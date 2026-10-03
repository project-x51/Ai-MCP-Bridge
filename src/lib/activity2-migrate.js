// #88 (v2.0) build step 5: the MIGRATION — a host's 1.7x activity history (v5 day files) converted IN PLACE into 2.0
// history (v6 day files + index files + the format marker), docs/spec-88.md §7.1, §7.2, §7.5, §10. The library behind
// src/tools/aimb-migrate-v2.mjs (the script parses the command line, finds the config / dir / host / port the bridge would
// use, prints); this module does the work on a persistence DIRECTORY, so the tests run it on temp dirs. Wired into nothing
// else yet: step 6 calls startCheck2 / writeFreshMarker at gateway start.
//
// THE CUTOVER (§7.1, Q09 / Q21 / Q24 / Q26 / Q35 / Q39: clean, no legacy reader, no rollback): every bridge is stopped; each
// host runs the script once; the bridges then start in any order and a 2.0 gateway refuses unconverted history (§7.5).
// ONE HOST, ONE DIRECTORY (§7.4, §10): the script converts only `activity/<lslug(host)>/` and its own temporary backup
// `activity-v5-backup/<lslug(host)>/` — on the Dropbox pair (ROBIN-Z790 + LITTLE-001 share persistence/) each host converts
// and writes only its own files, so the two may run at the same moment. A Dropbox conflicted copy (or any other odd name)
// in the host's directory is WARNED about and never read, converted or deleted (Q23, Q27).
//
// THE STEPS (each step's output is complete before the next starts; a crash anywhere leaves a state the next run handles):
//   0. preconditions — refuse (exit 2) while this host's gateway answers on its well-known port (a TCP connect that sends
//      no byte: the gateway's control handler does nothing until a HELLO frame, so the probe changes nothing there), or
//      while a `.tmp` newer than 10 s sits in the directory (a writer is active); the marker with no backup = already
//      converted (exit 0, nothing written); v6 records without a marker = refuse (never convert 2.0 history as 1.7x).
//   1. BACKUP — every exact-name day file copied to the backup directory, each copy read back and compared, then
//      `COMPLETE` (names, sizes, sha256) written last. A backup with COMPLETE is never overwritten (a re-run reuses it, so it
//      always holds the PRISTINE v5 files); one without it (a crash while copying) is redone.
//   2. CONVERT from the BACKUP (never from the half-converted directory: a re-run after a crash gives the same bytes),
//      convertV5 (lib/activity2-convert.js), each day written atomically over the host's own day file, 3. its index file
//      beside it, 4. the MARKER `format.json` (v 6, by, at, host, every day's size + sha256, the counts).
//   5. VERIFY — the day files on disk are exactly the marker's (names, sizes, sha256), every line is a v6 record, every
//      index file equals the index of its day, a fresh 2.0 replay of the written days equals the converter's own model
//      (every node, line, log, ghost, the scope / label / alias indexes), and the bridge is still not running.
//   6. DELETE the backup, COMPLETE last (Q35: it exists only during the migration).
// A FAILED run (an error, a failed verification — not a crash) RESTORES: the marker and the written index files go, every
// v5 day file is put back from the backup (checked against COMPLETE), then the backup is deleted — the directory is as it
// was before the run (exit 3). If the restore itself fails, the backup is KEPT and the message says where it is.
// A CRASH (the process killed) cannot restore; the next run finds the backup and resumes: no marker → convert again from
// the backup (steps 2 – 6); marker → verify and delete (5 – 6); files missing from COMPLETE's list → the delete had begun
// (verification had passed) → finish it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { lslug } from '../facets/persistence/file.js'
import { createModel, replayRecords2, recordKind2, ACTIVITY2_FORMAT } from './activity2.js'
import { hostDir, classifyNames, nameWarning, linesOf, writeAtomic, buildIndex, readIndex, FORMAT_FILE } from './activity2-files.js'
import { convertV5, dayBytes } from './activity2-convert.js'

