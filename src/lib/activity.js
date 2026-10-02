// #70 agent activity board — the PURE core. No I/O, no timers, no clock: every function that needs the time takes `now`
// (ms epoch) as a parameter, so the whole model is exercised directly by tests/test_activity_unit. Step 1 built the model;
// step 2 (v1.58.0) wired it into bridge.mjs (the `log` + `activity` tools, the gateway-owned state, the daily JSONL); steps
// 3–5 added the script, the gossip and the dashboard. Step 6a (v1.62.0, #70 "Step 6 redesign") REPLACED the fixed
// session → agent → context shape with ONE TREE OF NODES per session, and added batch logging.
//
// THE MODEL (docs/issues.md #70 "Step 6 redesign: unified tree").
// - A SESSION is keyed by sessionKey(realm, projKey(project), lc(user), lc(session), lc(host)) — the HOST is the ORIGIN
//   that holds it (this state's own `origin` for the local slice; the link's host for a remote slice). The same session
//   name on two hosts is two sessions; the board GROUPS them (boardView). Unchanged by 6a.
// - A session holds a tree of NODES in `sess.nodes` (a flat Map keyed by the node KEY) plus `sess.kids` (parent key →
//   child keys, insertion order). The session itself is the ROOT node (key '', path ''), agent-like for lifecycle (it
//   starts, finishes on a done/failed current line, goes stale, gone) — what `session.self` was before 6a.
// - Every other node is one of two KINDS, decided by its path segment: an AGENT (an actor: it starts, finishes when its
//   own current line is set done/failed, can go stale or gone, has `stale_after`) or a CONTEXT (a piece of work: a current
//   line, progress, an ETA — it never goes stale itself). Any node may contain either kind.
// - PATHS (parsePath / formatPath): one `/`-separated path; a segment starting with `@` is a context, anything else an
//   agent: `spec-70`, `spec-70/research`, `spec-70/@Tharsis`, `spec-70/@Tharsis/@z12`, `@#70/spec-70`,
//   `@#70/@step4/spec-70`. Quote a context name with spaces: `@"CTX strip 17"`. `@~` on the LAST segment sets that node's
//   CURRENT line; `@root` / `@~root` as the last segment means the node itself (so `a/b/@~root` = a/b's own headline, and
//   a bare `@~root` the session's). Names: an agent segment is letters/digits/_ then `. : # + -` (≤48 chars, no spaces); a
//   context name ≤60 chars, no `"`, `/` or control characters ("root" is reserved). The node KEY = lc(canonical path) —
//   case-insensitive, first-seen spelling kept (the #71 lesson); the parent key is the key minus its last segment.
// - THE OLD NOTATION IS A SPECIAL CASE (resolveAddress): `agent` (agent segments only) + `path` + ONE trailing context —
//   the `context` param ("@root" | "@Ctx" | "@~Ctx", markers optional) or else a leading `@…` prefix in the text, which
//   may itself be a relative path (`@Tharsis/@~z12 …`, `@#70/spec-70 …`). So agent:"a/b" + text "@~Ctx …" = a/b/@~Ctx.
// - Intermediate nodes a path names are created IMPLICITLY (no current line, `implicit:true`); a node stops being implicit
//   the first time a message targets it or is OWNED by it. The OWNER of a message is the nearest agent at or above its
//   target (the root when there is none). An implicit agent never goes stale (it never reported) — the root included: a
//   session whose only reports come from its agents has no staleness of its own.
// - Every message belongs to its TARGET node. `@~` (current:true) sets the target's current line + state; without it the
//   message is logged only. STATE (`running|blocked|failed|done|idle`) is the current line's; a node with no current line
//   counts as running. ONLY a current line changes it (a plain message records its state in its log entry only). An entry's
//   state defaults to the target's current state, else running. A done|failed current line on an AGENT node (or the root)
//   FINISHES it (`finished_at`); a later running|blocked|idle line revives it. Contexts don't finish (6b adds todos).
// - ACTIVITY: a message refreshes `last_activity` (and sets `stale_after`, until each node's next message) on its target
//   and every node above it up to and including its OWNER — so a context's message keeps its agent fresh, but a sub-agent
//   does not refresh its parent agent (each actor goes stale by its own reports, as before). The session header's
//   last_activity moves on every message. GONE is per agent (markSessionGone / markOriginDown mark every agent node).
// - STALE is computed, never reported (effectiveState / staleAt) and belongs to AGENTS (and the root): a running or
//   blocked agent with no message of ANY kind (owned by it) for longer than its window (its `stale_after` if its last
//   message set one, else the host's `stale_after_min`). done/failed/idle never go stale, nor does an implicit agent. A
//   CONTEXT never goes stale by itself: it shows the staleness (and gone) of its NEAREST AGENT ANCESTOR — the root for a
//   context directly under the session (6a decision: the session's own reports, at any depth that doesn't cross an agent,
//   keep it fresh — exactly as the session row always has) — and only while it has a live (running/blocked) current line
//   of its own; a context with no current line (a grouping node) shows no state and never shows stale.
// - PROGRESS and ETA are node attributes set by ANY message to that node (sticky; "none" clears either). ETA is stored as
//   an absolute ms time (eta_at) and is null whenever the node's state is done/failed. `details` and `data` belong to the
//   LINE: they are replaced by each current line and never carried forward.
// - ROLLUP (rollup / the bar): a node's bar is its REPORTED progress, else the SUM of its children's bars when they share a
//   unit, else the MEAN % of its children that have a bar — recursively, through any depth (`rollupStrategies` is the hook
//   where 6b adds "N of M todos done").
// - THE `log` FLAG (default true): log:false takes full effect on the board but is not appended to the log or the JSONL.
//   TEXT IS A TEMPLATE ({progress} {pct} {done} {total} {unit} {eta}) rendered at READ time (renderText).
// - BATCH (splitBatch): `items:[…]` (≤64 items, ≤64 KB) applied in order, one result each; one bad item doesn't abort the
//   rest. Top-level path / agent / context / log are DEFAULTS for every item (6b: an item's own path / agent is RELATIVE to
//   the default path, like a folder; a leading "/" makes it absolute — withDefaults).
//
// MEMORY MODEL: every node keeps its OWN bounded log (`log_entries_per_agent` entries, oldest dropped → `log_dropped`, and
// `log_floor` = the newest dropped entry's time: older entries of that node live only in the files). An in-memory entry
// keeps only text, state, time, the current flag and small fields; `details`/`data` live in memory ONLY on each node's
// CURRENT line. A node's "Log" view (logView) is the MERGED log of its subtree, newest first (a k-way merge over the
// subtree's per-node logs), paged by cursor, continuing into the day files below the subtree's floor.
//
// PERSISTED RECORDS (the daily JSONL, one host = one writer) — RECORD FORMAT v2 (6a; v1 records of 1.58–1.61 are SKIPPED
// by recordKind, never misread): logged entries { v:2, id, ts, path, current, text, state, …, identity, details, data },
// CHECKPOINTS { v:2, kind:"cp", k, ts, path, current, state, progress, eta_at, … } and REPEAT lines { v:2, rep:[k…], n,
// since, last }. The FIRST persisted record touching a node carries `new_from: i` (the chain root..target from index i on
// is new — 0 = the session itself); an entry whose new agent evicted others carries `evicted:[path]`; a current line on an
// agent carries the agent's resulting `finished_at`. The replay uses them to stop exactly where an instance began.
//
// REPLAY (createReplay / replayNewestFirst): rebuilds the local slice from records fed NEWEST FIRST. Phase 1 resolves each
// node's current line, bar, ETA, state and (agents) finished status from the newest record carrying them and stops once
// found or once the instance's first record (new_from) is passed — a node is sealed with its whole subtree. Phase 2 fills
// each node's log. Equivalent to a chronological apply() of the same records (the seeded-random unit test).
//
// GOSSIP: snapshot() / planSlice() / applySlice() — FORMAT v2 (a 1.61 v1 slice is refused 'bad-version'). One UNIT per
// node (its own fields only: no children, no rollup, no log, never details/data). Per-origin ownership, deltas against a
// per-link published view, newest-active first under a byte cap. A receiver stores nodes flat by key, so a child that
// arrives before its parent (a truncated frame) is held and linked once the parent arrives.
//
// DASHBOARDS: boardView({ raw:true }) → dashUnits() (one unit per session group + one per NODE) → planDashDelta().
// LIMITS are locked in code (they change what crosses the mesh); per-host knobs come from the `activity` config block.
//
// 6b (v1.63.0, #70 "Decisions before 6b"): TODOS AND PLANS. A context gains the states `todo` (☐) and `skipped` (struck
// through). A context whose FIRST current line is `todo`, or one created by a `plan:[…]`, is remembered as a PLAN ITEM
// (`node.plan` — no caller-visible flag; it stays one when ticked: done shows ☑). Agents (and the session) can't take
// todo / skipped ('bad-agent-state'); skipped (or todo on a context that already has a line) on an ordinary context is
// 'not-a-plan-item'. A plan item NEVER goes stale and never shows gone (its owner agent's row carries that). `plan:[names]`
// creates ☐ children of the target in the GIVEN order (re-plan: an existing item is kept as it is; a new name is added at
// the END; a name left out is left alone; an existing context with no line of its own is adopted as an item). Rollup adds
// "N of M done" (skipped excluded from M) after 6a's strategies. Lifetime: open items (todo/running/blocked) never expire
// and are never evicted; a plan expires finished_visible_hours (now 168 = 7 days) after its last item became done/skipped
// or its owner agent finished. CARRY-FORWARD (planCarryForward): at each local day rollover the gateway writes a `cf` record
// of every long-lived node (open plan items + their ancestors, and every node whose state would otherwise fall out of the
// replay window) into the new day's file, so a weeks-old open plan is rebuilt from the window alone. Records + slices are
// FORMAT v3 (v2 JSONL records are still read — v3 only adds; a v2 slice is refused: a 1.62 hub would misread todo states).
import { lc, projKey } from './keys.js'

/** The locked #70 limits (6a: depth/nodes replace "agent path depth 3" + "32 contexts per agent"). text/context in code
 * points; details/data/batch in UTF-8 bytes. */
export const ACTIVITY_LIMITS = Object.freeze({
  text: 240,                        // message text; LONGER IS TRUNCATED (… + warning), not rejected — see parseMessage
  context: 60,                      // context name; longer is REJECTED (a name is an identity: truncating could merge two)
  depth: 6,                         // path segments below the session (a/b/@c/@d/e/@f)
  pathSegment: 48,                  // chars per agent segment (this module's choice; not in the spec table)
  agentsPerSession: 128,            // agent nodes (the session root is not counted)
  nodesPerSession: 4096,            // every node of either kind (the root not counted)
  detailsBytes: 4 * 1024,
  dataBytes: 16 * 1024,
  staleAfterMaxMs: 24 * 3600000,    // a longer stale_after is CLAMPED to 24h (+ warning)
  etaMaxMs: 7 * 86400000,           // an ETA further out than 7 days is rejected (this module's choice)
  unit: 24,                         // progress unit label, code points (this module's choice)
  batchItems: 64,                   // a `log` call's items:[…] (6a)
  batchBytes: 64 * 1024,            // … and their JSON size
  planItems: 64,                    // names in one plan:[…] (6b; this module's choice — a plan also counts toward nodesPerSession)
})
/** Record / slice format. 6a = v2 (a v1 record of 1.58–1.61 is skipped); 6b = v3 (todo/skipped states, plan items, `cf`
 * carry-forward records). A v3 bridge still READS v2 JSONL records (v3 only adds) but refuses a v2 gossip slice. */
export const ACTIVITY_FORMAT = 3
const RECORD_FORMATS = new Set([2, 3])
/** The reportable states. `stale` and `gone` are derived (effectiveState), never reported. 6b: + todo / skipped (contexts only;
 * skipped only on a plan item). */
export const ACTIVITY_STATES = Object.freeze(['running', 'blocked', 'failed', 'done', 'idle', 'todo', 'skipped'])
/** The per-host defaults (`activity` config block). */
export const ACTIVITY_DEFAULTS = Object.freeze({
  log_retention_days: 7,            // daily JSONL retention
  log_entries_per_agent: 200,       // in-memory log cap per NODE (6a: every node keeps its own log)
  stale_after_min: 15,              // the default stale window (also the dashboard slider's default)
  finished_visible_hours: 168,      // a finished (or gone) agent stays visible/gossiped this long; also the replay window (6b: 7 days, was 24)
  memory_budget_mb: 64,             // enforceBudget's default budget
  progress_checkpoint_sec: 60,      // cp/rep cadence for log:false activity (0 = off; else 10..3600)
  enabled: true,
})
/** @typedef {Readonly<{ log_retention_days:number, log_entries_per_agent:number, stale_after_min:number, finished_visible_hours:number,
 *   memory_budget_mb:number, progress_checkpoint_sec:number, enabled:boolean }>} ActivityConfig */
/** config key -> env override name (AI_BRIDGE_ACTIVITY_<KEY>). */
export const ACTIVITY_ENV = Object.freeze(Object.fromEntries(Object.keys(ACTIVITY_DEFAULTS).map(k => [k, 'AI_BRIDGE_ACTIVITY_' + k.toUpperCase()])))
/** The message fields of a `log` call / batch item (6a: + path; 6b: + plan). */
export const MESSAGE_FIELDS = Object.freeze(['path', 'agent', 'text', 'context', 'state', 'progress', 'eta', 'stale_after', 'details', 'data', 'log', 'plan'])
/** Batch-level DEFAULTS allowed beside items:[…] (each item's own field wins). */
export const BATCH_DEFAULT_FIELDS = Object.freeze(['path', 'agent', 'context', 'log'])
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
const PLAN_STATES = new Set(['todo', 'skipped'])            // 6b: contexts only (skipped: plan items only)
const OPEN_ITEM = new Set(['todo', 'running', 'blocked'])   // 6b: an OPEN plan item — never expires, never evicted
const RESOLVED_ITEM = new Set(['done', 'skipped'])          // 6b: what closes a plan (failed / idle items don't — the owner finishing does)

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
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/**
 * The session key: realm + projKey(project) + lc(user) + lc(session) + lc(host), JSON-encoded so no separator can collide.
 * Inside this module the host is always the ORIGIN holding the session (keyOf). A missing realm is 'default'.
 * @param {{ realm?: string|null, project?: string|null, user?: string|null, session?: string|null, host?: string|null }} ident
 */
export const sessionKey = ident => { const i = ident && typeof ident === 'object' ? ident : {}; return JSON.stringify([lc(i.realm) || 'default', projKey(i.project), lc(i.user), lc(i.session), lc(i.host) || '']) }
/** The cross-host GROUP key (the board groups a session's entities from every host): sessionKey minus the host. */
export const groupKey = ident => { const i = ident && typeof ident === 'object' ? ident : {}; return JSON.stringify([lc(i.realm) || 'default', projKey(i.project), lc(i.user), lc(i.session)]) }
/** The key of `ident` as held in `origin`'s slice (default: this state's own) — the host is the origin, never ident.host. */
const keyOf = (state, ident, origin) => sessionKey({ ...(ident && typeof ident === 'object' ? ident : {}), host: origin || state.origin })
const p2 = n => String(n).padStart(2, '0')
/** The LOCAL calendar day of a ms time, "YYYY-MM-DD" (the daily JSONL's file name); null for a bad time. */
export function localDay(ts) { const d = new Date(ts); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : null }
/** The ms time embedded in an entry id (`<prefix><ts36>-<seq36>`) — which day file holds it — or null. */
export function entryTime(id) {
  const m = typeof id === 'string' && id.match(/([0-9a-z]+)-[0-9a-z]+$/)
  const t = m ? parseInt(m[1], 36) : NaN
  return Number.isFinite(t) && t > 1e12 && t < 1e14 ? t : null
}
/** An entry's ORDER key [ts, seq]: logs are kept sorted by it and merged by it (ties within one ms keep apply order). */
const seqOf = id => { const m = typeof id === 'string' && id.match(/-([0-9a-z]+)$/); const n = m ? parseInt(m[1], 36) : 0; return Number.isFinite(n) ? n : 0 }
const ordCmp = (a, b) => a.ts - b.ts || seqOf(a.id) - seqOf(b.id) || cmp(a.id, b.id)

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
// parsing: durations, progress, ETA

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
 * 'progress-clamped' warning. The unit is ≤ ACTIVITY_LIMITS.unit code points.
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
 * from `now`. A clock time "HH:MM" (24h) is LOCAL time at `tzOffsetMin` (minutes EAST of UTC), today, or tomorrow if that
 * time has already passed. Resolved at parse time so the stored value is absolute.
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

// ---------------------------------------------------------------------------------------------------------------
// parsing: names + PATHS (6a)

/**
 * Canonicalise a context NAME (without its at-sign/tilde markers): whitespace runs → one space, trimmed, ≤ 60 code
 * points, no control chars, `"` or `/` (6a: a slash separates path segments). Any case of "root" → 'root'.
 * @param {any} raw
 * @returns {ActivityResult} { ok:true, name } or { ok:false, code, what }
 */
