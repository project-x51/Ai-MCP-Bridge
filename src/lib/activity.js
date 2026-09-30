// #70 agent activity board — the PURE core (build-plan step 1). No I/O, no timers, no clock: every function that needs
// the time takes `now` (ms epoch) as a parameter, so the whole model is exercised directly by tests/test_activity_unit.
// Nothing here is wired into bridge.mjs yet; step 2 (the `log` tool + daily JSONL) calls this API.
//
// THE MODEL (docs/issues.md #70). The tree is project → session → agent → context → message.
// - A SESSION is keyed by (projKey(project), lc(session)) within an ORIGIN (the host that hosts it). Its own reports
//   (no `agent`) go to `session.self`, an entity shaped exactly like an agent (path null) that never counts toward the
//   agents-per-session limit and is never evicted.
// - An AGENT is a `/`-path label (≤3 segments) under its session. Agents don't register: the first message creates one.
//   Paths are FLAT keys (lc'd, first-seen spelling shown) — `a/b` does not create `a`; the dashboard draws the tree.
// - Every message belongs to a CONTEXT. `@root` (the default) is the entity's own context and exists from creation.
//   `@ctx text` appends to the log only; `@~ctx text` also makes it the context's CURRENT line. No prefix = `@root`,
//   log-only — so setting a current line is always a deliberate `@~`. Context names are lc-keyed (first-seen spelling
//   kept), so `@Build` and `@build` are one context (the #71 lesson: never let case split an identity).
// - STATE (`running|blocked|failed|done|idle`) is the CURRENT line's state; a context with no current line counts as
//   running. Only an `@~` message changes it (an `@` message records its state in its log entry only), like progress
//   and ETA. An entry's state defaults to the context's current state, else running. The entity's state is its root
//   context's. `@~root` done|failed FINISHES the entity (`finished_at`); a later `@~root` running|blocked|idle revives it.
// - STALE is computed, never reported (effectiveState/staleAt): a running or blocked item with no message of ANY kind
//   for longer than its window (the per-message `stale_after` override if its last message set one, else the host's
//   `stale_after_min`). done/failed/idle never go stale, nor does anything under a finished entity. GONE (the session
//   left the mesh — markSessionGone) outranks stale for anything not done/failed.
// - PROGRESS and ETA are context attributes set by `@~` messages and STICKY: a later `@~` line without them keeps them
//   ("none" clears either). ETA is stored as an absolute ms time (eta_at) and dropped when the context goes done/failed.
//   `details` and `data` belong to the LINE: they are replaced by each `@~` and never carried forward.
//
// MEMORY MODEL (#70 "Memory model"): an in-memory log entry keeps only text, state, time, context, the current flag and
// small fields (progress/eta/stale_after + has_details/has_data flags). `details`/`data` live in memory ONLY on each
// context's CURRENT line. apply() RETURNS the full entry (details + data + identity) for the caller to append to the
// host's daily JSONL, which is where older entries' details/data are read back from. Logs are capped per entity
// (`log_entries_per_agent`, oldest dropped); enforceBudget() evicts the oldest finished agents, then the oldest log
// entries — never current lines.
//
// GOSSIP (build-plan step 4): snapshot() is the compact replicated form — current lines only, no details/data (only
// has_* flags so a viewer knows to fetch), no log entries, arrays key-sorted and fields in a fixed order so equal state
// serialises identically. The replication model is PER-ORIGIN OWNERSHIP, not last-writer-wins: each host is
// authoritative for the sessions it hosts, so mergeSnapshot(from, snap) REPLACES everything held for `from` (never a
// field merge), cannot touch another origin's slice or our own, and is idempotent (a canonical signature per slice).
// dropOrigin() forgets a host that left.
//
// LIMITS are locked in code (they change what crosses the mesh, so every bridge must agree — a change is a version
// bump); the per-host knobs come from the `activity` config block + AI_BRIDGE_ACTIVITY_* env (resolveConfig).
import { lc, projKey } from './keys.js'

/** The locked #70 limits. text/context are counted in code points; details/data in UTF-8 bytes (data serialised). */
export const ACTIVITY_LIMITS = Object.freeze({
  text: 240,                        // message text; LONGER IS TRUNCATED (… + warning), not rejected — see parseMessage
  context: 60,                      // context name; longer is REJECTED (a name is an identity: truncating could merge two)
  pathDepth: 3,                     // agent path segments (a/b/c)
  pathSegment: 48,                  // chars per agent path segment (this module's choice; not in the spec table)
  contextsPerAgent: 32,             // INCLUDING @root, which every entity has — so 31 named contexts
  agentsPerSession: 128,            // the session's own entity (self) is not counted
  detailsBytes: 4 * 1024,
  dataBytes: 16 * 1024,
  staleAfterMaxMs: 24 * 3600000,    // a longer stale_after is CLAMPED to 24h (+ warning)
  etaMaxMs: 7 * 86400000,           // an ETA further out than 7 days is rejected (this module's choice)
  unit: 24,                         // progress unit label, code points (this module's choice)
})
/** The reportable states. `stale` and `gone` are derived (effectiveState), never reported. */
export const ACTIVITY_STATES = Object.freeze(['running', 'blocked', 'failed', 'done', 'idle'])
/** The per-host defaults (`activity` config block). */
export const ACTIVITY_DEFAULTS = Object.freeze({
  log_retention_days: 7,            // daily JSONL retention (used by step 2; validated here)
  log_entries_per_agent: 200,       // in-memory log cap per entity
  stale_after_min: 15,              // the default stale window (also the dashboard slider's default)
  finished_visible_hours: 24,       // a finished (or gone) agent stays visible/gossiped this long
  memory_budget_mb: 64,             // enforceBudget's default budget
  enabled: true,
})
/** config key -> env override name (AI_BRIDGE_ACTIVITY_<KEY>). */
export const ACTIVITY_ENV = Object.freeze(Object.fromEntries(Object.keys(ACTIVITY_DEFAULTS).map(k => [k, 'AI_BRIDGE_ACTIVITY_' + k.toUpperCase()])))
// numeric ranges: an out-of-range number is CLAMPED into [lo, hi] and rounded to an integer
const CONFIG_RANGES = {
  log_retention_days: [1, 365],
  log_entries_per_agent: [10, 5000],
  stale_after_min: [1, 1440],
  finished_visible_hours: [0, 720],
  memory_budget_mb: [8, 4096],
}
const MIN = 60000, HOUR = 3600000, MB = 1024 * 1024
const MAX_SESSIONS_PER_ORIGIN = 1024   // bounds a junk/huge gossiped slice (a sane host never gets near it)
const DONE_OR_FAILED = new Set(['done', 'failed'])
const LIVE = new Set(['running', 'blocked'])   // the only states that can go stale

