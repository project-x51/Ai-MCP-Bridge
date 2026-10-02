// #70 step 5 (v1.61.0) — the dashboard side of the activity board: subscribe + DELTAS, seq-gap resync, read access (page
// leaves refused), history paging into the DAY FILES (local and remote), QUEUED remote fetches (+ the `busy` bound), host
// down vs gone, the doorbell flag, the duplicate-hostname warning. Loopback "hosts", each a GATEWAY with its own host name:
//   B  127.0.0.1:14202 "DASH-B"  the observer: the WS dashboards connect here; persist dir B; ≤12 fetches per dashboard
//   A  127.0.0.2:14200 "DASH-A"  persist dir A; owner side: 8 entries per remote page, 2 fetches/s per link; bell grace 500 ms
//   C  127.0.0.3:14220 "DASH-C"  killed mid-test (host down)
//   E  127.0.0.4:14240 "DASH-A"  (!) a second hub with A's host name → B logs the duplicate-hostname warning
// Every host keeps log_entries_per_agent = 10 in memory, so a 30–40 entry history pages on into the files. Ports 14200–14299.
// v1.62.0 (#70 step 6a): dashboard units are one per NODE (kind "node", nkind, parent_key, the rolled-up `bar`); a nested
// tree's deltas fold to the same view as a fresh full board; a NESTED node's subtree log pages into the day files locally
// and remotely; a node's own-only view applies in the files too; a 1.61-format (v1) record in an old day file is skipped.
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const TOKEN = 'actdashtesttok'
const A_PORT = '14200', B_PORT = '14202', C_PORT = '14220', E_PORT = '14240'
const HA = 'DASH-A', HB = 'DASH-B', HC = 'DASH-C'
const dirs = { A: fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-adA-')), B: fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-adB-')) }
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-adcfg-'))
const cfgFile = path.join(cfgDir, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_entries_per_agent: 10 } }))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify

const errs = {}
function spawn(name, bind, port, host, extra = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
      AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}`, AI_BRIDGE_DISCOVERY_MS: '300',
      AI_BRIDGE_TEST_GOSSIP: '', ...extra }, stderr: 'pipe' })
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
// a WS client: a dashboard (or a page / listener leaf); reads by ref; board pushes folded into its store
function wsClient(port, hello, host = '127.0.0.1') {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${host}:${port}`)
    const d = { ws, msgs: [], refs: new Map(), queued: new Map(), store: { units: null, seq: 0, epoch: null }, drop: 0, dropped: [], resyncs: 0, n: 0 }
    d.send = o => ws.send(J(o))
    d.req = async (query, ms = 15000) => { const ref = 'r' + (++d.n); d.send({ type: 'activity', ref, query }); for (let t = 0; t < ms && !d.refs.has(ref); t += 25) await sleep(25); return d.refs.get(ref) || { ok: false, code: 'no-answer' } }
    d.fire = query => { const ref = 'r' + (++d.n); d.send({ type: 'activity', ref, query }); return ref }
    d.boards = () => d.msgs.filter(m => m.type === 'activity_board' || m.type === 'activity_delta')
    d.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => ws.send(J({ type: 'hello', token: TOKEN, ...hello })))
    ws.on('message', raw => {
      const m = JSON.parse(String(raw)); m._t = Date.now(); d.msgs.push(m)
      if (m.type === 'welcome' || (m.type === 'error' && !d.welcome)) { d.welcome = m; resolve(d) }
      if (m.type === 'activity') d.refs.set(m.ref, m.result)
      if (m.type === 'activity_queued') d.queued.set(m.ref, m)
      if (m.type === 'activity_board' || m.type === 'activity_delta') {
        if (m.type === 'activity_delta' && d.drop > 0) { d.drop--; d.dropped.push(m); return }   // simulate a lost frame
        if (applyMsg(d.store, m) === 'resync') { d.resyncs++; d.send({ type: 'activity_sub', resync: true }) }
      }
    })
    ws.on('error', () => resolve(d))
  })
}
const dashOn = (port, inst) => wsClient(port, { kind: 'dashboard', instance: inst })
const units = d => Object.values(d.store.units || {})
const grp = (d, name) => units(d).find(u => u.kind === 'session' && String(u.session).toLowerCase() === name.toLowerCase())
const agt = (d, name, p, host) => units(d).find(u => u.kind === 'node' && grp(d, name) && u.group === grp(d, name).key && u.path === p && (!host || u.host === host))   // v1.62.0: node units

