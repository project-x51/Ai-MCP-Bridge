// Fast UNIT tests for lib/activity.js — the pure core of #70 (agent activity board), build-plan steps 1 + 2. No bridge,
// no sockets, no clock: every time is an explicit `now`. Covers parsing (prefixes, limits, progress/eta/stale_after),
// apply semantics (@ vs @~, stickiness, finish, details/data retention, log cap, context/agent limits + eviction),
// the derived views (stale, gone, rollup, visibility), the gossip snapshot + per-origin merge, the memory budget and
// resolveConfig's env/config precedence. Step 2: the session identity, the log flag, default text + placeholders
// (renderText), persistence markers, checkpoints (cp/rep), the read views, the newest-first replay (== a chronological
// apply on seeded random sequences; phase 1; windows; instances) and the file facet's daily JSONL (temp dir).
import * as A from '../lib/activity.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
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

// ================================================================= constants
check('limits: the locked #70 values', A.ACTIVITY_LIMITS.text === 240 && A.ACTIVITY_LIMITS.context === 60 && A.ACTIVITY_LIMITS.pathDepth === 3
  && A.ACTIVITY_LIMITS.contextsPerAgent === 32 && A.ACTIVITY_LIMITS.agentsPerSession === 128 && A.ACTIVITY_LIMITS.detailsBytes === 4096
  && A.ACTIVITY_LIMITS.dataBytes === 16384 && A.ACTIVITY_LIMITS.staleAfterMaxMs === 24 * HOUR)
check('limits + defaults are frozen', Object.isFrozen(A.ACTIVITY_LIMITS) && Object.isFrozen(A.ACTIVITY_DEFAULTS) && Object.isFrozen(A.ACTIVITY_STATES))
check('defaults: the #70 per-host config (+ step 2 progress_checkpoint_sec)', J(A.ACTIVITY_DEFAULTS) === J({ log_retention_days: 7, log_entries_per_agent: 200, stale_after_min: 15, finished_visible_hours: 24, memory_budget_mb: 64, progress_checkpoint_sec: 60, enabled: true }))
check('states: running|blocked|failed|done|idle', J(A.ACTIVITY_STATES) === J(['running', 'blocked', 'failed', 'done', 'idle']))
check('env names: AI_BRIDGE_ACTIVITY_<KEY>', A.ACTIVITY_ENV.stale_after_min === 'AI_BRIDGE_ACTIVITY_STALE_AFTER_MIN' && A.ACTIVITY_ENV.enabled === 'AI_BRIDGE_ACTIVITY_ENABLED' && A.ACTIVITY_ENV.progress_checkpoint_sec === 'AI_BRIDGE_ACTIVITY_PROGRESS_CHECKPOINT_SEC' && Object.keys(A.ACTIVITY_ENV).length === 7)

// ================================================================= resolveConfig
{
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
}

// ================================================================= parseDuration
{
  const D = A.parseDuration
  check('duration: 15m / 1h25m / 1h 25m / 90s / 2d / 1.5h', D('15m') === 15 * MIN && D('1h25m') === 85 * MIN && D('1h 25m') === 85 * MIN && D('90s') === 90000 && D('2d') === 48 * HOUR && D('1.5h') === 90 * MIN)
  check('duration: number and bare numeric string = minutes', D(15) === 15 * MIN && D('15') === 15 * MIN && D(' 2.5 ') === 150000)
  check('duration: case-insensitive units', D('1H30M') === 90 * MIN)
  check('duration: junk is NaN', [D('abc'), D('15x'), D(''), D('m'), D('1h25'), D(null), D({}), D(-5), D('-5m')].every(Number.isNaN))
  check('duration: zero parses as 0 (callers reject it)', D('0m') === 0 && D(0) === 0)
}

