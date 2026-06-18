// MANUAL / INTERACTIVE — not part of `npm test` (it raises a real Windows Hello prompt you must answer).
// Live end-to-end of the TPM vault (§21): a session registers (secret sealed to your TPM), "forgets" the
// secret, then recover_secret raises a Windows Hello prompt — approve it and you get the ORIGINAL secret
// back and reattach. Run AT THE KEYBOARD:  node tests/manual/test_vault_tpm.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-vtpm-'))
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

console.log('\n=== TPM vault secret recovery — live experiment ===\n')
const tpmExe = path.resolve(SRCDIR, '../tray/windows/Tpm.exe')
if (!fs.existsSync(tpmExe)) { console.log('Building Tpm.exe ...'); spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', path.resolve(SRCDIR, '../tray/windows/build-tpm.cmd')], { stdio: 'inherit' }) }
const chk = spawnSync(tpmExe, ['--check'], { encoding: 'utf8' })
console.log('TPM/Hello check ->', (chk.stdout || '').trim(), '(exit', chk.status + ')')
if (chk.status !== 0) { console.log('\nTPM + Windows Hello not both available — cannot run the live vault.'); process.exit(2) }

const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: 'VaultHost', AI_BRIDGE_PORT: '8030', AI_BRIDGE_WS_PORT: '8031', AI_BRIDGE_TOKEN: 'testtok',
    AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir, AI_BRIDGE_VAULT: 'tpm',
    AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'inherit' })
const B = { client: new Client({ name: 'vault-manual', version: '0' }, { capabilities: {} }), transport }
await B.client.connect(transport); await sleep(700)

const SECRET = 'her-secret-' + Math.floor(chk.status + 4242)
await call(B, 'register_self', { name: 'Bolletta', secret: SECRET, project: 'demo' })
await call(B, 'claim_topic', { topic: 'Bills', as: 'Bolletta', secret: SECRET, exclusive: true })
console.log(`\nRegistered "Bolletta" (secret sealed to your TPM), claimed topic "Bills".`)
console.log('Now she has FORGOTTEN the secret. Recovering ...\n')
console.log('>>> A WINDOWS HELLO PROMPT SHOULD APPEAR — approve it to recover the secret. <<<\n')

const rec = await call(B, 'recover_secret', { name: 'Bolletta' })
console.log('recover_secret ->', JSON.stringify({ ok: rec.ok, by: rec.by, code: rec.code, reason: rec.reason, secretMatches: rec.secret === SECRET }))
if (rec.ok && rec.secret === SECRET) {
  const re = await call(B, 'register_self', { name: 'Bolletta', secret: rec.secret, project: 'demo' })
  console.log('reattach with recovered secret -> topics:', JSON.stringify(re.topics))
  console.log('\nRESULT: RECOVERED — the secret came back via your presence, and she reattached to "Bills".')
} else if (rec.code === 'recovery-denied') {
  console.log('\nRESULT: DENIED — you cancelled the prompt; no secret was returned (correct).')
} else {
  console.log('\nRESULT: ' + (rec.reason || rec.code || 'unexpected'))
}
await B.transport.close()
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(0)
