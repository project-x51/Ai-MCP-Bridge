// Fast UNIT tests for lib/activity.js — the pure core of #70 (agent activity board). No bridge, no sockets, no clock: every
// time is an explicit `now`. v1.62.0 (#70 step 6a): the UNIFIED NODE TREE — path parsing (every form + the old notation),
// agents vs contexts, implicit intermediates, depth / agent / node limits with subtree eviction, recursive rollup, context
// staleness inherited from the nearest agent, per-node logs merged per subtree (paging + the files descriptor), batches
// (splitBatch), the v2 record / slice format (a 1.61 v1 record or slice is skipped / refused), plus everything steps 1–5
// covered (parsing, apply, stale/gone/visibility, snapshot/merge, the wire, the dashboard units, the budget, checkpoints,
// the newest-first replay == a chronological apply on seeded random sequences WITH NESTED PATHS, the file facet).
// AIMB_TEST_ACTIVITY_LIB=<file> runs it against another copy of the library (the pre-change proof).
import { pathToFileURL } from 'node:url'
const A = await import(process.env.AIMB_TEST_ACTIVITY_LIB ? pathToFileURL(process.env.AIMB_TEST_ACTIVITY_LIB).href : '../lib/activity.js')
let pass = 0, fail = 0
const check = (n, c, x = '') => { let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.message} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
// each section runs on its own: a crash (e.g. a missing export when run against an older library) is ONE failure, the rest still run
async function section(fn) { try { await fn() } catch (e) { fail++; console.log('FAIL section crashed:', (e && e.message) || e) } }
const MIN = 60000, HOUR = 3600000
const T0 = Date.UTC(2026, 8, 30, 6, 0, 0)   // 2026-09-30 06:00 UTC (19:00 at +13:00)
const P = (input, opts) => A.parseMessage(input, opts)
const M = (input, opts = { now: T0 }) => { const r = P(input, opts); return r.ok ? r.msg : null }
const C = (input, opts = { now: T0 }) => { const r = P(input, opts); return r.ok ? 'OK' : r.code }
const mk = (config = {}, origin = 'HOST-A') => A.createActivity({ config, origin })
const S1 = { session: 'Bridget', project: 'AIMB', user: 'robin', host: 'ROBIN-Z790' }
/** parse + apply; throws on a parse failure so a test can't silently pass on a bad fixture */
function say(st, ident, input, now) {
  const p = A.parseMessage(input, { now, tzOffsetMin: 0 })
  if (!p.ok) throw new Error(`fixture failed to parse: ${J(input)} -> ${p.code}: ${p.what}`)
  return A.apply(st, ident, p.msg, now)
}
const rep = (ch, n) => ch.repeat(n)
const N = (st, ident, path, origin) => A.getNode(st, ident, path, origin)   // a node by path ('' / null = the session root)
const root = (st, ident, origin) => N(st, ident, '', origin)
const agentCount = s => [...s.nodes.values()].filter(n => n.key && n.kind === 'agent').length
const nonRoot = s => s.nodes.size - 1
const kidPaths = (s, path) => A.childrenOf(s, s.nodes.get(A.pathKey(path))).map(n => n.path)
const nodeOf = (g, path, host) => (g?.nodes || []).find(n => n.path === path && (!host || n.host === host))

// ================================================================= constants
check('limits: the locked #70 values (6a: depth 6, 128 agents, 4096 nodes, batch 64 / 64 KB)', A.ACTIVITY_LIMITS.text === 240 && A.ACTIVITY_LIMITS.context === 60 && A.ACTIVITY_LIMITS.depth === 6
  && A.ACTIVITY_LIMITS.agentsPerSession === 128 && A.ACTIVITY_LIMITS.nodesPerSession === 4096 && A.ACTIVITY_LIMITS.detailsBytes === 4096
  && A.ACTIVITY_LIMITS.dataBytes === 16384 && A.ACTIVITY_LIMITS.staleAfterMaxMs === 24 * HOUR && A.ACTIVITY_LIMITS.batchItems === 64 && A.ACTIVITY_LIMITS.batchBytes === 65536
  && !('contextsPerAgent' in A.ACTIVITY_LIMITS) && !('pathDepth' in A.ACTIVITY_LIMITS))
check('format: records + slices are v2 (6a)', A.ACTIVITY_FORMAT === 2 && mk().v === 2)
check('limits + defaults are frozen', Object.isFrozen(A.ACTIVITY_LIMITS) && Object.isFrozen(A.ACTIVITY_DEFAULTS) && Object.isFrozen(A.ACTIVITY_STATES))
check('defaults: the #70 per-host config (+ step 2 progress_checkpoint_sec)', J(A.ACTIVITY_DEFAULTS) === J({ log_retention_days: 7, log_entries_per_agent: 200, stale_after_min: 15, finished_visible_hours: 24, memory_budget_mb: 64, progress_checkpoint_sec: 60, enabled: true }))
check('states: running|blocked|failed|done|idle', J(A.ACTIVITY_STATES) === J(['running', 'blocked', 'failed', 'done', 'idle']))
check('env names: AI_BRIDGE_ACTIVITY_<KEY>', A.ACTIVITY_ENV.stale_after_min === 'AI_BRIDGE_ACTIVITY_STALE_AFTER_MIN' && A.ACTIVITY_ENV.enabled === 'AI_BRIDGE_ACTIVITY_ENABLED' && A.ACTIVITY_ENV.progress_checkpoint_sec === 'AI_BRIDGE_ACTIVITY_PROGRESS_CHECKPOINT_SEC' && Object.keys(A.ACTIVITY_ENV).length === 7)
check('message fields: + path (6a)', J(A.MESSAGE_FIELDS) === J(['path', 'agent', 'text', 'context', 'state', 'progress', 'eta', 'stale_after', 'details', 'data', 'log']))

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
  check('config: createActivity re-validates a raw block', mk({ stale_after_min: 99999 }).config.stale_after_min === 1440)
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

// ================================================================= parseMessage: context prefixes (the old notation)
await section(async () => {
  const m1 = M({ text: 'plain status' })
  check('prefix: none -> the session itself, log-only', m1.context === 'root' && m1.root && !m1.current && m1.text === 'plain status' && m1.path === '')
  const m2 = M({ text: '@build compiling' })
  check('prefix: @name -> that context, log-only, prefix stripped', m2.context === 'build' && !m2.root && !m2.current && m2.text === 'compiling' && m2.path === '@build')
  const m3 = M({ text: '@~build compiling' })
  check('prefix: @~name -> current', m3.context === 'build' && m3.current && m3.text === 'compiling')
  const m4 = M({ text: '@"CTX strip 17" tiling' })
  check('prefix: @"quoted name" with spaces', m4 && m4.context === 'CTX strip 17' && !m4.current && m4.text === 'tiling' && m4.path === '@"CTX strip 17"')
  const m5 = M({ text: '@~"CTX strip 17" tiling' })
  check('prefix: @~"quoted name" -> current', m5 && m5.context === 'CTX strip 17' && m5.current && m5.text === 'tiling')
  check('prefix: @root / @~root / @~ROOT are the node itself', (a => a.context === 'root' && a.root && !a.current && a.path === '')(M({ text: '@root hi' }))
    && (a => a.context === 'root' && a.root && a.current)(M({ text: '@~root hi' })) && (a => a.context === 'root' && a.root)(M({ text: '@~ROOT hi' })))
  check('prefix: @"root" quoted is also root', M({ text: '@~"Root" hi' }).root)
  check('prefix: "@ " / "@~ " followed by space is literal text', (a => a.context === 'root' && a.text === '@ hello')(M({ text: '@ hello' })) && (a => a.context === 'root' && a.text === '@~ hello')(M({ text: '@~ hello' })))
  check('prefix: a lone "@" is literal text', M({ text: '@' }).text === '@')
  check('prefix: leading whitespace tolerated; text trimmed', (a => a.context === 'build' && a.current && a.text === 'spaced out')(M({ text: '   @~build    spaced out  ' })))
  check('prefix: unterminated quote -> bad-context', C({ text: '@"unterminated hi' }) === 'bad-context')
  check('prefix: quote not followed by a space -> bad-context', C({ text: '@"x"y hi' }) === 'bad-context')
  check('prefix: empty quoted name -> bad-context', C({ text: '@"" hi' }) === 'bad-context' && C({ text: '@~"   " hi' }) === 'bad-context')
  check('prefix: an unquoted name containing a quote -> bad-context', C({ text: '@ab"c hi' }) === 'bad-context')
  check('prefix: prefix alone (no text) -> text-empty', C({ text: '@~build' }) === 'text-empty' && C({ text: '@~"a b"   ' }) === 'text-empty')
  check('prefix: quoted name whitespace collapsed', M({ text: '@~"a    b" x' }).context === 'a b')
  check('prefix: a quoted name at the very end is still a prefix (-> text-empty)', C({ text: '@"x"' }) === 'text-empty')
  // the context parameter
  const p1 = M({ text: '@~build hi', context: '@~deploy' })
  check('context param: overrides; text taken LITERALLY (prefix not parsed)', p1.context === 'deploy' && p1.current && p1.text === '@~build hi')
  check('context param: "build" = @build, "~build" = @~build', (a => a.context === 'build' && !a.current)(M({ text: 'x', context: 'build' })) && (a => a.context === 'build' && a.current)(M({ text: 'x', context: '~build' })))
  check('context param: "@root" / "@~root"', (a => a.root && !a.current)(M({ text: 'x', context: '@root' })) && (a => a.root && a.current)(M({ text: 'x', context: '@~root' })))
  check('context param: quoted or bare name with spaces', M({ text: 'x', context: '@~"CTX strip 17"' }).context === 'CTX strip 17' && M({ text: 'x', context: '@~CTX strip 17' }).context === 'CTX strip 17')
  check('context param: empty / whitespace -> the text prefix is used', M({ text: '@~b hi', context: '' }).context === 'b' && M({ text: '@~b hi', context: '   ' }).context === 'b')
  check('context param: non-string -> bad-context', C({ text: 'x', context: 5 }) === 'bad-context' && C({ text: 'x', context: '@~' }) === 'bad-context')
  check('context param (6a): a slash in it is refused (nest with path)', C({ text: 'x', context: '@a/b' }) === 'bad-context')
  // context name length
  check('context: 60 chars OK, 61 rejected (prefix)', M({ text: `@~${rep('c', 60)} x` }).context.length === 60 && C({ text: `@~${rep('c', 61)} x` }) === 'context-too-long')
  check('context: 60 chars OK, 61 rejected (quoted)', M({ text: `@"${rep('c', 59)} " x` }).context.length === 59 && C({ text: `@"${rep('c', 30)} ${rep('c', 30)}" x` }) === 'context-too-long')
  check('context: 60 chars OK, 61 rejected (param)', M({ text: 'x', context: rep('c', 60) }) !== null && C({ text: 'x', context: rep('c', 61) }) === 'context-too-long')
  check('context: length counts code points (60 emoji OK, 61 not)', M({ text: `@${rep('🙂', 60)} x` }) !== null && C({ text: `@${rep('🙂', 61)} x` }) === 'context-too-long')
  check('context: control chars rejected', C({ text: 'x', context: 'a\u0001b' }) === 'bad-context')
  check('normContextName: exported + canonical root; a slash is refused (6a)', A.normContextName('ROOT').name === 'root' && A.normContextName('  a  b ').name === 'a b' && !A.normContextName('').ok && A.normContextName('a/b').code === 'bad-context')
})

// ================================================================= 6a: PATHS — every form, canonical spelling, keys, errors
await section(async () => {
  const pp = s => A.parsePath(s)
  const kinds = s => (r => r.ok ? r.segs.map(x => (x.kind === 'agent' ? 'A:' : 'C:') + x.name).join(' ') : r.code)(pp(s))
  check('path: "spec-70" = an agent', kinds('spec-70') === 'A:spec-70')
  check('path: "spec-70/research" = a sub-agent', kinds('spec-70/research') === 'A:spec-70 A:research')
  check('path: "spec-70/@Tharsis" = a context of that agent', kinds('spec-70/@Tharsis') === 'A:spec-70 C:Tharsis')
  check('path: "spec-70/@Tharsis/@z12" = a nested context', kinds('spec-70/@Tharsis/@z12') === 'A:spec-70 C:Tharsis C:z12')
  check('path: "@#70/spec-70" = an agent under the session\'s context #70', kinds('@#70/spec-70') === 'C:#70 A:spec-70')
  check('path: "@#70/@step4/spec-70" = an agent under a nested task context', kinds('@#70/@step4/spec-70') === 'C:#70 C:step4 A:spec-70')
  check('path: quoted segments with spaces @"CTX strip 17" (and unquoted spaces in the path field)', kinds('a/@"CTX strip 17"/@z') === 'A:a C:CTX strip 17 C:z' && kinds('a/@CTX   strip 17') === 'A:a C:CTX strip 17')
  check('path: canonical display quotes a name with spaces; the key is its lower case', pp('A/@CTX strip 17').path === 'A/@"CTX strip 17"' && pp('A/@CTX strip 17').key === 'a/@"ctx strip 17"' && pp('@~x').key === '@x')
  check('path: @~ on the LAST segment = current; @root / @~root last = the node itself', pp('a/@~b').current && pp('a/@~b').path === 'a/@b' && pp('a/@~root').current && pp('a/@~root').path === 'a' && pp('@~root').path === '' && pp('').path === '')
  check('path: errors — @~ mid-path, @root mid-path, an empty segment, a bad agent segment, quotes not ending a segment', pp('a/@~b/@c').code === 'bad-path' && pp('a/@root/b').code === 'bad-path'
    && pp('a//b').code === 'bad-path' && pp('has space/x').code === 'bad-agent' && pp('@"x"y/z').code === 'bad-context' && pp('@"unterminated').code === 'bad-context' && pp(5).code === 'bad-path')
  check('path: depth 6 OK, 7 rejected (path-too-deep); @root does not count', pp('a/b/@c/@d/e/@f').ok && pp('a/b/@c/@d/e/@f/@g').code === 'path-too-deep' && pp('a/b/@c/@d/e/@f/@~root').ok)
  check('path: leading / trailing slashes dropped', pp('/a/@b/').path === 'a/@b')
  check('formatPath / pathKey: round-trip', A.formatPath(pp('x/@"a b"/@~c').segs) === 'x/@"a b"/@c' && A.pathKey('X/@B') === 'x/@b')
  // the message: path field, + text prefix as a relative path, + the old fields
  const mp = M({ path: '@#70/@step4/spec-70', text: '@Tharsis/@~z12 seeding' })
  check('message: path + a relative-path text prefix → one node path; owner = the nearest agent', mp.path === '@#70/@step4/spec-70/@Tharsis/@z12' && mp.current && mp.agent === '@#70/@step4/spec-70' && mp.context === 'z12' && !mp.root && mp.text === 'seeding')
  check('message: an agent target (root:true, context "root")', (m => m.root && m.context === 'root' && m.agent === 'spec-70/research' && !m.current)(M({ path: 'spec-70/research', text: 'x' })))
  check('message: a context directly under the session has no owner agent (agent:null)', (m => m.agent === null && m.context === '#70' && m.path === '@#70')(M({ path: '@#70', text: 'x' })))
  check('message: path ending @~ + a text prefix → bad-path; depth counted over the whole address', C({ path: 'a/@~b', text: '@c x' }) === 'bad-path' && C({ path: 'a/b/c/d/e', text: '@f/@g x' }) === 'path-too-deep')
  check('message: a text prefix with @~ mid-path → bad-path', C({ text: '@~a/@b x' }) === 'bad-path')
  // OLD NOTATION == the path form
  const same = (a, b) => (x => x.path === b.path && x.current === b.current && x.text === b.text)(M(a)) || `${J(M(a))}`
  const eqv = [
    [{ agent: 'a/b', text: '@~Ctx hi' }, { path: 'a/b/@~Ctx', text: 'hi' }],
    [{ agent: 'a/b', context: '@~Ctx', text: 'hi' }, { path: 'a/b/@~Ctx', text: 'hi' }],
    [{ agent: 'a', text: '@~root hi' }, { path: 'a/@~root', text: 'hi' }],
    [{ agent: 'a', text: 'hi' }, { path: 'a', text: 'hi' }],
    [{ text: '@~root hi' }, { path: '@~root', text: 'hi' }],
    [{ text: '@~"CTX strip 17" hi' }, { path: '@~"CTX strip 17"', text: 'hi' }],
    [{ agent: 'spec-70', path: '@Tharsis', text: '@~z12 hi' }, { path: 'spec-70/@Tharsis/@~z12', text: 'hi' }],
  ]
  check('old notation: agent + @~Ctx / context / @~root / nothing / a quoted prefix ≡ the path form (agent + path + ctx concatenate)', eqv.every(([a, b]) => { const x = M(a), y = M(b); return x && y && x.path === y.path && x.current === y.current && x.text === y.text && x.agent === y.agent && x.context === y.context }),
    J(eqv.map(([a, b]) => [M(a)?.path, M(b)?.path])))
  const st1 = mk(), st2 = mk()
  say(st1, S1, { agent: 'w', text: '@~build compiling', progress: '1/4' }, T0); say(st2, S1, { path: 'w/@~build', text: 'compiling', progress: '1/4' }, T0)
  check('old notation: applying either form gives the same state', J(A.snapshot(st1)) === J(A.snapshot(st2)))
  void same
  check('resolveAddress: exported (queries use it: agent + path + context, @~ ignored by callers)', (r => r.ok && r.key === 'a/@b')(A.resolveAddress({ agent: 'A', context: '@~B' })))
})

// ================================================================= parseMessage: text
await section(async () => {
  check('text: empty / whitespace -> text-empty', C({ text: '' }) === 'text-empty' && C({ text: '   \n ' }) === 'text-empty')
  check('text: non-string -> bad-text', C({ text: 5 }) === 'bad-text' && C({}) === 'bad-text')
  const t240 = rep('a', 240), m240 = M({ text: t240 })
  check('text: exactly 240 kept, no warning', m240.text === t240 && m240.warnings.length === 0)
  const m241 = M({ text: rep('a', 241) })
  check('text: 241 TRUNCATED to 240 (239 + …) + warning', Array.from(m241.text).length === 240 && m241.text.endsWith('…') && m241.warnings.includes('text-truncated'))
  const me = M({ text: rep('😀', 241) })
  check('text: truncation counts code points (no split surrogate)', Array.from(me.text).length === 240 && me.text.startsWith('😀') && !/[\ud800-\udbff]…$/.test(me.text))
  check('text: 240 emoji kept whole', M({ text: rep('😀', 240) }).warnings.length === 0)
  check('text: newlines/tabs -> one space; control chars dropped', M({ text: 'a\n\nb\tc\u0007d' }).text === 'a b cd')
  check('text: the prefix does not count toward 240', M({ text: `@~build ${rep('a', 240)}` }).warnings.length === 0)
})

// ================================================================= parseMessage: agent / state / input
await section(async () => {
  check('agent: absent / empty -> null (the session itself)', M({ text: 'x' }).agent === null && M({ text: 'x', agent: '' }).agent === null && M({ text: 'x', agent: null }).agent === null)
  check('agent: 1..6 levels (6a)', M({ text: 'x', agent: 'a' }).agent === 'a' && M({ text: 'x', agent: 'spec-70/research' }).agent === 'spec-70/research' && M({ text: 'x', agent: 'a/b/c/d/e/f' }).agent === 'a/b/c/d/e/f')
  check('agent: 7 levels -> path-too-deep', C({ text: 'x', agent: 'a/b/c/d/e/f/g' }) === 'path-too-deep')
  check('agent: segments trimmed, outer slashes dropped', M({ text: 'x', agent: ' /a / b/ ' }).agent === 'a/b')
  check('agent: empty inner segment -> bad-agent', C({ text: 'x', agent: 'a//b' }) === 'bad-agent' && C({ text: 'x', agent: '/' }) === 'bad-agent')
  check('agent: spaces / odd chars / a context segment -> bad-agent', C({ text: 'x', agent: 'has space' }) === 'bad-agent' && C({ text: 'x', agent: 'a$b' }) === 'bad-agent' && C({ text: 'x', agent: '-lead' }) === 'bad-agent' && C({ text: 'x', agent: 'a/@ctx' }) === 'bad-agent')
  check('agent: allowed punctuation + unicode letters', M({ text: 'x', agent: 'w_1.a:b#2+c-d' }) !== null && M({ text: 'x', agent: 'agënt/分析' }) !== null)
  check('agent: segment 48 OK, 49 rejected', M({ text: 'x', agent: rep('a', 48) }) !== null && C({ text: 'x', agent: rep('a', 49) }) === 'bad-agent')
  check('agent: non-string -> bad-agent', C({ text: 'x', agent: 7 }) === 'bad-agent')
  check('state: each reported state accepted (case-insensitive)', A.ACTIVITY_STATES.every(s => M({ text: 'x', state: s.toUpperCase() }).state === s))
  check('state: absent -> null (apply picks the default)', M({ text: 'x' }).state === null && M({ text: 'x', state: '' }).state === null)
  check('state: derived/unknown states rejected', C({ text: 'x', state: 'stale' }) === 'bad-state' && C({ text: 'x', state: 'gone' }) === 'bad-state' && C({ text: 'x', state: 'ok' }) === 'bad-state' && C({ text: 'x', state: 3 }) === 'bad-state')
  check('input: non-object -> bad-input', C(null) === 'bad-input' && C([]) === 'bad-input' && C('text') === 'bad-input')
  check('input: plan (6b) -> not-yet', C({ text: 'x', plan: ['A', 'B'] }) === 'not-yet')
  const r = P({ text: 'x', state: 'nope' })
  check('input: a failure carries code + a human "what"', r.ok === false && r.code === 'bad-state' && typeof r.what === 'string' && r.what.length > 5)
})

