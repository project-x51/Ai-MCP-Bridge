// #70 step 4 (v1.60.0) → #88 (v2.0) build step 9 — mesh-wide gossip of the activity board (gossip v6, docs/spec-88.md §6)
// + on-demand remote history, the parts test_activity2_gossip_live.mjs does not cover. Three "hosts" on loopback, each a
// 2.0 GATEWAY with its own host name (AI_BRIDGE_TEST_HOSTNAME); B (the smallest address) dials the others from its seeds:
//   B  127.0.0.1 "GOSSIP-B"  persist dir B; the observer. F is a FOLLOWER on B's port (a BARE session "BareF" of user
//                            alice) — it reads the mesh board through B, and takes over as B's gateway later (followers
//                            dial their gateway on 127.0.0.1, so the host with a follower is there)
//   A  127.0.0.2 "GOSSIP-A"  persist dir A; the OWNER side of the remote fetches (page = 3 entries, 2 fetches/s)
//   C  127.0.0.3 "GOSSIP-C"  persist dir C; a 1500-byte slice cap (truncation); killed at the end (owner down)
// The test-only AI_BRIDGE_TEST_ACTIVITY_TAP lets `activity {tap:true}` return the recent gossip frames sent/received (a v6
// frame's `units` by id). Covers: the mesh board read through a FOLLOWER (forwarded to its gateway) and by a dashboard's WS
// request; the same session name on A and B = two sessions, one per host; the bare-session user rule for scripts; a 20/s
// log:false burst for 4 s → ≤ 1 frame/s per link carrying only the changed units; a LINK RESTART (B's gateway killed, F
// takes over, replays B's files) → a full slice first on every new link, C's TRUNCATED newest-active first and completed
// by later frames; a FORGED slice (another origin / host fields inside) ignored, its link's sessions gone when it drops; a
// 1.7x peer's (activity_gossip:5) v5 slices skipped; a remote SUBTREE log by id; remote log paging over ≥ 3 pages and the
// fetch queue (the owner's 2/s) from the follower; ambiguous-session across hosts; prepare-shutdown on A → its agents gone
// at once (ACTIVITY_DOWN), cleared when A returns; C killed → remote_hosts shows it down and unlinked.
// Step 9 RETIRED (each check by its reason):
//   - "on B's board within ~2 s", "remote_hosts lists A (linked)", the plan on F + its tick as one delta + items never stale,
//     the nested tree node by node + a deep change as one delta, "entries rendered, no details", the remote entry checks,
//     "gossip never carries details/data", owner down → gone + owner-unreachable: covered by test_activity2_gossip_live.mjs
//     (replicate / ids / board head / rename-move-merge deltas / remote log / remote entry / restart) and
//     tests/unit/test_activity7_unit.mjs (a report = the node + its chain; the byte cap; down → gone);
//   - one "Twin" GROUP spanning both hosts (hosts, multi_host, selves): 1.7x-only (the 2.0 read lists one session per host;
//     grouping is the dashboard's, rebuilt in step 10);
//   - a subscribed dashboard's push (activity_sub → board + deltas): rebuilt on 2.0 in step 10 and checked in
//     test_activity_dashboard_live.mjs (+ the merged multi-host session in tests/unit/test_activity10_unit.mjs);
//   - the 1.61 peer (activity_gossip:1) and the LEGACY ≤ 1.59 hub D (its own board, no frames, still federated): 1.7x-only —
//     2.0 never meets one; a 1.7x peer is covered by test_activity2_gossip_live.mjs (§6 the 1.7x stand-in L) and by 6a here;
//   - the 1.7x `@`-path forms (paths, rel paths, implicit intermediates): 1.7x-only.
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 14100)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const TOKEN = 'gossiptesttok'
const A_PORT = String(tp(14100)), B_PORT = String(tp(14102)), C_PORT = String(tp(14140))
const HA = 'GOSSIP-A', HB = 'GOSSIP-B', HC = 'GOSSIP-C'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-gossip-'))
const dirs = { A: path.join(TMP, 'persist-A'), B: path.join(TMP, 'persist-B'), C: path.join(TMP, 'persist-C') }
const cfgFile = path.join(TMP, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_entries_per_agent: 50 } }))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
const V6 = 6   // the 2.0 activity format (activity_gossip:6, a v6 slice's `v`)

