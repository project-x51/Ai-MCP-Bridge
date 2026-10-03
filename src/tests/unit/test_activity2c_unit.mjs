// Fast UNIT tests for #88 (v2.0) build step 2c — positions (before / after / first / last, reorder), the per-session node
// limits + eviction, the dashboard ACTIONS on ids (applyAction2) incl. the clash dialog's answer (clashes2, `label` /
// `merges`), and the NOTICES they produce (actionNotice2 & co.) in lib/activity2.js (docs/spec-88.md §4.1, §1.6, §5.4, §5.5,
// §6.3). Pure: no bridge, no sockets; time is passed in.
import { testOnly } from '../helpers/check.mjs'
import * as M from '../../lib/activity2.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.message} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
async function section(fn) { try { await fn() } catch (e) { fail++; console.log('FAIL section crashed:', (e && e.stack) || e) } }
const BRIDGET = { session: 'Bridget', project: 'AIMB', user: 'robin' }
const T0 = 1790984000000
const DASH = { kind: 'dashboard', user: 'robin', host: 'ROBIN-Z790' }
const MIN = 60000
function world(o = {}) {
  const st = M.createModel({ origin: 'ROBIN-Z790', ...o })
  let now = T0
  const call = (x, opt) => M.applyCall(st, BRIDGET, x, now++, opt)
  const act = (id, action, args = {}, by = DASH) => M.applyAction2(st, { ...BRIDGET, id, action, args }, now++, { by })
  const sess = () => M.getSession2(st, BRIDGET)
  const tick = ms => { now += ms; return now }
  const at = () => now
  const get = (key, scope = null) => { const s = sess(); if (!s) return null; const c = scope ? get(scope) : M.rootOf(s), id = c && s.scope.get(c.id + '\n' + key.toLowerCase()); return id ? s.nodes.get(id) : null }
  const kids = k => M.childrenOf2(sess(), typeof k === 'string' ? get(k) : k || M.rootOf(sess())).map(c => c.label)
  return { st, call, act, sess, tick, at, get, kids }
}
const snap = s => J({ n: [...s.nodes.values()].map(n => [n.id, n.parent, n.label, n.type, n.rank, n.current, n.plan, n.plan_end, n.log.length, n.merged_into]).sort(), k: [...s.kids].map(([k, v]) => [k, [...v].sort()]).sort(),
  l: [...s.labels].sort(), sc: [...s.scope].sort(), a: [...s.aliases].sort(), g: [...s.ghosts.keys()].sort() })
const codes = r => (r.warnings || []).map(w => w.code)
const ops = r => (r.records || []).map(x => x.op)

// ================================================================= positions on create (§4.1, #82 on ids)
await section(() => {
  const w = world()
  for (const k of ['a', 'b', 'c']) w.call({ key: k, label: k.toUpperCase() })
  const x = w.call({ key: 'x', label: 'X', before: 'b' })
  check('create --before <key>: the new node lands before its sibling; its create record carries the stored rank', x.ok && J(w.kids()) === J(['A', 'X', 'B', 'C']) && x.records[0].op === 'create' && x.records[0].rank === w.get('x').rank && !!w.get('x').rank && x.placed.where === 'before B', J(w.kids()))
  const y = w.call({ key: 'y', label: 'Y', after: 'a' })
  check('create --after <key>: right after it', y.ok && J(w.kids()) === J(['A', 'Y', 'X', 'B', 'C']))
  const f = w.call({ key: 'f', label: 'F', position: 'first' })
  check('create --first: first among its group', f.ok && w.kids()[0] === 'F')
  const l = w.call({ key: 'l', label: 'L', position: 'LAST' })
  check('create --last: last (no stored rank: its derived rank already is the end — a rank only where needed)', l.ok && w.kids().at(-1) === 'L' && w.get('l').rank === null && l.records[0].rank === null)
  const lab = w.call({ key: 'z', label: 'Z', before: 'C' })
  check('an anchor is a SIBLING: a bare key that names none in the scope is read as a sibling\'s label ("C" = key c, label C)', lab.ok && J(w.kids().slice(-3)) === J(['Z', 'C', 'L']))
  w.call({ key: 'two', label: 'Two words' })
  check('…a label with spaces (a one-segment path) names the sibling with that label', w.call({ key: 'tw', label: 'Tw', after: 'Two words' }).ok && w.kids().at(-1) === 'Tw')
  check('…by id (before_id / after_id)', (r => r.ok && w.kids()[0] === 'Q')(w.call({ key: 'q', label: 'Q', before_id: w.get('f').id })))
  const p = w.call({ path: 'Box/Inner', position: 'first' })
  check('a NEW --path target is placed too (only the target — the intermediates go where they would)', p.ok && p.node.created && J(w.kids('Box')) === J(['Inner']))
  // refusals: nothing written
  const s0 = snap(w.sess())
  check('unknown-anchor: no such sibling (nothing written)', w.call({ key: 'n1', label: 'N1', before: 'nope' }).code === 'unknown-anchor' && snap(w.sess()) === s0)
  w.call({ key: 'deep', label: 'Deep', under: 'a' })
  check('bad-anchor: the anchor is not a sibling there', (r => r.code === 'bad-anchor')(w.call({ key: 'n2', label: 'N2', before: 'deep' })))
  w.call({ agent: 'lead', label: 'Lead' })
  check('bad-anchor: an anchor in another rank group (plan items, then contexts, then agents)', (r => r.code === 'bad-anchor' && /among the agents/.test(r.what))(w.call({ key: 'n3', label: 'N3', before: 'lead' })))
  check('bad-position: two positions, or position other than first | last', w.call({ key: 'n4', label: 'N4', before: 'a', after: 'b' }).code === 'bad-position' && w.call({ key: 'n4', label: 'N4', position: 'middle' }).code === 'bad-position')
  check('bad-position: a position with --move-to (it arrives last) or --merge; bad-ask with --ask', w.call({ key: 'a', move_to: '/Box', before: 'b' }).code === 'bad-position' && w.call({ key: 'a', merge: 'b', position: 'first' }).code === 'bad-position' && w.call({ key: 'qq', label: 'QQ', ask: 'Which?', before: 'a' }).code === 'bad-ask')
  check('bad-position: the session root has no siblings', w.call({ text: 'x', position: 'first' }).code === 'bad-position')
  check('before and before_id together → bad-input; a bad *_id → bad-ref', w.call({ key: 'n5', label: 'N5', before: 'a', before_id: w.get('a').id }).code === 'bad-input' && w.call({ key: 'n5', label: 'N5', after_id: 'x' }).code === 'bad-ref')
  // agents among agents
  w.call({ agent: 'lead2', label: 'Lead 2', position: 'first' })
  const ags = M.childrenOf2(w.sess(), M.rootOf(w.sess())).filter(c => c.kind === 'agent').map(c => c.label)
  check('a new AGENT is placed among the agents (--agent … --first)', J(ags) === J(['Lead 2', 'Lead']))
})

