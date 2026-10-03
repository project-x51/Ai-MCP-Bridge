// #70 agent activity board — the SHARED PRIMITIVES of the 2.0 board (#88). Pure: no I/O, no timers, no clock (every function
// that needs the time takes `now`). Until v1.75.1 this module was the whole 1.7x board (the path-keyed model, its replay,
// gossip v5, the dashboard units, the memory budget); #88 build step 11 (docs/spec-88.md §8) DELETED that model. What is
// left is used by the 2.0 model (lib/activity2.js) and its store, gossip, dashboard units and files (lib/activity2-*.js),
// the view state (lib/view-state.js), the bridge and the scripts:
// - the locked LIMITS, the reportable STATES and the per-host CONFIG (the `activity` block: resolveConfig);
// - attribution (normBy / byText), QUESTIONS (#85 / #90: normQuestion, questionView, the answer entry's text and details);
// - session keys (sessionKey / groupKey), the local DAY (localDay — the day files' names), an entry id's time (entryTime);
// - ORDER (#82: fractional ranks — rankOf, derivedRank, rankBetween, rankGroup, siblingCmp);
// - parsing durations, PROGRESS and ETAs; the NOTICE verbs and message limits;
// - the IDENTITY PRIMITIVES (build step 1; spec §1, §3, §4.0): mintId / legacyId (stable node ids), validKey / slugKey /
//   uniqueKey (keys), normLabel / labelKey (labels), parseRef / parsePath2 / formatPath2 (references and `@`-free paths) and
//   parseText (the leading-`@` rule) — with the §4.5 legacy-form DETECTOR (a 1.7x `@` path or `@~` marker is refused,
//   naming the 2.0 form): the only `@` / `@~` parsing left outside lib/activity-v5.js;
// - the derived views the 2.0 rows share (stateOf, progressPct, forceBar) and the text placeholders (renderText, fmtEta).
// The 1.7x (v5) RECORD READERS the migration needs (recordKind, the 1.7x path parser) live in lib/activity-v5.js.
// DEPTH2 (Q11b: hard 32, warning past 20) is the 2.0 depth; ACTIVITY_LIMITS.depth (6) is 1.7x's, kept for those readers.
import { createHash } from 'node:crypto'
import { lc, projKey } from './keys.js'

/** The locked #70 limits (6a: depth/nodes replace "agent path depth 3" + "32 contexts per agent"). text/context in code
 * points; details/data/batch in UTF-8 bytes. */
export const ACTIVITY_LIMITS = Object.freeze({
  text: 240,                        // message text; LONGER IS TRUNCATED (… + warning), not rejected — see lib/activity2.js parseCall
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
/** The reportable states. `stale` and `gone` are derived (lib/activity2.js), never reported. 6b: + todo / skipped (contexts only;
 * skipped only on a plan item). 6c: + abandoned (plans and plan items only — 'not-a-plan' elsewhere). */
export const ACTIVITY_STATES = Object.freeze(['running', 'blocked', 'failed', 'done', 'idle', 'todo', 'skipped', 'abandoned'])
/** The per-host defaults (`activity` config block). */
export const ACTIVITY_DEFAULTS = Object.freeze({
  log_retention_days: 7,            // daily JSONL retention
  log_entries_per_agent: 200,       // in-memory log cap per NODE (6a: every node keeps its own log)
  stale_after_min: 15,              // the default stale window (also the dashboard slider's default)
  finished_visible_hours: 168,      // a finished (or gone) agent stays visible/gossiped this long; also the replay window (6b: 7 days, was 24)
  memory_budget_mb: 64,             // enforceBudget2's default budget
  progress_checkpoint_sec: 60,      // cp/rep cadence for log:false activity (0 = off; else 10..3600)
  abandoned_plan_days: 90,          // 6c: a gone session's open plans are abandoned (by the bridge) after this long (1..3650)
  finished_plan_open_min: 120,      // 6c: an ENDED plan stays expanded on dashboards this long (0..10080; sent with the board)
  notice_batch_sec: 3,              // #80 (v1.68.0): notices to one session within this many seconds go as ONE message (0 = each at once; 0..60)
  enabled: true,
})
/** @typedef {Readonly<{ log_retention_days:number, log_entries_per_agent:number, stale_after_min:number, finished_visible_hours:number,
 *   memory_budget_mb:number, progress_checkpoint_sec:number, abandoned_plan_days:number, finished_plan_open_min:number, notice_batch_sec:number, enabled:boolean }>} ActivityConfig */
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
  abandoned_plan_days: [1, 3650],        // 6c
  finished_plan_open_min: [0, 10080],    // 6c: 0 = an ended plan collapses at once; ≤ 7 days
  notice_batch_sec: [0, 60],             // #80: 0 = no batching (each notice goes at once)
}
const MIN = 60000, HOUR = 3600000, DAY = 86400000, MB = 1024 * 1024

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
const oneLine = (v, max) => { const s = typeof v === 'string' ? normText(v) : ''; return s ? cpSlice(s, max) : null }
/**
 * Who wrote a SYSTEM entry (not the session itself): 6c's string ("bridge"), or 6d's `{ kind:"dashboard", user, host }` (a
 * dashboard action — user = the dashboard's OS user on its host, else "dashboard"; host = the gateway it is attached to).
 * Anything else → null (an ordinary message). Bounded, one-line, compact.
 * @param {any} v @returns {string|{kind:string, user:string, host:string}|null}
 */
export function normBy(v) {
  if (typeof v === 'string') return v.trim() ? v.trim().slice(0, 80) : null
  if (!v || typeof v !== 'object' || v.kind !== 'dashboard') return null
  return { kind: 'dashboard', user: oneLine(v.user, 64) || 'dashboard', host: oneLine(v.host, 64) || '?' }
}
/** 6d: the attribution phrase — "by robin via dashboard (ROBIN-Z790)" / "by bridge"; '' for none. */
export function byText(v) { const b = normBy(v); return !b ? '' : typeof b === 'string' ? `by ${b}` : `by ${b.user} via dashboard (${b.host})` }

// ---------------------------------------------------------------------------------------------------------------
// #85 (v1.71.0): QUESTIONS — the question object a question line carries (see the header)
/** The statuses: asked (open, awaiting an answer) → answered | expired | withdrawn (closed). */
export const QUESTION_STATUSES = Object.freeze(['asked', 'answered', 'expired', 'withdrawn'])
/** The limits: ≤ 8 choices of ≤ 60 code points each; a free-text answer ≤ 1000 code points; expires ≤ 7 days. The question itself
 * is a line: ≤ 240 code points (ACTIVITY_LIMITS.text — refused when longer, never truncated). */
export const QUESTION_LIMITS = Object.freeze({ choices: 8, choice: 60, answer: 1000, expiresMaxMs: 7 * 86400000 })
/** The answer notice's verb (the session's own question was answered / withdrawn / expired) — sent at once, never batched. */
export const ANSWER_NOTICE_VERB = 'activity_answer'
/** A choice / an answer choice as kept: one line, ≤ 60 code points (longer → null: refused by the parsers). */
const qChoice = v => { const s = typeof v === 'string' ? normText(v) : ''; return s && cpLen(s) <= QUESTION_LIMITS.choice ? s : null }
/** A free-text answer as kept: newlines / tabs kept, other control characters dropped, trimmed (≤ 1000 code points: the caller checks). */
const qAnswerText = s => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '')
/**
 * A question object from memory, a record or the wire → its canonical form, or null (not a question). Untrusted input is bounded:
 * ≤ 8 distinct choices of ≤ 60 code points, an answer only when answered (choice ≤ 60, text ≤ 1000), `by` / `at` only once closed.
 * free = free text is allowed (always, when there are no choices).
 * @param {any} v
 * @returns {{ status:string, choices:string[], free:boolean, asked_at:number, expires_at?:number, answer?:{ choice?:string, text?:string }, by?:any, at?:number, revised?:number, previous?:{ answer:{ choice?:string, text?:string }, by?:any, at?:number } }|null}
 */
