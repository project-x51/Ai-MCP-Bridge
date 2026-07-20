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

async function spawnBridge(port, extraEnv = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'PBridge', AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_SWEEP_MS: '5000', AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none', ...extraEnv }, stderr: 'pipe' })
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
const reg1 = await call(B, 'register_self', { name: 'Bolletta', secret: 'sb', project: 'shared' })
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
// #40 THE POINT OF STABLE IDS: a DIFFERENT bridge process (new port, new session) mints the SAME peer id,
// because it is derived from identity rather than the process. Pre-#40 this rotated on every restart, which
// is what made stored ids go stale and id-addressed sends fail.
check('peer id is IDENTICAL across a bridge restart', re.peer_id === reg1.peer_id, `${reg1.peer_id} -> ${re.peer_id}`)
check('the restarted id is still the stable form', /^peer:bolletta-[0-9a-f]{8}$/.test(re.peer_id || ''), re.peer_id)
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
await sleep(700)

// ===== PER-PEER MAILBOX KEYING: two co-user peers must NOT share a mailbox (the "echo" regression) =====
// Repro of Bolletta's bug: Alice sends to Bob; on reconnect Alice must NOT see her own outbound, and Bob
// (a different sub-peer, SAME realm:project:user) must get it. Before the fix both shared one mailbox key.
B = await spawnBridge(7966); await sleep(700)
await call(B, 'register_self', { name: 'Alice', secret: 'sa', project: 'shared' })
await call(B, 'register_self', { name: 'Bob', secret: 'sbob', project: 'shared' })
await sleep(200)
const es = await call(B, 'send_to_peer', { target: 'Bob', subject: 'job', message: 'work for bob', as: 'Alice', secret: 'sa' })
check('co-user directed send accepted', es.ok === true, JSON.stringify(es))
await sleep(300)
await B.transport.close(); await sleep(700)
B = await spawnBridge(7968); await sleep(700)
await call(B, 'register_self', { name: 'Alice', secret: 'sa', project: 'shared' })
await call(B, 'register_self', { name: 'Bob', secret: 'sbob', project: 'shared' })
await sleep(200)
const aliceIn = await call(B, 'inbox', { for: 'Alice', secret: 'sa', cursor: 0 })
check("sender's own outbound does NOT echo into its inbox on reconnect", aliceIn.messages.length === 0, JSON.stringify(aliceIn.messages.map(m => m.body)))
const bobIn = await call(B, 'inbox', { for: 'Bob', secret: 'sbob', cursor: 0 })
check('the actual recipient (same user, different peer) gets the parked message', bobIn.messages.some(m => m.body === 'work for bob'), JSON.stringify(bobIn.messages.map(m => m.body)))
await B.transport.close(); await sleep(700)

// ============================ DURABLE CLAIMS (responsibilities survive a restart) ============================
// ---- run 4: Bolletta claims a topic (durable by default), then the bridge dies ----
B = await spawnBridge(7956); await sleep(700)
await call(B, 'register_self', { name: 'Bolletta', secret: 'sb', project: 'shared' })
const cl = await call(B, 'claim_topic', { topic: 'retail/pricing', as: 'Bolletta', secret: 'sb', exclusive: true })
check('claim is durable by default when persistence is on', cl.ok === true && cl.persistent === true, JSON.stringify(cl))
await sleep(300)
await B.transport.close()
await sleep(700)

// ---- run 5: re-register Bolletta -> claim rehydrates and is routable; a directed send reaches her ----
B = await spawnBridge(7958); await sleep(700)
await call(B, 'register_self', { name: 'Bolletta', secret: 'sb', project: 'shared' })
await call(B, 'register_self', { name: 'Sender', secret: 'ss', project: 'shared' })
await sleep(300)
const ds = await call(B, 'send_to_peer', { target: 'topic:retail/pricing', subject: 'q', message: 'who owns pricing?', as: 'Sender', secret: 'ss' })
check('rehydrated claim is routable (directed topic send finds an owner)', ds.ok === true && ds.code !== 'no-owner', JSON.stringify(ds))
await sleep(200)
const cin = await call(B, 'inbox', { for: 'Bolletta', secret: 'sb', cursor: 0 })
check('topic-directed message reached the rehydrated owner', cin.messages.some(m => m.body === 'who owns pricing?'), JSON.stringify(cin.messages.map(m => m.body)))
const rel = await call(B, 'release_topic', { topic: 'retail/pricing', as: 'Bolletta', secret: 'sb' })
check('release succeeds', rel.ok === true, JSON.stringify(rel))
await sleep(300)
await B.transport.close()
await sleep(700)

// ---- run 6: after release, the claim must NOT rehydrate ----
B = await spawnBridge(7960); await sleep(700)
await call(B, 'register_self', { name: 'Bolletta', secret: 'sb', project: 'shared' })
await call(B, 'register_self', { name: 'Sender', secret: 'ss', project: 'shared' })
await sleep(300)
const ds2 = await call(B, 'send_to_peer', { target: 'topic:retail/pricing', subject: 'q', message: 'still there?', as: 'Sender', secret: 'ss' })
check('released claim does NOT rehydrate (no owner after release)', ds2.ok === false && ds2.code === 'no-owner', JSON.stringify(ds2))
await B.transport.close()
await sleep(700)

// ---- run 7-8: a PROCESS claim (held by the session itself, no `as`) also rehydrates across a restart ----
B = await spawnBridge(7962, { AI_BRIDGE_PROJECT: 'ops' }); await sleep(700)
const pc = await call(B, 'claim_topic', { topic: 'ops/alerts' })
check('process claim accepted + durable', pc.ok === true && pc.persistent === true, JSON.stringify(pc))
await sleep(300)
await B.transport.close()
await sleep(700)
B = await spawnBridge(7964, { AI_BRIDGE_PROJECT: 'ops' }); await sleep(900)   // rehydrate fires on client connect
const idp = await call(B, 'my_identity')
check('process claim rehydrated into this session topics after restart',
  (idp.topics || []).some(t => t.pattern === 'ops/alerts' && t.role === 'owner'), JSON.stringify((idp.topics || []).map(t => t.pattern)))
await B.transport.close()

// ===== §19: a directed send to an OFFLINE peer BY NAME parks via its durable registration (survives a restart) =====
B = await spawnBridge(7976); await sleep(700)
await call(B, 'register_self', { name: 'Carol', secret: 'sca', project: 'shared' })   // writes a durable registration
await call(B, 'register_self', { name: 'Dave', secret: 'sdv', project: 'shared' })
await sleep(200)
await B.transport.close(); await sleep(700)   // gateway restart: live registrations gone, durable ones survive
B = await spawnBridge(7978); await sleep(700)
await call(B, 'register_self', { name: 'Dave', secret: 'sdv', project: 'shared' })   // Dave is back; Carol stays offline
await sleep(200)
const toCarol = await call(B, 'send_to_peer', { target: 'Carol', subject: 'job', message: 'for carol', as: 'Dave', secret: 'sdv' })
check('send to an offline peer BY NAME parks via its durable registration', toCarol.ok === true && toCarol.parked === true && toCarol.offline === true, JSON.stringify(toCarol))
const toNobody = await call(B, 'send_to_peer', { target: 'Nobody', subject: 'x', message: 'y', as: 'Dave', secret: 'sdv' })
check('send to a genuinely unknown name still errors (no durable registration)', toNobody.ok === false && toNobody.code === 'unknown-target', JSON.stringify(toNobody))
await call(B, 'register_self', { name: 'Carol', secret: 'sca', project: 'shared' })   // Carol returns
await sleep(250)
const carolIn = (await call(B, 'inbox', { for: 'Carol', secret: 'sca', cursor: 0 })).messages.map(m => m.body)
check('the parked message is delivered to the named peer on its return', carolIn.includes('for carol'), JSON.stringify(carolIn))
await B.transport.close(); await sleep(500)

// ===== §20: register_self resync — returns topics + access, and durable subscriptions rehydrate =====
B = await spawnBridge(7982); await sleep(700)
await call(B, 'register_self', { name: 'Resync', secret: 'sre', project: 'shared' })
await call(B, 'claim_topic', { topic: 'jobs', as: 'Resync', secret: 'sre', exclusive: true })
await call(B, 'subscribe', { pattern: 'news/#', as: 'Resync', secret: 'sre' })
await sleep(250)
await B.transport.close(); await sleep(700)
B = await spawnBridge(7984); await sleep(700)
const resync = await call(B, 'register_self', { name: 'Resync', secret: 'sre', project: 'shared' })
const owned = (resync.topics || []).some(t => t.pattern === 'jobs' && t.role === 'owner')
const subbed = (resync.topics || []).some(t => t.pattern === 'news/#' && t.role === 'subscriber')
check('register_self returns the identity\'s owned + subscribed topics (resync)', owned && subbed, JSON.stringify(resync.topics))
check('register_self returns an access list (reachable projects)', Array.isArray(resync.access), JSON.stringify(resync.access))
// the rehydrated subscription is live: a publish to a matching topic reaches the returning subscriber
await call(B, 'register_self', { name: 'Editor', secret: 'sed', project: 'shared' })
await sleep(150)
await call(B, 'publish', { topic: 'news/breaking', subject: 'n', message: 'hot off the press', as: 'Editor', secret: 'sed' })
await sleep(200)
const resyncIn = (await call(B, 'inbox', { for: 'Resync', secret: 'sre', cursor: 0 })).messages.map(m => m.body)
check('a rehydrated subscription still delivers after the restart', resyncIn.includes('hot off the press'), JSON.stringify(resyncIn))
await B.transport.close(); await sleep(500)

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
