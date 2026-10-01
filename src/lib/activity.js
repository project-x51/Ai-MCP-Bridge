// #70 agent activity board — the PURE core. No I/O, no timers, no clock: every function that needs the time takes `now`
// (ms epoch) as a parameter, so the whole model is exercised directly by tests/test_activity_unit. Step 1 built the model;
// step 2 (v1.58.0) wires it into bridge.mjs (the `log` + `activity` tools, the gateway-owned state, the daily JSONL) and
// adds here: the `log` flag, the session identity, the persistence markers, checkpoints (cp/rep) and the newest-first replay.
//
// THE MODEL (docs/issues.md #70). The tree is project → session → agent → context → message.
// - A SESSION is keyed by sessionKey(realm, projKey(project), lc(user), lc(session)) within an ORIGIN (the host that hosts
//   it). The host is NOT part of it, so a session that moves machines stays the same session (#70 "Decisions after step 1").
//   Its own reports (no `agent`) go to `session.self`, an entity shaped exactly like an agent (path null) that never counts
//   toward the agents-per-session limit and is never evicted.
// - An AGENT is a `/`-path label (≤3 segments) under its session. Agents don't register: the first message creates one.
//   Paths are FLAT keys (lc'd, first-seen spelling shown) — `a/b` does not create `a`; the dashboard draws the tree.
// - Every message belongs to a CONTEXT. `@root` (the default) is the entity's own context and exists from creation.
//   `@ctx text` appends to the log only; `@~ctx text` also makes it the context's CURRENT line. No prefix = `@root`,
//   log-only — so setting a current line is always a deliberate `@~`. Context names are lc-keyed (first-seen spelling
//   kept), so `@Build` and `@build` are one context (the #71 lesson: never let case split an identity).
// - STATE (`running|blocked|failed|done|idle`) is the CURRENT line's state; a context with no current line counts as
//   running. ONLY an `@~` message changes it (an `@` message records its state in its log entry only). An entry's state
//   defaults to the context's current state, else running. The entity's state is its root context's. `@~root`
//   done|failed FINISHES the entity (`finished_at`); a later `@~root` running|blocked|idle revives it.
// - STALE is computed, never reported (effectiveState/staleAt): a running or blocked item with no message of ANY kind
//   for longer than its window (the per-message `stale_after` override if its last message set one, else the host's
//   `stale_after_min`). done/failed/idle never go stale, nor does anything under a finished entity. GONE (the session
//   left the mesh — markSessionGone) outranks stale for anything not done/failed.
// - PROGRESS and ETA are context attributes set by ANY message (`@` included — a bar update can't change the headline)
//   and STICKY ("none" clears either). ETA is stored as an absolute ms time (eta_at) and is null whenever the context's
//   state is done/failed (dropped when it goes done/failed, ignored while it is). `details` and `data` belong to the
//   LINE: they are replaced by each `@~` and never carried forward.
// - THE `log` FLAG (default true). log:true appends the message to the in-memory log and returns the full `entry` for the
//   daily JSONL. log:false still takes full effect (an `@~` sets the current line + state, progress/ETA move the bar, it
//   is activity and refreshes stale) but is NOT logged: apply returns entry:null, logged:false — scripts reporting every
//   second use it. A message carrying progress and/or eta may omit text (logged or not): it defaults to "{progress}"
//   (or "{eta}" with only an ETA).
// - TEXT IS A TEMPLATE: {progress} {pct} {done} {total} {unit} {eta} are rendered at READ time (renderText) — a current
//   line against the context's CURRENT bar + ETA (so "@~Seeding {progress}" moves with log:false updates), a log entry
//   against what was recorded on it. State, the JSONL and the gossip snapshot keep the raw template.
//
// MEMORY MODEL (#70 "Memory model"): an in-memory log entry keeps only text, state, time, context, the current flag and
// small fields (progress/eta/stale_after + has_details/has_data flags). `details`/`data` live in memory ONLY on each
// context's CURRENT line. apply() RETURNS the full entry (details + data + identity) for the caller to append to the
// host's daily JSONL, which is where older entries' details/data are read back from. Logs are capped per entity
// (`log_entries_per_agent`, oldest dropped); enforceBudget() evicts the oldest finished agents, then the oldest log
// entries — never current lines.
//
// PERSISTED RECORDS (the daily JSONL, one host = one writer): logged entries, CHECKPOINTS and REPEAT lines.
// - Every record that is the FIRST persisted one of its session / entity / context carries new_session / new_entity /
//   new_context, and an entry whose new agent evicted another carries `evicted:[path]`; a logged `@~root` line carries
//   the entity's resulting `finished_at`. The replay uses them to stop exactly where an instance began (an evicted or
//   expired agent that came back is a NEW instance), so it equals a chronological apply of the same records.
// - planCheckpoints() (the gateway calls it every `progress_checkpoint_sec`): a context with log:false activity since
//   the last tick whose current line / bar / ETA CHANGED since its last persisted record gets ONE full `cp` line
//   { kind:"cp", k, ts, identity, current, state, progress, eta_at } — `k` is a small per-FILE integer given to that
//   context the first time it is checkpointed in that day's file. Contexts alive but UNCHANGED are run-length encoded
//   in ONE trailing repeat line { rep:[k...], n, since, last }: every listed key was alive and unchanged in each of the
//   n intervals since..last. The SAME key set next tick rewrites that last line in place (n+1, last); a different set
//   (or any other write in between: a log entry or a cp) starts a new one. Contexts with no activity are not listed.
//
// REPLAY (createReplay / replayNewestFirst): rebuilds the local slice from records fed NEWEST FIRST (the JSONL read
// backwards). Phase 1 resolves each context's current line, bar, ETA, state and its entity's finished status from the
// newest record carrying them (a cp is a full snapshot; the newest of cp or logged entry wins) and stops looking once
// found or once the instance's first record (its new_* marker) is passed — phase1Complete() says when everything seen so
// far is resolved, so the board can publish early. Phase 2 fills each entity's log history (bounded, chronological;
// cp/rep lines never count). last_activity also takes the `last` of any rep line listing the context's key (same file).
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
  progress_checkpoint_sec: 60,      // step 2: cp/rep cadence for log:false activity (0 = off; else 10..3600)
  enabled: true,
})
/** @typedef {Readonly<{ log_retention_days:number, log_entries_per_agent:number, stale_after_min:number, finished_visible_hours:number,
 *   memory_budget_mb:number, progress_checkpoint_sec:number, enabled:boolean }>} ActivityConfig */
