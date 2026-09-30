# Ai MCP Bridge — Architecture

**Status:** living design note. Captures the agreed model for identity, realms, cross-project
consent, reply authentication, topics, federation, and the pluggable security/transport profile
architecture. Sections marked **(built)**, **(designed — pending)**, or **(reserved — later)**
reflect implementation state; see [§13 Implementation status](#13-implementation-status).

The operational reference (tools, setup, daily flow) lives in [`../src/README.md`](../src/README.md).
This document is the *why* and the *shape*.

---

## 1. Mesh fundamentals (built)

- **One bridge per MCP stdio client.** Claude Code: one process per session. Claude Desktop/Cowork:
  one process shared by every conversation; those register as **sub-peers** with their own identity,
  secret and private inbox.
- **Per-host gateway by port-bind election.** First bridge to bind the shared port becomes gateway;
  the rest become followers and register over a control connection. The single retry edge
  (follower → re-bind) is the only failover path; state is reconstructed by re-registration.
- **Same-host pairs dial directly.** The gateway is a registry + WebSocket ingress for **page leaves**
  + trace collector. Same-host session pairs connect loopback-to-loopback, bypassing the gateway.
- **Delivery is at-least-once** with content-derived envelope ids + receiver dedupe. Loop guard:
  a hop-chain of ids in each envelope.

Everything below builds on this substrate. The substrate itself is **realm-agnostic** — it routes
abstract identities and defers auth/crypto/transport/config to the realm profile (§10).

---

## 2. Participants vs infrastructure

A hard line runs through the system:

- **Participants** — *sessions, sub-peers (conversations), and page leaves*. They send and receive
  application messages. Every participant carries a **mandatory `(project, user)`** classification.
- **Infrastructure** — *bridges, gateways, translators*. They route and **enforce** policy. They are
  **never** participants and carry no project of their own. A headless gateway (e.g. a tray-launched
  always-on relay) is pure infrastructure — it has nothing to classify.

**Granularity is per-conversation, never per-bridge.** A single Desktop process multiplexes many
conversations that may belong to *different* projects, so the label attaches to the conversation
(the sub-peer). Code is one-conversation-per-process, so it attaches once at the process — but that's
a coincidence of the client, not the rule.

Classification is mandatory: `register_self`, a page `hello`, and a Code session's launch must all
supply `project` + `user`, or they are refused. Infrastructure roles are exempt because they are not
participants.

---

## 3. Realms — trust domain + security profile

A **realm** is the highest-level boundary: a trust-and-policy domain. It typically maps to an
organization, though one organization may run several (e.g. a locked-down enterprise realm plus a
looser lab realm).

A realm is defined by a **security profile** — a binding of implementations for its swappable facets:

| Facet | Default profile (built/near-term) | Alternate profiles (later) |
|---|---|---|
| **Auth** | shared `token` checked at HELLO | tailnet-node identity, mTLS, SPIFFE/SSO |
| **Body crypto** | AES-256-GCM, key = HKDF(token) | per-realm keys, KMS-backed |
| **Identity / users** | declared labels | directory- or SSO-resolved, mapped |
| **Config distribution** | shared JSON file (Dropbox / SMB) | URL, config service/API |
| **Transport** | length-prefixed JSON over TCP (+ WS leaves) | TLS-public, message queue, … |
| **Discovery** | enumerate reachable hubs via `tailscale status` | mDNS (LAN), presence-folder (Dropbox/SMB), static seeds |

"Internet realm / private-LAN realm / enterprise realm" are simply three profiles.

**Realm is orthogonal to transport.** The realm is the unit of *trust* (who shares keys + policy);
the transport network (LAN, tailnet) is the unit of *reachability*. A realm can span a tailnet; two
realms can share one tailnet (same wire, different trust); two realms can live on different tailnets.
A realm can **span many machines** on a tailnet with no central node and no static peer list (§7);
adding a machine is free. You only enter multi-*realm* territory — different keys and trust — by
**federating** through a translator (§8).

**Addressing.** Within a realm, projects and topics are bare (`topic:bridge/admin`). Across realms,
they qualify: `realm:project` and `@realm:project/topic`. The `realm` field and realm-qualified
addressing exist from day one so the wire format does not churn when federation lands.

---

## 4. Projects & cross-project consent (designed — pending)

Within a realm, **projects** isolate sessions. The default stance is **strict**: no project may reach
another. Same-project communication is always open. A single `open` config switch flips the realm to
"all projects interoperate" for trusted single-operator machines.

### Receiver-controlled inbound consent

Cross-project access is **the receiver's to grant**. Each project has an **inbound allow-list**:
"projects permitted to initiate to me." An entry arrives three ways — same rule, three provenances:

1. **Static** — declared in the realm's shared config (`projects.allow`). Survives restarts.
2. **Declared at runtime** — a session in the target project calls `allow_project {project, mode}`
   ("I'll open myself to X"). In-memory.
3. **Requested → granted** — a session calls `request_project_access {to, reason}`; the gateway
   mediates by project *name* (the requester still cannot see the target's sessions), delivering a
   `project_access_request` to the target; a target **operator** approves, creating the entry.

Runtime grants (2, 3) are **operator-gated** — the granting AI surfaces the request to its human, the
same pattern as topic-takeover. No session silently opens its project.

### Direction & the reply exception

Edges are **directed**: an entry is per-(target, source), so it is one-way by construction.
`mode` is `send` (source may initiate; target may only reply to those threads) or `bidirectional`
(both initiate; realized as an entry on each side, since each side consents for itself).

**Reply return-traffic is always allowed** — if A initiated to B, B may reply to A's thread even
without A having consented to inbound from B's project. This makes request/response work across a
one-way edge. The reply exception is made unforgeable by the **reply capability** (§5).

### Enforcement — two layers

1. **Visibility (primary).** The gateway gossips each session a roster **filtered** to the projects it
   may reach. Can't see a peer → can't address it. Sessions, sub-peers, pages, and topics are all
   filtered. Isolation is, first and foremost, roster scoping.
2. **Delivery (defense).** The bridge that delivers to the target re-checks the **sender's project**
   (carried in the cleartext metadata plane, so a splice-opaque gateway enforces without reading
   bodies) against the target project's inbound policy. Catches same-host direct-dial and cross-host.

### Policy file discipline

The realm's shared config is **read-only to the bridge** — static policy is hand-edited. This
sidesteps Dropbox/SMB write-conflict copies entirely (no two machines writing one JSON). The bridge
**live-reloads** on external change, so editing policy on one machine propagates to the realm.
Runtime grants stay in-memory; promote a grant to permanent by hand-adding it to the shared file.

---

## 5. Reply capability — unforgeable return traffic (designed — pending)

The reply exception (§4) is the one way a message crosses a project boundary without prior consent,
so it must be unforgeable: otherwise anyone could tag a message `reply_to:<anything>` and ride the
return-traffic allowance into a project that never consented.

**Mechanism — a stateless MAC keyed by the session secret.**

- At `register_self`, the bridge derives a signing key `capKey = HKDF(secret, "reply-cap")` and keeps
  **only that in RAM** for the conversation's lifetime. The raw secret is still hashed-and-discarded
  (it is never retained or written to disk).
- When a session **sends**, its bridge stamps
  `cap = HMAC-SHA256(capKey, ownProject | counterpartyProject | envId | expiry)` (truncated to 128
  bits), carried as `expiry.cap`. Every keyed field is on the wire, so verification is pure
  recomputation.
- A **reply** copies that `cap` and sets `reply_to` — the replier echoes, cannot alter.
- On the **return**, the original sender's bridge recomputes the HMAC with its `capKey` and
  constant-time compares; valid + sender-project matches the bound `counterpartyProject` → allow
  across the boundary. Nothing is stored.

`envId` (already a content hash) makes each cap **unique per message** and binds it to that exact
message; `counterpartyProject` stops a leaked cap being replayed by a *different* project. `expiry`
is still part of the signed payload (so it cannot be tampered) but is **no longer enforced** — see
Decision B below.

**Decision B — replies always get through (2026-06-14).** A genuine reply-cap is honoured for the
life of the minting process, regardless of two things that used to cancel it:

- **No clock.** The `expiry` field is signed but not checked, so a reply is never refused for being
  "too late." (Previously a 30-minute `CAP_TTL_MS` window could silently expire a thread mid-
  conversation — discovered live when a reply bounced ~9 min after the window closed.)
- **No revoke.** The cap is an **independent allow** in `deliveryAllowed` — checked *after*, and OR'd
  with, the project-consent test. A later `revoke_project` removes the forward grant (no *new*
  traffic) but does **not** cancel replies on threads that were already opened.

The natural lifetime is therefore "until either side's process restarts," at which point `capKey`
rotates and old caps stop validating. **Trade-off, accepted:** a party you revoke can still answer
messages you already sent it (per-thread, no new initiation) until one side restarts. The principle
is that inviting a reply is a standing invitation to that reply — consent state and a timer should
not strand return-traffic. (`CAP_TTL_MS` remains only to stamp `expiry`; env-overridable for tests.)

**Restart semantics fall out correctly, for free:**

- A **Cowork conversation** re-attaches with the same secret → the bridge re-derives the same `capKey`
  → caps minted before the restart still validate. Replies survive a restart with **no persistence**.
- A **Code session** relaunches as a new run with a fresh secret → its old caps die — the correct
  semantics (a re-opened conversation is *continued*; a relaunched session is *new*).
- The cap is **portable across machines** — it is bound to the secret, which travels with the session,
  not to any bridge or host.

**Why a MAC, not encryption.** "Encrypt a padded number and check the pattern on decrypt" is the
encryption-as-authentication foot-gun: a "1-in-a-million valid" structure is ~2²⁰ (brute-forced in
~a million tries), and block ciphers are malleable. HMAC gives ~2¹²⁸ forgery resistance with one
primitive, no padding scheme — the standard tool for stateless signed tokens.

**Durability note (forward-reference):** when offline delivery (§11) introduces a persistent agent
registry, the `capKey` derivation rides with it for free; cap durability and the reply's landing spot
then arrive together. Third-party verification (a relay checking on someone's behalf) would use an
asymmetric variant (sign private / verify public), landing with the federation key work (§8).

---

## 6. Topics (project-scoped) (designed — pending; flat topics built)

Topics are **scoped to their project**: a claim of `bridge/admin` in project `alpha` is independent
of `research`'s `bridge/admin`. Within your project you write the bare path; cross-project (along an
allowed edge) you qualify with `@research/bridge/admin` (the `@`-prefix marks the project and never
collides with a normal path segment). Exclusive-claim overlap (a claim conflicts with any overlapping
claim above or below it in the tree) is evaluated **per project**, so isolation holds.

The two relationships (subscribe = open interest; own/claim = accountability) and two patterns
(publish = event to all subscribers; send to `topic:` = directed work to owners) are unchanged from
the flat-topic model already built — projects add the scoping dimension.

**A claim (responsibility) must be CONCRETE — no wildcards** (built, 2026-06-16). `claim_topic` rejects
any pattern containing `+`/`#` with code `wildcard-claim`, for both exclusive and shared claims; the page
auto-claim of a leaf's `subject` applies the same guard. Rationale: a wildcard claim is **unaddressable**
— `send_to_peer {topic:...}` refuses a wildcard target (`wildcard-target`) — so an owned wildcard silently
breaks any UI that offers it as a send target. `subscribe` stays wildcard-capable: *watching* a subtree is
fine, *owning* one is not. A consequence: there is **no subtree ownership** — owning `retail` does not
block `retail/contact-energy` (concrete paths of different depth don't overlap), so sub-paths are claimed
independently. Convention: one concrete word per responsibility (Retail, Research, Bills, Bridge, …).

---

## 7. Cross-host mesh — one realm across machines (built — MVP)

A realm is the unit of *trust*; a tailnet is the unit of *reachability* (§3). A single realm can span
many machines on a tailnet **with no central node and no static peer list** — machines join and leave
freely. This is distinct from §8 (federation): there every machine shares one realm's keys, token, and
config; §8 bridges *different* realms.

**One hub per machine — co-equal, none central.** The per-host **port-bind election** is unchanged:
the first bridge process on a machine to bind `:PORT` becomes that machine's **hub** (its roster
holder + WS/page server); later local processes are followers. The hub is a *local representative*,
not an organiser — if it dies, the next local process re-binds and takes over. Across machines, hubs
are **peers of equal standing**: a flat mesh, never a star. No machine is "the" gateway.

**Discovery — the tailnet says who *could* be on the mesh; the token decides who *is*.** Cross-host has
no equivalent of the OS port table, so discovery uses the tailnet as a passive, symmetric directory:

1. **Candidates** — a hub enumerates online tailnet peers via `tailscale status --json` (local, no
   auth, already on every machine): "which of my machines are reachable right now." No **tags** —
   tagging a device transfers its ownership from the user to the tag, and these are user-logged-in
   workstations; no shared list; no privileged entry.
2. **Membership** — the hub attempts a connection to each candidate on the well-known bridge port and
   runs the **HELLO + realm-token handshake**. Whoever completes it is a member; a refused connection
   or a bad token is not. **The token is the membership filter**, so discovery needs no other shared
   state.
3. **Join / leave are implicit** — a machine appears in `tailscale status` when it comes online and
   disappears when it goes; stale peers fall out of the roster by the same TTL/heartbeat model as
   sub-peers. Nothing to configure, nothing to clean up.

**Roster gossip — a conflict-free union.** Once hubs connect, they exchange roster deltas peer-to-peer.
Each **session id is owned by exactly one machine**, so the global roster is the *union* of per-host
slices — merges never conflict; departures are tombstone + TTL. Eventually consistent, no authority.
The gossip also carries each host's **web sessions** (pages — display fields only, never capKey) and
marks each host's **gateway** (the gossiped entry whose session id equals its origin), so any machine's
dashboard renders the *full structure* of every machine — gateway, its followers, their sub-peers, and
pages — grouped by machine, not just a flat list of remote names.

**Delivery stays direct.** Envelopes go **host-to-host over the tailnet** by pair-dial to the
gossip-learned address — the `peer.host` roster field + the existing CONNECT handshake, the splice
already on the wire — with gossip-relay only as a fallback. The discovery directory is *never* in the
message hot path: `tailscale status` latency affects join/leave detection, not message latency.

**Addressing & bind.** A hub binds + advertises a **reachable** address (tailnet IP / MagicDNS name),
not loopback — `HOST` splits into a *bind* address and an *advertise* address. Same-machine peers keep
using loopback; cross-machine peers use the tailnet address carried in the roster. The advertise
address — the one per-machine value that cannot live in a Dropbox-shared config — **auto-derives** from
the discovery backend (`tailscale status` Self) when left unset, so a single shared config
(`bind: 0.0.0.0`, `discovery: tailscale`) suffices verbatim on every machine.

**Security posture.** The tailnet (WireGuard) encrypts every host-to-host link and the realm token
gates membership — sufficient for a trusted tailnet. Bodies are already AES-GCM encrypted (§3); frame
metadata (subjects, roster) rides the WireGuard tunnel in clear, acceptable inside the tailnet. For
hostile networks, swap the **transport facet** for a TLS profile; for network-layer access control
*without* tags, restrict the bridge port with **user-based** Tailscale ACL grants (by account /
`autogroup:member`), preserving user ownership of every machine.

**Discovery is a pluggable facet** — like transport and cipher. `tailscale` (enumerate `status`) is the
default; alternates are `mdns` (single LAN, zero shared state), `presence-folder` (Dropbox / SMB
bulletin board where each node writes its own uniquely-named heartbeat file), and `seeds` (explicit
addresses for hostile networks). Swapping the rendezvous mechanism never touches the mesh core.

**Deliberately out of scope here.** Cross-*realm* bridging stays in §8 (a translator, because keys
differ). And cross-machine hub **high-availability**: if a machine's hub dies its local mesh re-elects
locally, but a machine going fully offline simply *leaves* the mesh — its participants leave with it;
no other machine adopts them. That is the correct semantic for "machines join and leave freely."

---

## 8. Federation across realms — translator bridges (reserved — later)

Two realms have **different keys and different config**, so within-realm token auth and the
splice-opaque gateway cannot reach across. Bridging them requires a **translator**: a node that holds
credentials for *each* realm it joins and, at the border, **terminates one realm's crypto and
re-originates into the other's**. There is no splice-through across key domains.

A translator:

- **Enforces the receiver realm's federation consent** — `federation.peers[]` declares which of a
  *foreign realm's* projects may reach which of *ours*. Receiver-controlled, one level up from
  project consent.
- **Translates addressing** (`realm:project`) and **identity** — mapping, e.g., an enterprise
  SSO user to a label the LAN realm understands. (This is where **users** gain a structural role —
  see §9.)
- **Re-encrypts** — `open` with realm A's cipher, `seal` with realm B's cipher.

**Inherent tradeoff:** the translator sees plaintext crossing the border (it must, to bridge two key
systems). End-to-end secrecy holds *within* a realm; across a border the translator is in the trust
path. True cross-realm E2E would need the two endpoints to share a key negotiated *above* both
realms — a possible future layer, not a near-term goal. For a border gateway this is normal.

This maps directly onto the original security decisions: **D1** reserved a "terminate-and-re-encrypt
mode per pairing for enterprise inspection" — the translator *is* that mode, scoped to realm borders.
**D4** parked the enterprise stack (SPIFFE, short-lived creds, tenancy) — those are simply alternate
realm *profiles* a translator can speak.

---

## 9. Users — a realm-selectable identity model (designed — `label` pending)

`user` is a **mandatory identity field** on every participant: the human supervising the session.
But *how* a user is established differs wildly — a bare LAN label, a Tailscale account, an enterprise
SSO subject, a SPIFFE id — so **user resolution is a realm-profile facet (`IdentityModel`)**, exactly
like auth and transport (§10). The bridge **never owns a user database**: it carries a normalized
identity and delegates "who is this, and how sure are we" to the realm's profile.

### Normalized identity + assurance

Every user is carried as a realm-scoped, OS-agnostic tuple:

```
{ realm, scheme, id, display, assurance }
```

The unifying axis is **assurance** — how the identity was established:

| Assurance | Means | Source | Situation |
|---|---|---|---|
| **declared** | self-asserted label | the realm token already gated entry, so the label is trust-domain-trusted | bare LAN — zero infrastructure |
| **verified** | cryptographically proven | the realm's auth: Tailscale identity, OIDC/SSO, mTLS, SPIFFE | internet (Tailscale) / enterprise (SSO) |
| **mapped** | a *foreign* realm vouched, accepted via federation | translator mapping table (§8), assurance attenuated | across realms |

### Concrete `IdentityModel` implementations (each a pluggable facet)

- **`label`** (declared) — bare LAN: users are just names; the realm token is the real boundary.
  Optionally *seeded* from the OS account. **This is the v1 default.**
- **`tailnet`** (verified) — personal / cross-internet: the Tailscale node's owner is a verified
  identity for free, no enterprise infrastructure.
- **`oidc` / `mtls` / `spiffe`** (verified) — enterprise: delegate to the existing IdP; verify, don't store.
- **`mapped`** — the translator maps a foreign identity to a local one, attenuating assurance.

**The OS user is only ever a seed for a `label`** — never canonical, because an OS account (Windows
SID, Linux uid, macOS) is neither portable nor verifiable across machines. A verified identity that
*does* travel across OSes and the internet is the `tailnet` model, not the OS. So the OS dimension
does not enter the design.

### Roles, by assurance

- **Audit / display** — always (the dashboard can badge declared vs verified).
- **Grant-attribution** — a project/federation grant records the granting identity *with its
  assurance*; "verified alice@acme approved X" carries more weight than "declared robin."
- **Policy (per-user enforcement)** — **deferred until the concept is in place.** Only meaningful at
  `verified`+; how user access is enforced is decided once users exist on the wire.
- **Cross-realm** — mapped + attenuated at the translator.

### v1 scope

Ship the **`label`** model: `user` mandatory, assurance `declared`, optionally OS-seeded, used for
audit + grant-attribution — but the full normalized `{realm, scheme, id, display, assurance}` shape
is **on the wire from day one**, so `tailnet` / `oidc` / `mapped` slot in later as new `IdentityModel`
facets with **zero wire churn**. Per-user *access enforcement* is a later decision (the model first,
the policy once it's real).

---

## 10. Pluggable profile architecture (the implementation principle)

**The core mesh logic must be realm-agnostic, with each swappable facet behind a clean seam**, so that
plugging in a different kind of security or transport is obvious and local — not a rewrite. This is a
first-class requirement, not an aspiration.

### The facet interfaces

A **`RealmProfile`** binds one implementation per facet:

```
RealmProfile {
  auth:        AuthProvider     // prove/accept identity of a connecting peer
  cipher:      BodyCipher       // seal/open envelope bodies
  capSigner:   CapSigner        // mint/verify reply capabilities (§5)
  transport:   Transport        // listen / dial / frame
  config:      ConfigSource     // load + watch realm policy
  identity:    IdentityModel    // classify (project, user, realm); map across realms
  discovery:   Discovery        // enumerate candidate peer-hubs (§7) — none / seeds / tailscale
  persistence: Persistence      // durable mailboxes / claims / grants / retained (§12) — none / file
  authorizer:  Authorizer       // human-in-the-loop confirmation for presence-gated actions (§16) — none / script / hello
}
```

| Interface | Contract (shape) | Default implementation |
|---|---|---|
| `AuthProvider` | `credentials()` → HELLO payload; `authenticate(ctx)` → `{ok, peer}` | shared-token compare |
| `BodyCipher` | `seal(plaintext)` → `{ct, meta}`; `open(ct, meta)` → plaintext | AES-256-GCM, HKDF(token) |
| `CapSigner` | `mint(fields)` → cap; `verify(cap, fields)` → bool | HMAC(capKey) per §5 |
| `Transport` | `listen(onConn)`; `dial(addr)` → conn; framing contract | length-prefixed JSON / TCP + WS |
| `ConfigSource` | `load()` → realm config; `watch(onChange)` | shared JSON file + fs-watch |
| `IdentityModel` | `classify(declared)` → `{project, user, realm}`; `mapInbound(foreign, fromRealm)` | declared labels, no mapping |
| `Discovery` | `peers()` → candidate host:port hubs to probe (§7) | none (single-host); seeds; tailscale |
| `Persistence` | `mailbox` / `claims` / `grants` / `registrations` / `subscriptions` / `retained` stores over a shared folder (§12) | none (no-op); file |
| `Authorizer` | `confirm({action,subject,…})` → `{approved}` — presence-gated yes/no (§16) | none (deny); script; hello |
| `Vault` | `seal(secret)` → ciphertext; `unseal(ct)` → `{ok, plaintext}` — encrypt-to-user secret recovery (§21) | none; script; tpm (Hello + TPM) |

### How the pieces compose

- **Core** (election, roster, routing, queues, topics, project-consent) operates on abstract
  identities and calls the active profile's facets. It contains no `token`, no `aes-256-gcm`, no
  `net.connect` literal inline — those live only in the default-profile implementations.
- **A bridge** runs *one* `RealmProfile` (its realm).
- **A translator** instantiates *several* `RealmProfiles` and routes between them, applying federation
  consent + `identity.mapInbound` + re-encrypt (`open` on the source profile, `seal` on the
  destination).

### Module layout (built)

Each facet is its own folder with a `_template.js` (the stub to copy) plus one file per
implementation; `facets/index.js` binds one impl per facet into the `profile`:

```
src/facets/
  index.js              buildProfile(ctx) — selects an impl per facet (defaults; config.profile overrides)
  auth/        _template.js  token.js          (default: shared-token compare)
  cipher/      _template.js  aesgcm.js         (default: AES-256-GCM, HKDF(token))
  capsigner/   _template.js  hmac.js           (default: truncated HMAC reply-cap)
  identity/    _template.js  label.js          (default: declared label)
  config/      _template.js  file.js           (default: shared JSON file + live-reload watch)
  transport/   _template.js  tcp.js            (default: uint32-framed JSON / TCP + ws leaves)
```

`bridge.mjs` reaches all of these only through `profile` (it imports `buildProfile`, then aliases
`encryptEnvelope`/`plainBody`/`capKeyFrom`/`classifyIdentity`/`sendFrame`/`onFrames`/transport
listen+dial+ws from it). **Adding an implementation is: copy `<facet>/_template.js` to `<name>.js`,
implement it, register one line in `facets/index.js`** (or select via `config.profile`). Future
profiles (tailnet, mtls, spiffe, mapped) and the federation translator slot in here with no core
changes.

**Discovery facet — `discovery/`** (the seventh facet, §7, built): how a hub finds peer hubs.
`tailscale.js` enumerates online tailnet peers (`tailscale status --json`); `seeds.js` reads a static
list (tests / hostile networks); `none.js` is the single-host default. (`mdns.js`, `presence-folder.js`
are documented alternates, not yet written.) Interface: `candidates()` → reachable hub addresses;
`advertise()` → make this hub findable. Same copy-a-template pattern, no core changes — the mesh
consumes a peer list and is blind to how it was obtained.

---

## 11. Reserved surface & capability detection (partly built)

Forward-compatibility features exist in the protocol so they land without churn. Each returns
`{ok:false, code:"unsupported"}` until built, and is advertised via the `capabilities{}` object on
`my_identity` / the roster (feature-detection, not version-sniffing):

- **wake** — `set_wake` + a WS `listener` attach point (doorbell for idle Code sessions). *(reserved)*
- **park** (durable messages) + **persistent claims** (durable responsibilities) + **retain**
  (last-value-per-topic) — **built (§12)**; the `park`/`retain`/`persistent_claims` capability bits flip
  true when a `persistence` facet is active. `persistent`/`retain` are accepted always (a no-op without
  persistence).
- **force** (operator immediate-takeover of an offline holder) — still **reserved**; also the home for
  durable reply-caps (§5).
- **federation** — the `federation` config block + translator (§8).

---

## 12. Persistence — durable messages & responsibilities (partly built — v1.9)

> **Status (built, v1.9 → v1.12):** the `persistence` facet (`none` default / `file`) with stable
> format-prefixed identity keys, and **five stores** — **mailboxes** (auto-park on delivery, redelivered
> to a returning peer; cursor-ack; TTL + caps), **claims** (durable responsibilities, rehydrated on
> return; hard-expiry GC; no-clobber), **grants** (durable cross-project consent + TTL, §14), **durable
> registrations** (name→identity so an offline-by-name send parks, §19), and **retained** (last value per
> topic, delivered on subscribe). Enable with `profile.persistence:"file"` / `AI_BRIDGE_PERSISTENCE=file`;
> bodies stay encrypted at rest, records are self-describing. **Pending** — explicit `park` to a
> *never-registered* identity (registrations cover the once-registered case), and the full lease →
> dormant → displaced negotiation (the return path re-asserts a holder's own claims + does same-user
> Hello takeover / cross-user grace, but defers multi-claimant arbitration to `request_responsibility`).

Two features over one substrate: **durable messages** (a message to an offline peer survives and is
delivered when it returns) and **durable responsibilities** (a topic claim survives a restart). Both
light up the reserved `park` / `retain` / `persistent_claims` surface (§11). The substrate is a
**shared folder** every machine in the realm can see, behind a pluggable **`persistence` facet** — the
same decentralised, no-central-node shape as discovery (§7).

### Stable identity — the keying problem

Session ids (`host/hex`) and sub-peer ids are **volatile** — they change on every restart. The only
thing stable across a restart is `(name, secret)`, which already derives a stable `capKey =
HKDF(secret)` (§5). So durable state is keyed by a **stable identity** — `realm:project:user:name` —
never the session id.

The identity tuple is **lower-cased before keying** (v1.17), so names are case-insensitive end-to-end:
`"Bolletta"` and `"bolletta"` resolve to one mailbox/claim/vault, and live lookups
(`register_self`/`send_to_peer`/`inbox`) compare names case-folded too. The as-typed `name` is still
stored in the record body for **display** — only the *key* is canonicalised. Topic/project/pattern path
segments are likewise lower-cased into their on-disk keys (an `lslug` over the case-sensitive `slug`,
which is reserved for content-addressed envelope ids).

The on-disk key is **format-prefixed**, so the store is self-describing and switching formats never
strands data:
- **`h-<sha256(realm|project|user|name)>`** — production: fixed-length, fs-safe, leaks no identity
  taxonomy in a directory listing.
- **`r-<slug>-<first-4-of-that-sha>`** — dev (`devReadableKeys:true`): a sanitised, lower-cased slug
  (`default__aimb__robin__bridget`) plus a 4-char hash for uniqueness. Legible when eyeballing the
  folder mid-test.

On lookup the bridge computes **both** forms for an identity and drains whichever exists — so flipping
`devReadableKeys` with mailboxes already on disk does no damage; mail under the other prefix is still
found. A `secretHash` verifier is stored per identity so only the right secret drains a mailbox, and
**bodies stay AES-GCM ciphertext** (sealed to the `capKey`) so the folder — and anyone who can read it
— can't read message contents. Only routing metadata (subject, from/to, ts, expiry, reply-cap) is
cleartext.

### Durable messages — park + retain

- **park** — directed messages are **persistent by default** (`persist:false` opts out, for ephemeral
  pings). A message to an *offline* recipient is written to its mailbox and delivered on re-register,
  deduped by envelope id (at-least-once + idempotent). Live delivery when both are online never touches
  the store — persistence is only the offline fallback, so the shared folder's sync latency is never on
  the hot path. Consent is checked **twice** — at park-time (you can only park what you could send live)
  and again at delivery (consent may have changed; a parked cross-project message obeys the Decision-B
  reply-cap rules, §5). Per-mailbox caps (`mailboxMaxCount`, `mailboxMaxSize`) bound *each recipient*;
  over cap → **drop oldest and log** (no silent truncation). TTL `messageTtlDays` (default 14,
  per-message override) expires undelivered mail.
- **retain** — a `publish` with `retain:true` keeps the **last event per topic**; a new or returning
  subscriber gets it immediately on subscribe — catch-up without durable per-subscriber queues. TTL
  `retainedTtlDays` (default 14) or until overwritten; last-writer-wins.

### Durable responsibilities — the claim lifecycle

Claims are **persistent by default** (opt out per claim) and re-hydrated (auto-reclaimed) on
re-register. While the owner is away a claim follows a **lease + conflict-on-return** lifecycle:

- **ACTIVE** — owner present, *or* offline within the **grace window** (`claimGraceMinutes`, default
  60). Holds exclusively; others get `held`; topic traffic parks for the owner. The grace makes a normal
  restart a no-op — nobody can grab "Bridge" during a reboot.
- **DORMANT** — offline past grace. The reservation goes **soft**: it still exists (shows "[away]",
  reclaimable) but no longer blocks a new claimant; traffic keeps parking for the absent owner *until*
  someone takes it.
- **DISPLACED** — another peer claimed the topic while it was dormant. They are now ACTIVE and receive
  its traffic; the original claim is displaced, not deleted.
- **EXPIRED** — offline past `claimHardExpiryDays` (default 14) → the record is GC'd. (Or explicit
  `release_topic` any time.)

**Conflict-on-return is a mediated handoff, never a seizure:** return-while-DORMANT → re-hydrate
cleanly; return-while-DISPLACED → the owner is notified and may `request_responsibility`; the new
holder keeps it until they `grant_responsibility` it back. Claims must be **concrete** (the wildcard
ban, §6) and are **HMAC-signed by the holder's `capKey`** so a realm member can't forge another's claim
by dropping a file. Ownership is **computed** from the claim-file set + these timers — every gateway
agrees with no central arbiter.

### Subscriptions

Persisting subscriptions is **optional, default off** (`persistSubscriptions`). They're interest, cheap
to re-establish on reconnect, and `retain` covers "catch up on what I missed". Durable per-subscriber
event history is a heavier feature left for later.

### The substrate — a `persistence` facet over a shared folder

Pluggable like transport / discovery / cipher. `persistence.dir` is a **path**: the bridge neither
knows nor cares whether it's Dropbox (least setup, decentralised, roams), an SMB/NFS share (real-time,
no sync churn, needs an always-on host), or anything else. It works on all of them because the **file
layout is conflict-free even under the weakest backend** (Dropbox: no locks, eventual consistency,
"conflicted copy" on concurrent edits):

```
<persistence.dir>/
  mailboxes/  <identityKey>/env_<envId>.msg            one IMMUTABLE file per parked message
  claims/     <project>/<topicKey>/<holderKey>.claim   one file per holder (lease-renewed by that holder)
  retained/   <project>/<topicKey>/<publisherKey>.val  one file per publisher (effective value = newest)
```

The invariants that make it lock-free and conflict-free:
1. **No two processes ever write the same file** — names are content-addressed (envelope id) or
   per-writer (holder/publisher identity), so a shared backend never sees a concurrent edit to one file.
2. **Write-once or single-writer** — a `.msg` is immutable; a `.claim` is only ever rewritten by its own
   holder (to renew the lease).
3. **State is computed, not stored** — a topic's owner, its retained value, a mailbox's contents are
   pure functions of the file set + the timers; every gateway computes the same answer.
4. **Atomic writes + idempotent deletes** — write `*.tmp` then rename (readers skip `.tmp`); the only
   drainer of a mailbox is the recipient's *current* host (no cross-machine delete race); a file that
   reappears from sync lag is a redelivery, deduped; TTL/expiry GC is any-gateway and idempotent.

Default impl is host-local for a single machine; `dropbox` / `share` / `gossip` are drop-in. Git tracks
only the skeleton (`persistence/.gitignore` keeps the category folders, ignores all runtime data — it
holds cleartext subjects/identities). Config sizes accept a **string** — plain bytes or `KB`/`MB`/`GB`,
space optional, decimals OK (`16MB`, `12.5 MB`, `1 GB`, `1048576`). A future `storeMaxSize` could bound
the whole store; per-mailbox caps are the primary defence.

> **Keying caveat (v1.10 fix):** the on-disk key is `(realm, project, user, NAME)`. The IdentityModel's
> `classify()` deliberately omits the session name (an identity is the human+work, not the session), so
> the bridge appends it before every persistence call — sub-peers by their register name, the process by
> hostname. Earlier, the missing name collapsed all co-user sub-peers onto one mailbox/claim key (a
> sender then drained its own send on reconnect). One writer per file still holds because the name is
> part of the path.

### Offline owners, dormant-claim takeover & the authorizer (§16) — built v1.10

A durable claim makes a topic owner **addressable while offline**. Two behaviours follow:

- **Park to an offline owner.** A directed `send_to_peer {target:"topic:<t>"}` whose owner holds a durable
  claim but is not currently registered is **parked to that owner's mailbox** (by the identity rebuilt
  from the claim record, which now stores `user`+`name`) and delivered when it returns — instead of
  bouncing `no-owner`. Consent is checked at park-time (only park what you could send live). The owner
  chooses at `claim_topic` whether senders are **told** it is offline (`announce_offline`) or whether the
  message is parked **silently** (the send looks like a normal accept) — the default.
