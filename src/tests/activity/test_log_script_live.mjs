// #70 step 3 (v1.59.0) → #88 build step 9 (2.0): tools/aimb-log.mjs (the token-gated `logger` WS leaf on the gateway's ws
// port) speaking the 2.0 forms (docs/spec-88.md §4), and the gateway's POST /admin/prepare-shutdown (the Task Tray calls it
// before it kills the bridges).
// Host A: a GATEWAY (G, AI_BRIDGE_USER=alice, a 10-minute checkpoint interval so nothing is checkpointed unless the endpoint
// asks) with a temp persist dir + a temp AI_BRIDGE_CONFIG (never src/config.json). Host B: a gateway on 127.0.0.2 (user
// carol) federated with A by seeds, for the mesh-wide user-mismatch rule. A FAKE gateway (a WS server that welcomes a
// logger as a 1.7x bridge would: no activity_format) for gateway-unsupported. The script is pointed at the test bridge with
// AI_BRIDGE_TOKEN / AI_BRIDGE_CONFIG / AI_BRIDGE_WS_PORT (the test hook) and run as a child process; this file's port block.
// Covers (2.0, step 9): a one-shot agent report (the result names the node: id, key, label, path, kind, created; the line
// set by a leading @), --key creates once with --label (label-required without it; a sibling's label → "… (2)" with the
// relabelled warning; a retry changes nothing — exists), progress-only + --no-log, --data / --data-file / --details, the
// session's own line, --path (labels, quoted, below --agent, an alias after a rename) and --ctx, plan items (--item <k>
// "<label>" / --item "<label>", --done, positions), --move / --rename, --context-type, the typed field flags
// (--message-type=test-result --result … --checks … --failed … --duration …), --move-to with transient buckets that vanish
// (§3.8's test run), a bare --move-to refused with suggest, --resolve (read-only), questions (--ask … --wait: timeout 10,
// expired 11 via the expiry timer, answered 0 from a dashboard while --wait-answer waits, withdrawn 12), --guide agent as
// the agent's FIRST REPORT (created once, printed only the second time, label-required → the guide + the error, exit 64)
// and --guide session, EVERY removed 1.7x form (one check each, the message naming the 2.0 form; on the command line AND at
// the gateway over the logger link), gateway-unsupported against a gateway that does not speak 2.0 (nothing sent; --guide
// still prints, with a note), --batch <file|-> (one call, per-item results, the defaults, bounds), --stream (2.0 lines,
// arrays = batches, bad / legacy lines in place, EOF exit 0, a reconnect after a gateway restart), usage errors → 64 (incl.
// --token refused without echoing it), no bridge → 4, bad token, session-user-mismatch (this host and a remote host; same
// user accepted; accepted once the sub-peer left), the logger never on the roster, and prepare-shutdown (auth; the flush:
// a log:false burst survives a HARD kill only when the endpoint was called — a negative control loses it).
// RETIRED in step 9 (1.7x only): the `@` / `@~` path and text forms and the --plan / positional forms as WORKING forms (each
// is now a legacy-form check); "a script-only session is never marked gone" (2.0 does not mark local sessions gone yet).
// AIMB_TEST_BRIDGE=<file in src/> and AIMB_TEST_LOG_SCRIPT=<path> run it against other copies.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawn as spawnChild } from 'node:child_process'
import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lslug } from '../../facets/persistence/file.js'
const tp = testPorts(import.meta.url, 14000)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const SCRIPT = process.env.AIMB_TEST_LOG_SCRIPT ? path.resolve(process.env.AIMB_TEST_LOG_SCRIPT) : path.join(SRCDIR, 'tools', 'aimb-log.mjs')
const TOKEN = 'logscripttok', PORT = String(tp(14000)), WS = String(tp(14001)), B_PORT = String(tp(14010)), DEAD_WS = String(tp(14099)), FAKE_WS = String(tp(14098))
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-logscript-'))
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-logscriptcfg-'))
const cfgFile = path.join(cfgDir, 'config.json'), noTokCfg = path.join(cfgDir, 'notoken.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_entries_per_agent: 50 } }))
fs.writeFileSync(noTokCfg, JSON.stringify({}))
const hostDir = path.join(persist, 'activity', lslug(os.hostname(), 80))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify

function spawnBridge(name, bind, port, extra = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_PERSISTENCE: 'none',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: '', AI_BRIDGE_DISCOVERY_MS: '300', AI_BRIDGE_TEST_GOSSIP: '', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport, name }))
}
const gwEnv = { AI_BRIDGE_USER: 'alice', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persist, AI_BRIDGE_SEEDS: `127.0.0.2:${B_PORT}`,
  AI_BRIDGE_ACTIVITY_CHECKPOINT_MS: '600000' }   // a LONG interval: only the endpoint (or a clean exit) writes checkpoints
const spawnG = () => spawnBridge('ScriptGw', '127.0.0.1', PORT, gwEnv)
const call = async (b, n, a = {}) => { try { return JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000) {
  const t0 = Date.now(); let r
  do { r = await fn(); if (want(r)) return r; await sleep(150) } while (Date.now() - t0 < ms)
  return r
}
function records() {
  const out = []
  let files = []; try { files = fs.readdirSync(hostDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() } catch { }
  for (const f of files) for (const line of fs.readFileSync(path.join(hostDir, f), 'utf8').split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)) } catch { } }
  return out
}
const board = async h => (await call(h, 'activity')).sessions || []
const sess = (b, name) => b.find(s => s.session === name)
const nodeOf = (b, sname, p) => (sess(b, sname)?.nodes || []).find(x => x.path === p)   // 2.0: a node's path = its labels from the root ('' = the root)
const logOf = async (h, sname, id, extra = {}) => (await call(h, 'activity', { log: { session: sname, project: 'AIMB', id, limit: 50, ...extra } })).log || {}

// the script as a child process: env = the test hook (token, config, ws port); never the parent's AI_BRIDGE_USER/REALM/TOKEN_FILE
function scriptEnv(extra = {}) {
  const env = { ...process.env, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_WS_PORT: WS, ...extra }
  for (const k of ['AI_BRIDGE_USER', 'AI_BRIDGE_REALM', 'AI_BRIDGE_TOKEN_FILE']) if (!(k in extra)) delete env[k]
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]
  return env
}
function runLog(args, { env = {}, stdin = null, timeout = 25000 } = {}) {
  return new Promise(resolve => {
    let ch
    try { ch = spawnChild(process.execPath, [SCRIPT, ...args], { env: scriptEnv(env), stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) { return resolve({ code: -1, out: [], raw: '', err: String(e) }) }
    let out = '', err = ''
    ch.stdout.on('data', d => { out += d }); ch.stderr.on('data', d => { err += d })
    const t = setTimeout(() => { try { ch.kill() } catch { } }, timeout)
    ch.on('error', e => { err += String(e) })
    ch.on('close', code => { clearTimeout(t); resolve({ code, raw: out, err, out: out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return { unparsed: l } } }) }) })
    if (stdin != null) ch.stdin.end(stdin); else ch.stdin.end()
  })
}
const res1 = r => r.out.find(x => !x.unparsed) || {}
const ID = ['--session', 'Scripty', '--project', 'AIMB', '--user', 'robin']

