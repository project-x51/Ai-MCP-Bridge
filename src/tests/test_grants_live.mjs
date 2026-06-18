// Durable cross-project grants (§14) + grant acknowledgement (Bug 3 / #17): a requester is told when its
// access is approved (echoing request_id + permitted TTL); the operator may shorten the asked-for TTL; the
// grant survives a restart; and an expired grant stops authorising. Loopback-only, own persist dir.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const TOKEN = 'testtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, e)) }
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-grant-'))

async function spawn(port) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'G', AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
  const client = new Client({ name: 't-grant', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

// ---- run 1: request -> operator approves (shortening TTL) -> requester is notified -> send works ----
let B = await spawn(7970); await sleep(700)
await call(B, 'register_self', { name: 'Req', secret: 'sr', project: 'alpha' })
await call(B, 'register_self', { name: 'Op', secret: 'so', project: 'beta' })
await sleep(200)
const denied = await call(B, 'send_to_peer', { target: 'Op', subject: 'hi', message: 'pre-grant', as: 'Req', secret: 'sr' })
check('cross-project send denied before grant', denied.ok === false && denied.code === 'project-denied', JSON.stringify(denied))
const req = await call(B, 'request_project_access', { to: 'beta', reason: 'need to reach beta', ttl_minutes: 60, as: 'Req', secret: 'sr' })
check('request returns id + echoes requested ttl', req.ok === true && !!req.request_id && req.ttl_minutes === 60, JSON.stringify(req))
await sleep(200)
const opIn = await call(B, 'inbox', { for: 'Op', secret: 'so', cursor: 0 })
const reqMsg = opIn.messages.find(m => m.verb === 'project_access_request')
check('operator received the access request with the requested ttl', !!reqMsg && JSON.parse(reqMsg.body).ttl_minutes === 60, JSON.stringify(opIn.messages.map(m => m.verb)))
// operator approves, shortening 60 -> 30
const grant = await call(B, 'allow_project', { project: 'alpha', mode: 'send', ttl_minutes: 30, as: 'Op', secret: 'so' })
check('operator may shorten the granted ttl (60 -> 30)', grant.ok === true && grant.allow.ttl_minutes === 30, JSON.stringify(grant))
check('grant notified the pending requester', grant.notified === 1, JSON.stringify(grant.notified))
await sleep(200)
const reqIn = await call(B, 'inbox', { for: 'Req', secret: 'sr', cursor: 0 })
const ack = reqIn.messages.find(m => m.verb === 'project_access_granted')
check('requester was told its access landed (echoes request_id + permitted ttl)',
  !!ack && JSON.parse(ack.body).request_id === req.request_id && JSON.parse(ack.body).ttl_minutes === 30, JSON.stringify(reqIn.messages.map(m => m.verb)))
const allowed = await call(B, 'send_to_peer', { target: 'Op', subject: 'hi', message: 'post-grant', as: 'Req', secret: 'sr' })
check('cross-project send allowed after grant', allowed.ok === true, JSON.stringify(allowed))
await sleep(300)
await B.transport.close(); await sleep(700)

// ---- run 2: the grant survived the restart (no re-grant needed) ----
B = await spawn(7972); await sleep(700)
await call(B, 'register_self', { name: 'Req', secret: 'sr', project: 'alpha' })
await call(B, 'register_self', { name: 'Op', secret: 'so', project: 'beta' })
await sleep(200)
const afterRestart = await call(B, 'send_to_peer', { target: 'Op', subject: 'hi', message: 'after restart', as: 'Req', secret: 'sr' })
check('durable grant still authorises after a restart', afterRestart.ok === true, JSON.stringify(afterRestart))
// revoke -> denied again, and the durable edge is dropped
await call(B, 'revoke_project', { project: 'alpha', as: 'Op', secret: 'so' })
await sleep(100)
const afterRevoke = await call(B, 'send_to_peer', { target: 'Op', subject: 'hi', message: 'after revoke', as: 'Req', secret: 'sr' })
check('revoke restores denial', afterRevoke.ok === false && afterRevoke.code === 'project-denied', JSON.stringify(afterRevoke))
await B.transport.close(); await sleep(700)

// ---- run 3: revoke persisted -> still denied after another restart; and TTL expiry ----
B = await spawn(7974); await sleep(700)
await call(B, 'register_self', { name: 'Req', secret: 'sr', project: 'alpha' })
await call(B, 'register_self', { name: 'Op', secret: 'so', project: 'beta' })
await sleep(200)
const afterRevokeRestart = await call(B, 'send_to_peer', { target: 'Op', subject: 'hi', message: 'x', as: 'Req', secret: 'sr' })
check('revoked grant stays revoked across a restart', afterRevokeRestart.ok === false, JSON.stringify(afterRevokeRestart))
// short-lived grant expires
await call(B, 'allow_project', { project: 'alpha', mode: 'send', ttl_minutes: 0.01, as: 'Op', secret: 'so' })   // ~0.6s
const immediate = await call(B, 'send_to_peer', { target: 'Op', subject: 'hi', message: 'fresh', as: 'Req', secret: 'sr' })
check('short-TTL grant authorises immediately', immediate.ok === true, JSON.stringify(immediate))
await sleep(1200)
const expired = await call(B, 'send_to_peer', { target: 'Op', subject: 'hi', message: 'stale', as: 'Req', secret: 'sr' })
check('grant stops authorising once its TTL expires', expired.ok === false && expired.code === 'project-denied', JSON.stringify(expired))
await B.transport.close()

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
