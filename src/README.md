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
  builds the `{log_snippet}` / `{log_tool_hint}` connect-reminder texts (pure; the bridge fills the paths). `activity.js` is the
  pure core of the #70 agent activity board (no I/O, no clock — `now` is a parameter; bridge.mjs does the I/O): report
  parsing (`@ctx`/`@~ctx`, progress/eta/stale_after, the `log` flag, the locked limits), `apply` over a plain state
  object, text placeholders (`renderText`), checkpoints (`planCheckpoints`), the newest-first replay (`createReplay`),
  the read views (`boardView`/`logView`/`findEntry`), the derived views (stale/gone, rollup, visibility), the
  per-origin gossip `snapshot`/`mergeSnapshot` and (v1.60.0) the wire — `planSlice` (per-link deltas, byte cap, newest
  first) / `applySlice` (epoch + seq) / `markOriginDown` / `locateSessions`, the memory budget and `resolveConfig` (the `activity` block +
  `AI_BRIDGE_ACTIVITY_*`); unit-tested in `tests/unit/test_activity_unit.mjs`. `win-env.js`
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
    `lib/activity.js` to validate locally, so it runs from inside the bridge's `src/`. v1.62.0: `--path` (the node
    tree) and `--batch <file|->`; v1.63.0: `--plan "A" "B" …` and `--done`; v1.64.0: `--token-file <path>` (#75); v1.69.0:
    `--before` / `--after` / `--first` / `--last` and `--move` / `--to` (#82); v1.71.0: `--ask` / `--choice` / `--free` /
    `--expires` / `--wait` and `--wait-answer` (#85: a question, and waiting for its answer). See "Log / activity" below.
  - `tools/research_client.js` — example page leaf injected into a browser tab (generic site research;
    wayback engine on web.archive.org).
- `dashboard.html` — live debug page: **mesh map** (hosts grouped by session-id prefix, gateway ringed,
  sessions/pages as nodes, control/page edges, amber pulse on message activity, gateway↔gateway edge
  appears when cross-host gossip lands), plus roster tables + trace feed, and the **Activity** tree of what every
  agent is doing (#70 step 5 — see "The Activity page"; light / dark follow the OS; v1.65.0: a log panel for the selected
  row and a right-click menu of actions — see "Step 6d"). **The gateway serves it over
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
  `test_activity_unit.mjs` — the pure #70 activity-board core (`lib/activity.js`; #70, 664 — v1.63.0: todos, plans, the
  rollup variants, lifetime, eviction, carry-forward across rollovers + a restart; v1.64.0: abandoned, the plan-end rule,
  auto-abandon, entry counts, the home host + s0, the run boundary / pruned paging; v1.65.0: the agent-finish rule, the
  plan-end marker, every dashboard action + its codes, dismiss + its replay, the cf entry count); `test_activity_gossip_live.mjs`
  — four loopback "hosts" + a follower: the mesh board, deltas ≤1/s per link, truncation, remote paging / entries /
  queued fetches, going-down, owner down, forged slices, a legacy hub, dashboards, plans (#70 step 4 / 6b, 51);
  `test_dashboard_activity.mjs` — the dashboard's Activity view in jsdom: client-side stale, the status glyph + ring,
  hover times, placeholders, the delta store, the tree, pills / host down / bell, the project cycle, active only, logs
  (#70 step 5 / 6b — plan items, the plan bar, host tags, per-host headlines; 6c — open by default, the finished-plan
  window + slider, abandoned, home-host tags, the Plans filter, rollups that follow it, the bar column, counts, the run
  boundary, the 6d row hooks; 6d — the right-click menu per row and state, copies (never a token), confirmations,
  feedback, keyboard + long-press, the log panel + selection, pin / hide, open ancestors, unfiltered counts, the 0 – 7 day
  slider; 186); `test_activity_dashboard_live.mjs` — WS dashboards against three loopback hosts: subscribe → full
  board → deltas ≤1/s, seq-gap resync, page leaves refused, paging into the day files (local + remote), queued fetches
  + `busy`, gone vs host down, the doorbell flag, the duplicate-hostname warning, plan units + ticks (#70 step 5 / 6b, 43);
  `test_activity_carry_live.mjs` — the #70 6b carry-forward under the test clock hook: 13 days of seeded files, a real
  day rollover, a restart a week later rebuilt from the rollover's records alone (11); `test_activity_6c_live.mjs` — #70
  6c + #75 part 2: the reminders' --token-file (never the token), the exact {log_snippet} / {log_tool_hint}, aimb-log
  --token-file, the run boundary + pruned history local and remote, gossiped counts, the home host, the board head, and
  auto-abandon under the clock hook (31); `test_activity_actions_live.mjs` — #70 6d: every dashboard action with its codes
  and attribution, local and forwarded to the owning host (ACTIVITY_ACT) with the effect gossiped back, the agent-finish
  rule, abandon_plan leaving an agent running, dismiss (open items refused, gossiped, persisting across a restart), page
  leaves / loggers / hello-less sockets and forged hub frames refused, the exact entry count across restarts (43);
  `test_activity_notices_live.mjs` — #80: a dashboard action tells the owning session (`activity_changed`: subject, body,
  entry id), a burst batched into one message, view-only / refused actions and reads send nothing, the doorbell wakes,
  both directions across two hosts (the OWNER sends), a recipient on another host matched case-insensitively, an offline
  session's notice parked and drained, a script-only session gets nothing, prepare-shutdown flushes the queue (26);
  `test_activity_plan82_live.mjs` — #82: insert before / after / first / last (tool + script), reorder, move with its
  history (memory + the day files under the old path), abandon an ordinary context with the cascade, dashboard Move up /
  Move to (local and forwarded to the owner) with the #80 notice, gossip of ranks + moves to a second host, and a restart
  that replays it all (26); `test_activity_msg_live.mjs` — #83 / #84: Edit text (the line + state, attributed on the line,
  in the entry and through gossip; the batched `activity_text_edited`; the session's next report takes it back) and Message
  session (logged with details; `activity_message` at once — subject, body, entry id; live, parked, or "not delivered" for a
  script-only session), both directions across two hosts, refusals over the wire, an owner without `activity_msg` refused
  `owner-unsupported` before forwarding, the trust wording (34; + 3 with `AIMB_TEST_OLD_BRIDGE=<an older bridge.mjs>`: a real
  1.69 owner — boards both ways, its refusal, its dashboard acting on a 1.70 node); `test_activity_ask_live.mjs` — #85:
  questions (the tool's ask; an answer from the dashboard → `activity_answer` at once, the answer never in the subject; a
  script's `--ask … --wait` released by the answer; an agent's question to its session; answers forwarded to another host's
  owner, incl. a script waiting there; expiry; withdraw by the asker and the dashboard; a wait that runs out; a question that
  goes; script usage; an owner without `activity_ask` refused `owner-unsupported`; the trust wording; `--choice` one per flag, refusing status text / a flag) (37; + 4 with
  `AIMB_TEST_OLD_BRIDGE`: a real 1.70 host — it shows a question as a blocked context, its refusal, its dashboard's Abandon…
  withdrawing a 1.71 question, a 1.71 script's `--ask` against it `gateway-unsupported`). Tests run in
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
    never fails the run (no token, no bridge: it stops reporting). Live state comes from a side channel: the reporter
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
• `log {as, secret, path?, agent?, text?, context?, state?, progress?, eta?, stale_after?, details?, data?, log?, plan?, items?}` • `activity {project?, session?, path?, agent?, host?, active_only?, log?, entry?}` (#70 the mesh-wide activity board — see "Log / activity")
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

## Log / activity (#70) — what every agent is doing (v1.58.0 step 2, v1.59.0 step 3, v1.60.0 step 4, v1.61.0 step 5, v1.62.0 step 6a, v1.63.0 step 6b, v1.64.0 step 6c, v1.65.0 step 6d; v1.66.0 #79; v1.68.0 #80; v1.69.0 #82; v1.70.0 #83 / #84; v1.71.0 #85)
Sessions orchestrate, agents do the work. The **activity board** shows each session's agents and their progress across
the whole mesh: the `log` + `activity` tools, the gateway-owned state and the daily log files (step 2),
`tools/aimb-log.mjs` for agents and scripts that don't register (step 3, below), and the mesh-wide gossip plus on-demand
remote history (step 4, "Mesh-wide" below), the dashboard's **Activity** tree (step 5, "The Activity page" below), and
the **unified node tree + batch logging** (step 6a, v1.62.0, "The node tree" below) and **todos and plans** (step 6b,
v1.63.0, "Todos and plans" below), and (step 6c, v1.64.0, "Step 6c" below) the paste-ready agent snippet + the connect
reminders, the abandoned state and the plan-end rule, gossiped entry counts, run-boundary history, the finished-plan
window, home-host tags and the Plans filter.

### The node tree (v1.62.0, step 6a)
A session holds ONE TREE of **nodes**. The session itself is the root. Every other node is one of two kinds:
- an **agent** (an actor) — it starts with its first message, **finishes** when its own current line is set done/failed
  (a later running/blocked/idle line revives it), can go **stale** or **gone**, and takes `stale_after`;
- a **context** (a piece of work) — a current line, progress and an ETA. It never goes stale by itself.

Any node may contain either kind, so agents can be grouped under the task they serve and contexts can nest.

**Paths.** One `/`-separated path; a segment starting with `@` is a context, anything else an agent:

| Path | Means |
|---|---|
| `spec-70` | an agent |
| `spec-70/research` | a sub-agent |
| `spec-70/@Tharsis` | a context of that agent |
| `spec-70/@Tharsis/@z12` | a nested context |
| `@#70/spec-70` | agent spec-70 grouped under the session's context #70 |
| `@#70/@step4/spec-70` | an agent under a nested task context |

- `@~` on the **last** segment sets that node's current line: `spec-70/@~Tharsis`. `@root` / `@~root` as the last
  segment means the node itself: `spec-70/@~root` is the agent's own headline, a bare `@~root` the session's.
- Quote a context name with spaces: `@"CTX strip 17"` (in the `path` field an unquoted name may contain spaces too;
  the canonical spelling quotes it). An agent segment is letters/digits/`_` then `. : # + -` (≤48 chars); a context
  name ≤60 chars without `"`, `/` or control characters; `root` is reserved. Matching is case-insensitive; the first
  spelling seen is kept.
- Intermediate nodes a path names are created **implicitly** (`implicit:true`, no line of their own); a node stops being
  implicit once a message targets it or is owned by it. An implicit agent never goes stale.
- **The old notation is a special case:** `agent` (agent segments only) + `path` + ONE trailing context — the `context`
  param (`"@~Ctx"`, markers optional, the text then literal) or else a leading `@…` prefix in the text, which may itself
  be a relative path (`"@Tharsis/@~z12 seeding"`). Precedence: `context` beats a text prefix; `agent` then `path`
  concatenate. So `agent:"a/b"` + text `"@~Ctx …"` = `a/b/@~Ctx`, and no address + `"@~root …"` = the session's headline.

**Activity and staleness.** A message's **owner** is the nearest agent at or above its target (the session when there is
none). A message refreshes `last_activity` (and sets `stale_after`) on its target and every node up to its owner — a
context's message keeps its agent fresh; a sub-agent does not refresh its parent agent. **Staleness belongs to agents**
(and the session). A context shows the staleness / gone of its **nearest agent ancestor**, and only while it has a live
current line of its own (a context with no line — a grouping node — shows no state). A context directly under the
session follows the **session's own** reports (any message whose owner is the session, at any depth that doesn't cross an
agent) — exactly as the session row always has.

**Rollup** recurses through any depth: a node's bar is its reported progress, else the sum of its children's bars when
they share a unit, else the mean % of its children that have a bar, else (6b) "N of M done" over its plan items — see
"Todos and plans" for how plan items and other children combine. **v1.66.0 (#79): progress has three parts — done,
skipped, total** (see "Three-part progress" below): every rollup carries all three, and a **done** node always counts as
100% done.

**Logs.** Every node keeps its **own** bounded log (`log_entries_per_agent` per node). A node's **Log** is the merged log
of its whole **subtree**, newest first (`own:true` for the node's own entries); each entry carries its `path` and `rel`
(relative to the node). Paging works for any node, local and remote: the merged memory is complete down to the
subtree's **floor** (the newest entry any of its nodes holds only in the files), then the pages continue into the day
files.

**Limits** (locked): depth ≤ **6** segments; per session **128 agents** and **4096 nodes** of either kind (the root not
counted); text 240, context name 60, `details` 4 KB, `data` 16 KB (unchanged). A message that needs room **evicts the
oldest finished agent with its whole subtree** — v1.63.0: or the oldest ENDED plan (v1.64.0: every item done, or marked complete / abandoned), and never
a subtree that still holds an OPEN plan item; never an ancestor of its own target; reported in `evicted` — and is refused
(`too-many-agents` / `too-many-nodes`) only when that can't make room — or when it writes no record (`log:false`).

**Batch.** `log {…, items:[{ path?, agent?, text, context?, state?, progress?, eta?, stale_after?, details?, data?, log?,
ref? }, …]}` logs several messages in **one call**, applied **in order**: `{ok:true, results:[one per item, its ref
echoed], applied, failed}` — a bad item fails alone. Bounds: ≤ **64 items** and ≤ **64 KB** of items JSON; over either,
the whole call is refused (`too-many-items` / `batch-too-large`; `bad-batch` for an empty / non-array batch or another
message field beside `items`). Beside `items`, `log` is a default for every item and `path` / `agent` are the batch's
**default address**. **v1.63.0: an item's own `path` / `agent` is RELATIVE to it, like a folder** — `path:"@#70"` +
item `path:"@B/@~x"` = `@#70/@B/@x`; the default agent stays in front (`agent:"w"` + item `path:"y"` = `w/y`) — and a
**leading `/`** on the item's first address field makes it absolute from the session root (`"/@other/@~y"`). (6a's rule
was "an item's own path replaces the default".) The default `context` (a trailing marker) applies only to items naming no
path / agent; an item with only a `context` keeps the default path / agent and replaces the default context. A follower
forwards a batch to its gateway in ONE `ACTIVITY` frame; the `logger` WS accepts `{type:"log", ref, input:{items:[…]}}`;
the script takes `--batch <file.json|->` and, in `--stream`, a line that is a JSON array (both with the same relative
rule against `--agent` / `--path`). A batch is gossiped and pushed to dashboards as one coalesced update. An item may
carry a `plan` (v1.63.0).

**Formats (v1.63.0).** Day-file records are **v3** (`{"v":3, …, "path":"spec-70/@Tharsis", …}`; `new_from` marks the first
persisted record of each node on its chain); v3 only ADDS to v2 (the `todo` / `skipped` states, `plan_item` + `plan_ix`
on a plan item's records, `created_at` on a cp, the `cf` carry-forward record), so a 1.62 (v2) record is still read;
1.58–1.61 records (v1: `agent` / `context`) are **skipped**, never misread. Gossip slices are v3 (one unit per node, a
plan item with `plan_item` / `plan_ix`) and hubs declare `activity_gossip:3` — a 1.62 hub (format 2, which would misread
a todo) exchanges no activity with a 1.63 hub (its frames are ignored; remote fetches to it answer `owner-unsupported`).

### Todos and plans (v1.63.0, step 6b)
Opt-in: nothing becomes a todo unless it is created as one, and ordinary contexts are unchanged.

| State | Shown as | Meaning |
|---|---|---|
| `todo` | ☐ | planned, not started |
| `running` / `blocked` | the in-progress mark | being worked on |
| `done` | ☑ | finished |
| `skipped` | ~~struck through~~ | dropped from the plan, kept visible so the plan stays honest |
| `failed` / `idle` | ✗ in a box / the idle mark | as for any context |

- **A todo is a context with a todo status.** A context created by a **plan**, or whose FIRST current line has state
  `todo`, is remembered as a **plan item** (`plan_item:true` on the board; there is no flag to pass). It stays one after
  it is ticked: done shows ☑, not ✓, and it keeps the plan lifetime rules below.
- **Who can be what:** `todo` / `skipped` are context states — an agent or the session gets `bad-agent-state`. `skipped`
  on an ordinary context, or `todo` on a context that already has a line of its own, is `not-a-plan-item`.
- **Plans:** `log {path:"@#70", plan:["Spec", "Build", "Test"]}` (script: `--path @#70 --plan "Spec" "Build" "Test"`)
  creates `@#70/@Spec`, `@#70/@Build`, `@#70/@Test` as ☐ items, in the **given** order (never A→Z); each name is one
  context segment (≤60 chars, no `/`, a leading `@` is dropped, `root` is reserved; ≤64 names; a repeated name is kept
  once with a `plan-duplicates` warning; else `bad-plan`). Text is optional with a plan; with text, the target gets its own
  message first. Each new item is **logged** (a ☐ line whose text is its name, persisted at once) even with `log:false`,
  and the result lists them: `plan:[{name, path, created?, adopted?, plan_item, state}]`. A plan counts toward the 4096-node
  budget. A batch item may carry a plan.
- **Re-planning (the merge rule):** re-sending a plan **never duplicates or resets** an item — an existing item stays
  exactly as it is (its state, its place); a **new** name is added at the **end**, in the order given; a name **left out**
  stays where it is. Re-ordering the names moves nothing. An existing context with **no line of its own** (e.g. one a
  deeper path created) is **adopted** as a ☐ item; one that already has a line is left alone (`plan_item:false`).
- **Ticking:** `path:"@#70/@~Build", state:"done"` (script: `--path "@#70/@~Build" --done`; `--done` = `--state done`). An
  `@~` line that carries a state may omit its text: the item keeps its line (its name, or what was last said). An `@~`
  line with no state on a ☐ item **starts** it (running); `todo` again re-opens an item. Any report naming the path may
  tick it (the session or any agent).
- **Never stale:** a plan item never goes stale, in any state, and its own staleness is never shown (nor gone: it shows its
  own state). An agent working under an item still shows its OWN staleness on its row.
- **Rollup — "N of M done":** a node with plan items and no reported progress gets an automatic bar, unit `done`,
  `todos:true`, `n` = all items. **v1.66.0 (#79): M = EVERY item; N = done items; skipped AND abandoned items form the
  bar's skipped part; todo / in-progress / idle / failed items are what remains** (`{progress}` → "2 of 5 done · 1
  skipped"; `items:true`, `skipped`, `abandoned` = how many of the skipped were abandoned). (6b–6c left skipped items out
  of M and drew no bar when every item was skipped.) **Mixed children:** a plan item
  counts ONLY as a todo of its parent — its own bar (e.g. an agent under it reporting files) shows on its own row, never in
  the parent's sum. The precedence stays 6a's: the node's reported progress, then the SUM of its ordinary children's bars
  when they share a unit, then their MEAN %, then the plan's N of M — so ordinary children with bars win over the plan.
  Up the tree, plan bars sum like any shared unit (two plans → "3 of 9 done").
- **Lifetime** (v1.64.0 changed when a plan ENDS — see "Step 6c": only all-done, or the plan marked complete / abandoned;
  what follows is 6b's rule): `finished_visible_hours` now defaults to **168 (7 days)** (per host as before). **Open** items (todo /
  running / blocked) **never expire** while their session exists — not in a finished agent's subtree (the agent stays),
  not in a session that went gone. A **plan** (a node with plan items) **ends** when its last item became done / skipped,
  or when its owner (the plan node itself if it is an agent, else its nearest agent / the session) finishes, and expires
  `finished_visible_hours` after that: its items go, and the plan node too when it is a plain context with nothing else
  under it and no live line. **Eviction** under the hard limits (128 agents / 4096 nodes, the memory budget) takes the
  oldest finished agents and ended plans first and **never** a subtree that holds an open item; when nothing else can go,
  the call is refused (`too-many-nodes` / `too-many-agents`).
- **Carry-forward:** at each **local day rollover** (the gateway checks every 30 s) — and once after a restart's replay
  when today's file has none yet — the gateway appends a `cf` record of every long-lived node to the NEW day's file:
  every open plan item **and its ancestors**, and every node whose own state (line, bar, ETA, or its reported activity)
  would otherwise fall out of the replay window before the next rollover. `{"v":3,"kind":"cf","ts":…,"path":"@#70/@Build",
  …identity, "current":{…line incl. details/data}, "state", "progress", "eta_at", "created_at", "last_activity",
  "stale_after_ms", "implicit", "plan_item", "plan_ix", "finished_at"? }` — a full snapshot of that node only (it refreshes
  nobody's activity, so a quiet agent is as stale after a restart as before). The replay reads only its window, so a plan
  open for weeks comes back with every item's ☐ / ☑ / skipped / in-progress state, its order and its created_at; older
  history stays in the older day files and pages as before (a `cf` is never a log entry).
- **Headline** of a session on several hosts: the host that **most recently SET** a headline (its root line's own time),
  with each host's own line shown when the row is expanded (`selves`); none has one → the most recently active host.
- **Dashboard:** plan items render ☐ / the in-progress mark / ☑ / struck-through skipped, as a checklist (their line shows
  once it says more than the item's name), in creation order; a plan node shows a solid green "N of M done" bar (hover,
  v1.66.0: "2 of 5 done · 1 skipped (40%) — its plan: 5 items"). **Active only** keeps open items visible (even under a
  finished agent) and hides ended plans. **Host tags** appear only where a node's host differs from its parent's (a
  top-level node: from the session's headline host — v1.64.0: its HOME host); the session row shows all its hosts and,
  expanded, each host's own line above its Log.

**Reporting — `log {as, secret, path?, agent?, text?, context?, state?, progress?, eta?, stale_after?, details?, data?, log?, plan?, items?}`.**
You report as a registered session (`as` + `secret`). Address a node with `path` (above; omit it for the session itself)
or the old `agent` + `context` / text prefix — agents never register. The identity is **realm + project + user + session
name + host** (v1.60.0; + the node path): each host only ever writes its own entities, so the same session or node
reporting from two hosts is two entities, which the board groups under one session (a session that moves machines
leaves its old host's entries to go stale or gone).
- Every message belongs to its **target node**: `path:"w/@build", text:"compiling"` (or `agent:"w"` + `"@build
  compiling"`) appends to the build context's log; `@~` on the last segment (`"w/@~build"`, `"@~build compiling"`)
  also makes it that node's **current line**; `"@~root …"` sets your own headline; no address = the session itself, log
  only. `context:"@~build"` does the same as a text prefix (the text is then literal). Quote spaces: `@~"strip 17"`.
- **State** (`running|blocked|failed|done|idle`, + `todo|skipped` for plan items — v1.63.0) changes only with a current
  (`@~`) line; done/failed on an **agent's** own line **finishes** it. Stale is computed for agents (quiet longer than `stale_after_min`, or the message's own
  `stale_after`, ≤24h; a context follows its agent); gone = the session left this host's roster (deregister / TTL / its
  process exited), cleared when it comes back.
- **Progress / ETA** (`"4812/12000 tiles"`, `"3/6"`, `"61%"`, v1.66.0 also `"3/6 1 skipped"` / `{done, skipped, total}` / `"15m"`, `"1h25m"`, `"19:27"`) move the node's bar from
  **any** message, stick until changed (`"none"` clears) and the ETA is dropped while the node is done/failed.
- **Text is a template**, rendered when read: `{progress}` → "4,812 of 12,000 tiles" ("61%" for a % bar, "3 of 6"
  without a unit; v1.66.0: "1 of 5 done · 1 skipped" when the bar has a skipped part), `{skipped}` (v1.66.0), `{pct}` → "40%" (floored), `{done}` `{total}` `{unit}`, `{eta}` → "~1h 25m" ("now" once due, "?"
  with no ETA). `{{` / `}}` are literal braces; an unknown `{word}`, or a bar placeholder with no bar, stays as typed. A
  current line renders against the context's **live** bar (`"@~Tharsis Seeding {progress}"` keeps moving); a log entry
  against the progress recorded on it. The files and the gossip keep the raw template.
- **Default text:** a message with progress/eta and no text gets `"{progress}"` (`"{eta}"` with only an ETA) — logged or not.
- **`log:false`** updates the board (line, state, bar, activity) **without** appending to the log or the file. An
  agent's own tool calls cost tokens, so agents log sparingly, at milestones; a **script** may report often with
  `log:false` (e.g. every second) and occasionally `log:true`. The bridge checkpoints that progress every
  `progress_checkpoint_sec` so the bar survives a restart.
- Limits (locked; a change is a version bump): text 240 chars (longer is truncated + `warnings`), context name 60, depth
  6, 128 agents and 4096 nodes per session (room is made by evicting the oldest *finished* agent with its subtree, or an
  ended plan — never an open plan item),
  `details` 4 KB, `data` 16 KB JSON — keep both small. **Status text is plaintext, realm-wide: never put secrets in it.**
- Returns `{ ok, id, ts, session, path, agent, context, current, state, stale_at, logged }` (`agent` = the owner agent's
  path, `context` = the target's name when it is a context; + `warnings`, `evicted`; codes like `bad-path`,
  `path-too-deep`, `context-too-long`, `too-many-agents`, `too-many-nodes`, `bad-plan`, `bad-agent-state`,
  `not-a-plan-item`, `activity-disabled`, `activity-loading`, `no-gateway`; + `plan:[…]` with a plan). A batch returns
  `{ ok, results, applied, failed }`.

**Reading — `activity {project?, session?, path?, agent?, host?, active_only?, log?, entry?}`.** The mesh board: sessions,
each with `self` (its root node) and `nodes` — every node of its tree, FLAT, with `path`, `kind` (agent | context),
`depth`, `parent` and `host`, its current line (`text` raw, `rendered` filled in), effective state (`stale` / `gone`;
`was` = the reported one — computed by the READER with its own `stale_after_min`; contexts by their agent), `progress` =
its bar (reported, or the recursive rollup), ETA, `implicit`, visibility and log counts. Sessions are **grouped** by realm
+ project + user + name across hosts: every node (and the root) carries its `host`; a group on one host has `host`, one
on several has `hosts:[…]`, `multi_host:true`, `self` (v1.63.0: the root of the host that most recently SET a headline)
and `selves` (one per host). `path` (or `agent`) keeps a node and its subtree; `active_only` drops finished / gone agents
with what is under them (unless it holds an open plan item) and ended plans. A plan item has `plan_item:true` + `plan_ix`. `remote_hosts` lists each remote host held (`sessions`, `seq`, `linked`, `down_at`, `truncated`).
`log:{session, project?, user?, host?, path?, agent?, context?, own?, limit?, cursor?}` is a node's log — its SUBTREE
merged (each entry with `path` + `rel`), or `own:true` for its own entries — newest first, paged: `next_cursor` → pass it
as `cursor` for the older page; a name on several hosts is `ambiguous-session` (with each candidate's host) unless the
node or `host` settles it. `entry:{id, host?}` is one entry in full with its
`details`/`data` (memory for a current line, else the day file — via an id → offset index, else a scan of the day the
id's timestamp names); another host's CURRENT line is found by id alone, its older log entries need `host`. A remote
read answers with `from_host`. Times are ms epochs.

**One writer per host.** The host's **gateway** owns the board and its files; a follower authenticates its own sub-peer
and forwards the call up its control link (`ACTIVITY` frame + request id → `ACTIVITY_R`, 5 s timeout; only a registered
follower's frames are honoured, and only for a sub-peer on its roster). A follower promoted to gateway first **replays**
the host's files (below); a `log` call waits for that (≤15 s, else `activity-loading`).

**Files:** `<persist dir>/activity/<host>/YYYY-MM-DD.jsonl` (local date), only with persistence on. One JSON line per
logged entry (with `details`/`data` and the identity), plus two compact kinds for `log:false` activity:
- a **checkpoint** `{"v":2,"kind":"cp","k":3,"ts":…,"session":…,"path":"w/@tiles","current":{…},"state":…,"progress":…,"eta_at":…}`
  — written at most once per node per interval when its line / bar / ETA changed; `k` is a small per-file key given
  to the node the first time it is checkpointed that day;
- a **repeat line** `{"v":2,"rep":[3,7],"n":245,"since":…,"last":…}` — these keys were alive and *unchanged* for `n`
  intervals from `since` to `last`. While the set stays exactly the same the bridge rewrites this last line in place;
  any other write (an entry, a cp) or a different set starts a new one. Contexts with no activity aren't listed.

Ids are `act_<boot nonce>_<ms base36>-<seq>` (the time names the day file). Retention deletes day files older than
`log_retention_days` (at gateway start and daily). **Replay** reads the files newest-first, backwards in 64 KB chunks:
phase 1 fills current lines, bars, states and finished status from the newest record carrying them (a cp counts), and
publishes the board as soon as everything seen is resolved (or after 300 ms); phase 2 fills each agent's history. It
covers `finished_visible_hours`; a context's `last_activity` also takes the `last` of any repeat line listing it, so it
isn't stale after a restart; a `cf` carry-forward (v1.63.0, "Todos and plans") restores a long-lived node whose own
records are older than the window. A garbled final line (a crash mid-write) is skipped. A clean shutdown flushes pending
checkpoints, and so does the Task Tray before it kills the bridges (`POST /admin/prepare-shutdown`, below).

**Config** — an `activity` block in `config.json` (live-reloaded), each key with an `AI_BRIDGE_ACTIVITY_<KEY>` env override:
`log_retention_days` 7 · `log_entries_per_agent` 200 (in memory) · `stale_after_min` 15 · `finished_visible_hours` 168 (v1.63.0; was 24; also the replay window) ·
`memory_budget_mb` 64 (over it, the oldest finished agents, then the oldest log entries, are evicted) ·
`progress_checkpoint_sec` 60 (10–3600, 0 = off) · v1.64.0: `abandoned_plan_days` 90 (1–3650; a gone session's open plans are
abandoned by the bridge after this long) · `finished_plan_open_min` 120 (0–10080; how long an ended plan stays expanded on
dashboards — sent with the board) · v1.68.0: `notice_batch_sec` 3 (0–60, 0 = no batching; dashboard-change notices to one
session within this long go as one message — #80) · `enabled` true. Test-only env: `AI_BRIDGE_ACTIVITY_CHECKPOINT_MS`,
`_FWD_MS`, `_LOAD_WAIT_MS`, `_GC_MS`, `_RETENTION_MS`, `_INDEX_MAX`, `_PHASE1_MS`; step 4 (env only, every host should
agree): `_GOSSIP_MS` (1000), `_SLICE_MAX_BYTES` (262144), `_PAGE_ENTRIES` (50), `_PAGE_BYTES` (32768), `_FETCH_RATE` (4/s),
`_REMOTE_MS` (4000), `_DOWN_HOLD_MS` (30000); v1.63.0: `_ROLLOVER_CHECK_MS` (30000, the day-rollover check);
`AI_BRIDGE_TEST_ACTIVITY_TAP=1` (`activity {tap:true}` returns the recent frames, the replay stats and the last
carry-forward), `AI_BRIDGE_TEST_HOSTNAME` (two loopback "hosts" on one machine) and `AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS`
(v1.63.0: shifts the activity clock — report times, day files, the window, the rollover) are for tests.

### Step 6c (v1.64.0) — the agent snippet, the connect reminders, and the plan / history / dashboard rules
**How sessions learn to use the board.** Agents never see reminders, so an orchestrator pastes a ready-made block into each
agent's prompt. Two new connect-reminder placeholders, expanded per session when the reminder is emitted (like
`{doorbell_cmd}`; `lib/log-snippet.js`):
- **`{log_snippet}`** — the ready-to-run `tools/aimb-log.mjs` command with this host's absolute node + script paths, the
  session's `--session` / `--project`, `--token-file "<path>"` when the bridge read its token from a file (#75), and a
  `--path <agent-path>` placeholder for the orchestrator to fill in; then six short lines:
  ```
  Report your status with: "<node>" "<…/src/tools/aimb-log.mjs>" --session "Orch" --project "AIMB" [--token-file "<path>"] --path <agent-path> --text "<text>"
  - --text "@ctx …" logs to a context; "@~ctx …" also sets its line; keep "@~root <what you're doing>" current.
  - Report at milestones only (every call costs tokens); a script reporting often adds --no-log.
  - Before a long silent step (a build, a test run) add --stale-after 60m so you don't show as stale.
  - --item "A" --item "B" creates ☐ plan items under --path, in that order (one name per --item).
  - Start item A: --path "<agent-path>/@~A" --state running --text "<what>"; when done: same --path + --done.
  - Finish with --text "@~root <summary>" --state done (or failed). Never put secrets in status text.
  ```
  (v1.66.0, #79: the lines as they read now — explicit `--text` and one `--item` per plan item, so no argument depends on its
  position, and the checklist kept live.)
- **`{log_tool_hint}`** — the same guidance for a session without a shell (Cowork), phrased for the `log` tool: `log({
  as:"<name>", secret, text })`, `path`, `log:false`, `stale_after:"60m"`, `plan:["A","B"]`, a tick with `path:"<path>/@~A",
  state:"done"`, the finish line, no secrets.

`config.example.json`'s realm block (`behaviors.realm`, published once at deploy time) keeps the doorbell reminder and
adds two connect reminders: `client:code` and `client:cowork` (v1.66.0's text is in "Briefing agents" below). Both
carry `"id":"activity"`: v1.64.0 lets a config default carry an optional `id` so several defaults share one
(operation, scope, match) — a ≤1.63 host ignores the id and keeps only the last one, so publish the block once every host
runs 1.64. The bridge's MCP server instructions now name the `log` / `activity` tools too.

**The abandoned state.** (v1.69.0, #82: now valid on ANY context, and it cascades — see "The plan workflow" below.) `abandoned` (greyed, a dashed glyph with a slash) is valid only for **plans and plan items**: a
plan item, or a plan node (a node holding plan items — a context, or an agent / the session, which it then finishes like
done / failed). Anything else → `not-a-plan`. The tool and the script set it explicitly (`--state abandoned`, 6d adds a
right-click). In "N of M done" an abandoned item counts as not done and stays in M (`progress.abandoned` counts them;
skipped items stay out of M, as before — kept, since they are a deliberate decision, and a plan with a skipped item now
simply stays open until it is marked complete).

**When a plan ENDS (supersedes 6b's "done or skipped ends a plan").** A plan does not end while any item is anything but
done — skipped, failed, idle, todo, running and blocked all keep it open, and its owner finishing no longer ends it. It ends
only when **every item is done** (at the last one's time) or when **its node is set `done` (complete) or `abandoned`**
(`plan_end_at` on the board). Knock-on effects: every node of an OPEN plan (its items, whatever their state, and their
ancestors) never expires and is never evicted; an ended plan expires `finished_visible_hours` after it ended and is
evictable; the carry-forward carries every item of an open plan; Active only hides ended plans.

**Auto-abandon.** A session that has been **gone for `abandoned_plan_days`** (default 90) — not on its host's roster and
quiet that long (its gone time, else its last message: a script-only session is never marked gone, and gone isn't kept
across restarts) — has its open plans abandoned by the gateway: each open item (todo / running / blocked) and then the plan
node itself get an `@~` line with state `abandoned` ("abandoned by the bridge — the session has been gone 90 days"),
logged and persisted as entries with **`by:"bridge"`** (shown "by bridge" in the log). They are SYSTEM messages: they
touch no activity, so the session doesn't look alive. The plans then expire a window later like any ended plan.

**Gossiped entry counts.** Every gossiped node carries its OWN logged-entry count (`log_n`: memory + what the cap dropped)
and `log_partial` when its run began before that host's replay window (the count then understates: older entries live
only in its day files). The board's node `log` is `{entries, dropped, total, partial?}` locally and `{remote:true, total,
partial?}` for another host's node, so a remote Log row says "N entries" too — the dashboard sums a subtree itself, and
shows "N+" when a count understates.

**Run-boundary history.** A node's history now stops at the start of its **current run** — the record that began this
instance of the node (`new_from` at or above it on its chain): the page answers `run_start:true` (no `next_cursor`) and,
when an earlier run of the same name left entries, `earlier_cursor`. "Show earlier runs" = `log:{…, cursor:earlier_cursor,
earlier:true}` (the dashboard draws an "— earlier runs —" separator and keeps `earlier:true` for the following pages).
When the run began in a day file that **retention already deleted** (e.g. a carried-forward node older than
`log_retention_days`), the files run out before the run's start and the page says **`pruned:true`** — "earlier history
pruned" on the dashboard, never a silent gap. Local and remote paging alike (the owner does the paging). A session's own
run spans its children's runs (a child's new run is no boundary for the session).

**The finished-plan window.** An ENDED plan stays **expanded** on the dashboard for `finished_plan_open_min` (per host,
default 120, sent with the board in `head`), then collapses out of the default view — it isn't removed (the 7-day window
still does that). A **"plans open"** slider beside "stale after" changes it live (0–8 h; not persisted, like the stale
slider; v1.65.0: 0 – 7 days). Open plans always render expanded by default (a plan node's own click still wins; Collapse all
closes them).

**Home-host tags.** A top-level node's host tag now compares with the session's **HOME host** — the host it first appeared
on: the earliest-created root across hosts, ties by host name (the board's `home`; `created_at` rides every gossip header
and, since format v4, every record as `s0`, so it survives restarts). The headline still comes from the host that most
recently set one, but the tags no longer flip with it.

**The Plans filter.** A "plans" checkbox beside "active only" shows only plan nodes, plan items and their ancestors (the
sessions and agents that hold them), across all sessions; with Active only too, only open plans. Remembered per browser.
**Rollups follow the filters:** with Active only or Plans on, a rolled-up bar (and a line's `{progress}`) counts only what
the filter shows — the dashboard recomputes it with the bridge's own rule; a reported bar is shown as reported. (6b's
session rollup still counted an ended plan Active only hid.)

**Dashboard details.** The Activity section is open by default. Pills now sit right after the name, so the bar column lines
up on every row. Every row carries its identity for 6d's right-click menu: `data-kind` (project / session / host-line /
node / log / entry), the node's ORIGIN `data-host` and `data-path`, `data-session` / `data-project` / `data-user`
(`data-nkind`, `data-plan-item`, `data-plan-node`, an entry's `data-id`); `window.AimbActView.rowInfo[data-k]` holds the
same object. (v1.65.0: the menu — "Step 6d" above.)

**Formats (v1.64.0).** Records + slices are **v4** (`abandoned`, `by`, `s0` on every record, `log_n` / `log_partial` on
gossip nodes); v2 and v3 records are still read; hubs declare `activity_gossip:4` (a 1.63 hub would misread `abandoned`,
so the two don't exchange activity). Deploy = restart every host's gateway on 1.64.0 together.

### Step 6d (v1.65.0) — dashboard actions, the log panel, pin / hide
**Finishing an agent never completes its plan.** An agent (or the session) whose own line goes `done` or `failed` finishes,
and the plan it holds stays exactly as it is: its open items stay open (they never expire, the carry-forward keeps them)
until someone resolves them. A plan ends only when **every item is done**, when a **context** plan node is set `done`
(complete) or `abandoned`, or — for a plan held by an agent or the session — through its **plan-end marker**, which only
the dashboard's *Mark plan complete* / *Abandon plan* set (and *Reopen plan* clears). The tool's `abandoned` state on an
agent keeps 6c's meaning: it finishes the agent **and** ends its plan (it sets the marker). The board's plan nodes now also
carry `plan_end_how`: `all-done`, `done` (marked complete) or `abandoned`.

**Right-click actions — the dashboard's first write path.** Right-click a row (or focus it and press the **Menu** key /
**Shift+F10**; on a touch screen, **long-press**) for a menu with only the actions valid for that row in its current state:

| On | Actions (wire name) |
|---|---|
| Plan item | Mark done (`done`) · Skip (`skip`) · Reopen, back to ☐ (`reopen`) · Abandon item (`abandon`) |
| Plan node (open) | Mark plan complete (`complete`) · Abandon plan… (`abandon_plan`) |
| Plan node (ended by complete / abandon) | Reopen plan (`reopen_plan`) — a plan that ended because every item is done reopens when an item does |
| Agent / session holding open plan items | Abandon open plan items… (`abandon_plan`: only its OPEN items — todo / running / blocked — of the plans it holds without crossing another agent; those plans end; the agent or session itself **keeps running**) |
| Agent / session that is stale or gone | Mark finished — done… / — failed… (`finish`, args `state`) |
| Agent / session that is stale, gone or finished | Dismiss from the board… (`dismiss`) — never when its subtree holds part of an open plan (`has-open-items`) |
| Any node / a session's own line (v1.70.0, a 1.70+ owner) | Edit text… (`edit_text`) · Message session… (`message`) — see "Edit a line, message the session" below (not on a question: its line is the question) |
| An OPEN question (v1.71.0, a 1.71+ owner) | Answer… (`answer`, args `{choice?, text?}`) · Withdraw question… (`withdraw`) — see "Questions" below; a click on the row opens Answer… too |
| Any node / session | Copy path (a session: Copy session name) · Copy its aimb-log command · Pin / Unpin · Hide / Unhide |
| A log entry (in the log panel) | Copy entry id · Copy path |

- *Abandon plan*, *Mark finished* and *Dismiss* ask first (a dialog saying what happens — how many open items, that the
  agent keeps running, that nothing is deleted — and how it will be logged; Cancel has the focus, Escape cancels).
- **Who and how:** the dashboard sends `{type:"activity_action", ref, host, session, project, user, path, action, args}`
  over its realm-token WS connection; only an authenticated **dashboard** socket is accepted (a page leaf, a logger or a
  socket without a hello gets `unauthorized`). `host` is the node's ORIGIN: that host's gateway applies it — the bridge the
  dashboard is attached to does it itself, or forwards it over the existing authenticated hub link as `ACTIVITY_ACT`
  (queued and rate-limited like a remote history fetch: `busy` / `owner-unreachable` / `owner-unsupported`), so each host
  still writes only its own nodes. The answer comes back as `{type:"activity_action", ref, result}`; the row shows a
  spinner (with "queued" while a forward waits), then **✓** or the error code inline (the explanation on hover).
- **Attribution:** every applied action is a logged entry on the node, attributed `by:{kind:"dashboard", user, host}` + `act`
  (the action), its text "marked done by robin via dashboard (ROBIN-Z790)" — user = the OS user of the bridge the dashboard
  is attached to (`AI_BRIDGE_USER` wins; else "dashboard"), host = that bridge's host (an owner takes it from the hub link,
  never from the frame). An item's own line keeps its text (only its state changes). These are SYSTEM entries: they never
  refresh an agent's activity or un-gone a session. They are persisted, gossiped and shown in the log like any entry.
- **Stale** for *finish* / *dismiss* means what the viewer's slider says (`args.stale_min`); an implicit agent (it never
  reported) counts as quiet when every reported agent below it is.
- **Dismiss is not deletion.** The node and its subtree (or, on a gone session, the whole session) leave the board now
  instead of after the 7-day window. A logged `dismiss:true` entry — shown in the PARENT's log — records it, and the restart
  replay honours it like an eviction (older records at or under that path are an ended run), so a dismissal survives a
  restart; a new report under the same name starts a new run. The day files are append-only: nothing is erased.
- **Codes:** `not-a-plan-item`, `no-change`, `not-a-plan`, `already-ended`, `not-ended`, `all-items-done`, `no-open-plan`,
  `not-an-agent`, `already-finished`, `not-stale`, `has-open-items`, `bad-action`, `bad-args`, `unknown-session`,
  `unknown-node`, `unknown-host`, `not-owner` (a forwarded frame naming another host), `unauthorized`, `busy`,
  `owner-unreachable`, `owner-unsupported`, `activity-loading`.
- The MCP tools get no new actions: a session already resolves its own items and plans with states (`@~…/@~B` + `done` /
  `skipped` / `todo` / `abandoned`; a context plan node `done` / `abandoned`). The dashboard is the manual override.
- **The session is told (v1.68.0, #80)** — see "Dashboard-change notices" below.
- **Copy its aimb-log command** builds the session's `{log_snippet}` command for the node's HOST: its absolute node + script
  paths, `--session` / `--project`, `--token-file "<path>"` when that bridge reads its token from a file — never a token —
  and `--path "<the node>"` (the board head now carries `log_cmd` for this host and each remote host, from its full slices).

**The log panel replaces the Log rows.** The tree has no "Log" rows any more. **Click** a session, agent or context row to
select it (highlighted); the **chevron** (or a double-click) expands it. The selected node's merged subtree log shows in a
**panel to the right of the tree** (below it on a narrow screen): its path, host and entry count, entries newest first
(time, a state dot, the `@ctx` / `@~ctx` tag relative to it, the text; details and JSON on click), "load older…", "start of
this run · show earlier runs…", "earlier history pruned". A multi-host session's panel switches between its hosts; another
host's log comes through the bridge's queued remote fetch (a spinner while it waits). The selection survives board deltas
(the panel re-reads its first page when new entries arrive), and clears when the node leaves the board; ↻ refreshes, ×
closes.

**Pin / Hide (this browser only).** *Pin* sorts a node (or a session) to the top of its parent, marked 📌. *Hide* collapses
it away; its parent shows "N hidden — show" (shown, a hidden row is greyed and the control says "hide N again"). Both are
undone from the same menu and kept in `localStorage` (`aimb.act.pins` / `aimb.act.hidden`; a private window just forgets).

**Keyboard and touch.** Rows are focusable (`role="treeitem"`; log entries `listitem`): ↑/↓ move, Home / End jump, Enter
selects, → / ← expand / collapse, the Menu key or Shift+F10 opens the menu (↑/↓ inside it, Enter runs an item, Escape
closes and gives the focus back). A long-press (≈0.5 s) opens the menu on a touch screen; the tap that ends it does not
select.

**Other dashboard changes.** An open plan now expands its **ancestors** by default too (a plan under a collapsed agent or
context is visible). The header and project counts **ignore the filters** (always the real totals; rolled-up bars still
follow them). The "plans open" slider spans **0 – 7 days** in steps (minutes → hours → days; the bridge's
`finished_plan_open_min` range is already 0–10080). The abandoned glyph has its own colour token, clearly visible in dark
mode. The page has a viewport meta tag, and the phone layout rules now actually apply (the bar and name widths of the
≤720 px block were overridden before).

**Entry counts stay exact.** The day-rollover carry-forward record now carries the node's own entry count (`log_n`, +
`log_partial` while it still understates), so a node whose run began before the replay window keeps its exact count after a
restart — no "N+" from that cause.

**Formats (v1.65.0).** Records + slices are **v5** (the plan-end marker on agents, `dismiss` entries, `line_text`, `act` and
an object `by`, the cf `log_n`); v2–v4 records are still read; hubs declare `activity_gossip:5`. Deploy = restart every
host's gateway on 1.65.0 together.

### Dashboard-change notices — the session is told (v1.68.0, #80)
A dashboard action used to be only LOGGED on the node, so an orchestrator could keep working on an item a person had just
skipped or abandoned. Now the gateway that **owns** the node (the one that applied it — another host's node is applied, and
notified, by that host) sends the node's session a **system message** after every state-changing action: `done`, `skip`,
`reopen`, `abandon`, `complete`, `abandon_plan`, `reopen_plan`, `finish`, `dismiss`. Copy, pin and hide never reach the
bridge (they live in the browser), and a refused action or a read sends nothing.

- **Message:** verb **`activity_changed`**, from the owning gateway. Subject (public — status paths are realm-visible
  anyway), e.g. `robin skipped @Dash test/@Docs`, `robin marked @Rplan/@R1 done`, `robin abandoned the open plans of lead`.
  Body:
  ```json
  { "action": "skip", "path": "@\"Dash test\"/@Docs", "host": "ROBIN-Z790", "from_state": "todo", "to_state": "skipped",
    "by": { "user": "robin", "host": "LITTLE-001" }, "entry_id": "act_…", "session": "Lead", "project": "ACTS",
    "text": "Docs", "ts": 1790948729303 }
  ```
  `host` = the owner, `by.host` = the dashboard's host; `entry_id` = the logged entry that did it (`activity {entry:{id}}`).
  For `complete` / `abandon_plan` / `reopen_plan`, `of:"plan"` and the two states are the PLAN's (`open`, `done`,
  `all-done`, `abandoned`); `abandon_plan` adds `items:[{path, from_state, to_state, entry_id}]` for the items it abandoned.
- **Batched:** actions on one session within **`activity.notice_batch_sec`** (default **3**, 0 – 60; 0 = each at once; env
  `AI_BRIDGE_ACTIVITY_NOTICE_BATCH_SEC`) become ONE message — each new one re-arms the window, at most 5 windows after the
  first. Subject e.g. `robin skipped 2 items and abandoned 1 in @Dash test`; body `{actions:[…the bodies above…], count,
  session, project, host}`. `POST /admin/prepare-shutdown` and a clean exit flush every queue first.
- **Recipient:** the session's registered sub-peer(s), anywhere on the mesh, matched by realm + project + user + session
  name, case-insensitively (else a live bare session of that name). None live → the message is **parked** for the session's
  durable registration in the owning host's store and delivered on its next `register_self`. A **script-only** session (no
  sub-peer ever registered) gets the log entry only. A live session's doorbell wakes as for any mail.
- **Consent:** it rides the system-message path #72's grant notices use (`system`, set only by bridge code for the
  session's own board) — nothing else is opened.
- **What the session does:** the server instructions and the `log` tool say it: summarise the change for the user and don't
  act on it (stop or redo work) without their permission.
- **For later notices (#83 edit text and #84 message the session — built in v1.70.0, below; #85 answers):** the gateway's one internal hook
  `notifyActivitySession(ident, {verb, subject, body}, {now})` (`bridge.mjs`) batches per session and delivers as above;
  `ACT_NOTICE_COMBINE[verb]` merges several notices of one verb (the default: `{notices:[…], count}`), `now:true` sends at
  once.
- **Compatibility:** no wire change (gossip and `ACTIVITY_ACT` are unchanged); a 1.65 / 1.66 host just sends no notices
  for its own nodes. Receivers of any version accept the message (a `system` envelope, as since 1.56).

### Three-part progress, colours and session glyphs (v1.66.0, #79)
**Progress has three parts: done, skipped, total** (+ the unit). *Skipped* is resolved without being done — neither done
nor remaining. Report it with `"3/6 1 skipped"` / `"4812/12000 tiles · 100 skipped"` or `{done, skipped, total, unit}`
(done + skipped > total clamps skipped, `progress-clamped`); it defaults to 0.
- **Rollups carry all three:** a common unit sums done, skipped and total; mixed units average each child's done fraction
  and skipped fraction (each child weighted 1); a plan's "N of M done" counts every item — done items are done, **skipped
  and abandoned** items are skipped (they won't be done), todo / in-progress / idle / **failed** items remain (failed may be
  retried).
- **A done node counts as 100% done** — a full bar, and its whole weight to its parent — whatever its reported or rolled-up
  bar says; an **abandoned** node's remainder counts as skipped; a failed node keeps its bar. Otherwise reported progress
  wins over a rollup, as before. The plan-end rule is unchanged (skipped items keep a plan open).
- **Text:** `{progress}` → "1 of 5 done · 1 skipped" ("4,812 of 12,000 tiles" when nothing is skipped), `{pct}` = the
  done %, `{skipped}`.
- **Dashboard bars:** done (blue; a plan's green), then the **skipped segment** (a grey hatch, light and dark), then the
  track; striped = a rollup; the tooltip reads "1 of 5 done · 2 skipped (20%) · incl. 1 abandoned — its plan: 5 items".
- **Colours:** green means **done** only. **In progress is cyan** everywhere — the running ring and dot, a context's running
  mark, the in-progress plan item, running log dots (one token, `--act-running`). Blocked stays orange, failed red, stale /
  gone / skipped / abandoned grey.
- **Session glyph:** a session row (and each host line of a multi-host session) shows a small rounded **window** instead of
  the agent ring — its border empties towards stale like the ring, its colour is its state, and its face says the client:
  code `>_`, cowork a speech bubble, a page a globe, anything else a plain window. The Sessions table and the mesh map use
  the same glyph. The bridge takes the client kind from the mesh roster (`client_kind` on the dashboard's session units).
- **Compatibility:** `skipped` is an optional field (only when > 0) on progress in records, carry-forwards and gossip; a
  1.65 host ignores it (and shows no skipped segment), a 1.66 host reads a missing one as 0. The format stays v5, so hosts
  can upgrade one at a time.

### Briefing agents (v1.66.0; wording revised 2026-10-03)
An orchestrating session keeps its agents' work visible, and its plan truthful:
- Each piece of work is a **plan item**; an agent sits **under the item it serves**: paste `{log_snippet}` (the code
  reminder hands it out) into its prompt with `--path "<plan item>/<agent>"` (e.g. `--path "@Next release/@#81 tests/agent-81"`),
  and give it its checklist up front (or tell it to make one with `--item "A" --item "B"` as its first report).
- The agent keeps its checklist live: `--path "<agent>/@~<item>" --state running --text "<what>"` when it starts an item,
  a new `--text` at each sub-step, `--done` the moment it's done, `--text "@~root <what it's doing>"` current, and it
  finishes with `--text "@~root <summary>" --state done` (or `failed`).
- The orchestrator ticks the plan item **after checking the agent's work** (an agent finishing doesn't tick it), keeps its
  own `@~root` current, **adds unplanned work as a plan item first**, and **reopens** an item (`--state running`) when work
  on it resumes.

The realm reminders (`config.example.json`, `behaviors.realm`) say this within the 365-char reminder cap. They avoid the
v1.66 flags (`--text` / `--item`) in their own text, because a 1.65 host's script lacks them; `{log_snippet}` is expanded
by each host from its own script, so it can use them:
- `client:code`: "When you spawn agents, paste this into each prompt with --path "<plan item>/<agent>" (it sits under the
  item it serves; you tick the item after checking its work) and a checklist: {log_snippet} Keep your board true with the
  log tool: "@~root <what you are doing>" current; unplanned work added as an item first; an item reopened (state running)
  when work resumes."
- `client:cowork`: "Show what you are working on on the activity board: {log_tool_hint} Handing work to agents? Give each
  a path under the plan item it serves ("<item>/<agent>") and a checklist; it ticks items and ends with "@~root
  <summary>", state:"done". Keep your plan true: add unplanned work as an item first; reopen an item (state:"running")
  when work resumes."

### The plan workflow — order, insert anywhere, move, abandon anything (v1.69.0, #82)
**Order.** Siblings show **plan items first** (in their plan order), **then the other contexts, then agents**; a state
change never moves a row. Each node's position is a **fractional rank** — a base-36 string (`0-9a-z`, compared as text,
never ending in `0`), so there is always room between two ranks and a reorder writes **one** record; nothing is
renumbered. Most nodes never store a rank: a node without one has its **derived** rank — its creation time (9 base-36
digits of the ms) + its plan position (2 digits) + `i` — so the default is creation order, exactly as before, and a node
created later always sorts after the existing ones. A node gets a **stored** rank only when it is placed (inserted at a
position, reordered, moved), computed between its neighbours' ranks (an open end is bounded by the next millisecond's
derived rank, so later nodes still go after it). The `activity` board gives every node its `rank` (+ `rank_set` when
stored); gossip carries stored ranks only; checkpoints and carry-forwards persist them.

**Insert anywhere** (Robin: "an agent should be able to insert steps into a plan at any position"):
```bash
aimb-log … --path "@Next release" --item "Review" --before "Docs"   # or --after "Build" / --first / --last (default: the end)
aimb-log … --path "@Next release" --item "A" --item "B" --after "Spec"   # several keep their order at that spot
```
The tool: `log {path:"@Next release", plan:["Review"], before:"Docs"}` (`after`, `position:"first"|"last"`). An anchor is a
sibling: `"Docs"` / `"@Docs"` = a context, a bare name = an agent of that name first. Re-sending existing names never moves
them (`position-unused`). Errors: `unknown-anchor`, `bad-anchor` (an anchor of another kind — plan items, contexts and
agents are placed among their own kind), `bad-position` (two positions, or before itself).

**Reorder** an existing node with the same flags and no text: `--path "@Next release/@~Docs" --after "Ship"` (tool:
`{path:"@Next release/@~Docs", after:"Ship"}`) — one logged entry "placed after @Ship" carrying the rank; the line is
untouched. With text / a state it is a normal message that also places the node.

**Move** a node and everything under it to another parent in the same session (each host writes only its own nodes):
```bash
aimb-log … --move "@Next release/@Telemetry" --to "@Potential changes" [--first | --before "X" | …]
```
The tool: `{move:"@Next release/@Telemetry", to:"@Potential changes"}`. Both paths are relative to `--path` / `path` (a
leading `/` = from the session root; `--to "/"` = the root). The node keeps its line, state, bar, plan-item marker,
created_at, log and count; it goes to the **end of its kind** under the new parent unless placed (a plan item at the end of
the target plan); a new parent path is created (implicit). One logged entry at the NEW path: `moved by <session | user via
dashboard (host)> from @Next release/@Telemetry to @Potential changes`, with `moved_from` and `rank` on the record. The
result: `moved:{from, to, parent}`. Errors: `unknown-node`, `no-change` (already there — with a position it is a reorder),
`target-exists`, `bad-move` (into itself, the root, text / state / plan with a move), `path-too-deep`. **History follows the
node:** in memory its log moves with it; a restart's replay maps every older record under the old path onto the new one
(node by node, so an OLD parent keeps the activity those records gave it); the node remembers `moved:[{from, at}]` (carried
forward past the replay window), so its log pages on into the day files under the old path(s) — shown at its path now —
and its count includes them. The new parent's merged log shows the moved-in node's newer entries; its older ones (written
before the new parent began) come with "show earlier runs".

**Abandon anything.** `abandoned` is valid on **any context** (not only plans and plan items); an agent or the session
keeps its rule (only when it holds plan items — it finishes and its plan ends). Abandoning **cascades**: every open context
or plan item under it (todo / running / blocked, or a context whose plan is still open — not inside another agent: an
agent's work is its own) gets an abandoned line too, deepest first, logged `abandoned with <path>` (+ the dashboard's
attribution); the result lists them in `cascade:[{path, from_state}]`. Done / skipped / idle / failed nodes and agents keep
theirs. The dashboard greys the abandoned node **and everything under it**.

**Agents on the item they work on.** A plan item with agent children shows the **working agent** (the most recently active
one still running, else the latest) beside its box — its glyph, its name and its current line — even while the item is
closed. Ticking stays explicit: an agent finishing doesn't tick the item.

**Dashboard.** Right-click a node → **Move up / Move down** (among its own kind; a reorder), **Move to…** (a picker of every
node of the session on that host it may go under — not into itself, not its current parent, not past the depth limit,
no name clash — then a confirm), **Abandon…** on an ordinary context (confirmed; it cascades). **Drag and drop:** drop a row
on a sibling of its kind to put it before (upper half) / after (lower half) it, or on another node to move it there (asked
first). They go through the 6d action path (`activity_action` → the owner, forwarded as `ACTIVITY_ACT` for another host's
node), are attributed and logged like the other actions, and tell the session (#80): `robin moved @Next release/@Y before
@X`, `robin moved @Next release/@B to @Later` (body `where` / `moved_from` + `to`; a batch "robin moved 1 node and
reordered 1 in …"). New wire actions: `move` (`args.to`, + `before` / `after` / `position`) and `reorder` (`args.before |
after | position`).

**Compatibility (1.66 – 1.68 hosts).** The format stays **v5**: `rank` on a gossip node, `rank` / `moved_from` / `moved`
on records are optional fields a 1.68 host ignores (its board orders by creation; a move reaches it as an ordinary
removal + new node). A 1.69 hub declares `activity_plan:1` in PEER_HELLO; a 1.69 gateway forwards move / reorder only to an
owner that declared it (else `owner-unsupported`), and its dashboard offers them only for such hosts (`remote_hosts[].plan`).
A 1.69 follower refuses (`gateway-unsupported`) a `log` using move / to / before / after / position when its gateway is
older (it would drop the fields silently), and so does the 1.69 script. Downgrading a host to ≤1.68 after a move is not
supported: its replay would rebuild the moved node at both paths.

### Edit a line, message the session — from the dashboard (v1.70.0, #83 / #84)
Two more right-click items on **any node** — a context, a plan item, an agent, or a session's own line (a multi-host
session: each host's line, not the session row):

| Menu item | Wire action | What the owning host does | The session is told |
|---|---|---|---|
| **Edit text…** | `edit_text`, args `{text, state?}` | sets the node's **current line** (and optionally its state) for its session | `activity_text_edited`, batched |
| **Message session…** | `message`, args `{text}` | **logs** the message on the node and delivers it to the session | `activity_message`, at once |

Both travel the 6d action path (`activity_action` → the node's owner; another host's node is forwarded as `ACTIVITY_ACT`),
are SYSTEM entries attributed to the viewer (`by:{kind:"dashboard", user, host}` + `act`; they never refresh an agent's
activity), and reach the session through #80's notice hook.

**Edit text… (#83).** A dialog prefilled with the node's RAW line (`{progress}`, `{pct}`, `{eta}` … stay placeholders and
still render), a state picker — "keep <state>" or one of the states that node can take (a plan item: any; another context:
all but `todo` / `skipped`; an agent / the session: `running` · `blocked` · `failed` · `done` · `idle`, + `abandoned` only
while it holds plan items) — a live "N / 240" counter, and Save (disabled with a reason: empty, too long, nothing changed;
Enter saves, Escape cancels).
- The same limits as a report: 240 characters (the bridge truncates a longer one with `text-truncated`, as for a report),
  newlines become spaces, and the text is taken **literally** (a leading `@Docs` is text, not a path). No state → the line
  keeps its state (an edit doesn't start a ☐ item). Only the text and state change: the line keeps its details and data.
- **Attribution:** the line remembers who wrote it — `current.by = {user, host}` on the board (a raw / rendered line, the
  `activity` tool, gossip, checkpoints, the carry-forward and the restart replay all carry it; the record field is
  `line_by`). The dashboard shows a small **✎** right after the text (hover: "Edited by robin via dashboard (HOST) — its
  session's next report replaces it"). The logged entry reads `Docs: README first (edited by robin via dashboard (ROBIN-Z790))`
  (`act:"edit_text"`; the record's `line_text` keeps the line alone).
- **The session's next report** replaces the line and its ✎ as usual; a tick that keeps the text (`@~…/@~Docs` + a state)
  keeps the attribution — the text is still the viewer's.
- Codes: `bad-args` (no text), `bad-state` (a state that node can't take), `no-change` (the same text and state), + the 6d ones.
- **Notice:** verb `activity_text_edited`, batched with the session's other notices (`notice_batch_sec`). Subject e.g.
  `robin edited @Rel/@Docs (todo → running)` (no arrow without a state change); body
  ```json
  { "action": "edit_text", "path": "@Rel/@Docs", "host": "ROBIN-Z790", "from_state": "todo", "to_state": "running",
    "by": { "user": "robin", "host": "LITTLE-001" }, "entry_id": "act_…", "session": "Lead", "project": "AIMB",
    "text": "Docs: README first {progress}", "from_text": "Docs", "ts": 1790956444869 }
  ```
  Several edits in one window merge into ONE message (`ACT_NOTICE_COMBINE.activity_text_edited`): `robin edited 2 lines in
  @Rel`, body `{actions:[…], count, session, project, host}`.

**Message session… (#84).** A text box (up to **2000** characters; newlines kept; a live counter; Ctrl+Enter sends) titled
"Message <session> about <path>".
- The owner **logs** it on the node: `robin via dashboard: <the first 120 characters on one line>…` (`act:"message"`, not
  a current line — the node's line is untouched), the full text in the entry's `details` (cut to 4 KB only for a very long
  non-ASCII message; the delivered body always has all of it).
- It **delivers** it at once (`now:true` — not held for the batch window), verb `activity_message`. The **subject is public
  (not encrypted)**, so it names only who, the node's path and a few words (≤ 6 words / 40 characters): `robin about
  @Rel/@Code: Please also cover the empty-plan case…`. The **body** (encrypted like any body) carries the text:
  ```json
  { "action": "message", "path": "@Rel/@Code", "host": "ROBIN-Z790", "text": "Please also cover the empty-plan case.\nAnd say what the default is.",
    "by": { "user": "robin", "host": "ROBIN-Z790" }, "entry_id": "act_…", "session": "Lead", "project": "AIMB", "ts": 1790956445112 }
  ```
- **Delivery** is #80's: the session's live sub-peers mesh-wide, else **parked** for its registration on the owning host,
  else nothing. The action's result says which — `delivered:true, delivery:"live" | "parked"`, or for a **script-only**
  session `delivered:false, delivery:"none"`, warning `not-delivered`, `what: "not delivered: the session has no inbox (a
  script-only session) — the message is logged on the node"`. The dashboard shows "✓ sent" + "Message sent to Lead" (or
  "parked for Lead (offline)…"), and for none an amber "⚠ logged · not delivered: the session has no inbox" + a toast.
- Codes: `bad-args` (empty), `message-too-long` (over 2000 characters), + the 6d ones. The log panel marks a message entry
  💬 (its details hold the full text) and an edit entry ✎.

**Trust.** Both verbs are a REQUEST relayed from a dashboard viewer, not authorization: the server instructions and the
`log` tool's description say so next to #80's `activity_changed` sentence — summarise it for your user and act on it only
with their permission. (Anyone holding the realm token can open a dashboard — #70 "Questions after 6d".)

**Compatibility (1.66 – 1.69 hosts).** The format stays **v5**: `line_by` on records / a cp's or cf's line and `by` on a
gossiped line are optional fields a 1.69 host ignores (it shows the edited text without the ✎; its replay keeps the text).
A 1.70 hub declares **`activity_msg:1`** in PEER_HELLO; a 1.70 gateway forwards `edit_text` / `message` only to an owner
that declared it (else `owner-unsupported`, "… runs a bridge older than 1.70.0 …"), and its dashboard offers the two items
only for such hosts (`remote_hosts[].msg`; this gateway's own nodes always). An older host's dashboard keeps its own menu
and its actions on a 1.70 node work as before. `AI_BRIDGE_TEST_NO_ACTIVITY_MSG=1` (tests only) makes a hub leave the flag
out, to stand in for a 1.69 owner.

### Questions — ask, answer from the dashboard, wait for the answer (v1.71.0, #85)
A session or one of its agents asks the person watching the dashboard a QUESTION, and gets the answer back — as a message,
or by waiting for it in a script.

```bash
# an agent (a script): ask, then WAIT for the answer on the same connection (≤ 24h)
node "<abs>/src/tools/aimb-log.mjs" --session Bridget --project AIMB --path "@Next release/@#85/ask-85" \
     --ask "Postgres or SQLite for the cache?" --choice "Postgres" --choice "SQLite" --free --expires 2h --wait 30m
# → {"ok":true,"outcome":"answered","path":"…/ask-85/@?1","question":"Postgres or SQLite for the cache?","choices":["Postgres","SQLite"],
#    "free":true,"answer":{"choice":"SQLite","text":"smaller to ship"},"by":{"user":"robin","host":"ROBIN-Z790"},"at":…,"waited_ms":41250,
#    "asked":{"id":"act_…","path":"…/ask-85/@?1"}}          exit 0
# wait for an existing question (default 30m):   --wait-answer --path "…/ask-85/@?1" [--wait 30m]
# withdraw your own question:                     --path "…/ask-85/@?1" --state withdrawn [--text "decided myself"]
```
The tool form: `log({ as, secret, path:"ask-85", ask:"Postgres or SQLite?", choices:["Postgres","SQLite"], free?, expires?,
details?, data? })` — it returns AT ONCE with the question's `path` and `question:{status:"asked", …}`; the answer arrives as
an `activity_answer` message.

**The model.** A question is a **context whose current line carries `question`** — `{status, choices, free, asked_at,
expires_at?, answer?{choice?, text?}, by?, at?}`; the line's text IS the question. Asked on a context that is new, has no line
and no children (and isn't a plan item), or is already a question, THAT node becomes it (`--path "lead/@db" --ask …` →
`lead/@db`); asked anywhere else — an agent, the session, a context with a line or children, a plan item — it becomes a new
child `@?1`, `@?2` … (`--path ask-85` → `ask-85/@?1`). The result's `path` names it. Questions ride the line everywhere the
line goes (records, checkpoints, the carry-forward, gossip, the restart replay), so they need no new record or slice format.

| Status | How | The line's state (what a ≤1.70 host shows) | In "N of M done" |
|---|---|---|---|
| `asked` (awaiting an answer) | `ask` | `blocked` | remaining |
| `answered` | the dashboard's `answer` (a choice and / or free text, attributed) | `done` | done |
| `expired` | `expires` ran out — the bridge closes it (`by:"bridge"`, "expired — nobody answered within 2h") | `abandoned` | skipped |
| `withdrawn` | the asker's `state:"withdrawn"`, the dashboard's `withdraw`, or any abandon of it (an ancestor's cascade, Abandon plan, a ≤1.70 dashboard's Abandon…) | `abandoned` | skipped |

- **Limits:** the question ≤ 240 characters (refused `question-too-long`, never cut — put background in `details`); ≤ 8
  choices, each ≤ 60 characters, distinct (`bad-choices`); free text allowed by default only without choices (`free:true` /
  `--free` allows both); a free-text answer ≤ 1000 characters (`answer-too-long`); `expires` > 0 and ≤ 7 days (`bad-expires`).
  `ask` takes no `text` / `state` / bar / plan / position, and is always logged (`bad-ask`).
- **Rollup:** a question counts as an ITEM in "N of M done" — of its parent, and of the plan above it when its parent holds
  plan items (an open question keeps that plan open; answered counts as done). A plain report can't overwrite a question's
  line (`question-node`); a log-only message to it (no `@~`) is fine. Asking again on a closed question starts a new one
  there; on an open one → `question-open` (withdraw it first).
- **Answering (the dashboard).** A question shows a speech-bubble **"?"** (fuchsia while open, green ✓ answered, greyed
  expired / withdrawn), an "awaiting answer" pill and a tinted row; an answered one shows its answer after the question
  ("→ SQLite — smaller to ship"). **Click an open question** (or right-click → **Answer…**) for the dialog: the question, its
  choices as buttons (a radio group), a text box when free text is allowed, Answer disabled until something is picked / typed.
  **Withdraw question…** asks first. Neither offers Edit text… or Abandon… on a question.
- **The owner applies it** (the 6d path, `ACTIVITY_ACT` for another host's node): an entry `answered by robin via dashboard
  (ROBIN-Z790): SQLite — smaller to ship` (`act:"answer"`), the line → done with the answer on it, then (1) every script
  WAITING on it is released and (2) the session is told AT ONCE (`now:true`), verb **`activity_answer`**:
  subject (PUBLIC) `robin answered @Next release/@#85/ask-85/@?1: Postgres or SQLite for the cache?` — who, the path and the
  question's first words, **never the answer**; body (encrypted):
  ```json
  { "action": "answer", "status": "answered", "path": "…/ask-85/@?1", "host": "ROBIN-Z790", "question": "Postgres or SQLite for the cache?",
    "choices": ["Postgres", "SQLite"], "free": true, "answer": { "choice": "SQLite", "text": "smaller to ship" },
    "by": { "user": "robin", "host": "ROBIN-Z790" }, "entry_id": "act_…", "session": "Bridget", "project": "AIMB",
    "agent": "@Next release/@#85/ask-85", "asked_at": 1790958497365, "ts": 1790958498854 }
  ```
  `agent` = the asking agent's path (null = the session itself): an AGENT's question goes to its SESSION — the orchestrator
  relays it (a subagent usually has no inbox; it waits with `--wait` instead). A withdrawal from the dashboard sends the
  same verb (`robin withdrew …`, status `withdrawn`), an expiry too (`question expired …`, `by:"bridge"`). The action's result
  says `released` (waiting scripts) and `delivery` (live / parked / none); "not delivered" is warned only when nobody got it.
- **Waiting (`--wait`, `--wait-answer`).** The script sends `{type:"wait_answer", ref, path, timeout_ms}` on its logger
  connection — a long poll on the gateway (no board polling) — and gets ONE `{type:"answer", ref, result}` when the question
  closes or the time runs out. A dropped link is re-dialled and the wait resumed. **Exit codes: 0 answered · 10 the wait ran
  out (the question stays open) · 11 expired · 12 withdrawn · 13 gone** (it left the board, e.g. its agent was dismissed) ·
  4 / 64 as always (`not-a-question`, `gateway-unsupported` … / usage).
- **Attention badge.** A collapsed row with open questions below it shows **"? N"**; the session and project rows always show
  their count, and the section header says "? N open questions". Rows keep their order.

**Trust.** An `activity_answer` is the dashboard viewer's answer to a question the session ITSELF asked: the server
instructions and the `log` tool say the session may proceed on it within what its user already approved (it doesn't widen
that; expired / withdrawn = no answer).

**Compatibility (1.66 – 1.70 hosts).** The format stays **v5**: `question` is an optional field on a line (records, cp / cf,
gossip) that a 1.70 host drops — it shows an open question as an ordinary **blocked** context whose text is the question, an
answered one as done, a closed one as abandoned. A 1.71 hub declares **`activity_ask:1`** in PEER_HELLO; a 1.71 gateway
forwards `answer` / `withdraw` only to an owner that declared it (else `owner-unsupported`, "… older than 1.71.0 …"), and its
dashboard offers Answer… / Withdraw only for such hosts (`remote_hosts[].ask`). A 1.70 dashboard's Abandon… on a 1.71 question
withdraws it. A 1.71 follower or script refuses `ask` / `choices` / `free` / `expires` / `state withdrawn` / `--wait` against a
≤1.70 gateway (`gateway-unsupported`; it would drop them). `AI_BRIDGE_TEST_NO_ACTIVITY_ASK=1` (tests only) leaves the flag out.

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

### The Activity page (v1.61.0, step 5; the node tree v1.62.0, step 6a)
The dashboard's **Activity** section is the mesh board as a tree: **project → session → its node tree (agents and
contexts, to any depth) → log entry**. (v1.65.0: logs moved out of the tree into the **log panel**, and rows got a
right-click menu — see "Step 6d" above; the "Log" rows described below are gone.)
- **Projects** show their counts (sessions · active agents — reported, unfinished agents). Clicking a project heading
  cycles **sessions + top-level nodes → sessions only → collapsed**; the **Projects / Sessions / Nodes** control sets
  every project at once (v1.62.0: "Nodes" — formerly "Agents" — means *expand down to each session's top-level nodes*).
  The default view shows every session with its top-level nodes' current lines; deeper nodes and logs start closed.
- **Every node expands on its own:** open it for its **Log** (the merged log of its subtree, "N entries, this node and
  below", each entry tagged with its path relative to the node — `@~root`, `@Tharsis/@~z12`, `research/@~root`) and
  then its children, one level (16 px) deeper — readable down to depth 6. Children are listed in creation order.
- **Agents** keep the status **ring** glyph and their name (monospace). **Contexts** (`@name`, in the info colour)
  show a smaller **state mark** without a ring — they have no staleness of their own: a context under a stale agent
  greys out with a stale pill, and its tooltip names the agent it follows. A node with no line of its own (an implicit
  grouping node) shows a hollow mark and "no current line".
- **A session row:** its name, a **host tag** per host (a session on several hosts is ONE row; its headline is the most
  recently active host's; its agents are tagged by host), the `@root` line with its placeholders filled, the status
  glyph (v1.66.0: the SESSION glyph, a window — see "Three-part progress, colours and session glyphs"), the progress bar, ⌛ when there is an ETA, 🔔 when a doorbell is armed for it, and pills.
- **A node row:** the glyph / mark, its name, a host tag when the session spans hosts, its line with the placeholders
  filled, the bar (striped = a rollup of what is below it), ⌛, pills. The **Log** pages newest first (time, a state dot,
  the relative tag, the text; "load older…" at the end pages on). An entry with details / data expands into the text and
  the pretty-printed JSON. A session row's Log is the whole session's (one per host).
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

**Data path — deltas, not boards.** The section is **open by default** (v1.64.0; it was collapsed before — your own
open / closed choice is remembered per browser), and a dashboard subscribes only while it is open and the browser tab is
visible — one that closes it costs the bridge nothing:
- `{type:"activity_sub"}` → `{type:"activity_board", full:true, epoch, seq:1, head, upsert:[…]}`: every **unit** — one
  per session group (header, `self` / `selves`, `bell`, `hosts_down`) and one per **node** (v1.62.0: `kind:"node"`,
  `nkind` agent | context, `path`, `key`, `parent_key`, `depth`, its own `progress` and the rolled-up `bar`) — in the **raw** form: the
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

`--session <name> --project <P> [--user U] [--agent a/b] [--path "a/@Ctx"] [--ctx "@~Ctx"] [--state S | --done] [--progress 4812/12000:tiles]
[--eta 1h25m] [--stale-after 60m] [--details "..."] [--data '{...}' | --data-file f.json] [--no-log] [--text "<text>"] [--item "A" --item "B" …]
[--before "Y" | --after "Y" | --first | --last] [--move "<node>" --to "<new parent>"]` — the
`log` tool's fields as flags (v1.62.0: `--path` addresses any node — `--path "@#70/@step4/spec-70"`, `--path
"spec-70/@~Tharsis"` — and combines with `--agent` / `--ctx` / a text prefix exactly as the tool's fields do).
**`--plan "A" "B" …`** (v1.63.0) creates ☐ plan items under the node `--path` / `--agent` names, in that order — every
argument after `--plan` up to the next `--flag` is a name, so put text BEFORE `--plan` (or after `--`): `--path "@~#70"
"the 6b plan" --plan Spec Build Test`. v1.66.0 (#79): a `--plan` name that looks like status text (`@~…` or "@ctx
words") is refused locally with `bad-plan`: `"@~root headline" looks like
status text — put text before --plan`. **v1.66.0 (#79, the call signature):** `--text "<text>"` names the text explicitly and
`--item "A"` adds ONE plan item per flag (repeatable, in command-line order, mixable with `--plan`), so no argument's meaning
depends on where it sits: `--path "@~#70" --text "the 6b plan" --item Spec --item Build --item Test`. Positional text and
`--plan "A" "B"` still work (1.65 snippets use them); `--text` plus positional text is refused, and an `--item` that looks
like status text is `bad-plan` ("pass text with --text"). Programs keep using JSON via `--batch` / `--stream`. **`--done`** = `--state done`, and a tick needs no text: `--path "@#70/@~Build"
--done`. **v1.69.0 (#82):** `--before "Y"` / `--after "Y"` / `--first` / `--last` place new `--item`s there (else they
REORDER the `--path` node: `--path "@Plan/@~X" --before "Y"`), and `--move "<node>" --to "<new parent>"` re-parents a
node with its subtree (relative to `--path`; see "The plan workflow" above). Against a ≤1.68 gateway these flags are
refused with `gateway-unsupported` (exit 4) — that gateway would ignore them. **v1.71.0 (#85):** `--ask "<question>"
[--choice "A" --choice "B" …] [--free] [--expires 2h] [--wait 30m]` posts a question (ONE choice per `--choice`, repeatable,
like `--item` — a value that looks like status text or is a flag is refused; `--wait` waits for the answer), `--wait-answer --path <question> [--wait 30m]` waits for an existing
one, `--state withdrawn` withdraws yours — see "Questions" above (exit codes 0 / 10 / 11 / 12 / 13 for a wait). **`--batch <items.json|->`** (v1.62.0) sends a JSON array of items (the tool's item fields + `ref`; ≤64, ≤64 KB) in ONE
call — `--agent` / `--path` / `--ctx` / `--no-log` are the defaults (v1.63.0: an item's own path is relative to them; a
leading `/` = absolute) — and prints ONE line `{ok, results, applied,
failed}`: exit 0 when every item applied, 4 when the bridge refused the call or any item failed, 64 for a bad file or
the bounds. The text is the positional argument (several words are joined; anything after `--` is
text); it is optional when `--progress`/`--eta` is given (default `"{progress}"` / `"{eta}"`). `--ctx` sets the context
(the text is then literal), `--no-log` = `log:false`, `--data-file` may start with a BOM. The report is validated
locally with the bridge's own parser first, so a bad one costs no connection.
- **Output:** ONE JSON line on stdout — the `log` tool's result (`{ok, id, ts, session, agent, context, current, state,
  stale_at, logged}`), or `{ok:false, code, what}`. Usage text goes to stderr.
- **Exit codes** (doorbell conventions): **0** ok · **4** the bridge said no or the transport failed (`link-error` = no
  bridge, `unauthorized`, `session-user-mismatch`, `gateway-unsupported` = a pre-1.59 gateway, `timeout`, …) · **64**
  bad usage (a missing `--session`/`--project`, an unknown flag, bad `--data` JSON, a report the bridge would reject
  such as `bad-state` / `bad-text`, `token-in-argv`, `no-token`). v1.71.0 (#85) — a wait (`--wait` / `--wait-answer`):
  **0** answered · **10** the wait ran out (still open) · **11** expired · **12** withdrawn · **13** gone.
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
- **Token / port:** like the doorbell — v1.64.0 (#75): **`--token-file <path>`** (a bare token or a `KEY=VALUE` env file,
  `~` expanded) is AUTHORITATIVE when given (an unreadable or empty one is exit 64, `no-token`, naming the file — never a
  silent fallback); else `AI_BRIDGE_TOKEN` / `AI_BRIDGE_TOKEN_FILE`, else the bridge's `config.json` found relative to the
  **script** (`../config.json`; `AI_BRIDGE_CONFIG` names another); and
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

- A line carries the `log` tool's fields minus auth (`path agent text context state progress eta stale_after details data
  log`, + an optional `ref`, echoed back) — or (v1.62.0) a JSON **array** of them: a batch, answered by ONE result line
  `{line, ok, results, applied, failed}`. The command line's identity applies to every line; `--agent`, `--path`, `--ctx`
  and `--no-log` are defaults a line may override (a line naming its own `path` / `agent` takes none of the address
  defaults; one with only a `context` keeps `--agent` / `--path`). Any other field (e.g. `session`) → that line gets `bad-field`; bad JSON
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
`{type:"log", ref, input:{…log fields}}` → `{type:"logged", ref, result}` per report (v1.62.0: `input:{items:[…], …defaults}` is a batch → `result:{ok, results, applied, failed}`). A logger socket is **not** a page
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
