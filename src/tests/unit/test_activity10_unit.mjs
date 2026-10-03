// Fast UNIT tests for #88 (v2.0) build step 10 — the DASHBOARD's units on the 2.0 board (docs/spec-88.md §5.4, §5.7;
// lib/activity2-dash.js + lib/activity2.js menuStatic2): no bridge, no sockets. Covered:
//   - the UNITS by node id: one per session group (its key = groupKey; each host's ROOT rides it as self / selves with its
//     node_id), one per node (id = ["n", group, lc(host), nodeId], parent_id — the root's id at the top level); the root,
//     a merged node and an orphan are no node units;
//   - deltas by id (planDashDelta2): a report = that node's unit; a RENAME and a MOVE keep every id (no remove — the
//     dashboard's selection and view records survive), the descendants' paths follow; a merge removes the merged node's
//     unit; a dismissal removes the subtree; TIME never changes a unit (an open attempt is the page's clock);
//   - the TYPE fields: a plan's / a group's / a question's / a test-run's type, bar (none for a group / question), the
//     test-run's tests bar (Q56), took (timing2 without a clock), the menu (menuStatic2: the registry's entries that apply
//     now, finish / dismiss marked for the page's slider — "finish|quiet", "dismiss|quiet-tree" — and dismiss left out while
//     the node is part of an OPEN plan), edit states, transient;
//   - the RAW state: a local agent of a session that LEFT shows gone (+ was), a remote host DOWN → gone + host_down;
//   - the MERGED board: a session on two hosts = ONE session unit (multi_host, hosts, home, selves, the headline host),
//     each host's nodes their own units; the type registry (dashTypes2) carries every menu action's label.
import { testOnly } from '../helpers/check.mjs'
import * as M from '../../lib/activity2.js'
import * as S from '../../lib/activity2-store.js'
import * as G from '../../lib/activity2-gossip.js'
import { dashUnits2, planDashDelta2, dashTypes2, dashNode2 } from '../../lib/activity2-dash.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.stack} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
function section(name, fn) { try { fn() } catch (e) { fail++; console.log(`FAIL section "${name}" crashed:`, (e && e.stack) || e) } }
const ID = { session: 'Bridget', project: 'AIMB', user: 'robin', realm: 'default' }
const BY = { kind: 'dashboard', user: 'robin', host: 'H' }
const T0 = 1790000000000
const objs = units => [...units.values()].map(u => u.obj)
const nodeU = (units, label) => objs(units).find(u => u.kind === 'node' && u.label === label)
const sessU = units => objs(units).find(u => u.kind === 'session')
function board() {
  const st = S.createStore2({ host: 'H' })
  const ap = (i, t) => { const r = st.apply(ID, i, T0 + t); if (!r.ok) throw new Error(`apply ${J(i)}: ${r.code} ${r.what}`); return r }
  ap({ key: 'rel', label: 'Next release', context_type: 'plan', plan: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }, 1000)
  ap({ agent: 'w', label: 'Worker', under: 'a', text: '@on it', state: 'running' }, 2000)
  ap({ key: 'g', label: 'Ideas', context_type: 'group' }, 3000)
  ap({ key: 'n1', label: 'Notes', under: 'g', text: '@a note' }, 3100)
  ap({ key: 'n2', label: 'Other', under: 'g', text: '@done one', state: 'done' }, 3200)
  ap({ key: 'tr', label: 'Tests', context_type: 'test-run', plan: [{ key: 't1', label: 'T1' }, { key: 't2', label: 'T2' }, { key: 't3', label: 'T3' }] }, 4000)
  ap({ key: 't1', text: 'ok', message_type: 'test-result', fields: { result: 'pass', checks: 3 } }, 5000)
  ap({ key: 't2', text: 'bad', message_type: 'test-result', fields: { result: 'fail', checks: 2, failed: 1 } }, 5100)
  ap({ key: 'q', label: 'Q', ask: 'Which database should the cache use?', choices: ['Postgres', 'SQLite'] }, 6000)
  ap({ key: 'tmp', label: 'Scratch', transient: true }, 7000)
  ap({ key: 'kid', label: 'Kid', under: 'tmp', text: '@x' }, 7100)
  return st
}

