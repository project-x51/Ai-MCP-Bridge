// Fast UNIT tests for #88 (v2.0) build step 5 — the MIGRATION SCRIPT (src/tools/aimb-migrate-v2.mjs + lib/activity2-migrate.js;
// docs/spec-88.md §7.1, §7.2, §7.5, §10). The script runs as a CHILD PROCESS on TEMP persistence dirs only (always with
// --dir, --host, --port of this file's port block and a temp --config / AI_BRIDGE_CONFIG — never the real persistence/, the
// real config.json or the live bridge's ports), on 1.7x history written by the FROZEN 1.7x library
// (tests/fixtures/activity-v175.js: entries, cp / rep, the gc pass, a cf at each rollover) over 3 days with plans, moves,
// questions and a dismissal: the dry run (nothing written), the run (v6 days = the converter's bytes, index files, the
// marker's sizes + sha256, no backup left), the idempotent re-run, the refusals (a "bridge" answering on the port, a fresh
// .tmp, v6 records without a marker), a failed verification (restored: every byte as before), crashes at each step (the
// test hooks) and the resumed run giving the clean run's bytes, the start check (§7.5), the Dropbox rule (a conflicted
// copy warned about, left alone, never converted; two hosts in one persistence dir converted at once, each only its own).
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testOnly } from '../helpers/check.mjs'
import { portBase } from '../helpers/ports.mjs'
import * as V from '../fixtures/activity-v175.js'
import * as A from '../../lib/activity.js'
import * as M from '../../lib/activity2.js'
import * as C from '../../lib/activity2-convert.js'
import * as F from '../../lib/activity2-files.js'
import * as G from '../../lib/activity2-migrate.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.stack} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
async function section(fn) { try { await fn() } catch (e) { fail++; console.log('FAIL section crashed:', (e && e.stack) || e) } }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.resolve(HERE, '../../tools/aimb-migrate-v2.mjs')
const BASE = portBase(import.meta.url)
const FAKE_PORT = BASE, DEAD_PORT = BASE + 1   // a fake "bridge" listens on the first; nothing ever listens on the second
const HOST = 'ROBIN-Z790', HOST2 = 'LITTLE-001'
const ALPHA = { session: 'Alpha', project: 'AIMB', user: 'robin' }
const BETA = { session: 'Beta', project: 'Marz', user: 'kim' }
const DASH = { kind: 'dashboard', user: 'robin', host: HOST }
const MIN = 60000, HOUR = 3600000
const T0 = new Date(2026, 9, 1, 9, 0, 0).getTime()   // a LOCAL morning: day files are per local day
const ACT_BLOCK = { log_entries_per_agent: 8 }
const CFG_ACT = A.resolveConfig(ACT_BLOCK, {})
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-migrate5-'))
const CONFIG_FILE = path.join(TMP, 'config.json')
fs.writeFileSync(CONFIG_FILE, J({ activity: ACT_BLOCK, port: DEAD_PORT }))

