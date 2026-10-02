// #85 (v1.71.0) — live: QUESTIONS answered from the dashboard. A session (the `log` tool's ask) or a script (aimb-log --ask) posts a
// question — a context whose line is the question (state blocked, current.question { status asked, choices, … }); the dashboard's
// `answer` {choice?, text?} is applied by the node's OWNER (forwarded over the hub link), logged + attributed, and (1) releases a
// script waiting on it (aimb-log --wait / --wait-answer: one JSON line, exit 0 answered · 10 still open · 11 expired · 12 withdrawn ·
// 13 gone) and (2) reaches the session at once as `activity_answer` (an agent's question: its session, body.agent names it) — the
// answer in the encrypted body, never in the public subject. `expires` closes it as expired; the asker (state withdrawn) or the
// dashboard (`withdraw`, or a ≤1.70 dashboard's Abandon…) withdraws it. Answer / withdraw go only to an owner that declared
// `activity_ask` (else owner-unsupported). Temp persist dirs + a temp AI_BRIDGE_CONFIG (never src/config.json); a test-set token
// that is never printed. Loopback "hosts":
//   B  127.0.0.1 "NOT-B"  dashboard dashB; sessions Lead + Orch (registered), the script sessions Scripty / Waiter
//   A  127.0.0.2 "NOT-A"  session Remote (registered); a script waiting on A for an answer given on B's dashboard
//   C  127.0.0.3 "NOT-C"  AI_BRIDGE_TEST_NO_ACTIVITY_ASK=1: it declares no activity_ask (stands in for a 1.70 owner); session Older
//   D  127.0.0.4 "NOT-D"  ONLY with AIMB_TEST_OLD_BRIDGE=<an older bridge.mjs> (a `git archive` of 1.70): the real mixed check
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
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
const OLD = process.env.AIMB_TEST_OLD_BRIDGE || ''
const LOGGER = path.join(SRCDIR, 'tools', 'aimb-log.mjs')
const TOKEN = 'ask85-' + crypto.randomBytes(9).toString('hex')
const B_PORT = String(tp(16100)), A_PORT = String(tp(16102)), C_PORT = String(tp(16104)), D_PORT = String(tp(16106))
const HB = 'NOT-B', HA = 'NOT-A', HC = 'NOT-C', HD = 'NOT-D'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-85-'))
const dirs = Object.fromEntries(['A', 'B', 'C', 'D'].map(k => [k, fs.mkdtempSync(path.join(tmp, `p${k}-`))]))
const cfgFile = path.join(tmp, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { notice_batch_sec: 2 } }))   // a batch window: answers must NOT wait for it
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const seen = []   // every raw response / frame / script output: none may carry the token
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).split(TOKEN).join('<TOKEN>'))) }
const J = JSON.stringify