/** The marker's `by`. */
export const MIGRATOR = 'aimb-migrate-v2 2.0.0'
/** Exit codes: 0 done / nothing to do, 2 refused (a precondition; nothing written), 3 failed (restored, or the backup kept),
 * 9 a test hook's simulated crash, 64 the command line, 78 the 2.0 gateway's start refusal (§7.5). */
export const EXIT = Object.freeze({ ok: 0, refused: 2, failed: 3, crashed: 9, usage: 64, start: 78 })
/** A `.tmp` younger than this in the host's directory means a writer is active (§7.2). */
export const TMP_ACTIVE_MS = 10000
export const COMPLETE_FILE = 'COMPLETE'
export const BACKUP_ROOT = 'activity-v5-backup'
/** The command a refusal names. */
export const MIGRATE_CMD = 'node src/tools/aimb-migrate-v2.mjs'

/** The host's temporary backup directory: `<dir>/activity-v5-backup/<lslug(host)>` (outside `activity/`: no reader lists it). */
export const backupDir = (dir, host) => path.join(dir, BACKUP_ROOT, lslug(host || 'host', 80))
/** `activity/<lslug(host)>` — how messages name the host's directory (relative to the persistence dir). */
export const hostRel = host => `activity/${lslug(host || 'host', 80)}`
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const readDirSafe = d => { try { return fs.readdirSync(d) } catch { return [] } }
const J = JSON.stringify
const iso = t => new Date(t).toISOString()
const dayOf = name => name.slice(0, 10)
const sortedKeys = o => Object.keys(o).sort()
const RM = { force: true, recursive: true, maxRetries: 5, retryDelay: 200 }
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
/** writeAtomic (§10.2), retried a few times on EPERM / EBUSY / EACCES: on Windows a sync client or an indexer can hold the target open for a moment. */
function writeFile(file, data) {
  for (let i = 0; ; i++) {
    try { return writeAtomic(file, data) } catch (e) {
      for (const n of readDirSafe(path.dirname(file))) if (n.startsWith(path.basename(file) + '.tmp-')) try { fs.rmSync(path.join(path.dirname(file), n), { force: true }) } catch { }
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code)) throw e
      sleep(200 * (i + 1))
    }
  }
}

class Damaged extends Error { constructor(msg) { super(msg); this.damaged = true } }

// ---------------------------------------------------------------------------------------------------------------
// is a bridge running here?

/**
 * Dial one TCP port and hang up at once (no byte sent) → 'up' (it accepted), 'down' (refused / no such address here) or
 * 'unknown' (no answer in time). The gateway's control handler (bridge.mjs onControlConn) does nothing until a HELLO frame
 * arrives, so this probe changes nothing in a running bridge — it is the bridge's own test: whoever holds the port is the
 * host's gateway (bridge.mjs election()).
 * @param {number} port @param {string} [host] @param {number} [timeoutMs]
 * @returns {Promise<'up'|'down'|'unknown'>}
 */
export function probePort(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise(resolve => {
    let done = false, timer = null
    const s = net.connect({ port, host })
    const fin = r => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(r) }
    timer = setTimeout(() => fin('unknown'), timeoutMs)
    s.once('connect', () => fin('up'))
    s.once('error', e => fin(['ECONNREFUSED', 'EADDRNOTAVAIL', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(/** @type {any} */ (e).code) ? 'down' : 'unknown'))
  })
}
/**
 * Is THIS host's gateway running? It holds the well-known control port (config `port` / AI_BRIDGE_PORT, default 12317) on
 * loopback — or only on its `bind` address when that is a specific interface (a tailnet IP), so that is dialled too.
 * → { up, unknown, at } (at = the address that answered, or the one that gave no answer).
 * @param {{ port: number, bind?: string, timeoutMs?: number }} o
 */
export async function probeGateway(o) {
  const hosts = ['127.0.0.1']
  if (o.bind && !['0.0.0.0', '127.0.0.1', '::', '::1', 'localhost'].includes(o.bind)) hosts.push(o.bind)
  let unknown = null
  for (const h of hosts) {
    const r = await probePort(o.port, h, o.timeoutMs || 1500)
    if (r === 'up') return { up: true, unknown: false, at: `${h}:${o.port}` }
    if (r === 'unknown' && !unknown) unknown = `${h}:${o.port}`
  }
  return { up: false, unknown: !!unknown, at: unknown }
}

