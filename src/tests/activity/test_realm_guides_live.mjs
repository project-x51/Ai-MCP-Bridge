// #89 part 2 (v1.74.0) — live: GUIDES published in the realm, PULLED from a gateway. A `behaviors.realm.guides` block
// { agent?: { text, min_bridge? }, session?: { text, min_bridge? } } in ONE host's config rides the realm record mesh-wide;
// `aimb-log --guide` asks its gateway ({type:"guide"} on the logger link) and prints the realm's text (placeholders filled,
// the capability note appended) or, failing that, its own built-in text — the last line names the source. The `log` tool's
// guide:"agent"|"session" returns the text instead of logging (Cowork). Guides are never pushed (register_self carries none).
// Loopback "hosts" (temp configs via AI_BRIDGE_CONFIG — never src/config.json; a test-set token that is never printed):
//   B  127.0.0.2 "GUIDE-B"  publishes the guides (its config)
//   A  127.0.0.1 "GUIDE-A"  gateway + a FOLLOWER (same IP + port), seeds B, no guides of its own
//   C  127.0.0.3 "GUIDE-C"  a lone gateway (no seeds): an EMPTY realm record
//   fakes: a WS server that says it is a 1.73.0 gateway, one that says 1.74.0 but answers bad-op, one that never answers
//   D  127.0.0.1 "GUIDE-D" (its own port: the lower address dials, so it reaches B)  ONLY with AIMB_TEST_OLD_BRIDGE=<an older bridge.mjs> (a `git archive` of 1.73): a real old gateway
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawn as spawnProc } from 'node:child_process'
import { WebSocket, WebSocketServer } from 'ws'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 17000)   // #81: this file's port block (17000 = its first port name)
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const LOGGER = path.join(SRCDIR, 'tools', 'aimb-log.mjs')
const VER = JSON.parse(fs.readFileSync(path.join(SRCDIR, 'package.json'), 'utf8')).version
const TOKEN = 'guide89-' + crypto.randomBytes(9).toString('hex')
const OLD = process.env.AIMB_TEST_OLD_BRIDGE || ''
const A_PORT = String(tp(17000)), B_PORT = String(tp(17002)), C_PORT = String(tp(17004)), D_PORT = String(tp(17006))
const OLD_WS = tp(17010), BADOP_WS = tp(17011), MUTE_WS = tp(17012), DEAD_WS = tp(17013)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-89g-'))
const cfgA = path.join(tmp, 'configA.json'), cfgF = path.join(tmp, 'configAF.json'), cfgB = path.join(tmp, 'configB.json'), cfgC = path.join(tmp, 'configC.json')
const writeCfg = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const seen = []   // every raw response / frame / script output: none may carry the token
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).split(TOKEN).join('<TOKEN>'))) }
const J = JSON.stringify
const fwd = p => p.replace(/\\/g, '/')