// ---------------------------------------------------------------------------------------------------------------
// small helpers
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)                   // code-unit order: locale-free, deterministic
const cpLen = s => { let n = 0; for (const _ of s) n++; return n }   // length in code points
const cpSlice = (s, n) => Array.from(s).slice(0, n).join('')
const utf8 = s => Buffer.byteLength(s, 'utf8')
/** A pass/fail result: { ok:true, ...fields } or { ok:false, code, what }.
 * @typedef {{ ok: boolean, code?: string, what?: string, [key: string]: any }} ActivityResult */
/** @returns {ActivityResult} */
const bad = (code, what) => ({ ok: false, code, what })
const has = (o, k) => o[k] !== undefined && o[k] !== null && o[k] !== ''
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g
/** One-liner text: newline/tab runs → one space, other control chars removed, trimmed. */
const normText = s => s.replace(/\s*[\r\n\t\f\v]+\s*/g, ' ').replace(CONTROL, '').trim()
/** Drop null/undefined/false fields (compact gossip; a missing flag reads as false). Field order is kept. */
function compact(o) { const r = {}; for (const k of Object.keys(o)) { const v = o[k]; if (v !== null && v !== undefined && v !== false) r[k] = v } return r }

/** The session key within an origin: projKey(project) + lc(session), JSON-encoded so no separator can collide. */
export const sessionKey = (project, session) => JSON.stringify([projKey(project), lc(session)])

// ---------------------------------------------------------------------------------------------------------------
// config

function numVal(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v === 'string' && /^\s*[-+]?\d+(\.\d+)?\s*$/.test(v)) return Number(v)
  return NaN
}
function boolVal(v) {
  if (typeof v === 'boolean') return v
  if (v === 1 || v === 0) return v === 1
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(s)) return true
    if (['0', 'false', 'no', 'off'].includes(s)) return false
  }
  return null
}
/**
 * Resolve the per-host activity config. Precedence per key: env `AI_BRIDGE_ACTIVITY_<KEY>` > the config block's key >
 * ACTIVITY_DEFAULTS. A number outside its range is clamped (and rounded); a value that isn't a number (or a boolean for
 * `enabled`) is ignored — an invalid ENV value falls through to the config block's value, and an invalid config value
 * to the default. Empty strings count as unset. Returns a frozen object with exactly the ACTIVITY_DEFAULTS keys.
 * @param {any} cfgBlock  the `activity` block of config.json (anything else is treated as {})
 * @param {Record<string, string|undefined>} [env]  e.g. process.env
 * @param {string[]} [warnings]  optional sink: one human line per ignored or clamped value
 */
export function resolveConfig(cfgBlock, env = {}, warnings) {
  const block = cfgBlock && typeof cfgBlock === 'object' && !Array.isArray(cfgBlock) ? cfgBlock : {}
  const e = env && typeof env === 'object' ? env : {}
  const warn = s => { if (Array.isArray(warnings)) warnings.push(s) }
  const out = {}
  for (const key of Object.keys(ACTIVITY_DEFAULTS)) {
    const cands = []   // [source label, raw] in precedence order
    if (has(e, ACTIVITY_ENV[key]) && String(e[ACTIVITY_ENV[key]]).trim() !== '') cands.push([ACTIVITY_ENV[key], e[ACTIVITY_ENV[key]]])
    if (has(block, key)) cands.push([`activity.${key}`, block[key]])
    let val = ACTIVITY_DEFAULTS[key]
    for (const [src, raw] of cands) {
      if (key === 'enabled') {
        const b = boolVal(raw)
        if (b === null) { warn(`${src}=${JSON.stringify(raw)} is not a boolean — ignored`); continue }
        val = b; break
      }
      const n = numVal(raw)
      if (!Number.isFinite(n)) { warn(`${src}=${JSON.stringify(raw)} is not a number — ignored`); continue }
      const [lo, hi] = CONFIG_RANGES[key]
      const c = Math.min(hi, Math.max(lo, Math.round(n)))
      if (c !== n) warn(`${src}=${n} clamped to ${c} (range ${lo}..${hi})`)
      val = c; break
    }
    out[key] = val
  }
  return Object.freeze(out)
}

// ---------------------------------------------------------------------------------------------------------------
// parsing

/**
 * A duration → ms, or NaN. A number, or a bare numeric string, is MINUTES (like consent's TTLs). Otherwise one or more
 * `<n><unit>` terms, unit d|h|m|s, optionally space-separated, decimals allowed: "15m", "1h25m", "1h 25m", "90s",
 * "1.5h". Zero is returned as 0 (callers decide whether that's allowed).
 * @param {any} v
 */
export function parseDuration(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * MIN) : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim().toLowerCase()
  if (!s) return NaN
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * MIN)
  const UNIT = { d: 86400000, h: HOUR, m: MIN, s: 1000 }
  const re = /(\d+(?:\.\d+)?)\s*([dhms])\s*/y
  let ms = 0, pos = 0, m
  while ((m = re.exec(s))) { ms += parseFloat(m[1]) * UNIT[m[2]]; pos = re.lastIndex }
  return pos && pos === s.length ? Math.round(ms) : NaN
}

/**
 * Progress → { ok:true, value:{done,total,unit}, warning? } | { ok:false, what }. Accepts "4812/12000 tiles",
 * "4812/12000:tiles", "3/6" (unit ''), "61%" (→ {done:61,total:100,unit:'%'}), a bare number (a percent) or an object
 * {done,total,unit}. total must be > 0 and done ≥ 0; done > total (or a percent > 100) is CLAMPED to total with a
 * 'progress-clamped' warning — counts legitimately overshoot an estimated total, and losing the whole report over it
 * would be worse. The unit is ≤ ACTIVITY_LIMITS.unit code points.
 * @param {any} v
 */
export function parseProgress(v) {
  let done, total, unit = ''
  if (typeof v === 'number') { done = v; total = 100; unit = '%' }
  else if (v && typeof v === 'object' && !Array.isArray(v)) {
    done = Number(v.done); total = Number(v.total); unit = typeof v.unit === 'string' ? v.unit : ''
    if (v.done === null || v.done === '' || v.total === null || v.total === '') return { ok: false, what: 'progress {done,total} must be numbers' }
  } else if (typeof v === 'string') {
    const s = v.trim()
    let m = s.match(/^(\d+(?:\.\d+)?)\s*%$/)
    if (m) { done = Number(m[1]); total = 100; unit = '%' }
    else if ((m = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?:\s*:\s*|\s+|$)(.*)$/s))) { done = Number(m[1]); total = Number(m[2]); unit = m[3] }
    else return { ok: false, what: `progress "${cpSlice(s, 40)}" isn't "done/total [unit]", "done/total:unit" or "N%"` }
  } else return { ok: false, what: 'progress must be a string like "3/6", "4812/12000 tiles" or "61%"' }
  unit = normText(String(unit)).replace(/\s+/g, ' ')
  if (!Number.isFinite(done) || !Number.isFinite(total)) return { ok: false, what: 'progress done/total must be numbers' }
  if (total <= 0) return { ok: false, what: 'progress total must be > 0' }
  if (done < 0) return { ok: false, what: 'progress done must be ≥ 0' }
  if (total > 1e15) return { ok: false, what: 'progress total is too large' }
  if (cpLen(unit) > ACTIVITY_LIMITS.unit) return { ok: false, what: `progress unit is longer than ${ACTIVITY_LIMITS.unit} chars` }
  let warning
  if (done > total) { done = total; warning = 'progress-clamped' }
  return { ok: true, value: { done, total, unit }, warning }
}

