// #70 step 3 (v1.59.0) — tools/aimb-log.mjs (the token-gated `logger` WS leaf on the gateway's ws port) and the gateway's
// POST /admin/prepare-shutdown (the Task Tray calls it before it kills the bridges).
// Host A: a GATEWAY (G, 127.0.0.1:14000, ws 14001, AI_BRIDGE_USER=alice, a 10-minute checkpoint interval so nothing is
// checkpointed unless the endpoint asks) with a temp persist dir + a temp AI_BRIDGE_CONFIG (never src/config.json). Host B:
// a gateway on 127.0.0.2:14010 (user carol) federated with A by seeds, for the mesh-wide user-mismatch rule. The script
// is pointed at the test bridge with AI_BRIDGE_TOKEN / AI_BRIDGE_CONFIG / AI_BRIDGE_WS_PORT (the test hook) and run as a
// child process. Covers: a one-shot log, progress-only with the default text, --no-log, --data-file / --data, usage
// errors → 64 (incl. --token refused without echoing it, no token), no bridge → 4, session-user-mismatch (a live sub-peer
// on this host AND on the remote host; same user accepted, case-insensitive; accepted once the sub-peer left), a
// script-only session never marked gone, --stream (many lines, one result each in order, bad lines in place, EOF exit 0,
// a reconnect after a gateway restart with a line queued while it was down), the logger never on the roster, and
// prepare-shutdown (auth: bad / missing / query-string token, GET, unknown path; the flush: a log:false burst survives a
// HARD kill only when the endpoint was called — a negative control loses it).
// AIMB_TEST_BRIDGE=<file in src/> and AIMB_TEST_LOG_SCRIPT=<path> run it against other copies (the pre-change proof).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawn as spawnChild } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lslug } from '../facets/persistence/file.js'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const SCRIPT = process.env.AIMB_TEST_LOG_SCRIPT ? path.resolve(process.env.AIMB_TEST_LOG_SCRIPT) : path.join(SRCDIR, 'tools', 'aimb-log.mjs')
const TOKEN = 'logscripttok', PORT = '14000', WS = '14001', B_PORT = '14010', DEAD_WS = '14099'
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-logscript-'))
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-logscriptcfg-'))
const cfgFile = path.join(cfgDir, 'config.json'), noTokCfg = path.join(cfgDir, 'notoken.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_entries_per_agent: 50 } }))
fs.writeFileSync(noTokCfg, JSON.stringify({}))
const hostDir = path.join(persist, 'activity', lslug(os.hostname(), 80))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
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
  let files = []; try { files = fs.readdirSync(hostDir).filter(f => f.endsWith('.jsonl')).sort() } catch { }
  for (const f of files) for (const line of fs.readFileSync(path.join(hostDir, f), 'utf8').split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)) } catch { } }
  return out
}
const board = async h => (await call(h, 'activity')).sessions || []
const sess = (b, name) => b.find(s => s.session === name)
const agentOf = (b, sname, a) => (sess(b, sname)?.agents || []).find(x => x.agent === a)
const ctxOf = (b, sname, a, c) => ((a ? agentOf(b, sname, a) : sess(b, sname)?.self)?.contexts || []).find(x => x.name === c)

