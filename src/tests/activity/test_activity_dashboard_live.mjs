// #70 step 5 (v1.61.0) — the dashboard side of the activity board, PORTED to the 2.0 board in #88 build step 9: the
// dashboard's `activity` REQUEST on its WS (the board, a node's log page, by node id or 2.0 path), read access (page leaves
// refused), history paging into the DAY FILES through the index (local and remote, owner-paged; "show earlier runs"), QUEUED
// remote fetches (+ the `busy` bound), host down (gossip v6: the session's down_at, its agents gone), the duplicate-hostname
// warning. Loopback "hosts", each a GATEWAY with its own host name:
//   B  127.0.0.1:14202 "DASH-B"  the observer: the WS dashboards connect here; persist dir B; ≤12 fetches per dashboard
//   A  127.0.0.2:14200 "DASH-A"  persist dir A; owner side: 8 entries per remote page, 2 fetches/s per link
//   C  127.0.0.3:14220 "DASH-C"  killed mid-test (host down)
//   E  127.0.0.4:14240 "DASH-A"  (!) a second hub with A's host name → B logs the duplicate-hostname warning
// Every host keeps log_entries_per_agent = 10 (a page never exceeds it), so a 30–40 entry history takes several pages.
// Ports 14200–14299 (this file's port block).
// RETIRED in step 9 (each named where it stood): paging on into a SEEDED older day file and the skipped 1.61-format line in
// it (a 2.0 gateway refuses v5 history; the earlier run is made live instead, by a dismissal and a re-create of the same key
// — §3.7).
// RESTORED in step 10 (the board PUSHES on the 2.0 units, lib/activity2-dash.js — docs/spec-88.md §5.4): activity_sub's
// FULL board (+ the 2.0 head: format 6, view_user; the type registry), units BY NODE ID (a node's unit names the owner's
// node id, parent_id, the RAW state — no rendered / stale_at), #79's client_kind on the session unit, deltas (≤ 1 per
// second, chained, only what changed; the folded view = a fresh full board), the seq-gap resync, nested + plan-item deltas,
// a RENAME and a MOVE keeping every unit id (no remove), the page leaf getting no pushes, activity_unsub.
// RESTORED in step 10 (spec Q72, on the `activity` read rows): 8. a session that LEFT (deregistered) shows its agents gone
// + the session's gone_at — on B's board and its owner's, no down_at — and is cleared when it registers again; 9. the
// doorbell bell on the (remote and owner's) board, cleared after the re-arm grace (A: 500 ms), and a local doorbell.
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 14200)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const TOKEN = 'actdashtesttok'
const A_PORT = String(tp(14200)), B_PORT = String(tp(14202)), C_PORT = String(tp(14220)), E_PORT = String(tp(14240))
const HA = 'DASH-A', HB = 'DASH-B', HC = 'DASH-C'
const dirs = { A: fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-adA-')), B: fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-adB-')) }
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-adcfg-'))
const cfgFile = path.join(cfgDir, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_entries_per_agent: 10 } }))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify

