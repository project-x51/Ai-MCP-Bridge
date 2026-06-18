// Authorizer facet (architecture.md §16) — a pluggable human-in-the-loop confirmation for sensitive,
// presence-gated decisions (today: taking over your OWN dormant topic from another session; later: inbox
// secret-unlock, sensitive grants). The bridge calls confirm() and acts on { approved }. Swapping the impl
// swaps HOW the human is asked (a real Windows Hello prompt, a PIN, a script) without touching the bridge.
//
//   confirm({ action, topic, subject, details, user, requester }) -> { approved: boolean, reason?, by? }
//
// MUST default to NOT approved on any error/unavailability — never silently approve.
export const meta = { facet: 'authorizer', name: '_template' }
export function create(ctx) {
  return {
    meta,
    async confirm(_req) { return { approved: false, reason: 'not-implemented', by: '_template' } },
  }
}
