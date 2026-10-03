// Fast UNIT tests for #88 (v2.0) build step 10, spec Q72 — the four 1.7x board behaviours rebuilt on the 2.0 model
// (lib/activity2.js "#88 step 10 (Q72)" + expire2, lib/activity2-store.js): no bridge, no sockets.
// Covered:
//   - GONE (markSessionGone2 / store.markGone): the session, its agents and root get gone_at (null clears); the store's
//     board shows a LOCAL gone node as state "gone" + was (an agent / the root, a context's live line through its owner;
//     never a plan item, never a finished agent) and the session's gone_at; a REPORT clears the session's mark and the
//     reporting chain's (touch) — the other agents stay gone; gone_at is never written (replay ≡ live without it);
//   - EXPIRY of gone (expire2 / store.expire): a gone agent past finished_visible_hours leaves like a finished one (a
//     `remove` why "expire"), never one holding an open plan; a GONE session with an open plan stays whole; once its plan
//     ended it leaves WHOLE past the window (one `remove` of its root, why "expire"), the replay folds it, and the store's
//     `left` lists its ids;
//   - AUTO-ABANDON (autoAbandon2 / store.autoAbandon): a session gone (or, never marked, quiet) for abandoned_plan_days
//     and not live → each open item abandoned, then its plan node (a context by its line, an agent by the plan-end marker),
//     deepest plans first; entries attributed to the bridge (by "bridge", the 1.7x text), touching no activity; a live
//     session, a recent gone_at, a disabled board → nothing; a replay of the writes gives the same board;
//   - the MEMORY BUDGET (estimateBytes2 / enforceBudget2 / store.budget): the oldest finished agents / ended plans evicted
//     first (`remove` why "evict"; never an open plan, never an unfinished agent), then the oldest IN-MEMORY log entries
//     dropped (log shrinks, log_dropped grows, nothing written; current lines kept); the replay of the writes = the board;
//   - the DOORBELL flag (setBells2 / store.setBells): name (any case) + optional project; changed only on a change; the
//     board's session row carries bell:true.
import { testOnly } from '../helpers/check.mjs'
import * as M from '../../lib/activity2.js'
import * as S from '../../lib/activity2-store.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.stack} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
function section(name, fn) { try { fn() } catch (e) { fail++; console.log(`FAIL section "${name}" crashed:`, (e && e.stack) || e) } }
const ID = { session: 'Bridget', project: 'AIMB', user: 'robin', realm: 'default' }
const KIM = { session: 'kim-s', project: 'Marz', user: 'kim', realm: 'default' }
const DASH = { kind: 'dashboard', user: 'robin', host: 'H' }
const MIN = 60000, HOUR = 3600000, DAY = 86400000
const T0 = new Date(2026, 9, 1, 9, 0, 0).getTime()
const parse = r => JSON.parse(J(r))

/** A model + its written records (the "files"), on a clock. */
function world(config = {}) {
  const st = M.createModel({ origin: 'H', config: { log_entries_per_agent: 20, ...config } })
  let now = T0
  const files = []
  const put = ws => { for (const r of ws || []) files.push(parse(r)) }
  const call = (x, ident = ID) => { const r = M.applyCall(st, ident, x, now); if (r.ok) put(r.writes); return r }
  const act = (id, action, args = {}, ident = ID) => { const r = M.applyAction2(st, { ...ident, id, action, args }, now, { by: DASH }); if (r.ok) put(r.writes); return r }
  const sess = (ident = ID) => M.getSession2(st, ident)
  const node = (path, ident = ID) => { const s = sess(ident); return s ? (path === '' ? M.rootOf(s) : M.findPath(s, path)) : null }
  return { st, files, put, call, act, sess, node, tick: ms => (now += ms), at: () => now, config }
}
/** The board as the model holds it — without what is in memory only (gone_at, bell, cp marks) and, optionally, the logs. */
function dump(st, o = {}) {
  const sorted = m => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return J(sorted(st.sessions).map(([k, s]) => ({ k, last_activity: s.last_activity, nodes: sorted(s.nodes).map(([, n]) => {
    const x = { ...n }; delete x.gone_at; delete x.cp_dirty; delete x.cp_sig; delete x.log_floor
    if (o.logs === false) { delete x.log; delete x.log_dropped }
    x.path = M.pathOf(s, n); x.plan_end_at = M.planEndAt2(s, n)
    return x
  }), ...(o.ghosts ? { ghosts: sorted(s.ghosts).map(([id, g]) => [id, g.why, g.parent]) } : {}) })))
}
function replayOf(w, now) { const B = M.createModel({ origin: 'H', config: { log_entries_per_agent: 20, ...w.config } }); M.replayRecords2(B, w.files, now, { from: 0 }); return B }
const rowAt = (b, p) => ((b[0] || {}).nodes || []).find(n => n.path === p)