// ================================================================= parseMessage: progress
await section(async () => {
  const pg = v => { const m = M({ text: 'x', progress: v }); return m ? m.progress : 'REJECTED' }
  check('progress: "4812/12000 tiles"', J(pg('4812/12000 tiles')) === J({ done: 4812, total: 12000, unit: 'tiles' }))
  check('progress: "4812/12000:tiles" and " : " spacing', J(pg('4812/12000:tiles')) === J({ done: 4812, total: 12000, unit: 'tiles' }) && J(pg('4812 / 12000 : tiles')) === J({ done: 4812, total: 12000, unit: 'tiles' }))
  check('progress: "3/6" (no unit)', J(pg('3/6')) === J({ done: 3, total: 6, unit: '' }))
  check('progress: multi-word unit', pg('3/6 map tiles').unit === 'map tiles')
  check('progress: "61%" -> {61,100,%}', J(pg('61%')) === J({ done: 61, total: 100, unit: '%' }) && pg('61.5 %').done === 61.5)
  check('progress: a bare number is a percent', J(pg(40)) === J({ done: 40, total: 100, unit: '%' }))
  check('progress: object form', J(pg({ done: 2, total: 8, unit: 'files' })) === J({ done: 2, total: 8, unit: 'files' }))
  check('progress: decimals allowed', pg('1.5/4 GB').done === 1.5)
  check('progress: 0/5 is fine', pg('0/5').done === 0)
  const over = M({ text: 'x', progress: '13/12' })
  check('progress: done > total CLAMPS to total + warning', over.progress.done === 12 && over.warnings.includes('progress-clamped'))
  const pov = M({ text: 'x', progress: '150%' })
  check('progress: > 100% clamps to 100 + warning', pov.progress.done === 100 && pov.warnings.includes('progress-clamped'))
  check('progress: total 0 -> bad-progress', C({ text: 'x', progress: '5/0' }) === 'bad-progress' && C({ text: 'x', progress: { done: 1, total: 0 } }) === 'bad-progress')
  check('progress: negatives -> bad-progress', C({ text: 'x', progress: '-1/5' }) === 'bad-progress' && C({ text: 'x', progress: { done: -1, total: 5 } }) === 'bad-progress' && C({ text: 'x', progress: -3 }) === 'bad-progress')
  check('progress: junk -> bad-progress', ['abc', '5/', '/5', '4812/12000tiles', '5/5/5', 'NaN%'].every(v => C({ text: 'x', progress: v }) === 'bad-progress') && C({ text: 'x', progress: [1] }) === 'bad-progress' && C({ text: 'x', progress: true }) === 'bad-progress')
  check('progress: object with non-numbers -> bad-progress', C({ text: 'x', progress: { done: 'a', total: 5 } }) === 'bad-progress' && C({ text: 'x', progress: { done: null, total: 5 } }) === 'bad-progress')
  check('progress: unit 24 chars OK, 25 rejected', pg(`1/2 ${rep('u', 24)}`).unit.length === 24 && C({ text: 'x', progress: `1/2 ${rep('u', 25)}` }) === 'bad-progress')
  check('progress: "none" -> explicit clear (null); absent -> key absent', (m => 'progress' in m && m.progress === null)(M({ text: 'x', progress: 'none' })) && !('progress' in M({ text: 'x' })) && !('progress' in M({ text: 'x', progress: '' })))
  check('progressPct', A.progressPct({ done: 1, total: 4 }) === 25 && A.progressPct(null) === 0)
})

// ================================================================= parseMessage: eta
await section(async () => {
  const eta = (v, opts = { now: T0, tzOffsetMin: 0 }) => { const r = P({ text: 'x', eta: v }, opts); return r.ok ? r.msg.eta_at : r.code }
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
  check('eta: without now -> bad-eta', P({ text: 'x', eta: '15m' }).code === 'bad-eta')
  check('eta: "none" -> explicit clear (null), needs no now', (r => r.ok && r.msg.eta_at === null)(P({ text: 'x', eta: 'none' })))
  check('parseEta exported (NaN on no clock)', Number.isNaN(A.parseEta('15m', undefined)) && A.parseEta('15m', 0) === 15 * MIN)
})

// ================================================================= parseMessage: stale_after / details / data
await section(async () => {
  const sa = v => { const r = P({ text: 'x', stale_after: v }); return r.ok ? r.msg : r.code }
  check('stale_after: "60m" / "2h" / 30 (minutes)', sa('60m').stale_after_ms === HOUR && sa('2h').stale_after_ms === 2 * HOUR && sa(30).stale_after_ms === 30 * MIN)
  check('stale_after: exactly 24h, no warning', sa('24h').stale_after_ms === 24 * HOUR && sa('24h').warnings.length === 0)
  check('stale_after: > 24h CLAMPS to 24h + warning', sa('25h').stale_after_ms === 24 * HOUR && sa('25h').warnings.includes('stale-after-capped') && sa('3d').stale_after_ms === 24 * HOUR)
  check('stale_after: zero / junk rejected', sa('0m') === 'bad-stale-after' && sa('later') === 'bad-stale-after' && sa(-1) === 'bad-stale-after')
  check('stale_after: absent -> null', M({ text: 'x' }).stale_after_ms === null)
  check('details: 4096 bytes OK, 4097 rejected', M({ text: 'x', details: rep('d', 4096) }).details.length === 4096 && C({ text: 'x', details: rep('d', 4097) }) === 'details-too-large')
  check('details: measured in UTF-8 bytes (2048 x "é" OK, 2049 not)', M({ text: 'x', details: rep('é', 2048) }) !== null && C({ text: 'x', details: rep('é', 2049) }) === 'details-too-large')
  check('details: non-string -> bad-details', C({ text: 'x', details: { a: 1 } }) === 'bad-details' && C({ text: 'x', details: 5 }) === 'bad-details')
  check('details: absent / empty -> null', M({ text: 'x' }).details === null && M({ text: 'x', details: '' }).details === null)
  check('data: object and array accepted', J(M({ text: 'x', data: { a: [1, 2] } }).data) === J({ a: [1, 2] }) && J(M({ text: 'x', data: [1, 'b'] }).data) === J([1, 'b']))
  check('data: a JSON string of an object is parsed', J(M({ text: 'x', data: '{"tiles":17}' }).data) === J({ tiles: 17 }))
  check('data: invalid JSON string -> bad-data', C({ text: 'x', data: '{nope' }) === 'bad-data')
  check('data: scalars -> bad-data', C({ text: 'x', data: 5 }) === 'bad-data' && C({ text: 'x', data: '"str"' }) === 'bad-data' && C({ text: 'x', data: true }) === 'bad-data')
  check('data: class instances -> bad-data', C({ text: 'x', data: new Date(0) }) === 'bad-data' && C({ text: 'x', data: new Map() }) === 'bad-data')
  const cyc = { a: 1 }; cyc.self = cyc
  check('data: cyclic -> bad-data', C({ text: 'x', data: cyc }) === 'bad-data')
  check('data: BigInt inside -> bad-data', C({ text: 'x', data: { n: 10n } }) === 'bad-data')
  check('data: null-prototype object OK', M({ text: 'x', data: Object.assign(Object.create(null), { a: 1 }) }).data.a === 1)
  const exact = { s: rep('z', 16384 - J({ s: '' }).length) }
  check('data: exactly 16384 bytes serialised OK, one more rejected', J(exact).length === 16384 && M({ text: 'x', data: exact }) !== null && C({ text: 'x', data: { s: exact.s + 'z' } }) === 'data-too-large')
  const src = { n: 1, deep: { k: 'v' } }, dm = M({ text: 'x', data: src })
  src.n = 2; src.deep.k = 'changed'
  check('data: stored as a JSON CLONE (later caller mutation does not leak)', dm.data.n === 1 && dm.data.deep.k === 'v')
  check('data: undefined/function fields are dropped by the JSON clone', J(M({ text: 'x', data: { a: 1, f() {}, u: undefined } }).data) === J({ a: 1 }))
})

// ================================================================= apply: basics
await section(async () => {
  const st = mk()
  const r = say(st, S1, { text: 'starting up' }, T0)
  check('apply: ok + the #70 return shape (+ path)', r.ok && typeof r.id === 'string' && r.ts === T0 && r.current === false && r.agent === null && r.context === 'root' && r.path === '' && r.state === 'running'
    && r.stale_at === T0 + 15 * MIN && Array.isArray(r.evicted) && r.evicted.length === 0 && Array.isArray(r.warnings), J(r))
  const sess = A.getSession(st, S1)
  check('apply: auto-creates the session with its ROOT node; its host is the origin (ident.host ignored)', !!sess && sess.session === 'Bridget' && sess.project === 'AIMB' && sess.user === 'robin' && sess.host === 'HOST-A'
    && sess.nodes.has('') && sess.nodes.size === 1 && sess.origin === 'HOST-A' && root(st, S1).kind === 'agent')
  check('apply: a plain message logs to the root without setting the current line', root(st, S1).log.length === 1 && root(st, S1).current === null)
  check('apply: in-memory entry is small (no details/data/path keys; current:false omitted)', J(Object.keys(root(st, S1).log[0])) === J(['id', 'ts', 'text', 'state']))
  check('apply: the returned entry carries identity + path for the JSONL (v2)', r.entry.v === 2 && r.entry.session === 'Bridget' && r.entry.project === 'AIMB' && r.entry.path === '' && r.entry.origin === 'HOST-A'
    && r.entry.host === 'HOST-A' && r.entry.user === 'robin' && r.entry.current === false && r.entry.details === null && r.entry.data === null && !('agent' in r.entry) && !('context' in r.entry))
  const r2 = say(st, S1, { text: 'second' }, T0 + 1)
  check('apply: entry ids unique + ordered', r2.id !== r.id && r2.id > r.id)
  check('apply: session lookup is case-insensitive on session + project + user (+ realm, default "default")', A.getSession(st, { session: 'BRIDGET', project: 'aimb', user: 'ROBIN' }) === sess
    && A.getSession(st, { session: 'Bridget', project: 'AIMB', user: 'robin', realm: 'DEFAULT' }) === sess)
  check('apply: the session key needs the user', A.getSession(st, { session: 'Bridget', project: 'AIMB' }) === null)
  say(st, { session: 'Bridget', project: 'Other' }, { text: 'x' }, T0)
  check('apply: same session name in another project = another session', st.local.size === 2)
  check('apply: missing session name -> bad-session', A.apply(st, { session: '  ' }, M({ text: 'x' }), T0).code === 'bad-session' && A.apply(st, null, M({ text: 'x' }), T0).code === 'bad-session')
  check('apply: not a parsed msg -> bad-message', A.apply(st, S1, { text: 5 }, T0).code === 'bad-message' && A.apply(st, S1, null, T0).code === 'bad-message')
  check('apply: now must be a number -> bad-now', A.apply(st, S1, M({ text: 'x' }), NaN).code === 'bad-now' && A.apply(st, S1, M({ text: 'x' }), undefined).code === 'bad-now')
  check('apply: not a state -> bad-state-object', A.apply({}, S1, M({ text: 'x' }), T0).code === 'bad-state-object')
  const off = mk({ enabled: false })
  check('apply: activity.enabled=false -> activity-disabled, nothing stored', A.apply(off, S1, M({ text: 'x' }), T0).code === 'activity-disabled' && off.local.size === 0)
  const s2 = mk()
  say(s2, { session: 'Nameless' }, { text: 'x' }, T0)
  check('apply: no project -> "unclassified"', A.getSession(s2, { session: 'Nameless' }).project === 'unclassified' && A.getSession(s2, { session: 'nameless', project: '' }) !== null)
})

// ================================================================= 6a: the tree — nodes, kinds, implicit intermediates, first-seen spelling
await section(async () => {
  const st = mk(), I = S1
  const r = say(st, I, { path: '@#70/@step4/spec-70', text: '@Tharsis/@~z12 seeding' }, T0)
  const s = A.getSession(st, I)
  check('tree: a deep path creates every node on it, each with its kind', r.ok && r.path === '@#70/@step4/spec-70/@Tharsis/@z12' && J([...s.nodes.values()].map(n => [n.path, n.kind])) === J([['', 'agent'], ['@#70', 'context'], ['@#70/@step4', 'context'],
    ['@#70/@step4/spec-70', 'agent'], ['@#70/@step4/spec-70/@Tharsis', 'context'], ['@#70/@step4/spec-70/@Tharsis/@z12', 'context']]), J([...s.nodes.values()].map(n => [n.path, n.kind])))
  check('tree: intermediates are IMPLICIT; the target and its owner (the nearest agent) are not; the root is implicit until it reports itself', N(st, I, '@#70').implicit && N(st, I, '@#70/@step4/spec-70/@Tharsis').implicit
    && !N(st, I, '@#70/@step4/spec-70').implicit && !N(st, I, '@#70/@step4/spec-70/@Tharsis/@z12').implicit && root(st, I).implicit)
  check('tree: parent links + children (kids in insertion order)', N(st, I, '@#70/@step4').parent === '@#70' && J(kidPaths(s, '@#70')) === J(['@#70/@step4']) && J(kidPaths(s, '')) === J(['@#70']))
  check('tree: depth = segments below the session', N(st, I, '@#70/@step4/spec-70/@Tharsis/@z12').depth === 5 && root(st, I).depth === 0)
  say(st, I, { path: '@#70/@STEP4/Spec-70/@tharsis/@Z13', text: 'case' }, T0 + 1)
  check('tree: nodes match case-insensitively; a NEW child keeps its parent\'s first-seen spelling', s.nodes.size === 7 && N(st, I, '@#70/@step4/spec-70/@Tharsis/@Z13').path === '@#70/@step4/spec-70/@Tharsis/@Z13')
  say(st, I, { agent: 'spec-70', path: 'research', text: '@~root sub-agent here' }, T0 + 2)
  check('tree: any node may contain either kind (a sub-agent under an agent; an agent under contexts)', N(st, I, 'spec-70/research').kind === 'agent' && N(st, I, 'spec-70').kind === 'agent' && N(st, I, 'spec-70').implicit
    && N(st, I, '@#70/@step4/spec-70').kind === 'agent')
  say(st, I, { text: '@~root orchestrating' }, T0 + 3)
  check('tree: the session reporting itself makes its root non-implicit', !root(st, I).implicit && root(st, I).current.text === 'orchestrating')
  check('getNode: by path (case-insensitive), null/"" = the root, junk = null', N(st, I, 'SPEC-70/RESEARCH') === s.nodes.get('spec-70/research') && N(st, I, null) === s.nodes.get('') && N(st, I, 'a//b') === null && N(st, I, 'nope') === null)
})

// ================================================================= apply: @ vs @~, stickiness, default state, finish
await section(async () => {
  const st = mk(), I = S1, A1 = 'worker'
  const e = () => N(st, I, A1)
  const ctx = n => N(st, I, `${A1}/@${n}`)
  const r1 = say(st, I, { agent: A1, text: '@build compiling', progress: '1/4', eta: '10m', state: 'blocked' }, T0)
  check('@: creates the agent + context; does NOT set the current line', r1.ok && r1.agent === 'worker' && r1.context === 'build' && !r1.current && ctx('build').current === null)
  check('@: progress + eta move the bar (ANY message); state stays in the log entry only (the CONTEXT\'s own log)', J(ctx('build').progress) === J({ done: 1, total: 4, unit: '' }) && ctx('build').eta_at === T0 + 10 * MIN
    && ctx('build').log[0].progress.done === 1 && ctx('build').log[0].eta_at === T0 + 10 * MIN && ctx('build').log[0].state === 'blocked' && A.stateOf(ctx('build')) === 'running' && e().log.length === 0)
  const r2 = say(st, I, { agent: A1, text: '@~build 2 of 4', progress: '2/4 files', eta: '8m' }, T0 + MIN)
  check('@~: sets the current line + progress + eta', r2.current && ctx('build').current.text === '2 of 4' && ctx('build').current.id === r2.id && J(ctx('build').progress) === J({ done: 2, total: 4, unit: 'files' }) && ctx('build').eta_at === T0 + MIN + 8 * MIN)
  check('@~: the default state is running when the node has no current line', r2.state === 'running')
  say(st, I, { agent: A1, text: '@~build still going' }, T0 + 2 * MIN)
  check('@~: progress + eta are STICKY (kept when a later @~ omits them)', ctx('build').current.text === 'still going' && ctx('build').progress.done === 2 && ctx('build').eta_at === T0 + 9 * MIN)
  say(st, I, { agent: A1, text: '@~build waiting on review', state: 'blocked' }, T0 + 3 * MIN)
  const r4 = say(st, I, { agent: A1, text: '@build pinged Robin' }, T0 + 4 * MIN)
  check('default state: an @ entry inherits the node\'s current state', r4.state === 'blocked' && ctx('build').log.at(-1).state === 'blocked')
  const r5 = say(st, I, { agent: A1, text: '@~build new line' }, T0 + 5 * MIN)
  check('default state: an @~ line inherits it too', r5.state === 'blocked' && A.stateOf(ctx('build')) === 'blocked')
  say(st, I, { agent: A1, text: '@build it failed?', state: 'failed' }, T0 + 6 * MIN)
  check('@ with an explicit state does not change the node state', A.stateOf(ctx('build')) === 'blocked')
  check('default state: a new context starts running', say(st, I, { agent: A1, text: '@fresh hi' }, T0 + 6 * MIN).state === 'running')
  say(st, I, { agent: A1, text: '@~build cleared', progress: 'none', eta: 'none', state: 'running' }, T0 + 7 * MIN)
  check('"none" clears progress + eta', ctx('build').progress === null && ctx('build').eta_at === null)
  say(st, I, { agent: A1, text: '@~build again', progress: '3/4', eta: '5m' }, T0 + 8 * MIN)
  say(st, I, { agent: A1, text: '@~build done', state: 'done' }, T0 + 9 * MIN)
  check('@~ done drops the eta but keeps progress', ctx('build').eta_at === null && ctx('build').progress.done === 3)
  check('@~ctx done does NOT finish the agent (contexts never finish)', e().finished_at === null && A.isActive(e()) && ctx('build').finished_at === null)
  say(st, I, { agent: A1, text: 'all done?', state: 'done' }, T0 + 10 * MIN)
  check('a plain message with done (log-only) does NOT finish the agent', e().finished_at === null)
  const rf = say(st, I, { agent: A1, text: '@~root finished', state: 'done' }, T0 + 11 * MIN)
  check('@~root done finishes the agent (finished_at)', e().finished_at === T0 + 11 * MIN && !A.isActive(e()) && A.stateOf(e()) === 'done' && rf.stale_at === null)
  say(st, I, { path: `${A1}/@~root`, text: 'really done', state: 'done' }, T0 + 12 * MIN)
  check('a second done line keeps the first finished_at', e().finished_at === T0 + 11 * MIN)
  say(st, I, { agent: A1, text: 'late note' }, T0 + 13 * MIN)
  check('a later plain message leaves it finished (but counts as activity)', e().finished_at === T0 + 11 * MIN && e().last_activity === T0 + 13 * MIN)
  say(st, I, { agent: A1, text: '@~root back at it', state: 'running' }, T0 + 14 * MIN)
  check('@~root running revives a finished agent', e().finished_at === null && A.isActive(e()))
  say(st, I, { agent: A1, text: '@~root crashed', state: 'failed' }, T0 + 15 * MIN)
  check('@~root failed also finishes', e().finished_at === T0 + 15 * MIN && A.stateOf(e()) === 'failed')
  const st2 = mk()
  say(st2, I, { text: '@~root session done', state: 'done' }, T0)
  check('a session-level @~root done finishes the session\'s root', root(st2, I).finished_at === T0)
  say(st2, I, { agent: 'x', text: '@~root idle', state: 'idle' }, T0)
  check('@~root idle does not finish', N(st2, I, 'x').finished_at === null)
  say(st2, I, { path: 'deep/sub/@~root', text: 'sub done', state: 'done' }, T0 + 1)
  check('6a: a sub-agent\'s own done line finishes IT, not its parent', N(st2, I, 'deep/sub').finished_at === T0 + 1 && N(st2, I, 'deep').finished_at === null)
})

