// Fast UNIT tests for lib/activity.js — since #88 build step 11 the SHARED PRIMITIVES of the 2.0 board (the 1.7x model they
// were part of is deleted) — and for lib/activity-v5.js, the 1.7x (v5) readers the migration keeps. No bridge, no sockets, no
// clock: every time is an explicit `now`. Covered: the locked limits / states / defaults, resolveConfig, parseDuration,
// parseProgress (three-part, #79) and parseEta (called directly — they were reached through parseMessage), progressPct,
// renderText / fmtNum / fmtEta, localDay / entryTime, sessionKey / groupKey, normBy / byText, ranks (#82), the question
// constants, stampText / answerEntryText (#90), firstWords (#84), and the v5 path reader (every 1.7x form, keys, errors).
// The 2.0 model on these is tested by test_activity2*_unit, test_activity3 – 10_unit and test_activity_q72_unit.
//
// RETIRED in step 11 (the behaviour is deleted with the 1.7x model — each listed by the section it had here): parseMessage
// (context prefixes and the old notation, text, agent / state / input, progress / eta / stale_after / details / data AS
// MESSAGE FIELDS, default text, the log flag, MESSAGE_FIELDS, the v5 ACTIVITY_FORMAT here); apply (basics, the path tree,
// @ vs @~, details retention, activity + stale_after, the log cap, depth / agent / node limits and eviction, gone, the
// session identity of an applied report, persistence markers); the derived views (stale / gone, rollup, isActive / visible /
// expire); gossip v5 (snapshot, mergeSnapshot, planSlice / applySlice, the mesh board); the memory budget; read views,
// the subtree log, paging and the files descriptor; checkpoints + repeat lines; the replay (seeded replay == apply,
// instances, the window, phase 1, v1 records); the file facet's 1.7x daily JSONL (persistence.activity — deleted: the 2.0
// day files are lib/activity2-files.js, test_activity3 / 6_unit); the dashboard's raw board, units, deltas and bells;
// splitBatch; 6b todos / plans / carry-forward; 6c abandoned, the plan-end rule, auto-abandon, counts, the home host; 6d
// the plan-end marker and dashboard actions; #79 rollups and progress on the wire; #80 notices; #82 placing, move, cascade,
// dashboard move / reorder and their replay; #83 / #84 edit text and messages; #85 questions (parsing, the state machine,
// rollup, expiry, notices, the waiter's view, gossip, the replay); #90 change_answer, the answer entry, open questions
// never stale, and their replay. The `AIMB_TEST_ACTIVITY_LIB` hook (the pre-change proof against another copy of the
// 1.7x library) went with them.
import { testOnly } from '../helpers/check.mjs'
import * as A from '../../lib/activity.js'
import * as V5 from '../../lib/activity-v5.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.message} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
// each section runs on its own: a crash (e.g. a missing export) is ONE failure, the rest still run
async function section(fn) { try { await fn() } catch (e) { fail++; console.log('FAIL section crashed:', (e && e.message) || e) } }
const MIN = 60000, HOUR = 3600000
const T0 = Date.UTC(2026, 8, 30, 6, 0, 0)   // 2026-09-30 06:00 UTC (19:00 at +13:00)
const rep = (ch, n) => ch.repeat(n)
const BY = { kind: 'dashboard', user: 'robin', host: 'DASH-HOST' }
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }

// ================================================================= constants
check('limits: the locked #70 values (6a: depth 6, 128 agents, 4096 nodes, batch 64 / 64 KB)', A.ACTIVITY_LIMITS.text === 240 && A.ACTIVITY_LIMITS.context === 60 && A.ACTIVITY_LIMITS.depth === 6
  && A.ACTIVITY_LIMITS.agentsPerSession === 128 && A.ACTIVITY_LIMITS.nodesPerSession === 4096 && A.ACTIVITY_LIMITS.detailsBytes === 4096
  && A.ACTIVITY_LIMITS.dataBytes === 16384 && A.ACTIVITY_LIMITS.staleAfterMaxMs === 24 * HOUR && A.ACTIVITY_LIMITS.batchItems === 64 && A.ACTIVITY_LIMITS.batchBytes === 65536
  && !('contextsPerAgent' in A.ACTIVITY_LIMITS) && !('pathDepth' in A.ACTIVITY_LIMITS))
