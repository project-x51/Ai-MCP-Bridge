// #80 (v1.68.0) — live: a dashboard action TELLS the owning session. The gateway that owns the node sends the node's session a
// SYSTEM message, verb `activity_changed` (subject "robin skipped @Dash test/@Docs", body { action, path, host, from_state,
// to_state, by:{ user, host }, entry_id, … }); several within notice_batch_sec become ONE message (body.actions:[…]). Temp
// persist dirs + a temp AI_BRIDGE_CONFIG (never src/config.json); a test-set token that is never printed. Loopback "hosts":
//   B  127.0.0.1 "NOT-B"  dashboard dashB; session Lead (registered here), Off (registered, then offline), scripts Cross + Scripty
//   A  127.0.0.2 "NOT-A"  dashboard dashA; session Remote (registered here) + the sub-peer "cross" of B's script session Cross
//   C  127.0.0.3 "NOT-C"  alone, a 60 s window: prepare-shutdown flushes the queued notice
// Covers: one action → one message (fields, the entry id), the doorbell waking on it; a burst → ONE batched message;
// view-only / refused actions and reads send nothing; across hosts both ways (B's dashboard → A's node → A's session; A's
// dashboard → B's node → B's session); a recipient on ANOTHER host than the node (matched case-insensitively); an offline
// session's notice PARKED and drained on its return; a script-only session gets nothing; the shutdown flush.
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawn as spawnProc } from 'node:child_process'
import { WebSocket } from 'ws'
import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 15000)   // #81: this file's port block (15000 = its first port name)
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const DOORBELL = path.join(SRCDIR, 'tools', 'aimb-doorbell.mjs')
const TOKEN = 'act80-' + crypto.randomBytes(9).toString('hex')
const B_PORT = String(tp(15000)), A_PORT = String(tp(15002)), C_PORT = String(tp(15004))
const HB = 'NOT-B', HA = 'NOT-A', HC = 'NOT-C'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-80-'))
const dirs = { A: fs.mkdtempSync(path.join(tmp, 'pA-')), B: fs.mkdtempSync(path.join(tmp, 'pB-')), C: fs.mkdtempSync(path.join(tmp, 'pC-')) }
const cfgFile = path.join(tmp, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { notice_batch_sec: 2 } }))   // the window (the default is 3 s)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const seen = []   // every raw response / frame text: none may carry the token
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).split(TOKEN).join('<TOKEN>'))) }
const J = JSON.stringify