// ================================================================= apply: details/data retention (memory model)
await section(async () => {
  const st = mk(), I = S1
  const b = () => N(st, I, 'w/@build')
  const r1 = say(st, I, { agent: 'w', text: '@~build compiling', details: 'full compiler output', data: { errors: 0 } }, T0)
  const cur = b().current
  check('@~ keeps details + data on the CURRENT line', cur.details === 'full compiler output' && cur.data.errors === 0)
  check('the log entry keeps only flags (no details/data)', b().log[0].has_details === true && b().log[0].has_data === true && !('details' in b().log[0]) && !('data' in b().log[0]))
  check('the returned full entry carries details + data (for the JSONL)', r1.entry.details === 'full compiler output' && r1.entry.data.errors === 0 && r1.entry.current === true)
  const r2 = say(st, I, { agent: 'w', text: '@build side note', details: 'log-only details', data: [1, 2] }, T0 + 1)
  check('@ with details: NOT kept in memory anywhere, only returned', b().current.details === 'full compiler output' && r2.entry.details === 'log-only details'
    && J(r2.entry.data) === J([1, 2]) && b().log[1].has_details && !('details' in b().log[1]))
  say(st, I, { agent: 'w', text: '@~build next step' }, T0 + 2)
  check('a new @~ line REPLACES details/data (never carried forward)', b().current.details === null && b().current.data === null)
  check('no entry anywhere holds details text', !J(b().log).includes('full compiler output') && !J(b().log).includes('log-only details'))
})

// ================================================================= apply: activity + stale_after (target..owner)
await section(async () => {
  const st = mk(), I = S1
  say(st, I, { agent: 'w', text: '@~a start' }, T0)
  say(st, I, { agent: 'w', text: '@b other' }, T0 + 5 * MIN)
  const e = N(st, I, 'w'), a = () => N(st, I, 'w/@a'), b = () => N(st, I, 'w/@b')
  check('last_activity: on the target, its owner agent and the session header', e.last_activity === T0 + 5 * MIN && a().last_activity === T0 && b().last_activity === T0 + 5 * MIN
    && A.getSession(st, I).last_activity === T0 + 5 * MIN)
  check('created times recorded', e.created_at === T0 && b().created_at === T0 + 5 * MIN)
  const r = say(st, I, { agent: 'w', text: '@~a long build', stale_after: '60m' }, T0 + 6 * MIN)
  check('stale_after stored on the context AND its owner agent; stale_at = the owner\'s', a().stale_after_ms === HOUR && e.stale_after_ms === HOUR && r.stale_at === T0 + 6 * MIN + HOUR)
  say(st, I, { agent: 'w', text: '@b meanwhile' }, T0 + 7 * MIN)
  check('the next message clears the agent\'s override, not another context\'s', e.stale_after_ms === null && a().stale_after_ms === HOUR && b().stale_after_ms === null)
  say(st, I, { agent: 'w', text: '@~a build done' }, T0 + 8 * MIN)
  check('the context\'s own next message clears its override', a().stale_after_ms === null)
  say(st, I, { agent: 'w', text: '@a out-of-order report' }, T0)
  check('last_activity never moves backwards (an earlier-timed report is still logged, in time order)', e.last_activity === T0 + 8 * MIN && a().last_activity === T0 + 8 * MIN
    && A.getSession(st, I).last_activity === T0 + 8 * MIN && a().log.some(x => x.ts === T0 && x.text === 'out-of-order report') && a().log[0].ts === T0)
  // 6a: a sub-agent does not refresh its parent agent; a context does refresh its agent; nothing above the owner moves
  const s2 = mk()
  say(s2, I, { path: 'p', text: '@~root parent' }, T0)
  say(s2, I, { path: '@grp/p2', text: 'x' }, T0)
  say(s2, I, { path: 'p/child', text: '@~root child' }, T0 + 10 * MIN)
  say(s2, I, { path: '@grp/p2/@deep/@er', text: 'ctx' }, T0 + 11 * MIN)
  check('6a: a sub-agent\'s message refreshes it only (not its parent agent)', N(s2, I, 'p').last_activity === T0 && N(s2, I, 'p/child').last_activity === T0 + 10 * MIN)
  check('6a: a nested context\'s message refreshes every node up to its agent, and nothing above', N(s2, I, '@grp/p2/@deep').last_activity === T0 + 11 * MIN && N(s2, I, '@grp/p2').last_activity === T0 + 11 * MIN
    && N(s2, I, '@grp').last_activity === T0 && root(s2, I).last_activity === T0)
})

// ================================================================= apply: log cap (per NODE)
await section(async () => {
  const st = mk({ log_entries_per_agent: 10 }), I = S1
  for (let i = 1; i <= 12; i++) say(st, I, { agent: 'w', text: `m${i}` }, T0 + i)
  const e = N(st, I, 'w')
  check('log cap: holds log_entries_per_agent (oldest dropped first) + the floor = the newest dropped', e.log.length === 10 && e.log[0].text === 'm3' && e.log[9].text === 'm12' && e.log_dropped === 2 && e.log_floor === T0 + 2)
  for (let i = 1; i <= 11; i++) say(st, I, { text: `s${i}` }, T0 + i)
  check('log cap: applies to the session root too', root(st, I).log.length === 10 && root(st, I).log_dropped === 1)
  for (let i = 1; i <= 12; i++) say(st, I, { agent: 'w', text: `@c ctx ${i}` }, T0 + 100 + i)
  check('log cap (6a): every node keeps its OWN log — a context\'s entries do not push out its agent\'s', N(st, I, 'w/@c').log.length === 10 && e.log.length === 10 && e.log[0].text === 'm3')
  say(st, I, { agent: 'w', text: '@~cur keep me' }, T0 + 100)
  for (let i = 0; i < 20; i++) say(st, I, { agent: 'w', text: `@cur flood ${i}` }, T0 + 200 + i)
  check('log cap: dropping entries never touches a current line', N(st, I, 'w/@cur').current.text === 'keep me')
})

// ================================================================= 6a: limits — depth, agents, nodes, eviction (subtree-wise)
await section(async () => {
  const st = mk(), I = S1
  check('limits: depth 6 accepted, 7 rejected', say(st, I, { path: 'a/b/@c/@d/e/@f', text: 'deep' }, T0).ok && P({ path: 'a/b/@c/@d/e/@f/g', text: 'x' }).code === 'path-too-deep')
  // agents: 128 (the root not counted; implicit agents count)
  const s2 = mk()
  let ok = true
  for (let i = 1; i <= 128; i++) ok = say(s2, I, { agent: `a${i}`, text: 'hi' }, T0 + i).ok && ok
  const sess = A.getSession(s2, I)
  check('agents: 128 accepted', ok && agentCount(sess) === 128 && sess.nAgents === 128)
  check('agents: session-level messages + contexts do not count as agents', say(s2, I, { text: '@ctx orchestrator here' }, T0 + 200).ok && agentCount(sess) === 128)
  const r = say(s2, I, { agent: 'a129', text: 'hi' }, T0 + 300)
  check('agents: the 129th with none finished -> too-many-agents, nothing created', !r.ok && r.code === 'too-many-agents' && agentCount(sess) === 128 && !N(s2, I, 'a129'))
  check('agents: an implicit agent counts too (x/y needs TWO agent slots)', say(s2, I, { path: 'x/y', text: 'hi' }, T0 + 301).code === 'too-many-agents' && !N(s2, I, 'x'))
  check('agents: existing agents still accepted at the limit (and their contexts)', say(s2, I, { agent: 'a1', text: '@~more still here' }, T0 + 302).ok)
  say(s2, I, { agent: 'a50', text: '@~root done', state: 'done' }, T0 + 400)
  say(s2, I, { agent: 'a7', text: '@~root failed', state: 'failed' }, T0 + 500)
  const r2 = say(s2, I, { agent: 'a129', text: 'hi' }, T0 + 600)
  check('agents: at the limit, the oldest FINISHED agent is evicted to make room', r2.ok && J(r2.evicted) === J(['a50']) && agentCount(sess) === 128 && !N(s2, I, 'a50') && !!N(s2, I, 'a7') && !!N(s2, I, 'a129'))
  check('agents: then the next oldest finished', (x => x.ok && J(x.evicted) === J(['a7']))(say(s2, I, { agent: 'a130', text: 'hi' }, T0 + 700)))
  check('agents: then rejected again', say(s2, I, { agent: 'a131', text: 'hi' }, T0 + 800).code === 'too-many-agents')
  // eviction is SUBTREE-wise and never an ancestor of the target
  const s3 = mk()
  for (let i = 1; i <= 126; i++) say(s3, I, { agent: `a${i}`, text: 'hi' }, T0)
  say(s3, I, { path: 'boss/@notes', text: 'boss notes' }, T0)
  say(s3, I, { path: 'boss/helper/@ctx', text: 'helper' }, T0)   // 128 agents: a1..a126 + boss + boss/helper
  say(s3, I, { path: 'boss/@~root', text: 'boss done', state: 'done' }, T0 + 1)
  const s3s = A.getSession(s3, I)
  const before = s3s.nodes.size
  const rb = say(s3, I, { path: 'newbie', text: 'hi' }, T0 + 2)
  check('eviction: evicting a finished agent removes its WHOLE subtree (its contexts and a running sub-agent)', rb.ok && J(rb.evicted) === J(['boss']) && !N(s3, I, 'boss') && !N(s3, I, 'boss/helper') && !N(s3, I, 'boss/@notes')
    && !N(s3, I, 'boss/helper/@ctx') && s3s.nodes.size === before - 4 + 1 && agentCount(s3s) === 127, J([rb, before, s3s.nodes.size]))
  const s4 = mk()
  for (let i = 1; i <= 127; i++) say(s4, I, { agent: `a${i}`, text: 'hi' }, T0)
  say(s4, I, { path: 'old/@~root', text: 'old done', state: 'done' }, T0 + 1)   // 128, 'old' finished and the only candidate
  const ra = say(s4, I, { path: 'old/kid', text: 'a new kid of a finished agent' }, T0 + 2)
  check('eviction: never an ANCESTOR of the target (rejected instead)', ra.code === 'too-many-agents' && !!N(s4, I, 'old'))
  check('eviction: a log:false message may not evict (an eviction must reach the JSONL)', say(s4, I, { path: 'other', text: 'x', log: false }, T0 + 3).code === 'too-many-agents' && !!N(s4, I, 'old'))
  // the node budget: 4096 (any kind)
  const s5 = mk(), I5 = { session: 'Budget', project: 'P', user: 'u' }
  let okN = true
  for (let i = 0; i < 4096; i++) okN = say(s5, I5, { path: `@c${i}`, text: 'x', log: false }, T0).ok && okN
  const s5s = A.getSession(s5, I5)
  check('nodes: 4096 accepted (the root not counted)', okN && nonRoot(s5s) === 4096)
  check('nodes: the 4097th -> too-many-nodes (no finished agent to evict)', say(s5, I5, { path: '@one-more', text: 'x' }, T0 + 1).code === 'too-many-nodes' && nonRoot(s5s) === 4096)
  const s6 = mk(), I6 = { session: 'Budget2', project: 'P', user: 'u' }
  say(s6, I6, { path: 'fin/@a', text: 'x' }, T0); say(s6, I6, { path: 'fin/@b', text: 'x' }, T0); say(s6, I6, { path: 'fin/@~root', text: 'done', state: 'done' }, T0 + 1)
  for (let i = 0; i < 4093; i++) say(s6, I6, { path: `@c${i}`, text: 'x', log: false }, T0 + 2)
  const rn = say(s6, I6, { path: '@x/@y', text: 'two new nodes' }, T0 + 3)
  check('nodes: at 4096 a message needing room evicts the oldest finished agent with its subtree (3 nodes)', rn.ok && J(rn.evicted) === J(['fin']) && nonRoot(A.getSession(s6, I6)) === 4096 - 3 + 2, J([rn.code, rn.evicted, nonRoot(A.getSession(s6, I6))]))
  const s7 = mk()
  for (let i = 1; i <= 128; i++) say(s7, { session: 'other', project: 'AIMB' }, { agent: `a${i}`, text: 'hi' }, T0)
  check('limits are per session', say(s7, I, { agent: 'a1', text: 'hi' }, T0).ok)
})

// ================================================================= apply: gone
await section(async () => {
  const st = mk(), I = S1
  say(st, I, { agent: 'spec-70/research/deep', text: '@~root digging' }, T0)
  say(st, I, { agent: 'spec-70', text: 'parent reports too' }, T0 + 2)
  const rs = say(st, I, { text: '@~root orchestrating', state: 'running' }, T0 + 3)
  check('session-level: no agent -> the root node, same model', rs.ok && rs.agent === null && root(st, I).current.text === 'orchestrating')
  check('gone: unknown session -> false', A.markSessionGone(st, { session: 'nobody', project: 'AIMB' }, T0) === false)
  say(st, I, { agent: 'finisher', text: '@~root done', state: 'done' }, T0 + 4)
  say(st, I, { agent: 'idler', text: '@~root waiting', state: 'idle' }, T0 + 4)
  say(st, I, { agent: 'idler', text: '@~ctx busy' }, T0 + 4)
  check('gone: markSessionGone', A.markSessionGone(st, I, T0 + 10 * MIN) === true && A.getSession(st, I).gone_at === T0 + 10 * MIN)
  const E = p => N(st, I, p)
  check('gone: an unfinished agent shows gone (outranks stale) — every agent node, sub-agents included', A.effectiveState(E('spec-70'), T0 + 5 * HOUR, 15).state === 'gone' && A.effectiveState(E('spec-70/research/deep'), T0 + 5 * HOUR, 15).gone)
  check('gone: idle shows gone too; done stays done', A.effectiveState(E('idler'), T0 + 11 * MIN, 15).state === 'gone' && A.effectiveState(E('finisher'), T0 + 11 * MIN, 15).state === 'done')
  check('gone: a CONTEXT shows its agent\'s gone (it has no gone of its own); the root shows gone', A.effectiveState(E('idler/@ctx'), T0 + 11 * MIN, 15, E('idler')).state === 'gone' && E('idler/@ctx').gone_at === null
    && A.effectiveState(root(st, I), T0 + 11 * MIN, 15).state === 'gone')
  check('gone: gone agents are not active', !A.isActive(E('spec-70')))
  say(st, I, { agent: 'spec-70', text: 'back!' }, T0 + 20 * MIN)
  check('gone: a message clears it for the session + that message\'s owner', A.getSession(st, I).gone_at === null && E('spec-70').gone_at === null && E('idler').gone_at === T0 + 10 * MIN && E('spec-70/research/deep').gone_at === T0 + 10 * MIN)
  A.markSessionGone(st, I, null)
  check('gone: markSessionGone(null) clears everything', E('idler').gone_at === null && root(st, I).gone_at === null)
})

// ================================================================= views: stale (agents) + 6a: contexts inherit from their nearest agent
await section(async () => {
  const st = mk(), I = S1
  say(st, I, { agent: 'r', text: '@~root working' }, T0)
  const e = N(st, I, 'r')
  check('stale: staleAt = last activity + staleMin', A.staleAt(e, 15) === T0 + 15 * MIN && A.staleAt(e, 5) === T0 + 5 * MIN)
  check('stale: at exactly the threshold it is NOT stale (quiet for LONGER than)', A.effectiveState(e, T0 + 15 * MIN, 15).state === 'running')
  const es = A.effectiveState(e, T0 + 15 * MIN + 1, 15)
  check('stale: one ms past -> stale, was running', es.state === 'stale' && es.stale && es.was === 'running' && es.stale_at === T0 + 15 * MIN)
  check('stale: the viewer\'s threshold is a parameter', A.effectiveState(e, T0 + 10 * MIN, 5).state === 'stale' && A.effectiveState(e, T0 + 10 * MIN, 30).state === 'running')
  check('stale: a bogus threshold falls back to the default 15', A.staleAt(e, 0) === T0 + 15 * MIN && A.staleAt(e, NaN) === T0 + 15 * MIN)
  say(st, I, { agent: 'b', text: '@~root waiting', state: 'blocked' }, T0)
  check('stale: blocked goes stale, was blocked', (x => x.state === 'stale' && x.was === 'blocked')(A.effectiveState(N(st, I, 'b'), T0 + HOUR, 15)))
  for (const s of ['done', 'failed', 'idle']) {
    say(st, I, { agent: `n-${s}`, text: '@~root x', state: s }, T0)
    const x = A.effectiveState(N(st, I, `n-${s}`), T0 + 48 * HOUR, 15)
    check(`stale: ${s} never goes stale`, x.state === s && !x.stale && x.stale_at === null && A.staleAt(N(st, I, `n-${s}`), 15) === null)
  }
  say(st, I, { agent: 'q', text: 'just logging, no current line' }, T0)
  check('stale: an agent with no current line counts as running (and can go stale)', A.effectiveState(N(st, I, 'q'), T0 + 16 * MIN, 15).state === 'stale')
  say(st, I, { path: 'imp/kid', text: '@~root only the kid reports' }, T0)
  check('stale (6a): an IMPLICIT agent (never reported) never goes stale', A.staleAt(N(st, I, 'imp'), 15) === null && A.effectiveState(N(st, I, 'imp'), T0 + 5 * HOUR, 15).state === 'running'
    && A.effectiveState(N(st, I, 'imp/kid'), T0 + 5 * HOUR, 15).state === 'stale')
  say(st, I, { agent: 'o', text: '@~root big download', stale_after: '60m' }, T0)
  const o = N(st, I, 'o')
  check('stale_after: the override beats the viewer threshold', A.effectiveState(o, T0 + 30 * MIN, 15).state === 'running' && A.effectiveState(o, T0 + 61 * MIN, 15).state === 'stale' && A.staleAt(o, 15) === T0 + HOUR)
  say(st, I, { agent: 'o', text: '@~root download finished, unpacking' }, T0 + 61 * MIN)
  check('stale_after: gone after the next message (back to the default)', A.staleAt(o, 15) === T0 + 61 * MIN + 15 * MIN)
  // 6a: contexts take their staleness from the nearest agent ancestor
  say(st, I, { agent: 'm', text: '@~tiles strip 1' }, T0)
  say(st, I, { agent: 'm', text: '@~root overall fine' }, T0 + 20 * MIN)
  const m = N(st, I, 'm'), tiles = N(st, I, 'm/@tiles')
  check('stale (6a): a context does NOT go stale by its own quiet — its agent is fresh, so it is fresh', A.effectiveState(tiles, T0 + 21 * MIN, 15, m).state === 'running' && A.staleAt(tiles, 15, m) === T0 + 35 * MIN)
  check('stale (6a): ... and goes stale exactly when its agent does (was = its own state)', A.effectiveState(tiles, T0 + 36 * MIN, 15, m).state === 'stale' && A.effectiveState(m, T0 + 36 * MIN, 15).state === 'stale' && A.effectiveState(tiles, T0 + 36 * MIN, 15, m).was === 'running')
  say(st, I, { agent: 'm', text: '@~blocked waiting', state: 'blocked' }, T0 + 20 * MIN)
  say(st, I, { agent: 'm', text: '@~fin all good', state: 'done' }, T0 + 20 * MIN)
  say(st, I, { agent: 'm', text: '@nolinectx just a log' }, T0 + 20 * MIN)
  check('stale (6a): a done context under a stale agent stays done; a blocked one shows stale (was blocked)', A.effectiveState(N(st, I, 'm/@fin'), T0 + 5 * HOUR, 15, m).state === 'done'
    && (x => x.state === 'stale' && x.was === 'blocked')(A.effectiveState(N(st, I, 'm/@blocked'), T0 + 5 * HOUR, 15, m)))
  check('stale (6a): a context with no current line (a grouping node) never shows stale', A.staleAt(N(st, I, 'm/@nolinectx'), 15, m) === null && A.effectiveState(N(st, I, 'm/@nolinectx'), T0 + 5 * HOUR, 15, m).state === 'running')
  say(st, I, { agent: 'm', text: '@~root all done', state: 'done' }, T0 + 22 * MIN)
  check('stale: contexts under a FINISHED agent never go stale', A.effectiveState(tiles, T0 + 5 * HOUR, 15, m).state === 'running' && A.staleAt(tiles, 15, m) === null)
  // contexts directly under the session inherit the SESSION's (root's) staleness
  const s2 = mk()
  say(s2, I, { text: '@~#70 planning step 4' }, T0)
  say(s2, I, { path: '@#70/spec-70', text: '@~root busy agent' }, T0 + 30 * MIN)
  const r2 = root(s2, I), c70 = N(s2, I, '@#70')
  check('stale (6a): a context directly under the session follows the SESSION\'s own reports (an agent under it does not refresh it)', A.effectiveState(c70, T0 + 16 * MIN, 15, r2).state === 'stale'
    && A.effectiveState(N(s2, I, '@#70/spec-70'), T0 + 40 * MIN, 15).state === 'running')
  say(s2, I, { text: '@#70/@step4 note under the session' }, T0 + 31 * MIN)
  check('stale (6a): ... and any session-owned message (at any depth below it, not crossing an agent) refreshes it', A.effectiveState(c70, T0 + 40 * MIN, 15, r2).state === 'running')
  check('stateOf: node / nothing', A.stateOf(tiles) === 'running' && A.stateOf(m) === 'done' && A.stateOf(null) === 'running')
  check('apply returns stale_at for the message\'s target (a context: its agent\'s)', say(st, I, { agent: 'z', text: '@~ctx x', stale_after: '2h' }, T0).stale_at === T0 + 2 * HOUR)
})