const all = []
function spawn(name, bind, port, host, extra = {}, script = SRCDIR + BRIDGE) {
  const transport = new StdioClientTransport({ command: 'node', args: [script], cwd: path.dirname(script),
    env: { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
      AI_BRIDGE_STABLE_IDS: '1', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_TEST_NO_ACTIVITY_MSG: '', AI_BRIDGE_TEST_NO_ACTIVITY_ASK: '', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => { const h = { c, transport, name }; all.push(h); return h })
}
async function stop(h) { try { await h.transport.close() } catch { } all.splice(all.indexOf(h), 1); await sleep(300) }
const fileOf = d => ({ AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: d })
const call = async (b, n, a = {}) => { try { const t = (await b.c.callTool({ name: n, arguments: a })).content[0].text; seen.push(t); return JSON.parse(t) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 150) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
const board = async (h, q = {}) => (await call(h, 'activity', q)).sessions || []
const nodeOf = (b, name, p) => { const s = b.find(x => String(x.session).toLowerCase() === name.toLowerCase()); return !s ? undefined : p === '' ? s.self : (s.nodes || []).find(x => x.path === p) }
const logOf = async (h, q) => ((await call(h, 'activity', { log: { limit: 50, ...q } })).log || { entries: [] })
const inbox = async (h, name, secret, verb) => ((await call(h, 'inbox', { for: name, secret, cursor: 0 })).messages || []).filter(m => !verb || m.verb === verb)
const bodyOf = m => { try { return JSON.parse(m.body) } catch { return {} } }
/** aimb-log as a child process → Promise<{ code, out (the JSON line), stdout, stderr, ms }> (args after the script) */
function runLog(args, wsPort = Number(B_PORT) + 1, env = {}, host = '127.0.0.1') {
  return new Promise(resolve => {
    const t0 = Date.now(), p = spawnProc(process.execPath, [LOGGER, '--url', `ws://${host}:${wsPort}`, ...args], { env: { ...process.env, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_USER: 'robin', ...env } })
    let so = '', se = ''
    p.stdout.on('data', d => { so += d }); p.stderr.on('data', d => { se += d })
    p.on('exit', code => { seen.push(so, se); let out = null; try { out = JSON.parse(so.trim().split('\n').pop()) } catch { } resolve({ code, out, stdout: so, stderr: se, ms: Date.now() - t0 }) })
  })
}
function wsClient(port, kind, extra = {}) {   // a dashboard on a gateway's WS port
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${extra.host || '127.0.0.1'}:${port}`), C = { ws, msgs: [], n: 0, welcome: null }
    C.send = o => ws.send(J(o))
    C.action = async (msg, ms = 10000) => { const ref = `r${++C.n}`; C.send({ type: 'activity_action', ref, ...msg }); const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = C.msgs.find(x => x.type === 'activity_action' && x.ref === ref); if (m) return m.result; await sleep(30) } return { ok: false, code: 'no-answer' } }
    C.close = () => { try { ws.close() } catch { } }
    ws.on('open', () => ws.send(J({ type: 'hello', kind, token: TOKEN, instance: `t-${kind}-${port}` })))
    ws.on('message', raw => { const s = String(raw); seen.push(s); const m = JSON.parse(s); C.msgs.push(m); if (m.type === 'welcome' || m.type === 'error') { C.welcome = m; resolve(C) } })
    ws.on('close', () => resolve(C))
    ws.on('error', () => resolve(C))
  })
}
const verOk = (v, min) => { const a = String(v).split('.').map(Number); return a[0] > 1 || (a[0] === 1 && a[1] >= min) }

// ================================================================= the mesh: B, A and C (no activity_ask) linked
const B = await spawn('HubB', '127.0.0.1', B_PORT, HB, { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT},127.0.0.3:${C_PORT}${OLD ? `,127.0.0.4:${D_PORT}` : ''}` })
await sleep(600)
const A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` })
const C = await spawn('HubC', '127.0.0.3', C_PORT, HC, { ...fileOf(dirs.C), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}`, AI_BRIDGE_TEST_NO_ACTIVITY_ASK: '1' })
const ids = await Promise.all([A, B, C].map(h => call(h, 'my_identity')))
check('harness: A, B and C are gateways on ≥ 1.71.0', ids.every(i => i.role === 'gateway' && verOk(i.bridge_version, 71)), J(ids.map(i => [i.role, i.bridge_version])))
const linked = await until(() => call(B, 'list_sessions'), r => [HA, HC].every(h => (r.sessions || []).some(s => String(s.session).startsWith(h + '/'))), 12000)
check('harness: A and C are linked to B', [HA, HC].every(h => (linked.sessions || []).some(s => String(s.session).startsWith(h + '/'))))
const dashB = await wsClient(Number(B_PORT) + 1, 'dashboard')
dashB.send({ type: 'activity_sub' })
const Q = (session, path, action, args = {}, host = HB) => ({ host, session, project: 'ASKS', user: 'robin', path, action, args })