const all = []
const spawn = (name, bind, port, host, cfg, extra = {}) => spawnWith(SRCDIR + BRIDGE, name, bind, port, host, cfg, extra)
function spawnWith(script, name, bind, port, host, cfg, extra = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [script], cwd: path.dirname(script),
    env: { ...process.env, AI_BRIDGE_CONFIG: cfg, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
      AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_DEFAULT_BEHAVIOR: '', AI_BRIDGE_GOSSIP_REFRESH_MS: '60000',   // a long refresh: propagation must be change-driven
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: '', AI_BRIDGE_DISCOVERY_MS: '300', AI_BRIDGE_TEST_GOSSIP: '', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => { const h = { c, transport, name }; all.push(h); return h })
}
const call = async (b, n, a = {}) => { try { const t = (await b.c.callTool({ name: n, arguments: a })).content[0].text; seen.push(t); return JSON.parse(t) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 10000, step = 250) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
/** aimb-log --guide as a child process → Promise<{ code, stdout, stderr, last (the last line) }> */
function runGuide(args, url, env = {}) {
  return new Promise(resolve => {
    const p = spawnProc(process.execPath, [LOGGER, '--url', url, ...args], { env: { ...process.env, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_CONFIG: path.join(tmp, 'none.json'), AI_BRIDGE_USER: 'robin', ...env } })
    let so = '', se = ''
    p.stdout.on('data', d => { so += d }); p.stderr.on('data', d => { se += d })
    p.on('exit', code => { seen.push(so, se); const lines = so.trimEnd().split('\n'); resolve({ code, stdout: so, stderr: se, last: lines[lines.length - 1] || '', first: lines[0] || '' }) })
  })
}
const urlA = `ws://127.0.0.1:${Number(A_PORT) + 1}`, urlB = `ws://127.0.0.2:${Number(B_PORT) + 1}`, urlC = `ws://127.0.0.3:${Number(C_PORT) + 1}`
/** a raw logger link: hello → welcome, then guide requests */
function logger(url) {
  return new Promise(resolve => {
    const ws = new WebSocket(url), L = { ws, msgs: [], welcome: null, n: 0 }
    L.guide = async (o, ms = 5000) => { const ref = `g${++L.n}`; ws.send(J({ type: 'guide', ref, ...o })); const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = L.msgs.find(x => x.ref === ref); if (m) return m; await sleep(20) } return { type: 'none' } }
    L.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => ws.send(J({ type: 'hello', kind: 'logger', token: TOKEN, ident: { session: 'Raw', project: 'G89', user: 'robin' } })))
    ws.on('message', raw => { const s = String(raw); seen.push(s); const m = JSON.parse(s); L.msgs.push(m); if (m.type === 'welcome' || m.type === 'error') { L.welcome = m; resolve(L) } })
    ws.on('error', () => resolve(L))
  })
}
const T_AGENT = 'REALM-AGENT v1 cmd=[{cmd}] path=[{path}] gw=[{gateway}] script=[{script}] keep={json}'
const GUIDES_V1 = { agent: { text: T_AGENT }, session: { text: ['REALM-SESSION v1', 'brief: {cmd} --path "@Item/<agent>" --guide agent'], min_bridge: '1.74' } }
const REALM_V1 = { updated_at: '2026-10-03T10:00:00Z', default: [], guides: GUIDES_V1 }

// ================================================================= the hosts
writeCfg(cfgB, { behaviors: { realm: REALM_V1 } })
writeCfg(cfgA, {}); writeCfg(cfgF, {}); writeCfg(cfgC, {})
const B = await spawn('HostB', '127.0.0.2', B_PORT, 'GUIDE-B', cfgB)
const A = await spawn('HostA', '127.0.0.1', A_PORT, 'GUIDE-A', cfgA, { AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT })
await sleep(700)
const F = await spawn('HostAF', '127.0.0.1', A_PORT, 'GUIDE-A', cfgF, { AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT })
const C = await spawn('HostC', '127.0.0.3', C_PORT, 'GUIDE-C', cfgC, { AI_BRIDGE_DISCOVERY: 'none' })
await sleep(900)
const roles = [(await call(A, 'my_identity')).role, (await call(F, 'my_identity')).role, (await call(B, 'my_identity')).role, (await call(C, 'my_identity')).role]
check('harness: A = gateway + follower, B and C = gateways, all on this version', J(roles) === J(['gateway', 'follower', 'gateway', 'gateway']) && (await call(A, 'my_identity')).bridge_version === VER, J(roles))

// ================================================================= 1. published on B → served by A's gateway (aimb-log --guide)
const agentArgs = ['--session', 'Worker', '--project', 'G89', '--path', '@Next/@Item/helper', '--guide', 'agent']
const g1 = await until(() => runGuide(agentArgs, urlA), r => r.first.startsWith('REALM-AGENT v1'))
console.log('  A --guide agent =\n' + g1.stdout.replace(/^/gm, '    | '))
const wantCmd = `"${fwd(process.execPath)}" "${fwd(LOGGER)}" --session "Worker" --project "G89"`
check('1: a guide published in B\'s config is served by host A\'s gateway after replication (aimb-log --guide agent: exit 0, the realm text)', g1.code === 0 && g1.first.startsWith('REALM-AGENT v1'), J([g1.code, g1.stdout.slice(0, 300), g1.stderr.slice(0, 200)]))
check('1: placeholders filled — {cmd} = the script\'s own ready command, {path} = its --path, {gateway} / {script} = the versions; {json} left as written',
  g1.first === `REALM-AGENT v1 cmd=[${wantCmd}] path=[@Next/@Item/helper] gw=[${VER}] script=[${VER}] keep={json}`, g1.first)
