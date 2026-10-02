#!/usr/bin/env node
// aimb-log (#70 step 3, v1.59.0) — report an agent's / a script's status to this host's activity board WITHOUT registering.
//
// Why: an orchestrating session puts ONE line in each agent's prompt ("report with: node aimb-log.mjs --session X
// --project P --agent research …"), and the agent (or any long-running script) reports progress with it. The bridge's
// `log` tool needs a registered sub-peer (as + secret); this script instead attaches to the GATEWAY's WS port as a
// token-gated `logger` leaf — the same trust as the doorbell (Robin, 2026-10-01: anyone holding the realm token may
// report as any session) — EXCEPT that the gateway refuses to speak for a session that is LIVE on the mesh roster under
// another user (code session-user-mismatch). A script-only session is never marked gone; it can go stale.
//
// v1.62.0 (#70 step 6a): the node tree — --path <p> addresses any node (`spec-70/@Tharsis`, `@#70/@step4/spec-70`; `@` = a
// context, else an agent; `@"a b"` quotes; `@~` on the last segment sets its current line); --agent / --ctx still work and
// combine with it (agent + path + ctx, or a leading `@…` text prefix). --batch <file.json|-> sends a JSON ARRAY of items
// (≤64, ≤64 KB) in ONE call → one line {ok, results:[…]} (exit 0 when every item applied, 4 when the bridge refused the
// call or any item failed); in --stream a line may be an array (a batch) → one result line {line, ok, results}.
//
// v1.63.0 (#70 step 6b): TODOS AND PLANS. --plan "A" "B" "C" creates ☐ plan items under the target node (--path / --agent),
// in the given order (every following argument up to the next --flag is a name; put text BEFORE --plan, or after `--`);
// re-sending a plan keeps the existing items as they are and adds new names at the end. --done = --state done; tick an item
// with --path "@#70/@~B" --done (text optional: an @~ line with a state keeps its text). --state todo|skipped is for plan
// items only. Batch / stream paths are RELATIVE to --path / --agent (a leading "/" = from the session root): --path @#70
// with an item {path:"@B/@~x"} reports to @#70/@B/@x.
//
// Usage (one report):
//   node tools/aimb-log.mjs --session <name> --project <P> [--user U] [--agent a/b] [--path p] [--ctx "@~Ctx"] [--state S | --done]
//        [--progress 4812/12000:tiles] [--eta 1h25m] [--stale-after 60m] [--details "..."]
//        [--data '{...}' | --data-file f.json] [--no-log] ["<text>"] [--plan "A" "B" …]
//   The text is optional when --progress/--eta is given (it defaults to "{progress}" / "{eta}", rendered when read).
//   --no-log = log:false (update the board only; not appended to the log or the daily file). Flags after `--` are text.
// Usage (a script reporting often — e.g. every second — over ONE connection):
//   node tools/aimb-log.mjs --stream --session <name> --project <P> [--user U] [--agent a] [--path p] [--ctx "@~Ctx"] [--no-log]
//   then write newline-delimited JSON objects to stdin, each with the `log` tool's fields minus auth:
//   {path?, agent?, text?, context?, state?, progress?, eta?, stale_after?, details?, data?, log?} (+ an optional `ref` echoed
//   back) — or a JSON ARRAY of such objects (a batch, one result line for the array).
//   The command line's identity applies to every line; --agent / --path / --ctx / --no-log are DEFAULTS a line may override
//   (6b: a line's own path / agent is RELATIVE to --agent / --path — a leading "/" makes it absolute — and drops --ctx; one
//   with only a context keeps --agent / --path).
// Usage (a batch): node tools/aimb-log.mjs --batch items.json --session <name> --project <P> [--agent a] [--path p] [--ctx c] [--no-log]
//   (`--batch -` reads the array from stdin).
//   One JSON result line per input line ({line:n, ref?, ...result}), in input order. Exit 0 at stdin EOF. If the link
//   drops the script reconnects with backoff; a line in flight when it dropped is reported failed (link-lost — it is
//   NOT resent, so a logged entry is never duplicated), and a line that waits longer than AIMB_LOG_LINE_WAIT_MS (default
//   10000) for a link is reported failed (no-bridge). A fatal hello error (bad token, bad ident, an old gateway) exits 4.
//
// v1.64.0 (#70 6c / #75 part 2): --token-file <path> — the realm token from a FILE (a bare token or a KEY=VALUE env file, `~`
// expanded), exactly as the doorbell: an explicit --token-file is AUTHORITATIVE (an unreadable or empty one is exit 64 naming
// the file — never a silent fallback to another source). The connect reminder's {log_snippet} adds it when the bridge itself
// read its token from a file.
//
// Identity: --session and --project are required; --user defaults to AI_BRIDGE_USER, else the OS login user
// (os.userInfo().username); the realm is AI_BRIDGE_REALM, else config.json `realm`, else "default" (as the bridge).
// Token / port: --token-file (#75), else AI_BRIDGE_TOKEN (or AI_BRIDGE_TOKEN_FILE, as the bridge #46) else config.json's `token`; --ws-port /
// --url / AI_BRIDGE_WS_PORT else config.json's `wsPort` (12318). config.json is found relative to THIS SCRIPT (../config.json),
// or AI_BRIDGE_CONFIG names it (tests). `--token` is REFUSED (exit 64): argv is world-readable in the process list and
// the realm token is also the body-encryption key — use the env var or the config file. The token is never printed.
//
// Exit codes (doorbell conventions): 0 ok (stream: stdin EOF) · 4 the bridge said no / transport error (no bridge, link
// lost, timeout, a pre-1.59 gateway) · 64 bad usage (a missing flag, bad JSON, a report the bridge would reject).
// stdout is ONE JSON line (the bridge's `log` result, or {ok:false, code, what}); usage text goes to stderr.
// Protocol: hello {type:"hello", kind:"logger", token, ident:{session, project, user, realm}} → {type:"welcome", logger:true,
// bridge_version, ident} | {type:"error", code, what}; then {type:"log", ref, input} → {type:"logged", ref, result}.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { parseMessage, splitBatch, withDefaults, MESSAGE_FIELDS } from '../lib/activity.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const USAGE = 'usage: aimb-log.mjs --session <name> --project <P> [--token-file f] [--user U] [--agent a/b] [--path "a/@Ctx"] [--ctx "@~Ctx"] [--state S | --done] [--progress 4812/12000:tiles] [--eta 1h25m] [--stale-after 60m] [--details "..."] [--data \'{...}\' | --data-file f.json] [--no-log] ["<text>"] [--plan "A" "B" …]\n       aimb-log.mjs --stream --session <name> --project <P> [--user U] [--agent a] [--path p] [--ctx "@~Ctx"] [--no-log]   (NDJSON on stdin — an object or an array per line — one result line each)\n       aimb-log.mjs --batch <items.json|-> --session <name> --project <P> [--user U] [--agent a] [--path p] [--ctx "@~Ctx"] [--no-log]   (a JSON array of items, one call)'
const LOG_FIELDS = MESSAGE_FIELDS   // v1.62.0: + path
const VALUE_FLAGS = new Set(['session', 'project', 'user', 'agent', 'path', 'ctx', 'state', 'progress', 'eta', 'stale-after', 'details', 'data', 'data-file', 'batch', 'ws-port', 'url', 'token-file'])   // v1.64.0: + token-file (#75)
const BOOL_FLAGS = new Set(['no-log', 'stream', 'help', 'done'])   // v1.63.0: + done (= --state done)
const STREAM_FLAGS = new Set(['session', 'project', 'user', 'agent', 'path', 'ctx', 'no-log', 'stream', 'ws-port', 'url', 'token-file'])
const BATCH_FLAGS = new Set(['session', 'project', 'user', 'agent', 'path', 'ctx', 'no-log', 'batch', 'ws-port', 'url', 'token-file'])
const num = (v, d) => (Number(v) > 0 ? Number(v) : d)
const TIMEOUT_MS = num(process.env.AIMB_LOG_TIMEOUT_MS, 8000)          // one-shot: connect + hello + reply; stream: hello + each reply
const LINE_WAIT_MS = num(process.env.AIMB_LOG_LINE_WAIT_MS, 10000)     // stream: how long a line may wait for a (re)connected link
const BACKOFF_MAX_MS = num(process.env.AIMB_LOG_BACKOFF_MAX_MS, 5000)  // stream: reconnect backoff cap (starts at 200 ms, doubles)
const FATAL = new Set(['unauthorized', 'ident-required', 'bad-ident', 'realm-mismatch', 'gateway-unsupported', 'already-hello'])