section('gone', () => {
  const st = S.createStore2({ host: 'H' })
  st.apply(ID, { agent: 'w', label: 'W', text: '@working', state: 'running' }, T0)
  st.apply(ID, { agent: 'w', key: 'ctx', label: 'Ctx', text: '@in ctx' }, T0 + 1)
  st.apply(ID, { agent: 'w', key: 'quiet', label: 'Quiet' , text: 'just a note' }, T0 + 2)
  st.apply(ID, { agent: 'p', label: 'P', text: '@planning', plan: [{ key: 'i1', label: 'I1' }] }, T0 + 3)
  st.apply(ID, { agent: 'f', label: 'F', text: '@finished', state: 'done' }, T0 + 4)
  check('markGone: an unknown session → false (nothing made)', st.markGone(KIM, T0) === false && st.state.sessions.size === 1)
  const before = st.board({}, T0 + 10)
  check('harness: nothing is gone before the mark', !before[0].gone_at && !before[0].nodes.some(n => n.state === 'gone'), J(before[0].nodes.map(n => [n.path, n.state])))
  check('markGone: the session is known → true', st.markGone(ID, T0 + 100) === true)
  const s = M.getSession2(st.state, ID)
  check('markSessionGone2: the session, every agent and the root get gone_at; contexts do not', s.gone_at === T0 + 100 && [...s.nodes.values()].every(n => (n.kind === 'context' ? n.gone_at == null : n.gone_at === T0 + 100)))
  const b = st.board({}, T0 + 200)
  check('board: the session row carries gone_at', b[0].gone_at === T0 + 100, J({ ...b[0], nodes: undefined }))
  check('board: a running agent shows gone (was running); its context\'s live line shows gone through its owner', rowAt(b, 'W')?.state === 'gone' && rowAt(b, 'W')?.was === 'running' && rowAt(b, 'W/Ctx')?.state === 'gone' && rowAt(b, 'W/Ctx')?.was === 'running', J(b[0].nodes.map(n => [n.path, n.state, n.was])))
  check('board: a plan item never shows gone (its own ☐ state); a finished agent shows its done; the root shows gone too', rowAt(b, 'P/I1')?.state === 'todo' && rowAt(b, 'F')?.state === 'done' && rowAt(b, 'P')?.state === 'gone' && rowAt(b, '')?.state === 'gone', J(b[0].nodes.map(n => [n.path, n.state])))
  check('board: a STALE agent of a gone session shows gone (gone outranks stale, as 1.7x)', (bb => rowAt(bb, 'W')?.state === 'gone' && rowAt(bb, 'W')?.was === 'running' && !rowAt(bb, 'W')?.stale)(st.board({}, T0 + 2 * HOUR)))
  // a REPORT clears the session's mark and the reporting chain's (1.7x: the session + the message's owner)
  st.apply(ID, { agent: 'w', text: 'back again' }, T0 + 300)
  const b2 = st.board({}, T0 + 301)
  check('touch: a report clears the SESSION\'s gone_at and its owner\'s; the other agents stay gone', s.gone_at == null && M.findPath(s, 'W').gone_at == null && M.findPath(s, 'P').gone_at === T0 + 100 && !b2[0].gone_at
    && rowAt(b2, 'W')?.state === 'running' && rowAt(b2, 'P')?.state === 'gone', J(b2[0].nodes.map(n => [n.path, n.state])))
  st.markGone(ID, null)
  check('markGone(null): clears every mark (the session is back)', s.gone_at == null && [...s.nodes.values()].every(n => n.gone_at == null) && !st.board({}, T0 + 400)[0].nodes.some(n => n.state === 'gone'))
  // in memory only: no record is written for gone — a dashboard/system call never clears it either
  const w = world()
  w.call({ agent: 'w', label: 'W', text: '@x' })
  const n0 = w.files.length
  M.markSessionGone2(w.st, ID, w.at())
  w.tick(MIN); w.act(w.node('W').id, 'message', { text: 'hello from the dashboard' })
  check('gone_at is never written (no record), and a dashboard action (a system call) does not clear it', w.files.length === n0 + 1 && w.sess().gone_at === T0 && w.node('W').gone_at === T0, J(w.files.slice(n0)))
  check('replay ≡ live without gone_at (it is in memory only)', dump(replayOf(w, w.at() + 1)) === dump(w.st))
})