/** config key -> env override name (AI_BRIDGE_ACTIVITY_<KEY>). */
export const ACTIVITY_ENV = Object.freeze(Object.fromEntries(Object.keys(ACTIVITY_DEFAULTS).map(k => [k, 'AI_BRIDGE_ACTIVITY_' + k.toUpperCase()])))
// numeric ranges: an out-of-range number is CLAMPED into [lo, hi] and rounded to an integer
const CONFIG_RANGES = {
  log_retention_days: [1, 365],
  log_entries_per_agent: [10, 5000],
  stale_after_min: [1, 1440],
  finished_visible_hours: [0, 720],
  memory_budget_mb: [8, 4096],
  progress_checkpoint_sec: [10, 3600],   // plus 0 = off (resolveConfig special-cases it)
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

/**
 * The session key within an origin: realm + projKey(project) + lc(user) + lc(session), JSON-encoded so no separator can
 * collide (#70 "Decisions after step 1": the host is NOT part of it — a session that moves machines stays the same
 * session). Case-insensitive; the records keep the first-seen spelling. A missing realm is 'default' (the bridge's).
 * @param {{ realm?: string|null, project?: string|null, user?: string|null, session?: string|null }} ident
 */
export const sessionKey = ident => { const i = ident && typeof ident === 'object' ? ident : {}; return JSON.stringify([lc(i.realm) || 'default', projKey(i.project), lc(i.user), lc(i.session)]) }
const p2 = n => String(n).padStart(2, '0')
/** The LOCAL calendar day of a ms time, "YYYY-MM-DD" (the daily JSONL's file name); null for a bad time. */
export function localDay(ts) { const d = new Date(ts); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : null }
/** The ms time embedded in an entry id (`<prefix><ts36>-<seq36>`) — which day file holds it — or null. */
export function entryTime(id) {
  const m = typeof id === 'string' && id.match(/([0-9a-z]+)-[0-9a-z]+$/)
  const t = m ? parseInt(m[1], 36) : NaN
  return Number.isFinite(t) && t > 1e12 && t < 1e14 ? t : null
}

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
 * @returns {ActivityConfig}
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
      if (key === 'progress_checkpoint_sec' && n <= 0) { if (n < 0) warn(`${src}=${n} clamped to 0 (off)`); val = 0; break }   // 0 = checkpoints off
      const [lo, hi] = CONFIG_RANGES[key]
      const c = Math.min(hi, Math.max(lo, Math.round(n)))
      if (c !== n) warn(`${src}=${n} clamped to ${c} (range ${lo}..${hi})`)
      val = c; break
    }
    out[key] = val
  }
  return /** @type {ActivityConfig} */ (Object.freeze(out))
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
 *   details: string|null, data: any, log: boolean, warnings: string[] }} ActivityMsg
 *   `progress` / `eta_at` are ABSENT when not given and null when explicitly cleared ("none"). `text` is the RAW
 *   template (placeholders are rendered at read time — renderText) and never empty.
 */

/**
 * Validate + normalise one report (the `log` tool / aimb-log script argument shape) into a message for apply().
 * - Context: from `context` when given (then `text` is taken LITERALLY — no prefix parsing, so a text may start with
 *   "@"), else a leading `@name` / `@~name` / `@"a b"` / `@~"a b"` prefix, which is stripped. Absent → `@root`, log-only.
 * - text: newlines/tabs → spaces, trimmed, must be non-empty; longer than 240 code points is TRUNCATED to 239 + "…"
 *   with a 'text-truncated' warning (a status line is worth keeping even when chatty; a reject would cost the agent
 *   another call). Everything else over a limit is REJECTED. DEFAULT TEXT (step 2): a message carrying progress and/or
 *   eta may omit text (logged or not) — it becomes "{progress}" (or "{eta}" when only an ETA is given), a template the
 *   reader renders against the context's live bar. No text and no progress/eta is still rejected.
 * - log: true (default) | false — see the module header (accepts booleans, 1/0 and "true"/"false"/"yes"/"no").
 * - state: running|blocked|failed|done|idle (case-insensitive) or absent (null → apply() picks the default).
 * - progress / eta: see parseProgress / parseEta; the string "none" clears either.
 * - stale_after: a duration > 0; over 24h is clamped with a 'stale-after-capped' warning.
 * - details: a string ≤ 4 KB UTF-8. data: a plain object/array (or a JSON string of one), JSON-cloned, ≤ 16 KB.
 * @param {any} input  { agent?, text?, context?, state?, progress?, eta?, stale_after?, details?, data?, log? }
 * @param {{ now?: number, tzOffsetMin?: number }} [opts]  needed only to resolve an eta
 * @returns {ActivityResult} { ok:true, msg: ActivityMsg } or { ok:false, code, what }
 */
export function parseMessage(input, opts = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('bad-input', 'expected an object { text, agent?, context?, state?, progress?, eta?, stale_after?, details?, data?, log? }')
  const warnings = []
  let agent = null
  if (has(input, 'agent')) { const a = normAgentPath(input.agent); if (!a.ok) return a; agent = a.path }
  const log = has(input, 'log') ? boolVal(input.log) : true
  if (log === null) return bad('bad-log', 'log must be true (append to the log; the default) or false (update the board only)')
  const bar = has(input, 'progress') || has(input, 'eta')   // a bar update may omit text: it defaults to a template
  if (input.text != null && typeof input.text !== 'string') return bad('bad-text', 'text must be a string')
  if (typeof input.text !== 'string' && !bar) return bad('bad-text', 'text must be a string (it may be omitted only when progress or eta is given)')
  let text = input.text || '', context = 'root', current = false
  if (has(input, 'context') && !(typeof input.context === 'string' && !input.context.trim())) {
    const c = parseContextParam(input.context); if (!c.ok) return c
    context = c.name; current = c.current
  } else {
    const p = splitPrefix(text); if (!p.ok) return p
    if (p.name !== null) { context = p.name; current = p.current; text = p.rest }
  }
  text = normText(text)
  if (!text) {
    if (!bar) return bad('text-empty', 'text is empty (a context prefix alone is not a message)')
    text = has(input, 'progress') ? '{progress}' : '{eta}'   // #70: the default text of a bar update (rendered at read time)
  }
  if (cpLen(text) > ACTIVITY_LIMITS.text) { text = cpSlice(text, ACTIVITY_LIMITS.text - 1) + '…'; warnings.push('text-truncated') }
  let state = null
  if (has(input, 'state')) {
    state = typeof input.state === 'string' ? input.state.trim().toLowerCase() : ''
    if (!ACTIVITY_STATES.includes(state)) return bad('bad-state', `state must be one of ${ACTIVITY_STATES.join('|')}`)
  }
  /** @type {ActivityMsg} */
  const msg = { agent, context, root: context === 'root', current, text, state, stale_after_ms: null, details: null, data: null, log, warnings }
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
 *   current:ActivityLine|null, progress:ActivityProgress|null, eta_at:number|null, persisted?:boolean,
 *   cp_dirty?:number }} ActivityContext
 * @typedef {{ path:string|null, key:string|null, started_at:number, last_activity:number, finished_at:number|null,
 *   gone_at:number|null, stale_after_ms:number|null, contexts:Map<string, ActivityContext>, log:any[],
 *   log_dropped:number, persisted?:boolean }} ActivityEntity
 * @typedef {{ key:string, origin:string, realm?:string, session:string, project:string, user:string|null,
 *   host:string|null, created_at:number, last_activity:number, gone_at:number|null, self:ActivityEntity,
 *   agents:Map<string, ActivityEntity>, persisted?:boolean }} ActivitySession
 * @typedef {{ day:string, keys:Map<string, number>, next:number,
 *   rep:{ keys:number[], since:number, last:number, n:number, offset?:number }|null }} ActivityCpFile
 * @typedef {{ v:1, config:any, origin:string, idPrefix:string, seq:number, local:Map<string, ActivitySession>,
 *   remote:Map<string, { sessions:Map<string, ActivitySession>, sig:string }>,
 *   cpLive:Map<string, [string, string|null, string]>, cp:ActivityCpFile|null }} ActivityState
 */

