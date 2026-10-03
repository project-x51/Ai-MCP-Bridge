// #70 step 6d (v1.65.0), ported to the 2.0 board in #88 build step 9 — live: the dashboard's WRITE path (right-click
// ACTIONS), now BY NODE ID (docs/spec-88.md §5.4, §6.3). Ports 14300–14399 (this file's block); temp persist dirs + a temp
// AI_BRIDGE_CONFIG (never src/config.json); a test-set token that is never printed. Loopback "hosts", each a 2.0 GATEWAY:
//   B  127.0.0.1:14302 "ACT-B"  the dashboard attaches here (ws 14303); persist dir B; session Lead (+ Leaver) registered on it
//   A  127.0.0.2:14300 "ACT-A"  the OWNER of session Remote: a dashboard action on its nodes is forwarded B → A (ACTIVITY_ACT)
//   G  127.0.0.3:14340 "ACT-G"  alone, restarted with the test clock (+6.5 d, +10 d): the carry-forward's exact entry count
// Covers every action by id (plan item done / skip / reopen / abandon; plan complete / abandon_plan / reopen_plan; agent /
// session abandon_plan, finish, dismiss) with their codes (+ 2.0's bad-id); the attribution entry ("… by robin via dashboard
// (ACT-B)", by + act); local and FORWARDED to the owner, the effect back on B's board through gossip v6; an agent finishing
// leaves its plan open; abandon_plan on an agent leaves it running; dismiss refusing a subtree with open items, removing an
// agent / a whole (stale) session, the removal gossiped, and PERSISTING across a gateway restart (the dismissal's event entry
// on the parent); a page leaf, a logger and a socket without a hello refused; forged hub frames (no hello / not an adopted
// peer / naming another owner / claiming a host); a remote host's aimb-log paths in the board head (never the token); the
// entry count (log_n, the page's total) exact after restarts past the replay window.
// Retired in step 9 (1.7x-only): path-addressed actions; a session marked GONE when its sub-peer leaves
// (syncActivityGone is 1.7x — the whole-session dismissal is checked on a STALE session root instead); the row's
// plan_end_at / plan_end_how / plan_node (2.0 rows carry none — a plan's end is checked through the actions' own refusals:
// already-ended / not-ended / no-open-plan); 1.7x's log.total / partial (2.0: log_n + the log page's total).
// Restored in step 10: the dashboard's pushed board and its own head (log_cmd, user — who actions are attributed to).
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import crypto from 'node:crypto'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 14300)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const TOKEN = 'act6d-' + crypto.randomBytes(9).toString('hex')
const A_PORT = String(tp(14300)), B_PORT = String(tp(14302)), G_PORT = String(tp(14340))
const HA = 'ACT-A', HB = 'ACT-B', HG = 'ACT-G'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-6d-'))
const dirs = { A: fs.mkdtempSync(path.join(tmp, 'pA-')), B: fs.mkdtempSync(path.join(tmp, 'pB-')), G: fs.mkdtempSync(path.join(tmp, 'pG-')) }
const cfgFile = path.join(tmp, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_retention_days: 30 } }))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const seen = []   // every raw response / frame text: none may carry the token
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).split(TOKEN).join('<TOKEN>'))) }
const J = JSON.stringify
const DAY = 86400000
const NO_ID = 'aaaaaaaaaaaaaaaa'   // a well-formed node id no board holds

