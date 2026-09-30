// #68 — no secret material may leave the process in anything roster-shaped. Each page leaf's entry in the gateway's
// `pages` map holds `capKey`, its reply-cap SIGNING key (makeEnvelope mints with it, verifyReplyCap checks against it),
// and rosterPayload() used to SPREAD those entries — so the key went out in list_sessions, in the follower ROSTER
// frame and in the WS welcome/roster (other pages, dashboards). Whoever holds a page's capKey can mint a valid reply
// cap and deliver to that page from a project with no grant: a cross-project consent bypass. Pages now go out through
// an allow-list (publicPage), like the peer-gossip localPagesSlice always did.
//
// Harness: gateway G (127.0.0.1) + a FOLLOWER F on the same port + a raw control-port follower that records the
// ROSTER frames on the wire, and a peer gateway B (127.0.0.2) with its own page (the #66d remote-page entries). Pages
// on G and B, sub-peers with secrets on G and F. Asserted, at ANY depth, that no key named capKey / secretHash /
// token / sealed (and no serialized Buffer) appears in: G's, F's and B's list_sessions; the raw ROSTER frames; a
// dashboard's and a second (seeAll) page's welcome + roster messages (+ the dashboard's trace_history). Plus a
// functional guard: the reply-cap flow to a page still works (a cross-project reply to the page's message is
// delivered; a fresh send from the same project is still denied). Temp config via AI_BRIDGE_CONFIG (never
// src/config.json), persistence none, ports 14300-14305.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import WebSocket from 'ws'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-fix proof run this test against a reverted copy
const TOKEN = 'rostersecretstok'
const G_PORT = '14300', B_PORT = '14304'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-rostersecrets-'))
const cfg = path.join(TMP, 'config.json')
fs.writeFileSync(cfg, '{}')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).slice(0, 600))) }

// every path (at any depth) whose KEY is secret material, or whose value is a serialized Buffer
const SECRET_KEYS = new Set(['capkey', 'secrethash', 'token', 'sealed'])
function secretsIn(v, at = '$', out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => secretsIn(x, `${at}[${i}]`, out))
  else if (v && typeof v === 'object') {
    if (v.type === 'Buffer' && Array.isArray(v.data)) out.push(`${at} (serialized Buffer)`)
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEYS.has(k.toLowerCase())) out.push(`${at}.${k}`)
      secretsIn(x, `${at}.${k}`, out)
    }
  }
  return out
}
const noSecrets = (label, obj) => { const hits = secretsIn(obj); check(`${label}: no capKey/secretHash/token/sealed at any depth`, hits.length === 0, hits.slice(0, 8).join(', ')) }
const hasPage = (obj, inst) => (obj?.pages || []).some(p => p.instance === inst)

function spawn(name, bind, port, extra) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfg, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_PERSISTENCE: 'none',
      AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_DEFAULT_BEHAVIOR: '', AI_BRIDGE_GOSSIP_REFRESH_MS: '60000',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: '', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)
