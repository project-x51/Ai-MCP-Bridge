// Fast UNIT tests for #88 (v2.0) build step 7 — GOSSIP v6 (lib/activity2-gossip.js): no bridge, no sockets
// (docs/spec-88.md §6, §8 step 7). Covered:
//   - the v6 UNIT: one per node, by id (id, p | root, c, key, scope, label, nk, type) — no path, no details / data (has_*
//     flags), merged nodes not sent; the session header names its root's id;
//   - a FULL slice applied on another host gives the SAME board: every row (id, path, kind, type, state, line, bar,
//     display — counts, tests, status, took —, plan items, log count) equal to the owner's own;
//   - DELTAS BY ID: a rename and a move change ONE unit (the descendants' paths follow on the receiver), a line change the
//     node + its activity chain only, a removal lists only the TOPMOST removed node (its subtree goes with it), a merge's
//     children (moved out of the removed node) are sent again in full — the receiver never keeps a stale copy;
//   - the wire rules: a delta only on top of the held (epoch, seq) (out-of-sync otherwise, and before any full slice), a
//     full slice replaces, v5 / v1 bodies → bad-version, our own origin refused, junk units dropped (bad ids, a parent
//     cycle, a second root, a context claiming the session kind), an orphan (parent not held yet) hidden until its parent
//     arrives, the byte cap (newest-active first, the rest in the next frames);
//   - a host DOWN → its agents and live lines show gone; a fresh full slice clears it; expireRemote2 drops it after the window;
//   - reads: remoteBoard2 (host / session filters), locateRemote2, findRemoteLine2, knownHost2, remoteInfo2; actionQuery2
//     (the id-valued args kept and bounded, the 1.7x path args dropped);
//   - a seeded GOSSIP FUZZ: 150 random histories (reports, plans, renames, moves, merges, unmerges, --move-to buckets that
//     vanish, questions, test results, dismissals, expiry) gossiped as deltas under random byte caps — the receiver's board
//     equals the owner's AND a fresh full slice's after every flush.
import { testOnly } from '../helpers/check.mjs'
import * as A from '../../lib/activity.js'
import * as M from '../../lib/activity2.js'
import * as S from '../../lib/activity2-store.js'
import * as G from '../../lib/activity2-gossip.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.stack} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
function section(name, fn) { try { fn() } catch (e) { fail++; console.log(`FAIL section "${name}" crashed:`, (e && e.stack) || e) } }

const OWNER = 'ROBIN-Z790', PEER = 'LITTLE-001'
const LEAD = { session: 'Lead', project: 'AIMB', user: 'robin', realm: 'default' }
const DASH = { kind: 'dashboard', user: 'robin', host: OWNER }
const T0 = new Date(2026, 9, 1, 9, 0, 0).getTime()
const MIN = 60000
function world() {
  const st = M.createModel({ origin: OWNER, config: { log_entries_per_agent: 50 } })
  let now = T0
  const w = { st, get now() { return now }, tick: (ms = 1000) => { now += ms; return now } }
  w.call = (input, ident = LEAD) => { const r = M.applyCall(st, ident, input, w.tick()); if (!r.ok) throw new Error(`${J(input)} → ${J(r)}`); return r }
  w.try = (input, ident = LEAD) => M.applyCall(st, ident, input, w.tick())
  w.action = q => M.applyAction2(st, { ...LEAD, ...q }, w.tick(), { by: DASH })
  w.sess = (ident = LEAD) => M.getSession2(st, ident)
  return w
}
/** The owner's own rows of a session (store.board's walk). */
function ownRows(sess, now) {
  const memo = new Map(), out = []
  const walk = (n, d) => { out.push(S.nodeRow2(sess, n, d, now, memo, 15)); for (const c of M.childrenOf2(sess, n)) walk(c, d + 1) }
  walk(M.rootOf(sess), 0)
  return out
}
/** What must be equal on every host (the rows minus nothing time-relative that differs: both are computed at the same now). */
const proj = r => J({ id: r.id, path: r.path, kind: r.kind, type: r.type, key: r.key, scope: r.scope, label: r.label, parent: r.parent, depth: r.depth, plan_item: !!r.plan_item, transient: !!r.transient,
  test: r.test || null, state: r.state, stale_at: r.stale_at, rank: r.rank, created_at: r.created_at, run_at: r.run_at, runs: r.runs, last_activity: r.last_activity,
  current: r.current ? { id: r.current.id, ts: r.current.ts, text: r.current.text, state: r.current.state, has_details: r.current.has_details, has_data: r.current.has_data, question: r.current.question || null } : null,
  progress: r.progress, eta_at: r.eta_at, finished_at: r.finished_at, implicit: r.implicit, log_n: r.log_n, display: r.display })
