// #88 (v2.0) build step 3: the v6 DAY FILES and the per-day INDEX FILES of one host (docs/spec-88.md §2, §2.4, §5.2, §10).
//
// Beside lib/activity2.js (the model, its records and the replay). Step 6 wired it: the persistence facet's `activity2`
// (facets/persistence/file.js) binds these functions to its directory (+ the paging counter), and the 2.0 gateway's store
// (lib/activity2-store.js) writes through createDayWriter, indexes closed days at rollover, prunes days with their index,
// pages through readSpanBackwards, rebuilds the ghost table from the index files and warns about conflicted copies.
// Synchronous and dependency-free: every function takes the persistence DIRECTORY, so the tests run on temp dirs.
//
// THE LAYOUT (§2.4, §10): `<dir>/activity/<lslug(host)>/` holds this host's
//   YYYY-MM-DD.jsonl       the day files (v6 records, one per line, appended; the trailing repeat line rewritten in place)
//   YYYY-MM-DD.idx.json    the index of a CLOSED day: { v:1, day, size, sessions, nodes:{ id:[first, last, count] }, struct }
//   format.json            the format marker (written by the migration, step 5; only named here)
// THE DROPBOX RULE (§10): each host writes ONLY its own directory (a writer is bound to one host); every file but the day
// files is written WHOLE through writeAtomic (a `.tmp-…` sibling, then rename; readers skip it); readers match EXACT names
// only — a Dropbox "conflicted copy" / "Case Conflict" (or any other unexpected name) is never read, never deleted, and
// reported once per name as a WARN line (scanHostDir / scanViewsDir → `warnings`, the board head's `fs_warnings`).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { lslug } from '../facets/persistence/file.js'
import { localDay } from './activity.js'
import { recordKind2 } from './activity2.js'

/** The exact names a reader takes (§10.6) — anything else in the directory is never read. */
export const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
export const INDEX_FILE_RE = /^\d{4}-\d{2}-\d{2}\.idx\.json$/
export const FORMAT_FILE = 'format.json'
export const VIEW_FILE_RE = /^[a-z0-9._-]+\.json$/
const TMP_RE = /\.tmp(-[0-9a-f]+)?$/
const CONFLICT_RE = /conflicted copy|case conflict/i
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
/** The index file format (§2.4). */
export const INDEX_FORMAT = 1

/** A host's activity directory: `<dir>/activity/<lslug(host)>` (the facet's own rule, so it names the directory the gateway owns). */
export const hostDir = (dir, host) => path.join(dir, 'activity', lslug(host || 'host', 80))
const checkDay = day => { if (!DAY_RE.test(String(day))) throw new Error(`bad activity day "${day}"`); return String(day) }
export const dayFile = (dir, host, day) => path.join(hostDir(dir, host), `${checkDay(day)}.jsonl`)
export const indexFile = (dir, host, day) => path.join(hostDir(dir, host), `${checkDay(day)}.idx.json`)
/** The day a record is filed under: its own local day (a repeat line's: its `last`). */
export const recordDay = rec => localDay(rec && Array.isArray(rec.rep) ? rec.last : rec && rec.ts)

/** Write a whole file atomically (§10.2): a `.tmp-<hex>` sibling, then a rename over the target. */
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}
const readDirSafe = d => { try { return fs.readdirSync(d) } catch { return [] } }

/**
 * Sort a directory listing by the exact-name rules (§10.6): day files, index files, the format marker, `.tmp` files (a
 * writer's half-written file: skipped), Dropbox CONFLICTED copies ("… (LITTLE-001's conflicted copy 2026-10-03).jsonl",
 * "Case Conflict" variants) and anything else UNKNOWN. Only the first three are ever read.
 * @param {string[]} names
 */
