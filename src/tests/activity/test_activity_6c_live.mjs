// #70 step 6c + #75 part 2 (v1.64.0) — live. Ports 14700–14729; temp persist dirs + temp AI_BRIDGE_CONFIG files (never
// src/config.json); no token is ever printed (each check that touches output proves the token is absent).
// 1. #75 part 2 + the connect reminders: a gateway whose token comes from AI_BRIDGE_TOKEN_FILE, with the realm block of
//    config.example.json — a code session gets the doorbell reminder AND the activity one, each command carrying
//    --token-file "<that path>" (never the token); {log_snippet} expands to the exact aimb-log command + the six guidance
//    lines; a cowork session gets {log_tool_hint} (the log tool, its plan field) and not the script; set_wake's hint carries
//    the path. The snippet's command, run VERBATIM (placeholders filled), reports with only --token-file as the token source;
//    aimb-log's explicit --token-file is authoritative (a wrong file fails even with a good env token; an unreadable one is
//    exit 64 naming the file). A config.json token or an env token adds no --token-file.
// 2. Two hosts (A 127.0.0.2:14710 "SIXC-A", with SEEDED day files; B 127.0.0.1:14712 "SIXC-B"): the RUN BOUNDARY of a node
//    whose name had an earlier run (local paging on A, remote paging through B: run_start + earlier_cursor, then earlier:true),
//    "earlier history pruned" for a run whose first day file retention deleted (A prunes it at startup), the gossiped
//    per-node entry counts on B's board (+ partial), the HOME host of a session on both hosts (B first, A's newer headline),
//    and a dashboard's board head (finished_plan_open_min) + an ended plan's plan_end_at.
// 3. AUTO-ABANDON through the test clock hook: a script-only session's open plan; the gateway restarted 2 days later
//    (AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS, abandoned_plan_days 1) abandons it — entries by the bridge, in the files.
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { WebSocket } from 'ws'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lslug } from '../../facets/persistence/file.js'
import * as Act from '../../lib/activity.js'
const tp = testPorts(import.meta.url, 14700)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const LOGGER = path.join(SRCDIR, 'tools', 'aimb-log.mjs')
const TOKEN = 'sixc-' + crypto.randomBytes(9).toString('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).split(TOKEN).join('<TOKEN>'))) }
const J = JSON.stringify
const MIN = 60000, HOUR = 3600000, DAY = 86400000
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-6c-'))
const all = []
function spawn(name, env) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_TOKEN: '', AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_USER: 'robin', AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_PERSISTENCE: 'none', ...env }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => { const h = { c, transport, name }; all.push(h); return h })
}
async function stop(h) { try { await h.transport.close() } catch { } all.splice(all.indexOf(h), 1); await sleep(400) }
const seen = []   // every raw response text: none may contain the token
const call = async (b, n, a = {}) => { try { const t = (await b.c.callTool({ name: n, arguments: a })).content[0].text; seen.push(t); return JSON.parse(t) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
async function until(fn, want, ms = 8000, step = 150) { const t0 = Date.now(); let r; do { r = await fn(); if (want(r)) return r; await sleep(step) } while (Date.now() - t0 < ms); return r }
const fwd = p => p.replace(/\\/g, '/')
// split a command line the snippet hands out (double-quoted words, plain words) — no shell involved
const argvOf = cmd => [...cmd.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(m => (m[1] != null ? m[1].replace(/\\"/g, '"') : m[2]))
const runLog = (args, env = {}) => { const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000, env: { ...process.env, AI_BRIDGE_TOKEN: '', AI_BRIDGE_TOKEN_FILE: '', ...env } }); seen.push(r.stdout || '', r.stderr || ''); let out = null; try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()) } catch { } return { code: r.status, out, stdout: r.stdout || '', stderr: r.stderr || '' } }

// ================================================================= 1. #75 part 2 + {log_snippet} / {log_tool_hint}
const example = JSON.parse(fs.readFileSync(path.join(SRCDIR, 'config.example.json'), 'utf8'))
const realm = example.behaviors.realm
const tokFile = path.join(tmp, 'realm token.txt'); fs.writeFileSync(tokFile, TOKEN + '\n')   // a space in the path: the quoting matters
const cfg1 = path.join(tmp, 'cfg1.json'); fs.writeFileSync(cfg1, J({ wsPort: tp(14701), behaviors: { realm } }))
const P1 = { AI_BRIDGE_PORT: String(tp(14700)), AI_BRIDGE_WS_PORT: String(tp(14701)), AI_BRIDGE_BIND: '127.0.0.1' }
const G1 = await spawn('SixcG1', { ...P1, AI_BRIDGE_CONFIG: cfg1, AI_BRIDGE_TOKEN_FILE: tokFile })
const id1 = await call(G1, 'my_identity')
check('harness: a gateway on ≥ 1.64.0 whose token came from AI_BRIDGE_TOKEN_FILE', id1.role === 'gateway' && (v => v[0] > 1 || (v[0] === 1 && v[1] >= 64))(String(id1.bridge_version).split('.').map(Number)), J([id1.role, id1.bridge_version]))
check('config.example.json: the realm block keeps the doorbell reminder and adds the activity ones (code: {log_snippet}; cowork: {log_tool_hint}) — each ≤ 365 chars raw (the reminder cap on every host — the #79 orchestrator briefing fits inside it, so a 1.65 host shows it whole)', realm.default.some(d => d.match === 'code' && /\{doorbell_cmd\}/.test(d.behavior))
  && realm.default.some(d => d.match === 'code' && d.id === 'activity' && /\{log_snippet\}/.test(d.behavior) && /@~root/.test(d.behavior)) && realm.default.some(d => d.match === 'cowork' && /\{log_tool_hint\}/.test(d.behavior)) && realm.default.every(d => d.behavior.length <= 365))
const orch = await call(G1, 'register_self', { name: 'Orch', secret: 'o', project: 'SixC', client: 'claude-code' })
const cow = await call(G1, 'register_self', { name: 'Cow', secret: 'c', project: 'SixC', client: 'cowork' })
const rOrch = (orch.connect_reminders || []).map(r => r.behavior), rCow = (cow.connect_reminders || []).map(r => r.behavior)
const TF = fwd(path.resolve(tokFile)), NODE = fwd(process.execPath)
const door = rOrch.find(b => /aimb-doorbell\.mjs/.test(b)) || ''
check('#75: the doorbell reminder\'s command carries --token-file "<that path>" (forward slashes, quoted)', door.includes(`--name "Orch" --project "SixC" --token-file "${TF}"`), door)
const actR = rOrch.find(b => /aimb-log\.mjs/.test(b)) || ''
const snip = actR.slice(actR.indexOf('Report your status with:'), actR.lastIndexOf('\nKeep your board true')) || ''
const lines = snip.split('\n'), cmd = lines[0].replace(/^Report your status with: /, '')
const want = `"${NODE}" "${fwd(LOGGER)}" --session "Orch" --project "SixC" --token-file "${TF}" --path <agent-path> --text "<text>"`
console.log('  {log_snippet} =\n' + snip.split(TF).join('<token-file>').replace(/^/gm, '    | '))
check('{log_snippet}: the EXACT ready-to-run command — absolute node + script paths, --session / --project, #75\'s --token-file, a --path <agent-path> placeholder', cmd === want || cmd.replace(/^"[^"]*node(\.exe)?"/i, '"N"') === want.replace(/^"[^"]*"/, '"N"'), J([cmd.split(TF).join('<tf>'), want.split(TF).join('<tf>')]))
check('{log_snippet}: then six short guidance lines (≤ 110 chars each; 7 lines in all)', lines.length === 7 && lines.slice(1).every(l => l.startsWith('- ') && l.length <= 110), J(lines.map(l => l.length)))
const G = lines.slice(1).join('\n')
check('{log_snippet}: @ctx vs @~ctx · milestones (tool calls cost) + --no-log · --stale-after 60m · (#79) one line on --item "A" --item "B" and one on starting an item (--state running --text) + ticking it (--done) · finish with --text "@~root …" --state done / failed · never secrets',
  /--text "@ctx …" logs/.test(G) && /"@~ctx …" also sets its line/.test(G) && /milestones/.test(G) && /--no-log/.test(G) && /--stale-after 60m/.test(G) && lines.filter(l => /--item "A" --item "B"/.test(l)).length === 1
  && lines.filter(l => /--state running --text "<what>"/.test(l) && /--done/.test(l)).length === 1 && /--text "@~root <summary>" --state done \(or failed\)/.test(G) && /Never put secrets/.test(G), G)
check('the code reminder: an orchestrator puts the block into its agents\' prompts and keeps its own @~root current', /paste this into each prompt/.test(actR) && /@~root/.test(actR.slice(actR.lastIndexOf('\nKeep your board true'))))
const orchB = actR.slice(0, actR.indexOf('Report your status with:')), ownB = actR.slice(actR.lastIndexOf('\nKeep your board true'))
check('#79 snippet: the checklist stays LIVE and no argument depends on its position — "@~root" kept current; one --item per plan item (no --plan); start an item with --state running --text, tick it with --done the moment it is done', /keep "@~root <what you're doing>" current/.test(G) && /--item "A" --item "B" creates .*one name per --item/.test(G) && !/--plan/.test(G)
  && /Start item A: --path "<agent-path>\/@~A" --state running --text "<what>"; when done: same --path \+ --done\./.test(G), G)
check('briefing (Robin, 2026-10-03): the code reminder tells an orchestrator to put each agent UNDER the plan item it serves (--path "<plan item>/<agent>") with a checklist, and to tick the item itself after checking the work; its own board stays true — @~root current, unplanned work added as an item first, an item reopened (state running) when work resumes',
  /paste this into each prompt with --path "<plan item>\/<agent>" \(it sits under the item it serves; you tick the item after checking its work\) and a checklist/.test(orchB) && /when done: same --path \+ --done/.test(snip) && /--text "@~root <summary>" --state done \(or failed\)/.test(snip)
  && /"@~root <what you are doing>" current/.test(ownB) && /unplanned work added as an item first/.test(ownB) && /an item reopened \(state running\) when work resumes/.test(ownB) && !/\{\w+\}/.test(actR), actR.split(TF).join('<tf>'))
const hintR = rCow.find(b => /log tool/.test(b)) || '', hint = hintR.slice(hintR.indexOf('Report your status with the log tool'), hintR.includes('\nHanding work to agents') ? hintR.indexOf('\nHanding work to agents') : undefined)   // #79: the orchestrator briefing follows the hint
check('{log_tool_hint}: a COWORK session gets the log-tool form — as:"Cow", plan:["A","B"], a tick via path "…/@~A" + state done, stale_after, finish, no secrets — and no script path', /log\(\{ as:"Cow", secret, text \}\)/.test(hint) && /plan:\["A","B"\]/.test(hint) && /state:"done"/.test(hint) && /state:"running"/.test(hint) && /keep "@~root/.test(hint) && /Give each a path under the plan item it serves \("<item>\/<agent>"\) and a checklist; it ticks items and ends with "@~root <summary>", state:"done"\. Keep your plan true: add unplanned work as an item first; reopen an item \(state:"running"\) when work resumes/.test(hintR) && !/\{\w+\}/.test(hintR) && /stale_after:"60m"/.test(hint) && /Never put secrets/.test(hint) && !/aimb-log|aimb-doorbell/.test(hint)
  && hint.split('\n').length === 7, hint)
check('reminder audience: the code session does NOT get the cowork reminder, and the cowork session gets neither the doorbell nor the script', !rOrch.some(b => /log tool: log\(/.test(b) && /as:"Orch"/.test(b) && !/aimb-log/.test(b)) && !rCow.some(b => /aimb-doorbell|aimb-log/.test(b)), J([rOrch.length, rCow.length]))
const wake = await call(G1, 'set_wake', { as: 'Orch', secret: 'o' })
check('#75: set_wake\'s code hint carries --token-file "<path>" and says the token comes from it', (wake.command || '').endsWith(`--token-file "${TF}"`) && /the token comes from --token-file/.test(wake.hint || ''), wake.hint)
await call(G1, 'list_behaviors', { as: 'Orch', secret: 'o' })
// run the snippet's command VERBATIM (placeholders filled) — the token-FILE is its only token source
const argv = argvOf(cmd.replace('<agent-path>', 'research').replace('"<text>"', '"@~root hello from the snippet"'))
check('harness: the snippet\'s argv = node + the script + flags', argv[0] === NODE && fwd(argv[1]) === fwd(LOGGER) && argv.includes('--token-file') && argv.at(-1) === '@~root hello from the snippet', J(argv.slice(1).map(a => a.split(TF).join('<tf>'))))
const r1 = runLog(argv.slice(1), { AI_BRIDGE_CONFIG: cfg1 })
const b1 = await until(async () => (await call(G1, 'activity', { session: 'Orch' })).sessions || [], b => (b[0]?.nodes || []).some(n => n.path === 'research'), 5000)
check('aimb-log --token-file: the snippet\'s command, run as is, reports (exit 0) — the agent shows on the board', r1.code === 0 && r1.out?.ok === true && (b1[0]?.nodes || []).find(n => n.path === 'research')?.current?.text === 'hello from the snippet', J([r1.code, r1.out, r1.stderr.slice(0, 300)]))
const wrongF = path.join(tmp, 'wrong.txt'); fs.writeFileSync(wrongF, 'not-the-token')
const r2 = runLog([LOGGER, '--session', 'Orch', '--project', 'SixC', '--token-file', wrongF, '--ws-port', String(tp(14701)), 'x'], { AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_CONFIG: cfg1 })
check('aimb-log --token-file is AUTHORITATIVE: a wrong file fails (exit 4 unauthorized) even with the right token in AI_BRIDGE_TOKEN', r2.code === 4 && r2.out?.ok === false, J([r2.code, r2.out]))
const missing = path.join(tmp, 'no such dir', 'token.txt')
const r3 = runLog([LOGGER, '--session', 'Orch', '--project', 'SixC', '--token-file', missing, '--ws-port', String(tp(14701)), 'x'], { AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_CONFIG: cfg1 })
check('aimb-log --token-file unreadable → exit 64, the JSON names the file (code no-token) — never a silent fallback', r3.code === 64 && r3.out?.code === 'no-token' && r3.out?.what.includes(missing) && r3.out?.token_file === missing, J([r3.code, r3.out]))
const envTok = path.join(tmp, 'bridge.env'); fs.writeFileSync(envTok, `AI_BRIDGE_PROJECT=SixC\nAI_BRIDGE_TOKEN=${TOKEN}\n`)
const r4 = runLog([LOGGER, '--session', 'Orch', '--project', 'SixC', '--token-file', envTok, '--ws-port', String(tp(14701)), '--path', 'envfile', '@~root via a KEY=VALUE env file'], { AI_BRIDGE_CONFIG: cfg1 })
check('aimb-log --token-file: a KEY=VALUE env file works too', r4.code === 0 && r4.out?.ok === true, J([r4.code, r4.out]))
await stop(G1)
const cfg2 = path.join(tmp, 'cfg2.json'); fs.writeFileSync(cfg2, J({ token: TOKEN, behaviors: { realm } }))
const G2 = await spawn('SixcG2', { ...P1, AI_BRIDGE_CONFIG: cfg2 })
const o2 = await call(G2, 'register_self', { name: 'Orch', secret: 'o', project: 'SixC', client: 'claude-code' }), w2 = await call(G2, 'set_wake', { as: 'Orch', secret: 'o' })
check('#75: a token from config.json adds NO --token-file (the script reads config.json itself); the hint says so', (o2.connect_reminders || []).length >= 2 && !(o2.connect_reminders || []).some(r => /--token-file/.test(r.behavior)) && !/--token-file/.test(w2.command || '') && /token\/port default from the bridge's config\.json/.test(w2.hint || ''), J(o2.connect_reminders))
await stop(G2)
const G3 = await spawn('SixcG3', { ...P1, AI_BRIDGE_CONFIG: cfg1, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: tokFile })
const o3 = await call(G3, 'register_self', { name: 'Orch', secret: 'o', project: 'SixC', client: 'claude-code' })
check('#75: an env token VALUE (AI_BRIDGE_TOKEN, which wins over the file) adds NO --token-file — it can\'t be passed on safely', (o3.connect_reminders || []).length >= 2 && !(o3.connect_reminders || []).some(r => /--token-file/.test(r.behavior)), J(o3.connect_reminders))
await stop(G3)

// ================================================================= 2. two hosts: run boundary, pruned, counts, home host, the board head
const HA = 'SIXC-A', HB = 'SIXC-B', dirA = fs.mkdtempSync(path.join(tmp, 'pA-')), dirB = fs.mkdtempSync(path.join(tmp, 'pB-'))
const cfgAB = path.join(tmp, 'cfgAB.json'); fs.writeFileSync(cfgAB, J({ activity: { finished_plan_open_min: 45 } }))
// seed A's day files with the LIBRARY (chronological applies, so every new_from marker is where a gateway would write it)
const sim = Act.createActivity({ origin: HA, config: { finished_visible_hours: 1 } }), RN = { session: 'Runner', project: 'SixC', user: 'robin', realm: 'default' }
const files = new Map(), put = rec => { const d = Act.localDay(rec.ts); if (!files.has(d)) files.set(d, []); files.get(d).push(J(rec)) }
const now0 = Date.now(), D = k => now0 - k * DAY
const say = (input, t) => { const p = Act.parseMessage(input, { now: t }); if (!p.ok) throw new Error(`seed ${J(input)}: ${p.code}`); const r = Act.apply(sim, RN, p.msg, t); if (!r.ok) throw new Error(`seed ${J(input)}: ${r.code}`); for (const x of r.records) put(x) }
say({ path: 'old', text: 'old: created 20 days ago' }, D(20))
for (const k of [6, 5]) say({ path: 'old', text: `old: day -${k}` }, D(k))
say({ text: '@~root runner up' }, D(4))
for (let i = 1; i <= 3; i++) say({ path: 'research', text: `run 1 note ${i}` }, D(4) + i * MIN)
say({ path: 'research/@~root', text: 'run 1 done', state: 'done' }, D(4) + 4 * MIN)
Act.expire(sim, D(4) + 2 * HOUR)   // the finished agent leaves the board (the sim's window is 1 h) …
for (const k of [3, 2, 1]) say({ path: 'old', text: `old: day -${k}` }, D(k))
say({ path: '@shipped', plan: ['p1', 'p2'] }, D(2)); say({ path: '@shipped/@~p1', state: 'done' }, D(2) + MIN); say({ path: '@shipped/@~p2', state: 'done' }, D(2) + 2 * MIN)
for (let i = 1; i <= 4; i++) say({ path: 'research', text: `run 2 note ${i}` }, D(1) + i * MIN)   // … and comes back: a NEW run
const hostDir = path.join(dirA, 'activity', lslug(HA, 80)); fs.mkdirSync(hostDir, { recursive: true })
for (const [d, ls] of files) fs.writeFileSync(path.join(hostDir, `${d}.jsonl`), ls.join('\n') + '\n')
const oldDay = Act.localDay(D(20))
const envAB = { AI_BRIDGE_CONFIG: cfgAB, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', AI_BRIDGE_TEST_GOSSIP: '' }
const A = await spawn('SixcA', { ...envAB, AI_BRIDGE_PORT: String(tp(14710)), AI_BRIDGE_WS_PORT: String(tp(14711)), AI_BRIDGE_BIND: '127.0.0.2', AI_BRIDGE_ADVERTISE_HOST: '127.0.0.2', AI_BRIDGE_TEST_HOSTNAME: HA, AI_BRIDGE_SEEDS: '127.0.0.1:' + tp(14712), AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: dirA })
const B = await spawn('SixcB', { ...envAB, AI_BRIDGE_PORT: String(tp(14712)), AI_BRIDGE_WS_PORT: String(tp(14713)), AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_ADVERTISE_HOST: '127.0.0.1', AI_BRIDGE_TEST_HOSTNAME: HB, AI_BRIDGE_SEEDS: '127.0.0.2:' + tp(14710), AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: dirB })
const node = (b, s, p, host) => ((b || []).find(g => g && g.session === s)?.nodes || []).find(n => n.path === p && (!host || n.host === host))
const bB = await until(async () => (await call(B, 'activity')).sessions || [], b => !!node(b, 'Runner', 'research', HA) && !!node(b, 'Runner', 'old', HA), 15000)
check('harness: A replayed its seeded files (retention pruned the 20-day-old one) and B sees A\'s board', !!node(bB, 'Runner', 'research', HA) && !fs.existsSync(path.join(hostDir, `${oldDay}.jsonl`)), J([bB.map(g => g.session), fs.readdirSync(hostDir)]))
check('6c counts over gossip: B\'s board shows each of A\'s nodes with its OWN entry count (log.total), "partial" where it understates', J(node(bB, 'Runner', 'research', HA)?.log) === J({ remote: true, total: 4 }) && J(node(bB, 'Runner', 'old', HA)?.log) === J({ remote: true, total: 5, partial: true }),
  J([node(bB, 'Runner', 'research', HA)?.log, node(bB, 'Runner', 'old', HA)?.log]))
const lA = await call(A, 'activity', { log: { session: 'Runner', path: 'research' } })
check('6c run boundary (local, on A): the history stops at the start of the CURRENT run (run_start + earlier_cursor)', J((lA.log?.entries || []).map(e => e.text)) === J(['run 2 note 4', 'run 2 note 3', 'run 2 note 2', 'run 2 note 1']) && lA.log?.run_start === true && /^f1\./.test(lA.log?.earlier_cursor || '') && lA.log?.next_cursor === null, J(lA.log))
const rB = await call(B, 'activity', { log: { session: 'Runner', path: 'research' } })
check('6c run boundary (remote, through B): the owner pages it the same way — from_host A, run_start + earlier_cursor', rB.from_host === HA && J((rB.log?.entries || []).map(e => e.text)) === J(['run 2 note 4', 'run 2 note 3', 'run 2 note 2', 'run 2 note 1']) && rB.log?.run_start === true && !!rB.log?.earlier_cursor, J(rB))
const eB = await call(B, 'activity', { log: { session: 'Runner', path: 'research', cursor: rB.log?.earlier_cursor, earlier: true } })
check('6c "show earlier runs" (remote): cursor = earlier_cursor + earlier:true continues past the boundary into the earlier run', J((eB.log?.entries || []).map(e => e.text)) === J(['run 1 done', 'run 1 note 3', 'run 1 note 2', 'run 1 note 1']) && !eB.log?.run_start && eB.log?.next_cursor === null && !eB.log?.pruned, J(eB.log))
const oA = await call(A, 'activity', { log: { session: 'Runner', path: 'old' } }), oB = await call(B, 'activity', { log: { session: 'Runner', path: 'old' } })
check('6c pruned: a run that began in a day file retention deleted ends in pruned:true — locally and through B — never a silent gap', oA.log?.pruned === true && oB.log?.pruned === true && (oB.log?.entries || []).at(-1)?.text === 'old: day -6' && !(oB.log?.entries || []).some(e => /20 days/.test(e.text)), J([oA.log?.pruned, oB.log?.entries?.map(e => e.text)]))
const sA = await call(A, 'activity', { log: { session: 'Runner' } })
check('6c pruned: the session\'s own run began in that deleted file too (pruned); a child\'s new run is no boundary for it', sA.log?.pruned === true && !sA.log?.run_start && (sA.log?.entries || []).some(e => e.text === 'run 2 note 1'), J(sA.log && [sA.log.pruned, sA.log.run_start, sA.log.entries.length]))
// the HOME host: the session appears on B first, then on A with a newer headline
const tb = runLog([LOGGER, '--session', 'Twin', '--project', 'SixC', '--url', 'ws://127.0.0.1:' + tp(14713), '--path', 'bjob', '@~root on B first'], { AI_BRIDGE_TOKEN: TOKEN })
await sleep(1500)
const ta = runLog([LOGGER, '--session', 'Twin', '--project', 'SixC', '--url', 'ws://127.0.0.2:' + tp(14711), '@~root A has the newer headline'], { AI_BRIDGE_TOKEN: TOKEN })
const tj = runLog([LOGGER, '--session', 'Twin', '--project', 'SixC', '--url', 'ws://127.0.0.2:' + tp(14711), '--path', 'ajob', '@~root on A'], { AI_BRIDGE_TOKEN: TOKEN })
const tw = await until(async () => ((await call(B, 'activity', { session: 'Twin' })).sessions || [])[0], g => !!g && g.multi_host && !!(g.nodes || []).find(n => n.path === 'ajob'), 8000)
check('6c home host: a session on both hosts names its HOME host (B — it appeared there first), while the headline is A\'s (newer)', tb.code === 0 && ta.code === 0 && tj.code === 0 && tw?.home === HB && tw?.self?.host === HA, J([tw?.home, tw?.self?.host, tw?.hosts]))
// a dashboard on B: the head carries finished_plan_open_min; an ended plan carries plan_end_at
const dash = await new Promise(resolve => {
  const ws = new WebSocket('ws://127.0.0.1:' + tp(14713)), d = { ws, board: null }
  ws.on('open', () => ws.send(J({ type: 'hello', kind: 'dashboard', instance: 'six', token: TOKEN })))
  ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.type === 'welcome') ws.send(J({ type: 'activity_sub' })); if (m.type === 'activity_board') { d.board = m; resolve(d) } })
  ws.on('error', () => resolve(d)); setTimeout(() => resolve(d), 8000)
})
const pu = (dash.board?.upsert || []).find(u => u.kind === 'node' && u.path === '@shipped' && u.host === HA)
check('6c the finished-plan window\'s plumbing: the board head carries finished_plan_open_min (45, from config); an ENDED plan\'s unit carries plan_node + plan_end_at (when its last item was done)', dash.board?.head?.finished_plan_open_min === 45 && pu?.plan_node === true && pu?.plan_end_at === D(2) + 2 * MIN, J([dash.board?.head, pu]))
try { dash.ws.close() } catch { }
await stop(A); await stop(B)

// ================================================================= 3. AUTO-ABANDON through the clock hook
const dirE = fs.mkdtempSync(path.join(tmp, 'pE-')), cfgE = path.join(tmp, 'cfgE.json'); fs.writeFileSync(cfgE, J({ token: TOKEN, activity: { abandoned_plan_days: 1 } }))
const envE = { AI_BRIDGE_CONFIG: cfgE, AI_BRIDGE_PORT: String(tp(14720)), AI_BRIDGE_WS_PORT: String(tp(14721)), AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: dirE, AI_BRIDGE_ACTIVITY_GC_MS: '300' }
const E1 = await spawn('SixcE1', envE)
await call(E1, 'my_identity')
const s1 = runLog([LOGGER, '--session', 'Ghosty', '--project', 'SixC', '--ws-port', String(tp(14721)), '--path', '@~#70', 'the plan', '--plan', 'A', 'B'], { AI_BRIDGE_CONFIG: cfgE })
const s2 = runLog([LOGGER, '--session', 'Ghosty', '--project', 'SixC', '--ws-port', String(tp(14721)), '--path', '@#70/@~A', '--done'], { AI_BRIDGE_CONFIG: cfgE })
await sleep(1500)
const e1 = ((await call(E1, 'activity', { session: 'Ghosty' })).sessions || [])[0]
check('auto-abandon (setup): a script-only session\'s plan — A done, B open — and nothing abandoned within the day', s1.code === 0 && s2.code === 0 && node([e1], 'Ghosty', '@#70/@B')?.state === 'todo' && node([e1], 'Ghosty', '@#70')?.state === 'running', J([s1.code, s2.code, e1 && e1.nodes.map(n => [n.path, n.state])]))
await stop(E1)
const E2 = await spawn('SixcE2', { ...envE, AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: String(2 * DAY + HOUR) })
const e2 = await until(async () => ((await call(E2, 'activity', { session: 'Ghosty' })).sessions || [])[0], g => node([g], 'Ghosty', '@#70/@B')?.state === 'abandoned' && node([g], 'Ghosty', '@#70')?.state === 'abandoned', 10000)
check('auto-abandon: restarted 2 days later (the clock hook; abandoned_plan_days 1), the gateway abandons the gone session\'s open item and the plan node; the done item stays done', node([e2], 'Ghosty', '@#70/@B')?.state === 'abandoned' && node([e2], 'Ghosty', '@#70')?.state === 'abandoned' && node([e2], 'Ghosty', '@#70/@A')?.state === 'done', J(e2 && e2.nodes.map(n => [n.path, n.state])))
const lg = await call(E2, 'activity', { log: { session: 'Ghosty', path: '@#70' } })
const byB = (lg.log?.entries || []).filter(e => e.by === 'bridge')
check('auto-abandon: logged as entries attributed to the bridge (by:"bridge"), newest first in the plan\'s log', byB.length === 2 && byB.every(e => e.state === 'abandoned' && /abandoned by the bridge/.test(e.text)) && J(byB.map(e => e.path)) === J(['@#70', '@#70/@B']), J(lg.log?.entries?.map(e => [e.path, e.state, e.by])))
const dayE = Act.localDay(Date.now() + 2 * DAY + HOUR), fileE = path.join(dirE, 'activity', lslug(os.hostname(), 80), `${dayE}.jsonl`)
const recE = (() => { try { return fs.readFileSync(fileE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } })()
check('auto-abandon: … and persisted in the (shifted) day\'s file as current-format records with by:"bridge"', recE.filter(r => r.by === 'bridge' && r.v === Act.ACTIVITY_FORMAT && r.state === 'abandoned').length === 2, J(recE.map(r => [r.kind || 'entry', r.path, r.state, r.by])))
await stop(E2)

check('no response, reminder, script output or error EVER contained the realm token', !seen.some(t => t.includes(TOKEN)), seen.filter(t => t.includes(TOKEN)).length)
console.log(`\n${pass} passed, ${fail} failed`)
for (const h of [...all]) { try { await h.transport.close() } catch { } }
await sleep(400)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