// ================================================================= views: rollup (6a: recursive)
await section(async () => {
  const st = mk(), I = S1
  const s = () => A.getSession(st, I)
  const R = p => A.rollup(s(), N(st, I, p))
  say(st, I, { agent: 'none', text: '@~a x' }, T0)
  check('rollup: nothing has progress -> null', R('none') === null && A.rollup(null, null) === null)
  say(st, I, { agent: 'sum', text: '@~s1 x', progress: '10/100 tiles' }, T0)
  say(st, I, { agent: 'sum', text: '@~s2 x', progress: '30/100 Tiles' }, T0)
  const rs = R('sum')
  check('rollup: children sharing a unit (case-insensitive) are SUMMED', rs.done === 40 && rs.total === 200 && rs.pct === 20 && rs.rollup === true && rs.n === 2 && rs.unit === 'tiles', J(rs))
  say(st, I, { agent: 'mix', text: '@~a x', progress: '1/2 files' }, T0)
  say(st, I, { agent: 'mix', text: '@~b x', progress: '25/100 tiles' }, T0)
  const rm = R('mix')
  check('rollup: mixed units -> the mean percent, labelled a rollup', rm.done === 37.5 && rm.total === 100 && rm.unit === '%' && rm.rollup && rm.n === 2, J(rm))
  say(st, I, { agent: 'pct', text: '@~a x', progress: '20%' }, T0)
  say(st, I, { agent: 'pct', text: '@~b x', progress: '61%' }, T0)
  check('rollup: percent children -> mean %', (r => r.done === 40.5 && r.unit === '%' && r.rollup)(R('pct')))
  say(st, I, { agent: 'bare', text: '@~a x', progress: '3/6' }, T0)
  say(st, I, { agent: 'bare', text: '@~b x', progress: '1/4' }, T0)
  check('rollup: unit-less children share the "" unit and sum', (r => r.done === 4 && r.total === 10 && r.unit === '' && r.rollup)(R('bare')))
  say(st, I, { agent: 'sum', text: '@~root overall', progress: '7/10 strips' }, T0)
  const rr = R('sum')
  check('rollup: a REPORTED progress wins (not a rollup)', rr.done === 7 && rr.total === 10 && rr.unit === 'strips' && rr.rollup === false && rr.pct === 70)
  say(st, I, { agent: 'logonly', text: '@a x', progress: '5/10' }, T0)
  check('rollup: progress on a plain (log-only) message counts too', (r => r && r.done === 5 && r.total === 10 && r.rollup)(R('logonly')))
  say(st, I, { agent: 'one', text: '@~a x', progress: '5/10 files' }, T0)
  check('rollup: a single child still rolls up (labelled)', (r => r.done === 5 && r.rollup && r.n === 1)(R('one')))
  say(st, I, { text: '@~phase1 x', progress: '1/2' }, T0)
  check('rollup: works for the session root (over its top-level nodes)', (r => r && r.rollup)(A.rollup(s(), root(st, I))))
  // 6a: recursion through any depth, agents and contexts alike
  const t = mk(), T = { session: 'Tree', project: 'P', user: 'u' }
  say(t, T, { path: '@#70/@step4/spec-70/@Tharsis/@z11', text: 'x', progress: '5/10 tiles' }, T0)
  say(t, T, { path: '@#70/@step4/spec-70/@Tharsis/@z12', text: 'x', progress: '3/10 tiles' }, T0)
  say(t, T, { path: '@#70/@step4/other/@q', text: 'x', progress: '2/10 tiles' }, T0)
  const ts = A.getSession(t, T), TR = p => A.rollup(ts, N(t, T, p))
  check('rollup (6a): recursive — a context sums its children, an agent its contexts, a grouping context its agents, up to the session', (TR('@#70/@step4/spec-70/@Tharsis').done === 8 && TR('@#70/@step4/spec-70').done === 8
    && TR('@#70/@step4').done === 10 && TR('@#70/@step4').total === 30 && TR('@#70').done === 10 && A.rollup(ts, root(t, T)).done === 10 && TR('@#70').n === 1 && TR('@#70/@step4').n === 2), J([TR('@#70/@step4'), TR('@#70')]))
  say(t, T, { path: '@#70/@step4/other', text: 'own bar', progress: '50%' }, T0)
  check('rollup (6a): a reported bar in the middle stops the recursion there; mixed units above → the mean %', TR('@#70/@step4/other').done === 50 && TR('@#70/@step4/other').rollup === false
    && (r => r.unit === '%' && r.done === 45 && r.n === 2)(TR('@#70/@step4')), J(TR('@#70/@step4')))
  const memo = new Map()
  A.rollup(ts, root(t, T), memo)
  check('rollup: a memo caches every node it visited (one board walk; nothing below a reported bar)', memo.has('') && memo.size === ts.nodes.size - 1 && !memo.has('@#70/@step4/other/@q'))
})

// ================================================================= views: isActive / visible / expire (subtrees)
await section(async () => {
  const st = mk(), I = S1
  say(st, I, { agent: 'live', text: 'x' }, T0)
  say(st, I, { agent: 'fin', text: '@~root done', state: 'done' }, T0)
  say(st, I, { path: 'fin/@notes', text: 'note' }, T0)
  say(st, I, { path: 'fin/kid', text: 'a running kid' }, T0)
  const L = N(st, I, 'live'), F = N(st, I, 'fin')
  check('isActive: live yes, finished no', A.isActive(L) && !A.isActive(F) && !A.isActive(null))
  check('visible: an unfinished agent is always visible', A.visible(L, T0 + 1000 * HOUR, 24))
  check('visible: finished stays visible for finished_visible_hours', A.visible(F, T0 + 23 * HOUR, 24) && !A.visible(F, T0 + 24 * HOUR, 24) && !A.visible(F, T0 + 25 * HOUR, 24))
  check('visible: hours = 0 hides a finished agent at once', !A.visible(F, T0, 0) && A.visible(L, T0, 0))
  check('visible: a gone agent uses the same window', A.visible({ gone_at: T0 }, T0 + HOUR, 24) && !A.visible({ gone_at: T0 }, T0 + 25 * HOUR, 24) && !A.visible(null, T0, 24))
  const removed = A.expire(st, T0 + 25 * HOUR)
  check('expire: removes finished agents past the window WITH their subtree; keeps live ones', J(removed) === J([{ session: 'Bridget', project: 'AIMB', agent: 'fin' }]) && !N(st, I, 'fin') && !N(st, I, 'fin/@notes') && !N(st, I, 'fin/kid') && N(st, I, 'live') !== null, J(removed))
  const I2 = { session: 'Leaver', project: 'AIMB' }
  say(st, I2, { agent: 'x', text: 'hi' }, T0)
  A.markSessionGone(st, I2, T0 + HOUR)
  check('expire: a gone session stays within the window', A.expire(st, T0 + 2 * HOUR).length === 0 && A.getSession(st, I2) !== null)
  const rem2 = A.expire(st, T0 + 26 * HOUR)
  check('expire: a gone session past the window is removed whole', rem2.some(r => r.session === 'Leaver' && r.agent === null) && A.getSession(st, I2) === null && A.getSession(st, I) !== null)
  const st3 = mk({ finished_visible_hours: 1 })
  say(st3, I, { agent: 'f', text: '@~root done', state: 'done' }, T0)
  check('expire: honours config.finished_visible_hours', A.expire(st3, T0 + 30 * MIN).length === 0 && A.expire(st3, T0 + 61 * MIN).length === 1)
})

// ================================================================= gossip: snapshot (v2: one record per node)
await section(async () => {
  const st = mk({}, 'HOST-A'), I = S1
  say(st, I, { agent: 'w', text: '@~build compiling', progress: '2/4 files', eta: '10m', details: 'SECRET-DETAILS-TEXT', data: { marker: 'SECRET-DATA-VALUE' } }, T0)
  say(st, I, { agent: 'w', text: 'LOG-ONLY-ENTRY-TEXT' }, T0 + 1)
  const snap = A.snapshot(st), js = J(snap)
  check('snapshot: shape { v:2, origin, sessions:[{ …, nodes:[…] }] }', snap.v === 2 && snap.origin === 'HOST-A' && snap.sessions.length === 1 && Array.isArray(snap.sessions[0].nodes) && !('agents' in snap.sessions[0]) && !('self' in snap.sessions[0]))
  check('snapshot: NO details / data / log entries', !js.includes('SECRET-DETAILS-TEXT') && !js.includes('SECRET-DATA-VALUE') && !js.includes('LOG-ONLY-ENTRY-TEXT') && !js.includes('"log"') && !js.includes('"details"') && !js.includes('"data"'))
  const c = snap.sessions[0].nodes.find(x => x.path === 'w/@build')
  check('snapshot: a node carries its current line (has_details/has_data flags) + progress + eta', c.current.text === 'compiling' && c.current.has_details === true && c.current.has_data === true
    && J(c.progress) === J({ done: 2, total: 4, unit: 'files' }) && c.eta_at === T0 + 10 * MIN)
  check('snapshot: the root is the node with path ""; null/false fields omitted (compact)', snap.sessions[0].nodes[0].path === '' && !('finished_at' in snap.sessions[0].nodes[1]) && !('gone_at' in snap.sessions[0]) && !('implicit' in c))
  check('snapshot: serialises identically twice', J(A.snapshot(st)) === js)
  const build = order => {
    const s = mk({}, 'H')
    const steps = {
      a: () => { say(s, { session: 'zeta', project: 'P' }, { agent: 'b', text: '@z x' }, T0 + 1); say(s, { session: 'zeta', project: 'P' }, { agent: 'b', text: '@a x' }, T0 + 2) },
      b: () => say(s, { session: 'alpha', project: 'P' }, { agent: 'y', text: '@q x', progress: '1/2' }, T0 + 3),
      c: () => say(s, { session: 'alpha', project: 'P' }, { agent: 'x', text: '@m x' }, T0 + 3),
      d: () => say(s, { session: 'mid', project: 'Q' }, { text: '@k x' }, T0 + 5),
    }
    for (const k of order) steps[k]()
    return J(A.snapshot(s))
  }
  const o1 = build(['a', 'b', 'c', 'd']), o2 = build(['d', 'c', 'b', 'a']), o3 = build(['c', 'a', 'd', 'b'])
  check('snapshot: deterministic across insertion orders (key-sorted)', o1 === o2 && o2 === o3, `${o1}\n${o2}`)
  const parsed = JSON.parse(o1)
  check('snapshot: nodes sorted by key (root first)', J(parsed.sessions.find(s => s.session === 'alpha').nodes.map(n => n.path)) === J(['', 'x', 'x/@m', 'y', 'y/@q'])
    && J(parsed.sessions.find(s => s.session === 'zeta').nodes.map(n => n.path)) === J(['', 'b', 'b/@a', 'b/@z']))
  check('snapshot: session order is by (project, session) key', J(parsed.sessions.map(s => s.session)) === J(['alpha', 'zeta', 'mid']))
  check('snapshot: sessionFilter', A.snapshot(st, s => s.session !== 'Bridget').sessions.length === 0 && A.snapshot(st, () => true).sessions.length === 1)
  check('snapshot: an unknown origin -> empty slice', A.snapshot(st, undefined, 'NOPE').sessions.length === 0)
  const before = J(A.snapshot(st))
  const sn = A.snapshot(st); sn.sessions[0].nodes.find(x => x.progress).progress.done = 999
  check('snapshot: returns copies (mutating it does not touch the state)', J(A.snapshot(st)) === before)
})

// ================================================================= gossip: mergeSnapshot
await section(async () => {
  const hostB = mk({}, 'HOST-B'), hostC = mk({}, 'HOST-C'), here = mk({}, 'HOST-A')
  say(hostB, { session: 'Mac', project: 'AIMB' }, { agent: 'w', text: '@~root on B', progress: '1/3 steps' }, T0)
  say(hostB, { session: 'Two', project: 'AIMB' }, { text: '@~root second B session' }, T0)
  say(hostC, { session: 'Linux', project: 'X' }, { text: '@~root on C', state: 'blocked' }, T0)
  say(here, S1, { text: '@~root local' }, T0)
  const localBefore = J(A.snapshot(here))
  const snapB = A.snapshot(hostB), snapC = A.snapshot(hostC)
  const m1 = A.mergeSnapshot(here, 'HOST-B', snapB)
  check('merge: folds a remote slice in', m1.ok && m1.changed && m1.sessions === 2 && A.getSession(here, { session: 'Mac', project: 'AIMB' }, 'HOST-B') !== null)
  check('merge: remote sessions are not local', A.getSession(here, { session: 'Mac', project: 'AIMB' }) === null)
  const m2 = A.mergeSnapshot(here, 'HOST-B', JSON.parse(J(snapB)))
  check('merge: idempotent (same slice again -> changed:false)', m2.ok && m2.changed === false)
  check('merge: round-trips exactly (re-snapshot of the held slice === the origin\'s snapshot)', J(A.snapshot(here, undefined, 'HOST-B')) === J(snapB))
  A.mergeSnapshot(here, 'HOST-C', snapC)
  check('merge: two origins held side by side', here.remote.size === 2 && A.getSession(here, { session: 'Linux', project: 'X' }, 'HOST-C') !== null)
  hostB.local.delete(A.sessionKey({ project: 'AIMB', session: 'Two', host: 'HOST-B' }))
  say(hostB, { session: 'Mac', project: 'AIMB' }, { agent: 'w', text: '@~root B moved on' }, T0 + MIN)
  const m3 = A.mergeSnapshot(here, 'HOST-B', A.snapshot(hostB))
  check('merge: a new slice REPLACES the origin\'s old one (dropped session gone)', m3.changed && A.getSession(here, { session: 'Two', project: 'AIMB' }, 'HOST-B') === null
    && N(here, { session: 'Mac', project: 'AIMB' }, 'w', 'HOST-B').current.text === 'B moved on')
  check('merge: other origins untouched', J(A.snapshot(here, undefined, 'HOST-C')) === J(snapC))
  check('merge: our own local slice untouched', J(A.snapshot(here)) === localBefore)
  check('merge: our own origin is refused', A.mergeSnapshot(here, 'HOST-A', snapB).code === 'own-origin' && J(A.snapshot(here)) === localBefore)
  A.mergeSnapshot(here, 'HOST-D', { ...snapC, origin: 'HOST-C' })
  check('merge: ownership comes from the link (fromOrigin), not the snapshot\'s origin field', here.remote.has('HOST-D') && J(A.snapshot(here, undefined, 'HOST-C')) === J(snapC)
    && A.getSession(here, { session: 'Linux', project: 'X' }, 'HOST-D').origin === 'HOST-D')
  check('merge: bad origin / bad snapshot rejected', A.mergeSnapshot(here, '', snapB).code === 'bad-origin' && A.mergeSnapshot(here, 'HOST-E', null).code === 'bad-snapshot' && A.mergeSnapshot(here, 'HOST-E', { v: 2, sessions: 'x' }).code === 'bad-snapshot' && !here.remote.has('HOST-E'))
  check('merge (6a): a v1 (1.61) snapshot is refused bad-version, nothing held', A.mergeSnapshot(here, 'HOST-E', { v: 1, origin: 'HOST-E', sessions: [{ session: 'Old', project: 'P', self: {}, agents: [{ path: 'a' }] }] }).code === 'bad-version' && !here.remote.has('HOST-E'))
  const empty = A.mergeSnapshot(here, 'HOST-D', { v: 2, origin: 'HOST-D', sessions: [] })
  check('merge: an empty slice clears that origin\'s sessions', empty.changed && A.getSession(here, { session: 'Linux', project: 'X' }, 'HOST-D') === null)
  check('dropOrigin: forgets a host; false when unknown', A.dropOrigin(here, 'HOST-D') === true && !here.remote.has('HOST-D') && A.dropOrigin(here, 'HOST-D') === false && here.remote.has('HOST-C'))
  const lin = root(here, { session: 'Linux', project: 'X' }, 'HOST-C')
  const mac = A.getSession(here, { session: 'Mac', project: 'AIMB' }, 'HOST-B')
  check('merge: derived views work on remote nodes', A.effectiveState(lin, T0 + HOUR, 15).state === 'stale' && A.effectiveState(lin, T0 + HOUR, 15).was === 'blocked'
    && (r => r.done === 1 && r.total === 3 && r.rollup === false)(A.rollup(mac, N(here, { session: 'Mac', project: 'AIMB' }, 'w', 'HOST-B'))))
  const all = A.allSessions(here)
  check('allSessions: local first, then origins sorted', all.length === 3 && all[0].origin === 'HOST-A' && all[1].origin === 'HOST-B' && all[2].origin === 'HOST-C')
  // defensive normalisation of a hostile/junk slice
  const junk = { v: 2, origin: 'EVIL', sessions: [
    null, 'x', { project: 'no-session-name' },
    { session: 'Big', project: 'P', nodes: Array.from({ length: 200 }, (_, i) => ({ path: `a${i}`, created_at: T0, last_activity: T0, current: { id: 'i', ts: T0, text: rep('t', 500), state: 'weird', details: 'LEAKED-DETAILS', data: { leak: 1 } } })) },
    { session: 'Paths', project: 'P', nodes: [{ path: 'a/b/c/d/e/f/g' }, { path: 'has space' }, { path: 'ok' }, { path: 'OK' }, { path: 'x/@~y' }, { path: 5 }] },
    { session: 'Ctx', project: 'P', nodes: [...Array.from({ length: 5000 }, (_, i) => ({ path: `@c${i}`, progress: '5/0', stale_after_ms: 99 * HOUR }))] },
  ] }
  const mj = A.mergeSnapshot(here, 'EVIL', junk)
  const big = A.getSession(here, { session: 'Big', project: 'P' }, 'EVIL')
  const a0 = big.nodes.get('a0').current
  check('merge (defensive): junk sessions skipped', mj.ok && mj.sessions === 3)
  check('merge (defensive): agents capped at 128', agentCount(big) === 128)
  check('merge (defensive): text truncated to 240, bad state -> running, details/data never kept', Array.from(a0.text).length === 240 && a0.state === 'running' && !('details' in a0) && !('data' in a0) && !J(A.snapshot(here, undefined, 'EVIL')).includes('LEAKED-DETAILS'))
  check('merge (defensive): invalid / too-deep / @~ paths dropped, duplicates collapsed, a root added', J([...A.getSession(here, { session: 'Paths', project: 'P' }, 'EVIL').nodes.values()].map(a => a.path)) === J(['ok', '']))
  const many = A.getSession(here, { session: 'Ctx', project: 'P' }, 'EVIL')
  check('merge (defensive): nodes capped at 4096; bad progress dropped; stale_after capped', nonRoot(many) === 4096 && many.nodes.has('') && [...many.nodes.values()].every(c => c.progress === null) && many.nodes.get('@c0').stale_after_ms === 24 * HOUR)
  const again = A.mergeSnapshot(here, 'EVIL', A.snapshot(here, undefined, 'EVIL'))
  check('merge (defensive): its canonical form is stable (re-merge -> unchanged)', again.ok && again.changed === false)
})

// ================================================================= memory budget
await section(async () => {
  const st = mk(), I = S1
  const b0 = A.estimateBytes(st)
  say(st, I, { agent: 'w', text: 'hello' }, T0)
  const b1 = A.estimateBytes(st)
  say(st, I, { agent: 'w', text: '@~root with details', details: rep('d', 4000), data: { s: rep('z', 8000) } }, T0 + 1)
  const b2 = A.estimateBytes(st)
  check('estimateBytes: grows with state; details/data on current lines are counted', b1 > b0 && b2 - b1 > 2 * (4000 + 8000))
  say(st, I, { agent: 'w', text: '@~root replaced' }, T0 + 2)
  check('estimateBytes: shrinks when a current line drops its details/data', A.estimateBytes(st) < b2 - 20000)
  const nothing = A.enforceBudget(st, 10 * 1024 * 1024)
  check('enforceBudget: under budget -> nothing evicted', nothing.evicted.length === 0 && nothing.entries_dropped === 0 && !nothing.over && nothing.bytes_after === nothing.bytes_before)
  check('enforceBudget: the default budget is config.memory_budget_mb', A.enforceBudget(st).evicted.length === 0)
  const s2 = mk()
  for (const [p, t] of [['f-new', 3], ['f-old', 1], ['f-mid', 2]]) {
    for (let i = 0; i < 5; i++) say(s2, I, { agent: p, text: `work ${i}` }, T0 + i)
    say(s2, I, { agent: p, text: '@~root done', state: 'done' }, T0 + t * HOUR)
  }
  say(s2, I, { path: 'f-old/@sub/kid', text: 'a kid under f-old' }, T0)
  for (let i = 0; i < 5; i++) say(s2, I, { agent: 'live', text: `busy ${i}` }, T0 + i)
  say(s2, I, { agent: 'live', text: '@~root working hard' }, T0 + 10)
  const full = A.estimateBytes(s2)
  const one = A.enforceBudget(s2, full - 1)
  check('enforceBudget: evicts the OLDEST finished agent first (just enough) — with its subtree', J(one.evicted.map(e => e.agent)) === J(['f-old']) && one.entries_dropped === 0 && !one.over && one.bytes_after <= full - 1
    && !N(s2, I, 'f-old/@sub/kid'))
  const two = A.enforceBudget(s2, A.estimateBytes(s2) - 1)
  check('enforceBudget: then the next oldest', J(two.evicted.map(e => e.agent)) === J(['f-mid']))
  check('enforceBudget: evicted agents are gone; unfinished stay', !N(s2, I, 'f-old') && !N(s2, I, 'f-mid') && N(s2, I, 'f-new') !== null && N(s2, I, 'live') !== null)
  const tiny = A.enforceBudget(s2, 1)
  const live = N(s2, I, 'live')
  check('enforceBudget: over a tiny budget: all finished evicted, then every log entry dropped, still over', J(tiny.evicted.map(e => e.agent)) === J(['f-new']) && tiny.entries_dropped > 0 && tiny.over
    && live.log.length === 0 && root(s2, I).log.length === 0)
  check('enforceBudget: never evicts a current line, an unfinished agent or the root; the floor moves up', live.current.text === 'working hard' && root(s2, I) !== null && live.log_dropped === 6 && live.log_floor === T0 + 10)
  const s3 = mk(), I3 = S1
  say(s3, I3, { agent: 'x', text: 'x1' }, T0 + 1)
  say(s3, I3, { agent: 'y', text: 'y2' }, T0 + 2)
  say(s3, I3, { agent: 'x', text: 'x3' }, T0 + 3)
  say(s3, I3, { agent: 'y', text: 'y4' }, T0 + 4)
  const d1 = A.enforceBudget(s3, A.estimateBytes(s3) - 1)
  const X = N(s3, I3, 'x'), Y = N(s3, I3, 'y')
  check('enforceBudget: log entries drop oldest-first across nodes (x1)', d1.entries_dropped === 1 && d1.evicted.length === 0 && X.log.map(e => e.text).join() === 'x3' && Y.log.length === 2)
  A.enforceBudget(s3, A.estimateBytes(s3) - 1)
  check('enforceBudget: … then y2', Y.log.map(e => e.text).join() === 'y4' && X.log.length === 1 && X.log_dropped === 1 && Y.log_dropped === 1)
  const s4 = mk({}, 'HOST-A'), rb = mk({}, 'HOST-B')
  say(rb, { session: 'R', project: 'P' }, { agent: 'ra', text: '@~root done', state: 'done' }, T0)
  A.mergeSnapshot(s4, 'HOST-B', A.snapshot(rb))
  say(s4, I, { agent: 'la', text: '@~root done', state: 'done' }, T0 + HOUR)
  const r4 = A.enforceBudget(s4, 1)
  check('enforceBudget: remote slices are never evicted (their origin bounds them)', J(r4.evicted.map(e => e.agent)) === J(['la']) && N(s4, { session: 'R', project: 'P' }, 'ra', 'HOST-B') !== null)
  check('estimateBytes: counts remote slices', A.estimateBytes(s4) > A.estimateBytes(mk()) + 500)
})