export function classifyNames(names) {
  const out = { days: [], indexes: [], format: false, tmp: [], conflicted: [], unknown: [] }
  for (const n of names) {
    if (DAY_FILE_RE.test(n)) out.days.push(n.slice(0, 10))
    else if (INDEX_FILE_RE.test(n)) out.indexes.push(n.slice(0, 10))
    else if (n === FORMAT_FILE) out.format = true
    else if (TMP_RE.test(n)) out.tmp.push(n)
    else if (CONFLICT_RE.test(n)) out.conflicted.push(n)
    else out.unknown.push(n)
  }
  out.days.sort(); out.indexes.sort(); out.conflicted.sort(); out.unknown.sort()
  return out
}
/** The WARN line for a name a reader ignores (§10.6). */
export function nameWarning(where, host, name) {
  return CONFLICT_RE.test(name)
    ? `activity: Dropbox conflicted copy '${name}' in ${where} — two machines may be writing as host ${host} (a duplicate hostname?); it is ignored — check it and delete it by hand`
    : `activity: unexpected file '${name}' in ${where} — it is not read; check it and delete it by hand`
}
/**
 * List a host's OWN activity directory (§10.6: at gateway start and at each day rollover): its day files, index files,
 * marker — and the names that are never read, each with its WARN line. `seen` (a Set, optional) makes a warning print
 * once per name across calls ("logged once"): `warnings` holds only names not seen before; `fs_warnings` holds them all.
 * Reads names only; deletes nothing (a conflicted copy may hold the only copy of some records).
 * @param {string} dir @param {string} host @param {{ seen?: Set<string> }} [o]
 */
export function scanHostDir(dir, host, o = {}) {
  const d = hostDir(dir, host), c = classifyNames(readDirSafe(d)), where = `activity/${lslug(host || 'host', 80)}`
  const odd = [...c.conflicted, ...c.unknown]
  const fsWarnings = odd.map(n => nameWarning(where, host, n))
  const warnings = odd.filter(n => !(o.seen && o.seen.has(where + '/' + n))).map(n => nameWarning(where, host, n))
  if (o.seen) for (const n of odd) o.seen.add(where + '/' + n)
  return { dir: d, ...c, warnings, fs_warnings: fsWarnings }
}
/**
 * List `<dir>/views/` (§10.6: `^[a-z0-9._-]+\.json$` only; step 8 writes there): the view files, and the names that are
 * never read with their WARN lines.
 * @param {string} dir @param {{ seen?: Set<string> }} [o]
 */
export function scanViewsDir(dir, o = {}) {
  const views = [], odd = []
  for (const n of readDirSafe(path.join(dir, 'views'))) { if (VIEW_FILE_RE.test(n)) views.push(n); else if (!TMP_RE.test(n)) odd.push(n) }
  const w = n => nameWarning('views', '?', n)
  const warnings = odd.filter(n => !(o.seen && o.seen.has('views/' + n))).map(w)
  if (o.seen) for (const n of odd) o.seen.add('views/' + n)
  return { views: views.sort(), odd: odd.sort(), warnings, fs_warnings: odd.map(w) }
}

/** Step 8 (§5.6, §10.1): this host's view-state file, `<dir>/views/<lslug(host)>.json` — written by this host only. */
export const viewFile = (dir, host) => path.join(dir, 'views', `${lslug(host || 'host', 80)}.json`)
/** Write this host's view-state image WHOLE and atomically (§10.2). */
export function writeView(dir, host, obj) { writeAtomic(viewFile(dir, host), JSON.stringify(obj)) }
/**
 * Read every view file of `<dir>/views/` by the EXACT-name rule (`^[a-z0-9._-]+\.json$`: this host's and, on a shared
 * folder, the other hosts' — read only); a conflicted copy / odd name is never read (scanViewsDir warns about it). A file
 * that does not parse is skipped. → [{ name, data }]
 */