let exiting = false
function finish(code, obj) {   // print ONE JSON line (if any), then exit once stdout has drained
  if (exiting) return
  exiting = true
  const out = obj ? JSON.stringify(obj) + '\n' : ''
  process.stdout.write(out, () => process.exit(code))
}
function usage(code, what, extra) { console.error(USAGE); finish(64, { ok: false, code, what, ...(extra || {}) }) }

// ---- argv
const flags = {}, words = []
{
  const argv = process.argv.slice(2)
  let err = null
  for (let i = 0; i < argv.length && !err; i++) {
    const a = argv[i]
    if (a === '--') { words.push(...argv.slice(i + 1)); break }
    if (!a.startsWith('--') || a.length === 2) { words.push(a); continue }
    const eq = a.indexOf('=')
    const name = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase()
    if (name === 'token') { err = ['token-in-argv', '--token is refused: a token on the command line is visible in the process list. Pass --token-file <path>, set AI_BRIDGE_TOKEN (or AI_BRIDGE_TOKEN_FILE), or let it read the bridge\'s config.json'] ; break }
    if (name === 'plan') {   // v1.63.0 (#70 6b): every following argument up to the next --flag (or `--`) is a plan name
      const names = eq > 0 ? [a.slice(eq + 1)] : []
      if (eq < 0) while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) names.push(argv[++i])
      if (!names.length) { err = ['usage', '--plan needs at least one name: --plan "A" "B" …']; break }
      flags.plan = (flags.plan || []).concat(names); continue
    }
    if (BOOL_FLAGS.has(name)) { if (eq > 0) err = ['usage', `--${name} takes no value`]; else flags[name] = true; continue }
    if (!VALUE_FLAGS.has(name)) { err = ['usage', `unknown flag --${name}`]; break }
    const v = eq > 0 ? a.slice(eq + 1) : argv[i + 1]
    if (eq < 0) { if (v === undefined || v.startsWith('--')) { err = ['usage', `--${name} needs a value`]; break } i++ }
    flags[name] = v
  }
  if (err) usage(err[0], err[1])
}
if (!exiting && flags.help) { console.error(USAGE); finish(0, null) }