const all = []
function spawn(name, bind, port, host, extra = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
      AI_BRIDGE_STABLE_IDS: '1', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', AI_BRIDGE_TEST_GOSSIP: '', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => { const h = { c, transport, name }; all.push(h); return h })
}
async function stop(h) { try { await h.transport.close() } catch { } all.splice(all.indexOf(h), 1); await sleep(300) }
const fileOf = d => ({ AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: d })
const call = async (b, n, a = {}) => { try { const t = (await b.c.callTool({ name: n, arguments: a })).content[0].text; seen.push(t); return JSON.parse(t) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 150) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
const board = async (h, q = {}) => (await call(h, 'activity', q)).sessions || []
const nodeOf = (b, name, p) => (b.find(s => String(s.session).toLowerCase() === name.toLowerCase())?.nodes || []).find(x => x.path === p)
const logOf = async (h, q) => ((await call(h, 'activity', { log: { limit: 50, ...q } })).log || { entries: [] })
const notes = async (h, name, secret) => ((await call(h, 'inbox', { for: name, secret, cursor: 0 })).messages || []).filter(m => m.verb === 'activity_changed')
const bodyOf = m => { try { return JSON.parse(m.body) } catch { return {} } }
function wsClient(port, kind, extra = {}) {   // a dashboard (or a logger with ident) on a gateway's WS port
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${extra.host || '127.0.0.1'}:${port}`), C = { ws, msgs: [], n: 0, welcome: null }
    C.send = o => ws.send(J(o))
    C.action = async (msg, ms = 8000) => { const ref = `r${++C.n}`; C.send({ type: 'activity_action', ref, ...msg }); const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = C.msgs.find(x => x.type === 'activity_action' && x.ref === ref); if (m) return m.result; await sleep(30) } return { ok: false, code: 'no-answer' } }
    C.log = async input => { const ref = `l${++C.n}`; C.send({ type: 'log', ref, input }); const r = await until(async () => C.msgs.find(m => m.type === 'logged' && m.ref === ref), x => !!x, 4000, 30); return r ? r.result : { ok: false, code: 'no-answer' } }
    C.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => ws.send(J({ type: 'hello', kind, token: TOKEN, ...(kind === 'logger' ? { ident: extra.ident } : { instance: `t-${kind}-${port}` }) })))
    ws.on('message', raw => { const s = String(raw); seen.push(s); const m = JSON.parse(s); C.msgs.push(m); if (m.type === 'welcome' || m.type === 'error') { C.welcome = m; resolve(C) } })
    ws.on('close', () => resolve(C))
    ws.on('error', () => resolve(C))
  })
}

// ================================================================= the mesh: B and A linked
let B = await spawn('HubB', '127.0.0.1', B_PORT, HB, { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT}` })
await sleep(600)
const A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` })
const ids = await Promise.all([A, B].map(h => call(h, 'my_identity')))
check('harness: A and B are gateways on ≥ 1.68.0', ids.every(i => i.role === 'gateway' && (v => v[0] > 1 || (v[0] === 1 && v[1] >= 68))(String(i.bridge_version).split('.').map(Number))), J(ids.map(i => [i.role, i.bridge_version])))
const linked = await until(() => call(B, 'list_sessions'), r => (r.sessions || []).some(s => String(s.session).startsWith(HA + '/')), 10000)
check('harness: A is linked to B', (linked.sessions || []).some(s => String(s.session).startsWith(HA + '/')))

// ---- fixtures: B's Lead (a plan of four), A's Remote, B's script sessions Cross (its sub-peer "cross" lives on A) + Scripty, B's Off
await call(B, 'register_self', { name: 'Lead', secret: 'l', project: 'ACTS' })
const L = input => call(B, 'log', { as: 'Lead', secret: 'l', ...input })
const lp = await L({ path: '@"Dash test"', plan: ['Docs', 'Code', 'Ship', 'Extra'] })
await call(A, 'register_self', { name: 'Remote', secret: 'r', project: 'ACTS' })
const rp = await call(A, 'log', { as: 'Remote', secret: 'r', path: '@Rplan', plan: ['R1', 'R2'] })
await call(A, 'register_self', { name: 'cross', secret: 'x', project: 'acts' })   // the case differs from the script's: matching is case-insensitive
const lgCross = await wsClient(Number(B_PORT) + 1, 'logger', { ident: { session: 'CROSS', project: 'ACTS', user: 'robin' } })
const xl = await lgCross.log({ path: '@P', plan: ['X1'] })
const lgScript = await wsClient(Number(B_PORT) + 1, 'logger', { ident: { session: 'Scripty', project: 'ACTS', user: 'robin' } })
const sl = await lgScript.log({ path: '@S', plan: ['S1'] })
const off = await call(B, 'register_self', { name: 'Off', secret: 'o', project: 'ACTS' })
const ol = await call(B, 'log', { as: 'Off', secret: 'o', path: '@Q', plan: ['Q1'] })
await call(B, 'deregister', { peer_id: off.peer_id, secret: 'o' })
check('fixtures: plans reported (Lead + Off on B, Remote on A, the script sessions Cross + Scripty on B)', [lp, rp, xl, sl, ol].every(r => r && r.ok), J([lp, rp, xl, sl, ol].map(r => r && r.code)))
const gb = await until(() => board(A), b => !!nodeOf(b, 'Lead', '@"Dash test"/@Extra') && !!nodeOf(b, 'CROSS', '@P/@X1'), 8000)
const ga = await until(() => board(B), b => !!nodeOf(b, 'Remote', '@Rplan/@R2'), 8000)
check('fixtures: each host\'s plans are on the other\'s board (gossip)', !!nodeOf(gb, 'Lead', '@"Dash test"/@Extra') && !!nodeOf(ga, 'Remote', '@Rplan/@R2'))
const roster = await until(() => call(B, 'list_sessions'), r => (r.sessions || []).flatMap(s => s.subpeers || []).some(s => s.name === 'cross'), 6000)
check('fixtures: B\'s roster holds A\'s sub-peer "cross"', (roster.sessions || []).flatMap(s => s.subpeers || []).some(s => s.name === 'cross'))

const dashB = await wsClient(Number(B_PORT) + 1, 'dashboard')
const dashA = await wsClient(Number(A_PORT) + 1, 'dashboard', { host: '127.0.0.2' })
check('dashboards: welcomed on B and A', dashB.welcome?.type === 'welcome' && dashA.welcome?.type === 'welcome')
const Q = (path, action, extra = {}) => ({ host: HB, session: 'Lead', project: 'ACTS', user: 'robin', path, action, ...extra })

// ================================================================= ONE action → ONE message
const t1 = Date.now()
const a1 = await dashB.action(Q('@"Dash test"/@Docs', 'skip'))
const early = await notes(B, 'Lead', 'l')
const n1 = await until(() => notes(B, 'Lead', 'l'), ms => ms.length >= 1, 8000)
const dt = Date.now() - t1
check('one action: applied as before (the dashboard\'s result unchanged)', a1.ok && a1.host === HB && a1.action === 'skip' && a1.path === '@"Dash test"/@Docs', J(a1))
check('one action: the session\'s inbox gets ONE activity_changed message — after the batch window (not at once)', early.length === 0 && n1.length === 1 && dt >= 1500, J([early.length, n1.length, dt]))
const m1 = n1[0] || {}, b1 = bodyOf(m1)
const e1 = (await logOf(B, { session: 'Lead', path: '@"Dash test"/@Docs', own: true })).entries[0] || {}
check('message: subject "robin skipped @Dash test/@Docs"', m1.subject === 'robin skipped @Dash test/@Docs', m1.subject)
check('message: body { action skip, path, host NOT-B (the owner), from_state todo, to_state skipped, by:{user robin, host NOT-B}, entry_id = the logged entry, session, project, text }',
  b1.action === 'skip' && b1.path === '@"Dash test"/@Docs' && b1.host === HB && b1.from_state === 'todo' && b1.to_state === 'skipped' && J(b1.by) === J({ user: 'robin', host: HB })
  && !!b1.entry_id && b1.entry_id === e1.id && e1.act === 'skip' && b1.session === 'Lead' && b1.project === 'ACTS' && b1.text === 'Docs', J([b1, e1.id]))
check('message: sent by the gateway (from = B\'s bridge session)', String(m1.from?.session || m1.from || '').startsWith(HB + '/'), J(m1.from))

// ================================================================= a BURST → ONE batched message
const burst = [await dashB.action(Q('@"Dash test"/@Code', 'skip')), await dashB.action(Q('@"Dash test"/@Ship', 'abandon')), await dashB.action(Q('@"Dash test"/@Extra', 'skip'))]
const n2 = await until(() => notes(B, 'Lead', 'l'), ms => ms.length >= 2, 9000)
await sleep(2500)   // nothing else may follow
const n2b = await notes(B, 'Lead', 'l')
const m2 = n2b[1] || {}, b2 = bodyOf(m2)
check('batch: three actions within the window → exactly ONE more message', burst.every(r => r.ok) && n2.length === 2 && n2b.length === 2, J([burst.map(r => r.code), n2b.length]))
check('batch: subject "robin skipped 2 items and abandoned 1 in @Dash test"', m2.subject === 'robin skipped 2 items and abandoned 1 in @Dash test', m2.subject)
check('batch: body { actions:[3, in order, each with its fields], count 3, session, project, host }', b2.count === 3 && J((b2.actions || []).map(a => [a.action, a.path, a.from_state, a.to_state])) === J([['skip', '@"Dash test"/@Code', 'todo', 'skipped'], ['abandon', '@"Dash test"/@Ship', 'todo', 'abandoned'], ['skip', '@"Dash test"/@Extra', 'todo', 'skipped']])
  && (b2.actions || []).every(a => a.entry_id && a.by?.user === 'robin' && a.host === HB) && b2.session === 'Lead' && b2.host === HB, J(b2))

// ================================================================= view-only / refused actions and reads send NOTHING
const vo = [await dashB.action(Q('@"Dash test"/@Docs', 'pin')), await dashB.action(Q('@"Dash test"/@Docs', 'hide')), await dashB.action(Q('@"Dash test"/@Docs', 'copy')),
  await dashB.action(Q('@"Dash test"/@Docs', 'skip')), await dashB.action(Q('@"Dash test"/@Nope', 'done'))]
await call(B, 'activity', { log: { session: 'Lead', limit: 5 } })
dashB.send({ type: 'activity_sub' })
await sleep(3500)
check('view-only: pin / hide / copy are not bridge actions (bad-action; they live in the browser) and a refused action (no-change, unknown-node) or a read changes nothing — no message',
  J(vo.map(r => r.code)) === J(['bad-action', 'bad-action', 'bad-action', 'no-change', 'unknown-node']) && (await notes(B, 'Lead', 'l')).length === 2, J([vo.map(r => r.code), (await notes(B, 'Lead', 'l')).length]))

// ================================================================= the session's DOORBELL wakes on a notice (no inbox read meanwhile)
const bellOut = { out: '', code: null }
const bell = spawnProc('node', [DOORBELL, '--name', 'Lead', '--project', 'ACTS', '--token', TOKEN, '--url', `ws://127.0.0.1:${Number(B_PORT) + 1}`, '--timeout', '20'], { cwd: SRCDIR })
bell.stdout.on('data', d => { bellOut.out += d.toString() })
const bellExit = new Promise(r => bell.on('exit', c => { bellOut.code = c; r(c) }))
await sleep(1500)
const rc = await dashB.action(Q('@"Dash test"/@Code', 'reopen'))
await Promise.race([bellExit, sleep(9000)])
let bj = null; try { bj = JSON.parse(bellOut.out.trim().split('\n').pop()) } catch { }
const n3 = await notes(B, 'Lead', 'l')
check('doorbell: the session\'s armed doorbell WAKES on the notice (exit 0, reason mail) — and it is that notice', rc.ok && bellOut.code === 0 && bj?.reason === 'mail' && n3.length === 3 && n3[2].subject === 'robin reopened @Dash test/@Code', `exit ${bellOut.code} ${bellOut.out} ${n3.length}`)
try { bell.kill() } catch { }

