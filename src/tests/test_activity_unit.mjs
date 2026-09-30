// Fast UNIT tests for lib/activity.js — the pure core of #70 (agent activity board), build-plan step 1. No bridge, no
// sockets, no clock: every time is an explicit `now`. Covers parsing (prefixes, limits, progress/eta/stale_after),
// apply semantics (@ vs @~, stickiness, finish, details/data retention, log cap, context/agent limits + eviction),
// the derived views (stale, gone, rollup, visibility), the gossip snapshot + per-origin merge, the memory budget and
// resolveConfig's env/config precedence.
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
check('defaults: the #70 per-host config', J(A.ACTIVITY_DEFAULTS) === J({ log_retention_days: 7, log_entries_per_agent: 200, stale_after_min: 15, finished_visible_hours: 24, memory_budget_mb: 64, enabled: true }))
check('states: running|blocked|failed|done|idle', J(A.ACTIVITY_STATES) === J(['running', 'blocked', 'failed', 'done', 'idle']))
check('env names: AI_BRIDGE_ACTIVITY_<KEY>', A.ACTIVITY_ENV.stale_after_min === 'AI_BRIDGE_ACTIVITY_STALE_AFTER_MIN' && A.ACTIVITY_ENV.enabled === 'AI_BRIDGE_ACTIVITY_ENABLED' && Object.keys(A.ACTIVITY_ENV).length === 6)

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
  check('apply: session lookup is case-insensitive on session + project', A.getSession(st, { session: 'BRIDGET', project: 'aimb' }) === sess)
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
  check('@: progress/eta/state recorded in the log entry only', ctx('build').progress === null && ctx('build').eta_at === null && e().log[0].progress.done === 1 && e().log[0].eta_at === T0 + 10 * MIN && e().log[0].state === 'blocked'
    && A.stateOf(ctx('build')) === 'running')
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
  check('rollup: progress on @ (log-only) messages does not count', R('logonly') === null)
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
  hostB.local.delete(A.sessionKey('AIMB', 'Two'))
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
