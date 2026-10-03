// #88 (v2.0) build step 4: the CONVERSION LIBRARY — 1.7x activity history (record formats v2 – v5, path-keyed) into 2.0
// history (format v6, id-keyed), docs/spec-88.md §7.3, §8 step 4. Pure: no clock, no machine name (the host is a
// parameter), no wall-clock time — the same input gives the same bytes. Beside lib/activity2.js (the 2.0 model, its records
// and the replay) and lib/activity2-files.js (the day / index files, the Dropbox rule); used by nothing but its tests yet —
// step 5's migration script (src/tools/aimb-migrate-v2.mjs) drives it, step 6 wires the 2.0 files into the bridge.
//
// THE FORWARD PASS (§7.3): one chronological pass over the host's days, oldest first, record by record. Every v6 record it
// writes is FOLDED at once into a 2.0 model (createFold2 — the replay's own fold), so the pass always knows the tree as the
// 2.0 replay of what it has written so far, and the converted model IS that replay by construction. Beside the model it
// keeps, per session, the 1.7x PATH MAP (lc canonical v5 path → the id of the node there now), so a v5 record finds its node:
// - EXPIRY (1.7x's gc pass writes nothing; it ran every minute): before each record at T, what 1.7x's `expire` would have
//   removed by T — a finished agent, an ended plan (1.7x's plan rules: planOf17), finished_visible_hours after the end,
//   never part of an open plan — leaves with a `remove` (why "expire"); a node the record itself names is kept (1.7x still
//   held it); only once a gc minute has passed after its due time and after the record that made it a candidate; in the
//   order things fell due, and within one in 1.7x's node order (it decides what an ended plan takes); never between the
//   records of one call. And a record whose `new_from` is at or above a held node BEGINS a new run there (the old one ended unseen)
//   → `remove` (why "expire") of the held node, then a `create` (run:true) of the new one (new_from 0: the whole session
//   ended → the root's `remove`);
// - a node the record names that is not held and that no new_from covers began before the history the pass holds (the
//   oldest day, or a node 1.7x kept that the pass had dropped) → it is RESTATED by a `cf` (structure + line state);
// - `evicted:[…]` → `remove` why "evict" (first: they made room); `dismiss:true` → the dismissal entry on the PARENT (type
//   event, `of` = the removed id — 2.0's form, Q54) + `remove` why "dismiss" (the root: the whole session);
// - `moved_from` → a `move` record (+ a `label` record when the new parent has a sibling of that label: the one duplicate
//   1.7x allowed, an agent `x` beside a context `@x`), the subtree's paths re-keyed; the move entry follows;
// - `plan_item` on a node that is not one yet → an `item` record; a first question line → a `type` record (question — a
//   1.7x question that later holds children stays one: answerable, an item of its parent's plan); `rank` on an existing
//   node → a `rank` record (a create / move carries its own; a cp restates it);
// - entries → v6 entries (`n`, `at` = the node's path then, `type` = the message type: question / answer / withdrawal /
//   expiry for a question's lifecycle, event for a dismissal, else note — a move / placement entry too, with its `act`:
//   as 1.7x applied it, it refreshes the session's activity and makes its node non-implicit; `line` = the entry set the
//   line's text / details / data; `took` (+ `took_total` / `attempts`) on the entry that ends an attempt); cp → v6 cp (its
//   `timing` stepped when its line changed); rep lines as they are (cp keys kept); 1.7x cf → v6 cf;
// - every DAY FILE starts with a carry-forward of the WHOLE board (planCarryForward2, as a 2.0 bridge writes at each
//   rollover — the 2.0 replay window needs every node's structure restated, §2.3): the day's own leading 1.7x cf lines are
//   folded first (they restate what 1.7x carried), then the whole board is written once;
// - what a 1.7x restart would FORGET is dropped where 1.7x dropped it: an implicit, line-less, childless node (an empty
//   grouping node — a session root too) that no 1.7x record has named within the replay window (finished_visible_hours)
//   is removed (why "expire") at the next day start and at the end.
// IDS (§1.2, §7.3, hole H7): a node's id is legacyId(host + session, its FINAL v5 path key) — so the pass runs TWICE: the
// first with provisional ids learns every run's final path; the second writes the real ids. Runs that share a final path
// share the id (a later run is a new run of the same node: the same key, creator and kind, `runs` counted) — unless their
// lifetimes overlap (a node moved onto a path another node had held): then the later-ending one keeps the plain id and the
// other gets legacyId(…, path + "\u0001<n>"). The session root keeps its minted id (mintId(session, "", "")).
// KEYS (§7.3): an agent's key = its segment (slugged when it is not a valid key — a ':' in it), a context's = slug(its
// label), a `?N` question = `?N` (the next free `?M` on a clash); unique per creator (`-2` …), creator = the owner at
// creation (the nearest agent at or above the new parent, else the session). LABELS = the segment; a clash with a live
// sibling (agent `x` + context `@x`) → the younger becomes `x (2)` (`asked`), listed in the report.
// THE DROPBOX RULE (§10): readV5Dir reads exact day-file names only; a conflicted copy (or any other odd name) is listed
// with its WARN line and never read; convertDir writes another directory only (never its own input), every file atomically.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { lc } from './keys.js'
import { recordKind, parsePath, formatPath, pathKey, legacyId, mintId, validKey, slugKey, uniqueKey, sessionKey, normBy, normQuestion, formatPath2, labelKey,
  ACTIVITY_STATES, parseProgress } from './activity.js'
import { ACTIVITY2_FORMAT, createModel, createFold2, getSession2, carryOf2, planCarryForward2, freeLabel, pathOf, capAt, childrenOf2, rootOf, timingStep } from './activity2.js'
import { classifyNames, nameWarning, linesOf, writeAtomic, buildIndex } from './activity2-files.js'

const HOUR = 3600000
const GC_MS = 60000   // 1.7x's gc pass (bridge.mjs ACT_GC_MS): expire() every minute
const QKEY_RE = /^\?\d+$/
const FINAL = new Set(['done', 'failed', 'abandoned'])
const PLAN_END = new Set(['done', 'abandoned'])
const finite = v => typeof v === 'number' && Number.isFinite(v)
const wPlanEnd = v => (v && typeof v === 'object' && PLAN_END.has(v.state) && finite(Number(v.ts)) ? { state: v.state, ts: Math.floor(Number(v.ts)) } : null)
const wProgress = p => { if (p === null || p === undefined) return null; const r = typeof p === 'object' ? parseProgress(p) : null; return r && r.ok ? r.value : null }

/**
 * A v5 LINE (a cp's / cf's `current`) → the 2.0 line ({ id, ts, text, state, details, data, by?, question? }) — what the 1.7x
 * replay makes of it (lineOf): a line needs a text; `line_by` is the line's `by`; data only an object.
 * @param {any} l
 */