// ---- config: token, port, realm (never printed)
function readTokenFile(p) {
  try {
    const raw = fs.readFileSync(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p, 'utf8')
    const m = raw.match(/^\s*AI_BRIDGE_TOKEN\s*=\s*(.+?)\s*$/m)
    return (m ? m[1] : raw).trim()
  } catch { return '' }
}
const CONFIG_FILE = process.env.AI_BRIDGE_CONFIG
  ? path.resolve(process.env.AI_BRIDGE_CONFIG.startsWith('~') ? path.join(os.homedir(), process.env.AI_BRIDGE_CONFIG.slice(1)) : process.env.AI_BRIDGE_CONFIG)
  : path.join(HERE, '..', 'config.json')
let CFG = {}
try { CFG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {} } catch { }
// v1.64.0 (#75): an EXPLICIT --token-file is the only source when given (unreadable / empty → exit 64 naming the file)
const TOKEN_FILE_ARG = typeof flags['token-file'] === 'string' ? flags['token-file'] : null
const TOKEN = TOKEN_FILE_ARG != null ? readTokenFile(TOKEN_FILE_ARG)
  : (process.env.AI_BRIDGE_TOKEN || (process.env.AI_BRIDGE_TOKEN_FILE ? readTokenFile(process.env.AI_BRIDGE_TOKEN_FILE) : '') || CFG.token || '')
const WSPORT = flags['ws-port'] || process.env.AI_BRIDGE_WS_PORT || CFG.wsPort || 12318
const URL_ = flags.url || `ws://127.0.0.1:${WSPORT}`
const REALM = process.env.AI_BRIDGE_REALM || CFG.realm || 'default'
const OS_USER = (() => { try { return os.userInfo().username || '' } catch { return process.env.USERNAME || process.env.USER || '' } })()
const ident = { session: String(flags.session || '').trim(), project: String(flags.project || '').trim(), user: String(flags.user || process.env.AI_BRIDGE_USER || OS_USER || '').trim(), realm: REALM }