// ================================================================= ACROSS HOSTS
// B's dashboard acts on A's node → A (the owner) applies it and tells A's session
const r1 = await dashB.action({ host: HA, session: 'Remote', project: 'ACTS', user: 'robin', path: '@Rplan/@R1', action: 'done' })
const rn = await until(() => notes(A, 'Remote', 'r'), ms => ms.length >= 1, 8000)
const rb = bodyOf(rn[0] || {})
check('federated B → A: applied by the owner A; A\'s session Remote gets the message — host NOT-A (the owner), by { robin, NOT-B } (the dashboard\'s host)',
  r1.ok && r1.host === HA && rn.length === 1 && rn[0].subject === 'robin marked @Rplan/@R1 done' && rb.host === HA && J(rb.by) === J({ user: 'robin', host: HB }) && rb.from_state === 'todo' && rb.to_state === 'done', J([r1, rn.map(m => m.subject), rb]))
check('federated B → A: the message comes from A\'s gateway (the owner sends it, not the dashboard\'s host)', String(rn[0]?.from?.session || rn[0]?.from || '').startsWith(HA + '/'), J(rn[0]?.from))
// A's dashboard acts on B's node → B applies it and tells B's session
const r2 = await dashA.action({ host: HB, session: 'Lead', project: 'ACTS', user: 'robin', path: '@"Dash test"/@Docs', action: 'done' })
const ln = await until(() => notes(B, 'Lead', 'l'), ms => ms.length >= 4, 8000)
const lb = bodyOf(ln[3] || {})
check('federated A → B: applied by the owner B; B\'s session Lead gets it — host NOT-B, by { robin, NOT-A }, skipped → done',
  r2.ok && r2.host === HB && ln.length === 4 && lb.host === HB && J(lb.by) === J({ user: 'robin', host: HA }) && lb.from_state === 'skipped' && lb.to_state === 'done' && ln[3]?.subject === 'robin marked @Dash test/@Docs done', J([r2, lb]))
