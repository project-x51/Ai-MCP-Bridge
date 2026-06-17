// Live persistence (§12): durable mailboxes. A message to a sub-peer survives a bridge RESTART and is
// re-delivered to the returning peer (same name+secret => same identity), and a consumed message is not.
// Each "restart" is a fresh bridge on a new port sharing the same persistence dir + the same identity.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))

const TOKEN = 'testtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, e)) }
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-live-'))

async function spawnBridge(port) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'PBridge', AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_SWEEP_MS: '5000' }, stderr: 'pipe' })
  const client = new Client({ name: 't-persist', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

// ---- run 1: register Bolletta + a sender, send her 2 messages, then kill the bridge WITHOUT her consuming ----
let B = await spawnBridge(7950); await sleep(700)
const id = await call(B, 'my_identity')
check('persistence facet active (file)', id.profile.persistence === 'file', JSON.stringify(id.profile.persistence))
check('park + retain capabilities advertised', id.capabilities.park === true && id.capabilities.retain === true, JSON.stringify(id.capabilities))
await call(B, 'register_self', { name: 'Bolletta', secret: 'sb', project: 'shared' })
await call(B, 'register_self', { name: 'Sender', secret: 'ss', project: 'shared' })
await sleep(200)
const s1 = await call(B, 'send_to_peer', { target: 'Bolletta', subject: 'm1', message: 'first parked', as: 'Sender', secret: 'ss' })
const s2 = await call(B, 'send_to_peer', { target: 'Bolletta', subject: 'm2', message: 'second parked', as: 'Sender', secret: 'ss' })
check('sends accepted', s1.ok && s2.ok, JSON.stringify([s1.ok, s2.ok]))
await sleep(400)              // let the durable puts flush
await B.transport.close()     // Bolletta's RAM queue is lost here
await sleep(700)

// ---- run 2 (restart): re-register Bolletta -> parked mail re-hydrated ----
B = await spawnBridge(7952); await sleep(700)
const re = await call(B, 'register_self', { name: 'Bolletta', secret: 'sb', project: 'shared' })
check('re-register after restart is a fresh sub-peer (RAM queue was gone)', re.reattached !== true, JSON.stringify(re.reattached))
await sleep(200)
const in1 = await call(B, 'inbox', { for: 'Bolletta', secret: 'sb', cursor: 0 })
const bodies = in1.messages.map(m => m.body)
check('BOTH parked messages survived the restart', bodies.includes('first parked') && bodies.includes('second parked'), JSON.stringify(bodies))
check('parked bodies decrypt correctly after restart', in1.messages.every(m => typeof m.body === 'string' && !m.enc), JSON.stringify(bodies))
await call(B, 'inbox', { for: 'Bolletta', secret: 'sb', cursor: in1.next_cursor })   // consume (cursor past) -> ack off the durable mailbox
await sleep(400)
await B.transport.close()
await sleep(700)

// ---- run 3: consumed messages must NOT redeliver ----
B = await spawnBridge(7954); await sleep(700)
await call(B, 'register_self', { name: 'Bolletta', secret: 'sb', project: 'shared' })
await sleep(200)
const in2 = await call(B, 'inbox', { for: 'Bolletta', secret: 'sb', cursor: 0 })
check('consumed messages do NOT redeliver after a later restart', in2.messages.length === 0, JSON.stringify(in2.messages.map(m => m.body)))
await B.transport.close()

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
