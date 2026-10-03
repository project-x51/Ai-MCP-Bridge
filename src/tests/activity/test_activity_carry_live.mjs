// #70 step 6b (v1.63.0) → #88 (v2.0) build step 9 — CARRY-FORWARD across a day rollover and a restart whose files reach
// back further than the replay window, on the 2.0 board. One gateway (its port block, ws +1), a temp persist dir + a temp
// AI_BRIDGE_CONFIG (never src/config.json; log_retention_days 30 so the old files stay; finished_visible_hours left at its
// 7-day DEFAULT), host name CARRY-HOST (AI_BRIDGE_TEST_HOSTNAME). The test-only clock hook
// AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS shifts the activity board's clock, so the gateway starts a few seconds before a
// LOCAL midnight (D 23:59:50) and the rollover check (AI_BRIDGE_ACTIVITY_ROLLOVER_CHECK_MS = 300) fires for real.
// History: 13 days of 1.7x day files written by the FROZEN 1.7x library (tests/fixtures/activity-v175.js) exactly as a
// 1.7x gateway wrote them — a session-level plan "#70" created on D−12 (one item done, one in progress, one skipped, two
// ☐), a finished agent, one carry-forward per local midnight since, a note on D−1 — then CONVERTED to v6 by the migration
// library (lib/activity2-migrate.js, as src/tools/aimb-migrate-v2.mjs runs it; a 2.0 gateway refuses v5 history).
// Covers (docs/spec-88.md §2.3, §5.2, §7): (1) the startup replay rebuilds the weeks-old plan from the window alone (the
// converted cf lines: states, plan order, created_at, lines, the plan bar; the expired agent stays gone) and writes no
// second carry-forward for a day that has one; (2) the day ROLLOVER writes the whole board as v6 cf lines (parents first)
// into the NEW day's file; (3) older history still pages from the older (converted) files; (4) a RESTART a week later
// (clock D+7 12:00: every seeded file is outside the window) rebuilds the plan from the rollover's cf alone and writes that
// day's cf at once (why: startup); a tick after it works.
// Step 9 retired (1.7x-only): the v4/v5 cf snapshot shape and "only OPEN items + ancestors are carried" (2.0 carries EVERY
// node, §2.3 as built) and the `@`-paths.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as V from '../fixtures/activity-v175.js'
import * as A from '../../lib/activity.js'
import * as F from '../../lib/activity2-files.js'
import * as G from '../../lib/activity2-migrate.js'
const tp = testPorts(import.meta.url, 14600)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const TOKEN = 'carrytesttok', PORT = String(tp(14600)), HOST = 'CARRY-HOST'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-carry-'))
const persist = path.join(TMP, 'persist'), cfgFile = path.join(TMP, 'config.json')
fs.mkdirSync(persist, { recursive: true })
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_retention_days: 30 } }))
const hostDir = F.hostDir(persist, HOST)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify

function spawn(name, offsetMs) {
  const env = { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: String(Number(PORT) + 1),
    AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_ADVERTISE_HOST: '127.0.0.1', AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: HOST,
    AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persist, AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_TEST_ACTIVITY_TAP: '1',
    AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: String(offsetMs), AI_BRIDGE_ACTIVITY_ROLLOVER_CHECK_MS: '300', TEMP: TMP, TMP }
  delete env.AI_BRIDGE_TRAY
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR, env, stderr: 'pipe' })
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
// the plan's items in BOARD order (the rows are depth first in sibling order): [label, state, plan_item]
const itemsOf = b => { const plan = nodeOf(b, '#70'); return (lead(b)?.nodes || []).filter(x => plan && x.parent === plan.id).map(x => [x.label, x.state, !!x.plan_item]) }
const WANT = J([['Spec', 'done', true], ['Build', 'running', true], ['Test', 'skipped', true], ['Ship', 'todo', true], ['Docs', 'todo', true]])

