// #54 — send ON BEHALF OF a topic. `send_to_peer {from_topic}` lets the CURRENT owner of a topic speak for it: the
// sending bridge validates ownership (a live owner claim held by the caller, in its project) and stamps a SEPARATE
// cleartext envelope field `from_topic` (+ `from_topic_icon`, the claim icon) — additive, `from` is still the real peer.
// Two gateways on distinct loopback IPs stand in for two hosts: A (127.0.0.1) and B (127.0.0.2), discovery `seeds`,
// file persistence in a temp dir per host, a temp AI_BRIDGE_CONFIG (never src/config.json), ports 14500-14503.
// Cases: (1) the owner sends with from_topic locally + cross-host: the receiver's inbox carries from_topic + icon and
// `from` is still the real peer; the push-channel meta carries it too; a plain send has no from_topic at all;
// (2) a non-owner (and a wildcard, and an un-claimed process) is refused not-topic-owner and nothing is delivered;
// (3) send to topic:Y with from_topic:X fans out to every owner of Y with the field intact; any co-owner of a SHARED
// topic may speak for it (from B, cross-host); (4) a reply to the peer still works, and a reply to topic:<from_topic>
// reaches the topic's owners; (5) parked/offline sends (to an offline topic owner, and to an offline peer by name)
// keep the field after redelivery on re-register; (6) handoff: after release(keep_alive) + a new owner claims, the new
// owner may send from_topic, the old owner can no longer, and mail parked on the ownerless topic drains with its
// from_topic intact; (7) a page may send on behalf of its auto-claimed subject, and only that.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
const tp = testPorts(import.meta.url, 14500)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-change proof run this test against a reverted copy
const TOKEN = 'fromtopictok'
const A_PORT = String(tp(14500)), B_PORT = String(tp(14502))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-fromtopic-'))
const cfg = path.join(TMP, 'config.json')
fs.writeFileSync(cfg, '{}')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).slice(0, 600))) }