// ================================================================= the TOOL form: Lead asks (registered), returns at once
await call(B, 'register_self', { name: 'Lead', secret: 'l', project: 'ASKS' })
const t0 = Date.now()
const la = await call(B, 'log', { as: 'Lead', secret: 'l', path: 'lead-agent', ask: 'Postgres or SQLite for the cache?', choices: ['Postgres', 'SQLite'], details: 'the cache is small' })
check('tool: log {ask, choices} returns AT ONCE with the question\'s path (a child @?1 of the agent) and question { status asked, choices, free false }',
  la.ok && la.path === 'lead-agent/@?1' && la.state === 'blocked' && la.question?.status === 'asked' && J(la.question.choices) === J(['Postgres', 'SQLite']) && la.question.free === false && Date.now() - t0 < 3000, J(la))
const lq = nodeOf(await board(B), 'Lead', 'lead-agent/@?1')
check('board: the question node — a context whose line is the question (state blocked) and current.question (the activity tool shows it)', lq?.kind === 'context' && lq.current?.text === 'Postgres or SQLite for the cache?' && lq.current?.question?.status === 'asked' && lq.state === 'blocked', J(lq))
const bh = await until(async () => dashB.msgs.filter(m => m.type === 'activity_board' && m.head).at(-1), m => !!m && (m.head.remote_hosts || []).length >= 2, 8000)
const rh = h => ((bh && bh.head.remote_hosts) || []).find(x => x.host === h) || {}
check('capability: the board head marks A (activity_ask) ask:true — and C (no activity_ask) not; both keep msg / plan', rh(HA).ask === true && rh(HA).msg === true && !rh(HC).ask && rh(HC).msg === true && rh(HC).plan === true, J(bh && bh.head.remote_hosts))
const dq = await until(async () => { const u = dashB.msgs.filter(m => (m.type === 'activity_board' || m.type === 'activity_delta')).flatMap(m => m.upsert || []); return u.filter(x => x.kind === 'node' && x.path === 'lead-agent/@?1').at(-1) }, x => !!x, 6000)
check('dashboard units carry the question on the line (current.question: status, choices)', dq?.current?.question?.status === 'asked' && J(dq.current.question.choices) === J(['Postgres', 'SQLite']), J(dq?.current))

// refusals over the wire
const r1 = await dashB.action(Q('Lead', 'lead-agent/@?1', 'answer', { choice: 'MySQL' }))
const r2 = await dashB.action(Q('Lead', 'lead-agent/@?1', 'edit_text', { text: 'nope' }))
const r3 = await dashB.action(Q('Lead', 'lead-agent/@?1', 'answer', { choice: 'SQLite', text: 'and why' }))
const r4 = await dashB.action(Q('Lead', 'lead-agent', 'answer', { choice: 'SQLite' }))
check('refusals: a choice it doesn\'t have → bad-choice; edit_text on a question → question-node; free text on a choices-only question → bad-args; a non-question → not-a-question', r1.code === 'bad-choice' && r2.code === 'question-node' && r3.code === 'bad-args' && r4.code === 'not-a-question', J([r1.code, r2.code, r3.code, r4.code]))

// ================================================================= ANSWER from the dashboard → the session hears it at once (activity_answer)
const ta = Date.now()
const an = await dashB.action(Q('Lead', 'lead-agent/@?1', 'answer', { choice: 'sqlite' }))
const ni = await until(() => inbox(B, 'Lead', 'l', 'activity_answer'), ms => ms.length >= 1, 4000, 50)
const dt = Date.now() - ta, nb = bodyOf(ni[0] || {})
check('answer: applied by the owner (B), delivered LIVE at once (not after the 2 s batch window) — result delivery "live", the question now answered', an.ok && an.host === HB && an.action === 'answer' && an.delivered === true && an.delivery === 'live' && an.question?.status === 'answered' && ni.length === 1 && dt < 1800, J([an, dt]))
check('notice: the PUBLIC subject = who + the path + the question\'s first words — "robin answered lead-agent/@?1: Postgres or SQLite for the…" — never the answer', ni[0]?.subject === 'robin answered lead-agent/@?1: Postgres or SQLite for the cache?' && !/SQLite/.test((ni[0]?.subject || '').replace('Postgres or SQLite', '')), ni[0]?.subject)
check('notice: the body (encrypted) has { action answer, status answered, answer {choice "SQLite"}, question, choices, agent "lead-agent", path, host NOT-B, by {robin, NOT-B}, entry_id, session, project }',
  nb.action === 'answer' && nb.status === 'answered' && J(nb.answer) === J({ choice: 'SQLite' }) && nb.question === 'Postgres or SQLite for the cache?' && J(nb.choices) === J(['Postgres', 'SQLite']) && nb.agent === 'lead-agent' && nb.path === 'lead-agent/@?1' && nb.host === HB && J(nb.by) === J({ user: 'robin', host: HB }) && nb.session === 'Lead' && nb.project === 'ASKS' && !!nb.entry_id, J(nb))
