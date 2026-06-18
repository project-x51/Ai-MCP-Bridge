// Secret recovery via the vault facet (§21): the bridge SEALS a session's secret at registration; a session
// that lost it calls recover_secret (presence-gated in the tpm impl) and gets the ORIGINAL secret back, then
// re-registers to reattach. Uses the `script` vault (reversible, no Hello) so the whole flow runs headlessly.
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
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-vault-'))

async function spawn(port, extra = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'V', AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_VAULT: 'script', AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none', ...extra }, stderr: 'pipe' })
  const client = new Client({ name: 't-vault', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

// ---- A: register (secret sealed) -> claim/subscribe -> recover the secret -> reattach with it ----
let B = await spawn(8010); await sleep(700)
await call(B, 'register_self', { name: 'Forgetful', secret: 'topsecret-42', project: 'ops' })
await call(B, 'claim_topic', { topic: 'deploys', as: 'Forgetful', secret: 'topsecret-42', exclusive: true })
await call(B, 'subscribe', { pattern: 'alerts/#', as: 'Forgetful', secret: 'topsecret-42' })
await sleep(200)
const rec = await call(B, 'recover_secret', { name: 'Forgetful' })
check('recover_secret returns the original secret (presence-gated)', rec.ok === true && rec.secret === 'topsecret-42', JSON.stringify(rec))
// the recovered secret actually works: re-register reattaches and the resync hands the topics back
const re = await call(B, 'register_self', { name: 'Forgetful', secret: rec.secret, project: 'ops' })
check('recovered secret reattaches and resyncs topics', re.ok === true && (re.topics || []).some(t => t.pattern === 'deploys' && t.role === 'owner') && (re.topics || []).some(t => t.pattern === 'alerts/#'), JSON.stringify(re.topics))
const unknown = await call(B, 'recover_secret', { name: 'NoSuchSession' })
check('recover_secret for an unknown name is rejected', unknown.ok === false && unknown.code === 'unknown-identity', JSON.stringify(unknown))
await B.transport.close(); await sleep(600)

// ---- B: a denied presence check -> recovery-denied (the secret is never returned) ----
B = await spawn(8012, { AI_BRIDGE_VAULT_DENY: '1' }); await sleep(700)
await call(B, 'register_self', { name: 'Locked', secret: 'noleak-99', project: 'ops' })
await sleep(150)
const denied = await call(B, 'recover_secret', { name: 'Locked' })
check('denied presence -> recovery-denied, no secret leaked', denied.ok === false && denied.code === 'recovery-denied' && !denied.secret, JSON.stringify(denied))
await B.transport.close(); await sleep(600)

// ---- C: with no vault facet, recovery is unsupported ----
B = await spawn(8014, { AI_BRIDGE_VAULT: 'none' }); await sleep(700)
await call(B, 'register_self', { name: 'Plain', secret: 'x', project: 'ops' })
const unsup = await call(B, 'recover_secret', { name: 'Plain' })
check('recover_secret is unsupported without a vault facet', unsup.ok === false && unsup.code === 'unsupported', JSON.stringify(unsup))
await B.transport.close()

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