/**
 * ETA → absolute ms epoch, or NaN. A duration ("15m", "1h25m", "90s"; a number = minutes; > 0 and ≤ 7 days) counts
 * from `now`. A clock time "HH:MM" (24h) is LOCAL time at `tzOffsetMin` (minutes EAST of UTC: NZST = +720 — i.e.
 * `-new Date().getTimezoneOffset()`), today, or tomorrow if that time has already passed. Resolved at parse time so
 * the stored value is absolute. A DST change between now and the clock time is not modelled (off by the shift).
 * @param {any} v
 * @param {number} now
 * @param {number} [tzOffsetMin]
 */
export function parseEta(v, now, tzOffsetMin = 0) {
  if (!Number.isFinite(now)) return NaN
  const m = typeof v === 'string' && v.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  if (m) {
    const tz = (Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0) * MIN
    const dayStart = Math.floor((now + tz) / 86400000) * 86400000 - tz          // local midnight, as UTC ms
    let at = dayStart + Number(m[1]) * HOUR + Number(m[2]) * MIN
    if (at <= now) at += 86400000
    return at
  }
  const ms = parseDuration(v)
  return Number.isFinite(ms) && ms > 0 && ms <= ACTIVITY_LIMITS.etaMaxMs ? now + ms : NaN
}

/**
 * Canonicalise a context NAME (without its at-sign/tilde markers): whitespace runs → one space, trimmed, ≤ ACTIVITY_LIMITS.context code
 * points, no control chars or `"`. Any case of "root" → 'root'.
 * @param {any} raw
 * @returns {ActivityResult} { ok:true, name } or { ok:false, code, what }
 */