function spawn(name, bind, port, host, extra = {}) {
  const env = { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
    AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
    AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}`, AI_BRIDGE_DISCOVERY_MS: '300',
    AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_TEST_ACTIVITY_TAP: '1', TEMP: tmp, TMP: tmp, ...extra }
  delete env.AI_BRIDGE_TRAY
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR, env, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => { const h = { c, transport, name }; all.push(h); return h })
}
const all = []
async function stop(h) { try { await h.transport.close() } catch { } all.splice(all.indexOf(h), 1); await sleep(500) }
const fileOf = d => ({ AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: d })
const call = async (b, n, a = {}) => { try { const t = (await b.c.callTool({ name: n, arguments: a })).content[0].text; seen.push(t); return JSON.parse(t) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 120) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
const board = async (h, q = {}) => (await call(h, 'activity', q)).sessions || []
const group = (b, name) => b.find(s => String(s.session).toLowerCase() === name.toLowerCase())
const nodeOf = (b, name, p) => (group(b, name)?.nodes || []).find(x => x.path === p)
const logOf = async (h, q) => ((await call(h, 'activity', { log: { limit: 50, ...q } })).log || { entries: [] })
const tap = async h => (await call(h, 'activity', { tap: true, session: '-none-' })).tap || { sent: [], recv: [] }
// a WS client: hello as `kind` (dashboard / page / logger / none), then actions by ref
function wsClient(port, kind, extra = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${extra.host || '127.0.0.1'}:${port}`), C = { ws, msgs: [], n: 0, welcome: null, closed: false }
    C.send = o => ws.send(J(o))
    C.action = async (msg, ms = 8000) => { const ref = `r${++C.n}`; C.send({ type: 'activity_action', ref, ...msg }); const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = C.msgs.find(x => x.type === 'activity_action' && x.ref === ref); if (m) return m.result; await sleep(30) } return { ok: false, code: 'no-answer' } }
    C.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => { if (kind === 'none') resolve(C); else ws.send(J({ type: 'hello', kind, token: extra.token || TOKEN, ...(kind === 'logger' ? { ident: extra.ident || { session: 'Lead', project: 'ACTS', user: 'robin' } } : { instance: `t-${kind}-${C.n}` }) })) })
    ws.on('message', raw => { const s = String(raw); seen.push(s); const m = JSON.parse(s); C.msgs.push(m); if (m.type === 'welcome' || m.type === 'error') { C.welcome = m; resolve(C) } })
    ws.on('close', () => { C.closed = true; resolve(C) })
    ws.on('error', () => resolve(C))
  })
}
// a raw hub-protocol socket (length-prefixed JSON frames) for the forged-frame checks — replies collected
const frameOf = o => { const b = Buffer.from(J(o)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]) }
function rawSock(host, port, hello) {
  return new Promise(resolve => {
    const R = { frames: [] }
    let buf = Buffer.alloc(0)
    const s = net.connect(Number(port), host, () => {
      if (hello) { s.write(frameOf({ t: 'HELLO', ver: 1, fromBridge: hello.session, fromSession: hello.session, name: 'fake', auth: TOKEN }))
        if (hello.peer) s.write(frameOf({ t: 'PEER_HELLO', session: hello.session, name: 'fake', host: '127.0.0.9', port: 1, realm: 'default', gossip_refresh: true, refresh_ms: 60000, activity_gossip: hello.fmt })) }
      setTimeout(() => resolve(R), 500)
    })
    R.s = s; R.send = o => s.write(frameOf(o)); R.close = () => { try { s.destroy() } catch { } }
    R.res = async (rid, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const f = R.frames.find(x => x.t === 'ACTIVITY_RES' && x.rid === rid); if (f) return f.result; await sleep(30) } return null }
    s.on('data', d => { buf = Buffer.concat([buf, d]); while (buf.length >= 4) { const n = buf.readUInt32BE(0); if (buf.length < 4 + n) break; try { R.frames.push(JSON.parse(buf.slice(4, 4 + n).toString())) } catch { } buf = buf.slice(4 + n) } })
    s.on('error', () => resolve(R))
  })
}