section('units by node id', () => {
  const st = board(), u = dashUnits2({ state: st.state, host: 'H' }), sess = M.getSession2(st.state, ID)
  const s = sessU(u)
  check('one session unit: id ["s", groupKey], key = the group, the root as self with its node_id (kind session)', s.id === J(['s', s.key]) && s.key === J(['default', 'aimb', 'robin', 'bridget']) && s.self.node_id === sess.rootId && s.self.kind === 'session' && s.self.nkind === 'session' && s.host === 'H' && !s.multi_host, J(s).slice(0, 300))
  const nodes = objs(u).filter(x => x.kind === 'node')
  check('one node unit per live node (not the root): id ["n", group, lc(host), node id], node_id, parent_id', nodes.length === sess.nodes.size - 1 && nodes.every(x => x.id === J(['n', s.key, 'h', x.node_id]) && sess.nodes.has(x.node_id) && x.node_id !== sess.rootId), J(nodes.map(x => x.id)))
  const rel = nodeU(u, 'Next release'), a = nodeU(u, 'A'), w = nodeU(u, 'Worker')
  check('parent_id: a top-level node names the ROOT; a child its parent; path / depth / label / key / scope', rel.parent_id === sess.rootId && a.parent_id === rel.node_id && w.parent_id === a.node_id && w.path === 'Next release/A/Worker' && w.depth === 3 && w.key === 'w' && w.nkind === 'agent' && a.key === 'a' && !a.scope && a.label === 'A' && a.name === 'A', J([rel, a, w].map(x => [x.parent_id, x.path, x.depth, x.key, x.scope])))
  check('the effective RANK rides every node (a derived one when none was placed): siblings sort as childrenOf2', [a, nodeU(u, 'B')].every(x => typeof x.rank === 'string' && x.rank.length > 0) && a.rank < nodeU(u, 'B').rank)
  check('raw state + raw times: a running agent is "running" (stale is the page\'s), last_activity / created_at sent, no stale_at', w.state === 'running' && w.last_activity === T0 + 2000 && w.created_at === T0 + 2000 && !('stale_at' in w) && !('stale' in w))
  check('the line without details / data (has_* flags), the question on a question\'s line', w.current.text === 'on it' && !('details' in w.current) && nodeU(u, 'Q').current.question.status === 'asked' && J(nodeU(u, 'Q').current.question.choices) === J(['Postgres', 'SQLite']))
})

section('types', () => {
  const st = board(), u = dashUnits2({ state: st.state, host: 'H' })
  const rel = nodeU(u, 'Next release'), g = nodeU(u, 'Ideas'), q = nodeU(u, 'Q'), tr = nodeU(u, 'Tests'), a = nodeU(u, 'A')
  check('a plan: type plan, its bar = its items ("N of M"), plan_node, open (no plan_end_at)', rel.type === 'plan' && rel.bar.items && rel.bar.total === 2 && rel.plan_node && rel.plan_end_at == null && a.plan_item && Number.isInteger(a.plan_ix))
  check('a group: type group, NO bar (the page counts its children: abandoned / hidden not counted)', g.type === 'group' && !('bar' in g) && !g.plan_node)
  check('a question: type question, no bar', q.type === 'question' && !('bar' in q))
  check('a test-run (Q56): its tests bar — passed vs failed vs total, the counts in its tooltip; its items bar is what it adds to its parent', tr.type === 'test-run' && tr.tests.passed === 1 && tr.tests.failed === 1 && tr.tests.total === 3 && Math.round(tr.tests.pct_passed) === 33 && /1 passed · 1 failed · 1 to go of 3 · 5 checks \(1 failed\)/.test(tr.tests.tooltip) && tr.bar.items && tr.bar.done === 2, J(tr.tests))
  check('TIME: a finished test-run plan shows nothing yet; an open attempt carries started_at (no running_ms: the page\'s clock); a transient context says so', nodeU(u, 'Worker').took.started_at === T0 + 2000 && !('running_ms' in nodeU(u, 'Worker').took) && nodeU(u, 'Scratch').transient === true, J(nodeU(u, 'Worker').took))
  const types = dashTypes2()
  check('dashTypes2: every node type with its glyph, show and a label + group for every menu action of the registry', Object.keys(M.NODE_TYPES).every(t => types[t] && types[t].glyph === M.NODE_TYPES[t].glyph && types[t].show === M.NODE_TYPES[t].show && M.NODE_TYPES[t].menu.every(m => types[t].menu[m.action] && types[t].menu[m.action].label === m.label && types[t].menu[m.action].group === m.group)))
})