section('expire gone', () => {
  const w = world({ finished_visible_hours: 1 })
  w.call({ agent: 'g', label: 'G', text: '@going', state: 'running' })
  w.call({ agent: 'p', label: 'P', text: '@holding', plan: [{ key: 'i1', label: 'I1' }] })
  w.call({ agent: 'f', label: 'F', text: '@done', state: 'done' })
  w.call({ agent: 'g', key: 'kid', label: 'Kid', text: '@under g' })
  M.markSessionGone2(w.st, ID, w.at())
  w.tick(30 * MIN)
  const e1 = M.expire2(w.st, w.at())
  check('expire2: nothing within the window (gone / finished 30 min ago, window 1 h)', e1.writes.length === 0 && !!w.node('G') && !!w.node('F'))
  w.tick(31 * MIN)
  const e2 = M.expire2(w.st, w.at()); w.put(e2.writes)
  const rm = e2.records.filter(r => r.op === 'remove')
  check('expire2: a GONE agent past the window leaves like a finished one (with its subtree; `remove` why "expire")', !w.node('G') && !w.node('G/Kid') && !w.node('F') && rm.length === 2 && rm.every(r => r.why === 'expire') && e2.removed.some(x => x.path === 'G'), J(rm))
  check('expire2: a gone agent holding part of an OPEN plan stays; so does the gone session holding it', !!w.node('P') && !!w.node('P/I1') && !!w.sess() && !e2.removed.some(x => x.session))
  w.tick(30 * DAY)
  const e3 = M.expire2(w.st, w.at())
  check('expire2: an open plan keeps a gone session whole however long it has been gone (auto-abandon ends it)', e3.writes.length === 0 && !!w.sess() && !!w.node('P/I1'))
  w.act(w.node('P').id, 'abandon_plan')
  check('harness: the plan abandoned from the dashboard (the session stays gone: a system call)', M.planEndAt2(w.sess(), w.node('P'), M.planOf2(w.sess(), w.node('P'))) != null && w.sess().gone_at === T0)
  const rootId = w.sess().rootId
  const e4 = M.expire2(w.st, w.at()); w.put(e4.writes)
  check('expire2: a GONE session past the window with no open plan leaves WHOLE — ONE `remove` of its root (why "expire", was "")', !w.sess() && e4.records.length === 1 && e4.records[0].op === 'remove' && e4.records[0].n === rootId && e4.records[0].why === 'expire' && e4.records[0].was === ''
    && e4.removed.length === 1 && e4.removed[0].session === true, J(e4.records))
  const R = replayOf(w, w.at() + 1)
  check('replay: the root\'s remove folds as the dismiss of a session does — the session is gone', !M.getSession2(R, ID) && dump(R) === dump(w.st), dump(R))
  // the store: `left` names the session's every id
  const st = S.createStore2({ host: 'H', config: { finished_visible_hours: 1 } })
  const a = st.apply(ID, { agent: 'a', label: 'A', text: '@x' }, T0)
  const sid = M.getSession2(st.state, ID).rootId
  st.markGone(ID, T0)
  const ex = st.expire(T0 + 2 * HOUR)
  check('store.expire: a gone session leaving whole → changed, and `left` lists its ids (root + nodes) for the view pruning', ex.changed && !M.getSession2(st.state, ID) && ex.left?.includes(sid) && ex.left?.includes(a.node.id), J(ex))
  // a session never marked gone does not leave (quiet sessions just go stale)
  const st2 = S.createStore2({ host: 'H', config: { finished_visible_hours: 1 } })
  st2.apply(ID, { agent: 'a', label: 'A', text: '@x' }, T0)
  check('store.expire: a quiet session never marked gone stays (and its unfinished agent)', !st2.expire(T0 + 10 * DAY).changed && st2.board({}, T0 + 10 * DAY)[0]?.nodes.some(n => n.path === 'A'))
})

