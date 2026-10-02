// #70 step 4 (v1.60.0) — mesh-wide gossip of the activity board + on-demand remote history.
// Four "hosts" on loopback, each a GATEWAY with its own host name (AI_BRIDGE_TEST_HOSTNAME); B (the smallest address)
// dials the others from its seeds:
//   B  127.0.0.1:14102 "GOSSIP-B"  persist dir B; the observer. F is a FOLLOWER on B's port (a BARE session "BareF" of
//                                  user alice) — it reads the mesh board through B, and takes over as B's gateway later
//                                  (followers dial their gateway on 127.0.0.1, so the host with a follower is there)
//   A  127.0.0.2:14100 "GOSSIP-A"  persist dir A; the OWNER side of the remote fetches (page = 3 entries, 2 fetches/s)
//   C  127.0.0.3:14140 "GOSSIP-C"  persist dir C; a 1500-byte slice cap (truncation); killed at the end (owner down)
//   D  127.0.0.4:14150 "GOSSIP-D"  AI_BRIDGE_TEST_GOSSIP=legacy — behaves like a ≤1.59 hub (no flag, ignores the frames)
// The test-only AI_BRIDGE_TEST_ACTIVITY_TAP lets `activity {tap:true}` return the recent gossip frames sent/received.
// Covers: an agent on A on B's board within ~2 s tagged with A's host (and on F's, forwarded); the same session/agent name
// on A and B = two entities in one group; a dashboard WS request + push; a 20/s log:false burst for 4 s → ≤1 frame/s
// per link; the bare-session user rule; a link restart (B's gateway killed, F takes over) → full slices, C's TRUNCATED newest-first and completed by later
// deltas; a forged slice (another origin; host fields) ignored; remote log paging over ≥3 pages; remote entry
// details/data; the fetch rate limit (queued by the requester since v1.61.0); prepare-shutdown on A → gone at once, cleared when A returns; C killed →
// owner-unreachable + gone; the legacy hub breaks nothing. v1.62.0 (#70 step 6a): slices are format v2 (one unit per NODE) —
// a nested tree logged on A reaches B node by node, a deep change sends only the changed nodes, a remote SUBTREE log is
// paged by the owner, and a peer declaring the 1.61 format (activity_gossip:1) has its v1 slices skipped. Ports
// 14100–14199. AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Act from '../lib/activity.js'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const TOKEN = 'gossiptesttok'
const A_PORT = '14100', B_PORT = '14102', C_PORT = '14140', D_PORT = '14150'
const HA = 'GOSSIP-A', HB = 'GOSSIP-B', HC = 'GOSSIP-C', HD = 'GOSSIP-D'
const dirs = { A: fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-gsA-')), B: fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-gsB-')), C: fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-gsC-')) }
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-gscfg-'))
const cfgFile = path.join(cfgDir, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_entries_per_agent: 50 } }))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify

function spawn(name, bind, port, host, extra = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
      AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}`, AI_BRIDGE_DISCOVERY_MS: '300',
      AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_TEST_ACTIVITY_TAP: '1', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport, name }))
}
const fileOf = d => ({ AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: d })
const envA = { ...fileOf(dirs.A), AI_BRIDGE_ACTIVITY_PAGE_ENTRIES: '3', AI_BRIDGE_ACTIVITY_FETCH_RATE: '2' }
const seedsB = { AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT},127.0.0.3:${C_PORT},127.0.0.4:${D_PORT}` }   // the smaller address dials
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
const group = (b, name) => b.find(s => String(s.session).toLowerCase() === name.toLowerCase())
const agentsOf = (b, name, path) => (group(b, name)?.nodes || []).filter(x => x.path === path)   // v1.62.0: every node by path (one per host)
const tap = async h => (await call(h, 'activity', { tap: true, session: '-none-' })).tap || { sent: [], recv: [] }
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
function rawPeer(host, port, session, fmt = Act.ACTIVITY_FORMAT) {   // the current format (6d: v5)
  return new Promise(resolve => {
    const s = net.connect(Number(port), host, () => {
      s.write(frameOf({ t: 'HELLO', ver: 1, fromBridge: session, fromSession: session, name: 'fake', auth: TOKEN }))
      s.write(frameOf({ t: 'PEER_HELLO', session, name: 'fake', host: '127.0.0.9', port: 1, realm: 'default', gossip_refresh: true, refresh_ms: 60000, activity_gossip: fmt }))
      setTimeout(() => resolve(s), 400)
    })
    s.on('error', () => resolve(s)); s.on('data', () => { })
  })
}
const forgedSession = (name, host) => ({ session: name, project: 'AIMB', user: 'robin', realm: 'default', host, created_at: Date.now(), last_activity: Date.now(),
  nodes: [{ path: '', created_at: Date.now(), last_activity: Date.now(), current: { id: 'forged-1', ts: Date.now(), text: `forged ${name}`, state: 'running' } }] })