const sameBoard = (ownSessRows, remoteRows) => ownSessRows.length === remoteRows.length && ownSessRows.every((r, i) => proj(r) === proj(remoteRows[i]))
const diffBoard = (a, b) => J({ own: a.map(r => r.path), remote: b.map(r => r.path), first: (() => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (!a[i] || !b[i] || proj(a[i]) !== proj(b[i])) return [a[i] && proj(a[i]), b[i] && proj(b[i])]; return null })() })
/** A link: the owner's published view + a receiver; send() = the next frame (full first), applied → its body. */
function link(w, o = {}) {
  const L = { pub: G.createPub2(), rem: G.createRemote2({ origin: PEER }), seq: 0, epoch: o.epoch || 'ep1', needFull: true, frames: [] }
  L.send = (maxBytes) => {
    const full = L.needFull
    const plan = G.planSlice2(w.st, L.pub, { full, maxBytes })
    if (!plan.body) return null
    const f = { ...plan.body, epoch: L.epoch, seq: L.seq + 1, ...(full ? {} : { base: L.seq }) }
    L.seq++; L.needFull = false
    const r = G.applySlice2(L.rem, OWNER, f)
    if (!r.ok) throw new Error(`apply: ${J(r)}`)
    L.frames.push(f)
    return f
  }
  L.flush = (maxBytes) => { let f, n = 0; while ((f = L.send(maxBytes)) && n++ < 500) { if (!f.truncated) break } return n }
  L.rows = (q = {}) => G.remoteBoard2(L.rem, q, w.now, 15)
  return L
}
const sessRows = (L, name = 'Lead') => (L.rows().find(s => s.session === name) || { nodes: [] }).nodes
const unitsOf = f => (f.sessions || []).flatMap(s => s.nodes || [])

// ---------------------------------------------------------------------------------------------------------------
section('units', () => {
  const w = world()
  const ag = w.call({ agent: 'w1', label: 'Worker 1', text: '@reading', state: 'running', progress: '1/4 docs', details: 'SECRET-DETAILS', data: { x: 1 } })
  const docs = w.call({ agent: 'w1', key: 'docs', label: 'Docs', text: '@writing', plan: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })
  w.call({ agent: 'w1', key: 'a', state: 'done' })
  w.call({ agent: 'w1', key: 'ref', label: 'Ref', text: 'r' })
  const into = w.call({ agent: 'w1', key: 'ref2', label: 'Ref 2', text: 'r2' })
  w.call({ agent: 'w1', key: 'ref', merge: 'ref2' })
  const u = G.gossipUnits2(w.st)
  const ents = [...u.ents.values()].map(e => e.ent)
  const sess = w.sess(), hdr = [...u.sessions.values()][0].hdr
  check('units: one per node by id — id, p (the parent id), c (the creator id), key, scope, label, nk, type; NO path', ents.every(e => /^[a-z2-7]{16}$/.test(e.id) && !('path' in e))
    && ents.find(e => e.id === docs.node.id)?.p === ag.node.id && ents.find(e => e.id === docs.node.id)?.c === ag.node.id && ents.find(e => e.id === docs.node.id)?.key === 'docs' && ents.find(e => e.id === docs.node.id)?.scope === 'w1'
    && ents.find(e => e.id === docs.node.id)?.label === 'Docs' && ents.find(e => e.id === docs.node.id)?.nk === 'context' && ents.find(e => e.id === ag.node.id)?.type === 'agent', J(ents.find(e => e.id === docs.node.id)))
  check('units: the session root carries root:true and no p; the header names its id (root_id)', ents.filter(e => e.root).length === 1 && ents.find(e => e.root).id === sess.rootId && !('p' in ents.find(e => e.root)) && hdr.root_id === sess.rootId, J(hdr))
  check('units: the line without details / data — has_details / has_data flags only', !J(ents).includes('SECRET-DETAILS') && ents.find(e => e.id === ag.node.id)?.current?.has_details === true && ents.find(e => e.id === ag.node.id)?.current?.has_data === true)
  check('units: plan items carry plan_item + plan_ix; a merged node is NOT sent (it is a hidden child)', ents.filter(e => e.plan_item).length === 2 && !ents.some(e => e.label === 'Ref') && ents.some(e => e.id === into.node.id), J(ents.map(e => e.label)))
  check('units: equal state serialises identically (canonical JSON, no null / false fields)', J(G.gossipUnits2(w.st).ents.get([...u.ents.keys()][0]).json) === J([...u.ents.values()][0].json) && !/:null|:false/.test([...u.ents.values()].map(e => e.json).join('')))
})