const errs = {}
function spawn(name, bind, port, host, extra = {}) {
  const env = { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
    AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
    AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}`, AI_BRIDGE_DISCOVERY_MS: '300',
    AI_BRIDGE_TEST_GOSSIP: '', TEMP: cfgDir, TMP: cfgDir, ...extra }
  delete env.AI_BRIDGE_TRAY
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR, env, stderr: 'pipe' })
  errs[name] = ''
  transport.stderr.on('data', d => { errs[name] += String(d) })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport, name }))
}
const fileOf = d => ({ AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: d })
const call = async (b, n, a = {}) => { try { return JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 100) {
  const t0 = Date.now(); let r
  do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms)
  return r
}
async function hardKill(h) {
  const pid = h.transport.pid
  try { process.kill(pid, 'SIGKILL') } catch { }
  for (let i = 0; i < 60; i++) { try { process.kill(pid, 0) } catch { break } await sleep(100) }
  try { await h.transport.close() } catch { }
}
// a `logger` WS leaf (tools/aimb-log.mjs's protocol)
function logger(host, wsPort, ident) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${host}:${wsPort}`)
    const res = new Map(), L = { ws, res, welcome: null, n: 0 }
    L.send = input => { const ref = ++L.n; ws.send(J({ type: 'log', ref, input })); return ref }
    L.log = async input => { const ref = L.send(input); for (let i = 0; i < 100 && !res.has(ref); i++) await sleep(30); return res.get(ref) || { ok: false, code: 'no-answer' } }
    L.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => ws.send(J({ type: 'hello', kind: 'logger', token: TOKEN, ident })))
    ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.type === 'welcome' || m.type === 'error') { L.welcome = m; resolve(L) } else if (m.type === 'logged') res.set(m.ref, m.result) })
    ws.on('error', () => resolve(L))
  })
}
// a WS client: a dashboard (or a page / listener leaf); reads and actions by ref
function wsClient(port, hello, host = '127.0.0.1') {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${host}:${port}`)
    const d = { ws, msgs: [], refs: new Map(), acts: new Map(), queued: new Map(), n: 0 }
    d.send = o => ws.send(J(o))
    d.req = async (query, ms = 15000) => { const ref = 'r' + (++d.n); d.send({ type: 'activity', ref, query }); for (let t = 0; t < ms && !d.refs.has(ref); t += 25) await sleep(25); return d.refs.get(ref) || { ok: false, code: 'no-answer' } }
    d.fire = query => { const ref = 'r' + (++d.n); d.send({ type: 'activity', ref, query }); return ref }
    d.act = async (q, ms = 10000) => { const ref = 'a' + (++d.n); d.send({ type: 'activity_action', ref, ...q }); for (let t = 0; t < ms && !d.acts.has(ref); t += 25) await sleep(25); return d.acts.get(ref) || { ok: false, code: 'no-answer' } }
    d.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => ws.send(J({ type: 'hello', token: TOKEN, ...hello })))
    ws.on('message', raw => {
      const m = JSON.parse(String(raw)); m._t = Date.now(); d.msgs.push(m)
      if (m.type === 'welcome' || (m.type === 'error' && !d.welcome)) { d.welcome = m; resolve(d) }
      if (m.type === 'activity') d.refs.set(m.ref, m.result)
      if (m.type === 'activity_action') d.acts.set(m.ref, m.result)
      if (m.type === 'activity_queued') d.queued.set(m.ref, m)
    })
    ws.on('error', () => resolve(d))
  })
}
const dashOn = (port, inst) => wsClient(port, { kind: 'dashboard', instance: inst })
// the dashboard's board: the `activity` read on its WS, and (step 10) the PUSHES folded into a store as the page does
const sessOf = (b, name, host) => ((b && b.sessions) || []).find(s => String(s.session).toLowerCase() === name.toLowerCase() && (!host || s.host === host))
const nodeAt = (s, p) => ((s && s.nodes) || []).find(n => n.path === p)
const retired = (what, why) => console.log(`SKIP ${what} (retired in #88 step 9: ${why})`)
// the page's delta store (dashboard.html AimbAct.applyMsg, same rules): a full board replaces; a delta needs base === seq
function applyMsg(st, m) {
  if (m.type === 'activity_board') { if (m.ok === false) { st.error = m; return 'error' } st.units = {}; st.epoch = m.epoch; st.seq = m.seq; for (const u of m.upsert || []) st.units[u.id] = u; return 'full' }
  if (m.type === 'activity_delta') {
    if (!st.units || m.epoch !== st.epoch || m.base !== st.seq) return 'resync'
    for (const id of m.remove || []) delete st.units[id]
    for (const u of m.upsert || []) st.units[u.id] = u
    st.seq = m.seq; return 'delta'
  }
  return null
}
const canon = st => J(Object.keys(st.units || {}).sort().map(k => st.units[k]))
// a SUBSCRIBED dashboard: its pushes folded into d.store (d.drop = lose that many deltas; a gap → resync, as the page)
function subscribe(d) {
  d.store = { units: null, seq: 0, epoch: null }; d.drop = 0; d.dropped = []; d.resyncs = 0
  d.boards = () => d.msgs.filter(m => m.type === 'activity_board' || m.type === 'activity_delta')
  d.ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.type !== 'activity_board' && m.type !== 'activity_delta') return
    if (m.type === 'activity_delta' && d.drop > 0) { d.drop--; d.dropped.push(m); return }
    if (applyMsg(d.store, m) === 'resync') { d.resyncs++; d.send({ type: 'activity_sub', resync: true }) } })
  d.send({ type: 'activity_sub' })
  return d
}
const units = d => Object.values((d.store && d.store.units) || {})
const grp = (d, name) => units(d).find(u => u.kind === 'session' && String(u.session).toLowerCase() === name.toLowerCase())
const agt = (d, name, p, host) => units(d).find(u => u.kind === 'node' && grp(d, name) && u.group === grp(d, name).key && u.path === p && (!host || u.host === host))