const v1Session = name => ({ session: name, project: 'AIMB', user: 'robin', realm: 'default', created_at: Date.now(), last_activity: Date.now(),
  self: { started_at: Date.now(), last_activity: Date.now(), contexts: [{ name: 'root', created_at: Date.now(), last_activity: Date.now(), current: { id: 'v1-1', ts: Date.now(), text: `v1 ${name}`, state: 'running' } }] }, agents: [{ path: 'old-agent', contexts: [] }] })

const all = []
const drop = h => { const i = all.indexOf(h); if (i >= 0) all.splice(i, 1) }
// ---- the mesh
let B = await spawn('HubB', '127.0.0.1', B_PORT, HB, envB); all.push(B)
await sleep(600)
let A = await spawnA(); all.push(A)
const F = await spawn('BareF', '127.0.0.1', B_PORT, HB, envF); all.push(F)
let C = await spawn('HubC', '127.0.0.3', C_PORT, HC, envC); all.push(C)
const D = await spawn('HubD', '127.0.0.4', D_PORT, HD, { AI_BRIDGE_TEST_GOSSIP: 'legacy' }); all.push(D)
const ids = await Promise.all([A, B, F, C, D].map(h => call(h, 'my_identity')))
check('harness: A, B, C, D gateways + F a follower on B, all on ≥ 1.60.0', J(ids.map(i => i.role)) === J(['gateway', 'gateway', 'follower', 'gateway', 'gateway'])
  && ids.every(i => (v => v[0] > 1 || (v[0] === 1 && v[1] >= 60))(String(i.bridge_version).split('.').map(Number))), J(ids.map(i => [i.role, i.bridge_version])))
const linked = await until(() => call(B, 'list_sessions'), r => [HA, HC, HD].every(h => (r.sessions || []).some(s => String(s.session).startsWith(h + '/'))), 10000)
check('harness: A, C and the legacy D are linked to B (federated roster)', [HA, HC, HD].every(h => (linked.sessions || []).some(s => String(s.session).startsWith(h + '/'))), J((linked.sessions || []).map(s => s.session)))

// ---- 1. an agent logged on A shows on B's board within ~2 s, tagged with A's host
await call(A, 'register_self', { name: 'Orch', secret: 'or', project: 'AIMB' })
const t0 = Date.now()
const l1 = await call(A, 'log', { as: 'Orch', secret: 'or', agent: 'research', text: '@~root reading the spec', progress: '1/4 docs' })
const b1 = await until(() => board(B), b => agentsOf(b, 'Orch', 'research').length > 0, 6000, 50)
const dt = Date.now() - t0, ra = agentsOf(b1, 'Orch', 'research')[0]
check('gossip: an agent logged on A is on B\'s board within ~2 s', l1.ok && !!ra && dt < 2500, `${dt}ms ${J(ra)}`)
check('gossip: ... tagged with A\'s host (entity + group), its line + bar intact, no local log on B', ra?.host === HA && group(b1, 'Orch')?.host === HA && ra?.current?.text === 'reading the spec'
  && ra?.progress?.done === 1 && ra?.log?.remote === true, J(group(b1, 'Orch')))
const fb = await board(F)
check('follower: F\'s activity read (forwarded to B) shows the mesh board, tagged', agentsOf(fb, 'Orch', 'research')[0]?.host === HA, J(group(fb, 'Orch')))
const hb = await call(B, 'activity')
check('board head: remote_hosts lists A (linked)', (hb.remote_hosts || []).some(x => x.host === HA && x.linked === true), J(hb.remote_hosts))