check('limits + defaults are frozen', Object.isFrozen(A.ACTIVITY_LIMITS) && Object.isFrozen(A.ACTIVITY_DEFAULTS) && Object.isFrozen(A.ACTIVITY_STATES))
check('defaults: the #70 per-host config (+ step 2 progress_checkpoint_sec; 6b: finished_visible_hours 168 = 7 days; 6c: abandoned_plan_days 90, finished_plan_open_min 120; #80: notice_batch_sec 3)', J(A.ACTIVITY_DEFAULTS) === J({ log_retention_days: 7, log_entries_per_agent: 200, stale_after_min: 15, finished_visible_hours: 168, memory_budget_mb: 64, progress_checkpoint_sec: 60, abandoned_plan_days: 90, finished_plan_open_min: 120, notice_batch_sec: 3, enabled: true }))
check('states: running|blocked|failed|done|idle + (6b) todo|skipped + (6c) abandoned', J(A.ACTIVITY_STATES) === J(['running', 'blocked', 'failed', 'done', 'idle', 'todo', 'skipped', 'abandoned']))
check('env names: AI_BRIDGE_ACTIVITY_<KEY>', A.ACTIVITY_ENV.stale_after_min === 'AI_BRIDGE_ACTIVITY_STALE_AFTER_MIN' && A.ACTIVITY_ENV.enabled === 'AI_BRIDGE_ACTIVITY_ENABLED' && A.ACTIVITY_ENV.progress_checkpoint_sec === 'AI_BRIDGE_ACTIVITY_PROGRESS_CHECKPOINT_SEC' && A.ACTIVITY_ENV.abandoned_plan_days === 'AI_BRIDGE_ACTIVITY_ABANDONED_PLAN_DAYS' && A.ACTIVITY_ENV.finished_plan_open_min === 'AI_BRIDGE_ACTIVITY_FINISHED_PLAN_OPEN_MIN' && A.ACTIVITY_ENV.notice_batch_sec === 'AI_BRIDGE_ACTIVITY_NOTICE_BATCH_SEC' && Object.keys(A.ACTIVITY_ENV).length === 10)
check('step 11: the 1.7x model is gone from lib/activity.js (no createActivity / parseMessage / apply / replay / gossip v5 / parsePath); the v5 readers are lib/activity-v5.js',
  ['createActivity', 'parseMessage', 'apply', 'applyAction', 'createReplay', 'snapshot', 'planSlice', 'applySlice', 'boardView', 'dashUnits', 'enforceBudget', 'parsePath', 'formatPath', 'pathKey', 'recordKind', 'MESSAGE_FIELDS', 'ACTIVITY_FORMAT'].every(k => A[k] === undefined)
  && typeof V5.parsePath === 'function' && typeof V5.recordKind === 'function' && V5.ACTIVITY_FORMAT === 5)

// ================================================================= resolveConfig
await section(async () => {
  const R = A.resolveConfig
  check('config: nothing given -> defaults (exact keys)', J(R(undefined, undefined)) === J(A.ACTIVITY_DEFAULTS) && J(R({}, {})) === J(A.ACTIVITY_DEFAULTS))
  check('config: result is frozen', Object.isFrozen(R({}, {})))
  check('config: block values used', (c => c.log_retention_days === 30 && c.stale_after_min === 5 && c.enabled === false)(R({ log_retention_days: 30, stale_after_min: 5, enabled: false }, {})))
  check('config: env beats the block', R({ stale_after_min: 5 }, { AI_BRIDGE_ACTIVITY_STALE_AFTER_MIN: '20' }).stale_after_min === 20)
  check('config: env numeric string parsed', R({}, { AI_BRIDGE_ACTIVITY_MEMORY_BUDGET_MB: ' 128 ' }).memory_budget_mb === 128)
  check('config: block numeric string parsed', R({ log_entries_per_agent: '300' }, {}).log_entries_per_agent === 300)
  check('config: empty env string = unset (block wins)', R({ stale_after_min: 5 }, { AI_BRIDGE_ACTIVITY_STALE_AFTER_MIN: '' }).stale_after_min === 5)
  {
    const w = []
    const c = R({ stale_after_min: 0, log_retention_days: 9999, memory_budget_mb: 1, log_entries_per_agent: 3, finished_visible_hours: -5 }, {}, w)
    check('config: out-of-range numbers clamp (low + high)', c.stale_after_min === 1 && c.log_retention_days === 365 && c.memory_budget_mb === 8 && c.log_entries_per_agent === 10 && c.finished_visible_hours === 0, J(c))
    check('config: each clamp is reported as a warning', w.length === 5 && w.every(s => /clamped/.test(s)), J(w))
  }
  check('config: non-integers round', R({ stale_after_min: 7.6 }, {}).stale_after_min === 8)
  {
    const w = []
    const c = R({ stale_after_min: 'soon', log_retention_days: NaN, memory_budget_mb: {}, enabled: 'maybe' }, {}, w)
    check('config: bad block values fall back to the defaults', c.stale_after_min === 15 && c.log_retention_days === 7 && c.memory_budget_mb === 64 && c.enabled === true, J(c))
    check('config: each ignored value is reported', w.length === 4 && w.every(s => /ignored/.test(s)), J(w))
  }
  check('config: a bad ENV value falls through to the block, not straight to the default',
    R({ stale_after_min: 5 }, { AI_BRIDGE_ACTIVITY_STALE_AFTER_MIN: 'abc' }).stale_after_min === 5 && R({}, { AI_BRIDGE_ACTIVITY_STALE_AFTER_MIN: 'abc' }).stale_after_min === 15)
  check('config: an out-of-range env value clamps (does not fall through)', R({ stale_after_min: 5 }, { AI_BRIDGE_ACTIVITY_STALE_AFTER_MIN: '99999' }).stale_after_min === 1440)
  check('config: enabled accepts true/false/1/0/yes/no/on/off',
    ['0', 'false', 'no', 'off', 'OFF'].every(v => R({}, { AI_BRIDGE_ACTIVITY_ENABLED: v }).enabled === false)
    && ['1', 'true', 'yes', 'on', 'True'].every(v => R({ enabled: false }, { AI_BRIDGE_ACTIVITY_ENABLED: v }).enabled === true)
    && R({ enabled: 0 }, {}).enabled === false && R({ enabled: 'off' }, {}).enabled === false)
  check('config: a non-object block is treated as {}', J(R('junk', {})) === J(A.ACTIVITY_DEFAULTS) && J(R([1, 2], {})) === J(A.ACTIVITY_DEFAULTS) && J(R(null, null)) === J(A.ACTIVITY_DEFAULTS))
  check('config: unknown block keys are dropped', !('bogus' in R({ bogus: 1 }, {})))
  const w = []
  check('config: progress_checkpoint_sec 0 = off; 5 -> 10; 99999 -> 3600; -1 -> 0 (+ warning)', R({ progress_checkpoint_sec: 0 }).progress_checkpoint_sec === 0
    && R({ progress_checkpoint_sec: 5 }).progress_checkpoint_sec === 10 && R({ progress_checkpoint_sec: 99999 }).progress_checkpoint_sec === 3600
    && R({ progress_checkpoint_sec: -1 }, {}, w).progress_checkpoint_sec === 0 && w.length === 1 && R({}, { AI_BRIDGE_ACTIVITY_PROGRESS_CHECKPOINT_SEC: '30' }).progress_checkpoint_sec === 30)
})

