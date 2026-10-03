// #88 (v2.0) build step 7 — GOSSIP v6, live: three 2.0 gateways (the pre-cutover switch AI_BRIDGE_ACTIVITY_V2=1) and one
// 1.7x gateway (the same bridge WITHOUT the switch = a live 1.7x bridge), each on its own loopback address, host name
// (AI_BRIDGE_TEST_HOSTNAME), temp persistence dir and this file's port block (never 12317 / 12318); a temp AI_BRIDGE_CONFIG
// (never src/config.json). Every gateway has the others as seeds (activity gossip is one-hop: each host sends its OWN board):
//   A  127.0.0.1  "V2GOS-A"  2.0; a dashboard attaches here (its actions on B's nodes go to B by id)
//   B  127.0.0.2  "V2GOS-B"  2.0; serves 3 entries per remote log page; restarted mid-test (catch-up)
//   C  127.0.0.3  "V2GOS-C"  2.0; a third board
//   L  127.0.0.4  "V2GOS-L"  1.7x (no switch): announces activity_gossip:5
// Covers (docs/spec-88.md §6, §8 step 7): the handshake (2.0 announces 6 and shares only with 6); boards REPLICATE both
// ways and to a third host, node IDS STABLE across hosts (the same id, path, kind, type, bar and plan on every board); a
// rename / a move on one host travels as ONE changed unit, a merge as the merged node's removal (+ its new parent);
// REMOTE LOG PAGES both ways — by id, paged by the OWNER through its index files across ≥ 3 pages, "show removed" for a
// vanished transient bucket — and a remote entry's details; DASHBOARD ACTIONS on a remote node BY ID (skip, move, rename,
// merge; the clash dialog's answer: an unanswered clash → duplicate-label with the list, then answered with a label);
// a HOST RESTART: its agents GONE on the others while it is down, owner-unreachable for its pages, then its replayed board
// back (same ids, gone cleared) and CATCH-UP both ways (what changed meanwhile); and a 1.7x PEER: nothing is shared in
// either direction (§6.2's equality check), the mismatch logged once, no frames, its sessions unknown to a 2.0 read /
// action, the message mesh still federated.
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
const P = { A: String(BASE), B: String(BASE + 2), C: String(BASE + 4), L: String(BASE + 6) }
const ADDR = { A: '127.0.0.1', B: '127.0.0.2', C: '127.0.0.3', L: '127.0.0.4' }
const H = { A: 'V2GOS-A', B: 'V2GOS-B', C: 'V2GOS-C', L: 'V2GOS-L' }
const TOKEN = 'act2gossiptok'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-act2gos-'))
const dirs = Object.fromEntries(Object.keys(H).map(k => [k, path.join(TMP, `persist-${k}`)]))
const cfgFile = path.join(TMP, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_entries_per_agent: 50 } }))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify

