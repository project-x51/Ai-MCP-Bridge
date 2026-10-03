// #88 (v2.0) build step 6 — BRIDGE FILES, live: a 2.0 gateway (every gateway since step 9 removed the switch) on a temp
// persistence dir, a temp AI_BRIDGE_CONFIG (never src/config.json), its own TEMP dir (the tray's refusal file) and this
// file's port block (never 12317 / 12318). The history is 1.7x history written by the FROZEN 1.7x library
// (tests/fixtures/activity-v175.js) over three days, then converted by the migration library (lib/activity2-migrate.js,
// as src/tools/aimb-migrate-v2.mjs runs it). The test-only clock hook (AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS) puts the
// gateway a few seconds before a local midnight, so the day ROLLOVER (AI_BRIDGE_ACTIVITY_ROLLOVER_CHECK_MS = 300) happens.
// Covers (docs/spec-88.md §2.4, §5.1, §5.2, §7.5, §8 step 6, §10):
//   (0) the START CHECK — on unconverted (v5) history the 2.0 gateway exits 78 with the command in its stderr line and in
//       the tray's file, changing no byte; a leftover migration backup → 78 "did not finish"; (step 9) WITHOUT the
//       pre-cutover switch the gateway is 2.0 all the same: it refuses the same history (the switch is gone);
//   (1) after the migration the 2.0 gateway STARTS on the converted history (its board, format 6, the tray's old refusal
//       file removed) and WRITES v6 records to today's day file (node records + entries by id) — the open day's index is
//       kept in memory (the file the migration wrote for it goes stale until the rollover rewrites it);
//   (2) log pages via the INDEX: only indexed ranges are read (the facet's counter: span reads, no whole-day reads);
//       ghosts' entries only with removed:true ("show removed");
//   (3) the day ROLLOVER: the closed day's index file is written and EQUALS a rebuild of it; the new day's file opens with
//       the board's cf; a planted Dropbox conflicted copy is warned about (fs_warnings) and left alone;
//   (4) a RESTART days later: the ghost table is REBUILT from the index files (a dismissal outside the replay window still
//       links its agent's entries to the session's log, with removed:true only);
//   (5) a RESTART with a shorter retention: the old days go WITH their index files, and the ghost whose last entry went
//       leaves the table (its entries are gone from the log); the conflicted copy is still there.
import { testOnly } from '../helpers/check.mjs'
import { portBase } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as V from '../fixtures/activity-v175.js'
import * as A from '../../lib/activity.js'
import * as F from '../../lib/activity2-files.js'
import * as G from '../../lib/activity2-migrate.js'
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BASE = portBase(import.meta.url), PORT = String(BASE), WSPORT = String(BASE + 1)
const TOKEN = 'act2filestok', HOST = 'V2HOST-A'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-act2files-'))
const persist = path.join(TMP, 'persist'), tempDir = path.join(TMP, 'temp'), cfgFile = path.join(TMP, 'config.json')
fs.mkdirSync(tempDir, { recursive: true })
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_retention_days: 30 } }))
const hostDir = F.hostDir(persist, HOST), trayFile = path.join(tempDir, `aimb-start-refused-${WSPORT}.txt`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
const MIN = 60000, HOUR = 3600000, DAY = 86400000

// ---- the virtual clock: MID = a local midnight 30 days ahead (no collision with real files); D = the day before it
const now0 = new Date(), MID = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate() + 30, 0, 0, 0).getTime()
const D = A.localDay(MID - 1000), D1 = A.localDay(MID + 1000), Dm1 = A.localDay(MID - DAY - 1000), Dm2 = A.localDay(MID - 2 * DAY - 1000)
const at = (daysBack, h, m = 0) => new Date(new Date(MID).getFullYear(), new Date(MID).getMonth(), new Date(MID).getDate() - 1 - daysBack, h, m, 0).getTime()   // local time on D − daysBack
const ALPHA = { session: 'Alpha', project: 'AIMB', user: 'robin' }, BETA = { session: 'Beta', project: 'AIMB', user: 'robin' }

