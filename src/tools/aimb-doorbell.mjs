#!/usr/bin/env node
// Doorbell (#39) — block until mail is WAITING for a peer/topic, then exit so the caller wakes up.
//
// Why: an idle AI session that polls `inbox` every few seconds burns a model turn per poll (~8,600/day)
// to learn "nothing arrived". This script does the waiting instead: it attaches to the bridge as a
// `listener` leaf, blocks on a push socket costing no tokens and ~no CPU, and exits the moment there is
// something to collect. Run it backgrounded; the harness wakes the agent when it exits, and the agent
// then polls `inbox` ONCE (behaviour reminders ride along on the messages, as always).
//
// Usage:
//   node tools/aimb-doorbell.mjs --name Bridget [--project AIMB] [--topic virtualization]
//                                [--timeout 1800] [--status /tmp/doorbell.json]
//                                [--url ws://127.0.0.1:12318] [--token XXX]
//
// Token/port default to ../config.json (or AI_BRIDGE_TOKEN / AI_BRIDGE_WS_PORT).
//
// Hourly chime (#67) — the DEFAULT when no --timeout is given: the doorbell exits at the top of the next hour
// (LOCAL wall-clock, e.g. 14:00:00), or earlier if mail arrives, with reason:"hourly", time:"14:00" and guidance
// telling the agent to DISPLAY the time to the user, then re-arm. It is a deliberate, visible wake (a clock the
// user sees), NOT a silent re-arm. It never exits before the boundary (an early setTimeout waits out the rest),
// so a re-arm always targets the NEXT hour — no double chime, no hot loop. An explicit --timeout <sec> keeps the
// old behaviour exactly (reason:"timeout", silent re-arm). TEST HOOK: env AIMB_DOORBELL_PERIOD_SEC=<n> chimes on
// the next multiple of n seconds (local clock) instead of the hour — for tests only.
//
// 6-hour inbox check-in (#69): the hourly chimes at 00:00, 06:00, 12:00 and 18:00 (LOCAL) also carry
// inbox_check:true and guidance telling the agent to call its inbox tool NOW even if nothing is waiting — that tool
// call keeps the Ai MCP Bridge loaded in an otherwise idle session — then display the time and re-arm. reason stays
// "hourly" and time stays the boundary's "HH:MM". The mark is judged from the BOUNDARY's local wall time (see
// aimb-doorbell-clock.mjs isCheckinMark), never Date.now() drift, so midnight is "00:00" and a check-in. With the
// period hook, the check-in lands on every boundary whose seconds since local midnight divide by EVERY × period.
// TEST/TUNING KNOB: env AIMB_DOORBELL_CHECKIN_EVERY=<k> (default 6) makes it every k-th boundary instead. Mail
// exits, explicit --timeout exits and the other hourly chimes are unchanged.
//
// Exit code is a SUCCESS/FAILURE signal for the harness (which paints any non-zero background exit as "failed",
// so a benign 30-min timeout used to surface as a FAILURE — #52). The SPECIFIC outcome travels in `reason` on
// stdout + the --status file, so a caller still branches on it:
//   0  did its job    -> if reason=="mail" poll the inbox & handle it; if "hourly" show the user the time (and if
//                        inbox_check:true, call the inbox tool first even with nothing waiting — #69); then re-arm.
//                        reason ∈ { mail, hourly, timeout, peer-gone, link-closed(after arming) }
//   4  couldn't do it -> never armed / a bridge error frame; investigate rather than hot-loop
//  64  bad usage
// A routine NO-MAIL wake (timeout / peer-gone / a post-arm link drop) also carries guidance:"silent re-arm…"
// so a doorbell LOOP doesn't burn tokens narrating uneventful re-arms — the agent stays quiet unless it STOPS
// looping (or mail needs handling). stdout is a single JSON line. Every exit carries `exited_at` (local ISO-8601
// with tz offset) + `exited_at_unix` (#51); the same two fields land in the --status file's exit write.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { nextBoundary as boundaryAfter, hhmm, isCheckinMark } from './aimb-doorbell-clock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const i = argv.indexOf('--' + k)
  if (i < 0) return d
  const v = argv[i + 1]
  return (v && !v.startsWith('--')) ? v : true
}

