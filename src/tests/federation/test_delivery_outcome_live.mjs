// #61 — a cross-host send must report the RECEIVER's real outcome, exactly as a local send does. Pre-fix, the
// pair-splice MSG handler sent CLOSE {code:'ok'} unconditionally, so a project-denied (or dead-lettered) send to a
// sub-peer on ANOTHER host read as ok:true — which masked #62 for a whole debugging session. Two gateways on distinct
// loopback IPs (127.0.0.1 / 127.0.0.2) stand in for two hosts; A's sender dials B's well-known port and B's gateway
// re-splices to its own pairServer, i.e. the real cross-host delivery path.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const tp = testPorts(import.meta.url, 13600)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-fix proof run this test against a reverted copy
const TOKEN = 'outcometok'
const A_PORT = String(tp(13600)), B_PORT = String(tp(13602))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(name, bind, port, extra) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_PERSISTENCE: 'none',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)
const subjects = m => (m.messages || []).map(x => x.subject)

const B = await spawn('HostB', '127.0.0.2', B_PORT, { AI_BRIDGE_SEEDS: '' })
const A = await spawn('HostA', '127.0.0.1', A_PORT, { AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT })
await sleep(1500)

// B hosts two sub-peers on its gateway: one in the sender's project, one in a foreign project with no grant.
const bSame = await call(B, 'register_self', { name: 'BSame', secret: 'bs', project: 'Mine' })
const bOther = await call(B, 'register_self', { name: 'BOther', secret: 'bo', project: 'Other' })
await call(A, 'register_self', { name: 'ASender', secret: 'as', project: 'Mine' })
await sleep(800)   // gossip B's sub-peers into A's roster
const aSessions = (await call(A, 'list_sessions')).sessions || []
check('B\'s sub-peers are visible on A (federated)',
  ['BSame', 'BOther'].every(n => aSessions.some(s => (s.subpeers || []).some(sp => sp.name === n))),
  JSON.stringify(aSessions.map(s => ({ name: s.name, subs: (s.subpeers || []).map(x => x.name) }))))

const send = (target, subject) => call(A, 'send_to_peer', { as: 'ASender', secret: 'as', target, verb: 'test', subject, message: subject })

// 1. cross-project, no grant on B -> the receiver refuses; the sender must SEE the refusal (was ok:true pre-fix)
const denied = await send(bOther.peer_id, 'denied-cross-host')
check('cross-host send to a foreign-project peer with no grant reports ok:false code:project-denied',
  denied.ok === false && denied.code === 'project-denied', JSON.stringify(denied))
await sleep(400)
const otherMail = await call(B, 'inbox', { for: bOther.peer_id, secret: 'bo', cursor: 0 })
check('the denied target\'s inbox is empty', (otherMail.messages || []).length === 0, JSON.stringify(subjects(otherMail)))

// 2. positive control: same project on B -> ok:true and actually received
const same = await send(bSame.peer_id, 'same-project-cross-host')
check('cross-host same-project send reports ok:true (no error code)', same.ok === true && !same.code, JSON.stringify(same))
await sleep(400)
const sameMail = await call(B, 'inbox', { for: bSame.peer_id, secret: 'bs', cursor: 0 })
check('the same-project target actually received it', subjects(sameMail).includes('same-project-cross-host'), JSON.stringify(subjects(sameMail)))

// 3. B-side peer grants Mine -> the same cross-host send now succeeds and lands
const grant = await call(B, 'allow_project', { project: 'Mine', as: bOther.peer_id, secret: 'bo' })
check('B-side peer grants project Mine', grant.ok === true, JSON.stringify(grant))
const granted = await send(bOther.peer_id, 'granted-cross-host')
check('after the grant, the cross-host send reports ok:true', granted.ok === true && !granted.code, JSON.stringify(granted))
await sleep(400)
const otherMail2 = await call(B, 'inbox', { for: bOther.peer_id, secret: 'bo', cursor: 0 })
check('after the grant, the target actually received it (and only that one)',
  JSON.stringify(subjects(otherMail2)) === JSON.stringify(['granted-cross-host']), JSON.stringify(subjects(otherMail2)))

// 4. dead-letter: a (legacy-form) id under B's session that names no live sub-peer -> B dead-letters it to its
// process inbox. Mirrors a local send: ok:true (fire-and-forget) but FLAGGED dead_lettered, not a silent success.
const bId = await call(B, 'my_identity')
const ghost = `${bId.session}/ghost-${Date.now()}`
const dl = await send(ghost, 'dead-letter-cross-host')
check('cross-host send to an unknown sub-peer under B reports ok:true + dead_lettered:true',
  dl.ok === true && dl.dead_lettered === true, JSON.stringify(dl))
await sleep(300)
const bProc = await call(B, 'inbox', { cursor: 0 })
check('B dead-lettered it to its process inbox', (bProc.messages || []).some(m => m.subject === 'dead-letter-cross-host' && m.dead_letter_for === ghost),
  JSON.stringify((bProc.messages || []).map(m => ({ s: m.subject, dl: m.dead_letter_for }))))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of [A, B]) { try { await b.transport.close() } catch {} }
process.exit(fail ? 1 : 0)