check('1: the last line names the source in ONE short line (the realm, its updated_at, the origin host)', g1.last === '(Guide source: the realm\'s published agent guide, updated_at 2026-10-03T10:00:00.000Z from GUIDE-B.)' && g1.stdout.trimEnd().split('\n').length === 2, g1.last)
const g1b = await runGuide(agentArgs, urlB)
check('1: ... and B (the publisher) serves the same text', g1b.code === 0 && g1b.first === g1.first, g1b.first)

// 2. the raw request on A's gateway: the frame, min_bridge against the requester's version, a bad kind
const LA = await logger(urlA)
check('2: harness: a logger link on A (welcome from a 1.74 gateway)', LA.welcome?.type === 'welcome' && LA.welcome.logger === true && LA.welcome.bridge_version === VER, J(LA.welcome))
const w1 = await LA.guide({ kind: 'agent', cmd: 'CMD', path: 'P/q', script: '1.73.0' })
check('2: {type:"guide"} → {type:"guide", ref, ok, kind, text (rendered), source "realm", updated_at, origin, gateway}',
  w1.type === 'guide' && w1.ok === true && w1.kind === 'agent' && w1.text === `REALM-AGENT v1 cmd=[CMD] path=[P/q] gw=[${VER}] script=[1.73.0] keep={json}` && w1.source === 'realm' && w1.updated_at === Date.parse('2026-10-03T10:00:00Z') && w1.origin === 'GUIDE-B' && w1.gateway === VER, J(w1))