// ---- 1.7x history, written as a 1.7x gateway writes its day files (as test_activity4's history(), smaller)
function history(host = HOST, salt = '') {
  const st = V.createActivity({ origin: host, config: ACT_BLOCK })
  const days = new Map()
  const put = (rec, day = V.localDay(rec.ts)) => { let a = days.get(day); if (!a) days.set(day, a = []); a.push(JSON.parse(J(rec))) }
  const putW = ws => { for (const w of ws) { const rec = JSON.parse(J(w.rec)), day = V.localDay(Array.isArray(rec.rep) ? rec.last : rec.ts), a = days.get(day); if (w.rewrite && a && a.length && Array.isArray(a[a.length - 1].rep)) a[a.length - 1] = rec; else put(rec, day) } }
  let t = T0, lastDay = V.localDay(t), nextCp = t + 5 * MIN, nextGc = t + MIN
  const tick = ms => {
    t += ms
    while (nextCp <= t || nextGc <= t) { if (nextGc <= nextCp) { V.expire(st, nextGc); nextGc += MIN } else { putW(V.planCheckpoints(st, nextCp)); nextCp += 5 * MIN } }
    const d = V.localDay(t)
    if (d !== lastDay) { lastDay = d; putW(V.planCarryForward(st, t)) }
  }
  const say = (ident, input) => { const p = V.parseMessage(input, { now: t, tzOffsetMin: 0 }); if (!p.ok) throw new Error(J(p)); const r = V.apply(st, ident, p.msg, t); if (!r.ok) throw new Error(J(r)); for (const x of r.records) put(x); return r }
  const act = (ident, p, action, args = {}) => { const r = V.applyAction(st, { ...ident, path: p, action, args }, t, { by: { ...DASH, host } }); if (r.ok) for (const x of r.records) put(x); return r }
  // day 1: an agent with a plan, a move, a question + its answer
  say(ALPHA, { path: `@"Next release"/@WIP/spec-88${salt}/@~root`, text: 'writing the spec', state: 'running', stale_after: '30m' }); tick(MIN)
  say(ALPHA, { path: `@"Next release"/@WIP/spec-88${salt}`, plan: ['Read', 'Design', 'Build'] }); tick(MIN)
  say(ALPHA, { path: `@"Next release"/@WIP/spec-88${salt}/@~Read`, state: 'running', text: 'reading' }); tick(5 * MIN)
  say(ALPHA, { path: `@"Next release"/@WIP/spec-88${salt}/@~Read`, state: 'done' }); tick(MIN)
  act(ALPHA, `@"Next release"/@WIP/spec-88${salt}/@Design`, 'move', { to: '@"Next release"' }); tick(MIN)
  say(ALPHA, { path: '@Questions', ask: 'Which database?', choices: ['Postgres', 'SQLite'] }); tick(MIN)
  act(ALPHA, '@Questions', 'answer', { choice: 'SQLite' }); tick(MIN)
  say(BETA, { path: 'helper/@~root', text: 'helping', state: 'running' }); tick(20 * HOUR)
  // day 2: more work, a finished helper dismissed, the agent's item running
  say(ALPHA, { path: `@"Next release"/@WIP/spec-88${salt}/@~Build`, state: 'running', text: 'building' }); tick(MIN)
  say(BETA, { path: 'helper/@~root', text: 'helped', state: 'done' }); tick(MIN)
  act(BETA, 'helper', 'dismiss', { stale_min: 1 }); tick(MIN)
  say(ALPHA, { path: 'w2/@~root', text: 'a second agent', state: 'running' }); tick(MIN)
  say(ALPHA, { path: 'w2/@Notes/@~root', text: 'notes' }); tick(24 * HOUR)
  // day 3
  say(ALPHA, { path: `@"Next release"/@WIP/spec-88${salt}/@~Build`, state: 'done', text: 'built' }); tick(MIN)
  say(ALPHA, { path: 'w2/@~root', text: 'finished', state: 'done' }); tick(MIN)
  say(ALPHA, { path: `@"Next release"/@WIP/spec-88${salt}/@~root`, text: 'the last record before the stop' })
  putW(V.flushCheckpoints(st, t, { withRep: true }))   // a clean stop (the runbook stops every bridge first)
  return [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, records]) => ({ day, records }))
}
const HIST = history(), HIST2 = history(HOST2, '-l')
const dayText = d => d.records.map(r => J(r) + '\n').join('') + 'not json at all\n'   // (a garbled line: skipped by the conversion)

/** A fresh persistence dir holding HOST's (and optionally HOST2's) 1.7x history. */
let nDir = 0
function persist(o = {}) {
  const dir = path.join(TMP, `p${++nDir}`)
  for (const [host, hist] of [[HOST, HIST], ...(o.two ? [[HOST2, HIST2]] : [])]) {
    const hd = F.hostDir(dir, host)
    fs.mkdirSync(hd, { recursive: true })
    for (const d of hist) fs.writeFileSync(path.join(hd, `${d.day}.jsonl`), dayText(d))
  }
  return dir
}
/** Every file under a dir → its sha256 (the "changed no byte" checks). */
function snap(dir) {
  const out = {}
  const walk = (d, rel) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), r = rel ? `${rel}/${n}` : n; if (fs.statSync(p).isDirectory()) { out[r + '/'] = 'dir'; walk(p, r) } else out[r] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } }
  if (fs.existsSync(dir)) walk(dir, '')
  return out
}
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')

