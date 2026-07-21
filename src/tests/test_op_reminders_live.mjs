// #44 — operation-scoped behaviour reminders, end-to-end through the real tool responses.
//
// Pre-#44 reminders fired only on DELIVERY. Now a reminder carries an `operation`, and outbound operations
// (send/publish/claim_topic/allow_project/…) echo the matching reminders in that TOOL'S RESPONSE — post-hoc
// for the message content, but in time for the transcript line / follow-up the agent composes next. This drives
// the real handlers and asserts the reminder shows up on the send response, not on an unrelated one, and that a
// deliver-scoped reminder does NOT leak onto a send (and vice-versa).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-oprem-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

const t = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: 'GW', AI_BRIDGE_PORT: '7995', AI_BRIDGE_WS_PORT: '7996', AI_BRIDGE_TOKEN: 'opremtok',
    AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir, AI_BRIDGE_BIND: '127.0.0.1',
    AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
const c = new Client({ name: 't-oprem', version: '0' }, { capabilities: {} })
await c.connect(t)
const call = async (n, a = {}) => JSON.parse((await c.callTool({ name: n, arguments: a })).content[0].text)
await sleep(400)

await call('register_self', { name: 'Talker', secret: 'st', project: 'PowerHub', user: 'robin' })
await call('register_self', { name: 'Owner', secret: 'so', project: 'PowerHub', user: 'robin' })

// ---- set a SEND-operation reminder (all sends) + a DELIVER one, so we can prove they don't cross ----
const setSend = await call('set_behavior', { operation: 'send', scope: 'all', behavior: 'Report as 📨 to <peer>', as: 'Talker', secret: 'st' })
check('set_behavior accepts an operation', setSend.ok === true && setSend.operation === 'send', JSON.stringify(setSend))
await call('set_behavior', { operation: 'deliver', scope: 'all', behavior: 'Report as 🖂 from <peer>', as: 'Talker', secret: 'st' })
const listed = await call('list_behaviors', { as: 'Talker', secret: 'st' })
check('list_behaviors round-trips the operation', (listed.behaviors || []).some(b => b.operation === 'send') && (listed.behaviors || []).some(b => b.operation === 'deliver'), JSON.stringify(listed.behaviors))

// ---- a direct send: the SEND reminder must ride the RESPONSE ----
const sendResp = await call('send_to_peer', { target: 'Owner', subject: 'hi', message: 'hello', as: 'Talker', secret: 'st' })
check('send_to_peer response carries reminders', Array.isArray(sendResp.reminders), JSON.stringify(sendResp).slice(0, 200))
check('the SEND reminder fired on the send', (sendResp.reminders || []).some(r => r.operation === 'send' && /📨 to/.test(r.behavior)))
check('the DELIVER reminder did NOT leak onto the send', !(sendResp.reminders || []).some(r => r.operation === 'deliver'))

// ---- and the DELIVER reminder rides the delivered message, not the send ----
const inbox = await call('inbox', { for: 'Owner', secret: 'so', cursor: 0 })   // Owner has none of its own — nothing here
const talkerSelf = await call('send_to_peer', { target: 'Talker', subject: 'echo', message: 'to self-ish', as: 'Owner', secret: 'so' })
await sleep(200)
const talkerIn = await call('inbox', { for: 'Talker', secret: 'st', cursor: 0 })
const msg = (talkerIn.messages || []).find(m => m.body === 'to self-ish')
check('the DELIVER reminder rides the delivered message', !!msg && (msg.reminders || []).some(r => (r.operation || 'deliver') === 'deliver' && /🖂 from/.test(r.behavior)), JSON.stringify(msg && msg.reminders))
check('the SEND reminder did NOT leak onto the delivered message', !!msg && !(msg.reminders || []).some(r => r.operation === 'send'))

// ---- a scoped operation: claim_topic reminder only for a matching project ----
await call('set_behavior', { operation: 'claim_topic', scope: 'project', match: 'PowerHub', behavior: 'Announce the claim on team/reviews', as: 'Owner', secret: 'so' })
const claim = await call('claim_topic', { topic: 'demo/thing', as: 'Owner', secret: 'so' })
check('claim_topic response carries the operation reminder', (claim.reminders || []).some(r => r.operation === 'claim_topic' && /Announce the claim/.test(r.behavior)), JSON.stringify(claim.reminders))
// a send from Owner must NOT pick up the claim_topic reminder
const ownerSend = await call('send_to_peer', { target: 'Talker', subject: 'x', message: 'y', as: 'Owner', secret: 'so' })
check('claim_topic reminder does not leak onto a send', !(ownerSend.reminders || []).some(r => r.operation === 'claim_topic'))

// ---- an op with NO reminder and no default is silent (undefined, not []) ----
const noRem = await call('publish', { topic: 'demo/evt', subject: 's', message: 'm', as: 'Owner', secret: 'so' })
check('an operation with no matching reminder omits the field entirely', !('reminders' in noRem) || noRem.reminders === undefined, JSON.stringify(noRem).slice(0, 160))

// ---- bad operation is rejected ----
const bad = await call('set_behavior', { operation: 'not-an-op', scope: 'all', behavior: 'x', as: 'Talker', secret: 'st' })
check('a bad operation is rejected with bad-operation', bad.ok === false && bad.code === 'bad-operation', JSON.stringify(bad))

console.log(`\n${pass} passed, ${fail} failed`)
await c.close()
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