// ================================================================= positions on plan items, reorder, move
await section(() => {
  const w = world()
  const p = w.call({ key: 'rel', label: 'Release', plan: ['Spec', 'Build', 'Ship'] })
  const s = w.sess(), rel = w.get('rel')
  const ins = w.call({ key: 'rel', plan: ['Spec', 'Test', 'Docs'], before: 'Ship' })
  check('plan + position: the items the call CREATES are placed (in the given order), the kept one stays', ins.ok && J(w.kids('rel')) === J(['Spec', 'Build', 'Test', 'Docs', 'Ship']) && ins.plan[1].rank && ins.plan[2].rank && !ins.plan[0].rank, J(w.kids('rel')))
  check('…their create records carry the ranks', ins.records.filter(r => r.op === 'create').every(r => typeof r.rank === 'string'))
  const nu = w.call({ key: 'rel', plan: ['Spec'], position: 'first' })
  check('plan + position where nothing is created → warning position-unused (a re-plan never moves an item)', nu.ok && codes(nu).includes('position-unused') && w.kids('rel')[0] === 'Spec')
  check('plan items are a group of their own: a context anchor is bad-anchor', (w.call({ key: 'ctx', label: 'Ctx', under: 'rel' }), w.call({ key: 'rel', plan: ['Late'], before: 'ctx' }).code === 'bad-anchor'))
  // reorder (an existing target + a position alone)
  const before = snap(s)
  const ro = w.call({ key: 'Ship', position: 'first' })
  check('reorder: a position alone on an existing node moves it among its siblings — ONE rank record + its entry', ro.ok && w.kids('rel')[0] === 'Ship' && J(ops(ro)) === J(['rank']) && ro.entries.length === 1 && ro.entries[0].text === 'placed first' && ro.entries[0].type === 'event' && ro.placed.rank === w.get('Ship').rank, J(ro.entries))
  const again = w.call({ key: 'Ship', position: 'first' })
  check('reorder: already there → a no-op (nothing written; a retry reorders nothing)', again.ok && again.records.length === 0 && again.entries.length === 0 && !again.placed)
  const ab = w.call({ key: 'Build', after: 'Docs' })
  check('reorder --after <label>', ab.ok && J(w.kids('rel').slice(0, 5)) === J(['Ship', 'Spec', 'Test', 'Docs', 'Build']) && ab.entries[0].text === 'placed after Docs')
  check('reorder before itself → bad-position', w.call({ key: 'Build', before: 'Build' }).code === 'bad-position')
  const exi = w.call({ key: 'Spec', label: 'Spec', under: 'rel', position: 'last' })
  check('a create-shaped call (with --under) on an EXISTING node ignores its position: warning exists (hole H2)', exi.ok && exi.records.length === 0 && (exi.warnings.find(x => x.code === 'exists' && x.ignored.includes('position'))) && w.kids('rel')[1] === 'Spec')
  const dash = w.call({ key: 'Docs', position: 'first' }, { by: DASH, act: 'reorder' })
  check('a dashboard reorder\'s entry is attributed ("placed by robin via dashboard (…) first")', dash.entries[0].text === 'placed by robin via dashboard (ROBIN-Z790) first' && dash.records[0].act === 'reorder')
  // move + a position
  w.call({ key: 'later', label: 'Later' })
  for (const k of ['l1', 'l2']) w.call({ key: k, label: k.toUpperCase(), under: 'later' })
  const mv = w.call({ key: 'ctx', move: 'later', before: 'l2' })
  check('--move + --before: it lands where the position says; the move record carries that rank; the entry says where', mv.ok && J(w.kids('later')) === J(['L1', 'Ctx', 'L2']) && mv.records[0].op === 'move' && mv.records[0].rank === w.get('ctx').rank && /\(before L2\)$/.test(mv.entries[0].text), J(mv.entries[0]))
  const mvs = w.call({ key: 'ctx', move: 'later', position: 'last' })
  check('--move to its own parent with a position = a reorder (rank record)', mvs.ok && w.kids('later').at(-1) === 'Ctx' && J(ops(mvs)) === J(['rank']))
  check('--move + an anchor that is not under the destination → bad-anchor (nothing written)', (() => { const s0 = snap(s); const r = w.call({ key: 'l1', move: 'rel', before: 'l2' }); return r.code === 'bad-anchor' && snap(s) === s0 })())
  void p; void before; void rel
})

