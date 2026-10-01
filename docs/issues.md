# Open issues / planned work

Resume-ready register of open work. Built items live in `architecture.md` §13 (the version history /
changelog). This file is the *forward* list. Newest/highest priority first. Issue numbers continue the
project's `#NN` sequence.

---

## RESUME STATE (updated 2026-10-01, v1.58.0) — read this first after a compact
**Current version: v1.58.0** (#70 step 2: the `log` + `activity` tools, gateway-owned activity state, the daily JSONL;
code done, NOT yet deployed — live hosts run v1.54.0). Work up to v1.57.0 is committed AND pushed to `main` (see
`git log`); v1.58.0 is in the working tree for review. Everything below is durable;
nothing important is only in chat.

**DEPLOYED (2026-09-30):** every live host runs **v1.54.0**: ROBIN-Z790, LITTLE-001, Robins-Mac, phub-lnx-01 (checked
with `list_sessions`).
- `Tpm.exe` was rebuilt: it reports the Platform Crypto Provider, and the public key is unchanged.
- The shared Dropbox `config.json` now carries `behaviors.realm` (`updated_at` 2026-09-30T05:30:57Z) with the
  code-session doorbell connect reminder. It reloads live and was verified on a `register_self`.
- The tray gained **Restart Bridges…** (`1012daf`). ROBIN runs the new tray.
- **LITTLE's tray is NOT running.** The new exe is in place there, but it has to be started on the interactive desktop
  (SSH can't: a scheduled-task launch was refused by the auto-mode classifier as persistence).

Optional tidy: live configs still carry ignored `compatPorts` keys (harmless). Not done: the optional
`from_topic`-aware receive line in `behaviors.realm` (#54).

**2026-10-01 (v1.58.0):** Built **#70 step 2** — `log` (as a registered session; `@`/`@~` contexts, progress/ETA on any
message, `log:false` board-only updates, `{progress}`/`{eta}` text templates rendered at read time) and `activity` (this
host's board, one agent's log, one entry's details/data). The host's gateway owns the state and
`activity/<host>/YYYY-MM-DD.jsonl` (entries + `cp` checkpoints + run-length `rep` lines); followers forward over the
control link; a new gateway replays the files newest-first. Deploy = restart each bridge on 1.58.0 (a follower needs a
1.58 gateway; it says `gateway-unsupported` otherwise).

**Still open:** #70 agent activity board (steps 1–2 built; next: step 3 `tools/aimb-log.mjs`, then gossip, dashboard, snippet), #65 self-updating bridge (desirable, spec first — would automate host upgrades), #53 Cowork doorbell,
#50(c), #48 (after full rollout), #49 (deferred). Offered, not requested: a receiver-side check that a `from_topic`
sender is a gossiped owner of that topic (#54 hardening).

**2026-09-30 (v1.57.0):** Fixed **#71** — one canonical project spelling mesh-wide (the first-seen one; matching stays
case-insensitive): `allow`, `access`, `list_sessions`, `my_identity`, the #72 notices and the dashboard all show it; a
replicated `project_names` map rides the roster gossip. Also fixed: a reply-cap now survives the replier re-registering
in another case. Deploy = restart each bridge on 1.57.0 (older bridges ignore the map and keep showing declared spellings).

**2026-09-30 (v1.56.0):** Built **#72** — `allow_project` announces every grant change to the granted project
(`project_access_granted`: live members mesh-wide, parked for offline durable registrations; a pending requester's copy
echoes its `request_id`, one notice each) and `revoke_project` sends `project_access_revoked`. Only the granting bridge
announces; identical re-grants are silent. `notified` now counts all notices (+ `notified_pending`/`announced`/`parked`).
Deploy = restart each bridge on 1.56.0 (only the granting bridge needs it; receivers of any version accept the notice).

**2026-09-30 (v1.55.0):** Fixed **#73** — the doorbell no longer loops on a name not re-registered since a bridge
restart: the bridge sends `{type:"unknown"}` (script: `reason:"peer-unknown"`, exit 0, "call register_self … then
re-arm" guidance) and keeps `gone` for a name that left while watched; the script also maps an old bridge's instant
`gone` to `peer-unknown`. Deploy = restart each bridge on 1.55.0 (the doorbell script ships beside it).

**2026-09-30 (v1.54.0):** Built **#69** — the doorbell's hourly chimes at 00:00/06:00/12:00/18:00 (local) add
`inbox_check:true` + guidance to call the inbox tool NOW even if nothing is waiting (keeps the Ai MCP Bridge loaded in
an idle session), then display the time and re-arm. Other chimes, mail and `--timeout` exits unchanged. The script now
imports `tools/aimb-doorbell-clock.mjs` (ships beside it). Nothing to restart: each re-armed doorbell picks it up.
The `config.example.json` connect default mentions it; live configs were not edited (the realm connect default only
changes where someone publishes a newer `behaviors.realm` block).

**2026-09-30 (v1.53.0):** Fixed **#42** — the `tpm` vault now trusts a key only when `Tpm.exe` POSITIVELY reports the
Microsoft Platform Crypto Provider + a `TPM-Version:` platform type; otherwise `recover_secret:false` (reason + hint in
`my_identity.facet_probe`) and `seal()` refuses. The helper (`Tpm.cs`) is hardware-or-nothing (TBS device check + PCP
only, exit 2 otherwise). **Key-compatible** (same provider + `aimb-vault` key; identical public key verified) — no
re-registration. **DEPLOY STEP FOR ROBIN (pending):** the new `Tpm.exe` is NOT built into `tray/windows/` yet (the live
exe was left untouched). Run `tray/windows/build-tpm.cmd` on ROBIN-Z790 (Dropbox syncs it to LITTLE-001), THEN restart
bridges/tray. A 1.53.0 bridge with the old exe reports `recover_secret:false` (`tpm-helper-outdated`) until rebuilt.

**2026-09-30 (v1.52.0):** Fixed **#58** (dashboard only) — a CLI host's per-session follower `code` bridge that hosts
exactly one sub-peer now renders ONCE, as that sub-peer, in the sessions list (both views), the mesh map and the
Computers counts; bare code sessions, 2+-sub-peer bridges, gateways and agent/tray bridges are unchanged. The bridge
serves `dashboard.html` from disk, so a pull is enough — no restart, no config change.

**2026-09-30 (v1.51.0):** Built **#54** — `send_to_peer {from_topic}` sends on behalf of a topic the caller currently
owns (validated on the sending bridge, else `not-topic-owner`); carried as cleartext `from_topic` + `from_topic_icon`
beside `from` (never replacing it) on every delivery path, in `inbox`, the push meta, traces and the dashboard. Pages
may do it for their own `subject`; not on `publish`. The shipped receive convention in `config.example.json` renders
`🖂 from ⚡ retail (via Retally)` — a host's live `config.json` keeps its own copy until someone edits it. Roll 1.51.0
to a SENDING host to use it; older receivers ignore the fields.

**2026-09-30 (v1.50.0):** Fixed **#55** — a `claim_topic` re-claim is now a PATCH: omitted fields keep the existing
claim's values (live, rehydrated, or the holder's own dormant durable record) instead of resetting to the defaults,
so a plain re-claim after a compact/restart no longer flips a shared topic exclusive. No config change; roll 1.50.0
to each host at leisure (each host governs its own claims).

**2026-09-30 (v1.49.0):** Fixed **#68** (security) — page reply-cap signing keys (`capKey`) no longer leak in
`list_sessions`, the follower `ROSTER` or the WS `welcome`/`roster`; pages go out through an allow-list
(`publicPage`). No config change; roll 1.49.0 to every gateway to stop the leak mesh-wide.

**2026-09-30 (v1.48.0):** Did **#66(c)+(d)** and closed **#66**. (c) Retained topic values now replicate mesh-wide
as a last-writer-wins set keyed by (realm, project, topic) (`lib/retained.js`; `PEER_ROSTER.retained` /
`ROSTER.retained`, sent only to a link/follower that lacks the current version, + a follower→gateway `RETAINED`
frame), persisted where learned, so a later subscriber on ANY host is caught up. A value over the 64KB replication cap
stays on its publishing host (the publish reply says `retained_replicated:false`) and a too-large marker retires the
older value elsewhere. (d) Pages gossip their `subscriptions` + `page_ingress`; a publish/`send_to_peer` to a page on
another host dials the owning gateway, which delivers via `deliverPage` (consent checked there) and returns the real
outcome in the #61 CLOSE code. **Rollout:** both need 1.48.0 on the publishing/sending host AND the host that holds
the subscriber/page; a page behind a ≤1.47 gateway fails `page-remote-unsupported`. No live config was edited.

**2026-09-30 (v1.47.0):** Did **#66(b)** — realm-wide default reminders. A `behaviors.realm` block
`{ "updated_at": "<ISO>", "default": [...] }` in ANY one host's config is now a single last-writer-wins record gossiped
mesh-wide (`PEER_ROSTER.realm_defaults`, `ROSTER.realm_defaults`, follower→gateway `REALM_DEFAULTS` frame) and
persisted where learned. A host's own `behaviors.default` entry still wins its (operation,scope,match) key; realm
entries fill the rest (tagged `realm:true`). New env `AI_BRIDGE_CONFIG=<path>` points a bridge at an alternate config
file. **Rollout:** realm defaults spread only among 1.47.0+ hosts. Once EVERY host (and the bridge its followers run)
is on 1.47.0, put the doorbell connect reminder (`connect`/`client`/`code`, as in `config.example.json`) in ONE
config's `behaviors.realm` — e.g. the shared Dropbox `config.json` — with a fresh `updated_at`, and it will spread to
the Mac and phub-lnx-01 without editing their configs. Remove any local `connect`/`client`/`code` entry from a host's
`behaviors.default` if you want the realm text there (a local entry wins its key). Bump `updated_at` on every later
edit. No live config was edited.

**2026-09-30 (v1.46.0):** Did **#59** and closed **#56** — the realm port migration is COMPLETE. Every online host
(ROBIN-Z790, LITTLE-001, Robins-Mac, phub-lnx-01) runs on 12317/12318; phub-lnx-02 is retired. The dual-port compat
capability (#57/v1.37.0 + the v1.38.0 dial fallback) is gone: one well-known port, single-port election, one WS
ingress, a single cross-host dial. A host still on 7000 can no longer federate. Leftover `compatPorts`/
`compatWsPorts` keys in live configs (e.g. the shared Dropbox `config.json`) are now ignored, so no edit is needed.

**2026-09-30 (v1.45.0):** Fixed **#62**. Runtime cross-project grants (`allow_project`/`revoke_project`) now
replicate mesh-wide as a last-writer-wins set (revoke = tombstone): gossiped in `PEER_ROSTER.grants`, pushed to
followers in `ROSTER.grants`, and sent up from a follower in a new `GRANTS` frame; every process persists what it
learns. **Rollout: every host (gateways AND the bridges its followers run) needs 1.45.0 for grants to spread** — a
≤1.44 host still only knows its local grants (and the #62 static-edge workaround on the Mac stays needed until the Mac
runs 1.45.0). Static `config.projects` edges are still per-config (not gossiped).

**2026-09-30 (v1.44.0):** Fixed **#63**. Cross-host federation now self-heals: a full slice is sent on every
(re)link; a same-host peer with a new session retires the old one; and a 60s refresh+PING heartbeat expires
provably-quiet peers (default 180s). Older (≤1.43) peers are never expired for being quiet. The heal on a host
needs THAT host upgraded to 1.44.0, so roll it out to LITTLE, the Mac and the Linux boxes.

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
The bridge restarted at some point over the ~2 months after the 2026-07-25 snapshot — on reconnect the queue epoch had
reset and Bridget's `Bridge` claim had NOT rehydrated (re-claimed it). Rollout
note for #64: the `connect` default belongs in a host's config only AFTER it runs 1.41.0 (on 1.40.0 an unknown
`connect`/`client` folds to a `receive`/`all` reminder), so the live/shared config was intentionally NOT edited.

**Live mesh (2026-09-30):** every online host is on port **12317** — ROBIN-Z790 (this machine; gateway is the Task
Tray bridge, Bridget is a follower), LITTLE-001 (reads the shared Dropbox config), Robins-Mac (owns topic `mac`, runs
MacDaddy) and phub-lnx-01 (migrated 2026-09-30 on v1.44.0). **phub-lnx-02 is RETIRED.** Versions vary per host
(roll-outs of 1.42–1.47 are pending), so re-run `list_sessions` before trusting version details.

**Remote admin + history:** `ssh mac` (robin@robins-macbook-pro.tail14b1ac.ts.net, key `~/.ssh/robins_mac_ed25519`,
macOS Remote Login — the App Store Tailscale build can't run Tailscale SSH) and `ssh phub1` (robin@phub-lnx-01, key
`~/.ssh/phub_lnx_01_ed25519`) and `ssh little1` (robin@little-001, key `~/.ssh/little_001_ed25519`,
Windows OpenSSH set up 2026-09-30: Tailscale-only firewall, key-only, PowerShell shell; the tray runs in the
interactive session, so SSH can't show it on the desktop). The old "Mac never receives Bridget" saga (2026-07-25) was #62 (per-host consent) masked
by #61; MacDaddy fixed it live with `allow_project`, and both bugs are now fixed in code (v1.42.0 / v1.45.0).
Writing a remote config over SSH can trip the auto-mode classifier — hand Robin the command if it does.

**The port migration (#56) is DONE:** default ports moved 7000/7001 → **12317/12318** (macOS AirPlay clash), every
host is on them, and v1.46.0 (#59) removed the compat window. **Restarting a
bridge = restart the Claude app or the Task Tray** (`tray/windows/AiMcpBridgeTray.exe --root <src>`); the desktop
relaunches a dead bridge on next MCP use. **Use the doorbell** (`node tools/aimb-doorbell.mjs --name Bridget
--project AIMB --status <file>`, backgrounded) to wait for mail instead of manually polling `@` — it wakes on
real mail only and costs no tokens idle.

**Bridget reconnect ritual:** `register_self` first (name Bridget, secret `bridget-aimb-2026`, project AIMB), use
the returned `peer_id` for inbox/send; re-claim `Bridge` (exclusive, icon 🌉) if `topics` comes back empty; re-register
whenever a send returns `unknown-subpeer`.

---

## #73 — doorbell reports `peer-gone` for a name not re-registered since a bridge restart (re-arm loop)  ·  **DONE (v1.55.0)**
Reported by Ferret : PC.1 (Ferret project, 2026-09-30).
**Built:** the listener tracks whether its watched name has been on the roster at any point while it was armed
(`ws.watchSeen`, set in `notifyOne` whenever `listenerState` finds it). A name that is missing and was never seen gets
the new `{type:"unknown"}` frame; one that was seen and then left keeps `{type:"gone"}`. Project scoping and topic-only
watches are unchanged. The script maps `unknown` → `reason:"peer-unknown"`, exit 0, `--status` state `unknown`,
`guidance:"Your name isn't registered on this bridge (it probably restarted). Call register_self with your name +
secret, then re-arm the doorbell."` (no silent re-arm). `peer-gone` keeps the silent re-arm and adds "if the bridge
restarted since your last register_self, call it first". **Old bridges** send `gone` for both cases, so a `gone`
within 2 s of `welcome` (`AIMB_DOORBELL_EARLY_GONE_MS`) from a bridge that reports <1.55.0 becomes `peer-unknown` with
`inferred_from:"early-gone"` (the hot-loop guard); a later `gone` stays `peer-gone`. README exit-code table and the
listener protocol updated. Tests: `test_doorbell_live` 56 → 71 (listener `unknown` vs `gone`, project scoping, topic
watch; script `peer-unknown`/`peer-gone` + status file; the guard against a fake old listener server: early gone,
late gone, version gate); 9 of the new checks FAIL on the pre-change bridge + script.
- **What happens:** after a bridge restart (the queue epoch changes), a session's name is unknown until it calls
  `register_self` again. A doorbell armed before that exits at once with `reason:"peer-gone"`, and its guidance says
  "silent re-arm". Re-arming exits again, so the session loops without ever re-registering. The v1.54.0 rollout
  restarted every bridge, so every code session is exposed.
- **Wanted:**
  - Tell "never known / not registered since the restart" apart from "was here and left". Proposed:
    `reason:"peer-unknown"` with guidance to call `register_self` with your name and secret, then re-arm.
  - Or let the listener arm on an unknown name and wait for it to register.
  - A real departure stays `peer-gone`.
  - Exit code stays 0, since it isn't a bridge fault.
  - Update the README exit-code table.

## #72 — `allow_project` grants aren't announced to the granted project  ·  **DONE (v1.56.0)**
Reported by Ferret : PC.1 (2026-09-30).
**Built:** `allow_project` sends a `project_access_granted` **system** notice to the granted project's live sessions /
sub-peers / pages mesh-wide (the audience `request_project_access` uses) and parks it for each durable registration of
that project live nowhere on the roster (drained on its next `register_self`; only registrations in the granting
bridge's store). Subject e.g. `Ferret granted AIMB access (bidirectional, 30m)`, `from` = the granter; body `{action,
granting_project, granted_project, mode, one_way, direction, ttl_minutes, expires_at, granted_by, note, to, from}`.
`revoke_project` sends `project_access_revoked` the same way (only when a live grant was revoked). **Consent:** it runs
granting → granted (closed under a one-way grant), so it uses the existing `system` exemption that
`project_access_request` and the Bug-3 ack already ride — set only by bridge code for these verbs, so ordinary sends in
that direction stay `project-denied`. **Duplicates:** only the handler where the call was made announces
(`consent.merge()` gossip never does); an identical re-grant (same mode + TTL, read back via the new `consent.edge()`)
returns `announce:"unchanged"` and announces nothing; a pending requester rides the same call (its copy adds
`request_id`) and is skipped in the broadcast. Return: `notified` = `notified_pending` + `announced` + `parked` (was
pending only). Not announced: a TTL grant expiring by itself. Tests: new `test_grant_notice_live` (28 checks); 20 FAIL on
the pre-change bridge.
- **What happens:** `allow_project` returned `notified: 0` because there was no pending `request_project_access`. The
  granted project's sessions (AIMB here) have no way to learn they can now reach Ferret.
- **Wanted:**
  - A short `project_access_granted` notice to the granted project's live sessions, parked for durable ones.
  - The notice carries the mode (one-way or bidirectional; bidirectional also opens the reverse direction) and any TTL.
  - A revoke should probably announce too.
  - Grants federate as a last-writer-wins set since #62, so decide which host sends the notice (the granting bridge)
    to avoid duplicates.

## #71 — project names show inconsistent case (`AIMB` vs `aimb`, `Marz` vs `marz`)  ·  **DONE (v1.57.0)**
Reported by Ferret : PC.1 (2026-09-30).
**Built:** one canonical DISPLAY spelling per project, mesh-wide — the **first-seen** one. A new `lib/project-names.js`
holds a replicated map `projKey → {name, first_seen}`: a sighting (a `register_self`, a page, the bridge's own identity,
an `allow_project` naming a project, and on a gateway every roster entry, so ≤1.56 hosts' sessions are covered) folds in
as `{name, now}`, and merge keeps the earliest `first_seen` (tie → lexically smaller: `AIMB` beats `aimb`). It rides
`PEER_ROSTER` / `ROSTER` as `project_names`, goes up from a follower in a `PROJECT_NAMES` frame, and persists one file
per host (`project-names/<host>.pnames`). Shown through it: `list_sessions` (sessions, sub-peers, topics, pages),
`register_self` (`identity.project`, `access`), `my_identity`, `allow_project` (`allow.from` was the projKey `"aimb"`),
`revoke_project`, `request_project_access` (`to` was lower-cased), topic send/publish results, the #72 notices (subject
+ body) and the dashboard (roster, groups, persistence view). Identities and the wire roster are never rewritten.
**Audit** (matching was already `projKey` almost everywhere — consent, topics/`@project/`, claims, parked mail,
registrations, retained, reminders, stable ids, egress, doorbell, `from_topic`; the file store lower-cases every key).
Real case bugs found + fixed: the **reply-cap** bound the two projects by their declared spelling, so a replier that
re-registered as `BETA` (was `Beta`) got `project-denied` on an invited reply (now projKey'd; the old form is still
accepted); `allow_project` let a caller declared `UNCLASSIFIED` grant (compared `=== 'unclassified'`); a page declared
`Unclassified` got a scoped roster; `isIdentityLive` compared user + name exact-case. Tests: new
`test_project_case_live` (27 checks; 23 FAIL on the pre-change bridge) + 14 unit checks in `test_lib_unit`. Full suite 1104 passed (45 files).
- **What happens:**
  - A Ferret session called `allow_project(project:"AIMB")` and got a grant shown as `{from:"aimb", to:"Ferret"}`;
    `register_self` then listed `access:["aimb"]`.
  - `list_sessions` shows both `Marz` (MapGuy2, Lighter) and `marz` (MapSeeder).
  - Matching is already case-insensitive (`projKey`/`lc`), so this is presentation plus stored spelling, not a split,
    but it reads as two projects.
- **Wanted:** one canonical display spelling per project (realm), ideally the first-seen or registered spelling. Use
  it in grants, `access`, the roster, `list_sessions` and the dashboard, while matching stays case-insensitive.
  Verify that no path really treats different cases as different projects (topics, consent, parked mail).

## #70 — agent activity board: live agent status by session, mesh-wide  ·  **OPEN (spec in progress — Robin + Bridget, 2026-09-30)**
**Why:** sessions increasingly act as **orchestrators** and their **agents do the work**, but nothing shows what those
agents are doing right now. **What:** a new dashboard page showing, across the whole mesh, sessions grouped by project,
each session's agents under it, and each agent's progress. Agents report it themselves with a doorbell-style script (or
a bridge tool). The bridge gossips the current state, and each host keeps the full log.

### Decided so far
**Hierarchy and identity:**
- The tree is project → session → agent → context → message.
- Agents do NOT register. An agent reports as `session + agent label`, and the orchestrator puts that one line in the
  agent's prompt.
- Agents may nest with a path label (`spec-70/research`). Claude Code subagents can't spawn subagents as far as we know,
  but workflows and other SDK clients can go deeper, and the tree just adds a level.

**Message model:** every message belongs to a context.
- `@root` is the default and is the agent's or session's own context.
- `@Ctx <text>` adds a message to that context's log.
- `@~Ctx <text>` adds it to the log **and** makes it the context's **current** line.
- `@~root` sets the headline status.
- A message with no prefix is logged to `@root` without changing the headline, so setting a current line is always a
  deliberate `@~`.
- A context is created by its first message. Quote names with spaces: `@~"CTX strip 17"`.
- ~~Progress and ETA take effect on `@~` messages (an `@` message only records them in its log entry).~~ Superseded
  (2026-10-01): ANY message moves the bar — see "Decisions after step 1".
- Optional `details` (≤ 4 KB text) and `data` (≤ 16 KB JSON) are **not gossiped**; the dashboard fetches them on demand.
- Keyed update-in-place lines (an earlier idea) are dropped; `@~` replaces them.

**States:**
- Reported states: `running | blocked | failed | done | idle`.
- **Stale is computed, never reported.** A running or blocked item with no message of ANY kind for longer than the
  threshold (default 15 min) shows as "stale, was X", with its text greyed. A context goes stale by its own most
  recent message.
- Done, failed and idle never go stale.
- When a session leaves the mesh, its agents are marked **gone**.

**Lifecycle:** an agent's first message starts it. `@~root` set to done or failed ends it. Finished agents stay visible
for 24h, collapsed, then leave the gossip; they remain in the host's daily log.

**Progress:** a context may carry `done/total unit` or a %.
- The agent's or session's `@root` shows either a reported figure or a **rollup** of its contexts: summed when they
  share a unit, otherwise the average %.
- A rollup is labelled as one.
- An ETA is always shown as **estimated**.

**Times:** no inline time text. Each row has a **status ring**:
- the centre shows the state: a dot for live states, a tick for done, a cross for failed;
- the ring empties as the time left before going stale runs out.

Hover tooltips carry the actual times: started, elapsed, last activity, stale-at, or finished and how long it took.
⌛ appears only when there's an ETA (hover shows "estimated"). 🔔 appears when the session's doorbell is armed. Hovering
a progress bar shows the exact counts and whether they were reported or rolled up.

**Layout:**
- **Tree only.** The cards layout was prototyped and dropped.
- Projects cycle between all, sessions only and collapsed. A global Projects / Sessions / Agents depth control sets
  every project at once.
- Default view: every session with its agents' `@root` lines showing, and all contexts and messages closed.
- An expanded agent or session shows a **Log** (every context, newest first, tagged `@ctx` / `@~ctx`), then its
  contexts (name, current line, progress, ETA). Each context expands into its own log. A log entry expands into its
  details and JSON.
- An "Active only" filter hides finished agents.
- A pill appears only for blocked, failed or stale.
- The layout needs further work (Robin).

**Visibility:** status text is plaintext realm-wide, like a subject. There's no project scoping; agents are told never
to put secrets in it.

### The call (proposed; name = `log`)
**Bridge tool:**
```
log({ as, secret,                 // the reporting session (registered sub-peer)
      agent?,                     // agent label/path under it; omit = the session itself
      text?,                      // one-liner ≤ 240 chars (longer is truncated); may start with @ctx / @~ctx; a template
                                  //   ({progress} {pct} {done} {total} {unit} {eta}); default "{progress}" / "{eta}"
      context?,                   // "@root" (default) | "@Ctx" | "@~Ctx"; overrides a prefix in text
      state?,                     // running|blocked|failed|done|idle; default: the context's current, else running
      progress?,                  // "4812/12000 tiles" | "3/6" | "61%" | "none"
      eta?,                       // "15m" | "1h25m" | "19:27" | "none"
      stale_after?,               // "60m" (max 24h): this may stay quiet that long before it counts as stale
      details?, data?,            // ≤ 4 KB text / ≤ 16 KB JSON, fetched on demand
      log? })                     // true (default) = append to the log + file; false = board only
  → { ok, id, ts, session, agent, context, current, state, stale_at, logged }   (BUILT v1.58.0)
```

**Script:** `tools/aimb-log.mjs`, token-gated like the doorbell, no registration needed.
```
node aimb-log.mjs --session <name> [--project P] [--agent <label>] [--ctx "@~Ctx"] [--state S]
  [--progress 4812/12000:tiles] [--eta 1h25m] [--details "..."] [--data '{...}' | --data-file f.json] "<text>"
```
- It prints one JSON line. Exit codes: 0 ok, 4 bridge error, 64 usage.
- Anyone holding the realm token can report as any session via the script. That is the same trust as the doorbell,
  and was accepted (Robin); the bridge tool checks `as`/`secret`.

### Limits and configuration (decided, Robin, 2026-09-30)
**Fixed in code, versioned** (these change what crosses the mesh, so every bridge must agree):

| Limit | Value |
|---|---|
| Message text | 240 chars |
| Context name | 60 chars |
| Agent path depth | 3 (`a/b/c`) |
| Contexts per agent | 32 |
| Agents per session | 128 |
| `details` | 4 KB |
| `data` | 16 KB |

The tool description and the agent snippet encourage keeping details and data as small as possible. Changing a limit
means a version bump, or later a realm-wide setting.

**Configurable per host:** an `activity` block in `config.json`, each key with an `AI_BRIDGE_ACTIVITY_*` env override.

| Key | Default |
|---|---|
| `log_retention_days` | 7 |
| `log_entries_per_agent` | 200, kept in memory |
| `stale_after_min` | 15. Also the dashboard slider's default; a viewer can still move it. |
| `finished_visible_hours` | 24 |
| `memory_budget_mb` | 64. Over budget, the oldest finished agents are evicted first. |
| `enabled` | true |

**Per-message stale override:** `stale_after` (e.g. `60m`, capped at 24h) on a message sets how long that agent or
context may stay quiet before it counts as stale. It lasts until its next message. This is for legitimately long
silent steps such as builds and downloads.

**Memory model:** worst case, 128 agents × 200 entries × 20 KB is about 500 MB per session. So:
- In memory, a log entry keeps text, state, time, context and the flags.
- `details` and `data` stay in memory only for each context's CURRENT line.
- Older entries' `details` and `data` are read back from the host's daily JSONL when expanded.

### Decisions after step 1 (Robin, 2026-10-01)
- **State and the current line change only on `@~`.** An `@` message's state is recorded in its log entry only.
- **Progress and ETA:**
  - They persist between messages; `none` clears them. The ETA is dropped when a context goes done or failed.
  - **ANY message can update a context's progress and ETA**, `@` included, since a bar update can't change the
    headline.
- **Progress ticks:** a message with NO text but `progress` and/or `eta`:
  - updates the bar and ETA and counts as activity (it keeps the agent and context fresh);
  - is not appended to the log and is not written to the daily JSONL, so it is ephemeral (memory and gossip only);
  - on restart, the bar falls back to the last LOGGED message that carried progress, until the next tick.
- **Session identity:** realm + project + user + session name. The host is not part of it, so a session that moves
  machines stays the same session.
- **Restart replay, newest first:** the host's daily JSONL is read BACKWARDS from the newest record.
  - A reverse fold fills each entity's current line, bar, state and finished status, and stops once they are found,
    so the board is current almost immediately.
  - The in-memory history (up to `log_entries_per_agent`) then fills in, in the background.
  - It covers `finished_visible_hours` (24h).
- **Each bridge owns only its own history:**
  - A restarted bridge rebuilds only its own host's sessions.
  - Other hosts' current lines arrive by gossip (step 4).
  - Remote history, details and data are fetched on demand from the owning bridge (the #66d `CONNECT` pattern) and
    never bulk-copied.
  - If the owning host is down, its agents show as gone and their history is unavailable.
- **One writer per host:** the host's GATEWAY owns the activity state and the files. Followers forward `log` calls
  up. Files are per HOST (`activity/<host>/YYYY-MM-DD.jsonl` under the persist dir), so a newly elected gateway
  continues the same history.
- **During step 2 (Robin, 2026-10-01):**
  - **The `log` flag** (default true): `log:false` takes full effect on the board (line, state, bar, activity) but is
    not appended to the log or the file — for frequent updates (a script every second); `log:true` for milestones.
    (Replaced the earlier implicit "no text = progress tick".)
  - **Text is a template** rendered at READ time: `{progress}` `{pct}` `{done}` `{total}` `{unit}` `{eta}`; `{{`/`}}`
    literal; unknown or unfillable placeholders left as typed. A current line renders against the context's LIVE bar,
    a log entry against what it recorded. A message with progress/eta and no text defaults to `"{progress}"`
    (`"{eta}"` with only an ETA), logged or not.
  - **Checkpoints** (`progress_checkpoint_sec`, default 60, 10–3600, 0 = off): a context changed via `log:false` gets ONE
    `{"kind":"cp","k":n,…}` line per interval (`k` = a per-file key); alive-but-unchanged contexts go in ONE trailing
    `{"rep":[k…],"n","since","last"}` line, rewritten in place while the key set is exactly the same. Replay: the newest
    of cp / entry wins for line, bar and state; `last_activity` takes rep `last`; garbled final lines are skipped.

### Logging flag, checkpoints and chunked history (Robin, 2026-10-01; supersedes the implicit "tick" rule above)
- **An explicit `log` flag (default true) decides whether a message is logged.**
  - `log:false` still takes effect: an `@~` sets the current line and state, progress and ETA update the bar, and it
    counts as activity. It is not added to the log or the daily JSONL.
  - Text is optional only for a `log:false` message that carries progress and/or ETA.
  - The agent or script decides explicitly. An agent's own tool calls are expensive, so it logs sparingly; a script
    can report every second with `log:false` and log a milestone now and then.
- **Bridge progress checkpoints:** every `progress_checkpoint_sec` (per-host config, default 60, 0 = off), the
  gateway writes at most one compact checkpoint record per context whose bar, ETA or current line changed via
  `log:false` messages.
  - Checkpoints are not log entries: they are hidden from log views and entry lookup.
  - Replay uses them, so the bar survives a restart without log noise.
- **Checkpoint notation in the daily JSONL** (keeps the file clean):
  - A CHANGED context writes `{"kind":"cp","k":17,...current line/bar/state}`, where `k` is a short per-file key.
  - Unchanged-but-alive contexts are run-length encoded in ONE trailing repeat line:
    `{"rep":[17,18,23],"n":245,"since":t0,"last":t1}`.
  - At each interval, if that line is still the file's last line it is rewritten IN PLACE (truncate + write;
    single writer per host file): `n` is incremented and `last` updated. Any other write closes it, and the next
    unchanged interval starts a new one.
  - Replay takes `last` as the context's last-alive time, so stale is right after a restart.
  - Log views ignore `cp` and `rep` lines.
  - A garbled final line (a crash mid-rewrite) is skipped, losing at most one interval of liveness.
- **Text placeholders, rendered when READ (stored raw):** `{progress}` ("4,812 of 12,000 tiles"), `{pct}`, `{done}`,
  `{total}`, `{unit}` and `{eta}`.
  - Current lines render against the CURRENT bar, so a template headline counts up live with `log:false` updates.
  - Log entries render against the progress recorded on that entry.
  - An unknown `{word}` is left as is; `{{` and `}}` are literal braces.
  - **Default text:** a message with progress but no text gets `"{progress}"`, logged or not. No text and no
    progress or ETA is rejected.
- **History across the wire is CHUNKED (step 4):**
  - Remote log, details and data fetches are paged with a cursor, a bounded page size (entries and bytes) and a
    request rate limit per link.
  - Details and data travel only on an explicit per-entry fetch.
  - A large history never swamps a bridge's CPU or a link's budget.
  - Replay and history reads are incremental and yield to the event loop.

### Build plan
Each step is its own version.
1. `src/lib/activity.js`: pure logic plus unit tests. Nothing visible. **BUILT (2026-09-30)** — `src/lib/activity.js`
   (parse, `apply`, stale/gone/rollup/visibility views, per-origin `snapshot`/`mergeSnapshot`, memory budget,
   `resolveConfig`) + `src/tests/test_activity_unit.mjs` (287 checks). Not wired into the bridge, so **no version
   bump** (still v1.57.0). Decisions: text over 240 is truncated with a warning (everything else over a limit is
   rejected); done > total clamps; a clock ETA resolves at parse time (`now` + tz offset); the 129th agent evicts
   the session's oldest finished agent and is rejected only when none has finished.
2. The `log` tool, local state and the daily JSONL. **BUILT (v1.58.0, 2026-10-01)** — `log` + `activity` tools, the
   gateway-owned state (followers forward over the control link), `activity/<host>/YYYY-MM-DD.jsonl` (entries, `cp`,
   `rep`), newest-first replay with an early phase-1 publish, retention, expiry, budget, gone on leave; `log:false`,
   text templates and checkpoints (decided during the step). `test_activity_unit` 384 checks, new `test_log_live` (52).
   See architecture.md §13 "Built (v1.58.0)".
3. `tools/aimb-log.mjs`.
4. Gossip, plus on-demand fetch of logs, details and data.
5. The dashboard Activity tree.
6. `{log_snippet}` plus a connect reminder.

### How sessions learn to use it (proposed)
The same channels that taught sessions the doorbell (#64/#66b/#67):
1. **A realm-wide connect reminder:** a `behaviors.realm` `connect` entry for `client:code`. It says: when you spawn
   agents, put `{log_snippet}` in each agent's prompt and report your own status with `@~root`.
   - `{log_snippet}` is a new placeholder the bridge expands per session at emit time, like `{doorbell_cmd}`: the
     absolute node and script paths plus `--session "<name>" --project "<proj>"`, followed by a two-line how-to
     (`@`/`@~`, report at milestones, the final `--state done`).
   - The orchestrator pastes it and adds `--agent <label>`.
2. **The tool and the server instructions:** the `log` tool's own description, plus one line in the bridge's MCP
   server instructions, cover sessions that have the bridge loaded. This includes Cowork, which can't run the script
   but can call the tool.
3. **Agents never see reminders.** They learn only from the orchestrator's prompt, which is why the snippet has to be
   ready to paste.
4. **Later:** check whether client hooks could inject the snippet into spawned agents automatically.

### Still to decide / build notes
- The gossip frame shape and caps: current lines only, with per-agent and per-host limits and oldest-first eviction.
- Where the log lives: on the originating host, in a daily JSONL file.
- On-demand fetch for logs, details and data, via the `CONNECT` pattern from #66d.
- The orchestrator guidance text: what to put in an agent's prompt, and reporting at milestones rather than every step
  (token cost).
- Whether client hooks can automate start and stop.
- The read tool for orchestrators, so a session can answer "what's everyone doing".
- The layout polish still to come.

Related: #58 (dashboard session dedupe), #62/#66 (what federates), #39/#53 (doorbell-style scripts), #65 (a rollout would
benefit from the same visibility).

## #69 — doorbell 6-hour inbox check-in keeps the bridge loaded  ·  **DONE (v1.54.0)**
Robin's request (2026-09-30). An idle session whose only activity is the doorbell loop makes no bridge tool call for
hours, and the host can unload the MCP bridge from it. **Built:** the hourly chimes whose boundary falls on a 6-hour
mark (00:00, 06:00, 12:00, 18:00 local) keep `reason:"hourly"` and `time`, and add `inbox_check:true` with
`guidance:"6-hour check-in (18:00): call your inbox tool now even if nothing is waiting — it keeps the Ai MCP Bridge
loaded in this session. Then display the time to the user and re-arm the doorbell."`; the `--status` exit write gets
the same fields. Other hourly chimes, mail exits and explicit-`--timeout` exits are unchanged. The mark is decided from
the BOUNDARY's local wall time (`isCheckinMark` in the new pure helper `tools/aimb-doorbell-clock.mjs`, which also now
holds `nextBoundary`/`hhmm`), never `Date.now()` drift, so midnight reports `"00:00"` and is a check-in. Rule: the
boundary's seconds since local midnight divide by `every × period` (1-hour period, every 6 → hour % 6 === 0). Knobs:
`AIMB_DOORBELL_PERIOD_SEC` (existing test hook) and new `AIMB_DOORBELL_CHECKIN_EVERY` (default 6; test/tuning). The
`config.example.json` realm connect default (356 chars) and the code-session `set_wake` hint mention it. Tests:
`test_doorbell_live` 40 → 56 (on-mark, off-mark, default interval, mail/`--timeout` unchanged, status file, and pure
checks of 00/06/12/18 vs 01/23 incl. midnight after 23:59:59.998); 9 of the new checks FAIL on the pre-change script.

## #68 — page capKey (reply-cap signing key) leaked in roster/list_sessions/WS  ·  **DONE (v1.49.0)**
Found by the #66d agent (2026-09-30): `list_sessions` showed each page as `capKey: {type:'Buffer', data:[...]}`.
A page leaf's stored entry holds `capKey`, its reply-cap SIGNING key (`makeEnvelope` mints with it,
`verifyReplyCap` checks a reply to the page against it), and `rosterPayload()` spread the stored entries — so the key
went out in `list_sessions`, the follower `ROSTER` frame (and a follower's `list_sessions`) and the WS
`welcome`/`roster` to every other page and dashboard. Only the peer gossip (`localPagesSlice`) was allow-listed.
**Impact:** whoever holds page P's key can mint a valid reply cap and deliver to P from a project with NO grant (the
reply-cap exception in `deliveryAllowed` bypasses consent) — a cross-project consent bypass WITHIN the realm. All
members share the realm token (and since #43 a page key is derivable from token + instance anyway), so nothing is
exposed to outsiders; the key just no longer lands ready-made in AI transcripts, logs and web pages. **Fix:**
`publicPage()` — an explicit allow-list of the public page fields — applied in `rosterPayload()` to local and remote
(#66d) pages, so every roster-shaped output goes through it; a follower and `mergeRemoteRoster` also keep only the
public fields of what they receive. `capKey` stays in the in-memory `pages` map. Audit of sessions, sub-peers
(`secretHash`, sub-peer `capKey`), topics, traces, the dashboard persistence snapshot (vault identities only, never
`sealed`) and the MCP tool replies found no other leak. Test: `test_roster_secrets_live` (30), verified to fail
(13 checks) on the pre-fix code. No rollout dependency — a 1.49.0 bridge stops emitting keys on its own; a ≤1.48
gateway still emits them until upgraded (a 1.49.0 follower drops them on receipt).

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

## #66 — replication audit: what federates mesh-wide vs what's bridge-local  ·  **DONE (v1.48.0)** (audit — Robin, 2026-09-29; (a) grants DONE v1.45.0; (b) default reminders DONE v1.47.0; (c) retained values + (d) remote page subscriptions DONE v1.48.0; (e) parked mail, the vault and durable registrations stay store-local BY DESIGN)
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
- Pages — but DISPLAY FIELDS ONLY (`localPagesSlice`: instance, kind, title, subject, icon, project, user). *(Since
  v1.48.0 (#66d) also `subscriptions`, `realm` and `page_ingress`, and a remote page is routable — item 6.)*
- Host aliases (gateway's `rosterPayload.hosts`).

**Does NOT replicate** — local to a bridge PROCESS (RAM) or to a persistence STORE (shared only where the store
is, e.g. the Windows Dropbox pair; never across separate machines):
1. **Consent grants** (`runtimeAllow` / `allow_project`) — per-process + durable per-store, NOT gossiped *(was — now
   replicated since v1.45.0, #62; static `config.projects` edges are still per-config)*. → #62,
   the acute case. You can SEE and ADDRESS a peer mesh-wide, but whether a cross-project send is ALLOWED depends on
   the RECIPIENT's host having the grant. Proven live 2026-09-29: a doorbell broadcast reached Marz sessions on
   LITTLE (grant there) but was `project-denied` for MapGuy2 on ROBIN and Ferret:Mac.1 on the Mac (no grant there).
2. **Session behaviour reminders** (`set_behavior`) — per-holder-identity, RAM + durable per-store; follow the
   identity only within a shared store. Applied on the holder's hosting bridge.
3. **Default + connect reminders** (`config.behaviors.default`) and **static consent edges** (`config.projects`)
   — per CONFIG FILE. Shared only via a shared config. This is why the #64 connect-reminder default must be added
   to each host's config (or a realm-wide config) to take effect everywhere. *(Since v1.47.0 (#66b) a
   `behaviors.realm` block replicates mesh-wide as one LWW record; `behaviors.default` and `config.projects` stay
   per-config.)*
4. **Retained topic values** (last-value-per-topic) — per store; a new subscriber gets the retained value only
   from the store that holds it (so cross-host retained delivery is not guaranteed). *(Since v1.48.0 (#66c)
   replicated mesh-wide as a last-writer-wins set; a value over the 64KB replication cap stays on its publishing host.)*
5. **Durable registrations** (name→identity offline-park), **parked mailboxes**, **vault** (sealed secrets) — per
   store, keyed to the recipient's home bridge BY DESIGN (federating these = shared durable storage, big change).
6. **Remote page subscriptions** — gossiped pages carry display fields only, so a cross-host publish does NOT
   reach a remote page's subscription (edge case). *(Since v1.48.0 (#66d) subscriptions are gossiped and a remote
   page is delivered through its owning gateway, with an honest #61 outcome.)*

**The bug class:** routing federates but policy doesn't, so a peer is reachable everywhere while the rule that
governs the interaction (consent, behaviour) lives only where it was set. **Fix candidates, priority order:**
(a) **grants** (#62) — **DONE (v1.45.0):** gossiped in PEER_ROSTER as a last-writer-wins set (tombstone revokes),
pushed to/from followers, persisted where learned (static `config.projects` edges remain per-config — item 3); (b) **default/connect reminders** — **DONE (v1.47.0):** a
`behaviors.realm` block `{updated_at, default:[...]}` in any host's config is one replicated last-writer-wins record
(explicit operator `updated_at`, never mtime), gossiped in `PEER_ROSTER`/`ROSTER` + a follower→gateway `REALM_DEFAULTS`
frame, persisted where learned, layered UNDER each host's local `behaviors.default` (local key wins; realm fills gaps).
Needs 1.47.0 on every host; rollout note in RESUME STATE; (c) **retained values** — **DONE (v1.48.0):** a
last-writer-wins set keyed by (realm, project, topic), newest publish time wins, carried in `PEER_ROSTER`/`ROSTER`
(only to a link/follower lacking the current version) + a follower→gateway `RETAINED` frame, persisted where learned,
honouring the retained TTL; the subscribe-time catch-up reads store + set and still delivers via `deliverSub`
(consent unchanged); a value over the 64KB cap stays on its publishing host and a too-large marker retires older
copies; (d) **remote page subscriptions** — **DONE (v1.48.0):** pages gossip `subscriptions` + `page_ingress`,
`allTopicEntries`/`subscribersOf` include remote pages, and a `page:` target on another host is dialed to its owning
gateway (`CONNECT page:<instance>` → `deliverPage` → #61 CLOSE code); `send_to_peer` to a remote page works; a page on
a ≤1.47 gateway fails `page-remote-unsupported`;
(e) leave parked-mail/vault/registrations store-local by design — **this is the remainder, and it is intentional**:
they are keyed to the recipient's home bridge, and federating them would mean shared durable storage. #61 (ok:true masks a denied/dropped send) makes
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

## #63 — stale cross-host federation state after a peer's port-migration doesn't self-heal  ·  **DONE (v1.44.0)**
**Fixed:** (v1.44.0) a full slice on every (re)link; a restarted same-host peer (new session) retires the old one
(same port at once, other port after a PING probe); a refresh+PING heartbeat expires provably-quiet peers; and
only the current link may write a peer's slice. Mixed-version-safe via a `gossip_refresh` flag. Details are in
architecture.md §13; the regression guard is `test_federation_heal_live`.
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

## #62 — cross-project consent grants don't federate (per-receiving-host)  ·  **DONE (v1.45.0)**
**Fixed:** (v1.45.0) option (a): runtime grants are a replicated last-writer-wins set — one record per `(from,to)`
edge with `updated_at`; a revoke is a tombstone. Every gateway re-gossips the full set in `PEER_ROSTER.grants`
(sent at once on change), followers get it in `ROSTER.grants` and send their own changes up in a `GRANTS` frame, and
every process persists what it learns. Tombstones are GC'd after `AI_BRIDGE_GRANT_TOMBSTONE_TTL_MS` (30 days; a host
offline longer can resurrect a revoked grant). Needs 1.45.0 on every host; ≤1.44 hosts ignore it. Static config
edges stay per-config. Guard: `test_grants_federate_live` (9/18 FAIL pre-fix). See architecture §13.
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

## #42 — the TPM probe lies about hardware backing  ·  **DONE (v1.53.0 — helper rebuild pending deploy)**
`tray/windows/Tpm.exe --pubkey` returns exit 0 + a valid RSA key on a machine with **no TPM** (falls back to
a software KSP), so `facets/vault/tpm.js` `probe()` reports `recover_secret:true` on a TPM-less box, and —
worse — `seal()` succeeds against that software key (secrets silently sealed to non-TPM storage). **Fix is
C#:** `Tpm.cs` must open the key under the **Platform Crypto Provider** and exit non-zero when it can't, so
"got bytes" ≠ "hardware-backed". Extra field detail gathered since: (a) the probe also FALSE-NEGATIVES when
`Tpm.exe` isn't built yet (my probe deliberately doesn't build it), so a real-TPM box reports false until the
helper exists; (b) `Tpm.exe`/`HelloConfirm.exe` are git-ignored but **Dropbox-synced**, so a Windows-built
helper lands on other machines regardless of their actual TPM — feeding the false positive nondeterministically.
Design principle to preserve: `profile.names.vault` = intent, `capabilities.recover_secret` = verified truth.
**Fixed:** `Tpm.cs` requires a TPM visible to TPM Base Services and a key in the Platform Crypto Provider that answers
`PCP_PLATFORM_TYPE`; every mode exits 2 + `ERROR=…` otherwise (no software fallback; `--decrypt` checks before Hello).
`--pubkey` prints `PROVIDER=` + `PLATFORM_TYPE=`; `tpm.js` requires both for `probe()` AND `seal()` (a pre-#42 exe reads
`tpm-helper-outdated`); a missing helper reports `tpm-helper-missing` + a build-tpm.cmd hint in
`my_identity.facet_probe`. Finding: the OLD helper already used only the PCP (key `aimb-vault`) — no fallback in its
source — so the fix is key-compatible; the field "no TPM" came from `Win32_Tpm`, which needs admin. The runtime
checks make a Dropbox-synced exe fail honestly on a TPM-less box. Guarded by `test_facet_probe_live` (stub helpers;
5 checks fail pre-fix). **Pending deploy:** build the new `Tpm.exe` into `tray/windows/` (`build-tpm.cmd`), restart.

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

## #54 — send on behalf of a TOPIC (topic-as-sender attribution)  ·  **DONE (v1.51.0)**
**Built:** (v1.51.0) `send_to_peer {from_topic}` — only a CURRENT owner (a live owner claim held by the caller, in its
project; any co-owner of a shared topic) may use it, checked on the sending bridge (`fromTopicOf`), else
`{ok:false, code:'not-topic-owner'}` and nothing is sent (a wildcard → `wildcard-from-topic`). Carried as two flat
cleartext envelope fields `from_topic` + `from_topic_icon` (the claim icon), ADDITIVE to `from`; they survive local,
cross-host, `topic:` fanout, parked and redelivered paths and show in `inbox`, the push meta, traces and the
dashboard. Receive convention: `🖂 from ⚡ retail (via Retally) · …`. Replies still go to the peer (reply to
`topic:<from_topic>` for continuity across a handoff — documented, not automatic). `publish` does NOT take it (the
channel already is the topic). Pages: the WS `send` accepts it for the page's own `subject`. Details in
architecture.md §13; regression guard `test_from_topic_live`.
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

## #55 — `claim_topic` re-claim SILENTLY RESETS omitted fields  ·  **DONE (v1.50.0)**
**Fixed:** (v1.50.0) a re-claim is a PATCH: every omitted field keeps the EXISTING claim's value — the live claim
(incl. one rehydrated after a restart) or else the holder's own dormant durable record; defaults apply only to a NEW
claim. Precedence: explicit arg > existing claim > kept-alive marker (new claims) > default; an explicit
`false`/`""`/`null` clears. Conflict checks use the effective `exclusive` (a plain re-claim of a shared co-owned
topic stays shared; an explicit flip to exclusive with a co-owner is refused `held`). A re-claim with
`persistent:false` also drops the durable record. Details in architecture.md §13; regression guard
`test_reclaim_preserve_live`.
Found 2026-07-24 while telling Bolletta how to flip `bills` to exclusive. Re-claiming a topic you already hold
updates it in place (good — `claimed_at` is preserved, no release needed), **but every field you don't pass is
reset rather than preserved**: `description` → `''`, `icon` → `null`, `keep_alive` → `false`,
`announce_offline` → `false`. So the natural `claim_topic {topic:"bills", exclusive:true}` — changing ONE flag —
silently wipes the description, the icon, and both continuity settings. The fallbacks at bridge.mjs
(`eDesc`/`eIcon`/`keep_alive`/`eAnnounce`) fall back to the **kept-alive marker**, which is null for a topic
that is currently OWNED, so nothing backstops a re-claim. **Fix:** on a re-claim (`myTopics.has(k)`), fall back
to the EXISTING record for any field the caller omitted, so a re-claim is a patch not a replace. Keep an
explicit `null`/`false` as a real clear. Workaround until then: pass every field you want to keep.

## #56 — migrate the WHOLE REALM to ports 12317/12318  ·  **DONE (2026-09-30)**
**Closed:** phub-lnx-01 was migrated to 12317 on v1.44.0 (pulled, config flipped, `aimb-bridge.service` restarted;
it shows port 12317 on the mesh), and phub-lnx-02 is retired. Every online host is on 12317/12318, so the compat
window was removed in v1.46.0 (#59). The procedure below is kept as history; `compatPorts` no longer exists.
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

## #58 — code sessions on a CLI host show TWICE (follower-bridge + sub-peer)  ·  **DONE (v1.52.0)**
**Fixed:** (v1.52.0, dashboard only) `soloSub` in `dashboard.html` collapses a FOLLOWER `code` bridge that hosts
exactly ONE sub-peer (and owns no topic itself) into that sub-peer — one row in both sessions views, one node on the
mesh map, one Connection (not also a Session) in Computers; the bridge's id/version/connected time are on hover and in
the expander. Gateways, bare code sessions with no sub-peer, 2+-sub-peer followers and agent/cowork/tray bridges are
unchanged. Details in architecture.md §13; regression guard `test_dashboard_collapse`.
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

## #59 — rip out the dual-port compat capability once the realm is migrated  ·  **DONE (v1.46.0)**
**Done:** compat config, multi-port bind/election, per-compat WS ingress and the `connectToPeer` fallback are gone;
the handler extraction is kept. `test_dual_port_live` was deleted, and `test_migrate_dial_live` became
`test_gateway_subpeer_delivery_live` (keeps only the #60 loopback re-splice guard). See architecture §13 v1.46.0.
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
