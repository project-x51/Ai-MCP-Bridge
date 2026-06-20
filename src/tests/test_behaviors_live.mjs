// #29 behaviour reminders: a session registers short 'how to behave' prompts scoped to a topic it owns / a
// host / a project / a subscription / all, and the bridge returns the matching ones alongside each delivered
// message (inbox items here). Multiple scopes can match -> a list, most-specific first. Durable + resync;
// topic-scoped reminders ride along to the next owner via a kept-alive handoff (#26).
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
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-beh-'))

const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: 'Host', AI_BRIDGE_PORT: '7580', AI_BRIDGE_WS_PORT: '7581', AI_BRIDGE_TOKEN: 'testtok',
    AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
const B = { client: new Client({ name: 'test-beh', version: '0' }, { capabilities: {} }), transport }
await B.client.connect(transport); await sleep(500)
const call = async (n, a = {}) => JSON.parse((await B.client.callTool({ name: n, arguments: a })).content[0].text)
const reminders = m => (m && m.reminders) || []

await call('register_self', { name: 'Worker', secret: 'w', project: 'ops' })
await call('register_self', { name: 'Sender', secret: 's', project: 'ops' })
await sleep(150)

// --- register behaviours across scopes
await call('claim_topic', { topic: 'builds/nightly', exclusive: true, as: 'Worker', secret: 'w' })
const set1 = await call('set_behavior', { scope: 'topic', match: 'builds/nightly', behavior: 'Triage the build, then post a summary to the owner.', as: 'Worker', secret: 'w' })
check('set_behavior (topic) ok', set1.ok === true && set1.count === 1, JSON.stringify(set1))
await call('set_behavior', { scope: 'project', match: 'ops', behavior: 'Acknowledge ops messages within the hour.', as: 'Worker', secret: 'w' })
await call('set_behavior', { scope: 'all', behavior: 'Be concise.', as: 'Worker', secret: 'w' })
const listed = await call('list_behaviors', { as: 'Worker', secret: 'w' })
check('list_behaviors returns all three', listed.behaviors.length === 3, JSON.stringify(listed.behaviors.map(b => b.scope)))

// --- a directed send to the topic should carry the matching reminders (topic + project + all), most-specific first
await call('send_to_peer', { target: 'topic:builds/nightly', subject: 'build done', message: 'nightly green', verb: 'review', as: 'Sender', secret: 's' })
await sleep(200)
const inb = await call('inbox', { for: 'Worker', secret: 'w', cursor: 0 })
const msg = inb.messages.find(m => m.body === 'nightly green')
const rs = reminders(msg)
check('delivered message carries reminders', rs.length === 3, JSON.stringify(rs))
check('reminders ordered most-specific first (topic, then project, then all)', rs[0].scope === 'topic' && rs[1].scope === 'project' && rs[2].scope === 'all', JSON.stringify(rs.map(r => r.scope)))
check('topic reminder has the right behavior + match', rs[0].match === 'builds/nightly' && /Triage the build/.test(rs[0].behavior), JSON.stringify(rs[0]))

// --- a send to the peer by NAME (not the topic) -> topic scope does NOT fire; project + all do
await call('send_to_peer', { target: 'Worker', subject: 'ping', message: 'direct ping', as: 'Sender', secret: 's' })
await sleep(150)
const inb2 = await call('inbox', { for: 'Worker', secret: 'w', cursor: inb.next_cursor })
const rs2 = reminders(inb2.messages.find(m => m.body === 'direct ping'))
check('non-topic message: topic scope does not fire; project + all do', rs2.length === 2 && rs2.every(r => r.scope !== 'topic'), JSON.stringify(rs2.map(r => r.scope)))

// --- clear one, and clear-all
const cl = await call('clear_behavior', { scope: 'project', match: 'ops', as: 'Worker', secret: 'w' })
check('clear_behavior removes one', cl.ok === true && cl.cleared === 1 && (await call('list_behaviors', { as: 'Worker', secret: 'w' })).behaviors.length === 2)
const clAll = await call('clear_behavior', { as: 'Worker', secret: 'w' })
check('clear_behavior (no scope) clears all', clAll.cleared === 2 && (await call('list_behaviors', { as: 'Worker', secret: 'w' })).behaviors.length === 0)

// --- subscription scope (isolated): a publish matching a subscribed pattern carries the subscription reminder
await call('subscribe', { pattern: 'alerts/#', as: 'Worker', secret: 'w' })
await call('set_behavior', { scope: 'subscription', match: 'alerts/#', behavior: 'Page on-call for any DB alert.', as: 'Worker', secret: 'w' })
const before = await call('inbox', { for: 'Worker', secret: 'w', cursor: inb2.next_cursor })   // advance cursor to "now"
await call('publish', { topic: 'alerts/db', subject: 'db', message: 'db down', as: 'Sender', secret: 's' })
await sleep(150)
const rsSub = reminders((await call('inbox', { for: 'Worker', secret: 'w', cursor: before.next_cursor })).messages.find(m => m.body === 'db down'))
check('subscription-scope reminder fires for a matching publish', rsSub.some(r => r.scope === 'subscription' && r.match === 'alerts/#'), JSON.stringify(rsSub.map(r => r.scope)))
await call('clear_behavior', { as: 'Worker', secret: 'w' })

// --- validation
check('bad scope rejected', (await call('set_behavior', { scope: 'nope', behavior: 'x', as: 'Worker', secret: 'w' })).code === 'bad-scope')
check('over-long behavior rejected', (await call('set_behavior', { scope: 'all', behavior: 'x'.repeat(400), as: 'Worker', secret: 'w' })).code === 'behavior-too-long')
check('match required for non-all', (await call('set_behavior', { scope: 'topic', behavior: 'x', as: 'Worker', secret: 'w' })).code === 'match-required')

// --- resync: register_self hands back the durable behaviours
await call('set_behavior', { scope: 'host', match: 'BUILDBOX', behavior: 'Builds from BUILDBOX are trusted.', as: 'Worker', secret: 'w' })
const re = await call('register_self', { name: 'Worker', secret: 'w', project: 'ops' })
check('register_self resync returns behaviours', Array.isArray(re.behaviors) && re.behaviors.some(b => b.scope === 'host' && b.match === 'BUILDBOX'), JSON.stringify(re.behaviors))

// --- #26 x #29: a topic-scoped reminder rides along a kept-alive handoff to the next owner
await call('register_self', { name: 'Heir', secret: 'h', project: 'ops' })
await call('claim_topic', { topic: 'reviews/api', exclusive: true, keep_alive: true, as: 'Worker', secret: 'w' })
await call('set_behavior', { scope: 'topic', match: 'reviews/api', behavior: 'Review within one business day; tag the author.', as: 'Worker', secret: 'w' })
await call('release_topic', { topic: 'reviews/api', as: 'Worker', secret: 'w' })   // keep_alive inherited -> kept marker carries the behaviour
await call('claim_topic', { topic: 'reviews/api', exclusive: true, as: 'Heir', secret: 'h' })
await sleep(120)
const heirBeh = await call('list_behaviors', { as: 'Heir', secret: 'h' })
check('new owner INHERITS the topic-scoped reminder across the handoff', heirBeh.behaviors.some(b => b.scope === 'topic' && b.match === 'reviews/api' && /Review within one business day/.test(b.behavior)), JSON.stringify(heirBeh.behaviors))

console.log(`\n${pass} passed, ${fail} failed`)
await B.transport.close()
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