// ---------------------------------------------------------------------------------------------------------------
// reading the directory

/** The format marker: { exists, marker (null = unreadable / not an object) }. */
export function readMarker(dir, host) {
  const f = path.join(hostDir(dir, host), FORMAT_FILE)
  let raw
  try { raw = fs.readFileSync(f, 'utf8') } catch { return { exists: false, marker: null } }
  try { const j = JSON.parse(raw); return { exists: true, marker: j && typeof j === 'object' && !Array.isArray(j) ? j : null } } catch { return { exists: true, marker: null } }
}
const markerV6 = m => !!(m && m.marker && m.marker.v === ACTIVITY2_FORMAT)
/** The backup directory's state: null (none), else { names, complete (COMPLETE parsed, or null), missing (listed files gone) }. */
export function readBackup(dir, host) {
  const bd = backupDir(dir, host)
  if (!fs.existsSync(bd)) return null
  const names = readDirSafe(bd)
  let complete = null
  try {
    const j = JSON.parse(fs.readFileSync(path.join(bd, COMPLETE_FILE), 'utf8'))
    if (j && j.files && typeof j.files === 'object' && Object.keys(j.files).every(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && Number.isFinite(j.files[n].size) && typeof j.files[n].sha256 === 'string')) complete = j
  } catch { }
  const missing = complete ? sortedKeys(complete.files).filter(n => !names.includes(n)) : []
  return { dir: bd, names, complete, missing }
}
/** Read v5 day files by name from a directory: [{ day, records, bytes }] — with `expect` (COMPLETE's files) each must match it. */
function readDays(d, names, expect) {
  const out = []
  for (const n of names) {
    let buf
    try { buf = fs.readFileSync(path.join(d, n)) } catch { throw new Damaged(`${n} is missing from ${d}`) }
    if (expect && (buf.length !== expect[n].size || sha256(buf) !== expect[n].sha256)) throw new Damaged(`${n} in ${d} does not match its size / sha256 in ${COMPLETE_FILE}`)
    out.push({ day: dayOf(n), records: linesOf(buf).map(l => l.rec), bytes: buf.length })
  }
  return out
}
/** 2.0 records in what should be 1.7x history (a marker that went missing) — never convert them as v5. */
const v6Count = days => days.reduce((a, d) => a + d.records.filter(r => r && r.v === ACTIVITY2_FORMAT && recordKind2(r)).length, 0)

// ---------------------------------------------------------------------------------------------------------------
// the 2.0 gateway's start check (§7.5) — step 6 wires it

/**
 * May a 2.0 GATEWAY start on this host's history? → { ok:true } (converted), { ok:true, fresh:true } (no day files and no
 * marker: the gateway writes the marker, writeFreshMarker, and starts), or { ok:false, code:78, message } — the history is
 * 1.7x (v5), or a migration did not finish (its backup is still there). Followers own no activity: no check. Reads only.
 * @param {string} dir @param {string} host
 */
export function startCheck2(dir, host) {
  const rel = `persistence/${hostRel(host)}`
  if (fs.existsSync(backupDir(dir, host)))
    return { ok: false, code: EXIT.start, message: `the migration of ${rel} did not finish — run ${MIGRATE_CMD} again (see docs/spec-88.md §7.1)` }
  const m = readMarker(dir, host)
  if (markerV6(m)) return { ok: true }
  const c = classifyNames(readDirSafe(hostDir(dir, host)))
  if (c.days.length || m.exists)
    return { ok: false, code: EXIT.start, message: `activity history in ${rel} is format v5 (pre-2.0). Stop every bridge, then run: ${MIGRATE_CMD} (see docs/spec-88.md §7.1)` }
  return { ok: true, fresh: true }
}
/** The marker of a host with no 1.7x history (a fresh install; the gateway's start, or the script). */
export function writeFreshMarker(dir, host, now) {
  const m = { v: ACTIVITY2_FORMAT, by: MIGRATOR, at: iso(now), host, days: {}, records: 0, sessions: 0, nodes: 0, ghosts: 0, relabelled: 0, fresh: true }
  writeFile(path.join(hostDir(dir, host), FORMAT_FILE), J(m))
  return m
}