// ---- 2. the same session/agent name on A and B = two entities, one group
await call(A, 'register_self', { name: 'Twin', secret: 'tw', project: 'AIMB' })
await call(B, 'register_self', { name: 'Twin', secret: 'tw', project: 'AIMB' })
await call(A, 'log', { as: 'Twin', secret: 'tw', agent: 'worker', text: '@~root twin on A' })
await call(B, 'log', { as: 'Twin', secret: 'tw', agent: 'worker', text: '@~root twin on B' })
const b2 = await until(() => board(B), b => agentsOf(b, 'Twin', 'worker').length === 2, 5000)
const tw = group(b2, 'Twin'), tws = agentsOf(b2, 'Twin', 'worker')
check('grouping: one Twin group spanning both hosts (hosts + multi_host)', !!tw && tw.multi_host === true && J([...(tw.hosts || [])].sort()) === J([HA, HB]), J(tw))
check('grouping: two "worker" entities, each tagged with its own host and line', J(tws.map(x => [x.host, x.current?.text]).sort()) === J([[HA, 'twin on A'], [HB, 'twin on B']]), J(tws))
check('grouping: selves (one per host)', (tw?.selves || []).length === 2, J(tw?.selves))
const a2 = await until(() => board(A), b => agentsOf(b, 'Twin', 'worker').length === 2, 5000)
check('grouping: A sees the same (B gossips to A)', agentsOf(a2, 'Twin', 'worker').some(x => x.host === HB), J(group(a2, 'Twin')))

// ---- 2b. dashboards (WS): request/response + a push (≤1/s) when the mesh board changes
const dash = await new Promise(resolve => {
  const ws = new WebSocket(`ws://127.0.0.1:${Number(B_PORT) + 1}`), d = { ws, msgs: [] }
  ws.on('open', () => ws.send(J({ type: 'hello', token: TOKEN, kind: 'dashboard', instance: 'gossip-dash' })))
  ws.on('message', raw => { const m = JSON.parse(String(raw)); d.msgs.push(m); if (m.type === 'welcome') resolve(d) })
  ws.on('error', () => resolve(d))
})
dash.ws.send(J({ type: 'activity', ref: 'q1', query: { session: 'Orch' } }))
await until(async () => dash.msgs.some(m => m.type === 'activity' && m.ref === 'q1'), x => x, 3000)
const dq = dash.msgs.find(m => m.type === 'activity' && m.ref === 'q1')
check('dashboard: {type:"activity", query} → the mesh board (A\'s agent, tagged)', dq?.result?.ok === true && agentsOf(dq.result.sessions || [], 'Orch', 'research')[0]?.host === HA, J(dq))
// v1.61.0 (#70 step 5): pushes go only to a SUBSCRIBED dashboard — a full board, then deltas (test_activity_dashboard_live)
dash.ws.send(J({ type: 'activity_sub' }))
await until(async () => dash.msgs.some(m => m.type === 'activity_board'), x => x, 3000)
await call(A, 'log', { as: 'Orch', secret: 'or', agent: 'dash-probe', text: '@~root seen on a dashboard' })
const probeUnit = m => (m.upsert || []).find(u => u.kind === 'node' && u.path === 'dash-probe')
await until(async () => dash.msgs.some(m => m.type === 'activity_delta' && probeUnit(m)), x => x, 4000)
check('dashboard: a subscribed dashboard gets a delta after a remote change (the agent, tagged with its host)', dash.msgs.some(m => m.type === 'activity_board' && m.full)
  && dash.msgs.some(m => m.type === 'activity_delta' && probeUnit(m)?.host === HA), J(dash.msgs.filter(m => m.type.startsWith('activity_')).map(m => m.type)))
dash.ws.close()

// ---- 3. bare-session rule: a script may not report for a BARE session live under another user (same user: fine)
const bob = await logger('127.0.0.2', Number(A_PORT) + 1, { session: 'baref', project: 'aimb', user: 'bob' })
const rb = bob.welcome?.logger ? await bob.log({ text: 'speaking for BareF' }) : { ok: false, code: 'no-welcome' }
bob.close()
check('bare session: another user → session-user-mismatch', rb.ok === false && rb.code === 'session-user-mismatch', J(rb))
const alice = await logger('127.0.0.2', Number(A_PORT) + 1, { session: 'BareF', project: 'AIMB', user: 'Alice' })
const ral = alice.welcome?.logger ? await alice.log({ text: '@~root bare session reporting' }) : { ok: false, code: 'no-welcome' }
alice.close()
check('bare session: the same user (case-insensitive) → accepted', ral.ok === true, J(ral))

