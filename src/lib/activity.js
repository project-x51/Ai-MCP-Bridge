// #70 agent activity board — the PURE core. No I/O, no timers, no clock: every function that needs the time takes `now`
// (ms epoch) as a parameter, so the whole model is exercised directly by tests/unit/test_activity_unit. Step 1 built the model;
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
//   TEXT IS A TEMPLATE ({progress} {pct} {done} {total} {unit} {eta}; #79: + {skipped}) rendered at READ time (renderText).
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
//
// 6c (v1.64.0, #70 "Decisions before 6c and 6d"): an `abandoned` state for PLANS and PLAN ITEMS only (a node holding plan
// items, or an item — else 'not-a-plan'); a plan now ENDS only when every item is done, or when its node is set done
// (complete) or abandoned — skipped / failed / idle / todo / running / blocked items all keep it open (supersedes 6b's "done
// or skipped ends a plan" and "its owner finishing ends it"); every node of an OPEN plan (its items + their ancestors) never
// expires and is never evicted. AUTO-ABANDON (autoAbandon): the open items of a session that has been gone (not live, no
// message) for abandoned_plan_days, then the plan node itself, become `abandoned` — entries attributed to the bridge
// (`by:"bridge"`, a SYSTEM message: no activity, no un-gone). Each node's own log COUNT rides the gossip (`log_n`, + the
// `log_partial` flag when its run began before the replay window, so the count understates); every record carries `s0` (the
// session's created_at) so the HOME host (the earliest-created root across hosts, ties by host name) is stable; the board
// carries `home` and each plan node's `plan_end_at`; RUN-BOUNDARY history (filePage): a node's day-file paging stops at the
// record that began its CURRENT run (new_from at or above it) unless asked for earlier runs, and says `pruned` when the run
// began in a file retention already deleted. Records + slices are FORMAT v4 (v2 / v3 records still read).
//
// 6d (v1.65.0, #70 "Decisions after 6c, for 6d"): FINISHING AN AGENT NEVER COMPLETES ITS PLAN — an agent's (or the session's)
// own line no longer ends the plan it holds; only every item done, or an explicit end does: a CONTEXT plan node's line set done
// / abandoned (as in 6c), or the PLAN-END MARKER (`node.plan_end` = { state: done|abandoned, ts }) that an agent / the session
// gets from the dashboard's "complete" / "abandon plan" (or the tool's `abandoned` line on an agent, which still finishes it as
// in 6c); "reopen plan" clears it. DASHBOARD ACTIONS (applyAction — the first write path from outside the session): on a plan
// item done / skip / reopen / abandon; on a plan node complete / abandon_plan / reopen_plan; on an agent or the session
// abandon_plan (only its OPEN plan items — and the open plans it holds then end — the agent keeps running), finish (done |
// failed; when stale or gone) and dismiss (remove it + its subtree from the board now: a logged `dismiss:true` entry the
// replay honours like an eviction; never a subtree holding part of an open plan). Each is a SYSTEM message attributed to its
// author (`by` = { kind:"dashboard", user, host }, `act` = the action; the entry's text says "… by <user> via dashboard
// (<host>)" while an item's own line keeps its text — `line_text` on the record). The carry-forward `cf` record now carries
// the node's own entry count (`log_n`, + `log_partial`), so a count stays exact across restarts. Records + slices are
// FORMAT v5 (+ plan_end, dismiss, line_text, act, cf log_n; v2–v4 records still read).
//
// #79 (v1.66.0): THREE-PART PROGRESS — { done, skipped, total, unit }: skipped is resolved without being done (neither done
// nor remaining). Rollups carry all three (rollupStrategies): a common unit sums them, mixed units average the done and skipped
// fractions, a plan's "N of M done" counts EVERY item in M (skipped and abandoned items → skipped; failed / open → remaining).
// A DONE node is 100% done whatever its bar says, an ABANDONED one has its remainder skipped (forceBar). WIRE-COMPATIBLE with
// 1.65: `skipped` is an optional field on a progress object (records, cp / cf, gossip), present only when > 0 — a 1.65 reader
// ignores it and a missing one is 0 — so the format stays v5 and hosts can upgrade one at a time.
//
// #82 (v1.69.0): THE PLAN WORKFLOW. ORDER: each node's position among its siblings is a FRACTIONAL RANK (rankOf / siblingCmp:
// plan items, then contexts, then agents) — stored only when a node is PLACED (before / after / position on new plan items or a
// reorder, or a move), else derived from created_at + plan_ix, so the default is creation order and a reorder writes one record.
// MOVE (`move` + `to`; applyMove) re-parents a node with its subtree: one logged entry at the new path with `moved_from`; the
// replay maps every older record onto the path its node has now (node by node), and `node.moved` gives its log aliases into the
// day files (nodeAliases). `abandoned` is valid on ANY context and CASCADES to the open contexts / items under it
// (cascadeAbandon). Dashboard actions `move` / `reorder`. Still format v5: rank / moved_from / moved are optional fields a 1.68
// host ignores.
//
// #83 / #84 (v1.70.0): two more dashboard actions (MSG_ACTIONS). `edit_text` (args.text, args.state?) sets a node's CURRENT
// LINE for its session — a SYSTEM message like the others (no activity); the line remembers who wrote its text (`line.by`, the
// record's `line_by`, gossiped / checkpointed / replayed) until the session's next line replaces it (a tick that keeps the text
// keeps it too); the logged entry says "<text> (edited by <user> via dashboard (<host>))". `message` (args.text, ≤ 2000 chars)
// LOGS "<user> via dashboard: <first 120 chars>…" on the node (the full text in `details`); the bridge delivers it. Notices:
// actionNotice (edit_text → verb activity_text_edited, batched; several merge through combineActionNotices) and messageNotice
// (verb activity_message, sent at once; a public subject of who + path + firstWords, the text in the body).
// Still format v5: line_by / line.by are optional fields a 1.69 host ignores.
//
// #85 (v1.71.0): QUESTIONS. A question is a CONTEXT whose current LINE carries `question` = { status, choices, free, asked_at,
// expires_at?, answer?, by?, at? } — the line's text IS the question (≤ 240 code points; longer is refused, never cut). `ask`
// (+ choices ≤ 8 × ≤ 60, free, expires) posts one: on a context that is new, line-less and leaf, or already a question, THAT node
// becomes it; on anything else (an agent, the session, a context with a line or children) a new child `@?<n>` is created
// (applyAsk). STATUS asked → answered (the dashboard's `answer`: a choice and/or free text, attributed) | expired (the bridge,
// after `expires`) | withdrawn (the asker's state "withdrawn", the dashboard's `withdraw`, or any abandon / cascade of an open one).
// For WIRE COMPATIBILITY the line's STATE follows the status — asked = blocked, answered = done, expired / withdrawn = abandoned —
// so a ≤1.70 host (which drops the unknown `question` field) shows an ordinary blocked / done / abandoned context with the
// question as its text. A question counts as an ITEM in "N of M done" (open = remaining, answered = done, closed unanswered =
// skipped) and, under a node holding plan items, as an item of that plan. The question rides the line everywhere `line_by` does:
// the entry record's `question`, a cp's / cf's `current.question`, gossip `current.question`, the replay (lineOf). A plain report
// can't overwrite a question's line ('question-node'). Still format v5: `question` is an optional field a 1.70 host ignores.
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
 * carry-forward records); 6c = v4 (the abandoned state, `by`, `s0`, gossiped log counts). A v4 bridge still READS v2 / v3
 * JSONL records (each format only adds) but refuses an older gossip slice (a 1.63 hub would misread `abandoned`). 6d = v5 (the
 * plan-end marker, dismiss entries, line_text / act / object `by`, the cf entry count) — a 1.64 hub would show an agent's
 * completed plan as open and a dismissed node again. */
export const ACTIVITY_FORMAT = 5
const RECORD_FORMATS = new Set([2, 3, 4, 5])
/** The reportable states. `stale` and `gone` are derived (effectiveState), never reported. 6b: + todo / skipped (contexts only;
 * skipped only on a plan item). 6c: + abandoned (plans and plan items only — 'not-a-plan' elsewhere). */