export function normContextName(raw) {
  if (typeof raw !== 'string') return bad('bad-context', 'context must be a string')
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) return bad('bad-context', 'context name is empty')
  if (/["\u0000-\u001f\u007f]/.test(name)) return bad('bad-context', 'context name may not contain quotes or control characters')
  if (name.includes('/')) return bad('bad-context', 'context name may not contain "/" (it separates path segments — nest with a path: "@a/@b")')
  if (cpLen(name) > ACTIVITY_LIMITS.context) return bad('context-too-long', `context name is longer than ${ACTIVITY_LIMITS.context} chars`)
  return { ok: true, name: lc(name) === 'root' ? 'root' : name }
}
const SEGMENT = /^[\p{L}\p{N}_][\p{L}\p{N}_.:#+-]*$/u
function normAgentSeg(raw) {
  const s = String(raw).trim()
  if (!s) return bad('bad-agent', 'agent path has an empty segment')
  if (cpLen(s) > ACTIVITY_LIMITS.pathSegment) return bad('bad-agent', `agent path segment "${cpSlice(s, 20)}…" is longer than ${ACTIVITY_LIMITS.pathSegment} chars`)
  if (!SEGMENT.test(s)) return bad('bad-agent', `agent path segment "${cpSlice(s, 40)}" may only use letters, digits and _ . : # + - (no spaces; a context segment starts with @)`)
  return { ok: true, name: s }
}
const tooDeep = n => bad('path-too-deep', `the path has ${n} segments; the limit is ${ACTIVITY_LIMITS.depth}`)
/**
 * Canonicalise an AGENT path (agent segments only — the old `agent` field): 1..6 `/`-separated segments, each trimmed.
 * Leading/trailing slashes are dropped; an empty inner segment is not.
 * @param {any} raw
 * @returns {ActivityResult} { ok:true, path, segs } or { ok:false, code, what }
 */
export function normAgentPath(raw) {
  if (typeof raw !== 'string') return bad('bad-agent', 'agent must be a string path like "spec-70/research"')
  const parts = raw.trim().replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length === 1 && !parts[0].trim()) return bad('bad-agent', 'agent path is empty')
  if (parts.length > ACTIVITY_LIMITS.depth) return tooDeep(parts.length)
  /** @type {PathSeg[]} */
  const segs = []
  for (const p of parts) { const a = normAgentSeg(p); if (!a.ok) return a; segs.push({ kind: 'agent', name: a.name }) }
  return { ok: true, path: formatPath(segs), segs }
}
/** @typedef {{ kind: 'agent'|'context', name: string }} PathSeg */
const needsQuote = name => /\s/.test(name) || name[0] === '~'
const segText = s => (s.kind === 'context' ? '@' + (needsQuote(s.name) ? `"${s.name}"` : s.name) : s.name)
/** The canonical display path of segments ('' = the session root). Its lc() is the node KEY. @param {PathSeg[]} segs */
export const formatPath = segs => segs.map(segText).join('/')
/** The node key of a display path (case-insensitive). */
export const pathKey = p => lc(p)
/** A child's display path: its parent's (first-seen) path + the new segment. */
const childPath = (parent, seg) => (parent && parent.path ? parent.path + '/' : '') + segText(seg)
const parentKeyOf = k => { const i = k.lastIndexOf('/'); return k ? (i < 0 ? '' : k.slice(0, i)) : null }
/**
 * Scan a path at `i` of `s`: segments split on `/` (outside quotes). A segment starting with `@` is a context (`@~` = the
 * current-line marker; `@"…"` quoted; `@root` = the node itself), anything else an agent segment. textMode: the path is a
 * text PREFIX — it ends at whitespace (unquoted names may not contain spaces); otherwise it runs to the end of `s` and an
 * unquoted context name may contain spaces.
 * @returns {ActivityResult} { ok, segs:[{kind,name,current,root}], end }
 */
function scanPath(s, i, textMode) {
  const out = []
  const isWs = c => /\s/.test(c)
  for (;;) {
    if (i >= s.length || (textMode && isWs(s[i]))) { if (!out.length) return bad('bad-path', 'empty path'); break }
    if (s[i] === '/') return bad('bad-path', 'path has an empty segment')
    if (s[i] === '@') {
      let j = i + 1, current = false
      if (s[j] === '~') { current = true; j++ }
      let raw
      if (s[j] === '"') {
        const close = s.indexOf('"', j + 1)
        if (close < 0) return bad('bad-context', 'unterminated quoted context name (@"…")')
        raw = s.slice(j + 1, close); j = close + 1
        if (j < s.length && s[j] !== '/' && !(textMode && isWs(s[j]))) return bad('bad-context', textMode ? 'a quoted context name must be followed by a space' : 'a quoted context name must end its segment')
        const n = normContextName(raw); if (!n.ok) return n
        out.push({ kind: 'context', name: n.name, current, root: n.name === 'root' })
      } else {
        let k = j
        while (k < s.length && s[k] !== '/' && !(textMode && isWs(s[k]))) k++
        raw = s.slice(j, k); j = k
        const n = normContextName(raw); if (!n.ok) return n
        out.push({ kind: 'context', name: n.name, current, root: n.name === 'root' })
      }
      i = j
    } else {
      let k = i
      while (k < s.length && s[k] !== '/' && !(textMode && isWs(s[k]))) k++
      const a = normAgentSeg(s.slice(i, k)); if (!a.ok) return a
      out.push({ kind: 'agent', name: a.name, current: false, root: false })
      i = k
    }
    if (s[i] === '/') { i++; if (i >= s.length || (textMode && isWs(s[i]))) break }   // a trailing slash is tolerated
    else if (i < s.length && !(textMode && isWs(s[i]))) return bad('bad-path', 'unexpected character in the path')
  }
  return { ok: true, segs: out, end: i }
}
/** Normalise scanned segments: `@~` only on the last, `@root` only last (→ the node itself), depth ≤ 6. */
function finishSegs(raw) {
  const segs = [], n = raw.length
  let current = false
  for (let k = 0; k < n; k++) {
    const r = raw[k], last = k === n - 1
    if (r.current && !last) return bad('bad-path', '@~ (set the current line) may only mark the LAST segment')
    if (r.root && !last) return bad('bad-path', '@root (the node itself) may only be the last segment')
    if (last && r.current) current = true
    if (!r.root) segs.push({ kind: r.kind, name: r.name })
  }
  if (segs.length > ACTIVITY_LIMITS.depth) return tooDeep(segs.length)
  return { ok: true, segs, current }
}
/**
 * Parse a full node PATH (the `path` field): `spec-70/@Tharsis/@~z12`, `@#70/spec-70`, `@"CTX strip 17"`, `a/@~root`.
 * Leading/trailing slashes are dropped; '' (or just '@root') = the session itself.
 * @param {any} raw
 * @returns {ActivityResult} { ok:true, segs, current, path, key } or { ok:false, code, what }
 */
export function parsePath(raw) {
  if (typeof raw !== 'string') return bad('bad-path', 'path must be a string like "spec-70/@Tharsis"')
  const s = raw.trim().replace(/^\/+|\/+$/g, '')
  if (!s) return { ok: true, segs: [], current: false, path: '', key: '' }
  const r = scanPath(s, 0, false); if (!r.ok) return r
  const f = finishSegs(r.segs); if (!f.ok) return f
  const path = formatPath(f.segs)
  return { ok: true, segs: f.segs, current: f.current, path, key: pathKey(path) }
}
// A leading `@…` prefix in text — a RELATIVE path whose first segment is a context or the node itself (`@~Ctx`,
// `@"a b"`, `@Tharsis/@~z12`, `@#70/spec-70`). `@` (or `@~`) followed by whitespace or the end is NOT a prefix.
/** @returns {ActivityResult} { ok, raw:null } or { ok, raw:[seg…], rest } */
function splitPrefix(text) {
  const t = text.replace(/^\s+/, '')
  if (t[0] !== '@') return { ok: true, raw: null }
  let i = 1
  if (t[i] === '~') i++
  if (i >= t.length || /\s/.test(t[i])) return { ok: true, raw: null }
  const r = scanPath(t, 0, true); if (!r.ok) return r
  return { ok: true, raw: r.segs, rest: t.slice(r.end) }
}
// The legacy `context` parameter: "@root" | "@Ctx" | "@~Ctx" | "@~\"Ctx\"" — the markers are optional ("build" = @build,
// "~build" = @~build) and the whole remainder is ONE context name (spaces allowed without quotes). Nest with `path`.
/** @returns {ActivityResult} */
function parseContextParam(v) {
  if (typeof v !== 'string') return bad('bad-context', 'context must be a string like "@root", "@build" or "@~build"')
  let s = v.trim(), current = false
  if (s[0] === '@') s = s.slice(1)
  if (s[0] === '~') { current = true; s = s.slice(1) }
  s = s.trim()
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1)
  const n = normContextName(s)
  return n.ok ? { ok: true, raw: [{ kind: 'context', name: n.name, current, root: n.name === 'root' }] } : n
}
/**
 * Resolve the ADDRESS of a message or a query (6a): `agent` (agent segments only — the old field) + `path` (any path) +
 * ONE trailing part — the `context` param, else (when `text` is given and textPrefix) a leading `@…` prefix in the text.
 * Precedence: context param > text prefix; agent and path concatenate (agent first). `@~` marks only the overall LAST
 * segment. Returns the node's segments, path and key, the current flag, and the text left after a stripped prefix.
 * @param {any} input @param {{ text?: string|null }} [o]
 * @returns {ActivityResult} { ok, segs, current, path, key, text }
 */
export function resolveAddress(input, o = {}) {
  const raw = []
  let text = o.text
  if (has(input, 'agent')) { const a = normAgentPath(input.agent); if (!a.ok) return a; for (const sg of a.segs) raw.push({ ...sg, current: false, root: false }) }
  if (has(input, 'path')) {
    if (typeof input.path !== 'string') return bad('bad-path', 'path must be a string like "spec-70/@Tharsis"')
    const s = input.path.trim().replace(/^\/+|\/+$/g, '')
    if (s) { const r = scanPath(s, 0, false); if (!r.ok) return r; raw.push(...r.segs) }
  }
  let tail = null
  if (has(input, 'context') && !(typeof input.context === 'string' && !input.context.trim())) {
    const c = parseContextParam(input.context); if (!c.ok) return c
    tail = c.raw
  } else if (typeof text === 'string') {
    const p = splitPrefix(text); if (!p.ok) return p
    if (p.raw) { tail = p.raw; text = p.rest }
  }
  if (tail) {
    const prev = raw[raw.length - 1]
    if (prev && (prev.current || prev.root)) return bad('bad-path', 'the path already ends with @~ / @root — a context (or a text prefix) can\'t follow it')
    raw.push(...tail)
  }
  const f = finishSegs(raw); if (!f.ok) return f
  const path = formatPath(f.segs)
  return { ok: true, segs: f.segs, current: f.current, path, key: pathKey(path), text }
}
const ownerIndex = segs => { for (let i = segs.length - 1; i >= 0; i--) if (segs[i].kind === 'agent') return i + 1; return 0 }   // index into the chain [root, …segs]

/**
 * @typedef {{ done:number, total:number, unit:string }} ActivityProgress
 * @typedef {{
 *   segs: PathSeg[], path: string, key: string, agent: string|null, context: string, root: boolean, current: boolean,
 *   text: string, state: string|null, progress?: ActivityProgress|null, eta_at?: number|null, stale_after_ms: number|null,
 *   details: string|null, data: any, log: boolean, warnings: string[], plan?: string[], keepText?: boolean, planOnly?: boolean }} ActivityMsg
 *   `path`/`key` address the TARGET node ('' = the session root); `agent` = its OWNER's path (null = the session), `context`
 *   = the target's name when it is a context, else 'root' (the old shape); `root` = the target is an agent or the session.
 *   `progress` / `eta_at` are ABSENT when not given and null when explicitly cleared ("none").
 */

/**
 * Validate + normalise one report (the `log` tool / aimb-log script argument shape) into a message for apply().
 * - The address: see resolveAddress (path / agent / context / a text prefix). A text prefix is stripped; with the
 *   `context` param the text is taken LITERALLY.
 * - text: newlines/tabs → spaces, trimmed, non-empty; longer than 240 code points is TRUNCATED to 239 + "…" with a
 *   'text-truncated' warning. DEFAULT TEXT: a message carrying progress and/or eta may omit text — "{progress}" (or
 *   "{eta}"). Everything else over a limit is REJECTED.
 * - log, state, progress, eta, stale_after, details, data: as before 6a.
 * - 6b: state todo / skipped only on a CONTEXT ('bad-agent-state' on an agent or the session). `plan:[names]` (parsePlan)
 *   creates plan items under the target; with a plan the text is optional (no text = the plan only: `planOnly`). An `@~`
 *   message with a `state` may omit text: the node keeps its current text (`keepText`; else its name) — a tick.
 * @param {any} input  { path?, agent?, text?, context?, state?, progress?, eta?, stale_after?, details?, data?, log?, plan? }
 * @param {{ now?: number, tzOffsetMin?: number }} [opts]  needed only to resolve an eta
 * @returns {ActivityResult} { ok:true, msg: ActivityMsg } or { ok:false, code, what }
 */
export function parseMessage(input, opts = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('bad-input', 'expected an object { text, path?, agent?, context?, state?, progress?, eta?, stale_after?, details?, data?, log?, plan? }')
  if (input.items !== undefined) return bad('bad-input', 'items:[…] is a batch — log it as a batch (splitBatch)')
  const warnings = []
  const log = has(input, 'log') ? boolVal(input.log) : true
  if (log === null) return bad('bad-log', 'log must be true (append to the log; the default) or false (update the board only)')
  let plan = null
  if (input.plan !== undefined) { const pl = parsePlan(input.plan); if (!pl.ok) return pl; plan = pl.names; if (pl.warning) warnings.push(pl.warning) }
  let state = null
  if (has(input, 'state')) {
    state = typeof input.state === 'string' ? input.state.trim().toLowerCase() : ''
    if (!ACTIVITY_STATES.includes(state)) return bad('bad-state', `state must be one of ${ACTIVITY_STATES.join('|')}`)
  }
  const bar = has(input, 'progress') || has(input, 'eta')   // a bar update may omit text: it defaults to a template
  if (input.text != null && typeof input.text !== 'string') return bad('bad-text', 'text must be a string')
  const ad = resolveAddress(input, { text: input.text || '' }); if (!ad.ok) return ad
  let text = normText(ad.text), keepText = false, planOnly = false
  if (!text) {
    if (bar) text = has(input, 'progress') ? '{progress}' : '{eta}'   // #70: the default text of a bar update (rendered at read time)
    else if (state && ad.current) keepText = true                     // 6b: a tick (`@~…/@B` + state) keeps the line's text
    else if (plan && !state) planOnly = true                          // 6b: just the plan (the target gets no message of its own)
    else if (typeof input.text !== 'string') return bad('bad-text', 'text must be a string (it may be omitted only with progress / eta, a plan, or a state on an @~ line)')
    else return bad('text-empty', 'text is empty (a context prefix alone is not a message)')
  }
  if (cpLen(text) > ACTIVITY_LIMITS.text) { text = cpSlice(text, ACTIVITY_LIMITS.text - 1) + '…'; warnings.push('text-truncated') }
  const segs = ad.segs, oi = ownerIndex(segs), tgt = segs[segs.length - 1]
  if (state && PLAN_STATES.has(state) && (!tgt || tgt.kind === 'agent')) return bad('bad-agent-state', `${state} is a plan state — only a context (a plan item) can be ${state}; an agent or the session reports running|blocked|failed|done|idle`)
  if (plan && segs.length + 1 > ACTIVITY_LIMITS.depth) return tooDeep(segs.length + 1)
  /** @type {ActivityMsg} */
  const msg = { segs, path: ad.path, key: ad.key, agent: oi ? formatPath(segs.slice(0, oi)) : null, context: tgt && tgt.kind === 'context' ? tgt.name : 'root',
    root: !tgt || tgt.kind === 'agent', current: ad.current, text, state, stale_after_ms: null, details: null, data: null, log, warnings,
    ...(plan ? { plan } : {}), ...(keepText ? { keepText } : {}), ...(planOnly ? { planOnly } : {}) }
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

/**
 * 6b: a PLAN — 1..64 names, each ONE context segment validated like any context name (normContextName: ≤60 chars, no `/`,
 * quotes or control characters; one leading `@` is dropped, so "@A" = "A"; "root" is reserved). A name repeated in the
 * list (case-insensitive) is kept once ('plan-duplicates' warning). The order is the order given.
 * @param {any} v
 * @returns {ActivityResult} { ok:true, names:string[], warning? } or { ok:false, code:'bad-plan', what }
 */
export function parsePlan(v) {
  if (!Array.isArray(v) || !v.length) return bad('bad-plan', 'plan must be a non-empty array of names, e.g. ["Spec", "Build", "Test"]')
  if (v.length > ACTIVITY_LIMITS.planItems) return bad('bad-plan', `a plan holds at most ${ACTIVITY_LIMITS.planItems} names (got ${v.length}) — split it`)
  const names = [], seen = new Set()
  let dup = false
  for (const raw of v) {
    if (typeof raw !== 'string') return bad('bad-plan', 'each plan name must be a string')
    const s = raw.trim().replace(/^@/, '')
    if (s[0] === '@' || s[0] === '~') return bad('bad-plan', `plan name "${cpSlice(raw, 40)}": a name is one plain context segment (no @~ marker)`)
    const n = normContextName(s)
    if (!n.ok) return bad('bad-plan', `plan name "${cpSlice(String(raw), 40)}": ${n.what}`)
    if (n.name === 'root') return bad('bad-plan', 'plan name "root" is reserved (it means the node itself)')
    if (seen.has(lc(n.name))) { dup = true; continue }
    seen.add(lc(n.name)); names.push(n.name)
  }
  return { ok: true, names, ...(dup ? { warning: 'plan-duplicates' } : {}) }
}
const trimSlashes = s => String(s).trim().replace(/^\/+|\/+$/g, '')
/**
 * Merge batch / stream DEFAULTS under one item. `log` is a plain default. ADDRESS defaults — 6b (#70 "Decisions before 6b"
 * 7): an item's own `path` / `agent` is RELATIVE to the default address (default agent + default path), like a folder: the
 * result is agent = the default agent, path = default path / item agent / item path. A LEADING "/" on the item's first
 * address field (its agent, else its path) makes it ABSOLUTE from the session root (the defaults are then ignored). The
 * default `context` (a trailing marker) applies only to an item naming no path / agent of its own; an item with only a
 * `context` keeps the default path / agent and replaces the default context (the pre-6a stream rule). An item agent that
 * isn't a valid agent path is passed through unmerged, so parseMessage reports it.
 * @param {Record<string, any>} defaults @param {Record<string, any>} item
 */
export function withDefaults(defaults, item) {
  const d = { ...(defaults || {}) }
  if (!item || (item.path === undefined && item.agent === undefined)) return { ...d, ...item }
  const first = item.agent !== undefined ? item.agent : item.path
  delete d.context
  if (typeof first === 'string' && first.trim().startsWith('/')) { delete d.path; delete d.agent; return { ...d, ...item } }   // absolute
  if ((item.agent !== undefined && (typeof item.agent !== 'string' || !normAgentPath(item.agent).ok)) || (item.path !== undefined && typeof item.path !== 'string')) { delete d.path; delete d.agent; return { ...d, ...item } }
  const parts = [d.path, item.agent, item.path].filter(x => typeof x === 'string').map(trimSlashes).filter(Boolean)
  const { agent: _a, path: _p, ...rest } = item
  const out = /** @type {any} */ ({ ...d, ...rest, path: parts.join('/') })
  if (d.agent === undefined) delete out.agent
  return out
}
/**
 * BATCH (6a): split a `log` call's `{ items:[…], path?, agent?, context?, log? }` into per-item inputs. Bounds: 1..64 items
 * and ≤ 64 KB of items JSON — over either, the WHOLE call is refused ('too-many-items' / 'batch-too-large'). The
 * top-level path / agent / context / log are DEFAULTS merged under each item (withDefaults — 6b: an item's own path /
 * agent is RELATIVE to the default path, a leading "/" makes it absolute); any other top-level message field beside items
 * is 'bad-batch'. Each item: an object of MESSAGE_FIELDS (6b: + plan) + an optional `ref` (echoed); a non-object item or
 * an unknown field gets its own error (`error`) and the rest still apply.
 * @param {any} input
 * @returns {ActivityResult} { ok:true, items:[{ ref?, input?, error? }] } or { ok:false, code, what }
 */
export function splitBatch(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.items)) return bad('bad-batch', 'a batch is { items:[{ text, path?, … }, …] }')
  const items = input.items
  if (!items.length) return bad('bad-batch', 'items is empty')
  if (items.length > ACTIVITY_LIMITS.batchItems) return bad('too-many-items', `a batch holds at most ${ACTIVITY_LIMITS.batchItems} items (got ${items.length}) — split it`)
  let bytes
  try { bytes = utf8(JSON.stringify(items)) } catch (e) { return bad('bad-batch', `items are not JSON-serialisable (${e && e.message})`) }
  if (bytes > ACTIVITY_LIMITS.batchBytes) return bad('batch-too-large', `the batch is ${bytes} bytes of JSON; the limit is ${ACTIVITY_LIMITS.batchBytes} — split it or trim details/data`)
  const extra = Object.keys(input).filter(k => k !== 'items' && input[k] !== undefined && !BATCH_DEFAULT_FIELDS.includes(k))
  if (extra.length) return bad('bad-batch', `beside items only ${BATCH_DEFAULT_FIELDS.join(' / ')} may be given (as defaults for every item); put ${extra.join(', ')} in each item`)
  const defaults = {}
  for (const k of BATCH_DEFAULT_FIELDS) if (input[k] !== undefined) defaults[k] = input[k]
  const out = []
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) { out.push({ error: bad('bad-item', 'each item must be an object { text, path?, … }') }); continue }
    const { ref, ...fields } = it
    const r = ref !== undefined ? { ref } : {}
    const unknown = Object.keys(fields).filter(k => !MESSAGE_FIELDS.includes(k))
    if (unknown.length) { out.push({ ...r, error: bad('bad-field', `unknown field(s) ${unknown.join(', ')}: an item carries ${MESSAGE_FIELDS.join(', ')} (+ ref)`) }); continue }
    out.push({ ...r, input: withDefaults(defaults, fields) })
  }
  return { ok: true, items: out }
}

