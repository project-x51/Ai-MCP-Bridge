// Topics suite (amendment 2026-06-12): claim/release with icons, exclusive overlap (incl. subtree),
// subscribe + wildcards, publish vs send-to-owners, mandatory subject, encryption roundtrip,
// reserved-surface unsupported codes, capabilities, lifecycle.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))

const PORT = '7400', WSPORT = '7401', TOKEN = 'testtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, cond, extra='') => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) } }

async function spawnBridge(name) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    // pin persistence OFF: this suite verifies the persistence-DISABLED defaults (reserved-surface codes,
    // claim-vanishes-with-holder), so it must not inherit a dev config.json that turns persistence on.
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: WSPORT, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_SWEEP_MS: '400', AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
  const client = new Client({ name: `test-${name}`, version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport, name }
}
const call = async (b, name, args={}) => JSON.parse((await b.client.callTool({ name, arguments: args })).content[0].text)

const A = await spawnBridge('Desk'); await sleep(400)
const B = await spawnBridge('Code'); await sleep(600)
const idA = await call(A, 'my_identity'), idB = await call(B, 'my_identity')

// --- version + capabilities (T14)
check('bridge_version present', /^\d+\.\d+\.\d+$/.test(idA.bridge_version || ''), JSON.stringify(idA.bridge_version))
check('capabilities all false', idA.capabilities && Object.values(idA.capabilities).every(v => v === false), JSON.stringify(idA.capabilities))

// --- mandatory subject (T7)
const noSub = await call(B, 'send_to_peer', { target: idA.session, message: 'no subject' })
check('send without subject rejected', noSub.ok === false && noSub.code === 'subject-required')
const noSubPub = await call(B, 'publish', { topic: 'retail/x', message: 'x', subject: '' })
check('publish without subject rejected', noSubPub.ok === false && noSubPub.code === 'subject-required')

// --- claims: icon, exclusive, subtree overlap (T6/T15)
const c1 = await call(B, 'claim_topic', { topic: 'bridge/admin', description: 'owns the bridge', exclusive: true, icon: '*B*' })
check('B claims exclusive with icon', c1.ok === true && c1.icon === '*B*', JSON.stringify(c1))
await sleep(400)
const c2 = await call(A, 'claim_topic', { topic: 'Bridge/Admin', exclusive: true })
check('case-insensitive conflict -> held', c2.ok === false && c2.code === 'held' && c2.holder === idB.session, JSON.stringify(c2))
// §6: wildcard CLAIMS are banned — responsibilities must be concrete + addressable — for shared AND exclusive
const c3 = await call(A, 'claim_topic', { topic: 'bridge/#' })
check('wildcard claim rejected (shared)', c3.ok === false && c3.code === 'wildcard-claim', JSON.stringify(c3))
const c3b = await call(A, 'claim_topic', { topic: 'retail/+', exclusive: true })
check('wildcard claim rejected (exclusive)', c3b.ok === false && c3b.code === 'wildcard-claim', JSON.stringify(c3b))
const c4 = await call(A, 'claim_topic', { topic: 'retail', description: 'all retail', exclusive: true })
check('A claims concrete exclusive topic', c4.ok === true, JSON.stringify(c4))
await sleep(400)
// with no subtree ownership (you can't claim retail/#), a concrete sub-path is independently claimable
const c5 = await call(B, 'claim_topic', { topic: 'retail/contact-energy' })
check('concrete sub-path independently claimable (no subtree ownership)', c5.ok === true, JSON.stringify(c5))
const c6 = await call(B, 'claim_topic', { topic: 'bridge/admin', description: 'updated', exclusive: true, icon: '*B*' })
check('re-claim idempotent', c6.ok === true && c6.reclaimed === true, JSON.stringify(c6))

// --- persistent claims are ACCEPTED (durable only when a persistence facet is on; a no-op here, §12),
//     while the still-reserved surface returns unsupported (T14)
const u1 = await call(B, 'claim_topic', { topic: 'x/y', persistent: true })
const u2 = await call(B, 'claim_topic', { topic: 'x/y', force: true })
const u3 = await call(B, 'publish', { topic: 'x/y', subject: 's', message: 'm', retain: true })
const u4 = await call(B, 'send_to_peer', { target: idA.session, subject: 's', message: 'm', park: true })
const u5 = await call(B, 'set_wake', { mode: 'exit-on-message' })
check('persistent claim accepted (no-op without a persistence facet)', u1.ok === true && !u1.persistent, JSON.stringify(u1))
check('force/retain/park/set_wake still unsupported', [u2, u3, u4, u5].every(r => r.ok === false && r.code === 'unsupported'),
  JSON.stringify([u2.code, u3.code, u4.code, u5.code]))