// ================================================================= parseMessage: context prefixes
{
  const m1 = M({ text: 'plain status' })
  check('prefix: none -> @root, log-only', m1.context === 'root' && m1.root && !m1.current && m1.text === 'plain status')
  const m2 = M({ text: '@build compiling' })
  check('prefix: @name -> that context, log-only, prefix stripped', m2.context === 'build' && !m2.root && !m2.current && m2.text === 'compiling')
  const m3 = M({ text: '@~build compiling' })
  check('prefix: @~name -> current', m3.context === 'build' && m3.current && m3.text === 'compiling')
  const m4 = M({ text: '@"CTX strip 17" tiling' })
  check('prefix: @"quoted name" with spaces', m4 && m4.context === 'CTX strip 17' && !m4.current && m4.text === 'tiling')
  const m5 = M({ text: '@~"CTX strip 17" tiling' })
  check('prefix: @~"quoted name" -> current', m5 && m5.context === 'CTX strip 17' && m5.current && m5.text === 'tiling')
  check('prefix: @root / @~root / @~ROOT are the root context', (a => a.context === 'root' && a.root && !a.current)(M({ text: '@root hi' }))
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
  // context name length
  check('context: 60 chars OK, 61 rejected (prefix)', M({ text: `@~${rep('c', 60)} x` }).context.length === 60 && C({ text: `@~${rep('c', 61)} x` }) === 'context-too-long')
  check('context: 60 chars OK, 61 rejected (quoted)', M({ text: `@"${rep('c', 59)} " x` }).context.length === 59 && C({ text: `@"${rep('c', 30)} ${rep('c', 30)}" x` }) === 'context-too-long')
  check('context: 60 chars OK, 61 rejected (param)', M({ text: 'x', context: rep('c', 60) }) !== null && C({ text: 'x', context: rep('c', 61) }) === 'context-too-long')
  check('context: length counts code points (60 emoji OK, 61 not)', M({ text: `@${rep('🙂', 60)} x` }) !== null && C({ text: `@${rep('🙂', 61)} x` }) === 'context-too-long')
  check('context: control chars rejected', C({ text: 'x', context: 'a\u0001b' }) === 'bad-context')
  check('normContextName: exported + canonical root', A.normContextName('ROOT').name === 'root' && A.normContextName('  a  b ').name === 'a b' && !A.normContextName('').ok)
}

// ================================================================= parseMessage: text
{
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
}

// ================================================================= parseMessage: agent / state / input
{
  check('agent: absent / empty -> null (the session itself)', M({ text: 'x' }).agent === null && M({ text: 'x', agent: '' }).agent === null && M({ text: 'x', agent: null }).agent === null)
  check('agent: 1..3 levels', M({ text: 'x', agent: 'a' }).agent === 'a' && M({ text: 'x', agent: 'spec-70/research' }).agent === 'spec-70/research' && M({ text: 'x', agent: 'a/b/c' }).agent === 'a/b/c')
  check('agent: 4 levels -> agent-too-deep', C({ text: 'x', agent: 'a/b/c/d' }) === 'agent-too-deep')
  check('agent: segments trimmed, outer slashes dropped', M({ text: 'x', agent: ' /a / b/ ' }).agent === 'a/b')
  check('agent: empty inner segment -> bad-agent', C({ text: 'x', agent: 'a//b' }) === 'bad-agent' && C({ text: 'x', agent: '/' }) === 'bad-agent')
  check('agent: spaces / odd chars -> bad-agent', C({ text: 'x', agent: 'has space' }) === 'bad-agent' && C({ text: 'x', agent: 'a$b' }) === 'bad-agent' && C({ text: 'x', agent: '-lead' }) === 'bad-agent')
  check('agent: allowed punctuation + unicode letters', M({ text: 'x', agent: 'w_1.a:b#2+c-d' }) !== null && M({ text: 'x', agent: 'agënt/分析' }) !== null)
  check('agent: segment 48 OK, 49 rejected', M({ text: 'x', agent: rep('a', 48) }) !== null && C({ text: 'x', agent: rep('a', 49) }) === 'bad-agent')
  check('agent: non-string -> bad-agent', C({ text: 'x', agent: 7 }) === 'bad-agent')
  check('state: each reported state accepted (case-insensitive)', A.ACTIVITY_STATES.every(s => M({ text: 'x', state: s.toUpperCase() }).state === s))
  check('state: absent -> null (apply picks the default)', M({ text: 'x' }).state === null && M({ text: 'x', state: '' }).state === null)
  check('state: derived/unknown states rejected', C({ text: 'x', state: 'stale' }) === 'bad-state' && C({ text: 'x', state: 'gone' }) === 'bad-state' && C({ text: 'x', state: 'ok' }) === 'bad-state' && C({ text: 'x', state: 3 }) === 'bad-state')
  check('input: non-object -> bad-input', C(null) === 'bad-input' && C([]) === 'bad-input' && C('text') === 'bad-input')
  const r = P({ text: 'x', state: 'nope' })
  check('input: a failure carries code + a human "what"', r.ok === false && r.code === 'bad-state' && typeof r.what === 'string' && r.what.length > 5)
}

// ================================================================= parseMessage: progress
{
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
}

// ================================================================= parseMessage: eta
{
  const eta = (v, opts = { now: T0, tzOffsetMin: 0 }) => { const r = P({ text: 'x', eta: v }, opts); return r.ok ? r.msg.eta_at : r.code }
  check('eta: 15m / 1h25m / 90s from now', eta('15m') === T0 + 15 * MIN && eta('1h25m') === T0 + 85 * MIN && eta('90s') === T0 + 90000)
  check('eta: number = minutes', eta(10) === T0 + 10 * MIN)
  check('eta: 7d OK, longer rejected', eta('7d') === T0 + 7 * 86400000 && eta('7d1s') === 'bad-eta')
  check('eta: zero / junk rejected', eta('0m') === 'bad-eta' && eta('soon') === 'bad-eta' && eta('25:00') === 'bad-eta' && eta('12:60') === 'bad-eta')
  // T0 = 06:00 UTC. At +13:00 (780) local is 19:00.
  check('eta: "19:27" local at +13:00 -> 27 min from now', eta('19:27', { now: T0, tzOffsetMin: 780 }) === T0 + 27 * MIN)
  check('eta: a passed clock time rolls to tomorrow', eta('18:00', { now: T0, tzOffsetMin: 780 }) === T0 + 23 * HOUR)
  check('eta: the current minute exactly rolls to tomorrow', eta('19:00', { now: T0, tzOffsetMin: 780 }) === T0 + 24 * HOUR)
  check('eta: "19:27" at UTC (offset 0) -> 13h27m', eta('19:27') === T0 + 13 * HOUR + 27 * MIN)
  check('eta: clock at a negative offset (-05:00 local 01:00) "9:05"', eta('9:05', { now: T0, tzOffsetMin: -300 }) === T0 + 8 * HOUR + 5 * MIN)
  check('eta: crossing local midnight (+13:00, "00:30" -> 5h30m)', eta('00:30', { now: T0, tzOffsetMin: 780 }) === T0 + 5 * HOUR + 30 * MIN)
  check('eta: without now -> bad-eta', P({ text: 'x', eta: '15m' }).code === 'bad-eta')
  check('eta: "none" -> explicit clear (null), needs no now', (r => r.ok && r.msg.eta_at === null)(P({ text: 'x', eta: 'none' })))
  check('parseEta exported (NaN on no clock)', Number.isNaN(A.parseEta('15m', undefined)) && A.parseEta('15m', 0) === 15 * MIN)
}

// ================================================================= parseMessage: stale_after / details / data
{
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
}

// ================================================================= apply: basics
{
  const st = mk()
  const r = say(st, S1, { text: 'starting up' }, T0)
  check('apply: ok + the #70 return shape', r.ok && typeof r.id === 'string' && r.ts === T0 && r.current === false && r.agent === null && r.context === 'root' && r.state === 'running'
    && r.stale_at === T0 + 15 * MIN && Array.isArray(r.evicted) && r.evicted.length === 0 && Array.isArray(r.warnings), J(r))
  const sess = A.getSession(st, S1)
  check('apply: auto-creates the session (+ its own entity with @root)', !!sess && sess.session === 'Bridget' && sess.project === 'AIMB' && sess.user === 'robin' && sess.host === 'ROBIN-Z790'
    && sess.self.contexts.has('root') && sess.agents.size === 0 && sess.origin === 'HOST-A')
  check('apply: a plain message logs to @root without setting the current line', sess.self.log.length === 1 && sess.self.contexts.get('root').current === null)
  check('apply: in-memory entry is small (no details/data keys; current:false omitted)', J(Object.keys(sess.self.log[0])) === J(['id', 'ts', 'context', 'text', 'state']))
  check('apply: the returned entry carries identity for the JSONL', r.entry.session === 'Bridget' && r.entry.project === 'AIMB' && r.entry.agent === null && r.entry.origin === 'HOST-A'
    && r.entry.host === 'ROBIN-Z790' && r.entry.user === 'robin' && r.entry.current === false && r.entry.details === null && r.entry.data === null)
  const r2 = say(st, S1, { text: 'second' }, T0 + 1)
  check('apply: entry ids unique + ordered', r2.id !== r.id && r2.id > r.id)
  check('apply: session lookup is case-insensitive on session + project + user (+ realm, default "default")', A.getSession(st, { session: 'BRIDGET', project: 'aimb', user: 'ROBIN' }) === sess
    && A.getSession(st, { session: 'Bridget', project: 'AIMB', user: 'robin', realm: 'DEFAULT' }) === sess)
  check('apply: the session key needs the user (step 2: realm + project + user + session)', A.getSession(st, { session: 'Bridget', project: 'AIMB' }) === null)
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
}

// ================================================================= apply: @ vs @~, stickiness, default state, finish
{
  const st = mk(), I = S1, A1 = 'worker'
  const e = () => A.getEntity(st, I, A1)
  const ctx = n => e().contexts.get(n)
  const r1 = say(st, I, { agent: A1, text: '@build compiling', progress: '1/4', eta: '10m', state: 'blocked' }, T0)
  check('@: creates the agent + context; does NOT set the current line', r1.ok && r1.agent === 'worker' && r1.context === 'build' && !r1.current && ctx('build').current === null)
  check('@: progress + eta move the bar (step 2: ANY message); state stays in the log entry only', J(ctx('build').progress) === J({ done: 1, total: 4, unit: '' }) && ctx('build').eta_at === T0 + 10 * MIN
    && e().log[0].progress.done === 1 && e().log[0].eta_at === T0 + 10 * MIN && e().log[0].state === 'blocked' && A.stateOf(ctx('build')) === 'running')
  const r2 = say(st, I, { agent: A1, text: '@~build 2 of 4', progress: '2/4 files', eta: '8m' }, T0 + MIN)
  check('@~: sets the current line + progress + eta', r2.current && ctx('build').current.text === '2 of 4' && ctx('build').current.id === r2.id && J(ctx('build').progress) === J({ done: 2, total: 4, unit: 'files' }) && ctx('build').eta_at === T0 + MIN + 8 * MIN)
  check('@~: the default state is running when the context has no current line', r2.state === 'running')
  say(st, I, { agent: A1, text: '@~build still going' }, T0 + 2 * MIN)
  check('@~: progress + eta are STICKY (kept when a later @~ omits them)', ctx('build').current.text === 'still going' && ctx('build').progress.done === 2 && ctx('build').eta_at === T0 + 9 * MIN)
  say(st, I, { agent: A1, text: '@~build waiting on review', state: 'blocked' }, T0 + 3 * MIN)
  const r4 = say(st, I, { agent: A1, text: '@build pinged Robin' }, T0 + 4 * MIN)
  check('default state: an @ entry inherits the context\'s current state', r4.state === 'blocked' && e().log[e().log.length - 1].state === 'blocked')
  const r5 = say(st, I, { agent: A1, text: '@~build new line' }, T0 + 5 * MIN)
  check('default state: an @~ line inherits it too', r5.state === 'blocked' && A.stateOf(ctx('build')) === 'blocked')
  say(st, I, { agent: A1, text: '@build it failed?', state: 'failed' }, T0 + 6 * MIN)
  check('@ with an explicit state does not change the context state', A.stateOf(ctx('build')) === 'blocked')
  check('default state: a new context starts running', say(st, I, { agent: A1, text: '@fresh hi' }, T0 + 6 * MIN).state === 'running')
  say(st, I, { agent: A1, text: '@~build cleared', progress: 'none', eta: 'none', state: 'running' }, T0 + 7 * MIN)
  check('"none" clears progress + eta', ctx('build').progress === null && ctx('build').eta_at === null)
  say(st, I, { agent: A1, text: '@~build again', progress: '3/4', eta: '5m' }, T0 + 8 * MIN)
  say(st, I, { agent: A1, text: '@~build done', state: 'done' }, T0 + 9 * MIN)
  check('@~ done drops the eta but keeps progress', ctx('build').eta_at === null && ctx('build').progress.done === 3)
  check('@~ctx done does NOT finish the agent', e().finished_at === null && A.isActive(e()))
  say(st, I, { agent: A1, text: 'all done?', state: 'done' }, T0 + 10 * MIN)
  check('@root done (log-only) does NOT finish the agent', e().finished_at === null)
  const rf = say(st, I, { agent: A1, text: '@~root finished', state: 'done' }, T0 + 11 * MIN)
  check('@~root done finishes the agent (finished_at)', e().finished_at === T0 + 11 * MIN && !A.isActive(e()) && A.stateOf(e()) === 'done' && rf.stale_at === null)
  say(st, I, { agent: A1, text: '@~root really done', state: 'done' }, T0 + 12 * MIN)
  check('a second @~root done keeps the first finished_at', e().finished_at === T0 + 11 * MIN)
  say(st, I, { agent: A1, text: 'late note' }, T0 + 13 * MIN)
  check('a later @ message leaves it finished (but counts as activity)', e().finished_at === T0 + 11 * MIN && e().last_activity === T0 + 13 * MIN)
  say(st, I, { agent: A1, text: '@~root back at it', state: 'running' }, T0 + 14 * MIN)
  check('@~root running revives a finished agent', e().finished_at === null && A.isActive(e()))
  say(st, I, { agent: A1, text: '@~root crashed', state: 'failed' }, T0 + 15 * MIN)
  check('@~root failed also finishes', e().finished_at === T0 + 15 * MIN && A.stateOf(e()) === 'failed')
  const st2 = mk()
  say(st2, I, { text: '@~root session done', state: 'done' }, T0)
  check('a session-level @~root done finishes the session\'s own entity', A.getSession(st2, I).self.finished_at === T0)
  say(st2, I, { agent: 'x', text: '@~root idle', state: 'idle' }, T0)
  check('@~root idle does not finish', A.getEntity(st2, I, 'x').finished_at === null)
}

// ================================================================= apply: details/data retention (memory model)
{
  const st = mk(), I = S1
  const e = () => A.getEntity(st, I, 'w')
  const r1 = say(st, I, { agent: 'w', text: '@~build compiling', details: 'full compiler output', data: { errors: 0 } }, T0)
  const cur = e().contexts.get('build').current
  check('@~ keeps details + data on the CURRENT line', cur.details === 'full compiler output' && cur.data.errors === 0)
  check('the log entry keeps only flags (no details/data)', e().log[0].has_details === true && e().log[0].has_data === true && !('details' in e().log[0]) && !('data' in e().log[0]))
  check('the returned full entry carries details + data (for the JSONL)', r1.entry.details === 'full compiler output' && r1.entry.data.errors === 0 && r1.entry.current === true)
  const r2 = say(st, I, { agent: 'w', text: '@build side note', details: 'log-only details', data: [1, 2] }, T0 + 1)
  check('@ with details: NOT kept in memory anywhere, only returned', e().contexts.get('build').current.details === 'full compiler output' && r2.entry.details === 'log-only details'
    && J(r2.entry.data) === J([1, 2]) && e().log[1].has_details && !('details' in e().log[1]))
  say(st, I, { agent: 'w', text: '@~build next step' }, T0 + 2)
  check('a new @~ line REPLACES details/data (never carried forward)', e().contexts.get('build').current.details === null && e().contexts.get('build').current.data === null)
  check('no entry anywhere holds details text', !J(e().log).includes('full compiler output') && !J(e().log).includes('log-only details'))
}

// ================================================================= apply: activity + stale_after tracking
{
  const st = mk(), I = S1
  say(st, I, { agent: 'w', text: '@~a start' }, T0)
  say(st, I, { agent: 'w', text: '@b other' }, T0 + 5 * MIN)
  const e = A.getEntity(st, I, 'w')
  check('last_activity: per agent, per context and per session', e.last_activity === T0 + 5 * MIN && e.contexts.get('a').last_activity === T0 && e.contexts.get('b').last_activity === T0 + 5 * MIN
    && A.getSession(st, I).last_activity === T0 + 5 * MIN)
  check('created/started times recorded', e.started_at === T0 && e.contexts.get('b').created_at === T0 + 5 * MIN)
  const r = say(st, I, { agent: 'w', text: '@~a long build', stale_after: '60m' }, T0 + 6 * MIN)
  check('stale_after stored on the context AND the agent', e.contexts.get('a').stale_after_ms === HOUR && e.stale_after_ms === HOUR && r.stale_at === T0 + 6 * MIN + HOUR)
  say(st, I, { agent: 'w', text: '@b meanwhile' }, T0 + 7 * MIN)
  check('the next message clears the agent\'s override, not another context\'s', e.stale_after_ms === null && e.contexts.get('a').stale_after_ms === HOUR && e.contexts.get('b').stale_after_ms === null)
  say(st, I, { agent: 'w', text: '@~a build done' }, T0 + 8 * MIN)
  check('the context\'s own next message clears its override', e.contexts.get('a').stale_after_ms === null)
  say(st, I, { agent: 'w', text: '@a out-of-order report' }, T0)
  check('last_activity never moves backwards (an earlier-timed report is still logged)', e.last_activity === T0 + 8 * MIN && e.contexts.get('a').last_activity === T0 + 8 * MIN
    && A.getSession(st, I).last_activity === T0 + 8 * MIN && e.log[e.log.length - 1].ts === T0)
}

// ================================================================= apply: log cap
{
  const st = mk({ log_entries_per_agent: 10 }), I = S1
  for (let i = 1; i <= 12; i++) say(st, I, { agent: 'w', text: `m${i}` }, T0 + i)
  const e = A.getEntity(st, I, 'w')
  check('log cap: holds log_entries_per_agent (oldest dropped first)', e.log.length === 10 && e.log[0].text === 'm3' && e.log[9].text === 'm12' && e.log_dropped === 2)
  for (let i = 1; i <= 11; i++) say(st, I, { text: `s${i}` }, T0 + i)
  check('log cap: applies to the session\'s own entity too', A.getSession(st, I).self.log.length === 10 && A.getSession(st, I).self.log_dropped === 1)
  say(st, I, { agent: 'w', text: '@~cur keep me' }, T0 + 100)
  for (let i = 0; i < 20; i++) say(st, I, { agent: 'w', text: `flood ${i}` }, T0 + 200 + i)
  check('log cap: dropping entries never touches a current line', e.contexts.get('cur').current.text === 'keep me')
}

// ================================================================= apply: context limit
{
  const st = mk(), I = S1
  let ok = true
  for (let i = 1; i <= 31; i++) ok = say(st, I, { agent: 'w', text: `@c${i} x` }, T0 + i).ok && ok
  const e = A.getEntity(st, I, 'w')
  check('contexts: root + 31 named = 32 accepted', ok && e.contexts.size === 32)
  const logLen = e.log.length
  const r = say(st, I, { agent: 'w', text: '@c32 x' }, T0 + 100)
  check('contexts: the 33rd -> too-many-contexts', !r.ok && r.code === 'too-many-contexts' && /32/.test(r.what))
  check('contexts: a rejected message changes nothing (atomic)', e.contexts.size === 32 && e.log.length === logLen && e.last_activity === T0 + 31)
  check('contexts: existing contexts (incl. root) still accept messages', say(st, I, { agent: 'w', text: '@~c5 y' }, T0 + 101).ok && say(st, I, { agent: 'w', text: 'root msg' }, T0 + 102).ok)
  check('contexts: matched case-insensitively (not a new context)', say(st, I, { agent: 'w', text: '@C7 y' }, T0 + 103).ok && e.contexts.size === 32)
  for (let i = 1; i <= 31; i++) say(st, I, { text: `@k${i} x` }, T0 + i)
  check('contexts: the limit applies to the session\'s own entity', say(st, I, { text: '@k32 x' }, T0 + 50).code === 'too-many-contexts')
  const st2 = mk()
  say(st2, I, { agent: 'w', text: '@~Build first' }, T0)
  say(st2, I, { agent: 'w', text: '@build second' }, T0 + 1)
  const e2 = A.getEntity(st2, I, 'w')
  check('contexts: first-seen spelling kept; @Build and @build are one', e2.contexts.size === 2 && e2.contexts.get('build').name === 'Build' && e2.log[1].context === 'Build')
}

// ================================================================= apply: agent limit + eviction
{
  const st = mk(), I = S1
  let ok = true
  for (let i = 1; i <= 128; i++) ok = say(st, I, { agent: `a${i}`, text: 'hi' }, T0 + i).ok && ok
  const sess = A.getSession(st, I)
  check('agents: 128 accepted', ok && sess.agents.size === 128)
  check('agents: session-level messages do not count', say(st, I, { text: 'orchestrator here' }, T0 + 200).ok && sess.agents.size === 128)
  const r = say(st, I, { agent: 'a129', text: 'hi' }, T0 + 300)
  check('agents: the 129th with none finished -> too-many-agents, nothing created', !r.ok && r.code === 'too-many-agents' && sess.agents.size === 128 && !sess.agents.has('a129'))
  check('agents: existing agents still accepted at the limit', say(st, I, { agent: 'a1', text: 'still here' }, T0 + 301).ok)
  say(st, I, { agent: 'a50', text: '@~root done', state: 'done' }, T0 + 400)
  say(st, I, { agent: 'a7', text: '@~root failed', state: 'failed' }, T0 + 500)
  const r2 = say(st, I, { agent: 'a129', text: 'hi' }, T0 + 600)
  check('agents: at the limit, the oldest FINISHED agent is evicted to make room', r2.ok && J(r2.evicted) === J(['a50']) && sess.agents.size === 128 && !sess.agents.has('a50') && sess.agents.has('a7') && sess.agents.has('a129'))
  const r3 = say(st, I, { agent: 'a130', text: 'hi' }, T0 + 700)
  check('agents: then the next oldest finished', r3.ok && J(r3.evicted) === J(['a7']))
  check('agents: then rejected again', say(st, I, { agent: 'a131', text: 'hi' }, T0 + 800).code === 'too-many-agents')
  const st2 = mk()
  for (let i = 1; i <= 128; i++) say(st2, { session: 'other', project: 'AIMB' }, { agent: `a${i}`, text: 'hi' }, T0)
  check('agents: the limit is per session', say(st2, I, { agent: 'a1', text: 'hi' }, T0).ok)
  const st3 = mk()
  for (let i = 1; i <= 128; i++) say(st3, I, { agent: `a${i}`, text: 'hi' }, T0)
  say(st3, I, { agent: 'a1', text: '@~root done', state: 'done' }, T0 + 1)
  const r4 = say(st3, I, { agent: 'a2', text: 'existing agent' }, T0 + 2)
  check('agents: a message for an EXISTING agent at the limit never evicts', r4.ok && r4.evicted.length === 0 && A.getSession(st3, I).agents.has('a1'))
}

// ================================================================= apply: paths, session entity, gone
{
  const st = mk(), I = S1
  const r = say(st, I, { agent: 'spec-70/research/deep', text: '@~root digging' }, T0)
  const sess = A.getSession(st, I)
  check('paths: a 3-level agent is ONE flat entity (parents not implied)', r.ok && r.agent === 'spec-70/research/deep' && sess.agents.size === 1 && !sess.agents.has('spec-70'))
  say(st, I, { agent: 'Spec-70/Research/DEEP', text: 'same one' }, T0 + 1)
  check('paths: case-insensitive, first-seen spelling kept', sess.agents.size === 1 && A.getEntity(st, I, 'SPEC-70/research/deep').path === 'spec-70/research/deep')
  say(st, I, { agent: 'spec-70', text: 'parent reports too' }, T0 + 2)
  check('paths: the parent is its own entity when it reports', sess.agents.size === 2)
  const rs = say(st, I, { text: '@~root orchestrating', state: 'running' }, T0 + 3)
  check('session-level: no agent -> the session\'s own entity, same model', rs.ok && rs.agent === null && sess.self.contexts.get('root').current.text === 'orchestrating' && A.getEntity(st, I, null) === sess.self)
  // gone
  check('gone: unknown session -> false', A.markSessionGone(st, { session: 'nobody', project: 'AIMB' }, T0) === false)
  say(st, I, { agent: 'finisher', text: '@~root done', state: 'done' }, T0 + 4)
  say(st, I, { agent: 'idler', text: '@~root waiting', state: 'idle' }, T0 + 4)
  check('gone: markSessionGone', A.markSessionGone(st, I, T0 + 10 * MIN) === true && sess.gone_at === T0 + 10 * MIN)
  const E = p => A.getEntity(st, I, p)
  check('gone: an unfinished agent shows gone (outranks stale)', A.effectiveState(E('spec-70'), T0 + 5 * HOUR, 15).state === 'gone' && A.effectiveState(E('spec-70'), T0 + 5 * HOUR, 15).gone)
  check('gone: idle shows gone too; done stays done', A.effectiveState(E('idler'), T0 + 11 * MIN, 15).state === 'gone' && A.effectiveState(E('finisher'), T0 + 11 * MIN, 15).state === 'done')
  check('gone: the session entity + its contexts show gone', A.effectiveState(sess.self, T0 + 11 * MIN, 15).state === 'gone' && A.effectiveState(sess.self.contexts.get('root'), T0 + 11 * MIN, 15, sess.self).state === 'gone')
  check('gone: gone agents are not active', !A.isActive(E('spec-70')))
  say(st, I, { agent: 'spec-70', text: 'back!' }, T0 + 20 * MIN)
  check('gone: a message clears it for the session + that entity', sess.gone_at === null && E('spec-70').gone_at === null && E('idler').gone_at === T0 + 10 * MIN)
  A.markSessionGone(st, I, null)
  check('gone: markSessionGone(null) clears everything', E('idler').gone_at === null && sess.self.gone_at === null)
}

// ================================================================= views: stale
{
  const st = mk(), I = S1
  say(st, I, { agent: 'r', text: '@~root working' }, T0)
  const e = A.getEntity(st, I, 'r')
  check('stale: staleAt = last activity + staleMin', A.staleAt(e, 15) === T0 + 15 * MIN && A.staleAt(e, 5) === T0 + 5 * MIN)
  check('stale: at exactly the threshold it is NOT stale (quiet for LONGER than)', A.effectiveState(e, T0 + 15 * MIN, 15).state === 'running')
  const es = A.effectiveState(e, T0 + 15 * MIN + 1, 15)
  check('stale: one ms past -> stale, was running', es.state === 'stale' && es.stale && es.was === 'running' && es.stale_at === T0 + 15 * MIN)
  check('stale: the viewer\'s threshold is a parameter', A.effectiveState(e, T0 + 10 * MIN, 5).state === 'stale' && A.effectiveState(e, T0 + 10 * MIN, 30).state === 'running')
  check('stale: a bogus threshold falls back to the default 15', A.staleAt(e, 0) === T0 + 15 * MIN && A.staleAt(e, NaN) === T0 + 15 * MIN)
  say(st, I, { agent: 'b', text: '@~root waiting', state: 'blocked' }, T0)
  check('stale: blocked goes stale, was blocked', (x => x.state === 'stale' && x.was === 'blocked')(A.effectiveState(A.getEntity(st, I, 'b'), T0 + HOUR, 15)))
  for (const s of ['done', 'failed', 'idle']) {
    say(st, I, { agent: `n-${s}`, text: '@~root x', state: s }, T0)
    const x = A.effectiveState(A.getEntity(st, I, `n-${s}`), T0 + 48 * HOUR, 15)
    check(`stale: ${s} never goes stale`, x.state === s && !x.stale && x.stale_at === null && A.staleAt(A.getEntity(st, I, `n-${s}`), 15) === null)
  }
  say(st, I, { agent: 'q', text: 'just logging, no current line' }, T0)
  check('stale: an entity with no current line counts as running (and can go stale)', A.effectiveState(A.getEntity(st, I, 'q'), T0 + 16 * MIN, 15).state === 'stale')
  say(st, I, { agent: 'o', text: '@~root big download', stale_after: '60m' }, T0)
  const o = A.getEntity(st, I, 'o')
  check('stale_after: the override beats the viewer threshold', A.effectiveState(o, T0 + 30 * MIN, 15).state === 'running' && A.effectiveState(o, T0 + 61 * MIN, 15).state === 'stale' && A.staleAt(o, 15) === T0 + HOUR)
  say(st, I, { agent: 'o', text: '@~root download finished, unpacking' }, T0 + 61 * MIN)
  check('stale_after: gone after the next message (back to the default)', A.staleAt(o, 15) === T0 + 61 * MIN + 15 * MIN)
  // a context goes stale by its OWN last message
  say(st, I, { agent: 'm', text: '@~tiles strip 1' }, T0)
  say(st, I, { agent: 'm', text: '@~root overall fine' }, T0 + 20 * MIN)
  const m = A.getEntity(st, I, 'm')
  check('stale: a context goes stale by its own most recent message', A.effectiveState(m.contexts.get('tiles'), T0 + 21 * MIN, 15, m).state === 'stale' && A.effectiveState(m, T0 + 21 * MIN, 15).state === 'running')
  say(st, I, { agent: 'm', text: '@~root all done', state: 'done' }, T0 + 22 * MIN)
  check('stale: contexts under a FINISHED agent never go stale', A.effectiveState(m.contexts.get('tiles'), T0 + 5 * HOUR, 15, m).state === 'running' && A.staleAt(m.contexts.get('tiles'), 15, m) === null)
  check('stateOf: context / entity / nothing', A.stateOf(m.contexts.get('tiles')) === 'running' && A.stateOf(m) === 'done' && A.stateOf(null) === 'running')
  check('apply returns stale_at for the message\'s context', say(st, I, { agent: 'z', text: '@~ctx x', stale_after: '2h' }, T0).stale_at === T0 + 2 * HOUR)
}

// ================================================================= views: rollup
{
  const st = mk(), I = S1
  const R = a => A.rollup(A.getEntity(st, I, a))
  say(st, I, { agent: 'none', text: '@~a x' }, T0)
  check('rollup: nothing has progress -> null', R('none') === null && A.rollup(null) === null)
  say(st, I, { agent: 'sum', text: '@~s1 x', progress: '10/100 tiles' }, T0)
  say(st, I, { agent: 'sum', text: '@~s2 x', progress: '30/100 Tiles' }, T0)
  const rs = R('sum')
  check('rollup: contexts sharing a unit (case-insensitive) are SUMMED', rs.done === 40 && rs.total === 200 && rs.pct === 20 && rs.rollup === true && rs.n === 2 && rs.unit === 'tiles', J(rs))
  say(st, I, { agent: 'mix', text: '@~a x', progress: '1/2 files' }, T0)
  say(st, I, { agent: 'mix', text: '@~b x', progress: '25/100 tiles' }, T0)
  const rm = R('mix')
  check('rollup: mixed units -> the mean percent, labelled a rollup', rm.done === 37.5 && rm.total === 100 && rm.unit === '%' && rm.rollup && rm.n === 2, J(rm))
  say(st, I, { agent: 'pct', text: '@~a x', progress: '20%' }, T0)
  say(st, I, { agent: 'pct', text: '@~b x', progress: '61%' }, T0)
  check('rollup: percent contexts -> mean %', (r => r.done === 40.5 && r.unit === '%' && r.rollup)(R('pct')))
  say(st, I, { agent: 'bare', text: '@~a x', progress: '3/6' }, T0)
  say(st, I, { agent: 'bare', text: '@~b x', progress: '1/4' }, T0)
  check('rollup: unit-less contexts share the "" unit and sum', (r => r.done === 4 && r.total === 10 && r.unit === '' && r.rollup)(R('bare')))
  say(st, I, { agent: 'sum', text: '@~root overall', progress: '7/10 strips' }, T0)
  const rr = R('sum')
  check('rollup: a REPORTED @root progress wins (not a rollup)', rr.done === 7 && rr.total === 10 && rr.unit === 'strips' && rr.rollup === false && rr.pct === 70)
  say(st, I, { agent: 'logonly', text: '@a x', progress: '5/10' }, T0)
  check('rollup: progress on an @ (log-only) message counts too (step 2)', (r => r && r.done === 5 && r.total === 10 && r.rollup)(R('logonly')))
  say(st, I, { agent: 'one', text: '@~a x', progress: '5/10 files' }, T0)
  check('rollup: a single context still rolls up (labelled)', (r => r.done === 5 && r.rollup && r.n === 1)(R('one')))
  say(st, I, { text: '@~phase1 x', progress: '1/2' }, T0)
  check('rollup: works for the session\'s own entity', (r => r.done === 1 && r.total === 2 && r.rollup)(A.rollup(A.getSession(st, I).self)))
}

// ================================================================= views: isActive / visible / expire
{
  const st = mk(), I = S1
  say(st, I, { agent: 'live', text: 'x' }, T0)
  say(st, I, { agent: 'fin', text: '@~root done', state: 'done' }, T0)
  const L = A.getEntity(st, I, 'live'), F = A.getEntity(st, I, 'fin')
  check('isActive: live yes, finished no', A.isActive(L) && !A.isActive(F) && !A.isActive(null))
  check('visible: an unfinished agent is always visible', A.visible(L, T0 + 1000 * HOUR, 24))
  check('visible: finished stays visible for finished_visible_hours', A.visible(F, T0 + 23 * HOUR, 24) && !A.visible(F, T0 + 24 * HOUR, 24) && !A.visible(F, T0 + 25 * HOUR, 24))
  check('visible: hours = 0 hides a finished agent at once', !A.visible(F, T0, 0) && A.visible(L, T0, 0))
  check('visible: a gone agent uses the same window', A.visible({ gone_at: T0 }, T0 + HOUR, 24) && !A.visible({ gone_at: T0 }, T0 + 25 * HOUR, 24) && !A.visible(null, T0, 24))
  const removed = A.expire(st, T0 + 25 * HOUR)
  check('expire: removes finished agents past the window, keeps live ones', J(removed) === J([{ session: 'Bridget', project: 'AIMB', agent: 'fin' }]) && A.getEntity(st, I, 'fin') === null && A.getEntity(st, I, 'live') !== null)
  const I2 = { session: 'Leaver', project: 'AIMB' }
  say(st, I2, { agent: 'x', text: 'hi' }, T0)
  A.markSessionGone(st, I2, T0 + HOUR)
  check('expire: a gone session stays within the window', A.expire(st, T0 + 2 * HOUR).length === 0 && A.getSession(st, I2) !== null)
  const rem2 = A.expire(st, T0 + 26 * HOUR)
  check('expire: a gone session past the window is removed whole', rem2.some(r => r.session === 'Leaver' && r.agent === null) && A.getSession(st, I2) === null && A.getSession(st, I) !== null)
  const st3 = mk({ finished_visible_hours: 1 })
  say(st3, I, { agent: 'f', text: '@~root done', state: 'done' }, T0)
  check('expire: honours config.finished_visible_hours', A.expire(st3, T0 + 30 * MIN).length === 0 && A.expire(st3, T0 + 61 * MIN).length === 1)
}

// ================================================================= gossip: snapshot
{
  const st = mk({}, 'HOST-A'), I = S1
  say(st, I, { agent: 'w', text: '@~build compiling', progress: '2/4 files', eta: '10m', details: 'SECRET-DETAILS-TEXT', data: { marker: 'SECRET-DATA-VALUE' } }, T0)
  say(st, I, { agent: 'w', text: 'LOG-ONLY-ENTRY-TEXT' }, T0 + 1)
  const snap = A.snapshot(st), js = J(snap)
  check('snapshot: shape { v:1, origin, sessions }', snap.v === 1 && snap.origin === 'HOST-A' && snap.sessions.length === 1)
  check('snapshot: NO details / data / log entries', !js.includes('SECRET-DETAILS-TEXT') && !js.includes('SECRET-DATA-VALUE') && !js.includes('LOG-ONLY-ENTRY-TEXT') && !js.includes('"log"') && !js.includes('"details"') && !js.includes('"data"'))
  const c = snap.sessions[0].agents[0].contexts.find(x => x.name === 'build')
  check('snapshot: the current line with has_details/has_data flags + progress + eta', c.current.text === 'compiling' && c.current.has_details === true && c.current.has_data === true
    && J(c.progress) === J({ done: 2, total: 4, unit: 'files' }) && c.eta_at === T0 + 10 * MIN)
  check('snapshot: null/false fields omitted (compact)', !('finished_at' in snap.sessions[0].agents[0]) && !('gone_at' in snap.sessions[0]) && !('path' in snap.sessions[0].self))
  check('snapshot: serialises identically twice', J(A.snapshot(st)) === js)
  // determinism: the same state built in a different insertion order serialises identically
  const build = order => {
    const s = mk({}, 'H')
    const steps = {
      a: () => { say(s, { session: 'zeta', project: 'P' }, { agent: 'b', text: '@z x' }, T0 + 1); say(s, { session: 'zeta', project: 'P' }, { agent: 'b', text: '@a x' }, T0 + 2) },
      b: () => say(s, { session: 'alpha', project: 'P' }, { agent: 'y', text: '@q x', progress: '1/2' }, T0 + 3),
      c: () => say(s, { session: 'alpha', project: 'P' }, { agent: 'x', text: '@m x' }, T0 + 3),   // same time as b: only the INSERTION order differs
      d: () => say(s, { session: 'mid', project: 'Q' }, { text: '@k x' }, T0 + 5),
    }
    for (const k of order) steps[k]()
    return J(A.snapshot(s))
  }
  const o1 = build(['a', 'b', 'c', 'd']), o2 = build(['d', 'c', 'b', 'a']), o3 = build(['c', 'a', 'd', 'b'])
  check('snapshot: deterministic across insertion orders (key-sorted)', o1 === o2 && o2 === o3, `${o1}\n${o2}`)
  const parsed = JSON.parse(o1)
  check('snapshot: agents and contexts sorted by key', J(parsed.sessions.find(s => s.session === 'alpha').agents.map(a => a.path)) === J(['x', 'y'])
    && J(parsed.sessions.find(s => s.session === 'zeta').agents[0].contexts.map(c => c.name)) === J(['a', 'root', 'z']))
  check('snapshot: session order is by (project, session) key', J(parsed.sessions.map(s => s.session)) === J(['alpha', 'zeta', 'mid']))
  const filtered = A.snapshot(st, s => s.session !== 'Bridget')
  check('snapshot: sessionFilter', filtered.sessions.length === 0 && A.snapshot(st, () => true).sessions.length === 1)
  check('snapshot: an unknown origin -> empty slice', A.snapshot(st, undefined, 'NOPE').sessions.length === 0)
  const before = J(A.snapshot(st))
  const sn = A.snapshot(st); sn.sessions[0].agents[0].contexts[0].progress.done = 999
  check('snapshot: returns copies (mutating it does not touch the state)', J(A.snapshot(st)) === before)
}

// ================================================================= gossip: mergeSnapshot
{
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
  // B's host drops a session: the new slice REPLACES the old one wholesale
  A.expire(hostB, T0)   // no-op, just exercising
  hostB.local.delete(A.sessionKey({ project: 'AIMB', session: 'Two' }))
  say(hostB, { session: 'Mac', project: 'AIMB' }, { agent: 'w', text: '@~root B moved on' }, T0 + MIN)
  const m3 = A.mergeSnapshot(here, 'HOST-B', A.snapshot(hostB))
  check('merge: a new slice REPLACES the origin\'s old one (dropped session gone)', m3.changed && A.getSession(here, { session: 'Two', project: 'AIMB' }, 'HOST-B') === null
    && A.getEntity(here, { session: 'Mac', project: 'AIMB' }, 'w', 'HOST-B').contexts.get('root').current.text === 'B moved on')
  check('merge: other origins untouched', J(A.snapshot(here, undefined, 'HOST-C')) === J(snapC))
  check('merge: our own local slice untouched', J(A.snapshot(here)) === localBefore)
  check('merge: our own origin is refused', A.mergeSnapshot(here, 'HOST-A', snapB).code === 'own-origin' && J(A.snapshot(here)) === localBefore)
  const spoof = { ...snapC, origin: 'HOST-C' }
  A.mergeSnapshot(here, 'HOST-D', spoof)
  check('merge: ownership comes from the link (fromOrigin), not the snapshot\'s origin field', here.remote.has('HOST-D') && J(A.snapshot(here, undefined, 'HOST-C')) === J(snapC)
    && A.getSession(here, { session: 'Linux', project: 'X' }, 'HOST-D').origin === 'HOST-D')
  check('merge: bad origin / bad snapshot rejected', A.mergeSnapshot(here, '', snapB).code === 'bad-origin' && A.mergeSnapshot(here, 'HOST-E', null).code === 'bad-snapshot' && A.mergeSnapshot(here, 'HOST-E', { sessions: 'x' }).code === 'bad-snapshot' && !here.remote.has('HOST-E'))
  const empty = A.mergeSnapshot(here, 'HOST-D', { v: 1, origin: 'HOST-D', sessions: [] })
  check('merge: an empty slice clears that origin\'s sessions', empty.changed && A.getSession(here, { session: 'Linux', project: 'X' }, 'HOST-D') === null)
  check('dropOrigin: forgets a host; false when unknown', A.dropOrigin(here, 'HOST-D') === true && !here.remote.has('HOST-D') && A.dropOrigin(here, 'HOST-D') === false && here.remote.has('HOST-C'))
  // views work on remote entities
  const lin = A.getSession(here, { session: 'Linux', project: 'X' }, 'HOST-C').self
  check('merge: derived views work on remote entities', A.effectiveState(lin, T0 + HOUR, 15).state === 'stale' && A.effectiveState(lin, T0 + HOUR, 15).was === 'blocked'
    && (r => r.done === 1 && r.total === 3 && r.rollup === false)(A.rollup(A.getEntity(here, { session: 'Mac', project: 'AIMB' }, 'w', 'HOST-B'))))
  const all = A.allSessions(here)
  check('allSessions: local first, then origins sorted', all.length === 3 && all[0].origin === 'HOST-A' && all[1].origin === 'HOST-B' && all[2].origin === 'HOST-C')
  check('merge: the merged slice\'s entity still exposes the rolled-up progress', A.rollup(A.getEntity(here, { session: 'Mac', project: 'AIMB' }, 'w', 'HOST-B')).done === 1)
  // defensive normalisation of a hostile/junk slice
  const junk = {
    v: 1, origin: 'EVIL', sessions: [
      null, 'x', { project: 'no-session-name' },
      { session: 'Big', project: 'P', agents: [
        ...Array.from({ length: 200 }, (_, i) => ({ path: `a${i}`, started_at: T0, last_activity: T0, contexts: [{ name: 'root', current: { id: 'i', ts: T0, text: rep('t', 500), state: 'weird', details: 'LEAKED-DETAILS', data: { leak: 1 } } }] })),
      ] },
      { session: 'Paths', project: 'P', agents: [{ path: 'a/b/c/d/e' }, { path: 'has space' }, { path: 'ok' }, { path: 'OK' }] },
      { session: 'Ctx', project: 'P', agents: [{ path: 'many', contexts: Array.from({ length: 50 }, (_, i) => ({ name: `c${i}`, progress: '5/0', stale_after_ms: 99 * HOUR })) }] },
    ],
  }
  const mj = A.mergeSnapshot(here, 'EVIL', junk)
  const big = A.getSession(here, { session: 'Big', project: 'P' }, 'EVIL')
  const a0 = big.agents.get('a0').contexts.get('root').current
  check('merge (defensive): junk sessions skipped', mj.ok && mj.sessions === 3)
  check('merge (defensive): agents capped at 128', big.agents.size === 128)
  check('merge (defensive): text truncated to 240, bad state -> running, details/data never kept', Array.from(a0.text).length === 240 && a0.state === 'running' && !('details' in a0) && !('data' in a0) && !J(A.snapshot(here, undefined, 'EVIL')).includes('LEAKED-DETAILS'))
  check('merge (defensive): invalid agent paths dropped, duplicates collapsed', J([...A.getSession(here, { session: 'Paths', project: 'P' }, 'EVIL').agents.values()].map(a => a.path)) === J(['ok']))
  const many = A.getEntity(here, { session: 'Ctx', project: 'P' }, 'many', 'EVIL')
  check('merge (defensive): contexts capped at 32 with root kept; bad progress dropped; stale_after capped', many.contexts.size === 32 && many.contexts.has('root')
    && [...many.contexts.values()].every(c => c.progress === null) && many.contexts.get('c0').stale_after_ms === 24 * HOUR)
  const again = A.mergeSnapshot(here, 'EVIL', A.snapshot(here, undefined, 'EVIL'))
  check('merge (defensive): its canonical form is stable (re-merge -> unchanged)', again.ok && again.changed === false)
}

// ================================================================= memory budget
{
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

  // eviction order: oldest finished agents first
  const s2 = mk()
  for (const [p, t] of [['f-new', 3], ['f-old', 1], ['f-mid', 2]]) {
    for (let i = 0; i < 5; i++) say(s2, I, { agent: p, text: `work ${i}` }, T0 + i)
    say(s2, I, { agent: p, text: '@~root done', state: 'done' }, T0 + t * HOUR)
  }
  for (let i = 0; i < 5; i++) say(s2, I, { agent: 'live', text: `busy ${i}` }, T0 + i)
  say(s2, I, { agent: 'live', text: '@~root working hard' }, T0 + 10)
  const full = A.estimateBytes(s2)
  const one = A.enforceBudget(s2, full - 1)
  check('enforceBudget: evicts the OLDEST finished agent first (just enough)', J(one.evicted.map(e => e.agent)) === J(['f-old']) && one.entries_dropped === 0 && !one.over && one.bytes_after <= full - 1)
  const two = A.enforceBudget(s2, A.estimateBytes(s2) - 1)
  check('enforceBudget: then the next oldest', J(two.evicted.map(e => e.agent)) === J(['f-mid']))
  check('enforceBudget: evicted agents are gone; unfinished stay', A.getEntity(s2, I, 'f-old') === null && A.getEntity(s2, I, 'f-mid') === null && A.getEntity(s2, I, 'f-new') !== null && A.getEntity(s2, I, 'live') !== null)
  const tiny = A.enforceBudget(s2, 1)
  const live = A.getEntity(s2, I, 'live')
  check('enforceBudget: over a tiny budget: all finished evicted, then every log entry dropped, still over', J(tiny.evicted.map(e => e.agent)) === J(['f-new']) && tiny.entries_dropped > 0 && tiny.over
    && live.log.length === 0 && A.getSession(s2, I).self.log.length === 0)
  check('enforceBudget: never evicts a current line, an unfinished agent or the session entity', live.contexts.get('root').current.text === 'working hard' && A.getSession(s2, I).self !== null && live.log_dropped === 6)

  // log entries: the globally OLDEST first, across agents
  const s3 = mk(), I3 = S1
  say(s3, I3, { agent: 'x', text: 'x1' }, T0 + 1)
  say(s3, I3, { agent: 'y', text: 'y2' }, T0 + 2)
  say(s3, I3, { agent: 'x', text: 'x3' }, T0 + 3)
  say(s3, I3, { agent: 'y', text: 'y4' }, T0 + 4)
  const d1 = A.enforceBudget(s3, A.estimateBytes(s3) - 1)
  const X = A.getEntity(s3, I3, 'x'), Y = A.getEntity(s3, I3, 'y')
  check('enforceBudget: log entries drop oldest-first across agents (x1)', d1.entries_dropped === 1 && d1.evicted.length === 0 && X.log.map(e => e.text).join() === 'x3' && Y.log.length === 2)
  A.enforceBudget(s3, A.estimateBytes(s3) - 1)
  check('enforceBudget: … then y2', Y.log.map(e => e.text).join() === 'y4' && X.log.length === 1 && X.log_dropped === 1 && Y.log_dropped === 1)

  // remote slices are never evicted
  const s4 = mk({}, 'HOST-A'), rb = mk({}, 'HOST-B')
  say(rb, { session: 'R', project: 'P' }, { agent: 'ra', text: '@~root done', state: 'done' }, T0)
  A.mergeSnapshot(s4, 'HOST-B', A.snapshot(rb))
  say(s4, I, { agent: 'la', text: '@~root done', state: 'done' }, T0 + HOUR)
  const r4 = A.enforceBudget(s4, 1)
  check('enforceBudget: remote slices are never evicted (their origin bounds them)', J(r4.evicted.map(e => e.agent)) === J(['la']) && A.getEntity(s4, { session: 'R', project: 'P' }, 'ra', 'HOST-B') !== null)
  check('estimateBytes: counts remote slices', A.estimateBytes(s4) > A.estimateBytes(mk()) + 500)
}

// ================================================================= step 2 (v1.58.0): config, ids, days
{
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
}

// ================================================================= step 2: session identity = realm + project + user + session
{
  const st = mk()
  say(st, { session: 'Alpha', project: 'AIMB', user: 'robin', host: 'ROBIN-Z790' }, { text: 'one' }, T0)
  say(st, { session: 'Alpha', project: 'AIMB', user: 'kim', host: 'ROBIN-Z790' }, { text: 'two' }, T0)
  say(st, { session: 'Alpha', project: 'AIMB', user: 'robin', realm: 'other' }, { text: 'three' }, T0)
  check('identity: same name + project, another user (or realm) = another session', st.local.size === 3)
  say(st, { session: 'ALPHA', project: 'aimb', user: 'Robin', host: 'LITTLE-001' }, { text: 'moved' }, T0 + MIN)
  const s = A.getSession(st, { session: 'alpha', project: 'AIMB', user: 'robin' })
  check('identity: another HOST is the same session (it moved machines); first-seen spellings kept, host updated', st.local.size === 3 && s.session === 'Alpha' && s.user === 'robin' && s.host === 'LITTLE-001' && s.self.log.length === 2)
  check('identity: the session record + entry carry the realm', s.realm === 'default' && say(st, S1, { text: 'r' }, T0).entry.realm === 'default')
  check('sessionKey: an object; realm defaults to "default"', A.sessionKey({ session: 'a', project: 'P', user: 'u' }) === A.sessionKey({ session: 'A', project: 'p', user: 'U', realm: 'Default' }))
}

// ================================================================= step 2: the log flag
{
  check('log flag: default true; false / "false" / 0 / "no" parse; junk -> bad-log', M({ text: 'x' }).log === true && M({ text: 'x', log: false }).log === false && M({ text: 'x', log: 'false' }).log === false
    && M({ text: 'x', log: 0 }).log === false && M({ text: 'x', log: 'no' }).log === false && M({ text: 'x', log: true }).log === true && C({ text: 'x', log: 'maybe' }) === 'bad-log')
  const st = mk(), I = S1
  const e = () => A.getEntity(st, I, 'w')
  say(st, I, { agent: 'w', text: '@~build compiling', progress: '1/4' }, T0)
  const before = e().log.length
  const r = say(st, I, { agent: 'w', text: '@~build linking', state: 'blocked', progress: '2/4', details: 'D', log: false }, T0 + MIN)
  check('log:false: takes full effect (current line + state + bar)', r.ok && r.logged === false && e().contexts.get('build').current.text === 'linking' && A.stateOf(e().contexts.get('build')) === 'blocked'
    && e().contexts.get('build').progress.done === 2 && e().contexts.get('build').current.details === 'D')
  check('log:false: NOT appended to the log; entry:null, logged:false; still has an id (its line)', e().log.length === before && r.entry === null && typeof r.id === 'string' && e().contexts.get('build').current.id === r.id)
  check('log:false: counts as activity (refreshes stale)', e().last_activity === T0 + MIN && r.stale_at === T0 + MIN + 15 * MIN)
  A.markSessionGone(st, I, T0 + 2 * MIN)
  say(st, I, { agent: 'w', text: '@build ping', log: false }, T0 + 3 * MIN)
  check('log:false: clears gone like any message', A.getSession(st, I).gone_at === null && e().gone_at === null)
  const r2 = say(st, I, { agent: 'w', text: 'logged' }, T0 + 4 * MIN)
  check('log:true (default): logged:true + an entry', r2.logged === true && !!r2.entry && e().log.length === before + 1)
  // a new agent at the 128 limit must be logged (its eviction has to reach the JSONL)
  const s2 = mk()
  for (let i = 1; i <= 128; i++) say(s2, I, { agent: `a${i}`, text: 'hi' }, T0)
  say(s2, I, { agent: 'a1', text: '@~root done', state: 'done' }, T0 + 1)
  check('log:false: may not create the 129th agent (an eviction must be logged)', say(s2, I, { agent: 'new', text: 'hi', log: false }, T0 + 2).code === 'too-many-agents' && A.getEntity(s2, I, 'a1') !== null)
  check('... a logged one evicts as before', say(s2, I, { agent: 'new', text: 'hi' }, T0 + 3).evicted.join() === 'a1')
}

// ================================================================= step 2: default text + progress/eta on any message
{
  check('default text: progress without text -> "{progress}" (logged or not)', M({ progress: '3/6' }).text === '{progress}' && M({ progress: '3/6', log: false }).text === '{progress}' && M({ text: '', progress: '3/6' }).text === '{progress}')
  check('default text: only an ETA -> "{eta}"', M({ eta: '15m' }).text === '{eta}' && M({ progress: '1/2', eta: '15m' }).text === '{progress}')
  check('default text: no text and no progress/eta is still rejected', C({}) === 'bad-text' && C({ text: '' }) === 'text-empty' && C({ text: '@~build' }) === 'text-empty' && C({ state: 'done' }) === 'bad-text')
  const m = M({ text: '@~build', progress: '5/10 tiles', state: 'blocked' })
  check('default text: a prefix alone + progress = that context\'s line "{progress}" (state allowed)', m.context === 'build' && m.current && m.text === '{progress}' && m.state === 'blocked')
  check('default text: "{progress}" also with the context param', M({ context: '@~tiles', progress: '1/2' }).text === '{progress}')
  const st = mk(), I = S1, c = () => A.getEntity(st, I, 'w').contexts.get('t')
  say(st, I, { agent: 'w', text: '@~t start', eta: '30m' }, T0)
  say(st, I, { agent: 'w', text: '@t note', eta: '10m' }, T0 + MIN)
  check('eta: an @ message moves the ETA too', c().eta_at === T0 + 11 * MIN)
  say(st, I, { agent: 'w', text: '@~t finished', state: 'done' }, T0 + 2 * MIN)
  say(st, I, { agent: 'w', text: '@t late eta', eta: '10m', progress: '9/10' }, T0 + 3 * MIN)
  check('eta: ignored while the context is done (bar still moves)', c().eta_at === null && c().progress.done === 9)
  say(st, I, { agent: 'w', text: '@~t again', state: 'running' }, T0 + 4 * MIN)
  check('eta: stays dropped after a revive without one', c().eta_at === null)
}

// ================================================================= step 2: persistence markers on entries
{
  const st = mk(), I = S1
  const a = say(st, I, { agent: 'w', text: '@~build go' }, T0).entry
  check('markers: the first entry of a session/agent/context carries new_session/new_entity/new_context', a.new_session && a.new_entity && a.new_context && a.v === 1)
  const b = say(st, I, { agent: 'w', text: '@build more' }, T0 + 1).entry
  check('markers: later entries carry none', !b.new_session && !b.new_entity && !b.new_context)
  const c2 = say(st, I, { agent: 'w', text: 'root note' }, T0 + 2).entry
  check('markers: a new context (root\'s first entry) carries new_context only', c2.new_context && !c2.new_entity && !c2.new_session)
  const d = say(st, I, { text: 'session self' }, T0 + 3).entry
  check('markers: the session\'s own entity\'s first entry carries new_entity', d.new_entity && d.new_context && !d.new_session)
  say(st, I, { agent: 'q', text: '@x hi', log: false }, T0 + 4)
  const q = say(st, I, { agent: 'q', text: '@x logged now' }, T0 + 5).entry
  check('markers: go on the first PERSISTED record (an unlogged creation does not count)', q.new_entity && q.new_context)
  const f = say(st, I, { agent: 'w', text: '@~root done', state: 'done' }, T0 + 6).entry
  const g = say(st, I, { agent: 'w', text: '@~root still done', state: 'done' }, T0 + 7).entry
  const h = say(st, I, { agent: 'w', text: '@~root back', state: 'running' }, T0 + 8).entry
  check('markers: an @~root entry carries the entity\'s resulting finished_at (null when live)', f.finished_at === T0 + 6 && g.finished_at === T0 + 6 && 'finished_at' in h && h.finished_at === null && !('finished_at' in b))
  check('in-memory entries never hold the markers', !('new_session' in A.getEntity(st, I, 'w').log[0]) && !('finished_at' in A.getEntity(st, I, 'w').log.at(-1)))
}

// ================================================================= step 2: renderText (placeholders rendered at READ time)
{
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
}

// ================================================================= step 2: read views (board / log / entry) + rendering
{
  const st = mk(), I = S1, now = T0 + 10 * MIN
  say(st, I, { agent: 'w', text: '@~tiles Seeding {progress} ({pct}) eta {eta}', progress: '10/100 tiles', eta: '30m' }, T0)
  say(st, I, { agent: 'w', text: '@tiles batch {progress}', progress: '20/100 tiles' }, T0 + MIN)
  say(st, I, { agent: 'w', progress: '40/100 tiles', context: '@tiles', log: false }, T0 + 2 * MIN)
  say(st, I, { agent: 'w', text: '@~root overall {progress}' }, T0 + 3 * MIN)
  say(st, I, { text: '@~root orchestrating' }, T0 + 4 * MIN)
  say(st, { session: 'Other', project: 'X', user: 'robin' }, { agent: 'z', text: '@~root fin', state: 'done' }, T0)
  const b = A.boardView(st, now)
  const bw = b.find(s => s.session === 'Bridget').agents[0], tiles = bw.contexts.find(c => c.name === 'tiles')
  check('board: sessions sorted, agents + contexts (root first) with effective state', b.length === 2 && bw.agent === 'w' && bw.contexts[0].name === 'root' && tiles.state === 'running')
  check('board: a current line renders against the CURRENT bar + ETA (moved by the log:false update)', tiles.current.text === 'Seeding {progress} ({pct}) eta {eta}' && tiles.current.rendered === 'Seeding 40 of 100 tiles (40%) eta ~20m')
  check('board: a root line renders against the entity\'s bar (the rollup)', bw.current.rendered === 'overall 40 of 100 tiles' && bw.progress.rollup === true)
  check('board: filters (project, session, agent, active_only)', A.boardView(st, now, { project: 'x' }).length === 1 && A.boardView(st, now, { session: 'bridget' }).length === 1
    && A.boardView(st, now, { agent: 'nope' }).length === 0 && A.boardView(st, now, { active_only: true }).find(s => s.session === 'Other').agents.length === 0)
  check('board: stale computed with stale_after_min (or a viewer threshold)', A.boardView(st, T0 + 30 * MIN)[0].agents[0].state === 'stale' && A.boardView(st, T0 + 30 * MIN, { staleMin: 60 })[0].agents[0].state === 'running')
  const lv = A.logView(st, { session: 'Bridget', agent: 'w' }, now)
  check('log view: newest first; rendered against the progress RECORDED on each entry', lv.ok && lv.entries.length === 3 && lv.entries[0].text === 'overall {progress}' && lv.entries[0].rendered === 'overall {progress}'
    && lv.entries[1].rendered === 'batch 20 of 100 tiles' && lv.entries[2].rendered === 'Seeding 10 of 100 tiles (10%) eta ~20m')
  check('log view: context filter + limit', A.logView(st, { session: 'Bridget', agent: 'w', context: '@tiles', limit: 1 }, now).entries.map(e => e.text).join() === 'batch {progress}'
    && A.logView(st, { session: 'Bridget', agent: 'w', context: 'tiles' }, now).total === 2)
  check('log view: the session itself (no agent); codes', A.logView(st, { session: 'bridget' }, now).entries[0].text === 'orchestrating' && A.logView(st, { session: 'nobody' }).code === 'unknown-session'
    && A.logView(st, { session: 'Bridget', agent: 'ghost' }).code === 'unknown-agent' && A.logView(st, {}).code === 'bad-log-query')
  say(st, { session: 'Bridget', project: 'Other', user: 'robin' }, { text: 'twin' }, T0)
  check('log view: an ambiguous name asks for the project', A.logView(st, { session: 'Bridget' }).code === 'ambiguous-session' && A.logView(st, { session: 'Bridget', project: 'aimb', agent: 'w' }).ok)
  const r = say(st, I, { agent: 'w', text: '@~d with details', details: 'DD', data: { a: 1 } }, T0 + 5 * MIN)
  const r2 = say(st, I, { agent: 'w', text: '@d log only', details: 'LOGGED' }, T0 + 6 * MIN)
  const f1 = A.findEntry(st, r.id, now), f2 = A.findEntry(st, r2.id, now)
  check('findEntry: a current line comes with its details/data', f1.where === 'current' && f1.complete && f1.entry.details === 'DD' && f1.entry.data.a === 1 && f1.entry.agent === 'w' && f1.entry.session === 'Bridget')
  check('findEntry: a log entry has flags only (complete:false -> read the JSONL); unknown -> null', f2.where === 'log' && f2.complete === false && f2.entry.has_details && f2.entry.details === null && A.findEntry(st, 'nope') === null)
}

// ================================================================= step 2: checkpoints (cp) + repeat lines (rep)
{
  const st = mk(), I = S1
  const tick = t => A.planCheckpoints(st, t)
  const file = []   // simulates the day's JSONL: rewrite:true replaces the LAST line
  const write = ws => { for (const w of ws) { if (w.rewrite) { check('rep rewrite: the open repeat line IS the file\'s last line', file.length && file.at(-1).rep !== undefined); file[file.length - 1] = w.rec } else file.push(w.rec) } return ws }
  say(st, I, { agent: 'w', context: '@~scan', progress: '1/100', log: false }, T0)
  const w1 = write(tick(T0 + MIN))
  check('cp: a context changed by log:false -> one full cp line with a per-file key', w1.length === 1 && w1[0].kind === 'cp' && w1[0].rec.kind === 'cp' && w1[0].rec.k === 1 && w1[0].rec.progress.done === 1
    && w1[0].rec.current.text === '{progress}' && w1[0].rec.new_session && w1[0].rec.new_entity && w1[0].rec.new_context)
  check('cp: nothing live -> nothing written', tick(T0 + 2 * MIN).length === 0)
  for (let i = 0; i < 3; i++) {
    say(st, I, { agent: 'w', context: '@~scan', progress: '1/100', log: false }, T0 + (2 + i) * MIN + 1000)   // alive, UNCHANGED
    write(tick(T0 + (3 + i) * MIN))
  }
  check('rep: unchanged-but-alive intervals -> ONE repeat line whose n increments (rewritten in place)', file.length === 2 && J(file[1].rep) === '[1]' && file[1].n === 3 && file[1].since === T0 + 3 * MIN && file[1].last === T0 + 5 * MIN)
  say(st, I, { agent: 'w', context: '@~scan', progress: '50/100', log: false }, T0 + 5 * MIN + 1000)    // a CHANGE
  say(st, I, { agent: 'w', text: '@~other x', log: false }, T0 + 5 * MIN + 2000)
  const w2 = write(tick(T0 + 6 * MIN))
  check('cp: a change mid-stream -> a new cp (same key); a new context gets the next key', w2.length === 2 && w2.every(w => w.kind === 'cp') && w2.find(w => w.rec.context === 'scan').rec.k === 1 && w2.find(w => w.rec.context === 'other').rec.k === 2)
  say(st, I, { agent: 'w', context: '@~scan', progress: '50/100', log: false }, T0 + 6 * MIN + 1000)
  say(st, I, { agent: 'w', text: '@~other x', log: false }, T0 + 6 * MIN + 2000)
  const w3 = write(tick(T0 + 7 * MIN))
  check('rep: after a cp the next unchanged interval starts a FRESH repeat line', w3.length === 1 && w3[0].kind === 'rep' && !w3[0].rewrite && J(w3[0].rec.rep) === '[1,2]' && w3[0].rec.n === 1)
  say(st, I, { agent: 'w', context: '@~scan', progress: '50/100', log: false }, T0 + 7 * MIN + 1000)
  const w4 = write(tick(T0 + 8 * MIN))
  check('rep: a different key set -> a new line (every key on a line was alive in all its n intervals)', w4.length === 1 && !w4[0].rewrite && J(w4[0].rec.rep) === '[1]')
  say(st, I, { agent: 'w', context: '@~scan', progress: '50/100', log: false }, T0 + 8 * MIN + 1000)
  const ent = say(st, I, { agent: 'w', text: '@other a logged line' }, T0 + 8 * MIN + 2000); file.push(ent.entry)
  const w5 = write(tick(T0 + 9 * MIN))
  check('rep: any other write (a log entry) closes the open line -> the next is appended', w5.length === 1 && w5[0].kind === 'rep' && !w5[0].rewrite)
  check('cp: at most one cp per context per interval (a burst)', (() => { for (let i = 0; i < 20; i++) say(st, I, { agent: 'w', context: '@~scan', progress: `${51 + i}/100`, log: false }, T0 + 9 * MIN + i * 100); const w = write(tick(T0 + 10 * MIN)); return w.length === 1 && w[0].rec.progress.done === 70 })())
  // the replay: last_activity from the rep lines; the bar from the newest cp
  const now = T0 + 11 * MIN
  const b = A.createActivity({ origin: 'HOST-A' })
  A.replayNewestFirst(b, ['{"truncated', ...file.slice().reverse()], now)
  const sc = A.getEntity(b, I, 'w').contexts.get('scan')
  check('replay: the bar + current line come back from the newest cp', sc.progress.done === 70 && sc.current.text === '{progress}')
  check('replay: last_activity = the newest record or rep `last` listing the key', sc.last_activity === T0 + 10 * MIN && A.getEntity(b, I, 'w').contexts.get('other').last_activity === T0 + 8 * MIN + 2000)
  check('replay: checkpoints never enter the log history', A.getEntity(b, I, 'w').log.map(e => e.text).join() === 'a logged line')
  check('replay: a garbled record (a crash mid-rewrite) is skipped', A.recordKind('{"truncated') === null && A.recordKind({ rep: [1], n: 1 }) === null && A.recordKind({ kind: 'cp', session: 's', context: 'c', ts: 1 }) === null)
  check('replay: today\'s cp keys are re-derived (new cps continue the numbering)', b.cp && b.cp.next === 3 && b.cp.keys.size === 2)
  // a context alive all day on ONE old cp + ONE rep line: the cp is older than the window but the rep is inside it
  const TB = T0 - 2 * HOUR   // 04:00 UTC: TB .. TB+3h is one local day in every real timezone
  const s3 = A.createActivity({ origin: 'H', config: { finished_visible_hours: 1 } })
  const oldCp = { v: 1, kind: 'cp', k: 4, ts: TB, session: 'S', project: 'P', user: 'u', agent: null, context: 'scan', current: { id: 'i', ts: TB, text: 'scanning', state: 'running' }, state: 'running', progress: { done: 5, total: 9, unit: '' }, eta_at: null, new_session: true, new_entity: true, new_context: true }
  const repLine = { rep: [4], n: 200, since: TB + MIN, last: TB + 3 * HOUR }
  A.replayNewestFirst(s3, [repLine, { v: 1, id: 'z', ts: TB + 1000, session: 'S', project: 'P', user: 'u', agent: null, context: 'other', text: 'old', state: 'running' }, oldCp], TB + 3 * HOUR + MIN)
  const sc3 = A.getEntity(s3, { session: 'S', project: 'P', user: 'u' }, null).contexts.get('scan')
  check('replay: an old cp still needed by an in-window rep line is used (and old entries are not)', !!sc3 && sc3.current.text === 'scanning' && sc3.last_activity === TB + 3 * HOUR
    && !A.getEntity(s3, { session: 'S', project: 'P', user: 'u' }, null).contexts.has('other'))
  // a new local day: keys restart and every live context gets a full cp there
  const tomorrow = T0 + 30 * HOUR
  say(st, I, { agent: 'w', context: '@~scan', progress: '70/100', log: false }, tomorrow - 1000)
  const w6 = tick(tomorrow)
  check('cp: a new day\'s file -> keys restart at 1, an unchanged context gets a full cp', w6.length === 1 && w6[0].kind === 'cp' && w6[0].rec.k === 1)
  // flushCheckpoints: every dirty context now (a clean shutdown)
  say(st, I, { agent: 'w', context: '@~scan', progress: '71/100', log: false }, tomorrow + 1000)
  say(st, I, { agent: 'w', text: '@~other y', log: false }, tomorrow + 2000)
  const fl = A.flushCheckpoints(st, tomorrow + 3000)
  check('flushCheckpoints: a cp per dirty context, regardless of the interval', fl.length === 2 && fl.every(w => w.kind === 'cp'))
  // v1.59.0 (#70 step 3, the tray's prepare-shutdown): { withRep:true } also returns the repeat line for the alive-but-unchanged
  say(st, I, { agent: 'w', context: '@~scan', progress: '72/100', log: false }, tomorrow + 4000)
  say(st, I, { agent: 'w', text: '@~other y', log: false }, tomorrow + 5000)   // identical line: alive, unchanged
  const fr = A.flushCheckpoints(st, tomorrow + 6000, { withRep: true })
  const otherK = fr.length === 2 ? st.cp.keys.get([...st.cp.keys.keys()].find(k => k.includes('other'))) : null
  check('flushCheckpoints withRep: the changed context\'s cp AND a repeat line for the unchanged one', fr.length === 2 && fr[0].kind === 'cp' && fr[0].rec.progress.done === 72
    && fr[1].kind === 'rep' && J(fr[1].rec.rep) === J([otherK]) && fr[1].rec.last === tomorrow + 6000, J(fr))
  check('flushCheckpoints (default): still cp lines only', A.flushCheckpoints(st, tomorrow + 7000).every(w => w.kind === 'cp'))
}

// ================================================================= step 2: replay == chronological apply (seeded random)
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const byKey = (a, b) => (String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0)
function dump(st, full = true) {
  const ent = e => ({ path: e.path, finished_at: e.finished_at, ...(full ? { started_at: e.started_at, last_activity: e.last_activity, gone_at: e.gone_at, stale_after_ms: e.stale_after_ms, log: e.log, log_dropped: e.log_dropped } : {}),
    contexts: [...e.contexts.values()].sort(byKey).map(c => ({ name: c.name, current: c.current && (full ? c.current : { id: c.current.id, text: c.current.text, state: c.current.state, details: c.current.details, data: c.current.data }),
      progress: c.progress, eta_at: c.eta_at, ...(full ? { created_at: c.created_at, last_activity: c.last_activity, stale_after_ms: c.stale_after_ms } : {}) })) })
  return J([...st.local.values()].sort(byKey).map(s => ({ key: s.key, realm: s.realm, session: s.session, project: s.project, user: s.user, ...(full ? { host: s.host, created_at: s.created_at, last_activity: s.last_activity, gone_at: s.gone_at } : {}),
    self: ent(s.self), agents: [...s.agents.values()].sort(byKey).map(ent) })))
}
function genMessages(seed, n, { unlogged = 0 } = {}) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)]
  const idents = [{ session: 'Alpha', project: 'AIMB', user: 'robin', host: 'H1' }, { session: 'beta', project: 'Marz', user: 'robin', host: 'H1' }, { session: 'ALPHA', project: 'aimb', user: 'kim', host: 'H1' }]
  const agents = [null, null, 'w1', 'W1', 'w2/sub', 'w3', 'deep/a/b']
  const ctxs = ['', '@build ', '@~build ', '@~Build ', '@tiles ', '@~tiles ', '@~"strip 17" ', '@root ', '@~root ', '@~root ']
  const out = []
  let t = T0
  for (let i = 0; i < n; i++) {
    t += 1000 + Math.floor(r() * 90000)
    const input = { agent: pick(agents), text: pick(ctxs) + `m${i} {progress}` }
    if (r() < 0.3) input.state = pick(A.ACTIVITY_STATES)
    if (r() < 0.25) input.progress = r() < 0.15 ? 'none' : `${Math.floor(r() * 50)}/${50 + Math.floor(r() * 50)} ${pick(['tiles', 'Tiles', '', 'files'])}`
    if (r() < 0.2) input.eta = r() < 0.2 ? 'none' : `${1 + Math.floor(r() * 90)}m`
    if (r() < 0.1) input.stale_after = `${5 + Math.floor(r() * 120)}m`
    if (r() < 0.1) input.details = `details ${i}`
    if (r() < 0.1) input.data = { i, v: [i, 'x'] }
    if (unlogged && r() < unlogged) { input.log = false; if (!input.text.startsWith('@~') && r() < 0.6) input.progress = `${i % 50}/50` }
    if (r() < 0.03) { delete input.text; if (!input.progress && !input.eta) input.progress = `${i % 7}/7` }   // default text
    out.push({ ident: pick(idents), input, t })
  }
  return out
}
{
  for (const seed of [7, 70, 1958]) {
    const msgs = genMessages(seed, 1500)
    const A1 = A.createActivity({ origin: 'H1', config: { log_entries_per_agent: 10 } }), entries = []
    let applied = 0
    for (const m of msgs) { const r = say(A1, m.ident, m.input, m.t); if (r.ok) { applied++; if (r.entry) entries.push(JSON.parse(J(r.entry))) } }
    const now = msgs.at(-1).t + MIN
    A.expire(A1, now)
    const B = A.createActivity({ origin: 'H1', config: { log_entries_per_agent: 10 } })
    const st = A.replayNewestFirst(B, entries.slice().reverse(), now)
    check(`replay == chronological apply: seed ${seed} (${applied} msgs, ${st.entries} entries; current state AND log contents)`, dump(A1) === dump(B), firstDiff(dump(A1), dump(B)))
  }
  // with log:false messages + periodic checkpoints + a final flush: current lines, bars, ETAs, states, finished agree
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
}
function firstDiff(a, b) { if (a === b) return ''; let i = 0; while (i < a.length && a[i] === b[i]) i++; return `@${i}: …${a.slice(Math.max(0, i - 120), i + 80)}\n  vs …${b.slice(Math.max(0, i - 120), i + 80)}` }