export function normQuestion(v) {
  if (!v || typeof v !== 'object' || !QUESTION_STATUSES.includes(v.status)) return null
  const choices = [], seen = new Set()
  for (const c of Array.isArray(v.choices) ? v.choices.slice(0, 32) : []) { const s = qChoice(c); if (s && !seen.has(lc(s)) && choices.length < QUESTION_LIMITS.choices) { seen.add(lc(s)); choices.push(s) } }
  const num = x => { const n = Number(x); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null }
  /** @type {any} */
  const out = { status: v.status, choices, free: v.free === true || !choices.length, asked_at: num(v.asked_at) || 0 }
  if (num(v.expires_at)) out.expires_at = num(v.expires_at)
  if (v.status === 'answered' && v.answer && typeof v.answer === 'object') { const a = qAnswerObj(v.answer); if (a) out.answer = a }
  if (v.status !== 'asked') {
    const by = qBy(v.by)
    if (by) out.by = by
    if (num(v.at)) out.at = num(v.at)
  }
  // #90 (v1.75.0): a REVISED answer — how many times it was changed and the answer before the latest (a ≤1.74 host drops both)
  if (out.answer && num(v.revised)) {
    out.revised = Math.min(num(v.revised), 9999)
    const p = v.previous && typeof v.previous === 'object' ? v.previous : null, pa = p ? qAnswerObj(p.answer) : null
    if (pa) { const pb = qBy(p.by); out.previous = { answer: pa, ...(pb ? { by: pb } : {}), ...(num(p.at) ? { at: num(p.at) } : {}) } }
  }
  return out
}
/** An answer object as kept (choice ≤ 60, text ≤ 1000 code points) or null. */
function qAnswerObj(v) {
  if (!v || typeof v !== 'object') return null
  const a = {}, ch = qChoice(v.choice), tx = qAnswerText(v.text)
  if (ch) a.choice = ch
  if (tx) a.text = cpLen(tx) > QUESTION_LIMITS.answer ? cpSlice(tx, QUESTION_LIMITS.answer - 1) + '…' : tx
  return a.choice || a.text ? a : null
}
const qBy = v => normBy(v && typeof v === 'object' ? { ...v, kind: 'dashboard' } : v)
/** #90: two answers are the same (the choice and the text). */
export const sameAnswer = (a, b) => !!a && !!b && (a.choice || null) === (b.choice || null) && (a.text || null) === (b.text || null)
const byView = b => (b && typeof b === 'object' ? { user: b.user, host: b.host } : b || null)
/** A question as the board / the activity tool show it (`by` as { user, host }, or "bridge"). #90: + revised / previous. @param {any} q @returns {any} */
export const questionView = q => {
  const n = normQuestion(q)
  return n ? { status: n.status, choices: n.choices, free: n.free, ...compact({ asked_at: n.asked_at || null, expires_at: n.expires_at || null, answer: n.answer || null,
    by: byView(n.by), at: n.at || null, revised: n.revised || null,
    previous: n.previous ? compact({ answer: n.previous.answer, by: byView(n.previous.by), at: n.previous.at || null }) : null }) } : null
}
/** The answer as one line for people: "Postgres — because the rest of the stack uses it" / just the choice / just the text. */
export function answerText(a, max = 160) {
  const parts = []
  if (a && a.choice) parts.push(a.choice)
  if (a && a.text) parts.push(normText(a.text))
  const s = parts.join(' — ')
  return cpLen(s) > max ? cpSlice(s, max - 1).trimEnd() + '…' : s
}
const cutTo = (s, n) => (cpLen(s) > n ? cpSlice(s, Math.max(0, n - 1)).trimEnd() + '…' : s)
/**
 * #90 (v1.75.0): the LOG TEXT of an answer entry (≤ 240) — the answer is named in it: `answered by robin via dashboard (HOST):
 * "Accept" — note: ship it today` (a choice, quoted, + the free-text note), `…: "ship it today"` (free text only). verb =
 * "answered" | "answer changed".
 */
