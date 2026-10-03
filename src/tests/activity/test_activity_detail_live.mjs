// #86 (v1.72.0) — live: a node's DETAILS and DATA reach a dashboard ON DEMAND, never through gossip. Ported to the 2.0 board
// (#88 build step 9): the dashboard's details section asks for the selected node's line by its ENTRY id + host (`activity
// {entry:{id, host}}` on its WS): this gateway answers its own nodes; another host's are fetched from their OWNER over the hub
// link (ACTIVITY_REQ op "entry", gossip v6). The boards (the `activity` read, the tool's and the dashboard's) carry only
// has_details / has_data and the line's id. An older log entry (no longer the current line) comes back from the owner's day
// file. An owner that went away degrades to a refusal the page turns into a sentence. Nodes are made with the 2.0 tool forms
// (key + label, a leading "@" sets the line).
// Retired in step 9 (1.7x only): the dashboard's board / delta PUSHES (activity_sub — rebuilt in step 10; the same checks
// read the board with the `activity` request instead), and the mixed check against a real older owner (AIMB_TEST_OLD_BRIDGE —
// a 2.0 gateway shares activity only with 2.0 hosts, §6.2).
// Temp persist dirs + a temp AI_BRIDGE_CONFIG (never src/config.json); a test-set token that is never printed. Loopback "hosts":
//   B  127.0.0.1 "NOT-B"  the dashboard dashB; session Local (a node with details + data)
//   A  127.0.0.2 "NOT-A"  session Far (nodes with details + data, an older entry, a large data value)
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
const TOKEN = 'act86-' + crypto.randomBytes(9).toString('hex')
const B_PORT = String(tp(16200)), A_PORT = String(tp(16202))
const HB = 'NOT-B', HA = 'NOT-A'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-86-'))
const dirs = Object.fromEntries(['A', 'B'].map(k => [k, fs.mkdtempSync(path.join(tmp, `p${k}-`))]))
const cfgFile = path.join(tmp, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({}))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const seen = []   // every raw response / frame text: none may carry the token
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).split(TOKEN).join('<TOKEN>'))) }
const J = JSON.stringify