export function normContextName(raw) {
  if (typeof raw !== 'string') return bad('bad-context', 'context must be a string')
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) return bad('bad-context', 'context name is empty')
  if (/["\u0000-\u001f\u007f]/.test(name)) return bad('bad-context', 'context name may not contain quotes or control characters')
  if (cpLen(name) > ACTIVITY_LIMITS.context) return bad('context-too-long', `context name is longer than ${ACTIVITY_LIMITS.context} chars`)
  return { ok: true, name: lc(name) === 'root' ? 'root' : name }
}

const SEGMENT = /^[\p{L}\p{N}_][\p{L}\p{N}_.:#+-]*$/u
/**
 * Canonicalise an agent path: 1..3 `/`-separated segments, each trimmed, ≤ 48 chars, letters/digits/`_` then also
 * `. : # + -` (no spaces — it's a CLI flag value). Leading/trailing slashes are dropped; an empty inner segment is not.
 * @param {any} raw
 * @returns {ActivityResult} { ok:true, path } or { ok:false, code, what }
 */
export function normAgentPath(raw) {
  if (typeof raw !== 'string') return bad('bad-agent', 'agent must be a string path like "spec-70/research"')
  const segs = raw.trim().replace(/^\/+|\/+$/g, '').split('/').map(s => s.trim())
  if (segs.length === 1 && !segs[0]) return bad('bad-agent', 'agent path is empty')
  if (segs.length > ACTIVITY_LIMITS.pathDepth) return bad('agent-too-deep', `agent path has ${segs.length} levels; the limit is ${ACTIVITY_LIMITS.pathDepth} (a/b/c)`)
  for (const s of segs) {
    if (!s) return bad('bad-agent', 'agent path has an empty segment')
    if (cpLen(s) > ACTIVITY_LIMITS.pathSegment) return bad('bad-agent', `agent path segment "${cpSlice(s, 20)}…" is longer than ${ACTIVITY_LIMITS.pathSegment} chars`)
    if (!SEGMENT.test(s)) return bad('bad-agent', `agent path segment "${s}" may only use letters, digits and _ . : # + - (no spaces)`)
  }
  return { ok: true, path: segs.join('/') }
}

// A leading context prefix in text: @name / @~name / @"name with spaces" / @~"name". `@` (or `@~`) followed by
// whitespace or the end is NOT a prefix (the text is literal). An unterminated quote, or a quote not followed by
// whitespace, is an error (clearly meant as a prefix). Returns { name:null } when there is no prefix.
/** @returns {ActivityResult} */
function splitPrefix(text) {
  const t = text.replace(/^\s+/, '')
  if (t[0] !== '@') return { ok: true, name: null }
  let i = 1, current = false
  if (t[i] === '~') { current = true; i++ }
  if (i >= t.length || /\s/.test(t[i])) return { ok: true, name: null }
  let raw, rest
  if (t[i] === '"') {
    const close = t.indexOf('"', i + 1)
    if (close < 0) return bad('bad-context', 'unterminated quoted context name (@"…")')
    if (close + 1 < t.length && !/\s/.test(t[close + 1])) return bad('bad-context', 'a quoted context name must be followed by a space')
    raw = t.slice(i + 1, close); rest = t.slice(close + 1)
  } else {
    const m = t.slice(i).match(/^\S+/)
    raw = m[0]; rest = t.slice(i + raw.length)
  }
  const n = normContextName(raw)
  if (!n.ok) return n
  return { ok: true, name: n.name, current, rest }
}
// The `context` parameter: "@root" | "@Ctx" | "@~Ctx" | "@~\"Ctx\"" — the markers are optional ("build" = @build,
// "~build" = @~build) and the whole remainder is the name (spaces allowed without quotes).
/** @returns {ActivityResult} */
function parseContextParam(v) {
  if (typeof v !== 'string') return bad('bad-context', 'context must be a string like "@root", "@build" or "@~build"')
  let s = v.trim(), current = false
  if (s[0] === '@') s = s.slice(1)
  if (s[0] === '~') { current = true; s = s.slice(1) }
  s = s.trim()
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1)
  const n = normContextName(s)
  return n.ok ? { ok: true, name: n.name, current } : n
}

/**
 * @typedef {{ done:number, total:number, unit:string }} ActivityProgress
 * @typedef {{
 *   agent: string|null, context: string, root: boolean, current: boolean, text: string, state: string|null,
 *   progress?: ActivityProgress|null, eta_at?: number|null, stale_after_ms: number|null,
 *   details: string|null, data: any, warnings: string[] }} ActivityMsg
 *   `progress` / `eta_at` are ABSENT when not given and null when explicitly cleared ("none").
 */

/**
 * Validate + normalise one report (the `log` tool / aimb-log script argument shape) into a message for apply().
 * - Context: from `context` when given (then `text` is taken LITERALLY — no prefix parsing, so a text may start with
 *   "@"), else a leading `@name` / `@~name` / `@"a b"` / `@~"a b"` prefix, which is stripped. Absent → `@root`, log-only.
 * - text: newlines/tabs → spaces, trimmed, must be non-empty; longer than 240 code points is TRUNCATED to 239 + "…"
 *   with a 'text-truncated' warning (a status line is worth keeping even when chatty; a reject would cost the agent
 *   another call). Everything else over a limit is REJECTED.
 * - state: running|blocked|failed|done|idle (case-insensitive) or absent (null → apply() picks the default).
 * - progress / eta: see parseProgress / parseEta; the string "none" clears either (on an `@~` line).
 * - stale_after: a duration > 0; over 24h is clamped with a 'stale-after-capped' warning.
 * - details: a string ≤ 4 KB UTF-8. data: a plain object/array (or a JSON string of one), JSON-cloned, ≤ 16 KB.
 * @param {any} input  { agent?, text, context?, state?, progress?, eta?, stale_after?, details?, data? }
 * @param {{ now?: number, tzOffsetMin?: number }} [opts]  needed only to resolve an eta
 * @returns {ActivityResult} { ok:true, msg: ActivityMsg } or { ok:false, code, what }
 */
export function parseMessage(input, opts = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('bad-input', 'expected an object { text, agent?, context?, state?, progress?, eta?, stale_after?, details?, data? }')
  const warnings = []
  let agent = null
  if (has(input, 'agent')) { const a = normAgentPath(input.agent); if (!a.ok) return a; agent = a.path }
  if (typeof input.text !== 'string') return bad('bad-text', 'text must be a string')
  let text = input.text, context = 'root', current = false
  if (has(input, 'context') && !(typeof input.context === 'string' && !input.context.trim())) {
    const c = parseContextParam(input.context); if (!c.ok) return c
    context = c.name; current = c.current
  } else {
    const p = splitPrefix(text); if (!p.ok) return p
    if (p.name !== null) { context = p.name; current = p.current; text = p.rest }
  }
  text = normText(text)
  if (!text) return bad('text-empty', 'text is empty (a context prefix alone is not a message)')
  if (cpLen(text) > ACTIVITY_LIMITS.text) { text = cpSlice(text, ACTIVITY_LIMITS.text - 1) + '…'; warnings.push('text-truncated') }
  let state = null
  if (has(input, 'state')) {
    state = typeof input.state === 'string' ? input.state.trim().toLowerCase() : ''
    if (!ACTIVITY_STATES.includes(state)) return bad('bad-state', `state must be one of ${ACTIVITY_STATES.join('|')}`)
  }
  /** @type {ActivityMsg} */
  const msg = { agent, context, root: context === 'root', current, text, state, stale_after_ms: null, details: null, data: null, warnings }
  if (has(input, 'progress')) {
    if (typeof input.progress === 'string' && input.progress.trim().toLowerCase() === 'none') msg.progress = null
    else {
      const p = parseProgress(input.progress); if (!p.ok) return bad('bad-progress', p.what)
      msg.progress = p.value; if (p.warning) warnings.push(p.warning)
    }
  }
  if (has(input, 'eta')) {
    if (typeof input.eta === 'string' && input.eta.trim().toLowerCase() === 'none') msg.eta_at = null
    else {
      if (!Number.isFinite(opts.now)) return bad('bad-eta', 'an eta needs the current time (parseMessage opts.now)')
      const at = parseEta(input.eta, opts.now, opts.tzOffsetMin)
      if (!Number.isFinite(at)) return bad('bad-eta', 'eta must be a duration ("15m", "1h25m", "90s"; > 0, ≤ 7 days) or a local clock time "HH:MM"')
      msg.eta_at = at
    }
  }
  if (has(input, 'stale_after')) {
    let ms = parseDuration(input.stale_after)
    if (!Number.isFinite(ms) || ms <= 0) return bad('bad-stale-after', 'stale_after must be a duration > 0 like "60m" or "2h" (max 24h)')
    if (ms > ACTIVITY_LIMITS.staleAfterMaxMs) { ms = ACTIVITY_LIMITS.staleAfterMaxMs; warnings.push('stale-after-capped') }
    msg.stale_after_ms = ms
  }
  if (has(input, 'details')) {
    if (typeof input.details !== 'string') return bad('bad-details', 'details must be a string')
    if (utf8(input.details) > ACTIVITY_LIMITS.detailsBytes) return bad('details-too-large', `details is ${utf8(input.details)} bytes; the limit is ${ACTIVITY_LIMITS.detailsBytes} — keep it short`)
    msg.details = input.details
  }
  if (has(input, 'data')) {
    let d = input.data
    if (typeof d === 'string') { try { d = JSON.parse(d) } catch { return bad('bad-data', 'data is a string but not valid JSON') } }
    const plain = Array.isArray(d) || (d && typeof d === 'object' && (Object.getPrototypeOf(d) === Object.prototype || Object.getPrototypeOf(d) === null))
    if (!plain) return bad('bad-data', 'data must be a JSON object or array')
    let json
    try { json = JSON.stringify(d) } catch (e) { return bad('bad-data', `data is not JSON-serialisable (${e && e.message})`) }
    const bytes = utf8(json)
    if (bytes > ACTIVITY_LIMITS.dataBytes) return bad('data-too-large', `data is ${bytes} bytes serialised; the limit is ${ACTIVITY_LIMITS.dataBytes} — keep it small`)
    msg.data = JSON.parse(json)   // a clone of plain JSON: nothing the caller mutates later leaks into the state
  }
  return { ok: true, msg }
}

// ---------------------------------------------------------------------------------------------------------------
// state

/**
 * @typedef {{ id:string, ts:number, text:string, state:string, details?:string|null, data?:any, data_bytes?:number,
 *   has_details?:boolean, has_data?:boolean }} ActivityLine
 * @typedef {{ name:string, key:string, created_at:number, last_activity:number, stale_after_ms:number|null,
 *   current:ActivityLine|null, progress:ActivityProgress|null, eta_at:number|null }} ActivityContext
 * @typedef {{ path:string|null, key:string|null, started_at:number, last_activity:number, finished_at:number|null,
 *   gone_at:number|null, stale_after_ms:number|null, contexts:Map<string, ActivityContext>, log:any[],
 *   log_dropped:number }} ActivityEntity
 * @typedef {{ key:string, origin:string, session:string, project:string, user:string|null, host:string|null,
 *   created_at:number, last_activity:number, gone_at:number|null, self:ActivityEntity,
 *   agents:Map<string, ActivityEntity> }} ActivitySession
 * @typedef {{ v:1, config:any, origin:string, idPrefix:string, seq:number, local:Map<string, ActivitySession>,
 *   remote:Map<string, { sessions:Map<string, ActivitySession>, sig:string }> }} ActivityState
 */

/**
 * A fresh state container (a plain object of Maps; every function here takes it as the first argument).
 * @param {{ config?: any, origin?: string, idPrefix?: string }} [opts]
 *   config: a resolveConfig() result or a raw `activity` block (re-validated either way, env NOT consulted here);
 *   origin: this host's name (whose slice snapshot() produces and mergeSnapshot() refuses to overwrite);
 *   idPrefix: prefix for entry ids — step 2 should pass something unique per bridge run (host + boot nonce), since the
 *   in-state sequence restarts at 0.
 * @returns {ActivityState}
 */
export function createActivity({ config, origin = 'local', idPrefix = 'act_' } = {}) {
  return { v: 1, config: resolveConfig(config || {}, {}), origin: String(origin || 'local'), idPrefix: String(idPrefix), seq: 0, local: new Map(), remote: new Map() }
}

/** @returns {ActivityContext} */
function newContext(name, now) {
  return { name, key: lc(name), created_at: now, last_activity: now, stale_after_ms: null, current: null, progress: null, eta_at: null }
}
/** @returns {ActivityEntity} */
function newEntity(path, now) {
  const e = { path, key: path == null ? null : lc(path), started_at: now, last_activity: now, finished_at: null, gone_at: null,
    stale_after_ms: null, contexts: new Map(), log: [], log_dropped: 0 }
  e.contexts.set('root', newContext('root', now))
  return e
}
function oldestFinished(sess) {
  let best = null
  for (const a of sess.agents.values()) if (a.finished_at && (!best || a.finished_at < best.finished_at || (a.finished_at === best.finished_at && a.key < best.key))) best = a
  return best
}
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/**
 * Apply one parsed message from a LOCAL session. Atomic: a rejected message changes nothing.
 * - Creates the session / agent / context on first use (a new entity starts with an empty @root).
 * - Appends a small log entry (capped at config.log_entries_per_agent, oldest dropped → entity.log_dropped).
 * - `@~` sets the context's current line (+ its details/data, which live nowhere else in memory) and applies
 *   progress / eta (sticky; "none" cleared them at parse); an `@` message records them in its entry only.
 * - Entry state = msg.state, else the context's current state, else running.
 * - `@~root` done|failed finishes the entity (finished_at, first time only); `@~root` running|blocked|idle revives it.
 * - last_activity (session, entity, context) = now (never moved backwards) for ANY message; `stale_after` is stored on the entity AND the
 *   context and lasts until each one's next message (a message without it clears it).
 * - Limits: a new context beyond 32 (incl. root) → 'too-many-contexts'. A new agent beyond 128 EVICTS the session's
 *   oldest FINISHED agent (reported in `evicted`; its log survives in the JSONL) and is rejected ('too-many-agents')
 *   only when none has finished — so a long-running orchestrator cycling through agents isn't locked out for 24h.
 * - A message arriving for a session marked gone clears gone_at on the session and the reporting entity.
 * @param {ActivityState} state
 * @param {{ session:string, project?:string, user?:string, host?:string }} ident  the reporting session
 * @param {ActivityMsg} msg  parseMessage(...).msg
 * @param {number} now
 * @returns {ActivityResult} { ok:true, id, ts, entry, current, state, stale_at, agent, context, evicted:string[],
 *   warnings:string[] } or { ok:false, code, what }
 */
export function apply(state, ident, msg, now) {
  if (!state || !(state.local instanceof Map)) return bad('bad-state-object', 'pass a createActivity() state')
  if (!state.config.enabled) return bad('activity-disabled', 'the activity board is disabled on this host (activity.enabled)')
  if (!Number.isFinite(now)) return bad('bad-now', 'now must be a ms epoch')
  if (!msg || typeof msg.text !== 'string' || typeof msg.context !== 'string') return bad('bad-message', 'pass the msg from parseMessage()')
  const sessName = str(ident && ident.session)
  if (!sessName) return bad('bad-session', 'the reporting session needs a name')
  const L = ACTIVITY_LIMITS
  const sKey = sessionKey(ident.project, sessName)
  let sess = state.local.get(sKey)
  const aKey = msg.agent == null ? null : lc(msg.agent)
  let ent = sess ? (aKey === null ? sess.self : sess.agents.get(aKey)) : null
  let evict = null
  if (aKey !== null && !ent && sess && sess.agents.size >= L.agentsPerSession) {
    evict = oldestFinished(sess)
    if (!evict) return bad('too-many-agents', `this session already has ${L.agentsPerSession} agents and none has finished (report @~root done/failed when an agent ends)`)
  }
  const cKey = lc(msg.context)
  let ctx = ent ? ent.contexts.get(cKey) : null
  if (!ctx && ent && ent.contexts.size >= L.contextsPerAgent) return bad('too-many-contexts', `this ${aKey === null ? 'session' : 'agent'} already has ${L.contextsPerAgent} contexts (including @root)`)
  // ---- every check passed: mutate ----
  if (!sess) {
    sess = { key: sKey, origin: state.origin, session: sessName, project: str(ident.project) || 'unclassified', user: str(ident.user), host: str(ident.host),
      created_at: now, last_activity: now, gone_at: null, self: newEntity(null, now), agents: new Map() }
    state.local.set(sKey, sess)
    if (aKey === null) ent = sess.self
  }
  if (str(ident.user)) sess.user = str(ident.user)
  if (str(ident.host)) sess.host = str(ident.host)
  if (evict) sess.agents.delete(evict.key)
  if (!ent) { ent = newEntity(msg.agent, now); sess.agents.set(aKey, ent) }
  if (!ctx) ctx = ent.contexts.get(cKey)
  if (!ctx) { ctx = newContext(msg.context, now); ent.contexts.set(cKey, ctx) }
  const entryState = msg.state || (ctx.current ? ctx.current.state : null) || 'running'
  const id = `${state.idPrefix}${now.toString(36)}-${(++state.seq).toString(36)}`
  const small = compact({ id, ts: now, context: ctx.name, current: !!msg.current, text: msg.text, state: entryState,
    progress: msg.progress || undefined, eta_at: msg.eta_at || undefined, stale_after_ms: msg.stale_after_ms || undefined,
    has_details: msg.details ? true : undefined, has_data: msg.data != null ? true : undefined })
  ent.log.push(small)
  while (ent.log.length > state.config.log_entries_per_agent) { ent.log.shift(); ent.log_dropped++ }
  // max(): a report timed earlier than one already applied (clock skew, a replayed JSONL) never moves activity back
  sess.last_activity = Math.max(sess.last_activity, now); ent.last_activity = Math.max(ent.last_activity, now); ctx.last_activity = Math.max(ctx.last_activity, now)
  ent.stale_after_ms = ctx.stale_after_ms = msg.stale_after_ms || null
  sess.gone_at = null; ent.gone_at = null
  if (msg.current) {
    ctx.current = { id, ts: now, text: msg.text, state: entryState, details: msg.details || null, data: msg.data != null ? msg.data : null,
      data_bytes: msg.data != null ? utf8(JSON.stringify(msg.data)) : 0 }
    if ('progress' in msg) ctx.progress = msg.progress ? { ...msg.progress } : null
    if ('eta_at' in msg) ctx.eta_at = msg.eta_at || null
    if (DONE_OR_FAILED.has(entryState)) ctx.eta_at = null
    if (cKey === 'root') {
      if (DONE_OR_FAILED.has(entryState)) { if (!ent.finished_at) ent.finished_at = now }
      else ent.finished_at = null
    }
  }
  const entry = { ...small, current: !!msg.current, origin: state.origin, session: sess.session, project: sess.project, user: sess.user, host: sess.host,
    agent: ent.path, details: msg.details || null, data: msg.data != null ? msg.data : null }
  return { ok: true, id, ts: now, entry, current: !!msg.current, state: entryState, stale_at: staleAt(ctx, state.config.stale_after_min, ent),
    agent: ent.path, context: ctx.name, evicted: evict ? [evict.path] : [], warnings: msg.warnings || [] }
}

/**
 * Mark a LOCAL session as having left the mesh (its unfinished agents then show as `gone`), or pass `now = null` to
 * clear it (the session is back). A later message from the session clears it for the session + that entity anyway.
 * @param {ActivityState} state
 * @param {{ session:string, project?:string }} ident
 * @param {number|null} now
 * @returns {boolean} whether the session is known
 */
export function markSessionGone(state, ident, now) {
  const sess = state.local.get(sessionKey(ident.project, ident.session || ''))
  if (!sess) return false
  const at = Number.isFinite(now) ? now : null
  sess.gone_at = at; sess.self.gone_at = at
  for (const a of sess.agents.values()) a.gone_at = at
  return true
}

/**
 * Remove LOCAL agents that finished (or went gone) more than `finished_visible_hours` ago, and gone sessions past the
 * same window. Their history stays in the daily JSONL. Remote slices are expired by their own origin.
 * @param {ActivityState} state
 * @param {number} now
 * @returns {{ session:string, project:string, agent:string|null }[]} what was removed (agent null = the whole session)
 */
export function expire(state, now) {
  const hours = state.config.finished_visible_hours, out = []
  for (const [k, s] of [...state.local]) {
    if (s.gone_at && !visible({ finished_at: null, gone_at: s.gone_at }, now, hours)) { state.local.delete(k); out.push({ session: s.session, project: s.project, agent: null }); continue }
    for (const [ak, a] of [...s.agents]) if (!visible(a, now, hours)) { s.agents.delete(ak); out.push({ session: s.session, project: s.project, agent: a.path }) }
  }
  return out
}

/** A session record, local by default or from a remote origin's slice. */
export function getSession(state, ident, origin) {
  const k = sessionKey(ident.project, ident.session || '')
  if (!origin || origin === state.origin) return state.local.get(k) || null
  const sl = state.remote.get(origin)
  return (sl && sl.sessions.get(k)) || null
}
/** An entity (agent path, or null/undefined = the session itself), local by default. */
export function getEntity(state, ident, agent, origin) {
  const s = getSession(state, ident, origin)
  if (!s) return null
  return agent == null || agent === '' ? s.self : s.agents.get(lc(agent)) || null
}
/** Every session held (local first, then each remote origin), sorted by origin then key. Each has `.origin`. */
export function allSessions(state) {
  const out = [...state.local.values()].sort((a, b) => cmp(a.key, b.key))
  for (const o of [...state.remote.keys()].sort(cmp)) out.push(...[...state.remote.get(o).sessions.values()].sort((a, b) => cmp(a.key, b.key)))
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// derived views (pure; the dashboard's stale slider passes its own staleMin)

/** The reported state of an entity (its root context's current line) or a context (its current line); else running. */
export function stateOf(item) {
  if (!item) return 'running'
  if (item.contexts instanceof Map) { const r = item.contexts.get('root'); return r && r.current ? r.current.state : 'running' }
  return item.current ? item.current.state : 'running'
}
/**
 * When `item` (an entity or a context) goes stale: last_activity + its stale_after override, else staleMin minutes.
 * null when it can't go stale: its state isn't running/blocked, or it (or `parent`, for a context) has finished.
 * @param {any} item @param {number} staleMin @param {any} [parent]  the entity a context belongs to
 */
export function staleAt(item, staleMin, parent) {
  if (!item || item.finished_at || (parent && parent.finished_at)) return null
  if (!LIVE.has(stateOf(item))) return null
  const win = item.stale_after_ms > 0 ? item.stale_after_ms : (Number.isFinite(staleMin) && staleMin > 0 ? staleMin : ACTIVITY_DEFAULTS.stale_after_min) * MIN
  return item.last_activity + win
}
/**
 * The state to SHOW. `gone` (the session left; not for done/failed) outranks `stale`; stale = quiet for LONGER than
 * the window (now > stale_at). Returns { state, was, stale, gone, stale_at } — `was` is the reported state, for
 * "stale, was blocked".
 * @param {any} item @param {number} now @param {number} staleMin @param {any} [parent]
 */
export function effectiveState(item, now, staleMin, parent) {
  const was = stateOf(item)
  const finished = !!(item && (item.finished_at || (parent && parent.finished_at)))
  const gone = !!(item && (item.gone_at || (parent && parent.gone_at))) && !finished && !DONE_OR_FAILED.has(was)
  if (gone) return { state: 'gone', was, stale: false, gone: true, stale_at: null }
  const at = staleAt(item, staleMin, parent)
  const stale = at !== null && now > at
  return { state: stale ? 'stale' : was, was, stale, gone: false, stale_at: at }
}
/** Percent 0..100 of a progress value. */
export const progressPct = p => (p && p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0)
/**
 * The progress an entity's @root shows. A REPORTED @root progress wins (rollup:false). Otherwise its other contexts
 * with progress roll up (rollup:true): summed when they all share a unit (case-insensitive; '' counts as a unit, '%'
 * doesn't sum), else the mean percent as {done:<mean>, total:100, unit:'%'}. null when nothing has progress.
 * @returns {null | { done:number, total:number, unit:string, pct:number, rollup:boolean, n:number }}
 */
export function rollup(entity) {
  if (!entity || !(entity.contexts instanceof Map)) return null
  const root = entity.contexts.get('root')
  if (root && root.progress) return { ...root.progress, pct: progressPct(root.progress), rollup: false, n: 1 }
  const ps = [...entity.contexts.values()].filter(c => c.key !== 'root' && c.progress).sort((a, b) => cmp(a.key, b.key)).map(c => c.progress)
  if (!ps.length) return null
  const u = lc(ps[0].unit)
  if (u !== '%' && ps.every(p => lc(p.unit) === u)) {
    const done = ps.reduce((s, p) => s + p.done, 0), total = ps.reduce((s, p) => s + p.total, 0)
    return { done, total, unit: ps[0].unit, pct: progressPct({ done, total }), rollup: true, n: ps.length }
  }
  const mean = Math.round((ps.reduce((s, p) => s + progressPct(p), 0) / ps.length) * 10) / 10
  return { done: mean, total: 100, unit: '%', pct: mean, rollup: true, n: ps.length }
}
/** Not finished and not gone (the dashboard's "Active only" filter). */
export const isActive = entity => !!entity && !entity.finished_at && !entity.gone_at
/**
 * Still shown/gossiped? Unfinished + present → true; finished (or gone) → for `finishedVisibleHours` after it.
 * @param {any} entity @param {number} now @param {number} finishedVisibleHours
 */
export function visible(entity, now, finishedVisibleHours) {
  if (!entity) return false
  const end = entity.finished_at || entity.gone_at
  if (!end) return true
  return now - end < Math.max(0, Number(finishedVisibleHours) || 0) * HOUR
}

// ---------------------------------------------------------------------------------------------------------------
// gossip: snapshot + per-origin merge

function snapLine(l) {
  return l ? compact({ id: l.id, ts: l.ts, text: l.text, state: l.state, has_details: !!(l.details || l.has_details), has_data: !!(l.data != null || l.has_data) }) : null
}
function snapCtx(c) {
  return compact({ name: c.name, created_at: c.created_at, last_activity: c.last_activity, stale_after_ms: c.stale_after_ms,
    progress: c.progress ? { done: c.progress.done, total: c.progress.total, unit: c.progress.unit } : null, eta_at: c.eta_at, current: snapLine(c.current) })
}
function snapEntity(e) {
  return compact({ path: e.path, started_at: e.started_at, last_activity: e.last_activity, finished_at: e.finished_at, gone_at: e.gone_at,
    stale_after_ms: e.stale_after_ms, contexts: [...e.contexts.values()].sort((a, b) => cmp(a.key, b.key)).map(snapCtx) })
}
function snapSession(s) {
  return compact({ session: s.session, project: s.project, user: s.user, host: s.host, created_at: s.created_at, last_activity: s.last_activity,
    gone_at: s.gone_at, self: snapEntity(s.self), agents: [...s.agents.values()].sort((a, b) => cmp(a.key, b.key)).map(snapEntity) })
}
/**
 * The compact replicated form of one origin's slice (default: ours): current lines only (with has_details/has_data
 * flags, never the details/data), no log entries, sessions/agents/contexts sorted by key and every record's fields in
 * a fixed order with null/false fields omitted — equal state serialises identically. Call expire() first so finished
 * agents past their window leave the gossip.
 * @param {ActivityState} state
 * @param {(s: ActivitySession) => boolean} [sessionFilter]
 * @param {string} [origin]  a remote origin re-gossips that origin's slice verbatim (e.g. a gateway to its followers)
 * @returns {{ v:1, origin:string, sessions:any[] }}
 */
export function snapshot(state, sessionFilter, origin) {
  const o = origin || state.origin
  const src = o === state.origin ? state.local : (state.remote.get(o) || { sessions: new Map() }).sessions
  const list = [...src.values()].filter(s => !sessionFilter || sessionFilter(s)).sort((a, b) => cmp(a.key, b.key))
  return { v: 1, origin: o, sessions: list.map(snapSession) }
}

// --- wire → state (defensive: a snapshot is untrusted input; the same limits apply) ---
const wTime = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null }
const wPos = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null }
function wText(v) {
  if (typeof v !== 'string') return null
  const t = normText(v)
  return !t ? null : cpLen(t) > ACTIVITY_LIMITS.text ? cpSlice(t, ACTIVITY_LIMITS.text - 1) + '…' : t
}
function wLine(l) {
  if (!l || typeof l !== 'object') return null
  const text = wText(l.text)
  if (!text) return null
  return { id: typeof l.id === 'string' ? l.id.slice(0, 100) : '', ts: wTime(l.ts) || 0, text, state: ACTIVITY_STATES.includes(l.state) ? l.state : 'running',
    has_details: !!l.has_details, has_data: !!l.has_data }
}
function wEntity(r, path) {
  const e = newEntity(path, wTime(r.started_at) || 0)
  e.last_activity = wTime(r.last_activity) || 0
  e.finished_at = wPos(r.finished_at); e.gone_at = wPos(r.gone_at)
  e.stale_after_ms = wPos(r.stale_after_ms) ? Math.min(wPos(r.stale_after_ms), ACTIVITY_LIMITS.staleAfterMaxMs) : null
  e.contexts.clear()
  for (const c of Array.isArray(r.contexts) ? r.contexts : []) {
    if (!c || typeof c !== 'object') continue
    const n = normContextName(c.name)
    if (!n.ok || e.contexts.has(lc(n.name))) continue
    if (e.contexts.size >= ACTIVITY_LIMITS.contextsPerAgent - (e.contexts.has('root') || n.name === 'root' ? 0 : 1)) continue   // keep a slot for root
    const ctx = newContext(n.name, wTime(c.created_at) || 0)
    ctx.last_activity = wTime(c.last_activity) || 0
    ctx.stale_after_ms = wPos(c.stale_after_ms) ? Math.min(wPos(c.stale_after_ms), ACTIVITY_LIMITS.staleAfterMaxMs) : null
    const p = c.progress ? parseProgress(c.progress) : null
    ctx.progress = p && p.ok ? p.value : null
    ctx.eta_at = wPos(c.eta_at)
    ctx.current = wLine(c.current)
    e.contexts.set(ctx.key, ctx)
  }
  if (!e.contexts.has('root')) e.contexts.set('root', newContext('root', e.started_at))
  return e
}
function wSession(r, origin) {
  if (!r || typeof r !== 'object') return null
  const session = str(r.session)
  if (!session) return null
  const project = str(r.project) || 'unclassified'
  const s = { key: sessionKey(project, session), origin, session, project, user: str(r.user), host: str(r.host), created_at: wTime(r.created_at) || 0,
    last_activity: wTime(r.last_activity) || 0, gone_at: wPos(r.gone_at), self: wEntity(r.self && typeof r.self === 'object' ? r.self : {}, null), agents: new Map() }
  for (const a of Array.isArray(r.agents) ? r.agents : []) {
    if (s.agents.size >= ACTIVITY_LIMITS.agentsPerSession) break
    if (!a || typeof a !== 'object') continue
    const p = normAgentPath(a.path)
    if (!p.ok || s.agents.has(lc(p.path))) continue
    s.agents.set(lc(p.path), wEntity(a, p.path))
  }
  return s
}
/**
 * Fold a remote host's snapshot in. PER-ORIGIN OWNERSHIP: the slice REPLACES everything held for `fromOrigin` (sessions
 * it no longer lists disappear); no other origin's slice is touched, and our own origin is refused. The snapshot is
 * re-validated against the same limits. Idempotent: a slice whose canonical form equals the held one → changed:false.
 * @param {ActivityState} state
 * @param {string} fromOrigin  the host that OWNS the slice (the link it arrived on decides, not the snapshot's field)
 * @param {any} snap  a snapshot() from that host
 * @returns {ActivityResult} { ok:true, changed:boolean, sessions:number } or { ok:false, code, what }
 */
