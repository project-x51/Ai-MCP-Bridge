// #70 step 6c + #75 part 2 (v1.64.0) — live; PORTED to the 2.0 board in #88 build step 9 (docs/spec-88.md §4.3, §4.4,
// §5.3, §6). Ports 14700–14729 of this file's block; temp persist dirs + temp AI_BRIDGE_CONFIG files (never
// src/config.json); no token is ever printed (each check that touches output proves the token is absent).
// 1. #75 part 2 + the connect reminders (2.0 texts): a gateway whose token comes from AI_BRIDGE_TOKEN_FILE, with the realm
//    block of config.example.json — a code session gets the doorbell reminder AND the activity one, each command carrying
//    --token-file "<that path>" (never the token); {log_snippet} expands to the exact 2.0 aimb-log command (`--agent
//    <your-key> --label "<your name>" --under <item-key>`) + ONE guidance line; `--guide agent` run from it is the agent's
//    FIRST REPORT (§4.4: created under the item, "reading the guide"; a re-read writes nothing) and prints the 2.0 rules;
//    `--guide session` the orchestrator's; a cowork session gets {log_tool_hint} (key / label, plan:[{key, label}], a
//    leading @) and not the script; set_wake's hint carries the path. The snippet's command, run VERBATIM (placeholders
//    filled, + --text), reports with only --token-file as the token source; aimb-log's explicit --token-file is
//    authoritative (a wrong file fails even with a good env token; an unreadable one is exit 64 naming the file). A
//    config.json token or an env token adds no --token-file. Every raw realm reminder fits the 365-char reminder cap.
// 2. Two 2.0 hosts (A 127.0.0.2:14710 "SIXC-A", file persistence; B 127.0.0.1:14712 "SIXC-B"). A's history is WRITTEN
//    THROUGH A 2.0 GATEWAY on A's own clock (the test clock hook AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: 4 days ago, then
//    1 day ago, then now with log_retention_days 3 — so retention deletes the first day file at startup). Covers: the RUN
//    BOUNDARY (§5.3) of an agent that came back after a dismissal (a ghost key re-used = a new run of the same id, §3.7) —
//    local paging on A and remote paging through B (gossip v6, its owner pages it): run_start + earlier_cursor, then
//    earlier:true; "earlier history pruned" (pruned:true) for a run that began in a day file retention deleted — locally and
//    through B, and for the session root (a child's new run is no boundary for it); the gossiped per-node entry counts
//    (log_n) on B's board equal to the owner's.
// RETIRED in step 9 (1.7x-only): the seeded v5 day files (a 2.0 gateway refuses v5 history — the history above is written
// through 2.0 gateways instead); the gossiped count's `partial` flag (a v6 slice carries log_n only); the HOME host of a
// session on two hosts (the 2.0 board lists each host's copy as its own row, tagged host — there is no merged multi-host
// group); the dashboard board head's finished_plan_open_min + an ended plan's plan_end_at (the dashboard's board pushes are
// not wired to 2.0 until step 10).
// 3. AUTO-ABANDON (RESTORED in step 10, spec Q72, on the 2.0 board) through the test clock hook: a script-only session's
//    open plan (#70: A done, B open); the gateway restarted 2 days + 1 h later (abandoned_plan_days 1) abandons B, then the
//    plan node #70, as entries attributed to the bridge (by "bridge", the 1.7x text), written to the shifted day's file.
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
import { localDay } from '../../lib/activity.js'
import * as F from '../../lib/activity2-files.js'
const tp = testPorts(import.meta.url, 14700)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const LOGGER = path.join(SRCDIR, 'tools', 'aimb-log.mjs')
const VER = JSON.parse(fs.readFileSync(path.join(SRCDIR, 'package.json'), 'utf8')).version
const TOKEN = 'sixc-' + crypto.randomBytes(9).toString('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).split(TOKEN).join('<TOKEN>'))) }
const J = JSON.stringify
const DAY = 86400000
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-6c-'))
const all = []
function spawn(name, env) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_TOKEN: '', AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_USER: 'robin', AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_PERSISTENCE: 'none', TEMP: tmp, TMP: tmp, ...env }, stderr: 'pipe' })
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
const runLog = (args, env = {}) => { const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000, env: { ...process.env, AI_BRIDGE_TOKEN: '', AI_BRIDGE_TOKEN_FILE: '', AI_BRIDGE_USER: 'robin', ...env } }); seen.push(r.stdout || '', r.stderr || ''); let out = null; try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()) } catch { } return { code: r.status, out, stdout: r.stdout || '', stderr: r.stderr || '' } }
const sessOf = (b, s, host) => (b || []).find(g => g && g.session === s && (!host || g.host === host))
const nodeAt = (b, s, p, host) => ((sessOf(b, s, host) || {}).nodes || []).find(n => n.path === p)