// a streaming child we drive line by line
function streamLog(args, env = {}) {
  const ch = spawnChild(process.execPath, [SCRIPT, '--stream', ...args], { env: scriptEnv(env), stdio: ['pipe', 'pipe', 'pipe'] })
  const s = { ch, lines: [], code: null, closed: null, err: '' }
  let buf = ''
  ch.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) { try { s.lines.push(JSON.parse(l)) } catch { s.lines.push({ unparsed: l }) } } } })
  ch.stderr.on('data', d => { s.err += d })
  ch.on('error', e => { s.err += String(e) })
  s.closed = new Promise(r => ch.on('close', code => { s.code = code; r(code) }))
  s.send = o => { try { ch.stdin.write((typeof o === 'string' ? o : J(o)) + '\n') } catch { } }
  s.end = () => { try { ch.stdin.end() } catch { } }
  s.waitLines = async (n, ms = 10000) => { const t0 = Date.now(); while (s.lines.length < n && Date.now() - t0 < ms) await sleep(50); return s.lines.length >= n }
  return s
}
/** One logger WS link: hello → welcome, then send(msg) → the reply of the given type with the same ref. */
function loggerLink(identity) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS}`), msgs = [], l = { ws, msgs, welcome: null, n: 0 }
    l.req = async (o, type) => { const ref = `r${++l.n}`; ws.send(J({ ...o, ref })); const m = await until(async () => msgs.find(x => x.type === type && x.ref === ref), x => !!x, 8000); return m || { type, ref, result: { ok: false, code: 'no-answer' } } }
    ws.on('open', () => ws.send(J({ type: 'hello', kind: 'logger', token: TOKEN, ident: identity })))
    ws.on('message', raw => { const m = JSON.parse(String(raw)); msgs.push(m); if (m.type === 'welcome') { l.welcome = m; resolve(l) } })
    ws.on('error', () => resolve(l))
    setTimeout(() => resolve(l), 5000)
  })
}
function dashboard() {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS}`), d = { ws, msgs: [], n: 0 }
    d.act = async q => { const ref = `a${++d.n}`; ws.send(J({ type: 'activity_action', ref, ...q })); const m = await until(async () => d.msgs.find(x => x.type === 'activity_action' && x.ref === ref), x => !!x, 8000); return (m && m.result) || { ok: false, code: 'no-answer' } }
    ws.on('open', () => ws.send(J({ type: 'hello', token: TOKEN, kind: 'dashboard', instance: 'dash-script' })))
    ws.on('message', raw => { const m = JSON.parse(String(raw)); d.msgs.push(m); if (m.type === 'welcome') resolve(d) })
    ws.on('error', () => resolve(d))
  })
}

function post(p, headers = {}, method = 'POST', host = '127.0.0.1') {
  return new Promise(resolve => {
    const req = http.request({ host, port: Number(WS), path: p, method, headers, timeout: 5000 }, res => {
      let body = ''; res.on('data', d => { body += d }); res.on('end', () => { let j = null; try { j = JSON.parse(body) } catch { } resolve({ status: res.statusCode, body: j, raw: body }) })
    })
    req.on('error', e => resolve({ status: 0, err: String(e) }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }) })
    req.end()
  })
}
const prepare = (tok = TOKEN) => post('/admin/prepare-shutdown', tok == null ? {} : { Authorization: `Bearer ${tok}` })
async function hardKill(h) {   // TerminateProcess (as the tray's Process.Kill): no exit handlers run
  const pid = h.transport.pid
  try { process.kill(pid, 'SIGKILL') } catch { }
  for (let i = 0; i < 60; i++) { try { process.kill(pid, 0) } catch { break } await sleep(100) }
  try { await h.transport.close() } catch { }
}