const w2 = await LA.guide({ kind: 'session', cmd: 'CMD', script: '1.73.0' })
check('2: min_bridge 1.74 vs a 1.73.0 requester → text null, source builtin, reason min_bridge (the script prints its own)', w2.ok === true && w2.text === null && w2.source === 'builtin' && w2.reason === 'min_bridge' && w2.min_bridge === '1.74.0', J(w2))
const w3 = await LA.guide({ kind: 'session', cmd: 'CMD', script: VER })
check('2: ... a requester on 1.74.0 gets it (an array of lines joined with newlines)', w3.ok === true && w3.source === 'realm' && w3.text === 'REALM-SESSION v1\nbrief: CMD --path "@Item/<agent>" --guide agent', J(w3))
const w4 = await LA.guide({ kind: 'session', cmd: 'CMD' })
check('2: ... a requester that names no version never meets a min_bridge', w4.ok === true && w4.text === null && w4.reason === 'min_bridge', J(w4))
const w5 = await LA.guide({ kind: 'robot' })
check('2: a bad kind → ok:false bad-guide', w5.type === 'guide' && w5.ok === false && w5.code === 'bad-guide', J(w5))
LA.close()
const s1 = await runGuide(['--session', 'Lead', '--project', 'G89', '--guide', 'session'], urlA)
check('2: aimb-log --guide session (1.74 script) → the realm\'s session guide, source line', s1.code === 0 && s1.first === 'REALM-SESSION v1' && s1.stdout.includes(`brief: "${fwd(process.execPath)}" "${fwd(LOGGER)}" --session "Lead" --project "G89" --path "@Item/<agent>" --guide agent`) && /^\(Guide source: the realm's published session guide/.test(s1.last), s1.stdout)

// 3. the log tool's guide (Cowork): on A's GATEWAY and on A's FOLLOWER (its record came in the ROSTER)
const cowA = await call(A, 'register_self', { name: 'CowA', secret: 'ca', project: 'G89', client: 'cowork' })
const cowF = await call(F, 'register_self', { name: 'CowF', secret: 'cf', project: 'G89', client: 'cowork' })
check('3: guides are never PUSHED — register_self (connect reminders, default behaviours) carries no guide text', !J(cowA).includes('REALM-AGENT') && !J(cowA).includes('REALM-SESSION') && !J(cowF).includes('REALM-AGENT'), J(cowA).slice(0, 300))
const t1 = await call(A, 'log', { as: 'CowA', secret: 'ca', guide: 'agent', path: '@Plan/@X/research' })
check('3: log {guide:"agent"} on A\'s gateway → the realm text with {cmd} = the session\'s aimb-log command on this host, {path} = path, {script} = this bridge',
  t1.ok === true && t1.kind === 'agent' && t1.source === 'realm' && t1.text.startsWith('REALM-AGENT v1 cmd=["') && t1.text.includes(`"${fwd(path.join(SRCDIR, 'tools', 'aimb-log.mjs'))}" --session "CowA" --project "G89"]`)
  && t1.text.includes('path=[@Plan/@X/research]') && t1.text.includes(`script=[${VER}]`) && t1.updated_at === Date.parse('2026-10-03T10:00:00Z'), J(t1))
const t2 = await until(() => call(F, 'log', { as: 'CowF', secret: 'cf', guide: 'session' }), r => r.source === 'realm')
check('3: log {guide:"session"} on A\'s FOLLOWER → the realm text (the follower holds the record from its gateway\'s ROSTER)', t2.ok === true && t2.source === 'realm' && t2.text.startsWith('REALM-SESSION v1') && t2.text.includes('--session "CowF"'), J(t2))
const brd = await call(A, 'activity', {})
check('3: a guide request logs NOTHING (no CowA / CowF on the board)', !J(brd.sessions || []).includes('CowA') && !J(brd.sessions || []).includes('CowF'), J((brd.sessions || []).map(s => s.session)))
const t3 = await call(A, 'log', { as: 'CowA', secret: 'ca', guide: 'agent', text: 'hello' })
check('3: guide with report fields → bad-guide (it returns text instead of logging)', t3.ok === false && t3.code === 'bad-guide' && /text/.test(t3.what || ''), J(t3))
const t4 = await call(A, 'log', { as: 'CowA', secret: 'ca', guide: 'robot' })
check('3: a bad kind → bad-guide', t4.ok === false && t4.code === 'bad-guide', J(t4))
const t5 = await call(A, 'log', { as: 'CowA', secret: 'WRONG', guide: 'agent' })
check('3: the guide still needs the session\'s as + secret', t5.ok === false && !J(t5).includes('REALM-AGENT'), J(t5))

// 4. B publishes a NEWER record: session needs 9.0 (→ built-in everywhere), agent text replaced
writeCfg(cfgB, { behaviors: { realm: { updated_at: '2026-10-03T11:00:00Z', default: [], guides: { agent: 'REALM-AGENT v2 {path}', session: { text: 'REALM-SESSION v2', min_bridge: '9.0' } } } } })
const g4 = await until(() => runGuide(agentArgs, urlA), r => r.first.startsWith('REALM-AGENT v2'))
check('4: a newer record on B replaces the guide on A (same replication as the reminders)', g4.code === 0 && g4.first === 'REALM-AGENT v2 @Next/@Item/helper', g4.stdout)
const s4 = await until(() => runGuide(['--session', 'Lead', '--project', 'G89', '--guide', 'session'], urlA), r => !r.first.startsWith('REALM-SESSION'))
check('4: min_bridge 9.0 → aimb-log falls back to its OWN built-in session guide; the source line says why', s4.code === 0 && /^ACTIVITY BOARD — how a session reports/.test(s4.first) && s4.last === `(Guide source: built into aimb-log ${VER}; the realm's session guide needs 9.0.0+.)`, s4.stdout.slice(-400))
const t6 = await until(() => call(A, 'log', { as: 'CowA', secret: 'ca', guide: 'session' }), r => r.source === 'builtin')
check('4: ... the log tool returns the bridge\'s built-in text (always text), source builtin, reason min_bridge', t6.ok === true && t6.source === 'builtin' && t6.reason === 'min_bridge' && /^ACTIVITY BOARD — how a session reports/.test(t6.text) && t6.text.includes('--session "CowA"') && t6.updated_at === null, J(t6).slice(0, 400))

// 5. a newer record WITHOUT guides clears them (the built-in text again, "the realm publishes no … guide")
writeCfg(cfgB, { behaviors: { realm: { updated_at: '2026-10-03T12:00:00Z', default: [] } } })
const g5 = await until(() => runGuide(agentArgs, urlA), r => !r.first.startsWith('REALM-AGENT'))
check('5: a newer record without guides clears them on A → the built-in agent guide, source line "the realm publishes no agent guide"', g5.code === 0 && /^ACTIVITY BOARD — how to report your work \(aimb-log /.test(g5.first) && g5.stdout.includes('--path "@Next/@Item/helper" --text "<text>"') && g5.last === `(Guide source: built into aimb-log ${VER}; the realm publishes no agent guide.)`, g5.stdout.slice(-300))

// 6. an EMPTY gateway (C: no record at all)
const g6 = await runGuide(agentArgs, urlC)
check('6: a gateway with no realm record → the built-in guide (exit 0), "the realm publishes no agent guide"', g6.code === 0 && /^ACTIVITY BOARD — how to report your work/.test(g6.first) && /the realm publishes no agent guide/.test(g6.last), g6.stdout.slice(-300))
const LC = await logger(urlC), w6 = await LC.guide({ kind: 'agent', cmd: 'c', script: VER }); LC.close()
check('6: ... its frame: text null, source builtin, reason none, updated_at null', w6.ok === true && w6.text === null && w6.source === 'builtin' && w6.reason === 'none' && w6.updated_at === null, J(w6))
// an invalid guide in C's own config is dropped at load (the reminders of that block still apply), nothing served
writeCfg(cfgC, { behaviors: { realm: { updated_at: '2026-10-03T13:00:00Z', default: [{ operation: 'connect', scope: 'client', match: 'code', behavior: 'C-REMINDER' }], guides: { agent: { text: 'x'.repeat(5000) } } } } })
const rc = await until(() => call(C, 'register_self', { name: 'CodeC', secret: 'cc', project: 'G89', client: 'claude-code' }), r => (r.connect_reminders || []).some(x => x.behavior === 'C-REMINDER'))
const LC2 = await logger(urlC), w7 = await LC2.guide({ kind: 'agent', cmd: 'c', script: VER }); LC2.close()
check('6: a guide over 4 KB in a config is dropped at load (never cut) — the block\'s reminders still apply, the built-in guide is served', (rc.connect_reminders || []).some(x => x.behavior === 'C-REMINDER') && w7.text === null && w7.reason === 'none', J([w7, (rc.connect_reminders || []).length]))

// ================================================================= 7. fallbacks: an older gateway, one that answers bad-op, one that is mute, none
function fakeGateway(port, onMsg) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port })
  wss.on('connection', ws => ws.on('message', raw => { const m = JSON.parse(String(raw)); fakes.log.push([port, m.type]); onMsg(ws, m) }))
  return wss
}
const fakes = { log: [] }
const welcome = v => ({ type: 'welcome', logger: true, instance: 'x', gateway: 'FAKE/1', bridge_version: v, realm: 'default', host: 'FAKE', ident: { project: 'G89', user: 'robin', session: 'Worker' } })
const oldGw = fakeGateway(OLD_WS, (ws, m) => { if (m.type === 'hello') ws.send(J(welcome('1.73.0'))); else ws.send(J({ type: 'logged', ref: m.ref, result: { ok: false, code: 'bad-op' } })) })
const badOp = fakeGateway(BADOP_WS, (ws, m) => { if (m.type === 'hello') ws.send(J(welcome('1.74.0'))); else ws.send(J({ type: 'logged', ref: m.ref != null ? m.ref : null, result: { ok: false, code: 'bad-op', what: 'a logger sends only …' } })) })
const mute = fakeGateway(MUTE_WS, (ws, m) => { if (m.type === 'hello') ws.send(J(welcome('1.74.0'))) })
await sleep(200)
const o1 = await runGuide(agentArgs, `ws://127.0.0.1:${OLD_WS}`)
check('7: a 1.73 gateway → the built-in guide naming that gateway, "gateway 1.73.0 serves no realm guides" — and no guide request was sent to it',
  o1.code === 0 && /^ACTIVITY BOARD — how to report your work \(aimb-log [^,]+, gateway 1\.73\.0\)/.test(o1.first) && o1.last === `(Guide source: built into aimb-log ${VER}; gateway 1.73.0 serves no realm guides (1.74+).)` && !fakes.log.some(([p, t]) => p === OLD_WS && t === 'guide'), J([o1.stdout.slice(-300), fakes.log]))