check('federated: nobody else was told (Remote still has 1)', (await notes(A, 'Remote', 'r')).length === 1)
// a recipient on ANOTHER host than the node: the script session CROSS logs on B; its sub-peer "cross" (project "acts") is on A
const x1 = await dashB.action({ host: HB, session: 'CROSS', project: 'ACTS', user: 'robin', path: '@P/@X1', action: 'skip' })
const xn = await until(() => notes(A, 'cross', 'x'), ms => ms.length >= 1, 8000)
check('recipient mesh-wide: B (the owner) finds the session\'s sub-peer on A — matched case-insensitively (CROSS/ACTS ↔ cross/acts)', x1.ok && xn.length === 1 && bodyOf(xn[0]).path === '@P/@X1' && bodyOf(xn[0]).host === HB, J([x1, xn.map(m => m.subject)]))

// ================================================================= an OFFLINE session: parked, drained on its return
const o1 = await dashB.action({ host: HB, session: 'Off', project: 'ACTS', user: 'robin', path: '@Q/@Q1', action: 'skip' })
await sleep(3000)
const back = await call(B, 'register_self', { name: 'Off', secret: 'o', project: 'ACTS' })
const on = await notes(B, 'Off', 'o')
check('offline: the notice is PARKED for the offline session and delivered when it registers again', o1.ok && back.ok !== false && on.length === 1 && on[0].subject === 'robin skipped @Q/@Q1' && bodyOf(on[0]).to_state === 'skipped', J([o1.code, on.map(m => m.subject)]))

