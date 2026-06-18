// Identity suite: realm + mandatory (project, user) classification via the label IdentityModel,
// carried on my_identity, register_self, and the gossiped roster; child inheritance.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))

const PORT = '7800', WSPORT = '7801', TOKEN = 'testtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) } }

async function spawnBridge(name, extraEnv = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: WSPORT, AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_SWEEP_MS: '400', AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none', ...extraEnv }, stderr: 'pipe' })
  const client = new Client({ name: `test-${name}`, version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport, name }
}
const call = async (b, name, args = {}) => JSON.parse((await b.client.callTool({ name, arguments: args })).content[0].text)

// A: classified Code-style process (project/user via env, custom realm). B: unclassified infra.
const A = await spawnBridge('Alpha', { AI_BRIDGE_REALM: 'lan-home', AI_BRIDGE_PROJECT: 'alpha', AI_BRIDGE_USER: 'robin' }); await sleep(400)
const B = await spawnBridge('Infra'); await sleep(600)

const idA = await call(A, 'my_identity'), idB = await call(B, 'my_identity')
check('realm carried on my_identity', idA.realm === 'lan-home', idA.realm)
check('classified process has identity', idA.identity && idA.identity.project === 'alpha' && idA.identity.user === 'robin', JSON.stringify(idA.identity))
check('declared assurance + label scheme', idA.identity.scheme === 'label' && idA.identity.assurance === 'declared', JSON.stringify(idA.identity))
check('normalized id is realm:project:user', idA.identity.id === 'lan-home:alpha:robin', idA.identity.id)
check('unclassified process = infrastructure (no identity)', idB.identity === null, JSON.stringify(idB.identity))
check('default realm when unset', idB.realm === 'default', idB.realm)

// register_self carries project/user; returned + classified
const r1 = await call(A, 'register_self', { name: 'conv1', secret: 's1', project: 'alpha', user: 'robin', client: 'cowork' })
check('register_self returns identity', r1.ok && r1.identity && r1.identity.project === 'alpha' && r1.identity.realm === 'lan-home', JSON.stringify(r1.identity))
// a different project on the same shared process (Desktop multiplexes projects)
const r2 = await call(A, 'register_self', { name: 'conv2', secret: 's2', project: 'research', user: 'alice' })   // user 'alice' is IGNORED
check('second conversation can be a different project', r2.identity.project === 'research', JSON.stringify(r2.identity))
check('session-declared user is ignored — user comes from the OS login', r2.identity.user === 'robin', JSON.stringify(r2.identity))

// child inherits parent's project; user is always the OS login
const sc = await call(A, 'register_self', { name: 'scout1', secret: 'sc1', parent: 'conv2' })
check('child inherits parent project; user is the OS login', sc.identity.project === 'research' && sc.identity.user === 'robin', JSON.stringify(sc.identity))

// gossip: B sees A's sub-peers with project/user
await sleep(500)
const lsB = await call(B, 'list_sessions')
const aEntry = lsB.sessions.find(s => s.session === idA.session)
const conv1 = aEntry && (aEntry.subpeers || []).find(s => s.name === 'conv1')
const conv2 = aEntry && (aEntry.subpeers || []).find(s => s.name === 'conv2')
check('roster gossips sub-peer project/user', conv1 && conv1.project === 'alpha' && conv1.user === 'robin', JSON.stringify(conv1))
check('roster shows distinct projects per conversation', conv2 && conv2.project === 'research', JSON.stringify(conv2))
check('classified session entry carries project + realm', aEntry && aEntry.project === 'alpha' && aEntry.realm === 'lan-home', JSON.stringify({ p: aEntry?.project, r: aEntry?.realm }))

// re-attach preserves identity
const re = await call(A, 'register_self', { name: 'conv1', secret: 's1' })
check('re-attach returns same identity', re.reattached === true && re.identity.project === 'alpha', JSON.stringify(re.identity))

console.log(`\n${pass} passed, ${fail} failed`)
await A.transport.close(); await B.transport.close()
process.exit(fail ? 1 : 0)