// ---------------------------------------------------------------------------------------------------------------
section('full slice = the same board', () => {
  const w = world()
  w.call({ agent: 'lead', label: 'Lead agent', text: '@coordinating', state: 'running' })
  w.call({ agent: 'lead', key: 'rel', label: 'Next release', context_type: 'plan', plan: [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }, { key: 'z', label: 'Z' }] })
  w.call({ agent: 'lead', key: 'x', state: 'running', text: '@on it' }); w.tick(4 * MIN)
  w.call({ agent: 'lead', key: 'x', state: 'done' })
  w.call({ agent: 'lead', key: 'y', state: 'skipped' })
  w.call({ agent: 'lead', key: 'ideas', label: 'Ideas', context_type: 'group', text: 'a list' })
  w.call({ agent: 'lead', key: 'i1', label: 'Idea one', under: 'ideas', text: '@one' })
  w.call({ agent: 'lead', key: 'i2', label: 'Idea two', under: 'ideas', text: '@two', state: 'done' })
  w.call({ agent: 'lead', key: 'tests', label: 'Tests', context_type: 'test-run', text: '@running the suite', state: 'running' })
  w.call({ agent: 'lead', key: 'pending', label: 'Pending', under: 'tests', transient: true, plan: [{ key: 't1', label: 'T1' }, { key: 't2', label: 'T2' }] })
  w.call({ agent: 'lead', key: 't1', state: 'running', move_to: '/Lead agent/Tests/In progress' })
  w.call({ agent: 'lead', key: 't1', message_type: 'test-result', fields: { result: 'pass', checks: 22, duration: '4.1s' }, move_to: '/Lead agent/Tests/Passed' })
  w.call({ agent: 'lead', key: 'q', label: 'Which DB', ask: 'Which database should the cache use?', choices: ['Postgres', 'SQLite'] })
  w.call({ agent: 'lead/helper', label: 'Helper', text: '@helping', state: 'running', under: 'rel', stale_after: '30m' })
  w.call({ agent: 'lead/helper', text: '@finished', state: 'done' })
  const L = link(w)
  L.flush()
  const own = ownRows(w.sess(), w.now), rem = sessRows(L)
  check('full: every row equal on the receiver (ids, paths, types, states, lines, bars, a group\'s count, a test-run\'s tests bar, a question\'s status, took, plan items, log counts)', sameBoard(own, rem), diffBoard(own, rem))
  const at = p => rem.find(r => r.path === p)
  check('full: … spot checks — the plan "1 of 3 · 1 skipped", the group "1 open · 1 done", the test-run 1 passed, the question open, the helper done', at('Lead agent/Next release')?.display?.bar?.done === 1 && at('Lead agent/Next release')?.display?.bar?.skipped === 1
    && at('Lead agent/Ideas')?.display?.count?.text === '1 open · 1 done' && at('Lead agent/Tests')?.display?.tests?.passed === 1 && at('Lead agent/Which DB')?.current?.question?.status === 'asked'
    && at('Lead agent/Next release/Helper')?.state === 'done' && at('Lead agent/Next release/X')?.display?.took?.text === 'took 4m 1s', J(rem.map(r => [r.path, r.state, r.display])))
  check('full: the rows are tagged with the owner host and remote:true', L.rows()[0].host === OWNER && L.rows()[0].remote === true && L.rows()[0].root_id === w.sess().rootId)
})