export function readViews(dir) {
  const out = []
  for (const n of scanViewsDir(dir).views) {
    try { out.push({ name: n, data: JSON.parse(fs.readFileSync(path.join(dir, 'views', n), 'utf8')) }) } catch { out.push({ name: n, data: null }) }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// reading

/** Split a day file's bytes into lines: [{ rec (null = garbled), offset, length }] in file order. */
export function linesOf(buf) {
  const out = []
  let start = 0
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0x0a) continue
    if (i > start) { let rec = null; try { rec = JSON.parse(buf.subarray(start, i).toString('utf8')) } catch { } out.push({ rec, offset: start, length: i - start }) }
    start = i + 1
  }
  return out
}
/** This host's day files (exact names only), oldest first. */
export const days = (dir, host) => classifyNames(readDirSafe(hostDir(dir, host))).days
/** One day's records in file order: [{ rec, day, offset, length }] ([] when the file is missing). */
export function readDay(dir, host, day) {
  let buf
  try { buf = fs.readFileSync(dayFile(dir, host, day)) } catch { return [] }
  return linesOf(buf).map(l => ({ ...l, day }))
}
/**
 * Every record NEWEST FIRST — the newest day file from its end, then earlier days down to `fromDay` — as the replay is
 * fed ({ rec, day, offset, length }). Exact-name day files only: a conflicted copy is never read.
 * @param {string} dir @param {string} host @param {{ fromDay?: string }} [o]
 */
export function* readBackwards(dir, host, o = {}) {
  for (const day of days(dir, host).reverse()) {
    if (o.fromDay && day < o.fromDay) break
    const ls = readDay(dir, host, day)
    for (let i = ls.length - 1; i >= 0; i--) yield ls[i]
  }
}
/**
 * The records of one day whose line STARTS within [from, to] (byte offsets — an index's [first, last] for a set of nodes,
 * §5.2): reads only those bytes (to the end of the line at `to`).
 * @returns {{ rec:any, day:string, offset:number, length:number }[]}
 */
export function readSpan(dir, host, day, from, to) {
  let fd
  try { fd = fs.openSync(dayFile(dir, host, day), 'r') } catch { return [] }
  try {
    const size = fs.fstatSync(fd).size
    if (from >= size || to < from) return []
    let end = Math.min(size, to + 4096)
    for (;;) {   // read [from, end), growing `end` until it holds the end of the line that starts at `to`
      const b = Buffer.alloc(end - from)
      fs.readSync(fd, b, 0, b.length, from)
      const nl = b.indexOf(0x0a, to - from)
      if (nl >= 0 || end >= size) return linesOf(nl >= 0 ? b.subarray(0, nl + 1) : b).map(l => ({ ...l, offset: l.offset + from, day }))
      end = Math.min(size, end + (end - from))
    }
  } finally { fs.closeSync(fd) }
}

// ---------------------------------------------------------------------------------------------------------------
// the per-day INDEX (§2.4: id → offsets; `struct` = the day's structure, for the ghost table)

const STRUCT_FIELDS = ['c', 'scope', 'key', 'nk', 'type', 'label', 'asked', 'p', 'rank', 'run', 'transient', 'grace_ms', 'plan_item', 'plan_ix', 'implicit', 'runs',
  'into', 'from', 'kids', 'kid_ranks', 'why', 'merged_into', 'merged_from', 'run_at']
const identTuple = r => [String(r.realm || 'default'), r.project == null ? '' : String(r.project), r.user == null ? '' : String(r.user), String(r.session).trim(), Number.isFinite(r.s0) ? r.s0 : null]
/**
 * An index builder for one day file (the writer keeps today's up to date on every append; buildIndex scans a whole file):
 * add(rec, offset) per line, then index(size) → { v:1, day, size, sessions:[{ realm, project, user, session, s0 }],
 * nodes:{ id:[first entry offset, last entry offset, entry count] } (ENTRIES only — cp / cf / rep and node records are not
 * counted), struct:[ the day's node records and the structure of its cf lines, compact: { op, ts, n, s (its session in
 * `sessions`), …the structural fields } ] }.
 * @param {string} day
 */
