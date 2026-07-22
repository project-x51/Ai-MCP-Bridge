// Doorbell (#39) — live proof that a `listener` leaf is pushed waiting-mail COUNTS and nothing else,
// and that the shipped client script exits with the right code so a caller can be woken by it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const PORT = '7190', WSPORT = '7191', TOKEN = 'doorbelltok'
const PDIR = path.join(os.tmpdir(), 'aimb-doorbell-' + Date.now())
fs.mkdirSync(PDIR, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

const t = new StdioClientTransport({
  command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
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

// ---- 6. a watch on a name that is not on the roster reports `gone` ----
const L4 = listen({ name: 'NoSuchPeer', project: 'DBTEST' })
const gone = await L4.waitFor('gone')
check('unknown/departed peer reports gone', !!gone)

// ---- 7. a listener with no watch is rejected ----
const L5 = listen({})
const err = await L5.waitFor('error')
check('listener without a watch is rejected', !!(err && err.code === 'watch-required'), JSON.stringify(err))

// ---- 8. the shipped SCRIPT exits 0 with a JSON summary when mail lands ----
for (const l of [L, L2, L3, L4, L5]) { try { l.sock.close() } catch {} }
await call('inbox', { for: owner.peer_id, secret: 's-own', cursor: 0 })   // clear
await sleep(400)
const statusFile = path.join(PDIR, 'doorbell-status.json')
const script = spawn('node', [path.join(SRCDIR, 'tools', 'aimb-doorbell.mjs'),
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

// ---- 9. the script exits 2 (re-arm) when nothing arrives before the timeout ----
await call('inbox', { for: owner.peer_id, secret: 's-own', cursor: 0 })
await sleep(400)
const script2 = spawn('node', [path.join(SRCDIR, 'tools', 'aimb-doorbell.mjs'),
  '--name', 'Owner', '--project', 'DBTEST', '--token', TOKEN, '--url', `ws://127.0.0.1:${WSPORT}`, '--timeout', '1'], { cwd: SRCDIR })
let out2 = ''
script2.stdout.on('data', d => { out2 += d.toString() })
const code2 = await new Promise(r => script2.on('exit', r))
check('script exits 2 on timeout (re-arm)', code2 === 2, 'exit ' + code2)
check('timeout summary says so', out2.includes('timeout'), out2.trim())
let parsed2 = null; try { parsed2 = JSON.parse(out2.trim().split('\n').pop()) } catch {}
check('timeout summary is self-timestamped too (#51)',
  !!(parsed2 && parsed2.reason === 'timeout' && /T\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/.test(parsed2.exited_at || '') && Number.isInteger(parsed2.exited_at_unix)),
  out2.trim())

console.log(`\n${pass} passed, ${fail} failed`)
await c.close()
try { fs.rmSync(PDIR, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