/** Run the script: → { code, json (the --json report line), out, err }. Never the real config, dir or ports. */
function run(dir, extra = [], env = {}, host = HOST) {
  const e = { ...process.env, AI_BRIDGE_CONFIG: CONFIG_FILE, ...env }
  for (const k of ['AI_BRIDGE_PORT', 'AI_BRIDGE_PERSIST_DIR', 'AI_BRIDGE_BIND', 'AI_BRIDGE_TEST_HOSTNAME', 'AIMB_TEST_MIGRATE_STOP', 'AIMB_TEST_MIGRATE_CORRUPT']) if (!(k in env)) delete e[k]
  for (const k of Object.keys(e)) if (k.startsWith('AI_BRIDGE_ACTIVITY_')) delete e[k]
  const args = [SCRIPT, '--dir', dir, '--host', host, '--port', String(extra.includes('--port') ? extra[extra.indexOf('--port') + 1] : DEAD_PORT), '--config', CONFIG_FILE, '--json', ...extra.filter((a, i) => a !== '--port' && extra[i - 1] !== '--port')]
  return new Promise(resolve => {
    const ch = spawn(process.execPath, args, { env: e, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    ch.stdout.on('data', d => { out += d }); ch.stderr.on('data', d => { err += d })
    ch.on('close', code => { let json = null; const l = out.trim().split('\n').filter(x => x.startsWith('{')).pop(); try { json = JSON.parse(l) } catch { } resolve({ code, json, out, err }) })
  })
}

// the reference: what the converter makes of HIST (the bytes every finished run must leave)
const REF = C.convertV5(HIST.map(d => ({ day: d.day, records: dayText(d).trim().split('\n') })), { host: HOST, config: CFG_ACT })
const REF_BYTES = Object.fromEntries(REF.days.map(d => [d.day, C.dayBytes(d.records)]))
/** The checks every finished conversion of HOST in `dir` must pass. '' = all good. */
function converted(dir, host = HOST, ref = REF_BYTES) {
  const hd = F.hostDir(dir, host)
  const names = fs.readdirSync(hd).filter(n => !n.includes('conflicted copy')).sort()
  const want = [...Object.keys(ref).flatMap(d => [`${d}.idx.json`, `${d}.jsonl`]), 'format.json'].sort()
  if (J(names) !== J(want)) return `files ${J(names)} ≠ ${J(want)}`
  const mk = JSON.parse(fs.readFileSync(path.join(hd, 'format.json'), 'utf8'))
  if (mk.v !== 6 || mk.by !== G.MIGRATOR || mk.host !== host || !mk.at) return `marker ${J(mk)}`
  for (const [day, buf] of Object.entries(ref)) {
    const b = fs.readFileSync(path.join(hd, `${day}.jsonl`))
    if (!b.equals(buf)) return `${day}.jsonl differs from the converter's bytes`
    if (mk.days[day].size !== b.length || mk.days[day].sha256 !== sha(b)) return `marker ${day} ≠ the file`
    if (!F.linesOf(b).every(l => l.rec && M.recordKind2(l.rec))) return `${day}: a line that is not v6`
    if (J(JSON.parse(fs.readFileSync(path.join(hd, `${day}.idx.json`), 'utf8'))) !== J(F.buildIndex(day, b))) return `${day}.idx.json ≠ buildIndex`
  }
  if (fs.existsSync(G.backupDir(dir, host))) return 'the backup directory is still there'
  return ''
}

// ===============================================================================================================
await section(async () => {
  check('the 1.7x fixture: 3 days of history with plans, a move, a question and a dismissal', HIST.length === 3 && REF.report.moved >= 1 && REF.report.removed.dismiss >= 1 && REF.report.nodes >= 8, J(REF.report))
  const r = await run(persist(), ['--bogus'])
  check('a bad command line → exit 64 with the usage', r.code === 64 && /usage:/.test(r.err), J(r))
  const r2 = await run(path.join(TMP, 'no-such-dir'))
  check('a persistence dir that does not exist → refused (exit 2), nothing created', r2.code === 2 && r2.json.status === 'refused' && !fs.existsSync(path.join(TMP, 'no-such-dir')), J(r2.json))
})

await section(async () => {
  // ---- the DRY RUN: the report, and not one byte written
  const dir = persist(), before = snap(dir)
  const r = await run(dir, ['--dry-run'])
  check('dry run: exit 0, status dry-run, the report (days, records, nodes, ghosts) = the converter\'s', r.code === 0 && r.json.status === 'dry-run' && r.json.report.days === 3 && r.json.report.records === REF.report.records_in
    && r.json.report.nodes === REF.report.nodes && r.json.report.ghosts === REF.report.ghosts && /would convert 3 day files/.test(r.json.message) && /nothing written/.test(r.json.message), J(r.json))
  check('dry run: every file unchanged (names + sha256), no backup directory, no .tmp, no marker', J(snap(dir)) === J(before) && !fs.existsSync(path.join(dir, G.BACKUP_ROOT)), J(snap(dir)))
  const t = await run(dir, ['--dry-run', '--port', String(DEAD_PORT)], {}, HOST)
  const txt = await new Promise(res => { const ch = spawn(process.execPath, [SCRIPT, '--dir', dir, '--host', HOST, '--port', String(DEAD_PORT), '--config', CONFIG_FILE, '--dry-run'], { env: { ...process.env, AI_BRIDGE_CONFIG: CONFIG_FILE } }); let o = ''; ch.stdout.on('data', d => { o += d }); ch.on('close', c => res({ c, o })) })
  check('dry run without --json: the text report names the host, its directory and what it would write', t.code === 0 && txt.c === 0 && txt.o.includes(`host ${HOST}`) && txt.o.includes('activity/robin-z790 (dry run): would convert'), txt.o)
})

await section(async () => {
  // ---- the RUN, then the idempotent re-run
  const dir = persist()
  const r = await run(dir)
  check('run: exit 0, status done, "verified, backup (…) removed"', r.code === 0 && r.json.status === 'done' && r.json.report.verified === true && /verified, backup \(.+\) removed/.test(r.json.message), J(r.json))
  const bad = converted(dir)
  check('run: the day files are v6 and byte-identical to the converter\'s; an index file per day = buildIndex; the marker\'s sizes + sha256 match; the backup is gone', !bad, bad)
  check('run: activity-v5-backup/ itself is removed when empty', !fs.existsSync(path.join(dir, G.BACKUP_ROOT)))
  check('the 2.0 start check (§7.5) passes on the converted directory', G.startCheck2(dir, HOST).ok === true)
  // a 2.0 replay of the files as a bridge reads them (newest first, through the files layer) = the converter's board
  const B = M.createModel({ origin: HOST, config: CFG_ACT })
  const rp = M.createReplay2(B, { now: Date.now() + 1, from: 0 })
  for (const x of F.readBackwards(dir, HOST)) rp.feed(x.rec, x.day)
  rp.finish()
  check('the converted files replayed backwards through the files layer give the converter\'s board', G.dumpModel2(B) === G.dumpModel2(REF.model))
  const before = snap(dir)
  const r2 = await run(dir)
  check('a re-run after success: exit 0 "already converted (format v6, <day> by aimb-migrate-v2 …) — nothing to do", not one byte changed', r2.code === 0 && r2.json.status === 'already' && /already converted \(format v6, \d{4}-\d{2}-\d{2} by aimb-migrate-v2/.test(r2.json.message) && J(snap(dir)) === J(before), J(r2.json))
  const r3 = await run(dir, ['--dry-run'])
  check('… and its dry run says the same', r3.code === 0 && r3.json.status === 'already' && J(snap(dir)) === J(before), J(r3.json))
  // the marker deleted by hand: v6 records without a marker are never converted as 1.7x
  fs.rmSync(path.join(F.hostDir(dir, HOST), 'format.json'))
  const before2 = snap(dir)
  const r4 = await run(dir)
  check('v6 records without a marker: refused (exit 2), nothing changed', r4.code === 2 && /2\.0 \(v6\) records but has no format\.json/.test(r4.json.message) && J(snap(dir)) === J(before2), J(r4.json))
})

await section(async () => {
  // ---- REFUSALS while a bridge (or a writer) is up
  const dir = persist(), before = snap(dir)
  const srv = net.createServer(s => s.destroy())
  await new Promise(res => srv.listen(FAKE_PORT, '127.0.0.1', res))
  let r
  try { r = await run(dir, ['--port', String(FAKE_PORT)]) } finally { await new Promise(res => srv.close(res)) }
  check('a "bridge" answering on this host\'s port: refused (exit 2) "a bridge is running on this host … stop every bridge first", nothing written', r.code === 2 && r.json.status === 'refused' && /a bridge is running on this host \(it answers on 127\.0\.0\.1:\d+\) — stop every bridge first/.test(r.json.message) && J(snap(dir)) === J(before), J(r.json))
  const rd = await run(dir, ['--dry-run', '--port', String(FAKE_PORT)])
  check('… the port free again (the fake bridge stopped): the dry run goes ahead', rd.code === 0 && rd.json.status === 'dry-run', J(rd.json))
  // a fresh .tmp (a writer active) → refused; an old one (a crash's leftover) → deleted and the run goes ahead
  const tmpF = path.join(F.hostDir(dir, HOST), `${HIST[2].day}.idx.json.tmp-0a1b2c3d`)
  fs.writeFileSync(tmpF, 'half')
  const r2 = await run(dir)
  check('a .tmp written in the last 10 s: refused (exit 2) "a writer is active", nothing changed', r2.code === 2 && /a writer is active in activity\/robin-z790/.test(r2.json.message) && fs.existsSync(tmpF) && !fs.existsSync(path.join(dir, G.BACKUP_ROOT)), J(r2.json))
  const old = (Date.now() - 60000) / 1000
  fs.utimesSync(tmpF, old, old)
  const r3 = await run(dir)
  check('a stale .tmp (older than 10 s): deleted, the run converts', r3.code === 0 && r3.json.status === 'done' && !fs.existsSync(tmpF) && !converted(dir), J(r3.json) + converted(dir))
  // the 2.0 start check on unconverted history
  const d2 = persist()
  const sc = G.startCheck2(d2, HOST)
  check('the 2.0 start check on 1.7x history: exit 78, "format v5 (pre-2.0). Stop every bridge, then run: node src/tools/aimb-migrate-v2.mjs"', !sc.ok && sc.code === 78 && sc.message.includes('persistence/activity/robin-z790 is format v5 (pre-2.0)') && sc.message.includes('node src/tools/aimb-migrate-v2.mjs'), J(sc))
})

await section(async () => {
  // ---- a FAILED run restores: the planted corruption fails the verification
  const dir = persist(), before = snap(dir)
  const r = await run(dir, [], { AIMB_TEST_MIGRATE_CORRUPT: '1' })
  check('a failed verification: exit 3 "verification failed … RESTORED from the backup"', r.code === 3 && r.json.status === 'failed' && /verification failed/.test(r.json.message) && /RESTORED/.test(r.json.message) && r.json.report.restored === true, J(r.json))
  check('… every v5 file is back byte for byte; no marker, no index file, no backup — the directory is as before the run', J(snap(dir)) === J(before), J([snap(dir), before]))
  check('… so the 2.0 start check still refuses it as v5', G.startCheck2(dir, HOST).code === 78)
  const r2 = await run(dir)
  check('… and the next run converts it (the clean run\'s bytes)', r2.code === 0 && r2.json.status === 'done' && !converted(dir), J(r2.json) + converted(dir))
})

await section(async () => {
  // ---- CRASHES (the test hooks stop the process at a step) and the resumed run
  const orig = Object.fromEntries(HIST.map(d => [`${d.day}.jsonl`, sha(Buffer.from(dayText(d)))]))
  {
    const dir = persist()
    const r = await run(dir, [], { AIMB_TEST_MIGRATE_STOP: 'backup' })
    const bd = G.backupDir(dir, HOST), c = JSON.parse(fs.readFileSync(path.join(bd, 'COMPLETE'), 'utf8'))
    check('a crash after the backup: it holds byte-identical copies of every v5 day + COMPLETE (names, sizes, sha256)', r.code === 9 && J(fs.readdirSync(bd).sort()) === J([...Object.keys(orig), 'COMPLETE'].sort())
      && Object.entries(orig).every(([n, h]) => sha(fs.readFileSync(path.join(bd, n))) === h && c.files[n].sha256 === h), J(r))
    check('… the 2.0 start check refuses: "did not finish — run … again"', G.startCheck2(dir, HOST).code === 78 && /did not finish/.test(G.startCheck2(dir, HOST).message))
    const r2 = await run(dir)
    check('… the next run resumes from it: done, the clean run\'s bytes', r2.code === 0 && r2.json.status === 'done' && /resumed/.test(r2.json.message) && !converted(dir), J(r2.json) + converted(dir))
  }
  {
    const dir = persist()
    const r = await run(dir, [], { AIMB_TEST_MIGRATE_STOP: 'day:2' })
    const hd = F.hostDir(dir, HOST)
    const half = fs.readFileSync(path.join(hd, `${HIST[0].day}.jsonl`)).equals(REF_BYTES[HIST[0].day]) && sha(fs.readFileSync(path.join(hd, `${HIST[2].day}.jsonl`))) === orig[`${HIST[2].day}.jsonl`]
    const bdBefore = snap(G.backupDir(dir, HOST))
    const rd = await run(dir, ['--dry-run'])
    check('a crash after converting 2 of 3 days: the directory is half v6, half v5; a dry run says a real run resumes from the backup, and changes nothing', r.code === 9 && half && rd.code === 0 && rd.json.lines.some(l => /resumes from its backup/.test(l)) && J(snap(G.backupDir(dir, HOST))) === J(bdBefore), J(rd.json))
    const r2 = await run(dir)
    check('… the next run converts from the BACKUP (never the half-converted days): the clean run\'s bytes, byte for byte', r2.code === 0 && r2.json.status === 'done' && !converted(dir), J(r2.json) + converted(dir))
  }
  {
    const dir = persist()
    const r = await run(dir, [], { AIMB_TEST_MIGRATE_STOP: 'marker' })
    const r2 = await run(dir)
    check('a crash after the marker: the next run verifies and removes the backup', r.code === 9 && r2.code === 0 && r2.json.status === 'done' && r2.json.report.verified === true && !converted(dir), J(r2.json) + converted(dir))
  }
  {
    const dir = persist()
    const r = await run(dir, [], { AIMB_TEST_MIGRATE_STOP: 'delete' })
    const bd = G.backupDir(dir, HOST), left = fs.readdirSync(bd)
    const r2 = await run(dir)
    check('a crash mid-delete (COMPLETE is deleted last, so it is still there): the next run finishes the delete', r.code === 9 && left.includes('COMPLETE') && left.length < 4 && r2.code === 0 && r2.json.status === 'done' && /removed now/.test(r2.json.message) && !converted(dir), J([left, r2.json]))
  }
  {
    // a backup without COMPLETE (a crash while copying) is redone from the (untouched) directory
    const dir = persist(), bd = G.backupDir(dir, HOST)
    fs.mkdirSync(bd, { recursive: true })
    fs.writeFileSync(path.join(bd, `${HIST[0].day}.jsonl`), 'half a cop')
    const r = await run(dir)
    check('a backup without COMPLETE is redone: the run converts the directory\'s own files (the clean run\'s bytes)', r.code === 0 && r.json.status === 'done' && !converted(dir), J(r.json) + converted(dir))
  }
  {
    // a damaged backup (a file no longer matching COMPLETE) is never used — and kept for a person to look at
    const dir = persist()
    await run(dir, [], { AIMB_TEST_MIGRATE_STOP: 'day:1' })
    const bd = G.backupDir(dir, HOST)
    fs.appendFileSync(path.join(bd, `${HIST[1].day}.jsonl`), 'x')
    const r = await run(dir)
    check('a damaged backup: exit 3 "the backup is damaged", the backup kept', r.code === 3 && /the backup is damaged/.test(r.json.message) && fs.existsSync(path.join(bd, 'COMPLETE')), J(r.json))
  }
})

await section(async () => {
  // ---- the DROPBOX rule: a conflicted copy; two hosts in one persistence dir
  const dir = persist(), hd = F.hostDir(dir, HOST)
  const cc = `${HIST[0].day} (LITTLE-001's conflicted copy 2026-10-03).jsonl`
  const ccText = J({ ...HIST[0].records.find(r => V.recordKind(r) === 'entry'), id: 'act_conflicted-1', text: 'from the conflicted copy' }) + '\n'
  fs.writeFileSync(path.join(hd, cc), ccText)
  const rd = await run(dir, ['--dry-run'])
  check('a conflicted copy: the dry run WARNs about it', rd.code === 0 && rd.json.warnings.some(w => w.includes('conflicted copy') && w.includes(cc)), J(rd.json.warnings))
  const r = await run(dir)
  const all = fs.readdirSync(hd).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).flatMap(n => F.linesOf(fs.readFileSync(path.join(hd, n))).map(l => l.rec))
  check('… the run WARNs, converts the rest, leaves it in place unchanged and never converts it', r.code === 0 && r.json.status === 'done' && r.json.warnings.some(w => w.includes(cc)) && r.json.report.conflicted.includes(cc)
    && fs.readFileSync(path.join(hd, cc), 'utf8') === ccText && !all.some(x => x && x.id === 'act_conflicted-1') && !converted(dir), J(r.json) + converted(dir))
  const sc = G.startCheck2(dir, HOST)
  check('… and the start check is not bothered by it', sc.ok === true)

  // two hosts' directories in one persistence dir: one run touches only its own; both at the same moment
  const d2 = persist({ two: true })
  const other = snap(F.hostDir(d2, HOST2))
  const ra = await run(d2)
  check('two hosts in one persistence dir: converting ROBIN-Z790 leaves LITTLE-001\'s directory byte for byte as it was', ra.code === 0 && !converted(d2) && J(snap(F.hostDir(d2, HOST2))) === J(other), J(ra.json))
  const d3 = persist({ two: true })
  const REF2 = C.convertV5(HIST2.map(d => ({ day: d.day, records: dayText(d).trim().split('\n') })), { host: HOST2, config: CFG_ACT })
  const [x, y] = await Promise.all([run(d3, [], {}, HOST), run(d3, [], {}, HOST2)])
  check('… both converted at the same moment: each its own directory, each the converter\'s bytes; no backup left', x.code === 0 && y.code === 0 && !converted(d3, HOST) && !converted(d3, HOST2, Object.fromEntries(REF2.days.map(d => [d.day, C.dayBytes(d.records)])))
    && !fs.existsSync(path.join(d3, G.BACKUP_ROOT)), J([x.json, y.json]) + converted(d3, HOST2, Object.fromEntries(REF2.days.map(d => [d.day, C.dayBytes(d.records)]))))
  check('… ids differ across hosts (every id hashes the host)', (() => { const a = new Set(REF.model.sessions.values().next().value.nodes.keys()); return [...REF2.model.sessions.values()].every(s => [...s.nodes.keys()].every(k => !a.has(k))) })())
})

await section(async () => {
  // ---- a FRESH host, and a host with no directory at all
  const dir = path.join(TMP, 'fresh'), hd = F.hostDir(dir, HOST)
  fs.mkdirSync(hd, { recursive: true })
  const rd = await run(dir, ['--dry-run'])
  check('an empty host directory: the dry run would write the marker, writes nothing', rd.code === 0 && /would write the format marker/.test(rd.json.message) && fs.readdirSync(hd).length === 0, J(rd.json))
  check('… the start check: fresh (the gateway writes the marker and starts)', G.startCheck2(dir, HOST).fresh === true)
  const r = await run(dir)
  const mk = JSON.parse(fs.readFileSync(path.join(hd, 'format.json'), 'utf8'))
  check('… the run writes the marker (a fresh host), exit 0; then the start check passes', r.code === 0 && r.json.status === 'fresh' && mk.v === 6 && J(mk.days) === '{}' && G.startCheck2(dir, HOST).ok === true && !G.startCheck2(dir, HOST).fresh, J(r.json))
  const r2 = await run(dir, [], {}, 'SOME-OTHER-HOST')
  check('a host with no activity directory: exit 0 "nothing to convert", names the other hosts there, creates nothing', r2.code === 0 && r2.json.status === 'nothing' && /other hosts' directories here: robin-z790/.test(r2.json.message) && !fs.existsSync(F.hostDir(dir, 'SOME-OTHER-HOST')), J(r2.json))
})

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