function v6Line(l) {
  if (!l || typeof l !== 'object' || typeof l.text !== 'string' || !l.text) return null
  const by = l.line_by && typeof l.line_by === 'object' ? normBy(l.line_by) : null, q = normQuestion(l.question)
  return { id: String(l.id || ''), ts: finite(l.ts) ? l.ts : 0, text: l.text, state: ACTIVITY_STATES.includes(l.state) ? l.state : 'running',
    details: typeof l.details === 'string' && l.details ? l.details : null, data: l.data != null && typeof l.data === 'object' ? l.data : null,
    ...(by ? { by } : {}), ...(q ? { question: q } : {}) }
}
/** A node's TIME as a cp / cf carries it, after its line becomes `line` (a log:false change seen only by its checkpoint:
 * timingStep at the line's own time) — or null when it never timed anything. */
function timingAfter(node, line) {
  const t = { started_at: node.started_at, ended_at: node.ended_at, first_started_at: node.first_started_at, took: node.took, took_total: node.took_total || 0, attempts: node.attempts || 0 }
  const c0 = node.current
  if (line && (!c0 || c0.id !== line.id || c0.ts !== line.ts || c0.state !== line.state)) Object.assign(t, timingStep(t, line.state, line.ts, null))
  return t.first_started_at != null || t.attempts ? t : null
}

/** The input days, oldest first: [{ day, records:[ a record object, a JSON line, or null (garbled) ] }]. */
function normDays(days) {
  const out = []
  for (const d of Array.isArray(days) ? days : []) {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.day))) throw new Error(`convertV5: bad day ${d && d.day}`)
    const recs = (Array.isArray(d.records) ? d.records : []).map(r => { if (typeof r !== 'string') return r && typeof r === 'object' ? r : null; try { return JSON.parse(r) } catch { return null } })
    out.push({ day: String(d.day), records: recs })
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
}

/**
 * CONVERT a host's 1.7x history (§7.3): `days` = [{ day:"YYYY-MM-DD", records:[…] }] (each day file's records in file order:
 * objects, JSON lines, or null for a garbled line) → { days:[{ day, records:[v6 records] }] (the same days, each record filed
 * in the day file its source came from), report, model (the 2.0 model the converted days replay to — createModel's,
 * sessions installed), paths:{ [sessionKey]: { [v5 path key]: id } } (the live nodes' final v5 paths → ids) }.
 * opts.host = the host that owns the directory (its gateway's host name: every id hashes it, §1.2) — required; opts.config =
 * the host's `activity` config block (finished_visible_hours = the replay window the forgetting follows; log_entries_per_agent);
 * opts.forget = false keeps what a 1.7x restart would forget (the live tree as it was, every empty grouping node included).
 * Deterministic: the same input gives the same records (byte for byte once serialised).
 * @param {any[]} days @param {{ host: string, config?: any, forget?: boolean }} opts
 */
export function convertV5(days, opts) {
  const host = opts && typeof opts.host === 'string' ? opts.host.trim() : ''
  if (!host) throw new Error('convertV5: opts.host (the host whose directory this is) is required')
  const input = normDays(days)
  const o = { host, config: (opts && opts.config) || {}, forget: !(opts && opts.forget === false) }
  const p1 = forward(input, o, null)
  const ids = assignIds(p1.runs)
  const p2 = forward(input, o, ids)
  if (p2.runs.length !== p1.runs.length || p2.runs.some((r, i) => r.final !== p1.runs[i].final || r.sk !== p1.runs[i].sk))
    throw new Error('convertV5: the id pass diverged from the first pass (a bug in the conversion)')
  return { days: p2.days, report: p2.report, model: p2.model, paths: p2.paths }
}

/**
 * The FINAL ids of the runs (§7.3): runs grouped by (session, final v5 path); the group's plain id goes to the run that
 * ended last (or is live) and to every earlier run that ended before the next holder began — later runs of one node;
 * an overlapping run takes the next free variant ("\u0001<n>" after the path). → ids[run index]
 * @param {any[]} runs
 */
function assignIds(runs) {
  const groups = new Map()
  for (const r of runs) { const k = r.sk + '\n' + r.final; let g = groups.get(k); if (!g) groups.set(k, g = []); g.push(r) }
  const ids = new Array(runs.length)
  for (const g of groups.values()) {
    const end = r => (r.end == null ? Infinity : r.end)
    g.sort((a, b) => end(b) - end(a) || b.start - a.start)
    const slots = []   // { minStart }
    for (const r of g) {
      let j = slots.findIndex(s => end(r) <= s.minStart)   // (a run that ends where the next begins: one after the other)
      if (j < 0) { j = slots.length; slots.push({ minStart: r.start }) } else slots[j].minStart = Math.min(slots[j].minStart, r.start)
      ids[r.i] = legacyId(r.ident, j === 0 ? r.final : `${r.final}\u0001${j + 1}`)
    }
  }
  return ids
}