// ================================================================= the mesh: B (dashboard host), A (owner of Remote)
const envB = { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT}` }   // the smaller address dials
let B = await spawn('HubB', '127.0.0.1', B_PORT, HB, envB)
await sleep(600)
const A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` })
const ids = await Promise.all([A, B].map(h => call(h, 'my_identity')))
const heads = await Promise.all([A, B].map(h => call(h, 'activity', { session: '-none-' })))
check('harness: A and B are gateways holding the 2.0 board (format 6)', ids.every(i => i.role === 'gateway') && heads.every(h => h.format === 6), J([ids.map(i => [i.role, i.bridge_version]), heads.map(h => h.format)]))
const linked = await until(() => call(B, 'list_sessions'), r => (r.sessions || []).some(s => String(s.session).startsWith(HA + '/')), 10000)
check('harness: A is linked to B', (linked.sessions || []).some(s => String(s.session).startsWith(HA + '/')))
// ---- B's session Lead: a stale-able lead holding a plan, a context plan, a fresh agent, a stale helper, an owner that finishes
await call(B, 'register_self', { name: 'Lead', secret: 'l', project: 'ACTS' })
const L = input => call(B, 'log', { as: 'Lead', secret: 'l', ...input })
const seed = await Promise.all([
  L({ agent: 'lead', label: 'lead', text: '@leading', plan: ['I1', 'I2', 'I3'], stale_after: '1s' }),
  L({ key: 'p70', label: '#70', plan: ['A', 'B'] }),
  L({ agent: 'fresh', label: 'fresh', text: '@fresh work' }),
  L({ agent: 'helper', label: 'helper', text: '@helping', stale_after: '1s' }),
  L({ agent: 'owner', label: 'owner', text: '@owning', plan: ['o1'] }),
])
const fin = await L({ agent: 'owner', text: '@all done here', state: 'done' })
check('fixture: Lead\'s nodes are reported on B', seed.every(r => r.ok) && fin.ok, J([...seed, fin].map(r => r.code || r.node?.path)))
// ---- A's session Remote
await call(A, 'register_self', { name: 'Remote', secret: 'r', project: 'ACTS' })
const rr = await call(A, 'log', { as: 'Remote', secret: 'r', agent: 'ragent', label: 'ragent', text: '@remote work', plan: ['R1', 'R2'], stale_after: '1s' })
check('fixture: Remote\'s plan is reported on A and gossiped to B', rr.ok && !!(await until(() => board(B), b => !!nodeOf(b, 'Remote', 'ragent/R2'), 6000)) && !!nodeOf(await board(B), 'Remote', 'ragent/R2'), J(rr))
const b0 = await board(B)
const idOf = p => nodeOf(b0, 'Lead', p)?.id
const rid = p => nodeOf(b0, 'Remote', p)?.id
check('fixture: every row carries its 16-char node id (the same on A\'s and B\'s board for A\'s nodes)', ['lead', 'lead/I1', '#70', '#70/A', 'fresh', 'helper', 'owner', 'owner/o1'].every(p => /^[a-z2-7]{16}$/.test(idOf(p) || ''))
  && rid('ragent/R1') === nodeOf(await board(A), 'Remote', 'ragent/R1')?.id && rid('ragent') === rr.node?.id, J((group(b0, 'Lead')?.nodes || []).map(n => [n.path, n.id])))

// ================================================================= a dashboard on B: access, the head
const dash = await wsClient(Number(B_PORT) + 1, 'dashboard')
check('dashboard: welcomed on B', dash.welcome?.type === 'welcome')
dash.send({ type: 'activity_sub' })
const sub = await until(async () => dash.msgs.find(m => m.type === 'activity_board'), x => !!x, 5000, 50)
check('board pushes (2.0, step 10): activity_sub → a full board by node id, its head naming this host\'s aimb-log paths and who actions are attributed to (never the token)', sub?.full === true && !!sub?.head?.log_cmd?.script && sub?.head?.user === 'robin' && !J(sub).includes(TOKEN)
  && (sub.upsert || []).some(u => u.kind === 'node' && /^[a-z2-7]{16}$/.test(u.node_id || '')), J(sub && { ...sub, upsert: (sub.upsert || []).length, types: undefined }))
const rh = await until(async () => ((await call(B, 'activity', { session: '-none-' })).remote_hosts || []).find(x => x.host === HA), x => !!x?.log_cmd, 5000, 100)
check('board head (6d): each remote host\'s aimb-log paths (from its full slice) — never the token', !!rh?.log_cmd?.script && /aimb-log\.mjs$/.test(rh.log_cmd.script) && !!rh.log_cmd.node && !J(rh).includes(TOKEN), J(rh))
const Q = (id, action, args, extra = {}) => ({ host: HB, session: 'Lead', project: 'ACTS', user: 'robin', id, action, ...(args ? { args } : {}), ...extra })
const page = await wsClient(Number(B_PORT) + 1, 'page')
const pr = await page.action(Q(idOf('lead/I1'), 'done'))
const lg = await wsClient(Number(B_PORT) + 1, 'logger')
const lr = await lg.action(Q(idOf('lead/I1'), 'done'))
const anon = await wsClient(Number(B_PORT) + 1, 'none')
const nr = await anon.action(Q(idOf('lead/I1'), 'done'))
const badTok = await wsClient(Number(B_PORT) + 1, 'dashboard', { token: 'not-the-token' })
check('access: a PAGE leaf → unauthorized; a LOGGER → unauthorized; a socket with no hello → unauthorized; a wrong token is closed', pr.code === 'unauthorized' && lr.code === 'unauthorized' && nr.code === 'unauthorized' && badTok.closed, J([pr, lr, nr, badTok.closed]))
check('access: … and none of them changed anything (I1 still todo)', nodeOf(await board(B), 'Lead', 'lead/I1')?.state === 'todo')
page.close(); lg.close(); anon.close()