// ================================================================= parseDuration
await section(async () => {
  const D = A.parseDuration
  check('duration: 15m / 1h25m / 1h 25m / 90s / 2d / 1.5h', D('15m') === 15 * MIN && D('1h25m') === 85 * MIN && D('1h 25m') === 85 * MIN && D('90s') === 90000 && D('2d') === 48 * HOUR && D('1.5h') === 90 * MIN)
  check('duration: number and bare numeric string = minutes', D(15) === 15 * MIN && D('15') === 15 * MIN && D(' 2.5 ') === 150000)
  check('duration: case-insensitive units', D('1H30M') === 90 * MIN)
  check('duration: junk is NaN', [D('abc'), D('15x'), D(''), D('m'), D('1h25'), D(null), D({}), D(-5), D('-5m')].every(Number.isNaN))
  check('duration: zero parses as 0 (callers reject it)', D('0m') === 0 && D(0) === 0)
})

// ================================================================= the 1.7x (v5) PATH reader (lib/activity-v5.js — the converter reads 1.7x records with it)
await section(async () => {
  const pp = s => V5.parsePath(s)
  const kinds = s => (r => r.ok ? r.segs.map(x => (x.kind === 'agent' ? 'A:' : 'C:') + x.name).join(' ') : r.code)(pp(s))
  check('v5 path: "spec-70" = an agent', kinds('spec-70') === 'A:spec-70')
  check('v5 path: "spec-70/research" = a sub-agent', kinds('spec-70/research') === 'A:spec-70 A:research')
  check('v5 path: "spec-70/@Tharsis" = a context of that agent', kinds('spec-70/@Tharsis') === 'A:spec-70 C:Tharsis')
  check('v5 path: "spec-70/@Tharsis/@z12" = a nested context', kinds('spec-70/@Tharsis/@z12') === 'A:spec-70 C:Tharsis C:z12')
  check('v5 path: "@#70/spec-70" = an agent under the session\'s context #70', kinds('@#70/spec-70') === 'C:#70 A:spec-70')
  check('v5 path: "@#70/@step4/spec-70" = an agent under a nested task context', kinds('@#70/@step4/spec-70') === 'C:#70 C:step4 A:spec-70')
  check('v5 path: quoted segments with spaces @"CTX strip 17" (and unquoted spaces in the path field)', kinds('a/@"CTX strip 17"/@z') === 'A:a C:CTX strip 17 C:z' && kinds('a/@CTX   strip 17') === 'A:a C:CTX strip 17')
  check('v5 path: canonical display quotes a name with spaces; the key is its lower case', pp('A/@CTX strip 17').path === 'A/@"CTX strip 17"' && pp('A/@CTX strip 17').key === 'a/@"ctx strip 17"' && pp('@~x').key === '@x')
  check('v5 path: @~ on the LAST segment = current; @root / @~root last = the node itself', pp('a/@~b').current && pp('a/@~b').path === 'a/@b' && pp('a/@~root').current && pp('a/@~root').path === 'a' && pp('@~root').path === '' && pp('').path === '')
  check('v5 path: errors — @~ mid-path, @root mid-path, an empty segment, a bad agent segment, quotes not ending a segment', pp('a/@~b/@c').code === 'bad-path' && pp('a/@root/b').code === 'bad-path'
    && pp('a//b').code === 'bad-path' && pp('has space/x').code === 'bad-agent' && pp('@"x"y/z').code === 'bad-context' && pp('@"unterminated').code === 'bad-context' && pp(5).code === 'bad-path')
  check('v5 path: depth 6 OK, 7 rejected (path-too-deep); @root does not count', pp('a/b/@c/@d/e/@f').ok && pp('a/b/@c/@d/e/@f/@g').code === 'path-too-deep' && pp('a/b/@c/@d/e/@f/@~root').ok)
  check('v5 path: leading / trailing slashes dropped', pp('/a/@b/').path === 'a/@b')
  check('v5 formatPath / pathKey: round-trip', V5.formatPath(pp('x/@"a b"/@~c').segs) === 'x/@"a b"/@c' && V5.pathKey('X/@B') === 'x/@b')
  check('v5 context names: 60 code points OK, 61 refused; control characters and a slash refused; "ROOT" is the node itself', pp(`@${rep('c', 60)}`).ok && pp(`@${rep('c', 61)}`).code === 'context-too-long'
    && pp(`@${rep('🙂', 60)}`).ok && pp(`@${rep('🙂', 61)}`).code === 'context-too-long' && pp('@a\u0001b').code === 'bad-context' && pp('@"a/b"').code === 'bad-context' && pp('x/@ROOT').path === 'x')
  check('v5 agent segments: 48 OK, 49 refused; allowed punctuation + unicode letters; a leading "-" refused', pp(rep('a', 48)).ok && pp(rep('a', 49)).code === 'bad-agent' && pp('w_1.a:b#2+c-d').ok && pp('agënt/分析').ok && pp('-lead').code === 'bad-agent')
  check('v5 recordKind: entry / cp / rep / cf of formats v2 – v5; a v1 (1.58 – 1.61) or v6 record, junk and an unknown state → null', V5.recordKind({ v: 5, id: 'a-1', ts: T0, session: 'S', path: '', text: 'x', state: 'running' }) === 'entry'
    && V5.recordKind({ v: 2, kind: 'cp', k: 1, ts: T0, session: 'S', path: 'a' }) === 'cp' && V5.recordKind({ v: 3, kind: 'cf', ts: T0, session: 'S', path: 'a' }) === 'cf' && V5.recordKind({ v: 4, rep: [1, 2], last: T0 }) === 'rep'
    && V5.recordKind({ v: 1, id: 'a-1', ts: T0, session: 'S', path: '', text: 'x', state: 'running' }) === null && V5.recordKind({ v: 6, id: 'a-1', ts: T0, session: 'S', path: '', text: 'x', state: 'running' }) === null
    && V5.recordKind({ v: 5, id: 'a-1', ts: T0, session: 'S', path: '', text: 'x', state: 'stale' }) === null && V5.recordKind(null) === null && V5.recordKind([]) === null)
})