check('notice: sent by the owning gateway as a system message (from = B\'s bridge)', String(ni[0]?.from?.session || ni[0]?.from || '').startsWith(HB + '/'), J(ni[0]?.from))
const la2 = nodeOf(await board(B), 'Lead', 'lead-agent/@?1'), le = (await logOf(B, { session: 'Lead', path: 'lead-agent/@?1', own: true })).entries[0] || {}
check('board + log: the line is DONE with question {status answered, answer, by}; the entry "answered by robin via dashboard (NOT-B): SQLite" (act answer); the activity tool shows the answer', la2?.state === 'done' && la2.current.text === 'Postgres or SQLite for the cache?' && J(la2.current.question.answer) === J({ choice: 'SQLite' }) && J(la2.current.question.by) === J({ user: 'robin', host: HB })
  && le.text === 'answered by robin via dashboard (NOT-B): SQLite' && le.act === 'answer', J([la2?.current, le]))
const again = await dashB.action(Q('Lead', 'lead-agent/@?1', 'answer', { choice: 'Postgres' }))
check('a closed question: answering again → question-closed', again.code === 'question-closed', J(again))

// ================================================================= the SCRIPT: --ask … --wait (a script-only session) — released by the answer
const wP = runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'Ship on Friday?', '--choice', 'Yes', '--choice', 'No', '--free', '--wait', '30s'])
const sq = await until(async () => nodeOf(await board(B), 'Scripty', 'worker/@?1'), x => !!x, 6000)
check('script --ask: the question is on the board (worker/@?1, free text allowed beside the choices) while the script waits', sq?.current?.question?.status === 'asked' && sq.current.question.free === true && J(sq.current.question.choices) === J(['Yes', 'No']), J(sq?.current))
await sleep(400)
const sa = await dashB.action(Q('Scripty', 'worker/@?1', 'answer', { choice: 'Yes', text: 'after the review' }))
const w1 = await wP
check('script --wait: released by the answer — exit 0, ONE JSON line { ok, outcome answered, answer {choice, text}, by, question, path, asked {id, path} }',
  w1.code === 0 && w1.out?.ok === true && w1.out.outcome === 'answered' && J(w1.out.answer) === J({ choice: 'Yes', text: 'after the review' }) && J(w1.out.by) === J({ user: 'robin', host: HB }) && w1.out.question === 'Ship on Friday?' && w1.out.path === 'worker/@?1' && w1.out.asked?.path === 'worker/@?1' && !!w1.out.asked?.id && w1.stdout.trim().split('\n').length === 1, J([w1.code, w1.out, w1.stderr.slice(0, 300)]))
check('the dashboard hears it reached the script: released 1, no "not-delivered" warning (a script-only session has no inbox, but its script took the answer)', sa.ok && sa.released === 1 && sa.delivery === 'none' && !(sa.warnings || []).includes('not-delivered'), J(sa))
const wa = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--path', 'worker/@?1', '--wait', '5s'])
check('--wait-answer on an already answered question: at once, exit 0, the same answer', wa.code === 0 && wa.out?.outcome === 'answered' && wa.out.answer?.choice === 'Yes' && wa.ms < 4000, J([wa.code, wa.out]))

