// #62 — cross-project consent grants must FEDERATE. Consent is receiver-side (deliveryAllowed → consent.mayInitiate,
// evaluated in the bridge PROCESS hosting the target), but a runtime `allow_project` grant used to live only in the
// one process that ran it. Live 2026-09-29: an AIMB broadcast reached Marz sessions on LITTLE (grant there) but was
// `project-denied` for MapGuy2 — a Marz sub-peer on a FOLLOWER bridge on ROBIN — and for Ferret on the Mac.
//
// Two gateways on distinct loopback IPs (127.0.0.1 / 127.0.0.2) stand in for two hosts; host A also runs a FOLLOWER
// (same IP + port as A's gateway, so it loses the bind and follows) that hosts the target sub-peer, exactly the
// MapGuy2 shape. Cases: denied before any grant; a grant made on host B (NOT where the target lives) lets the send
// through AND land; a revoke on B propagates; a re-grant beats the tombstone; a grant made on A's FOLLOWER goes up to
// A's gateway and out to B; and a grant A LEARNED survives A (gateway + follower) restarting while B is down.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-fix proof run this test against a reverted copy
const TOKEN = 'grantfedtok'
const A_PORT = '13900', B_PORT = '13902'
const persistA = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-grantfed-'))   // host A's store (gateway + follower share it, as on a real host)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(name, bind, port, extra) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_PERSISTENCE: 'none',
      AI_BRIDGE_TEST_GOSSIP: '',
      // a LONG #63 refresh, so every propagation below must be PROMPT (change-driven), not ride the periodic refresh
      AI_BRIDGE_GOSSIP_REFRESH_MS: '60000',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: '', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)
const subjects = m => (m.messages || []).map(x => x.subject)
// poll a send until it is allowed (or give up) — propagation is async, but must be prompt (well inside the 60s refresh)
async function sendUntil(fn, want, ms = 6000) {
  const t0 = Date.now(); let r
  do { r = await fn(); if (want(r)) return r; await sleep(250) } while (Date.now() - t0 < ms)
  return r
}
const fileA = { AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistA }
const all = []

