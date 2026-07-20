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
//                                [--url ws://127.0.0.1:7001] [--token XXX]
//
// Token/port default to ../config.json (or AI_BRIDGE_TOKEN / AI_BRIDGE_WS_PORT).
//
// Exit codes — each means a DIFFERENT next move for the caller:
//   0  mail waiting      -> poll the inbox, handle it, re-arm
//   2  timeout, no mail   -> re-arm (bounded cost; nothing happened)
//   3  watched peer gone  -> register_self again, then re-arm
//   4  link lost/error    -> bridge restarted or down; re-arm (or investigate)
//  64  bad usage
// stdout is a single JSON line describing why it exited.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

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
const WSPORT = arg('ws-port') || process.env.AI_BRIDGE_WS_PORT || CFG.wsPort || 7001
const URL_ = arg('url') || `ws://127.0.0.1:${WSPORT}`
const NAME = arg('name'), PROJECT = arg('project'), TOPIC = arg('topic')
const TIMEOUT_MS = Number(arg('timeout', 1800)) * 1000
const STATUS = arg('status')

if (!NAME && !TOPIC) { console.error('usage: --name <peer> [--project P] [--topic T] [--timeout sec] [--status file]'); process.exit(64) }
if (!TOKEN) { console.error('no realm token: pass --token, set AI_BRIDGE_TOKEN, or run beside src/config.json'); process.exit(64) }

const started = Date.now()
const watch = { name: NAME || null, project: PROJECT || null, topic: TOPIC || null }

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

let finished = false
function done(code, payload) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  if (payload) console.log(JSON.stringify(payload))
  status(code === 0 ? 'mail' : code === 2 ? 'timeout' : code === 3 ? 'gone' : 'lost', payload)
  try { ws.close() } catch {}
  process.exit(code)
}

const timer = setTimeout(() => done(2, { reason: 'timeout', waited_sec: Math.round((Date.now() - started) / 1000), watch }), TIMEOUT_MS)

status('connecting')
const ws = new WebSocket(URL_)

ws.on('open', () => {
  status('connected')
  ws.send(JSON.stringify({ type: 'hello', kind: 'listener', token: TOKEN, watch }))
})

ws.on('message', raw => {
  let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
  switch (m.type) {
    case 'welcome': status('armed', { bridge_version: m.bridge_version, gateway: m.gateway }); break
    case 'ping':    status('alive', { pings: true }); break
    case 'mail':    done(0, { reason: 'mail', peer: m.peer, unread_direct: m.unread_direct, topics: m.topics, total: m.total, watch }); break
    case 'gone':    done(3, { reason: 'peer-gone', watch }); break
    case 'error':   done(4, { reason: 'error', code: m.code, what: m.what, watch }); break
  }
})

ws.on('close', () => done(4, { reason: 'link-closed', watch }))
ws.on('error', e => done(4, { reason: 'link-error', message: String((e && e.message) || e), watch }))
