// #82 (v1.69.0) — live: the PLAN WORKFLOW on real bridges. Insert plan items anywhere (before / after / first / last, several in
// their given order) and reorder (the `log` tool and tools/aimb-log.mjs); MOVE a node with its subtree (its history follows it:
// memory, the day files under the old path, the counts) and a RESTART that replays the moves and the order; abandon an ordinary
// context with the CASCADE; dashboard Move up / Move to (local and forwarded to the owner over the hub link) sending the #80
// notice; and the GOSSIP of ranks + moves to a second host. Temp persist dirs + a temp AI_BRIDGE_CONFIG (never src/config.json);
// a test-set token that is never printed. Loopback "hosts":
//   B  127.0.0.1 "NOT-B"  dashboard dashB; session Lead (registered here); restarted once (file persistence)
//   A  127.0.0.2 "NOT-A"  dashboard dashA — it moves B's node (forwarded to the owner B)
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawn as spawnProc } from 'node:child_process'
import { WebSocket } from 'ws'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 15100)   // #81: this file's port block (15100 = its first port name)
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const SCRIPT = path.join(SRCDIR, 'tools', 'aimb-log.mjs')
const TOKEN = 'act82-' + crypto.randomBytes(9).toString('hex')
const B_PORT = String(tp(15100)), A_PORT = String(tp(15102))
const HB = 'NOT-B', HA = 'NOT-A'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-82-'))
const dirs = { A: fs.mkdtempSync(path.join(tmp, 'pA-')), B: fs.mkdtempSync(path.join(tmp, 'pB-')) }
const cfgFile = path.join(tmp, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { notice_batch_sec: 1, log_entries_per_agent: 10 } }))   // a short notice window; a small memory log (paging reaches the files)
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
async function stop(h) { try { await h.transport.close() } catch { } all.splice(all.indexOf(h), 1); await sleep(400) }
const fileOf = d => ({ AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: d })
const call = async (b, n, a = {}) => { try { const t = (await b.c.callTool({ name: n, arguments: a })).content[0].text; seen.push(t); return JSON.parse(t) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 150) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
const board = async (h, q = {}) => (await call(h, 'activity', q)).sessions || []
const sessOf = (b, name) => b.find(s => String(s.session).toLowerCase() === name.toLowerCase())
const nodeOf = (b, name, p) => (sessOf(b, name)?.nodes || []).find(x => x.path === p)
// the children of `parent` in display order: plan items, then contexts, then agents — each by rank (the board's rank field)
const kidsOf = (b, name, parent) => (sessOf(b, name)?.nodes || []).filter(n => n.parent === parent).sort((x, y) => (g => g(x) - g(y))(n => (n.plan_item ? 0 : n.kind === 'context' ? 1 : 2)) || (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : 0)).map(n => n.name)
const logOf = async (h, q) => ((await call(h, 'activity', { log: { limit: 50, ...q } })).log || { entries: [] })
async function logAll(h, q) {   // every page (memory, then the day files)
  const out = []; let cursor = null, n = 0
  do { const lg = await logOf(h, { ...q, limit: 5, ...(cursor ? { cursor } : {}) }); out.push(...(lg.entries || [])); cursor = lg.next_cursor || null } while (cursor && ++n < 30)
  return out
}
const notes = async (h, name, secret) => ((await call(h, 'inbox', { for: name, secret, cursor: 0 })).messages || []).filter(m => m.verb === 'activity_changed')
const bodyOf = m => { try { return JSON.parse(m.body) } catch { return {} } }
function wsClient(port, kind, extra = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${extra.host || '127.0.0.1'}:${port}`), C = { ws, msgs: [], n: 0, welcome: null }
    C.send = o => ws.send(J(o))
    C.action = async (msg, ms = 8000) => { const ref = `r${++C.n}`; C.send({ type: 'activity_action', ref, ...msg }); const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = C.msgs.find(x => x.type === 'activity_action' && x.ref === ref); if (m) return m.result; await sleep(30) } return { ok: false, code: 'no-answer' } }
    C.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => ws.send(J({ type: 'hello', kind, token: TOKEN, instance: `t-${kind}-${port}` })))
    ws.on('message', raw => { const s = String(raw); seen.push(s); const m = JSON.parse(s); C.msgs.push(m); if (m.type === 'welcome' || m.type === 'error') { C.welcome = m; resolve(C) } })
    ws.on('close', () => resolve(C)); ws.on('error', () => resolve(C))
  })
}
function script(args) {   // tools/aimb-log.mjs as a child process → { code, out (the JSON line) }
  return new Promise(resolve => {
    const env = { ...process.env, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_WS_PORT: String(Number(B_PORT) + 1), AI_BRIDGE_USER: 'robin' }
    delete env.AI_BRIDGE_TOKEN_FILE; delete env.AI_BRIDGE_REALM
    const p = spawnProc('node', [SCRIPT, '--session', 'Scripted', '--project', 'P82', ...args], { cwd: SRCDIR, env })
    let out = ''; p.stdout.on('data', d => { out += d }); p.stderr.on('data', () => { })
    p.on('exit', code => { seen.push(out); let j = null; try { j = JSON.parse(out.trim().split('\n').pop()) } catch { } resolve({ code, out: j }) })
  })
}

// ================================================================= B and A, linked
let B = await spawn('HubB', '127.0.0.1', B_PORT, HB, { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT}` })
await sleep(600)
const A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` })
const ids = await Promise.all([A, B].map(h => call(h, 'my_identity')))
check('harness: A and B are gateways on ≥ 1.69.0', ids.every(i => i.role === 'gateway' && (v => v[0] > 1 || (v[0] === 1 && v[1] >= 69))(String(i.bridge_version).split('.').map(Number))), J(ids.map(i => [i.role, i.bridge_version])))
await until(() => call(B, 'list_sessions'), r => (r.sessions || []).some(s => String(s.session).startsWith(HA + '/')), 10000)
await call(B, 'register_self', { name: 'Lead', secret: 'l', project: 'P82' })
const L = input => call(B, 'log', { as: 'Lead', secret: 'l', ...input })

// ================================================================= INSERT anywhere (the tool)
const p0 = await L({ path: '@Next', plan: ['A', 'B', 'C'] })
const p1 = await L({ path: '@Next', plan: ['X', 'Y'], before: 'B' })
let bB = await board(B)
check('insert (tool): plan + before "B" puts the new items there IN THE GIVEN ORDER — A X Y B C; the result carries their ranks', p0.ok && p1.ok && J(kidsOf(bB, 'Lead', '@Next')) === J(['A', 'X', 'Y', 'B', 'C']) && p1.plan.every(i => i.created && i.rank), J([kidsOf(bB, 'Lead', '@Next'), p1]))
const p2 = await L({ path: '@Next', plan: ['F'], position: 'first' }), p3 = await L({ path: '@Next', plan: ['Z'], after: 'C' }), p4 = await L({ path: '@Next', plan: ['E'] })
bB = await board(B)
check('insert (tool): position first; after the last item; no position = the end', p2.ok && p3.ok && p4.ok && J(kidsOf(bB, 'Lead', '@Next')) === J(['F', 'A', 'X', 'Y', 'B', 'C', 'Z', 'E']), J(kidsOf(bB, 'Lead', '@Next')))
const bad1 = await L({ path: '@Next', plan: ['Q'], before: 'Nope' }), bad2 = await L({ path: '@Next/@~A', before: 'A', after: 'B' })
check('insert (tool): an unknown anchor → unknown-anchor (nothing created); two positions → bad-position', bad1.code === 'unknown-anchor' && bad2.code === 'bad-position' && !nodeOf(await board(B), 'Lead', '@Next/@Q'), J([bad1, bad2]))
// ---- REORDER
const r1 = await L({ path: '@Next/@~C', before: 'A' })
bB = await board(B)
check('reorder (tool): path "@Next/@~C" + before "A", no text — C moves before A, its line untouched; logged "placed before @A"', r1.ok && r1.rank && J(kidsOf(bB, 'Lead', '@Next')) === J(['F', 'C', 'A', 'X', 'Y', 'B', 'Z', 'E'])
  && nodeOf(bB, 'Lead', '@Next/@C').current?.text === 'C' && (await logOf(B, { session: 'Lead', path: '@Next/@C', own: true })).entries[0]?.text === 'placed before @A', J([r1, kidsOf(bB, 'Lead', '@Next')]))
// ---- the SCRIPT: --item + --before, --first, reorder with --path @~, --move / --to
const s1 = await script(['--path', '@Plan', '--item', 'one', '--item', 'two', '--item', 'three'])
const s2 = await script(['--path', '@Plan', '--item', 'a1', '--item', 'a2', '--before', 'two'])
const s3 = await script(['--path', '@Plan/@~three', '--first'])
const s4 = await script(['--path', '@Plan/@~one', '--after', 'two', '--text', 'started one', '--state', 'running'])
bB = await board(B)
check('script: --item "a1" --item "a2" --before "two" → one a1 a2 two; --path "@Plan/@~three" --first; --after with text + state (the line set too)',
  [s1, s2, s3, s4].every(r => r.code === 0 && r.out?.ok) && J(kidsOf(bB, 'Scripted', '@Plan')) === J(['three', 'a1', 'a2', 'two', 'one']) && nodeOf(bB, 'Scripted', '@Plan/@one')?.current?.text === 'started one', J([[s1, s2, s3, s4].map(r => r.code + ' ' + J(r.out).slice(0, 120)), kidsOf(bB, 'Scripted', '@Plan')]))
const s5 = await script(['--first', '--last', '--path', '@Plan/@~one'])
const s6 = await script(['--move', '@Plan/@a1', '--to', '@Later'])
bB = await board(B)
check('script: --move "@Plan/@a1" --to "@Later" (a NEW parent, created) — exit 0; --first with --last → exit 64', s5.code === 64 && s6.code === 0 && s6.out?.moved?.from === '@Plan/@a1' && !!nodeOf(bB, 'Scripted', '@Later/@a1') && !nodeOf(bB, 'Scripted', '@Plan/@a1') && nodeOf(bB, 'Scripted', '@Later/@a1').plan_item === true, J([s5, s6]))

// ================================================================= MOVE with history (12 entries on A > the memory cap of 10)
for (let i = 1; i <= 12; i++) await L({ path: '@Next/@~A', text: `step ${i}`, ...(i === 1 ? { state: 'running' } : {}) })
await L({ path: '@Next/@A/@~sub', text: 'a sub-context of A' })
await L({ path: '@Later', plan: ['L1'] })
const before = nodeOf(await board(B), 'Lead', '@Next/@A')
const mv = await L({ move: '@Next/@A', to: '@Later' })
bB = await board(B)
const moved = nodeOf(bB, 'Lead', '@Later/@A')
check('move (tool): @Next/@A → @Later/@A with its subtree; nothing left at the old path; the plan item goes to the END of the target plan', mv.ok && mv.moved?.from === '@Next/@A' && mv.moved?.to === '@Later/@A' && !!moved && !!nodeOf(bB, 'Lead', '@Later/@A/@sub') && !nodeOf(bB, 'Lead', '@Next/@A') && J(kidsOf(bB, 'Lead', '@Later')) === J(['L1', 'A']), J([mv, kidsOf(bB, 'Lead', '@Later')]))
check('move: it keeps its line, state, plan-item marker, created_at — and its entry count (+1: the move)', moved && moved.plan_item && moved.current?.text === 'step 12' && moved.state === 'running' && moved.created_at === before.created_at && moved.log.total === before.log.total + 1, J([before, moved]))
const hist = await logAll(B, { session: 'Lead', path: '@Later/@A', own: true })
check('move: its log pages through EVERYTHING — the move entry, then the 12 steps written under the OLD path (memory, then the day files), all shown at its path now',
  hist[0]?.text === 'moved by Lead from @Next/@A to @Later' && J(hist.slice(1).map(e => e.text)) === J([...Array.from({ length: 12 }, (_, i) => `step ${12 - i}`), 'A']) && hist.every(e => e.path === '@Later/@A') && hist.length === 14, J(hist.map(e => e.text)))
const mvBad = [await L({ move: '@Later/@A', to: '@Later' }), await L({ move: '@Later', to: '@Later/@A' }), await L({ move: '@Nope', to: '@Later' }), await L({ move: '@Later/@A', to: '@Later', text: 'x' })]
check('move errors: no-change, into itself (bad-move), unknown-node, a move with text (bad-move)', J(mvBad.map(r => r.code)) === J(['no-change', 'bad-move', 'unknown-node', 'bad-move']), J(mvBad))

// ================================================================= ABANDON any context + the CASCADE
await L({ path: '@Big/@~ctx', text: 'an open context' })
await L({ path: '@Big/@ctx', plan: ['i1', 'i2'] })
await L({ path: '@Big/@ctx/@~i2', state: 'done' })
await L({ path: '@Big/w1/@~root', text: 'an agent under Big' })
const ab = await L({ path: '@~Big', text: 'not doing this', state: 'abandoned' })
bB = await board(B)
check('abandon: an ORDINARY context (no plan) can be abandoned', ab.ok && nodeOf(bB, 'Lead', '@Big')?.state === 'abandoned', J(ab))
check('cascade: its open contexts / items are abandoned too (deepest first, each "abandoned with @Big"); done items and agents keep theirs',
  J((ab.cascade || []).map(c => [c.path, c.from_state])) === J([['@Big/@ctx/@i1', 'todo'], ['@Big/@ctx', 'running']]) && nodeOf(bB, 'Lead', '@Big/@ctx/@i1')?.state === 'abandoned' && nodeOf(bB, 'Lead', '@Big/@ctx/@i2')?.state === 'done'
  && nodeOf(bB, 'Lead', '@Big/w1')?.state === 'running' && (await logOf(B, { session: 'Lead', path: '@Big/@ctx/@i1', own: true })).entries[0]?.text === 'abandoned with @Big', J(ab.cascade))

// ================================================================= GOSSIP to A: ranks + the move
const bA = await until(() => board(A), b => J(kidsOf(b, 'Lead', '@Later')) === J(['L1', 'A']) && !nodeOf(b, 'Lead', '@Next/@A'), 8000)
check('gossip: A shows B\'s plan in B\'s order (stored ranks ride the slice) and the move (old path removed, new one there)', J(kidsOf(bA, 'Lead', '@Next')) === J(kidsOf(bB, 'Lead', '@Next')) && J(kidsOf(bA, 'Lead', '@Later')) === J(['L1', 'A']) && !nodeOf(bA, 'Lead', '@Next/@A')
  && nodeOf(bA, 'Lead', '@Next/@C')?.rank_set === true && nodeOf(bA, 'Lead', '@Big/@ctx/@i1')?.state === 'abandoned', J([kidsOf(bA, 'Lead', '@Next'), kidsOf(bB, 'Lead', '@Next')]))

// ================================================================= DASHBOARD actions: reorder + move (local), move forwarded from A, notices
const dashB = await wsClient(Number(B_PORT) + 1, 'dashboard')
const dashA = await wsClient(Number(A_PORT) + 1, 'dashboard', { host: '127.0.0.2' })
const Q = (path, action, args) => ({ host: HB, session: 'Lead', project: 'P82', user: 'robin', path, action, args })
const n0 = (await notes(B, 'Lead', 'l')).length
const up = await dashB.action(Q('@Next/@Y', 'reorder', { before: '@"X"' }))
const nUp = await until(() => notes(B, 'Lead', 'l'), ms => ms.length > n0, 8000)
bB = await board(B)
check('dashboard Move up (reorder before the previous sibling): applied — Y before X; the session hears "robin moved @Next/@Y before @X"', up.ok && up.where === 'before @X' && kidsOf(bB, 'Lead', '@Next').indexOf('Y') === kidsOf(bB, 'Lead', '@Next').indexOf('X') - 1
  && nUp.length === n0 + 1 && nUp.at(-1).subject === 'robin moved @Next/@Y before @X' && bodyOf(nUp.at(-1)).action === 'reorder', J([up, nUp.map(m => m.subject)]))
const mvD = await dashB.action(Q('@Next/@B', 'move', { to: '@Later' }))
const nMv = await until(() => notes(B, 'Lead', 'l'), ms => ms.length > n0 + 1, 8000)
bB = await board(B)
check('dashboard Move to…: applied — @Next/@B → @Later/@B (end of that plan); logged "moved by robin via dashboard (NOT-B) from …"; the notice "robin moved @Next/@B to @Later"',
  mvD.ok && mvD.moved_from === '@Next/@B' && J(kidsOf(bB, 'Lead', '@Later')) === J(['L1', 'A', 'B']) && nMv.at(-1)?.subject === 'robin moved @Next/@B to @Later' && bodyOf(nMv.at(-1)).moved_from === '@Next/@B'
  && (await logOf(B, { session: 'Lead', path: '@Later/@B', own: true })).entries[0]?.text === `moved by robin via dashboard (${HB}) from @Next/@B to @Later`, J([mvD, nMv.map(m => m.subject)]))
dashA.send({ type: 'activity_sub' })
const boardMsg = await until(async () => dashA.msgs.find(m => m.type === 'activity_board'), x => !!x, 6000, 50)
check('dashboard head: A lists B among its remote hosts with plan:true (B applies move / reorder)', !!boardMsg && (boardMsg.head?.remote_hosts || []).some(r => r.host === HB && r.plan === true), J(boardMsg?.head?.remote_hosts))
const fw = await dashA.action(Q('@Later/@B', 'move', { to: '@Next', position: 'first' }))
const nFw = await until(() => notes(B, 'Lead', 'l'), ms => ms.length > n0 + 2, 8000)
bB = await board(B)
check('federated: A\'s dashboard moves B\'s node — forwarded to the OWNER B (ACTIVITY_ACT), applied there, attributed to A\'s dashboard, B\'s session told',
  fw.ok && fw.host === HB && kidsOf(bB, 'Lead', '@Next')[0] === 'B' && nFw.at(-1)?.subject === 'robin moved @Later/@B to @Next' && bodyOf(nFw.at(-1)).by?.host === HA, J([fw, nFw.map(m => m.subject)]))
const abD = await dashB.action(Q('@Pot', 'abandon', {}))
check('dashboard abandon on an unknown node → unknown-node; a move / reorder with bad args → bad-args', abD.code === 'unknown-node' && (await dashB.action(Q('@Later/@A', 'move', {}))).code === 'bad-args' && (await dashB.action(Q('@Later/@A', 'reorder', {}))).code === 'bad-args')

// ================================================================= RESTART B: the replay honours the moves and the order
const order0 = { next: kidsOf(bB, 'Lead', '@Next'), later: kidsOf(bB, 'Lead', '@Later'), plan: kidsOf(bB, 'Scripted', '@Plan') }
await stop(B)
B = await spawn('HubB', '127.0.0.1', B_PORT, HB, { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT}` })
const bR = await until(() => board(B), b => !!nodeOf(b, 'Lead', '@Later/@A') && !!sessOf(b, 'Scripted'), 15000)
check('restart: the order is rebuilt exactly (stored ranks from the records)', J(kidsOf(bR, 'Lead', '@Next')) === J(order0.next) && J(kidsOf(bR, 'Lead', '@Later')) === J(order0.later) && J(kidsOf(bR, 'Scripted', '@Plan')) === J(order0.plan), J([order0, kidsOf(bR, 'Lead', '@Next'), kidsOf(bR, 'Lead', '@Later')]))
check('restart: every moved node is where it was moved to — nothing at the old paths; its subtree with it; still a plan item', !nodeOf(bR, 'Lead', '@Next/@A') && !!nodeOf(bR, 'Lead', '@Later/@A/@sub') && nodeOf(bR, 'Lead', '@Later/@A').plan_item === true
  && nodeOf(bR, 'Lead', '@Later/@A').current?.text === 'step 12' && !!nodeOf(bR, 'Lead', '@Next/@B') && !nodeOf(bR, 'Lead', '@Later/@B') && !!nodeOf(bR, 'Scripted', '@Later/@a1'), J(sessOf(bR, 'Lead')?.nodes.map(n => n.path)))