const o2 = await runGuide(agentArgs, `ws://127.0.0.1:${BADOP_WS}`)
check('7: a gateway that answers the guide request with bad-op → the built-in guide (exit 0)', o2.code === 0 && /^ACTIVITY BOARD — how to report your work/.test(o2.first) && /built into aimb-log .*serves no realm guides/.test(o2.last) && fakes.log.some(([p, t]) => p === BADOP_WS && t === 'guide'), o2.stdout.slice(-300))
const t0 = Date.now(), o3 = await runGuide(agentArgs, `ws://127.0.0.1:${MUTE_WS}`, { AIMB_LOG_GUIDE_MS: '800' }), ms3 = Date.now() - t0
check('7: a gateway that never answers → the built-in guide after AIMB_LOG_GUIDE_MS (exit 0, prompt)', o3.code === 0 && /^ACTIVITY BOARD — how to report your work/.test(o3.first) && /Guide source: built into aimb-log/.test(o3.last) && ms3 < 5000, J([ms3, o3.last]))
const o4 = await runGuide(agentArgs, `ws://127.0.0.1:${DEAD_WS}`)
check('7: no gateway at all → the built-in guide, "could not be reached" note + source line', o4.code === 0 && /could not be reached just now/.test(o4.stdout) && /the gateway could not be asked/.test(o4.last), o4.stdout.slice(-300))
for (const w of [oldGw, badOp, mute]) { try { w.close() } catch { } }