// ---------------------------------------------------------------------------------------------------------------
section('deltas by id', () => {
  const w = world()
  const ag = w.call({ agent: 'w1', label: 'Worker', text: '@hi', state: 'running' })
  const docs = w.call({ agent: 'w1', key: 'docs', label: 'Docs', text: '@d', plan: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })
  const notes = w.call({ agent: 'w1', key: 'notes', label: 'Notes', text: '@n' })
  const deep = w.call({ agent: 'w1', key: 'deep', label: 'Deep', under: 'notes', text: '@deep' })
  const L = link(w)
  L.flush()
  w.call({ agent: 'w1', key: 'docs', rename: 'Documents' })
  let f = L.send()
  check('delta: a RENAME is ONE unit (the node, its new label); the receiver\'s descendants follow (Worker/Documents/A)', unitsOf(f).length === 1 && unitsOf(f)[0].id === docs.node.id && sessRows(L).some(r => r.path === 'Worker/Documents/A'), J(f))
  w.call({ agent: 'w1', key: 'notes', move: 'docs' })
  f = L.send()
  check('delta: a MOVE is ONE unit (the moved node: its new p); its child\'s path follows (Worker/Documents/Notes/Deep)', unitsOf(f).length === 1 && unitsOf(f)[0].id === notes.node.id && unitsOf(f)[0].p === docs.node.id && sessRows(L).some(r => r.path === 'Worker/Documents/Notes/Deep' && r.id === deep.node.id), J(f))
  w.call({ agent: 'w1', key: 'deep', text: 'logged only' })
  f = L.send()
  check('delta: a report changes the node + its activity chain up to its agent (never a sibling, never another subtree)', unitsOf(f).every(u => [deep.node.id, notes.node.id, docs.node.id, ag.node.id].includes(u.id)) && unitsOf(f).some(u => u.id === deep.node.id), J(unitsOf(f).map(u => u.label)))
  check('delta: nothing changed → no frame (a heartbeat is the bridge\'s)', L.send() === null)
  check('delta: after each frame the receiver equals the owner', sameBoard(ownRows(w.sess(), w.now), sessRows(L)), diffBoard(ownRows(w.sess(), w.now), sessRows(L)))
  // a removal: the topmost only; its subtree goes with it (a finished helper agent with contexts below it, dismissed)
  const hp = w.call({ agent: 'w1/helper', label: 'Helper', text: '@helping', state: 'running' })
  w.call({ agent: 'w1/helper', key: 'h1', label: 'H1', text: '@h1' })
  w.call({ agent: 'w1/helper', key: 'h2', label: 'H2', under: 'h1', text: '@h2' })
  w.call({ agent: 'w1/helper', text: '@done', state: 'done' })
  L.send()
  const r = w.action({ id: hp.node.id, action: 'dismiss', args: { stale_min: 15 } })
  f = r.ok ? L.send() : null
  check('delta: a dismissed subtree is ONE removal (the topmost id) — the receiver drops its whole subtree', r.ok === true && f && (f.remove || []).length === 1 && f.remove[0].id === hp.node.id && !sessRows(L).some(x => x.path.startsWith('Worker/Helper'))
    && sameBoard(ownRows(w.sess(), w.now), sessRows(L)), J([r.code, f]))
  // a merge whose node has children: the children are sent again in full (the published subtree was forgotten)
  const m1 = w.call({ agent: 'w1', key: 'm1', label: 'M1', text: 'm1' })
  const k1 = w.call({ agent: 'w1', key: 'k1', label: 'Kid 1', under: 'm1', text: 'k1' })
  const k2 = w.call({ agent: 'w1', key: 'k2', label: 'Kid 2', under: 'm1', text: 'k2' })
  const m2 = w.call({ agent: 'w1', key: 'm2', label: 'M2', text: 'm2' })
  L.flush()
  w.call({ agent: 'w1', key: 'm1', merge: 'm2' })
  f = L.send()
  check('delta: a MERGE = the merged node\'s removal + its children re-sent under the target (their new p) — the receiver ends equal', (f.remove || []).some(x => x.id === m1.node.id) && [k1, k2].every(k => unitsOf(f).some(u => u.id === k.node.id && u.p === m2.node.id))
    && sameBoard(ownRows(w.sess(), w.now), sessRows(L)), J([f, diffBoard(ownRows(w.sess(), w.now), sessRows(L))]))
  w.call({ agent: 'w1', key: 'm1', unmerge: true })
  L.send()
  check('delta: an UNMERGE brings the node back (a new unit) — still equal', sessRows(L).some(x => x.id === m1.node.id && x.path === 'Worker/M1') && sameBoard(ownRows(w.sess(), w.now), sessRows(L)), diffBoard(ownRows(w.sess(), w.now), sessRows(L)))
  // a whole session leaving: removal without an id
  w.call({ agent: 'x', label: 'X', text: '@x' }, { ...LEAD, session: 'Other' })
  L.send()
  const ro = w.action({ session: 'Other', id: M.getSession2(w.st, { ...LEAD, session: 'Other' }).rootId, action: 'dismiss', args: { stale_min: 0.0001 } })
  f = L.send()
  check('delta: a session leaving (its root dismissed) = a removal without an id; the receiver drops the session', !ro.ok || ((f.remove || []).some(x => x.session === 'Other' && !x.id) && !L.rows().some(s => s.session === 'Other')), J([ro.code, f]))
})

