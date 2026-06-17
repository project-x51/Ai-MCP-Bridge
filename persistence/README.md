# Persistence store

Shared folder backing **durable messages** (park / retain) and **durable responsibilities**
(persistent topic claims) — see `docs/architecture.md` §13. Synced between a realm's machines by
whatever `persistence.dir` points at: Dropbox here (least setup), or an SMB / NFS share for
real-time, no sync churn.

Git tracks **only the skeleton** — the three category folders below, via their `.gitkeep`. Everything
one level deeper is **gitignored**: it's machine-generated runtime data that holds encrypted message
bodies *and* cleartext subjects/identities, and must never reach the public repo. (Dropbox still syncs
that data between machines — git just versions the structure.)

    mailboxes/  <identityKey>/env_<envId>.msg            one immutable file per parked message
    claims/     <project>/<topicKey>/<holderKey>.claim   one file per holder (lease-renewed)
    retained/   <project>/<topicKey>/<publisherKey>.val  one file per publisher (newest wins)

**Collision-free on a no-lock backend (Dropbox):** no two processes ever write the same file — names
are content-addressed (envelope id) or per-writer (holder/publisher identity); files are write-once
(messages) or single-writer (claims). Effective state (a topic's owner, its retained value, a
mailbox's contents) is *computed* from the file set, never stored authoritatively — so there is never
a concurrent edit to one file, hence no "conflicted copy". Bodies are AES-GCM encrypted to the
recipient's secret; claims are HMAC-signed by their holder.