// ================================================================= node limits + eviction (6a / 6c on ids)
await section(() => {
  const w = world({ limits: { nodesPerSession: 8, agentsPerSession: 3 } })
  w.call({ agent: 'a1', label: 'A1' }); w.call({ agent: 'a1', key: 'k1', label: 'K1' })
  w.call({ agent: 'a2', label: 'A2' })
  w.call({ agent: 'a1', state: 'done', text: '@finished' })
  w.tick(1000)
  w.call({ agent: 'a2', state: 'done', text: '@finished too' })
  w.call({ key: 'p', label: 'P', plan: ['I1', 'I2'] })   // 3 + 3 + … = 7 nodes: a1, k1, a2, p, I1, I2
  check('limits: the model takes lowered limits (a test hook)', w.st.limits.nodesPerSession === 8 && w.st.limits.agentsPerSession === 3)
  const s = w.sess(), a1 = w.get('a1')
  const r = w.call({ key: 'n1', label: 'N1' }) // 7
  const r2 = w.call({ key: 'n2', label: 'N2' }) // 8
  check('limits: up to the limit nothing is evicted', r.ok && r2.ok && !r.evicted && !r2.evicted)
  const r3 = w.call({ key: 'n3', label: 'N3' })
  check('limits: past it, the OLDEST finished agent is EVICTED with its subtree (a `remove` record why "evict"; evicted in the result)', r3.ok && J(r3.evicted.map(e => e.label)) === J(['A1']) && r3.records.some(x => x.op === 'remove' && x.why === 'evict' && x.n === a1.id) && !s.nodes.has(a1.id) && s.ghosts.has(a1.id) && [...s.ghosts.values()].some(g => g.key === 'k1' && g.parent === a1.id) && !w.get('k1', 'a1'), J(r3.evicted))
  // an ended plan
  w.call({ key: 'I1', state: 'done' }); w.call({ key: 'I2', state: 'done' })
  const ev = []
  for (const k of ['n4', 'n5', 'n6']) { const x = w.call({ key: k, label: k.toUpperCase() }); if (x.ok) ev.push(...(x.evicted || [])) }
  check('limits: the next oldest goes — a finished agent, then an ENDED plan (a plain plan context goes WITH its items)', J(ev.map(e => e.label)) === J(['A2', 'P']) && !w.get('p') && !w.get('I1'), J(ev))
  w.call({ key: 'n7', label: 'N7' }); w.call({ key: 'n8', label: 'N8' })
  // nothing left to evict
  const s0 = snap(s)
  const r6 = w.call({ key: 'n9', label: 'N9' })
  check('limits: nothing evictable → too-many-nodes, the call refused as a whole (nothing written)', r6.code === 'too-many-nodes' && snap(s) === s0)
  // open plans and the call's own nodes are never evicted
  const w2 = world({ limits: { nodesPerSession: 5, agentsPerSession: 5 } })
  w2.call({ agent: 'ag', label: 'Ag' }); w2.call({ agent: 'ag', key: 'pl', label: 'Pl', plan: ['X', 'Y'] })
  w2.call({ agent: 'ag', state: 'done', text: '@done' })
  w2.call({ key: 'c', label: 'C' })
  const r7 = w2.call({ key: 'd', label: 'D' })
  check('limits: a finished agent holding an OPEN plan is never evicted (too-many-nodes)', r7.code === 'too-many-nodes' && !!w2.get('ag'))
  const w3 = world({ limits: { nodesPerSession: 50, agentsPerSession: 2 } })
  w3.call({ agent: 'x1', label: 'X1' }); w3.call({ agent: 'x2', label: 'X2' })
  check('limits: past the AGENT limit with none finished → too-many-agents', w3.call({ agent: 'x3', label: 'X3' }).code === 'too-many-agents')
  w3.call({ agent: 'x1', state: 'done', text: '@done' })
  const r8 = w3.call({ agent: 'x3', label: 'X3' })
  check('limits: …once one has finished, it is evicted to make room', r8.ok && J(r8.evicted.map(e => e.label)) === J(['X1']))
  const w4 = world({ limits: { nodesPerSession: 2, agentsPerSession: 5 } })
  w4.call({ agent: 'p1', label: 'P1' }); w4.call({ agent: 'p1', state: 'done', text: '@done' })
  const r9 = w4.call({ agent: 'p1', key: 'k', label: 'K', plan: ['Z'] })
  check('limits: never what the call itself touches — its agent, target or what it creates (an ancestor of the target stays)', r9.code === 'too-many-nodes' && !!w4.get('p1'))
})