// ================================================================= config, ids, days
await section(async () => {
  const R = A.resolveConfig
  const w = []
  check('config: progress_checkpoint_sec 0 = off; 5 -> 10; 99999 -> 3600; -1 -> 0 (+ warning)', R({ progress_checkpoint_sec: 0 }).progress_checkpoint_sec === 0
    && R({ progress_checkpoint_sec: 5 }).progress_checkpoint_sec === 10 && R({ progress_checkpoint_sec: 99999 }).progress_checkpoint_sec === 3600
    && R({ progress_checkpoint_sec: -1 }, {}, w).progress_checkpoint_sec === 0 && w.length === 1 && R({}, { AI_BRIDGE_ACTIVITY_PROGRESS_CHECKPOINT_SEC: '30' }).progress_checkpoint_sec === 30)
  const st = A.createActivity({ origin: 'H', idPrefix: 'act_ab12_' })
  const r = say(st, S1, { text: 'x' }, T0)
  check('ids: <prefix><ts36>-<seq36>; entryTime() reads the time back', r.id === `act_ab12_${T0.toString(36)}-1` && A.entryTime(r.id) === T0 && A.entryTime('nope') === null && A.entryTime(5) === null)
  const d = new Date(T0)
  check('localDay: the LOCAL calendar day, YYYY-MM-DD', A.localDay(T0) === `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` && A.localDay(NaN) === null)
})

// ================================================================= session identity = realm + project + user + session (+ host = origin)
await section(async () => {
  const st = mk()
  say(st, { session: 'Alpha', project: 'AIMB', user: 'robin', host: 'ROBIN-Z790' }, { text: 'one' }, T0)
  say(st, { session: 'Alpha', project: 'AIMB', user: 'kim', host: 'ROBIN-Z790' }, { text: 'two' }, T0)
  say(st, { session: 'Alpha', project: 'AIMB', user: 'robin', realm: 'other' }, { text: 'three' }, T0)
  check('identity: same name + project, another user (or realm) = another session', st.local.size === 3)
  say(st, { session: 'ALPHA', project: 'aimb', user: 'Robin', host: 'LITTLE-001' }, { text: 'moved' }, T0 + MIN)
  const s = A.getSession(st, { session: 'alpha', project: 'AIMB', user: 'robin' })
  check('identity: a LOCAL report ignores ident.host — same local session; first-seen spellings kept', st.local.size === 3 && s.session === 'Alpha' && s.user === 'robin' && s.host === 'HOST-A' && s.nodes.get('').log.length === 2)
  check('sessionKey: the host is part of it (case-insensitive); groupKey leaves it out', A.sessionKey({ session: 'a', project: 'P', user: 'u', host: 'H1' }) !== A.sessionKey({ session: 'a', project: 'P', user: 'u', host: 'H2' })
    && A.sessionKey({ session: 'a', project: 'P', user: 'u', host: 'h1' }) === A.sessionKey({ session: 'A', project: 'p', user: 'U', host: 'H1' })
    && A.groupKey({ session: 'a', project: 'P', user: 'u', host: 'H1' }) === A.groupKey({ session: 'A', project: 'p', user: 'U', host: 'H2' }))
  check('identity: the session key carries this origin', s.key === A.sessionKey({ session: 'alpha', project: 'AIMB', user: 'robin', host: 'HOST-A' }))
  check('identity: the session record + entry carry the realm', s.realm === 'default' && say(st, S1, { text: 'r' }, T0).entry.realm === 'default')
  check('sessionKey: an object; realm defaults to "default"', A.sessionKey({ session: 'a', project: 'P', user: 'u' }) === A.sessionKey({ session: 'A', project: 'p', user: 'U', realm: 'Default' }))
})

// ================================================================= the log flag
await section(async () => {
  check('log flag: default true; false / "false" / 0 / "no" parse; junk -> bad-log', M({ text: 'x' }).log === true && M({ text: 'x', log: false }).log === false && M({ text: 'x', log: 'false' }).log === false
    && M({ text: 'x', log: 0 }).log === false && M({ text: 'x', log: 'no' }).log === false && M({ text: 'x', log: true }).log === true && C({ text: 'x', log: 'maybe' }) === 'bad-log')
  const st = mk(), I = S1
  const b = () => N(st, I, 'w/@build'), e = () => N(st, I, 'w')
  say(st, I, { agent: 'w', text: '@~build compiling', progress: '1/4' }, T0)
  const before = b().log.length
  const r = say(st, I, { agent: 'w', text: '@~build linking', state: 'blocked', progress: '2/4', details: 'D', log: false }, T0 + MIN)
  check('log:false: takes full effect (current line + state + bar)', r.ok && r.logged === false && b().current.text === 'linking' && A.stateOf(b()) === 'blocked' && b().progress.done === 2 && b().current.details === 'D')
  check('log:false: NOT appended to the log; entry:null, logged:false; still has an id (its line)', b().log.length === before && r.entry === null && typeof r.id === 'string' && b().current.id === r.id)
  check('log:false: counts as activity (refreshes the agent)', e().last_activity === T0 + MIN && r.stale_at === T0 + MIN + 15 * MIN)
  A.markSessionGone(st, I, T0 + 2 * MIN)
  say(st, I, { agent: 'w', text: '@build ping', log: false }, T0 + 3 * MIN)
  check('log:false: clears gone like any message', A.getSession(st, I).gone_at === null && e().gone_at === null)
  const r2 = say(st, I, { agent: 'w', text: '@build logged' }, T0 + 4 * MIN)
  check('log:true (default): logged:true + an entry', r2.logged === true && !!r2.entry && b().log.length === before + 1)
})

// ================================================================= default text + progress/eta on any message
await section(async () => {
  check('default text: progress without text -> "{progress}" (logged or not)', M({ progress: '3/6' }).text === '{progress}' && M({ progress: '3/6', log: false }).text === '{progress}' && M({ text: '', progress: '3/6' }).text === '{progress}')
  check('default text: only an ETA -> "{eta}"', M({ eta: '15m' }).text === '{eta}' && M({ progress: '1/2', eta: '15m' }).text === '{progress}')
  check('default text: no text and no progress/eta is still rejected', C({}) === 'bad-text' && C({ text: '' }) === 'text-empty' && C({ text: '@~build' }) === 'text-empty' && C({ state: 'done' }) === 'bad-text')
  const m = M({ text: '@~build', progress: '5/10 tiles', state: 'blocked' })
  check('default text: a prefix alone + progress = that node\'s line "{progress}" (state allowed)', m.context === 'build' && m.current && m.text === '{progress}' && m.state === 'blocked')
  check('default text: "{progress}" also with the context param / the path', M({ context: '@~tiles', progress: '1/2' }).text === '{progress}' && M({ path: 'a/@~t', progress: '1/2' }).text === '{progress}')
  const st = mk(), I = S1, c = () => N(st, I, 'w/@t')
  say(st, I, { agent: 'w', text: '@~t start', eta: '30m' }, T0)
  say(st, I, { agent: 'w', text: '@t note', eta: '10m' }, T0 + MIN)
  check('eta: a plain message moves the ETA too', c().eta_at === T0 + 11 * MIN)
  say(st, I, { agent: 'w', text: '@~t finished', state: 'done' }, T0 + 2 * MIN)
  say(st, I, { agent: 'w', text: '@t late eta', eta: '10m', progress: '9/10' }, T0 + 3 * MIN)
  check('eta: ignored while the node is done (bar still moves)', c().eta_at === null && c().progress.done === 9)
  say(st, I, { agent: 'w', text: '@~t again', state: 'running' }, T0 + 4 * MIN)
  check('eta: stays dropped after a revive without one', c().eta_at === null)
})

// ================================================================= persistence markers (6a: new_from over the chain)
await section(async () => {
  const st = mk(), I = S1
  const a = say(st, I, { agent: 'w', text: '@~build go' }, T0).entry
  check('markers: the first record of a session carries new_from 0 (everything on its chain is new); v2', a.new_from === 0 && a.v === 2 && !('new_session' in a))
  const b = say(st, I, { agent: 'w', text: '@build more' }, T0 + 1).entry
  check('markers: later records of the same nodes carry none', !('new_from' in b))
  const c2 = say(st, I, { agent: 'w', text: 'agent note' }, T0 + 2).entry
  check('markers: a node already persisted as an ancestor carries none', !('new_from' in c2))
  const d = say(st, I, { path: 'w/@build/@deep/@er', text: 'x' }, T0 + 3).entry
  check('markers: new_from = the first new index of the chain [root, …segments]', d.new_from === 3)
  say(st, I, { agent: 'q', text: '@x hi', log: false }, T0 + 4)
  const q = say(st, I, { agent: 'q', text: '@x logged now' }, T0 + 5).entry
  check('markers: go on the first PERSISTED record (an unlogged creation does not count)', q.new_from === 1)
  const f = say(st, I, { agent: 'w', text: '@~root done', state: 'done' }, T0 + 6).entry
  const g = say(st, I, { agent: 'w', text: '@~root still done', state: 'done' }, T0 + 7).entry
  const h = say(st, I, { agent: 'w', text: '@~root back', state: 'running' }, T0 + 8).entry
  const k = say(st, I, { agent: 'w', text: '@~build ctx line', state: 'done' }, T0 + 9).entry
  check('markers: an agent\'s current line carries its resulting finished_at (null when live); a context\'s never', f.finished_at === T0 + 6 && g.finished_at === T0 + 6 && 'finished_at' in h && h.finished_at === null && !('finished_at' in b) && !('finished_at' in k))
  check('in-memory entries never hold the markers', !('new_from' in N(st, I, 'w').log[0]) && !('finished_at' in N(st, I, 'w').log.at(-1)))
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
  check('fmtNum: grouping, decimals, negatives, deterministic', A.fmtNum(1234567) === '1,234,567' && A.fmtNum(1.5) === '1.5' && A.fmtNum(1234.567) === '1,234.57' && A.fmtNum(0) === '0'
    && A.fmtNum(999) === '999' && A.fmtNum(1000) === '1,000' && A.fmtNum(-2500) === '-2,500' && A.fmtNum(1e15) === '1,000,000,000,000,000' && A.fmtNum(2.0) === '2')
  check('fmtEta: rounding edges', A.fmtEta(59000) === '~59s' && A.fmtEta(60000) === '~1m' && A.fmtEta(89 * MIN + 40000) === '~1h 30m' && A.fmtEta(NaN) === '?')
})

// ================================================================= read views (board / log / entry) + rendering
await section(async () => {
  const st = mk(), I = S1, now = T0 + 10 * MIN
  say(st, I, { agent: 'w', text: '@~tiles Seeding {progress} ({pct}) eta {eta}', progress: '10/100 tiles', eta: '30m' }, T0)
  say(st, I, { agent: 'w', text: '@tiles batch {progress}', progress: '20/100 tiles' }, T0 + MIN)
  say(st, I, { agent: 'w', progress: '40/100 tiles', context: '@tiles', log: false }, T0 + 2 * MIN)
  say(st, I, { agent: 'w', text: '@~root overall {progress}' }, T0 + 3 * MIN)
  say(st, I, { text: '@~root orchestrating' }, T0 + 4 * MIN)
  say(st, { session: 'Other', project: 'X', user: 'robin' }, { agent: 'z', text: '@~root fin', state: 'done' }, T0)
  const b = A.boardView(st, now)
  const g = b.find(s => s.session === 'Bridget'), bw = nodeOf(g, 'w'), tiles = nodeOf(g, 'w/@tiles')
  check('board: groups with self (the root) + a FLAT nodes list (path, kind, depth, parent, host)', b.length === 2 && g.self.path === '' && bw.kind === 'agent' && tiles.kind === 'context' && tiles.parent === 'w' && tiles.depth === 2 && tiles.host === 'HOST-A' && tiles.state === 'running' && !('agents' in g))
  check('board: a current line renders against the CURRENT bar + ETA (moved by the log:false update)', tiles.current.text === 'Seeding {progress} ({pct}) eta {eta}' && tiles.current.rendered === 'Seeding 40 of 100 tiles (40%) eta ~20m')
  check('board: an agent line renders against its bar (the rollup of its children)', bw.current.rendered === 'overall 40 of 100 tiles' && bw.progress.rollup === true)
  check('board: filters (project, session, path / agent, active_only)', A.boardView(st, now, { project: 'x' }).length === 1 && A.boardView(st, now, { session: 'bridget' }).length === 1
    && A.boardView(st, now, { agent: 'nope' }).length === 0 && A.boardView(st, now, { path: 'w/@tiles' })[0].nodes.length === 1 && A.boardView(st, now, { path: 'w' })[0].nodes.length === 2
    && A.boardView(st, now, { active_only: true }).find(s => s.session === 'Other').nodes.length === 0)
  check('board: stale computed with stale_after_min (or a viewer threshold); a context follows its agent', nodeOf(A.boardView(st, T0 + 30 * MIN)[0], 'w').state === 'stale' && nodeOf(A.boardView(st, T0 + 30 * MIN)[0], 'w/@tiles').state === 'stale'
    && nodeOf(A.boardView(st, T0 + 30 * MIN, { staleMin: 60 })[0], 'w').state === 'running')
  const lv = A.logView(st, { session: 'Bridget', agent: 'w' }, now)
  check('log view: the agent\'s SUBTREE merged, newest first; rendered against the progress RECORDED on each entry; rel paths', lv.ok && lv.entries.length === 3 && lv.entries[0].text === 'overall {progress}' && lv.entries[0].rendered === 'overall {progress}' && lv.entries[0].rel === ''
    && lv.entries[1].rendered === 'batch 20 of 100 tiles' && lv.entries[1].rel === '@tiles' && lv.entries[1].path === 'w/@tiles' && lv.entries[2].rendered === 'Seeding 10 of 100 tiles (10%) eta ~20m')
  check('log view: a context (old context filter or the path) + limit; own:true = the node\'s own entries', A.logView(st, { session: 'Bridget', agent: 'w', context: '@tiles', limit: 1 }, now).entries.map(e => e.text).join() === 'batch {progress}'
    && A.logView(st, { session: 'Bridget', path: 'w/@tiles' }, now).total === 2 && A.logView(st, { session: 'Bridget', path: 'w', own: true }, now).entries.length === 1)
  check('log view: the session itself = everything (no path); codes', A.logView(st, { session: 'bridget' }, now).entries[0].text === 'orchestrating' && A.logView(st, { session: 'bridget' }, now).total === 4
    && A.logView(st, { session: 'nobody' }).code === 'unknown-session' && A.logView(st, { session: 'Bridget', agent: 'ghost' }).code === 'unknown-node' && A.logView(st, {}).code === 'bad-log-query'
    && A.logView(st, { session: 'Bridget', own: true }, now).entries.length === 1)
  say(st, { session: 'Bridget', project: 'Other', user: 'robin' }, { text: 'twin' }, T0)
  check('log view: an ambiguous name asks for the project', A.logView(st, { session: 'Bridget' }).code === 'ambiguous-session' && A.logView(st, { session: 'Bridget', project: 'aimb', agent: 'w' }).ok)
  const r = say(st, I, { agent: 'w', text: '@~d with details', details: 'DD', data: { a: 1 } }, T0 + 5 * MIN)
  const r2 = say(st, I, { agent: 'w', text: '@d log only', details: 'LOGGED' }, T0 + 6 * MIN)
  const f1 = A.findEntry(st, r.id, now), f2 = A.findEntry(st, r2.id, now)
  check('findEntry: a current line comes with its details/data + its node path', f1.where === 'current' && f1.complete && f1.entry.details === 'DD' && f1.entry.data.a === 1 && f1.entry.path === 'w/@d' && f1.entry.session === 'Bridget')
  check('findEntry: a log entry has flags only (complete:false -> read the JSONL); unknown -> null', f2.where === 'log' && f2.complete === false && f2.entry.has_details && f2.entry.details === null && A.findEntry(st, 'nope') === null)
})

// ================================================================= 6a: the subtree-merged log — order, paging, floors, the files descriptor
await section(async () => {
  const st = mk({ log_entries_per_agent: 10 }), I = S1
  const ids = {}
  const put = (path, text, t) => { const r = say(st, I, { path, text }, t); (ids[path] || (ids[path] = [])).push(r.id); return r.id }
  // interleaved entries across a nested subtree: spec-70 (agent), its contexts, a nested context, a sub-agent
  const order = []
  let t = T0
  for (let i = 0; i < 6; i++) for (const p of ['spec-70', 'spec-70/@Tharsis', 'spec-70/@Tharsis/@z12', 'spec-70/research', '@elsewhere']) order.push({ p, id: put(p, `${p} #${i}`, (t += 1000)) })
  const sub = order.filter(x => x.p.startsWith('spec-70')).map(x => x.id).reverse()
  const all1 = A.logView(st, { session: 'Bridget', path: 'spec-70', limit: 200 }, T0 + HOUR)
  check('subtree log: every entry of the subtree (agent, contexts, nested context, sub-agent), newest first, nothing outside', J(all1.entries.map(e => e.id)) === J(sub.slice(0, 10)) && all1.total === 24, J([all1.entries.length, all1.total]))
  const pages = []
  let cur = null
  for (let k = 0; k < 10; k++) { const p = A.logView(st, { session: 'Bridget', path: 'spec-70', limit: 7, ...(cur ? { cursor: cur } : {}) }, T0 + HOUR); pages.push(p); cur = p.next_cursor; if (!cur) break }
  check('subtree log: paged with cursors (7 per page) through all 24, in order, no duplicates', J(pages.flatMap(p => p.entries.map(e => e.id))) === J(sub) && pages.length === 4 && pages[3].next_cursor === null, J(pages.map(p => p.entries.length)))
  check('subtree log: a nested context\'s own subtree', A.logView(st, { session: 'Bridget', path: 'spec-70/@Tharsis', limit: 50 }, T0 + HOUR).total === 12 && A.logView(st, { session: 'Bridget', path: 'spec-70/@Tharsis', own: true }, T0 + HOUR).total === 6)
  check('subtree log: rel paths are relative to the queried node', (e => e.rel === '@Tharsis/@z12' && e.path === 'spec-70/@Tharsis/@z12')(A.logView(st, { session: 'Bridget', path: 'spec-70' }, T0 + HOUR).entries.find(e => e.path.endsWith('@z12'))))
  // the floor: a node that dropped entries makes the memory incomplete below its newest dropped one → the files continue there
  for (let i = 0; i < 12; i++) put('spec-70/@Tharsis/@z12', `burst ${i}`, (t += 1000))   // z12 now drops (cap 10)
  const z12 = N(st, I, 'spec-70/@Tharsis/@z12')
  check('harness: z12 dropped entries; its floor = the newest dropped entry\'s time', z12.log_dropped === 8 && z12.log_floor > T0)
  const mem = []
  let fc = null, desc = null
  for (let k = 0; k < 10; k++) { const p = A.logView(st, { session: 'Bridget', path: 'spec-70', limit: 10, ...(fc ? { cursor: fc } : {}) }, T0 + HOUR, { files: true }); mem.push(...p.entries); if (p.files) { desc = p.files; break } fc = p.next_cursor; if (!fc) break }
  check('files: memory serves the subtree only at/above its floor, then a descriptor continues below it (target = the node key, subtree)', !!desc && mem.every(e => e.ts >= z12.log_floor) && desc.before.ts === z12.log_floor
    && desc.target.key === 'spec-70' && desc.target.own === false && desc.target.session === 'Bridget' && desc.from === null, J(desc && { ...desc, before: desc.before && { ts: desc.before.ts, ids: [...desc.before.ids] } }))
  check('files: entries in memory below the floor (other nodes) are left for the files (none served twice)', mem.length === new Set(mem.map(e => e.id)).size && !mem.some(e => e.ts < z12.log_floor))
  const noFiles = A.logView(st, { session: 'Bridget', path: 'spec-70', limit: 200 }, T0 + HOUR)
  check('files: without opts.files the whole memory is merged (no floor cut, no descriptor)', !noFiles.files && noFiles.entries.length === 10 && noFiles.total === 28)
  const ent = say(mk(), I, { path: 'spec-70/@Tharsis/@~z12', text: 'x {progress}', progress: '1/2', details: 'D' }, T0).entry
  const tg = desc.target
  check('files: fileEntryMatches — the node and its subtree (case-insensitive); not outside; own:true only the node; cp / v1 lines never', A.fileEntryMatches(ent, tg) && A.fileEntryMatches({ ...ent, session: 'BRIDGET', path: 'SPEC-70/@tharsis' }, tg)
    && !A.fileEntryMatches({ ...ent, path: 'spec-700' }, tg) && !A.fileEntryMatches({ ...ent, path: '@elsewhere' }, tg) && A.fileEntryMatches({ ...ent, path: 'spec-70' }, { ...tg, own: true }) && !A.fileEntryMatches(ent, { ...tg, own: true })
    && !A.fileEntryMatches({ ...ent, kind: 'cp', k: 1 }, tg) && !A.fileEntryMatches({ ...ent, v: 1 }, tg) && A.fileEntryMatches({ ...ent, path: '' }, { ...tg, key: '' }))
  const fv = A.fileEntryView(ent, T0, 'spec-70')
  check('files: fileEntryView = the in-memory entry shape + path + rel + rendered as recorded', fv.rendered === 'x 1 of 2' && fv.has_details === true && !('details' in fv) && fv.current === true && fv.path === 'spec-70/@Tharsis/@z12' && fv.rel === '@Tharsis/@z12', J(fv))
  // a cursor whose entry was dropped continues by time; garbage → bad-cursor
  const pt = A.logView(st, { session: 'Bridget', path: 'spec-70/@Tharsis/@z12', cursor: ids['spec-70/@Tharsis/@z12'][0] }, T0 + HOUR)
  check('paging: a cursor whose entry was dropped continues from its time; garbage -> bad-cursor', pt.ok && pt.entries.length === 0 && pt.next_cursor === null
    && A.logView(st, { session: 'Bridget', path: 'spec-70', cursor: 'garbage' }, T0 + HOUR).code === 'bad-cursor')
})

