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
- **Designed — pending:** the `wake`/doorbell (overlaps the push fallback); durable reply-caps; the
  Hello-vault inbox-secret-unlock (a further use of the authorizer).
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
