# Open issues / planned work

Resume-ready register of open work. Built items live in `architecture.md` §13 (the version history /
changelog). This file is the *forward* list. Newest/highest priority first. Issue numbers continue the
project's `#NN` sequence.

---

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

## #56 — migrate the WHOLE REALM to ports 12317/12318  ·  **OPEN** (now de-risked by #57)
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