// ================================================================= plan ITEM actions (local on B)
const i1Text = nodeOf(b0, 'Lead', 'lead/I1')?.current?.text ?? null
const d1 = await dash.action(Q(idOf('lead/I1'), 'done'))
const b1 = await board(B)
check('item done: ok (applied on B, the owner, by id) — ☐ → ☑ on the board, the item\'s line KEEPS its text', d1.ok && d1.host === HB && d1.action === 'done' && d1.id === idOf('lead/I1') && d1.path === 'lead/I1' && d1.from_state === 'todo' && d1.to_state === 'done'
  && nodeOf(b1, 'Lead', 'lead/I1')?.state === 'done' && (nodeOf(b1, 'Lead', 'lead/I1')?.current?.text ?? null) === i1Text, J([d1, i1Text, nodeOf(b1, 'Lead', 'lead/I1')?.current]))
const lg1 = await logOf(B, { session: 'Lead', id: idOf('lead/I1'), own: true })
const e1 = lg1.entries[0] || {}
check('attribution: the action is LOGGED on the node — "marked done by robin via dashboard (ACT-B)", by { kind:"dashboard", user, host }, act, the result\'s entry_id', e1.text === 'marked done by robin via dashboard (ACT-B)' && J(e1.by) === J({ kind: 'dashboard', user: 'robin', host: HB }) && e1.act === 'done' && e1.state === 'done' && e1.id === d1.entry_id, J([e1, d1.entry_id]))
check('propagation: the change reaches A\'s board through gossip v6 (the same id ☑)', nodeOf(await until(() => board(A), b => nodeOf(b, 'Lead', 'lead/I1')?.state === 'done', 5000), 'Lead', 'lead/I1')?.id === idOf('lead/I1'))
const sk = await dash.action(Q(idOf('lead/I2'), 'skip')), ro = await dash.action(Q(idOf('lead/I2'), 'reopen')), ab = await dash.action(Q(idOf('lead/I3'), 'abandon'))
const b2 = await board(B)
check('item skip / reopen (→ ☐ todo) / abandon: each applied', sk.ok && ro.ok && ab.ok && nodeOf(b2, 'Lead', 'lead/I2')?.state === 'todo' && nodeOf(b2, 'Lead', 'lead/I3')?.state === 'abandoned', J([sk.code, ro.code, ab.code]))
const codes = await Promise.all([
  dash.action(Q(idOf('fresh'), 'done')), dash.action(Q(idOf('lead/I1'), 'done')), dash.action(Q(NO_ID, 'done')), dash.action({ ...Q(idOf('lead/I1'), 'done'), session: 'Nobody' }),
  dash.action(Q(idOf('lead/I1'), 'explode')), dash.action(Q(idOf('fresh'), 'complete')), dash.action(Q(idOf('#70/A'), 'finish', { state: 'done' })), dash.action(Q(idOf('fresh'), 'finish', { state: 'maybe' })),
  dash.action(Q(idOf('fresh'), 'finish', { state: 'done' })), dash.action(Q(idOf('fresh'), 'dismiss')), dash.action(Q(idOf('#70'), 'reopen_plan')), dash.action({ ...Q(idOf('lead/I1'), 'done'), host: 'NO-SUCH-HOST' }),
  dash.action(Q('not-an-id', 'done')), dash.action({ ...Q(undefined, 'done'), path: 'lead/I1' }),
])
check('codes: not-a-plan-item · no-change · unknown-node · unknown-session · bad-action · not-a-plan · not-an-agent · bad-args · not-stale (finish) · not-stale (dismiss) · not-ended · unknown-host · bad-id · bad-id (a 1.7x path, no id)',
  J(codes.map(r => r.code)) === J(['not-a-plan-item', 'no-change', 'unknown-node', 'unknown-session', 'bad-action', 'not-a-plan', 'not-an-agent', 'bad-args', 'not-stale', 'not-stale', 'not-ended', 'unknown-host', 'bad-id', 'bad-id']), J(codes.map(r => r.code)))

