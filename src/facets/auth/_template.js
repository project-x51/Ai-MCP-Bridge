// AuthProvider facet — TEMPLATE. Copy this to "<name>.js", set meta.name, and implement.
// Proves/accepts the identity of a connecting peer. Returns the credential this bridge presents in a
// HELLO, and verifies a credential received from a peer. (Default impl: shared-token compare.)
//
// Interface:
//   credential() -> any        the value to put in an outbound HELLO `auth` field
//   verify(cred) -> boolean    true if an inbound credential is acceptable
export const meta = { facet: 'auth', name: 'template' }
export function create(ctx) {
  return {
    credential() { throw new Error('auth.credential not implemented') },
    verify(cred) { throw new Error('auth.verify not implemented') },
  }
}