export function mergeSnapshot(state, fromOrigin, snap) {
  const origin = typeof fromOrigin === 'string' ? fromOrigin.trim() : ''
  if (!origin) return bad('bad-origin', 'mergeSnapshot needs the owning origin')
  if (origin === state.origin) return bad('own-origin', 'a remote snapshot may not replace this host\'s own slice')
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.sessions)) return bad('bad-snapshot', 'expected { v, origin, sessions:[...] }')
  const sessions = new Map()
  for (const r of snap.sessions) {
    if (sessions.size >= MAX_SESSIONS_PER_ORIGIN) break
    const s = wSession(r, origin)
    if (s && !sessions.has(s.key)) sessions.set(s.key, s)
  }
  const sig = JSON.stringify([...sessions.values()].sort((a, b) => cmp(a.key, b.key)).map(snapSession))
  const held = state.remote.get(origin)
  if (held && held.sig === sig) return { ok: true, changed: false, sessions: sessions.size }
  state.remote.set(origin, { sessions, sig })
  return { ok: true, changed: true, sessions: sessions.size }
}
/** Forget a remote origin's slice (the host left the mesh). Returns whether one was held. */
export const dropOrigin = (state, origin) => state.remote.delete(origin)

// ---------------------------------------------------------------------------------------------------------------
// memory budget (an ESTIMATE of V8 heap use: strings at 2 bytes/char + fixed per-object/Map-entry overheads)