function spawn(name, bind, port, extra) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfg, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind,
      AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: path.join(TMP, 'persist-' + name),
      AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_DEFAULT_BEHAVIOR: '', AI_BRIDGE_GOSSIP_REFRESH_MS: '60000',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  const pushed = []
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') pushed.push(n.params) }
  return c.connect(transport).then(() => ({ c, transport, pushed }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)
async function until(fn, want, ms = 8000) {
  const t0 = Date.now(); let r
  do { r = await fn(); if (want(r)) return r; await sleep(300) } while (Date.now() - t0 < ms)
  return r
}
// a sub-peer's inbox, tracked per peer with its own cursor; everything ever served is kept in box[who]
const cursors = {}, box = {}
async function poll(b, who, secret) {
  const r = await call(b, 'inbox', { for: who, secret, cursor: cursors[who] || 0 })
  cursors[who] = r.next_cursor
  const got = r.messages || []
  ;(box[who] = box[who] || []).push(...got)
  return got
}
async function waitMsg(b, who, secret, subject, ms = 6000) {
  const t0 = Date.now()
  do { const m = (box[who] || []).find(x => x.subject === subject); if (m) return m; await poll(b, who, secret); await sleep(150) } while (Date.now() - t0 < ms)
  return (box[who] || []).find(x => x.subject === subject) || null
}
const S = { Retally: { as: 'Retally', secret: 'sr' }, Other: { as: 'Other', secret: 'so' }, LocalRcv: { as: 'LocalRcv', secret: 'sl' },
  RemoteRcv: { as: 'RemoteRcv', secret: 'sm' }, CoRetail: { as: 'CoRetail', secret: 'sc' }, ParkRcv: { as: 'ParkRcv', secret: 'sp' }, NewOwner: { as: 'NewOwner', secret: 'sn' } }
const all = []

// ---- hosts
const B = await spawn('HostB', '127.0.0.2', B_PORT, { AI_BRIDGE_SEEDS: `127.0.0.1:${A_PORT}` }); all.push(B)
const A = await spawn('HostA', '127.0.0.1', A_PORT, { AI_BRIDGE_SEEDS: `127.0.0.2:${B_PORT}` }); all.push(A)
await sleep(900)
const reg = async (b, name, extra = {}) => call(b, 'register_self', { name, secret: S[name].secret, project: 'shop', ...extra })
const retally = await reg(A, 'Retally')
await reg(A, 'Other')
const localRcv = await reg(A, 'LocalRcv', { mode: 'push' })   // push mode: also gets the channel notification
await reg(A, 'ParkRcv')
await reg(A, 'NewOwner')
const remoteRcv = await reg(B, 'RemoteRcv')
await reg(B, 'CoRetail')
check('harness: sub-peers registered on both hosts', retally.ok === true && localRcv.ok === true && remoteRcv.ok === true, JSON.stringify([retally, remoteRcv]))
const RET = retally.peer_id
const c1 = await call(A, 'claim_topic', { topic: 'retail', exclusive: false, icon: '⚡', description: 'retail desk', ...S.Retally })
check('harness: Retally owns retail (shared, icon ⚡)', c1.ok === true && c1.icon === '⚡', JSON.stringify(c1))
const seesRemote = await until(() => call(A, 'list_sessions'), r => (r.sessions || []).some(s => (s.subpeers || []).some(p => p.name === 'RemoteRcv')))
check('harness: A sees B\'s RemoteRcv', (seesRemote.sessions || []).some(s => (s.subpeers || []).some(p => p.name === 'RemoteRcv')))

// ---- (1) the owner sends with from_topic, locally and cross-host
const plain = await call(A, 'send_to_peer', { target: 'LocalRcv', subject: 'plain', message: 'no attribution', ...S.Retally })
const pm = await waitMsg(A, 'LocalRcv', 'sl', 'plain')
check('(1) a plain send carries NO from_topic (unchanged for everyone)', plain.ok === true && !!pm && !('from_topic' in pm) && !('from_topic_icon' in pm), JSON.stringify(pm))
const s1 = await call(A, 'send_to_peer', { target: 'LocalRcv', subject: 'local-ft', verb: 'note', message: 'from the retail desk', from_topic: 'retail', ...S.Retally })
check('(1) local send with from_topic: ok, response echoes from_topic', s1.ok === true && s1.from_topic === 'retail', JSON.stringify(s1))
const m1 = await waitMsg(A, 'LocalRcv', 'sl', 'local-ft')
check('(1) local receiver: inbox carries from_topic + icon', !!m1 && m1.from_topic === 'retail' && m1.from_topic_icon === '⚡', JSON.stringify(m1))
check('(1) local receiver: `from` is still the real peer (Retally)', !!m1 && m1.from?.session === RET && m1.from?.name === 'Retally' && m1.body === 'from the retail desk', JSON.stringify(m1 && m1.from))
const push1 = A.pushed.find(p => p.meta && p.meta.subject === 'local-ft')
check('(1) push-channel meta carries from_topic + from_topic_icon beside from', !!push1 && push1.meta.from_topic === 'retail' && push1.meta.from_topic_icon === '⚡' && push1.meta.from === RET && push1.meta.from_name === 'Retally', JSON.stringify(push1 && push1.meta))
const pushPlain = A.pushed.find(p => p.meta && p.meta.subject === 'plain')
check('(1) push meta for a plain send has no from_topic key', !!pushPlain && !('from_topic' in pushPlain.meta), JSON.stringify(pushPlain && pushPlain.meta))
const s2 = await call(A, 'send_to_peer', { target: remoteRcv.peer_id, subject: 'xhost-ft', verb: 'note', message: 'across hosts', from_topic: 'retail', ...S.Retally })
check('(1) cross-host send with from_topic: ok', s2.ok === true && s2.from_topic === 'retail', JSON.stringify(s2))
const m2 = await waitMsg(B, 'RemoteRcv', 'sm', 'xhost-ft')
check('(1) cross-host receiver: inbox carries from_topic + icon, from = Retally', !!m2 && m2.from_topic === 'retail' && m2.from_topic_icon === '⚡' && m2.from?.session === RET && m2.from?.name === 'Retally', JSON.stringify(m2))

// ---- (2) a non-owner is refused and nothing is delivered
const n1 = await call(A, 'send_to_peer', { target: 'LocalRcv', subject: 'spoof-local', message: 'x', from_topic: 'retail', ...S.Other })
check('(2) non-owner refused: ok:false not-topic-owner (+ topic)', n1.ok === false && n1.code === 'not-topic-owner' && n1.topic === 'retail', JSON.stringify(n1))
const n2 = await call(A, 'send_to_peer', { target: remoteRcv.peer_id, subject: 'spoof-xhost', message: 'x', from_topic: 'retail', ...S.Other })
check('(2) non-owner refused on a cross-host target too', n2.ok === false && n2.code === 'not-topic-owner', JSON.stringify(n2))
const n3 = await call(A, 'send_to_peer', { target: 'topic:retail', subject: 'spoof-topic', message: 'x', from_topic: 'retail', ...S.Other })
check('(2) non-owner refused on a topic send too (nothing fans out)', n3.ok === false && n3.code === 'not-topic-owner' && !n3.fanout, JSON.stringify(n3))
const n4 = await call(A, 'send_to_peer', { target: 'LocalRcv', subject: 'spoof-proc', message: 'x', from_topic: 'retail' })
check('(2) the (un-claimed) process session itself is refused too', n4.ok === false && n4.code === 'not-topic-owner', JSON.stringify(n4))
const n5 = await call(A, 'send_to_peer', { target: 'LocalRcv', subject: 'spoof-wild', message: 'x', from_topic: 'retail/#', ...S.Retally })
check('(2) a wildcard from_topic is refused (even for the owner)', n5.ok === false && n5.code === 'wildcard-from-topic', JSON.stringify(n5))
const n6 = await call(A, 'send_to_peer', { target: 'LocalRcv', subject: 'spoof-foreign', message: 'x', from_topic: '@elsewhere/retail', ...S.Retally })
check('(2) a from_topic in ANOTHER project is refused (you own it only in yours)', n6.ok === false && n6.code === 'not-topic-owner', JSON.stringify(n6))
await sleep(500)
await poll(A, 'LocalRcv', 'sl'); await poll(B, 'RemoteRcv', 'sm'); await poll(A, 'Retally', 'sr')
const spoofSubj = m => /^spoof-/.test(m.subject)
const everything = () => [...(box.LocalRcv || []), ...(box.RemoteRcv || []), ...(box.Retally || [])]
check('(2) ... and none of the refused sends was delivered anywhere', !everything().some(spoofSubj), JSON.stringify(everything().map(m => m.subject)))

// ---- (3) topic fanout: send to topic:desk (owned on BOTH hosts) with from_topic:retail
await call(A, 'claim_topic', { topic: 'desk', exclusive: false, ...S.LocalRcv })
await call(B, 'claim_topic', { topic: 'desk', exclusive: false, ...S.RemoteRcv })
await until(() => call(A, 'list_sessions'), r => (r.sessions || []).flatMap(s => s.topics || []).filter(t => t.role === 'owner' && t.pattern === 'desk').length >= 2)
const f1 = await call(A, 'send_to_peer', { target: 'topic:desk', subject: 'fanout-ft', verb: 'task', message: 'desk work', from_topic: 'retail', ...S.Retally })
check('(3) topic send with from_topic fans out to both owners, all ok', f1.ok === true && f1.from_topic === 'retail' && (f1.fanout || []).length === 2 && f1.fanout.every(x => x.ok), JSON.stringify(f1))
const fl = await waitMsg(A, 'LocalRcv', 'sl', 'fanout-ft'), fr = await waitMsg(B, 'RemoteRcv', 'sm', 'fanout-ft')
check('(3) local owner of desk: topic=desk, from_topic=retail + icon, from=Retally', !!fl && fl.topic === 'desk' && fl.from_topic === 'retail' && fl.from_topic_icon === '⚡' && fl.from?.session === RET, JSON.stringify(fl))
check('(3) remote owner of desk: the same, intact across the splice', !!fr && fr.topic === 'desk' && fr.from_topic === 'retail' && fr.from_topic_icon === '⚡' && fr.from?.session === RET, JSON.stringify(fr))
// any co-owner of a SHARED topic may speak for it — CoRetail on B, whose claim has no icon of its own
const co = await call(B, 'claim_topic', { topic: 'retail', exclusive: false, ...S.CoRetail })
check('(3) CoRetail (host B) co-owns shared retail', co.ok === true, JSON.stringify(co))
await until(() => call(B, 'list_sessions'), r => (r.sessions || []).flatMap(s => s.topics || []).some(t => t.role === 'owner' && t.pattern === 'retail' && t.holder_name === 'Retally'))
const cs = await call(B, 'send_to_peer', { target: 'LocalRcv', subject: 'coowner-ft', message: 'co-owner speaks', from_topic: 'retail', ...S.CoRetail })
check('(3) a co-owner of a shared topic may send from_topic', cs.ok === true && cs.from_topic === 'retail', JSON.stringify(cs))
const cm = await waitMsg(A, 'LocalRcv', 'sl', 'coowner-ft')
check('(3) ... received (cross-host) with from_topic + the topic\'s icon, from = CoRetail', !!cm && cm.from_topic === 'retail' && cm.from_topic_icon === '⚡' && cm.from?.name === 'CoRetail', JSON.stringify(cm))

// ---- (4) replies: default reply routing goes to the PEER; topic:<from_topic> is the continuity option
const rp = await call(B, 'send_to_peer', { target: m2.from.session, subject: 'reply-peer', message: 'thanks', reply_to: m2.id, ...S.RemoteRcv })
check('(4) reply to the peer (from.session) is ok', rp.ok === true, JSON.stringify(rp))
const rm = await waitMsg(A, 'Retally', 'sr', 'reply-peer')
check('(4) ... and Retally gets it, reply_to intact', !!rm && rm.reply_to === m2.id && rm.from?.name === 'RemoteRcv', JSON.stringify(rm))
const rt = await call(B, 'send_to_peer', { target: `topic:${m2.from_topic}`, subject: 'reply-topic', message: 'to the desk', reply_to: m2.id, ...S.RemoteRcv })
check('(4) reply to topic:<from_topic> reaches the topic\'s owners', rt.ok === true && (rt.fanout || []).some(x => x.holder_name === 'Retally' && x.ok), JSON.stringify(rt))
const rtm = await waitMsg(A, 'Retally', 'sr', 'reply-topic')
check('(4) ... Retally gets the topic reply', !!rtm && rtm.topic === 'retail', JSON.stringify(rtm))

// ---- (5) parked / offline delivery keeps the field after redelivery
const pc = await call(A, 'claim_topic', { topic: 'backoffice', ...S.ParkRcv })
check('(5) ParkRcv owns backoffice (durable)', pc.ok === true && pc.persistent === true, JSON.stringify(pc))
const parkId = (await call(A, 'list_sessions')).sessions.flatMap(s => s.subpeers || []).find(s => s.name === 'ParkRcv').id
await call(A, 'deregister', { peer_id: parkId, secret: 'sp' })
await sleep(300)
const pk1 = await call(A, 'send_to_peer', { target: 'topic:backoffice', subject: 'parked-topic-ft', message: 'while you were out', from_topic: 'retail', ...S.Retally })
check('(5) send to the offline owner\'s topic PARKS', pk1.ok === true && pk1.parked === true && pk1.from_topic === 'retail', JSON.stringify(pk1))
const pk2 = await call(A, 'send_to_peer', { target: 'ParkRcv', subject: 'parked-name-ft', message: 'by name', from_topic: 'retail', ...S.Retally })
check('(5) send to the offline peer BY NAME parks', pk2.ok === true && pk2.parked === true && pk2.from_topic === 'retail', JSON.stringify(pk2))
await reg(A, 'ParkRcv')   // returns -> durable mailbox drains
await sleep(300)
const pm1 = await waitMsg(A, 'ParkRcv', 'sp', 'parked-topic-ft'), pm2 = await waitMsg(A, 'ParkRcv', 'sp', 'parked-name-ft')
check('(5) parked topic send redelivered with from_topic + icon, from = Retally', !!pm1 && pm1.from_topic === 'retail' && pm1.from_topic_icon === '⚡' && pm1.from?.session === RET, JSON.stringify(pm1))
check('(5) parked by-name send redelivered with from_topic + icon, from = Retally', !!pm2 && pm2.from_topic === 'retail' && pm2.from_topic_icon === '⚡' && pm2.from?.session === RET, JSON.stringify(pm2))

// ---- (6) topic continuity across an ownership handoff
await call(B, 'release_topic', { topic: 'retail', keep_alive: false, ...S.CoRetail })
await until(() => call(A, 'list_sessions'), r => !(r.sessions || []).flatMap(s => s.topics || []).some(t => t.role === 'owner' && t.pattern === 'retail' && t.holder_name === 'CoRetail'))
const coGone = await call(B, 'send_to_peer', { target: 'LocalRcv', subject: 'spoof-coowner-after', message: 'x', from_topic: 'retail', ...S.CoRetail })
check('(6) the co-owner, after releasing, can no longer send from_topic', coGone.ok === false && coGone.code === 'not-topic-owner', JSON.stringify(coGone))
const rel = await call(A, 'release_topic', { topic: 'retail', keep_alive: true, ...S.Retally })
check('(6) Retally releases retail, kept alive for the handoff', rel.ok === true && rel.kept_alive === true, JSON.stringify(rel))
const old1 = await call(A, 'send_to_peer', { target: 'LocalRcv', subject: 'spoof-old-owner', message: 'x', from_topic: 'retail', ...S.Retally })
check('(6) the OLD owner can no longer send from_topic retail', old1.ok === false && old1.code === 'not-topic-owner', JSON.stringify(old1))
// mail to the ownerless (kept-alive) topic, itself sent on behalf of another topic, parks against the topic
const gap = await call(A, 'send_to_peer', { target: 'topic:retail', subject: 'gap-ft', message: 'during the handoff', from_topic: 'desk', ...S.LocalRcv })
check('(6) a send to the ownerless kept-alive topic parks (with from_topic desk)', gap.ok === true && gap.parked === true && gap.ownerless === true && gap.from_topic === 'desk', JSON.stringify(gap))
const nc = await call(A, 'claim_topic', { topic: 'retail', ...S.NewOwner })
check('(6) NewOwner claims retail, inherits the icon, drains the parked mail', nc.ok === true && nc.icon === '⚡' && nc.drained === 1, JSON.stringify(nc))
const gm = await waitMsg(A, 'NewOwner', 'sn', 'gap-ft')
check('(6) the drained mail keeps from_topic=desk and from=LocalRcv', !!gm && gm.from_topic === 'desk' && gm.from?.name === 'LocalRcv', JSON.stringify(gm))
const nw = await call(A, 'send_to_peer', { target: remoteRcv.peer_id, subject: 'new-owner-ft', message: 'still the retail desk', from_topic: 'retail', ...S.NewOwner })
check('(6) the NEW owner can send from_topic retail', nw.ok === true && nw.from_topic === 'retail', JSON.stringify(nw))
const nm = await waitMsg(B, 'RemoteRcv', 'sm', 'new-owner-ft')
check('(6) ... same topic + icon as before the handoff, from = NewOwner', !!nm && nm.from_topic === 'retail' && nm.from_topic_icon === '⚡' && nm.from?.name === 'NewOwner', JSON.stringify(nm))
const old2 = await call(A, 'send_to_peer', { target: 'topic:desk', subject: 'spoof-old-owner-topic', message: 'x', from_topic: 'retail', ...S.Retally })
check('(6) the old owner is still refused after the new claim', old2.ok === false && old2.code === 'not-topic-owner', JSON.stringify(old2))

// ---- (7) a page sends on behalf of its auto-claimed subject
const pg = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${Number(A_PORT) + 1}`)
  const sent = []
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN, kind: 'page', instance: 'kiosk1', page_kind: 'kiosk', title: 'Kiosk', subject: 'kiosk', icon: '🏪', project: 'shop', user: 'robin' })))
  ws.on('message', raw => {
    let m = null; try { m = JSON.parse(String(raw)) } catch { return }
    if (m.type === 'welcome') resolve({ ws, sent })
    else if (m.type === 'sent') sent.push(m)
  })
  ws.on('error', reject)
})
const pageSend = async (ref, extra) => {
  pg.ws.send(JSON.stringify({ type: 'send', ref, to: localRcv.peer_id, verb: 'note', body: 'from the kiosk', ...extra }))
  const t0 = Date.now()
  while (Date.now() - t0 < 4000) { const r = pg.sent.find(x => x.ref === ref); if (r) return r; await sleep(100) }
  return null
}
const pg1 = await pageSend('k1', { subject: 'page-ft', from_topic: 'kiosk' })
check('(7) page sends from_topic = its own subject: ok', !!pg1 && pg1.ok === true, JSON.stringify(pg1))
const pgm = await waitMsg(A, 'LocalRcv', 'sl', 'page-ft')
check('(7) ... received with from_topic kiosk + the page icon, from = the page', !!pgm && pgm.from_topic === 'kiosk' && pgm.from_topic_icon === '🏪' && pgm.from?.session === 'page:kiosk1', JSON.stringify(pgm))
const pg2 = await pageSend('k2', { subject: 'spoof-page', from_topic: 'retail' })
check('(7) a page claiming a topic it does not own is refused not-topic-owner', !!pg2 && pg2.ok === false && pg2.code === 'not-topic-owner', JSON.stringify(pg2))
await sleep(400)
await poll(A, 'LocalRcv', 'sl'); await poll(B, 'RemoteRcv', 'sm'); await poll(A, 'Retally', 'sr')
check('(7) ... and it was not delivered — nor was any other refused (spoof-*) send, over the whole run', !everything().some(spoofSubj), JSON.stringify(everything().filter(spoofSubj).map(m => m.subject)))

console.log(`\n${pass} passed, ${fail} failed`)
try { pg.ws.close() } catch {}
for (const b of all) { try { await b.transport.close() } catch {} }
await sleep(300)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
