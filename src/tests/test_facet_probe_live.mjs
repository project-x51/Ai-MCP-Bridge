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
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
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
// #42: WHY it is false is visible too — on Windows a missing helper names the build command (a real-TPM box
// that just hasn't built Tpm.exe must not look like a box without a TPM); elsewhere the platform reason
const fp = id.facet_probe && id.facet_probe.vault
check('#42: my_identity.facet_probe carries the vault reason' + (process.platform === 'win32' ? ' + the build hint' : ''),
  !!fp && fp.facet === 'tpm' && fp.ok === false && (process.platform === 'win32' ? fp.reason === 'tpm-helper-missing' && /build-tpm\.cmd/.test(fp.hint || '') : fp.reason === 'tpm-unavailable-platform'), JSON.stringify(fp))
await B.transport.close(); await sleep(400)

// ---- 4. #42: "the helper printed a key" is NOT "the key is in a TPM" ----
// The field case: a TPM-less host where Tpm.exe --pubkey still exited 0 with a valid RSA key, so the probe said
// recover_secret:true and seal() silently sealed to non-TPM storage. Reproduced with a stub helper (compiled
// with the in-box csc, so it is a real .exe the facet can spawn) whose output is chosen per bridge by env:
//   software -> exit 0 + PUBKEY + PROVIDER=<a software KSP>   must be FALSE and must NOT seal
//   legacy   -> exit 0 + PUBKEY only (a pre-#42 helper)       must be FALSE (cannot prove hardware) and not seal
//   fail     -> exit 2 + ERROR=no-tpm                         must be FALSE
//   platform -> PROVIDER=Microsoft Platform Crypto Provider + PLATFORM_TYPE=TPM-Version:...  -> TRUE and seals
// "Did it seal?" is observed end-to-end: recover_secret finds no vault entry (no-vault-entry) when the seal was
// refused, and reaches the helper's --decrypt (which this stub answers as a denied Hello) when it sealed.
if (process.platform !== 'win32') console.log('SKIP #42 stub-helper checks (Windows-only: the tpm facet needs win32)')
else {
  const stubDir = path.join(persistDir, 'stub'); fs.mkdirSync(stubDir)
  fs.writeFileSync(path.join(stubDir, 'TpmStub.cs'), `using System;
class S { static int Main(string[] a) {
  string m = Environment.GetEnvironmentVariable("AIMB_STUB_MODE") ?? "", op = a.Length > 0 ? a[0] : "";
  if (m == "fail") { Console.Error.WriteLine("ERROR=no-tpm (stub)"); return 2; }
  if (op == "--decrypt") { Console.WriteLine("RESULT=Canceled"); return 3; }
  if (op != "--pubkey") return 1;
  if (m == "platform") { Console.WriteLine("PROVIDER=Microsoft Platform Crypto Provider"); Console.WriteLine("PLATFORM_TYPE=TPM-Version:2.0 -Level:0-Revision:0-VendorID:'STUB'"); }
  if (m == "software") Console.WriteLine("PROVIDER=Microsoft Software Key Storage Provider");
  Console.WriteLine("PUBKEY=" + Environment.GetEnvironmentVariable("AIMB_STUB_PUBKEY"));
  return 0; } }
`)
  const csc = [path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find(p => fs.existsSync(p))
  const stub = path.join(stubDir, 'TpmStub.exe')
  if (csc) spawnSync(csc, ['/nologo', '/out:' + stub, path.join(stubDir, 'TpmStub.cs')], { encoding: 'utf8', windowsHide: true })
  check('#42: stub helper compiled', fs.existsSync(stub), csc ? 'csc failed' : 'no csc.exe')
  if (fs.existsSync(stub)) {
    // a real RSA public key in the helper's "<modulus_b64>.<exponent_b64>" form, so a permitted seal can succeed
    const jwk = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })
    const std = s => Buffer.from(s, 'base64url').toString('base64')
    const PUB = std(jwk.n) + '.' + std(jwk.e)
    const modes = [['software', 7946, false], ['legacy', 7948, false], ['fail', 8004, false], ['platform', 8006, true]]
    for (const [mode, port, want] of modes) {
      B = await spawnBridge(port, { AI_BRIDGE_VAULT: 'tpm', AI_BRIDGE_AUTHORIZER: 'none', AI_BRIDGE_TPM_HELPER: stub,
        AIMB_STUB_MODE: mode, AIMB_STUB_PUBKEY: PUB }); await sleep(1200)
      id = await call(B, 'my_identity')
      check(`#42: helper "${mode}" -> recover_secret ${want}`, id.capabilities.recover_secret === want, JSON.stringify({ caps: id.capabilities, probe: id.facet_probe && id.facet_probe.vault }))
      await call(B, 'register_self', { name: 'Sealed' + mode, secret: 's3cret-' + mode, project: 'demo' }); await sleep(300)
      const r = await call(B, 'recover_secret', { name: 'Sealed' + mode, project: 'demo' })
      if (want) check(`#42: helper "${mode}" -> seal succeeded (recovery reaches the TPM helper)`, r.ok === false && r.code === 'recovery-denied' && r.reason === 'hello-deny', JSON.stringify(r))
      else check(`#42: helper "${mode}" -> seal REFUSED (no vault entry written)`, r.ok === false && r.code === 'no-vault-entry', JSON.stringify(r))
      await B.transport.close(); await sleep(400)
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