// a WS leaf (page or dashboard); records EVERY message it is sent
function leaf(host, wsPort, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${wsPort}`)
    const msgs = []
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN, ...hello })))
    ws.on('message', raw => {
      let m = null; try { m = JSON.parse(String(raw)) } catch { return }
      msgs.push(m)
      if (m.type === 'welcome') resolve({ ws, msgs, of: t => msgs.filter(x => x.type === t) })
    })
    ws.on('error', reject)
  })
}
// a raw follower on a gateway's control port (length-prefixed JSON frames): HELLO + REGISTER, then record every frame
function rawFollower(host, port) {
  const frames = []
  const sock = net.connect(Number(port), host)
  const send = o => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); sock.write(Buffer.concat([h, b])) }
  let buf = Buffer.alloc(0)
  sock.on('connect', () => {
    send({ t: 'HELLO', ver: 1, fromBridge: 'test/rawf', fromSession: 'test/rawf', name: 'rawf', auth: TOKEN })
    send({ t: 'REGISTER', session: 'test/rawf', name: 'rawf', port: 1, subpeers: [], topics: [], realm: 'default' })
  })
  sock.on('data', d => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0)
      try { frames.push(JSON.parse(buf.subarray(4, 4 + n).toString())) } catch {}
      buf = buf.subarray(4 + n)
    }
  })
  sock.on('error', () => {})
  return { sock, frames, rosters: () => frames.filter(f => f.type === 'ROSTER' || f.t === 'ROSTER') }
}
async function until(fn, want, ms = 8000) {
  const t0 = Date.now(); let r
  do { r = await fn(); if (want(r)) return r; await sleep(300) } while (Date.now() - t0 < ms)
  return r
}
const all = [], socks = []

// ---- G (gateway), B (peer gateway on another "host"), F (follower of G)
const B = await spawn('SecB', '127.0.0.2', B_PORT, { AI_BRIDGE_SEEDS: `127.0.0.1:${G_PORT}` }); all.push(B)
const G = await spawn('SecG', '127.0.0.1', G_PORT, { AI_BRIDGE_SEEDS: `127.0.0.2:${B_PORT}` }); all.push(G)
await sleep(700)
const F = await spawn('SecF', '127.0.0.1', G_PORT, {}); all.push(F)
await sleep(900)
const gRole = (await call(G, 'my_identity')).role, fRole = (await call(F, 'my_identity')).role
check('harness: G is a gateway, F its follower', gRole === 'gateway' && fRole === 'follower', `${gRole}/${fRole}`)

// sub-peers WITH secrets (each holds secretHash + its own capKey in RAM) on the gateway and on the follower
const rep = await call(G, 'register_self', { name: 'Rep', secret: 'rep-secret', project: 'Other', user: 'robin' })
await call(F, 'register_self', { name: 'FolPeer', secret: 'fol-secret', project: 'Other', user: 'robin' })
await call(G, 'subscribe', { pattern: 'sec/#', as: 'Rep', secret: 'rep-secret' })
// one-way consent: Pages -> Other only (the page may message Rep; Rep may NOT initiate to the page)
const al = await call(G, 'allow_project', { project: 'Pages', as: 'Rep', secret: 'rep-secret' })
check('harness: Rep granted Pages -> Other (one-way)', al.ok === true, JSON.stringify(al))

const raw = rawFollower('127.0.0.1', G_PORT); socks.push(raw.sock)
await sleep(300)
const P = await leaf('127.0.0.1', Number(G_PORT) + 1, { kind: 'page', instance: 'secpg', page_kind: 'watcher', title: 'Secret Page', project: 'Pages', user: 'robin', subject: 'sec/page', subscribe: ['sec/#'] }); socks.push(P.ws)
const PB = await leaf('127.0.0.2', Number(B_PORT) + 1, { kind: 'page', instance: 'secpgB', page_kind: 'watcher', title: 'Remote Page', project: 'Pages', user: 'robin', subscribe: ['sec/#'] }); socks.push(PB.ws)
const D = await leaf('127.0.0.1', Number(G_PORT) + 1, { kind: 'dashboard', instance: 'secdash' }); socks.push(D.ws)
const W = await leaf('127.0.0.1', Number(G_PORT) + 1, { kind: 'page', instance: 'secpg2', page_kind: 'viewer', title: 'Second Page', project: 'Other', user: 'robin', seeAll: true }); socks.push(W.ws)

// ---- 1. list_sessions on the gateway (local + the #66d remote page entries)
const gl = await until(() => call(G, 'list_sessions'), r => ['secpg', 'secpg2', 'secpgB'].every(i => hasPage(r, i)))
check('G list_sessions shows its pages AND B\'s remote page (the check has something to find)', ['secpg', 'secpg2', 'secpgB'].every(i => hasPage(gl, i)), JSON.stringify((gl.pages || []).map(p => p.instance)))
check('... with the public fields intact (title, project, subscriptions, host_label; remote: origin + page_ingress)',
  (() => { const p = gl.pages.find(x => x.instance === 'secpg'), r = gl.pages.find(x => x.instance === 'secpgB')
    return p && p.title === 'Secret Page' && p.project === 'Pages' && (p.subscriptions || []).includes('sec/#') && !!p.host_label && p.identity?.project === 'Pages'
      && r && !!r.origin && r.page_ingress === true })(), JSON.stringify(gl.pages))
check('... and G\'s sub-peer is listed', (gl.sessions || []).some(s => (s.subpeers || []).some(sp => sp.name === 'Rep')), JSON.stringify((gl.sessions || []).map(s => s.subpeers)))
noSecrets('G list_sessions', gl)
const bl = await until(() => call(B, 'list_sessions'), r => hasPage(r, 'secpgB') && hasPage(r, 'secpg'))
check('B list_sessions shows its own page and G\'s', hasPage(bl, 'secpgB') && hasPage(bl, 'secpg'), JSON.stringify((bl.pages || []).map(p => p.instance)))
noSecrets('B list_sessions', bl)

// ---- 2. the follower: its list_sessions (built from the ROSTER it received) and the raw ROSTER frames on the wire
const fl = await until(() => call(F, 'list_sessions'), r => ['secpg', 'secpgB'].every(i => hasPage(r, i)))
check('F (follower) list_sessions shows the gateway\'s pages', ['secpg', 'secpgB'].every(i => hasPage(fl, i)), JSON.stringify((fl.pages || []).map(p => p.instance)))
noSecrets('F (follower) list_sessions', fl)
await until(async () => raw.rosters(), r => r.some(f => hasPage(f, 'secpg')))
const rr = raw.rosters()
check('raw follower received ROSTER frames carrying the page', rr.some(f => hasPage(f, 'secpg')), `${rr.length} ROSTER frames`)
noSecrets('follower ROSTER frames (wire)', rr)

// ---- 3. WS leaves: a dashboard (full roster) and a second page (seeAll) — welcome + every roster push
check('dashboard got a welcome + roster pushes that include the page', hasPage(D.of('welcome')[0], 'secpg') || D.of('roster').some(m => hasPage(m, 'secpg')), JSON.stringify(D.msgs.map(m => m.type)))
noSecrets('dashboard welcome', D.of('welcome'))
noSecrets('dashboard roster pushes', D.of('roster'))
noSecrets('dashboard trace_history', D.of('trace_history'))
check('second page (seeAll) sees the first page in its welcome/roster', hasPage(W.of('welcome')[0], 'secpg') || W.of('roster').some(m => hasPage(m, 'secpg')), JSON.stringify(W.msgs.map(m => m.type)))
noSecrets('second page welcome', W.of('welcome'))
noSecrets('second page roster pushes', W.of('roster'))
noSecrets('first page (all messages)', P.msgs)
noSecrets('remote page on B (all messages)', PB.msgs)

// ---- 4. functional: the reply-cap flow to a page still works (the gateway still holds the page's capKey in RAM)
P.ws.send(JSON.stringify({ type: 'send', ref: 'r1', to: rep.peer_id, verb: 'ask', subject: 'question from page', body: 'ping from page' }))
const sent = await until(async () => P.of('sent').find(m => m.ref === 'r1'), m => !!m, 4000)
check('page -> Rep (Pages -> Other, granted) delivered', sent && sent.ok === true, JSON.stringify(sent))
const inb = await until(() => call(G, 'inbox', { for: rep.peer_id, secret: 'rep-secret' }), r => (r.messages || []).some(m => m.body === 'ping from page'), 4000)
const q = (inb.messages || []).find(m => m.body === 'ping from page')
check('Rep received the page\'s message (with a reply cap)', !!q && q.from?.session === 'page:secpg', JSON.stringify(inb.messages))
const fresh = await call(G, 'send_to_peer', { target: 'page:secpg', subject: 'unsolicited', verb: 'note', message: 'fresh', as: 'Rep', secret: 'rep-secret' })
check('a FRESH Rep -> page send is still denied (no Other -> Pages grant)', fresh.ok === false && fresh.code === 'project-denied', JSON.stringify(fresh))
const reply = q ? await call(G, 'send_to_peer', { target: 'page:secpg', subject: 're: question from page', verb: 'answer', message: 'pong from Rep', as: 'Rep', secret: 'rep-secret', reply_to: q.id }) : {}
check('a cross-project REPLY to the page\'s message is delivered (reply-cap verified against the page\'s capKey)', reply.ok === true, JSON.stringify(reply))
await sleep(400)
const penv = P.of('envelope').map(m => m.envelope)
check('... the page received the reply', penv.some(e => e.body === 'pong from Rep' && e.reply_to === (q && q.id)), JSON.stringify(penv.map(e => e.subject)))
check('... and not the unsolicited send', !penv.some(e => e.subject === 'unsolicited'), JSON.stringify(penv.map(e => e.subject)))

// after all that traffic: one more sweep of everything that went out
noSecrets('G list_sessions (after traffic)', await call(G, 'list_sessions'))
noSecrets('all dashboard messages (after traffic)', D.msgs)
noSecrets('all raw follower frames (after traffic)', raw.frames)

console.log(`\n${pass} passed, ${fail} failed`)
for (const s of socks) { try { s.close ? s.close() : s.destroy() } catch {} }
for (const b of all) { try { await b.transport.close() } catch {} }
await sleep(300)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