// ================================================================= an AGENT's question → its SESSION (the orchestrator relays it)
await call(B, 'register_self', { name: 'Orch', secret: 'o', project: 'ASKS' })
const aw = runLog(['--session', 'Orch', '--project', 'ASKS', '--path', '@Next/helper-85', '--ask', 'Which wording for the changelog?', '--wait', '30s'])
const aq = await until(async () => nodeOf(await board(B), 'Orch', '@Next/helper-85/@?1'), x => !!x, 6000)
check('agent: a subagent\'s script asks under its own path (@Next/helper-85/@?1; free text only)', aq?.current?.question?.free === true && aq.current.question.choices.length === 0, J(aq?.current))
const aa = await dashB.action(Q('Orch', '@Next/helper-85/@?1', 'answer', { text: 'Use "Fixed" and "Added".\nKeep it short.' }))
const aw1 = await aw
const oi = await until(() => inbox(B, 'Orch', 'o', 'activity_answer'), ms => ms.length >= 1, 4000, 50), ob = bodyOf(oi[0] || {})
check('agent: the waiting script gets the free-text answer (newlines kept) AND the session (the orchestrator) gets activity_answer naming the agent (body.agent) — it relays it',
  aa.ok && aa.released === 1 && aa.delivery === 'live' && aw1.code === 0 && aw1.out?.answer?.text === 'Use "Fixed" and "Added".\nKeep it short.' && oi.length === 1 && ob.agent === '@Next/helper-85' && ob.answer?.text === 'Use "Fixed" and "Added".\nKeep it short.'
  && oi[0].subject === 'robin answered @Next/helper-85/@?1: Which wording for the changelog?', J([aa, aw1.code, oi.map(m => m.subject), ob]))

// ================================================================= ACROSS HOSTS: B's dashboard answers A's questions (forwarded to the owner)
await call(A, 'register_self', { name: 'Remote', secret: 'r', project: 'ASKS' })
const ra = await call(A, 'log', { as: 'Remote', secret: 'r', path: '@R', ask: 'Deploy A now?', choices: ['now', 'later'] })
check('a NEW context addressed by ask becomes the question itself (@R — no @?1 child)', ra.ok && ra.path === '@R' && ra.context === 'R', J(ra))
const waP = runLog(['--session', 'Waiter', '--project', 'ASKS', '--path', 'w', '--ask', 'Rebuild the tray on A?', '--choice', 'yes', '--choice', 'no', '--wait', '30s'], Number(A_PORT) + 1, {}, '127.0.0.2')
await until(async () => { const b = await board(B); return !!nodeOf(b, 'Remote', '@R') && !!nodeOf(b, 'Waiter', 'w/@?1') }, x => x, 10000)
const fa = await dashB.action(Q('Remote', '@R', 'answer', { choice: 'later' }, HA))
const ri = await until(() => inbox(A, 'Remote', 'r', 'activity_answer'), ms => ms.length >= 1, 6000, 50), rb = bodyOf(ri[0] || {})
check('federated B → A: the OWNER (A) applies the answer and tells its session from A\'s gateway (host NOT-A, by {robin, NOT-B})', ra.ok && fa.ok && fa.host === HA && fa.delivery === 'live' && ri.length === 1 && rb.host === HA && J(rb.by) === J({ user: 'robin', host: HB }) && J(rb.answer) === J({ choice: 'later' })
  && String(ri[0]?.from?.session || ri[0]?.from || '').startsWith(HA + '/'), J([fa, rb]))
const gb = await until(async () => nodeOf(await board(B), 'Remote', '@R'), x => x?.current?.question?.status === 'answered', 6000)
check('federated: gossip carries the answer back — B\'s board shows A\'s question answered (state done)', gb?.current?.question?.status === 'answered' && gb.state === 'done' && J(gb.current.question.answer) === J({ choice: 'later' }), J(gb?.current))
const fw = await dashB.action(Q('Waiter', 'w/@?1', 'answer', { choice: 'yes' }, HA))
const wA = await waP
check('federated --wait: a script waiting on A\'s gateway is released by an answer given on B\'s dashboard (exit 0)', fw.ok && fw.released === 1 && wA.code === 0 && wA.out?.answer?.choice === 'yes', J([fw, wA.code, wA.out]))

