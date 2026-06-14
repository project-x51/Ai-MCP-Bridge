// Discovery: none (default) — single-host only. No cross-host peers are ever offered, so a bridge runs
// exactly as it did before cross-host federation existed. Opt in to a real backend with
// `"profile": { "discovery": "tailscale" }` (or "seeds"), or env AI_BRIDGE_DISCOVERY=tailscale.
export const meta = { facet: 'discovery', name: 'none' }
export function create() {
  return { async candidates() { return [] }, advertise() {} }
}