// ---- the report(s): validate locally with the bridge's own parser (a bad report costs no connection and exits 64)
const STREAM = !!flags.stream, BATCH = flags.batch != null
const defaults = {}
if (flags.agent != null) defaults.agent = flags.agent
if (flags.path != null) defaults.path = flags.path
if (flags.ctx != null) defaults.context = flags.ctx
if (flags['no-log']) defaults.log = false
let oneShot = null
// a batch (6a): the items + the command line's defaults, checked locally (bounds, JSON) — each item is answered by the bridge
function batchInput(items) {
  if (!Array.isArray(items)) return { err: { code: 'bad-batch', what: 'a batch is a JSON array of items' } }
  const input = { ...defaults, items }
  const sp = splitBatch(input)
  return sp.ok ? { input } : { err: { code: sp.code, what: sp.what } }
}
if (!exiting) {
  if (!ident.session) usage('usage', '--session <name> is required')
  else if (!ident.project) usage('usage', '--project <P> is required')
  else if (!ident.user) usage('usage', 'no user: pass --user (the OS login user could not be read)')
  else if (!TOKEN && TOKEN_FILE_ARG != null) usage('no-token', `no realm token: --token-file ${TOKEN_FILE_ARG} could not be read (or is empty)`, { token_file: TOKEN_FILE_ARG })
  else if (!TOKEN) usage('no-token', `no realm token: pass --token-file <path> (the file the bridge reads with AI_BRIDGE_TOKEN_FILE), set AI_BRIDGE_TOKEN_FILE / AI_BRIDGE_TOKEN, or put it in ${CONFIG_FILE} (read relative to this script, not the working directory)`)
  else if (STREAM && BATCH) usage('usage', '--stream and --batch are exclusive (a stream line may itself be an array)')
  else if (BATCH) {
    const extra = Object.keys(flags).filter(k => !BATCH_FLAGS.has(k))
    if (extra.length) usage('usage', `--batch takes the report fields per item, not --${extra.join(' / --')}`)
    else if (words.length) usage('usage', '--batch reads its items from the file (or stdin); no positional text')
  } else if (STREAM) {
    const extra = Object.keys(flags).filter(k => !STREAM_FLAGS.has(k))
    if (extra.length) usage('usage', `--stream takes the report fields per line, not --${extra.join(' / --')}`)
    else if (words.length) usage('usage', '--stream reads its reports from stdin; no positional text')
  } else {
    const input = { ...defaults }
    if (words.length) input.text = words.join(' ')
    for (const [f, k] of [['state', 'state'], ['progress', 'progress'], ['eta', 'eta'], ['stale-after', 'stale_after'], ['details', 'details']]) if (flags[f] != null) input[k] = flags[f]
    if (flags.plan) input.plan = flags.plan                                   // v1.63.0 (#70 6b)
    if (flags.done && flags.state != null) usage('usage', '--done and --state are exclusive (--done = --state done)')
    else if (flags.done) input.state = 'done'
    if (exiting) { /* usage printed */ } else if (flags.data != null && flags['data-file'] != null) usage('usage', '--data and --data-file are exclusive')
    else if (flags.data != null) { try { input.data = JSON.parse(flags.data) } catch (e) { usage('bad-data', `--data is not JSON: ${e.message}`) } }
    else if (flags['data-file'] != null) {
      let raw = null
      try { raw = fs.readFileSync(String(flags['data-file']), 'utf8') } catch (e) { usage('bad-data', `--data-file unreadable: ${e.code || e.message}`) }
      if (raw != null) { try { input.data = JSON.parse(raw.replace(/^﻿/, '')) } catch (e) { usage('bad-data', `--data-file is not JSON: ${e.message}`) } }
    }
    if (!exiting) {
      const p = parseMessage(input, { now: Date.now(), tzOffsetMin: -new Date().getTimezoneOffset() })
      if (!p.ok) usage(p.code || 'bad-input', p.what || 'invalid report')
      else oneShot = input
    }
  }
}