// ================================================================= PLAN NODE actions
const cp = await dash.action(Q(idOf('#70'), 'complete'))
const n70 = nodeOf(await board(B), 'Lead', '#70')
check('plan complete: the context plan node is set done — its plan ENDS (of plan, open → done) whatever its items say (A still todo)', cp.ok && cp.of === 'plan' && cp.from_state === 'open' && cp.to_state === 'done' && n70?.state === 'done' && nodeOf(await board(B), 'Lead', '#70/A')?.state === 'todo', J([cp, n70]))
check('plan complete again → already-ended', (await dash.action(Q(idOf('#70'), 'complete'))).code === 'already-ended')
const rp = await dash.action(Q(idOf('#70'), 'reopen_plan'))
check('plan reopen: open again (the node back to running; reopen_plan again → not-ended)', rp.ok && rp.to_state === 'open' && nodeOf(await board(B), 'Lead', '#70')?.state === 'running' && (await dash.action(Q(idOf('#70'), 'reopen_plan'))).code === 'not-ended', J(rp))
const ap = await dash.action(Q(idOf('#70'), 'abandon_plan'))
const b3 = await board(B)
check('plan abandon_plan: its OPEN items abandoned, then the node — the plan ends abandoned', ap.ok && ap.of === 'plan' && ap.to_state === 'abandoned' && ['#70/A', '#70/B', '#70'].every(p => nodeOf(b3, 'Lead', p)?.state === 'abandoned')
  && J(ap.applied.map(x => x.path)) === J(['#70/A', '#70/B', '#70']) && J(ap.applied.map(x => x.id)) === J(['#70/A', '#70/B', '#70'].map(idOf)) && (await dash.action(Q(idOf('#70'), 'complete'))).code === 'already-ended', J(ap.applied))

// ================================================================= the agent-finish rule; abandon_plan / finish / dismiss on agents
const own = nodeOf(b3, 'Lead', 'owner')
check('rule (6d): an agent FINISHING done leaves its plan OPEN — the owner is finished, its item still ☐, its bar the items, reopen_plan → not-ended', !!own?.finished_at && own.state === 'done' && nodeOf(b3, 'Lead', 'owner/o1')?.state === 'todo' && own.display?.bar?.items === true
  && (await dash.action(Q(idOf('owner'), 'reopen_plan'))).code === 'not-ended', J(own))
await sleep(1300)   // lead (and helper, and ragent on A) reported stale_after 1s: they are STALE now
const apl = await dash.action(Q(idOf('lead'), 'abandon_plan'))
const b4 = await board(B), ld = nodeOf(b4, 'Lead', 'lead')
check('abandon_plan on an AGENT: only its OPEN items (I2) become abandoned (I1 done kept) and its plan ends — the agent KEEPS RUNNING (its line untouched, not finished)', apl.ok && nodeOf(b4, 'Lead', 'lead/I2')?.state === 'abandoned' && nodeOf(b4, 'Lead', 'lead/I1')?.state === 'done'
  && ld?.current?.state === 'running' && ld?.current?.text === 'leading' && !ld?.finished_at && (await dash.action(Q(idOf('lead'), 'abandon_plan'))).code === 'no-open-plan', J([apl, ld]))