// ---- the shifted clock: D = the local day the gateway starts in, 10 s before its midnight
const now0 = new Date(), nextMid = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate() + 30, 0, 0, 0)   // 30 days ahead: no collision with real files
const V0 = nextMid.getTime() - 10000, D = A.localDay(V0), D1 = A.localDay(nextMid.getTime() + 5000)
const at = (daysBack, h, m = 0) => new Date(nextMid.getFullYear(), nextMid.getMonth(), nextMid.getDate() - 1 - daysBack, h, m, 0).getTime()   // local time on D − daysBack
// ---- seed the day files with the frozen 1.7x LIBRARY, exactly as a 1.7x gateway would have written them
const sim = V.createActivity({ origin: HOST, config: { log_retention_days: 30 } }), I = { session: 'Lead', project: 'AIMB', user: 'robin', realm: 'default' }
const files = new Map(), put = rec => { const d = V.localDay(rec.ts); if (!files.has(d)) files.set(d, []); files.get(d).push(J(rec)) }
const say = (input, t) => { const p = V.parseMessage(input, { now: t }); if (!p.ok) throw new Error(`seed ${J(input)}: ${p.code}`); const r = V.apply(sim, I, p.msg, t); if (!r.ok) throw new Error(`seed ${J(input)}: ${r.code}`); for (const x of r.records) put(x) }
say({ path: '@~#70', text: 'the #70 plan' }, at(12, 10))
say({ path: '@#70', plan: ITEMS }, at(12, 10, 1))
say({ path: '@#70/@~Spec', state: 'done' }, at(12, 11))
say({ path: '@#70/@~Build', text: 'compiling', progress: '3/10 files' }, at(12, 12))
say({ path: '@#70/@~Test', state: 'skipped' }, at(12, 13))
say({ path: 'oldtimer/@~root', text: 'finished long ago', state: 'done' }, at(12, 14))
for (let back = 11; back >= 0; back--) {   // every local midnight since: the sweep, then the carry-forward
  const mid = new Date(nextMid.getFullYear(), nextMid.getMonth(), nextMid.getDate() - 1 - back, 0, 0, 5).getTime()
  V.expire(sim, mid)
  for (const w of V.planCarryForward(sim, mid)) put(w.rec)
  if (back === 1) say({ path: '@#70/@Build', text: 'a note from yesterday' }, at(1, 15))
}
fs.mkdirSync(hostDir, { recursive: true })
for (const [d, lines] of files) fs.writeFileSync(path.join(hostDir, `${d}.jsonl`), lines.join('\n') + '\n')
const seededDays = [...files.keys()].sort()
check('harness: 13 days of seeded 1.7x files (D−12 … D) — far beyond the 7-day replay window', seededDays.length === 13 && seededDays[0] === A.localDay(at(12, 10)) && seededDays.at(-1) === D, J(seededDays))
// ---- convert them (a 2.0 gateway refuses v5 history: exit 78)
const mig = await G.migrate({ dir: persist, host: HOST, config: A.resolveConfig({ log_retention_days: 30 }, {}), probe: async () => ({ up: false }), now: () => V0 - 30000 })
const totalV6 = seededDays.reduce((s, d) => s + fileRecs(d).length, 0)
check('harness: the migration library converted the 13 days to v6 (the marker, an index file per day, every record v6)', mig.code === 0 && fs.existsSync(path.join(hostDir, 'format.json')) && seededDays.every(d => fs.existsSync(path.join(hostDir, `${d}.idx.json`)) && fileRecs(d).every(r => r.v === 6)),
  J([mig.code, mig.status, mig.message]))