// ---------------------------------------------------------------------------------------------------------------
section('wire rules', () => {
  const w = world()
  w.call({ agent: 'w1', label: 'Worker', text: '@hi' })
  const rem = G.createRemote2({ origin: PEER })
  const full = G.planSlice2(w.st, G.createPub2(), { full: true }).body
  check('wire: a delta before any full slice → out-of-sync', G.applySlice2(rem, OWNER, { v: 6, epoch: 'e', seq: 2, base: 1, sessions: [] }).code === 'out-of-sync')
  check('wire: v5 / v1 bodies → bad-version (a 1.7x slice is never misread)', G.applySlice2(rem, OWNER, { v: 5, full: true, sessions: [] }).code === 'bad-version' && G.applySlice2(rem, OWNER, { v: 1, full: true, sessions: [] }).code === 'bad-version')
  check('wire: our own origin is refused', G.applySlice2(rem, PEER, { ...full, epoch: 'e', seq: 1 }).code === 'own-origin')
  check('wire: a full slice is taken; a delta on the wrong base / epoch → out-of-sync', G.applySlice2(rem, OWNER, { ...full, epoch: 'e', seq: 1 }).ok && G.applySlice2(rem, OWNER, { v: 6, epoch: 'e', seq: 3, base: 2, sessions: [] }).code === 'out-of-sync'
    && G.applySlice2(rem, OWNER, { v: 6, epoch: 'other', seq: 2, base: 1, sessions: [] }).code === 'out-of-sync' && G.applySlice2(rem, OWNER, { v: 6, epoch: 'e', seq: 2, base: 1, sessions: [] }).ok)
  const s0 = full.sessions[0], root = s0.nodes.find(n => n.root), ag = s0.nodes.find(n => n.nk === 'agent')
  const junk = { ...s0, nodes: [...s0.nodes,
    { id: 'NOT-AN-ID', p: root.id, label: 'bad id', nk: 'context' },
    { id: 'aaaaaaaaaaaaaaaa', p: 'bbbbbbbbbbbbbbbb', label: 'cycle a', nk: 'context' }, { id: 'bbbbbbbbbbbbbbbb', p: 'aaaaaaaaaaaaaaaa', label: 'cycle b', nk: 'context' },
    { id: 'cccccccccccccccc', root: true, label: 'second root', nk: 'session' },
    { id: 'dddddddddddddddd', p: ag.id, label: 'a context as session', nk: 'session' },
    { id: 'eeeeeeeeeeeeeeee', p: 'ffffffffffffffff', label: 'orphan', nk: 'context' },
    { id: 'gggggggggggggggg', p: ag.id, label: '', nk: 'context' }] }
  const rem2 = G.createRemote2({ origin: PEER })
  G.applySlice2(rem2, OWNER, { v: 6, full: true, epoch: 'e', seq: 1, sessions: [junk, { session: 'NoRoot', nodes: [] }] })
  const rows = G.remoteBoard2(rem2, {}, w.now, 15)
  check('wire: junk units are dropped — a bad id, a second root, a context claiming the session kind, an empty label; a session record without root_id', rows.length === 1 && !J(rows).includes('bad id') && !J(rows).includes('second root') && !J(rows).includes('a context as session') && rows[0].nodes.length === 2, J(rows))
  check('wire: a parent CYCLE never reaches the board (unreachable from the root, no endless walk) and an orphan waits hidden', !J(rows).includes('cycle') && !J(rows).includes('orphan'))
  const rem3 = G.createRemote2({ origin: PEER })
  G.applySlice2(rem3, OWNER, { v: 6, full: true, epoch: 'e', seq: 1, sessions: [{ ...s0, nodes: [{ id: 'eeeeeeeeeeeeeeee', p: ag.id, label: 'kid first', nk: 'context', last_activity: 5 }] }] })
  const r3a = G.remoteBoard2(rem3, {}, w.now, 15)[0].nodes
  G.applySlice2(rem3, OWNER, { v: 6, epoch: 'e', seq: 2, base: 1, sessions: [{ ...s0, nodes: [ag] }] })
  const r3b = G.remoteBoard2(rem3, {}, w.now, 15)[0].nodes
  check('wire: a unit whose parent arrives LATER (a truncated frame) shows once the parent is held; the root is a placeholder until its own unit', r3a.length === 1 && r3a[0].path === '' && r3b.map(r => r.path).join('|') === '|Worker|Worker/kid first', J([r3a, r3b.map(r => r.path)]))
  // the byte cap: newest-active first, the rest in the next frames
  const w2 = world()
  for (let i = 1; i <= 12; i++) w2.call({ agent: `a${String(i).padStart(2, '0')}`, label: `Agent ${i}`, text: `@batch ${i} ${'x'.repeat(150)}` })
  const L2 = link(w2)
  const f1 = L2.send(900)
  const order = unitsOf(f1).filter(u => u.nk === 'agent').map(u => Number(u.label.split(' ')[1]))
  check('cap: a full slice over the cap is TRUNCATED, newest-active first', f1.truncated === true && order.length >= 1 && order.length < 12 && order[0] === 12 && J(order) === J([...order].sort((a, b) => b - a)), J([f1.truncated, order]))
  let n = 1
  while (L2.send(900)) n++
  check('cap: the rest follows in later frames until the receiver equals the owner', n >= 2 && sameBoard(ownRows(w2.sess(), w2.now), sessRows(L2)), J(n))
})

