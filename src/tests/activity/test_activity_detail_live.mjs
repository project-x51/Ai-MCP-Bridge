// #86 (v1.72.0) — live: a node's DETAILS and DATA reach a dashboard ON DEMAND, never through gossip. The dashboard's details section asks
// for the selected node's current line by its entry id + host (`activity {entry:{id, host}}`, the v1.60 request): this gateway answers its
// own nodes, another host's are fetched from their OWNER over the hub link (ACTIVITY_REQ op "entry"). Gossip and the boards carry only
// has_details / has_data and the line's id. An older log entry (no longer the current line) comes back from the owner's day file. An owner
// that went away degrades to a refusal the page turns into a sentence. No new request kind — so an older (≥ 1.60) owner answers the same
// way: with AIMB_TEST_OLD_BRIDGE=<an older bridge.mjs> (e.g. a `git archive` of 1.71) a real older owner is checked too.
// Temp persist dirs + a temp AI_BRIDGE_CONFIG (never src/config.json); a test-set token that is never printed. Loopback "hosts":
//   B  127.0.0.1 "NOT-B"  the dashboard dashB; session Local (a node with details + data)
//   A  127.0.0.2 "NOT-A"  session Far (nodes with details + data, an older entry, a large data value)
//   D  127.0.0.4 "NOT-D"  ONLY with AIMB_TEST_OLD_BRIDGE: session Ancient on a real older bridge
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 16200)   // #81: this file's port block (16200 = its first port name)
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const OLD = process.env.AIMB_TEST_OLD_BRIDGE || ''
const TOKEN = 'act86-' + crypto.randomBytes(9).toString('hex')
const B_PORT = String(tp(16200)), A_PORT = String(tp(16202)), D_PORT = String(tp(16206))
const HB = 'NOT-B', HA = 'NOT-A', HD = 'NOT-D'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-86-'))
const dirs = Object.fromEntries(['A', 'B', 'D'].map(k => [k, fs.mkdtempSync(path.join(tmp, `p${k}-`))]))
const cfgFile = path.join(tmp, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({}))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const seen = []   // every raw response / frame text: none may carry the token
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).split(TOKEN).join('<TOKEN>'))) }
const J = JSON.stringify