section('auto-abandon', () => {
  const w = world({ abandoned_plan_days: 2 })
  w.call({ key: 'n70', label: '#70', text: '@the plan', plan: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })
  w.call({ key: 'a', state: 'done' })
  w.call({ agent: 'w', label: 'W', text: '@agent plan', plan: [{ key: 'x', label: 'X' }] })
  w.call({ agent: 'w', key: 'sub', label: 'Sub', text: '@sub plan', plan: [{ key: 'y', label: 'Y' }] })
  w.call({ agent: 'w', key: 'y', state: 'running', text: '@on y' })
  const la = w.sess().last_activity
  w.tick(DAY)
  check('autoAbandon2: quiet 1 day (< abandoned_plan_days 2) → nothing', M.autoAbandon2(w.st, w.at()).writes.length === 0)
  w.tick(DAY + HOUR)
  check('autoAbandon2: a LIVE session (on the roster) → nothing', M.autoAbandon2(w.st, w.at(), { live: () => true }).writes.length === 0)
  M.markSessionGone2(w.st, ID, w.at() - HOUR)
  check('autoAbandon2: gone_at counts first (gone an hour ago: not due, however old its last activity)', M.autoAbandon2(w.st, w.at()).writes.length === 0)
  M.markSessionGone2(w.st, ID, null)
  const off = M.createModel({ origin: 'H', config: { enabled: false } })
  check('autoAbandon2: a disabled board → nothing', M.autoAbandon2(off, w.at()).writes.length === 0)
  const ab = M.autoAbandon2(w.st, w.at()); w.put(ab.writes)
  const s = w.sess()
  check('autoAbandon2: every open item abandoned, then its plan node — a context by its line (keeping its text), an agent by the plan-end marker (it keeps running); a done item stays done', w.node('#70/B').current.state === 'abandoned' && w.node('#70').current.state === 'abandoned' && w.node('#70/A').current.state === 'done'
    && w.node('W/X').current.state === 'abandoned' && w.node('W/Sub/Y').current.state === 'abandoned' && w.node('W/Sub').current.state === 'abandoned'
    && w.node('W').current.state === 'running' && w.node('W').plan_end?.state === 'abandoned', J([...s.nodes.values()].map(n => [M.pathOf(s, n), n.current && n.current.state, n.plan_end])))
  check('autoAbandon2: DEEPEST plans first (W/Sub\'s item and node before the depth-1 plans; each plan\'s items before its node)',
    J(ab.abandoned.slice(0, 2).map(d => d.path)) === J(['W/Sub/Y', 'W/Sub']) && ab.abandoned.findIndex(d => d.path === '#70/B') < ab.abandoned.findIndex(d => d.path === '#70') && ab.abandoned.findIndex(d => d.path === 'W/X') < ab.abandoned.findIndex(d => d.path === 'W'), J(ab.abandoned.map(d => d.path)))
  check('autoAbandon2: each entry attributed to the bridge (by "bridge") with the 1.7x text; one per item / plan node', ab.entries.length === 6 && ab.entries.every(e => e.by === 'bridge' && e.text === 'abandoned by the bridge — the session has been gone 2 days'),
    J(ab.entries.map(e => [e.at, e.by, e.text])))
  check('autoAbandon2: a system message — no activity (the session\'s last_activity unchanged; never looks alive)', s.last_activity === la && w.node('W').last_activity < w.at() - DAY)
  check('autoAbandon2: a second pass finds nothing open', M.autoAbandon2(w.st, w.at() + 1).writes.length === 0)
  check('autoAbandon2: abandoned[] carries the ident, ids, item flags and from-states', ab.abandoned.every(d => d.ident.session === 'Bridget' && /^[a-z2-7]{16}$/.test(d.id)) && ab.abandoned.find(d => d.path === '#70/B')?.item === true && ab.abandoned.find(d => d.path === '#70/B')?.from === 'todo' && ab.abandoned.find(d => d.path === 'W/Sub/Y')?.from === 'running')
  check('replay: the abandon\'s written entries replay to the same board', dump(replayOf(w, w.at() + 1)) === dump(w.st))
  // the store writes them (memory-only: persisted null → no flag) and reports changed
  const st = S.createStore2({ host: 'H', config: { abandoned_plan_days: 1 } })
  st.apply(ID, { key: 'k', label: 'K', text: '@p', plan: ['One'] }, T0)
  const r = st.autoAbandon(T0 + 2 * DAY, { live: () => false })
  const kRow = st.board({}, T0 + 2 * DAY)[0].nodes.find(n => n.path === 'K')
  check('store.autoAbandon: changed + abandoned (the item, then K — its line keeps its text)', r.changed && r.abandoned.length === 2 && kRow.state === 'abandoned' && kRow.current.text === 'p', J([r, kRow]))
  const lg = st.logPage({ session: 'Bridget', path: 'K' }, T0 + 2 * DAY)
  check('store.autoAbandon: the log shows the bridge\'s entries ("…gone 1 day", by bridge)', (lg.entries || []).filter(e => e.by === 'bridge' && e.text === 'abandoned by the bridge — the session has been gone 1 day').length === 2, J(lg.entries))
})

