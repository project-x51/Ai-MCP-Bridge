// Sub-peer suite: registration, secrets, cursors/epochs, hierarchy, dead-letter, TTL, cross-process routing.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))

const PORT = '7200', WSPORT = '7201', TOKEN = 'testtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, cond, extra='') => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) } }

async function spawnBridge(name) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: WSPORT, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_SWEEP_MS: '400', AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
  const client = new Client({ name: `test-${name}`, version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport, name }
}
const call = async (b, name, args={}) => JSON.parse((await b.client.callTool({ name, arguments: args })).content[0].text)

const A = await spawnBridge('Desk'); await sleep(400)
const B = await spawnBridge('Code'); await sleep(600)

// --- client detection (diagnostic only)
const idA = await call(A, 'my_identity'), idB = await call(B, 'my_identity')
check('A client recorded', idA.client && idA.client.name === 'test-Desk', JSON.stringify(idA.client))
check('A detected poll (no channel cap, not code-like)', idA.client.detected_mode === 'poll')
check('B detected push (code-like name)', idB.client.detected_mode === 'push', JSON.stringify(idB.client))

// --- registration
const r1 = await call(A, 'register_self', { name: 'cowork1', secret: 's1-secret' })
check('register ok with 3-segment id', r1.ok === true && r1.peer_id.split('/').length === 3, JSON.stringify(r1))
check('fresh queue: epoch + cursor 0', typeof r1.queue_epoch === 'string' && r1.next_cursor === 0)
const taken = await call(A, 'register_self', { name: 'cowork1', secret: 'WRONG' })
check('name-taken on wrong secret', taken.ok === false && taken.code === 'name-taken')
const re = await call(A, 'register_self', { name: 'cowork1', secret: 's1-secret' })
check('re-attach: same id + flag', re.peer_id === r1.peer_id && re.reattached === true && re.queue_epoch === r1.queue_epoch)

// --- cross-process send to sub-peer by name; per-handle inbox with secret
const s1 = await call(B, 'send_to_peer', { subject: 'test probe', target: 'cowork1', verb: 'discuss_issue', message: 'msg-one' })
check('B->cowork1 by name ok', s1.ok === true && s1.to === r1.peer_id, JSON.stringify(s1))
await sleep(300)
const bad = await call(A, 'inbox', { for: 'cowork1', secret: 'WRONG' })
check('inbox wrong secret rejected', bad.code === 'bad-secret')
const in1 = await call(A, 'inbox', { for: 'cowork1', secret: 's1-secret' })
check('cowork1 got msg', in1.messages.length === 1 && in1.messages[0].body === 'msg-one', JSON.stringify(in1.messages))
check('epoch consistent', in1.queue_epoch === r1.queue_epoch)
const in2 = await call(A, 'inbox', { for: 'cowork1', secret: 's1-secret', cursor: in1.next_cursor })
check('cursor drains: second poll empty', in2.messages.length === 0 && in2.next_cursor === in1.next_cursor)
const inHigh = await call(A, 'inbox', { for: 'cowork1', secret: 's1-secret', cursor: 999 })
check('stale-high cursor clamps', inHigh.messages.length === 0 && inHigh.next_cursor === in1.next_cursor)

// --- sub-peer -> sub-peer same process, identity carried
await call(A, 'register_self', { name: 'cowork2', secret: 's2-secret' })
const asBad = await call(A, 'send_to_peer', { subject: 'test probe', target: 'cowork2', message: 'x', as: 'cowork1', secret: 'WRONG' })
check('send as wrong secret rejected', asBad.code === 'bad-secret')
const s2 = await call(A, 'send_to_peer', { subject: 'test probe', target: 'cowork2', message: 'hi from cowork1', as: 'cowork1', secret: 's1-secret' })
check('send as cowork1 ok', s2.ok === true && s2.as === r1.peer_id, JSON.stringify(s2))
const in3 = await call(A, 'inbox', { for: 'cowork2', secret: 's2-secret' })
check('cowork2 sees subpeer sender', in3.messages.length === 1 && in3.messages[0].from.kind === 'subpeer' && in3.messages[0].from.session === r1.peer_id)

// --- roster propagation
const lsB = await call(B, 'list_sessions')
const aEntry = lsB.sessions.find(s => s.session === idA.session)
check('B roster shows A sub-peers', aEntry && (aEntry.subpeers || []).length === 2, JSON.stringify(aEntry?.subpeers))
check('B roster shows A client badge', aEntry && aEntry.client === 'test-Desk', JSON.stringify(aEntry?.client))

// --- hierarchy + deregister dead-letter
const sc1 = await call(A, 'register_self', { name: 'scout1', secret: 'scout1-sec', parent: 'cowork1' })
check('child registered under parent', sc1.ok === true, JSON.stringify(sc1))
await sleep(300)
await call(B, 'send_to_peer', { subject: 'test probe', target: 'scout1', message: 'reply for scout1' })
await sleep(300)
const dr = await call(A, 'deregister', { peer_id: sc1.peer_id, secret: 'scout1-sec' })
check('deregister ok', dr.ok === true, JSON.stringify(dr))
const in4 = await call(A, 'inbox', { for: 'cowork1', secret: 's1-secret', cursor: in1.next_cursor })
const dl = in4.messages.find(m => m.dead_letter_for === sc1.peer_id)
check('unread dead-lettered to parent', !!dl && dl.body === 'reply for scout1', JSON.stringify(in4.messages))

// --- TTL expiry with cascade-to-parent dead-letter
const sc2 = await call(A, 'register_self', { name: 'scout2', secret: 'scout2-sec', parent: 'cowork1', ttl_minutes: 0.02 })
await sleep(250)
await call(B, 'send_to_peer', { subject: 'test probe', target: sc2.peer_id, message: 'late reply for scout2' })
await sleep(2600)   // ttl 1.2s + sweep 400ms
const idA2 = await call(A, 'my_identity')
check('scout2 expired by ttl', !idA2.subpeers.some(s => s.id === sc2.peer_id), JSON.stringify(idA2.subpeers))
const in5 = await call(A, 'inbox', { for: 'cowork1', secret: 's1-secret', cursor: in4.next_cursor })
check('ttl strays dead-lettered to parent', in5.messages.some(m => m.dead_letter_for === sc2.peer_id), JSON.stringify(in5.messages))

// --- unknown sub-peer handle on live process dead-letters to process inbox
await call(B, 'send_to_peer', { subject: 'test probe', target: `${idA.session}/ghost-dead`, message: 'to a ghost' })
await sleep(300)
const inProc = await call(A, 'inbox', {})
check('ghost handle dead-letters to process inbox', inProc.messages.some(m => m.dead_letter_for === `${idA.session}/ghost-dead`))

// --- remote sub-peer on follower B reachable from A
const rb = await call(B, 'register_self', { name: 'codepeer1', secret: 'cp1-sec' })
await sleep(400)
const s3 = await call(A, 'send_to_peer', { subject: 'test probe', target: 'codepeer1', message: 'cross-process hello' })
check('A->codepeer1 ok', s3.ok === true && s3.to === rb.peer_id, JSON.stringify(s3))
await sleep(300)
const in6 = await call(B, 'inbox', { for: 'codepeer1', secret: 'cp1-sec' })
check('codepeer1 received cross-process', in6.messages.length === 1 && in6.messages[0].body === 'cross-process hello')

console.log(`\n${pass} passed, ${fail} failed`)
await A.transport.close(); await B.transport.close()
process.exit(fail ? 1 : 0)