// ================================================================= actions: plan items, plans, agents (6d on ids)
await section(() => {
  const w = world()
  w.call({ key: 'rel', label: 'Release', plan: ['Spec', 'Build', 'Ship'] })
  const spec = w.get('Spec'), rel = w.get('rel')
  const d = w.act(spec.id, 'done')
  check('done: a plan item ticked by id — attributed, a system change (no activity), the line keeps its text', d.ok && d.to_state === 'done' && d.from_state === 'todo' && spec.current.state === 'done' && spec.current.text === 'Spec' && d.entries[0].text === 'marked done by robin via dashboard (ROBIN-Z790)' && d.entries[0].act === 'done' && d.entries[0].by.user === 'robin', J(d.entries[0]))
  check('…the result names the node (id, path before, ident, kind, owner), entry_id, applied, records / entries / writes', d.id === spec.id && d.path === 'Release/Spec' && d.ident.session === 'Bridget' && d.kind === 'context' && d.owner === null && d.entry_id === d.entries[0].id && J(d.applied) === J([{ id: spec.id, path: 'Release/Spec', state: 'done' }]) && d.writes.length === 1)
  check('done again → no-change; skip / reopen / done on a non-item → not-a-plan-item', w.act(spec.id, 'done').code === 'no-change' && w.act(rel.id, 'skip').code === 'not-a-plan-item')
  check('skip → skipped; reopen → back to todo', w.act(w.get('Build').id, 'skip').ok && w.get('Build').current.state === 'skipped' && w.act(w.get('Build').id, 'reopen').ok && w.get('Build').current.state === 'todo')
  // complete / reopen_plan on a context plan
  const c = w.act(rel.id, 'complete')
  check('complete: a CONTEXT plan node — its line done (of:"plan", from open)', c.ok && c.of === 'plan' && c.from_state === 'open' && c.to_state === 'done' && M.planEndHow2(w.sess(), rel) === 'done')
  check('complete again → already-ended; reopen an item of an ended plan warns plan-ended', w.act(rel.id, 'complete').code === 'already-ended' && (r => r.ok && codes(r).includes('plan-ended'))(w.act(spec.id, 'reopen')))
  const ro = w.act(rel.id, 'reopen_plan')
  check('reopen_plan: the plan node runs again (of:"plan", from done)', ro.ok && ro.from_state === 'done' && ro.to_state === 'open' && rel.current.state === 'running' && M.planEndAt2(w.sess(), rel) === null)
  check('reopen_plan on an open plan → not-ended; complete on a node without items → not-a-plan', w.act(rel.id, 'reopen_plan').code === 'not-ended' && w.act(spec.id, 'complete').code === 'not-a-plan')
  // abandon cascades
  w.call({ key: 'sub', label: 'Sub', under: 'Build', text: '@busy' })
  const ab = w.act(w.get('Build').id, 'abandon')
  check('abandon: the item and its OPEN descendants (cascade, listed in applied with from + entry_id)', ab.ok && ab.applied.length === 2 && ab.applied[1].id === w.get('sub').id && ab.applied[1].from === 'running' && w.get('sub').current.state === 'abandoned')
  // agents: complete / abandon_plan by the marker
  w.call({ agent: 'lead', label: 'Lead' })
  w.call({ agent: 'lead', plan: [{ key: 'i1', label: 'I1' }, { key: 'i2', label: 'I2' }] })
  const lead = w.get('lead')
  const ap = w.act(lead.id, 'abandon_plan')
  check('abandon_plan on an AGENT: its open items abandoned, then the plan-end MARKER (the agent keeps running)', ap.ok && ap.of === 'plan' && ap.applied.filter(a => a.item).length === 2 && lead.plan_end && lead.plan_end.state === 'abandoned' && !lead.finished_at && M.planEndHow2(w.sess(), lead) === 'abandoned', J(ap.applied))
  check('abandon_plan again → no-open-plan', w.act(lead.id, 'abandon_plan').code === 'no-open-plan')
  const ro2 = w.act(lead.id, 'reopen_plan')
  check('reopen_plan on an agent clears the marker', ro2.ok && lead.plan_end === null)
  // finish
  check('finish: an ACTIVE agent → not-stale; a context → not-an-agent; a bad state → bad-args', w.act(lead.id, 'finish', { state: 'done' }).code === 'not-stale' && w.act(rel.id, 'finish', { state: 'done' }).code === 'not-an-agent' && w.act(lead.id, 'finish', { state: 'meh' }).code === 'bad-args')
  w.tick(16 * MIN)
  const fin = w.act(lead.id, 'finish', { state: 'failed' })
  check('finish: a STALE agent is marked finished (failed) — "marked finished (failed) by …"', fin.ok && fin.to_state === 'failed' && !!lead.finished_at && /^marked finished \(failed\) by robin/.test(fin.entries[0].text))
  check('finish again → already-finished; args.stale_min is the viewer\'s slider', w.act(lead.id, 'finish', { state: 'done' }).code === 'already-finished')
  check('bad-by, bad-action, bad-id, unknown-session', w.act(lead.id, 'finish', {}, null).code === 'bad-by' && w.act(lead.id, 'explode').code === 'bad-action' && M.applyAction2(w.st, { ...BRIDGET, id: 'nope', action: 'done' }, w.tick(1), { by: DASH }).code === 'bad-id' && M.applyAction2(w.st, { session: 'Nobody', id: lead.id, action: 'done' }, w.tick(1), { by: DASH }).code === 'unknown-session')
})

