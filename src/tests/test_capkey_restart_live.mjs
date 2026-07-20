// #43 END-TO-END: a reply-cap minted by a process must still be honoured after that process RESTARTS.
//
// Decision B promises a valid reply-cap "always gets through". That was untrue for process-minted caps: the
// key came from the random per-process SESSION, so it rotated on every restart. v1.26.2 derives it from the
// process IDENTITY instead. The unit tests in test_lib_unit prove the KEY MATERIAL is stable; this proves the
// PROMISE end-to-end, across a real restart, through the actual consent gate.
//
// Shape (the cap must be the ONLY thing letting the reply through, or the test proves nothing):
//   process = project "alpha";  sub-peer Owner = project "beta"
//   beta ALLOWS alpha  -> the seed message alpha->beta is delivered, carrying a reply_cap minted with the
//                         process's cap key. alpha NEVER allows beta, so the reverse direction is denied…
//   …EXCEPT for a valid reply-cap. Restart the bridge, then reply: it must still arrive.
// A negative control asserts a FRESH (non-reply) send in the same direction is refused, proving it is the cap
// doing the work and not some accidental grant.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const TOKEN = 'capkeytok'
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-capkey-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

// identity must be IDENTICAL across the restart — that is the whole point (port may differ, identity may not)
async function spawnBridge(port) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'CapHost', AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_PROJECT: 'alpha',
      AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
  const client = new Client({ name: 't-capkey', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

// ---- run 1: open a cross-project thread so a reply-cap is minted, and DON'T let Owner consume it ----
let B = await spawnBridge(7960); await sleep(700)
const id1 = await call(B, 'my_identity')
check('process is classified into project alpha', id1.identity && id1.identity.project === 'alpha', JSON.stringify(id1.identity))

await call(B, 'register_self', { name: 'Owner', secret: 'os', project: 'beta' })
const grant = await call(B, 'allow_project', { project: 'alpha', as: 'Owner', secret: 'os' })   // beta opens to alpha
check('beta allows alpha (one direction only)', grant.ok === true, JSON.stringify(grant))
await sleep(200)

const seed = await call(B, 'send_to_peer', { target: 'Owner', subject: 'seed', message: 'opens the thread' })
check('seed alpha->beta delivered (grant applies)', seed.ok === true, JSON.stringify(seed))
// deliberately NOT polling Owner: the message stays parked, so it rehydrates after the restart and Owner can
// still echo its reply_cap. Consuming it here would ack the durable copy and there would be nothing to reply to.
await sleep(400)
await B.transport.close(); await sleep(800)

// ---- run 2: a DIFFERENT process (new port, new random SESSION) — same identity ----
B = await spawnBridge(7962); await sleep(800)
const id2 = await call(B, 'my_identity')
check('restarted bridge is genuinely a new process (new session id)', id2.session !== id1.session, `${id1.session} -> ${id2.session}`)

await call(B, 'register_self', { name: 'Owner', secret: 'os', project: 'beta' })
await sleep(300)
const got = await call(B, 'inbox', { for: 'Owner', secret: 'os', cursor: 0 })
const seedMsg = got.messages.find(m => m.body === 'opens the thread')
check('seed survived the restart and reached Owner', !!seedMsg, JSON.stringify(got.messages.map(m => m.body)))
check('seed carries a reply_cap minted by the OLD process', !!(seedMsg && seedMsg.reply_cap), seedMsg && String(seedMsg.reply_cap))

// ---- NEGATIVE CONTROL: without a cap, beta -> alpha must be refused ----
const bare = await call(B, 'send_to_peer', { target: id2.session, subject: 'bare', message: 'no cap', as: 'Owner', secret: 'os' })
check('negative control: a FRESH beta->alpha send is denied (alpha never allowed beta)', bare.ok === false, JSON.stringify(bare))

// ---- THE ASSERTION: the reply, carrying the pre-restart cap, still gets through ----
const reply = await call(B, 'send_to_peer', { target: id2.session, subject: 're: seed', message: 'reply across a restart',
  as: 'Owner', secret: 'os', reply_to: seedMsg && seedMsg.id })
check('reply carrying the PRE-RESTART cap is accepted', reply.ok === true, JSON.stringify(reply))
await sleep(400)
const procIn = await call(B, 'inbox', { cursor: 0 })   // no `for` = the process inbox
check('…and it actually ARRIVED at the restarted process', (procIn.messages || []).some(m => m.body === 'reply across a restart'),
  JSON.stringify((procIn.messages || []).map(m => m.body)))

console.log(`\n${pass} passed, ${fail} failed`)
await B.transport.close()
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
