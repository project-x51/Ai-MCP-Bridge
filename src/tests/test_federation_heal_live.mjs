// #63 — cross-host federation must SELF-HEAL. Production: after the Mac restarted (new gateway session) and moved
// port 7000 -> 12317, LITTLE-001 kept the Mac's OLD slice behind a TCP link that still looked ESTABLISHED, so its
// sessions routed Mac-bound sends to the dead old port until LITTLE's bridges were restarted by hand. Pre-fix, a
// peer's slice was only replaced by a new gossip from the SAME gateway session, and only dropped when that link's
// socket closed — neither happens for a half-open link to a restarted peer.
//
// Phase 1 (restart heal): A reaches B1 through a TCP relay on 127.0.0.3 that, like a half-open link, never passes
// B1's death back to A. B then restarts as a new process (new session) on a NEW port. A must retire B1's slice,
// show the new B's sessions/sub-peers at the new port, and DELIVER to a sub-peer on the new B (stable ids, so the
// old and new sub-peer share one id — exactly the shadowing that misrouted the Mac's traffic).
// Phase 2 (expiry heal + mixed-version guard): a refresh-capable peer that goes silent while its socket stays open
// is expired within the expiry window; a normal quiet peer and two legacy (<=1.43-style) peers are never expired.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-fix proof run this test against a reverted copy
const LEGACY = process.env.AIMB_TEST_LEGACY_BRIDGE || BRIDGE   // optional: run the two legacy peers on a REAL <=1.43 copy (mixed-version proof)
const TOKEN = 'healtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(name, bind, port, extra, file = BRIDGE) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + file], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_PERSISTENCE: 'none',
      AI_BRIDGE_COMPAT_PORTS: '', AI_BRIDGE_COMPAT_WS_PORTS: '', AI_BRIDGE_STABLE_IDS: '1', AI_BRIDGE_TEST_GOSSIP: '',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: '', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)
const sessionsOf = async b => (await call(b, 'list_sessions')).sessions || []
const brief = ss => JSON.stringify(ss.map(s => ({ name: s.name, origin: s.origin, port: s.port, subs: (s.subpeers || []).map(x => x.name) })))
const all = []
// A TCP relay that behaves like a half-open link: whichever end dies first, the OTHER end is kept open and its
// writes are swallowed — no FIN/RST ever reaches the survivor. A dial whose upstream is refused is closed.
async function halfOpenRelay(host, port, upHost, upPort) {
  const srv = net.createServer(client => {
    const up = net.connect(upPort, upHost)
    let upOk = false
    const wedge = (dead, alive) => { dead.unpipe(alive); alive.unpipe(dead); alive.on('data', () => {}); alive.resume() }
    client.on('error', () => {}); up.on('error', () => { if (!upOk) client.destroy() })
    up.on('connect', () => { upOk = true; client.pipe(up, { end: false }); up.pipe(client, { end: false }) })
    up.on('close', () => { if (upOk) wedge(up, client) })
    client.on('close', () => { if (upOk) wedge(client, up); else up.destroy() })
  })
  await new Promise(r => srv.listen(port, host, r))
  return srv
}

// ============ Phase 1: restart heal (B restarts as a new process on a new port, behind a half-open link) ============
const B1_PORT = 13802, B2_PORT = 13806, A_PORT = 13800, RELAY_PORT = 13810
// Half-open relay: A -> 127.0.0.3:13810 -> B1 (127.0.0.2:13802). When B1 dies the relay keeps A's side OPEN and
// swallows A's writes, so from A the link stays ESTABLISHED (the LITTLE<->Mac state). New dials after B1 is gone
// fail upstream and are closed, as a dead port would be.
const relay = await halfOpenRelay('127.0.0.3', RELAY_PORT, '127.0.0.2', B1_PORT)

// long refresh/expiry here, so only the RESTART-replacement path (not expiry) can heal within this phase
const P1 = { AI_BRIDGE_GOSSIP_REFRESH_MS: '20000', AI_BRIDGE_PEER_EXPIRY_MS: '60000', AI_BRIDGE_PEER_PROBE_MS: '500' }
const B1 = await spawn('HostB', '127.0.0.2', B1_PORT, P1); all.push(B1)
const A = await spawn('HostA', '127.0.0.1', A_PORT, { ...P1, AI_BRIDGE_SEEDS: `127.0.0.3:${RELAY_PORT},127.0.0.2:${B2_PORT}` }); all.push(A)
const b1Id = (await call(B1, 'my_identity')).session
const bp1 = await call(B1, 'register_self', { name: 'Bpeer', secret: 'sb', project: 'Heal' })
await call(A, 'register_self', { name: 'Apeer', secret: 'sa', project: 'Heal' })
await sleep(1500)
let aSess = await sessionsOf(A)
check('A federates with B1 through the relay and sees its sub-peer at B1\'s port',
  aSess.some(s => s.origin === b1Id && Number(s.port) === B1_PORT && (s.subpeers || []).some(sp => sp.id === bp1.peer_id)), brief(aSess))

