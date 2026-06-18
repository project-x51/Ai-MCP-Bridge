# Ai MCP Bridge

Peer-to-peer mesh for AI sessions + web pages on one PC (multi-host later via Tailscale).
One bridge per MCP stdio client — which is one per **Claude Code session**, but only one per
**Claude Desktop app instance**: ALL Cowork conversations share that process. Shared conversations
(and subagents) therefore register as **sub-peers** with their own identity, secret and private
inbox — see "Sub-peers" below. Port-bind election picks the per-host gateway
(:7000); followers register over a control connection. Same-host session pairs dial each other's
loopback ports directly. The gateway is also the WebSocket ingress (:7001) for **page leaves**
(any embedding web page, plus the bundled dashboard.html) and the trace collector for the debug dashboard.

Security model: splice-opaque gateway (end-to-end encrypted bodies pass through unread), Tailscale
overlay identity for cross-host, tailnet-membership pairing, and no raw credentials on the wire.

Design rationale — the realm / pluggable-profile model, mandatory project+user classification,
receiver-controlled cross-project consent, signed reply capabilities, project-scoped topics, and
federation via translator bridges: see [`../docs/architecture.md`](../docs/architecture.md).

## Files
- `bridge.mjs` — the mesh node + gateway/WS/trace roles + MCP stdio server (realm-agnostic core).
- `facets/` — the pluggable realm profile: `auth/ cipher/ capsigner/ identity/ config/ transport/
  discovery/ persistence/ authorizer/`, each with a `_template.js` + impl files, assembled by
  `facets/index.js`. Copy a file to add one. (`discovery` = §7 cross-host, `persistence` = §12 durable
  state, `authorizer` = §16 presence-gated confirmation.)
- `config.json` — `port`, `wsPort`, `token`, `realm`, optional `projects` policy / `profile` / `tray`.
- `tools/` — embeddable client tools (consumers inline / inject these):
  - `tools/aimb-page-bridge.js` — leaf client embedded by page renderers (`window.AIMB_BRIDGE_CFG` + `aimbBridge.send`).
  - `tools/aimb-bridge-ui.js` — reusable bridge UI widget: pip + session/topic dropdown + send-button wiring,
    injects its own CSS, no framework. Any renderer inlines it after `aimb-page-bridge.js` and calls
    `aimbBridgeUI.init({mount, buttons, verb, subject, payload})`. See "Pages".
  - `tools/research_client.js` — example page leaf injected into a browser tab (generic site research;
    wayback engine on web.archive.org).