// ---- 4. rate: a 20/s log:false burst (3 agents) for 4 s → at most ONE frame per second on A→B
const pump = await logger('127.0.0.2', Number(A_PORT) + 1, { session: 'Pump', project: 'AIMB', user: 'robin' })
await pump.log({ agent: 'p1', text: '@~bar pumping {progress}', progress: '0/80' })
await sleep(1200)
const tStart = Date.now()
let n = 0
for (let i = 1; i <= 80; i++) { for (const ag of ['p1', 'p2', 'p3']) pump.send({ agent: ag, context: '@~bar', text: 'pumping {progress}', progress: `${i}/80`, log: false }); n += 3; await sleep(50) }
const tEnd = Date.now()
await sleep(1500)
const sentAB = (await tap(A)).sent.filter(x => x.peer === HB && ['full', 'delta', 'beat'].includes(x.kind) && x.ts >= tStart && x.ts <= tEnd + 1200)
const gaps = sentAB.slice(1).map((x, i) => x.ts - sentAB[i].ts)
const secs = (tEnd - tStart) / 1000
check(`rate: ${n} board updates in ${secs.toFixed(1)} s → ≤1 frame/s on the A→B link (${sentAB.length} frames)`, sentAB.length >= 2 && sentAB.length <= Math.ceil(secs) + 2, J(sentAB.map(x => [x.ts - tStart, x.kind, x.nodes.length])))
check('rate: consecutive frames on one link are ≥ ~1 s apart (coalesced)', gaps.every(g => g >= 900), J(gaps))
check('rate: ... carrying only what changed (≤ the 3 pumped agents + their @bar nodes per frame)', sentAB.every(x => x.nodes.length <= 6 && x.nodes.every(a => /^Pump\/p[123](\/@bar)?$/.test(a))), J(sentAB.map(x => x.nodes)))
const b4 = await until(() => board(B), b => ['p1', 'p2', 'p3'].every(p => agentsOf(b, 'Pump', `${p}/@bar`)[0]?.progress?.done === 80), 4000)
check('rate: B ends with the final bars (80/80 on all three)', ['p1', 'p2', 'p3'].every(p => agentsOf(b4, 'Pump', `${p}/@bar`)[0]?.progress?.done === 80), J(group(b4, 'Pump')))
pump.close()

// ---- 5. C (a 1500-byte cap) has 10 agents; then a LINK RESTART: B's gateway dies, F takes over → full slices
await call(C, 'register_self', { name: 'Tiler', secret: 'ti', project: 'AIMB' })
for (let i = 1; i <= 10; i++) { await call(C, 'log', { as: 'Tiler', secret: 'ti', agent: `c${String(i).padStart(2, '0')}`, text: `@~root tile batch ${i} ${'x'.repeat(150)}` }); await sleep(15) }
await until(() => board(B), b => (group(b, 'Tiler')?.nodes || []).length === 10, 15000, 250)
await hardKill(B); drop(B)
const fRole = await until(() => call(F, 'my_identity'), r => r.role === 'gateway', 10000, 200)
check('link restart: B\'s gateway is gone; F (same host) took over as gateway', fRole.role === 'gateway', J(fRole.role))
const bF = await until(() => board(F), b => (group(b, 'Tiler')?.nodes || []).length === 10 && agentsOf(b, 'Orch', 'research').length === 1 && agentsOf(b, 'Twin', 'worker').length === 2, 15000, 200)
check('link restart: the new gateway gets FULL slices — A\'s and C\'s agents are back on its board', (group(bF, 'Tiler')?.nodes || []).length === 10 && agentsOf(bF, 'Orch', 'research')[0]?.host === HA, J(bF.map(g => [g.session, g.hosts || g.host, (g.nodes || []).length])))
check('link restart: ... and host B\'s own Twin worker was replayed from B\'s files', agentsOf(bF, 'Twin', 'worker').some(x => x.host === HB && x.current?.text === 'twin on B'), J(group(bF, 'Twin')))
const tF = await tap(F)
const fromA = tF.recv.filter(x => x.peer === HA && ['full', 'delta', 'beat'].includes(x.kind)), fromC = tF.recv.filter(x => x.peer === HC && ['full', 'delta', 'beat'].includes(x.kind))
check('link restart: the first frame on each new link is a full slice', fromA[0]?.kind === 'full' && fromC[0]?.kind === 'full', J([fromA[0], fromC[0]]))
const firstC = fromC[0] || { nodes: [] }
const cNums = firstC.nodes.map(a => Number(a.split('/c')[1]))
check('truncation: C\'s full slice is over its 1500-byte cap → TRUNCATED, newest-active first', firstC.truncated === true && cNums.length >= 1 && cNums.length < 10 && J(cNums) === J([...cNums].sort((x, y) => y - x)) && cNums[0] === 10, J(firstC))
check('truncation: ... the rest followed in later frames (≥1 s apart) until all 10 were held', fromC.length >= 2 && fromC.slice(1).every((x, i) => x.ts - fromC[i].ts >= 900), J(fromC.map(x => [x.kind, x.nodes.length, x.truncated])))