/**
 * A fresh state container (a plain object of Maps; every function here takes it as the first argument).
 * @param {{ config?: any, origin?: string, idPrefix?: string }} [opts]
 *   config: a resolveConfig() result or a raw `activity` block (re-validated either way, env NOT consulted here);
 *   origin: this host's name (whose slice snapshot() produces and mergeSnapshot() refuses to overwrite);
 *   idPrefix: prefix for entry ids — the bridge passes `act_<boot nonce>_`, since the in-state sequence restarts at 0
 *   (an id is `<prefix><ts base36>-<seq base36>`; entryTime() reads the time back out).
 * @returns {ActivityState}
 */
export function createActivity({ config, origin = 'local', idPrefix = 'act_' } = {}) {
  return { v: 1, config: resolveConfig(config || {}, {}), origin: String(origin || 'local'), idPrefix: String(idPrefix), seq: 0, local: new Map(), remote: new Map(),
    cpLive: new Map(), cp: null }
}

// `persisted`: has a record of this session/entity/context reached the JSONL yet (its first one carries new_*)?
// `cp_dirty`: bits of what a log:false message changed since the last persisted record (CP_CUR | CP_PROG | CP_ETA).
const CP_CUR = 1, CP_PROG = 2, CP_ETA = 4
/** @returns {ActivityContext} */
function newContext(name, now) {
  return { name, key: lc(name), created_at: now, last_activity: now, stale_after_ms: null, current: null, progress: null, eta_at: null, persisted: false, cp_dirty: 0 }
}
/** @returns {ActivityEntity} */
function newEntity(path, now) {
  const e = { path, key: path == null ? null : lc(path), started_at: now, last_activity: now, finished_at: null, gone_at: null,
    stale_after_ms: null, contexts: new Map(), log: [], log_dropped: 0, persisted: false }
  e.contexts.set('root', newContext('root', now))
  return e
}
function oldestFinished(sess) {
  let best = null
  for (const a of sess.agents.values()) if (a.finished_at && (!best || a.finished_at < best.finished_at || (a.finished_at === best.finished_at && a.key < best.key))) best = a
  return best
}
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
/** The small in-memory log entry of a (logged) message or a JSONL entry — the SAME shape from both (replay equality). */
function smallOf(e) {
  const s = compact({ id: e.id, ts: e.ts, context: e.context, current: !!e.current, text: e.text, state: e.state,
    progress: e.progress || undefined, eta_at: e.eta_at || undefined, stale_after_ms: e.stale_after_ms || undefined,
    has_details: e.has_details ? true : undefined, has_data: e.has_data ? true : undefined })
  if (e.progress === null) s.progress = null   // an explicit "none" is recorded (the replay must see the clear)
  if (e.eta_at === null) s.eta_at = null
  return s
}
/** new_session / new_entity / new_context for the FIRST persisted record of each (and mark them persisted). */
function persistMarks(sess, ent, ctx) {
  const m = {}
  if (!sess.persisted) { m.new_session = true; sess.persisted = true }
  if (!ent.persisted) { m.new_entity = true; ent.persisted = true }
  if (!ctx.persisted) { m.new_context = true; ctx.persisted = true }
  return m
}
const cpId = (sKey, aKey, cKey) => JSON.stringify([sKey, aKey, cKey])
const fullLine = l => (l ? { id: l.id, ts: l.ts, text: l.text, state: l.state, details: l.details || null, data: l.data != null ? l.data : null } : null)

/**
 * Apply one parsed message from a LOCAL session. Atomic: a rejected message changes nothing.
 * - Creates the session / agent / context on first use (a new entity starts with an empty @root).
 * - log:true (the default) appends a small log entry (capped at config.log_entries_per_agent, oldest dropped →
 *   entity.log_dropped) and returns the full `entry` (details + data + identity + persistence markers) for the JSONL.
 *   log:false appends nothing and returns entry:null, logged:false — everything below still applies.
 * - `@~` sets the context's current line (+ its details/data, which live nowhere else in memory). Progress / eta are
 *   applied from ANY message (sticky; "none" cleared them at parse); the ETA is then dropped if the context's state is
 *   done/failed.
 * - Entry state = msg.state, else the context's current state, else running.
 * - `@~root` done|failed finishes the entity (finished_at, first time only); `@~root` running|blocked|idle revives it.
 * - last_activity (session, entity, context) = now (never moved backwards) for ANY message; `stale_after` is stored on
 *   the entity AND the context and lasts until each one's next message (a message without it clears it).
 * - Limits: a new context beyond 32 (incl. root) → 'too-many-contexts'. A new agent beyond 128 EVICTS the session's
 *   oldest FINISHED agent (reported in `evicted`; its log survives in the JSONL) and is rejected ('too-many-agents')
 *   only when none has finished — or when the new agent's message is log:false (an eviction must reach the JSONL).
 * - A message arriving for a session marked gone clears gone_at on the session and the reporting entity.
 * - A log:false message marks what it changed (current line / bar / ETA) dirty and the context live for the next
 *   planCheckpoints(); a logged one closes the open repeat line.
 * @param {ActivityState} state
 * @param {{ session:string, project?:string, user?:string|null, realm?:string, host?:string }} ident  the reporting session
 * @param {ActivityMsg} msg  parseMessage(...).msg
 * @param {number} now
 * @returns {ActivityResult} { ok:true, id, ts, logged, entry, current, state, stale_at, agent, context,
 *   evicted:string[], warnings:string[] } or { ok:false, code, what }
 */
