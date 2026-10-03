// #90 (v1.75.0) — live: REVISE AN ANSWER, and the fix for Robin's 2026-10-03 bug (expanding a question's "answered by …" log entry
// showed the QUESTION's background, the asker's --details, instead of the answer). Now:
//  - a question's STATUS entries (answered, answer changed, withdrawn, expired) carry details of their own — the answer (choice, note,
//    who + when, a reminder of the question) — fetched by the entry's id (`activity {entry:{id, host}}`, from the owner's day file);
//    the question's line keeps the ask entry's id + the background, so the node's details (and the ask entry) still show it — also
//    after a restart (the replay reads the record's line_id / line_details / line_data);
//  - the dashboard's `change_answer` {choice?, text?} on an ANSWERED question: applied by the OWNER as a new attributed entry
//    ("answer changed by robin via dashboard (HOST): …"), the previous answer stays in the log, the question keeps status answered
//    with revised + previous; the session hears it at once (`activity_answer`, status "revised", body.answer + body.previous); a
//    script that already returned is not told again, a new --wait-answer returns the LATEST answer (the question is not reopened);
//  - only an owner that declared `activity_revise` applies it (else owner-unsupported; the board head's remote_hosts[].revise);
//  - an OPEN question never goes stale (no stale_at).
// Temp persist dirs + a temp AI_BRIDGE_CONFIG (never src/config.json); a test-set token that is never printed. Loopback "hosts":
//   B  127.0.0.1 "NOT-B"  dashboard dashB; session Lead (registered), script sessions Scripty
//   A  127.0.0.2 "NOT-A"  session Remote (registered) — restarted to prove the replay
//   C  127.0.0.3 "NOT-C"  AI_BRIDGE_TEST_NO_ACTIVITY_REVISE=1: no activity_revise (stands in for a 1.74 owner); session Older
//   D  127.0.0.4 "NOT-D"  ONLY with AIMB_TEST_OLD_BRIDGE=<an older bridge.mjs> (a `git archive` of 1.74): the real mixed check
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
const tp = testPorts(import.meta.url, 17100)   // #81: this file's port block (17100 = its first port name)
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const OLD = process.env.AIMB_TEST_OLD_BRIDGE || ''
const LOGGER = path.join(SRCDIR, 'tools', 'aimb-log.mjs')
const TOKEN = 'rev90-' + crypto.randomBytes(9).toString('hex')
const B_PORT = String(tp(17100)), A_PORT = String(tp(17102)), C_PORT = String(tp(17104)), D_PORT = String(tp(17106))
const HB = 'NOT-B', HA = 'NOT-A', HC = 'NOT-C', HD = 'NOT-D'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-90-'))
const dirs = Object.fromEntries(['A', 'B', 'C', 'D'].map(k => [k, fs.mkdtempSync(path.join(tmp, `p${k}-`))]))
const cfgFile = path.join(tmp, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { notice_batch_sec: 2 } }))   // a batch window: an answer must NOT wait for it
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const seen = []   // every raw response / frame / script output: none may carry the token
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).split(TOKEN).join('<TOKEN>'))) }
const J = JSON.stringify

