// #85 (v1.71.0) → #88 (2.0, ported in build step 9) — live: QUESTIONS answered from the dashboard, on the 2.0 board (node ids).
// A session (the `log` tool's ask) or a script (aimb-log --ask) posts a question — a node of TYPE question whose line is the
// question (state blocked, current.question { status asked, choices, free, … }): a new `?N` child in the asker's scope, or the
// addressed context itself when the call creates a line-less one. The dashboard's `answer` {choice?, text?} — an
// `activity_action` BY NODE ID — is applied by the node's OWNER (forwarded over the hub link when it is another host's), logged
// + attributed, and (1) releases a script waiting on it (aimb-log --ask … --wait / --wait-answer --key ?N: one JSON line, exit
// 0 answered · 10 still open · 11 expired · 12 withdrawn · 13 gone; the logger WS `wait_answer` by node_id underneath; a
// dropped link re-dialled) and (2) reaches the session at once as `activity_answer` (an agent's question: its session,
// body.agent names it) — the answer in the encrypted body, never in the public subject. `expires` closes it as expired (the
// bridge's expiry timer); the asker (state withdrawn / abandoned) or the dashboard (`withdraw`) withdraws it.
// Retired in step 9 (1.7x-only, gone in 2.0): the `activity_ask` feature flag (the board head's remote_hosts[].ask, an older
// owner refused `owner-unsupported`, AI_BRIDGE_TEST_NO_ACTIVITY_ASK), the dashboard's board pushes carrying the question (step
// 10 rebuilds them), the "looks like status text" refusal of an `@~` choice, and the AIMB_TEST_OLD_BRIDGE mixed-version checks
// (2.0 never meets 1.7x). Temp persist dirs + a temp AI_BRIDGE_CONFIG (never src/config.json); a test-set token that is never
// printed. Loopback "hosts":
//   B  127.0.0.1 "NOT-B"  dashboard dashB; sessions Lead + Orch (registered), the script sessions Scripty / Waiter2
//   A  127.0.0.2 "NOT-A"  session Remote (registered); scripts waiting on A for answers given on B's dashboard; restarted
//                         while a script waits (the script re-dials)
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawn as spawnProc } from 'node:child_process'
import { WebSocket } from 'ws'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 16100)   // #81: this file's port block (16100 = its first port name)
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const LOGGER = path.join(SRCDIR, 'tools', 'aimb-log.mjs')
const TOKEN = 'ask85-' + crypto.randomBytes(9).toString('hex')
const B_PORT = String(tp(16100)), A_PORT = String(tp(16102))
const HB = 'NOT-B', HA = 'NOT-A'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-85-'))
const dirs = Object.fromEntries(['A', 'B'].map(k => [k, fs.mkdtempSync(path.join(tmp, `p${k}-`))]))
const cfgFile = path.join(tmp, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { notice_batch_sec: 2 } }))   // a batch window: answers must NOT wait for it
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const seen = []   // every raw response / frame / script output: none may carry the token
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).split(TOKEN).join('<TOKEN>'))) }
const J = JSON.stringify