export function answerEntryText(verb, by, a) {
  const head = `${verb}${byText(by) ? ' ' + byText(by) : ''}: `, L = ACTIVITY_LIMITS.text
  const tx = a && a.text ? normText(a.text) : ''
  if (a && a.choice) { const s = `${head}"${a.choice}"`; return tx ? s + cutTo(` — note: ${tx}`, L - cpLen(s)) : cutTo(s, L) }
  return head + '"' + cutTo(tx, L - cpLen(head) - 2) + '"'
}
const p2t = n => String(n).padStart(2, '0')
/** #90: a time for people in an entry's details — the owner's local time with its UTC offset: "2026-10-03 14:05:09 (UTC+13:00)". */
export function stampText(ts) {
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return '?'
  const off = -d.getTimezoneOffset(), sg = off >= 0 ? '+' : '-', ao = Math.abs(off)
  return `${d.getFullYear()}-${p2t(d.getMonth() + 1)}-${p2t(d.getDate())} ${p2t(d.getHours())}:${p2t(d.getMinutes())}:${p2t(d.getSeconds())} (UTC${sg}${p2t(Math.floor(ao / 60))}:${p2t(ao % 60)})`
}
const whoText = by => byText(by) || 'by its session'
/** A text cut to at most `max` UTF-8 bytes ("…" when cut). */
function fitBytes(s, max) {
  if (utf8(s) <= max) return s
  let t = s
  while (t && utf8(t) > max - 3) t = cpSlice(t, Math.max(0, cpLen(t) - Math.max(1, Math.ceil((utf8(t) - max + 3) / 4))))
  return t + '…'
}
/**
 * #90 (v1.75.0) — the fix for Robin's 2026-10-03 bug: a question's STATUS entries (answered, answer changed, withdrawn, expired)
 * carry their OWN details — what happened — never the question's background (that stays on the question's line and its ask
 * entry). prev / next = the question before / after; text = the question; o = { now, note (the asker's withdrawal note), why (an
 * abandon that withdrew it) }. Plain text, ≤ 4 KB (a long answer / note is cut to fit):
 *   Answer: Accept
 *   Note: ship it today
 *   Answered by robin via dashboard (ROBIN-Z790) at 2026-10-03 14:05:09 (UTC+13:00)
 *   Previous answer: Reject — by robin via dashboard (ROBIN-Z790) at …   (a change only)
 *   Question: Ship v1.75 today? (asked 2026-10-03 13:58:00 (UTC+13:00))
 */
export function questionEntryDetails(prev, next, text, o = {}) {
  const q = normQuestion(next), p = normQuestion(prev)
  if (!q) return null
  const now = o.now, qline = `Question: ${preview(text || '', 120)}${q.asked_at ? ` (asked ${stampText(q.asked_at)})` : ''}`
  const head = [], tail = []
  let body = ''
  if (q.status === 'answered' && q.answer) {
    const changed = !!(p && p.status === 'answered' && p.answer)
    if (q.answer.choice) head.push(`Answer: ${q.answer.choice}`)
    tail.push(`${changed ? 'Changed' : 'Answered'} ${whoText(q.by)} at ${stampText(q.at || now)}`)
    if (changed) tail.push(`Previous answer: ${answerText(p.answer, 300)} — ${whoText(p.by)}${p.at ? ' at ' + stampText(p.at) : ''}`)
    body = q.answer.text ? (q.answer.choice ? 'Note: ' : 'Answer: ') + q.answer.text : ''
  } else if (q.status === 'withdrawn') {
    head.push(`Withdrawn ${whoText(q.by)} at ${stampText(q.at || now)}${o.why ? ` (${normText(String(o.why))})` : ''}`)
    body = o.note ? `Note: ${o.note}` : ''
  } else if (q.status === 'expired') {
    head.push(`Expired at ${stampText(q.at || now)} — nobody answered${q.asked_at && q.expires_at ? ` within ${fmtEta(q.expires_at - q.asked_at).replace(/^~/, '')}` : ''}`)
  } else return null
  tail.push(qline)
  const fixed = [...head, ...tail].join('\n')
  if (body) body = fitBytes(body, ACTIVITY_LIMITS.detailsBytes - utf8(fixed) - 2)
  return fitBytes([...head, ...(body ? [body] : []), ...tail].join('\n'), ACTIVITY_LIMITS.detailsBytes)
}

/**
 * The session key: realm + projKey(project) + lc(user) + lc(session) + lc(host), JSON-encoded so no separator can collide.
 * The host is the ORIGIN holding the session. A missing realm is 'default'.
 * @param {{ realm?: string|null, project?: string|null, user?: string|null, session?: string|null, host?: string|null }} ident
 */