// ---------------------------------------------------------------------------------------------------------------
// state

/**
 * @typedef {{ id:string, ts:number, text:string, state:string, details?:string|null, data?:any, data_bytes?:number,
 *   has_details?:boolean, has_data?:boolean }} ActivityLine
 * @typedef {{ key:string, path:string, name:string, kind:'agent'|'context', parent:string|null, depth:number,
 *   created_at:number, last_activity:number, stale_after_ms:number|null, current:ActivityLine|null,
 *   progress:ActivityProgress|null, eta_at:number|null, finished_at:number|null, gone_at:number|null, implicit:boolean,
 *   log:any[], log_dropped:number, log_floor:number, persisted?:boolean, cp_dirty?:number, plan?:boolean, plan_ix?:number|null,
 *   pt?:{ a:number, l:number, p:number, e:number } }} ActivityNode
 * @typedef {{ key:string, origin:string, realm?:string, session:string, project:string, user:string|null,
 *   host:string|null, created_at:number, last_activity:number, gone_at:number|null, nodes:Map<string, ActivityNode>,
 *   kids:Map<string, Set<string>>, nAgents:number, bell?:boolean }} ActivitySession
 * @typedef {{ day:string, keys:Map<string, number>, next:number,
 *   rep:{ keys:number[], since:number, last:number, n:number, offset?:number }|null }} ActivityCpFile
 * @typedef {{ v:number, config:any, origin:string, idPrefix:string, seq:number, local:Map<string, ActivitySession>,
 *   remote:Map<string, { sessions:Map<string, ActivitySession>, sig:string|null, down_at?:number|null, epoch?:string|null, seq?:number, truncated?:boolean }>,
 *   cpLive:Map<string, [string, string]>, cp:ActivityCpFile|null }} ActivityState
 */

/**
 * A fresh state container (a plain object of Maps; every function here takes it as the first argument).
 * @param {{ config?: any, origin?: string, idPrefix?: string }} [opts]
 * @returns {ActivityState}
 */
export function createActivity({ config, origin = 'local', idPrefix = 'act_' } = {}) {
  return { v: ACTIVITY_FORMAT, config: resolveConfig(config || {}, {}), origin: String(origin || 'local'), idPrefix: String(idPrefix), seq: 0, local: new Map(), remote: new Map(),
    cpLive: new Map(), cp: null }
}

// `persisted`: has a record touching this node reached the JSONL yet (its first one carries new_from)?
// `cp_dirty`: bits of what a log:false message changed since the last persisted record (CP_CUR | CP_PROG | CP_ETA).
// `pt` (6b): when a record last PERSISTED the node's activity / line / bar / ETA (0 = never) — the carry-forward's test.
// `plan` / `plan_ix` (6b): a plan item (remembered for good) and its position in the plan call that made it (a tie-break
// for items created in the same millisecond: children keep CREATION order — created_at, then plan_ix, then key).
const CP_CUR = 1, CP_PROG = 2, CP_ETA = 4
/** @returns {ActivityNode} */
function newNode(path, segs, now) {
  const last = segs.length ? segs[segs.length - 1] : null, key = pathKey(path)
  return { key, path, name: last ? last.name : '', kind: last ? last.kind : 'agent', parent: parentKeyOf(key), depth: segs.length, created_at: now, last_activity: now,
    stale_after_ms: null, current: null, progress: null, eta_at: null, finished_at: null, gone_at: null, implicit: true, log: [], log_dropped: 0, log_floor: 0, persisted: false, cp_dirty: 0,
    plan: false, plan_ix: null, pt: { a: 0, l: 0, p: 0, e: 0 } }
}
/** A new session record with its root node. */
function newSession(key, origin, f, now) {
  const s = { key, origin, realm: f.realm, session: f.session, project: f.project, user: f.user, host: origin, created_at: now, last_activity: now, gone_at: null,
    nodes: new Map(), kids: new Map(), nAgents: 0 }
  s.nodes.set('', newNode('', [], now))   // implicit until a message is OWNED by the session itself (an agents-only session never goes stale)
  return s
}
/** Add a node to a session (its parent need not exist yet: a remote child may arrive first — kids are keyed by parent key). */
function addNode(sess, node) {
  sess.nodes.set(node.key, node)
  if (node.parent != null) { let k = sess.kids.get(node.parent); if (!k) sess.kids.set(node.parent, (k = new Set())); k.add(node.key) }
  if (node.key && node.kind === 'agent') sess.nAgents++
}
/** Every key of `key`'s subtree (itself first, depth-first, kids in insertion order). */
function subtreeKeys(sess, key) {
  const out = [], stack = [key]
  while (stack.length) { const k = stack.pop(); if (!sess.nodes.has(k)) continue; out.push(k); const ks = sess.kids.get(k); if (ks) stack.push(...[...ks].reverse()) }
  return out
}
/** Remove a node and its whole subtree; returns the removed nodes. Never the root. */
function removeSubtree(sess, key) {
  if (!key || !sess.nodes.has(key)) return []
  const keys = subtreeKeys(sess, key), out = []
  for (const k of keys) { const n = sess.nodes.get(k); sess.nodes.delete(k); sess.kids.delete(k); if (n.kind === 'agent') sess.nAgents--; out.push(n) }
  const n0 = out[0], pk = sess.kids.get(n0.parent)
  if (pk) { pk.delete(key); if (!pk.size) sess.kids.delete(n0.parent) }
  return out
}
/** The node chain root → target for segs (missing nodes as null). */
function chainKeys(segs) { const out = ['']; for (let i = 1; i <= segs.length; i++) out.push(pathKey(formatPath(segs.slice(0, i)))); return out }
/** The nearest AGENT at or above a node (the root when none). */
function ownerOf(sess, node) {
  let n = node
  while (n && n.kind !== 'agent') n = sess.nodes.get(n.parent)
  return n || sess.nodes.get('')
}
/** 6b: an OPEN plan item (todo / running / blocked) — never expires, never evicted. */
const isOpenItem = n => !!n && !!n.plan && OPEN_ITEM.has(stateOf(n))
/** 6b: every key that is, or is an ancestor of, an OPEN plan item — a subtree rooted at k holds one iff k is in the set. */
function openPlanKeys(sess) {
  const out = new Set()
  for (const n of sess.nodes.values()) if (isOpenItem(n)) for (let k = n.key; k != null && !out.has(k); k = parentKeyOf(k)) out.add(k)
  return out
}
/**
 * 6b: a node's PLAN = its plan-item children (null when it has none): { items, open, resolvedAt } — resolvedAt = when the
 * last item became done / skipped, once EVERY item is done or skipped (else null).
 */
function planOf(sess, node) {
  const items = childrenOf(sess, node).filter(c => c.plan)
  if (!items.length) return null
  let open = 0, resolvedAt = 0, all = true
  for (const it of items) {
    const s = stateOf(it)
    if (OPEN_ITEM.has(s)) open++
    if (RESOLVED_ITEM.has(s)) resolvedAt = Math.max(resolvedAt, it.current ? it.current.ts : 0); else all = false
  }
  return { items, open, resolvedAt: all ? resolvedAt : null }
}
/**
 * 6b: when a plan ENDED (it expires finished_visible_hours later): its last item became done / skipped, or its owner agent
 * (the plan node itself when it is an agent, else its nearest agent / the session) finished — whichever came first. null
 * while any item is OPEN: an open plan never ends.
 */
function planEndAt(sess, node, p) {
  if (!p || p.open) return null
  const owner = node.kind === 'agent' ? node : ownerOf(sess, node), fin = owner && owner.finished_at ? owner.finished_at : null
  const ends = [p.resolvedAt, fin].filter(x => x != null)
  return ends.length ? Math.min(...ends) : null
}
/**
 * 6b: what removing an ended plan takes — the subtree ROOTS: its items, or the plan node itself (with them) when it is an
 * ordinary context (not the session, not an agent, not itself a plan item) left with nothing but the items and no live line.
 */
function planRemoval(sess, node, p) {
  if (node.key && node.kind === 'context' && !node.plan && childrenOf(sess, node).length === p.items.length && !(node.current && LIVE.has(node.current.state))) return [node.key]
  return p.items.map(i => i.key)
}
/**
 * The subtrees that may be EVICTED for a message to `targetKey` (the hard limits), oldest first: finished agents (6a) and —
 * 6b — ENDED plans whose every item is done / skipped (planRemoval). Never one holding an OPEN plan item (#70 "Decisions
 * before 6b" 3), never one the target is at or under (nor a plan whose node the target is at or under, except the
 * session's own). Each: { at, key, roots:[subtree root keys] }.
 */
function evictionCandidates(sess, targetKey) {
  const open = openPlanKeys(sess), out = []
  for (const n of sess.nodes.values()) {
    if (n.key && n.kind === 'agent' && n.finished_at && !under(targetKey, n.key) && !open.has(n.key)) out.push({ at: n.finished_at, key: n.key, roots: [n.key] })
    const p = planOf(sess, n)
    if (p && p.resolvedAt != null && !p.items.some(i => open.has(i.key)) && !(n.key && under(targetKey, n.key))) {
      const roots = planRemoval(sess, n, p)
      if (!roots.some(r => under(targetKey, r))) out.push({ at: p.resolvedAt, key: n.key, roots })
    }
  }
  return out.sort((a, b) => a.at - b.at || cmp(a.key, b.key))
}
/** The small in-memory log entry of a (logged) message or a JSONL entry — the SAME shape from both (replay equality). */
function smallOf(e) {
  const s = compact({ id: e.id, ts: e.ts, current: !!e.current, text: e.text, state: e.state,
    progress: e.progress || undefined, eta_at: e.eta_at || undefined, stale_after_ms: e.stale_after_ms || undefined,
    has_details: e.has_details ? true : undefined, has_data: e.has_data ? true : undefined })
  if (e.progress === null) s.progress = null   // an explicit "none" is recorded (the replay must see the clear)
  if (e.eta_at === null) s.eta_at = null
  return s
}
/** Insert an entry into a node's log in ORDER (apply order; an earlier-timed report goes where its time puts it). */
function logInsert(node, e) {
  const L = node.log
  let i = L.length
  while (i > 0 && ordCmp(L[i - 1], e) > 0) i--
  L.splice(i, 0, e)
}
function logDropOldest(node) { const e = node.log.shift(); if (e) { node.log_dropped++; if (e.ts > node.log_floor) node.log_floor = e.ts } return e }
/** new_from for the FIRST persisted record touching a node of the chain (and mark the chain persisted). */
function persistMarks(chain) {
  let k = -1
  for (let i = 0; i < chain.length; i++) if (!chain[i].persisted) { k = i; break }
  for (const n of chain) n.persisted = true
  return k >= 0 ? { new_from: k } : {}
}
/** 6b: note what a record persisted — activity for every node of `span` (owner..target), the target's line / bar / ETA. */
function notePersisted(span, tgt, what, ts) {
  for (const n of span) { const p = n.pt || (n.pt = { a: 0, l: 0, p: 0, e: 0 }); if (ts > p.a) p.a = ts }
  const p = tgt.pt || (tgt.pt = { a: 0, l: 0, p: 0, e: 0 })
  if (what.line && ts > p.l) p.l = ts
  if (what.prog && ts > p.p) p.p = ts
  if (what.eta && ts > p.e) p.e = ts
}
/** The record fields of a plan item (6b): the marker + its plan position. */
const planFields = n => (n && n.plan ? { plan_item: true, ...(Number.isInteger(n.plan_ix) ? { plan_ix: n.plan_ix } : {}) } : {})
const cpId = (sKey, nKey) => JSON.stringify([sKey, nKey])
const fullLine = l => (l ? { id: l.id, ts: l.ts, text: l.text, state: l.state, details: l.details || null, data: l.data != null ? l.data : null } : null)

/**
 * Apply one parsed message from a LOCAL session. Atomic: a rejected message changes nothing.
 * - Creates the session and every node the path names (intermediates IMPLICIT). The target and its owner stop being
 *   implicit.
 * - log:true appends a small entry to the TARGET's own log (capped per node, oldest dropped) and returns the full `entry`
 *   for the JSONL; log:false appends nothing (entry:null, logged:false).
 * - `@~` sets the target's current line (+ details/data); done|failed on an AGENT target finishes it, a live state
 *   revives it. Progress / eta from ANY message (ETA dropped while done/failed).
 * - last_activity (and stale_after) on the target and every node up to its OWNER; the session header always.
 * - LIMITS: depth ≤ 6 (parse), ≤ 128 agents and ≤ 4096 nodes per session. A message that would exceed either EVICTS the
 *   oldest finished agents / ended plans (evictionCandidates: each with its whole subtree; never an ancestor of the target,
 *   never an OPEN plan item; reported in `evicted`, their history stays in the JSONL) and is rejected ('too-many-agents' /
 *   'too-many-nodes') only when that can't make room — or when it writes no record (an eviction must reach the JSONL).
 * - A message clears gone_at on the session and on its owner.
 * - 6b: todo / skipped (validated here against the target: 'not-a-plan-item'); a context whose first current line is todo
 *   becomes a plan item; an `@~` line without a state on a ☐ item starts it (running); keepText keeps the line's text. A
 *   `plan` then creates its items under the target, in order, each with its own LOGGED entry (a ☐ line whose text is its
 *   name), whatever `log` says — so a plan always reaches the files. Re-plan: an existing item is kept untouched; an
 *   existing ordinary context with no line of its own is ADOPTED as an item; one with a line is left alone (plan_item:false).
 * @param {ActivityState} state
 * @param {{ session:string, project?:string, user?:string|null, realm?:string, host?:string }} ident  the reporting session
 * @param {ActivityMsg} msg  parseMessage(...).msg
 * @param {number} now
 * @returns {ActivityResult} { ok:true, id, ts, logged, entry, records, current, state, stale_at, path, agent, context,
 *   evicted:string[], warnings:string[], plan? } or { ok:false, code, what } — `records` = every JSONL record this call
 *   wrote, in order (the target's entry first, then each new plan item's)
 */