// ================================================================= 1. #75 part 2 + {log_snippet} / {log_tool_hint} (2.0 texts)
const example = JSON.parse(fs.readFileSync(path.join(SRCDIR, 'config.example.json'), 'utf8'))
const realm = example.behaviors.realm
const tokFile = path.join(tmp, 'realm token.txt'); fs.writeFileSync(tokFile, TOKEN + '\n')   // a space in the path: the quoting matters
const cfg1 = path.join(tmp, 'cfg1.json'); fs.writeFileSync(cfg1, J({ wsPort: tp(14701), behaviors: { realm } }))
const P1 = { AI_BRIDGE_PORT: String(tp(14700)), AI_BRIDGE_WS_PORT: String(tp(14701)), AI_BRIDGE_BIND: '127.0.0.1' }
const G1 = await spawn('SixcG1', { ...P1, AI_BRIDGE_CONFIG: cfg1, AI_BRIDGE_TOKEN_FILE: tokFile })
const id1 = await call(G1, 'my_identity')
check('harness: a gateway on ≥ 1.64.0 whose token came from AI_BRIDGE_TOKEN_FILE', id1.role === 'gateway' && (v => v[0] > 1 || (v[0] === 1 && v[1] >= 64))(String(id1.bridge_version).split('.').map(Number)), J([id1.role, id1.bridge_version]))
check('config.example.json: the realm block keeps the doorbell reminder and the 2.0 activity ones (code: {log_snippet} with --agent / --label / --under; cowork: {log_tool_hint} with agent / label / under) — no 1.7x "@~" form — each ≤ 365 chars raw (the reminder cap: a longer one is CUT)',
  realm.default.some(d => d.match === 'code' && /\{doorbell_cmd\}/.test(d.behavior))
  && realm.default.some(d => d.match === 'code' && d.id === 'activity' && /\{log_snippet\}/.test(d.behavior) && /--agent <its key> --label "<its name>" --under <its plan item's key>/.test(d.behavior))
  && realm.default.some(d => d.match === 'cowork' && /\{log_tool_hint\}/.test(d.behavior) && /agent:"<key>", label:"<its name>" and under:"<the plan item's key>"/.test(d.behavior))
  && !realm.default.some(d => /@~/.test(d.behavior)) && realm.default.every(d => d.behavior.length <= 365), J(realm.default.map(d => [d.match, d.id, d.behavior.length])))
const orch = await call(G1, 'register_self', { name: 'Orch', secret: 'o', project: 'SixC', client: 'claude-code' })
const cow = await call(G1, 'register_self', { name: 'Cow', secret: 'c', project: 'SixC', client: 'cowork' })
const rOrch = (orch.connect_reminders || []).map(r => r.behavior), rCow = (cow.connect_reminders || []).map(r => r.behavior)
const TF = fwd(path.resolve(tokFile)), NODE = fwd(process.execPath)
const door = rOrch.find(b => /aimb-doorbell\.mjs/.test(b)) || ''
check('#75: the doorbell reminder\'s command carries --token-file "<that path>" (forward slashes, quoted)', door.includes(`--name "Orch" --project "SixC" --token-file "${TF}"`), door)
const actR = rOrch.find(b => /aimb-log\.mjs/.test(b)) || ''
const snip = actR.slice(actR.indexOf('Report your status with:'), actR.lastIndexOf('\nKeep your board true')) || ''
const lines = snip.split('\n'), cmd = lines[0].replace(/^Report your status with: /, '')
const BASE = `"${NODE}" "${fwd(LOGGER)}" --session "Orch" --project "SixC" --token-file "${TF}"`   // the session's ready command (no address)
const want = `${BASE} --agent <your-key> --label "<your name>" --under <item-key>`
const sameNode = (a, b) => a === b || a.replace(/^"[^"]*node(\.exe)?"/i, '"N"') === b.replace(/^"[^"]*"/, '"N"')
console.log('  {log_snippet} =\n' + snip.split(TF).join('<token-file>').replace(/^/gm, '    | '))
check('{log_snippet} (2.0, §4.3): the EXACT ready-to-run command — absolute node + script paths, --session / --project, #75\'s --token-file, then --agent <your-key> --label "<your name>" --under <item-key> for the orchestrator to fill', sameNode(cmd, want), J([cmd.split(TF).join('<tf>'), want.split(TF).join('<tf>')]))
check('#89 {log_snippet}: the command + ONE guidance line (≤ 110 chars): run it with --guide agent first — that puts you on the board and prints the rules (they come from the script itself)', lines.length === 2 && lines[1] === '- First run it with --guide agent in place of --text: that puts you on the board and prints the rules.' && lines[1].length <= 110, J(lines.map(l => l.length)))
// a plan item for the agents to sit under (the orchestrator's own --key), then the snippet's command with --guide agent
const item = runLog([LOGGER, '--session', 'Orch', '--project', 'SixC', '--token-file', tokFile, '--key', 'spec', '--label', 'Spec', '--text', '@writing the spec'], { AI_BRIDGE_CONFIG: cfg1 })
const fill = (c, key, label) => c.replace('<your-key>', key).replace('"<your name>"', `"${label}"`).replace('<item-key>', 'spec')
const gRun = runLog(argvOf(fill(cmd, 'research', 'Research') + ' --guide agent').slice(1), { AI_BRIDGE_CONFIG: cfg1 }), G = gRun.stdout
console.log('  --guide agent =\n' + G.split(TF).join('<token-file>').replace(/^/gm, '    | '))
const gL = G.trimEnd().split('\n')
check('harness: the orchestrator\'s plan item "Spec" (--key spec --label Spec)', item.code === 0 && item.out?.ok === true && item.out?.node?.key === 'spec', J([item.code, item.out]))
check('#89 → 2.0 --guide agent (the snippet\'s command, filled): exit 0, plain text — "You are the agent research", its own ready command (--token-file, --agent "research", --text), keys made once with --label, a leading @ sets the line, the checklist first (--item <k> "<label>"), a live item (--state running --text "@…"), unplanned work first, "<name> (2)", milestones + --stale-after 60m, --ask/--choice/--wait, finish --state done --text "@<summary>", never secrets, the gateway it asked — and no 1.7x form (@~, --plan, --path)',
  gRun.code === 0 && gL[0] === `ACTIVITY BOARD — how to report your work (aimb-log ${VER}, gateway ${VER})` && /You are the agent research on the Ai MCP Bridge dashboard/.test(G) && sameNode(gL[2].trim(), `${BASE} --agent "research" --text "<text>"`)
  && /--key <k> names YOUR node\. Make it once with --label "<name>" \(needed\) and --under <k>; then just --key <k>\./.test(G) && /--text "@<what>" sets the node's line; plain --text "…" only logs\./.test(G)
  && /Make your checklist first: --item <k> "<label>" \(repeat it\); tick one with --key <k> --done\./.test(G) && /--key <k> --state running --text "@<what you are doing>"/.test(G)
  && /not on your checklist: add it as an item FIRST/.test(G) && /becomes "<name> \(2\)"/.test(G) && /milestones only/.test(G) && /--stale-after 60m/.test(G) && /--ask "…" --choice "A" --choice "B" --wait 30m/.test(G)
  && /Finish with --state done --text "@<summary>" \(or failed\)/.test(G) && /Never put secrets/.test(G) && !/@~|--plan|--path|--choices/.test(G), J([gRun.code, G.slice(0, 600), gRun.stderr.slice(0, 200)]))
const guideLong = L => L.filter(l => !l.includes(TF) && !l.startsWith('(') && l.length > 110)   // every line but the command lines and the result / source lines
check('2.0 guide: every line of the agent guide (but its command line) is ≤ 110 characters (§4.3), ≥ 10 rule lines', gL.filter(l => l.startsWith('- ')).length >= 10 && !guideLong(gL).length, J(guideLong(gL)))
const bG = await until(async () => (await call(G1, 'activity', { session: 'Orch' })).sessions || [], b => !!nodeAt(b, 'Orch', 'Spec/Research'), 5000)
const rsN = nodeAt(bG, 'Orch', 'Spec/Research'), specN = nodeAt(bG, 'Orch', 'Spec')
check('§4.4 --guide agent WITH --agent / --label / --under is the agent\'s FIRST REPORT: the agent is created UNDER the item (kind agent, key research, state running, the line "reading the guide") and the last line says so (label, path, key, id) after the source line',
  rsN?.kind === 'agent' && rsN?.key === 'research' && rsN?.parent_id === specN?.id && rsN?.state === 'running' && rsN?.current?.text === 'reading the guide'
  && gL.at(-2) === `(Guide source: built into aimb-log ${VER}; the realm publishes no agent guide.)` && gL.at(-1) === `(You are on the board now as "Research" — Spec/Research; key research, id ${rsN?.id}.)`, J([rsN, gL.slice(-2)]))
const sRun = runLog(argvOf(cmd.replace(' --agent <your-key> --label "<your name>" --under <item-key>', '') + ' --guide session').slice(1), { AI_BRIDGE_CONFIG: cfg1 }), SG = sRun.stdout
check('#89 → 2.0 --guide session: an orchestrator\'s rules — the headline (--text "@…", no --key), a context made once by key + its --item <key> "<label>" items, unplanned work first, tick only after checking the work, the TWO-line agent brief (run … --agent <key> --label "<its name>" --under fix-x --guide agent + its checklist); notices summarised for the user',
  sRun.code === 0 && /--text "@<what you are doing now>" \(no --key = your own session line\)/.test(SG) && /--key rel --label "Next release"/.test(SG) && /--key rel --item fix-x "Fix X" --item docs "Docs"/.test(SG) && /not on the plan: add it as an item FIRST/.test(SG) && /Tick an item only after you have checked the work: --key fix-x --done/.test(SG)
  && SG.split('\n').some(l => sameNode(l.replace(/^ *Before you start, run: /, ''), `${BASE} --agent <key> --label "<its name>" --under fix-x --guide agent`)) && /activity_changed \/ activity_message \/ activity_answer/.test(SG) && !/@~|--plan|--path/.test(SG) && !guideLong(SG.trimEnd().split('\n')).length, J([sRun.code, SG.slice(0, 400), guideLong(SG.trimEnd().split('\n'))]))
const gBad = runLog([LOGGER, '--session', 'Orch', '--project', 'SixC', '--guide', 'robot'], { AI_BRIDGE_CONFIG: cfg1 })
check('#89 --guide takes agent / session only (exit 64, usage)', gBad.code === 64 && gBad.out?.code === 'usage' && /agent \/ session/.test(gBad.out?.what || ''), J([gBad.code, gBad.out]))
const orchB = actR.slice(0, actR.indexOf('Report your status with:')), ownB = actR.slice(actR.lastIndexOf('\nKeep your board true'))
check('briefing (2.0): the code reminder tells an orchestrator to paste the block into each agent\'s prompt with --agent <its key> --label "<its name>" --under <its plan item\'s key> and a checklist, ticking the item itself after checking the work; its own board stays true — text "@<what you are doing>" current, unplanned work added as an item first, an item reopened (state running) when work resumes; no placeholder left, no "@~"',
  /Paste this into each prompt with --agent <its key> --label "<its name>" --under <its plan item's key> \(you tick the item after checking its work\) and a checklist/.test(orchB) && /--guide agent/.test(snip)
  && /text "@<what you are doing>" current/.test(ownB) && /unplanned work added as an item first/.test(ownB) && /an item reopened \(state running\) when work resumes/.test(ownB) && !/\{\w+\}/.test(actR) && !/@~/.test(actR), actR.split(TF).join('<tf>'))
const hintR = rCow.find(b => /log tool/.test(b)) || '', hint = hintR.slice(hintR.indexOf('Report your status with the log tool'), hintR.includes('\nHanding work to agents') ? hintR.indexOf('\nHanding work to agents') : undefined)   // #79: the orchestrator briefing follows the hint
check('{log_tool_hint} (2.0): a COWORK session gets the log-tool form — as:"Cow", text:"@…" sets the line, a task made once by key + label, plan:[{ key, label }], a tick by key + state done, "<label> (2)", stale_after, finish with state:"done", text:"@<summary>", no secrets, a question — 8 lines, no script path, no "@~"',
  /log\(\{ as:"Cow", secret, text \}\) — add key:"<k>" \(\+ label the first time\) for a task\./.test(hint) && /text:"@<what>" sets the node's line; plain text only logs/.test(hint) && /key:"docs", label:"Write the docs"/.test(hint) && /plan:\[\{ key:"a", label:"A" \}, …\]/.test(hint) && /key:"a", state:"done"/.test(hint)
  && /"<label> \(2\)"/.test(hint) && /stale_after:"60m"/.test(hint) && /state:"done", text:"@<summary>"/.test(hint) && /Never put secrets/.test(hint) && /ask:"…", choices:\["A","B"\]/.test(hint) && /activity_answer/.test(hint)
  && !/aimb-log|aimb-doorbell/.test(hint) && !/@~/.test(hintR) && hint.split('\n').length === 8
  && /Give each agent:"<key>", label:"<its name>" and under:"<the plan item's key>" plus a checklist; it ticks items and ends with state:"done", text:"@<summary>"\. Keep your plan true: add unplanned work as an item first; reopen an item \(state:"running"\) when work resumes/.test(hintR) && !/\{\w+\}/.test(hintR), hintR)
check('reminder audience: the code session does NOT get the cowork reminder, and the cowork session gets neither the doorbell nor the script', !rOrch.some(b => /log tool: log\(/.test(b) && /as:"Orch"/.test(b) && !/aimb-log/.test(b)) && !rCow.some(b => /aimb-doorbell|aimb-log/.test(b)), J([rOrch.length, rCow.length]))
const wake = await call(G1, 'set_wake', { as: 'Orch', secret: 'o' })
check('#75: set_wake\'s code hint carries --token-file "<path>" and says the token comes from it', (wake.command || '').endsWith(`--token-file "${TF}"`) && /the token comes from --token-file/.test(wake.hint || ''), wake.hint)
await call(G1, 'list_behaviors', { as: 'Orch', secret: 'o' })
// run the snippet's command VERBATIM (placeholders filled, + the agent's --text) — the token-FILE is its only token source
const argv = argvOf(fill(cmd, 'helper', 'Helper') + ' --text "@hello from the snippet"')
check('harness: the snippet\'s argv = node + the script + flags', argv[0] === NODE && fwd(argv[1]) === fwd(LOGGER) && argv.includes('--token-file') && J(argv.slice(-8)) === J(['--agent', 'helper', '--label', 'Helper', '--under', 'spec', '--text', '@hello from the snippet']), J(argv.slice(1).map(a => a.split(TF).join('<tf>'))))
const r1 = runLog(argv.slice(1), { AI_BRIDGE_CONFIG: cfg1 })
const b1 = await until(async () => (await call(G1, 'activity', { session: 'Orch' })).sessions || [], b => !!nodeAt(b, 'Orch', 'Spec/Helper'), 5000)
check('aimb-log --token-file: the snippet\'s command, run as is, reports (exit 0) — the agent is created under the item with its line', r1.code === 0 && r1.out?.ok === true && r1.out?.node?.created === true && nodeAt(b1, 'Orch', 'Spec/Helper')?.kind === 'agent' && nodeAt(b1, 'Orch', 'Spec/Helper')?.current?.text === 'hello from the snippet', J([r1.code, r1.out, r1.stderr.slice(0, 300)]))
// the agent reports, then re-reads its guide: nothing is written (§4.4)
const rw = runLog(argvOf(fill(cmd, 'research', 'Research') + ' --text "@drafting section 2"').slice(1), { AI_BRIDGE_CONFIG: cfg1 })
const g2 = runLog(argvOf(fill(cmd, 'research', 'Research') + ' --guide agent').slice(1), { AI_BRIDGE_CONFIG: cfg1 })
const b2 = ((await call(G1, 'activity', { session: 'Orch' })).sessions || [])
check('§4.4 a RE-READ of the guide (the agent already on the board) writes nothing: "(Already on the board as …: nothing written.)", the running line stays', rw.code === 0 && g2.code === 0 && g2.stdout.trimEnd().split('\n').at(-1) === '(Already on the board as "Research" — Spec/Research: nothing written.)' && nodeAt(b2, 'Orch', 'Spec/Research')?.current?.text === 'drafting section 2', J([rw.code, g2.code, g2.stdout.slice(-200), nodeAt(b2, 'Orch', 'Spec/Research')?.current]))
const wrongF = path.join(tmp, 'wrong.txt'); fs.writeFileSync(wrongF, 'not-the-token')
const r2 = runLog([LOGGER, '--session', 'Orch', '--project', 'SixC', '--token-file', wrongF, '--ws-port', String(tp(14701)), '--text', 'x'], { AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_CONFIG: cfg1 })
check('aimb-log --token-file is AUTHORITATIVE: a wrong file fails (exit 4 unauthorized) even with the right token in AI_BRIDGE_TOKEN', r2.code === 4 && r2.out?.ok === false, J([r2.code, r2.out]))
const missing = path.join(tmp, 'no such dir', 'token.txt')
const r3 = runLog([LOGGER, '--session', 'Orch', '--project', 'SixC', '--token-file', missing, '--ws-port', String(tp(14701)), '--text', 'x'], { AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_CONFIG: cfg1 })
check('aimb-log --token-file unreadable → exit 64, the JSON names the file (code no-token) — never a silent fallback', r3.code === 64 && r3.out?.code === 'no-token' && r3.out?.what.includes(missing) && r3.out?.token_file === missing, J([r3.code, r3.out]))
const envTok = path.join(tmp, 'bridge.env'); fs.writeFileSync(envTok, `AI_BRIDGE_PROJECT=SixC\nAI_BRIDGE_TOKEN=${TOKEN}\n`)
const r4 = runLog([LOGGER, '--session', 'Orch', '--project', 'SixC', '--token-file', envTok, '--ws-port', String(tp(14701)), '--agent', 'envfile', '--label', 'Env file', '--text', '@via a KEY=VALUE env file'], { AI_BRIDGE_CONFIG: cfg1 })
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

// ================================================================= 2. two 2.0 hosts: run boundary, pruned, counts
const HA = 'SIXC-A', HB = 'SIXC-B', dirA = fs.mkdtempSync(path.join(tmp, 'pA-')), dirB = fs.mkdtempSync(path.join(tmp, 'pB-'))
const cfgA0 = path.join(tmp, 'cfgA0.json'); fs.writeFileSync(cfgA0, J({ activity: { log_retention_days: 30 } }))
const cfgAB = path.join(tmp, 'cfgAB.json'); fs.writeFileSync(cfgAB, J({ activity: { log_retention_days: 3 } }))
const envAB = { AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', AI_BRIDGE_TEST_GOSSIP: '' }
const envA = { ...envAB, AI_BRIDGE_PORT: String(tp(14710)), AI_BRIDGE_WS_PORT: String(tp(14711)), AI_BRIDGE_BIND: '127.0.0.2', AI_BRIDGE_ADVERTISE_HOST: '127.0.0.2', AI_BRIDGE_TEST_HOSTNAME: HA, AI_BRIDGE_SEEDS: '127.0.0.1:' + tp(14712), AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: dirA }
const urlA = 'ws://127.0.0.2:' + tp(14711)
const say = (...args) => runLog([LOGGER, '--session', 'Runner', '--project', 'SixC', '--url', urlA, ...args], { AI_BRIDGE_TOKEN: TOKEN })
const now0 = Date.now(), dayOld = localDay(now0 - 4 * DAY), dayPrev = localDay(now0 - DAY), hostDir = F.hostDir(dirA, HA)
// A's history, written through 2.0 gateways on A's own (shifted) clock: 4 days ago, then 1 day ago
const A0 = await spawn('SixcA0', { ...envA, AI_BRIDGE_CONFIG: cfgA0, AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: String(-4 * DAY) })
await call(A0, 'my_identity')
const h0 = [say('--text', '@runner up'), say('--agent', 'old', '--label', 'Old', '--text', '@old: created 4 days ago')]
await stop(A0)
const A1 = await spawn('SixcA1', { ...envA, AI_BRIDGE_CONFIG: cfgA0, AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: String(-DAY) })
await call(A1, 'my_identity')
const h1 = [say('--agent', 'old', '--text', 'old: day -1')]
await stop(A1)
const daysBefore = F.days(dirA, HA)
check('harness: A\'s history was written by 2.0 gateways on its shifted clock — day files 4 days ago and 1 day ago', [...h0, ...h1].every(r => r.code === 0 && r.out?.ok) && daysBefore.includes(dayOld) && daysBefore.includes(dayPrev), J([[...h0, ...h1].map(r => [r.code, r.out?.code]), daysBefore]))
// now: A (log_retention_days 3: the 4-day-old file goes at startup) and B, linked (gossip v6)
const A = await spawn('SixcA', { ...envA, AI_BRIDGE_CONFIG: cfgAB })
const B = await spawn('SixcB', { ...envAB, AI_BRIDGE_CONFIG: cfgAB, AI_BRIDGE_PORT: String(tp(14712)), AI_BRIDGE_WS_PORT: String(tp(14713)), AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_ADVERTISE_HOST: '127.0.0.1', AI_BRIDGE_TEST_HOSTNAME: HB, AI_BRIDGE_SEEDS: '127.0.0.2:' + tp(14710), AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: dirB })
await call(A, 'my_identity'); await call(B, 'my_identity')
// the RUN BOUNDARY: an agent's first run (3 notes + done), dismissed from the board (a ghost), then back with the same key (a new run of the same id)
const run1 = [say('--agent', 'research', '--label', 'Research', '--text', 'run 1 note 1'), say('--agent', 'research', '--text', 'run 1 note 2'), say('--agent', 'research', '--text', 'run 1 note 3'), say('--agent', 'research', '--state', 'done', '--text', '@run 1 done')]
const rid = run1[0].out?.node?.id
const dash = await new Promise(resolve => {
  const ws = new WebSocket(urlA), d = { ws, msgs: [], n: 0 }
  d.act = async q => { const ref = `a${++d.n}`; ws.send(J({ type: 'activity_action', ref, ...q })); const m = await until(async () => d.msgs.find(x => x.type === 'activity_action' && x.ref === ref), x => !!x, 8000, 50); return (m && m.result) || { ok: false, code: 'no-answer' } }
  ws.on('open', () => ws.send(J({ type: 'hello', kind: 'dashboard', instance: 'six', token: TOKEN })))
  ws.on('message', raw => { const s = String(raw); seen.push(s); const m = JSON.parse(s); d.msgs.push(m); if (m.type === 'welcome') resolve(d) })
  ws.on('error', () => resolve(d)); setTimeout(() => resolve(d), 8000)
})
const dis = await dash.act({ host: HA, session: 'Runner', project: 'SixC', user: 'robin', id: rid, action: 'dismiss' })
try { dash.ws.close() } catch { }
await call(A, 'my_identity')
const run2 = []
for (let i = 1; i <= 4; i++) run2.push(i === 1 ? say('--agent', 'research', '--label', 'Research', '--text', 'run 2 note 1') : say('--agent', 'research', '--text', `run 2 note ${i}`))
const oldT = say('--agent', 'old', '--text', 'old: today')
check('harness: run 1 of agent "research" (3 notes, done), DISMISSED from the board (a dashboard action by id), then run 2 with the SAME key: the same node id, created again (§3.7: a ghost\'s key re-used = a new run)',
  [...run1, ...run2, oldT].every(r => r.code === 0 && r.out?.ok) && /^[a-z2-7]{16}$/.test(rid || '') && dis.ok === true && run2[0].out?.node?.id === rid && run2[0].out?.node?.created === true, J([[...run1, ...run2].map(r => [r.code, r.out?.code]), dis, run2[0].out?.node]))
const bB = await until(async () => (await call(B, 'activity')).sessions || [], b => !!nodeAt(b, 'Runner', 'Research', HA) && !!nodeAt(b, 'Runner', 'Old', HA) && nodeAt(b, 'Runner', 'Old', HA)?.current?.text === 'old: day -1' && (nodeAt(b, 'Runner', 'Research', HA)?.log_n || 0) >= 4, 15000)
const bA = (await call(A, 'activity', { session: 'Runner' })).sessions || []
check('harness: A\'s retention deleted the 4-day-old day file (with its index) at startup and kept the 1-day-old one; B holds A\'s board (gossip v6)', !F.days(dirA, HA).includes(dayOld) && !fs.existsSync(F.indexFile(dirA, HA, dayOld)) && F.days(dirA, HA).includes(dayPrev) && !!nodeAt(bB, 'Runner', 'Research', HA) && sessOf(bB, 'Runner', HA)?.remote === true, J([F.days(dirA, HA), (sessOf(bB, 'Runner', HA)?.nodes || []).map(n => n.path)]))
check('6c counts over gossip v6: B\'s board shows each of A\'s nodes with its OWNER\'s entry count (log_n)', ['Research', 'Old', ''].every(p => nodeAt(bB, 'Runner', p, HA)?.log_n > 0 && nodeAt(bB, 'Runner', p, HA)?.log_n === nodeAt(bA, 'Runner', p)?.log_n),
  J(['Research', 'Old', ''].map(p => [p, nodeAt(bB, 'Runner', p, HA)?.log_n, nodeAt(bA, 'Runner', p)?.log_n])))
const texts = l => (l?.entries || []).map(e => e.text)
const lA = await call(A, 'activity', { log: { session: 'Runner', id: rid } })
check('6c run boundary (local, on A): the history stops at the start of the CURRENT run (run_start + earlier_cursor f2.…)', J(texts(lA.log)) === J(['run 2 note 4', 'run 2 note 3', 'run 2 note 2', 'run 2 note 1']) && lA.log?.run_start === true && /^f2\./.test(lA.log?.earlier_cursor || '') && lA.log?.next_cursor === null && !lA.log?.pruned, J(lA.log && { ...lA.log, entries: texts(lA.log) }))
const rB = await call(B, 'activity', { log: { session: 'Runner', path: 'Research' } })
check('6c run boundary (remote, through B): the owner pages it the same way — from_host A, run_start + earlier_cursor', rB.from_host === HA && J(texts(rB.log)) === J(['run 2 note 4', 'run 2 note 3', 'run 2 note 2', 'run 2 note 1']) && rB.log?.run_start === true && !!rB.log?.earlier_cursor, J(rB.log ? { ...rB, log: { ...rB.log, entries: texts(rB.log) } } : rB))
const eB = await call(B, 'activity', { log: { session: 'Runner', path: 'Research', cursor: rB.log?.earlier_cursor, earlier: true } })
check('6c "show earlier runs" (remote): cursor = earlier_cursor + earlier:true continues past the boundary into the earlier run', J(texts(eB.log)) === J(['run 1 done', 'run 1 note 3', 'run 1 note 2', 'run 1 note 1']) && eB.log?.earlier === true && !eB.log?.run_start && eB.log?.next_cursor === null && !eB.log?.pruned, J(eB.log ? { ...eB.log, entries: texts(eB.log) } : eB))
const oA = await call(A, 'activity', { log: { session: 'Runner', path: 'Old' } }), oB = await call(B, 'activity', { log: { session: 'Runner', path: 'Old' } })
check('6c pruned: a run that began in a day file retention deleted ends in pruned:true — locally and through B — never a silent gap (and never run_start)', oA.log?.pruned === true && !oA.log?.run_start && oB.from_host === HA && oB.log?.pruned === true && J(texts(oB.log)) === J(['old: today', 'old: day -1']) && J(texts(oA.log)) === J(texts(oB.log)), J([oA.log?.pruned, oA.log?.run_start, texts(oA.log), oB.log?.pruned, texts(oB.log)]))
const sA = await call(A, 'activity', { log: { session: 'Runner' } })
check('6c pruned: the session\'s own run began in that deleted file too (pruned); a child\'s new run is no boundary for it (its run 2 shows, its run 1 is an earlier run)', sA.log?.pruned === true && !sA.log?.run_start && texts(sA.log).includes('run 2 note 1') && texts(sA.log).includes('old: day -1') && !texts(sA.log).includes('run 1 note 1') && !texts(sA.log).some(t => /4 days ago/.test(t)), J(sA.log && [sA.log.pruned, sA.log.run_start, texts(sA.log)]))
await stop(A); await stop(B)

// ================================================================= 3. AUTO-ABANDON through the clock hook (step 10, Q72: the 2.0 board)
const dirE = fs.mkdtempSync(path.join(tmp, 'pE-')), cfgE = path.join(tmp, 'cfgE.json'); fs.writeFileSync(cfgE, J({ token: TOKEN, activity: { abandoned_plan_days: 1 } }))
const envE = { AI_BRIDGE_CONFIG: cfgE, AI_BRIDGE_PORT: String(tp(14720)), AI_BRIDGE_WS_PORT: String(tp(14721)), AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: dirE, AI_BRIDGE_ACTIVITY_GC_MS: '300' }
const HOUR = 3600000
const E1 = await spawn('SixcE1', envE)
const hostE = (await call(E1, 'my_identity')).host || os.hostname()
const sayE = (...args) => runLog([LOGGER, '--session', 'Ghosty', '--project', 'SixC', '--ws-port', String(tp(14721)), ...args], { AI_BRIDGE_CONFIG: cfgE })
const s1 = sayE('--key', 'n70', '--label', '#70', '--text', '@the plan', '--item', 'a', 'A', '--item', 'b', 'B')
const s2 = sayE('--key', 'a', '--done')
await sleep(1500)
const e1 = await call(E1, 'activity', { session: 'Ghosty' })
check('auto-abandon (setup): a script-only session\'s plan — A done, B open — and nothing abandoned within the day', s1.code === 0 && s2.code === 0 && nodeAt(e1.sessions, 'Ghosty', '#70/B')?.state === 'todo' && nodeAt(e1.sessions, 'Ghosty', '#70/A')?.state === 'done' && nodeAt(e1.sessions, 'Ghosty', '#70')?.state === 'running',
  J([s1.code, s1.out, s2.code, s2.out, (sessOf(e1.sessions, 'Ghosty')?.nodes || []).map(n => [n.path, n.state])]))
await stop(E1)
const E2 = await spawn('SixcE2', { ...envE, AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: String(2 * DAY + HOUR) })
const e2 = await until(async () => (await call(E2, 'activity', { session: 'Ghosty' })).sessions || [], b => nodeAt(b, 'Ghosty', '#70/B')?.state === 'abandoned' && nodeAt(b, 'Ghosty', '#70')?.state === 'abandoned', 10000)
check('auto-abandon: restarted 2 days later (the clock hook; abandoned_plan_days 1), the gateway abandons the gone session\'s open item and the plan node; the done item stays done', nodeAt(e2, 'Ghosty', '#70/B')?.state === 'abandoned' && nodeAt(e2, 'Ghosty', '#70')?.state === 'abandoned' && nodeAt(e2, 'Ghosty', '#70/A')?.state === 'done',
  J((sessOf(e2, 'Ghosty')?.nodes || []).map(n => [n.path, n.state])))
const lgE = await call(E2, 'activity', { log: { session: 'Ghosty', path: '#70' } })
const byBr = (lgE.log?.entries || []).filter(e => e.by === 'bridge')
check('auto-abandon: logged as entries attributed to the bridge (by:"bridge", "abandoned by the bridge — the session has been gone 1 day"), newest first in the plan\'s log', byBr.length === 2 && byBr.every(e => e.state === 'abandoned' && e.text === 'abandoned by the bridge — the session has been gone 1 day') && J(byBr.map(e => e.path)) === J(['#70', '#70/B']),
  J(lgE.log?.entries?.map(e => [e.path, e.state, e.by, e.text])))
const dayE = localDay(Date.now() + 2 * DAY + HOUR)
const recE = F.readDay(dirE, hostE, dayE).map(l => l.rec).filter(Boolean)
check('auto-abandon: … and persisted in the (shifted) day\'s file as v6 entries with by:"bridge"', recE.filter(r => r.by === 'bridge' && r.v === 6 && r.state === 'abandoned' && r.kind == null).length === 2, J([hostE, dayE, recE.map(r => [r.kind || 'entry', r.at, r.state, r.by])]))
await stop(E2)

check('no response, reminder, script output or error EVER contained the realm token', !seen.some(t => t.includes(TOKEN)), seen.filter(t => t.includes(TOKEN)).length)
console.log(`\n${pass} passed, ${fail} failed`)
for (const h of [...all]) { try { await h.transport.close() } catch { } }
await sleep(400)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