const fz = await dash.action(Q(idOf('lead'), 'finish', { state: 'failed' }))
const ld2 = nodeOf(await board(B), 'Lead', 'lead')
const lle = (await logOf(B, { session: 'Lead', id: idOf('lead'), own: true })).entries[0] || {}
check('finish a STALE agent (failed): finished, its line failed (text kept); logged "marked finished (failed) by robin via dashboard (ACT-B)"', fz.ok && !!ld2?.finished_at && ld2?.current?.state === 'failed' && ld2?.current?.text === 'leading' && lle.text === 'marked finished (failed) by robin via dashboard (ACT-B)' && lle.act === 'finish', J([fz, lle]))
check('finish again → already-finished', (await dash.action(Q(idOf('lead'), 'finish', { state: 'done' }))).code === 'already-finished')
check('dismiss an agent whose subtree holds OPEN plan items (owner: its o1 is still ☐) → has-open-items', (await dash.action(Q(idOf('owner'), 'dismiss'))).code === 'has-open-items')
const ds = await dash.action(Q(idOf('helper'), 'dismiss'))
const b5 = await board(B)
check('dismiss a STALE agent: it leaves the board now (with its subtree)', ds.ok && ds.dismissed?.path === 'helper' && ds.dismissed?.id === idOf('helper') && !nodeOf(b5, 'Lead', 'helper') && !!nodeOf(b5, 'Lead', 'fresh'), J(ds))
const rootLog = await logOf(B, { session: 'Lead' })
check('dismiss: logged as an EVENT entry on the PARENT (dismiss:true, of = the removed id, act, by) in its log — nothing erased', rootLog.entries.some(e => e.dismiss === true && e.of === idOf('helper') && e.act === 'dismiss' && e.text === 'dismissed "helper" from the board by robin via dashboard (ACT-B)' && e.id === ds.entry_id), J(rootLog.entries.slice(0, 3)))
check('dismiss: the removal reaches A\'s board through the gossip', !!(await until(() => board(A), b => !!nodeOf(b, 'Lead', 'fresh') && !nodeOf(b, 'Lead', 'helper'), 5000)) && !nodeOf(await board(A), 'Lead', 'helper'))
// a whole session: its ROOT (stale) is dismissed
const lv = await call(B, 'register_self', { name: 'Leaver', secret: 'v', project: 'ACTS' })
const lvl = await call(B, 'log', { as: 'Leaver', secret: 'v', text: '@about to leave', stale_after: '1s' })
await call(B, 'deregister', { peer_id: lv.peer_id, secret: 'v' })
await until(() => board(A), b => !!group(b, 'Leaver'), 5000)
await sleep(1300)
const lvRoot = group(await board(B), 'Leaver')?.root_id
const dz = await dash.action({ ...Q(lvRoot, 'dismiss'), session: 'Leaver' })
check('dismiss a STALE session (its root id): the whole session leaves B\'s board — and A\'s (gossip)', lvl.ok && !!lvRoot && dz.ok && dz.dismissed?.session === true && !group(await board(B), 'Leaver')
  && !group(await until(() => board(A), b => !group(b, 'Leaver'), 5000), 'Leaver'), J([lvl.code, dz]))

// ================================================================= FORWARDED to the owner (A)
const RQ = (id, action, args) => ({ host: HA, session: 'Remote', project: 'ACTS', user: 'robin', id, action, ...(args ? { args } : {}) })
const rd = await dash.action(RQ(rid('ragent/R1'), 'done'))
check('forward: an action on A\'s node, asked on B, is applied by A (result host ACT-A), by id', rd.ok && rd.host === HA && rd.path === 'ragent/R1' && rd.id === rid('ragent/R1'), J(rd))
const rb = await until(() => board(B), b => nodeOf(b, 'Remote', 'ragent/R1')?.state === 'done', 5000)
check('forward: the effect comes back to B\'s board through the gossip (A\'s session)', nodeOf(rb, 'Remote', 'ragent/R1')?.state === 'done' && group(rb, 'Remote')?.host === HA && group(rb, 'Remote')?.remote === true)
const re1 = (await logOf(A, { session: 'Remote', id: rid('ragent/R1'), own: true })).entries[0] || {}
check('forward: A logs it attributed to the DASHBOARD\'s host and user — "… by robin via dashboard (ACT-B)"', re1.text === 'marked done by robin via dashboard (ACT-B)' && re1.by?.host === HB && re1.by?.user === 'robin', J(re1))
const tb = await tap(B), ta = await tap(A)
check('forward: over the hub link as ACTIVITY_ACT (B sent it, A received it and answered)', tb.sent.some(x => x.kind === 'act' && x.op === 'done') && ta.recv.some(x => x.kind === 'act' && x.op === 'done') && ta.sent.some(x => x.kind === 'res' && x.op === 'action' && x.ok), J([tb.sent.filter(x => x.kind === 'act'), ta.recv.filter(x => x.kind === 'act')]))
const rcodes = await Promise.all([dash.action(RQ(rid('ragent'), 'done')), dash.action(RQ(rid('ragent'), 'dismiss')), dash.action(RQ('not-an-id', 'done'))])
check('forward: the OWNER validates — not-a-plan-item, has-open-items, bad-id (its codes, host ACT-A)', J(rcodes.map(r => r.code)) === J(['not-a-plan-item', 'has-open-items', 'bad-id']) && rcodes.every(r => r.host === HA), J(rcodes))
const rfin = await dash.action(RQ(rid('ragent'), 'finish', { state: 'done' }))
const rag = await until(() => board(B), b => !!nodeOf(b, 'Remote', 'ragent')?.finished_at, 5000)
check('forward: finishing A\'s stale agent from B — finished on B\'s board too; its plan (R2 ☐) stays OPEN (reopen_plan → not-ended)', rfin.ok && !!nodeOf(rag, 'Remote', 'ragent')?.finished_at && nodeOf(rag, 'Remote', 'ragent/R2')?.state === 'todo'
  && (await dash.action(RQ(rid('ragent'), 'reopen_plan'))).code === 'not-ended', J(rfin))