const all = []
function spawn(name, bind, port, host, extra = {}, script = path.isAbsolute(BRIDGE) ? BRIDGE : SRCDIR + BRIDGE) {
  const transport = new StdioClientTransport({ command: 'node', args: [script], cwd: path.dirname(script),
    env: { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: host,
      AI_BRIDGE_STABLE_IDS: '1', AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_TEST_NO_ACTIVITY_MSG: '', AI_BRIDGE_TEST_NO_ACTIVITY_ASK: '',
      AI_BRIDGE_TEST_NO_ACTIVITY_REVISE: '', ...extra }, stderr: 'pipe' })
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
const entryOf = async (h, id, host) => (await call(h, 'activity', { entry: { id, host } }))
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
const BG = 'BACKGROUND: the cache holds 2 GB of tiles; Postgres is already in the stack'

// ================================================================= the mesh: B, A and C (no activity_revise) linked
const B = await spawn('HubB', '127.0.0.1', B_PORT, HB, { ...fileOf(dirs.B), AI_BRIDGE_SEEDS: `127.0.0.2:${A_PORT},127.0.0.3:${C_PORT}${OLD ? `,127.0.0.4:${D_PORT}` : ''}` })
await sleep(600)
let A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` })
const C = await spawn('HubC', '127.0.0.3', C_PORT, HC, { ...fileOf(dirs.C), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}`, AI_BRIDGE_TEST_NO_ACTIVITY_REVISE: '1' })
const ids = await Promise.all([A, B, C].map(h => call(h, 'my_identity')))
check('harness: A, B and C are gateways on ≥ 1.75.0', ids.every(i => i.role === 'gateway' && verOk(i.bridge_version, 75)), J(ids.map(i => [i.role, i.bridge_version])))
const linked = await until(() => call(B, 'list_sessions'), r => [HA, HC].every(h => (r.sessions || []).some(s => String(s.session).startsWith(h + '/'))), 12000)
check('harness: A and C are linked to B', [HA, HC].every(h => (linked.sessions || []).some(s => String(s.session).startsWith(h + '/'))))
const dashB = await wsClient(Number(B_PORT) + 1, 'dashboard')
dashB.send({ type: 'activity_sub' })
const Q = (session, path, action, args = {}, host = HB) => ({ host, session, project: 'REV', user: 'robin', path, action, args })
const bh = await until(async () => dashB.msgs.filter(m => m.type === 'activity_board' && m.head).at(-1), m => !!m && (m.head.remote_hosts || []).length >= 2, 8000)
const rh = h => ((bh && bh.head.remote_hosts) || []).find(x => x.host === h) || {}
check('capability: the board head marks A (activity_revise) revise:true — and C (none) not; both keep ask / msg / plan', rh(HA).revise === true && rh(HA).ask === true && !rh(HC).revise && rh(HC).ask === true && rh(HC).msg === true, J(bh && bh.head.remote_hosts))

// ================================================================= THE BUG: the answer entry's details are the ANSWER
await call(B, 'register_self', { name: 'Lead', secret: 'l', project: 'REV' })
const la = await call(B, 'log', { as: 'Lead', secret: 'l', path: 'lead-agent', ask: 'Postgres or SQLite for the cache?', choices: ['Postgres', 'SQLite'], free: true, details: BG, data: { size_gb: 2 } })
check('an OPEN question never goes stale: the ask\'s result has no stale_at, nor its node on the board; an ordinary blocked line beside it has one',
  la.ok && la.stale_at == null && await (async () => { await call(B, 'log', { as: 'Lead', secret: 'l', path: 'lead-agent/@~waiting', text: 'waiting on CI', state: 'blocked' }); const b = await board(B); return !nodeOf(b, 'Lead', la.path)?.stale_at && nodeOf(b, 'Lead', la.path)?.state === 'blocked' && !!nodeOf(b, 'Lead', 'lead-agent/@waiting')?.stale_at })(), J(la))