// ---------------------------------------------------------------------------------------------------------------
// the 2.0 model as text (the verification compares the replay of the written files with the converter's own model)

/** Every session, node (all fields but the checkpoint bookkeeping and the replay window's `log_floor`), index, alias, ghost. */
export function dumpModel2(st) {
  const sorted = m => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out = []
  for (const [k, s] of sorted(st.sessions)) {
    const nodes = sorted(s.nodes).map(([, n]) => { const x = { ...n }; delete x.cp_dirty; delete x.cp_sig; delete x.log_floor; return x })
    out.push({ k, ident: s.ident, created_at: s.created_at, last_activity: s.last_activity, rootId: s.rootId, nodes, kids: sorted(s.kids).map(([p, ids]) => [p, [...ids].sort()]).filter(([, ids]) => ids.length),
      labels: sorted(s.labels), scope: sorted(s.scope), aliases: sorted(s.aliases), ghosts: sorted(s.ghosts), gkids: sorted(s.gkids).map(([p, ids]) => [p, [...ids].sort()]).filter(([, ids]) => ids.length) })
  }
  return J(out)
}
const lastTsOf = days => { let t = 0; for (const d of days) for (const r of d.records) { const x = r && (Array.isArray(r.rep) ? r.last : r.ts); if (Number.isFinite(x) && x > t) t = x } return t }

// ---------------------------------------------------------------------------------------------------------------
// the migration

/**
 * MIGRATE one host's activity history in place (§7.2). Synchronous file work; async only for the bridge probe.
 * @param {{ dir: string, host: string, config?: any, dryRun?: boolean, now?: () => number,
 *   probe?: () => Promise<{ up: boolean, unknown?: boolean, at?: string }>, hook?: (point: string, ctx: any) => void }} o
 *   dir = the persistence directory; host = the bridge's host name; config = the host's resolved `activity` block;
 *   probe = is this host's gateway running (probeGateway); hook = test points ('backup', 'day:N', 'marker', 'verify',
 *   'delete') — the script's test hooks stop the process there (a crash) or plant a corruption.
 * @returns {Promise<{ code: number, status: string, message: string, lines: string[], warnings: string[], report: any }>}
 */