// ================================================================= step 2: replay — instances, eviction, window, phase 1
{
  // an agent evicted at the 128 limit and later re-created: the replay must not merge the two instances
  const st = mk({ log_entries_per_agent: 10 }), I = S1, entries = []
  const sayE = (input, t) => { const r = say(st, I, input, t); if (r.entry) entries.push(JSON.parse(J(r.entry))); return r }
  for (let i = 1; i <= 128; i++) sayE({ agent: `a${i}`, text: `@~work a${i} start`, progress: `${i}/200` }, T0 + i * 1000)
  sayE({ agent: 'a5', text: '@~root done', state: 'done' }, T0 + 200000)
  sayE({ agent: 'a9', text: '@~root done', state: 'done' }, T0 + 201000)
  check('harness: the 129th agent evicts a5', sayE({ agent: 'new1', text: 'hi' }, T0 + 202000).evicted.join() === 'a5')
  sayE({ agent: 'new1', text: '@~root done', state: 'done' }, T0 + 203000)
  check('harness: a5 comes back as a NEW instance (evicts a9)', sayE({ agent: 'a5', text: '@~fresh back again' }, T0 + 204000).evicted.join() === 'a9')
  const now = T0 + 300000
  A.expire(st, now)
  const B = mk({ log_entries_per_agent: 10 })
  A.replayNewestFirst(B, entries.slice().reverse(), now)
  check('replay: evicted agents stay evicted; a re-created agent is a NEW instance (no old contexts / log)', dump(st) === dump(B) && !A.getEntity(B, I, 'a9') && !A.getEntity(B, I, 'a5').contexts.has('work'), firstDiff(dump(st), dump(B)))
  // the window: records older than finished_visible_hours are not replayed
  const W = mk({ finished_visible_hours: 2 }), ents = []
  const sw = (input, t) => { const r = say(W, I, input, t); if (r.entry) ents.push(JSON.parse(J(r.entry))) }
  sw({ agent: 'old', text: '@~root long gone', state: 'done' }, T0)
  sw({ agent: 'live', text: '@~root recent' }, T0 + 5 * HOUR)
  const W2 = mk({ finished_visible_hours: 2 })
  const sts = A.replayNewestFirst(W2, ents.slice().reverse(), T0 + 5 * HOUR + MIN)
  check('replay: only records within finished_visible_hours (an agent finished before the window is not resurrected)', !A.getEntity(W2, I, 'old') && !!A.getEntity(W2, I, 'live') && sts.entries === 1)
  check('replay: feed() reports "old" for a record before the window', A.createReplay(mk({ finished_visible_hours: 1 }), { now: T0 + 2 * HOUR }).feed(ents[0]) === 'old')
}
{
  // phase 1: the caller can tell when every entity/context seen so far is resolved, and publish early
  const st = mk(), I = S1, entries = []
  const sayE = (input, t) => { const r = say(st, I, input, t); if (r.entry) entries.push(JSON.parse(J(r.entry))) }
  sayE({ text: '@~root orchestrating' }, T0)                                     // the session's own entity (oldest)
  sayE({ agent: 'w', text: '@~build compiling', progress: '1/4', eta: '10m' }, T0 + MIN)
  sayE({ agent: 'w', text: '@~root working' }, T0 + 2 * MIN)
  for (let i = 0; i < 30; i++) sayE({ agent: 'w', text: `@build noise ${i}` }, T0 + 3 * MIN + i * 1000)
  const B = mk(), rp = A.createReplay(B, { now: T0 + HOUR })
  const recs = entries.slice().reverse()
  let i = 0
  for (; i < 30; i++) rp.feed(recs[i])
  check('phase 1: not complete while a context\'s current line / bar is unresolved', !rp.phase1Complete() && rp.pending() === 1)
  rp.feed(recs[i++])   // w @~root (root's first record → sealed)
  check('phase 1: still pending: build has no @~ yet', !rp.phase1Complete())
  rp.feed(recs[i++])   // w @~build — resolves build (current, bar, ETA)
  check('phase 1: complete once everything SEEN is resolved (one older record still unread)', rp.phase1Complete() && i === recs.length - 1)
  rp.publish()
  const wb = A.getEntity(B, I, 'w')
  check('phase 1: publish() installs current lines + bars without history', wb.contexts.get('build').current.text === 'compiling' && wb.contexts.get('build').progress.done === 1 && wb.contexts.get('root').current.text === 'working' && wb.log.length === 0)
  rp.feed(recs[i++])
  const fin = rp.finish()
  check('phase 2: finish() adds the history (chronological, capped) and the rest', fin.entries === 33 && A.getEntity(B, I, 'w').log.length === 32 && A.getEntity(B, I, 'w').log[0].text === 'compiling'
    && A.getSession(B, I).self.contexts.get('root').current.text === 'orchestrating' && dump(st) === dump(B))
}