export function apply(state, ident, msg, now) {
  if (!state || !(state.local instanceof Map)) return bad('bad-state-object', 'pass a createActivity() state')
  if (!state.config.enabled) return bad('activity-disabled', 'the activity board is disabled on this host (activity.enabled)')
  if (!Number.isFinite(now)) return bad('bad-now', 'now must be a ms epoch')
  if (!msg || typeof msg.text !== 'string' || !(msg.text || msg.keepText || msg.planOnly) || !Array.isArray(msg.segs)) return bad('bad-message', 'pass the msg from parseMessage()')
  const logged = msg.log !== false, planOnly = !!msg.planOnly
  const sessName = str(ident && ident.session)
  if (!sessName) return bad('bad-session', 'the reporting session needs a name')
  const L = ACTIVITY_LIMITS
  const sKey = keyOf(state, { realm: ident.realm, project: ident.project, user: ident.user, session: sessName })
  let sess = state.local.get(sKey)
  const segs = msg.segs, keys = chainKeys(segs), tKey = keys[keys.length - 1]
  const tgtKind = segs.length ? segs[segs.length - 1].kind : 'agent', tgt0 = sess ? sess.nodes.get(tKey) : null
  if (!planOnly && msg.state && PLAN_STATES.has(msg.state)) {   // 6b: todo / skipped are plan states
    if (tgtKind === 'agent') return bad('bad-agent-state', `${msg.state} is a plan state — only a context (a plan item) can be ${msg.state}`)
    if (!(tgt0 && tgt0.plan) && (msg.state === 'skipped' || !msg.current || (tgt0 && tgt0.current)))
      return bad('not-a-plan-item', `"${msg.path}" is ${tgt0 && tgt0.current ? 'an ordinary context (it already has a line of its own)' : 'not a plan item'} — ${msg.state} is for plan items: create them with plan:[…] (or a FIRST @~ line with state todo)`)
  }
  // 6b: the plan's items under the target: new (create), an ordinary context with no line of its own (adopt), an item (keep)
  const items = []
  for (const name of msg.plan || []) {
    const seg = { kind: /** @type {'context'} */ ('context'), name }, key = pathKey(formatPath([...segs, seg])), ex = sess ? sess.nodes.get(key) : null
    items.push({ name, seg, key, ex, act: !ex ? 'create' : ex.plan ? 'keep' : !ex.current ? 'adopt' : 'other' })
  }
  const writes = (logged && !planOnly) || items.some(it => it.act === 'create' || it.act === 'adopt')   // does this call write a record?
  // the nodes this message would create, and room for them (simulate evictions first: atomic)
  let newN = 0, newA = 0
  for (let i = 1; i < keys.length; i++) if (!sess || !sess.nodes.has(keys[i])) { newN++; if (segs[i - 1].kind === 'agent') newA++ }
  for (const it of items) if (it.act === 'create') newN++
  const evict = []
  if (sess && newN) {
    let nNodes = sess.nodes.size - 1 + newN, nAg = sess.nAgents + newA
    if (nNodes > L.nodesPerSession || nAg > L.agentsPerSession) {
      const gone = new Set()
      for (const c of evictionCandidates(sess, tKey)) {
        if (nNodes <= L.nodesPerSession && nAg <= L.agentsPerSession) break
        const ks = c.roots.flatMap(r => subtreeKeys(sess, r)).filter(k => !gone.has(k))
        if (!ks.length) continue
        for (const k of ks) { gone.add(k); nNodes--; if (sess.nodes.get(k).kind === 'agent') nAg-- }
        evict.push(c)
      }
      if (nAg > L.agentsPerSession) return bad('too-many-agents', `this session already has ${L.agentsPerSession} agents and none (outside this path, holding no open plan item) has finished (report a done/failed current line when an agent ends)`)
      if (nNodes > L.nodesPerSession) return bad('too-many-nodes', `this session already has ${L.nodesPerSession} nodes and not enough finished agents or ended plans to evict (open plan items are never evicted)`)
      if (!writes) return bad(newA ? 'too-many-agents' : 'too-many-nodes', `this session is at its limit: a NEW node must arrive with a logged message (log:true), which evicts the oldest finished agent(s)`)
    }
  } else if (!sess && (newN > L.nodesPerSession || newA > L.agentsPerSession)) return bad('too-many-nodes', 'too many nodes')
  // ---- every check passed: mutate ----
  if (!sess) {
    sess = newSession(sKey, state.origin, { realm: str(ident.realm) || 'default', session: sessName, project: str(ident.project) || 'unclassified', user: str(ident.user) }, now)
    state.local.set(sKey, sess)
  }
  const evicted = []
  for (const c of evict) for (const r of c.roots) { const n = sess.nodes.get(r); if (n) { removeSubtree(sess, r); evicted.push(n.path) } }
  const chain = [sess.nodes.get('')]
  for (let i = 1; i < keys.length; i++) {
    let n = sess.nodes.get(keys[i])
    if (!n) { n = newNode(childPath(chain[i - 1], segs[i - 1]), segs.slice(0, i), now); addNode(sess, n) }   // the parent's first-seen spelling
    chain.push(n)
  }
  const tgt = chain[chain.length - 1], oi = ownerIndex(segs), owner = chain[oi]
  const cap = state.config.log_entries_per_agent
  const touch = span => {   // a message's activity: target..owner (and the session header); stale_after until each node's next message
    sess.last_activity = Math.max(sess.last_activity, now)   // max(): a report timed earlier than one already applied never moves activity back
    for (const n of span) { n.last_activity = Math.max(n.last_activity, now); n.stale_after_ms = msg.stale_after_ms || null }
    sess.gone_at = null; owner.gone_at = null
  }
  const res = { ok: true, id: null, ts: now, logged: false, entry: null, records: [], current: false, state: stateOf(tgt), stale_at: null, path: tgt.path,
    agent: oi ? owner.path : null, context: tgt.kind === 'context' ? tgt.name : 'root', evicted, warnings: msg.warnings || [] }
  if (!planOnly) {   // ---- the message to the target itself
    tgt.implicit = false; owner.implicit = false
    const before = { cur: tgt.current, prog: JSON.stringify(tgt.progress), eta: tgt.eta_at }
    const c0 = tgt.current
    let entryState = msg.state || (c0 ? c0.state : null) || 'running'
    if (!msg.state && msg.current && tgt.plan && c0 && c0.state === 'todo') entryState = 'running'   // 6b: a line on a ☐ item starts it
    const text = msg.keepText ? (c0 ? c0.text : (tgt.name || entryState)) : msg.text                // 6b: a tick keeps the line's text
    if (msg.current && msg.state === 'todo' && tgt.kind === 'context' && !tgt.plan) tgt.plan = true   // 6b: a first line of todo makes a plan item (validated above)
    const id = `${state.idPrefix}${now.toString(36)}-${(++state.seq).toString(36)}`
    touch(chain.slice(oi))
    let lineId = id
    if (msg.current) {
      // a log:false line IDENTICAL to the current one (text, state, details, data) keeps it — "alive, unchanged" (a rep, not a cp)
      const same = !logged && c0 && c0.text === text && c0.state === entryState && (c0.details || null) === (msg.details || null)
        && JSON.stringify(c0.data != null ? c0.data : null) === JSON.stringify(msg.data != null ? msg.data : null)
      if (same) lineId = c0.id
      else tgt.current = { id, ts: now, text, state: entryState, details: msg.details || null, data: msg.data != null ? msg.data : null,
        data_bytes: msg.data != null ? utf8(JSON.stringify(msg.data)) : 0 }
      if (tgt.kind === 'agent') {
        if (DONE_OR_FAILED.has(entryState)) { if (!tgt.finished_at) tgt.finished_at = now }
        else tgt.finished_at = null
      }
    }
    if ('progress' in msg) tgt.progress = msg.progress ? { ...msg.progress } : null   // ANY message moves the bar
    if ('eta_at' in msg) tgt.eta_at = msg.eta_at || null
    if (DONE_OR_FAILED.has(stateOf(tgt))) tgt.eta_at = null                          // dropped on done/failed, ignored while it is
    Object.assign(res, { id: lineId, logged, current: !!msg.current, state: entryState, stale_at: staleAt(tgt, state.config.stale_after_min, owner) })
    if (!logged) {   // the board only: mark what changed for the next checkpoint, and the node as live this interval
      const bits = (tgt.current !== before.cur ? CP_CUR : 0) | (JSON.stringify(tgt.progress) !== before.prog ? CP_PROG : 0) | (tgt.eta_at !== before.eta ? CP_ETA : 0)
      tgt.cp_dirty = (tgt.cp_dirty || 0) | bits
      state.cpLive.set(cpId(sKey, tKey), [sKey, tKey])
    } else {
      const small = smallOf({ id, ts: now, current: msg.current, text, state: entryState,
        progress: 'progress' in msg ? msg.progress : undefined, eta_at: 'eta_at' in msg ? msg.eta_at : undefined, stale_after_ms: msg.stale_after_ms,
        has_details: !!msg.details, has_data: msg.data != null })
      logInsert(tgt, small)
      while (tgt.log.length > cap) logDropOldest(tgt)
      // this entry persists what it carries: the line (+ its state, and a done/failed line's dropped ETA), the bar, the ETA
      const etaW = 'eta_at' in msg || (msg.current && DONE_OR_FAILED.has(entryState))
      if (tgt.cp_dirty) tgt.cp_dirty &= ~((msg.current ? CP_CUR : 0) | (etaW ? CP_ETA : 0) | ('progress' in msg ? CP_PROG : 0))
      notePersisted(chain.slice(oi), tgt, { line: msg.current, prog: 'progress' in msg, eta: etaW }, now)
      res.entry = { v: ACTIVITY_FORMAT, ...small, current: !!msg.current, path: tgt.path, origin: state.origin, realm: sess.realm, session: sess.session, project: sess.project, user: sess.user, host: sess.host,
        details: msg.details || null, data: msg.data != null ? msg.data : null, ...planFields(tgt), ...persistMarks(chain),
        ...(msg.current && tgt.kind === 'agent' ? { finished_at: tgt.finished_at } : {}) }
      res.records.push(res.entry)
    }
  }
  if (msg.plan) {   // ---- 6b: the plan's items, in the given order (each a LOGGED ☐ line)
    const out = []
    items.forEach((it, ix) => {
      let n = it.ex && sess.nodes.has(it.key) ? it.ex : null
      if (it.act === 'create') { n = newNode(childPath(tgt, it.seg), [...segs, it.seg], now); addNode(sess, n) }
      if (n && (it.act === 'create' || it.act === 'adopt')) {
        const ichain = [...chain, n]
        n.plan = true; n.plan_ix = ix; n.implicit = false; owner.implicit = false
        touch(ichain.slice(oi))
        const id = `${state.idPrefix}${now.toString(36)}-${(++state.seq).toString(36)}`
        n.current = { id, ts: now, text: it.name, state: 'todo', details: null, data: null, data_bytes: 0 }
        const small = smallOf({ id, ts: now, current: true, text: it.name, state: 'todo', stale_after_ms: msg.stale_after_ms })
        logInsert(n, small)
        while (n.log.length > cap) logDropOldest(n)
        notePersisted(ichain.slice(oi), n, { line: true }, now)
        res.records.push({ v: ACTIVITY_FORMAT, ...small, current: true, path: n.path, origin: state.origin, realm: sess.realm, session: sess.session, project: sess.project, user: sess.user, host: sess.host,
          details: null, data: null, ...planFields(n), ...persistMarks(ichain) })
      }
      out.push({ ...compact({ name: n ? n.name : it.name, path: n ? n.path : childPath(tgt, it.seg), created: it.act === 'create', adopted: it.act === 'adopt' }), plan_item: !!(n && n.plan), state: n ? stateOf(n) : null })
    })
    res.plan = out
  }
  if (res.records.length) {
    if (evicted.length) res.records[0].evicted = evicted   // the first record names what made room (the replay marks those paths dead)
    if (state.cp) state.cp.rep = null                      // any other write closes the open repeat line
  }
  return res
}

/**
 * The checkpoint writes due now (the gateway calls this every `progress_checkpoint_sec`, then appends / rewrites them in
 * order). Every NODE with log:false activity since the last call is either CHANGED (its current line, bar or ETA moved
 * since its last persisted record — or it has no key in today's file yet) → one full `cp` line, or UNCHANGED → its key
 * joins this interval's repeat line (rewritten in place while the key set is exactly the same and nothing else was written
 * since). A new local day starts a new file: keys restart at 1 and every live node gets a full cp there.
 * @param {ActivityState} state
 * @param {number} now
 * @returns {{ kind:string, rewrite?:boolean, rec:any }[]}  kind 'cp' | 'rep'
 */
export function planCheckpoints(state, now) {
  const day = localDay(now)
  if (!state.cp || state.cp.day !== day) state.cp = { day, keys: new Map(), next: 1, rep: null }
  const cp = state.cp, writes = [], same = []
  for (const [id, [sKey, nKey]] of [...state.cpLive]) {
    state.cpLive.delete(id)
    const sess = state.local.get(sKey), node = sess && sess.nodes.get(nKey)
    if (!node) continue   // evicted / expired since
    let k = cp.keys.get(id)
    if (node.cp_dirty || k === undefined) {
      if (k === undefined) { k = cp.next++; cp.keys.set(id, k) }
      writes.push({ kind: 'cp', rec: checkpointOf(state, sess, node, now, k) })
      node.cp_dirty = 0
    } else same.push(k)
  }
  if (writes.length || !same.length) cp.rep = null   // a cp line (or an interval with no unchanged-live node) closes it
  if (!same.length) return writes
  same.sort((a, b) => a - b)
  if (cp.rep && cp.rep.keys.join() === same.join()) { cp.rep.n++; cp.rep.last = now; writes.push({ kind: 'rep', rewrite: true, rec: repRecord(cp.rep) }) }
  else { cp.rep = { keys: same, since: now, last: now, n: 1 }; writes.push({ kind: 'rep', rewrite: false, rec: repRecord(cp.rep) }) }
  return writes
}
/**
 * Every dirty node's cp NOW, regardless of the interval (a clean shutdown's flush). By default only the cp lines;
 * `{ withRep: true }` (the tray's prepare-shutdown) returns the whole plan — the repeat line too.
 * @param {ActivityState} state @param {number} now @param {{ withRep?: boolean }} [opts]
 */
export function flushCheckpoints(state, now, opts = {}) {
  for (const s of state.local.values()) for (const n of s.nodes.values()) if (n.cp_dirty) state.cpLive.set(cpId(s.key, n.key), [s.key, n.key])
  const plan = planCheckpoints(state, now)
  return opts && opts.withRep ? plan : plan.filter(w => w.kind === 'cp')
}
const repRecord = r => ({ v: ACTIVITY_FORMAT, rep: r.keys.slice(), n: r.n, since: r.since, last: r.last })
const chainOf = (sess, node) => { const c = []; for (let n = node; n; n = n.parent != null ? sess.nodes.get(n.parent) : null) c.unshift(n); return c }
const lastAgentIx = chain => { let k = 0; chain.forEach((n, i) => { if (n.kind === 'agent') k = i }); return k }
/** One node's full checkpoint line (a snapshot: current line incl. details/data, state, bar, ETA; an agent: finished_at; 6b: the plan-item marker + created_at). */
function checkpointOf(state, sess, node, now, k) {
  const chain = chainOf(sess, node)
  notePersisted(chain.slice(lastAgentIx(chain)), node, { line: true, prog: true, eta: true }, now)
  return { v: ACTIVITY_FORMAT, kind: 'cp', k, ts: now, path: node.path, origin: state.origin, realm: sess.realm || 'default', session: sess.session, project: sess.project, user: sess.user, host: sess.host,
    current: fullLine(node.current), state: stateOf(node), progress: node.progress ? { ...node.progress } : null, eta_at: node.eta_at || null, created_at: node.created_at,
    ...planFields(node), ...(node.kind === 'agent' ? { finished_at: node.finished_at } : {}), ...persistMarks(chain) }
}
/**
 * 6b CARRY-FORWARD (#70 "Decisions before 6b" 4): the `cf` records the gateway writes into the NEW day's file at each local
 * day rollover (and once after a restart's replay when today's file has none yet). One full snapshot of every LONG-LIVED
 * local node: (1) every OPEN plan item and all its ancestors, and (2) every node whose own state — its current line, bar,
 * ETA, or (reported, not implicit) its activity — last reached the files before now − finished_visible_hours + 25 h, i.e.
 * would fall out of the replay window before the next rollover. Parents before children, children in creation order. A
 * `cf` carries the node's line (+ details / data), state, bar, ETA, finished_at, created_at, last_activity,
 * stale_after_ms, implicit and the plan-item marker, so the replay rebuilds a weeks-old open plan from the window alone;
 * older history stays in the older files and pages as before (a cf is never a log entry).
 * @param {ActivityState} state @param {number} now
 * @returns {{ kind:'cf', rec:any }[]}
 */
export function planCarryForward(state, now) {
  const thr = now - Math.max(0, Number(state.config.finished_visible_hours) || 0) * HOUR + 25 * HOUR
  const out = []
  for (const s of [...state.local.values()].sort((a, b) => cmp(a.key, b.key))) {
    const keep = openPlanKeys(s)
    for (const n of s.nodes.values()) if (carryDue(n, thr)) keep.add(n.key)
    if (!keep.size) continue
    for (const k of subtreeKeys(s, '')) if (keep.has(k)) out.push({ kind: /** @type {'cf'} */ ('cf'), rec: carryOf(state, s, s.nodes.get(k), now) })
  }
  if (out.length && state.cp) state.cp.rep = null   // any other write closes the open repeat line
  return out
}
/** Would this node's own state fall out of a replay window that starts at `thr`? (an implicit node has none of its own) */
function carryDue(n, thr) {
  const p = n.pt || { a: 0, l: 0, p: 0, e: 0 }
  return (!!n.current && p.l < thr) || (!!n.progress && p.p < thr) || (!!n.eta_at && p.e < thr) || (!n.implicit && p.a < thr)
}
/** One node's carry-forward record (a full snapshot that also restores created_at / last_activity / implicit). */
function carryOf(state, sess, node, now) {
  const chain = chainOf(sess, node)
  notePersisted([node], node, { line: true, prog: true, eta: true }, now)
  return { v: ACTIVITY_FORMAT, kind: 'cf', ts: now, path: node.path, origin: state.origin, realm: sess.realm || 'default', session: sess.session, project: sess.project, user: sess.user, host: sess.host,
    current: fullLine(node.current), state: stateOf(node), progress: node.progress ? { ...node.progress } : null, eta_at: node.eta_at || null,
    created_at: node.created_at, last_activity: node.last_activity, stale_after_ms: node.stale_after_ms || null, implicit: !!node.implicit,
    ...planFields(node), ...(node.kind === 'agent' ? { finished_at: node.finished_at } : {}), ...persistMarks(chain) }
}