const all = []
const drop = h => { const i = all.indexOf(h); if (i >= 0) all.splice(i, 1) }
process.on('uncaughtException', async e => {   // never leave a bridge behind (e.g. the pre-change run)
  fail++; console.log('FAIL the test crashed:', e && e.stack)
  for (const b of all) { try { await b.transport.close() } catch { } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(1)
})
// ---- the mesh
let B = await spawn('HubB', '127.0.0.1', B_PORT, HB, { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT},127.0.0.3:${C_PORT},127.0.0.4:${E_PORT}`, AI_BRIDGE_ACTIVITY_QUEUE_DASH: '12' }); all.push(B)
await sleep(500)
const A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_ACTIVITY_PAGE_ENTRIES: '8', AI_BRIDGE_ACTIVITY_FETCH_RATE: '2', AI_BRIDGE_ACTIVITY_BELL_GRACE_MS: '500' }); all.push(A)
let C = await spawn('HubC', '127.0.0.3', C_PORT, HC); all.push(C)
const ids = await Promise.all([A, B, C].map(h => call(h, 'my_identity')))
check('harness: A, B, C gateways on ≥ 1.60.0', ids.every(i => i.role === 'gateway' && (v => v[0] > 1 || (v[0] === 1 && v[1] >= 60))(String(i.bridge_version).split('.').map(Number))), J(ids.map(i => [i.role, i.bridge_version])))
const linked = await until(() => call(B, 'list_sessions'), r => [HA, HC].every(h => (r.sessions || []).some(s => String(s.session).startsWith(h + '/'))), 10000)
check('harness: A and C linked to B', [HA, HC].every(h => (linked.sessions || []).some(s => String(s.session).startsWith(h + '/'))))
const WSB = Number(B_PORT) + 1, WSA = Number(A_PORT) + 1

// ---- seed: agents on A (via a script) and on B
const la = await logger('127.0.0.2', WSA, { session: 'Orch', project: 'AIMB', user: 'robin' })
await la.log({ agent: 'research', text: '@~root reading the spec', progress: '1/4 docs' })
const lb = await logger('127.0.0.1', WSB, { session: 'Local', project: 'Tools', user: 'robin' })
await lb.log({ agent: 'builder', text: '@~root compiling', progress: '2/10 files' })

// ---- 1. a dashboard that never subscribes is pushed NOTHING; a subscribed one gets a full board then deltas
const d0 = await dashOn(WSB, 'dash-idle')
const d1 = await dashOn(WSB, 'dash-sub')
d1.send({ type: 'activity_sub' })
await until(async () => d1.store.units && agt(d1, 'Orch', 'research'), x => !!x, 5000)
const full1 = d1.msgs.find(m => m.type === 'activity_board')
check('subscribe: a FULL board first (full, epoch, seq 1, head with the stale default + host)', !!full1 && full1.full === true && full1.seq === 1 && !!full1.epoch && full1.head?.stale_after_min === 15 && full1.head?.host === HB, J(full1 && { ...full1, upsert: (full1.upsert || []).length }))
check('subscribe: the full board holds the mesh — A\'s agent (tagged A) and B\'s, as units', agt(d1, 'Orch', 'research')?.host === HA && agt(d1, 'Local', 'builder')?.host === HB && grp(d1, 'Orch')?.kind === 'session', J(units(d1).map(u => [u.kind, u.session || u.agent, u.host])))
check('subscribe: units are RAW — the reported state, the line\'s template and no rendered / stale_at', agt(d1, 'Orch', 'research')?.state === 'running' && agt(d1, 'Orch', 'research')?.current?.text === 'reading the spec'
  && !('rendered' in (agt(d1, 'Orch', 'research')?.current || {})) && !('stale_at' in (agt(d1, 'Orch', 'research') || {})) && agt(d1, 'Orch', 'research')?.last_activity > 0, J(agt(d1, 'Orch', 'research')))

// ---- 2. a burst → deltas only, ≤1 per second, each carrying only what changed
const pump = await logger('127.0.0.1', WSB, { session: 'Pump', project: 'Tools', user: 'robin' })
await pump.log({ agent: 'p1', text: '@~bar pumping {progress}', progress: '0/60' })
await sleep(1500)
const mark = d1.msgs.length, tStart = Date.now()
for (let i = 1; i <= 60; i++) { for (const ag of ['p1', 'p2', 'p3']) pump.send({ agent: ag, context: '@~bar', text: 'pumping {progress}', progress: `${i}/60`, log: false }); await sleep(50) }
const tEnd = Date.now()
await sleep(1600)
const burst = d1.msgs.slice(mark).filter(m => m.type === 'activity_board' || m.type === 'activity_delta')
const deltas = burst.filter(m => m.type === 'activity_delta'), gaps = deltas.slice(1).map((m, i) => m._t - deltas[i]._t), secs = (tEnd - tStart) / 1000
check(`deltas: ${180} updates in ${secs.toFixed(1)} s → only DELTAS (no full board) to the subscriber`, deltas.length >= 2 && burst.every(m => m.type === 'activity_delta'), J(burst.map(m => m.type)))
check(`deltas: at most one per second (${deltas.length} in ${secs.toFixed(1)} s, gaps ≥ ~1 s)`, deltas.length <= Math.ceil(secs) + 2 && gaps.every(g => g >= 900), J(gaps))
check('deltas: chained — each base is the previous seq', deltas.every((m, i) => i === 0 || m.base === deltas[i - 1].seq) && deltas.every(m => m.seq === m.base + 1), J(deltas.map(m => [m.base, m.seq])))
check('deltas: carry only what changed (the pumped agents + their @bar nodes + their session, never the whole board)', deltas.every(m => (m.upsert || []).length <= 7 && (m.upsert || []).every(u => (u.kind === 'node' && /^p[123](\/@bar)?$/.test(u.path)) || (u.kind === 'session' && u.session === 'Pump'))), J(deltas.map(m => (m.upsert || []).map(u => u.path || u.session))))
check('no subscription → no pushes: the idle dashboard got no activity_board / activity_delta', d0.boards().length === 0, J(d0.boards().map(m => m.type)))
const d2 = await dashOn(WSB, 'dash-truth'); d2.send({ type: 'activity_sub' })
await until(async () => d2.store.units, x => !!x, 4000)
check('deltas: the subscriber\'s folded view equals a fresh full board', canon(d1.store) === canon(d2.store) && agt(d1, 'Pump', 'p3/@bar')?.progress?.done === 60 && agt(d1, 'Pump', 'p3')?.bar?.done === 60, `${canon(d1.store).length} vs ${canon(d2.store).length}`)
d2.close()

// ---- 3. seq gap → resync
const nFull = d1.msgs.filter(m => m.type === 'activity_board').length
d1.drop = 1
await la.log({ agent: 'gap1', text: '@~root first change (its delta is lost)' })
await until(async () => d1.dropped.length, x => x > 0, 4000)
await sleep(1100)
await la.log({ agent: 'gap2', text: '@~root second change' })
await until(async () => d1.msgs.filter(m => m.type === 'activity_board').length > nFull && agt(d1, 'Orch', 'gap2'), x => !!x, 5000)
check('resync: the delta after a lost one does not follow → the page asks again and gets a FULL board', d1.resyncs >= 1 && d1.msgs.filter(m => m.type === 'activity_board').length > nFull, J({ resyncs: d1.resyncs, fulls: d1.msgs.filter(m => m.type === 'activity_board').length }))
check('resync: the view is whole again (the lost change is there)', !!agt(d1, 'Orch', 'gap1') && !!agt(d1, 'Orch', 'gap2'), J(units(d1).filter(u => u.kind === 'node').map(u => u.path)))

// ---- 3b (6a). a NESTED tree's deltas: node units with parent keys + kinds; the folded view equals a fresh full board
const mark2 = d1.msgs.length
await la.log({ path: '@#70/@step4/spec-70', text: '@Tharsis/@~z12 deep line {progress}', progress: '1/4 tiles' })
await la.log({ path: '@#70/@step4/spec-70/research', text: '@~root a sub-agent' })
await until(async () => agt(d1, 'Orch', '@#70/@step4/spec-70/research'), x => !!x, 5000)
await sleep(1200)
await la.log({ path: '@#70/@step4/spec-70/@Tharsis/@z12', progress: '3/4 tiles', log: false })
await until(async () => agt(d1, 'Orch', '@#70/@step4/spec-70/@Tharsis/@z12')?.progress?.done === 3, x => x, 5000)
await sleep(300)
const z12 = agt(d1, 'Orch', '@#70/@step4/spec-70/@Tharsis/@z12'), lastD = d1.msgs.slice(mark2).filter(m => m.type === 'activity_delta').at(-1)
check('nested units (6a): every node is a unit with nkind, depth, parent_key; implicit intermediates; the rolled-up bar on the ancestors', z12?.nkind === 'context' && z12?.depth === 5 && z12?.parent_key === '@#70/@step4/spec-70/@tharsis'
  && agt(d1, 'Orch', '@#70')?.implicit === true && agt(d1, 'Orch', '@#70')?.bar?.done === 3 && agt(d1, 'Orch', '@#70/@step4/spec-70')?.nkind === 'agent', J([z12, agt(d1, 'Orch', '@#70')]))
check('nested deltas (6a): a deep bar update → only that node, its ancestors whose bar moved and the session header', !!lastD && (lastD.upsert || []).every(u => u.kind === 'session' || /^@#70(\/@step4(\/spec-70(\/@Tharsis(\/@z12)?)?)?)?$/.test(u.path)) && (lastD.upsert || []).some(u => u.path === '@#70/@step4/spec-70/@Tharsis/@z12'), J(lastD && lastD.upsert.map(u => u.path || u.session)))
const d3 = await dashOn(WSB, 'dash-truth2'); d3.send({ type: 'activity_sub' })
await until(async () => d3.store.units, x => !!x, 4000)
check('nested deltas (6a): the folded view equals a fresh full board', canon(d1.store) === canon(d3.store), `${canon(d1.store).length} vs ${canon(d3.store).length}`)
d3.close()

// ---- 3c (6b, v1.63.0). a PLAN on A (via the script's logger WS) reaches the dashboard as plan-item units; a tick → a delta with the item + the plan bar
await la.log({ path: '@#77', plan: ['Spec', 'Build', 'Ship'] })
await until(async () => agt(d1, 'Orch', '@#77/@Ship'), x => !!x, 5000)
await sleep(1200)
const mark3 = d1.msgs.length
await la.log({ path: '@#77/@~Spec', state: 'done' })
await until(async () => agt(d1, 'Orch', '@#77/@Spec')?.state === 'done', x => x, 5000)
await sleep(300)
const pu = n => agt(d1, 'Orch', `@#77/@${n}`), d6b = d1.msgs.slice(mark3).filter(m => m.type === 'activity_delta')
check('6b dashboard units: plan items carry plan_item + plan_ix + their REPORTED state (todo / done), A\'s host; the plan node its "N of M done" bar', ['Spec', 'Build', 'Ship'].every((n, i) => pu(n)?.plan_item === true && pu(n)?.plan_ix === i && pu(n)?.host === HA && pu(n)?.nkind === 'context')
  && pu('Spec').state === 'done' && pu('Build').state === 'todo' && (b => b && b.todos === true && b.done === 1 && b.total === 3)(agt(d1, 'Orch', '@#77')?.bar), J([pu('Spec'), agt(d1, 'Orch', '@#77')]))
check('6b dashboard deltas: the tick arrives as a delta carrying the item and the plan node whose bar moved — not the untouched items', d6b.length >= 1 && d6b.some(m => (m.upsert || []).some(u => u.path === '@#77/@Spec' && u.state === 'done')) && d6b.some(m => (m.upsert || []).some(u => u.path === '@#77' && u.bar?.done === 1))
  && !d6b.some(m => (m.upsert || []).some(u => u.path === '@#77/@Ship' || u.path === '@#77/@Build')), J(d6b.map(m => (m.upsert || []).map(u => u.path || u.session))))

// ---- 4. read access: a page leaf gets neither pushes nor reads
const pg = await wsClient(WSB, { kind: 'page', page_kind: 'probe', title: 'Probe page', instance: 'probe-pg' })
const pr = await pg.req({ session: 'Orch' }, 3000)
check('page leaf: an activity read is REFUSED (dashboard-only), not answered', pr.ok === false && pr.code === 'dashboard-only', J(pr))
pg.send({ type: 'activity_sub' })
await sleep(300)
const pgSub = pg.msgs.find(m => m.type === 'activity_board')
check('page leaf: activity_sub is refused too (no board in the answer)', !!pgSub && pgSub.ok === false && pgSub.code === 'dashboard-only' && !pgSub.upsert, J(pgSub))
pg.send({ type: 'hello', token: TOKEN, kind: 'dashboard', instance: 'probe-pg-2' })
await sleep(200)
const pr2 = await pg.req({ session: 'Orch' }, 3000)
check('page leaf: a second hello cannot turn it into a dashboard (already-hello; still refused)', pg.msgs.some(m => m.type === 'error' && m.code === 'already-hello') && pr2.code === 'dashboard-only', J([pg.msgs.filter(m => m.type === 'error'), pr2]))
await la.log({ agent: 'after-page', text: '@~root a change while the page listens' })
await sleep(1500)
check('page leaf: no board pushes reach it', !pg.msgs.some(m => (m.type === 'activity_board' && m.ok !== false) || m.type === 'activity_delta'), J(pg.msgs.map(m => m.type)))
pg.close()

// ---- 5. history paging into the DAY FILES — local (B), ≥3 pages, on into an older day's file
const pl = await logger('127.0.0.1', WSB, { session: 'PagerB', project: 'Tools', user: 'robin' })
const idsB = []
for (let i = 1; i <= 40; i++) idsB.push((await pl.log({ agent: 'deep', text: `@step b entry ${i}` })).id)
const old = new Date(Date.now() - 3 * 86400000), day = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`
const oldIds = [], oldRecs = []
for (let i = 1; i <= 5; i++) { const ts = old.getTime() + i * 1000, id = `act_old_${ts.toString(36)}-${i}`; oldIds.push(id); oldRecs.push(J({ v: 2, id, ts, path: 'deep/@step', text: `old entry ${i}`, state: 'running', origin: HB, realm: 'default', session: 'PagerB', project: 'Tools', user: 'robin', host: HB })) }
oldRecs.splice(2, 0, J({ v: 1, id: `act_v1_${(old.getTime() + 2500).toString(36)}-9`, ts: old.getTime() + 2500, context: 'step', text: 'A 1.61-FORMAT LINE', state: 'running', origin: HB, realm: 'default', session: 'PagerB', project: 'Tools', user: 'robin', host: HB, agent: 'deep' }))   // 6a: skipped
const oldDir = path.join(dirs.B, 'activity', 'dash-b')
fs.mkdirSync(oldDir, { recursive: true }); fs.writeFileSync(path.join(oldDir, `${day}.jsonl`), oldRecs.join('\n') + '\n')
const pagesB = []
let cur = null
for (let k = 0; k < 8; k++) {
  const r = await d1.req({ log: { session: 'PagerB', agent: 'deep', limit: 12, ...(cur ? { cursor: cur } : {}) } })
  pagesB.push(r); cur = r.log?.next_cursor
  if (!cur || r.ok === false) break
}
const gotB = pagesB.flatMap(p => (p.log?.entries || []).map(e => e.id))
const wantB = [...idsB].reverse().concat([...oldIds].reverse())
check(`local paging: ${pagesB.length} pages (≥3) chained by next_cursor, newest first, through the files to an older day`, pagesB.length >= 3 && pagesB.every(p => p.ok) && J(gotB) === J(wantB) && pagesB[pagesB.length - 1]?.log?.next_cursor === null,
  J(pagesB.map(p => [p.ok, p.code, p.log?.entries?.length, p.log?.from_files, p.log?.next_cursor])))
check('local paging: page 1 = the 10 kept in memory (a page never exceeds log_entries_per_agent); page 2 continues in the files with a file cursor', pagesB[0]?.log?.entries?.length === 10 && !pagesB[0]?.log?.from_files
  && pagesB[1]?.log?.from_files === 10 && /^f1\./.test(pagesB[1]?.log?.next_cursor || ''), J(pagesB.slice(0, 2).map(p => [p.log?.entries?.length, p.log?.from_files, p.log?.next_cursor])))
check('local paging: file entries keep the in-memory shape (rendered, path + rel, state; no details/data)', (pagesB[1]?.log?.entries || []).length > 0 && pagesB[1].log.entries.every(e => e.rendered && e.path === 'deep/@step' && e.rel === '@step' && e.state === 'running' && !('details' in e)), J(pagesB[1]?.log?.entries?.[0]))
check('local paging (6a): the 1.61-format (v1) line in the old day file was skipped (never in a page)', !gotB.some(id => id.startsWith('act_v1_')) && !J(pagesB).includes('1.61-FORMAT'))
const ctxPage = await d1.req({ log: { session: 'PagerB', agent: 'deep', own: true, limit: 12 } })
check('local paging (6a): a node\'s OWN-only view applies in the files too (deep\'s entries all live in deep/@step → empty, no cursor)', ctxPage.ok && ctxPage.log?.entries?.length === 0 && ctxPage.log?.next_cursor === null, J(ctxPage.log))
const nestPage = await d1.req({ log: { session: 'PagerB', path: 'deep/@step', limit: 12, cursor: pagesB[1]?.log?.next_cursor } })
check('local paging (6a): the nested context\'s own subtree pages on into the files with a file cursor', nestPage.ok && (nestPage.log?.entries || []).length > 0 && nestPage.log.entries.every(e => e.path === 'deep/@step' && e.rel === ''), J(nestPage.log && nestPage.log.entries.length))

// ---- 6. remote paging: A's history through B, owner-paged (8 per page) on into A's day files
const pa = await logger('127.0.0.2', WSA, { session: 'PagerA', project: 'AIMB', user: 'robin' })
const idsA = []
for (let i = 1; i <= 30; i++) idsA.push((await pa.log({ path: '@#70/deep/@step', text: `a entry ${i}` })).id)   // 6a: a NESTED node on the remote host
await until(async () => agt(d1, 'PagerA', '@#70/deep'), x => !!x, 5000)
const pagesA = []
cur = null
for (let k = 0; k < 8; k++) {
  const r = await d1.req({ log: { session: 'PagerA', path: '@#70/deep', ...(cur ? { cursor: cur } : {}) } })
  pagesA.push(r); cur = r.log?.next_cursor
  if (!cur || r.ok === false) break
}
const gotA = pagesA.flatMap(p => (p.log?.entries || []).map(e => e.id))
check(`remote paging: ${pagesA.length} pages (≥3) of A's NESTED subtree (@#70/deep) through B, newest first, into A's files`, pagesA.length >= 3 && pagesA.every(p => p.ok && p.from_host === HA) && J(gotA) === J([...idsA].reverse()),
  J(pagesA.map(p => [p.ok, p.code, p.log?.entries?.length, p.log?.from_files])))
check('remote paging: the owner\'s page size holds (≤8) and later pages come from the files', pagesA.every(p => (p.log?.entries || []).length <= 8) && pagesA.some(p => p.log?.from_files > 0), J(pagesA.map(p => p.log?.from_files)))
await sleep(2500)   // A's bucket (2/s) refills

// ---- 7. queued remote fetches: a burst that step 4 answered `rate-limited` now all succeed (B paces them)
const refs = Array.from({ length: 10 }, () => d1.fire({ log: { session: 'Orch', agent: 'research', limit: 1 } }))
const res = await until(async () => refs.map(r => d1.refs.get(r)), rs => rs.every(Boolean), 15000, 50)
check('queue: a burst of 10 remote fetches (owner serves 2/s) → all answered ok, none rate-limited', res.every(r => r && r.ok === true), J(res.map(r => r ? r.code || 'ok' : 'none')))
check('queue: the waiting ones were told their wait (activity_queued, wait_ms) and carry queued_ms', refs.some(r => d1.queued.get(r)?.wait_ms > 0) && res.some(r => r?.queued_ms > 0), J(refs.map(r => d1.queued.get(r)?.wait_ms)))
await sleep(2500)
const refs2 = Array.from({ length: 30 }, () => d1.fire({ log: { session: 'Orch', agent: 'research', limit: 1 } }))
const res2 = await until(async () => refs2.map(r => d1.refs.get(r)), rs => rs.every(Boolean), 30000, 50)
const busy = res2.filter(r => r?.code === 'busy')
check('queue bound: 30 at once from one dashboard (bound 12) → the excess is `busy` with retry_after_ms; the rest ok', busy.length >= 14 && busy.every(r => r.retry_after_ms > 0) && res2.filter(r => r?.ok).length + busy.length === 30, J(res2.map(r => r ? r.code || 'ok' : 'none')))

// ---- 8. gone (the session left) vs host down (its host went away)
const reg = await call(A, 'register_self', { name: 'Leaver', secret: 'lv', project: 'AIMB' })
await call(A, 'log', { as: 'Leaver', secret: 'lv', agent: 'w', text: '@~root working' })
await until(async () => agt(d1, 'Leaver', 'w'), x => !!x, 5000)
await call(A, 'deregister', { peer_id: reg.peer_id, secret: 'lv' })
const gl = await until(async () => agt(d1, 'Leaver', 'w'), x => x?.state === 'gone', 6000)
check('gone: a session that LEFT shows its agents gone — with no host_down (its host is fine)', gl?.state === 'gone' && gl?.was === 'running' && !gl?.host_down && !grp(d1, 'Leaver')?.hosts_down, J(gl))
const lc1 = await logger('127.0.0.3', Number(C_PORT) + 1, { session: 'Cee', project: 'AIMB', user: 'robin' })
await lc1.log({ agent: 'c1', text: '@~root on C' })
await until(async () => agt(d1, 'Cee', 'c1'), x => !!x, 5000)
lc1.close()
await hardKill(C); drop(C)
const hd = await until(async () => agt(d1, 'Cee', 'c1'), x => x?.state === 'gone', 8000)
check('host down: C killed → its agents gone AND host_down (a distinct mark); the group lists hosts_down', hd?.state === 'gone' && hd?.host_down > 0 && J(grp(d1, 'Cee')?.hosts_down) === J([HC]), J([hd, grp(d1, 'Cee')?.hosts_down]))
check('host down: ... and A\'s gone session still has no host_down', !agt(d1, 'Leaver', 'w')?.host_down)

// ---- 9. the doorbell flag: a listener armed on A for Orch → the bell on B's board; gone shortly after it closes
const bell = await wsClient(WSA, { kind: 'listener', watch: { name: 'Orch', project: 'AIMB' } }, '127.0.0.2')
const bOn = await until(async () => grp(d1, 'Orch'), g => g?.bell === true, 5000)
check('bell: an armed doorbell on the session\'s host → bell:true on the (remote) board', bOn?.bell === true, J(bOn) + ' on A: ' + J((await call(A, 'activity', { session: 'Orch' })).sessions?.map(g => g.bell)))
check('bell: other sessions have none', !grp(d1, 'PagerA')?.bell && !grp(d1, 'Local')?.bell)
bell.close()
const bOff = await until(async () => grp(d1, 'Orch'), g => g && !g.bell, 6000)
check('bell: closing the listener clears it (after the short re-arm grace)', bOff && !bOff.bell, J(bOff))
const bellB = await wsClient(WSB, { kind: 'listener', watch: { name: 'local' } })
const bLoc = await until(async () => grp(d1, 'Local'), g => g?.bell === true, 4000)
check('bell: a local doorbell (name only, any case) marks a local session', bLoc?.bell === true, J(bLoc))
bellB.close()

// ---- 10. unsubscribe: no more pushes
d1.send({ type: 'activity_unsub' })
await sleep(300)
const nAfter = d1.boards().length
await la.log({ agent: 'after-unsub', text: '@~root change after unsubscribe' })
await sleep(1500)
check('unsubscribe: no pushes after activity_unsub', d1.boards().length === nAfter, `${d1.boards().length - nAfter} more`)

// ---- 11. a second hub with A's host name → B warns once (rate-limited)
const E = await spawn('HubE', '127.0.0.4', E_PORT, HA); all.push(E)
await until(async () => errs.HubB, s => /duplicate host name "DASH-A"/.test(s), 10000, 200)
await sleep(2000)
const warns = (errs.HubB.match(/duplicate host name "DASH-A"/g) || []).length
check('duplicate hostname: B logs a WARN naming both hubs', warns >= 1 && /WARN duplicate host name "DASH-A": .*127\.0\.0\.2.*127\.0\.0\.4|WARN duplicate host name "DASH-A": .*127\.0\.0\.4.*127\.0\.0\.2/.test(errs.HubB), errs.HubB.split('\n').filter(l => /duplicate/.test(l)).join(' | '))
check('duplicate hostname: rate-limited (one warning)', warns === 1, String(warns))

console.log(`\n${pass} passed, ${fail} failed`)
for (const x of [la, lb, pump, pl, pa]) x.close()
for (const x of [d0, d1]) x.close()
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(400)
for (const d of [...Object.values(dirs), cfgDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
process.exit(fail ? 1 : 0)