export const sessionKey = ident => { const i = ident && typeof ident === 'object' ? ident : {}; return JSON.stringify([lc(i.realm) || 'default', projKey(i.project), lc(i.user), lc(i.session), lc(i.host) || '']) }
/** The cross-host GROUP key (the board groups a session's entities from every host): sessionKey minus the host. */
export const groupKey = ident => { const i = ident && typeof ident === 'object' ? ident : {}; return JSON.stringify([lc(i.realm) || 'default', projKey(i.project), lc(i.user), lc(i.session)]) }
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
// #82 (v1.69.0): ORDER — a node's POSITION among its siblings is a FRACTIONAL RANK: a string of base-36 digits (0-9a-z)
// compared in code-unit order, never ending in "0", so there is always room between two ranks and a reorder writes ONE
// record (only the moved node's rank) — nothing is ever renumbered. Most nodes never STORE a rank: a node without one has its
// DERIVED rank — its creation time (9 base-36 digits, ms) + its plan position (2 digits; 0 = none, else plan_ix + 1) + "i" —
// so the default order is creation order exactly as before (1.68 nodes, and every node created on 1.69 without a position),
// and a new node created later sorts after every existing one. A node gets a STORED rank only when it is placed: inserted at a
// position (before / after / first / last), reordered, or moved; that rank is computed between its neighbours' ranks (stored
// or derived) and always stays below the derived rank of any node created later (an open "end" is bounded by the next ms).
// SIBLING ORDER (siblingCmp): plan items first, then the other contexts, then agents (rankGroup) — each by rank, then key.
export const RANK_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const RANK_MAX = 128   // chars: ~600 inserts at ONE spot before a rank would outgrow it ('rank-exhausted')
const RANK_RE = /^[0-9a-z]*[1-9a-z]$/
/** A stored rank from a record / the wire: a non-empty base-36 string (≤128 chars, no trailing "0"), else null. */
export const validRank = r => (typeof r === 'string' && r.length > 0 && r.length <= RANK_MAX && RANK_RE.test(r) ? r : null)
const pad36 = (n, w) => { const s = Math.max(0, Math.floor(Number(n) || 0)).toString(36); return s.length >= w ? s.slice(-w) : '0'.repeat(w - s.length) + s }
/** The DERIVED rank of a node with no stored one: creation order (created_at, then its plan position). */
export const derivedRank = (createdAt, planIx) => pad36(createdAt, 9) + pad36(Number.isInteger(planIx) && planIx >= 0 ? planIx + 1 : 0, 2) + 'i'
/** A node's effective rank: its stored one, else derived. */
export const rankOf = n => (n && validRank(n.rank)) || derivedRank(n ? n.created_at : 0, n && n.plan ? n.plan_ix : null)
/** The sibling GROUP: plan items 0, other contexts 1, agents 2 (rows never jump on a state change — only a node becoming a plan item moves it). */
export const rankGroup = n => (n && n.plan ? 0 : n && n.kind === 'context' ? 1 : 2)
/** Sibling order: group, then rank, then key (a derived tie: the same ms and plan position). */
export const siblingCmp = (a, b) => rankGroup(a) - rankGroup(b) || cmp(rankOf(a), rankOf(b)) || cmp(a.key, b.key)
/**
 * A rank strictly between `lo` and `hi` (either may be null: an open end). The midpoint of two base-36 fractions with no
 * trailing zero (the classic fractional-index construction): shared prefix, then the middle digit, else one more digit. lo ≥ hi
 * (two equal derived ranks) → just above lo (the tie then falls to the key).
 * @param {string|null} lo @param {string|null} hi @returns {string}
 */