// ================================================================= checkpoints (cp) + repeat lines (rep) — per node
await section(async () => {
  const st = mk(), I = S1
  const tick = t => A.planCheckpoints(st, t)
  const file = []
  const write = ws => { for (const w of ws) { if (w.rewrite) { check('rep rewrite: the open repeat line IS the file\'s last line', file.length && file.at(-1).rep !== undefined); file[file.length - 1] = w.rec } else file.push(w.rec) } return ws }
  say(st, I, { agent: 'w', context: '@~scan', progress: '1/100', log: false }, T0)
  const w1 = write(tick(T0 + MIN))
  check('cp: a node changed by log:false -> one full v2 cp line (path) with a per-file key', w1.length === 1 && w1[0].kind === 'cp' && w1[0].rec.kind === 'cp' && w1[0].rec.v === 2 && w1[0].rec.k === 1 && w1[0].rec.progress.done === 1
    && w1[0].rec.current.text === '{progress}' && w1[0].rec.path === 'w/@scan' && w1[0].rec.new_from === 0)
  check('cp: nothing live -> nothing written', tick(T0 + 2 * MIN).length === 0)
  for (let i = 0; i < 3; i++) {
    say(st, I, { agent: 'w', context: '@~scan', progress: '1/100', log: false }, T0 + (2 + i) * MIN + 1000)
    write(tick(T0 + (3 + i) * MIN))
  }
  check('rep: unchanged-but-alive intervals -> ONE v2 repeat line whose n increments (rewritten in place)', file.length === 2 && file[1].v === 2 && J(file[1].rep) === '[1]' && file[1].n === 3 && file[1].since === T0 + 3 * MIN && file[1].last === T0 + 5 * MIN)
  say(st, I, { agent: 'w', context: '@~scan', progress: '50/100', log: false }, T0 + 5 * MIN + 1000)
  say(st, I, { path: 'w/@other/@~root', text: 'x', log: false }, T0 + 5 * MIN + 2000)
  const w2 = write(tick(T0 + 6 * MIN))
  check('cp: a change mid-stream -> a new cp (same key); a new node gets the next key', w2.length === 2 && w2.every(w => w.kind === 'cp') && w2.find(w => w.rec.path === 'w/@scan').rec.k === 1 && w2.find(w => w.rec.path === 'w/@other').rec.k === 2)
  say(st, I, { agent: 'w', context: '@~scan', progress: '50/100', log: false }, T0 + 6 * MIN + 1000)
  say(st, I, { agent: 'w', text: '@~other x', log: false }, T0 + 6 * MIN + 2000)
  const w3 = write(tick(T0 + 7 * MIN))
  check('rep: after a cp the next unchanged interval starts a FRESH repeat line', w3.length === 1 && w3[0].kind === 'rep' && !w3[0].rewrite && J(w3[0].rec.rep) === '[1,2]' && w3[0].rec.n === 1)
  say(st, I, { agent: 'w', context: '@~scan', progress: '50/100', log: false }, T0 + 7 * MIN + 1000)
  const w4 = write(tick(T0 + 8 * MIN))
  check('rep: a different key set -> a new line', w4.length === 1 && !w4[0].rewrite && J(w4[0].rec.rep) === '[1]')
  say(st, I, { agent: 'w', context: '@~scan', progress: '50/100', log: false }, T0 + 8 * MIN + 1000)
  const ent = say(st, I, { agent: 'w', text: '@other a logged line' }, T0 + 8 * MIN + 2000); file.push(ent.entry)
  const w5 = write(tick(T0 + 9 * MIN))
  check('rep: any other write (a log entry) closes the open line -> the next is appended', w5.length === 1 && w5[0].kind === 'rep' && !w5[0].rewrite)
  check('cp: at most one cp per node per interval (a burst)', (() => { for (let i = 0; i < 20; i++) say(st, I, { agent: 'w', context: '@~scan', progress: `${51 + i}/100`, log: false }, T0 + 9 * MIN + i * 100); const w = write(tick(T0 + 10 * MIN)); return w.length === 1 && w[0].rec.progress.done === 70 })())
  const now = T0 + 11 * MIN
  const b = A.createActivity({ origin: 'HOST-A' })
  A.replayNewestFirst(b, ['{"truncated', ...file.slice().reverse()], now)
  const sc = N(b, I, 'w/@scan')
  check('replay: the bar + current line come back from the newest cp', sc.progress.done === 70 && sc.current.text === '{progress}')
  check('replay: last_activity = the newest record or rep `last` listing the key', sc.last_activity === T0 + 10 * MIN && N(b, I, 'w/@other').last_activity === T0 + 8 * MIN + 2000)
  check('replay: checkpoints never enter the log history', N(b, I, 'w/@other').log.map(e => e.text).join() === 'a logged line' && N(b, I, 'w/@scan').log.length === 0)
  check('replay: a garbled record (a crash mid-rewrite) is skipped', A.recordKind('{"truncated') === null && A.recordKind({ v: 2, rep: [1], n: 1 }) === null && A.recordKind({ v: 2, kind: 'cp', session: 's', path: 'c', ts: 1 }) === null)
  check('replay: today\'s cp keys are re-derived (new cps continue the numbering)', b.cp && b.cp.next === 3 && b.cp.keys.size === 2)
  const TB = T0 - 2 * HOUR
  const s3 = A.createActivity({ origin: 'H', config: { finished_visible_hours: 1 } })
  const oldCp = { v: 2, kind: 'cp', k: 4, ts: TB, session: 'S', project: 'P', user: 'u', path: '@scan', current: { id: 'i', ts: TB, text: 'scanning', state: 'running' }, state: 'running', progress: { done: 5, total: 9, unit: '' }, eta_at: null, new_from: 0 }
  const repLine = { v: 2, rep: [4], n: 200, since: TB + MIN, last: TB + 3 * HOUR }
  A.replayNewestFirst(s3, [repLine, { v: 2, id: 'z', ts: TB + 1000, session: 'S', project: 'P', user: 'u', path: '@other', text: 'old', state: 'running' }, oldCp], TB + 3 * HOUR + MIN)
  const sc3 = N(s3, { session: 'S', project: 'P', user: 'u' }, '@scan')
  check('replay: an old cp still needed by an in-window rep line is used (and old entries are not)', !!sc3 && sc3.current.text === 'scanning' && sc3.last_activity === TB + 3 * HOUR
    && !N(s3, { session: 'S', project: 'P', user: 'u' }, '@other'))
  const tomorrow = T0 + 30 * HOUR
  say(st, I, { agent: 'w', context: '@~scan', progress: '70/100', log: false }, tomorrow - 1000)
  const w6 = tick(tomorrow)
  check('cp: a new day\'s file -> keys restart at 1, an unchanged node gets a full cp', w6.length === 1 && w6[0].kind === 'cp' && w6[0].rec.k === 1)
  say(st, I, { agent: 'w', context: '@~scan', progress: '71/100', log: false }, tomorrow + 1000)
  say(st, I, { agent: 'w', text: '@~other y', log: false }, tomorrow + 2000)
  const fl = A.flushCheckpoints(st, tomorrow + 3000)
  check('flushCheckpoints: a cp per dirty node, regardless of the interval', fl.length === 2 && fl.every(w => w.kind === 'cp'))
  say(st, I, { agent: 'w', context: '@~scan', progress: '72/100', log: false }, tomorrow + 4000)
  say(st, I, { agent: 'w', text: '@~other y', log: false }, tomorrow + 5000)
  const fr = A.flushCheckpoints(st, tomorrow + 6000, { withRep: true })
  const otherK = fr.length === 2 ? st.cp.keys.get([...st.cp.keys.keys()].find(k => k.includes('other'))) : null
  check('flushCheckpoints withRep: the changed node\'s cp AND a repeat line for the unchanged one', fr.length === 2 && fr[0].kind === 'cp' && fr[0].rec.progress.done === 72
    && fr[1].kind === 'rep' && J(fr[1].rec.rep) === J([otherK]) && fr[1].rec.last === tomorrow + 6000, J(fr))
  check('flushCheckpoints (default): still cp lines only', A.flushCheckpoints(st, tomorrow + 7000).every(w => w.kind === 'cp'))
})

// ================================================================= replay == chronological apply (seeded random, NESTED paths)
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const byKey = (a, b) => (String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0)
function dump(st, full = true) {
  const node = n => ({ key: n.key, path: n.path, kind: n.kind, parent: n.parent, finished_at: n.finished_at,
    current: n.current && (full ? n.current : { id: n.current.id, text: n.current.text, state: n.current.state, details: n.current.details, data: n.current.data }),
    progress: n.progress, eta_at: n.eta_at, ...(full ? { created_at: n.created_at, last_activity: n.last_activity, gone_at: n.gone_at, stale_after_ms: n.stale_after_ms, implicit: n.implicit, log: n.log, log_dropped: n.log_dropped, log_floor: n.log_floor } : {}) })
  return J([...st.local.values()].sort(byKey).map(s => ({ key: s.key, realm: s.realm, session: s.session, project: s.project, user: s.user, ...(full ? { host: s.host, created_at: s.created_at, last_activity: s.last_activity, gone_at: s.gone_at } : {}),
    nodes: [...s.nodes.values()].sort(byKey).map(node) })))
}
function genMessages(seed, n, { unlogged = 0 } = {}) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)]
  const idents = [{ session: 'Alpha', project: 'AIMB', user: 'robin', host: 'H1' }, { session: 'beta', project: 'Marz', user: 'robin', host: 'H1' }, { session: 'ALPHA', project: 'aimb', user: 'kim', host: 'H1' }]
  const addrs = [{}, {}, { agent: 'w1' }, { agent: 'W1' }, { agent: 'w2/sub' }, { agent: 'w3' }, { agent: 'deep/a/b' }, { path: '@#70/spec-70' }, { path: '@#70/@step4/spec-70' }, { path: 'w1/@Tharsis' },
    { path: '@#70' }, { agent: 'w2', path: 'sub/@ctx' }, { path: 'spec-70/research' }]
  const ctxs = ['', '@build ', '@~build ', '@~Build ', '@tiles ', '@~tiles ', '@~"strip 17" ', '@root ', '@~root ', '@~root ', '@Tharsis/@~z12 ', '@z/@y ']
  const out = []
  let t = T0
  for (let i = 0; i < n; i++) {
    t += 1000 + Math.floor(r() * 90000)
    const input = { ...pick(addrs), text: pick(ctxs) + `m${i} {progress}` }
    if (r() < 0.3) input.state = pick(A.ACTIVITY_STATES)
    if (r() < 0.25) input.progress = r() < 0.15 ? 'none' : `${Math.floor(r() * 50)}/${50 + Math.floor(r() * 50)} ${pick(['tiles', 'Tiles', '', 'files'])}`
    if (r() < 0.2) input.eta = r() < 0.2 ? 'none' : `${1 + Math.floor(r() * 90)}m`
    if (r() < 0.1) input.stale_after = `${5 + Math.floor(r() * 120)}m`
    if (r() < 0.1) input.details = `details ${i}`
    if (r() < 0.1) input.data = { i, v: [i, 'x'] }
    if (unlogged && r() < unlogged) { input.log = false; if (!input.text.startsWith('@~') && r() < 0.6) input.progress = `${i % 50}/50` }
    if (r() < 0.03) { delete input.text; if (!input.progress && !input.eta) input.progress = `${i % 7}/7` }
    out.push({ ident: pick(idents), input, t })
  }
  return out
}
function firstDiff(a, b) { if (a === b) return ''; let i = 0; while (i < a.length && a[i] === b[i]) i++; return `@${i}: …${a.slice(Math.max(0, i - 120), i + 80)}\n  vs …${b.slice(Math.max(0, i - 120), i + 80)}` }
await section(async () => {
  for (const seed of [7, 70, 1958]) {
    const msgs = genMessages(seed, 1500)
    const A1 = A.createActivity({ origin: 'H1', config: { log_entries_per_agent: 10 } }), entries = []
    let applied = 0
    for (const m of msgs) { const r = say(A1, m.ident, m.input, m.t); if (r.ok) { applied++; if (r.entry) entries.push(JSON.parse(J(r.entry))) } }
    const now = msgs.at(-1).t + MIN
    A.expire(A1, now)
    const B = A.createActivity({ origin: 'H1', config: { log_entries_per_agent: 10 } })
    const st = A.replayNewestFirst(B, entries.slice().reverse(), now)
    const nodes = [...A1.local.values()].reduce((s, x) => s + x.nodes.size, 0)
    check(`replay == chronological apply: seed ${seed} (${applied} msgs, ${st.entries} entries, ${nodes} nodes incl. depth-5 paths; current state, floors AND log contents)`, dump(A1) === dump(B), firstDiff(dump(A1), dump(B)))
  }
  for (const seed of [11, 2026]) {
    const msgs = genMessages(seed, 1200, { unlogged: 0.45 })
    const A2 = A.createActivity({ origin: 'H1', config: { log_entries_per_agent: 10 } }), recs = []
    const writeW = ws => { for (const w of ws) { if (w.rewrite) recs[recs.length - 1] = JSON.parse(J(w.rec)); else recs.push(JSON.parse(J(w.rec))) } }
    let nextTick = T0 + 5 * MIN
    for (const m of msgs) {
      while (m.t >= nextTick) { writeW(A.planCheckpoints(A2, nextTick)); nextTick += 5 * MIN }
      const r = say(A2, m.ident, m.input, m.t)
      if (r.ok && r.entry) recs.push(JSON.parse(J(r.entry)))
    }
    const now = msgs.at(-1).t + MIN
    writeW(A.flushCheckpoints(A2, now))
    A.expire(A2, now)
    const B2 = A.createActivity({ origin: 'H1', config: { log_entries_per_agent: 10 } })
    const st2 = A.replayNewestFirst(B2, recs.slice().reverse(), now)
    check(`replay with cp/rep (log:false 45%): seed ${seed} (${st2.entries} entries, ${st2.cps} cps, ${st2.reps} reps) — current lines/bars/ETAs/states/finished agree`, dump(A2, false) === dump(B2, false), firstDiff(dump(A2, false), dump(B2, false)))
  }
})

// ================================================================= replay — instances, eviction (subtrees), window, phase 1, v1 records
await section(async () => {
  const st = mk({ log_entries_per_agent: 10 }), I = S1, entries = []
  const sayE = (input, t) => { const r = say(st, I, input, t); if (r.entry) entries.push(JSON.parse(J(r.entry))); return r }
  for (let i = 1; i <= 127; i++) sayE({ agent: `a${i}`, text: `@~work a${i} start`, progress: `${i}/200` }, T0 + i * 1000)
  sayE({ path: 'a5/kid/@ctx', text: 'a sub-agent of a5' }, T0 + 150000)   // 128 agents
  sayE({ agent: 'a5', text: '@~root done', state: 'done' }, T0 + 200000)
  sayE({ agent: 'a9', text: '@~root done', state: 'done' }, T0 + 201000)
  check('harness: the 129th agent evicts a5 WITH its subtree', (r => r.evicted.join() === 'a5' && !N(st, I, 'a5/kid'))(sayE({ agent: 'new1', text: 'hi' }, T0 + 202000)))
  sayE({ agent: 'new1', text: '@~root done', state: 'done' }, T0 + 203000)
  sayE({ agent: 'filler', text: 'back to 128 agents' }, T0 + 203500)
  check('harness: a5 comes back as a NEW instance (evicts a9)', sayE({ agent: 'a5', text: '@~fresh back again' }, T0 + 204000).evicted.join() === 'a9')
  const now = T0 + 300000
  A.expire(st, now)
  const B = mk({ log_entries_per_agent: 10 })
  A.replayNewestFirst(B, entries.slice().reverse(), now)
  check('replay: evicted subtrees stay evicted; a re-created agent is a NEW instance (no old contexts / sub-agents / log)', dump(st) === dump(B) && !N(B, I, 'a9') && !N(B, I, 'a5/@work') && !N(B, I, 'a5/kid'), firstDiff(dump(st), dump(B)))
  const W = mk({ finished_visible_hours: 2 }), ents = []
  const sw = (input, t) => { const r = say(W, I, input, t); if (r.entry) ents.push(JSON.parse(J(r.entry))) }
  sw({ agent: 'old', text: '@~root long gone', state: 'done' }, T0)
  sw({ agent: 'live', text: '@~root recent' }, T0 + 5 * HOUR)
  const W2 = mk({ finished_visible_hours: 2 })
  const sts = A.replayNewestFirst(W2, ents.slice().reverse(), T0 + 5 * HOUR + MIN)
  check('replay: only records within finished_visible_hours (an agent finished before the window is not resurrected)', !N(W2, I, 'old') && !!N(W2, I, 'live') && sts.entries === 1)
  check('replay: feed() reports "old" for a record before the window', A.createReplay(mk({ finished_visible_hours: 1 }), { now: T0 + 2 * HOUR }).feed(ents[0]) === 'old')
  // a node whose instance began BEFORE the window: its log floor is the window start (older entries are only in the files)
  const Wf = mk({ finished_visible_hours: 2 }), ef = []
  const sf = (input, t) => { const r = say(Wf, I, input, t); if (r.entry) ef.push(JSON.parse(J(r.entry))) }
  sf({ path: 'long/@runner', text: 'started long ago' }, T0)
  sf({ path: 'long/@runner', text: 'still going' }, T0 + 5 * HOUR)
  const Wf2 = mk({ finished_visible_hours: 2 })
  A.replayNewestFirst(Wf2, ef.slice().reverse(), T0 + 5 * HOUR + MIN)
  check('replay: a node whose instance began before the window gets log_floor = the window start', N(Wf2, I, 'long/@runner').log.length === 1 && N(Wf2, I, 'long/@runner').log_floor === T0 + 5 * HOUR + MIN - 2 * HOUR)
})
await section(async () => {
  const st = mk(), I = S1, entries = []
  const sayE = (input, t) => { const r = say(st, I, input, t); if (r.entry) entries.push(JSON.parse(J(r.entry))) }
  sayE({ text: '@~root orchestrating' }, T0)
  sayE({ path: '@#70/spec-70/@build', text: '@~root compiling', progress: '1/4', eta: '10m' }, T0 + MIN)
  sayE({ path: '@#70/spec-70', text: '@~root working' }, T0 + 2 * MIN)
  for (let i = 0; i < 30; i++) sayE({ path: '@#70/spec-70/@build', text: `noise ${i}` }, T0 + 3 * MIN + i * 1000)
  const B = mk(), rp = A.createReplay(B, { now: T0 + HOUR })
  const recs = entries.slice().reverse()
  let i = 0
  for (; i < 30; i++) rp.feed(recs[i])
  check('phase 1: not complete while a node\'s current line / bar is unresolved (the context + its ancestors)', !rp.phase1Complete() && rp.pending() >= 1)
  rp.feed(recs[i++])
  check('phase 1: still pending: build has no current line yet', !rp.phase1Complete())
  rp.feed(recs[i++])
  check('phase 1: complete once everything SEEN is resolved (one older record still unread)', rp.phase1Complete() && i === recs.length - 1, J(rp.stats()))
  rp.publish()
  const wb = N(B, I, '@#70/spec-70/@build')
  check('phase 1: publish() installs current lines + bars without history', wb.current.text === 'compiling' && wb.progress.done === 1 && N(B, I, '@#70/spec-70').current.text === 'working' && wb.log.length === 0)
  rp.feed(recs[i++])
  const fin = rp.finish()
  check('phase 2: finish() adds the history (chronological, capped per node) and the rest', fin.entries === 33 && N(B, I, '@#70/spec-70/@build').log.length === 31 && N(B, I, '@#70/spec-70/@build').log[0].text === 'compiling'
    && root(B, I).current.text === 'orchestrating' && dump(st) === dump(B), firstDiff(dump(st), dump(B)))
})
await section(async () => {
  // 6a: a 1.61-format (v1) JSONL record is skipped cleanly — never misread as a node
  const H = mk({ log_entries_per_agent: 10 }, 'HOST-A')
  const v1 = [
    { v: 1, id: 'act_a_1-1', ts: T0, session: 'Old', project: 'AIMB', user: 'robin', context: 'root', current: true, text: 'v1 root line', state: 'running', new_session: true, new_entity: true, new_context: true },
    { v: 1, id: 'act_a_2-2', ts: T0 + 1000, session: 'Old', project: 'AIMB', user: 'robin', agent: 'w', context: 'build', current: true, text: 'v1 agent line', state: 'running', new_entity: true, new_context: true },
    { v: 1, kind: 'cp', k: 1, ts: T0 + 2000, session: 'Old', project: 'AIMB', user: 'robin', agent: 'w', context: 'build', current: { id: 'c', ts: T0, text: 'v1 cp', state: 'running' }, state: 'running', progress: { done: 1, total: 2, unit: '' } },
    { rep: [1], n: 3, since: T0, last: T0 + 3000 },
  ]
  const v2 = { v: 2, id: 'act_b_3-3', ts: T0 + 4000, session: 'New', project: 'AIMB', user: 'robin', path: 'w/@build', current: true, text: 'v2 line', state: 'running', new_from: 0 }
  check('v1 records: recordKind → null for every 1.61-format line (entry, cp, rep)', v1.every(r => A.recordKind(r) === null) && A.recordKind(v2) === 'entry')
  const st = A.replayNewestFirst(H, [v2, ...v1.slice().reverse()].reverse().reverse(), T0 + MIN)
  check('v1 records: the replay skips them (counted), rebuilding only the v2 session', st.skipped === 4 && st.sessions === 1 && !A.getSession(H, { session: 'Old', project: 'AIMB', user: 'robin' }) && N(H, { session: 'New', project: 'AIMB', user: 'robin' }, 'w/@build').current.text === 'v2 line', J(st))
})