const OBJ = 64, MAPE = 48, NUMS = 48
const sB = s => (typeof s === 'string' ? 16 + 2 * s.length : 0)
const progB = p => (p ? OBJ + sB(p.unit) + 16 : 0)
const lineB = l => (l ? OBJ + sB(l.id) + sB(l.text) + sB(l.state) + 16 + (l.details ? sB(l.details) : 0) + (l.data != null ? OBJ + 2 * (l.data_bytes || 0) : 0) : 0)
const ctxB = c => OBJ + MAPE + sB(c.name) + sB(c.key) + NUMS + lineB(c.current) + progB(c.progress)
const entryB = e => 16 + OBJ + sB(e.id) + sB(e.text) + sB(e.context) + sB(e.state) + NUMS + progB(e.progress)
function entityB(e) {
  let n = OBJ + MAPE + sB(e.path) + sB(e.key) + NUMS
  for (const c of e.contexts.values()) n += ctxB(c)
  for (const x of e.log) n += entryB(x)
  return n
}
function sessionB(s) {
  let n = OBJ + MAPE + sB(s.key) + sB(s.session) + sB(s.project) + sB(s.user) + sB(s.host) + NUMS + entityB(s.self)
  for (const a of s.agents.values()) n += entityB(a)
  return n
}
/** Estimated in-memory bytes of the whole state (local + remote slices). @param {ActivityState} state */
export function estimateBytes(state) {
  let n = OBJ
  for (const s of state.local.values()) n += sessionB(s)
  for (const sl of state.remote.values()) { n += MAPE + sB(sl.sig); for (const s of sl.sessions.values()) n += sessionB(s) }
  return n
}
/**
 * Bring the state under `budgetBytes` (default config.memory_budget_mb). Evicts, in order: (1) the oldest FINISHED
 * local agents (by finished_at); then (2) the oldest log entries across every local entity (by ts; each entity's log
 * drops from its front). Never a current line, never an unfinished agent, never a session's own entity, never a
 * remote slice (its origin bounds it and replaces it on every gossip). May still be over (over:true) when current
 * lines alone exceed the budget.
 * @param {ActivityState} state
 * @param {number} [budgetBytes]
 * @returns {{ evicted:{session:string, project:string, agent:string}[], entries_dropped:number, bytes_before:number, bytes_after:number, over:boolean }}
 */