export function apply(state, ident, msg, now) {
  if (!state || !(state.local instanceof Map)) return bad('bad-state-object', 'pass a createActivity() state')
  if (!state.config.enabled) return bad('activity-disabled', 'the activity board is disabled on this host (activity.enabled)')
  if (!Number.isFinite(now)) return bad('bad-now', 'now must be a ms epoch')
  if (!msg || typeof msg.text !== 'string' || !msg.text || typeof msg.context !== 'string') return bad('bad-message', 'pass the msg from parseMessage()')
  const logged = msg.log !== false
  const sessName = str(ident && ident.session)
  if (!sessName) return bad('bad-session', 'the reporting session needs a name')
  const L = ACTIVITY_LIMITS
  const sKey = sessionKey({ realm: ident.realm, project: ident.project, user: ident.user, session: sessName })
  let sess = state.local.get(sKey)
  const aKey = msg.agent == null ? null : lc(msg.agent)
  let ent = sess ? (aKey === null ? sess.self : sess.agents.get(aKey)) : null
  let evict = null
  if (aKey !== null && !ent && sess && sess.agents.size >= L.agentsPerSession) {
    evict = oldestFinished(sess)
    if (!evict) return bad('too-many-agents', `this session already has ${L.agentsPerSession} agents and none has finished (report @~root done/failed when an agent ends)`)
    if (!logged) return bad('too-many-agents', `this session has ${L.agentsPerSession} agents: a NEW agent must introduce itself with a logged message (log:true), which evicts the oldest finished one`)
  }
  const cKey = lc(msg.context)
  let ctx = ent ? ent.contexts.get(cKey) : null
  if (!ctx && ent && ent.contexts.size >= L.contextsPerAgent) return bad('too-many-contexts', `this ${aKey === null ? 'session' : 'agent'} already has ${L.contextsPerAgent} contexts (including @root)`)
  // ---- every check passed: mutate ----
  if (!sess) {
    sess = { key: sKey, origin: state.origin, realm: str(ident.realm) || 'default', session: sessName, project: str(ident.project) || 'unclassified', user: str(ident.user), host: str(ident.host),
      created_at: now, last_activity: now, gone_at: null, self: newEntity(null, now), agents: new Map(), persisted: false }
    state.local.set(sKey, sess)
    if (aKey === null) ent = sess.self
  }
  if (str(ident.host)) sess.host = str(ident.host)   // the session may move machines (realm/project/user/name are its identity)
  if (evict) sess.agents.delete(evict.key)
  if (!ent) { ent = newEntity(msg.agent, now); sess.agents.set(aKey, ent) }
  if (!ctx) ctx = ent.contexts.get(cKey)
  if (!ctx) { ctx = newContext(msg.context, now); ent.contexts.set(cKey, ctx) }
  const before = { cur: ctx.current, prog: JSON.stringify(ctx.progress), eta: ctx.eta_at }
  const entryState = msg.state || (ctx.current ? ctx.current.state : null) || 'running'
  const id = `${state.idPrefix}${now.toString(36)}-${(++state.seq).toString(36)}`
  // max(): a report timed earlier than one already applied (clock skew, a replayed JSONL) never moves activity back
  sess.last_activity = Math.max(sess.last_activity, now); ent.last_activity = Math.max(ent.last_activity, now); ctx.last_activity = Math.max(ctx.last_activity, now)
  ent.stale_after_ms = ctx.stale_after_ms = msg.stale_after_ms || null
  sess.gone_at = null; ent.gone_at = null
  let lineId = id
  if (msg.current) {
    // a log:false line IDENTICAL to the current one (text, state, details, data) keeps it — "alive, unchanged" (a rep, not a cp)
    const c0 = ctx.current, same = !logged && c0 && c0.text === msg.text && c0.state === entryState && (c0.details || null) === (msg.details || null)
      && JSON.stringify(c0.data != null ? c0.data : null) === JSON.stringify(msg.data != null ? msg.data : null)
    if (same) lineId = c0.id
    else ctx.current = { id, ts: now, text: msg.text, state: entryState, details: msg.details || null, data: msg.data != null ? msg.data : null,
      data_bytes: msg.data != null ? utf8(JSON.stringify(msg.data)) : 0 }
    if (cKey === 'root') {
      if (DONE_OR_FAILED.has(entryState)) { if (!ent.finished_at) ent.finished_at = now }
      else ent.finished_at = null
    }
  }
  if ('progress' in msg) ctx.progress = msg.progress ? { ...msg.progress } : null   // #70 step 2: ANY message moves the bar
  if ('eta_at' in msg) ctx.eta_at = msg.eta_at || null
  if (DONE_OR_FAILED.has(stateOf(ctx))) ctx.eta_at = null                         // dropped on done/failed, ignored while it is
  const res = { ok: true, id: lineId, ts: now, logged, entry: null, current: !!msg.current, state: entryState,
    stale_at: staleAt(ctx, state.config.stale_after_min, ent), agent: ent.path, context: ctx.name, evicted: evict ? [evict.path] : [], warnings: msg.warnings || [] }
  if (!logged) {   // the board only: mark what changed for the next checkpoint, and the context as live this interval
    const bits = (ctx.current !== before.cur ? CP_CUR : 0) | (JSON.stringify(ctx.progress) !== before.prog ? CP_PROG : 0) | (ctx.eta_at !== before.eta ? CP_ETA : 0)
    ctx.cp_dirty = (ctx.cp_dirty || 0) | bits
    state.cpLive.set(cpId(sKey, aKey, cKey), [sKey, aKey, cKey])
    return res
  }
  const small = smallOf({ id, ts: now, context: ctx.name, current: msg.current, text: msg.text, state: entryState,
    progress: 'progress' in msg ? msg.progress : undefined, eta_at: 'eta_at' in msg ? msg.eta_at : undefined, stale_after_ms: msg.stale_after_ms,
    has_details: !!msg.details, has_data: msg.data != null })
  ent.log.push(small)
  while (ent.log.length > state.config.log_entries_per_agent) { ent.log.shift(); ent.log_dropped++ }
  // this entry persists what it carries: the line (+ its state, and a done/failed line's dropped ETA), the bar, the ETA
  if (ctx.cp_dirty) ctx.cp_dirty &= ~((msg.current ? CP_CUR | (DONE_OR_FAILED.has(entryState) ? CP_ETA : 0) : 0) | ('progress' in msg ? CP_PROG : 0) | ('eta_at' in msg ? CP_ETA : 0))
  if (state.cp) state.cp.rep = null   // any other write closes the open repeat line
  res.entry = { v: 1, ...small, current: !!msg.current, origin: state.origin, realm: sess.realm, session: sess.session, project: sess.project, user: sess.user, host: sess.host,
    agent: ent.path, details: msg.details || null, data: msg.data != null ? msg.data : null, ...persistMarks(sess, ent, ctx),
    ...(evict ? { evicted: [evict.path] } : {}), ...(msg.current && cKey === 'root' ? { finished_at: ent.finished_at } : {}) }
  return res
}

/**
 * The checkpoint writes due now (the gateway calls this every `progress_checkpoint_sec`, then appends / rewrites them
 * in order). Every context with log:false activity since the last call is either CHANGED (its current line, bar or
 * ETA moved since its last persisted record — or it has no key in today's file yet) → one full `cp` line, or UNCHANGED
 * → its key joins this interval's repeat line. The repeat line REWRITES the open one in place (rewrite:true, n+1) when
 * the key set is EXACTLY the same and nothing else was written since; otherwise a new one is appended (so every key on
 * a repeat line was alive in each of its n intervals). A new local day starts a new file: keys restart at 1 and every
 * live context gets a full cp there.
 * @param {ActivityState} state
 * @param {number} now
 * @returns {{ kind:string, rewrite?:boolean, rec:any }[]}  kind 'cp' | 'rep'
 */
