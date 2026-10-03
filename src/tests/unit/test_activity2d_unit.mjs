// Fast UNIT tests for #88 (v2.0) build step 2d — the first USER types on 2b's registries: the `test-run` node type (its
// items across its buckets, its bar + pass / fail counts, its plan end), the `test-result` message type (typed fields,
// validated; the node keeps its latest one), the #92 context-aware menu as registry data (menuOf2), and how #81's dashboard
// test reporter maps onto them (docs/spec-88.md §1.7, §3.8, §8 step 2d). Pure: no bridge, no sockets; time is passed in.
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
  const byPath = p => M.findPath(sess(), p)
  const kids = k => M.childrenOf2(sess(), typeof k === 'string' ? byPath(k) : k || M.rootOf(sess())).map(c => c.label)
  const bar = n => M.bar2(sess(), typeof n === 'string' ? get(n) : n)
  const counts = n => M.testCounts2(sess(), typeof n === 'string' ? get(n) : n)
  const menu = (n, o) => M.menuOf2(sess(), typeof n === 'string' ? get(n) : n, { now, ...o }).map(m => m.action)
  return { st, call, act, sess, tick, at, get, byPath, kids, bar, counts, menu }
}
const codes = r => (r.warnings || []).map(w => w.code)
const ops = r => (r.records || []).map(x => x.op)

// ================================================================= the registries: the reserved names are built now
await section(() => {
  const T = M.NODE_TYPES['test-run'], R = M.MESSAGE_TYPES['test-result']
  check('registry: test-run is a settable context type (no longer reserved): bar = its items, items across its buckets (tree), show = tests, counts as a bar',
    T.kind === 'context' && T.settable && !T.reserved && T.bar === 'items' && T.items === 'tree' && T.show === 'tests' && T.counts_as === 'bar' && T.plan_end && T.children === null && Object.isFrozen(T))
  check('registry: a test-run\'s plan also ends on a FAILED line (ends: done | failed | abandoned); the other types end on done | abandoned',
    J(T.ends) === J(['done', 'failed', 'abandoned']) && J(M.NODE_TYPES.context.ends) === J(['done', 'abandoned']) && J(M.NODE_TYPES.plan.ends) === J(['done', 'abandoned']))
  check('registry: every other type keeps its items among its children (items: children)', Object.entries(M.NODE_TYPES).every(([k, x]) => k === 'test-run' ? x.items === 'tree' : x.items === 'children'))
  check('registry: no reserved node or message type is left', Object.values(M.NODE_TYPES).every(x => !x.reserved) && Object.values(M.MESSAGE_TYPES).every(x => !x.reserved))
  check('registry: test-result is settable and KEPT on the node as `test`; result (pass | fail | skip, required), checks, failed (≤ checks), duration',
    R.settable && R.keep === 'test' && J(Object.keys(R.fields)) === J(['result', 'checks', 'failed', 'duration']) && R.fields.result.required && J(R.fields.result.values) === J(['pass', 'fail', 'skip']) && R.fields.failed.at_most === 'checks')
  check('parseContextType: test-run (any case) is accepted; the bad-type list now names it', M.parseContextType('TEST-RUN').type === 'test-run' && /test-run/.test(M.parseContextType('nope').what))
  check('a type change to test-run is possible (setType2 takes the settable types); the dashboard offers only Show as group / plan', (() => {
    const w = world(); w.call({ key: 'c', label: 'C' })
    const r = M.setType2(w.st, BRIDGET, w.get('c').id, 'test-run', w.tick(1), { by: DASH })
    return r.ok && w.get('c').type === 'test-run' && r.records[0].type === 'test-run'
  })())
})