- **Taking over a dormant topic.** When a claimant wants a topic an *offline* durable owner still holds,
  the in-RAM exclusive-blocker check can't see it, so a dedicated guard resolves it:
  - **Same user** (your own other session): gated by the **`authorizer` facet** — a presence check the
    human must pass. `none` (default) denies; `hello` raises a real **Windows Hello** prompt via the
    tray (proven in `experiments/hello-tpm-vault`; the live shim is the one unwired piece); `script`
    (env/file decision) makes the whole flow testable headlessly. The facet **never silently approves**.
  - **Different user**: **grace-then-displaceable** — held during the grace window, then displaceable
    only if takeover is permitted. Policy is **per-claim** (`grace_minutes`, `allow_other_user`) over the
    realm **config** (`claimGraceMinutes`, `allowCrossUserTakeover`, default deny).

The authorizer is the reusable seam for any future presence-gated decision (e.g. the inbox secret-unlock
/ Hello-vault recovery): the bridge calls `authorizer.confirm({action, subject, details, user})` and acts
on `{approved}`; swapping the impl swaps *how* the human is asked without touching the core.

### Durable cross-project grants with TTL + acknowledgement (§14) — built v1.10

Runtime `allow_project` grants (§4) are now **durable** (a `grants` store in the persistence facet;
re-hydrated into `runtimeAllow` on startup, dropping any expired) and may carry a **TTL** — minutes or a
duration string, `forever` supported. A `request_project_access` may state a requested TTL; the operator
may **only shorten** it; the grant response and the requester's notification both report the **permitted**
TTL. Approving a request is no longer silent: the bridge sends the requester a **`project_access_granted`**
echoing its `request_id` + the permitted TTL/expiry (it previously had to poll-by-retry). Edges are
routing metadata (project names + mode + expiry, already cleartext in the roster) so stored as plain JSON.
Since v1.45.0 (#62) runtime grants also **replicate mesh-wide** as a last-writer-wins set (revokes are
tombstones), gossiped between hubs and pushed to/from followers — see §13 v1.45.0.