// ================================================================= the file facet's daily JSONL (+ the replay reading it backwards)
await section(async () => {
  const os = await import('node:os'), fs = await import('node:fs'), path = await import('node:path')
  const { create } = await import('../facets/persistence/file.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-actunit-'))
  const store = create({ CFG: {}, HERE: dir, env: { AI_BRIDGE_PERSIST_DIR: dir } }), F = store.activity
  const st = mk({ log_entries_per_agent: 10 }), I = S1, D = A.localDay(T0)
  for (let i = 0; i < 40; i++) { const r = say(st, I, { path: `w/@c${i % 3}/@~z`, text: `ünïcødé ✓ line ${i} {progress}`, progress: `${i}/40 tiles`, details: 'é'.repeat(i * 7) }, T0 + i * 1000); await F.append('HOST', D, J(r.entry)) }
  const back = []
  for await (const r of F.readBackwards('HOST', { chunk: 61 })) back.push(r)
  check('facet: readBackwards (chunked) yields every line newest first, intact across chunk edges', back.length === 40 && back.every(r => r.rec) && back[0].rec.text.includes('line 39') && back[39].rec.text.includes('line 0'))
  check('facet: offsets + lengths address each line (readAt)', J(await F.readAt('HOST', D, back[5].offset, back[5].length)) === J(back[5].rec))
  const B = mk({ log_entries_per_agent: 10 }), rp = A.createReplay(B, { now: T0 + HOUR })
  for (const r of back) rp.feed(r.rec, r.day)
  rp.finish()
  check('facet → replay: the state rebuilt from the file equals the live one (nested nodes)', dump(st) === dump(B), firstDiff(dump(st), dump(B)))
  const a = await F.append('HOST', D, J({ v: 2, rep: [1], n: 1, since: 1, last: 2 }))
  const r1 = await F.replaceTail('HOST', D, a.offset, J({ v: 2, rep: [1], n: 2, since: 1, last: 3 }))
  await F.append('HOST', D, J({ v: 2, id: 'act_x_zz-1', ts: T0, session: 'S', path: '', text: 'later', state: 'running' }))
  const r2 = await F.replaceTail('HOST', D, a.offset, J({ v: 2, rep: [1], n: 3, since: 1, last: 4 }))
  const reps = []; for await (const r of F.readBackwards('HOST')) if (r.rec && r.rec.rep) reps.push(r.rec)
  check('facet: replaceTail rewrites the LAST line in place; once something follows it, it appends instead', r1.rewritten === true && r2.rewritten === false && J(reps.map(x => x.n)) === '[3,2]')
  const file = path.join(dir, 'activity', 'host', `${D}.jsonl`)
  fs.appendFileSync(file, '{"crash-mid-wri')
  const s2 = create({ CFG: {}, HERE: dir, env: { AI_BRIDGE_PERSIST_DIR: dir } })
  await s2.activity.append('HOST', D, J({ v: 2, rep: [9], n: 1, since: 5, last: 6 }))
  const tail = []; for await (const r of s2.activity.readBackwards('HOST')) { tail.push(r); if (tail.length === 2) break }
  check('facet: a partial last line (a crash) is skipped as garbled, and the next append starts on a fresh line', tail[0].rec && J(tail[0].rec.rep) === '[9]' && tail[1].rec === null)
  check('facet: find() returns a logged entry by id, never a cp/rep line', (await F.find('HOST', D, 'act_x_zz-1'))?.text === 'later' && (await F.find('HOST', D, 'nope')) === null)
  await F.append('HOST', '2020-01-02', J({ old: true }))
  check('facet: days() + prune() (retention)', J(await F.days('HOST')) === J(['2020-01-02', D]) && J(await F.prune('HOST', '2021-01-01')) === J(['2020-01-02']) && J(await F.days('HOST')) === J([D]))
  check('facet: a bad day name is refused (no path tricks)', await F.append('HOST', '../../x', '{}').then(() => false, () => true))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { }
})

// ================================================================= the mesh board — grouped by session across hosts
await section(async () => {
  const a = mk({}, 'HOST-A'), b = mk({}, 'HOST-B'), here = mk({}, 'HOST-A')
  const ID = { session: 'Twin', project: 'AIMB', user: 'robin' }
  say(a, ID, { agent: 'worker', text: '@~root on A' }, T0)
  say(b, { ...ID, session: 'TWIN' }, { agent: 'worker', text: '@~root on B' }, T0 + MIN)
  say(b, { ...ID, session: 'TWIN' }, { path: 'worker/@Tharsis/@~z12', text: 'nested on B' }, T0 + MIN)
  say(b, { session: 'Solo', project: 'AIMB', user: 'robin' }, { text: '@~root only B' }, T0)
  say(here, ID, { agent: 'worker', text: '@~root on A' }, T0)
  A.mergeSnapshot(here, 'HOST-B', A.snapshot(b))
  const bv = A.boardView(here, T0 + 2 * MIN)
  const twin = bv.find(g => g.session.toLowerCase() === 'twin'), solo = bv.find(g => g.session === 'Solo')
  check('board: the same session name on two hosts = ONE group spanning both (hosts + multi_host)', bv.length === 2 && !!twin && J(twin.hosts) === J(['HOST-A', 'HOST-B']) && twin.multi_host === true && !('host' in twin))
  check('board: ... with TWO nodes for the same path, each tagged with its host; B\'s nested nodes come along', J(twin.nodes.filter(x => x.path === 'worker').map(x => [x.host, x.current.text])) === J([['HOST-A', 'on A'], ['HOST-B', 'on B']])
    && nodeOf(twin, 'worker/@Tharsis/@z12', 'HOST-B')?.current?.text === 'nested on B' && nodeOf(twin, 'worker/@Tharsis', 'HOST-B')?.implicit === true)
  check('board: ... selves (one per host) + self = the most recently active host\'s', twin.selves.length === 2 && twin.self.host === 'HOST-B' && J(twin.selves.map(x => x.host)) === J(['HOST-A', 'HOST-B']))
  say(here, ID, { text: '@~root the headline lives on A' }, T0 + 30)
  const hl = A.boardView(here, T0 + 2 * MIN).find(g => g.session.toLowerCase() === 'twin')
  check('board (6a): the headline comes from the most recently active host WITH a line of its own (B reported later, but only through its agents)', hl.self.host === 'HOST-A' && hl.self.current.text === 'the headline lives on A', J(hl.self))
  check('board: a one-host group keeps `host`; a remote node\'s log lives on its owner', solo.host === 'HOST-B' && !('hosts' in solo) && solo.self.host === 'HOST-B' && solo.self.log.remote === true && nodeOf(twin, 'worker', 'HOST-A').log.entries === 1)
  check('board: filter by host', A.boardView(here, T0 + 2 * MIN, { host: 'host-b' }).length === 2 && A.boardView(here, T0 + 2 * MIN, { host: 'HOST-A' }).length === 1)
  check('board: stale is computed on the READER\'s side with its own window', A.boardView(here, T0 + 40 * MIN, { session: 'solo' })[0].self.state === 'stale' && A.boardView(here, T0 + 40 * MIN, { session: 'solo', staleMin: 60 })[0].self.state === 'running')
  const loc = A.locateSessions(here, { session: 'twin' })
  check('locateSessions: every host holding the name (local first), filterable by host/project/user', J(loc.map(x => [x.host, x.local])) === J([['HOST-A', true], ['HOST-B', false]])
    && A.locateSessions(here, { session: 'twin', host: 'host-b' }).length === 1 && A.locateSessions(here, { session: 'twin', user: 'kim' }).length === 0 && A.locateSessions(here, {}).length === 0)
  const bLine = N(here, ID, 'worker/@Tharsis/@z12', 'HOST-B').current.id, aLine = N(here, ID, 'worker').current.id
  check('locateEntry: a remote CURRENT line (any depth) names its host; a local one is local; unknown -> null', J(A.locateEntry(here, bLine)) === J({ host: 'HOST-B', local: false }) && A.locateEntry(here, aLine).local === true && A.locateEntry(here, 'nope') === null)
  check('markOriginDown: unknown origin -> false', A.markOriginDown(here, 'NOPE', T0) === false)
  check('markOriginDown: the slice\'s unfinished agents show GONE (last-known lines kept), contexts with them', A.markOriginDown(here, 'HOST-B', T0 + 3 * MIN) === true
    && A.boardView(here, T0 + 3 * MIN, { session: 'solo' })[0].self.state === 'gone' && A.boardView(here, T0 + 3 * MIN, { session: 'solo' })[0].self.current.text === 'only B'
    && nodeOf(A.boardView(here, T0 + 3 * MIN, { session: 'twin' })[0], 'worker', 'HOST-B').state === 'gone' && nodeOf(A.boardView(here, T0 + 3 * MIN, { session: 'twin' })[0], 'worker/@Tharsis/@z12', 'HOST-B').state === 'gone'
    && nodeOf(A.boardView(here, T0 + 3 * MIN, { session: 'twin' })[0], 'worker', 'HOST-A').state === 'running')
  check('remoteInfo: down_at shown', A.remoteInfo(here)[0].host === 'HOST-B' && A.remoteInfo(here)[0].down_at === T0 + 3 * MIN)
  const back = A.mergeSnapshot(here, 'HOST-B', A.snapshot(b))
  check('a fresh full slice from the returning host clears gone (even when identical)', back.changed === true && A.boardView(here, T0 + 4 * MIN, { session: 'solo' })[0].self.state === 'running' && !A.remoteInfo(here)[0].down_at)
  A.markOriginDown(here, 'HOST-B', T0 + 5 * MIN)
  check('expireRemote: a slice down longer than finished_visible_hours is dropped', A.expireRemote(here, T0 + 5 * MIN + 23 * HOUR).length === 0 && J(A.expireRemote(here, T0 + 5 * MIN + 24 * HOUR)) === J(['HOST-B']) && !here.remote.has('HOST-B'))
  check('merge: own origin refused case-insensitively', A.mergeSnapshot(here, 'host-a', A.snapshot(b)).code === 'own-origin')
})

// ================================================================= the wire — planSlice (full / delta / cap) + applySlice (seq), NESTED nodes
await section(async () => {
  const src = mk({}, 'HOST-B'), dst = mk({}, 'HOST-A'), pub = A.createPub()
  const ID = { session: 'S', project: 'P', user: 'u' }
  for (let i = 1; i <= 5; i++) say(src, ID, { agent: `a${i}`, text: `@~root agent ${i}` }, T0 + i * 1000)
  const send = (opts, seq, base) => { const p = A.planSlice(src, pub, opts); return p.body ? { p, frame: { epoch: 'E1', seq, ...(base != null ? { base } : {}), ...JSON.parse(J(p.body)) } } : { p, frame: null } }
  let { p, frame } = send({ full: true }, 1)
  check('planSlice full: v2, every node (root + 5), no remove, not truncated', frame.v === 2 && frame.full === true && frame.sessions.length === 1 && frame.sessions[0].nodes.length === 6 && !frame.remove && !frame.truncated && p.entities === 6)
  check('planSlice full: NO details/data/log on the wire', !J(frame).includes('"details"') && !J(frame).includes('"log"'))
  const m1 = A.applySlice(dst, 'HOST-B', frame)
  check('applySlice full: replaces the origin\'s slice, records epoch/seq', m1.ok && m1.full && dst.remote.get('HOST-B').seq === 1 && dst.remote.get('HOST-B').epoch === 'E1' && agentCount(A.getSession(dst, ID, 'HOST-B')) === 5)
  check('planSlice delta: nothing changed -> no frame', send({}, 2, 1).frame === null)
  say(src, ID, { agent: 'a2', text: '@~root agent 2 moved on' }, T0 + 10000)
  ;({ frame } = send({}, 2, 1))
  check('planSlice delta: carries ONLY the changed node (+ its session header)', frame && !frame.full && frame.v === 2 && frame.sessions.length === 1 && J(frame.sessions[0].nodes.map(x => x.path)) === J(['a2']) && frame.sessions[0].session === 'S')
  const m2 = A.applySlice(dst, 'HOST-B', frame)
  check('applySlice delta: patches that node only; seq advances', m2.ok && m2.changed && dst.remote.get('HOST-B').seq === 2 && N(dst, ID, 'a2', 'HOST-B').current.text === 'agent 2 moved on' && N(dst, ID, 'a1', 'HOST-B').current.text === 'agent 1')
  // 6a: a nested change — only the nodes that changed travel (the target + the agent whose last_activity moved), never the whole subtree
  say(src, ID, { path: 'a3/@Tharsis/@~z12', text: 'deep line', progress: '1/9' }, T0 + 11000)
  ;({ frame } = send({}, 3, 2))
  check('planSlice delta (6a): a nested message → the new nodes + its owner only (a3, a3/@Tharsis, a3/@Tharsis/@z12)', J(frame.sessions[0].nodes.map(x => x.path).sort()) === J(['a3', 'a3/@Tharsis', 'a3/@Tharsis/@z12']), J(frame.sessions[0].nodes.map(x => x.path)))
  A.applySlice(dst, 'HOST-B', frame)
  say(src, ID, { path: 'a3/@Tharsis/@z12', text: 'bar only', progress: '2/9', log: false }, T0 + 12000)
  ;({ frame } = send({}, 4, 3))
  check('planSlice delta (6a): a bar update deep in the tree → that node + the nodes up to its agent (their last_activity) — nothing else', J(frame.sessions[0].nodes.map(x => x.path).sort()) === J(['a3', 'a3/@Tharsis', 'a3/@Tharsis/@z12']), J(frame.sessions[0].nodes.map(x => x.path)))
  A.applySlice(dst, 'HOST-B', frame)
  check('applySlice: the receiver rolls up through the nested nodes itself', A.rollup(A.getSession(dst, ID, 'HOST-B'), N(dst, ID, 'a3', 'HOST-B')).done === 2)
  check('applySlice delta: a replayed / skipped delta is refused out-of-sync', A.applySlice(dst, 'HOST-B', frame).code === 'out-of-sync' && A.applySlice(dst, 'HOST-B', { ...frame, base: 7, seq: 8 }).code === 'out-of-sync'
    && A.applySlice(dst, 'HOST-B', { ...frame, epoch: 'OTHER', base: 4, seq: 5 }).code === 'out-of-sync' && A.applySlice(dst, 'HOST-C', { v: 2, epoch: 'E1', base: 0, seq: 1, sessions: [] }).code === 'out-of-sync')
  check('applySlice: a sync beat (empty delta, base === seq) is accepted, unchanged', (r => r.ok && r.changed === false)(A.applySlice(dst, 'HOST-B', { v: 2, epoch: 'E1', base: 4, seq: 4, sessions: [] })))
  check('applySlice (6a): a v1 (1.61) frame is refused bad-version — full or delta — and nothing changes', A.applySlice(dst, 'HOST-B', { v: 1, full: true, epoch: 'Z', seq: 1, sessions: [] }).code === 'bad-version'
    && A.applySlice(dst, 'HOST-B', { epoch: 'E1', base: 4, seq: 5, sessions: [] }).code === 'bad-version' && dst.remote.get('HOST-B').seq === 4 && agentCount(A.getSession(dst, ID, 'HOST-B')) === 5)
  // removals: a subtree evicted / expired + a whole session gone
  say(src, { session: 'T', project: 'P', user: 'u' }, { text: '@~root second session' }, T0 + 13000)
  ;({ frame } = send({}, 5, 4)); A.applySlice(dst, 'HOST-B', frame)
  say(src, ID, { path: 'a3/@~root', text: 'a3 done', state: 'done' }, T0 + 14000)
  ;({ frame } = send({}, 6, 5)); A.applySlice(dst, 'HOST-B', frame)
  A.expire(src, T0 + 14000 + 25 * HOUR)
  src.local.delete(A.sessionKey({ session: 'T', project: 'P', user: 'u', host: 'HOST-B' }))
  ;({ frame } = send({}, 7, 6))
  check('planSlice delta: removals — every node of the expired subtree and the whole session, by identity', frame && J(frame.remove.map(x => [x.session, x.path || null]).sort()) === J([['S', 'a3'], ['S', 'a3/@Tharsis'], ['S', 'a3/@Tharsis/@z12'], ['T', null]]), J(frame && frame.remove))
  A.applySlice(dst, 'HOST-B', frame)
  check('applySlice delta: removals applied (subtree gone)', !N(dst, ID, 'a3', 'HOST-B') && !N(dst, ID, 'a3/@Tharsis/@z12', 'HOST-B') && A.getSession(dst, { session: 'T', project: 'P', user: 'u' }, 'HOST-B') === null && agentCount(A.getSession(dst, ID, 'HOST-B')) === 4)
  check('deltas converge: the held slice re-snapshots exactly as the source', J(A.snapshot(dst, undefined, 'HOST-B')) === J(A.snapshot(src)), J(A.snapshot(dst, undefined, 'HOST-B')).slice(0, 300))
  // a removal of just the parent on the receiver takes its subtree with it
  const rcv = mk({}, 'HOST-Z'), sp = A.createPub()
  say(src, ID, { path: 'p/@c/@d', text: 'x' }, T0 + 20000)
  A.applySlice(rcv, 'HOST-B', { epoch: 'q', seq: 1, ...JSON.parse(J(A.planSlice(src, sp, { full: true }).body)) })
  A.applySlice(rcv, 'HOST-B', { v: 2, epoch: 'q', seq: 2, base: 1, sessions: [], remove: [{ session: 'S', project: 'P', user: 'u', path: 'p' }] })
  check('applySlice: a node removal on the receiver removes its subtree', !N(rcv, ID, 'p', 'HOST-B') && !N(rcv, ID, 'p/@c/@d', 'HOST-B') && !!N(rcv, ID, 'a1', 'HOST-B'))
  // a CHILD that arrives before its parent (a truncated frame) is held and linked once the parent arrives
  const r2 = mk({}, 'HOST-Y')
  A.applySlice(r2, 'HOST-B', { v: 2, full: true, epoch: 'o', seq: 1, sessions: [{ session: 'S', project: 'P', user: 'u', nodes: [{ path: '' }, { path: 'kid/@ctx', current: { id: 'k', ts: T0, text: 'orphan for now', state: 'running' } }] }] })
  const os2 = A.getSession(r2, ID, 'HOST-B')
  check('orphans: a node whose parent has not arrived is held (not linked under the root)', !!os2.nodes.get('kid/@ctx') && J(A.childrenOf(os2, os2.nodes.get('')).map(n => n.path)) === '[]')
  A.applySlice(r2, 'HOST-B', { v: 2, epoch: 'o', seq: 2, base: 1, sessions: [{ session: 'S', project: 'P', user: 'u', nodes: [{ path: 'kid' }] }] })
  check('orphans: ... and linked once the parent arrives', J(A.childrenOf(os2, os2.nodes.get('kid')).map(n => n.path)) === J(['kid/@ctx']) && J(A.childrenOf(os2, os2.nodes.get('')).map(n => n.path)) === J(['kid']))
  const forged = JSON.parse(J(A.planSlice(src, A.createPub(), { full: true }).body)); forged.sessions[0].host = 'HOST-C'; forged.origin = 'HOST-C'
  A.applySlice(dst, 'HOST-D', { ...forged, epoch: 'X', seq: 1 })
  check('applySlice: ownership is the link\'s origin — the frame\'s origin/host fields never decide it', dst.remote.has('HOST-D') && !dst.remote.has('HOST-C') && A.getSession(dst, ID, 'HOST-D').host === 'HOST-D'
    && A.applySlice(dst, 'host-a', { v: 2, full: true, sessions: [] }).code === 'own-origin' && A.applySlice(dst, 'HOST-E', { v: 2, sessions: 'x' }).code === 'bad-slice')
  A.markOriginDown(dst, 'HOST-B', T0 + 20000)
  check('applySlice: a delta for a slice marked down is refused out-of-sync', A.applySlice(dst, 'HOST-B', { v: 2, epoch: 'E1', base: 7, seq: 7, sessions: [] }).code === 'out-of-sync')
})
await section(async () => {
  const src = mk({}, 'HOST-B'), dst = mk({}, 'HOST-A'), pub = A.createPub()
  const ID = { session: 'Big', project: 'P', user: 'u' }
  for (let i = 1; i <= 10; i++) say(src, ID, { agent: `ag${String(i).padStart(2, '0')}`, text: `@~root line ${i} ${'x'.repeat(150)}` }, T0 + i * 1000)
  const p1 = A.planSlice(src, pub, { full: true, maxBytes: 1500 })
  const got1 = (p1.body.sessions[0].nodes || []).map(x => x.path).filter(Boolean)
  check('cap: an oversized full slice is TRUNCATED (flagged) and stays under the cap', p1.body.truncated === true && p1.pending === true && got1.length >= 2 && got1.length < 10 && J(p1.body).length <= 1500 + 400)
  check('cap: newest-active first (ag10, ag09, …)', J(got1) === J(Array.from({ length: got1.length }, (_, i) => `ag${String(10 - i).padStart(2, '0')}`)), J(got1))
  A.applySlice(dst, 'HOST-B', { epoch: 'E', seq: 1, ...p1.body })
  check('cap: the receiver holds the partial slice, flagged truncated', agentCount(A.getSession(dst, ID, 'HOST-B')) === got1.length && A.remoteInfo(dst)[0].truncated === true)
  let seq = 1, frames = 0, p
  while ((p = A.planSlice(src, pub, { maxBytes: 1500 })).body && frames < 20) { A.applySlice(dst, 'HOST-B', { epoch: 'E', base: seq, seq: seq + 1, ...p.body }); seq++; frames++ }
  check('cap: the rest follows in later deltas until the slice is complete', frames >= 1 && agentCount(A.getSession(dst, ID, 'HOST-B')) === 10 && !A.remoteInfo(dst)[0].truncated
    && J(A.snapshot(dst, undefined, 'HOST-B')) === J(A.snapshot(src)))
  const tiny = A.planSlice(src, A.createPub(), { full: true, maxBytes: 10 })
  check('cap: a cap smaller than one node still sends one (and flags the rest)', tiny.entities === 1 && tiny.body.truncated === true)
})