const an = await dashB.action(Q('Lead', la.path, 'answer', { choice: 'SQLite', text: 'smaller to ship' }))
const lg1 = (await logOf(B, { session: 'Lead', path: la.path, own: true })).entries
const ansE = lg1.find(e => e.act === 'answer') || {}, askE = lg1.find(e => !e.act) || {}
check('the answer entry\'s TEXT names the answer: answered by robin via dashboard (NOT-B): "SQLite" — note: smaller to ship', an.ok && ansE.text === 'answered by robin via dashboard (NOT-B): "SQLite" — note: smaller to ship' && ansE.has_details === true && !ansE.has_data, J([an, ansE]))
const fe = await entryOf(B, ansE.id, HB)
check('THE BUG (#90): expanding the answer entry (activity {entry:{id}}) shows the ANSWER — the choice, the note, who + when, the question — never the question\'s background; no data',
  /^Answer: SQLite\nNote: smaller to ship\nAnswered by robin via dashboard \(NOT-B\) at .+\nQuestion: Postgres or SQLite for the cache\? \(asked /.test(fe.entry?.details || '') && !/BACKGROUND/.test(fe.entry?.details || '') && fe.entry?.data == null && fe.source === 'file' && !('line_details' in (fe.entry || {})), J(fe))
const lq = nodeOf(await board(B), 'Lead', la.path), fl = await entryOf(B, lq?.current?.id, HB), fa = await entryOf(B, askE.id, HB)
check('… and the background STAYS on the question: its line keeps the ask entry\'s id, so the node\'s details (and the ask entry) still show it and its data',
  lq?.current?.id === askE.id && askE.id !== ansE.id && lq.current.has_details && lq.current.has_data && fl.entry?.details === BG && J(fl.entry?.data) === J({ size_gb: 2 }) && fa.entry?.details === BG, J([lq?.current, fl.entry?.details, askE.id]))

// ================================================================= CHANGE ANSWER → the session hears it at once (status revised)
const r0 = await dashB.action(Q('Lead', la.path, 'change_answer', { choice: 'sqlite', text: 'smaller to ship' }))
const r1 = await dashB.action(Q('Lead', la.path, 'change_answer', { choice: 'MySQL' }))
const r2 = await dashB.action(Q('Lead', la.path, 'answer', { choice: 'Postgres' }))
check('refusals: the same answer → no-change; a choice it lacks → bad-choice; answer on an answered question → question-closed (it names change_answer)', r0.code === 'no-change' && r1.code === 'bad-choice' && r2.code === 'question-closed' && /change_answer/.test(r2.what || ''), J([r0, r1, r2]))
const n0 = (await inbox(B, 'Lead', 'l', 'activity_answer')).length
const t0 = Date.now()
const ch = await dashB.action(Q('Lead', la.path, 'change_answer', { choice: 'Postgres', text: 'it is already in the stack' }))
const ni = await until(() => inbox(B, 'Lead', 'l', 'activity_answer'), ms => ms.length >= n0 + 1, 4000, 50)
const dt = Date.now() - t0, nm = ni.at(-1) || {}, nb = bodyOf(nm)
check('change_answer: applied by the owner, delivered LIVE at once (not after the 2 s batch window); the result carries previous + the question (answered, revised 1)',
  ch.ok && ch.host === HB && ch.action === 'change_answer' && ch.delivery === 'live' && ch.question?.status === 'answered' && ch.question.revised === 1 && J(ch.previous?.answer) === J({ choice: 'SQLite', text: 'smaller to ship' }) && dt < 1800, J([ch, dt]))
check('notice: activity_answer, the PUBLIC subject "robin changed the answer to lead-agent/@?1: Postgres or SQLite for the…" (no answer in it); body status "revised", the NEW answer and the PREVIOUS one (+ who / when), revised 1',
  nm.subject === 'robin changed the answer to lead-agent/@?1: Postgres or SQLite for the cache?' && nb.status === 'revised' && nb.action === 'change_answer' && J(nb.answer) === J({ choice: 'Postgres', text: 'it is already in the stack' })
  && J(nb.previous?.answer) === J({ choice: 'SQLite', text: 'smaller to ship' }) && J(nb.previous?.by) === J({ user: 'robin', host: HB }) && nb.previous.at > 0 && nb.revised === 1 && nb.agent === 'lead-agent' && !!nb.entry_id && J(nb.by) === J({ user: 'robin', host: HB }), J([nm.subject, nb]))
const lg2 = (await logOf(B, { session: 'Lead', path: la.path, own: true })).entries, chE = lg2.find(e => e.act === 'change_answer') || {}
const fc = await entryOf(B, chE.id, HB)
check('the log keeps the PREVIOUS answer (ask, answer, change); the change entry "answer changed by robin via dashboard (NOT-B): \\"Postgres\\" — note: …", its details the new answer + "Previous answer: SQLite — smaller to ship — by …"',
  lg2.length === 3 && lg2.some(e => e.id === ansE.id) && chE.text === 'answer changed by robin via dashboard (NOT-B): "Postgres" — note: it is already in the stack' && chE.id === nb.entry_id
  && /^Answer: Postgres\nNote: it is already in the stack\nChanged by robin via dashboard \(NOT-B\) at .+\nPrevious answer: SQLite — smaller to ship — by robin via dashboard \(NOT-B\) at .+\nQuestion: /.test(fc.entry?.details || '') && !/BACKGROUND/.test(fc.entry?.details || ''), J([lg2.map(e => e.text), fc.entry?.details]))
const lq2 = nodeOf(await board(B), 'Lead', la.path)
check('the board: still ANSWERED (line done) with the LATEST answer, revised 1 + previous; the line\'s id is still the ask entry\'s', lq2?.state === 'done' && lq2.current.question.status === 'answered' && J(lq2.current.question.answer) === J({ choice: 'Postgres', text: 'it is already in the stack' }) && lq2.current.question.revised === 1 && J(lq2.current.question.previous?.answer) === J({ choice: 'SQLite', text: 'smaller to ship' }) && lq2.current.id === askE.id, J(lq2?.current))
const dq = await until(async () => dashB.msgs.filter(m => m.type === 'activity_board' || m.type === 'activity_delta').flatMap(m => m.upsert || []).filter(x => x.kind === 'node' && x.path === la.path).at(-1), x => x?.current?.question?.revised === 1, 6000)
check('the dashboard units carry revised + previous', dq?.current?.question?.revised === 1 && J(dq.current.question.previous?.answer) === J({ choice: 'SQLite', text: 'smaller to ship' }), J(dq?.current))

// ================================================================= waiting scripts: an answered --wait is not told again; the question is not reopened
const wP = runLog(['--session', 'Scripty', '--project', 'REV', '--path', 'worker', '--ask', 'Ship on Friday?', '--choice', 'Yes', '--choice', 'No', '--wait', '30s'])
const sq = await until(async () => nodeOf(await board(B), 'Scripty', 'worker/@?1'), x => !!x, 6000)
await sleep(300)
const sa = await dashB.action(Q('Scripty', 'worker/@?1', 'answer', { choice: 'Yes' }))
const w1 = await wP
check('script --wait: released by the first answer (exit 0, "Yes")', !!sq && sa.ok && sa.released === 1 && w1.code === 0 && w1.out?.answer?.choice === 'Yes', J([sa, w1.code, w1.out]))
const sc = await dashB.action(Q('Scripty', 'worker/@?1', 'change_answer', { choice: 'No' }))
check('changing it: applied; no script is waiting any more (released 0); a script-only session has no inbox — "not delivered", the answer is on the node', sc.ok && sc.released === 0 && sc.delivery === 'none' && (sc.warnings || []).includes('not-delivered'), J(sc))
const wa = await runLog(['--session', 'Scripty', '--project', 'REV', '--wait-answer', '--path', 'worker/@?1', '--wait', '5s'])
check('a NEW --wait-answer returns at once with the LATEST answer ("No"), revised 1 + previous "Yes" — the question was not reopened', wa.code === 0 && wa.out?.outcome === 'answered' && wa.out.answer?.choice === 'No' && wa.out.revised === 1 && wa.out.previous?.answer?.choice === 'Yes' && wa.ms < 4000, J([wa.code, wa.out]))

// ================================================================= ACROSS HOSTS: B's dashboard changes A's answer (forwarded to the owner)
await call(A, 'register_self', { name: 'Remote', secret: 'r', project: 'REV' })
const ra = await call(A, 'log', { as: 'Remote', secret: 'r', path: '@R', ask: 'Deploy A now?', choices: ['now', 'later'], details: 'BG-A: the tray is rebuilt' })
await until(async () => nodeOf(await board(B), 'Remote', '@R'), x => !!x, 8000)
const fa1 = await dashB.action(Q('Remote', '@R', 'answer', { choice: 'later' }, HA))
const fa2 = await dashB.action(Q('Remote', '@R', 'change_answer', { choice: 'now' }, HA))
const ri = await until(() => inbox(A, 'Remote', 'r', 'activity_answer'), ms => ms.some(m => bodyOf(m).status === 'revised'), 6000, 50), rb = bodyOf(ri.find(m => bodyOf(m).status === 'revised') || {})
check('federated B → A: the OWNER (A) applies the change and tells its session from A\'s gateway (status revised, answer "now", previous "later", by robin on NOT-B)',
  ra.ok && fa1.ok && fa2.ok && fa2.host === HA && fa2.delivery === 'live' && rb.host === HA && J(rb.answer) === J({ choice: 'now' }) && J(rb.previous?.answer) === J({ choice: 'later' }) && J(rb.by) === J({ user: 'robin', host: HB }), J([fa2, rb]))
const gb = await until(async () => nodeOf(await board(B), 'Remote', '@R'), x => x?.current?.question?.revised === 1, 6000)
check('federated: gossip carries the change back — B\'s board shows A\'s question with the new answer, revised 1', J(gb?.current?.question?.answer) === J({ choice: 'now' }) && gb.state === 'done', J(gb?.current))
const lgA = (await call(B, 'activity', { log: { session: 'Remote', project: 'REV', user: 'robin', host: HA, path: '@R', limit: 20 } })).log?.entries || []
const chA = lgA.find(e => e.act === 'change_answer') || {}, feA = await entryOf(B, chA.id, HA)
check('federated: the change entry\'s details come from the owner (A) — the new answer and the previous one, not A\'s background', feA.from_host === HA && /^Answer: now\nChanged by robin via dashboard \(NOT-B\) at .+\nPrevious answer: later — by robin via dashboard \(NOT-B\) at /.test(feA.entry?.details || '') && !/BG-A/.test(feA.entry?.details || ''), J([chA, feA]))

// ================================================================= an OLDER owner (no activity_revise): refused before forwarding
await call(C, 'register_self', { name: 'Older', secret: 'o', project: 'REV' })
const oq = await call(C, 'log', { as: 'Older', secret: 'o', path: '@O', ask: 'On an older owner?', choices: ['a', 'b'] })
await until(async () => nodeOf(await board(B), 'Older', '@O'), x => !!x, 8000)
const oa = await dashB.action(Q('Older', '@O', 'answer', { choice: 'a' }, HC))
const oc = await dashB.action(Q('Older', '@O', 'change_answer', { choice: 'b' }, HC))
await sleep(400)
check('older owner: answer still forwards (it declared activity_ask) but change_answer is refused owner-unsupported ("… older than 1.75.0 …") — nothing forwarded, the answer stays "a"',
  oq.ok && oa.ok && oc.code === 'owner-unsupported' && oc.host === HC && /older than 1\.75\.0/.test(oc.what || '') && J(nodeOf(await board(C), 'Older', '@O')?.current?.question?.answer) === J({ choice: 'a' }) && !nodeOf(await board(C), 'Older', '@O')?.current?.question?.revised, J([oa, oc]))

// ================================================================= a RESTART of the owner (A): the replay keeps the line's id + background, the revised answer
await stop(A)
A = await spawn('HubA', '127.0.0.2', A_PORT, HA, { ...fileOf(dirs.A), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` })
const rr = await until(async () => nodeOf(await board(A), 'Remote', '@R'), x => !!x, 10000)
const fr = await entryOf(A, rr?.current?.id, HA), fch = await entryOf(A, chA.id, HA)
check('restart: A\'s replay restores the question — answered, the latest answer, revised 1 + previous; its line keeps the ask entry\'s id with the background; the change entry keeps the answer details',
  rr?.current?.question?.status === 'answered' && J(rr.current.question.answer) === J({ choice: 'now' }) && rr.current.question.revised === 1 && J(rr.current.question.previous?.answer) === J({ choice: 'later' }) && rr.current.id === ra.id
  && fr.entry?.details === 'BG-A: the tray is rebuilt' && /^Answer: now\n/.test(fch.entry?.details || ''), J([rr?.current, fr.entry?.details, fch.entry?.details]))

// ================================================================= the session guidance
const instr = String(B.c.getInstructions ? B.c.getInstructions() || '' : '')
const logDesc = String(((await B.c.listTools()).tools.find(t => t.name === 'log') || {}).description || '')
check('guidance: the server instructions and the log tool say status revised = the viewer changed an earlier answer (body.previous)', /status revised = the viewer CHANGED an earlier answer/.test(instr) && /revised \(the viewer changed an earlier answer: body\.previous/.test(logDesc), instr.slice(-600))

// ================================================================= OPTIONAL: a real older bridge (AIMB_TEST_OLD_BRIDGE) — the mixed check
if (OLD) {
  const D = await spawn('HubD', '127.0.0.4', D_PORT, HD, { ...fileOf(dirs.D), AI_BRIDGE_SEEDS: `127.0.0.1:${B_PORT}` }, OLD)
  const did = await call(D, 'my_identity')
  await call(D, 'register_self', { name: 'Ancient', secret: 'a', project: 'REV' })
  const dq1 = await call(D, 'log', { as: 'Ancient', secret: 'a', path: '@D', ask: 'Old owner question?', choices: ['x', 'y'] })
  await until(() => call(B, 'list_sessions'), r => (r.sessions || []).some(x => String(x.session).startsWith(HD + '/')), 15000)
  await until(async () => nodeOf(await board(B), 'Ancient', '@D'), x => !!x, 12000)
  const dbh = await until(async () => dashB.msgs.filter(m => (m.type === 'activity_board' || m.type === 'activity_delta') && m.head && (m.head.remote_hosts || []).some(x => x.host === HD)).at(-1), m => !!m && (m.head.remote_hosts || []).some(x => x.host === HD), 8000)
  const rD = ((dbh && dbh.head.remote_hosts) || []).find(x => x.host === HD) || {}
  const da = await dashB.action(Q('Ancient', '@D', 'answer', { choice: 'x' }, HD)), dc = await dashB.action(Q('Ancient', '@D', 'change_answer', { choice: 'y' }, HD))
  check(`mixed (${did.bridge_version}): the older owner is marked ask but not revise; its question is answered from a 1.75 dashboard; change_answer → owner-unsupported`, dq1.ok && rD.ask === true && !rD.revise && da.ok && dc.code === 'owner-unsupported', J([rD, da, dc]))
  const gdb = await until(() => board(D), b => nodeOf(b, 'Lead', la.path)?.current?.question?.answer?.choice === 'Postgres', 12000)
  const dn = nodeOf(gdb, 'Lead', la.path)
  check(`mixed (${did.bridge_version}): the older host shows the 1.75 changed question with its LATEST answer (it drops revised / previous)`, dn?.current?.question?.status === 'answered' && J(dn.current.question.answer) === J({ choice: 'Postgres', text: 'it is already in the stack' }) && !dn.current.question.revised, J(dn?.current))
} else console.log('SKIP mixed check with a real older bridge (set AIMB_TEST_OLD_BRIDGE=<an older bridge.mjs>)')

check('no response, frame, push or script output carried the realm token', !seen.some(t => String(t).includes(TOKEN)))
console.log(`\n${pass} passed, ${fail} failed`)
dashB.close()
for (const h of [...all]) await stop(h)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