// ================================================================= parseProgress (called directly; #79: three-part) + progressPct
await section(async () => {
  const PP = v => A.parseProgress(v)
  const pg = v => { const r = PP(v); return r.ok ? r.value : 'REJECTED' }
  check('progress: "4812/12000 tiles"', J(pg('4812/12000 tiles')) === J({ done: 4812, total: 12000, unit: 'tiles' }))
  check('progress: "4812/12000:tiles" and " : " spacing', J(pg('4812/12000:tiles')) === J({ done: 4812, total: 12000, unit: 'tiles' }) && J(pg('4812 / 12000 : tiles')) === J({ done: 4812, total: 12000, unit: 'tiles' }))
  check('progress: "3/6" (no unit)', J(pg('3/6')) === J({ done: 3, total: 6, unit: '' }))
  check('progress: multi-word unit', pg('3/6 map tiles').unit === 'map tiles')
  check('progress: "61%" -> {61,100,%}', J(pg('61%')) === J({ done: 61, total: 100, unit: '%' }) && pg('61.5 %').done === 61.5)
  check('progress: a bare number is a percent', J(pg(40)) === J({ done: 40, total: 100, unit: '%' }))
  check('progress: object form', J(pg({ done: 2, total: 8, unit: 'files' })) === J({ done: 2, total: 8, unit: 'files' }))
  check('progress: decimals allowed', pg('1.5/4 GB').done === 1.5)
  check('progress: 0/5 is fine', pg('0/5').done === 0)
  check('progress: done > total CLAMPS to total + warning', (r => r.ok && r.value.done === 12 && r.warning === 'progress-clamped')(PP('13/12')))
  check('progress: > 100% clamps to 100 + warning', (r => r.ok && r.value.done === 100 && r.warning === 'progress-clamped')(PP('150%')))
  check('progress: total 0 refused', !PP('5/0').ok && !PP({ done: 1, total: 0 }).ok)
  check('progress: negatives refused', !PP('-1/5').ok && !PP({ done: -1, total: 5 }).ok && !PP(-3).ok)
  check('progress: junk refused', ['abc', '5/', '/5', '4812/12000tiles', '5/5/5', 'NaN%'].every(v => !PP(v).ok) && !PP([1]).ok && !PP(true).ok)
  check('progress: object with non-numbers refused', !PP({ done: 'a', total: 5 }).ok && !PP({ done: null, total: 5 }).ok)
  check('progress: unit 24 chars OK, 25 refused', pg(`1/2 ${rep('u', 24)}`).unit.length === 24 && !PP(`1/2 ${rep('u', 25)}`).ok)
  check('#79 parseProgress: skipped from an object or a trailing "N skipped" ("3/6 1 skipped", "4812/12000 tiles · 100 skipped", "3/6:tiles, 1 skipped"); "3/6 skipped" is still a unit', J(PP({ done: 3, skipped: 1, total: 6, unit: 'x' }).value) === J({ done: 3, total: 6, unit: 'x', skipped: 1 })
    && J(PP('3/6 1 skipped').value) === J({ done: 3, total: 6, unit: '', skipped: 1 }) && J(PP('4812/12000 tiles · 100 skipped').value) === J({ done: 4812, total: 12000, unit: 'tiles', skipped: 100 })
    && J(PP('3/6:tiles, 1 skipped').value) === J({ done: 3, total: 6, unit: 'tiles', skipped: 1 }) && J(PP('3/6 skipped').value) === J({ done: 3, total: 6, unit: 'skipped' }), J([PP('3/6 1 skipped'), PP('4812/12000 tiles · 100 skipped'), PP('3/6 skipped')]))
  check('#79 parseProgress: WITHOUT skipped the value is exactly the 1.65 one (no key — records / slices byte-identical); skipped 0 is dropped too', J(PP('4812/12000 tiles').value) === J({ done: 4812, total: 12000, unit: 'tiles' }) && J(PP({ done: 1, total: 2, unit: '', skipped: 0 }).value) === J({ done: 1, total: 2, unit: '' }) && J(PP('61%').value) === J({ done: 61, total: 100, unit: '%' }))
  check('#79 parseProgress: done + skipped > total clamps skipped (progress-clamped); a negative / non-numeric skipped is refused', (r => r.ok && r.value.skipped === 2 && r.warning === 'progress-clamped')(PP({ done: 4, skipped: 5, total: 6 })) && !PP({ done: 1, skipped: -1, total: 6 }).ok && !PP({ done: 1, skipped: 'x', total: 6 }).ok)
  check('progressPct', A.progressPct({ done: 1, total: 4 }) === 25 && A.progressPct(null) === 0)
})