// ================================================================= OPTIONAL: a real older bridge (AIMB_TEST_OLD_BRIDGE=<a ≤1.73 bridge.mjs>)
if (OLD) {
  const cfgD = path.join(tmp, 'configD.json'); writeCfg(cfgD, {})
  // B publishes guides + a reminder again; the old host D links to B (and so re-gossips a guide-less copy of the record)
  writeCfg(cfgB, { behaviors: { realm: { updated_at: '2026-10-03T14:00:00Z', default: [{ operation: 'connect', scope: 'client', match: 'code', behavior: 'B-REMINDER-V4' }], guides: { agent: 'REALM-AGENT v4' } } } })
  const D = await spawnWith(OLD, 'HostD', '127.0.0.1', D_PORT, 'GUIDE-D', cfgD, { AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT })
  const dv = (await call(D, 'my_identity')).bridge_version
  const rd = await until(() => call(D, 'register_self', { name: 'CodeD', secret: 'cd', project: 'G89', client: 'claude-code' }), r => (r.connect_reminders || []).some(x => x.behavior === 'B-REMINDER-V4'), 15000)
  check(`OLD: a real ${dv} host takes the record WITH guides (wire-compatible): its sessions get the record's reminder`, (rd.connect_reminders || []).some(x => x.behavior === 'B-REMINDER-V4'), J(rd.connect_reminders))
  await sleep(1500)   // D's guide-less copy (same updated_at) has had time to travel
  const gA = await until(() => runGuide(agentArgs, urlA), r => r.first === 'REALM-AGENT v4')
  check(`OLD: ... and the 1.74 hosts keep the guided copy (a guide-less copy relayed by the ${dv} host never wins the tie)`, gA.first === 'REALM-AGENT v4' && (await runGuide(agentArgs, urlB)).first === 'REALM-AGENT v4', gA.stdout.slice(0, 200))
  const od = await runGuide(agentArgs, `ws://127.0.0.1:${Number(D_PORT) + 1}`)
  check(`OLD: a real ${dv} gateway → this script prints its built-in guide (exit 0) and says the gateway serves no realm guides`, od.code === 0 && /^ACTIVITY BOARD — how to report your work/.test(od.first) && od.last.includes(`gateway ${dv} serves no realm guides`), od.stdout.slice(-300))
  const LD = await logger(`ws://127.0.0.1:${Number(D_PORT) + 1}`), wd = await LD.guide({ kind: 'agent', script: VER }); LD.close()
  check(`OLD: the ${dv} gateway answers a raw guide request with bad-op (what the script's fallback relies on)`, wd.type === 'logged' && wd.result?.code === 'bad-op', J(wd))
} else console.log('SKIP the check with a real older bridge (set AIMB_TEST_OLD_BRIDGE=<an older bridge.mjs>)')

check('no token in any response, frame or script output', !seen.some(s => String(s).includes(TOKEN)))
console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(300)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