// --- send to topic owners (T3/T5) + encryption roundtrip (T8)
const s1 = await call(A, 'send_to_peer', { target: 'topic:bridge/admin', subject: 'bridge question', message: 'secret payload 42' })
check('topic: send routes to owner', s1.ok === true && s1.fanout.length === 1 && s1.fanout[0].to === idB.session, JSON.stringify(s1))
await sleep(300)
const inB = await call(B, 'inbox', {})
const got = inB.messages.find(m => m.subject === 'bridge question')
check('owner received decrypted body + subject', !!got && got.body === 'secret payload 42' && got.topic === 'bridge/admin' && !got.enc, JSON.stringify(got))
const noOwner = await call(A, 'send_to_peer', { target: 'topic:nobody/home', subject: 's', message: 'm' })
check('unowned topic -> no-owner', noOwner.ok === false && noOwner.code === 'no-owner')
const wild = await call(A, 'send_to_peer', { target: 'topic:retail/+', subject: 's', message: 'm' })
check('wildcard send rejected', wild.ok === false && wild.code === 'wildcard-target')
const bare = await call(A, 'send_to_peer', { target: 'bridge/admin', subject: 's', message: 'm' })
check('bare topic does NOT resolve (explicit only)', bare.ok === false && bare.code === 'unknown-target', JSON.stringify(bare))

// --- subscribe + publish (T2/T3/T5)
await call(A, 'register_self', { name: 'cowork1', secret: 's1' })
const sub1 = await call(A, 'subscribe', { pattern: 'news/#', as: 'cowork1', secret: 's1' })
check('sub-peer subscribes wildcard', sub1.ok === true, JSON.stringify(sub1))
const sub2 = await call(B, 'subscribe', { pattern: 'news/power' })
check('process subscribes concrete', sub2.ok === true)
await sleep(400)
const p1 = await call(A, 'publish', { topic: 'news/power', subject: 'price spike', message: 'spot prices up', verb: 'notify' })
check('publish reaches both subscribers', p1.ok === true && p1.subscribers === 2, JSON.stringify(p1))
await sleep(300)
const inC1 = await call(A, 'inbox', { for: 'cowork1', secret: 's1' })
const ev = inC1.messages.find(m => m.subject === 'price spike')
check('wildcard subscriber got event (pattern publish)', !!ev && ev.pattern === 'publish' && ev.body === 'spot prices up', JSON.stringify(ev))
const inB2 = await call(B, 'inbox', {})
check('concrete subscriber got event', inB2.messages.some(m => m.subject === 'price spike'))
const p2 = await call(B, 'publish', { topic: 'lonely/topic', subject: 'anyone there', message: 'hello?' })
check('publish to zero subscribers ok', p2.ok === true && p2.subscribers === 0, JSON.stringify(p2))

// --- owners are auto-subscribed (T2)
const p3 = await call(A, 'publish', { topic: 'bridge/admin', subject: 'admin event', message: 'fyi' })
check('publish to owned topic reaches owner', p3.ok === true && p3.subscribers >= 1 && p3.fanout.some(f => f.to === idB.session), JSON.stringify(p3))

// --- subscribers do NOT receive sends (T3)
const s2 = await call(A, 'send_to_peer', { target: 'topic:news/power', subject: 'directed work', message: 'do this' })
check('send to subscribed-but-unowned topic -> no-owner', s2.ok === false && s2.code === 'no-owner', JSON.stringify(s2))

// --- roster gossip shows topics with role + icon
const lsA = await call(A, 'list_sessions')
const bEntry = lsA.sessions.find(s => s.session === idB.session)
check('roster shows owner + subscriber entries', bEntry && (bEntry.topics || []).some(t => t.role === 'owner' && t.pattern === 'bridge/admin' && t.icon === '*B*')
  && (bEntry.topics || []).some(t => t.role === 'subscriber' && t.pattern === 'news/power'), JSON.stringify(bEntry?.topics))

// --- unsubscribe + release lifecycle
const un1 = await call(B, 'unsubscribe', { pattern: 'news/power' })
check('unsubscribe ok', un1.ok === true)
await sleep(400)
const p4 = await call(A, 'publish', { topic: 'news/power', subject: 'second spike', message: 'again' })
check('unsubscribed peer no longer counted', p4.subscribers === 1, JSON.stringify(p4))
const rel = await call(B, 'release_topic', { topic: 'BRIDGE/admin' })
check('release ok (case-insensitive)', rel.ok === true)
await sleep(400)
const c7 = await call(A, 'claim_topic', { topic: 'bridge/admin', exclusive: true, icon: '*A*' })
check('A claims after release', c7.ok === true && c7.holder === idA.session, JSON.stringify(c7))

// --- deregister drops the sub-peer's subscriptions
await call(A, 'deregister', { peer_id: inC1.peer_id, secret: 's1' })
await sleep(400)
const p5 = await call(A, 'publish', { topic: 'news/power', subject: 'third spike', message: 'gone?' })
check('deregistered subscriber dropped', p5.subscribers === 0, JSON.stringify(p5))

console.log(`\n${pass} passed, ${fail} failed`)
await A.transport.close(); await B.transport.close()
process.exit(fail ? 1 : 0)