export function planCheckpoints(state, now) {
  const day = localDay(now)
  if (!state.cp || state.cp.day !== day) state.cp = { day, keys: new Map(), next: 1, rep: null }
  const cp = state.cp, writes = [], same = []
  for (const [id, [sKey, aKey, cKey]] of [...state.cpLive]) {
    state.cpLive.delete(id)
    const sess = state.local.get(sKey), ent = sess && (aKey === null ? sess.self : sess.agents.get(aKey)), ctx = ent && ent.contexts.get(cKey)
    if (!ctx) continue   // evicted / expired since
    let k = cp.keys.get(id)
    if (ctx.cp_dirty || k === undefined) {
      if (k === undefined) { k = cp.next++; cp.keys.set(id, k) }
      writes.push({ kind: 'cp', rec: checkpointOf(state, sess, ent, ctx, now, k) })
      ctx.cp_dirty = 0
    } else same.push(k)
  }
  if (writes.length || !same.length) cp.rep = null   // a cp line (or an interval with no unchanged-live context) closes it
  if (!same.length) return writes
  same.sort((a, b) => a - b)
  if (cp.rep && cp.rep.keys.join() === same.join()) { cp.rep.n++; cp.rep.last = now; writes.push({ kind: 'rep', rewrite: true, rec: repRecord(cp.rep) }) }
  else { cp.rep = { keys: same, since: now, last: now, n: 1 }; writes.push({ kind: 'rep', rewrite: false, rec: repRecord(cp.rep) }) }
  return writes
}
/** Every dirty context's cp NOW, regardless of the interval (a clean shutdown's flush). */
export function flushCheckpoints(state, now) {
  for (const s of state.local.values()) for (const e of [s.self, ...s.agents.values()]) for (const c of e.contexts.values())
    if (c.cp_dirty) state.cpLive.set(cpId(s.key, e.key, c.key), [s.key, e.key, c.key])
  return planCheckpoints(state, now).filter(w => w.kind === 'cp')
}
const repRecord = r => ({ rep: r.keys.slice(), n: r.n, since: r.since, last: r.last })
/** One context's full checkpoint line (a snapshot: current line incl. details/data, state, bar, ETA; root: finished_at). */
function checkpointOf(state, sess, ent, ctx, now, k) {
  return { v: 1, kind: 'cp', k, ts: now, origin: state.origin, realm: sess.realm || 'default', session: sess.session, project: sess.project, user: sess.user, host: sess.host,
    agent: ent.path, context: ctx.name, current: fullLine(ctx.current), state: stateOf(ctx), progress: ctx.progress ? { ...ctx.progress } : null, eta_at: ctx.eta_at || null,
    ...(ctx.key === 'root' ? { finished_at: ent.finished_at } : {}), ...persistMarks(sess, ent, ctx) }
}

/**
 * Mark a LOCAL session as having left the mesh (its unfinished agents then show as `gone`), or pass `now = null` to
 * clear it (the session is back). A later message from the session clears it for the session + that entity anyway.
 * @param {ActivityState} state
 * @param {{ session:string, project?:string, user?:string|null, realm?:string }} ident  (a session record works too)
 * @param {number|null} now
 * @returns {boolean} whether the session is known
 */
