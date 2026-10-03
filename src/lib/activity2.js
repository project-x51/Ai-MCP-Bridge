// #88 (v2.0) build step 2a: the ID-KEYED MODEL's STRUCTURE and RESOLUTION (docs/spec-88.md §1 – §3, §5.1).
//
// Written BESIDE the 1.7x path model in lib/activity.js, which keeps serving the bridge (1.75 logic) until step 9 switches
// it; nothing imports this module yet except its tests (tests/unit/test_activity2_unit.mjs). It uses the step 1 identity
// primitives of lib/activity.js (mintId, validKey, slugKey, uniqueKey, normLabel, labelKey, parsePath2, parseRef,
// formatPath2) and #82's ranks (rankOf, rankBetween, derivedRank).
//
// WHAT IS HERE (2a):
// - A session holds its nodes KEYED BY ID (`nodes`), children by parent id (`kids`), the SCOPE index (creator id + lc(key)
//   → id; it holds GHOSTS' keys too, so a key names one node for good, §1.1), the SIBLING LABEL index (parent id +
//   labelKey(label) → id; live, non-merged nodes only, §1.6), the ALIAS table (labelKey(old display path) → id, §3.3) and
//   the GHOST table (removed nodes: id → { parent, key, creator, label, kind, removed_at … }, plus `gkids` by parent, §5.1).
// - applyCall(): target resolution (§3: --agent, --key, --id, --path, else the agent / the session root), references
//   (--under / --move / --merge, §3.2, with the `*_id` forms), the idempotent create (§3.5: location and label only at
//   creation, warning `exists`; `--label` equal to the `asked` label is no difference), ghost resurrection (§3.7: same id,
//   a new run), and the structural verbs: --move (+ --rename as one checked change), --rename, --merge, --unmerge,
//   --move-to (§3.8: create-if-missing, same-label ghost RESURRECTED, transient contexts, arrival last, the no-op retry,
//   Q45's bare-name refusal), --transient[=grace] (Q44) and --keep. Each structural change is a POINTER change that writes
//   ONE node record (move + rename: two records, one checked change).
// - The label rules (§1.6: label-required, AUTO-RENAME on create "x (2)" with `asked` + warning `relabelled`,
//   `duplicate-label` on a rename / move / merge / unmerge), the depth rules (Q11b: hard 32 → `depth`, naming the deepest
//   node; past 20 → warning `deep-tree`), and the refusals `cross-session`, `unknown-agent`, `not-an-agent`, `unknown-node`,
//   `bad-merge`, `bad-move`, `id-collision`.
// - Every call is ALL-OR-NOTHING: each mutation is journalled in a transaction and undone if any later check refuses.
// - Transient vanish (§3.8): when the last live child leaves a transient context it becomes a ghost (remove record
//   why:"transient"), bottom-up through emptied transient parents; with a grace period (Q44) it is only marked
//   `empty_since` and sweepTransients() (the owner's expiry pass) removes it later unless a child arrived meanwhile.
// - Alias lifetime (expireAliases) and ghost lifetime (pruneGhosts); capAt (the ~1 KB cap on an entry's `at`, Q11b) and
//   shortPath (the middle-cut display form).
//
// BUILD STEP 2b (docs/spec-88.md §4.0, §5.7, §3.8 Q46) adds, still beside the 1.7x model:
// - LINES and ENTRIES (§4.0): a report's text goes through parseText — plain text only LOGS, a leading `@` also SETS the
//   line (`@@` = a literal `@`); `--state` / `--progress` / `--eta` change the node whatever the text, and a state change
//   with plain text keeps the line's TEXT (one rule, no implied line: Q33). Every entry is a v6 entry { v:6, id, ts, n,
//   current, text, state, at, … } — `current` = the entry changed the line (its text or its state; `line_text` holds the
//   line's text when the entry's differs), `at` = the node's display path then, capped at ~1 KB (capAt). The structural
//   verbs' entries (moved / renamed / merged / unmerged / emptied) are real entries too. A call returns `records` (node
//   records), `entries` and `writes` (both, in the order written — what the bridge persists). Activity: a report refreshes
//   target..owner and the calling agent (§1.4); a system call (opts.by) refreshes nothing. A context's own line (a leading
//   `@`, or a question) makes a transient context permanent (§3.8).
// - PLANS (§4.1, §5.7): `plan:[ "label" | { key, label } ]` — keep / adopt / create (label-required, Q31; a sibling label
//   clash auto-renamed) / `exists-elsewhere`; each new or adopted item gets a ☐ line + entry; derived ranks, and a stored
//   rank only where a derived one would sort before an existing item. ROLLUP (bar2): a node holding plan items rolls up ONLY
//   its items ("N of M"; reverses 6c decision 7), a node without rolls up as before. The plan END (planOf2 / planEndAt2 /
//   planEndHow2 + the agent's plan-end marker) and the abandon CASCADE.
// - QUESTIONS (#85 / #90 on ids): ask (the node itself, or a new `?N` child keyed in the asker's scope), the asker's
//   withdrawal (state "withdrawn"), answerQuestion2 (answer + change answer), withdrawQuestion2, expireQuestions2,
//   questionOutcome2, nextQuestionExpiry2; an OPEN question never goes stale (staleAt2 / effectiveState2).
// - TYPES (Robin, 2026-10-03, "typed nodes and entries"; §1.7): two small built-in registries — NODE_TYPES (context, plan,
//   group, question, agent, session; test-run reserved until 2d) declare per type its fields, display, rollup, children and
//   the #92 menu slot; MESSAGE_TYPES (note, question, answer, withdrawal, expiry, event; test-result reserved until 2d) declare each entry
//   type's typed fields (validateEntryFields). `context_type` gives a NEW context its type, `message_type` + `fields` an
//   entry's; setType2 is the dashboard's Show as group / plan. GROUPS (§5.7) are type group: no bar (groupCount2 instead),
//   no plan end, nothing added to the parent's rollup. A question is type question; an answer an `answer` entry.
// - Q46: parseMoveTo accepts only `/…` and `../X`; a refused relative form answers `suggest:"/…"`; resolveCall = the
//   read-only `resolve` tool.
//
// BUILD STEP 2c (docs/spec-88.md §4.1, §1.6, §5.4, §5.5, §6.3) adds, still beside the 1.7x model:
// - POSITIONS (#82's ranks on ids): before / after (a §3.2 reference to a sibling, or *_id) and position first | last on
//   a NEW target, on the plan items a call creates, on --move (where it lands), and alone on an existing target = a REORDER
//   (a `rank` record + its "placed before Build" entry; a no-op when already there, so a retry reorders nothing). Ranks are
//   derived; a stored one only where needed. A position given with --under on an EXISTING target is ignored (`exists`).
// - The per-session NODE LIMITS (≤ 4096 nodes, ≤ 128 agents; createModel's `limits`): a call that creates past them
//   EVICTS the oldest finished agents / ended plans (`remove` why:"evict"; never what the call touches, never an open plan),
//   else it is refused `too-many-nodes` / `too-many-agents`.
// - applyAction2: the dashboard's actions ON IDS (done / skip / reopen / abandon, complete / reopen_plan / abandon_plan,
//   finish, dismiss + its PARENT entry, move (+ a position), reorder, rename, merge, edit_text, message, answer /
//   change_answer / withdraw (2b's answerQuestion2 / withdrawQuestion2), show_as_group / show_as_plan (2b's setType2)), each
//   all-or-nothing and attributed. The CLASH DIALOG (§1.6, Q32): clashes2 lists what a move / merge would clash with (and
//   the clashes "merge them" would create one level down); the answer (`label`, `merges:[{ id, into_id } | { id, label }]`)
//   rides the move / merge action and is applied as ONE checked change — `clash-changed` (with the fresh list) when the tree
//   moved on.
// - NOTICES (§5.5; model output, not wired): actionNotice2 / messageNotice2 / answerNotice2 / combineActionNotices2 — what
//   an action notifies, to whom (the node's session + its nearest agent) and when (batched / at once); subjects name the
//   node's path at SEND time, from its id.
//
// BUILD STEP 2d (docs/spec-88.md §1.7, §3.8, §8 step 2d) — the first USER types on 2b's registries:
// - the `test-run` node type (context-settable: --context-type=test-run): its bar is its ITEMS across its BUCKETS
//   (`items: 'tree'`, runItems2 — §3.8's Pending / In progress / Passed / Failed; what it adds to its parent's rollup), and
//   its row shows its TESTS (`show: 'tests'`: testBar2 over testCounts2 — passed / failed / skipped / to go of N, + checks;
//   one passed / failed / total bar since Q56 CHANGED); its plan also ends on a FAILED
//   line (`ends`); planRemoval2 takes a run whole when only buckets and items are below it.
// - the `test-result` message type (--message-type=test-result + fields result (required) / checks / failed (≤ checks) /
//   duration (ms; "4.1s", "250ms")): the node KEEPS its latest one (`keep: 'test'` → node.test, with the state it left), so
//   the bridge counts them; the result stands while that state does (testOutcome2) — a later state change wins, a restart
//   (todo / running / blocked) clears it. Q57 / Q61 / Q62 (Robin, during step 3: "state is progress, result is outcome"):
//   logging a test-result means the test FINISHED — its state becomes DONE whatever the result (a test-result alone is a
//   report); `--state done` with it is fine, any other state is refused `bad-state`; any context can take one (a skip too,
//   plan item or not); an agent / the session can't (`not-a-test`).
//   Q56 CHANGED: a test-run row shows ONE bar of its tests, passed vs failed vs total, the counts in its tooltip (testBar2).
// - #92 folded in: every type's context-aware MENU as data (`menu`: { action, label, group, when }), menuOf2 = the entries
//   that apply to a node now (WHEN2 mirrors applyAction2's checks).
//
// BUILD STEP 3 (docs/spec-88.md §2, §5.1 – §5.3, §8 step 3, §10) — v6 records + replay (the section at the end):
// - what the records carry for the replay: `create` + scope (the creator's chain) / implicit / runs, `merge` + kid_ranks,
//   entries + line (set the line's text) / test_cleared / caller (the calling agent it refreshed);
// - recordKind2 (v6 only); expire2 / expirePass2 (expiry WRITES its removals: `remove` why "expire");
//   planCheckpoints2 / flushCheckpoints2 (cp / rep; a cp carries the kept test-result); planCarryForward2 (cf carries
//   STRUCTURE, the whole board each rollover); createReplay2 / replayRecords2 (a chronological fold; the window + cf);
//   rebuildGhosts2 (the ghost table from the index files' struct). The day files and index files: lib/activity2-files.js.
// - TIME in the logs (Robin): timingStep times each node's attempts (running → done / failed / skipped / abandoned; a
//   test-result's duration is its took; re-runs add up), the ending entry carries `took`, cp / cf carry `timing`, the
//   replay re-derives it; timing2 / fmtTook, and `took` in displayOf2 ("took 4m 12s").
// - Step 4 (the conversion, lib/activity2-convert.js) uses: createFold2 (the replay's chronological fold on its own — one
//   record at a time; createReplay2 is that fold over its buffer), carryOf2 (one node's cf) and timingStep, now exported.
//
// STUBS LEFT FOR LATER STEPS (said where they bite):
// - Step 6 WIRED the bridge (behind the pre-cutover switch AI_BRIDGE_ACTIVITY_V2 until step 9): lib/activity2-store.js
//   appends `writes` / cp / cf through the facet's writer, writes index files at rollover, pages via the index,
//   runs rebuildGhosts2 + pruneGhosts at startup / rollover and the conflicted-copy WARN. The session ROOT writes no
//   create record (its id is derivable).
// - Step 9 wires the script's typed-field flags (--result / --checks / --failed / --duration → `fields`); step 10 the
//   dashboard's use of displayOf2 (`tests`: testBar2) and menuOf2.
import { lc } from './keys.js'
import { DEPTH2, ACTIVITY_LIMITS, ACTIVITY_STATES, mintId, validKey, slugKey, uniqueKey, normLabel, labelKey, parsePath2, parseRef, formatPath2,
  parseDuration, parseProgress, parseEta, parseText, sessionKey, rankOf, rankGroup, rankBetween, derivedRank, resolveConfig, normBy, byText,
  normQuestion, questionView, questionEntryDetails, answerEntryText, sameAnswer, QUESTION_LIMITS, fmtEta, progressPct, forceBar, stateOf, validRank,
  MESSAGE_LIMITS, firstWords, NOTICE_VERB, EDIT_NOTICE_VERB, MESSAGE_NOTICE_VERB, ANSWER_NOTICE_VERB, localDay } from './activity.js'

/** The v6 record format this model writes (spec §2). */
export const ACTIVITY2_FORMAT = 6
/** 2a's limits: depth (Q11b), the label length (§1.3), the `at` cap (Q11b), aliases per node (§3.3), the longest grace. */
export const LIMITS2 = Object.freeze({ depthMax: DEPTH2.max, depthWarn: DEPTH2.warn, label: ACTIVITY_LIMITS.context, atBytes: 1024, aliasesPerNode: 16, graceMaxMs: 24 * 3600000 })
const DAY = 86400000, HOUR = 3600000, MIN = 60000
const ID_RE = /^[a-z2-7]{16}$/
const LIVE = new Set(['running', 'blocked'])                     // the states that can go stale
const FINAL = new Set(['done', 'failed', 'abandoned'])           // an agent's line in one of them finishes it; the ETA is dropped
const OPEN_ITEM = new Set(['todo', 'running', 'blocked'])        // an OPEN plan item (what a cascade abandons)
const PLAN_END = new Set(['done', 'abandoned'])                  // the plan-end MARKER's states (a context's own line: its type's `ends`)
const PLAN_STATES = new Set(['todo', 'skipped'])                 // contexts only (skipped: plan items only)
const QSTATE = Object.freeze({ asked: 'blocked', answered: 'done', expired: 'abandoned', withdrawn: 'abandoned' })
const STATE_OUTCOME = Object.freeze({ done: 'pass', failed: 'fail', skipped: 'skip', abandoned: 'skip' })   // 2d: a test's outcome by its state
const RESULT_STATE = 'done'   // Q57 / Q62 (Robin): the state a test-result sets, whatever the result — it is the test's progress; the result its outcome

// ---------------------------------------------------------------------------------------------------------------
// small helpers
const cpLen = s => { let n = 0; for (const _ of s) n++; return n }
const cpSlice = (s, n) => Array.from(s).slice(0, n).join('')
const utf8 = s => Buffer.byteLength(s, 'utf8')
// eslint-disable-next-line no-control-regex
const normText = s => s.replace(/\s*[\r\n\t\f\v]+\s*/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim()
const cut = (s, n = ACTIVITY_LIMITS.text) => (cpLen(s) > n ? cpSlice(s, n - 1).trimEnd() + '…' : s)
// eslint-disable-next-line no-control-regex
const answerTextOf = s => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '')
const boolOf = v => (v === true || v === false ? v : v === 'true' ? true : v === 'false' ? false : null)
/** A plain JSON object (no undefined / null / false fields). */
function compact(o) { const r = {}; for (const k of Object.keys(o)) { const v = o[k]; if (v !== null && v !== undefined && v !== false) r[k] = v } return r }
/** @returns {any} */
const bad = (code, what, extra = {}) => ({ ok: false, code, what, ...extra })
const scopeKey = (creatorId, key) => creatorId + '\n' + lc(key)
const labelIx = (parentId, label) => parentId + '\n' + labelKey(label)
const brief = n => ({ id: n.id, key: n.key, label: n.label })
const has = (o, k) => o && o[k] !== undefined && o[k] !== null && o[k] !== false && o[k] !== ''

/**
 * A fresh 2.0 model: { v:6, origin, config, retentionMs, idPrefix, seq, sessions: Map<sessionKey, Session2> }. `origin` is
 * this host (every local node's owner host, §1.2). `config` = the resolved `activity` block (resolveConfig: log_retention_days
 * bounds alias lifetime (§3.3), log_entries_per_agent each node's in-memory log, stale_after_min the stale window). Entry
 * ids are `<idPrefix><ts36>-<seq36>` as in 1.7x.
 * `limits` (2c) = the per-session node limits (ACTIVITY_LIMITS: ≤ 4096 nodes, ≤ 128 agents, the root not counted); a test
 * may lower them.
 * @param {{ origin?: string, config?: any, idPrefix?: string, limits?: { nodesPerSession?: number, agentsPerSession?: number } }} [o]
 */
export function createModel({ origin = 'local', config = {}, idPrefix = 'act_', limits = {} } = {}) {
  const cfg = resolveConfig(config || {}, {})
  const lim = n => (Number.isInteger(n) && n > 0 ? n : null)
  return { v: ACTIVITY2_FORMAT, origin: String(origin || 'local'), config: cfg, retentionMs: cfg.log_retention_days * DAY, idPrefix: String(idPrefix), seq: 0, sessions: new Map(),
    limits: Object.freeze({ nodesPerSession: lim(limits && limits.nodesPerSession) || ACTIVITY_LIMITS.nodesPerSession, agentsPerSession: lim(limits && limits.agentsPerSession) || ACTIVITY_LIMITS.agentsPerSession }) }
}

/**
 * A session of this host (created with its ROOT on first use when `now` is given). The root: kind "session", id =
 * mintId(session, "", ""), label = the session name, chain "" (it is the creator of the session's own keys).
 * @param {any} state @param {{ session: string, project?: string, user?: string, realm?: string }} ident @param {number} [now]
 */
export function getSession2(state, ident, now) {
  const i = ident && typeof ident === 'object' ? ident : /** @type {any} */ ({})
  const name = typeof i.session === 'string' ? i.session.trim() : ''
  if (!name) return null
  const id = { realm: (i.realm && String(i.realm).trim()) || 'default', project: i.project == null ? '' : String(i.project), user: i.user == null ? '' : String(i.user), session: name, host: state.origin }
  const key = sessionKey(id)
  let s = state.sessions.get(key)
  if (!s && Number.isFinite(now)) {
    const rootId = mintId(id, '', '')
    s = { key, ident: id, created_at: now, last_activity: now, rootId, nodes: new Map(), kids: new Map(), scope: new Map(), labels: new Map(), aliases: new Map(), ghosts: new Map(), gkids: new Map() }
    // the root is IMPLICIT until a report is owned by the session itself (an agents-only session never goes stale), as 1.7x
    s.nodes.set(rootId, newNode({ id: rootId, key: '', creator: null, chain: '', scope: '', kind: 'session', label: name, parent: null, now, implicit: true }))
    state.sessions.set(key, s)
  }
  return s || null
}
/** The session's root node. */
export const rootOf = sess => sess.nodes.get(sess.rootId)

// 2b: the node TYPE (NODE_TYPES: context | plan | group | question for a context, agent, session), the LINE (`current` =
// { id, ts, text, state, details, data, by?, question? }), the bar (`progress`), `eta_at`, `stale_after_ms`, `finished_at`
// (agents / the root), the plan-end marker (`plan_end`, agents / the root), and the node's own bounded in-memory log (`log`,
// oldest dropped → `log_dropped`). `cp_dirty`: a log:false report changed it (step 3's checkpoint). 2d: `test` = its latest
// test-result's fields { result, checks?, failed?, duration?, ts, entry, state } (MESSAGE_TYPES `keep`; testOutcome2).
function newNode({ id, key, creator, chain, scope, kind, label, parent, now, asked = null, transient = false, grace_ms = null, implicit = false, runs = 1,
  plan_ix = null, rank = null, type = null }) {
  return { id, key, creator, chain, scope, kind, type: type || (kind === 'context' ? 'context' : kind), label, asked, parent, rank, created_at: now, run_at: now, runs, last_activity: now,
    transient: !!transient, grace_ms: transient && grace_ms ? grace_ms : null, empty_since: null, merged_into: null, merged_from: null,
    implicit: !!implicit, plan: plan_ix != null, plan_ix, current: null, progress: null, eta_at: null, stale_after_ms: null, finished_at: null,
    gone_at: null, plan_end: null, log: [], log_dropped: 0, cp_dirty: false, cp_sig: null, test: null,
    started_at: null, ended_at: null, first_started_at: null, took: null, took_total: 0, attempts: 0 }   // step 3: TIME (timingStep)
}

// ---------------------------------------------------------------------------------------------------------------
// step 3: TIME IN THE LOGS (Robin, 2026-10-03: "when the task is finished the time between it being started and finished
// should be recorded in the task") — an ATTEMPT begins when the node's line goes `running` (not already in an open attempt)
// and ends when it reaches done / failed / skipped / abandoned: `took` = end − start (a test-result's `duration`, when
// given, IS the took); `took_total` / `attempts` add up the finished attempts (a reopen / restart / test re-run is a new
// attempt); back to `todo` mid-attempt drops it (no took). Ticked straight from todo (never running): no start, no took.
const END_STATES = new Set(['done', 'failed', 'skipped', 'abandoned'])
/** The timing change a line-state change makes (s1 = the new state; durMs = a test-result's duration) → a patch. */
export function timingStep(n, s1, ts, durMs) {
  const open = n.started_at != null && n.ended_at == null, p = /** @type {any} */ ({})
  if (s1 === 'running' && !open) { p.started_at = ts; p.ended_at = null; if (n.first_started_at == null) p.first_started_at = ts }
  else if (END_STATES.has(s1) && (open || durMs != null)) {
    const took = durMs != null ? durMs : Math.max(0, ts - n.started_at)
    Object.assign(p, { took, took_total: (n.took_total || 0) + took, attempts: (n.attempts || 0) + 1, ended_at: ts, ...(open ? {} : { started_at: null }) })
  } else if (s1 === 'todo' && open) { p.started_at = null; p.ended_at = null }
  return p
}
/** A short duration: "850ms", "4.1s", "4m 12s", "1h 3m", "2d 3h". */
export function fmtTook(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(Math.round(ms / 100) / 10).toString()}s`
  const s = Math.round(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d) return `${d}d${h ? ` ${h}h` : ''}`
  if (h) return `${h}h${m ? ` ${m}m` : ''}`
  return `${m}m${sec ? ` ${sec}s` : ''}`
}

// ---------------------------------------------------------------------------------------------------------------
// TYPES (Robin, 2026-10-03, "typed nodes and entries"): two small built-in REGISTRIES — data, not code paths

const REPORT_FIELDS = Object.freeze(['text', 'state', 'progress', 'eta', 'stale_after', 'details', 'data', 'log', 'plan', 'ask', 'message_type', 'fields'])
const deep = o => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.freeze({ ...v, fields: Object.freeze(v.fields),
  ...(v.kind ? { items: v.items || 'children', ends: Object.freeze(v.ends || ['done', 'abandoned']), children: v.children ? Object.freeze(v.children) : null,
    menu: Object.freeze((v.menu || []).map(m => Object.freeze({ ...m }))) } : {}) })])))

// 2d (#92 folded in): the context-aware MENU of each node type, as DATA — entries in display order, each { action (an
// ACTIONS2 wire name), label, group (the dashboard draws a separator between groups), when (a WHEN2 predicate: shown only
// while it holds) }. menuOf2 answers the entries that apply to a node now.
const M_ITEM = [
  { action: 'done', label: 'Mark done', group: 'item', when: 'item-not-done' },
  { action: 'skip', label: 'Skip', group: 'item', when: 'item-not-skipped' },
  { action: 'reopen', label: 'Reopen (to do)', group: 'item', when: 'item-not-todo' },
  { action: 'abandon', label: 'Abandon', group: 'item', when: 'context-not-abandoned' },
]
const M_PLAN = (noun = 'the plan') => [
  { action: 'complete', label: `Complete ${noun}`, group: 'plan', when: 'plan-open' },
  { action: 'reopen_plan', label: `Reopen ${noun}`, group: 'plan', when: 'plan-ended' },
  { action: 'abandon_plan', label: `Abandon ${noun}`, group: 'plan', when: 'holds-open-plan' },
]
const M_NODE = [
  { action: 'move', label: 'Move to…', group: 'node', when: 'not-root' },
  { action: 'rename', label: 'Rename…', group: 'node', when: 'not-root' },
  { action: 'edit_text', label: 'Edit text…', group: 'node' },
  { action: 'message', label: 'Message the session…', group: 'node' },
]
const M_MERGE = { action: 'merge', label: 'Merge into…', group: 'node' }
const M_AS_GROUP = { action: 'show_as_group', label: 'Show as group', group: 'type', when: 'not-item' }
const M_AS_PLAN = { action: 'show_as_plan', label: 'Show as plan', group: 'type' }
const M_AGENT = [
  { action: 'finish', label: 'Mark finished…', group: 'agent', when: 'quiet-unfinished' },
  { action: 'dismiss', label: 'Dismiss from the board', group: 'agent', when: 'dismissable' },
]
/**
 * The NODE TYPE registry. Every node has a `type`; a context's is given at creation (`--context-type=<type>`, the tool's
 * `context_type`, case-insensitive; default `context`) and changed only by the dashboard (Show as group / plan: setType2) or
 * by --ask (a question). Per type:
 * - `kind`      the node kind it belongs to (context | agent | session; the kind never changes, §1.4)
 * - `settable`  a caller may give it as --context-type (agent, session and question are the bridge's: --agent / --ask)
 * - `reserved`  named, not built yet — refused `type-reserved` (none since 2d built test-run; kept for later types)
 * - `fields`    the report fields a node of this type takes (a group takes no progress: it has no bar; a question no plan)
 * - `glyph`, `show`  display: the row's glyph and what shows where a bar would ('bar' | 'count' | 'status' | 'tests':
 *               a test-run's ONE bar of its tests, passed vs failed vs total, its counts in the tooltip: testBar2, Q56)
 * - `bar`       its own bar: 'auto' (its plan items only when it holds any — ROLLUP — else its children's bars), 'items'
 *               (always "N of M" over its items), 'none'
 * - `items`     (2d) where its plan ITEMS are: 'children' (its own plan-item children, + its questions), or 'tree' (a
 *               test-run: every plan item / question BELOW it, reached through its BUCKETS — the contexts that hold them —
 *               not through an agent or a group; runItems2)
 * - `counts_as` what it adds to its PARENT's rollup: 'bar' (its bar), 'item' (one of "N of M"), 'none' (a plan item
 *               counts as an item whatever its type)
 * - `plan_end`  it can hold a plan that ENDS (§5.7); `ends` (2d): the states of a CONTEXT plan node's own line that end
 *               it (done / abandoned; a test-run's failed line ends it too — the run is over)
 * - `children`  the node types allowed under it (null = any; [] = none)
 * - `menu`      (2d, #92) the context-aware menu: [{ action, label, group, when? }] in display order (menuOf2)
 */
export const NODE_TYPES = deep({
  context: { kind: 'context', settable: true, fields: REPORT_FIELDS, glyph: '•', show: 'bar', bar: 'auto', counts_as: 'bar', plan_end: true, children: null,
    menu: [...M_ITEM, ...M_PLAN(), M_AS_GROUP, M_AS_PLAN, M_MERGE, ...M_NODE] },
  plan: { kind: 'context', settable: true, fields: REPORT_FIELDS, glyph: '☰', show: 'bar', bar: 'items', counts_as: 'bar', plan_end: true, children: null,
    menu: [...M_ITEM, ...M_PLAN(), M_AS_GROUP, M_MERGE, ...M_NODE] },
  group: { kind: 'context', settable: true, fields: REPORT_FIELDS.filter(f => f !== 'progress'), glyph: '▤', show: 'count', bar: 'none', counts_as: 'none', plan_end: false, children: null,
    menu: [M_ITEM[3], M_AS_PLAN, M_MERGE, ...M_NODE] },
  question: { kind: 'context', settable: false, fields: ['text', 'state', 'stale_after', 'details', 'data', 'log', 'ask'], glyph: '?', show: 'status', bar: 'none', counts_as: 'item', plan_end: false, children: [],
    menu: [{ action: 'answer', label: 'Answer…', group: 'question', when: 'open-question' }, { action: 'change_answer', label: 'Change answer…', group: 'question', when: 'answered-question' },
      { action: 'withdraw', label: 'Withdraw', group: 'question', when: 'open-question' }, M_NODE[0], M_NODE[3]] },
  'test-run': { kind: 'context', settable: true, fields: REPORT_FIELDS, glyph: '⚑', show: 'tests', bar: 'items', items: 'tree', counts_as: 'bar', plan_end: true, ends: ['done', 'failed', 'abandoned'], children: null,
    menu: [...M_ITEM, ...M_PLAN('the run'), M_MERGE, ...M_NODE] },
  agent: { kind: 'agent', settable: false, fields: REPORT_FIELDS, glyph: '◆', show: 'bar', bar: 'auto', counts_as: 'bar', plan_end: true, children: null,
    menu: [...M_PLAN('its plan'), ...M_AGENT, ...M_NODE] },
  session: { kind: 'session', settable: false, fields: REPORT_FIELDS, glyph: '◎', show: 'bar', bar: 'auto', counts_as: 'bar', plan_end: true, children: null,
    menu: [...M_PLAN('its plan'), ...M_AGENT, M_NODE[2], M_NODE[3]] },
})
/** A node's registry entry (an unknown type reads as `context`). */
export const typeOf = n => NODE_TYPES[n && n.type] || NODE_TYPES.context
/** What a child adds to its parent's rollup: a plan item is an ITEM whatever its type; else its type says. */
const countsAs = c => (c.plan ? 'item' : typeOf(c).counts_as)
/**
 * Parse a `--context-type` / `context_type` value (case-insensitive): a SETTABLE context type → { ok, type }; `question` only
 * with --ask (`opts.ask`); a reserved one → `type-reserved`; anything else → `bad-type`.
 * @param {any} raw @param {{ ask?: boolean }} [o]
 */
export function parseContextType(raw, o = {}) {
  const v = typeof raw === 'string' ? lc(raw.trim()) : ''
  const T = NODE_TYPES[v]
  if (T && T.reserved) return bad('type-reserved', `context type "${v}" is reserved — it arrives in a later 2.0 step`)
  if (v === 'question') return o.ask ? { ok: true, type: v } : bad('bad-type', 'a question is made by --ask (the node gets the type question)')
  if (!T || T.kind !== 'context' || !T.settable) return bad('bad-type', `context type must be one of ${Object.keys(NODE_TYPES).filter(k => NODE_TYPES[k].kind === 'context' && NODE_TYPES[k].settable && !NODE_TYPES[k].reserved).join('|')}${T ? ` ("${v}" is the bridge's)` : ''}`)
  return { ok: true, type: v }
}

/**
 * The MESSAGE (entry) TYPE registry. Every entry has a `type` (`--message-type=<type>`, the tool's `message_type`; default
 * `note`) and, when its type declares any, typed `fields` — validated, so the bridge can count them. `--data` stays the
 * free-form extra the bridge does not interpret. `settable`: a caller may give it (the others are written by the bridge:
 * an ask is a `question` entry, an answer an `answer` entry, …); `reserved`: named, not built yet (none since 2d).
 * `keep` (2d): the node attribute where the node KEEPS its latest entry of this type's fields (test-result → `test`), so
 * the bridge can count them (testCounts2) after the entry has left the in-memory log — and with log:false too.
 * Field specs: { type: 'string' | 'text' | 'int' | 'bool' | 'enum' | 'duration' | 'time' | 'list', max?, min?, values?,
 * item?, required? (the type needs it: refused without it), at_most? (an int no greater than that other field) }. A
 * duration is kept in ms: a number IS ms (so a kept value validates to itself), a string has a unit ("4.1s", "250ms",
 * "2m", "1h25m"); a bare-number string is refused (no unit).
 */
export const MESSAGE_TYPES = deep({
  note: { settable: true, fields: {} },   // a plain report (the default)
  question: { settable: false, fields: { choices: { type: 'list', max: QUESTION_LIMITS.choices, item: QUESTION_LIMITS.choice }, free: { type: 'bool' }, expires_at: { type: 'time' } } },
  answer: { settable: false, fields: { choice: { type: 'string', max: QUESTION_LIMITS.choice }, text: { type: 'text', max: QUESTION_LIMITS.answer }, revised: { type: 'int', min: 1 } } },
  withdrawal: { settable: false, fields: { note: { type: 'string', max: ACTIVITY_LIMITS.text } } },
  expiry: { settable: false, fields: { after_ms: { type: 'int', min: 0 } } },
  event: { settable: false, fields: {} },   // a structural change the bridge logs: moved, renamed, merged, unmerged, emptied, a type change
  // 2d: one test's outcome (`result`, required), how many checks it ran and how many of them failed, how long it took
  'test-result': { settable: true, keep: 'test', fields: { result: { type: 'enum', values: ['pass', 'fail', 'skip'], required: true }, checks: { type: 'int', min: 0 },
    failed: { type: 'int', min: 0, at_most: 'checks' }, duration: { type: 'duration' } } },
})
/** A duration field's value → ms (NaN when bad): a number is ms; a string needs a unit — "4.1s", "250ms", "2m", "1h25m". */
function durationMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim().toLowerCase(), ms = /^(\d+(?:\.\d+)?)\s*ms$/.exec(s)
  if (ms) return Math.round(parseFloat(ms[1]))
  return /^[\d.]+$/.test(s) ? NaN : parseDuration(s)
}
/**
 * Validate an entry's typed FIELDS against its message type (the registry): unknown fields are refused, each value is
 * checked and normalised (a duration → ms, an int from a numeric string …). → { ok, fields } (only the fields given) or
 * `bad-fields`.
 * @param {string} type @param {any} fields
 */
export function validateEntryFields(type, fields) {
  const T = MESSAGE_TYPES[type]
  if (!T) return bad('bad-message-type', `message type "${type}" is not one of ${Object.keys(MESSAGE_TYPES).join('|')}`)
  const need = Object.keys(T.fields).filter(k => T.fields[k].required)
  const needs = out => { const miss = need.filter(k => out[k] === undefined); return miss.length ? bad('bad-fields', `a ${type} entry needs ${miss.map(k => `${k}${T.fields[k].values ? ` (${T.fields[k].values.join('|')})` : ''}`).join(', ')}`) : { ok: true, fields: out } }
  if (fields == null) return needs({})
  if (typeof fields !== 'object' || Array.isArray(fields)) return bad('bad-fields', 'fields must be an object of the message type\'s typed fields')
  const out = {}
  for (const [k, v] of Object.entries(fields)) {
    const s = T.fields[k]
    if (!s) return bad('bad-fields', Object.keys(T.fields).length ? `${type} has no field "${k}" (it takes ${Object.keys(T.fields).join(', ')}; free-form extras go in data)` : `${type} takes no typed fields (free-form extras go in data)`)
    if (v === undefined || v === null) continue
    const no = what => bad('bad-fields', `${type}.${k} ${what}`)
    if (s.type === 'string' || s.type === 'text') {
      if (typeof v !== 'string') return no('must be a string')
      const x = s.type === 'string' ? normText(v) : answerTextOf(v)
      if (!x) return no('is empty')
      if (s.max && cpLen(x) > s.max) return no(`is longer than ${s.max} characters`)
      out[k] = x
    } else if (s.type === 'int' || s.type === 'time') {
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN
      if (!Number.isSafeInteger(n) || n < (s.type === 'time' ? 1 : s.min != null ? s.min : -Infinity)) return no(`must be ${s.type === 'time' ? 'a ms time' : `an integer${s.min != null ? ` ≥ ${s.min}` : ''}`}`)
      out[k] = n
    } else if (s.type === 'bool') { const b = boolOf(v); if (b === null) return no('must be true or false'); out[k] = b }
    else if (s.type === 'enum') { const x = typeof v === 'string' ? lc(v.trim()) : ''; if (!s.values.includes(x)) return no(`must be one of ${s.values.join('|')}`); out[k] = x }
    else if (s.type === 'duration') { const ms = durationMs(v); if (!Number.isFinite(ms) || ms < 0) return no('must be a duration with a unit, like "4.1s", "250ms" or "2m" (a number is ms)'); out[k] = ms }
    else if (s.type === 'list') {
      if (!Array.isArray(v) || (s.max && v.length > s.max) || v.some(x => typeof x !== 'string' || !normText(x) || (s.item && cpLen(normText(x)) > s.item))) return no(`must be a list of at most ${s.max} strings of ≤ ${s.item} characters`)
      out[k] = v.map(x => normText(x))
    }
  }
  for (const [k, s] of Object.entries(T.fields)) if (s.at_most && out[k] !== undefined && out[s.at_most] !== undefined && out[k] > out[s.at_most]) return bad('bad-fields', `${type}.${k} (${out[k]}) can't be more than ${s.at_most} (${out[s.at_most]})`)
  return needs(out)
}