export function rankBetween(lo, hi) {
  const a = lo || '', b = hi || null
  if (b !== null && a >= b) return a + 'i'
  return midRank(a, b)
}
function midRank(a, b) {
  const D = RANK_DIGITS
  if (b !== null) {
    let n = 0
    while ((a[n] || '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midRank(a.slice(n), b.slice(n))
  }
  const dA = a ? D.indexOf(a[0]) : 0, dB = b !== null ? D.indexOf(b[0]) : D.length
  if (dB - dA > 1) return D[Math.round((dA + dB) / 2)]
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return D[dA] + midRank(a.slice(1), null)
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
 * #79 (v1.66.0): progress has THREE parts — { done, skipped, total, unit } (skipped = resolved without being done; it is
 * neither done nor remaining). `skipped` is optional everywhere and defaults to 0: an object's `skipped`, or a string's
 * trailing "N skipped" ("3/6 1 skipped", "4812/12000 tiles · 100 skipped"); done + skipped > total clamps skipped
 * ('progress-clamped'). The value carries `skipped` only when > 0, so a 1.65 record / slice is byte-identical and a 1.65
 * reader (which takes done / total / unit) simply ignores it.
 * @param {any} v
 */
export function parseProgress(v) {
  let done, total, unit = '', skipped = 0
  if (typeof v === 'number') { done = v; total = 100; unit = '%' }
  else if (v && typeof v === 'object' && !Array.isArray(v)) {
    done = Number(v.done); total = Number(v.total); unit = typeof v.unit === 'string' ? v.unit : ''
    if (v.done === null || v.done === '' || v.total === null || v.total === '') return { ok: false, what: 'progress {done,total} must be numbers' }
    if (v.skipped != null && v.skipped !== '') skipped = Number(v.skipped)   // #79: optional (a 1.65 peer never sends it → 0)
  } else if (typeof v === 'string') {
    let s = v.trim()
    const sk = s.match(/^(.+?)(?:\s*[,;·]\s*|\s+)(\d+(?:\.\d+)?)\s+skipped$/i)   // #79: a trailing "N skipped" (only after a done/total form)
    if (sk && /^\d+(?:\.\d+)?\s*\/\s*\d/.test(sk[1])) { s = sk[1]; skipped = Number(sk[2]) }
    let m = s.match(/^(\d+(?:\.\d+)?)\s*%$/)
    if (m) { done = Number(m[1]); total = 100; unit = '%' }
    else if ((m = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?:\s*:\s*|\s+|$)(.*)$/s))) { done = Number(m[1]); total = Number(m[2]); unit = m[3] }
    else return { ok: false, what: `progress "${cpSlice(s, 40)}" isn't "done/total [unit]", "done/total:unit" or "N%"` }
  } else return { ok: false, what: 'progress must be a string like "3/6", "4812/12000 tiles" or "61%"' }
  unit = normText(String(unit)).replace(/\s+/g, ' ')
  if (!Number.isFinite(done) || !Number.isFinite(total)) return { ok: false, what: 'progress done/total must be numbers' }
  if (!Number.isFinite(skipped) || skipped < 0) return { ok: false, what: 'progress skipped must be a number ≥ 0' }
  if (total <= 0) return { ok: false, what: 'progress total must be > 0' }
  if (done < 0) return { ok: false, what: 'progress done must be ≥ 0' }
  if (total > 1e15) return { ok: false, what: 'progress total is too large' }
  if (cpLen(unit) > ACTIVITY_LIMITS.unit) return { ok: false, what: `progress unit is longer than ${ACTIVITY_LIMITS.unit} chars` }
  let warning
  if (done > total) { done = total; warning = 'progress-clamped' }
  if (done + skipped > total) { skipped = total - done; warning = 'progress-clamped' }
  return { ok: true, value: { done, total, unit, ...(skipped > 0 ? { skipped } : {}) }, warning }
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
// #88 identity primitives (v2.0 build step 1; docs/spec-88.md §1, §3, §4.0). The 2.0 model (lib/activity2.js) is built on
// them; step 11 deleted the 1.7x model they were first written beside.

/** Key limits (spec §1.1): a key is 1 – 48 code points; a slug made from a label is cut to 40. */
export const KEY_LIMITS = Object.freeze({ key: 48, slug: 40 })
/** 2.0 depth (spec §1.3, Q11b — revises Q11; 1.7x's ACTIVITY_LIMITS.depth = 6 is left for lib/activity-v5.js): steps below the session
 * root. `max` is HARD (a create / move past it is refused `depth`), past `warn` a call succeeds with warning `deep-tree`. */
export const DEPTH2 = Object.freeze({ max: 32, warn: 20 })
const KEY_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_.#+-]*$/u        // today's agent-segment charset (SEGMENT) MINUS ':' (hole H1)
const QKEY_RE = /^\?\d+$/                                     // a bridge-made question key (?1, ?2 …; #85's @?N)
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'               // RFC 4648 base32, lower-case, no padding
const base32 = buf => { let out = '', v = 0, n = 0; for (const b of buf) { v = ((v << 8) | b) & 0xffff; n += 8; while (n >= 5) { out += B32[(v >>> (n - 5)) & 31]; n -= 5 } } return n > 0 ? out + B32[(v << (5 - n)) & 31] : out }
const hashId = parts => base32(createHash('sha256').update(JSON.stringify(parts)).digest()).slice(0, 16)
const sessParts = i => { const x = i && typeof i === 'object' ? i : {}; return [lc(x.host), lc(x.realm) || 'default', lc(x.project), lc(x.user), lc(x.session)] }
const chainText = c => (Array.isArray(c) ? c.join('/') : c == null ? '' : String(c))

/**
 * The stable id of a v2-born node (spec §1.2): the first 16 chars of base32(sha256(JSON ["aimb-node/2", lc(host),
 * lc(realm)||"default", lc(project), lc(user), lc(session), lc(creatorChain), lc(key)])). The session root = chain '', key ''.
 * Minted ONCE at creation and stored — never recomputed. Pass keys as validKey returns them (NFC).
 * @param {{ host?: string, realm?: string, project?: string, user?: string, session?: string }} ident
 * @param {string|string[]} chain  the creator chain ("spec-88/research"; '' = the session itself); an array is joined by '/'
 * @param {string} key
 * @returns {string} 16 chars of [a-z2-7]
 */
export const mintId = (ident, chain, key) => hashId(['aimb-node/2', ...sessParts(ident), lc(chainText(chain)), lc(key)])

/**
 * The id the migration gives a v5 node (spec §1.2, §7.3): ["aimb-node/legacy", …the same session parts…, pathKey], where
 * pathKey is the v5 key (lc canonical 1.7x path, `@` included) of the node's FINAL path. A different prefix from mintId, so
 * the two families never meet.
 * @param {{ host?: string, realm?: string, project?: string, user?: string, session?: string }} ident
 * @param {string} v5PathKey
 * @returns {string}
 */
export const legacyId = (ident, v5PathKey) => hashId(['aimb-node/legacy', ...sessParts(ident), lc(v5PathKey)])

/**
 * Validate a node KEY (spec §1.1): NFC, trimmed, 1 – 48 code points, first `\p{L}` `\p{N}` or `_`, then those plus `. # + -`
 * (no `:`, no `/`, no spaces). `root` (any case) is reserved. `?<digits>` (a question key) only with { question:true } — the
 * bridge minting one, or a caller REFERENCING one.
 * @param {any} raw @param {{ question?: boolean }} [o]
 * @returns {ActivityResult} { ok:true, key } or { ok:false, code:'bad-key', what }
 */
export function validKey(raw, o = {}) {
  if (typeof raw !== 'string') return bad('bad-key', 'key must be a string like "docs" or "spec-88"')
  const k = raw.normalize('NFC').trim()
  if (!k) return bad('bad-key', 'key is empty')
  if (cpLen(k) > KEY_LIMITS.key) return bad('bad-key', `key "${cpSlice(k, 20)}…" is longer than ${KEY_LIMITS.key} chars`)
  if (QKEY_RE.test(k)) return o.question ? { ok: true, key: k } : bad('bad-key', `"${k}" is a question key: only the bridge makes those`)
  if (lc(k) === 'root') return bad('bad-key', '"root" is reserved')
  if (!KEY_RE.test(k)) return bad('bad-key', `key "${cpSlice(k, 40)}" may only use letters, digits and _ . # + - (starting with a letter, digit or _)`)
  return { ok: true, key: k }
}

/**
 * The KEY made from a label (spec §1.1, for path-created nodes and a label-only `--item`): NFC, whitespace runs → '-', drop
 * everything outside [\p{L}\p{N}_.-], collapse '-' runs, strip leading non-[\p{L}\p{N}_] and trailing '-' / '.', ≤ 40 code
 * points; empty or `root` → `node`. Case is kept (keys compare case-insensitively). Always a valid key. A clash in its scope
 * is settled by uniqueKey.
 * @param {any} label @returns {string}
 */
export function slugKey(label) {
  const strip = s => s.replace(/^[^\p{L}\p{N}_]+/u, '').replace(/[-.]+$/, '')
  let s = strip(String(label == null ? '' : label).normalize('NFC').trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_.-]/gu, '').replace(/-{2,}/g, '-'))
  s = strip(cpSlice(s, KEY_LIMITS.slug))
  return !s || lc(s) === 'root' ? 'node' : s
}

