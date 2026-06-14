// IdentityModel — declared label (default). The realm token already gated entry, so a self-asserted
// project/user label is trust-domain-trusted (assurance "declared"). Verified/mapped impls slot in
// later with zero wire churn (architecture.md §8).
export const meta = { facet: 'identity', name: 'label' }
export function create(ctx) {
  function classify({ project, user, realm } = {}) {
    const p = String(project || '').trim() || 'unclassified'
    const u = String(user || '').trim() || 'unknown'
    const r = String(realm || ctx.REALM).trim() || 'default'
    return { realm: r, scheme: 'label', id: `${r}:${p}:${u}`, project: p, user: u, display: u, assurance: 'declared' }
  }
  return { classify, mapInbound: (id) => id }
}