// ---------------------------------------------------------------------------------------------------------------
// the tree: paths, depth, children

/** The labels root → node (the root itself has none: its path is ""). */
export function labelsOf(sess, node) {
  const out = []
  for (let n = node; n && n.parent != null; n = sess.nodes.get(n.parent)) out.unshift(n.label)
  return out
}
/** A node's display path NOW (§3.3: labels joined by "/", no "@", quoted where needed). */
export const pathOf = (sess, node) => formatPath2(labelsOf(sess, node))
/** Steps below the session root (a child of the root is depth 1, Q11b). */
export function depthOf(sess, node) { let d = 0; for (let n = node; n && n.parent != null; n = sess.nodes.get(n.parent)) d++; return d }
/** Every child id (merged ones included: a merged node is a HIDDEN child of the node it merged into, §3.6). */
const kidIds = (sess, id) => { const k = sess.kids.get(id); return k ? [...k] : [] }
/** The visible (live, non-merged) children, in sibling order (#82: group, then rank, then key). */
export function childrenOf2(sess, node) {
  return kidIds(sess, node.id).map(id => sess.nodes.get(id)).filter(n => n && !n.merged_into)
    .sort((a, b) => rankGroup(a) - rankGroup(b) || (rankOf(a) < rankOf(b) ? -1 : rankOf(a) > rankOf(b) ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
/** Is `node` at or below `anc`? */
function atOrUnder(sess, node, anc) { for (let n = node; n; n = n.parent != null ? sess.nodes.get(n.parent) : null) if (n.id === anc.id) return true; return false }
/** The deepest node of a subtree (hidden merged nodes count) and its depth. */
function deepestIn(sess, node) {
  let best = { node, depth: depthOf(sess, node) }
  const walk = (n, d) => { if (d > best.depth) best = { node: n, depth: d }; for (const id of kidIds(sess, n.id)) { const c = sess.nodes.get(id); if (c) walk(c, d + 1) } }
  walk(node, best.depth)
  return best
}
/** The nearest AGENT at or above a node, else the root (§1.4, §3.4: a path-created node's creator). */
function ownerOf2(sess, node) { let n = node; while (n && n.kind !== 'agent' && n.parent != null) n = sess.nodes.get(n.parent); return n && n.kind === 'agent' ? n : rootOf(sess) }
/** The child of `parent` a path SEGMENT names (§3.3 step 1): by label, else an agent (or a question, `?N`) by its key. */
function childBySeg(sess, parent, seg) {
  const id = sess.labels.get(labelIx(parent.id, seg))
  if (id) return sess.nodes.get(id)
  for (const c of childrenOf2(sess, parent)) if ((c.kind === 'agent' || c.key.startsWith('?')) && lc(c.key) === lc(seg)) return c
  return null
}
/**
 * A LOOKUP of a display path in the live tree only (no aliases, never creates): the node, or null. For views and tests.
 * @param {any} sess @param {string} path @returns {any}
 */
export function findPath(sess, path) {
  const p = parsePath2(path)
  if (!p.ok || !sess) return null
  let n = rootOf(sess)
  for (const seg of p.segs) { n = childBySeg(sess, n, seg); if (!n) return null }
  return n
}
/** Is this node a QUESTION (a node of type question, #85 — made by --ask)? */
export const isQuestion2 = n => !!(n && n.type === 'question')
/** Is it an OPEN question (asked, awaiting an answer)? */
export const isOpenQuestion2 = n => !!(isQuestion2(n) && n.current && n.current.question && n.current.question.status === 'asked')

/** A node as results name it (§4.2): { id, key, scope, label, path, kind, type } (+ transient / merged_into / plan_item when set). */
export function nodeView(sess, n) {
  if (!n) return null
  return { id: n.id, key: n.key, scope: n.scope, label: n.label, path: pathOf(sess, n), kind: n.kind, type: n.type,
    ...(n.transient ? { transient: true, ...(n.grace_ms ? { grace_ms: n.grace_ms } : {}) } : {}), ...(n.merged_into ? { merged_into: n.merged_into } : {}),
    ...(n.plan ? { plan_item: true } : {}), ...(n.test ? { test: { ...n.test } } : {}) }
}
/** The visible tree below a node, for tests and debugging: { label, key, id, kids:[…] }. */
export function treeOf(sess, node = rootOf(sess)) {
  return { label: node.label, key: node.key, id: node.id, ...(node.transient ? { transient: true } : {}), kids: childrenOf2(sess, node).map(c => treeOf(sess, c)) }
}

// ---------------------------------------------------------------------------------------------------------------
// display forms (Q11b)

/**
 * Cap a stored path (an entry's `at`, Q08) at `max` UTF-8 bytes: a longer one keeps its head and its tail and is cut in the
 * MIDDLE with "…", on code-point boundaries, so the top of the tree and the node's own label both survive.
 * @param {string} path @param {number} [max] @returns {string}
 */
export function capAt(path, max = LIMITS2.atBytes) {
  const s = String(path == null ? '' : path)
  if (Buffer.byteLength(s, 'utf8') <= max) return s
  const cps = Array.from(s), budget = max - 3   // "…" is 3 bytes
  let head = '', hb = 0, i = 0, tail = '', tb = 0, j = cps.length - 1
  for (; i < cps.length; i++) { const b = Buffer.byteLength(cps[i], 'utf8'); if (hb + b > Math.floor(budget / 2)) break; head += cps[i]; hb += b }
  for (; j >= i; j--) { const b = Buffer.byteLength(cps[j], 'utf8'); if (hb + tb + b > budget) break; tail = cps[j] + tail; tb += b }
  return head + '…' + tail
}

/**
 * The DISPLAY form of a long path (Q11b): at most `max` code points, shortened in the MIDDLE by whole segments — the first
 * segment, "…", then as many trailing segments as fit (`Next release/…/Write the docs`). A path whose last segment alone is
 * too long is cut in the middle of the text. The full path goes on hover.
 * @param {string} path @param {number} [max] @returns {string}
 */
export function shortPath(path, max = 80) {
  const s = String(path == null ? '' : path)
  if (cpLen(s) <= max) return s
  const parsed = parsePath2(s), segs = parsed.ok ? parsed.segs : s.split('/')
  if (segs.length > 2) {
    const first = formatPath2([segs[0]])
    let tail = [], n = segs.length - 1
    while (n > 0 && cpLen(first + '/…/' + formatPath2([segs[n], ...tail])) <= max) tail = [segs[n--], ...tail]
    if (tail.length && n >= 1) return first + '/…/' + formatPath2(tail)
  }
  const keep = Math.max(2, max - 1), h = Math.ceil(keep / 2), cps = Array.from(s)
  return cps.slice(0, h).join('') + '…' + cps.slice(cps.length - (keep - h)).join('')
}

// ---------------------------------------------------------------------------------------------------------------
// transactions: every mutation is journalled, so a refused call is undone exactly (all-or-nothing, §3.8 / §1.6)

function newTx(state, sess, now, o = {}) {
  return { state, sess, now, by: normBy(o.by) || null, act: typeof o.act === 'string' && o.act ? o.act : null, undo: [], records: [], entries: [], writes: [], warnings: [], deepest: 0 }
}
function mset(t, map, k, v) { const had = map.has(k), old = map.get(k); map.set(k, v); t.undo.push(() => { if (had) map.set(k, old); else map.delete(k) }) }
function mdel(t, map, k) { if (!map.has(k)) return; const old = map.get(k); map.delete(k); t.undo.push(() => map.set(k, old)) }
function sadd(t, map, k, v) {
  let s = map.get(k); const fresh = !s
  if (fresh) { s = new Set(); map.set(k, s) }
  if (s.has(v)) return
  s.add(v); t.undo.push(() => { s.delete(v); if (fresh && !s.size && map.get(k) === s) map.delete(k) })
}
function sdel(t, map, k, v) {
  const s = map.get(k); if (!s || !s.has(v)) return
  s.delete(v); const emptied = !s.size; if (emptied) map.delete(k)
  t.undo.push(() => { if (emptied) map.set(k, s); s.add(v) })
}
function fset(t, obj, f, v) { const old = obj[f]; if (old === v) return; obj[f] = v; t.undo.push(() => { obj[f] = old }) }
function rollback(t) { while (t.undo.length) t.undo.pop()() }

const identOf = sess => ({ realm: sess.ident.realm, session: sess.ident.session, project: sess.ident.project, user: sess.ident.user, host: sess.ident.host, origin: sess.ident.host, s0: sess.created_at })
/** One NODE RECORD (§2.1): { v:6, kind:"node", op, ts, n, …fields, …ident } (+ by / act when a dashboard did it). */
function record(t, op, n, fields = {}) {
  const r = { v: ACTIVITY2_FORMAT, kind: 'node', op, ts: t.now, n: n.id, ...fields, ...(t.by ? { by: t.by } : {}), ...(t.act ? { act: t.act } : {}), ...identOf(t.sess) }
  t.records.push(r); t.writes.push(r)
  if (t.state.cp) t.state.cp.rep = null   // step 3: any other write closes the open repeat line (planCheckpoints2)
  return r
}
const newEntryId = (state, now) => `${state.idPrefix}${now.toString(36)}-${(++state.seq).toString(36)}`
/** Step 3: a node's LINE STATE as one string — what a checkpoint restates (planCheckpoints2: changed → a cp line, else a repeat). */
const cpSig = n => JSON.stringify([n.current, n.progress, n.eta_at, n.finished_at, n.plan_end, n.test, n.started_at, n.ended_at, n.took, n.took_total])
/** The small form a node's in-memory log keeps (no details / data, no identity). */
const smallOf = e => compact({ id: e.id, ts: e.ts, type: e.type, fields: e.fields, current: !!e.current, text: e.text, state: e.state, progress: e.progress, eta_at: e.eta_at,
  stale_after_ms: e.stale_after_ms, has_details: e.details ? true : undefined, has_data: e.data != null ? true : undefined, by: e.by, act: e.act })
/** Step 6: the same small form for a day-file entry (the store's log pages, lib/activity2-store.js). */
export const smallOf2 = smallOf
/**
 * Write one v6 ENTRY on `node` (§2.2): { v:6, id, ts, n, type, fields?, current, text, state, at, …f.extra, by?, act?, …ident,
 * details, data }. `type` = its MESSAGE TYPE (default note) and `fields` its typed fields (MESSAGE_TYPES; omitted when none).
 * `at` = the node's display path NOW (or f.at), capped at ~1 KB. It joins `entries` and `writes`, and the node's own bounded log.
 * @param {any} t @param {any} node @param {{ id?: string, type?: string, fields?: any, current?: boolean, text: string, state?: string, at?: string, details?: any, data?: any, extra?: any, by?: any, act?: any }} f
 */
function writeEntry(t, node, f) {
  const { state, sess } = t
  const by = f.by !== undefined ? f.by : t.by, act = f.act !== undefined ? f.act : t.act
  const fields = f.fields && Object.keys(f.fields).length ? f.fields : null
  const e = /** @type {any} */ ({ v: ACTIVITY2_FORMAT, id: f.id || newEntryId(state, t.now), ts: t.now, n: node.id, type: f.type || 'note', ...(fields ? { fields } : {}), current: !!f.current, text: f.text, state: f.state || stateOf(node),
    at: capAt(f.at != null ? f.at : pathOf(sess, node)), ...compact(f.extra || {}), ...(by ? { by } : {}), ...(act ? { act } : {}), ...identOf(sess),
    details: f.details != null ? f.details : null, data: f.data != null ? f.data : null })
  if (f.extra && f.extra.progress === null) e.progress = null   // an explicit "none" is recorded (the replay must see the clear)
  if (f.extra && f.extra.eta_at === null) e.eta_at = null
  t.entries.push(e); t.writes.push(e)
  const cap = state.config.log_entries_per_agent, log = [...node.log, smallOf(e)]
  const drop = Math.max(0, log.length - cap)
  fset(t, node, 'log', drop ? log.slice(drop) : log)
  if (drop) fset(t, node, 'log_dropped', node.log_dropped + drop)
  // step 3: the node's line state as its newest record left it (a later log:false report that changes nothing → a repeat
  // line) — only while no log:false change is pending: then the replay's node equals this one (else its checkpoint decides)
  if (!node.cp_dirty) fset(t, node, 'cp_sig', cpSig(node))
  if (state.cp) state.cp.rep = null
  return e
}
/**
 * The ENTRY a structural change writes on the node (§2.2: "moved by robin via dashboard (ROBIN-Z790) from … to …", the
 * transient vanish's "emptied — removed from the board (transient)"): logged only, attributed when a dashboard (or the
 * bridge) did it — the attribution goes after the verb.
 */
function entryStub(t, n, act, text, at) {
  const said = t.by && act !== 'transient' ? text.replace(/^(\S+)/, `$1 ${byText(t.by)}`) : text
  return writeEntry(t, n, { type: 'event', text: cut(said), act: act === 'transient' ? act : t.act || act, at, by: act === 'transient' ? null : t.by })
}
const warn = (t, w) => t.warnings.push(w)
function noteDepth(t, d) { if (d > t.deepest) t.deepest = d }

// ---------------------------------------------------------------------------------------------------------------
// labels (§1.6)

/** The live sibling under `parentId` holding `label` (labelKey), other than `selfId`; else null. */
function clashAt(sess, parentId, label, selfId = null) {
  const id = sess.labels.get(labelIx(parentId, label))
  return id && id !== selfId ? sess.nodes.get(id) || null : null
}
/**
 * The first free label among `parentId`'s children (§1.6): `label` itself, else "<label> (2)", "(3)" … — the suffix counts
 * in the comparison, and a label that would pass 60 code points is cut BEFORE the suffix.
 * @returns {{ label: string, sibling: any }}
 */
export function freeLabel(sess, parentId, label, selfId = null) {
  const sibling = clashAt(sess, parentId, label, selfId)
  if (!sibling) return { label, sibling: null }
  for (let n = 2; ; n++) {
    const sfx = ` (${n})`, cand = cpSlice(label, LIMITS2.label - cpLen(sfx)).trimEnd() + sfx
    if (!clashAt(sess, parentId, cand, selfId)) return { label: cand, sibling }
  }
}
const dupLabel = (sess, parentId, label, sib, selfId, what) => bad('duplicate-label',
  `${what}: "${sib.label}" already has that label there (key ${sib.key}) — pick another label, e.g. "${freeLabel(sess, parentId, label, selfId).label}"`,
  { sibling: brief(sib), suggestion: freeLabel(sess, parentId, label, selfId).label })

// ---------------------------------------------------------------------------------------------------------------
// structural primitives (journalled)

/** Put a node into the live tree: nodes, kids, the label index (unless merged), the scope index; leaves the ghost table. */
function addLive(t, node) {
  const { sess } = t
  const g = sess.ghosts.get(node.id)
  if (g) { mdel(t, sess.ghosts, node.id); sdel(t, sess.gkids, g.parent, node.id) }
  mset(t, sess.nodes, node.id, node)
  if (node.parent != null) {
    sadd(t, sess.kids, node.parent, node.id)
    if (!node.merged_into) mset(t, sess.labels, labelIx(node.parent, node.label), node.id)
    arrived(t, node.parent)
  }
  if (node.creator != null) mset(t, sess.scope, scopeKey(node.creator, node.key), node.id)
}
/** Take a node out of its parent (kids + label index); it keeps its own subtree. */
function detach(t, node) {
  const { sess } = t
  if (node.parent == null) return
  sdel(t, sess.kids, node.parent, node.id)
  const ix = labelIx(node.parent, node.label)
  if (sess.labels.get(ix) === node.id) mdel(t, sess.labels, ix)
}
/** Hang a node under `parent` (visible unless merged); clears a transient parent's grace mark. */
function attach(t, node, parent) {
  const { sess } = t
  fset(t, node, 'parent', parent.id)
  sadd(t, sess.kids, parent.id, node.id)
  if (!node.merged_into) mset(t, sess.labels, labelIx(parent.id, node.label), node.id)
  arrived(t, parent.id)
}
/** The stored rank that puts a node LAST in its group under `parent` (§3.8 "arrival"; the default when no position is given). */
function lastRank(t, parent, node) {
  const g = rankGroup(node)
  let hi = null
  for (const c of childrenOf2(t.sess, parent)) if (c.id !== node.id && rankGroup(c) === g) { const r = rankOf(c); if (hi === null || r > hi) hi = r }
  return rankBetween(hi, derivedRank(t.now + 1, null))
}
/** Q11b after a structural change: the moved / created subtree must stay ≤ 32 deep (the deepest node named), past 20 warns. */
function checkDepth(t, node) {
  const d = deepestIn(t.sess, node)
  if (d.depth > LIMITS2.depthMax) return bad('depth', `that would put "${d.node.label}" (key ${d.node.key}) at depth ${d.depth}; the limit is ${LIMITS2.depthMax} below the session`, { node: brief(d.node), depth: d.depth })
  noteDepth(t, d.depth)
  return null
}

/**
 * CREATE a node (§2.1 `create`): mint its id (or re-use a GHOST's: a new run, §3.7), settle its label (AUTO-RENAME on a
 * sibling clash, `asked` + warning `relabelled`, §1.6), check the depth, write the record.
 * @returns {any} the node, or a refusal
 */
function createNode(t, { creator, key, kind, label, parent, transient = false, grace_ms = null, implicit = false, ghost = null, plan_ix = null, rank = null, type = null }) {
  const { sess } = t
  // a GHOST comes back as itself: its id, key, kind and creator (the key's namespace — even if that agent is gone too)
  const cId = ghost ? ghost.creator : creator.id, cChain = ghost ? ghost.scope : creator.chain
  if (ghost) { key = ghost.key; kind = ghost.kind }
  // its TYPE: the one asked for, else a ghost's own (a group comes back a group), else its kind's; a plan item is never a group
  type = kind !== 'context' ? kind : type || (ghost && ghost.type) || 'context'
  if (plan_ix != null && typeOf({ type }).counts_as === 'none') type = 'context'
  const allowed = typeOf(parent).children
  if (allowed && !allowed.includes(type)) return bad('bad-child', `"${pathOf(sess, parent) || sess.ident.session}" is a ${parent.type} — it holds ${allowed.length ? allowed.join(' / ') + ' nodes only' : 'nothing'}`)
  const id = ghost ? ghost.id : mintId(sess.ident, cChain, key)
  const other = sess.nodes.get(id) || (!ghost && sess.ghosts.get(id))
  if (other && (other.creator !== cId || lc(other.key) !== lc(key))) return bad('id-collision', `the id ${id} minted for ${cChain}:${key} is already held by another node (${other.scope}:${other.key}) — nothing was merged; use another key`)
  if (other) return bad('exists', `${cChain}:${key} exists`)   // callers look the scope up first: a guard, never reached
  const d = depthOf(sess, parent) + 1
  if (d > LIMITS2.depthMax) return bad('depth', `that would put "${label}" (key ${key}) at depth ${d}; the limit is ${LIMITS2.depthMax} below the session`, { node: { id, key, label }, depth: d })
  noteDepth(t, d)
  const fl = freeLabel(sess, parent.id, label)
  const chain = kind === 'agent' ? (cChain ? cChain + '/' : '') + key : null
  const node = newNode({ id, key, creator: cId, chain, scope: cChain, kind, label: fl.label, parent: parent.id, now: t.now,
    asked: fl.sibling ? label : null, transient: kind === 'context' && transient, grace_ms, implicit, runs: ghost ? (ghost.runs || 1) + 1 : 1,
    plan_ix: kind === 'context' ? plan_ix : null, rank, type })
  addLive(t, node)
  if (fl.sibling) warn(t, { code: 'relabelled', asked: label, got: fl.label, sibling: brief(fl.sibling), what: `"${label}" is taken under "${pathOf(sess, sess.nodes.get(parent.id)) || sess.ident.session}": created as "${fl.label}"` })
  // step 3: + `scope` (the creator's chain: the replay derives an agent's chain from it even when the creator is gone),
  // `implicit` (a path's intermediate) and `runs` (> 1: the run number of a resurrected ghost)
  record(t, 'create', node, { c: cId, scope: cChain, key: node.key, nk: kind, type: node.type, label: node.label, p: parent.id, rank: node.rank, run: true,
    ...(node.asked ? { asked: node.asked } : {}), ...(node.transient ? { transient: true, ...(node.grace_ms ? { grace_ms: node.grace_ms } : {}) } : {}),
    ...(node.plan ? { plan_item: true, plan_ix: node.plan_ix } : {}), ...(node.implicit ? { implicit: true } : {}), ...(node.runs > 1 ? { runs: node.runs } : {}) })
  return node
}

/** A transient context whose last live child just LEFT vanishes (or starts its grace period, Q44) — §3.8. */
function left(t, parentId) {
  const { sess } = t
  const p = sess.nodes.get(parentId)
  if (!p || p.kind !== 'context' || !p.transient || p.merged_into) return
  if (childrenOf2(sess, p).length) return
  if (p.grace_ms) { if (p.empty_since == null) fset(t, p, 'empty_since', t.now); return }
  removeNode(t, p, 'transient')
}
/** A child ARRIVED: a transient context in its grace period stays (Q44). */
function arrived(t, parentId) { const p = t.sess.nodes.get(parentId); if (p && p.empty_since != null) fset(t, p, 'empty_since', null) }

/** Drop the aliases that point at any of `ids` (§3.3 (b): its node was removed). */
function dropAliases(t, ids) { for (const [k, a] of [...t.sess.aliases]) if (ids.has(a.id)) mdel(t, t.sess.aliases, k) }
/** Record `path` (a node's display path BEFORE a change) as an alias of `id` (§3.3): newest wins; ≤ 16 per node, newest kept. */
function addAlias(t, path, id) {
  if (!path) return
  const { sess } = t
  mset(t, sess.aliases, labelKey(path), { id, path, at: t.now, used: t.now })
  const mine = [...sess.aliases].filter(([, a]) => a.id === id).sort((x, y) => x[1].used - y[1].used)
  for (let i = 0; i < mine.length - LIMITS2.aliasesPerNode; i++) mdel(t, sess.aliases, mine[i][0])
}

/**
 * REMOVE a node and its subtree (§2.1 `remove`, why: dismiss | evict | expire | transient): each node leaves memory into
 * the GHOST table (§5.1: its last parent, key, creator, label, kind, removed_at; keys stay held in the scope index), the
 * aliases to them are dropped, one record is written for the top node (+ the transient vanish's entry stub before it), and
 * a transient parent that emptied vanishes in turn.
 */
export function removeNode(t, node, why) {
  const { sess } = t
  if (!node || node.parent == null) return
  const was = pathOf(sess, node), parentId = node.parent
  if (why === 'transient') entryStub(t, node, 'transient', 'emptied — removed from the board (transient)')
  const ids = new Set(), stack = [node]
  while (stack.length) { const n = stack.pop(); ids.add(n.id); for (const id of kidIds(sess, n.id)) { const c = sess.nodes.get(id); if (c) stack.push(c) } }
  detach(t, node)
  for (const id of ids) {
    const n = sess.nodes.get(id)
    if (id !== node.id && !n.merged_into) { const ix = labelIx(n.parent, n.label); if (sess.labels.get(ix) === id) mdel(t, sess.labels, ix) }
    mdel(t, sess.kids, id)
    mdel(t, sess.nodes, id)
    mset(t, sess.ghosts, id, { id, key: n.key, creator: n.creator, chain: n.chain, scope: n.scope, kind: n.kind, label: n.label, parent: n.parent,
      removed_at: t.now, last_ts: t.now, why: id === node.id ? why : 'parent', transient: n.transient, grace_ms: n.grace_ms, runs: n.runs, type: n.type })
    sadd(t, sess.gkids, n.parent, id)
  }
  dropAliases(t, ids)
  record(t, 'remove', node, { why, was })
  left(t, parentId)
}

/** Make a transient context PERMANENT (§3.8: --keep, a rename, its own line (2b), a pin (step 8)) — one `keep` record. */
export function keepNode(t, node) {
  if (!node || !node.transient) return false
  fset(t, node, 'transient', false); fset(t, node, 'grace_ms', null); fset(t, node, 'empty_since', null)
  record(t, 'keep', node)
  return true
}

/**
 * Step 8 (§3.8, §5.6): a PIN makes a transient context permanent. The OWNER calls this with the targets that have a live
 * `pin:` record of any user in the view set it holds; each of ITS transient contexts among them gets one `keep` record
 * (by = the pinning dashboard's user, act "pin"). → { writes, kept:[{ id, path }] }
 * @param {any} state @param {Iterable<string>} ids @param {number} now @param {{ by?: any }} [opts]
 */
export function keepPinned2(state, ids, now, opts = {}) {
  const out = { records: [], writes: [], kept: [] }
  const want = new Set(ids || [])
  if (!want.size) return out
  for (const sess of state.sessions.values()) {
    for (const id of want) {
      const n = sess.nodes.get(id)
      if (!n || n.kind !== 'context' || !n.transient || n.merged_into) continue
      const t = newTx(state, sess, now, { by: opts.by, act: 'pin' })
      if (keepNode(t, n)) { out.records.push(...t.records); out.writes.push(...t.writes); out.kept.push({ id, path: pathOf(sess, n) }) }
    }
  }
  return out
}

/** RENAME (§1.6: a clash → duplicate-label, nothing written): one `label` record; the old path becomes an alias. */
function renameNode(t, node, label) {
  const { sess } = t
  if (node.parent == null) return bad('bad-rename', 'the session root is labelled by its session name')
  if (node.merged_into) return bad('bad-rename', `"${node.label}" is merged — unmerge it first`)
  if (label === node.label) return null
  const sib = clashAt(sess, node.parent, label, node.id)
  if (sib) return dupLabel(sess, node.parent, label, sib, node.id, `can't rename "${node.label}" to "${label}"`)
  const was = pathOf(sess, node), old = node.label
  const ix = labelIx(node.parent, node.label)
  if (sess.labels.get(ix) === node.id) mdel(t, sess.labels, ix)
  fset(t, node, 'label', label)
  mset(t, sess.labels, labelIx(node.parent, label), node.id)
  record(t, 'label', node, { label, was })
  addAlias(t, was, node.id)
  entryStub(t, node, 'rename', `renamed from "${old}" to "${label}"`)
  keepNode(t, node)
  return null
}

/**
 * MOVE under `dest` (§1.6, §3.8 arrival): the root can't move, never under itself, a merged node can't move, same session
 * (callers resolve `dest` in the session: `cross-session` is raised there), the label (or `rename`, one checked change)
 * must be free at the destination, the whole subtree must stay ≤ 32 deep. Already there → a no-op (no record; a rename
 * still applies). Arrives LAST in its group — or, 2c, where `pos` (a position: before / after a sibling there, first, last)
 * puts it; a position with the node already under `dest` is a REORDER. One `move` record (+ a `label` record with a rename);
 * the old path is an alias; a transient old parent that emptied vanishes.
 * @returns {any} { moved } | { noop:true } | { placed } | a refusal
 */
function moveNode(t, node, dest, rename = null, pos = null, scopeNode = null) {
  const { sess } = t
  if (node.parent == null) return bad('bad-move', 'the session root cannot move')
  if (node.merged_into) return bad('bad-move', `"${node.label}" is merged — unmerge it first`)
  if (atOrUnder(sess, dest, node)) return bad('bad-move', `can't move "${node.label}" under itself`)
  if (dest.merged_into) return bad('bad-move', `"${dest.label}" is merged into another node`)
  const allowed = typeOf(dest).children
  if (allowed && !allowed.includes(node.type)) return bad('bad-child', `"${pathOf(sess, dest) || sess.ident.session}" is a ${dest.type} — it holds ${allowed.length ? allowed.join(' / ') + ' nodes only' : 'nothing'}`)
  const label = rename != null ? rename : node.label
  if (node.parent === dest.id) {
    if (rename != null) { const e = renameNode(t, node, rename); if (e) return e }
    if (pos) return reorderNode(t, node, pos, scopeNode || rootOf(sess))   // 2c: the same parent + a position = a reorder (#82)
    return { noop: true }
  }
  const sib = clashAt(sess, dest.id, label, node.id)
  if (sib) return dupLabel(sess, dest.id, label, sib, node.id, `can't move "${node.label}" under "${pathOf(sess, dest) || sess.ident.session}"${rename != null ? ` as "${label}"` : ''}`)
  // 2c: where it lands among its new siblings (resolved before anything changes; its group is the one it has now)
  let pr = null
  if (pos) {
    const rp = resolvePos(t, pos, dest, scopeNode || rootOf(sess))
    if (rp.ok === false) return rp
    if (rp.anchor && rankGroup(rp.anchor) !== rankGroup(node)) return badAnchor(rp.anchor, node)
    pr = placeRanks2(t, dest, rankGroup(node), rp, 1, new Set([node.id]), false)
    if (pr.ok === false) return pr
  }
  const was = pathOf(sess, node), from = node.parent, relabel = label !== node.label
  detach(t, node)
  if (relabel) fset(t, node, 'label', label)   // before attach: the label index must take the NEW label
  attach(t, node, dest)
  const rank = (pr && pr.ranks[0]) || lastRank(t, dest, node)
  fset(t, node, 'rank', rank)
  const e = checkDepth(t, node); if (e) return e
  record(t, 'move', node, { p: dest.id, rank, was })
  if (relabel) { record(t, 'label', node, { label, was }); keepNode(t, node) }
  addAlias(t, was, node.id)
  entryStub(t, node, 'move', `moved from ${was} to ${pathOf(sess, node)}${pr ? ` (${pr.text})` : ''}`)
  left(t, from)
  return { moved: { from: was, to: pathOf(sess, node), parent_id: dest.id, rank, ...(pr ? { where: pr.text } : {}) } }
}

/**
 * MERGE A into B (§3.6): contexts / plan items only, same session; refused `bad-merge` for A = B, B under A, an agent, the
 * root, A holding an OPEN question; `duplicate-label` listing EVERY clash of A's children with B's. A's children move under
 * B (last in their groups), A becomes a HIDDEN child of B (`merged_into`, `merged_from` = its parent then). One `merge`
 * record (kids listed, no move records); A's path becomes an alias (resolution redirects A to B).
 * 2c — the dashboard's CLASH ANSWER (§1.6, Q32): `ans` = { map: id → { into_id } (merge them) | { label } (a different
 * label), used: Set } settles each clash of A's children instead of refusing: "merge them" merges that child into its
 * same-label sibling under B (recursively, its own children's clashes answered the same way), a label relabels it as it
 * lands (a `label` record + its entry). A clash with no answer → `duplicate-label`; an answer that no longer fits the tree
 * (the sibling changed, the new label is taken) → `clash-changed`. The tool and the script pass no answers (they refuse).
 */
function mergeNode(t, a, b, ans = null) {
  const { sess } = t
  const no = canMergeWhy(sess, a, b)
  if (no) return no
  const kids = childrenOf2(sess, a)
  const clashes = [], plan = []
  let stale = false
  for (const k of kids) {
    const s = clashAt(sess, b.id, k.label), an = ans ? ans.map.get(k.id) : null
    if (!s) { plan.push({ k }); continue }
    if (an && an.into_id != null && an.into_id === s.id) { ans.used.add(k.id); plan.push({ k, into: s }); continue }
    if (an && an.label != null) { ans.used.add(k.id); plan.push({ k, label: an.label }); continue }
    if (an) { ans.used.add(k.id); stale = true }
    clashes.push({ label: k.label, key: k.key, id: k.id, sibling: brief(s), suggestion: freeLabel(sess, b.id, k.label).label, can_merge: !canMergeWhy(sess, k, s) })
  }
  if (clashes.length) return bad(stale ? 'clash-changed' : 'duplicate-label', `can't merge "${a.label}" into "${b.label}": ${clashes.map(c => `"${c.label}" is already there (suggest "${c.suggestion}")`).join('; ')}`, { clashes })
  const was = pathOf(sess, a), from = a.parent, moved = []
  for (const p of plan) {
    if (p.into) { const r = mergeNode(t, p.k, p.into, ans); if (r.ok === false) return r; continue }
    const label = p.label != null ? p.label : p.k.label, kwas = pathOf(sess, p.k), old = p.k.label, relabel = label !== old
    const sib = clashAt(sess, b.id, label, p.k.id)
    if (sib) return bad(ans ? 'clash-changed' : 'duplicate-label', `can't merge "${a.label}" into "${b.label}": "${label}" is already there (key ${sib.key})`, { sibling: brief(sib), suggestion: freeLabel(sess, b.id, label, p.k.id).label })
    detach(t, p.k)
    if (relabel) fset(t, p.k, 'label', label)
    attach(t, p.k, b)
    fset(t, p.k, 'rank', lastRank(t, b, p.k))
    const e = checkDepth(t, p.k); if (e) return e
    if (relabel) { record(t, 'label', p.k, { label, was: kwas }); addAlias(t, kwas, p.k.id); entryStub(t, p.k, 'rename', `renamed from "${old}" to "${label}"`); keepNode(t, p.k) }
    moved.push(p.k)
  }
  detach(t, a)
  fset(t, a, 'merged_into', b.id); fset(t, a, 'merged_from', from)
  attach(t, a, b)
  const e = checkDepth(t, a); if (e) return e
  record(t, 'merge', a, { into: b.id, from, was, kids: moved.map(k => k.id), kid_ranks: moved.map(k => k.rank) })   // step 3: the rank each kid got under B
  addAlias(t, was, a.id)
  entryStub(t, a, 'merge', `merged into ${pathOf(sess, b)}`, was)
  left(t, from)
  return { merged: { into_id: b.id, path: pathOf(sess, b), kids: moved.map(k => k.id) } }
}
/** Why A can't merge into B (§3.6), or null: the `bad-merge` refusals. */
function canMergeWhy(sess, a, b) {
  if (a.id === b.id) return bad('bad-merge', "can't merge a node into itself")
  if (a.parent == null || b.parent == null) return bad('bad-merge', "the session root can't be merged (or merged into)")
  if (a.kind !== 'context' || b.kind !== 'context') return bad('bad-merge', `only contexts merge: "${(a.kind !== 'context' ? a : b).label}" is an agent (a key namespace)`)
  if (a.merged_into) return bad('bad-merge', `"${a.label}" is already merged`)
  if (atOrUnder(sess, b, a)) return bad('bad-merge', `can't merge "${a.label}" into its own descendant "${b.label}"`)
  if (isOpenQuestion2(a)) return bad('bad-merge', `"${a.label}" holds an open question — answer or withdraw it first`)
  if (typeOf(b).children && !typeOf(b).children.length) return bad('bad-merge', `"${b.label}" is a ${b.type} — nothing merges into it`)
  return null
}

/**
 * UNMERGE (§3.6): A goes back under its pre-merge parent as a plain context (its children stay with B). Refused
 * `duplicate-label` when the old parent has gained a child with A's label (`label` names A anew), `bad-unmerge` when A is
 * not merged or its old parent is gone. One `unmerge` record (+ a `label` record when relabelled).
 */
function unmergeNode(t, a, label = null) {
  const { sess } = t
  if (!a.merged_into) return bad('bad-unmerge', `"${a.label}" is not merged`)
  const from = sess.nodes.get(a.merged_from)
  if (!from) return bad('bad-unmerge', `"${a.label}"'s old parent is no longer on the board — it stays merged`)
  const want = label != null ? label : a.label
  const sib = clashAt(sess, from.id, want, a.id)
  if (sib) return dupLabel(sess, from.id, want, sib, a.id, `can't unmerge "${a.label}" back under "${pathOf(sess, from) || sess.ident.session}"${label != null ? ` as "${want}"` : ''}`)
  const relabel = want !== a.label
  detach(t, a)
  fset(t, a, 'merged_into', null); fset(t, a, 'merged_from', null)
  if (relabel) fset(t, a, 'label', want)
  attach(t, a, from)
  const rank = lastRank(t, from, a)
  fset(t, a, 'rank', rank)
  const e = checkDepth(t, a); if (e) return e
  record(t, 'unmerge', a, { p: from.id, rank })
  if (relabel) record(t, 'label', a, { label: want })
  entryStub(t, a, 'unmerge', `unmerged back to ${pathOf(sess, a)}`)
  return { unmerged: { parent_id: from.id, path: pathOf(sess, a) } }
}

// ---------------------------------------------------------------------------------------------------------------
// 2c: POSITIONS (§4.1: --before / --after <ref>, --first / --last; #82's ranks on ids)

const GROUP_NAMES = Object.freeze(['plan items', 'contexts', 'agents'])
const badAnchor = (a, n) => bad('bad-anchor', `"${a.label}" is among the ${GROUP_NAMES[rankGroup(a)]} — plan items come first, then contexts, then agents; place it among the ${GROUP_NAMES[rankGroup(n)]}`)
/**
 * Resolve a POSITION under `parent` → { kind: 'before'|'after'|'first'|'last', anchor (the sibling, before / after only) }.
 * The anchor is a §3.2 reference — `*_id` exact; `chain:key` exactly; a bare key in your scope, then your creator's … — and,
 * since an anchor is always a SIBLING, a bare key that names none there (or names a node elsewhere) is also tried as the
 * label (or agent key) of one of `parent`'s children, as is a one-segment path. It must be a visible child of `parent`
 * (`bad-anchor`); nothing found → `unknown-anchor`.
 */
function resolvePos(t, pos, parent, scopeNode) {
  if (pos.kind === 'first' || pos.kind === 'last') return { kind: pos.kind, anchor: null }
  const { sess } = t, where = pathOf(sess, parent) || sess.ident.session
  let n = null
  if (pos.ref_id != null) { const r = byId(t, pos.ref_id, `${pos.kind}_id`); if (r.ok === false) return r.code === 'unknown-node' ? bad('unknown-anchor', r.what) : r; n = r.node }
  else {
    const p = parseRef(pos.ref)
    if (!p.ok) return p
    if (p.kind === 'chain') { const c = creatorByChain(t, p.creators), id = c && sess.scope.get(scopeKey(c.id, p.key)); n = (id && sess.nodes.get(id)) || null }
    else if (p.kind === 'key') {
      let hit = null
      for (let s = scopeNode; s && !hit; s = s.creator != null ? sess.nodes.get(s.creator) : null) { const id = sess.scope.get(scopeKey(s.id, p.key)); hit = (id && sess.nodes.get(id)) || null }
      n = hit && hit.parent === parent.id && !hit.merged_into ? hit : childBySeg(sess, parent, p.key) || hit
    } else if (p.segs.length === 1) n = childBySeg(sess, parent, p.segs[0])
    else { const w = walkPath(t, scopeNode, p.segs, false); n = w.ok === false ? null : w.node }
    if (!n) return bad('unknown-anchor', `no sibling "${cpSlice(String(pos.ref), 60)}" under "${where}" to place it ${pos.kind}`)
  }
  if (n.parent !== parent.id || n.merged_into) return bad('bad-anchor', `"${n.label}" is not under "${where}" — ${pos.kind} names a sibling there`)
  return { kind: pos.kind, anchor: n }
}
/**
 * k ranks for nodes of rank group g placed per `rp` (resolvePos) under `parent` — #82's placeRanks on ids. `skip` = the ids
 * being placed (left out of their own siblings). `fresh` (nodes this call creates): "last" stores NO rank — their derived
 * rank (creation time) already puts them last (a stored one only where 2b's "needed" rule already gave it). → { ok, ranks
 * (string|null)[], text } or `bad-anchor` / `bad-position` / `rank-exhausted`.
 */
function placeRanks2(t, parent, g, rp, k, skip, fresh) {
  const sibs = childrenOf2(t.sess, parent).filter(n => !skip.has(n.id) && rankGroup(n) === g)
  const openHi = derivedRank(t.now + 1, null), nulls = text => ({ ok: true, ranks: new Array(k).fill(null), text })
  let lo = null, hi = null, text
  if (rp.anchor) {
    const a = rp.anchor
    if (skip.has(a.id)) return bad('bad-position', `a node can't be placed ${rp.kind} itself`)
    if (rankGroup(a) !== g) return bad('bad-anchor', `"${a.label}" is among the ${GROUP_NAMES[rankGroup(a)]} — plan items come first, then contexts, then agents; place it among the ${GROUP_NAMES[g]}`)
    const i = sibs.indexOf(a)
    if (rp.kind === 'before') { lo = i > 0 ? rankOf(sibs[i - 1]) : null; hi = rankOf(a) } else { lo = rankOf(a); hi = i < sibs.length - 1 ? rankOf(sibs[i + 1]) : openHi }
    text = `${rp.kind} ${a.label}`
  } else if (rp.kind === 'first') {
    text = 'first'
    if (!sibs.length) return nulls(text)
    hi = rankOf(sibs[0])
  } else {
    text = 'last'
    if (fresh || !sibs.length) return nulls(text)
    lo = rankOf(sibs[sibs.length - 1]); hi = openHi
  }
  if (lo !== null && hi !== null && lo >= hi) hi = null
  const ranks = []
  for (let i = 0; i < k; i++) { const r = rankBetween(lo, hi); if (!validRank(r)) return bad('rank-exhausted', 'too many insertions at one spot — place it elsewhere'); ranks.push(r); lo = r }
  return { ok: true, ranks, text }
}
/**
 * Place NEW nodes (the call's target, or the plan items it created) per `pos` among `parent`'s children: each gets its rank
 * on the node and on its own `create` record (still unwritten: the call's records go out together). → { placed:{ where } }.
 */
function placeNew(t, nodes, parent, pos, scopeNode) {
  const rp = resolvePos(t, pos, parent, scopeNode)
  if (rp.ok === false) return rp
  const pr = placeRanks2(t, parent, rankGroup(nodes[0]), rp, nodes.length, new Set(nodes.map(n => n.id)), true)
  if (pr.ok === false) return pr
  nodes.forEach((n, i) => {
    const r = pr.ranks[i]
    if (r == null) return
    fset(t, n, 'rank', r)
    const rec = t.records.find(x => x.op === 'create' && x.n === n.id)
    if (rec) rec.rank = r
  })
  return { placed: { where: pr.text, ...(nodes.length === 1 && nodes[0].rank ? { rank: nodes[0].rank } : {}) } }
}
/**
 * REORDER an existing node among its siblings (§4.1: a position alone on an existing target; the dashboard's reorder; a
 * same-parent move with a position): one `rank` record + its entry ("placed before Build", §2.2). Already there (directly
 * before / after the anchor, first, last) → a no-op: nothing written, so a retry never reorders anything again.
 * @returns {any} { placed:{ where, rank } } | { noop:true } | a refusal
 */
function reorderNode(t, node, pos, scopeNode) {
  const { sess } = t
  if (node.parent == null) return bad('bad-position', 'the session root has no siblings')
  const parent = sess.nodes.get(node.parent), g = rankGroup(node)
  const rp = resolvePos(t, pos, parent, scopeNode)
  if (rp.ok === false) return rp
  if (rp.anchor && rp.anchor.id === node.id) return bad('bad-position', `a node can't be placed ${rp.kind} itself`)
  if (rp.anchor && rankGroup(rp.anchor) !== g) return badAnchor(rp.anchor, node)
  const full = childrenOf2(sess, parent).filter(n => rankGroup(n) === g), i = full.indexOf(node)
  const there = rp.kind === 'before' ? full[i + 1] === rp.anchor : rp.kind === 'after' ? full[i - 1] === rp.anchor : rp.kind === 'first' ? i === 0 : i === full.length - 1
  if (there) return { noop: true }
  const pr = placeRanks2(t, parent, g, rp, 1, new Set([node.id]), false)
  if (pr.ok === false) return pr
  const rank = pr.ranks[0] || lastRank(t, parent, node)
  fset(t, node, 'rank', rank)
  record(t, 'rank', node, { rank })
  entryStub(t, node, 'reorder', `placed ${pr.text}`)
  return { placed: { where: pr.text, rank } }
}

// ---------------------------------------------------------------------------------------------------------------
// resolution (§3)

/** A merged node resolves to the node it merged into (§3.6, §3.2), with warning `merged`. */
function redirect(t, node) {
  let n = node, hops = 0
  while (n && n.merged_into && hops++ < 64) n = t.sess.nodes.get(n.merged_into)
  if (n !== node) warn(t, { code: 'merged', what: `"${node.label}" was merged into ${pathOf(t.sess, n)}`, from: node.id, to: n.id })
  return n
}
/** A node by id: this session's (live); another session's → cross-session; a ghost / nothing → unknown-node. */
function byId(t, id, what) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return bad('bad-ref', `${what} must be a node id (16 chars of a-z 2-7)`)
  const n = t.sess.nodes.get(id)
  if (n) return { node: n }
  for (const s of t.state.sessions.values()) if (s !== t.sess && s.nodes.has(id)) return bad('cross-session', `${what} ${id} belongs to another session (${s.ident.session}): moves stay within a session`)
  return bad('unknown-node', `${what} ${id} is not on the board${t.sess.ghosts.has(id) ? ' (it was removed)' : ''}`)
}
/** Walk the creator chain from the root (each step a LIVE agent). */
function creatorByChain(t, creators) {
  let c = rootOf(t.sess)
  for (const k of creators) {
    const id = t.sess.scope.get(scopeKey(c.id, k)), n = id && t.sess.nodes.get(id)
    if (!n || n.kind !== 'agent') return null
    c = n
  }
  return c
}
/**
 * Resolve a REFERENCE (§3.2) — never creates: `chain:key` (exactly that scope), a bare key (the call's scope, then its
 * creator's … up to the session's), a path (§3.3 from the scope node: live tree, then aliases), or an id (`*_id`).
 * A merged node resolves to its target.
 */
function resolveRef(t, raw, rawId, scopeNode, what) {
  const { sess } = t
  let r
  if (rawId != null) r = byId(t, rawId, what)
  else {
    const p = parseRef(raw)
    if (!p.ok) return p
    if (p.kind === 'chain') {
      const c = creatorByChain(t, p.creators)
      const id = c && sess.scope.get(scopeKey(c.id, p.key)), n = id && sess.nodes.get(id)
      r = n ? { node: n } : bad('unknown-node', `${what} "${raw}" names no node on the board`)
    } else if (p.kind === 'key') {
      let n = null
      for (let s = scopeNode; s && !n; s = s.creator != null ? sess.nodes.get(s.creator) : null) { const id = sess.scope.get(scopeKey(s.id, p.key)); n = (id && sess.nodes.get(id)) || null }
      r = n ? { node: n } : bad('unknown-node', `${what} "${raw}": no node has that key in your scope or above`)
    } else {
      const w = walkPath(t, scopeNode, p.segs, false)
      r = w.ok === false ? bad('unknown-node', `${what} "${raw}" names no node on the board`) : w
    }
  }
  if (r.ok === false) return r
  return { node: redirect(t, r.node) }
}

/**
 * Walk a PATH (§3.3) from `base`: (1) the live tree, segment by segment (label, else an agent / question by key); (2) the
 * ALIAS table — the longest alias that is a prefix of the full path and covers more than the live tree matched (the live
 * tree always wins), with warning `alias`; the rest resolves below it; (3) with `create`, the missing tail is CREATED as
 * contexts (intermediates implicit), creator = the OWNER (§3.4), key = slug (-2 … on a clash, live or ghost), label = the
 * segment — or, where a GHOST under that parent has the segment's label, that ghost is RESURRECTED (a new run, §3.7).
 * @returns {any} { node, created:boolean } or a refusal
 */
function walkPath(t, base, segs, create, o = {}) {
  const { sess } = t
  let n = base, i = 0
  for (; i < segs.length; i++) { const c = childBySeg(sess, n, segs[i]); if (!c) break; n = c }
  if (i < segs.length) {
    const baseLabels = labelsOf(sess, base), full = [...baseLabels, ...segs]
    for (let j = full.length; j > baseLabels.length + i; j--) {
      const k = labelKey(formatPath2(full.slice(0, j))), a = sess.aliases.get(k), hit = a && sess.nodes.get(a.id)
      if (!hit) continue
      fset(t, a, 'used', t.now)
      const to = redirect(t, hit)
      warn(t, { code: 'alias', what: `${formatPath2(full.slice(0, j))} is now ${pathOf(sess, to)}`, was: formatPath2(full.slice(0, j)), now: pathOf(sess, to), id: to.id })
      n = to; i = j - baseLabels.length
      for (; i < segs.length; i++) { const c = childBySeg(sess, n, segs[i]); if (!c) break; n = c }
      break
    }
  }
  if (i === segs.length) return { node: n, created: false }
  if (!create) return bad('unknown-node', `no node at ${formatPath2(segs)}`)
  for (; i < segs.length; i++) {
    const last = i === segs.length - 1
    const ghost = ghostUnder(sess, n, segs[i])
    const c = ghost
      ? createNode(t, { ghost, creator: null, key: null, kind: null, label: segs[i], parent: n, implicit: !last, transient: last && !!o.transient, grace_ms: o.grace_ms, type: last ? o.type : null })
      : createNode(t, { creator: ownerOf2(sess, n), key: freeKey(sess, ownerOf2(sess, n), segs[i]), kind: 'context', label: segs[i], parent: n, implicit: !last, transient: last && !!o.transient, grace_ms: o.grace_ms, type: last ? o.type : null })
    if (c.ok === false) return c
    n = c
  }
  return { node: n, created: true }
}
/** The first of slug(label), -2, -3 … that NO node in `creator`'s scope holds, live or ghost (§3.3, §3.8). */
const freeKey = (sess, creator, label) => uniqueKey(slugKey(label), k => sess.scope.has(scopeKey(creator.id, k)))
/** The newest CONTEXT GHOST whose last parent is `parent` and whose label matches (labelKey) — §3.8 step 2. Never an agent's
 * ghost: a path (and a --move-to bucket) never makes an agent (§3.3) — step 3's replay fuzz found one brought back as a
 * transient "bucket". */
function ghostUnder(sess, parent, label) {
  const ids = sess.gkids.get(parent.id)
  if (!ids) return null
  let best = null
  for (const id of ids) { const g = sess.ghosts.get(id); if (g && g.kind === 'context' && labelKey(g.label) === labelKey(label) && (!best || g.removed_at > best.removed_at)) best = g }
  return best
}

/**
 * Split a path that may be RELATIVE (§3.8): `/…` = absolute from the session root; otherwise any run of leading `..`
 * segments (`up`, each one level up from the node's current parent) and the label segments after them (a bare `X` has
 * up = 0). A label that is literally `..` is written quoted (`".."`). Syntax only — what is ALLOWED is the caller's rule.
 * @param {any} raw @param {string} [what] @returns {any} { ok:true, abs, up, segs } or { ok:false, code, what }
 */
function splitRel(raw, what = 'move_to') {
  if (typeof raw !== 'string' || !raw.trim()) return bad('bad-path', `${what} must be a path: "../X" (beside the node's parent) or "/A/X" (from the session root)`)
  let s = raw.trim()
  if (s.startsWith('/')) { const p = parsePath2(s); return p.ok ? { ok: true, abs: true, up: 0, segs: p.segs } : p }
  let up = 0, m
  while ((m = /^\.\.[ ]*(?:\/[ ]*|$)/.exec(s))) { up++; s = s.slice(m[0].length) }
  const p = parsePath2(s)
  return p.ok ? { ok: true, abs: false, up, segs: p.segs } : p
}
/**
 * Parse a `--move-to` path (§3.8, Q45, Q46 FINAL): only `/…` (absolute from the session root) and `../X` (exactly ONE
 * leading `..` and ONE label: beside the node's current parent) — the two forms a retry resolves to the same place. A bare
 * `X`, and every deeper relative form (`../A/B`, `../../X`, `../../R/X`), is refused `bad-path`; such a refusal carries
 * `rel: { up, segs }` so the call can answer `suggest: "/…"` — the absolute path it would have resolved to (applyCall). `..`
 * alone (no destination) is refused without one.
 * @param {any} raw @returns {any} { ok:true, abs, up, segs } or { ok:false, code, what, rel? }
 */
export function parseMoveTo(raw) {
  const r = splitRel(raw)
  if (!r.ok) return r
  const shown = raw.trim()
  if (r.abs) return r.segs.length ? r : bad('bad-path', 'move_to "/" names the session root: give the destination, e.g. "/Later"')
  const dest = r.segs.length ? formatPath2(r.segs) : null, rel = { up: r.up, segs: r.segs }
  if (!r.up) return bad('bad-path', `move_to "${shown}" is a bare name — not allowed (a retry would move the node again, one level down): use "../${dest}" (beside the node's parent) or "/…/${dest}" (from the session root)`, { rel })
  if (!r.segs.length) return bad('bad-path', `move_to "${shown}" has no destination after the ".." — name it, e.g. "../Done", or give an absolute path "/…"`)
  if (r.up !== 1 || r.segs.length !== 1) return bad('bad-path', `move_to "${shown}" is not retry-safe (a retry resolves a relative path from the NEW parent): only one step up is allowed — "../X", beside the node's parent — or the absolute form "/…" (aimb-log --resolve prints it)`, { rel })
  return r
}

/**
 * `--move-to` (§3.8): resolve the destination from the node's current parent (or the root), segment by segment — a LIVE
 * child (label, else agent key) → a same-label GHOST of that parent RESURRECTED (same id / key / creator, a new run,
 * transient) → a NEW transient context (creator = the CALLER, key unused in its scope, live or ghost) — then move the node
 * there (last; the --move refusals). Already there → no move (and nothing created): a retry is a no-op.
 */
function moveToPath(t, node, mt, caller, grace_ms) {
  const { sess } = t
  if (node.parent == null) return bad('bad-move', 'the session root cannot move')
  let base = mt.abs ? rootOf(sess) : sess.nodes.get(node.parent)
  for (let k = 0; k < mt.up; k++) {
    if (base.parent == null) return bad('bad-path', `move_to goes above the session root (${mt.up} ".." from ${pathOf(sess, node)})`)
    base = sess.nodes.get(base.parent)
  }
  let n = base, i = 0
  for (; i < mt.segs.length; i++) { const c = childBySeg(sess, n, mt.segs[i]); if (!c) break; n = c }
  if (i === mt.segs.length && n.id === node.parent) return { noop: true }
  if (i === mt.segs.length && atOrUnder(sess, n, node)) return bad('bad-move', `can't move "${node.label}" under itself`)
  for (; i < mt.segs.length; i++) {
    if (atOrUnder(sess, n, node)) return bad('bad-move', `can't move "${node.label}" under itself`)
    const ghost = ghostUnder(sess, n, mt.segs[i])
    const c = ghost
      ? createNode(t, { ghost, creator: null, key: null, kind: null, label: mt.segs[i], parent: n, transient: true, grace_ms })
      : createNode(t, { creator: caller, key: freeKey(sess, caller, mt.segs[i]), kind: 'context', label: mt.segs[i], parent: n, transient: true, grace_ms })
    if (c.ok === false) return c
    if (ghost && !c.transient) { fset(t, c, 'transient', true); fset(t, c, 'grace_ms', grace_ms || null) }
    n = c
  }
  return moveNode(t, node, n)
}

// ---------------------------------------------------------------------------------------------------------------
// 2b: reading a path without changing anything (Q46: the refused move's `suggest`, the resolve tool)

/**
 * Walk `segs` from `base` the way --move-to would (§3.8) WITHOUT creating or resurrecting anything: a live child (label,
 * else an agent / question by key) → this parent's same-label GHOST → "new" (that segment and every one after it would be
 * created). → { node (the last live or ghost node reached), state:'live'|'ghost'|'new', labels (as spelt on the board; the
 * new tail as given), create:[labels] }
 */
function walkRead(sess, base, segs) {
  let n = base, state = 'live'
  const labels = [], create = []
  for (const seg of segs) {
    if (state !== 'new') {
      const c = state === 'live' ? childBySeg(sess, n, seg) : null
      if (c) { n = c; labels.push(c.label); continue }
      const g = ghostUnder(sess, n, seg)
      if (g) { n = g; state = 'ghost'; labels.push(g.label); continue }
      state = 'new'
    }
    labels.push(seg); create.push(seg)
  }
  return { node: n, state, labels, create }
}
/** The base a path starts from (§3.8): the root for an absolute one; else the node's current PARENT, one level up per "..". */
function relBase(sess, node, abs, up) {
  if (abs) return { base: rootOf(sess) }
  if (node.parent == null) return bad('bad-path', 'the session root has no parent: a relative path needs a node (--key / --id / --path), or give an absolute path "/…"')
  let base = sess.nodes.get(node.parent)
  for (let k = 0; k < up; k++) {
    if (base.parent == null) return bad('bad-path', `the path goes above the session root (${up} ".." from ${pathOf(sess, node)})`)
    base = sess.nodes.get(base.parent)
  }
  return { base }
}
const absPath = (sess, base, labels) => '/' + formatPath2([...labelsOf(sess, base), ...labels])

/**
 * The RESOLVE helper (Q46 — `aimb-log --resolve "<path>" [--key X | --id I | --path P]`, the tool `resolve`): the absolute
 * path and id a path resolves to NOW, from the named node's current parent (the --move-to base; no key / id / path = the
 * --agent node; the session root has no parent, so only an absolute path works from it), walked as --move-to would (a live
 * child → a same-label ghost → would be created). Takes ANY relative form (a bare X, ../A/B, ../../X) and the absolute one.
 * CHANGES NOTHING: no create, no resurrection, no alias refresh.
 * @param {any} state @param {{ session: string, project?: string, user?: string, realm?: string }} ident
 * @param {{ resolve: string, agent?: string, key?: string, id?: string, path?: string }} input
 * @returns {any} { ok:true, path:"/…", id (null when it would be created), state:"live"|"ghost"|"new", node (live only),
 *   create:[labels a move there would create], from (the node it is relative to), warnings } or a refusal
 */
export function resolveCall(state, ident, input) {
  if (!state || !(state.sessions instanceof Map)) return bad('bad-state-object', 'pass a createModel() state')
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('bad-input', 'expected { resolve: "<path>", agent?, key? | id? | path? }')
  const extra = Object.keys(input).filter(k => !['resolve', 'agent', 'key', 'id', 'path'].includes(k) && input[k] !== undefined)
  if (extra.length) return bad('bad-input', `resolve takes agent, key | id | path and resolve — not ${extra.join(', ')}`)
  const sp = splitRel(input.resolve, 'resolve')
  if (!sp.ok) return sp
  const pc = parseCall({ agent: input.agent, key: input.key, id: input.id, path: input.path })
  if (!pc.ok) return pc
  const q = pc.q, sess = getSession2(state, ident)
  if (!sess) return bad('unknown-session', `no activity from a session "${String(ident && ident.session).slice(0, 80)}" on this host`)
  const t = newTx(state, sess, 0)
  try {
    let scope = rootOf(sess)
    if (q.agent) { scope = creatorByChain(t, q.agent); if (!scope) return bad('unknown-agent', `--agent ${q.agent.join('/')} is not on the board`) }
    let node = scope
    if (q.key != null) {
      const id = sess.scope.get(scopeKey(scope.id, q.key)), n = id && sess.nodes.get(id)
      if (!n) return bad('unknown-node', `no node has the key ${q.key} in your scope${id ? ' (it was removed)' : ''}`)
      node = n
    } else if (q.id != null) { const r = byId(t, q.id, 'id'); if (r.ok === false) return r; node = r.node }
    else if (q.segs) { const w = walkPath(t, scope, q.segs, false); if (w.ok === false) return w; node = w.node }
    node = redirect(t, node)
    const b = relBase(sess, node, sp.abs, sp.up)
    if (b.ok === false) return b
    const w = walkRead(sess, b.base, sp.segs)
    return { ok: true, path: absPath(sess, b.base, w.labels), id: w.state === 'new' ? null : w.node.id, state: w.state, node: w.state === 'live' ? nodeView(sess, w.node) : null,
      create: w.create, from: nodeView(sess, node), warnings: [...t.warnings] }
  } finally { rollback(t) }
}

// ---------------------------------------------------------------------------------------------------------------
// 2b: lines and entries (§4.0)

/** Does a node hold plan items (a PLAN node)? */
const holdsItems = (sess, n) => childrenOf2(sess, n).some(c => c.plan)
/**
 * A report's ACTIVITY (§1.4): target..owner (the nearest agent at or above it, else the root) and the calling agent get
 * last_activity = now and stale_after until their next report; the owner stops being implicit; the session header moves.
 * A system call (t.by: the bridge, a dashboard) touches nothing (6c).
 */
function touch(t, node, staleMs, caller) {
  const { sess } = t
  const owner = ownerOf2(sess, node)
  const bump = n => { fset(t, n, 'last_activity', Math.max(n.last_activity, t.now)); fset(t, n, 'stale_after_ms', staleMs || null); fset(t, n, 'gone_at', null) }
  for (let n = node; n; n = n.parent != null ? sess.nodes.get(n.parent) : null) { bump(n); if (n === owner) break }
  if (caller && caller.kind === 'agent' && caller !== owner) bump(caller)
  fset(t, owner, 'implicit', false)
  fset(t, sess, 'last_activity', Math.max(sess.last_activity, t.now))
}

/**
 * Apply one REPORT to `node` (§4.0) inside the call's transaction — every check first, then the changes. m = parseReport's
 * { text, line, state, progress?, eta_at?, stale_after_ms, details, data, log, ask?, withdraw? }; o = { question (a status
 * change's new question: an answer, the dashboard's withdraw, the expiry), entryText (the LOG text; the line keeps its
 * own), planEnd ('done' | 'abandoned' | 'open'), cascade:false, caller (the calling agent, for activity) }.
 * - The LINE changes when the text has a leading `@` (m.line), a state is given, or a question is asked / changes status
 *   (`changes` — the entry's `current`). Only a leading `@` (or a question) sets its TEXT: a state change keeps it (one rule,
 *   no implied line: Q33). details / data go on the entry, and on the line when its text is set (a state change keeps the
 *   line's).
 * - States (6b / 6c / #82): todo / skipped only on contexts; todo as a line-less context's first state makes it a plan item
 *   (an `item` record); skipped only on a plan item; abandoned on any context, on an agent / the root only while it holds
 *   plan items (it then also ENDS its plan: the plan-end marker, 6d); a `@` line on a ☐ item starts it. done / failed /
 *   abandoned finish an agent or the root, a live state revives it; the ETA is dropped on those.
 * - Questions (#85 / #90): a question's line is the question — a plain report may LOG on it, but a line / state on it is
 *   refused (`question-node`), except abandoned on an OPEN one, which withdraws it. A status change keeps the line's id,
 *   details and data; its entry gets details of its own (questionEntryDetails).
 * - Its own line (a leading `@`, or a question) makes a transient context PERMANENT (§3.8).
 * - log:false writes no entry (the node is marked cp_dirty for step 3's checkpoint).
 * - Abandoned CASCADES to the open contexts / plans under it (not crossing an agent), unless o.cascade === false.
 * @returns {any} { entry, changes, line, state, cascade? } or a refusal (nothing changed)
 */
function applyReport(t, node, m, o = {}) {
  const { sess } = t
  const by = t.by, ctx = node.kind === 'context', c0 = node.current, q0 = c0 && c0.question ? c0.question : null
  const where = () => pathOf(sess, node) || sess.ident.session
  let st = m.state || null, qLine = null, qEntry = null, qWhy = null, keepQ = false
  // the entry's MESSAGE TYPE (MESSAGE_TYPES): the caller's (default note), or the bridge's for a question's lifecycle
  let mtype = m.mtype || 'note', mfields = m.fields || null
  if (m.ask) {
    qLine = { status: 'asked', choices: m.ask.choices, free: m.ask.free, asked_at: t.now, ...(m.ask.expires_at ? { expires_at: m.ask.expires_at } : {}) }
    mtype = 'question'; mfields = { ...(m.ask.choices.length ? { choices: m.ask.choices } : {}), free: m.ask.free, ...(m.ask.expires_at ? { expires_at: m.ask.expires_at } : {}) }
  } else if (o.question) { qLine = o.question; keepQ = true; mtype = o.mtype || 'note'; mfields = o.mfields || null }
  else if (m.withdraw) {
    if (!q0) return bad('not-a-question', `"${where()}" is not a question — state withdrawn withdraws a question you asked`)
    if (q0.status !== 'asked') return bad('question-closed', `the question "${where()}" is already ${q0.status}`)
    qLine = { ...q0, status: 'withdrawn', at: t.now, ...(by ? { by } : {}) }; keepQ = true; st = QSTATE.withdrawn
    qEntry = cut(`withdrawn${by ? ' ' + byText(by) : ''}${m.withdraw.note ? ': ' + m.withdraw.note : ''}`)
    mtype = 'withdrawal'; mfields = m.withdraw.note ? { note: m.withdraw.note } : null
  }
  // Q57 / Q61 / Q62 (Robin: "state is progress, result is outcome"): logging a test-result means the test FINISHED — it
  // sets the state to DONE whatever the result (pass / fail / skip is the outcome: the colour, the bucket, testBar2);
  // `--state done` with it is consistent, any other state is refused (a test has no outcome while unfinished). Any
  // CONTEXT that takes a test-result is a test (a plan item or not); an agent / the session runs tests, it isn't one.
  if (mtype === 'test-result' && mfields && mfields.result) {
    if (!ctx) return bad('not-a-test', `"${where()}" is ${node.parent == null ? 'the session' : 'an agent'} — an agent runs tests, it isn't one: log the test-result on the test's own node (--key / --path)`)
    if (st && st !== RESULT_STATE) return bad('bad-state', `a test-result means the test finished: its state is done (the result ${mfields.result} is its outcome) — drop --state ${st}, or send done`)
    st = RESULT_STATE
  }
  const changes = !!(m.line || st || qLine)
  if (q0 && changes && !qLine) {
    if (st === 'abandoned' && !m.line && q0.status === 'asked') { qLine = { ...q0, status: 'withdrawn', at: t.now, ...(by ? { by } : {}) }; keepQ = true; qWhy = o.entryText || null; mtype = 'withdrawal'; mfields = null }   // abandoned / cascaded: an open question is withdrawn
    else return bad('question-node', `"${where()}" is a question — its line is the question: it is answered on the dashboard${q0.status === 'asked' ? ', or withdraw it (state withdrawn)' : '; ask again on it for a new one'} (plain text only logs on it)`)
  }
  if (st && PLAN_STATES.has(st)) {
    if (!ctx) return bad('bad-agent-state', `${st} is a plan state — only a context (a plan item) can be ${st}; an agent or the session reports running|blocked|failed|done|idle`)
    if (!node.plan && (st === 'skipped' || c0)) return bad('not-a-plan-item', `"${where()}" is ${c0 ? 'an ordinary context (it already has a line of its own)' : 'not a plan item'} — ${st} is for plan items: make them with --item`)
    if (!node.plan && typeOf(node).counts_as === 'none') return bad('bad-type', `"${where()}" is a ${node.type} — a ${node.type} can't be a plan item`)
  }
  if (st === 'abandoned' && !ctx && !holdsItems(sess, node)) return bad('not-a-plan', `"${where()}" is ${node.parent == null ? 'the session' : 'an agent'} holding no plan — abandoned is for contexts, plan items and plans (an agent or the session that holds plan items)`)
  // ---- every check passed: apply
  if (qLine) qLine = normQuestion(qLine)
  let entryState = st || (c0 ? c0.state : null) || 'running'
  if (m.ask) entryState = QSTATE.asked
  else if (m.line && !st && node.plan && c0 && c0.state === 'todo') entryState = 'running'   // a line on a ☐ item starts it
  const setText = !!(m.line || m.ask)
  const lineText = m.ask ? m.ask.question : m.line ? m.text : c0 ? c0.text : node.label
  if (st === 'todo' && ctx && !node.plan && !c0) { fset(t, node, 'plan', true); record(t, 'item', node, {}) }   // 6b: a first line of todo makes a plan item
  const entryId = newEntryId(t.state, t.now)
  if (changes) {
    const keep = keepQ && c0
    const lineBy = setText ? (t.act === 'edit_text' && by && typeof by === 'object' ? by : null) : (c0 && c0.by) || null   // #83: who wrote the line's text (2c's edit text)
    const fresh = setText && !keep
    fset(t, node, 'current', { id: keep ? c0.id : entryId, ts: t.now, text: lineText, state: entryState,
      details: fresh ? m.details || null : c0 ? c0.details || null : null, data: fresh ? (m.data != null ? m.data : null) : c0 && c0.data != null ? c0.data : null,
      ...(lineBy ? { by: lineBy } : {}), ...(qLine ? { question: qLine } : {}) })
    if (!ctx) fset(t, node, 'finished_at', FINAL.has(entryState) ? node.finished_at || t.now : null)
  }
  // step 3: TIME — the line's state change starts / ends an attempt (timingStep); a test-result's duration is its took
  let tookNow = null
  if (changes) {
    const tp = timingStep(node, entryState, t.now, mtype === 'test-result' && mfields && Number.isFinite(mfields.duration) ? mfields.duration : null)
    for (const k of Object.keys(tp)) fset(t, node, k, tp[k])
    if ('took' in tp) tookNow = tp
  }
  let planEnd = o.planEnd || null
  if (changes && !ctx && entryState === 'abandoned' && !planEnd) planEnd = 'abandoned'   // 6d: the tool's abandoned on an agent / the root ends the plan it holds
  if (planEnd) fset(t, node, 'plan_end', planEnd === 'open' ? null : { state: planEnd, ts: t.now })
  if ('progress' in m) fset(t, node, 'progress', m.progress ? { ...m.progress } : null)
  if ('eta_at' in m) fset(t, node, 'eta_at', m.eta_at || null)
  if (FINAL.has(stateOf(node))) fset(t, node, 'eta_at', null)
  // 2d: a type with `keep` (test-result → `test`): the node keeps this entry's fields (+ the state it left the node in: the
  // result stands while that state does, testOutcome2); a later report that STARTS it again (todo / running / blocked, with
  // no test-result) clears it — a new run of that test. No state is implied by a result (the state drives the bar).
  const keepAs = MESSAGE_TYPES[mtype] && MESSAGE_TYPES[mtype].keep
  let testCleared = false
  if (keepAs) fset(t, node, keepAs, { ...(mfields || {}), ts: t.now, entry: m.log !== false ? entryId : null, state: stateOf(node) })
  else if (st && OPEN_ITEM.has(st) && node.test) { fset(t, node, 'test', null); testCleared = true }
  fset(t, node, 'implicit', false)
  // step 3: the CALLING agent the report also refreshes (§1.4) when it is not on target..owner — the entry names it (`caller`)
  const callerId = !by && o.caller && o.caller.kind === 'agent' && o.caller !== ownerOf2(sess, node) ? o.caller.id : null
  if (!by) touch(t, node, m.stale_after_ms, o.caller)
  if (setText && node.transient) keepNode(t, node)   // its OWN line makes a transient context permanent (§3.8)
  let entry = null
  if (m.log !== false) {
    const text = cut(o.entryText || qEntry || m.text || ('progress' in m && m.progress ? '{progress}' : 'eta_at' in m && m.eta_at ? '{eta}' : null) || lineText)
    const eDet = keepQ ? questionEntryDetails(q0, qLine, c0 ? c0.text : lineText, { now: t.now, note: m.withdraw ? m.withdraw.note : null, why: qWhy }) : m.details || null
    entry = writeEntry(t, node, { id: entryId, type: mtype, fields: mfields, current: changes, text, state: entryState, details: eDet, data: keepQ ? null : m.data,
      extra: { progress: 'progress' in m ? m.progress : undefined, eta_at: 'eta_at' in m ? m.eta_at : undefined, stale_after_ms: m.stale_after_ms || undefined,
        // step 3 (the replay): `line` = this entry SET the line's text (its details / data are the line's; else the line kept
        // its own), `test_cleared` = a restart dropped the node's kept test-result, `caller` = the calling agent refreshed too
        line: setText || undefined, test_cleared: testCleared || undefined, caller: callerId || undefined,
        // TIME: the entry that ENDS an attempt carries its took (ms) and, after a re-run, the total over its attempts
        took: tookNow ? tookNow.took : undefined, took_total: tookNow && tookNow.attempts > 1 ? tookNow.took_total : undefined, attempts: tookNow && tookNow.attempts > 1 ? tookNow.attempts : undefined,
        line_text: changes && lineText !== text ? lineText : undefined, line_by: changes && node.current.by ? node.current.by : undefined,
        question: changes && qLine ? qLine : undefined, plan_end: planEnd || undefined,
        ...(keepQ && c0 ? { line_id: c0.id, line_details: c0.details || undefined, line_data: c0.data != null ? c0.data : undefined } : {}) } })
    if (changes && !ctx) entry.finished_at = node.finished_at   // an agent's line carries its resulting finished_at (null = revived)
  } else {   // log:false — its checkpoint (step 3) restates the node; a calling agent it refreshed gets one too (its activity)
    fset(t, node, 'cp_dirty', true)
    if (callerId) fset(t, sess.nodes.get(callerId), 'cp_dirty', true)
  }
  const cascade = changes && entryState === 'abandoned' && o.cascade !== false ? cascadeAbandon2(t, node) : []
  return { entry, changes, line: setText, state: entryState, ...(cascade.length ? { cascade } : {}) }
}

/**
 * The CASCADE of an abandoned node (#82 part 5): every CONTEXT under it (not crossing an agent: an agent's work is its own),
 * deepest first, that is OPEN (its line todo / running / blocked) or holds an open plan gets an abandoned line; the entry says
 * why ("abandoned with <path>" + the attribution). An open question there is withdrawn. → [{ id, path, from, entry_id }]
 */
function cascadeAbandon2(t, top) {
  const { sess } = t
  const list = []
  const walk = (n, d) => { for (const c of childrenOf2(sess, n)) if (c.kind === 'context') { list.push({ c, d }); walk(c, d + 1) } }
  walk(top, 1)
  list.sort((a, b) => b.d - a.d || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0))
  const why = cut(`abandoned with ${pathOf(sess, top) || sess.ident.session}${t.by ? ' ' + byText(t.by) : ''}`)
  const out = []
  for (const { c } of list) {
    if (!sess.nodes.has(c.id)) continue
    const p = planOf2(sess, c)
    if (!((c.current && OPEN_ITEM.has(c.current.state)) || (p && planEndAt2(sess, c, p) == null))) continue
    const from = c.current ? c.current.state : 'open'
    const r = applyReport(t, c, { state: 'abandoned', text: null, line: false, log: true, stale_after_ms: null }, { entryText: why, cascade: false })
    if (r.ok === false) continue
    out.push({ id: c.id, path: pathOf(sess, c), from, entry_id: r.entry ? r.entry.id : null })
  }
  return out
}

/**
 * Parse a call's REPORT fields (§4.0, §4.2): text (parseText: plain = log only, a leading `@` = also set the line, `@@` = a
 * literal `@`; `@~` refused legacy-form), state, progress / eta ("none" clears), stale_after, details, data, log — or a
 * QUESTION (ask + choices / free / expires) or the asker's withdrawal (state "withdrawn", text = a note). The 1.7x `to` and
 * `note` are refused legacy-form. → { ok, rep } (rep null: the call reports nothing)
 */
function parseReport(input, o, warnings) {
  const given = k => input[k] !== undefined && input[k] !== null
  if (given('to')) return bad('legacy-form', '--move … --to was removed in 2.0: use --key <node> --move <parent> (or --path … --move …)')
  if (given('note')) return bad('legacy-form', 'note was removed in 2.0: plain text only logs — use text "…" (a leading @ also sets the line)')
  let log = true
  if (given('log')) { log = boolOf(input.log); if (log === null) return bad('bad-log', 'log must be true (append to the log; the default) or false (update the board only)') }
  const common = { stale_after_ms: null, details: null, data: null }
  if (given('stale_after')) {
    let ms = parseDuration(input.stale_after)
    if (!Number.isFinite(ms) || ms <= 0) return bad('bad-stale-after', 'stale_after must be a duration > 0 like "60m" or "2h" (max 24h)')
    if (ms > ACTIVITY_LIMITS.staleAfterMaxMs) { ms = ACTIVITY_LIMITS.staleAfterMaxMs; warnings.push({ code: 'stale-after-capped', what: 'stale_after capped at 24h' }) }
    common.stale_after_ms = ms
  }
  if (given('details')) {
    if (typeof input.details !== 'string') return bad('bad-details', 'details must be a string')
    if (utf8(input.details) > ACTIVITY_LIMITS.detailsBytes) return bad('details-too-large', `details is ${utf8(input.details)} bytes; the limit is ${ACTIVITY_LIMITS.detailsBytes} — keep it short`)
    common.details = input.details
  }
  if (given('data')) {
    let d = input.data
    if (typeof d === 'string') { try { d = JSON.parse(d) } catch { return bad('bad-data', 'data is a string but not valid JSON') } }
    const plain = Array.isArray(d) || (d && typeof d === 'object' && (Object.getPrototypeOf(d) === Object.prototype || Object.getPrototypeOf(d) === null))
    if (!plain) return bad('bad-data', 'data must be a JSON object or array')
    let json
    try { json = JSON.stringify(d) } catch (e) { return bad('bad-data', `data is not JSON-serialisable (${e && e.message})`) }
    if (utf8(json) > ACTIVITY_LIMITS.dataBytes) return bad('data-too-large', `data is ${utf8(json)} bytes serialised; the limit is ${ACTIVITY_LIMITS.dataBytes} — keep it small`)
    common.data = JSON.parse(json)
  }
  // ---- the entry's MESSAGE TYPE (MESSAGE_TYPES; default note) and its typed fields (validated — --data stays free-form)
  let mtype = null, mfields = null
  if (given('message_type')) {
    const v = typeof input.message_type === 'string' ? lc(input.message_type.trim()) : '', T = MESSAGE_TYPES[v]
    if (!T) return bad('bad-message-type', `message_type must be one of ${Object.keys(MESSAGE_TYPES).filter(k => MESSAGE_TYPES[k].settable && !MESSAGE_TYPES[k].reserved).join('|')}`)
    if (T.reserved) return bad('type-reserved', `message type "${v}" is reserved — it arrives in a later 2.0 step`)
    if (!T.settable) return bad('bad-message-type', `"${v}" entries are written by the bridge (${v === 'question' ? 'ask a question with ask' : v === 'answer' ? 'answers come from the dashboard' : 'not by a report'})`)
    mtype = v
  }
  if (given('fields') || mtype) { const f = validateEntryFields(mtype || 'note', given('fields') ? input.fields : null); if (!f.ok) return f; mfields = f.fields }   // a type's required fields too (test-result needs result)
  const typed = mtype != null || mfields != null
  // ---- a QUESTION (#85): ask (+ choices / free / expires); it always sets the line, always logs
  if (['ask', 'choices', 'free', 'expires'].some(given)) {
    if (!given('ask')) return bad('bad-ask', 'choices / free / expires belong to a question — give ask (the question) too')
    if (typed) return bad('bad-ask', 'an ask is a question entry: message_type / fields can\'t go with it')
    if (typeof input.ask !== 'string') return bad('bad-ask', 'ask must be a string: the question')
    const question = normText(input.ask)
    if (!question) return bad('bad-ask', 'the question (ask) is empty')
    if (cpLen(question) > ACTIVITY_LIMITS.text) return bad('question-too-long', `a question is at most ${ACTIVITY_LIMITS.text} characters (got ${cpLen(question)}) — shorten it (put background in details)`)
    const extra = ['state', 'progress', 'eta', 'plan'].filter(given)
    if (given('text') && !(typeof input.text === 'string' && !input.text.trim())) extra.unshift('text')
    if (extra.length) return bad('bad-ask', `a question takes ask, choices, free, expires, details, data and stale_after — not ${extra.join(', ')} (the question goes in ask)`)
    if (log === false) return bad('bad-ask', 'a question is always logged (log:false can\'t go with ask)')
    const choices = [], seen = new Set()
    if (given('choices')) {
      if (!Array.isArray(input.choices)) return bad('bad-choices', 'choices must be an array of strings, e.g. ["Postgres", "SQLite"]')
      if (input.choices.length > QUESTION_LIMITS.choices) return bad('bad-choices', `a question has at most ${QUESTION_LIMITS.choices} choices (got ${input.choices.length})`)
      for (const c of input.choices) {
        const s = typeof c === 'string' ? normText(c) : ''
        if (!s) return bad('bad-choices', 'each choice must be a non-empty string')
        if (cpLen(s) > QUESTION_LIMITS.choice) return bad('bad-choices', `choice "${cpSlice(s, 30)}…" is longer than ${QUESTION_LIMITS.choice} characters`)
        if (seen.has(lc(s))) return bad('bad-choices', `choice "${cpSlice(s, 40)}" is given twice`)
        seen.add(lc(s)); choices.push(s)
      }
    }
    let free = !choices.length
    if (given('free')) { const b = boolOf(input.free); if (b === null) return bad('bad-ask', 'free must be true (free text allowed) or false'); free = b }
    if (!choices.length && !free) return bad('bad-ask', 'a question needs choices, free text, or both (free:false with no choices can\'t be answered)')
    let expires_at = null
    if (given('expires')) {
      const ms = parseDuration(input.expires)
      if (!Number.isFinite(ms) || ms <= 0 || ms > QUESTION_LIMITS.expiresMaxMs) return bad('bad-expires', 'expires must be a duration > 0 and ≤ 7 days, e.g. "2h" or "30m"')
      if (!Number.isFinite(o.now)) return bad('bad-expires', 'expires needs the current time')
      expires_at = o.now + ms
    }
    // Robin (2026-10-03): a question reads naturally — the question, then its options as the answers; the text never restates
    // the choices (they are structured fields). Two or more choices spelt out in the text → a warning, not a refusal.
    const inText = choices.filter(c => lc(question).includes(lc(c)))
    if (choices.length > 1 && inText.length > 1) warnings.push({ code: 'choices-in-question', choices: inText, what: `the question repeats its choices (${inText.join(', ')}) — state the question only; the choices are listed below it as the answers` })
    return { ok: true, rep: { ask: { question, choices, free, expires_at }, text: null, line: true, state: null, log: true, ...common } }
  }
  let state = null
  if (given('state')) {
    state = typeof input.state === 'string' ? input.state.trim().toLowerCase() : ''
    if (state !== 'withdrawn' && !ACTIVITY_STATES.includes(state)) return bad('bad-state', `state must be one of ${ACTIVITY_STATES.join('|')} (or withdrawn: a question you asked)`)
  }
  if (given('text') && typeof input.text !== 'string') return bad('bad-text', 'text must be a string')
  const pt = given('text') ? parseText(input.text) : { ok: true, text: '', line: false }
  if (!pt.ok) return pt
  let text = normText(pt.text), line = pt.line
  if (text && cpLen(text) > ACTIVITY_LIMITS.text) { text = cpSlice(text, ACTIVITY_LIMITS.text - 1) + '…'; warnings.push({ code: 'text-truncated', what: `text cut to ${ACTIVITY_LIMITS.text} characters` }) }
  // ---- the asker WITHDRAWS its question (#85): the text is a note for the log
  if (state === 'withdrawn') {
    const extra = ['progress', 'eta', 'plan'].filter(given)
    if (extra.length) return bad('bad-state', `withdrawn (a question) takes an optional text note — not ${extra.join(', ')}`)
    if (log === false) return bad('bad-state', 'withdrawing a question is always logged (log:false can\'t go with state withdrawn)')
    if (typed) return bad('bad-state', 'a withdrawal is a withdrawal entry: message_type / fields can\'t go with it')
    return { ok: true, rep: { withdraw: { note: text || null }, text: null, line: false, state: null, log: true, ...common } }
  }
  if (!text) {
    if (line && !state) return bad('text-empty', 'a leading "@" sets the line to the text after it — that text is empty')
    line = false
  }
  /** @type {any} */
  const rep = { text: text || null, line, state, log, ...common, ...(mtype ? { mtype } : {}), ...(mfields && Object.keys(mfields).length ? { fields: mfields } : {}) }
  if (given('progress')) {
    if (typeof input.progress === 'string' && input.progress.trim().toLowerCase() === 'none') rep.progress = null
    else { const p = parseProgress(input.progress); if (!p.ok) return bad('bad-progress', p.what); rep.progress = p.value; if (p.warning) warnings.push({ code: p.warning, what: 'progress clamped to its total' }) }
  }
  if (given('eta')) {
    if (typeof input.eta === 'string' && input.eta.trim().toLowerCase() === 'none') rep.eta_at = null
    else {
      if (!Number.isFinite(o.now)) return bad('bad-eta', 'an eta needs the current time')
      const at = parseEta(input.eta, o.now, o.tzOffsetMin)
      if (!Number.isFinite(at)) return bad('bad-eta', 'eta must be a duration ("15m", "1h25m", "90s"; > 0, ≤ 7 days) or a local clock time "HH:MM"')
      rep.eta_at = at
    }
  }
  if (!rep.text && !state && !('progress' in rep) && !('eta_at' in rep) && mtype !== 'test-result') {   // a test-result alone IS a report: the test finished (Q62)
    if (common.details != null || common.data != null || common.stale_after_ms || typed) return bad('bad-input', 'details / data / stale_after / message_type / fields ride on a report: give text, a state, progress or eta too')
    return { ok: true, rep: null }
  }
  return { ok: true, rep }
}

// ---------------------------------------------------------------------------------------------------------------
// 2b: plans (§4.1, §5.7)

/**
 * Parse the tool's `plan` (the script's --item list, §4.1, Q31): 1 – 64 entries, each a "label" (its key is the label's
 * slug; matched by LABEL under the target first — the re-plan rule) or { key, label? } (the label is REQUIRED when the item
 * is created, never the key). An item given twice (same key / same label) is kept once, warning plan-duplicates.
 */
function parsePlan2(v, warnings) {
  if (!Array.isArray(v) || !v.length) return bad('bad-plan', 'plan must be a non-empty array: ["Spec", "Build"] or [{ key:"spec", label:"Write the spec" }]')
  if (v.length > ACTIVITY_LIMITS.planItems) return bad('bad-plan', `a plan holds at most ${ACTIVITY_LIMITS.planItems} items (got ${v.length}) — split it`)
  const out = [], seen = new Set()
  let dup = false
  for (const raw of v) {
    let it
    if (typeof raw === 'string') { const l = normLabel(raw); if (!l.ok) return bad('bad-plan', `plan item "${cpSlice(String(raw), 40)}": ${l.what}`); it = { key: null, label: l.label } }
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const k = validKey(raw.key)
      if (!k.ok) return bad('bad-plan', `plan item key: ${k.what}`)
      let label = null
      if (raw.label != null) { const l = normLabel(raw.label); if (!l.ok) return bad('bad-plan', `plan item ${k.key}: ${l.what}`); label = l.label }
      it = { key: k.key, label }
    } else return bad('bad-plan', 'each plan item is a label ("Write the docs") or { key, label }')
    const dk = it.key ? 'k\n' + lc(it.key) : 'l\n' + labelKey(it.label)
    if (seen.has(dk)) { dup = true; continue }
    seen.add(dk); out.push(it)
  }
  if (dup) warnings.push({ code: 'plan-duplicates', what: 'an item given twice is kept once' })
  return { ok: true, items: out }
}