// ================================================================= step 2: the file facet's daily JSONL (+ the replay reading it backwards)
{
  const os = await import('node:os'), fs = await import('node:fs'), path = await import('node:path')
  const { create } = await import('../facets/persistence/file.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-actunit-'))
  const store = create({ CFG: {}, HERE: dir, env: { AI_BRIDGE_PERSIST_DIR: dir } }), F = store.activity
  const st = mk({ log_entries_per_agent: 10 }), I = S1, D = A.localDay(T0)
  for (let i = 0; i < 40; i++) { const r = say(st, I, { agent: 'w', text: `@~c${i % 3} ünïcødé ✓ line ${i} {progress}`, progress: `${i}/40 tiles`, details: 'é'.repeat(i * 7) }, T0 + i * 1000); await F.append('HOST', D, J(r.entry)) }
  const back = []
  for await (const r of F.readBackwards('HOST', { chunk: 61 })) back.push(r)   // a tiny chunk: lines and multi-byte chars straddle chunk edges
  check('facet: readBackwards (chunked) yields every line newest first, intact across chunk edges', back.length === 40 && back.every(r => r.rec) && back[0].rec.text.includes('line 39') && back[39].rec.text.includes('line 0'))
  check('facet: offsets + lengths address each line (readAt)', J(await F.readAt('HOST', D, back[5].offset, back[5].length)) === J(back[5].rec))
  const B = mk({ log_entries_per_agent: 10 }), rp = A.createReplay(B, { now: T0 + HOUR })
  for (const r of back) rp.feed(r.rec, r.day)
  rp.finish()
  check('facet → replay: the state rebuilt from the file equals the live one', dump(st) === dump(B), firstDiff(dump(st), dump(B)))
  const a = await F.append('HOST', D, J({ rep: [1], n: 1, since: 1, last: 2 }))
  const r1 = await F.replaceTail('HOST', D, a.offset, J({ rep: [1], n: 2, since: 1, last: 3 }))
  await F.append('HOST', D, J({ v: 1, id: 'act_x_zz-1', ts: T0, session: 'S', context: 'root', text: 'later', state: 'running' }))
  const r2 = await F.replaceTail('HOST', D, a.offset, J({ rep: [1], n: 3, since: 1, last: 4 }))
  const reps = []; for await (const r of F.readBackwards('HOST')) if (r.rec && r.rec.rep) reps.push(r.rec)
  check('facet: replaceTail rewrites the LAST line in place; once something follows it, it appends instead', r1.rewritten === true && r2.rewritten === false && J(reps.map(x => x.n)) === '[3,2]')
  const file = path.join(dir, 'activity', 'host', `${D}.jsonl`)
  fs.appendFileSync(file, '{"crash-mid-wri')   // a crash left a partial last line
  const s2 = create({ CFG: {}, HERE: dir, env: { AI_BRIDGE_PERSIST_DIR: dir } })   // a new process (the next gateway)
  await s2.activity.append('HOST', D, J({ rep: [9], n: 1, since: 5, last: 6 }))
  const tail = []; for await (const r of s2.activity.readBackwards('HOST')) { tail.push(r); if (tail.length === 2) break }
  check('facet: a partial last line (a crash) is skipped as garbled, and the next append starts on a fresh line', tail[0].rec && J(tail[0].rec.rep) === '[9]' && tail[1].rec === null)
  check('facet: find() returns a logged entry by id, never a cp/rep line', (await F.find('HOST', D, 'act_x_zz-1'))?.text === 'later' && (await F.find('HOST', D, 'nope')) === null)
  await F.append('HOST', '2020-01-02', J({ old: true }))
  check('facet: days() + prune() (retention)', J(await F.days('HOST')) === J(['2020-01-02', D]) && J(await F.prune('HOST', '2021-01-01')) === J(['2020-01-02']) && J(await F.days('HOST')) === J([D]))
  check('facet: a bad day name is refused (no path tricks)', await F.append('HOST', '../../x', '{}').then(() => false, () => true))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