await B1.transport.close()   // B1 dies; the relay keeps A's end of the link open
await sleep(800)
aSess = await sessionsOf(A)
check('harness: B1\'s death is invisible to A (half-open link, stale slice retained — the #63 precondition)',
  aSess.some(s => s.origin === b1Id), brief(aSess))

// B restarts: new process -> new gateway session, NEW port. Same identity -> same stable sub-peer id.
const B2 = await spawn('HostB', '127.0.0.2', B2_PORT, P1); all.push(B2)
const b2Id = (await call(B2, 'my_identity')).session
const bp2 = await call(B2, 'register_self', { name: 'Bpeer', secret: 'sb', project: 'Heal' })
check('harness: the restarted B has a new session but the same stable sub-peer id', b2Id !== b1Id && bp2.peer_id === bp1.peer_id, `${b1Id} ${b2Id} ${bp1.peer_id} ${bp2.peer_id}`)
await sleep(2500)   // discovery dial of the new B + the same-host PING probe window
aSess = await sessionsOf(A)
check('A holds NO roster entries from B\'s old origin after the restart', !aSess.some(s => s.origin === b1Id), brief(aSess))
check('A sees the restarted B\'s gateway session at the NEW port', aSess.some(s => s.session === b2Id && s.origin === b2Id && Number(s.port) === B2_PORT), brief(aSess))
const owners = aSess.filter(s => (s.subpeers || []).some(sp => sp.id === bp2.peer_id))
check('the sub-peer resolves to exactly one owner: the new B, at the new port',
  owners.length === 1 && owners[0].origin === b2Id && Number(owners[0].port) === B2_PORT, brief(owners))
const sent = await call(A, 'send_to_peer', { as: 'Apeer', secret: 'sa', target: bp2.peer_id, verb: 'test', subject: 'heal-after-restart', message: 'reaches the new B' })
check('A -> sub-peer on the restarted B is delivered ok', sent.ok === true, JSON.stringify(sent))
await sleep(400)
const mail = await call(B2, 'inbox', { for: bp2.peer_id, secret: 'sb', cursor: 0 })
check('the restarted B\'s sub-peer actually RECEIVES it (inbox, not just ok)',
  (mail.messages || []).some(m => m.subject === 'heal-after-restart'), JSON.stringify((mail.messages || []).map(m => m.subject)))
for (const b of [A, B2]) { try { await b.transport.close() } catch {} }
relay.close()

// ============ Phase 1b: restart on the SAME port, the restarted peer dialing US (inbound link) ============
// B (127.0.0.1:13830, the smaller address) dials A3 through a relay; B dies behind it (A3's inbound socket stays
// open), then restarts on the SAME port and dials in again. Two live gateways can't share one host:port, so A3
// must retire the old session immediately — no probe needed, and this works for an inbound link too.
const A3_PORT = 13840, B3_PORT = 13830, RELAY2_PORT = 13850
const relay2 = await halfOpenRelay('127.0.0.3', RELAY2_PORT, '127.0.0.1', A3_PORT)
const A3 = await spawn('HostA3', '127.0.0.1', A3_PORT, P1); all.push(A3)
const B3a = await spawn('HostB3', '127.0.0.1', B3_PORT, { ...P1, AI_BRIDGE_SEEDS: `127.0.0.3:${RELAY2_PORT}` }); all.push(B3a)
const b3aId = (await call(B3a, 'my_identity')).session
const bp3a = await call(B3a, 'register_self', { name: 'B3peer', secret: 's3', project: 'Heal' })
await call(A3, 'register_self', { name: 'A3peer', secret: 'sa3', project: 'Heal' })
await sleep(1500)
let a3 = await sessionsOf(A3)
check('A3 is dialed by B (through the relay) and sees its sub-peer', a3.some(s => s.origin === b3aId && (s.subpeers || []).some(sp => sp.id === bp3a.peer_id)), brief(a3))
await B3a.transport.close()
await sleep(800)
a3 = await sessionsOf(A3)
check('harness: the dialer\'s death is invisible to A3 (half-open inbound link)', a3.some(s => s.origin === b3aId), brief(a3))
const B3b = await spawn('HostB3', '127.0.0.1', B3_PORT, { ...P1, AI_BRIDGE_SEEDS: `127.0.0.3:${RELAY2_PORT}` }); all.push(B3b)
const b3bId = (await call(B3b, 'my_identity')).session
const bp3b = await call(B3b, 'register_self', { name: 'B3peer', secret: 's3', project: 'Heal' })
await sleep(1500)
a3 = await sessionsOf(A3)
check('same-port restart: A3 retires the old session at once (no old-origin entries)', b3bId !== b3aId && !a3.some(s => s.origin === b3aId), brief(a3))
check('same-port restart: A3 sees the restarted B and its sub-peer', a3.some(s => s.origin === b3bId && (s.subpeers || []).some(sp => sp.id === bp3b.peer_id)), brief(a3))
const sent3 = await call(A3, 'send_to_peer', { as: 'A3peer', secret: 'sa3', target: bp3b.peer_id, verb: 'test', subject: 'heal-same-port', message: 'reaches the restarted B' })
await sleep(400)
const mail3 = await call(B3b, 'inbox', { for: bp3b.peer_id, secret: 's3', cursor: 0 })
check('A3 -> restarted B\'s sub-peer is delivered and received', sent3.ok === true && (mail3.messages || []).some(m => m.subject === 'heal-same-port'), JSON.stringify(sent3))
for (const b of [A3, B3b]) { try { await b.transport.close() } catch {} }
relay2.close()

