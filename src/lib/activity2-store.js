// #88 (v2.0) build step 6: the 2.0 GATEWAY's activity STORE — the id-keyed model (lib/activity2.js) together with its
// FILES (the persistence facet's `activity2`: lib/activity2-files.js bound to the persistence directory), docs/spec-88.md
// §2.4, §5.1 – §5.3, §7.5, §10. bridge.mjs keeps the timers, the tools and the wire; this module is everything between a
// call and the bytes on disk, so the unit tests drive it on temp dirs without a bridge.
//
// THE STAGING (spec §8 step 6 "as built"): the bridge runs this store only with the pre-cutover switch
// AI_BRIDGE_ACTIVITY_V2=1 (tests, and a host that has been converted); without it the 1.7x board (lib/activity.js) serves
// as before, until step 9 switches the bridge for good. Gossip v6 is step 7, the per-user view state step 8, the 2.0 tool /
// script forms and guides step 9, the dashboard step 10.
//
// WHAT IT DOES
// - start(now): §7.5's START CHECK (lib/activity2-migrate.js startCheck2): v5 history or an unfinished migration → refused
//   (the bridge exits 78 with the message); no history and no marker → the marker is written (a fresh host).
// - open(now): RETENTION first (a day file and its index file go together), the directory SCAN (a Dropbox conflicted copy /
//   odd name → one WARN line per name, `fs_warnings` in the board head), the REPLAY of the window (createReplay2, newest
//   first, stopping at the window), the INDEXES (each closed day's index file — rebuilt when missing or stale — and today's
//   in memory), the GHOST TABLE (rebuildGhosts2 from the indexes' `struct`, each ghost's `last_ts` = the start of the newest
//   retained day holding one of its entries) and pruneGhosts.
// - apply / action calls write their records THROUGH THE WRITER (one writer per host); checkpoint / flush (cp + rep);
//   expire (the owner's pass, it writes its removals); rollover(now, why): the carry-forward into the new day (once per day,
//   and after a restart whose replay found none today), the index file of every closed day, retention, the scan, the
//   ghosts' days refreshed + pruneGhosts (a ghost leaves when retention drops its last entry).
// - LOG PAGES (§5.1 – §5.3): a node's merged log over its MEMBERS (the subtree now, by id; + its ghosts with removed:true —
//   "show removed", off by default), read through the INDEX: only the days that hold a member and, in each, only the byte
//   range [min first, max last] — backwards, so a page that fills early reads only the tail. Each member contributes its
//   CURRENT run (entries since its run began); a ghost all its retained entries. Exhausted → run_start (+ earlier_cursor when
//   an earlier run left entries; earlier:true pages those) or pruned (the run began in a day retention deleted). Without
//   files (no persistence) the members' in-memory logs serve.
import { lc, projKey } from './keys.js'
import { localDay, entryTime, renderText, formatPath2 } from './activity.js'
import * as A2 from './activity2.js'

const DAY = 86400000
/** The local midnight (ms) of a "YYYY-MM-DD" day. */
const dayStart = day => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day)); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null }
const utf8 = s => Buffer.byteLength(s, 'utf8')
const bad = (code, what, extra = {}) => ({ ok: false, code, what, ...extra })
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
/** A day-file page cursor (2.0): `f2.<day>.<offset>` = the entries BEFORE that byte offset of that day's file, then older days. */
export const fileCursor2 = (day, offset) => `f2.${day}.${Math.max(0, Math.floor(Number(offset) || 0))}`
/** @returns {{ day: string, offset: number } | null} */
export function parseFileCursor2(c) { const m = typeof c === 'string' && c.match(/^f2\.(\d{4}-\d{2}-\d{2})\.(\d{1,15})$/); return m ? { day: m[1], offset: Number(m[2]) } : null }
/** The 2.0 `log` tool's fields (lib/activity2.js parseCall) — what the bridge passes through from a tool call / a logger link. */
export const LOG2_FIELDS = Object.freeze(['agent', 'key', 'id', 'path', 'label', 'rename', 'under', 'under_id', 'move', 'move_id', 'merge', 'merge_id', 'move_to', 'unmerge', 'keep', 'transient',
  'before', 'before_id', 'after', 'after_id', 'position', 'plan', 'context_type', 'text', 'state', 'progress', 'eta', 'stale_after', 'details', 'data', 'log', 'ask', 'choices', 'free', 'expires',
  'message_type', 'fields'])