// ================================================================= parseEta (called directly)
await section(async () => {
  const eta = (v, o = { now: T0, tzOffsetMin: 0 }) => { const t = A.parseEta(v, o.now, o.tzOffsetMin); return Number.isFinite(t) ? t : 'bad-eta' }
  check('eta: 15m / 1h25m / 90s from now', eta('15m') === T0 + 15 * MIN && eta('1h25m') === T0 + 85 * MIN && eta('90s') === T0 + 90000)
  check('eta: number = minutes', eta(10) === T0 + 10 * MIN)
  check('eta: 7d OK, longer rejected', eta('7d') === T0 + 7 * 86400000 && eta('7d1s') === 'bad-eta')
  check('eta: zero / junk rejected', eta('0m') === 'bad-eta' && eta('soon') === 'bad-eta' && eta('25:00') === 'bad-eta' && eta('12:60') === 'bad-eta')
  check('eta: "19:27" local at +13:00 -> 27 min from now', eta('19:27', { now: T0, tzOffsetMin: 780 }) === T0 + 27 * MIN)
  check('eta: a passed clock time rolls to tomorrow', eta('18:00', { now: T0, tzOffsetMin: 780 }) === T0 + 23 * HOUR)
  check('eta: the current minute exactly rolls to tomorrow', eta('19:00', { now: T0, tzOffsetMin: 780 }) === T0 + 24 * HOUR)
  check('eta: "19:27" at UTC (offset 0) -> 13h27m', eta('19:27') === T0 + 13 * HOUR + 27 * MIN)
  check('eta: clock at a negative offset (-05:00 local 01:00) "9:05"', eta('9:05', { now: T0, tzOffsetMin: -300 }) === T0 + 8 * HOUR + 5 * MIN)
  check('eta: crossing local midnight (+13:00, "00:30" -> 5h30m)', eta('00:30', { now: T0, tzOffsetMin: 780 }) === T0 + 5 * HOUR + 30 * MIN)
  check('parseEta: NaN without a clock', Number.isNaN(A.parseEta('15m', undefined)) && A.parseEta('15m', 0) === 15 * MIN)
})