function spawn(name, bind, port, host, extra = {}) {
  const env = { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
    AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
    AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}`, AI_BRIDGE_DISCOVERY_MS: '300',
    AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_TEST_ACTIVITY_TAP: '1', TEMP: TMP, TMP, ...extra }
  delete env.AI_BRIDGE_TRAY
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR, env, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport, name }))
}
const fileOf = d => ({ AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: d })
const envA = { ...fileOf(dirs.A), AI_BRIDGE_ACTIVITY_PAGE_ENTRIES: '3', AI_BRIDGE_ACTIVITY_FETCH_RATE: '2' }
const seedsB = { AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT},127.0.0.3:${C_PORT}` }   // the smaller address dials
const envB = { ...fileOf(dirs.B), ...seedsB }
const envF = { ...fileOf(dirs.B), ...seedsB, AI_BRIDGE_PROJECT: 'AIMB', AI_BRIDGE_USER: 'alice' }   // a BARE session "BareF" (project + user of its own)
const envC = { ...fileOf(dirs.C), AI_BRIDGE_ACTIVITY_SLICE_MAX_BYTES: '1500' }
const spawnA = () => spawn('HubA', '127.0.0.2', A_PORT, HA, envA)
const call = async (b, n, a = {}) => { try { return JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 100) {
  const t0 = Date.now(); let r
  do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms)
  return r
}
const board = async h => (await call(h, 'activity')).sessions || []
const sessOf = (b, name, host) => b.find(s => String(s.session).toLowerCase() === name.toLowerCase() && (!host || s.host === host))
const sessAll = (b, name) => b.filter(s => String(s.session).toLowerCase() === name.toLowerCase())
const nodeAt = (s, p) => ((s && s.nodes) || []).find(n => n.path === p)
const agentsOf = s => ((s && s.nodes) || []).filter(n => n.kind === 'agent')
const tap = async h => (await call(h, 'activity', { tap: true, session: '-none-' })).tap || { sent: [], recv: [] }
const SLICES = ['full', 'delta', 'beat']
async function hardKill(h) {   // TerminateProcess: no exit handlers run (like the tray's kill)
  const pid = h.transport.pid
  try { process.kill(pid, 'SIGKILL') } catch { }
  for (let i = 0; i < 60; i++) { try { process.kill(pid, 0) } catch { break } await sleep(100) }
  try { await h.transport.close() } catch { }
}
function post(host, port, p, headers = {}) {
  return new Promise(resolve => {
    const req = http.request({ host, port: Number(port), path: p, method: 'POST', headers, timeout: 5000 }, res => {
      let body = ''; res.on('data', d => { body += d }); res.on('end', () => { let j = null; try { j = JSON.parse(body) } catch { } resolve({ status: res.statusCode, body: j }) })
    })
    req.on('error', e => resolve({ status: 0, err: String(e) }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }) })
    req.end()
  })
}
// a `logger` WS leaf (what tools/aimb-log.mjs speaks) — results by ref
function logger(host, wsPort, ident) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${host}:${wsPort}`)
    const res = new Map(), L = { ws, res, welcome: null, n: 0 }
    L.send = input => { const ref = ++L.n; ws.send(J({ type: 'log', ref, input })); return ref }
    L.log = async input => { const ref = L.send(input); for (let i = 0; i < 100 && !res.has(ref); i++) await sleep(50); return res.get(ref) || { ok: false, code: 'no-answer' } }
    L.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => ws.send(J({ type: 'hello', kind: 'logger', token: TOKEN, ident })))
    ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.type === 'welcome') { L.welcome = m; resolve(L) } else if (m.type === 'logged') res.set(m.ref, m.result); else if (m.type === 'error') { L.welcome = m; resolve(L) } })
    ws.on('error', () => resolve(L))
  })
}
// a raw peer-hub link (HELLO + PEER_HELLO) for the forgery checks
const frameOf = o => { const b = Buffer.from(J(o)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]) }
function rawPeer(host, port, session, fmt = V6) {
  return new Promise(resolve => {
    const s = net.connect(Number(port), host, () => {
      s.write(frameOf({ t: 'HELLO', ver: 1, fromBridge: session, fromSession: session, name: 'fake', auth: TOKEN }))
      s.write(frameOf({ t: 'PEER_HELLO', session, name: 'fake', host: '127.0.0.9', port: 1, realm: 'default', gossip_refresh: true, refresh_ms: 60000, activity_gossip: fmt }))
      setTimeout(() => resolve(s), 400)
    })
    s.on('error', () => resolve(s)); s.on('data', () => { })
  })
}
// a v6 session record (§6.1): the header (+ a `host` field that must NOT decide ownership) + its root unit + one agent unit
const fid = (c, n) => (c.repeat(14) + n).slice(0, 16)   // a well-formed 16-char node id (a-z2-7)
const forgedSession = (name, host, c) => ({ session: name, project: 'AIMB', user: 'robin', realm: 'default', host, created_at: Date.now(), last_activity: Date.now(), root_id: fid(c, 'aa'),
  nodes: [{ id: fid(c, 'aa'), root: true, label: name, nk: 'session', type: 'session', created_at: Date.now(), last_activity: Date.now(), host },
    { id: fid(c, 'bb'), p: fid(c, 'aa'), label: 'Forger', nk: 'agent', type: 'agent', created_at: Date.now(), last_activity: Date.now(), host, current: { id: `forged-${c}`, ts: Date.now(), text: `forged ${name}`, state: 'running' } }] })
const v5Session = name => ({ session: name, project: 'AIMB', user: 'robin', realm: 'default', created_at: Date.now(), last_activity: Date.now(),
  nodes: [{ path: '', created_at: Date.now(), last_activity: Date.now(), current: { id: 'v5-1', ts: Date.now(), text: `v5 ${name}`, state: 'running' } }] })

const all = []
const drop = h => { const i = all.indexOf(h); if (i >= 0) all.splice(i, 1) }
try {
  // ---- the mesh
  let B = await spawn('HubB', '127.0.0.1', B_PORT, HB, envB); all.push(B)
  await sleep(600)
  let A = await spawnA(); all.push(A)
  const F = await spawn('BareF', '127.0.0.1', B_PORT, HB, envF); all.push(F)
  let C = await spawn('HubC', '127.0.0.3', C_PORT, HC, envC); all.push(C)
  const ids = await Promise.all([A, B, F, C].map(h => call(h, 'my_identity')))
  check('harness: A, B, C gateways + F a follower on B', J(ids.map(i => i.role)) === J(['gateway', 'gateway', 'follower', 'gateway']), J(ids.map(i => [i.role, i.bridge_version])))
  const linked = await until(() => call(B, 'list_sessions'), r => [HA, HC].every(h => (r.sessions || []).some(s => String(s.session).startsWith(h + '/'))), 10000)
  check('harness: A and C are linked to B (federated roster)', [HA, HC].every(h => (linked.sessions || []).some(s => String(s.session).startsWith(h + '/'))), J((linked.sessions || []).map(s => s.session)))

  // ---- 1. an agent logged on A: on B's board, and on F's (a follower's read is forwarded to its gateway)
  await call(A, 'register_self', { name: 'Orch', secret: 'or', project: 'AIMB' })
  const la = i => call(A, 'log', { as: 'Orch', secret: 'or', ...i })
  const l1 = await la({ agent: 'research', label: 'Research', text: '@reading the spec', state: 'running', progress: '1/4 docs' })
  const b1 = await until(() => board(B), b => !!nodeAt(sessOf(b, 'Orch', HA), 'Research'), 6000, 50)
  check('harness: an agent logged on A is on B\'s board, tagged with A (remote)', l1.ok && nodeAt(sessOf(b1, 'Orch', HA), 'Research')?.id === l1.node?.id && sessOf(b1, 'Orch', HA)?.remote === true, J([l1, sessOf(b1, 'Orch')]))
  const fb = await board(F)
  const fr = nodeAt(sessOf(fb, 'Orch', HA), 'Research')
  check('follower: F\'s activity read (forwarded to B) shows the mesh board — A\'s agent, tagged with A, its id, line and bar', fr?.id === l1.node?.id && sessOf(fb, 'Orch', HA)?.host === HA && fr?.current?.text === 'reading the spec' && fr?.progress?.done === 1, J(sessOf(fb, 'Orch')))

  // ---- 2. the same session name on A and B = two sessions on the board, one per host
  await call(A, 'register_self', { name: 'Twin', secret: 'tw', project: 'AIMB' })
  await call(B, 'register_self', { name: 'Twin', secret: 'tw', project: 'AIMB' })
  const twA = await call(A, 'log', { as: 'Twin', secret: 'tw', agent: 'worker', label: 'Worker', text: '@twin on A', state: 'running' })
  const twB = await call(B, 'log', { as: 'Twin', secret: 'tw', agent: 'worker', label: 'Worker', text: '@twin on B', state: 'running' })
  const b2 = await until(() => board(B), b => sessAll(b, 'Twin').length === 2, 5000)
  const tws = sessAll(b2, 'Twin')
  check('same name: two "Twin" sessions on B\'s board, one per host, each with its own Worker (its own id and line)', twA.ok && twB.ok && J(tws.map(s => [s.host, nodeAt(s, 'Worker')?.current?.text]).sort()) === J([[HA, 'twin on A'], [HB, 'twin on B']])
    && nodeAt(sessOf(b2, 'Twin', HA), 'Worker')?.id === twA.node?.id && nodeAt(sessOf(b2, 'Twin', HB), 'Worker')?.id === twB.node?.id && twA.node?.id !== twB.node?.id, J(tws.map(s => [s.host, s.nodes.map(n => [n.path, n.id])])))
  const a2 = await until(() => board(A), b => sessAll(b, 'Twin').length === 2, 5000)
  check('same name: A sees the same (B gossips to A)', nodeAt(sessOf(a2, 'Twin', HB), 'Worker')?.current?.text === 'twin on B' && nodeAt(sessOf(a2, 'Twin', HA), 'Worker')?.current?.text === 'twin on A', J(sessAll(a2, 'Twin')))

  // ---- 2b. a dashboard (WS) request for the board → the mesh board
  const dash = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${Number(B_PORT) + 1}`), d = { ws, msgs: [] }
    ws.on('open', () => ws.send(J({ type: 'hello', token: TOKEN, kind: 'dashboard', instance: 'gossip-dash' })))
    ws.on('message', raw => { const m = JSON.parse(String(raw)); d.msgs.push(m); if (m.type === 'welcome') resolve(d) })
    ws.on('error', () => resolve(d))
  })
  dash.ws.send(J({ type: 'activity', ref: 'q1', query: { session: 'Orch' } }))
  await until(async () => dash.msgs.some(m => m.type === 'activity' && m.ref === 'q1'), x => x, 3000)
  const dq = dash.msgs.find(m => m.type === 'activity' && m.ref === 'q1')
  check('dashboard: {type:"activity", query} → the mesh board (A\'s agent, tagged)', dq?.result?.ok === true && nodeAt(sessOf(dq.result.sessions || [], 'Orch', HA), 'Research')?.id === l1.node?.id, J(dq))
  dash.ws.close()

  // ---- 3. bare-session rule: a script may not report for a BARE session live under another user (same user: fine)
  const bob = await logger('127.0.0.2', Number(A_PORT) + 1, { session: 'baref', project: 'aimb', user: 'bob' })
  const rb = bob.welcome?.logger ? await bob.log({ text: 'speaking for BareF' }) : { ok: false, code: 'no-welcome' }
  bob.close()
  check('bare session: another user → session-user-mismatch', rb.ok === false && rb.code === 'session-user-mismatch', J(rb))
  const alice = await logger('127.0.0.2', Number(A_PORT) + 1, { session: 'BareF', project: 'AIMB', user: 'Alice' })
  const ral = alice.welcome?.logger ? await alice.log({ text: '@bare session reporting' }) : { ok: false, code: 'no-welcome' }
  alice.close()
  check('bare session: the same user (case-insensitive) → accepted', ral.ok === true, J(ral))

  // ---- 4. rate: a 20/s log:false burst (3 agents' bars) for 4 s → at most ONE frame per second on A→B
  const pump = await logger('127.0.0.2', Number(A_PORT) + 1, { session: 'Pump', project: 'AIMB', user: 'robin' })
  const pumpIds = new Set()
  for (const ag of ['p1', 'p2', 'p3']) {
    const a = await pump.log({ agent: ag, label: ag.toUpperCase(), text: '@pumping', state: 'running' })
    const bar = await pump.log({ agent: ag, key: 'bar', label: 'Bar', text: '@pumping', progress: '0/80' })
    for (const r of [a, bar]) if (r.node?.id) pumpIds.add(r.node.id)
  }
  await sleep(1200)
  const tStart = Date.now()
  let n = 0
  for (let i = 1; i <= 80; i++) { for (const ag of ['p1', 'p2', 'p3']) pump.send({ agent: ag, key: 'bar', progress: `${i}/80`, log: false }); n += 3; await sleep(50) }
  const tEnd = Date.now()
  await sleep(1500)
  const sentAB = (await tap(A)).sent.filter(x => x.peer === HB && SLICES.includes(x.kind) && x.ts >= tStart && x.ts <= tEnd + 1200)
  const gaps = sentAB.slice(1).map((x, i) => x.ts - sentAB[i].ts)
  const secs = (tEnd - tStart) / 1000
  check(`rate: ${n} board updates in ${secs.toFixed(1)} s → ≤1 frame/s on the A→B link (${sentAB.length} frames)`, pumpIds.size === 6 && sentAB.length >= 2 && sentAB.length <= Math.ceil(secs) + 2, J([pumpIds.size, sentAB.map(x => [x.ts - tStart, x.kind, (x.units || []).length])]))
  check('rate: consecutive frames on one link are ≥ ~1 s apart (coalesced)', gaps.every(g => g >= 900), J(gaps))
  check('rate: ... carrying only what changed (units of the Pump session only: its 3 agents, their bars, at most its root)', sentAB.every(x => (x.units || []).length <= 7 && (x.units || []).every(u => u.session === 'Pump' && (pumpIds.has(u.id) || u.root))),
    J(sentAB.map(x => (x.units || []).map(u => `${u.session}/${u.label}`))))
  const b4 = await until(() => board(B), b => ['P1', 'P2', 'P3'].every(p => nodeAt(sessOf(b, 'Pump', HA), `${p}/Bar`)?.progress?.done === 80), 4000)
  check('rate: B ends with the final bars (80/80 on all three)', ['P1', 'P2', 'P3'].every(p => nodeAt(sessOf(b4, 'Pump', HA), `${p}/Bar`)?.progress?.done === 80), J(sessOf(b4, 'Pump')?.nodes?.map(x => [x.path, x.progress])))
  pump.close()

  // ---- 5. C (a 1500-byte cap) has 10 agents; then a LINK RESTART: B's gateway dies, F takes over → full slices
  await call(C, 'register_self', { name: 'Tiler', secret: 'ti', project: 'AIMB' })
  for (let i = 1; i <= 10; i++) { await call(C, 'log', { as: 'Tiler', secret: 'ti', agent: `c${String(i).padStart(2, '0')}`, label: `Tile ${i}`, text: `@tile batch ${i} ${'x'.repeat(150)}`, state: 'running' }); await sleep(15) }
  await until(() => board(B), b => agentsOf(sessOf(b, 'Tiler', HC)).length === 10, 15000, 250)
  await hardKill(B); drop(B)
  const fRole = await until(() => call(F, 'my_identity'), r => r.role === 'gateway', 10000, 200)
  check('link restart: B\'s gateway is gone; F (same host) took over as gateway', fRole.role === 'gateway', J(fRole.role))
  const bF = await until(() => board(F), b => agentsOf(sessOf(b, 'Tiler', HC)).length === 10 && !!nodeAt(sessOf(b, 'Orch', HA), 'Research') && sessAll(b, 'Twin').length === 2, 15000, 200)
  check('link restart: the new gateway gets FULL slices — A\'s and C\'s agents are back on its board (same ids)', agentsOf(sessOf(bF, 'Tiler', HC)).length === 10 && nodeAt(sessOf(bF, 'Orch', HA), 'Research')?.id === l1.node?.id, J(bF.map(s => [s.session, s.host, s.nodes.length])))
  check('link restart: ... and host B\'s own Twin worker was replayed from B\'s files (its id, its line)', nodeAt(sessOf(bF, 'Twin', HB), 'Worker')?.id === twB.node?.id && nodeAt(sessOf(bF, 'Twin', HB), 'Worker')?.current?.text === 'twin on B', J(sessAll(bF, 'Twin')))
  const tF = await tap(F)
  const fromA = tF.recv.filter(x => x.peer === HA && SLICES.includes(x.kind)), fromC = tF.recv.filter(x => x.peer === HC && SLICES.includes(x.kind))
  check('link restart: the first frame on each new link is a full v6 slice', fromA[0]?.kind === 'full' && fromC[0]?.kind === 'full' && fromA[0]?.v === V6 && fromC[0]?.v === V6, J([fromA[0], fromC[0]]))
  const firstC = fromC[0] || { units: [] }
  const cNums = (firstC.units || []).filter(u => /^Tile \d+$/.test(u.label)).map(u => Number(u.label.slice(5)))
  check('truncation: C\'s full slice is over its 1500-byte cap → TRUNCATED, newest-active first', firstC.truncated === true && cNums.length >= 1 && cNums.length < 10 && J(cNums) === J([...cNums].sort((x, y) => y - x)) && cNums[0] === 10, J(firstC))
  check('truncation: ... the rest followed in later frames (≥1 s apart) until all 10 were held', fromC.length >= 2 && fromC.slice(1).every((x, i) => x.ts - fromC[i].ts >= 900)
    && new Set(fromC.flatMap(x => (x.units || []).filter(u => /^Tile \d+$/.test(u.label)).map(u => u.label))).size === 10, J(fromC.map(x => [x.kind, (x.units || []).length, x.truncated])))

  // ---- 6. forged slices: another origin's name in the frame is refused; host fields inside never decide ownership
  const fake = await rawPeer('127.0.0.1', B_PORT, 'FAKE-HOST/0001')
  fake.write(frameOf({ t: 'ACTIVITY_SLICE', v: V6, origin: HA, epoch: 'f', seq: 1, full: true, sessions: [forgedSession('ForgedA', HA, 'q')] }))
  await sleep(300)
  fake.write(frameOf({ t: 'ACTIVITY_SLICE', v: V6, epoch: 'f', seq: 2, full: true, sessions: [forgedSession('ForgedB', HA, 'r')] }))
  const b6 = await until(() => board(F), b => !!sessOf(b, 'ForgedB'), 3000)
  check('forged: a slice naming another origin (A) is dropped — nothing of it on the board', !sessOf(b6, 'ForgedA') && !J(b6).includes('forged ForgedA') && (await tap(F)).recv.some(x => x.peer === 'FAKE-HOST' && x.kind === 'forged'), J(b6.map(s => s.session)))
  check('forged: a slice\'s own host fields are ignored — it is tagged with the LINK\'s host, never A', sessOf(b6, 'ForgedB')?.host === 'FAKE-HOST' && sessAll(b6, 'ForgedB').length === 1 && nodeAt(sessOf(b6, 'ForgedB'), 'Forger')?.current?.text === 'forged ForgedB', J(sessAll(b6, 'ForgedB')))
  check('forged: A\'s own nodes are untouched', nodeAt(sessOf(b6, 'Orch', HA), 'Research')?.id === l1.node?.id && nodeAt(sessOf(b6, 'Orch', HA), 'Research')?.current?.text === 'reading the spec')
  fake.destroy()
  const b6b = await until(() => board(F), b => nodeAt(sessOf(b, 'ForgedB'), 'Forger')?.state === 'gone', 3000)
  check('forged: when that link drops, its agents show gone', nodeAt(sessOf(b6b, 'ForgedB'), 'Forger')?.state === 'gone' && sessOf(b6b, 'ForgedB')?.down_at > 0, J(sessOf(b6b, 'ForgedB')))
  // 6a: a 1.7x peer (activity_gossip:5) — its v5 slices are SKIPPED (never misread), full or delta
  const old17 = await rawPeer('127.0.0.1', B_PORT, 'OLD-HUB/0001', 5)
  old17.write(frameOf({ t: 'ACTIVITY_SLICE', v: 5, origin: 'OLD-HUB', epoch: 'o', seq: 1, full: true, sessions: [v5Session('Old17')] }))
  old17.write(frameOf({ t: 'ACTIVITY_SLICE', v: 5, origin: 'OLD-HUB', epoch: 'o', seq: 2, base: 1, sessions: [v5Session('Old17b')] }))
  await sleep(1200)
  const b6c = await board(F), tOld = await tap(F)
  check('1.7x peer (6a): its v5 slices are skipped — nothing on the board, the frames tapped as skipped-format, no frame sent to it', !sessOf(b6c, 'Old17') && !sessOf(b6c, 'Old17b') && !J(b6c).includes('v5 Old17')
    && tOld.recv.filter(x => x.peer === 'OLD-HUB' && x.kind === 'skipped-format').length >= 2 && !tOld.sent.some(x => x.peer === 'OLD-HUB'), J(tOld.recv.filter(x => x.peer === 'OLD-HUB')))
  old17.destroy()

  // ---- 6b: a remote SUBTREE log by id — the merged log of an agent, its context and its sub-agent, paged by the owner
  const sp = await la({ agent: 'spec', label: 'Spec 70', text: '@agent under a task', state: 'running' })
  const th = await la({ agent: 'spec', key: 'tharsis', label: 'Tharsis', text: 'deep context', progress: '1/4 tiles' })
  const sub = await la({ agent: 'spec/research', label: 'Sub research', text: '@a sub-agent', state: 'running' })
  await until(() => board(F), b => !!nodeAt(sessOf(b, 'Orch', HA), 'Spec 70/Sub research'), 6000)
  await sleep(1100)
  const rsub = await call(F, 'activity', { log: { session: 'Orch', id: sp.node?.id, limit: 50 } })
  check('subtree (6b): the remote SUBTREE log of an agent (by id) is fetched from its owner — its own entry, its context\'s and its sub-agent\'s', sp.ok && th.ok && sub.ok && rsub.ok && rsub.from_host === HA
    && J((rsub.log?.entries || []).map(e => e.node_id).sort()) === J([sp.node.id, th.node.id, sub.node.id].sort()), J([rsub.code, rsub.log?.entries?.map(e => [e.node_id, e.at, e.text])]))
  await sleep(1100)

  // ---- 7. remote history: A's log paged (3 per page on A) across ≥3 pages, from the follower-turned-gateway F
  const ids7 = []
  for (let i = 1; i <= 7; i++) ids7.push((await la({ agent: 'pager', label: 'Pager', text: `page entry ${i}` })).id)
  const pg = await until(() => board(F), b => !!nodeAt(sessOf(b, 'Orch', HA), 'Pager'), 5000)
  const pagerId = nodeAt(sessOf(pg, 'Orch', HA), 'Pager')?.id
  const pages = []
  let cursor = null
  for (let k = 0; k < 5; k++) {
    const r = await call(F, 'activity', { log: { session: 'Orch', id: pagerId, own: true, limit: 50, ...(cursor ? { cursor } : {}) } })
    pages.push(r); cursor = r.log?.next_cursor
    if (!cursor) break
    await sleep(600)   // A serves 2 fetches per second per link
  }
  const got7 = pages.flatMap(p => (p.log?.entries || []).map(e => e.id))
  check('remote log: paged by the OWNER (3 per page) — ≥ 3 pages, newest first, chained by next_cursor', pages.length >= 3 && pages.every(p => p.ok && p.from_host === HA && p.log?.host === HA) && pages[0].log.entries.length === 3
    && J(got7.filter(id => ids7.includes(id))) === J([...ids7].reverse()) && !pages.at(-1).log.next_cursor, J(pages.map(p => [p.ok, p.code, p.log?.entries?.length, p.log?.next_cursor])))
  await sleep(1100)
  // ---- 9. the fetch rate limit (A serves 2/s per link): the requesting gateway QUEUES the burst at the owner's rate
  const burst = await Promise.all(Array.from({ length: 8 }, () => call(F, 'activity', { log: { session: 'Orch', id: pagerId, limit: 1 } })))
  check('rate limit: a burst of 8 remote fetches → all answered (queued at the owner\'s 2/s, none rate-limited)', burst.every(r => r.ok) && burst.some(r => r.queued_ms > 0), J(burst.map(r => r.code || `ok${r.queued_ms ? '+' + r.queued_ms : ''}`)))
  const amb = await call(F, 'activity', { log: { session: 'Twin' } })
  check('remote log: a name on several hosts → ambiguous-session with each candidate\'s host', amb.ok === false && amb.code === 'ambiguous-session' && J((amb.candidates || []).map(c => c.host).sort()) === J([HA, HB]), J(amb))

  // ---- 10. prepare-shutdown on A → its agents gone on F at once (ACTIVITY_DOWN); cleared when A returns
  const tDown = Date.now()
  const ps = await post('127.0.0.2', Number(A_PORT) + 1, '/admin/prepare-shutdown', { Authorization: `Bearer ${TOKEN}` })
  check('prepare-shutdown: 200 + the going-down notice went to the peer hub(s)', ps.status === 200 && ps.body?.down_notified >= 1, J(ps))
  const b10 = await until(() => board(F), b => nodeAt(sessOf(b, 'Orch', HA), 'Research')?.state === 'gone', 3000, 50)
  check('going down: F shows A\'s agents GONE immediately (before any link timeout), last line kept', nodeAt(sessOf(b10, 'Orch', HA), 'Research')?.state === 'gone' && Date.now() - tDown < 1500
    && nodeAt(sessOf(b10, 'Orch', HA), 'Research')?.current?.text === 'reading the spec' && nodeAt(sessOf(b10, 'Twin', HA), 'Worker')?.state === 'gone', `${Date.now() - tDown}ms ${J(nodeAt(sessOf(b10, 'Orch', HA), 'Research'))}`)
  check('going down: host B\'s own agents are not affected', nodeAt(sessOf(b10, 'Twin', HB), 'Worker')?.state === 'running', J(nodeAt(sessOf(b10, 'Twin', HB), 'Worker')))
  await hardKill(A); drop(A)
  A = await spawnA(); all.push(A)
  const b10b = await until(() => board(F), b => nodeAt(sessOf(b, 'Orch', HA), 'Research') && nodeAt(sessOf(b, 'Orch', HA), 'Research').state !== 'gone', 15000, 200)
  check('going down: when A returns (replayed from its files) its fresh slice clears gone (the same id)', nodeAt(sessOf(b10b, 'Orch', HA), 'Research')?.state === 'running' && nodeAt(sessOf(b10b, 'Orch', HA), 'Research')?.current?.text === 'reading the spec'
    && nodeAt(sessOf(b10b, 'Orch', HA), 'Research')?.id === l1.node?.id, J(nodeAt(sessOf(b10b, 'Orch', HA), 'Research')))

  // ---- 11. owner down: C killed → the board head's remote_hosts shows C down and unlinked
  await hardKill(C); drop(C)
  const hd = await until(() => call(F, 'activity', { session: '-none-' }), h => (h.remote_hosts || []).some(x => x.host === HC && x.down_at > 0), 5000)
  check('owner down: remote_hosts shows C down and unlinked (its board still held, gone)', (hd.remote_hosts || []).some(x => x.host === HC && x.down_at > 0 && x.linked === false && x.sessions >= 1), J(hd.remote_hosts))
} catch (e) { fail++; console.log('FAIL crashed:', (e && e.stack) || e) }

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(400)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