// ---- 6. forged slices: another origin's name in the frame is refused; host fields inside never decide ownership
const fake = await rawPeer('127.0.0.1', B_PORT, 'FAKE-HOST/0001')
fake.write(frameOf({ t: 'ACTIVITY_SLICE', v: Act.ACTIVITY_FORMAT, origin: HA, epoch: 'f', seq: 1, full: true, sessions: [forgedSession('ForgedA', HA)] }))
await sleep(300)
fake.write(frameOf({ t: 'ACTIVITY_SLICE', v: Act.ACTIVITY_FORMAT, epoch: 'f', seq: 2, full: true, sessions: [forgedSession('ForgedB', HA)] }))
const b6 = await until(() => board(F), b => !!group(b, 'ForgedB'), 3000)
check('forged: a slice naming another origin (A) is dropped — nothing of it on the board', !group(b6, 'ForgedA') && !b6.some(g => (g.nodes || []).concat(g.self || []).some(e => e.current?.text === 'forged ForgedA')), J(b6.map(g => g.session)))
check('forged: a slice\'s own host fields are ignored — it is tagged with the LINK\'s host, never A', group(b6, 'ForgedB')?.host === 'FAKE-HOST' && group(b6, 'ForgedB')?.self?.host === 'FAKE-HOST', J(group(b6, 'ForgedB')))
check('forged: A\'s own entities are untouched', agentsOf(b6, 'Orch', 'research')[0]?.host === HA && agentsOf(b6, 'Orch', 'research')[0]?.current?.text === 'reading the spec')
fake.destroy()
const b6b = await until(() => board(F), b => group(b, 'ForgedB')?.self?.state === 'gone', 3000)
check('forged: when that link drops, its entities show gone', group(b6b, 'ForgedB')?.self?.state === 'gone', J(group(b6b, 'ForgedB')?.self))
// 6a: a peer that declares the 1.61 format (activity_gossip:1) — its v1 slices are SKIPPED (never misread), full or delta
const old161 = await rawPeer('127.0.0.1', B_PORT, 'OLD-HUB/0001', 1)
old161.write(frameOf({ t: 'ACTIVITY_SLICE', v: 1, origin: 'OLD-HUB', epoch: 'o', seq: 1, full: true, sessions: [v1Session('Old161')] }))
old161.write(frameOf({ t: 'ACTIVITY_SLICE', v: 1, origin: 'OLD-HUB', epoch: 'o', seq: 2, base: 1, sessions: [v1Session('Old161b')] }))
await sleep(1200)
const b6c = await board(F), tOld = await tap(F)
check('1.61 peer (6a): its v1 slices are skipped — nothing on the board, the frames tapped as skipped-format, no resync asked of it', !group(b6c, 'Old161') && !group(b6c, 'Old161b') && !J(b6c).includes('v1 Old161')
  && tOld.recv.filter(x => x.peer === 'OLD-HUB' && x.kind === 'skipped-format').length >= 2 && !tOld.sent.some(x => x.peer === 'OLD-HUB'), J(tOld.recv.filter(x => x.peer === 'OLD-HUB')))
old161.destroy()

