// #66(d) — a page (web leaf) on ANOTHER host must be reachable. Gossiped pages used to carry display fields only and
// page delivery was local-only, so a publish on host A never reached a page connected to host B's gateway even though
// A could see it. Pages now gossip their subscriptions (+ `page_ingress`), allTopicEntries/subscribersOf include remote
// pages, and an envelope for a remote page:<instance> is dialed to its owning gateway, which hands it to deliverPage
// (consent checked THERE) and returns the real outcome in the #61 CLOSE code.
//
// Three gateways on distinct loopback IPs stand in for three hosts: A (127.0.0.1, + a FOLLOWER), B (127.0.0.2) with a
// page leaf, and C (127.0.0.3) — an OLDER gateway, mimicked with AI_BRIDGE_TEST_GOSSIP=legacy (or spawned from a real
// pre-1.48 copy named by AIMB_TEST_LEGACY_BRIDGE) — with a page of its own. Every bridge reads a temp config via
// AI_BRIDGE_CONFIG (never src/config.json); no persistence. Cases: (1) a publish on A's gateway AND on A's follower
// reaches B's page, fanout ok:true; (2) a directed send_to_peer to page:<instance> (and by title) from A works;
// (3) a sender whose project the page can't receive from gets ok:false project-denied, and the page gets nothing;
// (4) the page on the older gateway is not a subscriber and a directed send fails honestly (page-remote-unsupported);
// (5) B's control port rejects a CONNECT to an unknown page with page-gone.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import WebSocket from 'ws'
const tp = testPorts(import.meta.url, 14110)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-change proof run this test against a reverted copy
const LEGACY = process.env.AIMB_TEST_LEGACY_BRIDGE || ''       // optional: a real ≤1.47 bridge copy for host C
const TOKEN = 'pageremotetok'
const A_PORT = String(tp(14110)), B_PORT = String(tp(14112)), C_PORT = String(tp(14114))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-pageremote-'))
const cfg = path.join(TMP, 'config.json')
fs.writeFileSync(cfg, '{}')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(name, bind, port, extra, script = BRIDGE) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + script], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfg, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_PERSISTENCE: 'none',
      AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_DEFAULT_BEHAVIOR: '', AI_BRIDGE_GOSSIP_REFRESH_MS: '60000',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: '', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)