// ================================================================= renderText (placeholders rendered at READ time)
await section(async () => {
  const R = A.renderText, P1 = { done: 4812, total: 12000, unit: 'tiles' }
  check('render: {progress} with a unit', R('Seeding {progress}', P1, null, T0) === 'Seeding 4,812 of 12,000 tiles')
  check('render: {progress} without a unit; for a % bar', R('{progress}', { done: 3, total: 6, unit: '' }, null, T0) === '3 of 6' && R('{progress}', { done: 61, total: 100, unit: '%' }, null, T0) === '61%')
  check('render: {pct} floored (100% only when done)', R('{pct}', P1, null, T0) === '40%' && R('{pct}', { done: 999, total: 1000, unit: '' }, null, T0) === '99%' && R('{pct}', { done: 6, total: 6, unit: '' }, null, T0) === '100%')
  check('render: {done} {total} {unit}', R('{done}/{total} {unit}', P1, null, T0) === '4,812/12,000 tiles')
  check('render: {unit} with no unit is left untouched', R('{done} {unit}', { done: 3, total: 6, unit: '' }, null, T0) === '3 {unit}')
  check('render: no bar -> bar placeholders left untouched', R('a {progress} {pct} {done} {total} {unit} b', null, null, T0) === 'a {progress} {pct} {done} {total} {unit} b')
  check('render: {eta} short relative durations', R('{eta}', null, T0 + 85 * MIN, T0) === '~1h 25m' && R('{eta}', null, T0 + 45 * MIN, T0) === '~45m' && R('{eta}', null, T0 + 2 * HOUR, T0) === '~2h'
    && R('{eta}', null, T0 + 51 * HOUR, T0) === '~2d 3h' && R('{eta}', null, T0 + 30000, T0) === '~30s' && R('{eta}', null, T0 + 48 * HOUR, T0) === '~2d')
  check('render: {eta} due/past -> "now"; none -> "?"', R('{eta}', null, T0, T0) === 'now' && R('{eta}', null, T0 - MIN, T0) === 'now' && R('ETA {eta}', null, null, T0) === 'ETA ?')
  check('render: {{ and }} are literal braces', R('{{progress}} {{x}} }}', P1, null, T0) === '{progress} {x} }' && R('{{{progress}}}', { done: 1, total: 2, unit: '' }, null, T0) === '{1 of 2}')
  check('render: an unknown {word} (or {Progress}) is left untouched', R('{nope} {Progress} {progress', P1, null, T0) === '{nope} {Progress} {progress')
  check('render: a plain text is returned as is; non-string -> ""', R('just text', P1, null, T0) === 'just text' && R(null, P1, null, T0) === '')
  check('render: a rollup works as the bar', R('{progress}', { done: 40, total: 200, unit: 'tiles', pct: 20, rollup: true, n: 2 }, null, T0) === '40 of 200 tiles')
  check('#79 render: a three-part bar — "{progress}" adds " · N skipped", {pct} stays the done %, {skipped} the count', R('{progress}|{pct}|{skipped}', { done: 2, skipped: 1, total: 5, unit: '' }, null, T0) === '2 of 5 · 1 skipped|40%|1'
    && R('{progress}', { done: 61, skipped: 10, total: 100, unit: '%' }, null, T0) === '61% · 10% skipped' && R('{skipped}', P1, null, T0) === '0')
  check('fmtNum: grouping, decimals, negatives, deterministic', A.fmtNum(1234567) === '1,234,567' && A.fmtNum(1.5) === '1.5' && A.fmtNum(1234.567) === '1,234.57' && A.fmtNum(0) === '0'
    && A.fmtNum(999) === '999' && A.fmtNum(1000) === '1,000' && A.fmtNum(-2500) === '-2,500' && A.fmtNum(1e15) === '1,000,000,000,000,000' && A.fmtNum(2.0) === '2')
  check('fmtEta: rounding edges', A.fmtEta(59000) === '~59s' && A.fmtEta(60000) === '~1m' && A.fmtEta(89 * MIN + 40000) === '~1h 30m' && A.fmtEta(NaN) === '?')
  check('#79 forceBar: a DONE node is full (forced done, nothing skipped); an ABANDONED one has its remainder skipped; others unchanged; no bar stays none', (b => b.done === 10 && b.total === 10 && b.skipped === 0 && b.pct === 100 && b.forced === 'done')(A.forceBar({ current: { state: 'done' } }, { done: 3, skipped: 1, total: 10, abandoned: 1 }))
    && (b => b.done === 1 && b.skipped === 2 && b.forced === 'abandoned')(A.forceBar({ current: { state: 'abandoned' } }, { done: 1, skipped: 0, total: 3 })) && J(A.forceBar({ current: { state: 'failed' } }, { done: 4, skipped: 0, total: 10 })) === J({ done: 4, skipped: 0, total: 10 })
    && A.forceBar({ current: { state: 'done' } }, null) === null)
  check('stateOf: a node\'s line state, else running', A.stateOf({ current: { state: 'done' } }) === 'done' && A.stateOf({ current: null }) === 'running' && A.stateOf(null) === 'running')
})