// ================================================================= actions: dismiss (+ its parent entry), edit text, message, types, questions
await section(() => {
  const w = world()
  w.call({ key: 'team', label: 'Team' })
  w.call({ agent: 'h', label: 'Helper', under: 'team' })
  w.call({ agent: 'h', key: 'notes', label: 'Notes', text: '@writing' })
  const h = w.get('h'), team = w.get('team'), s = w.sess()
  check('dismiss: an active agent → not-stale; a context → not-an-agent', w.act(h.id, 'dismiss').code === 'not-stale' && w.act(team.id, 'dismiss').code === 'not-an-agent')
  w.call({ agent: 'h', state: 'done', text: '@done' })
  const dm = w.act(h.id, 'dismiss')
  const e = dm.entries[0]
  check('dismiss: the agent and its subtree leave the board (ghosts; one `remove` record why "dismiss")', dm.ok && !s.nodes.has(h.id) && s.ghosts.has(h.id) && J(ops(dm)) === J(['remove']) && dm.records[0].why === 'dismiss' && dm.dismissed.nodes === 2 && dm.to_state === 'dismissed' && dm.node === null)
  check('dismiss: its ENTRY is on the PARENT — dismiss:true, of = the removed id (6d, §2.2)', e.n === team.id && e.dismiss === true && e.of === h.id && e.type === 'event' && /^dismissed "Helper" from the board by robin via dashboard/.test(e.text) && dm.entry_id === e.id && team.log.at(-1).id === e.id, J(e))
  check('dismiss: a removed node is gone for later actions (unknown-node, "it was removed")', (r => r.code === 'unknown-node' && /removed/.test(r.what))(w.act(h.id, 'dismiss')))
  w.call({ agent: 'p', label: 'Planner', plan: ['X'] })
  w.call({ agent: 'p', state: 'done', text: '@done' })
  check('dismiss: an agent holding part of an OPEN plan → has-open-items', w.act(w.get('p').id, 'dismiss').code === 'has-open-items')
  // the session root
  const w2 = world()
  w2.call({ agent: 'only', label: 'Only' })
  w2.call({ agent: 'only', state: 'done', text: '@done' })
  const rd = w2.act(M.rootOf(w2.sess()).id, 'dismiss')
  check('dismiss the SESSION: the whole session leaves memory (a remove record for the root; the entry on the root itself)', rd.ok && rd.dismissed.session === true && !w2.sess() && rd.records[0].op === 'remove' && rd.entries[0].of === rd.id)
  // edit_text
  w.call({ key: 'doc', label: 'Doc', text: '@draft', details: 'the story' })
  const doc = w.get('doc')
  const ed = w.act(doc.id, 'edit_text', { text: '@literal text' })
  check('edit_text: the text is taken LITERALLY (a leading @ is text), the line keeps its details, line.by = the editor', ed.ok && doc.current.text === '@literal text' && doc.current.details === 'the story' && doc.current.by.user === 'robin' && ed.from_text === 'draft' && ed.new_text === '@literal text')
  check('edit_text: the LOGGED entry = the text + "(edited by …)"; line_by on it', ed.entries[0].text === '@literal text (edited by robin via dashboard (ROBIN-Z790))' && ed.entries[0].line_by.user === 'robin')
  const eds = w.act(doc.id, 'edit_text', { text: 'blocked on review', state: 'blocked' })
  check('edit_text + state: both change (from / to state)', eds.ok && eds.from_state === 'running' && eds.to_state === 'blocked')
  check('edit_text: the same text + state → no-change; a state the node can\'t take → bad-state; no text → bad-args', w.act(doc.id, 'edit_text', { text: 'blocked on review' }).code === 'no-change' && w.act(doc.id, 'edit_text', { text: 'x', state: 'todo' }).code === 'bad-state' && w.act(doc.id, 'edit_text', {}).code === 'bad-args')
  check('editStates2: a plan item any state, a context no plan states, an agent abandoned only while it holds items', J(M.editStates2(s, doc)) === J(['running', 'blocked', 'failed', 'done', 'idle', 'abandoned']) && !M.editStates2(s, w.get('p')).includes('todo') && M.editStates2(s, w.get('p')).includes('abandoned'))
  // message
  const long = 'Please also cover the migration. '.repeat(10).trim()
  const ms = w.act(doc.id, 'message', { text: long })
  check('message: LOGGED on the node ("robin via dashboard: <preview>"), the full text in details; the line is untouched', ms.ok && ms.message === long && ms.entries[0].text.startsWith('robin via dashboard: Please also cover') && [...ms.entries[0].text].length <= 240 && ms.entries[0].details === long && ms.entries[0].current === false && doc.current.text === 'blocked on review')
  check('message: empty → bad-args; over 2000 → message-too-long', w.act(doc.id, 'message', { text: '  ' }).code === 'bad-args' && w.act(doc.id, 'message', { text: 'x'.repeat(2001) }).code === 'message-too-long')
  // show as group / plan (setType2)
  w.call({ key: 'cands', label: 'Candidates' })
  const g = w.act(w.get('cands').id, 'show_as_group')
  check('show_as_group: wired to setType2 — a type record, from_type / to_type', g.ok && w.get('cands').type === 'group' && J(ops(g)) === J(['type']) && g.from_type === 'context' && g.to_type === 'group' && g.records[0].act === 'show_as_group')
  check('show_as_plan back; the same again → no-change', w.act(w.get('cands').id, 'show_as_plan').ok && w.get('cands').type === 'plan' && w.act(w.get('cands').id, 'show_as_plan').code === 'no-change')
  // questions (answerQuestion2 / withdrawQuestion2)
  w.call({ agent: 'asker', label: 'Asker' })
  const q = w.call({ agent: 'asker', ask: 'Which database should the cache use?', choices: ['Postgres', 'SQLite'] })
  const an = w.act(q.node.id, 'answer', { choice: 'sqlite' })
  check('answer: wired to answerQuestion2 — answer, owner = the asking agent, to_state done', an.ok && an.answer.choice === 'SQLite' && an.to_state === 'done' && an.from_state === 'blocked' && an.agent.key === 'asker' && an.owner.key === 'asker' && an.entries[0].type === 'answer')
  const ch = w.act(q.node.id, 'change_answer', { choice: 'Postgres' })
  check('change_answer: wired (revised, previous)', ch.ok && ch.question.revised === 1 && ch.previous.answer.choice === 'SQLite')
  const q2 = w.call({ agent: 'asker', ask: 'Ship today?', choices: ['Yes', 'No'] })
  const wd = w.act(q2.node.id, 'withdraw')
  check('withdraw: wired to withdrawQuestion2 (abandoned)', wd.ok && wd.to_state === 'abandoned' && wd.question.status === 'withdrawn')
  check('edit_text on a question → question-node (its line is the question); editStates2 offers it nothing', w.act(q.node.id, 'edit_text', { text: 'x' }).code === 'question-node' && M.editStates2(s, q.node.id && s.nodes.get(q.node.id)).length === 0)
})