/** One forward pass (see the head of this file). ids = null: provisional ids (pass 1). */
function forward(input, o, ids) {
  const host = o.host
  const state = createModel({ origin: host, config: o.config })
  const fold = createFold2(state, {})
  state.sessions = fold.sessions   // live while folding (getSession2 / planCarryForward2 read it); finish() installs it again
  const win = Math.max(0, Number(state.config.finished_visible_hours) || 0) * HOUR
  const runs = [], S = new Map()
  const report = { host, days: input.length, records_in: 0, records_out: 0, skipped: 0, entries: 0, sessions: 0, nodes: 0, ghosts: 0, runs: 0,
    created: 0, restated: 0, moved: 0, removed: { expire: 0, evict: 0, dismiss: 0, forgotten: 0 }, relabelled: /** @type {any[]} */ ([]), keyed: /** @type {any[]} */ ([]),
    per_day: /** @type {any[]} */ ([]) }
  let op = 0, curDay = '', out = /** @type {any[]} */ ([]), silent = false, lastTs = null, curT = -Infinity
  const outDays = []
  /** Write one v6 record (and fold it). A silent cf (a day's leading 1.7x cf, restated again by the whole board) is folded only. */
  const emit = rec => { if (!(silent && rec.kind === 'cf')) out.push(rec); fold.fold(rec, null, curDay); op++; return rec }

  // ---- sessions: the converter's side of one (session, host): the v5 path map, keys used, identities, when each node was named
  function sessFor(rec) {
    const ident = { realm: (rec.realm && String(rec.realm).trim()) || 'default', project: rec.project == null ? '' : String(rec.project), user: rec.user == null ? '' : String(rec.user), session: String(rec.session).trim(), host }
    const sk = sessionKey(ident)
    let s = S.get(sk)
    if (!s) S.set(sk, s = { sk, ident, rootId: mintId(ident, '', ''), pmap: new Map(), pkOf: new Map(), runOf: new Map(), lastSeen: new Map(), used: new Set(), identity: new Map(), introduced: new Set(), nextDue: -Infinity, ord: new Map(), dirtyAt: -Infinity, appeared: new Map() })
    return s
  }
  const model = s => fold.sessions.get(s.sk) || null
  /** The session in the model, made just before a record of it is written (as the replay's rSession makes it from that
   * record: created_at = its s0) — never for a record that writes nothing. */
  const open = (s, rec) => { if (!model(s)) getSession2(state, s.ident, finite(rec.s0) && rec.s0 > 0 ? rec.s0 : rec.ts) }
  const identF = s => { const m = model(s), i = m.ident; return { realm: i.realm, session: i.session, project: i.project, user: i.user, host, origin: host, s0: m.created_at } }
  // who did it: a node record names a DASHBOARD (by / act, as 2.0's record() does); an entry any author (the bridge's "bridge" too)
  const byF = rec => { const b = normBy(rec && rec.by); return b && typeof b === 'object' ? { by: b, ...(typeof rec.act === 'string' ? { act: rec.act } : {}) } : {} }
  const byE = rec => { const b = normBy(rec && rec.by); return b ? { by: b, ...(typeof rec.act === 'string' ? { act: rec.act } : {}) } : typeof rec.act === 'string' ? { act: rec.act } : {} }
  const seen = (s, id, ts) => { if (!(s.lastSeen.get(id) >= ts)) s.lastSeen.set(id, ts) }
  // a record that may make something due to expire NOW (structure; an agent finishing or a plan ending — an inner plan that
  // ended long ago is due at once when the open plan around it ends) makes its session's next expiry check a full one;
  // anything else can only make a due time later than now (nextDue, from the last full check, still holds)
  const dirty = s => { s.nextDue = -Infinity; s.dirtyAt = curT }
  const nodeRecord = (s, op0, ts, n, fields) => { dirty(s); return emit({ v: ACTIVITY2_FORMAT, kind: 'node', op: op0, ts, n, ...fields, ...identF(s) }) }

  // ---- runs and identities
  function newRun(s, pk) {
    const run = { i: runs.length, sk: s.sk, ident: s.ident, start: op, end: /** @type {number|null} */ (null), final: pk }
    runs.push(run)
    const id = ids ? ids[run.i] : legacyId(s.ident, '\u0001run\u0001' + run.i)
    const m = model(s)
    if (m && m.nodes.has(id)) throw new Error(`convertV5: id ${id} is still live (a bug in the id assignment)`)
    return { run, id }
  }
  // ord: the place of a node in 1.7x's node map (its insertion order: a node is appended when made, and a moved subtree is
  // re-appended, depth first) — 1.7x's expiry pass walks it in that order, and the order decides what an ended plan takes
  let ordSeq = 0
  const register = (s, id, pk, run) => { s.pmap.set(pk, id); s.pkOf.set(id, pk); s.runOf.set(id, run); s.ord.set(id, ++ordSeq) }
  const reorder = (s, id) => { const m = model(s), walk = x => { s.ord.set(x, ++ordSeq); for (const c of m.kids.get(x) || []) walk(c) }; walk(id) }
  /** The creator (owner at creation) of a node new under `parentId`: the nearest agent at or above it, else the root. */
  function creatorUnder(s, parentId) {
    const m = model(s)
    for (let n = m.nodes.get(parentId); n; n = n.parent != null ? m.nodes.get(n.parent) : null) if (n.kind === 'agent') return { id: n.id, chain: n.chain }
    return { id: s.rootId, chain: '' }
  }
  /** A node's identity (key, creator, scope, kind) — minted on its first run, kept for every later run of its id. */
  function identityOf(s, id, parentId, seg) {
    let idn = s.identity.get(id)
    if (idn) return idn
    const cr = creatorUnder(s, parentId), taken = k => s.used.has(cr.id + '\n' + k)
    let key
    if (seg.kind === 'context' && QKEY_RE.test(seg.name)) {   // a bridge-made question: `?N` (#85's @?N), the next free `?M` on a clash
      key = seg.name
      if (taken(lc(key))) { let n = 0; for (const u of s.used) { const m = u.startsWith(cr.id + '\n?') && /^\?(\d+)$/.exec(u.slice(cr.id.length + 1)); if (m) n = Math.max(n, Number(m[1])) } key = `?${n + 1}` }
    } else if (seg.kind === 'agent') { const v = validKey(seg.name); key = uniqueKey(v.ok ? v.key : slugKey(seg.name), taken) }
    else key = uniqueKey(slugKey(seg.name), taken)
    if (seg.kind === 'agent' && key !== seg.name && ids) report.keyed.push({ session: s.ident.session, name: seg.name, key })
    s.used.add(cr.id + '\n' + lc(key))
    idn = { key, c: cr.id, scope: cr.chain, nk: seg.kind, runs: 0 }
    s.identity.set(id, idn)
    return idn
  }
  function labelFor(s, parentId, name, selfId = null) {
    const fl = freeLabel(model(s), parentId, name, selfId)
    if (fl.sibling && ids) report.relabelled.push({ session: s.ident.session, path: pathOf(model(s), model(s).nodes.get(parentId)), label: name, got: fl.label })
    return fl
  }

  // ---- node records
  /** CREATE (a run begins here: new_from) the node at segs[0..i) under parentId. isT: it is the record's target. */
  function createAt(s, rec, segs, i, parentId, T, isT) {
    const seg = segs[i - 1], pk = pathKey(formatPath(segs.slice(0, i)))
    const { run, id } = newRun(s, pk)
    const idn = identityOf(s, id, parentId, seg)
    idn.runs++
    const fl = labelFor(s, parentId, seg.name)
    const plan = isT && seg.kind === 'context' && rec.plan_item === true, ix = plan && Number.isInteger(rec.plan_ix) ? rec.plan_ix : null
    const type = seg.kind === 'agent' ? 'agent' : isT && rec.current === true && rec.question ? 'question' : 'context'
    nodeRecord(s, 'create', T, id, { c: idn.c, scope: idn.scope, key: idn.key, nk: seg.kind, type, label: fl.label, p: parentId, rank: isT && typeof rec.rank === 'string' && rec.rank ? rec.rank : null, run: true,
      ...(fl.sibling ? { asked: seg.name } : {}), ...(ix != null ? { plan_item: true, plan_ix: ix } : {}), ...(!isT ? { implicit: true } : {}), ...(idn.runs > 1 ? { runs: idn.runs } : {}) })
    register(s, id, pk, run)
    report.created++
    if (plan && ix == null) nodeRecord(s, 'item', T, id, {})   // a plan item with no plan position (a first todo line): its own record, as 2.0 writes it
    return id
  }
  /** RESTATE (a `cf`) a node the pass does not hold and no new_from covers: its run began before the history held. v5cf = the
   * 1.7x cf that restates it (its line state), else it is restated line-less and implicit (the record that names it follows). */
  function introduceAt(s, rec, segs, i, parentId, T, v5cf, extra = null) {
    const seg = segs[i - 1], pk = pathKey(formatPath(segs.slice(0, i)))
    const { run, id } = newRun(s, pk)
    const idn = identityOf(s, id, parentId, seg)
    if (!idn.runs) idn.runs = 1
    const fl = labelFor(s, parentId, seg.name)
    // created: what 1.7x's replay makes of it — the record's own time, or a cf's created_at (for the ancestors it names too)
    const cAt = rec && rec.kind === 'cf' && finite(rec.created_at) ? Math.min(rec.created_at, rec.ts) : T
    const line = v5cf ? v6Line(v5cf.current) : null
    const type = seg.kind === 'agent' ? 'agent' : line && line.question ? 'question' : 'context'
    const plan = !!v5cf && seg.kind === 'context' && v5cf.plan_item === true
    const la = v5cf && finite(v5cf.last_activity) ? Math.min(v5cf.last_activity, v5cf.ts) : cAt
    emit({ v: ACTIVITY2_FORMAT, kind: 'cf', ts: T, n: id, c: idn.c, scope: idn.scope, key: idn.key, nk: seg.kind, type, label: fl.label, ...(fl.sibling ? { asked: seg.name } : {}), p: parentId,
      rank: extra && extra.rank ? extra.rank : v5cf && typeof v5cf.rank === 'string' && v5cf.rank ? v5cf.rank : null, ...(plan ? { plan_item: true, plan_ix: Number.isInteger(v5cf.plan_ix) ? v5cf.plan_ix : null } : {}),
      implicit: v5cf ? v5cf.implicit === true : true, runs: idn.runs, created_at: cAt, run_at: cAt,
      current: line, state: line ? line.state : 'running', progress: v5cf ? wProgress(v5cf.progress) : null, eta_at: v5cf && finite(v5cf.eta_at) && !(line && FINAL.has(line.state)) ? v5cf.eta_at : null, test: null,
      last_activity: la, stale_after_ms: v5cf && v5cf.stale_after_ms > 0 ? v5cf.stale_after_ms : null,
      ...(seg.kind === 'agent' ? { finished_at: v5cf ? finAt(v5cf, line) : null, plan_end: v5cf ? wPlanEnd(v5cf.plan_end) : null } : {}),
      log_n: v5cf && Number.isInteger(v5cf.log_n) && v5cf.log_n >= 0 ? v5cf.log_n : 0, aliases: [...(v5cf ? movedAliases(v5cf) : []), ...(extra && extra.aliases ? extra.aliases : [])], ...identF(s) })
    dirty(s)
    register(s, id, pk, run)
    s.introduced.add(id)
    report.restated++
    return id
  }
  /** An agent's finished_at as a v5 cp / cf states it (the 1.7x replay's rule). */
  const finAt = (r, line) => (finite(r.finished_at) ? r.finished_at : line && FINAL.has(line.state) ? line.ts : null)
  /** A v5 cf's `moved` history → aliases (its earlier v5 paths, written without the at-signs: §3.3, §7.3). */
  function movedAliases(r) {
    const out = []
    for (const mv of Array.isArray(r.moved) ? r.moved : []) {
      if (!mv || typeof mv.from !== 'string' || !finite(mv.at)) continue
      const pp = parsePath(mv.from)
      if (pp.ok && pp.segs.length) out.push({ path: formatPath2(pp.segs.map(x => x.name)), at: mv.at, used: mv.at })
    }
    return out
  }
  /** REMOVE a held node (+ its subtree): one `remove` record; the path map forgets the subtree, its runs end. */
  function removeRec(s, id, why, T, extra = {}) {
    const m = model(s), node = m && m.nodes.get(id)
    if (!node) return
    nodeRecord(s, 'remove', T, id, { why, was: pathOf(m, node), ...extra })
    const pk = s.pkOf.get(id)
    if (pk != null) for (const [k, x] of [...s.pmap]) if (k === pk || k.startsWith(pk + '/')) { s.pmap.delete(k); s.pkOf.delete(x); const run = s.runOf.get(x); if (run) { run.end = op; s.runOf.delete(x) } }
    report.removed[why === 'expire' && extra.forgotten ? 'forgotten' : why]++
  }
  /** The whole SESSION leaves (its root's `remove`): a dismissal of the session, or new_from 0 (it ended unseen). */
  function removeSession(s, why, T, extra = {}) {
    if (!model(s)) return
    nodeRecord(s, 'remove', T, s.rootId, { why, was: '', ...extra })
    for (const [x, run] of s.runOf) { run.end = op; s.pkOf.delete(x) }
    s.pmap.clear(); s.runOf.clear(); s.pkOf.clear()
    report.removed[why === 'expire' && extra.forgotten ? 'forgotten' : why]++
  }
  /** Re-key a moved subtree in the path map (old v5 path → new). */
  function repath(s, oldPk, newPk) {
    for (const [k, x] of [...s.pmap]) {
      if (k !== oldPk && !k.startsWith(oldPk + '/')) continue
      const nk = newPk + k.slice(oldPk.length)
      s.pmap.delete(k); s.pmap.set(nk, x); s.pkOf.set(x, nk)
      const run = s.runOf.get(x); if (run) run.final = nk
    }
  }
  /**
   * The node chain root → segs[0..upto) of a record: held nodes, else created (new_from at or above: a new run — a held node
   * there ended unseen and is removed first) or restated (a `cf`). v5cf: the record is a 1.7x cf (it restates its target).
   */
  function ensureChain(s, rec, segs, nf, T, upto, v5cf) {
    const chain = [s.rootId]
    let how = 'held'   // what became of the LAST node: held | created | restated
    for (let i = 1; i <= upto; i++) {
      const pk = pathKey(formatPath(segs.slice(0, i)))
      let id = s.pmap.get(pk)
      const isNew = nf != null && i >= nf
      how = 'held'
      if (id && isNew) { removeRec(s, id, 'expire', T); id = null }
      if (!id) {
        if (isNew) { id = createAt(s, rec, segs, i, chain[i - 1], T, i === segs.length); how = 'created' }
        else { id = introduceAt(s, rec, segs, i, chain[i - 1], T, i === segs.length ? v5cf : null); how = 'restated' }
      }
      chain.push(id)
    }
    return { chain, how }
  }
  /** Before a record's own write: `plan_item` → an `item` record, a first question line → a `type` record, `rank` on an
   * existing node → a `rank` record. */
  function nodeChanges(s, rec, id, T, line, created) {
    const node = model(s).nodes.get(id)
    if (rec.plan_item === true && node.kind === 'context' && !node.plan) nodeRecord(s, 'item', T, id, Number.isInteger(rec.plan_ix) ? { plan_ix: rec.plan_ix } : {})
    if (line && line.question && node.kind === 'context' && node.type !== 'question') nodeRecord(s, 'type', T, id, { type: 'question' })
    if (!created && rec.kind == null && 'rank' in rec && typeof rec.moved_from !== 'string' && (rec.rank || null) !== (node.rank || null)) nodeRecord(s, 'rank', T, id, { rank: rec.rank || null, ...byF(rec) })
  }

  // ---- entries
  /** A v5 entry → its v6 entry on node `id` (o.dismiss: the dismissal entry, on the parent, `of` the removed id). */
  function entryOf(s, rec, id, o = {}) {
    const m = model(s), node = m.nodes.get(id), c0 = node.current, cur = rec.current === true && !o.dismiss
    const kept = cur && typeof rec.line_id === 'string', q = cur ? normQuestion(rec.question) : null
    let type = 'note', fields = null
    if (o.dismiss) type = 'event'
    else if (q && q.status === 'asked' && !kept) { type = 'question'; fields = { ...(q.choices && q.choices.length ? { choices: q.choices } : {}), free: !!q.free, ...(q.expires_at ? { expires_at: q.expires_at } : {}) } }
    else if (q && q.status === 'answered') { type = 'answer'; const a = q.answer || {}; fields = { ...(a.choice ? { choice: a.choice } : {}), ...(a.text ? { text: a.text } : {}), ...(q.revised ? { revised: q.revised } : {}) } }
    else if (q && q.status === 'withdrawn') type = 'withdrawal'
    else if (q && q.status === 'expired') { type = 'expiry'; if (finite(q.expires_at) && finite(q.asked_at) && q.expires_at >= q.asked_at) fields = { after_ms: q.expires_at - q.asked_at } }
    // a 1.7x move / placement entry stays a NOTE with its `act` (as 1.7x applied it: the session's own refreshes its activity,
    // any makes the node non-implicit — an `event` would do neither); its node record carries the structure
    // `line`: the entry set the line's text / details / data (a v5 line always takes its entry's details / data) — omitted only
    // for a tick that keeps everything (the 2.0 fold then keeps the line's own)
    const same = c0 && (c0.details || null) === (typeof rec.details === 'string' && rec.details ? rec.details : null) && JSON.stringify(c0.data != null ? c0.data : null) === JSON.stringify(rec.data != null ? rec.data : null)
    const line = cur && !kept && !(typeof rec.line_text === 'string' && rec.line_text && same)
    const planEnd = typeof rec.plan_end === 'string' ? rec.plan_end : cur && rec.v < 5 && rec.state === 'abandoned' && node.kind !== 'context' ? 'abandoned' : null
    const e = /** @type {any} */ ({ v: ACTIVITY2_FORMAT, id: String(rec.id), ts: rec.ts, n: id, type, ...(fields && Object.keys(fields).length ? { fields } : {}), current: cur, text: rec.text, state: rec.state,
      at: capAt(o.at != null ? o.at : pathOf(m, node)) })
    if ('progress' in rec) e.progress = rec.progress && typeof rec.progress === 'object' ? rec.progress : null
    if ('eta_at' in rec) e.eta_at = finite(rec.eta_at) ? rec.eta_at : null
    if (rec.stale_after_ms > 0) e.stale_after_ms = rec.stale_after_ms
    if (line) e.line = true
    if (cur && typeof rec.line_text === 'string' && rec.line_text) e.line_text = rec.line_text
    if (cur && rec.line_by && typeof rec.line_by === 'object') e.line_by = normBy(rec.line_by)
    if (q) e.question = q
    if (planEnd) e.plan_end = planEnd
    if (kept) { e.line_id = rec.line_id; if (rec.line_details) e.line_details = rec.line_details; if (rec.line_data != null) e.line_data = rec.line_data }
    if (o.dismiss) { e.dismiss = true; if (o.of) e.of = o.of }
    Object.assign(e, byE(rec), identF(s), { details: typeof rec.details === 'string' && rec.details ? rec.details : null, data: rec.data != null ? rec.data : null })
    if (cur && node.kind !== 'context' && 'finished_at' in rec) e.finished_at = finite(rec.finished_at) ? rec.finished_at : null
    const a0 = node.attempts || 0
    if ((cur && FINAL.has(rec.state)) || planEnd) dirty(s)
    emit(e)
    report.entries++
    const n2 = m.nodes.get(id)   // TIME: the entry that ENDS an attempt carries its took (+ the total after a re-run), as 2.0 writes it
    if (n2 && (n2.attempts || 0) > a0) { e.took = n2.took; if (n2.attempts > 1) { e.took_total = n2.took_total; e.attempts = n2.attempts } }
    return e
  }

  // ---- one v5 record
  function evictions(s, rec, T) {
    for (const p of Array.isArray(rec.evicted) ? rec.evicted : []) { const q = parsePath(String(p)); const id = q.ok && q.key ? s.pmap.get(q.key) : null; if (id) removeRec(s, id, 'evict', T) }
  }
  function handle(rec, kind) {
    const pp = parsePath(rec.path)
    if (!pp.ok || pp.current) { report.skipped++; return }
    const s = sessFor(rec), T = rec.ts, segs = pp.segs, L = segs.length
    const nf = Number.isInteger(rec.new_from) && rec.new_from >= 0 ? rec.new_from : null
    if (kind === 'entry' && rec.dismiss === true) return dismissal(s, rec, pp)
    evictions(s, rec, T)
    if (nf === 0 && model(s)) removeSession(s, 'expire', T)   // the session itself is new: the one held ended unseen
    open(s, rec)
    if (kind === 'entry' && typeof rec.moved_from === 'string') return moved(s, rec, pp, nf)
    const v5cf = kind === 'cf' ? rec : null
    const { chain, how } = ensureChain(s, rec, segs, nf, T, L, v5cf)
    for (const id of chain) seen(s, id, T)
    const id = chain[L]
    if (kind === 'cf' || (kind === 'cp' && rec.current && FINAL.has(rec.current.state))) dirty(s)
    if (v5cf && finite(rec.created_at)) {   // a carried node's created_at dates the ancestors it names (1.7x's replay: the oldest it knows)
      const cAt = Math.min(rec.created_at, T), m = model(s)
      for (let i = 1; i < L; i++) { const a = m.nodes.get(chain[i]); if (a && s.introduced.has(a.id) && a.created_at > cAt) emit({ ...carryOf2(m, a, T), created_at: cAt, run_at: cAt, ...(a.last_activity === a.created_at ? { last_activity: cAt } : {}), ...identF(s) }) }
    }
    if (kind === 'entry') { nodeChanges(s, rec, id, T, rec.current === true ? { question: rec.question } : null, how === 'created'); entryOf(s, rec, id); return }
    if (kind === 'cp') {
      const line = v6Line(rec.current)
      nodeChanges(s, rec, id, T, line, true)
      if ('rank' in rec && how !== 'created' && (typeof rec.rank === 'string' && rec.rank ? rec.rank : null) !== (model(s).nodes.get(id).rank || null)) nodeRecord(s, 'rank', T, id, { rank: typeof rec.rank === 'string' && rec.rank ? rec.rank : null })   // a cp restates the stored rank (1.7x's replay reads it)
      const node = model(s).nodes.get(id), tm = timingAfter(node, line)
      emit({ v: ACTIVITY2_FORMAT, kind: 'cp', k: rec.k, ts: T, n: id, current: line, state: line ? line.state : 'running', progress: wProgress(rec.progress), eta_at: finite(rec.eta_at) && !(line && FINAL.has(line.state)) ? rec.eta_at : null,
        test: null, last_activity: T, stale_after_ms: node.stale_after_ms || null,
        ...(node.kind !== 'context' ? { finished_at: finAt(rec, line), plan_end: 'plan_end' in rec ? wPlanEnd(rec.plan_end) : node.plan_end || null } : {}),
        ...(tm ? { timing: tm } : {}), created_at: node.created_at, rank: node.rank || null, ...identF(s) })
      return
    }
    // a 1.7x cf: a node it introduced is already restated; a held (or just created) one is restated now (structure from the
    // model, line state from the cf)
    if (!(how === 'restated' && L > 0)) restate(s, rec, id)
  }
  /** A held node restated by a 1.7x cf: 2.0's cf of it (carryOf2: structure, aliases, count, time) with the cf's line state. */
  function restate(s, r, id) {
    const m = model(s), node = m.nodes.get(id), line = v6Line(r.current), base = carryOf2(m, node, r.ts), tm = timingAfter(node, line)
    const aliases = [...base.aliases]
    for (const a of movedAliases(r)) if (!aliases.some(x => labelKey(x.path) === labelKey(a.path))) aliases.push(a)
    const plan = node.kind === 'context' && (node.plan || r.plan_item === true)
    const rec = { ...base, ts: r.ts, rank: 'rank' in r ? (typeof r.rank === 'string' && r.rank ? r.rank : null) : base.rank,
      ...(plan ? { plan_item: true, plan_ix: node.plan_ix != null ? node.plan_ix : Number.isInteger(r.plan_ix) ? r.plan_ix : null } : {}),
      implicit: r.implicit === true, current: line, state: line ? line.state : 'running', progress: wProgress(r.progress), eta_at: finite(r.eta_at) && !(line && FINAL.has(line.state)) ? r.eta_at : null,
      last_activity: finite(r.last_activity) ? Math.min(r.last_activity, r.ts) : base.last_activity, stale_after_ms: r.stale_after_ms > 0 ? r.stale_after_ms : null,
      ...(node.kind !== 'context' ? { finished_at: finAt(r, line), plan_end: 'plan_end' in r ? wPlanEnd(r.plan_end) : base.plan_end } : {}),
      log_n: Number.isInteger(r.log_n) && r.log_n >= 0 ? r.log_n : base.log_n, aliases }
    delete rec.timing
    if (tm) rec.timing = tm
    if (line && line.question && node.kind === 'context') rec.type = 'question'
    // the identity fields stay last (as carryOf2 writes them)
    const id0 = identF(s)
    for (const k of Object.keys(id0)) delete rec[k]
    emit(Object.assign(rec, id0))
  }
  /** A MOVE (`moved_from`): the new parents (new_from may say they are new), a `move` record (+ a `label` record on a
   * clash), the subtree re-keyed, then its entry. A node the pass does not hold is created / restated at its new path. */
  function moved(s, rec, pp, nf) {
    const T = rec.ts, segs = pp.segs, L = segs.length
    const from = parsePath(rec.moved_from)
    const id0 = from.ok && from.key ? s.pmap.get(from.key) : null
    if (id0) { const m = model(s); for (let n = m.nodes.get(id0); n; n = n.parent != null ? m.nodes.get(n.parent) : null) seen(s, n.id, T) }   // its old parents were named then too
    const { chain } = ensureChain(s, rec, segs, nf, T, L - 1, null)
    let id = id0
    if (id && id === chain[L - 1]) id = null   // (defensive: never under itself)
    if (id) {
      const held = s.pmap.get(pp.key)
      if (held && held !== id) removeRec(s, held, 'expire', T)   // a node 1.7x had dropped still held at the destination
      const m = model(s), node = m.nodes.get(id), parentId = chain[L - 1]
      if (node.parent !== parentId) {
        const was = pathOf(m, node)
        // the one duplicate 1.7x allowed (an agent `x` beside a context `@x`) arriving by a move: the YOUNGER of the two is
        // relabelled "x (2)" (§7.3) — the sibling already there before the move, the moved node after it
        const sib = freeLabel(m, parentId, node.label, node.id).sibling
        const sibYounger = !!sib && (sib.created_at > node.created_at || (sib.created_at === node.created_at && sib.id > node.id))
        if (sibYounger) {
          const got = freeLabel(m, parentId, sib.label, null).label
          if (ids) report.relabelled.push({ session: s.ident.session, path: pathOf(m, m.nodes.get(parentId)), label: sib.label, got })
          nodeRecord(s, 'label', T, sib.id, { label: got, was: pathOf(m, sib) })
        }
        nodeRecord(s, 'move', T, id, { p: parentId, rank: typeof rec.rank === 'string' && rec.rank ? rec.rank : null, was, ...byF(rec) })
        if (sib && !sibYounger) { const fl = labelFor(s, parentId, node.label, node.id); nodeRecord(s, 'label', T, id, { label: fl.label, was }) }
        report.moved++
      } else if ('rank' in rec && (rec.rank || null) !== (node.rank || null)) nodeRecord(s, 'rank', T, id, { rank: rec.rank || null, ...byF(rec) })
      repath(s, from.key, pp.key)
      reorder(s, id)
    } else {
      const isNew = nf != null && L >= nf
      // not held (its run began before the history held): restated at its new path with the move's rank, its old path an alias
      id = isNew ? createAt(s, rec, segs, L, chain[L - 1], T, true) : introduceAt(s, rec, segs, L, chain[L - 1], T, null,
        { rank: typeof rec.rank === 'string' && rec.rank ? rec.rank : null, aliases: from.ok && from.segs.length ? [{ path: formatPath2(from.segs.map(x => x.name)), at: T, used: T }] : [] })
    }
    for (const x of [...chain, id]) seen(s, x, T)
    nodeChanges(s, { ...rec, rank: undefined }, id, T, null, true)
    entryOf(s, rec, id)
  }
  /** A DISMISSAL (`dismiss:true`): its entry on the PARENT (the root's on itself), then the node and its subtree leave. */
  function dismissal(s, rec, pp) {
    const T = rec.ts
    if (!pp.key) {   // the whole session
      if (!model(s)) return
      seen(s, s.rootId, T)
      entryOf(s, rec, s.rootId, { dismiss: true, of: s.rootId, at: '' })
      removeSession(s, 'dismiss', T, byF(rec))
      return
    }
    const id = s.pmap.get(pp.key), m = model(s)
    if (!m) return   // (a session the pass does not hold: nothing of it to remove)
    const parentId = id ? m.nodes.get(id).parent : pp.segs.length === 1 ? s.rootId : s.pmap.get(pathKey(formatPath(pp.segs.slice(0, -1))))
    if (parentId && m.nodes.has(parentId)) {
      for (let n = m.nodes.get(parentId); n; n = n.parent != null ? m.nodes.get(n.parent) : null) seen(s, n.id, T)
      entryOf(s, rec, parentId, { dismiss: true, of: id || null })
    }
    if (id) removeRec(s, id, 'dismiss', T, byF(rec))
  }
  /** FORGET what a 1.7x restart would not rebuild (see the head): implicit, line-less, childless nodes (bottom-up, then an
   * empty implicit session) no v5 record has named since T − the window. */
  function forget(T) {
    if (!win || !o.forget) return
    for (const s of S.values()) {
      const m = model(s)
      if (!m) continue
      for (let again = true; again;) {
        again = false
        for (const n of [...m.nodes.values()]) {
          if (n.parent == null || !m.nodes.has(n.id) || !n.implicit || n.current || n.progress || (m.kids.get(n.id) || new Set()).size) continue
          if ((s.lastSeen.get(n.id) || -Infinity) >= T - win) continue
          removeRec(s, n.id, 'expire', T, { forgotten: true }); again = true
        }
      }
      const root = rootOf(m)
      if (root && root.implicit && !root.current && !childrenOf2(m, root).length && !(m.kids.get(root.id) || new Set()).size && (s.lastSeen.get(root.id) || -Infinity) < T - win) removeSession(s, 'expire', T, { forgotten: true })
    }
  }

  // ---- EXPIRY as 1.7x's gateway did it live (its gc pass writes nothing): before each v5 record at T, what was due by T —
  // a finished agent, an ended plan, finished_visible_hours after it ended (1.7x `expire` = expire2's rules: never part of
  // an open plan; an ended plan's items, or its plain context node with them) — leaves with a `remove` (why "expire"). A
  // node the record itself names is kept: 1.7x still held it (its gc had not run yet; were it gone, new_from would say so).
  const isLive = n => !!(n.current && (n.current.state === 'running' || n.current.state === 'blocked'))
  // 1.7x's PLAN of a node (planOf / planEndAt — not 2.0's planOf2: a 1.7x question node can hold plan items, and its own
  // done / abandoned line ends their plan): its plan-item children + the questions beside them; it ends when every item is
  // done, when a context's own line is done / abandoned, or by an agent's / the session's plan-end marker
  // (the children unsorted — order does not matter here, and this runs on every expiry check)
  const kidsOf = (m, n) => { const out = []; for (const id of m.kids.get(n.id) || []) { const c = m.nodes.get(id); if (c && !c.merged_into) out.push(c) } return out }
  function planOf17(m, n) {
    const kids = kidsOf(m, n), items = kids.filter(c => c.plan)
    if (!items.length) return null
    for (const c of kids) if (!c.plan && c.current && c.current.question) items.push(c)
    let all = true, doneAt = 0
    for (const it of items) { if (it.current && it.current.state === 'done') doneAt = Math.max(doneAt, it.current.ts || 0); else all = false }
    return { items, allDoneAt: all ? doneAt : null }
  }
  function planEnd17(n, p) {
    if (!p) return null
    const ends = []
    if (p.allDoneAt != null) ends.push(p.allDoneAt)
    if (n.kind === 'context' && n.current && PLAN_END.has(n.current.state)) ends.push(n.current.ts || 0)
    if (n.plan_end && PLAN_END.has(n.plan_end.state)) ends.push(n.plan_end.ts || 0)
    return ends.length ? Math.min(...ends) : null
  }
  /** Every plan of a session now: [{ n, p, end }] (end null = open) + the OPEN set (an open plan's items and their ancestors). */
  function plansOf(m) {
    const plans = [], open = new Set()
    for (const pid of m.kids.keys()) {
      const n = m.nodes.get(pid)
      if (!n || n.merged_into) continue
      const p = planOf17(m, n)
      if (!p) continue
      const end = planEnd17(n, p)
      plans.push({ n, p, end })
      if (end == null) for (const it of p.items) for (let x = it; x && !open.has(x.id); x = x.parent != null ? m.nodes.get(x.parent) : null) open.add(x.id)
    }
    return { plans, open }
  }
  const removalOf = (m, n, p) => (n.kind === 'context' && n.parent != null && !n.plan && kidsOf(m, n).length === p.items.length && !isLive(n) ? [n] : p.items)
  function expireDue(T, skip) {
    if (!win) return
    for (const s of S.values()) {
      const m = model(s)
      if (!m || !(s.nextDue <= T)) continue
      const ordOf = x => (x === s.rootId ? 0 : s.ord.has(x) ? s.ord.get(x) : Infinity)
      let plans, open
      // a candidate is gone for sure once a gc pass has run after it fell due — and after the record that made it one (an item
      // added to a plan that had ended, a plan whose open neighbour ended): its due time + one gc interval (60 s)
      const since = key => { let a = s.appeared.get(key); if (a === undefined) s.appeared.set(key, a = s.dirtyAt); return a }
      const agentDue = n => (n.kind === 'agent' && n.finished_at && !n.merged_into && !open.has(n.id) ? Math.max(n.finished_at + win, since('a' + n.id + n.finished_at)) + GC_MS : null)
      const planDue = x => (x.end != null && !x.p.items.some(i => open.has(i.id)) ? Math.max(x.end + win, since('p' + x.n.id + x.end + ':' + x.p.items.length)) + GC_MS : null)
      // LOOK: the earliest thing due by T (at) and the next one after T. 1.7x's gc ran every minute, so what fell due in
      // between went in the order it fell due — a pass at each due time, in turn (the order decides what an ended plan takes:
      // its items alone while an agent beside them lives, the plain plan node with them once it has gone)
      for (;;) {
        ;({ plans, open } = plansOf(m))
        let at = Infinity, next = Infinity
        const see = (due, kept) => { if (due > T || kept) next = Math.min(next, Math.max(due, T)); else at = Math.min(at, due) }
        for (const n of m.nodes.values()) { const due = agentDue(n); if (due != null) see(due, skip.has(n.id)) }
        for (const x of plans) { const due = planDue(x); if (due != null) see(due, removalOf(m, x.n, x.p).some(r => skip.has(r.id))) }
        if (at === Infinity) { s.nextDue = next; break }
        const before = op
        // a pass at that time, in 1.7x's order (agents, then plans in its node order), re-reading what is open after each removal
        for (const n of [...m.nodes.values()]) {
          if (m.nodes.get(n.id) !== n) continue
          const due = agentDue(n)
          if (due == null || due > at || skip.has(n.id)) continue
          removeRec(s, n.id, 'expire', T); ({ plans, open } = plansOf(m))
        }
        for (const pid of [...m.kids.keys()].sort((x, y) => ordOf(x) - ordOf(y))) {
          const n = m.nodes.get(pid)
          if (!n || n.merged_into) continue
          const p = planOf17(m, n), due = p ? planDue({ n, p, end: planEnd17(n, p) }) : null
          if (due == null || due > at) continue
          const roots = removalOf(m, n, p)
          if (roots.some(r => skip.has(r.id))) continue
          for (const r of roots) if (m.nodes.get(r.id) === r) removeRec(s, r.id, 'expire', T)
          ;({ plans, open } = plansOf(m))
        }
        if (op === before) { s.nextDue = -Infinity; break }   // (defensive: a pass that removed nothing ends the catch-up)
      }
    }
  }
  /** The ids a v5 record names (its path's held chain; a move's old one too) — kept by expireDue. */
  function named(r) {
    const out = new Set(), pp = typeof r.path === 'string' ? parsePath(r.path) : null
    if (!pp || !pp.ok) return out
    const s = S.get(sessionKey({ realm: (r.realm && String(r.realm).trim()) || 'default', project: r.project == null ? '' : String(r.project), user: r.user == null ? '' : String(r.user), session: String(r.session).trim(), host }))
    if (!s) return out
    // (from new_from on, the nodes it names are NEW: a held one there had ended — it is not kept)
    const nf = Number.isInteger(r.new_from) && r.new_from >= 0 ? r.new_from : Infinity
    const add = (segs, upto = segs.length) => { for (let i = 1; i <= upto; i++) { const id = s.pmap.get(pathKey(formatPath(segs.slice(0, i)))); if (id) out.add(id) } }
    if (nf > 0) add(pp.segs, Math.min(pp.segs.length, nf - 1))
    if (typeof r.moved_from === 'string') { const f = parsePath(r.moved_from); if (f.ok) add(f.segs) }
    return out
  }

  // ---- the days
  for (const { day, records } of input) {
    curDay = day; out = []
    let i = 0, T0 = null
    for (const r of records) { const k = recordKind(r); if (k) { T0 = k === 'rep' ? r.last : r.ts; break } }
    report.records_in += records.length
    if (T0 != null) {
      // the day's leading 1.7x carry-forward (what 1.7x carried, so held then): expiry and forgetting first, then those cf lines
      // are folded, then the WHOLE board is written once
      let j = i
      const skip = new Set()
      for (; j < records.length; j++) { const r = records[j], k = recordKind(r); if (k === 'cf') { for (const x of named(r)) skip.add(x) } else if (k) break }
      curT = T0
      expireDue(T0, skip)
      forget(T0)
      silent = true
      for (; i < j; i++) { const r = records[i], k = recordKind(r); if (k === 'cf') handle(r, k); else report.skipped++ }
      silent = false
      if (fold.sessions.size) for (const w of planCarryForward2(state, T0)) emit(w.rec)
      for (const s of S.values()) dirty(s)
    }
    for (; i < records.length; i++) {
      const r = records[i], k = recordKind(r)
      if (!k) { report.skipped++; continue }
      if (k === 'rep') { emit({ v: ACTIVITY2_FORMAT, rep: r.rep.slice(), n: r.n, since: r.since, last: r.last }); lastTs = r.last; continue }
      curT = r.ts
      if (!(r.ts <= lastTs)) expireDue(r.ts, named(r))   // (not between the records of one call: they share its time — no gc pass ran between them)
      handle(r, k)
      lastTs = r.ts
    }
    outDays.push({ day, records: out })
    report.per_day.push({ day, records_in: records.length, records_out: out.length })
  }
  if (lastTs != null && outDays.length) { curDay = outDays[outDays.length - 1].day; out = outDays[outDays.length - 1].records; forget(lastTs); report.per_day[report.per_day.length - 1].records_out = out.length }
  const stats = fold.finish()
  const paths = /** @type {any} */ ({})
  for (const s of S.values()) if (state.sessions.has(s.sk)) paths[s.sk] = Object.fromEntries([...s.pmap].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
  Object.assign(report, { records_out: outDays.reduce((a, d) => a + d.records.length, 0), sessions: stats.sessions, nodes: stats.nodes, ghosts: stats.ghosts, runs: runs.length })
  return { days: outDays, report, model: state, paths, runs }
}

// ---------------------------------------------------------------------------------------------------------------
// files

/** A day's v6 records as the bytes of its day file (one JSON line each). @param {any[]} records */
export const dayBytes = records => Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''), 'utf8')

