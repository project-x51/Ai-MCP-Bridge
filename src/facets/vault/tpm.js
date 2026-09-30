// Vault facet: tpm (Windows) — seals the secret to the user's TPM key (CNG "Microsoft Platform Crypto
// Provider"), and unsealing requires a real Windows Hello presence check. Mechanism proven in
// experiments/hello-tpm-vault. Seal is SILENT (RSA-OAEP encrypt to the exported public key, done in Node);
// unseal shells out to Tpm.exe --decrypt, which raises the Hello prompt and TPM-decrypts. Built by
// tray/windows/build-tpm.cmd; override the path with AI_BRIDGE_TPM_HELPER (and the key name with
// AI_BRIDGE_TPM_KEY — scratch testing only). Fails closed if unavailable.
//
// #42: "the helper printed a PUBKEY" is NOT "the key is in a TPM". A key is only trusted — for the probe AND
// for seal — when the helper POSITIVELY reports the Platform Crypto Provider plus the PCP's platform type
// (PROVIDER= / PLATFORM_TYPE= lines, emitted by the #42 helper, which itself exits 2 on a TPM-less host).
// A pre-#42 helper prints neither, so it reads as unverified (`tpm-helper-outdated`) until rebuilt.
//
// (v1: seals to THIS machine's TPM. The multi-machine envelope — seal to every machine's pubkey via the
// Dropbox-shared machines/ registry — is the proven next step, tracked in #21.)
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
export const meta = { facet: 'vault', name: 'tpm' }
export const PLATFORM_PROVIDER = 'Microsoft Platform Crypto Provider'   // MS_PLATFORM_CRYPTO_PROVIDER — the TPM KSP
const BUILD_HINT = 'tpm helper not built — run tray/windows/build-tpm.cmd, then restart the bridge'
export function create(ctx) {
  const here = ctx.HERE || '.'
  const env = ctx.env || {}
  const exe = path.resolve(here, env.AI_BRIDGE_TPM_HELPER || '../tray/windows/Tpm.exe')
  const build = path.resolve(here, '../tray/windows/build-tpm.cmd')
  const keyArgs = env.AI_BRIDGE_TPM_KEY ? ['--key', String(env.AI_BRIDGE_TPM_KEY)] : []
  let hwCache = null   // only a VERIFIED hardware key is cached; a failure is re-asked next time
  // auto-build only the DEFAULT helper: build-tpm.cmd writes tray/windows/Tpm.exe, so building for an
  // overridden path would never produce it — and would silently replace the live helper instead
  const ensureExe = () => { if (fs.existsSync(exe)) return true; if (env.AI_BRIDGE_TPM_HELPER) return false; try { spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', build], { timeout: 120000, windowsHide: true }) } catch { } return fs.existsSync(exe) }
  /** #42: ask the helper for the public key AND proof it lives in the TPM. -> { ok, pub, platform } | { ok:false, reason, detail?, hint? } */
  function hardwareKey() {
    if (hwCache) return hwCache
    let r
    try { r = spawnSync(exe, ['--pubkey', ...keyArgs], { encoding: 'utf8', timeout: 30000, windowsHide: true }) } catch (e) { return { ok: false, reason: 'tpm-error', detail: e.message } }
    const out = r.stdout || '', err = ((r.stderr || '').match(/ERROR=(.*)/) || [])[1]
    if (r.status !== 0) return { ok: false, reason: 'tpm-unavailable', detail: (err || (r.error && r.error.message) || `exit ${r.status}`).trim() }
    const pub = (out.match(/PUBKEY=([A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+)/) || [])[1]
    const provider = ((out.match(/PROVIDER=(.*)/) || [])[1] || '').trim()
    const platform = ((out.match(/PLATFORM_TYPE=(.*)/) || [])[1] || '').trim()
    if (!pub) return { ok: false, reason: 'tpm-error', detail: 'no PUBKEY from helper' }
    if (!provider) return { ok: false, reason: 'tpm-helper-outdated', hint: 'Tpm.exe predates #42 and cannot prove the key is TPM-backed — rebuild it with tray/windows/build-tpm.cmd' }
    if (provider !== PLATFORM_PROVIDER || !/^TPM-Version:/.test(platform)) return { ok: false, reason: 'tpm-not-hardware', detail: `provider="${provider}"${platform ? ` platform="${platform}"` : ''}` }
    hwCache = { ok: true, pub, platform }
    return hwCache
  }
  const b64url = s => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')   // standard base64 -> base64url (for JWK n/e)
  return {
    meta, enabled: true,
    /** #41: can this platform ACTUALLY back the configured vault? Deliberately exercises the TPM (asks for the
     *  public key) rather than just checking the helper exists — a machine can have Tpm.exe present and no TPM
     *  at all (fTPM disabled in firmware), which is the exact case that made `recover_secret` fail only at the
     *  moment of need. #42: and "got a key" is not enough — hardwareKey() requires the helper's positive
     *  platform-provider report. Never calls ensureExe(), which would try to BUILD the helper (slow) during
     *  startup; a missing helper instead says so, with the build command, so a real-TPM box that merely hasn't
     *  built Tpm.exe yet doesn't look like a box without a TPM. */
    async probe() {
      if (process.platform !== 'win32') return { ok: false, reason: 'tpm-unavailable-platform' }
      if (!fs.existsSync(exe)) return { ok: false, reason: 'tpm-helper-missing', hint: BUILD_HINT }
      const k = hardwareKey()
      return k.ok ? { ok: true, platform: k.platform } : k
    },
    async seal(plaintext) {
      // #42: refuse (null => nothing stored) rather than seal to a key we cannot prove is in the TPM
      if (process.platform !== 'win32' || !ensureExe()) return null
      const k = hardwareKey()
      if (!k.ok) { if (ctx.log) ctx.log(`WARN vault=tpm: not sealing — ${k.reason}${k.detail ? ` (${k.detail})` : ''}`); return null }
      try {
        const [nB64, eB64] = k.pub.split('.')   // Tpm.exe --pubkey => "<modulus_b64>.<exponent_b64>"
        const key = crypto.createPublicKey({ key: { kty: 'RSA', n: b64url(nB64), e: b64url(eB64) }, format: 'jwk' })
        const ct = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(String(plaintext), 'utf8'))
        return 'tpm:' + ct.toString('base64')
      } catch { return null }
    },
    async unseal(ct, opts = {}) {
      if (process.platform !== 'win32' || !ensureExe()) return { ok: false, reason: 'tpm-unavailable' }
      if (typeof ct !== 'string' || !ct.startsWith('tpm:')) return { ok: false, reason: 'bad-ciphertext' }
      try {
        const args = ['--decrypt', ct.slice(4), ...keyArgs]; if (opts.subject) args.push('--message', String(opts.subject))
        const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 90000, windowsHide: true })
        if (r.status === 0) { const m = (r.stdout || '').match(/PLAINTEXT=(.*)/); if (m) return { ok: true, plaintext: Buffer.from(m[1].trim(), 'base64').toString('utf8'), by: 'tpm' } }
        const detail = ((r.stderr || '').match(/ERROR=(.*)/) || [])[1]   // #42: the helper says WHY (no-tpm / key-missing / ...)
        return { ok: false, reason: r.status === 3 ? 'hello-deny' : r.status === 2 ? 'tpm-unavailable' : 'tpm-error', code: r.status, ...(detail ? { detail: detail.trim() } : {}) }
      } catch (e) { return { ok: false, reason: 'tpm-error:' + e.message } }
    },
  }
}
