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

**Consent-control notices are exempt.** The bridge's own consent traffic — `project_access_request` (to a project
the requester cannot yet reach), `project_access_granted` and `project_access_revoked` (#72: granting → granted, the
direction a one-way grant leaves closed) — is marked `system` on the envelope, and `deliveryAllowed` passes `system`
first. Only bridge code sets it, for those fixed verbs; no tool, page or `send_to_peer` argument can, so it is not a
general bypass (a realm member forging raw frames is outside the model anyway — the realm is one trust domain). A
system notice skips `all`-scope receive reminders; project/host-scoped ones (matching the sender) still ride it.

### Project names: case-insensitive, first-seen spelling is canonical (v1.57.0, #71)

A project is identified by its **case-insensitive key** (`projKey` = trimmed + lower-cased; empty = `unclassified`).
Every place a project is compared or keyed uses it — consent edges and grants, topic ownership and `@project/` targets,
durable claims / parked mail / registrations / subscriptions / vault (the file store lower-cases every key), retained
values, reminder scopes, stable `peer:` ids, egress allowlists and the reply-cap (§5). So `AIMB` and `aimb` are one
project; a different case never splits one.

What is **shown** uses ONE spelling per project, mesh-wide: the **first-seen** one. Each bridge holds a small map
`projKey → {name, first_seen}` (`lib/project-names.js`); a sighting — a `register_self`, a page, the bridge's own
identity, an `allow_project` naming a project, and (on a gateway) any roster entry, which covers sessions of hosts too
old to send a map — folds in as `{name, first_seen: now}`. Merge keeps the **earliest `first_seen`**, then (a tie) the
lexically **smaller** name (`AIMB` < `aimb`, so an uppercase spelling beats its lowercase twin seen together). The
order is total, so merge is idempotent + commutative and every host re-gossips the whole map — the #62 / #66b pattern:
it rides `PEER_ROSTER` / `ROSTER` as `project_names`, a follower sends its sightings up in a `PROJECT_NAMES` frame, and
it persists one file per host (`project-names/<host>.pnames`), folded at startup. All hosts converge on the same
spelling. Display surfaces map through it: `list_sessions`, `register_self` (`identity.project`, `access`),
`my_identity`, `allow_project` / `revoke_project` / `request_project_access` results, topic send/publish results, the
#72 grant notices and the dashboard (roster + persistence view, via the `project_names` map on its roster). A later
registration in another case adopts the canonical spelling in what it is shown. Identities are **never rewritten**
(`identity.id` keeps the declared spelling, the roster the wire carries stays raw), so nothing may compare the display
name — code keeps using `projKey`. Limit: `first_seen` is wall-clock, so on a skewed clock "first" is approximate — the
agreement (every host showing the same spelling) does not depend on it.

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
- Both projects are bound by their **case-insensitive key** (`projKey`, v1.57.0, #71) — like every other project
  comparison — so a replier that re-registered as `BETA` (was `Beta`) still answers. A cap minted by a ≤1.56
  process bound the declared spellings; the verifier accepts that form too.

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

**Hub-to-hub frames** (uint32-framed JSON over the hub link; `HELLO` with the realm token first, then `PEER_HELLO`
adopts the link — every other frame is honoured only on an adopted link, and a frame type a hub doesn't know is
ignored, which is how mixed versions coexist):
- `PEER_HELLO {session, name, host, port, realm, gossip_refresh, refresh_ms, activity_gossip}` — the capability flags
  (#63 refresh; v1.60.0 `activity_gossip:1`) decide what each side sends.
- `PEER_ROSTER {gateway, host, port, sessions, pages, grants, realm_defaults, project_names, retained?}` — the local
  slice (§7 above; #62/#66b/#66c/#71 ride it); `PING` / `PONG` (#63 liveness).
- `CONNECT` / `ACCEPT` / `REJECT` / `MSG` / `CLOSE` — the delivery splice (and #66d page ingress).
- **Activity (v1.60.0, #70 step 4)** — one-hop, ≤1 `ACTIVITY_SLICE` per second per link:
  - `ACTIVITY_SLICE {v:1, origin, epoch, seq, full:true, sessions:[…], truncated?}` — a FULL slice (on every (re)link and
    on request): the sender's own host's sessions in snapshot form (current lines only, `has_details`/`has_data` flags).
  - `ACTIVITY_SLICE {v:1, origin, epoch, seq, base, sessions:[…changed…], remove?:[{realm, project, user, session,
    agent?}], truncated?}` — a DELTA: each session record = its header + only the changed `self` / `agents`; applied only
    when `base` equals the receiver's held seq for that epoch (else dropped + `resync`). An empty delta with
    `base === seq` (`beat:true`) is the minute heartbeat's sync check.
  - `ACTIVITY_DOWN {origin, reason}` — going down (prepare-shutdown / clean exit): the receiver shows that host gone.
  - `ACTIVITY_REQ {rid, op:"log"|"entry", q}` → `ACTIVITY_RES {rid, result}` — on-demand history from the owning hub
    (paged, rate-limited by the owner; v1.61.0: pages continue into the owner's day files, a rate-limited answer names
    the owner's `rate`, and the requester queues its fetches at that rate); `ACTIVITY_REQ {op:"resync"}` (no rid, no
    reply) asks for a full slice. v1.61.0: a session record's header may carry `bell:true` (a doorbell armed for it).
  - `ACTIVITY_ACT {rid, q:{session, project, user, path, action, args?}, by:{user}}` → `ACTIVITY_RES {rid, result}` (v1.65.0,
    #70 6d) — a DASHBOARD ACTION forwarded to the hub that owns the node (each host writes only its own nodes); queued and
    paced by the requester like an `ACTIVITY_REQ`, rate-limited by the owner's same per-link bucket. The owner attributes
    it `by:{kind:"dashboard", user, host:<the LINK's host>}` (never a host named in the frame); a `q.host` naming another
    host → `not-owner`; on a socket that is not an adopted peer hub (no HELLO, or no PEER_HELLO) → `unauthorized`.
    v1.65.0: a FULL `ACTIVITY_SLICE` also carries `log_cmd:{node, script, token_file}` — the sender's aimb-log paths for
    the dashboards' "copy command" (a path, never the token).
  - `origin` is informational: ownership is ALWAYS the link's host (the hostname of the peer's `PEER_HELLO` session);
    a frame whose `origin` names another host is dropped.

**Dashboard activity messages** (v1.61.0, #70 step 5; WS `dashboard` leaves only — a page leaf is answered
`dashboard-only`): `{type:"activity_sub", resync?}` → `{type:"activity_board", full:true, epoch, seq:1, head, upsert}`,
then ≤1/s `{type:"activity_delta", epoch, seq, base, head, upsert, remove}` (units: one per session group, one per agent,
in the raw board form); `{type:"activity_unsub"}`; `{type:"activity", ref, query}` → (`{type:"activity_queued", ref,
host, wait_ms, position}` while a remote fetch waits) → `{type:"activity", ref, result}`. v1.65.0 (#70 6d) — the first
WRITE: `{type:"activity_action", ref, host, session, project, user, path, action, args?}` → (`activity_queued` while a
forward waits) → `{type:"activity_action", ref, result}`; accepted only from an authenticated `dashboard` socket (a page
leaf, a logger or a socket without a hello → `unauthorized`); the board `head` carries `log_cmd` (this host's aimb-log
paths), `user` (who actions are attributed to) and each `remote_hosts[]` entry its own `log_cmd`. v1.68.0 (#80): the
gateway that APPLIES an action (the owner) then tells the node's session with a `system` envelope, verb `activity_changed`
(batched per session) — an ordinary message on the existing delivery paths, so no frame changes. v1.70.0 (#83 / #84): two
more actions, `edit_text` (`args:{text, state?}` — the node's current line, attributed on the line itself) and `message`
(`args:{text}` — logged on the node, delivered to its session at once); their notices are verbs `activity_text_edited`
(batched) and `activity_message`; a `message` result says whether it reached an inbox (`delivered`, `delivery:"live" |
"parked" | "none"`). Hubs declare `activity_msg:1` in PEER_HELLO; the board head's `remote_hosts[]` gets `msg:true` for them.
v1.72.0 (#86): the page's details section reads a node's details / data with the existing `{type:"activity", query:{entry:{id,
host}}}` (the line's entry id from the board) — no new frame, request kind or capability.

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
Since v1.56.0 (#72) every grant **change** is also **announced** to the granted project, not only to a pending
requester: a **`project_access_granted`** notice (mode, one-way vs bidirectional, TTL/expiry, granter) goes to its live
sessions / sub-peers / pages mesh-wide and is **parked** for its offline durable registrations; `revoke_project` sends
**`project_access_revoked`** the same way. Only the bridge where the call was made announces (a grant learned by gossip
never does), an identical re-grant (same mode + TTL) is not re-announced, and the notice rides the `system` consent
exemption (below) because it runs granting → granted, which a one-way grant leaves closed — see §13 v1.56.0.

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
- **Built (v1.75.1):** *A plan node's bar is its items only (Robin, 2026-10-03; reverses 6c decision 7).* `rollup` (lib/activity.js)
  and the dashboard's `rollKids`: a node holding any plan item gets "N of M done" over its items (questions still count as items);
  its helper agents and contexts keep their own bars on their own rows; a node with no plan items rolls up its children as before.
  Seen live on #88: an open plan showed a full green bar because two finished helper agents' bars won. Wire-compatible (format v5).
- **Built (v1.75.0):** *#90 — change an answer from the dashboard; a question's status entries carry their own details; open
  questions never go stale.* **Wire-compatible with 1.66 – 1.74** (format stays v5). **The bug (Robin, 2026-10-03):** expanding a
  question's "answered by …" entry showed the QUESTION's background — `apply` copied the line's details / data onto a status change's
  ENTRY (to keep them on the line), and the entry's id WAS the line's id, so `findEntry` answered the entry fetch with the line.
  Now (`lib/activity.js` `apply`): a question's status change (answer, change, withdraw, expiry, an abandon / cascade that withdraws
  it) keeps the LINE's id (the ask entry's), details and data, and its ENTRY gets `questionEntryDetails(prev, next, text)` — the
  answer (choice, note), who + when (`stampText`: local time + UTC offset), a changed answer's previous one, a withdrawal's note or
  why, an expiry's window, a one-line `Question: …` reminder; ≤ 4 KB; no data. The record carries `line_id` / `line_details` /
  `line_data` for the replay (`lineOf`); `lookupActivityEntry` strips them from an entry it serves. The entry TEXT names the answer
  (`answerEntryText`): `answered by robin via dashboard (HOST): "SQLite" — note: smaller to ship` (free text alone quoted).
  **`change_answer`** {choice?, text?} (`REVISE_ACTIONS`): on an ANSWERED question only (`question-open` / `question-closed`,
  `no-change` for the same answer, else `answer`'s checks); a new entry `answer changed by …: "…"` (`act:"change_answer"`); the
  question stays answered with `revised` (count) + `previous` {answer, by, at} (`normQuestion` keeps both, bounded like the answer;
  boards / gossip / records / the waiter's view carry them). Notice: `activity_answer` at once, `status:"revised"`, `answer` +
  `previous` + `revised`, subject "robin changed the answer to <path>: <first words>". Waiters: none released (the question never
  reopens); `--wait-answer` returns the latest answer. **Capability:** PEER_HELLO `activity_revise:1` → `p.act.revise` →
  `remote_hosts[].revise`; a 1.75 gateway refuses to forward change_answer to an owner without it (`owner-unsupported`, "older
  than 1.75.0"); `AI_BRIDGE_TEST_NO_ACTIVITY_REVISE=1` (tests). **Stale:** `staleAt` / `effectiveState` treat an OPEN question like
  a plan item (never stale, never gone); the dashboard's `effState` too, except its host down → stale + "host down". **Dashboard:**
  Change answer… (menu + a click on an answered row, for `hostRevise`), `actAnswerDlg` in change mode (prefilled, "Current answer:",
  `checkChange`), facts "Answer … (changed)" / "Answer changed" / "Previous answer" (`byWho`), the row tooltip's "(was: …)".
  Tests: `test_activity_unit` 879 (+30: the entry details per status, ids, findEntry, the log, change_answer + refusals + notice +
  waiter view, gossip, replay incl. a 1.74-shaped record set, stale, 2 seeded replay == apply runs with changes),
  `test_dashboard_activity` 344 (+16), new `test_activity_revise_live` 23 (20 FAIL on 1.74; + 2 mixed against a real 1.74 build:
  25/25); `test_activity_ask_live` expects the quoted entry text.
- **Built (v1.74.0):** *#89 part 2 — realm guides, pulled not pushed.* `behaviors.realm` gains an optional `guides`
  `{ agent?: { text, min_bridge? }, session?: { text, min_bridge? } }` (`lib/realm-defaults.js` `checkGuides` / `normGuide`):
  each text a string or an array of lines, ≤ 4096 UTF-8 bytes (separate from the 365-char reminder cap), newline / tab the only
  control characters, `min_bridge` a version ("1.75" → "1.75.0"); an invalid guide is DROPPED, never cut, and the bridge logs why
  at load; the rest of the record stands. **Replication:** the guides are part of the one LWW realm record, so they ride
  `PEER_ROSTER.realm_defaults` / `ROSTER.realm_defaults` / `REALM_DEFAULTS` and the per-host `.rdef` store exactly as the
  reminders do (a newer record replaces or clears them). `beatsRealm`'s tie rule gained a step — updated_at, default JSON,
  **guides JSON**, origin — so the record WITH guides beats the same record without them: a 1.66 – 1.73 host accepts the record,
  drops `guides` and re-gossips a guide-less copy with the same `updated_at`, which must not block the real one on a 1.74 host
  (merge stays a total order: idempotent + commutative). Guides therefore travel only across 1.74+ hops. **Serving (pulled):**
  never in `register_self` or a connect reminder. A logger link's `{type:"guide", ref, kind, cmd?, path?, script?}` →
  `{type:"guide", ref, ok, kind, text|null, source:"realm"|"builtin", updated_at, origin?, reason?, min_bridge?, gateway}` on
  the gateway (`serveGuide` / `loggerGuide`): the realm text rendered by `lib/log-snippet.js` `guideText` (`{cmd}` `{path}`
  `{gateway}` `{script}`; any other `{word}` untouched) + `gatewayNote` (the capability note, appended whatever the source);
  `text:null` (reason `none` | `min_bridge`) tells the script to use its own built-in text. `min_bridge` is checked against the
  LOWER of the requester's version (the frame's `script`; none = never meets one) and the serving gateway's. A ≤1.73 gateway
  answers the frame `{type:"logged", result:{code:"bad-op"}}`. `aimb-log --guide` asks only a ≥1.74 gateway (the welcome's
  `bridge_version`), waits ≤ `AIMB_LOG_GUIDE_MS` (2500), and falls back to its built-in text on an old / unreachable / mute
  gateway or `text:null`; its last line (`guideSourceLine`) names the source. The **`log` tool's `guide:"agent"|"session"`**
  (with as + secret; only `path` beside it, else `bad-guide`) is served in the tool's own process from the record it holds
  (a follower's came in the gateway's ROSTER), always as text: the realm's, else the bridge's built-in with `{cmd}` = the
  session's `logCmd`. Wire-compatible with 1.66 – 1.73 (one new optional record field, one new logger frame type). Tests:
  `test_lib_unit` (+23: validation, the 4 KB byte cap, placeholders, `min_bridge`, the tie rule with a guide-less relay,
  commutativity) and new `test_realm_guides_live` (31; +4 with `AIMB_TEST_OLD_BRIDGE` = a real 1.73 host).
- **Built (v1.73.0):** *#89 — the agent and session guides come from the script.* `aimb-log --guide agent|session` prints
  the how-to (`agentGuide` / `sessionGuide` in `lib/log-snippet.js`), tailored to the gateway it asks (≤1.5 s; flags the gateway
  can't serve are left out or named). `{log_snippet}` is now the command + one line pointing at `--guide agent`. No wire change.
- **Built (v1.72.0):** *#86 + #87 — a node's details and data on the dashboard; the log panel oldest first.* **Page only, no wire
  change** (format stays v5; `BRIDGE_VERSION` 1.72.0 so the mesh map shows who has the page; wire-compatible with 1.66 – 1.71).
  **#86 — the details section** (`dashboard.html` `actRenderDetails`): the log panel became a column — header, a collapsible
  DETAILS section (≤ 45vh, its own scroll), the entry list (its own scroll) — and the section shows the selected node (or a
  session's own line on that host): the rendered line, then `AimbAct.nodeFacts` (pure, plain-text `{k, v}` pairs: kind, state
  incl. stale / gone / host down / item state, the three-part `barTip`, `etaTip`, who = session · project · user on host, when
  the line was set and by whom — #83's `current.by`, when = started · last activity · finished / gone, a question's choices /
  asked / expires / answer / who answered, the subtree's entry count), then the line's `details` and `data`. **On demand by
  entry id:** gossip and the boards carry only `current.id` + `has_details` / `has_data` (unchanged since v1.60 `snapLine`), and
  the v1.60 `activity {entry:{id, host}}` request already serves a CURRENT line by id from memory on its owner (`findEntry` →
  `lookupActivityEntry`; another host's over `ACTIVITY_REQ` op `entry`, queued at the owner's rate) and an older entry from the
  day file — so no request kind was added and every v5 owner (≥ 1.65) answers; a mixed live check against a real 1.71 owner
  passed. The page fetches outside the render (`setTimeout 0`, a failed send answers at once), one at a time per node (`detNk`
  / `detId`), keeps the last entry shown per node while a newer line's is in flight (`detShown`, "updating"), fetches nothing
  while folded, caches entries (≤ 240, oldest dropped) and turns refusals into sentences + Retry (`detErrText`:
  owner-unreachable, owner-unsupported, unknown-entry, busy / rate-limited, unknown-host). **Escaping:** the details / data
  block (`ddBuild`) and `AimbAct.jsonTree` use DOM nodes + `textContent` only; `actReconcile` gained BUILD rows (`{build, sig}`:
  rebuilt only when the signature changes, so a viewer's open / closed JSON nodes survive the 1 s re-render and unrelated
  deltas). The JSON tree: `<details>` per object / array ("{ 3 keys }" / "[ 2 items ]"), open to depth 2, > 50 children start
  closed, depth > 40 → "…", type classes on theme tokens; Copy = `JSON.stringify(data, null, 2)`. Log entries expand into the
  same block (6d printed a `<pre>` of JSON). **Markers:** `ddMark` — "¶" (details) / "{}" (data) inside a tree row's line
  (after ✎, via `lnMark`, so the bar column is untouched) and on log entries (replacing 6d's "⋯").
  **#87 — the order** (Robin: oldest first WITH a toggle). `AimbAct.logRows(entries, sepAt, oldest)` maps the bridge's
  newest-first pages to the display order (the "— earlier runs —" separator between the runs either way); the end-of-log row
  ("load older…", "show earlier runs…", pruned, …) goes on top when oldest first. **Following:** `ACT.follow` = the reader is
  within `EDGE_PX` (24) of the newest end (`atEdge`; set by the list's scroll events); following, every render pins the list to
  that edge; not following, `logAnchor` / `logScrollFix` keep the first visible ENTRY at the same offset across the render (so
  a page prepended above or entries appended below never move the view) and `ACT.newN` counts what arrived — the "N new ↓"
  chip (↑ newest first) jumps back and follows. **New entries are MERGED** (`actPollLog` + `AimbAct.mergeNewest`): when the
  board's count for the selection moves (≥ 1.5 s after the last read) or after a dashboard action, the first page is read
  again and only the newer entries go on top of the held list (older pages, `next_cursor`, `sepAt` kept — 6d re-read the
  whole log, and not at all once an older page was loaded); no overlap → the page replaces the list. The toggle (`data-pa=
  "order"`) flips `ACT.logOrder`, kept per viewer in `localStorage` `aimb.act.logOrder` (try/catch both ways; a throwing
  storage = oldest first, the toggle still works in memory). Tests: `test_dashboard_activity` 327 (+42: the pure helpers,
  the section, on-demand fetch, escaping, Copy, the tree surviving deltas, folded = no fetch, remote + refusals, entry blocks,
  a fake layout for follow / chip / load older / newest first, throwing and stored storage on fresh pages, CSS; 6 order checks
  updated), new `test_activity_detail_live` 14 (+1 mixed vs a real 1.71 owner).
- **Built (v1.71.0):** *#85 — questions as a type of context, answerable from the dashboard.* **Wire-compatible with 1.66 –
  1.70** (format stays v5; hosts upgrade one at a time). **The model (`lib/activity.js`):** a question is a CONTEXT whose current
  LINE carries `question` = `{status, choices, free, asked_at, expires_at?, answer?{choice?, text?}, by?, at?}` (`normQuestion`:
  bounded — ≤ 8 distinct choices of ≤ 60, an answer only when answered, its text ≤ 1000, `by` / `at` only once closed); the
  line's text is the question. It rides the line exactly as #83's `line_by` does — the entry record's `question` (+ `line_text`
  when a status change logs another text), a cp's / cf's `current.question` (`fullLine`), gossip `current.question`
  (`snapLine` / `wLine`; never on an agent), `lineView` / `rawLine` (`questionView`: `by` as `{user, host}` or `"bridge"`), the
  replay's `lineOf` — so nothing new on the wire or in the files. **Status → line state** (`QUESTION_LINE_STATE`): asked =
  `blocked`, answered = `done`, expired / withdrawn = `abandoned` — what a 1.70 host (which drops `question`) shows.
  **Asking:** `parseMessage` hands `ask` / `choices` / `free` / `expires` to `parseAsk` (the question literal, ≤ 240 code points
  or `question-too-long` — never cut; ≤ 8 choices × 60, distinct, `bad-choices`; `free` defaults to "no choices"; `expires` >
  0 and ≤ 7 d → `expires_at`; no text / state / bar / plan / move / position / log:false — `bad-ask`; the address + details /
  data / stale_after parsed the usual way) → `msg.ask`; `apply` → `applyAsk` picks the node — the addressed CONTEXT when it is
  new, line-less with no children and not a plan item, or already a question (an open one → `question-open`); else a new child
  `?<n>` (1 + the highest `?<digits>` sibling; `path-too-deep` past 6) — then applies a logged `@~` line (blocked) with
  `opts.question`. **Closing:** `apply` takes the line's new question from `opts.question` (an answer, the expiry, applyAsk);
  `state:"withdrawn"` (`parseWithdraw`: a keepText tick, state abandoned, `msg.withdraw {note}`, `not-a-question` /
  `question-closed`) withdraws it ("withdrawn: <note>"); a keepText `abandoned` tick on an OPEN question (an ancestor's
  cascade, `abandonPlans`, the 6d `abandon` — i.e. a 1.70 dashboard) withdraws it too, attributed; any other line on a
  question node → `question-node` (a log-only message is fine). A status change keeps the line's details / data.
  **Actions:** `ACTIVITY_ACTIONS` + `answer` (`args {choice?, text?}`: a choice matched case-insensitively to its canonical
  spelling, `bad-choice`; text only when `free`, ≤ 1000, newlines kept; `bad-args` when neither / not allowed; `not-a-question`,
  `question-closed`; an `@~` done tick with `opts.question` answered + `by` + `at`, entry "answered by <user> via dashboard
  (<host>): <answerText>", `act:"answer"`, no cascade, no activity) and `withdraw` (→ withdrawn, "withdrawn by …");
  `ASK_ACTIONS` = those two. `edit_text` on a question is `question-node`. **Expiry:** `expireQuestions(state, now)` closes every
  local open question past `expires_at` as a SYSTEM line by the bridge ("expired — nobody answered within 10m") → `{records,
  expired:[{ident, path, text, question, entry_id, agent}]}`; `nextQuestionExpiry(state)` for the timer. **Rollup / plans:**
  `rollup` counts question children as ITEMS (open = remaining, answered = done, closed unanswered = skipped); `planOf` adds
  them to a node's plan only when it already holds plan items (an open question keeps that plan open; `openPlanKeys` then
  protects it); `activeHidden` hides closed questions of an ended plan. **Notices:** `answerNotice` (via `actionNotice` for
  answer / withdraw, directly for an expiry) → verb `activity_answer` (`ANSWER_NOTICE_VERB`), PUBLIC subject "robin answered
  <path>: <firstWords(question)>" / "robin withdrew …" / "question expired …" — never the answer; body `{action, status,
  path, host, question, choices, free, answer?, by, entry_id, session, project, agent (the asking agent's path, null = the
  session), asked_at, ts}`. **The waiter's view:** `questionOutcome(state, sess, node)` → `{outcome open | answered | expired |
  withdrawn | gone, …}` (gone = the node or its session left the board, or it is no longer a question). **Bridge:** PEER_HELLO
  **`activity_ask:1`** (`p.act.ask`; `AI_BRIDGE_TEST_NO_ACTIVITY_ASK=1` omits it), `actRemoteInfo` `ask:true`; `activityAction`
  forwards `ASK_ACTIONS` only to an owner that declared it (else `owner-unsupported`, before queueing); `actActionQuery` passes
  `args.choice`; `actApplyAction` settles the waiters FIRST (`released`), then sends an `activity_answer` with `{now:true}`
  (like #84's message: `delivery`; `not-delivered` only when no inbox AND no waiter) and returns `released` + `question`.
  **Waiting:** a logger link's `{type:"wait_answer", ref, path, timeout_ms ≤ 24 h}` → one `{type:"answer", ref, result}`
  (`loggerWait`: the logger's own session; `bad-path` / `unknown-node` / `not-a-question` / `busy` — 16 per link, 1024 per
  gateway); the waiter holds the node object and `actSettleWaiters` (called from `actChanged` — every local board change —
  and before an action's notice) releases it as soon as its outcome isn't open; its timer answers `timeout`; a closed link drops
  its waits. **Expiry timer:** `actScheduleExpiry` (re-armed by `actChanged`) fires at the next `expires_at`;
  `actExpireQuestions` persists the records, notifies each session at once and calls `actChanged` (the GC tick is a safety
  net; a restart past an expiry closes it after the replay). The follower refuses `usesAsk` input against a ≤1.70 gateway
  (`gateway-unsupported`). The server instructions and the `log` tool's description: an `activity_answer` is the viewer's answer
  to a question the session itself asked — it may proceed on it within what its user already approved. **Script
  (`tools/aimb-log.mjs`):** `--ask` / `--choice "A"` (ONE choice per flag, repeatable — like `--item`, so no argument is positional; status text or a flag as its value is refused) / `--free` / `--expires`; `--wait <dur>` (≤ 24h)
  turns a one-shot ask into ask-then-wait on the SAME link; `--wait-answer --path <q> [--wait 30m]`; a dropped link is
  re-dialled and the wait resumed; exit 0 answered · 10 timeout · 11 expired · 12 withdrawn · 13 gone; ≤1.70 gateway →
  `gateway-unsupported`. **Snippet:** a seventh guidance line in `{log_snippet}` (`--ask "…" --choice "A" --choice "B" --wait 30m waits
  for the answer (exit 0 = answered).`) and `{log_tool_hint}` (`ask:"…", choices:[…] … activity_answer`), ≤ 110 characters
  each. **Dashboard:** `questionGlyph` (a speech bubble: "?" filled fuchsia — `--ask` / `--ask-bg` tokens, light + dark —
  answered ✓ green, expired / withdrawn dashed grey), `qOf` / `isQuestion` / `isOpenQuestion`, an open question's row tinted
  with an accent edge + "awaiting answer" pill, an answered one "→ <answer>" after the question; `buildTree` counts open
  questions under every node on the whole tree (`t.nq`, the session's / project's `nq`) → the **"? N" badge** on a collapsed
  row and always on session / project rows, and "? N open questions" in the section tag; `rollKids` counts questions as items;
  `menuFor` `question` + `can_ask` (`hostAsk`: this gateway or `remote_hosts[].ask`) → Answer… / Withdraw question… (asks
  first), and no Edit text… / Abandon… on a question; a click on an open question opens `actAnswerDlg` (`actFormDlg`: the
  question, choice buttons as a radio group, a text box when free, `checkAnswer`, ≤ 1000) → `answer {choice?, text?}`; `actDo`
  toasts who got it (a waiting script, the session, parked) or "⚠ answered · nobody was waiting"; the legend. **Mixed versions
  (live, loopback):** a 1.70 (`git archive HEAD`) and 1.71 bridges — the 1.70 board shows a question as a blocked context with
  its text (no `question`), answer on the 1.70 owner `owner-unsupported`, the 1.70 dashboard's Abandon… withdraws a 1.71
  question, a 1.71 script's `--ask` against the 1.70 gateway `gateway-unsupported`: 41/41 with `AIMB_TEST_OLD_BRIDGE` (4 checks;
  37 without). **Tests:** `test_activity_unit` 849 (+51, incl. 4 seeded replay == apply runs with asks, answers, withdrawals,
  cascades, expiry and moves), `test_dashboard_activity` 285 (+26; the legend now has 20 glyphs), `test_activity_6c_live` 34
  (+1: the seventh snippet line), new `test_activity_ask_live` 37 (+1 after review: `--choice`, one choice per flag, replaced `--choices`). Full parallel `npm test` (typecheck included): 2684 checks in 58 files, all green (5m04s) — the run before it had one load failure in `mesh/test_mesh` (a bridge child closed mid-test, "Connection closed"; 22/22 alone three times, untouched by #85).
- **Built (v1.70.0):** *#83 + #84 — Edit text… and Message session… from the dashboard.* **Wire-compatible with 1.66 – 1.69**
  (format stays v5; hosts upgrade one at a time). **Actions (`lib/activity.js`):** `ACTIVITY_ACTIONS` + `edit_text` and
  `message`; `MSG_ACTIONS` = those two (a ≤1.69 owner answers `bad-action`). **`edit_text`** (`args:{text, state?}`) on any node
  (the session root too): `editStates(sess, node)` = what a report could set there (a plan item: every state; another context:
  no todo / skipped; an agent / the session: running · blocked · failed · done · idle, + abandoned only while it holds plan
  items) → else `bad-state`; `bad-args` (no text), `no-change`. The message is parsed with a placeholder text and the text set
  afterwards (LITERAL: no `@ctx` prefix parsing; `normText`; > 240 → 239 + "…", `text-truncated`, the report rule); no state =
  the line's (an edit never starts a ☐ item); the line's details / data are carried over. Applied through `apply` as a SYSTEM
  `@~` line (`by`, `act:"edit_text"`, `entryText` = the line + " (edited by <user> via dashboard (<host>))" fitted to 240), so
  no activity, the abandon cascade if abandoned. **The line's attribution:** `ActivityLine.by` (a normBy object) = who wrote
  its TEXT when not its session — set by `edit_text`, kept by a keepText tick, cleared by any other line (the log:false
  "same line" shortcut now also compares `by`, so a session re-sending the edited text takes it back); records carry
  `line_by` (entries, a cp's / cf's `current` via `fullLine`), the replay's `lineOf` reads only `line_by` (never an entry's
  own `by`), gossip's `snapLine` / `wLine` carry `by` (bounded by `normBy`), `lineView` / `rawLine` give `by:{user, host}`.
  Result: `from_text`, `new_text` (+ the 6d / #80 fields). **`message`** (`args:{text}`, `MESSAGE_LIMITS` 2000 code points /
  a 120-character preview): `msgText` keeps newlines / tabs, drops other control characters; `bad-args`, `message-too-long`;
  ONE non-current SYSTEM entry on the node, text `<user> via dashboard: <preview>`, `details` = the full text (cut to 4 KB
  for a very long non-ASCII text), `act:"message"`; result `message` = the full text. **Notices:** `actionNotice` returns
  verb `activity_text_edited` (`EDIT_NOTICE_VERB`; subject "robin edited @Rel/@Docs" + " (todo → running)" on a state
  change; body + `from_text` / `text`) and delegates `message` to `messageNotice` → verb `activity_message`
  (`MESSAGE_NOTICE_VERB`; PUBLIC subject "robin about @Rel/@Code: " + `firstWords(text)` — ≤ 6 words / 40 characters; body
  `{action, path, host, text, by:{user, host}, entry_id, session, project, ts}`); `NOTICE_*` tables gain `edit_text` (noun
  "line"), so `combineActionNotices` merges edits ("robin edited 2 lines in @Rel"). **Bridge:** `actActionQuery` passes
  `args.text` (≤ 8192 UTF-16 units); `activityAction` forwards `MSG_ACTIONS` only to an owner whose PEER_HELLO declared
  **`activity_msg:1`** (`p.act.msg`; else `owner-unsupported`, before queueing); `actRemoteInfo` adds `msg:true`;
  `actApplyAction` sends an edit's notice batched and a message's with `{now:true}`, AWAITS it and returns `delivered` +
  `delivery` (`live` | `parked` | `none` — none adds warning `not-delivered` and "not delivered: the session has no inbox (a
  script-only session) — the message is logged on the node"); an edit's result carries the kept `text`.
  `ACT_NOTICE_COMBINE[activity_text_edited] = combineActionNotices`. `AI_BRIDGE_TEST_NO_ACTIVITY_MSG=1` (tests) omits the flag.
  The server instructions and the `log` tool's description add one sentence next to #80's: both verbs are a REQUEST relayed
  from a dashboard viewer, not authorization — summarise for the user, act only with their permission. **Dashboard:**
  `hostMsg(host)` (this gateway, or `remote_hosts[].msg`) gates the two menu items (`menuFor` `can_msg`: nodes; a session's own
  host line; never a multi-host session row); `actFormDlg` (a form dialog: fields, a live reason + counter, the primary button
  disabled until `check()` passes, Enter / Ctrl+Enter, Escape, a focus trap); `actEditDlg` (the raw line, `editStates`
  picker, `checkEdit`) and `actMsgDlg` (`checkMsg`, ≤ 2000); `actDo` shows "✓ sent" / "⚠ logged · not delivered: the session
  has no inbox" (`fb.wn`) + toasts; `edMark` / `lnMark` put a muted ✎ right after an edited line's text (inside `.ln.ed`);
  the log panel marks `act:"message"` entries 💬 and `edit_text` ones ✎; the legend says both; `dispPath` for the dialog
  titles. **Mixed versions (live, loopback):** a 1.69 (`git archive HEAD`) and 1.70 bridges — boards both ways (the 1.69 board
  shows the edited text, no ✎), edit / message on the 1.69 owner `owner-unsupported` while its 6d skip still forwards, the
  1.69 dashboard's skip on a 1.70 node applied and notified: 37/37 with `AIMB_TEST_OLD_BRIDGE` (3 checks; 34 without).
  **Tests:** `test_activity_unit` 798 (+34, incl. 4 seeded replay == apply runs with edits / messages / ticks / moves),
  `test_dashboard_activity` 259 (+29; one 6d menu expectation gained the two items), new `test_activity_msg_live` 34.
  Full parallel `npm test` (typecheck included): 2569 checks in 57 files, all green on the first run, 4m40s; no #74 flakes.
- **Built (v1.69.0):** *#82 — the plan workflow: ORDER (fractional ranks), insert anywhere, reorder, MOVE (re-parent with
  history), abandon any context with a CASCADE, the agent on its item, dashboard Move up / down / to + drag and drop.*
  **Wire-compatible with 1.66 – 1.68** (format stays v5; hosts upgrade one at a time). **Order (`lib/activity.js`):** a node's
  position among its siblings is a fractional rank — base-36 (`RANK_DIGITS`), compared as text, never ending in `0`
  (`validRank`, ≤128 chars); `rankBetween(lo, hi)` = the classic midpoint (shared prefix, the middle digit, else one more
  digit). Most nodes store NO rank: `rankOf(n)` = the stored one, else `derivedRank(created_at, plan_ix)` = 9 base-36 digits
  of the creation ms + 2 of the plan position + `i` — so the default is creation order (1.68 nodes and every unplaced 1.69 node
  alike) and a later node sorts after. A rank is STORED only when a node is placed; an open end is bounded by
  `derivedRank(now + 1)` so later nodes still go after. `siblingCmp` = group (`rankGroup`: plan items 0, contexts 1, agents 2)
  → rank → key; the board gives every node `rank` (+ `rank_set`). **Messages:** `parseMessage` takes `before` / `after`
  (`parseAnchor`: `"@X"` a context, a bare name an agent first, else a context) / `position` (first | last), at most one
  (`bad-position`); with a plan they place the NEW items (k ranks between the neighbours, in order — `placeRanks`; existing
  names never move: `position-unused`), else the target (a `posOnly` message — no text — writes one logged, non-current entry
  "placed before @Y" carrying `rank`; with text it is a normal message that also places). An anchor must be a sibling of the
  same group (`unknown-anchor`, `bad-anchor`). **Move:** `move` + `to` (relative to path / agent, `/` = absolute; `parseMove`,
  no text / state / bar / plan: `bad-move`) → `applyMove`: re-keys the node and its subtree (`rekeySubtree`: nodes, kids, the
  parents' child sets, cpLive, a dismissal entry's path), creates a new parent path implicit, places it (default: the end of
  its group; a same-parent move with a position = a reorder; `no-change`, `target-exists`, `path-too-deep`, `unknown-node`),
  appends `{from, at}` to `node.moved` (≤8) and writes ONE logged entry at the new path ("moved by <session | user via
  dashboard (host)> from … to …", `moved_from`, `rank`). A session's own move counts as its activity; a dashboard's is a
  system entry. **Replay:** a move record registers `{fromKey, fromLen, toSegs}` on its session (even when skipped); every
  OLDER record is replayed through the moves made after it, oldest first, NODE BY NODE (`remapSegs` per chain prefix): the
  target and its current chain take the record as before, an OLD parent the node moved away from keeps the record's
  created_at / activity (created if nothing else names it; skipped when it ended since — `goneAt`: dead, a dead ancestor, or a
  sealed ancestor with nothing moved in after the record), the new parents never see it. A node that got where it is by a
  move made after the record owns the record only if that move carried it (`foreign` — else it is a dead instance's record
  landing by name). Sealing (`sealRuns`) seals each run of the record's chain as it is now; a node moved in under a sealed
  node at or after the sealing record (`movedAt`) is left out, the moved node is never sealed by its own move record. A
  dismissal / an `evicted` path follows only its PARENT's moves (`remapGone`). Two pre-6d replay gaps closed on the way: a
  dismissal's entry is attached even when its name was used again later; a record skipped for an ended descendant still
  keeps its ancestors (an implicit parent emptied by a dismissal survives a restart, with the session). Proven by the seeded
  replay == chronological-apply test, now with moves / placements / abandons / dashboard actions / expiry in the mix (10
  seeds in the suite; 400 + 200 seeds fuzzed during the build). **History under the old path:** `nodeAliases(sess, node,
  subtree)` → `{aliases:[{key, depth, base, before, after, start}], after}` from the moves of the node, its ancestors and (a
  subtree log) nodes moved in under it; `logView`'s file target carries them; `fileEntryMatches` / `fileRunStart` accept a
  record under an alias in its time window (a record at the current path before the latest move belongs to an older
  occupant), a move record is never the moved node's run start, and `fileEntryView` shows an alias entry at the node's path
  now. Counts move with the node (memory) and are rebuilt from the remapped records. **Persistence:** cp + cf carry `rank`
  (null = derived); cf carries `moved`; `carryDue` re-carries a stored rank / a move history the window would lose (`pt.r`,
  `pt.m`). **Abandon:** `abandoned` on ANY context (an agent / the session still only when it holds plan items); an `@~`
  abandoned line cascades (`cascadeAbandon`): every context under it, not crossing another agent, that is open (todo /
  running / blocked) or holds an open plan gets an abandoned line, deepest first, logged "abandoned with <path>" (+ the
  attribution), `cascade:[{path, from}]` on the result (abandon_plan / auto-abandon report theirs in `applied` too).
  **Actions:** `ACTIVITY_ACTIONS` + `move` (args.to + a position) and `reorder` (args.before | after | position);
  `PLAN82_ACTIONS`; `abandon` on any context; notices "robin moved @Next/@B to @Later" / "robin moved @Next/@Y before @X"
  (body `moved_from` + `to` / `where`; nouns "node" in a batch). **Wire:** gossip nodes carry a STORED rank only (a 1.68
  receiver ignores it); PEER_HELLO `activity_plan:1`; a 1.69 gateway forwards move / reorder only to such an owner (else
  `owner-unsupported`) and lists `plan:true` in the board head's `remote_hosts`; `actActionQuery` passes args.to / before /
  after / position; a follower and the script refuse the new `log` fields against a ≤1.68 gateway (`usesPlan82` →
  `gateway-unsupported`). **Tool / script:** `log` gets `before` / `after` / `position` / `move` / `to` (+ result `rank`,
  `moved`, `cascade`); `aimb-log` `--before` / `--after` / `--first` / `--last` / `--move` / `--to`. **Dashboard:** siblings
  by group + rank (`cmpRank`; `rankOf` fills in for an old bridge); a plan item shows its working agent (`workingAgent`: its
  glyph, name, current line) beside its box even closed; an abandoned node greys its whole subtree (`abd`); right-click Move
  up / Move down (`moveSteps`), Move to… (`moveTargets` picker → a confirm; `canMoveInto`: same host, not into itself, not its
  parent, depth, no name clash), Abandon… on an ordinary context (confirmed); drag and drop (`dropPlan`: a sibling of its kind
  → reorder before / after, another node → move into it, confirmed); only for a host that applies them (`hostPlan`).
  **Mixed versions (live, loopback):** a 1.68 (`git archive HEAD`) and a 1.69 bridge exchanged boards both ways (the 1.68
  board shows the move as removal + new node, no rank), 6d actions worked both ways, a move on a 1.68 node was refused
  `owner-unsupported`, the 1.69 script refused `--before` against the 1.68 gateway — 11/11. Downgrading a host after a move
  is not supported (a ≤1.68 replay would rebuild the moved node at both paths). **Tests:** `test_activity_unit` 764 (+70),
  `test_dashboard_activity` 230 (+25), new `test_activity_plan82_live` 26; 4 dashboard / unit expectations changed with the
  new rules (contexts sort before agents; abandoned on an ordinary context; the cascade in a 6c rollup; the menu's Move items).
  Full parallel `npm test` (typecheck included): 2472 checks in 56 files, all green on the first run, 4m17s.
- **Built (v1.68.0):** *#80 — a dashboard action TELLS the owning session.* Before, a right-click action (6d) was only
  logged on the node, so an orchestrator could keep working on an item a person had just skipped or abandoned.
  **Wire-compatible with 1.65 / 1.66** (no frame or format change; hosts upgrade one at a time — a ≤1.66 owner just sends
  no notices). **When:** after every APPLIED state-changing action — `done`, `skip`, `reopen`, `abandon`, `complete`,
  `abandon_plan`, `reopen_plan`, `finish`, `dismiss` — by the gateway that applied it, i.e. the node's OWNER (a forwarded
  `ACTIVITY_ACT` is applied and notified by the owner, not by the dashboard's host). Copy / pin / hide never reach the
  bridge; refused actions and reads send nothing. **Model (`lib/activity.js`):** `applyAction` now also returns what the
  notice says — `ident` (the session's realm / project / user / name, canonical spellings), `kind`, the line's `text`,
  `from_state` → `to_state` (read before the action applies; `of:"plan"` for complete / abandon_plan / reopen_plan, whose
  states are the PLAN's: open | done | all-done | abandoned) and `entry_id` (the logged entry that did it); abandon_plan's
  `applied[]` carries each item's `from` + `entry_id`. Two pure builders: `actionNotice(r, {by, host, ts})` → `{verb:
  "activity_changed", subject, body}` — subject "robin skipped @Dash test/@Docs" (quotes dropped; the root = the session's
  name; "… the plan of lead" / "… the open plans of lead" for an agent), body `{action, path, host, from_state, to_state,
  of?, by:{user, host}, entry_id, session, project, text, ts, items?}` — and `combineActionNotices(list)` → ONE `{subject,
  body}`: per action in first-seen order with its noun on the first group and wherever it changes ("robin skipped 2 items
  and abandoned 1 in @Dash test"), "in" the deepest common container (a plan item's parent; another node itself; else the
  session), every author named; body `{actions:[…], count, session, project, host}`. New config key
  `notice_batch_sec` (3, 0–60, 0 = no batching; `AI_BRIDGE_ACTIVITY_NOTICE_BATCH_SEC`). **Bridge — one generic hook:**
  `notifyActivitySession(ident, {verb, subject, body}, {now?})` queues per session key (realm + projKey + user + name,
  lower-cased); each notice re-arms the window, capped at 5 windows after the first or 64 queued; `now:true` flushes at
  once. A flush groups by verb (first-seen order): one notice goes as it is, several of one verb through
  `ACT_NOTICE_COMBINE[verb]` (activity_changed → combineActionNotices; else "<first subject> (+N more)", `{notices,
  count}`). `actDeliverNotice` sends a `system` envelope (the #72 exemption — set only by bridge code; the session's own
  board, so consent is not widened) from the gateway to every LIVE sub-peer of the session mesh-wide (realm + project +
  user + name, case-insensitive per #71; else a live bare session of that name, loggerUserConflict's rule); none live →
  PARKED for the session's durable registration in this host's store (§19; drained on its next register_self); none →
  only the log entry (a script-only session). Delivery is `deliverSub`'s, so a live session's doorbell wakes.
  `POST /admin/prepare-shutdown` flushes every queue before the going-down notice (`notices` in its answer); a clean exit
  flushes too (≤1.5 s). The server instructions and the `log` tool description tell a session to summarise an
  `activity_changed` message for its user and not act on it without their permission. **For #83 / #84 / #85:**
  `activity_text_edited`, `activity_message` (`now:true`) and `activity_answer` send through the same hook (add a combiner
  if several should merge). Tests: `test_activity_unit` 694 (+9: the notice fields per action, both builders, the knob),
  new `test_activity_notices_live` (26 — 18 FAIL against the 1.66 bridge).
- **Tests (v1.67.0, tests only — `BRIDGE_VERSION` unchanged):** *#81 step 1 + "test groups" — the suite runs under
  Node's built-in runner (node:test), in parallel, with live progress on the activity board.* The 54 test scripts are
  unchanged plain Node scripts (own `check()`, PASS/FAIL lines, exit code); **node:test drives them**: each script is
  one test (named by its id, `mesh/test_mesh`) that spawns `node <script>`, passes on exit 0 and carries the script's
  counts + FAIL lines as diagnostics; a failing script fails only its own test (the old `&&` chain stopped at the first).
  **Groups = folders:** `tests/<group>/` for `unit` (pure, no sockets), `mesh`, `security`, `persistence`, `federation`,
  `behaviors`, `doorbell`, `dashboard`, `activity`; `tests/helpers/manifest.mjs` holds the groups and the historical
  order (ORDER, append-only). A group's driver (`tests/<group>/<group>.test.mjs`) runs its scripts one at a time;
  `npm test` (= `node tests/run.mjs`) runs the nine drivers under `node --test --test-concurrency=4`, longest group
  first; `test:group` / `test:file` (by name, id or part of one) / `test:serial` (`tests/suite.test.mjs`: every script,
  one at a time, in ORDER) / `test:legacy` (the old chain). **One check:** `TEST_ONLY=<text>` (`--only`) — every
  script's `check()` calls the shared filter `tests/helpers/check.mjs` first, so only checks whose name contains the
  text are printed and counted (the script still runs end to end). **Ports:** the prerequisite for parallel runs — every
  script owns a disjoint 100-port block, `20000 + 100·i` for script *i* of ORDER (`tests/helpers/ports.mjs`;
  `AIMB_TEST_PORT_BASE` moves the space; the live 12317/12318 can never fall in it); a script maps its historical
  numbers into its block with `tp(n)` (which throws outside the block). The audit found 12 pairs of files sharing ports
  (e.g. test_mesh / test_dashboard on 7100, test_persist_live / test_offline_park_live on 7982–7985, test_realm_defaults /
  test_log_script on 14000, test_project_case / test_federation_heal on 13800, test_roster_secrets / test_activity_actions
  on 14300) — harmless serially, collisions in parallel. Temp dirs were already per script
  (`mkdtemp`); `test_dashboard` (which WROTE host aliases into `src/config.json`) and `test_page_e2e` (which read the
  live realm token from it) now use a temp config and a test token. **Dashboard reporter**
  (`tests/reporters/aimb-dashboard.mjs`, beside `spec`): with `AIMB_TEST_LOG_SESSION` set it keeps ONE
  `aimb-log --stream` child for the run and reports to `AIMB_TEST_LOG_PATH` (default `@tests`): a plan of one item per
  script (☐ → running → done / failed), a `log:false` progress line every ~10 s ("checks N · file i/T · <running>", the
  #79 three-part bar: done = passed checks; total from a per-script check-count cache; checks a crashed script never
  reached count as skipped), a logged entry per failing script (FAIL lines in `details`), and a final summary.
  `AIMB_TEST_LOG_CONFIG` reaches only the logger child (as its `AI_BRIDGE_CONFIG`); silent without a session, a token or
  a bridge, and never fails the run. Because node:test replays each test file's events only after the earlier files
  have reported, live state comes from a side channel: the reporter creates `AIMB_TEST_STATUS_DIR`, the drivers append
  start / end lines to a per-process file there. **Timings (this 32-thread dev PC):** serial, the old chain: 12m07s before
  the move, 12m11s after (`test:legacy`, 2315 / 2315); `test:serial` 12m07s; parallel `npm test` 3m55s / 3m50s / 3m49s
  (typecheck included; runs 2 and 3: 2315 checks, 54/54 green). The activity group (~205 s) is the critical path;
  scripts did not slow down measurably under 4-way parallelism.
- **Built (v1.66.0):** *#79 — the `--plan` text footgun, THREE-PART progress (done / skipped / total), a done node = 100%;
  plus (same change set) the live-checklist snippet + orchestrator briefing, cyan = in progress, and a session glyph.*
  **Wire-compatible with 1.65** (format stays v5; hosts upgrade one at a time). **Model (`lib/activity.js`):** a progress
  value is `{done, total, unit, skipped?}` — `parseProgress` takes an object's `skipped` or a string's trailing "N skipped"
  ("3/6 1 skipped", "4812/12000 tiles · 100 skipped"; done + skipped > total clamps skipped, `progress-clamped`) and carries
  `skipped` only when > 0, so records, cp / cf and gossip units without it are byte-identical to 1.65 and a 1.65 reader (which
  takes done / total / unit) ignores it; a missing one is 0 (`skOf`). **Rollups carry all three** (`rollupStrategies`): a
  common unit SUMS done, skipped and total; mixed units AVERAGE each child's done fraction and skipped fraction (each child
  weighted 1; skipped ≤ 100 − done); "N of M done" now counts EVERY item in M (replaces 6b/6c's "skipped left out of M"):
  done items → done, skipped AND abandoned items → skipped (`abandoned` = how many of them), todo / running / blocked / idle /
  FAILED items → remaining (failed may be retried); the items bar is marked `items:true`. Every bar carries `skipped` (0 when
  none). **`forceBar`**: a node whose own state is DONE shows done = total, skipped 0 (`forced:"done"`) whatever its reported
  or rolled-up bar said — so it contributes its whole weight to its parent (the live case: a plan marked complete with 1 of
  3 items done showed a partial bar); an ABANDONED node's remainder becomes skipped (`forced:"abandoned"`); failed keeps
  its bar. Reported progress still wins over a rollup (6a's precedence), except for that override. The plan-END rule is
  unchanged (skipped items keep a plan open). **Text:** `{progress}` → "1 of 5 done · 1 skipped" ("61% · 10% skipped";
  unchanged without skipped), `{pct}` = the done %, new `{skipped}`. **Dashboard:** bars draw done (blue; a plan's green),
  then a SKIPPED segment (`b.sk`, a grey hatch from `--bar-skip` / `--bar-skip-2`, light + dark), then the track; a done
  node's bar is full; striped stays the rollup marker; tooltip "1 of 5 done · 2 skipped (20%) · incl. 1 abandoned — its plan:
  5 items". The client rollup (filters on, 6c) mirrors the bridge (`ownBar` / `rollKids` / `force`), and `norm3` widens a
  1.65 bridge's items bar (skipped outside M — `n = total + skipped` gives it away) so the page reads either bridge.
  **`aimb-log --plan`:** a name that looks like status text (`@~…` or "@ctx words") →
  `bad-plan` "… looks like status text — put text before --plan" (exit 64, locally). `--progress` takes the skipped part.
  **Call signature:** `--text "<text>"` (explicit text; exclusive with positional text) and a repeatable `--item "A"` (one plan
  item per flag, joins `--plan`'s names in command-line order); positional text and `--plan` stay for 1.65 snippets.
  **Snippet (`lib/log-snippet.js`):** uses `--text` and `--item` throughout (no `--plan`); the checklist stays live (start an
  item with `--state running --text "<what>"`, tick it with `--done` the moment it is done; keep "@~root …" current); the tool
  form likewise. **Reminders (`config.example.json` `behaviors.realm`, `updated_at` 2026-10-02T12:00Z):** the code one
  briefs an orchestrator (the block into each agent's prompt with `--path` = its unique name + its checklist, or `--plan`
  one first; its own `@~root` current; its agents tracked as its own plan, ticked as they report back); the cowork one the
  same for the `log` tool. Both stay within the 365-char reminder cap so a 1.65 host shows them whole (no new placeholder).
  **Colours / glyphs (dashboard):** green means DONE only — in progress is cyan through one token, `--act-running` (the
  running ring + dot, a context's running mark, the in-progress plan item, running log dots); a SESSION has its own glyph
  (`sessGlyph`: a rounded window whose border is the stale countdown, `rect.ring` pathLength 100; face by client kind — code
  ">_", cowork a bubble, page a globe, else a plain window), one builder for the Activity session rows + host lines, the
  legend, the Sessions table and the mesh map. The bridge adds `client_kind` to each dashboard session unit from the mesh
  roster (`actRosterKinds`, remembered per realm + project + user + name; dashboards only, not the gossip).
  Tests: `test_activity_unit` 684 (+20 #79), `test_dashboard_activity` 205 (+19: three-part bars, labels, done = full, the 1.65 bar widened, client == bridge on one fixture, cyan, session glyphs), `test_log_script_live` 57 (+3: --plan text refusal, text-first plan, --progress skipped), `test_activity_6c_live` 33 (+2: live snippet, orchestrator briefing), `test_activity_dashboard_live` 44 (+1: client_kind); 4 live tests updated for M = every item. Pre-change: 20 lib checks fail against the 1.65 library, 6 dashboard checks (+ the #79 block crashing) against the 1.65 page. Full suite 2313 checks in 54 files (typecheck clean): 2311 passed; the 2 failures were the pre-existing midnight flake in test_dashboard_activity (a fixture "started 1 h ago" gets a date prefix before 01:00 local), which passes when rerun after 01:00. Live check: a 1.65 and a 1.66 bridge exchanged activity both ways, 8/8, no errors.
- **Built (v1.65.0):** *the agent activity board, step 6d — the dashboard's right-click ACTIONS (its first write path), the
  log panel, pin / hide; plus the agent-finish rule, abandon_plan on agents and the exact carried-forward entry count (#70).*
  Decisions of 2026-10-02 ("Decisions before 6c and 6d" + "Decisions after 6c, for 6d"). Nothing of #70 was deployed.
  **Model (`lib/activity.js`):** `planEndAt` takes an agent's / the session's own line OUT of the plan-end rule — finishing
  never completes a plan; a CONTEXT plan node's line done / abandoned still ends its plan; an agent / the session ends one
  only through the new PLAN-END MARKER `node.plan_end = {state: done|abandoned, ts}` (set / cleared by a logged entry with
  `plan_end: done|abandoned|open`; the tool's `abandoned` line on an agent sets it too — 6c's "finishes it and ends its plan"
  kept). `plan_end` rides the gossip unit, cp and cf records; the replay resolves it like a line (a ≤v4 abandoned agent line
  counts as the marker). The board's plan nodes add `plan_end_how` (all-done | done | abandoned). **`applyAction(state, q,
  now, {by})`** (pure; `ACTIVITY_ACTIONS`): item `done` / `skip` / `reopen` (→ todo) / `abandon` (a keepText `@~` line —
  the line keeps its text, the LOGGED entry's text is the attribution: `apply` opts `entryText` → the record's `text`, plus
  `line_text` = the line's own; `act`; `by`); plan `complete` (context → line done; agent / root → marker done),
  `reopen_plan` (refused `not-ended` / `all-items-done`; context → line running; agent → marker open), `abandon_plan`
  (`heldPlans`: the node's open plans reached without crossing another agent, deepest first — each OPEN item abandoned, then
  the plan node: a context by its line, an agent / the session by the marker, so it keeps running; the shared
  `abandonPlans` now also drives auto-abandon, which therefore no longer finishes agents); agent / session `finish` (args
  state done|failed; only when QUIET — `quietAgent`: finished, stale or gone at `args.stale_min` (the viewer's slider), or
  implicit with every reported agent below it quiet) and `dismiss` (quiet or finished, every agent below too, and
  `openPlanKeys` not holding it → `has-open-items`). Codes: bad-action, bad-args, bad-by, unknown-session, bad-path,
  unknown-node, not-a-plan-item, no-change, not-a-plan, already-ended, not-ended, all-items-done, no-open-plan,
  not-an-agent, already-finished, not-stale, has-open-items. `by` (`normBy`) may now be the 6c string or
  `{kind:"dashboard", user, host}` (bounded, one line); `byText` → "by robin via dashboard (ROBIN-Z790)"; any `by` makes a
  SYSTEM message (no activity, no un-gone; the replay agrees). **Dismiss** (`dismissNode`): one LOGGED entry
  `{…, dismiss:true, act, by}` at the node's path, then the subtree leaves memory (the root: the whole session); the entry
  lands in the PARENT's log with its own `path` (`logView` / `findEntry` honour an entry's `path`). The replay treats it like
  `evicted`: a path not re-created newer is DEAD (older records at or under it skipped; the session's root → the session
  is not rebuilt), and the entry is attached to the parent's log at build; a skipped record that began a live ANCESTOR's
  run still marks that ancestor (`new_from` below the dead point — else a session whose first record was on a dismissed
  path looked partial). **Counts:** `cf` records carry `log_n` (+ `log_partial`); the replay's count = the entries after the
  newest cf + its `log_n`, and `node.cpartial` (the COUNT understates) is now separate from `node.partial` (the run began
  before the window — still drives "earlier history pruned"); gossip `log_partial` / the board's `partial` use `cpartial`.
  Records + slices are **format v5** (v2–v4 records still read; a v4 slice is refused). **Bridge:** WS `{type:
  "activity_action", ref, host, session, project, user, path, action, args}` from an authenticated `dashboard` socket only
  (a page leaf / a logger / a socket without a hello → `unauthorized`; the logger branch answers it explicitly);
  `activityAction`: host = this host → `actApplyAction` (waits out a replay, `Act.applyAction`, every record persisted in
  order, `actChanged()` → gossip + dashboard deltas, a log line); else `activityRemote(host, 'action', q, {by:{user}})` —
  the same per-link queue (`job.by`) → `ACTIVITY_ACT {rid, q, by}`; the owner (`actServeAction`) takes a token from the
  shared bucket (`actTakeToken`, now also used by `actServe`), refuses a `q.host` naming another host (`not-owner`) and
  applies it with `by.host` = the link's host. `onActivityFrame` answers an `ACTIVITY_ACT` on an unadopted socket / a
  forged origin with `unauthorized` and one from a hub of another format with `owner-unsupported`. Attribution user =
  `PROC_USER` (AI_BRIDGE_USER / the OS login) else "dashboard". Full slices carry `log_cmd` (`actLogCmd`: node, script,
  token_file PATH or null — never the token); the dashboard head adds `log_cmd`, `user` and each remote host's `log_cmd`.
  Followers serve no dashboard (the WS ingress is the gateway's), so there is no follower path for actions. The MCP tools
  get no new actions (the session resolves its own items with states; the dashboard is the manual override); the `log` /
  `activity` descriptions say so. **Dashboard:** the Log rows are gone — a click SELECTS a session / agent / context row
  (`ACT.sel`; the chevron or a double-click expands) and the LOG PANEL (`#actpanel`, right of the tree; below it under
  900 px) shows its merged subtree log (header: path, host, count, a multi-host session's host switch, ↻, ×; entries,
  details, "load older", the run boundary, pruned; re-reads its first page when the count changes; cleared when the node
  leaves the board). The right-click MENU (`AimbAct.menuFor(model)`; the model built lazily per row against the
  UNFILTERED tree: `quietAgent`, `subtreeAgentsQuiet`, `rootQuiet`, `ownsOpenPlan`, `openItemsOwned`): only the actions
  valid for the row and state, copies (path / session name / entry id / the aimb-log command via `AimbAct.logCmd` from the
  head's `log_cmd` of the node's host), Pin / Hide; confirmation dialogs for abandon_plan / finish / dismiss; per-row
  feedback (a spinner — "queued" while a forward waits — then ✓ or the code). Keyboard: focusable rows (treeitem / listitem,
  aria-expanded / aria-selected), arrows / Home / End / Enter / → / ←, the Menu key and Shift+F10; touch: a 550 ms
  long-press (the ending tap does not select). Pin / Hide in `localStorage` (`buildTree({pins, hidden, showHidden})`: pinned
  first among siblings, hidden counted on the parent → "N hidden — show" / "hide N again"; sessions per project too). Also:
  open plans expand their ANCESTORS by default (`nodeOpenDefault` = `t.open` or 6c's window); header + project counts from
  the unfiltered tree; the "plans open" slider = an index into `PLAN_OPEN_STEPS` (0 – 10080 min); an `--abandon` colour
  token (dark: #B8C2D0); `--bad-fg` for the danger button; a viewport meta tag; the ≤720 px phone rules moved after the base
  rules (6a's block was overridden: its bar / name widths never applied). **Tests:** `test_activity_unit` 630 → **664**;
  `test_dashboard_activity` 132 → **186**; new `test_activity_actions_live` **43**; `test_log_live`,
  `test_activity_gossip_live`, `test_activity_carry_live`, `test_activity_6c_live` updated for format v5. Against the 1.64
  library / page / bridge: `test_activity_unit` 9 FAIL (4 sections crash on the missing `applyAction`, counted once
  each), `test_dashboard_activity` fails its first 6d check then crashes (no log panel), `test_activity_actions_live` 35 of
  43. Full suite **2268 passed, 0 failed** (54 files, typecheck clean, first run; standalone reruns: `test_grants_federate_live` 3/3, `test_activity_actions_live` 5/5 incl. the suite, `test_federation_heal_live` 4 of 5 — one run ended without its summary line, the #74 flake).
- **Built (v1.64.0):** *the agent activity board, step 6c — the agent snippet + the connect reminders, the abandoned state
  and the new plan-end rule, gossiped entry counts, run-boundary history, the finished-plan window, home-host tags, the
  Plans filter (#70) — together with #75 part 2 (the token FILE in the commands the bridge hands out).* Decisions of
  2026-10-02 ("Decisions before 6c and 6d"). Nothing of #70 was deployed. **#75 part 2:** `TOKEN_FILE_PATH` is set only when
  the token really came from `AI_BRIDGE_TOKEN_FILE` (no `AI_BRIDGE_TOKEN` value): `doorbellCmd` (so `{doorbell_cmd}` and
  `set_wake`'s `command`) and `{log_snippet}` end with `--token-file "<resolved path, forward slashes>"`; the `set_wake`
  hint says the token comes from it. A config.json token adds nothing (the scripts read config.json), and neither does an
  env VALUE (it can't be handed on safely). `tools/aimb-log.mjs` gained `--token-file` with the doorbell's semantics
  (explicit = authoritative; unreadable / empty → exit 64 `no-token` naming the file + `token_file`). **The snippet**
  (new pure `lib/log-snippet.js`, expanded lazily at emit time by `expandPlaceholders`): `{log_snippet}` = "Report your
  status with: `"<node>" "<…/tools/aimb-log.mjs>" --session "<name>" --project "<project>" [--token-file "<path>"] --path
  <agent-path> "<text>"`" + six lines (@ctx vs @~ctx; milestones + --no-log; --stale-after 60m; --plan "A" "B"; --done;
  finish @~root --state done / failed + never secrets); `{log_tool_hint}` = the same for the `log` tool (Cowork). The
  realm block in `config.example.json` keeps the doorbell reminder and adds `client:code` / `client:cowork` activity
  reminders; since both code reminders share (connect, client, code), a CONFIG default may now carry an optional `id`
  (`reminders.js` `defKey`; `realm-defaults.js` canonicalises it) — a session's own reminder still overrides every default
  of its (operation, scope, match); a ≤1.63 host ignores the id. The MCP server instructions name the `log` / `activity`
  tools. **abandoned:** `ACTIVITY_STATES` + `abandoned` (and `DONE_OR_FAILED` includes it: it finishes an agent, drops an
  ETA, never shows gone); `apply` allows it only on a plan item or a node holding plan items (else `not-a-plan`). **The
  plan-END rule (supersedes 6b):** `planOf` → `allDoneAt`; `planEndAt` = when every item became done, or the plan node's
  own line went done (complete) / abandoned (`PLAN_END`) — skipped / failed / idle / open items and the owner finishing no
  longer end it. `openPlanKeys` = every item of a NOT-ended plan + its ancestors (whatever the item's state), used by
  `expire`, `evictionCandidates` (+ `enforceBudget`), `activeHidden` and `planCarryForward`. Rollup: abandoned items stay
  in M as not done (`abandoned` count); skipped stay out. **Auto-abandon** (`autoAbandon(state, now, {live})`, from the
  gateway's GC sweep with live = on this host's roster; `abandoned_plan_days` 90, 1–3650, env
  `AI_BRIDGE_ACTIVITY_ABANDONED_PLAN_DAYS`): a session not live and gone / quiet that long has its open plans abandoned,
  deepest first — each todo / running / blocked item, then the plan node — through `apply(…, {by:'bridge'})`, a SYSTEM
  message: `by` on the small entry and the record, no activity touched (last_activity, stale_after, gone, the owner's
  implicit), and the replay skips activity for `by` records too; the records are persisted in order. **Entry counts:**
  gossip nodes carry `log_n` (own entries: log + dropped; a remote node re-gossips its count) and `log_partial` (the new
  `node.partial`: the replay never saw the record that began the run); `boardView`'s `log` = `{entries, dropped, total,
  partial?}` / `{remote, total, partial?}`. **Run boundary:** the day-file half of a log page moved into the library
  (`filePage(lv, files, records, {now, maxBytes, scanBytes, earlier})`; the bridge's `actLogPage` passes the facet's
  `readBackwards`, starting at the day file of the oldest entry memory served): it stops at the record that began the
  node's CURRENT run (`fileRunStart`: a record of the session at or under the node with `new_from ≤ depth`) → `run_start`
  + (when a bounded peek finds an older entry of the node) `earlier_cursor`; `earlier:true` (the `log` query field) pages
  past boundaries; files exhausted without the start for a partial node → `pruned`. Local and remote (the owner pages).
  **Home host:** every entry / cp / cf record carries `s0` = the session's created_at (the replay takes the min, so it
  survives the window); `boardView` gives a multi-host group `home` = the earliest-created root, ties by lower-cased host
  name. **Board:** plan nodes carry `plan_node` + `plan_end_at`; heads (dashboards, the tool) carry
  `finished_plan_open_min` (120, 0–10080, `AI_BRIDGE_ACTIVITY_FINISHED_PLAN_OPEN_MIN`). **Formats:** v4 records + slices
  (v2 / v3 records still read; hubs declare `activity_gossip:4`; a v3 slice is refused `bad-version`). **Dashboard:** the
  Activity section opens by default; `ACT.open` is tri-state (undefined = `planOpenDefault`: an open plan, or one ended less
  than the window ago, renders expanded; Collapse all closes for good); a "plans open" slider (live, not persisted); a "plans"
  filter (`buildTree({plansOnly})`: plan items, plan nodes, their ancestors; persisted); ROLLUPS FOLLOW THE FILTERS (`rollKids`
  ports the library's strategies; `t.fbar` / per-host `fbars` for the session row — 6b's session rollup counted an ended
  plan Active only hid); top-level host tags vs `home`; pills right after the name so the bar column aligns; abandoned
  styling + glyphs (agent, context, item) + legend; "N entries" / "N+" from `subtreeLog`; the run-boundary rows ("start of
  this run · show earlier runs…", "— earlier runs —", "earlier history pruned"); `by` on entries; 6d hooks — every row
  carries `data-kind` / `data-host` / `data-path` / `data-session` / `data-project` / `data-user` (+ nkind, plan flags,
  home, hosts, an entry's id) and `AimbActView.rowInfo`. **Tests:** `test_activity_unit` 588 → **630**;
  `test_dashboard_activity` 105 → **132**; new `test_activity_6c_live` **31**; `test_log_live` 75, `test_activity_gossip_live`
  51, `test_activity_dashboard_live` 43, `test_activity_carry_live` 11 updated for format v4 and the new rules (6b fixtures
  that relied on "skipped ends a plan" / "a finished owner ends it" now use all-done plans / failed agents). Against the 1.63
  library / page / bridge: `test_activity_unit` 50 FAIL (crashed sections count once), `test_dashboard_activity` 10 (the 6c
  block crashes: no `planOpenDefault`), `test_activity_6c_live` 27 of 31. Full suite **2137 passed, 0 failed** (53 files, typecheck clean, first run; no #74 flakes).
- **Built (v1.63.0):** *the agent activity board, step 6b — TODOS AND PLANS, their lifetime and the day-rollover
  carry-forward, plus three agreed 6a adjustments (#70).* Decisions of 2026-10-02 ("Decisions before 6b"). Nothing of #70
  was deployed. **States:** `ACTIVITY_STATES` gains `todo` (☐) and `skipped` (struck through) — context states only
  (`bad-agent-state` for an agent or the session, at parse time). **Plan items** (`node.plan` + `plan_ix`, never cleared,
  no caller-visible flag): a context created by `plan:[…]`, adopted by one (an existing context with no line of its own),
  or whose FIRST current line is `todo`. `skipped` on an ordinary context, `todo` on one that already has a line, or a
  plain (non-`@~`) todo on a new one → `not-a-plan-item`. An `@~` line without a state on a ☐ item starts it (running); an
  `@~` line WITH a state may omit text (`keepText`: the line keeps its text — else the node's name) — the "tick", which
  the script spells `--done` (= `--state done`). A plan item never goes stale and never shows gone (`staleAt` null,
  `effectiveState` = its own state); its owner agent still shows its own. **Plans** (`parsePlan`; `log {plan:[…]}`, a
  batch item's `plan`, the script's `--plan A B …` — every argument up to the next `--flag`): 1..64 names, one context
  segment each (a leading `@` dropped, repeats folded + `plan-duplicates`, else `bad-plan`; depth checked); text optional
  (`planOnly`: no message of the target's own; with text the target's message goes first). Each new / adopted item gets a
  LOGGED ☐ entry (text = its name, `plan_item` + `plan_ix`) even under `log:false`, so a plan always reaches the files;
  `apply` returns `records:[…]` (the target's entry, then the items — the bridge persists them in order) and
  `plan:[{name, path, created?, adopted?, plan_item, state}]`. **Re-plan merge:** an existing item is never duplicated or
  reset (state and place kept); new names are appended at the END in the given order; missing names stay; re-ordering
  moves nothing; a context with a line of its own is left alone (`plan_item:false`). Children keep CREATION order
  (created_at, then `plan_ix`, then key) live, on the dashboard and after a replay (which now rebuilds siblings from
  created_at + plan_ix + the record order instead of A→Z). **Rollup:** `rollupStrategies` get `(bars of the ORDINARY
  children, the PLAN-ITEM children)` — sum (shared unit), then mean %, then "N of M done" (`{done, total: items −
  skipped, unit:'done', todos:true, skipped, n}`; all skipped → no bar; failed = not done). So a plan item counts only as a
  todo of its parent (its own bar — e.g. from an agent under it — stays on its row) and ordinary children with bars win on
  a mixed node (6a's precedence) — **REVERSED in v1.75.1 (#88): a node holding plan items rolls up its items only; its
  ordinary children keep their bars on their own rows** (see §13 "Built (v1.75.1)"); plan bars sum up the tree (`todos` kept). **Lifetime:** `finished_visible_hours`
  defaults to **168** (also the replay window). `expire` never removes anything holding an OPEN item (todo / running /
  blocked: `openPlanKeys` = the open items and all their ancestors) — a finished agent or a GONE session with one stays;
  a plan ENDS when its last item became done / skipped or its owner (the plan node if an agent, else its nearest agent /
  the session) finished (`planEndAt`) and expires a window later (`planRemoval`: its items, plus the plan node when it is
  a plain context left with nothing else and no live line). **Eviction** (`evictionCandidates`, now shared by `apply` and
  `enforceBudget`): finished agents and ENDED plans, oldest first, never a subtree holding an open item, never one on the
  target's path; else `too-many-nodes` / `too-many-agents` (the message says open items are never evicted). **Carry-
  forward** (`planCarryForward`): `cf` records `{v:3, kind:"cf", ts, path, …identity, current (full line incl. details /
  data), state, progress, eta_at, created_at, last_activity, stale_after_ms, implicit, plan_item?, plan_ix?, finished_at?,
  new_from?}` for every open plan item + all its ancestors and every node whose own state (line / bar / ETA / reported
  activity) last reached the files before now − window + 25 h — each node tracks it in `pt {a, l, p, e}` (set by entries,
  cps and cfs; rebuilt by the replay from what the window held) — parents first, children in creation order. The replay
  takes a `cf` as a full snapshot of its TARGET only (its own created_at / last_activity / implicit; nobody's activity is
  refreshed, so a quiet agent stays exactly as stale), reports `cfs` and `cf_today`. **The bridge:** `actNow()` = the wall
  clock + the test-only `AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS` drives every activity time; a timer
  (`AI_BRIDGE_ACTIVITY_ROLLOVER_CHECK_MS`, 30 s) calls `actRollover`, which writes the carry-forward into the new day's
  file when the local day changed (serialised with the checkpoint writer); after a replay without a cf in today's file it
  writes one at once ("startup"). `activity {tap:true}` (test-only) shows the replay stats and the last carry-forward.
  **6a adjustments:** batch item paths are RELATIVE to the batch's default agent + path (`withDefaults`: path = default
  path / item agent / item path, the default agent kept; a leading `/` on the item's first address field = absolute; the
  default context only for items without an address of their own) — the tool, the logger WS (both via `splitBatch`), the
  script's `--batch` and `--stream`; the multi-host headline (`self`) = the root with the newest CURRENT-LINE time (6a
  took the most recently ACTIVE host among those with a line — different when a host set its headline earlier but kept
  reporting later; tie → most recently active; no line anywhere → most recently active); host tags only where a node's
  host differs from its parent's (a top-level node compares with the headline host; `AimbAct.hostTagOn`), and an expanded
  multi-host session shows each host's own line above its Log. **Formats:** records + slices v3 (`ACTIVITY_FORMAT` 3);
  `recordKind` reads v2 and v3 (v3 only adds) and the new `cf` kind; slices must be v3 and hubs declare
  `activity_gossip:3` (a 1.62 hub would misread a todo, so its frames are ignored and fetches to it answer
  `owner-unsupported`). Gossip nodes and dashboard units carry `plan_item` + `plan_ix`; a wire agent can't be todo /
  skipped (coerced to running). **The dashboard:** plan items render as a checklist — ☐ / the in-progress mark / ☑ / a
  struck-through skipped row (failed: ✗ in a box), the line only once it says more than the item's name — in creation
  order; a plan node's "N of M done" bar is solid green (tooltip "2 of 4 done (50%) · 1 skipped (left out) — its plan: 5
  items"); "Active only" keeps open items (even under a finished agent) and hides ended plans; the legend adds the plan
  marks. **Tests:** `test_activity_unit` 516 → **588**; `test_log_live` 66 → **75**; `test_log_script_live` 50 → **54**;
  `test_activity_gossip_live` 48 → **51**; `test_activity_dashboard_live` 41 → **43**; `test_dashboard_activity` 85 →
  **105**; new `test_activity_carry_live` **11** (13 days of seeded files, a real rollover under the clock hook, a restart
  a week later whose window holds only the rollover's records). Against the 1.62 library / bridge / page / script:
  `test_activity_unit` 52 FAIL (crashed sections count once), `test_log_live` 16, `test_log_script_live` 9,
  `test_activity_gossip_live` 5, `test_activity_dashboard_live` 2, `test_dashboard_activity` 4 (the 6b block crashes:
  no `planGlyph`), `test_activity_carry_live` 10 of 11. Full suite **2037 passed, 0 failed** (52 files, typecheck clean, first run; no #74 flakes).
- **Built (v1.62.0):** *the agent activity board, step 6a of the revised step 6 — the UNIFIED NODE TREE plus batch
  logging (#70).* Decisions of 2026-10-02 ("Step 6 redesign"). Nothing of #70 was deployed, so record and wire formats
  changed freely (no converters; old-format data is skipped). **The model (`lib/activity.js`):** a session holds ONE tree
  of nodes — `sess.nodes` (a flat Map keyed by the node key = `lc(canonical path)`) + `sess.kids` (parent key → child
  keys, insertion order) + `nAgents`; the session itself is the ROOT node (key `''`, kind agent — what `session.self`
  was). Every other node is an **agent** (starts, finishes on its own done/failed current line, stale, gone,
  `stale_after`) or a **context** (current line, progress, ETA; never stale by itself); either kind may contain either.
  **Paths** (`parsePath` / `formatPath` / `resolveAddress`): `/`-separated; a segment starting with `@` is a context,
  anything else an agent (`spec-70`, `spec-70/research`, `spec-70/@Tharsis`, `spec-70/@Tharsis/@z12`, `@#70/spec-70`,
  `@#70/@step4/spec-70`); `@"CTX strip 17"` quotes (the `path` field also takes unquoted spaces; the canonical spelling
  quotes a name with whitespace or a leading `~`); `@~` only on the LAST segment = set that node's current line; `@root`
  / `@~root` only last = the node itself; depth ≤ 6; context names may no longer contain `/`. **The old notation maps
  onto it:** `agent` (agent segments only) + `path` + ONE trailing context — the `context` param (old syntax, one name)
  or else a leading `@…` text prefix, itself a relative path (`@Tharsis/@~z12 …`); context beats a prefix, agent and path
  concatenate; so `agent:"a/b"` + `"@~Ctx …"` ≡ `path:"a/b/@~Ctx"`, and no address + `@~root` = the root. The message
  (`ActivityMsg`) carries `segs` / `path` / `key` plus the old-shaped `agent` (its OWNER's path), `context` and `root`.
  Intermediates are created **implicit** (no line); a node stops being implicit when a message targets or is OWNED by it
  (the owner = the nearest agent at or above the target, else the root; the root itself is implicit until the session
  reports). **Activity:** a message moves `last_activity` / `stale_after` on target..owner only (a context keeps its agent
  fresh; a sub-agent doesn't refresh its parent); the session header on every message; it clears gone on the session +
  its owner. **Staleness (decided here):** agents only (and the root); an implicit agent never goes stale; a CONTEXT shows
  its nearest agent ancestor's stale / gone / finished — only while it has a live current line of its own (a context
  without one is a grouping node: no state, never stale) — and a context directly under the session follows the
  **session's own** reports (anything it owns, at any depth not crossing an agent), exactly like the session row before.
  `effectiveState(item, now, staleMin, owner)` / `staleAt(item, staleMin, owner)` take the owner for a context.
  **Limits:** depth 6 replaces "agent path depth 3", and per session 128 agents + a budget of 4096 nodes replace "32
  contexts per agent"; a message that needs room evicts the oldest FINISHED agents with their WHOLE subtree (never an
  ancestor of its target; simulated first, so a rejection changes nothing) and is refused `too-many-agents` /
  `too-many-nodes` only when that can't make room or it is `log:false`. Expiry and `enforceBudget` also remove subtrees.
  **Rollup** (`rollup(sess, node, memo)`) recurses: reported progress, else the children's bars summed when they share a
  unit, else their mean % — `rollupStrategies` is the hook for 6b's "N of M todos done". **Logs:** every node keeps its
  own log (`log_entries_per_agent` per node), kept in (ts, seq) order, with `log_floor` = the newest entry it holds only
  in the files (moved by the cap, the budget and the replay window). `logView` addresses a node by path / agent / context
  and returns its SUBTREE merged newest first (a binary-search cut per node + a k-way merge; `own:true` for the node
  alone), each entry with `path` + `rel`; a cursor is any entry id (its time + sequence), so it survives the entry's drop;
  with `files:true` memory serves the subtree only down to its FLOOR (the max of its nodes' floors; else the oldest
  memory entry) and the `files` descriptor (`target:{…identity, key, own}`, `before:{ts, ids-at-ts}`) continues below it —
  `fileEntryMatches` matches the node and (own:false) anything under it by path key. Unknown node → `unknown-node`.
  **Records — FORMAT v2:** entries `{v:2, id, ts, path, current, text, state, …, identity, details, data, new_from?,
  evicted?, finished_at? (agents)}`, checkpoints `{v:2, kind:"cp", k, path, …}` per node, repeat lines `{v:2, rep, …}`;
  `new_from: i` marks the first persisted record touching each node of the chain [root, …segments] (0 = a new session).
  `recordKind` returns null for anything not v2, so a 1.58–1.61 record is SKIPPED (counted), never misread; the bridge's
  id index and entry lookup accept v2 entries only. **Replay** (still newest-first, phase 1 / phase 2) works per node:
  a `new_from` marker SEALS that node with its subtree (any older record whose chain passes a sealed node is an older
  instance), `evicted` paths not seen newer are dead with their subtree, phase 1 waits only for nodes a record TOUCHED
  (target..owner), and a node whose instance began before the window gets `log_floor` = the window start. The seeded
  random replay ≡ chronological-apply test now runs over nested paths (depth 5, agents under contexts, sub-agents, text
  prefixes that are relative paths) and compares every node incl. implicit, floors and logs. **Gossip — FORMAT v2:** one
  unit per NODE (its own fields; never children, rollup, log, details/data); `snapshot` → `{v:2, sessions:[{…header,
  nodes:[…]}]}`; deltas carry changed nodes + `remove:[{…identity, path}]` (a node removal takes its subtree on the
  receiver); `mergeSnapshot` / `applySlice` refuse a non-v2 body (`bad-version`); a receiver stores nodes flat, so a child
  that arrives before its parent (a truncated frame) is held and linked when the parent arrives. Hubs declare
  `activity_gossip: 2` in PEER_HELLO; a link whose peer declared anything else (a 1.60/1.61 hub: 1) has ALL its activity
  frames ignored (logged once, tapped `skipped-format`; no resync loop) and remote fetches to it answer
  `owner-unsupported`. **Views:** the tool's board lists each group's `self` (root) and a FLAT `nodes` list (`path`,
  `kind`, `depth`, `parent`, `host`, effective state, `progress` = the bar, `implicit`, log counts); `path` (or the old
  `agent`) filters a subtree; `active_only` drops inactive agents with their subtrees; the headline (`self`) is now the most
  recently active host's root that HAS a current line (else the most recent). Dashboard units are one per session group +
  one per node (`kind:"node"`, `nkind`, `key`, `parent_key`, `depth`, own `progress` + the rolled-up `bar`), sessions then
  parents before children. **Batch:** `splitBatch` (1..64 items, ≤64 KB of items JSON → else `too-many-items` /
  `batch-too-large` for the whole call; `bad-batch`; per item `bad-item` / `bad-field` / `not-yet` for `plan`) and
  `withDefaults` (beside `items`, `log` is a default; `path` / `agent` / `context` are ADDRESS defaults, all-or-nothing: an
  item naming its own `path` or `agent` takes none of them; one with only a `context` keeps the default path / agent).
  The bridge: `log` takes `items` (tool, follower, logger WS); `activityLog` checks the bounds before any wait, applies
  each item in order through `actApplyOne` (awaiting each append, so the file keeps the order), answers `{ok:true,
  results:[…+ref], applied, failed}` and calls `actChanged` / `syncActivityBells` ONCE — one coalesced gossip and dashboard
  update. A follower forwards a batch in ONE `ACTIVITY` frame (the test tap records `fwd` frames with their item count);
  the logger accepts `{type:"log", input:{items}}`. The script: `--path`, `--batch <file|->` (one call, one result line;
  exit 0 / 4 when any item failed / 64 for a bad file or the bounds), and a `--stream` line may be an array (a batch, one
  result line). **The dashboard** renders the node tree to any depth: session rows + their top-level nodes by default; each
  node expands on its own into its subtree **Log** ("N entries, this node and below"; entry tags relative to it —
  `@~root`, `@Tharsis/@~z12`, `research/@~root`) and its children (creation order, 16 px per level, readable at depth 6;
  narrower on a small screen); agents keep the ring glyph, contexts get a smaller state mark without a ring, coloured
  `@name`, and inherit stale / gone from their owner in the page's own stale computation (the slider moves them too);
  implicit nodes show a hollow mark; Projects / Sessions / **Nodes** (formerly Agents) = expand down to the top-level
  nodes; Expand all opens every node at any depth. **Tests:** `test_activity_unit` 448 → **516** (path forms, old-notation
  equivalence, tree + implicit + spelling, depth / agent / node limits + subtree eviction, recursive rollup, context
  staleness inheritance, the subtree-merged log + floors + the files descriptor, v1 records skipped / v1 slices refused,
  nested deltas + orphans + subtree removal, node dash units, splitBatch / withDefaults; sections now run independently
  and `AIMB_TEST_ACTIVITY_LIB` points it at another library) — against the 1.61 library 59 FAIL (33 of them whole
  sections that need the new API); `test_log_live` 52 → **66**; `test_log_script_live` 40 → **50**;
  `test_activity_gossip_live` 44 → **48**; `test_activity_dashboard_live` 36 → **41**; `test_dashboard_activity` 62 → **85**.
  Against the 1.61 bridge / page / script: `test_log_live` 11 FAIL (then crashes on the old board shape), `test_log_script_live`
  10 FAIL (crash), `test_activity_gossip_live` 7 FAIL (crash), `test_activity_dashboard_live` 14 of 41 FAIL,
  `test_dashboard_activity` 8 FAIL (then crashes: no `entryTag`).
  Full suite 1911 passed, 0 failed (51 files, typecheck clean, first run; no flakes).
- **Built (v1.61.0):** *the agent activity board, build-plan step 5 — the dashboard's Activity tree, plus deltas to
  dashboards, history paging into the day files, queued remote fetches, read access, the doorbell flag, host down vs gone
  and the duplicate-hostname warning (#70).* Decisions of 2026-10-02 ("Decisions before step 5"; the layout Robin approved
  via interactive mockups). **The page** (`dashboard.html`, a new collapsible **Activity** section, collapsed by default;
  `#activity` opens it): a TREE only — project → session → agent → context → log entry. Project headings show their
  counts (sessions · active agents) and cycle all → sessions only → collapsed on click; a Projects / Sessions / Agents
  control sets every project. Default view: every session with its agents' `@root` rows, contexts + logs closed. A session
  on several hosts is ONE row (a host tag each; the headline = the most recently active host's `self`; agents tagged by
  host; expanding it shows a Log + contexts per host). Rows: a 16 px SVG status glyph (centre = state: dot running /
  blocked / idle, tick done, cross failed; a live item's ring EMPTIES as the time left before stale runs out — ticked in
  place each second via `data-sa`/`data-win`), the name (agents monospace; `a/b` nests under `a`, prefix dimmed), the
  `@root` line rendered, a progress bar (striped = rollup), ⌛ only with an ETA, 🔔 with an armed doorbell, pills ONLY for
  blocked / failed / stale / gone plus a distinct violet **host down** badge; a stale row greys out. NO inline time text:
  hover tooltips (computed on mouseover from the live data) give started / running for / last activity / stale at, or
  done|failed at + took; the bar gives exact counts + reported vs "rollup of its N contexts"; ⌛ "ETA ~15m (estimated),
  about 19:27"; 🔔 "Doorbell armed". Expanding an entity: a **Log** row ("N entries, all contexts"; remote: "all contexts
  · HOST") → entries newest first (time, state dot, `@ctx` / `@~ctx`, rendered text; an entry with details/data expands
  into the text + pretty JSON; "load older…" pages on; a queued fetch shows a spinner + its wait; `busy` offers a retry),
  then each context (◎, glyph, line, bar, ⌛) expanding into its own log. Controls: active only (finished + gone agents and
  sessions with nothing active hidden; localStorage), a stale-after slider 5–60 min (default = the head's
  `stale_after_min`; an item's `stale_after_ms` wins), Expand all (sessions + agents, never fetches) / Collapse all, a
  legend. Rows are diffed by key (`actReconcile`), so the 1 s re-render only replaces changed rows and hover tooltips
  survive. The pure client logic is `window.AimbAct` (effState / ringFrac / glyphSvg / statusTip / etaTip / barTip /
  renderText — a port of lib's / applyMsg / nextLevel / buildTree) for the jsdom test. **Colour tokens:** the page now
  defines `:root` tokens (bg, fg, muted, lines, heads, surfaces, state colours) with a dark set under `prefers-color-scheme:
  dark` (or `?theme=dark|light` → `data-theme`); the structural colours of every section use them, the pastel badges keep
  theirs. **Deltas to dashboards:** the old whole-board-per-second push is gone. A dashboard subscribes (`activity_sub`)
  only while the section is open and the tab visible, unsubscribes on leave; subscribe → `activity_board {full, epoch,
  seq:1, head, upsert}`, then ≤1 per `ACT_GOSSIP_MS` (one global timer, kicked by `actDashKick` on any local / remote
  change) `activity_delta {epoch, seq, base, head, upsert, remove}` diffed per dashboard (`ws.actSub.pub`) — lib
  `dashUnits(boardView(…, {raw:true}))` (one unit per session group, one per agent; stable ids) + `planDashDelta` (the same
  published-view diff as `planSlice`); a delta is sent only if a unit or the head (minus `now`) changed. RAW board form:
  reported states (`gone` kept — data, not time), raw templates and times, no `rendered`/`stale_at`, so time passing never
  makes a delta and the page's slider is instant. A `base` that isn't the page's seq → `{activity_sub, resync:true}` → a
  fresh full board. **Paging into the day files:** `logView(…, {files:true})` returns, once memory runs out with room
  left, a `files` descriptor (target identity, `before` = the oldest in-memory entry's ts + the in-memory ids — or the
  dropped cursor's time —, the room left); a page that fills exactly at the end of memory hands out its last id, and a
  file cursor `f1.<day>.<offset>` skips memory. The bridge's `actLogPage` continues with the persistence facet's
  `readBackwards(host, {fromDay: retention, before:{day, offset}})` (new `before` option: start below that offset of that
  day, newer days skipped; chunked async reads), matching `fileEntryMatches` (logged entries of that realm / project /
  user / session / agent [/ context], case-insensitive; cp/rep never) → `fileEntryView` (the in-memory shape + rendered),
  bounded by the page's entries, 32 KB (`ACT_PAGE_BYTES`) and at most `AI_BRIDGE_ACTIVITY_SCAN_BYTES` (8 MB) of file per
  page (then a cursor at the last record scanned); `from_files` counts them. Local reads and the owner side of remote
  `log` fetches both use it (the owner's 50 / 32 KB). **Queued remote fetches:** `activityRemote(host, op, q, ctx)` puts
  every fetch in the link's queue (`p.act.out`), paced by a mirror token bucket (`ACT_FETCH_RATE`, or the `rate` an
  owner's `rate-limited` answer now names; such an answer puts the fetch back at the head for its `retry_after_ms`, ≤4
  times); bounds `AI_BRIDGE_ACTIVITY_QUEUE_LINK` (64 waiting per link) and `_QUEUE_DASH` (16 queued + in flight per
  dashboard, `ws.actFetches`), and `ctx.maxWaitMs` (a follower's forwarded read ≈ `ACT_FWD_MS − ACT_REMOTE_MS − 300`, the
  gateway's own tool `_TOOL_WAIT_MS` 10 s) → `busy` + `retry_after_ms`; `ctx.onQueued` → `{type:"activity_queued", ref,
  host, wait_ms, position}`; a waited result carries `queued_ms`; a dropped link fails its queue (`owner-unreachable`).
  **Read access:** on the WS, `activity` / `activity_sub` / `activity_unsub` from anything but a dashboard → `dashboard-only`
  (pushes only ever go to subscribed dashboards); a second `hello` on a connection is refused (`already-hello`) so a page
  can't re-hello into a dashboard. The `activity` tool is unchanged. **Host down vs gone:** `boardView` marks every entity
  of a remote slice whose origin is down (`markOriginDown`: ACTIVITY_DOWN, link lost / retired / expired) with
  `host_down` (the down time), the group with `hosts_down` (tool + raw); a session that left is `gone` without it.
  **The bell:** `setBells(state, watches)` sets `session.bell` for each local session a doorbell listener on this gateway
  watches (name, + project when given); synced on listener connect / close (+ `AI_BRIDGE_ACTIVITY_BELL_GRACE_MS`, 5 s,
  after a close — the doorbell re-arms after each wake), after each `log` and after the replay; `bell` rides the gossip
  header (`sessHeader` / `wHeader` / `applySlice`; a ≤1.60 receiver ignores it) and groups OR it. **Duplicate host names:**
  `adoptPeer` → `warnDupHost` (once per name per `AI_BRIDGE_DUP_HOST_WARN_MS`, 10 min): a peer with OUR name, another live
  peer link with the same name at a different advertise host, or (after the #63 PING probe) one at the same host on
  another port that stayed alive. No other behaviour change. The `activity` tool description now says the paging,
  `host_down` / `bell` and `busy`. Tests: `test_activity_unit` 427 → 448 (raw board, host_down, dash units + deltas,
  bells through a full + a header-only delta, file cursors, the files descriptor, fileEntryMatches / View, the facet's
  `before`); `test_activity_gossip_live` (44) — its dashboard check now subscribes, its rate-limit check now expects the
  burst queued (all ok); new `test_dashboard_activity` (62, jsdom; against the pre-change page: nothing to test, 2/2 FAIL);
  new `test_activity_dashboard_live` (36 — three loopback hosts + a fourth with A's name: full board on subscribe, deltas
  only, ≤1/s under a 180-update burst, chained bases, the folded view = a fresh full board; an unsubscribed dashboard gets
  nothing; a dropped delta → resync → whole again; a page leaf refused (reads, subscribe, a re-hello) and pushed nothing;
  local paging over 5 pages through the files into a 3-day-old file; remote paging over 4 pages into A's files; a 10-fetch
  burst all ok with `activity_queued` + `queued_ms`; 30 at once → `busy` beyond 12; gone vs host down; the bell (remote,
  cleared after the grace, local by name); unsubscribe; the duplicate-hostname WARN once) — against the pre-change bridge
  28 of the 36 FAIL. Full suite 1787 passed, 0 failed (51 files; in the first full run `test_federation` lost a bridge
  connection once mid-test, then passed 6/6 solo and in the complete rerun).
- **Built (v1.60.0):** *the agent activity board, build-plan step 4 — mesh-wide gossip of the board + on-demand remote
  history (#70).* Decisions of 2026-10-01 ("Decisions before step 4"). **Host in the identity:** every entity is keyed by
  realm + project + user + session + HOST (+ agent path) — `sessionKey` gains the host, and inside `lib/activity.js` the
  host is always the ORIGIN holding the entity (a local report's `ident.host` is ignored: each host writes only its own;
  a remote slice's host is the link's). The replay keys every record with this host whatever its `host` field says, so
  step-2/3 day files (which may lack it) replay unchanged. **The wire** (`lib/activity.js`): `gossipUnits` (one unit per
  entity + its session header, canonical JSON), `planSlice(state, pub, {full, maxBytes})` — a FULL slice or a DELTA
  against the link's published view `pub` (changed entities inside their session record + `remove:[{realm, project,
  user, session[, agent]}]`), newest-active first under the byte cap (the first entity always goes; what didn't fit stays
  unpublished, so the next frame carries it; `truncated:true`); `applySlice(state, origin, body)` — a full body replaces
  the origin's slice (`mergeSnapshot`, which now also records `epoch`/`seq` and always replaces a slice marked down), a
  delta applies only on exactly (epoch, `base` = held seq) else `out-of-sync`, re-validating every record like a
  snapshot (`wHeader`/`wSession`/`wEntity`; the record's own `host` is never used); `markOriginDown` (unfinished entities
  of a down origin show gone, last lines kept), `expireRemote` (down longer than `finished_visible_hours` → dropped),
  `remoteInfo`. **The mesh board:** `boardView` now covers local + every remote slice, GROUPED by realm + project +
  user + session name (`groupKey`) across hosts; every entity view carries `host`; a one-host group keeps `host`, a
  multi-host one has `hosts`, `multi_host`, `self` (the most recently active host's) and `selves`; a remote entity's
  `log` is `{remote:true}`; stale/gone computed on the reader's side; `host` filter. `locateSessions` / `locateEntry`
  find which host holds a log / current line; `logView` is PAGED (`cursor` = the last id of the previous page →
  `next_cursor`; `opts.maxEntries` / `maxBytes`; an unknown cursor whose id names a time continues from it).
  **Bridge:** frames `ACTIVITY_SLICE` / `ACTIVITY_DOWN` / `ACTIVITY_REQ` / `ACTIVITY_RES` on the peer-hub link (§7 "Hub-to-hub
  frames"), only from an ADOPTED link (`peerEntryOf(sock)`), ownership = `hostOfGw(peer session)`; a frame whose
  `origin` names another host is dropped; a delta from a link that never sent a full one, or out of sync, triggers
  `ACTIVITY_REQ {op:"resync"}` (≤ every 2 s per link). `PEER_HELLO` declares `activity_gossip:1`; a link gets a full
  slice on adoption (`actLinkInit` in `adoptPeer`). **Rate + coalescing:** a local change (`activityLog`, gone sweep, GC
  expiry/budget, replay publish/finish) only bumps a version and KICKS each link's single timer, due `ACT_GOSSIP_MS`
  (1 s) after that link's last frame; the frame then carries the current diff — so any burst is ≤1 frame/s per link; the
  #63 heartbeat adds a sync beat through the same scheduler. Cap `AI_BRIDGE_ACTIVITY_SLICE_MAX_BYTES` (256 KB). The units
  are computed once per version and shared by every link. `actOwner` maps each remote host to the peer session whose
  link owns its slice; `dropPeer` (close / retire / expiry) → `actLinkLost` fails that link's in-flight fetches and marks
  the host down. **Remote history:** `activity {log}` resolves the session on any host (`ambiguous-session` now lists
  each candidate's host; the agent or `host` disambiguates); a remote one → `ACTIVITY_REQ {op:"log", q}` to the owner,
  which answers `logView` capped at `AI_BRIDGE_ACTIVITY_PAGE_ENTRIES` (50) / `_PAGE_BYTES` (32 KB); `entry:{id, host?}` →
  `{op:"entry"}` → the owner's `lookupActivityEntry` (memory → id index → streamed day-file scan; details + data only
  here). The owner rate-limits per link with a token bucket (`_FETCH_RATE`, 4/s, burst 4) → `rate-limited` +
  `retry_after_ms`; the requester times out after `_REMOTE_MS` (4 s, < the follower's 5 s) → `owner-unreachable`, as
  does a missing link; a peer without the flag → `owner-unsupported`. Remote results carry `from_host`; the board head
  carries `remote_hosts`. **Going down:** `/admin/prepare-shutdown`, after the flush, sends `ACTIVITY_DOWN` to every
  capable peer and answers `down_notified`; SIGINT/SIGTERM do the same (≤300 ms) before exiting; after a notice no slices
  go out for `_DOWN_HOLD_MS` (30 s), then full ones (if still alive). Receivers mark that host down at once; its next
  full slice (a returning host) clears it. **Followers** keep forwarding reads to their gateway (no replicated board on
  followers: they'd only duplicate memory and traffic, and every follower read already goes up the control link).
  **Dashboards** get `{type:"activity_board", board}` (≤1/s, only when one is connected) and may send `{type:"activity",
  ref, query}`. **Bare-session rule:** `loggerUserConflict` also refuses a script report for a BARE process-level
  session (a roster entry with its own project + user, name = the session) under another user; same user allowed.
  **Mixed versions:** a ≤1.59 hub doesn't declare the flag → gets no activity frames (and ignores them anyway — unknown
  frame types fall through); its agents just aren't on 1.60 boards. Test hooks: `AI_BRIDGE_TEST_HOSTNAME` (distinct host
  names for loopback "hosts"), `AI_BRIDGE_TEST_ACTIVITY_TAP` (`activity {tap:true}` → recent frame summaries), and
  `AI_BRIDGE_TEST_GOSSIP=legacy` now also mimics a ≤1.59 hub for activity. Tests: `test_activity_unit` 386 → 427 (host
  key, pre-1.60 replay, grouping, locate, down/clear/expire, planSlice full/delta/removals/convergence, the byte cap
  newest-first + spill-over, applySlice seq/out-of-sync/ownership, paging); new `test_activity_gossip_live` (44 — four
  loopback hosts + a follower: on B's board within ~2 s tagged with A's host, also through the follower; one group for
  the same name on two hosts; a dashboard WS request + push; a 20/s `log:false` burst → ≤1 frame/s with ≥900 ms gaps; the bare-session rule; a link
  restart (B's gateway killed, the follower takes over) → full slices, C's truncated newest-first and completed by later
  frames; forged slices; remote paging over 3 pages; remote entry details/data; the rate limit; prepare-shutdown → gone
  at once, cleared when A returns; owner down → `owner-unreachable`; a legacy hub); against the pre-change bridge 38 of
  the 44 FAIL. `test_log_script_live`'s version check is now ≥ 1.59.0. Full suite 1668 passed, 0 failed (49 files; `test_federation_heal_live` lost a
  bridge connection once mid-run in the full suite and then passed 19/19 in 7 solo runs).
- **Built (v1.59.0):** *the agent activity board, build-plan step 3 — `tools/aimb-log.mjs`, plus the Task Tray's
  prepare-shutdown flush (#70).* **The script** reports to this host's board WITHOUT registering: it attaches to the
  GATEWAY's WS port as a token-gated `logger` leaf — `hello {kind:"logger", token, ident:{session, project, user,
  realm}}` → `welcome {logger:true, …}` | `error {code}` (+ close: `unauthorized` — now said out loud for a logger,
  `ident-required`, `bad-ident`, `realm-mismatch`), then `{type:"log", ref, input}` → `{type:"logged", ref, result}`, the
  result being `activityLog`'s (the `log` tool's shape) with `opts.script` so the session is never tracked for gone. A
  logger socket is kept OUT of `leaves` / `pages`: never on the roster, `list_sessions` or the dashboard, no roster
  pushes, no connect/disconnect log lines. **Decisions (Robin, 2026-10-01):** (1) no sub-peer; identity = `--session`
  + `--project` (required) + `--user` (default `AI_BRIDGE_USER`, else `os.userInfo().username`) + the realm
  (`AI_BRIDGE_REALM` / config `realm` / `default`, as the bridge); script-only sessions are never marked gone but go
  stale. (2) anyone holding the realm token may report as any session, EXCEPT a session LIVE on the mesh roster (a
  sub-peer with the same realm + project + name on ANY host — this gateway's, its followers' and the gossiped remote
  slices) under a DIFFERENT user (case-insensitive) → `session-user-mismatch` (`loggerUserConflict`, checked on every
  report against the current roster). CLI: `--agent --ctx --state --progress --eta --stale-after --details --data |
  --data-file --no-log [text]`, validated locally with `lib/activity.js parseMessage` (a bad report exits 64 without
  connecting); ONE JSON line out; exit 0 / 4 (bridge or transport: `link-error`, `unauthorized`, `session-user-mismatch`,
  `gateway-unsupported` for a pre-1.59 gateway that took the hello for a page, `timeout`) / 64 (usage). `--token` is
  REFUSED (`token-in-argv`, value not echoed): the token comes from `AI_BRIDGE_TOKEN` / `AI_BRIDGE_TOKEN_FILE` / the
  `config.json` beside the script (`AI_BRIDGE_CONFIG` overrides; the test hook, with `AI_BRIDGE_WS_PORT` / `--ws-port`).
  **`--stream`:** one connection, NDJSON on stdin (the `log` fields minus auth, + an echoed `ref`), the command line's
  identity on every line and `--agent`/`--ctx`/`--no-log` as per-line-overridable defaults; one result line per input
  line IN ORDER (a bad line answered in place: `bad-json`, `bad-field`, a parser code); one report in flight at a time;
  reconnect with backoff (200 ms → 5 s) on a drop — the in-flight line is reported `link-lost` and NOT resent (no
  duplicate entries), a line waiting longer than `AIMB_LOG_LINE_WAIT_MS` (10 s) for a link → `no-bridge`; exit 0 at EOF,
  4 on a fatal hello error. **Prepare-shutdown:** the tray's Restart Bridges… / Shut down all `Process.Kill()` the
  bridges (TerminateProcess: no `exit` handler, so the `log:false` progress since the last checkpoint was lost). The
  gateway's HTTP server (the WS port) now answers `POST /admin/prepare-shutdown` — loopback callers only (403), `Authorization:
  Bearer <realm token>` only (401; never a URL token), POST only (405) — with `flushActivityNow()`: wait out an
  in-flight tick, `flushCheckpoints(…, {withRep:true})` (new option: the repeat line too, so unchanged contexts' last
  activity survives) through the refactored `writeCheckpoints`, then `persistence.activity.drain()` (new facet method:
  await every per-file write chain) → `{ok, role, bridge_version, flushed:{cp, rep, files_drained[, skipped]}, ms}`.
  Followers write no activity files and issue their persistence writes immediately, so nothing is propagated to them.
  **Tray:** `PrepareShutdown()` (HttpWebRequest, no proxy, 3 s timeout, C# 5) runs first inside `ShutdownAllBridges`
  (so both `OnRestart` and Quit → Shut down all); any failure (a pre-1.59 gateway's 404, none running) → kill anyway.
  Tests: new `test_log_script_live` (40 checks — one-shot, the default text, `--no-log`, `--data-file`/`--data`, 13
  usage errors → 64, no bridge / bad token → 4, the mismatch rule on this host AND a federated one, script-only never
  gone, the logger off the roster, `--stream` (153 lines in order, bad lines in place, overrides + `ref`, EOF 0, a
  reconnect across a HARD-killed gateway with a line queued while it was down, `no-bridge` per line), the endpoint's
  auth (bad / missing / URL token, GET, unknown path) and the flush: a `log:false` burst survives a hard kill + restart
  only via the endpoint — a negative control without it falls back to the last logged bar); against the pre-change
  bridge 31 of the 40 FAIL (the 9 that pass are the script's own local checks). `test_activity_unit` 384 → 386
  (`withRep`). `test_log_live`'s version check is now ≥ 1.58.0. Full suite 1583 passed, 0 failed (48 files; no flakes this run).
- **Built (v1.58.0):** *the agent activity board, build-plan step 2 — the `log` + `activity` tools, gateway-owned state,
  the host's daily JSONL (#70).* **Model changes in `lib/activity.js`** (the step-1 pure core; decisions of 2026-10-01):
  the session key is realm + project + user + session name (the host is not part of it); state and the current line
  change only on `@~`, while progress / ETA move on ANY message (sticky, `none` clears, the ETA is null while the
  context is done/failed); the **`log` flag** (default true) — `log:false` takes full effect (line, state, bar, activity)
  but is not appended to the in-memory log or the file (`entry:null, logged:false`); a message with progress/eta and no
  text defaults to `"{progress}"` (`"{eta}"`); **text is a template** rendered at READ time (`renderText`: `{progress}`
  `{pct}` `{done}` `{total}` `{unit}` `{eta}`, `{{`/`}}` literal, unknown or unfillable placeholders left as typed,
  locale-neutral `fmtNum`) — current lines against the live bar, log entries against what they recorded; the files and
  the snapshot keep the raw template. **Persisted records** carry `new_session` / `new_entity` / `new_context` on the
  first record of each, `evicted` on an evicting entry and `finished_at` on an `@~root` entry, so the **replay**
  (`createReplay` / `replayNewestFirst`, records fed NEWEST FIRST) stops exactly where an instance began and provably
  equals a chronological `apply` of the same entries (seeded random tests, current state AND log contents). Phase 1
  (current line, bar, ETA, state, finished — the newest record carrying each; `phase1Complete()` when everything seen
  is resolved, `publish()` installs it) then phase 2 (each entity's history, chronological, capped); only
  `finished_visible_hours`. **Checkpoints** (`planCheckpoints`, every `progress_checkpoint_sec`, default 60, 0 = off): a
  context whose line / bar / ETA changed via `log:false` gets ONE `{"kind":"cp","k":…}` snapshot line per interval
  (`k` = a per-file key); alive-but-unchanged contexts are run-length encoded in ONE trailing `{"rep":[k…],"n","since",
  "last"}` line, rewritten in place while the key set stays exactly the same (any other write, or another set, starts a
  new one); replay takes `last_activity` from the newest record or rep `last`, and a garbled final line is skipped. New
  read views `boardView` / `logView` / `findEntry`. **Bridge:** ONE WRITER PER HOST — the gateway creates the state on
  promotion (`startActivity` in `becomeGateway`) and replays the host's files in the background (startup never blocks;
  a `log` call waits ≤15 s for it, reads see the phase-1 board early with `loading`); a follower authenticates its own
  sub-peer (`authSub`), validates the input locally, then forwards `{ident, input}` up its control link in an
  `ACTIVITY` frame with a request id (`ACTIVITY_R` back; 5 s timeout → `gateway-timeout`; no gateway during a
  re-election → `no-gateway`; a ≤1.57 gateway → `gateway-unsupported`; a dying link → `gateway-lost`). The gateway
  honours `ACTIVITY` only on a HELLO'd connection that REGISTERED as that follower, and a `log` only for a sub-peer on
  that follower's roster entry. `activity` reads go the same way. Files via a new persistence facet store
  `activity` (`append` / `replaceTail` / `appendSync` / `readAt` / `find` / `days` / `readBackwards` / `prune`; file +
  none + _template): `activity/<host>/YYYY-MM-DD.jsonl` (local date of the record), per-file serialised appends, a
  crash's partial last line repaired before the next append, reads backwards in 64 KB chunks. Ids
  `act_<nonce>_<ts36>-<seq36>`; details/data lookups go memory → id index → a scan of the day the id names. Retention
  (`log_retention_days`) at gateway start + daily; `expire` + `enforceBudget` every minute (and every 50 applies);
  gone = a present→absent transition of the session on this host's roster (swept in `broadcastRoster`), cleared when
  it returns; a clean shutdown flushes pending checkpoints (sync appends on `exit`). Config: the `activity` block via
  `resolveConfig` (live-reloaded), `AI_BRIDGE_ACTIVITY_*` env. **Not yet:** gossip / remote reads (step 4), the
  dashboard (5), `aimb-log.mjs` (3), the agent snippet (6). Also fixed: `test_lib_unit`'s "#71 durable: rehydrate"
  waited a fixed 150 ms for fire-and-forget writes — it now awaits them, and `persistence.projectNames.put` is
  serialised per file so back-to-back saves land in order. Tests: `test_activity_unit` 287 → 384 checks; new
  `test_log_live` (52 checks — gateway + follower on one host: forwarding, one file per host, `@`/`@~`, templates,
  `log:false`, one cp + ONE rep line whose `n` grows and a fresh one after a change, memory / index / scan lookups,
  limits + codes, `enabled:false`, stale, forged frames, gone on deregister, retention, startup replay of a seeded
  file, restart replay twice incl. the `log:false` bar); against the pre-change bridge 46 of the 52 FAIL. `test_lib_unit`
  +1. Full suite 1541 passed, 0 failed (47 files; `test_grants_federate_live` lost a bridge process once in the full run
  and passed 7/7 alone).
- **Built (v1.57.0):** *one canonical project spelling mesh-wide — the first-seen one (#71).* Reported by Ferret :
  PC.1. **What was wrong:** matching was case-insensitive, but surfaces showed whatever spelling they held:
  `allow_project(project:"AIMB")` returned `{from:"aimb"}` (consent stores projKey'd edges and the handler echoed the
  key), `register_self` listed `access:["aimb"]` (`consent.reachable()` returns keys), `request_project_access` echoed a
  lower-cased `to`, and `list_sessions` showed `Marz` (MapGuy2, Lighter) beside `marz` (MapSeeder) — two projects to a
  reader. **Fix:** `lib/project-names.js`, a replicated map `projKey → {name, first_seen}` (§4 "Project names"): a
  sighting — `register_self`, a page hello, the bridge's own identity at startup, an `allow_project` naming a project,
  and on a gateway every roster project in `broadcastRoster()` (`noteRosterProjects`, one timestamp per batch, so ≤1.56
  hosts' sessions get a spelling too) — folds in as `{name, first_seen: now}`; merge keeps the earliest `first_seen`,
  tie → the lexically smaller name. Total order ⇒ idempotent + commutative, so every host re-gossips the whole map:
  `project_names` on `PEER_ROSTER` (in the gossip dedupe signature) and `ROSTER`, a follower→gateway `PROJECT_NAMES`
  frame (on connect + on a new local sighting), persisted one file per host (`project-names/<host>.pnames`, new
  `persistence.projectNames` in file/none/_template) and folded at startup. **Display only:** `displayRoster()` maps
  sessions / sub-peers / topics / pages for `list_sessions` and every WS leaf roster (+ `project_names` for the
  dashboard); `displayIdent()` / `accessOf()` for `register_self` and `my_identity`; `allow_project` (`allow.from/to`,
  trace), `revoke_project`, `request_project_access` (`to`, the request's `from_project`), topic send/publish/park
  results (`project`, `cross_project`, `owner_projects`), `recover_secret` / park candidates, and the #72 notices
  (subject + every body field). The dashboard's `pj()` shows the canonical spelling (roster, project groups, sub-peer
  captions, persistence view: grants, claims, registrations, retained, kept), falling back to its Title case for a
  project the map doesn't know. The ROSTER sent to followers and `PEER_ROSTER` slices stay raw and identities are never
  rewritten (`identity.id` keeps the declared spelling), so a ≤1.56 follower's routing/caps see exactly what they did.
  **Audit** — every project compare/key, checked: consent (`mayInitiate` / `reachable` / `allow` / `revoke` / pending,
  static edges) projKey; topics (`ownersOf` / `subscribersOf` / `iconOf`, claim conflicts, `@project/` refs, the
  cross-project fallback) projKey; durable claims / kept topics / retained / mailboxes / registrations / subscriptions /
  vault / behaviors — the file facet lower-cases every key (`lslug`, `identityKeys`); retained set (`retainedKey`,
  `forProject`) projKey; reminders' project scope projKey; stable `peer:` ids and cap-key input projKey; egress
  allowlist projKey; doorbell watch projKey; `from_topic` projKey; #72 audience + parking projKey; dashboard grouping
  lower-cased. **Real case bugs, fixed:** (1) the **reply-cap** (§5) was minted/verified over the DECLARED spellings, so
  a replier that re-registered as `BETA` (was `Beta`) had its invited cross-project reply `project-denied` — now bound
  by projKey, and the verifier also accepts the raw form a ≤1.56 process minted; (2) `allow_project` compared
  `=== 'unclassified'`, so a caller declared `UNCLASSIFIED` could grant as the infrastructure bucket
  (now `caller-unclassified`); (3) `rosterFor` did the same for a page declared `Unclassified` (it got a scoped roster
  instead of the full one); (4) `isIdentityLive` compared user + name exact-case (a live owner could read as dormant
  for §16). **Compat:** a ≤1.56 peer ignores `project_names` / `PROJECT_NAMES` and keeps showing declared spellings;
  the #72 notice's legacy `to`/`from` fields now carry canonical spellings instead of the projKey (compare them
  case-insensitively). **Limit:** `first_seen` is wall-clock, so "first" is approximate under clock skew (agreement
  doesn't depend on it); the map is capped at 1000 projects. Tests: new `test_project_case_live` (27 checks — two hosts +
  a follower: `Marz`/`marz`/`MARZ` shown as one spelling on all three bridges and in the registrant's own
  `register_self`, concurrent `ops`/`Ops` converge to one spelling on both hosts, `allow_project` "AIMB"/"aimb" →
  `allow.from` "AIMB", the grantee's + granter's `access`, notice subject/body, `request_project_access` / revoke echo,
  the dashboard roster + map, the reply-cap survives a `Beta`→`BETA` re-register, `UNCLASSIFIED` can't grant); against
  the pre-change bridge 23 of the 27 FAIL. +14 `test_lib_unit` checks (first-seen, earlier wins, tie rule, junk,
  commutative/idempotent across orders, durable round-trip). `test_grants_federate_live` now expects `access` "Marz".
  Full suite 1104 passed, 0 failed (45 files).
- **Built (v1.56.0):** *grants are announced to the granted project (#72).* Reported by Ferret : PC.1. **What was
  wrong:** `allow_project` told only a PENDING `request_project_access` requester (`notified: 0` otherwise), and pending
  requests live only in the bridge where the request was made — so when Ferret granted AIMB bidirectional access, no AIMB
  session ever learned it could now reach Ferret. **Fix:** `allow_project` now sends a **`project_access_granted`** system
  notice to the granted project's live members mesh-wide (`projectTargets`: local sub-peers + every roster session /
  sub-peer / page in that project — the audience `request_project_access` already used) and **parks** it for each durable
  registration of that project that is live nowhere on the roster (mailbox `name:<peer>`, drained on its next
  `register_self`, as §19 parking; only registrations in the granting bridge's store — a shared Dropbox store covers
  every host, a host-local one only that host). Subject (public) e.g. `Ferret granted AIMB access (bidirectional, 30m)`;
  `from` = the granting sub-peer (so `from.project` is the granting project and a reply reaches the granter); body
  `{action:"granted", granting_project, granted_project, mode, one_way, direction:"AIMB -> Ferret"|"AIMB <-> Ferret",
  ttl_minutes, expires_at, granted_by:{name,session,project,user}, note, to, from}` (`to`/`from` = the Bug-3 ack's
  original fields). `revoke_project` sends **`project_access_revoked`** the same way (`{action:"revoked", …, mode,
  revoked_by}`, subject `Ferret revoked AIMB access`). **Consent:** the notice runs granting → granted, which a one-way
  grant leaves closed, so it is `system` — the exemption `project_access_request` and the Bug-3 ack already use,
  set only by bridge code for these verbs, so an ordinary send in that direction stays `project-denied` (tested); a
  ≤1.55 receiver honours it too. **No duplicates:** only the `allow_project` / `revoke_project` handler announces;
  `consent.merge()` (GRANTS / PEER_ROSTER gossip) has no hook, so one notice per change mesh-wide. A re-grant of a
  live edge with the same mode and TTL (forever, or the same minutes — read back from the stored record as
  `exp − updated_at` via the new `consent.edge()`) is not re-announced (`announce:"unchanged"`); a revoke of an edge
  that wasn't live changes nothing and announces nothing. **Pending requesters** ride the same call as extra targets
  (their copy adds `request_id`) and are skipped in the broadcast — one notice each, and still acked on an unchanged
  re-grant. **Return:** `notified` now counts every notice (pending acks + live announcements + parked; was pending
  only), split as `notified_pending`, `announced`, `parked`; `revoke_project` gains `notified` / `announced` / `parked`.
  Not announced: a TTL grant expiring on its own. Tests: new `test_grant_notice_live` (28 checks) — same-bridge and
  cross-bridge live delivery with verb/mode/granter/subject, one-way consent still denies ordinary Alpha → Beta traffic,
  parked for an offline durable registration + delivered on re-register, no duplicate from the gossip-learning bridge,
  identical re-grants (forever and 30m) silent, a changed grant re-announced, revoke notices, a pending requester acked
  once with its `request_id`; against the pre-change bridge 20 of the 28 FAIL. Full suite 1063 passed (44 files).
- **Built (v1.55.0):** *doorbell `peer-unknown` — no re-arm loop after a bridge restart (#73).* Reported by Ferret :
  PC.1. **What was wrong:** after a bridge restart a session's sub-peer name is unknown until it calls `register_self`
  again, but a doorbell armed on it got `{type:"gone"}` at once → `reason:"peer-gone"` + the silent-re-arm guidance →
  re-arm → instant `gone` again: a loop that never re-registered. **Fix (bridge):** the listener remembers whether its
  watched name was on the roster at any point while armed (`ws.watchSeen`, set by `notifyOne` whenever
  `listenerState` finds it). Missing and never seen → new `{type:"unknown", watch}`; seen then missing →
  `{type:"gone", watch}` as before. Project scoping unchanged; a topic-only watch gets neither. **Fix (script):**
  `unknown` → `reason:"peer-unknown"`, exit 0 (not a bridge fault), status state `unknown`, and
  `guidance:"Your name isn't registered on this bridge (it probably restarted). Call register_self with your name +
  secret, then re-arm the doorbell."` — deliberately NOT the silent re-arm. `peer-gone` keeps the silent re-arm and
  now adds "if the bridge restarted since your last register_self, call it first". **Mixed mesh:** a <1.55 bridge
  has no `unknown` frame and sends `gone` for a never-registered name, so the script treats a `gone` within
  `AIMB_DOORBELL_EARLY_GONE_MS` (default 2000) of `welcome` from a bridge whose `welcome.bridge_version` is <1.55.0
  (or absent) as `peer-unknown` + `inferred_from:"early-gone"` — the hot-loop guard; later, or from a ≥1.55 bridge,
  it stays `peer-gone`. Trade-off: on an old bridge a name that genuinely leaves within 2 s of arming reads as
  `peer-unknown` (harmless: re-registering is the right move then too). An OLD script on a NEW bridge ignores
  `unknown` and simply waits (chime / timeout; it rings if the name re-registers) — no loop either way. Tests:
  `test_doorbell_live` 56 → 71 — listener `unknown` for a never-registered name (no `gone`), `gone` (no `unknown`) for
  one that deregisters while armed, the name in another project is `unknown`, a topic watch gets neither; the script's
  `peer-unknown` (exit 0, re-register guidance, not silent, status file) vs `peer-gone` (silent + re-register hint);
  and a fake old listener server proving the guard (instant `gone` from 1.54.0 → `peer-unknown`, a late one →
  `peer-gone`, an instant one from 1.55.0 → `peer-gone`). New hook `AIMB_DOORBELL_TEST_BRIDGE` runs the bridge half
  against another copy; against the pre-change bridge + script 9 of the new checks FAIL.
- **Built (v1.54.0, tray):** *Task Tray "Restart Bridges…" menu item.* Sits above Quit; a Yes/No confirmation (default No) then stops every `bridge.mjs` process on the machine, waits up to 10s for them to exit (ports free), re-reads version/ports and launches a fresh headless gateway, pausing the keep-alive monitor meanwhile. Tray-only — bridge version unchanged; rebuild with `tray/windows/build.cmd`.
- **Built (v1.54.0):** *doorbell 6-hour inbox check-in keeps the bridge loaded (#69).* Robin's request: an idle
  session that only loops the doorbell makes no bridge tool call for hours, so the host may unload the MCP bridge
  from it. The hourly chimes (#67) whose boundary falls on 00:00, 06:00, 12:00 or 18:00 LOCAL now keep
  `reason:"hourly"` + `time` and add `inbox_check:true` with `guidance:"6-hour check-in (18:00): call your inbox tool
  now even if nothing is waiting — it keeps the Ai MCP Bridge loaded in this session. Then display the time to the
  user and re-arm the doorbell."` — the same fields land in the `--status` exit write. Every other chime, mail exits
  and explicit-`--timeout` exits are byte-for-byte unchanged. **Mark from the boundary, not the clock:** the chime
  already waits out an early timer and labels itself with the boundary; the check-in is decided the same way,
  `isCheckinMark(target)` on the boundary's local wall time (seconds since local midnight divisible by
  `every × period`; real period 3600 s and every 6 → hour % 6 === 0), so drift can't turn 00:00 into a "23:59"
  non-check-in and midnight reports `"00:00"`. The pure maths (`nextBoundary`, `hhmm`, `isCheckinMark`) moved to
  `tools/aimb-doorbell-clock.mjs`, imported by the script (ships beside it) and by the test — the script itself
  runs on import, so a side-effect-free module is what makes it unit-testable. Knobs: `AIMB_DOORBELL_PERIOD_SEC`
  (existing test hook) and `AIMB_DOORBELL_CHECKIN_EVERY=<k>` (default 6; test/tuning — every k-th boundary). The
  realm connect default in `config.example.json` (356 chars, under the 365 cap) and the code-session `set_wake` hint
  mention the check-in. Tests: `test_doorbell_live` 40 → 56 — on-mark chime (every = 1: `hourly` + time +
  `inbox_check:true` + check-in guidance, never early, status file), off-mark chime (no `inbox_check`, exact #67
  guidance), default interval consistency (period 2 s: `inbox_check` iff seconds-since-midnight % 12 === 0), mail and
  `--timeout` carry no `inbox_check` even when every boundary is a mark, and pure checks (00/06/12/18 yes, 01/23 no,
  all 24 hours, the boundary after 23:59:59.998 is "00:00" + a check-in, after 17:59:59.998 is 18:00, after
  18:00:00.001 is 19:00 + not). Run against the pre-change script (`AIMB_DOORBELL_TEST_TOOLS` → a temp copy) 9 checks
  FAIL (3 live on-mark + 6 pure).
- **Built (v1.53.0):** *TPM probe requires the platform crypto provider — no software-key false positive (#42).*
  **What was wrong:** the #41 `tpm` probe asked "did `Tpm.exe --pubkey` exit 0 with a PUBKEY?", and `seal()` trusted
  the same answer — so on the field host with no usable TPM the bridge advertised `recover_secret:true` and would
  seal secrets to whatever key came back. "Got bytes" cannot answer "was it hardware". **Found on the way (the old
  helper):** the pre-#42 `Tpm.cs` already named ONLY the Microsoft Platform Crypto Provider, per-user key
  `aimb-vault` — there is no software-provider fallback in its source (the live exe's strings confirm the same
  provider + key name), and on ROBIN-Z790 (Intel PTT, TPM 2.0) that key exists in the PCP and not in the software
  KSP. The field host's "no TPM" reading came from `Win32_Tpm`, which needs admin (non-elevated it is *Access
  denied*), so what backed the key there is still unproven; the new helper now answers that definitively. **Built:**
  (1) `tray/windows/Tpm.cs` is hardware-or-nothing for EVERY mode: it requires a TPM visible to TPM Base Services
  (`Tbsi_GetDeviceInfo`, no admin needed), opens/creates the key under the Platform Crypto Provider only, and proves
  the key is TPM-backed by the provider answering `PCP_PLATFORM_TYPE` (`TPM-Version:2.0 -Level:0-…`), which a
  software KSP cannot. Any failure is **exit 2** + `ERROR=<no-tpm|platform-provider-unavailable|not-platform-provider|
  not-hardware-backed|key-missing …>` on stderr. `--pubkey` now also prints `PROVIDER=` and `PLATFORM_TYPE=` (the
  positive signal); `--decrypt` opens the key (never creates one) BEFORE raising Windows Hello, so a TPM-less box
  never shows a prompt that cannot lead to a decrypt; optional `--key <name>` for scratch testing. `build-tpm.cmd`
  takes an optional output directory so a new helper can be built and tested without replacing the live one.
  (2) `facets/vault/tpm.js` `hardwareKey()` trusts a key only when the helper exits 0 AND reports
  `PROVIDER=Microsoft Platform Crypto Provider` AND a `PLATFORM_TYPE=TPM-Version:…`; otherwise `probe()` is false
  with a reason (`tpm-unavailable` + the helper's `detail`, `tpm-not-hardware`, or `tpm-helper-outdated` for a pre-#42
  exe) and `seal()` returns null (nothing stored, WARN logged) instead of sealing to unproven storage. A missing helper
  still is NOT auto-built by the probe, but now says so: `reason:'tpm-helper-missing'` + `hint: "tpm helper not built
  — run tray/windows/build-tpm.cmd, then restart the bridge"`. `seal()`/`unseal()` only auto-build the DEFAULT helper
  path (building for an `AI_BRIDGE_TPM_HELPER` override would silently replace the live exe instead); new
  `AI_BRIDGE_TPM_KEY` passes `--key`. (3) `bridge.mjs` keeps the last probe result per facet and returns it in
  `my_identity.facet_probe` (reason/detail/hint visible, not just the bit), adds the hint to the startup WARN, and a
  failed unseal's helper `detail` rides `recover_secret`'s `recovery-denied`. **Dropbox-synced exe:** the checks are
  made at RUNTIME on the machine that runs the exe; nothing about the build machine's TPM is baked in, so a
  Windows-built `Tpm.exe` that Dropbox lands on a TPM-less machine now exits 2 there and the probe reports false.
  **Verified:** `test_facet_probe_live` +10 checks (21 total) with a stub helper compiled by the in-box csc —
  software-KSP provider ⇒ false + seal refused (`no-vault-entry`), pre-#42 output ⇒ false + refused, non-zero exit ⇒
  false, platform provider ⇒ true + sealed (recovery reaches the helper) — plus the missing-helper hint; 5 of them FAIL
  against the pre-fix `tpm.js`. Scratch build on ROBIN-Z790: `--pubkey`/`--selftest` report the PCP + `TPM-Version:2.0
  … VendorID:'INTC'`; a `tpm.js` seal to a scratch key TPM-decrypts back to the plaintext (Hello-gated `--decrypt` not
  run headlessly); a missing key fails exit 2 before any prompt. Suite 1004 across 43. **Deployment — KEY-COMPATIBLE:** same provider, same
  key name, and the new helper returns a byte-identical public key for the existing `aimb-vault` key, so existing
  sealed blobs keep working and no re-registration is needed. Rebuild the live helper with
  `tray\windows\build-tpm.cmd` (Dropbox then syncs it to other Windows hosts, where it now fails honestly if they
  lack a TPM), then restart bridges/tray to pick up v1.53.0. Order matters only one way: a v1.53.0 bridge with the
  OLD exe reports `recover_secret:false` (`tpm-helper-outdated`) and skips re-sealing (existing vault entries are kept;
  an identity registering for the FIRST time in that window gets none until it re-registers) until the exe is rebuilt;
  an older bridge with the NEW exe works unchanged (it still reads `PUBKEY=`). So: rebuild first, then restart.
- **Built (v1.52.0):** *the dashboard shows a CLI code session ONCE, not as bridge + sub-peer (#58).* **What was
  wrong:** the desktop app shares ONE bridge across conversations (N conversations = 1 bridge + N sub-peers, and the
  connections view hides that agent bridge), but a CLI host spawns one follower bridge PER Claude Code session (MCP
  stdio), so each conversation drew twice: a bare-hex, `claude-code`, topic-less bridge row/orange bubble AND the
  sub-peer it registered (Modell, Renda). Not a routing bug — a presentation one. **Built (dashboard only, no
  bridge/protocol change):** `soloSub(s)` in `dashboard.html` names the pair: a FOLLOWER (not `is_gateway`) with
  `client_kind==='code'`, exactly ONE sub-peer, and no topic OWNED by the bridge itself (collapsing would hide the
  claim). Such a pair renders as the sub-peer alone — it carries the name, topics and project — everywhere: the
  connections view (no bridge row), the show-bridges view (one top-level row instead of bridge + ↳ leaf), the mesh
  map (one sub-peer-styled node in the bridge row with the edge to its gateway; `nodePos` maps BOTH ids, so a trace
  naming either pulses it; the edge takes the sub-peer's id) and the Computers counts (the pair is one Connection,
  not also a Session). The bridge's session id, version, client and connected time go on the hover title and the row
  expander (`bridgeNote`). **Unchanged by design:** gateways (even a `claude-code` gateway with one sub-peer), a
  bare code session with NO sub-peer (a standalone MCP connection, e.g. `Robins-Mac.local/43cbd85c`), a follower
  hosting 2+ sub-peers (shown like the desktop's shared bridge today), and agent/cowork/tray bridges. Regression guard
  `test_dashboard_collapse` (jsdom, three-machine fixture covering each case, 30 checks); verified to FAIL 12 checks
  against the pre-change `dashboard.html` (it reads `DASHBOARD_HTML` to point at another copy).
- **Built (v1.51.0):** *send on behalf of a topic — `from_topic` attribution (#54).* **What was missing:** sender
  attribution was always the PEER. The envelope's `topic` is set by ROUTING (the destination of a `topic:X` send, the
  channel of a publish), never authorship, so there was no way to say "this came FROM topic X" — and "messages from the
  Retail topic" should stay one coherent thread across an owner handoff or a peer-id rotation, where "messages from
  Retally" do not. **Built:** `send_to_peer` takes an optional `from_topic`. New `fromTopicOf(holder, project, ref)`
  validates it on the SENDING bridge before anything is routed or parked: the caller (the `as`/secret sub-peer, or the
  process session) must hold a LIVE `role:'owner'` entry for that concrete topic in `myTopics`, in its own project —
  any co-owner of a shared topic qualifies; a dormant durable record does not (it isn't holding the topic now).
  Otherwise `{ok:false, code:'not-topic-owner', topic}` and nothing is sent; a wildcard is `wildcard-from-topic`; a
  `@other/…` ref can't match (you own a topic only in your project). **Shape:** two FLAT cleartext envelope fields,
  `from_topic` (the claim's own spelling) and `from_topic_icon` (the caller's claim icon, else a co-owner's via
  `iconOf`, so a shared topic reads the same whichever owner speaks; omitted when there's none) — flat because the push
  channel meta is flat strings, and the same two names are used everywhere (envelope, `inbox`, channel meta, traces).
  **Additive, never replacing `from`:** accountability, default reply routing, reply-caps and the hop/loop guard all
  still key off the real peer. `makeEnvelope` sets them before the id is computed; `envelopeId` hashes them only when
  present, so a plain envelope's id is unchanged. Being on the envelope they survive every path untouched: local
  (`deliver`/`deliverSub`), same-host pair-dial, cross-host splice, `topic:` fanout (`routeToTopicOwners` threads the
  validated fields to every per-owner envelope), parking (`parkToOfflineOwners` incl. the #26 ownerless kept-alive
  mailbox, `parkToOfflineName`) and durable redelivery (the stored record is the whole envelope; the kept-alive drain
  spreads it). `inbox` shows them (via `decryptedView`), the push meta adds them (`fromTopicMeta`; absent ⇒ no keys),
  `emitTrace` + the park traces carry them, and the dashboard trace row renders `⚡ Retail (via Retally)` with an "on
  behalf of" detail. The shipped `receive` convention (`config.example.json`, 349/365 chars) now says: with
  from_topic, write `🖂 from <from_topic_icon> <from_topic> (via <sender>) · …` (a host's own `config.json` keeps its
  copy until edited). **Replies:** unchanged — to the peer; a receiver wanting continuity across a handoff can reply
  to `topic:<from_topic>` (documented, no automatic rerouting). **Not on `publish`:** there the channel already IS the
  topic. **Pages:** the WS `send` path accepts `from_topic` too, validated the same way against the page's only claim
  — its auto-claimed `subject` (the refusal comes back as `sent {ok:false, code}`); `aimb-page-bridge.js`'s `send`
  passes it through. **Mixed versions:** ≤1.50 bridges carry the unknown fields through untouched (every forward
  spreads the envelope) and ≤1.50 receivers simply ignore them and show the peer; a ≤1.50 SENDER ignores `from_topic`
  (so it can't stamp one — attribution is only as trustworthy as the realm, same as `from`). **Test:**
  `test_from_topic_live` (46 checks, two gateways on 127.0.0.1/.2 with file persistence — owner sends locally and
  cross-host with the icon and `from` intact, push meta too, a plain send has no field; a non-owner / the unclaimed
  process / a wildcard / another project's ref are refused and nothing is delivered; a `topic:` fanout across both
  hosts keeps it; a cross-host co-owner of a shared topic may speak for it; replies to the peer and to
  `topic:<from_topic>`; parked-to-offline-owner and parked-by-name mail keeps it after re-register; handoff — the
  released co-owner and old owner are refused, the new owner may send, mail parked on the ownerless topic drains with
  its field; a page for its own subject but not another). Verified to FAIL against v1.50.0 (33 of 46 checks).
  `test_lib_unit` +2 (`envelopeId` covers `from_topic`; a plain id is unchanged). Full suite 964 across 42 files,
  green. No config or wire-protocol change.
- **Built (v1.50.0):** *`claim_topic` re-claim keeps omitted fields instead of resetting them (#55).* **What was
  wrong:** a re-claim (same holder, same topic) rebuilt the claim from the call's arguments, so every field the caller
  left out (`description`, `icon`, `exclusive`, `announce_offline`, `grace_minutes`, `allow_other_user`, `keep_alive`,
  `persistent`) fell back to its default. Since #64 (v1.41.0) flipped the defaults to `exclusive:true`/
  `announce_offline:true`, a plain `claim_topic {topic}` — routine after a compact or restart — silently turned a
  SHARED topic EXCLUSIVE (or was refused `held` against its own co-owner) and wiped the description, icon and
  continuity settings. The kept-alive (#26) fallback didn't help: that marker is null while the topic is owned.
  **Fix:** a re-claim is a PATCH. The handler first finds the EXISTING claim — the live one in `myTopics` (which
  includes one `rehydrateClaim` restored after the holder re-registered), else this holder's own DORMANT durable
  record (new `ownDurableClaim`: on disk but not in RAM, e.g. a rehydrate refused by a then-live exclusive owner, or a
  process claim racing the async process rehydrate; that record is exactly what a rehydrate would restore, so it is
  treated as the existing claim and its `claimed_at` kept). Per field the precedence is **explicit arg > existing
  claim > kept-alive marker (new claims only) > default**; an explicit `false`/`""`/`null` is a real value (it
  clears). The conflict checks (the live `blocker` and `resolveDormantConflict`) run on the EFFECTIVE `exclusive`:
  a plain re-claim of a co-owned shared topic stays shared and succeeds, an explicit flip to `exclusive:true` with
  a co-owner is still refused `held`. A re-claim with `persistent:false` now also removes the durable record (before,
  it lingered and the claim came back after a restart). The identity match `resolveDormantConflict` used is factored
  into `sameClaimHolder` so both paths agree (case-insensitive user/name). Tool-schema text + `src/README.md` say
  the defaults apply to NEW claims and a re-claim keeps what it omits. **Test:** `test_reclaim_preserve_live` (28
  checks — new-claim defaults; a full claim re-claimed with only `topic` unchanged on the roster + response; a
  one-field re-claim changes only that field; the shared co-owner / flip-to-exclusive conflict; a planted own
  dormant record is patched; `persistent:false` drops the record; restart → re-register → rehydrate → plain
  re-claim keeps every field, and a second restart still restores them). Verified to FAIL against v1.49.0 (15 of
  28 checks). Full suite 916 across 41 files, green. No config or wire change; per-host only (each host's own claims).
- **Built (v1.49.0):** *stop leaking page reply-cap keys in the roster (#68).* **What was wrong:** each page leaf's
  entry in the gateway's `pages` map holds `capKey`, its reply-cap SIGNING key (`makeEnvelope` mints a page's caps
  with it; `verifyReplyCap` checks a reply to the page against it). `rosterPayload()` built its page list by
  SPREADING the stored entries (`{ ...p, host_label }`), so every page's `capKey` (a serialized Buffer) went out in
  the `list_sessions` tool, in the follower `ROSTER` frame (and so a follower's own `list_sessions`), and in the WS
  `welcome`/`roster` to every leaf — other pages and dashboards (`rosterPayloadFor`/`rosterFor` derive from it). A
  holder of page P's `capKey` can mint a valid reply cap and deliver to P from a project with no grant: the reply-cap
  exception in `deliveryAllowed` is an independent allow OR'd after the consent check, so this is a cross-project
  consent bypass. Only the peer gossip (`localPagesSlice`) was already allow-listed. **Fix:** new `publicPage(p)` —
  an explicit ALLOW-LIST of the public page fields (`instance, page_kind, title, subject, subscriptions, icon, kind,
  project, user, realm, host_label, origin, host, port, page_ingress` + the identity facet's label fields) — applied
  in `rosterPayload()` to local AND remote (#66d) pages, so every roster-shaped output passes through it. Defence in
  depth: a follower keeps only `publicPage()` of what a (≤1.48) gateway's `ROSTER` sends, and `mergeRemoteRoster`
  keeps only the public fields of a peer's gossiped pages. `capKey` stays in the in-memory `pages` map where the
  gateway needs it (a follower never uses a page's key: pages send and receive on their gateway). **Audit** of the
  rest: session entries, sub-peer lists (the `REGISTER`/`SUBPEERS`/`announceSubpeers`/`becomeGateway` builders),
  topic records, traces, the dashboard persistence snapshot (vault identities only, never `sealed`), `my_identity`
  and `register_self` replies were already built field-by-field — no `secretHash`, sub-peer `capKey`, token or sealed
  data leaves the process. **Scope:** a consent bypass WITHIN the realm; every reader of the roster already holds the
  realm token, from which (since #43) a page's key is derivable anyway, so nothing is exposed to outsiders — but the
  key no longer lands ready-made in AI transcripts, logs and every web page. New `test_roster_secrets_live` (30
  checks): a gateway + follower + raw control-port follower + peer gateway on a second loopback "host", pages and
  secret-holding sub-peers on both; asserts no `capKey`/`secretHash`/`token`/`sealed` key (or serialized Buffer) at
  any depth in `list_sessions` (gateway, follower, peer), the follower `ROSTER` frames on the wire, and a dashboard's
  and a second page's `welcome`/`roster`/`trace_history`; plus the reply-cap flow to a page still works (a
  cross-project reply is delivered, a fresh send is still denied). Verified to FAIL (13 checks) on the pre-fix code.
- **Built (v1.48.0):** *retained values + remote page subscriptions federate (#66c/d).* **(c) What was wrong:** a
  `publish {retain:true}` was stored only in the PUBLISHING host's persistence store, and the subscribe-time catch-up
  read only the subscriber's own store — so a subscriber that joined later on another machine never got the value.
  **Design (the #62 pattern):** new `lib/retained.js` holds a replicated last-writer-wins SET keyed by
  `(realm, project, topic)` (project/topic case-insensitive): `{ realm, project, topic, ts (ms = the publish time),
  env (the stored, body-ciphered envelope), origin }`. `beatsRetained`: greater `ts`, then the greater envelope id — a
  total order, so merge is idempotent + commutative; no tombstones (a newer publish simply replaces the value). Every
  process holds the set in RAM (so a gateway without persistence still relays it). A local retained publish is still
  written under the publisher (unchanged) and merged into the set; a win on a gateway → `broadcastRoster`, on a
  follower → a new follower→gateway frame `RETAINED {session, retained:[…]}` (just the changed record; the whole set on
  every (re)connect after `REGISTER`; accepted only after `HELLO`). The set rides `PEER_ROSTER.retained` and
  `ROSTER.retained` — but, unlike grants, ONLY to a peer link / follower that hasn't had the set's current `version()`
  yet (`sendGossip` / `followerRetainedV`): the set can be MBs and the roster is re-sent on every unread-count change.
  A fresh link or (re)registered follower has no version, so it gets the whole set; the version is in the
  `gossipToPeers` dedupe signature, so a change goes at once. `mergeRemoteRoster` merges it BEFORE the #63
  unchanged-slice return (as grants/realm defaults). **Persistence:** what a process LEARNS it writes into its own
  store under a synthetic identity `{user:'#replicated', name:<host>}` (one file per writing host per topic, as #66b);
  the store's newest-per-topic read makes it just another candidate. New `retained.all()` on the store facets;
  `rehydrate()` loads it at startup, so a restarted host keeps serving AND re-gossiping a value whose publisher is
  offline. **Catch-up:** `subscribe` now takes, per topic, the newest of the store (own + learned) and the set (values
  not yet on disk), preferring the store on a tie, and delivers exactly as before (a fresh envelope via
  `routeEnvelope` → `deliverSub`), still gated by `PERSIST` as today. **Size cap:** a record whose envelope serialises
  to more than 64KB (`RETAIN_REPLICATE_MAX_BYTES`; env `AI_BRIDGE_RETAIN_REPLICATE_MAX_BYTES`) is NOT replicated: the
  publisher keeps it in its own store (local subscribers still get it) and the set gossips a small MARKER instead,
  `{…, env:null, too_large:<bytes>}`, which beats any older replicated value, so no other host keeps serving a stale
  one; there a later subscriber gets nothing for that topic. The publish reply says so: `retained_replicated:false,
  retained_bytes, retained_cap_bytes, retained_note`, plus a log line. The whole gossiped set is also budgeted at 4MB
  per frame (`AI_BRIDGE_RETAIN_GOSSIP_MAX_BYTES`; frames die above 8MB): newest first, older values beyond it stay
  local (logged). The file store prefers a file that holds the value over a marker on a ts tie. **TTL:** the store's
  `retainedTtlDays` (default 14) from the ORIGINAL publish time — an expired record is refused on merge, never listed
  or served, and `gc()` (every 10 min, `AI_BRIDGE_RETAIN_GC_MS`) drops it; the store's own `gcAll` ages learned copies
  the same way. **Consent unchanged:** the catch-up considers only records in the SUBSCRIBER's project + realm, and
  each delivery still goes through `deliverSub` → `deliveryAllowed(publisher project → subscriber project)` on the
  subscriber's host (grants federate since #62), so replication widens nothing. **Why gossip, not on-demand:** a
  request to the owning host at subscribe time needs a new request/response protocol with timeouts through followers
  and gateways, and fails exactly when the publisher is offline; the LWW set reuses the proven #62 machinery and keeps
  working with the publisher gone. **(d) What was wrong:** gossiped pages carried display fields only
  (`localPagesSlice`) and page delivery was local-only, so a publish on host A never reached a page on host B's gateway
  even though A could see it (on a follower, remote pages even showed up as `unclassified` owners and a send to one was
  a blind `PAGE_MSG` reported `ok:true`). **Design:** `localPagesSlice` now also gossips each page's `subscriptions`
  (≤32 patterns), `realm` and a capability flag `page_ingress:true` — never its `capKey`. `mergeRemoteRoster` stores
  remote pages with the owning gateway's `host`/`port` (like remote sessions), and followers get them in `ROSTER`.
  `allTopicEntries` (hence `subscribersOf`/`ownersOf`/`iconOf`) now walks remote pages too, with their bare
  `project`/`realm`, but ONLY those flagged `page_ingress` — a page behind an older gateway can't be reached, so it
  must not look like a subscriber. **Routing:** `routeEnvelope` sends a `page:<instance>` that isn't local to
  `routeRemotePage`: dial the owning gateway's well-known port with `CONNECT page:<instance>` (a follower dials it
  directly, as it does for remote sessions); without `page_ingress` it returns `ok:false page-remote-unsupported`
  without dialing. **Ingress:** `onControlConn` answers a `CONNECT` for a page target itself (pages live on the
  gateway, not behind a pair port): an unknown page → `REJECT page-gone`; else `ACCEPT`, and the `MSG` goes to the
  unchanged `deliverPage` — whose socket check (`page-gone`), consent check (`project-denied`, run on the page's
  host) and send check (`page-send-failed`) now come back to the sender in the #61 `CLOSE` code (`target-mismatch` if
  the envelope names another target). So a publish fanout entry for a remote page is honest (`ok:true` only when
  delivered). **send_to_peer** to a remote page falls out: `resolvePageTarget` also resolves remote instances (and a
  unique remote title/kind when no local page matches), then `routeEnvelope` routes it. A page→page send from a leaf
  and the gateway's `PAGE_MSG` handler now go through `routeEnvelope` too (a ≤1.47 follower forwards every page it sees
  there). `projectOfTarget`/`nameOf` read remote pages. **Frames/fields:** `PEER_ROSTER.retained`, `ROSTER.retained`,
  new `RETAINED` frame; page slice `subscriptions`/`realm`/`page_ingress`; remote page entries gain `host`/`port`;
  `CONNECT page:<instance>` + `MSG` + `CLOSE` on a gateway's control port. **Mixed versions:** ≤1.47 bridges ignore
  the new fields and the `RETAINED` frame, so retained values spread only among 1.48+ hosts (a ≤1.47 host serves only
  its own store, as before), and a ≤1.47 gateway's pages carry no `page_ingress` — they are skipped as subscribers and
  a directed send fails `page-remote-unsupported` (a ≤1.47 gateway given a page `CONNECT` answers `unknown-target`).
  A ≤1.47 sender still can't reach a remote page (unchanged). Test-only: `AI_BRIDGE_TEST_GOSSIP=legacy` now also
  mimics a ≤1.47 gateway's pages (no new slice fields, page `CONNECT` → `unknown-target`). **Trust:** any realm member
  can gossip a retained value — the same level as the existing unsigned roster/grant gossip; a far-future `ts` would
  win (and never age out, since the TTL counts from `ts`) until a later one beats it. **Tests:** 19 new unit checks in `test_lib_unit`
  (key case-insensitivity, junk refused, marker conversion, LWW order + tie, idempotent, persist-on-learn only, TTL on
  merge/list/gc, marker retires an older value, gossip budget, commutative, rehydrate incl. markers). New
  `test_retain_federate_live` (20 checks; two gateways + a follower with its OWN store, file persistence, temp
  configs): a later subscriber on A's follower and gateway gets B's value; a newer publish from A's follower
  replaces it on B and A; another project's subscriber gets nothing; a cross-project value is withheld until a
  (federated) grant, then delivered; an oversized value reports `retained_replicated:false`, retires the older value
  on A and is still served on B; a learned value survives A restarting with B down. New `test_page_remote_live`
  (18 checks; A + follower, B with a WS page leaf, C an older gateway): publishes from A's gateway and follower reach
  B's page with fanout `ok:true`; `send_to_peer` by instance, by title and from the follower land (a real outcome, not
  the blind forward); an Other-project publish/send is `project-denied` and never lands; C's page is not in the
  fanout and a directed send is `page-remote-unsupported`; B rejects `CONNECT page:<unknown>` with `page-gone`. The
  page test also passes with host C spawned from the real 1.47.0 bridge (`AIMB_TEST_LEGACY_BRIDGE`). Against the
  pre-change bridge (`AIMB_TEST_BRIDGE`) 10 of 20 retained and 14 of 18 page checks FAIL (the passes are harness
  checks and negatives). Suite 858 across 39.
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
- **Superseded — was open (#42), FIXED in v1.53.0 (see that entry; the helper source turned out to have no
  software fallback, but "got a key" still proved nothing): the #41 probe's PREMISE is false — `Tpm.exe
  --pubkey` succeeds without a TPM.**
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