/**
 * The first free key in a scope (spec §1.1): `base` itself, else `base-2`, `base-3` … (base cut so the result stays ≤ 48
 * code points). `taken` = a Set of lc() keys, or a predicate given the lc() candidate.
 * @param {string} base @param {Set<string>|((lcKey: string) => boolean)} taken @returns {string}
 */
export function uniqueKey(base, taken) {
  const isTaken = typeof taken === 'function' ? taken : k => !!taken && taken.has(k)
  if (!isTaken(lc(base))) return base
  for (let n = 2; ; n++) {
    const sfx = `-${n}`, k = cpSlice(base, KEY_LIMITS.key - sfx.length).replace(/[-.]+$/, '') + sfx
    if (!isTaken(lc(k))) return k
  }
}

/**
 * Canonicalise a LABEL (spec §1.3: today's context-name rule minus its `/` and `"` bans): whitespace runs → one space,
 * trimmed, 1 – 60 code points, no control characters. Any text otherwise — `root`, `@x`, `a/b` are all labels.
 * @param {any} raw @returns {ActivityResult} { ok:true, label } or { ok:false, code:'bad-label', what }
 */
export function normLabel(raw) {
  if (typeof raw !== 'string') return bad('bad-label', 'label must be a string')
  const label = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!label) return bad('bad-label', 'label is empty')
  if (/[\u0000-\u001f\u007f]/.test(label)) return bad('bad-label', 'label may not contain control characters')
  if (cpLen(label) > ACTIVITY_LIMITS.context) return bad('bad-label', `label is longer than ${ACTIVITY_LIMITS.context} chars`)
  return { ok: true, label }
}

/** The COMPARISON form of a label (spec §1.6: sibling labels are unique by this): NFC + lc. @param {any} label */
export const labelKey = label => lc(String(label == null ? '' : label).normalize('NFC')).normalize('NFC')

