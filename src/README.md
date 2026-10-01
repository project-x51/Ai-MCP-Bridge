# Ai MCP Bridge

Peer-to-peer mesh for AI sessions + web pages on one PC (multi-host later via Tailscale).
One bridge per MCP stdio client — which is one per **Claude Code session**, but only one per
**Claude Desktop app instance**: ALL Cowork conversations share that process. Shared conversations
(and subagents) therefore register as **sub-peers** with their own identity, secret and private
inbox — see "Sub-peers" below. Port-bind election picks the per-host gateway
(:12317 by default — moved off :7000, which macOS AirPlay Receiver squats; see config.example.json `_comment_ports`);
followers register over a control connection. Same-host session pairs dial each other's
loopback ports directly. The gateway is also the WebSocket ingress (:12318) for **page leaves**
(any embedding web page, plus the bundled dashboard.html) and the trace collector for the debug dashboard.

Security model: splice-opaque gateway (end-to-end encrypted bodies pass through unread), Tailscale
overlay identity for cross-host, tailnet-membership pairing, and no raw credentials on the wire.

Design rationale — the realm / pluggable-profile model, mandatory project+user classification,
receiver-controlled cross-project consent, signed reply capabilities, project-scoped topics, and
federation via translator bridges: see [`../docs/architecture.md`](../docs/architecture.md).