// ================================================================= ids, days, session keys, attribution
await section(async () => {
  check('entryTime: reads the ms time back from <prefix><ts36>-<seq36>; junk → null', A.entryTime(`act_ab12_${T0.toString(36)}-1`) === T0 && A.entryTime('nope') === null && A.entryTime(5) === null)
  const d = new Date(T0)
  check('localDay: the LOCAL calendar day, YYYY-MM-DD', A.localDay(T0) === `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` && A.localDay(NaN) === null)
  check('sessionKey: the host is part of it (case-insensitive); groupKey leaves it out', A.sessionKey({ session: 'a', project: 'P', user: 'u', host: 'H1' }) !== A.sessionKey({ session: 'a', project: 'P', user: 'u', host: 'H2' })
    && A.sessionKey({ session: 'a', project: 'P', user: 'u', host: 'h1' }) === A.sessionKey({ session: 'A', project: 'p', user: 'U', host: 'H1' })
    && A.groupKey({ session: 'a', project: 'P', user: 'u', host: 'H1' }) === A.groupKey({ session: 'A', project: 'p', user: 'U', host: 'H2' }))
  check('sessionKey: another user (or realm) = another key; realm defaults to "default"', A.sessionKey({ session: 'a', project: 'P', user: 'u' }) !== A.sessionKey({ session: 'a', project: 'P', user: 'k' })
    && A.sessionKey({ session: 'a', project: 'P', user: 'u' }) !== A.sessionKey({ session: 'a', project: 'P', user: 'u', realm: 'other' })
    && A.sessionKey({ session: 'a', project: 'P', user: 'u' }) === A.sessionKey({ session: 'A', project: 'p', user: 'U', realm: 'Default' }))
  check('6d normBy / byText: a dashboard author is bounded + one line; a string stays 6c\'s; junk → none', J(A.normBy({ kind: 'dashboard', user: 'r\nx', host: 'H'.repeat(99) })) === J({ kind: 'dashboard', user: 'r x', host: 'H'.repeat(64) }) && A.byText(BY) === 'by robin via dashboard (DASH-HOST)'
    && A.byText('bridge') === 'by bridge' && A.normBy({ kind: 'evil' }) === null && A.normBy(42) === null)
  check('#84 firstWords: at most 6 words / 40 characters ("…" when cut), one line', A.firstWords('one two three four five six seven') === 'one two three four five six…' && A.firstWords('short') === 'short' && A.firstWords('x'.repeat(60)) === 'x'.repeat(39) + '…' && A.firstWords('a\nb  c') === 'a b c' && A.firstWords('Done. Next: ship it now please, thanks') === 'Done. Next: ship it now please…')
  check('notice verbs + the message limits', A.NOTICE_VERB === 'activity_changed' && A.EDIT_NOTICE_VERB === 'activity_text_edited' && A.MESSAGE_NOTICE_VERB === 'activity_message' && A.ANSWER_NOTICE_VERB === 'activity_answer' && A.MESSAGE_LIMITS.text === 2000 && A.MESSAGE_LIMITS.preview === 120)
})