/**
 * The plan's ITEMS under `target`, in order (6b on ids): an existing child that is already an item is KEPT as it is; an
 * ordinary line-less context (type context or plan) is ADOPTED (an `item` record); one with a line of its own is left alone
 * (plan_item:false); a key held elsewhere in the scope makes nothing (`exists-elsewhere`, §3.5); a ghost key (or, for a
 * label-only item, a same-label ghost of this target) comes back as a new run; anything else is CREATED in the caller's
 * scope (born a plan item: `plan_item` / `plan_ix` on the create record). Each new or adopted item gets a ☐ line (its label,
 * todo) and a logged entry. Ranks: derived (creation time + plan position) — a stored one only where the derived one would
 * sort before an item already there (an explicit position: placeNew, 2c).
 * @returns {any} { items:[{ key, id, label, path, created, adopted?, plan_item, state, warning? }] } or a refusal
 */
function applyPlan2(t, target, items, scope) {
  const { sess } = t
  if (isQuestion2(target)) return bad('bad-plan', 'a question holds no plan')
  const out = []
  const itemsHi = () => { let hi = null; for (const c of childrenOf2(sess, target)) if (c.plan) { const r = rankOf(c); if (hi === null || r > hi) hi = r } return hi }
  const make = (ix, spec) => {
    const hi = itemsHi(), rank = hi !== null && hi >= derivedRank(t.now, ix) ? rankBetween(hi, derivedRank(t.now + 1, null)) : null   // a rank only where needed
    return spec.ghost ? createNode(t, { ghost: spec.ghost, creator: null, key: null, kind: null, label: spec.label || spec.ghost.label, parent: target, plan_ix: ix, rank })
      : createNode(t, { creator: scope, key: spec.key, kind: 'context', label: spec.label, parent: target, plan_ix: ix, rank })
  }
  const itemLine = (n, ix, adopt) => {
    if (adopt) { fset(t, n, 'plan', true); fset(t, n, 'plan_ix', ix); record(t, 'item', n, { plan_ix: ix }) }
    const id = newEntryId(t.state, t.now)
    fset(t, n, 'current', { id, ts: t.now, text: n.label, state: 'todo', details: null, data: null })
    fset(t, n, 'implicit', false)
    if (!t.by) touch(t, n, null, null)
    writeEntry(t, n, { id, current: true, text: cut(n.label), state: 'todo', extra: { line: true } })
  }
  const classify = c => (c.plan ? 'keep' : c.kind === 'context' && !c.current && countsAs(c) === 'bar' ? 'adopt' : 'other')   // a group / question is never adopted
  for (let ix = 0; ix < items.length; ix++) {
    const it = items[ix]
    let n, how = 'create', warning = null
    if (it.key) {
      const id = sess.scope.get(scopeKey(scope.id, it.key)), live = id ? sess.nodes.get(id) : null, ghost = id && !live ? sess.ghosts.get(id) : null
      if (live && (live.parent !== target.id || live.merged_into)) {
        warn(t, { code: 'exists-elsewhere', key: live.key, id: live.id, what: `${live.scope}:${live.key} exists elsewhere (${pathOf(sess, live)}) — no new item was made` })
        out.push({ key: live.key, id: live.id, label: live.label, path: pathOf(sess, live), created: false, plan_item: !!live.plan, state: stateOf(live), warning: 'exists-elsewhere' })
        continue
      }
      if (live) {
        n = live; how = classify(live)
        if (it.label && labelKey(it.label) !== labelKey(live.label) && !(live.asked && labelKey(it.label) === labelKey(live.asked))) warning = 'exists'
      } else if (ghost) {
        if (ghost.kind !== 'context') return bad('bad-plan', `${it.key} was an agent — a plan item is a context: give it another key`)
        n = make(ix, { ghost, label: it.label })
      } else {
        if (!it.label) return bad('label-required', `the plan item ${it.key} is new: give its label ({ key:"${it.key}", label:"…" }; a label never defaults to the key)`)
        n = make(ix, { key: it.key, label: it.label })
      }
    } else {
      const sib = clashAt(sess, target.id, it.label)
      if (sib) { n = sib; how = classify(sib) }
      else { const g = ghostUnder(sess, target, it.label); n = g && g.kind === 'context' ? make(ix, { ghost: g, label: it.label }) : make(ix, { key: freeKey(sess, scope, it.label), label: it.label }) }
    }
    if (n.ok === false) return n
    if (how === 'create' || how === 'adopt') itemLine(n, ix, how === 'adopt')
    if (warning) warn(t, { code: 'exists', ignored: ['label'], what: `${n.scope}:${n.key} exists — its label is set only at creation (use --rename)` })
    out.push({ key: n.key, id: n.id, label: n.label, path: pathOf(sess, n), created: how === 'create', ...(how === 'adopt' ? { adopted: true } : {}), plan_item: !!n.plan, state: stateOf(n), ...(warning ? { warning } : {}) })
  }
  return { items: out }
}