## Files
- `bridge.mjs` — the mesh node + gateway/WS/trace roles + MCP stdio server (realm-agnostic core).
- `lib/` — logic factored out of `bridge.mjs` so it's reasoned-about + unit-tested in isolation (no spawn —
  `tests/test_lib_unit.mjs`). **Pure** helpers: `topics.js` (path matching / `parseTopicRef`), `envelope.js`
  (`envelopeId`), `keys.js` (`lc` / `projKey` canonicalisers), `tool-schemas.js` (the `tools/list` payload),
  and `secret-resolver.js` (expand `${scheme:key}` secret references — `${env:…}` today, `${vault:…}` /
  `${service:…}` as explicit seams). **Encapsulated stateful modules** that OWN their data behind an API
  (bridge.mjs calls the API, never the Maps): `consent.js` (runtime grants + pending requests;
  `mayInitiate`/`allow`/`revoke`/…), `reminders.js` (#29 per-session behaviours; `remindersFor`/`set`/`clear`/…),
  `project-names.js` (#71 the replicated first-seen canonical spelling per project; `note`/`merge`/`display`),
  `traces.js` (the observation-plane ring buffer + dashboard fan-out; `collect`/`history`), and `egress-auth.js`
  (#36 server-side auth token sources — mint/cache/refresh a bearer token for an egress backend). `activity.js` is the
  pure core of the #70 agent activity board (no I/O, no clock — `now` is a parameter; bridge.mjs does the I/O): report
  parsing (`@ctx`/`@~ctx`, progress/eta/stale_after, the `log` flag, the locked limits), `apply` over a plain state
  object, text placeholders (`renderText`), checkpoints (`planCheckpoints`), the newest-first replay (`createReplay`),
  the read views (`boardView`/`logView`/`findEntry`), the derived views (stale/gone, rollup, visibility), the
  per-origin gossip `snapshot`/`mergeSnapshot` and (v1.60.0) the wire — `planSlice` (per-link deltas, byte cap, newest
  first) / `applySlice` (epoch + seq) / `markOriginDown` / `locateSessions`, the memory budget and `resolveConfig` (the `activity` block +
  `AI_BRIDGE_ACTIVITY_*`); unit-tested in `tests/test_activity_unit.mjs`. `win-env.js`
  rehydrates environment variables that an MCP host stripped at launch (Windows registry) so `${env:…}` secret
  refs resolve. The bridge core (handlers, routing, delivery, gateway) deliberately stays in `bridge.mjs`.
- `types.d.ts` — shared shapes for JSDoc + `checkJs` (see Type-checking below).
- `facets/` — the pluggable realm profile: `auth/ cipher/ capsigner/ identity/ config/ transport/
  discovery/ persistence/ authorizer/ vault/`, each with a `_template.js` + impl files, assembled by
  `facets/index.js`. Copy a file to add one. (`discovery` = §7 cross-host, `persistence` = §12 durable
  state, `authorizer` = §16 presence-gated confirmation, `vault` = §21 secret recovery — seal each
  session's secret so a session that lost it can recover via `recover_secret` + a presence check.)
- `services/` — opt-in **in-process capability modules** (see "Services" below), loaded only when
  `config.services.<name>` is present, so an unopened capability has no surface. First inhabitant:
  `egress.js` (the `http_request` proxy + server-side auth token sources).
- `config.json` — `port`, `wsPort`, `token`, `realm`, optional `projects` policy / `profile` / `tray`.
- `tools/` — embeddable client tools (consumers inline / inject these):
  - `tools/aimb-page-bridge.js` — leaf client embedded by page renderers (`window.AIMB_BRIDGE_CFG` + `aimbBridge.send`).
  - `tools/aimb-bridge-ui.js` — reusable bridge UI widget: pip + session/topic dropdown + send-button wiring,
    injects its own CSS, no framework. Any renderer inlines it after `aimb-page-bridge.js` and calls
    `aimbBridgeUI.init({mount, buttons, verb, subject, payload})`. See "Pages".
  - `tools/aimb-doorbell.mjs` — **the doorbell (#39)**: a node CLI that blocks until mail is waiting for a peer
    (or topic) and then exits, so an idle AI session can be woken instead of polling `inbox` every few seconds.
    See "Doorbell" below. Its pure clock maths (next boundary, `HH:MM` label, the #69 6-hour check-in mark) is in
    `tools/aimb-doorbell-clock.mjs`, which must sit beside it.
  - `tools/aimb-log.mjs` — **the activity reporter (#70 step 3)**: a node CLI that reports an agent's or a script's
    status to this host's activity board without registering (one report, or `--stream` NDJSON). It imports
    `lib/activity.js` to validate locally, so it runs from inside the bridge's `src/`. See "Log / activity" below.
  - `tools/research_client.js` — example page leaf injected into a browser tab (generic site research;
    wayback engine on web.archive.org).
- `dashboard.html` — live debug page: **mesh map** (hosts grouped by session-id prefix, gateway ringed,
  sessions/pages as nodes, control/page edges, amber pulse on message activity, gateway↔gateway edge
  appears when cross-host gossip lands), plus roster tables + trace feed, and the **Activity** tree of what every
  agent is doing (#70 step 5 — see "The Activity page"; light / dark follow the OS). **The gateway serves it over
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
  plus box/edge/node z-layering and the agent client-kind, via a synthetic two-machine roster in jsdom (15);
  `test_dashboard_persistence.mjs` — the Persistence view: a real bridge's durable state (claim/registration/
  subscription) is snapshotted to the dashboard and rendered into the per-store expanders + profile line (7); `test_page_e2e.mjs` — generic
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
  retained (newest-wins, allForProject, gc), registrations, subscriptions + self-describing parked data (40); `test_persist_live.mjs` — live restart proof: a parked message survives a
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
  caught up on subscribe, survives a restart, last-value-wins (4); `test_vault_live.mjs` — secret recovery
  (§21): a sealed secret is recovered via the vault (presence-gated) + reattaches with resync, deny path
  leaks nothing, unknown/unsupported handled (5); `test_doorbell_live.mjs` — the doorbell (#39): a `listener`
  leaf is pushed `mail` on a direct send and on a topic send (counts kept separate), gets `unknown` for a name not
  on the roster when it arms and `gone` for one that leaves while armed (#73), `watch-required` with no watch,
  heartbeats, fires immediately when armed with mail already waiting,
  and is proven ISOLATED (never sees roster/traces/persistence/sender) — plus the shipped
  `tools/aimb-doorbell.mjs` exit codes (0 mail / 0 timeout), its status file, and the #67 hourly chime (a
  shortened test period chimes `hourly` with the boundary time + display guidance, never early, re-arm targets the
  next boundary; mail still fires first; an explicit `--timeout` keeps `timeout` + silent guidance), and the #69
  6-hour check-in (an on-mark chime adds `inbox_check:true` + call-your-inbox guidance, stdout and status file; an
  off-mark chime, mail and `--timeout` carry none; pure checks of the 00/06/12/18:00 mark incl. midnight), and #73
  (`peer-unknown` + re-register guidance vs `peer-gone`, and the legacy-bridge early-gone guard against a fake old
  listener server) (71);
  `test_parked_live.mjs` — out-of-band parked mail surfaces
  on a plain poll and on reattach, and is **acked on serve** so a re-register never redelivers it (#23/#34, 8);
  `test_keepalive_live.mjs` — `release_topic {keep_alive}` keeps an ownerless topic alive, parks directed
  sends, and a re-claim drains them (#26, 10); `test_behaviors_live.mjs` — scoped behaviour reminders across
  all five scopes + validation + resync + cross-handoff inheritance (#29, 14); `test_default_behavior_live.mjs`
  — the bridge-wide default reminder attaches to a session with none of its own and is overridable (#32, 3);
  `test_http_egress_live.mjs` — real MCP → bridge → echo-server egress: backend/project/method gates, origin
  containment, header filter + server-side inject (#33, 9); and `test_lib_unit.mjs` — the fast pure-`lib/` +
  services units (topics/envelope/refs/consent/reminders/traces, egress incl. server-side auth mint/refresh/
  inject and the secret-resolver, `win-env` reg-parsing, tailscale `hostOf`) (#31/#35/#36, 88); and
  `test_activity_unit.mjs` — the pure #70 activity-board core (`lib/activity.js`; #70, 448); `test_activity_gossip_live.mjs`
  — four loopback "hosts" + a follower: the mesh board, deltas ≤1/s per link, truncation, remote paging / entries /
  queued fetches, going-down, owner down, forged slices, a legacy hub, dashboards (#70 step 4, 44);
  `test_dashboard_activity.mjs` — the dashboard's Activity view in jsdom: client-side stale, the status glyph + ring,
  hover times, placeholders, the delta store, the tree, pills / host down / bell, the project cycle, active only, logs
  (#70 step 5, 62); `test_activity_dashboard_live.mjs` — WS dashboards against three loopback hosts: subscribe → full
  board → deltas ≤1/s, seq-gap resync, page leaves refused, paging into the day files (local + remote), queued fetches
  + `busy`, gone vs host down, the doorbell flag, the duplicate-hostname warning (#70 step 5, 36). Tests run in
  cwd is `process.cwd()`, so any path works incl. Windows. The page fixture is env-overridable
  (`AIMB_TEST_PAGE` — point it at any page following the same widget contract; `AIMB_DASHBOARD`) —
  no hardcoded paths.
  The suites live in **`tests/`** and spawn `../bridge.mjs` with absolute paths, so `npm test` (run
  from `src/`) or `node tests/test_*.mjs` works from anywhere.
- **Type-checking (zero build).** The bridge ships as plain `node bridge.mjs` — no compile step. Types are
  applied via **JSDoc + `checkJs`** (`tsconfig.json` + shared shapes in `types.d.ts`), so `npm run typecheck`
  (`tsc --noEmit`) catches missing/renamed fields without emitting anything or adding a runtime dependency.
  `npm test` runs it first (a `pretest` gate). `typescript`/`@types/node` are devDependencies only.
- `test_page.html` — generic demo leaf + fixture for the page E2E (open in a browser with `?token=`).
- `claude_code_mcp.example.json` — MCP server entry.
- `../tray/windows/` — the Windows system-tray component (Open Dashboard / Quit; supervises the
  bridge). Opt-in auto-launch via `config.json` `"tray": true` / `AI_BRIDGE_TRAY=1`. See
  [`../tray/README.md`](../tray/README.md).

## Setup (per machine)
> **Linux / headless box?** See [`../docs/linux-setup.md`](../docs/linux-setup.md) — turn off the `tpm`/`hello`
> facets, run the gateway as a `systemd --user` service (`loginctl enable-linger` is **required**), and deliver
> the realm token out of band.

1. Install Node 20+. In this folder: `npm install`.
2. `config.json`: set a long random `token` (already generated on first install). The bridge reads the
   `config.json` beside `bridge.mjs`; env **`AI_BRIDGE_CONFIG=<path>`** points it at another file instead (absolute,
   or relative to the working directory; `~` expands) — live-reload and alias write-back follow that path too.
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
`my_identity` • `set_name {name}` • `list_sessions` • `register_self {name, secret, project?, user?, parent?, client?, mode?, ttl_minutes?}`
• `deregister {peer_id, secret}` • `recover_secret {name, project?}` (§21 vault — recover a lost secret, presence-gated)
• `send_to_peer {target, subject, message, verb?, reply_to?, from_topic?, park?, as?, secret?}`
(target = session/sub-peer id, unique friendly name, or `topic:<topic>` — a bare topic auto-routes cross-project when granted; `topic:@project/…` targets a specific one) • `publish {topic, subject, message, verb?, retain?, as?, secret?}`
• `inbox {cursor?, for?, secret?}` • `claim_topic {topic, description?, exclusive?, icon?, persistent?, keep_alive?, grace_minutes?, allow_other_user?, force?, as?, secret?}`
• `release_topic {topic, keep_alive?, as?, secret?}` (#26 `keep_alive`: keep an ownerless topic alive so directed sends park during a handoff)
• `subscribe {pattern, as?, secret?}` • `unsubscribe {pattern, as?, secret?}`
• `set_behavior {behavior, operation?, scope, match?, as?, secret?}` • `list_behaviors {as?, secret?}` • `clear_behavior {operation?, scope?, match?, as?, secret?}` (#29/#32/#44 per-operation behaviour reminders)
• `allow_project {project, mode?, as?, secret?}` • `revoke_project {project, as?, secret?}` • `request_project_access {to, reason?, as?, secret?}`
• `http_request {backend, method?, path?, query?, headers?, body?, json?, as?, secret?}` (#33/#36 egress — present only when a backend is configured)
• `log {as, secret, agent?, text?, context?, state?, progress?, eta?, stale_after?, details?, data?, log?}` • `activity {project?, session?, agent?, host?, active_only?, log?, entry?}` (#70 the mesh-wide activity board — see "Log / activity")
• `set_wake {…}` (reserved — unsupported).

**Feature detection (#41):** `profile.names` says which facet the operator CONFIGURED; `capabilities` says
what this host can actually DO. `capabilities.recover_secret` / `presence_confirm` are set by a startup
probe of the `vault` / `authorizer` facets and start FALSE until verified — so a box configured
`vault: "tpm"` with no TPM advertises `recover_secret: false` instead of failing only when recovery is
needed. Key off `capabilities`, never off `profile`. A facet impl opts in by exporting
`probe() -> {ok, reason}` (absent ⇒ assumed backed).

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
in-memory) or via `request_project_access {to}` → an operator there approves. Every grant **change** is announced
to the granted project (v1.56.0, #72): its live sessions / sub-peers mesh-wide get a **`project_access_granted`**
notice (subject e.g. `Ferret granted AIMB access (bidirectional)`; body `{action, granting_project, granted_project,
mode, one_way, direction, ttl_minutes, expires_at, granted_by, note}` — bidirectional means the granting project may
initiate back too), offline durable registrations get it parked for their next `register_self`, and a pending
requester's copy also echoes its `request_id` (one notice each). `revoke_project` sends **`project_access_revoked`**
the same way. Only the bridge where the call was made announces (never one that learns the grant by gossip), and an
identical re-grant (same mode + TTL) or a no-op revoke announces nothing (`announce:"unchanged"`). Returns: `notified`
(all notices) = `notified_pending` + `announced` (live) + `parked`. These notices, like `project_access_request`, are
bridge-generated **system** messages exempt from consent (the grant may be one-way), which no tool argument can set —
so an ordinary send in the closed direction is still `project-denied`. Enforced **receiver-side**
at delivery (cross-project sends are dropped `project-denied`). **Replies** to a thread you opened are
allowed back without a reverse grant, gated by an unforgeable **reply capability** — an HMAC keyed by
the session's secret-derived `capKey`, bound to `(senderProject|targetProject|envId|expiry)` (projects by case-insensitive key, v1.57.0), verified
by recomputation (no stored state; survives a Cowork re-attach). **Decision B:** a valid reply-cap
**always gets through** — it is not time-expired and a later `revoke_project` does not cancel replies
on already-opened threads (the cap is an independent allow, OR'd after the consent check). It dies
only when a process restarts (`capKey` rotates). **Topics are project-scoped**: two
projects can each own `svc/api`; bare `topic:x` is your project, `topic:@other/x` targets another
(then consent-gated). Policy **live-reloads** when the shared config file changes.

**Project names are case-insensitive; the first-seen spelling is canonical** (v1.57.0, #71). `AIMB`, `aimb` and
`Aimb` are ONE project everywhere a project is compared or keyed — consent and grants, topics and `@project/` targets,
claims, parked mail and registrations, retained values, reminders, stable ids and the reply-cap (all via `projKey`).
What is SHOWN uses one spelling per project, mesh-wide: the **first-seen** one (the earliest registration, page,
bridge identity or grant naming it; a tie → the lexically smaller, so `AIMB` beats `aimb`). Each bridge keeps a small
replicated map (`projKey → {name, first_seen}`, earliest wins) that rides the roster gossip and persists like the other
durable state, and every surface maps through it: `list_sessions` (sessions, sub-peers, topics, pages), `register_self`
(`identity.project`, `access`), `my_identity`, `allow_project` (`allow.from`/`to`), `revoke_project`,
`request_project_access` (`to`), topic send/publish results, the #72 grant notices (subject + body) and the dashboard.
A later registration in another case adopts it: `register_self {project:"marz"}` shows `"Marz"` once `Marz` is
canonical. The stored identity is never rewritten (`identity.id` keeps the declared spelling; only `project` is mapped
for display), so matching code must keep using `projKey`, never the display name.

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
  its human operator. A re-claim of a topic you hold is a PATCH (#55): every field you omit keeps its
  current value — the defaults (`exclusive`, `announce_offline`, `persistent` on) apply only to a NEW
  claim — so pass just what you want to change. Owners are auto-subscribed. The optional
  `icon` (short markdown, e.g. an emoji) shows wherever the topic renders.
- **Publish** = event to ALL subscribers (`publish {topic, subject, message}`): nobody obliged to
  act; zero subscribers is ok (`subscribers: 0`).
- **Send** = directed work to the OWNER(S) only: `send_to_peer {target:"topic:<topic>"}` (prefix
  REQUIRED, no bare-topic fallback; unowned topic → `no-owner`). Subscribers never see sends.
- **Send on behalf of a topic (#54, v1.51.0):** `send_to_peer {…, from_topic:"retail"}` — the CURRENT owner of a
  topic (any co-owner of a shared one) speaks for it. The sending bridge checks the caller holds a live owner claim
  on it in its own project (else `not-topic-owner`, nothing sent; a wildcard → `wildcard-from-topic`) and stamps the
  envelope with `from_topic` + `from_topic_icon` (the claim icon) — cleartext metadata the receiver can trust like
  `from`, and ADDITIVE: `from` is still the real peer (accountability, replies, reply-caps and the loop guard use it).
  It rides every path (local, cross-host, `topic:` fanout, parked/redelivered mail) and shows in `inbox`, the push
  channel meta and the dashboard traces; the shipped receive convention renders `🖂 from ⚡ retail (via Retally)`.
  A page may do the same for its own `subject` (WS `send` with `from_topic`). **Replies** still go to the peer by
  default; for continuity across an owner handoff reply to `topic:<from_topic>` instead. Not on `publish` — there the
  channel already IS the topic. Older (≤1.50) receivers ignore the fields and just show the peer.
- **Subject (mandatory):** every send/publish carries `subject` — a short PUBLIC one-line
  description shown in traces/dashboard/channel meta. Omitting it errors (`subject-required`).
  Bodies are AES-256-GCM encrypted (key HKDF-derived from the config `token`); subject/verb/
  routing metadata stay cleartext by design. Trust-domain encryption, not per-pair E2E (D2 later).
- **Persistence (§12 — opt-in `AI_BRIDGE_PERSISTENCE=file`):** durable **mailboxes** (auto-park on
  delivery, redelivered to a returning peer), **claims** (durable by default; rehydrate on return),
  **grants** (durable cross-project consent + TTL, §14), **registrations** (a send to an offline peer by
  name parks, §19), and **retained** (`publish {retain:true}` keeps the last value per topic; a new
  subscriber gets it on subscribe — on ANY 1.48+ host since #66c: retained values replicate mesh-wide as a
  last-writer-wins set; a value over the 64KB replication cap stays on its publishing host and the publish
  reply says `retained_replicated:false`). Records are self-describing; bodies stay encrypted at rest. Still
  **reserved** (`unsupported`): explicit `park` to a *never-registered* identity, `force` claim takeover, and
  the `set_wake` tool. The WS `kind:"listener"` half of wake/doorbell is **BUILT** (v1.25.0 — see Doorbell
  below). `capabilities{}` on my_identity/roster is the feature-detection surface (its
  `park`/`retain`/`persistent_claims` bits flip true when persistence is active; `doorbell` is always true,
  `wake` stays false until `set_wake` exists).
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

## Services (in-process capabilities) — HTTP egress + server-side auth
Opt-in capability modules under `services/`, loaded only when `config.services.<name>` is present (an
unopened capability has no surface). Each contributes MCP tool(s) and is live-reloadable via `setConfig`.

- **egress (#33)** — an `http_request` tool that proxies to **operator-declared backends only** (no
  arbitrary URLs): you name a configured backend + a path and the bridge joins them, **containing the final
  URL to the backend's origin** (SSRF-safe — `//host`, absolute URLs and `..` escapes are rejected). Each
  backend declares `base`, allowed `methods`, a REQUIRED `projects` allowlist (no `*`), `allowHeaders`
  (request headers a caller may set), static `headers` (injected server-side, never returned), `timeoutMs`,
  `maxResponseBytes`, `followRedirects`. The caller's project must be in the allowlist. Purpose: let a
  sandboxed/cowork session reach a local dev API it otherwise can't. Runs in the bridge process the caller is
  attached to (no port). Live-reloadable; env `AI_BRIDGE_EGRESS_BACKENDS` overrides for automation.
- **Server-side auth (#36)** — a backend may add `auth` so the bridge **mints / caches / refreshes / injects**
  a bearer token; the caller never supplies, sees, or can override the credential or token. `auth.source.type`
  is `static` (token = a resolved secret) or `http` (mint via a request, read the token at `tokenPath`, TTL
  from `expiryPath` seconds or `ttlSec`; re-mint on expiry and, unless `refreshOn401:false`, on a 401). Secrets
  are **references, not literals**: `${env:VAR}` via `lib/secret-resolver.js`, with `${vault:…}` /
  `${service:…}` as future seams. On Windows the bridge rehydrates launcher-stripped env vars from the registry
  (`lib/win-env.js`) so `${env:…}` resolves even under an MCP host that hands its child a curated environment.
  See `config.example.json` (`example-authed`) for the shape.

## Doorbell (#39) — stop polling, get woken
An idle session that polls `inbox` every ~10s spends a **model turn per poll** (~8,600/day) to be told
"nothing arrived". Instead, attach a **`listener`** leaf and block:

```bash
node "<abs path>/src/tools/aimb-doorbell.mjs" --name Bridget --project AIMB --status "<your scratchpad>/doorbell-Bridget.json"
```

- `--name` is the peer to watch; `--topic` watches a topic instead.
- `--project` is optional: it only matters when two peers share a name.
- `--status` is optional. Give it a per-session path such as your scratchpad or `%TEMP%`, never a fixed `/tmp/...`,
  because on Windows node resolves `/tmp` to `C:	mp`, which usually doesn't exist, and status writes fail silently.
- The realm token and port come from the bridge's own `src/config.json`, found relative to the **script**, not your
  working directory, so the command runs from anywhere. Don't pass `--token` in a shared command line.

**You don't need to know that path:** `set_wake` (for a code session) returns a ready-to-run `command`, and a
`connect` reminder may say `{doorbell_cmd}`, which the bridge expands per session when it emits the reminder
(#67): `"<abs node>" "<abs path to this host's tools/aimb-doorbell.mjs>" --name "<you>" --project "<proj>"`.
Forward slashes and double quotes, so it runs from bash everywhere, Git Bash on Windows included, and it works on
macOS where `node` may not be on a non-login shell's PATH. Also: `{doorbell_path}`, `{node}`, `{name}`,
`{project}`. Unknown `{tokens}` pass through, and the stored reminder is never modified.

**Hourly chime (#67), the default:** with no `--timeout`, the doorbell exits at the **top of the next hour**
(local wall-clock, e.g. 14:00:00), or earlier if mail arrives, with `reason:"hourly"`, `time:"14:00"` and
`guidance:"Top of the hour: display the current time (14:00) to the user, then re-arm the doorbell."`. That wake is
meant to be **seen**, not a silent re-arm. It never exits before the boundary (an early timer waits out the
remainder), so a re-arm always targets the *next* hour, with no double chime and no hot loop. An explicit
`--timeout <sec>` keeps the fixed timeout (`reason:"timeout"`, silent guidance). Test hook:
`AIMB_DOORBELL_PERIOD_SEC=<n>` chimes on the next multiple of *n* seconds instead of the hour (tests only).

**6-hour inbox check-in (#69):** the chimes at **00:00, 06:00, 12:00 and 18:00** (local) keep `reason:"hourly"` and
`time`, and add `inbox_check:true` with
`guidance:"6-hour check-in (18:00): call your inbox tool now even if nothing is waiting — it keeps the Ai MCP Bridge
loaded in this session. Then display the time to the user and re-arm the doorbell."` (same fields in the `--status`
exit write). An idle session otherwise makes no bridge tool call for hours, and the host may unload the MCP bridge;
that one inbox call keeps it loaded. The mark is judged from the **boundary's** local wall time, never `Date.now()`
drift, so midnight reports `"00:00"` and is a check-in. Every other chime, mail exits and explicit-`--timeout` exits
are unchanged. The maths lives in `tools/aimb-doorbell-clock.mjs` (pure, unit-tested; keep it beside the script).
With the period hook, the check-in lands on each boundary whose seconds since local midnight divide by
6 × period. Test/tuning knob: `AIMB_DOORBELL_CHECKIN_EVERY=<k>` (default 6) = every *k*-th boundary instead.

Run it **backgrounded**; it costs no tokens and ~no CPU while waiting, and exits the moment there is
something to collect. The caller wakes, acts on the result, and re-arms.

**Exit codes (#52).** The exit code is a plain success/failure signal, because the harness shows any non-zero
background exit as "failed". The specific outcome is always in **`reason`**, which appears in the single JSON line on
stdout and in the `--status` exit write. Branch on `reason`:

| Exit | `reason` | What the caller does |
|---|---|---|
| **0** | `mail` | Poll `inbox` once, handle the mail, re-arm. |
| **0** | `hourly` | Show the user `time`, re-arm. If `inbox_check:true` (00/06/12/18:00, #69), call `inbox` first even if nothing is waiting. |
| **0** | `timeout` | Only with an explicit `--timeout`. Silent re-arm. |
| **0** | `peer-gone` | The watched name was here and left the mesh. Silent re-arm; re-register first if the bridge restarted since your last `register_self`. |
| **0** | `peer-unknown` | The watched name isn't registered on this bridge (it probably restarted, #73). Call `register_self` with your name + secret, **then** re-arm. Not a silent re-arm: re-arming alone just loops. |
| **0** | `link-closed` / `link-error` | The bridge link dropped **after** arming, e.g. a bridge restart. Silent re-arm. |
| **4** | `error` | The bridge sent an error frame (`code`, `what`). Investigate; don't hot-loop re-arming. |
| **4** | `link-closed` / `link-error` | The link failed **before** it ever armed (bridge down, wrong port/token). Investigate. |
| **64** | — | Bad usage, e.g. no `--name`/`--topic`, or no realm token found. Fix the command. |

Routine no-mail wakes (exit 0 and anything but `mail`/`hourly`/`peer-unknown`) also carry a terse
`guidance:"silent re-arm…"`, so a doorbell loop doesn't burn tokens narrating uneventful re-arms. The agent stays
quiet unless it's stopping the loop. `peer-unknown` instead carries
`guidance:"Your name isn't registered on this bridge (it probably restarted). Call register_self with your name +
secret, then re-arm the doorbell."` (`--status` state `unknown`).
`--status` writes a heartbeat file, so you can confirm the doorbell is alive without spending a turn. Every exit is
**self-timestamped** (#51): `exited_at` (local ISO-8601 with tz offset) and `exited_at_unix`, on stdout and in the
`--status` exit write.

Protocol: `hello {kind:"listener", token, watch:{name?, project?, topic?}}` → `welcome`, then
`{type:"mail", peer, unread_direct, topics{}, total}` when the v1.24.17 waiting counts rise above zero,
`{type:"unknown"}` if the watched name is not on the roster and hasn't been since the listener armed (v1.55.0, #73:
e.g. not re-registered after a bridge restart), `{type:"gone"}` if it was there during the watch and then left,
`{type:"ping"}` heartbeats. Project scoping applies to both; a topic-only watch gets neither. A bridge before
1.55.0 sends `gone` in both cases, so the script treats a `gone` within 2 s of `welcome` from a <1.55 bridge as
`peer-unknown` (`inferred_from:"early-gone"`) — the hot-loop guard; knob `AIMB_DOORBELL_EARLY_GONE_MS`.
It is **counts-only** — no roster, traces, persistence or sender identities — so it needs **no per-peer secret**
(the realm token gates the socket, and these integers already go to every dashboard). Behaviour reminders are unaffected: they still ride along on
the messages when the woken session polls its inbox.

## Log / activity (#70) — what every agent is doing (v1.58.0 step 2, v1.59.0 step 3, v1.60.0 step 4, v1.61.0 step 5)
Sessions orchestrate, agents do the work. The **activity board** shows each session's agents and their progress across
the whole mesh: the `log` + `activity` tools, the gateway-owned state and the daily log files (step 2),
`tools/aimb-log.mjs` for agents and scripts that don't register (step 3, below), and the mesh-wide gossip plus on-demand
remote history (step 4, "Mesh-wide" below), and the dashboard's **Activity** tree (step 5, "The Activity page" below). The
agent snippet (step 6) follows.

**Reporting — `log {as, secret, agent?, text?, context?, state?, progress?, eta?, stale_after?, details?, data?, log?}`.**
You report as a registered session (`as` + `secret`). Omit `agent` for the session itself; `agent:"spec-70/research"`
(≤3 levels) reports for one of your agents — agents never register. The identity is **realm + project + user + session
name + host** (v1.60.0; + the agent path): each host only ever writes its own entities, so the same session or agent name
reporting from two hosts is two entities, which the board groups under one session (a session that moves machines
leaves its old host's entries to go stale or gone).
- Every message belongs to a **context**: `"@build compiling"` appends to the build context's log; `"@~build
  compiling"` also makes it that context's **current line**; `"@~root …"` sets your own headline; no prefix = `@root`,
  log only. `context:"@~build"` does the same without a prefix (the text is then literal). Quote spaces: `@~"strip 17"`.
- **State** (`running|blocked|failed|done|idle`) changes only with an `@~` line; `@~root` done/failed **finishes** the
  agent. Stale is computed (quiet longer than `stale_after_min`, or the message's own `stale_after`, ≤24h); gone = the
  session left this host's roster (deregister / TTL / its process exited), cleared when it comes back.
- **Progress / ETA** (`"4812/12000 tiles"`, `"3/6"`, `"61%"` / `"15m"`, `"1h25m"`, `"19:27"`) move the bar from **any**
  message, stick until changed (`"none"` clears) and the ETA is dropped while the context is done/failed.
- **Text is a template**, rendered when read: `{progress}` → "4,812 of 12,000 tiles" ("61%" for a % bar, "3 of 6"
  without a unit), `{pct}` → "40%" (floored), `{done}` `{total}` `{unit}`, `{eta}` → "~1h 25m" ("now" once due, "?"
  with no ETA). `{{` / `}}` are literal braces; an unknown `{word}`, or a bar placeholder with no bar, stays as typed. A
  current line renders against the context's **live** bar (`"@~Tharsis Seeding {progress}"` keeps moving); a log entry
  against the progress recorded on it. The files and the gossip keep the raw template.
- **Default text:** a message with progress/eta and no text gets `"{progress}"` (`"{eta}"` with only an ETA) — logged or not.
- **`log:false`** updates the board (line, state, bar, activity) **without** appending to the log or the file. An
  agent's own tool calls cost tokens, so agents log sparingly, at milestones; a **script** may report often with
  `log:false` (e.g. every second) and occasionally `log:true`. The bridge checkpoints that progress every
  `progress_checkpoint_sec` so the bar survives a restart.
- Limits (locked; a change is a version bump): text 240 chars (longer is truncated + `warnings`), context name 60, 32
  contexts per agent, 128 agents per session (the 129th evicts the oldest *finished* one), `details` 4 KB, `data` 16 KB
  JSON — keep both small. **Status text is plaintext, realm-wide: never put secrets in it.**
- Returns `{ ok, id, ts, session, agent, context, current, state, stale_at, logged }` (+ `warnings`, `evicted`; codes
  like `context-too-long`, `too-many-agents`, `activity-disabled`, `activity-loading`, `no-gateway`).

**Reading — `activity {project?, session?, agent?, host?, active_only?, log?, entry?}`.** The mesh board: sessions →
agents → contexts with their current lines (`text` raw, `rendered` filled in), effective state (`stale` / `gone`; `was` =
the reported one — computed by the READER with its own `stale_after_min`), rollup progress (summed per shared unit, else
the mean %), ETA, visibility and log counts. Sessions are **grouped** by realm + project + user + name across hosts:
every agent (and the session's own entity) carries its `host`; a group on one host has `host`, one on several has
`hosts:[…]`, `multi_host:true`, `self` (the most recently active host's) and `selves` (one per host). `remote_hosts`
lists each remote host held (`sessions`, `seq`, `linked`, `down_at`, `truncated`).
`log:{session, project?, user?, host?, agent?, context?, limit?, cursor?}` is one agent's (or the session's) log, newest
first, paged — `next_cursor` → pass it as `cursor` for the older page; a name on several hosts is `ambiguous-session`
(with each candidate's host) unless the agent or `host` settles it. `entry:{id, host?}` is one entry in full with its
`details`/`data` (memory for a current line, else the day file — via an id → offset index, else a scan of the day the
id's timestamp names); another host's CURRENT line is found by id alone, its older log entries need `host`. A remote
read answers with `from_host`. Times are ms epochs.

**One writer per host.** The host's **gateway** owns the board and its files; a follower authenticates its own sub-peer
and forwards the call up its control link (`ACTIVITY` frame + request id → `ACTIVITY_R`, 5 s timeout; only a registered
follower's frames are honoured, and only for a sub-peer on its roster). A follower promoted to gateway first **replays**
the host's files (below); a `log` call waits for that (≤15 s, else `activity-loading`).

**Files:** `<persist dir>/activity/<host>/YYYY-MM-DD.jsonl` (local date), only with persistence on. One JSON line per
logged entry (with `details`/`data` and the identity), plus two compact kinds for `log:false` activity:
- a **checkpoint** `{"kind":"cp","k":3,"ts":…,"session":…,"agent":…,"context":…,"current":{…},"state":…,"progress":…,"eta_at":…}`
  — written at most once per context per interval when its line / bar / ETA changed; `k` is a small per-file key given
  to the context the first time it is checkpointed that day;
- a **repeat line** `{"rep":[3,7],"n":245,"since":…,"last":…}` — these keys were alive and *unchanged* for `n`
  intervals from `since` to `last`. While the set stays exactly the same the bridge rewrites this last line in place;
  any other write (an entry, a cp) or a different set starts a new one. Contexts with no activity aren't listed.

Ids are `act_<boot nonce>_<ms base36>-<seq>` (the time names the day file). Retention deletes day files older than
`log_retention_days` (at gateway start and daily). **Replay** reads the files newest-first, backwards in 64 KB chunks:
phase 1 fills current lines, bars, states and finished status from the newest record carrying them (a cp counts), and
publishes the board as soon as everything seen is resolved (or after 300 ms); phase 2 fills each agent's history. It
covers `finished_visible_hours`; a context's `last_activity` also takes the `last` of any repeat line listing it, so it
isn't stale after a restart. A garbled final line (a crash mid-write) is skipped. A clean shutdown flushes pending
checkpoints, and so does the Task Tray before it kills the bridges (`POST /admin/prepare-shutdown`, below).

**Config** — an `activity` block in `config.json` (live-reloaded), each key with an `AI_BRIDGE_ACTIVITY_<KEY>` env override:
`log_retention_days` 7 · `log_entries_per_agent` 200 (in memory) · `stale_after_min` 15 · `finished_visible_hours` 24 ·
`memory_budget_mb` 64 (over it, the oldest finished agents, then the oldest log entries, are evicted) ·
`progress_checkpoint_sec` 60 (10–3600, 0 = off) · `enabled` true. Test-only env: `AI_BRIDGE_ACTIVITY_CHECKPOINT_MS`,
`_FWD_MS`, `_LOAD_WAIT_MS`, `_GC_MS`, `_RETENTION_MS`, `_INDEX_MAX`, `_PHASE1_MS`; step 4 (env only, every host should
agree): `_GOSSIP_MS` (1000), `_SLICE_MAX_BYTES` (262144), `_PAGE_ENTRIES` (50), `_PAGE_BYTES` (32768), `_FETCH_RATE` (4/s),
`_REMOTE_MS` (4000), `_DOWN_HOLD_MS` (30000); `AI_BRIDGE_TEST_ACTIVITY_TAP=1` (`activity {tap:true}` returns the recent
frames) and `AI_BRIDGE_TEST_HOSTNAME` (two loopback "hosts" on one machine) are for tests.

### Mesh-wide — gossip + on-demand history (v1.60.0, step 4)
Every gateway keeps its own host's board and **gossips** it to every peer hub over the existing hub-to-hub link
(one-hop, like the roster slices; followers hold no board and forward their reads to the gateway as before, so a
follower's `activity` shows the mesh too):
- **What travels:** current lines only — never details, data or log entries (a line carries `has_details`/`has_data`).
- **Full, then deltas:** a peer gets a **full slice** on every (re)link (and when it asks — `resync`), then **deltas**:
  only the entities that changed (inside their session record) and removals. Each frame carries the sender's `epoch`
  and a `seq`; a delta applies only on top of exactly the held `seq` (`base`), otherwise the receiver drops it and asks
  for a full slice. The #63 heartbeat adds a sync beat once a minute.
- **Rate:** at most **one frame per second per link**. A change only schedules the link's next frame, so a burst (a 1/s
  `--stream` script plus many agents) coalesces into one frame carrying the latest state.
- **Byte cap:** `AI_BRIDGE_ACTIVITY_SLICE_MAX_BYTES` (256 KB) per frame. Over it, the newest-active entities go first and
  the frame is marked `truncated`; the rest follows in the next second(s).
- **Ownership:** a slice belongs to the host of the link it arrived on (the peer gateway's authenticated `PEER_HELLO`
  session) — never to a field in the frame. A frame naming another origin is dropped; host fields inside are ignored.
  Every limit is re-validated on receive. A host never accepts a slice for itself.
- **Gone:** when a host's link drops, it is retired or expired (#63), or it sends a **going-down notice**, its agents show
  as **gone** at once, with their last-known lines; when the host comes back its fresh full slice clears it. A slice
  that stays down is forgotten after `finished_visible_hours`.
- **Going down:** `POST /admin/prepare-shutdown` (the tray, below) flushes, then sends every peer hub `ACTIVITY_DOWN`;
  a clean exit (SIGINT / SIGTERM) does too, best effort. After the notice the bridge sends no slices for 30 s (then full
  ones, if it is still alive).
- **Remote history, on demand:** `activity {log}` / `{entry}` for another host's entity is a request over the same link
  to the **owning** gateway: a log comes in **pages** (at most 50 entries / 32 KB, set by the owner; `cursor` →
  `next_cursor`; since v1.61.0 the pages continue into the owner's **day files**, below); details and data only on an
  explicit `entry` fetch. The owner serves at most 4 fetches per second per link; since v1.61.0 the **requesting**
  gateway queues its fetches at that rate (below) instead of passing `rate-limited` on. Owner down or not answering in
  4 s → `owner-unreachable` (its agents stay on the board, gone); a pre-1.60 owner → `owner-unsupported`.
- **Dashboards** subscribe and get deltas (v1.61.0 — "The Activity page" below).
- **Mixed versions:** a ≤1.59 hub doesn't declare `activity_gossip`, so it gets no activity frames (and would ignore
  them); its agents simply don't appear on 1.60 boards. Deploy = restart each host's gateway on 1.60.0.

### The Activity page (v1.61.0, step 5)
The dashboard's **Activity** section is the mesh board as a tree: **project → session → agent → context → log entry**.
- **Projects** show their counts (sessions · active agents). Clicking a project heading cycles **all → sessions only →
  collapsed**; the **Projects / Sessions / Agents** control sets every project at once. The default view shows every
  session with its agents' `@root` rows; contexts and logs start closed.
- **A session row:** its name, a **host tag** per host (a session on several hosts is ONE row; its headline is the most
  recently active host's; its agents are tagged by host), the `@root` line with its placeholders filled, the status
  glyph, the progress bar, ⌛ when there is an ETA, 🔔 when a doorbell is armed for it, and pills.
- **An agent row:** the glyph, its path (monospace; `a/b` nests under `a`), its `@root` line, the bar (striped = a rollup
  of its contexts), ⌛, pills. **Expanding** a session or agent shows its **Log** ("N entries, all contexts" — newest
  first, each entry with its time, a state dot, `@ctx` / `@~ctx` and the text; "load older…" at the end pages on) and
  then its **contexts** (◎, the line, the bar, ⌛), each expanding into its own log. An entry with details / data expands
  into the text and the pretty-printed JSON.
- **The status glyph** (16 px): the centre is the state (a dot for running / blocked / idle, a tick for done, a cross for
  failed); a live item's **ring empties** as the time left before it goes stale runs out. **No time text is inline** —
  hover the glyph for the actual times (started, running for, last activity, stale at — or done / failed at and how long
  it took), the bar for the exact counts (reported or a rollup), ⌛ for "ETA ~15m (estimated), about 19:27".
- **Pills** only for **blocked, failed, stale, gone**, plus a distinct **host down** badge (violet; its host sent a
  going-down notice or its link dropped — every agent of that host) as opposed to **gone** (the session left). A stale
  row's text greys out.
- **Controls:** **active only** (hides finished and gone agents and sessions with nothing active; remembered per
  browser); **stale after** 5–60 min (starts at the bridge's `stale_after_min`; an item's own `stale_after` still wins) —
  stale is computed **in the page** from the raw times, so the slider is instant; **Expand all / Collapse all**. A legend
  explains the glyphs. The colours are the page's tokens: light by default, dark with the OS setting (or `?theme=dark`
  / `?theme=light`); `dashboard.html#activity` opens the section directly.

**Data path — deltas, not boards.** The section is collapsed by default, and a dashboard subscribes only while it is
open and the browser tab is visible — one that never opens it costs the bridge nothing:
- `{type:"activity_sub"}` → `{type:"activity_board", full:true, epoch, seq:1, head, upsert:[…]}`: every **unit** — one
  per session group (header, `self` / `selves`, `bell`, `hosts_down`) and one per agent — in the **raw** form: the
  reported state (`gone` included), the raw line template, the raw times; no `rendered` or `stale_at` (the page computes
  those), so time passing is never a change.
- Then at most once a second, when anything changed: `{type:"activity_delta", epoch, seq, base, head, upsert:[changed
  units], remove:[unit ids]}`, diffed against what THAT dashboard was last sent. A delta whose `base` isn't the page's
  `seq` means one was lost: the page sends `{type:"activity_sub", resync:true}` and starts again from a full board.
  `head` = `{host, now, stale_after_min, remote_hosts, loading?}` (the page corrects for clock skew with `now`).
- `{type:"activity_unsub"}` when the section closes (or the tab is hidden).
- Reads stay `{type:"activity", ref, query}` → `{type:"activity", ref, result}`; a remote fetch that has to wait first
  sends `{type:"activity_queued", ref, host, wait_ms, position}` (the page shows a spinner).

**Paging into the day files.** Once an entity's in-memory entries (`log_entries_per_agent`) run out, `activity {log}`
pages on into the host's daily JSONL — read backwards in chunks with the same reader as the restart replay (async per
chunk, so it yields to the event loop), back through `log_retention_days` (older instances of the same agent name
included). A file page's cursor is `f1.<day>.<offset>` (continue before that byte of that day's file). Pages stay
bounded (a page never exceeds `log_entries_per_agent` entries, a remote owner's 50 entries / 32 KB; 32 KB locally),
and a page reads at most 8 MB of file (`AI_BRIDGE_ACTIVITY_SCAN_BYTES`) — a rarely-reporting agent in a busy file may
get a short or empty page with a cursor to go on (the page follows it automatically). Remote pages do the same on the
owner. `from_files` counts a page's entries that came from the files.

**Queued remote fetches.** The requesting gateway queues its remote `log` / `entry` fetches per link and paces them with
a mirror of the owner's token bucket (4/s, or the `rate` an owner's `rate-limited` answer names — such a fetch goes back
to the head of the queue for its `retry_after_ms`, at most 4 times). Bounds: 64 waiting per link
(`AI_BRIDGE_ACTIVITY_QUEUE_LINK`) and 16 queued + in flight per dashboard (`AI_BRIDGE_ACTIVITY_QUEUE_DASH`); beyond
either → `{ok:false, code:"busy", retry_after_ms}`. A follower's forwarded read may wait ≈0.7 s at most (it must answer
inside the follower's 5 s timeout), the `activity` tool on the gateway 10 s (`AI_BRIDGE_ACTIVITY_TOOL_WAIT_MS`); longer
→ `busy`. A result that waited carries `queued_ms`.

**Read access.** The activity board's pushes and the WS `activity` reads are for **dashboards** (and registered sessions,
through the `activity` tool) — **never page leaves**: a page's `activity` / `activity_sub` is answered
`dashboard-only`, and a connection gets one `hello` (a page can't re-hello into a dashboard: `already-hello`).

**Host down vs gone, and the bell.** Every entity of a host that went down carries `host_down` (when), and its session
group lists `hosts_down` — a session that LEFT is `gone` without it (both in the `activity` tool too). A session's `bell`
is true while a doorbell `listener` on its host's gateway watches its name (+ project); it rides the gossip header, so
every board shows it, and stays ~5 s after the listener closes (`AI_BRIDGE_ACTIVITY_BELL_GRACE_MS`; the doorbell
re-arms after each wake).

**Duplicate host names** are accepted (#70 decision) but logged: a gateway that links two peer hubs with the same host
name at different addresses (or one with its own name; or, after a liveness probe, at the same address on another port)
logs `WARN duplicate host name "<name>": …` once per name per 10 min (`AI_BRIDGE_DUP_HOST_WARN_MS`) — their activity
slices overwrite each other.

### The script — `tools/aimb-log.mjs` (v1.59.0, step 3)
For agents (which never register) and long-running scripts. The orchestrator puts one line in each agent's prompt and the
agent reports with it; no `register_self`, no secret:

```bash
node "<abs path>/src/tools/aimb-log.mjs" --session Bridget --project AIMB --agent spec-70/research "@~root reading the spec"
node "<abs path>/src/tools/aimb-log.mjs" --session Bridget --project AIMB --agent tiles --ctx "@~Tharsis" --progress 4812/12000:tiles --eta 1h25m
```

`--session <name> --project <P> [--user U] [--agent a/b/c] [--ctx "@~Ctx"] [--state S] [--progress 4812/12000:tiles]
[--eta 1h25m] [--stale-after 60m] [--details "..."] [--data '{...}' | --data-file f.json] [--no-log] ["<text>"]` — the
`log` tool's fields as flags. The text is the positional argument (several words are joined; anything after `--` is
text); it is optional when `--progress`/`--eta` is given (default `"{progress}"` / `"{eta}"`). `--ctx` sets the context
(the text is then literal), `--no-log` = `log:false`, `--data-file` may start with a BOM. The report is validated
locally with the bridge's own parser first, so a bad one costs no connection.
- **Output:** ONE JSON line on stdout — the `log` tool's result (`{ok, id, ts, session, agent, context, current, state,
  stale_at, logged}`), or `{ok:false, code, what}`. Usage text goes to stderr.
- **Exit codes** (doorbell conventions): **0** ok · **4** the bridge said no or the transport failed (`link-error` = no
  bridge, `unauthorized`, `session-user-mismatch`, `gateway-unsupported` = a pre-1.59 gateway, `timeout`, …) · **64**
  bad usage (a missing `--session`/`--project`, an unknown flag, bad `--data` JSON, a report the bridge would reject
  such as `bad-state` / `bad-text`, `token-in-argv`, `no-token`).
- **Identity:** realm + project + user + session — `--session` and `--project` are required, `--user` defaults to
  `AI_BRIDGE_USER`, else the OS login user (`os.userInfo().username`); the realm is `AI_BRIDGE_REALM`, else
  `config.json`'s `realm`, else `default` (the bridge's rule; the gateway refuses another realm). A script-only session
  is **never marked gone** (it has no roster presence to lose) but it goes **stale** like anything else.
- **Who may report as whom (Robin, 2026-10-01):** anyone holding the realm token may report as any session — the
  doorbell's trust — **except** a session that is LIVE on the mesh roster (a registered sub-peer on ANY host, gossiped
  slices included, or — v1.60.0 — a BARE process-level session: a bridge started with its own project + user, whose
  name is the session name) with the same realm + project + name under a **different user** (case-insensitive): that
  report is refused with `session-user-mismatch`. Checked by the gateway against its roster on every report. Same user →
  accepted; once the session leaves the roster, accepted.
- **Token / port:** like the doorbell, from the bridge's `config.json` found relative to the **script**
  (`../config.json`; `AI_BRIDGE_CONFIG` names another), or `AI_BRIDGE_TOKEN` / `AI_BRIDGE_TOKEN_FILE`, and
  `--ws-port` / `--url` / `AI_BRIDGE_WS_PORT`. **`--token` is refused** (exit 64, `token-in-argv`; the value is not
  echoed): argv is readable in the process list and the realm token is also the body-encryption key. The script never
  prints the token.

**`--stream`** — for scripts that report often (every second): ONE connection, newline-delimited JSON on stdin, one
result line per input line, **in input order**:

```bash
my-seeder | node aimb-log.mjs --stream --session Bridget --project AIMB --agent seeder --ctx "@~tiles" --no-log
#   stdin:  {"progress":"4812/12000:tiles"}          stdout: {"line":1,"ok":true,…,"logged":false}
#           {"text":"@~root done","state":"done","log":true,"ref":"fin"}   {"line":2,"ref":"fin","ok":true,…}
```

- A line carries the `log` tool's fields minus auth (`agent text context state progress eta stale_after details data
  log`, + an optional `ref`, echoed back). The command line's identity applies to every line; `--agent`, `--ctx` and
  `--no-log` are defaults a line may override. Any other field (e.g. `session`) → that line gets `bad-field`; bad JSON
  → `bad-json` — answered in place, the stream goes on. Only identity flags, those defaults, `--ws-port`/`--url` are
  allowed with `--stream`.
- **Exit 0 at stdin EOF**, once every line is answered. A fatal hello error (`unauthorized`, `bad-ident`,
  `realm-mismatch`, `gateway-unsupported`) reports every pending line and exits 4.
- **Reconnects** with backoff (200 ms doubling to 5 s; `AIMB_LOG_BACKOFF_MAX_MS`) when the link drops, e.g. a gateway
  restart. A line in flight when it dropped is reported `link-lost` and NOT resent (it may have been applied; a resend
  could duplicate a logged entry); a line that waits longer than `AIMB_LOG_LINE_WAIT_MS` (default 10000) for a link is
  reported `no-bridge`. Lines are sent one at a time (each waits for its answer; `AIMB_LOG_TIMEOUT_MS`, default 8000).

**Protocol** (the gateway's WS port; only the gateway serves it): `hello {type:"hello", kind:"logger", token,
ident:{session, project, user, realm}}` → `{type:"welcome", logger:true, bridge_version, realm, host, ident}` or
`{type:"error", code, what}` + close (`unauthorized`, `ident-required`, `bad-ident`, `realm-mismatch`); then
`{type:"log", ref, input:{…log fields}}` → `{type:"logged", ref, result}` per report. A logger socket is **not** a page
or a session: it never appears in `list_sessions`, the dashboard or the roster, and gets no roster pushes. A pre-1.59
gateway takes the hello for a page and answers a plain `welcome` (no `logger:true`); the script then closes at once
with `gateway-unsupported`.

### Prepare-shutdown — `POST /admin/prepare-shutdown` (v1.59.0)
The Task Tray's Restart Bridges… and Shut down all kill the bridges with TerminateProcess, which runs no exit handler, so
the `log:false` progress since the last checkpoint used to be lost. Now the tray first calls the **gateway's** HTTP
server (the WS port): `POST http://127.0.0.1:<wsPort>/admin/prepare-shutdown` with **`Authorization: Bearer <realm
token>`** (a token in the URL is not accepted). The gateway waits out an in-flight checkpoint tick, writes every dirty
context's `cp` line **and** the repeat line now (so the unchanged contexts' last activity survives too), drains the
activity file's write queue (queued log entries included), and only then answers
`200 {ok:true, role, bridge_version, flushed:{cp, rep, files_drained[, skipped]}, ms}` (`skipped`: `replaying`,
`checkpoints-off`, `no-persistence`). Non-loopback callers get 403, a missing/bad token 401, a non-POST 405, another
`/admin/…` path 404. **Only the gateway needs it:** followers write no activity files and keep no deferred writes (their
persistence writes are issued immediately), so nothing is propagated to them. v1.60.0: after the flush the gateway also
sends its peer hubs the going-down notice (`down_notified` = how many) so their boards show this host's agents gone at
once. The bridge keeps running afterwards; the caller kills it.

## Behaviour reminders (#29 / #32 / #44)
A session registers "how to behave" reminders: `set_behavior {behavior, operation?, scope, match?}`
(`list_behaviors`, `clear_behavior`). A reminder is bound to an **`operation`** (which bridge action fires it)
plus a **`scope`+`match`** (which instances). `operation` defaults to **`receive`** (a message arrives) — those
ride the received message, so a session relearns its standing instructions across a compaction. Other
operations — `send`, `publish`, `claim_topic`, `release_topic`, `subscribe`, `allow_project`, `revoke_project`,
`request_project_access` — instead **echo the matching reminders in that tool's response** (post-hoc for the
message content, but in time for the transcript line / follow-up the agent composes next). For `receive` the
scope matches the **sender**; for outbound operations it matches the **target**. Scopes: `topic` / `host` /
`project` / `subscription` / `all`. A bridge-wide **default** (`config.behaviors.default`, tagged `default:true`;
may itself name an `operation`) applies to every session unless that session sets its own for the same
`operation`+`scope`+`match`. **Realm-wide defaults (#66b, v1.47.0):** a `config.behaviors.realm` block
`{ updated_at, default:[...] }` in ANY one host's config replicates to every 1.47+ bridge (last-writer-wins on the
explicit `updated_at`); a host's own `behaviors.default` entry wins its key, realm entries fill the rest (tagged
`realm:true`). **No reminder and no default for an operation ⇒ it is silent** — so an operation
costs nothing until opted into. A `send` reminder never fires on `receive` (or vice-versa); to cover both
directions register one per operation. *(#47: the incoming operation was renamed `deliver`→`receive`; `deliver`
is still accepted as a legacy alias — from a stale client or an existing durable reminder — and folded to
`receive`.)*

## Notes / current limits
- 622 checks across 30 suites (see the per-suite descriptions above).
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
  envelopes to confirm). A page on ANOTHER host (#66d, v1.48.0) is reachable too — by publish (its
  `subscribe` patterns are gossiped) and by `send_to_peer`: the sender dials the page's owning gateway, which
  delivers and returns the real outcome (`ok:true`, `project-denied`, `page-gone`); a page behind a ≤1.47
  gateway fails with `page-remote-unsupported`. `tools/research_client.js` is a worked example leaf: it runs a
  worklist sent by a session and streams progress/result envelopes back to the requester's inbox.