// ================================================================= #82 ranks
await section(async () => {
  const D = A.RANK_DIGITS
  let ok = true, worst = ''
  const rnd = rng(82)
  const randRank = () => { let s = ''; const n = 1 + Math.floor(rnd() * 6); for (let i = 0; i < n; i++) s += D[Math.floor(rnd() * 36)]; return s.replace(/0+$/, '') || 'i' }
  for (let i = 0; i < 2000; i++) {
    let a = randRank(), b = randRank(); if (a === b) continue; if (a > b) [a, b] = [b, a]
    const m = A.rankBetween(a, b), lo = A.rankBetween(null, a), hi = A.rankBetween(b, null)
    if (!(a < m && m < b) || !(lo < a) || !(hi > b) || ![m, lo, hi].every(x => A.validRank(x))) { ok = false; worst = J([a, b, m, lo, hi]); break }
  }
  check('#82 rankBetween: strictly between (and below / above an open end) for 2000 random base-36 pairs; never a trailing "0"', ok, worst)
  let lo = 'a', hi = 'b', grow = 0
  for (let i = 0; i < 200; i++) { const m = A.rankBetween(lo, hi); if (!(lo < m && m < hi)) { grow = -1; break } hi = m; grow = m.length }
  check('#82 rankBetween: 200 inserts at ONE spot keep strict order, growing slowly (≤ 50 chars)', grow > 0 && grow <= 50, grow)
  check('#82 validRank: base-36, no trailing 0, ≤128 chars', A.validRank('a1') === 'a1' && A.validRank('a0') === null && A.validRank('A') === null && A.validRank('') === null && A.validRank('z'.repeat(129)) === null && A.validRank(5) === null)
  check('#82 derivedRank: creation order (ms) then plan position — an older node and a lower plan_ix sort first', A.derivedRank(T0, 0) < A.derivedRank(T0, 1) && A.derivedRank(T0, 5) < A.derivedRank(T0 + 1, null) && A.derivedRank(T0, null) < A.derivedRank(T0, 0) && A.derivedRank(T0, 0).length === 12)
  const n = (key, kind, o = {}) => ({ key, kind, created_at: T0, ...o })
  check('#82 rankOf / rankGroup / siblingCmp: a stored rank wins, else derived; plan items, then contexts, then agents; a tie falls to the key',
    A.rankOf(n('a', 'context', { rank: 'k' })) === 'k' && A.rankOf(n('a', 'context')) === A.derivedRank(T0, null) && A.rankGroup(n('x', 'context', { plan: true })) === 0 && A.rankGroup(n('x', 'context')) === 1 && A.rankGroup(n('x', 'agent')) === 2
    && J([n('ag', 'agent'), n('c', 'context'), n('p2', 'context', { plan: true, plan_ix: 1 }), n('p1', 'context', { plan: true, plan_ix: 0 }), n('b', 'context')].sort(A.siblingCmp).map(x => x.key)) === J(['p1', 'p2', 'b', 'c', 'ag']))
})

// ================================================================= #85 / #90 questions: constants, the answer entry's text, stampText
await section(async () => {
  const STAMP = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/
  check('#85 constants: the limits (8 choices × 60, answers ≤ 1000, expires ≤ 7 d), the statuses, the verb',
    A.QUESTION_LIMITS.choices === 8 && A.QUESTION_LIMITS.choice === 60 && A.QUESTION_LIMITS.answer === 1000 && A.QUESTION_LIMITS.expiresMaxMs === 7 * 24 * HOUR
    && A.ANSWER_NOTICE_VERB === 'activity_answer' && J(A.QUESTION_STATUSES) === J(['asked', 'answered', 'expired', 'withdrawn']))
  check('#90 stampText: local time + its UTC offset', STAMP.test(A.stampText(T0)) && A.stampText(NaN) === '?')
  check('#90 answerEntryText: a choice quoted + " — note: …"; free text alone quoted; cut to 240 with "…"',
    A.answerEntryText('answered', BY, { choice: 'Accept', text: 'ship\nit' }) === 'answered by robin via dashboard (DASH-HOST): "Accept" — note: ship it'
    && A.answerEntryText('answer changed', BY, { text: 'later' }) === 'answer changed by robin via dashboard (DASH-HOST): "later"'
    && [...A.answerEntryText('answered', BY, { choice: 'A', text: 'x'.repeat(900) })].length === 240 && A.answerEntryText('answered', BY, { choice: 'A', text: 'x'.repeat(900) }).endsWith('…')
    && [...A.answerEntryText('answered', BY, { text: 'y'.repeat(900) })].length === 240 && A.answerEntryText('answered', BY, { text: 'y'.repeat(900) }).endsWith('…"'))
  check('#85 normQuestion / questionView: bounded and canonical; junk → null; by shown as { user, host }', (q => q && J(q.choices) === J(['Postgres', 'SQLite']) && q.free === false && q.status === 'asked')(A.normQuestion({ status: 'asked', choices: [' Postgres ', 'SQLite', 'postgres'], asked_at: T0 }))
    && A.normQuestion({ status: 'nope' }) === null && A.normQuestion(null) === null
    && J(A.questionView({ status: 'answered', choices: ['A'], asked_at: T0, answer: { choice: 'A' }, by: BY, at: T0 + 1 })) === J({ status: 'answered', choices: ['A'], free: false, asked_at: T0, answer: { choice: 'A' }, by: { user: 'robin', host: 'DASH-HOST' }, at: T0 + 1 }))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
