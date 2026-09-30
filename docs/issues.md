# Open issues / planned work

Resume-ready register of open work. Built items live in `architecture.md` §13 (the version history /
changelog). This file is the *forward* list. Newest/highest priority first. Issue numbers continue the
project's `#NN` sequence.

---

## RESUME STATE (updated 2026-09-30, v1.43.0) — read this first after a compact
**Current version: v1.43.0.** All work committed to `main` (v1.42.0 + v1.43.0 committed locally, not yet pushed).
Everything below is durable; nothing important is only in chat.

**2026-09-30 (v1.43.0):** Shipped **#67**. The doorbell now chimes at the top of each hour by default
(`reason:"hourly"`, display the time, then re-arm). Connect reminders and the code-session `set_wake` hint now carry
a ready-to-run `{doorbell_cmd}` with this host's absolute node + script paths. Rollout: the connect default only
takes effect once a host runs 1.43.0 AND its config carries the connect entry. Live config was not edited.

**2026-09-30 (v1.42.0):** Fixed **#61** — a cross-host `send_to_peer` now reports the receiver's real outcome
(`project-denied` → `ok:false`; dead-letter → `ok:true, dead_lettered:true`) instead of a blanket `ok:true`. Hosts
must run 1.42.0 on both ends to see refusals; roll it out so #62-style drops stop failing silently.

**2026-09-29 (v1.41.0):** Shipped **#64** — connect reminders (new `connect` operation + `client` scope, so a
standing reminder can be pinned to register and filtered by client kind; the shipped default tells `code` sessions
to use the doorbell), `claim_topic` defaults flipped to **exclusive+announce_offline+persistent all true**, and
`set_wake` now returns a **session-type-resolved** unsupported message (code → doorbell fallback; else → none).
The bridge restarted at some point over the ~2 months since the snapshot below — on reconnect the queue epoch had
reset and Bridget's `Bridge` claim had NOT rehydrated (re-claimed it). **The mesh snapshot below is from
2026-07-25 and is almost certainly stale — re-run `list_sessions` before trusting host/port details.** Rollout
note for #64: the `connect` default belongs in a host's config only AFTER it runs 1.41.0 (on 1.40.0 an unknown
`connect`/`client` folds to a `receive`/`all` reminder), so the live/shared config was intentionally NOT edited.

**Live mesh (SNAPSHOT 2026-07-25 — STALE, re-verify):** every host was on **v1.39.0 gateways** —
- ROBIN-Z790 (this machine) — port **12317**, gateway is the Task Tray bridge; my session (Bridget) is a follower.
- LITTLE-001 — **12317** (migrated; reads the shared Dropbox config, no local edit needed).
- Robins-Mac — still on **7000** (version-migrated, not yet PORT-migrated); owns topic `mac`; runs MacDaddy.
- phub-lnx-01, phub-lnx-02 — v1.39.0 gateways, still on **7000** (bare gateways, no sub-peers).

So: **all v1.39.0; port-flip still pending on Mac + both Linux boxes** (7000 → 12317). Dual-port keeps the mixed
realm federated. Once every host shows 12317 on the dashboard Bridge column, do #59 (rip out compat ports).

**"Mac never receives Bridget's messages" — real cause is #62 (cross-project consent), NOT #60.** The Mac is
now fully migrated (v1.40.0 / 12317 / bind 0.0.0.0). The actual block: `deliveryAllowed` is receiver-side +
directional and the Mac's bridge lacks an `AIMB→PowerHub` grant (ROBIN/LITTLE have it via shared Dropbox
persistence; the Mac, a separate machine, doesn't). So AIMB (Bridget) → PowerHub (MacDaddy/Mac-2) is
`project-denied` and dropped — while **#61** makes the sender see `ok:true`, which masked it and sent me chasing
#60/ports for an hour. #60 was a real latent bug (tailnet-IP `pairServer` bind) and its v1.40.0 fix stands, but it
was NOT this symptom's cause. **Immediate fix:** add to the Mac's `config.json` (live-reloads, no restart) —
`"projects":{"default":"strict","allow":[{"from":"AIMB","to":"PowerHub","mode":"bidirectional"}]}`. Diagnosed via
SSH: **`ssh mac` now works** (key auth over Tailscale + macOS Remote Login; alias in `~/.ssh/config`, key
`~/.ssh/robins_mac_ed25519`, user `robin`, host `robins-macbook-pro.tail14b1ac.ts.net`). NB the Mac App Store
Tailscale build can't run Tailscale's own SSH server — we use macOS Remote Login instead.

**The port migration (#56) is IN FLIGHT** and working: default ports moved 7000/7001 → **12317/12318** (macOS
AirPlay clash). Dual-port compat (#57) is THREE surfaces (bind, same-host election, cross-host dial — the v1.38.0
`connectToPeer` fallback). The shared Dropbox `config.json` (gitignored) is already flipped to `port 12317,
wsPort 12318, compatPorts [7000], compatWsPorts [7001]` + the receive/send behaviour defaults. **Restarting a
bridge = restart the Claude app or the Task Tray** (`tray/windows/AiMcpBridgeTray.exe --root <src>`); the desktop
relaunches a dead bridge on next MCP use. **Use the doorbell** (`node tools/aimb-doorbell.mjs --name Bridget
--project AIMB --status <file>`, backgrounded) to wait for mail instead of manually polling `@` — it wakes on
real mail only and costs no tokens idle.