let CFG = {}
try { CFG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.json'), 'utf8')) } catch {}
const TOKEN = arg('token') || process.env.AI_BRIDGE_TOKEN || CFG.token || ''
const WSPORT = arg('ws-port') || process.env.AI_BRIDGE_WS_PORT || CFG.wsPort || 12318
const URL_ = arg('url') || `ws://127.0.0.1:${WSPORT}`
const NAME = arg('name'), PROJECT = arg('project'), TOPIC = arg('topic')
const TIMEOUT_ARG = arg('timeout')   // explicit --timeout => the old fixed timeout; absent => the hourly chime (#67)
const TIMEOUT_MS = TIMEOUT_ARG != null ? Number(TIMEOUT_ARG) * 1000 : null
const PERIOD_SEC = Number(process.env.AIMB_DOORBELL_PERIOD_SEC) > 0 ? Number(process.env.AIMB_DOORBELL_PERIOD_SEC) : 3600   // test hook
const CHECKIN_EVERY = Number(process.env.AIMB_DOORBELL_CHECKIN_EVERY) > 0 ? Math.floor(Number(process.env.AIMB_DOORBELL_CHECKIN_EVERY)) : 6   // #69 test/tuning knob
const STATUS = arg('status')

if (!NAME && !TOPIC) { console.error('usage: --name <peer> [--project P] [--topic T] [--timeout sec] [--status file]   (no --timeout = chime at the top of the next hour; 00/06/12/18:00 chimes add inbox_check:true — call your inbox tool)'); process.exit(64) }
if (!TOKEN) { console.error('no realm token: pass --token, set AI_BRIDGE_TOKEN, or run beside src/config.json'); process.exit(64) }

const started = Date.now()
const watch = { name: NAME || null, project: PROJECT || null, topic: TOPIC || null }

// Local ISO-8601 WITH tz offset (e.g. 2026-07-22T13:52:45.123+12:00) — a human reads the wake time at a glance
// without doing UTC math. `new Date().toISOString()` is UTC-only, hence the hand-build. (#51)
function localIso(d = new Date()) {
  const pad = (n, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0')
  const off = -d.getTimezoneOffset()   // minutes east of UTC
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(off / 60)}:${pad(off % 60)}`
}

// #67: the next chime boundary / its label live in aimb-doorbell-clock.mjs (pure, unit-tested); #69 adds the
// check-in mark there too.
const nextBoundary = (now = Date.now()) => boundaryAfter(now, PERIOD_SEC)

// heartbeat/state file — lets a human (or the agent, cheaply) confirm the doorbell is still alive
// WITHOUT spending a turn. Rewritten on connect, on every bridge ping, and on exit.
function status(state, extra) {
  if (!STATUS || STATUS === true) return
  try {
    fs.writeFileSync(String(STATUS), JSON.stringify({
      state, watch, pid: process.pid,
      since: new Date(started).toISOString(), last: new Date().toISOString(),
      ...(extra || {}),
    }, null, 1))
  } catch { /* a doorbell must never die because a status write failed */ }
}

let finished = false, armed = false   // armed flips true on the bridge's `welcome` — a pre-arm link failure is real trouble, a post-arm one is a benign re-arm
// A brief, imperative wake-guidance for a routine (no-mail) exit — deliberately terse because it rides EVERY
// idle re-arm and the agent reads it each time. Tells the loop to stay silent unless it's actually stopping.
const REARM_GUIDANCE = "silent re-arm — don't mention this wake unless you're stopping the loop"
// #67: the hourly chime is the opposite — a visible wake whose whole point is to show the user the time.
const chimeGuidance = t => `Top of the hour: display the current time (${t}) to the user, then re-arm the doorbell.`
// #69: on the 6-hour marks the chime also makes the agent touch the bridge, so an idle session keeps it loaded.
const checkinGuidance = t => `6-hour check-in (${t}): call your inbox tool now even if nothing is waiting — it keeps the Ai MCP Bridge loaded in this session. Then display the time to the user and re-arm the doorbell.`
function done(reason, extra) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  // #52: the code is success/failure only. Trouble = a bridge error frame, or a link failure BEFORE we ever
  // armed (couldn't do the job). Everything post-arm — mail, timeout, peer-gone, a dropped link — is a normal
  // outcome the caller re-arms from, so exit 0 and let `reason` carry the specifics.
  const trouble = reason === 'error' || ((reason === 'link-closed' || reason === 'link-error') && !armed)
  const code = trouble ? 4 : 0
  const state = reason === 'mail' ? 'mail' : reason === 'hourly' ? 'hourly' : reason === 'timeout' ? 'timeout' : reason === 'peer-gone' ? 'gone' : 'lost'
  const routineNoMail = !trouble && reason !== 'mail' && reason !== 'hourly'   // uneventful wake -> tell the agent to re-arm silently
  const now = new Date()
  // #51: stamp EVERY exit centrally, so both the stdout line and the status file's exit write carry it.
  const payload = { reason, ...(extra || {}), watch,
    exited_at: localIso(now), exited_at_unix: Math.floor(now.getTime() / 1000),
    ...(reason === 'hourly' ? { guidance: extra.inbox_check ? checkinGuidance(extra.time) : chimeGuidance(extra.time) } : routineNoMail ? { guidance: REARM_GUIDANCE } : {}) }
  console.log(JSON.stringify(payload))
  status(state, payload)
  try { ws.close() } catch {}
  process.exit(code)
}

let timer
if (TIMEOUT_MS != null) timer = setTimeout(() => done('timeout', { waited_sec: Math.round((Date.now() - started) / 1000) }), TIMEOUT_MS)
else {
  // #67: a timer can fire a few ms EARLY relative to Date.now() — if it does, wait out the remainder rather than
  // chime at 13:59:59.998 (which a re-arm would then follow with a second 14:00 chime). Always exit AT/AFTER it.
  const target = nextBoundary(started)
  const chime = () => {
    const left = target - Date.now()
    if (left > 0) { timer = setTimeout(chime, left); return }
    // #69: the check-in is decided by the BOUNDARY's local time (target), not Date.now() — midnight reads "00:00"
    done('hourly', { time: hhmm(target), ...(isCheckinMark(target, PERIOD_SEC, CHECKIN_EVERY) ? { inbox_check: true } : {}) })
  }
  timer = setTimeout(chime, target - started)
}

status('connecting')
const ws = new WebSocket(URL_)

ws.on('open', () => {
  status('connected')
  ws.send(JSON.stringify({ type: 'hello', kind: 'listener', token: TOKEN, watch }))
})

ws.on('message', raw => {
  let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
  switch (m.type) {
    case 'welcome': armed = true; status('armed', { bridge_version: m.bridge_version, gateway: m.gateway }); break
    case 'ping':    status('alive', { pings: true }); break
    case 'mail':    done('mail', { peer: m.peer, unread_direct: m.unread_direct, topics: m.topics, total: m.total }); break
    case 'gone':    done('peer-gone', {}); break
    case 'error':   done('error', { code: m.code, what: m.what }); break
  }
})

ws.on('close', () => done('link-closed', {}))
ws.on('error', e => done('link-error', { message: String((e && e.message) || e) }))