// ---------------------------------------------------------------------------------------------------------------
section('down, gone, expiry, reads', () => {
  const w = world()
  const ag = w.call({ agent: 'w1', label: 'Worker', text: '@working', state: 'running' })
  w.call({ agent: 'w1', key: 'c', label: 'Ctx', text: '@live line', state: 'running' })
  w.call({ agent: 'w1', key: 'p', label: 'Plan', plan: [{ key: 'i', label: 'Item' }] })
  const L = link(w)
  L.flush()
  check('down: markOriginDown2 → true; the agent and its context\'s live line show GONE, a plan item keeps its state, lines kept', G.markOriginDown2(L.rem, OWNER, w.now) === true
    && sessRows(L).find(r => r.path === 'Worker')?.state === 'gone' && sessRows(L).find(r => r.path === 'Worker/Ctx')?.state === 'gone' && sessRows(L).find(r => r.path === 'Worker/Plan/Item')?.state === 'todo'
    && sessRows(L).find(r => r.path === 'Worker')?.current?.text === 'working' && L.rows()[0].down_at === w.now, J(sessRows(L).map(r => [r.path, r.state])))
  check('down: a delta while down → out-of-sync (a full slice is asked for)', G.applySlice2(L.rem, OWNER, { v: 6, epoch: L.epoch, seq: L.seq + 1, base: L.seq, sessions: [] }).code === 'out-of-sync')
  L.needFull = true; L.epoch = 'ep2'; L.send()
  check('down: a fresh FULL slice (the host is back) clears gone', sessRows(L).find(r => r.path === 'Worker')?.state === 'running' && !L.rows()[0].down_at)
  G.markOriginDown2(L.rem, OWNER, w.now)
  check('expiry: a host down shorter than the window stays; past it, it leaves (expireRemote2 names it)', J(G.expireRemote2(L.rem, w.now + 1000, 3600000)) === '[]' && J(G.expireRemote2(L.rem, w.now + 3600000, 3600000)) === J([OWNER]) && L.rem.hosts.size === 0)
  L.needFull = true; L.send()
  w.call({ agent: 'w1', text: 'with a details', details: 'D' })
  w.call({ agent: 'w1', label: 'Worker', text: '@current', details: 'D2' }, { ...LEAD, session: 'Two' })
  L.send()
  const two = M.getSession2(w.st, { ...LEAD, session: 'Two' })
  const lineId = [...two.nodes.values()].find(n => n.kind === 'agent' || n.parent == null && n.current)?.current?.id || [...two.nodes.values()].find(n => n.current)?.current?.id
  check('reads: remoteBoard2 filters by session / host; locateRemote2 finds a session (project / user / host)', L.rows({ session: 'Two' }).length === 1 && L.rows({ host: 'nope' }).length === 0 && L.rows({ host: OWNER.toLowerCase() }).length === 2
    && G.locateRemote2(L.rem, { session: 'lead', project: 'aimb' }).length === 1 && G.locateRemote2(L.rem, { session: 'Lead', user: 'someone' }).length === 0, J(L.rows().map(s => s.session)))
  check('reads: findRemoteLine2 finds the host of a remote CURRENT line by its entry id; knownHost2 is case-insensitive; remoteInfo2', G.findRemoteLine2(L.rem, lineId) === OWNER && G.findRemoteLine2(L.rem, 'act_nope') === null
    && G.knownHost2(L.rem, OWNER.toLowerCase()) === OWNER && G.remoteInfo2(L.rem)[0].host === OWNER && G.remoteInfo2(L.rem)[0].sessions === 2 && G.remoteInfo2(L.rem)[0].nodes > 0, J([lineId, G.remoteInfo2(L.rem)]))
  check('reads: the agent\'s id on the receiver = the owner\'s', sessRows(L).find(r => r.path === 'Worker')?.id === ag.node.id)
  const q = G.actionQuery2({ session: 'Lead', project: 'AIMB', user: 'robin', id: ag.node.id, action: 'move', path: 'Worker', args: { to_id: 'x'.repeat(100), to: 'Old/path', before: 'Y', label: 'L'.repeat(2000), merges: [{ id: 'a', into_id: 'b', junk: 1 }, 'bad'], stale_min: '15', text: 't', choice: 'c', state: 'done', evil: { a: 1 } } })
  check('actionQuery2: the id-valued args kept and bounded (to_id ≤ 64, label ≤ 1024, merges as { id, into_id | label }), the 1.7x path args and junk dropped', q.id === ag.node.id && !('path' in q) && q.args.to_id.length === 64 && !('to' in q.args) && !('before' in q.args) && q.args.label.length === 1024
    && J(q.args.merges) === J([{ id: 'a', into_id: 'b' }, {}]) && q.args.stale_min === 15 && !('evil' in q.args), J(q))
})