/**
 * Mark a LOCAL session as having left the mesh (its unfinished agents then show as `gone`), or pass `now = null` to clear
 * it (the session is back). A later message from the session clears it for the session + that message's owner anyway.
 * @param {ActivityState} state
 * @param {{ session:string, project?:string, user?:string|null, realm?:string }} ident  (a session record works too)
 * @param {number|null} now
 * @returns {boolean} whether the session is known
 */
export function markSessionGone(state, ident, now) {
  const sess = state.local.get(keyOf(state, ident))
  if (!sess) return false
  const at = Number.isFinite(now) ? now : null
  sess.gone_at = at
  for (const n of sess.nodes.values()) if (n.kind === 'agent') n.gone_at = at
  return true
}

/**
 * Remove LOCAL agents that finished (or went gone) more than `finished_visible_hours` ago — each WITH ITS SUBTREE — and
 * gone sessions past the same window. Their history stays in the daily JSONL. Remote slices are expired by their origin.
 * 6b: nothing holding an OPEN plan item expires (an agent or a gone session that holds one stays — open items never expire
 * while their session exists); an ENDED plan (planEndAt: its last item done / skipped, or its owner finished) expires the
 * same window after it ended — its items go (planRemoval: with the plan node when that is a plain context left empty).
 * @param {ActivityState} state
 * @param {number} now
 * @returns {{ session:string, project:string, agent:string|null, plan?:boolean }[]} what was removed (agent = the node path; null = the whole session)
 */
export function expire(state, now) {
  const hours = state.config.finished_visible_hours, win = Math.max(0, Number(hours) || 0) * HOUR, out = []
  for (const [k, s] of [...state.local]) {
    let open = openPlanKeys(s)
    if (s.gone_at && !visible({ finished_at: null, gone_at: s.gone_at }, now, hours) && !open.size) { state.local.delete(k); out.push({ session: s.session, project: s.project, agent: null }); continue }
    for (const n of [...s.nodes.values()]) if (n.key && n.kind === 'agent' && s.nodes.has(n.key) && !visible(n, now, hours) && !open.has(n.key)) { removeSubtree(s, n.key); out.push({ session: s.session, project: s.project, agent: n.path }) }
    for (const n of [...s.nodes.values()]) {
      if (!s.nodes.has(n.key)) continue
      const p = planOf(s, n), end = planEndAt(s, n, p)
      if (end == null || now - end < win || p.items.some(i => open.has(i.key))) continue
      for (const r of planRemoval(s, n, p)) { const x = s.nodes.get(r); if (x) { removeSubtree(s, r); out.push({ session: s.session, project: s.project, agent: x.path, plan: true }) } }
      open = openPlanKeys(s)
    }
  }
  return out
}

/** A session record, local by default or from a remote origin's slice (the key's host is the origin — ident.host is ignored). */
export function getSession(state, ident, origin) {
  if (!origin || origin === state.origin) return state.local.get(keyOf(state, ident)) || null
  const sl = state.remote.get(origin)
  return (sl && sl.sessions.get(keyOf(state, ident, origin))) || null
}
/** A NODE by path (null / '' = the session root), local by default. The path is canonicalised (case-insensitive). */
export function getNode(state, ident, path, origin) {
  const s = getSession(state, ident, origin)
  if (!s) return null
  if (path == null || path === '') return s.nodes.get('') || null
  const p = parsePath(String(path))
  return p.ok ? s.nodes.get(p.key) || null : null
}
/** Compat alias (pre-6a name): an agent path is a node path. */
export const getEntity = getNode
/** A node's children (in insertion order). */
export function childrenOf(sess, node) { const ks = sess && node ? sess.kids.get(node.key) : null; return ks ? [...ks].map(k => sess.nodes.get(k)).filter(Boolean) : [] }
/** Every session held (local first, then each remote origin), sorted by origin then key. Each has `.origin`. */
export function allSessions(state) {
  const out = [...state.local.values()].sort((a, b) => cmp(a.key, b.key))
  for (const o of [...state.remote.keys()].sort(cmp)) out.push(...[...state.remote.get(o).sessions.values()].sort((a, b) => cmp(a.key, b.key)))
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// derived views (pure; the dashboard's stale slider passes its own staleMin)

/** The reported state of a node (its current line's); else running. */
export function stateOf(item) { return item && item.current ? item.current.state : 'running' }
const isContext = n => !!n && n.kind === 'context'
/**
 * When `item` goes stale. An AGENT (or the root): last_activity + its stale_after override, else staleMin minutes; null
 * when it can't (not running/blocked, finished, implicit). A CONTEXT never goes stale itself: when it has a LIVE current
 * line of its own it shows its owner's stale_at (`owner` = its nearest agent ancestor), else null.
 * @param {any} item @param {number} staleMin @param {any} [owner]  for a context: its nearest agent ancestor
 */
export function staleAt(item, staleMin, owner) {
  if (!item || item.plan) return null   // 6b: a plan item never goes stale, in any state (its owner agent's row shows that agent's)
  if (isContext(item)) return item.current && LIVE.has(item.current.state) && owner && !isContext(owner) ? staleAt(owner, staleMin) : null
  if (item.finished_at || item.implicit) return null
  if (!LIVE.has(stateOf(item))) return null
  const win = item.stale_after_ms > 0 ? item.stale_after_ms : (Number.isFinite(staleMin) && staleMin > 0 ? staleMin : ACTIVITY_DEFAULTS.stale_after_min) * MIN
  return item.last_activity + win
}
/**
 * The state to SHOW. `gone` (the owner agent left; not for done/failed) outranks `stale`; stale = quiet for LONGER than the
 * window (now > stale_at). A context inherits both from `owner` (its nearest agent ancestor). Returns { state, was, stale,
 * gone, stale_at } — `was` is the reported state.
 * @param {any} item @param {number} now @param {number} staleMin @param {any} [owner]
 */
export function effectiveState(item, now, staleMin, owner) {
  const was = stateOf(item)
  if (item && item.plan) return { state: was, was, stale: false, gone: false, stale_at: null }   // 6b: a plan item shows its own state only (never stale, never gone)
  const agent = isContext(item) ? owner : item
  const finished = !!(agent && agent.finished_at)
  const gone = !!(agent && agent.gone_at) && !finished && !DONE_OR_FAILED.has(was)
  if (gone) return { state: 'gone', was, stale: false, gone: true, stale_at: null }
  const at = staleAt(item, staleMin, owner)
  const stale = at !== null && now > at
  return { state: stale ? 'stale' : was, was, stale, gone: false, stale_at: at }
}
/** Percent 0..100 of a progress value. */
export const progressPct = p => (p && p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0)
// ROLLUP strategies, in precedence order after a node's own reported progress (6a; 6b adds the last). Each gets the bars of
// the node's ORDINARY children (every child that is not a plan item, with a bar) and its PLAN ITEMS, and returns a bar or
// null. 6b ("Decisions before 6b"; the build's choice for MIXED children): a plan item counts ONLY as a todo of its parent
// (its own bar — e.g. an agent working under it — shows on its own row, never in the parent's sum / mean), so a plan node
// shows "N of M done" unless it also has ordinary children with bars, which win by 6a's precedence (sum, then mean %).
const rollupStrategies = [
  (bars) => {   // the SUM of the children's bars when they all share a unit (case-insensitive; '' counts, '%' doesn't sum)
    if (!bars.length) return null
    const u = lc(bars[0].unit)
    if (u === '%' || !bars.every(p => lc(p.unit) === u)) return null
    const done = bars.reduce((s, p) => s + p.done, 0), total = bars.reduce((s, p) => s + p.total, 0)
    return { done, total, unit: bars[0].unit, pct: progressPct({ done, total }), rollup: true, n: bars.length, ...(bars.every(p => p.todos) ? { todos: true } : {}) }
  },
  (bars) => { if (!bars.length) return null; const mean = Math.round((bars.reduce((s, p) => s + progressPct(p), 0) / bars.length) * 10) / 10; return { done: mean, total: 100, unit: '%', pct: mean, rollup: true, n: bars.length } },
  (bars, items) => {   // 6b: "N of M done" over the plan items — skipped ones are left out of M (none left → no bar); failed / idle count as not done
    if (!items.length) return null
    let done = 0, skipped = 0
    for (const it of items) { const s = stateOf(it); if (s === 'done') done++; else if (s === 'skipped') skipped++ }
    const total = items.length - skipped
    return total > 0 ? { done, total, unit: 'done', pct: progressPct({ done, total }), rollup: true, todos: true, skipped, n: items.length } : null
  },
]
/**
 * A node's BAR (recursive): its REPORTED progress (rollup:false), else its children rolled up (rollup:true): the sum of its
 * ordinary children's bars when they share a unit, else their mean percent — through any depth — else (6b) "N of M done"
 * over its plan items (`todos:true`, unit "done", `skipped` = how many were left out). null when nothing applies.
 * `memo` (a Map) caches per call when walking a whole board.
 * @param {ActivitySession} sess @param {ActivityNode} node @param {Map<string, any>} [memo]
 * @returns {null | { done:number, total:number, unit:string, pct:number, rollup:boolean, n:number, todos?:boolean, skipped?:number }}
 */
export function rollup(sess, node, memo) {
  if (!sess || !node) return null
  if (memo && memo.has(node.key)) return memo.get(node.key)
  let r = null
  if (node.progress) r = { ...node.progress, pct: progressPct(node.progress), rollup: false, n: 1 }
  else {
    const kids = childrenOf(sess, node).sort((a, b) => cmp(a.key, b.key))
    const bars = kids.filter(c => !c.plan).map(c => rollup(sess, c, memo)).filter(Boolean), items = kids.filter(c => c.plan)
    if (bars.length || items.length) for (const f of rollupStrategies) { r = f(bars, items); if (r) break }
  }
  if (memo) memo.set(node.key, r)
  return r
}
/** An agent not finished and not gone (the dashboard's "Active only" filter). */
export const isActive = node => !!node && !node.finished_at && !node.gone_at
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
// replay: rebuild the local slice from the JSONL, NEWEST FIRST

const finite = v => typeof v === 'number' && Number.isFinite(v)
/**
 * A JSONL record's kind: 'entry' (a logged message), 'cp', 'rep', 'cf' (6b: a carry-forward snapshot) — or null for
 * anything unusable (skipped), INCLUDING a pre-6a v1 record (1.58–1.61: agent/context fields) — never misread as a node
 * record. v2 (1.62) and v3 (1.63) records are both read: v3 only ADDS (todo/skipped states, plan_item, cf).
 */
export function recordKind(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || !RECORD_FORMATS.has(r.v)) return null
  if (Array.isArray(r.rep)) return finite(r.last) && r.rep.every(k => Number.isInteger(k)) ? 'rep' : null
  if (typeof r.session !== 'string' || !r.session.trim() || typeof r.path !== 'string' || !finite(r.ts)) return null
  if (r.kind === 'cp') return Number.isInteger(r.k) ? 'cp' : null
  if (r.kind === 'cf') return 'cf'
  if (r.kind != null) return null
  return typeof r.id === 'string' && typeof r.text === 'string' && r.text && ACTIVITY_STATES.includes(r.state) ? 'entry' : null
}
const wProgress = p => { if (p === null) return null; const r = p && typeof p === 'object' ? parseProgress(p) : null; return r && r.ok ? r.value : undefined }