const all = []
function spawn(name, bind, port, host, extra = {}, script = SRCDIR + BRIDGE) {
  const env = { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
    AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
    AI_BRIDGE_STABLE_IDS: '1', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', AI_BRIDGE_TEST_GOSSIP: '', TEMP: tmp, TMP: tmp, ...extra }
  delete env.AI_BRIDGE_TRAY
  const transport = new StdioClientTransport({ command: 'node', args: [script], cwd: path.dirname(script), env, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => { const h = { c, transport, name }; all.push(h); return h })
}
async function stop(h) { try { await h.transport.close() } catch { } const i = all.indexOf(h); if (i >= 0) all.splice(i, 1); await sleep(300) }
const fileOf = d => ({ AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: d })
const call = async (b, n, a = {}) => { try { const t = (await b.c.callTool({ name: n, arguments: a })).content[0].text; seen.push(t); return JSON.parse(t) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 150) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
const board = async (h, q = {}) => (await call(h, 'activity', q)).sessions || []
const nodeOf = (b, name, p, host) => { const s = b.find(x => String(x.session).toLowerCase() === name.toLowerCase() && (!host || x.host === host)); return !s ? undefined : (s.nodes || []).find(x => x.path === p) }
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
// the dashboard's view of a node (2.0, until step 10 rebuilds its pushes): the `activity` board read on its WS → the node's row
const dashNode = async (C, session, p, host) => { const r = await C.req({ session }); return nodeOf((r && r.sessions) || [], session, p, host) }

try {
  // ================================================================= the mesh: B (dashboard) and A (an owner) linked
  const B = await spawn('HubB', '127.0.0.1', B_PORT, HB, { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT}` })
  await sleep(600)
  let A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` })
  const ids = await Promise.all([A, B].map(h => call(h, 'my_identity')))
  check('harness: A and B are gateways (2.0 boards, format 6)', ids.every(i => i.role === 'gateway') && (await call(B, 'activity', { session: '-none-' })).format === 6, J(ids.map(i => [i.role, i.bridge_version])))
  await until(() => call(B, 'list_sessions'), r => (r.sessions || []).some(s => String(s.session).startsWith(HA + '/')), 12000)

  // ---- fixtures: Far on A — a line with details + data, then a newer line (the first becomes an older entry); Local on B
  const DET1 = 'step 3 of 8 — <b>files</b> & "quotes"\nsecond line'
  const DATA1 = { files: ['a.txt', 'b.txt'], ok: true, nested: { depth: { n: 3 } }, '<script>x</script>': null }
  await call(A, 'register_self', { name: 'Far', secret: 'f', project: 'DET' })
  const F = input => call(A, 'log', { as: 'Far', secret: 'f', ...input })
  const f0 = await F({ key: 'crunch', label: 'Crunch', text: '@first pass', details: 'OLDER-DETAILS', data: { pass: 1 } })
  const f1 = await F({ key: 'crunch', text: '@crunching', details: DET1, data: DATA1 })
  const BIG = { rows: Array.from({ length: 300 }, (_, i) => ({ i, name: `row ${i}` })) }
  const fb = await F({ key: 'big', label: 'Big', text: '@a large data value', data: BIG })
  await call(B, 'register_self', { name: 'Local', secret: 'l', project: 'DET' })
  const l1 = await call(B, 'log', { as: 'Local', secret: 'l', key: 'here', label: 'Here', text: '@local work', details: 'LOCAL-DETAILS', data: { local: true } })
  check('fixtures: lines with details + data reported (Far on A — two lines on Crunch, a large data value on Big; Local on B)', [f0, f1, fb, l1].every(r => r && r.ok) && f1.line === true && f1.node?.id === f0.node?.id, J([f0, f1, fb, l1].map(r => r && (r.code || r.what))))

  // ---- the dashboard on B: the board (the `activity` read) carries the flags only
  const dashB = await wsClient(Number(B_PORT) + 1, 'dashboard')
  const uF = await until(() => dashNode(dashB, 'Far', 'Crunch', HA), u => !!u && !!u.current && u.current.id === f1.id, 10000, 150)
  const uL = await dashNode(dashB, 'Local', 'Here', HB), uBig = await dashNode(dashB, 'Far', 'Big', HA)
  check('board (gossip): a remote node\'s line carries its entry id + has_details / has_data — and NOT the details or the data', uF?.current?.id === f1.id && uF.current.has_details === true && uF.current.has_data === true && !('details' in uF.current) && !('data' in uF.current) && uBig?.current?.has_data === true && !uBig.current.has_details, J(uF?.current))
  const boardText = dashB.raw.filter(s => /"type":"activity"/.test(s) && /"sessions"/.test(s)).join('\n')
  check('board (gossip): no board read on the dashboard carries any of the details or data text', !/second line|OLDER-DETAILS|a\.txt|LOCAL-DETAILS|row 299/.test(boardText) && boardText.length > 0)
  const bF = nodeOf(await board(B), 'Far', 'Crunch', HA)
  check('board (the activity tool on B): the same flags for A\'s node, no details / data', bF?.current?.id === f1.id && bF.current.has_details === true && bF.current.has_data === true && !('details' in bF.current), J(bF?.current))

  // ================================================================= ON DEMAND: the details section's fetch (activity {entry:{id, host}})
  const r1 = await dashB.req({ entry: { id: uF.current.id, host: HA } })
  check('remote node: its CURRENT line\'s details + data come from the OWNER (from_host NOT-A, source memory) — exactly as reported (text kept, JSON intact)',
    r1.ok !== false && r1.from_host === HA && r1.source === 'memory' && r1.entry?.details === DET1 && J(r1.entry?.data) === J(DATA1) && r1.entry.id === f1.id && r1.entry.current === true && r1.entry.path === 'Crunch' && r1.entry.node_id === f1.node?.id, J(r1))
  const rL = await dashB.req({ entry: { id: uL.current.id, host: HB } })
  check('local node: this gateway answers its own (no from_host)', rL.ok !== false && !rL.from_host && rL.entry?.details === 'LOCAL-DETAILS' && J(rL.entry?.data) === J({ local: true }), J(rL))
  const rBig = await dashB.req({ entry: { id: uBig.current.id, host: HA } })
  check('a large data value (300 rows) crosses the hub link whole', rBig.ok !== false && Array.isArray(rBig.entry?.data?.rows) && rBig.entry.data.rows.length === 300 && rBig.entry.data.rows[299].name === 'row 299', J({ ok: rBig.ok, code: rBig.code, n: rBig.entry?.data?.rows?.length }))
  // the older entry (no longer the current line): its details come back from A's DAY FILE
  const lg = await dashB.req({ log: { session: 'Far', project: 'DET', user: 'robin', host: HA, id: uF.id, limit: 50 } })
  const old = (lg.log?.entries || []).find(e => e.id === f0.id)
  check('the log page (remote, by node id, paged by the owner): the older entry is listed with its flags only', lg.from_host === HA && !!old && old.has_details === true && old.has_data === true && !('details' in old) && !('data' in old), J([lg.code, lg.log?.entries?.map(e => [e.id, e.has_details])]))
  const r0 = await dashB.req({ entry: { id: f0.id, host: HA } })
  check('an OLDER entry (expanded in the log panel): its details + data from the owner\'s day file (source file)', r0.ok !== false && r0.from_host === HA && r0.source === 'file' && r0.entry?.details === 'OLDER-DETAILS' && J(r0.entry?.data) === J({ pass: 1 }), J(r0))
  // the line moves on → the dashboard asks for the new id; the old one is still served (from the file now)
  const f2 = await F({ key: 'crunch', text: '@crunching more', data: { files: ['c.txt'] } })
  const u2 = await until(() => dashNode(dashB, 'Far', 'Crunch', HA), u => !!u && u.current?.id === f2.id, 8000, 150)
  const r2 = await dashB.req({ entry: { id: u2.current.id, host: HA } }), r1b = await dashB.req({ entry: { id: f1.id, host: HA } })
  check('the line moved on: the board has the NEW id (data only); its fetch returns the new data; the previous line is now served from the file',
    u2.current.has_data === true && !u2.current.has_details && r2.entry?.details == null && J(r2.entry?.data) === J({ files: ['c.txt'] }) && r1b.source === 'file' && r1b.entry?.details === DET1, J([u2.current, r2.entry, r1b.source]))
  // refusals the page turns into sentences
  const rx = await dashB.req({ entry: { id: 'act_nope-1', host: HA } }), ru = await dashB.req({ entry: { id: f1.id, host: 'NOT-Z' } })
  check('refusals: an unknown id on the owner → unknown-entry (forwarded back); an unknown host → unknown-host', rx.ok === false && rx.code === 'unknown-entry' && ru.ok === false && ru.code === 'unknown-host', J([rx, ru]))

  console.log('SKIP mixed check with a real older bridge (retired in #88 step 9: a 2.0 gateway shares activity only with 2.0 hosts)')

  // ================================================================= the owner GOES AWAY: a refusal, not a hang
  await stop(A); A = null
  await sleep(800)
  const t0 = Date.now(), rg = await dashB.req({ entry: { id: f2.id, host: HA } }, 20000)
  check('owner gone: the fetch is REFUSED promptly (owner-unreachable, or unknown-host once its slice is dropped) — the page says "the details are on NOT-A, which can\'t be reached"', rg.ok === false && ['owner-unreachable', 'unknown-host'].includes(rg.code) && Date.now() - t0 < 15000, J([rg, Date.now() - t0]))

  check('no response, frame or push carried the realm token', !seen.some(t => t.includes(TOKEN)))
  dashB.close()
} catch (e) { fail++; console.log('FAIL crashed:', (e && e.stack) || e) }
console.log(`\n${pass} passed, ${fail} failed`)
for (const h of [...all]) await stop(h)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