- `dashboard.html` — live debug page: **mesh map** (hosts grouped by session-id prefix, gateway ringed,
  sessions/pages as nodes, control/page edges, amber pulse on message activity, gateway↔gateway edge
  appears when cross-host gossip lands), plus roster tables + trace feed. **The gateway serves it over
  HTTP on the ws port** — open `http://127.0.0.1:<wsPort>/?token=<token>` (same origin as the WS, so it
  isn't blocked the way a `file://` page is). Opening the file directly still works if you add `?ws=`.
  Click a node to set an **alias**: sessions/pages rename live (a session's own `set_name` wins later);
  host aliases persist in `config.json` `aliases{}` (e.g. a hostname → "Office PC").
- `chat.html` — interactive **chat client**. `token` / `user` / `project` come from the URL *or* a text
  bar (so a newcomer needn't guess); with a token it lists every project and its AI sessions, and you
  pick one and chat (send text, see the session's replies). The gateway also serves this over HTTP:
  `http://127.0.0.1:<wsPort>/chat.html`. Cross-project sends are still consent-gated (shown inline).
- The gateway serves the bundled pages (`dashboard.html`, `chat.html`, `test_page.html`) and the
  `tools/*.js` client over HTTP on the ws port — so the whole client toolkit loads same-origin.
- `test_mesh.mjs` — harness: 3 bridges, election, routing, push, leaves, traces, failover (22 checks).
- `test_dashboard.mjs` — dashboard map/alias/sub-peer suite + agent-kind classification + page wildcard-subject guard (27); `test_dashboard_multihost.mjs` —
  by-machine grouping, remote-gateway marking, code=orange, cross-host edge, gossiped web sessions,
  plus box/edge/node z-layering and the agent client-kind, via a synthetic two-machine roster in jsdom (15); `test_page_e2e.mjs` — generic
  widget-contract E2E (dropdown/selection/send/sub-peers/topics/offline) against the `test_page.html`
  fixture, real clicks via jsdom (44); `test_subpeers.mjs` — registration, secrets, cursors/epochs,
  hierarchy, dead-letter, TTL, cross-process (26); `test_topics.mjs` — claims/icons/exclusive overlap,
  subscribe/publish/send patterns, mandatory subject, encryption roundtrip, reserved-surface codes,
  wildcard-claim ban (responsibilities are concrete), lifecycle (32); `test_identity.mjs` — realm + project/user classification, child inheritance, gossip
  (13); `test_consent.mjs` — strict/grant/revoke, reply-cap return-traffic (incl. replies that survive
  an expired cap and a later revoke — Decision B), case-insensitive projects, bidirectional,
  request_project_access, project-scoped topics, open mode (36); `test_federation.mjs` — cross-host
  mesh (§7): two bridges discover each other via the `seeds` backend, gossip rosters, deliver
  envelopes both directions through the gateway splice, and drop a departed host (10);
  `test_persistence.mjs` — persistence facet (§12) units: size-string parser, format-prefixed stable
  identity keys + both-form lookup, mailbox store/drain/ack/caps/TTL, claims per-holder/byHolder/gcAll,
  retained (newest-wins, allForProject, gc), registrations + self-describing parked data (36); `test_persist_live.mjs` — live restart proof: a parked message survives a
  bridge restart and is redelivered to the returning peer (consumed ones aren't), per-peer mailbox keying
  (a sender's own send never echoes back), a durable claim rehydrates and is routable on re-register (and
  stays gone after `release_topic`), incl. a process-held claim, plus durable registrations (§19) — a send
  to an offline peer BY NAME parks via its registration and is delivered on return, a never-registered name
  still errors (20); `test_grants_live.mjs` — durable
  cross-project grants (§14): request → operator shortens the TTL → requester notified (project_access_
  granted) → send works → survives restart → revoke (persisted) → TTL expiry (12); `test_offline_park_live.mjs`
  — offline owners (§16): park to an offline owner + announce on/off + redelivery; same-user dormant-topic
  takeover gated by the authorizer (none=held, script-approve=ok); cross-user grace/displace (8);
  `test_retain_live.mjs` — retained values (§12): `publish {retain:true}` → a later/wildcard subscriber is
  caught up on subscribe, survives a restart, last-value-wins (4). Tests run in
  cwd is `process.cwd()`, so any path works incl. Windows. The page fixture is env-overridable
  (`AIMB_TEST_PAGE` — point it at any page following the same widget contract; `AIMB_DASHBOARD`) —
  no hardcoded paths.
  The suites live in **`tests/`** and spawn `../bridge.mjs` with absolute paths, so `npm test` (run
  from `src/`) or `node tests/test_*.mjs` works from anywhere.
- `test_page.html` — generic demo leaf + fixture for the page E2E (open in a browser with `?token=`).
- `claude_code_mcp.example.json` — MCP server entry.
- `../tray/windows/` — the Windows system-tray component (Open Dashboard / Quit; supervises the
  bridge). Opt-in auto-launch via `config.json` `"tray": true` / `AI_BRIDGE_TRAY=1`. See
  [`../tray/README.md`](../tray/README.md).

## Setup (per machine)
1. Install Node 20+. In this folder: `npm install`.
2. `config.json`: set a long random `token` (already generated on first install).
3. Add the MCP entry (`claude_code_mcp.example.json`) to your Claude config and restart:
   - **Claude Code**: project `.mcp.json` or `~/.claude.json`. For channel push (messages arrive
     without polling), start sessions with:
     `claude --dangerously-load-development-channels server:ai-mcp-bridge`
     (research-preview flag; custom channels aren't on the Anthropic allowlist yet).
   - **Claude Desktop / Cowork**: add to `claude_desktop_config.json`. ONE process serves every
     Cowork conversation: each conversation must `register_self` (own name + self-invented secret)
     and poll `inbox {for, secret, cursor}` — same mesh, pull instead of push.
4. First session up becomes gateway automatically. Identity: Code sessions `set_name`
   ("Scout"); Cowork conversations `register_self` instead (set_name renames the shared process node).

## MCP tools
`my_identity` • `set_name {name}` • `list_sessions` • `register_self {name, secret, parent?, mode?, ttl_minutes?}`
• `deregister {peer_id, secret}` • `send_to_peer {target, subject, message, verb?, reply_to?, park?, as?, secret?}`
(target = session/sub-peer id, unique friendly name, or `topic:<topic>`) • `publish {topic, subject, message, verb?, retain?, as?, secret?}`
• `inbox {cursor?, for?, secret?}` • `claim_topic {topic, description?, exclusive?, icon?, persistent?, force?, as?, secret?}`
• `release_topic {topic, as?, secret?}` • `subscribe {pattern, as?, secret?}` • `unsubscribe {pattern, as?, secret?}`
• `allow_project {project, mode?, as?, secret?}` • `revoke_project {project, as?, secret?}`
• `request_project_access {to, reason?, as?, secret?}` • `set_wake {…}` (reserved — unsupported).

## Realms, identity, consent & the profile seam (v1.6.0)
A **realm** is one trust+policy domain — all bridges sharing a config file (`realm`, `token`, policy).
Set per machine via `AI_BRIDGE_REALM` / config `realm` (default `"default"`). Every **participant**
(session, sub-peer, page) carries a mandatory **`(project, user)`** classification — the project the
conversation is for + the human supervising it — normalized by the realm's pluggable `IdentityModel`
to `{realm, scheme, id, display, assurance}`. v1.5 ships the **`label`** model (assurance `declared`):
- Code session: `AI_BRIDGE_PROJECT` / `AI_BRIDGE_USER` env (absent ⇒ the process is *infrastructure*,
  no project — it only routes).
- Sub-peer: `register_self {…, project, user}` (a child inherits its parent's).
- Page: `AIMB_BRIDGE_CFG.project` / `.user`.

**Cross-project isolation is enforced.** Default stance **strict** (`config.json` `projects.default`,
or env `AI_BRIDGE_OPEN=1` for open); same project always talks. A project opens itself to another with
`allow_project {project, mode}` (receiver-controlled; static edges in `projects.allow`, runtime grants
in-memory) or via `request_project_access {to}` → an operator there approves. Enforced **receiver-side**
at delivery (cross-project sends are dropped `project-denied`). **Replies** to a thread you opened are
allowed back without a reverse grant, gated by an unforgeable **reply capability** — an HMAC keyed by
the session's secret-derived `capKey`, bound to `(senderProject|targetProject|envId|expiry)`, verified
by recomputation (no stored state; survives a Cowork re-attach). **Decision B:** a valid reply-cap
**always gets through** — it is not time-expired and a later `revoke_project` does not cancel replies
on already-opened threads (the cap is an independent allow, OR'd after the consent check). It dies
only when a process restarts (`capKey` rotates). **Topics are project-scoped**: two
projects can each own `svc/api`; bare `topic:x` is your project, `topic:@other/x` targets another
(then consent-gated). Policy **live-reloads** when the shared config file changes.

**Visibility is enforced too:** a page is served a roster filtered to the projects it may reach
(can't see → can't address), matching the delivery gate. Opt out with `AIMB_BRIDGE_CFG.seeAll = true`.
The dashboard surfaces realm/project/user per session and on the map.

The security/transport facets — **auth, cipher, capsigner, config, identity, transport** — each live
in their own module under [`facets/`](facets/) (a `_template.js` stub + one file per impl), bound into
the `profile` by `facets/index.js`. Swapping or adding one (tailnet/OIDC/mTLS/mapped, or a TLS
transport) is **copy a file, implement, register one line** — no core changes. See
[`../docs/architecture.md`](../docs/architecture.md) §4–§9. Federation/translators stay reserved (§7).

## Topics (amendment 2026-06-12 — v1.3.0)
One hierarchical topic namespace (`/`-separated paths, e.g. `team/reviews`); two
relationships, fully orthogonal; two message patterns. Everything gossips with the roster. By default a
topic **vanishes with its holder**; with persistence on (§12, v1.9) a claim is **durable** and
**rehydrates** when its holder returns (see Persistence below).

- **Subscribe** (interest — open to EVERYONE on any topic; wildcards `+` one level, `#` subtree):
  `subscribe {pattern}`. Exclusivity is about accountability, never watching.
- **Own** (accountability): `claim_topic {topic, description, exclusive, icon}` — claims may cover
  a subtree (`team/#`); an exclusive claim conflicts with ANY overlapping claim (above or below).
  On `code:"held"` never seize: send the holder verb `request_responsibility {topic, reason}`;
  the holder replies `grant_responsibility` (after releasing) / `refuse_responsibility`, or asks
  its human operator. Re-claims are idempotent updates. Owners are auto-subscribed. The optional
  `icon` (short markdown, e.g. an emoji) shows wherever the topic renders.
- **Publish** = event to ALL subscribers (`publish {topic, subject, message}`): nobody obliged to
  act; zero subscribers is ok (`subscribers: 0`).
- **Send** = directed work to the OWNER(S) only: `send_to_peer {target:"topic:<topic>"}` (prefix
  REQUIRED, no bare-topic fallback; unowned topic → `no-owner`). Subscribers never see sends.
- **Subject (mandatory):** every send/publish carries `subject` — a short PUBLIC one-line
  description shown in traces/dashboard/channel meta. Omitting it errors (`subject-required`).
  Bodies are AES-256-GCM encrypted (key HKDF-derived from the config `token`); subject/verb/
  routing metadata stay cleartext by design. Trust-domain encryption, not per-pair E2E (D2 later).
- **Persistence (§12 — opt-in `AI_BRIDGE_PERSISTENCE=file`):** durable **mailboxes** (auto-park on
  delivery, redelivered to a returning peer), **claims** (durable by default; rehydrate on return),
  **grants** (durable cross-project consent + TTL, §14), **registrations** (a send to an offline peer by
  name parks, §19), and **retained** (`publish {retain:true}` keeps the last value per topic; a new
  subscriber gets it on subscribe). Records are self-describing; bodies stay encrypted at rest. Still
  **reserved** (`unsupported`): explicit `park` to a *never-registered* identity, `force` claim takeover,
  `set_wake` + WS `kind:"listener"` (wake/doorbell). `capabilities{}` on my_identity/roster is the
  feature-detection surface (its `park`/`retain`/`persistent_claims` bits flip true when persistence is active).
- **Pages:** `AIMB_BRIDGE_CFG.subject` (a topic path) is auto-claimed (shared) + auto-subscribed;
  `AIMB_BRIDGE_CFG.subscribe: [patterns]` adds subscriptions; `aimbBridge.publish({topic, subject, …})`
  publishes; page sends require `subject` like everyone else (aimb-bridge-ui `opts.subject`).

## Sub-peers (Cowork conversations + subagents)
- `register_self("Scout", <self-invented secret>)` → `peer_id` (`<host>/<bridge>/<slug>-<hex>`) +
  `queue_epoch`. Keep the secret in your context; same (name, secret) **re-attaches** after idle or
  expiry. Epoch changed on a later poll ⇒ queue was rebuilt (e.g. PC restart) ⇒ reset cursor to 0.
- **Declare your client (2026-06-11):** pass `client:"claude-code"` / `"cowork"` at register_self.
  Kind shows on the roster/dashboard, and **code sub-peers default to push (streaming)**: deliverSub
  also fires a channel notification with `meta.for=<peer_id>` / `meta.for_name` so a Code session
  sharing a Desktop bridge process (Desktop opens ONE bridge for all conversations incl. Code tabs)
  still streams — filter pushes by `meta.for`. Explicit `mode` always wins; `AI_BRIDGE_MODE=poll` suppresses.
- **Identity everywhere (2026-06-11):** `list_sessions` now returns the real `gateway` session id on
  followers too, per-session `is_gateway` + `client_kind` (`code`/`cowork`/`other`) + `host_label`,
  and top-level `host`. (`host_label` is display-only; the routing `host` field on roster entries is
  reserved for tailnet addresses.)
- **Bridge version (2026-06-12):** `BRIDGE_VERSION` (bumped on every behavioural change) is surfaced
  as `bridge_version` in `my_identity`, on every roster session entry (so mixed-version meshes are
  visible — dashboard shows it next to the client badge), and in the page `welcome`. Sessions can
  compare it against the version they last saw to detect that the bridge restarted onto new code.
- Private queue per sub-peer (in-memory, cap 300, absolute client-held cursors, non-destructive reads).
  Liveness TTL (default 720 min; children 60) drops idle entries from the roster — re-register to return.
- **Subagents**: parallel subagents expecting replies get their OWN identity — parent mints the child's
  secret in the spawn prompt, registers with `parent=<own handle>`, child `deregister`s before returning.
  Unread messages **dead-letter to the parent** (tagged `dead_letter_for`) on deregister/expiry.
  Lending the parent's handle+secret is for fire-and-forget sends only.
- Mode is detected from the MCP initialize handshake (clientInfo + channel capability) and shown in
  `my_identity`, the roster and a `client-connect` trace; channel push is always attempted at process
  level (the queue is the truth) unless `AI_BRIDGE_MODE=poll` / config `mode` explicitly suppresses it.

Inbound push arrives as `<channel source="ai-mcp-bridge" from=... from_name=... verb=... subject=... envelope_id=...>body</channel>`.
**Verbs are advisory and application-defined** — the bridge never interprets them; the receiving
session decides what a verb means. `message` is the default. An app picks its own vocabulary
(e.g. `review_request {ref}`, `notify {…}`, button-click verbs from a page) and the matching
payload shape; carry whatever JSON your handlers expect in the body.

## Pages
Renderers embed `tools/aimb-page-bridge.js` + `window.AIMB_BRIDGE_CFG = {wsUrl, token, pageKind, title, subject, subscribe, icon, project, user}`, then
`tools/aimb-bridge-ui.js` and one init call (`subject` opts is REQUIRED for buttons):
```js
aimbBridgeUI.init({ mount: "#aimb-mount", buttons: "button.aimb-discuss", verb: "review_request",
  subject: function(btn){ return "review " + btn.dataset.ref; },
  payload: function(btn){ return { ref: btn.dataset.ref, /* ... */ }; } });
```
Widget behaviour (all tested in `test_page_e2e.mjs`): **named conversations only** (sub-peers = Cowork
on yellow, named processes = Code on blue; unnamed hex processes hidden); **no auto-selection** —
buttons stay disabled until a session is picked; selection persisted by NAME in `?session=` (hash
fallback on `file://`) so reload re-selects; per-option 🟢/⚪ status circles, dropdown tinted to the
selected session's type; pip 🟢 online / 🟠 no conversations / ⚪ bridge offline.
The dropdown is **grouped** (amendment 2026-06-12): `Ai Sessions`, `Ai Topics` (green, claim icon
shown, targets `topic:<topic>`, one option per topic with a ×N owner count), and — only when
`groups` opts them in — `Browser Sessions` + `Browser Topics`. Default
`groups: ["ai-sessions","ai-topics"]` keeps pages pointed at AI targets.
A typical page wires action buttons (e.g. per-row "Discuss") to send an app-defined verb +
payload to the session picked in its dropdown. Pages appear on the roster and the dashboard.

## Notes / current limits
- 224 checks across 9 suites (2026-06-14).
- **Cross-host mesh (§7) — one realm across machines, no central node.** Co-equal per-host hubs
  (port-bind elected) find each other through the **discovery facet** and gossip rosters peer-to-peer;
  remote sessions land in the roster tagged with their owning gateway's address, so the existing
  CONNECT-splice delivers cross-host with no special routing. Discovery: `none` (default, single-host),
  `tailscale` (enumerate `tailscale status` — no tags, token-gated membership, free join/leave), or
  `seeds` (static list / tests). Opt in with `profile.discovery` or env `AI_BRIDGE_DISCOVERY`; set
  `bind` to `0.0.0.0` (or a tailnet IP). With `tailscale`, **`advertiseHost` auto-derives** from
  `tailscale status` per machine, so a single `config.json` (`{ "bind": "0.0.0.0", "profile": {
  "discovery": "tailscale" } }`) can be Dropbox-shared verbatim across machines — no per-machine env.
  WireGuard encrypts the link; the realm token gates membership (allow the control port inbound on the
  Tailscale interface). Direct session-to-session pair-dial (vs the gateway splice) and cross-host HA
  re-election are follow-ups.
- Lifecycle events are first-class trace rows (2026-06-11): gateway promotion, session/page/sub-peer
  connect + offline all appear in the dashboard trace feed as **dir `con`** (purple badge) instead of info.
- Verbs are advisory: the receiving session decides what to do. Loop guard: hop-chain in envelopes.
- Delivery is at-least-once with content-derived envelope ids + receiver dedupe.
- **Session → page messaging:** pages are not just senders — a session can drive a page leaf by
  addressing `send_to_peer {target:"page:<instance>"}` (or a unique page title), and the page
  receives via `aimbBridge.onMessage(cb)`. Routing: the gateway delivers straight to the page
  socket; a follower forwards via a `PAGE_MSG` control frame (ack is optimistic — watch for reply
  envelopes to confirm). `tools/research_client.js` is a worked example leaf: it runs a
  worklist sent by a session and streams progress/result envelopes back to the requester's inbox.