// ================================================================= FORGED hub frames (to A)
const R2 = rid('ragent/R2'), FQ = (action, extra = {}) => ({ session: 'Remote', project: 'ACTS', user: 'robin', id: R2, action, ...extra })
const n0 = nodeOf(await board(A), 'Remote', 'ragent/R2')?.state
const raw0 = await rawSock('127.0.0.2', A_PORT, null)
raw0.send({ t: 'ACTIVITY_ACT', rid: 'f0', q: FQ('done'), by: { user: 'mallory' } })
const f0 = await raw0.res('f0')
const raw1 = await rawSock('127.0.0.2', A_PORT, { session: 'FAKEHOST/hello-only' })
raw1.send({ t: 'ACTIVITY_ACT', rid: 'f1', q: FQ('done'), by: { user: 'mallory' } })
const f1 = await raw1.res('f1')
check('forged: an ACTIVITY_ACT on a socket with NO hello → unauthorized; with a hello but NOT an adopted peer hub → unauthorized; nothing changed', f0?.code === 'unauthorized' && f1?.code === 'unauthorized' && nodeOf(await board(A), 'Remote', 'ragent/R2')?.state === n0 && n0 === 'todo', J([f0, f1, n0]))
raw0.close(); raw1.close()
const raw2 = await rawSock('127.0.0.2', A_PORT, { session: 'FAKEHOST/peer', peer: true, fmt: 6 })
raw2.send({ t: 'ACTIVITY_ACT', rid: 'f2', q: FQ('done', { host: HB }), by: { user: 'mallory' } })
const f2 = await raw2.res('f2')
raw2.send({ t: 'ACTIVITY_ACT', rid: 'f3', origin: 'ACT-B', q: FQ('done'), by: { user: 'mallory' } })
const f3 = await raw2.res('f3')
check('forged: an adopted (v6) peer naming ANOTHER owner (q.host) → not-owner; a frame claiming another origin → unauthorized; still unchanged', f2?.code === 'not-owner' && f3?.code === 'unauthorized' && nodeOf(await board(A), 'Remote', 'ragent/R2')?.state === 'todo', J([f2, f3]))
raw2.send({ t: 'ACTIVITY_ACT', rid: 'f4', q: FQ('skip'), by: { user: 'mallory', host: 'EVIL', kind: 'dashboard' } })
const f4 = await raw2.res('f4')
const re4 = (await logOf(A, { session: 'Remote', id: R2, own: true })).entries[0] || {}
check('forged: an action can\'t claim another host — attributed to the LINK\'s host (FAKEHOST), never the frame\'s "EVIL"', f4?.ok === true && re4.by?.host === 'FAKEHOST' && re4.by?.user === 'mallory' && !J(re4).includes('EVIL'), J([f4, re4.by]))
raw2.close()

