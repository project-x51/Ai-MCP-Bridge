// #60 regression guard — cross-host delivery to a sub-peer hosted by the remote host's GATEWAY, where that
// gateway binds a SPECIFIC IP (as a real host binds its tailnet IP), which exercises the loopback pairServer
// re-splice. Two "hosts" are simulated on two loopback IPs (127.0.0.1 = A, 127.0.0.2 = B) sharing ONE realm
// control port, exactly as tailscale discovery hands a candidate on the dialer's own port.
// (Formerly test_migrate_dial_live, which also covered the #57 compat-port dial fallback removed in v1.46.0.)
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const tp = testPorts(import.meta.url, 13210)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const TOKEN = 'gwsubtok'
const PORT = String(tp(13210))   // the realm's one control port — both hosts use it (on different loopback IPs)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(name, bind, port, extra) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_PERSISTENCE: 'none',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)

// B: a peer gateway on 127.0.0.2, no seeds (it only waits to be dialed).
const B = await spawn('HostB', '127.0.0.2', PORT, { AI_BRIDGE_SEEDS: '' })
// A: a gateway on 127.0.0.1 whose only seed is B on the shared realm port. 127.0.0.1:… < 127.0.0.2:…, so A dials.
const A = await spawn('HostA', '127.0.0.1', PORT, { AI_BRIDGE_SEEDS: '127.0.0.2:' + PORT })
await sleep(1500)   // let discovery tick + the dial connect

const aId = await call(A, 'my_identity')
check('A is a gateway on the realm port', aId.role === 'gateway' && aId.gateway_port === Number(PORT), `${aId.role}:${aId.gateway_port}`)

const aSessions = (await call(A, 'list_sessions')).sessions || []
const bOnA = aSessions.find(s => s.name === 'HostB' || s.host === '127.0.0.2')
check('A federated with B (single dial on the shared realm port)',
  !!bOnA && bOnA.host === '127.0.0.2', JSON.stringify(aSessions.map(s => ({ name: s.name, host: s.host }))))

// B registers a sub-peer; it must appear in A's roster (gossip flows over the link, both directions)
const bpeer = await call(B, 'register_self', { name: 'Bpeer', secret: 'sb', project: 'DP' })
await sleep(600)
const aSessions2 = (await call(A, 'list_sessions')).sessions || []
const bpeerVisible = aSessions2.some(s => (s.subpeers || []).some(sp => sp.name === 'Bpeer'))
check('B\'s sub-peers gossip across the link into A\'s roster', bpeerVisible,
  JSON.stringify(aSessions2.map(s => ({ name: s.name, subs: (s.subpeers || []).map(x => x.name) }))))

// Cross-host DELIVERY to a peer that is its own host's GATEWAY sub-peer. B is bound to a SPECIFIC IP (127.0.0.2,
// as a real host binds its tailnet IP — NOT 0.0.0.0), so when A's envelope reaches B's well-known port, B must
// re-splice it to Bpeer over loopback (127.0.0.1:pairPort). This is the exact path that silently broke the Mac:
// its pairServer had been bound to the tailnet IP, so the loopback re-splice got ECONNREFUSED and EVERY inbound
// send to the gateway-hosted sub-peer failed target-unreachable — while the peer could still send out fine. The
// fix binds pairServer to loopback. Regression guard: A -> Bpeer must deliver, and B must actually receive it.
await call(A, 'register_self', { name: 'Apeer', secret: 'sa', project: 'DP' })
const sent = await call(A, 'send_to_peer', { as: 'Apeer', secret: 'sa', target: bpeer.peer_id,
  verb: 'test', subject: 'cross-host to a gateway-hosted sub-peer', message: 'hello Bpeer' })
check('A -> B gateway-hosted sub-peer send is accepted (loopback re-splice, not target-unreachable)',
  sent.ok === true, JSON.stringify(sent))
await sleep(400)
const bMail = await call(B, 'inbox', { for: bpeer.peer_id, secret: 'sb', cursor: 0 })
check('B\'s gateway-hosted sub-peer actually RECEIVES the cross-host message',
  (bMail.messages || []).some(m => m.subject === 'cross-host to a gateway-hosted sub-peer'),
  JSON.stringify((bMail.messages || []).map(m => m.subject)))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of [A, B]) { try { await b.transport.close() } catch {} }
process.exit(fail ? 1 : 0)