section('budget', () => {
  const w = world({ log_entries_per_agent: 50 })
  for (const k of ['f1', 'f2', 'f3']) { for (let i = 0; i < 10; i++) w.call({ agent: k, label: k.toUpperCase(), text: `${k} note ${i} ` + 'x'.repeat(200) }); w.tick(MIN); w.call({ agent: k, text: `@${k} done`, state: 'done' }); w.tick(MIN) }
  w.call({ agent: 'held', label: 'Held', text: '@holds', plan: [{ key: 'h1', label: 'H1' }] }); w.call({ agent: 'held', text: '@held done', state: 'done' })
  w.call({ agent: 'run', label: 'Run', text: '@running' })
  for (let i = 0; i < 10; i++) w.call({ agent: 'run', text: `run note ${i} ` + 'y'.repeat(200) })
  w.tick(MIN)
  const b0 = M.estimateBytes2(w.st)
  check('estimateBytes2: a positive estimate that grows with the logs', b0 > 10000 && (() => { const x = M.createModel({ origin: 'H' }); return M.estimateBytes2(x) < 1000 })(), String(b0))
  check('estimateBytes2: opts.remote counts the held remote boards too', M.estimateBytes2(w.st, { remote: { hosts: new Map([['R', { sessions: new Map([['k', w.sess()]]) }]]) } }) > 2 * b0 - 1000)
  const none = M.enforceBudget2(w.st, b0 + 1000, w.at())
  check('enforceBudget2: under the budget → nothing evicted, nothing dropped, nothing written', none.evicted.length === 0 && none.entries_dropped === 0 && none.writes.length === 0 && !none.over)
  const r1 = M.enforceBudget2(w.st, b0 - 100, w.at()); w.put(r1.writes)
  check('enforceBudget2: just over → the OLDEST finished agent evicted (`remove` why "evict"), nothing more', J(r1.evicted.map(e => e.path)) === J(['F1']) && r1.records.length === 1 && r1.records[0].op === 'remove' && r1.records[0].why === 'evict' && r1.entries_dropped === 0 && !w.node('F1') && !!w.node('F2') && r1.bytes_after <= b0 - 100, J(r1))
  check('replay: the eviction folds to the same board (+ the ghost)', dump(replayOf(w, w.at() + 1), { ghosts: true }) === dump(w.st, { ghosts: true }))
  const runLog = w.node('Run').log.length, cur = w.node('Run').current.text
  const r2 = M.enforceBudget2(w.st, 6000, w.at()); w.put(r2.writes)
  check('enforceBudget2: far over → every finished agent evicted oldest first, NEVER one holding an open plan item, never an unfinished agent', J(r2.evicted.map(e => e.path)) === J(['F2', 'F3']) && !!w.node('Held') && !!w.node('Held/H1') && !!w.node('Run'), J(r2.evicted))
  check('enforceBudget2: then the oldest IN-MEMORY log entries dropped — the log shrinks, log_dropped grows, nothing written for that; current lines kept', r2.entries_dropped > 0 && w.node('Run').log.length < runLog && w.node('Run').log_dropped === runLog - w.node('Run').log.length
    && r2.writes.length === r2.records.length && r2.records.every(x => x.op === 'remove' && x.why === 'evict') && w.node('Run').current.text === cur, J({ dropped: r2.entries_dropped, log: w.node('Run').log.length, d: w.node('Run').log_dropped }))
  check('enforceBudget2: the oldest entries go first (what is left is the newest)', (l => l.length === 0 || l[l.length - 1].text.startsWith('run note 9'))(w.node('Run').log))
  check('enforceBudget2: still over when current lines alone exceed the budget → over:true', M.enforceBudget2(w.st, 100, w.at()).over === true)
  check('replay: the evictions replay to the same board (the logs aside: the files keep what memory dropped)', dump(replayOf(w, w.at() + 1), { logs: false, ghosts: true }) === dump(w.st, { logs: false, ghosts: true }))
  // the store: evictions written, `left` for the view pruning
  const st = S.createStore2({ host: 'H' })
  const f = st.apply(ID, { agent: 'old', label: 'Old', text: '@done', state: 'done' }, T0)
  st.apply(ID, { agent: 'cur', label: 'Cur', text: '@on' }, T0 + 1)
  const bud = st.budget(M.estimateBytes2(st.state) - 10, T0 + 2)
  check('store.budget: changed, evicted the finished agent, `left` names it', bud.changed && J(bud.evicted.map(e => e.path)) === J(['Old']) && J(bud.left) === J([f.node.id]) && !bud.over, J(bud))
})