/**
 * A node's PLAN = its plan-item children (null when it has none, and always for a type without a plan end — a GROUP, a
 * question): { items (+ the questions under it, #85), open (todo / running / blocked), done, skipped (skipped + abandoned),
 * total, allDoneAt (when the last item became done, once EVERY item is done; else null) }.
 */
export function planOf2(sess, node) {
  if (!sess || !node || !typeOf(node).plan_end) return null
  let items
  if (typeOf(node).items === 'tree') { items = runItems2(sess, node); if (!items.some(c => c.plan)) return null }   // 2d: a test-run's items are in its buckets
  else {
    const kids = childrenOf2(sess, node)
    items = kids.filter(c => c.plan)
    if (!items.length) return null
    for (const c of kids) if (!c.plan && countsAs(c) === 'item') items.push(c)
  }
  let open = 0, done = 0, skipped = 0, doneAt = 0, all = true
  for (const it of items) {
    const s = stateOf(it)
    if (OPEN_ITEM.has(s)) open++
    if (s === 'done') { done++; doneAt = Math.max(doneAt, it.current ? it.current.ts : 0) } else { all = false; if (s === 'skipped' || s === 'abandoned') skipped++ }
  }
  return { items, open, done, skipped, total: items.length, allDoneAt: all ? doneAt : null }
}
/**
 * When a plan ENDED, or null while it is open (6c / 6d): every item done (the last one's time), a CONTEXT plan node's own
 * line set to one of its type's `ends` (done / abandoned; a test-run's failed too, 2d), or the plan-end marker of an agent /
 * the root — whichever came first. Skipped, failed, idle, todo, running and blocked items keep it open; a group has no plan
 * end.
 */
export function planEndAt2(sess, node, p = planOf2(sess, node)) {
  if (!p) return null
  const ends = []
  if (p.allDoneAt != null) ends.push(p.allDoneAt)
  if (node.kind === 'context' && node.current && typeOf(node).ends.includes(node.current.state)) ends.push(node.current.ts || 0)
  if (node.plan_end && PLAN_END.has(node.plan_end.state)) ends.push(node.plan_end.ts || 0)
  return ends.length ? Math.min(...ends) : null
}
/** HOW a plan ended: 'all-done' | 'done' (marked complete) | 'abandoned' — or null while it is open. */
export function planEndHow2(sess, node, p = planOf2(sess, node)) {
  if (!p || planEndAt2(sess, node, p) == null) return null
  if (p.allDoneAt != null) return 'all-done'
  if (node.kind === 'context' && node.current && typeOf(node).ends.includes(node.current.state)) return node.current.state
  return node.plan_end ? node.plan_end.state : null
}

// ---------------------------------------------------------------------------------------------------------------
// 2b: bars (§5.7, ROLLUP) and groups

const skOf = p => (p && p.skipped > 0 ? p.skipped : 0)
/** The SUM of the children's bars when they all share a unit (case-insensitive; '' counts, '%' doesn't sum). */
function sumBar(bars) {
  if (!bars.length) return null
  const u = lc(bars[0].unit)
  if (u === '%' || !bars.every(p => lc(p.unit) === u)) return null
  const done = bars.reduce((s, p) => s + p.done, 0), skipped = bars.reduce((s, p) => s + skOf(p), 0), total = bars.reduce((s, p) => s + p.total, 0)
  return { done, skipped, total, unit: bars[0].unit, pct: progressPct({ done, total }), rollup: true, n: bars.length, ...(bars.every(p => p.todos) ? { todos: true } : {}) }
}
/** The MEAN of the children's done % and skipped % (each child weighted 1). */
function meanBar(bars) {
  if (!bars.length) return null
  const r1 = x => Math.round(x * 10) / 10
  const mean = r1(bars.reduce((s, p) => s + progressPct(p), 0) / bars.length)
  const skipped = Math.min(r1(bars.reduce((s, p) => s + (p.total > 0 ? Math.min(100, (skOf(p) / p.total) * 100) : 0), 0) / bars.length), r1(100 - mean))
  return { done: mean, skipped, total: 100, unit: '%', pct: mean, rollup: true, n: bars.length }
}
/** "N of M done" over items (#79: M = every item; skipped + abandoned → skipped; failed / idle / open → remaining). */
function itemsBar(items) {
  if (!items.length) return null
  let done = 0, skipped = 0, abandoned = 0
  for (const it of items) { const s = stateOf(it); if (s === 'done') done++; else if (s === 'skipped') skipped++; else if (s === 'abandoned') { skipped++; abandoned++ } }
  return { done, skipped, total: items.length, unit: 'done', pct: progressPct({ done, total: items.length }), rollup: true, todos: true, items: true, n: items.length, ...(abandoned ? { abandoned } : {}) }
}
/**
 * A node's BAR (§5.7), by its TYPE (NODE_TYPES `bar`): none for a GROUP or a question (whatever it holds); else its REPORTED
 * progress; else rolled up from its children by what each adds (`counts_as`: a group adds nothing; a plan item or a
 * question is an ITEM; anything else adds its bar): a node holding PLAN ITEMS — or a `plan` — rolls up ONLY its items
 * ("N of M") — ROLLUP, reversing 6c decision 7: its helper agents / contexts show their bars on their own rows; a node with
 * no plan items rolls up as before — the SUM of its children's bars when they share a unit, else their MEAN %, else "N of M"
 * over its questions. A done / abandoned node's own state overrides the bar (forceBar). `memo` (a Map) caches per call.
 * @param {any} sess @param {any} node @param {Map<string, any>} [memo] @returns {any}
 */
export function bar2(sess, node, memo) {
  if (!sess || !node) return null
  if (memo && memo.has(node.id)) return memo.get(node.id)
  const T = typeOf(node)
  let r = null
  if (T.bar !== 'none') {
    if (node.progress) r = { ...node.progress, skipped: skOf(node.progress), pct: progressPct(node.progress), rollup: false, n: 1 }
    else {
      const kids = childrenOf2(sess, node).filter(c => countsAs(c) !== 'none').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const items = T.items === 'tree' ? runItems2(sess, node) : kids.filter(c => countsAs(c) === 'item')   // 2d: a test-run's items, across its buckets
      if (T.bar === 'items' || items.some(c => c.plan)) r = itemsBar(items)
      else {
        const bars = kids.filter(c => countsAs(c) === 'bar').map(c => bar2(sess, c, memo)).filter(Boolean)
        r = sumBar(bars) || meanBar(bars) || itemsBar(items)
      }
    }
    r = forceBar(node, r)
  }
  if (memo) memo.set(node.id, r)
  return r
}
/**
 * What a row shows for its type (NODE_TYPES): { type, glyph, show:'bar'|'count'|'status'|'tests', bar?, count?, tests? } —
 * the dashboard's input. A test-run ('tests', Q56 CHANGED by Robin) shows ONE bar of its TESTS — passed (green) vs failed
 * (red) vs total (testBar2) — with the pass / fail counts in its tooltip; no items bar, no counts text beside it. (Its
 * items bar, bar2, is still what it adds to its parent's rollup.)
 */
export function displayOf2(sess, node, o = {}) {
  const T = typeOf(node), tk = timing2(sess, node, o.now)
  return { type: node.type, glyph: T.glyph, show: T.show, ...(T.show === 'bar' ? { bar: bar2(sess, node, o.memo) } : {}),
    ...(T.show === 'count' ? { count: groupCount2(sess, node, o) } : {}), ...(T.show === 'tests' ? { tests: testBar2(sess, node) } : {}), ...(tk ? { took: tk } : {}) }
}
/**
 * A node's TIME (step 3, Robin: "time in the logs") — what the dashboard shows as "took 4m 12s": { started_at, ended_at,
 * took (its latest finished attempt, ms), took_total + attempts (every finished attempt: re-runs add up), running_ms (an
 * open attempt, when `now` is given), plan?: { started_at (the first start among the node and its plan's items),
 * ended_at (planEndAt2), took } (a plan node, a test-run, an agent / the session holding a plan), text } — null when the
 * node never started and holds no timed plan. text: the plan's took when it has one, else its own ("took 4m 12s", "took
 * 2.1s (9.4s over 3 runs)", "running 3m" while open with `now`).
 * @param {any} sess @param {any} node @param {number} [now]
 */
export function timing2(sess, node, now) {
  if (!sess || !node) return null
  const open = node.started_at != null && node.ended_at == null
  let plan = null
  const p = planOf2(sess, node)
  if (p) {
    let start = node.first_started_at
    for (const it of p.items) if (it.first_started_at != null && (start == null || it.first_started_at < start)) start = it.first_started_at
    const end = planEndAt2(sess, node, p)
    if (start != null) plan = { started_at: start, ended_at: end, took: end != null && end >= start ? end - start : null }
  }
  if (node.first_started_at == null && !node.attempts && !plan) return null
  const running = open && Number.isFinite(now) ? Math.max(0, now - node.started_at) : null
  const text = plan && plan.took != null ? `took ${fmtTook(plan.took)}`
    : node.took != null ? `took ${fmtTook(node.took)}${node.attempts > 1 ? ` (${fmtTook(node.took_total)} over ${node.attempts} runs)` : ''}`
      : running != null ? `running ${fmtTook(running)}` : null
  return { started_at: node.started_at, ended_at: node.ended_at, took: node.took, took_total: node.took_total, attempts: node.attempts, ...(running != null ? { running_ms: running } : {}), ...(plan ? { plan } : {}), text }
}
/**
 * A test-run's ONE bar (Q56): its tests passed (green) vs failed (red) vs total — { passed, failed, total, pct_passed,
 * pct_failed, tooltip ("2 passed · 1 failed · 1 to go of 4 · 27 checks (2 failed)"), counts (testCounts2) } — or null
 * while it holds no test. The rest of the bar (skipped, running, to go) is neither green nor red.
 */