const all = []
try {
  const Gw = await spawn('CarryGw', V0 - Date.now()); all.push(Gw)
  const id = await call(Gw, 'my_identity'), h0 = await call(Gw, 'activity', { session: '-none-' })
  check('harness: a gateway serving the 2.0 board (format 6) — it started on the converted history', id.role === 'gateway' && h0.ok && h0.format === 6, J([id.role, id.bridge_version, h0.code, h0.format]))

  // ---- 1. the startup replay rebuilds the weeks-old plan from the window alone
  const b1 = await until(() => board(Gw), b => !!nodeOf(b, '#70/Docs'), 8000)
  check('startup: the plan created 12 days ago is back — every item a plan item with its state, in the given order', J(itemsOf(b1)) === WANT, J([itemsOf(b1), (lead(b1)?.nodes || []).map(n => n.path)]))
  const createdShip = nodeOf(b1, '#70/Ship')?.created_at
  check('startup: its lines, bar and created_at as written; the plan bar "1 of 5 done · 1 skipped" (#79); the finished agent stays gone', nodeOf(b1, '#70/Build')?.current?.text === 'compiling' && nodeOf(b1, '#70/Build')?.progress?.done === 3
    && createdShip === at(12, 10, 1) && nodeOf(b1, '#70')?.current?.text === 'the #70 plan' && (bar => bar && bar.done === 1 && bar.total === 5 && bar.skipped === 1)(nodeOf(b1, '#70')?.display?.bar) && !nodeOf(b1, 'oldtimer'),
  J([nodeOf(b1, '#70'), nodeOf(b1, '#70/Build')?.current, createdShip, at(12, 10, 1)]))
  const t1 = await tap(Gw)
  check('startup: the replay read only the window — fewer records than the history holds, carry-forwards among them, and today\'s cf seen (no second one written)', t1.open && t1.open.fed > 0 && t1.open.fed < totalV6 && t1.open.cfs > 0 && t1.open.cf_today === true && t1.cf_day === D && !t1.carry_forward,
    J([t1.open, t1.cf_day, t1.carry_forward, totalV6]))

  // ---- 2. the day ROLLOVER (the shifted clock crosses midnight) → the whole board as v6 cf lines in the NEW day's file
  const t2 = await until(() => tap(Gw), t => t.carry_forward && t.carry_forward.day === D1, 20000)
  const cf = fileRecs(D1).filter(r => r.kind === 'cf')
  check('rollover: the gateway noticed the new local day and carried the board forward (why: day rollover)', t2.carry_forward?.day === D1 && t2.carry_forward?.why === 'day rollover' && t2.carry_forward?.written === cf.length && t2.cf_day === D1, J(t2.carry_forward))
  const L1 = lead(b1), idOf = p => nodeOf(b1, p)?.id
  const cfIx = p => cf.findIndex(r => r.n === idOf(p))
  check('rollover: the new day\'s file holds a v6 cf of EVERY node of the plan (the root, #70, all five items, done / skipped ones too), parents first', !!L1 && ['', '#70', ...ITEMS.map(n => `#70/${n}`)].every(p => cfIx(p) >= 0) && cfIx('') < cfIx('#70') && cfIx('#70') < cfIx('#70/Ship')
    && cf.every(r => r.v === 6 && r.session === 'Lead') && cf[cfIx('#70/Ship')]?.plan_item === true && cf[cfIx('#70/Ship')]?.p === idOf('#70') && cf[cfIx('#70/Build')]?.current?.text === 'compiling', J(cf.map(r => [r.label, r.n, r.p])))

  // ---- 3. older history stays in the older files and pages as before (the plan's merged log, through the index files)
  let page = await call(Gw, 'activity', { log: { session: 'Lead', id: idOf('#70'), limit: 50 } }), got = [...(page.log?.entries || [])], n = 0
  while (page.log?.next_cursor && n++ < 12) { page = await call(Gw, 'activity', { log: { session: 'Lead', id: idOf('#70'), limit: 50, cursor: page.log.next_cursor } }); got.push(...(page.log?.entries || [])) }
  const oldDay = A.localDay(at(12, 10))
  check('history: the plan\'s log pages on into the 12-day-old file — its creation entries and the item ticks are there, yesterday\'s note too (carry-forwards never show)', page.ok !== false && got.some(e => e.text === 'a note from yesterday')
    && got.some(e => e.text === 'the #70 plan' && A.localDay(e.ts) === oldDay) && got.some(e => e.node_id === idOf('#70/Spec') && e.state === 'done' && A.localDay(e.ts) === oldDay) && got.some(e => e.node_id === idOf('#70/Test') && e.state === 'skipped')
    && !got.some(e => e.kind === 'cf'), J([page.code, got.map(e => [e.path || e.at, e.text, e.state, A.localDay(e.ts)])]))

  // ---- 4. a RESTART a week later: every seeded file is outside the window — the rollover's cf rebuilds the plan alone
  await Gw.transport.close(); all.splice(all.indexOf(Gw), 1)
  await sleep(700)
  const V2 = new Date(nextMid.getFullYear(), nextMid.getMonth(), nextMid.getDate() + 6, 12, 0, 0).getTime(), D7 = A.localDay(V2)   // D+7 12:00: the window starts D 12:00 — after every seeded record
  const G2 = await spawn('CarryGw2', V2 - Date.now()); all.push(G2)
  const b2 = await until(() => board(G2), b => !!nodeOf(b, '#70/Docs'), 8000)
  check('restart a week later: the plan is rebuilt from the window alone (only the rollover\'s cf is in it) — states, order, lines, the same ids', J(itemsOf(b2)) === WANT && nodeOf(b2, '#70/Build')?.current?.text === 'compiling' && nodeOf(b2, '#70')?.current?.text === 'the #70 plan'
    && ITEMS.every(nm => nodeOf(b2, `#70/${nm}`)?.id === idOf(`#70/${nm}`)), J(itemsOf(b2)))
  const t3 = await until(() => tap(G2), t => t.carry_forward && t.carry_forward.day === D7, 6000)
  check('restart: the replay used ONLY the rollover day\'s records (every seeded file is outside the window, no entry in it); today\'s file had no carry-forward → one is written at once (why: startup)', t3.open?.fed === fileRecs(D1).length && t3.open?.entries === 0 && t3.open?.cf_today === false
    && t3.carry_forward?.why === 'startup' && fileRecs(D7).some(r => r.kind === 'cf' && r.n === idOf('#70/Ship')), J([t3.open, t3.carry_forward, fileRecs(D1).length]))
  await call(G2, 'register_self', { name: 'Lead', secret: 'ld', project: 'AIMB' })
  const tick = await call(G2, 'log', { as: 'Lead', secret: 'ld', path: '#70/Ship', state: 'done' })
  const b3 = await until(() => board(G2), b => nodeOf(b, '#70/Ship')?.state === 'done', 4000)
  check('restart: the restored plan takes ticks as before (Ship ☑, the bar 2 of 5 · 1 skipped, #79)', tick.ok && tick.node?.id === idOf('#70/Ship') && nodeOf(b3, '#70/Ship')?.state === 'done'
    && (bar => bar && bar.done === 2 && bar.total === 5 && bar.skipped === 1)(nodeOf(b3, '#70')?.display?.bar), J([tick, nodeOf(b3, '#70')?.display?.bar]))
} catch (e) { fail++; console.log('FAIL crashed:', (e && e.stack) || e) }

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(400)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