section('bells', () => {
  const st = S.createStore2({ host: 'H' })
  st.apply(ID, { text: '@hi' }, T0); st.apply(KIM, { text: '@yo' }, T0)
  check('setBells2: a watch by name (any case) → that session only; changed', st.setBells([{ name: 'bridget' }]) === true && M.getSession2(st.state, ID).bell === true && !M.getSession2(st.state, KIM).bell)
  check('setBells2: the same watches again → unchanged (false)', st.setBells([{ name: 'BRIDGET', project: null }]) === false)
  check('setBells2: a watch naming another project does not match', st.setBells([{ name: 'Bridget', project: 'Other' }]) === true && !M.getSession2(st.state, ID).bell)
  check('setBells2: the project (any case) matches; a name-less watch (topic only) never does', st.setBells([{ name: 'Bridget', project: 'aimb' }, { topic: 'x/y' }, null]) === true && M.getSession2(st.state, ID).bell === true && !M.getSession2(st.state, KIM).bell)
  const b = st.board({}, T0 + 1)
  check('board: the session row carries bell:true (only the watched one)', b.find(s => s.session === 'Bridget')?.bell === true && !('bell' in b.find(s => s.session === 'kim-s')), J(b.map(s => [s.session, s.bell])))
  check('setBells2: no watches → cleared', st.setBells([]) === true && !M.getSession2(st.state, ID).bell && !('bell' in st.board({}, T0 + 2).find(s => s.session === 'Bridget')))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