export function indexBuilder(day) {
  const nodes = new Map(), struct = [], sessions = [], sIx = new Map()
  const sessOf = r => { const t = identTuple(r), k = JSON.stringify(t); let i = sIx.get(k); if (i === undefined) { i = sessions.length; sIx.set(k, i); sessions.push({ realm: t[0], project: t[1], user: t[2], session: t[3], s0: t[4] }) } return i }
  return {
    add(rec, offset) {
      const kind = recordKind2(rec)
      if (kind === 'entry') { const a = nodes.get(rec.n); if (a) { a[1] = offset; a[2]++ } else nodes.set(rec.n, [offset, offset, 1]) }
      else if (kind === 'node' || kind === 'cf') {
        const s = { op: kind === 'cf' ? 'cf' : rec.op, ts: rec.ts, n: rec.n, s: sessOf(rec) }
        for (const f of STRUCT_FIELDS) if (rec[f] !== undefined && rec[f] !== null && rec[f] !== false) s[f] = rec[f]
        struct.push(s)
      }
    },
    index(size) { return { v: INDEX_FORMAT, day, size, sessions: sessions.map(x => ({ ...x })), nodes: Object.fromEntries([...nodes].map(([k, v]) => [k, v.slice()])), struct: struct.map(x => ({ ...x })) } },
    /** Step 6: one node's [first, last, count] (live, not a copy), or null. */
    get(id) { return nodes.get(id) || null },
  }
}
/** The index of a day file's bytes (one scan). */
export function buildIndex(day, buf) {
  const b = indexBuilder(day)
  for (const l of linesOf(buf)) if (l.rec) b.add(l.rec, l.offset)
  return b.index(buf.length)
}
/** A day's index file, parsed — or null (missing, unreadable, another format, another day). Exact names only. */
export function readIndex(dir, host, day) {
  try { const j = JSON.parse(fs.readFileSync(indexFile(dir, host, day), 'utf8')); return j && j.v === INDEX_FORMAT && j.day === day && Number.isFinite(j.size) && j.nodes && Array.isArray(j.struct) ? j : null } catch { return null }
}
/** Write a day's index file (atomically). */
export function writeIndex(dir, host, idx) { writeAtomic(indexFile(dir, host, idx.day), JSON.stringify(idx)) }
/**
 * A CLOSED day's index: the index file when its `size` matches the day file, else REBUILT by one scan and written
 * (atomically). → { index, rebuilt } (index null when the day file is missing).
 */
export function ensureIndex(dir, host, day) {
  let size
  try { size = fs.statSync(dayFile(dir, host, day)).size } catch { return { index: null, rebuilt: false } }
  const have = readIndex(dir, host, day)
  if (have && have.size === size) return { index: have, rebuilt: false }
  const idx = buildIndex(day, fs.readFileSync(dayFile(dir, host, day)))
  writeIndex(dir, host, idx)
  return { index: idx, rebuilt: true }
}
/** Every retained day's index (ensureIndex each: a missing / stale one is rebuilt), oldest first. */
export function readIndexes(dir, host) { return days(dir, host).map(d => ensureIndex(dir, host, d).index).filter(Boolean) }
/**
 * Step 6: the records of one day whose line STARTS within [from, to] — NEWEST FIRST, read BACKWARDS in `chunk`-byte pieces
 * from the end of the line at `to` (or from `before`, a record start: a page cursor) down to `from`, so a page that fills
 * up early reads only the tail of the range (§5.2). `from` must be a record start (an index offset). `onRead(bytes)` hears
 * every byte read (the facet's paging counter). Yields { rec (null = garbled), day, offset, length }.
 * @param {string} dir @param {string} host @param {string} day @param {number} from @param {number} to
 * @param {{ before?: number|null, chunk?: number, onRead?: (n: number) => void }} [o]
 */