section('menus (menuStatic2)', () => {
  const st = board(), u = dashUnits2({ state: st.state, host: 'H' })
  const w = nodeU(u, 'Worker'), a = nodeU(u, 'A'), q = nodeU(u, 'Q'), g = nodeU(u, 'Ideas'), s = sessU(u)
  check('an agent under an open plan item (holding no part of it): finish|quiet and dismiss|quiet-tree (the page checks both against its slider); move / rename / edit / message', J(w.menu) === J(['finish|quiet', 'dismiss|quiet-tree', 'move', 'rename', 'edit_text', 'message']), J(w.menu))
  check('a plan item: its item actions, abandon, Show as plan (not group: it counts in its plan), merge, move, rename, edit, message', J(a.menu) === J(['done', 'skip', 'abandon', 'show_as_plan', 'merge', 'move', 'rename', 'edit_text', 'message']), J(a.menu))
  check('an open question: answer, withdraw, move, message (no edit: its line is the question)', J(q.menu) === J(['answer', 'withdraw', 'move', 'message']), J(q.menu))
  check('a group: abandon, Show as plan, merge, move, rename, edit, message', J(g.menu) === J(['abandon', 'show_as_plan', 'merge', 'move', 'rename', 'edit_text', 'message']), J(g.menu))
  check('the session root: its plan (abandon), finish|quiet, dismiss … NOT while it holds an open plan, edit, message', s.self.menu.includes('abandon_plan') && s.self.menu.includes('finish|quiet') && !s.self.menu.some(x => /^dismiss/.test(x)) && s.self.menu.includes('edit_text'), J(s.self.menu))
  // the Worker finishes; the plan ends → finish gone, dismiss offered (the page checks its subtree is quiet)
  st.apply(ID, { agent: 'w', text: '@done', state: 'done' }, T0 + 9000)
  st.action({ ...ID, id: nodeU(u, 'A').node_id, action: 'done' }, T0 + 9100, { by: BY })
  st.action({ ...ID, id: nodeU(u, 'B').node_id, action: 'done' }, T0 + 9200, { by: BY })
  const u2 = dashUnits2({ state: st.state, host: 'H' }), w2 = nodeU(u2, 'Worker')
  check('a FINISHED agent outside any open plan: no finish, dismiss|quiet-tree; the ended plan: reopen? no — every item done (all-done)', !w2.menu.includes('finish|quiet') && w2.menu.includes('dismiss|quiet-tree') && nodeU(u2, 'Next release').plan_end_how === 'all-done' && !nodeU(u2, 'Next release').menu.includes('complete'), J([w2.menu, nodeU(u2, 'Next release').menu]))
  check('edit states: a plan item any state; an agent no todo / skipped', J(nodeU(u2, 'A').edit_states) === J(M.editStates2(M.getSession2(st.state, ID), M.getSession2(st.state, ID).nodes.get(nodeU(u2, 'A').node_id))) && !w2.edit_states.includes('todo'))
})

section('deltas by id', () => {
  const st = board(), pub = new Map()
  const full = planDashDelta2(pub, dashUnits2({ state: st.state, host: 'H' }), { full: true })
  check('a full board: sessions first, then nodes parents before children', full.upsert[0].kind === 'session' && full.upsert.slice(1).every((x, i, a) => i === 0 || (a[i - 1].depth || 0) <= (x.depth || 0)) && !full.remove.length)
  check('nothing changed → an empty delta', planDashDelta2(pub, dashUnits2({ state: st.state, host: 'H' })).empty)
  check('TIME passing never changes a unit (raw times; the clock is the page\'s)', (() => { const p2 = new Map(pub); return planDashDelta2(p2, dashUnits2({ state: st.state, host: 'H' })).empty })())
  const u0 = dashUnits2({ state: st.state, host: 'H' }), wid = nodeU(u0, 'Worker').id
  st.apply(ID, { agent: 'w', text: '@reading' }, T0 + 10000)
  const d1 = planDashDelta2(pub, dashUnits2({ state: st.state, host: 'H' }))
  check('a report: the node\'s unit (+ its activity chain / rollups), no removal', d1.upsert.some(x => x.id === wid && x.current.text === 'reading') && !d1.remove.length, J(d1.upsert.map(x => x.label)))
  const relId = nodeU(u0, 'Next release').node_id, ids0 = new Set([...u0.keys()])
  st.action({ ...ID, id: relId, action: 'rename', args: { label: 'Release 2.0' } }, T0 + 11000, { by: BY })
  const u1 = dashUnits2({ state: st.state, host: 'H' }), d2 = planDashDelta2(pub, u1)
  check('a RENAME keeps every id (no remove): the node\'s new label, its descendants\' paths follow', !d2.remove.length && J([...u1.keys()].sort()) === J([...ids0].sort()) && nodeU(u1, 'Release 2.0').node_id === relId && nodeU(u1, 'Worker').path === 'Release 2.0/A/Worker' && d2.upsert.some(x => x.node_id === relId), J(d2))
  const gId = nodeU(u1, 'Ideas').node_id, kidId = nodeU(u1, 'Kid').node_id
  st.action({ ...ID, id: kidId, action: 'move', args: { to_id: gId } }, T0 + 12000, { by: BY })
  const u2 = dashUnits2({ state: st.state, host: 'H' }), d3 = planDashDelta2(pub, u2)
  check('a MOVE keeps its id: parent_id changes; the transient it left vanished → that unit removed', nodeU(u2, 'Kid').parent_id === gId && nodeU(u2, 'Kid').id === nodeU(u1, 'Kid').id && d3.remove.length === 1 && d3.remove[0] === nodeU(u1, 'Scratch').id && !nodeU(u2, 'Scratch'), J(d3.remove))
  const otherId = nodeU(u2, 'Other').node_id, notesId = nodeU(u2, 'Notes').node_id
  st.action({ ...ID, id: otherId, action: 'merge', args: { into_id: notesId } }, T0 + 13000, { by: BY })
  const d4 = planDashDelta2(pub, dashUnits2({ state: st.state, host: 'H' }))
  check('a MERGE removes the merged node\'s unit (a merged node is never a unit)', J(d4.remove) === J([nodeU(u2, 'Other').id]), J(d4.remove))
})