// ---- the link
function hello(ws) { ws.send(JSON.stringify({ type: 'hello', kind: 'logger', token: TOKEN, ident })) }
const unsupported = m => ({ ok: false, code: 'gateway-unsupported', what: `the gateway on ${URL_} runs bridge ${m.bridge_version || '?'}; aimb-log needs 1.59.0+ on this host's gateway (restart it on the new version)` })

// ---- a batch: read the array (file or stdin), check it locally, then ONE call like a one-shot (exit 0 only when every item applied)
async function readBatch() {
  let raw
  try {
    if (flags.batch === '-') { const chunks = []; for await (const c of process.stdin) chunks.push(c); raw = Buffer.concat(chunks).toString('utf8') }
    else raw = fs.readFileSync(String(flags.batch), 'utf8')
  } catch (e) { return usage('bad-batch', `--batch unreadable: ${e.code || e.message}`) }
  let items
  try { items = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch (e) { return usage('bad-batch', `--batch is not JSON: ${e.message}`) }
  const b = batchInput(items)
  if (b.err) return usage(b.err.code, b.err.what)
  oneShot = b.input
  sendOne()
}
if (!exiting && BATCH) readBatch()
else if (!exiting && oneShot) sendOne()
function sendOne() {
  // ONE report (or one batch): connect → hello → welcome → log → logged → print → exit
  const ws = new WebSocket(URL_)
  let welcomed = false
  const timer = setTimeout(() => { finish(4, { ok: false, code: 'timeout', what: `no answer from ${URL_} within ${TIMEOUT_MS}ms` }); try { ws.terminate() } catch { } }, TIMEOUT_MS)
  const done = (code, obj) => { clearTimeout(timer); try { ws.close() } catch { } finish(code, obj) }
  ws.on('open', () => hello(ws))
  ws.on('message', raw => {
    let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.type === 'welcome' && !welcomed) {
      welcomed = true
      if (!m.logger) return done(4, unsupported(m))   // a pre-1.59 gateway took the hello for a page: close at once
      ws.send(JSON.stringify({ type: 'log', ref: 1, input: oneShot }))
    } else if (m.type === 'logged') done(m.result && m.result.ok && !(m.result.failed > 0) ? 0 : 4, m.result || { ok: false, code: 'bad-reply' })   // a batch with a failed item → 4
    else if (m.type === 'error') done(4, { ok: false, code: m.code || 'error', what: m.what || null })
  })
  ws.on('close', () => done(4, { ok: false, code: 'link-closed', what: welcomed ? 'the bridge closed the link before answering' : 'the bridge closed the link (bad token?)' }))
  ws.on('error', e => done(4, { ok: false, code: 'link-error', what: String((e && e.message) || e) }))
}