// the script as a child process: env = the test hook (token, config, ws port); never the parent's AI_BRIDGE_USER/REALM/TOKEN_FILE
function scriptEnv(extra = {}) {
  const env = { ...process.env, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_WS_PORT: WS, ...extra }
  for (const k of ['AI_BRIDGE_USER', 'AI_BRIDGE_REALM', 'AI_BRIDGE_TOKEN_FILE']) if (!(k in extra)) delete env[k]
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]
  return env
}
function runLog(args, { env = {}, stdin = null, timeout = 20000 } = {}) {
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
const res1 = r => r.out[0] || {}
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
const B = await spawnBridge('ScriptHostB', '127.0.0.2', B_PORT, { AI_BRIDGE_USER: 'carol' }); all.push(B)
let G = await spawnG(); all.push(G)
await sleep(900)
const gid = await call(G, 'my_identity')
check('harness: G is a gateway on ≥ 1.59.0', gid.role === 'gateway' && (v => v[0] > 1 || (v[0] === 1 && v[1] >= 59))(String(gid.bridge_version).split('.').map(Number)), J([gid.role, gid.bridge_version]))   // v1.60.0: ≥, so a later bump doesn't break it

// ---- one-shot
const o1 = await runLog([...ID, '--agent', 'build', '@~compile compiling 3 crates'])
check('one-shot: exit 0 + ONE JSON line, the log result shape', o1.code === 0 && o1.out.length === 1 && res1(o1).ok === true && res1(o1).session === 'Scripty' && res1(o1).agent === 'build'
  && res1(o1).context === 'compile' && res1(o1).current === true && res1(o1).logged === true && typeof res1(o1).id === 'string', J([o1.code, o1.out, o1.err]))
let b = await board(G)
check('one-shot: on the board under project/user/session from the flags', ctxOf(b, 'Scripty', 'build', 'compile')?.current?.text === 'compiling 3 crates' && sess(b, 'Scripty')?.user === 'robin'
  && sess(b, 'Scripty')?.project === 'AIMB', J(sess(b, 'Scripty')))
check('one-shot: the token is never printed', !o1.raw.includes(TOKEN) && !o1.err.includes(TOKEN))

// ---- progress-only (default text) + --no-log
const o2 = await runLog([...ID, '--agent', 'build', '--ctx', '@~tiles', '--progress', '10/100:tiles', '--eta', '1h25m'])
b = await board(G)
check('progress-only: no text → the default "{progress}", rendered against the bar', o2.code === 0 && ctxOf(b, 'Scripty', 'build', 'tiles')?.current?.text === '{progress}'
  && ctxOf(b, 'Scripty', 'build', 'tiles')?.current?.rendered === '10 of 100 tiles' && !!ctxOf(b, 'Scripty', 'build', 'tiles')?.eta_at, J([o2.out, ctxOf(b, 'Scripty', 'build', 'tiles')]))
const nLogged = (await call(G, 'activity', { log: { session: 'Scripty', project: 'AIMB', agent: 'build', limit: 100 } })).log?.entries?.length
const o3 = await runLog([...ID, '--agent', 'build', '--ctx', '@tiles', '--progress', '20/100:tiles', '--no-log'])
b = await board(G)
const nLogged2 = (await call(G, 'activity', { log: { session: 'Scripty', project: 'AIMB', agent: 'build', limit: 100 } })).log?.entries?.length
check('--no-log: logged:false, the bar moves, nothing appended to the log', o3.code === 0 && res1(o3).logged === false && ctxOf(b, 'Scripty', 'build', 'tiles')?.progress?.done === 20
  && nLogged2 === nLogged && nLogged === 2, J([res1(o3), nLogged, nLogged2]))

// ---- --data-file / --data
const dataFile = path.join(cfgDir, 'data.json')
fs.writeFileSync(dataFile, '﻿' + J({ rows: 12, errors: [] }))
const o4 = await runLog([...ID, '--agent', 'build', '--details', 'FULL LOG TAIL', '--data-file', dataFile, '@build linked'])
const e4 = await call(G, 'activity', { entry: { id: res1(o4).id } })
check('--data-file: the JSON (a BOM tolerated) + --details land on the entry', o4.code === 0 && e4.ok && e4.entry?.data?.rows === 12 && e4.entry?.details === 'FULL LOG TAIL', J([o4.out, e4]))
const o5 = await runLog([...ID, '--data', '{"k":[1,2]}', '--state', 'blocked', '--stale-after', '60m', '@~root waiting on CI'])
b = await board(G)
check('--data inline + --state + --stale-after on the session itself (no --agent)', o5.code === 0 && sess(b, 'Scripty')?.self?.current?.text === 'waiting on CI' && sess(b, 'Scripty')?.self?.state === 'blocked'
  && (await call(G, 'activity', { entry: { id: res1(o5).id } })).entry?.data?.k?.[1] === 2, J([o5.out, sess(b, 'Scripty')?.self]))

// ---- usage errors → 64 (one JSON line with a code; usage on stderr)
const u = await Promise.all([
  runLog(['--project', 'AIMB', 'x']),
  runLog(['--session', 'S', 'x']),
  runLog([...ID, '--bogus', 'x']),
  runLog([...ID, '--token', 'SEKRET-IN-ARGV', 'x']),
  runLog([...ID, '--data', '{nope', 'x']),
  runLog([...ID, '--state', 'stale', 'x']),
  runLog([...ID]),
  runLog([...ID, '--data', '{}', '--data-file', dataFile, 'x']),
  runLog([...ID, '--stream', 'positional']),
  runLog([...ID, '--stream', '--progress', '1/2']),
  runLog([...ID, '--data-file', path.join(cfgDir, 'missing.json'), 'x']),
  runLog([...ID, '--agent']),
  runLog([...ID, 'x'], { env: { AI_BRIDGE_TOKEN: undefined, AI_BRIDGE_CONFIG: noTokCfg } }),
])
check('usage: every bad call exits 64', u.every(r => r.code === 64), J(u.map(r => r.code)))
check('usage: codes (usage ×2, usage, token-in-argv, bad-data, bad-state, bad-text, usage ×4, usage, no-token)',
  J(u.map(r => res1(r).code)) === J(['usage', 'usage', 'usage', 'token-in-argv', 'bad-data', 'bad-state', 'bad-text', 'usage', 'usage', 'usage', 'bad-data', 'usage', 'no-token']), J(u.map(r => res1(r).code)))
check('usage: --token is refused WITHOUT echoing its value', !u[3].raw.includes('SEKRET-IN-ARGV') && !u[3].err.includes('SEKRET-IN-ARGV') && /AI_BRIDGE_TOKEN/.test(res1(u[3]).what || ''), J(res1(u[3])))
check('usage: the usage text goes to stderr', u.every(r => /usage: aimb-log/.test(r.err)))

// ---- no bridge → 4
const nb = await runLog([...ID, '--ws-port', DEAD_WS, 'hello'])
check('no bridge: exit 4, link-error', nb.code === 4 && res1(nb).ok === false && res1(nb).code === 'link-error', J([nb.code, nb.out]))
const nb2 = await runLog([...ID, 'hello'], { env: { AI_BRIDGE_TOKEN: 'wrong-token' } })
check('bad token: exit 4, unauthorized', nb2.code === 4 && res1(nb2).code === 'unauthorized', J([nb2.code, nb2.out]))

// ---- session-user-mismatch: a live sub-peer under ANOTHER user (this host: alice; host B: carol)
const wk = await call(G, 'register_self', { name: 'Worker', secret: 'wk', project: 'AIMB' })   // user = alice (AI_BRIDGE_USER)
await call(B, 'register_self', { name: 'Remote', secret: 'rm', project: 'Marz' })                // user = carol, on host B
const mm1 = await runLog(['--session', 'Worker', '--project', 'AIMB', '--user', 'bob', 'pretending'])
check('mismatch: a live sub-peer (alice) + a script claiming bob → session-user-mismatch, exit 4', mm1.code === 4 && res1(mm1).code === 'session-user-mismatch', J([mm1.code, mm1.out]))
const mm2 = await runLog(['--session', 'worker', '--project', 'aimb', '--user', 'bob', 'pretending'])
check('mismatch: the session + project match case-insensitively', res1(mm2).code === 'session-user-mismatch', J(mm2.out))
const mm3 = await runLog(['--session', 'Worker', '--project', 'AIMB', '--user', 'ALICE', '@~root reporting for myself'])
check('mismatch: the SAME user (case-insensitive) is accepted', mm3.code === 0 && res1(mm3).ok === true, J(mm3.out))
const mm4 = await runLog(['--session', 'Worker', '--project', 'Other', '--user', 'bob', 'another project'])
check('mismatch: the same name in ANOTHER project is not that session (accepted)', mm4.code === 0 && res1(mm4).ok === true, J(mm4.out))
await until(async () => (await call(G, 'list_sessions')).sessions || [], ss => ss.some(s => (s.subpeers || []).some(sp => sp.name === 'Remote')), 8000)
const mm5 = await runLog(['--session', 'Remote', '--project', 'Marz', '--user', 'bob', 'pretending remotely'])
const mm6 = await runLog(['--session', 'Remote', '--project', 'Marz', '--user', 'carol', 'carol for herself'])
check('mismatch: a live sub-peer on ANOTHER host (gossiped roster) is protected too; its own user is accepted', res1(mm5).code === 'session-user-mismatch' && res1(mm6).ok === true, J([mm5.out, mm6.out]))
await call(G, 'deregister', { peer_id: wk.peer_id, secret: 'wk' })
await sleep(300)
const mm7 = await runLog(['--session', 'Worker', '--project', 'AIMB', '--user', 'bob', 'after it left'])
check('mismatch: once the sub-peer left the roster, anyone holding the token may report as it', mm7.code === 0 && res1(mm7).ok === true, J(mm7.out))
b = await board(G)
check('script-only: never marked gone across roster changes (deregister swept the board)', agentOf(b, 'Scripty', 'build')?.state === 'running' && !sess(b, 'Scripty')?.gone_at, J(agentOf(b, 'Scripty', 'build')))

// ---- --stream: many lines, one result each in order, bad lines in place, the logger never on the roster, EOF → 0
const before = await call(G, 'list_sessions')
const st = streamLog(['--session', 'Streamer', '--project', 'AIMB', '--user', 'robin', '--agent', 'pump', '--ctx', '@~rows', '--no-log'])
const N = 150
for (let i = 1; i <= N; i++) {
  if (i === 40) st.send('{not json')
  if (i === 80) st.send({ session: 'Hijack', progress: '1/2' })
  if (i === 100) st.send({ text: 'milestone: 100 rows', agent: 'pump', context: '@~root', log: true, ref: 'm100' })
  st.send({ progress: `${i}/${N}:rows` })
}
await st.waitLines(N + 3, 15000)
const mid = await call(G, 'list_sessions')
check('logger: never on the roster (no session, no page) while a stream is connected', J((mid.sessions || []).map(s => s.session)) === J((before.sessions || []).map(s => s.session))
  && (mid.pages || []).length === (before.pages || []).length && !J(mid).includes('Streamer'), J([mid.sessions?.length, mid.pages]))
st.end()
await st.closed
const L = st.lines
check('stream: one result per input line, in input order', L.length === N + 3 && L.every((x, i) => x.line === i + 1), J(L.map(x => x.line).slice(0, 12)))
check('stream: the bad lines are answered in place (bad-json, bad-field) and the rest go through', L[39]?.code === 'bad-json' && L[80]?.code === 'bad-field' && L.filter(x => x.ok).length === N + 1, J([L[39], L[80]]))
check('stream: a line may override the defaults (agent/context/log) and its ref is echoed', L[101]?.ref === 'm100' && L[101]?.logged === true && L[101]?.context === 'root' && L[102]?.logged === false, J([L[101], L[102]]))
check('stream: stdin EOF → exit 0', st.code === 0, String(st.code))
b = await board(G)
check('stream: the board has the last bar', ctxOf(b, 'Streamer', 'pump', 'rows')?.progress?.done === N && ctxOf(b, 'Streamer', 'pump', 'root')?.current?.text === 'milestone: 100 rows', J(agentOf(b, 'Streamer', 'pump')))

// ---- prepare-shutdown: auth
const pa = await Promise.all([prepare('wrong'), prepare(null), post(`/admin/prepare-shutdown?token=${TOKEN}`), post('/admin/prepare-shutdown', { Authorization: `Bearer ${TOKEN}` }, 'GET'), post('/admin/nope', { Authorization: `Bearer ${TOKEN}` })])
check('prepare-shutdown: bad token 401, missing 401, a token in the URL is NOT accepted (401), GET 405, unknown path 404', J(pa.map(r => r.status)) === J([401, 401, 401, 405, 404]), J(pa.map(r => [r.status, r.body && r.body.code])))

// ---- prepare-shutdown: the flush. A log:false burst (no checkpoint for 10 min) survives a HARD kill only via the endpoint.
const burst = async (session, upTo) => {
  const s = streamLog(['--session', session, '--project', 'AIMB', '--user', 'robin', '--agent', 'seed', '--ctx', '@~bar'])
  s.send({ text: 'Seeding {progress}', progress: `1/${upTo}:tiles` })                                  // logged: the file knows the session
  for (let i = 2; i <= upTo; i++) s.send({ context: '@bar', progress: `${i}/${upTo}:tiles`, log: false })   // `@` (not the default @~): bar only, the line stays
  s.end(); await s.closed
  return s.lines.filter(x => x.ok).length
}
check('flush: a burst of log:false progress (Flushy, 1 logged + 59 board-only)', await burst('Flushy', 60) === 60)
check('flush: nothing checkpointed yet (10-minute interval)', !records().some(r => r.kind === 'cp' && r.session === 'Flushy'))
const pr = await prepare()
check('prepare-shutdown: 200 {ok, flushed:{cp ≥ 1}} for the bearer token', pr.status === 200 && pr.body?.ok === true && pr.body?.flushed?.cp >= 1 && typeof pr.body?.flushed?.files_drained === 'number', J(pr))
check('prepare-shutdown: the cp is ON DISK when it answers (bar 60/60)', records().some(r => r.kind === 'cp' && r.session === 'Flushy' && r.progress?.done === 60))
await hardKill(G); all.splice(all.indexOf(G), 1)
G = await spawnG(); all.push(G)
let fb = await until(() => board(G), x => !!ctxOf(x, 'Flushy', 'seed', 'bar'), 10000)
check('flush: after a HARD kill + restart the bar survived (60, not the logged 1)', ctxOf(fb, 'Flushy', 'seed', 'bar')?.progress?.done === 60 && ctxOf(fb, 'Flushy', 'seed', 'bar')?.current?.rendered === 'Seeding 60 of 60 tiles', J(ctxOf(fb, 'Flushy', 'seed', 'bar')))
// negative control: the same burst, NO endpoint call, a hard kill → the bar falls back to the last LOGGED progress
check('control: a second burst (Lossy) without prepare-shutdown', await burst('Lossy', 60) === 60)
await hardKill(G); all.splice(all.indexOf(G), 1)
G = await spawnG(); all.push(G)
fb = await until(() => board(G), x => !!ctxOf(x, 'Lossy', 'seed', 'bar'), 10000)
check('control: without the endpoint the hard kill LOSES the log:false bar (back to the logged 1/60)', ctxOf(fb, 'Lossy', 'seed', 'bar')?.progress?.done === 1 && ctxOf(fb, 'Flushy', 'seed', 'bar')?.progress?.done === 60, J(ctxOf(fb, 'Lossy', 'seed', 'bar')))

// ---- --stream reconnect across a gateway restart (a line written while it is down is queued, then delivered)
const rs = streamLog(['--session', 'Rejoin', '--project', 'AIMB', '--user', 'robin'], { AIMB_LOG_BACKOFF_MAX_MS: '400', AIMB_LOG_LINE_WAIT_MS: '20000' })
rs.send({ text: '@~root before the restart' })
await rs.waitLines(1)
check('reconnect: the first line went through', rs.lines[0]?.ok === true, J(rs.lines))
await hardKill(G); all.splice(all.indexOf(G), 1)
await sleep(500)
rs.send({ text: '@~root written while the gateway was down', progress: '5/10' })
await sleep(800)
check('reconnect: the line waits (no answer while there is no gateway)', rs.lines.length === 1 && rs.code === null, J(rs.lines))
G = await spawnG(); all.push(G)
await rs.waitLines(2, 15000)
rs.send({ text: '@~root after the restart' })
await rs.waitLines(3, 10000)
rs.end(); await rs.closed
check('reconnect: the queued line was delivered after the restart, then the next one', rs.lines[1]?.ok === true && rs.lines[1]?.line === 2 && rs.lines[2]?.ok === true && rs.code === 0, J([rs.lines, rs.code, rs.err.slice(0, 300)]))
b = await board(G)
check('reconnect: the board has the post-restart line', sess(b, 'Rejoin')?.self?.current?.text === 'after the restart' && sess(b, 'Rejoin')?.self?.progress?.done === 5, J(sess(b, 'Rejoin')?.self))

// ---- a stream whose link is down for longer than AIMB_LOG_LINE_WAIT_MS reports no-bridge per line and still exits 0 at EOF
const dn = streamLog(['--session', 'Nobody', '--project', 'AIMB', '--user', 'robin', '--ws-port', DEAD_WS], { AIMB_LOG_LINE_WAIT_MS: '600' })
dn.send({ text: 'one' }); dn.send({ text: 'two' }); dn.end()
await dn.closed
check('no bridge (stream): each line reported no-bridge, exit 0 at EOF', dn.lines.length === 2 && dn.lines.every(x => x.code === 'no-bridge') && dn.code === 0, J([dn.lines, dn.code]))

console.log(`\n${pass} passed, ${fail} failed`)
for (const h of all) { try { await h.transport.close() } catch { } }
await sleep(400)
for (const d of [persist, cfgDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
process.exit(fail ? 1 : 0)
