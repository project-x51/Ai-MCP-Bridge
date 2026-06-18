// Vault facet (architecture.md §16 / secret recovery) — seals a session's secret so it can be RECOVERED
// via the user's presence after the session loses it (a compact throws away the bearer secret). The seal is
// encrypt-to-the-user (their TPM key); unsealing requires a presence check (Windows Hello). The bridge stores
// the ciphertext in the persistence `vault` store and hands the plaintext back (over the local MCP stdio)
// only after a successful unseal. Swapping the impl swaps HOW the secret is protected/recovered.
//
//   seal(plaintext)  -> ciphertext string | null      (silent: encrypt to the user's public key)
//   unseal(ciphertext) -> { ok, plaintext?, reason?, by? }   (presence-gated decrypt)
//
// MUST fail closed: any error/unavailability → { ok:false }, never leak or fabricate a secret.
export const meta = { facet: 'vault', name: '_template' }
export function create(ctx) {
  return {
    meta, enabled: false,
    async seal(_plaintext) { return null },
    async unseal(_ciphertext) { return { ok: false, reason: 'not-implemented' } },
  }
}