section('gone, host down, the merged multi-host board', () => {
  const st = board()
  M.markSessionGone2(st.state, ID, T0 + 20000)
  const u = dashUnits2({ state: st.state, host: 'H' }), w = nodeU(u, 'Worker'), s = sessU(u)
  check('a LOCAL session that left: its running agent shows gone (was running), gone_at; a context keeps its own state (the page follows its agent); the session unit\'s gone_at', w.state === 'gone' && w.was === 'running' && w.gone_at === T0 + 20000 && nodeU(u, 'Notes').state === 'running' && s.gone_at === T0 + 20000 && s.self.state === 'gone', J([w.state, w.was, s.gone_at, s.self.state]))
  M.markSessionGone2(st.state, ID, null)
  // a second host with the SAME session (and one of its own), via gossip v6
  const peer = S.createStore2({ host: 'P' })
  peer.apply(ID, { key: 'docs', label: 'Docs', text: '@writing' }, T0 + 30000)
  peer.apply(ID, { text: '@peer headline' }, T0 + 30500)
  peer.apply({ ...ID, session: 'Solo' }, { key: 'x', label: 'X', text: '@x' }, T0 + 31000)
  const rem = G.createRemote2({ origin: 'H' })
  const body = G.planSlice2(peer.state, G.createPub2(), { full: true }).body
  check('harness: the peer\'s full slice is taken', G.applySlice2(rem, 'P', { ...body, epoch: 'e', seq: 1 }).ok)
  const mu = dashUnits2({ state: st.state, host: 'H', remote: rem })
  const both = objs(mu).find(x => x.kind === 'session' && x.session === 'Bridget'), solo = objs(mu).find(x => x.kind === 'session' && x.session === 'Solo')
  check('a session on TWO hosts = ONE session unit: multi_host, hosts (local first), home = the host it first appeared on, a self per host', both.multi_host && J(both.hosts) === J(['H', 'P']) && both.home === 'H' && both.selves.length === 2 && both.selves.every(x => x.node_id && x.kind === 'session') && both.selves[1].host === 'P', J(both).slice(0, 400))
  check('… its headline host = the one that SET a line most recently (P\'s root line)', both.self.host === 'P' && both.self.current.text === 'peer headline')
  check('… each host\'s nodes are their own units (the host in the id), the remote node\'s parent_id = ITS root', (() => { const d = nodeU(mu, 'Docs'); return d.id === J(['n', both.key, 'p', d.node_id]) && d.host === 'P' && d.parent_id === both.selves[1].node_id })())
  check('a remote-only session is a one-host session unit', solo.host === 'P' && !solo.multi_host)
  G.markOriginDown2(rem, 'P', T0 + 40000)
  const du = dashUnits2({ state: st.state, host: 'H', remote: rem })
  const bd = objs(du).find(x => x.kind === 'session' && x.session === 'Bridget')
  check('the remote host DOWN: its nodes carry host_down, its root shows gone; the session unit lists it in hosts_down', nodeU(du, 'Docs').host_down === T0 + 40000 && bd.selves[1].state === 'gone' && J(bd.hosts_down) === J(['P']), J([nodeU(du, 'Docs'), bd.hosts_down]))
  check('the project\'s canonical spelling and the client kind are the caller\'s (#71 / #79)', (() => { const k = dashUnits2({ state: st.state, host: 'H', project: () => 'Aimb', kindOf: g => (g.session === 'Bridget' ? 'code' : null) }); const x = sessU(k); return x.project === 'Aimb' && x.client_kind === 'code' })())
})

section('dashNode2', () => {
  const st = board(), sess = M.getSession2(st.state, ID)
  const n = [...sess.nodes.values()].find(x => x.label === 'T2')
  const d = dashNode2(sess, n, { host: 'H', memo: new Map() })
  check('a test\'s kept test-result rides its unit (the panel\'s details); a finished test has its time', d.test.result === 'fail' && d.state === 'done' && d.plan_item, J(d))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
