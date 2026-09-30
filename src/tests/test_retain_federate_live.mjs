// #66(c) — RETAINED topic values must reach subscribers mesh-wide. A `publish {retain:true}` used to live only in the
// PUBLISHING host's persistence store, so a subscriber that joined later on another machine (a separate store) never
// got it. Retained records now replicate as a last-writer-wins set keyed by (realm, project, topic).
//
// Two gateways on distinct loopback IPs (127.0.0.1 / 127.0.0.2) stand in for two hosts; host A also runs a FOLLOWER
// (same IP + port, so it loses the bind and follows) with its OWN store, so a value can only reach it over the
// gateway→follower ROSTER. Every bridge reads its own temp config via AI_BRIDGE_CONFIG (never src/config.json) and a
// temp file store. Cases: (1) B publishes retained; a LATER subscriber on A's follower and on A's gateway gets it;
// (2) a NEWER publish from A's follower (up in RETAINED, out to B) replaces it on both hosts; (3) consent/project
// rules still apply — another project's subscriber gets nothing, and a cross-project value is withheld until a grant
// (which federates, #62) allows it; (4) an OVERSIZED value (> the 64KB replication cap) stays on its publishing host,
// is reported as not replicated, and retires the older replicated value elsewhere; (5) a value A LEARNED survives A
// (gateway + follower) restarting while B is down.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-change proof run this test against a reverted copy
const TOKEN = 'retainfedtok'
const A_PORT = '14100', B_PORT = '14102'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-retainfed-'))
const persistA = path.join(TMP, 'persistA'), persistAF = path.join(TMP, 'persistAF'), persistB = path.join(TMP, 'persistB')
const cfg = path.join(TMP, 'config.json')
fs.writeFileSync(cfg, '{}')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(name, bind, port, persistDir, extra) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfg, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind,
      AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_DEFAULT_BEHAVIOR: '',
      // a LONG #63 refresh, so every propagation below must be PROMPT (change-driven), not ride the periodic refresh
      AI_BRIDGE_GOSSIP_REFRESH_MS: '60000',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: '', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)
// A FRESH subscriber (new name each try) subscribes and reads what the subscribe-time catch-up delivered. Retried until
// `want(bodies)` — propagation is async but must be prompt (well inside the 60s refresh). Returns the last bodies seen.
let seq = 0
async function lateSubscriber(b, project, pattern, want, ms = 8000) {
  const t0 = Date.now(); let bodies = []
  do {
    const nm = `late${++seq}`
    await call(b, 'register_self', { name: nm, secret: 's', project })
    await call(b, 'subscribe', { pattern, as: nm, secret: 's' })
    await sleep(150)
    bodies = ((await call(b, 'inbox', { for: nm, secret: 's', cursor: 0 })).messages || []).map(m => m.body)
    await call(b, 'deregister', { peer_id: nm, secret: 's' })
    if (want(bodies)) return bodies
    await sleep(250)
  } while (Date.now() - t0 < ms)
  return bodies
}
const has = v => bs => bs.includes(v)
const all = []