// ---- 1.7x history (D−2 … D) written as a 1.7x gateway writes its day files
function history() {
  const st = V.createActivity({ origin: HOST, config: { log_retention_days: 30 } })
  const days = new Map()
  const put = (rec, day = V.localDay(rec.ts)) => { let a = days.get(day); if (!a) days.set(day, a = []); a.push(JSON.parse(J(rec))) }
  const putW = ws => { for (const w of ws) { const rec = JSON.parse(J(w.rec)), day = V.localDay(Array.isArray(rec.rep) ? rec.last : rec.ts), a = days.get(day); if (w.rewrite && a && a.length && Array.isArray(a[a.length - 1].rep)) a[a.length - 1] = rec; else put(rec, day) } }
  let t = at(2, 9), lastDay = V.localDay(t)
  const tick = to => { while (t < to) { t = Math.min(to, t + MIN); V.expire(st, t); const d = V.localDay(t); if (d !== lastDay) { lastDay = d; putW(V.planCarryForward(st, t)) } } }
  const say = (ident, input, when) => { tick(when); const p = V.parseMessage(input, { now: t, tzOffsetMin: 0 }); if (!p.ok) throw new Error(J(p)); const r = V.apply(st, ident, p.msg, t); if (!r.ok) throw new Error(J(r)); for (const x of r.records) put(x) }
  const act = (ident, p, action, args, when) => { tick(when); const r = V.applyAction(st, { ...ident, path: p, action, args }, t, { by: { kind: 'dashboard', user: 'robin', host: HOST } }); if (!r.ok) throw new Error(J(r)); for (const x of r.records) put(x) }
  say(ALPHA, { path: '@"Next release"/@WIP/spec-88/@~root', text: 'writing the spec', state: 'running' }, at(2, 9))
  say(ALPHA, { path: '@"Next release"/@WIP/spec-88', plan: ['Read', 'Design', 'Build'] }, at(2, 9, 5))
  say(ALPHA, { path: '@"Next release"/@WIP/spec-88/@~Read', state: 'done', text: 'read it' }, at(2, 10))
  say(BETA, { path: 'helper/@~root', text: 'helping', state: 'running' }, at(2, 11))
  say(BETA, { path: 'helper/@~root', text: 'helped', state: 'done' }, at(1, 9))
  act(BETA, 'helper', 'dismiss', {}, at(1, 10))
  say(ALPHA, { path: '@"Next release"/@WIP/spec-88/@~Build', state: 'running', text: 'building' }, at(0, 9))
  say(ALPHA, { path: '@"Next release"/@WIP/spec-88/@~root', text: 'the last 1.7x record' }, at(0, 12))
  putW(V.flushCheckpoints(st, t, { withRep: true }))
  return [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1))
}
const HIST = history()
fs.mkdirSync(hostDir, { recursive: true })
for (const [day, recs] of HIST) fs.writeFileSync(path.join(hostDir, `${day}.jsonl`), recs.map(r => J(r) + '\n').join(''))
check('harness: three days of 1.7x (v5) history (D−2 … D) in the host\'s directory', J(HIST.map(h => h[0])) === J([Dm2, Dm1, D]) && HIST.every(([, rs]) => rs.every(r => r.v === 5)), J(HIST.map(h => [h[0], h[1].length])))

