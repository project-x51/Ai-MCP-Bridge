// #46 — the realm token can be supplied via AI_BRIDGE_TOKEN_FILE (a PATH, harmless in argv) instead of the
// secret VALUE inlined into the command line. The token is the membership gate, so "did the follower join the
// gateway?" is a true end-to-end check that the file was read: a wrong/empty token can't join.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const TOKEN = 'filetoktest-9f3c', PORT = '7991'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-tokfile-'))
const bareFile = path.join(dir, 'token.txt');          fs.writeFileSync(bareFile, TOKEN + '\n')                     // bare-token file
const envFile  = path.join(dir, 'bridge.env');         fs.writeFileSync(envFile, `AI_BRIDGE_PROJECT=Demo\nAI_BRIDGE_TOKEN=${TOKEN}\n`)   // KEY=VALUE env file
const wrongFile = path.join(dir, 'wrong.txt');         fs.writeFileSync(wrongFile, 'not-the-realm-token')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(env) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: String(Number(PORT) + 1),
      AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none',
      AI_BRIDGE_TOKEN: '', AI_BRIDGE_TOKEN_FILE: '', ...env }, stderr: 'pipe' })
  const c = new Client({ name: 't-tokfile', version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)

// gateway holds the port with a plain env token
const GW = await spawn({ AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_NAME: 'GW' }); await sleep(700)
const gw = await call(GW, 'my_identity')
check('gateway up with an env token', gw.role === 'gateway', gw.role)

// follower supplies the SAME token via a BARE-token file -> must join the gateway (proves the file was read)
const F1 = await spawn({ AI_BRIDGE_TOKEN_FILE: bareFile, AI_BRIDGE_NAME: 'F1' }); await sleep(900)
const f1 = await call(F1, 'my_identity')
check('follower via bare-token FILE joined the gateway', f1.role === 'follower' && f1.gateway === gw.session, `${f1.role} gw=${f1.gateway}`)

// follower supplies the token via a KEY=VALUE env file (bridge.env shape) -> also joins
const F2 = await spawn({ AI_BRIDGE_TOKEN_FILE: envFile, AI_BRIDGE_NAME: 'F2' }); await sleep(900)
const f2 = await call(F2, 'my_identity')
check('follower via KEY=VALUE env FILE joined the gateway', f2.role === 'follower' && f2.gateway === gw.session, `${f2.role} gw=${f2.gateway}`)

// precedence: an explicit AI_BRIDGE_TOKEN beats AI_BRIDGE_TOKEN_FILE — env=good, file=wrong -> still joins
const F3 = await spawn({ AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_TOKEN_FILE: wrongFile, AI_BRIDGE_NAME: 'F3' }); await sleep(900)
const f3 = await call(F3, 'my_identity')
check('explicit AI_BRIDGE_TOKEN takes precedence over the file', f3.role === 'follower' && f3.gateway === gw.session, `${f3.role} gw=${f3.gateway}`)

// end-to-end: a message routes across the env-token gateway and the file-token follower (same realm)
await call(GW, 'register_self', { name: 'GwPeer', secret: 'sg', project: 'Demo' })
await call(F1, 'register_self', { name: 'F1Peer', secret: 'sf', project: 'Demo' })
await sleep(300)
const sent = await call(F1, 'send_to_peer', { target: 'GwPeer', subject: 'x', message: 'crosses on a file token', as: 'F1Peer', secret: 'sf' })
check('send from the file-token follower is accepted', sent.ok !== false, JSON.stringify(sent))
await sleep(300)
const inbox = await call(GW, 'inbox', { for: 'GwPeer', secret: 'sg', cursor: 0 })
check('…and it was delivered (shared realm via the token file)', (inbox.messages || []).some(m => m.body === 'crosses on a file token'), JSON.stringify((inbox.messages || []).map(m => m.body)))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of [GW, F1, F2, F3]) { try { await b.transport.close() } catch {} }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