export function testBar2(sess, node) {
  const c = testCounts2(sess, node)
  if (!c) return null
  return { passed: c.passed, failed: c.failed, total: c.tests, pct_passed: progressPct({ done: c.passed, total: c.tests }), pct_failed: progressPct({ done: c.failed, total: c.tests }),
    tooltip: c.text, counts: c }
}

// ---------------------------------------------------------------------------------------------------------------
// 2d: test runs (§1.7 test-run / test-result, §3.8's buckets)

/**
 * A test-run's ITEMS (NODE_TYPES `items: 'tree'`): every plan item and question below it, reached through its BUCKETS —
 * the contexts that hold them (Pending / In progress / Passed / Failed, a nested test-run) — never through an agent (its
 * work is its own) or a group (a group adds nothing to a rollup). An item's own children are not walked. In sibling order.
 * @param {any} sess @param {any} node @returns {any[]}
 */
export function runItems2(sess, node) {
  const out = []
  const walk = n => { for (const c of childrenOf2(sess, n)) { if (countsAs(c) === 'item') out.push(c); else if (c.kind === 'context' && countsAs(c) === 'bar') walk(c) } }
  walk(node)
  return out
}
/**
 * One test's OUTCOME: 'pass' | 'fail' | 'skip' | 'running' | 'pending' (null for a node that is not a test). Its latest
 * test-result's `result` while the node is still in the state that report left it in; else (a later dashboard tick or
 * report changed the state — the latest word wins — or it has no result) its STATE: done → pass, failed → fail, skipped /
 * abandoned → skip, running / blocked → running, anything else (todo, idle) → pending.
 */
export function testOutcome2(node) {
  if (!node) return null
  const s = stateOf(node)
  if (node.test && node.test.result && node.test.state === s) return node.test.result
  return STATE_OUTCOME[s] || (LIVE.has(s) ? 'running' : 'pending')
}
/**
 * A test-run's COUNTS (its row's tests bar and tooltip, testBar2 — §1.7 `show: 'tests'`; any node can be asked): its TESTS are its items
 * (runItems2) plus every other context below it, through its buckets, that holds a test-result (`test`) — the run node's
 * own result is not one of them. Per test its outcome (testOutcome2); `checks` / `failed_checks` / `duration_ms` add up the
 * tests' latest test-results. "History follows the node": a test moved out of the run no longer counts, and a test started
 * again (todo / running) has dropped its old result. → null when it holds no test.
 * @returns {null | { tests, passed, failed, skipped, running, pending, checks, failed_checks, duration_ms, text }}
 */
export function testCounts2(sess, node) {
  if (!sess || !node) return null
  const tests = []
  const walk = n => {
    for (const c of childrenOf2(sess, n)) {
      if (countsAs(c) === 'item') { if (!isQuestion2(c)) tests.push(c) }   // a question counts in the bar, but it is not a test
      else if (c.kind !== 'context' || countsAs(c) === 'none') continue
      else if (c.test && c.type !== 'test-run') tests.push(c)
      else walk(c)
    }
  }
  walk(node)
  if (!tests.length) return null
  const r = { tests: tests.length, passed: 0, failed: 0, skipped: 0, running: 0, pending: 0, checks: 0, failed_checks: 0, duration_ms: 0, text: '' }
  const key = { pass: 'passed', fail: 'failed', skip: 'skipped', running: 'running', pending: 'pending' }
  for (const c of tests) {
    r[key[testOutcome2(c)]]++
    if (c.test) { r.checks += c.test.checks || 0; r.failed_checks += c.test.failed || 0; r.duration_ms += c.test.duration || 0 }
  }
  const open = r.running + r.pending
  r.text = [`${r.passed} passed`, `${r.failed} failed`, r.skipped && `${r.skipped} skipped`, open && `${open} to go`].filter(Boolean).join(' · ') + ` of ${r.tests}` +
    (r.checks ? ` · ${r.checks} check${r.checks === 1 ? '' : 's'}${r.failed_checks ? ` (${r.failed_checks} failed)` : ''}` : '')
  return r
}

// ---------------------------------------------------------------------------------------------------------------
// 2d: the context-aware MENU (#92) — NODE_TYPES `menu`, filtered by WHEN2

/** The `when` predicates of the menu entries (sess, node, o = { now, staleMin }) — each mirrors applyAction2's own check. */
const WHEN2 = Object.freeze({
  'item-not-done': (s, n) => !!n.plan && stateOf(n) !== 'done',
  'item-not-skipped': (s, n) => !!n.plan && stateOf(n) !== 'skipped',
  'item-not-todo': (s, n) => !!n.plan && stateOf(n) !== 'todo',
  'context-not-abandoned': (s, n) => n.kind === 'context' && !(n.current && n.current.state === 'abandoned'),
  'plan-open': (s, n) => { const p = planOf2(s, n); return !!p && planEndAt2(s, n, p) == null },
  'plan-ended': (s, n) => { const p = planOf2(s, n); return !!p && planEndAt2(s, n, p) != null && p.allDoneAt == null },
  'holds-open-plan': (s, n) => (n.kind !== 'context' || !!planOf2(s, n)) && heldPlans2(s, n).length > 0,
  'quiet-unfinished': (s, n, o) => !n.finished_at && quiet2(s, n, o.now, o.staleMin),
  'dismissable': (s, n, o) => subtree2(s, n).every(x => (x === n ? quiet2(s, x, o.now, o.staleMin) : x.kind !== 'agent' || x.implicit || quiet2(s, x, o.now, o.staleMin))) && !openPlanIds(s).has(n.id),
  'not-root': (s, n) => n.parent != null,
  'not-item': (s, n) => !n.plan,
  'open-question': (s, n) => isOpenQuestion2(n),
  'answered-question': (s, n) => !!(isQuestion2(n) && n.current && n.current.question && n.current.question.status === 'answered'),
})
/**
 * The context-aware MENU of a node NOW (#92, folded into the type registry): its type's `menu` entries whose `when` holds —
 * [{ action, label, group }] in display order; each `action` is an applyAction2 action. A plan item's item actions come with
 * its type's menu (a plan item is an attribute, not a type). o = { now, staleMin } (the dashboard's slider; for finish /
 * dismiss: is the agent quiet).
 * @param {any} sess @param {any} node @param {{ now?: number, staleMin?: number }} [o]
 */
export function menuOf2(sess, node, o = {}) {
  if (!sess || !node) return []
  const ctx = { now: Number.isFinite(o.now) ? o.now : Date.now(), staleMin: Number.isFinite(o.staleMin) ? o.staleMin : 15 }
  return typeOf(node).menu.filter(m => !m.when || WHEN2[m.when](sess, node, ctx)).map(m => ({ action: m.action, label: m.label, group: m.group }))
}

/**
 * A GROUP's count (§5.7), where its bar would be (a type whose `show` is 'count') — null for any other node, or a group
 * with nothing to count.
 * Its visible children, minus ABANDONED ones (withdrawn / expired questions too) and the viewer's HIDDEN rows (`hidden`: a
 * Set of ids, §5.6): done = done, skipped = skipped, everything else open. text = "4 items" while none is resolved, else
 * the non-zero parts of "3 open · 1 done · 1 skipped".
 * @param {any} sess @param {any} node @param {{ hidden?: Set<string> }} [o]
 * @returns {null | { n: number, open: number, done: number, skipped: number, text: string }}
 */
export function groupCount2(sess, node, o = {}) {
  if (!sess || !node || typeOf(node).show !== 'count') return null
  let open = 0, done = 0, skipped = 0
  for (const c of childrenOf2(sess, node)) {
    if (o.hidden && o.hidden.has(c.id)) continue
    const s = stateOf(c)
    if (s === 'abandoned') continue
    if (s === 'done') done++; else if (s === 'skipped') skipped++; else open++
  }
  const n = open + done + skipped
  if (!n) return null
  const text = !done && !skipped ? `${n} item${n === 1 ? '' : 's'}` : [open && `${open} open`, done && `${done} done`, skipped && `${skipped} skipped`].filter(Boolean).join(' · ')
  return { n, open, done, skipped, text }
}

/**
 * Change a context's TYPE (§5.7 — the dashboard's Show as group / Show as plan; 2c's action calls this): one `type` node
 * record + a logged `event` entry ("shown as a group by robin via dashboard (…)"); its children keep their states. Only
 * between the SETTABLE context types (context | plan | group | test-run); a question stays a question, an agent / the session have
 * theirs (`bad-type`); a plan item can't become a type that adds nothing to its plan (a group: `bad-type`); a reserved type
 * → `type-reserved`; the same type again → `no-change`.
 * @param {any} state @param {{ session: string, project?: string, user?: string, realm?: string }} ident @param {string} id
 * @param {string} type @param {number} now @param {{ by?: any, act?: string }} [opts]
 */
export function setType2(state, ident, id, type, now, opts = {}) {
  const sess = getSession2(state, ident)
  if (!sess) return bad('unknown-session', 'no such session on this host')
  const n = sess.nodes.get(id)
  if (!n || n.merged_into) return bad('unknown-node', `${id} is not on the board`)
  const where = pathOf(sess, n) || sess.ident.session
  if (n.kind !== 'context') return bad('bad-type', `"${where}" is ${n.kind === 'agent' ? 'an agent' : 'the session'} — only a context's type changes`)
  if (n.type === 'question') return bad('bad-type', `"${where}" is a question — it stays one`)
  const p = parseContextType(type)
  if (!p.ok) return p
  if (n.plan && typeOf({ type: p.type }).counts_as === 'none') return bad('bad-type', `"${where}" is a plan item — it counts in its plan, so it can't be a ${p.type}`)
  if (n.type === p.type) return bad('no-change', `"${where}" is already a ${p.type}`)
  const t = newTx(state, sess, now, { by: opts.by, act: opts.act || `show_as_${p.type}` })
  fset(t, n, 'type', p.type)
  record(t, 'type', n, { type: p.type })
  entryStub(t, n, 'type', `shown as a ${p.type}`)
  return { ok: true, node: nodeView(sess, n), records: t.records, entries: t.entries, writes: t.writes }
}

// ---------------------------------------------------------------------------------------------------------------
// 2b: staleness (an open question and a plan item never go stale)

/**
 * When `node` goes stale (6a / 6b / #90 on ids): a plan item and an OPEN question never do; a context shows its owner's
 * (the nearest agent at or above, not the root's when the root is implicit) only while it has a live line of its own; an
 * agent / the root: last_activity + its stale_after, else staleMin minutes — null when finished, implicit or not live.
 * @param {any} sess @param {any} node @param {number} staleMin
 */
export function staleAt2(sess, node, staleMin) {
  if (!node || node.plan || isOpenQuestion2(node)) return null
  if (node.kind === 'context') return node.current && LIVE.has(node.current.state) ? staleAt2(sess, ownerOf2(sess, node), staleMin) : null
  if (node.finished_at || node.implicit || !LIVE.has(stateOf(node))) return null
  const win = node.stale_after_ms > 0 ? node.stale_after_ms : (Number.isFinite(staleMin) && staleMin > 0 ? staleMin : 15) * MIN
  return node.last_activity + win
}
/** The state to SHOW: { state, was, stale, stale_at } — a plan item / an open question shows its own state only. */
export function effectiveState2(sess, node, now, staleMin) {
  const was = stateOf(node)
  if (node.plan || isOpenQuestion2(node)) return { state: was, was, stale: false, stale_at: null }
  const at = staleAt2(sess, node, staleMin)
  const stale = at !== null && now > at
  return { state: stale ? 'stale' : was, was, stale, stale_at: at }
}

// ---------------------------------------------------------------------------------------------------------------
// 2b: questions (#85 / #90 on ids)

/**
 * Where a question goes (#85): the addressed node itself when it is a question already (a CLOSED one starts a new question
 * there; an OPEN one → question-open) or is a plain `context` that is line-less, childless and not a plan item (it BECOMES
 * a question: a `type` record); otherwise a new child of type question keyed `?<n>` in the ASKER's scope (n = 1 + the
 * highest `?<digits>` key that scope holds, live or ghost, so the key names one node for good), labelled `?<n>` by the bridge.
 */
function askNode(t, node, scope) {
  const { sess } = t
  const self = isQuestion2(node) || (node.kind === 'context' && node.type === 'context' && !node.current && !node.plan && !childrenOf2(sess, node).length)
  if (self) {
    if (isOpenQuestion2(node)) return bad('question-open', `"${pathOf(sess, node)}" is still waiting for an answer — withdraw it first (state withdrawn), or ask on another node`)
    if (node.type !== 'question') { fset(t, node, 'type', 'question'); record(t, 'type', node, { type: 'question' }) }   // it BECOMES a question
    return node
  }
  let n = 0
  for (const k of sess.scope.keys()) if (k.startsWith(scope.id + '\n')) { const m = /^\?(\d{1,9})$/.exec(k.slice(scope.id.length + 1)); if (m) n = Math.max(n, Number(m[1])) }
  return createNode(t, { creator: scope, key: `?${n + 1}`, kind: 'context', label: `?${n + 1}`, parent: node, type: 'question' })
}
const findQuestion = (state, ident, id) => {
  const sess = getSession2(state, ident)
  if (!sess) return { err: bad('unknown-session', 'no such session on this host') }
  const node = sess.nodes.get(id)
  if (!node || node.merged_into) return { err: bad('unknown-node', `${id} is not on the board`) }
  if (!isQuestion2(node)) return { err: bad('not-a-question', `"${pathOf(sess, node) || sess.ident.session}" is not a question`) }
  return { sess, node, q: node.current.question }
}
const askerOf = (sess, node) => { const o = ownerOf2(sess, node); return o.parent == null ? null : nodeView(sess, o) }

/**
 * ANSWER an open question — or, with opts.change, CHANGE the answer of an answered one (#85 / #90; the dashboard's answer /
 * change_answer, wired by 2c): args.choice (one of its choices) and / or args.text (when free text is allowed). The line
 * keeps its id, text, details and data; status answered (state done), `by` / `at`, a change adds `revised` + `previous`; the
 * entry names the answer ("answered by robin via dashboard (…): "Postgres"") and carries details of its own. A system
 * message (no activity). → { ok, node, question, answer, previous?, entry_id, agent, records, entries, writes }
 * @param {any} state @param {any} ident @param {string} id @param {{ choice?: string, text?: string }} args @param {number} now
 * @param {{ by: any, change?: boolean }} opts
 */
export function answerQuestion2(state, ident, id, args, now, opts = /** @type {any} */ ({})) {
  const by = normBy(opts.by)
  if (!by || typeof by === 'string') return bad('bad-by', 'an answer needs its author ({ kind:"dashboard", user, host })')
  const f = findQuestion(state, ident, id)
  if (f.err) return f.err
  const { sess, node, q } = f, chg = !!opts.change, a = args && typeof args === 'object' ? args : {}
  if (!chg && q.status !== 'asked') return bad('question-closed', `the question "${pathOf(sess, node)}" is already ${q.status}${q.status === 'answered' ? ' — change its answer instead' : ''}`)
  if (chg && q.status !== 'answered') return bad(q.status === 'asked' ? 'question-open' : 'question-closed', q.status === 'asked' ? `the question "${pathOf(sess, node)}" has no answer yet — answer it` : `the question "${pathOf(sess, node)}" is ${q.status} — only an answered question's answer can be changed`)
  const ans = /** @type {any} */ ({})
  if (a.choice != null && String(a.choice).trim()) {
    if (!q.choices.length) return bad('bad-args', 'this question has no choices — answer it with text')
    const hit = q.choices.find(c => lc(c) === lc(normText(String(a.choice))))
    if (!hit) return bad('bad-choice', `"${cpSlice(String(a.choice), 60)}" is not one of its choices: ${q.choices.join(' | ')}`)
    ans.choice = hit
  }
  const tx = answerTextOf(a.text)
  if (tx) {
    if (!q.free) return bad('bad-args', 'this question takes one of its choices, not free text')
    if (cpLen(tx) > QUESTION_LIMITS.answer) return bad('answer-too-long', `an answer is at most ${QUESTION_LIMITS.answer} characters (got ${cpLen(tx)})`)
    ans.text = tx
  }
  if (!ans.choice && !ans.text) return bad('bad-args', q.choices.length ? `answer with a choice (${q.choices.join(' | ')})${q.free ? ' and / or text' : ''}` : 'answer with text')
  if (chg && sameAnswer(ans, q.answer)) return bad('no-change', `that is already the answer of "${pathOf(sess, node)}"`)
  const action = chg ? 'change_answer' : 'answer'
  const t = newTx(state, sess, now, { by, act: action })
  const prev = chg ? { answer: q.answer, ...(q.by ? { by: q.by } : {}), ...(q.at ? { at: q.at } : {}) } : null
  const qa = { ...q, status: 'answered', answer: ans, by, at: now, ...(chg ? { revised: (q.revised || 0) + 1, previous: prev } : {}) }
  const r = applyReport(t, node, { state: QSTATE.answered, text: null, line: false, log: true, stale_after_ms: null }, { question: qa, entryText: answerEntryText(chg ? 'answer changed' : 'answered', by, ans), cascade: false,
    mtype: 'answer', mfields: { ...ans, ...(chg ? { revised: qa.revised } : {}) } })   // an answer is an `answer` entry; the node's state (done) drives plans and bars
  if (r.ok === false) { rollback(t); return r }
  const qv = /** @type {any} */ (questionView(node.current.question))
  return { ok: true, action, node: nodeView(sess, node), question: qv, answer: ans, ...(chg ? { previous: qv.previous || null } : {}), entry_id: r.entry ? r.entry.id : null,
    agent: askerOf(sess, node), records: t.records, entries: t.entries, writes: t.writes }
}

/**
 * WITHDRAW an open question from the dashboard (#85; 2c's action): status withdrawn (state abandoned), attributed; the line
 * keeps the question. (The ASKER withdraws its own with a report: state "withdrawn".)
 * @param {any} state @param {any} ident @param {string} id @param {number} now @param {{ by: any }} opts
 */
export function withdrawQuestion2(state, ident, id, now, opts = /** @type {any} */ ({})) {
  const by = normBy(opts.by)
  if (!by || typeof by === 'string') return bad('bad-by', 'a withdrawal needs its author ({ kind:"dashboard", user, host })')
  const f = findQuestion(state, ident, id)
  if (f.err) return f.err
  const { sess, node, q } = f
  if (q.status !== 'asked') return bad('question-closed', `the question "${pathOf(sess, node)}" is already ${q.status}`)
  const t = newTx(state, sess, now, { by, act: 'withdraw' })
  const r = applyReport(t, node, { state: QSTATE.withdrawn, text: null, line: false, log: true, stale_after_ms: null }, { question: { ...q, status: 'withdrawn', by, at: now }, entryText: cut(`withdrawn ${byText(by)}`), cascade: false, mtype: 'withdrawal' })
  if (r.ok === false) { rollback(t); return r }
  return { ok: true, action: 'withdraw', node: nodeView(sess, node), question: questionView(node.current.question), entry_id: r.entry ? r.entry.id : null, agent: askerOf(sess, node),
    records: t.records, entries: t.entries, writes: t.writes }
}

/**
 * EXPIRY (#85): every open question whose expires_at has passed becomes expired, unanswered — a SYSTEM line by the bridge
 * (state abandoned; no activity), logged "expired — nobody answered within <dur>". → { records, entries, writes,
 * expired:[{ action:"expire", ident, id, key, path, text, question, entry_id, agent }] }
 * @param {any} state @param {number} now
 */
export function expireQuestions2(state, now) {
  const out = { records: [], entries: [], writes: [], expired: [] }
  for (const sess of state.sessions.values()) {
    for (const n of [...sess.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!sess.nodes.has(n.id) || !isOpenQuestion2(n)) continue
      const q = n.current.question
      if (!(q.expires_at > 0) || now < q.expires_at) continue
      const t = newTx(state, sess, now, { by: 'bridge' })
      const dur = q.asked_at ? ` within ${fmtEta(q.expires_at - q.asked_at).replace(/^~/, '')}` : ''
      const r = applyReport(t, n, { state: QSTATE.expired, text: null, line: false, log: true, stale_after_ms: null }, { question: { ...q, status: 'expired', by: 'bridge', at: now }, entryText: `expired — nobody answered${dur}`, cascade: false,
        mtype: 'expiry', mfields: q.asked_at ? { after_ms: q.expires_at - q.asked_at } : null })
      if (r.ok === false) { rollback(t); continue }
      out.records.push(...t.records); out.entries.push(...t.entries); out.writes.push(...t.writes)
      out.expired.push({ action: 'expire', ident: { ...sess.ident }, id: n.id, key: n.key, path: pathOf(sess, n), text: n.current.text, question: questionView(n.current.question), entry_id: r.entry ? r.entry.id : null, agent: askerOf(sess, n) })
    }
  }
  return out
}
/** When the next open question expires (ms), or null — the gateway's expiry timer. @param {any} state */
export function nextQuestionExpiry2(state) {
  let at = null
  for (const s of state.sessions.values()) for (const n of s.nodes.values()) if (isOpenQuestion2(n) && n.current.question.expires_at > 0 && (at === null || n.current.question.expires_at < at)) at = n.current.question.expires_at
  return at
}
/**
 * A WAITER's view of a question (the script's --wait): { outcome ("open" while asked, else its status; "gone" when it left
 * the board or is no longer a question), status, id, key, path, question, choices, free, answer?, by?, at?, revised?,
 * previous?, asked_at, expires_at?, entry_id }.
 * @param {any} state @param {any} ident @param {string} id
 */
export function questionOutcome2(state, ident, id) {
  const sess = getSession2(state, ident), node = sess ? sess.nodes.get(id) : null
  if (!node || !isQuestion2(node)) return { outcome: 'gone', id }
  const q = /** @type {any} */ (questionView(node.current.question))
  return { outcome: q.status === 'asked' ? 'open' : q.status, status: q.status, id, key: node.key, path: pathOf(sess, node), question: node.current.text, choices: q.choices, free: q.free,
    ...(q.answer ? { answer: q.answer } : {}), ...(q.by ? { by: q.by } : {}), ...(q.at ? { at: q.at } : {}), ...(q.revised ? { revised: q.revised, previous: q.previous || null } : {}),
    asked_at: q.asked_at, ...(q.expires_at ? { expires_at: q.expires_at } : {}), entry_id: node.current.id }
}

// ---------------------------------------------------------------------------------------------------------------
// the call

/**
 * Validate a call (the 2.0 `log` tool's fields, §4.2): the structure (2a) — agent, key | id | path, label, under, move |
 * move_to | merge | unmerge, rename, transient ("30s" = a grace, Q44), keep — plus 2b's context_type (a NEW context's type,
 * NODE_TYPES), plan and the REPORT (parseReport: text / state / progress / eta / stale_after / details / data / log /
 * message_type + fields, or ask … / state withdrawn). A refused
 * relative move_to that could be resolved is kept (`move_to_refused`) so the call answers its `suggest` (Q46). 2c: a
 * POSITION (before / after / before_id / after_id, or position "first" | "last") → q.pos = { kind, ref? | ref_id? } — not
 * with move_to / merge / unmerge / ask. o = { now, tzOffsetMin } for an eta / expires.
 * @returns {any} { ok:true, q } or a refusal
 */
export function parseCall(input, o = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('bad-input', 'expected an object { agent?, key? | id? | path?, label?, under?, text?, state?, plan?, move? | move_to?, rename?, merge?, unmerge?, transient?, keep?, context_type?, message_type?, fields?, before? | after? | position? }')
  const q = /** @type {any} */ ({ warnings: [] })
  if (has(input, 'agent')) {
    if (typeof input.agent !== 'string') return bad('bad-agent', 'agent must be a key chain like "spec-88" or "spec-88/research"')
    const steps = input.agent.trim().replace(/^\/+|\/+$/g, '').split('/').map(s => validKey(s))
    const badStep = steps.find(s => !s.ok)
    if (badStep) return bad('bad-agent', `agent "${input.agent}": ${badStep.what}`)
    q.agent = steps.map(s => s.key)
  }
  const addr = ['key', 'id', 'path'].filter(k => has(input, k))
  if (addr.length > 1) return bad('bad-address', `give one of --key / --id / --path, not ${addr.join(' + ')}`)
  if (has(input, 'key')) { const k = validKey(input.key, { question: true }); if (!k.ok) return k; q.key = k.key }
  if (has(input, 'id')) { if (typeof input.id !== 'string' || !ID_RE.test(input.id)) return bad('bad-id', 'id must be a node id (16 chars of a-z 2-7)'); q.id = input.id }
  if (has(input, 'path')) { const p = parsePath2(input.path); if (!p.ok) return p; q.segs = p.segs }
  if (q.segs && (has(input, 'under') || has(input, 'under_id'))) return bad('bad-address', '--under places a NEW --key / --agent node; a --path names its own place')
  for (const f of ['label', 'rename']) if (has(input, f)) { const l = normLabel(input[f]); if (!l.ok) return bad(l.code, `${f}: ${l.what}`); q[f] = l.label }
  for (const f of ['under', 'move', 'merge']) {
    if (has(input, f) && has(input, f + '_id')) return bad('bad-input', `give ${f} or ${f}_id, not both`)
    if (has(input, f)) { if (typeof input[f] !== 'string') return bad('bad-ref', `${f} must be a reference: a key, chain:key or a path`); q[f] = input[f] }
    if (has(input, f + '_id')) q[f + '_id'] = input[f + '_id']
  }
  if (has(input, 'move_to')) { const m = parseMoveTo(input.move_to); if (m.ok) q.move_to = m; else if (m.rel) q.move_to_refused = m; else return m }
  q.unmerge = input.unmerge === true
  q.keep = input.keep === true
  if (has(input, 'transient')) {
    if (input.transient === true) q.transient = { grace_ms: null }
    else if (typeof input.transient === 'string') {
      const ms = parseDuration(input.transient)
      if (!Number.isFinite(ms) || ms <= 0 || ms > LIMITS2.graceMaxMs || /^\s*[\d.]+\s*$/.test(input.transient)) return bad('bad-input', `transient "${input.transient}": give a grace period like "30s", "2m" (≤ 24h), or true for none`)
      q.transient = { grace_ms: ms }
    } else return bad('bad-input', 'transient must be true or a grace period like "30s"')
  }
  // 2c: a POSITION (§4.1 --before / --after <ref> | --first / --last; the tool's before / after / before_id / after_id /
  // position "first" | "last") — one of them
  for (const f of ['before', 'after']) if (has(input, f) && has(input, f + '_id')) return bad('bad-input', `give ${f} or ${f}_id, not both`)
  const pk = ['before', 'after', 'position'].filter(k => has(input, k) || has(input, k + '_id'))
  if (pk.length > 1) return bad('bad-position', `give ONE of before / after / position (got ${pk.join(' + ')})`)
  if (pk[0] === 'position') {
    const p = typeof input.position === 'string' ? lc(input.position.trim()) : ''
    if (p !== 'first' && p !== 'last') return bad('bad-position', 'position must be "first" or "last" (or give before / after a sibling)')
    q.pos = { kind: p }
  } else if (pk.length) {
    const f = pk[0]
    if (has(input, f + '_id')) { if (typeof input[f + '_id'] !== 'string' || !ID_RE.test(input[f + '_id'])) return bad('bad-ref', `${f}_id must be a node id (16 chars of a-z 2-7)`); q.pos = { kind: f, ref_id: input[f + '_id'] } }
    else { if (typeof input[f] !== 'string') return bad('bad-ref', `${f} must be a reference to a sibling: a key, chain:key or a label`); q.pos = { kind: f, ref: input[f] } }
  }
  const verbs = ['move', 'move_to', 'merge', 'unmerge'].filter(v => v === 'move' ? q.move != null || q.move_id != null : v === 'merge' ? q.merge != null || q.merge_id != null : v === 'unmerge' ? q.unmerge : !!(q.move_to || q.move_to_refused))
  if (verbs.length > 1) return bad('bad-input', `one structural change per call: ${verbs.join(' + ')} (--move-to with --move: one destination per call)`)
  if (q.rename != null && (q.merge != null || q.merge_id != null || q.unmerge || q.move_to || q.move_to_refused)) return bad('bad-input', '--rename goes alone or with --move (one checked change)')
  if (q.keep && q.transient) return bad('bad-input', '--keep with --transient: pick one')
  if (q.pos && (q.move_to || q.move_to_refused || q.merge != null || q.merge_id != null || q.unmerge)) return bad('bad-position', 'a position goes with a create, --item, --move or alone (a reorder) — --move-to arrives last, and a merge / unmerge places nothing')
  const rp = parseReport(input, o, q.warnings)
  if (!rp.ok) return rp
  q.report = rp.rep
  if (input.plan !== undefined && input.plan !== null) { const pl = parsePlan2(input.plan, q.warnings); if (!pl.ok) return pl; q.plan = pl.items }
  if (q.report && q.report.ask && (verbs.length || q.rename != null || q.plan || q.pos)) return bad('bad-ask', 'a question goes alone: no move / move_to / merge / unmerge / rename / plan / position with ask')
  if (has(input, 'context_type')) { const ct = parseContextType(input.context_type, { ask: !!(q.report && q.report.ask) }); if (!ct.ok) return ct; q.context_type = ct.type }
  q.given = REPORT_FIELDS.filter(f => input[f] !== undefined && input[f] !== null && !(f === 'text' && input.text === ''))   // checked against the target's type (NODE_TYPES fields)
  return { ok: true, q }
}

/**
 * Resolve the agent chain (§1.5): each step a LIVE agent in its creator's scope. The LAST step, when missing, is CREATED —
 * only by a call that TARGETS the agent (no key / id / path), with its label (`label-required`; under `under` or its
 * creator; a ghost agent comes back as a new run). A missing earlier step, or a missing agent on a call aimed elsewhere →
 * `unknown-agent`; a step that names a context → `not-an-agent`.
 */
function resolveAgent(t, steps, q, targetsAgent) {
  const { sess } = t
  let creator = rootOf(sess), created = false
  for (let i = 0; i < steps.length; i++) {
    const chain = steps.slice(0, i + 1).join('/')
    const id = sess.scope.get(scopeKey(creator.id, steps[i])), live = id && sess.nodes.get(id), ghost = id && !live ? sess.ghosts.get(id) : null
    if (live) { if (live.kind !== 'agent') return bad('not-an-agent', `--agent ${chain}: "${steps[i]}" is a context (${pathOf(sess, live)}), not an agent`); creator = live; continue }
    if (ghost && ghost.kind !== 'agent') return bad('not-an-agent', `--agent ${chain}: "${steps[i]}" was a context, not an agent`)
    if (i < steps.length - 1 || !targetsAgent) return bad('unknown-agent', `--agent ${chain} is not on the board — start it first: --agent ${chain} --label "…" --guide agent`)
    if (!q.label && !ghost) return bad('label-required', `creating the agent ${chain} needs its name: --label "…" (a label never defaults to the key)`)
    let parent = creator
    if (q.under != null || q.under_id != null) { const r = resolveRef(t, q.under, q.under_id, creator, 'under'); if (r.ok === false) return r; parent = r.node }
    if (q.transient) return bad('bad-input', 'only a context can be transient, not an agent')
    const n = ghost ? createNode(t, { ghost, creator, key: steps[i], kind: 'agent', label: q.label || ghost.label, parent })
      : createNode(t, { creator, key: steps[i], kind: 'agent', label: q.label, parent })
    if (n.ok === false) return n
    creator = n; created = true
  }
  return { agent: creator, created }
}

/** `exists` (§3.5): a create's location / label / transient flag / context type given for a node that already exists is ignored. */
function existsCheck(t, node, q, scopeNode) {
  const ignored = []
  if (q.label != null && labelKey(q.label) !== labelKey(node.label) && !(node.asked && labelKey(q.label) === labelKey(node.asked))) ignored.push('label')
  if (q.under != null || q.under_id != null) {
    const r = resolveRef(t, q.under, q.under_id, scopeNode, 'under')
    if (r.ok === false || r.node.id !== node.parent) ignored.push('under')
  }
  if (q.transient && !q.move_to) ignored.push('transient')
  if (q.context_type && q.context_type !== node.type && !(q.context_type === 'question' && q.report && q.report.ask)) ignored.push('context_type')
  if (q.pos && !q.plan && q.move == null && q.move_id == null && (q.under != null || q.under_id != null)) ignored.push('position')   // 2c: a create-shaped retry never reorders (H2)
  if (ignored.length) warn(t, { code: 'exists', ignored, what: `${node.scope}:${node.key} exists — ${ignored.map(f => '--' + f.replace('_', '-')).join(', ')} ignored (location, label and type are set only at creation; use --move / --rename)` })
}

/**
 * Apply one CALL (2a's structure + 2b's report): resolve the session, the agent (§1.5) and the TARGET (§3: key → id → path
 * → the agent → the session root), creating what the rules create (a new context gets its --context-type); then — on the
 * target — the REPORT (§4.0; an ask goes to the question node, askNode), the PLAN's items, and the structural verb
 * (--move [+ --rename], --rename, --move-to, --merge; --unmerge goes BEFORE the report, so the report lands on the
 * unmerged node), then --keep. ALL-OR-NOTHING: a refusal undoes every change of the call and writes nothing.
 * @param {any} state  createModel()
 * @param {{ session: string, project?: string, user?: string, realm?: string }} ident  the reporting session
 * @param {any} input  the 2.0 `log` tool's fields (parseCall)
 * @param {number} now
 * @param {{ by?: any, act?: string, tzOffsetMin?: number }} [opts]  by / act (6d) when a dashboard (or the bridge) did it: a
 *   SYSTEM call — attributed, refreshing no activity
 * @returns {any} { ok:true, id (the ENTRY id, H10), ts, node:{ …, created }, created, agent?, state, current (the line
 *   changed), line (its text was set), logged, stale_at, question?, plan?, cascade?, moved? / merged? / unmerged?,
 *   placed? { where, rank? } (2c: a position), evicted? [{ id, key, label, path }] (2c: the limits), records, entries,
 *   writes, warnings } or a refusal
 */