const snap = dir => { const out = {}; const walk = (d, rel) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), r = rel ? `${rel}/${n}` : n; if (fs.statSync(p).isDirectory()) walk(p, r); else out[r] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } }; if (fs.existsSync(dir)) walk(dir, ''); return out }
function bridgeEnv(name, o = {}) {
  const e = { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: WSPORT, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_ADVERTISE_HOST: '127.0.0.1',
    AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persist, AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_TEST_HOSTNAME: HOST, AI_BRIDGE_TEST_ACTIVITY_TAP: '1',
    AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: String(o.offset || 0), AI_BRIDGE_ACTIVITY_ROLLOVER_CHECK_MS: '300', TEMP: tempDir, TMP: tempDir, ...(o.v2 === false ? {} : { AI_BRIDGE_ACTIVITY_V2: '1' }), ...(o.env || {}) }
  for (const k of ['AI_BRIDGE_TRAY', ...(o.v2 === false ? ['AI_BRIDGE_ACTIVITY_V2'] : [])]) delete e[k]
  return e
}
/** A bare gateway process (no MCP client): → { code, err } once it exits, or { code: null } after `ms`. */
function runGateway(name, o = {}, ms = 15000) {
  return new Promise(resolve => {
    const c = spawnChild(process.execPath, [path.join(SRCDIR, 'bridge.mjs')], { cwd: SRCDIR, env: bridgeEnv(name, o), stdio: ['pipe', 'pipe', 'pipe'] })
    let err = ''
    c.stderr.on('data', d => { err += d })
    c.stdout.on('data', () => { })
    const timer = setTimeout(() => { try { c.kill() } catch { } resolve({ code: null, err }) }, ms)
    c.on('exit', code => { clearTimeout(timer); resolve({ code, err }) })
  })
}
function spawnMcp(name, o = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [path.join(SRCDIR, 'bridge.mjs')], cwd: SRCDIR, env: bridgeEnv(name, o), stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport, name }))
}
const call = async (b, n, a = {}) => { try { return JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(150) } while (Date.now() - t0 < ms); return r }
const fileRecs = day => { try { return fs.readFileSync(path.join(hostDir, `${day}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
const all = []
async function stop(b) { try { await b.transport.close() } catch { } all.splice(all.indexOf(b), 1); await sleep(700) }

try {
  // ---- (0) the start check (§7.5)
  const before0 = snap(persist)
  const r0 = await runGateway('V2Refuse')
  const msg0 = 'activity history in persistence/activity/v2host-a is format v5 (pre-2.0). Stop every bridge, then run: node src/tools/aimb-migrate-v2.mjs'
  check('start check: on unconverted (v5) history the 2.0 gateway REFUSES TO START — exit 78, the command in its stderr line', r0.code === 78 && r0.err.includes(`REFUSED TO START (exit 78): ${msg0}`), J([r0.code, r0.err.slice(-400)]))
  let tray = ''; try { tray = fs.readFileSync(trayFile, 'utf8') } catch { }
  check('start check: the same message in the tray\'s file (TEMP/aimb-start-refused-<ws port>.txt); not one byte of the history changed', tray.trim().startsWith(msg0) && J(snap(persist)) === J(before0), J([tray]))
  const bk = G.backupDir(persist, HOST)
  fs.mkdirSync(bk, { recursive: true }); fs.writeFileSync(path.join(bk, `${Dm2}.jsonl`), 'x\n')
  const r1 = await runGateway('V2Refuse2')
  check('start check: a leftover migration backup → exit 78 "did not finish — run node src/tools/aimb-migrate-v2.mjs again"', r1.code === 78 && r1.err.includes('the migration of persistence/activity/v2host-a did not finish — run node src/tools/aimb-migrate-v2.mjs again'), J([r1.code, r1.err.slice(-300)]))
  fs.rmSync(path.join(persist, G.BACKUP_ROOT), { recursive: true, force: true })
  // step 9 removed the pre-cutover switch: WITHOUT AI_BRIDGE_ACTIVITY_V2 the gateway is 2.0 all the same — it refuses too
  const before1 = snap(persist)
  const r2 = await runGateway('NoSwitch', { v2: false })
  check('step 9: the switch is gone — a gateway started WITHOUT AI_BRIDGE_ACTIVITY_V2 refuses the same v5 history (exit 78), no byte changed', r2.code === 78 && r2.err.includes(`REFUSED TO START (exit 78): ${msg0}`) && J(snap(persist)) === J(before1), J([r2.code, r2.err.slice(-300)]))
  // convert the host's history (as src/tools/aimb-migrate-v2.mjs does)
  const rep = await G.migrate({ dir: persist, host: HOST, config: A.resolveConfig({ log_retention_days: 30 }, {}), probe: async () => ({ up: false }), now: () => MID - 30000 })
  check('harness: the migration library converted the host\'s history (v6 days + index files + the marker, no backup left)', rep.code === 0 && fs.existsSync(path.join(hostDir, 'format.json')) && [Dm2, Dm1, D].every(d => fs.existsSync(path.join(hostDir, `${d}.idx.json`))) && !fs.existsSync(bk), J([rep.code, rep.status, rep.message]))

  // ---- (1) a 2.0 gateway STARTS on the converted history and WRITES v6 records
  fs.writeFileSync(trayFile, 'an old refusal\n')
  const V0 = MID - 20000
  const G1 = await spawnMcp('V2Gw1', { offset: V0 - Date.now() }); all.push(G1)
  const h1 = await call(G1, 'activity')
  const alpha = (h1.sessions || []).find(s => s.session === 'Alpha'), nodeAt = (s, p) => (s && s.nodes || []).find(n => n.path === p)
  check('2.0 start: the gateway serves the CONVERTED board — format 6, nodes by id with 2.0 paths (no "@"), the plan and its states', h1.ok && h1.format === 6 && nodeAt(alpha, 'Next release/WIP/spec-88')?.kind === 'agent' && nodeAt(alpha, 'Next release/WIP/spec-88/Read')?.state === 'done'
    && nodeAt(alpha, 'Next release/WIP/spec-88/Build')?.state === 'running' && /^[a-z2-7]{16}$/.test(nodeAt(alpha, 'Next release/WIP/spec-88')?.id || ''), J((alpha?.nodes || []).map(n => [n.path, n.state])))
  check('2.0 start: the tray\'s refusal file of an earlier refusal is removed once the gateway starts', !fs.existsSync(trayFile))
  const reg = await call(G1, 'register_self', { name: 'Lead', secret: 'ld', project: 'AIMB' })
  const lg = (input) => call(G1, 'log', { as: 'Lead', secret: 'ld', ...input })
  const w9 = await lg({ agent: 'w9', label: 'Worker 9', text: '@starting', state: 'running' })
  const notes = await lg({ agent: 'w9', key: 'notes', label: 'Notes', text: '@a first note' })
  const job1 = await lg({ agent: 'w9', key: 'job', label: 'Job', text: '@queued', move_to: '/Pending' })
  const job2 = await lg({ agent: 'w9', key: 'job', text: '@finished', state: 'done', move_to: '/Done' })
  check('2.0 log: the 2.0 tool forms apply (an agent, a context under it, a --move-to into a transient bucket and out of it)', reg.peer_id && w9.ok && notes.ok && job1.ok && job2.ok && w9.node?.id && notes.node?.path === 'Worker 9/Notes', J([reg.code, w9, notes.code, job1.code, job2.code]))
  const today = fileRecs(D), mine = today.filter(r => r.session === 'Lead')
  check('2.0 files: today\'s day file holds v6 records only for the new work — node records (create, move, remove) and entries by id (n, at)', mine.length > 0 && mine.every(r => r.v === 6) && mine.some(r => r.kind === 'node' && r.op === 'create' && r.n === w9.node.id)
    && mine.some(r => r.kind === 'node' && r.op === 'remove' && r.why === 'transient') && mine.some(r => r.id === notes.id && r.n === notes.node.id && r.at === 'Worker 9/Notes'), J(mine.map(r => [r.kind || 'entry', r.op, r.at])))
  const ixOpen = F.readIndex(persist, HOST, D)
  check('2.0 files: the OPEN day\'s index lives in memory — the file the migration wrote for it is left stale (its size ≠ the day file\'s) until the rollover rewrites it', !!ixOpen && ixOpen.size < fs.statSync(path.join(hostDir, `${D}.jsonl`)).size && !ixOpen.nodes[w9.node.id], J(ixOpen && ixOpen.size))
  const lc1 = (await call(G1, 'activity', { log: { session: 'Lead', limit: 50 } })).log || {}
  const lr1 = (await call(G1, 'activity', { log: { session: 'Lead', limit: 50, removed: true } })).log || {}
  check('2.0 ghosts: the vanished transient bucket\'s entries are in the session\'s log ONLY with removed:true, marked removed', (lc1.entries || []).length > 0 && !(lc1.entries || []).some(e => e.path === 'Pending')
    && (lr1.entries || []).some(e => e.path === 'Pending' && e.removed === true) && lr1.ghost_members >= 1, J([(lc1.entries || []).map(e => e.path), (lr1.entries || []).map(e => [e.path, e.removed])]))
  // paging through the index: a node whose entries are only in today's file reads one span, never a whole day
  const tapOf = async b => (await call(b, 'activity', { tap: true, session: '-none-' })).tap || {}
  const s0 = (await tapOf(G1)).files
  const pg = (await call(G1, 'activity', { log: { session: 'Lead', id: notes.node.id } })).log || {}
  const s1 = (await tapOf(G1)).files
  const todayBytes = fs.statSync(path.join(hostDir, `${D}.jsonl`)).size
  check('2.0 paging: a page reads only the INDEXED range of the one day that holds the node (one span read, fewer bytes than the day file, no whole-day read)', pg.entries?.length === 1 && s1.span_reads - s0.span_reads === 1 && s1.span_bytes - s0.span_bytes < todayBytes && s1.day_reads === s0.day_reads, J([pg.entries?.length, s0, s1, todayBytes]))
  const pa0 = (await tapOf(G1)).files
  const pa = (await call(G1, 'activity', { log: { session: 'Alpha', path: 'Next release/WIP/spec-88' } })).log || {}
  const pa1 = (await tapOf(G1)).files
  const daysWith = [Dm2, Dm1].filter(d => { const ix = F.readIndex(persist, HOST, d); return ix && Object.keys(ix.nodes).length }).length
  check('2.0 paging: the converted agent\'s merged log comes from the converted days through their index files (spans only, ≤ one per day)', (pa.entries || []).some(e => e.text === 'read it') && (pa.entries || []).some(e => e.text === 'the last 1.7x record') && pa1.span_reads - pa0.span_reads <= daysWith + 1 && pa1.day_reads === pa0.day_reads, J([(pa.entries || []).map(e => e.text), pa0, pa1]))

  // ---- (3) the day ROLLOVER (the clock crosses midnight): the closed day's index file, the new day's cf
  fs.writeFileSync(path.join(hostDir, `${Dm1} (LITTLE-001's conflicted copy ${D}).jsonl`), '{"v":6}\n')
  const t3 = await until(() => tapOf(G1), t => t.carry_forward && t.carry_forward.day === D1, 30000)
  await sleep(500)
  const ixD = F.readIndex(persist, HOST, D), rebuilt = F.buildIndex(D, fs.readFileSync(path.join(hostDir, `${D}.jsonl`)))
  check('rollover: the closed day\'s index file is written and EQUALS a rebuild of its day file (size, nodes, struct, sessions)', !!ixD && J(ixD) === J(rebuilt) && ixD.nodes[notes.node.id]?.[2] >= 1, J([t3.carry_forward, ixD && ixD.size, rebuilt.size]))
  const cf1 = fileRecs(D1).filter(r => r.kind === 'cf')
  check('rollover: the new day\'s file opens with the whole board as v6 cf lines (structure carried: Worker 9, Notes, spec-88)', cf1.length > 0 && cf1.every(r => r.v === 6) && cf1.some(r => r.n === w9.node.id && r.label === 'Worker 9') && cf1.some(r => r.n === notes.node.id && r.p === w9.node.id), J(cf1.map(r => r.label)))
  const h3 = await call(G1, 'activity', { session: '-none-' })
  check('Dropbox rule: the planted conflicted copy is in the board head\'s fs_warnings (checked at the rollover) and left alone', (h3.fs_warnings || []).some(w => w.includes('conflicted copy') && w.includes(`${Dm1} (LITTLE-001's conflicted copy`)) && fs.existsSync(path.join(hostDir, `${Dm1} (LITTLE-001's conflicted copy ${D}).jsonl`)), J(h3.fs_warnings))
  await stop(G1)

  // ---- (4) a RESTART days later: the ghost table rebuilt from the index files
  const V2 = MID + 6 * DAY + 12 * HOUR   // the 7-day replay window starts at D 12:00 — after Beta's helper was dismissed (D−1)
  const G2 = await spawnMcp('V2Gw2', { offset: V2 - Date.now() }); all.push(G2)
  const tp2 = await tapOf(G2)
  const bl = (await call(G2, 'activity', { log: { session: 'Beta', limit: 50 } })).log || {}
  const br = (await call(G2, 'activity', { log: { session: 'Beta', limit: 50, removed: true } })).log || {}
  check('restart: the ghost table is REBUILT from the index files (the dismissal lies outside the replay window)', tp2.open && tp2.open.ghosts_rebuilt >= 1, J(tp2.open))
  check('restart: Beta\'s log shows the dismissed helper\'s entries ONLY with removed:true ("helping", "helped", marked removed); the dismissal entry on the session always', !(bl.entries || []).some(e => e.removed) && (bl.entries || []).some(e => e.dismiss)
    && ['helping', 'helped'].every(t => (br.entries || []).some(e => e.text === t && e.removed === true && e.path === 'helper')), J([(bl.entries || []).map(e => [e.text, e.dismiss]), (br.entries || []).map(e => [e.text, e.path, e.removed])]))
  const b2 = await call(G2, 'activity')
  const lead2 = (b2.sessions || []).find(s => s.session === 'Lead'), alpha2 = (b2.sessions || []).find(s => s.session === 'Alpha')
  check('restart: the board comes back from the rollover\'s cf (Worker 9 / Notes, the converted spec-88 plan)', !!nodeAt(lead2, 'Worker 9/Notes') && nodeAt(alpha2, 'Next release/WIP/spec-88/Read')?.state === 'done', J((b2.sessions || []).map(s => [s.session, s.nodes.map(n => n.path)])))
  await stop(G2)

  // ---- (5) a RESTART with a shorter retention: old days go with their index files; the ghost whose last entry went leaves
  const G3 = await spawnMcp('V2Gw3', { offset: V2 - Date.now(), env: { AI_BRIDGE_ACTIVITY_LOG_RETENTION_DAYS: '6' } }); all.push(G3)
  const names3 = fs.readdirSync(hostDir)
  check('retention: the days before D+1 are deleted WITH their index files; the conflicted copy is never pruned', ![Dm2, Dm1, D].some(d => names3.includes(`${d}.jsonl`) || names3.includes(`${d}.idx.json`)) && names3.includes(`${D1}.jsonl`) && names3.some(n => n.includes('conflicted copy')), J(names3))
  const br3 = (await call(G3, 'activity', { log: { session: 'Beta', limit: 50, removed: true } })).log || {}
  check('retention: the helper\'s ghost left with its last day — removed:true shows none of its entries any more', br3.ok !== false && !(br3.entries || []).some(e => e.path === 'helper') && (br3.ghost_members || 0) === 0, J([br3.code, br3.ghost_members, (br3.entries || []).map(e => e.text)]))
  await stop(G3)
} catch (e) { fail++; console.log('FAIL crashed:', (e && e.stack) || e) }

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(400)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