// ---- host B (gateway) + host A (gateway + FOLLOWER, each with its own store)
const B = await spawn('HostB', '127.0.0.2', B_PORT, persistB); all.push(B)
let A = await spawn('HostA', '127.0.0.1', A_PORT, persistA, { AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(A)
await sleep(700)
let F = await spawn('HostAF', '127.0.0.1', A_PORT, persistAF, { AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(F)
await sleep(900)
const aRole = (await call(A, 'my_identity')).role, fRole = (await call(F, 'my_identity')).role
check('harness: host A runs a gateway + a FOLLOWER', aRole === 'gateway' && fRole === 'follower', `${aRole}/${fRole}`)
check('harness: retain is on (file persistence) on every bridge', [A, F, B].length === 3 && (await call(B, 'my_identity')).capabilities.retain === true)

// 1. B publishes retained; a LATER subscriber on another host gets it
await call(B, 'register_self', { name: 'PubB', secret: 'pb', project: 'News' })
const p1 = await call(B, 'publish', { topic: 'news/headline', subject: 'headline', message: 'v1', retain: true, as: 'PubB', secret: 'pb' })
check('B: retained publish accepted (and replicable — no size note)', p1.ok === true && p1.retained === true && p1.retained_replicated === undefined, JSON.stringify(p1))
let got = await lateSubscriber(F, 'News', 'news/#', has('v1'))
check('a LATER subscriber on A\'s FOLLOWER (own store) gets B\'s retained value (wildcard match)', got.includes('v1'), JSON.stringify(got))
got = await lateSubscriber(A, 'News', 'news/headline', has('v1'))
check('a LATER subscriber on A\'s gateway gets it too', got.includes('v1'), JSON.stringify(got))

// 2. a NEWER publish from A's FOLLOWER replaces it on both hosts (follower -> gateway -> B)
await call(F, 'register_self', { name: 'PubF', secret: 'pf', project: 'News' })
const p2 = await call(F, 'publish', { topic: 'news/headline', subject: 'headline', message: 'v2', retain: true, as: 'PubF', secret: 'pf' })
check('A\'s follower: newer retained publish accepted', p2.ok === true && p2.retained === true, JSON.stringify(p2))
got = await lateSubscriber(B, 'News', 'news/headline', has('v2'))
check('a new subscriber on B gets the NEWER value published on A\'s follower', got.includes('v2'), JSON.stringify(got))
check('... and not the older one (last-value-wins mesh-wide)', !got.includes('v1'), JSON.stringify(got))
got = await lateSubscriber(A, 'News', 'news/headline', has('v2'))
check('a new subscriber on A\'s gateway gets the newer value only', got.includes('v2') && !got.includes('v1'), JSON.stringify(got))

// 3. consent / project rules are not widened
got = await lateSubscriber(A, 'Ops', 'news/#', () => false, 1200)
check('a subscriber in ANOTHER project (Ops) on A gets nothing from News\'s retained values', got.length === 0, JSON.stringify(got))
await call(B, 'register_self', { name: 'PubOther', secret: 'po', project: 'Other' })
const p3 = await call(B, 'publish', { topic: '@News/news/secret', subject: 'secret', message: 'hidden', retain: true, as: 'PubOther', secret: 'po' })
check('B: a cross-project (Other -> @News) retained publish is stored', p3.ok === true && p3.retained === true, JSON.stringify(p3))
await sleep(800)
got = await lateSubscriber(A, 'News', 'news/secret', () => false, 1200)
check('without a grant, a News subscriber on A is NOT caught up on Other\'s value (consent checked at delivery)', !got.includes('hidden'), JSON.stringify(got))
const g = await call(B, 'allow_project', { project: 'Other', as: 'PubB', secret: 'pb' })
check('a News session on B grants Other', g.ok === true, JSON.stringify(g))
got = await lateSubscriber(A, 'News', 'news/secret', has('hidden'))
check('after the (federated) grant, the same catch-up on A delivers it — so it WAS replicated, and consent gated it', got.includes('hidden'), JSON.stringify(got))

// 4. the size cap: an oversized value stays on its publishing host and retires the older replicated one elsewhere
await call(B, 'publish', { topic: 'news/big', subject: 'big', message: 'small-1', retain: true, as: 'PubB', secret: 'pb' })
got = await lateSubscriber(A, 'News', 'news/big', has('small-1'))
check('cap setup: a small retained value on news/big reaches A', got.includes('small-1'), JSON.stringify(got))
const BIG = 'B'.repeat(70000)   // ~93KB once body-ciphered: over the 64KB replication cap
const p4 = await call(B, 'publish', { topic: 'news/big', subject: 'big', message: BIG, retain: true, as: 'PubB', secret: 'pb' })
check('an oversized retained publish says it was NOT replicated (with the cap)', p4.ok === true && p4.retained === true && p4.retained_replicated === false && p4.retained_cap_bytes === 65536 && p4.retained_bytes > 65536, JSON.stringify({ ...p4, reminders: undefined }))
got = await lateSubscriber(A, 'News', 'news/big', bs => !bs.includes('small-1'))
check('a new subscriber on A gets NEITHER the oversized value NOR the stale older one (a too-large marker retired it)', !got.includes('small-1') && !got.includes(BIG), JSON.stringify(got.map(b => String(b).slice(0, 20))))
got = await lateSubscriber(B, 'News', 'news/big', has(BIG), 3000)
check('on the PUBLISHING host the oversized value is still retained locally', got.includes(BIG) && !got.includes('small-1'), JSON.stringify(got.map(b => String(b).slice(0, 20))))

// 5. durability: the value A LEARNED (published on A's follower -> A's store as a learned copy; B's 'hidden' too)
// survives A (gateway + follower) restarting while B is down
await B.transport.close(); all.splice(all.indexOf(B), 1)
await sleep(300)
await F.transport.close(); await A.transport.close(); all.length = 0
await sleep(1000)
A = await spawn('HostA', '127.0.0.1', A_PORT, persistA, { AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(A)
await sleep(700)
F = await spawn('HostAF', '127.0.0.1', A_PORT, persistAF, { AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(F)
await sleep(900)
got = await lateSubscriber(A, 'News', 'news/headline', has('v2'), 3000)
check('after A restarts (B down): A\'s gateway still serves the newest value it learned', got.includes('v2') && !got.includes('v1'), JSON.stringify(got))
got = await lateSubscriber(A, 'News', 'news/secret', has('hidden'), 3000)
check('... including one published on B (learned + persisted on A)', got.includes('hidden'), JSON.stringify(got))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch {} }
await sleep(300)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