// ================================================================= test-result: typed fields, validated (§1.7)
await section(() => {
  const v = (f) => M.validateEntryFields('test-result', f)
  const good = v({ result: 'PASS', checks: '22', failed: 0, duration: '4.1s' })
  check('good: result pass (case-insensitive), checks "22" → 22, failed 0, duration "4.1s" → 4100 ms', good.ok && J(good.fields) === J({ result: 'pass', checks: 22, failed: 0, duration: 4100 }), J(good))
  check('duration forms: "250ms" → 250, "2m" → 120000, "1h25m" → 5100000, "1m 30s" → 90000, a NUMBER is ms (4100 → 4100), 0 is fine',
    v({ result: 'pass', duration: '250ms' }).fields.duration === 250 && v({ result: 'pass', duration: '2m' }).fields.duration === 120000 && v({ result: 'pass', duration: '1h25m' }).fields.duration === 5100000
    && v({ result: 'pass', duration: '1m 30s' }).fields.duration === 90000 && v({ result: 'pass', duration: 4100 }).fields.duration === 4100 && v({ result: 'pass', duration: 0 }).fields.duration === 0)
  check('a kept value validates to ITSELF (a number duration is ms — re-validating a stored entry changes nothing)', (() => { const a = v({ result: 'fail', checks: 3, failed: 1, duration: '4.1s' }).fields; const b = v(a); return b.ok && J(a) === J(b.fields) })())
  check('bad duration: a bare-number STRING (no unit: "4100"), a negative number, nonsense', ['4100', '4.1', -1, 'soon', '4.1 parsecs'].every(d => v({ result: 'pass', duration: d }).code === 'bad-fields'))
  check('bad enum: result maybe → bad-fields naming pass|fail|skip', (r => r.code === 'bad-fields' && /pass\|fail\|skip/.test(r.what))(v({ result: 'maybe' })))
  check('bad count: a negative checks, a fractional one, a non-number', v({ result: 'pass', checks: -1 }).code === 'bad-fields' && v({ result: 'pass', checks: 2.5 }).code === 'bad-fields' && v({ result: 'pass', checks: 'many' }).code === 'bad-fields' && v({ result: 'pass', failed: -2 }).code === 'bad-fields')
  check('failed can\'t be more than checks (when both are given)', (r => r.code === 'bad-fields' && /failed \(5\) can't be more than checks \(3\)/.test(r.what))(v({ result: 'fail', checks: 3, failed: 5 })) && v({ result: 'fail', failed: 5 }).ok)
  check('result is REQUIRED: fields without it, or none at all → bad-fields "a test-result entry needs result (pass|fail|skip)"',
    (r => r.code === 'bad-fields' && /needs result \(pass\|fail\|skip\)/.test(r.what))(v({ checks: 3 })) && v(null).code === 'bad-fields' && v({ result: null }).code === 'bad-fields')
  check('an unknown field → bad-fields (extras go in data)', (r => r.code === 'bad-fields' && /no field "name"/.test(r.what) && /data/.test(r.what))(v({ result: 'pass', name: 'x' })))
  check('a note still takes no fields, and needs none', M.validateEntryFields('note', null).ok && M.validateEntryFields('note', { a: 1 }).code === 'bad-fields')
})

// ================================================================= test-result on a report: the entry, and the node KEEPS it
await section(() => {
  const w = world()
  w.call({ key: 'box', label: 'Box', plan: [{ key: 't1', label: 'test_mesh' }] })
  const r = w.call({ key: 't1', state: 'done', text: '@22 passed', message_type: 'Test-Result', fields: { result: 'pass', checks: '22', duration: '4.1s' } })
  const e = r.entries && r.entries[0]
  check('the entry is a test-result entry with its fields normalised (checks 22, duration 4100 ms)', r.ok && e.type === 'test-result' && J(e.fields) === J({ result: 'pass', checks: 22, duration: 4100 }) && e.current && e.state === 'done', J(e))
  const n = w.get('t1')
  check('the node KEEPS it as `test` { result, checks, duration, ts, entry, state } — the state the report left it in', n.test && n.test.result === 'pass' && n.test.checks === 22 && n.test.duration === 4100 && n.test.entry === e.id && n.test.state === 'done' && n.test.ts === e.ts)
  check('…and the result names it (node.test)', r.node.test && r.node.test.result === 'pass')
  check('Q57 / Q62 (Robin: "state is progress, result is outcome"): a test-result means the test FINISHED — it sets the state to DONE, also for a fail (the line keeps its text; the outcome is the result)',
    (() => { w.call({ key: 'n1', label: 'N1' }); const x = w.call({ key: 'n1', text: 'ran', message_type: 'test-result', fields: { result: 'fail' } }); return x.ok && x.current && w.get('n1').current.state === 'done' && w.get('n1').current.text === 'N1' && M.testOutcome2(w.get('n1')) === 'fail' })())
  check('Q61 (C): any context that takes a test-result is a test — pass and skip set done too, a skip works on a plan item AND on an ordinary context (no not-a-plan-item)', (() => {
    w.call({ key: 'n2', label: 'N2' }); const a = w.call({ key: 'n2', text: 'ran', message_type: 'test-result', fields: { result: 'pass' } })
    w.call({ key: 'box2', label: 'Box2', plan: [{ key: 'n3', label: 'N3' }] }); const b = w.call({ key: 'n3', text: 'skipped', message_type: 'test-result', fields: { result: 'skip' } })
    w.call({ key: 'n4', label: 'N4' }); const c = w.call({ key: 'n4', text: 'x', message_type: 'test-result', fields: { result: 'skip' } })
    return a.ok && w.get('n2').current.state === 'done' && M.testOutcome2(w.get('n2')) === 'pass' && b.ok && w.get('n3').current.state === 'done' && M.testOutcome2(w.get('n3')) === 'skip'
      && c.ok && w.get('n4').current.state === 'done' && M.testOutcome2(w.get('n4')) === 'skip'
  })())
  check('Q61: an AGENT (or the session) can\'t take a test-result — it runs tests, it isn\'t one (not-a-test)', (() => {
    const a = w.call({ agent: 'runner', label: 'Runner', text: 'x', message_type: 'test-result', fields: { result: 'pass' } })
    w.call({ agent: 'runner', label: 'Runner', text: '@up' })
    const b = w.call({ agent: 'runner', text: 'x', message_type: 'test-result', fields: { result: 'pass' } }), c = w.call({ text: 'x', message_type: 'test-result', fields: { result: 'pass' } })
    return a.code === 'not-a-test' && b.code === 'not-a-test' && /runs tests, it isn't one/.test(b.what) && c.code === 'not-a-test'
  })())
  const lf = w.call({ key: 't1', message_type: 'test-result', fields: { result: 'fail', checks: 22, failed: 2 }, state: 'done', log: false })
  check('Q62: --state done with a result is consistent; log:false: no entry, the node still keeps the result (entry null; the checkpoint carries it, step 3)', lf.ok && !lf.entries.length && w.get('t1').test.result === 'fail' && w.get('t1').test.entry === null && w.get('t1').cp_dirty && w.get('t1').current.state === 'done')
  check('Q62: a result with an unfinished (or another) state is REFUSED — running / todo / blocked / abandoned / failed / skipped: "a test-result means the test finished"',
    ['running', 'todo', 'blocked', 'abandoned', 'failed', 'skipped'].every(s => { const r = w.call({ key: 't1', state: s, message_type: 'test-result', fields: { result: 'pass' } }); return r.code === 'bad-state' && /means the test finished: its state is done/.test(r.what) })
    && w.get('t1').test.result === 'fail' && w.get('t1').current.state === 'done')
  w.call({ key: 't1', state: 'skipped' })
  check('the LATEST word wins: a later state change (no test-result) — the outcome follows the state (skipped → skip), the checks stay', (() => { const t = w.get('t1'); return M.testOutcome2(t) === 'skip' && t.test && t.test.result === 'fail' })())
  w.call({ key: 't1', text: '@still skipped' })
  check('…a line change that keeps the state changes nothing', M.testOutcome2(w.get('t1')) === 'skip')
  w.call({ key: 't1', state: 'running', text: '@again' })
  check('a RESTART (state todo / running / blocked, no test-result) clears the kept result: a new run of that test', w.get('t1').test === null && M.testOutcome2(w.get('t1')) === 'running' && !('test' in M.nodeView(w.sess(), w.get('t1'))))
  const s0 = J([...w.sess().nodes.values()].map(x => [x.id, x.test]))
  check('a refused call keeps nothing (all-or-nothing): a bad field, or a test-result with ask', w.call({ key: 't1', text: 'x', message_type: 'test-result', fields: { result: 'meh' } }).code === 'bad-fields'
    && w.call({ key: 't1', ask: 'Ok?', message_type: 'test-result', fields: { result: 'pass' } }).code === 'bad-ask' && J([...w.sess().nodes.values()].map(x => [x.id, x.test])) === s0)
  check('a test-result ALONE is a report (Q62: the test finished — done, the line keeps its text); other typed fields alone still need a report (bad-input)',
    (r => r.ok && r.current && w.get('t1').current.state === 'done' && w.get('t1').test.result === 'pass')(w.call({ key: 't1', message_type: 'test-result', fields: { result: 'pass' } }))
    && w.call({ key: 't1', details: 'x' }).code === 'bad-input')
  check('a question takes no test-result (bad-field: message_type)', (() => { w.call({ key: 'q', label: 'Q', ask: 'Ship it?', choices: ['Yes', 'No'] }); return w.call({ key: 'q', text: 'x', message_type: 'test-result', fields: { result: 'pass' } }).code === 'bad-field' })())
  check('testOutcome2 by state alone: done → pass, failed → fail, skipped / abandoned → skip, running / blocked → running, todo / idle → pending',
    J(['done', 'failed', 'skipped', 'abandoned', 'running', 'blocked', 'todo', 'idle'].map(s => M.testOutcome2({ current: { state: s } }))) === J(['pass', 'fail', 'skip', 'skip', 'running', 'running', 'pending', 'pending']))
})

// ================================================================= a test-run across its buckets (§3.8's example, typed)
await section(() => {
  const w = world()
  w.call({ key: 'rel', label: 'Release', plan: ['Ship'] })
  const tr = w.call({ key: 'tests', label: 'Tests', under: 'rel', context_type: 'test-run', text: '@test run started', state: 'running' })
  check('--context-type=test-run on create: type on the node and on the create record', tr.ok && w.get('tests').type === 'test-run' && tr.records.find(x => x.op === 'create').type === 'test-run')
  const pd = w.call({ key: 'pending', label: 'Pending', under: 'tests', transient: true, plan: [{ key: 't1', label: 'test_a' }, { key: 't2', label: 'test_b' }, { key: 't3', label: 'test_c' }, { key: 't4', label: 'test_d' }] })
  check('the reporter\'s Pending bucket holds one plan item per test', pd.ok && J(w.kids('Release/Tests/Pending')) === J(['test_a', 'test_b', 'test_c', 'test_d']))
  const b0 = w.bar('tests'), c0 = w.counts('tests')
  check('the run\'s bar is its ITEMS across its buckets: 0 of 4', b0 && b0.items && b0.total === 4 && b0.done === 0, J(b0))
  check('its counts: 0 passed · 0 failed · 4 to go of 4', c0 && c0.tests === 4 && c0.pending === 4 && c0.text === '0 passed · 0 failed · 4 to go of 4', J(c0))
  const st = w.call({ key: 't1', state: 'running', text: '@running', move_to: '../In progress' })
  check('a test starts: --move-to "../In progress" creates the bucket (transient) beside Pending', st.ok && J(w.kids('Release/Tests')) === J(['Pending', 'In progress']) && w.byPath('Release/Tests/In progress').transient)
  check('…counts: 1 running', w.counts('tests').running === 1 && w.counts('tests').text === '0 passed · 0 failed · 4 to go of 4')
  const ok1 = w.call({ key: 't1', state: 'done', text: '@22 passed', message_type: 'test-result', fields: { result: 'pass', checks: 22, failed: 0, duration: '4.1s' }, move_to: '../Passed' })
  check('a pass: ONE call reports, records the result and moves it to Passed; In progress vanished (emptied)', ok1.ok && J(w.kids('Release/Tests')) === J(['Pending', 'Passed']) && ok1.entries.some(e => e.type === 'test-result'), J(w.kids('Release/Tests')))
  w.call({ key: 't2', state: 'running', move_to: '../In progress' })
  const f2 = w.call({ key: 't2', state: 'done', text: '@FAILED: 3 passed, 2 failed', details: 'FAIL x\nFAIL y', message_type: 'test-result', fields: { result: 'fail', checks: 5, failed: 2, duration: 1500 }, move_to: '../Failed' })
  w.call({ key: 't3', message_type: 'test-result', fields: { result: 'skip' }, move_to: '../Skipped' })
  check('a fail goes to Failed, a skip to Skipped; Pending still holds the last one', f2.ok && J(w.kids('Release/Tests')) === J(['Pending', 'Passed', 'Failed', 'Skipped']) && J(w.kids('Release/Tests/Pending')) === J(['test_d']))
  const b1 = w.bar('tests'), c1 = w.counts('tests')
  check('the run\'s ITEMS bar across the buckets (what it adds to its parent): 3 of 4 done — a finished test is DONE whatever its result (Q62: state is progress); pass / fail / skip is in its counts and testBar2',
    b1.done === 3 && b1.skipped === 0 && b1.total === 4 && ['t1', 't2', 't3'].every(k => w.get(k).current.state === 'done'), J(b1))
  check('its counts: 1 passed · 1 failed · 1 skipped · 1 to go of 4 · 27 checks (2 failed); duration 5600 ms', c1.passed === 1 && c1.failed === 1 && c1.skipped === 1 && c1.pending === 1 && c1.checks === 27 && c1.failed_checks === 2 && c1.duration_ms === 5600
    && c1.text === '1 passed · 1 failed · 1 skipped · 1 to go of 4 · 27 checks (2 failed)', J(c1))
  check('each bucket rolls up its own items (Passed 1 of 1, Failed 1 of 1 — its failed test is done)', (s => M.bar2(s, w.byPath('Release/Tests/Passed')).done === 1 && M.bar2(s, w.byPath('Release/Tests/Failed')).done === 1)(w.sess()))
  check('side effect (Q62): the FAILED bucket\'s own plan ENDS (all its items done) — yet it is not evicted / expired alone (a bucket goes with its run)',
    (s => M.planEndHow2(s, w.byPath('Release/Tests/Failed')) === 'all-done')(w.sess()))
  const d = M.displayOf2(w.sess(), w.get('tests'))
  check('displayOf2 (Q56 CHANGED): a test-run shows its glyph and ONE bar of its tests — passed (green) vs failed (red) vs total — the counts in its tooltip; no items bar beside it',
    d.show === 'tests' && d.glyph === '⚑' && !('bar' in d) && d.tests.passed === 1 && d.tests.failed === 1 && d.tests.total === 4 && d.tests.pct_passed === 25 && d.tests.pct_failed === 25
    && d.tests.tooltip === '1 passed · 1 failed · 1 skipped · 1 to go of 4 · 27 checks (2 failed)' && d.tests.counts.checks === 27, J(d))
  check('testBar2: null while a node holds no test', (() => { w.call({ key: 'empty', label: 'Empty', text: 'x' }); return M.testBar2(w.sess(), w.get('empty')) === null })())
  check('the run adds its BAR to its parent\'s rollup (Release holds plan items: it rolls up only those — ROLLUP; a plain parent sums it)', (() => {
    const r = w.bar('rel'); w.call({ key: 'box', label: 'Box' }); w.call({ key: 'tests', move: 'box' }); const b = w.bar('box'); w.call({ key: 'tests', move: 'rel' })
    return r.total === 1 && b && b.total === 4 && b.done === 3
  })())
  w.call({ key: 't4', state: 'done', message_type: 'test-result', fields: { result: 'pass', checks: 3 }, move_to: '../Passed' })
  check('Pending vanished once it emptied; Passed / Failed / Skipped stay', J(w.kids('Release/Tests')) === J(['Passed', 'Failed', 'Skipped']) && w.sess().ghosts.has(pd.node.id))
  const p = M.planOf2(w.sess(), w.get('tests'))
  check('the run\'s PLAN is its items across the buckets (4); every test FINISHED (a failed one too) → it ended, all done', p && p.total === 4 && p.done === 4 && M.planEndHow2(w.sess(), w.get('tests')) === 'all-done')
  const end = w.call({ key: 'tests', state: 'failed', text: '@TESTS FAILED: 2 passed, 1 failed, 1 skipped' })
  check('the run\'s own line can still say failed (non-test work keeps the failed state)', end.ok && w.get('tests').current.state === 'failed')
  check('a FAILED line on a run whose tests are not all finished ENDS its plan (planEndHow2 failed) — the run is over', (() => {
    w.call({ key: 'r2', label: 'Run 2', context_type: 'test-run', state: 'running', plan: [{ key: 'u1', label: 'u_1' }, { key: 'u2', label: 'u_2' }] })
    w.call({ key: 'u1', message_type: 'test-result', fields: { result: 'fail' }, text: 'x' })
    const before = M.planEndAt2(w.sess(), w.get('r2'))
    w.call({ key: 'r2', state: 'failed', text: '@aborted' })
    return before === null && M.planEndHow2(w.sess(), w.get('r2')) === 'failed'
  })())
  check('…a plain context\'s failed line does not end its plan (ends: done | abandoned)', (() => { w.call({ key: 'pc', label: 'PC', plan: ['x'] }); w.call({ key: 'pc', state: 'failed', text: '@no' }); return M.planEndAt2(w.sess(), w.get('pc')) === null })())
  // what a run does NOT walk into
  w.call({ agent: 'helper', label: 'Helper', under: 'tests' })
  w.call({ agent: 'helper', key: 'h1', label: 'H1', plan: ['hx'] })
  w.call({ key: 'parked', label: 'Parked', under: 'tests', context_type: 'group' })
  w.call({ key: 'g1', label: 'G1', under: 'parked', state: 'todo' })
  w.call({ key: 'g1', message_type: 'test-result', fields: { result: 'pass' }, text: 'x' })
  check('an agent\'s work and a GROUP\'s items are not the run\'s (its bar and counts stay 4 tests)', w.bar('tests').total === 4 && w.counts('tests').tests === 4 && M.runItems2(w.sess(), w.get('tests')).length === 4)
  // a test that is not a plan item: a context with a result
  w.call({ key: 'adhoc', label: 'Ad hoc', under: 'Release/Tests/Passed', text: 'ran', message_type: 'test-result', fields: { result: 'pass', checks: 1 } })
  check('a context in a bucket with a test-result counts as a test too (not in the bar: it is not a plan item)', w.counts('tests').tests === 5 && w.counts('tests').passed === 3 && w.bar('tests').total === 4)
  check('a NESTED test-run is walked through (a suite of suites): its tests count in the outer run', (() => {
    w.call({ key: 'sub', label: 'Sub run', under: 'tests', context_type: 'test-run' })
    w.call({ key: 'sub', plan: [{ key: 's1', label: 'sub_1' }] })
    w.call({ key: 's1', state: 'done', message_type: 'test-result', fields: { result: 'pass', checks: 4 } })
    return w.bar('tests').total === 5 && w.counts('tests').tests === 6 && w.counts('sub').tests === 1 && w.counts('sub').passed === 1
  })())
  check('testCounts2 is null for a node with no tests', (w.call({ key: 'empty', label: 'Empty' }), w.counts('empty') === null))
})

// ================================================================= a second run: the same buckets, the results reset
await section(() => {
  const w = world()
  w.call({ key: 'tests', label: 'Tests', context_type: 'test-run', state: 'running', text: '@run 1' })
  w.call({ key: 'pending', label: 'Pending', under: 'tests', transient: true, plan: [{ key: 'a', label: 'test_a' }, { key: 'b', label: 'test_b' }] })
  const pendingId = w.get('pending').id
  w.call({ key: 'a', state: 'done', message_type: 'test-result', fields: { result: 'pass', checks: 2 }, move_to: '../Passed' })
  w.call({ key: 'b', state: 'done', message_type: 'test-result', fields: { result: 'fail', checks: 2, failed: 1 }, move_to: '../Failed' })
  w.call({ key: 'tests', state: 'failed', text: '@run 1 failed' })
  const passedId = w.byPath('Tests/Passed').id
  check('run 1 ends: Passed + Failed, 1 passed · 1 failed', J(w.kids('Tests')) === J(['Passed', 'Failed']) && w.counts('tests').text === '1 passed · 1 failed of 2 · 4 checks (1 failed)', w.counts('tests').text)
  // run 2: the reporter moves every test back to Pending (an existing item can't be re-planned elsewhere: exists-elsewhere)
  const re = w.call({ key: 'pending', label: 'Pending', under: 'tests', transient: true, plan: [{ key: 'a', label: 'test_a' }, { key: 'b', label: 'test_b' }, { key: 'c', label: 'test_c' }] })
  check('run 2: Pending comes back with the SAME id (a new run of it); the old tests answer exists-elsewhere, a new one is created', re.ok && w.get('pending').id === pendingId && w.get('pending').runs === 2
    && J(re.plan.map(i => i.warning || (i.created ? 'created' : 'kept'))) === J(['exists-elsewhere', 'exists-elsewhere', 'created']))
  w.call({ key: 'tests', state: 'running', text: '@run 2' })
  for (const k of ['a', 'b']) w.call({ key: k, state: 'todo', move_to: '../Pending', log: false })
  check('…so they move back with --state todo --move-to "../Pending": the old buckets empty and vanish', J(w.kids('Tests')) === J(['Pending']) && J(w.kids('Tests/Pending')) === J(['test_c', 'test_a', 'test_b']), J(w.kids('Tests/Pending')))
  check('…their kept results were dropped (a restart): 0 passed · 0 failed · 3 to go, no checks', w.get('a').test === null && w.get('b').test === null && w.counts('tests').text === '0 passed · 0 failed · 3 to go of 3', w.counts('tests').text)
  check('the run\'s plan is open again (its line is running, items todo)', M.planEndAt2(w.sess(), w.get('tests')) === null)
  w.call({ key: 'a', state: 'done', message_type: 'test-result', fields: { result: 'pass' }, move_to: '../Passed' })
  check('a bucket comes back with its id (the ghost resurrected, §3.8)', w.byPath('Tests/Passed').id === passedId)
})

// ================================================================= the context-aware menu (#92 folded into the registry)
await section(() => {
  const w = world()
  check('every menu entry names an applyAction2 action, has a label and a group; every `when` is known (menuOf2 never throws)',
    Object.values(M.NODE_TYPES).every(T => T.menu.length && T.menu.every(m => M.ACTIONS2.includes(m.action) && m.label && m.group)) && Object.isFrozen(M.NODE_TYPES.context.menu) && Object.isFrozen(M.NODE_TYPES.context.menu[0]))
  w.call({ key: 'rel', label: 'Release', plan: ['A', 'B'] })
  check('a plan item (todo): Mark done, Skip, Abandon; Show as group / plan; Merge; Move, Rename, Edit text, Message — not Reopen (already to do)',
    J(w.menu('A', { now: w.at() })) === J(['done', 'skip', 'abandon', 'show_as_plan', 'merge', 'move', 'rename', 'edit_text', 'message']), J(w.menu('A')))
  w.call({ key: 'a', state: 'done' })
  check('…once done: Skip, Reopen, Abandon (no Mark done)', J(w.menu('a').slice(0, 3)) === J(['skip', 'reopen', 'abandon']))
  check('a plan node (open): Complete / Abandon the plan; Show as group (it is no plan item); not Reopen the plan', (m => m.includes('complete') && m.includes('abandon_plan') && !m.includes('reopen_plan') && m.includes('show_as_group') && !m.includes('done'))(w.menu('rel')))
  w.call({ key: 'rel', state: 'done', text: '@shipped' })
  check('…ended by its line (not every item done): Reopen the plan; no Complete', (m => m.includes('reopen_plan') && !m.includes('complete') && !m.includes('abandon_plan'))(w.menu('rel')))
  check('the labels say what they do ("Complete the plan", "Move to…")', (() => { const m = M.menuOf2(w.sess(), w.get('b'), { now: w.at() }); return m.find(x => x.action === 'move').label === 'Move to…' && m[0].label === 'Mark done' })())
  w.call({ key: 'g', label: 'G', context_type: 'group' })
  check('a group: Abandon, Show as plan, Merge, Move, Rename, Edit text, Message (no plan actions, no Show as group)', J(w.menu('g')) === J(['abandon', 'show_as_plan', 'merge', 'move', 'rename', 'edit_text', 'message']), J(w.menu('g')))
  w.call({ key: 'tr', label: 'Run', context_type: 'test-run', plan: ['t'] })
  check('a test-run (open): Complete the run / Abandon the run, Merge, Move, Rename, Edit text, Message; no Show as …',
    (m => J(m) === J(['abandon', 'complete', 'abandon_plan', 'merge', 'move', 'rename', 'edit_text', 'message']))(w.menu('tr')) && M.menuOf2(w.sess(), w.get('tr'), { now: w.at() }).find(x => x.action === 'complete').label === 'Complete the run', J(w.menu('tr')))
  w.call({ key: 'q', label: 'Q', ask: 'Ship it?', choices: ['Yes', 'No'] })
  check('an OPEN question: Answer…, Withdraw, Move, Message', J(w.menu('q')) === J(['answer', 'withdraw', 'move', 'message']), J(w.menu('q')))
  M.answerQuestion2(w.st, BRIDGET, w.get('q').id, { choice: 'Yes' }, w.tick(1), { by: DASH })
  check('an ANSWERED question: Change answer…, Move, Message', J(w.menu('q')) === J(['change_answer', 'move', 'message']), J(w.menu('q')))
  w.call({ agent: 'lead', label: 'Lead', text: '@working', state: 'running' })
  check('a running agent: Move, Rename, Edit text, Message — no Finish / Dismiss (it is not quiet)', J(w.menu('lead')) === J(['move', 'rename', 'edit_text', 'message']), J(w.menu('lead')))
  w.tick(60 * MIN)
  check('…once stale (by the viewer\'s slider): Mark finished…, Dismiss', (m => m.includes('finish') && m.includes('dismiss'))(w.menu('lead', { staleMin: 15 })))
  check('…and each offered action is accepted by applyAction2 (finish)', (r => r.ok)(w.act(w.get('lead').id, 'finish', { state: 'done', stale_min: 15 })))
  check('the session root: no Move / Rename (it can\'t move); Edit text and Message', (m => !m.includes('move') && !m.includes('rename') && m.includes('edit_text') && m.includes('message'))(M.menuOf2(w.sess(), M.rootOf(w.sess()), { now: w.at() }).map(x => x.action)))
  check('an agent holding an open plan: Complete its plan / Abandon its plan', (() => { w.call({ agent: 'lead2', label: 'Lead 2', plan: ['p1'] }); const m = M.menuOf2(w.sess(), w.get('lead2'), { now: w.at() }); return m.some(x => x.action === 'complete' && x.label === 'Complete its plan') && m.some(x => x.action === 'abandon_plan') })())
  check('menuOf2 of nothing is empty', J(M.menuOf2(w.sess(), null)) === '[]')
})

// ================================================================= an ended test-run is evicted WHOLE (planRemoval2)
await section(() => {
  const w = world({ limits: { nodesPerSession: 9 } })
  w.call({ key: 'tests', label: 'Tests', context_type: 'test-run', state: 'running', text: '@run' })
  w.call({ key: 'pending', label: 'Pending', under: 'tests', transient: true, plan: [{ key: 'a', label: 'test_a' }, { key: 'b', label: 'test_b' }] })
  w.call({ key: 'a', state: 'done', move_to: '../Passed' })
  w.call({ key: 'b', state: 'done', move_to: '../Passed' })
  check('setup: the run holds Passed with both tests, its plan ENDED (every item done)', J(w.kids('Tests')) === J(['Passed']) && M.planEndAt2(w.sess(), w.get('tests')) != null)
  w.call({ key: 'tests', state: 'done', text: '@tests passed' })
  const r = w.call({ key: 'n', label: 'New', plan: ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'] })
  check('a call past the node limit evicts the ENDED run whole (the run + its bucket + its items), not its bucket alone', r.ok && r.evicted && r.evicted.length === 1 && r.evicted[0].label === 'Tests' && !w.get('tests') && !w.byPath('Tests'), J(r.evicted || r))
  const w2 = world({ limits: { nodesPerSession: 9 } })
  w2.call({ key: 'tests', label: 'Tests', context_type: 'test-run', state: 'running', text: '@run' })
  w2.call({ key: 'pending', label: 'Pending', under: 'tests', transient: true, plan: [{ key: 'a', label: 'test_a' }, { key: 'b', label: 'test_b' }] })
  w2.call({ key: 'a', state: 'done', move_to: '../Passed' }); w2.call({ key: 'b', state: 'done', move_to: '../Passed' })
  const r2 = w2.call({ key: 'n', label: 'New', plan: ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'] })
  check('…a run whose own line is still LIVE stays (6b): only its items go, and its emptied transient bucket vanishes', r2.ok && J(r2.evicted.map(e => e.label)) === J(['test_a', 'test_b']) && w2.get('tests') && J(w2.kids('Tests')) === J([]), J(r2.evicted || r2))
})

// ================================================================= #81's dashboard test reporter, mapped onto the 2.0 model
// tests/reporters/aimb-dashboard.mjs (1.7x) sends, over one aimb-log --stream: the run node's plan (one ☐ item per script),
// "queued" / "running" / done / failed lines per script with log:false, a log:false progress tick on the run, a logged
// entry per failing script (FAIL lines in details) and a final logged summary. At the 2.0 cutover it becomes the calls
// below (spec §3.8 + §1.7): a test-run node, a transient Pending bucket holding the scripts as plan items, one report-and-
// move per script event, a test-result entry per finished script. The bar and the pass / fail counts come from the model.
await section(() => {
  const w = world()
  const RUN = { key: 'tests', label: 'Tests' }
  // the 2.0 reporter: event → the call it sends (what aimb-log --stream items would carry)
  const reporter = {
    start: names => [
      { ...RUN, context_type: 'test-run', state: 'running', text: `@test run started: ${names.length} test scripts` },
      { key: 'pending', label: 'Pending', under: RUN.key, transient: true, plan: names.map(n => ({ key: n, label: n })) },
    ],
    // a script already on the board (an earlier run) answered exists-elsewhere: it moves back to Pending
    requeue: name => ({ key: name, state: 'todo', move_to: '../Pending', log: false }),
    onStart: (name, group) => ({ key: name, state: 'running', text: `@running · ${group}`, move_to: '../In progress', log: false }),
    onEnd: (name, r) => r.ok
      ? { key: name, state: 'done', text: `@${r.pass} passed, ${r.fail} failed · ${r.ms / 1000}s`, message_type: 'test-result', fields: { result: 'pass', checks: r.pass + r.fail, failed: r.fail, duration: r.ms }, move_to: '../Passed' }
      : { key: name, state: 'done', text: `@FAILED: ${r.pass} passed, ${r.fail} failed`, details: r.fails.join('\n'), message_type: 'test-result', fields: { result: 'fail', checks: r.pass + r.fail, failed: r.fail, duration: r.ms }, move_to: '../Failed' },
    tick: text => ({ key: RUN.key, text: `@${text}`, log: false }),   // the bar and counts come from the run's items now: no progress needed
    final: (ok, summary, details) => ({ key: RUN.key, state: ok ? 'done' : 'failed', text: `@${ok ? 'tests passed' : 'TESTS FAILED'}: ${summary}`, ...(details ? { details } : {}) }),
  }
  const send = x => { const r = w.call(x); if (!r.ok) throw new Error(`${J(x)} → ${r.code}: ${r.what}`); return r }
  // ---- run 1: three scripts — unit passes, mesh fails, dashboard passes; unit and mesh run in parallel
  const names = ['test_unit', 'test_mesh', 'test_dash']
  const st = reporter.start(names).map(send)
  check('start: the run node is a test-run (its line "test run started: 3 test scripts"); Pending holds 3 ☐ scripts', w.get('tests').type === 'test-run' && w.get('tests').current.text === 'test run started: 3 test scripts' && J(w.kids('Tests/Pending')) === J(names) && st[1].plan.every(i => i.created))
  send(reporter.onStart('test_unit', 'unit')); send(reporter.onStart('test_mesh', 'mesh'))
  check('two scripts running in parallel sit in In progress', J(w.kids('Tests/In progress')) === J(['test_unit', 'test_mesh']) && w.counts('tests').running === 2)
  send(reporter.tick('checks 40 · file 0/3 · test_unit, test_mesh'))
  check('a tick sets only the run\'s line (log:false: no entry, the counts unchanged)', w.get('tests').current.text === 'checks 40 · file 0/3 · test_unit, test_mesh' && w.counts('tests').running === 2)
  send(reporter.onEnd('test_unit', { ok: true, pass: 700, fail: 0, ms: 4100 }))
  const fr = send(reporter.onEnd('test_mesh', { ok: false, pass: 30, fail: 2, ms: 9000, fails: ['FAIL relay drops', 'FAIL heal'] }))
  check('In progress vanished when its last script left; Passed / Failed hold the finished ones', J(w.kids('Tests')) === J(['Pending', 'Passed', 'Failed']))
  const failEntry = fr.entries.find(e => e.type === 'test-result')
  check('the failing script\'s entry is a test-result with its FAIL lines in details (the 1.7x logged entry); then its move entry (an event)',
    failEntry && failEntry.fields.result === 'fail' && failEntry.fields.failed === 2 && failEntry.fields.duration === 9000 && failEntry.details === 'FAIL relay drops\nFAIL heal' && fr.entries.at(-1).type === 'event' && J(ops(fr)).includes('"move"'), J(fr.entries))
  send(reporter.onStart('test_dash', 'dashboard'))
  send(reporter.onEnd('test_dash', { ok: true, pass: 50, fail: 0, ms: 2000 }))
  check('Pending and In progress are gone; the run reads 2 passed · 1 failed of 3 · 782 checks (2 failed)', J(w.kids('Tests')) === J(['Passed', 'Failed']) && w.counts('tests').text === '2 passed · 1 failed of 3 · 782 checks (2 failed)', w.counts('tests').text)
  check('the run\'s items bar: 3 of 3 (every script finished — the failed one too, Q62); its tests bar: 2 passed, 1 failed', (b => b.done === 3 && b.total === 3 && b.items)(w.bar('tests'))
    && (t => t.passed === 2 && t.failed === 1 && t.total === 3)(M.testBar2(w.sess(), w.get('tests'))))
  const fin = send(reporter.final(false, '2 passed, 1 failed (test_mesh) · 15s', 'test_mesh: 30 passed, 2 failed\nFAIL relay drops\nFAIL heal'))
  check('final: the run\'s plan ended when its last script finished (all done); the failed line says how the run went; its summary is a logged entry with the details',
    M.planEndHow2(w.sess(), w.get('tests')) === 'all-done' && w.get('tests').current.state === 'failed' && fin.entries[0].details.startsWith('test_mesh') && fin.entries[0].text.startsWith('TESTS FAILED'))
  // ---- run 2: the same scripts + a new one; the earlier ones are moved back to Pending
  const st2 = reporter.start([...names, 'test_new']).map(send)
  const again = st2[1].plan.filter(i => i.warning === 'exists-elsewhere').map(i => i.key)
  check('run 2 start: the known scripts answer exists-elsewhere (they sit in Passed / Failed); the new one is created in Pending', J(again) === J(names) && st2[1].plan[3].created)
  again.forEach(n => send(reporter.requeue(n)))
  check('requeued: every script is in Pending again, ☐, its old result dropped — 0 passed · 0 failed · 4 to go of 4', J(w.kids('Tests')) === J(['Pending']) && names.every(n => w.get(n).current.state === 'todo' && w.get(n).test === null) && w.counts('tests').text === '0 passed · 0 failed · 4 to go of 4', w.counts('tests').text)
  check('the run is open again (its line running, its plan open)', w.get('tests').current.state === 'running' && M.planEndAt2(w.sess(), w.get('tests')) === null)
  for (const n of [...names, 'test_new']) { send(reporter.onStart(n, 'g')); send(reporter.onEnd(n, { ok: true, pass: 1, fail: 0, ms: 10 })) }
  send(reporter.final(true, '4 passed · 1s'))
  check('run 2 all green: only Passed remains, 4 passed · 0 failed of 4, the run done (its plan ended: all done)', J(w.kids('Tests')) === J(['Passed']) && w.counts('tests').text === '4 passed · 0 failed of 4 · 4 checks' && M.planEndHow2(w.sess(), w.get('tests')) === 'all-done', w.counts('tests').text)
  const ids = new Set([...w.sess().nodes.values()].map(n => n.id))
  check('every bucket kept ONE id across both runs (Passed resurrected, not re-made)', w.byPath('Tests/Passed') && ids.has(w.byPath('Tests/Passed').id) && w.byPath('Tests/Passed').runs >= 2)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