### Durable registrations — offline-by-name delivery (§19) — built v1.11

Sub-peer registrations are RAM-only, so a gateway restart drops them and a directed send to that peer **by
name** bounced `unknown-target` — the message evaporated. Now `register_self` also records a durable,
**self-describing** `name → identity` mapping in a `registrations` store (one file per identity: the full
`{realm, project, user, name}` + `secret_hash` + `last_seen`). A send to a name with no *live* peer then
looks up the registration, checks consent (you can only park what you could send live), and **parks** to
that identity's mailbox — delivered when the peer returns. A name that was *never* registered still errors
`unknown-target` (you can't park for a string nobody ever claimed). Registrations age out on the same
hard-expiry as claims.

This is also why a parked **`.msg` stores the recipient identity in-body**, not only in the hashed dir key:
a record that carries its own identity can be attributed, migrated, and audited without reversing the key —
the exact property whose *absence* (claims with no `user`/`name`) caused the v1.10.x owner-lockout bug.

---

## 13. Implementation status

- **Built (v1.3):** within-realm mesh — gateway election, followers, sub-peers (register/secret/
  cursor/epoch/TTL/dead-letter), page leaves, roster gossip, dashboard; **flat** topics with
  subscribe/own + publish/send, exclusive-overlap, icons; mandatory message `subject`; AES-GCM body
  encryption; reserved wake/offline surface; capability object; cross-host CONNECT splice (untested).
- **Built (v1.6):** the profile-facet seam fully extracted into `src/facets/` (all six facets in
  their own modules with templates — §10); mandatory `(realm, project, user)` normalized identity via
  the `label` `IdentityModel` (§9); receiver-controlled project consent — strict default + `open`,
  static config edges + runtime `allow_project` / `revoke_project` / `request_project_access`, enforced
  receiver-side at delivery (§4); the signed reply-capability (§5); project-scoped topics +
  `@project` / `@realm:project` addressing (§6); config policy live-reload; per-recipient roster
  **visibility** filtering (a page sees only reachable projects; opt out with hello `seeAll`); the
  dashboard surfaces realm/project/user.
- **Built (v1.8):** cross-host mesh — one realm across machines (§7): co-equal per-host hubs (port-bind
  elected) federated over the tailnet; `discovery` facet (`tailscale` / `seeds` / `none`) with
  token-gated membership (no tags, no central node, free join/leave); the smaller ADVERTISE:PORT
  initiates each link; conflict-free roster gossip (per-host slices, tagged by origin); host-to-host
  delivery via the gateway CONNECT-splice; bind/advertise address split. (Also live: reply-cap
  **Decision B** — replies always get through, §5.) *Follow-ups:* direct session pair-dial (vs the
  gateway splice) and cross-host HA re-election.
- **Built (v1.9):** persistence (§12) over a shared-folder `persistence` facet (`none` default /
  `file`), encrypted at rest — **durable mailboxes** (auto-park on delivery; redelivered to a returning
  peer on re-register; cursor-ack drops the durable copy; TTL + per-mailbox caps drop-and-log) and
  **durable responsibilities** (claims durable by default when persistence is on; rehydrated on
  re-register / on connect; `release_topic` drops them; hard-expiry GC; no-clobber on return). Stable
  format-prefixed identity keys with both-form lookup. Opt in with `AI_BRIDGE_PERSISTENCE=file`. Also:
  user identity is taken from the **OS login** (`os.userInfo()`), not a session-declared value, so it
  can't be fabricated. Live-verified by `test_persist_live.mjs` (restart → redelivery / rehydrate).
- **Built (v1.10):**
  - *Per-peer durable keying fix* — persistence keys by `(realm,project,user,name)`; without the name,
    co-user sub-peers shared one mailbox and a sender saw its own send on reconnect (now keyed per peer:
    sub-peers by name, the process by hostname). `test_persist_live` regression.
  - *Offline owners (§16)* — a directed send to a topic whose durable owner is **offline** parks for its
    return instead of bouncing `no-owner`; the owner opts in (`announce_offline`) to having senders told.
  - *Dormant-claim takeover* via the new pluggable **`authorizer`** facet (`none`/`script`/`hello`):
    taking over your **own** dormant topic needs presence confirmation (Windows Hello in prod, script in
    CI); a **different** user may take over only after a grace window and only if allowed —
    per-claim `grace_minutes` + `allow_other_user` over global `claimGraceMinutes` + `allowCrossUserTakeover`.
  - *Durable cross-project grants with TTL (§4)* — `allow_project` survives a restart and may carry a
    TTL (the operator can shorten what a requester asked for); approving a `request_project_access`
    now **notifies the requester** (`project_access_granted`, echoing `request_id` + permitted TTL).
    Persistence facet gains a `grants` store.
  - *Tray* shows the running bridge version.
  - Verified by `test_grants_live` + `test_offline_park_live`; suite 291 across 13.
- **Built (v1.10.x fixes):** back-compat for claim records — skip an unattributable legacy record (no
  user/name) and compare the user **case-insensitively** (`"Robin"` ≡ OS `"robin"`), so a returning owner
  is never locked out of its own dormant topic. The **`hello` authorizer** is now wired to a real
  **`HelloConfirm.exe`** (UserConsentVerifier) and live-verified both ways (approve → takeover, deny → held).
- **Built (v1.11):** *durable registrations (§19)* — `register_self` records a self-describing
  `name → identity` mapping in a new `registrations` persistence store, so a directed send to a peer **by
  name** that is offline / lost on a gateway restart **parks** for its return instead of bouncing
  `unknown-target` (a never-registered name still errors). Parked `.msg` files now store the **recipient
  identity** in-body (not just the hashed key), so the data is attributable/migratable without reversing
  the key. Verified by `test_persist_live` (park-by-name across a restart). Suite 302 across 13.
- **Built (v1.12):** `retain` (§12) — `publish {retain:true}` keeps the **last value per concrete topic**
  in the `retained` store; a new/returning **subscriber is caught up on it immediately on subscribe**
  (wildcard patterns match), last-value-wins, survives a restart, TTL `retainedTtlDays`. This completes
  §12 persistence (mailboxes, claims, grants, registrations, retained all built). Also hardened: a global
  uncaughtException/unhandledRejection net so a stray frame-handler error can't drop the whole gateway.
  Suite 308 across 14.
- **Built (v1.13):** *inbox hint (doorbell-lite)* — every response to a call made by a registered
  sub-peer (`as`/`secret`) carries `inbox: { unread, next_cursor, queue_epoch }`, so a session learns it
  has mail waiting without a dedicated poll (and a returning peer sees its rehydrated count on
  `register_self`). Additive + backward-compatible; un-attributed calls carry no hint.
- **Built (v1.26.0):** *stable peer ids — an id is derived from identity, not from the minting process (#40)* —
  **The problem:** a sub-peer id was `HOST/<session>/<name>-<rand>` with `session = randomBytes(4)` minted at
  process start, so the id embedded *which process hosts me*. Because a bridge is an MCP stdio server its
  lifetime is its CLIENT's, and in agent mode that restarts constantly — so ids rotated **between turns**
  (observed in the field: `virtualguy-16c4 → -c892 → -ce45 → -3581` in ~2 days). Any stored id went stale and
  id-addressed sends bounced `unknown-target`; only name/`topic:` addressing was reliable. **The fix:** the id is
  now `peer:<slug>-<sha256(realm|project|user|name)[0..8]>` — derived from the SAME identity tuple the durable
  layer already keys by, which is why topics and parked mail always rehydrated correctly while the live id did
  not. WHICH process hosts a peer became a **roster lookup** (`rosterSub()`) instead of a substring of the id, so
  a peer can move process — or machine — without changing identity. The `peer:` prefix follows the existing
  `page:` convention, keeping `kindOf()` a prefix test. **Three sites encoded the old assumption**, and only the
  first is obvious: `ownerOf()` (routing), `isLocalSubId()` (which decided local vs network delivery, and whose
  prefix test silently pushed local deliveries onto the wire), and — subtlest — `makeEnvelope()`'s **hop chain**,
  where "don't add myself when delivering to my own sub-peer" was also a prefix test, so a process publishing to
  its own sub-peer added itself to `hops` and its own loop guard then bounced the delivery (caught by
  `test_topics`' wildcard-subscriber check, not by the routing tests). All three now use an ownership test with
  the legacy prefix retained as a fallback, so **old-format ids still resolve** on a new bridge.
  **Rolled out in two phases, because compatibility is one-way** (a 1.26 bridge reads old ids; a pre-1.26 bridge
  cannot parse a `peer:` id — so minting them anywhere requires *every* host to already read them, which would
  otherwise mean a synchronised restart of the whole realm):
  **Phase 1 — the default, and what this version ships:** the bridge READS stable ids but still MINTS the legacy
  process-scoped form. It is therefore compatible in *both* directions and can be rolled out **one host at a
  time, at any pace, with no coordination** — an older bridge never sees an id it cannot parse.
  **Phase 2 — opt in with `AI_BRIDGE_STABLE_IDS=1` / `config.stableIds`:** the bridge MINTS stable ids. Safe once
  every host reads them; that flip needs no coordination either, since a host still minting legacy ids and one
  minting stable ids interoperate freely. `capabilities.stable_ids_read` (always true on 1.26+) vs
  `stable_ids_write` (minting) is the gate: confirm **read** on every host before enabling **write** anywhere.
  Verified by `test_stable_ids_live` (16 checks: both phases' capability bits and minted forms, the id is
  IDENTICAL across a real restart on a new port/session, distinct peers don't collide, legacy ids still route on
  a 1.26 bridge, and — the load-bearing one — a **reader-only bridge resolves and delivers to a `peer:` id it
  would never have minted**, which is what makes the uncoordinated rollout safe). Suite 560 across 24.
- **Built (v1.25.1):** *dashboard: bridge version per computer* — the Computers table gains a **Bridge** column
  next to Connections, showing the `bridge_version` gossiped on that machine's sessions. A machine running
  several bridges lists **every distinct version**, flagged amber (`.mixed`) — version skew on one box, or across
  the mesh, is exactly what explains "why doesn't feature X work over there" (it immediately surfaced that
  `phub-lnx-gold` was on 1.24.17 with no doorbell while the other hosts were on 1.25.0). Dashboard-only; no
  protocol change. Verified by `test_dashboard_multihost` (4 checks: version shown, single-version not flagged,
  a skewed machine lists both, skewed machine flagged).
- **Built (v1.25.0):** *the doorbell — WS `listener` attach point, so an idle session stops polling (#39)* —
  implements the long-reserved T14 `kind:"listener"` half. **The problem:** two AI sessions collaborating each
  polled `inbox` every ~10s, which is a MODEL TURN per poll (~8,600/day/session) almost always returning
  "nothing" — real token cost, no benefit. **The shape:** a listener leaf declares `watch {name?, project?,
  topic?}` and is pushed `{type:"mail", peer, unread_direct, topics{}, total}` the moment the v1.24.17 waiting
  counts go above zero for what it watches; `{type:"gone"}` if the watched name leaves the roster (registrations
  lapse routinely, and a doorbell must not wait forever on a peer that needs re-registering); `{type:"ping"}`
  heartbeats so a watcher blocked for an hour can tell the link is alive. Arming **fires immediately** if mail is
  already waiting — otherwise a doorbell armed after the fact silently misses it. **Deliberately counts-only** —
  no roster (listeners are excluded from the roster fan-out), no traces, no persistence, no sender identities —
  which is why it needs **no per-peer secret**: these are the same integers already gossiped to every dashboard,
  and the realm token already gates the socket. "How to act" needs nothing new either: the woken session polls
  its own inbox over MCP, where behaviour reminders (#29/#32) already ride along on each message. Ships with
  `tools/aimb-doorbell.mjs`, which blocks on the socket and exits with a code that tells the caller its next
  move — `0` mail (JSON summary on stdout) / `2` timeout, re-arm / `3` peer gone, re-register / `4` link lost —
  plus an optional `--status` heartbeat file so liveness is inspectable at zero token cost. Backgrounded, it
  turns ~8,600 wake-ups a day into roughly one per actual message. `capabilities.doorbell` is the feature bit;
  **`wake` stays false** — `set_wake` is still unimplemented and saying otherwise would be a lie to feature
  detection. Verified by `test_doorbell_live` (25 checks: frame shape, counts split, isolation from
  roster/traces/persistence/sender, heartbeat, arm-after-the-fact, gone, watch-required, and the real script's
  exit codes + status file).
- **Built (v1.24.17):** *dashboard: waiting-mail counts next to sessions + topics* — a small `(n)` badge shows
  **uncollected** mail (queue items past the served high-water — what the next poll would return). The counts are
  kept **separate by how each message was addressed** so the UI decides presentation independently: a **session /
  sub-peer** badge counts **direct** sends only (`env.topic` null → `unread_direct` on each roster sub-peer entry);
  a **topic** badge counts sends addressed to **that topic** only (`env.topic` matched against the owner's claim
  pattern → `waiting` on each topic entry). Both are computed in the holder's own process from its live queue (no
  double-count, no cross-host snapshot dependency) and gossip on the existing SUBPEERS/TOPICS frames; a 250ms-
  coalesced `scheduleCounts()` re-gossips on delivery, on poll (served advances → badge drops), and on out-of-band
  rehydrate, so badges update live. Semantics note: the bridge has no *answered* state (verbs are advisory), so
  `(n)` means "waiting to be collected" and clears when the owner polls; purely-offline owners' parked mail remains
  in the Persistence → 📨 Mailboxes / 🪧 Kept views. Dashboard-only render + two additive roster fields; backward-
  compatible (older peers simply omit the fields → badge 0, so a peer on an older bridge never badges at all).
  **Known limitation (accepted):** the two counts are independently *displayed* but not independently *clearable* —
  a peer queue has ONE `served` high-water (and `inbox`'s `cursor` only selects what is RETURNED, never what is
  marked served), so any poll collects everything and both badges drop together. Per-topic acking would need a
  per-topic cursor set or an explicit `ack {envelope_ids|topic}`; the durable mailbox already acks per envelope id,
  so the in-RAM single `served` scalar is the only blocker.
- **Built (v1.24.16):** *mesh map: balance top/bottom margin* — the host boxes started at `boxTops=60` (60px
  of empty space above them) while the viewBox left only `+20` below, so the map looked top-heavy inside its
  panel. Dropped `boxTops` to 20 to match the bottom margin. Nothing draws above `boxTops` (the cross-host edge
  sits at `y1-30 = boxTops+40`, the follower arc peak at `boxTops+16` — both stay inside the box). Cosmetic.
- **Built (v1.24.15):** *dashboard: actually align the Computers column with the Sessions Name column* — the
  v1.24.14 spacer cell alone didn't line up: the Computers and Sessions tables size their columns
  independently, so the leading spacer column came out wider than the Sessions chevron column. Fix: force the
  leading chevron/spacer column of every main table to shrink to its content
  (`table:not(.pers) th:first-child, td:first-child { width:1%; white-space:nowrap }`), so the second column
  (Name / Computer / Time) starts at the same x in all of them. Cosmetic.
- **Built (v1.24.14):** *dashboard: indent the Computers column to align with the Sessions Name column* — a
  leading `.x-chev`-width spacer cell so the Computer name lines up under the Sessions name. Cosmetic.
  (Superseded by v1.24.15 — the spacer alone did not align the independent tables.)
- **Built (v1.24.13):** *dashboard: move Mesh map below Sessions* — section order is now Computers → Sessions →
  Mesh map → Persistence → Traces. Pure markup reorder (sections are keyed by id/data-sec, no logic change).
- **Built (v1.24.12):** *dashboard "Computers" section + Mesh map collapsed by default* — a new **Computers**
  expander (open by default, top of the page) lists one row per machine on the mesh — this machine first, the
  local one flagged "this machine", the tailnet advertise address for remotes, and per-machine session +
  connection counts. The **Mesh map** now starts **collapsed** (per-section defaults via a `DEFAULT_COLLAPSED`
  map in `wireSections`; a user's saved preference still wins). Verified by `test_dashboard` (five sections) and
  `test_dashboard_multihost` (a row per machine, this-machine flag, remote address; map collapsed / Computers
  open by default). Suite 514 across 22.
- **Built (v1.24.11):** *dashboard Sessions default grouping is now "project"* — the connections view opens
  grouped by project (was PC); PC/user/none remain selectable and a chosen value still persists. Verified by
  `test_dashboard_multihost` (default render shows 📁 project headers, no 🖥 PC headers). Suite 509 across 22.
- **Built (v1.24.10):** *dashboard Sessions grouping adds "project"* — the `group by` dropdown now offers
  **PC / project / user / none**. Project (and user) keys are case-insensitive (compare lower / display Title)
  with a first-seen label, so case-variants (e.g. `CamelCo`+`camelco`) collapse into one group whose header keeps
  the declared case. Verified by `test_dashboard_multihost` (a header per project; case-variant projects merge).
  Suite 508 across 22.
- **Built (v1.24.9):** *fix: group-by-user keyed on case-sensitive user → duplicate "Robin" groups* — the
  grouping key used the raw user string, so `robin` (sub-peers) and `Robin` (pages) fell into two groups that
  both *displayed* as "Robin". Per the standing rule (compare lower / display Title), the user key is now
  lower-cased so case-variants collapse into one group (header still Title-cased). PC keys stay as-is —
  hostnames are case-stable and the `m.hosts[k]` alias lookup needs the original case. Verified by
  `test_dashboard_multihost` (`robin` + `Robin` → one group). Suite 506 across 22.
- **Built (v1.24.8):** *dashboard Sessions grouping dropdown (PC / user / none)* — a `group by` select in the
  Sessions header groups the **connections** view (show-bridges off) by **PC** (machine, default), **user** (the
  human), or **none** (one flat list). Within every group the code → cowork → browser order holds; PC groups
  put this machine first, user groups sort A→Z. Grouping only applies to the connections view — when "show
  bridges" is on the nested process view is inherently per‑PC, so the dropdown is **disabled** and grouping is
  forced to PC. Persisted in `localStorage`; clicks don't toggle the section collapse. Verified by
  `test_dashboard_multihost` (group‑by‑user makes a header per human, not per PC, and places each connection
  under its user). Suite 505 across 22.
- **Built (v1.24.7):** *connections-only view orders code → cowork → browser* — the "show bridges"-off view
  now groups the flattened connections in a fixed order (**code**, then **cowork**, then **browser** pages;
  other kinds fall just before browser), stable within each group. Verified by `test_dashboard_multihost`
  (cowork registered before code, sort reorders them). Suite 503 across 22.
- **Built (v1.24.6):** *dashboard Sessions "show bridges" toggle (default off)* — a checkbox in the Sessions
  header, **unchecked by default**, controls whether the infrastructure **bridge processes** (gateway / host /
  tray — the no-project session rows) are shown. Off (default): a **connections-only** view — just the
  participants that ride the bridges (browser = pages, code + cowork = sub-peers, plus any project-bearing
  code/cowork session), flattened under each machine. On: the current full nested view (bridge rows + their
  leaves). Display-only, persisted in `localStorage`; the click doesn't toggle the section collapse; the Mesh
  map is unaffected. Verified by `test_dashboard`/`test_dashboard_multihost` (default hides GATEWAY/bridge rows
  but keeps sub-peers; toggling on restores the full view). Suite 502 across 22.
- **Built (v1.24.5):** *lost-secret rejections hint at recover_secret (§21)* — when a session loses its bearer
  secret (e.g. a compaction drops it) and its live sub-peer still holds the name, `register_self` with the wrong
  secret returns `name-taken` and a tool call with a wrong `as`/`secret` returns `bad-secret` — dead ends unless
  the caller knows about recovery. Now, **when the vault is on**, both responses carry `recoverable: true` and a
  `hint` naming `recover_secret { name, project }` (a presence check returns the original sealed secret, then
  retry). Gated on the vault being present so the hint is never shown when recovery is impossible; the
  create-path (expired peer) still rehydrates by identity, so only these two live-peer rejections needed it.
  Verified by `test_vault_live` (hint on `name-taken` + `bad-secret` with a vault; absent with vault `none`).
  Suite 501 across 22.
- **Built (v1.24.4):** *dashboard "streaming" → "push", shown only when push is genuinely live* — the
  sub-peer badge read `· streaming` whenever `mode==='push'`, but a Code session is marked push by a
  **code-name heuristic** even when its MCP client never declared the `claude/channel` capability — i.e. it
  isn't actually receiving channel pushes (that's the still-pending #2, gated behind a dev flag). Showing
  "streaming" there over-claimed an unimplemented capability. Fix: renamed the badge to **`· push`** and gate it
  on **real channel capability** — `announceSubpeers` now attaches `channel_capable` (the hosting process's
  `CLIENT.channel_capable`) to each gossiped sub-peer, and the dashboard/map render `· push` only when
  `channel_capable && mode==='push'`. The optimistic push *mode* + `detected_mode` heuristic (and its
  `test_subpeers` contract) are unchanged — this is purely honest **display**. Verified by
  `test_dashboard_multihost` (a channel-capable push sub-peer shows `· push`, no `streaming`). Suite 498 across 22.
- **Built (v1.24.3):** *display-case rule for the dashboard + page widget (#38)* — the standing case rule is
  **compare lower-case, display Title**: upper-case the first letter of every word (start, or after a
  non-alphanumeric separator like `/` `-` space), keeping any **existing** upper-case; digits don't start a word.
  `online-tool/analysis` → `Online-Tool/Analysis`; `OnlineTool/Analysis` stays; `2degrees` stays; and the same
  human shown as both `robin` and `Robin` now both render `Robin`. Applied via pure display helpers (`tc` for
  topics/projects/users, `nm` for names — `nm` leaves a bare hex slug, an unnamed session's id, untouched) to
  the Sessions table, persistence tables, the SVG map, and traces in `dashboard.html`, and to the option/pip
  text in `tools/aimb-bridge-ui.js`. **Display-only** — storage, routing, option `value`/`dataset.name`, and the
  (already case-insensitive, #37) matching are unchanged. Verified by `test_dashboard_persistence`
  (`builds`→`Builds`, `alerts/#`→`Alerts/#`, `online-tool/analysis`→`Online-Tool/Analysis`) and `test_page_e2e`
  (display Title-cased while `value` stays raw). Suite 497 across 22.
- **Built (v1.24.2):** *fix: page UI matched a target by exact case (#37)* — the bridge-UI widget
  (`tools/aimb-bridge-ui.js`) matched its persisted target against live options with `name === want`
  (case‑sensitive). A page whose target was e.g. `Bills` never matched the live `bills` topic, so the widget
  showed a dangling `Bills — offline` entry beside the online `bills — Topic ×1`. Fix: compare
  case‑INSENSITIVELY and snap the selection to the live entry's **canonical case** once matched — the standing
  rule is *compare lowercase, display original case*. Verified by `test_page_e2e` (a fresh page with a
  mixed‑case `?session` selects the live topic, no offline dangler, display stays canonical). Suite 496 across 22.
- **Built (v1.24.1):** *rehydrate launcher-stripped env so `${env:…}` secret refs resolve (#36 follow-up)* —
  some MCP hosts (Claude Desktop among them) spawn a server with a **curated, minimal environment**: arbitrary
  user variables aren't forwarded unless named in the server's `env` block. That silently broke egress‑auth
  `${env:VAR}` references — the credential is set in the user environment and present in every *normal* process,
  but absent from the bridge's `process.env`, so a mint fails with `secret-unresolved` (no amount of rebooting
  helps, because it's the launcher, not the logon, that strips it). Fix (`lib/win-env.js`): on Windows the
  bridge reads the **live registry** (`HKCU\Environment`, then the HKLM system environment) at startup and fills
  in any variable **missing** from `process.env` — never overriding what the launcher provided (`PATH` etc.
  stay as given). The secret stays exactly where the operator set it (no new files, no plaintext in any launcher
  config, no config‑reference change); `${env:VAR}` "just works." No‑op off Windows; best‑effort (never throws).
  Verified by `test_lib_unit` (`parseRegQuery`: REG_SZ / REG_EXPAND_SZ / header‑line skip) plus a live
  strip‑then‑rehydrate‑then‑mint check. Suite 493 across 22.
- **Built (v1.24.0):** *egress server-side auth token sources (#36)* — extends #33 so an egress backend can
  declare `auth`: the bridge **mints, caches, refreshes, and injects** a bearer token, and the caller never
  supplies, sees, or can override the credential or the token ("approach A"). `auth.source.type` is pluggable —
  **`static`** (the token *is* a resolved secret) or **`http`** (mint via a request: `url`/`method`/`json`|`body`,
  read the token at `tokenPath`, TTL from `expiryPath` seconds or `ttlSec`; re-mint on expiry and, unless
  `refreshOn401:false`, on a 401 from the backend). Mints are **single-flighted** and cached with a refresh
  skew; the injected header is stripped from any caller-supplied headers first; the token/credential are
  **never logged, traced, or returned**. Secrets in the config are **references, not literals**: a new pluggable
  resolver (`lib/secret-resolver.js`) expands `${env:VAR}` from the bridge's environment today, with
  `${vault:…}`/`${service:…}` as explicit seams (an unwired scheme throws). This is a deliberate perspective
  call: an env var is **not** hidden from a local shell-capable process running as the same user — it prevents
  the *durable / off-machine* leaks (repo, Dropbox-synced `config.json`, transcripts, other-project callers) and
  lets a stronger boundary (TPM vault #21, or an out-of-process/other-user minter #24) drop in later **without a
  schema change**. Token logic lives in `lib/egress-auth.js`; `services/egress.js` builds one provider per
  auth-declaring backend. Verified by `test_lib_unit` (secret-resolver: env/embedded/deep/missing/unwired-scheme;
  egress auth: mint+inject, credential-into-mint-only, token-absent-from-response, caching, caller-can't-override,
  401→re-mint→retry, expiry re-mint, mint-failure→structured error, static source). Suite 490 across 22.
- **Built (v1.23.2):** *fix: cross-host mesh splits when a hub starts before Tailscale is ready (#35)* — the
  advertise host (the one per-machine value that can't live in a shared config) auto-derives from the discovery
  backend (`tailscale status` Self). It was derived **once, at gateway startup**; a hub that started before
  Tailscale had assigned this node its tailnet IP saw a *partial* status (Self has `HostName` but no
  `TailscaleIPs`/`DNSName`), and `hostOf()` fell back to the bare hostname (e.g. `ROBIN-Z790`). That value never
  corrected. Because the deterministic dial tie-break is *only the lexicographically smaller `ADVERTISE:PORT`
  dials*, a hostname (`'R'`=0x52) sorts **above** every peer IP (`'1'`=0x31), so the hub decided it should never
  dial out; IP-addressed peers, comparing IP-vs-IP, also declined — split brain, no link forms, silently.
  Symptom: worked on first boot (Tailscale up), dead after any restart that beat Tailscale's readiness. Fix,
  three parts: (1) `hostOf()` returns **only tailnet-routable** forms (WireGuard IP or MagicDNS FQDN), never the
  bare `HostName`, so a partial status yields `null`; (2) advertise derivation is **retried every
  `discoveryTick`** (not one-shot) until a routable address is in hand; (3) `discoveryTick` **refuses to run the
  dial tie-break** while the advertise host is still un-derived (loopback/hostname). Backends without a
  `selfHost` (seeds/none) and operator-pinned/bind-IP advertise addresses are treated as ready immediately, so
  the federation/multihost paths are unchanged. Verified by `test_lib_unit` (`hostOf`: IP-preferred, MagicDNS
  fallback, partial-status→null) + the unchanged cross-host `test_federation`/`test_dashboard_multihost`. Suite
  475 across 22.
- **Built (v1.23.1):** *fix: durable mail redelivered on every re-register (#34)* — the inbox poll acked a
  message's durable copy only once the cursor moved **past** it (`q.items.slice(0, start)` — the messages
  *before* the cursor), i.e. lazily on the *next* poll. On a fresh register the queue restarts at base 0, so the
  first poll (cursor 0) had `start = 0` and acked **nothing**, even though it *returned* the mail. A session that
  read-then-reattached — or re-registered after a bridge restart (new session id ⇒ fresh queue ⇒ re-drain of the
  durable mailbox) — re-surfaced the same already-read messages every time. Fix: ack **on serve** — the poll now
  drops the durable copy of the messages it is **returning now** (`q.items.slice(start)`), so each parked message
  is acked exactly when first delivered and a later re-register won't re-pull it. The park guarantee is
  preserved: a message stays durable until actually read (served in a poll). Residual (noted, not fixed): a
  pure push-only client that **never** polls won't ack its live-delivered durable copies — most clients poll via
  the inbox hint, so this is rare. Verified by `test_parked_live` (new assertion: the durable mailbox is empty
  the instant after a cursor-0 serve — fails on the old deferred-ack code). Suite 471 across 22.
- **Built (v1.23):** *services layer + HTTP egress (#33; see docs/web-edge-node.md)* — introduces an opt-in
  **services** layer: in-process capability modules in `src/services/`, loaded only when configured
  (`config.services.<name>`), each contributing MCP tools (merged into `tools/list`, routed to its `handle()`)
  and live-reloadable. A capability that isn't opened has **no surface**. First inhabitant: **egress** — an
  **`http_request`** tool letting a session GET/POST to **operator-declared backends only** (no arbitrary
  URLs), so cowork/sandboxed sessions can reach a local dev API (e.g. a GCloud emulator). Safety: a backend
  declares `base`, allowed `methods`, a **required `projects` allowlist** (no `*`), `allowHeaders` (caller-
  settable request headers), `headers` (injected **server-side**, e.g. auth — never echoed), `timeoutMs`,
  `maxResponseBytes`, `followRedirects`. The **core SSRF defense**: the final URL is built from `base + path`
  and its **origin must equal the backend's** (`new URL(...).origin` check) — `//host`, absolute URLs, and
  `..` escapes are rejected, so a session can't reach the metadata endpoint or any other local port. Runs in
  the bridge process the caller is attached to (no port); env `AI_BRIDGE_EGRESS_BACKENDS` overrides for
  automation. This is step 1 of the **web-edge-node** roadmap (the static file server #30 becomes the first
  out-of-process brick later). Verified by `test_lib_unit` (13: backend/project/method gates, origin
  containment, header filter + server-side inject, base64) + a live `test_http_egress_live` (real MCP → bridge
  → echo server). Suite 470 across 22.
- **Built (v1.22):** *config-level default behaviour reminder (#32)* — extends #29 with a bridge-wide DEFAULT
  reminder set in **`config.behaviors.default`** (a string = an `all`-scope default; or an array of
  `{scope,match,behavior}`). It's attached to **every** session's delivered messages — even one that never
  called `set_behavior` — **tagged `default:true`**, so an operator can make all sessions e.g. *"Summarize but
  don't act without user permission"* by default. A session's OWN reminder for the same `scope`+`match`
  **overrides** the default (the default then doesn't fire). Runtime-only (not persisted; config is the source
  of truth) and **live-reloadable** via the ConfigSource watch; `register_self` advertises the active defaults
  as `default_behaviors`. Env `AI_BRIDGE_DEFAULT_BEHAVIOR` adds/overrides an `all`-scope default (used by the
  test). Lives in `lib/reminders.js` (`setDefaults`/`defaultList`, deduped by scope+match). Verified by
  `test_lib_unit` (fires for a session with none of its own, override, self-skip, dedupe) + a live
  `test_default_behavior_live`. Suite 448 across 21.
- **Built (v1.21):** *per-session behaviour reminders (#29)* — a session registers short 'how to behave when a
  message arrives' prompts scoped to a **topic** it owns / a **host** / a **project** / a **subscription**
  pattern / **all**, via `set_behavior {scope, match, behavior}` (+ `list_behaviors` / `clear_behavior`). The
  bridge attaches the matching reminder(s) to each delivered message — in the push channel meta AND in inbox
  items — as `reminders: [{scope, match, behavior}]`. A message can satisfy several scopes, so it returns a
  LIST, ordered **most-specific first** (topic > subscription > project > host > all); `all` skips self/system
  messages. Caps: ≤280 chars, ≤64 per session. Durable per-identity (new `behaviors` store + `none` stub),
  rehydrated on `register_self` (the resync now also returns `behaviors`). **Topic-scoped reminders ride along
  a kept-alive handoff (#26):** on a `keep_alive` release the topic's reminders are stashed in the kept marker
  and the next claimant inherits them. Dashboard shows a 🧭 *Behaviours* store. Verified by
  `test_behaviors_live` (14 checks: all five scopes, ordering, validation, resync, cross-handoff inheritance).
  Suite 392 across 19.
- **Built (v1.20):** *keep-alive topics — park directed sends through an ownerless handoff (#26)* — by default a
  released topic is gone and directed sends bounce `no-owner`. Now **`release_topic {keep_alive:true}`** (or a
  topic **claimed `keep_alive`**) keeps it alive as a durable **ownerless** marker: directed sends PARK against
  the topic itself (a synthetic topic-mailbox, consent-checked against the topic's project) and the **next
  session that claims it drains the queue** + inherits the kept description/icon. A **safety TTL**
  (`limits.ownerlessTtlMs`, default 7d, via `ownerlessTtlDays`) sweeps abandoned ownerless topics + their parked
  mail in the GC tick. New persistence store `keptTopics` (+ `none` stub); `claim_topic`/`release_topic` take a
  `keep_alive` flag; dashboard shows a 🪧 *Kept-alive* store. Surfaced a latent fix on the way: `persistClaim`
  was fire-and-forget, so a claim→release in quick succession could leave a stale durable claim — `claim_topic`
  now **awaits** the durable write. Verified by `test_keepalive_live` (10 checks: park, drain-on-reclaim,
  release-flag vs claim-time, no-owner preserved) + `test_persistence` keptTopics TTL GC. Suite 378 across 18.
- **Built (v1.19):** *first-class cross-project topic send + clearer codes (#27/#28)* — a **bare** `topic:<t>`
  send still resolves in the sender's own project, but when there is **no owner there** it now resolves
  **realm-wide**: if exactly one **grant-reachable** other project owns the topic, the send **auto-routes**
  there (consent-checked at delivery via `mayInitiate`) and the result carries `cross_project:<project>` —
  so reaching a foreign-project owner no longer requires the throwaway-peer workaround (register in the
  target project, send, deregister). When the owner's project is **not** grant-reachable, the code is now
  **`cross-project-no-grant`** (with `owner_projects` + a hint to `request_project_access` or use
  `@<project>/`); when several reachable projects own it, **`cross-project-ambiguous`**. So `no-owner` stops
  doubling as "owned in another project" and only means *genuinely ownerless*. Explicit
  `topic:@<project>/<t>` is unchanged (respected as-is, no fallback). Verified by `test_consent` §7b
  (auto-route with grant, distinct codes without, no-owner preserved). Suite 364 across 17.
- **Built (v1.18.1):** *mailbox filename fix* — the envelope id already carries the `env_` prefix
  (`envelopeId()` → `env_<hash>`), but the mailbox `put`/`ack` template prepended another, producing
  `env_env_<hash>.msg` on disk. Now the file is just `<envId>.msg`. `ack` tries both the new and the legacy
  double-prefixed name, so files written before the fix still drain and get cleaned (no migration needed).
- **Built (v1.18):** *parked mail surfaces on poll + reattach (§23)* — fixed a real gap: a message written to
  a peer's **durable mailbox while that peer is already LIVE** (parked out-of-band by another federated
  process, or while the peer was momentarily treated as offline) only surfaced on a **fresh `register_self`**;
  a plain `inbox` poll or a reattach served the in-RAM queue and never re-read the durable store, so the
  message stranded until the in-RAM entry expired. `inbox` (and the reattach branch) now call
  **`syncDurableMailbox`** — drain the durable mailbox and push any envelope ids **not already queued** into
  the queue (dedup by id, so normally live-delivered mail is never doubled). Live delivery is unchanged.
  Regression test `test_parked_live` (7 checks) parks straight into the persist dir via the facet to simulate
  another process and asserts a plain poll + a reattach both surface it exactly once; verified to FAIL with the
  fix neutered. Suite 355 across 17.
- **Built (v1.17):** *case-insensitive names & topics* — every **name** (peer/sub-peer) and **topic** is
  now **presented in its original case but stored and compared lower-case**, so all checks are
  case-insensitive: `register_self`/`send_to_peer`/`inbox` match `"Bolletta"` ≡ `"bolletta"`, and the
  persistence keys (identity tuple, claim/retained/subscription paths) canonicalise to lower-case so a
  case variant never splits a mailbox/claim/vault. Display strings keep their original case (record bodies
  store the as-typed `name`/`pattern`/`holder_name`). Topics were already level-wise case-folded
  (`splitTopic`); this extends the same rule to names and the on-disk keys. Existing mixed-case persistence
  files written before v1.17 self-heal as owners re-assert (re-persisted under the lower-case key) — but
  **parked mail** under the old mixed-case keys would strand, so an upgrade ships with a one-shot
  migration: **`scripts/migrate-persistence-lowercase.mjs <dir>`** re-keys every mailbox/claim/registration
  /subscription/vault entry (and lower-cases retained paths) using the facet's own `identityKeys`/`lslug`
  (no drift), then reads everything back through the facet to verify. Dry-run by default; `--apply` only
  with the bridge **stopped**; idempotent and FS-case-aware (on case-insensitive NTFS the identity hashes
  are still re-keyed; dir casing is cosmetic). Run order for a 1.15→1.17 upgrade: stop bridge → dry-run →
  `--apply` → restart.
  The **dashboard** reflects the rule with a header note ("shown as entered; matching is case-insensitive")
  and also fixes an expander bug: a roster/persistence push rebuilds the tables (`innerHTML=''`), which used
  to snap any open inner expander (a mailbox, a session) shut a moment later — open state is now kept in an
  in-memory `openRows` map keyed by a stable id (`sess/`, `sp/`, `page/`, `pers/`) and restored after each
  rebuild. Verified by new case-insensitivity checks in `test_subpeers` + `test_persistence` and an
  expander-survives-rerender check in `test_dashboard_persistence`. Suite 348 across 16.
- **Built (v1.16):** *secret recovery (Hello-vault, §21)* — the bridge **seals** a session's secret at
  registration (encrypt-to-the-user) into a `vault` persistence store; a session that lost it (a compact
  throws away the bearer secret) calls **`recover_secret {name}`** and gets the original back after a
  **presence check** — only the real human at their own machine can unseal it, and the secret was never
  re-sent until then. New pluggable **`vault` facet**: `none` (off) / `script` (reversible, headless tests)
  / `tpm` (RSA-OAEP to the Windows TPM key + a Windows Hello unseal, via Tpm.exe — proven in
  experiments/hello-tpm-vault). Also: reattach now resyncs (topics/access) like a fresh register. The
  tpm helper + multi-machine envelope (seal to each of the user's machines) are the live-verify follow-ups.
- **Built (v1.15):** *dashboard persistence view* — the gateway pushes a read-only `snapshot()` of all six
  durable stores to the dashboard (self-describing records → real identities, not hashes), rendered as a
  Persistence section: count chips + a per-store expander (mailboxes/claims/grants/registrations/
  subscriptions/retained). A profile line shows version + facets + capabilities. Live-refreshed while a
  dashboard watches.
- **Built (v1.14):** *session resync (stateful bridge, stateless session)* — `register_self` now returns
  `topics` (the identity's owned **and subscribed** topics, rehydrated from durable state) + `access` (the
  projects it may reach) + the inbox hint, so a reconnecting/compacted session relearns its responsibilities
  in one call, no re-claim/re-subscribe. Backing this: **durable subscriptions** (a 6th persistence store;
  default-on `persistSubscriptions`, opt-out) that rehydrate like owned claims. Additive + backward-compatible.
- **Built (v1.26.1):** *facet capability probe — stop advertising what the host can't do (#41 FIXED)* — a
  bridge reported `profile.vault = "tpm"` because that is what it was *configured* with, whether or not the
  platform could back it, so a peer concluded secret recovery was available and `recover_secret` only failed at
  the moment of need. Fixed by separating the two ideas along the seam the codebase already had:
  **`profile.names` = intent** (what the operator asked for, unchanged), **`capabilities` = verified truth**.
  Facet impls may now export **`probe() -> {ok, reason}`** (absent ⇒ assumed backed, so every other facet is
  untouched); the bridge probes `vault` + `authorizer` shortly after startup, sets the new
  **`capabilities.recover_secret`** / **`presence_confirm`**, and re-broadcasts so the roster carries the honest
  answer. Both bits start **false** and are raised only on a successful probe — never claim an unverified
  capability. Configured-but-unbacked also logs a startup **WARN**, and the dashboard profile line flags the
  facet **⚠ unavailable**. The `tpm` probe deliberately *exercises* the TPM (asks for the public key) rather
  than checking the helper exists, because the field case had `Tpm.exe` present and no TPM at all; the `hello`
  probe checks platform + helper only, since enrolment cannot be tested without raising a prompt — a documented
  limit, and `confirm()` still fails closed. Neither probe calls `ensureExe()`, which would try to *build* a
  helper during startup. Verified by `test_facet_probe_live` (11 checks incl. the field case reproduced
  portably: configured `tpm`/`hello` with absent helpers ⇒ `profile` still reports the intent while the
  capability bits are false, `recover_secret` still fails closed, and the honest bits are gossiped on the
  roster). Suite 571 across 25. *Also hardened on the way:* `AI_BRIDGE_STABLE_IDS` now wins **both** ways
  (`'0'` forces off), and three suites stopped asserting a peer-id *shape* — the id form is owned by
  `test_stable_ids_live`, which pins the mode explicitly, so the suite no longer depends on the operator's
  `config.json`. (Caught because enabling phase 2 on the dev box made the suite fail.)
- **Superseded — was open (#41): `profile` advertises INTENT, not CAPABILITY.** A bridge reports
  `profile.vault = "tpm"` / `profile.authorizer = "hello"` because that is what it is *configured* with, whether
  or not the platform can actually back it. Found in the field on a box where `Win32_Tpm` returns **no instance
  at all** (AMD fTPM disabled in firmware; Windows 11 installed with the TPM requirement bypassed): the roster
  advertised `vault: "tpm"`, so a peer would reasonably conclude secret recovery was available — and
  `recover_secret` then failed `recovery-denied / tpm-unavailable` at the *exact moment* a compacted session
  needed it, which is the worst possible time to discover it. The facets are otherwise a clean seam; this is a
  reporting flaw, not a facet flaw. **Fix:** probe each facet at startup and degrade the REPORTED profile to
  `none` when the platform cannot back it (and surface the degradation on the dashboard), so feature detection
  tells the truth. Until then, the honest fallback when a vault is unavailable is the session transcript — see
  `docs/linux-setup.md` §2. NB on the host-side remedy: enabling fTPM where **no** TPM currently exists cannot
  invalidate anything (nothing is sealed yet) — the hazard is **downstream**. On a machine signed in with a
  Microsoft account, a newly-present TPM can cause Windows to enable Device Encryption, and it is a *later*
  firmware change that then strands the disk behind a recovery key. So it stays an operator decision (know the
  account type and hold the recovery key), but for the right reason.
- **Built (v1.26.2):** *durable + non-public reply-cap keys (#43)* — the CapSigner mixes in **no** entropy of
  its own (`deriveKey = HKDF(input, salt='aimb-reply-cap')`), so the input alone decides a cap key's stability
  AND its secrecy. Two problems followed, and only the first was the one being hunted. **(1) Not durable:**
  a process key came from the random per-process `SESSION`, so it rotated on every restart — silently breaking
  Decision B's promise that a valid reply-cap *always* gets through. Since a bridge's lifetime is its MCP
  client's, that window was far shorter than the design assumed. **(2) Publicly derivable:** `SESSION` and a
  page `instance` are **published** (`list_sessions` returns every session id; envelopes carry `from.session`;
  the roster carries page instances), so anyone able to read the roster could recompute the key and mint a
  valid cap — and a valid cap is an *independent allow* OR'd after the consent check, so that bypassed
  cross-project isolation. Fixed by deriving the process key from the process **identity** (stable across a
  restart) mixed with the realm **token**, and the page key from the token + instance (still per-instance —
  a browser tab genuinely is ephemeral — but no longer computable from the published id). Sub-peer keys were
  always fine: they derive from the peer's own self-invented secret, which is both unguessable and stable.
  Inputs live in `lib/capkeys.js` so the properties are unit-testable (7 checks: deterministic, no random
  component, token-gated, identity-separating, case-insensitive, page rotation, page token-gating).
  **Honest scope:** this raises the bar from *anyone who can read the roster* to *a realm member* — it is
  defence in depth, NOT a defence against a hostile realm member, because the realm is one trust domain by
  design (members already share the token-derived body-encryption key). **Coverage gap:** the cross-restart
  durability is now proven END-TO-END by `test_capkey_restart_live` (v1.26.3): a cross-project thread is
  opened under a one-way grant, the bridge is RESTARTED as a genuinely new process, and the reply carrying
  the pre-restart cap is still accepted and delivered — with a negative control asserting a fresh
  (non-reply) send in the same direction is refused, so the cap is demonstrably the only thing letting it
  through. The test was verified to FAIL against the pre-#43 derivation (`project-denied`), so it is a real
  regression guard rather than a tautology. Suite 587 across 26.
- **Built (v1.47.0):** *realm-wide default reminders replicate mesh-wide (#66b).* **What was wrong:** default
  reminders (`config.behaviors.default`) are per config FILE — ROBIN and LITTLE share the Dropbox config, the Mac and
  phub-lnx-01 each have their own — so a default added once (v1.43's doorbell connect reminder) reached only hosts
  whose config was hand-edited. **Config:** a new `behaviors.realm` block, `{ "updated_at": "<ISO>", "default": [
  {operation, scope, match, behavior}, … ] }`, in ANY one host's config. `default` has the `behaviors.default` shape
  and the SAME validation (`normDefaults`, now exported from `lib/reminders.js`: an unknown op → `receive`, an unknown
  scope → `all`, 365-char cap, dedupe by key; a string = one all-scope receive default; at most 64 entries).
  `updated_at` is EXPLICIT, never the file mtime, so an unrelated edit to another host's config can't win; a block
  without a valid `updated_at` is ignored with a log line. **Design:** new `lib/realm-defaults.js` holds ONE
  replicated last-writer-wins record for the whole realm, `{ updated_at (ms), default:[…], origin }` (`origin` = the
  publishing host's name, stable across restarts). `beatsRealm`: greater `updated_at` wins; on a tie the greater
  canonical JSON of the (sorted) list, then the greater origin — a total order, so merge is idempotent + commutative.
  Unlike #62 there is no local stamp bump: the operator's timestamp IS the order, so an older block in a host's own
  config never overrides a newer one it learned. A newer block replaces the WHOLE list (one record, not per entry); to
  clear, publish a newer block with `"default": []`; deleting the block retracts nothing. bridge.mjs only calls
  `merge()`/`current()`/`rehydrate()`; `onChange` hands the winner's list to `reminders.setRealmDefaults()`.
  **Spreading:** each bridge seeds its candidate from its own config at start and on every live-reload
  (`seedRealmDefaults`); a win on a gateway → `broadcastRoster`, on a follower → a new follower→gateway frame
  `REALM_DEFAULTS {session, realm_defaults}` (also sent on every (re)connect after `REGISTER`/`GRANTS`; accepted only
  after `HELLO`). The winner rides `PEER_ROSTER.realm_defaults` (included in the `gossipToPeers` dedupe signature, so
  a change goes at once, and in the #63 refresh as anti-entropy) and `ROSTER.realm_defaults` to followers, which
  merge it (a follower computes its own sub-peers' reminders). `mergeRemoteRoster` merges it BEFORE the #63
  unchanged-slice early return, exactly as grants do; a change re-broadcasts, and an idempotent merge ends the loop.
  **Persistence:** when on, every process writes the winner to a new `realmDefaults` store (`realm/<host>.rdef`, one
  file per writing host, so a shared store never has two machines on one file) and `rehydrate()` takes the LWW winner
  of all copies at startup, so a restarted host keeps the latest even if it can reach no one. **Precedence
  (effective defaults, `effectiveDefaults(local, realm)`):** the host's own `behaviors.default` entries, plus every
  realm entry whose `(operation, scope, match)` key no local entry has — a LOCAL entry wins its key, the realm fills
  the gaps; a session's own `set_behavior` reminder still beats both. Realm-sourced reminders carry `default:true,
  realm:true`; `register_self`'s `default_behaviors` is the effective set; #67 placeholder expansion applies (it runs
  on the emitting host, so each host hands out its own doorbell path). **Config path override:** new env
  `AI_BRIDGE_CONFIG=<path>` (absolute, cwd-relative, `~` expands) replaces `config.json` beside `bridge.mjs` for the
  startup read, the live-reload watch (`facets/config/file.js` via `ctx.CONFIG_FILE`) and the alias write-back — a
  general feature (several bridges from one checkout; config outside the code folder) that the live test needs.
  **`config.example.json`:** the doorbell connect reminder (`connect`/`client`/`code`) MOVED from
  `behaviors.default` into `behaviors.realm.default` (it is a realm-wide convention, the motivating case). The
  receive/send presentation conventions stay LOCAL: they work on every bridge version with no federation (realm
  defaults need 1.47+ everywhere), and a host can restyle them without a realm-wide timestamp race.
  `_comment_behaviors` documents the block. **Mixed versions:** ≤1.46 bridges ignore `realm_defaults` and the
  `REALM_DEFAULTS` frame, so realm defaults spread only among 1.47+ hosts (and followers of a 1.47+ gateway); a ≤1.46
  host keeps using only its own `behaviors.default` (and ignores a `behaviors.realm` block in its config).
  **Trust:** any realm member can publish realm defaults — the same trust level as the #62 grant gossip (the realm
  token is the membership gate); a far-future `updated_at` would win until beaten by a later one. **Tests:** 29 new
  unit checks in `test_lib_unit` (newer wins, older ignored, ISO == ms, idempotent, tie rules both orders, commutative
  across permutations, canonical order, shared validation, caps, junk input, config parse, persist/notify only on a
  win, rehydrate picks the newest; effective-defaults precedence incl. local-beats-realm, realm fills gaps, own beats
  both, empty realm list). New `test_realm_defaults_live` (20 checks): gateways on 127.0.0.1/127.0.0.2 plus a
  FOLLOWER on A, each on its own temp config via `AI_BRIDGE_CONFIG`, 60s refresh so propagation must be prompt:
  (1) B's realm connect reminder reaches a code sub-peer on A's follower with `{doorbell_cmd}`/`{name}` expanded to
  A's paths, tagged `realm:true`; (2) B raises `updated_at` (live-reload) → A's follower + gateway show the new text;
  (3) an OLDER block in A's own configs overrides nothing, on A or B; (4) a local `behaviors.default` entry with the
  same key wins on A's follower while the realm still fills other keys and B is unaffected; (5) a newer block in the
  FOLLOWER's own config goes up (`REALM_DEFAULTS`) and out to B, replacing the whole record; (6) with file persistence,
  A (gateway + follower) restarted with B down and no realm block left still has it. Against the pre-change bridge
  (`AIMB_TEST_BRIDGE`) 18 of 20 FAIL (only the harness check and one negative pass). Suite 802 across 37.
- **Built (v1.46.0):** *removed the dual-port compat capability — the realm port migration is complete (#59,
  closes #56).* The transitional #57 machinery (v1.37.0 bind/election + v1.38.0 cross-host dial fallback) existed
  only to carry the realm from 7000/7001 to 12317/12318 without a coordinated restart. Every online host (ROBIN-Z790,
  LITTLE-001, Robins-Mac, phub-lnx-01 — the last migrated 2026-09-30 on v1.44.0) now runs on 12317/12318, and
  phub-lnx-02 is retired, so the window is closed. **Removed:** the `COMPAT_PORTS`/`COMPAT_WS_PORTS` constants and
  their `compatPorts`/`compatWsPorts` config + `AI_BRIDGE_COMPAT_PORTS`/`AI_BRIDGE_COMPAT_WS_PORTS` env reads; the
  multi-port `bindPorts` loop and `becomeFollower(gwPort)` parameter (election is back to *bind `PORT`; on
  `EADDRINUSE` follow the gateway on `PORT`*); the per-compat-ws-port WS ingress (one `startWsIngress(WS_PORT)`); and
  the port-fallback loop in `connectToPeer` (back to ONE dial on the candidate's port, freeing the address on close so
  a later discovery tick retries). The `onControlConn`/`onWsConnection`/`startWsIngress` handler extraction is kept.
  Untouched: all #63 self-healing in `connectToPeer`/`adoptPeer`/the heartbeat (including the same-host
  different-port restart probe — a host can still restart on another port), the #62 grants frames and the #61 CLOSE
  behaviour. `tailscale.js` still hands each candidate the DIALER's own port, which is correct again: **the realm must
  share one control port**, and a host still on 7000 can no longer federate. Live configs (e.g. the shared Dropbox
  `config.json`) may still carry `compatPorts`/`compatWsPorts`; those keys are now simply ignored.
  `config.example.json` drops them and `_comment_ports` now states the one-port rule (keeping the avoid-7000-on-macOS
  warning). **Tests:** `test_dual_port_live` deleted; `test_migrate_dial_live` rewritten as
  `test_gateway_subpeer_delivery_live`, keeping only the #60 guard (A delivers to a sub-peer hosted by B's gateway
  while B binds a specific IP, 127.0.0.2, exercising the loopback `pairServer` re-splice) with both hosts on one
  shared port; the now-meaningless `AI_BRIDGE_COMPAT_*: ''` spawn env was stripped from the live tests. Suite 754 across 36.
- **Built (v1.45.0):** *cross-project consent grants federate mesh-wide as a last-writer-wins set (#62).* **What
  broke:** consent is receiver-side — `deliveryAllowed` → `consent.mayInitiate(from, to)` runs in the bridge PROCESS
  hosting the target — but an `allow_project` grant lived only in the one process that ran it (RAM + that host's
  store). Live 2026-09-29: an AIMB broadcast reached Marz sessions on LITTLE (grant there) but was `project-denied`
  for MapGuy2, a Marz sub-peer on a FOLLOWER on ROBIN, and for Ferret on the Mac. **Design:** `lib/consent.js` now
  holds one record per edge `(from,to)`: `{ from, to, mode, exp, updated_at, revoked, origin }` (`updated_at` = ms
  epoch; `origin` = the writing session). A revoke writes a TOMBSTONE (`revoked:true`, newer `updated_at`) instead of
  deleting, so it propagates and beats the older grant. `merge()` keeps per edge the record that wins `beats()`:
  greater `updated_at`; on a tie the tombstone, then the greater origin, then the greater canonical JSON — a total
  order, so merge is idempotent + commutative. A local `allow`/`revoke` stamps `max(now, known+1)`, so it always
  beats what the host already knows even under clock skew. `mayInitiate`/`reachable` read the merged set and skip
  tombstones and expired grants. bridge.mjs only calls `grantSet()`/`merge()` and never touches the map.
  **Replication:** every gateway re-gossips the FULL set it knows (local + learned) in a new `grants` field on
  `PEER_ROSTER` — roster slices are one-hop, but LWW makes transitive re-gossip safe, so a grant crosses any number of
  hubs. `gossipToPeers`'s dedupe signature now includes the set, so an `allow_project` sends at once (not on the 60s
  #63 refresh); `mergeRemoteRoster` merges the set BEFORE the #63 unchanged-slice stamp-only return, so a grant-only
  change is never swallowed, and a change re-broadcasts (→ onward gossip; an idempotent merge ends the loop). The
  #63 refresh carries the set too (anti-entropy). **Followers:** the gateway's `ROSTER` to followers carries
  `grants`, and a follower merges it into its own consent (consent for a follower's sub-peer is checked in the
  follower). A follower's own `allow_project`/`revoke_project` goes UP in a new follower→gateway `GRANTS` frame
  (`{t:'GRANTS', session, grants}`, full set, accepted only after `HELLO`), also sent on every (re)connect after
  `REGISTER`; the gateway merges and re-broadcasts/gossips. So a grant made anywhere reaches every gateway AND every
  follower on every host. **Persistence:** every process persists each record that CHANGED in a merge, so a learned
  grant survives a restart and its granting host going offline. Legacy durable records (no `updated_at`) date from
  `granted_at` (else 0), so any 1.45 write beats them. A tombstone is stored with `exp` = the revoke time, so a ≤1.44
  bridge sharing the store (the Windows Dropbox pair) never rehydrates it as a grant; the file store's `gcAll` now
  skips tombstones. The dashboard's Grants view shows tombstones as "revoked" and counts only live grants.
  **Tombstone GC:** `consent.gc()` turns an EXPIRED grant into a tombstone (same `updated_at`, so it still beats an
  older forever-grant a long-offline host re-gossips) and drops a tombstone once older than
  `AI_BRIDGE_GRANT_TOMBSTONE_TTL_MS` (default 30 days) from `max(updated_at, exp)`. **Known limit:** a host offline
  for longer than that TTL can come back and re-gossip a grant whose revoke everyone has already forgotten,
  resurrecting it. (A ≤1.44 bridge sharing a store also gc's tombstones early, since their `exp` is past.)
  **Mixed versions:** ≤1.44 bridges ignore the `grants` field and the `GRANTS` frame, so grants spread only among
  1.45+ hosts; a ≤1.44 host (or a follower under a ≤1.44 gateway) still knows only its local grants. Nothing breaks
  for older peers. **Out of scope:** static `config.projects.allow` edges stay per-config and are NOT gossiped.
  **Security:** any realm member can gossip a grant (the realm token is the membership gate) — the same trust level
  as the existing unsigned roster/claim gossip, and an accepted trade-off; the `GRANTS` frame needs a `HELLO`'d
  connection and `PEER_ROSTER` grants are merged only from an adopted peer link. The `request_project_access` →
  `allow_project` → `project_access_granted` flow is unchanged (pending requests stay local to the operator's
  bridge). **Tests:** 22 new LWW unit checks in `test_lib_unit` (newer wins; tombstone beats older grant; newer
  grant beats older tombstone; idempotent; commutative across orders + batch; tie rules; expiry incl. gc→tombstone;
  legacy records; local stamp beats a future-stamped tombstone; revoke of an unknown edge; tombstone TTL; junk
  input). New `test_grants_federate_live` (18 checks): gateways on 127.0.0.1/127.0.0.2 plus a FOLLOWER on A hosting
  the Marz target (the MapGuy2 shape), a 60s refresh so every propagation must be prompt: denied before any grant; a
  grant made on B (not where the target lives) → `ok:true` AND in the follower-hosted target's inbox, and the
  follower's own `access` lists it; a revoke on B → denied again; a re-grant beats the tombstone; a grant made on A's
  FOLLOWER reaches B (lands in the inbox); and, with file persistence in a temp dir, the grant A LEARNED survives A
  (gateway + follower) restarting while B is down. Against the pre-fix bridge + consent (`AIMB_TEST_BRIDGE`) 9 of 18
  FAIL — every propagation and durability check (`project-denied` where the grant should apply).
- **Built (v1.44.0):** *cross-host federation self-heals after a peer restarts or moves port (#63).* **What broke:**
  after the Mac flipped 7000→12317 and restarted several times, LITTLE-001 kept the Mac's OLD roster slice behind a
  TCP link that still showed ESTABLISHED, so LITTLE's sessions dialed the dead old port for Mac peers while ROBIN's
  (fresh link) worked; only restarting LITTLE's bridges fixed it. **Root cause:** a receiver replaces a peer's slice
  only on a `PEER_ROSTER` from the SAME gateway session, gossip only fires when the sender's local slice changes
  (`lastGossip`), and a slice is only dropped when that link's socket closes. A restarted peer has a NEW session,
  and a half-open link never closes, so the old slice stayed forever. With stable ids the old and new sub-peer share
  one id and `rosterSub` returns the FIRST (stale) owner, so delivery went to the old port. **Fix (four parts):**
  (1) *Re-link sends fresh state:* both link directions send a full slice on adopt, independent of `lastGossip`;
  the dialer now re-sends after `PEER_HELLO`, because its connect-time frame can predate a change that
  `gossipToPeers` sent before the link was adopted. (2) *Replace a restarted peer:* `adoptPeer` compares the new hub
  with existing entries. **Same machine** means the same hostname prefix of the session id AND the same advertised
  host, so different machines never match. Same advertised port ⇒ certainly a restart (two live gateways can't share
  one host:port) ⇒ `retirePeer` at once (drop slice + destroy socket). Different port ⇒ possibly a live rival
  (split-brain, or two loopback test "hosts"), so the old link is PINGed and retired only if a provable peer (below)
  stays silent for `PEER_PROBE_MS`. Single-process dual-port (#57) is one session, so it never triggers this.
  (3) *Heartbeat + expiry:* every `GOSSIP_REFRESH_MS` a gateway re-sends its full slice to each refresh-capable
  peer and PINGs every link. A receiver stamps `seen` on each `PEER_ROSTER`/`PONG`. An unchanged slice is stamp-only
  (per-peer signature), so there is no `broadcastRoster` spam. A provable peer not heard from within
  `expiryOf(p) = max(PEER_EXPIRY_MS, 2×refresh, 3×the peer's advertised refresh_ms)` is retired. Its socket is
  destroyed, so an outbound link frees `peerByAddr` and discovery re-dials it. The refreshed slice also re-stamps
  every remote session's host/port from the frame. (4) *Stale-socket guard:* `mergeRemoteRoster` now accepts a slice
  only from the CURRENT `peerGw` socket for that gateway. A late frame on a retired or replaced socket used to
  resurrect entries that no `peerGw` entry owned, so nothing would ever clean them up. **Mixed-version handling
  (1.39–1.43 peers):** `PEER_HELLO`/`PEER_ROSTER` now carry `gossip_refresh:true, refresh_ms`. A peer is only
  *provable* (expirable, probe-retirable) if it DECLARES the flag (so it really refreshes and PONGs), OR if it is a
  link WE dialed: every bridge since 1.0 answers `PING` on its control port, and older `connectToPeer` dialers
  ignore it. So an older peer that dialed us is NEVER expired for being quiet; for it, our periodic PING writes still
  surface a truly dead TCP link as an RST. Refresh rosters go only to declared peers: an older receiver can't
  expire, and would needlessly re-merge and re-broadcast. Older bridges ignore the new fields and the `PING`. The
  heal on an older RECEIVER still needs it upgraded. **Knobs:** `AI_BRIDGE_GOSSIP_REFRESH_MS` (default 60000),
  `AI_BRIDGE_PEER_EXPIRY_MS` (default 3× refresh = 180000), `AI_BRIDGE_PEER_PROBE_MS` (default 5000); test-only
  `AI_BRIDGE_TEST_GOSSIP=silent|legacy`. **Tests:** new `test_federation_heal_live` (19 checks). A TCP relay on
  127.0.0.3 simulates the half-open link: whichever end dies, the other is kept open with writes swallowed. The
  checks cover: restart on a NEW port behind an outbound half-open link (no old-origin entries, one owner at the new
  port, delivery verified via the target's inbox); restart on the SAME port behind an inbound link; a silent
  refresh-capable peer expired within the window with its socket destroyed; and a quiet 1.44 peer plus two legacy
  peers (one we dialed, one that dialed us) still linked after 3× expiry. `AIMB_TEST_LEGACY_BRIDGE` runs the legacy
  peers on a real 1.43 copy (19/19). Against the pre-fix bridge (`AIMB_TEST_BRIDGE`) 7 checks FAIL, including the
  production symptom exactly: `ECONNREFUSED` to B's old port.
- **Built (v1.43.0):** *the doorbell chimes hourly by default, and a connect reminder carries the script's location
  (#67).* Two of Robin's asks. (1) **Hourly chime.** With no `--timeout`, `tools/aimb-doorbell.mjs` now exits at the
  top of the next LOCAL hour (or earlier on mail) with `reason:"hourly"`, `time:"14:00"`, the usual `exited_at`
  stamps and `guidance:"Top of the hour: display the current time (14:00) to the user, then re-arm the doorbell."`.
  That is deliberately NOT the silent-re-arm wake: the point is a clock the user sees. Same fields in the `--status`
  exit write (`state:"hourly"`). **No double chime / hot loop:** a `setTimeout` can fire a few ms early relative to
  `Date.now()`, so the timer re-checks and waits out any remainder, always exiting at/after the boundary. A re-arm
  then computes the NEXT boundary, and the reported time is the boundary's, never a drifted "13:59". The boundary
  is `setHours(h+1)` on the local clock (so DST and non-whole-hour offsets are handled). An explicit `--timeout <sec>`
  is unchanged (`reason:"timeout"`, silent guidance). Test hook: env `AIMB_DOORBELL_PERIOD_SEC=<n>` chimes on the
  next multiple of *n* local seconds. (2) **Where is the doorbell?** Agents often don't know the path, and on macOS
  `node` may be off PATH for a non-login shell. `register_self` now expands placeholders in each emitted
  `connect_reminders[].behavior` (fresh + reattach paths): `{doorbell_cmd}` →
  `"<process.execPath>" "<HERE>/tools/aimb-doorbell.mjs" --name "<name>" --project "<project>"`, plus
  `{doorbell_path}`, `{node}`, `{name}`, `{project}`. The values come from THIS bridge's own location, so each host
  hands out its own correct path, with forward slashes and double-quoted paths (spaces), runnable from bash on every
  platform including Git Bash. Unknown `{tokens}` pass through; expansion is emit-time only, so the stored reminder
  keeps the raw tokens. `set_wake` for a code session now returns the same ready-to-run `command` in its `hint` and
  mentions the hourly default. The shipped connect default in `config.example.json` uses `{doorbell_cmd}` (322
  chars, under the 365 cap). **Rollout:** the default only reaches a session once its host runs 1.43.0 AND that
  host's config carries the connect entry; live configs were not edited. Tests: `test_doorbell_live` +10 (40:
  hourly exit, time, display guidance, stamps, never-early, status file, next-boundary re-arm, mail before the chime,
  explicit `--timeout` wins); `test_connect_reminders_live` +7 (17: `{doorbell_cmd}`/`{doorbell_path}`/`{node}`/
  `{name}`/`{project}` expansion, unknown token untouched, stored reminder unmodified, `set_wake` hint carries the
  path). Verified to FAIL against the pre-change code (7 + 5 fails).
- **Built (v1.42.0):** *a cross-host send reports the receiver's REAL outcome — `ok:true` no longer masks a
  denied or dead-lettered delivery (#61).* **What broke:** `send_to_peer` to a sub-peer on ANOTHER host returned
  `ok:true` even when that host refused (`project-denied`) or dead-lettered the message — which hid #62 (grants don't
  federate) for a full debugging session. A LOCAL send already returned the honest result; only the cross-host path
  lied. **Root cause:** the `pairServer` `MSG` handler called `deliver`/`deliverSub` and then sent `CLOSE {code:'ok'}`
  unconditionally, ignoring the return; `dialAndSend` resolved `{ok:true}` on any `CLOSE`. **Fix:** the MSG handler
  now captures the result and sends `CLOSE {code}` with `code = 'ok'` when `r.ok`, else `r.code`, plus
  `dead_lettered`/`dedup` flags when set; `dialAndSend` resolves `ok` only for `code:'ok'` or a code-less CLOSE, else
  `{ok:false, code}`, and passes the flags through. The gateway's CONNECT splice is byte-opaque, so the richer CLOSE
  reaches the remote sender unchanged, and the result now mirrors a local send exactly: denied → `{ok:false,
  code:'project-denied'}`, dead-letter → `{ok:true, dead_lettered:true}`, loop → `{ok:false, code:'loop'}`. All
  consumers (`send_to_peer` spreads `...r`; topic/publish fan-out and the WS leaf `send` read `r.ok`/`r.code`;
  `deliverSystemToProject` counts `r.ok`) pick it up with no further change. **Backward compat:** an OLD receiver
  always sends `CLOSE {code:'ok'}` → a new sender still reads ok (no regression); a NEW receiver's `CLOSE
  {code:'project-denied'}` read by an OLD sender still reads ok (old code ignores the code — no improvement until the
  SENDER is on 1.42.0, but no breakage). So the fix is sender+receiver: both ends must run 1.42.0 to see a refusal.
  New `test_delivery_outcome_live` (10 checks, two gateways on 127.0.0.1/127.0.0.2): cross-host denied →
  `ok:false/project-denied` and the target's inbox stays empty; same-project positive control delivers; after the
  B-side `allow_project {project:'Mine'}` the same send succeeds and lands; a send to a dead id under B's session
  reports `dead_lettered:true` and lands in B's process inbox. Verified to FAIL against the pre-fix bridge (2 fails:
  the denied send reads `ok:true`, the dead-letter reads plain `ok:true`), so it is a real regression guard.
- **Built (v1.41.0):** *connect reminders (by client type), claim-default flip, and a session-resolved `set_wake` (#64).*
  Three related changes, all Robin's calls. (1) **`connect` operation + `client` scope** in the reminder system
  (`lib/reminders.js`): a reminder can now be pinned to the register moment and filtered by the session's client
  kind (`code`/`agent`/`cowork`/`other`). `register_self` returns any matching ones as `connect_reminders`, and
  the shipped config default tells **code** sessions to run the doorbell — a runtime-configurable, client-typed
  standing hint rather than a hardcoded instructions line. There is no bridge-side `wake`, so this is how a poll
  client learns its options at connect. (2) **`claim_topic` defaults flipped to `exclusive:true` +
  `announce_offline:true`** (persistent was already default-true): a plain claim is now a sole-owner, durable,
  offline-announcing responsibility — matching how every real topic is already claimed; shared/silent are the
  opt-outs. (3) **`set_wake` now answers by session type**: still `unsupported` (`CAPS.wake=false`), but a `code`
  session is told *"use the doorbell as a fallback"* (with the command), while others get *"no fallback
  supported"* — so the caller learns what it can actually do. New `test_connect_reminders_live` (10 checks) proves
  the claim defaults on the roster, both `set_wake` branches, and client-scope gating (code matches, cowork
  doesn't, `all` always fires); `test_offline_park_live` updated (silent parking now opts out explicitly). Full
  suite green. Live rollout note: the `connect` default goes into a host's config only AFTER it runs 1.41.0 — on
  1.40.0 an unknown `connect` op/`client` scope folds to a `receive`/`all` reminder.
- **Built (v1.40.0):** *pair-listener binds loopback, not the tailnet IP — fixes an inbound-only host (#60).* A
  host could SEND to the mesh but NOTHING on the mesh could be routed to it: every `send_to_peer` to Robin's Mac
  came back `target-unreachable`, though the Mac appeared healthy in every roster and its own sends landed fine.
  Root cause: the `pairServer` — the host-internal splice target every bridge listens on — was bound to `BIND`,
  but it is only ever DIALED over loopback. Cross-host delivery reaches a host's WELL-KNOWN port, then the
  gateway re-splices the envelope to the owning local session via `connect(pairPort, peer.host || HOST)` where
  `HOST` is hard-coded `127.0.0.1` (`mergeRemoteRoster` rewrites a remote session's port to its gateway's PORT,
  so `pairPort` never crosses a host). When `bind` is `0.0.0.0` (the Windows boxes) loopback is covered and it
  works; the Mac's `bind` is its specific **tailnet IP**, so `pairServer` listened on that IP only and the
  gateway's dial to `127.0.0.1:pairPort` for its OWN gateway-hosted sub-peer (MacDaddy) got ECONNREFUSED →
  `target-unreachable`. It was Mac-only because only the Mac had BOTH a gateway-hosted sub-peer AND a non-`0.0.0.0`
  bind (the Linux gateways carry no sub-peers; the Windows boxes bind `0.0.0.0`). Fix: `pairServer.listen(0, HOST)`
  — the pair port is an internal loopback-only listener and should never have been on the tailnet at all (a small
  attack-surface win too). This is the SAME failure I earlier wrote off in `test_migrate_dial_live` as "a
  loopback-harness quirk, not a routing bug" (B bound to 127.0.0.2 → self-splice to 127.0.0.1 refused) — it was a
  real bug; production just needed a host whose bind wasn't `0.0.0.0`. That test now DELIVERS A→B's gateway-hosted
  sub-peer and asserts receipt; verified it FAILS with the exact `target-unreachable` against the pre-fix bind, so
  it is a real regression guard. Full suite green.
- **Built (v1.39.0):** *dashboard version colouring by COMPATIBILITY, not popularity (Robin).* #50 flagged any
  version differing from the mesh MODE (most common) amber — which during a rollout wrongly reddened the NEWEST
  node (the minority) while the old majority looked fine. Replaced with a compatibility tri-state: **green** =
  the newest version present on the mesh · **red** = below the compat floor (`MIN_COMPATIBLE`, currently 1.26.0 —
  the stable-`peer:`-id break, §9), i.e. too old to interoperate · **black** = compatible, just behind. A host
  running >1 version at once stays a separate **amber** "mixed" badge (a stuck mid-upgrade, orthogonal to
  compatibility). The map banner is now RED only when an incompatible version is actually present; a compatible
  skew during a rollout is a neutral grey note, not an alarm. Applied everywhere versions render — per-node map
  labels, per-host badges, the Computers/Bridge column — with the legend rewritten. `MIN_COMPATIBLE` lives in
  `dashboard.html` (served by the gateway) with a comment to bump it on a real breaking change. Verified by the
  rewritten `test_dashboard_multihost` (latest=green, a <floor node=red, a ≥floor-but-behind node=black, a
  two-version host=amber, red banner names the incompatible). On the current live mesh: 1.38.0 green, 1.36.0 and
  1.32.0 black, no red — a healthy rollout reads as such. Suite 662 across 33.
- **Built (v1.38.0):** *dual-port, the CROSS-HOST dial half (#57 fix — live-mesh incident).* v1.37.0's compat
  window covered the LISTEN side (a gateway binds new+old ports) and same-host election, but not the OUTBOUND
  cross-host dial. `facets/discovery/tailscale.js` hands each candidate the DIALER's own port (it assumes a
  uniform realm port), so when ROBIN-Z790 migrated to 12317 and, by the "smaller IP dials" tie-break, was the
  designated dialer for the still-on-7000 hosts, it dialed them on 12317, missed, and **partitioned itself off
  the live mesh** (three isolated segments). The compat LISTENER would have caught an inbound dial, but the
  tie-break put ROBIN on the outbound side, so that path never ran. **Fix:** `connectToPeer` now falls back
  through the compat ports — try the primary (advertised) port, then each compat port — with a 4s per-attempt
  guard; the tie-break still elects one dialer per pair, this only changes which port it succeeds on. A
  non-migrated node (no compat) is unchanged. Verified by `test_migrate_dial_live`: a migrated dialer handed a
  WRONG-port candidate (exactly what tailscale produces) falls back to compat and federates with an old-port
  peer on a second loopback IP, and the peer's sub-peers gossip across the healed link. **Lesson:** "dual-port"
  is three surfaces — bind, same-host election, AND cross-host dial; v1.37.0 shipped two of three and the third
  only shows under a real multi-host migration, which the loopback suites don't exercise. Suite 662 across 33.
- **Built (v1.37.0):** *dual-port gateway — a compat window for the port migration (#57).* Migrating the realm's
  ports (#56, from #46/v1.36.0) risked a **same-host split-brain**: flip a host's config to 12317 while a session's
  bridge still runs on 7000, and the next new session binds 12317 (free) and stands up a SECOND gateway. Fix: a
  gateway can hold **more than one** control port. New invariant — *a gateway owns every well-known control port on
  its host*, so "is there already a gateway here?" == "is ANY of those ports bound?". Election (`bindPorts`) now
  tries `[PORT, ...compatPorts]` in turn; if ANY is already held, an existing gateway is there — including an OLDER
  one on just the old port — and we drop what we grabbed and **follow it on that port** (`becomeFollower(gwPort)`),
  never a rival. This required extracting the inline control-connection and WS-leaf handlers into shared
  `onControlConn`/`onWsConnection`/`startWsIngress` so the primary and each compat listener reuse them; the WS
  ingress likewise runs once per ws port, so a doorbell/page on an old ws port still reaches the gateway during the
  move. **Opt-in** (`compatPorts`/`compatWsPorts`, default `[]`): set them in the SAME config edit that flips the
  port, so a lingering old-port session converges with no coordinated restart; remove them once every host
  advertises the new port. Opt-in (not default-on) keeps two loopback-simulated *hosts* in the test suite from
  colliding on a shared compat port — real hosts are separate machines. New `test_dual_port_live` (6 checks) proves
  an old-port bridge joins a new-port+compat gateway, a message routes across the join, WS compat reaches the
  gateway, and the reverse start order makes the new-port bridge step down rather than split. #56's migration
  procedure is rewritten around this. Suite 659 across 32.
- **Built (v1.36.0):** *default ports 7000/7001 → 12317/12318 (macOS AirPlay clash).* MacDaddy (a new node —
  Robin's MacBook Pro) hit `EADDRINUSE` binding a `0.0.0.0` gateway on 7000: macOS Control Center's **AirPlay
  Receiver squats `*:5000` and `*:7000`**, and the workaround (bind a specific IP) then strands loopback clients
  (the doorbell, dashboard and chat all live on `127.0.0.1`). **12317/12318** bind cleanly on macOS, Windows AND
  Linux — clear of AirPlay, the Linux ephemeral range (32768+) and the Windows dynamic/Hyper-V range (49152+).
  Changed the SHIPPED default only: `config.example.json` (with a `_comment_ports` rationale) + the code
  fallbacks (`bridge.mjs`, the doorbell, page-bridge, research_client, chat/dashboard/test_page HTML) + README
  and linux-setup docs. **Safe for the running realm:** every live host has an explicit `port` in its own
  `config.json` that overrides the fallback, so nothing moves until a host opts in; and the gateway port is
  gossiped (`PEER_ROSTER`/`PEER_HELLO` carry it, verified), so mixed-port hosts keep federating — only same-host
  sessions must agree. The live Dropbox `config.json` was deliberately NOT flipped (that would arm a same-host
  split-brain on the next new-session spawn, before a coordinated restart); the whole-realm migration is tracked
  as #56 (per-host: edit config, restart all same-host bridges together). Derivation for the curious: 12·3·17 =
  M·C·P (13·3·16 shifted −1/0/+1). No default-dependent tests, so suite unchanged at 653 across 31.
- **Built (v1.35.0):** *topic emphasis shows DURABILITY and EXCLUSIVITY as separate signals.* Robin read the
  dashboard's bold topics as "durable" and asked why `bills` wasn't — but bold meant **exclusive**, and `bills`
  was durable all along (`persistent:true` on disk, refreshed, with `keep_alive:true` + `announce_offline:true` —
  better continuity than most). A non-exclusive-but-durable topic looked undurable, and the misread nearly sent
  a "fix" instruction to its owner for a non-problem. Two independent facts had been collapsed onto one visual.
  **Fix:** **bold = durable**, **underline = exclusive**, both = both, plain = neither — applied everywhere
  topics render (holder rows, the expander detail, and the persistence claims/kept tables), plus a **legend** in
  the header, which is the piece whose absence caused the misread. The expander detail now also spells out
  `· durable` alongside `· exclusive`. **Required a bridge change:** `persistent` was only ever written into the
  `.claim` FILE by `persistClaim` — it was absent from the in-RAM `myTopics` record, so `topicList()` never put
  it on the roster and the dashboard had no durability signal to render at all. Added at both `myTopics.set`
  sites (fresh claim, and the durable-claim rehydrate path where it is true by construction). Verified by four
  new checks in `test_dashboard_multihost` covering all four flag combinations. Suite 653 across 31.
- **Built (v1.34.0):** *doorbell exit codes = success/failure; built-in silent re-arm guidance (#52).* A peer
  (Analysiz2) reported — with a real misreport to Robin behind it — that `aimb-doorbell.mjs` exited **2** on a
  clean timeout, and the Claude Code background-task harness paints ANY non-zero exit as "failed", so a benign
  30-min timeout surfaced as a FAILURE (and a doorbell LOOP narrated "Quiet re-arm, nothing new" every cycle).
  **Fix, two parts:** (1) the exit code is now a pure success/failure signal — **0** once the doorbell has ARMED
  and any normal outcome occurs (mail / timeout / peer-gone / a post-arm link drop → re-arm), **4** only when it
  couldn't do its job (never armed / bridge error frame → investigate, don't hot-loop), **64** bad usage. The
  specific outcome moved entirely into `reason` on stdout + `--status`, so a caller still branches on it (the
  mail-vs-timeout split Analysiz2 relied on is intact, just not via the numeric code). An `armed` flag draws the
  line: a link failure BEFORE welcome is real trouble (4), a drop AFTER is a benign re-arm (0). (2) a routine
  **no-mail** wake now carries a terse built-in `guidance:"silent re-arm — don't mention this wake unless you're
  stopping the loop"` — kept deliberately short because it rides every idle re-arm and the agent reads it each
  time — so a loop stops burning tokens narrating uneventful wakes; mail exits carry NO guidance (that one IS
  actionable). Resolves the "doorbell exit codes vs the harness" item that had sat under Smaller/maybe. Verified
  by `test_doorbell_live` (timeout now exits 0 with guidance; mail exits 0 without guidance; both self-stamped).
  Suite 649 across 31.
- **Built (v1.33.0):** *behaviour-reminder char cap 280 → 365; report each arrival on its own line.* Two
  linked field notes as the receive/send default conventions got adopted across the mesh. (1) A Cowork session
  rendered two arrivals concatenated onto ONE line (`🖂 … · 🖂 …`), because the convention said "open with" a
  glyph line without saying each message gets its OWN line — clarified the `receive` default to "Put EACH
  incoming message on its own blockquote (>) line". (2) That clarification, plus room for conventions to spell
  out their format, needed headroom: `MAX_LEN` 280 → **365** (~+30%) in `lib/reminders.js`, and the config-
  default truncation now uses `MAX_LEN` (was a hardcoded 280) so a longer operator default isn't silently
  clipped on a bridge that's been upgraded. **Rollout note:** the new `receive` default is 270 chars — under
  the OLD 280 — deliberately, so a not-yet-upgraded 1.32.0 bridge (which still truncates at 280 on live-reload)
  serves it intact; only reminders/defaults ABOVE 280 require every bridge to be on 1.33.0+ first. tool-schema
  description updated to "max 365 chars". Config change is live-reloaded (no restart); the `MAX_LEN` bump needs
  a bridge restart to take effect. Suite 647 across 31 (new boundary checks: 300-char accepted, 365 ok / 366 rejected).
- **Built (v1.32.0):** *bridge version ON the mesh map + a non-uniform-mesh flag (#50).* The dashboard's
  **Computers table** already carried each machine's bridge version, but the **mesh map** — the view you glance
  at during a rollout — did not, so a version-skewed mesh looked healthy on the map. It bit a peer twice in one
  day: a single host running *two* bridge versions at once (Claude Code spawns its own `bridge.mjs` beside the
  service's, and the two started across a `git pull`), and a tray-supervised bridge left on an old version while
  its checkout moved on. Same root class as the "synced checkout ≠ running bridge" gotcha: version-on-disk ≠
  version-running. **Built (a)+(b):** every session node now shows its running `bridge_version`; the value goes
  **amber** when it isn't the mesh MODE (the most common version) — so a single stale bridge, or the older half
  of a mixed host, stands out. Each host box carries a version badge (amber when that host runs >1 version, or a
  single version that isn't the mesh mode), and a top **banner** names the skew (`⚠ mixed bridge versions on the
  mesh: v1.30.0 (1) v1.32.0 (3)`) since uniformity is a whole-mesh property a table makes you eyeball row by row.
  All from data already in the roster (`s.bridge_version` per session), so no bridge change. **(c) deferred** —
  flagging a node whose *running* version differs from the version *on its disk* (the exact gap behind both
  incidents) needs the bridge to read its own `package.json` at request time and thread a `code_version` through
  the gossiped roster; the requester himself flagged it as maybe-not-worth-the-plumbing, so it stays in
  docs/issues.md #50 pending Robin's call. Verified by six new checks in `test_dashboard_multihost` (skew banner,
  mixed host badge, non-mixed uniform host, an amber behind-node, a non-amber mode-node, version shown on the
  gateway node); the uniform-mesh `test_dashboard` shows no banner. Suite 645 across 31.
- **Built (v1.31.0):** *the doorbell self-timestamps its exit (#51).* `tools/aimb-doorbell.mjs` printed one
  JSON line on exit, but only the *timeout* reason carried any time signal (`waited_sec`) — mail / gone / error
  / link-closed had none, so a session woken after a quiet stretch could not tell whether the wake fired 2
  minutes ago or 40 without cross-referencing other logs. **Fix (additive):** every exit line now carries
  `exited_at` (local ISO-8601 **with tz offset**, e.g. `2026-07-22T13:52:45.123+12:00` — a human reads the wake
  time at a glance, no UTC math) and `exited_at_unix`. Stamped **centrally in `done()`**, so all five exit
  reasons get it uniformly, and the same two fields land in the `--status` file's exit write. `new Date()` is
  UTC-only, so the local-with-offset string is hand-built (`localIso()`). Pure new fields — no change to exit
  codes or the existing summary shape, safe against any caller. Requested by Linux-1 (relaying Robin). Verified
  by two new checks in `test_doorbell_live` (mail exit + timeout exit both carry a well-formed local-ISO stamp +
  unix field, and the status file's exit write carries them too). Suite 639 across 31.
- **Built (v1.30.0):** *the incoming behaviour operation renamed `deliver` → `receive` (#47).* #44 named the
  operation that fires when a message ARRIVES `deliver`, but from the recipient's seat the message is *received*,
  not delivered — and "deliver" reads as an outbound verb, which is exactly the confusion `send` sits opposite.
  Robin's call: name it `receive`, and make `receive` the omitted-operation default (so every pre-#44 behaviour,
  which all fired on inbound mail, keeps working unchanged). **Rename is total but back-compatible via an alias,
  not a migration:** `OP_ALIASES = {deliver:'receive'}` folds the old name to the canonical one at every entry
  point — a stale client that still sends `operation:'deliver'` (tool schemas cache across a version bump, #45),
  a config default that names `deliver`, and — the durable one — existing `.beh` files written under the old
  name. Nothing on disk is renamed: the persistence layer keeps READING legacy-named files (`deliver__…​.beh`
  and pre-#44 unprefixed `<scope>__<match>.beh`), folds their operation to `receive` on load, and — so a cleared
  reminder can't be resurrected by a stale filename — `remove()` deletes by CONTENT match (operation/scope/match)
  rather than by a reconstructed name. Deliberately no file-rename migration: the persistence dir is a
  Dropbox-shared checkout with a still-older host on it, and renaming would churn files across versions; alias-on-
  read is inert for the old code (it reads `receive`, its own unknown-op fold maps it back to `deliver` — same
  semantics). `#48` (make `operation` MANDATORY, dropping the silent default) waits on a full client-restart
  cycle. Verified by `test_receive_rename_live` (12 checks): two real legacy flavours pre-seeded into a hashed
  holder dir — a #44-era `operation:"deliver"` file and a pre-#44 no-operation file — both rehydrate as
  `receive`, fire on a live delivered message most-specific-first, and (the subtle part) are physically removed
  on clear so nothing resurrects across a genuine bridge restart; plus the alias accepted + folded live in
  `test_op_reminders_live` and at the unit layer. Suite 636 across 31.
- **Built (v1.29.0):** *realm token from a file — keep it out of argv (#46).* A peer found the realm token in
  **plaintext in the process command line** on a host whose MCP client inlines `env:{AI_BRIDGE_TOKEN:"…"}` into
  an inline `--mcp-config` (Claude Code on Linux). argv is world-readable via `ps` and captured by crash dumps /
  monitors / support bundles, and the realm token is BOTH the membership gate AND the body-encryption key — so
  that one string is the whole mesh, and unlike a file you cannot chmod argv. Ironic on the same box whose Linux
  guide moves the token stdin-only into a 0600 `bridge.env` specifically to keep it out of `ps`. **Fix:**
  `bridge.mjs` reads the token from `AI_BRIDGE_TOKEN_FILE` (a PATH — harmless in argv) when set, so an MCP config
  references a path instead of the secret value. Accepts a bare-token file or a `KEY=VALUE` env file (e.g.
  `~/.aimb/bridge.env`); `~` expands to home. Precedence: `AI_BRIDGE_TOKEN` value → `AI_BRIDGE_TOKEN_FILE`
  contents → `config.json` token. Additive, backward-compatible; the exposure is client-config-shaped, not a
  bridge bug (the tray path never had the token in argv). Verified by `test_token_file_live` (6 checks: bare
  file + env-file shape both gate realm membership end-to-end, explicit env beats the file, a message routes
  across the file-token boundary). Token ROTATION is deferred (see docs/issues.md #49); the exposed value is
  limited to a local `ps` on a single-user dev VM. Suite 622 across 30.
- **Built (v1.28.0):** *notify `tools/list_changed` so an upgraded bridge refreshes a running client's cached
  schema (#45).* v1.27.0 (#44) added the `operation` param to `set_behavior`, and the bridge advertised it
  correctly — but a peer testing it in the field found the param was silently STRIPPED before the call left the
  client. Cause: an MCP client caches `tools/list` at initialize; when the bridge is upgraded UNDER a running
  client (the normal case here — the stdio/tray bridge is replaced but the client session lives on), the client
  keeps the OLD schema and drops any argument the old schema didn't declare. A bridge restart alone did **not**
  refresh it (confirmed on two independent clients). The bridge now declares `capabilities.tools.listChanged`
  and calls `sendToolListChanged()` shortly after each client's `initialized`, prompting the client to re-fetch
  `tools/list` and pick up new params without a full session restart. **Scope of the claim:** the automated
  test (`test_toollist_changed_live`) proves the BRIDGE's half — it advertises the capability, emits the
  notification post-initialize, and the re-fetched `set_behavior` schema carries `operation`. Whether a given
  client actually re-fetches on the notification is client-specific and is verified live against a real Claude
  Code client, not asserted by a test double. Also surfaced: `set_behavior` silently defaults a stripped
  `operation` to `deliver` — the response echoes the stored value (`operation:"deliver"`), which is how the
  field tester caught it; the bridge cannot warn about a parameter a client never sends, so the refresh is the
  real fix. Suite 616 across 29.
- **Built (v1.27.0):** *behaviour reminders generalized to OPERATIONS (#44).* Reminders were receive-only —
  every scope was defined over an incoming message, so a convention governing an OUTBOUND action (a reporting
  glyph, a consent habit) had no hook and fired too late or not at all. A reminder now carries an **`operation`**
  (which bridge action fires the check) alongside its scope+match; omitting it defaults to **`deliver`**, so every
  pre-#44 behaviour and the operator default keep working unchanged (no migration; old durable `.beh` files load
  as `deliver`). Supported operations: `deliver` (on-message, as before) plus `send`, `publish`, `claim_topic`,
  `release_topic`, `subscribe`, `allow_project`, `revoke_project`, `request_project_access` — each **echoes the
  matching reminders in that TOOL'S RESPONSE**. That is post-hoc for the message CONTENT (too late to change the
  body) but lands exactly when the agent composes its transcript line / follow-up / report — where reporting and
  consent conventions live. **Subject:** `deliver` matches the SENDER (its project/host, the arrival topic);
  outbound operations match the TARGET (the project/topic/host the action concerns). **The design property:** no
  session reminder AND no operator default for an operation ⇒ it is silent, so supporting an operation costs
  nothing until someone opts in — which is the noise control, with no separate mechanism. `operation` was chosen
  over a bolt-on `send` scope precisely so a reminder cannot leak across directions: a `send` reminder never
  fires on `deliver` and vice-versa, and the same scope+match can carry different reminders per operation. (An
  `operation:"*"` any-op sentinel was considered and deliberately NOT built — it would attach reminders to
  operations a session never reasons about, polluting context; a both-direction convention registers two
  reminders instead.) `set_behavior`/`clear_behavior` gain an optional `operation`; the persisted `.beh` file
  name is now operation-prefixed so the same scope+match on two operations don't collide. Verified by
  `test_lib_unit` (operation validation, cross-operation isolation, coexistence, deliver-only inheritance) +
  `test_op_reminders_live` (11 checks driving the real send/claim_topic/publish responses: the reminder rides
  the right response, does not leak across operations, and an un-opted operation omits the field). Suite 612
  across 28.
- **Built (v1.26.4):** *#41(c) — followers now re-announce probed capabilities.* The #41 probe mutates `CAPS`
  ~50ms after startup, but a follower had only ever sent its capabilities once, in the REGISTER frame at
  connect — so if REGISTER preceded the probe, the gateway roster kept the follower's stale pre-probe values
  forever while the gateway's own entry re-broadcast correctly. That is why two same-version sessions on one
  TPM-less host showed OPPOSITE `recover_secret` bits: not two probe results, one propagated result and one
  stale REGISTER value. Fixed with a `CAPS` update frame (mirrors SUBPEERS/TOPICS): `announceCaps()` runs when
  the probe completes, the gateway applies it to the roster and re-broadcasts. The probe delay is now
  env-tunable (`AI_BRIDGE_PROBE_MS`) so a test can force the register-before-probe ordering. Verified by
  `test_caps_propagate_live` (5 checks: a follower's roster entry goes false→true as its late probe lands),
  proven sensitive by reverting the re-announce (the follower's roster bit stays stale while its self-report
  is correct — the exact split-brain reported from the field). Suite 592 across 27.
- **Defect — OPEN (#42): the #41 probe's PREMISE is false — `Tpm.exe --pubkey` succeeds without a TPM.**
  Distinct from #41(c) above (that was propagation; this is the probe asking the wrong question). Field-
  confirmed on a host with **no TPM at all** (`Win32_Tpm` returns no instance; fTPM disabled in firmware):
  `Tpm.exe --pubkey` still returns **exit 0 and a valid RSA key**, because the helper falls back to a
  software KSP instead of the Platform Crypto Provider. So `probe()`'s test — "exit 0 AND a PUBKEY match" —
  cannot tell hardware-backed from software-backed, and reports `recover_secret: true` on a machine that has
  no TPM. **Worse than a wrong bit:** `seal()` also SUCCEEDS against that software key, so a secret would be
  sealed to something that is not the TPM, silently, and unseal would work — nothing fails at the moment of
  need, which is the whole failure mode #41 set out to remove. **Fix (a `tray/windows/Tpm.exe` C# change, not
  JS):** have the helper report WHICH provider backed the key and exit non-zero when it is not the Platform
  Crypto Provider — a probe that asks "did I get bytes" cannot answer "was it hardware". Until then, treat
  `recover_secret: true` as "a vault answered", not "a TPM answered".
- **Superseded note (old #42 text kept for history): the #41 probe gives a FALSE POSITIVE on some hosts.** Field evidence: two v1.26.1
  bridges on the SAME machine (no TPM — `Win32_Tpm` returns no instance) report OPPOSITE answers — the
  tray-launched gateway advertises `recover_secret: true` / `presence_confirm: true`, while the
  Code-launched session correctly reports both false. So the probe is not deterministic per host, which
  defeats #41 in exactly the case it was built for. Leading hypotheses, in order: (a) `Tpm.exe --pubkey`
  *succeeds* without a TPM (falling back to a software key store), in which case the probe is asking the
  wrong question and must verify the key is genuinely TPM-backed; (b) the two processes resolve DIFFERENT
  helper paths via `AI_BRIDGE_TPM_HELPER` / `AI_BRIDGE_HELLO_HELPER` or a different `HERE`, so one finds a
  helper and the other doesn't; (c) the `hello` probe is too weak by construction — it only checks platform +
  file existence, so a present-but-unusable helper reads as backed. Diagnostics requested from the affected
  host. Until resolved, treat `recover_secret` as advisory rather than authoritative.
- **Designed — pending:** `set_wake` (the tool half of T14 — the WS `listener` half shipped as the doorbell,
  v1.25.0 #39); durable reply-caps; mutual peer **presence/liveness** (a secret-authenticated doorbell variant
  exchanging keep-alives between two sessions/topics, so each knows the other is up — distinct from
  mail-waiting, and the one case that DOES need the secret).
- **Reserved — later:** federation + translator bridges (§8); alternate realm profiles (`tailnet`,
  `oidc`, `mtls`, `spiffe`, `mapped`); per-user *access enforcement* (§9); `force` operator-takeover of
  an offline holder.

---

## Document purpose and scope

**Purpose:** the durable design rationale and target shape for the Ai MCP Bridge — identity, realms,
isolation, reply authentication, federation, and the pluggable profile architecture.

**In scope:** the *why* behind the model and the seams the implementation must preserve.

**Out of scope:** operational commands, tool signatures, and setup (those live in
[`../src/README.md`](../src/README.md)); host-application specifics (the bridge is application-agnostic).