// ---- 6a: a NESTED tree on A reaches F node by node; a deep change carries only the changed nodes; the remote subtree log
const deepPaths = ['@#70/@step4/spec-70', '@#70/@step4/spec-70/@Tharsis/@z12', '@#70/@step4/spec-70/research']
await call(A, 'log', { as: 'Orch', secret: 'or', path: '@#70/@step4/spec-70', text: '@~root agent under a task' })
await call(A, 'log', { as: 'Orch', secret: 'or', path: '@#70/@step4/spec-70/@Tharsis/@~z12', text: 'deep context', progress: '1/4 tiles' })
await call(A, 'log', { as: 'Orch', secret: 'or', path: '@#70/@step4/spec-70/research', text: '@~root a sub-agent' })
const bN = await until(() => board(F), b => deepPaths.every(p => agentsOf(b, 'Orch', p)[0]?.host === HA), 6000)
check('nested (6a): a depth-5 tree logged on A is on F\'s board node by node (kinds, implicit intermediates, A\'s host, rollup)', deepPaths.every(p => agentsOf(bN, 'Orch', p)[0]?.host === HA)
  && agentsOf(bN, 'Orch', '@#70')[0]?.implicit === true && agentsOf(bN, 'Orch', '@#70/@step4/spec-70/@Tharsis')[0]?.kind === 'context' && agentsOf(bN, 'Orch', '@#70')[0]?.progress?.done === 1, J((group(bN, 'Orch')?.nodes || []).map(n => n.path)))