// ================================================================= EXPIRY
const ex = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'Expire me?', '--expires', '2s', '--wait', '20s'])
check('expiry: --expires 2s --wait 20s → the bridge closes it as EXPIRED and the script exits 11 (outcome expired, by bridge, no answer)', ex.code === 11 && ex.out?.outcome === 'expired' && ex.out.by === 'bridge' && !ex.out.answer && ex.ms < 9000, J([ex.code, ex.out, ex.ms]))
const exn = nodeOf(await board(B), 'Scripty', ex.out?.path || 'worker/@?2'), exl = (await logOf(B, { session: 'Scripty', path: ex.out?.path || 'worker/@?2', own: true })).entries[0] || {}
check('expiry: the node is expired (line abandoned: a ≤1.70 host sees an abandoned context), logged by the bridge "expired — nobody answered within 2s"', exn?.state === 'abandoned' && exn.current.question.status === 'expired' && exl.text === 'expired — nobody answered within 2s' && exl.by === 'bridge', J([exn?.current, exl]))
const le2 = await call(B, 'log', { as: 'Lead', secret: 'l', path: 'lead-agent', ask: 'Quick one?', expires: '2s' })
const lx = await until(() => inbox(B, 'Lead', 'l', 'activity_answer'), ms => ms.some(m => bodyOf(m).status === 'expired'), 8000)
const lxm = lx.find(m => bodyOf(m).status === 'expired') || {}
check('expiry: a registered session is told at once — activity_answer, status expired, subject "question expired lead-agent/@?2: Quick one?"', le2.ok && lxm.subject === 'question expired lead-agent/@?2: Quick one?' && bodyOf(lxm).action === 'expire' && bodyOf(lxm).by === 'bridge', J([le2.path, lx.map(m => m.subject)]))

// ================================================================= WITHDRAW (the asker; the dashboard) + the wait's other outcomes
const qw = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'Withdraw me?'])
const qp = qw.out?.path
const ww = runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--path', qp || 'x', '--wait', '30s'])
await sleep(800)
const wd = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', qp || 'x', '--state', 'withdrawn', '--text', 'decided myself'])
const ww1 = await ww
check('withdraw (the asker): --path <q> --state withdrawn → exit 0 (question withdrawn); a script waiting on it exits 12 (outcome withdrawn)', qw.code === 0 && !!qp && wd.code === 0 && wd.out?.question?.status === 'withdrawn' && ww1.code === 12 && ww1.out?.outcome === 'withdrawn', J([qw.out, wd.code, wd.out, ww1.code, ww1.out]))
const lw = await call(B, 'log', { as: 'Lead', secret: 'l', path: 'lead-agent', ask: 'Withdrawn by the dashboard?' })
const dw = await dashB.action(Q('Lead', lw.path, 'withdraw'))
const lwi = await until(() => inbox(B, 'Lead', 'l', 'activity_answer'), ms => ms.some(m => bodyOf(m).status === 'withdrawn'), 4000, 50)
check('withdraw (the dashboard): attributed, the session told at once — "robin withdrew lead-agent/@?3: Withdrawn by the dashboard?" (status withdrawn)', dw.ok && dw.question?.status === 'withdrawn' && lwi.some(m => m.subject === `robin withdrew ${lw.path}: Withdrawn by the dashboard?`), J([dw, lwi.map(m => m.subject)]))
const qt = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'Nobody answers this?'])
const to = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--path', qt.out?.path || 'x', '--wait', '2s'])
check('the wait runs out: exit 10, outcome timeout — the question stays open', to.code === 10 && to.out?.outcome === 'timeout' && to.out.status === 'asked' && to.ms >= 1900 && nodeOf(await board(B), 'Scripty', qt.out?.path)?.current?.question?.status === 'asked', J([to.code, to.out]))
// gone: the agent holding the question finishes and is dismissed from the dashboard
const gq = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'temp', '--ask', 'Gone soon?'])
await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'temp/@~root', '--text', 'finished', '--state', 'done'])
const gw = runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--path', gq.out?.path || 'x', '--wait', '30s'])
await sleep(800)
const dsm = await dashB.action(Q('Scripty', 'temp', 'dismiss'))
const gw1 = await gw
check('gone: the agent holding the question is dismissed — a script waiting on it exits 13 (outcome gone)', dsm.ok && gw1.code === 13 && gw1.out?.outcome === 'gone', J([dsm.code, gw1.code, gw1.out]))