export function applyCall(state, ident, input, now, opts = {}) {
  if (!state || !(state.sessions instanceof Map)) return bad('bad-state-object', 'pass a createModel() state')
  if (!Number.isFinite(now)) return bad('bad-now', 'now must be a ms epoch')
  const pc = parseCall(input, { now, tzOffsetMin: opts.tzOffsetMin })
  if (!pc.ok) return pc
  const q = pc.q
  const fresh = !getSession2(state, ident)
  const sess = getSession2(state, ident, now)
  if (!sess) return bad('bad-session', 'the reporting session needs a name')
  const t = newTx(state, sess, now, opts)
  const r = run(t, q)
  if (r.ok === false) { rollback(t); if (fresh) state.sessions.delete(sess.key); return r }
  // 2c: the per-session NODE LIMITS — a call that created nodes past them evicts the oldest finished agents / ended plans
  // (never what this call touched or an ancestor of it), else it is refused as a whole
  if (t.records.some(x => x.op === 'create')) {
    const ev = enforceLimits(t, [r.node && r.node.id, r.agent && r.agent.id, r.moved && r.moved.parent_id, ...t.records.filter(x => x.op === 'create').map(x => x.n)])
    if (ev.ok === false) { rollback(t); if (fresh) state.sessions.delete(sess.key); return ev }
    if (ev.length) r.evicted = ev
  }
  if (t.deepest > LIMITS2.depthWarn) warn(t, { code: 'deep-tree', depth: t.deepest, what: `the tree is ${t.deepest} deep here (over ${LIMITS2.depthWarn}; the limit is ${LIMITS2.depthMax})` })
  return { ok: true, ...r, records: t.records, entries: t.entries, writes: t.writes, warnings: [...q.warnings, ...t.warnings] }
}

function run(t, q) {
  const { sess } = t
  let scopeNode = rootOf(sess), agentCreated = false
  const targetsAgent = q.key == null && q.id == null && !q.segs
  if (q.context_type && targetsAgent) return bad('bad-input', 'only a context takes a --context-type (an agent is type agent): give the --key / --path of the context it creates')
  if (q.agent) {
    const a = resolveAgent(t, q.agent, q, targetsAgent)
    if (a.ok === false) return a
    scopeNode = a.agent; agentCreated = a.created
  }
  let node, created = false
  const grace = q.transient ? q.transient.grace_ms : null
  const asks = !!(q.report && q.report.ask)
  const newType = q.context_type || (asks ? 'question' : null)   // a context this call creates and asks on IS the question
  if (q.key != null) {
    const id = sess.scope.get(scopeKey(scopeNode.id, q.key)), live = id && sess.nodes.get(id), ghost = id && !live ? sess.ghosts.get(id) : null
    if (live) { node = q.unmerge ? live : redirect(t, live); if (!q.unmerge) existsCheck(t, live, q, scopeNode) }   // existsCheck ignores --transient with --move-to (it is for the destinations)
    else {
      if (q.key.startsWith('?')) return bad('unknown-node', `no question ${q.key} in your scope (question keys are made by the bridge)`)
      if (!q.label && !ghost) return bad('label-required', `creating ${scopeNode.chain}:${q.key} needs a label: --label "…" (a label never defaults to the key)`)
      let parent = scopeNode
      if (q.under != null || q.under_id != null) { const r = resolveRef(t, q.under, q.under_id, scopeNode, 'under'); if (r.ok === false) return r; parent = r.node }
      if (q.transient && ghost && ghost.kind !== 'context') return bad('bad-input', 'only a context can be transient, not an agent')
      const n = createNode(t, ghost ? { ghost, creator: scopeNode, key: q.key, kind: 'context', label: q.label || ghost.label, parent, transient: !!q.transient, grace_ms: grace, type: newType }
        : { creator: scopeNode, key: q.key, kind: 'context', label: q.label, parent, transient: !!q.transient, grace_ms: grace, type: newType })
      if (n.ok === false) return n
      node = n; created = true
    }
  } else if (q.id != null) {
    const r = byId(t, q.id, 'id')
    if (r.ok === false) return r
    node = q.unmerge ? r.node : redirect(t, r.node)
    if (!q.unmerge) existsCheck(t, r.node, q, scopeNode)
  } else if (q.segs) {
    const w = walkPath(t, scopeNode, q.segs, true, { transient: !!q.transient, grace_ms: grace, type: newType })
    if (w.ok === false) return w
    node = q.unmerge ? w.node : redirect(t, w.node); created = w.created
    if (!created && (q.transient || q.context_type)) existsCheck(t, node, { transient: q.transient, move_to: q.move_to, context_type: q.context_type, report: q.report }, scopeNode)
  } else {
    node = scopeNode; created = agentCreated
    if (q.agent && !agentCreated) existsCheck(t, node, q, sess.nodes.get(node.creator) || rootOf(sess))
    else if (!q.agent && q.transient && !q.move_to) return bad('bad-input', '--transient needs a node the call creates (--key, --path, or with --move-to)')
  }
  // Q46: a refused relative --move-to answers the absolute path it would have resolved to (from the node's parent NOW)
  if (q.move_to_refused) {
    const mr = q.move_to_refused, b = relBase(sess, node, false, mr.rel.up)
    if (b.ok === false) return bad('bad-path', `${mr.what} (${b.what})`)
    const suggest = absPath(sess, b.base, walkRead(sess, b.base, mr.rel.segs).labels)
    return bad('bad-path', `${mr.what} — it resolves now to "${suggest}": retry with move_to "${suggest}"`, { suggest })
  }
  // the TYPE's fields (NODE_TYPES): a group takes no progress (it has no bar), a question no plan …
  const T = typeOf(node), off = (q.given || []).filter(f => !T.fields.includes(f))
  if (off.length) return bad('bad-field', `"${pathOf(sess, node) || sess.ident.session}" is a ${node.type} — it takes no ${off.join(', ')}`)
  const out = /** @type {any} */ ({ node: null, created, id: null, ts: t.now, logged: false, current: false, line: false })
  if (q.unmerge) {
    const m = unmergeNode(t, node, q.label != null ? q.label : null)
    if (m.ok === false) return m
    out.unmerged = m.unmerged
  }
  let rnode = node
  if (q.report) {
    if (asks) { const a = askNode(t, node, scopeNode); if (a.ok === false) return a; rnode = a }
    const r = applyReport(t, rnode, q.report, { caller: scopeNode })
    if (r.ok === false) return r
    Object.assign(out, { id: r.entry ? r.entry.id : null, logged: !!r.entry, current: r.changes, line: r.line })
    if (r.cascade) out.cascade = r.cascade
    if (asks) out.question = questionView(rnode.current.question)
  }
  if (q.plan) { const p = applyPlan2(t, node, q.plan, scopeNode); if (p.ok === false) return p; out.plan = p.items }
  const hasMove = q.move != null || q.move_id != null
  // 2c: a POSITION (§4.1) — with a plan it places the items this call CREATED (a re-plan never moves an item); else it places
  // a NEW target among its siblings, or REORDERS an existing one (a no-op when it is already there). On an existing target
  // a create-shaped call (one giving --under) does not reorder: the position is ignored with `exists` (§3.5, hole H2: a
  // retried create must not undo a dashboard reorder). With --move it says where the node lands (moveNode).
  if (q.pos && !hasMove) {
    if (q.plan) {
      const made = (out.plan || []).filter(i => i.created).map(i => sess.nodes.get(i.id)).filter(Boolean)
      if (!made.length) warn(t, { code: 'position-unused', what: 'no new plan item was made — a re-plan never moves an item (reorder one on its own)' })
      else {
        const pl = placeNew(t, made, node, q.pos, scopeNode)
        if (pl.ok === false) return pl
        for (const i of out.plan) { const n = sess.nodes.get(i.id); if (i.created && n && n.rank) i.rank = n.rank }
        out.placed = pl.placed
      }
    } else if (node.parent == null) return bad('bad-position', 'the session root has no siblings')
    else if (created) { const pl = placeNew(t, [node], sess.nodes.get(node.parent), q.pos, scopeNode); if (pl.ok === false) return pl; out.placed = pl.placed }
    else if (q.under != null || q.under_id != null) { /* ignored: existsCheck warned `exists` (ignored: position) */ }
    else { const pl = reorderNode(t, node, q.pos, scopeNode); if (pl.ok === false) return pl; if (pl.placed) out.placed = pl.placed }
  }
  if (hasMove) {
    const d = resolveRef(t, q.move, q.move_id, scopeNode, 'move')
    if (d.ok === false) return d
    const m = moveNode(t, node, d.node, q.rename != null ? q.rename : null, q.pos || null, scopeNode)
    if (m.ok === false) return m
    if (m.moved) out.moved = m.moved
    if (m.placed) out.placed = m.placed
  } else if (q.rename != null) {
    const e = renameNode(t, node, q.rename); if (e) return e
  } else if (q.move_to) {
    const m = moveToPath(t, node, q.move_to, scopeNode, grace)
    if (m.ok === false) return m
    if (m.moved) out.moved = m.moved
  } else if (q.merge != null || q.merge_id != null) {
    const d = resolveRef(t, q.merge, q.merge_id, scopeNode, 'merge')
    if (d.ok === false) return d
    const m = mergeNode(t, node, d.node)
    if (m.ok === false) return m
    out.merged = m.merged
  }
  if (q.keep) { if (node.kind !== 'context') return bad('bad-input', '--keep applies to a transient context'); keepNode(t, node) }
  out.node = { ...nodeView(sess, rnode), created: rnode === node ? created : true }
  out.state = stateOf(rnode)
  out.stale_at = staleAt2(sess, rnode, t.state.config.stale_after_min)
  if (q.agent) out.agent = nodeView(sess, scopeNode)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// 2c: node limits and EVICTION (6a / 6c on ids)

/** Every node holding part of an OPEN plan: its open plans' items and their ancestors (never evicted, never dismissed). */
function openPlanIds(sess) {
  const out = new Set()
  for (const n of sess.nodes.values()) {
    if (n.merged_into) continue
    const p = planOf2(sess, n)
    if (!p || planEndAt2(sess, n, p) != null) continue
    for (const it of p.items) for (let x = it; x && !out.has(x.id); x = x.parent != null ? sess.nodes.get(x.parent) : null) out.add(x.id)
  }
  return out
}
/** What removing an ENDED plan takes (6b): the plan node itself (with its items) when it is a plain context — not the root,
 * not an agent, not itself a plan item — holding nothing but the items and no live line; else just its items. */
function planRemoval2(sess, n, p) {
  // 2d: a test-run holds its items in buckets — it goes whole when everything below it is a bucket or an item (no agent)
  const only = typeOf(n).items === 'tree' ? subtree2(sess, n).slice(1).every(x => x.kind === 'context') : childrenOf2(sess, n).length === p.items.length
  if (n.kind === 'context' && n.parent != null && !n.plan && only && !(n.current && LIVE.has(n.current.state))) return [n]
  return p.items
}
/** 2d: is `n`'s plan part of an enclosing test-run's plan (n is one of its BUCKETS: the run's items include n's)? */
function inRunPlan2(sess, n, p) {
  for (let a = n.parent != null ? sess.nodes.get(n.parent) : null; a; a = a.parent != null ? sess.nodes.get(a.parent) : null) {
    if (a.kind !== 'context') return false
    if (typeOf(a).items === 'tree') { const rp = planOf2(sess, a); return !!rp && rp.items.includes(p.items[0]) }
  }
  return false
}
/**
 * The subtrees that may be EVICTED (6a / 6c), oldest first: FINISHED agents (by finished_at) and ENDED plans (by when they
 * ended; planRemoval2). Never one holding part of an OPEN plan, never one at or above a node in `keep` (the call's target,
 * its agent, what it created — and their ancestors), never a plan whose node is in `keep` (bar the session's own).
 * → [{ at, id, roots:[nodes] }]
 */
function evictionCandidates2(sess, keep) {
  const open = openPlanIds(sess), out = []
  for (const n of sess.nodes.values()) {
    if (n.merged_into) continue
    if (n.kind === 'agent' && n.finished_at && !keep.has(n.id) && !open.has(n.id)) out.push({ at: n.finished_at, id: n.id, roots: [n] })
    const p = planOf2(sess, n), end = p ? planEndAt2(sess, n, p) : null
    if (end == null || p.items.some(i => open.has(i.id)) || (n.parent != null && keep.has(n.id))) continue
    if (inRunPlan2(sess, n, p)) continue   // 2d: a test-run's bucket goes with its run (the run is the candidate), not alone
    const roots = planRemoval2(sess, n, p)
    if (!roots.some(r => keep.has(r.id))) out.push({ at: end, id: n.id, roots })
  }
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
/** A session's node counts (the root not counted; merged nodes count — they are in memory). */
function countOf(sess) { let nodes = 0, agents = 0; for (const n of sess.nodes.values()) { if (n.parent == null) continue; nodes++; if (n.kind === 'agent') agents++ } return { nodes, agents } }
/**
 * The per-session LIMITS (ACTIVITY_LIMITS, state.limits: ≤ 4096 nodes, ≤ 128 agents): over them, EVICT the oldest
 * candidates (each a `remove` record why:"evict", its subtree into the ghost table) until the session fits; nothing that
 * `protect` names or holds may go. Can't make room → `too-many-agents` / `too-many-nodes` (the call is refused as a whole).
 * → [{ id, key, label, path }] (what was evicted) or a refusal
 */
function enforceLimits(t, protect) {
  const { sess } = t, L = t.state.limits
  let c = countOf(sess)
  const fits = () => c.nodes <= L.nodesPerSession && c.agents <= L.agentsPerSession
  if (fits()) return []
  const keep = new Set()
  for (const id of protect) for (let n = id ? sess.nodes.get(id) : null; n && !keep.has(n.id); n = n.parent != null ? sess.nodes.get(n.parent) : null) keep.add(n.id)
  const evicted = []
  for (const cand of evictionCandidates2(sess, keep)) {
    if (fits()) break
    let any = false
    for (const r of cand.roots) if (sess.nodes.get(r.id) === r) { evicted.push({ id: r.id, key: r.key, label: r.label, path: pathOf(sess, r) }); removeNode(t, r, 'evict'); any = true }
    if (any) c = countOf(sess)
  }
  if (c.agents > L.agentsPerSession) return bad('too-many-agents', `this session already has ${L.agentsPerSession} agents and none (outside this call's nodes, holding no open plan item) has finished — report a done / failed line when an agent ends`)
  if (c.nodes > L.nodesPerSession) return bad('too-many-nodes', `this session already has ${L.nodesPerSession} nodes and not enough finished agents or ended plans to evict (open plan items are never evicted)`)
  return evicted
}

// ---------------------------------------------------------------------------------------------------------------
// 2c: DASHBOARD ACTIONS on ids (6d / #80 / #82 / #83 / #84 / #85 / #90 on ids, + 2.0's rename / merge / Show as group / plan)

/** The actions (wire names, §5.4). Plan items: done / skip / reopen (→ todo) / abandon (any context); plan nodes: complete /
 * abandon_plan / reopen_plan; agents and the session: abandon_plan / finish (args.state done | failed) / dismiss; any node:
 * move (args.to_id + a position + the clash answer), reorder, rename (args.label), edit_text, message; contexts: merge
 * (args.into_id + the clash answer), show_as_group / show_as_plan; questions: answer / change_answer / withdraw. */
export const ACTIONS2 = Object.freeze(['done', 'skip', 'reopen', 'abandon', 'complete', 'abandon_plan', 'reopen_plan', 'finish', 'dismiss', 'move', 'reorder', 'rename', 'merge',
  'edit_text', 'message', 'answer', 'withdraw', 'change_answer', 'show_as_group', 'show_as_plan'])
const ITEM_ACTIONS = Object.freeze({ done: 'done', skip: 'skipped', reopen: 'todo', abandon: 'abandoned' })
const ACTION_LABEL = Object.freeze({ done: 'marked done', skip: 'skipped', reopen: 'reopened (back to to do)', abandon: 'abandoned', complete: 'plan marked complete',
  abandon_plan: 'plan abandoned', reopen_plan: 'plan reopened', finish: 'marked finished', dismiss: 'dismissed from the board', withdraw: 'withdrawn' })
const actText = (label, by) => cut(`${label} ${byText(by)}`.trim())
/** #84: a message's text as kept — control characters out except newlines / tabs (CRLF → LF), trimmed. */
// eslint-disable-next-line no-control-regex
const msgText = s => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '')
/** #84: the first `max` code points of a text as ONE line ("…" when cut). */
const preview = (s, max) => cut(normText(String(s || '')), max)

/**
 * #83: the states the dashboard's Edit text… may set on a node — what a report could set there: a plan item any state;
 * another context any but todo / skipped; an agent / the session running | blocked | failed | done | idle, + abandoned only
 * while it holds plan items. A question none (its line is the question).
 * @param {any} sess @param {any} node @returns {string[]}
 */
export function editStates2(sess, node) {
  if (!node || isQuestion2(node)) return []
  if (node.kind === 'context') return node.plan ? [...ACTIVITY_STATES] : ACTIVITY_STATES.filter(s => !PLAN_STATES.has(s))
  return ACTIVITY_STATES.filter(s => !PLAN_STATES.has(s) && (s !== 'abandoned' || holdsItems(sess, node)))
}
/** The visible subtree of a node (it first). */
function subtree2(sess, node) { const out = []; const walk = n => { out.push(n); for (const c of childrenOf2(sess, n)) walk(c) }; walk(node); return out }
/** 6d: the OPEN plans `node` holds — itself and its subtree, not crossing another agent (an agent's plans, not its sub-agents'). */
function heldPlans2(sess, node) {
  const out = []
  const walk = n => { const p = planOf2(sess, n); if (p && planEndAt2(sess, n, p) == null) out.push(n); for (const c of childrenOf2(sess, n)) if (c.kind !== 'agent') walk(c) }
  walk(node)
  return out
}
/** 6d: is this agent (or the session root) QUIET — finished, stale (by `sm` minutes) or gone; an implicit one (it never
 * reported) when every reported agent below it is quiet. */
function quiet2(sess, n, now, sm) {
  if (n.finished_at || n.gone_at) return true
  if (effectiveState2(sess, n, now, sm).stale) return true
  if (!n.implicit) return false
  return subtree2(sess, n).slice(1).every(x => x.kind !== 'agent' || x.implicit || quiet2(sess, x, now, sm))
}
/** A line action: `st` on the node, keeping the line's text (a tick); the LOGGED entry's text is `text` (the attribution). */
const lineAct = (t, node, st, text) => applyReport(t, node, { state: st, text: null, line: false, log: true, stale_after_ms: null }, { entryText: text })
/** A logged (non-current) entry on an agent / the session that sets ('done' | 'abandoned') or clears ('open') its plan-end marker. */
const markerAct = (t, node, planEnd, text) => applyReport(t, node, { text, line: false, state: null, log: true, stale_after_ms: null }, { planEnd })
/**
 * End OPEN plans by abandoning them (the dashboard's abandon_plan), DEEPEST first: each plan's OPEN items get an abandoned
 * line, then the plan node itself — a CONTEXT by its line, an agent / the session by the plan-end marker (it keeps running).
 * → [{ id, path, item, from, entry_id, cascade? }]
 */
function abandonPlans2(t, plans, text) {
  const { sess } = t, done = []
  const one = (n, item) => {
    const from = item ? stateOf(n) : 'open', path = pathOf(sess, n)
    const r = !item && n.kind !== 'context' ? markerAct(t, n, 'abandoned', text) : lineAct(t, n, 'abandoned', text)
    if (r.ok === false) return
    done.push({ id: n.id, path, item, from, entry_id: r.entry ? r.entry.id : null })
    for (const c of r.cascade || []) done.push({ id: c.id, path: c.path, item: !!(sess.nodes.get(c.id) || {}).plan, from: c.from, entry_id: c.entry_id, cascade: true })
  }
  for (const n of [...plans].sort((a, b) => depthOf(sess, b) - depthOf(sess, a) || (a.id < b.id ? -1 : 1))) {
    if (!sess.nodes.has(n.id)) continue
    const p = planOf2(sess, n)
    if (!p || planEndAt2(sess, n, p) != null) continue
    for (const it of p.items) if (OPEN_ITEM.has(stateOf(it))) one(it, true)
    one(n, false)
  }
  return done
}
/** A dashboard action's position (args.before_id | after_id | position "first" | "last") → { kind, ref_id? } | null. */
function actionPos(a) {
  const given = ['before_id', 'after_id', 'position'].filter(k => a[k] != null && a[k] !== '')
  if (!given.length) return { ok: true, pos: null }
  if (given.length > 1) return bad('bad-position', `give ONE of before_id / after_id / position (got ${given.join(' + ')})`)
  if (given[0] === 'position') { const p = typeof a.position === 'string' ? lc(a.position.trim()) : ''; return p === 'first' || p === 'last' ? { ok: true, pos: { kind: p } } : bad('bad-position', 'position must be "first" or "last"') }
  const v = a[given[0]]
  if (typeof v !== 'string' || !ID_RE.test(v)) return bad('bad-ref', `${given[0]} must be a node id`)
  return { ok: true, pos: { kind: given[0] === 'before_id' ? 'before' : 'after', ref_id: v } }
}
/**
 * The dialog's CLASH ANSWER (§1.6, Q32; §6.3 `merges`) → { ok, map: id → { into_id } | { label }, used: Set }: `label` (the
 * moved node's new label) and `merges:[{ id, into_id } | { id, label }]` — per clash, "merge them" (into its same-label
 * sibling `into_id`) or "use a different label".
 */
function parseAnswers(a, nodeId) {
  const map = new Map()
  if (a.label != null) { const l = normLabel(a.label); if (!l.ok) return bad('bad-args', `label: ${l.what}`); map.set(nodeId, { label: l.label }) }
  if (a.merges != null) {
    if (!Array.isArray(a.merges) || a.merges.length > ACTIVITY_LIMITS.nodesPerSession) return bad('bad-args', 'merges must be a list of { id, into_id } (merge them) or { id, label } (use a different label)')
    for (const x of a.merges) {
      if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ID_RE.test(x.id)) return bad('bad-args', 'each merges entry names its node: { id, into_id } or { id, label }')
      if (map.has(x.id)) return bad('bad-args', `${x.id} is answered twice`)
      if (x.into_id != null && x.label != null) return bad('bad-args', `${x.id}: one answer per clash — into_id (merge them) or label`)
      if (x.into_id != null) { if (typeof x.into_id !== 'string' || !ID_RE.test(x.into_id)) return bad('bad-args', `${x.id}: into_id must be a node id`); map.set(x.id, { into_id: x.into_id }) }
      else if (x.label != null) { const l = normLabel(x.label); if (!l.ok) return bad('bad-args', `${x.id}: label: ${l.what}`); map.set(x.id, { label: l.label }) }
      else return bad('bad-args', `${x.id}: give into_id (merge them) or label (a different label)`)
    }
  }
  return { ok: true, map, used: new Set() }
}

/**
 * ONE dashboard ACTION on a LOCAL node, by id (6d on ids, §5.4) → { ok, action, id, path (before), node (now; null when it
 * left), ident, kind, type, key, scope, text (the line's, before), from_state, to_state, of? ("plan"), entry_id, applied:[{
 * id, path, state, from?, entry_id?, item? }], owner (the nearest agent at or above, or null = the session), records,
 * entries, writes, warnings? } + per action: moved_from / to / to_id / where / rank (move, reorder), from_label / label
 * (rename), into_id / into (merge, or a move answered "merge them"), from_text / new_text (edit_text), message, question /
 * answer / previous (answer / change_answer / withdraw), from_type / to_type (show_as_*), dismissed. ALL-OR-NOTHING, a
 * SYSTEM change attributed `by` + `act` (no activity). What it notifies: actionNotice2.
 * q = { session, project?, user?, realm?, id, action, args? }; opts.by = { kind:"dashboard", user, host } (required).
 * Codes: bad-action, bad-by, unknown-session, bad-id, unknown-node, bad-args, not-a-plan-item, no-change, not-a-plan,
 * already-ended, not-ended, all-items-done, no-open-plan, not-an-agent, already-finished, not-stale, has-open-items, the
 * position / move / merge / rename refusals, duplicate-label (an unanswered clash: `clashes` = the dialog's list,
 * clashes2), clash-changed (the answer no longer fits the tree: the dialog reopens with `clashes`), and the question codes.
 * args.stale_min (1..1440; default the host's) = the dashboard slider, so "stale" means what the viewer saw.
 * @param {any} state @param {any} q @param {number} now @param {{ by?: any }} [opts]
 * @returns {any}
 */
export function applyAction2(state, q, now, opts = {}) {
  if (!state || !(state.sessions instanceof Map)) return bad('bad-state-object', 'pass a createModel() state')
  if (!Number.isFinite(now)) return bad('bad-now', 'now must be a ms epoch')
  if (!q || typeof q !== 'object') return bad('bad-action', 'an action is { session, project?, user?, realm?, id, action, args? }')
  const action = typeof q.action === 'string' ? q.action.trim().toLowerCase() : ''
  if (!ACTIONS2.includes(action)) return bad('bad-action', `action must be one of ${ACTIONS2.join('|')}`)
  const by = normBy(opts && opts.by)
  if (!by || typeof by === 'string') return bad('bad-by', 'an action needs its author ({ kind:"dashboard", user, host })')
  const args = q.args && typeof q.args === 'object' && !Array.isArray(q.args) ? q.args : {}
  const sess = typeof q.session === 'string' && q.session.trim() ? getSession2(state, { session: q.session, project: q.project, user: q.user, realm: q.realm }) : null
  if (!sess) return bad('unknown-session', `no activity from a session "${String(q.session).slice(0, 80)}" (${String(q.project || '').slice(0, 60)}) on this host`)
  if (typeof q.id !== 'string' || !ID_RE.test(q.id)) return bad('bad-id', 'an action names its node by id (16 chars of a-z 2-7)')
  const node = sess.nodes.get(q.id)
  if (!node || node.merged_into) return bad('unknown-node', `${q.id} is not on the board${sess.ghosts.has(q.id) ? ' (it was removed)' : node ? ' (it is merged)' : ''}`)
  const smArg = Number(args.stale_min), sm = Number.isFinite(smArg) && smArg >= 1 && smArg <= 1440 ? smArg : state.config.stale_after_min
  // #80: what the notice says — read BEFORE the action applies
  const plan0 = planOf2(sess, node), from0 = stateOf(node), planFrom0 = plan0 ? (planEndAt2(sess, node, plan0) != null ? planEndHow2(sess, node, plan0) : 'open') : null
  const path0 = pathOf(sess, node), isAgent = node.kind !== 'context'
  const base = { action, id: node.id, path: path0, ident: { ...sess.ident }, kind: node.kind, type: node.type, key: node.key, scope: node.scope, text: node.current ? node.current.text : null, owner: askerOf(sess, node), by }
  const t = newTx(state, sess, now, { by, act: action })
  const fail = r => { rollback(t); return r }
  const entryOf = () => { for (let i = t.entries.length - 1; i >= 0; i--) if (t.entries[i].n === node.id) return t.entries[i].id; return t.entries.length ? t.entries[t.entries.length - 1].id : null }
  const alive = () => state.sessions.get(sess.key) === sess && sess.nodes.get(node.id) === node
  const done = (to, extra = {}) => ({ ok: true, ...base, node: alive() ? nodeView(sess, node) : null, from_state: to.of === 'plan' ? planFrom0 : from0, to_state: to.state, ...(to.of ? { of: to.of } : {}),
    entry_id: entryOf(), applied: [{ id: node.id, path: path0, state: alive() ? stateOf(node) : null }], ...extra, records: t.records, entries: t.entries, writes: t.writes,
    ...(t.warnings.length ? { warnings: [...t.warnings] } : {}) })
  /** a self-contained 2b call (its own transaction) → the action's shape */
  const wrap = (r, to, extra = {}) => (r.ok === false ? r : { ...base, ...r, ok: true, action, node: r.node || (alive() ? nodeView(sess, node) : null), from_state: from0, to_state: to.state, entry_id: r.entry_id || (r.entries && r.entries.length ? r.entries[r.entries.length - 1].id : null),
    applied: [{ id: node.id, path: path0, state: stateOf(node) }], ...extra })
  /** a refused move / merge: the dialog's fresh clash list rides along (it reopens with the tree as it is now) */
  const clashFail = (r, args2) => { rollback(t); if (r.code !== 'duplicate-label' && r.code !== 'clash-changed') return r; const c = clashes2(state, sess.ident, node.id, args2); return { ...r, clashes: c.ok ? c.clashes : r.clashes || [] } }
  switch (action) {
    case 'done': case 'skip': case 'reopen': case 'abandon': {   // a PLAN ITEM (abandon: any context, with its open descendants)
      if (!node.plan && !(action === 'abandon' && node.kind === 'context')) return bad('not-a-plan-item', `"${path0 || sess.ident.session}" is not a plan item${action === 'abandon' ? ' or a context' : ''}`)
      const st = ITEM_ACTIONS[action]
      if (node.current && stateOf(node) === st) return bad('no-change', `"${path0}" is already ${st}`)
      const r = lineAct(t, node, st, actText(ACTION_LABEL[action], by))
      if (r.ok === false) return fail(r)
      const par = sess.nodes.get(node.parent), pp = par ? planOf2(sess, par) : null
      if (action === 'reopen' && pp && planEndAt2(sess, par, pp) != null) warn(t, { code: 'plan-ended', what: `the plan of "${pathOf(sess, par) || sess.ident.session}" has ended — reopen the plan too` })
      const casc = (r.cascade || []).map(c => ({ id: c.id, path: c.path, state: 'abandoned', from: c.from, entry_id: c.entry_id }))
      return done({ state: st }, casc.length ? { applied: [{ id: node.id, path: path0, state: st }, ...casc] } : {})
    }
    case 'complete': {   // a PLAN NODE: ends its plan (a context: its line done; an agent / the session: the marker)
      if (!plan0) return bad('not-a-plan', `"${path0 || sess.ident.session}" holds no plan items`)
      if (planEndAt2(sess, node, plan0) != null) return bad('already-ended', `the plan of "${path0 || sess.ident.session}" has already ended`)
      const text = actText(ACTION_LABEL.complete, by)
      const r = isAgent ? markerAct(t, node, 'done', text) : lineAct(t, node, 'done', text)
      return r.ok === false ? fail(r) : done({ state: 'done', of: 'plan' })
    }
    case 'reopen_plan': {
      if (!plan0) return bad('not-a-plan', `"${path0 || sess.ident.session}" holds no plan items`)
      if (planEndAt2(sess, node, plan0) == null) return bad('not-ended', `the plan of "${path0 || sess.ident.session}" is open`)
      if (plan0.allDoneAt != null) return bad('all-items-done', 'every item of this plan is done — reopen an item instead')
      const text = actText(ACTION_LABEL.reopen_plan, by)
      const r = isAgent ? markerAct(t, node, 'open', text) : lineAct(t, node, 'running', text)
      return r.ok === false ? fail(r) : done({ state: 'open', of: 'plan' })
    }
    case 'abandon_plan': {   // a plan node: its open items, then it; an agent / the session: every open plan it holds (it keeps running)
      if (!isAgent && !plan0) return bad('not-a-plan', `"${path0}" holds no plan items`)
      const plans = heldPlans2(sess, node)
      if (!plans.length) return bad('no-open-plan', `"${path0 || sess.ident.session}" holds no open plan`)
      const d = abandonPlans2(t, plans, actText(ACTION_LABEL.abandon_plan, by))
      return done({ state: 'abandoned', of: 'plan' }, { applied: d.map(x => ({ id: x.id, path: x.path, state: 'abandoned', item: x.item, from: x.from, entry_id: x.entry_id })) })
    }
    case 'finish': {   // an agent / the session that is stale or gone
      if (!isAgent) return bad('not-an-agent', `"${path0}" is a context — only an agent or the session finishes`)
      const st = typeof args.state === 'string' ? args.state.trim().toLowerCase() : ''
      if (st !== 'done' && st !== 'failed') return bad('bad-args', 'finish takes args.state "done" or "failed"')
      if (node.finished_at) return bad('already-finished', `"${path0 || sess.ident.session}" has already finished`)
      if (!quiet2(sess, node, now, sm)) return bad('not-stale', `"${path0 || sess.ident.session}" is neither stale nor gone — only a quiet agent can be marked finished`)
      const r = lineAct(t, node, st, actText(`${ACTION_LABEL.finish} (${st})`, by))
      return r.ok === false ? fail(r) : done({ state: st })
    }
    case 'dismiss': {   // remove an agent / the session (with its subtree) from the board now; the files keep everything
      if (!isAgent) return bad('not-an-agent', `"${path0}" is a context — dismiss removes an agent or a session`)
      const sub = subtree2(sess, node)
      if (!sub.every(x => (x === node ? quiet2(sess, x, now, sm) : x.kind !== 'agent' || x.implicit || quiet2(sess, x, now, sm))))
        return bad('not-stale', `"${path0 || sess.ident.session}" (or an agent under it) is still active — only a stale, gone or finished agent can be dismissed`)
      if (openPlanIds(sess).has(node.id)) return bad('has-open-items', `"${path0 || sess.ident.session}" holds part of an OPEN plan — complete or abandon it first (open plan items are never removed)`)
      let count = 0
      const walk = n => { count++; for (const id of kidIds(sess, n.id)) { const c = sess.nodes.get(id); if (c) walk(c) } }
      walk(node)
      const root = node.parent == null, holder = root ? node : sess.nodes.get(node.parent)
      // 6d: ONE logged entry — on the PARENT (`dismiss:true`, `of` = the removed id; the session root: on itself) — then the
      // node and its subtree leave memory (a `remove` record, why "dismiss"; the root: the whole session)
      const e = writeEntry(t, holder, { type: 'event', text: actText(root ? 'the session dismissed from the board' : `dismissed "${node.label}" from the board`, by), state: stateOf(node), extra: { dismiss: true, of: node.id } })
      if (!root) removeNode(t, node, 'dismiss')
      else { record(t, 'remove', node, { why: 'dismiss', was: '' }); mdel(t, state.sessions, sess.key) }
      return done({ state: 'dismissed' }, { entry_id: e.id, applied: [{ id: node.id, path: path0, state: 'dismissed' }], dismissed: { id: node.id, path: path0, nodes: count, session: root } })
    }
    case 'reorder': {   // a new place among its siblings (args.before_id | after_id, or position first | last)
      const ap = actionPos(args)
      if (ap.ok === false) return ap
      if (!ap.pos) return bad('bad-args', 'reorder takes args.before_id / args.after_id (a sibling) or args.position ("first" | "last")')
      const r = reorderNode(t, node, ap.pos, rootOf(sess))
      if (r.ok === false) return fail(r)
      if (r.noop) return bad('no-change', `"${path0}" is already there`)
      const w = r.placed.where
      return done({ state: from0 }, { where: w === 'first' ? 'to the top' : w === 'last' ? 'to the end' : w, rank: r.placed.rank })
    }
    case 'move': {   // re-parent (args.to_id) + a position; a clash with a same-label sibling → the dialog's answer (label / merges)
      if (node.parent == null) return bad('bad-move', 'the session root cannot move')
      if (typeof args.to_id !== 'string') return bad('bad-args', 'move takes args.to_id: the new parent\'s id (+ before_id / after_id / position; label / merges answer a label clash)')
      const ap = actionPos(args)
      if (ap.ok === false) return ap
      const an = parseAnswers(args, node.id)
      if (an.ok === false) return an
      const d = byId(t, args.to_id, 'to_id')
      if (d.ok === false) return d
      const dest = d.node
      if (dest.id === node.parent && !an.map.size) {
        if (!ap.pos) return bad('no-change', `"${path0}" is already there`)
        const r = reorderNode(t, node, ap.pos, rootOf(sess))
        if (r.ok === false) return fail(r)
        if (r.noop) return bad('no-change', `"${path0}" is already there`)
        return done({ state: from0 }, { where: r.placed.where, rank: r.placed.rank })
      }
      const mine = an.map.get(node.id), label = mine && mine.label != null ? mine.label : node.label
      if (mine) an.used.add(node.id)
      const sib = clashAt(sess, dest.id, label, node.id)
      let extra
      if (mine && mine.into_id != null) {   // "merge them": the moved node merges into its same-label sibling there
        if (!sib || sib.id !== mine.into_id) return clashFail(bad('clash-changed', `the tree changed: "${node.label}" no longer clashes with that node under "${pathOf(sess, dest) || sess.ident.session}" — look again`), { to_id: dest.id })
        const m = mergeNode(t, node, sib, an)
        if (m.ok === false) return clashFail(m, { to_id: dest.id })
        extra = { into_id: sib.id, into: pathOf(sess, sib), merged: m.merged }
      } else {
        if (sib) return clashFail(mine ? bad('clash-changed', `the tree changed: "${label}" is taken under "${pathOf(sess, dest) || sess.ident.session}" too (key ${sib.key})`) : dupLabel(sess, dest.id, label, sib, node.id, `can't move "${node.label}" under "${pathOf(sess, dest) || sess.ident.session}"`), { to_id: dest.id })
        if (dest.id === node.parent) { const e = renameNode(t, node, label); if (e) return fail(e) }
        const m = dest.id === node.parent ? (ap.pos ? reorderNode(t, node, ap.pos, rootOf(sess)) : { noop: true }) : moveNode(t, node, dest, label !== node.label ? label : null, ap.pos, rootOf(sess))
        if (m.ok === false) return clashFail(m, { to_id: dest.id })
        extra = { moved_from: path0, to: pathOf(sess, dest), to_id: dest.id, ...(m.moved ? { rank: m.moved.rank, ...(m.moved.where ? { where: m.moved.where } : {}) } : m.placed ? { rank: m.placed.rank, where: m.placed.where } : {}),
          ...(mine ? { label } : {}) }
      }
      const unused = [...an.map.keys()].filter(k => !an.used.has(k))
      if (unused.length) return clashFail(bad('clash-changed', `the tree changed: ${unused.length} answer${unused.length === 1 ? '' : 's'} no longer match${unused.length === 1 ? 'es' : ''} a clash — look again`), { to_id: dest.id })
      return done({ state: from0 }, extra)
    }
    case 'merge': {   // A into B (args.into_id); clashes among the children → the dialog's answer (merges)
      if (typeof args.into_id !== 'string') return bad('bad-args', 'merge takes args.into_id: the node to merge into (+ merges answering its children\'s label clashes)')
      if (args.label != null) return bad('bad-args', 'a merged node keeps no label of its own — answer its children\'s clashes in merges')
      const an = parseAnswers(args, node.id)
      if (an.ok === false) return an
      const d = byId(t, args.into_id, 'into_id')
      if (d.ok === false) return d
      const m = mergeNode(t, node, d.node, an)
      if (m.ok === false) return clashFail(m, { into_id: d.node.id })
      const unused = [...an.map.keys()].filter(k => !an.used.has(k))
      if (unused.length) return clashFail(bad('clash-changed', `the tree changed: ${unused.length} answer${unused.length === 1 ? '' : 's'} no longer match${unused.length === 1 ? 'es' : ''} a clash — look again`), { into_id: d.node.id })
      return done({ state: from0 }, { into_id: d.node.id, into: pathOf(sess, d.node), merged: m.merged })
    }
    case 'rename': {   // Rename… (label ≤ 60): a sibling's label → duplicate-label with the suggestion (shown inline)
      const l = normLabel(args.label)
      if (!l.ok) return bad('bad-args', `rename takes args.label — ${l.what}`)
      if (l.label === node.label) return bad('no-change', `"${path0}" is already labelled that`)
      const old = node.label, e = renameNode(t, node, l.label)
      if (e) return fail(e)
      return done({ state: from0 }, { from_label: old, label: l.label })
    }
    case 'edit_text': {   // #83: set the node's LINE (+ optionally its state) for its session — any node, the session root too
      if (typeof args.text !== 'string' || !normText(args.text)) return bad('bad-args', 'edit_text takes args.text — the new line (and optionally args.state)')
      const valid = editStates2(sess, node)
      const st = typeof args.state === 'string' && args.state.trim() ? args.state.trim().toLowerCase() : null
      if (st && !valid.includes(st)) return bad('bad-state', `"${path0 || sess.ident.session}" can be ${valid.join('|') || 'nothing (a question\'s line is the question)'} — not ${st}`)
      const keep = st || (node.current ? stateOf(node) : null)   // no state given: the line keeps its state (a ☐ item is not started by an edit)
      let text = normText(args.text)
      if (cpLen(text) > ACTIVITY_LIMITS.text) { text = cpSlice(text, ACTIVITY_LIMITS.text - 1) + '…'; warn(t, { code: 'text-truncated', what: `text cut to ${ACTIVITY_LIMITS.text} characters` }) }
      if (node.current && node.current.text === text && stateOf(node) === (keep || 'running')) return bad('no-change', `"${path0 || sess.ident.session}" already reads that`)
      const suffix = ` (edited ${byText(by)})`, room = ACTIVITY_LIMITS.text - cpLen(suffix)   // the LOGGED entry: the text + who edited it (the line keeps the text alone)
      const et = (cpLen(text) > room ? cpSlice(text, room - 1) + '…' : text) + suffix
      const c0 = node.current
      const r = applyReport(t, node, { text, line: true, state: keep, log: true, stale_after_ms: null, details: c0 ? c0.details || null : null, data: c0 && c0.data != null ? c0.data : null }, { entryText: et })
      if (r.ok === false) return fail(r)
      const st2 = stateOf(node), casc = (r.cascade || []).map(c => ({ id: c.id, path: c.path, state: 'abandoned', from: c.from, entry_id: c.entry_id }))
      return done({ state: st2 }, { from_text: base.text, new_text: text, ...(casc.length ? { applied: [{ id: node.id, path: path0, state: st2 }, ...casc] } : {}) })
    }
    case 'message': {   // #84: a message to the node's session — LOGGED on the node here; the bridge delivers it (actionNotice2)
      const full = msgText(args.text)
      if (!full) return bad('bad-args', 'message takes args.text — what to tell the session')
      if (cpLen(full) > MESSAGE_LIMITS.text) return bad('message-too-long', `a message is at most ${MESSAGE_LIMITS.text} characters (got ${cpLen(full)}) — shorten it`)
      let det = full   // the full text in details (≤ 4 KB: a long non-ASCII message is cut there — the delivered message carries all of it)
      while (utf8(det) > ACTIVITY_LIMITS.detailsBytes) det = cpSlice(det, Math.max(1, cpLen(det) - Math.ceil((utf8(det) - ACTIVITY_LIMITS.detailsBytes) / 4) - 1)) + '…'
      const r = applyReport(t, node, { text: cut(`${by.user} via dashboard: ${preview(full, MESSAGE_LIMITS.preview)}`), line: false, state: null, log: true, stale_after_ms: null, details: det, data: null })
      if (r.ok === false) return fail(r)
      return done({ state: from0 }, { message: full })
    }
    case 'answer': case 'change_answer':   // #85 / #90 — 2b's model call
      return wrap(answerQuestion2(state, sess.ident, node.id, args, now, { by, change: action === 'change_answer' }), { state: 'done' })
    case 'withdraw':
      return wrap(withdrawQuestion2(state, sess.ident, node.id, now, { by }), { state: 'abandoned' })
    case 'show_as_group': case 'show_as_plan': {   // GROUPS: Show as group / Show as plan — 2b's setType2
      const to = action === 'show_as_group' ? 'group' : 'plan'
      return wrap(setType2(state, sess.ident, node.id, to, now, { by, act: action }), { state: from0 }, { from_type: base.type, to_type: to })
    }
  }
  return bad('bad-action', action)
}

