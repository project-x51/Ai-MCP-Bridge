// #41 — `profile` advertises INTENT; capabilities must advertise VERIFIED CAPABILITY.
//
// Found in the field: a host configured `vault: "tpm"` but had no TPM at all (fTPM disabled in firmware), so
// the roster advertised vault="tpm", a peer concluded secret recovery was available, and `recover_secret`
// only failed at the exact moment a compacted session needed it. The fix is a startup probe: `profile.names`
// still reports what the operator ASKED FOR, while capabilities.recover_secret / presence_confirm report what
// this host can actually DO.
//
// The load-bearing case is CONFIGURED-BUT-UNBACKED, reproduced portably by pointing the helper at a path that
// does not exist (on non-Windows the platform check fails first — either way the probe must say no).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-probe-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

async function spawnBridge(port, extraEnv = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'P' + port, AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: 'probetok', AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none', ...extraEnv }, stderr: 'pipe' })
  const client = new Client({ name: 't-probe', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

// ---- 1. no vault / no authorizer configured: capabilities are false, and that is honest ----
let B = await spawnBridge(7940, { AI_BRIDGE_VAULT: 'none', AI_BRIDGE_AUTHORIZER: 'none' }); await sleep(900)
let id = await call(B, 'my_identity')
check('vault=none -> recover_secret false', id.capabilities.recover_secret === false, JSON.stringify(id.capabilities))
check('authorizer=none -> presence_confirm false', id.capabilities.presence_confirm === false, JSON.stringify(id.capabilities))
await B.transport.close(); await sleep(500)

// ---- 2. a BACKED facet raises the capability ----
B = await spawnBridge(7942, { AI_BRIDGE_VAULT: 'script', AI_BRIDGE_AUTHORIZER: 'script' }); await sleep(900)
id = await call(B, 'my_identity')
check('vault=script (backed) -> recover_secret true', id.capabilities.recover_secret === true, JSON.stringify(id.capabilities))
check('authorizer=script (backed) -> presence_confirm true', id.capabilities.presence_confirm === true, JSON.stringify(id.capabilities))
check('profile still reports the configured names', id.profile.vault === 'script' && id.profile.authorizer === 'script', JSON.stringify(id.profile))
await B.transport.close(); await sleep(500)

// ---- 3. THE #41 CASE: configured but NOT backed ----
// vault=tpm / authorizer=hello with helpers that cannot exist. profile must still say what was ASKED FOR,
// while the capability bits tell the truth — that gap is the whole defect.
const missing = path.join(persistDir, 'definitely-not-here.exe')
B = await spawnBridge(7944, { AI_BRIDGE_VAULT: 'tpm', AI_BRIDGE_AUTHORIZER: 'hello',
  AI_BRIDGE_TPM_HELPER: missing, AI_BRIDGE_HELLO_HELPER: missing }); await sleep(1200)
id = await call(B, 'my_identity')
check('#41: profile still advertises the CONFIGURED vault (intent preserved)', id.profile.vault === 'tpm', JSON.stringify(id.profile))
check('#41: profile still advertises the CONFIGURED authorizer', id.profile.authorizer === 'hello', JSON.stringify(id.profile))
check('#41: recover_secret is FALSE because the platform cannot back it', id.capabilities.recover_secret === false, JSON.stringify(id.capabilities))
check('#41: presence_confirm is FALSE because the helper is absent', id.capabilities.presence_confirm === false, JSON.stringify(id.capabilities))

// and the behaviour still fails closed, as it always did — the probe only stops us ADVERTISING it
const rec = await call(B, 'recover_secret', { name: 'Nobody', project: 'demo' })
check('#41: recover_secret still fails closed (no false success)', rec.ok === false, JSON.stringify(rec))

// the capability bits ride the roster too, so a REMOTE peer sees the truth, not just this process
const roster = await call(B, 'list_sessions')
const self = (roster.sessions || []).find(s => s.capabilities)
check('#41: the honest capability bits are gossiped on the roster', !!self && self.capabilities.recover_secret === false, JSON.stringify(self && self.capabilities))
await B.transport.close(); await sleep(400)

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
