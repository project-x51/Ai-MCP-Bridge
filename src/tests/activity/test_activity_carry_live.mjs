// #70 step 6b (v1.63.0) — CARRY-FORWARD across a day rollover and a restart whose files reach back further than the
// replay window. One gateway (127.0.0.1:14600, ws 14601), a temp persist dir + a temp AI_BRIDGE_CONFIG (never
// src/config.json; log_retention_days 30 so the old files stay; finished_visible_hours left at its 7-day DEFAULT). The
// test-only clock hook AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS shifts the activity board's clock, so the gateway starts a
// few seconds before a LOCAL midnight (D 23:59:50) and the rollover check (AI_BRIDGE_ACTIVITY_ROLLOVER_CHECK_MS = 300)
// fires for real.
// Seeded day files (written with lib/activity.js exactly as a gateway writes them): a session-level plan @#70 created on
// D−12 (one item done, one in progress, one skipped, two ☐), a finished agent, one carry-forward per local midnight since,
// and a note on D−1 — 13 days of files, far more than the 7-day replay window.
// Covers: (1) the startup replay rebuilds the weeks-old plan from the window alone (states, plan order, created_at; the
// expired agent stays gone; the creation files are never read) and writes no second carry-forward for a day that has one;
// (2) the day ROLLOVER writes a cf of every open plan item + its ancestors into the NEW day's file; (3) older history still
// pages from the older files; (4) a RESTART a week later (clock D+7 12:00: every seeded file is outside the window) rebuilds
// the plan from the rollover's cf alone and writes that day's cf at once (startup); a tick after it works.
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lslug } from '../../facets/persistence/file.js'
import * as Act from '../../lib/activity.js'
const tp = testPorts(import.meta.url, 14600)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const TOKEN = 'carrytesttok', PORT = String(tp(14600))
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-carry-'))
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-carrycfg-'))
const cfgFile = path.join(cfgDir, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_retention_days: 30 } }))
const HOST = os.hostname(), hostDir = path.join(persist, 'activity', lslug(HOST, 80))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
const MIN = 60000, HOUR = 3600000

