// #64 live: (1) claim_topic defaults flip to exclusive/announce_offline/persistent = TRUE; (2) set_wake returns
// an unsupported message RESOLVED BY SESSION TYPE (code → doorbell fallback, else → no fallback); (3) the new
// 'connect' operation + 'client' scope — a connect reminder rides the register_self response, filtered by the
// session's client kind. Client kind is set per sub-peer via register_self {client}, so one bridge covers all cases.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const PDIR = path.join(os.tmpdir(), 'aimb-conntest-' + Date.now())

const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: 'Host', AI_BRIDGE_PORT: '13520', AI_BRIDGE_WS_PORT: '13521', AI_BRIDGE_TOKEN: 'conntok',
    AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_COMPAT_PORTS: '', AI_BRIDGE_COMPAT_WS_PORTS: '',
    AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: PDIR }, stderr: 'pipe' })
const B = { client: new Client({ name: 'test-conn', version: '0' }, { capabilities: {} }), transport }
await B.client.connect(transport); await sleep(500)
const call = async (n, a = {}) => JSON.parse((await B.client.callTool({ name: n, arguments: a })).content[0].text)

// client kind is declared per sub-peer: 'claude-code' -> code, 'cowork' -> cowork.
await call('register_self', { name: 'Coder', secret: 'c', project: 'PH', client: 'claude-code' })
await call('register_self', { name: 'Coworker', secret: 'w', project: 'PH', client: 'cowork' })
await sleep(150)

// (1) claim_topic DEFAULTS: no flags → exclusive + persistent true in the response; announce_offline true on the roster.
const claim = await call('claim_topic', { topic: 'defaults/probe', as: 'Coder', secret: 'c', description: 'defaults probe' })
check('claim default exclusive = true', claim.exclusive === true, JSON.stringify(claim))
check('claim default persistent = true (persistence on)', claim.persistent === true, JSON.stringify(claim))
const sess = (await call('list_sessions')).sessions || []
const topicRow = sess.flatMap(s => s.topics || []).find(t => t.pattern === 'defaults/probe')
check('claim default announce_offline = true (on the roster)', !!topicRow && topicRow.announce_offline === true, JSON.stringify(topicRow))
check('claimed topic reads exclusive + persistent on the roster', !!topicRow && topicRow.exclusive === true && topicRow.persistent === true, JSON.stringify(topicRow))

// (2) set_wake resolved by session type.
const wCode = await call('set_wake', { as: 'Coder', secret: 'c' })
check('set_wake code: unsupported + doorbell fallback', wCode.ok === false && wCode.code === 'unsupported' && wCode.fallback === 'doorbell' && /doorbell/i.test(wCode.what), JSON.stringify(wCode))
const wCow = await call('set_wake', { as: 'Coworker', secret: 'w' })
check('set_wake non-code: unsupported + NO fallback', wCow.ok === false && wCow.code === 'unsupported' && !wCow.fallback && /no fallback/i.test(wCow.what), JSON.stringify(wCow))

// (3) connect reminders, client-scoped. Coder registers its own connect reminders; on RE-register (reattach) the
// matching ones ride the response. A 'client:code' one matches Coder; a 'client:cowork' one does not; 'all' always does.
await call('set_behavior', { operation: 'connect', scope: 'client', match: 'code', behavior: 'CODE-DOORBELL-HINT', as: 'Coder', secret: 'c' })
await call('set_behavior', { operation: 'connect', scope: 'client', match: 'cowork', behavior: 'COWORK-ONLY-HINT', as: 'Coder', secret: 'c' })
await call('set_behavior', { operation: 'connect', scope: 'all', behavior: 'EVERYONE-HINT', as: 'Coder', secret: 'c' })
const reCoder = await call('register_self', { name: 'Coder', secret: 'c', project: 'PH', client: 'claude-code' })
const crB = (reCoder.connect_reminders || []).map(r => r.behavior)
check('connect reminder: client:code MATCHES a code session', crB.includes('CODE-DOORBELL-HINT'), JSON.stringify(crB))
check('connect reminder: client:cowork does NOT match a code session', !crB.includes('COWORK-ONLY-HINT'), JSON.stringify(crB))
check('connect reminder: scope all matches every session', crB.includes('EVERYONE-HINT'), JSON.stringify(crB))

// The mirror: a cowork session with a client:code connect reminder does NOT get it (gated the other way).
await call('set_behavior', { operation: 'connect', scope: 'client', match: 'code', behavior: 'CODE-ONLY-HINT', as: 'Coworker', secret: 'w' })
const reCow = await call('register_self', { name: 'Coworker', secret: 'w', project: 'PH', client: 'cowork' })
const crW = (reCow.connect_reminders || []).map(r => r.behavior)
check('connect reminder: client:code does NOT match a cowork session', !crW.includes('CODE-ONLY-HINT'), JSON.stringify(crW))

console.log(`\n${pass} passed, ${fail} failed`)
await B.transport.close()
process.exit(fail ? 1 : 0)