// ---------------------------------------------------------------------------------------------------------------
section('gossip fuzz', () => {
  let seedBad = null, histories = 0, frames = 0, removes = 0, truncs = 0
  for (let seed = 1; seed <= 150 && !seedBad; seed++) {
    let s = seed * 2654435761 >>> 0
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
    const pick = a => a[Math.floor(rnd() * a.length)]
    const w = world()
    const L = link(w)
    const sessions = [LEAD, { ...LEAD, session: 'Side' }]
    const agents = ['a1', 'a2', 'a2/sub']
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']
    const labels = ['Docs', 'Notes', 'Build', 'Ship', 'Tests', 'Ideas']
    try {
      for (const ag of ['a1', 'a2']) w.call({ agent: ag, label: `Agent ${ag}`, text: `@${ag} working`, state: 'running' })
      w.call({ agent: 'a2/sub', label: 'Sub', text: '@sub', state: 'running' })
      for (let i = 0; i < 60; i++) {
        const ident = rnd() < 0.85 ? LEAD : sessions[1], agent = pick(agents), key = pick(keys), op = rnd()
        let r = null
        if (op < 0.22) r = w.try({ agent, key, label: pick(labels), text: rnd() < 0.5 ? `@line ${i}` : `entry ${i}`, ...(rnd() < 0.4 ? { state: pick(['running', 'blocked', 'done', 'idle']) } : {}), ...(rnd() < 0.3 ? { progress: `${Math.floor(rnd() * 5)}/5` } : {}), ...(rnd() < 0.3 ? { under: pick(keys) } : {}) }, ident)
        else if (op < 0.32) r = w.try({ agent, key, label: pick(labels), plan: [{ key: `${key}i1`, label: 'One' }, { key: `${key}i2`, label: 'Two' }] }, ident)
        else if (op < 0.4) r = w.try({ agent, key: `${pick(keys)}i${pick([1, 2])}`, state: pick(['done', 'skipped', 'running', 'todo']) }, ident)
        else if (op < 0.47) r = w.try({ agent, key, rename: `${pick(labels)} ${i}` }, ident)
        else if (op < 0.55) r = w.try({ agent, key, move: pick(keys) }, ident)
        else if (op < 0.6) r = w.try({ agent, key, merge: pick(keys) }, ident)
        else if (op < 0.63) r = w.try({ agent, key, unmerge: true }, ident)
        else if (op < 0.71) r = w.try({ agent, key, label: pick(labels), text: `@moving ${i}`, move_to: pick(['/Queue', '/Done', '../Bucket']) }, ident)
        else if (op < 0.75) r = w.try({ agent, key: `q${i}`, label: `Q ${i}`, ask: 'Which one should we use?', choices: ['This', 'That'] }, ident)
        else if (op < 0.8) r = w.try({ agent, key, label: pick(labels), message_type: 'test-result', fields: { result: pick(['pass', 'fail', 'skip']), checks: 3 } }, ident)
        else if (op < 0.86) {
          const se = M.getSession2(w.st, ident)
          const cand = se ? [...se.nodes.values()].filter(n => n.parent != null && !n.merged_into) : []
          if (cand.length) r = w.action({ ...ident, id: pick(cand).id, action: pick(['skip', 'done', 'abandon', 'dismiss', 'reopen']), args: { stale_min: 0.001 } })
        } else if (op < 0.9) { w.tick(30 * MIN); const p = M.expirePass2(w.st, w.now); r = { ok: true, n: p.writes.length } }
        else w.tick(Math.floor(rnd() * 5 * MIN))
        if (rnd() < 0.45) {   // a frame now (a burst coalesces otherwise), under a random byte cap
          const f = L.send(rnd() < 0.3 ? 400 + Math.floor(rnd() * 1500) : undefined)
          if (f) { frames++; if (f.remove) removes += f.remove.length; if (f.truncated) truncs++ }
        }
      }
      L.flush(rnd() < 0.5 ? 600 : undefined)
      histories++
      // the receiver = the owner, session by session; = a fresh full slice
      const fresh = link(w); fresh.flush()
      for (const se of w.st.sessions.values()) {
        const own = ownRows(se, w.now)
        const rem = (L.rows().find(x => x.session === se.ident.session) || { nodes: [] }).nodes
        const fr = (fresh.rows().find(x => x.session === se.ident.session) || { nodes: [] }).nodes
        if (!sameBoard(own, rem) || !sameBoard(own, fr)) { seedBad = { seed, session: se.ident.session, delta: diffBoard(own, rem), full: diffBoard(own, fr) }; break }
      }
      if (!seedBad && L.rows().length !== w.st.sessions.size) seedBad = { seed, sessions: [L.rows().map(x => x.session), [...w.st.sessions.values()].map(x => x.ident.session)] }
    } catch (e) { seedBad = { seed, threw: String((e && e.stack) || e) } }
  }
  check(`fuzz: 150 random histories gossiped as deltas (random byte caps) — the receiver equals the owner and a fresh full slice after every flush (${frames} frames, ${removes} removals, ${truncs} truncated)`, !seedBad && histories === 150 && removes > 0 && truncs > 0, J(seedBad))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