/**
 * Read a directory of 1.7x DAY FILES (the host's `activity/<host>/`, or the migration's backup of it): exact names only
 * (YYYY-MM-DD.jsonl); a Dropbox conflicted copy or any other odd name is listed with its WARN line and NEVER read (§10.6).
 * → { days:[{ day, records }], conflicted, unknown, tmp, warnings }
 * @param {string} dir @param {{ host?: string }} [o]  host: named in the warnings
 */
export function readV5Dir(dir, o = {}) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { }
  const c = classifyNames(names), where = path.basename(dir)
  const days = c.days.map(day => ({ day, records: linesOf(fs.readFileSync(path.join(dir, `${day}.jsonl`))).map(l => l.rec) }))
  return { days, conflicted: c.conflicted, unknown: c.unknown, tmp: c.tmp, warnings: [...c.conflicted, ...c.unknown].map(n => nameWarning(`activity/${where}`, o.host || where, n)) }
}

/**
 * CONVERT a directory of 1.7x day files into ANOTHER directory (never in place: the migration converts from its backup,
 * §7.2): every day file → a v6 day file of the same name + its index file (§2.4), each written atomically. Conflicted copies
 * (and other odd names) in the source are reported, not read, not copied.
 * → { report (+ conflicted, warnings), files:[{ day, size, sha256, index }], model, paths }
 * @param {{ srcDir: string, dstDir: string, host: string, config?: any }} o
 */
export function convertDir(o) {
  if (!o || !o.srcDir || !o.dstDir) throw new Error('convertDir: srcDir and dstDir are required')
  if (path.resolve(o.srcDir) === path.resolve(o.dstDir)) throw new Error('convertDir: the destination must be another directory (never the input)')
  const src = readV5Dir(o.srcDir, { host: o.host })
  const c = convertV5(src.days, { host: o.host, config: o.config })
  fs.mkdirSync(o.dstDir, { recursive: true })
  const files = []
  for (const d of c.days) {
    const buf = dayBytes(d.records), idx = buildIndex(d.day, buf)
    writeAtomic(path.join(o.dstDir, `${d.day}.jsonl`), buf)
    writeAtomic(path.join(o.dstDir, `${d.day}.idx.json`), JSON.stringify(idx))
    files.push({ day: d.day, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), index: `${d.day}.idx.json` })
  }
  return { report: { ...c.report, conflicted: src.conflicted, unknown: src.unknown, warnings: src.warnings }, files, model: c.model, paths: c.paths }
}