export function* readSpanBackwards(dir, host, day, from, to, o = {}) {
  let fd
  try { fd = fs.openSync(dayFile(dir, host, day), 'r') } catch { return }
  const count = n => { if (o.onRead) o.onRead(n) }
  const emit = (buf, offset) => { let rec = null; try { rec = JSON.parse(buf.toString('utf8')) } catch { } return { rec, day, offset, length: buf.length } }
  try {
    const size = fs.fstatSync(fd).size
    if (from >= size || to < from) return
    let end = -1   // the end of the line that starts at `to` (past its "\n")
    for (let p = to; p < size && end < 0;) { const n = Math.min(4096, size - p), b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, p); count(n); const i = b.indexOf(0x0a); if (i >= 0) end = p + i + 1; else p += n }
    if (end < 0) end = size
    if (o.before != null && Number.isFinite(o.before)) end = Math.min(end, Math.max(0, o.before))
    const chunk = Math.max(256, Number(o.chunk) || 65536)
    let pos = end, tail = Buffer.alloc(0)
    while (pos > from) {
      const n = Math.min(chunk, pos - from); pos -= n
      const b = Buffer.alloc(n)
      fs.readSync(fd, b, 0, n, pos); count(n)
      const data = tail.length ? Buffer.concat([b, tail]) : b   // `data` starts at file offset `pos`
      let e = data.length
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue
        if (e > i + 1) yield emit(data.subarray(i + 1, e), pos + i + 1)
        e = i
      }
      tail = Buffer.from(data.subarray(0, e))   // the (partial) line that started before this chunk
    }
    if (tail.length) yield emit(tail, from)
  } finally { fs.closeSync(fd) }
}
/**
 * PAGING via the index (§5.2): the days that hold any of `ids` (a subtree's members) and the byte range [min first, max
 * last] in each → [{ day, from, to, count }], newest day first. A day without an index entry for them is not read at all.
 * @param {any[]} indexes @param {Iterable<string>} ids
 */