const all = []
let fake = null
try {
  const B = await spawnBridge('ScriptHostB', '127.0.0.2', B_PORT, { AI_BRIDGE_USER: 'carol' }); all.push(B)
  let G = await spawnG(); all.push(G)
  await sleep(900)
  const gid = await call(G, 'my_identity')
  check('harness: G is a gateway', gid.role === 'gateway', J([gid.role, gid.bridge_version]))

  // ---- one-shot: an agent creates itself with its label; a leading @ sets its line
  const o1 = await runLog([...ID, '--agent', 'build', '--label', 'Build', '--text', '@compiling 3 crates'])
  const r1 = res1(o1)
  check('one-shot: exit 0 + ONE JSON line, the 2.0 result shape (entry id, node { id, key, label, path, kind, created }, line set)', o1.code === 0 && o1.out.length === 1 && r1.ok === true && r1.session === 'Scripty'
    && r1.node?.key === 'build' && r1.node?.label === 'Build' && r1.node?.kind === 'agent' && r1.node?.created === true && /^[a-z2-7]{16}$/.test(r1.node?.id || '') && r1.line === true && r1.logged === true && typeof r1.id === 'string', J([o1.code, o1.out, o1.err.slice(0, 300)]))
  let b = await board(G)
  check('one-shot: on the board under project / user / session from the flags (the agent "Build", its line)', nodeOf(b, 'Scripty', 'Build')?.current?.text === 'compiling 3 crates' && nodeOf(b, 'Scripty', 'Build')?.kind === 'agent'
    && sess(b, 'Scripty')?.user === 'robin' && sess(b, 'Scripty')?.project === 'AIMB', J(sess(b, 'Scripty')))
  check('one-shot: the token is never printed', !o1.raw.includes(TOKEN) && !o1.err.includes(TOKEN))
  const o1b = await runLog([...ID, '--agent', 'build', '--text', 'plain text only logs'])
  b = await board(G)
  check('text rule (§4.0): plain --text only LOGS (line:false) — the line keeps its text', o1b.code === 0 && res1(o1b).line === false && res1(o1b).logged === true && nodeOf(b, 'Scripty', 'Build')?.current?.text === 'compiling 3 crates', J([res1(o1b), nodeOf(b, 'Scripty', 'Build')?.current]))
  const o1c = await runLog([...ID, '--agent', 'build', '--text', '@@home is where'])
  b = await board(G)
  check('text rule: "@@" is a literal "@" (logged, the line unchanged); "@@@x" sets the line to "@x"', o1c.code === 0 && res1(o1c).line === false && nodeOf(b, 'Scripty', 'Build')?.current?.text === 'compiling 3 crates'
    && (await runLog([...ID, '--agent', 'build', '--text', '@@@home'])).code === 0 && nodeOf(await board(G), 'Scripty', 'Build')?.current?.text === '@home', J(res1(o1c)))

  // ---- --key: created once, with --label (required); a sibling's label → "(2)"; a retry is idempotent
  const k0 = await runLog([...ID, '--agent', 'build', '--key', 'tiles', '--progress', '10/100:tiles'])
  check('--key without --label on a NEW node → label-required (exit 4: the gateway decides), nothing created', k0.code === 4 && res1(k0).code === 'label-required' && !nodeOf(await board(G), 'Scripty', 'Build/Tiles'), J([k0.code, k0.out]))
  const k1 = await runLog([...ID, '--agent', 'build', '--key', 'tiles', '--label', 'Tiles', '--progress', '10/100:tiles', '--eta', '1h25m'])
  b = await board(G)
  check('--key + --label creates the context in the agent\'s scope (scope "build"); progress-only = no line (§4.0), the bar + ETA move', k1.code === 0 && res1(k1).node?.scope === 'build' && res1(k1).node?.path === 'Build/Tiles' && res1(k1).node?.created === true
    && nodeOf(b, 'Scripty', 'Build/Tiles')?.progress?.done === 10 && !!nodeOf(b, 'Scripty', 'Build/Tiles')?.eta_at && !nodeOf(b, 'Scripty', 'Build/Tiles')?.current, J([res1(k1), nodeOf(b, 'Scripty', 'Build/Tiles')]))
  const nLogged = (await logOf(G, 'Scripty', res1(k1).node?.id, { own: true })).entries?.length
  const k2 = await runLog([...ID, '--agent', 'build', '--key', 'tiles', '--progress', '20/100:tiles', '--no-log'])
  b = await board(G)
  const nLogged2 = (await logOf(G, 'Scripty', res1(k1).node?.id, { own: true })).entries?.length
  check('--no-log: logged:false, the bar moves, nothing appended to the log', k2.code === 0 && res1(k2).logged === false && nodeOf(b, 'Scripty', 'Build/Tiles')?.progress?.done === 20 && nLogged2 === nLogged && nLogged === 1, J([res1(k2), nLogged, nLogged2]))
  const k3 = await runLog([...ID, '--agent', 'build', '--key', 'tiles', '--label', 'Other name', '--under', 'build', '--text', 'a retry'])
  check('§3.5: a retry naming an existing key changes nothing structural — a different --label / --under → warning exists', k3.code === 0 && (res1(k3).warnings || []).some(w => w.code === 'exists') && nodeOf(await board(G), 'Scripty', 'Build/Tiles')?.label === 'Tiles', J(res1(k3)))
  const n1 = await runLog([...ID, '--key', 'n1', '--label', 'Notes', '--text', 'first notes'])
  const n2 = await runLog([...ID, '--key', 'n2', '--label', 'Notes', '--text', 'second notes'])
  check('§1.6: a create whose label a sibling has gets "Notes (2)", reported (node.label + warning relabelled naming the sibling)', n1.code === 0 && n2.code === 0 && res1(n2).node?.label === 'Notes (2)'
    && (res1(n2).warnings || []).some(w => w.code === 'relabelled' && w.asked === 'Notes' && w.got === 'Notes (2)' && w.sibling?.key === 'n1'), J(res1(n2)))
  const n3 = await runLog([...ID, '--key', 'n2', '--label', 'Notes', '--text', 'again'])
  check('§3.5 / H19: repeating the asked label on the renamed node raises no exists (and makes no "(3)")', n3.code === 0 && !(res1(n3).warnings || []).some(w => w.code === 'exists') && res1(n3).node?.label === 'Notes (2)', J(res1(n3)))

  // ---- --data-file / --data / --details; the session's own line
  const dataFile = path.join(cfgDir, 'data.json')
  fs.writeFileSync(dataFile, '﻿' + J({ rows: 12, errors: [] }))
  const o4 = await runLog([...ID, '--agent', 'build', '--details', 'FULL LOG TAIL', '--data-file', dataFile, '--text', 'build linked'])
  const e4 = await call(G, 'activity', { entry: { id: res1(o4).id } })
  check('--data-file: the JSON (a BOM tolerated) + --details land on the entry', o4.code === 0 && e4.ok && e4.entry?.data?.rows === 12 && e4.entry?.details === 'FULL LOG TAIL', J([o4.out, e4]))
  const o5 = await runLog([...ID, '--data', '{"k":[1,2]}', '--state', 'blocked', '--stale-after', '60m', '--text', '@waiting on CI'])
  b = await board(G)
  check('--data inline + --state + --stale-after on the session itself (no --agent / --key)', o5.code === 0 && nodeOf(b, 'Scripty', '')?.current?.text === 'waiting on CI' && nodeOf(b, 'Scripty', '')?.state === 'blocked'
    && (await call(G, 'activity', { entry: { id: res1(o5).id } })).entry?.data?.k?.[1] === 2, J([o5.out, nodeOf(b, 'Scripty', '')]))

  // ---- --path (labels, quoted, below --agent) and --ctx; an alias after a rename
  const p1 = await runLog([...ID, '--path', 'Next release/Docs', '--text', '@writing'])
  const p2 = await runLog([...ID, '--path', 'Next release/"a/b test"', '--text', 'quoted'])
  const p3 = await runLog([...ID, '--agent', 'build', '--path', 'Research', '--text', 'below the agent'])
  const p4 = await runLog([...ID, '--agent', 'build', '--ctx', 'Notes', '--text', '@via --ctx'])
  b = await board(G)
  check('--path: labels from the root create the missing contexts; a quoted label holds "/"; with --agent it walks from the agent; --ctx = one more label', [p1, p2, p3, p4].every(r => r.code === 0)
    && nodeOf(b, 'Scripty', 'Next release/Docs')?.current?.text === 'writing' && nodeOf(b, 'Scripty', 'Next release/Docs')?.key === 'Docs' && !!nodeOf(b, 'Scripty', 'Next release/"a/b test"') && !!nodeOf(b, 'Scripty', 'Build/Research')
    && nodeOf(b, 'Scripty', 'Build/Notes')?.current?.text === 'via --ctx', J([[p1, p2, p3, p4].map(r => [r.code, res1(r).node?.path || res1(r).code]), (sess(b, 'Scripty')?.nodes || []).map(n => n.path)]))
  const docsId = res1(p1).node?.id
  const rn = await runLog([...ID, '--id', docsId, '--rename', 'Documentation'])
  const p5 = await runLog([...ID, '--path', 'Next release/Docs', '--text', 'by the old path'])
  check('--rename by --id; then the OLD path still lands in the same node (an alias, warning alias)', rn.code === 0 && p5.code === 0 && res1(p5).node?.id === docsId && res1(p5).node?.label === 'Documentation' && (res1(p5).warnings || []).some(w => w.code === 'alias'), J([res1(rn), res1(p5)]))

  // ---- plan items, --done, positions, --move
  const it1 = await runLog([...ID, '--key', 'rel', '--label', 'Release 2.0', '--text', '@the release plan', '--item', 'spec', 'Spec', '--item', 'Build it', '--item', 'test', 'Test'])
  b = await board(G)
  check('--item <k> "<label>" / --item "<label>": plan items in command-line order (keys: given, else the slug)', it1.code === 0 && res1(it1).node?.path === 'Release 2.0'
    && J((res1(it1).plan || []).map(p => [p.key, p.label, p.created])) === J([['spec', 'Spec', true], ['Build-it', 'Build it', true], ['test', 'Test', true]]), J([it1.code, res1(it1)]))
  const relPath = res1(it1).node?.path
  const it2 = await runLog([...ID, '--key', 'spec', '--done'])
  const it3 = await runLog([...ID, '--key', 'rel', '--item', 'readme', 'Readme', '--first'])
  b = await board(G)
  const relRow = nodeOf(b, 'Scripty', relPath)
  check('--done ticks an item (= --state done); --first places a NEW item first; the plan reads "1 of 4"', it2.code === 0 && nodeOf(b, 'Scripty', `${relPath}/Spec`)?.state === 'done' && it3.code === 0
    && (res1(it3).plan || [])[0]?.created === true && (relRow?.display?.bar || {}).total === 4 && (relRow?.display?.bar || {}).done === 1, J([res1(it2).state, res1(it3), relRow?.display]))
  const it4 = await runLog([...ID, '--key', 'rel', '--item', 'spec', 'Spec', '--item', 'readme', 'Readme'])
  check('re-sending the plan keeps the items as they are (created:false; Spec stays done)', it4.code === 0 && (res1(it4).plan || []).every(p => p.created === false) && nodeOf(await board(G), 'Scripty', `${relPath}/Spec`)?.state === 'done', J(res1(it4)))
  const mv = await runLog([...ID, '--key', 'n2', '--move', 'rel', '--rename', 'Release notes'])
  b = await board(G)
  check('--move <ref> --rename "<label>": one checked change (moved under rel, relabelled)', mv.code === 0 && !!res1(mv).moved && !!nodeOf(b, 'Scripty', `${relPath}/Release notes`), J(res1(mv)))
  const mvBad = await runLog([...ID, '--key', 'n1', '--move', 'rel', '--rename', 'Release notes'])
  check('--move onto a sibling\'s label → duplicate-label (exit 4), nothing moved', mvBad.code === 4 && res1(mvBad).code === 'duplicate-label' && !!nodeOf(await board(G), 'Scripty', 'Notes'), J(res1(mvBad)))

  // ---- §3.8's test run: --context-type=test-run, transient buckets, the typed field flags, --move-to
  const tr0 = await runLog([...ID, '--key', 'tests', '--label', 'Tests', '--context-type=test-run', '--text', '@test run'])
  const tr1 = await runLog([...ID, '--key', 'pending', '--label', 'Pending', '--under', 'tests', '--transient', '--item', 't1', 'test one', '--item', 't2', 'test two'])
  const tr2 = await runLog([...ID, '--key', 't1', '--state', 'running', '--move-to', '../In progress'])
  b = await board(G)
  check('--context-type=test-run + a --transient bucket of items; --move-to "../In progress" creates the sibling bucket (transient) and moves the test there', [tr0, tr1, tr2].every(r => r.code === 0)
    && nodeOf(b, 'Scripty', 'Tests')?.type === 'test-run' && nodeOf(b, 'Scripty', 'Tests/Pending')?.transient === true && nodeOf(b, 'Scripty', 'Tests/In progress/test one')?.state === 'running' && nodeOf(b, 'Scripty', 'Tests/In progress')?.transient === true,
    J([[tr0, tr1, tr2].map(r => res1(r).code || res1(r).node?.path), (sess(b, 'Scripty')?.nodes || []).filter(n => n.path.startsWith('Tests')).map(n => n.path)]))
  const tr3 = await runLog([...ID, '--key', 't1', '--message-type=test-result', '--result', 'pass', '--checks', '22', '--failed', '0', '--duration', '4.1s', '--move-to', '../Passed'])
  b = await board(G)
  const t1row = nodeOf(b, 'Scripty', 'Tests/Passed/test one')
  check('typed field flags: --message-type=test-result --result --checks --failed --duration → the node keeps the result (duration in ms), state done; In progress VANISHED (emptied transient)', tr3.code === 0
    && t1row?.state === 'done' && t1row?.test?.result === 'pass' && t1row?.test?.checks === 22 && t1row?.test?.duration === 4100 && !nodeOf(b, 'Scripty', 'Tests/In progress'), J([res1(tr3), t1row]))
  const tr4 = await runLog([...ID, '--key', 't2', '--message-type=test-result', '--result', 'fail', '--checks', '5', '--failed', '2', '--move-to', '/Tests/Failed', '--details', 'FAIL a\nFAIL b'])
  b = await board(G)
  check('--move-to "/Tests/Failed" (absolute); Pending vanished with its last test; the run shows ONE tests bar: 1 passed / 1 failed of 2, 27 checks (Q56)', tr4.code === 0 && nodeOf(b, 'Scripty', 'Tests/Failed/test two')?.test?.result === 'fail'
    && !nodeOf(b, 'Scripty', 'Tests/Pending') && (d => d && d.show === 'tests' && d.tests && d.tests.passed === 1 && d.tests.failed === 1 && d.tests.total === 2 && d.tests.counts.checks === 27)(nodeOf(b, 'Scripty', 'Tests')?.display), J([res1(tr4).code, nodeOf(b, 'Scripty', 'Tests')?.display]))
  const tr5 = await runLog([...ID, '--key', 't2', '--move-to', 'Passed'])
  check('--move-to "Passed" (a bare name) → bad-path with suggest "/…" (Q45 / Q46), nothing moved', tr5.code === 4 && res1(tr5).code === 'bad-path' && /^\//.test(res1(tr5).suggest || '') && !!nodeOf(await board(G), 'Scripty', 'Tests/Failed/test two'), J(res1(tr5)))
  const fl = await Promise.all([runLog([...ID, '--key', 'x9', '--result', 'pass']), runLog([...ID, '--key', 'x9', '--message-type=note', '--checks', '3'])])
  check('typed field flags without their --message-type → bad-fields locally (exit 64), naming the type', fl.every(r => r.code === 64 && res1(r).code === 'bad-fields' && /--message-type=test-result/.test(res1(r).what)), J(fl.map(r => res1(r))))
  const tr6 = await runLog([...ID, '--key', 'grp', '--label', 'Ideas', '--context-type=group', '--item', 'Idea one'])
  check('--context-type=group: a list (type group), its items under it', tr6.code === 0 && nodeOf(await board(G), 'Scripty', 'Ideas')?.type === 'group', J(res1(tr6)))

  // ---- --resolve: read-only
  const rs1 = await runLog([...ID, '--resolve', '../Released', '--key', 't1'])
  const rs2 = await runLog([...ID, '--resolve', '/Tests/Passed', '--key', 't1'])
  check('--resolve "../X" from a node: the absolute path a move there would take, state new + what it would create; an existing one → its id; nothing changes', rs1.code === 0 && res1(rs1).ok === true && res1(rs1).path === '/Tests/Released' && res1(rs1).state === 'new'
    && J(res1(rs1).create) === J(['Released']) && rs2.code === 0 && res1(rs2).state === 'live' && res1(rs2).id === nodeOf(await board(G), 'Scripty', 'Tests/Passed')?.id && !nodeOf(await board(G), 'Scripty', 'Tests/Released'), J([res1(rs1), res1(rs2)]))

  // ---- the `resolve` TOOL (Q46), forwarded by a FOLLOWER to the gateway (the ACTIVITY frame's new op); stopped at once
  const F = await spawnBridge('ScriptF', '127.0.0.1', PORT, { AI_BRIDGE_USER: 'alice' }); all.push(F)
  const fid = await call(F, 'my_identity')
  await call(F, 'register_self', { name: 'ToolF', secret: 'tf', project: 'AIMB' })
  const tl = await call(F, 'log', { as: 'ToolF', secret: 'tf', key: 'a', label: 'Alpha', plan: [{ key: 'b', label: 'Beta' }] })
  const rt1 = await call(F, 'resolve', { as: 'ToolF', secret: 'tf', key: 'b', resolve: '../Gamma' })
  const rt2 = await call(F, 'resolve', { as: 'ToolF', secret: 'tf', key: 'b', resolve: '/Alpha/Beta' })
  check('resolve tool via a follower: "../Gamma" from Alpha/Beta → /Gamma (new); "/Alpha/Beta" → live, its id; nothing created', fid.role === 'follower' && tl.ok && rt1.ok === true && rt1.path === '/Gamma' && rt1.state === 'new'
    && rt2.ok === true && rt2.state === 'live' && rt2.id === (tl.plan || [])[0]?.id && !nodeOf(await board(G), 'ToolF', 'Gamma'), J([fid.role, rt1, rt2]))
  const rt3 = await call(F, 'resolve', { resolve: '../x' }), rt4 = await call(F, 'resolve', { as: 'ToolF', secret: 'tf', key: 'nope', resolve: '../x' })
  check('resolve tool: without as → as-required; an unknown key → unknown-node', rt3.code === 'as-required' && rt4.ok === false && rt4.code === 'unknown-node', J([rt3, rt4]))
  try { await F.transport.close() } catch { }
  all.splice(all.indexOf(F), 1)
  await sleep(500)

  // ---- questions + waits (exit 0 answered · 10 timeout · 11 expired · 12 withdrawn)
  const q1 = await runLog([...ID, '--ask', 'Which database should the cache use?', '--choice', 'Postgres', '--choice', 'SQLite', '--wait', '1s'])
  const q1r = res1(q1)
  check('--ask … --wait 1s: no answer in time → exit 10, outcome timeout (the question stays open), the ask named (node id + key ?1)', q1.code === 10 && q1r.outcome === 'timeout' && q1r.asked?.node?.key === '?1' && /^[a-z2-7]{16}$/.test(q1r.asked?.node?.id || ''), J([q1.code, q1.out]))
  const qid = q1r.asked?.node?.id
  b = await board(G)
  check('the question is on the board: ?1 under the session, blocked, its line the question, its choices structured', nodeOf(b, 'Scripty', '?1')?.type === 'question' && nodeOf(b, 'Scripty', '?1')?.current?.question?.status === 'asked'
    && J(nodeOf(b, 'Scripty', '?1')?.current?.question?.choices) === J(['Postgres', 'SQLite']), J(nodeOf(b, 'Scripty', '?1')))
  const waiting = runLog([...ID, '--wait-answer', '--key', '?1', '--wait', '20s'])
  await sleep(1200)
  const dash = await dashboard()
  const an = await dash.act({ session: 'Scripty', project: 'AIMB', user: 'robin', id: qid, action: 'answer', args: { choice: 'Postgres' } })
  const w1 = await waiting
  check('--wait-answer --key ?1: a dashboard answer releases the waiting script → exit 0, the answer in the JSON line', an.ok === true && w1.code === 0 && res1(w1).outcome === 'answered' && res1(w1).answer?.choice === 'Postgres', J([an, w1.code, w1.out]))
  const w1b = await runLog([...ID, '--wait-answer', '--id', qid, '--wait', '2s'])
  check('--wait-answer on an already-answered question (by --id) → exit 0 at once', w1b.code === 0 && res1(w1b).outcome === 'answered' && res1(w1b).waited_ms < 1500, J(w1b.out))
  const q2 = await runLog([...ID, '--key', 'q2', '--label', 'Ship decision', '--ask', 'Ship it today?', '--choice', 'Yes', '--choice', 'No'])
  const q2w = await runLog([...ID, '--key', 'q2', '--state', 'withdrawn', '--text', 'no longer needed'])
  const w2 = await runLog([...ID, '--wait-answer', '--key', 'q2', '--wait', '3s'])
  check('a NEW line-less context asked on becomes the question itself; withdrawn by its asker → --wait-answer exits 12', q2.code === 0 && res1(q2).node?.key === 'q2' && q2w.code === 0 && w2.code === 12 && res1(w2).outcome === 'withdrawn', J([res1(q2).node, res1(q2w).code, w2.code, w2.out]))
  const q3 = await runLog([...ID, '--key', 'q3', '--label', 'Quick one', '--ask', 'Is this still relevant?', '--free', '--expires', '2s', '--wait', '15s'])
  check('--ask --expires 2s --wait 15s: the gateway\'s expiry timer closes it → exit 11, outcome expired (well before the wait ran out)', q3.code === 11 && res1(q3).outcome === 'expired' && res1(q3).waited_ms < 10000, J([q3.code, q3.out]))
  const w3 = await runLog([...ID, '--wait-answer', '--key', 'n1', '--wait', '2s'])
  check('--wait-answer on a node that is not a question → not-a-question (exit 4)', w3.code === 4 && res1(w3).code === 'not-a-question', J(w3.out))

  // ---- --guide agent = the agent's FIRST REPORT (§4.4); --guide session prints only
  const g1 = await runLog([...ID, '--agent', 'helper', '--label', 'Helper', '--under', 'rel', '--guide', 'agent'])
  b = await board(G)
  const helper = nodeOf(b, 'Scripty', `${relPath}/Helper`)
  check('--guide agent --agent helper --label "Helper" --under rel: prints the 2.0 guide AND puts the agent on the board (under rel, running, "reading the guide")', g1.code === 0 && /ACTIVITY BOARD — how to report your work/.test(g1.raw)
    && /You are the agent helper/.test(g1.raw) && /\(You are on the board now as "Helper"/.test(g1.raw) && helper?.kind === 'agent' && helper?.state === 'running' && helper?.current?.text === 'reading the guide', J([g1.code, g1.raw.slice(-500), helper]))
  check('--guide agent: the guide teaches the 2.0 forms (--key / --label, a leading @, --item <k> "<label>", "@<summary>") and no 1.7x form (@~, --path "…/@…")', /--key <k> names YOUR node/.test(g1.raw) && /--text "@<what>" sets the node's line/.test(g1.raw)
    && /--item <k> "<label>"/.test(g1.raw) && /--state done --text "@<summary>"/.test(g1.raw) && !/@~/.test(g1.raw), g1.raw.slice(0, 600))
  const helperLog = (await logOf(G, 'Scripty', helper?.id, { own: true })).entries?.length
  const g2 = await runLog([...ID, '--agent', 'helper', '--guide', 'agent'])
  const helperLog2 = (await logOf(G, 'Scripty', helper?.id, { own: true })).entries?.length
  check('--guide agent again (already on the board): prints only — "(Already on the board as …)", nothing written', g2.code === 0 && /\(Already on the board as "Helper"/.test(g2.raw) && helperLog2 === helperLog && nodeOf(await board(G), 'Scripty', `${relPath}/Helper`)?.current?.text === 'reading the guide', J([g2.code, g2.raw.slice(-300), helperLog, helperLog2]))
  const g3 = await runLog([...ID, '--agent', 'nolabel', '--guide', 'agent'])
  check('--guide agent for a NEW agent without --label: the guide, then the error (label-required), exit 64; nothing created', g3.code === 64 && /ACTIVITY BOARD/.test(g3.raw) && /label-required/.test(g3.raw) && !(sess(await board(G), 'Scripty')?.nodes || []).some(n => n.key === 'nolabel'), J([g3.code, g3.raw.slice(-300)]))
  const g4 = await runLog([...ID, '--guide', 'session'])
  check('--guide session: the session\'s 2.0 guide (brief an agent with --agent <key> --label "…" --under <item key> --guide agent), exit 0', g4.code === 0 && /briefs its agents/.test(g4.raw) && /--agent <key> --label "<its name>" --under fix-x --guide agent/.test(g4.raw) && !/@~/.test(g4.raw), g4.raw.slice(0, 400))
  const g5 = await runLog([...ID, '--agent', 'helper', '--guide', 'agent', '--text', 'x'])
  check('--guide with report flags → usage (exit 64)', g5.code === 64 && res1(g5).code === 'usage', J(g5.out))

  // ---- the REMOVED 1.7x forms (§4.5): each refused legacy-form, exit 64, the message naming the 2.0 form
  const lf = async (args, name, re) => { const r = await runLog([...ID, ...args]); check(`legacy-form (${name}): exit 64, the message names the 2.0 form`, r.code === 64 && res1(r).code === 'legacy-form' && re.test(res1(r).what || ''), J([r.code, r.out])) }
  await lf(['positional', 'text'], 'positional text', /use --text "…"/)
  await lf(['--plan', 'A', 'B'], '--plan', /use --item "A" --item "B"/)
  await lf(['--move', 'x', '--to', 'y'], '--move … --to', /use --key <node> --move <parent>/)
  await lf(['--path', '@Next release/@Docs', '--text', 'x'], '@ in a path', /paths have no @ in 2\.0: write "Next release\/Docs"/)
  await lf(['--path', 'Next release/@~Docs', '--text', 'x'], '@~ in a path', /@~ was removed in 2\.0: use --text "@…"/)
  await lf(['--text', '@~root my headline'], '@~ in the text', /@~ was removed in 2\.0: use --text "@my headline"/)
  await lf(['--agent', 'a', '--ctx', '@~Ctx', '--text', 'x'], '--ctx "@~Ctx"', /--ctx takes a label in 2\.0 \(no @\): --ctx "Ctx"/)
  await lf(['--key', 'rel', '--item', '@~root headline'], '--item "@~…"', /@~ was removed in 2\.0/)
  // … and at the GATEWAY (an old script or a pasted 1.7x call over the logger link)
  const lk = await loggerLink({ session: 'Scripty', project: 'AIMB', user: 'robin' })
  check('logger welcome: activity_format 6 (what the 2.0 script checks)', lk.welcome?.logger === true && lk.welcome?.activity_format === 6, J(lk.welcome))
  const gl = []
  for (const input of [{ path: '@Next release/@Docs', text: 'x' }, { text: '@~root x' }, { move: 'x', to: 'y' }, { note: 'x' }, { context: '@~root', text: 'x' }]) gl.push((await lk.req({ type: 'log', input }, 'logged')).result)
  check('gateway: an @ path, @~ text, to, note and context in a logger report → legacy-form each (nothing written)', gl.every(r => r && r.ok === false && r.code === 'legacy-form'), J(gl))
  const wl = (await lk.req({ type: 'wait_answer', path: '@?1', timeout_ms: 1000 }, 'answer')).result
  check('gateway: a 1.7x wait_answer by "@?1" path → legacy-form', wl?.ok === false && wl?.code === 'legacy-form', J(wl))
  const wid = (await lk.req({ type: 'wait_answer', node_id: qid, timeout_ms: 1000 }, 'answer')).result
  check('gateway: wait_answer { node_id } (§4.2) on an answered question → at once, outcome answered', wid?.ok === true && wid?.outcome === 'answered' && wid?.id === qid, J(wid))
  const rsl = (await lk.req({ type: 'resolve', input: { resolve: '../Released', key: 't1' } }, 'resolved')).result
  check('gateway: {type:"resolve"} on the logger link answers like --resolve', rsl?.ok === true && rsl?.path === '/Tests/Released', J(rsl))
  // the logger WS takes a 2.0 batch: { items, agent } → per-item results (refs), each item its own call
  const wsb = (await lk.req({ type: 'log', input: { agent: 'build', items: [{ ref: 1, key: 'w1', label: 'W one', text: '@one' }, { ref: 2, key: 'w1', text: 'two' }, { ref: 3, path: '@old', text: 'x' }] } }, 'logged')).result
  check('logger WS: a batch → one reply, per-item results in order with refs; agent is the default; a legacy item fails alone', wsb?.ok === true && wsb.applied === 2 && wsb.failed === 1
    && J((wsb.results || []).map(r => [r.ref, r.ok, r.node?.path || r.code])) === J([[1, true, 'Build/W one'], [2, true, 'Build/W one'], [3, false, 'legacy-form']]), J(wsb))
  try { lk.ws.close() } catch { }

  // ---- gateway-unsupported: a gateway that does not speak 2.0 (its welcome has no activity_format)
  const fakeGot = []
  fake = new WebSocketServer({ host: '127.0.0.1', port: Number(FAKE_WS) })
  fake.on('connection', ws => ws.on('message', raw => { const m = JSON.parse(String(raw)); fakeGot.push(m.type); if (m.type === 'hello') ws.send(J({ type: 'welcome', logger: true, bridge_version: '1.75.1', ident: m.ident })) }))
  await sleep(200)
  const fu = await runLog([...ID, '--ws-port', FAKE_WS, '--key', 'x', '--label', 'X', '--text', 'hi'])
  check('gateway-unsupported: a 1.7x gateway → exit 4 BEFORE anything is sent (no log message reached it)', fu.code === 4 && res1(fu).code === 'gateway-unsupported' && /1\.75\.1/.test(res1(fu).what) && !fakeGot.includes('log'), J([fu.code, fu.out, fakeGot]))
  const fg = await runLog([...ID, '--ws-port', FAKE_WS, '--agent', 'h2', '--label', 'H2', '--guide', 'agent'])
  check('gateway-unsupported: --guide still prints its built-in 2.0 text, with the note that this gateway is not on 2.0 (and no registration)', fg.code === 0 && /ACTIVITY BOARD/.test(fg.raw) && /runs 1\.75\.1, not 2\.0/.test(fg.raw)
    && /Not on the board yet/.test(fg.raw) && !fakeGot.includes('guide'), J([fg.code, fg.raw.slice(-400), fakeGot]))

  // ---- --batch <file|->: ONE call, one result line; per-item results; exit 0 / 4 / 64
  await runLog([...ID, '--agent', 'batcher', '--label', 'Batcher', '--text', '@batching'])
  const batchFile = path.join(cfgDir, 'batch.json')
  fs.writeFileSync(batchFile, J([{ ref: 'one', key: 'step', label: 'Step', text: '@first', progress: '1/3' }, { ref: 'two', key: 'step', text: '@second', progress: '2/3' }, { ref: 'abs', path: 'Top/Z', text: 'absolute' }]))
  const bf = await runLog([...ID, '--agent', 'batcher', '--batch', batchFile])
  b = await board(G)
  check('--batch file: exit 0, ONE line {ok, results:[…]} in order with refs; --agent is every item\'s default (a path walks from it)', bf.code === 0 && bf.out.length === 1 && res1(bf).ok === true
    && J((res1(bf).results || []).map(r => [r.ref, r.ok, r.node?.path])) === J([['one', true, 'Batcher/Step'], ['two', true, 'Batcher/Step'], ['abs', true, 'Batcher/Top/Z']]), J([bf.code, bf.out, bf.err.slice(0, 300)]))
  check('--batch file: applied in order (the last line + bar win)', nodeOf(b, 'Scripty', 'Batcher/Step')?.current?.text === 'second' && nodeOf(b, 'Scripty', 'Batcher/Step')?.progress?.done === 2)
  const bs = await runLog([...ID, '--batch', '-'], { stdin: J([{ key: 'sa', label: 'Stdin A', text: '@from stdin' }, { key: 'sb', text: 'no label' }, { key: 'sa', state: 'stale' }, { key: 'sc', label: 'Stdin C', text: '@still applied' }]) })
  check('--batch -: read from stdin; bad items fail alone (label-required, bad-state) → exit 4 (applied 2, failed 2)', bs.code === 4 && res1(bs).ok === true && res1(bs).applied === 2 && res1(bs).failed === 2
    && res1(bs).results?.[1]?.code === 'label-required' && res1(bs).results?.[2]?.code === 'bad-state', J([bs.code, bs.out]))
  b = await board(G)
  check('--batch -: the good items are on the board', nodeOf(b, 'Scripty', 'Stdin A')?.current?.text === 'from stdin' && nodeOf(b, 'Scripty', 'Stdin C')?.current?.text === 'still applied')
  const bu = await Promise.all([
    runLog([...ID, '--batch', path.join(cfgDir, 'missing.json')]),
    runLog([...ID, '--batch', '-'], { stdin: '{not json' }),
    runLog([...ID, '--batch', '-'], { stdin: J({ text: 'an object, not an array' }) }),
    runLog([...ID, '--batch', '-'], { stdin: J(Array.from({ length: 65 }, () => ({ text: 'x' }))) }),
    runLog([...ID, '--batch', '-'], { stdin: J(Array.from({ length: 20 }, () => ({ text: 'x', details: 'd'.repeat(4000) }))) }),
    runLog([...ID, '--batch', batchFile, '--path', 'x']),
    runLog([...ID, '--batch', batchFile, '--state', 'done']),
    runLog([...ID, '--batch', batchFile, '--stream']),
    runLog([...ID, '--batch', '-'], { stdin: J([{ text: 'x', bogus: 1 }]) }),
  ])
  check('--batch usage: unreadable / bad JSON / not an array → bad-batch; 65 items → too-many-items; > 64 KB → batch-too-large; --path / message flags / --stream → usage (all exit 64); an unknown item field → that item fails (exit 4)',
    bu.slice(0, 8).every(r => r.code === 64) && J(bu.slice(0, 8).map(r => res1(r).code)) === J(['bad-batch', 'bad-batch', 'bad-batch', 'too-many-items', 'batch-too-large', 'usage', 'usage', 'usage'])
    && bu[8].code === 4 && res1(bu[8]).results?.[0]?.code === 'bad-field', J(bu.map(r => [r.code, res1(r).code || res1(r).results?.[0]?.code])))

  // ---- usage errors → 64 (one JSON line with a code; usage on stderr)
  const u = await Promise.all([
    runLog(['--project', 'AIMB', '--text', 'x']),
    runLog(['--session', 'S', '--text', 'x']),
    runLog([...ID, '--bogus', 'x']),
    runLog([...ID, '--token', 'SEKRET-IN-ARGV', '--text', 'x']),
    runLog([...ID, '--data', '{nope', '--text', 'x']),
    runLog([...ID, '--state', 'stale', '--text', 'x']),
    runLog([...ID, '--key', 'a', '--path', 'b', '--text', 'x']),
    runLog([...ID, '--data', '{}', '--data-file', dataFile, '--text', 'x']),
    runLog([...ID, '--stream', '--text', 'x']),
    runLog([...ID, '--stream', '--progress', '1/2']),
    runLog([...ID, '--data-file', path.join(cfgDir, 'missing.json'), '--text', 'x']),
    runLog([...ID, '--agent']),
    runLog([...ID, '--text', 'x'], { env: { AI_BRIDGE_TOKEN: undefined, AI_BRIDGE_CONFIG: noTokCfg } }),
    runLog([...ID, '--key', 'bad:key', '--text', 'x']),
  ])
  check('usage: every bad call exits 64', u.every(r => r.code === 64), J(u.map(r => r.code)))
  check('usage: codes (usage ×2, usage, token-in-argv, bad-data, bad-state, bad-address, usage ×3, bad-data, usage, no-token, bad-key)',
    J(u.map(r => res1(r).code)) === J(['usage', 'usage', 'usage', 'token-in-argv', 'bad-data', 'bad-state', 'bad-address', 'usage', 'usage', 'usage', 'bad-data', 'usage', 'no-token', 'bad-key']), J(u.map(r => res1(r).code)))
  check('usage: --token is refused WITHOUT echoing its value', !u[3].raw.includes('SEKRET-IN-ARGV') && !u[3].err.includes('SEKRET-IN-ARGV') && /AI_BRIDGE_TOKEN/.test(res1(u[3]).what || ''), J(res1(u[3])))
  check('usage: the usage text goes to stderr', u.filter(r => res1(r).code === 'usage').every(r => /usage: aimb-log/.test(r.err)))

  // ---- no bridge → 4; a bad token → 4
  const nb = await runLog([...ID, '--ws-port', DEAD_WS, '--text', 'hello'])
  check('no bridge: exit 4, link-error', nb.code === 4 && res1(nb).ok === false && res1(nb).code === 'link-error', J([nb.code, nb.out]))
  const nb2 = await runLog([...ID, '--text', 'hello'], { env: { AI_BRIDGE_TOKEN: 'wrong-token' } })
  check('bad token: exit 4, unauthorized', nb2.code === 4 && res1(nb2).code === 'unauthorized', J([nb2.code, nb2.out]))

  // ---- session-user-mismatch: a live sub-peer under ANOTHER user (this host: alice; host B: carol)
  const wk = await call(G, 'register_self', { name: 'Worker', secret: 'wk', project: 'AIMB' })   // user = alice (AI_BRIDGE_USER)
  await call(B, 'register_self', { name: 'Remote', secret: 'rm', project: 'Marz' })                // user = carol, on host B
  const mm1 = await runLog(['--session', 'Worker', '--project', 'AIMB', '--user', 'bob', '--text', 'pretending'])
  check('mismatch: a live sub-peer (alice) + a script claiming bob → session-user-mismatch, exit 4', mm1.code === 4 && res1(mm1).code === 'session-user-mismatch', J([mm1.code, mm1.out]))
  const mm2 = await runLog(['--session', 'worker', '--project', 'aimb', '--user', 'bob', '--text', 'pretending'])
  check('mismatch: the session + project match case-insensitively', res1(mm2).code === 'session-user-mismatch', J(mm2.out))
  const mm3 = await runLog(['--session', 'Worker', '--project', 'AIMB', '--user', 'ALICE', '--text', '@reporting for myself'])
  check('mismatch: the SAME user (case-insensitive) is accepted', mm3.code === 0 && res1(mm3).ok === true, J(mm3.out))
  const mm4 = await runLog(['--session', 'Worker', '--project', 'Other', '--user', 'bob', '--text', 'another project'])
  check('mismatch: the same name in ANOTHER project is not that session (accepted)', mm4.code === 0 && res1(mm4).ok === true, J(mm4.out))
  const mmg = await runLog(['--session', 'Worker', '--project', 'AIMB', '--user', 'bob', '--agent', 'imp', '--label', 'Imp', '--guide', 'agent'])
  check('mismatch: --guide agent for that session prints the guide but registers nothing (session-user-mismatch, exit 4)', mmg.code === 4 && /ACTIVITY BOARD/.test(mmg.raw) && /session-user-mismatch/.test(mmg.raw), J([mmg.code, mmg.raw.slice(-300)]))
  await until(async () => (await call(G, 'list_sessions')).sessions || [], ss => ss.some(s => (s.subpeers || []).some(sp => sp.name === 'Remote')), 8000)
  const mm5 = await runLog(['--session', 'Remote', '--project', 'Marz', '--user', 'bob', '--text', 'pretending remotely'])
  const mm6 = await runLog(['--session', 'Remote', '--project', 'Marz', '--user', 'carol', '--text', 'carol for herself'])
  check('mismatch: a live sub-peer on ANOTHER host (gossiped roster) is protected too; its own user is accepted', res1(mm5).code === 'session-user-mismatch' && res1(mm6).ok === true, J([mm5.out, mm6.out]))
  await call(G, 'deregister', { peer_id: wk.peer_id, secret: 'wk' })
  await sleep(300)
  const mm7 = await runLog(['--session', 'Worker', '--project', 'AIMB', '--user', 'bob', '--text', 'after it left'])
  check('mismatch: once the sub-peer left the roster, anyone holding the token may report as it', mm7.code === 0 && res1(mm7).ok === true, J(mm7.out))

  // ---- --stream: many lines, one result each in order, bad / legacy lines in place, the logger never on the roster, EOF → 0
  const before = await call(G, 'list_sessions')
  const st = streamLog(['--session', 'Streamer', '--project', 'AIMB', '--user', 'robin', '--agent', 'pump', '--no-log'])
  const N = 150, sent = []
  const send = (o, want) => { sent.push(want); st.send(o) }
  send({ label: 'Pump', text: '@pumping', log: true }, 'agent')
  send({ key: 'rows', label: 'Rows', progress: `0/${N}:rows` }, 'rows')
  for (let i = 1; i <= N; i++) {
    if (i === 40) send('{not json', 'bad-json')
    if (i === 80) send({ session: 'Hijack', progress: '1/2' }, 'bad-field')
    if (i === 100) send({ text: '@milestone: 100 rows', log: true, ref: 'm100' }, 'm100')
    if (i === 110) send({ path: 'Old/@~x', text: 'y' }, 'legacy-path')
    if (i === 111) send({ context: '@~root', text: 'y' }, 'legacy-context')
    if (i === 120) send([{ ref: 'b1', key: 'arr', label: 'Arr', text: '@array one', log: true }, { ref: 'b2', key: 'arr', state: 'nope' }], 'batch')
    if (i === 121) send([], 'empty-batch')
    send({ key: 'rows', progress: `${i}/${N}:rows` }, 'p')
  }
  await st.waitLines(sent.length, 20000)
  const mid = await call(G, 'list_sessions')
  check('logger: never on the roster (no session, no page) while a stream is connected', J((mid.sessions || []).map(s => s.session)) === J((before.sessions || []).map(s => s.session))
    && (mid.pages || []).length === (before.pages || []).length && !J(mid).includes('Streamer'), J([mid.sessions?.length, mid.pages]))
  st.end()
  await st.closed
  const L = st.lines, at = w => L[sent.indexOf(w)]
  check('stream: one result per input line, in input order (line = the input line number; a result\'s own line flag is line_set)', L.length === sent.length && L.every((x, i) => x.line === i + 1) && at('agent')?.line_set === true, J([L.length, sent.length, L.map(x => x.line).slice(0, 12)]))
  check('stream: bad lines are answered in place (bad-json, bad-field, an empty batch), and the 1.7x lines → legacy-form (an @~ path, context)', at('bad-json')?.code === 'bad-json' && at('bad-field')?.code === 'bad-field' && at('empty-batch')?.code === 'bad-batch'
    && at('legacy-path')?.code === 'legacy-form' && at('legacy-context')?.code === 'legacy-form', J([at('bad-json'), at('bad-field'), at('empty-batch'), at('legacy-path'), at('legacy-context')]))
  check('stream: every progress line went through', L.filter((x, i) => sent[i] === 'p').every(x => x.ok === true) && at('agent')?.node?.kind === 'agent' && at('rows')?.node?.path === 'Pump/Rows', J([at('agent'), at('rows')]))
  check('stream: an ARRAY line is a batch — one result line {line, ok, results} with refs; --agent applies; a bad item fails alone', at('batch')?.ok === true && J((at('batch')?.results || []).map(r => [r.ref, r.ok, r.code || r.node?.path])) === J([['b1', true, 'Pump/Arr'], ['b2', false, 'bad-state']]), J(at('batch')))
  check('stream: a line may override the defaults (log:true) and its ref is echoed; the agent default targets the agent', at('m100')?.ref === 'm100' && at('m100')?.logged === true && at('m100')?.node?.key === 'pump' && L[L.length - 1]?.logged === false, J([at('m100'), L[L.length - 1]]))
  check('stream: stdin EOF → exit 0', st.code === 0, String(st.code))
  b = await board(G)
  check('stream: the board has the last bar and the milestone line', nodeOf(b, 'Streamer', 'Pump/Rows')?.progress?.done === N && nodeOf(b, 'Streamer', 'Pump')?.current?.text === 'milestone: 100 rows', J([nodeOf(b, 'Streamer', 'Pump'), nodeOf(b, 'Streamer', 'Pump/Rows')?.progress]))

  // ---- prepare-shutdown: auth
  const pa = await Promise.all([prepare('wrong'), prepare(null), post(`/admin/prepare-shutdown?token=${TOKEN}`), post('/admin/prepare-shutdown', { Authorization: `Bearer ${TOKEN}` }, 'GET'), post('/admin/nope', { Authorization: `Bearer ${TOKEN}` })])
  check('prepare-shutdown: bad token 401, missing 401, a token in the URL is NOT accepted (401), GET 405, unknown path 404', J(pa.map(r => r.status)) === J([401, 401, 401, 405, 404]), J(pa.map(r => [r.status, r.body && r.body.code])))

  // ---- prepare-shutdown: the flush. A log:false burst (no checkpoint for 10 min) survives a HARD kill only via the endpoint.
  const burst = async (session, upTo) => {
    const s = streamLog(['--session', session, '--project', 'AIMB', '--user', 'robin', '--agent', 'seed'])
    s.send({ label: 'Seed', text: '@seeding' })
    s.send({ key: 'bar', label: 'Bar', text: '@Seeding {progress}', progress: `1/${upTo}:tiles` })   // logged: the file knows the node and its first bar
    for (let i = 2; i <= upTo; i++) s.send({ key: 'bar', progress: `${i}/${upTo}:tiles`, log: false })
    s.end(); await s.closed
    return { ok: s.lines.filter(x => x.ok).length, id: (s.lines[1] && s.lines[1].node && s.lines[1].node.id) || null }
  }
  const fl1 = await burst('Flushy', 60)
  check('flush: a burst of log:false progress (Flushy: 2 logged + 59 board-only)', fl1.ok === 61 && !!fl1.id, J(fl1))
  check('flush: nothing checkpointed yet (10-minute interval)', !records().some(r => r.kind === 'cp' && r.n === fl1.id))
  const pr = await prepare()
  check('prepare-shutdown: 200 {ok, flushed:{cp ≥ 1}} for the bearer token', pr.status === 200 && pr.body?.ok === true && pr.body?.flushed?.cp >= 1 && typeof pr.body?.flushed?.files_drained === 'number', J(pr))
  check('prepare-shutdown: the v6 cp is ON DISK when it answers (bar 60/60, by node id)', records().some(r => r.v === 6 && r.kind === 'cp' && r.n === fl1.id && r.progress?.done === 60), J(records().filter(r => r.kind === 'cp').slice(-3)))
  await hardKill(G); all.splice(all.indexOf(G), 1)
  G = await spawnG(); all.push(G)
  let fb = await until(() => board(G), x => !!nodeOf(x, 'Flushy', 'Seed/Bar'), 10000)
  check('flush: after a HARD kill + restart the bar survived (60, not the logged 1)', nodeOf(fb, 'Flushy', 'Seed/Bar')?.progress?.done === 60 && nodeOf(fb, 'Flushy', 'Seed/Bar')?.current?.text === 'Seeding {progress}', J(nodeOf(fb, 'Flushy', 'Seed/Bar')))
  // negative control: the same burst, NO endpoint call, a hard kill → the bar falls back to the last LOGGED progress
  check('control: a second burst (Lossy) without prepare-shutdown', (await burst('Lossy', 60)).ok === 61)
  await hardKill(G); all.splice(all.indexOf(G), 1)
  G = await spawnG(); all.push(G)
  fb = await until(() => board(G), x => !!nodeOf(x, 'Lossy', 'Seed/Bar'), 10000)
  check('control: without the endpoint the hard kill LOSES the log:false bar (back to the logged 1/60)', nodeOf(fb, 'Lossy', 'Seed/Bar')?.progress?.done === 1 && nodeOf(fb, 'Flushy', 'Seed/Bar')?.progress?.done === 60, J(nodeOf(fb, 'Lossy', 'Seed/Bar')))

  // ---- --stream reconnect across a gateway restart (a line written while it is down is queued, then delivered)
  const rs = streamLog(['--session', 'Rejoin', '--project', 'AIMB', '--user', 'robin'], { AIMB_LOG_BACKOFF_MAX_MS: '400', AIMB_LOG_LINE_WAIT_MS: '20000' })
  rs.send({ text: '@before the restart' })
  await rs.waitLines(1)
  check('reconnect: the first line went through', rs.lines[0]?.ok === true, J(rs.lines))
  await hardKill(G); all.splice(all.indexOf(G), 1)
  await sleep(500)
  rs.send({ text: '@written while the gateway was down', progress: '5/10' })
  await sleep(800)
  check('reconnect: the line waits (no answer while there is no gateway)', rs.lines.length === 1 && rs.code === null, J(rs.lines))
  G = await spawnG(); all.push(G)
  await rs.waitLines(2, 15000)
  rs.send({ text: '@after the restart' })
  await rs.waitLines(3, 10000)
  rs.end(); await rs.closed
  check('reconnect: the queued line was delivered after the restart, then the next one', rs.lines[1]?.ok === true && rs.lines[1]?.line === 2 && rs.lines[2]?.ok === true && rs.code === 0, J([rs.lines, rs.code, rs.err.slice(0, 300)]))
  b = await board(G)
  check('reconnect: the board has the post-restart line', nodeOf(b, 'Rejoin', '')?.current?.text === 'after the restart' && nodeOf(b, 'Rejoin', '')?.progress?.done === 5, J(nodeOf(b, 'Rejoin', '')))

  // ---- a stream whose link is down for longer than AIMB_LOG_LINE_WAIT_MS reports no-bridge per line and still exits 0 at EOF
  const dn = streamLog(['--session', 'Nobody', '--project', 'AIMB', '--user', 'robin', '--ws-port', DEAD_WS], { AIMB_LOG_LINE_WAIT_MS: '600' })
  dn.send({ text: 'one' }); dn.send({ text: 'two' }); dn.end()
  await dn.closed
  check('no bridge (stream): each line reported no-bridge, exit 0 at EOF', dn.lines.length === 2 && dn.lines.every(x => x.code === 'no-bridge') && dn.code === 0, J([dn.lines, dn.code]))
} catch (e) {
  check('the test ran to its end', false, String((e && e.stack) || e))
}

console.log(`\n${pass} passed, ${fail} failed`)
for (const h of all) { try { await h.transport.close() } catch { } }
try { fake && fake.close() } catch { }
await sleep(400)
for (const d of [persist, cfgDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
process.exit(fail ? 1 : 0)