// ================================================================= dismiss PERSISTS across a gateway restart (B)
dash.close()
await stop(B)
B = await spawn('HubB', '127.0.0.1', B_PORT, HB, envB)
const b6 = await until(() => board(B, { session: 'Lead' }), b => !!nodeOf(b, 'Lead', 'fresh'), 15000)
check('restart: B replays its files — the dismissed agent stays OFF the board (and the dismissed session), the rest is back with the SAME ids', !!nodeOf(b6, 'Lead', 'fresh') && !nodeOf(b6, 'Lead', 'helper') && !group(await board(B), 'Leaver') && nodeOf(b6, 'Lead', 'lead/I1')?.state === 'done'
  && ['lead', 'lead/I1', 'owner', 'owner/o1', '#70'].every(p => nodeOf(b6, 'Lead', p)?.id === idOf(p)), J((group(b6, 'Lead')?.nodes || []).map(n => n.path)))
const dash2 = await wsClient(Number(B_PORT) + 1, 'dashboard')
check('restart: the action states survive too (the lead finished, its plan-end marker: abandon_plan → no-open-plan; the owner\'s plan still open: reopen_plan → not-ended)', !!nodeOf(b6, 'Lead', 'lead')?.finished_at && nodeOf(b6, 'Lead', 'owner/o1')?.state === 'todo'
  && (await dash2.action(Q(idOf('lead'), 'abandon_plan'))).code === 'no-open-plan' && (await dash2.action(Q(idOf('owner'), 'reopen_plan'))).code === 'not-ended')
dash2.close()
const rl2 = await logOf(B, { session: 'Lead' })
check('restart: the dismissal\'s entry is still in the session\'s log', rl2.entries.some(e => e.dismiss === true && e.of === idOf('helper') && e.act === 'dismiss'), J(rl2.entries.slice(0, 4).map(e => [e.path, e.act])))

// ================================================================= the entry count stays EXACT across restarts (the cf's log_n)
const G0 = await spawn('HubG', '127.0.0.3', G_PORT, HG, { ...fileOf(dirs.G), AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_SEEDS: '' })
await until(() => call(G0, 'my_identity'), i => i.role === 'gateway', 10000)
const glog = await wsClient(Number(G_PORT) + 1, 'logger', { host: '127.0.0.3', ident: { session: 'Counter', project: 'ACTS', user: 'robin' } })
let okN = 0
for (let i = 1; i <= 5; i++) { const ref = `c${i}`; glog.ws.send(J({ type: 'log', ref, input: { path: 'counted', text: `entry ${i}` } })); const r = await until(async () => glog.msgs.find(m => m.type === 'logged' && m.ref === ref), x => !!x, 3000, 30); if (r?.result?.ok) okN++ }
glog.close()
check('count fixture: 5 entries logged on G (a script-only session through the logger leaf)', okN === 5, J([glog.welcome && glog.welcome.type, glog.msgs.slice(0, 3)]))
await stop(G0)
const G1 = await spawn('HubG', '127.0.0.3', G_PORT, HG, { ...fileOf(dirs.G), AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_SEEDS: '', AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: String(Math.round(6.5 * DAY)) })
const cf1 = await until(async () => (await call(G1, 'activity', { tap: true, session: '-none-' })).tap?.carry_forward, x => !!x, 15000)
check('count: a restart 6.5 days later writes the startup carry-forward (the quiet node is about to leave the window)', (cf1?.written || 0) >= 1, J(cf1))
await stop(G1)
const G2 = await spawn('HubG', '127.0.0.3', G_PORT, HG, { ...fileOf(dirs.G), AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_SEEDS: '', AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: String(10 * DAY) })
const gb = await until(() => board(G2, { session: 'Counter' }), b => !!nodeOf(b, 'Counter', 'counted'), 15000)
const cn = nodeOf(gb, 'Counter', 'counted')
const cpg = await logOf(G2, { session: 'Counter', id: cn?.id, own: true })
check('count (6d): 10 days later (the entries are all outside the replay window) the node\'s count is still EXACT — log_n 5, the log page\'s total 5', cn?.log_n === 5 && cpg.total === 5, J([cn?.log_n, cpg.total, cpg.entries?.length]))
await stop(G2)

check('no response, frame or push carried the realm token', !seen.some(t => t.includes(TOKEN)))
console.log(`\n${pass} passed, ${fail} failed`)
for (const h of [...all]) await stop(h)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