// A path segment needs quotes when it holds '/', starts with '"' or '@' (an unquoted '@' start is the 1.7x form), or is '.'
// (a leading './' is the "this is a path" marker, §3.2) or '..' (a leading '..' navigates in `--move-to`, §3.8). Labels are
// trimmed, so the "starts / ends with a space" case of Q37 never arises. `"` inside is doubled.
const quoteLabel = l => (/\/|^["@]|^\.\.?$/.test(l) ? `"${l.replace(/"/g, '""')}"` : l)
/** The display path of labels (spec §3.3: labels joined by '/', no `@`; quoted where needed). @param {string[]} labels */
export const formatPath2 = labels => labels.map(quoteLabel).join('/')

// The 1.7x path → its 2.0 spelling, for the legacy-form message: each segment loses its `@` / `@~`, `@"…"` is unquoted,
// `@root` (the node itself) is dropped. Best effort: a malformed 1.7x path still gets a useful message.
function convertLegacyPath(s) {
  const out = []
  let tilde = false
  for (let i = 0; i < s.length;) {
    while (s[i] === ' ') i++
    let j = i
    if (s[j] === '@') { j++; if (s[j] === '~') { tilde = true; j++ } }
    let name
    if (s[j] === '"') { const close = s.indexOf('"', j + 1); name = s.slice(j + 1, close < 0 ? s.length : close); j = close < 0 ? s.length : close + 1 }
    else { let k = j; while (k < s.length && s[k] !== '/') k++; name = s.slice(j, k); j = k }
    const atRoot = s[i] === '@' && lc(name) === 'root'
    name = name.replace(/\s+/g, ' ').trim()
    if (name && !atRoot) out.push(name)
    while (j < s.length && s[j] !== '/') j++
    i = j + 1
  }
  return { path: formatPath2(out), tilde }
}
const legacyPath = raw => {
  const c = convertLegacyPath(raw)
  return c.tilde
    ? { ok: false, code: 'legacy-form', what: `@~ was removed in 2.0: use --text "@…" on the node (${c.path ? `--path "${c.path}" or its --key` : 'no --key / --path: your own node'})`, path: c.path }
    : { ok: false, code: 'legacy-form', what: `paths have no @ in 2.0: write ${c.path ? `"${c.path}"` : 'no path (the node itself)'}`, path: c.path }
}

/**
 * Parse a 2.0 PATH (spec §3.3, Q37): segments separated by '/', each a LABEL (normLabel). A segment holding '/' (or one
 * starting with '"', '@' or being '.') is written in double quotes, `""` inside for a literal '"'; an unquoted segment runs
 * to the next '/', quotes inside it literal. Leading / trailing slashes and one leading './' (§3.2's "force a path") are
 * dropped; '' = the scope itself; ≤ DEPTH2.max (32) segments (Q11b). An UNQUOTED segment starting with '@' is the 1.7x form: refused
 * `legacy-form`, the message (and `path`) giving the converted 2.0 path (§4.5).
 * @param {any} raw
 * @returns {ActivityResult} { ok:true, segs:[label…], path, key } (key = labelKey(path)) or { ok:false, code, what, path? }
 */
export function parsePath2(raw) {
  if (typeof raw !== 'string') return bad('bad-path', 'path must be a string like "Next release/Docs"')
  let s = raw.trim()
  if (s.startsWith('./')) s = s.slice(2)
  s = s.replace(/^\/+|\/+$/g, '')
  if (!s) return { ok: true, segs: [], path: '', key: '' }
  /** @type {string[]} */
  const segs = []
  for (let i = 0; ;) {
    while (s[i] === ' ') i++
    let label
    if (s[i] === '"') {
      let j = i + 1, t = ''
      for (;;) {
        if (j >= s.length) return bad('bad-path', 'unterminated quoted segment ("…")')
        if (s[j] === '"') { if (s[j + 1] === '"') { t += '"'; j += 2; continue } j++; break }
        t += s[j++]
      }
      while (s[j] === ' ') j++
      if (j < s.length && s[j] !== '/') return bad('bad-path', 'a quoted segment must end its segment (…"/…)')
      label = t; i = j
    } else {
      if (s[i] === '@') return legacyPath(s)
      let j = i
      while (j < s.length && s[j] !== '/') j++
      label = s.slice(i, j); i = j
    }
    if (!label.trim()) return bad('bad-path', 'path has an empty segment')
    const n = normLabel(label); if (!n.ok) return n
    segs.push(n.label)
    if (i >= s.length) break
    i++   // the '/'
    if (i >= s.length) return bad('bad-path', 'path has an empty segment')
  }
  if (segs.length > DEPTH2.max) return bad('path-too-deep', `the path has ${segs.length} segments; the limit is ${DEPTH2.max}`)
  const path = formatPath2(segs)
  return { ok: true, segs, path, key: labelKey(path) }
}

/**
 * Parse a REFERENCE (`--under`, `--before`, `--after`, `--move`, `--merge`; spec §3.2), by its syntax:
 * - `chain:key` → { kind:'chain', chain, creators, key } — exactly that scope (`:88` = the session's `88`; `spec-89:docs`).
 * - a bare valid key (incl. a question key `?3`) → { kind:'key', key } — your scope, then your creator's … up to the session's.
 * - anything else (contains '/', a label with spaces, a quoted segment, a leading './') → { kind:'path', segs, path, key }
 *   (parsePath2: refused `legacy-form` for a 1.7x `@` path).
 * @param {any} raw @returns {ActivityResult}
 */
export function parseRef(raw) {
  if (typeof raw !== 'string') return bad('bad-ref', 'a reference must be a string: a key, chain:key, or a path')
  const s = raw.trim()
  if (!s) return bad('bad-ref', 'the reference is empty')
  const asPath = () => { const p = parsePath2(s); return p.ok ? { ok: true, kind: 'path', segs: p.segs, path: p.path, key: p.key } : p }
  if (s.startsWith('./')) return asPath()
  const colon = s.lastIndexOf(':')
  if (colon >= 0) {
    const chain = s.slice(0, colon), k = validKey(s.slice(colon + 1), { question: true })
    const creators = chain ? chain.split('/').map(c => validKey(c)) : []
    if (k.ok && creators.every(c => c.ok)) return { ok: true, kind: 'chain', chain: creators.map(c => c.key).join('/'), creators: creators.map(c => c.key), key: k.key }
  }
  const k = validKey(s, { question: true })
  return k.ok ? { ok: true, kind: 'key', key: k.key } : asPath()
}

/**
 * Split a report's TEXT by the leading-`@` rule (spec §4.0, Q36): count the run of '@' at the start; each PAIR stands for one
 * literal '@', an odd one left over is the set-the-line marker. `@x` → line "x"; `@@x` → logs "@x"; `@@@x` → line "@x"; an
 * '@' anywhere else is just a character (`x@` is plain). The text is trimmed first. `@~…` (the 1.7x marker) is refused
 * `legacy-form`, naming the 2.0 form.
 * @param {any} raw
 * @returns {ActivityResult} { ok:true, text, line } (line = it sets the current line) or { ok:false, code, what }
 */
export function parseText(raw) {
  if (typeof raw !== 'string') return bad('bad-text', 'text must be a string')
  const t = raw.trim()
  let n = 0
  while (t[n] === '@') n++
  if (n === 1 && t[1] === '~') {
    const m = /^@~("[^"]*"|\S*)\s*(.*)$/s.exec(t), target = m ? m[1].replace(/^"|"$/g, '') : '', rest = m ? m[2] : ''
    const own = !target || lc(target) === 'root'
    return { ok: false, code: 'legacy-form', what: `@~ was removed in 2.0: use --text "@${rest || '…'}" on the node (${own ? 'no --key: your own node' : `--key <its key>, or --path "${formatPath2([target])}"`})` }
  }
  return { ok: true, text: ('@'.repeat(n >> 1) + t.slice(n)).trim(), line: n % 2 === 1 }
}

/** @typedef {{ done:number, total:number, unit:string, skipped?:number }} ActivityProgress */

// ---------------------------------------------------------------------------------------------------------------
// 6d / #84: DASHBOARD MESSAGES (the 2.0 actions are lib/activity2.js applyAction2)

/** #84: a dashboard message's limits — its full text (code points), and the preview logged as the entry's text. */
export const MESSAGE_LIMITS = Object.freeze({ text: 2000, preview: 120 })
/** #84: the first `max` code points of a text as ONE line ("…" when cut). */
const preview = (s, max) => { const t = normText(String(s || '')); return cpLen(t) > max ? cpSlice(t, max - 1).trimEnd() + '…' : t }
/** #84: a few words for a PUBLIC subject — at most `words` words and `chars` code points ("…" when cut). */
export function firstWords(s, words = 6, chars = 40) {
  const ws = normText(String(s || '')).split(' ').filter(Boolean)
  let out = ''
  const cut = o => (o.endsWith('…') ? o : o.replace(/[\s.,;:!?]+$/u, '') + '…')   // "…" after the last word (no "case.…")
  for (const w of ws.slice(0, words)) { const nx = out ? out + ' ' + w : w; if (cpLen(nx) > chars) return cut(out || cpSlice(w, chars - 1) + '…'); out = nx }
  return ws.length > words ? cut(out) : out
}

// ---------------------------------------------------------------------------------------------------------------
// #80 (v1.68.0): DASHBOARD-CHANGE NOTICES. After an action applies, the OWNING gateway tells the node's session — a system
// message, verb `activity_changed`, to its registered sub-peer (parked when it is offline; a script-only session gets the
// log entry only). The 2.0 builders are lib/activity2.js actionNotice2 / messageNotice2 / answerNotice2 /
// combineActionNotices2; the bridge batches them per session (notice_batch_sec) and delivers them (bridge.mjs
// notifyActivitySession). These are the verbs.
export const NOTICE_VERB = 'activity_changed'
/** #83 (v1.70.0): the verb of a dashboard EDIT of a node's line (batched like activity_changed; several merge through combineActionNotices2). */
export const EDIT_NOTICE_VERB = 'activity_text_edited'
/** #84 (v1.70.0): the verb of a dashboard viewer's MESSAGE about a node (sent at once — a person waits on it). */
export const MESSAGE_NOTICE_VERB = 'activity_message'

// ---------------------------------------------------------------------------------------------------------------
// derived views (pure; the dashboard's stale slider passes its own staleMin)

/** The reported state of a node (its current line's); else running. */
export function stateOf(item) { return item && item.current ? item.current.state : 'running' }
/** Percent 0..100 of a progress value. */
export const progressPct = p => (p && p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0)
// ROLLUP strategies, in precedence order after a node's own reported progress (6a; 6b adds the last). Each gets the bars of
// the node's ORDINARY children (every child that is not a plan item, with a bar) and its PLAN ITEMS, and returns a bar or
// null. 6b ("Decisions before 6b"; the build's choice for MIXED children): a plan item counts ONLY as a todo of its parent
// (its own bar — e.g. an agent working under it — shows on its own row, never in the parent's sum / mean), so a plan node
// shows "N of M done". #88: that holds even when it also has ordinary children with bars (helper agents, a questions
// context) — they show their bars on their own rows (was 6c decision 7, "ordinary children win": an open plan whose helper
// agents had finished showed a full bar).
// #79 (v1.66.0): every bar has THREE parts — done, skipped (resolved, not done: never counted as remaining), total — and
// each strategy carries all three: a common unit SUMS done, skipped and total; mixed units AVERAGE each child's done
// fraction and skipped fraction (each child weighted 1); "N of M done" counts ALL items in M (replaces 6b/6c's "skipped
// left out of M"): done items → done; skipped AND abandoned items → skipped (they won't be done); todo / running / blocked /
// idle / failed items → remaining (failed counts as not done — it may be retried).
const skOf = p => (p && p.skipped > 0 ? p.skipped : 0)   // #79: a progress without `skipped` (a 1.65 peer, any old record) = 0
/**
 * #79: a node's OWN state overrides what its bar says. DONE = 100% done (done = total, skipped 0, `forced:'done'`) — so a
 * done node shows a full bar and contributes its whole weight as done to its parent, whatever its reported or rolled-up bar
 * said (seen live: a plan marked complete showed a partial striped bar); ABANDONED = it won't be done: whatever is not done
 * becomes skipped (`forced:'abandoned'`). Anything else (failed included) keeps its bar. A node with no bar stays without one.
 * @param {any} node @param {any} r
 */
export function forceBar(node, r) {
  if (!r) return r
  const s = stateOf(node)
  if (s === 'done') { const { abandoned, ...rest } = r; return { ...rest, done: r.total, skipped: 0, pct: 100, forced: 'done' } }   // nothing left skipped (or abandoned) in a full bar
  if (s === 'abandoned') return { ...r, skipped: Math.max(0, r.total - r.done), forced: 'abandoned' }
  return r
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
/** #79: the {progress} wording — "4,812 of 12,000 tiles", "1 of 5 done · 1 skipped", "61% · 10% skipped" (the dashboard's barText mirrors it). @param {any} p */
export function progressText(p) {
  const unit = p && typeof p.unit === 'string' ? p.unit : '', sk = skOf(p)
  return (unit === '%' ? `${fmtNum(p.done)}%` : `${fmtNum(p.done)} of ${fmtNum(p.total)}${unit ? ' ' + unit : ''}`) + (sk ? ` · ${fmtNum(sk)}${unit === '%' ? '%' : ''} skipped` : '')
}
/**
 * Render a status-text TEMPLATE. Placeholders: {progress} → "4,812 of 12,000 tiles" ("61%" for a % bar, "3 of 6" without a
 * unit); {pct} → "40%" (floored); {done}, {total}, {unit}; {eta} → "~1h 25m" from eta_at vs now ("now" once due, "?" when
 * there is no ETA). `{{` and `}}` are literal braces. An unknown {word} is left untouched, and so is a bar placeholder
 * with no bar to fill it (or {unit} with no unit). #79: three-part progress — {progress} adds " · N skipped" when skipped > 0
 * ("1 of 5 done · 1 skipped", "61% · 10% skipped"; unchanged without skipped), {pct} stays the DONE percent, and
 * {skipped} → the skipped count ("0" when none).
 * @param {string} template @param {any} progress  {done,total,unit,skipped?} (or a rollup) or null
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
      case 'progress': return !p ? m : progressText(p)
      case 'pct': return p ? `${Math.floor(progressPct(p) + 1e-9)}%` : m
      case 'skipped': return p ? fmtNum(skOf(p)) : m   // #79
      case 'done': return p ? fmtNum(p.done) : m
      case 'total': return p ? fmtNum(p.total) : m
      case 'unit': return unit || m
      case 'eta': return Number.isFinite(eta_at) && eta_at > 0 ? fmtEta(eta_at - now) : '?'
      default: return m
    }
  })
}