/**
 * A stateful reverse folder: feed() the host's records NEWEST FIRST (today's file from its end, then earlier days), then
 * finish(). Equivalent to a chronological apply() of the same logged entries (current state AND log contents) — the unit
 * test proves it on seeded random sequences with nested paths — plus the cp/rep records (a cp is a snapshot of one node).
 * - Phase 1 (current state): each node's current line = the newest current-line entry, cp or cf; its bar / ETA = the newest
 *   record carrying them (ETA: a newer plain ETA counts only if the state then was not done/failed); an agent's
 *   finished_at = its newest current line's; last_activity (target..owner) = the max over its records and the `last` of
 *   any rep line that lists its key in the same file. A node stops being looked for once resolved, or once the record that
 *   began its instance (new_from) is passed — which SEALS it with its subtree: any older record whose chain passes through
 *   it is an older instance and is skipped. phase1Complete() = every node seen so far is resolved (publish early).
 * - 6b: a `cf` (carry-forward) record is a full snapshot of its TARGET only: line, bar, ETA, finished_at, the plan-item
 *   marker, implicit, stale_after_ms, and its own created_at / last_activity (not the record's time) — it refreshes no
 *   other node's activity, so a week-old agent carried forward is as stale after a restart as before it. Any record of a
 *   plan item (plan_item:true) marks it one. Each node's created_at = the oldest it is known by (a cf's created_at counts).
 *   Children are rebuilt in CREATION order (created_at, then plan_ix, then the order the records were written, then key).
 * - Phase 2 (history): the newest log_entries_per_agent logged entries per node, chronological; cp/rep/cf never count.
 * - Only records within `finished_visible_hours` of `now` are used ('old' → the caller stops), except an older cp a rep
 *   line of the same file still needs. A node whose instance began before the window gets log_floor = the window start.
 * - A path evicted by an entry (`evicted`) and not seen newer is DEAD: older records under it are skipped.
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
  let maxK = 0, fed = 0, skipped = 0, entries = 0, cps = 0, reps = 0, cfs = 0, cfToday = false, feedNo = 0
  const rNode = (path, segs) => {
    const last = segs.length ? segs[segs.length - 1] : null
    return { key: pathKey(path), path, segs, name: last ? last.name : '', kind: last ? last.kind : 'agent', created: null, cFeed: 0, last: -Infinity, sa: null, saSet: false,
      current: null, curFound: false, progress: null, progFound: false, eta: null, etaRes: false, pend: null, hasPend: false, finAt: null, finRes: false,
      implicit: true, seen: false, sealed: false, marker: false, log: [], total: 0, floor: 0, plan: false, planIx: null, tA: 0, tL: 0, tP: 0, tE: 0, tPend: 0 }
  }
  const resolveEta = (c, v, t) => { c.eta = v; c.etaRes = true; c.tE = t || 0 }
  function sealNode(s, n, marker) {
    for (const x of s.nodes.values()) {
      if (x.sealed || !(x.key === n.key || n.key === '' || x.key.startsWith(n.key + '/'))) continue
      if (!x.etaRes) resolveEta(x, x.hasPend ? x.pend : null, x.hasPend ? x.tPend : 0)
      x.curFound = x.progFound = x.finRes = true; x.sealed = true; if (marker) x.marker = true
    }
  }
  const nodeDone = n => !n.seen || (n.curFound && n.progFound && n.etaRes && (n.kind !== 'agent' || n.finRes))
  /**
   * One record (newest first). `day` = the file it came from (default: its own local day).
   * @returns {'ok'|'skip'|'old'}
   */
  function feed(rec, day) {
    const kind = recordKind(rec)
    if (!kind) { skipped++; return 'skip' }
    feedNo++
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
    const pp = parsePath(rec.path)
    if (!pp.ok || pp.current) { skipped++; return 'skip' }
    if (kind === 'cp') {
      const m = repLast.get(d), r = m && m.get(rec.k)
      if (rec.ts < cutoff && r === undefined) return 'old'
      if (r !== undefined) { repL = r; m.delete(rec.k) }   // a rep line lists the NEAREST older cp with its key (same file): consume
      if (d === today) { const id = cpId(keyOf(state, rec), pp.key); if (!cpKeys.has(id)) cpKeys.set(id, rec.k); maxK = Math.max(maxK, rec.k) }
    } else if (rec.ts < cutoff) return 'old'
    // the key's host is THIS origin whatever the record says — the files are per host (one writer); keyOf ignores rec.host
    const sk = keyOf(state, rec), keys = chainKeys(pp.segs)
    let s = sessions.get(sk)
    if (s) {
      if (keys.some(k => s.dead.has(k))) { skipped++; return 'skip' }   // an evicted older instance
      for (const k of keys) { const n = s.nodes.get(k); if (n && n.sealed) { skipped++; return 'skip' } }   // an older instance of a node on the chain
      let newN = 0, newA = 0
      for (let i = 1; i < keys.length; i++) if (!s.nodes.has(keys[i])) { newN++; if (pp.segs[i - 1].kind === 'agent') newA++ }
      if (s.nodes.size - 1 + newN > ACTIVITY_LIMITS.nodesPerSession || s.nAgents + newA > ACTIVITY_LIMITS.agentsPerSession) { skipped++; return 'skip' }
    }
    // ---- accepted: create what's new ----
    if (!s) {
      s = { key: sk, realm: 'default', session: rec.session, project: 'unclassified', user: null, host: state.origin, created: null, last: -Infinity, nodes: new Map(), dead: new Set(), nAgents: 0 }
      s.nodes.set('', rNode('', [])); sessions.set(sk, s)
    }
    const chain = [s.nodes.get('')]
    for (let i = 1; i < keys.length; i++) {
      let n = s.nodes.get(keys[i])
      if (!n) { const sg = pp.segs.slice(0, i); n = rNode(childPath(chain[i - 1], sg[i - 1]), sg); s.nodes.set(keys[i], n); if (n.kind === 'agent') s.nAgents++ }
      chain.push(n)
    }
    fed++
    // identity spellings: every record carries the canonical (first-seen) one; the OLDEST record's is kept
    s.session = rec.session.trim(); s.project = str(rec.project) || 'unclassified'; s.user = str(rec.user); s.realm = str(rec.realm) || 'default'
    const tgt = chain[chain.length - 1], oi = ownerIndex(pp.segs), isCf = kind === 'cf'
    // a cf restores its TARGET only (its own implicit flag, created_at, last_activity); any other record marks target + owner reported
    if (isCf) { if (rec.implicit !== true) tgt.implicit = false } else { tgt.implicit = false; chain[oi].implicit = false }
    if (rec.plan_item === true) { tgt.plan = true; if (tgt.planIx == null && Number.isInteger(rec.plan_ix)) tgt.planIx = rec.plan_ix }
    const act = isCf ? (finite(rec.last_activity) ? Math.min(rec.last_activity, rec.ts) : rec.ts) : Math.max(rec.ts, repL)
    const cAt = isCf && finite(rec.created_at) ? Math.min(rec.created_at, rec.ts) : rec.ts
    s.last = Math.max(s.last, act)
    for (const n of chain) if (n.created == null || cAt < n.created || (cAt === n.created && feedNo > n.cFeed)) { n.created = cAt; n.cFeed = feedNo }   // the oldest known; on a tie, the earlier-written record
    s.created = s.created == null ? cAt : Math.min(s.created, cAt)
    const lo = isCf ? chain.length - 1 : oi
    for (let i = lo; i < chain.length; i++) { chain[i].seen = true; chain[i].last = Math.max(chain[i].last, act); chain[i].tA = Math.max(chain[i].tA, rec.ts) }   // phase 1 waits only for nodes a record TOUCHED (target..owner), not bare ancestors
    if (kind === 'cp' || isCf) {
      if (kind === 'cp') cps++; else { cfs++; if (d === today) cfToday = true }
      const st = rec.current && ACTIVITY_STATES.includes(rec.current.state) ? rec.current.state : 'running'
      if (!tgt.curFound) { tgt.current = rec.current && typeof rec.current.text === 'string' && rec.current.text ? lineOf(rec.current) : null; tgt.curFound = true; tgt.tL = rec.ts }
      if (!tgt.progFound) { tgt.progress = wProgress(rec.progress) || null; tgt.progFound = true; tgt.tP = rec.ts }
      if (!tgt.etaRes) resolveEta(tgt, tgt.hasPend ? (DONE_OR_FAILED.has(st) ? null : tgt.pend) : (finite(rec.eta_at) ? rec.eta_at : null), tgt.hasPend ? tgt.tPend : rec.ts)
      if (tgt.kind === 'agent' && !tgt.finRes) { tgt.finAt = finite(rec.finished_at) ? rec.finished_at : (DONE_OR_FAILED.has(st) && rec.current ? rec.current.ts : null); tgt.finRes = true }
      if (isCf && !tgt.saSet) { tgt.sa = rec.stale_after_ms > 0 ? rec.stale_after_ms : null; tgt.saSet = true }
    } else {
      entries++
      tgt.total++
      if (tgt.log.length < N) tgt.log.push(smallOf(rec))
      else if (!tgt.floor) tgt.floor = rec.ts   // the newest entry that doesn't fit = the newest one only in the files
      for (let i = oi; i < chain.length; i++) if (!chain[i].saSet) { chain[i].sa = rec.stale_after_ms > 0 ? rec.stale_after_ms : null; chain[i].saSet = true }
      if (!tgt.progFound && 'progress' in rec) { const p = wProgress(rec.progress); if (p !== undefined) { tgt.progress = p; tgt.progFound = true; tgt.tP = rec.ts } }
      if (rec.current && !tgt.curFound) { tgt.current = lineOf(rec); tgt.curFound = true; tgt.tL = rec.ts }
      if (!tgt.etaRes) {   // the newest ETA-bearing record wins, unless the state when it arrived was done/failed
        const hasEta = 'eta_at' in rec
        if (rec.current) {
          if (DONE_OR_FAILED.has(rec.state)) resolveEta(tgt, null, rec.ts)
          else if (tgt.hasPend) resolveEta(tgt, tgt.pend, tgt.tPend)
          else if (hasEta) resolveEta(tgt, finite(rec.eta_at) ? rec.eta_at : null, rec.ts)
        } else if (hasEta && !tgt.hasPend) { tgt.pend = finite(rec.eta_at) ? rec.eta_at : null; tgt.hasPend = true; tgt.tPend = rec.ts }
      }
      if (rec.current && tgt.kind === 'agent' && !tgt.finRes) { tgt.finAt = 'finished_at' in rec ? (finite(rec.finished_at) ? rec.finished_at : null) : (DONE_OR_FAILED.has(rec.state) ? rec.ts : null); tgt.finRes = true }
      if (Array.isArray(rec.evicted)) for (const p of rec.evicted) { const q = parsePath(String(p)); if (q.ok && q.key && !s.nodes.has(q.key)) s.dead.add(q.key) }   // that subtree's older instance ended here
    }
    if (Number.isInteger(rec.new_from) && rec.new_from >= 0 && rec.new_from < chain.length) sealNode(s, chain[rec.new_from], true)
    return 'ok'
  }
  function lineOf(r) {
    const data = r.data != null && typeof r.data === 'object' ? r.data : null
    return { id: String(r.id || ''), ts: finite(r.ts) ? r.ts : 0, text: String(r.text), state: ACTIVITY_STATES.includes(r.state) ? r.state : 'running',
      details: typeof r.details === 'string' && r.details ? r.details : null, data, data_bytes: data != null ? utf8(JSON.stringify(data)) : 0 }
  }
  /** Nodes seen so far whose phase-1 fields are not all resolved yet. */
  function pending() { let n = 0; for (const s of sessions.values()) for (const x of s.nodes.values()) if (!nodeDone(x)) n++; return n }
  /** Does `day`'s file still hold an older cp that an in-window rep line needs? (keep reading it past the window) */
  const wantsOlder = day => { const m = repLast.get(day); return !!(m && m.size) }
  function build(withLogs) {
    const out = new Map()
    for (const s of sessions.values()) {
      const created = s.created
      const sess = newSession(s.key, state.origin, { realm: s.realm, session: s.session, project: s.project, user: s.user }, created)
      sess.last_activity = Math.max(created, s.last)
      sess.nodes.clear()
      // parents before children, and each parent's children in CREATION order (6b: plans keep their given order) — by depth,
      // then created_at, plan_ix, the record order (cFeed: fed later = written earlier) and key
      const ix = r => (r.planIx == null ? -1 : r.planIx)
      const list = [...s.nodes.values()].sort((a, b) => a.segs.length - b.segs.length || a.created - b.created || ix(a) - ix(b) || b.cFeed - a.cFeed || cmp(a.key, b.key))
      for (const r of list) addNode(sess, bNode(r, r.key ? r.created : created, withLogs))
      for (const n of sess.nodes.values()) n.persisted = true
      out.set(s.key, sess)
    }
    state.local = out
    state.cpLive = new Map()
    expire(state, now)
  }
  function bNode(r, created, withLogs) {
    const n = newNode(r.path, r.segs, created)
    n.last_activity = Math.max(created, r.last); n.stale_after_ms = r.sa; n.implicit = r.implicit
    n.current = r.current ? { ...r.current } : null
    n.progress = r.progress ? { ...r.progress } : null
    n.eta_at = r.etaRes ? r.eta : (r.hasPend ? r.pend : null)   // provisional until resolved
    if (DONE_OR_FAILED.has(stateOf(n))) n.eta_at = null
    if (n.kind === 'agent') n.finished_at = r.key === '' && !r.finRes ? null : r.finAt
    if (r.plan && n.kind === 'context') { n.plan = true; n.plan_ix = r.planIx }
    n.pt = { a: r.tA, l: r.tL, p: r.tP, e: r.tE }   // what the window holds: the carry-forward re-checkpoints what would fall out of it
    if (withLogs) {
      n.log = r.log.slice().reverse().sort(ordCmp); n.log_dropped = r.total - n.log.length
      n.log_floor = r.floor || (r.marker ? 0 : (r.total ? cutoff : 0))   // an instance that began before the window: older entries are only in the files
    }
    return n
  }
  return {
    feed, pending, wantsOlder,
    /** true once at least one record was used and every node seen so far has its phase-1 fields */
    phase1Complete: () => fed > 0 && pending() === 0,
    /** Install the phase-1 view (current lines, bars, states; no history) into state.local — early, provisional. */
    publish() { build(false) },
    /** End of input: resolve everything, install current state + history, re-derive today's cp keys. `cf_today` (6b): today's
     * file already holds a carry-forward (else the gateway writes one now). */
    finish() {
      for (const s of sessions.values()) sealNode(s, s.nodes.get(''), false)
      build(true)
      state.cp = cpKeys.size || maxK ? { day: today, keys: new Map(cpKeys), next: maxK + 1, rep: null } : null
      return { fed, skipped, entries, cps, reps, cfs, cf_today: cfToday, sessions: state.local.size }
    },
    stats: () => ({ fed, skipped, entries, cps, reps, cfs, pending: pending() }),
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
 * Render a status-text TEMPLATE. Placeholders: {progress} → "4,812 of 12,000 tiles" ("61%" for a % bar, "3 of 6" without a
 * unit); {pct} → "40%" (floored); {done}, {total}, {unit}; {eta} → "~1h 25m" from eta_at vs now ("now" once due, "?" when
 * there is no ETA). `{{` and `}}` are literal braces. An unknown {word} is left untouched, and so is a bar placeholder
 * with no bar to fill it (or {unit} with no unit).
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
// read views (the `activity` tool; the dashboard builds on the raw form)

// a current line renders against the node's BAR (its reported progress, else its rollup) + ETA
const lineView = (l, p, eta, now) => (l ? compact({ id: l.id, ts: l.ts, text: l.text, rendered: renderText(l.text, p, eta, now), state: l.state,
  has_details: !!(l.details || l.has_details), has_data: !!(l.data != null || l.has_data) }) : null)
const rawLine = l => (l ? compact({ id: l.id, ts: l.ts, text: l.text, state: l.state, has_details: !!(l.details || l.has_details), has_data: !!(l.data != null || l.has_data) }) : null)
/** Is `key` inside `k`'s subtree (or `k` itself)? '' = everything. */
const under = (key, k) => !k || key === k || key.startsWith(k + '/')
/**
 * The MESH board: every session this host holds — its own and each remote origin's slice — GROUPED by realm + project +
 * user + session name across hosts (groupKey). Each group: `self` = the HEADLINE host's ROOT node (6b, #70 "Decisions
 * before 6b" 6: the host that most recently SET a headline — the newest root current line by its time; none has one → the
 * most recently active host), `selves` = every host's root when it spans several (each host's own line), and `nodes` =
 * every non-root node from every host, FLAT, each with its `path`,
 * `kind`, `depth`, `parent` path and `host` (the same path on two hosts = two entries), sorted by path then host.
 * EFFECTIVE state is computed HERE with `staleMin` (default this host's config.stale_after_min): agents by their own
 * activity, contexts by their nearest agent ancestor's. `progress` is the node's BAR (reported or rolled up).
 * @param {ActivityState} state @param {number} now
 * @param {{ project?:string, session?:string, agent?:string, path?:string, host?:string, active_only?:boolean, staleMin?:number, raw?:boolean }} [opts]
 *   path (or the old `agent`) keeps the nodes at that path and under it; host keeps only that host's; active_only drops
 *   finished/gone agents with their subtrees (6b: unless the subtree holds an OPEN plan item) and ENDED plans (every item
 *   done / skipped: the items, and the plan node when it is a plain context with nothing else shown and no live line); raw =
 *   the dashboard form (reported states, raw templates + times, own `progress` + the rolled-up `bar`). 6b: a plan item
 *   carries `plan_item:true` (+ `plan_ix`) and never shows stale or gone.
 */
export function boardView(state, now, opts = {}) {
  const sm = Number(opts.staleMin) > 0 ? Number(opts.staleMin) : state.config.stale_after_min
  const hours = state.config.finished_visible_hours
  const pk = str(opts.project) ? projKey(opts.project) : null, sk = str(opts.session) ? lc(opts.session) : null, hk = str(opts.host) ? lc(opts.host) : null
  let nk = null
  const pf = str(opts.path) || str(opts.agent)
  if (pf) { const p = parsePath(pf); nk = p.ok ? p.key : lc(pf).replace(/^\/+|\/+$/g, '') }
  const raw = !!opts.raw
  // a remote node's log lives on its owner (fetched on demand): its view says so. host_down = its HOST went away
  const nodeView = (s, n, host, local, down, memo) => {
    const owner = ownerOf(s, n), eff = effectiveState(n, now, sm, owner), bar = rollup(s, n, memo)
    const lg = local ? { entries: n.log.length, dropped: n.log_dropped } : { remote: true }
    const isAg = n.kind === 'agent'
    const base = { path: n.path, kind: n.kind, name: n.key ? n.name : null, depth: n.depth, parent: n.key ? (s.nodes.get(n.parent) || { path: n.parent }).path : null, host,
      plan_item: n.plan || null, plan_ix: n.plan && Number.isInteger(n.plan_ix) ? n.plan_ix : null }
    if (raw) return compact({ ...base, key: n.key, parent_key: n.parent, state: !isContext(n) && eff.gone ? 'gone' : eff.was, was: !isContext(n) && eff.gone ? eff.was : null, implicit: n.implicit,
      active: isAg ? isActive(n) : null, host_down: down || null, current: rawLine(n.current), progress: n.progress ? { ...n.progress } : null, bar, eta_at: n.eta_at,
      created_at: n.created_at, last_activity: n.last_activity, finished_at: n.finished_at, gone_at: isAg ? n.gone_at : null, stale_after_ms: n.stale_after_ms, log: lg })
    return compact({ ...base, state: eff.state, was: eff.state !== eff.was ? eff.was : null, stale_at: eff.stale_at, implicit: n.implicit, active: isAg ? isActive(n) : null,
      visible: isAg ? visible(n, now, hours) : null, host_down: down || null, current: lineView(n.current, bar, n.eta_at, now), progress: bar, eta_at: n.eta_at,
      created_at: n.created_at, last_activity: n.last_activity, finished_at: n.finished_at, gone_at: isAg ? n.gone_at : null, stale_after_ms: n.stale_after_ms, log: lg })
  }
  const groups = new Map()   // groupKey -> [{ s, host, local, down }]
  const add = (s, host, local, down) => {
    if (pk && projKey(s.project) !== pk) return
    if (sk && lc(s.session) !== sk) return
    if (hk && lc(host) !== hk) return
    const g = groupKey(s)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push({ s, host, local, down: down || null })
  }
  for (const s of state.local.values()) add(s, state.origin, true, null)
  for (const [o, sl] of state.remote) for (const s of sl.sessions.values()) add(s, o, false, sl.down_at || null)
  const out = []
  for (const g of [...groups.keys()].sort(cmp)) {
    const parts = groups.get(g).sort((a, b) => (a.local !== b.local ? (a.local ? -1 : 1) : cmp(lc(a.host), lc(b.host))))
    let nodes = []
    for (const p of parts) {
      p.memo = new Map()
      const list = [...p.s.nodes.values()].filter(n => n.key).sort((a, b) => a.depth - b.depth || cmp(a.key, b.key))
      const hidden = opts.active_only ? activeHidden(p.s, list) : null
      for (const n of list) {
        if (hidden && hidden.has(n.key)) continue
        if (nk && !under(n.key, nk)) continue
        nodes.push({ n, p })
      }
    }
    if (nk && !nodes.length) continue
    nodes.sort((x, y) => cmp(x.n.key, y.n.key) || cmp(lc(x.p.host), lc(y.p.host)))
    const hosts = [...new Set(parts.map(p => p.host))]
    const lead = parts[0].s, multi = hosts.length > 1
    // the headline (6b): the host that most recently SET one — the newest root current line by its own time (6a picked the most
    // recently ACTIVE host among those with a line, so a host whose agents reported later took the headline from a host that
    // set it later); a tie → the more recently active; no host has a line → the most recently active host
    const lineTs = p => { const r = p.s.nodes.get(''); return r && r.current ? r.current.ts || 0 : -1 }
    const newest = parts.reduce((b, p) => (lineTs(p) > lineTs(b) || (lineTs(p) === lineTs(b) && p.s.last_activity > b.s.last_activity) ? p : b), parts[0])
    const goneAll = parts.every(p => p.s.gone_at)
    const down = parts.filter(p => p.down).map(p => p.host)
    const selfOf = p => nodeView(p.s, p.s.nodes.get(''), p.host, p.local, p.down, p.memo)
    out.push(compact({ session: lead.session, project: lead.project, user: lead.user, realm: lead.realm, host: multi ? null : hosts[0], hosts: multi ? hosts : null, multi_host: multi,
      created_at: Math.min(...parts.map(p => p.s.created_at)), last_activity: Math.max(...parts.map(p => p.s.last_activity)),
      gone_at: goneAll ? Math.max(...parts.map(p => p.s.gone_at)) : null,
      bell: parts.some(p => p.s.bell), hosts_down: down.length ? down : null,
      self: selfOf(newest), selves: multi ? parts.map(selfOf) : null,
      nodes: nodes.map(x => nodeView(x.p.s, x.n, x.p.host, x.p.local, x.p.down, x.p.memo)) }))
  }
  return out
}
/**
 * 6b: the node keys `active_only` hides in one session (list = its non-root nodes, parents before children): a finished /
 * gone agent with its subtree — unless that subtree holds an OPEN plan item (kept, with its ancestors) — and every ENDED
 * plan's items (all done / skipped; the plan node too when it is a plain context with nothing else left shown and no live
 * line of its own).
 */
function activeHidden(sess, list) {
  const open = openPlanKeys(sess), hide = new Set(), ended = new Set()
  for (const n of [sess.nodes.get(''), ...list]) { const p = n && planOf(sess, n); if (p && p.resolvedAt != null) ended.add(n.key) }
  for (const n of list) {
    if (open.has(n.key)) continue
    if (hide.has(n.parent) || (n.kind === 'agent' && !isActive(n)) || (n.plan && ended.has(n.parent))) hide.add(n.key)
  }
  for (const k of ended) {
    const n = sess.nodes.get(k)
    if (!k || !n || n.kind !== 'context' || n.plan || hide.has(k) || open.has(k) || (n.current && LIVE.has(n.current.state))) continue
    if (childrenOf(sess, n).every(c => hide.has(c.key))) hide.add(k)
  }
  return hide
}
/**
 * The DOORBELL flag: mark each LOCAL session whose name (+ project, when the watch names one) a doorbell `listener` on this
 * host's gateway is watching — `bell` rides the session header (gossip + dashboards).
 * @param {ActivityState} state @param {{ name?: string|null, project?: string|null }[]} watches
 * @returns {boolean} whether any session's flag changed
 */
export function setBells(state, watches) {
  const ws = (Array.isArray(watches) ? watches : []).filter(w => w && str(w.name)).map(w => ({ n: lc(w.name.trim()), p: str(w.project) ? projKey(w.project) : null }))
  let changed = false
  for (const s of state.local.values()) {
    const b = ws.some(w => w.n === lc(s.session) && (!w.p || w.p === projKey(s.project)))
    if (!!s.bell !== b) { s.bell = b; changed = true }
  }
  return changed
}
/**
 * DASHBOARD DELTAS: the same shape of diff as the gossip (a per-subscriber published view; only what changed + removals),
 * over the MERGED raw board: one unit per session GROUP (its header + self/selves) and, 6a, one per NODE (group + host +
 * node key; `kind:'node'`, `nkind` = agent|context, `parent_key`). Each unit carries a stable `id`.
 * @param {any[]} board  boardView(state, now, { raw:true }) (canonical project spellings applied by the caller)
 * @returns {Map<string, { json:string, obj:any }>}
 */
export function dashUnits(board) {
  const units = new Map()
  for (const g of Array.isArray(board) ? board : []) {
    const gk = groupKey(g), { nodes, ...hdr } = g
    const gid = JSON.stringify(['s', gk]), go = { id: gid, kind: 'session', key: gk, ...hdr }
    units.set(gid, { json: JSON.stringify(go), obj: go })
    for (const n of nodes || []) {
      const { kind: nkind, ...rest } = n
      const id = JSON.stringify(['n', gk, lc(n.host), n.key]), no = { id, kind: 'node', nkind, group: gk, ...rest }
      units.set(id, { json: JSON.stringify(no), obj: no })
    }
  }
  return units
}
/**
 * One dashboard's next delta against its published view `pub` (id -> json): the changed / new units (`upsert`, sessions
 * before nodes, parents before children) and the ids that left (`remove`). `full` resets the view. `pub` is updated.
 * @param {Map<string, string>} pub @param {Map<string, { json:string, obj:any }>} units @param {{ full?: boolean }} [opts]
 * @returns {{ upsert:any[], remove:string[], empty:boolean }}
 */
export function planDashDelta(pub, units, opts = {}) {
  if (opts && opts.full) pub.clear()
  const upsert = [], remove = []
  for (const [id, u] of units) if (pub.get(id) !== u.json) { upsert.push(u.obj); pub.set(id, u.json) }
  for (const id of [...pub.keys()]) if (!units.has(id)) { remove.push(id); pub.delete(id) }
  upsert.sort((a, b) => (a.kind === b.kind ? (a.depth || 0) - (b.depth || 0) : a.kind === 'session' ? -1 : 1))
  return { upsert, remove, empty: !upsert.length && !remove.length }
}
/**
 * The sessions matching a log query on EVERY host held: [{ host, local, session }] — by name (+ project / user / host
 * when given, case-insensitive). The bridge reads a local one here and fetches a remote one from its owner.
 * @param {ActivityState} state @param {{ session?:string, project?:string, user?:string, host?:string }} q
 */
export function locateSessions(state, q) {
  const sk = q && str(q.session) ? lc(q.session) : null
  if (!sk) return []
  const pk = str(q.project) ? projKey(q.project) : null, uk = str(q.user) ? lc(q.user) : null, hk = str(q.host) ? lc(q.host) : null
  const ok = (s, host) => lc(s.session) === sk && (!pk || projKey(s.project) === pk) && (!uk || lc(s.user) === uk) && (!hk || lc(host) === hk)
  const out = []
  for (const s of [...state.local.values()].sort((a, b) => cmp(a.key, b.key))) if (ok(s, state.origin)) out.push({ host: state.origin, local: true, session: s })
  for (const o of [...state.remote.keys()].sort(cmp)) for (const s of [...state.remote.get(o).sessions.values()].sort((a, b) => cmp(a.key, b.key))) if (ok(s, o)) out.push({ host: o, local: false, session: s })
  return out
}
/** Which host holds the CURRENT line `id`: { host, local } or null. Remote log entries aren't gossiped — pass entry:{id, host}. */
export function locateEntry(state, id) {
  if (typeof id !== 'string' || !id) return null
  const hasIt = s => [...s.nodes.values()].some(n => n.current && n.current.id === id)
  for (const s of state.local.values()) if (hasIt(s)) return { host: state.origin, local: true }
  for (const [o, sl] of state.remote) for (const s of sl.sessions.values()) if (hasIt(s)) return { host: o, local: false }
  return null
}
/** Resolve a log query's NODE address (path / agent / context; `@~` ignored) → { ok, key } . */
export function queryNodeKey(q) {
  const ad = resolveAddress({ path: q && q.path, agent: q && q.agent, context: q && q.context })
  return ad.ok ? { ok: true, key: ad.key, path: ad.path } : ad
}
const relPath = (path, base) => (!base ? path : path === base ? '' : path.slice(base.length + 1))
/**
 * A NODE's log, NEWEST FIRST — 6a: by default the MERGED log of its whole SUBTREE (every node keeps its own log; this is a
 * k-way merge over them, cut by the cursor with a binary search per node), `own:true` for the node's own entries only.
 * The session is found by name (+ project/user when the name alone is ambiguous); the node by path / agent / context
 * (resolveAddress; omitted = the session itself). Each entry carries its node's `path` and `rel` (relative to the
 * queried node; '' = the node itself) and is rendered against the progress / ETA RECORDED on it.
 * PAGED: `cursor` = the id of the last entry of the previous page (its time + sequence decide, so it works for any node
 * and after the entry was dropped); a page holds at most `limit` (≤ log_entries_per_agent, ≤ opts.maxEntries) entries and
 * ~opts.maxBytes of JSON (at least one); `next_cursor` is set while older entries remain.
 * opts.files: the caller pages on into the DAY FILES. The subtree's memory is complete only down to its FLOOR (the max of
 * its nodes' log_floor — the newest entry some node holds only in the files; else the oldest entry in memory): memory
 * serves entries at or above it, then a `files` descriptor { target, from, before, need, bytes, maxBytes } continues below.
 * @param {ActivityState} state
 * @param {{ session:string, project?:string, user?:string, path?:string|null, agent?:string|null, context?:string, own?:boolean, limit?:number, cursor?:string }} q
 * @param {number} [now]
 * @param {{ maxEntries?: number, maxBytes?: number, files?: boolean }} [opts]
 * @returns {ActivityResult}
 */
export function logView(state, q, now = Date.now(), opts = {}) {
  if (!q || typeof q !== 'object' || !str(q.session)) return bad('bad-log-query', 'log needs { session, project?, path?, agent?, context?, own?, limit?, cursor? }')
  const sk = lc(q.session), pk = str(q.project) ? projKey(q.project) : null, uk = str(q.user) ? lc(q.user) : null
  const cands = [...state.local.values()].filter(s => lc(s.session) === sk && (!pk || projKey(s.project) === pk) && (!uk || lc(s.user) === uk))
  if (!cands.length) return bad('unknown-session', `no activity from a session "${q.session}" on this host`)
  if (cands.length > 1) return { ok: false, code: 'ambiguous-session', what: 'several sessions have that name — pass project (and user)', candidates: cands.map(s => ({ session: s.session, project: s.project, user: s.user })) }
  const s = cands[0]
  const qa = queryNodeKey(q); if (!qa.ok) return qa
  const node = s.nodes.get(qa.key)
  if (!node) return bad('unknown-node', `session "${s.session}" has no node "${qa.path}"`)
  const own = !!q.own
  const scope = own ? [node] : subtreeKeys(s, node.key).map(k => s.nodes.get(k))
  const maxE = Number(opts && opts.maxEntries) > 0 ? Math.floor(Number(opts.maxEntries)) : Infinity, maxB = Number(opts && opts.maxBytes) > 0 ? Number(opts.maxBytes) : Infinity
  const lim = Math.max(1, Math.min(Number(q.limit) > 0 ? Math.floor(Number(q.limit)) : 50, state.config.log_entries_per_agent, maxE))
  let total = 0, dropped = 0
  for (const n of scope) { total += n.log.length; dropped += n.log_dropped }
  const head = { ok: true, session: s.session, project: s.project, user: s.user, path: node.path, kind: node.kind, own }
  const target = { realm: s.realm, project: s.project, user: s.user, session: s.session, key: node.key, own }
  const fc = parseFileCursor(q.cursor)
  if (fc) {
    if (!(opts && opts.files)) return bad('bad-cursor', 'that cursor pages the day files, which this reader does not serve')
    return { ...head, entries: [], total, dropped, next_cursor: null, files: { target, from: fc, before: null, need: lim, bytes: 0, maxBytes: maxB } }
  }
  let cur = null   // entries strictly OLDER than this order key
  if (str(q.cursor)) {
    const t = entryTime(q.cursor)
    if (t === null) return bad('bad-cursor', 'cursor must be the next_cursor of a previous page')
    cur = { ts: t, id: q.cursor }
  }
  // the FLOOR: memory is complete for the whole subtree only at or above it (opts.files: the files serve what is below)
  let floor = 0, minOldest = null
  for (const n of scope) { if (n.log_floor > floor) floor = n.log_floor; if (n.log.length && (minOldest === null || n.log[0].ts < minOldest)) minOldest = n.log[0].ts }
  const cutTs = opts && opts.files && floor ? floor : null
  // per node: [lo, hi) = the entries older than the cursor and (files) at/above the floor — a binary search each
  const heads = []
  for (const n of scope) {
    const Lg = n.log
    if (!Lg.length) continue
    let lo = 0, hi = Lg.length
    if (cur) { let a = 0, b = Lg.length; while (a < b) { const m = (a + b) >> 1; if (ordCmp(Lg[m], cur) < 0) a = m + 1; else b = m } hi = a }
    if (cutTs !== null) { let a = 0, b = hi; while (a < b) { const m = (a + b) >> 1; if (Lg[m].ts < cutTs) a = m + 1; else b = m } lo = a }
    if (hi > lo) heads.push({ n, i: hi - 1, lo })
  }
  const entries = []
  let bytes = 0, more = false
  for (;;) {
    let best = null
    for (const h of heads) if (h.i >= h.lo && (!best || ordCmp(h.n.log[h.i], best.n.log[best.i]) > 0)) best = h
    if (!best) break
    if (entries.length >= lim) { more = true; break }
    const e = best.n.log[best.i]
    const x = { ...e, path: best.n.path, rel: relPath(best.n.path, node.path), rendered: renderText(e.text, e.progress, e.eta_at, now) }
    const b = utf8(JSON.stringify(x)) + 1
    if (entries.length && bytes + b > maxB) { more = true; break }
    entries.push(x); bytes += b; best.i--
  }
  const out = /** @type {any} */ ({ ...head, entries, total, dropped, next_cursor: more && entries.length ? entries[entries.length - 1].id : null })
  if (opts && opts.files && !more) {   // memory ran out: older entries are only in the day files
    if (entries.length >= lim || bytes >= maxB) out.next_cursor = entries.length ? entries[entries.length - 1].id : null   // full: the next page starts there
    else {
      let bts = cutTs !== null ? cutTs : minOldest
      if (cur && (bts === null || cur.ts < bts)) bts = cur.ts   // a cursor below the floor (its entry was dropped): the files continue before IT
      const ids = new Set()
      // the memory entries AT that time were all served (on this page or an earlier one) unless it lies below the floor cut — the files skip them
      if (bts !== null && (cutTs === null || bts >= cutTs)) for (const n of scope) for (const e of n.log) if (e.ts === bts) ids.add(e.id)
      if (cur) ids.add(cur.id)
      out.files = { target, from: null, before: bts !== null ? { ts: bts, ids } : null, need: lim - entries.length, bytes, maxBytes: maxB }
    }
  }
  return out
}
/** A day-file paging cursor: `f1.<day>.<offset>` = continue with the records BEFORE that byte offset of that day's file. */
export const fileCursor = (day, offset) => `f1.${day}.${Math.max(0, Math.floor(Number(offset) || 0))}`
/** @returns {{ day:string, offset:number } | null} */
export function parseFileCursor(c) {
  const m = typeof c === 'string' && c.match(/^f1\.(\d{4}-\d{2}-\d{2})\.(\d{1,15})$/)
  return m ? { day: m[1], offset: Number(m[2]) } : null
}
/**
 * Is this day-file record a LOGGED v2 entry of `target` (logView's files.target: realm + project + user + session + the
 * node key + own)? It matches the node itself or (own:false) anything under it. cp / rep / v1 lines never match.
 */
export function fileEntryMatches(rec, target) {
  if (recordKind(rec) !== 'entry' || !target) return false
  if (lc(rec.session) !== lc(target.session) || projKey(rec.project) !== projKey(target.project) || lc(rec.user) !== lc(target.user)) return false
  if ((lc(rec.realm) || 'default') !== (lc(target.realm) || 'default')) return false
  const k = pathKey(rec.path), t = target.key || ''
  return target.own ? k === t : under(k, t)
}
/** A day-file entry in logView's entry shape (the small in-memory form + path, rel and `rendered` as recorded). */
export const fileEntryView = (rec, now, basePath = '') => ({ ...smallOf(rec), path: rec.path, rel: relPath(rec.path, basePath), rendered: renderText(rec.text, rec.progress, rec.eta_at, now) })
/**
 * An entry by id from MEMORY: a current line (with its details/data; `rendered` against the live bar) or a log entry
 * (flags only — the caller reads details/data back from the JSONL; `rendered` as recorded). null when not held.
 * @param {ActivityState} state @param {string} id @param {number} [now]
 * @returns {null | { where:string, complete:boolean, entry:any }}  where 'current' | 'log'
 */
export function findEntry(state, id, now = Date.now()) {
  if (typeof id !== 'string' || !id) return null
  let hit = null
  for (const s of state.local.values()) {
    const who = { session: s.session, project: s.project, user: s.user, realm: s.realm, host: s.host }
    for (const n of s.nodes.values()) {
      if (n.current && n.current.id === id) {
        const l = n.current
        const r = renderText(l.text, rollup(s, n), n.eta_at, now)
        return { where: 'current', complete: true, entry: { id: l.id, ts: l.ts, ...who, path: n.path, kind: n.kind, current: true, text: l.text, rendered: r, state: l.state, details: l.details || null, data: l.data != null ? l.data : null } }
      }
      if (!hit) { const x = n.log.find(y => y.id === id); if (x) hit = { where: 'log', complete: !x.has_details && !x.has_data, entry: { ...x, ...who, path: n.path, kind: n.kind, current: !!x.current, rendered: renderText(x.text, x.progress, x.eta_at, now), details: null, data: null } } }
    }
  }
  return hit
}

// ---------------------------------------------------------------------------------------------------------------
// gossip: snapshot + per-origin merge (FORMAT v2: one unit per node)

function snapLine(l) {
  return l ? compact({ id: l.id, ts: l.ts, text: l.text, state: l.state, has_details: !!(l.details || l.has_details), has_data: !!(l.data != null || l.has_data) }) : null
}
/** A node's replicated form: its OWN fields (never children, rollup, log, details/data). 6b: + plan_item / plan_ix. */
function snapNode(n) {
  return compact({ path: n.path, created_at: n.created_at, last_activity: n.last_activity, finished_at: n.finished_at, gone_at: n.kind === 'agent' ? n.gone_at : null,
    stale_after_ms: n.stale_after_ms, implicit: n.implicit, progress: n.progress ? { done: n.progress.done, total: n.progress.total, unit: n.progress.unit } : null,
    eta_at: n.eta_at, current: snapLine(n.current), plan_item: !!n.plan, plan_ix: n.plan && Number.isInteger(n.plan_ix) ? n.plan_ix : null })
}
const sortedNodes = s => [...s.nodes.values()].sort((a, b) => cmp(a.key, b.key))
function snapSession(s) {
  return compact({ session: s.session, project: s.project, user: s.user, realm: s.realm, host: s.host, created_at: s.created_at, last_activity: s.last_activity,
    gone_at: s.gone_at, bell: !!s.bell, nodes: sortedNodes(s).map(snapNode) })
}
/**
 * The compact replicated form of one origin's slice (default: ours): every node's own fields (current lines with
 * has_details/has_data flags, never the details/data; no log), sessions + nodes sorted by key, null/false fields omitted —
 * equal state serialises identically. Format v2.
 * @param {ActivityState} state
 * @param {(s: ActivitySession) => boolean} [sessionFilter]
 * @param {string} [origin]  a remote origin re-gossips that origin's slice verbatim
 * @returns {{ v:number, origin:string, sessions:any[] }}
 */
export function snapshot(state, sessionFilter, origin) {
  const o = origin || state.origin
  const src = o === state.origin ? state.local : (state.remote.get(o) || { sessions: new Map() }).sessions
  const list = [...src.values()].filter(s => !sessionFilter || sessionFilter(s)).sort((a, b) => cmp(a.key, b.key))
  return { v: ACTIVITY_FORMAT, origin: o, sessions: list.map(snapSession) }
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
/** A node from the wire (validated path → canonical key), or null. */
function wNode(r) {
  if (!r || typeof r !== 'object') return null
  const p = parsePath(typeof r.path === 'string' ? r.path : '')
  if (!p.ok || p.current) return null
  const n = newNode(p.path, p.segs, wTime(r.created_at) || 0)
  n.last_activity = wTime(r.last_activity) || 0
  n.stale_after_ms = wPos(r.stale_after_ms) ? Math.min(wPos(r.stale_after_ms), ACTIVITY_LIMITS.staleAfterMaxMs) : null
  n.implicit = r.implicit === true
  const pr = r.progress ? parseProgress(r.progress) : null
  n.progress = pr && pr.ok ? pr.value : null
  n.eta_at = wPos(r.eta_at)
  n.current = wLine(r.current)
  if (n.kind === 'agent') {
    n.finished_at = wPos(r.finished_at); n.gone_at = wPos(r.gone_at)
    if (n.current && PLAN_STATES.has(n.current.state)) n.current.state = 'running'   // 6b: an agent can't be todo / skipped
  } else if (r.plan_item === true) { n.plan = true; n.plan_ix = Number.isInteger(r.plan_ix) && r.plan_ix >= 0 && r.plan_ix < ACTIVITY_LIMITS.planItems ? r.plan_ix : null }
  n.persisted = true
  return n
}
/** Put a wire node into a session (REPLACING one held at its key); false when over the limits. */
function wPut(s, n) {
  const old = s.nodes.get(n.key)
  if (old) {
    if (old.kind === 'agent' && n.key) s.nAgents--
    s.nodes.delete(n.key)
  } else if (n.key && (s.nodes.size - (s.nodes.has('') ? 1 : 0) >= ACTIVITY_LIMITS.nodesPerSession || (n.kind === 'agent' && s.nAgents >= ACTIVITY_LIMITS.agentsPerSession))) return false
  addNode(s, n)
  return true
}
// a session record's header from the wire; host = the ORIGIN (the link's host — never the record's `host` field)
function wHeader(r, origin) {
  if (!r || typeof r !== 'object') return null
  const session = str(r.session)
  if (!session) return null
  const project = str(r.project) || 'unclassified'
  const realm = str(r.realm) || 'default', user = str(r.user)
  return { key: sessionKey({ realm, project, user, session, host: origin }), origin, realm, session, project, user, host: origin, created_at: wTime(r.created_at) || 0,
    last_activity: wTime(r.last_activity) || 0, gone_at: wPos(r.gone_at), bell: r.bell === true }
}
function wSession(r, origin) {
  const h = wHeader(r, origin)
  if (!h) return null
  const s = { ...h, nodes: new Map(), kids: new Map(), nAgents: 0 }
  for (const x of Array.isArray(r.nodes) ? r.nodes : []) {
    const n = wNode(x)
    if (!n || s.nodes.has(n.key)) continue
    wPut(s, n)
  }
  if (!s.nodes.has('')) addNode(s, newNode('', [], h.created_at))
  return s
}
const badVersion = v => bad('bad-version', `activity slice format v${v == null ? '?' : v}; this bridge speaks v${ACTIVITY_FORMAT} (a 1.62 or older peer — upgrade it)`)
/**
 * Fold a remote host's snapshot in. PER-ORIGIN OWNERSHIP: the slice REPLACES everything held for `fromOrigin`; no other
 * origin's slice is touched, and our own origin is refused. Re-validated against the same limits. Idempotent. A slice
 * held while its origin was marked DOWN is always replaced (changed:true). A snapshot whose `v` isn't 2 → 'bad-version'.
 * @param {ActivityState} state
 * @param {string} fromOrigin  the host that OWNS the slice (the link it arrived on decides, not the snapshot's field)
 * @param {any} snap  a snapshot() from that host
 * @param {{ epoch?: any, seq?: number, truncated?: boolean }} [meta]
 * @returns {ActivityResult} { ok:true, changed:boolean, sessions:number } or { ok:false, code, what }
 */
export function mergeSnapshot(state, fromOrigin, snap, meta = {}) {
  const origin = typeof fromOrigin === 'string' ? fromOrigin.trim() : ''
  if (!origin) return bad('bad-origin', 'mergeSnapshot needs the owning origin')
  if (lc(origin) === lc(state.origin)) return bad('own-origin', 'a remote snapshot may not replace this host\'s own slice')
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.sessions)) return bad('bad-snapshot', 'expected { v, origin, sessions:[...] }')
  if (snap.v !== ACTIVITY_FORMAT) return badVersion(snap.v)
  const sessions = new Map()
  for (const r of snap.sessions) {
    if (sessions.size >= MAX_SESSIONS_PER_ORIGIN) break
    const s = wSession(r, origin)
    if (s && !sessions.has(s.key)) sessions.set(s.key, s)
  }
  const sig = JSON.stringify([...sessions.values()].sort((a, b) => cmp(a.key, b.key)).map(snapSession))
  const pos = { epoch: meta && meta.epoch != null ? String(meta.epoch) : null, seq: meta && Number.isFinite(Number(meta.seq)) ? Number(meta.seq) : 0, truncated: !!(meta && meta.truncated) }
  const held = state.remote.get(origin)
  if (held && held.sig === sig && !held.down_at) { Object.assign(held, pos); return { ok: true, changed: false, sessions: sessions.size } }
  state.remote.set(origin, { sessions, sig, down_at: null, ...pos })
  return { ok: true, changed: true, sessions: sessions.size }
}
/** Forget a remote origin's slice (the host left the mesh). Returns whether one was held. */
export const dropOrigin = (state, origin) => state.remote.delete(origin)

