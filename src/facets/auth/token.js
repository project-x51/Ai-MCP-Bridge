// AuthProvider — shared-token (default). Every bridge in a realm shares config.token; a HELLO carries
// it and the receiver compares. Empty token = no auth (loopback dev).
export const meta = { facet: 'auth', name: 'token' }
export function create(ctx) {
  const TOKEN = ctx.TOKEN
  return {
    credential() { return TOKEN },
    verify(cred) { return !TOKEN || cred === TOKEN },
  }
}
