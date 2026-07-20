// Vault facet: script/memory — a reversible base64 "seal" with NO presence check, so the secret-recovery
// flow is fully testable headlessly (this is the CI seam; it is NOT secure). The real at-rest protection +
// Hello gating is the 'tpm' impl. AI_BRIDGE_VAULT_DENY=1 makes unseal fail, to exercise the deny path.
export const meta = { facet: 'vault', name: 'script' }
export function create(ctx) {
  const env = (ctx && ctx.env) || {}
  return {
    meta, enabled: true,
    async probe() { return { ok: true } },   // #41: the test double is always backed
    async seal(plaintext) { return 'b64:' + Buffer.from(String(plaintext), 'utf8').toString('base64') },
    async unseal(ct, _opts) {
      if (env.AI_BRIDGE_VAULT_DENY === '1') return { ok: false, reason: 'script-deny', by: 'script' }
      if (typeof ct !== 'string' || !ct.startsWith('b64:')) return { ok: false, reason: 'bad-ciphertext' }
      try { return { ok: true, plaintext: Buffer.from(ct.slice(4), 'base64').toString('utf8'), by: 'script' } }
      catch { return { ok: false, reason: 'decode-error' } }
    },
  }
}