const all = []
function spawn(name, bind, port, host, extra = {}, script = path.isAbsolute(BRIDGE) ? BRIDGE : SRCDIR + BRIDGE) {
  const env = { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
    AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
    AI_BRIDGE_STABLE_IDS: '1', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', AI_BRIDGE_TEST_GOSSIP: '', TEMP: tmp, TMP: tmp, ...extra }
  delete env.AI_BRIDGE_TRAY
  const transport = new StdioClientTransport({ command: 'node', args: [script], cwd: path.dirname(script), env, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => { const h = { c, transport, name }; all.push(h); return h })
}
async function stop(h) { try { await h.transport.close() } catch { } all.splice(all.indexOf(h), 1); await sleep(300) }
const fileOf = d => ({ AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: d })
const call = async (b, n, a = {}) => { try { const t = (await b.c.callTool({ name: n, arguments: a })).content[0].text; seen.push(t); return JSON.parse(t) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 150) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
const board = async (h, q = {}) => (await call(h, 'activity', q)).sessions || []
/** a node row by its 2.0 path (labels, no @; '' = the session root), on the session's board (host: a remote copy) */
const nodeOf = (b, name, p, host) => { const s = b.find(x => String(x.session).toLowerCase() === name.toLowerCase() && (!host || x.host === host)); return !s ? undefined : (s.nodes || []).find(x => x.path === p) }
const logOf = async (h, q) => ((await call(h, 'activity', { log: { limit: 50, ...q } })).log || { entries: [] })
const inbox = async (h, name, secret, verb) => ((await call(h, 'inbox', { for: name, secret, cursor: 0 })).messages || []).filter(m => !verb || m.verb === verb)
const bodyOf = m => { try { return JSON.parse(m.body) } catch { return {} } }
const byIs = (b, host) => !!b && typeof b === 'object' && b.user === 'robin' && b.host === host
/** aimb-log as a child process → Promise<{ code, out (the JSON line), stdout, stderr, ms }> (args after the script) */
function runLog(args, wsPort = Number(B_PORT) + 1, env = {}, host = '127.0.0.1') {
  return new Promise(resolve => {
    const t0 = Date.now(), p = spawnProc(process.execPath, [LOGGER, '--url', `ws://${host}:${wsPort}`, ...args], { env: { ...process.env, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_USER: 'robin', ...env } })
    let so = '', se = ''
    p.stdout.on('data', d => { so += d }); p.stderr.on('data', d => { se += d })
    p.on('exit', code => { seen.push(so, se); let out = null; try { out = JSON.parse(so.trim().split('\n').pop()) } catch { } resolve({ code, out, stdout: so, stderr: se, ms: Date.now() - t0 }) })
  })
}
function wsClient(port, kind, extra = {}) {   // a dashboard (or a logger: extra.ident) on a gateway's WS port
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${extra.host || '127.0.0.1'}:${port}`), C = { ws, msgs: [], n: 0, welcome: null }
    C.send = o => ws.send(J(o))
    C.action = async (msg, ms = 10000) => { const ref = `r${++C.n}`; C.send({ type: 'activity_action', ref, ...msg }); const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = C.msgs.find(x => x.type === 'activity_action' && x.ref === ref); if (m) return m.result; await sleep(30) } return { ok: false, code: 'no-answer' } }
    C.wait = async (msg, ms = 10000) => { const ref = `w${++C.n}`; C.send({ type: 'wait_answer', ref, ...msg }); const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = C.msgs.find(x => x.type === 'answer' && x.ref === ref); if (m) return m.result; await sleep(30) } return { ok: false, code: 'no-answer' } }
    C.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => ws.send(J({ type: 'hello', kind, token: TOKEN, instance: `t-${kind}-${port}`, ...(extra.ident ? { ident: extra.ident } : {}) })))
    ws.on('message', raw => { const s = String(raw); seen.push(s); const m = JSON.parse(s); C.msgs.push(m); if (m.type === 'welcome' || m.type === 'error') { C.welcome = m; resolve(C) } })
    ws.on('close', () => resolve(C))
    ws.on('error', () => resolve(C))
  })
}

try {
  // ================================================================= the mesh: B and A (2.0 gateways) linked
  const B = await spawn('HubB', '127.0.0.1', B_PORT, HB, { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT}` })
  await sleep(600)
  let A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` })
  const ids = await Promise.all([A, B].map(h => call(h, 'my_identity')))
  const heads = await Promise.all([A, B].map(h => call(h, 'activity', { session: '-none-' })))
  check('harness: A and B are gateways holding the 2.0 board (head format 6)', ids.every(i => i.role === 'gateway') && heads.every(h => h.head ? h.head.format === 6 : h.format === 6), J([ids.map(i => [i.role, i.bridge_version]), heads.map(h => (h.head || h).format)]))
  const linked = await until(() => call(B, 'list_sessions'), r => (r.sessions || []).some(s => String(s.session).startsWith(HA + '/')), 12000)
  check('harness: A is linked to B', (linked.sessions || []).some(s => String(s.session).startsWith(HA + '/')))
  const dashB = await wsClient(Number(B_PORT) + 1, 'dashboard')
  const Q = (session, id, action, args = {}, host = HB) => ({ host, session, project: 'ASKS', user: 'robin', id, action, args })

  // ================================================================= the TOOL form: Lead asks (registered), returns at once
  await call(B, 'register_self', { name: 'Lead', secret: 'l', project: 'ASKS' })
  const t0 = Date.now()
  const la = await call(B, 'log', { as: 'Lead', secret: 'l', agent: 'lead-agent', label: 'lead-agent', ask: 'Postgres or SQLite for the cache?', choices: ['Postgres', 'SQLite'], details: 'the cache is small' })
  const QID = la.node?.id
  check('tool: log {agent, ask, choices} returns AT ONCE with the question node (a new child ?1 of the agent, type question: node.key "?1", path lead-agent/?1, a 16-char id) and question { status asked, choices, free false }',
    la.ok && la.node?.key === '?1' && la.node.path === 'lead-agent/?1' && la.node.type === 'question' && /^[a-z2-7]{16}$/.test(QID || '') && la.state === 'blocked' && la.question?.status === 'asked' && J(la.question.choices) === J(['Postgres', 'SQLite']) && la.question.free === false && Date.now() - t0 < 3000, J(la))
  check('tool (2.0): a question that repeats its choices succeeds with warning choices-in-question (§5.8)', (la.warnings || []).some(w => (w.code || w) === 'choices-in-question'), J(la.warnings))
  const lq = nodeOf(await board(B), 'Lead', 'lead-agent/?1')
  check('board: the question node — a context of type question whose line is the question (state blocked) with current.question (the activity tool shows it); same id', lq?.id === QID && lq.kind === 'context' && lq.type === 'question' && lq.current?.text === 'Postgres or SQLite for the cache?' && lq.current?.question?.status === 'asked' && lq.state === 'blocked', J(lq))
  const AGENT_ID = nodeOf(await board(B), 'Lead', 'lead-agent')?.id

  // refusals over the wire (by id)
  const r1 = await dashB.action(Q('Lead', QID, 'answer', { choice: 'MySQL' }))
  const r2 = await dashB.action(Q('Lead', QID, 'edit_text', { text: 'nope' }))
  const r3 = await dashB.action(Q('Lead', QID, 'answer', { choice: 'SQLite', text: 'and why' }))
  const r4 = await dashB.action(Q('Lead', AGENT_ID, 'answer', { choice: 'SQLite' }))
  const r5 = await dashB.action(Q('Lead', 'aaaaaaaaaaaaaaaa', 'answer', { choice: 'SQLite' }))
  check('refusals: a choice it doesn\'t have → bad-choice; edit_text on a question → question-node; free text on a choices-only question → bad-args; a non-question → not-a-question; an id not on the board → unknown-node',
    r1.code === 'bad-choice' && r2.code === 'question-node' && r3.code === 'bad-args' && r4.code === 'not-a-question' && r5.code === 'unknown-node', J([r1.code, r2.code, r3.code, r4.code, r5.code]))

  // ================================================================= ANSWER from the dashboard → the session hears it at once (activity_answer)
  const ta = Date.now()
  const an = await dashB.action(Q('Lead', QID, 'answer', { choice: 'sqlite' }))
  const ni = await until(() => inbox(B, 'Lead', 'l', 'activity_answer'), ms => ms.length >= 1, 4000, 50)
  const dt = Date.now() - ta, nb = bodyOf(ni[0] || {})
  check('answer: applied by the owner (B), delivered LIVE at once (not after the 2 s batch window) — result delivery "live", the question now answered', an.ok && an.host === HB && an.action === 'answer' && an.delivered === true && an.delivery === 'live' && an.question?.status === 'answered' && ni.length === 1 && dt < 1800, J([an, dt]))
  check('notice: the PUBLIC subject = who + the path + the question\'s first words — "robin answered lead-agent/?1: Postgres or SQLite for the…" — never the answer', ni[0]?.subject === 'robin answered lead-agent/?1: Postgres or SQLite for the cache?' && !/SQLite/.test((ni[0]?.subject || '').replace('Postgres or SQLite', '')), ni[0]?.subject)
  check('notice: the body (encrypted) has { action answer, status answered, answer {choice "SQLite"}, question, choices, agent (the asking agent: id + path lead-agent), path, node_id, key ?1, host NOT-B, by {robin, NOT-B}, entry_id, session, project }',
    nb.action === 'answer' && nb.status === 'answered' && J(nb.answer) === J({ choice: 'SQLite' }) && nb.question === 'Postgres or SQLite for the cache?' && J(nb.choices) === J(['Postgres', 'SQLite']) && nb.agent?.path === 'lead-agent' && nb.agent?.id === AGENT_ID
    && nb.path === 'lead-agent/?1' && nb.node_id === QID && nb.key === '?1' && nb.host === HB && byIs(nb.by, HB) && nb.session === 'Lead' && nb.project === 'ASKS' && !!nb.entry_id, J(nb))
  check('notice: sent by the owning gateway as a system message (from = B\'s bridge)', String(ni[0]?.from?.session || ni[0]?.from || '').startsWith(HB + '/'), J(ni[0]?.from))
  const la2 = nodeOf(await board(B), 'Lead', 'lead-agent/?1'), le = (await logOf(B, { session: 'Lead', id: QID, own: true })).entries[0] || {}
  check('board + log: the line is DONE with question {status answered, answer, by}; the entry "answered by robin via dashboard (NOT-B): \\"SQLite\\"" (an `answer` entry, act answer; #90: the answer quoted)', la2?.state === 'done' && la2.current.text === 'Postgres or SQLite for the cache?' && J(la2.current.question.answer) === J({ choice: 'SQLite' }) && byIs(la2.current.question.by, HB)
    && le.text === 'answered by robin via dashboard (NOT-B): "SQLite"' && le.act === 'answer' && le.type === 'answer' && le.id === nb.entry_id, J([la2?.current, le]))
  const again = await dashB.action(Q('Lead', QID, 'answer', { choice: 'Postgres' }))
  check('a closed question: answering again → question-closed', again.code === 'question-closed', J(again))

  // ================================================================= the SCRIPT: --ask … --wait (a script-only session) — released by the answer
  const wP = runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--label', 'worker', '--ask', 'Ship on Friday?', '--choice', 'Yes', '--choice', 'No', '--free', '--wait', '30s'])
  const sq = await until(async () => nodeOf(await board(B), 'Scripty', 'worker/?1'), x => !!x, 6000)
  check('script --ask: the question is on the board (worker/?1, free text allowed beside the choices) while the script waits', sq?.type === 'question' && sq.current?.question?.status === 'asked' && sq.current.question.free === true && J(sq.current.question.choices) === J(['Yes', 'No']), J(sq))
  await sleep(400)
  const sa = await dashB.action(Q('Scripty', sq?.id, 'answer', { choice: 'Yes', text: 'after the review' }))
  const w1 = await wP
  check('script --wait: released by the answer — exit 0, ONE JSON line { ok, outcome answered, answer {choice, text}, by, question, path, id, key ?1, asked {id (the entry), node {id, path}} }',
    w1.code === 0 && w1.out?.ok === true && w1.out.outcome === 'answered' && J(w1.out.answer) === J({ choice: 'Yes', text: 'after the review' }) && byIs(w1.out.by, HB) && w1.out.question === 'Ship on Friday?' && w1.out.path === 'worker/?1' && w1.out.id === sq?.id && w1.out.key === '?1'
    && w1.out.asked?.node?.id === sq?.id && w1.out.asked.node.path === 'worker/?1' && !!w1.out.asked.id && w1.stdout.trim().split('\n').length === 1, J([w1.code, w1.out, w1.stderr.slice(0, 300)]))
  check('the dashboard hears it reached the script: released 1, no "not-delivered" warning (a script-only session has no inbox, but its script took the answer)', sa.ok && sa.released === 1 && sa.delivery === 'none' && !(sa.warnings || []).includes('not-delivered'), J(sa))
  const wa = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--agent', 'worker', '--key', '?1', '--wait', '5s'])
  const wb = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--path', 'worker/?1', '--wait', '5s'])
  const wc = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--id', sq?.id || 'x', '--wait', '5s'])
  check('--wait-answer on an already answered question (--agent worker --key ?1, --path worker/?1, --id <node id>): at once, exit 0, the same answer',
    [wa, wb, wc].every(w => w.code === 0 && w.out?.outcome === 'answered' && w.out.answer?.choice === 'Yes' && w.out.id === sq?.id && w.ms < 4000), J([wa, wb, wc].map(w => [w.code, w.out])))

  // ================================================================= an AGENT's question → its SESSION (the orchestrator relays it)
  await call(B, 'register_self', { name: 'Orch', secret: 'o', project: 'ASKS' })
  const nx = await runLog(['--session', 'Orch', '--project', 'ASKS', '--key', 'next', '--label', 'Next', '--text', '@planning'])
  const aw = runLog(['--session', 'Orch', '--project', 'ASKS', '--agent', 'helper-85', '--label', 'helper-85', '--under', 'next', '--ask', 'Which wording for the changelog?', '--wait', '30s'])
  const aq = await until(async () => nodeOf(await board(B), 'Orch', 'Next/helper-85/?1'), x => !!x, 6000)
  check('agent: a subagent\'s script asks under its own node (Next/helper-85/?1; free text only)', nx.code === 0 && aq?.current?.question?.free === true && aq.current.question.choices.length === 0, J([nx.out, aq?.current]))
  const aa = await dashB.action(Q('Orch', aq?.id, 'answer', { text: 'Use "Fixed" and "Added".\nKeep it short.' }))
  const aw1 = await aw
  const oi = await until(() => inbox(B, 'Orch', 'o', 'activity_answer'), ms => ms.length >= 1, 4000, 50), ob = bodyOf(oi[0] || {})
  check('agent: the waiting script gets the free-text answer (newlines kept) AND the session (the orchestrator) gets activity_answer naming the agent (body.agent) — it relays it',
    aa.ok && aa.released === 1 && aa.delivery === 'live' && aw1.code === 0 && aw1.out?.answer?.text === 'Use "Fixed" and "Added".\nKeep it short.' && oi.length === 1 && ob.agent?.path === 'Next/helper-85' && ob.agent?.key === 'helper-85' && ob.answer?.text === 'Use "Fixed" and "Added".\nKeep it short.'
    && oi[0].subject === 'robin answered Next/helper-85/?1: Which wording for the changelog?', J([aa, aw1.code, oi.map(m => m.subject), ob]))

  // ================================================================= ACROSS HOSTS: B's dashboard answers A's questions (forwarded to the owner)
  await call(A, 'register_self', { name: 'Remote', secret: 'r', project: 'ASKS' })
  const ra = await call(A, 'log', { as: 'Remote', secret: 'r', key: 'r', label: 'R', ask: 'Deploy A now?', choices: ['now', 'later'] })
  check('a NEW context addressed by ask becomes the question itself (key r, path R, type question — no ?1 child)', ra.ok && ra.node?.key === 'r' && ra.node.path === 'R' && ra.node.type === 'question' && ra.question?.status === 'asked', J(ra))
  const waP = runLog(['--session', 'Waiter', '--project', 'ASKS', '--agent', 'w', '--label', 'w', '--ask', 'Rebuild the tray on A?', '--choice', 'yes', '--choice', 'no', '--wait', '30s'], Number(A_PORT) + 1, {}, '127.0.0.2')
  const both = await until(async () => { const b = await board(B); return [nodeOf(b, 'Remote', 'R', HA), nodeOf(b, 'Waiter', 'w/?1', HA)] }, x => !!x[0] && !!x[1], 10000)
  check('federated: A\'s questions are on B\'s board (gossip v6: same id, type question, current.question)', both[0]?.id === ra.node?.id && both[0].type === 'question' && both[0].current?.question?.status === 'asked' && both[1]?.current?.question?.status === 'asked', J(both))
  const fa = await dashB.action(Q('Remote', ra.node?.id, 'answer', { choice: 'later' }, HA))
  const ri = await until(() => inbox(A, 'Remote', 'r', 'activity_answer'), ms => ms.length >= 1, 6000, 50), rb = bodyOf(ri[0] || {})
  check('federated B → A: the OWNER (A) applies the answer and tells its session from A\'s gateway (host NOT-A, by {robin, NOT-B})', ra.ok && fa.ok && fa.host === HA && fa.delivery === 'live' && ri.length === 1 && rb.host === HA && byIs(rb.by, HB) && J(rb.answer) === J({ choice: 'later' }) && rb.agent === null
    && String(ri[0]?.from?.session || ri[0]?.from || '').startsWith(HA + '/'), J([fa, rb]))
  const gb = await until(async () => nodeOf(await board(B), 'Remote', 'R', HA), x => x?.current?.question?.status === 'answered', 6000)
  check('federated: gossip carries the answer back — B\'s board shows A\'s question answered (state done)', gb?.current?.question?.status === 'answered' && gb.state === 'done' && J(gb.current.question.answer) === J({ choice: 'later' }), J(gb?.current))
  const fw = await dashB.action(Q('Waiter', both[1]?.id, 'answer', { choice: 'yes' }, HA))
  const wA = await waP
  check('federated --wait: a script waiting on A\'s gateway is released by an answer given on B\'s dashboard (exit 0; the owner says released 1)', fw.ok && fw.released === 1 && wA.code === 0 && wA.out?.answer?.choice === 'yes', J([fw, wA.code, wA.out]))

  // ================================================================= the logger WS wait_answer, BY NODE ID (what the script sends)
  const lg = await wsClient(Number(B_PORT) + 1, 'logger', { ident: { session: 'Scripty', project: 'ASKS', user: 'robin', realm: 'default' } })
  const wq = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'Raw wait?', '--choice', 'a', '--choice', 'b'])
  const wsBad = await lg.wait({ node_id: 'NOT-AN-ID', timeout_ms: 1000 })
  const wsLegacy = await lg.wait({ path: 'worker/@?1', timeout_ms: 1000 })
  const wsNone = await lg.wait({ timeout_ms: 1000 })
  const wsDone = await lg.wait({ node_id: sq?.id, timeout_ms: 1000 })
  const wsP = lg.wait({ node_id: wq.out?.node?.id, timeout_ms: 20000 }, 25000)
  await sleep(500)
  const wsA = await dashB.action(Q('Scripty', wq.out?.node?.id, 'answer', { choice: 'b' }))
  const wsR = await wsP
  check('logger WS wait_answer: by node_id — an answered question at once (waited_ms 0), an open one released by the answer {ok, outcome answered, answer, id, path}; a bad node_id → bad-input, no address → bad-input, a 1.7x "@" path → legacy-form',
    wq.code === 0 && wsDone.ok && wsDone.outcome === 'answered' && wsDone.waited_ms === 0 && wsA.ok && wsA.released === 1 && wsR.ok && wsR.outcome === 'answered' && wsR.answer?.choice === 'b' && wsR.id === wq.out?.node?.id && wsR.path === wq.out?.node?.path
    && wsBad.code === 'bad-input' && wsNone.code === 'bad-input' && wsLegacy.code === 'legacy-form', J([wq.out?.node, wsDone, wsR, wsBad, wsNone, wsLegacy]))
  lg.close()

  // ================================================================= a DROPPED LINK: the gateway restarts while a script waits — it re-dials and waits again
  const rdP = runLog(['--session', 'Waiter', '--project', 'ASKS', '--agent', 'w', '--ask', 'Survive a restart?', '--choice', 'yes', '--choice', 'no', '--wait', '60s'], Number(A_PORT) + 1, {}, '127.0.0.2')
  const rdq = await until(async () => nodeOf(await board(A), 'Waiter', 'w/?2'), x => !!x, 6000)
  await sleep(500)
  await stop(A)
  A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` })
  const back = await until(async () => nodeOf(await board(B), 'Waiter', 'w/?2', HA), x => x?.id === rdq?.id && x.state !== 'gone', 15000, 200)
  await sleep(2500)   // the script's backoff (≤ 5 s) re-dials A and re-sends its wait by node_id
  const rda = await until(() => dashB.action(Q('Waiter', rdq?.id, 'answer', { choice: 'no' }, HA)), r => r.ok || !['owner-unreachable', 'unknown-host', 'unknown-session'].includes(r.code), 10000, 500)
  const rd = await rdP
  check('dropped link: A restarts while a --ask … --wait script waits on it — A\'s replay keeps the question, the script re-dials and waits again by node_id, and an answer from B\'s dashboard releases it (exit 0, released 1)',
    !!rdq && !!back && rda.ok && rda.host === HA && rda.released === 1 && rd.code === 0 && rd.out?.outcome === 'answered' && rd.out.answer?.choice === 'no' && rd.out.id === rdq?.id, J([rda, rd.code, rd.out, rd.stderr.slice(0, 300)]))

  // ================================================================= EXPIRY
  const ex = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'Expire me?', '--expires', '2s', '--wait', '20s'])
  check('expiry: --expires 2s --wait 20s → the bridge closes it as EXPIRED and the script exits 11 (outcome expired, by bridge, no answer)', ex.code === 11 && ex.out?.outcome === 'expired' && ex.out.by === 'bridge' && !ex.out.answer && ex.ms < 9000, J([ex.code, ex.out, ex.ms]))
  const exn = nodeOf(await board(B), 'Scripty', ex.out?.path || 'worker/?3'), exl = (await logOf(B, { session: 'Scripty', id: ex.out?.id || exn?.id, own: true })).entries[0] || {}
  check('expiry: the node is expired (line abandoned), logged by the bridge "expired — nobody answered within 2s" (an `expiry` entry)', exn?.state === 'abandoned' && exn.current.question.status === 'expired' && exl.text === 'expired — nobody answered within 2s' && exl.by === 'bridge' && exl.type === 'expiry', J([exn?.current, exl]))
  const le2 = await call(B, 'log', { as: 'Lead', secret: 'l', agent: 'lead-agent', ask: 'Quick one?', expires: '2s' })
  const lx = await until(() => inbox(B, 'Lead', 'l', 'activity_answer'), ms => ms.some(m => bodyOf(m).status === 'expired'), 8000)
  const lxm = lx.find(m => bodyOf(m).status === 'expired') || {}
  check('expiry: a registered session is told at once — activity_answer, status expired, subject "question expired lead-agent/?2: Quick one?"', le2.ok && le2.node?.path === 'lead-agent/?2' && lxm.subject === 'question expired lead-agent/?2: Quick one?' && bodyOf(lxm).action === 'expire' && bodyOf(lxm).by === 'bridge', J([le2.node, lx.map(m => m.subject)]))

  // ================================================================= WITHDRAW (the asker; the dashboard) + the wait's other outcomes
  const qw = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'Withdraw me?'])
  const qk = qw.out?.node?.key
  const ww = runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--agent', 'worker', '--key', qk || 'x', '--wait', '30s'])
  await sleep(800)
  const wd = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--key', qk || 'x', '--state', 'withdrawn', '--text', 'decided myself'])
  const ww1 = await ww
  check('withdraw (the asker): --agent worker --key ?N --state withdrawn → exit 0 (question withdrawn); a script waiting on it (--wait-answer --key ?N) exits 12 (outcome withdrawn)', qw.code === 0 && /^\?\d+$/.test(qk || '') && wd.code === 0 && wd.out?.question?.status === 'withdrawn' && ww1.code === 12 && ww1.out?.outcome === 'withdrawn', J([qw.out?.node, wd.code, wd.out, ww1.code, ww1.out]))
  const qa2 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'Abandon me?'])
  const wab = runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--id', qa2.out?.node?.id || 'x', '--wait', '30s'])
  await sleep(800)
  const ab = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--key', qa2.out?.node?.key || 'x', '--state', 'abandoned'])
  const wab1 = await wab
  check('withdraw (the asker, §5.8): state abandoned on an OPEN question withdraws it — a script waiting on it exits 12', ab.code === 0 && ab.out?.question?.status === 'withdrawn' && wab1.code === 12 && wab1.out?.outcome === 'withdrawn', J([ab.code, ab.out, wab1.code, wab1.out]))
  const lw = await call(B, 'log', { as: 'Lead', secret: 'l', agent: 'lead-agent', ask: 'Withdrawn by the dashboard?' })
  const dw = await dashB.action(Q('Lead', lw.node?.id, 'withdraw'))
  const lwi = await until(() => inbox(B, 'Lead', 'l', 'activity_answer'), ms => ms.some(m => bodyOf(m).status === 'withdrawn'), 4000, 50)
  check('withdraw (the dashboard): attributed, the session told at once — "robin withdrew lead-agent/?3: Withdrawn by the dashboard?" (status withdrawn)', dw.ok && dw.question?.status === 'withdrawn' && lw.node?.path === 'lead-agent/?3' && lwi.some(m => m.subject === 'robin withdrew lead-agent/?3: Withdrawn by the dashboard?'), J([dw, lwi.map(m => m.subject)]))
  const qt = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'Nobody answers this?'])
  const to = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--agent', 'worker', '--key', qt.out?.node?.key || 'x', '--wait', '2s'])
  check('the wait runs out: exit 10, outcome timeout — the question stays open', to.code === 10 && to.out?.outcome === 'timeout' && to.out.status === 'asked' && to.ms >= 1900 && nodeOf(await board(B), 'Scripty', qt.out?.node?.path)?.current?.question?.status === 'asked', J([to.code, to.out]))
  // gone: the agent holding the question finishes and is dismissed from the dashboard
  const gq = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'temp', '--label', 'temp', '--ask', 'Gone soon?'])
  const gf = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'temp', '--text', '@finished', '--state', 'done'])
  const gw = runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--agent', 'temp', '--key', '?1', '--wait', '30s'])
  await sleep(800)
  const tempId = nodeOf(await board(B), 'Scripty', 'temp')?.id
  const dsm = await dashB.action(Q('Scripty', tempId, 'dismiss'))
  const gw1 = await gw
  check('gone: the agent holding the question is dismissed — a script waiting on it exits 13 (outcome gone)', gq.code === 0 && gf.code === 0 && dsm.ok && gw1.code === 13 && gw1.out?.outcome === 'gone', J([gq.out?.node, gf.out?.state, dsm, gw1.code, gw1.out]))

  // ================================================================= script usage + refusals
  const u1 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--wait', '1m', '--text', 'x'])
  const u2 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'x?', '--text', 'y'])
  const u3 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--path', 'worker'])
  const u4 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'x?', ...Array.from({ length: 9 }, (_, i) => ['--choice', 'c' + i]).flat()])
  const u5 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'x?', '--wait', '25h'])
  const u6 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--path', 'worker/@?1'])
  const c2 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'x?', '--choice', '--wait', '1m'])
  const c3 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'x?', '--choices', 'A', 'B'])
  const c4 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--agent', 'worker', '--ask', 'Order kept?', '--choice', 'B two', '--choice', 'A one'])
  check('--choice (one per flag, like --item): a flag as its value → 64 usage; --choices is unknown (64); two --choice flags keep their order',
    c2.code === 64 && c2.out?.code === 'usage' && /--choice needs a value/.test(c2.out.what || '') && c3.code === 64 && /unknown flag --choices/.test(c3.out?.what || '') && c4.code === 0 && J(c4.out?.question?.choices) === J(['B two', 'A one']), J([c2.out, c3.out, c4.out?.question]))
  check('script usage: --wait without --ask → 64; --ask with --text → 64 bad-ask; 9 choices → 64 bad-choices; --wait 25h → 64; --wait-answer on a non-question → 4 not-a-question; --wait-answer on a 1.7x "@" path → 64 legacy-form',
    u1.code === 64 && u2.code === 64 && u2.out?.code === 'bad-ask' && u4.code === 64 && u4.out?.code === 'bad-choices' && u5.code === 64 && u3.code === 4 && u3.out?.code === 'not-a-question' && u6.code === 64 && u6.out?.code === 'legacy-form', J([u1.code, u2.out, u3.code, u3.out, u4.out, u5.code, u6.code, u6.out]))

  // ================================================================= the session guidance (trust)
  const instr = String(B.c.getInstructions ? B.c.getInstructions() || '' : '')
  const tools = (await B.c.listTools()).tools, logTool = tools.find(t => t.name === 'log') || {}, logDesc = String(logTool.description || '')
  check('trust: the server instructions say an activity_answer is the viewer\'s answer to the session\'s OWN question — it may proceed on it within what its user already approved',
    /activity_answer is the dashboard viewer's answer to a question YOUR session asked/.test(instr) && /you may proceed on it within what your user already approved/.test(instr), instr.slice(0, 200))
  check('trust: so does the log tool\'s description (2.0 wording); its schema has ask / choices / free / expires and state withdrawn', /activity_answer to a question YOUR session asked you may act on within what your user already approved/.test(logDesc)
    && ['ask', 'choices', 'free', 'expires'].every(k => logTool.inputSchema?.properties?.[k]) && (logTool.inputSchema?.properties?.state?.enum || []).includes('withdrawn'), logDesc.slice(0, 300))

  check('no response, frame, push or script output carried the realm token', !seen.some(t => String(t).includes(TOKEN)))
  dashB.close()
} catch (e) { fail++; console.log('FAIL crashed:', String((e && e.stack) || e).split(TOKEN).join('<TOKEN>')) }
console.log(`\n${pass} passed, ${fail} failed`)
for (const h of [...all]) await stop(h)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
