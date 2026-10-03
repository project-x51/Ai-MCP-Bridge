// #89 part 2 (v1.74.0) — live: GUIDES published in the realm, PULLED from a gateway; PORTED to 2.0 in #88 build step 9
// (docs/spec-88.md §4.3, §4.4; Q34: a 2.0 gateway serves realm guides by 1.74's rules — an author's optional min_bridge
// works as before, no 2.0-specific gating or fallback was added). A `behaviors.realm.guides` block
// { agent?: { text, min_bridge? }, session?: { text, min_bridge? } } in ONE host's config rides the realm record mesh-wide;
// `aimb-log --guide` asks its gateway ({type:"guide"} on the logger link) and prints the realm's text (placeholders {cmd}
// {path} {agent} {gateway} {script} filled, the gateway note appended) or, failing that, its own built-in 2.0 text — the
// source line names the source. The `log` tool's guide:"agent"|"session" returns the text instead of logging (Cowork).
// Guides are never pushed (register_self carries none). 2.0 (§4.4): `--guide agent` WITH --agent (+ --label, --under) — and
// the tool's guide:"agent" + agent, and the raw frame's agent — is the agent's FIRST REPORT: the agent is created when
// missing (the response carries `board`), nothing is written when it is there; a refused create still serves the guide.
// The 2.0 script's welcome check: a gateway whose welcome lacks `activity_format: 6` is not 2.0 — the script prints its
// built-in guide with a "not 2.0" note (reason old-gateway) and sends no guide request.
// Loopback "hosts" (temp configs via AI_BRIDGE_CONFIG — never src/config.json; a test-set token that is never printed):
//   B  127.0.0.2 "GUIDE-B"  publishes the guides (its config)
//   A  127.0.0.1 "GUIDE-A"  gateway + a FOLLOWER (same IP + port), seeds B, no guides of its own
//   C  127.0.0.3 "GUIDE-C"  a lone gateway (no seeds): an EMPTY realm record
//   fakes: a WS server that says it is a 1.75.1 gateway (no activity_format: 1.7x), a 2.0 one that answers bad-op, a 2.0 one
//   that never answers
// RETIRED in step 9: the optional AIMB_TEST_OLD_BRIDGE checks against a real ≤ 1.73 bridge (mixed-version: 2.0 never meets
// 1.7x — every host is upgraded together, §7.1; the 1.7x gateway's side is covered by the fake above).
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
const A_PORT = String(tp(17000)), B_PORT = String(tp(17002)), C_PORT = String(tp(17004))
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
/** aimb-log --guide as a child process → Promise<{ code, stdout, stderr, lines, first, last }> */
function runGuide(args, url, env = {}) {
  return new Promise(resolve => {
    const p = spawnProc(process.execPath, [LOGGER, '--url', url, ...args], { env: { ...process.env, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_CONFIG: path.join(tmp, 'none.json'), AI_BRIDGE_USER: 'robin', ...env } })
    let so = '', se = ''
    p.stdout.on('data', d => { so += d }); p.stderr.on('data', d => { se += d })
    p.on('exit', code => { seen.push(so, se); const lines = so.trimEnd().split('\n'); resolve({ code, stdout: so, stderr: se, lines, last: lines[lines.length - 1] || '', first: lines[0] || '' }) })
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
const sessOf = (b, s) => (b || []).find(g => g && g.session === s)
const nodeAt = (b, s, p) => ((sessOf(b, s) || {}).nodes || []).find(n => n.path === p)
const T_AGENT = 'REALM-AGENT v1 cmd=[{cmd}] path=[{path}] agent=[{agent}] gw=[{gateway}] script=[{script}] keep={json}'
const GUIDES_V1 = { agent: { text: T_AGENT }, session: { text: ['REALM-SESSION v1', 'brief: {cmd} --agent <key> --label "<name>" --under item --guide agent'], min_bridge: '1.74' } }
const REALM_V1 = { updated_at: '2026-10-03T10:00:00Z', default: [], guides: GUIDES_V1 }
const SRC1 = '(Guide source: the realm\'s published agent guide, updated_at 2026-10-03T10:00:00.000Z from GUIDE-B.)'

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
const agentArgs = ['--session', 'Worker', '--project', 'G89', '--path', 'Next/Item/helper', '--guide', 'agent']
const g1 = await until(() => runGuide(agentArgs, urlA), r => r.first.startsWith('REALM-AGENT v1'))
console.log('  A --guide agent =\n' + g1.stdout.replace(/^/gm, '    | '))
const wantCmd = `"${fwd(process.execPath)}" "${fwd(LOGGER)}" --session "Worker" --project "G89"`
check('1: a guide published in B\'s config is served by host A\'s gateway after replication (aimb-log --guide agent: exit 0, the realm text)', g1.code === 0 && g1.first.startsWith('REALM-AGENT v1'), J([g1.code, g1.stdout.slice(0, 300), g1.stderr.slice(0, 200)]))
check('1: placeholders filled — {cmd} = the script\'s own ready command, {path} = its --path, {agent} = "<your-key>" (no --agent), {gateway} / {script} = the versions; {json} left as written',
  g1.first === `REALM-AGENT v1 cmd=[${wantCmd}] path=[Next/Item/helper] agent=[<your-key>] gw=[${VER}] script=[${VER}] keep={json}`, g1.first)
check('1: the last line names the source in ONE short line (the realm, its updated_at, the origin host); without --agent nothing else is printed', g1.last === SRC1 && g1.lines.length === 2, g1.stdout)
const g1b = await runGuide(agentArgs, urlB)
check('1: ... and B (the publisher) serves the same text', g1b.code === 0 && g1b.first === g1.first, g1b.first)
// 2.0 (§4.4): --guide agent WITH --agent / --label is the agent's first report — with the realm's text too
const helperArgs = ['--session', 'Worker', '--project', 'G89', '--agent', 'helper', '--label', 'Helper', '--guide', 'agent']
const g1c = await runGuide(helperArgs, urlA)
const bW = await until(async () => (await call(A, 'activity', { session: 'Worker' })).sessions || [], b => !!nodeAt(b, 'Worker', 'Helper'), 5000)
const helperN = nodeAt(bW, 'Worker', 'Helper')
check('1 (2.0): --guide agent --agent helper --label Helper → the realm text with {agent} = "helper", the source line, then the first report: the agent is ON THE BOARD (kind agent, running, "reading the guide") and the last line names its label, path, key and id',
  g1c.code === 0 && g1c.first === `REALM-AGENT v1 cmd=[${wantCmd}] path=[<your-path>] agent=[helper] gw=[${VER}] script=[${VER}] keep={json}` && g1c.lines[1] === SRC1
  && helperN?.kind === 'agent' && helperN?.state === 'running' && helperN?.current?.text === 'reading the guide' && g1c.last === `(You are on the board now as "Helper" — Helper; key helper, id ${helperN?.id}.)`, J([g1c.code, g1c.stdout, helperN]))

// 2. the raw request on A's gateway: the frame, the agent's first report, min_bridge against the requester's version, a bad kind
const LA = await logger(urlA)
check('2: harness: a logger link on A (welcome from a 2.0 gateway: activity_format 6)', LA.welcome?.type === 'welcome' && LA.welcome.logger === true && LA.welcome.bridge_version === VER && LA.welcome.activity_format === 6, J(LA.welcome))
const w1 = await LA.guide({ kind: 'agent', cmd: 'CMD', path: 'P/q', script: '1.73.0' })
check('2: {type:"guide"} → {type:"guide", ref, ok, kind, text (rendered), source "realm", updated_at, origin, gateway} — no agent, no `board`',
  w1.type === 'guide' && w1.ok === true && w1.kind === 'agent' && w1.text === `REALM-AGENT v1 cmd=[CMD] path=[P/q] agent=[<your-key>] gw=[${VER}] script=[1.73.0] keep={json}` && w1.source === 'realm' && w1.updated_at === Date.parse('2026-10-03T10:00:00Z') && w1.origin === 'GUIDE-B' && w1.gateway === VER && !('board' in w1), J(w1))
const w1a = await LA.guide({ kind: 'agent', cmd: 'CMD', agent: 'raw-agent', label: 'Raw agent', script: VER })
const w1b = await LA.guide({ kind: 'agent', cmd: 'CMD', agent: 'raw-agent', label: 'Raw agent', script: VER })
check('2 (2.0, §4.4): the frame with agent + label → {agent} filled, and `board` = the first report (created:true, node key / label / id); the same frame again → board.created:false, the same node — nothing written',
  w1a.ok === true && w1a.text.includes('agent=[raw-agent]') && w1a.board?.ok === true && w1a.board?.node?.created === true && w1a.board?.node?.key === 'raw-agent' && w1a.board?.node?.label === 'Raw agent' && /^[a-z2-7]{16}$/.test(w1a.board?.node?.id || '')
  && w1b.ok === true && w1b.board?.ok === true && w1b.board?.created === false && w1b.board?.node?.id === w1a.board?.node?.id, J([w1a.board, w1b.board]))
const w1c = await LA.guide({ kind: 'agent', cmd: 'CMD', agent: 'nolabel', script: VER })
check('2 (2.0, §4.4): a refused create (no label → label-required) still serves the guide; `board` is the refusal', w1c.ok === true && w1c.source === 'realm' && w1c.text.includes('agent=[nolabel]') && w1c.board?.ok === false && w1c.board?.code === 'label-required', J(w1c))
const w2 = await LA.guide({ kind: 'session', cmd: 'CMD', script: '1.73.0' })
check('2: min_bridge 1.74 vs a 1.73.0 requester → text null, source builtin, reason min_bridge (the script prints its own) — 1.74\'s rule, kept in 2.0 (Q34)', w2.ok === true && w2.text === null && w2.source === 'builtin' && w2.reason === 'min_bridge' && w2.min_bridge === '1.74.0', J(w2))
const w3 = await LA.guide({ kind: 'session', cmd: 'CMD', script: VER, agent: 'not-for-session', label: 'X' })
check('2: ... a requester on this version gets it (an array of lines joined with newlines); a session guide never registers an agent (no `board`)', w3.ok === true && w3.source === 'realm' && w3.text === 'REALM-SESSION v1\nbrief: CMD --agent <key> --label "<name>" --under item --guide agent' && !('board' in w3), J(w3))
const w4 = await LA.guide({ kind: 'session', cmd: 'CMD' })
check('2: ... a requester that names no version never meets a min_bridge', w4.ok === true && w4.text === null && w4.reason === 'min_bridge', J(w4))
const w5 = await LA.guide({ kind: 'robot' })
check('2: a bad kind → ok:false bad-guide', w5.type === 'guide' && w5.ok === false && w5.code === 'bad-guide', J(w5))
LA.close()
const bRaw = (await call(A, 'activity', { session: 'Raw' })).sessions || []
check('2: the raw frames put exactly ONE agent on the board (raw-agent; the refused "nolabel" and the session guide none)', !!nodeAt(bRaw, 'Raw', 'Raw agent') && !(sessOf(bRaw, 'Raw')?.nodes || []).some(n => n.key === 'nolabel' || n.key === 'not-for-session'), J((sessOf(bRaw, 'Raw')?.nodes || []).map(n => [n.path, n.key])))
const s1 = await runGuide(['--session', 'Lead', '--project', 'G89', '--guide', 'session'], urlA)
check('2: aimb-log --guide session → the realm\'s session guide ({cmd} = the script\'s command), source line', s1.code === 0 && s1.first === 'REALM-SESSION v1' && s1.stdout.includes(`brief: "${fwd(process.execPath)}" "${fwd(LOGGER)}" --session "Lead" --project "G89" --agent <key> --label "<name>" --under item --guide agent`) && /^\(Guide source: the realm's published session guide/.test(s1.last), s1.stdout)

// 3. the log tool's guide (Cowork): on A's GATEWAY and on A's FOLLOWER (its record came in the ROSTER)
const cowA = await call(A, 'register_self', { name: 'CowA', secret: 'ca', project: 'G89', client: 'cowork' })
const cowF = await call(F, 'register_self', { name: 'CowF', secret: 'cf', project: 'G89', client: 'cowork' })
check('3: guides are never PUSHED — register_self (connect reminders, default behaviours) carries no guide text', !J(cowA).includes('REALM-AGENT') && !J(cowA).includes('REALM-SESSION') && !J(cowF).includes('REALM-AGENT'), J(cowA).slice(0, 300))
const t1 = await call(A, 'log', { as: 'CowA', secret: 'ca', guide: 'agent', path: 'Plan/X/research' })
check('3: log {guide:"agent"} on A\'s gateway → the realm text with {cmd} = the session\'s aimb-log command on this host, {path} = path, {agent} = "<your-key>", {script} = this bridge; no `board` without agent',
  t1.ok === true && t1.kind === 'agent' && t1.source === 'realm' && t1.text.startsWith('REALM-AGENT v1 cmd=["') && t1.text.includes(`"${fwd(path.join(SRCDIR, 'tools', 'aimb-log.mjs'))}" --session "CowA" --project "G89"]`)
  && t1.text.includes('path=[Plan/X/research]') && t1.text.includes('agent=[<your-key>]') && t1.text.includes(`script=[${VER}]`) && t1.updated_at === Date.parse('2026-10-03T10:00:00Z') && !('board' in t1), J(t1))
const t2 = await until(() => call(F, 'log', { as: 'CowF', secret: 'cf', guide: 'session' }), r => r.source === 'realm')
check('3: log {guide:"session"} on A\'s FOLLOWER → the realm text (the follower holds the record from its gateway\'s ROSTER)', t2.ok === true && t2.source === 'realm' && t2.text.startsWith('REALM-SESSION v1') && t2.text.includes('--session "CowF"'), J(t2))
const brd = await call(A, 'activity', {})
check('3: a guide request without agent logs NOTHING (no CowA / CowF on the board)', !J(brd.sessions || []).includes('CowA') && !J(brd.sessions || []).includes('CowF'), J((brd.sessions || []).map(s => s.session)))
const t1b = await call(A, 'log', { as: 'CowA', secret: 'ca', guide: 'agent', agent: 'research', label: 'Research' })
const t2b = await call(F, 'log', { as: 'CowF', secret: 'cf', guide: 'agent', agent: 'fr', label: 'From follower' })
const brd2 = (await call(A, 'activity', {})).sessions || []
check('3 (2.0, §4.4): log {guide:"agent", agent, label} is the agent\'s first report — on the gateway and through the FOLLOWER (forwarded to its gateway): {agent} filled, `board` created, the agents on A\'s board',
  t1b.ok === true && t1b.text.includes('agent=[research]') && t1b.board?.ok === true && t1b.board?.node?.created === true && nodeAt(brd2, 'CowA', 'Research')?.current?.text === 'reading the guide'
  && t2b.ok === true && t2b.text.includes('agent=[fr]') && t2b.board?.ok === true && t2b.board?.node?.created === true && nodeAt(brd2, 'CowF', 'From follower')?.kind === 'agent', J([t1b.board, t2b.board, (sessOf(brd2, 'CowF')?.nodes || []).map(n => n.path)]))
const t3 = await call(A, 'log', { as: 'CowA', secret: 'ca', guide: 'agent', text: 'hello' })
check('3: guide with report fields → bad-guide (it returns text instead of logging)', t3.ok === false && t3.code === 'bad-guide' && /text/.test(t3.what || ''), J(t3))
const t4 = await call(A, 'log', { as: 'CowA', secret: 'ca', guide: 'robot' })
check('3: a bad kind → bad-guide', t4.ok === false && t4.code === 'bad-guide', J(t4))
const t5 = await call(A, 'log', { as: 'CowA', secret: 'WRONG', guide: 'agent' })
check('3: the guide still needs the session\'s as + secret', t5.ok === false && !J(t5).includes('REALM-AGENT'), J(t5))

// 4. B publishes a NEWER record: session needs 9.0 (→ built-in everywhere), agent text replaced
writeCfg(cfgB, { behaviors: { realm: { updated_at: '2026-10-03T11:00:00Z', default: [], guides: { agent: 'REALM-AGENT v2 {path} {agent}', session: { text: 'REALM-SESSION v2', min_bridge: '9.0' } } } } })
const g4 = await until(() => runGuide(agentArgs, urlA), r => r.first.startsWith('REALM-AGENT v2'))
check('4: a newer record on B replaces the guide on A (same replication as the reminders)', g4.code === 0 && g4.first === 'REALM-AGENT v2 Next/Item/helper <your-key>', g4.stdout)
const s4 = await until(() => runGuide(['--session', 'Lead', '--project', 'G89', '--guide', 'session'], urlA), r => !r.first.startsWith('REALM-SESSION'))
check('4: min_bridge 9.0 → aimb-log falls back to its OWN built-in (2.0) session guide; the source line says why', s4.code === 0 && /^ACTIVITY BOARD — how a session reports/.test(s4.first) && s4.stdout.includes('--key rel --item fix-x "Fix X"') && s4.last === `(Guide source: built into aimb-log ${VER}; the realm's session guide needs 9.0.0+.)`, s4.stdout.slice(-400))
const t6 = await until(() => call(A, 'log', { as: 'CowA', secret: 'ca', guide: 'session' }), r => r.source === 'builtin')
check('4: ... the log tool returns the bridge\'s built-in text (always text), source builtin, reason min_bridge', t6.ok === true && t6.source === 'builtin' && t6.reason === 'min_bridge' && /^ACTIVITY BOARD — how a session reports/.test(t6.text) && t6.text.includes('--session "CowA"') && t6.updated_at === null, J(t6).slice(0, 400))

// 5. a newer record WITHOUT guides clears them (the built-in text again, "the realm publishes no … guide")
writeCfg(cfgB, { behaviors: { realm: { updated_at: '2026-10-03T12:00:00Z', default: [] } } })
const g5 = await until(() => runGuide(agentArgs, urlA), r => !r.first.startsWith('REALM-AGENT'))
check('5: a newer record without guides clears them on A → the built-in 2.0 agent guide (its command with --agent "<your-key>" --text), source line "the realm publishes no agent guide"', g5.code === 0 && g5.first === `ACTIVITY BOARD — how to report your work (aimb-log ${VER}, gateway ${VER})` && g5.stdout.includes(`  ${wantCmd} --agent "<your-key>" --text "<text>"`) && g5.last === `(Guide source: built into aimb-log ${VER}; the realm publishes no agent guide.)`, g5.stdout.slice(-300))
const g5b = await runGuide(helperArgs, urlA)
check('5 (2.0, §4.4): the built-in guide re-read by an agent already on the board ("helper") → its own command (--agent "helper"), the source line, then "(Already on the board as …: nothing written.)"', g5b.code === 0 && g5b.stdout.includes(`  ${wantCmd} --agent "helper" --text "<text>"`) && /You are the agent helper /.test(g5b.stdout)
  && g5b.lines.at(-2) === `(Guide source: built into aimb-log ${VER}; the realm publishes no agent guide.)` && g5b.last === '(Already on the board as "Helper" — Helper: nothing written.)', g5b.stdout.slice(-300))

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

// ================================================================= 7. fallbacks: a 1.7x gateway, a 2.0 one that answers bad-op, one that is mute, none
function fakeGateway(port, onMsg) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port })
  wss.on('connection', ws => ws.on('message', raw => { const m = JSON.parse(String(raw)); fakes.log.push([port, m.type]); onMsg(ws, m) }))
  return wss
}
const fakes = { log: [] }
const welcome = (v, fmt) => ({ type: 'welcome', logger: true, instance: 'x', gateway: 'FAKE/1', bridge_version: v, realm: 'default', host: 'FAKE', ident: { project: 'G89', user: 'robin', session: 'Worker' }, ...(fmt ? { activity_format: fmt } : {}) })
const oldGw = fakeGateway(OLD_WS, (ws, m) => { if (m.type === 'hello') ws.send(J(welcome('1.75.1'))); else ws.send(J({ type: 'logged', ref: m.ref, result: { ok: false, code: 'bad-op' } })) })
const badOp = fakeGateway(BADOP_WS, (ws, m) => { if (m.type === 'hello') ws.send(J(welcome(VER, 6))); else ws.send(J({ type: 'logged', ref: m.ref != null ? m.ref : null, result: { ok: false, code: 'bad-op', what: 'a logger sends only …' } })) })
const mute = fakeGateway(MUTE_WS, (ws, m) => { if (m.type === 'hello') ws.send(J(welcome(VER, 6))) })
await sleep(200)
const o1 = await runGuide(agentArgs, `ws://127.0.0.1:${OLD_WS}`)
check('7: a 1.75.1 gateway (its welcome has no activity_format: not 2.0) → the built-in guide naming that gateway, the "not 2.0" note, source "gateway 1.75.1 does not speak 2.0" — and no guide request was sent to it',
  o1.code === 0 && o1.first === `ACTIVITY BOARD — how to report your work (aimb-log ${VER}, gateway 1.75.1)` && o1.stdout.includes('This host\'s gateway runs 1.75.1, not 2.0: reports are refused (gateway-unsupported) until it is upgraded.')
  && o1.last === `(Guide source: built into aimb-log ${VER}; gateway 1.75.1 does not speak 2.0.)` && !fakes.log.some(([p, t]) => p === OLD_WS && t === 'guide'), J([o1.stdout.slice(-400), fakes.log]))
const o1b = await runGuide(helperArgs, `ws://127.0.0.1:${OLD_WS}`)
check('7: ... with --agent: the guide (exit 0) and "Not on the board yet" (that gateway cannot register the agent; still no guide request)', o1b.code === 0 && /^\(Not on the board yet: this host's gateway could not register you/.test(o1b.last) && o1b.lines.at(-2) === `(Guide source: built into aimb-log ${VER}; gateway 1.75.1 does not speak 2.0.)` && !fakes.log.some(([p, t]) => p === OLD_WS && t === 'guide'), o1b.stdout.slice(-300))
const o2 = await runGuide(agentArgs, `ws://127.0.0.1:${BADOP_WS}`)
check('7: a 2.0 gateway that answers the guide request with bad-op → the built-in guide (exit 0)', o2.code === 0 && /^ACTIVITY BOARD — how to report your work/.test(o2.first) && /^\(Guide source: built into aimb-log /.test(o2.last) && fakes.log.some(([p, t]) => p === BADOP_WS && t === 'guide'), o2.stdout.slice(-300))
const t0 = Date.now(), o3 = await runGuide(agentArgs, `ws://127.0.0.1:${MUTE_WS}`, { AIMB_LOG_GUIDE_MS: '800' }), ms3 = Date.now() - t0
check('7: a gateway that never answers → the built-in guide after AIMB_LOG_GUIDE_MS (exit 0, prompt)', o3.code === 0 && /^ACTIVITY BOARD — how to report your work/.test(o3.first) && /Guide source: built into aimb-log/.test(o3.last) && fakes.log.some(([p, t]) => p === MUTE_WS && t === 'guide') && ms3 < 5000, J([ms3, o3.last]))
const o4 = await runGuide(agentArgs, `ws://127.0.0.1:${DEAD_WS}`)
check('7: no gateway at all → the built-in guide, "could not be reached" note + source line', o4.code === 0 && /could not be reached just now/.test(o4.stdout) && /the gateway could not be asked/.test(o4.last), o4.stdout.slice(-300))
for (const w of [oldGw, badOp, mute]) { try { w.close() } catch { } }

check('no token in any response, frame or script output', !seen.some(s => String(s).includes(TOKEN)))
console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(300)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
