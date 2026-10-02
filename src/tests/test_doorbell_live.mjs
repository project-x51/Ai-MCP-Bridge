// Doorbell (#39) — live proof that a `listener` leaf is pushed waiting-mail COUNTS and nothing else,
// and that the shipped client script exits with the right code so a caller can be woken by it.
// #67: with no --timeout the script chimes at the top of the next hour (reason:"hourly" + display guidance);
// the AIMB_DOORBELL_PERIOD_SEC test hook shortens that period so the chime is provable in seconds.
// #69: chimes on a 6-hour mark (00/06/12/18:00 local) add inbox_check:true + "call your inbox tool now" guidance;
// AIMB_DOORBELL_CHECKIN_EVERY moves the mark (every k-th boundary) so both sides are provable in seconds.
// AIMB_DOORBELL_TEST_TOOLS=<dir> points the script + clock-helper checks at another tools/ dir (used to prove the
// new checks FAIL on a pre-change copy); default = this tree's tools/.
// #73: a name NOT on the roster when the listener arms gets {type:"unknown"} (script: reason "peer-unknown", exit 0,
// re-register guidance, NOT silent); one that was there and LEFT while armed keeps `gone`/"peer-gone". A tiny fake
// listener server stands in for a <1.55 bridge (no `unknown` frame) to prove the script's early-gone hot-loop guard.
// AIMB_DOORBELL_TEST_BRIDGE=<path to bridge.mjs> runs the bridge half against another copy (pre-change proof).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import WebSocket, { WebSocketServer } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const TOOLSDIR = process.env.AIMB_DOORBELL_TEST_TOOLS ? path.resolve(process.env.AIMB_DOORBELL_TEST_TOOLS) : path.join(SRCDIR, 'tools')
const DOORBELL = path.join(TOOLSDIR, 'aimb-doorbell.mjs')
const BRIDGE = process.env.AIMB_DOORBELL_TEST_BRIDGE ? path.resolve(process.env.AIMB_DOORBELL_TEST_BRIDGE) : path.join(SRCDIR, 'bridge.mjs')
const PORT = '7190', WSPORT = '7191', TOKEN = 'doorbelltok'
const PDIR = path.join(os.tmpdir(), 'aimb-doorbell-' + Date.now())
fs.mkdirSync(PDIR, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

const t = new StdioClientTransport({
  command: 'node', args: [BRIDGE], cwd: path.dirname(BRIDGE),
  env: { ...process.env, AI_BRIDGE_NAME: 'GW', AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: WSPORT, AI_BRIDGE_TOKEN: TOKEN,
         AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: PDIR, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none',
         AI_BRIDGE_DOORBELL_PING_MS: '400' },
  stderr: 'pipe',
})
const c = new Client({ name: 'doorbell-test', version: '0' }, { capabilities: {} })
await c.connect(t)
const call = async (n, a = {}) => JSON.parse((await c.callTool({ name: n, arguments: a })).content[0].text)
await sleep(400)

const owner = await call('register_self', { name: 'Owner', secret: 's-own', project: 'DBTEST', user: 'robin', client: 'claude-code' })
const sender = await call('register_self', { name: 'Sender', secret: 's-snd', project: 'DBTEST', user: 'robin', client: 'claude-code' })
await call('claim_topic', { topic: 'virtualization', description: 'vm', exclusive: true, icon: '🖥️', as: owner.peer_id, secret: 's-own' })

// ---- 1. a listener attaches and receives ONLY doorbell frames (no roster / traces / persistence) ----
function listen(watch) {
  const seen = []
  const sock = new WebSocket(`ws://127.0.0.1:${WSPORT}`)
  sock.on('open', () => sock.send(JSON.stringify({ type: 'hello', kind: 'listener', token: TOKEN, watch })))
  sock.on('message', r => { try { seen.push(JSON.parse(r.toString())) } catch {} })
  return { sock, seen, waitFor: async (type, ms = 3000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { const m = seen.find(x => x.type === type); if (m) return m; await sleep(40) }
    return null
  } }
}

const L = listen({ name: 'Owner', project: 'DBTEST' })
const welcome = await L.waitFor('welcome')
check('listener gets a welcome', !!welcome)
check('welcome advertises capabilities.doorbell', !!(welcome && welcome.capabilities && welcome.capabilities.doorbell === true), JSON.stringify(welcome && welcome.capabilities))
check('wake stays false (set_wake still unsupported)', !!(welcome && welcome.capabilities && welcome.capabilities.wake === false))
check('welcome echoes the watch', !!(welcome && welcome.watch && welcome.watch.name === 'Owner'))
check('no mail frame while the inbox is empty', !L.seen.some(m => m.type === 'mail'))

// ---- 2. a DIRECT send rings the doorbell with a direct count ----
await call('send_to_peer', { target: owner.peer_id, subject: 'direct', message: 'hi', as: sender.peer_id, secret: 's-snd' })
const mail = await L.waitFor('mail')
check('direct send rings the doorbell', !!mail)
check('mail carries unread_direct = 1', !!(mail && mail.unread_direct === 1), mail && String(mail.unread_direct))
check('mail carries no topic count yet', !!(mail && Object.keys(mail.topics || {}).length === 0))
check('listener never receives the roster', !L.seen.some(m => m.type === 'roster'))
check('listener never receives traces', !L.seen.some(m => m.type === 'trace' || m.type === 'trace_history'))
check('listener never receives persistence', !L.seen.some(m => m.type === 'persistence'))
check('mail frame leaks no sender identity', !!(mail && !JSON.stringify(mail).includes('Sender')))

// ---- 3. heartbeat proves the link is alive while nothing happens ----
const ping = await L.waitFor('ping', 2000)
check('doorbell heartbeats (ping)', !!ping)

// ---- 4. a TOPIC send is reported separately from the direct count ----
await call('inbox', { for: owner.peer_id, secret: 's-own', cursor: 0 })   // collect -> counts back to 0
await sleep(400)
const L2 = listen({ name: 'Owner', project: 'DBTEST' })
await L2.waitFor('welcome')
await call('send_to_peer', { target: 'topic:virtualization', subject: 'topic', message: 'via topic', as: sender.peer_id, secret: 's-snd' })
const mail2 = await L2.waitFor('mail')
check('topic send rings the doorbell', !!mail2)
check('topic count reported under topics{}', !!(mail2 && Number(Object.values(mail2.topics || {})[0]) === 1), mail2 && JSON.stringify(mail2.topics))
check('topic send did NOT bump unread_direct', !!(mail2 && mail2.unread_direct === 0), mail2 && String(mail2.unread_direct))

// ---- 5. arming AFTER mail already waits fires immediately (must not miss what's there) ----
const L3 = listen({ name: 'Owner', project: 'DBTEST' })
const mail3 = await L3.waitFor('mail')
check('arming with mail already waiting fires at once', !!mail3)

// ---- 6. #73: a watch on a name that is NOT on the roster when it arms reports `unknown` (not `gone`) ----
const L4 = listen({ name: 'NoSuchPeer', project: 'DBTEST' })
const unk = await L4.waitFor('unknown')
check('#73 never-registered peer reports unknown', !!unk, JSON.stringify(L4.seen.map(m => m.type)))
check('#73 never-registered peer does NOT report gone', !L4.seen.some(m => m.type === 'gone'), JSON.stringify(L4.seen.map(m => m.type)))

// ---- 6b. #73: a name that IS registered when the listener arms and then LEAVES still reports `gone` ----
const leaver = await call('register_self', { name: 'Leaver', secret: 's-lv', project: 'DBTEST', user: 'robin', client: 'claude-code' })
const L6 = listen({ name: 'Leaver', project: 'DBTEST' })
await L6.waitFor('welcome')
await sleep(200)
check('#73 registered peer: no unknown/gone while it is there', !L6.seen.some(m => m.type === 'unknown' || m.type === 'gone'), JSON.stringify(L6.seen.map(m => m.type)))
await call('deregister', { peer_id: leaver.peer_id, secret: 's-lv' })
const gone = await L6.waitFor('gone')
check('#73 departed peer (left while armed) reports gone', !!gone, JSON.stringify(L6.seen.map(m => m.type)))
check('#73 departed peer does NOT report unknown', !L6.seen.some(m => m.type === 'unknown'), JSON.stringify(L6.seen.map(m => m.type)))
// project scoping unchanged: the right name in the WRONG project is not a match -> unknown
const L7 = listen({ name: 'Owner', project: 'OTHERPROJ' })
check('#73 name in another project is unknown here (project scoping kept)', !!(await L7.waitFor('unknown')), JSON.stringify(L7.seen.map(m => m.type)))
// a topic-only watch never gets unknown/gone
const L8 = listen({ topic: 'virtualization' })
await L8.waitFor('welcome'); await sleep(300)
check('#73 topic-only watch gets no unknown/gone', !L8.seen.some(m => m.type === 'unknown' || m.type === 'gone'), JSON.stringify(L8.seen.map(m => m.type)))

// ---- 7. a listener with no watch is rejected ----
const L5 = listen({})
const err = await L5.waitFor('error')
check('listener without a watch is rejected', !!(err && err.code === 'watch-required'), JSON.stringify(err))

// ---- 8. the shipped SCRIPT exits 0 with a JSON summary when mail lands ----
for (const l of [L, L2, L3, L4, L5, L6, L7, L8]) { try { l.sock.close() } catch {} }
await call('inbox', { for: owner.peer_id, secret: 's-own', cursor: 0 })   // clear
await sleep(400)
const statusFile = path.join(PDIR, 'doorbell-status.json')
const script = spawn('node', [DOORBELL,
  '--name', 'Owner', '--project', 'DBTEST', '--token', TOKEN, '--url', `ws://127.0.0.1:${WSPORT}`,
  '--timeout', '20', '--status', statusFile], { cwd: SRCDIR })
let out = ''
script.stdout.on('data', d => { out += d.toString() })
await sleep(900)
check('script writes a heartbeat status file while waiting', fs.existsSync(statusFile))
await call('send_to_peer', { target: owner.peer_id, subject: 'wake', message: 'ring', as: sender.peer_id, secret: 's-snd' })
const code = await new Promise(r => script.on('exit', r))
check('script exits 0 on mail', code === 0, 'exit ' + code)
let parsed = null; try { parsed = JSON.parse(out.trim().split('\n').pop()) } catch {}
check('script prints a JSON summary', !!(parsed && parsed.reason === 'mail'), out.trim())
check('summary carries the direct count', !!(parsed && parsed.unread_direct === 1), parsed && String(parsed.unread_direct))
// #51: every exit line is self-timestamped — local ISO-8601 with a tz offset + a unix seconds field
check('mail summary is self-timestamped (exited_at local ISO + exited_at_unix)',
  !!(parsed && typeof parsed.exited_at === 'string' && /T\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/.test(parsed.exited_at) && Number.isInteger(parsed.exited_at_unix)),
  parsed && JSON.stringify({ exited_at: parsed.exited_at, exited_at_unix: parsed.exited_at_unix }))
let st = null; try { st = JSON.parse(fs.readFileSync(statusFile, 'utf8')) } catch {}
check('status file exit write carries the same timestamp', !!(st && st.state === 'mail' && typeof st.exited_at === 'string' && Number.isInteger(st.exited_at_unix)), st && JSON.stringify(st))
// #52: mail is actionable, so it must NOT carry the silent-re-arm guidance (the agent should handle it, not go quiet)
check('mail exit carries NO re-arm guidance', !!(parsed && parsed.guidance === undefined), parsed && parsed.guidance)

// ---- 9. a clean timeout is an EXPECTED termination: exit 0 (not "failed" in the harness), with re-arm guidance (#52) ----
await call('inbox', { for: owner.peer_id, secret: 's-own', cursor: 0 })
await sleep(400)
const script2 = spawn('node', [DOORBELL,
  '--name', 'Owner', '--project', 'DBTEST', '--token', TOKEN, '--url', `ws://127.0.0.1:${WSPORT}`, '--timeout', '1'], { cwd: SRCDIR })
let out2 = ''
script2.stdout.on('data', d => { out2 += d.toString() })
const code2 = await new Promise(r => script2.on('exit', r))
check('clean timeout exits 0 (expected termination, not a failure)', code2 === 0, 'exit ' + code2)
check('timeout summary says so', out2.includes('timeout'), out2.trim())
let parsed2 = null; try { parsed2 = JSON.parse(out2.trim().split('\n').pop()) } catch {}
check('timeout summary is self-timestamped too (#51)',
  !!(parsed2 && parsed2.reason === 'timeout' && /T\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/.test(parsed2.exited_at || '') && Number.isInteger(parsed2.exited_at_unix)),
  out2.trim())
// #52: a routine no-mail wake carries the brief, built-in re-arm guidance so a doorbell loop stays quiet
check('timeout carries the silent re-arm guidance', !!(parsed2 && typeof parsed2.guidance === 'string' && /silent re-arm/i.test(parsed2.guidance)), parsed2 && parsed2.guidance)

// ---- 9b. #75 the realm token from a FILE: a host whose bridge reads AI_BRIDGE_TOKEN_FILE (MCP client config) has
// no token in config.json and the session's shell doesn't inherit the MCP server's env — the doorbell must accept
// --token-file <path> and AI_BRIDGE_TOKEN_FILE (bare token or KEY=VALUE env file), like the bridge (#46).
const tokFile = path.join(PDIR, 'realm.token'), envFile = path.join(PDIR, 'bridge.env')
fs.writeFileSync(tokFile, TOKEN + '\n'); fs.writeFileSync(envFile, `# comment\nAI_BRIDGE_TOKEN=${TOKEN}\nOTHER=x\n`)
const tokEnv = { ...process.env }; delete tokEnv.AI_BRIDGE_TOKEN; delete tokEnv.AI_BRIDGE_TOKEN_FILE
function runNoTokenArg(extraArgs, env = {}) {   // no --token; config.json lookup is defeated by AIMB_DOORBELL_TEST_TOOLS-independent ws url + an empty cfg dir
  const p = spawn('node', [DOORBELL, '--name', 'Owner', '--project', 'DBTEST', '--url', `ws://127.0.0.1:${WSPORT}`, '--timeout', '1', ...extraArgs],
    { cwd: SRCDIR, env: { ...tokEnv, ...env } })
  let o = '', e = ''
  p.stdout.on('data', d => { o += d.toString() }); p.stderr.on('data', d => { e += d.toString() })
  return new Promise(r => p.on('exit', code => { let j = null; try { j = JSON.parse(o.trim().split('\n').pop()) } catch {}; r({ code, j, err: e.trim(), out: o.trim() }) }))
}
await call('inbox', { for: owner.peer_id, secret: 's-own', cursor: 0 })
await sleep(300)
const tf1 = await runNoTokenArg(['--token-file', tokFile])
check('#75 --token-file <bare token file> arms the doorbell (clean timeout, exit 0)', tf1.code === 0 && !!tf1.j && tf1.j.reason === 'timeout', `exit ${tf1.code} ${tf1.out} ${tf1.err}`)
const tf2 = await runNoTokenArg(['--token-file', envFile])
check('#75 --token-file <KEY=VALUE env file> arms the doorbell', tf2.code === 0 && !!tf2.j && tf2.j.reason === 'timeout', `exit ${tf2.code} ${tf2.out} ${tf2.err}`)
const tf3 = await runNoTokenArg([], { AI_BRIDGE_TOKEN_FILE: envFile })
check('#75 AI_BRIDGE_TOKEN_FILE env arms the doorbell', tf3.code === 0 && !!tf3.j && tf3.j.reason === 'timeout', `exit ${tf3.code} ${tf3.out} ${tf3.err}`)
const tf4 = await runNoTokenArg(['--token-file', path.join(PDIR, 'missing.token')])
check('#75 an unreadable --token-file is bad usage (exit 64) and names the file', tf4.code === 64 && /token-file/.test(tf4.err) && /missing\.token/.test(tf4.err), `exit ${tf4.code} ${tf4.err}`)
check('#75 the token value never appears in the doorbell output', ![tf1, tf2, tf3, tf4].some(r => (r.out + r.err).includes(TOKEN)), 'token leaked')

// ---- 10. #67 hourly chime: NO --timeout => exit at the next boundary with reason:"hourly", the boundary's local
// time and DISPLAY guidance (not a silent re-arm). The test hook shortens the hour to a 2-second period. A guard
// kills a script that never chimes (the pre-#67 script would sit on its 1800s default).
function runDoorbell(extraArgs, env = {}, killAfterMs = 15000) {
  const p = spawn('node', [DOORBELL,
    '--name', 'Owner', '--project', 'DBTEST', '--token', TOKEN, '--url', `ws://127.0.0.1:${WSPORT}`, ...extraArgs],
    { cwd: SRCDIR, env: { ...process.env, ...env } })
  let o = ''
  p.stdout.on('data', d => { o += d.toString() })
  const guard = setTimeout(() => { try { p.kill() } catch {} }, killAfterMs)
  const exited = new Promise(r => p.on('exit', code => {
    clearTimeout(guard)
    let j = null; try { j = JSON.parse(o.trim().split('\n').pop()) } catch {}
    r({ code, out: o.trim(), j })
  }))
  return { p, exited }
}
await call('inbox', { for: owner.peer_id, secret: 's-own', cursor: 0 })
await sleep(300)
const chimeStatus = path.join(PDIR, 'doorbell-chime.json')
// #69: every = 43200 puts the check-in mark at 2 s x 43200 = local midnight only, so these chimes are OFF the mark
const OFFMARK = { AIMB_DOORBELL_PERIOD_SEC: '2', AIMB_DOORBELL_CHECKIN_EVERY: '43200' }
const h1 = await runDoorbell(['--status', chimeStatus], OFFMARK).exited
check('hourly chime (no --timeout): exits 0 with reason "hourly"', h1.code === 0 && !!h1.j && h1.j.reason === 'hourly', `exit ${h1.code} ${h1.out}`)
check('hourly chime carries the boundary\'s local time (HH:MM[:SS])', !!(h1.j && /^\d\d:\d\d(:\d\d)?$/.test(h1.j.time || '')), h1.out)
check('hourly chime guidance says DISPLAY the time (not a silent re-arm)',
  !!(h1.j && typeof h1.j.guidance === 'string' && /display the current time/i.test(h1.j.guidance) && h1.j.guidance.includes(h1.j.time) && !/silent/i.test(h1.j.guidance)), h1.j && h1.j.guidance)
check('hourly chime is self-timestamped (#51)', !!(h1.j && /T\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/.test(h1.j.exited_at || '') && Number.isInteger(h1.j.exited_at_unix)), h1.out)
// never early: the exit's local wall clock is AT/AFTER the reported boundary (so a re-arm targets the NEXT one)
const clk = j => (j.exited_at || '').slice(11, 19), lbl = t => t.length === 5 ? t + ':00' : t
check('hourly chime never exits before its boundary', !!(h1.j && h1.j.time && clk(h1.j) >= lbl(h1.j.time)), h1.j && `${clk(h1.j)} vs ${h1.j.time}`)
let stc = null; try { stc = JSON.parse(fs.readFileSync(chimeStatus, 'utf8')) } catch {}
check('status file exit write carries the chime (state/reason/time/guidance)',
  !!(stc && stc.state === 'hourly' && stc.reason === 'hourly' && h1.j && stc.time === h1.j.time && /display/i.test(stc.guidance || '')), stc && JSON.stringify(stc))
// an immediate re-arm must chime at the NEXT boundary — no double chime for the same one
const h2 = await runDoorbell([], OFFMARK).exited
check('re-arm chimes at the NEXT boundary (no double chime)', !!(h1.j && h2.j && h2.j.reason === 'hourly' && h2.j.time && h2.j.time !== h1.j.time), `${h1.j && h1.j.time} then ${h2.j && h2.j.time}`)
// #69: an OFF-mark chime is exactly today's chime — no inbox_check, display-the-time guidance, no inbox call asked for
check('#69 off-mark chime carries NO inbox_check (stdout + status file)',
  !!(h1.j && h2.j && !('inbox_check' in h1.j) && !('inbox_check' in h2.j) && stc && !('inbox_check' in stc)), `${h1.out} | ${h2.out}`)
check('#69 off-mark chime keeps today\'s display-the-time guidance (no inbox call)',
  !!(h1.j && h1.j.guidance === `Top of the hour: display the current time (${h1.j.time}) to the user, then re-arm the doorbell.`), h1.j && h1.j.guidance)

// ---- 10b. #69 6-hour check-in ON the mark: every = 1 makes EVERY boundary a check-in mark, so the next chime is one.
// It keeps reason:"hourly" + time, adds inbox_check:true, and tells the agent to call its inbox tool NOW. ----
const secOfDay = t => { const [h, m, s = 0] = t.split(':').map(Number); return h * 3600 + m * 60 + s }
const ckStatus = path.join(PDIR, 'doorbell-checkin.json')
const k1 = await runDoorbell(['--status', ckStatus], { AIMB_DOORBELL_PERIOD_SEC: '1', AIMB_DOORBELL_CHECKIN_EVERY: '1' }).exited
check('#69 on-mark chime: exit 0, reason still "hourly", time still HH:MM[:SS]',
  k1.code === 0 && !!k1.j && k1.j.reason === 'hourly' && /^\d\d:\d\d(:\d\d)?$/.test(k1.j.time || ''), `exit ${k1.code} ${k1.out}`)
check('#69 on-mark chime carries inbox_check:true', !!(k1.j && k1.j.inbox_check === true), k1.out)
check('#69 on-mark guidance: call the inbox tool NOW even if nothing waits, keeps the bridge loaded, then display + re-arm',
  !!(k1.j && typeof k1.j.guidance === 'string' && k1.j.guidance.includes(k1.j.time) && /call your inbox tool now even if nothing is waiting/i.test(k1.j.guidance)
     && /keeps the Ai MCP Bridge loaded/i.test(k1.j.guidance) && /display the time to the user/i.test(k1.j.guidance) && /re-arm/i.test(k1.j.guidance) && !/silent/i.test(k1.j.guidance)),
  k1.j && k1.j.guidance)
check('#69 on-mark chime never exits before its boundary', !!(k1.j && k1.j.time && clk(k1.j) >= lbl(k1.j.time)), k1.j && `${clk(k1.j)} vs ${k1.j.time}`)
let stk = null; try { stk = JSON.parse(fs.readFileSync(ckStatus, 'utf8')) } catch {}
check('#69 status file exit write carries the check-in (state/reason hourly, time, inbox_check, guidance)',
  !!(stk && k1.j && stk.state === 'hourly' && stk.reason === 'hourly' && stk.time === k1.j.time && stk.inbox_check === true && stk.guidance === k1.j.guidance), stk && JSON.stringify(stk))
// the DEFAULT interval (no knob) is every 6th boundary: with a 2 s period the mark is seconds-since-midnight % 12 === 0
const d1 = await runDoorbell([], { AIMB_DOORBELL_PERIOD_SEC: '2' }).exited
check('#69 default interval: inbox_check exactly when the boundary\'s seconds-since-local-midnight divide by 6 x period',
  !!(d1.j && d1.j.reason === 'hourly' && d1.j.time && ((secOfDay(d1.j.time) % 12 === 0) === (d1.j.inbox_check === true))
     && (d1.j.inbox_check === true || !('inbox_check' in d1.j))), d1.out)

// ---- 11. mail still fires BEFORE the chime (default hourly mode: no --timeout, no test hook). #69: with EVERY hour a
// check-in mark (every = 1), a mail exit is still exactly a mail exit — no inbox_check, no guidance ----
const m1 = runDoorbell([], { AIMB_DOORBELL_CHECKIN_EVERY: '1' })
await sleep(900)
await call('send_to_peer', { target: owner.peer_id, subject: 'wake2', message: 'ring2', as: sender.peer_id, secret: 's-snd' })
const r1 = await m1.exited
check('default (hourly) mode: mail still wakes it first, reason "mail"', r1.code === 0 && !!r1.j && r1.j.reason === 'mail' && r1.j.unread_direct === 1, `exit ${r1.code} ${r1.out}`)
check('mail wake carries no chime fields / guidance', !!(r1.j && r1.j.time === undefined && r1.j.guidance === undefined), r1.out)
check('#69 mail wake carries no inbox_check (even when every hour is a check-in mark)', !!(r1.j && !('inbox_check' in r1.j)), r1.out)
await call('inbox', { for: owner.peer_id, secret: 's-own', cursor: 0 })
await sleep(300)

// ---- 12. an explicit --timeout keeps the old behaviour exactly, even with the period hook set ----
const t1 = await runDoorbell(['--timeout', '3'], { AIMB_DOORBELL_PERIOD_SEC: '1', AIMB_DOORBELL_CHECKIN_EVERY: '1' }).exited
check('explicit --timeout wins over the chime: reason "timeout" + silent re-arm guidance',
  t1.code === 0 && !!t1.j && t1.j.reason === 'timeout' && /silent re-arm/i.test(t1.j.guidance || '') && t1.j.time === undefined, `exit ${t1.code} ${t1.out}`)
check('#69 explicit --timeout exit carries no inbox_check (even with every boundary a check-in mark)', !!(t1.j && !('inbox_check' in t1.j)), t1.out)

// ---- 13. #69 pure clock maths (no waiting): the check-in mark is judged from the BOUNDARY's local wall time ----
let clock = null
try { clock = await import(pathToFileURL(path.join(TOOLSDIR, 'aimb-doorbell-clock.mjs')).href) } catch (e) { console.log('  (clock helper not importable:', String(e && e.message || e).split('\n')[0] + ')') }
const at = (h, m = 0, s = 0, ms = 0) => new Date(2026, 8, 30, h, m, s, ms).getTime()   // LOCAL wall time
const mk = ms => !!(clock && clock.isCheckinMark(ms))
check('#69 pure: 00:00, 06:00, 12:00, 18:00 are check-in marks (1-hour period, every 6)', !!clock && [0, 6, 12, 18].every(h => mk(at(h))), clock ? [0, 6, 12, 18].map(h => mk(at(h))).join(',') : 'no helper')
check('#69 pure: 01:00 and 23:00 are NOT check-in marks', !!clock && !mk(at(1)) && !mk(at(23)), clock ? `${mk(at(1))},${mk(at(23))}` : 'no helper')
check('#69 pure: every other top-of-hour off the 6-hour marks is not a check-in',
  !!clock && Array.from({ length: 24 }, (_, h) => h).every(h => mk(at(h)) === (h % 6 === 0)), 'no helper or mismatch')
// midnight via the REAL boundary maths: armed at 23:59:59.998 the next boundary is the next day's 00:00 — labelled
// "00:00" and a check-in, even though the clock at arm time reads hour 23 (drift must not decide it)
const mid = clock ? clock.nextBoundary(at(23, 59, 59, 998), 3600) : NaN
check('#69 pure: the boundary after 23:59:59.998 is midnight, labelled "00:00", and a check-in',
  !!clock && new Date(mid).getHours() === 0 && new Date(mid).getMinutes() === 0 && clock.hhmm(mid) === '00:00' && clock.isCheckinMark(mid) && !clock.isCheckinMark(at(23, 59, 59, 998)),
  clock ? `${new Date(mid).toString()} ${clock.hhmm(mid)}` : 'no helper')
const six = clock ? clock.nextBoundary(at(17, 59, 59, 998), 3600) : NaN
const aft = clock ? clock.nextBoundary(at(18, 0, 0, 1), 3600) : NaN
check('#69 pure: the boundary after 17:59:59.998 is 18:00 and a check-in; after 18:00:00.001 it is 19:00 and not',
  !!clock && clock.hhmm(six) === '18:00' && clock.isCheckinMark(six) && clock.hhmm(aft) === '19:00' && !clock.isCheckinMark(aft),
  clock ? `${clock.hhmm(six)} / ${clock.hhmm(aft)}` : 'no helper')
check('#69 pure: a test period p marks every 6th multiple of p since local midnight (p=2: 00:00:12 yes, 00:00:10 no)',
  !!clock && clock.isCheckinMark(at(0, 0, 12), 2) && !clock.isCheckinMark(at(0, 0, 10), 2) && clock.isCheckinMark(at(0, 0, 10), 2, 5) && clock.isCheckinMark(at(0, 0, 3), 1, 1),
  'no helper or mismatch')

// ---- 14. #73 the SCRIPT: peer-unknown vs peer-gone, and the legacy-bridge early-gone hot-loop guard ----
function runWatch(name, url, extraArgs = [], env = {}, killAfterMs = 15000) {
  const p = spawn('node', [DOORBELL, '--name', name, '--project', 'DBTEST', '--token', TOKEN, '--url', url, '--timeout', '10', ...extraArgs],
    { cwd: SRCDIR, env: { ...process.env, ...env } })
  let o = ''
  p.stdout.on('data', d => { o += d.toString() })
  const guard = setTimeout(() => { try { p.kill() } catch {} }, killAfterMs)
  const exited = new Promise(r => p.on('exit', code => {
    clearTimeout(guard)
    let j = null; try { j = JSON.parse(o.trim().split('\n').pop()) } catch {}
    r({ code, out: o.trim(), j })
  }))
  return { p, exited }
}
const REREG = /register_self/i
const unkStatus = path.join(PDIR, 'doorbell-unknown.json')
const u1 = await runWatch('Ghost', `ws://127.0.0.1:${WSPORT}`, ['--status', unkStatus]).exited
check('#73 script: never-registered name -> exit 0, reason "peer-unknown"', u1.code === 0 && !!u1.j && u1.j.reason === 'peer-unknown', `exit ${u1.code} ${u1.out}`)
check('#73 script: peer-unknown guidance says re-register (register_self + secret) then re-arm, NOT a silent re-arm',
  !!(u1.j && typeof u1.j.guidance === 'string' && REREG.test(u1.j.guidance) && /secret/i.test(u1.j.guidance) && /re-arm/i.test(u1.j.guidance) && !/silent/i.test(u1.j.guidance)), u1.j && u1.j.guidance)
let stu = null; try { stu = JSON.parse(fs.readFileSync(unkStatus, 'utf8')) } catch {}
check('#73 script: status file exit write says unknown (state/reason/guidance)',
  !!(stu && stu.state === 'unknown' && stu.reason === 'peer-unknown' && u1.j && stu.guidance === u1.j.guidance), stu && JSON.stringify(stu))
// a name that registers, then leaves while the script is armed -> still peer-gone (silent re-arm + re-register hint)
const lv2 = await call('register_self', { name: 'Leaver2', secret: 's-lv2', project: 'DBTEST', user: 'robin', client: 'claude-code' })
const lvStatus = path.join(PDIR, 'doorbell-leaver.json')
const g1p = runWatch('Leaver2', `ws://127.0.0.1:${WSPORT}`, ['--status', lvStatus])
for (let i = 0; i < 50; i++) { let s1 = null; try { s1 = JSON.parse(fs.readFileSync(lvStatus, 'utf8')) } catch {} ; if (s1 && s1.state === 'armed') break; await sleep(100) }
await call('deregister', { peer_id: lv2.peer_id, secret: 's-lv2' })
const g1 = await g1p.exited
check('#73 script: a name that left while armed -> exit 0, reason "peer-gone"', g1.code === 0 && !!g1.j && g1.j.reason === 'peer-gone', `exit ${g1.code} ${g1.out}`)
check('#73 script: peer-gone keeps the silent re-arm and mentions re-registering after a restart',
  !!(g1.j && /silent re-arm/i.test(g1.j.guidance || '') && REREG.test(g1.j.guidance || '')), g1.j && g1.j.guidance)

// a fake listener server stands in for an OLD bridge (no `unknown` frame): welcome{bridge_version}, then `gone` after goneMs
const FAKE_PORT = 13690
let fakeMode = { version: '1.54.0', goneMs: 0 }
const fake = new WebSocketServer({ host: '127.0.0.1', port: FAKE_PORT })
fake.on('connection', sock => sock.on('message', r => {
  let m = null; try { m = JSON.parse(r.toString()) } catch { return }
  if (m.type !== 'hello') return
  sock.send(JSON.stringify({ type: 'welcome', instance: 'fake', gateway: 'FAKE', bridge_version: fakeMode.version, capabilities: {}, watch: m.watch }))
  const g = () => { try { sock.send(JSON.stringify({ type: 'gone', watch: m.watch })) } catch {} }
  fakeMode.goneMs ? setTimeout(g, fakeMode.goneMs) : g()
}))
await new Promise(r => fake.on('listening', r))
const FAKE_URL = `ws://127.0.0.1:${FAKE_PORT}`
fakeMode = { version: '1.54.0', goneMs: 0 }
const e1 = await runWatch('Ferret', FAKE_URL).exited
check('#73 legacy guard: an old bridge\'s instant gone after welcome -> exit 0, reason "peer-unknown" (no hot loop)',
  e1.code === 0 && !!e1.j && e1.j.reason === 'peer-unknown' && e1.j.inferred_from === 'early-gone', `exit ${e1.code} ${e1.out}`)
check('#73 legacy guard: carries the re-register guidance, not the silent re-arm',
  !!(e1.j && REREG.test(e1.j.guidance || '') && !/silent/i.test(e1.j.guidance || '')), e1.j && e1.j.guidance)
fakeMode = { version: '1.54.0', goneMs: 700 }
const e2 = await runWatch('Ferret', FAKE_URL, [], { AIMB_DOORBELL_EARLY_GONE_MS: '200' }).exited
check('#73 legacy guard: a LATE gone from an old bridge stays "peer-gone"', e2.code === 0 && !!e2.j && e2.j.reason === 'peer-gone', `exit ${e2.code} ${e2.out}`)
fakeMode = { version: '1.55.0', goneMs: 0 }
const e3 = await runWatch('Ferret', FAKE_URL).exited
check('#73 legacy guard is gated on the bridge version: an instant gone from a >=1.55 bridge is a real "peer-gone"',
  e3.code === 0 && !!e3.j && e3.j.reason === 'peer-gone', `exit ${e3.code} ${e3.out}`)
await new Promise(r => fake.close(r))

console.log(`\n${pass} passed, ${fail} failed`)
await c.close()
try { fs.rmSync(PDIR, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