const all = []
function spawn(name, bind, port, host, extra = {}, script = SRCDIR + BRIDGE) {
  const transport = new StdioClientTransport({ command: 'node', args: [script], cwd: path.dirname(script),
    env: { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
      AI_BRIDGE_STABLE_IDS: '1', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', AI_BRIDGE_TEST_GOSSIP: '', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => { const h = { c, transport, name }; all.push(h); return h })
}
async function stop(h) { try { await h.transport.close() } catch { } const i = all.indexOf(h); if (i >= 0) all.splice(i, 1); await sleep(300) }
const fileOf = d => ({ AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: d })
const call = async (b, n, a = {}) => { try { const t = (await b.c.callTool({ name: n, arguments: a })).content[0].text; seen.push(t); return JSON.parse(t) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 150) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
const board = async (h, q = {}) => (await call(h, 'activity', q)).sessions || []
const nodeOf = (b, name, p) => { const s = b.find(x => String(x.session).toLowerCase() === name.toLowerCase()); return !s ? undefined : p === '' ? s.self : (s.nodes || []).find(x => x.path === p) }
function wsClient(port, kind, extra = {}) {   // a dashboard on a gateway's WS port
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${extra.host || '127.0.0.1'}:${port}`), C = { ws, msgs: [], raw: [], n: 0, welcome: null }
    C.send = o => ws.send(J(o))
    C.req = async (query, ms = 12000) => { const ref = `q${++C.n}`; C.send({ type: 'activity', ref, query }); const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = C.msgs.find(x => x.type === 'activity' && x.ref === ref); if (m) return m.result; await sleep(30) } return { ok: false, code: 'no-answer' } }
    C.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => ws.send(J({ type: 'hello', kind, token: TOKEN, instance: `t-${kind}-${port}` })))
    ws.on('message', raw => { const s = String(raw); seen.push(s); C.raw.push(s); const m = JSON.parse(s); C.msgs.push(m); if (m.type === 'welcome' || m.type === 'error') { C.welcome = m; resolve(C) } })
    ws.on('close', () => resolve(C))
    ws.on('error', () => resolve(C))
  })
}
const verOk = (v, min) => { const a = String(v).split('.').map(Number); return a[0] > 1 || (a[0] === 1 && a[1] >= min) }
// the dashboard's view of a node: the latest board / delta frame that carries it (a raw unit: { path, host, current:{ id, has_details, has_data } })
const unitOf = (C, session, p, host) => { for (let i = C.msgs.length - 1; i >= 0; i--) { const m = C.msgs[i]; if (m.type !== 'activity_board' && m.type !== 'activity_delta') continue
  for (const u of m.upsert || []) { if (u.kind === 'node' && u.path === p && u.host === host) return u   // (paths are unique across this test's sessions)
    if (u.kind === 'session' && p === '' && String(u.session).toLowerCase() === session.toLowerCase()) { const s = (u.selves || [u.self]).find(x => x && x.host === host); if (s) return s } } } return null }

// ================================================================= the mesh: B (dashboard) and A (an owner) linked
const B = await spawn('HubB', '127.0.0.1', B_PORT, HB, { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT}${OLD ? `,127.0.0.4:${D_PORT}` : ''}` })
await sleep(600)
const A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` })
const ids = await Promise.all([A, B].map(h => call(h, 'my_identity')))
check('harness: A and B are gateways on ≥ 1.72.0', ids.every(i => i.role === 'gateway' && verOk(i.bridge_version, 72)), J(ids.map(i => [i.role, i.bridge_version])))
await until(() => call(B, 'list_sessions'), r => (r.sessions || []).some(s => String(s.session).startsWith(HA + '/')), 12000)

// ---- fixtures: Far on A — a line with details + data, then an older entry with details; Local on B
const DET1 = 'step 3 of 8 — <b>files</b> & "quotes"\nsecond line'
const DATA1 = { files: ['a.txt', 'b.txt'], ok: true, nested: { depth: { n: 3 } }, '<script>x</script>': null }
await call(A, 'register_self', { name: 'Far', secret: 'f', project: 'DET' })
const F = input => call(A, 'log', { as: 'Far', secret: 'f', ...input })
const f0 = await F({ path: 'crunch', text: '@~root first pass', details: 'OLDER-DETAILS', data: { pass: 1 } })
const f1 = await F({ path: 'crunch', text: '@~root crunching', details: DET1, data: DATA1 })
const BIG = { rows: Array.from({ length: 300 }, (_, i) => ({ i, name: `row ${i}` })) }
const fb = await F({ path: '@big', text: '@~root a large data value', data: BIG })
await call(B, 'register_self', { name: 'Local', secret: 'l', project: 'DET' })
const l1 = await call(B, 'log', { as: 'Local', secret: 'l', path: 'here', text: '@~root local work', details: 'LOCAL-DETAILS', data: { local: true } })
check('fixtures: lines with details + data reported (Far on A — two lines on crunch, a large data value on @big; Local on B)', [f0, f1, fb, l1].every(r => r && r.ok), J([f0, f1, fb, l1].map(r => r && (r.code || r.what))))

// ---- the dashboard on B
const dashB = await wsClient(Number(B_PORT) + 1, 'dashboard')
dashB.send({ type: 'activity_sub' })
await until(async () => unitOf(dashB, 'Far', 'crunch', HA), u => !!u && !!u.current && u.current.id === f1.id, 10000, 100)
const uF = unitOf(dashB, 'Far', 'crunch', HA), uL = unitOf(dashB, 'Local', 'here', HB), uBig = unitOf(dashB, 'Far', '@big', HA)
check('board (gossip): a remote node\'s line carries its entry id + has_details / has_data — and NOT the details or the data', uF?.current?.id === f1.id && uF.current.has_details === true && uF.current.has_data === true && !('details' in uF.current) && !('data' in uF.current) && uBig?.current?.has_data === true && !uBig.current.has_details, J(uF?.current))
const boardText = dashB.raw.filter(s => /"type":"activity_(board|delta)"/.test(s)).join('\n')
check('board (gossip): no board / delta frame on the dashboard carries any of the details or data text', !/second line|OLDER-DETAILS|a\.txt|LOCAL-DETAILS|row 299/.test(boardText) && boardText.length > 0)
const bF = nodeOf(await board(B), 'Far', 'crunch')
check('board (the activity tool on B): the same flags for A\'s node, no details / data', bF?.current?.id === f1.id && bF.current.has_details === true && bF.current.has_data === true && !('details' in bF.current), J(bF?.current))

// ================================================================= ON DEMAND: the details section's fetch (activity {entry:{id, host}})
const r1 = await dashB.req({ entry: { id: uF.current.id, host: HA } })
check('remote node: its CURRENT line\'s details + data come from the OWNER (from_host NOT-A, source memory) — exactly as reported (text kept, JSON intact)',
  r1.ok !== false && r1.from_host === HA && r1.source === 'memory' && r1.entry?.details === DET1 && J(r1.entry?.data) === J(DATA1) && r1.entry.id === f1.id && r1.entry.current === true && r1.entry.path === 'crunch', J(r1))
const rL = await dashB.req({ entry: { id: uL.current.id, host: HB } })
check('local node: this gateway answers its own (no from_host)', rL.ok !== false && !rL.from_host && rL.entry?.details === 'LOCAL-DETAILS' && J(rL.entry?.data) === J({ local: true }), J(rL))
const rBig = await dashB.req({ entry: { id: uBig.current.id, host: HA } })
check('a large data value (300 rows) crosses the hub link whole', rBig.ok !== false && Array.isArray(rBig.entry?.data?.rows) && rBig.entry.data.rows.length === 300 && rBig.entry.data.rows[299].name === 'row 299', J({ ok: rBig.ok, code: rBig.code, n: rBig.entry?.data?.rows?.length }))
// the older entry (no longer the current line): its details come back from A's DAY FILE
const lg = await dashB.req({ log: { session: 'Far', project: 'DET', user: 'robin', host: HA, path: 'crunch', limit: 50 } })
const old = (lg.log?.entries || []).find(e => e.id === f0.id)
check('the log page (remote, paged as before): the older entry is listed with its flags only', !!old && old.has_details === true && old.has_data === true && !('details' in old) && !('data' in old), J(lg.log?.entries?.map(e => [e.id, e.has_details])))
const r0 = await dashB.req({ entry: { id: f0.id, host: HA } })
check('an OLDER entry (expanded in the log panel): its details + data from the owner\'s day file (source file)', r0.ok !== false && r0.from_host === HA && r0.source === 'file' && r0.entry?.details === 'OLDER-DETAILS' && J(r0.entry?.data) === J({ pass: 1 }), J(r0))
// the line moves on → the dashboard asks for the new id; the old one is still served (from the file now)
const f2 = await F({ path: 'crunch', text: '@~root crunching more', data: { files: ['c.txt'] } })
await until(async () => unitOf(dashB, 'Far', 'crunch', HA), u => !!u && u.current?.id === f2.id, 8000, 100)
const u2 = unitOf(dashB, 'Far', 'crunch', HA)
const r2 = await dashB.req({ entry: { id: u2.current.id, host: HA } }), r1b = await dashB.req({ entry: { id: f1.id, host: HA } })
check('the line moved on: the board has the NEW id (data only); its fetch returns the new data; the previous line is now served from the file',
  u2.current.has_data === true && !u2.current.has_details && r2.entry?.details == null && J(r2.entry?.data) === J({ files: ['c.txt'] }) && r1b.source === 'file' && r1b.entry?.details === DET1, J([u2.current, r2.entry, r1b.source]))
// refusals the page turns into sentences
const rx = await dashB.req({ entry: { id: 'act_nope-1', host: HA } }), ru = await dashB.req({ entry: { id: f1.id, host: 'NOT-Z' } })
check('refusals: an unknown id on the owner → unknown-entry (forwarded back); an unknown host → unknown-host', rx.ok === false && rx.code === 'unknown-entry' && ru.ok === false && ru.code === 'unknown-host', J([rx, ru]))

// ================================================================= OPTIONAL: a real older owner (AIMB_TEST_OLD_BRIDGE) — no capability needed
if (OLD) {
  const D = await spawn('HubD', '127.0.0.4', D_PORT, HD, { ...fileOf(dirs.D), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` }, OLD)
  const did = await call(D, 'my_identity')
  await call(D, 'register_self', { name: 'Ancient', secret: 'a', project: 'DET' })
  const dl = await call(D, 'log', { as: 'Ancient', secret: 'a', path: 'old', text: '@~root on an older bridge', details: 'ANCIENT-DETAILS', data: { v: did.bridge_version } })
  const ud = await until(async () => unitOf(dashB, 'Ancient', 'old', HD), u => !!u && !!u.current?.id, 15000, 150)
  const rd = await dashB.req({ entry: { id: ud?.current?.id, host: HD } })
  check(`mixed (${did.bridge_version}): an OLDER owner's node shows the flags on the 1.72 board and its details + data are fetched the same way (no capability needed)`,
    dl.ok && ud?.current?.has_details === true && rd.ok !== false && rd.from_host === HD && rd.entry?.details === 'ANCIENT-DETAILS' && J(rd.entry?.data) === J({ v: did.bridge_version }), J([did.bridge_version, ud?.current, rd]))
  await stop(D)
} else console.log('SKIP mixed check with a real older bridge (set AIMB_TEST_OLD_BRIDGE=<an older bridge.mjs>)')

// ================================================================= the owner GOES AWAY: a refusal, not a hang
await stop(A)
await sleep(800)
const t0 = Date.now(), rg = await dashB.req({ entry: { id: f2.id, host: HA } }, 20000)
check('owner gone: the fetch is REFUSED promptly (owner-unreachable, or unknown-host once its slice is dropped) — the page says "the details are on NOT-A, which can\'t be reached"', rg.ok === false && ['owner-unreachable', 'unknown-host'].includes(rg.code) && Date.now() - t0 < 15000, J([rg, Date.now() - t0]))

check('no response, frame or push carried the realm token', !seen.some(t => t.includes(TOKEN)))
console.log(`\n${pass} passed, ${fail} failed`)
dashB.close()
for (const h of [...all]) await stop(h)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