export async function migrate(o) {
  const t0 = Date.now(), now = o.now || Date.now, hook = o.hook || (() => { })
  const dir = path.resolve(o.dir), host = String(o.host || '').trim(), dry = !!o.dryRun
  const rel = hostRel(host), hd = hostDir(dir, host), bd = backupDir(dir, host)
  const lines = [], warnings = []
  const report = /** @type {any} */ ({ host, dir: hd, dry_run: dry, status: null })
  const done = (code, status, message) => { report.status = status; report.ms = Date.now() - t0; return { code, status, message, lines, warnings, report } }
  if (!host) return done(EXIT.usage, 'usage', 'no host name (--host)')
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return done(EXIT.refused, 'refused', `the persistence directory ${dir} does not exist — check --dir (or persistence.dir in the config)`)

  // ---- preconditions (read only)
  if (o.probe) {
    const p = await o.probe()
    if (p.up) return done(EXIT.refused, 'refused', `a bridge is running on this host (it answers on ${p.at}) — stop every bridge first (tray, service, auto-start; docs/spec-88.md §7.1), then run this again`)
    if (p.unknown) return done(EXIT.refused, 'refused', `could not tell whether a bridge is running on this host (no answer from ${p.at} in time) — make sure every bridge is stopped, then run this again`)
  }
  if (!fs.existsSync(hd)) {
    const others = readDirSafe(path.join(dir, 'activity')).filter(n => n !== path.basename(hd))
    if (!readBackup(dir, host)) return done(EXIT.ok, 'nothing', `${rel}: no activity history for host ${host} in ${dir} — nothing to convert (a 2.0 gateway writes its marker at its first start)${others.length ? `; other hosts' directories here: ${others.join(', ')} (each host converts its own: --host)` : ''}`)
  }
  const scan = classifyNames(readDirSafe(hd))
  for (const n of [...scan.conflicted, ...scan.unknown]) warnings.push(nameWarning(rel, host, n))
  report.conflicted = scan.conflicted; report.unknown = scan.unknown
  const tNow = now()
  const tmpAge = scan.tmp.map(n => { try { return { n, age: tNow - fs.statSync(path.join(hd, n)).mtimeMs } } catch { return { n, age: Infinity } } })
  const active = tmpAge.filter(x => x.age < TMP_ACTIVE_MS)
  if (active.length) return done(EXIT.refused, 'refused', `a writer is active in ${rel} ('${active[0].n}' was written ${Math.max(0, Math.round(active[0].age / 1000))} s ago) — stop every bridge first, then run this again`)
  const stale = tmpAge.map(x => x.n)

  const mk = readMarker(dir, host), bk = readBackup(dir, host)
  if (mk.exists && !markerV6(mk)) return done(EXIT.refused, 'refused', `${rel}/${FORMAT_FILE} is unreadable or not a 2.0 (v6) marker — check it by hand (it is never overwritten)`)
  const cfg = o.config || {}

  if (markerV6(mk) && !bk) {
    const m = mk.marker
    return done(EXIT.ok, 'already', `${rel}: already converted (format v6, ${String(m.at || '?').slice(0, 10)} by ${m.by || '?'}) — nothing to do`)
  }
  if (markerV6(mk) && bk && !bk.complete) {
    if (bk.names.every(n => /\.tmp(-[0-9a-f]+)?$/.test(n))) {   // an emptied backup directory (the delete had finished its files)
      if (dry) return done(EXIT.ok, 'dry-run', `${rel} (dry run): already converted; would remove the empty backup directory ${path.relative(dir, bd)} — nothing written`)
      removeBackup(dir, host)
      return done(EXIT.ok, 'already', `${rel}: already converted; the empty backup directory left by an earlier run was removed`)
    }
    return done(EXIT.refused, 'refused', `${path.relative(dir, bd)} has files but no ${COMPLETE_FILE}, beside a v6 marker — not a state a migration leaves; check it by hand`)
  }

  // ---- resume after a crash: a backup with COMPLETE
  let resume = null
  if (bk && bk.complete) {
    if (bk.missing.length) {
      if (markerV6(mk)) resume = 'finish-delete'   // the delete had begun, so verification had passed
      else {
        // a restore had finished and its backup delete was cut short: the directory must hold the original files
        const orig = sortedKeys(bk.complete.files).every(n => { try { const b = fs.readFileSync(path.join(hd, n)); return b.length === bk.complete.files[n].size && sha256(b) === bk.complete.files[n].sha256 } catch { return false } })
        if (!orig) return done(EXIT.failed, 'failed', `${path.relative(dir, bd)} is incomplete (${bk.missing.join(', ')} missing) and ${rel} does not hold the original v5 files — check both by hand`)
        resume = 'stale-backup'
      }
    } else resume = markerV6(mk) ? 'verify' : 'convert'
  }
  if (resume === 'finish-delete') {
    if (dry) return done(EXIT.ok, 'dry-run', `${rel} (dry run): converted and verified by an earlier run; would finish deleting its backup — nothing written`)
    removeBackup(dir, host)
    return done(EXIT.ok, 'done', `${rel}: converted and verified by an earlier run; its backup is removed now`)
  }
  if (resume === 'stale-backup') {
    if (dry) lines.push(`an earlier run restored ${rel} and left part of its backup; a real run removes it first`)
    else removeBackup(dir, host)
  }
  const fromBackup = resume === 'convert' || resume === 'verify'

  // ---- the source: the host's day files (a fresh run), or the backup (a resumed one)
  let src
  try {
    src = fromBackup ? readDays(bd, sortedKeys(bk.complete.files), bk.complete.files) : readDays(hd, scan.days.map(d => `${d}.jsonl`), null)
  } catch (e) {
    if (e.damaged) return done(EXIT.failed, 'failed', `the backup is damaged: ${e.message} — nothing was changed by this run; the backup in ${path.relative(dir, bd)} is kept: check it by hand`)
    throw e
  }
  if (!src.length && !fromBackup) {
    if (dry) return done(EXIT.ok, 'dry-run', `${rel} (dry run): no 1.7x day files — would write the format marker (a fresh host); nothing written`)
    if (bk) removeBackup(dir, host)   // (a backup cut short while copying, of files that are gone now)
    writeFreshMarker(dir, host, now())
    return done(EXIT.ok, 'fresh', `${rel}: no 1.7x day files — format marker written (a fresh host)`)
  }
  const v6 = v6Count(src)
  if (v6) return done(EXIT.refused, 'refused', `${rel} already holds ${v6} 2.0 (v6) records but has no ${FORMAT_FILE} marker — it is not converted again; check it by hand`)
  const bytesIn = src.reduce((a, d) => a + d.bytes, 0)
  report.backup_bytes = bytesIn

  // ---- the forward pass (in memory; a dry run stops after it)
  let conv = /** @type {any} */ (null)
  try { conv = convertV5(src.map(d => ({ day: d.day, records: d.records })), { host, config: cfg }) } catch (e) {
    if (dry) return done(EXIT.failed, 'failed', `${rel} (dry run): the conversion failed: ${e && e.message} — nothing written`)
    conv = { error: e }
  }
  if (conv.report) fillReport(report, conv)
  if (dry) {
    report.bytes_out = conv.days.reduce((a, d) => a + dayBytes(d.records).length, 0)
    if (stale.length) lines.push(`would delete ${stale.length} stale .tmp file(s): ${stale.join(', ')}`)
    const how = fromBackup ? (resume === 'verify' ? 'an earlier run converted it and stopped before verifying; a real run verifies it from its backup' : 'an earlier run stopped part-way; a real run resumes from its backup') : null
    if (how) lines.push(how)
    return done(EXIT.ok, 'dry-run', `${rel} (dry run): would convert ${summary(report)}; would write ${plural(report.days, 'day file', 'day files')} + ${plural(report.days, 'index file', 'index files')} (${mb(report.bytes_out)}), backup ${mb(bytesIn)} during the run — nothing written`)
  }

  // ---- 0. stale .tmp files go
  for (const n of stale) fs.rmSync(path.join(hd, n), { force: true })

  // ---- 1. the backup
  let complete = fromBackup ? bk.complete : null
  if (!complete) {
    try { complete = makeBackup(hd, bd, src, host, now()) } catch (e) {
      removeBackup(dir, host)   // nothing was converted yet: the directory is untouched
      return done(EXIT.failed, 'failed', `${rel}: the backup failed (${e && e.message}) — nothing was changed`)
    }
    hook('backup', { dir, host })
  }

  // ---- 2 – 5 (on any failure: restore)
  try {
    if (conv.error) throw new Error(`the conversion failed: ${conv.error && conv.error.message}`)
    const files = {}
    if (resume !== 'verify') {
      fs.rmSync(path.join(hd, FORMAT_FILE), { force: true })
      let i = 0
      for (const d of conv.days) {
        const buf = dayBytes(d.records)
        writeFile(path.join(hd, `${d.day}.jsonl`), buf)
        writeFile(path.join(hd, `${d.day}.idx.json`), J(buildIndex(d.day, buf)))
        files[d.day] = { size: buf.length, sha256: sha256(buf) }
        hook(`day:${++i}`, { dir, host })
      }
      const r = conv.report
      writeFile(path.join(hd, FORMAT_FILE), J({ v: ACTIVITY2_FORMAT, by: MIGRATOR, at: iso(now()), host, days: files, records: r.records_in, sessions: r.sessions, nodes: r.nodes, ghosts: r.ghosts, relabelled: r.relabelled.length }))
      hook('marker', { dir, host })
    }
    hook('verify', { dir, host })
    const bad = verify(dir, host, conv, cfg)
    if (!bad && o.probe) { const p = await o.probe(); if (p.up) throw Object.assign(new Error(`a bridge started on this host during the migration (it answers on ${p.at})`), { bridge: true }) }
    if (bad) throw new Error(`verification failed: ${bad}`)
  } catch (e) {
    const why = e && e.message, next = e && e.bridge ? 'stop every bridge, then run this again' : 'please report this (the converter needs a fix); the bridges cannot start on 1.7x history'
    const rs = restore(dir, host, complete)
    report.restored = rs.ok
    if (rs.ok) return done(EXIT.failed, 'failed', `${rel}: ${why} — the v5 history was RESTORED from the backup and the backup removed: nothing changed — ${next}`)
    return done(EXIT.failed, 'failed', `${rel}: ${why} — and the restore failed too (${rs.error}); the original v5 files are in ${path.relative(dir, bd)} (with ${COMPLETE_FILE}): run this again, or copy them back by hand`)
  }
  report.verified = true

  // ---- 6. the backup goes
  removeBackup(dir, host, () => hook('delete', { dir, host }))
  report.backup = 'removed'
  return done(EXIT.ok, 'done', `${rel}: ${summary(report)}, verified, backup (${mb(bytesIn)}) removed, ${((Date.now() - t0) / 1000).toFixed(1)} s${resume ? ' (resumed an earlier run)' : ''}`)
}

function fillReport(report, conv) {
  const r = conv.report
  Object.assign(report, { days: r.days, records: r.records_in, records_out: r.records_out, skipped: r.skipped, sessions: r.sessions, nodes: r.nodes, ghosts: r.ghosts,
    relabelled: r.relabelled, keyed: r.keyed, removed: r.removed })
}
const grp = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const mb = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`)
const plural = (n, one, many) => `${grp(n)} ${n === 1 ? one : many}`
function summary(r) {
  return `${plural(r.days, 'day file', 'day files')}, ${plural(r.records, 'record', 'records')} → ${plural(r.nodes, 'node', 'nodes')} (${plural(r.ghosts, 'ghost', 'ghosts')})`
    + (r.relabelled && r.relabelled.length ? `, ${plural(r.relabelled.length, 'label', 'labels')} made unique` : '')
    + (r.keyed && r.keyed.length ? `, ${plural(r.keyed.length, 'agent key', 'agent keys')} slugged` : '')
}

/** Step 1: copy every day file into the (fresh) backup directory, each copy read back and compared, COMPLETE last. */
function makeBackup(hd, bd, src, host, now) {
  fs.rmSync(bd, RM)   // a backup without COMPLETE is redone
  fs.mkdirSync(bd, { recursive: true })
  const files = {}
  for (const d of src) {
    const n = `${d.day}.jsonl`, buf = fs.readFileSync(path.join(hd, n))
    fs.writeFileSync(path.join(bd, n), buf)
    const back = fs.readFileSync(path.join(bd, n)), h = sha256(buf)
    if (back.length !== buf.length || sha256(back) !== h) throw new Error(`the backup copy of ${n} does not match the original`)
    files[n] = { size: buf.length, sha256: h }
  }
  const c = { v: 1, by: MIGRATOR, at: iso(now), host, files }
  writeFile(path.join(bd, COMPLETE_FILE), J(c))
  return c
}

/** Step 5: '' when the files on disk are the conversion, else what differs (the first problem). */
function verify(dir, host, conv, cfg) {
  const hd = hostDir(dir, host), mk = readMarker(dir, host)
  if (!markerV6(mk)) return `${FORMAT_FILE} is missing or unreadable`
  const m = mk.marker, want = conv.days.map(d => d.day).sort()
  if (J(sortedKeys(m.days || {})) !== J(want)) return `the marker lists days ${J(sortedKeys(m.days || {}))}, the conversion wrote ${J(want)}`
  const onDisk = classifyNames(readDirSafe(hd)).days
  if (J(onDisk) !== J(want)) return `the directory holds day files ${J(onDisk)}, the marker lists ${J(want)}`
  const items = []
  for (const d of conv.days) {
    let buf
    try { buf = fs.readFileSync(path.join(hd, `${d.day}.jsonl`)) } catch { return `${d.day}.jsonl is missing` }
    const e = m.days[d.day]
    if (buf.length !== e.size || sha256(buf) !== e.sha256) return `${d.day}.jsonl does not match its size / sha256 in the marker`
    if (!buf.equals(dayBytes(d.records))) return `${d.day}.jsonl is not what the conversion wrote`
    const ls = linesOf(buf)
    const odd = ls.findIndex(l => !l.rec || !recordKind2(l.rec))
    if (odd >= 0) return `${d.day}.jsonl line ${odd + 1} is not a v6 record`
    const idx = readIndex(dir, host, d.day)
    if (!idx) return `${d.day}.idx.json is missing or unreadable`
    if (idx.size !== buf.length || J(idx) !== J(buildIndex(d.day, buf))) return `${d.day}.idx.json does not match its day file`
    for (const l of ls) items.push({ rec: l.rec, day: d.day })
  }
  const R = createModel({ origin: host, config: cfg })
  replayRecords2(R, items, lastTsOf(conv.days), { from: 0 })
  if (dumpModel2(R) !== dumpModel2(conv.model)) return 'a 2.0 replay of the written days does not give the converted board'
  let nodes = 0, ghosts = 0   // (as the conversion counts them: the session roots included)
  for (const s of R.sessions.values()) { nodes += s.nodes.size; ghosts += s.ghosts.size }
  if (nodes !== conv.report.nodes || ghosts !== conv.report.ghosts) return `the replay holds ${nodes} nodes (${ghosts} ghosts), the conversion reported ${conv.report.nodes} (${conv.report.ghosts})`
  return ''
}

/** A failed run: the marker and the index files go, the v5 day files come back from the backup (checked), then the backup goes. */
function restore(dir, host, complete) {
  const hd = hostDir(dir, host), bd = backupDir(dir, host)
  if (!complete) return { ok: false, error: 'no complete backup' }
  try {
    fs.rmSync(path.join(hd, FORMAT_FILE), { force: true })
    for (const n of sortedKeys(complete.files)) {
      const buf = fs.readFileSync(path.join(bd, n)), f = complete.files[n]
      if (buf.length !== f.size || sha256(buf) !== f.sha256) throw new Error(`the backup copy of ${n} does not match ${COMPLETE_FILE}`)
      writeFile(path.join(hd, n), buf)
      fs.rmSync(path.join(hd, `${dayOf(n)}.idx.json`), { force: true })
    }
    for (const n of sortedKeys(complete.files)) {
      const buf = fs.readFileSync(path.join(hd, n))
      if (buf.length !== complete.files[n].size || sha256(buf) !== complete.files[n].sha256) throw new Error(`${n} does not match the original after the restore`)
    }
  } catch (e) { return { ok: false, error: e && e.message } }
  removeBackup(dir, host)
  return { ok: true }
}

/** Step 6 (and the end of a restore): the backup's day files, then COMPLETE LAST, then the directory (and `activity-v5-backup/` when empty). */
function removeBackup(dir, host, afterFirst) {
  const bd = backupDir(dir, host)
  let first = true
  for (const n of readDirSafe(bd).filter(n => n !== COMPLETE_FILE).sort()) {
    fs.rmSync(path.join(bd, n), RM)
    if (first && afterFirst) { first = false; afterFirst() }
  }
  fs.rmSync(path.join(bd, COMPLETE_FILE), RM)
  fs.rmSync(bd, RM)
  try { fs.rmdirSync(path.join(dir, BACKUP_ROOT)) } catch { }   // only when empty (another host's backup may be there)
}
