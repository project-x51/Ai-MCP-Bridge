// IdentityModel facet — TEMPLATE. Copy to "<name>.js" and implement. Establishes "who is this and how
// sure are we" for a participant, as a normalized realm-scoped identity (architecture.md §8). The
// default trusts declared labels; other impls verify via Tailscale / OIDC / mTLS, or map foreign ids.
//
// Interface:
//   classify({project, user, realm}) -> { realm, scheme, id, project, user, display, assurance }
//   mapInbound(foreignIdentity, fromRealm) -> identity   (translator hook; default: identity)
export const meta = { facet: 'identity', name: 'template' }
export function create(ctx) {
  return {
    classify(input) { throw new Error('identity.classify not implemented') },
    mapInbound(id, fromRealm) { return id },
  }
}