// ================================================================= a SCRIPT-ONLY session: the log entry only
const s1 = await dashB.action({ host: HB, session: 'Scripty', project: 'ACTS', user: 'robin', path: '@S/@S1', action: 'skip' })
await sleep(3000)
const se = (await logOf(B, { session: 'Scripty', path: '@S/@S1', own: true })).entries[0] || {}
const sreg = await call(B, 'register_self', { name: 'Scripty', secret: 's', project: 'ACTS' })
const sn = await notes(B, 'Scripty', 's')
check('script-only: the action is logged on the node, and nothing was sent or parked (registering afterwards finds no notice)', s1.ok && se.act === 'skip' && sreg.ok !== false && sn.length === 0, J([s1.code, se.act, sn.length]))
check('script-only: no other session received it', (await notes(B, 'Lead', 'l')).length === 4 && (await notes(A, 'cross', 'x')).length === 1)

// ================================================================= shutdown FLUSHES a queued notice (C: a 60 s window)
const C = await spawn('HubC', '127.0.0.3', C_PORT, HC, { ...fileOf(dirs.C), AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_SEEDS: '', AI_BRIDGE_ACTIVITY_NOTICE_BATCH_SEC: '60' })
await until(() => call(C, 'my_identity'), i => i.role === 'gateway', 10000)
await call(C, 'register_self', { name: 'Solo', secret: 'z', project: 'ACTS' })
await call(C, 'log', { as: 'Solo', secret: 'z', path: '@Z', plan: ['Z1'] })
const dashC = await wsClient(Number(C_PORT) + 1, 'dashboard', { host: '127.0.0.3' })
const c1 = await dashC.action({ host: HC, session: 'Solo', project: 'ACTS', user: 'robin', path: '@Z/@Z1', action: 'skip' })
await sleep(2500)
const before = (await notes(C, 'Solo', 'z')).length
const ps = await new Promise(resolve => {
  const req = http.request({ host: '127.0.0.3', port: Number(C_PORT) + 1, path: '/admin/prepare-shutdown', method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }, res => { let d = ''; res.on('data', x => { d += x }); res.on('end', () => { seen.push(d); try { resolve(JSON.parse(d)) } catch { resolve({ raw: d }) } }) })
  req.on('error', e => resolve({ error: String(e) })); req.end()
})
const after = await until(() => notes(C, 'Solo', 'z'), ms => ms.length >= 1, 4000)
check('shutdown: with a 60 s window nothing has gone yet; POST /admin/prepare-shutdown flushes it (notices: 1) and the session has it', c1.ok && before === 0 && ps.ok === true && ps.notices === 1 && after.length === 1 && after[0].subject === 'robin skipped @Z/@Z1', J([c1.code, before, ps, after.length]))

check('no response, frame or push carried the realm token', !seen.some(t => t.includes(TOKEN)))
console.log(`\n${pass} passed, ${fail} failed`)
for (const x of [dashA, dashB, dashC, lgCross, lgScript]) x.close()
for (const h of [...all]) await stop(h)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