export function markSessionGone(state, ident, now) {
  const sess = state.local.get(sessionKey(ident))
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
  const k = sessionKey(ident)
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
// replay: rebuild the local slice from the JSONL, NEWEST FIRST (#70 "Decisions after step 1": restart replay)

const finite = v => typeof v === 'number' && Number.isFinite(v)
/** A JSONL record's kind: 'entry' (a logged message), 'cp', 'rep' — or null for anything unusable (skipped). */
export function recordKind(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  if (Array.isArray(r.rep)) return finite(r.last) && r.rep.every(k => Number.isInteger(k)) ? 'rep' : null
  if (typeof r.session !== 'string' || !r.session.trim() || typeof r.context !== 'string' || !finite(r.ts)) return null
  if (r.kind === 'cp') return Number.isInteger(r.k) ? 'cp' : null
  if (r.kind != null) return null
  return typeof r.id === 'string' && typeof r.text === 'string' && r.text && ACTIVITY_STATES.includes(r.state) ? 'entry' : null
}
const wProgress = p => { if (p === null) return null; const r = p && typeof p === 'object' ? parseProgress(p) : null; return r && r.ok ? r.value : undefined }

/**
 * A stateful reverse folder: feed() the host's records NEWEST FIRST (today's file from its end, then earlier days), then
 * finish(). Equivalent to a chronological apply() of the same logged entries (current state AND log contents) — the
 * unit test proves it on a seeded random sequence — plus the cp/rep records (a cp is a snapshot of one context).
 * - Phase 1 (current state): each context's current line = the newest `@~` entry or cp; its bar / ETA = the newest
 *   record carrying them (ETA: a newer `@` ETA counts only if the state then was not done/failed); its entity's
 *   finished_at = the newest root line's; last_activity = the max over its records and the `last` of any rep line that
 *   lists its key in the same file. A field stops being looked for once found, or once the record that began its
 *   instance (new_session / new_entity / new_context) is passed. phase1Complete() = every entity and context seen so
 *   far is resolved, so the caller can publish() early.
 * - Phase 2 (history): the newest log_entries_per_agent logged entries per entity, put back in chronological order;
 *   cp and rep lines never count. finish() resolves the rest (end of input = the beginning of time) and installs it.
 * - Only records within `finished_visible_hours` of `now` are used: feed() returns 'old' for an older one (the caller
 *   stops reading). Exception: an older cp whose key an in-window rep line of the same file still needs is used (a
 *   context alive all day on one cp + one rep line). Agents that would already have expired are dropped (expire()).
 * - An entity whose instance was evicted (an entry's `evicted`) is not resurrected from its older records.
 * @param {ActivityState} state  publish()/finish() REPLACE state.local (live applies must wait for finish())
 * @param {{ now: number }} opts
 */
export function createReplay(state, { now }) {
  const N = state.config.log_entries_per_agent
  const cutoff = now - Math.max(0, Number(state.config.finished_visible_hours) || 0) * HOUR
  const today = localDay(now)
  const sessions = new Map()
  const repLast = new Map()   // day -> Map(k -> newest `last` of a rep line listing k)  (keys are per file)
  const cpKeys = new Map()    // today's file: cpId -> k (re-derived, so new cps keep numbering past them)
  let maxK = 0, fed = 0, skipped = 0, entries = 0, cps = 0, reps = 0
  const rCtx = name => ({ name, key: lc(name), created: null, last: -Infinity, sa: null, saSet: false, current: null, curFound: false,
    progress: null, progFound: false, eta: null, etaRes: false, pend: null, hasPend: false, touched: false, sealed: false })
  const rEnt = path => { const e = { path, key: path == null ? null : lc(path), started: null, last: -Infinity, sa: null, saSet: false, finAt: null, finRes: false,
    sealed: false, touched: false, contexts: new Map(), log: [], total: 0 }; e.contexts.set('root', rCtx('root')); return e }
  const resolveEta = (c, v) => { c.eta = v; c.etaRes = true }
  function sealCtx(c) { if (!c.etaRes) resolveEta(c, c.hasPend ? c.pend : null); c.curFound = c.progFound = true; c.sealed = true }
  function sealEnt(e) { e.finRes = true; for (const c of e.contexts.values()) sealCtx(c); e.sealed = true }
  function sealSess(s) { sealEnt(s.self); for (const a of s.agents.values()) sealEnt(a); s.sealed = true }
  const ctxDone = c => !c.touched || (c.curFound && c.progFound && c.etaRes)
  const entDone = e => !e.touched || (e.finRes && [...e.contexts.values()].every(ctxDone))

  /**
   * One record (newest first). `day` = the file it came from (default: its own local day).
   * @returns {'ok'|'skip'|'old'}
   */
  function feed(rec, day) {
    const kind = recordKind(rec)
    if (!kind) { skipped++; return 'skip' }
    if (kind === 'rep') {
      if (rec.last < cutoff) return 'old'
      const d = day || localDay(rec.last)
      if (!repLast.has(d)) repLast.set(d, new Map())
      const m = repLast.get(d)
      for (const k of rec.rep) if (!(m.get(k) >= rec.last)) m.set(k, rec.last)
      reps++; fed++
      return 'ok'
    }
    const d = day || localDay(rec.ts)
    let repL = -Infinity
    if (kind === 'cp') {
      const m = repLast.get(d), r = m && m.get(rec.k)
      if (rec.ts < cutoff && r === undefined) return 'old'
      if (r !== undefined) { repL = r; m.delete(rec.k) }   // a rep line lists the NEAREST older cp with its key (same file): consume
      if (d === today) { const id = cpId(sessionKey(rec), rec.agent == null ? null : lc(rec.agent), lc(rec.context)); if (!cpKeys.has(id)) cpKeys.set(id, rec.k); maxK = Math.max(maxK, rec.k) }
    } else if (rec.ts < cutoff) return 'old'
    const sk = sessionKey(rec), ak = rec.agent == null ? null : lc(rec.agent), ck = lc(rec.context)
    let s = sessions.get(sk)
    if (s && (s.sealed || (ak !== null && s.dead.has(ak)))) { skipped++; return 'skip' }   // an older instance
    let e = s ? (ak === null ? s.self : s.agents.get(ak)) : null
    if (e && e.sealed) { skipped++; return 'skip' }
    let c = e ? e.contexts.get(ck) : null
    if (c && c.sealed) { skipped++; return 'skip' }
    let path = null, cname = null
    if (ak !== null && !e) { const p = normAgentPath(rec.agent); if (!p.ok || (s && s.agents.size >= ACTIVITY_LIMITS.agentsPerSession)) { skipped++; return 'skip' } path = p.path }
    if (!c) { const n = normContextName(rec.context); if (!n.ok || (e && e.contexts.size >= ACTIVITY_LIMITS.contextsPerAgent)) { skipped++; return 'skip' } cname = n.name }
    // ---- accepted: create what's new ----
    if (!s) { s = { key: sk, realm: 'default', session: rec.session, project: 'unclassified', user: null, host: null, created: null, last: -Infinity, sealed: false, self: rEnt(null), agents: new Map(), dead: new Set() }; sessions.set(sk, s) }
    if (!e) { e = ak === null ? s.self : rEnt(path); if (ak !== null) s.agents.set(ak, e) }
    if (!c) { c = e.contexts.get(ck) || rCtx(cname); e.contexts.set(ck, c) }
    fed++
    // identity spellings: every record carries the canonical (first-seen) one; the OLDEST record's is kept
    s.session = rec.session.trim(); s.project = str(rec.project) || 'unclassified'; s.user = str(rec.user); s.realm = str(rec.realm) || 'default'
    if (!s.host && str(rec.host)) s.host = str(rec.host)   // the newest record's host (a session may move machines)
    e.touched = c.touched = true
    const act = Math.max(rec.ts, repL)
    s.last = Math.max(s.last, act); e.last = Math.max(e.last, act); c.last = Math.max(c.last, act)
    s.created = rec.ts; e.started = rec.ts; c.created = rec.ts   // overwritten by each OLDER record → the instance's first
    if (kind === 'cp') {
      cps++
      const st = rec.current && ACTIVITY_STATES.includes(rec.current.state) ? rec.current.state : 'running'
      if (!c.curFound) { c.current = rec.current && typeof rec.current.text === 'string' && rec.current.text ? lineOf(rec.current) : null; c.curFound = true }
      if (!c.progFound) { c.progress = wProgress(rec.progress) || null; c.progFound = true }
      if (!c.etaRes) resolveEta(c, c.hasPend ? (DONE_OR_FAILED.has(st) ? null : c.pend) : (finite(rec.eta_at) ? rec.eta_at : null))
      if (ck === 'root' && !e.finRes) { e.finAt = finite(rec.finished_at) ? rec.finished_at : (DONE_OR_FAILED.has(st) && rec.current ? rec.current.ts : null); e.finRes = true }
    } else {
      entries++
      e.total++
      if (e.log.length < N) e.log.push(smallOf(rec))
      if (!e.saSet) { e.sa = rec.stale_after_ms > 0 ? rec.stale_after_ms : null; e.saSet = true }
      if (!c.saSet) { c.sa = rec.stale_after_ms > 0 ? rec.stale_after_ms : null; c.saSet = true }
      if (!c.progFound && 'progress' in rec) { const p = wProgress(rec.progress); if (p !== undefined) { c.progress = p; c.progFound = true } }
      if (rec.current && !c.curFound) { c.current = lineOf(rec); c.curFound = true }
      if (!c.etaRes) {   // the newest ETA-bearing record wins, unless the state when it arrived was done/failed
        const hasEta = 'eta_at' in rec
        if (rec.current) {
          if (DONE_OR_FAILED.has(rec.state)) resolveEta(c, null)
          else if (c.hasPend) resolveEta(c, c.pend)
          else if (hasEta) resolveEta(c, finite(rec.eta_at) ? rec.eta_at : null)
        } else if (hasEta && !c.hasPend) { c.pend = finite(rec.eta_at) ? rec.eta_at : null; c.hasPend = true }
      }
      if (rec.current && ck === 'root' && !e.finRes) { e.finAt = 'finished_at' in rec ? (finite(rec.finished_at) ? rec.finished_at : null) : (DONE_OR_FAILED.has(rec.state) ? rec.ts : null); e.finRes = true }
      if (Array.isArray(rec.evicted)) for (const p of rec.evicted) { const k = lc(p); if (!s.agents.has(k)) s.dead.add(k) }   // that agent's older instance ended here
    }
    if (rec.new_context) sealCtx(c)
    if (rec.new_entity) sealEnt(e)
    if (rec.new_session) sealSess(s)
    return 'ok'
  }
  function lineOf(r) {
    const data = r.data != null && typeof r.data === 'object' ? r.data : null
    return { id: String(r.id || ''), ts: finite(r.ts) ? r.ts : 0, text: String(r.text), state: ACTIVITY_STATES.includes(r.state) ? r.state : 'running',
      details: typeof r.details === 'string' && r.details ? r.details : null, data, data_bytes: data != null ? utf8(JSON.stringify(data)) : 0 }
  }
  /** Contexts/entities seen so far whose phase-1 fields are not all resolved yet. */
  function pending() { let n = 0; for (const s of sessions.values()) for (const e of [s.self, ...s.agents.values()]) if (!entDone(e)) n++; return n }
  /** Does `day`'s file still hold an older cp that an in-window rep line needs? (keep reading it past the window) */
  const wantsOlder = day => { const m = repLast.get(day); return !!(m && m.size) }
  function build(withLogs) {
    const out = new Map()
    for (const s of sessions.values()) {
      const created = s.created
      const sess = { key: s.key, origin: state.origin, realm: s.realm, session: s.session, project: s.project, user: s.user, host: s.host,
        created_at: created, last_activity: Math.max(created, s.last), gone_at: null, self: bEnt(s.self, created, withLogs), agents: new Map(), persisted: true }
      for (const [k, a] of s.agents) sess.agents.set(k, bEnt(a, a.started, withLogs))
      out.set(s.key, sess)
    }
    state.local = out
    state.cpLive = new Map()
    expire(state, now)
  }
  function bEnt(r, started, withLogs) {
    const e = newEntity(r.path, started)
    e.last_activity = Math.max(started, r.last); e.finished_at = r.finAt; e.stale_after_ms = r.sa; e.persisted = r.touched
    e.contexts.clear()
    for (const c of r.contexts.values()) {
      const created = c.key === 'root' ? started : c.created
      const x = newContext(c.name, created)
      x.last_activity = Math.max(created, c.last); x.stale_after_ms = c.sa; x.persisted = c.touched
      x.current = c.current ? { ...c.current } : null
      x.progress = c.progress ? { ...c.progress } : null
      x.eta_at = c.etaRes ? c.eta : (c.hasPend ? c.pend : null)   // provisional until resolved
      if (DONE_OR_FAILED.has(stateOf(x))) x.eta_at = null
      e.contexts.set(c.key, x)
    }
    if (withLogs) { e.log = r.log.slice().reverse(); e.log_dropped = r.total - e.log.length }
    return e
  }
  return {
    feed, pending, wantsOlder,
    /** true once at least one record was used and every entity/context seen so far has its phase-1 fields */
    phase1Complete: () => fed > 0 && pending() === 0,
    /** Install the phase-1 view (current lines, bars, states; no history) into state.local — early, provisional. */
    publish() { build(false) },
    /** End of input: resolve everything, install current state + history, re-derive today's cp keys. */
    finish() {
      for (const s of sessions.values()) sealSess(s)
      build(true)
      state.cp = cpKeys.size || maxK ? { day: today, keys: new Map(cpKeys), next: maxK + 1, rep: null } : null
      return { fed, skipped, entries, cps, reps, sessions: state.local.size }
    },
    stats: () => ({ fed, skipped, entries, cps, reps, pending: pending() }),
  }
}
/**
 * Convenience: replay records given NEWEST FIRST in one go (stops at the first one older than the window) and install
 * the result. Returns finish()'s stats.
 * @param {ActivityState} state @param {any[]} recordsNewestFirst @param {number} now
 */
export function replayNewestFirst(state, recordsNewestFirst, now) {
  const rp = createReplay(state, { now })
  for (const r of recordsNewestFirst) {
    const res = rp.feed(r)
    if (res === 'old' && !rp.wantsOlder(localDay(r && (r.ts || r.last)))) break
  }
  return rp.finish()
}

// ---------------------------------------------------------------------------------------------------------------
// text placeholders (rendered at READ time; the JSONL, the gossip snapshot and the state keep the raw template)

/** A locale-neutral number: thousands grouped with ",", at most 2 decimals (trailing zeros dropped). Deterministic. */
export function fmtNum(n) {
  if (!Number.isFinite(n)) return String(n)
  const [i, f] = (Math.round(Math.abs(n) * 100) / 100).toFixed(2).split('.')
  const frac = f.replace(/0+$/, '')
  return (n < 0 && (Number(i) || Number(frac)) ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '')
}
/** A short relative duration for an ETA: "~1h 25m", "~45m", "~2d 3h", "~30s"; due or past → "now". */
export function fmtEta(ms) {
  if (!Number.isFinite(ms)) return '?'
  if (ms <= 0) return 'now'
  if (ms < 59500) return `~${Math.max(1, Math.round(ms / 1000))}s`
  const m = Math.round(ms / MIN), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d) return `~${d}d${h ? ` ${h}h` : ''}`
  if (h) return `~${h}h${mm ? ` ${mm}m` : ''}`
  return `~${mm}m`
}
/**
 * Render a status-text TEMPLATE (#70 step 2). Placeholders: {progress} → "4,812 of 12,000 tiles" ("61%" for a % bar,
 * "3 of 6" without a unit); {pct} → "40%" (floored, so 100% only when done); {done}, {total}, {unit}; {eta} → "~1h 25m"
 * from eta_at vs now ("now" once due, "?" when there is no ETA). `{{` and `}}` are literal braces. An unknown {word} is
 * left untouched, and so is a bar placeholder with no bar to fill it (or {unit} with no unit).
 * @param {string} template @param {any} progress  {done,total,unit} (or a rollup) or null
 * @param {number|null|undefined} eta_at @param {number} now
 */
