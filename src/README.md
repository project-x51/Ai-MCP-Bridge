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
  `tests/unit/test_lib_unit.mjs`). **Pure** helpers: `topics.js` (path matching / `parseTopicRef`), `envelope.js`
  (`envelopeId`), `keys.js` (`lc` / `projKey` canonicalisers), `tool-schemas.js` (the `tools/list` payload),
  and `secret-resolver.js` (expand `${scheme:key}` secret references — `${env:…}` today, `${vault:…}` /
  `${service:…}` as explicit seams). **Encapsulated stateful modules** that OWN their data behind an API
  (bridge.mjs calls the API, never the Maps): `consent.js` (runtime grants + pending requests;
  `mayInitiate`/`allow`/`revoke`/…), `reminders.js` (#29 per-session behaviours; `remindersFor`/`set`/`clear`/…),
  `project-names.js` (#71 the replicated first-seen canonical spelling per project; `note`/`merge`/`display`),
  `traces.js` (the observation-plane ring buffer + dashboard fan-out; `collect`/`history`), and `egress-auth.js`
  (#36 server-side auth token sources — mint/cache/refresh a bearer token for an egress backend). `log-snippet.js` (#70 6c)
  builds the `{log_snippet}` / `{log_tool_hint}` connect-reminder texts (pure; the bridge fills the paths). The activity board (#70; 2.0, #88): `activity.js` holds the shared
  primitives (limits, states, `resolveConfig` — the `activity` block + `AI_BRIDGE_ACTIVITY_*` —, durations / progress /
  ETA parsing, questions, ranks, and the #88 identity primitives: `mintId`, keys, slugs, `@`-free paths, the leading-`@`
  text rule); `activity2.js` is the pure 2.0 model (the id-keyed tree, `parseCall` / `applyCall`, plans, questions, the
  type registries, actions, v6 records + the replay, expiry, the budget); `activity2-files.js` the day / index files
  and the marker; `activity2-store.js` the gateway's store (model + files); `activity2-gossip.js` gossip v6;
  `activity2-dash.js` the dashboard's units; `view-state.js` the per-user view set; `activity2-convert.js` +
  `activity2-migrate.js` (+ the v5 readers in `activity-v5.js`) the one-time 1.7x → 2.0 conversion. All pure or
  directory-scoped and unit-tested (`tests/unit/test_activity*_unit.mjs`, `test_node_id_unit`, `test_view_state_unit`). `win-env.js`
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
  - `tools/aimb-log.mjs` — **the activity reporter** (#70; 2.0 forms since #88): a node CLI that reports an agent's or
    a script's status to this host's activity board without registering (one report, `--batch`, or `--stream` NDJSON),
    and asks questions / waits for their answers. It validates with `lib/activity2.js`, so it runs from inside the
    bridge's `src/`, and talks only to a 2.0 gateway. See "Log / activity" below.
  - `tools/aimb-migrate-v2.mjs` — **the one-time 1.7x → 2.0 history conversion** (#88): converts this host's
    `persistence/activity/<host>/` in place, verified, restored on failure. Run it only with every bridge on the host
    stopped (it refuses while the gateway answers on its port). See `../docs/cutover-2.0.md`.
  - `tools/research_client.js` — example page leaf injected into a browser tab (generic site research;
    wayback engine on web.archive.org).
- `dashboard.html` — live debug page: **mesh map** (hosts grouped by session-id prefix, gateway ringed,
  sessions/pages as nodes, control/page edges, amber pulse on message activity, gateway↔gateway edge
  appears when cross-host gossip lands), plus roster tables + trace feed, and the **Activity** tree of what every
  agent is doing (#70 step 5 — see "The Activity page"; light / dark follow the OS; v1.65.0: a log panel for the selected
  row and a right-click menu of actions — see "Step 6d"; v1.72.0: the selected node's details + data at the top of the
  panel, and the log oldest first — see "Details, data and the log order"). **The gateway serves it over
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
  the ACTIVITY BOARD (2.0, #88): `unit/test_activity_unit.mjs` (the shared primitives in `lib/activity.js`),
  `test_node_id_unit.mjs` (ids, keys, slugs, labels, references, `@`-free paths, the leading-`@` rule),
  `test_activity2*_unit.mjs` … `test_activity10_unit.mjs` and `test_activity_q72_unit.mjs` (one per #88 build step: the
  model, plans / questions / types, actions, test runs, v6 records + replay, the conversion — fuzzed against the frozen
  1.7x library in `tests/fixtures/activity-v175.js` —, the migration script, the store and its files, gossip v6 — a seeded
  gossip fuzz —, the tool / script / guides, the dashboard units, the session lifecycle), `test_view_state_unit.mjs`; and
  the live suites in `tests/activity/` — 2.0 gateways on temp dirs: the start check (exit 78) and the files
  (`test_activity2_files_live`), gossip v6 across hosts and a 1.7x stand-in (`test_activity2_gossip_live`,
  `test_activity_gossip_live`), the view state (`test_view_state_live`), the script (`test_log_script_live`: every 2.0
  form and every removed one), the tool (`test_log_live`), questions and waits (`test_activity_ask_live`,
  `test_activity_revise_live`), dashboard actions and notices by id (`test_activity_actions_live`,
  `test_activity_notices_live`, `test_activity_msg_live`, `test_activity_plan82_live`), details / paging / pushes
  (`test_activity_detail_live`, `test_activity_dashboard_live`), the carry-forward and the guides (`test_activity_carry_live`,
  `test_activity_6c_live`, `test_realm_guides_live`) and the page in jsdom (`test_dashboard_activity`). Each file's header
  says what it covers and what the 2.0 port retired. Tests run in
  cwd is `process.cwd()`, so any path works incl. Windows. The page fixture is env-overridable
  (`AIMB_TEST_PAGE` — point it at any page following the same widget contract; `AIMB_DASHBOARD`) —
  no hardcoded paths.
  The suites live in **`tests/<group>/`** (v1.67.0, #81) and spawn `../../bridge.mjs` with absolute paths, so
  `npm test` (run from `src/`) or `node tests/<group>/test_*.mjs` works from anywhere.
- **Running the tests (#81, v1.67.0).** Each `test_*.mjs` is still a plain Node script (its own `check()`, PASS/FAIL
  lines, "N passed, M failed", exit 1 on a failure); **node:test** drives them, one script = one test named by its id
  (`mesh/test_mesh`), passing on exit 0, with the counts + FAIL lines attached as diagnostics. A failing script fails only
  its own test; the rest still run. Nine **groups** = nine folders (`tests/helpers/manifest.mjs` lists them, and the
  historical order): `unit` (pure, no sockets: lib, persistence facet, activity core) · `mesh` · `security` (consent,
  grants, vault, token file, roster secrets, cap keys, facet probes, egress) · `persistence` · `federation` · `behaviors` ·
  `doorbell` · `dashboard` · `activity`. Each group's driver is `tests/<group>/<group>.test.mjs` (its scripts one at a
  time); groups run in parallel.
  - `npm test` — typecheck, then every group in parallel (`node tests/run.mjs` → `node --test --test-concurrency=4` with
    the `spec` and dashboard reporters, longest group first). ~4 min instead of ~12 serially.
  - `npm run test:group -- mesh` (or several: `-- mesh federation`) — one group. `npm run test:file -- test_mesh` — one
    script (a name, an id `mesh/test_mesh`, or any part of one: `activity_6c`, `federat`). `npm run test:serial` — every
    script one at a time in the historical order (`tests/suite.test.mjs`). `npm run test:legacy` — the old `&&` chain
    (stops at the first failure). `node tests/run.mjs --list` prints the groups.
  - **One check:** `TEST_ONLY=<text>` (or `--only <text>` on `test:file` / `test:group`) keeps only the checks whose
    NAME contains the text (case-insensitive) — the shared filter in `tests/helpers/check.mjs` that every script's
    `check()` calls. The script still runs end to end (its checks are steps of one scenario); TEST_ONLY narrows what is
    reported and counted: `npm run test:file -- test_dashboard --only "host alias"`, or
    `TEST_ONLY="host alias" node tests/dashboard/test_dashboard.mjs`. (`--test-name-pattern` applies only once a file is
    converted to native describe/it — none is yet.)
  - **Ports:** every script owns a disjoint block of 100 ports — script *i* of the manifest order gets `20000 + 100·i …`
    (`tests/helpers/ports.mjs`; `AIMB_TEST_PORT_BASE` moves the whole space, e.g. a second worktree at 30000). A script
    keeps its historical port numbers as names: `const tp = testPorts(import.meta.url, 7950)` → `tp(7952)` = its block
    + 2; `tp()` throws outside the block. Temp dirs are per script (`mkdtemp`), and no test reads or writes
    `src/config.json` (the dashboard and page E2E suites now use a temp config). A new test: append it to `ORDER` and
    to one group in the manifest (a driver fails a script that is in a group folder but not in the manifest).
  - **Live dashboard progress:** the `tests/reporters/aimb-dashboard.mjs` reporter shows a run on the activity board,
    over ONE `tools/aimb-log.mjs --stream` child: a plan with one ☐ item per script (running → done / failed), a
    `log:false` progress line about every 10 s ("checks N · file i/T · <running scripts>", bar = {done: passed checks,
    skipped, total}), a logged entry per failing script (FAIL lines in `details`) and a final summary. Env:
    `AIMB_TEST_LOG_SESSION` (without it the reporter does nothing), `AIMB_TEST_LOG_PROJECT` (default AIMB),
    `AIMB_TEST_LOG_PATH` (default `@tests`; an agent passes its own path, e.g. `…/tests-81/@run`), `AIMB_TEST_LOG_USER`,
    `AIMB_TEST_LOG_SCRIPT` (another `aimb-log.mjs`, e.g. the main checkout's, which finds the live config itself) and
    `AIMB_TEST_LOG_CONFIG` (a config file given ONLY to the aimb-log child as its `AI_BRIDGE_CONFIG` — never set
    `AI_BRIDGE_CONFIG` / `AI_BRIDGE_TOKEN*` in the test run's own env: the live tests' bridges would inherit it).
    `AIMB_TEST_LOG_TICK_MS` / `AIMB_TEST_LOG_DEBUG=<file>` (a transcript of the stream) are for tuning. It is silent and
    never fails the run (no token, no bridge: it stops reporting). **Not yet on 2.0:** it still sends 1.7x stream lines
    (`@` paths, `@~`), which a 2.0 gateway refuses `legacy-form` — run the suite without `AIMB_TEST_LOG_SESSION` until it
    is switched to the 2.0 test-run pattern (`docs/spec-88.md` §3.8, build step 2d). Live state comes from a side channel: the reporter
    creates `AIMB_TEST_STATUS_DIR`, each driver appends start / end lines there (node:test replays a test file's events
    only after the earlier files have reported). Other knobs: `AIMB_TEST_FILE_TIMEOUT_MS` (default 15 min) kills a hung
    script and its bridges.
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
• `log {as, secret, agent?, key?, id?, path?, label?, under?, text?, state?, progress?, eta?, stale_after?, details?, data?, log?, plan?, context_type?, message_type?, fields?, move?, rename?, merge?, unmerge?, move_to?, transient?, keep?, before?, after?, position?, ask?, choices?, free?, expires?, guide?, items?}` • `resolve {as, secret, resolve, agent?, key?, id?, path?}` • `activity {project?, session?, user?, host?, log?, entry?}` (the mesh-wide activity board, 2.0 forms — see "Log / activity")
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
- **Token in a file (#75):** if the bridge gets its token from `AI_BRIDGE_TOKEN_FILE` (set in the MCP client config),
  `config.json` has no token and your shell doesn't inherit the MCP server's env. Pass `--token-file <same path>`, or
  set `AI_BRIDGE_TOKEN_FILE`. The file may be a bare token or a `KEY=VALUE` env file. An explicit `--token-file` that
  can't be read is exit 64; it never silently falls back to another source.
- **The reminder carries it (#75 part 2, v1.64.0):** when the bridge itself read its token from `AI_BRIDGE_TOKEN_FILE`,
  `{doorbell_cmd}`, `set_wake`'s `command` / `hint` and `{log_snippet}` (below) all end with `--token-file "<that path>"`
  (absolute, forward slashes, quoted) — the PATH only; the token never appears in a reminder or a hint. A token from
  `config.json` adds nothing (the scripts read that file themselves). A token passed as an env VALUE
  (`AI_BRIDGE_TOKEN` in the MCP client config) adds nothing either: it can't be handed on safely, so a host that wants
  the reminders to work verbatim keeps its token in a file (`AI_BRIDGE_TOKEN_FILE`) or in `config.json`.

**You don't need to know that path:** `set_wake` (for a code session) returns a ready-to-run `command`, and a
`connect` reminder may say `{doorbell_cmd}`, which the bridge expands per session when it emits the reminder
(#67): `"<abs node>" "<abs path to this host's tools/aimb-doorbell.mjs>" --name "<you>" --project "<proj>"` (+
`--token-file "<path>"`, #75).
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

## Log / activity — what every agent is doing (#70; 2.0: #88)
Sessions orchestrate, agents do the work. The **activity board** shows each session's agents and their work across the
whole mesh: sessions report with the `log` tool (or, from a shell, `tools/aimb-log.mjs`), anyone reads it with the
`activity` tool or on the dashboard's **Activity** view. Since **2.0.0** (#88, "stable node identity") every node has a
stable internal id: a move or rename is one record and nothing is rewritten. The authoritative rules are
[`../docs/spec-88.md`](../docs/spec-88.md) (§1 identity, §2 records, §3 resolution, §4 API, §5 display, §6 gossip, §7
migration); upgrading a 1.7x realm is [`../docs/cutover-2.0.md`](../docs/cutover-2.0.md). The 1.7x history of this
section (#70 steps 2 – 6d, #79 – #90) is in `docs/architecture.md` §13.

### The tree: nodes, keys, labels, types
A session holds ONE TREE of nodes; the session itself is the root. A node is an **agent** (an actor: it starts with its
first report, **finishes** when its own line is set done / failed, can go **stale** or **gone**) or a **context** (a
piece of work with a line, a bar and an ETA; never stale by itself). Either kind may hold either kind.
- **Id.** Minted once from (owner host, session, creator, key): 16 characters of `a-z2-7`. Results name it as
  `node.id`; the dashboard's copied command uses `--id`. Ids never collide across hosts (the host is hashed in).
- **Key.** The name its creator chose (`--key docs`, `key:"docs"`; 1 – 48 of letters, digits and `_ . # + -`; no `:` or
  `/`; `root` reserved), unique in the creator's SCOPE. An agent's key is its segment of the `--agent` chain
  (`spec-88/research`). A used key reopens its node: new work gets a new key.
- **Label.** Its name on the board (≤ 60), REQUIRED when a call creates the node (`label-required`; never the key).
  Labels are unique among siblings: a clashing CREATE becomes `"Notes (2)"` (warning `relabelled`; the result says which
  label it got); a deliberate rename / move onto a sibling's label is refused `duplicate-label`.
- **Path.** Labels from the session root (or from `--agent`) joined by `/`, no `@` — `Next release/WIP/Docs`; a label
  holding `/` is quoted (`"a/b"`). A path resolves against the live tree, then the aliases of moved / renamed nodes
  (warning `alias`), then creates the missing tail.
- **Types** (a built-in registry: fields, glyph, what shows in place of a bar, rollup, menu): `context` (default),
  `plan` (☰ — its bar is ALWAYS its items, "N of M"), `group` (▤ — a list, not a plan: no bar, a count "3 open · 1 done"),
  `test-run` (⚑ — one bar of its tests, passed green / failed red), `question`, `agent`, `session`. Entries are typed
  too: `note` (default), `question`, `answer`, `withdrawal`, `expiry`, `event` (structure: moves, merges, dismissals) and
  `test-result` (`result` pass | fail | skip, `checks`, `failed`, `duration`; a test-result means done).
- **State:** `running · blocked · failed · done · idle · todo · skipped · abandoned` (+ `withdrawn` for a question you
  asked). `todo` / `skipped` are for plan items; `abandoned` cascades to the open work under it. **Time:** each attempt
  from running to its end is timed (`took`; a reopen starts a new attempt) and shows after the line ("took 4m 12s",
  "running 3m").
- **Limits:** text 240 (longer is truncated with a warning), label 60, depth 32 (warning `deep-tree` past 20),
  128 agents and 4 096 nodes per session (the oldest finished agents / ended plans are evicted past them), details 4 KB,
  data 16 KB.

### Reporting — the `log` tool and `tools/aimb-log.mjs`
Both take the same fields (the script's flags in brackets); the script needs no registration (below).
- **Address:** `agent` [`--agent <chain>`] — report AS that agent (your keys live in its scope; a call with no key / id /
  path targets the agent itself and creates it when new); `key` [`--key`] — YOUR node, created by the first call that
  names it (with `label` [`--label`] and optionally `under` [`--under <ref>`] or a position); `id` [`--id`]; `path`
  [`--path "A/B"`]; [`--ctx "<label>"`] = one more path segment below `--agent` / `--path`. No address = your own node
  (the agent, else the session root). A `<ref>` is a key (yours, then your creators'), `chain:key`, a path, or an `*_id`
  field. Location and label are set ONLY at creation: a different `under` / `label` on an existing node is ignored
  (warning `exists`) — change them with `move` / `rename`.
- **Text** (§4.0): plain `text` [`--text "…"`] only LOGS an entry; a LEADING `@` also SETS the node's line
  (`"@Writing the docs"`); `@@` = a literal `@`. `state`, `progress` ("4812/12000 tiles", "3/6", "61%", "3/6 1
  skipped"), `eta` ("15m", "19:27"), `stale_after` ("60m", ≤ 24h) change the node whatever the text. `log:false`
  [`--no-log`] updates the board without logging (frequent progress; checkpointed, below). `details` [`--details`] and
  `data` [`--data` / `--data-file`] are fetched on demand. Finish with `state:"done", text:"@<summary>"`.
- **Plans:** `plan:[{ key, label }, "Label", …]` [`--item <k> "<label>"` / `--item "<label>"`, repeatable] creates ☐ plan
  items under the target, in order (re-sending keeps existing items; a label-only item's key is its slug, matched by
  label first). Tick: `key:"spec", state:"done"` [`--key spec --done`]. `before` / `after` / `position:"first"|"last"`
  [`--before` / `--after` / `--first` / `--last`] place new items or a new node; alone on an existing node they REORDER it.
- **Structure:** `move` [`--move <ref>`] re-parents the target with its subtree; `rename` [`--rename`] (with `move`: one
  checked change); `merge` / `unmerge` [`--merge <ref>` / `--unmerge`] (contexts and plan items; the merged node's log stays
  reachable); `move_to` [`--move-to "../X" | "/A/B"`] = report, THEN move there in one all-or-nothing call (only `../X` —
  beside the parent — or absolute; a bare or deeper relative path is refused `bad-path` with `suggest:"/…"`; missing
  destinations are created TRANSIENT); `transient` [`--transient` / `--transient=30s`] — a new context that vanishes when
  its last child leaves (after the grace); `keep` [`--keep`] makes it permanent (so does a pin on the dashboard). The
  read-only `resolve` tool [`--resolve "<path>"`] prints the absolute path + id a path names now.
- **Types:** `context_type` [`--context-type=plan|group|test-run|context`] for a NEW context; `message_type` + `fields`
  [`--message-type=test-result --result pass --checks 22 --failed 0 --duration 4.1s`].
- **Questions:** `ask` [`--ask "<the question only>"`] + `choices` [`--choice "A"`, one per option, ≤ 8 × 60 chars] +
  `free` [`--free`] + `expires` [`--expires 2h`, ≤ 7d] posts a question for the dashboard viewer (on a line-less context,
  else a new `?N` child). The answer arrives as `activity_answer`; the script can WAIT for it on the same connection
  (`--wait 30m`; `--wait-answer --key|--id|--path` for an existing one). Withdraw: its key with `state:"withdrawn"`. An
  open question never goes stale. State the question only — its choices are listed below it as the answers (a question
  that repeats its choices gets warning `choices-in-question`).
- **Batches:** `items:[…]` [`--batch <file.json|->`, a `--stream` array line] — ≤ 64 items, ≤ 64 KB; beside the items only
  `agent` and `log` (defaults); each item is its own all-or-nothing call, applied in order →
  `{ ok, results:[…, ref echoed], applied, failed }`.
- **Guide:** `guide:"agent"|"session"` [`--guide agent|session`] logs nothing and returns the how-to text; with `agent`
  (+ `label`, `under`) it is that agent's FIRST REPORT: the agent is put on the board (running, "reading the guide") if it
  is not there yet.
- **Result:** `{ ok, id (the ENTRY id), ts, session, node:{ id, key, scope, label, path, kind, type, created? }, state,
  current, line (true when the line was set), logged, stale_at }` (+ `plan:[…]`, `moved`, `merged`, `question`,
  `cascade`, `warnings`: `exists`, `exists-elsewhere`, `alias`, `relabelled`, `deep-tree`, `position-unused`,
  `choices-in-question`).
- **Removed 1.7x forms** — refused `legacy-form` BEFORE anything is written, with a message naming the 2.0 form (the
  script on its command line, the gateway in tool calls, batches, streams and waits):

| 1.7x form | 2.0 form |
|---|---|
| positional text (`aimb-log … "text"`) | `--text "…"` (a leading `@` sets the line) |
| `--plan "A" "B"` | `--item "A" --item "B"` (or `--item <key> "<label>"`) |
| `--move <node> --to <parent>`; the tool's `to` | `--key <node> --move <parent>` |
| `@` at the start of a path segment (`@"Next release"/@Docs`, `@root`, `@?3`) | `Next release/Docs` (the message shows the converted path) |
| `@~` in a path or text (`…/@~A`, `"@~root …"`) | `--text "@…"` on the node (`--key A`, or no `--key` for your own node) |
| the tool's `note` / `context` | plain `text` / `path` (or `--ctx`) |

**Status text is plaintext and visible realm-wide: never put secrets in it.**

### `tools/aimb-log.mjs` — reporting without registering
```bash
node src/tools/aimb-log.mjs --session S --project P --agent docs-agent --label "Docs agent" --under docs --guide agent
node src/tools/aimb-log.mjs --session S --project P --agent docs-agent --item readme "Rewrite the README"
node src/tools/aimb-log.mjs --session S --project P --agent docs-agent --key readme --state running --text "@Rewriting it"
node src/tools/aimb-log.mjs --session S --project P --agent docs-agent --state done --text "@README done"
node src/tools/aimb-log.mjs --session S --project P --path "Next release/Docs" --text "a plain log entry"
```
- It talks to this host's GATEWAY as a token-gated `logger` leaf on the WS port — the same trust as the doorbell (anyone
  holding the realm token may report as any session) — except that the gateway refuses to speak for a session that is LIVE
  on the roster under another user (`session-user-mismatch`). A script-only session is never marked gone; it can go stale.
- **Identity:** `--session` and `--project` (required); `--user` (default `AI_BRIDGE_USER`, else the OS login); the realm
  from `AI_BRIDGE_REALM`, else `config.json`'s `realm`. **Token / port:** `--token-file <path>` (#75), else
  `AI_BRIDGE_TOKEN` / `AI_BRIDGE_TOKEN_FILE`, else `config.json` (found as `../config.json` from the script, or
  `AI_BRIDGE_CONFIG`); `--ws-port` / `--url` / `AI_BRIDGE_WS_PORT`, else `wsPort`. `--token` is refused (argv is
  world-readable). It validates locally with the gateway's own parser (`lib/activity2.js`), so it runs from inside `src/`.
- **2.0 only:** it talks only to a gateway whose welcome says `activity_format: 6`; any other is `gateway-unsupported`
  (exit 4) before anything is sent — except `--guide`, which prints its built-in text against anything.
- **`--stream`:** ONE connection, NDJSON on stdin (an object, or an array = a batch, per line), one result line each in
  order (`line` = the input line number; the result's own `line` flag is `line_set`); a dropped link is re-dialled.
  Lines are sent one at a time (`AIMB_LOG_TIMEOUT_MS`, default 8000).
- **Exit codes:** 0 ok · 4 the bridge said no / transport error / no 2.0 gateway · 64 the command line (incl.
  `legacy-form`) · waits: 10 the wait ran out (the question stays open), 11 expired, 12 withdrawn, 13 the session left.
- **Protocol** (the gateway's WS port): `{type:"hello", kind:"logger", token, ident:{session, project, user, realm}}` →
  `{type:"welcome", logger:true, bridge_version, activity_format:6, realm, host, ident}` or `{type:"error", code, what}`
  + close; then `{type:"log", ref, input}` → `{type:"logged", ref, result}` (an `input.items` = a batch),
  `{type:"guide", kind, cmd, agent?, label?, under?, script}` → `{type:"guide", ok, kind, text, source, board?}`,
  `{type:"resolve", …}` → `{type:"resolved", …}` and `wait_answer {node_id | agent + key|id|path}`. A logger socket is
  not a page or a session: it never appears in `list_sessions`, the dashboard or the roster.

### Guides, the snippet and the realm reminders
Agents never see reminders, so an orchestrator puts ONE line in each agent's prompt: `{log_snippet}` = the ready
aimb-log command for this host (absolute node + script paths, `--session` / `--project`, `--token-file` when the bridge
read its token from a file) with `--agent <your-key> --label "<your name>" --under <item-key>` for the orchestrator to
fill, plus "First run it with --guide agent in place of --text". `{log_tool_hint}` is the same for a session without a
shell (Cowork: the `log` tool). The built-in guides (`lib/log-snippet.js`: `agentGuide`, `sessionGuide`; every line
≤ 110 characters) teach the 2.0 rules. `config.example.json`'s `behaviors.realm` carries the two connect reminders
(`client:code` / `client:cowork`, `"id":"activity"`) that brief orchestrators in 2.0 forms within the 365-character cap;
publishing them — and any realm GUIDES (`behaviors.realm.guides.agent|session`: `text` ≤ 4 KB, placeholders `{cmd}`,
`{agent}`, `{path}`, `{gateway}`, `{script}`, optional `min_bridge`; pulled on request, newest `updated_at` wins) — into
the shared `config.json` is an operator step (bump `updated_at`). The bridge never writes `config.json`.

### Reading — the `activity` tool
`activity {project?, session?, user?, host?, log?, entry?}` — the mesh board: `sessions`, each with its nodes depth first
(`id`, `parent_id`, `key`, `scope`, `label`, `path`, `kind`, `type` + the registry's display, `depth`, `host`; the line,
the effective state — stale / gone computed here —, the bar, ETA, time, log counts). The head carries `format: 6`,
`view_user`, `remote_hosts`, `unshared_hosts` (linked hosts still on 1.7x, below) and `fs_warnings` (Dropbox conflicted
copies). `log:{ session, id | path, own?, removed?, earlier?, limit?, cursor? }` pages a node's MERGED log — the entries of
every node in its subtree NOW, newest first, each tagged with where it was logged (`at`); `removed:true` adds the
entries of removed nodes (ghosts, marked `removed`); a node's history stops at its current run (`run_start`, then
`earlier_cursor` / `earlier:true` = "show earlier runs"; `pruned` when the run began before the oldest retained day).
`entry:{ id, host? }` fetches one entry's details / data. A remote session's pages and entries are fetched from its
owner.

### One writer per host; the files
The host's **gateway** owns its board and its files; a follower forwards its sessions' calls up its control link
(`ACTIVITY` frame → `ACTIVITY_R`). Files (only with persistence on), in `<persist dir>`:
- `activity/<host>/YYYY-MM-DD.jsonl` — the day file (local date): **v6** records — NODE records (`create`, `label`,
  `move`, `rank`, `item`, `merge`, `remove`, `keep` …: structure, never shown in a log) and ENTRIES by node id (`n`) with
  `at` (the path when written); `cp` checkpoints + an in-place `rep` repeat line for `log:false` activity (flushed every
  `progress_checkpoint_sec`, on a clean exit and on prepare-shutdown); a `cf` carry-forward at each day start holds the
  whole structure, so the replay never needs older files.
- `activity/<host>/YYYY-MM-DD.idx.json` — the day's index (node id → entry offsets), written at the rollover and rebuilt
  at open when missing or stale: a log page reads only the indexed spans, backwards.
- `activity/<host>/format.json` — the format marker `{v:6, by, at, days, …}`.
- `views/<host>.json` — the per-user view state this host holds (below).
- `activity-v5-backup/<host>/` — exists only while `tools/aimb-migrate-v2.mjs` runs.

Every file lives under the WRITING host's name and only that host writes it (Dropbox-safe; atomic `*.tmp` + rename);
readers match exact names only, and a Dropbox conflicted copy is WARNed once and listed in `fs_warnings`, never read or
deleted. Retention deletes day files (with their index files) older than `log_retention_days`. A new gateway REPLAYS the
retained window synchronously before it serves.

**The start check (exit 78).** A gateway with v5 (1.7x) day files and no v6 marker, or with a leftover
`activity-v5-backup/<host>/`, REFUSES TO START: one stderr line `activity: REFUSED TO START (exit 78): <why + the command
to run>`, the same text in `<os temp>/aimb-start-refused-<wsPort>.txt` (the Windows tray shows it and stops relaunching
until Restart Bridges…), exit 78. No day files and no marker = a fresh host: the marker is written and it starts.
Followers own no activity: no check. **The migration:** `node src/tools/aimb-migrate-v2.mjs [--dry-run] [--dir <persist
dir>] [--host <name>] [--port <n>] [--config <file>] [--json]` converts THIS host's directory in place — it refuses
while this host's gateway answers on its port, backs up, converts, writes the index files and the marker, VERIFIES
(sizes, sha256, every line v6, a fresh replay = the converter's model), removes the backup; a failed run RESTORES the v5
files (exit 3). Exit 0 done / nothing to do, 2 refused (nothing written), 3 failed, 64 the command line. See
`docs/cutover-2.0.md` and spec §7.

**Config** — an `activity` block in `config.json` (live-reloaded), each key with an `AI_BRIDGE_ACTIVITY_<KEY>` env
override: `log_retention_days` 7 · `log_entries_per_agent` 200 (in memory, per node) · `stale_after_min` 15 ·
`finished_visible_hours` 168 (a finished / gone agent stays visible this long; also the replay window) ·
`memory_budget_mb` 64 (over it the oldest finished agents / ended plans are evicted — written as `remove` records —, then
the oldest in-memory log entries dropped) · `progress_checkpoint_sec` 60 (10 – 3600, 0 = off) · `abandoned_plan_days` 90
(a gone session's open plans are abandoned by the bridge) · `finished_plan_open_min` 120 (an ended plan stays expanded on
dashboards) · `notice_batch_sec` 3 (dashboard-change notices to one session within this long go as one message) ·
`enabled` true. Env only (every host should agree): `AI_BRIDGE_ACTIVITY_GOSSIP_MS` (1000), `_SLICE_MAX_BYTES` (262144),
`_PAGE_ENTRIES` (50), `_PAGE_BYTES` (32768), `_FETCH_RATE` (4/s), `_REMOTE_MS` (4000), `_DOWN_HOLD_MS` (30000),
`_QUEUE_LINK` / `_QUEUE_DASH` / `_TOOL_WAIT_MS` (the remote-fetch queues), `_BELL_GRACE_MS`; view state
`AI_BRIDGE_VIEW_TOMBSTONE_TTL_MS` (30 days), `_SAVE_MS` (10 s), `_GC_MS` (10 min). Test-only: `AI_BRIDGE_ACTIVITY_FWD_MS`,
`_GC_MS`, `_ROLLOVER_CHECK_MS`, `_CHECKPOINT_MS`, `AI_BRIDGE_TEST_ACTIVITY_TAP=1`, `AI_BRIDGE_TEST_HOSTNAME`,
`AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS`, `AI_BRIDGE_TEST_GOSSIP=v5` (a gateway that announces format 5: the tests'
stand-in for a host left on 1.7x), `AIMB_TEST_VIEW_USER`.

**Lifecycle.** A session whose sub-peer leaves this host's roster shows **gone** (in memory; a report or its return
clears it); a gone agent / session leaves the board after `finished_visible_hours` unless it holds an open plan. A plan
ENDS when every item is done / skipped / abandoned, or its node is set done / abandoned; an open plan's nodes never expire
and are never evicted. The doorbell's 🔔 shows on a session whose listener is armed.

### Mesh-wide — gossip v6
Every gateway gossips its own board to every peer hub over the hub-to-hub link: a full slice on every (re)link, then
deltas, ≤ 1 frame/s per link, `AI_BRIDGE_ACTIVITY_SLICE_MAX_BYTES` per frame (newest-active first). A **unit per node, by
id** (no path: a rename or move changes ONE unit), current lines only — never details, data or entries. A link shares
activity only when both ends announce `activity_gossip:6` in PEER_HELLO: **a host still on 1.7x shares nothing** (the
message mesh still works) and every 2.0 host lists it in the board head's `unshared_hosts` — a RED row on the dashboard
("LITTLE-001 is still on 1.7x (1.75.1): not on this board"). Remote log pages, entries and dashboard actions go to the
node's OWNER by id (`ACTIVITY_REQ` / `ACTIVITY_ACT`), rate-limited per link; a host that goes down shows its agents gone
until it returns (`host_down`), and leaves the board after `finished_visible_hours`.

### The dashboard's Activity view
Projects → sessions → the node tree, merged per session across hosts. Rows show the label, the type's glyph (☰ plan, ▤
group, ⚑ test run, ◌ transient), the line, the bar (or a group's count, a test run's tests bar, a question's pills) and the
time. Click a row: its subtree log in the panel beside the tree ("show earlier runs", "show removed", the log order,
"— new since you last looked —"). **Right-click** (or Menu / Shift+F10, long-press on touch) = the node type's menu: Done /
Skip / Reopen / Abandon, Complete / Abandon / Reopen plan, Finish, Dismiss, Edit text…, Message session…, Answer… /
Change answer… / Withdraw, Rename…, Merge into…, Move to… / Move up / Move down (drag and drop too), Show as group / Show
as plan, the copy commands (`--agent …` / `--key …` / `--id …`), Pin / Hide. Actions go BY ID to the node's owner
(`activity_action {host, session, project, user, id, action, args}`), are logged "… by <user> via dashboard (<host>)",
and the owning session is told (`activity_changed`, `activity_text_edited`, `activity_message`, `activity_answer` — a
REQUEST relayed from a viewer, not authorization). A move or merge onto a same-label sibling opens the CLASH DIALOG (merge
them, or a suggested label). **The per-user view** (pins, hidden, open / closed, Expand / Collapse all, the options,
"seen") belongs to the serving gateway's OS login and follows it to every 2.0 host (a replicated last-writer-wins set,
`views/<host>.json`); a node you closed shows "N new" / "? N" instead of reopening; Reset view clears it. The board
streams as deltas (`activity_sub` → full board + `types`, then ≤ 1 delta/s; `view_set` / `view` for the view state).

### Prepare-shutdown — `POST /admin/prepare-shutdown` (v1.59.0)
The Task Tray's Restart Bridges… and Shut down all kill the bridges with TerminateProcess, which runs no exit handler, so
the `log:false` progress since the last checkpoint used to be lost. Now the tray first calls the **gateway's** HTTP
server (the WS port): `POST http://127.0.0.1:<wsPort>/admin/prepare-shutdown` with **`Authorization: Bearer <realm
token>`** (a token in the URL is not accepted). The gateway waits out an in-flight checkpoint tick, writes every dirty
node's `cp` line **and** the repeat line now (v6 records since 2.0) (so the unchanged contexts' last activity survives too), drains the
activity file's write queue (queued log entries included), and only then answers
`200 {ok:true, role, bridge_version, flushed:{cp, rep, files_drained[, skipped]}, notices, down_notified, ms}`
(`skipped`: `checkpoints-off`, `no-persistence`). Non-loopback callers get 403, a missing/bad token 401, a non-POST 405, another
`/admin/…` path 404. **Only the gateway needs it:** followers write no activity files and keep no deferred writes (their
persistence writes are issued immediately), so nothing is propagated to them. v1.60.0: after the flush the gateway also
sends its peer hubs the going-down notice (`down_notified` = how many) so their boards show this host's agents gone at
once. v1.68.0 (#80): before that it sends every queued dashboard-change notice (`notices` = how many messages went). The
bridge keeps running afterwards; the caller kills it.

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
`realm:true`). (v1.74.0: the same block may also carry `guides` — the realm's text for `aimb-log --guide`, pulled on
request, never sent as a reminder; see "Realm guides" under step 6c.) **No reminder and no default for an operation ⇒ it is silent** — so an operation
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
