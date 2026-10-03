// #88 (v2.0) build step 8 — PER-USER VIEW STATE, live (docs/spec-88.md §5.6, §8 step 8; Q13 / Q28 / Q29 / Q30 / Q70): four
// 2.0 gateways and one STAND-IN for a 1.7x gateway (since step 9 removed the switch: AI_BRIDGE_TEST_GOSSIP=v5 announces 5),
// each on its own loopback address, host name (AI_BRIDGE_TEST_HOSTNAME), temp persistence dir and this file's port block
// (never 12317 / 12318); a temp AI_BRIDGE_CONFIG (never src/config.json). Links (seeds): everything through A —
//   A  127.0.0.1  "VIEW8-A"  2.0, view user = this machine's login (AIMB_TEST_VIEW_USER = it): the board's owner
//   B  127.0.0.2  "VIEW8-B"  2.0, NO test hook and AI_BRIDGE_USER=builder → still this machine's login (Q29)
//   C  127.0.0.3  "VIEW8-C"  2.0, the same user; linked to A only ("a third via the first"); restarted alone at the end
//   D  127.0.0.4  "VIEW8-D"  2.0, user "alice" (AIMB_TEST_VIEW_USER); drops VIEW deltas (anti-entropy repairs it)
//   L  127.0.0.5  "VIEW8-L"  the 1.7x stand-in (AI_BRIDGE_TEST_GOSSIP=v5): Q70's unshared host
// Covers: whose view (Q29: the serving gateway's OS login, never AI_BRIDGE_USER; the welcome's view.user, the head's
// view_user); a pin on A pushed live to A's second window and to B and C (via A), never to alice's dashboard on D — her
// own choices stay hers (two users kept apart); refused records; the choices are keyed by NODE ID, so they survive a
// RENAME and a MOVE; a close made on B survives new activity on A (the page's "N new" baseline kept); a selection is
// pushed (the page applies it at its next load, Q30) and served at a new load; Reset view on C voids the user's records
// on every host (alice's untouched); a dismissed agent's and a merged context's records TOMBSTONED on all hosts; a pin on
// a TRANSIENT bucket made on B makes it permanent on its owner A (it stays when emptied); anti-entropy (view_v) repairs
// the dropped deltas; views/<host>.json written per host; a host RESTARTED with its peers down keeps the set (and merges
// another host's file of a shared folder, read only), a Dropbox conflicted copy in views/ warned and never read; Q70: the
// 1.7x host in unshared_hosts on A (its link) and B (through A's slice), gone from both once its link drops.
import { testOnly } from '../helpers/check.mjs'
import { portBase } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BASE = portBase(import.meta.url)
const KEYS = ['A', 'B', 'C', 'D', 'L']
const P = Object.fromEntries(KEYS.map((k, i) => [k, String(BASE + i * 2)]))
const ADDR = Object.fromEntries(KEYS.map((k, i) => [k, `127.0.0.${i + 1}`]))
const H = Object.fromEntries(KEYS.map(k => [k, `VIEW8-${k}`]))
const SEEDS = { A: ['B', 'C', 'D', 'L'], B: ['A'], C: ['A'], D: ['A'], L: ['A'] }
const ME = (() => { try { return os.userInfo().username.trim().toLowerCase() } catch { return 'unknown' } })()
const TOKEN = 'view8tok'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-view8-'))
const dirs = Object.fromEntries(KEYS.map(k => [k, path.join(TMP, `persist-${k}`)]))
const cfgFile = path.join(TMP, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_entries_per_agent: 50 } }))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify

function spawn(k, extra = {}) {
  const env = { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: `Hub${k}`, AI_BRIDGE_PORT: P[k], AI_BRIDGE_WS_PORT: String(Number(P[k]) + 1), AI_BRIDGE_TOKEN: TOKEN,
    AI_BRIDGE_BIND: ADDR[k], AI_BRIDGE_ADVERTISE_HOST: ADDR[k], AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: H[k], AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: dirs[k],
    AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: SEEDS[k].map(x => `${ADDR[x]}:${P[x]}`).join(','), AI_BRIDGE_DISCOVERY_MS: '300',
    AI_BRIDGE_TEST_GOSSIP: k === 'L' ? 'v5' : '', AI_BRIDGE_TEST_ACTIVITY_TAP: '1', AI_BRIDGE_VIEW_SAVE_MS: '400', TEMP: TMP, TMP, ...extra }   // step 9: no switch any more; L stands in for a 1.7x hub (AI_BRIDGE_TEST_GOSSIP=v5)
  if (!('AIMB_TEST_VIEW_USER' in extra)) delete env.AIMB_TEST_VIEW_USER
  delete env.AI_BRIDGE_TRAY
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR, env, stderr: 'pipe' })
  const c = new Client({ name: `t-${k}`, version: '0' }, { capabilities: {} })
  const h = { c, transport, k, err: '' }
  return c.connect(transport).then(() => { try { transport.stderr.on('data', d => { h.err += d; if (h.err.length > 400000) h.err = h.err.slice(-200000) }) } catch { } return h })
}
const EXTRA = {
  A: { AIMB_TEST_VIEW_USER: ME, AI_BRIDGE_GOSSIP_REFRESH_MS: '1500' },
  B: { AI_BRIDGE_USER: 'builder' },
  C: { AIMB_TEST_VIEW_USER: ME },
  D: { AIMB_TEST_VIEW_USER: 'alice', AI_BRIDGE_TEST_VIEW_DROP_DELTAS: '1', AI_BRIDGE_GOSSIP_REFRESH_MS: '1500' },
  L: {},
}
const call = async (b, n, a = {}) => { try { return JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 150) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
const head = h => call(h, 'activity', { session: '-none-' })
const tapView = async h => ((await call(h, 'activity', { tap: true, session: '-none-' })).tap || {}).view || { recs: [] }
const recOn = async (h, user, k) => (await tapView(h)).recs.find(r => r.user === user && r.k === k) || null
const board = async (h, q = {}) => (await call(h, 'activity', q)).sessions || []
const sessOf = (b, name, host) => b.find(s => String(s.session).toLowerCase() === name.toLowerCase() && (!host || s.host === host))
const nodeAt = (s, p) => ((s && s.nodes) || []).find(n => n.path === p)
async function hardKill(h) {
  const pid = h.transport.pid
  try { process.kill(pid, 'SIGKILL') } catch { }
  for (let i = 0; i < 60; i++) { try { process.kill(pid, 0) } catch { break } await sleep(100) }
  try { await h.transport.close() } catch { }
}
/** A dashboard socket: its welcome (view), every message, view_set. */
function dashboard(k, inst) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${ADDR[k]}:${Number(P[k]) + 1}`), d = { ws, msgs: [], welcome: null }
    d.set = recs => ws.send(J({ type: 'view_set', ref: 'v', recs }))
    d.pushed = () => d.msgs.filter(m => m.type === 'view').flatMap(m => m.recs)
    d.act = async q => { const ref = `a${Math.random()}`; ws.send(J({ type: 'activity_action', ref, ...q })); const m = await until(async () => d.msgs.find(x => x.type === 'activity_action' && x.ref === ref), x => !!x, 8000, 50); return (m && m.result) || { ok: false, code: 'no-answer' } }
    ws.on('open', () => ws.send(J({ type: 'hello', token: TOKEN, kind: 'dashboard', instance: inst || `dash-${k}-${Math.random().toString(36).slice(2, 8)}` })))
    ws.on('message', raw => { const m = JSON.parse(String(raw)); d.msgs.push(m); if (m.type === 'welcome') { d.welcome = m; resolve(d) } })
    ws.on('error', () => resolve(d))
  })
}
const welcomeRecs = async k => { const d = await dashboard(k); const v = d.welcome && d.welcome.view; d.ws.close(); return v || { user: null, recs: [] } }
const has = (recs, k, v) => recs.some(r => r.k === k && (v === undefined || J(r.v) === J(v)))

const all = []
const live = {}
try {
  // ---- the mesh
  live.A = await spawn('A', EXTRA.A); all.push(live.A)
  await sleep(400)
  for (const k of ['B', 'C', 'D', 'L']) { live[k] = await spawn(k, EXTRA[k]); all.push(live[k]) }
  const ids = await Promise.all(KEYS.map(k => call(live[k], 'my_identity')))
  check('harness: A, B, C, D (2.0) and L (1.7x) are gateways', ids.every(i => i.role === 'gateway'), J(ids.map(i => i.role)))
  const linked = await until(() => call(live.A, 'list_sessions'), r => ['B', 'C', 'D', 'L'].every(k => (r.sessions || []).some(s => String(s.session).startsWith(H[k] + '/'))), 12000)
  check('harness: B, C, D and L are linked to A', ['B', 'C', 'D', 'L'].every(k => (linked.sessions || []).some(s => String(s.session).startsWith(H[k] + '/'))))

  // ---- 1. whose view (Q29)
  const hd = Object.fromEntries(await Promise.all(['A', 'B', 'C', 'D'].map(async k => [k, await head(live[k])])))
  check('user: the board head names the view user — A and C this machine\'s login, D alice', hd.A.view_user === ME && hd.C.view_user === ME && hd.D.view_user === 'alice', J([hd.A.view_user, hd.C.view_user, hd.D.view_user]))
  check('user: B (no test hook, AI_BRIDGE_USER=builder) serves its OS LOGIN\'s view, not the AI_BRIDGE_USER name (Q29)', hd.B.view_user === ME && hd.B.view_user !== 'builder', J(hd.B.view_user))
  const dA1 = await dashboard('A', 'dash-A1'), dA2 = await dashboard('A', 'dash-A2'), dB = await dashboard('B'), dC = await dashboard('C'), dD = await dashboard('D')
  check('user: the dashboard welcome carries view:{ user, recs } (empty at first)', dA1.welcome?.view?.user === ME && Array.isArray(dA1.welcome.view.recs) && dA1.welcome.view.recs.length === 0 && dD.welcome?.view?.user === 'alice', J([dA1.welcome?.view, dD.welcome?.view]))

  // ---- the board on A
  await call(live.A, 'register_self', { name: 'Lead', secret: 'ld', project: 'AIMB' })
  const la = i => call(live.A, 'log', { as: 'Lead', secret: 'ld', ...i })
  const w1 = await la({ agent: 'w1', label: 'Worker', text: '@working', state: 'running' })
  const docs = await la({ agent: 'w1', key: 'docs', label: 'Docs', text: '@writing' })
  const notes = await la({ agent: 'w1', key: 'notes', label: 'Notes', text: '@notes' })
  const area = await la({ agent: 'w1', key: 'area', label: 'Area', text: '@an area' })
  await la({ agent: 'w1', key: 'a1', label: 'A1', text: '@first', under: 'area' })
  const N = { docs: docs.node?.id, notes: notes.node?.id, area: area.node?.id, w1: w1.node?.id }
  check('board: the nodes exist on A (ids)', [w1, docs, notes, area].every(r => r.ok && /^[a-z2-7]{16}$/.test(r.node?.id || '')), J([w1, docs].map(r => r.code || r.node)))

  // ---- 2. a pin on A: live in A's other window, on B and on C (via A); never on alice's dashboard
  dA1.set([{ k: `pin:${N.docs}`, v: 1 }])
  const pA2 = await until(async () => dA2.pushed(), r => has(r, `pin:${N.docs}`, 1), 5000, 100)
  check('pin: A\'s SECOND window gets it live ({type:"view"}), the window that set it gets no echo', has(pA2, `pin:${N.docs}`, 1) && !dA1.msgs.some(m => m.type === 'view' || m.type === 'view_refused'), J([pA2, dA1.msgs.filter(m => m.type.startsWith('view'))]))
  const pB = await until(async () => dB.pushed(), r => has(r, `pin:${N.docs}`, 1), 6000, 100)
  const pC = await until(async () => dC.pushed(), r => has(r, `pin:${N.docs}`, 1), 6000, 100)
  check('pin: replicated — pushed live to B\'s dashboard and to C\'s (C is linked to A only)', has(pB, `pin:${N.docs}`, 1) && has(pC, `pin:${N.docs}`, 1), J([pB, pC]))
  const rOnA = await recOn(live.A, ME, `pin:${N.docs}`)
  check('pin: the record is stamped by the gateway (user, ts, origin = A)', rOnA && rOnA.origin === H.A && rOnA.ts > 0 && rOnA.user === ME, J(rOnA))
  // alice: her own choice on D, kept apart
  dD.set([{ k: `hide:${N.notes}`, v: 1 }, { k: 'opt:show_removed', v: true }])
  await until(async () => recOn(live.A, 'alice', `hide:${N.notes}`), r => !!r, 6000)
  await sleep(1500)
  check('two users: alice\'s records reach A (the set holds every user) but are never pushed to A\'s dashboards', !!(await recOn(live.A, 'alice', `hide:${N.notes}`)) && !dA2.pushed().some(r => r.k === `hide:${N.notes}`), J(dA2.pushed()))
  check('two users: robin\'s pin is never pushed to alice\'s dashboard on D', !dD.pushed().some(r => r.k === `pin:${N.docs}`), J(dD.pushed()))
  const wD = await welcomeRecs('D'), wA = await welcomeRecs('A')
  check('two users: a new load on D serves alice\'s choices only; on A only robin\'s ("show removed" saved per user)', has(wD.recs, `hide:${N.notes}`, 1) && has(wD.recs, 'opt:show_removed', true) && !has(wD.recs, `pin:${N.docs}`)
    && has(wA.recs, `pin:${N.docs}`, 1) && !has(wA.recs, `hide:${N.notes}`), J([wD, wA]))
  // refused input
  dA1.set([{ k: 'pin:', v: 1 }, { k: `open:${N.docs}`, v: { o: 7 } }])
  const ref = await until(async () => dA1.msgs.find(m => m.type === 'view_refused'), m => !!m, 4000, 50)
  check('view_set: bad records are refused with a code each ({type:"view_refused"})', ref && J(ref.refused.map(x => x.code)) === J(['bad-key', 'bad-value']), J(ref))

  // ---- 3. keyed by node id: a rename and a move keep the choice
  await la({ agent: 'w1', key: 'docs', rename: 'Documentation' })
  await la({ agent: 'w1', key: 'docs', move: 'area' })
  const bdA = await board(live.A)
  const wA3 = await welcomeRecs('A'), wC3 = await welcomeRecs('C')
  check('ids: after a RENAME and a MOVE the node keeps its id and the pin still names it (A and C)', nodeAt(sessOf(bdA, 'Lead'), 'Worker/Area/Documentation')?.id === N.docs && has(wA3.recs, `pin:${N.docs}`, 1) && has(wC3.recs, `pin:${N.docs}`, 1), J([nodeAt(sessOf(bdA, 'Lead'), 'Worker/Area/Documentation'), wA3.recs]))

  // ---- 4. a close on B survives new activity on A (the page's badge baseline)
  const areaRow = nodeAt(sessOf(await board(live.B), 'Lead', H.A), 'Worker/Area')
  dB.set([{ k: `open:${N.area}`, v: { o: 0, n: 3, q: 0 } }])
  await until(async () => recOn(live.A, ME, `open:${N.area}`), r => !!r, 6000)
  await la({ agent: 'w1', key: 'a2', label: 'A2', text: '@new under the closed node', under: 'area' })
  await la({ agent: 'w1', key: 'a1', text: 'more activity' })
  await sleep(1500)
  const wC4 = await welcomeRecs('C'), wA4 = await welcomeRecs('A')
  const closed = wC4.recs.find(r => r.k === `open:${N.area}`)
  check('close: made on B (a remote node of A), it is still CLOSED everywhere after new activity under it on A ({o:0, n:3} kept)', !!areaRow && closed && J(closed.v) === J({ o: 0, n: 3, q: 0 }) && has(wA4.recs, `open:${N.area}`, { o: 0, n: 3, q: 0 }), J([closed, areaRow && areaRow.id]))

  // ---- 5. the selection: pushed (the page applies it at its next load — Q30), served at a new load
  dA1.set([{ k: 'sel', v: N.notes }, { k: 'fold:details', v: 0 }])
  const sel2 = await until(async () => dA2.pushed(), r => has(r, 'sel', N.notes), 4000, 100)
  const wA5 = await welcomeRecs('A')
  check('selection: the record reaches the second window (the page keeps it for its next load) and a NEW load gets sel + the DETAILS fold', has(sel2, 'sel', N.notes) && has(wA5.recs, 'sel', N.notes) && has(wA5.recs, 'fold:details', 0), J(wA5.recs))
  // seen: a max register
  const eNew = (await la({ agent: 'w1', key: 'notes', text: 'a newer entry' })).id
  dA1.set([{ k: `seen:${N.notes}`, v: eNew }]); await sleep(300); dB.set([{ k: `seen:${N.notes}`, v: notes.id }])
  await sleep(2000)
  const sA = await recOn(live.A, ME, `seen:${N.notes}`), sB = await recOn(live.B, ME, `seen:${N.notes}`)
  check('seen: a later write of an OLDER entry (B) never moves "last seen" back — both hosts keep the newer entry', sA?.v === eNew && sB?.v === eNew, J([sA, sB]))

  // ---- 6. a dismissed agent's / a merged context's records TOMBSTONED on every host
  const tmp = await la({ agent: 'tmp', label: 'Temp agent', text: '@short job', state: 'running' })
  const extra = await la({ agent: 'w1', key: 'extra', label: 'Extra', text: '@to be merged' })
  dA1.set([{ k: `pin:${tmp.node.id}`, v: 1 }, { k: `open:${extra.node.id}`, v: { o: 1 } }])
  dD.set([{ k: `hide:${tmp.node.id}`, v: 1 }])
  await until(async () => recOn(live.C, ME, `pin:${tmp.node.id}`), r => !!r, 6000)
  await until(async () => recOn(live.A, 'alice', `hide:${tmp.node.id}`), r => !!r, 6000)
  await la({ agent: 'tmp', state: 'done', text: '@finished' })
  const dism = await dA1.act({ session: 'Lead', project: 'AIMB', user: 'robin', id: tmp.node.id, action: 'dismiss' })
  const mg = await dA1.act({ session: 'Lead', project: 'AIMB', user: 'robin', id: extra.node.id, action: 'merge', args: { into_id: N.notes } })
  const tombs = async h => { const v = await tapView(h); const f = (u, k) => v.recs.find(r => r.user === u && r.k === k); return [f(ME, `pin:${tmp.node.id}`), f('alice', `hide:${tmp.node.id}`), f(ME, `open:${extra.node.id}`)] }
  const tbC = await until(() => tombs(live.C), t => t.every(r => r && r.v === null), 8000)
  const tbB = await tombs(live.B), tbA = await tombs(live.A)
  check('prune: the dismissed agent\'s records (robin\'s pin, alice\'s hide) and the merged context\'s open → TOMBSTONES on A, B and C', dism.ok && mg.ok && [tbA, tbB, tbC].every(t => t.every(r => r && r.v === null)), J([dism.code, mg.code, tbA, tbB, tbC]))
  const tbD = await until(() => tombs(live.D), t => t.every(r => r && r.v === null), 10000)
  check('prune + anti-entropy: D drops every VIEW delta, yet the tombstones reach it (view_v differs → a full set)', tbD.every(r => r && r.v === null), J(tbD))
  const tD = ((await call(live.D, 'activity', { tap: true, session: '-none-' })).tap || {}).recv || []
  check('anti-entropy: D\'s tap shows dropped deltas and a full VIEW received after its link\'s first one', tD.some(x => x.kind === 'view-dropped') && tD.filter(x => x.kind === 'view' && x.full).length >= 2, J(tD.filter(x => String(x.kind).startsWith('view')).slice(-8)))

  // ---- 7. a pin on a TRANSIENT bucket (made on B) makes it permanent on its owner A
  await la({ agent: 'w1', key: 'job', label: 'Job', text: '@queued', move_to: '/Worker/Queue' })
  const qRow = await until(() => board(live.B), b => !!nodeAt(sessOf(b, 'Lead', H.A), 'Worker/Queue'), 6000)
  const queue = nodeAt(sessOf(qRow, 'Lead', H.A), 'Worker/Queue')
  dB.set([{ k: `pin:${queue && queue.id}`, v: 1 }])
  const kept = await until(() => board(live.A), b => !!nodeAt(sessOf(b, 'Lead'), 'Worker/Queue') && !nodeAt(sessOf(b, 'Lead'), 'Worker/Queue').transient, 6000)
  await la({ agent: 'w1', key: 'job', text: '@done', state: 'done', move_to: '/Worker/Done' })
  await sleep(1200)
  const after = await board(live.A)
  check('keep: a pin made on B on A\'s transient bucket → A writes keep (no longer transient), and the emptied bucket STAYS', !!queue && queue.transient === true && !!nodeAt(sessOf(kept, 'Lead'), 'Worker/Queue') && !nodeAt(sessOf(kept, 'Lead'), 'Worker/Queue').transient && !!nodeAt(sessOf(after, 'Lead'), 'Worker/Queue'),
    J([queue, nodeAt(sessOf(after, 'Lead'), 'Worker/Queue')]))
  check('keep: A logs it', live.A.err.includes('the transient context is permanent now (keep)'))

  // ---- 8. Q70: the 1.7x host is a serious issue on every 2.0 board
  const uA = await until(() => head(live.A), h => (h.unshared_hosts || []).some(u => u.host === H.L), 6000)
  const uB = await until(() => head(live.B), h => (h.unshared_hosts || []).some(u => u.host === H.L), 6000)
  const eA = (uA.unshared_hosts || []).find(u => u.host === H.L), eB = (uB.unshared_hosts || []).find(u => u.host === H.L)
  // (L is this tree's bridge with AI_BRIDGE_TEST_GOSSIP=v5 — the stand-in for a 1.7x host — so its version is this one's)
  check('Q70: A\'s head lists the 1.7x host L in unshared_hosts (its version, since, seen by A)', eA && /^\d+\.\d+\.\d+/.test(eA.bridge_version || '') && eA.since > 0 && J(eA.seen_by) === J([H.A]) && eA.activity_gossip === 5, J(uA.unshared_hosts))
  check('Q70: replicated — B (not linked to L) lists it too, seen by A', eB && J(eB.seen_by) === J([H.A]), J(uB.unshared_hosts))
  check('Q70: no 2.0 host is ever listed', !(uA.unshared_hosts || []).some(u => [H.B, H.C, H.D].includes(u.host)))
  await hardKill(live.L); all.splice(all.indexOf(live.L), 1)
  const gA = await until(() => head(live.A), h => !(h.unshared_hosts || []).length, 8000)
  const gB = await until(() => head(live.B), h => !(h.unshared_hosts || []).length, 8000)
  check('Q70: L\'s link drops → off the list on A and on B', !(gA.unshared_hosts || []).length && !(gB.unshared_hosts || []).length, J([gA.unshared_hosts, gB.unshared_hosts]))

  // ---- 9. Reset view on C: the user's records void on every host; alice's untouched
  dA1.set([{ k: `hide:${N.area}`, v: 1 }])
  await until(async () => recOn(live.C, ME, `hide:${N.area}`), r => !!r, 6000)
  dC.set([{ k: 'reset', v: 1 }])
  const rA = await until(async () => dA2.pushed(), r => has(r, 'reset', 1), 6000, 100)
  await sleep(1500)
  const wA9 = await welcomeRecs('A'), wB9 = await welcomeRecs('B'), wD9 = await welcomeRecs('D')
  check('reset: pushed live to A\'s window; a new load on A and on B serves only the reset record (every older choice void)', has(rA, 'reset', 1) && J(wA9.recs.map(r => r.k)) === J(['reset']) && J(wB9.recs.map(r => r.k)) === J(['reset']), J([wA9.recs, wB9.recs]))
  check('reset: alice\'s view on D is untouched', has(wD9.recs, `hide:${N.notes}`, 1), J(wD9.recs))
  dA1.set([{ k: `pin:${N.notes}`, v: 1 }])
  await until(async () => recOn(live.C, ME, `pin:${N.notes}`), r => !!r, 6000)
  const wC9 = await welcomeRecs('C')
  check('reset: a choice made after it counts again (pin on A, served on C)', has(wC9.recs, `pin:${N.notes}`, 1), J(wC9.recs))

  // ---- 10. files + a restart with every peer down
  await sleep(1200)
  const vfiles = Object.fromEntries(['A', 'B', 'C', 'D'].map(k => [k, (() => { try { return fs.readdirSync(path.join(dirs[k], 'views')) } catch { return [] } })()]))
  check('files: each host writes ONLY its own views/<host>.json', ['A', 'B', 'C', 'D'].every(k => J(vfiles[k].filter(n => !n.includes('.tmp'))) === J([`view8-${k.toLowerCase()}.json`])), J(vfiles))
  for (const d of [dA1, dA2, dB, dC, dD]) try { d.ws.close() } catch { }
  for (const k of ['A', 'B', 'D']) { await hardKill(live[k]); all.splice(all.indexOf(live[k]), 1) }
  await hardKill(live.C); all.splice(all.indexOf(live.C), 1)
  const vdir = path.join(dirs.C, 'views')
  const cImg = JSON.parse(fs.readFileSync(path.join(vdir, 'view8-c.json'), 'utf8'))
  check('files: C\'s file holds the whole set (own + learned, both users)', cImg.v === 1 && cImg.host === H.C && cImg.recs.some(r => r.user === 'alice') && cImg.recs.some(r => r.user === ME && r.k === `pin:${N.notes}`), J(cImg.recs.length))
  // a shared folder (the Dropbox pair): another host's file beside C's, and a conflicted copy of C's
  const other = { v: 1, host: 'VIEW8-Z', realm: cImg.realm, written_at: Date.now(), recs: [{ realm: cImg.realm, user: ME, k: `pin:${N.area}`, v: 1, ts: Date.now(), origin: 'VIEW8-Z' }] }
  fs.writeFileSync(path.join(vdir, 'view8-z.json'), J(other))
  const otherBytes = fs.readFileSync(path.join(vdir, 'view8-z.json'), 'utf8')
  const conflicted = "view8-c (VIEW8-Z's conflicted copy 2026-10-03).json"
  fs.writeFileSync(path.join(vdir, conflicted), J({ ...cImg, recs: [{ realm: cImg.realm, user: ME, k: `pin:${N.w1}`, v: 1, ts: Date.now() + 5, origin: 'VIEW8-C' }] }))
  live.C = await spawn('C', EXTRA.C); all.push(live.C)
  const hC = await head(live.C)
  const wC10 = await welcomeRecs('C')
  check('restart: C, alone (every peer down), still serves the user\'s view from its file', has(wC10.recs, `pin:${N.notes}`, 1) && has(wC10.recs, 'reset', 1), J(wC10.recs))
  check('restart: another host\'s views file on the shared folder is merged (read only — never rewritten)', has(wC10.recs, `pin:${N.area}`, 1) && fs.readFileSync(path.join(vdir, 'view8-z.json'), 'utf8') === otherBytes, J(wC10.recs))
  check('conflicted copy: never read (its pin is absent) …', !has(wC10.recs, `pin:${N.w1}`), J(wC10.recs))
  check('conflicted copy: … and WARNED — in the board head\'s fs_warnings and the log', (hC.fs_warnings || []).some(w => w.includes(conflicted) && w.includes('conflicted copy')) && live.C.err.includes(`conflicted copy '${conflicted}' in views`), J(hC.fs_warnings))
  check('conflicted copy: never deleted', fs.existsSync(path.join(vdir, conflicted)))
} catch (e) { fail++; console.log('FAIL crashed:', (e && e.stack) || e) }

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(500)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