// ================================================================= actions: move / reorder / rename / merge + the clash dialog (§1.6, Q32)
await section(() => {
  const w = world()
  w.call({ key: 'a', label: 'A' }); w.call({ key: 'b', label: 'B' })
  w.call({ key: 'n', label: 'Notes', under: 'a' }); w.call({ key: 'n1', label: 'One', under: 'n' }); w.call({ key: 'n2', label: 'Two', under: 'n' })
  w.call({ key: 'm', label: 'Notes', under: 'b' }); w.call({ key: 'm1', label: 'One', under: 'm' }); w.call({ key: 'm3', label: 'Three', under: 'm' })
  w.call({ key: 'x', label: 'X', under: 'b' })
  const s = w.sess(), A = w.get('a'), B = w.get('b'), N = w.get('n'), Mn = w.get('m')
  // rename
  check('rename: by id (a label record), its old path an alias; onto a sibling\'s label → duplicate-label + suggestion; same → no-change',
    (r => r.ok && r.from_label === 'X' && r.label === 'Y' && J(ops(r)) === J(['label']))(w.act(w.get('x').id, 'rename', { label: 'Y' })) &&
    (r => r.code === 'duplicate-label' && r.suggestion === 'notes (2)' && r.sibling.id === Mn.id)(w.act(w.get('x').id, 'rename', { label: 'notes' })) && w.act(w.get('x').id, 'rename', { label: 'Y' }).code === 'no-change')
  // reorder
  const ro = w.act(w.get('x').id, 'reorder', { before_id: Mn.id })
  check('reorder: by before_id — "to the top" / "before Notes"', ro.ok && J(w.kids('b')) === J(['Y', 'Notes']) && ro.where === 'before Notes' && ro.rank === w.get('x').rank)
  check('reorder: already there → no-change; no position → bad-args', w.act(w.get('x').id, 'reorder', { position: 'first' }).code === 'no-change' && w.act(w.get('x').id, 'reorder', {}).code === 'bad-args')
  // the clash dialog: clashes2
  const cl = M.clashes2(w.st, BRIDGET, N.id, { to_id: B.id })
  const c0 = cl.clashes[0]
  check('clashes2: moving Notes under B clashes with B\'s Notes — merge offered, suggestion "Notes (2)", and the clash "merge them" would make one level down (One)', cl.ok && cl.clashes.length === 1 && c0.id === N.id && c0.sibling.id === Mn.id && c0.can_merge && c0.suggestion === 'Notes (2)' && c0.under_id === B.id && J(c0.nested.map(x => [x.label, x.sibling.id])) === J([['One', w.get('m1').id]]), J(cl))
  // a move that clashes, unanswered
  const s0 = snap(s)
  const un = w.act(N.id, 'move', { to_id: B.id })
  check('move onto a same-label sibling with no answer → duplicate-label carrying the dialog\'s clash list (nothing written)', un.code === 'duplicate-label' && un.clashes.length === 1 && un.clashes[0].nested.length === 1 && snap(s) === s0)
  // answer: a different label
  const rl = w.act(N.id, 'move', { to_id: B.id, label: 'Notes (2)' })
  check('answer "use a different label": moved AND relabelled as ONE change (move + label records)', rl.ok && J(ops(rl)) === J(['move', 'label']) && N.label === 'Notes (2)' && N.parent === B.id && rl.label === 'Notes (2)' && rl.moved_from === 'A/Notes' && rl.to === 'B')
  // move back, then answer "merge them" with the nested clash answered too
  w.call({ key: 'n', move: 'a', rename: 'Notes' })
  const s2 = snap(s)
  const mg0 = w.act(N.id, 'move', { to_id: B.id, merges: [{ id: N.id, into_id: Mn.id }] })
  check('answer "merge them" whose merge would clash one level down, unanswered → duplicate-label + the fresh clash list (nothing written)', mg0.code === 'duplicate-label' && mg0.clashes.length === 1 && mg0.clashes[0].nested.length === 1 && snap(s) === s2 && N.parent === A.id && !N.merged_into)
  const mg = w.act(N.id, 'move', { to_id: B.id, merges: [{ id: N.id, into_id: Mn.id }, { id: w.get('n1').id, into_id: w.get('m1').id }] })
  check('answer "merge them" + the nested clash merged too: Notes merges into B/Notes, its One into B/Notes/One, Two moves over', mg.ok && N.merged_into === Mn.id && w.get('n1').merged_into === w.get('m1').id && w.get('n2').parent === Mn.id && J(ops(mg)) === J(['merge', 'merge']) && mg.into_id === Mn.id && mg.merged.kids.includes(w.get('n2').id), J(ops(mg)))
  check('…the nested merge record comes first; the outer one lists only the children that moved', mg.records[0].n === w.get('n1').id && J(mg.records[1].kids) === J([w.get('n2').id]))
  // merge action (into_id) with a label answer
  const w2 = world()
  w2.call({ key: 'p', label: 'P' }); w2.call({ key: 'q', label: 'Q' })
  w2.call({ key: 'p1', label: 'Shared', under: 'p' }); w2.call({ key: 'q1', label: 'Shared', under: 'q' })
  const P = w2.get('p'), Q = w2.get('q'), p1 = w2.get('p1')
  check('merge (Merge into…) with a clashing child and no answer → duplicate-label + clashes', (r => r.code === 'duplicate-label' && r.clashes.length === 1 && r.clashes[0].id === p1.id)(w2.act(P.id, 'merge', { into_id: Q.id })))
  const s1 = snap(w2.sess())
  check('an answer for a node that does not clash (the tree changed) → clash-changed, nothing written', (r => r.code === 'clash-changed' && snap(w2.sess()) === s1)(w2.act(P.id, 'merge', { into_id: Q.id, merges: [{ id: p1.id, label: 'Shared (2)' }, { id: Q.id, label: 'Zzz' }] })))
  check('a "merge them" answer naming the wrong sibling → clash-changed', w2.act(P.id, 'merge', { into_id: Q.id, merges: [{ id: p1.id, into_id: P.id }] }).code === 'clash-changed')
  const ml = w2.act(P.id, 'merge', { into_id: Q.id, merges: [{ id: p1.id, label: 'Shared (2)' }] })
  check('merge + "use a different label" for the child: it is relabelled as it lands (label record before the merge record)', ml.ok && J(ops(ml)) === J(['label', 'merge']) && p1.label === 'Shared (2)' && p1.parent === Q.id && P.merged_into === Q.id && ml.into === 'Q')
  check('merge: a label on the merge itself → bad-args; bad merges shapes → bad-args', w2.act(Q.id, 'merge', { into_id: P.id, label: 'x' }).code === 'bad-args' && w2.act(Q.id, 'move', { to_id: P.id, merges: [{ id: 'nope' }] }).code === 'bad-args')
  // agents: no "merge them"
  const w3 = world()
  w3.call({ key: 'home', label: 'Home' }); w3.call({ key: 'away', label: 'Away' })
  w3.call({ agent: 'bot', label: 'Bot', under: 'home' }); w3.call({ key: 'bot2', label: 'Bot', under: 'away' })
  const cb = M.clashes2(w3.st, BRIDGET, w3.get('bot').id, { to_id: w3.get('away').id })
  check('clashes2: for an AGENT "merge them" is not offered (can_merge false, no nested)', cb.clashes.length === 1 && cb.clashes[0].can_merge === false && cb.clashes[0].nested.length === 0)
  const s3 = snap(w3.sess())
  check('…and a "merge them" answer for it is refused (bad-merge), nothing written', w3.act(w3.get('bot').id, 'move', { to_id: w3.get('away').id, merges: [{ id: w3.get('bot').id, into_id: w3.get('bot2').id }] }).code === 'bad-merge' && snap(w3.sess()) === s3)
  check('a label answer that is itself taken there → clash-changed (with the fresh list)', (r => r.code === 'clash-changed' && r.clashes.length === 1 && snap(w3.sess()) === s3)(w3.act(w3.get('bot').id, 'move', { to_id: w3.get('away').id, label: 'bot' })))
  // a plain move with a position
  w3.call({ key: 'a1', label: 'A1', under: 'away' })
  const mp = w3.act(w3.get('home').id, 'move', { to_id: w3.get('away').id, before_id: w3.get('a1').id })
  check('move (to_id + before_id): re-parented and placed (where, rank)', mp.ok && J(w3.kids('away')) === J(['Bot', 'Home', 'A1']) && mp.where === 'before A1' && mp.to === 'Away' && mp.to_id === w3.get('away').id)
  check('move to its own parent without a position → no-change; the root → bad-move; no to_id → bad-args', w3.act(w3.get('home').id, 'move', { to_id: w3.get('away').id }).code === 'no-change' && w3.act(M.rootOf(w3.sess()).id, 'move', { to_id: w3.get('away').id }).code === 'bad-move' && w3.act(w3.get('home').id, 'move', {}).code === 'bad-args')
})

