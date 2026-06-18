// Persistence facet (docs/architecture.md §12) — durable mailboxes (park), retained topic values, and
// durable claim records, over a shared folder the realm's machines all see. Copy this to <name>.js and
// implement the three stores; register it in facets/index.js. ctx = { CFG, HERE, REALM, env, log, ... }.
//
// Design invariants the impl MUST preserve (so it's conflict-free even on a no-lock backend like Dropbox):
//   - one writer per file; names are content-addressed (envelope id) or per-writer (identity key)
//   - messages are write-once; a claim/retained file is rewritten only by its own holder/publisher
//   - effective state (owner, retained value, mailbox contents) is COMPUTED from the file set
//   - atomic writes (temp + rename); deletes idempotent
// Bodies arrive already-encrypted (cipher facet) and claims already-signed (capSigner) — this facet just
// stores opaque records. Identity = { realm, project, user, name }; keys are format-prefixed + stable.
export const meta = { facet: 'persistence', name: '_template' }
export function create(ctx) {
  return {
    meta, root: null, readable: false,
    mailbox: {
      async put(identity, envId, record) {},      // park one message
      async drain(identity) { return [] },         // [{ envId, ts, record, _file, _size }] across both key forms, oldest first
      async ack(identity, envId) {},               // delete after delivery
      async gc(identity, opts) { return [] },      // enforce TTL + caps; return dropped [{envId, why}] for logging
      async gcAll(opts) { return 0 },              // sweep EVERY mailbox for TTL-expired messages; return count dropped
    },
    claims: {
      async put(project, topic, identity, record) {},
      async read(project, topic) { return [] },    // every holder's claim record for the topic (ownership computed by the caller)
      async byHolder(identity) { return [] },      // every claim filed by an identity, so it can re-assert them on register
      async remove(project, topic, identity) {},
      async gcAll(opts) { return 0 },              // drop claims past hard expiry (holder never returned); return count dropped
    },
    grants: {
      async put(from, to, record) {},              // durable cross-project consent edge (from->to, mode, exp)
      async all() { return [] },                   // every stored edge, to rehydrate runtimeAllow on startup
      async remove(from, to) {},
      async gcAll(opts) { return 0 },              // drop edges past their expiry; return count dropped
    },
    registrations: {
      async put(identity, record) {},              // durable name->identity (+ secret_hash, last_seen), self-describing
      async all() { return [] },
      async byName(name) { return [] },            // every registration with this name (case-insensitive); caller scopes by consent
      async remove(identity) {},
      async gcAll(opts) { return 0 },              // drop registrations unseen past maxAgeMs; return count dropped
    },
    subscriptions: {
      async put(identity, pattern, record) {},     // durable per-holder interest (self-describing)
      async byHolder(identity) { return [] },      // an identity's subscriptions, to rehydrate on re-register
      async remove(identity, pattern) {},
      async gcAll(opts) { return 0 },              // drop subscriptions unseen past maxAgeMs; return count dropped
    },
    retained: {
      async put(project, topic, identity, record) {},
      async read(project, topic) { return null },  // the newest publisher value
      async allForProject(project) { return [] },  // newest value per topic: [{topic, record}] (for subscribe-time catch-up)
      async gcAll(opts) { return 0 },              // drop retained values older than ttlMs; return count dropped
    },
    limits: { messageTtlMs: 0, retainedTtlMs: 0, graceMs: 0, hardExpiryMs: 0, mailboxMaxCount: 0, mailboxMaxBytes: 0 },
  }
}