const all = []
const drop = h => { const i = all.indexOf(h); if (i >= 0) all.splice(i, 1) }
process.on('uncaughtException', async e => {   // never leave a bridge behind (e.g. the pre-change run)
  fail++; console.log('FAIL the test crashed:', e && e.stack)
  for (const b of all) { try { await b.transport.close() } catch { } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(1)
})
const closers = []
try {
  // ---- the mesh
  const B = await spawn('HubB', '127.0.0.1', B_PORT, HB, { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT},127.0.0.3:${C_PORT},127.0.0.4:${E_PORT}`, AI_BRIDGE_ACTIVITY_QUEUE_DASH: '12' }); all.push(B)
  await sleep(500)
  const A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_ACTIVITY_PAGE_ENTRIES: '8', AI_BRIDGE_ACTIVITY_FETCH_RATE: '2', AI_BRIDGE_ACTIVITY_BELL_GRACE_MS: '500' }); all.push(A)
  const C = await spawn('HubC', '127.0.0.3', C_PORT, HC); all.push(C)
  const ids = await Promise.all([A, B, C].map(h => call(h, 'my_identity')))
  check('harness: A, B, C are gateways (2.0 boards)', ids.every(i => i.role === 'gateway'), J(ids.map(i => [i.role, i.bridge_version])))
  const linked = await until(() => call(B, 'list_sessions'), r => [HA, HC].every(h => (r.sessions || []).some(s => String(s.session).startsWith(h + '/'))), 10000)
  check('harness: A and C linked to B', [HA, HC].every(h => (linked.sessions || []).some(s => String(s.session).startsWith(h + '/'))))
  const WSB = Number(B_PORT) + 1, WSA = Number(A_PORT) + 1

  // ---- seed: agents on A (via a script) and on B
  const la = await logger('127.0.0.2', WSA, { session: 'Orch', project: 'AIMB', user: 'robin' }); closers.push(la)
  const s1 = await la.log({ agent: 'research', label: 'Research', text: '@reading the spec', progress: '1/4 docs' })
  const lb = await logger('127.0.0.1', WSB, { session: 'Local', project: 'Tools', user: 'robin' }); closers.push(lb)
  const s2 = await lb.log({ agent: 'builder', label: 'Builder', text: '@compiling', progress: '2/10 files' })
  check('harness: the scripts\' reports (2.0 forms) applied on A and B', s1.ok && s2.ok, J([s1, s2]))

  // ---- 1. the dashboard's board: the PUSHES (step 10: units by node id) and the `activity` read
  const d0 = await dashOn(WSB, 'dash-idle'); closers.push(d0)
  const d1 = subscribe(await dashOn(WSB, 'dash-sub')); closers.push(d1)
  await until(async () => d1.store.units && agt(d1, 'Orch', 'Research'), x => !!x, 6000, 50)
  const full1 = d1.msgs.find(m => m.type === 'activity_board')
  check('subscribe: a FULL board first (full, epoch, seq 1, head with the stale default, this host, format 6, whose view; the type registry)', !!full1 && full1.full === true && full1.seq === 1 && !!full1.epoch && full1.head?.stale_after_min === 15 && full1.head?.host === HB && full1.head?.format === 6
    && typeof full1.head?.view_user === 'string' && !!full1.types?.plan?.menu?.complete, J(full1 && { ...full1, upsert: (full1.upsert || []).length, types: Object.keys(full1.types || {}) }))
  const ru = agt(d1, 'Orch', 'Research', HA)
  check('subscribe: the full board holds the mesh — A\'s agent (tagged A, the OWNER\'s node id) and B\'s, as units; the session unit carries A\'s root', !!ru && ru.node_id === s1.node?.id && ru.id === J(['n', grp(d1, 'Orch').key, HA.toLowerCase(), s1.node?.id]) && ru.parent_id === grp(d1, 'Orch').self?.node_id
    && agt(d1, 'Local', 'Builder')?.host === HB && grp(d1, 'Orch')?.kind === 'session' && grp(d1, 'Orch')?.host === HA, J(units(d1).map(u => [u.kind, u.session || u.path, u.host, u.node_id])))
  check('subscribe: units are RAW — the reported state, the line\'s template, no rendered / stale_at; the type and its menu (no clock in it)', ru?.state === 'running' && ru?.current?.text === 'reading the spec' && !('rendered' in (ru?.current || {})) && !('stale_at' in (ru || {})) && ru?.last_activity > 0
    && ru?.type === 'agent' && Array.isArray(ru?.menu) && ru.menu.includes('finish|quiet') && ru?.bar?.done === 1, J(ru))
  // #79: the session unit carries client_kind from the MESH ROSTER: Orch registers on A as a claude-code sub-peer → "code"
  const kreg = await call(A, 'register_self', { name: 'Orch', secret: 'k79', project: 'AIMB', user: 'robin', client: 'claude-code' })
  const gk = await until(async () => grp(d1, 'Orch'), g => g && g.client_kind === 'code', 8000)
  check('#79 client_kind: a session unit takes its client kind from the mesh roster (Orch on A as claude-code → "code" on B\'s dashboard); a script-only session has none', kreg.ok && gk?.client_kind === 'code' && !('client_kind' in (grp(d1, 'Local') || {})), J([kreg.ok, gk && { ...gk, self: undefined }, grp(d1, 'Local')?.client_kind]))
  // ---- 1b. a burst → deltas only, ≤1 per second, each carrying only what changed
  const pump = await logger('127.0.0.1', WSB, { session: 'Pump', project: 'Tools', user: 'robin' }); closers.push(pump)
  for (const ag of ['p1', 'p2', 'p3']) await pump.log({ agent: ag, label: ag.toUpperCase(), text: '@pumping {progress}', progress: '0/60' })
  await sleep(1500)
  const mark = d1.msgs.length, tStart = Date.now()
  for (let i = 1; i <= 60; i++) { for (const ag of ['p1', 'p2', 'p3']) pump.send({ agent: ag, progress: `${i}/60`, log: false }); await sleep(50) }
  const tEnd = Date.now()
  await sleep(1600)
  const burst = d1.msgs.slice(mark).filter(m => m.type === 'activity_board' || m.type === 'activity_delta')
  const deltas = burst.filter(m => m.type === 'activity_delta'), gaps = deltas.slice(1).map((m, i) => m._t - deltas[i]._t), secs = (tEnd - tStart) / 1000
  check(`deltas: 180 updates in ${secs.toFixed(1)} s → only DELTAS (no full board) to the subscriber`, deltas.length >= 2 && burst.every(m => m.type === 'activity_delta'), J(burst.map(m => m.type)))
  check(`deltas: at most one per second (${deltas.length} in ${secs.toFixed(1)} s, gaps ≥ ~1 s)`, deltas.length <= Math.ceil(secs) + 2 && gaps.every(g => g >= 900), J(gaps))
  check('deltas: chained — each base is the previous seq', deltas.every((m, i) => i === 0 || m.base === deltas[i - 1].seq) && deltas.every(m => m.seq === m.base + 1), J(deltas.map(m => [m.base, m.seq])))
  check('deltas: carry only what changed (the pumped agents + their session, never the whole board)', deltas.every(m => (m.upsert || []).length <= 4 && (m.upsert || []).every(u => (u.kind === 'node' && /^P[123]$/.test(u.path)) || (u.kind === 'session' && u.session === 'Pump'))), J(deltas.map(m => (m.upsert || []).map(u => u.path || u.session))))
  check('no subscription → no pushes: the idle dashboard got no activity_board / activity_delta', !d0.msgs.some(m => m.type === 'activity_board' || m.type === 'activity_delta'), J(d0.msgs.map(m => m.type)))
  const d2 = subscribe(await dashOn(WSB, 'dash-truth'))
  await until(async () => d2.store.units, x => !!x, 4000)
  check('deltas: the subscriber\'s folded view equals a fresh full board', canon(d1.store) === canon(d2.store) && agt(d1, 'Pump', 'P3')?.progress?.done === 60, `${canon(d1.store).length} vs ${canon(d2.store).length}`)
  d2.close()
  // ---- 1c. seq gap → resync
  const nFull = d1.msgs.filter(m => m.type === 'activity_board').length
  d1.drop = 1
  await la.log({ agent: 'gap1', label: 'Gap 1', text: '@first change (its delta is lost)' })
  await until(async () => d1.dropped.length, x => x > 0, 4000)
  await sleep(1100)
  await la.log({ agent: 'gap2', label: 'Gap 2', text: '@second change' })
  await until(async () => d1.msgs.filter(m => m.type === 'activity_board').length > nFull && agt(d1, 'Orch', 'Gap 2'), x => !!x, 5000)
  check('resync: the delta after a lost one does not follow → the page asks again and gets a FULL board', d1.resyncs >= 1 && d1.msgs.filter(m => m.type === 'activity_board').length > nFull, J({ resyncs: d1.resyncs, fulls: d1.msgs.filter(m => m.type === 'activity_board').length }))
  check('resync: the view is whole again (the lost change is there)', !!agt(d1, 'Orch', 'Gap 1') && !!agt(d1, 'Orch', 'Gap 2'), J(units(d1).filter(u => u.kind === 'node').map(u => u.path)))
  // ---- 1d. NESTED units by id, a plan's items, and a rename / move that keep every id
  await la.log({ key: 'p70', label: '#70', plan: [{ key: 'spec', label: 'Spec' }, { key: 'build', label: 'Build' }, { key: 'ship', label: 'Ship' }] })
  await la.log({ agent: 'w70', label: 'W70', under: 'build', text: '@deep line {progress}', progress: '1/4 tiles' })
  await until(async () => agt(d1, 'Orch', '#70/Build/W70'), x => !!x, 5000)
  const w70 = agt(d1, 'Orch', '#70/Build/W70'), b70 = agt(d1, 'Orch', '#70/Build'), p70 = agt(d1, 'Orch', '#70')
  check('nested units: node_id / parent_id link the tree by id (no path keys); depth; plan items with plan_ix; the plan\'s "N of M" bar', w70?.parent_id === b70?.node_id && b70?.parent_id === p70?.node_id && p70?.parent_id === grp(d1, 'Orch').self.node_id && w70?.depth === 3
    && ['Spec', 'Build', 'Ship'].every((n, i) => agt(d1, 'Orch', `#70/${n}`)?.plan_item === true && agt(d1, 'Orch', `#70/${n}`)?.plan_ix === i) && p70?.bar?.items && p70?.bar?.total === 3, J([w70, b70, p70].map(u => u && [u.node_id, u.parent_id, u.depth, u.path])))
  await sleep(1200)
  const mark3 = d1.msgs.length
  await la.log({ key: 'spec', state: 'done' })
  await until(async () => agt(d1, 'Orch', '#70/Spec')?.state === 'done', x => x, 5000)
  await sleep(300)
  const d6b = d1.msgs.slice(mark3).filter(m => m.type === 'activity_delta')
  check('plan-item deltas: the tick arrives as a delta carrying the item and the plan node whose bar moved — not the untouched items', d6b.some(m => (m.upsert || []).some(u => u.path === '#70/Spec' && u.state === 'done')) && d6b.some(m => (m.upsert || []).some(u => u.path === '#70' && u.bar?.done === 1))
    && !d6b.some(m => (m.upsert || []).some(u => u.path === '#70/Ship')), J(d6b.map(m => (m.upsert || []).map(u => u.path || u.session))))
  const ids1 = new Set(units(d1).map(u => u.id)), mark4 = d1.msgs.length
  const ren = await d1.act({ host: HA, session: 'Orch', project: 'AIMB', user: 'robin', id: p70.node_id, action: 'rename', args: { label: '#70 renamed' } })
  await until(async () => agt(d1, 'Orch', '#70 renamed/Build/W70'), x => !!x, 6000)
  const rmv = d1.msgs.slice(mark4).filter(m => m.type === 'activity_delta').flatMap(m => m.remove || [])
  check('a RENAME from the dashboard (by id, on A through B): every unit keeps its id — no remove; the label and the descendants\' paths follow', ren.ok && !rmv.length && agt(d1, 'Orch', '#70 renamed')?.id === p70.id && agt(d1, 'Orch', '#70 renamed/Build/W70')?.id === w70.id && [...ids1].every(id => units(d1).some(u => u.id === id)), J([ren, rmv]))
  const mv = await d1.act({ host: HA, session: 'Orch', project: 'AIMB', user: 'robin', id: w70.node_id, action: 'move', args: { to_id: agt(d1, 'Orch', '#70 renamed/Ship').node_id } })
  await until(async () => agt(d1, 'Orch', '#70 renamed/Ship/W70'), x => !!x, 6000)
  check('a MOVE (by id): the same unit id, a new parent_id', mv.ok && agt(d1, 'Orch', '#70 renamed/Ship/W70')?.id === w70.id && agt(d1, 'Orch', '#70 renamed/Ship/W70')?.parent_id === agt(d1, 'Orch', '#70 renamed/Ship')?.node_id, J(mv))
  const d3 = subscribe(await dashOn(WSB, 'dash-truth2'))
  await until(async () => d3.store.units, x => !!x, 4000)
  await sleep(1200)
  check('nested deltas: the folded view equals a fresh full board', canon(d1.store) === canon(d3.store), `${canon(d1.store).length} vs ${canon(d3.store).length}`)
  d3.close()
  const bd1 = await until(() => d1.req({}), r => !!nodeAt(sessOf(r, 'Orch', HA), 'Research'), 6000, 150)
  check('board read: the head (ok, format 6, the stale default, this host)', bd1.ok === true && bd1.format === 6 && bd1.stale_after_min === 15 && bd1.host === HB, J({ ...bd1, sessions: (bd1.sessions || []).length }))
  check('board read: it holds the mesh — A\'s agent (its session tagged A, remote) and B\'s own', nodeAt(sessOf(bd1, 'Orch', HA), 'Research')?.kind === 'agent' && sessOf(bd1, 'Orch', HA)?.remote === true && !!nodeAt(sessOf(bd1, 'Local', HB), 'Builder') && !sessOf(bd1, 'Local', HB)?.remote,
    J((bd1.sessions || []).map(s => [s.session, s.host, s.remote, (s.nodes || []).map(n => n.path)])))
  const rs = nodeAt(sessOf(bd1, 'Orch', HA), 'Research')
  check('board read: a remote row carries the reported state, the line and the progress (and the owner\'s node id)', rs?.state === 'running' && rs?.current?.text === 'reading the spec' && rs?.progress?.done === 1 && rs?.progress?.total === 4 && rs?.id === s1.node?.id && rs?.last_activity > 0, J(rs))

  // ---- 4. read access: a page leaf gets neither pushes nor reads
  const pg = await wsClient(WSB, { kind: 'page', page_kind: 'probe', title: 'Probe page', instance: 'probe-pg' })
  const pr = await pg.req({ session: 'Orch' }, 3000)
  check('page leaf: an activity read is REFUSED (dashboard-only), not answered', pr.ok === false && pr.code === 'dashboard-only', J(pr))
  pg.send({ type: 'activity_sub' })
  await sleep(300)
  const pgSub = pg.msgs.find(m => m.type === 'activity_board')
  check('page leaf: activity_sub is refused too (dashboard-only; no board in the answer)', !!pgSub && pgSub.ok === false && pgSub.code === 'dashboard-only' && !pgSub.upsert, J(pgSub))
  pg.send({ type: 'hello', token: TOKEN, kind: 'dashboard', instance: 'probe-pg-2' })
  await sleep(200)
  const pr2 = await pg.req({ session: 'Orch' }, 3000)
  check('page leaf: a second hello cannot turn it into a dashboard (already-hello; still refused)', pg.msgs.some(m => m.type === 'error' && m.code === 'already-hello') && pr2.code === 'dashboard-only', J([pg.msgs.filter(m => m.type === 'error'), pr2]))
  check('page leaf: no board pushes reach it', !pg.msgs.some(m => (m.type === 'activity_board' && m.ok !== false) || m.type === 'activity_delta'), J(pg.msgs.map(m => m.type)))
  pg.close()

  // ---- 5. history paging into the DAY FILES — local (B), ≥3 pages, the run boundary, then "show earlier runs"
  const pl = await logger('127.0.0.1', WSB, { session: 'PagerB', project: 'Tools', user: 'robin' }); closers.push(pl)
  // run 1 of Deep (and its Step): 5 entries, finished, then DISMISSED from the dashboard (the nodes become ghosts)
  const run1 = []
  const r1a = await pl.log({ agent: 'deep', label: 'Deep', text: '@first run', state: 'running' }); run1.push(r1a)
  for (let i = 1; i <= 5; i++) run1.push(await pl.log({ agent: 'deep', key: 'step', label: 'Step', text: `old entry ${i}` }))
  run1.push(await pl.log({ agent: 'deep', text: '@first run done', state: 'done' }))
  const deepId1 = r1a.node?.id, stepId1 = run1[1].node?.id
  const dis = await d1.act({ host: HB, session: 'PagerB', project: 'Tools', user: 'robin', id: deepId1, action: 'dismiss' })
  // run 2: the same keys again → the SAME ids, a NEW run (§3.7); 40 entries on Deep/Step
  const run2 = []
  const r2a = await pl.log({ agent: 'deep', label: 'Deep', text: '@second run', state: 'running' }); run2.push(r2a)
  for (let i = 1; i <= 40; i++) run2.push(await pl.log({ agent: 'deep', key: 'step', label: 'Step', text: `b entry ${i}` }))
  check('harness (paging): run 1 logged, finished and dismissed; the same keys again → the SAME node ids (a new run)', run1.every(r => r.ok) && dis.ok === true && run2.every(r => r.ok) && r2a.node?.id === deepId1 && run2[1].node?.id === stepId1 && run2[1].node?.path === 'Deep/Step',
    J([run1.map(r => r.code), dis, run2.filter(r => !r.ok).map(r => r.code), r2a.node, run2[1].node]))
  const idsB = run2.map(r => r.id), oldIds = run1.map(r => r.id)
  const pagesB = []
  let cur = null, earlier = false, boundaryAt = null
  for (let k = 0; k < 12; k++) {
    const r = await d1.req({ log: { session: 'PagerB', path: 'Deep', limit: 12, ...(cur ? { cursor: cur } : {}), ...(earlier ? { earlier: true } : {}) } })
    pagesB.push(r); cur = r.log?.next_cursor
    // the pages stop at the start of the CURRENT run (run_start + earlier_cursor), then "show earlier runs" = that cursor with earlier:true
    if (!cur && !earlier && r.log?.run_start && r.log?.earlier_cursor) { boundaryAt = pagesB.length; cur = r.log.earlier_cursor; earlier = true }
    if (!cur || r.ok === false) break
  }
  const gotB = pagesB.flatMap(p => (p.log?.entries || []).map(e => e.id))
  const wantB = [...idsB].reverse().concat([...oldIds].reverse())
  check(`local paging: ${pagesB.length} pages (≥3) chained by next_cursor, newest first, through the files to the CURRENT run's start (run_start + earlier_cursor at page ${boundaryAt}), then — earlier:true — on into the earlier run`,
    pagesB.length >= 3 && pagesB.every(p => p.ok) && J(gotB) === J(wantB) && pagesB[pagesB.length - 1]?.log?.next_cursor === null
    && boundaryAt !== null && J(pagesB.slice(0, boundaryAt).flatMap(p => (p.log?.entries || []).map(e => e.id))) === J([...idsB].reverse()),
    J([pagesB.map(p => [p.ok, p.code, p.log?.entries?.length, p.log?.from_files, p.log?.next_cursor, p.log?.run_start, p.log?.earlier_cursor]), gotB.length, wantB.length]))
  check('local paging: page 1 = 10 (a page never exceeds log_entries_per_agent), read from the day file through the index (from_files 10, a file cursor f2.)', pagesB[0]?.log?.entries?.length === 10 && pagesB[0]?.log?.from_files === 10
    && /^f2\./.test(pagesB[0]?.log?.next_cursor || '') && pagesB[1]?.log?.from_files === 10 && /^f2\./.test(pagesB[1]?.log?.next_cursor || ''), J(pagesB.slice(0, 2).map(p => [p.log?.entries?.length, p.log?.from_files, p.log?.next_cursor])))
  check('local paging: file entries keep the in-memory shape (rendered, node_id, at, path + rel, state; no details/data)', (pagesB[1]?.log?.entries || []).length > 0 && pagesB[1].log.entries.every(e => e.rendered && e.node_id === stepId1 && e.at === 'Deep/Step' && e.path === 'Deep/Step' && e.rel === 'Step' && !!e.state && !('details' in e) && !('data' in e)), J(pagesB[1]?.log?.entries?.[0]))
  retired('local paging: on into a SEEDED older day file; its 1.61-format (v1) line skipped', 'a 2.0 gateway refuses v5 history (exit 78); the earlier run above is made live instead')
  const ownPage = await d1.req({ log: { session: 'PagerB', path: 'Deep', own: true, limit: 12 } })
  check('local paging: a node\'s OWN-only view applies in the files too (Deep\'s own current-run entry only — none of Step\'s; no cursor)', ownPage.ok && J((ownPage.log?.entries || []).map(e => e.id)) === J([r2a.id]) && ownPage.log?.next_cursor === null, J(ownPage.log))
  const nestPage = await d1.req({ log: { session: 'PagerB', path: 'Deep/Step', limit: 12, cursor: pagesB[1]?.log?.next_cursor } })
  check('local paging: the nested context\'s own subtree pages on into the files with a file cursor', nestPage.ok && (nestPage.log?.entries || []).length > 0 && nestPage.log.entries.every(e => e.path === 'Deep/Step' && e.rel === '') && idsB.includes(nestPage.log.entries[0].id), J(nestPage.log && [nestPage.code, nestPage.log.entries.length]))

  // ---- 6. remote paging: A's history through B, owner-paged (8 per page) through A's day files
  const pa = await logger('127.0.0.2', WSA, { session: 'PagerA', project: 'AIMB', user: 'robin' }); closers.push(pa)
  const n70 = await pa.log({ key: 'n70', label: '#70', text: '@issue 70' })
  const idsA = []
  const pd = await pa.log({ agent: 'deep', label: 'Deep', under: 'n70', text: '@deep work', state: 'running' }); idsA.push(pd.id)
  for (let i = 1; i <= 30; i++) idsA.push((await pa.log({ agent: 'deep', key: 'step', label: 'Step', text: `a entry ${i}` })).id)   // a NESTED node on the remote host
  const onB = await until(() => d1.req({ session: 'PagerA' }), r => !!nodeAt(sessOf(r, 'PagerA', HA), '#70/Deep/Step'), 6000, 150)
  const deepA = nodeAt(sessOf(onB, 'PagerA', HA), '#70/Deep')
  check('harness (remote paging): A\'s nested Deep (#70/Deep/Step) is on B\'s board by its owner\'s id', n70.ok && pd.ok && deepA?.id === pd.node?.id, J([n70.code, pd.code, pd.node, sessOf(onB, 'PagerA', HA)?.nodes?.map(n => n.path)]))
  const pagesA = []
  cur = null
  for (let k = 0; k < 10; k++) {
    const r = await d1.req({ log: { session: 'PagerA', path: '#70/Deep', ...(cur ? { cursor: cur } : {}) } })
    pagesA.push(r); cur = r.log?.next_cursor
    if (!cur || r.ok === false) break
  }
  const gotA = pagesA.flatMap(p => (p.log?.entries || []).map(e => e.id))
  check(`remote paging: ${pagesA.length} pages (≥3) of A's NESTED subtree (#70/Deep) through B, newest first, from A's files`, pagesA.length >= 3 && pagesA.every(p => p.ok && p.from_host === HA) && J(gotA) === J([...idsA].reverse()),
    J(pagesA.map(p => [p.ok, p.code, p.log?.entries?.length, p.log?.from_files])))
  check('remote paging: the owner\'s page size holds (≤8) and the pages come from its files', pagesA.every(p => (p.log?.entries || []).length <= 8) && pagesA[0]?.log?.entries?.length === 8 && pagesA.some(p => p.log?.from_files > 0), J(pagesA.map(p => p.log?.from_files)))
  const byId = await d1.req({ log: { session: 'PagerA', id: deepA?.id, limit: 3 } })
  check('remote paging: the same subtree BY NODE ID (the 2.0 form) — the owner serves it', byId.ok && byId.from_host === HA && J((byId.log?.entries || []).map(e => e.id)) === J([...idsA].reverse().slice(0, 3)), J([byId.code, byId.log?.entries?.map(e => e.id)]))
  await sleep(2500)   // A's bucket (2/s) refills

  // ---- 7. queued remote fetches: a burst the owner would answer `rate-limited` all succeed (B paces them)
  const rq = { log: { session: 'Orch', path: 'Research', limit: 1 } }
  const refs = Array.from({ length: 10 }, () => d1.fire(rq))
  const res = await until(async () => refs.map(r => d1.refs.get(r)), rs => rs.every(Boolean), 15000, 50)
  check('queue: a burst of 10 remote fetches (owner serves 2/s) → all answered ok, none rate-limited', res.every(r => r && r.ok === true && r.from_host === HA), J(res.map(r => r ? r.code || 'ok' : 'none')))
  check('queue: the waiting ones were told their wait (activity_queued, wait_ms) and carry queued_ms', refs.some(r => d1.queued.get(r)?.wait_ms > 0) && res.some(r => r?.queued_ms > 0), J(refs.map(r => d1.queued.get(r)?.wait_ms)))
  await sleep(2500)
  const refs2 = Array.from({ length: 30 }, () => d1.fire(rq))
  const res2 = await until(async () => refs2.map(r => d1.refs.get(r)), rs => rs.every(Boolean), 30000, 50)
  const busy = res2.filter(r => r?.code === 'busy')
  check('queue bound: 30 at once from one dashboard (bound 12) → the excess is `busy` with retry_after_ms; the rest ok', busy.length >= 14 && busy.every(r => r.retry_after_ms > 0) && res2.filter(r => r?.ok).length + busy.length === 30, J(res2.map(r => r ? r.code || 'ok' : 'none')))

  // ---- 8. gone (the session left) vs host down (its host went away) — step 10 (Q72) rebuilt gone on the 2.0 board
  const reg = await call(A, 'register_self', { name: 'Leaver', secret: 'lv', project: 'AIMB' })
  const lv = await call(A, 'log', { as: 'Leaver', secret: 'lv', agent: 'w', label: 'W', text: '@working', state: 'running' })
  const lvOn = await until(() => d1.req({ session: 'Leaver' }), r => !!nodeAt(sessOf(r, 'Leaver', HA), 'W'), 6000, 150)
  check('gone (harness): a registered session on A reports an agent; on B\'s board, running, not gone', lv.ok && nodeAt(sessOf(lvOn, 'Leaver', HA), 'W')?.state === 'running' && !sessOf(lvOn, 'Leaver', HA)?.gone_at, J([lv, sessOf(lvOn, 'Leaver', HA)]))
  await call(A, 'deregister', { peer_id: reg.peer_id, secret: 'lv' })
  const gb = await until(() => d1.req({ session: 'Leaver' }), r => nodeAt(sessOf(r, 'Leaver', HA), 'W')?.state === 'gone', 8000, 200)
  const gs = sessOf(gb, 'Leaver', HA), gl = nodeAt(gs, 'W')
  check('gone: a session that LEFT (deregistered) shows its agents gone (was running, the line kept) and the session\'s gone_at — with no down_at (its host is fine)', gl?.state === 'gone' && gl?.was === 'running' && gl?.current?.text === 'working' && gs?.gone_at > 0 && !gs?.down_at, J(gs))
  const ga = await call(A, 'activity', { session: 'Leaver' })
  check('gone: ... and on its OWNER\'s board too (a local gone row)', nodeAt(sessOf(ga, 'Leaver', HA), 'W')?.state === 'gone' && sessOf(ga, 'Leaver', HA)?.gone_at > 0, J(sessOf(ga, 'Leaver', HA)))
  const reg2 = await call(A, 'register_self', { name: 'Leaver', secret: 'lv', project: 'AIMB' })
  const back = await until(() => d1.req({ session: 'Leaver' }), r => nodeAt(sessOf(r, 'Leaver', HA), 'W')?.state === 'running' && !sessOf(r, 'Leaver', HA)?.gone_at, 8000, 200)
  check('gone: the session back on the roster (registered again) → the mark is cleared (running again)', !!reg2.peer_id && nodeAt(sessOf(back, 'Leaver', HA), 'W')?.state === 'running' && !sessOf(back, 'Leaver', HA)?.gone_at, J(sessOf(back, 'Leaver', HA)))
  await call(A, 'deregister', { peer_id: reg2.peer_id, secret: 'lv' })
  await until(() => d1.req({ session: 'Leaver' }), r => nodeAt(sessOf(r, 'Leaver', HA), 'W')?.state === 'gone', 8000, 200)
  const lc1 = await logger('127.0.0.3', Number(C_PORT) + 1, { session: 'Cee', project: 'AIMB', user: 'robin' })
  const c1 = await lc1.log({ agent: 'c1', label: 'C1', text: '@on C', state: 'running' })
  const cOn = await until(() => d1.req({ session: 'Cee' }), r => !!nodeAt(sessOf(r, 'Cee', HC), 'C1'), 6000, 150)
  check('host down (harness): C\'s agent on B\'s board, running, no down_at', c1.ok && nodeAt(sessOf(cOn, 'Cee', HC), 'C1')?.state === 'running' && !sessOf(cOn, 'Cee', HC)?.down_at, J(sessOf(cOn, 'Cee', HC)))
  lc1.close()
  await hardKill(C); drop(C)
  const hd = await until(() => d1.req({}), r => nodeAt(sessOf(r, 'Cee', HC), 'C1')?.state === 'gone', 10000, 200)
  const cee = sessOf(hd, 'Cee', HC)
  check('host down: C killed → its agents gone (the line kept) AND the distinct host-down mark (the session\'s down_at; the head\'s remote_hosts names C down)', nodeAt(cee, 'C1')?.state === 'gone' && nodeAt(cee, 'C1')?.was === 'running' && nodeAt(cee, 'C1')?.current?.text === 'on C' && cee?.down_at > 0
    && (hd.remote_hosts || []).some(x => x.host === HC && x.down_at > 0), J([cee, hd.remote_hosts]))
  check('host down: ... and A\'s sessions (their host is fine) have no down_at, their agents not gone', !!sessOf(hd, 'Orch', HA) && !sessOf(hd, 'Orch', HA).down_at && nodeAt(sessOf(hd, 'Orch', HA), 'Research')?.state !== 'gone', J(sessOf(hd, 'Orch', HA)))
  check('host down: ... and A\'s GONE session (it left; its host is fine) still has no down_at', nodeAt(sessOf(hd, 'Leaver', HA), 'W')?.state === 'gone' && !sessOf(hd, 'Leaver', HA)?.down_at, J(sessOf(hd, 'Leaver', HA)))
  const cpg = await d1.req({ log: { session: 'Cee', host: HC } })
  check('host down: a page of C\'s node → owner-unreachable (with the host), promptly', cpg.ok === false && cpg.code === 'owner-unreachable' && cpg.host === HC, J(cpg))

  // ---- 9. the doorbell flag: a listener armed on A for Orch → the bell on B's board; gone shortly after it closes (step 10, Q72)
  const bell = await wsClient(WSA, { kind: 'listener', watch: { name: 'Orch', project: 'AIMB' } }, '127.0.0.2')
  const bOn = await until(() => d1.req({}), r => sessOf(r, 'Orch', HA)?.bell === true, 5000, 150)
  check('bell: an armed doorbell on the session\'s host → bell:true on the (remote) board', sessOf(bOn, 'Orch', HA)?.bell === true, J({ ...sessOf(bOn, 'Orch', HA), nodes: undefined }) + ' on A: ' + J(((await call(A, 'activity', { session: 'Orch' })).sessions || []).map(g => g.bell)))
  check('bell: ... on the owner\'s own board too', sessOf(await call(A, 'activity', { session: 'Orch' }), 'Orch', HA)?.bell === true)
  check('bell: other sessions have none', !!sessOf(bOn, 'PagerA', HA) && !sessOf(bOn, 'PagerA', HA).bell && !sessOf(bOn, 'Local', HB)?.bell, J((bOn.sessions || []).map(s => [s.session, s.bell])))
  bell.close()
  const bOff = await until(() => d1.req({}), r => !!sessOf(r, 'Orch', HA) && !sessOf(r, 'Orch', HA).bell, 6000, 150)
  check('bell: closing the listener clears it (after the short re-arm grace)', !!sessOf(bOff, 'Orch', HA) && !sessOf(bOff, 'Orch', HA).bell, J({ ...sessOf(bOff, 'Orch', HA), nodes: undefined }))
  const bellB = await wsClient(WSB, { kind: 'listener', watch: { name: 'local' } })
  const bLoc = await until(() => d1.req({}), r => sessOf(r, 'Local', HB)?.bell === true, 4000, 150)
  check('bell: a local doorbell (name only, any case) marks a local session', sessOf(bLoc, 'Local', HB)?.bell === true, J({ ...sessOf(bLoc, 'Local', HB), nodes: undefined }))
  bellB.close()

  // ---- 10. unsubscribe: no more pushes
  d1.send({ type: 'activity_unsub' })
  await sleep(300)
  const nAfter = d1.boards().length
  await la.log({ agent: 'after-unsub', label: 'After unsub', text: '@a change after unsubscribe' })
  await sleep(1800)
  check('unsubscribe: no pushes after activity_unsub', d1.boards().length === nAfter, `${d1.boards().length - nAfter} more`)

  // ---- 11. a second hub with A's host name → B warns once (rate-limited)
  const E = await spawn('HubE', '127.0.0.4', E_PORT, HA); all.push(E)
  await until(async () => errs.HubB, s => /duplicate host name "DASH-A"/.test(s), 10000, 200)
  await sleep(2000)
  const warns = (errs.HubB.match(/duplicate host name "DASH-A"/g) || []).length
  check('duplicate hostname: B logs a WARN naming both hubs', warns >= 1 && /WARN duplicate host name "DASH-A": .*127\.0\.0\.2.*127\.0\.0\.4|WARN duplicate host name "DASH-A": .*127\.0\.0\.4.*127\.0\.0\.2/.test(errs.HubB), errs.HubB.split('\n').filter(l => /duplicate/.test(l)).join(' | '))
  check('duplicate hostname: rate-limited (one warning)', warns === 1, String(warns))
} catch (e) { fail++; console.log('FAIL crashed:', (e && e.stack) || e) }

console.log(`\n${pass} passed, ${fail} failed`)
for (const x of closers) x.close()
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(400)
for (const d of [...Object.values(dirs), cfgDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
process.exit(fail ? 1 : 0)
