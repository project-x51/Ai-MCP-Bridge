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
// RETIRED in step 9 (each named where it stood): the board PUSHES — activity_sub's full board, deltas (≤1/s, chained, only
// what changed, nested and plan-item deltas, the folded view = a fresh board), the seq-gap resync, activity_unsub, the units'
// raw shape and #79's client_kind on a session unit — the dashboard's pushes answer `not-in-2.0-yet` until build step 10
// rebuilds the page (one check pins that); a session that LEFT shown gone (syncActivityGone is 1.7x — a gap in 2.0); the
// doorbell bell on the board (syncActivityBells is 1.7x — a gap in 2.0); paging on into a SEEDED older day file and the
// skipped 1.61-format line in it (a 2.0 gateway refuses v5 history; the earlier run is made live instead, by a dismissal and
// a re-create of the same key — §3.7).
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
// the dashboard's board (2.0: the `activity` read on its WS until step 10 rebuilds the pushes)
const sessOf = (b, name, host) => ((b && b.sessions) || []).find(s => String(s.session).toLowerCase() === name.toLowerCase() && (!host || s.host === host))
const nodeAt = (s, p) => ((s && s.nodes) || []).find(n => n.path === p)
const retired = (what, why) => console.log(`SKIP ${what} (retired in #88 step 9: ${why})`)
const STEP10 = 'the dashboard\'s board pushes answer not-in-2.0-yet until build step 10 rebuilds the page'

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
  const A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_ACTIVITY_PAGE_ENTRIES: '8', AI_BRIDGE_ACTIVITY_FETCH_RATE: '2' }); all.push(A)
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

  // ---- 1. the dashboard's board: the `activity` read (the pushes are step 10)
  const d0 = await dashOn(WSB, 'dash-idle'); closers.push(d0)
  const d1 = await dashOn(WSB, 'dash-sub'); closers.push(d1)
  d1.send({ type: 'activity_sub' })
  const sub = await until(async () => d1.msgs.find(m => m.type === 'activity_board'), x => !!x, 3000, 50)
  check('subscribe (step 10 pending): activity_sub answers not-in-2.0-yet — no board pushed (the dashboard reads the board with the activity request)', !!sub && sub.ok === false && sub.code === 'not-in-2.0-yet' && !sub.upsert, J(sub))
  retired('subscribe: a FULL board first / deltas ≤1 per second, chained, only what changed / the folded view = a fresh full board', STEP10)
  retired('resync after a seq gap; nested (6a) and plan-item (6b) deltas; unsubscribe', STEP10)
  retired('units are RAW (no rendered / stale_at) and #79 client_kind on a session unit', `dashboard units — ${STEP10}`)
  const bd1 = await until(() => d1.req({}), r => !!nodeAt(sessOf(r, 'Orch', HA), 'Research'), 6000, 150)
  check('board read: the head (ok, format 6, the stale default, this host)', bd1.ok === true && bd1.format === 6 && bd1.stale_after_min === 15 && bd1.host === HB, J({ ...bd1, sessions: (bd1.sessions || []).length }))
  check('board read: it holds the mesh — A\'s agent (its session tagged A, remote) and B\'s own', nodeAt(sessOf(bd1, 'Orch', HA), 'Research')?.kind === 'agent' && sessOf(bd1, 'Orch', HA)?.remote === true && !!nodeAt(sessOf(bd1, 'Local', HB), 'Builder') && !sessOf(bd1, 'Local', HB)?.remote,
    J((bd1.sessions || []).map(s => [s.session, s.host, s.remote, (s.nodes || []).map(n => n.path)])))
  const rs = nodeAt(sessOf(bd1, 'Orch', HA), 'Research')
  check('board read: a remote row carries the reported state, the line and the progress (and the owner\'s node id)', rs?.state === 'running' && rs?.current?.text === 'reading the spec' && rs?.progress?.done === 1 && rs?.progress?.total === 4 && rs?.id === s1.node?.id && rs?.last_activity > 0, J(rs))
  check('no subscription → no pushes: the idle dashboard got no activity_board / activity_delta', !d0.msgs.some(m => m.type === 'activity_board' || m.type === 'activity_delta'), J(d0.msgs.map(m => m.type)))

  // ---- 4. read access: a page leaf gets neither pushes nor reads
  const pg = await wsClient(WSB, { kind: 'page', page_kind: 'probe', title: 'Probe page', instance: 'probe-pg' })
  const pr = await pg.req({ session: 'Orch' }, 3000)
  check('page leaf: an activity read is REFUSED (dashboard-only), not answered', pr.ok === false && pr.code === 'dashboard-only', J(pr))
  pg.send({ type: 'activity_sub' })
  await sleep(300)
  const pgSub = pg.msgs.find(m => m.type === 'activity_board')
  check('page leaf: activity_sub is refused too (dashboard-only — not even the step-10 answer; no board in the answer)', !!pgSub && pgSub.ok === false && pgSub.code === 'dashboard-only' && !pgSub.upsert, J(pgSub))
  pg.send({ type: 'hello', token: TOKEN, kind: 'dashboard', instance: 'probe-pg-2' })
  await sleep(200)
  const pr2 = await pg.req({ session: 'Orch' }, 3000)
  check('page leaf: a second hello cannot turn it into a dashboard (already-hello; still refused)', pg.msgs.some(m => m.type === 'error' && m.code === 'already-hello') && pr2.code === 'dashboard-only', J([pg.msgs.filter(m => m.type === 'error'), pr2]))
  retired('page leaf: no board pushes reach it', STEP10)
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

  // ---- 8. host down (its host went away) — a session that LEFT is a 2.0 gap
  retired('gone: a session that LEFT shows its agents gone (no host_down)', 'syncActivityGone is 1.7x — local sessions are not marked gone when their sub-peer leaves (a gap in 2.0)')
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
  const cpg = await d1.req({ log: { session: 'Cee', host: HC } })
  check('host down: a page of C\'s node → owner-unreachable (with the host), promptly', cpg.ok === false && cpg.code === 'owner-unreachable' && cpg.host === HC, J(cpg))

  // ---- 9. the doorbell flag — a 2.0 gap
  retired('bell: an armed doorbell → bell:true on the (remote) board; cleared after the re-arm grace; a local doorbell', 'syncActivityBells is 1.7x — the doorbell bell is not on the 2.0 board (a gap)')

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
