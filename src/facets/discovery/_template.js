// Discovery facet (docs/architecture.md §7) — how a per-host hub finds the OTHER hubs of the same
// realm across machines. The mesh consumes a flat list of candidate hub addresses and is blind to how
// they were obtained; the realm-token handshake (not this facet) decides who is actually a member.
//
// Copy this file to <name>.js, implement the two methods, and register it in facets/index.js.
// ctx = { TOKEN, REALM, CFG, HERE, SESSION, PORT, ADVERTISE, env, log }.
export const meta = { facet: 'discovery', name: '_template' }
export function create(ctx) {
  return {
    // Return the candidate peer-hub addresses to attempt: [{ host, port }]. May include self / dead
    // hosts — the caller skips self and lets the token handshake reject non-members. Async; never throw
    // (return [] on error). `port` defaults to this realm's control PORT when the backend only yields hosts.
    async candidates() { return [] },
    // Make THIS hub findable by peers (e.g. register a service). No-op when reachability alone suffices
    // (a peer just connects to the well-known port). Called once when the hub is elected.
    advertise() {},
  }
}
