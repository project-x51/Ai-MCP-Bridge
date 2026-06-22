// #32 live: a bridge-wide DEFAULT behaviour reminder (here via AI_BRIDGE_DEFAULT_BEHAVIOR; config.behaviors.default
// is the same path) is attached to EVERY session's delivered messages — even one that never called set_behavior —
// tagged default:true, and is OVERRIDDEN by a session's own all-scope reminder.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const DEFAULT = 'Summarize but do not act without user permission'

const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: 'Host', AI_BRIDGE_PORT: '7600', AI_BRIDGE_WS_PORT: '7601', AI_BRIDGE_TOKEN: 'testtok',
    AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none',
    AI_BRIDGE_DEFAULT_BEHAVIOR: DEFAULT }, stderr: 'pipe' })
const B = { client: new Client({ name: 'test-defbeh', version: '0' }, { capabilities: {} }), transport }
await B.client.connect(transport); await sleep(500)
const call = async (n, a = {}) => JSON.parse((await B.client.callTool({ name: n, arguments: a })).content[0].text)
const reminders = m => (m && m.reminders) || []

const reg = await call('register_self', { name: 'Worker', secret: 'w', project: 'ops' })
await call('register_self', { name: 'Sender', secret: 's', project: 'ops' })
await sleep(150)
check('register_self resync advertises the config default', (reg.default_behaviors || []).some(d => d.behavior === DEFAULT))

// Worker has registered NO behaviours of its own — a delivered message still carries the default (tagged)
await call('send_to_peer', { target: 'Worker', subject: 'ping', message: 'one', as: 'Sender', secret: 's' })
await sleep(150)
const in1 = await call('inbox', { for: 'Worker', secret: 'w', cursor: 0 })
const rs1 = reminders(in1.messages.find(m => m.body === 'one'))
check('default reminder attached to a session with none of its own', rs1.some(r => r.behavior === DEFAULT && r.default === true && r.scope === 'all'), JSON.stringify(rs1))

// Worker sets its OWN all-scope reminder -> it overrides the default (default no longer fires)
await call('set_behavior', { scope: 'all', behavior: 'My own rule.', as: 'Worker', secret: 'w' })
await call('send_to_peer', { target: 'Worker', subject: 'ping', message: 'two', as: 'Sender', secret: 's' })
await sleep(150)
const rs2 = reminders((await call('inbox', { for: 'Worker', secret: 'w', cursor: in1.next_cursor })).messages.find(m => m.body === 'two'))
check('own all-scope overrides the default (default suppressed)', rs2.some(r => /My own rule/.test(r.behavior)) && !rs2.some(r => r.default === true), JSON.stringify(rs2))

console.log(`\n${pass} passed, ${fail} failed`)
await B.transport.close()
process.exit(fail ? 1 : 0)
