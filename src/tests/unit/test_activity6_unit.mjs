// Fast UNIT tests for #88 (v2.0) build step 6 — BRIDGE FILES: the 2.0 gateway's store (lib/activity2-store.js) over the
// persistence facet's `activity2` (facets/persistence/file.js → lib/activity2-files.js), on TEMP persistence dirs only — no
// bridge, no sockets (docs/spec-88.md §2.4, §5.1 – §5.3, §7.5, §8 step 6, §10). Covered:
//   - the start check through the store (§7.5): a fresh host writes the marker; v5 history / a leftover backup refuse (78);
//   - writes through the writer (a call's node records + entries by id), cp / rep, the carry-forward once per day (a
//     restart the same day writes none), the closed day's INDEX at the rollover = a rebuild of it, a missing or stale index
//     file rebuilt at open;
//   - PAGING through the index: only the days whose index names a member are read (the facet's counter), only the span's
//     bytes, BACKWARDS (a page that fills early reads only the tail of a big span), cursors across days with no duplicate
//     and no gap, the run boundary (run_start / earlier_cursor / earlier:true / pruned);
//   - GHOSTS: a dismissed agent's and a vanished bucket's entries only with removed:true (the dismissal entry on the parent
//     always), the ghost table REBUILT from the index files after a restart whose window misses the removal, a ghost
//     leaving with its last retained day (a ghost chain kept while a ghost below still has entries);
//   - the Dropbox rule: a conflicted copy WARNED once per name, in fs_warnings, never read or pruned;
//   - a memory-only store (no persistence): pages from the members' in-memory logs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testOnly } from '../helpers/check.mjs'
import * as A from '../../lib/activity.js'
import * as M from '../../lib/activity2.js'
import * as F from '../../lib/activity2-files.js'
import * as S from '../../lib/activity2-store.js'
import { create as createPersistence } from '../../facets/persistence/file.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.stack} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
function section(name, fn) { try { fn() } catch (e) { fail++; console.log(`FAIL section "${name}" crashed:`, (e && e.stack) || e) } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-act6-'))
const HOST = 'ROBIN-Z790'
const MIN = 60000, HOUR = 3600000, DAY = 86400000
const T0 = new Date(2026, 9, 1, 9, 0, 0).getTime()   // a LOCAL morning: day files are per local day
const at = (d, h, m = 0) => new Date(2026, 9, 1 + d, h, m, 0).getTime()
const dayOf = d => A.localDay(at(d, 12))
const LEAD = { session: 'Lead', project: 'AIMB', user: 'robin', realm: 'default' }
const DASH = { kind: 'dashboard', user: 'robin', host: HOST }
let nDir = 0
const newDir = () => { const d = path.join(TMP, `p${++nDir}`); fs.mkdirSync(d, { recursive: true }); return d }
const facetOf = dir => createPersistence({ CFG: { persistence: { dir } }, HERE: dir, env: {} }).activity2
function mk(dir, cfg = {}, logs = []) {
  const fsx = dir ? facetOf(dir) : null
  const s = S.createStore2({ host: HOST, fsx, config: A.resolveConfig({ log_retention_days: 30, ...cfg }, {}), idPrefix: 'act_t6_', log: l => logs.push(l) })
  return { s, fsx, logs }
}
/** The bridge's cadence in miniature: a rollover whenever the local day changed, then the call. */
function drive(s) {
  return {
    log(input, t, ident = LEAD) { if (s.rolloverDue(t)) s.rollover(t); const r = s.apply(ident, input, t); if (!r.ok) throw new Error(`${J(input)} → ${J(r)}`); return r },
    act(q, t) { if (s.rolloverDue(t)) s.rollover(t); const r = s.action({ ...LEAD, ...q }, t, { by: DASH }); if (!r.ok) throw new Error(`${J(q)} → ${J(r)}`); return r },
  }
}
const hd = dir => F.hostDir(dir, HOST)
const recsOf = (dir, day) => { try { return fs.readFileSync(path.join(hd(dir), `${day}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const allPages = (s, q, now, lim = 3) => { const out = []; let cur = null, n = 0, last = null; do { last = s.logPage({ ...q, limit: lim, ...(cur ? { cursor: cur } : {}) }, now); if (!last.ok) return { out, last }; out.push(...last.entries); cur = last.next_cursor } while (cur && n++ < 200); return { out, last } }

// ---------------------------------------------------------------------------------------------------------------
section('start check', () => {
  const dir = newDir(), { s, logs } = mk(dir)
  const r = s.start(T0)
  const m = JSON.parse(fs.readFileSync(path.join(hd(dir), 'format.json'), 'utf8'))
  check('start: a fresh host (no history, no marker) starts and gets the v6 marker', r.ok && r.fresh && m.v === 6 && m.fresh === true && logs.some(l => l.includes('format marker')), J([r, m]))
  check('start: once marked, the next start is plain ok', J(mk(dir).s.start(T0)) === J({ ok: true }))
  const v5 = newDir(); fs.mkdirSync(hd(v5), { recursive: true }); fs.writeFileSync(path.join(hd(v5), `${dayOf(0)}.jsonl`), J({ v: 5, ts: T0, session: 'x', path: '' }) + '\n')
  const r5 = mk(v5).s.start(T0)
  check('start: v5 history (day files, no marker) → refused 78, the migration command named', !r5.ok && r5.code === 78 && r5.message.includes('is format v5 (pre-2.0)') && r5.message.includes('node src/tools/aimb-migrate-v2.mjs'), J(r5))
  fs.mkdirSync(path.join(dir, 'activity-v5-backup', 'robin-z790'), { recursive: true })
  const rb = mk(dir).s.start(T0)
  check('start: a leftover migration backup → refused 78 "did not finish"', !rb.ok && rb.code === 78 && rb.message.includes('did not finish'), J(rb))
  check('start: a memory-only store (no persistence) needs no check', mk(null).s.start(T0).ok)
})

// ---------------------------------------------------------------------------------------------------------------
section('writes, rollover, index files', () => {
  const dir = newDir(), { s, fsx, logs } = mk(dir), g = drive(s)
  s.start(T0); s.open(at(0, 9)); s.rollover(at(0, 9), 'startup')
  const w = g.log({ agent: 'w1', label: 'Worker 1', text: '@starting', state: 'running' }, at(0, 9, 1))
  const n1 = g.log({ agent: 'w1', key: 'notes', label: 'Notes', text: '@note one' }, at(0, 9, 2))
  g.log({ agent: 'w1', key: 'notes', text: 'quiet', log: false, progress: '1/4' }, at(0, 9, 3))
  const cps = s.checkpoint(at(0, 9, 4))
  const d0 = recsOf(dir, dayOf(0))
  check('writes: a call\'s node records and entries land in today\'s file in order, by id (create before its entry; at = the path)', d0.some(r => r.kind === 'node' && r.op === 'create' && r.n === w.node.id) && d0.findIndex(r => r.kind === 'node' && r.n === n1.node.id) < d0.findIndex(r => r.id === n1.id)
    && d0.find(r => r.id === n1.id)?.at === 'Worker 1/Notes' && d0.every(r => r.v === 6), J(d0.map(r => [r.kind || (r.rep ? 'rep' : 'entry'), r.op])))
  check('writes: a log:false report writes no entry; the checkpoint writes its cp line', cps === 1 && d0.some(r => r.kind === 'cp' && r.n === n1.node.id && r.progress?.done === 1), J(cps))
  check('writes: no cf the first day (the board was empty at the startup rollover); no index file for the open day', !d0.some(r => r.kind === 'cf') && !fs.existsSync(F.indexFile(dir, HOST, dayOf(0))))
  g.log({ agent: 'w1', key: 'notes', text: '@day two' }, at(1, 10))
  const ix0 = F.readIndex(dir, HOST, dayOf(0)), rb0 = F.buildIndex(dayOf(0), fs.readFileSync(F.dayFile(dir, HOST, dayOf(0))))
  check('rollover: the closed day\'s index file is written at the rollover and EQUALS a rebuild of its day file', !!ix0 && J(ix0) === J(rb0) && ix0.nodes[n1.node.id][2] === 1 && logs.some(l => l.includes(`wrote the index of ${dayOf(0)}`)), J(ix0 && ix0.nodes))
  const d1 = recsOf(dir, dayOf(1))
  check('rollover: the new day\'s file OPENS with the whole board as cf lines (root, the agent, its context), then the day\'s writes', d1.length > 3 && d1[0].kind === 'cf' && d1.slice(0, 3).every(r => r.kind === 'cf') && d1.some(r => r.kind === 'cf' && r.n === n1.node.id && r.label === 'Notes'), J(d1.map(r => r.kind || 'entry')))
  // a restart the same day: no second cf; a missing / stale closed index is rebuilt (and equals the written one)
  fs.unlinkSync(F.indexFile(dir, HOST, dayOf(0)))
  const r2 = mk(dir), st2 = r2.s.open(at(1, 11))
  const roll2 = r2.s.rollover(at(1, 11), 'startup')
  check('restart: the replay sees today\'s cf — the startup rollover writes no second one', st2.cf_today === true && roll2.cf === 0 && recsOf(dir, dayOf(1)).filter(r => r.kind === 'cf').length === d1.filter(r => r.kind === 'cf').length, J([st2.cf_today, roll2]))
  check('restart: a MISSING index file of a closed day is rebuilt at open — equal to the one written at the rollover', J(F.readIndex(dir, HOST, dayOf(0))) === J(ix0) && r2.logs.some(l => l.includes(`index of ${dayOf(0)} was missing`)), J(r2.logs))
  fs.appendFileSync(F.dayFile(dir, HOST, dayOf(0)), J({ v: 6, kind: 'node', op: 'label', ts: at(0, 23), n: n1.node.id, label: 'Notes', ...{ realm: 'default', project: 'AIMB', user: 'robin', session: 'Lead', host: HOST, origin: HOST, s0: at(0, 9, 1) } }) + '\n')
  const r3 = mk(dir); r3.s.open(at(1, 12))
  check('restart: a STALE index file (its size ≠ the day file\'s) is rebuilt at open', F.readIndex(dir, HOST, dayOf(0))?.size === fs.statSync(F.dayFile(dir, HOST, dayOf(0))).size && r3.logs.some(l => l.includes('was stale')), J(r3.logs))
  check('restart: the replayed board equals the live one (lines, the log:false bar via its cp)', (n => n && n.current?.text === 'day two' && n.progress?.done === 1)(r3.s.state.sessions.values().next().value.nodes.get(n1.node.id)), '')
  void fsx
})

// ---------------------------------------------------------------------------------------------------------------
section('paging through the index', () => {
  const dir = newDir(), { s, fsx } = mk(dir), g = drive(s)
  s.start(T0); s.open(at(0, 8)); s.rollover(at(0, 8), 'startup')
  const a = g.log({ agent: 'wa', label: 'Agent A', text: '@a1', state: 'running' }, at(0, 9))
  g.log({ agent: 'wb', label: 'Agent B', text: '@b day0', state: 'running' }, at(0, 9, 1))
  g.log({ agent: 'wb', text: 'b day1' }, at(1, 9))   // day 1: B only
  g.log({ agent: 'wa', text: 'a day2 first' }, at(2, 8))
  for (let i = 0; i < 600; i++) g.log({ agent: 'wb', text: `b filler ${i} ` + 'x'.repeat(200) }, at(2, 9) + i * 1000)   // a big span of B's between A's two day-2 entries
  g.log({ agent: 'wa', text: 'a day2 last' }, at(2, 12))
  const now = at(2, 13)
  const st0 = { ...fsx.stats }
  const p1 = s.logPage({ session: 'Lead', id: a.node.id, limit: 1 }, now)
  const st1 = { ...fsx.stats }
  check('paging: a limit-1 page of A reads ONE span (today\'s) and only its TAIL — far fewer bytes than the span holds (backwards, in chunks)', p1.entries.length === 1 && p1.entries[0].text === 'a day2 last' && st1.span_reads - st0.span_reads === 1 && st1.span_bytes - st0.span_bytes < 80 * 1024 && st1.day_reads === st0.day_reads,
    J([p1.entries.map(e => e.text), st0, st1]))
  const st2 = { ...fsx.stats }
  const pa = allPages(s, { session: 'Lead', id: a.node.id }, now, 2)
  const st3 = { ...fsx.stats }
  check('paging: every page of A together = all its entries newest first, no duplicate, no gap — across days, by cursor', J(pa.out.map(e => e.text)) === J(['a day2 last', 'a day2 first', 'a1']) && pa.last.run_start === true && !pa.last.next_cursor, J(pa.out.map(e => e.text)))
  check('paging: day 1 (no entry of A in its index) is never read; no whole day is read', st3.day_reads === st2.day_reads && (() => { const d1 = F.readIndex(dir, HOST, dayOf(1)); return d1 && !d1.nodes[a.node.id] })(), J([st2, st3]))
  const pc = s.logPage({ session: 'Lead', id: a.node.id, cursor: 'f2.2026-10-03.not' }, now)
  check('paging: a malformed cursor → bad-cursor', !pc.ok && pc.code === 'bad-cursor', J(pc))
  check('paging: total = the members\' entry count from the indexes (A: a1, a day2 first, a day2 last)', p1.total === 3, J(p1.total))
})

// ---------------------------------------------------------------------------------------------------------------
section('ghosts, show removed, runs', () => {
  const dir = newDir(), { s } = mk(dir, { finished_visible_hours: 24 }), g = drive(s)
  s.start(T0); s.open(at(0, 8)); s.rollover(at(0, 8), 'startup')
  const h = g.log({ agent: 'helper', label: 'Helper', text: '@helping', state: 'running' }, at(0, 9))
  g.log({ agent: 'helper', key: 'scratch', label: 'Scratch', text: '@scratching' }, at(0, 9, 5))
  g.log({ agent: 'helper', text: '@helped', state: 'done' }, at(0, 10))
  const dis = g.act({ id: h.node.id, action: 'dismiss' }, at(0, 11))
  const lead = g.log({ text: '@the lead', state: 'running' }, at(0, 12))
  const job = g.log({ key: 'job', label: 'Job', text: '@queued', move_to: '/Pending' }, at(0, 13))
  g.log({ key: 'job', text: '@picked up', move_to: '/Doing' }, at(0, 14))   // Pending vanishes (a ghost); Doing is new
  g.log({ key: 'job', text: '@queued again', move_to: '/Pending' }, at(0, 15))   // Pending RESURRECTED: same id, a new run
  const now = at(0, 16)
  const off = s.logPage({ session: 'Lead', limit: 100 }, now), on = s.logPage({ session: 'Lead', limit: 100, removed: true }, now)
  check('ghosts: the dismissed agent\'s (and its context\'s) entries are left out by default — the dismissal entry on the parent always shows', dis.ok && !off.entries.some(e => e.path?.startsWith('Helper')) && off.entries.some(e => e.dismiss && e.of === h.node.id), J(off.entries.map(e => [e.path, e.text, e.dismiss])))
  check('ghosts: removed:true adds them, marked removed, under their last path (Helper, Helper/Scratch)', ['helping', 'scratching', 'helped'].every(t => on.entries.some(e => e.text === t && e.removed === true && e.path.startsWith('Helper'))) && on.ghost_members >= 2 && on.entries.some(e => e.path === 'Helper/Scratch' && e.removed), J(on.entries.map(e => [e.path, e.text, e.removed])))
  const pend = [...s.state.sessions.values()][0], pid = M.findPath(pend, 'Pending')?.id
  const pp = s.logPage({ session: 'Lead', id: pid }, now)
  check('runs: a resurrected bucket\'s log is its CURRENT run — its own entries since it came back, the moved-in Job\'s whole run (§5.3) — run_start, with an earlier_cursor', pp.ok && pp.run_start === true && !!pp.earlier_cursor && !pp.entries.some(e => e.node_id === pid && e.ts < at(0, 15)) && pp.entries.some(e => e.node_id === job.node.id && e.text === 'queued'), J([pp.entries.map(e => [e.text, e.ts]), pp.run_start, pp.earlier_cursor]))
  const pe = s.logPage({ session: 'Lead', id: pid, cursor: pp.earlier_cursor, earlier: true }, now)
  check('runs: earlier:true from earlier_cursor pages the EARLIER run only (its first use: the emptied entry)', pe.ok && pe.entries.length > 0 && pe.entries.every(e => e.node_id === pid && e.ts < at(0, 15)), J(pe.entries.map(e => [e.text, e.ts])))
  void lead
  // a RESTART after the window (24 h): the removals are older than the window → the ghost table comes from the index files
  s.rollover(at(1, 0, 1)); s.rollover(at(2, 0, 1))
  const r2 = mk(dir, { finished_visible_hours: 24 }), st = r2.s.open(at(2, 12))
  r2.s.rollover(at(2, 12), 'startup')
  const sess2 = [...r2.s.state.sessions.values()][0], gh = sess2 && sess2.ghosts.get(h.node.id)
  check('restart: the ghost table is REBUILT from the index files (the dismissal lies before the replay window) — key, label, parent, last_ts = its last entry\'s day', st.ghosts_rebuilt >= 2 && gh && gh.label === 'Helper' && gh.key === 'helper' && gh.last_ts === new Date(2026, 9, 1).getTime(), J([st, gh]))
  const on2 = r2.s.logPage({ session: 'Lead', limit: 100, removed: true }, at(2, 12)), off2 = r2.s.logPage({ session: 'Lead', limit: 100 }, at(2, 12))
  check('restart: after the rebuild, removed:true still finds the helper\'s entries in the day-0 file; default still hides them', ['helping', 'helped'].every(t => on2.entries.some(e => e.text === t && e.removed)) && !off2.entries.some(e => e.removed), J(on2.entries.map(e => [e.path, e.text])))
  check('restart: a re-created agent of a ghost\'s key comes back as ITSELF (same id, a new run)', (() => { const r = drive(r2.s).log({ agent: 'helper', label: 'Helper', text: '@back', state: 'running' }, at(2, 13)); return r.node.id === h.node.id && r.node.created })())
  // retention drops day 0 (its index too): the helper's... (it is live again) — the Scratch ghost leaves with its last day
  const r3 = mk(dir, { finished_visible_hours: 24, log_retention_days: 1 }), st3 = r3.s.open(at(2, 14))
  const sess3 = [...r3.s.state.sessions.values()][0]
  check('retention: day 0 goes with its index file; the Scratch ghost (its only entries were on day 0) leaves the table', !fs.existsSync(F.dayFile(dir, HOST, dayOf(0))) && !fs.existsSync(F.indexFile(dir, HOST, dayOf(0))) && st3.pruned.includes(dayOf(0)) && sess3 && ![...sess3.ghosts.values()].some(x => x.label === 'Scratch'), J([st3.pruned, sess3 && [...sess3.ghosts.values()].map(x => [x.label, x.last_ts])]))
  const pr = r3.s.logPage({ session: 'Lead', limit: 100 }, at(2, 14))
  check('retention: a node whose run began in a deleted day pages to the end with pruned:true (never a silent gap)', pr.ok && pr.pruned === true && !pr.run_start, J([pr.pruned, pr.run_start]))
})

// ---------------------------------------------------------------------------------------------------------------
section('ghost chains', () => {
  // a ghost whose own entries are gone stays while a ghost BELOW it still has entries (it links them to the live ancestor)
  const st = M.createModel({ origin: HOST })
  const sess = M.getSession2(st, LEAD, T0)
  sess.ghosts.set('aaaaaaaaaaaaaaaa', { id: 'aaaaaaaaaaaaaaaa', key: 'p', creator: sess.rootId, label: 'P', kind: 'context', parent: sess.rootId, last_ts: null })
  sess.ghosts.set('bbbbbbbbbbbbbbbb', { id: 'bbbbbbbbbbbbbbbb', key: 'c', creator: sess.rootId, label: 'C', kind: 'context', parent: 'aaaaaaaaaaaaaaaa', last_ts: at(1, 0) })
  sess.gkids.set(sess.rootId, new Set(['aaaaaaaaaaaaaaaa'])); sess.gkids.set('aaaaaaaaaaaaaaaa', new Set(['bbbbbbbbbbbbbbbb']))
  const d1 = M.pruneGhosts(st, at(0, 0))
  check('ghost chain: a ghost with no retained entry is KEPT while a ghost below it still has one', d1.length === 0 && sess.ghosts.size === 2, J(d1))
  const d2 = M.pruneGhosts(st, at(2, 0))
  check('ghost chain: once the lower ghost\'s last day goes, both leave', d2.length === 2 && sess.ghosts.size === 0, J(d2))
})

// ---------------------------------------------------------------------------------------------------------------
section('Dropbox rule', () => {
  const dir = newDir(), { s, logs } = mk(dir)
  s.start(T0)
  fs.writeFileSync(path.join(hd(dir), `${dayOf(0)} (LITTLE-001's conflicted copy ${dayOf(1)}).jsonl`), 'x\n')
  s.open(at(5, 9)); s.rollover(at(5, 9), 'startup'); s.rollover(at(6, 9))
  const warns = logs.filter(l => l.startsWith('WARN') && l.includes('conflicted copy'))
  check('conflicted copy: WARNED once per name (open + a later rollover = one line), listed in the head\'s fs_warnings', warns.length === 1 && (s.head().fs_warnings || []).length === 1 && s.head().format === 6, J([warns, s.head()]))
  const r = mk(dir, { log_retention_days: 1 }); r.s.open(at(9, 9))
  check('conflicted copy: never read, never pruned by retention (an exact-name rule)', fs.existsSync(path.join(hd(dir), `${dayOf(0)} (LITTLE-001's conflicted copy ${dayOf(1)}).jsonl`)))
})

// ---------------------------------------------------------------------------------------------------------------
section('memory-only store', () => {
  const { s } = mk(null), g = drive(s)
  check('memory: no files — start / open / rollover work, the head has no fs_warnings', s.start(T0).ok && s.open(at(0, 9)).fed === 0 && s.rollover(at(0, 9)).indexed.length === 0 && !s.head().fs_warnings)
  const w = g.log({ agent: 'm1', label: 'Mem', text: '@one', state: 'running' }, at(0, 9, 1))
  g.log({ agent: 'm1', text: 'two' }, at(0, 9, 2)); g.log({ agent: 'm1', text: 'three' }, at(0, 9, 3))
  const all = allPages(s, { session: 'Lead', id: w.node.id }, at(0, 10), 2)
  check('memory: pages come from the in-memory log, newest first, by entry-id cursor', J(all.out.map(e => e.text)) === J(['three', 'two', 'one']) && all.out.every(e => e.node_id === w.node.id && e.path === 'Mem'), J(all.out.map(e => e.text)))
})

// ---------------------------------------------------------------------------------------------------------------
section('readSpanBackwards', () => {
  const dir = newDir(), fsx = facetOf(dir)
  const W = F.createDayWriter({ dir, host: HOST }), ident = { realm: 'default', project: 'P', user: 'u', session: 'S', host: HOST, origin: HOST, s0: T0 }
  const recs = []
  for (let i = 0; i < 50; i++) recs.push({ v: 6, id: `act_x_${(T0 + i).toString(36)}-${i.toString(36)}`, ts: T0 + i, n: i % 2 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb', current: false, text: `t${i} ` + 'y'.repeat(i * 7), state: 'running', at: 'x', ...ident })
  W.writeAll(recs)
  const ix = W.openIndex(dayOf(0)), [from, to] = ix.nodes.aaaaaaaaaaaaaaaa
  const got = [...fsx.readSpanBackwards(HOST, dayOf(0), from, to, { chunk: 300 })].filter(r => r.rec)
  check('readSpanBackwards: the lines starting in [first, last] newest first, exact offsets, tiny chunks', got.length === 49 && got[0].rec.text.startsWith('t49') && got[got.length - 1].rec.text.startsWith('t1 ') && got.every(r => r.length > 0), J([got.length, got[0] && got[0].offset, to]))
  const before = got[10].offset
  const tail = [...fsx.readSpanBackwards(HOST, dayOf(0), from, to, { before })].filter(r => r.rec)
  check('readSpanBackwards: `before` (a cursor) starts below that record', tail.length === got.length - 11 && tail[0].offset === got[11].offset, J([tail.length, tail[0] && tail[0].offset]))
})

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