/**
 * The CLASH DIALOG's list (§1.6, Q32; §5.4) — read-only: what moving node `id` under `args.to_id`, or merging it into
 * `args.into_id`, would clash with, so the dashboard can ask per clash "merge them" or "use a different label". → { ok,
 * clashes:[{ id, key, label, kind, under_id (where it would land), sibling:{ id, key, label }, suggestion ("Notes (2)"),
 * can_merge (both contexts and mergeable — never for an agent), nested:[the clashes "merge them" would create one level
 * down, the same shape] }] } — empty when nothing clashes. The answer goes back as one action (applyAction2 move / merge:
 * `label` and `merges:[{ id, into_id } | { id, label }]`).
 * @param {any} state @param {any} ident @param {string} id @param {{ to_id?: string, into_id?: string }} args
 */
export function clashes2(state, ident, id, args = {}) {
  const sess = getSession2(state, ident)
  if (!sess) return bad('unknown-session', 'no such session on this host')
  const node = sess.nodes.get(id)
  if (!node || node.merged_into) return bad('unknown-node', `${id} is not on the board`)
  const entry = (k, s, under) => { const cm = !canMergeWhy(sess, k, s); return { id: k.id, key: k.key, label: k.label, kind: k.kind, under_id: under.id, sibling: brief(s), suggestion: freeLabel(sess, under.id, k.label, k.id).label, can_merge: cm, nested: cm ? kidClashes(k, s) : [] } }
  const kidClashes = (a, b) => { const out = []; for (const k of childrenOf2(sess, a)) { const s = clashAt(sess, b.id, k.label, k.id); if (s) out.push(entry(k, s, b)) } return out }
  if (args.into_id != null) {
    const b = sess.nodes.get(args.into_id)
    if (!b || b.merged_into) return bad('unknown-node', `${args.into_id} is not on the board`)
    return { ok: true, clashes: kidClashes(node, b) }
  }
  const d = sess.nodes.get(args.to_id)
  if (!d || d.merged_into) return bad('unknown-node', `${args.to_id} is not on the board`)
  if (d.id === node.parent) return { ok: true, clashes: [] }
  const s = clashAt(sess, d.id, node.label, node.id)
  return { ok: true, clashes: s ? [entry(node, s, d)] : [] }
}

// ---------------------------------------------------------------------------------------------------------------
// 2c: NOTICES (#80 / #83 / #84 / #85 / #90 on ids, §5.5) — model output only; the bridge batches and delivers them

const NOTICE_ONE = Object.freeze({ done: 'marked {p} done', skip: 'skipped {p}', reopen: 'reopened {p}', abandon: 'abandoned {p}', complete: 'completed the plan {p}',
  abandon_plan: 'abandoned the plan {p}', reopen_plan: 'reopened the plan {p}', finish: 'marked {p} finished ({s})', dismiss: 'dismissed {p} from the board', edit_text: 'edited {p}',
  reorder: 'moved {p} {w}', show_as_group: 'showed {p} as a group', show_as_plan: 'showed {p} as a plan' })
const NOTICE_MANY = Object.freeze({ done: 'marked {n} done', skip: 'skipped {n}', reopen: 'reopened {n}', abandon: 'abandoned {n}', complete: 'completed {n}', abandon_plan: 'abandoned {n}',
  reopen_plan: 'reopened {n}', finish: 'finished {n}', dismiss: 'dismissed {n}', move: 'moved {n}', reorder: 'reordered {n}', edit_text: 'edited {n}', rename: 'renamed {n}', merge: 'merged {n}',
  show_as_group: 'regrouped {n}', show_as_plan: 'regrouped {n}' })
const NOTICE_NOUN = Object.freeze({ done: 'item', skip: 'item', reopen: 'item', abandon: 'item', complete: 'plan', abandon_plan: 'plan', reopen_plan: 'plan', finish: 'agent', dismiss: 'agent',
  move: 'node', reorder: 'node', edit_text: 'line', rename: 'node', merge: 'node', show_as_group: 'node', show_as_plan: 'node' })
const NOTICE_SUBJECT_MAX = 200
/** A node's display path NOW (§5.5: at SEND time, from the id — a batch is flushed seconds later), else `fallback` (it left). */
function pathNow(o, ident, id, fallback) {
  if (o && o.state && id) { const s = getSession2(o.state, ident || {}), n = s ? s.nodes.get(id) : null; if (n && !n.merged_into) return pathOf(s, n) }
  return fallback == null ? '' : fallback
}
/** A path for a SUBJECT: shortened in the middle (Q11b); the session root → the session's name. */
const subj = (p, session) => (p ? shortPath(p) : String(session || 'the session'))
const byOf = (b0, host) => { const b = normBy(b0); return b && typeof b === 'object' ? { user: b.user, host: b.host } : { user: typeof b === 'string' ? b : 'dashboard', host: host || '?' } }
/** Who a notice goes to (§5.5): the node's SESSION (its registered sub-peer; parked when it is offline), with the nearest
 * AGENT at or above the node named (null = the session itself) so an orchestrator can relay it. */
const toOf = r => { const i = r.ident || {}; return { realm: i.realm || 'default', project: i.project || null, user: i.user || null, session: i.session || null, host: i.host || null } }

/**
 * What one applied ACTION notifies (applyAction2's result; expireQuestions2's `expired[]` items) → { verb, subject, body,
 * to (the node's session), agent (the nearest agent at or above the node, or null), now (send at once — a message, an
 * answer — else batched per session, notice_batch_sec) }. Verbs: activity_changed (every structural / state action, incl.
 * 2.0's rename / merge / Show as group / plan), activity_text_edited (edit_text), activity_message (message, at once),
 * activity_answer (answer / change_answer / withdraw / expire, at once). Subjects are PUBLIC: who, what, the node's path NOW
 * (opts.state given: computed from the id at send time) shortened in the middle — never a message's or an answer's text.
 * Bodies gain node_id, key, scope beside path (§5.5). opts = { by (the author), host (the owner), ts, state? }.
 * @param {any} r @param {{ by?: any, host?: string, ts?: number, state?: any }} [opts]
 */
export function actionNotice2(r, opts = {}) {
  if (r && r.action === 'message') return messageNotice2(r, opts)
  if (r && ['answer', 'withdraw', 'expire', 'change_answer'].includes(r.action)) return answerNotice2(r, opts)
  const id = r.ident || {}, action = r.action, by = byOf(opts.by != null ? opts.by : r.by, opts.host)
  const p = pathNow(opts, id, r.id, r.path)
  const pp = r.kind !== 'context' && NOTICE_NOUN[action] === 'plan' ? `of ${subj(p, id.session)}` : subj(p, id.session)   // "completed the plan of lead"
  let said
  if (action === 'move' && r.into_id) said = `merged ${subj(r.path, id.session)} into ${subj(pathNow(opts, id, r.into_id, r.into), id.session)}`   // "merge them" from the move dialog
  else if (action === 'move') said = `moved ${subj(r.moved_from != null ? r.moved_from : r.path, id.session)} to ${subj(pathNow(opts, id, r.to_id, r.to), id.session)}${r.label ? ` as "${r.label}"` : ''}`   // names the OLD path
  else if (action === 'rename') said = `renamed ${subj(r.path, id.session)} to "${r.label}"`
  else if (action === 'merge') said = `merged ${subj(r.path, id.session)} into ${subj(pathNow(opts, id, r.into_id, r.into), id.session)}`
  else {
    const tpl = action === 'abandon_plan' && r.kind !== 'context' ? 'abandoned the open plans {p}' : NOTICE_ONE[action] || `${action} {p}`
    said = tpl.replace('{p}', pp).replace('{s}', r.to_state || '').replace('{w}', r.where || 'elsewhere')
  }
  const st83 = action === 'edit_text' && r.from_state && r.to_state && r.from_state !== r.to_state ? ` (${r.from_state} → ${r.to_state})` : ''   // #83: an edit that changed the state says so
  const subject = cpSlice(`${by.user} ${said}${st83}`, NOTICE_SUBJECT_MAX)
  const items = (r.applied || []).filter(a => a.id !== r.id).map(a => compact({ node_id: a.id, path: pathNow(opts, id, a.id, a.path), from_state: a.from || null, to_state: a.state, entry_id: a.entry_id || null }))
  const body = { action, path: p, node_id: r.id || null, key: r.key != null ? r.key : null, scope: r.scope != null ? r.scope : null, host: opts.host || id.host || null,
    from_state: r.from_state || null, to_state: r.to_state || null, ...(r.of ? { of: r.of } : {}), by, entry_id: r.entry_id || null, session: id.session || null, project: id.project || null,
    text: r.text || null, ts: opts.ts || null, ...(items.length ? { items } : {}),
    ...(action === 'move' ? { moved_from: r.moved_from != null ? r.moved_from : r.path, to: r.to_id ? pathNow(opts, id, r.to_id, r.to) : null, to_id: r.to_id || null } : {}),
    ...(r.into_id ? { into: pathNow(opts, id, r.into_id, r.into), into_id: r.into_id } : {}), ...(r.where ? { where: r.where } : {}),
    ...(action === 'rename' ? { from_label: r.from_label || null, label: r.label || null } : {}), ...(action === 'move' && r.label ? { label: r.label } : {}),
    ...(r.from_type ? { from_type: r.from_type, to_type: r.to_type } : {}), ...(r.dismissed ? { dismissed: r.dismissed } : {}),
    ...(action === 'edit_text' ? { from_text: r.from_text != null ? r.from_text : null, text: r.new_text != null ? r.new_text : null } : {}) }   // #83: the line before → after
  return { verb: action === 'edit_text' ? EDIT_NOTICE_VERB : NOTICE_VERB, subject, body, to: toOf(r), agent: r.owner || null, now: false }
}
/**
 * #84: a dashboard viewer's MESSAGE about a node → { verb:"activity_message", subject ("robin about Rel/#83: can you also
 * cover…" — a few words only), body { action, path, node_id, key, scope, host, text (ALL of it), by, entry_id, session,
 * project, ts }, to, agent, now:true }.
 * @param {any} r @param {{ by?: any, host?: string, ts?: number, state?: any }} [opts]
 */
export function messageNotice2(r, opts = {}) {
  const id = r.ident || {}, by = byOf(opts.by != null ? opts.by : r.by, opts.host), text = typeof r.message === 'string' ? r.message : ''
  const p = pathNow(opts, id, r.id, r.path)
  return { verb: MESSAGE_NOTICE_VERB, subject: cpSlice(`${by.user} about ${subj(p, id.session)}: ${firstWords(text)}`, NOTICE_SUBJECT_MAX),
    body: { action: 'message', path: p, node_id: r.id || null, key: r.key != null ? r.key : null, scope: r.scope != null ? r.scope : null, host: opts.host || id.host || null, text, by,
      entry_id: r.entry_id || null, session: id.session || null, project: id.project || null, ts: opts.ts || null }, to: toOf(r), agent: r.owner || null, now: true }
}
/**
 * #85 / #90: a session's OWN question answered, its answer changed, withdrawn (the dashboard) or expired (the bridge) →
 * { verb:"activity_answer", subject (who, the path, the question's first words — NEVER the answer), body { action, status
 * (answered | revised | withdrawn | expired), path, node_id, key, scope, host, question, choices, free, answer?, previous? /
 * revised?, by, entry_id, session, project, agent (the asking agent, or null = the session), asked_at, ts }, to, agent,
 * now:true }. r = applyAction2's answer / change_answer / withdraw result, or one of expireQuestions2's `expired[]`.
 * @param {any} r @param {{ by?: any, host?: string, ts?: number, state?: any }} [opts]
 */
export function answerNotice2(r, opts = {}) {
  const id = r.ident || {}, q = /** @type {any} */ (questionView(r.question)) || { status: r.action === 'withdraw' ? 'withdrawn' : r.action === 'expire' ? 'expired' : 'answered', choices: [], free: true }
  const b = normBy(opts.by != null ? opts.by : r.by != null ? r.by : q.by), by =b && typeof b === 'object' ? { user: b.user, host: b.host } : typeof b === 'string' ? b : 'dashboard'
  const who = typeof by === 'object' ? by.user : by, chg = r.action === 'change_answer'
  const p = pathNow(opts, id, r.id, r.path), fw = firstWords(r.text || '')
  const subject = cpSlice(r.action === 'expire' ? `question expired ${subj(p, id.session)}: ${fw}` : chg ? `${who} changed the answer to ${subj(p, id.session)}: ${fw}` : `${who} ${r.action === 'withdraw' ? 'withdrew' : 'answered'} ${subj(p, id.session)}: ${fw}`, NOTICE_SUBJECT_MAX)
  const body = { action: r.action, status: chg ? 'revised' : q.status, path: p, node_id: r.id || null, key: r.key != null ? r.key : null, scope: r.scope != null ? r.scope : null, host: opts.host || id.host || null,
    question: r.text || null, choices: q.choices, free: q.free, ...(q.answer ? { answer: q.answer } : {}), ...(chg ? { previous: q.previous || r.previous || null, revised: q.revised || 1 } : {}),
    by, entry_id: r.entry_id || null, session: id.session || null, project: id.project || null, agent: r.agent || null, asked_at: q.asked_at || null, ts: opts.ts || null }
  return { verb: ANSWER_NOTICE_VERB, subject, body, to: toOf(r), agent: r.agent || r.owner || null, now: true }
}
/**
 * Several notices for ONE session (actionNotice2's) → ONE { subject, body }: "robin skipped 2 items and abandoned 1 in Rel"
 * — per action in first-seen order, the noun on the first group (and again where it changes), "in" the deepest common
 * container (a plan item's parent; another node itself), else the session's name. body = { actions, count, session, project,
 * host }. One notice is returned as it is.
 * @param {Array<{ subject: string, body: any }>} notices
 */
export function combineActionNotices2(notices) {
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
  const segs = p => { const r = parsePath2(p || ''); return r.ok ? r.segs : [] }
  const containers = acts.map(a => { const s = segs(a.path); return NOTICE_NOUN[a.action] === 'item' ? s.slice(0, -1) : s })
  let common = containers[0] || []
  for (const c of containers) { let i = 0; while (i < common.length && i < c.length && labelKey(common[i]) === labelKey(c[i])) i++; common = common.slice(0, i) }
  const subject = cpSlice(`${users.join(', ')} ${said} in ${subj(formatPath2(common), first.session)}`, NOTICE_SUBJECT_MAX)
  return { subject, body: { actions: acts, count: acts.length, session: first.session || null, project: first.project || null, host: first.host || null } }
}

// ---------------------------------------------------------------------------------------------------------------
// passes (the owner's expiry pass; retention)

/**
 * The grace pass (Q44): every transient context EMPTY for at least its grace period vanishes (entry stub + `remove`
 * why:"transient"); an emptied transient parent then starts ITS grace (or vanishes at once without one). Returns the
 * records / entry stubs written. Run it with the owner's expiry pass (and the replay re-runs it, step 3).
 * @param {any} state @param {number} now
 */
export function sweepTransients(state, now) {
  const records = [], entries = [], writes = []
  for (const sess of state.sessions.values()) {
    const due = [...sess.nodes.values()].filter(n => n.transient && n.empty_since != null && n.grace_ms && now - n.empty_since >= n.grace_ms)
    for (const n of due) {
      if (!sess.nodes.has(n.id) || n.empty_since == null || childrenOf2(sess, n).length) continue
      const t = newTx(state, sess, now)
      removeNode(t, n, 'transient')
      records.push(...t.records); entries.push(...t.entries); writes.push(...t.writes)
    }
  }
  return { records, entries, writes }
}

/**
 * Alias lifetime (§3.3 (c)): an alias expires `log_retention_days` after it was made or last used; one whose node is gone
 * (removed: no longer live) is dropped too. Returns how many were dropped.
 * @param {any} state @param {number} now
 */
export function expireAliases(state, now) {
  let n = 0
  for (const sess of state.sessions.values()) for (const [k, a] of [...sess.aliases]) if (now - a.used > state.retentionMs || !sess.nodes.has(a.id)) { sess.aliases.delete(k); n++ }
  return n
}

/**
 * Ghost lifetime (§5.1): a ghost lives until retention drops its last entry — and while a ghost BELOW it still lives (a
 * ghost chain links a removed grandchild to its live ancestor). `retainFrom` = the oldest retained ms. A ghost that
 * leaves the table frees its key (the scope index entry). 2a's stand-in for "its last entry" is `last_ts` (the removal;
 * step 6 reads the index files). Returns the ids dropped.
 * @param {any} state @param {number} retainFrom
 */
export function pruneGhosts(state, retainFrom) {
  const dropped = []
  for (const sess of state.sessions.values()) {
    const memo = new Map()
    const keep = id => {
      if (memo.has(id)) return memo.get(id)
      memo.set(id, true)   // a cycle guard (never expected)
      const g = sess.ghosts.get(id)
      let k = !!g && g.last_ts >= retainFrom
      for (const c of sess.gkids.get(id) || []) if (keep(c)) k = true
      memo.set(id, k)
      return k
    }
    for (const id of [...sess.ghosts.keys()]) {
      if (keep(id)) continue
      const g = sess.ghosts.get(id)
      sess.ghosts.delete(id)
      const s = sess.gkids.get(g.parent); if (s) { s.delete(id); if (!s.size) sess.gkids.delete(g.parent) }
      if (g.creator != null && sess.scope.get(scopeKey(g.creator, g.key)) === id) sess.scope.delete(scopeKey(g.creator, g.key))
      dropped.push(id)
    }
  }
  return dropped
}

/**
 * Remove a node from the board (dismiss / evict / expire — the callers are 2c's actions and the expiry pass): a
 * transaction of its own, returning the records and entry stubs. The session root can't be removed.
 * @param {any} state @param {any} sess @param {string} id @param {string} why @param {number} now
 */
export function removeById(state, sess, id, why, now) {
  const n = sess.nodes.get(id)
  if (!n) return bad('unknown-node', `${id} is not on the board`)
  if (n.parent == null) return bad('bad-remove', 'the session root cannot be removed')
  const t = newTx(state, sess, now)
  removeNode(t, n, why)
  return { ok: true, records: t.records, entries: t.entries, writes: t.writes }
}

// ===============================================================================================================
// BUILD STEP 3 (docs/spec-88.md §2, §5.1, §5.3, §8 step 3): the v6 RECORDS read back — recordKind2, the expiry pass that
// writes its removals, checkpoints (cp / rep) and carry-forward (cf, which carries STRUCTURE too), and the REPLAY: a
// chronological fold of node records (each changes one thing; `create` begins a run) and entries attached by `n` — no
// path remapping. A replayed model equals the live one (tests/unit/test_activity3_unit.mjs fuzzes it). The day files, the
// per-day index files and the conflicted-copy rule live in lib/activity2-files.js; rebuildGhosts2 (below) turns the index
// files' `struct` into the ghost table.

/** The node-record ops (§2.1). */
export const NODE_OPS = Object.freeze(['create', 'label', 'move', 'rank', 'item', 'type', 'keep', 'merge', 'unmerge', 'remove'])
const NODE_OP_SET = new Set(NODE_OPS)
/**
 * A JSONL record's kind (format v6 ONLY, §2 / §7.5): 'node' (a node record), 'entry' (a logged entry), 'cp' (a checkpoint),
 * 'cf' (a carry-forward), 'rep' (a repeat line — told by its `rep` array; its `n` is a repeat COUNT, never a node id) — or
 * null for anything else (a v2 – v5 record, a garbled line): skipped like any line the reader can't use.
 * @param {any} r @returns {'node'|'entry'|'cp'|'cf'|'rep'|null}
 */
export function recordKind2(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.v !== ACTIVITY2_FORMAT) return null
  if (Array.isArray(r.rep)) return Number.isFinite(r.last) && r.rep.every(k => Number.isInteger(k)) ? 'rep' : null
  if (typeof r.session !== 'string' || !r.session.trim() || !Number.isFinite(r.ts) || typeof r.n !== 'string' || !ID_RE.test(r.n)) return null
  if (r.kind === 'node') return NODE_OP_SET.has(r.op) ? 'node' : null
  if (r.kind === 'cp') return Number.isInteger(r.k) ? 'cp' : null
  if (r.kind === 'cf') return 'cf'
  if (r.kind != null) return null
  return typeof r.id === 'string' && typeof r.text === 'string' && ACTIVITY_STATES.includes(r.state) ? 'entry' : null
}

// ---------------------------------------------------------------------------------------------------------------
// the owner's EXPIRY pass (1.7x `expire` on ids) — it WRITES its removals (`remove` why:"expire"), so the replay folds them
// at the moment they happened instead of deciding them again later

/**
 * Remove LOCAL agents that finished more than `finished_visible_hours` ago (each with its subtree) and ENDED plans that
 * long after they ended (planRemoval2: the plan node with its items when it is a plain context, else its items; a
 * test-run's bucket goes with its run) — never anything holding part of an OPEN plan. Each removal is a `remove` record,
 * why "expire" (+ the transient vanish it may cause). → { records, entries, writes, removed:[{ ident, id, key, label, path }] }
 * @param {any} state @param {number} now
 */
export function expire2(state, now) {
  const win = Math.max(0, Number(state.config.finished_visible_hours) || 0) * HOUR
  const out = { records: [], entries: [], writes: [], removed: [] }
  for (const sess of [...state.sessions.values()]) {
    const t = newTx(state, sess, now)
    let open = openPlanIds(sess)
    const gone = n => { out.removed.push({ ident: { ...sess.ident }, id: n.id, key: n.key, label: n.label, path: pathOf(sess, n) }); removeNode(t, n, 'expire'); open = openPlanIds(sess) }
    for (const n of [...sess.nodes.values()]) if (sess.nodes.get(n.id) === n && n.kind === 'agent' && !n.merged_into && n.finished_at && now - n.finished_at >= win && !open.has(n.id)) gone(n)
    for (const n of [...sess.nodes.values()]) {
      if (sess.nodes.get(n.id) !== n || n.merged_into) continue
      const p = planOf2(sess, n), end = p ? planEndAt2(sess, n, p) : null
      if (end == null || now - end < win || p.items.some(i => open.has(i.id)) || inRunPlan2(sess, n, p)) continue
      for (const r of planRemoval2(sess, n, p)) if (sess.nodes.get(r.id) === r) gone(r)
    }
    out.records.push(...t.records); out.entries.push(...t.entries); out.writes.push(...t.writes)
  }
  return out
}
/**
 * The whole owner's pass at `now`: question expiry (expireQuestions2), the transient grace sweep (sweepTransients) and the
 * removals (expire2), in that order — every write to persist. → { writes, expired, removed }
 * @param {any} state @param {number} now
 */
export function expirePass2(state, now) {
  const q = expireQuestions2(state, now), s = sweepTransients(state, now), e = expire2(state, now)
  return { writes: [...q.writes, ...s.writes, ...e.writes], expired: q.expired, removed: e.removed }
}

// ---------------------------------------------------------------------------------------------------------------
// checkpoints (§2.3: cp / rep — a log:false report writes no entry; its node is `cp_dirty` until the next checkpoint)

const cloneJ = v => (v == null ? null : JSON.parse(JSON.stringify(v)))
/** A node's LINE STATE as a cp / cf restates it: the line (details / data included), state, bar, ETA, its kept test-result
 * (2d), its activity and — an agent / the root — finished_at + the plan-end marker. */
const lineSnap = n => ({ current: cloneJ(n.current), state: stateOf(n), progress: cloneJ(n.progress), eta_at: n.eta_at || null, test: cloneJ(n.test),
  last_activity: n.last_activity, stale_after_ms: n.stale_after_ms || null, ...(n.kind !== 'context' ? { finished_at: n.finished_at || null, plan_end: cloneJ(n.plan_end) } : {}),
  ...(n.first_started_at != null || n.attempts ? { timing: { started_at: n.started_at, ended_at: n.ended_at, first_started_at: n.first_started_at, took: n.took, took_total: n.took_total, attempts: n.attempts } } : {}) })
/** One node's checkpoint line (`k` = its key in today's file). */
function checkpointOf2(sess, node, now, k) {
  return { v: ACTIVITY2_FORMAT, kind: 'cp', k, ts: now, n: node.id, ...lineSnap(node), created_at: node.created_at, rank: node.rank || null, ...identOf(sess) }
}
const repRecord2 = r => ({ v: ACTIVITY2_FORMAT, rep: r.keys.slice(), n: r.n, since: r.since, last: r.last })
/**
 * The checkpoint writes due now (the gateway calls this every `progress_checkpoint_sec`, then appends / rewrites them in
 * order) — 1.7x's planCheckpoints on ids. Every node a log:false report touched since the last call (`cp_dirty`) is either
 * CHANGED (its line state differs from what its newest record left — `cp_sig` — or it has no key in today's file yet) → a
 * full `cp` line, or UNCHANGED → its key joins this interval's repeat line (rewritten in place while the key set is exactly
 * the same and nothing else was written since). A new local day starts a new file: keys restart at 1.
 * @param {any} state @param {number} now @returns {{ kind:'cp'|'rep', rewrite?:boolean, rec:any }[]}
 */