// ---- host B (gateway) + host A (gateway + FOLLOWER). The follower hosts the target sub-peer (the MapGuy2 shape).
const B = await spawn('HostB', '127.0.0.2', B_PORT); all.push(B)
let A = await spawn('HostA', '127.0.0.1', A_PORT, { ...fileA, AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(A)
await sleep(700)
let F = await spawn('HostAF', '127.0.0.1', A_PORT, { ...fileA, AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(F)
await sleep(900)
const aRole = (await call(A, 'my_identity')).role, fRole = (await call(F, 'my_identity')).role
check('harness: host A runs a gateway + a FOLLOWER', aRole === 'gateway' && fRole === 'follower', `${aRole}/${fRole}`)

let mapGuy = await call(F, 'register_self', { name: 'MapGuy', secret: 'mg', project: 'Marz' })    // target: Marz, on A's FOLLOWER
await call(B, 'register_self', { name: 'Bridget', secret: 'bg', project: 'AIMB' })               // sender: AIMB, on host B
await call(B, 'register_self', { name: 'MarzB', secret: 'mb', project: 'Marz' })                 // a Marz operator on host B
await sleep(1200)   // gossip A's follower sub-peer into B's roster
const bSess = (await call(B, 'list_sessions')).sessions || []
check('harness: the follower-hosted target is visible on B (federated)',
  bSess.some(s => (s.subpeers || []).some(sp => sp.id === mapGuy.peer_id)), JSON.stringify(bSess.map(s => ({ n: s.name, subs: (s.subpeers || []).map(x => x.name) }))))

let n = 0
const sendAB = () => call(B, 'send_to_peer', { as: 'Bridget', secret: 'bg', target: mapGuy.peer_id, verb: 'test', subject: `ab-${++n}`, message: 'x' })
const inboxF = async () => subjects(await call(F, 'inbox', { for: mapGuy.peer_id, secret: 'mg', cursor: 0 }))
const isDenied = r => r.ok === false && r.code === 'project-denied'
const isOk = r => r.ok === true && !r.code

// 1. no grant anywhere -> denied, visibly (#61)
const d0 = await sendAB()
check('before any grant: AIMB (host B) -> Marz sub-peer on A\'s follower is project-denied', isDenied(d0), JSON.stringify(d0))

// 2. the grant is made on B (NOT where the target lives) -> it must reach A's gateway AND A's follower
const g = await call(B, 'allow_project', { project: 'AIMB', as: 'MarzB', secret: 'mb' })
check('a Marz session on host B grants AIMB', g.ok === true, JSON.stringify(g))
const s1 = await sendUntil(sendAB, isOk)
check('after the B-side grant: the same cross-host send is ok:true', isOk(s1), JSON.stringify(s1))
await sleep(300)
let got = await inboxF()
check('... and it actually LANDED in the follower-hosted target\'s inbox', got.includes(`ab-${n}`), JSON.stringify(got))
check('... and the denied one did not', !got.includes('ab-1'), JSON.stringify(got))
const fReg = await call(F, 'register_self', { name: 'Probe', secret: 'pr', project: 'AIMB' })
check('the FOLLOWER\'s own consent now lists AIMB -> Marz (register_self access; #71: canonical spelling)', Array.isArray(fReg.access) && fReg.access.includes('Marz'), JSON.stringify(fReg.access))

// 3. revoke on B propagates -> denied again
const rv = await call(B, 'revoke_project', { project: 'AIMB', as: 'MarzB', secret: 'mb' })
check('revoke_project on B', rv.ok === true && rv.revoked === true, JSON.stringify(rv))
const d1 = await sendUntil(sendAB, isDenied)
check('after the B-side revoke: the send is project-denied again', isDenied(d1), JSON.stringify(d1))

// 4. a re-grant (newer) beats the tombstone everywhere
await call(B, 'allow_project', { project: 'AIMB', as: 'MarzB', secret: 'mb' })
const s2 = await sendUntil(sendAB, isOk)
check('a re-grant on B beats the replicated tombstone', isOk(s2), JSON.stringify(s2))

// 5. a grant made on A's FOLLOWER must go UP to A's gateway and OUT to B (edge Ops -> Marz, target MarzB on B)
const opsA = await call(A, 'register_self', { name: 'OpsA', secret: 'oa', project: 'Ops' })
await sleep(300)
const marzBId = (await call(B, 'list_sessions')).sessions.flatMap(s => s.subpeers || []).find(sp => sp.name === 'MarzB')?.id
let m = 0
const sendOps = () => call(A, 'send_to_peer', { as: 'OpsA', secret: 'oa', target: marzBId, verb: 'test', subject: `ops-${++m}`, message: 'x' })
const d2 = await sendOps()
check('before the follower grant: Ops (host A) -> MarzB (host B) is project-denied', !!marzBId && isDenied(d2), JSON.stringify(d2))
const fg = await call(F, 'allow_project', { project: 'Ops', as: mapGuy.peer_id, secret: 'mg' })
check('MapGuy (on A\'s follower) grants Ops', fg.ok === true, JSON.stringify(fg))
const s3 = await sendUntil(sendOps, isOk)
check('the follower-made grant reached host B: Ops -> MarzB is ok:true', isOk(s3), JSON.stringify(s3))
await sleep(300)
const mbIn = subjects(await call(B, 'inbox', { for: 'MarzB', secret: 'mb', cursor: 0 }))
check('... and it landed in MarzB\'s inbox', mbIn.includes(`ops-${m}`), JSON.stringify(mbIn))
void opsA

// 6. durability: the AIMB -> Marz grant A LEARNED (made on B, which has no persistence) survives A restarting while B is down
await B.transport.close(); all.splice(all.indexOf(B), 1)
await sleep(300)
await F.transport.close(); await A.transport.close(); all.length = 0
await sleep(1000)
A = await spawn('HostA', '127.0.0.1', A_PORT, { ...fileA, AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(A)
await sleep(700)
F = await spawn('HostAF', '127.0.0.1', A_PORT, { ...fileA, AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(F)
await sleep(900)
mapGuy = await call(F, 'register_self', { name: 'MapGuy', secret: 'mg', project: 'Marz' })
const aimbA = await call(A, 'register_self', { name: 'AimbLocal', secret: 'al', project: 'AIMB' })
check('after A restarts (B down): A\'s gateway still knows AIMB -> Marz', Array.isArray(aimbA.access) && aimbA.access.includes('Marz'), JSON.stringify(aimbA.access))
await sleep(500)
const s4 = await call(A, 'send_to_peer', { as: 'AimbLocal', secret: 'al', target: mapGuy.peer_id, verb: 'test', subject: 'after-restart', message: 'x' })
check('after A restarts (B down): AIMB -> the Marz sub-peer on the restarted follower is ok:true', isOk(s4), JSON.stringify(s4))
await sleep(300)
got = await inboxF()
check('... and it landed', got.includes('after-restart'), JSON.stringify(got))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch {} }
await sleep(300)
try { fs.rmSync(persistA, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
