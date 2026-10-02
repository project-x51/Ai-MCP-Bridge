// #72 — an allow_project grant is ANNOUNCED to the granted project. Live 2026-09-30: Ferret granted AIMB bidirectional
// access and got `notified: 0` (no pending request_project_access), so no AIMB session ever learned it could now reach
// Ferret. Now the bridge where the grant was MADE sends a `project_access_granted` system notice to the granted
// project's live members mesh-wide and parks it for its offline durable registrations; `revoke_project` sends
// `project_access_revoked` the same way. A bridge that LEARNS the grant via gossip announces nothing (one notice per
// change), an identical re-grant is not re-announced, and a pending requester gets its Bug-3 ack exactly once.
//
// Two gateways on distinct loopback IPs (127.0.0.1 / 127.0.0.2) stand in for two hosts, each with its own file store.
// Host 1 holds the granter (Alpha), a Beta sub-peer on the SAME bridge, and an OFFLINE durable Beta registration;
// host 2 holds a Beta sub-peer on ANOTHER bridge (it learns the grant only by gossip) and an Alpha sub-peer.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 13700)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-fix proof run this test against a reverted copy
const TOKEN = 'grantnoticetok'
const P1_PORT = String(tp(13700)), P2_PORT = String(tp(13702))
const persist1 = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-gnotice1-'))
const persist2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-gnotice2-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(name, bind, port, persistDir, extra) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin',
      AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir, AI_BRIDGE_TEST_GOSSIP: '',
      AI_BRIDGE_GOSSIP_REFRESH_MS: '60000',
      AI_BRIDGE_STABLE_IDS: '1',   // #81: pinned (it was inherited from the operator's config.json; without it a re-register mints a NEW id and step 3's deregister misses it)
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: '', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)
const all = []
const H2 = await spawn('Host2', '127.0.0.2', P2_PORT, persist2); all.push(H2)
const H1 = await spawn('Host1', '127.0.0.1', P1_PORT, persist1, { AI_BRIDGE_SEEDS: '127.0.0.2:' + P2_PORT }); all.push(H1)
await sleep(1200)

const GR = { as: 'Granter', secret: 'gr' }
const reg = (h, name, secret, project) => call(h, 'register_self', { name, secret, project })
await reg(H1, 'Granter', 'gr', 'Alpha')
await reg(H1, 'BetaLocal', 'bl', 'Beta')                    // granted project, SAME bridge as the granter
await reg(H2, 'BetaRemote', 'br', 'Beta')                   // granted project, ANOTHER bridge (learns the grant by gossip)
await reg(H2, 'AlphaRemote', 'ar', 'Alpha')                 // granting project on host 2 (for the one-way consent check)
const off = await reg(H1, 'BetaOff', 'bo', 'Beta')          // durable Beta registration on host 1 ...
await call(H1, 'deregister', { peer_id: off.peer_id, secret: 'bo' })   // ... that goes OFFLINE (the durable record stays)
const off2 = await reg(H2, 'BetaOff2', 'b2', 'Beta')        // an offline durable Beta registration in host 2's store
await call(H2, 'deregister', { peer_id: off2.peer_id, secret: 'b2' })
await sleep(1500)   // gossip each host's sub-peers into the other's roster
const h1Subs = (await call(H1, 'list_sessions')).sessions.flatMap(s => s.subpeers || []).map(s => s.name)
check('harness: host 1 sees host 2\'s Beta sub-peer (federated roster)', h1Subs.includes('BetaRemote'), JSON.stringify(h1Subs))

const inbox = async (h, name, secret) => (await call(h, 'inbox', { for: name, secret, cursor: 0 })).messages || []
const ofVerb = (msgs, v) => msgs.filter(m => m.verb === v)
const body = m => { try { return JSON.parse(m.body) } catch { return {} } }

// ---- 1. a one-way grant Alpha -> Beta (Beta may initiate to Alpha) is announced
const g1 = await call(H1, 'allow_project', { project: 'Beta', ...GR })
check('allow_project ok (one-way, forever)', g1.ok === true && g1.allow.mode === 'send', JSON.stringify(g1))
check('return counts the notices: announced to the 2 live Beta sub-peers, parked 1, notified = 3 (was 0)',
  g1.announced === 2 && g1.parked === 1 && g1.notified === 3 && g1.notified_pending === 0, JSON.stringify(g1))
