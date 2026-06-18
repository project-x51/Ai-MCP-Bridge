// §16 offline owners + dormant-claim takeover. A directed send to a topic whose durable owner is OFFLINE
// parks for its return (announced only if the owner opted in); taking over your OWN dormant topic needs the
// authorizer (none=held, script=approve); a DIFFERENT user may take over only after grace AND if allowed.
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
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-park-'))

async function spawn(port, extra = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'P', AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none', ...extra }, stderr: 'pipe' })
  const client = new Client({ name: 't-park', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

// ===== A/B: park to an offline owner; announced only if the owner opted in; redelivered on return =====
let B = await spawn(7980); await sleep(700)
await call(B, 'register_self', { name: 'Owner', secret: 'so', project: 'shared' })
await call(B, 'register_self', { name: 'Sender', secret: 'ss', project: 'shared' })
await sleep(150)
await call(B, 'claim_topic', { topic: 'jobs', as: 'Owner', secret: 'so', exclusive: true, announce_offline: true })
await call(B, 'claim_topic', { topic: 'quiet', as: 'Owner', secret: 'so', exclusive: true })   // announce_offline default false
await sleep(150)
await call(B, 'deregister', { peer_id: (await call(B, 'list_sessions')).sessions.flatMap(s => s.subpeers || []).find(s => s.name === 'Owner').id, secret: 'so' })
await sleep(150)
const pj = await call(B, 'send_to_peer', { target: 'topic:jobs', subject: 'job', message: 'do job', as: 'Sender', secret: 'ss' })
check('send to offline owner PARKS (announce on -> sender told offline)', pj.ok === true && pj.parked === true && pj.offline === true, JSON.stringify(pj))
const pq = await call(B, 'send_to_peer', { target: 'topic:quiet', subject: 'q', message: 'quiet job', as: 'Sender', secret: 'ss' })
check('send to offline owner PARKS silently (announce off -> no offline flag)', pq.ok === true && !pq.offline && !pq.parked, JSON.stringify(pq))
await sleep(200)
await call(B, 'register_self', { name: 'Owner', secret: 'so', project: 'shared' })   // returns -> claims rehydrate + mail drains
await sleep(250)
const inb = (await call(B, 'inbox', { for: 'Owner', secret: 'so', cursor: 0 })).messages.map(m => m.body)
check('both parked messages redelivered to the owner on return', inb.includes('do job') && inb.includes('quiet job'), JSON.stringify(inb))
await B.transport.close(); await sleep(700)

// ===== C: same-user takeover of a DORMANT topic is authorizer-gated (none=held) =====
B = await spawn(7982, { AI_BRIDGE_AUTHORIZER: 'none' }); await sleep(700)
await call(B, 'register_self', { name: 'A1', secret: 's1', project: 'shared' })
await call(B, 'claim_topic', { topic: 'lead', as: 'A1', secret: 's1', exclusive: true })
await sleep(120)
await call(B, 'deregister', { peer_id: (await call(B, 'list_sessions')).sessions.flatMap(s => s.subpeers || []).find(s => s.name === 'A1').id, secret: 's1' })
await sleep(120)
await call(B, 'register_self', { name: 'A2', secret: 's2', project: 'shared' })   // same user (robin), different session
const heldNone = await call(B, 'claim_topic', { topic: 'lead', as: 'A2', secret: 's2', exclusive: true })
check('same-user takeover with authorizer=none is HELD', heldNone.ok === false && heldNone.code === 'held' && heldNone.same_user === true, JSON.stringify(heldNone))
await B.transport.close(); await sleep(700)

// ...and with authorizer=script(approve) the same takeover SUCCEEDS (the Hello plugin is the live-only piece)
B = await spawn(7984, { AI_BRIDGE_AUTHORIZER: 'script', AI_BRIDGE_AUTHORIZER_DECISION: 'approve' }); await sleep(700)
await call(B, 'register_self', { name: 'A2', secret: 's2', project: 'shared' })
const tookOver = await call(B, 'claim_topic', { topic: 'lead', as: 'A2', secret: 's2', exclusive: true })
check('same-user takeover with authorizer approval SUCCEEDS', tookOver.ok === true && tookOver.topic === 'lead', JSON.stringify(tookOver))
await B.transport.close(); await sleep(700)

// ===== D: cross-user takeover — grace + per-claim allow_other_user govern it =====
// robin claims three topics offline with different policies, then an ALICE bridge (same persist dir) tries each.
B = await spawn(7986); await sleep(700)
await call(B, 'register_self', { name: 'R', secret: 'sr', project: 'shared' })
await call(B, 'claim_topic', { topic: 'open-now', as: 'R', secret: 'sr', exclusive: true, grace_minutes: 0, allow_other_user: true })
await call(B, 'claim_topic', { topic: 'never', as: 'R', secret: 'sr', exclusive: true, grace_minutes: 0, allow_other_user: false })
await call(B, 'claim_topic', { topic: 'wait', as: 'R', secret: 'sr', exclusive: true, allow_other_user: true })   // default 60m grace
await sleep(150)
await B.transport.close(); await sleep(700)   // robin's whole bridge gone -> all three dormant
const A = await spawn(7988, { AI_BRIDGE_USER: 'alice' }); await sleep(700)
await call(A, 'register_self', { name: 'AL', secret: 'sa', project: 'shared' })
await sleep(150)
const xOpen = await call(A, 'claim_topic', { topic: 'open-now', as: 'AL', secret: 'sa', exclusive: true })
check('cross-user takeover allowed past grace when allow_other_user:true', xOpen.ok === true, JSON.stringify(xOpen))
const xNever = await call(A, 'claim_topic', { topic: 'never', as: 'AL', secret: 'sa', exclusive: true })
check('cross-user takeover HELD when allow_other_user:false', xNever.ok === false && xNever.code === 'held' && xNever.cross_user === true, JSON.stringify(xNever))
const xWait = await call(A, 'claim_topic', { topic: 'wait', as: 'AL', secret: 'sa', exclusive: true })
check('cross-user takeover HELD while within the grace window', xWait.ok === false && xWait.within_grace === true, JSON.stringify(xWait))
await A.transport.close()

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