// a page leaf on a gateway's WS port; collects the envelopes it is handed
function page(host, wsPort, instance, title, project, subscribe) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${wsPort}`)
    const got = []
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN, kind: 'page', instance, page_kind: 'watcher', title, project, user: 'robin', subscribe })))
    ws.on('message', raw => {
      let m = null; try { m = JSON.parse(String(raw)) } catch { return }
      if (m.type === 'welcome') resolve({ ws, got })
      else if (m.type === 'envelope') got.push(m.envelope)
    })
    ws.on('error', reject)
  })
}
// a raw control-port client (length-prefixed JSON frames): HELLO + CONNECT, resolve with the first reply frame
function rawConnect(host, port, target) {
  return new Promise(resolve => {
    const sock = net.connect(Number(port), host)
    const send = o => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); sock.write(Buffer.concat([h, b])) }
    let buf = Buffer.alloc(0)
    const t = setTimeout(() => { sock.destroy(); resolve({ t: 'timeout' }) }, 3000)
    sock.on('connect', () => { send({ t: 'HELLO', ver: 1, fromBridge: 'test/raw', fromSession: 'test/raw', name: 'raw', auth: TOKEN }); send({ t: 'CONNECT', target }) })
    sock.on('data', d => {
      buf = Buffer.concat([buf, d])
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) { clearTimeout(t); const f = JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString()); sock.destroy(); resolve(f) }
    })
    sock.on('error', e => { clearTimeout(t); resolve({ t: 'error', code: e.code }) })
  })
}
async function until(fn, want, ms = 8000) {
  const t0 = Date.now(); let r
  do { r = await fn(); if (want(r)) return r; await sleep(300) } while (Date.now() - t0 < ms)
  return r
}
const pageEntry = (r, inst) => (r.fanout || []).find(f => f.to === 'page:' + inst)
const subjectsOf = pg => pg.got.map(e => e.subject)
const all = [], pagesOpen = []

// ---- hosts: B (page host), C (older gateway), A (gateway + follower). Everyone seeds everyone.
const B = await spawn('HostB', '127.0.0.2', B_PORT, { AI_BRIDGE_SEEDS: `127.0.0.1:${A_PORT},127.0.0.3:${C_PORT}` }); all.push(B)
const C = LEGACY
  ? await spawn('HostC', '127.0.0.3', C_PORT, { AI_BRIDGE_SEEDS: `127.0.0.1:${A_PORT},127.0.0.2:${B_PORT}` }, LEGACY)
  : await spawn('HostC', '127.0.0.3', C_PORT, { AI_BRIDGE_SEEDS: `127.0.0.1:${A_PORT},127.0.0.2:${B_PORT}`, AI_BRIDGE_TEST_GOSSIP: 'legacy' })
all.push(C)
const A = await spawn('HostA', '127.0.0.1', A_PORT, { AI_BRIDGE_SEEDS: `127.0.0.2:${B_PORT},127.0.0.3:${C_PORT}` }); all.push(A)
await sleep(700)
const F = await spawn('HostAF', '127.0.0.1', A_PORT, { AI_BRIDGE_SEEDS: `127.0.0.2:${B_PORT}` }); all.push(F)
await sleep(900)
const aRole = (await call(A, 'my_identity')).role, fRole = (await call(F, 'my_identity')).role
check('harness: host A runs a gateway + a FOLLOWER', aRole === 'gateway' && fRole === 'follower', `${aRole}/${fRole}`)

const pgB = await page('127.0.0.2', Number(B_PORT) + 1, 'pgB', 'Watcher B', 'News', ['news/#']); pagesOpen.push(pgB)
const pgC = await page('127.0.0.3', Number(C_PORT) + 1, 'pgC', 'Watcher C', 'News', ['news/#']); pagesOpen.push(pgC)
const seen = await until(() => call(A, 'list_sessions'), r => ['pgB', 'pgC'].every(i => (r.pages || []).some(p => p.instance === i)))
check('harness: A sees both remote pages (B\'s and the older C\'s)', ['pgB', 'pgC'].every(i => (seen.pages || []).some(p => p.instance === i)), JSON.stringify((seen.pages || []).map(p => p.instance)))

await call(A, 'register_self', { name: 'PubA', secret: 'pa', project: 'News' })
await call(F, 'register_self', { name: 'PubF', secret: 'pf', project: 'News' })
await call(A, 'register_self', { name: 'OtherA', secret: 'oa', project: 'Other' })

// 1. publish on A's gateway and on A's follower -> B's page
let n = 0
const pubA = () => call(A, 'publish', { topic: 'news/live', subject: `a-${++n}`, message: 'hello page', as: 'PubA', secret: 'pa' })
const r1 = await until(pubA, r => !!pageEntry(r, 'pgB'))
check('a publish on A lists B\'s page as a subscriber, fanout ok:true', pageEntry(r1, 'pgB')?.ok === true && !pageEntry(r1, 'pgB')?.code, JSON.stringify(r1.fanout))
await sleep(300)
check('... and B\'s page actually received it', subjectsOf(pgB).includes(`a-${n}`), JSON.stringify(subjectsOf(pgB)))
const bodyOk = pgB.got.find(e => e.subject === `a-${n}`)
check('... decrypted, from A\'s publisher, as a publish on the topic', bodyOk && bodyOk.body === 'hello page' && bodyOk.pattern === 'publish' && bodyOk.topic === 'news/live' && bodyOk.from?.name === 'PubA', JSON.stringify(bodyOk))
const r2 = await until(() => call(F, 'publish', { topic: 'news/live', subject: 'from-follower', message: 'x', as: 'PubF', secret: 'pf' }), r => !!pageEntry(r, 'pgB'))
check('a publish on A\'s FOLLOWER reaches B\'s page too (fanout ok:true)', pageEntry(r2, 'pgB')?.ok === true, JSON.stringify(r2.fanout))
await sleep(300)
check('... and it landed', subjectsOf(pgB).includes('from-follower'), JSON.stringify(subjectsOf(pgB)))

// 2. directed send_to_peer to the remote page
const d1 = await call(A, 'send_to_peer', { target: 'page:pgB', subject: 'direct-A', verb: 'note', message: 'd', as: 'PubA', secret: 'pa' })
check('send_to_peer page:<instance> on B from A\'s gateway is ok:true', d1.ok === true && !d1.code && d1.to === 'page:pgB', JSON.stringify(d1))
const d2 = await call(A, 'send_to_peer', { target: 'Watcher B', subject: 'direct-title', verb: 'note', message: 'd', as: 'PubA', secret: 'pa' })
check('... also by the remote page\'s unique title', d2.ok === true && d2.to === 'page:pgB', JSON.stringify(d2))
const d3 = await call(F, 'send_to_peer', { target: 'page:pgB', subject: 'direct-F', verb: 'note', message: 'd', as: 'PubF', secret: 'pf' })
check('... and from A\'s follower — a REAL outcome, not the blind PAGE_MSG forward (forwarded:gateway)', d3.ok === true && !d3.code && !d3.forwarded, JSON.stringify(d3))
await sleep(300)
check('... all three landed on B\'s page', ['direct-A', 'direct-title', 'direct-F'].every(s => subjectsOf(pgB).includes(s)), JSON.stringify(subjectsOf(pgB)))

// 3. consent is checked on the page's host and reported honestly
const r3 = await call(A, 'publish', { topic: '@News/news/live', subject: 'denied-pub', message: 'no', as: 'OtherA', secret: 'oa' })
check('an Other-project publish to @News: B\'s page entry is ok:false project-denied', pageEntry(r3, 'pgB')?.ok === false && pageEntry(r3, 'pgB')?.code === 'project-denied', JSON.stringify(r3.fanout))
const d4 = await call(A, 'send_to_peer', { target: 'page:pgB', subject: 'denied-direct', verb: 'note', message: 'no', as: 'OtherA', secret: 'oa' })
check('an Other-project send_to_peer to the page is ok:false project-denied', d4.ok === false && d4.code === 'project-denied', JSON.stringify(d4))
await sleep(300)
check('... and neither reached the page', !subjectsOf(pgB).includes('denied-pub') && !subjectsOf(pgB).includes('denied-direct'), JSON.stringify(subjectsOf(pgB)))

// 4. a page on an OLDER gateway: not a subscriber, and a directed send fails honestly
const r4 = await pubA()
check('the older gateway\'s page is NOT in the fanout (it cannot be reached, so it is not listed)', !pageEntry(r4, 'pgC') && pageEntry(r4, 'pgB')?.ok === true, JSON.stringify(r4.fanout))
const d5 = await call(A, 'send_to_peer', { target: 'page:pgC', subject: 'to-legacy', verb: 'note', message: 'x', as: 'PubA', secret: 'pa' })
check('send_to_peer to the older gateway\'s page is ok:false page-remote-unsupported (never a silent ok)', d5.ok === false && d5.code === 'page-remote-unsupported', JSON.stringify(d5))
await sleep(300)
check('... and the older gateway\'s page received nothing', pgC.got.length === 0, JSON.stringify(subjectsOf(pgC)))

// 5. B's control port: a CONNECT for a page it doesn't hold is refused with a clear code
const rj = await rawConnect('127.0.0.2', B_PORT, 'page:nope')
check('B rejects CONNECT page:<unknown> with page-gone', rj.t === 'REJECT' && rj.code === 'page-gone', JSON.stringify(rj))

console.log(`\n${pass} passed, ${fail} failed`)
for (const p of pagesOpen) { try { p.ws.close() } catch {} }
for (const b of all) { try { await b.transport.close() } catch {} }
await sleep(300)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