await sleep(800)
let bl = await inbox(H1, 'BetaLocal', 'bl'), br = await inbox(H2, 'BetaRemote', 'br')
const nl = ofVerb(bl, 'project_access_granted'), nr = ofVerb(br, 'project_access_granted')
check('a live Beta sub-peer on the SAME bridge got project_access_granted', nl.length === 1, JSON.stringify(bl.map(m => m.verb)))
check('a live Beta sub-peer on ANOTHER bridge got it', nr.length === 1, JSON.stringify(br.map(m => m.verb)))
const b1 = nl[0] ? body(nl[0]) : {}
check('the notice names the granting + granted project, the mode (one-way) and the granter',
  b1.action === 'granted' && b1.granting_project === 'Alpha' && b1.granted_project === 'Beta' && b1.mode === 'send' && b1.one_way === true &&
  b1.granted_by?.name === 'Granter' && b1.ttl_minutes == null && b1.expires_at == null && b1.direction === 'Beta -> Alpha', JSON.stringify(b1))
check('the public subject is short and says who granted whom what', nl[0]?.subject === 'Alpha granted Beta access (one-way)', nl[0]?.subject)
check('the notice comes FROM the granter (a reply reaches it)', nl[0]?.from?.name === 'Granter' && nr[0]?.from?.name === 'Granter', JSON.stringify(nl[0]?.from))
// consent: the notice ran Alpha -> Beta, a direction this one-way grant leaves CLOSED — ordinary traffic still can't
const denied = await call(H1, 'send_to_peer', { ...GR, target: 'BetaLocal', verb: 'test', subject: 'a->b', message: 'x' })
check('one-way: an ordinary Alpha -> Beta send is still project-denied (the notice opened no general path)', denied.ok === false && denied.code === 'project-denied', JSON.stringify(denied))
const deniedX = await call(H2, 'send_to_peer', { as: 'AlphaRemote', secret: 'ar', target: 'BetaRemote', verb: 'test', subject: 'a->b remote', message: 'x' })
check('one-way: Alpha -> Beta on host 2 is still project-denied too', deniedX.ok === false && deniedX.code === 'project-denied', JSON.stringify(deniedX))
const okBA = await call(H2, 'send_to_peer', { as: 'BetaRemote', secret: 'br', target: 'Granter', verb: 'test', subject: 'b->a', message: 'x' })
check('the granted direction Beta -> Alpha works (cross-host)', okBA.ok === true, JSON.stringify(okBA))

// ---- 2. the offline durable Beta registration got it parked, and receives it on re-register
const offBack = await reg(H1, 'BetaOff', 'bo', 'Beta')
await sleep(200)
const bo = ofVerb(await inbox(H1, 'BetaOff', 'bo'), 'project_access_granted')
check('an OFFLINE durable Beta registration gets the notice parked + delivered on re-register', offBack.ok === true && bo.length === 1 && body(bo[0]).granting_project === 'Alpha', JSON.stringify(bo.map(m => m.subject)))

// ---- 3. no duplicates: host 2 learned the grant by gossip and announced nothing (counts above were 1 each); its own
//         offline durable Beta registration gets nothing either (only the granting bridge announces)
await sleep(600)
br = await inbox(H2, 'BetaRemote', 'br'); bl = await inbox(H1, 'BetaLocal', 'bl')
check('no duplicate from the bridge that learned the grant by gossip (one notice each, after settling)',
  ofVerb(br, 'project_access_granted').length === 1 && ofVerb(bl, 'project_access_granted').length === 1, JSON.stringify([br.map(m => m.verb), bl.map(m => m.verb)]))
await reg(H2, 'BetaOff2', 'b2', 'Beta'); await sleep(200)
const bo2 = await inbox(H2, 'BetaOff2', 'b2')
check('the gossip-learning bridge parked nothing for its own offline Beta registration', ofVerb(bo2, 'project_access_granted').length === 0, JSON.stringify(bo2.map(m => m.verb)))
await call(H2, 'deregister', { peer_id: off2.peer_id, secret: 'b2' })