export function spansOf(indexes, ids) {
  const want = [...ids], out = []
  for (const idx of indexes) {
    let from = Infinity, to = -1, count = 0
    for (const id of want) { const a = idx.nodes[id]; if (!a) continue; from = Math.min(from, a[0]); to = Math.max(to, a[1]); count += a[2] }
    if (count) out.push({ day: idx.day, from, to, count })
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}

// ---------------------------------------------------------------------------------------------------------------
// the WRITER (one host, one directory — the Dropbox rule)

/**
 * The day-file writer of ONE host: it writes only `<dir>/activity/<lslug(host)>/` (§10.1). append() files a record under
 * its own local day (a repeat line under its `last`) and keeps that day's index in memory (§2.4: "today's file has the
 * same map in memory, updated on every append"); replaceTail() rewrites the open repeat line in place while it is still
 * the file's last line (else appends); rollover() writes the index file of every CLOSED day that lacks a current one
 * (from memory when it holds the whole day, else by one scan); prune() deletes a day's `.jsonl` and `.idx.json` together.
 * A file whose last byte isn't "\n" (a crash mid-write) gets one before the first append.
 * @param {{ dir: string, host: string }} o
 */
export function createDayWriter({ dir, host }) {
  const d = hostDir(dir, host)
  const open = new Map()   // day -> { size, last: { offset, length } | null, b: indexBuilder | null (null: the day had bytes before we opened it) }
  function dayState(day) {
    let s = open.get(day)
    if (s) return s
    fs.mkdirSync(d, { recursive: true })
    const f = dayFile(dir, host, day)
    let size = 0
    try { size = fs.statSync(f).size } catch { }
    let b = indexBuilder(day)
    if (size > 0) {
      const buf = fs.readFileSync(f)
      if (buf[buf.length - 1] !== 0x0a) { fs.appendFileSync(f, '\n'); size++ }
      for (const l of linesOf(buf)) if (l.rec) b.add(l.rec, l.offset)   // the in-memory index covers the whole file
    }
    s = { size, last: null, b }
    open.set(day, s)
    return s
  }
  const line = rec => Buffer.from(JSON.stringify(rec) + '\n')
  let rep = null   // the open repeat line: { day, offset } while it is the last line this writer wrote
  return {
    dir: d,
    /** Append one record to its day's file. → { day, offset, length } (length without the newline) */
    append(rec, day = recordDay(rec)) {
      const s = dayState(checkDay(day)), buf = line(rec), offset = s.size
      fs.appendFileSync(dayFile(dir, host, day), buf)
      s.size += buf.length; s.last = { offset, length: buf.length - 1 }
      s.b.add(rec, offset)
      rep = Array.isArray(rec.rep) ? { day, offset } : null
      return { day, offset, length: buf.length - 1 }
    },
    /** Rewrite the open repeat line that starts at `offset` in place, or append when it is no longer the last line. */
    replaceTail(day, offset, rec) {
      const s = dayState(checkDay(day)), buf = line(rec)
      if (!s.last || s.last.offset !== offset || s.last.offset + s.last.length + 1 !== s.size) return { ...this.append(rec, day), rewritten: false }
      const fd = fs.openSync(dayFile(dir, host, day), 'r+')
      try { fs.writeSync(fd, buf, 0, buf.length, offset); fs.ftruncateSync(fd, offset + buf.length) } finally { fs.closeSync(fd) }
      s.size = offset + buf.length; s.last = { offset, length: buf.length - 1 }
      rep = { day, offset }
      return { day, offset, length: buf.length - 1, rewritten: true }
    },
    /** Write a plan (planCheckpoints2 / planCarryForward2: [{ rec, rewrite? }]) or a call's `writes` (records) in order — a
     * repeat line marked `rewrite` replaces the open one in place (when it is still the last line written). */
    writeAll(writes) {
      const out = []
      for (const w0 of writes) {
        const w = w0 && w0.rec ? w0 : { rec: w0 }
        out.push(w.rewrite && rep && rep.day === recordDay(w.rec) ? this.replaceTail(rep.day, rep.offset, w.rec) : this.append(w.rec))
      }
      return out
    },
    /** The in-memory index of a day this writer has open (a copy), or null. */
    index(day) { const s = open.get(day); return s ? s.b.index(s.size) : null },
    /** Step 6: the in-memory index of `day` (today's), OPENING it first when the writer has not touched it yet (one scan
     * of the file; nothing is written). A copy. */
    openIndex(day) { const s = dayState(checkDay(day)); return s.b.index(s.size) },
    /** Step 6: a LIVE lookup into `day`'s in-memory index (opened as openIndex): id → [first, last, count] or null — no copy,
     * for paging today's file on every page. */
    lookup(day) { const s = dayState(checkDay(day)); return id => s.b.get(id) },
    /** The local day rolled over to `today`: write the index file of every earlier day without a current one. → days indexed */
    rollover(today) {
      const done = []
      for (const day of days(dir, host)) {
        if (day >= today) continue
        let size = -1
        try { size = fs.statSync(dayFile(dir, host, day)).size } catch { continue }
        const have = readIndex(dir, host, day)
        if (have && have.size === size) { open.delete(day); continue }
        const s = open.get(day)
        writeIndex(dir, host, s && s.size === size ? s.b.index(size) : buildIndex(day, fs.readFileSync(dayFile(dir, host, day))))
        open.delete(day)
        done.push(day)
      }
      return done
    },
    /** Retention: delete this host's day files before `beforeDay`, each with its index file. → days deleted */
    prune(beforeDay) {
      const out = []
      const c = classifyNames(readDirSafe(d))
      for (const day of new Set([...c.days, ...c.indexes])) {
        if (day >= beforeDay) continue
        let any = false
        for (const f of [dayFile(dir, host, day), indexFile(dir, host, day)]) { try { fs.unlinkSync(f); any = true } catch { } }
        open.delete(day)
        if (any) out.push(day)
      }
      return out.sort()
    },
    days: () => days(dir, host),
  }
}