export const ACTIVITY_STATES = Object.freeze(['running', 'blocked', 'failed', 'done', 'idle', 'todo', 'skipped', 'abandoned'])
/** The per-host defaults (`activity` config block). */
export const ACTIVITY_DEFAULTS = Object.freeze({
  log_retention_days: 7,            // daily JSONL retention
  log_entries_per_agent: 200,       // in-memory log cap per NODE (6a: every node keeps its own log)
  stale_after_min: 15,              // the default stale window (also the dashboard slider's default)
  finished_visible_hours: 168,      // a finished (or gone) agent stays visible/gossiped this long; also the replay window (6b: 7 days, was 24)
  memory_budget_mb: 64,             // enforceBudget's default budget
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
/** The message fields of a `log` call / batch item (6a: + path; 6b: + plan; #82: + move / to (re-parent) and before / after /
 * position (where new plan items, a moved node or the addressed node go among their siblings)). */
export const MESSAGE_FIELDS = Object.freeze(['path', 'agent', 'text', 'context', 'state', 'progress', 'eta', 'stale_after', 'details', 'data', 'log', 'plan', 'move', 'to', 'before', 'after', 'position', 'ask', 'choices', 'free', 'expires'])
/** #85: the fields of a QUESTION (ask = the question; choices; free = free text allowed; expires = a duration) — a ≤1.70 gateway
 * doesn't know them (it would drop them silently), so a 1.71 follower / script refuses to send them there; so is state "withdrawn". */
export const ASK_FIELDS = Object.freeze(['ask', 'choices', 'free', 'expires'])
const isWithdrawn = v => typeof v === 'string' && v.trim().toLowerCase() === 'withdrawn'
/** Does a `log` input (or a batch of them) use a #85 field (or state "withdrawn")? */
export const usesAsk = input => {
  const one = x => !!x && typeof x === 'object' && (ASK_FIELDS.some(k => x[k] !== undefined) || isWithdrawn(x.state))
  return !!input && typeof input === 'object' && (one(input) || (Array.isArray(input.items) && input.items.some(one)))
}
/** #82: the fields a ≤1.68 gateway doesn't know (it would silently ignore them) — a 1.69 follower / script refuses to send them there. */
export const PLAN82_FIELDS = Object.freeze(['move', 'to', 'before', 'after', 'position'])
/** Does a `log` input (or a batch of them) use any #82 field? */
export const usesPlan82 = input => !!input && typeof input === 'object' && (PLAN82_FIELDS.some(k => input[k] !== undefined) || (Array.isArray(input.items) && input.items.some(it => it && typeof it === 'object' && PLAN82_FIELDS.some(k => it[k] !== undefined))))
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
  abandoned_plan_days: [1, 3650],        // 6c
  finished_plan_open_min: [0, 10080],    // 6c: 0 = an ended plan collapses at once; ≤ 7 days
  notice_batch_sec: [0, 60],             // #80: 0 = no batching (each notice goes at once)
}
const MIN = 60000, HOUR = 3600000, DAY = 86400000, MB = 1024 * 1024
const MAX_SESSIONS_PER_ORIGIN = 1024   // bounds a junk/huge gossiped slice (a sane host never gets near it)
// 6c: the FINAL states — an agent's line in one of them finishes it, an ETA is dropped, gone is never shown (was done/failed;
// + abandoned, valid only on plans and plan items)
const DONE_OR_FAILED = new Set(['done', 'failed', 'abandoned'])
const LIVE = new Set(['running', 'blocked'])   // the only states that can go stale
const PLAN_STATES = new Set(['todo', 'skipped'])            // 6b: contexts only (skipped: plan items only)
const OPEN_ITEM = new Set(['todo', 'running', 'blocked'])   // 6b: an OPEN plan item (6c: what auto-abandon abandons)
const PLAN_END = new Set(['done', 'abandoned'])             // 6c: a plan NODE set to one of these ends its plan (complete / abandoned)

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
/** The line STATE of each status — what a ≤1.70 host (which drops `question`) shows: an open question is a BLOCKED context. */
export const QUESTION_LINE_STATE = Object.freeze({ asked: 'blocked', answered: 'done', expired: 'abandoned', withdrawn: 'abandoned' })
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
 * @returns {{ status:string, choices:string[], free:boolean, asked_at:number, expires_at?:number, answer?:{ choice?:string, text?:string }, by?:any, at?:number }|null}
 */
export function normQuestion(v) {
  if (!v || typeof v !== 'object' || !QUESTION_STATUSES.includes(v.status)) return null
  const choices = [], seen = new Set()
  for (const c of Array.isArray(v.choices) ? v.choices.slice(0, 32) : []) { const s = qChoice(c); if (s && !seen.has(lc(s)) && choices.length < QUESTION_LIMITS.choices) { seen.add(lc(s)); choices.push(s) } }
  const num = x => { const n = Number(x); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null }
  /** @type {any} */
  const out = { status: v.status, choices, free: v.free === true || !choices.length, asked_at: num(v.asked_at) || 0 }
  if (num(v.expires_at)) out.expires_at = num(v.expires_at)
  if (v.status === 'answered' && v.answer && typeof v.answer === 'object') {
    const a = {}, ch = qChoice(v.answer.choice), tx = qAnswerText(v.answer.text)
    if (ch) a.choice = ch
    if (tx) a.text = cpLen(tx) > QUESTION_LIMITS.answer ? cpSlice(tx, QUESTION_LIMITS.answer - 1) + '…' : tx
    if (a.choice || a.text) out.answer = a
  }
  if (v.status !== 'asked') {
    const by = normBy(v.by && typeof v.by === 'object' ? { ...v.by, kind: 'dashboard' } : v.by)
    if (by) out.by = by
    if (num(v.at)) out.at = num(v.at)
  }
  return out
}
/** A question as records / gossip carry it (plain JSON; `by` as { kind, user, host } or "bridge"). */
const qOut = q => { const n = normQuestion(q); return n ? compact({ ...n, choices: n.choices.length ? n.choices : null, free: n.free || null, by: n.by && typeof n.by === 'object' ? { ...n.by } : n.by }) : null }
/** A question as the board / the activity tool show it (`by` as { user, host }, or "bridge"). @param {any} q @returns {any} */
export const questionView = q => {
  const n = normQuestion(q)
  return n ? { status: n.status, choices: n.choices, free: n.free, ...compact({ asked_at: n.asked_at || null, expires_at: n.expires_at || null, answer: n.answer || null,
    by: n.by && typeof n.by === 'object' ? { user: n.by.user, host: n.by.host } : n.by || null, at: n.at || null }) } : null
}
/** The answer as one line for people: "Postgres — because the rest of the stack uses it" / just the choice / just the text. */
export function answerText(a, max = 160) {
  const parts = []
  if (a && a.choice) parts.push(a.choice)
  if (a && a.text) parts.push(normText(a.text))
  const s = parts.join(' — ')
  return cpLen(s) > max ? cpSlice(s, max - 1).trimEnd() + '…' : s
}
/** Is this node a question (its current line carries one)? */
export const isQuestion = n => !!(n && n.kind !== 'agent' && n.current && n.current.question)
/** Is this node an OPEN question (asked, awaiting an answer)? */
export const isOpenQuestion = n => isQuestion(n) && n.current.question.status === 'asked'

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
 * @typedef {{ done:number, total:number, unit:string, skipped?:number }} ActivityProgress
 * @typedef {{
 *   segs: PathSeg[], path: string, key: string, agent: string|null, context: string, root: boolean, current: boolean,
 *   text: string, state: string|null, progress?: ActivityProgress|null, eta_at?: number|null, stale_after_ms: number|null,
 *   details: string|null, data: any, log: boolean, warnings: string[], plan?: string[], keepText?: boolean, planOnly?: boolean,
 *   pos?: any, posOnly?: boolean, move?: { toSegs: PathSeg[], toPath: string, toKey: string },
 *   ask?: { choices: string[], free: boolean, expires_at: number|null }, withdraw?: { note: string|null } }} ActivityMsg
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
  const pos = parsePosition(input); if (!pos.ok) return pos
  if (has(input, 'move') || has(input, 'to')) return parseMove(input, pos.pos, warnings)   // #82: a MOVE (re-parent) is its own operation
  if (ASK_FIELDS.some(k => input[k] !== undefined && input[k] !== null)) return parseAsk(input, opts, pos.pos, log)   // #85: a QUESTION is its own operation
  if (isWithdrawn(input.state)) return parseWithdraw(input, opts, pos.pos, log)                                    // #85: the asker withdraws its question
  let plan = null
  if (input.plan !== undefined) { const pl = parsePlan(input.plan); if (!pl.ok) return pl; plan = pl.names; if (pl.warning) warnings.push(pl.warning) }
  let state = null
  if (has(input, 'state')) {
    state = typeof input.state === 'string' ? input.state.trim().toLowerCase() : ''
    if (!ACTIVITY_STATES.includes(state)) return bad('bad-state', `state must be one of ${ACTIVITY_STATES.join('|')} (or withdrawn: a question you asked)`)
  }
  const bar = has(input, 'progress') || has(input, 'eta')   // a bar update may omit text: it defaults to a template
  if (input.text != null && typeof input.text !== 'string') return bad('bad-text', 'text must be a string')
  const ad = resolveAddress(input, { text: input.text || '' }); if (!ad.ok) return ad
  let text = normText(ad.text), keepText = false, planOnly = false, posOnly = false
  if (!text) {
    if (bar) text = has(input, 'progress') ? '{progress}' : '{eta}'   // #70: the default text of a bar update (rendered at read time)
    else if (state && ad.current) keepText = true                     // 6b: a tick (`@~…/@B` + state) keeps the line's text
    else if (plan && !state) planOnly = true                          // 6b: just the plan (the target gets no message of its own)
    else if (pos.pos && !state) posOnly = true                        // #82: just a placement (the entry says where it went)
    else if (typeof input.text !== 'string') return bad('bad-text', 'text must be a string (it may be omitted only with progress / eta, a plan, a position, or a state on an @~ line)')
    else return bad('text-empty', 'text is empty (a context prefix alone is not a message)')
  }
  if (cpLen(text) > ACTIVITY_LIMITS.text) { text = cpSlice(text, ACTIVITY_LIMITS.text - 1) + '…'; warnings.push('text-truncated') }
  const segs = ad.segs, oi = ownerIndex(segs), tgt = segs[segs.length - 1]
  if (state && PLAN_STATES.has(state) && (!tgt || tgt.kind === 'agent')) return bad('bad-agent-state', `${state} is a plan state — only a context (a plan item) can be ${state}; an agent or the session reports running|blocked|failed|done|idle`)
  if (plan && segs.length + 1 > ACTIVITY_LIMITS.depth) return tooDeep(segs.length + 1)
  if (pos.pos && !plan && !segs.length) return bad('bad-position', 'before / after / position place a node among its siblings — the session root has none (address a node with path)')
  /** @type {ActivityMsg} */
  const msg = { segs, path: ad.path, key: ad.key, agent: oi ? formatPath(segs.slice(0, oi)) : null, context: tgt && tgt.kind === 'context' ? tgt.name : 'root',
    root: !tgt || tgt.kind === 'agent', current: ad.current, text, state, stale_after_ms: null, details: null, data: null, log, warnings,
    ...(plan ? { plan } : {}), ...(keepText ? { keepText } : {}), ...(planOnly ? { planOnly } : {}), ...(pos.pos ? { pos: pos.pos } : {}), ...(posOnly ? { posOnly } : {}) }
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
/**
 * #82: an ANCHOR — the sibling a node goes before / after. "@Docs" / "@\"Two words\"" = a context; a bare name = an agent of that
 * name when the parent has one, else a context ("Build docs", "Docs"). Resolved against the actual siblings in apply.
 * @param {any} raw @returns {ActivityResult} { ok, anchor:{ ref, kind:'context'|'either', name } }
 */
export function parseAnchor(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return bad('bad-position', 'before / after name a sibling: "Docs", "@Docs" or an agent\'s name')
  const s = raw.trim()
  if (s[0] === '@') {
    const r = scanPath(s, 0, false)
    if (!r.ok) return bad('bad-position', `anchor "${cpSlice(s, 40)}": ${r.what}`)
    if (r.segs.length !== 1 || r.segs[0].current || r.segs[0].root) return bad('bad-position', `anchor "${cpSlice(s, 40)}" must be ONE sibling (no / , @~ or @root)`)
    return { ok: true, anchor: { ref: s, kind: 'context', name: r.segs[0].name } }
  }
  if (s.includes('/')) return bad('bad-position', `anchor "${cpSlice(s, 40)}" must be ONE sibling's name (no /)`)
  const n = normContextName(s)
  if (!n.ok) return bad('bad-position', `anchor "${cpSlice(s, 40)}": ${n.what}`)
  return { ok: true, anchor: { ref: s, kind: SEGMENT.test(s) && cpLen(s) <= ACTIVITY_LIMITS.pathSegment ? 'either' : 'context', name: n.name } }
}
/** #82: before / after / position (first | last) — at most one. → { ok, pos: null | { before? | after? : anchor, position? } } */
function parsePosition(input) {
  const given = ['before', 'after', 'position'].filter(k => has(input, k))
  if (!given.length) return { ok: true, pos: null }
  if (given.length > 1) return bad('bad-position', `give ONE of before / after / position (got ${given.join(' + ')})`)
  if (given[0] === 'position') {
    const p = typeof input.position === 'string' ? input.position.trim().toLowerCase() : ''
    if (p !== 'first' && p !== 'last') return bad('bad-position', 'position must be "first" or "last" (or give before / after a sibling)')
    return { ok: true, pos: { position: p } }
  }
  const a = parseAnchor(input[given[0]]); if (!a.ok) return a
  return { ok: true, pos: { [given[0]]: a.anchor } }
}
/** Segments of a path RELATIVE to `base` (a leading "/" = from the session root); '/' alone = the root. */
function relSegs(base, raw, what) {
  if (typeof raw !== 'string' || !raw.trim()) return bad('bad-move', `${what} must be a path like "@Next release/@Docs" (relative to path; a leading "/" = from the session root)`)
  const s = raw.trim(), abs = s.startsWith('/')
  const p = parsePath(s)
  if (!p.ok) return bad(p.code === 'path-too-deep' ? 'path-too-deep' : 'bad-move', `${what}: ${p.what}`)
  if (p.current) return bad('bad-move', `${what} names a node, not a current line (no @~)`)
  const segs = abs ? p.segs : [...base, ...p.segs]
  if (segs.length > ACTIVITY_LIMITS.depth) return tooDeep(segs.length)
  return { ok: true, segs }
}
const MOVE_ONLY = ['text', 'context', 'state', 'progress', 'eta', 'stale_after', 'details', 'data', 'plan']
/**
 * #82: a MOVE — `move` (the node to move) and `to` (its NEW PARENT; "/" = the session root), both RELATIVE to the message's
 * address (path / agent; a leading "/" = from the session root) — plus an optional before / after / position among the new
 * siblings (default: the end of its group). A move is its own operation: it takes no text / state / bar / plan (the entry it
 * writes says "moved by … from … to …"). → { ok, msg } with msg.move = { toSegs, toPath, toKey } and segs/path/key = the node.
 */
function parseMove(input, pos, warnings) {
  if (!has(input, 'move')) return bad('bad-move', 'to is the NEW PARENT of a move — give move (the node to move) too')
  if (!has(input, 'to')) return bad('bad-move', 'move needs to: the new parent ("/" = the session root)')
  const extra = MOVE_ONLY.filter(k => input[k] !== undefined && input[k] !== null && !(k === 'text' && input.text === ''))
  if (extra.length) return bad('bad-move', `a move takes only path / agent (the base its paths are relative to), move, to and before / after / position — not ${extra.join(', ')}`)
  const ad = resolveAddress({ agent: input.agent, path: input.path }); if (!ad.ok) return ad
  if (ad.current) return bad('bad-move', 'the base path of a move names a node (no @~)')
  const f = relSegs(ad.segs, input.move, 'move'); if (!f.ok) return f
  if (!f.segs.length) return bad('bad-move', 'the session root can\'t be moved — move a node under it')
  const t = relSegs(ad.segs, input.to, 'to'); if (!t.ok) return t
  const path = formatPath(f.segs), toPath = formatPath(t.segs), oi = ownerIndex(f.segs), tgt = f.segs[f.segs.length - 1]
  const key = pathKey(path), toKey = pathKey(toPath)
  if (toKey === key || toKey.startsWith(key + '/')) return bad('bad-move', `"${path}" can't move into itself`)
  /** @type {ActivityMsg} */
  const msg = { segs: f.segs, path, key, agent: oi ? formatPath(f.segs.slice(0, oi)) : null, context: tgt.kind === 'context' ? tgt.name : 'root', root: tgt.kind === 'agent', current: false,
    text: '', state: null, stale_after_ms: null, details: null, data: null, log: true, warnings, move: { toSegs: t.segs, toPath, toKey }, ...(pos ? { pos } : {}) }
  return { ok: true, msg }
}
/**
 * #85: a QUESTION — `ask` (the question: one line, ≤ 240 code points; longer is REFUSED 'question-too-long' — a cut question is no
 * question) + optional `choices` (≤ 8 distinct, each ≤ 60 code points), `free` (free text allowed; default: only when there are no
 * choices) and `expires` (a duration > 0, ≤ 7 days: the question becomes expired, unanswered, after it). Addressed like any message
 * (path / agent / context; the question text is taken LITERALLY — a leading "@…" is not a path); the node is decided in apply
 * (applyAsk). It may carry details / data (context for whoever answers) and stale_after; not text / state / a bar / a plan / a
 * move / a position, and it is always logged. → msg with msg.ask = { choices, free, expires_at|null }, text = the question, state
 * = blocked, current.
 */
function parseAsk(input, opts, pos, log) {
  if (!has(input, 'ask')) return bad('bad-ask', 'choices / free / expires belong to a question — give ask (the question) too')
  if (typeof input.ask !== 'string') return bad('bad-ask', 'ask must be a string: the question')
  const question = normText(input.ask)
  if (!question) return bad('bad-ask', 'the question (ask) is empty')
  if (cpLen(question) > ACTIVITY_LIMITS.text) return bad('question-too-long', `a question is at most ${ACTIVITY_LIMITS.text} characters (got ${cpLen(question)}) — shorten it (put background in details)`)
  const extra = ['state', 'progress', 'eta', 'plan', 'move', 'to'].filter(k => has(input, k))
  if (has(input, 'text') && !(typeof input.text === 'string' && !input.text.trim())) extra.unshift('text')
  if (pos) extra.push('before / after / position')
  if (extra.length) return bad('bad-ask', `a question takes path / agent / context, ask, choices, free, expires, details, data and stale_after — not ${extra.join(', ')} (the question goes in ask)`)
  if (log === false) return bad('bad-ask', 'a question is always logged (log:false can\'t go with ask)')
  const choices = [], seen = new Set()
  if (input.choices != null) {
    if (!Array.isArray(input.choices)) return bad('bad-choices', 'choices must be an array of strings, e.g. ["Postgres", "SQLite"]')
    if (input.choices.length > QUESTION_LIMITS.choices) return bad('bad-choices', `a question has at most ${QUESTION_LIMITS.choices} choices (got ${input.choices.length})`)
    for (const c of input.choices) {
      if (typeof c !== 'string' || !normText(c)) return bad('bad-choices', 'each choice must be a non-empty string')
      const s = normText(c)
      if (cpLen(s) > QUESTION_LIMITS.choice) return bad('bad-choices', `choice "${cpSlice(s, 30)}…" is longer than ${QUESTION_LIMITS.choice} characters`)
      if (seen.has(lc(s))) return bad('bad-choices', `choice "${cpSlice(s, 40)}" is given twice`)
      seen.add(lc(s)); choices.push(s)
    }
  }
  let free = !choices.length
  if (input.free !== undefined && input.free !== null) {
    const b = boolVal(input.free)
    if (b === null) return bad('bad-ask', 'free must be true (free text allowed) or false')
    free = b
  }
  if (!choices.length && !free) return bad('bad-ask', 'a question needs choices, free text, or both (free:false with no choices can\'t be answered)')
  let expires_at = null
  if (has(input, 'expires')) {
    const ms = parseDuration(input.expires)
    if (!Number.isFinite(ms) || ms <= 0 || ms > QUESTION_LIMITS.expiresMaxMs) return bad('bad-expires', 'expires must be a duration > 0 and ≤ 7 days, e.g. "2h" or "30m"')
    if (!Number.isFinite(opts.now)) return bad('bad-expires', 'expires needs the current time (parseMessage opts.now)')
    expires_at = opts.now + ms
  }
  // the address + details / data / stale_after, checked the usual way (a placeholder text: the question is set below, literally)
  const base = parseMessage({ agent: input.agent, path: input.path, context: input.context, text: 'x', details: input.details, data: input.data, stale_after: input.stale_after }, opts)
  if (!base.ok) return base
  const msg = base.msg
  Object.assign(msg, { text: question, state: 'blocked', current: true, log: true, ask: { choices, free, expires_at } })
  return { ok: true, msg }
}
/**
 * #85: the asker WITHDRAWS its question — state "withdrawn" on the question node (its path; no `@~` needed). Optional text = a note for
 * the log ("withdrawn: <text>"); the line keeps the question. → msg with msg.withdraw = { note }, keepText, current, state abandoned.
 */
function parseWithdraw(input, opts, pos, log) {
  const extra = ['progress', 'eta', 'plan'].filter(k => has(input, k))
  if (pos) extra.push('before / after / position')
  if (extra.length) return bad('bad-state', `withdrawn (a question) takes path / agent / context and an optional text note — not ${extra.join(', ')}`)
  if (log === false) return bad('bad-state', 'withdrawing a question is always logged (log:false can\'t go with state withdrawn)')
  if (input.text != null && typeof input.text !== 'string') return bad('bad-text', 'text must be a string')
  const base = parseMessage({ agent: input.agent, path: input.path, context: input.context, text: 'x', details: input.details, data: input.data, stale_after: input.stale_after }, opts)
  if (!base.ok) return base
  const msg = base.msg
  if (msg.root) return bad('not-a-question', `"${msg.path || '@root'}" is ${msg.path ? 'an agent' : 'the session'} — state withdrawn is for a question you asked (its path)`)
  let note = typeof input.text === 'string' ? normText(input.text) : ''
  if (cpLen(note) > ACTIVITY_LIMITS.text) { note = cpSlice(note, ACTIVITY_LIMITS.text - 1) + '…'; msg.warnings.push('text-truncated') }
  Object.assign(msg, { text: '', keepText: true, state: 'abandoned', current: true, log: true, withdraw: { note: note || null } })
  return { ok: true, msg }
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
 *   has_details?:boolean, has_data?:boolean, by?:any, question?:any }} ActivityLine   (#83: by = who wrote its text when not its session — a dashboard edit; #85: question = the line's question)
 * @typedef {{ key:string, path:string, name:string, kind:'agent'|'context', parent:string|null, depth:number,
 *   created_at:number, last_activity:number, stale_after_ms:number|null, current:ActivityLine|null,
 *   progress:ActivityProgress|null, eta_at:number|null, finished_at:number|null, gone_at:number|null, implicit:boolean,
 *   log:any[], log_dropped:number, log_floor:number, persisted?:boolean, cp_dirty?:number, plan?:boolean, plan_ix?:number|null,
 *   pt?:{ a:number, l:number, p:number, e:number, r?:number, m?:number }, partial?:boolean, cpartial?:boolean, log_n?:number, plan_end?:{ state:string, ts:number }|null,
 *   rank?:string|null, moved?:{ from:string, at:number }[]|null }} ActivityNode
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
// `partial` (6c): the node's current RUN began before the replay window (the replay never saw the record that began it), so
// its in-memory log count understates and its run start may lie in a day file retention already deleted. `log_n` (6c): a
// REMOTE node's gossiped own-entry count (a local node counts its log + log_dropped). `cpartial` (6d): that COUNT understates
// (the run began before the window AND no carry-forward brought the exact count — a remote node: the owner said so).
// `plan_end` (6d): the PLAN-END MARKER of an agent / the session holding a plan — { state: 'done'|'abandoned', ts } or null.
const CP_CUR = 1, CP_PROG = 2, CP_ETA = 4
/** @returns {ActivityNode} */
function newNode(path, segs, now) {
  const last = segs.length ? segs[segs.length - 1] : null, key = pathKey(path)
  return { key, path, name: last ? last.name : '', kind: last ? last.kind : 'agent', parent: parentKeyOf(key), depth: segs.length, created_at: now, last_activity: now,
    stale_after_ms: null, current: null, progress: null, eta_at: null, finished_at: null, gone_at: null, implicit: true, log: [], log_dropped: 0, log_floor: 0, persisted: false, cp_dirty: 0,
    plan: false, plan_ix: null, pt: { a: 0, l: 0, p: 0, e: 0, r: 0, m: 0 }, partial: false, cpartial: false, plan_end: null, rank: null, moved: null }
}
/** 6d: a plan-end marker from a record / the wire: { state, ts } (state done | abandoned), else null. */
const wPlanEnd = v => (v && typeof v === 'object' && PLAN_END.has(v.state) && Number.isFinite(Number(v.ts)) && Number(v.ts) >= 0 ? { state: v.state, ts: Math.floor(Number(v.ts)) } : null)
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
/**
 * 6c (#70 "Decisions before 6c and 6d" 7): every key that is an item of an OPEN plan (planEndAt null), or an ancestor of
 * one — a subtree rooted at k holds part of an open plan iff k is in the set. Such nodes never expire and are never evicted
 * (6b protected only todo / running / blocked items; now every item of a plan that has not ended, whatever its state).
 */
function openPlanKeys(sess) {
  const out = new Set()
  for (const n of sess.nodes.values()) {
    const p = planOf(sess, n)
    if (!p || planEndAt(sess, n, p) != null) continue
    for (const it of p.items) for (let k = it.key; k != null && !out.has(k); k = parentKeyOf(k)) out.add(k)
  }
  return out
}
/**
 * A node's PLAN = its plan-item children (null when it has none): { items, open, allDoneAt } — open = how many are todo /
 * running / blocked; allDoneAt (6c) = when the last item became done, once EVERY item is done (else null).
 */
function planOf(sess, node) {
  const kids = childrenOf(sess, node), items = kids.filter(c => c.plan)
  if (!items.length) return null
  for (const c of kids) if (!c.plan && isQuestion(c)) items.push(c)   // #85: a question under a plan node is one of its items (open = blocked: the plan stays open)
  let open = 0, doneAt = 0, all = true
  for (const it of items) {
    const s = stateOf(it)
    if (OPEN_ITEM.has(s)) open++
    if (s === 'done') doneAt = Math.max(doneAt, it.current ? it.current.ts : 0); else all = false
  }
  return { items, open, allDoneAt: all ? doneAt : null }
}
/**
 * 6c: when a plan ENDED (it expires finished_visible_hours later), or null while it is OPEN. A plan ends only when EVERY item
 * is done (the last one's time), or when its node is set done (complete) or abandoned (that line's time) — whichever came
 * first. Skipped, failed, idle, todo, running and blocked items all keep it open, and its owner finishing no longer ends it
 * (this supersedes 6b's "done or skipped ends a plan").
 */
function planEndAt(sess, node, p) {
  if (!p) return null
  const ends = []
  if (p.allDoneAt != null) ends.push(p.allDoneAt)
  // 6d (#70 "Decisions after 6c, for 6d" 1): only a CONTEXT plan node's own line ends its plan — an agent's (or the session's)
  // line finishing done no longer completes the plan it holds; that takes the explicit plan-end marker (complete / abandon)
  if (node.kind === 'context' && node.current && PLAN_END.has(node.current.state)) ends.push(node.current.ts || 0)
  if (node.plan_end && PLAN_END.has(node.plan_end.state)) ends.push(node.plan_end.ts || 0)
  return ends.length ? Math.min(...ends) : null
}
/** 6d: HOW a plan ended — 'all-done' (every item done: only reopening an item reopens it), 'done' (marked complete) or
 * 'abandoned' — or null while it is open. */
function planEndHow(sess, node, p) {
  if (!p || planEndAt(sess, node, p) == null) return null
  if (p.allDoneAt != null) return 'all-done'
  if (node.kind === 'context' && node.current && PLAN_END.has(node.current.state)) return node.current.state
  return node.plan_end ? node.plan_end.state : null
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
 * The subtrees that may be EVICTED for a message to `targetKey` (the hard limits), oldest first: finished agents (6a) and
 * ENDED plans (6c: planEndAt — all done, or the node marked complete / abandoned; planRemoval). Never one holding part of an
 * OPEN plan (#70 "Decisions before 6b" 3), never one the target is at or under (nor a plan whose node the target is at or
 * under, except the session's own). Each: { at, key, roots:[subtree root keys] }.
 */
function evictionCandidates(sess, targetKey) {
  const open = openPlanKeys(sess), out = []
  for (const n of sess.nodes.values()) {
    if (n.key && n.kind === 'agent' && n.finished_at && !under(targetKey, n.key) && !open.has(n.key)) out.push({ at: n.finished_at, key: n.key, roots: [n.key] })
    const p = planOf(sess, n), end = p ? planEndAt(sess, n, p) : null
    if (end != null && !p.items.some(i => open.has(i.key)) && !(n.key && under(targetKey, n.key))) {
      const roots = planRemoval(sess, n, p)
      if (!roots.some(r => under(targetKey, r))) out.push({ at: end, key: n.key, roots })
    }
  }
  return out.sort((a, b) => a.at - b.at || cmp(a.key, b.key))
}
/** The small in-memory log entry of a (logged) message or a JSONL entry — the SAME shape from both (replay equality). */
function smallOf(e) {
  const s = compact({ id: e.id, ts: e.ts, current: !!e.current, text: e.text, state: e.state,
    progress: e.progress || undefined, eta_at: e.eta_at || undefined, stale_after_ms: e.stale_after_ms || undefined,
    has_details: e.has_details ? true : undefined, has_data: e.has_data ? true : undefined, by: normBy(e.by) || undefined,   // 6c: by = who wrote it when not the session (the bridge); 6d: or a dashboard { kind, user, host }
    act: typeof e.act === 'string' && ACTIVITY_ACTIONS.includes(e.act) ? e.act : undefined })   // 6d: the dashboard action that wrote it
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
  for (const n of span) { const p = n.pt || (n.pt = { a: 0, l: 0, p: 0, e: 0, r: 0, m: 0 }); if (ts > p.a) p.a = ts }
  const p = tgt.pt || (tgt.pt = { a: 0, l: 0, p: 0, e: 0, r: 0, m: 0 })
  if (what.line && ts > p.l) p.l = ts
  if (what.prog && ts > p.p) p.p = ts
  if (what.eta && ts > p.e) p.e = ts
  if (what.rank && ts > (p.r || 0)) p.r = ts     // #82: the stored rank
  if (what.moved && ts > (p.m || 0)) p.m = ts    // #82: the moved_from history
}
/** The record fields of a plan item (6b): the marker + its plan position. */
const planFields = n => (n && n.plan ? { plan_item: true, ...(Number.isInteger(n.plan_ix) ? { plan_ix: n.plan_ix } : {}) } : {})
const cpId = (sKey, nKey) => JSON.stringify([sKey, nKey])
const fullLine = l => (l ? { id: l.id, ts: l.ts, text: l.text, state: l.state, details: l.details || null, data: l.data != null ? l.data : null, ...(l.by ? { line_by: l.by } : {}), ...(l.question ? { question: qOut(l.question) } : {}) } : null)   // #83: + line_by; #85: + question

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
 * - 6c: `abandoned` only on a plan item or a plan NODE (one holding plan items — an agent or the session too, which it then
 *   finishes like done / failed); anything else → 'not-a-plan'. opts.by (e.g. "bridge") makes it a SYSTEM message: it is
 *   attributed (`by` on the entry and the record) and touches NO activity — no last_activity, stale_after, gone or implicit
 *   change beyond its target — so an auto-abandon never makes a gone session look alive.
 * Every record carries `s0` = the session's created_at (6c: the replay keeps it exact, so the HOME host is stable).
 * @param {ActivityState} state
 * @param {{ session:string, project?:string, user?:string|null, realm?:string, host?:string }} ident  the reporting session
 * @param {ActivityMsg} msg  parseMessage(...).msg
 * @param {number} now
 * @param {{ by?: any, act?: string, entryText?: string, planEnd?: string, cascade?: boolean, question?: any }} [opts]  by (6d) may be a dashboard { kind, user, host }; act / entryText (the LOG text; the line keeps its own) / planEnd (done | abandoned | open); cascade:false (#82) = no abandon cascade (the cascade's own entries); question (#85) = the line's new question object (applyAsk, an answer, the expiry)
 * @returns {ActivityResult} { ok:true, id, ts, logged, entry, records, current, state, stale_at, path, agent, context,
 *   evicted:string[], warnings:string[], plan? } or { ok:false, code, what } — `records` = every JSONL record this call
 *   wrote, in order (the target's entry first, then each new plan item's)
 */
export function apply(state, ident, msg, now, opts = {}) {
  if (!state || !(state.local instanceof Map)) return bad('bad-state-object', 'pass a createActivity() state')
  if (!state.config.enabled) return bad('activity-disabled', 'the activity board is disabled on this host (activity.enabled)')
  if (!Number.isFinite(now)) return bad('bad-now', 'now must be a ms epoch')
  if (!msg || typeof msg.text !== 'string' || !(msg.text || msg.keepText || msg.planOnly || msg.posOnly || msg.move) || !Array.isArray(msg.segs)) return bad('bad-message', 'pass the msg from parseMessage()')
  if (msg.move) return applyMove(state, ident, msg, now, opts)   // #82: a re-parent is its own operation
  if (msg.ask) return applyAsk(state, ident, msg, now, opts)     // #85: a question — decides its node, then applies its line here
  const posOnly = !!msg.posOnly, logged = msg.log !== false || posOnly, planOnly = !!msg.planOnly   // #82: a placement is always logged (its rank must reach the files)
  const sessName = str(ident && ident.session)
  if (!sessName) return bad('bad-session', 'the reporting session needs a name')
  const L = ACTIVITY_LIMITS
  const sKey = keyOf(state, { realm: ident.realm, project: ident.project, user: ident.user, session: sessName })
  let sess = state.local.get(sKey)
  const segs = msg.segs, keys = chainKeys(segs), tKey = keys[keys.length - 1]
  const tgtKind = segs.length ? segs[segs.length - 1].kind : 'agent', tgt0 = sess ? sess.nodes.get(tKey) : null
  if (!planOnly && !posOnly && msg.state && PLAN_STATES.has(msg.state)) {   // 6b: todo / skipped are plan states
    if (tgtKind === 'agent') return bad('bad-agent-state', `${msg.state} is a plan state — only a context (a plan item) can be ${msg.state}`)
    if (!(tgt0 && tgt0.plan) && (msg.state === 'skipped' || !msg.current || (tgt0 && tgt0.current)))
      return bad('not-a-plan-item', `"${msg.path}" is ${tgt0 && tgt0.current ? 'an ordinary context (it already has a line of its own)' : 'not a plan item'} — ${msg.state} is for plan items: create them with plan:[…] (or a FIRST @~ line with state todo)`)
  }
  // 6c: abandoned only on plans + plan items; #82 (part 4): on ANY context — an agent / the session still only when it holds plan items
  if (!planOnly && !posOnly && msg.state === 'abandoned' && tgtKind !== 'context' && !(tgt0 && (tgt0.plan || childrenOf(sess, tgt0).some(c => c.plan))))
    return bad('not-a-plan', `"${msg.path || '@root'}" is ${msg.path ? 'an agent' : 'the session'} holding no plan — abandoned is for contexts, plan items and plans (an agent or the session that holds plan items)`)
  const by = normBy(opts && opts.by)   // 6c: a SYSTEM message (the bridge's); 6d: or a dashboard action's { kind, user, host }
  const act = opts && typeof opts.act === 'string' && ACTIVITY_ACTIONS.includes(opts.act) ? opts.act : null                                       // 6d: which action wrote it
  const entryText = opts && typeof opts.entryText === 'string' && normText(opts.entryText) ? cpSlice(normText(opts.entryText), L.text) : null   // 6d: the LOG text (the line keeps its own)
  const planEndOpt = opts && (PLAN_END.has(opts.planEnd) || opts.planEnd === 'open') ? opts.planEnd : null                                       // 6d: set / clear the plan-end marker
  // #85: a QUESTION's line is its question — the new one (applyAsk; an answer; the expiry) comes in opts.question; the asker's
  // withdrawal, or any abandon / cascade of an OPEN question, withdraws it; any other line on a question node is refused
  const q0 = tgt0 && tgt0.current && tgt0.current.question ? tgt0.current.question : null
  const qIn = opts && opts.question ? normQuestion(opts.question) : null
  let qLine = null, qEntry = null
  if (!planOnly && !posOnly && msg.current) {
    if (qIn) qLine = qIn
    else if (msg.withdraw) {
      if (!q0) return bad('not-a-question', `"${msg.path}" is not a question — state withdrawn withdraws a question you asked (ask)`)
      if (q0.status !== 'asked') return bad('question-closed', `the question "${msg.path}" is already ${q0.status}`)
      qLine = { ...q0, status: 'withdrawn', at: now, ...(by ? { by } : {}) }
      qEntry = cpSlice(`withdrawn${by ? ' ' + byText(by) : ''}${msg.withdraw.note ? ': ' + msg.withdraw.note : ''}`, L.text)
    } else if (q0) {
      if (msg.keepText && msg.state === 'abandoned' && q0.status === 'asked') qLine = { ...q0, status: 'withdrawn', at: now, ...(by ? { by } : {}) }   // abandoned / cascaded: an open question is withdrawn
      else return bad('question-node', `"${msg.path}" is a question — its line is the question: it is answered on the dashboard${q0.status === 'asked' ? ', or withdraw it (state withdrawn)' : '; ask again on it (ask) for a new one'}`)
    }
    if (qLine) qLine = normQuestion(qLine)
    if (qLine && msg.keepText && tgt0 && tgt0.current) msg = { ...msg, details: tgt0.current.details || null, data: tgt0.current.data != null ? tgt0.current.data : null }   // a status change keeps the question's details / data
  }
  // 6b: the plan's items under the target: new (create), an ordinary context with no line of its own (adopt), an item (keep)
  const items = []
  for (const name of msg.plan || []) {
    const seg = { kind: /** @type {'context'} */ ('context'), name }, key = pathKey(formatPath([...segs, seg])), ex = sess ? sess.nodes.get(key) : null
    items.push({ name, seg, key, ex, act: !ex ? 'create' : ex.plan ? 'keep' : !ex.current ? 'adopt' : 'other' })
  }
  // #82: where the PLACED nodes go — new plan items (a position with a plan), else the target itself — computed before anything
  // changes (atomic): the anchor must be a sibling of the same group (plan items / other contexts / agents)
  let ranks = null, placeTxt = null
  if (msg.pos) {
    if (msg.plan) {
      const k = items.filter(it => it.act === 'create').length
      if (k) { const r = placeRanks(sess, tKey, 0, msg.pos, k, null, now, true); if (!r.ok) return r; ranks = r.ranks }
      else (msg.warnings || []).push('position-unused')   // every name already exists: a re-plan never moves an item (reorder it on its own)
    } else {
      const willPlan = tgtKind === 'context' && ((tgt0 && tgt0.plan) || (msg.current && msg.state === 'todo' && !(tgt0 && tgt0.current)))
      const r = placeRanks(sess, parentKeyOf(tKey), willPlan ? 0 : tgtKind === 'context' ? 1 : 2, msg.pos, 1, tKey, now, !tgt0)
      if (!r.ok) return r
      ranks = r.ranks; placeTxt = r.text
    }
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
    if (by) return           // 6c: a system message (auto-abandon) is nobody's activity
    sess.last_activity = Math.max(sess.last_activity, now)   // max(): a report timed earlier than one already applied never moves activity back
    for (const n of span) { n.last_activity = Math.max(n.last_activity, now); n.stale_after_ms = msg.stale_after_ms || null }
    sess.gone_at = null; owner.gone_at = null
  }
  const res = { ok: true, id: null, ts: now, logged: false, entry: null, records: [], current: false, state: stateOf(tgt), stale_at: null, path: tgt.path,
    agent: oi ? owner.path : null, context: tgt.kind === 'context' ? tgt.name : 'root', evicted, warnings: msg.warnings || [] }
  if (!planOnly) {   // ---- the message to the target itself
    tgt.implicit = false; if (!by) owner.implicit = false
    const cur = !!msg.current && !posOnly   // #82: a placement alone never sets the line
    const before = { cur: tgt.current, prog: JSON.stringify(tgt.progress), eta: tgt.eta_at }
    const c0 = tgt.current
    let entryState = msg.state || (c0 ? c0.state : null) || 'running'
    if (!msg.state && cur && tgt.plan && c0 && c0.state === 'todo') entryState = 'running'   // 6b: a line on a ☐ item starts it
    const text = posOnly ? cpSlice(placeTxt + (by ? ' ' + byText(by) : ''), L.text) : msg.keepText ? (c0 ? c0.text : (tgt.name || entryState)) : msg.text   // 6b: a tick keeps the line's text; #82: a placement says where
    if (cur && msg.state === 'todo' && tgt.kind === 'context' && !tgt.plan) tgt.plan = true   // 6b: a first line of todo makes a plan item (validated above)
    const rankSet = !msg.plan && !!(ranks && ranks[0])
    if (rankSet) tgt.rank = ranks[0]   // #82: placed (before / after / first / last)
    const id = `${state.idPrefix}${now.toString(36)}-${(++state.seq).toString(36)}`
    touch(chain.slice(oi))
    let lineId = id, planEnd = planEndOpt
    if (cur) {
      // a log:false line IDENTICAL to the current one (text, state, details, data) keeps it — "alive, unchanged" (a rep, not a cp)
      // #83: who wrote the line's TEXT when not its session — a dashboard edit; a tick that keeps the text keeps it; any other line clears it
      const lineBy = msg.keepText ? (c0 && c0.by) || null : act === 'edit_text' && by && typeof by === 'object' ? by : null
      const same = !logged && c0 && c0.text === text && c0.state === entryState && (c0.details || null) === (msg.details || null)
        && JSON.stringify(c0.data != null ? c0.data : null) === JSON.stringify(msg.data != null ? msg.data : null) && (c0.by || null) === lineBy   // #83: the session re-sending an edited text takes the line back
      if (same) lineId = c0.id
      else tgt.current = { id, ts: now, text, state: entryState, details: msg.details || null, data: msg.data != null ? msg.data : null,
        data_bytes: msg.data != null ? utf8(JSON.stringify(msg.data)) : 0, ...(lineBy ? { by: lineBy } : {}), ...(qLine ? { question: qLine } : {}) }   // #85: a question line
      if (tgt.kind === 'agent') {
        if (DONE_OR_FAILED.has(entryState)) { if (!tgt.finished_at) tgt.finished_at = now }
        else tgt.finished_at = null
        // 6d: the tool's `abandoned` on an agent / the session holding a plan keeps 6c's meaning — it finishes it AND ends its plan
        // (now through the plan-end marker: an agent's line alone no longer ends a plan)
        if (entryState === 'abandoned' && !planEndOpt) planEnd = 'abandoned'
      }
    }
    if (planEnd) tgt.plan_end = planEnd === 'open' ? null : { state: planEnd, ts: now }   // 6d: set / clear the plan-end marker
    if ('progress' in msg) tgt.progress = msg.progress ? { ...msg.progress } : null   // ANY message moves the bar
    if ('eta_at' in msg) tgt.eta_at = msg.eta_at || null
    if (DONE_OR_FAILED.has(stateOf(tgt))) tgt.eta_at = null                          // dropped on done/failed, ignored while it is
    Object.assign(res, { id: lineId, logged, current: cur, state: entryState, stale_at: staleAt(tgt, state.config.stale_after_min, owner), ...(rankSet ? { rank: tgt.rank } : {}),
      ...(cur && qLine ? { question: questionView(qLine) } : {}) })   // #85
    if (!logged) {   // the board only: mark what changed for the next checkpoint, and the node as live this interval
      const bits = (tgt.current !== before.cur ? CP_CUR : 0) | (JSON.stringify(tgt.progress) !== before.prog ? CP_PROG : 0) | (tgt.eta_at !== before.eta ? CP_ETA : 0)
      tgt.cp_dirty = (tgt.cp_dirty || 0) | bits
      state.cpLive.set(cpId(sKey, tKey), [sKey, tKey])
    } else {
      const small = smallOf({ id, ts: now, current: cur, text: entryText || qEntry || text, state: entryState,
        progress: 'progress' in msg ? msg.progress : undefined, eta_at: 'eta_at' in msg ? msg.eta_at : undefined, stale_after_ms: msg.stale_after_ms,
        has_details: !!msg.details, has_data: msg.data != null, by, act })
      logInsert(tgt, small)
      while (tgt.log.length > cap) logDropOldest(tgt)
      // this entry persists what it carries: the line (+ its state, and a done/failed line's dropped ETA), the bar, the ETA
      const etaW = 'eta_at' in msg || (cur && DONE_OR_FAILED.has(entryState))
      if (tgt.cp_dirty) tgt.cp_dirty &= ~((cur ? CP_CUR : 0) | (etaW ? CP_ETA : 0) | ('progress' in msg ? CP_PROG : 0))
      notePersisted(by ? [] : chain.slice(oi), tgt, { line: cur, prog: 'progress' in msg, eta: etaW, rank: rankSet }, now)
      res.entry = { v: ACTIVITY_FORMAT, ...small, current: cur, path: tgt.path, origin: state.origin, realm: sess.realm, session: sess.session, project: sess.project, user: sess.user, host: sess.host, s0: sess.created_at,
        details: msg.details || null, data: msg.data != null ? msg.data : null, ...planFields(tgt), ...persistMarks(chain),
        ...(cur && tgt.kind === 'agent' ? { finished_at: tgt.finished_at } : {}),
        ...(cur && (entryText || qEntry) && (entryText || qEntry) !== text ? { line_text: text } : {}),   // 6d: the LINE kept its text; the entry says what was done (+ by whom)
        ...(cur && tgt.current && tgt.current.by ? { line_by: tgt.current.by } : {}),   // #83: who wrote the line's text (a dashboard edit; kept by a tick)
        ...(cur && tgt.current && tgt.current.question ? { question: qOut(tgt.current.question) } : {}),   // #85: the line's question (status, choices, the answer …)
        ...(planEnd ? { plan_end: planEnd } : {}), ...(rankSet ? { rank: tgt.rank } : {}) }   // #82: the node's new position
      res.records.push(res.entry)
    }
    // #82 (part 5): CASCADE — abandoning a context / plan / plan item (or an agent / the session holding a plan) abandons its OPEN
    // descendants too (not crossing another agent), each with an entry saying why — as the dashboard's "Abandon plan" does
    if (cur && entryState === 'abandoned' && !(opts && opts.cascade === false)) {
      const cs = cascadeAbandon(state, sess, tgt, now, { by, act })
      if (cs.records.length) { res.records.push(...cs.records); res.cascade = cs.done }
    }
  }
  if (msg.plan) {   // ---- 6b: the plan's items, in the given order (each a LOGGED ☐ line)
    const out = []
    let ci = 0
    items.forEach((it, ix) => {
      let n = it.ex && sess.nodes.has(it.key) ? it.ex : null
      if (it.act === 'create') { n = newNode(childPath(tgt, it.seg), [...segs, it.seg], now); addNode(sess, n); if (ranks && ranks[ci]) n.rank = ranks[ci]; ci++ }   // #82: inserted at a position (in the given order)
      if (n && (it.act === 'create' || it.act === 'adopt')) {
        const ichain = [...chain, n], rk = it.act === 'create' && !!n.rank
        n.plan = true; n.plan_ix = ix; n.implicit = false; owner.implicit = false
        touch(ichain.slice(oi))
        const id = `${state.idPrefix}${now.toString(36)}-${(++state.seq).toString(36)}`
        n.current = { id, ts: now, text: it.name, state: 'todo', details: null, data: null, data_bytes: 0 }
        const small = smallOf({ id, ts: now, current: true, text: it.name, state: 'todo', stale_after_ms: msg.stale_after_ms })
        logInsert(n, small)
        while (n.log.length > cap) logDropOldest(n)
        notePersisted(ichain.slice(oi), n, { line: true, rank: rk }, now)
        res.records.push({ v: ACTIVITY_FORMAT, ...small, current: true, path: n.path, origin: state.origin, realm: sess.realm, session: sess.session, project: sess.project, user: sess.user, host: sess.host, s0: sess.created_at,
          details: null, data: null, ...planFields(n), ...persistMarks(ichain), ...(rk ? { rank: n.rank } : {}) })
      }
      out.push({ ...compact({ name: n ? n.name : it.name, path: n ? n.path : childPath(tgt, it.seg), created: it.act === 'create', adopted: it.act === 'adopt', rank: it.act === 'create' && n && n.rank ? n.rank : null }), plan_item: !!(n && n.plan), state: n ? stateOf(n) : null })
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
 * #85: ASK — decide the QUESTION's node, then apply its line. The addressed node itself when it is a CONTEXT that is new, has no
 * line, no children and is not a plan item, or is already a question (asking again on a CLOSED one starts a new question there;
 * on an OPEN one → 'question-open'); otherwise (an agent, the session, a context with a line or children, a plan item) a new
 * child context `@?<n>` (n = 1 + the highest `?<digits>` among its children). The line: text = the question, state blocked,
 * question = { status:"asked", choices, free, asked_at, expires_at? } — logged, the session's own message (activity as usual).
 */
function applyAsk(state, ident, msg, now, opts = {}) {
  const sessName = str(ident && ident.session)
  if (!sessName) return bad('bad-session', 'the reporting session needs a name')
  const sess = state.local.get(keyOf(state, { realm: ident.realm, project: ident.project, user: ident.user, session: sessName }))
  const segs = msg.segs, node = sess ? sess.nodes.get(msg.key) : null, last = segs.length ? segs[segs.length - 1] : null
  const self = !!last && last.kind === 'context' && (!node || isQuestion(node) || (!node.current && !node.plan && !childrenOf(sess, node).length))
  let qs = segs
  if (!self) {
    if (segs.length + 1 > ACTIVITY_LIMITS.depth) return tooDeep(segs.length + 1)
    let n = 0
    for (const c of node ? childrenOf(sess, node) : []) { const m = c.kind === 'context' && /^\?(\d{1,9})$/.exec(c.name); if (m) n = Math.max(n, Number(m[1])) }
    qs = [...segs, { kind: /** @type {'context'} */ ('context'), name: `?${n + 1}` }]
  } else if (isOpenQuestion(node)) return bad('question-open', `"${node.path}" is still waiting for an answer — withdraw it first (state withdrawn), or ask under another path`)
  const path = formatPath(qs), oi = ownerIndex(qs)
  const q = { status: 'asked', choices: msg.ask.choices, free: msg.ask.free, asked_at: now, ...(msg.ask.expires_at ? { expires_at: msg.ask.expires_at } : {}) }
  const m2 = { ...msg, segs: qs, path, key: pathKey(path), agent: oi ? formatPath(qs.slice(0, oi)) : null, context: qs[qs.length - 1].name, root: false, current: true, ask: undefined }
  return apply(state, ident, m2, now, { ...opts, question: q })
}

// ---------------------------------------------------------------------------------------------------------------
// #82 (v1.69.0): PLACING, MOVING and CASCADE-ABANDONING nodes

/** The sibling an anchor names under `parentKey` — for a bare name an agent of that name first, else a context. */
function findAnchor(sess, parentKey, anchor) {
  const kids = sess ? [...(sess.kids.get(parentKey) || [])].map(k => sess.nodes.get(k)).filter(Boolean) : []
  const ctx = kids.find(n => n.kind === 'context' && lc(n.name) === lc(anchor.name))
  if (anchor.kind === 'context') return ctx || null
  return kids.find(n => n.kind === 'agent' && lc(n.name) === lc(anchor.ref)) || ctx || null
}
const anchorText = n => (n.kind === 'context' ? `@${n.name}` : n.name)
/** The siblings in group g under parentKey (without `selfKey`), in order. */
function groupSibs(sess, parentKey, g, selfKey) {
  return sess ? [...(sess.kids.get(parentKey) || [])].map(k => sess.nodes.get(k)).filter(n => n && n.key !== selfKey && rankGroup(n) === g).sort(siblingCmp) : []
}
/** The open "end" of a group: below the derived rank of anything created from the next ms on (so new nodes still go after). */
const openHi = now => derivedRank(now + 1, null)
/**
 * k ranks for nodes of group g placed per `pos` under `parentKey` (selfKey = the node being reordered, left out of its own
 * siblings). `fresh` (new nodes): the end ("last", or no position) stores NO rank — their derived rank already puts them last.
 * → { ok, ranks:(string|null)[], text } or { ok:false, code:'unknown-anchor'|'bad-anchor'|'bad-position'|'rank-exhausted' }.
 */
function placeRanks(sess, parentKey, g, pos, k, selfKey, now, fresh) {
  const sibs = groupSibs(sess, parentKey, g, selfKey), GROUP = ['plan items', 'contexts', 'agents']
  let lo = null, hi = null, text
  if (pos.before || pos.after) {
    const an = pos.before || pos.after, a = findAnchor(sess, parentKey, an)
    if (!a) return bad('unknown-anchor', `no sibling "${cpSlice(an.ref, 60)}" to place it ${pos.before ? 'before' : 'after'}`)
    if (a.key === selfKey) return bad('bad-position', 'a node can\'t be placed before / after itself')
    if (rankGroup(a) !== g) return bad('bad-anchor', `"${anchorText(a)}" is among the ${GROUP[rankGroup(a)]} — plan items come first, then contexts, then agents; place it among the ${GROUP[g]}`)
    const i = sibs.indexOf(a)
    if (pos.before) { lo = i > 0 ? rankOf(sibs[i - 1]) : null; hi = rankOf(a) } else { lo = rankOf(a); hi = i < sibs.length - 1 ? rankOf(sibs[i + 1]) : openHi(now) }
    text = `placed ${pos.before ? 'before' : 'after'} ${anchorText(a)}`
  } else if (pos.position === 'first') {
    if (!sibs.length) return { ok: true, ranks: new Array(k).fill(null), text: 'placed first' }
    hi = rankOf(sibs[0]); text = 'placed first'
  } else {
    text = 'placed last'
    if (fresh || !sibs.length) return { ok: true, ranks: new Array(k).fill(null), text }
    lo = rankOf(sibs[sibs.length - 1]); hi = openHi(now)
    if (lo >= hi) hi = null
  }
  const ranks = []
  for (let i = 0; i < k; i++) { const r = rankBetween(lo, hi); if (r.length > RANK_MAX) return bad('rank-exhausted', 'too many insertions at one spot — place it elsewhere'); ranks.push(r); lo = r }
  return { ok: true, ranks, text }
}
/**
 * #82 (part 5): the cascade of an abandoned node — every CONTEXT under `top` (not crossing another agent: an agent's work is its
 * own), deepest first, that is OPEN (its line todo / running / blocked) or holds an open plan, gets an abandoned line; the entry
 * says why ("abandoned with @X", + the dashboard's attribution). → { records, done:[{ path, from, entry_id }] }.
 */
function cascadeAbandon(state, sess, top, now, o) {
  const out = { records: [], done: [] }
  const list = subtreeKeys(sess, top.key).slice(1).map(k => sess.nodes.get(k)).filter(x => x && x.kind === 'context' && !crossesAgent(sess, x, top))
  list.sort((a, b) => b.depth - a.depth || cmp(a.key, b.key))
  const why = cpSlice(`abandoned with ${displayPath(top.path, sess.session)}${o.by ? ' ' + byText(o.by) : ''}`, ACTIVITY_LIMITS.text)
  for (const x of list) {
    if (sess.nodes.get(x.key) !== x) continue
    const p = planOf(sess, x)
    if (!((x.current && OPEN_ITEM.has(x.current.state)) || (p && planEndAt(sess, x, p) == null))) continue
    const from = x.current ? x.current.state : 'open'
    const pm = parseMessage({ path: lineAddr(x), state: 'abandoned' }, { now })
    if (!pm.ok) continue
    const r = apply(state, identOf(sess), pm.msg, now, { by: o.by, act: o.act, entryText: why, cascade: false })
    if (r.ok) { out.records.push(...r.records); out.done.push({ path: x.path, from, entry_id: r.records.length ? r.records[r.records.length - 1].id : null }) }
  }
  return out
}
/** Re-key `node` and its subtree under `newParentKey` as `newPath` (sess.nodes, sess.kids, the parents' child sets, cpLive). */
function rekeySubtree(state, sess, node, newParentKey, newPath, newDepth) {
  const oldKey = node.key, oldPath = node.path, newKey = pathKey(newPath), dd = newDepth - node.depth
  const sub = subtreeKeys(sess, oldKey).map(k => sess.nodes.get(k))
  const op = sess.kids.get(node.parent)
  if (op) { op.delete(oldKey); if (!op.size) sess.kids.delete(node.parent) }
  const kidsOf = new Map(sub.map(n => [n.key, sess.kids.get(n.key)]))
  for (const n of sub) { sess.nodes.delete(n.key); sess.kids.delete(n.key) }
  const map = new Map()
  for (const n of sub) {
    const nk = newKey + n.key.slice(oldKey.length)
    map.set(n.key, nk)
    n.key = nk; n.path = newPath + n.path.slice(oldPath.length); n.depth += dd
    n.parent = n === node ? newParentKey : parentKeyOf(nk)
    for (const e of n.log) if (e.path != null && under(pathKey(e.path), oldKey)) e.path = newPath + e.path.slice(oldPath.length)   // a dismissal's entry names the path under it
    sess.nodes.set(nk, n)
  }
  for (const [ok, ks] of kidsOf) if (ks && ks.size) sess.kids.set(map.get(ok), new Set([...ks].map(k => map.get(k) || k)))
  let np = sess.kids.get(newParentKey); if (!np) sess.kids.set(newParentKey, (np = new Set())); np.add(newKey)
  for (const [id, [sk, nk]] of [...state.cpLive]) if (sk === sess.key && map.has(nk)) { state.cpLive.delete(id); state.cpLive.set(cpId(sk, map.get(nk)), [sk, map.get(nk)]) }
  return map
}
/**
 * #82 (part 1): MOVE a node with its whole subtree to a new parent in the same session (each host writes only its own nodes).
 * The node keeps everything (line, bar, state, plan-item marker, log, counts, created_at); it goes to the END of its group under
 * the new parent unless msg.pos says where (a stored rank); intermediates `to` names are created implicit, like any path. ONE
 * logged entry at the NEW path: "moved by <who> from <old> to <new parent>" with `moved_from` (the old path) and `rank` — the
 * replay maps every older record under the old path onto the new one, and the node keeps `moved` ({ from, at }…) so its log
 * pages on into the day files under the old path (logView aliases). A same-parent move with a position is a reorder.
 * Codes: unknown-node, no-change, target-exists, path-too-deep, too-many-nodes, bad-move, unknown-anchor / bad-anchor / …
 */
function applyMove(state, ident, msg, now, opts = {}) {
  const sessName = str(ident && ident.session)
  if (!sessName) return bad('bad-session', 'the reporting session needs a name')
  const sKey = keyOf(state, { realm: ident.realm, project: ident.project, user: ident.user, session: sessName })
  const sess = state.local.get(sKey), node = sess ? sess.nodes.get(msg.key) : null
  if (!node) return bad('unknown-node', `no node "${msg.path}" in this session to move`)
  const mv = msg.move, toKey = mv.toKey, by = normBy(opts && opts.by)
  const act = opts && typeof opts.act === 'string' && ACTIVITY_ACTIONS.includes(opts.act) ? opts.act : null
  if (toKey === node.parent) {   // the same parent: with a position it is a REORDER, else nothing to do
    if (!msg.pos) return bad('no-change', `"${node.path}" is already there`)
    return apply(state, ident, { ...msg, move: undefined, current: false, text: '', posOnly: true, log: true }, now, opts)
  }
  const parent = sess.nodes.get(toKey)
  const parentPath = parent ? parent.path : mv.toPath
  const newPath = (parentPath ? parentPath + '/' : '') + segText({ kind: node.kind, name: node.name }), newKey = pathKey(newPath)
  if (sess.nodes.has(newKey)) return bad('target-exists', `"${newPath}" already exists — the new parent has a node of that name`)
  const sub = subtreeKeys(sess, node.key).map(k => sess.nodes.get(k))
  const height = Math.max(...sub.map(n => n.depth)) - node.depth
  if (mv.toSegs.length + 1 + height > ACTIVITY_LIMITS.depth) return tooDeep(mv.toSegs.length + 1 + height)
  const tkeys = chainKeys(mv.toSegs)
  let newN = 0, newA = 0
  for (let i = 1; i < tkeys.length; i++) if (!sess.nodes.has(tkeys[i])) { newN++; if (mv.toSegs[i - 1].kind === 'agent') newA++ }
  if (sess.nodes.size - 1 + newN > ACTIVITY_LIMITS.nodesPerSession || sess.nAgents + newA > ACTIVITY_LIMITS.agentsPerSession) return bad(newA ? 'too-many-agents' : 'too-many-nodes', 'the new parent\'s path would take the session over its node limits')
  const g = rankGroup(node)
  // the position among the new siblings (default: the END of its group — the node's own derived rank is its creation time)
  const pr = placeRanksUnder(sess, toKey, tkeys, g, msg.pos || { position: 'last' }, node.key, now)
  if (!pr.ok) return pr
  // ---- mutate
  const chain0 = [sess.nodes.get('')]
  for (let i = 1; i < tkeys.length; i++) {
    let n = sess.nodes.get(tkeys[i])
    if (!n) { n = newNode(childPath(chain0[i - 1], mv.toSegs[i - 1]), mv.toSegs.slice(0, i), now); addNode(sess, n) }
    chain0.push(n)
  }
  const oldPath = node.path
  rekeySubtree(state, sess, node, toKey, (chain0[chain0.length - 1].path ? chain0[chain0.length - 1].path + '/' : '') + segText({ kind: node.kind, name: node.name }), mv.toSegs.length + 1)
  node.rank = pr.ranks[0] || null   // null: alone in its group there — its derived rank (creation time) is the end; a rank from the old parent never carries over
  node.moved = [...(node.moved || []), { from: oldPath, at: now }].slice(-8)
  const chain = [...chain0, node], oi = lastAgentIx(chain), owner = chain[oi]
  if (!by) {   // the session's own move is its activity (a dashboard's is not)
    sess.last_activity = Math.max(sess.last_activity, now)
    for (const n of chain.slice(oi)) { n.last_activity = Math.max(n.last_activity, now); n.stale_after_ms = null }
    sess.gone_at = null; owner.gone_at = null; owner.implicit = false
  }
  node.implicit = false
  const who = by ? byText(by).replace(/^by /, '') : sess.session
  const text = cpSlice(`moved by ${who} from ${displayPath(oldPath, sess.session)} to ${displayPath(parentPath, sess.session)}`, ACTIVITY_LIMITS.text)
  const id = `${state.idPrefix}${now.toString(36)}-${(++state.seq).toString(36)}`
  const small = smallOf({ id, ts: now, current: false, text, state: stateOf(node), by, act })
  logInsert(node, small)
  while (node.log.length > state.config.log_entries_per_agent) logDropOldest(node)
  notePersisted(by ? [] : chain.slice(oi), node, { rank: true, moved: true }, now)
  const rec = { v: ACTIVITY_FORMAT, ...small, current: false, path: node.path, origin: state.origin, realm: sess.realm, session: sess.session, project: sess.project, user: sess.user, host: sess.host, s0: sess.created_at,
    details: null, data: null, ...planFields(node), ...persistMarks(chain), moved_from: oldPath, rank: node.rank }
  if (state.cp) state.cp.rep = null
  return { ok: true, id, ts: now, logged: true, entry: rec, records: [rec], current: false, state: stateOf(node), stale_at: staleAt(node, state.config.stale_after_min, owner), path: node.path,
    agent: oi ? owner.path : null, context: node.kind === 'context' ? node.name : 'root', evicted: [], warnings: msg.warnings || [], moved: { from: oldPath, to: node.path, parent: parentPath }, rank: node.rank }
}
/** placeRanks under a parent that may not exist yet (no siblings then: the end). */
function placeRanksUnder(sess, toKey, tkeys, g, pos, selfKey, now) {
  if (!sess.nodes.has(toKey)) return (pos.before || pos.after) ? bad('unknown-anchor', `the new parent is new — it has no sibling to place it ${pos.before ? 'before' : 'after'}`) : { ok: true, ranks: [null] }
  return placeRanks(sess, toKey, g, pos, 1, selfKey, now, false)
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
  notePersisted(chain.slice(lastAgentIx(chain)), node, { line: true, prog: true, eta: true, rank: true }, now)
  return { v: ACTIVITY_FORMAT, kind: 'cp', k, ts: now, path: node.path, origin: state.origin, realm: sess.realm || 'default', session: sess.session, project: sess.project, user: sess.user, host: sess.host, s0: sess.created_at,
    current: fullLine(node.current), state: stateOf(node), progress: node.progress ? { ...node.progress } : null, eta_at: node.eta_at || null, created_at: node.created_at,
    ...planFields(node), ...(node.kind === 'agent' ? { finished_at: node.finished_at, plan_end: node.plan_end ? { ...node.plan_end } : null } : {}), rank: node.rank || null, ...persistMarks(chain) }   // #82: + its stored rank (null = derived)
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
    || (!!n.rank && (p.r || 0) < thr) || (!!(n.moved && n.moved.length) && (p.m || 0) < thr)   // #82: a stored rank / a moved_from history the window would lose
}
/** One node's carry-forward record (a full snapshot that also restores created_at / last_activity / implicit). */
function carryOf(state, sess, node, now) {
  const chain = chainOf(sess, node)
  notePersisted([node], node, { line: true, prog: true, eta: true, rank: true, moved: true }, now)
  return { v: ACTIVITY_FORMAT, kind: 'cf', ts: now, path: node.path, origin: state.origin, realm: sess.realm || 'default', session: sess.session, project: sess.project, user: sess.user, host: sess.host, s0: sess.created_at,
    current: fullLine(node.current), state: stateOf(node), progress: node.progress ? { ...node.progress } : null, eta_at: node.eta_at || null,
    created_at: node.created_at, last_activity: node.last_activity, stale_after_ms: node.stale_after_ms || null, implicit: !!node.implicit,
    ...planFields(node), ...(node.kind === 'agent' ? { finished_at: node.finished_at, plan_end: node.plan_end ? { ...node.plan_end } : null } : {}),
    log_n: ownCount(node), ...(node.cpartial ? { log_partial: true } : {}),   // 6d (#70 "Decisions after 6c, for 6d" 8): the node's own entry count, so it stays exact past the window
    rank: node.rank || null, ...(node.moved && node.moved.length ? { moved: node.moved.map(m => ({ ...m })) } : {}),   // #82: its stored rank; where it was moved from (its log's aliases)
    ...persistMarks(chain) }
}
/** A LOCAL node's own logged-entry count (memory + dropped; 6d: exact across restarts via the cf's log_n). */
const ownCount = n => n.log.length + n.log_dropped

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
 * 6b / 6c: nothing holding part of an OPEN plan expires (an agent or a gone session that holds one stays — open plans never
 * expire while their session exists; a gone session's are ABANDONED after abandoned_plan_days, see autoAbandon); an ENDED plan
 * (planEndAt — 6c: every item done, or its node set done / abandoned) expires the same window after it ended — its items go
 * (planRemoval: with the plan node when that is a plain context left empty).
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

/**
 * 6c AUTO-ABANDON (#70 "Decisions before 6c and 6d" 7): every OPEN plan of a LOCAL session that has been GONE for
 * `abandoned_plan_days` — not live (opts.live(sess) false: the gateway passes "on this host's roster") and quiet that long
 * (its gone_at, else its last activity: a script-only session is never marked gone, and gone_at doesn't survive a restart)
 * — is abandoned: each OPEN item (todo / running / blocked) gets an `@~` line with state abandoned, then the plan node
 * itself (a plan ends only when complete or abandoned), deepest plans first. Each is a SYSTEM message attributed to the
 * bridge (apply opts.by): logged + persisted like any entry (`by:"bridge"`), but it touches no activity and never makes
 * the session look alive. Returns { records:[…] (to persist, in order), abandoned:[{ session, project, path, item }] }.
 * @param {ActivityState} state @param {number} now
 * @param {{ live?: (sess: ActivitySession) => boolean, by?: string }} [opts]
 */
export function autoAbandon(state, now, opts = {}) {
  const days = Number(state.config.abandoned_plan_days) > 0 ? Number(state.config.abandoned_plan_days) : ACTIVITY_DEFAULTS.abandoned_plan_days
  const live = opts && typeof opts.live === 'function' ? opts.live : () => false, by = (opts && opts.by) || 'bridge'
  const out = { records: [], abandoned: [] }
  if (!state.config.enabled || !Number.isFinite(now)) return out
  const text = `abandoned by the bridge — the session has been gone ${days} day${days === 1 ? '' : 's'}`
  for (const s of [...state.local.values()].sort((a, b) => cmp(a.key, b.key))) {
    if (live(s)) continue
    const since = s.gone_at || s.last_activity
    if (!(now - since >= days * DAY)) continue
    const plans = [...s.nodes.values()].filter(n => { const p = planOf(s, n); return p && planEndAt(s, n, p) == null })
    const r = abandonPlans(state, s, plans, now, { by, text })   // 6d: the shared helper (an agent / the session holding a plan: the marker, not its line)
    out.records.push(...r.records); out.abandoned.push(...r.done.map(d => ({ session: s.session, project: s.project, path: d.path, item: d.item })))
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// 6d (v1.65.0): DASHBOARD ACTIONS — the board's first write path from outside the reporting session (#70 "Decisions before
// 6c and 6d" + "Decisions after 6c, for 6d"). The owning host's gateway applies them (a dashboard on another host forwards
// over the hub link); each is LOGGED on the node as a SYSTEM message (apply opts.by: no activity, never un-gones anything)
// attributed `by` = { kind:"dashboard", user, host } + `act`, its text "<what> by <user> via dashboard (<host>)".

/** The actions (wire names). Plan items: done / skip / reopen (→ todo) / abandon; plan nodes: complete / abandon_plan /
 * reopen_plan (the table's "Reopen" on a plan); agents and the session: abandon_plan / finish (args.state done|failed) / dismiss. */
export const ACTIVITY_ACTIONS = Object.freeze(['done', 'skip', 'reopen', 'abandon', 'complete', 'abandon_plan', 'reopen_plan', 'finish', 'dismiss', 'move', 'reorder', 'edit_text', 'message', 'answer', 'withdraw'])   // #82: + move (args.to, + a position) and reorder (args.before | after | position); abandon on ANY context; #83 / #84: + edit_text (args.text, state?) and message (args.text)
/** #82: the actions a ≤1.68 owner doesn't know (its dashboard path answers bad-action) — a 1.69 gateway forwards them only to a 1.69 owner. */
export const PLAN82_ACTIONS = Object.freeze(['move', 'reorder'])
/** #83 / #84 (v1.70.0): the actions a ≤1.69 owner doesn't know — a 1.70 gateway forwards them only to an owner that declared activity_msg. */
export const MSG_ACTIONS = Object.freeze(['edit_text', 'message'])
/** #85 (v1.71.0): the actions a ≤1.70 owner doesn't know — a 1.71 gateway forwards them only to an owner that declared activity_ask. */
export const ASK_ACTIONS = Object.freeze(['answer', 'withdraw'])
/** #84: a dashboard message's limits — its full text (code points), and the preview logged as the entry's text. */
export const MESSAGE_LIMITS = Object.freeze({ text: 2000, preview: 120 })
const ITEM_ACTIONS = Object.freeze({ done: 'done', skip: 'skipped', reopen: 'todo', abandon: 'abandoned' })
const ACTION_LABEL = Object.freeze({ done: 'marked done', skip: 'skipped', reopen: 'reopened (back to to do)', abandon: 'abandoned', complete: 'plan marked complete',
  abandon_plan: 'plan abandoned', reopen_plan: 'plan reopened', finish: 'marked finished', dismiss: 'dismissed from the board', move: 'moved', reorder: 'moved', edit_text: 'edited', message: 'message',
  answer: 'answered', withdraw: 'withdrawn' })
/**
 * #83: the states the dashboard's Edit text… may set on a node — what a report could set there: a plan item any state; another
 * context any but todo / skipped (plan states); an agent / the session running | blocked | idle | done | failed, + abandoned only
 * while it holds plan items (it then finishes and ends its plan, as a report would). In ACTIVITY_STATES order.
 * @param {any} sess @param {any} node @returns {string[]}
 */
export function editStates(sess, node) {
  if (!node) return []
  if (node.kind === 'context') return node.plan ? [...ACTIVITY_STATES] : ACTIVITY_STATES.filter(s => !PLAN_STATES.has(s))
  const holds = !!(sess && childrenOf(sess, node).some(c => c.plan))
  return ACTIVITY_STATES.filter(s => !PLAN_STATES.has(s) && (s !== 'abandoned' || holds))
}
/** #84: a message's text as kept — control characters out except newlines / tabs (CRLF → LF), trimmed. */
const msgText = s => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '')
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
const identOf = s => ({ realm: s.realm, project: s.project, user: s.user, session: s.session })
/** #85: the path of the AGENT a node belongs to (its nearest agent ancestor; null = the session itself). */
const ownerPath = (sess, n) => { const o = ownerOf(sess, n); return o && o.key ? o.path : null }
/** #82: an action's position args (before / after / position) as message fields. */
const posArgs = a => { const o = {}; for (const k of ['before', 'after', 'position']) if (a && typeof a[k] === 'string' && a[k].trim()) o[k] = a[k]; return o }
const lineAddr = n => (n.path ? n.path + '/@~root' : '@~root')
const actText = (label, by) => cpSlice(`${label} ${byText(by)}`.trim(), ACTIVITY_LIMITS.text)
/** An `@~` line with `st` on `node`, keeping the line's text (a tick); the LOGGED entry's text is o.text (attribution). */
function lineAction(state, sess, node, st, now, o) {
  const pm = parseMessage({ path: lineAddr(node), state: st }, { now })
  return pm.ok ? apply(state, identOf(sess), pm.msg, now, { by: o.by, act: o.act, entryText: o.text }) : pm
}
/** A logged (non-current) entry on an agent / the session that sets ('done' | 'abandoned') or clears ('open') its plan-end marker. */
function markerAction(state, sess, node, planEnd, now, o) {
  const pm = parseMessage({ ...(node.path ? { path: node.path } : {}), text: 'plan' }, { now })
  if (!pm.ok) return pm
  pm.msg.text = o.text
  return apply(state, identOf(sess), pm.msg, now, { by: o.by, act: o.act, planEnd })
}
/**
 * End OPEN plans by abandoning them (auto-abandon; the dashboard's abandon_plan), DEEPEST first: each plan's OPEN items (todo /
 * running / blocked) get an abandoned line, then the plan node itself — a CONTEXT by its line, an AGENT / the session by the
 * plan-end marker (it keeps running: #70 "Decisions after 6c, for 6d" 2). o.text = the entry text (default: the action's
 * attribution). Returns { records, done:[{ path, item, from, entry_id }] } (#80: from = the item's state before / 'open' for a
 * plan; entry_id = the logged entry that did it).
 */
function abandonPlans(state, sess, plans, now, o) {
  const out = { records: [], done: [] }
  const one = (n, item) => {
    const text = o.text || actText(item ? ACTION_LABEL.abandon : ACTION_LABEL.abandon_plan, o.by)
    const from = item ? stateOf(n) : 'open'
    const r = !item && n.kind === 'agent' ? markerAction(state, sess, n, 'abandoned', now, { by: o.by, act: o.act, text }) : lineAction(state, sess, n, 'abandoned', now, { by: o.by, act: o.act, text })
    if (r.ok) {
      const own = r.records.find(x => x.path === n.path) || r.records[r.records.length - 1]
      out.records.push(...r.records); out.done.push({ path: n.path, item, from, entry_id: own ? own.id : null })
      for (const c of r.cascade || []) out.done.push({ path: c.path, item: !!(sess.nodes.get(pathKey(c.path)) || {}).plan, from: c.from, entry_id: c.entry_id, cascade: true })   // #82: what the cascade abandoned under it
    }
  }
  for (const n of [...plans].sort((a, b) => b.depth - a.depth || cmp(a.key, b.key))) {
    if (sess.nodes.get(n.key) !== n) continue
    const p = planOf(sess, n)
    if (!p || planEndAt(sess, n, p) != null) continue
    for (const it of p.items) if (OPEN_ITEM.has(stateOf(it))) one(it, true)
    one(n, false)
  }
  return out
}
/** Does the path from x up to (not including) `top` pass through an agent other than `top`? (x itself counts) */
function crossesAgent(sess, x, top) { for (let y = x; y && y.key !== top.key; y = y.parent != null ? sess.nodes.get(y.parent) : null) if (y.kind === 'agent') return true; return false }
/** 6d: the OPEN plans `node` holds — itself and every node of its subtree reached without crossing another agent (an agent's
 * plans, not its sub-agents'). */
function heldPlans(sess, node) {
  const out = []
  for (const k of subtreeKeys(sess, node.key)) {
    const x = sess.nodes.get(k)
    if (x.key !== node.key && crossesAgent(sess, x, node)) continue
    const p = planOf(sess, x)
    if (p && planEndAt(sess, x, p) == null) out.push(x)
  }
  return out
}
/** 6d: is this agent (or the session root) QUIET — finished, or (by `sm` minutes) stale or gone; an implicit one (it never
 * reported) when every reported agent below it is quiet. */
function quietAgent(sess, n, now, sm) {
  if (n.finished_at) return true
  const e = effectiveState(n, now, sm)
  if (e.gone || e.stale) return true
  if (!n.implicit) return false
  return subtreeKeys(sess, n.key).slice(1).map(k => sess.nodes.get(k)).every(x => x.kind !== 'agent' || x.implicit || quietAgent(sess, x, now, sm))
}
/**
 * 6d: ONE dashboard action on a LOCAL node → { ok, action, path, records:[…] (persist in order), applied:[{ path, state }],
 * dismissed?, warnings? } or { ok:false, code, what }. #80 (v1.68.0) adds what the session's notice says: ident (realm, project,
 * user, session), kind, text (the line's), from_state, to_state, of ("plan" when the two are the plan's), entry_id; abandon_plan's
 * applied entries carry from + entry_id. q = { session, project?, user?, path ('' = the session), action, args? };
 * opts.by = { kind:'dashboard', user, host } (required — normBy). Codes: bad-action, bad-args, bad-by, unknown-session,
 * bad-path, unknown-node, not-a-plan-item, no-change, not-a-plan, already-ended, not-ended, all-items-done, no-open-plan,
 * not-an-agent, already-finished, not-stale, has-open-items. args.stale_min (1..1440; default the host's stale_after_min) =
 * the dashboard slider, so "stale" means what the viewer saw.
 * @param {ActivityState} state @param {any} q @param {number} now @param {{ by?: any }} [opts]
 * @returns {ActivityResult}
 */
export function applyAction(state, q, now, opts = {}) {
  if (!state || !(state.local instanceof Map)) return bad('bad-state-object', 'pass a createActivity() state')
  if (!state.config.enabled) return bad('activity-disabled', 'the activity board is disabled on this host (activity.enabled)')
  if (!q || typeof q !== 'object') return bad('bad-action', 'an action is { session, project?, user?, path, action, args? }')
  const action = typeof q.action === 'string' ? q.action.trim().toLowerCase() : ''
  if (!ACTIVITY_ACTIONS.includes(action)) return bad('bad-action', `action must be one of ${ACTIVITY_ACTIONS.join('|')}`)
  const by = normBy(opts && opts.by)
  if (!by || typeof by === 'string') return bad('bad-by', 'an action needs its author ({ kind:"dashboard", user, host })')
  const args = q.args && typeof q.args === 'object' && !Array.isArray(q.args) ? q.args : {}
  const sk = str(q.session) ? lc(q.session) : null
  if (!sk) return bad('unknown-session', 'an action names its session')
  const cands = [...state.local.values()].filter(s => lc(s.session) === sk && projKey(s.project) === projKey(q.project) && lc(s.user || '') === lc(q.user || ''))
  const sess = cands.length > 1 ? cands.find(s => lc(s.realm) === lc(q.realm || 'default')) || cands[0] : cands[0]
  if (!sess) return bad('unknown-session', `no activity from a session "${String(q.session).slice(0, 80)}" (${String(q.project || '').slice(0, 60)}) on this host`)
  const pp = parsePath(q.path == null ? '' : String(q.path))
  if (!pp.ok || pp.current) return bad('bad-path', pp.ok ? 'an action addresses a node (no @~)' : pp.what)
  const node = sess.nodes.get(pp.key)
  if (!node) return bad('unknown-node', `session "${sess.session}" has no node "${pp.path}"`)
  const smArg = Number(args.stale_min), sm = Number.isFinite(smArg) && smArg >= 1 && smArg <= 1440 ? smArg : state.config.stale_after_min
  const o = { by, act: action, text: actText(ACTION_LABEL[action], by) }
  const isAgent = node.kind === 'agent', plan = planOf(sess, node)
  // #80 (v1.68.0): what the owning session is told — the node's state before → after (`of:"plan"` when they are its PLAN's:
  // open | done | all-done | abandoned), the logged entry that did it, the session's identity (canonical spellings) and the
  // line's text. Read BEFORE the action applies.
  const from0 = stateOf(node), planFrom0 = plan ? (planEndAt(sess, node, plan) != null ? planEndHow(sess, node, plan) : 'open') : null
  const lineText = node.current ? node.current.text : null
  const entryOf = recs => { for (let i = recs.length - 1; i >= 0; i--) if (recs[i].path === node.path) return recs[i].id; return recs.length ? recs[recs.length - 1].id : null }
  const done = (recs, to, extra = {}) => ({ ok: true, action, path: node.path, records: recs, applied: extra.applied || [{ path: node.path, state: sess.nodes.get(node.key) ? stateOf(node) : null }], ...extra,
    ident: identOf(sess), kind: node.kind, text: lineText, from_state: to.of === 'plan' ? planFrom0 : from0, to_state: to.state, ...(to.of ? { of: to.of } : {}), entry_id: entryOf(recs) })
  switch (action) {
    case 'done': case 'skip': case 'reopen': case 'abandon': {   // ---- a PLAN ITEM (#82: abandon — any context, with its open descendants)
      if (!node.plan && !(action === 'abandon' && node.kind === 'context')) return bad('not-a-plan-item', `"${node.path || '@root'}" is not a plan item${action === 'abandon' ? ' or a context' : ''}`)
      const st = ITEM_ACTIONS[action]
      if (node.current && stateOf(node) === st) return bad('no-change', `"${node.path}" is already ${st}`)
      const r = lineAction(state, sess, node, st, now, o)
      if (!r.ok) return r
      const par = sess.nodes.get(node.parent), pp2 = par ? planOf(sess, par) : null
      const warn = action === 'reopen' && pp2 && planEndAt(sess, par, pp2) != null ? ['plan-ended'] : []   // its plan was marked complete / abandoned: reopen the plan too
      const casc = (r.cascade || []).map(c => ({ path: c.path, state: 'abandoned', from: c.from, entry_id: c.entry_id }))
      return done(r.records, { state: st }, { ...(warn.length ? { warnings: warn } : {}), ...(casc.length ? { applied: [{ path: node.path, state: st }, ...casc] } : {}) })
    }
    case 'move': {   // ---- #82: re-parent a node (+ its subtree) in its session; args.to = the new parent's path ('' = the session root)
      if (!node.key) return bad('bad-move', 'the session root can\'t be moved')
      if (typeof args.to !== 'string') return bad('bad-args', 'move takes args.to: the new parent\'s path ("" = the session root)')
      const pm = parseMessage({ move: '/' + node.path, to: '/' + args.to.replace(/^\/+/, ''), ...posArgs(args) }, { now })
      if (!pm.ok) return pm
      const r = apply(state, identOf(sess), pm.msg, now, { by, act: action })
      if (!r.ok) return r
      const st = stateOf(node)
      return { ...done(r.records, { state: st }), from_state: st, moved_from: r.moved ? r.moved.from : null, to: r.moved ? r.moved.parent : null, rank: r.rank || null }
    }
    case 'reorder': {   // ---- #82: a new place among its siblings (args.before | after = a sibling, or position first | last)
      if (!node.key) return bad('bad-position', 'the session root has no siblings')
      const pa = posArgs(args)
      if (!Object.keys(pa).length) return bad('bad-args', 'reorder takes args.before / args.after (a sibling) or args.position ("first" | "last")')
      const pm = parseMessage({ path: node.path, ...pa }, { now })
      if (!pm.ok) return pm
      const r = apply(state, identOf(sess), pm.msg, now, { by, act: action })
      if (!r.ok) return r
      const st = stateOf(node), w = (r.records[0] && r.records[0].text || '').replace(/^placed /, '').replace(/ by .*$/, '')
      return { ...done(r.records, { state: st }), from_state: st, where: w === 'first' ? 'to the top' : w === 'last' ? 'to the end' : w, rank: r.rank || null }
    }
    case 'edit_text': {   // ---- #83: set the node's CURRENT LINE (+ optionally its state) for its session — any node, the session root too
      if (typeof args.text !== 'string' || !normText(args.text)) return bad('bad-args', 'edit_text takes args.text — the new line (and optionally args.state)')
      const valid = editStates(sess, node)
      const st = typeof args.state === 'string' && args.state.trim() ? args.state.trim().toLowerCase() : null
      if (st && !valid.includes(st)) return bad('bad-state', `"${node.path || '@root'}" can be ${valid.join('|')} — not ${st}`)
      const keep = st || (node.current ? stateOf(node) : null)   // no state given: the line keeps its state (a ☐ item is not started by an edit)
      const pm = parseMessage({ path: lineAddr(node), text: 'x', ...(keep ? { state: keep } : {}) }, { now })   // the address only: the text is taken LITERALLY (a leading "@…" is text, not a path)
      if (!pm.ok) return pm
      let text = normText(args.text)
      if (cpLen(text) > ACTIVITY_LIMITS.text) { text = cpSlice(text, ACTIVITY_LIMITS.text - 1) + '…'; pm.msg.warnings.push('text-truncated') }   // the same limit as a report
      pm.msg.text = text
      if (node.current) { pm.msg.details = node.current.details || null; pm.msg.data = node.current.data != null ? node.current.data : null }   // only the TEXT (and state) change: the line keeps its details / data
      if (node.current && node.current.text === text && stateOf(node) === (keep || 'running')) return bad('no-change', `"${node.path || '@root'}" already reads that`)
      const suffix = ` (edited ${byText(by)})`, room = ACTIVITY_LIMITS.text - cpLen(suffix)   // the LOGGED entry: the text + who edited it (the line keeps the text alone)
      const et = (cpLen(text) > room ? cpSlice(text, room - 1) + '…' : text) + suffix
      const r = apply(state, identOf(sess), pm.msg, now, { by, act: action, entryText: et })
      if (!r.ok) return r
      const casc = (r.cascade || []).map(c => ({ path: c.path, state: 'abandoned', from: c.from, entry_id: c.entry_id }))
      const st2 = stateOf(node)
      return { ...done(r.records, { state: st2 }, { ...(casc.length ? { applied: [{ path: node.path, state: st2 }, ...casc] } : {}) }), from_text: lineText, new_text: text,
        ...(r.warnings && r.warnings.length ? { warnings: r.warnings } : {}) }
    }
    case 'message': {   // ---- #84: a message to the node's session — LOGGED on the node here; the bridge delivers it (messageNotice)
      const full = msgText(args.text)
      if (!full) return bad('bad-args', 'message takes args.text — what to tell the session')
      if (cpLen(full) > MESSAGE_LIMITS.text) return bad('message-too-long', `a message is at most ${MESSAGE_LIMITS.text} characters (got ${cpLen(full)}) — shorten it`)
      const pm = parseMessage({ ...(node.path ? { path: node.path } : {}), text: 'x' }, { now })
      if (!pm.ok) return pm
      pm.msg.text = cpSlice(`${by.user} via dashboard: ${preview(full, MESSAGE_LIMITS.preview)}`, ACTIVITY_LIMITS.text)
      let det = full   // the full text in details (≤ 4 KB: a long non-ASCII message is cut there — the delivered message carries all of it)
      while (utf8(det) > ACTIVITY_LIMITS.detailsBytes) det = cpSlice(det, Math.max(1, cpLen(det) - Math.ceil((utf8(det) - ACTIVITY_LIMITS.detailsBytes) / 4) - 1)) + '…'
      pm.msg.details = det
      const r = apply(state, identOf(sess), pm.msg, now, { by, act: action })
      if (!r.ok) return r
      const st2 = stateOf(node)
      return { ...done(r.records, { state: st2 }), from_state: st2, message: full }
    }
    case 'answer': {   // ---- #85: answer an OPEN question — args.choice (one of its choices) and / or args.text (when free text is allowed)
      const q = isQuestion(node) ? node.current.question : null
      if (!q) return bad('not-a-question', `"${node.path || '@root'}" is not a question`)
      if (q.status !== 'asked') return bad('question-closed', `the question "${node.path}" is already ${q.status}`)
      const ans = {}
      if (args.choice != null && String(args.choice).trim()) {
        if (!q.choices.length) return bad('bad-args', 'this question has no choices — answer it with args.text')
        const want = lc(normText(String(args.choice)))
        const hit = q.choices.find(c => lc(c) === want)
        if (!hit) return bad('bad-choice', `"${cpSlice(String(args.choice), 60)}" is not one of its choices: ${q.choices.join(' | ')}`)
        ans.choice = hit
      }
      const t = qAnswerText(args.text)
      if (t) {
        if (!q.free) return bad('bad-args', 'this question takes one of its choices, not free text')
        if (cpLen(t) > QUESTION_LIMITS.answer) return bad('answer-too-long', `an answer is at most ${QUESTION_LIMITS.answer} characters (got ${cpLen(t)})`)
        ans.text = t
      }
      if (!ans.choice && !ans.text) return bad('bad-args', q.choices.length ? `answer takes args.choice (${q.choices.join(' | ')})${q.free ? ' and / or args.text' : ''}` : 'answer takes args.text — the answer')
      const pm = parseMessage({ path: lineAddr(node), state: 'done' }, { now })
      if (!pm.ok) return pm
      const qa = { ...q, status: 'answered', answer: ans, by, at: now }
      const r = apply(state, identOf(sess), pm.msg, now, { by, act: action, entryText: cpSlice(`answered ${byText(by)}: ${answerText(ans, 200)}`, ACTIVITY_LIMITS.text), question: qa, cascade: false })
      if (!r.ok) return r
      return { ...done(r.records, { state: 'done' }), question: questionView(node.current.question), answer: ans, agent: ownerPath(sess, node) }
    }
    case 'withdraw': {   // ---- #85: withdraw an OPEN question from the dashboard (it won't be answered)
      const q = isQuestion(node) ? node.current.question : null
      if (!q) return bad('not-a-question', `"${node.path || '@root'}" is not a question`)
      if (q.status !== 'asked') return bad('question-closed', `the question "${node.path}" is already ${q.status}`)
      const pm = parseMessage({ path: lineAddr(node), state: 'abandoned' }, { now })
      if (!pm.ok) return pm
      const r = apply(state, identOf(sess), pm.msg, now, { by, act: action, entryText: actText(ACTION_LABEL.withdraw, by), question: { ...q, status: 'withdrawn', by, at: now }, cascade: false })
      if (!r.ok) return r
      return { ...done(r.records, { state: 'abandoned' }), question: questionView(node.current.question), agent: ownerPath(sess, node) }
    }
    case 'complete': {   // ---- a PLAN NODE: ends its plan (a context: its line done; an agent / the session: the marker)
      if (!plan) return bad('not-a-plan', `"${node.path || '@root'}" holds no plan items`)
      if (planEndAt(sess, node, plan) != null) return bad('already-ended', `the plan of "${node.path || '@root'}" has already ended`)
      const r = isAgent ? markerAction(state, sess, node, 'done', now, o) : lineAction(state, sess, node, 'done', now, o)
      return r.ok ? done(r.records, { state: 'done', of: 'plan' }) : r
    }
    case 'reopen_plan': {
      if (!plan) return bad('not-a-plan', `"${node.path || '@root'}" holds no plan items`)
      if (planEndAt(sess, node, plan) == null) return bad('not-ended', `the plan of "${node.path || '@root'}" is open`)
      if (plan.allDoneAt != null) return bad('all-items-done', 'every item of this plan is done — reopen an item instead')
      const r = isAgent ? markerAction(state, sess, node, 'open', now, o) : lineAction(state, sess, node, 'running', now, o)
      return r.ok ? done(r.records, { state: 'open', of: 'plan' }) : r
    }
    case 'abandon_plan': {   // a plan node: its open items, then it; an agent / the session: every open plan it holds (it keeps running)
      if (!isAgent && !plan) return bad('not-a-plan', `"${node.path}" holds no plan items`)
      const plans = heldPlans(sess, node)
      if (!plans.length) return bad('no-open-plan', `"${node.path || '@root'}" holds no open plan`)
      const r = abandonPlans(state, sess, plans, now, { by, act: action })
      return done(r.records, { state: 'abandoned', of: 'plan' }, { applied: r.done.map(d => ({ path: d.path, state: 'abandoned', item: d.item, from: d.from, entry_id: d.entry_id })) })
    }
    case 'finish': {   // ---- an agent / the session that is stale or gone
      if (!isAgent) return bad('not-an-agent', `"${node.path}" is a context — only an agent or the session finishes`)
      const st = typeof args.state === 'string' ? args.state.trim().toLowerCase() : ''
      if (st !== 'done' && st !== 'failed') return bad('bad-args', 'finish takes args.state "done" or "failed"')
      if (node.finished_at) return bad('already-finished', `"${node.path || '@root'}" has already finished`)
      if (!quietAgent(sess, node, now, sm)) return bad('not-stale', `"${node.path || '@root'}" is neither stale nor gone — only a quiet agent can be marked finished`)
      const r = lineAction(state, sess, node, st, now, { ...o, text: actText(`${ACTION_LABEL.finish} (${st})`, by) })
      return r.ok ? done(r.records, { state: st }) : r
    }
    case 'dismiss': {   // ---- remove an agent / the session (with its subtree) from the board now; the files keep everything
      if (!isAgent) return bad('not-an-agent', `"${node.path}" is a context — dismiss removes an agent or a session`)
      const sub = subtreeKeys(sess, node.key).map(k => sess.nodes.get(k))
      if (!sub.every(x => x.kind !== 'agent' || (x.key !== node.key && x.implicit) || quietAgent(sess, x, now, sm)))
        return bad('not-stale', `"${node.path || '@root'}" (or an agent under it) is still active — only a stale, gone or finished agent can be dismissed`)
      if (openPlanKeys(sess).has(node.key)) return bad('has-open-items', `"${node.path || '@root'}" holds part of an OPEN plan — complete or abandon it first (open plan items are never removed)`)
      const r = dismissNode(state, sess, node, now, o)
      return { ...r, action, ident: identOf(sess), kind: node.kind, text: lineText, from_state: from0, to_state: 'dismissed', entry_id: entryOf(r.records) }
    }
  }
  return bad('bad-action', action)
}
/**
 * 6d DISMISS: one LOGGED entry `{ …, dismiss:true }` at the node's path (state = its state, by / act), then the node and its
 * subtree leave memory (the session root: the whole session). The REPLAY honours it like an eviction (`evicted`): older
 * records at or under that path are an ended instance and are skipped, so the dismissal survives a restart; a later message
 * starts a NEW run (new_from). The entry itself lands in the PARENT's log (with its own `path`), so the parent's merged log
 * shows it; nothing in the files is erased.
 */
function dismissNode(state, sess, node, now, o) {
  const id = `${state.idPrefix}${now.toString(36)}-${(++state.seq).toString(36)}`
  const small = smallOf({ id, ts: now, current: false, text: o.text, state: stateOf(node), by: o.by, act: 'dismiss' })
  const rec = { v: ACTIVITY_FORMAT, ...small, current: false, path: node.path, origin: state.origin, realm: sess.realm, session: sess.session, project: sess.project, user: sess.user, host: sess.host, s0: sess.created_at,
    details: null, data: null, dismiss: true }
  const removed = node.key ? subtreeKeys(sess, node.key).length : sess.nodes.size
  if (node.key) {
    const parent = sess.nodes.get(node.parent)
    removeSubtree(sess, node.key)
    if (parent) { logInsert(parent, { ...small, path: node.path }); while (parent.log.length > state.config.log_entries_per_agent) logDropOldest(parent) }
  } else state.local.delete(sess.key)
  if (state.cp) state.cp.rep = null   // any other write closes the open repeat line
  return { ok: true, path: node.path, records: [rec], dismissed: { path: node.path, nodes: removed, session: !node.key }, applied: [{ path: node.path, state: 'dismissed' }] }
}

// ---------------------------------------------------------------------------------------------------------------
// #80 (v1.68.0): DASHBOARD-CHANGE NOTICES. After an action applies, the OWNING gateway tells the node's session — a system
// message, verb `activity_changed`, to its registered sub-peer (parked when it is offline; a script-only session gets the
// log entry only). These two PURE builders make the message; the bridge batches them per session (notice_batch_sec) and
// delivers them (bridge.mjs notifyActivitySession). Subjects are public (status paths are realm-visible anyway); a body is
// { action, path, host, from_state, to_state, of?, by:{ user, host }, entry_id, session, project, text, ts, items? } and a
// batch is { actions:[…those], count, session, project, host }.
export const NOTICE_VERB = 'activity_changed'
/** #83 (v1.70.0): the verb of a dashboard EDIT of a node's line (batched like activity_changed; several merge through combineActionNotices). */
export const EDIT_NOTICE_VERB = 'activity_text_edited'
/** #84 (v1.70.0): the verb of a dashboard viewer's MESSAGE about a node (sent at once — a person waits on it). */
export const MESSAGE_NOTICE_VERB = 'activity_message'
const NOTICE_ONE = Object.freeze({ done: 'marked {p} done', skip: 'skipped {p}', reopen: 'reopened {p}', abandon: 'abandoned {p}', complete: 'completed the plan {p}',
  abandon_plan: 'abandoned the plan {p}', reopen_plan: 'reopened the plan {p}', finish: 'marked {p} finished ({s})', dismiss: 'dismissed {p} from the board',
  move: 'moved {p} to {t}', reorder: 'moved {p} {w}', edit_text: 'edited {p}' })   // #82; #83
const NOTICE_MANY = Object.freeze({ done: 'marked {n} done', skip: 'skipped {n}', reopen: 'reopened {n}', abandon: 'abandoned {n}', complete: 'completed {n}',
  abandon_plan: 'abandoned {n}', reopen_plan: 'reopened {n}', finish: 'finished {n}', dismiss: 'dismissed {n}', move: 'moved {n}', reorder: 'reordered {n}', edit_text: 'edited {n}' })
const NOTICE_NOUN = Object.freeze({ done: 'item', skip: 'item', reopen: 'item', abandon: 'item', complete: 'plan', abandon_plan: 'plan', reopen_plan: 'plan', finish: 'agent', dismiss: 'agent', move: 'node', reorder: 'node', edit_text: 'line' })
const NOTICE_SUBJECT_MAX = 200
const segsOf = p => (typeof p === 'string' && p ? p.match(/@"[^"]*"|[^/]+/g) || [] : [])
/** A node path for people: `@"Next release"/@Docs` → `@Next release/@Docs`; the session root → the session's name. */
export function displayPath(path, session) { return path ? String(path).replace(/@"([^"]*)"/g, '@$1') : String(session || '@root') }
/**
 * One applied action (applyAction's result) → { verb, subject, body }. opts = { by (the action's author), host (the owner), ts }.
 * @param {any} r @param {{ by?: any, host?: string, ts?: number }} [opts]
 */
export function actionNotice(r, opts = {}) {
  if (r && r.action === 'message') return messageNotice(r, opts)   // #84
  if (r && (r.action === 'answer' || r.action === 'withdraw' || r.action === 'expire')) return answerNotice(r, opts)   // #85
  const b = normBy(opts.by), by = b && typeof b === 'object' ? { user: b.user, host: b.host } : { user: typeof b === 'string' ? b : 'dashboard', host: opts.host || '?' }
  const id = r.ident || {}, action = r.action
  const p = displayPath(action === 'move' && r.moved_from != null ? r.moved_from : r.path, id.session)   // #82: "moved @A/@x to @B" names the OLD path
  const pp =(r.kind === 'agent' && NOTICE_NOUN[action] === 'plan') ? `of ${p}` : p   // "completed the plan of lead"
  const tpl = action === 'abandon_plan' && r.kind === 'agent' ? 'abandoned the open plans {p}' : (NOTICE_ONE[action] || `${action} {p}`)
  const st83 = action === 'edit_text' && r.from_state && r.to_state && r.from_state !== r.to_state ? ` (${r.from_state} → ${r.to_state})` : ''   // #83: an edit that changed the state says so
  const subject = cpSlice(`${by.user} ${tpl.replace('{p}', pp).replace('{s}', r.to_state || '').replace('{t}', displayPath(r.to || '', id.session)).replace('{w}', r.where || 'elsewhere')}${st83}`, NOTICE_SUBJECT_MAX)
  const items = (r.applied || []).filter(a => a.path !== r.path).map(a => compact({ path: a.path, from_state: a.from || null, to_state: a.state, entry_id: a.entry_id || null }))
  const body = { action, path: r.path || '', host: opts.host || null, from_state: r.from_state || null, to_state: r.to_state || null, ...(r.of ? { of: r.of } : {}), by,
    entry_id: r.entry_id || null, session: id.session || null, project: id.project || null, text: r.text || null, ts: opts.ts || null, ...(items.length ? { items } : {}),
    ...(r.moved_from != null ? { moved_from: r.moved_from, to: r.to || '' } : {}), ...(r.where ? { where: r.where } : {}),   // #82: a move's old path + new parent; a reorder's place
    ...(action === 'edit_text' ? { from_text: r.from_text != null ? r.from_text : null, text: r.new_text != null ? r.new_text : null } : {}) }   // #83: the line before → after (text = the NEW line)
  return { verb: action === 'edit_text' ? EDIT_NOTICE_VERB : NOTICE_VERB, subject, body }
}
/**
 * #84: a dashboard viewer's MESSAGE about a node (applyAction's `message` result) → { verb:"activity_message", subject, body }.
 * The SUBJECT is public (never encrypted): only who, the node's path and a few words — "robin about @Next release/@#83: can you
 * also cover…". The BODY (encrypted like any body) carries the full text: { action:"message", path, host (the owner), text,
 * by:{ user, host }, entry_id (the logged entry), session, project, ts }.
 * @param {any} r @param {{ by?: any, host?: string, ts?: number }} [opts]
 */
export function messageNotice(r, opts = {}) {
  const b = normBy(opts.by), by = b && typeof b === 'object' ? { user: b.user, host: b.host } : { user: typeof b === 'string' ? b : 'dashboard', host: opts.host || '?' }
  const id = r.ident || {}, text = typeof r.message === 'string' ? r.message : ''
  const subject = cpSlice(`${by.user} about ${displayPath(r.path, id.session)}: ${firstWords(text)}`, NOTICE_SUBJECT_MAX)
  return { verb: MESSAGE_NOTICE_VERB, subject, body: { action: 'message', path: r.path || '', host: opts.host || null, text, by, entry_id: r.entry_id || null, session: id.session || null, project: id.project || null, ts: opts.ts || null } }
}
/**
 * #85: the session's OWN question was answered (the dashboard's `answer`), withdrawn (the dashboard's `withdraw`) or expired (the
 * bridge) → { verb:"activity_answer", subject, body } — sent at once (now:true), to the session (an agent's question too: its
 * orchestrator relays it — body.agent names the agent). The SUBJECT is public: who, the path and the question's first few words —
 * "robin answered @Next release/@?1: Postgres or SQLite for the…" — NEVER the answer. The BODY (encrypted) = { action (answer |
 * withdraw | expire), status, path, host (the owner), question (its text), choices, free, answer? { choice?, text? }, by { user,
 * host } (or "bridge"), entry_id, session, project, agent (the asking agent's path; null = the session), asked_at, ts }.
 * r = applyAction's answer / withdraw result, or { action:"expire", ident, path, text, question, entry_id, agent }.
 * @param {any} r @param {{ by?: any, host?: string, ts?: number }} [opts]
 */
export function answerNotice(r, opts = {}) {
  const id = r.ident || {}, q = /** @type {any} */ (questionView(r.question)) || { status: r.action === 'answer' ? 'answered' : r.action === 'withdraw' ? 'withdrawn' : 'expired', choices: [], free: true }
  const b = normBy(opts.by != null ? opts.by : q.by), by = b && typeof b === 'object' ? { user: b.user, host: b.host } : (typeof b === 'string' ? b : 'dashboard')
  const who = typeof by === 'object' ? by.user : by
  const p = displayPath(r.path, id.session), fw = firstWords(r.text || '')
  const subject = cpSlice(r.action === 'expire' ? `question expired ${p}: ${fw}` : `${who} ${r.action === 'withdraw' ? 'withdrew' : 'answered'} ${p}: ${fw}`, NOTICE_SUBJECT_MAX)
  const body = { action: r.action, status: q.status, path: r.path || '', host: opts.host || null, question: r.text || null, choices: q.choices, free: q.free,
    ...(q.answer ? { answer: q.answer } : {}), by, entry_id: r.entry_id || null, session: id.session || null, project: id.project || null, agent: r.agent != null ? r.agent : null,
    asked_at: q.asked_at || null, ts: opts.ts || null }
  return { verb: ANSWER_NOTICE_VERB, subject, body }
}
/**
 * #85: EXPIRY — every LOCAL open question whose expires_at has passed becomes `expired` (unanswered): a SYSTEM line by the bridge
 * (state abandoned, the question kept with status expired; no activity), logged "expired — nobody answered within <dur>".
 * Returns { records (persist in order), expired:[{ ident, path, text, question, entry_id, agent, action:"expire" }] } (each one
 * is also what answerNotice takes).
 * @param {ActivityState} state @param {number} now
 */
export function expireQuestions(state, now) {
  const out = { records: [], expired: [] }
  if (!state || !state.config.enabled || !Number.isFinite(now)) return out
  for (const s of [...state.local.values()].sort((a, b) => cmp(a.key, b.key))) {
    for (const n of [...s.nodes.values()].sort((a, b) => cmp(a.key, b.key))) {
      if (s.nodes.get(n.key) !== n || !isOpenQuestion(n)) continue
      const q = n.current.question
      if (!(q.expires_at > 0) || now < q.expires_at) continue
      const pm = parseMessage({ path: lineAddr(n), state: 'abandoned' }, { now })
      if (!pm.ok) continue
      const text = n.current.text, dur = q.asked_at ? ` within ${fmtEta(q.expires_at - q.asked_at).replace(/^~/, '')}` : ''
      const r = apply(state, identOf(s), pm.msg, now, { by: 'bridge', entryText: `expired — nobody answered${dur}`, question: { ...q, status: 'expired', by: 'bridge', at: now }, cascade: false })
      if (!r.ok) continue
      out.records.push(...r.records)
      out.expired.push({ action: 'expire', ident: identOf(s), path: n.path, text, question: questionView(n.current.question), entry_id: r.records.length ? r.records[r.records.length - 1].id : null, agent: ownerPath(s, n) })
    }
  }
  return out
}
/** #85: when the next LOCAL open question expires (ms), or null — the gateway's expiry timer. @param {ActivityState} state */
export function nextQuestionExpiry(state) {
  let at = null
  for (const s of state.local.values()) for (const n of s.nodes.values()) if (isOpenQuestion(n) && n.current.question.expires_at > 0 && (at === null || n.current.question.expires_at < at)) at = n.current.question.expires_at
  return at
}
/**
 * #85: a WAITER's view of a question node (the script's --wait): { outcome, status, path, question (text), choices, free, answer?,
 * by?, at?, asked_at, expires_at?, entry_id } — outcome = the status once closed ("answered" | "expired" | "withdrawn"), "open"
 * while asked, "gone" when the node (or its session) left the board or is no longer a question.
 * @param {ActivityState} state @param {any} sess @param {any} node
 */
export function questionOutcome(state, sess, node) {
  const alive = !!sess && state.local.get(sess.key) === sess && !!node && sess.nodes.get(node.key) === node
  if (!alive || !isQuestion(node)) return { outcome: 'gone', path: node ? node.path : null }
  const q = questionView(node.current.question)
  return { outcome: q.status === 'asked' ? 'open' : q.status, status: q.status, path: node.path, question: node.current.text, choices: q.choices, free: q.free,
    ...(q.answer ? { answer: q.answer } : {}), ...(q.by ? { by: q.by } : {}), ...(q.at ? { at: q.at } : {}), asked_at: q.asked_at, ...(q.expires_at ? { expires_at: q.expires_at } : {}), entry_id: node.current.id }
}
/**
 * Several notices for ONE session (bodies from actionNotice) → ONE { subject, body }: "robin skipped 2 items and abandoned 1 in
 * @Dashboard test" — per action in first-seen order, the noun on the first group (and again where it changes), "in" the deepest
 * common container (a plan item's parent; another node itself), else the session's name. body = { actions, count, session,
 * project, host }. One notice is returned as it is.
 * @param {Array<{ subject: string, body: any }>} notices
 */
export function combineActionNotices(notices) {
  const list = (notices || []).filter(n => n && n.body)
  if (list.length === 1) return { subject: list[0].subject, body: list[0].body }
  const acts = list.map(n => n.body), first = acts[0] || {}
  const users = [...new Set(acts.map(a => (a.by && a.by.user) || 'dashboard'))]
  const groups = new Map()
  for (const a of acts) groups.set(a.action, (groups.get(a.action) || 0) + 1)
  let lastNoun = null
  const parts = [...groups].map(([action, n]) => {
    const noun = NOTICE_NOUN[action] || 'change'
    const what = noun !== lastNoun ? `${n} ${noun}${n === 1 ? '' : 's'}` : String(n)
    lastNoun = noun
    return (NOTICE_MANY[action] || `${action} {n}`).replace('{n}', what)
  })
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || 'changed nothing'
  const containers = acts.map(a => { const s = segsOf(a.path); return NOTICE_NOUN[a.action] === 'item' ? s.slice(0, -1) : s })
  let common = containers[0] || []
  for (const c of containers) { let i = 0; while (i < common.length && i < c.length && common[i].toLowerCase() === c[i].toLowerCase()) i++; common = common.slice(0, i) }
  const where = displayPath(common.join('/'), first.session)
  const subject = cpSlice(`${users.join(', ')} ${said} in ${where}`, NOTICE_SUBJECT_MAX)
  return { subject, body: { actions: acts, count: acts.length, session: first.session || null, project: first.project || null, host: first.host || null } }
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
// #79 (v1.66.0): every bar has THREE parts — done, skipped (resolved, not done: never counted as remaining), total — and
// each strategy carries all three: a common unit SUMS done, skipped and total; mixed units AVERAGE each child's done
// fraction and skipped fraction (each child weighted 1); "N of M done" counts ALL items in M (replaces 6b/6c's "skipped
// left out of M"): done items → done; skipped AND abandoned items → skipped (they won't be done); todo / running / blocked /
// idle / failed items → remaining (failed counts as not done — it may be retried).
const skOf = p => (p && p.skipped > 0 ? p.skipped : 0)   // #79: a progress without `skipped` (a 1.65 peer, any old record) = 0
const rollupStrategies = [
  (bars) => {   // the SUM of the children's bars when they all share a unit (case-insensitive; '' counts, '%' doesn't sum)
    if (!bars.length) return null
    const u = lc(bars[0].unit)
    if (u === '%' || !bars.every(p => lc(p.unit) === u)) return null
    const done = bars.reduce((s, p) => s + p.done, 0), skipped = bars.reduce((s, p) => s + skOf(p), 0), total = bars.reduce((s, p) => s + p.total, 0)
    return { done, skipped, total, unit: bars[0].unit, pct: progressPct({ done, total }), rollup: true, n: bars.length, ...(bars.every(p => p.todos) ? { todos: true } : {}) }
  },
  (bars) => {   // the MEAN of the children's done % and skipped % (each child weighted 1; #79: skipped averaged like done)
    if (!bars.length) return null
    const r1 = x => Math.round(x * 10) / 10
    const mean = r1(bars.reduce((s, p) => s + progressPct(p), 0) / bars.length)
    const skipped = Math.min(r1(bars.reduce((s, p) => s + (p.total > 0 ? Math.min(100, (skOf(p) / p.total) * 100) : 0), 0) / bars.length), r1(100 - mean))
    return { done: mean, skipped, total: 100, unit: '%', pct: mean, rollup: true, n: bars.length }
  },
  (bars, items) => {   // "N of M done" over the plan items (#79: M = every item; skipped + abandoned → the skipped part; failed / idle / open → remaining)
    if (!items.length) return null
    let done = 0, skipped = 0, abandoned = 0
    for (const it of items) { const s = stateOf(it); if (s === 'done') done++; else if (s === 'skipped') skipped++; else if (s === 'abandoned') { skipped++; abandoned++ } }
    const total = items.length
    return { done, skipped, total, unit: 'done', pct: progressPct({ done, total }), rollup: true, todos: true, items: true, n: items.length, ...(abandoned ? { abandoned } : {}) }
  },
]
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
/**
 * A node's BAR (recursive): its REPORTED progress (rollup:false), else its children rolled up (rollup:true): the sum of its
 * ordinary children's bars when they share a unit, else their mean percent — through any depth — else (6b) "N of M done"
 * over its plan items (`todos:true` + `items:true`, unit "done"). #79: every bar is { done, skipped, total } (skipped 0 when
 * none; `abandoned` = how many of an items bar's skipped were abandoned), and a done / abandoned node's own state overrides
 * it (forceBar). null when nothing applies. `memo` (a Map) caches per call when walking a whole board.
 * @param {ActivitySession} sess @param {ActivityNode} node @param {Map<string, any>} [memo]
 * @returns {null | { done:number, skipped:number, total:number, unit:string, pct:number, rollup:boolean, n:number, todos?:boolean, items?:boolean, abandoned?:number, forced?:string }}
 */
export function rollup(sess, node, memo) {
  if (!sess || !node) return null
  if (memo && memo.has(node.key)) return memo.get(node.key)
  let r = null
  if (node.progress) r = { ...node.progress, skipped: skOf(node.progress), pct: progressPct(node.progress), rollup: false, n: 1 }
  else {
    const kids = childrenOf(sess, node).sort((a, b) => cmp(a.key, b.key))
    const bars = kids.filter(c => !c.plan && !isQuestion(c)).map(c => rollup(sess, c, memo)).filter(Boolean), items = kids.filter(c => c.plan || isQuestion(c))   // #85: a question counts as an item (open = remaining, answered = done, expired / withdrawn = skipped)
    if (bars.length || items.length) for (const f of rollupStrategies) { r = f(bars, items); if (r) break }
  }
  r = forceBar(node, r)
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
      implicit: true, seen: false, sealed: false, marker: false, log: [], total: 0, floor: 0, plan: false, planIx: null, tA: 0, tL: 0, tP: 0, tE: 0, tPend: 0,
      pe: null, peRes: false, cnt: null, cntAt: 0, cntPartial: false,   // 6d: the plan-end marker; the exact own-entry count a cf carried (+ when)
      rank: null, rankRes: false, tR: 0, moved: [], tM: 0, movedAt: 0 }   // #82: the stored rank (newest record carrying one); move events ({ from, at }) + when persisted; the latest move's time
  }
  const resolveEta = (c, v, t) => { c.eta = v; c.etaRes = true; c.tE = t || 0 }
  // `except` (#82): a key whose subtree is NOT sealed — a MOVE record's new_from may point above the moved node (its new parents
  // were new), but the moved node's own older records (under its old path) still follow. `recTs` (#82): the sealing record's time
  // — a node that was MOVED in under `n` at or after it (it, or a node between it and n: movedAt) wasn't part of that instance then
  function sealNode(s, n, marker, except, recTs, own) {   // own: the sealing record's own chain (always part of it — even moved away and back)
    for (const x of s.nodes.values()) {
      if (x.sealed || !(x.key === n.key || n.key === '' || x.key.startsWith(n.key + '/'))) continue
      if (except != null && (x.key === except || x.key.startsWith(except + '/'))) continue
      if (recTs != null && x !== n && !(own && own.has(x))) { let y = x, later = false; while (y && y !== n) { if (y.movedAt >= recTs) { later = true; break } y = s.nodes.get(parentKeyOf(y.key)) } if (later) continue }
      if (!x.etaRes) resolveEta(x, x.hasPend ? x.pend : null, x.hasPend ? x.tPend : 0)
      x.curFound = x.progFound = x.finRes = x.peRes = x.rankRes = true; x.sealed = true; if (marker) x.marker = true
    }
  }
  /**
   * #82: the PATH HISTORY. A move record (moved_from) registers { fromKey, fromLen, toSegs } on its session (newest first, as fed);
   * the path an OLDER record names is replayed through the moves made after it, OLDEST FIRST, giving the path that node has NOW.
   * feed() maps every node of a record's chain this way, one by one (a moved node's old parents stay where they are).
   */
  function remapSegs(s, segs, used) {   // used (a Set, optional): the moves that applied
    if (!s || !s.mv.length || !segs.length) return segs
    for (let i = s.mv.length - 1; i >= 0; i--) {
      const m = s.mv[i]
      if (under(pathKey(formatPath(segs)), m.fromKey)) { segs = [...m.toSegs, ...segs.slice(m.fromLen)]; if (used) used.add(m) }
    }
    return segs
  }
  /** The replay node at `sg` (created with its missing ancestors, implicit). */
  function ensureIn(s, sg) {
    const ks = chainKeys(sg)
    let p = s.nodes.get('')
    for (let j = 1; j < ks.length; j++) {
      let n = s.nodes.get(ks[j])
      if (!n) { const x = sg.slice(0, j); n = rNode(childPath(p, x[j - 1]), x); s.nodes.set(ks[j], n); if (n.kind === 'agent') s.nAgents++ }
      p = n
    }
    return p
  }
  // a node that ENDED with a record (dismissed, evicted) never moved again: only its PARENT's path follows the later moves
  const remapGone = (s, segs) => (segs.length ? [...remapSegs(s, segs.slice(0, -1)), segs[segs.length - 1]] : segs)
  const nodeDone = n => !n.seen || (n.curFound && n.progFound && n.etaRes && (n.kind !== 'agent' || n.finRes))
  const newRSession = (sk, rec) => {
    const s = { key: sk, realm: 'default', session: rec.session, project: 'unclassified', user: null, host: state.origin, created: null, last: -Infinity, nodes: new Map(), dead: new Set(), dms: [], nAgents: 0, mv: [] }
    s.nodes.set('', rNode('', []))
    return s
  }
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
    const sk = keyOf(state, rec)
    let s = sessions.get(sk)
    // #82: every node of the record's chain AS IT IS NOW — each node's path replayed through the moves made after the record (a
    // moved node's OLD parents stay where they are: they keep this record's activity; its NEW parents never saw it)
    const orig = pp.segs, L = orig.length, oseg = [], okey = [], isDismiss = kind === 'entry' && rec.dismiss === true
    const used = []   // #82: per chain node, the moves that applied to its path
    for (let i = 0; i <= L; i++) { used.push(new Set()); const sg = isDismiss && i === L ? remapGone(s, orig) : remapSegs(s, orig.slice(0, i), used[i]); oseg.push(sg); okey.push(pathKey(formatPath(sg))) }   // a dismissed node itself never moved again
    const tKey = okey[L], nf0 = Number.isInteger(rec.new_from) && rec.new_from >= 0 ? rec.new_from : null
    const onChain = i => i === L || !okey[i] || tKey === okey[i] || tKey.startsWith(okey[i] + '/')   // still an ancestor-or-self of the target
    const isMove = kind === 'entry' && typeof rec.moved_from === 'string'
    let mvAlias = null
    if (isMove) {   // #82: a MOVE — register it (even if this record is skipped below: what was under the old path moved all the same)
      const fp = parsePath(rec.moved_from)
      if (fp.ok && fp.key) {
        if (!s) { s = newRSession(sk, rec); sessions.set(sk, s) }
        s.mv.push(mvAlias = { fromKey: fp.key, fromLen: fp.segs.length, toSegs: orig, node: null })
      }
    }
    // #82: a node that got where it is by a MOVE made after this record owns the record only if that move carried it there — else the
    // record belongs to whatever was at that path before (an instance that ended) and lands on it by name only
    const foreign = i => { const X = s && s.nodes.get(okey[i]); if (!X) return false; for (const a of s.mv) if (a.node === X && !used[i].has(a)) return true; return false }
    const deadAt = i => !!s && (s.dead.has(okey[i]) || !!(s.nodes.get(okey[i]) && s.nodes.get(okey[i]).sealed) || foreign(i))
    // #82: an old ancestor the record's node moved away from is gone when it ended since — or, no longer there, when a node above it now
    // ended or BEGAN after this record (it would be a new child of a later instance: the old one went with an ancestor)
    const goneAt = i => {
      if (!s) return false
      if (deadAt(i)) return true
      const ks = chainKeys(oseg[i])
      if (ks.some(x => s.dead.has(x))) return true
      // a node above it that BEGAN after this record (sealed), with nothing between them moved in since: it was under that node's
      // older instance, which ended (dismissed / expired / evicted with it) — its name only lands on the new one
      for (let j = ks.length - 2; j >= 0; j--) {
        const S = s.nodes.get(ks[j])
        if (!S || !S.sealed) continue
        let movedIn = false
        for (let k = j + 1; k < ks.length; k++) { const y = s.nodes.get(ks[k]); if (y && y.movedAt >= rec.ts) { movedIn = true; break } }
        if (!movedIn) return true
      }
      return false
    }
    if (s) {
      let bad = -1
      // an evicted (6d: or dismissed) older instance, or an older instance of a node on the chain (#82: a DISMISSAL is checked above its
      // target only — its entry belongs to the parent's log even when the name was used again later, which seals the target)
      for (let i = 0; i <= (isDismiss ? L - 1 : L); i++) if (onChain(i) && deadAt(i)) { bad = i; break }
      if (bad < 0 && !isDismiss && goneAt(L)) bad = L   // #82: it was moved under a node that ended later (dismissed / evicted with it), or now names a later instance's subtree
      if (bad >= 0) {
        // #82: the ancestors ABOVE that point were there then (this record named them, maybe created them): keep them as the live apply
        // did — created_at, and the activity it gave the ones from its owner down (an implicit parent left empty by a dismissal stays)
        const oi0 = ownerIndex(orig), sys0 = kind === 'entry' && !!normBy(rec.by), cAt0 = kind === 'cf' && finite(rec.created_at) ? Math.min(rec.created_at, rec.ts) : rec.ts
        const kept = new Array(L + 1).fill(null)
        if (bad > 0) {   // the session itself was there then too (a session whose only node was dismissed still shows, as live)
          kept[0] = s.nodes.get('')
          if (kept[0].created == null || cAt0 < kept[0].created) { kept[0].created = cAt0; kept[0].cFeed = feedNo }
          s.session = rec.session.trim(); s.project = str(rec.project) || 'unclassified'; s.user = str(rec.user); s.realm = str(rec.realm) || 'default'
          s.created = s.created == null ? cAt0 : Math.min(s.created, cAt0)
          if (finite(rec.s0) && rec.s0 > 0 && rec.s0 < s.created) s.created = rec.s0
          if (kind !== 'cf' && !sys0) { s.last = Math.max(s.last, rec.ts); if (oi0 === 0) { kept[0].seen = true; kept[0].last = Math.max(kept[0].last, rec.ts); kept[0].tA = Math.max(kept[0].tA, rec.ts); kept[0].implicit = false } }
        }
        for (let i = 1; i < L; i++) {   // the target's ancestors above `bad`, and any old ancestor it has moved away from
          if ((onChain(i) && i >= bad) || goneAt(i)) continue
          const n = kept[i] = ensureIn(s, oseg[i])
          if (n.created == null || cAt0 < n.created) { n.created = cAt0; n.cFeed = feedNo }
          if (kind !== 'cf' && i >= oi0 && !sys0) { n.seen = true; n.last = Math.max(n.last, rec.ts); n.tA = Math.max(n.tA, rec.ts); if (i === oi0) n.implicit = false }
        }
        // 6d: the record still BEGAN the run of a live ancestor above that point (new_from) — mark it (else a session whose first
        // record was on a dismissed / evicted path would look partial after a restart); #82: each of them, where it is now
        if (nf0 != null) sealRuns(s, kept, nf0, rec.ts)
        skipped++; return 'skip'
      }
    }
    if (kind === 'entry' && rec.dismiss === true) {   // 6d: a DISMISSAL — what was at / under that path then is an ended instance (like `evicted`)
      if (!s) { s = newRSession(sk, rec); sessions.set(sk, s) }
      fed++
      if (!tKey) { if (!s.nodes.get('').sealed) s.dead.add('') }   // the whole session: no newer run of it (that would have sealed the root)
      else { if (!s.nodes.has(tKey)) s.dead.add(tKey); s.dms.push(tKey !== pp.key ? { ...rec, path: formatPath(oseg[L]) } : rec) }   // the entry belongs to the PARENT's log (attached in build)
      return 'ok'
    }
    // the nodes to hold: the target's chain now, and each old ancestor it has moved away from (unless that one ended since)
    const want = [L]
    for (let i = 1; i < L; i++) if (!onChain(i) && !goneAt(i)) want.push(i)
    if (s) {
      const miss = new Map()
      for (const i of want) { const ks = chainKeys(oseg[i]); for (let j = 1; j < ks.length; j++) if (!s.nodes.has(ks[j])) miss.set(ks[j], oseg[i][j - 1].kind) }
      const newA = [...miss.values()].filter(k => k === 'agent').length
      if (s.nodes.size - 1 + miss.size > ACTIVITY_LIMITS.nodesPerSession || s.nAgents + newA > ACTIVITY_LIMITS.agentsPerSession) { skipped++; return 'skip' }
    }
    // ---- accepted: create what's new ----
    if (!s) { s = newRSession(sk, rec); sessions.set(sk, s) }
    const sess0 = s, ensure = sg => ensureIn(sess0, sg)
    const tgt = ensure(oseg[L])
    const onode = okey.map((k, i) => (onChain(i) ? s.nodes.get(k) : want.includes(i) ? ensure(oseg[i]) : null))   // the record's chain, node by node, as it is now (null: ended since)
    fed++
    // identity spellings: every record carries the canonical (first-seen) one; the OLDEST record's is kept
    s.session = rec.session.trim(); s.project = str(rec.project) || 'unclassified'; s.user = str(rec.user); s.realm = str(rec.realm) || 'default'
    const oi = ownerIndex(orig), isCf = kind === 'cf'
    const isSys = kind === 'entry' && !!normBy(rec.by)   // 6c: a SYSTEM entry (auto-abandon; 6d: a dashboard action) is nobody's activity
    // a cf restores its TARGET only (its own implicit flag, created_at, last_activity); any other record marks target + owner reported
    if (isCf) { if (rec.implicit !== true) tgt.implicit = false } else { tgt.implicit = false; if (!isSys && onode[oi]) onode[oi].implicit = false }
    if (rec.plan_item === true) { tgt.plan = true; if (tgt.planIx == null && Number.isInteger(rec.plan_ix)) tgt.planIx = rec.plan_ix }
    if (!tgt.rankRes && 'rank' in rec) { tgt.rank = validRank(rec.rank); tgt.rankRes = true; tgt.tR = rec.ts }   // #82: the newest record that placed it (or a snapshot)
    if (isMove) { tgt.moved.push({ from: String(rec.moved_from), at: rec.ts }); tgt.movedAt = Math.max(tgt.movedAt, rec.ts); if (mvAlias) mvAlias.node = tgt }
    if (isCf && Array.isArray(rec.moved)) for (const m of rec.moved) if (m && typeof m.from === 'string' && finite(m.at)) { tgt.moved.push({ from: m.from, at: m.at }); tgt.movedAt = Math.max(tgt.movedAt, m.at) }
    if (isMove || (isCf && Array.isArray(rec.moved))) tgt.tM = Math.max(tgt.tM, rec.ts)
    const act = isCf ? (finite(rec.last_activity) ? Math.min(rec.last_activity, rec.ts) : rec.ts) : Math.max(rec.ts, repL)
    const cAt = isCf && finite(rec.created_at) ? Math.min(rec.created_at, rec.ts) : rec.ts
    if (!isSys) s.last = Math.max(s.last, act)
    for (const n of onode) if (n && (n.created == null || cAt < n.created || (cAt === n.created && feedNo > n.cFeed))) { n.created = cAt; n.cFeed = feedNo }   // the oldest known; on a tie, the earlier-written record
    s.created = s.created == null ? cAt : Math.min(s.created, cAt)
    if (finite(rec.s0) && rec.s0 > 0 && rec.s0 < s.created) s.created = rec.s0   // 6c: every record carries the session's created_at — exact even past the window (the HOME host)
    const lo = isCf ? L : oi
    for (let i = lo; i <= L; i++) { const n = onode[i]; if (!n) continue; n.seen = true; if (!isSys) { n.last = Math.max(n.last, act); n.tA = Math.max(n.tA, rec.ts) } }   // phase 1 waits only for nodes a record TOUCHED (target..owner), not bare ancestors
    if (kind === 'cp' || isCf) {
      if (kind === 'cp') cps++; else { cfs++; if (d === today) cfToday = true }
      const st = rec.current && ACTIVITY_STATES.includes(rec.current.state) ? rec.current.state : 'running'
      if (!tgt.curFound) { tgt.current = rec.current && typeof rec.current.text === 'string' && rec.current.text ? lineOf(rec.current) : null; tgt.curFound = true; tgt.tL = rec.ts }
      if (!tgt.progFound) { tgt.progress = wProgress(rec.progress) || null; tgt.progFound = true; tgt.tP = rec.ts }
      if (!tgt.etaRes) resolveEta(tgt, tgt.hasPend ? (DONE_OR_FAILED.has(st) ? null : tgt.pend) : (finite(rec.eta_at) ? rec.eta_at : null), tgt.hasPend ? tgt.tPend : rec.ts)
      if (tgt.kind === 'agent' && !tgt.finRes) { tgt.finAt = finite(rec.finished_at) ? rec.finished_at : (DONE_OR_FAILED.has(st) && rec.current ? rec.current.ts : null); tgt.finRes = true }
      if (isCf && !tgt.saSet) { tgt.sa = rec.stale_after_ms > 0 ? rec.stale_after_ms : null; tgt.saSet = true }
      if (tgt.kind === 'agent' && !tgt.peRes && 'plan_end' in rec) { tgt.pe = wPlanEnd(rec.plan_end); tgt.peRes = true }   // 6d: a snapshot carries the marker
      if (isCf && tgt.cnt == null && Number.isInteger(rec.log_n) && rec.log_n >= 0) { tgt.cnt = tgt.total + rec.log_n; tgt.cntAt = rec.ts; tgt.cntPartial = rec.log_partial === true }   // 6d: the exact count then + what came after it
    } else {
      entries++
      tgt.total++
      if (tgt.log.length < N) tgt.log.push(smallOf(rec))
      else if (!tgt.floor) tgt.floor = rec.ts   // the newest entry that doesn't fit = the newest one only in the files
      if (!isSys) for (let i = oi; i <= L; i++) { const n = onode[i]; if (n && !n.saSet) { n.sa = rec.stale_after_ms > 0 ? rec.stale_after_ms : null; n.saSet = true } }
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
      if (tgt.kind === 'agent' && !tgt.peRes) {   // 6d: the plan-end marker — set / cleared by an entry; a ≤v4 abandoned line on an agent ended its plan too
        const pe = typeof rec.plan_end === 'string' ? rec.plan_end : rec.v < 5 && rec.current && rec.state === 'abandoned' ? 'abandoned' : null
        if (pe) { tgt.pe = pe === 'open' ? null : wPlanEnd({ state: pe, ts: rec.ts }); tgt.peRes = true }
      }
      if (Array.isArray(rec.evicted)) for (const p of rec.evicted) { const q = parsePath(String(p)); if (!q.ok || !q.key) continue; const k = pathKey(formatPath(remapGone(s, q.segs))); if (k && !s.nodes.has(k)) s.dead.add(k) }   // that subtree's older instance ended here (#82: under its path now)
    }
    // the record that BEGAN an instance seals it: every node of its chain from new_from down (#82: node by node as they are now —
    // each run of nodes still parent → child is sealed by its head; a MOVE's new_from may name its NEW parents: the moved node itself
    // is never sealed by it, its older records follow)
    if (nf0 != null && nf0 <= L) sealRuns(s, isMove && nf0 < L ? onode.map(n => (n === tgt ? null : n)) : onode, nf0, rec.ts)   // a move's own node is never sealed by it (its movedAt = this record's time keeps its subtree out too)
    return 'ok'
  }
  /** Seal what a record BEGAN: nodes[nf0..] (its chain node by node as they are now; null = left out), each run of nodes still
   * parent → child by its head; nodes moved in under them at / after recTs are left out (sealNode); the record's own chain never is. */
  function sealRuns(s, nodes, nf0, recTs) {
    const own = new Set(nodes.slice(nf0).filter(Boolean))
    for (let i = nf0; i < nodes.length; i++) {
      const n = nodes[i]
      if (!n || n.sealed) continue
      if (i > nf0 && nodes[i - 1] && parentKeyOf(n.key) === nodes[i - 1].key) continue   // sealed with its run's head
      sealNode(s, n, true, null, recTs, own)
    }
  }
  function lineOf(r) {
    const data = r.data != null && typeof r.data === 'object' ? r.data : null
    const lb = r.line_by && typeof r.line_by === 'object' ? normBy(r.line_by) : null   // #83: who wrote its text (an entry's / a cp's current line_by; never the entry's own `by`)
    const qn = normQuestion(r.question)   // #85: the line's question (an entry's / a cp's / a cf's current.question)
    return { id: String(r.id || ''), ts: finite(r.ts) ? r.ts : 0, text: typeof r.line_text === 'string' && r.line_text ? r.line_text : String(r.text), state: ACTIVITY_STATES.includes(r.state) ? r.state : 'running',   // 6d: line_text = the line's own text (the entry's says what a dashboard did)
      details: typeof r.details === 'string' && r.details ? r.details : null, data, data_bytes: data != null ? utf8(JSON.stringify(data)) : 0, ...(lb && typeof lb === 'object' ? { by: lb } : {}), ...(qn ? { question: qn } : {}) }
  }
  /** Nodes seen so far whose phase-1 fields are not all resolved yet. */
  function pending() { let n = 0; for (const s of sessions.values()) for (const x of s.nodes.values()) if (!nodeDone(x)) n++; return n }
  /** Does `day`'s file still hold an older cp that an in-window rep line needs? (keep reading it past the window) */
  const wantsOlder = day => { const m = repLast.get(day); return !!(m && m.size) }
  function build(withLogs) {
    const out = new Map()
    for (const s of sessions.values()) {
      if ((s.dead.has('') && s.nodes.size === 1) || s.created == null) continue   // 6d: a dismissed session with no newer run (#82: or one only a skipped move named)
      if (withLogs) for (const dm of s.dms) {   // 6d: a dismissal's entry is in its PARENT's log (when that instance was there then)
        const r = s.nodes.get(parentKeyOf(pathKey(dm.path)))
        if (!r || r.sealed && r.created != null && r.created > dm.ts) continue
        r.log.push({ ...smallOf(dm), path: dm.path }); r.total++
        if (r.cnt != null && dm.ts > r.cntAt) r.cnt++
      }
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
    if (n.kind === 'agent') n.plan_end = r.pe || null   // 6d: the plan-end marker
    n.partial = !r.marker   // 6c: the replay never saw the record that began this run (it began before the window)
    n.cpartial = !r.marker && (r.cnt == null || r.cntPartial)   // 6d: …but a carry-forward's count makes its count exact
    n.pt = { a: r.tA, l: r.tL, p: r.tP, e: r.tE, r: r.tR, m: r.tM }   // what the window holds: the carry-forward re-checkpoints what would fall out of it
    n.rank = r.rank || null   // #82: its stored rank (null = derived)
    if (r.moved.length) {   // #82: its move history (move records + a carry-forward's list), oldest first, de-duplicated, the newest 8
      const seen = new Set(), ms = []
      for (const m of r.moved.slice().sort((a, b) => a.at - b.at)) { const k = m.at + '\u0001' + m.from; if (!seen.has(k)) { seen.add(k); ms.push({ from: m.from, at: m.at }) } }
      n.moved = ms.slice(-8)
    }
    if (withLogs) {
      n.log = r.log.slice().reverse().sort(ordCmp)
      let shiftedTs = 0
      while (n.log.length > N) shiftedTs = Math.max(shiftedTs, n.log.shift().ts)   // 6d: a dismissal's entry attached late may push the log over its cap (#82: its floor moves up as a live drop's does)
      n.log_dropped = Math.max(0, (r.cnt != null ? r.cnt : r.total) - n.log.length)   // 6d: the cf's count when one was met (exact)
      n.log_floor = Math.max(r.floor || (r.marker ? 0 : (r.total ? cutoff : 0)), shiftedTs)   // an instance that began before the window: older entries are only in the files
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

// ---------------------------------------------------------------------------------------------------------------
// read views (the `activity` tool; the dashboard builds on the raw form)

// a current line renders against the node's BAR (its reported progress, else its rollup) + ETA
// #83: `by` = who wrote the line's text when not its session ({ user, host } — a dashboard edit)
const lineByView = l => (l && l.by && typeof l.by === 'object' ? { user: l.by.user, host: l.by.host } : null)
const lineView = (l, p, eta, now) => (l ? compact({ id: l.id, ts: l.ts, text: l.text, rendered: renderText(l.text, p, eta, now), state: l.state,
  has_details: !!(l.details || l.has_details), has_data: !!(l.data != null || l.has_data), by: lineByView(l), question: l.question ? questionView(l.question) : null }) : null)   // #85: + question
const rawLine = l => (l ? compact({ id: l.id, ts: l.ts, text: l.text, state: l.state, has_details: !!(l.details || l.has_details), has_data: !!(l.data != null || l.has_data), by: lineByView(l),
  question: l.question ? questionView(l.question) : null }) : null)   // #85: + question
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
 *   finished/gone agents with their subtrees (6b: unless the subtree holds part of an OPEN plan) and ENDED plans (6c: every
 *   item done, or the node marked complete / abandoned: the items, and the plan node when it is a plain context with nothing
 *   else shown and no live line); raw = the dashboard form (reported states, raw templates + times, own `progress` + the
 *   rolled-up `bar`). 6b: a plan item carries `plan_item:true` (+ `plan_ix`) and never shows stale or gone. 6c: a plan
 *   node carries `plan_node:true` + `plan_end_at` (absent while open); `log` carries the node's own count (`total`,
 *   `partial` when it understates); a multi-host group carries `home` (the host it first appeared on).
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
    // 6c: the node's OWN entry count (`total`, the dashboard sums a subtree) — local: memory + dropped; remote: gossiped. partial =
    // its run began before the owner's replay window: the count understates (older entries live only in the day files)
    const lg = local ? compact({ entries: n.log.length, dropped: n.log_dropped, total: n.log.length + n.log_dropped, partial: !!n.cpartial }) : compact({ remote: true, total: n.log_n || 0, partial: !!n.cpartial })   // 6d: cpartial (a cf's count is exact)
    const isAg = n.kind === 'agent', pl = planOf(s, n)
    const base = { path: n.path, kind: n.kind, name: n.key ? n.name : null, depth: n.depth, parent: n.key ? (s.nodes.get(n.parent) || { path: n.parent }).path : null, host,
      plan_item: n.plan || null, plan_ix: n.plan && Number.isInteger(n.plan_ix) ? n.plan_ix : null,
      plan_node: pl ? true : null, plan_end_at: pl ? planEndAt(s, n, pl) : null, plan_end_how: pl ? planEndHow(s, n, pl) : null,   // 6c: a node holding plan items; when its plan ended (null = open); 6d: how (all-done | done | abandoned)
      rank: n.key ? rankOf(n) : null, rank_set: n.key && validRank(n.rank) ? true : null }   // #82: its position among its siblings (plan items, then contexts, then agents — each by rank); rank_set = placed explicitly
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
    // 6c (#70 "Decisions before 6c and 6d" 7): the HOME host = the host the session first appeared on — the earliest-created
    // root across hosts (created_at rides every gossip header and, since v4, every record as s0), ties by host name; top-level
    // host tags compare with it, so they never flip with the headline
    const home = multi ? parts.reduce((b, p) => (p.s.created_at < b.s.created_at || (p.s.created_at === b.s.created_at && cmp(lc(p.host), lc(b.host)) < 0) ? p : b), parts[0]).host : null
    out.push(compact({ session: lead.session, project: lead.project, user: lead.user, realm: lead.realm, host: multi ? null : hosts[0], hosts: multi ? hosts : null, multi_host: multi, home,
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
 * gone agent with its subtree — unless that subtree holds part of an OPEN plan (kept, with its ancestors) — and every ENDED
 * plan's items (6c: planEndAt — all done, or its node marked complete / abandoned; the plan node too when it is a plain
 * context with nothing else left shown and no live line of its own).
 */
function activeHidden(sess, list) {
  const open = openPlanKeys(sess), hide = new Set(), ended = new Set()
  for (const n of [sess.nodes.get(''), ...list]) { const p = n && planOf(sess, n); if (p && planEndAt(sess, n, p) != null) ended.add(n.key) }
  for (const n of list) {
    if (open.has(n.key)) continue
    if (hide.has(n.parent) || (n.kind === 'agent' && !isActive(n)) || ((n.plan || (isQuestion(n) && !isOpenQuestion(n))) && ended.has(n.parent))) hide.add(n.key)   // #85: + a closed question of an ended plan
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
  const target = { realm: s.realm, project: s.project, user: s.user, session: s.session, key: node.key, own, depth: node.depth, partial: !!node.partial,   // 6c: depth + partial for the run boundary (filePage)
    ...nodeAliases(s, node, !own) }   // #82: the old paths its history was written under (moved_from) — the day files are searched under them too
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
    const ep = e.path != null ? e.path : best.n.path   // 6d: a dismissal's entry sits in its parent's log with the dismissed node's path
    const x = { ...e, path: ep, rel: relPath(ep, node.path), rendered: renderText(e.text, e.progress, e.eta_at, now) }
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
  return !!matchAlias(rec, target)
}
/**
 * #82: which name of `target` a day-file record was written under: { a:null } = its current path (written after its last move —
 * `after`), { a: alias } = an OLD path (a moved_from of the node, of an ancestor, or — a subtree log — of a node now under it,
 * written in [alias.after, alias.before]); null = neither.
 */
function matchAlias(rec, target) {
  const k = pathKey(rec.path), t = target.key || '', ts = Number(rec.ts) || 0
  if ((target.own ? k === t : under(k, t)) && !(target.after > ts)) return { a: null }
  for (const a of target.aliases || []) if ((target.own ? k === a.key : under(k, a.key)) && ts <= a.before && ts >= a.after) return { a }
  return null
}
/**
 * #82: the old paths a node's history was written under — { aliases:[{ key, depth, base, before, after, start }], after } (both
 * absent when it never moved). For each move event of the node or an ancestor (node.moved: { from, at }): records under that old
 * path (+ the node's relative path below the moved one) written in [after, before] are the node's — `after` = the latest earlier
 * move on the path between them (before that the node wasn't there yet); `start` = it can hold the record that BEGAN the node's
 * run. A subtree log adds each node under it that was moved in (start:false). `after` on the result: a record at the CURRENT
 * path written before the latest move on the node's path belongs to whatever was there before. At most 32 aliases.
 */
export function nodeAliases(sess, node, subtree) {
  const up = []
  for (let n = node; n; n = n.parent != null ? sess.nodes.get(n.parent) : null) up.push(n)
  const evs = []
  for (const A of up) for (const m of A.moved || []) evs.push({ A, m })
  const aliases = []
  const add = (from, rel, depth, base, before, after, start) => { const p = parsePath(from + rel); if (p.ok && aliases.length < 32) aliases.push({ key: p.key, depth, base, before, after, start }) }
  let latest = 0
  for (const { A, m } of evs) {
    latest = Math.max(latest, m.at)
    let after = 0
    for (const e of evs) if (e.m.at < m.at && e.A.depth >= A.depth) after = Math.max(after, e.m.at)
    const fp = parsePath(m.from)
    if (!fp.ok) continue
    add(m.from, node.path.slice(A.path.length), fp.segs.length + (node.depth - A.depth), node.path, m.at, after, true)
  }
  if (subtree) for (const k of subtreeKeys(sess, node.key).slice(1)) {
    const D = sess.nodes.get(k)
    const ms = (D && D.moved) || []
    ms.forEach((m, i) => { const fp = parsePath(m.from); if (fp.ok) add(m.from, '', fp.segs.length, D.path, m.at, i ? ms[i - 1].at : 0, false) })
  }
  return aliases.length ? { aliases, after: latest } : {}
}
/** A day-file entry in logView's entry shape (the small in-memory form + path, rel and `rendered` as recorded). #82: with the
 * target, an entry written under an OLD path (an alias) shows the path its node has now. */
export const fileEntryView = (rec, now, basePath = '', target = null) => {
  let path = rec.path
  const hit = target && target.aliases ? matchAlias(rec, target) : null
  if (hit && hit.a) { const p = parsePath(rec.path); if (p.ok) { const rest = formatPath(p.segs.slice(hit.a.depth)); path = hit.a.base && rest ? `${hit.a.base}/${rest}` : (hit.a.base || rest) } }
  return { ...smallOf(rec), path, rel: relPath(path, basePath), rendered: renderText(rec.text, rec.progress, rec.eta_at, now) }
}
/**
 * 6c: did this day-file record BEGIN the current run of `target` (logView's files.target)? It is the first persisted record of
 * that node's instance: a record of the same session at or under the node whose `new_from` (the first new index on its chain
 * root..target) is at or above the node's depth — any kind (an entry, a cp, a cf). Read newest first, the first such record
 * met is the CURRENT run's start; everything older under the node belongs to earlier runs.
 */
export function fileRunStart(rec, target) {
  const k = recordKind(rec)
  if (!k || k === 'rep' || !target || !Number.isInteger(rec.new_from) || rec.new_from < 0) return false
  if (lc(rec.session) !== lc(target.session) || projKey(rec.project) !== projKey(target.project) || lc(rec.user) !== lc(target.user)) return false
  if ((lc(rec.realm) || 'default') !== (lc(target.realm) || 'default')) return false
  // #82: a MOVE record's new_from names the moved node's NEW parents — it began their run, never the moved node's (or anything under it)
  if (typeof rec.moved_from === 'string' && under(target.key || '', pathKey(rec.path))) return false
  const hit = matchAlias(rec, { ...target, own: false })
  if (!hit) return false
  return hit.a ? (hit.a.start && rec.new_from <= hit.a.depth) : rec.new_from <= (Number(target.depth) || 0)
}
/**
 * 6c: the DAY-FILE half of a log page (the I/O-free part of the bridge's actLogPage; `records` is the facet's readBackwards
 * from `files.from` — any (async) iterable of { rec, day, offset, length }, NEWEST FIRST). Continues `lv` (logView's result:
 * its entries, path) with the target's matching entries, up to files.need entries / opts.maxBytes of JSON, reading at most
 * opts.scanBytes of file. RUN BOUNDARY (#70 step-6 answer 5): it STOPS at the record that began the node's CURRENT run
 * (fileRunStart) — `run_start:true`, next_cursor null, and `earlier_cursor` (a file cursor: pass it as cursor with
 * earlier:true — "show earlier runs") when an older entry of the node exists before it (a bounded peek; one that runs out of
 * scan budget offers it anyway). With opts.earlier the boundary is ignored. When the files run out WITHOUT meeting the run's
 * start and the node's run began before the replay window (target.partial), the start lay in a file retention has already
 * deleted: `pruned:true` ("earlier history pruned", never a silent gap). Returns lv (mutated): entries, next_cursor,
 * from_files (+ run_start, earlier_cursor, pruned).
 * @param {any} lv @param {any} files @param {AsyncIterable<any>|Iterable<any>} records
 * @param {{ now?: number, maxBytes?: number, scanBytes?: number, earlier?: boolean }} [opts]
 */
export async function filePage(lv, files, records, opts = {}) {
  const f = files, out = lv.entries, now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const maxB = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : Infinity, scanMax = Number(opts.scanBytes) > 0 ? Number(opts.scanBytes) : Infinity
  let bytes = f.bytes || 0, scanned = 0, last = null, lastHit = null, stop = null, n = 0, boundary = null, peek = false
  for await (const r of records) {
    scanned += (r.length || 0) + 1; last = r
    const rec = r.rec
    if (boundary) {   // past the run's start: only look whether an EARLIER run left an entry of this node
      if (rec && fileEntryMatches(rec, f.target)) { peek = true; break }
      if (scanned >= scanMax) { peek = true; break }   // unknown within the budget: offer it anyway
      continue
    }
    if (rec && fileEntryMatches(rec, f.target) && !(f.before && (rec.ts > f.before.ts || f.before.ids.has(rec.id)))) {
      const x = fileEntryView(rec, now, lv.path, f.target), b = utf8(JSON.stringify(x)) + 1   // #82: an entry under an old path shows the node's path now
      if (n >= f.need || (out.length && bytes + b > maxB)) { stop = 'full'; break }
      out.push(x); bytes += b; n++; lastHit = r
    }
    if (!opts.earlier && rec && fileRunStart(rec, f.target)) { boundary = r; continue }   // its own entry (taken above) is part of the run
    if (scanned >= scanMax) { stop = 'scan'; break }
  }
  lv.from_files = n
  if (boundary) {
    lv.next_cursor = null; lv.run_start = true
    if (peek) lv.earlier_cursor = fileCursor(boundary.day, boundary.offset)
  } else if (stop === 'full') lv.next_cursor = lastHit ? fileCursor(lastHit.day, lastHit.offset) : (out.length ? out[out.length - 1].id : null)
  else if (stop === 'scan') lv.next_cursor = fileCursor(last.day, last.offset)
  else { lv.next_cursor = null; if (!opts.earlier && f.target && f.target.partial) lv.pruned = true }
  return lv
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
  for (const s of state.local.values()) {
    const who = { session: s.session, project: s.project, user: s.user, realm: s.realm, host: s.host }
    for (const n of s.nodes.values()) {
      if (n.current && n.current.id === id) {
        const l = n.current
        const r = renderText(l.text, rollup(s, n), n.eta_at, now)
        return { where: 'current', complete: true, entry: { id: l.id, ts: l.ts, ...who, path: n.path, kind: n.kind, current: true, text: l.text, rendered: r, state: l.state, details: l.details || null, data: l.data != null ? l.data : null, ...(l.question ? { question: questionView(l.question) } : {}) } }
      }
      if (!hit) { const x = n.log.find(y => y.id === id); if (x) hit = { where: 'log', complete: !x.has_details && !x.has_data, entry: { ...x, ...who, path: x.path != null ? x.path : n.path, kind: n.kind, current: !!x.current, rendered: renderText(x.text, x.progress, x.eta_at, now), details: null, data: null } } }
    }
  }
  return hit
}

// ---------------------------------------------------------------------------------------------------------------
// gossip: snapshot + per-origin merge (FORMAT v2: one unit per node)

function snapLine(l) {
  return l ? compact({ id: l.id, ts: l.ts, text: l.text, state: l.state, has_details: !!(l.details || l.has_details), has_data: !!(l.data != null || l.has_data),
    by: l.by && typeof l.by === 'object' ? { kind: 'dashboard', user: l.by.user, host: l.by.host } : null,   // #83: who wrote its text (a ≤1.69 receiver ignores it)
    question: l.question ? qOut(l.question) : null }) : null   // #85: the line's question (a ≤1.70 receiver ignores it: a blocked / done / abandoned context)
}
/** A node's replicated form: its OWN fields (never children, rollup, log, details/data). 6b: + plan_item / plan_ix. 6c: + log_n
 * (its OWN entry count: memory + dropped; a remote node re-gossips what it was told) and log_partial (the count understates). */
function snapNode(n) {
  return compact({ path: n.path, created_at: n.created_at, last_activity: n.last_activity, finished_at: n.finished_at, gone_at: n.kind === 'agent' ? n.gone_at : null,
    stale_after_ms: n.stale_after_ms, implicit: n.implicit, progress: n.progress ? { done: n.progress.done, total: n.progress.total, unit: n.progress.unit, ...(n.progress.skipped > 0 ? { skipped: n.progress.skipped } : {}) } : null,   // #79: + skipped, only when > 0 (a 1.65 reader ignores it)
    eta_at: n.eta_at, current: snapLine(n.current), plan_item: !!n.plan, plan_ix: n.plan && Number.isInteger(n.plan_ix) ? n.plan_ix : null,
    log_n: (n.log_n != null ? n.log_n : n.log.length + n.log_dropped) || null, log_partial: !!n.cpartial,   // 6d: partial = the COUNT understates (a cf's count makes it exact)
    plan_end: n.kind === 'agent' && n.plan_end ? { state: n.plan_end.state, ts: n.plan_end.ts } : null,
    rank: validRank(n.rank) })   // #82: a STORED rank only (a 1.68 receiver ignores it; every receiver derives the rest from created_at + plan_ix)   // 6d: the plan-end marker (receivers compute plan_end_at)
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
  const by = l.by && typeof l.by === 'object' ? normBy({ ...l.by, kind: 'dashboard' }) : null   // #83
  const question = normQuestion(l.question)   // #85: bounded (untrusted)
  return { id: typeof l.id === 'string' ? l.id.slice(0, 100) : '', ts: wTime(l.ts) || 0, text, state: ACTIVITY_STATES.includes(l.state) ? l.state : 'running',
    has_details: !!l.has_details, has_data: !!l.has_data, ...(by && typeof by === 'object' ? { by } : {}), ...(question ? { question } : {}) }
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
    if (n.current) delete n.current.question   // #85: an agent is never a question
  } else if (r.plan_item === true) { n.plan = true; n.plan_ix = Number.isInteger(r.plan_ix) && r.plan_ix >= 0 && r.plan_ix < ACTIVITY_LIMITS.planItems ? r.plan_ix : null }
  n.log_n = Number.isInteger(r.log_n) && r.log_n > 0 ? Math.min(r.log_n, 1e9) : 0   // 6c: the owner's own-entry count
  n.partial = n.cpartial = r.log_partial === true
  if (n.kind === 'agent') n.plan_end = wPlanEnd(r.plan_end)   // 6d
  n.rank = validRank(r.rank)   // #82
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
const lineB = l => (l ? OBJ + sB(l.id) + sB(l.text) + sB(l.state) + 16 + (l.details ? sB(l.details) : 0) + (l.data != null ? OBJ + 2 * (l.data_bytes || 0) : 0) + (l.question ? qB(l.question) : 0) : 0)
const qB = q => OBJ * 2 + NUMS + (q.choices || []).reduce((n, c) => n + sB(c), 0) + (q.answer ? sB(q.answer.choice) + sB(q.answer.text) : 0)   // #85
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