if (!exiting && STREAM) {
  // MANY reports over ONE connection: NDJSON on stdin, one result line each IN INPUT ORDER, reconnect with backoff.
  // The queue holds every line: a pending report { n, ref, input, deadline } or an already-answered one { n, ref, result }
  // (a bad line) that waits its turn behind the reports before it.
  const queue = []
  let ws = null, ready = false, inflight = null, backoff = 200, eof = false, nextRef = 0, retry = null
  const emit = (item, result) => { process.stdout.write(JSON.stringify({ line: item.n, ...(item.ref !== undefined ? { ref: item.ref } : {}), ...result }) + '\n') }
  function settle() { if (eof && !queue.length && !inflight && !exiting) { clearInterval(sweep); if (retry) clearTimeout(retry); try { ws && ws.close() } catch { } finish(0, null) } }
  function pump() {   // emit answered heads; send the next report when the link is up and nothing is in flight
    if (inflight || exiting) return
    while (queue.length && queue[0].result) { const it = queue.shift(); emit(it, it.result) }
    if (ready && ws && queue.length) {
      const it = queue.shift()
      it.wire = ++nextRef
      inflight = it
      it.timer = setTimeout(() => { if (inflight === it) { inflight = null; emit(it, { ok: false, code: 'timeout', what: `no answer within ${TIMEOUT_MS}ms` }); pump() } }, TIMEOUT_MS)
      try { ws.send(JSON.stringify({ type: 'log', ref: it.wire, input: it.input })) } catch { }
    }
    settle()
  }
  function fatal(r) {   // the bridge will never accept these reports (bad token / ident, an old gateway): report them all, exit 4
    if (inflight) { clearTimeout(inflight.timer); emit(inflight, r); inflight = null }
    for (const it of queue.splice(0)) emit(it, it.result || r)
    try { ws && ws.close() } catch { }
    finish(4, { ...r, fatal: true })
  }
  function connect() {
    retry = null
    if (exiting) return
    const sock = new WebSocket(URL_)
    ws = sock
    const helloTimer = setTimeout(() => { if (!ready && ws === sock) { try { sock.terminate() } catch { } } }, TIMEOUT_MS)
    sock.on('open', () => hello(sock))
    sock.on('message', raw => {
      let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.type === 'welcome' && !ready) {
        clearTimeout(helloTimer)
        if (!m.logger) return fatal(unsupported(m))   // a pre-1.59 gateway took the hello for a page
        ready = true; backoff = 200; pump()
      } else if (m.type === 'logged') {
        if (!inflight || m.ref !== inflight.wire) return   // a late answer to a line already reported (timeout)
        const it = inflight; inflight = null; clearTimeout(it.timer)
        emit(it, m.result || { ok: false, code: 'bad-reply' }); pump()
      } else if (m.type === 'error' && FATAL.has(m.code)) fatal({ ok: false, code: m.code, what: m.what || null })
    })
    sock.on('close', () => {
      clearTimeout(helloTimer)
      if (ws !== sock) return
      ready = false; ws = null
      if (inflight) { const it = inflight; inflight = null; clearTimeout(it.timer); emit(it, { ok: false, code: 'link-lost', what: 'the link dropped before the bridge answered; not resent (it may or may not have been applied)' }) }
      pump()
      if (!exiting && !retry) { retry = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, BACKOFF_MAX_MS) }
    })
    sock.on('error', () => { })   // 'close' follows
  }
  const sweep = setInterval(() => {   // with no link, a report that waited longer than LINE_WAIT_MS is reported (in order)
    if (ready || inflight || exiting) return
    const now = Date.now()
    while (queue.length && (queue[0].result || queue[0].deadline <= now)) { const it = queue.shift(); emit(it, it.result || { ok: false, code: 'no-bridge', what: `no link to ${URL_} within ${LINE_WAIT_MS}ms` }) }
    settle()
  }, 200)
  let n = 0
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', raw => {
    const item = { n: ++n }
    const line = raw.trim()
    if (!line) return
    let o
    try { o = JSON.parse(line) } catch (e) { item.result = { ok: false, code: 'bad-json', what: e.message } }
    if (!item.result && Array.isArray(o)) {   // v1.62.0: a batch line — one call, one result line {line, ok, results}
      const b = batchInput(o)
      if (b.err) item.result = { ok: false, ...b.err }
      else { item.input = b.input; item.deadline = Date.now() + LINE_WAIT_MS }
      queue.push(item); pump(); return
    }
    if (!item.result && (!o || typeof o !== 'object')) item.result = { ok: false, code: 'bad-line', what: 'each line must be a JSON object (or an array of them: a batch)' }
    if (!item.result) {
      const { ref, ...fields } = o
      item.ref = ref
      const extra = Object.keys(fields).filter(k => !LOG_FIELDS.includes(k))
      if (extra.length) item.result = { ok: false, code: 'bad-field', what: `unknown field(s) ${extra.join(', ')}: a line carries ${LOG_FIELDS.join(', ')} (+ ref); the identity comes from the command line` }
      else {
        item.input = withDefaults(defaults, fields)   // v1.62.0: a line with its own path / agent takes none of the address defaults
        const p = parseMessage(item.input, { now: Date.now(), tzOffsetMin: -new Date().getTimezoneOffset() })
        if (!p.ok) item.result = { ok: false, code: p.code || 'bad-input', what: p.what || null }
        else item.deadline = Date.now() + LINE_WAIT_MS
      }
    }
    queue.push(item)
    pump()
  })
  rl.on('close', () => { eof = true; pump() })
  connect()
}