const seqOf = id => { const m = typeof id === 'string' && id.match(/-([0-9a-z]+)$/); const n = m ? parseInt(m[1], 36) : 0; return Number.isFinite(n) ? n : 0 }
const ordCmp = (a, b) => a.ts - b.ts || seqOf(a.id) - seqOf(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The 2.0 store of ONE host's gateway.
 * @param {{ host: string, fsx?: any, config?: any, idPrefix?: string, limits?: any, log?: (line: string) => void }} o
 *   fsx = the persistence facet's `activity2` (null / absent: a memory-only board); config = the resolved `activity` block
 */
export function createStore2(o) {
  const host = String(o.host || 'host'), fsx = o.fsx || null, log = typeof o.log === 'function' ? o.log : () => { }
  const state = A2.createModel({ origin: host, config: o.config || {}, idPrefix: o.idPrefix || 'act_', limits: o.limits })
  const writer = fsx ? fsx.writer(host) : null
  const seen = new Set()            // odd names already warned about (once per name)
  const closed = new Map()          // closed day -> { size, nodes } (its index's node map; struct only at open)
  let fsWarnings = /** @type {string[]} */ ([]), cfDay = /** @type {string|null} */ (null), rollDay = /** @type {string|null} */ (null), stats = /** @type {any} */ (null), lastCf = /** @type {any} */ (null)

  const retainFromDay = now => localDay(now - state.config.log_retention_days * DAY)
  /** Write a call's / a plan's records through the writer → true (all written), false (a write failed), null (no files). */
  function persist(writes) {
    if (!writer || !writes || !writes.length) return writer ? true : null
    try { writer.writeAll(writes); return true } catch (e) { log(`activity: day-file append failed: ${(e && e.message) || e}`); return false }
  }
  function scan() {
    if (!fsx) return []
    const s = fsx.scan(host, seen), v = fsx.scanViews(seen)
    for (const w of [...s.warnings, ...v.warnings]) log(`WARN ${w}`)
    fsWarnings = [...s.fs_warnings, ...v.fs_warnings]
    return s
  }
  /** Every retained day's node map, oldest first: closed days from their index files (cached, re-checked by size), today
   * from the writer's memory (a live lookup). → [{ day, get(id) }] */
  function indexes(now, { full = false } = {}) {
    if (!fsx) return []
    const today = localDay(now), out = [], fullOut = []
    for (const day of fsx.days(host)) {
      if (day >= today) continue
      const size = fsx.daySize(host, day), c = closed.get(day)
      if (!full && c && c.size === size) { out.push({ day, get: id => c.nodes[id] || null }); continue }
      const had = fsx.hasIndex(host, day), r = fsx.ensureIndex(host, day)
      if (!r.index) continue
      if (r.rebuilt) log(`activity: index of ${day} ${had ? 'was stale' : 'was missing'} — rebuilt`)
      closed.set(day, { size: r.index.size, nodes: r.index.nodes })
      out.push({ day, get: id => r.index.nodes[id] || null }); fullOut.push(r.index)
    }
    for (const d of [...closed.keys()]) if (!out.some(x => x.day === d)) closed.delete(d)
    const look = writer.lookup(today)
    out.push({ day: today, get: look })
    if (full) fullOut.push(writer.openIndex(today))
    return full ? fullOut : out
  }
  /** Each ghost's `last_ts` = the start of the newest retained day holding one of its entries (null: none), then
   * pruneGhosts — a ghost leaves when retention dropped its last entry and no ghost below it still has one (§5.1). */
  function ghostDays(now) {
    if (!fsx) return []
    const ix = indexes(now).slice().reverse()   // newest first
    for (const sess of state.sessions.values()) for (const g of sess.ghosts.values()) {
      const hit = ix.find(x => x.get(g.id))
      g.last_ts = hit ? dayStart(hit.day) : null
    }
    return A2.pruneGhosts(state, dayStart(retainFromDay(now)))
  }
  function retention(now) {
    if (!writer) return []
    const gone = writer.prune(retainFromDay(now))
    if (gone.length) { for (const d of gone) closed.delete(d); log(`activity: retention removed ${gone.length} day(s) (day + index files): ${gone.join(', ')}`) }
    return gone
  }

  const store = {
    state, host,
    get files() { return !!fsx },
    get cfDay() { return cfDay },
    get lastCarryForward() { return lastCf },
    get openStats() { return stats },
    setConfig(cfg) { state.config = cfg; state.retentionMs = cfg.log_retention_days * DAY },
    /** §7.5: may this gateway start? → { ok:true[, fresh] } (a fresh host's marker is written here) | { ok:false, code:78, message } */
    start(now) {
      if (!fsx) return { ok: true, memory: true }
      const r = fsx.startCheck(host)
      if (r.ok && r.fresh) { fsx.writeFreshMarker(host, now); log(`activity: no history on this host — wrote the 2.0 format marker (format.json)`) }
      return r
    },
    /** Retention, the scan, the replay of the window, the indexes and the ghost table. → stats */
    open(now) {
      const t0 = Date.now()
      const pruned = retention(now)
      scan()
      let st = /** @type {any} */ ({ fed: 0, sessions: 0, nodes: 0, ghosts: 0, entries: 0, cf_today: false })
      if (fsx) {
        const rp = A2.createReplay2(state, { now })
        const fromDay = localDay(now - Math.max(0, Number(state.config.finished_visible_hours) || 0) * 3600000)
        for (const r of fsx.readBackwards(host, { fromDay })) {
          if (rp.feed(r.rec, r.day) === 'old' && !rp.wantsOlder(r.day)) break
        }
        st = rp.finish()
        const g = A2.rebuildGhosts2(state, indexes(now, { full: true }))
        const dropped = ghostDays(now)
        st = { ...st, ghosts_rebuilt: g.added, ghosts_pruned: dropped.length, ghosts: [...state.sessions.values()].reduce((a, s) => a + s.ghosts.size, 0) }
      }
      cfDay = st.cf_today ? localDay(now) : null
      rollDay = null
      stats = { ...st, pruned, ms: Date.now() - t0 }
      return stats
    },
    /** One 2.0 `log` call (lib/activity2.js applyCall), its writes appended in order. → the result without its records
     * (+ persisted:false when a write failed) */
    apply(ident, input, now, opts = {}) {
      const r = A2.applyCall(state, ident, input, now, opts)
      if (!r.ok) return r
      const p = persist(r.writes)
      const { records: _r, entries: _e, writes: _w, ...rest } = r
      return { ...rest, ...(p === false ? { persisted: false } : {}) }
    },
    /** One dashboard action on ids (lib/activity2.js applyAction2), its writes appended in order (step 10 wires the
     * dashboard to it; the tests use it for dismissals). → the result without its records */
    action(q, now, opts = {}) {
      const r = A2.applyAction2(state, q, now, opts)
      if (!r.ok) return r
      const p = persist(r.writes)
      const { records: _r, entries: _e, writes: _w, ...rest } = r
      return { ...rest, ...(p === false ? { persisted: false } : {}) }
    },
    /** The checkpoint plan due now (cp lines + the repeat line, rewritten in place) → how many lines. */
    checkpoint(now) { const w = A2.planCheckpoints2(state, now); persist(w); return w.length },
    /** A clean shutdown / the tray's prepare-shutdown: every dirty node's cp now (+ the repeat line). */
    flush(now) { const w = A2.flushCheckpoints2(state, now, { withRep: true }); persist(w); return w.length },
    /** The owner's expiry pass (questions, the grace sweep, removals — each written) + alias lifetime. → { changed, expired, removed } */
    expire(now) {
      const p = A2.expirePass2(state, now)
      persist(p.writes)
      A2.expireAliases(state, now)
      return { changed: p.writes.length > 0, expired: p.expired, removed: p.removed }
    },
    /** Is a rollover due (a new local day since the last one, or none yet)? */
    rolloverDue(now) { return rollDay !== localDay(now) },
    /**
     * The DAY ROLLOVER (and the same pass at startup): the carry-forward into today's file once a day (§2.3), the index file
     * of every closed day (§2.4), retention, the conflicted-copy scan (§10.6), the ghosts' days + pruneGhosts (§5.1).
     * → { day, cf, indexed, pruned, ghosts_dropped, warnings }
     */
    rollover(now, why = 'day rollover') {
      const day = localDay(now), out = { day, why, cf: 0, indexed: [], pruned: [], ghosts_dropped: 0, warnings: 0 }
      if (cfDay !== day) {
        const w = A2.planCarryForward2(state, now)
        persist(w)
        cfDay = day; out.cf = w.length; lastCf = { day, at: now, written: w.length, why }
        if (w.length) log(`activity: carried the board forward into ${day} (${w.length} node(s), ${why})`)
      }
      if (writer) {
        out.indexed = writer.rollover(day)
        if (out.indexed.length) log(`activity: wrote the index of ${out.indexed.join(', ')}`)
        out.pruned = retention(now)
        const before = seen.size
        scan()
        out.warnings = seen.size - before
        out.ghosts_dropped = ghostDays(now).length
      }
      rollDay = day
      return out
    },
    /** The board head's 2.0 fields. */
    head() { return { format: A2.ACTIVITY2_FORMAT, ...(fsWarnings.length ? { fs_warnings: fsWarnings.slice() } : {}) } },
    get fsWarnings() { return fsWarnings.slice() },

    /** This host's sessions as a 2.0 board: each session's nodes (live, visible) depth first in sibling order. */
    board(q = {}, now) {
      const out = []
      for (const sess of [...state.sessions.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
        const id = sess.ident
        if (str(q.session) && lc(q.session) !== lc(id.session)) continue
        if (str(q.project) && projKey(q.project) !== projKey(id.project)) continue
        if (str(q.user) && lc(q.user) !== lc(id.user)) continue
        const memo = new Map(), nodes = []
        const walk = (n, depth) => { nodes.push(nodeRow(sess, n, depth, now, memo, state.config.stale_after_min)); for (const c of A2.childrenOf2(sess, n)) walk(c, depth + 1) }
        walk(A2.rootOf(sess), 0)
        out.push({ session: id.session, project: id.project, user: id.user, realm: id.realm, host: id.host, created_at: sess.created_at, last_activity: sess.last_activity, root_id: sess.rootId,
          ghosts: sess.ghosts.size, nodes })
      }
      return out
    },
    /** One entry in full by id: a current line from memory, else the day file its id's time names (± a day). */
    entry(id, now) {
      if (typeof id !== 'string' || !id) return bad('id-required', 'entry needs { id }')
      for (const sess of state.sessions.values()) for (const n of sess.nodes.values()) {
        if (n.current && n.current.id === id) {
          const l = n.current
          return { ok: true, source: 'memory', entry: { id: l.id, ts: l.ts, session: sess.ident.session, project: sess.ident.project, user: sess.ident.user, node_id: n.id, path: A2.pathOf(sess, n), current: true, text: l.text, state: l.state,
            details: l.details || null, data: l.data != null ? l.data : null, rendered: renderText(l.text, n.progress, n.eta_at, now) } }
        }
      }
      if (fsx) {
        const t = entryTime(id)
        if (t) for (const d of new Set([localDay(t), localDay(t - DAY), localDay(t + DAY)])) {
          for (const l of fsx.readDay(host, d)) {
            if (!l.rec || l.rec.id !== id || A2.recordKind2(l.rec) !== 'entry') continue
            const { v: _v, ...e } = l.rec
            return { ok: true, source: 'file', entry: { ...e, node_id: e.n, rendered: renderText(e.text, e.progress, e.eta_at, now) } }
          }
        }
      }
      return bad('unknown-entry', `no entry ${id} on this host (in memory or in its day files)`)
    },
    /**
     * A node's LOG PAGE, newest first (§5.1 – §5.3). q = { session, project?, user?, id? | path?, own?, removed?, limit?,
     * cursor?, earlier? }; opts = { maxEntries?, maxBytes? }. → { ok, session, project, user, node, own, removed, members,
     * ghost_members, total, entries:[{ …small entry, node_id, at, path, rel, removed? , rendered }], next_cursor,
     * run_start?, earlier_cursor?, pruned?, from_files }
     */
    logPage(q, now, opts = {}) {
      if (!q || typeof q !== 'object' || !str(q.session)) return bad('bad-log-query', 'log needs { session, project?, user?, id? | path?, own?, removed?, limit?, cursor?, earlier? }')
      const cands = [...state.sessions.values()].filter(s => lc(s.ident.session) === lc(q.session) && (!str(q.project) || projKey(s.ident.project) === projKey(q.project)) && (!str(q.user) || lc(s.ident.user) === lc(q.user)))
      if (!cands.length) return bad('unknown-session', `no activity from a session "${q.session}" on this host`)
      if (cands.length > 1) return bad('ambiguous-session', 'several sessions have that name — pass project (and user)', { candidates: cands.map(s => ({ session: s.ident.session, project: s.ident.project, user: s.ident.user })) })
      const sess = cands[0]
      let node = null
      if (str(q.id)) node = sess.nodes.get(String(q.id).trim()) || null
      else if (q.path != null && String(q.path).trim() !== '') { const p = String(q.path); node = A2.findPath(sess, p) }
      else node = A2.rootOf(sess)
      if (!node) return bad('unknown-node', `session "${sess.ident.session}" has no node ${str(q.id) ? q.id : `"${q.path}"`}`)
      const own = !!q.own, removed = !!q.removed, earlier = !!q.earlier
      // MEMBERS: the node + (unless own) every node whose parent chain reaches it NOW — live (merged ones too) and, with
      // removed, the GHOSTS hanging below any member (a ghost chain links a removed grandchild to its live ancestor)
      const live = new Map(), ghosts = new Map()
      live.set(node.id, node)
      if (!own) {
        const stack = [node.id]
        while (stack.length) {
          const x = stack.pop()
          for (const c of sess.kids.get(x) || []) { const n = sess.nodes.get(c); if (n && !live.has(c)) { live.set(c, n); stack.push(c) } }
          if (removed) for (const g of sess.gkids.get(x) || []) { const gh = sess.ghosts.get(g); if (gh && !ghosts.has(g)) { ghosts.set(g, gh); stack.push(g) } }
        }
      }
      const basePath = A2.pathOf(sess, node)
      const gpath = id => {   // a ghost's path: its labels up to a live ancestor
        const labels = []
        let x = id, guard = 0
        while (x != null && guard++ < 64) { const g = sess.ghosts.get(x); if (!g) break; labels.unshift(g.label); x = g.parent }
        const anc = x != null ? sess.nodes.get(x) : null
        return formatPath2([...(anc ? A2.labelsOf(sess, anc) : []), ...labels])
      }
      const pathCache = new Map()
      const pathOfId = id => { if (pathCache.has(id)) return pathCache.get(id); const n = live.get(id); const p = n ? A2.pathOf(sess, n) : gpath(id); pathCache.set(id, p); return p }
      const rel = p => (!basePath ? p : p === basePath ? '' : p.startsWith(basePath + '/') ? p.slice(basePath.length + 1) : p)
      const view = (rec, small) => {
        const ghost = !live.has(rec.n), p = pathOfId(rec.n)
        return { ...small, node_id: rec.n, ...(rec.at != null ? { at: rec.at } : {}), path: p, rel: rel(p), ...(ghost ? { removed: true } : {}),
          ...(rec.dismiss ? { dismiss: true, of: rec.of } : {}), ...(rec.took != null ? { took: rec.took } : {}), ...(rec.took_total != null ? { took_total: rec.took_total, attempts: rec.attempts } : {}),
          rendered: renderText(small.text, small.progress, small.eta_at, now) }
      }
      // in the CURRENT run of its node? (a ghost: all its retained entries; earlier:true asks for the EARLIER runs only)
      const runAt = id => { const n = live.get(id); return n ? n.run_at : null }
      const inRun = (id, ts) => { const r = runAt(id); return r == null || ts >= r }
      const want = (id, ts) => (earlier ? !inRun(id, ts) : inRun(id, ts))
      const lim = Math.max(1, Math.min(Number(q.limit) > 0 ? Math.floor(Number(q.limit)) : 50, state.config.log_entries_per_agent, Number(opts.maxEntries) > 0 ? Math.floor(Number(opts.maxEntries)) : Infinity))
      const maxB = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : Infinity
      const head = { ok: true, session: sess.ident.session, project: sess.ident.project, user: sess.ident.user, node: A2.nodeView(sess, node), own, removed, ...(earlier ? { earlier: true } : {}), members: live.size, ...(removed ? { ghost_members: ghosts.size } : {}) }
      const entries = []
      let bytes = 0
      const take = x => { const b = utf8(JSON.stringify(x)) + 1; if (entries.length && bytes + b > maxB) return false; entries.push(x); bytes += b; return true }

      if (!fsx) {   // a memory-only board: the live members' own logs (their current runs; ghosts keep no log)
        let total = 0
        for (const n of live.values()) total += n.log.length + n.log_dropped
        const fc = str(q.cursor), cur = fc ? { ts: entryTime(fc), id: fc } : null
        if (fc && cur.ts == null) return bad('bad-cursor', 'cursor must be the next_cursor of a previous page')
        const all = []
        for (const n of live.values()) for (const e of n.log) if (want(n.id, e.ts) && (!cur || ordCmp(e, cur) < 0)) all.push({ e, n })
        all.sort((a, b) => ordCmp(b.e, a.e))
        let more = false
        for (const { e, n } of all) { if (entries.length >= lim) { more = true; break } if (!take(view({ n: n.id }, e))) { more = true; break } }
        return { ...head, total, entries, next_cursor: more && entries.length ? entries[entries.length - 1].id : null, from_files: 0 }
      }

      // FILES through the INDEX: each retained day that holds a member, only its [min first, max last] range, backwards
      const cur = q.cursor != null && q.cursor !== '' ? parseFileCursor2(q.cursor) : null
      if (q.cursor != null && q.cursor !== '' && !cur) return bad('bad-cursor', 'cursor must be the next_cursor (or earlier_cursor) of a previous page')
      const ix = indexes(now)
      const ids = [...live.keys(), ...ghosts.keys()]
      let total = 0
      const spans = []
      for (const x of ix) {
        let from = Infinity, to = -1, n = 0
        for (const id of ids) { const a = x.get(id); if (!a) continue; from = Math.min(from, a[0]); to = Math.max(to, a[1]); n += a[2] }
        total += n
        if (n) spans.push({ day: x.day, from, to })
      }
      spans.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
      let stop = null, lastPos = null, earlierAt = null, n = 0
      outer: for (const sp of spans) {
        if (cur && sp.day > cur.day) continue
        const before = cur && sp.day === cur.day ? cur.offset : null
        for (const r of fsx.readSpanBackwards(host, sp.day, sp.from, sp.to, { before })) {
          const rec = r.rec
          if (!rec || A2.recordKind2(rec) !== 'entry' || !(live.has(rec.n) || ghosts.has(rec.n))) continue
          if (!want(rec.n, rec.ts)) { if (!earlier && !earlierAt) earlierAt = { day: r.day, offset: r.offset + r.length + 1 }; continue }   // the earlier run continues from just below it (its record included)
          if (!take(view(rec, A2.smallOf2(rec)))) { stop = 'full'; break outer }
          lastPos = { day: r.day, offset: r.offset }; n++
          if (entries.length >= lim) { stop = 'full'; break outer }   // full: stop reading here (the next page may come back empty, with the run's end)
        }
      }
      const out = /** @type {any} */ ({ ...head, total, entries, from_files: n, next_cursor: null })
      if (stop === 'full') out.next_cursor = lastPos ? fileCursor2(lastPos.day, lastPos.offset) : null
      else if (!earlier) {
        const oldest = ix.length ? dayStart(ix[0].day) : null
        if (node.run_at != null && oldest != null && node.run_at < oldest) out.pruned = true   // its run began in a day retention deleted
        else out.run_start = true
        if (earlierAt) out.earlier_cursor = fileCursor2(earlierAt.day, earlierAt.offset)
      }
      return out
    },
  }
  return store
}

/** One board row (§5.4's input until step 10 designs the units): the node as results name it + its line, state, display. */
function nodeRow(sess, n, depth, now, memo, staleMin) {
  const l = n.current
  return { ...A2.nodeView(sess, n), parent: n.parent, depth, rank: n.rank || null, created_at: n.created_at, run_at: n.run_at, runs: n.runs, last_activity: n.last_activity,
    ...(es => ({ state: es.state, ...(es.stale ? { stale: true, was: es.was } : {}), stale_at: es.stale_at }))(A2.effectiveState2(sess, n, now, staleMin)), current: l ? { id: l.id, ts: l.ts, text: l.text, state: l.state, has_details: !!l.details, has_data: l.data != null, ...(l.by ? { by: l.by } : {}), ...(l.question ? { question: l.question } : {}) } : null,
    progress: n.progress || null, eta_at: n.eta_at || null, finished_at: n.finished_at || null, implicit: !!n.implicit, log_n: n.log.length + n.log_dropped, ...(n.log_floor ? { log_floor: n.log_floor } : {}),
    display: A2.displayOf2(sess, n, { now, memo }) }
}