check('restart: the moved node\'s count includes its entries from before the move', nodeOf(bR, 'Lead', '@Later/@A').log.total === moved.log.total, J([nodeOf(bR, 'Lead', '@Later/@A').log, moved.log]))
const hist2 = await logAll(B, { session: 'Lead', path: '@Later/@A', own: true })
check('restart: its log still pages through the move and the 12 steps under the old path', J(hist2.map(e => e.text)) === J(hist.map(e => e.text)), J(hist2.map(e => e.text)))
const sub2 = await logAll(B, { session: 'Lead', path: '@Later' })
const runEnd = await (async () => { let cursor = null, last = null, n = 0; do { last = await logOf(B, { session: 'Lead', path: '@Later', limit: 5, ...(cursor ? { cursor } : {}) }); cursor = last.next_cursor || null } while (cursor && ++n < 30); return last })()
const earlier = runEnd.earlier_cursor ? await logAll(B, { session: 'Lead', path: '@Later', cursor: runEnd.earlier_cursor, earlier: true }) : []
check('restart: the new parent\'s merged log includes the moved node\'s entries (they live under it now) — its recent ones, and (written before @Later began: "show earlier runs") the older steps',
  sub2.some(e => e.text === 'step 12' && e.path === '@Later/@A') && sub2.some(e => e.text === 'a sub-context of A' && e.path === '@Later/@A/@sub') && runEnd.run_start === true && earlier.some(e => e.text === 'step 1' && e.path === '@Later/@A'), J([sub2.map(e => [e.path, e.text]), runEnd.run_start, earlier.map(e => e.text)]))
check('restart: the abandoned context and its cascade are as they were', nodeOf(bR, 'Lead', '@Big')?.state === 'abandoned' && nodeOf(bR, 'Lead', '@Big/@ctx/@i1')?.state === 'abandoned' && nodeOf(bR, 'Lead', '@Big/@ctx/@i2')?.state === 'done')

check('no response, frame or push carried the realm token', !seen.some(t => t.includes(TOKEN)))
console.log(`\n${pass} passed, ${fail} failed`)
for (const x of [dashA, dashB]) x.close()
for (const h of [...all]) await stop(h)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