// ================================================================= script usage + refusals
const u1 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--wait', '1m', '--text', 'x'])
const u2 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'x?', '--text', 'y'])
const u3 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--wait-answer', '--path', 'worker'])
const u4 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'x?', ...Array.from({ length: 9 }, (_, i) => ['--choice', 'c' + i]).flat()])
const u5 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'x?', '--wait', '25h'])
const c1 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'x?', '--choice', '@~root Ship it'])
const c2 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'x?', '--choice', '--wait', '1m'])
const c3 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'x?', '--choices', 'A', 'B'])
const c4 = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'Order kept?', '--choice', 'B two', '--choice', 'A one'])
check('--choice (one per flag, like --item): a value that looks like status text → 64 bad-choices; a flag as its value → 64 usage; --choices is unknown (64); two --choice flags keep their order',
  c1.code === 64 && c1.out?.code === 'bad-choices' && /looks like status text/.test(c1.out.what || '') && c2.code === 64 && c2.out?.code === 'usage' && /--choice needs a value/.test(c2.out.what || '')
  && c3.code === 64 && /unknown flag --choices/.test(c3.out?.what || '') && c4.code === 0 && J(c4.out?.question?.choices) === J(['B two', 'A one']), J([c1.out, c2.out, c3.out, c4.out?.question]))
check('script usage: --wait without --ask → 64; --ask with --text → 64 bad-ask; 9 choices → 64 bad-choices; --wait 25h → 64; --wait-answer on a non-question → 4 not-a-question',
  u1.code === 64 && u2.code === 64 && u2.out?.code === 'bad-ask' && u4.code === 64 && u4.out?.code === 'bad-choices' && u5.code === 64 && u3.code === 4 && u3.out?.code === 'not-a-question', J([u1.code, u2.out, u3.code, u3.out, u4.out, u5.code]))

// ================================================================= an OLDER owner (no activity_ask): refused before forwarding
await call(C, 'register_self', { name: 'Older', secret: 'o', project: 'ASKS' })
const oq = await call(C, 'log', { as: 'Older', secret: 'o', path: '@O', ask: 'On an older owner?', choices: ['a', 'b'] })
await until(async () => nodeOf(await board(B), 'Older', '@O'), x => !!x, 8000)
const oa = await dashB.action(Q('Older', '@O', 'answer', { choice: 'a' }, HC)), ow = await dashB.action(Q('Older', '@O', 'withdraw', {}, HC))
await sleep(400)
check('older owner: answer and withdraw are refused owner-unsupported ("… older than 1.71.0 …") — nothing forwarded, its question stays open, its session hears nothing',
  oq.ok && oa.code === 'owner-unsupported' && ow.code === 'owner-unsupported' && oa.host === HC && /older than 1\.71\.0/.test(oa.what || '') && nodeOf(await board(C), 'Older', '@O')?.current?.question?.status === 'asked' && (await inbox(C, 'Older', 'o', 'activity_answer')).length === 0, J([oa, ow]))
const om = await dashB.action(Q('Older', '@O', 'message', { text: 'still reachable' }, HC))
check('older owner: the older actions still forward (message, a 1.70 action)', om.ok && om.host === HC, J(om))