// ============ Phase 2: expiry heal + mixed-version guard ============
// refresh 300ms / expiry 1200ms. A dials once (long discovery interval) so an expired peer is not re-linked mid-check.
const P2 = { AI_BRIDGE_GOSSIP_REFRESH_MS: '300', AI_BRIDGE_PEER_EXPIRY_MS: '1200' }
const Bs = await spawn('HostSilent', '127.0.0.2', 13822, { ...P2, AI_BRIDGE_TEST_GOSSIP: 'silent' }); all.push(Bs)   // declares refresh, then goes quiet (no gossip/refresh/PONG), socket stays open
const Bn = await spawn('HostQuiet', '127.0.0.4', 13824, P2); all.push(Bn)                                           // a normal 1.44 peer whose slice never changes
const Bl1 = await spawn('HostLegacyA', '127.0.0.5', 13826, { ...P2, AI_BRIDGE_TEST_GOSSIP: 'legacy' }, LEGACY); all.push(Bl1) // <=1.43-style, A dials it
const Bl2 = await spawn('HostLegacyB', '127.0.0.1', 13818, { ...P2, AI_BRIDGE_TEST_GOSSIP: 'legacy', AI_BRIDGE_SEEDS: '127.0.0.1:13820' }, LEGACY); all.push(Bl2)   // <=1.43-style, dials A (smaller addr)
await sleep(800)
const A2 = await spawn('HostA2', '127.0.0.1', 13820, { ...P2, AI_BRIDGE_DISCOVERY_MS: '30000', AI_BRIDGE_SEEDS: '127.0.0.2:13822,127.0.0.4:13824,127.0.0.5:13826' }); all.push(A2)
await sleep(700)
const names = ss => ss.filter(s => s.origin).map(s => s.name)
let a2 = await sessionsOf(A2)
check('A links all four peers (silent, quiet, legacy-dialed, legacy-dialer)',
  ['HostSilent', 'HostQuiet', 'HostLegacyA', 'HostLegacyB'].every(n => names(a2).includes(n)), brief(a2))
await sleep(2300)   // > expiry (1200ms) + one refresh tick
a2 = await sessionsOf(A2)
check('A EXPIRES the silent-but-connected peer\'s slice within the expiry window', !names(a2).includes('HostSilent'), brief(a2))
const bsView = await sessionsOf(Bs)
check('the expired link\'s socket was destroyed (the silent peer lost A too, so discovery can re-dial)', !bsView.some(s => s.name === 'HostA2'), brief(bsView))
await sleep(2000)   // now well past 3x expiry since link-up
a2 = await sessionsOf(A2)
check('a refresh-capable peer whose slice never changes is NOT expired (refresh + PONG keep it live)', names(a2).includes('HostQuiet'), brief(a2))
check('mixed-version: a legacy peer A dialed is NOT expired (it answers PING on its control port)', names(a2).includes('HostLegacyA'), brief(a2))
check('mixed-version: a legacy peer that dialed A is NEVER expired for being quiet', names(a2).includes('HostLegacyB'), brief(a2))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch {} }
process.exit(fail ? 1 : 0)