export function renderText(template, progress, eta_at, now) {
  if (typeof template !== 'string') return ''
  if (!template.includes('{') && !template.includes('}')) return template
  const p = progress && Number.isFinite(progress.done) && Number.isFinite(progress.total) && progress.total > 0 ? progress : null
  const unit = p && typeof p.unit === 'string' ? p.unit : ''
  return template.replace(/\{\{|\}\}|\{([a-z_]+)\}/g, (m, k) => {
    if (m === '{{') return '{'
    if (m === '}}') return '}'
    switch (k) {
      case 'progress': return !p ? m : unit === '%' ? `${fmtNum(p.done)}%` : `${fmtNum(p.done)} of ${fmtNum(p.total)}${unit ? ' ' + unit : ''}`
      case 'pct': return p ? `${Math.floor(progressPct(p) + 1e-9)}%` : m
      case 'done': return p ? fmtNum(p.done) : m
      case 'total': return p ? fmtNum(p.total) : m
      case 'unit': return unit || m
      case 'eta': return Number.isFinite(eta_at) && eta_at > 0 ? fmtEta(eta_at - now) : '?'
      default: return m
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// read views (the `activity` tool; the step-5 dashboard and the orchestrator query build on the same)

// a current line renders against the context's CURRENT bar + ETA (a root line: the bar the entity shows — its rollup)
const lineView = (l, p, eta, now) => (l ? compact({ id: l.id, ts: l.ts, text: l.text, rendered: renderText(l.text, p, eta, now), state: l.state,
  has_details: !!(l.details || l.has_details), has_data: !!(l.data != null || l.has_data) }) : null)
/**
 * This host's board: sessions → agents → contexts with their current lines, EFFECTIVE state (stale computed with
 * `staleMin`, default config.stale_after_min; gone), rollup progress and visibility. Sorted by key.
 * @param {ActivityState} state @param {number} now
 * @param {{ project?:string, session?:string, agent?:string, active_only?:boolean, staleMin?:number }} [opts]
 *   agent matches that path or anything under it (`a` → `a`, `a/b`); active_only drops finished/gone agents
 */
export function boardView(state, now, opts = {}) {
  const sm = Number(opts.staleMin) > 0 ? Number(opts.staleMin) : state.config.stale_after_min
  const hours = state.config.finished_visible_hours
  const pk = str(opts.project) ? projKey(opts.project) : null, sk = str(opts.session) ? lc(opts.session) : null, ak = str(opts.agent) ? lc(opts.agent).replace(/^\/+|\/+$/g, '') : null
  const ctxView = (c, e) => {
    const eff = effectiveState(c, now, sm, e)
    return compact({ name: c.name, state: eff.state, was: eff.state !== eff.was ? eff.was : null, stale_at: eff.stale_at,
      current: lineView(c.current, c.key === 'root' ? rollup(e) : c.progress, c.eta_at, now),
      progress: c.progress ? { ...c.progress, pct: Math.round(progressPct(c.progress) * 10) / 10 } : null, eta_at: c.eta_at, created_at: c.created_at,
      last_activity: c.last_activity, stale_after_ms: c.stale_after_ms })
  }
  const entView = e => {
    const eff = effectiveState(e, now, sm), root = e.contexts.get('root'), bar = rollup(e)
    return compact({ agent: e.path, state: eff.state, was: eff.state !== eff.was ? eff.was : null, stale_at: eff.stale_at, active: isActive(e), visible: visible(e, now, hours),
      current: lineView(root && root.current, bar, root ? root.eta_at : null, now), progress: bar, eta_at: root ? root.eta_at : null, started_at: e.started_at, last_activity: e.last_activity,
      finished_at: e.finished_at, gone_at: e.gone_at, stale_after_ms: e.stale_after_ms,
      contexts: [...e.contexts.values()].sort((a, b) => (a.key === 'root' ? -1 : b.key === 'root' ? 1 : cmp(a.key, b.key))).map(c => ctxView(c, e)),
      log: { entries: e.log.length, dropped: e.log_dropped } })
  }
  const out = []
  for (const s of [...state.local.values()].sort((a, b) => cmp(a.key, b.key))) {
    if (pk && projKey(s.project) !== pk) continue
    if (sk && lc(s.session) !== sk) continue
    let agents = [...s.agents.values()].sort((a, b) => cmp(a.key, b.key))
    if (ak) agents = agents.filter(a => a.key === ak || a.key.startsWith(ak + '/'))
    if (opts.active_only) agents = agents.filter(isActive)
    if (ak && !agents.length) continue
    out.push(compact({ session: s.session, project: s.project, user: s.user, realm: s.realm, host: s.host, created_at: s.created_at, last_activity: s.last_activity,
      gone_at: s.gone_at, self: entView(s.self), agents: agents.map(entView) }))
  }
  return out
}
/**
 * One entity's in-memory log, NEWEST FIRST (optionally one context's). The session is found by name (+ project/user
 * when the name alone is ambiguous). Checkpoints and repeat lines are never in it. Each entry's `rendered` uses the
 * progress / ETA RECORDED on that entry (history stays accurate), `now` for {eta}.
 * @param {ActivityState} state
 * @param {{ session:string, project?:string, user?:string, agent?:string|null, context?:string, limit?:number }} q
 * @param {number} [now]
 * @returns {ActivityResult}
 */
export function logView(state, q, now = Date.now()) {
  if (!q || typeof q !== 'object' || !str(q.session)) return bad('bad-log-query', 'log needs { session, project?, agent?, context?, limit? }')
  const sk = lc(q.session), pk = str(q.project) ? projKey(q.project) : null, uk = str(q.user) ? lc(q.user) : null
  const cands = [...state.local.values()].filter(s => lc(s.session) === sk && (!pk || projKey(s.project) === pk) && (!uk || lc(s.user) === uk))
  if (!cands.length) return bad('unknown-session', `no activity from a session "${q.session}" on this host`)
  if (cands.length > 1) return { ok: false, code: 'ambiguous-session', what: 'several sessions have that name — pass project (and user)', candidates: cands.map(s => ({ session: s.session, project: s.project, user: s.user })) }
  const s = cands[0]
  const ent = !str(q.agent) ? s.self : s.agents.get(lc(q.agent))
  if (!ent) return bad('unknown-agent', `session "${s.session}" has no agent "${q.agent}"`)
  let ck = null
  if (str(q.context)) { const c = parseContextParam(q.context); if (!c.ok) return c; ck = lc(c.name) }
  const lim = Math.max(1, Math.min(Number(q.limit) > 0 ? Math.floor(Number(q.limit)) : 50, state.config.log_entries_per_agent))
  const list = ck ? ent.log.filter(x => lc(x.context) === ck) : ent.log
  return { ok: true, session: s.session, project: s.project, user: s.user, agent: ent.path, context: ck ? (ent.contexts.get(ck) || { name: ck }).name : null,
    entries: list.slice(-lim).reverse().map(x => ({ ...x, rendered: renderText(x.text, x.progress, x.eta_at, now) })), total: list.length, dropped: ent.log_dropped }
}
/**
 * An entry by id from MEMORY: a current line (with its details/data; `rendered` against the live bar) or a log entry
 * (flags only — the caller reads details/data back from the JSONL; `rendered` as recorded). null when not held.
 * @param {ActivityState} state @param {string} id @param {number} [now]
 * @returns {null | { where:string, complete:boolean, entry:any }}  where 'current' | 'log'
 */
export function findEntry(state, id, now = Date.now()) {
  if (typeof id !== 'string' || !id) return null
  let hit = null
  for (const s of state.local.values()) for (const e of [s.self, ...s.agents.values()]) {
    const who = { session: s.session, project: s.project, user: s.user, realm: s.realm, host: s.host, agent: e.path }
    for (const c of e.contexts.values()) if (c.current && c.current.id === id) {
      const l = c.current
      const r = renderText(l.text, c.key === 'root' ? rollup(e) : c.progress, c.eta_at, now)
      return { where: 'current', complete: true, entry: { id: l.id, ts: l.ts, ...who, context: c.name, current: true, text: l.text, rendered: r, state: l.state, details: l.details || null, data: l.data != null ? l.data : null } }
    }
    if (!hit) { const x = e.log.find(y => y.id === id); if (x) hit = { where: 'log', complete: !x.has_details && !x.has_data, entry: { ...x, ...who, current: !!x.current, rendered: renderText(x.text, x.progress, x.eta_at, now), details: null, data: null } } }
  }
  return hit
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
  return compact({ session: s.session, project: s.project, user: s.user, realm: s.realm, host: s.host, created_at: s.created_at, last_activity: s.last_activity,
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
  const realm = str(r.realm) || 'default', user = str(r.user)
  const s = { key: sessionKey({ realm, project, user, session }), origin, realm, session, project, user, host: str(r.host), created_at: wTime(r.created_at) || 0,
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