// ================================================================= the session guidance (trust)
const instr = String(B.c.getInstructions ? B.c.getInstructions() || '' : '')
const tools = (await B.c.listTools()).tools, logTool = tools.find(t => t.name === 'log') || {}, logDesc = String(logTool.description || '')
check('trust: the server instructions say an activity_answer is the viewer\'s answer to the session\'s OWN question — it may proceed on it within what its user already approved',
  /activity_answer is the dashboard viewer's answer to a question YOUR session asked/.test(instr) && /you may proceed on it within what your user already approved/.test(instr), instr.slice(0, 200))
check('trust: so does the log tool\'s description; its schema has ask / choices / free / expires and state withdrawn', /activity_answer is the dashboard viewer's answer to a question YOUR session asked: you may proceed on it within what your user already approved/.test(logDesc)
  && ['ask', 'choices', 'free', 'expires'].every(k => logTool.inputSchema?.properties?.[k]) && (logTool.inputSchema?.properties?.state?.enum || []).includes('withdrawn'))

// ================================================================= OPTIONAL: a real older bridge (AIMB_TEST_OLD_BRIDGE) — the mixed check
if (OLD) {
  const D = await spawn('HubD', '127.0.0.4', D_PORT, HD, { ...fileOf(dirs.D), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` }, OLD)
  const did = await call(D, 'my_identity')
  await call(D, 'register_self', { name: 'Ancient', secret: 'a', project: 'ASKS' })
  const dp = await call(D, 'log', { as: 'Ancient', secret: 'a', path: '@D', plan: ['D1'] })
  await until(() => call(B, 'list_sessions'), r => (r.sessions || []).some(x => String(x.session).startsWith(HD + '/')), 15000)
  const lo = await call(B, 'log', { as: 'Lead', secret: 'l', path: 'lead-agent', ask: 'Seen on the old host?', choices: ['y', 'n'] })
  const gdb = await until(() => board(D), b => !!nodeOf(b, 'Lead', lo.path), 12000)
  const dn = nodeOf(gdb, 'Lead', lo.path)
  check(`mixed (${did.bridge_version}): the older host shows the question as an ORDINARY BLOCKED context with its text (it drops the question field)`, dp.ok && dn?.kind === 'context' && dn.current?.text === 'Seen on the old host?' && dn.state === 'blocked' && !dn.current.question, J([did.bridge_version, dn]))
  const da = await dashB.action(Q('Ancient', '@D/@D1', 'answer', { choice: 'y' }, HD))
  check(`mixed (${did.bridge_version}): answer on the older owner → owner-unsupported (refused before forwarding)`, da.code === 'owner-unsupported', J(da))
  const dashD = await wsClient(Number(D_PORT) + 1, 'dashboard', { host: '127.0.0.4' })
  const dab = await dashD.action({ host: HB, session: 'Lead', project: 'ASKS', user: 'robin', path: lo.path, action: 'abandon', args: {} })
  const nab = nodeOf(await board(B), 'Lead', lo.path)
  check(`mixed (${did.bridge_version}): the older dashboard's Abandon… on a 1.71 question WITHDRAWS it on the owner (status withdrawn, by robin via dashboard (NOT-D))`, dab.ok && nab?.current?.question?.status === 'withdrawn' && J(nab.current.question.by) === J({ user: 'robin', host: HD }), J([dab, nab?.current]))
  const so = await runLog(['--session', 'Scripty', '--project', 'ASKS', '--path', 'worker', '--ask', 'To an old gateway?'], Number(D_PORT) + 1, {}, '127.0.0.4')
  check(`mixed (${did.bridge_version}): a 1.71 script asking an older gateway → exit 4 gateway-unsupported (never silently dropped)`, so.code === 4 && so.out?.code === 'gateway-unsupported' && /1\.71\.0/.test(so.out.what || ''), J([so.code, so.out]))
  dashD.close()
} else console.log('SKIP mixed check with a real older bridge (set AIMB_TEST_OLD_BRIDGE=<an older bridge.mjs>)')

check('no response, frame, push or script output carried the realm token', !seen.some(t => String(t).includes(TOKEN)))
console.log(`\n${pass} passed, ${fail} failed`)
dashB.close()
for (const h of [...all]) await stop(h)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