**Immediate pickups:** (a) add the `AIMB→PowerHub` `projects` edge to the Mac's `config.json` to unblock delivery
to MacDaddy/Mac-2 (#62; live-reloads); (b) ~~fix #61~~ DONE v1.42.0 — roll 1.42.0 to every host so denied sends
stop reading ok:true; (c) #59 once all on 12317. **Bridget reconnect ritual:** `register_self`
first (name Bridget, secret `bridget-aimb-2026`, project AIMB, user Robin), use the returned `peer_id` for
inbox/send — the bridge restarts often during this migration, so re-register whenever a send returns
`unknown-subpeer`.

---

## #67 — doorbell hourly chime + connect reminder carries the script location  ·  **DONE (v1.43.0)**
Robin's request (2026-09-30), two parts. **(a) Hourly chime as the default.** With no `--timeout` the doorbell exits
at the top of the next LOCAL hour (or earlier on mail) with `reason:"hourly"`, `time:"14:00"`, the `exited_at`
stamps and guidance to DISPLAY the time to the user and then re-arm. It is a visible wake, not the silent re-arm.
It never exits before the boundary (an early timer waits out the remainder), so a re-arm targets the next hour,
with no double chime or hot loop. An explicit `--timeout <sec>` keeps the old `timeout` + silent-guidance behaviour
exactly. Test hook: `AIMB_DOORBELL_PERIOD_SEC`. **(b) Tell agents WHERE the doorbell is.** Agents often didn't know
the script path, and on macOS `node` may not be on PATH for non-login shells. `register_self` now expands
`{doorbell_cmd}` / `{doorbell_path}` / `{node}` / `{name}` / `{project}` in emitted `connect_reminders` from this
bridge's own location, emit-time only (stored reminders untouched, unknown tokens left as-is). `set_wake` for a code
session returns the same command. The shipped connect default in `config.example.json` uses `{doorbell_cmd}`.
**Rollout:** the connect default only takes effect once a host runs 1.43.0 AND its config carries the connect
entry (on older bridges a `{doorbell_cmd}` would reach the agent unexpanded). Live/shared config was intentionally
NOT edited. Tests: `test_doorbell_live` (40), `test_connect_reminders_live` (17), both verified to fail on the
pre-change code.

## #66 — replication audit: what federates mesh-wide vs what's bridge-local  ·  **OPEN (audit — Robin, 2026-09-29)**
Triggered by #62 (a consent grant not rippling past one bridge). Audit of bridge state, classified by whether it
replicates across the mesh. **The routing + observation plane FEDERATES; the policy + durability plane does NOT.**

**Replicates mesh-wide** (via `gossipFrame`/PEER_ROSTER, one hop, + `broadcastRoster` to followers — the ONLY
things in the gossip are `sessions` and `pages`):
- Sessions (id, name, host, port, bridge_version, capabilities, client kind, project/user).
- Sub-peers per session.
- Topic **claims** (role:owner) and **subscriptions** (role:subscriber) — they ride the session's `topics` array,
  so `allTopicEntries()` (which walks the whole `roster`, remote entries included) sees them everywhere. Hence
  directed `topic:` sends to an owner, publish fan-out to subscribers (`subscribersOf` → `routeEnvelope` dials
  cross-host), and roster visibility all work cross-host. ✓
- Pages — but DISPLAY FIELDS ONLY (`localPagesSlice`: instance, kind, title, subject, icon, project, user).
- Host aliases (gateway's `rosterPayload.hosts`).

**Does NOT replicate** — local to a bridge PROCESS (RAM) or to a persistence STORE (shared only where the store
is, e.g. the Windows Dropbox pair; never across separate machines):
1. **Consent grants** (`runtimeAllow` / `allow_project`) — per-process + durable per-store, NOT gossiped. → #62,
   the acute case. You can SEE and ADDRESS a peer mesh-wide, but whether a cross-project send is ALLOWED depends on
   the RECIPIENT's host having the grant. Proven live 2026-09-29: a doorbell broadcast reached Marz sessions on
   LITTLE (grant there) but was `project-denied` for MapGuy2 on ROBIN and Ferret:Mac.1 on the Mac (no grant there).
2. **Session behaviour reminders** (`set_behavior`) — per-holder-identity, RAM + durable per-store; follow the
   identity only within a shared store. Applied on the holder's hosting bridge.
3. **Default + connect reminders** (`config.behaviors.default`) and **static consent edges** (`config.projects`)
   — per CONFIG FILE. Shared only via a shared config. This is why the #64 connect-reminder default must be added
   to each host's config (or a realm-wide config) to take effect everywhere.
4. **Retained topic values** (last-value-per-topic) — per store; a new subscriber gets the retained value only
   from the store that holds it (so cross-host retained delivery is not guaranteed).
5. **Durable registrations** (name→identity offline-park), **parked mailboxes**, **vault** (sealed secrets) — per
   store, keyed to the recipient's home bridge BY DESIGN (federating these = shared durable storage, big change).
6. **Remote page subscriptions** — gossiped pages carry display fields only, so a cross-host publish does NOT
   reach a remote page's subscription (edge case).

**The bug class:** routing federates but policy doesn't, so a peer is reachable everywhere while the rule that
governs the interaction (consent, behaviour) lives only where it was set. **Fix candidates, priority order:**
(a) **grants** (#62) — gossip them in PEER_ROSTER, or carry a signed grant in the envelope (sender-side proof), or
a shared consent store; (b) **default/connect reminders** — a realm-wide config or gossip, so a connect reminder
set once reaches all hosts; (c) **retained values** + (d) **remote page subscriptions** — include in gossip;
(e) leave parked-mail/vault/registrations store-local by design. #61 (ok:true masks a denied/dropped send) makes
every one of these fail SILENTLY, so #61 is a prerequisite for trusting any of it.

## #65 — self-updating bridge (message-triggered upgrade)  ·  **DESIRABLE (spec before build — Robin, 2026-09-29)**
A future release should let an operator send a bridge a control message that makes it upgrade itself: `git fetch`
+ checkout a signed tag + `npm ci` if deps moved + restart — so a new bridge version rolls across all hosts without
hand-SSHing each. **Hard parts / requirements:** (1) **Restart is not self-serve** — a bridge is a child of its
MCP client (Claude Code) or the tray; delegate the restart to the supervisor (tray / launchd / systemd) or re-exec
and rely on the client to respawn (Claude Code respawns its MCP server on next tool use). (2) **Security — this is
RCE over a shared-token mesh:** MUST be opt-in per host (`allowRemoteUpgrade`), operator-presence-gated (Windows
Hello / authorizer — not silent), pinned to a trusted remote + a **signed tag** (never an arbitrary ref), ideally
accepted only from a trusted admin identity. (3) **Git state** clean + pull authenticated (differs per host).
(4) **Coordination** — orchestrate one host at a time with a health check between; a broadcast "everyone restart"
churns/partitions the mesh (#63). Pairs with #64 (a freshly-upgraded bridge announces its new version) and needs
the same operator control-plane the #66 broadcast problem wants (a trusted, presence-gated channel not subject to
per-project app-consent). **MVP:** `bridge_admin {action:"upgrade", ref}` → Hello-gated → fetch + verify signed
tag → supervisor restart → report status over the mesh.

## #64 — connect reminders (by client type) + claim-default flip + session-resolved set_wake  ·  **DONE (v1.41.0)**
Three related changes (Robin's calls), all shipped and tested. **(a) Connect reminders.** Added `connect` to
`BEHAVIOR_OPERATIONS` and `client` to `BEHAVIOR_SCOPES` (`lib/reminders.js`); `matches()` gains a `client` branch
(match = client kind: code|agent|cowork|other). `register_self` computes `opReminders(id,'connect',{client_kind})`
and returns them as `connect_reminders` (both fresh + reattach paths). The shipped **config default** (a `connect`
/`client:code` reminder in `behaviors.default`) tells code sessions to run the doorbell — a runtime-configurable,
client-typed standing hint, replacing the idea of a static instructions line. This is how a poll/code client
learns its options at connect while bridge-side `wake` stays unimplemented. **(b) claim_topic defaults** flipped
to `exclusive:true`, `announce_offline:true` (persistent was already default-true when persistence is on): a plain
claim is now sole-owner + durable + offline-announcing; shared/silent are explicit opt-outs. Tool-schema + config
docs updated. **(c) set_wake** stays `unsupported` (`CAPS.wake=false`) but resolves the message by the CALLER's
client kind — `code` → "Not implemented, but you can use the doorbell service as a fallback" (+ the command);
others → "Not implemented for your session with no fallback supported". Tests: `test_connect_reminders_live` (10
checks — claim defaults on the roster, both set_wake branches, client-scope gating both directions);
`test_offline_park_live` updated so the silent-parking case opts out of announce explicitly. Full suite green.
**Rollout:** the `connect` config default goes into a host's live config only AFTER it runs 1.41.0. **Follow-on
idea (not built):** `connect` currently fires in the `register_self` RESPONSE (pull); a true bridge-initiated
`wake` (push a non-running session awake) remains impossible — the doorbell is the fallback and is what #64 wires
in by default.

## #63 — stale cross-host federation state after a peer's port-migration doesn't self-heal  ·  **OPEN (needed a manual restart)**
After the Mac flipped 7000→12317 (and churned through several restarts), **LITTLE-001 kept stale delivery state for
the Mac**: Testy (on LITTLE) couldn't reach MacDaddy (on the Mac), while ROBIN-hosted senders (Bridget, Analysiz2)
could — because ROBIN's link to the Mac was fresh and LITTLE's was not. The Mac↔LITTLE TCP link showed ESTABLISHED
(verified via SSH: `Mac:49233->100.78.211.46:12317`), so it wasn't a missing link — LITTLE's *roster/routing* entry
for the Mac was stale (most likely a stale delivery port and/or a federation link that never re-keyed after the
Mac's restart), and #61 masked the resulting drop as `ok:true`. **It did NOT self-heal** — Robin fixed it by
**restarting LITTLE-001's bridges from the tray**, which re-established the link with current ports. (NB: MacDaddy's
"LITTLE↔Mac is healthy, nothing to fix" report was taken AFTER that restart, so it read a healed state as
never-broken — a good reminder that a post-fix snapshot can hide the fault.) **Investigate:** `mergeRemoteRoster`
replaces a peer's slice on each gossip, but gossip only re-fires when the *sender's* local slice signature changes
(`gossipToPeers` / `lastGossip`) — a peer that RESTARTS (new session id, same host) may not trigger a re-gossip to
already-linked hubs, and/or the old federation link lingers with stale entries. Options: force a full re-gossip to
all peer hubs on any peer (re)connect; drop+refresh a peer's roster slice when its gateway session id changes;
heartbeat-expire stale peer sessions. Relates to #57 (migration) and #61 (masking). Distinct from the v1.38.0 dial
fix, which was about INITIAL cross-port dialing, not refreshing an already-linked peer after it moves.

## #62 — cross-project consent grants don't federate (per-receiving-host)  ·  **OPEN (root cause of "Mac never receives")**
`deliveryAllowed` (bridge.mjs) is RECEIVER-side and directional: a PowerHub bridge accepts an AIMB message only
if THAT bridge has an `AIMB→PowerHub` edge — a static `CFG.projects` edge or a durable runtime grant
(`allow_project`, persisted in `lib/consent.js`'s `runtimeAllow`). **Grants are per-receiving-host and do NOT
federate across the mesh.** So a sender that was legitimately granted access on one host (ROBIN/LITTLE — shared
Dropbox persistence) silently CANNOT reach the same-named peer once it lives on a host that lacks the grant
(Robin's Mac — separate machine, own persistence). This was the real cause of "MacDaddy/Mac-2 never receive
Bridget's messages" while VirtualGuy on LITTLE received them fine. Confirmed: `deliverSub` returns
`project-denied` (bridge.mjs:638) on the Mac; the reply-cap exception (bridge.mjs:263) still works, which is why
a `reply_to` reply lands where a plain send doesn't. **Immediate fix (applied):** add a static edge to the Mac's
`config.json` — `"projects": { "default": "strict", "allow": [ { "from": "AIMB", "to": "PowerHub", "mode":
"bidirectional" } ] }` — which live-reloads (bridge.mjs:211, no restart). **Design fix (this issue):** decide how
cross-project grants should propagate — options: (a) gossip runtime grants to peer hubs so a grant is realm-wide;
(b) evaluate consent against the SENDER's home-bridge grant (carried, signed, in the envelope) rather than only
the receiver's local map; (c) keep it receiver-local but make the shared config the single source of truth for
static edges and document that per-host runtime grants are host-scoped by design. Relates to #61.

## #61 — `send_to_peer` reports `ok:true` even when delivery is denied or dead-lettered  ·  **DONE (v1.42.0)**
The pair-splice MSG handler (bridge.mjs, `pairServer`) sends `CLOSE {code:'ok'}` UNCONDITIONALLY after calling
`deliverSub`/`deliver`, ignoring their return. So when `deliverSub` returns `project-denied` (bridge.mjs:638) or
dead-letters to the process inbox (bridge.mjs:635 — target not in `subpeers`), the CROSS-HOST sender's
`dialAndSend` sees `CLOSE` and reports **`ok:true`**. The caller cannot tell a real delivery from a silent drop.
This masked #62 for a full debugging session — every denied/dropped send to the Mac looked like a success, which
sent the investigation chasing transport/port/bind theories (#60) instead of consent. **Fix:** propagate the real
outcome — have the MSG handler send `CLOSE {code}` carrying `deliverSub`'s result (e.g. `project-denied`,
`dead-lettered`), and have `dialAndSend` surface a non-ok / a `delivered:false` + `code` to the sender. Keep
dead-letter as `ok` only if we deliberately want fire-and-forget semantics — but a `project-denied` MUST NOT read
as success. Verified live: sends to MacDaddy returned `ok:true` while its `unread_direct` stayed 0 and it never
received them. Relates to #62.
**Fixed (v1.42.0):** the MSG handler's `CLOSE` now carries `deliver`/`deliverSub`'s result (`code` + `dead_lettered`
/`dedup`) and `dialAndSend` surfaces it, so a cross-host send returns exactly what a local one does (denied →
`ok:false, code:'project-denied'`; dead-letter → `ok:true, dead_lettered:true`). Needs 1.42.0 on BOTH ends (a code-
less/old CLOSE still reads ok). Guard: `test_delivery_outcome_live`, proven to fail pre-fix. See architecture §13.

## #60 — inbound-only host: pair-listener bound the tailnet IP, not loopback  ·  **DONE (v1.40.0)**
Robin's Mac could SEND to the mesh but nothing on the mesh could be routed TO its sub-peer (MacDaddy): every
`send_to_peer` returned `target-unreachable`, yet the Mac was healthy in every roster and its own sends landed.
**Root cause:** the `pairServer` — the host-internal splice target every bridge listens on — was bound to `BIND`,
but it is only ever DIALED over loopback. Cross-host delivery reaches a host's WELL-KNOWN port, then the gateway
re-splices the envelope to the owning local session via `connect(pairPort, peer.host || HOST)` with `HOST` hard-
coded `127.0.0.1` (`mergeRemoteRoster` rewrites a remote session's port to its gateway's PORT, so `pairPort`
never crosses a host). With `bind: "0.0.0.0"` (the Windows boxes) loopback is covered; the Mac's `bind` is its
specific **tailnet IP**, so `pairServer` listened on that IP only and the gateway's dial to `127.0.0.1:pairPort`
for its OWN gateway-hosted sub-peer got ECONNREFUSED → `target-unreachable`. Mac-only because only the Mac had
BOTH a gateway-hosted sub-peer AND a non-`0.0.0.0` bind (Linux gateways carry no sub-peers; Windows binds
`0.0.0.0`). **Fix:** `pairServer.listen(0, HOST)` — the pair port is a loopback-only internal listener and should
never be on the tailnet (small attack-surface win too). This is the same failure earlier mislabelled in
`test_migrate_dial_live` as "a loopback-harness quirk, not a routing bug"; it was real. That test now delivers
A→B's gateway-hosted sub-peer and asserts receipt — verified to FAIL with the exact `target-unreachable` against
the pre-fix bind, so it's a genuine regression guard. Full suite green. **Deploy:** the Mac must pull v1.40.0 +
restart its bridge for MacDaddy delivery to work.

## #46 — realm token from a FILE (`AI_BRIDGE_TOKEN_FILE`)  ·  **DONE (v1.29.0)**
The realm token was appearing in **plaintext in the process command line** on any host whose MCP client
inlines it (phub-lnx-gold uses an inline `--mcp-config` with `env:{AI_BRIDGE_TOKEN:"…"}`). argv is
world-readable via `ps` and captured by crash dumps / monitors / support bundles, and the realm token is
**both the membership gate and the body-encryption key** — so that one string is the whole mesh.
**Fix:** `bridge.mjs` now reads the token from `AI_BRIDGE_TOKEN_FILE` (a path — harmless in argv) when set.
Precedence: `AI_BRIDGE_TOKEN` value → `AI_BRIDGE_TOKEN_FILE` contents → `config.json` token. Accepts a
bare-token file or a `KEY=VALUE` env file (e.g. `bridge.env`). Linux guide updated to use the file form.
*Follow-up:* switch phub-lnx-gold's MCP config from inline `AI_BRIDGE_TOKEN` to `AI_BRIDGE_TOKEN_FILE`
pointing at `~/.aimb/bridge.env` (0600), so the token leaves its argv.

## #47 — rename operation `deliver` → `receive`; `receive` is the default  ·  **DONE (v1.30.0)**
Robin's call: the incoming operation is named **`receive`**, not `deliver`, and `receive` is the default when
`operation` is omitted (preserves pre-#44 reminders, which all fired on incoming mail). **Done** across
`lib/reminders.js`, `bridge.mjs` (`deliverCtx`→`receiveCtx`), `lib/tool-schemas.js`, `facets/persistence/file.js`,
`src/README.md`, and the tests. **Back-compat = alias, not migration:** `OP_ALIASES = {deliver:'receive'}` folds
the old name at every entry point (stale client input, config default, durable `.beh` files). Nothing on disk is
renamed — the persistence layer still READS legacy-named files (`deliver__…​.beh` + pre-#44 unprefixed) and folds
them on load; `remove()` deletes by CONTENT match so a cleared reminder can't be resurrected by a stale filename.
No file-rename migration on purpose: the persistence dir is Dropbox-shared with a still-older host, and alias-on-
read is inert for old code. New regression test `test_receive_rename_live` (12 checks) covers both legacy flavours
end-to-end incl. clear-and-restart. This unblocks the config-default work below (those want `operation:"receive"`).

## #48 — make `operation` MANDATORY (remove the omitted-default)  ·  *depends on #47 + full rollout*
Once **every** bridge is on the #47 format AND **every** Claude app has restarted (so cached tool schemas
include the `operation` param — see the client-cache limitation below), stop defaulting a missing operation.
`set_behavior` with no `operation` should then error (`operation-required`) rather than silently defaulting.
Rationale: the silent default is a footgun — a stale client strips `operation` and the reminder is silently
mis-filed (VirtualGuy's #44 incident). Gate: do NOT do this until the mesh + clients are uniformly upgraded,
or it breaks every not-yet-restarted client.

## #49 — token rotation procedure  ·  *deferred (Robin)*
The realm token has been exposed in argv on phub-lnx-gold (#46). Rotation deferred for now. When done:
change the token on all hosts **simultaneously** (a mismatch = both membership failure AND undecryptable
bodies). The Dropbox-synced `config.json` propagates the new value to the two Windows boxes automatically;
the Linux `bridge.env` needs a manual push; then **restart all bridges**. **Caveat:** persisted encrypted
mailboxes were sealed with the OLD token → undecryptable after rotation, so drain inboxes first or accept the
loss. Not urgent: exposure is limited to a local `ps` on a single-user dev VM. Revisit after #46 lands and
phub-lnx-gold is switched to the file form.

## #42 — the TPM probe lies about hardware backing  ·  **OPEN** (spawned background task `task_8e2f15cf`)
`tray/windows/Tpm.exe --pubkey` returns exit 0 + a valid RSA key on a machine with **no TPM** (falls back to
a software KSP), so `facets/vault/tpm.js` `probe()` reports `recover_secret:true` on a TPM-less box, and —
worse — `seal()` succeeds against that software key (secrets silently sealed to non-TPM storage). **Fix is
C#:** `Tpm.cs` must open the key under the **Platform Crypto Provider** and exit non-zero when it can't, so
"got bytes" ≠ "hardware-backed". Extra field detail gathered since: (a) the probe also FALSE-NEGATIVES when
`Tpm.exe` isn't built yet (my probe deliberately doesn't build it), so a real-TPM box reports false until the
helper exists; (b) `Tpm.exe`/`HelloConfirm.exe` are git-ignored but **Dropbox-synced**, so a Windows-built
helper lands on other machines regardless of their actual TPM — feeding the false positive nondeterministically.
Design principle to preserve: `profile.names.vault` = intent, `capabilities.recover_secret` = verified truth.

## Config defaults — ship `receive`/`send` behaviour conventions  ·  **DONE (commit b9263a2, refined v1.33.0)**
Shipped to `config.example.json` (repo) and the live Dropbox `config.json` as a `behaviors.default` ARRAY,
sourced from VirtualGuy's generic conventions and approved by Robin. The one-per-(operation,scope,match)
constraint meant the old `"Summarize but don't act without user permission"` string was MERGED into the single
`receive`/`all` entry. The line format and the 🖂/📨 glyphs are the DEFINITION, not examples (Robin). Refined in
v1.33.0 after a Cowork session concatenated two arrivals onto one line — the `receive` default now says "Put
EACH incoming message on its own blockquote (>) line", and the blockquote spans the arrival **and any work it
triggers** (a provenance marker for the bridge-originated stretch of transcript), returning to plain text for
the session's own work. Live-reloads without a restart; kept at 270 chars (under the pre-1.33 cap of 280) so a
not-yet-upgraded bridge serves it untruncated.

## #50 — show `bridge_version` on the Mesh Map + flag a non-uniform mesh  ·  **(a)+(b) DONE (v1.32.0); (c) deferred**
Requested by VirtualGuy (relaying Robin), 2026-07-21. The version was in the **Computers table** but not on
the **Mesh Map**, so the map — the view you glance at during a rollout — made a version-skewed mesh look
healthy. **Done (a)+(b):** every session node shows its running `bridge_version`, amber when it isn't the mesh
MODE; each host box has a version badge (amber when the host runs >1 version, or a single version that isn't
the mode — the phub-lnx-gold case); and a top banner names the skew when the mesh isn't uniform. All from
roster data already present (`s.bridge_version`), no bridge change. Verified by six checks in
`test_dashboard_multihost`.
- **(c) WON'T DO for now (Robin, 2026-07-22): "not high enough value to implement at this time."** Flag when a
  node's **running** version differs from the version **on its disk** — the exact gap behind both incidents
  (VirtualGuy's most-valued, but the plumbing-heavy one). Would need the bridge to read its own `package.json`
  **at request time** (a `code_version`) and thread it through the **gossiped roster** so remote nodes carry it;
  then the dashboard flags running≠checked-out. Real cross-host schema plumbing (roster entry + welcome +
  my_identity), unlike (a)+(b) which were dashboard-only. Parked; (a)+(b) already cover the practical need.

## #51 — doorbell: self-timestamp the exit output  ·  **DONE (v1.31.0)**
Requested by Linux-1 (phub-lnx-gold, relaying Robin), 2026-07-22. `tools/aimb-doorbell.mjs` printed one JSON
line on exit, but only the **timeout** case carried a time signal (`waited_sec`); mail / gone / error /
link-closed had none. **Done:** every exit line now carries `exited_at` (local ISO-8601 with tz offset) +
`exited_at_unix`, stamped centrally in `done()` so all five reasons get it uniformly, and the same two fields
land in the `--status` file's exit write. Purely additive — no change to exit codes or the summary shape.
Verified by new checks in `test_doorbell_live`.

## #52 — doorbell exit codes = success/failure; built-in silent re-arm guidance  ·  **DONE (v1.34.0)**
Reported by Analysiz2 (relaying Robin), 2026-07-23, with a real misreport behind it: the doorbell exited **2**
on a clean timeout, and the Claude Code background-task harness paints any non-zero exit as "failed", so a
benign 30-min timeout surfaced as a FAILURE and a loop narrated "Quiet re-arm, nothing new" every cycle.
**Done:** exit code is now success/failure only — **0** once armed and any normal outcome occurs
(mail/timeout/peer-gone/post-arm link drop), **4** only when it couldn't do its job (never armed / bridge error),
**64** bad usage; the specific outcome moved to `reason` on stdout + `--status`. Plus a terse built-in
`guidance:"silent re-arm…"` on routine no-mail wakes so a loop stays quiet (mail exits carry none — that one is
actionable). This is the same concern as the old Smaller/maybe "doorbell exit codes vs the harness" item, now
resolved.

## #53 — a token-free doorbell for COWORK peers  ·  **OPEN**
Raised by Retally (relaying Robin), 2026-07-23. The Code doorbell works because a Code session has a
**persistent local process** to host the blocking long-poll. A **Cowork session has no local task-runner**, so it
cannot host that wait — Retally tested it: a detached poller (`setsid`, `</dev/null &`) **died at the tool-call
boundary** (froze at tick 1, gone in ~70s) because the Cowork sandbox tears down its process tree per call. So
the bridge's long-poll PRIMITIVE is not the gap (Code proves it works) — **the gap is WHO HOSTS THE WAIT.**
Cowork peers already report `doorbell:true` but `wake:false`, `mode:poll`, `channel_capable:false`, and every
LLM-in-the-loop poll costs input tokens (context-dominated), so continuous polling is never token-free.
**Options, in rough order of promise:**
1. **Task-Tray gateway hosts the doorbell on behalf of a Cowork peer** — the tray is already a persistent host
   process holding a bridge connection; it runs the long-poll and raises a desktop/OS notification (or signals
   the Cowork app) on arrival. Reuses existing infra; token-free idle. *Most promising.*
2. **Bridge → desktop OS notification** driven by the existing `doorbell:true` capability, via the gateway —
   human-in-the-loop wake, zero idle tokens. Pairs naturally with (1).
3. **Cowork scheduled task** — available today, no bridge work, but costs tokens per fire (cold start) so only a
   coarse cadence. The fallback, not the goal.
4. **In-turn bounded long-poll tool** — a blocking "wait for a message up to N seconds" call a poll-mode client
   can chain within a turn (≤45s per call). Good for "wait for the reply now", not for indefinite idle.
**Depends on origin detection** (see Bigger/in-flight): the gateway must know "this peer is Cowork → notify it,
don't expect a local doorbell task." Same thread. Nothing built; feasibility read only.

## #54 — send on behalf of a TOPIC (topic-as-sender attribution)  ·  **OPEN**
Robin, 2026-07-23. **Today sender attribution is always the PEER.** `makeEnvelope` sets `from` to a peer
identity, and `as` on `send_to_peer`/`publish` takes a registered sub-peer handle — there is no way to send "on
behalf of" a topic. The envelope's `topic` field is populated by **routing**, not authorship: it is the
DESTINATION for `send_to_peer {target:"topic:X"}` (the topic whose owners receive it) and the CHANNEL for
`publish {topic:X}`. So a receiver learns *who* sent it plus *which topic was involved in delivery*, never "this
came FROM topic X". Closest existing behaviour is `publish`, which reads as "an event on topic X" — but `from`
is still the peer.
**Why it's worth having:** continuity across owner handoff and peer-id rotation. Topics already have durable
claims and keep-alive handoff, so if `retail` changes hands, "messages from the Retail topic" stay a coherent
thread while "messages from Retally" do not. Same instinct as preferring topic addressing over a stored peer id.
**Proposed shape:**
- `send_to_peer { from_topic: "retail", … }`, **validated that the caller OWNS that topic** — otherwise it is
  spoofing (anyone could claim to speak for a topic they don't hold).
- Carried as a SEPARATE envelope field (`from_topic`), **additive — never replacing `from`**. The real peer must
  survive: accountability, reply routing, and the hop/loop guard all depend on it.
- Receivers render topic-forward, peer still visible — e.g. `🖂 from ⚡ Retail (via Retally)`.
- Decide whether `publish` should carry it too (probably redundant there — the channel already is the topic).

## #55 — `claim_topic` re-claim SILENTLY RESETS omitted fields  ·  **OPEN**
Found 2026-07-24 while telling Bolletta how to flip `bills` to exclusive. Re-claiming a topic you already hold
updates it in place (good — `claimed_at` is preserved, no release needed), **but every field you don't pass is
reset rather than preserved**: `description` → `''`, `icon` → `null`, `keep_alive` → `false`,
`announce_offline` → `false`. So the natural `claim_topic {topic:"bills", exclusive:true}` — changing ONE flag —
silently wipes the description, the icon, and both continuity settings. The fallbacks at bridge.mjs
(`eDesc`/`eIcon`/`keep_alive`/`eAnnounce`) fall back to the **kept-alive marker**, which is null for a topic
that is currently OWNED, so nothing backstops a re-claim. **Fix:** on a re-claim (`myTopics.has(k)`), fall back
to the EXISTING record for any field the caller omitted, so a re-claim is a patch not a replace. Keep an
explicit `null`/`false` as a real clear. Workaround until then: pass every field you want to keep.

## #56 — migrate the WHOLE REALM to ports 12317/12318  ·  **IN PROGRESS** (3/4 hosts done; phub-lnx-01 remains)
The shipped default moved to 12317/12318 in v1.36.0, but existing hosts keep 7000/7001 via their own
`config.json` until migrated. Robin wants the whole realm moved eventually. **#57 (v1.37.0) removes the
coordinated-restart requirement** that used to make this delicate: a gateway can hold the new AND old port at
once (`compatPorts`), so a lingering old-port session on a host JOINS the new gateway instead of splitting.
**Per-host procedure (no coordination needed):**
- In ONE edit, set `"port": 12317, "wsPort": 12318, "compatPorts": [7000], "compatWsPorts": [7001]`, then restart
  the host's bridges whenever suits. During the window a new-code bridge holds both ports; any old-port session
  converges onto it. Restart each host on its own schedule.
- **Windows (ROBIN-Z790, LITTLE-001)** share the Dropbox `config.json` — one edit moves both on their next
  restarts. **Linux (phub-lnx-*)**: edit each `config.json`, `git pull`, `systemctl --user restart`, ufw 12317.
  **macOS (MacDaddy)** already on 12317/12318 (add `compatPorts` only if it needs to accept old-port peers, which
  cross-host it does not — the old port matters SAME-host).
- **Cleanup:** once the dashboard's Computers/Bridge column shows every host advertising 12317, drop `compatPorts`/
  `compatWsPorts` (back to `[]`) in a final pass.
Cross-host federation survives a mixed-port transition regardless (the gateway port is gossiped). After each
host: verify `my_identity → gateway_port` and that the roster still shows every machine.

## #57 — dual-port gateway (compat window for the migration)  ·  **DONE (v1.37.0)**
A gateway can now hold multiple control ports (+ ws ports): `compatPorts`/`compatWsPorts` (opt-in, default []).
New election invariant — a gateway owns EVERY well-known port on its host, so a bridge configured for an old port
finds it held and follows rather than standing up a rival. Extracted `onControlConn`/`onWsConnection`/
`startWsIngress` so primary + compat listeners share the handlers. Verified by `test_dual_port_live` (6 checks,
both start orders + ws compat). This is what makes #56 restart-free. Opt-in (not default-on) so loopback-simulated
multi-host tests don't collide on a shared compat port.

## #58 — code sessions on a CLI host show TWICE (follower-bridge + sub-peer)  ·  **OPEN** (dashboard clarity)
Robin spotted on phub-lnx-01: each Claude Code CLI session there appears as a full bridge-sized (orange, not
blue) bubble AND a top-level sessions-list row (`62bd6ec7`, `9e0b6a8d` — bare hex ids, `claude-code` client, no
topics), while its actual conversation shows separately as a sub-peer (Modell, Renda). Root cause is not a bug in
routing — it is the two client integrations: the **desktop app shares ONE bridge** across conversations (they
register as sub-peers, so N conversations = 1 bridge bubble + N sub-peers, and the shared bridge is hidden in the
default connections view), whereas a **CLI host spawns one bridge PER session** (MCP stdio launches its own
server), so N conversations = N follower-bridges + N sub-peers. The follower-bridge and its single sub-peer are
ONE logical thing shown as two. Why the desktop's shared bridge is hidden but these are not: the connections view
hides the agent/shared bridge rows and promotes sub-peers, but a `claude-code` follower-bridge is classed as a
real connection and shown — so it leaks in alongside its promoted sub-peer. **Direction (dashboard-only):**
collapse a FOLLOWER bridge that hosts exactly one sub-peer of its own into that conversation (render one node),
or extend the hide-bridges rule to code follower-bridges the same way it hides agent ones. Verify it does not
hide a genuine standalone code session that registered no sub-peer. Not a bridge/protocol change.

## #59 — rip out the dual-port compat capability once the realm is migrated  ·  **OPEN** (cleanup, after #56)
The `compatPorts`/`compatWsPorts` machinery (#57, v1.37.0) is a TRANSITIONAL migration aid. Once #56 is complete
and the dashboard's Computers/Bridge column shows every host advertising 12317/12318 (no 7000 anywhere), remove
it: (a) set `compatPorts`/`compatWsPorts` back to `[]` on every host (or delete the keys), then (b) in a later
release, delete the `COMPAT_PORTS`/`COMPAT_WS_PORTS` config, the multi-port `bindPorts` loop (revert election to
the single-port bind), the per-ws-port `startWsIngress` loop, and the `becomeFollower(gwPort)` parameter — folding
back toward the pre-#57 single-port shape while KEEPING the handler extraction (`onControlConn`/`onWsConnection`/
`startWsIngress`), which is a clean improvement worth retaining. Keep `test_dual_port_live` until the code is
removed, then delete it with the feature. Do NOT do this until #56 is fully done — removing compat early strands
any host still on the old port.

## Doc gotchas to fold into `linux-setup.md` / `architecture.md`
- **"Synced checkout ≠ running bridge."** A new commit appearing in the Dropbox/git checkout does NOT restart
  the running bridge — the tray only relaunches it if it dies, and the MCP transport doesn't reconnect on its
  own. Always verify `my_identity → bridge_version` before any version-dependent test. (Nearly produced a
  false negative that corroborated a real bug.)
- **"Adding a tool PARAMETER needs a client restart."** v1.28.0 emits `tools/list_changed` (#45), but it does
  NOT refresh Claude Code's cached tool schema (verified negative on two independent clients — the client
  strips the unknown param and even the deferred-tool registry keeps the old schema). So a new tool parameter
  is unreachable from an already-running client until its Claude app/session restarts. Adding whole *tools*,
  or changing behaviour behind *existing* params, does not need a restart. This is why #48 must wait for a
  full client-restart cycle.

## Smaller / maybe
- **Multiple behaviours per key.** The model allows one reminder per `(operation, scope, match)`; several
  conventions for the same key must be concatenated into one string (≤365 as of v1.33.0). Consider allowing an
  array per key if this gets limiting.

## Bigger / in-flight
- **Session ORIGIN detection (cowork vs code, and where code runs).** The `clientKind` regex guesses app
  identity from a free-text client name and collapses unknowns into a misleading `agent` bucket. Field probes
  (2026-07-23) established: (a) ONE bridge process serves MIXED origins at once (aa61c969 hosts cowork Bolletta
  +Retally alongside code Bridget+Analysiz2), so a process-level env sniff can't work — origin must be
  per-registration; (b) env-in-bash is not universal — a Cowork tool-shell runs in an isolated sandbox where
  `CLAUDE_CODE_*` come back EMPTY (only `CLAUDE_CODE_HOST_*` proxy plumbing), while Code-in-desktop's bash sees
  `CLAUDECODE=1`/`ENTRYPOINT=claude-desktop`/`AGENT_SDK`/`CHILD_SESSION`/real `SESSION_ID`; (c) the mislabel's
  direct cause is that identical Cowork sessions register with DIFFERENT `client` strings (Bolletta "cowork" vs
  Retally "local-agent-mode"). **Ideal:** a structured `origin` descriptor {product, host, mode, version,
  source} captured per-registration from the MCP connection layer, stamped by the integration that mounts the
  bridge (NOT inferred from a name, NOT read from a sandboxed bash). `host` is the axis Robin wants — it
  separates code-in-terminal from code-in-desktop. Ground truth for the fix: only Retally+Bolletta are Cowork;
  all other AI peers are Code. **Blocker:** reliably POPULATING origin per-surface on a shared bridge is a
  product/integration dependency outside this repo — the bridge can define/accept/render the field; the
  surfaces have to set it. Schema design pending; probe data captured in-session.
