// Vault facet: tpm (Windows) — seals the secret to the user's TPM key (CNG "Microsoft Platform Crypto
// Provider"), and unsealing requires a real Windows Hello presence check. Mechanism proven in
// experiments/hello-tpm-vault. Seal is SILENT (RSA-OAEP encrypt to the exported public key, done in Node);
// unseal shells out to Tpm.exe --decrypt, which raises the Hello prompt and TPM-decrypts. Built by
// tray/windows/build-tpm.cmd; override the path with AI_BRIDGE_TPM_HELPER. Fails closed if unavailable.
//
// (v1: seals to THIS machine's TPM. The multi-machine envelope — seal to every machine's pubkey via the
// Dropbox-shared machines/ registry — is the proven next step, tracked in #21.)
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
export const meta = { facet: 'vault', name: 'tpm' }
export function create(ctx) {
  const here = ctx.HERE || '.'
  const exe = path.resolve(here, (ctx.env && ctx.env.AI_BRIDGE_TPM_HELPER) || '../tray/windows/Tpm.exe')
  const build = path.resolve(here, '../tray/windows/build-tpm.cmd')
  let pubCache = null
  const ensureExe = () => { if (fs.existsSync(exe)) return true; try { spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', build], { timeout: 120000, windowsHide: true }) } catch { } return fs.existsSync(exe) }
  function pubKey() {
    if (pubCache) return pubCache
    if (process.platform !== 'win32' || !ensureExe()) return null
    try { const r = spawnSync(exe, ['--pubkey'], { encoding: 'utf8', timeout: 30000, windowsHide: true }); if (r.status === 0) { const m = (r.stdout || '').match(/PUBKEY=([A-Za-z0-9+/=]+)/); if (m) { pubCache = m[1]; return pubCache } } } catch { }
    return null
  }
  return {
    meta, enabled: true,
    async seal(plaintext) {
      const pub = pubKey(); if (!pub) return null
      try {
        const key = crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' })
        const ct = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(String(plaintext), 'utf8'))
        return 'tpm:' + ct.toString('base64')
      } catch { return null }
    },
    async unseal(ct, opts = {}) {
      if (process.platform !== 'win32' || !ensureExe()) return { ok: false, reason: 'tpm-unavailable' }
      if (typeof ct !== 'string' || !ct.startsWith('tpm:')) return { ok: false, reason: 'bad-ciphertext' }
      try {
        const args = ['--decrypt', ct.slice(4)]; if (opts.subject) args.push('--message', String(opts.subject))
        const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 90000, windowsHide: true })
        if (r.status === 0) { const m = (r.stdout || '').match(/PLAINTEXT=(.*)/); if (m) return { ok: true, plaintext: Buffer.from(m[1].trim(), 'base64').toString('utf8'), by: 'tpm' } }
        return { ok: false, reason: r.status === 3 ? 'hello-deny' : r.status === 2 ? 'tpm-unavailable' : 'tpm-error', code: r.status }
      } catch (e) { return { ok: false, reason: 'tpm-error:' + e.message } }
    },
  }
}