// ---- 4. an identical re-grant is not re-announced; a changed one is
const g2 = await call(H1, 'allow_project', { project: 'Beta', ...GR })
check('an identical re-grant (same mode, forever) announces nothing', g2.ok === true && g2.notified === 0 && g2.announce === 'unchanged', JSON.stringify(g2))
const g3 = await call(H1, 'allow_project', { project: 'Beta', mode: 'bidirectional', ttl_minutes: 30, ...GR })
check('a CHANGED grant (bidirectional, 30m) is announced again', g3.ok === true && g3.announced === 3 && !g3.announce, JSON.stringify(g3))   // BetaLocal, BetaRemote, BetaOff (back online)
await sleep(800)
const nb = ofVerb(await inbox(H2, 'BetaRemote', 'br'), 'project_access_granted')
const b3 = nb[1] ? body(nb[1]) : {}
check('the changed notice says bidirectional (the reverse direction is open too) + the TTL/expiry',
  nb.length === 2 && b3.mode === 'bidirectional' && b3.one_way === false && b3.direction === 'Beta <-> Alpha' && b3.ttl_minutes === 30 && !!b3.expires_at && /Alpha sessions may initiate to Beta/.test(b3.note || ''),
  JSON.stringify(nb.map(m => m.subject)))
check('... with the mode + TTL in the subject', nb[1]?.subject === 'Alpha granted Beta access (bidirectional, 30m)', nb[1]?.subject)
const g4 = await call(H1, 'allow_project', { project: 'Beta', mode: 'bidirectional', ttl_minutes: 30, ...GR })
check('an identical re-grant with the same TTL announces nothing', g4.ok === true && g4.notified === 0 && g4.announce === 'unchanged', JSON.stringify(g4))
await sleep(600)
check('... and nothing new arrived', ofVerb(await inbox(H2, 'BetaRemote', 'br'), 'project_access_granted').length === 2)

// ---- 5. revoke announces project_access_revoked on the same path
const rv = await call(H1, 'revoke_project', { project: 'Beta', ...GR })
check('revoke_project announces to the live Beta members', rv.ok === true && rv.revoked === true && rv.announced === 3 && rv.notified === 3, JSON.stringify(rv))
await sleep(800)
const rl = ofVerb(await inbox(H1, 'BetaLocal', 'bl'), 'project_access_revoked'), rr = ofVerb(await inbox(H2, 'BetaRemote', 'br'), 'project_access_revoked')
check('project_access_revoked reached Beta on the same bridge and on another bridge', rl.length === 1 && rr.length === 1, JSON.stringify([rl.length, rr.length]))
const rb = rr[0] ? body(rr[0]) : {}
check('the revoke notice names the projects, the mode revoked and who revoked it',
  rb.action === 'revoked' && rb.granting_project === 'Alpha' && rb.granted_project === 'Beta' && rb.mode === 'bidirectional' && rb.revoked_by?.name === 'Granter' && rr[0]?.subject === 'Alpha revoked Beta access',
  JSON.stringify({ rb, s: rr[0]?.subject }))
const rv2 = await call(H1, 'revoke_project', { project: 'Beta', ...GR })
check('revoking an already-revoked edge announces nothing', rv2.ok === true && rv2.revoked === false && rv2.notified === 0, JSON.stringify(rv2))

// ---- 6. a pending requester gets its Bug-3 ack (with request_id) exactly once; other members get the plain notice
await reg(H1, 'GammaReq', 'gq', 'Gamma')     // requester on the granting bridge (pending requests live where they're made)
await reg(H2, 'GammaOther', 'go', 'Gamma')
await sleep(1200)
const rq = await call(H1, 'request_project_access', { to: 'Alpha', reason: 'need it', as: 'GammaReq', secret: 'gq' })
check('harness: GammaReq asked Alpha for access', rq.ok === true && !!rq.request_id, JSON.stringify(rq))
const g5 = await call(H1, 'allow_project', { project: 'Gamma', ...GR })
check('the grant acks the pending requester and announces to the other Gamma member', g5.notified_pending === 1 && g5.announced === 1 && g5.notified === 2, JSON.stringify(g5))
await sleep(800)
const gq = ofVerb(await inbox(H1, 'GammaReq', 'gq'), 'project_access_granted'), go = ofVerb(await inbox(H2, 'GammaOther', 'go'), 'project_access_granted')
check('the pending requester is notified ONCE, echoing its request_id', gq.length === 1 && body(gq[0]).request_id === rq.request_id, JSON.stringify(gq.map(body)))
check('the other Gamma member gets the plain notice (no request_id)', go.length === 1 && !body(go[0]).request_id && body(go[0]).granted_project === 'Gamma', JSON.stringify(go.map(body)))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch {} }
await sleep(300)
for (const d of [persist1, persist2]) try { fs.rmSync(d, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
