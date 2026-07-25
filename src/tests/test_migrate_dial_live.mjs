// #57 fix — cross-host dial during a port migration. Reproduces the partition that took ROBIN-Z790 off the mesh:
// discovery (tailscale) hands a candidate on the DIALER's OWN port, but an un-migrated peer is still on the OLD
// port, so a migrated dialer never reaches it. The fix: connectToPeer falls back through the compat ports.
// Simulated on two loopback IPs (127.0.0.1 migrated dialer, 127.0.0.2 old-port peer) so the compat listener
// doesn't collide. The seed deliberately names the WRONG port (the dialer's), exactly as tailscale would.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const TOKEN = 'migdialtok'
const A_PORT = '13210', B_PORT = '13212'   // A (migrated) primary 13210 + compat 13212; B (old) on 13212
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(name, bind, port, extra) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_PERSISTENCE: 'none',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)

// B: an OLD-port peer on 127.0.0.2:13212, no seeds (it only waits to be dialed).
const B = await spawn('HostB', '127.0.0.2', B_PORT, { AI_BRIDGE_SEEDS: '' })
// A: MIGRATED gateway on 127.0.0.1 — primary 13210, compat 13212. Its ONLY seed for B names the WRONG port
// (13210, A's own port — what tailscale would hand it); B is actually on 13212. Only the compat fallback finds B.
const A = await spawn('HostA', '127.0.0.1', A_PORT, { AI_BRIDGE_COMPAT_PORTS: B_PORT, AI_BRIDGE_SEEDS: '127.0.0.2:' + A_PORT })
await sleep(1500)   // let discovery tick + the primary-port dial FAIL + the compat fallback connect

const aId = await call(A, 'my_identity')
check('A is a gateway on its new port', aId.role === 'gateway' && aId.gateway_port === Number(A_PORT), `${aId.role}:${aId.gateway_port}`)

const aSessions = (await call(A, 'list_sessions')).sessions || []
const bOnA = aSessions.find(s => s.name === 'HostB' || s.host === '127.0.0.2')
check('the migrated dialer FEDERATED with the old-port peer via the compat fallback (partition healed)',
  !!bOnA && bOnA.host === '127.0.0.2', JSON.stringify(aSessions.map(s => ({ name: s.name, host: s.host }))))

// B registers a sub-peer; it must appear in A's roster (gossip flows over the healed link, both directions)
const bpeer = await call(B, 'register_self', { name: 'Bpeer', secret: 'sb', project: 'DP' })
await sleep(600)
const aSessions2 = (await call(A, 'list_sessions')).sessions || []
const bpeerVisible = aSessions2.some(s => (s.subpeers || []).some(sp => sp.name === 'Bpeer'))
check('the old-port peer\'s sub-peers gossip across the healed link into the migrated node\'s roster', bpeerVisible,
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
