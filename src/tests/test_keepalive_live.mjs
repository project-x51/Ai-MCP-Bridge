// #26 keep_alive: a topic released (or claimed) with keep_alive stays ALIVE ownerless — directed sends PARK
// against it instead of bouncing no-owner, and the next session that claims it drains the parked queue.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-keepalive-'))

const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: 'Host', AI_BRIDGE_PORT: '7560', AI_BRIDGE_WS_PORT: '7561', AI_BRIDGE_TOKEN: 'testtok',
    AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
const B = { client: new Client({ name: 'test-keepalive', version: '0' }, { capabilities: {} }), transport }
await B.client.connect(transport); await sleep(500)
const call = async (n, a = {}) => JSON.parse((await B.client.callTool({ name: n, arguments: a })).content[0].text)

await call('register_self', { name: 'Owner', secret: 'o', project: 'demo' })
await call('register_self', { name: 'Sender', secret: 's', project: 'demo' })
await call('register_self', { name: 'NewOwner', secret: 'n', project: 'demo' })
await sleep(150)

// --- keep_alive at CLAIM time, inherited on release
const claimed = await call('claim_topic', { topic: 'analysis', exclusive: true, keep_alive: true, icon: '📊', description: 'the analysis topic', as: 'Owner', secret: 'o' })
check('claim with keep_alive reports it', claimed.ok === true && claimed.keep_alive === true, JSON.stringify(claimed))
const rel = await call('release_topic', { topic: 'analysis', as: 'Owner', secret: 'o' })   // no flag here -> inherits claim's keep_alive
check('release inherits keep_alive -> kept_alive', rel.ok === true && rel.kept_alive === true, JSON.stringify(rel))

// --- a directed send now PARKS against the ownerless topic (not no-owner)
const sent = await call('send_to_peer', { target: 'topic:analysis', subject: 'work', message: 'handoff payload', verb: 'do_analysis', as: 'Sender', secret: 's' })
check('send to ownerless kept-alive topic parks (not no-owner)', sent.ok === true && sent.parked === true && sent.ownerless === true, JSON.stringify(sent))

// --- a different session claims it -> the parked queue drains to the new owner
const reclaim = await call('claim_topic', { topic: 'analysis', exclusive: true, as: 'NewOwner', secret: 'n' })
check('reclaim drains the parked queue', reclaim.ok === true && reclaim.drained === 1, JSON.stringify(reclaim))
check('reclaim inherits the kept icon', reclaim.icon === '📊', JSON.stringify(reclaim))
await sleep(200)
const got = await call('inbox', { for: 'NewOwner', secret: 'n', cursor: 0 })
check('new owner received the handed-off message', got.messages.some(m => m.body === 'handoff payload' && m.verb === 'do_analysis'), JSON.stringify(got.messages.map(m => m.body)))
// the marker is consumed: a fresh send now has a LIVE owner (delivered, not parked)
const live = await call('send_to_peer', { target: 'topic:analysis', subject: 'x', message: 'now live', as: 'Sender', secret: 's' })
check('after reclaim the topic is owned again (delivered, not parked)', live.ok === true && !live.parked, JSON.stringify(live))

// --- keep_alive via the RELEASE flag (topic NOT claimed keep_alive)
await call('claim_topic', { topic: 'triage', exclusive: true, as: 'Owner', secret: 'o' })
const relFlag = await call('release_topic', { topic: 'triage', keep_alive: true, as: 'Owner', secret: 'o' })
check('release_topic {keep_alive} keeps a non-keep_alive claim alive', relFlag.kept_alive === true, JSON.stringify(relFlag))
const sent2 = await call('send_to_peer', { target: 'topic:triage', subject: 'x', message: 'triage parked', as: 'Sender', secret: 's' })
check('send parks against the release-flag kept topic', sent2.ok === true && sent2.ownerless === true, JSON.stringify(sent2))

// --- NEGATIVE: a normal release (no keep_alive) still bounces no-owner
await call('claim_topic', { topic: 'gone', exclusive: true, as: 'Owner', secret: 'o' })
await call('release_topic', { topic: 'gone', as: 'Owner', secret: 'o' })
const bounce = await call('send_to_peer', { target: 'topic:gone', subject: 'x', message: 'void', as: 'Sender', secret: 's' })
check('plain release still bounces no-owner', bounce.ok === false && bounce.code === 'no-owner', JSON.stringify(bounce))

console.log(`\n${pass} passed, ${fail} failed`)
await B.transport.close()
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
