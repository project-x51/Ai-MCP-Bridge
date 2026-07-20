// Vault facet: none (default) — no secret recovery. A session that loses its secret cannot self-recover;
// the operator must clear its durable state (it then re-registers fresh). Opt in to 'tpm' (Windows Hello +
// TPM) for real recovery, or 'script' for headless tests.
export const meta = { facet: 'vault', name: 'none' }
export function create() {
  return { meta, enabled: false, async probe() { return { ok: false, reason: 'no-vault' } },
    async seal() { return null }, async unseal() { return { ok: false, reason: 'no-vault' } } }
}