export function enforceBudget(state, budgetBytes) {
  const budget = Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : state.config.memory_budget_mb * MB
  const before = estimateBytes(state)
  let bytes = before, dropped = 0
  const evicted = []
  if (bytes > budget) {
    const fin = []
    for (const s of state.local.values()) for (const a of s.agents.values()) if (a.finished_at) fin.push({ s, a })
    fin.sort((x, y) => x.a.finished_at - y.a.finished_at || cmp(x.s.key, y.s.key) || cmp(x.a.key, y.a.key))
    for (const { s, a } of fin) {
      if (bytes <= budget) break
      bytes -= entityB(a)
      s.agents.delete(a.key)
      evicted.push({ session: s.session, project: s.project, agent: a.path })
    }
  }
  if (bytes > budget) {
    const all = []
    for (const s of state.local.values()) for (const ent of [s.self, ...s.agents.values()]) ent.log.forEach((e, i) => all.push({ ts: e.ts, i, ent }))
    all.sort((x, y) => x.ts - y.ts || x.i - y.i)
    for (const { ent } of all) {
      if (bytes <= budget) break
      const e = ent.log.shift()
      if (!e) continue
      ent.log_dropped++; dropped++
      bytes -= entryB(e)
    }
  }
  const after = estimateBytes(state)
  return { evicted, entries_dropped: dropped, bytes_before: before, bytes_after: after, over: after > budget }
}