function spawn(name, offsetMs) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: String(Number(PORT) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_ADVERTISE_HOST: '127.0.0.1', AI_BRIDGE_USER: 'robin',
      AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persist, AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_TEST_ACTIVITY_TAP: '1',
      AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: String(offsetMs), AI_BRIDGE_ACTIVITY_ROLLOVER_CHECK_MS: '300' }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport, name }))
}
const call = async (b, n, a = {}) => { try { return JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(150) } while (Date.now() - t0 < ms); return r }
const board = async h => (await call(h, 'activity')).sessions || []
const lead = b => b.find(s => s.session === 'Lead')
const nodeOf = (b, p) => (lead(b)?.nodes || []).find(x => x.path === p)
const tap = async h => (await call(h, 'activity', { tap: true, session: '-none-' })).tap || {}
const fileRecs = day => { try { return fs.readFileSync(path.join(hostDir, `${day}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
const ITEMS = ['Spec', 'Build', 'Test', 'Ship', 'Docs']
const itemsOf = b => ITEMS.map(n => { const x = nodeOf(b, `@#70/@${n}`); return x ? [n, x.state, !!x.plan_item, x.plan_ix] : [n, null] })
const WANT = J([['Spec', 'done', true, 0], ['Build', 'running', true, 1], ['Test', 'skipped', true, 2], ['Ship', 'todo', true, 3], ['Docs', 'todo', true, 4]])

// ---- the shifted clock: D = the local day the gateway starts in, 10 s before its midnight
const now0 = new Date(), nextMid = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate() + 30, 0, 0, 0)   // 30 days ahead: no collision with real files
const V0 = nextMid.getTime() - 10000, D = Act.localDay(V0), D1 = Act.localDay(nextMid.getTime() + 5000)
const at = (daysBack, h, m = 0) => new Date(nextMid.getFullYear(), nextMid.getMonth(), nextMid.getDate() - 1 - daysBack, h, m, 0).getTime()   // local time on D − daysBack
// ---- seed the day files with the LIBRARY, exactly as a gateway would have written them
const sim = Act.createActivity({ origin: HOST, config: { log_retention_days: 30 } }), I = { session: 'Lead', project: 'AIMB', user: 'robin', realm: 'default' }
const files = new Map(), put = rec => { const d = Act.localDay(rec.ts); if (!files.has(d)) files.set(d, []); files.get(d).push(J(rec)) }
const say = (input, t) => { const p = Act.parseMessage(input, { now: t }); if (!p.ok) throw new Error(`seed ${J(input)}: ${p.code}`); const r = Act.apply(sim, I, p.msg, t); if (!r.ok) throw new Error(`seed ${J(input)}: ${r.code}`); for (const x of r.records) put(x) }
say({ path: '@~#70', text: 'the #70 plan' }, at(12, 10))
say({ path: '@#70', plan: ITEMS }, at(12, 10, 1))
say({ path: '@#70/@~Spec', state: 'done' }, at(12, 11))
say({ path: '@#70/@~Build', text: 'compiling', progress: '3/10 files' }, at(12, 12))
say({ path: '@#70/@~Test', state: 'skipped' }, at(12, 13))
say({ path: 'oldtimer/@~root', text: 'finished long ago', state: 'done' }, at(12, 14))
for (let back = 11; back >= 0; back--) {   // every local midnight since: the sweep, then the carry-forward
  const mid = new Date(nextMid.getFullYear(), nextMid.getMonth(), nextMid.getDate() - 1 - back, 0, 0, 5).getTime()
  Act.expire(sim, mid)
  for (const w of Act.planCarryForward(sim, mid)) put(w.rec)
  if (back === 1) say({ path: '@#70/@Build', text: 'a note from yesterday' }, at(1, 15))
}
fs.mkdirSync(hostDir, { recursive: true })
for (const [d, lines] of files) fs.writeFileSync(path.join(hostDir, `${d}.jsonl`), lines.join('\n') + '\n')
const seededDays = [...files.keys()].sort(), totalSeeded = [...files.values()].reduce((s, x) => s + x.length, 0)
check('harness: 13 days of seeded files (D−12 … D) — far beyond the 7-day replay window', seededDays.length === 13 && seededDays[0] === Act.localDay(at(12, 10)) && seededDays.at(-1) === D, J(seededDays))

const all = []
const G = await spawn('CarryGw', V0 - Date.now()); all.push(G)
const id = await call(G, 'my_identity')
check('harness: a gateway on ≥ 1.63.0', id.role === 'gateway' && (v => v[0] > 1 || (v[0] === 1 && v[1] >= 63))(String(id.bridge_version).split('.').map(Number)), J([id.role, id.bridge_version]))

// ---- 1. the startup replay rebuilds the weeks-old plan from the window alone
const b1 = await until(() => board(G), b => !!nodeOf(b, '@#70/@Docs'), 8000)
check('startup: the plan created 12 days ago is back — every item a plan item with its state, in the given order', J(itemsOf(b1)) === WANT, J(itemsOf(b1)))
check('startup: its lines, bar and created_at as written; the plan bar "1 of 5 done · 1 skipped" (#79); the finished agent stays gone', nodeOf(b1, '@#70/@Build')?.current?.text === 'compiling' && nodeOf(b1, '@#70/@Build')?.progress?.done === 3
  && nodeOf(b1, '@#70/@Ship')?.created_at === at(12, 10, 1) && nodeOf(b1, '@#70')?.current?.text === 'the #70 plan' && (p => p && p.todos && p.done === 1 && p.total === 5 && p.skipped === 1)(nodeOf(b1, '@#70')?.progress) && !nodeOf(b1, 'oldtimer'), J(nodeOf(b1, '@#70')))
const t1 = await tap(G)
check('startup: the replay read only the window — fewer records than were seeded, carry-forwards among them, and today\'s cf seen (no second one written)', t1.replay && t1.replay.fed < totalSeeded && t1.replay.cfs > 0 && t1.replay.cf_today === true && t1.cf_day === D && !t1.carry_forward, J([t1.replay, t1.cf_day, t1.carry_forward, totalSeeded]))

// ---- 2. the day ROLLOVER (the shifted clock crosses midnight) → a cf of every open item + its ancestors in the NEW day's file
const t2 = await until(() => tap(G), t => t.carry_forward && t.carry_forward.day === D1, 20000)
const cf = fileRecs(D1).filter(r => r.kind === 'cf')
check('rollover: the gateway noticed the new local day and carried the long-lived nodes forward (why: day rollover)', t2.carry_forward?.day === D1 && t2.carry_forward?.why === 'day rollover' && t2.carry_forward?.written === cf.length && t2.cf_day === D1, J(t2.carry_forward))
check('rollover: the new day\'s file holds a cf of every OPEN item and its ancestors (parents first), each a v4 snapshot (6c: every item of the OPEN plan, done / skipped ones too)', ['', '@#70', '@#70/@Build', '@#70/@Ship', '@#70/@Docs'].every(p => cf.some(r => r.path === p)) && cf.findIndex(r => r.path === '@#70') < cf.findIndex(r => r.path === '@#70/@Ship')
  && cf.every(r => r.v === Act.ACTIVITY_FORMAT && r.session === 'Lead') && cf.find(r => r.path === '@#70/@Ship')?.plan_item === true && cf.find(r => r.path === '@#70/@Build')?.current?.text === 'compiling', J(cf.map(r => r.path)))

// ---- 3. older history stays in the older files and pages as before
let page = await call(G, 'activity', { log: { session: 'Lead', path: '@#70', limit: 50 } }), got = [...(page.log?.entries || [])], n = 0
while (page.log?.next_cursor && n++ < 12 && !got.some(e => e.text === 'Ship' && e.state === 'todo')) { page = await call(G, 'activity', { log: { session: 'Lead', path: '@#70', limit: 50, cursor: page.log.next_cursor } }); got.push(...(page.log?.entries || [])) }
check('history: the plan\'s log pages on into the 12-day-old file — the ☐ creation entries of its items are there (carry-forwards never show)', got.some(e => e.text === 'a note from yesterday') && ITEMS.every(nm => got.some(e => e.path === `@#70/@${nm}` && e.state === 'todo' && e.current))
  && !got.some(e => e.kind === 'cf'), J(got.map(e => [e.path, e.text, e.state])))

// ---- 4. a RESTART a week later: every seeded file is outside the window — the rollover's cf rebuilds the plan alone
await G.transport.close(); all.splice(all.indexOf(G), 1)
await sleep(600)
const V2 = new Date(nextMid.getFullYear(), nextMid.getMonth(), nextMid.getDate() + 6, 12, 0, 0).getTime(), D7 = Act.localDay(V2)   // D+7 12:00: the window starts D 12:00 — after every seeded record
const G2 = await spawn('CarryGw2', V2 - Date.now()); all.push(G2)
const b2 = await until(() => board(G2), b => !!nodeOf(b, '@#70/@Docs'), 8000)
check('restart a week later: the plan is rebuilt from the window alone (only the rollover\'s cf is in it) — states, order, lines', J(itemsOf(b2)) === WANT && nodeOf(b2, '@#70/@Build')?.current?.text === 'compiling' && nodeOf(b2, '@#70')?.current?.text === 'the #70 plan', J(itemsOf(b2)))
const t3 = await until(() => tap(G2), t => t.carry_forward && t.carry_forward.day === D7, 6000)
check('restart: the replay used ONLY the rollover\'s records (every seeded file is outside the window); today\'s file had no carry-forward → one is written at once (why: startup)', t3.replay?.fed === fileRecs(D1).length && t3.replay?.entries === 0 && t3.replay?.cf_today === false && t3.carry_forward?.why === 'startup' && fileRecs(D7).some(r => r.kind === 'cf' && r.path === '@#70/@Ship'), J([t3.replay, t3.carry_forward]))
await call(G2, 'register_self', { name: 'Lead', secret: 'ld', project: 'AIMB' })
const tick = await call(G2, 'log', { as: 'Lead', secret: 'ld', path: '@#70/@~Ship', state: 'done' })
const b3 = await until(() => board(G2), b => nodeOf(b, '@#70/@Ship')?.state === 'done', 4000)
check('restart: the restored plan takes ticks as before (Ship ☑, the bar 2 of 5 · 1 skipped, #79)', tick.ok && nodeOf(b3, '@#70/@Ship')?.state === 'done' && (p => p && p.done === 2 && p.total === 5)(nodeOf(b3, '@#70')?.progress), J([tick, nodeOf(b3, '@#70')?.progress]))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(400)
for (const d of [persist, cfgDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
process.exit(fail ? 1 : 0)
