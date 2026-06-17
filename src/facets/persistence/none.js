// Persistence facet: none (default) — persistence OFF. Every op is a no-op; nothing is durable, so the
// bridge behaves exactly as it did before §12. Opt in with `"profile": { "persistence": "file" }` (or
// env AI_BRIDGE_PERSISTENCE=file).
export const meta = { facet: 'persistence', name: 'none' }
export function create() {
  return {
    meta, root: null, readable: false,
    mailbox: { async put() {}, async drain() { return [] }, async ack() {}, async gc() { return [] } },
    claims: { async put() {}, async read() { return [] }, async remove() {} },
    retained: { async put() {}, async read() { return null } },
    limits: { messageTtlMs: 0, retainedTtlMs: 0, graceMs: 0, hardExpiryMs: 0, mailboxMaxCount: 0, mailboxMaxBytes: 0 },
  }
}