// ---- the wire — per-link deltas under a byte cap, newest-active first (one unit per NODE)

const sessHeader = s => compact({ session: s.session, project: s.project, user: s.user, realm: s.realm, host: s.host, created_at: s.created_at, last_activity: s.last_activity, gone_at: s.gone_at,
  bell: !!s.bell })
/**
 * This host's gossip UNITS: one per NODE, keyed `[sessionKey, nodeKey]`, with its canonical JSON (snapshot form) and
 * last_activity, plus each session's header. Compute once per change and reuse for every link (planSlice opts.units).
 * @param {ActivityState} state
 * @returns {{ sessions: Map<string, any>, ents: Map<string, any> }}
 */
export function gossipUnits(state) {
  const sessions = new Map(), ents = new Map()
  for (const s of state.local.values()) {
    const hdr = sessHeader(s)
    sessions.set(s.key, { sk: s.key, hdr, hj: JSON.stringify(hdr), id: { realm: s.realm, project: s.project, user: s.user, session: s.session }, last: s.last_activity })
    for (const n of s.nodes.values()) {
      const ent = snapNode(n), uk = JSON.stringify([s.key, n.key])
      ents.set(uk, { uk, sk: s.key, path: n.path, key: n.key, ent, json: JSON.stringify(ent), last: n.last_activity })
    }
  }
  return { sessions, ents }
}
/** A link's published view — what it was last sent: hdrs sk -> { hj, id }, ents uk -> { json, sk, path }. */
export const createPub = () => ({ hdrs: new Map(), ents: new Map() })
/**
 * The next frame body for ONE link: a FULL slice (`full:true`) or a DELTA against the link's `pub` — the changed / new
 * nodes (each inside its session record: the header + `nodes:[…]`) and `remove:[{realm, project, user, session[, path]}]`
 * (no path = the whole session; a node removal removes its subtree on the receiver). Nodes go NEWEST-ACTIVE FIRST until
 * `maxBytes` of JSON; the first always goes. What didn't fit stays unpublished, so the NEXT frame carries it
 * (`truncated:true` / pending:true). Returns { body:null } when a delta has nothing to say.
 * @param {ActivityState} state
 * @param {{ hdrs: Map<string, any>, ents: Map<string, any> }} pub
 * @param {{ full?: boolean, maxBytes?: number, units?: { sessions: Map<string, any>, ents: Map<string, any> } }} [opts]
 * @returns {{ body: any, pending: boolean, entities: number, bytes: number }}
 */