// ================================================================= paged log (the remote-history chunk)
await section(async () => {
  const st = mk({ log_entries_per_agent: 50 }), I = S1
  const ids = []
  for (let i = 0; i < 7; i++) ids.push(say(st, I, { agent: 'p', text: `entry ${i} ${'y'.repeat(100)}` }, T0 + i * 1000).id)
  const p1 = A.logView(st, { session: 'Bridget', agent: 'p', limit: 3 }, T0 + MIN)
  const p2 = A.logView(st, { session: 'Bridget', agent: 'p', limit: 3, cursor: p1.next_cursor }, T0 + MIN)
  const p3 = A.logView(st, { session: 'Bridget', agent: 'p', limit: 3, cursor: p2.next_cursor }, T0 + MIN)
  check('paging: three pages newest first, a cursor chaining them, null at the end', J(p1.entries.map(e => e.id)) === J([ids[6], ids[5], ids[4]]) && J(p2.entries.map(e => e.id)) === J([ids[3], ids[2], ids[1]])
    && J(p3.entries.map(e => e.id)) === J([ids[0]]) && p1.next_cursor === ids[4] && p3.next_cursor === null && p1.total === 7)
  const pe = A.logView(st, { session: 'Bridget', agent: 'p', limit: 50 }, T0 + MIN, { maxEntries: 2 })
  check('paging: opts.maxEntries caps the page (the owner\'s page size)', pe.entries.length === 2 && pe.next_cursor === ids[5])
  const pb = A.logView(st, { session: 'Bridget', agent: 'p' }, T0 + MIN, { maxBytes: 400 })
  check('paging: opts.maxBytes caps the page (at least one entry)', pb.entries.length >= 1 && pb.entries.length < 7 && J(pb.entries).length <= 400 + 80 && !!pb.next_cursor
    && A.logView(st, { session: 'Bridget', agent: 'p' }, T0 + MIN, { maxBytes: 1 }).entries.length === 1)
  N(st, I, 'p').log.splice(0, 5)
  const pt = A.logView(st, { session: 'Bridget', agent: 'p', cursor: ids[3] }, T0 + MIN)
  check('paging: a cursor whose entry was dropped continues from its time', pt.ok && pt.entries.length === 0 && pt.next_cursor === null)
  check('paging: without a cursor or caps the view is unchanged (all, newest first)', A.logView(st, { session: 'Bridget', agent: 'p' }, T0 + MIN).entries.length === 2)
  const pst = mk({ log_entries_per_agent: 10 }), pid = []
  for (let i = 0; i < 14; i++) pid.push(say(pst, S1, { agent: 'deep', text: `@step e${i}` }, T0 + i * 1000).id)
  const m1 = A.logView(pst, { session: 'Bridget', agent: 'deep', limit: 6 }, T0 + MIN, { files: true })
  const m2 = A.logView(pst, { session: 'Bridget', agent: 'deep', limit: 6, cursor: m1.next_cursor }, T0 + MIN, { files: true })
  check('files: memory first; a page that exhausts memory with room left carries a files descriptor (target, before = the floor, room)', !m1.files && m1.entries.length === 6 && m2.entries.length === 4 && m2.files?.need === 2
    && m2.files.before.ts === T0 + 3000 && m2.files.target.key === 'deep' && m2.files.target.session === 'Bridget' && m2.files.from === null, J(m2.files && { ...m2.files, before: m2.files.before && m2.files.before.ts }))
  const fresh = mk(), fid = []
  for (let i = 0; i < 4; i++) fid.push(say(fresh, S1, { path: 'n/@c', text: `f${i}` }, T0 + i * 1000).id)
  const q1 = A.logView(fresh, { session: 'Bridget', path: 'n', limit: 3 }, T0 + MIN, { files: true }), q2 = A.logView(fresh, { session: 'Bridget', path: 'n', limit: 3, cursor: q1.next_cursor }, T0 + MIN, { files: true })
  check('files: no floor → the files continue before the OLDEST memory entry, skipping every memory id at that time (the one served on this very page included)', q2.entries.length === 1 && q2.files?.before?.ts === T0 && q2.files.before.ids.has(fid[0]), J(q2.files && { ts: q2.files.before?.ts, ids: [...(q2.files.before?.ids || [])] }))
  const m3 = A.logView(pst, { session: 'Bridget', agent: 'deep', limit: 4, cursor: m1.next_cursor }, T0 + MIN, { files: true })
  check('files: a page filled exactly at the end of memory → its last id as the cursor (the next page starts in the files)', !m3.files && m3.entries.length === 4 && m3.next_cursor === pid[4])
  check('files: without opts.files the old view is unchanged (no descriptor, null cursor at the end)', !A.logView(pst, { session: 'Bridget', agent: 'deep', limit: 4, cursor: m1.next_cursor }, T0 + MIN).files
    && A.logView(pst, { session: 'Bridget', agent: 'deep', limit: 4, cursor: m1.next_cursor }, T0 + MIN).next_cursor === null)
  const fc = A.logView(pst, { session: 'Bridget', agent: 'deep', cursor: 'f1.2026-10-01.99' }, T0 + MIN, { files: true })
  check('files: a file cursor → no memory entries, a descriptor starting there; refused without opts.files', fc.ok && fc.entries.length === 0 && J(fc.files.from) === J({ day: '2026-10-01', offset: 99 })
    && A.logView(pst, { session: 'Bridget', agent: 'deep', cursor: 'f1.2026-10-01.99' }, T0 + MIN).code === 'bad-cursor')
  check('file cursor: format + parse (and garbage → null)', A.fileCursor('2026-10-02', 1234) === 'f1.2026-10-02.1234' && J(A.parseFileCursor('f1.2026-10-02.1234')) === J({ day: '2026-10-02', offset: 1234 })
    && A.parseFileCursor('act_x_1-2') === null && A.parseFileCursor('f1.2026-1-2.5') === null)
})

// ================================================================= the dashboard's raw board, node units + deltas, bells, host down
await section(async () => {
  const here = mk({}, 'HOST-A'), there = mk({}, 'HOST-B')
  say(here, S1, { agent: 'w1', text: '@~root seeding {progress}', progress: '2/8 tiles', eta: '20m' }, T0)
  say(here, S1, { path: '@#70/@step4/spec-70', text: '@Tharsis/@~z12 deep {progress}', progress: '1/4 tiles' }, T0)
  say(there, { ...S1, session: 'Remote' }, { agent: 'r1', text: '@~root over there' }, T0)
  A.applySlice(here, 'HOST-B', { v: 2, full: true, epoch: 'e', seq: 1, sessions: A.snapshot(there).sessions })
  const raw = A.boardView(here, T0 + 40 * MIN, { raw: true }), g = raw.find(x => x.session === 'Bridget'), w1 = nodeOf(g, 'w1')
  check('raw board: the REPORTED state even past the stale window (the page computes stale), no rendered / stale_at / visible', w1.state === 'running' && !('stale_at' in w1) && !('visible' in w1) && w1.current.text === 'seeding {progress}' && !('rendered' in w1.current)
    && w1.last_activity === T0 && w1.progress.done === 2 && w1.eta_at === T0 + 20 * MIN, J(w1))
  const z = nodeOf(g, '@#70/@step4/spec-70/@Tharsis/@z12'), sp = nodeOf(g, '@#70/@step4/spec-70')
  check('raw board (6a): every node with key, parent_key, kind, depth; own progress + the rolled-up bar', z.kind === 'context' && z.depth === 5 && z.parent_key === '@#70/@step4/spec-70/@tharsis' && z.key === '@#70/@step4/spec-70/@tharsis/@z12'
    && J(z.progress) === J({ done: 1, total: 4, unit: 'tiles' }) && sp.progress == null && sp.bar.done === 1 && sp.bar.rollup === true && nodeOf(g, '@#70').implicit === true, J([z, sp]))
  check('raw board: the non-raw (tool) view — stale + rendered', nodeOf(A.boardView(here, T0 + 40 * MIN).find(x => x.session === 'Bridget'), 'w1').state === 'stale' && nodeOf(A.boardView(here, T0).find(x => x.session === 'Bridget'), 'w1').current.rendered === 'seeding 2 of 8 tiles')
  const pub = new Map(), u1 = A.dashUnits(raw)
  const f = A.planDashDelta(pub, u1, { full: true })
  const nNodes = raw.reduce((s, x) => s + x.nodes.length, 0)
  check('dash units: one per session group + one per NODE (kind "node", nkind, group key, stable ids); sessions first, parents before children', u1.size === 2 + nNodes && f.upsert.filter(u => u.kind === 'session').length === 2
    && f.upsert.filter(u => u.kind === 'node').every(u => u.group && JSON.parse(u.id)[0] === 'n' && (u.nkind === 'agent' || u.nkind === 'context')) && f.upsert.findIndex(u => u.kind === 'node') > f.upsert.map(u => u.kind).lastIndexOf('session')
    && (ups => ups.findIndex(u => u.path === '@#70') < ups.findIndex(u => u.path === '@#70/@step4/spec-70/@Tharsis/@z12'))(f.upsert), J(f.upsert.map(u => [u.kind, u.path || u.session])))
  check('dash delta: nothing changed → empty (time passing is not a change in the raw form)', A.planDashDelta(pub, A.dashUnits(A.boardView(here, T0 + 50 * MIN, { raw: true }))).empty)
  say(here, S1, { path: '@#70/@step4/spec-70/@Tharsis/@z12', text: 'deep {progress}', progress: '3/4 tiles', log: false }, T0 + MIN)
  const d1 = A.planDashDelta(pub, A.dashUnits(A.boardView(here, T0 + MIN, { raw: true })))
  check('dash delta (6a): a deep bar update → that node, the nodes whose rolled-up bar moved, its agent and the session header — no siblings', d1.upsert.some(u => u.path === '@#70/@step4/spec-70/@Tharsis/@z12' && u.progress.done === 3)
    && d1.upsert.some(u => u.path === '@#70' && u.bar.done === 3) && !d1.upsert.some(u => u.path === 'w1') && d1.upsert.some(u => u.kind === 'session') && !d1.remove.length, J(d1.upsert.map(u => u.path ?? u.session)))
  A.dropOrigin(here, 'HOST-B')
  const d2 = A.planDashDelta(pub, A.dashUnits(A.boardView(here, T0 + MIN, { raw: true })))
  check('dash delta: a group that left → its session + node ids removed', d2.remove.length === 2 && !d2.upsert.length, J(d2))
  A.applySlice(here, 'HOST-B', { v: 2, full: true, epoch: 'e2', seq: 1, sessions: A.snapshot(there).sessions })
  A.markSessionGone(here, S1, T0 + 2 * MIN)
  A.markOriginDown(here, 'HOST-B', T0 + 3 * MIN)
  const bd = A.boardView(here, T0 + 3 * MIN, { raw: true }), gL = bd.find(x => x.session === 'Bridget'), gR = bd.find(x => x.session === 'Remote')
  check('gone vs host down: a session that left → gone, no host_down; a host down → gone + host_down + the group\'s hosts_down; a raw context keeps its own state', nodeOf(gL, 'w1').state === 'gone' && nodeOf(gL, 'w1').was === 'running' && !nodeOf(gL, 'w1').host_down && !gL.hosts_down
    && nodeOf(gR, 'r1').state === 'gone' && nodeOf(gR, 'r1').host_down === T0 + 3 * MIN && J(gR.hosts_down) === J(['HOST-B']) && gR.self.host_down === T0 + 3 * MIN && nodeOf(gL, '@#70/@step4/spec-70/@Tharsis/@z12').state === 'running')
  check('host down: the tool view carries host_down too', nodeOf(A.boardView(here, T0 + 3 * MIN).find(x => x.session === 'Remote'), 'r1').host_down === T0 + 3 * MIN)
  const b = mk({}, 'HOST-A')
  say(b, S1, { text: '@~root hi' }, T0); say(b, { ...S1, session: 'Other', project: 'X' }, { text: '@~root yo' }, T0)
  check('bells: a watch by name (+ project) marks the matching local session only; a change is reported once', A.setBells(b, [{ name: 'BRIDGET', project: 'aimb' }]) === true && A.setBells(b, [{ name: 'bridget', project: 'AIMB' }]) === false
    && A.getSession(b, S1).bell === true && !A.getSession(b, { ...S1, session: 'Other', project: 'X' }).bell)
  check('bells: a watch naming another project does not match; none → cleared', A.setBells(b, [{ name: 'Bridget', project: 'Other' }]) === true && !A.getSession(b, S1).bell && A.setBells(b, []) === false)
  A.setBells(b, [{ name: 'other' }])
  const snapB = A.snapshot(b)
  check('bells: the flag rides the gossip (snapshot / header)', snapB.sessions.find(s => s.session === 'Other').bell === true && !('bell' in snapB.sessions.find(s => s.session === 'Bridget')))
  const rcv = mk({}, 'HOST-Z'), bp = A.createPub()
  A.applySlice(rcv, 'HOST-A', { epoch: 'q', seq: 1, ...A.planSlice(b, bp, { full: true }).body })
  const bell1 = A.boardView(rcv, T0).find(x => x.session === 'Other').bell
  A.setBells(b, [{ name: 'bridget' }])
  A.applySlice(rcv, 'HOST-A', { epoch: 'q', seq: 2, base: 1, ...A.planSlice(b, bp).body })
  const bv2 = A.boardView(rcv, T0)
  check('bells: ... the receiver\'s board shows them, and a header-only delta moves them', bell1 === true && bv2.find(x => x.session === 'Bridget').bell === true && !bv2.find(x => x.session === 'Other').bell, J(bv2.map(x => [x.session, x.bell])))
})

// ================================================================= 6a: BATCH — splitBatch (bounds, defaults, per-item errors)
await section(async () => {
  const sb = A.splitBatch
  const okB = sb({ items: [{ text: 'a', ref: 1 }, { path: 'x/@~y', text: 'b' }], agent: 'w', log: false })
  check('batch: items split in order, refs kept, top-level path/agent/context/log are DEFAULTS (the item wins)', okB.ok && okB.items.length === 2 && okB.items[0].ref === 1 && okB.items[0].input.agent === 'w' && okB.items[0].input.log === false && !('ref' in okB.items[0].input)
    && okB.items[1].input.path === 'x/@~y' && !('ref' in okB.items[1]))
  check('batch: an item overriding a default', sb({ items: [{ text: 'a', log: true }], log: false }).items[0].input.log === true)
  check('batch: an item naming its own path / agent takes NONE of the address defaults (path, agent, context); one with only a context keeps agent / path', !('agent' in okB.items[1].input)
    && (x => x.path === 'p' && !('context' in x) && !('agent' in x) && x.log === false)(A.withDefaults({ agent: 'w', context: '@~c', log: false }, { path: 'p', text: 't' }))
    && (x => x.agent === 'w' && x.path === 'q' && x.context === '@~root')(A.withDefaults({ agent: 'w', path: 'q', context: '@~c' }, { context: '@~root', text: 't' })))
  check('batch: 64 items OK; 65 → too-many-items (the whole call)', sb({ items: Array.from({ length: 64 }, () => ({ text: 'x' })) }).ok && sb({ items: Array.from({ length: 65 }, () => ({ text: 'x' })) }).code === 'too-many-items')
  const big = Array.from({ length: 20 }, () => ({ text: 'x', details: rep('d', 4000) }))
  check('batch: > 64 KB of items JSON → batch-too-large (the whole call)', sb({ items: big }).code === 'batch-too-large' && sb({ items: big.slice(0, 15) }).ok)
  check('batch: not an array / empty / other top-level message fields → bad-batch', sb({ items: 'x' }).code === 'bad-batch' && sb({ items: [] }).code === 'bad-batch' && sb({ items: [{ text: 'x' }], text: 'top' }).code === 'bad-batch' && sb(null).code === 'bad-batch')
  const per = sb({ items: [{ text: 'ok' }, 'junk', { text: 'x', bogus: 1, ref: 'r3' }, { text: 'x', plan: ['A'], ref: 'p' }] })
  check('batch: a bad item gets its OWN error (bad-item / bad-field / not-yet for plan), the rest stay applicable', per.ok && !!per.items[0].input && per.items[1].error.code === 'bad-item' && per.items[2].error.code === 'bad-field' && per.items[2].ref === 'r3'
    && per.items[3].error.code === 'not-yet' && per.items[3].ref === 'p')
  check('parseMessage refuses an items object (it is a batch)', C({ items: [{ text: 'x' }] }) === 'bad-input')
  // applied in order, one result each, partial failure
  const st = mk(), I = S1
  const sp = sb({ items: [{ path: 'a/@~t', text: 'first' }, { path: 'a/@~t', text: 'second', state: 'bogus' }, { path: 'a/@~t', text: 'third' }, { path: 'a/b/c/d/e/f/g', text: 'too deep' }] })
  const res = sp.items.map(it => { if (it.error) return it.error; const p = P(it.input, { now: T0 }); return p.ok ? A.apply(st, I, p.msg, T0) : p })
  check('batch (applied in order): per-item results; a bad item fails alone; the last good line wins', res[0].ok && res[1].code === 'bad-state' && res[2].ok && res[3].code === 'path-too-deep' && N(st, I, 'a/@t').current.text === 'third' && N(st, I, 'a/@t').log.length === 2)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