const tN0 = Date.now()
await call(A, 'log', { as: 'Orch', secret: 'or', path: '@#70/@step4/spec-70/@Tharsis/@z12', progress: '3/4 tiles', log: false })
await until(() => board(F), b => agentsOf(b, 'Orch', '@#70/@step4/spec-70/@Tharsis/@z12')[0]?.progress?.done === 3, 5000)
const sentN = (await tap(A)).sent.filter(x => x.peer === HB && x.ts >= tN0 && x.kind === 'delta' && x.nodes.some(n => n.includes('@z12')))
check('nested (6a): a deep bar update travels as ONE delta carrying only the nodes on its chain up to its agent (not the whole tree)', sentN.length >= 1 && sentN[0].nodes.every(n => /^Orch\/@#70\/@step4\/spec-70(\/@Tharsis(\/@z12)?)?$/.test(n)) && sentN[0].nodes.length <= 3, J(sentN))
await sleep(1100)
const rsub = await call(F, 'activity', { log: { session: 'Orch', path: '@#70/@step4/spec-70', limit: 50 } })
check('nested (6a): the remote SUBTREE log of a nested agent is fetched from its owner (its contexts + sub-agent, rel paths)', rsub.ok && rsub.from_host === HA && rsub.log?.entries?.length === 3
  && J(rsub.log.entries.map(e => e.rel).sort()) === J(['', '@Tharsis/@z12', 'research']), J(rsub.log?.entries?.map(e => [e.rel, e.text])))
await sleep(1100)

// ---- 6b (v1.63.0): a PLAN on A reaches F — plan items with their states, plan position and the "N of M done" bar; a tick travels as a delta
await call(A, 'log', { as: 'Orch', secret: 'or', path: '@#76', plan: ['Spec', 'Build', 'Ship'] })
await call(A, 'log', { as: 'Orch', secret: 'or', path: '@#76/@~Spec', state: 'done' })
const pg = await until(() => board(F), b => agentsOf(b, 'Orch', '@#76/@Spec')[0]?.state === 'done' && !!agentsOf(b, 'Orch', '@#76/@Ship')[0], 6000)
const it = n => agentsOf(pg, 'Orch', `@#76/@${n}`)[0]
check('6b gossip: A\'s plan items are on F\'s board as plan items (plan_item, plan_ix, todo / done), A\'s host, with the plan bar "1 of 3 done"', ['Spec', 'Build', 'Ship'].every((n, i) => it(n)?.plan_item === true && it(n)?.plan_ix === i && it(n)?.host === HA)
  && it('Spec').state === 'done' && it('Build').state === 'todo' && (p => p && p.todos === true && p.done === 1 && p.total === 3)(agentsOf(pg, 'Orch', '@#76')[0]?.progress), J([it('Spec'), agentsOf(pg, 'Orch', '@#76')[0]]))
const t6b = Date.now()
await call(A, 'log', { as: 'Orch', secret: 'or', path: '@#76/@~Build', state: 'skipped' })
const pg2 = await until(() => board(F), b => agentsOf(b, 'Orch', '@#76/@Build')[0]?.state === 'skipped', 6000)
const sent6b = (await tap(A)).sent.filter(x => x.peer === HB && x.ts >= t6b && x.kind === 'delta' && x.nodes.some(n => n.includes('@#76/@Build')))
check('6b gossip: a tick (skipped) reaches F as ONE delta carrying the item (+ its chain), not the whole plan; the bar is now 1 of 3 · 1 skipped (#79: skipped stays in M)', agentsOf(pg2, 'Orch', '@#76/@Build')[0]?.state === 'skipped' && sent6b.length >= 1 && !sent6b[0].nodes.some(n => n.includes('@#76/@Ship'))
  && (p => p && p.done === 1 && p.total === 3 && p.skipped === 1)(agentsOf(pg2, 'Orch', '@#76')[0]?.progress), J([sent6b, agentsOf(pg2, 'Orch', '@#76')[0]?.progress]))
check('6b gossip: a remote plan item never shows stale on the receiver', (await call(F, 'activity', { session: 'Orch', path: '@#76' })).sessions?.[0]?.nodes?.filter(n => n.plan_item).every(n => !n.stale_at && n.state !== 'stale'))

// ---- 7. remote history: A's log paged (3 per page on A) across ≥3 pages, from F (host B's gateway now)
const ids7 = []
for (let i = 1; i <= 7; i++) ids7.push((await call(A, 'log', { as: 'Orch', secret: 'or', agent: 'pager', text: `@step page entry ${i}` })).id)
await until(() => board(F), b => agentsOf(b, 'Orch', 'pager').length === 1, 5000)
const pages = []
let cursor = null
for (let k = 0; k < 4; k++) {
  const r = await call(F, 'activity', { log: { session: 'Orch', agent: 'pager', limit: 50, ...(cursor ? { cursor } : {}) } })
  pages.push(r); cursor = r.log?.next_cursor
  if (!cursor) break
  await sleep(600)   // A serves 2 fetches per second per link
}
check('remote log: paged by the OWNER (3 per page) — 3 pages, newest first, chained by next_cursor', pages.length === 3 && pages.every(p => p.ok && p.from_host === HA && p.log?.host === HA)
  && J(pages.flatMap(p => p.log.entries.map(e => e.id))) === J([...ids7].reverse()) && pages[0].log.entries.length === 3 && pages[2].log.next_cursor === null, J(pages.map(p => [p.ok, p.code, p.log?.entries?.length, p.log?.next_cursor])))
check('remote log: entries are rendered + carry no details/data (fetched per entry only)', pages[0].log?.entries?.[0]?.text === 'page entry 7' && !('details' in (pages[0].log?.entries?.[0] || {})), J(pages[0].log?.entries?.[0]))
await sleep(1100)
// ---- 8. remote entry: details/data only on an explicit fetch
const le = await call(A, 'log', { as: 'Orch', secret: 'or', agent: 'pager', text: '@step with attachments', details: 'PAGER-DETAILS-TEXT', data: { rows: 42 } })
const cl = await call(A, 'log', { as: 'Orch', secret: 'or', agent: 'pager', text: '@~root current line', details: 'CURRENT-DETAILS', data: { cur: true } })
const b8 = await until(() => board(F), b => agentsOf(b, 'Orch', 'pager')[0]?.current?.text === 'current line', 5000)
check('gossip never carries details/data (only has_* flags)', !J(b8).includes('PAGER-DETAILS-TEXT') && !J(b8).includes('CURRENT-DETAILS') && agentsOf(b8, 'Orch', 'pager')[0]?.current?.has_details === true, J(agentsOf(b8, 'Orch', 'pager')[0]?.current))
const e1 = await call(F, 'activity', { entry: { id: le.id, host: HA } })
check('remote entry: entry:{id, host} fetches an older log entry\'s details + data from the owner', e1.ok && e1.from_host === HA && e1.entry?.details === 'PAGER-DETAILS-TEXT' && e1.entry?.data?.rows === 42 && e1.entry?.host === HA, J(e1))
await sleep(600)
const e2 = await call(F, 'activity', { entry: { id: cl.id } })
check('remote entry: a remote CURRENT line is found by id alone (it is in the gossiped slice)', e2.ok && e2.from_host === HA && e2.entry?.details === 'CURRENT-DETAILS' && e2.entry?.data?.cur === true, J(e2))
await sleep(1100)
// ---- 9. the fetch rate limit (A serves 2/s per link). v1.61.0 (#70 step 5): the requesting gateway QUEUES the burst at
// the owner's rate instead of answering rate-limited (the bounds + `busy` are in test_activity_dashboard_live)
const burst = await Promise.all(Array.from({ length: 8 }, () => call(F, 'activity', { log: { session: 'Orch', agent: 'pager', limit: 1 } })))
check('rate limit: a burst of 8 remote fetches → all answered (queued at the owner\'s 2/s, none rate-limited)', burst.every(r => r.ok) && burst.some(r => r.queued_ms > 0), J(burst.map(r => r.code || `ok${r.queued_ms ? '+' + r.queued_ms : ''}`)))
const amb = await call(F, 'activity', { log: { session: 'Twin' } })
check('remote log: a name on several hosts → ambiguous-session with each candidate\'s host', amb.ok === false && amb.code === 'ambiguous-session' && J((amb.candidates || []).map(c => c.host).sort()) === J([HA, HB]), J(amb))

// ---- 10. prepare-shutdown on A → its agents gone on B at once; cleared when A returns
const tDown = Date.now()
const ps = await post('127.0.0.2', Number(A_PORT) + 1, '/admin/prepare-shutdown', { Authorization: `Bearer ${TOKEN}` })
check('prepare-shutdown: 200 + the going-down notice went to the peer hub(s)', ps.status === 200 && ps.body?.down_notified >= 1, J(ps))
const b10 = await until(() => board(F), b => agentsOf(b, 'Orch', 'research')[0]?.state === 'gone', 3000, 50)
check('going down: B shows A\'s agents GONE immediately (before any link timeout), last line kept', agentsOf(b10, 'Orch', 'research')[0]?.state === 'gone' && Date.now() - tDown < 1500
  && agentsOf(b10, 'Orch', 'research')[0]?.current?.text === 'reading the spec' && agentsOf(b10, 'Twin', 'worker').find(x => x.host === HA)?.state === 'gone', `${Date.now() - tDown}ms ${J(agentsOf(b10, 'Orch', 'research')[0])}`)
check('going down: host B\'s own agents are not affected', agentsOf(b10, 'Twin', 'worker').find(x => x.host === HB)?.state === 'running')
await hardKill(A); drop(A)
A = await spawnA(); all.push(A)
const b10b = await until(() => board(F), b => agentsOf(b, 'Orch', 'research')[0] && agentsOf(b, 'Orch', 'research')[0].state !== 'gone', 15000, 200)
check('going down: when A returns (replayed from its files) its fresh slice clears gone', agentsOf(b10b, 'Orch', 'research')[0]?.state === 'running' && agentsOf(b10b, 'Orch', 'research')[0]?.current?.text === 'reading the spec', J(agentsOf(b10b, 'Orch', 'research')[0]))

// ---- 11. owner down: C killed → its agents gone on B; its history → owner-unreachable
await hardKill(C); drop(C)
const b11 = await until(() => board(F), b => agentsOf(b, 'Tiler', 'c01')[0]?.state === 'gone', 5000)
check('owner down: C\'s agents show gone, last-known lines kept', agentsOf(b11, 'Tiler', 'c01')[0]?.state === 'gone' && String(agentsOf(b11, 'Tiler', 'c01')[0]?.current?.text).startsWith('tile batch 1 '), J(agentsOf(b11, 'Tiler', 'c01')[0]))
const ou = await call(F, 'activity', { log: { session: 'Tiler', agent: 'c01' } })
check('owner down: a remote log read → owner-unreachable (with the host)', ou.ok === false && ou.code === 'owner-unreachable' && ou.host === HC, J(ou))
const hd = await call(F, 'activity')
check('owner down: remote_hosts shows C down and unlinked', (hd.remote_hosts || []).some(x => x.host === HC && x.down_at > 0 && x.linked === false), J(hd.remote_hosts))

// ---- 12. the legacy (≤1.59-like) hub D breaks nothing
await call(D, 'register_self', { name: 'OldTimer', secret: 'ot', project: 'AIMB' })
const ld = await call(D, 'log', { as: 'OldTimer', secret: 'ot', text: '@~root on the old hub' })
await sleep(1500)
const bD = await board(F), dB = await board(D), tF2 = await tap(F)
check('legacy hub: its own board works; its agents never reach the 1.60 board; no frames to it', ld.ok && !!group(dB, 'OldTimer') && !group(bD, 'OldTimer')
  && !tF2.sent.some(x => x.peer === HD) && !tF2.recv.some(x => x.peer === HD), J([ld, tF2.sent.filter(x => x.peer === HD).length]))
const sD = await call(F, 'list_sessions')
check('legacy hub: still federated (roster) with the 1.60 hubs', (sD.sessions || []).some(s => String(s.session).startsWith(HD + '/')))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(400)
for (const d of [...Object.values(dirs), cfgDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
process.exit(fail ? 1 : 0)