export function planSlice(state, pub, opts = {}) {
  const u = opts.units || gossipUnits(state), full = !!opts.full
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : Infinity
  if (full) { pub.hdrs.clear(); pub.ents.clear() }
  const remove = []
  if (!full) {
    const gone = new Set()
    for (const [sk, h] of pub.hdrs) if (!u.sessions.has(sk)) { remove.push({ ...h.id }); pub.hdrs.delete(sk); gone.add(sk) }
    for (const [uk, e] of pub.ents) {
      if (gone.has(e.sk)) { pub.ents.delete(uk); continue }
      if (!u.ents.has(uk)) { const h = pub.hdrs.get(e.sk); if (h && e.path) remove.push({ ...h.id, path: e.path }); pub.ents.delete(uk) }
    }
  }
  const cand = [], withEnt = new Set()
  for (const x of u.ents.values()) { const p = pub.ents.get(x.uk); if (!p || p.json !== x.json) { cand.push(x); withEnt.add(x.sk) } }
  for (const s of u.sessions.values()) { const p = pub.hdrs.get(s.sk); if ((!p || p.hj !== s.hj) && !withEnt.has(s.sk)) cand.push({ sk: s.sk, uk: JSON.stringify([s.sk]), hdrOnly: true, last: s.last }) }
  cand.sort((a, b) => b.last - a.last || cmp(a.uk, b.uk))
  const out = new Map()
  let bytes = 64 + (remove.length ? utf8(JSON.stringify(remove)) : 0), n = 0, pending = false
  for (const c of cand) {
    const s = u.sessions.get(c.sk), rec = out.get(c.sk)
    const add = (rec ? 0 : utf8(s.hj) + 16) + (c.hdrOnly ? 0 : utf8(c.json) + 2)
    if ((n || out.size) && bytes + add > maxBytes) { pending = true; break }
    let r = rec
    if (!r) { r = { ...s.hdr }; out.set(c.sk, r); pub.hdrs.set(c.sk, { hj: s.hj, id: s.id }) }
    if (!c.hdrOnly) { (r.nodes || (r.nodes = [])).push(c.ent); pub.ents.set(c.uk, { json: c.json, sk: c.sk, path: c.path }); n++ }
    bytes += add
  }
  if (!full && !out.size && !remove.length) return { body: null, pending: false, entities: 0, bytes: 0 }
  const body = /** @type {any} */ (full ? { v: ACTIVITY_FORMAT, full: true, sessions: [...out.values()] } : { v: ACTIVITY_FORMAT, sessions: [...out.values()], ...(remove.length ? { remove } : {}) })
  if (pending) body.truncated = true
  return { body, pending, entities: n, bytes }
}
/**
 * Fold one wire frame body from `fromOrigin` (the link's host). A body whose `v` isn't 2 is refused 'bad-version' (a
 * 1.61 peer's slice is skipped, never misread). A FULL body replaces the origin's slice (mergeSnapshot) and records its
 * (epoch, seq). A DELTA applies only on top of exactly the held position — else 'out-of-sync'. Removals first (a node
 * removal takes its subtree), then each session record: a new session is created, an existing one gets its header and
 * each listed node REPLACED (a new node beyond the limits is dropped). Everything is re-validated.
 * @param {ActivityState} state @param {string} fromOrigin @param {any} body
 * @returns {ActivityResult} { ok:true, changed, full, sessions } or { ok:false, code, what }
 */
export function applySlice(state, fromOrigin, body) {
  const origin = typeof fromOrigin === 'string' ? fromOrigin.trim() : ''
  if (!origin) return bad('bad-origin', 'applySlice needs the owning origin')
  if (lc(origin) === lc(state.origin)) return bad('own-origin', 'a remote slice may not touch this host\'s own entities')
  if (!body || typeof body !== 'object' || (body.sessions != null && !Array.isArray(body.sessions)) || (body.remove != null && !Array.isArray(body.remove))) return bad('bad-slice', 'expected { v:2, full?, epoch, seq, base?, sessions:[…], remove?:[…] }')
  if (body.v !== ACTIVITY_FORMAT) return badVersion(body.v)
  if (body.full) {
    const r = mergeSnapshot(state, origin, { v: ACTIVITY_FORMAT, sessions: body.sessions || [] }, { epoch: body.epoch, seq: body.seq, truncated: body.truncated })
    return r.ok ? { ...r, full: true } : r
  }
  const held = state.remote.get(origin)
  const epoch = body.epoch != null ? String(body.epoch) : null
  if (!held || held.down_at || held.epoch !== epoch || held.seq !== Number(body.base)) return bad('out-of-sync', 'this delta does not follow the held slice — ask for a full one')
  let changed = false
  for (const r of body.remove || []) {
    const h = wHeader(r, origin)
    if (!h) continue
    const s = held.sessions.get(h.key)
    if (!s) continue
    if (r.path == null || r.path === '') { if (r.path == null) { held.sessions.delete(h.key); changed = true } continue }
    const p = parsePath(String(r.path))
    if (p.ok && p.key && s.nodes.has(p.key)) { removeSubtree(s, p.key); changed = true }
  }
  for (const r of body.sessions || []) {
    const h = wHeader(r, origin)
    if (!h) continue
    const s = held.sessions.get(h.key)
    if (!s) {
      if (held.sessions.size >= MAX_SESSIONS_PER_ORIGIN) continue
      held.sessions.set(h.key, wSession(r, origin)); changed = true; continue
    }
    s.created_at = h.created_at; s.last_activity = h.last_activity; s.gone_at = h.gone_at; s.bell = h.bell
    for (const x of Array.isArray(r.nodes) ? r.nodes : []) { const n = wNode(x); if (n) wPut(s, n) }
    changed = true
  }
  held.seq = Number.isFinite(Number(body.seq)) ? Number(body.seq) : held.seq
  held.truncated = !!body.truncated
  if (changed) held.sig = null   // the canonical signature is a full slice's; the next full re-merges
  return { ok: true, changed, full: false, sessions: held.sessions.size }
}
/**
 * The origin went down or became unreachable: every session and AGENT node of its slice not already gone is marked gone
 * at `now` (contexts show their agent's). Kept until a fresh full slice replaces it (which clears the marks) or
 * expireRemote() drops it. Returns whether a slice was held.
 * @param {ActivityState} state @param {string} origin @param {number} now
 */
export function markOriginDown(state, origin, now) {
  const sl = state.remote.get(origin)
  if (!sl) return false
  if (sl.down_at) return true
  const at = Number.isFinite(now) ? now : Date.now()
  sl.down_at = at
  for (const s of sl.sessions.values()) {
    if (!s.gone_at) s.gone_at = at
    for (const n of s.nodes.values()) if (n.kind === 'agent' && !n.gone_at) n.gone_at = at
  }
  return true
}
/** Drop remote slices that have been DOWN longer than finished_visible_hours. Returns the origins dropped. */
export function expireRemote(state, now) {
  const win = Math.max(0, Number(state.config.finished_visible_hours) || 0) * HOUR, out = []
  for (const [o, sl] of [...state.remote]) if (sl.down_at && now - sl.down_at >= win) { state.remote.delete(o); out.push(o) }
  return out
}
/** One line per remote origin held: { host, sessions, seq, down_at?, truncated? } (sorted by host). */
export function remoteInfo(state) {
  return [...state.remote.keys()].sort(cmp).map(o => { const sl = state.remote.get(o); return compact({ host: o, sessions: sl.sessions.size, seq: sl.seq || 0, down_at: sl.down_at || null, truncated: !!sl.truncated }) })
}

// ---------------------------------------------------------------------------------------------------------------
// memory budget (an ESTIMATE of V8 heap use: strings at 2 bytes/char + fixed per-object/Map-entry overheads)

const OBJ = 64, MAPE = 48, NUMS = 48
const sB = s => (typeof s === 'string' ? 16 + 2 * s.length : 0)
const progB = p => (p ? OBJ + sB(p.unit) + 16 : 0)
const lineB = l => (l ? OBJ + sB(l.id) + sB(l.text) + sB(l.state) + 16 + (l.details ? sB(l.details) : 0) + (l.data != null ? OBJ + 2 * (l.data_bytes || 0) : 0) : 0)
const entryB = e => 16 + OBJ + sB(e.id) + sB(e.text) + sB(e.state) + NUMS + progB(e.progress)
function nodeB(n) {
  let b = OBJ + 2 * MAPE + sB(n.path) + sB(n.key) + sB(n.name) + sB(n.parent) + NUMS + lineB(n.current) + progB(n.progress)
  for (const x of n.log) b += entryB(x)
  return b
}
function sessionB(s) {
  let n = OBJ + MAPE + sB(s.key) + sB(s.session) + sB(s.project) + sB(s.user) + sB(s.host) + NUMS
  for (const x of s.nodes.values()) n += nodeB(x)
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
 * Bring the state under `budgetBytes` (default config.memory_budget_mb). Evicts, in order: (1) the oldest FINISHED local
 * agents (by finished_at) — each WITH ITS SUBTREE — and (6b) ENDED plans (by when they ended; evictionCandidates), never a
 * subtree holding an OPEN plan item; then (2) the oldest log entries across every local node (each node's log drops from
 * its front; its log_floor moves up). Never a current line, never an unfinished agent, never a session's root, never a
 * remote slice. May still be over (over:true) when current lines alone exceed the budget.
 * @param {ActivityState} state
 * @param {number} [budgetBytes]
 * @returns {{ evicted:{session:string, project:string, agent:string}[], entries_dropped:number, bytes_before:number, bytes_after:number, over:boolean }}
 */
export function enforceBudget(state, budgetBytes) {
  const budget = Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : state.config.memory_budget_mb * MB
  const before = estimateBytes(state)
  let bytes = before, dropped = 0
  const evicted = []
  if (bytes > budget) {   // 6b: the same candidates as the hard limits — finished agents + ended plans, never an OPEN plan item
    const cand = []
    for (const s of state.local.values()) for (const c of evictionCandidates(s, '\u0000')) cand.push({ s, c })
    cand.sort((x, y) => x.c.at - y.c.at || cmp(x.s.key, y.s.key) || cmp(x.c.key, y.c.key))
    for (const { s, c } of cand) {
      if (bytes <= budget) break
      for (const r of c.roots) {
        const n = s.nodes.get(r)
        if (!n) continue   // went with an evicted ancestor
        for (const x of removeSubtree(s, r)) bytes -= nodeB(x)
        evicted.push({ session: s.session, project: s.project, agent: n.path })
      }
    }
  }
  if (bytes > budget) {
    const all = []
    for (const s of state.local.values()) for (const n of s.nodes.values()) n.log.forEach((e, i) => all.push({ ts: e.ts, i, n }))
    all.sort((x, y) => x.ts - y.ts || x.i - y.i)
    for (const { n } of all) {
      if (bytes <= budget) break
      const e = logDropOldest(n)
      if (!e) continue
      dropped++
      bytes -= entryB(e)
    }
  }
  const after = estimateBytes(state)
  return { evicted, entries_dropped: dropped, bytes_before: before, bytes_after: after, over: after > budget }
}