function spawn(k, extra = {}) {
  const env = { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: `Hub${k}`, AI_BRIDGE_PORT: P[k], AI_BRIDGE_WS_PORT: String(Number(P[k]) + 1), AI_BRIDGE_TOKEN: TOKEN,
    AI_BRIDGE_BIND: ADDR[k], AI_BRIDGE_ADVERTISE_HOST: ADDR[k], AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: H[k], AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: dirs[k],
    AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: Object.keys(H).filter(x => x !== k).map(x => `${ADDR[x]}:${P[x]}`).join(','), AI_BRIDGE_DISCOVERY_MS: '300',
    AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_TEST_ACTIVITY_TAP: '1', TEMP: TMP, TMP, ...(k === 'L' ? {} : { AI_BRIDGE_ACTIVITY_V2: '1' }), ...extra }
  if (k === 'L') delete env.AI_BRIDGE_ACTIVITY_V2
  delete env.AI_BRIDGE_TRAY
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR, env, stderr: 'pipe' })
  const c = new Client({ name: `t-${k}`, version: '0' }, { capabilities: {} })
  const h = { c, transport, k, err: '' }
  return c.connect(transport).then(() => { try { transport.stderr.on('data', d => { h.err += d; if (h.err.length > 400000) h.err = h.err.slice(-200000) }) } catch { } return h })
}
const call = async (b, n, a = {}) => { try { return JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 150) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
const board = async (h, q = {}) => (await call(h, 'activity', q)).sessions || []
const sessOf = (b, name, host) => b.find(s => String(s.session).toLowerCase() === name.toLowerCase() && (!host || s.host === host))
const nodeAt = (s, p) => ((s && s.nodes) || []).find(n => n.path === p)
const tap = async h => (await call(h, 'activity', { tap: true, session: '-none-' })).tap || { sent: [], recv: [] }
async function hardKill(h) {   // TerminateProcess: no exit handlers run (like the tray's kill)
  const pid = h.transport.pid
  try { process.kill(pid, 'SIGKILL') } catch { }
  for (let i = 0; i < 60; i++) { try { process.kill(pid, 0) } catch { break } await sleep(100) }
  try { await h.transport.close() } catch { }
}
function dashboard(k) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${ADDR[k]}:${Number(P[k]) + 1}`), d = { ws, msgs: [], n: 0 }
    d.act = async q => { const ref = `a${++d.n}`; ws.send(J({ type: 'activity_action', ref, ...q })); const m = await until(async () => d.msgs.find(x => x.type === 'activity_action' && x.ref === ref), x => !!x, 8000, 50); return (m && m.result) || { ok: false, code: 'no-answer' } }
    ws.on('open', () => ws.send(J({ type: 'hello', token: TOKEN, kind: 'dashboard', instance: `dash-${k}` })))
    ws.on('message', raw => { const m = JSON.parse(String(raw)); d.msgs.push(m); if (m.type === 'welcome') resolve(d) })
    ws.on('error', () => resolve(d))
  })
}
// strip what legitimately differs between the owner's own rows and a remote copy (time-relative fields, local-only counts)
const same = n => n && J({ id: n.id, path: n.path, kind: n.kind, type: n.type, key: n.key, scope: n.scope, label: n.label, parent: n.parent, depth: n.depth, plan_item: !!n.plan_item, state: n.state,
  line: n.current && n.current.text, bar: n.display && n.display.bar ? [n.display.bar.done, n.display.bar.total] : null, show: n.display && n.display.show })

const all = []
try {
  // ---- the mesh
  const A = await spawn('A'); all.push(A)
  await sleep(500)
  let B = await spawn('B', { AI_BRIDGE_ACTIVITY_PAGE_ENTRIES: '3' }); all.push(B)
  const C = await spawn('C'); all.push(C)
  const L = await spawn('L'); all.push(L)
  const ids = await Promise.all([A, B, C, L].map(h => call(h, 'my_identity')))
  check('harness: A, B, C (2.0, the switch on) and L (1.7x) are gateways', ids.every(i => i.role === 'gateway'), J(ids.map(i => i.role)))
  const linked = await until(() => call(A, 'list_sessions'), r => ['B', 'C', 'L'].every(k => (r.sessions || []).some(s => String(s.session).startsWith(H[k] + '/'))), 12000)
  check('harness: B, C and the 1.7x L are federated with A (roster)', ['B', 'C', 'L'].every(k => (linked.sessions || []).some(s => String(s.session).startsWith(H[k] + '/'))), J((linked.sessions || []).map(s => s.session)))

  // ---- 1. boards replicate: B's work on A's and C's boards, ids stable across hosts
  await call(B, 'register_self', { name: 'Orch', secret: 'or', project: 'AIMB' })
  const lb = i => call(B, 'log', { as: 'Orch', secret: 'or', ...i })
  const w1 = await lb({ agent: 'w1', label: 'Worker 1', text: '@reading the spec', state: 'running', progress: '1/4 docs' })
  const docs = await lb({ agent: 'w1', key: 'docs', label: 'Docs', text: '@writing', plan: [{ key: 'intro', label: 'Intro' }, { key: 'api', label: 'API' }, { key: 'faq', label: 'FAQ' }] })
  await lb({ agent: 'w1', key: 'intro', state: 'done' })
  const t1 = Date.now()
  const onA = await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Docs/Intro') && nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Docs/Intro').state === 'done', 8000, 100)
  const dt = Date.now() - t1
  const sA = sessOf(onA, 'Orch', H.B)
  const own = sessOf(await board(B), 'Orch', H.B)
  check('replicate: B\'s session is on A\'s board within ~3 s, tagged with B\'s host and remote:true', w1.ok && docs.ok && !!sA && sA.remote === true && dt < 3500, `${dt}ms ${J(sA && sA.nodes.map(n => n.path))}`)
  check('ids: every node of B\'s session has the SAME id, path, kind, type, key, label, parent, state, line and bar on A as on B (its owner)', !!own && own.nodes.length === sA.nodes.length && own.nodes.every(n => same(n) === same(sA.nodes.find(x => x.id === n.id))),
    J(own && own.nodes.filter(n => same(n) !== same(sA.nodes.find(x => x.id === n.id))).map(n => [same(n), same(sA.nodes.find(x => x.id === n.id))])))
  check('ids: the node ids are the owner\'s 16-char ids (w1 = the log result\'s node.id); the root\'s id is the session\'s root_id', nodeAt(sA, 'Worker 1')?.id === w1.node?.id && /^[a-z2-7]{16}$/.test(w1.node?.id || '') && nodeAt(sA, '')?.id === sA.root_id && sA.root_id === own.root_id, J([w1.node, sA.root_id]))
  check('replicate: the plan travels — 3 items, the plan bar "1 of 3" on A, items never stale', nodeAt(sA, 'Worker 1/Docs')?.display?.bar?.done === 1 && nodeAt(sA, 'Worker 1/Docs')?.display?.bar?.total === 3 && ['Intro', 'API', 'FAQ'].every(l => nodeAt(sA, `Worker 1/Docs/${l}`)?.plan_item === true), J(nodeAt(sA, 'Worker 1/Docs')))
  const onC = await until(() => board(C), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Docs/Intro'), 8000)
  check('replicate: a THIRD 2.0 host (C) holds B\'s board too, same ids', !!nodeAt(sessOf(onC, 'Orch', H.B), 'Worker 1') && nodeAt(sessOf(onC, 'Orch', H.B), 'Worker 1').id === w1.node?.id, J((sessOf(onC, 'Orch', H.B) || {}).nodes?.map(n => n.path)))
  // both ways: A's work on B's board
  await call(A, 'register_self', { name: 'Lead', secret: 'ld', project: 'AIMB' })
  const la = i => call(A, 'log', { as: 'Lead', secret: 'ld', ...i })
  const lead = await la({ agent: 'planner', label: 'Planner', text: '@planning the release', state: 'running' })
  const onB = await until(() => board(B), b => !!nodeAt(sessOf(b, 'Lead', H.A), 'Planner'), 8000)
  check('replicate: both ways — A\'s agent on B\'s board, tagged with A, its id', nodeAt(sessOf(onB, 'Lead', H.A), 'Planner')?.id === lead.node?.id && sessOf(onB, 'Lead', H.A)?.host === H.A, J(sessOf(onB, 'Lead', H.A)))
  const hA = await call(A, 'activity', { session: '-none-' })
  check('board head: remote_hosts lists B and C (linked), never the 1.7x L', ['B', 'C'].every(k => (hA.remote_hosts || []).some(x => x.host === H[k] && x.linked === true)) && !(hA.remote_hosts || []).some(x => x.host === H.L), J(hA.remote_hosts))
  const hostB = await board(A, { host: H.B })
  check('board: host narrows to one host (A\'s read of host B = B\'s sessions only)', hostB.length >= 1 && hostB.every(s => s.host === H.B), J(hostB.map(s => [s.session, s.host])))

  // ---- 2. a rename / a move = ONE changed unit; a merge = the merged node's removal (+ its new parent)
  await sleep(1200)
  const sentUnits = async t0 => (await tap(B)).sent.filter(x => x.peer === H.A && x.ts >= t0 && x.kind === 'delta')
  let t2 = Date.now()
  const rn = await lb({ agent: 'w1', key: 'docs', rename: 'Documentation' })
  await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Documentation/Intro'), 6000)
  let d2 = await sentUnits(t2)
  check('rename: B → A as ONE delta carrying ONE unit (the renamed node, by id) — its children\'s paths change on A without being sent', rn.ok && d2.length === 1 && d2[0].units.length === 1 && d2[0].units[0].id === docs.node?.id && d2[0].units[0].label === 'Documentation', J(d2))
  const sA2 = sessOf(await board(A), 'Orch', H.B)
  check('rename: on A the subtree follows (Worker 1/Documentation/API …), ids unchanged', nodeAt(sA2, 'Worker 1/Documentation/API')?.id === nodeAt(sA, 'Worker 1/Docs/API')?.id, J(sA2.nodes.map(n => n.path)))
  await sleep(1200)
  const notes = await lb({ agent: 'w1', key: 'notes', label: 'Notes', text: '@a note' })
  await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Notes'), 6000)
  await sleep(1200)
  t2 = Date.now()
  const mv = await lb({ agent: 'w1', key: 'notes', move: 'docs' })
  await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Documentation/Notes'), 6000)
  d2 = await sentUnits(t2)
  check('move: B → A as ONE delta whose units are the moved node alone (its new parent id; no descendant, no path)', mv.ok && d2.length >= 1 && d2.every(f => f.units.every(u => u.id === notes.node?.id)) && d2[0].units.length === 1, J(d2))
  await sleep(1200)
  const ra = await lb({ agent: 'w1', key: 'ref-a', label: 'Ref A', text: 'a reference' })
  const rbb = await lb({ agent: 'w1', key: 'ref-b', label: 'Ref B', text: 'another' })
  await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Ref B'), 6000)
  await sleep(1200)
  t2 = Date.now()
  const mg = await lb({ agent: 'w1', key: 'ref-a', merge: 'ref-b' })
  const bMg = await until(() => board(A), b => !nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Ref A'), 6000)
  d2 = await sentUnits(t2)
  check('merge: B → A as the merged node\'s REMOVAL (by id) + at most its new parent\'s unit; A no longer shows it', mg.ok && ra.ok && rbb.ok && d2.some(f => f.removed.some(r => r.id === ra.node?.id)) && d2.every(f => f.units.every(u => u.id === rbb.node?.id))
    && !sessOf(bMg, 'Orch', H.B).nodes.some(n => n.id === ra.node?.id), J([mg.code, d2, sessOf(bMg, 'Orch', H.B).nodes.map(n => n.path)]))

  // ---- 3. remote log pages, both ways — by id, paged by the OWNER (3 per page on B) through its index files
  const pageIds = []
  for (let i = 1; i <= 7; i++) pageIds.push((await lb({ agent: 'pager', label: 'Pager', text: `page entry ${i}` })).id)
  const pagerOnA = await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Pager'), 6000)
  const pagerId = nodeAt(sessOf(pagerOnA, 'Orch', H.B), 'Pager')?.id
  const pages = []
  let cursor = null
  for (let k = 0; k < 5; k++) {
    const r = await call(A, 'activity', { log: { session: 'Orch', id: pagerId, own: true, limit: 50, ...(cursor ? { cursor } : {}) } })
    pages.push(r); cursor = r.log?.next_cursor
    if (!cursor) break
  }
  const got = pages.flatMap(p => (p.log?.entries || []).map(e => e.id))
  check('remote log: A pages B\'s node BY ID — served by its owner (from_host B, 3 per page), newest first, chained by next_cursor', pages.length >= 3 && pages.every(p => p.ok && p.from_host === H.B && p.log?.host === H.B) && pages[0].log.entries.length === 3
    && J(got.filter(id => pageIds.includes(id))) === J([...pageIds].reverse()) && /^f2\./.test(pages[0].log.next_cursor || ''), J(pages.map(p => [p.ok, p.code, p.log?.entries?.length, p.log?.next_cursor])))
  check('remote log: entries carry the node id and `at`, no details / data', pages[0].log?.entries?.[0]?.node_id === pagerId && typeof pages[0].log.entries[0].at === 'string' && !('details' in pages[0].log.entries[0]), J(pages[0].log?.entries?.[0]))
  const back = await call(B, 'activity', { log: { session: 'Lead', id: lead.node?.id } })
  check('remote log: both ways — B pages A\'s agent by id (from_host A)', back.ok && back.from_host === H.A && (back.log?.entries || []).some(e => e.text === 'planning the release'), J([back.code, back.log?.entries]))
  // "show removed" across hosts: a transient bucket that vanished on B
  await lb({ agent: 'w1', key: 'job', label: 'Job', text: '@queued', move_to: '/Queue' })
  await lb({ agent: 'w1', key: 'job', text: '@done', state: 'done', move_to: '/Finished' })
  await sleep(1100)
  const rootLog = await call(A, 'activity', { log: { session: 'Orch', host: H.B, limit: 50 } })
  const rootRem = await call(A, 'activity', { log: { session: 'Orch', host: H.B, limit: 50, removed: true } })
  check('remote log: "show removed" — the vanished bucket\'s entries only with removed:true, marked removed (the owner\'s ghost table)', rootLog.ok && rootRem.ok && !(rootLog.log?.entries || []).some(e => e.path === 'Queue')
    && (rootRem.log?.entries || []).some(e => e.path === 'Queue' && e.removed === true), J([(rootLog.log?.entries || []).map(e => e.path), (rootRem.log?.entries || []).map(e => [e.path, e.removed])]))
  const det = await lb({ agent: 'pager', text: 'with attachments', details: 'PAGER-DETAILS', data: { rows: 42 } })
  const cur = await lb({ agent: 'pager', text: '@current line', details: 'CURRENT-DETAILS' })
  await until(() => board(A), b => nodeAt(sessOf(b, 'Orch', H.B), 'Pager')?.current?.text === 'current line', 6000)
  const bd = await board(A)
  check('gossip never carries details / data — the remote line has has_details only', !J(bd).includes('CURRENT-DETAILS') && nodeAt(sessOf(bd, 'Orch', H.B), 'Pager')?.current?.has_details === true, J(nodeAt(sessOf(bd, 'Orch', H.B), 'Pager')?.current))
  const e1 = await call(A, 'activity', { entry: { id: det.id, host: H.B } })
  const e2 = await call(A, 'activity', { entry: { id: cur.id } })
  check('remote entry: entry:{id, host} fetches a logged entry\'s details + data from its owner; a remote CURRENT line by id alone', e1.ok && e1.from_host === H.B && e1.entry?.details === 'PAGER-DETAILS' && e1.entry?.data?.rows === 42
    && e2.ok && e2.from_host === H.B && e2.entry?.details === 'CURRENT-DETAILS', J([e1, e2]))

  // ---- 4. dashboard actions on a REMOTE node, by id (A's dashboard → B's owner)
  const dash = await dashboard('A')
  const sB = sessOf(await board(A), 'Orch', H.B)
  const api = nodeAt(sB, 'Worker 1/Documentation/API'), faq = nodeAt(sB, 'Worker 1/Documentation/FAQ'), docN = nodeAt(sB, 'Worker 1/Documentation'), w1N = nodeAt(sB, 'Worker 1')
  const who = { host: H.B, session: 'Orch', project: 'AIMB', user: 'robin' }
  const sk = await dash.act({ ...who, id: api.id, action: 'skip' })
  check('action: skip on B\'s plan item from A\'s dashboard → applied by its OWNER (host B), by id', sk.ok === true && sk.host === H.B && sk.action === 'skip', J(sk))
  const ownB = sessOf(await board(B), 'Orch', H.B)
  check('action: B\'s own board has it skipped (attributed to the dashboard of A); A sees it back through gossip', nodeAt(ownB, 'Worker 1/Documentation/API')?.state === 'skipped'
    && (await until(() => board(A), b => nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Documentation/API')?.state === 'skipped', 5000)).length > 0, J(nodeAt(ownB, 'Worker 1/Documentation/API')))
  await sleep(300)
  const rn2 = await dash.act({ ...who, id: faq.id, action: 'rename', args: { label: 'Questions' } })
  check('action: rename on a remote node (args.label) → ok, the new label on both boards', rn2.ok === true && rn2.host === H.B && !!nodeAt(sessOf(await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Documentation/Questions'), 5000), 'Orch', H.B), 'Worker 1/Documentation/Questions'), J(rn2))
  await sleep(300)
  const mvd = await dash.act({ ...who, id: nodeAt(sB, 'Worker 1/Ref B').id, action: 'move', args: { to_id: docN.id } })
  check('action: move on a remote node (args.to_id) → ok; on A it now sits under Documentation', mvd.ok === true && !!nodeAt(sessOf(await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Documentation/Ref B'), 5000), 'Orch', H.B), 'Worker 1/Documentation/Ref B'), J(mvd))
  // the clash dialog's answer, across hosts: Notes under Worker 1 again, a second "Notes" there, then a move onto it
  await lb({ agent: 'w1', key: 'notes2', label: 'Notes', text: 'a second notes' })
  const b4 = await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Notes'), 5000)
  const notesDoc = nodeAt(sessOf(b4, 'Orch', H.B), 'Worker 1/Documentation/Notes')
  await sleep(300)
  const clash = await dash.act({ ...who, id: notesDoc.id, action: 'move', args: { to_id: w1N.id } })
  check('clash: a remote move onto a same-label sibling, unanswered → duplicate-label from the owner, with the dialog\'s list', clash.ok === false && clash.code === 'duplicate-label' && clash.host === H.B && Array.isArray(clash.clashes) && clash.clashes.length >= 1, J(clash))
  await sleep(300)
  const answered = await dash.act({ ...who, id: notesDoc.id, action: 'move', args: { to_id: w1N.id, label: 'Notes (old)' } })
  check('clash: the same move answered with a different label → applied by the owner as one change', answered.ok === true && !!nodeAt(sessOf(await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Notes (old)'), 5000), 'Orch', H.B), 'Worker 1/Notes (old)'), J(answered))
  await sleep(300)
  const sB5 = sessOf(await board(A), 'Orch', H.B)
  const mgd = await dash.act({ ...who, id: nodeAt(sB5, 'Worker 1/Notes (old)').id, action: 'merge', args: { into_id: nodeAt(sB5, 'Worker 1/Notes').id } })
  check('action: merge on a remote node (args.into_id) → ok; the merged node leaves A\'s board', mgd.ok === true && !nodeAt(sessOf(await until(() => board(A), b => !nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/Notes (old)'), 5000), 'Orch', H.B), 'Worker 1/Notes (old)'), J([mgd, (sessOf(await board(A), 'Orch', H.B) || {}).nodes?.map(n => n.path)]))
  const bad = await dash.act({ ...who, id: 'not-an-id', action: 'skip' })
  check('action: a bad id is refused by the owner (bad-id), nothing applied', bad.ok === false && bad.code === 'bad-id', J(bad))

  // ---- 5. a HOST RESTART: B killed → gone on A, owner-unreachable; B back → same ids, gone cleared, catch-up both ways
  const nodesBefore = sessOf(await board(A), 'Orch', H.B).nodes, idsBefore = nodesBefore.map(n => n.id).sort()
  await hardKill(B); all.splice(all.indexOf(B), 1)
  const bDown = await until(() => board(A), b => nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1')?.state === 'gone', 8000)
  check('restart: B down → its agents show GONE on A (last lines kept)', nodeAt(sessOf(bDown, 'Orch', H.B), 'Worker 1')?.state === 'gone' && nodeAt(sessOf(bDown, 'Orch', H.B), 'Worker 1')?.current?.text === 'reading the spec', J(nodeAt(sessOf(bDown, 'Orch', H.B), 'Worker 1')))
  const ou = await call(A, 'activity', { log: { session: 'Orch', id: pagerId } })
  check('restart: a page of B\'s node while B is down → owner-unreachable (with the host)', ou.ok === false && ou.code === 'owner-unreachable' && ou.host === H.B, J(ou))
  const meanwhile = await la({ agent: 'planner', key: 'while', label: 'While B was down', text: '@logged on A meanwhile' })
  B = await spawn('B', { AI_BRIDGE_ACTIVITY_PAGE_ENTRIES: '3' }); all.push(B)
  const back5 = await until(() => board(A), b => nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1')?.state === 'running', 15000, 200)
  const idsAfter = sessOf(back5, 'Orch', H.B)?.nodes.map(n => n.id).sort()
  check('restart: B back (replayed from its files) → its fresh full slice clears gone on A, the SAME node ids', nodeAt(sessOf(back5, 'Orch', H.B), 'Worker 1')?.state === 'running' && J(idsAfter) === J(idsBefore), J([idsBefore.length, idsAfter && idsAfter.length, nodesBefore.map(n => n.path), sessOf(back5, 'Orch', H.B)?.nodes.map(n => n.path), sessOf(await board(B), 'Orch', H.B)?.nodes.map(n => n.path)]))
  const catchB = await until(() => board(B), b => !!nodeAt(sessOf(b, 'Lead', H.A), 'Planner/While B was down'), 10000)
  check('catch-up: B, restarted, holds what A logged while it was down (A\'s full slice on the new link)', nodeAt(sessOf(catchB, 'Lead', H.A), 'Planner/While B was down')?.id === meanwhile.node?.id, J((sessOf(catchB, 'Lead', H.A) || {}).nodes?.map(n => n.path)))
  await call(B, 'register_self', { name: 'Orch', secret: 'or', project: 'AIMB' })   // the new process: the session registers again
  const after = await lb({ agent: 'w1', key: 'after', label: 'After restart', text: '@back' })
  const catchA = await until(() => board(A), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/After restart'), 6000)
  const catchC = await until(() => board(C), b => !!nodeAt(sessOf(b, 'Orch', H.B), 'Worker 1/After restart'), 6000)
  check('catch-up: B\'s work after its restart reaches A and C as deltas again (the same agent id)', after.ok && nodeAt(sessOf(catchA, 'Orch', H.B), 'Worker 1/After restart')?.id === after.node?.id && nodeAt(sessOf(catchC, 'Orch', H.B), 'Worker 1')?.id === w1.node?.id
    && !!nodeAt(sessOf(catchC, 'Orch', H.B), 'Worker 1/After restart'), J([after.code, (sessOf(catchA, 'Orch', H.B) || {}).nodes?.map(n => n.path), (sessOf(catchC, 'Orch', H.B) || {}).nodes?.map(n => n.path)]))
  const pg5 = await call(A, 'activity', { log: { session: 'Orch', id: pagerId, own: true, limit: 50 } })
  check('restart: B\'s pages are served again after its restart (from its files)', pg5.ok && pg5.from_host === H.B && (pg5.log?.entries || []).length === 3, J([pg5.code, pg5.log?.entries?.length]))

  // ---- 6. a 1.7x PEER (L): nothing shared either way (§6.2), the message mesh still federated
  await call(L, 'register_self', { name: 'Old', secret: 'ol', project: 'AIMB' })
  const lo = await call(L, 'log', { as: 'Old', secret: 'ol', agent: 'old-agent', text: '@~root on the 1.7x host' })
  await sleep(2500)
  const bA6 = await board(A), bL6 = (await call(L, 'activity')).sessions || [], tA6 = await tap(A)
  check('1.7x peer: L\'s board works (its 1.7x log) but its sessions never reach a 2.0 board', lo.ok && !!bL6.find(s => s.session === 'Old') && !bA6.some(s => s.host === H.L || s.session === 'Old'), J([lo.code, bA6.map(s => [s.session, s.host])]))
  check('1.7x peer: no 2.0 session reaches L\'s 1.7x board either', !bL6.some(s => ['Orch', 'Lead'].includes(s.session)), J(bL6.map(s => [s.session, s.host])))
  check('1.7x peer: A never sends L an activity frame, takes none from it, and tapped the format mismatch once (activity_gossip:5)', !tA6.sent.some(x => x.peer === H.L) && !tA6.recv.some(x => x.peer === H.L && x.kind !== 'format-mismatch')
    && tA6.recv.filter(x => x.peer === H.L && x.kind === 'format-mismatch').length >= 1 && tA6.recv.find(x => x.peer === H.L && x.kind === 'format-mismatch').v === 5, J(tA6.recv.filter(x => x.peer === H.L)))
  check('1.7x peer: A logs the mismatch (2.0 shares activity only with 2.0 hosts)', A.err.includes(`activity: ${H.L} declares activity_gossip:5 — a 2.0 gateway shares activity only with 2.0 hosts`), A.err.split('\n').filter(l => l.includes(H.L)).slice(0, 3).join(' | '))
  const lr = await call(A, 'activity', { log: { session: 'Old' } })
  const la6 = await dash.act({ host: H.L, session: 'Old', project: 'AIMB', user: 'robin', id: 'aaaaaaaaaaaaaaaa', action: 'skip' })
  const lh = await board(A, { host: H.L })
  check('1.7x peer: a 2.0 read / action naming it → unknown-session / unknown-host / an empty board', lr.ok === false && lr.code === 'unknown-session' && la6.ok === false && la6.code === 'unknown-host' && lh.length === 0, J([lr.code, la6.code, lh.length]))
  const fed = await call(A, 'list_sessions')
  check('1.7x peer: still federated on the message mesh (roster)', (fed.sessions || []).some(s => String(s.session).startsWith(H.L + '/')))
  dash.ws.close()
} catch (e) { fail++; console.log('FAIL crashed:', (e && e.stack) || e) }

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch { } }
await sleep(500)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