export function planCheckpoints2(state, now) {
  const day = localDay(now)
  if (!state.cp || state.cp.day !== day) state.cp = { day, keys: new Map(), next: 1, rep: null }
  const cp = state.cp, same = []
  /** @type {{ kind:'cp'|'rep', rewrite?:boolean, rec:any }[]} */
  const writes = []
  for (const sess of state.sessions.values()) for (const n of sess.nodes.values()) {
    if (!n.cp_dirty) continue
    n.cp_dirty = false
    let k = cp.keys.get(n.id)
    if (k === undefined || cpSig(n) !== n.cp_sig) {
      if (k === undefined) { k = cp.next++; cp.keys.set(n.id, k) }
      writes.push({ kind: /** @type {'cp'} */ ('cp'), rec: checkpointOf2(sess, n, now, k) })
      n.cp_sig = cpSig(n)
    } else same.push(k)
  }
  if (writes.length || !same.length) cp.rep = null   // a cp line (or an interval with no unchanged node) closes it
  if (!same.length) return writes
  same.sort((a, b) => a - b)
  if (cp.rep && cp.rep.keys.join() === same.join()) { cp.rep.n++; cp.rep.last = now; writes.push({ kind: 'rep', rewrite: true, rec: repRecord2(cp.rep) }) }
  else { cp.rep = { keys: same, since: now, last: now, n: 1 }; writes.push({ kind: 'rep', rewrite: false, rec: repRecord2(cp.rep) }) }
  return writes
}
/**
 * Every dirty node's cp NOW (a clean shutdown's flush); `{ withRep: true }` returns the whole plan (the repeat line too).
 * @param {any} state @param {number} now @param {{ withRep?: boolean }} [opts]
 */
export function flushCheckpoints2(state, now, opts = {}) {
  const plan = planCheckpoints2(state, now)
  return opts && opts.withRep ? plan : plan.filter(w => w.kind === 'cp')
}

// ---------------------------------------------------------------------------------------------------------------
// carry-forward (§2.3: `cf` carries STRUCTURE too — a node's `create` may be older than the replay window)

/** One node's carry-forward record: its structure (creator + its chain, key, kind, type, label, parent, rank, plan item,
 * transient + grace + empty_since, merged_into / from, implicit, runs, created_at, run_at), its line state, its own entry
 * count (`log_n`) and the aliases that name it. The root's also carries the session's last_activity. */
export function carryOf2(sess, node, now) {
  const aliases = [...sess.aliases.values()].filter(a => a.id === node.id).map(a => ({ path: a.path, at: a.at, used: a.used }))
  return { v: ACTIVITY2_FORMAT, kind: 'cf', ts: now, n: node.id, c: node.creator, scope: node.scope, key: node.key, nk: node.kind, type: node.type, label: node.label,
    ...(node.asked ? { asked: node.asked } : {}), p: node.parent, rank: node.rank || null, ...(node.plan ? { plan_item: true, plan_ix: node.plan_ix } : {}),
    ...(node.transient ? { transient: true, grace_ms: node.grace_ms || null, empty_since: node.empty_since } : {}),
    ...(node.merged_into ? { merged_into: node.merged_into, merged_from: node.merged_from } : {}),
    implicit: !!node.implicit, runs: node.runs || 1, created_at: node.created_at, run_at: node.run_at, ...lineSnap(node),
    log_n: node.log.length + node.log_dropped, aliases, ...(node.parent == null ? { session_last_activity: sess.last_activity } : {}), ...identOf(sess) }
}
/**
 * The CARRY-FORWARD records the gateway writes into the NEW day's file at each local day rollover (and once after a
 * restart's replay when today's file has none yet): a full snapshot of EVERY node in memory (open plan items, agents,
 * contexts, hidden merged nodes, the root) — parents first, hidden merged nodes after their visible siblings. Carrying only
 * the nodes whose create would fall out of the window (§2.3's first rule) is not enough: an ancestor created inside the
 * window would miss the activity its older (not yet restated) child gave it before the cf — the window fuzz found it. So
 * the newest cf in the window restates the whole board, and every node alive at that rollover is known from there on.
 * → [{ kind:'cf', rec }]
 * @param {any} state @param {number} now
 */
export function planCarryForward2(state, now) {
  const out = []
  for (const s of [...state.sessions.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const walk = n => {
      out.push({ kind: /** @type {'cf'} */ ('cf'), rec: carryOf2(s, n, now) })
      const hidden = kidIds(s, n.id).map(id => s.nodes.get(id)).filter(c => c && c.merged_into).sort((a, b) => (a.id < b.id ? -1 : 1))
      for (const c of [...childrenOf2(s, n), ...hidden]) walk(c)
    }
    walk(rootOf(s))
  }
  if (out.length && state.cp) state.cp.rep = null
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// the REPLAY (§8 step 3): fold v6 records chronologically into a fresh set of sessions — no journal and no checks (the live
// apply made them), no new records: a transient context that empties starts its grace (`empty_since`) but never vanishes
// on its own (its `remove` record follows in the file)

/** The replay's session for a record's identity (created with its root on first use: created_at = the record's s0). */
function rSession(state, sessions, rec) {
  const ident = { realm: (rec.realm && String(rec.realm).trim()) || 'default', project: rec.project == null ? '' : String(rec.project), user: rec.user == null ? '' : String(rec.user), session: String(rec.session).trim(), host: state.origin }
  const key = sessionKey(ident)
  let s = sessions.get(key)
  if (!s) {
    const at = Number.isFinite(rec.s0) && rec.s0 > 0 ? rec.s0 : rec.ts, rootId = mintId(ident, '', '')
    s = { key, ident, created_at: at, last_activity: at, rootId, nodes: new Map(), kids: new Map(), scope: new Map(), labels: new Map(), aliases: new Map(), ghosts: new Map(), gkids: new Map() }
    s.nodes.set(rootId, newNode({ id: rootId, key: '', creator: null, chain: '', scope: '', kind: 'session', label: ident.session, parent: null, now: at, implicit: true }))
    sessions.set(key, s)
  }
  return s
}
const setOf = (map, id) => { let k = map.get(id); if (!k) map.set(id, k = new Set()); return k }
const unGhost = (sess, id) => { const g = sess.ghosts.get(id); if (!g) return null; sess.ghosts.delete(id); const gk = sess.gkids.get(g.parent); if (gk) { gk.delete(id); if (!gk.size) sess.gkids.delete(g.parent) } return g }
/** Hang `node` under its `parent` id (which may not be held yet: a node carried later): kids, the label index (never over a
 * live sibling that holds the label — a move's relabel follows in its own record), and a grace mark cleared (an arrival). */
function rAttach(sess, node) {
  if (node.parent == null) return
  setOf(sess.kids, node.parent).add(node.id)
  if (!node.merged_into) { const ix = labelIx(node.parent, node.label), h = sess.labels.get(ix); if (!h || h === node.id || !sess.nodes.has(h)) sess.labels.set(ix, node.id) }
  const p = sess.nodes.get(node.parent)
  if (p && p.empty_since != null) p.empty_since = null
}
function rDetach(sess, node) {
  if (node.parent == null) return
  const k = sess.kids.get(node.parent); if (k) { k.delete(node.id); if (!k.size) sess.kids.delete(node.parent) }
  const ix = labelIx(node.parent, node.label); if (sess.labels.get(ix) === node.id) sess.labels.delete(ix)
}
function rRelabel(sess, node, label) {
  rDetach(sess, node)
  node.label = label
  if (node.parent != null) { setOf(sess.kids, node.parent).add(node.id); if (!node.merged_into) { const ix = labelIx(node.parent, label), h = sess.labels.get(ix); if (!h || h === node.id || !sess.nodes.has(h)) sess.labels.set(ix, node.id) } }
}
/** A transient context whose last live child left starts its grace period (Q44); without one its `remove` record follows. */
function rLeft(sess, parentId, ts) {
  const p = sess.nodes.get(parentId)
  if (!p || p.kind !== 'context' || !p.transient || p.merged_into || !p.grace_ms || p.empty_since != null) return
  if (!childrenOf2(sess, p).length) p.empty_since = ts
}
function rAlias(sess, path, id, ts) {
  if (!path) return
  sess.aliases.set(labelKey(path), { id, path, at: ts, used: ts })
  const mine = [...sess.aliases].filter(([, a]) => a.id === id).sort((x, y) => x[1].used - y[1].used)
  for (let i = 0; i < mine.length - LIMITS2.aliasesPerNode; i++) sess.aliases.delete(mine[i][0])
}
/** A node and its subtree leave memory into the ghost table (removeNode's state change; nothing written). An id the replay
 * does not hold (its run began before the window and it was not carried) takes its held descendants with it. */
function rRemove(sess, id, why, ts) {
  const top = sess.nodes.get(id), ids = new Set(), stack = [id]
  while (stack.length) { const x = stack.pop(); if (ids.has(x)) continue; ids.add(x); for (const c of sess.kids.get(x) || []) stack.push(c) }
  if (top) rDetach(sess, top)
  const parentId = top ? top.parent : null
  for (const x of ids) {
    const n = sess.nodes.get(x)
    sess.kids.delete(x)
    if (!n) continue
    if (x !== id && !n.merged_into) { const ix = labelIx(n.parent, n.label); if (sess.labels.get(ix) === x) sess.labels.delete(ix) }
    sess.nodes.delete(x)
    sess.ghosts.set(x, { id: x, key: n.key, creator: n.creator, chain: n.chain, scope: n.scope, kind: n.kind, label: n.label, parent: n.parent,
      removed_at: ts, last_ts: ts, why: x === id ? why : 'parent', transient: n.transient, grace_ms: n.grace_ms, runs: n.runs, type: n.type })
    setOf(sess.gkids, n.parent).add(x)
  }
  for (const [k, a] of [...sess.aliases]) if (ids.has(a.id)) sess.aliases.delete(k)
  if (parentId != null) rLeft(sess, parentId, ts)
}
/** A report's ACTIVITY (touch): target..owner and the calling agent; the owner stops being implicit; the session header. */
function rTouch(sess, node, ts, staleMs, callerId, setStale = true) {
  const owner = ownerOf2(sess, node)
  const bump = n => { n.last_activity = Math.max(n.last_activity, ts); if (setStale) n.stale_after_ms = staleMs || null; n.gone_at = null }
  for (let n = node; n; n = n.parent != null ? sess.nodes.get(n.parent) : null) { bump(n); if (n === owner) break }
  const caller = callerId ? sess.nodes.get(callerId) : null
  if (caller && caller.kind === 'agent' && caller !== owner) bump(caller)
  owner.implicit = false
  sess.last_activity = Math.max(sess.last_activity, ts)
}
/** The line state a cp / cf restates. */
function rLineSnap(node, r) {
  node.current = r.current && typeof r.current === 'object' && typeof r.current.text === 'string' ? cloneJ(r.current) : null
  node.progress = r.progress && typeof r.progress === 'object' ? cloneJ(r.progress) : null
  node.eta_at = Number.isFinite(r.eta_at) ? r.eta_at : null
  node.test = r.test && typeof r.test === 'object' ? cloneJ(r.test) : null
  if (node.kind !== 'context') { node.finished_at = Number.isFinite(r.finished_at) ? r.finished_at : null; node.plan_end = r.plan_end && typeof r.plan_end === 'object' ? cloneJ(r.plan_end) : null }
  const tm = r.timing && typeof r.timing === 'object' ? r.timing : {}, num = v => (Number.isFinite(v) ? v : null)
  node.started_at = num(tm.started_at); node.ended_at = num(tm.ended_at); node.first_started_at = num(tm.first_started_at); node.took = num(tm.took)
  node.took_total = num(tm.took_total) || 0; node.attempts = Number.isInteger(tm.attempts) ? tm.attempts : 0
}
/** A node built from a record that restates it whole (a create, or a cf of a node the replay does not hold yet). */
function rNewNode(rec, at, parent) {
  const kind = rec.nk === 'agent' ? 'agent' : 'context', scope = typeof rec.scope === 'string' ? rec.scope : ''
  return newNode({ id: rec.n, key: String(rec.key), creator: rec.c, chain: kind === 'agent' ? (scope ? scope + '/' : '') + rec.key : null, scope, kind,
    label: String(rec.label), parent, now: at, asked: rec.asked || null, transient: rec.transient === true, grace_ms: rec.grace_ms || null, implicit: rec.implicit === true,
    runs: Number.isInteger(rec.runs) && rec.runs > 0 ? rec.runs : 1, plan_ix: rec.plan_item === true && Number.isInteger(rec.plan_ix) ? rec.plan_ix : null, rank: rec.rank || null, type: rec.type || null })
}

/**
 * Step 4: the replay's chronological FOLD on its own — one record at a time, oldest first — so the conversion
 * (lib/activity2-convert.js) keeps a model that IS the replay of what it has written so far. createReplay2's finish() is
 * this fold over its buffer. fold(rec, kind?, day?, mapOnly?) applies one record (kind = recordKind2(rec) when not given;
 * day = the file it came from, default its own local day — a cp key is per file; mapOnly = a cp read past the window only
 * for its key); `sessions` is the live result while folding; finish() drops what hangs from no root, installs the
 * sessions into state.sessions (with the entry seq and today's cp keys) and answers the stats.
 * @param {any} state @param {{ now?: number|null, cutoff?: number }} [o]  now: "today" (cf_today, today's cp keys); cutoff:
 *   the window start (a node a cf restates whose run began before it gets log_floor = cutoff)
 */
export function createFold2(state, { now = null, cutoff = -Infinity } = {}) {
  const N = state.config.log_entries_per_agent, sessions = new Map(), pend = new Map(), cpKeys = new Map(), today = Number.isFinite(now) ? localDay(now) : null
  const st = { entries: 0, records: 0, cps: 0, reps: 0, cfs: 0, cf_today: false, pending_dropped: 0 }
  let maxSeq = 0
  const findNode = id => { for (const s of sessions.values()) { const n = s.nodes.get(id); if (n) return { sess: s, node: n } } return null }
  const pushLog = (node, small) => { node.log.push(small); if (node.log.length > N) { const d = node.log.length - N; node.log.splice(0, d); node.log_dropped += d } }
  /** @param {any} rec @param {string|null} [kind] @param {string|null} [day] @param {boolean} [mapOnly] */
  function fold(rec, kind = null, day = null, mapOnly = false) {
    kind = kind || recordKind2(rec)
    if (!kind) return
    day = day || localDay(kind === 'rep' ? rec.last : rec.ts)
    if (kind === 'cp') { let m = cpKeys.get(day); if (!m) cpKeys.set(day, m = new Map()); m.set(rec.k, rec.n); if (mapOnly) return }
    if (kind === 'rep') {
      st.reps++
      const m = cpKeys.get(day)
      for (const k of rec.rep) { const id = m ? m.get(k) : null, f = id && findNode(id); if (f) rTouch(f.sess, f.node, rec.last, null, null, false) }
      return
    }
    const sess = rSession(state, sessions, rec)
    if (kind === 'entry') {
      st.entries++
      if (typeof rec.id === 'string' && rec.id.startsWith(state.idPrefix)) { const m = /-([0-9a-z]+)$/.exec(rec.id); if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 36) || 0) }
      const report = rec.type !== 'event', touches = report && !rec.by
      const node = sess.nodes.get(rec.n)
      if (!node) {   // not held (yet): its run began before the window — a cf restates it later (its log's head), else dropped
        if (!sess.ghosts.has(rec.n)) { let p = pend.get(rec.n); if (!p) pend.set(rec.n, p = []); p.push(smallOf(rec)) }
        if (touches) sess.last_activity = Math.max(sess.last_activity, rec.ts)
        return
      }
      if (rec.current) {
        const c0 = node.current, kept = typeof rec.line_id === 'string', set = rec.line === true && !kept
        node.current = { id: kept ? rec.line_id : rec.id, ts: rec.ts, text: typeof rec.line_text === 'string' && rec.line_text ? rec.line_text : rec.text, state: rec.state,
          details: set ? (rec.details != null ? rec.details : null) : kept ? (rec.line_details != null ? rec.line_details : null) : c0 ? c0.details || null : null,
          data: set ? (rec.data != null ? rec.data : null) : kept ? (rec.line_data != null ? rec.line_data : null) : c0 && c0.data != null ? c0.data : null,
          ...(rec.line_by ? { by: rec.line_by } : {}), ...(rec.question ? { question: rec.question } : {}) }
        if (node.kind !== 'context') node.finished_at = Number.isFinite(rec.finished_at) ? rec.finished_at : FINAL.has(rec.state) ? node.finished_at || rec.ts : null
        Object.assign(node, timingStep(node, rec.state, rec.ts, rec.type === 'test-result' && rec.fields && Number.isFinite(rec.fields.duration) ? rec.fields.duration : null))
      }
      if (typeof rec.plan_end === 'string') node.plan_end = rec.plan_end === 'open' ? null : { state: rec.plan_end, ts: rec.ts }
      if ('progress' in rec) node.progress = rec.progress ? { ...rec.progress } : null
      if ('eta_at' in rec) node.eta_at = rec.eta_at || null
      if (FINAL.has(stateOf(node))) node.eta_at = null
      const keepAs = MESSAGE_TYPES[rec.type] && MESSAGE_TYPES[rec.type].keep
      if (keepAs) node[keepAs] = { ...(rec.fields || {}), ts: rec.ts, entry: rec.id, state: stateOf(node) }
      else if (rec.test_cleared) node.test = null
      if (report) node.implicit = false
      if (touches) rTouch(sess, node, rec.ts, rec.stale_after_ms, rec.caller || null)
      pushLog(node, smallOf(rec))
      node.cp_sig = cpSig(node)
      return
    }
    if (kind === 'cp') {
      st.cps++
      const node = sess.nodes.get(rec.n)
      if (!node) return   // its cf (later) restates it
      rLineSnap(node, rec)
      node.implicit = false
      rTouch(sess, node, Number.isFinite(rec.last_activity) ? rec.last_activity : rec.ts, rec.stale_after_ms, null)
      node.cp_sig = cpSig(node)
      return
    }
    if (kind === 'cf') {
      st.cfs++
      if (day === today) st.cf_today = true
      let node = sess.nodes.get(rec.n)
      if (rec.n === sess.rootId) {
        if (Number.isFinite(rec.session_last_activity)) sess.last_activity = Math.max(sess.last_activity, rec.session_last_activity)
      } else {
        const fresh = !node
        if (fresh) {
          unGhost(sess, rec.n)
          node = rNewNode(rec, Number.isFinite(rec.created_at) ? rec.created_at : rec.ts, rec.p)
          sess.nodes.set(node.id, node)
          if (node.creator != null) sess.scope.set(scopeKey(node.creator, node.key), node.id)
          node.log = (pend.get(rec.n) || []).slice(-N)
          pend.delete(rec.n)
        } else rDetach(sess, node)
        node.type = rec.type || node.type
        node.asked = rec.asked || null
        node.merged_into = rec.merged_into || null; node.merged_from = rec.merged_into ? rec.merged_from || null : null
        node.parent = rec.p
        node.label = String(rec.label)
        rAttach(sess, node)
        node.rank = rec.rank || null
        node.plan = rec.plan_item === true; node.plan_ix = node.plan && Number.isInteger(rec.plan_ix) ? rec.plan_ix : null
        node.transient = rec.transient === true; node.grace_ms = node.transient && rec.grace_ms ? rec.grace_ms : null; node.empty_since = node.transient && Number.isFinite(rec.empty_since) ? rec.empty_since : null
        node.runs = Number.isInteger(rec.runs) && rec.runs > 0 ? rec.runs : node.runs
        node.created_at = Number.isFinite(rec.created_at) ? rec.created_at : node.created_at
        node.run_at = Number.isFinite(rec.run_at) ? rec.run_at : node.created_at
        if (fresh && node.run_at < cutoff) node.log_floor = cutoff
      }
      node.implicit = rec.implicit === true
      rLineSnap(node, rec)
      node.last_activity = Number.isFinite(rec.last_activity) ? rec.last_activity : node.last_activity
      node.stale_after_ms = rec.stale_after_ms > 0 ? rec.stale_after_ms : null
      if (Number.isInteger(rec.log_n) && rec.log_n >= node.log.length) node.log_dropped = rec.log_n - node.log.length
      for (const a of Array.isArray(rec.aliases) ? rec.aliases : []) {
        if (!a || typeof a.path !== 'string') continue
        const k = labelKey(a.path), had = sess.aliases.get(k)
        if (!had || had.at <= a.at) sess.aliases.set(k, { id: rec.n, path: a.path, at: a.at, used: Number.isFinite(a.used) ? a.used : a.at })
      }
      node.cp_sig = cpSig(node)
      return
    }
    // ---- a node record (§2.1)
    st.records++
    const node = sess.nodes.get(rec.n)
    if (rec.op === 'create') {
      if (node) rRemove(sess, node.id, 'run', rec.ts)   // a new run of a node still held (never written so; defensive)
      // a new run starts EMPTY: children hung under this id by the window's records while the replay did not hold it went
      // with its earlier run (removed with an ancestor the replay never held)
      for (const k of [...(sess.kids.get(rec.n) || [])]) rRemove(sess, k, 'parent', rec.ts)
      sess.kids.delete(rec.n)
      unGhost(sess, rec.n)
      pend.delete(rec.n)   // entries before a create belong to an earlier run
      const n = rNewNode(rec, rec.ts, rec.p)
      sess.nodes.set(n.id, n)
      rAttach(sess, n)
      if (n.creator != null) sess.scope.set(scopeKey(n.creator, n.key), n.id)
    } else if (rec.op === 'remove') {
      if (rec.n === sess.rootId) sessions.delete(sess.key)
      else rRemove(sess, rec.n, rec.why || 'dismiss', rec.ts)
    } else if (!node) {
      /* not held: its cf restates it (or it is gone) */
    } else if (rec.op === 'label') { rRelabel(sess, node, String(rec.label)); if (rec.was) rAlias(sess, rec.was, node.id, rec.ts) }
    else if (rec.op === 'move') { const from0 = node.parent; rDetach(sess, node); node.parent = rec.p; rAttach(sess, node); node.rank = rec.rank || null; if (rec.was) rAlias(sess, rec.was, node.id, rec.ts); rLeft(sess, from0, rec.ts) }
    else if (rec.op === 'rank') node.rank = rec.rank || null
    else if (rec.op === 'item') { node.plan = true; if (Number.isInteger(rec.plan_ix)) node.plan_ix = rec.plan_ix }
    else if (rec.op === 'type') { if (typeof rec.type === 'string') node.type = rec.type }
    else if (rec.op === 'keep') { node.transient = false; node.grace_ms = null; node.empty_since = null }
    else if (rec.op === 'merge') {
      const kids = Array.isArray(rec.kids) ? rec.kids : [], ranks = Array.isArray(rec.kid_ranks) ? rec.kid_ranks : []
      kids.forEach((id, j) => { const k = sess.nodes.get(id); if (!k) return; rDetach(sess, k); k.parent = rec.into; rAttach(sess, k); if (j < ranks.length) k.rank = ranks[j] || null })
      const from0 = node.parent
      rDetach(sess, node)
      node.merged_into = rec.into; node.merged_from = rec.from != null ? rec.from : from0; node.parent = rec.into
      rAttach(sess, node)
      if (rec.was) rAlias(sess, rec.was, node.id, rec.ts)
      rLeft(sess, from0, rec.ts)
    } else if (rec.op === 'unmerge') {
      rDetach(sess, node)
      node.merged_into = null; node.merged_from = null; node.parent = rec.p
      rAttach(sess, node)
      node.rank = rec.rank || null
    }
  }
  function finish() {
    // the tree holds only what hangs from a root (a node whose parent never came back is dropped, with its subtree)
    for (const s of sessions.values()) {
      const seen = new Set(), stack = [s.rootId]
      while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); for (const c of s.kids.get(x) || []) stack.push(c) }
      for (const id of [...s.nodes.keys()]) {
        if (seen.has(id)) continue
        const n = s.nodes.get(id)
        s.nodes.delete(id)
        if (n.creator != null && s.scope.get(scopeKey(n.creator, n.key)) === id) s.scope.delete(scopeKey(n.creator, n.key))
        const ix = labelIx(n.parent, n.label); if (s.labels.get(ix) === id) s.labels.delete(ix)
      }
      for (const [k, ids] of [...s.kids]) { if (!seen.has(k)) { s.kids.delete(k); continue } for (const id of [...ids]) if (!s.nodes.has(id)) ids.delete(id); if (!ids.size) s.kids.delete(k) }
      for (const [k, a] of [...s.aliases]) if (!s.nodes.has(a.id)) s.aliases.delete(k)   // an alias names a node on the board (§3.3 (b))
    }
    st.pending_dropped = [...pend.values()].reduce((a, p) => a + p.length, 0)
    state.sessions = sessions
    state.seq = Math.max(state.seq, maxSeq)
    const tk = cpKeys.get(today)
    if (tk && tk.size) { const keys = new Map(); let next = 1; for (const [k, id] of tk) { keys.set(id, k); next = Math.max(next, k + 1) } state.cp = { day: today, keys, next, rep: null } }
    else state.cp = null
    let nodes = 0, ghosts = 0
    for (const s of sessions.values()) { nodes += s.nodes.size; ghosts += s.ghosts.size }
    return { ...st, sessions: sessions.size, nodes, ghosts }
  }
  return { sessions, fold, finish, stats: st }
}
/**
 * The REPLAY of a host's v6 records (§8 step 3) — the 2.0 createReplay. feed() takes the records NEWEST FIRST, as the
 * backwards reader yields them (today's file from its end, then earlier days), with the DAY of the file each came from
 * (a cp key is per file); finish() folds them CHRONOLOGICALLY into a fresh set of sessions and installs it
 * (state.sessions is replaced). The fold:
 * - node records (§2.1) each change ONE thing — create (a new node, or a ghost's new RUN: same id), label, move, rank,
 *   item, type, keep, merge (A hidden under B; its `kids` under B at their `kid_ranks`), unmerge, remove (the node and its
 *   subtree into the ghost table; the session root's = the whole session) — plus the alias each `was` makes (§3.3) and a
 *   transient context's grace mark (`empty_since`) when its last child leaves;
 * - entries (§2.2) are attached by `n`: the node's own bounded log, its line (`current`: `line` says the entry SET the
 *   text — else the line keeps its text / details / data —, `line_id` a question's kept line), state, bar, ETA,
 *   finished_at, the plan-end marker, the kept test-result (`keep`) or its drop (`test_cleared`), and — a report, not a
 *   system entry — the activity of target..owner and of the `caller`;
 * - cp lines restate a node's line state (log:false), rep lines refresh the activity of the nodes they list (key → node
 *   by the same file's cp lines), cf lines restate a node WHOLE (structure, line, its entry count `log_n`, aliases).
 * The WINDOW: only records from `from` (default now − finished_visible_hours) are used — feed() answers 'old' before it
 * (keep reading a day while wantsOlder(day): a cp that an in-window rep line of that file still needs, for its key only).
 * A node whose run began earlier is restated by the window's cf lines; its entries fed before its first cf become its log's
 * head, and it gets `log_floor` = the window start (older entries are only in the files: §5.3 paging, step 6). Expiry,
 * eviction and the grace sweep are NOT re-run: their removals are records. The ghost table holds what the window removed;
 * rebuildGhosts2 adds the rest from the index files.
 * @param {any} state  createModel() — its sessions are REPLACED by finish()
 * @param {{ now: number, from?: number }} opts
 */
export function createReplay2(state, { now, from } = /** @type {any} */ ({})) {
  const cutoff = Number.isFinite(from) ? from : now - Math.max(0, Number(state.config.finished_visible_hours) || 0) * HOUR
  const buf = [], repNeed = new Map()
  let fed = 0, skipped = 0
  /** One record (newest first) from the file of `day` (default: its own local day). @returns {'ok'|'skip'|'old'} */
  function feed(rec, day) {
    const kind = recordKind2(rec)
    if (!kind) { skipped++; return 'skip' }
    const d = day || localDay(kind === 'rep' ? rec.last : rec.ts)
    if (kind === 'rep') {
      if (rec.last < cutoff) return 'old'
      let s = repNeed.get(d); if (!s) repNeed.set(d, s = new Set())
      for (const k of rec.rep) s.add(k)
    } else if (kind === 'cp') {
      const s = repNeed.get(d), needed = !!(s && s.has(rec.k))
      if (s) s.delete(rec.k)
      if (rec.ts < cutoff) { if (!needed) return 'old'; buf.push({ rec, kind, day: d, mapOnly: true }); fed++; return 'ok' }
    } else if (rec.ts < cutoff) return 'old'
    buf.push({ rec, kind, day: d }); fed++
    return 'ok'
  }
  /** Does `day`'s file still hold an older cp that an in-window rep line needs (keep reading it past the window)? */
  const wantsOlder = day => { const s = repNeed.get(day); return !!(s && s.size) }
  function finish() {
    const f = createFold2(state, { now, cutoff })
    for (let i = buf.length - 1; i >= 0; i--) { const { rec, kind, day, mapOnly } = buf[i]; f.fold(rec, kind, day, mapOnly) }
    return { fed, skipped, ...f.finish() }
  }
  return { feed, wantsOlder, finish, stats: () => ({ fed, skipped, buffered: buf.length }) }
}
/**
 * Convenience: replay `items` given CHRONOLOGICALLY (as written: oldest day first) — each a record, or { rec, day } (the
 * file it came from) — through createReplay2 NEWEST FIRST, stopping at the window as the bridge's reader does, and
 * install the result. → finish()'s stats.
 * @param {any} state @param {any[]} items @param {number} now @param {{ from?: number }} [opts]
 */
export function replayRecords2(state, items, now, opts = {}) {
  const rp = createReplay2(state, { now, from: opts.from })
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i], wrapped = !!(it && typeof it === 'object' && 'rec' in it && 'day' in it)
    const rec = wrapped ? it.rec : it, day = wrapped ? it.day : undefined
    const r = rp.feed(rec, day)
    if (r === 'old' && !rp.wantsOlder(day || (rec && localDay(Array.isArray(rec.rep) ? rec.last : rec.ts)))) break
  }
  return rp.finish()
}

/** The local midnight (ms) of a "YYYY-MM-DD" day. */
const dayStart = day => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day)); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null }
/**
 * The GHOST TABLE from the per-day index files (§5.1, §2.4: "rebuilt at startup from the index files' `struct` across
 * retention plus the replay"): folds every retained day's `struct` (node records + the structure of cf lines) oldest first,
 * and adds a ghost row for every node that ended REMOVED (with its subtree, as removeNode does) and that the replayed model
 * holds neither live nor as a ghost — so a node removed before the replay window still keeps its key (the scope index),
 * comes back as itself on a resurrection (§3.7, §3.8) and links a removed grandchild's entries to its live ancestor. Its
 * `last_ts` = the start of the newest retained day holding one of its entries (null: none — kept only as a chain link):
 * pruneGhosts(state, retainFrom) then drops it with that day (§5.1: "until retention drops its last entry"). Sessions the
 * model does not hold are skipped. Call it after the replay. → { added }
 * @param {any} state @param {any[]} indexes  index objects (lib/activity2-files.js: readIndexes / the writer's today)
 */
export function rebuildGhosts2(state, indexes) {
  const list = [...(indexes || [])].filter(x => x && Array.isArray(x.struct)).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const T = new Map(), kids = new Map(), lastDay = new Map()
  const setP = (x, p) => { if (x.p != null) { const k = kids.get(x.p); if (k) k.delete(x.id) } x.p = p; if (p != null) setOf(kids, p).add(x.id) }
  for (const idx of list) {
    for (const id of Object.keys(idx.nodes || {})) lastDay.set(id, idx.day)
    for (const s of idx.struct) {
      const ident = Array.isArray(idx.sessions) ? idx.sessions[s.s] : null
      if (!ident || typeof s.n !== 'string') continue
      let x = T.get(s.n)
      if (s.op === 'create' || s.op === 'cf') {
        if (!x) T.set(s.n, x = { id: s.n, p: null })
        Object.assign(x, { ident, key: String(s.key), c: s.c == null ? null : s.c, scope: typeof s.scope === 'string' ? s.scope : '', nk: s.nk, type: s.type || null, label: String(s.label),
          transient: !!s.transient, grace_ms: s.grace_ms || null, runs: Number.isInteger(s.runs) && s.runs > 0 ? s.runs : 1, removed: null })
        setP(x, s.p == null ? null : s.p)
        continue
      }
      if (!x) continue
      if (s.op === 'label') x.label = String(s.label)
      else if (s.op === 'move' || s.op === 'unmerge') setP(x, s.p)
      else if (s.op === 'merge') { setP(x, s.into); for (const k of Array.isArray(s.kids) ? s.kids : []) { const y = T.get(k); if (y) setP(y, s.into) } }
      else if (s.op === 'type') x.type = s.type || x.type
      else if (s.op === 'keep') { x.transient = false; x.grace_ms = null }
      else if (s.op === 'remove') {
        const stack = [x.id], seen = new Set()
        while (stack.length) {
          const id = stack.pop(); if (seen.has(id)) continue; seen.add(id)
          const y = T.get(id)
          if (y && !y.removed) y.removed = { ts: s.ts, why: id === x.id ? s.why || 'dismiss' : 'parent' }
          for (const c of kids.get(id) || []) stack.push(c)
        }
      }
    }
  }
  let added = 0
  for (const x of T.values()) {
    if (!x.removed) continue
    const sess = state.sessions.get(sessionKey({ ...x.ident, host: state.origin }))
    if (!sess || sess.nodes.has(x.id) || sess.ghosts.has(x.id)) continue
    const kind = x.nk === 'agent' ? 'agent' : 'context'
    sess.ghosts.set(x.id, { id: x.id, key: x.key, creator: x.c, chain: kind === 'agent' ? (x.scope ? x.scope + '/' : '') + x.key : null, scope: x.scope, kind, label: x.label, parent: x.p,
      removed_at: x.removed.ts, last_ts: lastDay.has(x.id) ? dayStart(lastDay.get(x.id)) : null, why: x.removed.why, transient: x.transient, grace_ms: x.grace_ms, runs: x.runs, type: x.type || kind })
    setOf(sess.gkids, x.p).add(x.id)
    if (x.c != null && !sess.scope.has(scopeKey(x.c, x.key))) sess.scope.set(scopeKey(x.c, x.key), x.id)
    added++
  }
  return { added }
}