// ================================================================= notices (§5.5) — what each action notifies, and to whom
await section(() => {
  const w = world()
  w.call({ key: 'rel', label: 'Release', plan: ['Spec', 'Build'] })
  w.call({ agent: 'lead', label: 'Lead', under: 'rel' })
  w.call({ agent: 'lead', key: 'docs', label: 'Docs', text: '@writing' })
  const spec = w.get('Spec'), docs = w.get('docs', 'lead')
  const d = w.act(spec.id, 'done')
  const n = M.actionNotice2(d, { host: 'ROBIN-Z790', ts: 5, state: w.st })
  check('notice: done → activity_changed "robin marked Release/Spec done", batched (now:false), to the node\'s session', n.verb === 'activity_changed' && n.subject === 'robin marked Release/Spec done' && n.now === false && n.to.session === 'Bridget' && n.to.project === 'AIMB' && n.agent === null, J(n))
  check('notice body: node_id, key, scope beside path (§5.5); from / to state; by; entry_id; ts', n.body.node_id === spec.id && n.body.key === 'Spec' && n.body.scope === '' && n.body.path === 'Release/Spec' && n.body.from_state === 'todo' && n.body.to_state === 'done' && n.body.by.user === 'robin' && n.body.entry_id === d.entry_id && n.body.ts === 5)
  const e = w.act(docs.id, 'edit_text', { text: 'Docs are blocked', state: 'blocked' })
  const ne = M.actionNotice2(e, { state: w.st })
  check('notice: edit_text → activity_text_edited, names the state change, carries the line before → after; agent = the owning agent', ne.verb === 'activity_text_edited' && ne.subject === 'robin edited Release/Lead/Docs (running → blocked)' && ne.body.from_text === 'writing' && ne.body.text === 'Docs are blocked' && ne.agent.key === 'lead', J(ne))
  // the path at SEND time (computed from the id)
  w.call({ key: 'rel', rename: 'Release 2.0' })
  const late = M.actionNotice2(d, { state: w.st })
  check('notice: the subject names the node\'s path NOW (a rename before the batch flushed shows the new path)', late.subject === 'robin marked Release 2.0/Spec done' && late.body.path === 'Release 2.0/Spec')
  check('…without the model it falls back to the path the action saw', M.actionNotice2(d).subject === 'robin marked Release/Spec done')
  // message, answers: at once
  const ms = w.act(docs.id, 'message', { text: 'Can you also cover the migration script and its dry run?' })
  const nm = M.actionNotice2(ms, { state: w.st })
  check('notice: message → activity_message, at once (now:true), subject = a few words only, body = the whole text', nm.verb === 'activity_message' && nm.now === true && nm.subject === 'robin about Release 2.0/Lead/Docs: Can you also cover the migration…' && nm.body.text === ms.message && nm.agent.key === 'lead', J(nm.subject))
  const q = w.call({ agent: 'lead', ask: 'Which database should the cache use?', choices: ['Postgres', 'SQLite'] })
  const an = w.act(q.node.id, 'answer', { choice: 'Postgres' })
  const na = M.actionNotice2(an, { state: w.st })
  check('notice: answer → activity_answer, at once, to the session with the asking agent named — the subject never holds the answer', na.verb === 'activity_answer' && na.now === true && /^robin answered Release 2\.0\/Lead\/\?1: Which database should the cache/.test(na.subject) && !/Postgres/.test(na.subject) && na.body.answer.choice === 'Postgres' && na.body.status === 'answered' && na.body.agent.key === 'lead' && na.agent.key === 'lead', J(na))
  const q2 = w.call({ agent: 'lead', ask: 'Ship it?', choices: ['Yes', 'No'], expires: '1m' })
  const ex = M.expireQuestions2(w.st, w.tick(2 * MIN))
  const nx = M.actionNotice2(ex.expired[0], { state: w.st })
  check('notice: an expiry (the bridge) → activity_answer "question expired …", status expired', nx.verb === 'activity_answer' && /^question expired Release 2\.0\/Lead\/\?2: Ship it\?/.test(nx.subject) && nx.body.status === 'expired' && nx.body.by === 'bridge', J(nx))
  void q2
  // structural actions (2.0's new ones)
  w.call({ key: 'later', label: 'Later' })
  const mv = w.act(w.get('Build').id, 'move', { to_id: w.get('later').id })
  const nmv = M.actionNotice2(mv, { state: w.st })
  check('notice: move names the OLD path and the destination ("robin moved Release 2.0/Build to Later")', nmv.subject === 'robin moved Release 2.0/Build to Later' && nmv.body.moved_from === 'Release 2.0/Build' && nmv.body.to === 'Later' && nmv.body.path === 'Later/Build')
  const rn = w.act(w.get('later').id, 'rename', { label: 'Someday' })
  check('notice: rename → "robin renamed Later to "Someday"" (from_label / label in the body)', (x => x.subject === 'robin renamed Later to "Someday"' && x.body.from_label === 'Later' && x.body.label === 'Someday')(M.actionNotice2(rn, { state: w.st })))
  w.call({ key: 'm1', label: 'M1' }); w.call({ key: 'm2', label: 'M2' })
  const mg = w.act(w.get('m1').id, 'merge', { into_id: w.get('m2').id })
  check('notice: merge → "robin merged M1 into M2"', (x => x.verb === 'activity_changed' && x.subject === 'robin merged M1 into M2' && x.body.into_id === w.get('m2').id)(M.actionNotice2(mg, { state: w.st })))
  const sg = w.act(w.get('m2').id, 'show_as_group')
  check('notice: Show as group → "robin showed M2 as a group"', (x => x.subject === 'robin showed M2 as a group' && x.body.to_type === 'group')(M.actionNotice2(sg, { state: w.st })))
  w.call({ agent: 'lead', state: 'done', text: '@done' })
  w.call({ key: 'rel', plan: ['Spec'] })
  w.act(w.get('Spec').id, 'skip')
  const dm = M.applyAction2(w.st, { ...BRIDGET, id: w.get('lead').id, action: 'dismiss' }, w.tick(1), { by: DASH })
  check('notice: dismiss of an agent → "robin dismissed Release 2.0/Lead from the board" (the path it had; it is gone now)', dm.ok && (x => x.subject === 'robin dismissed Release 2.0/Lead from the board' && x.body.dismissed.nodes >= 2)(M.actionNotice2(dm, { state: w.st })), J(dm.code || dm.what))
  // a batch for one session
  w.call({ key: 'p', label: 'Plan', plan: ['A', 'B', 'C'] })
  const ns = [w.act(w.get('A').id, 'skip'), w.act(w.get('B').id, 'skip'), w.act(w.get('C').id, 'done')].map(r => M.actionNotice2(r, { state: w.st }))
  const cb = M.combineActionNotices2(ns)
  check('combineActionNotices2: one subject per session — "robin skipped 2 items and marked 1 done in Plan"', cb.subject === 'robin skipped 2 items and marked 1 done in Plan' && cb.body.count === 3 && cb.body.actions.length === 3, cb.subject)
  check('…one notice is returned as it is', M.combineActionNotices2([ns[0]]).subject === ns[0].subject)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
