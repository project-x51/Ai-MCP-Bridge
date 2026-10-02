# Open issues / planned work

Resume-ready register of open work. Built items live in `architecture.md` §13 (the version history /
changelog). This file is the *forward* list. Newest/highest priority first. Issue numbers continue the
project's `#NN` sequence.

---

## RESUME STATE (updated 2026-10-03, v1.72.0) — read this first after a compact
**Current version: v1.72.0** (#86 + #87: the dashboard's log panel opens with the selected node's DETAILS — its line, state,
three-part progress, ETA, who / when, the ✎ attribution, a question's answer, its `details` text and `data` as a collapsible JSON
tree with Copy, fetched on demand by the line's entry id — and ¶ / {} markers on lines and entries; the log runs OLDEST FIRST,
follows the newest end, "N new ↓" when scrolled up, load older keeps the place, a per-viewer toggle for newest first; code done
in a worktree for review, NOT committed, NOT deployed; **no wire change** — the page uses the v1.60 `entry` request, so it is
wire-compatible with 1.66 – 1.71 and needs no capability). Before that **v1.71.0** (#85: QUESTIONS — `log ask` / `aimb-log --ask … [--choice "A" --choice "B"] [--wait 30m]` posts a question (a
context whose line carries `question`; state blocked for older hosts), the dashboard answers it (a "?" bubble, click → Answer…
with the choices / free text; Withdraw…; a "? N" badge on collapsed ancestors), the owner releases waiting scripts (exit 0 / 10 /
11 / 12 / 13) and tells the session at once (`activity_answer`, the answer only in the body); `expires`, withdraw; code done in a
worktree for review, NOT committed, NOT deployed; **wire-compatible with 1.66 – 1.70** — format stays v5; a ≤1.70 owner just can't
be answered from a 1.71 dashboard, `owner-unsupported`). Before that **v1.70.0** (#83 + #84: Edit text… and Message session… on any node from the dashboard — `edit_text` sets a
node's line for its session, attributed on the line (✎) and in the log, notice `activity_text_edited` (batched); `message`
logs on the node and delivers to the session at once, notice `activity_message`, "not delivered" for a script-only session;
code done in a worktree for review, NOT committed, NOT deployed; **wire-compatible with 1.66 – 1.69** — format stays v5, hosts
upgrade one at a time; a ≤1.69 owner just can't be edited / messaged from a 1.70 dashboard, `owner-unsupported`). Before that
**v1.69.0** (#82: the plan workflow — move / re-parent with history, insert anywhere + reorder by a
fractional rank, abandon any context with a cascade, the agent on its item, dashboard Move up / down / to + drag and drop; code
done in a worktree for review, NOT committed, NOT deployed; **wire-compatible with 1.66 – 1.68** — format stays v5, hosts
upgrade one at a time; a ≤1.68 owner just can't be moved / reordered from a 1.69 dashboard, `owner-unsupported`). Before that
**v1.68.0** (#80: a dashboard action tells the owning session — `activity_changed` system messages,
batched per session; code done in a worktree for review, NOT committed, NOT deployed; **wire-compatible with 1.65 / 1.66**,
so hosts can upgrade one at a time — a ≤1.66 owner simply sends no notices). Before that **v1.66.0** (#79: the `--plan` text footgun + THREE-PART progress done / skipped / total, a done node = 100%;
plus the live-checklist snippet + orchestrator briefing, cyan = in progress, a session glyph — code done in the working
tree for review, NOT committed, NOT deployed. **v1.65.0 is deployed live on every host; 1.66 is wire-compatible with 1.65
(format stays v5), so hosts can upgrade one at a time** — then republish the realm block from config.example.json). Before
that v1.65.0 (#70 step 6d — the LAST #70 build step; committed `f545450` and since deployed on every host; see the
v1.65.0 paragraph and the DEPLOY CHECKLIST below). Previously
v1.64.0 (#70 step 6c + #75 part 2, committed `23db35e`). Before that v1.63.0 (#70 step 6b: TODOS AND PLANS — `todo` / `skipped` context states, plan items, `plan:[…]`
with a keep-and-append re-plan rule, "N of M done" rollup, 7-day `finished_visible_hours`, open items never expire or get
evicted, the day-rollover CARRY-FORWARD; plus 6a adjustments: RELATIVE batch paths, the "most recently set" headline, host
tags only where they differ; record / slice format v3; code done, NOT yet deployed — live hosts run v1.54.0). v1.62.0
(#70 step 6a) is committed (`2d78a21`); v1.63.0 is in the working tree for review. The rebuilt tray (`PrepareShutdown()`
before the kill) is NOT installed: only a scratch build proved it compiles; Robin runs `tray/windows/build.cmd`.
Everything below is durable; nothing important is only in chat.

**2026-10-03 (v1.72.0):** Built **#86 + #87** (see "#86 as built", "#87 as built" and architecture.md §13 "Built (v1.72.0)"). PAGE
ONLY (`dashboard.html`) + `BRIDGE_VERSION` / package.json 1.72.0. The log panel is a column: header (+ the "⇅ oldest first" toggle),
a collapsible DETAILS section (≤ 45vh) for the selected node / a session's own line — `AimbAct.nodeFacts` + the line's details and
data, fetched by its entry id through the existing `activity {entry:{id, host}}` (the owner answers; another host's over
`ACTIVITY_REQ` op `entry`) — and the entry list with its own scroll. Details / data are built from DOM nodes + `textContent` only
(`ddBuild`, `AimbAct.jsonTree`; `actReconcile` build rows). The log runs oldest first (`AimbAct.logRows`), follows the newest end
(`atEdge`, `logAnchor` / `logScrollFix`), shows "N new ↓" when scrolled away, MERGES new first pages (`actPollLog` +
`mergeNewest`: older pages and the reader's place kept — 6d re-read everything), and remembers the order per viewer
(`aimb.act.logOrder`, try/catch). Tests: `test_dashboard_activity` 327 (+42; 6 order checks updated), new
`test_activity_detail_live` 14 (+1 mixed vs a real 1.71 owner: 15/15). Full parallel `npm test` (typecheck included): 2740 checks in 59 files, all green on the first run, 5m12s; no #74 flakes.
**Deploy:** any order; nothing to publish; a host serves the page from disk, so a pull + gateway restart (for the version) is enough.

**2026-10-03 (v1.71.0):** Built **#85** (see "#85 as built" and architecture.md §13 "Built (v1.71.0)"). A question is a
CONTEXT whose current line carries `question` {status asked | answered | expired | withdrawn, choices ≤ 8 × 60, free, asked_at,
expires_at?, answer?, by?, at?} — the line's text is the question (≤ 240, refused when longer); the line STATE follows the status
(asked = blocked, answered = done, expired / withdrawn = abandoned), which is all a ≤1.70 host shows. `ask` on a new / line-less
leaf context (or an existing question) makes THAT node the question, anywhere else a child `@?<n>`. Answer (dashboard `answer`
{choice?, text?}, attributed), withdraw (the asker's `state:"withdrawn"`, the dashboard's `withdraw`, or any abandon / cascade),
expiry (`expires`, closed by the bridge). Counts as an item in "N of M done" and of the plan above it. Scripts WAIT on the logger
link (`wait_answer` → one `answer` frame; `--wait`, `--wait-answer`; exit 0 answered · 10 still open · 11 expired · 12 withdrawn ·
13 gone); the session gets `activity_answer` at once (body.agent names an agent that asked). PEER_HELLO `activity_ask:1` →
`remote_hosts[].ask`. Snippet: a seventh line (`--ask "…" --choice "A" --choice "B" --wait 30m waits for the answer`); trust sentence in
the server instructions + the `log` tool. Tests: `test_activity_unit` 849 (+51), `test_dashboard_activity` 285 (+26),
`test_activity_6c_live` 34 (+1), new `test_activity_ask_live` 37 (+4 mixed against a real 1.70 build: 41/41). Full parallel `npm test` (typecheck included): 2684 checks in 58 files, all green, 5m04s (one earlier run: a load failure in `mesh/test_mesh`, green alone 3/3).
**Deploy:** any order; nothing to publish (the snippet's seventh line rides `{log_snippet}`, expanded by each host).

**2026-10-03 (v1.70.0):** Built **#83 + #84** (see "#83 as built", "#84 as built" and architecture.md §13 "Built (v1.70.0)").
Two dashboard actions on any node (a session: each host's own line), through the 6d path to the OWNER: `edit_text` {text,
state?} — a SYSTEM `@~` line taken literally (240 limit, truncated like a report; a state from `editStates`; no state keeps
the line's; details / data kept), the line carries `by` (record `line_by`; gossip, cp, cf, the replay), the entry reads "<text>
(edited by robin via dashboard (HOST))", the session's next report replaces it (a tick keeps it); notice
`activity_text_edited` (batched, merged by `ACT_NOTICE_COMBINE`: "robin edited 2 lines in @Rel"). `message` {text ≤ 2000} —
a logged entry "robin via dashboard: <120 chars>…" + details, delivered `now:true` as `activity_message` (public subject
"robin about @Rel/@Code: <≤ 6 words>…", the text in the body); the result says `delivery` live | parked | none (none =
"not delivered: the session has no inbox"). PEER_HELLO `activity_msg:1` → `remote_hosts[].msg`; older owners
`owner-unsupported`. Trust sentence in the server instructions + the `log` tool. Dashboard: the two dialogs, ✎ on an edited
line, 💬 / ✎ log entries. Tests: `test_activity_unit` 798 (+34), `test_dashboard_activity` 259 (+29), new
`test_activity_msg_live` 34 (+3 mixed against a real 1.69 build: 37/37); full parallel `npm test` 2569 checks in 57 files, all green on the first run (4m40s, no flakes).
**Deploy:** any order; nothing to publish (no snippet / reminder change).

**2026-10-03 (v1.69.0):** Built **#82** (see "#82 as built" and architecture.md §13 "Built (v1.69.0)"). Order = a fractional
base-36 rank per node, STORED only when placed (else derived from created_at + plan_ix, so the default stays creation order);
siblings: plan items, then contexts, then agents. `log` / `aimb-log`: `before` / `after` / `position` (`--before` / `--after` /
`--first` / `--last`) for new items or a reorder; `move` + `to` (`--move` / `--to`) re-parents a node with its subtree — one
record with `moved_from`, the replay maps older records onto the new path, the log pages into the day files under the old path.
`abandoned` on any context, cascading to open descendants ("abandoned with <path>"). Dashboard: rank order, the working agent
beside its plan item, greyed abandoned subtrees, Move up / down / to… (picker + confirm), Abandon…, drag and drop — new actions
`move` / `reorder` (#80-notified). PEER_HELLO `activity_plan:1`. Tests: `test_activity_unit` 764, `test_dashboard_activity` 230,
new `test_activity_plan82_live` 26; mixed 1.68 ↔ 1.69 live check 11/11; full parallel `npm test` (typecheck included) 2472 checks in 56 files, all green on the first run, 4m17s, no flakes. **Deploy:** any order; nothing to publish (the snippet
is unchanged).

**2026-10-03 (v1.68.0):** Built **#80** (see "#80 as built" and architecture.md §13 "Built (v1.68.0)"). After every applied
state-changing dashboard action the OWNING gateway sends the node's session a `system` message, verb `activity_changed`
(subject "robin skipped @Dash test/@Docs"; body `{action, path, host, from_state, to_state, by:{user, host}, entry_id, …}`);
several within `activity.notice_batch_sec` (3 s) become one ("robin skipped 2 items and abandoned 1 in @Dash test", body
`actions:[…]`). Recipient: the session's live sub-peers mesh-wide (case-insensitive), else parked for its durable
registration on the owning host, else nothing (script-only). Prepare-shutdown / a clean exit flush the queue. The generic
hook for #83 / #84 / #85 is `notifyActivitySession(ident, {verb, subject, body}, {now})` in `bridge.mjs`. New
`test_activity_notices_live` (26; 18 FAIL on 1.66); `test_activity_unit` 694. **Deploy:** any order (no wire change);
nothing to publish.

**2026-10-03 (v1.67.0, tests only — `BRIDGE_VERSION` stays 1.66.0, nothing to deploy):** Built **#81 step 1 + "test
groups"** (see "#81 as built" and architecture.md §13 "Tests (v1.67.0)"). The 54 scripts moved into nine group folders
(`tests/<group>/`) and run under node:test — `npm test` runs the groups in parallel (concurrency 4) in **~3m50s instead of
~12m** serially; `test:group` / `test:file` / `test:serial` / `test:legacy`; `TEST_ONLY` for one check; a disjoint
100-port block per script; the `aimb-dashboard` reporter shows a run live on the board (`AIMB_TEST_LOG_*`). Full parallel
run: 2315 checks, 54/54 green. Found on the way: `test_grant_notice_live` inherited `stableIds` from the operator's
config.json (it failed 2 checks anywhere without one, e.g. a worktree) — now pinned; `test_dashboard` wrote host aliases
into `src/config.json` and `test_page_e2e` read the live token from it — both now use a temp config.

**2026-10-03 (v1.66.0):** Built **#79** (see "#79 as built" and architecture.md §13 "Built (v1.66.0)"). Progress is
{done, skipped, total} (`skipped` optional on the wire, only when > 0 — a 1.65 reader ignores it, a missing one is 0);
rollups sum the three parts for a common unit, average the done / skipped fractions for mixed units, and "N of M done"
counts every item (skipped + abandoned → skipped; failed / open → remaining); a done node is 100% (a full bar), an abandoned
node's remainder is skipped. Dashboard: a grey-hatched skipped segment, cyan = in progress (`--act-running`), green = done
only, a session glyph (window; face by client kind) shared by the Activity tree, the Sessions table and the mesh map.
`aimb-log --plan` refuses status text ("… looks like status text — put text before --plan"). Snippet + realm reminders
brief orchestrators and keep checklists live (`updated_at` 2026-10-02T12:00Z in config.example.json; the live
`src/config.json` was NOT touched — Robin republishes). **Deploy:** compatible with 1.65; hosts can upgrade one at a time
(a 1.65 host shows no skipped segment and keeps the old "skipped left out of M" bar for its own board). Live-checked: a
1.65 and a 1.66 bridge exchanged activity both ways (full slices + deltas) with no errors. Tests: `test_activity_unit` 684 (+20 #79), `test_dashboard_activity` 205 (+19: three-part bars, labels, done = full, the 1.65 bar widened, client == bridge on one fixture, cyan, session glyphs), `test_log_script_live` 57 (+3: --plan text refusal, text-first plan, --progress skipped), `test_activity_6c_live` 33 (+2: live snippet, orchestrator briefing), `test_activity_dashboard_live` 44 (+1: client_kind); 4 live tests updated for M = every item. Pre-change: 20 lib checks fail against the 1.65 library, 6 dashboard checks (+ the #79 block crashing) against the 1.65 page. Full suite 2313 checks in 54 files (typecheck clean): 2311 passed; the 2 failures were the pre-existing midnight flake in test_dashboard_activity (a fixture "started 1 h ago" gets a date prefix before 01:00 local), which passes when rerun after 01:00. Live check: a 1.65 and a 1.66 bridge exchanged activity both ways, 8/8, no errors.

**2026-10-02 (v1.65.0):** Built **#70 step 6d** ("Decisions before 6c and 6d" + "Decisions after 6c, for 6d") — **the #70
build plan is COMPLETE**; next is the deploy (checklist below). The dashboard's first WRITE path: a **right-click menu** on
every row (Menu key / Shift+F10; long-press on touch) with only the actions valid for it — plan item done / skip / reopen /
abandon; plan complete / abandon plan / reopen plan; agent or session abandon open plan items (it keeps running) / mark
finished (when stale or gone) / dismiss (stale, gone or finished; never with open plan items) — plus copy path / its
aimb-log command (never a token) / entry id and the view-only **Pin / Hide** (per browser). Abandon plan, finish and dismiss
ask first; the row shows a spinner, then ✓ or the error code. The dashboard sends `{type:"activity_action"}` (dashboard
sockets only); the node's OWNER applies it — another host's over the hub link as the new `ACTIVITY_ACT` frame (queued and
rate-limited like a remote fetch) — and logs it "… by <user> via dashboard (<host>)" (`by` + `act`). **Finishing an agent
never completes its plan** (an agent's own line left the plan-end rule; agents / the session end a plan through a new
plan-end MARKER that complete / abandon plan set); dismissal is a logged `dismiss:true` entry the replay honours (it survives
a restart; nothing is erased); the carry-forward record carries each node's entry count (exact across restarts). **The log
panel replaces the Log rows**: click a row to select it, its subtree log shows beside the tree (below on a narrow screen).
Open plans expand their ancestors; header counts ignore the filters; the "plans open" slider spans 0 – 7 days; the
abandoned glyph is visible in dark mode; a viewport tag (and the phone CSS that never applied now does). Records + slices
are format **v5** (`activity_gossip:5`). Tests: `test_activity_unit` 664, `test_dashboard_activity` 186, new
`test_activity_actions_live` 43; full suite 2268 passed, 0 failed (54 files, typecheck clean, first run). See architecture.md §13 "Built (v1.65.0)" and #70 "6d as built" /
"Questions after 6d". The working tree is for review on top of the 6c commit (not committed).

**DEPLOY CHECKLIST — v1.55.0 → v1.65.0 (every live host still runs v1.54.0):**
1. **Update the code on every host** (ROBIN-Z790 + LITTLE-001 share the Dropbox tree; Robins-Mac and phub-lnx-01 get the
   same `src/` — tools/ included: the doorbell, `aimb-log.mjs` and its `--token-file`). No `config.json` edit is needed
   for the code itself.
2. **Rebuild the tray** (`tray/windows/build.cmd` on ROBIN-Z790; it calls `POST /admin/prepare-shutdown` before it kills
   the bridges, v1.59.0) — Dropbox carries the exe to LITTLE.
3. **Restart every host's GATEWAY on 1.65.0 TOGETHER** (and every follower bridge with it — restart the Claude app / the
   tray's "Restart Bridges…"; the Mac and phub-lnx-01 restart their bridges). Activity formats changed at 1.62 / 1.63 / 1.64 /
   1.65: hubs of different formats skip each other's activity frames (each host's own board still works), and a 1.64 owner
   answers a 1.65 dashboard's action `owner-unsupported` — so the board is whole only once every gateway runs 1.65.0.
4. **LITTLE-001's tray** is not running: start the NEW tray exe on its interactive desktop (RDP via the dyndns name, port
   3390 — SSH can't show it), then use its Restart Bridges… once.
5. **Token-file hosts:** a host whose MCP config passes the token as an env VALUE (`AI_BRIDGE_TOKEN`) gets no
   `--token-file` in its reminders / snippet / copied commands — switch it to `AI_BRIDGE_TOKEN_FILE=<path>` (the Mac already
   does; check ROBIN-Z790, LITTLE-001 and phub-lnx-01). A token in `config.json` needs nothing (the scripts read it).
6. **Then publish the realm block:** copy `config.example.json`'s `behaviors.realm` (the doorbell reminder + the
   `client:code` / `client:cowork` activity reminders, both `"id":"activity"`) into ONE config — the shared Dropbox
   `config.json` — with a fresh `updated_at`. Only after EVERY host runs ≥ 1.64 (the `id` field: a ≤1.63 host keeps only
   the last of the two code reminders). A host's own `connect`/`client`/`code` default would override it — remove any.
7. **Verify:** `list_sessions` shows 1.65.0 everywhere; on each host's dashboard (`http://127.0.0.1:12318/?token=…`) the
   Activity section shows every host's sessions; a session's `register_self` returns the doorbell + activity reminders with
   `--token-file` where expected; one test plan on one host, ticked by right-click from ANOTHER host's dashboard (the entry
   says "… via dashboard (<that host>)"); the tray's Restart Bridges… logs "prepare-shutdown — flushed …".

**2026-10-02 (v1.64.0):** Built **#70 step 6c** ("Decisions before 6c and 6d") and **#75 part 2** — `{log_snippet}` (the
paste-ready aimb-log command: absolute node + script paths, --session / --project, --token-file when the bridge read its
token from a file, a `--path <agent-path>` placeholder, then six guidance lines) and `{log_tool_hint}` (the same for the
`log` tool, Cowork) in the new `lib/log-snippet.js`; `config.example.json`'s realm block keeps the doorbell reminder and
adds `client:code` / `client:cowork` activity reminders (a config default may now carry an optional `id` so two share
one (operation, scope, match) — publish the block once every host runs 1.64); `{doorbell_cmd}` + `set_wake` carry
`--token-file "<path>"` (never the token) and `aimb-log.mjs` gained `--token-file` (authoritative, exit 64 naming an
unreadable file); the server instructions name the `log` tool. **Plans:** a new `abandoned` state (plans + plan items
only, else `not-a-plan`; greyed, a dashed glyph); a plan ENDS only when every item is done or its node is set done /
abandoned (supersedes 6b's done-or-skipped; the owner finishing no longer ends it) — every node of an open plan never
expires / is never evicted / is carried forward; **auto-abandon** after `abandoned_plan_days` (90) of a gone session
(entries `by:"bridge"`, system messages: no activity). **Dashboard:** the Activity section is open by default; open plans
expanded by default, ended ones for `finished_plan_open_min` (120, sent with the board; a live "plans open" slider);
gossiped per-node entry counts (`log_n` / `log_partial`, "N+ entries"); the RUN BOUNDARY in history (`run_start`,
`earlier_cursor` + `earlier:true` = "show earlier runs", `pruned` = "earlier history pruned"; local + remote);
top-level host tags vs the HOME host (earliest-created root, ties by name; `s0` on every record); a "plans" filter;
rollups that follow the filters; pills after the name (aligned bars); `data-*` row hooks for 6d. Records + slices are
format **v4** (hubs `activity_gossip:4`). Deploy = restart every host's gateway on 1.64.0 together, then publish the realm
block. See architecture.md §13 "Built (v1.64.0)". **Open before 6d:** "Questions before 6d" in #70.

**2026-10-02 (v1.63.0):** Built **#70 step 6b** ("Decisions before 6b") — a context with a todo status: `todo` (☐) and
`skipped` (struck through) states; a context created by a plan or whose first line is `todo` is a PLAN ITEM for good
(☑ when done; `bad-agent-state` for agents, `not-a-plan-item` for ordinary contexts); `plan:["A","B"]` (script `--plan A B`,
`--done`) creates ☐ items in the given order (re-plan: existing items kept untouched, new names appended at the end,
missing ones left alone, a line-less context adopted); a tick needs no text; plan items never go stale (nor gone); a
node with plan items rolls up "N of M done" (skipped left out of M; ordinary children with bars win by 6a's precedence;
a plan item counts only as a todo of its parent); `finished_visible_hours` 168; open items never expire and are never
evicted; an ended plan (all done / skipped, or its owner finished) expires 7 days later; at each local day rollover (and
once after a restart without one) the gateway writes a `cf` CARRY-FORWARD of every open plan item + its ancestors and
of every node that would fall out of the replay window, so a weeks-old plan survives restarts and retention. Batch item
paths are now RELATIVE to the batch path (a leading `/` = absolute); the multi-host headline is the host that most
recently SET one (6a picked the most recently active host with a line — a real difference, now tested); host tags only
where a node's host differs from its parent's; the expanded multi-host session shows each host's own line. Records +
slices are format **v3** (v2 records still read; a 1.62 hub's frames are ignored — hubs declare `activity_gossip:3`).
Test-only clock hook `AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS`; new `test_activity_carry_live`. Deploy = restart every
host's gateway on 1.63.0 together. See architecture.md §13 "Built (v1.63.0)". **Open before 6c:** "Questions before 6c"
in #70. **#75 part 2** (the `--token-file` in `{doorbell_cmd}`) was waiting on this step's `bridge.mjs` edits — it can go
ahead once v1.63.0 is committed.

**2026-10-02 (v1.62.0):** Built **#70 step 6a** (the revised step 6, "Step 6 redesign") — one tree of NODES per
session (the session = the root; agents start / finish / go stale / gone; contexts carry a line, progress and an ETA;
either contains either; intermediates implicit), the `/`-path grammar (`@` = context, `@"a b"` quotes, `@~` on the last
segment = current line, `@root` = the node itself, depth ≤ 6) with the old `agent` + `@~Ctx` notation mapping onto it,
128 agents + 4096 nodes per session (subtree eviction), recursive rollup, per-node logs merged per subtree (paging into
the day files for any node, local and remote), contexts showing their nearest agent's staleness (directly under the
session: the session's own reports), and **batch** logging (`items:[…]` ≤64 / ≤64 KB, one result each, one follower frame,
the logger WS, `--batch`, `--stream` arrays). JSONL records and gossip slices are format **v2** (a 1.58–1.61 record is
skipped; a 1.61 hub's activity frames are ignored — hubs declare `activity_gossip:2`). The dashboard renders the tree to
any depth (Projects / Sessions / Nodes). Deploy = restart every host's gateway on 1.62.0 together (1.61 and 1.62 hubs
don't exchange activity). See architecture.md §13 "Built (v1.62.0)". **Open before 6b:** "Questions before 6b" in #70.

**2026-10-02 (v1.61.0):** Built **#70 step 5** — the dashboard's **Activity** section (collapsed by default; a tree:
project → session → agent → context → log entry; status glyph with a stale ring, hover times, pills incl. a distinct
host-down badge, 🔔, ⌛, the stale slider computed in the page, active only, project cycle + depth control, light/dark
tokens). Dashboards now SUBSCRIBE (`activity_sub`) and get a full board then per-dashboard DELTAS ≤1/s (seq gap →
resync); `activity {log}` pages continue into the day files (local and remote); remote fetches are QUEUED on the
requesting gateway at the owner's rate (`busy` beyond 64 per link / 16 per dashboard); page leaves get no activity;
`host_down` / `hosts_down` and `bell` on the board; a duplicate host name is logged. Deploy = restart each host's
gateway on 1.61.0 (a 1.60 peer ignores `bell` and still answers fetches; a 1.60 owner's `rate-limited` is queued
around). See architecture.md §13 "Built (v1.61.0)". **Open before step 6:** see "Questions before step 6" in #70.

**2026-10-01 (v1.60.0):** Built **#70 step 4** — the activity identity now includes the HOST (each host writes only its
own entities; the board groups a session's entities across hosts, every entity tagged with its host); each gateway
gossips its own host's board to every peer hub (`ACTIVITY_SLICE`: a full slice on (re)link / request, then deltas, ≤1
frame per second per link, 256 KB cap newest-first, ownership = the link's host); remote `log` (paged) / `entry`
(details + data) are fetched from the owning gateway over the same link (`ACTIVITY_REQ`/`_RES`, rate-limited by the
owner; `owner-unreachable` when it is down); prepare-shutdown and a clean exit send `ACTIVITY_DOWN` so peers show that
host's agents gone at once; a script report is also refused for a BARE session of another user. Deploy = restart each
host's gateway on 1.60.0 (a ≤1.59 hub simply isn't on the 1.60 boards). See architecture.md §13 "Built (v1.60.0)".

**2026-10-01 (v1.59.0):** Built **#70 step 3** — `tools/aimb-log.mjs` reports to the board without registering (a
token-gated `logger` leaf on the gateway's WS port; `--session`/`--project`/`--user` identity; one-shot or `--stream`
NDJSON; exit 0/4/64; `--token` refused). The gateway refuses a report for a session live on the mesh under another
user (`session-user-mismatch`). The gateway answers `POST /admin/prepare-shutdown` (loopback + bearer token) by
flushing activity checkpoints and draining writes; the tray calls it before it kills the bridges. Deploy = restart
each bridge on 1.59.0 (only the gateway matters: the script says `gateway-unsupported` to a 1.58 gateway), then
rebuild + restart the tray.

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

**Still open:** #81 node:test migration (step 1 + test groups + the dashboard reporter built, v1.67.0; next: convert files to native describe/it one by one), #78 making use of latest Claude features (channels / plugin / hook; after the #70 deploy), #77 topic tags + By-topic view (after the #70 deploy), #74 federation test flakes, #70 agent activity board (built through 6d, v1.65.0 — next: the deploy above, then close it), #76 merged-log gap (low), #65 self-updating bridge (desirable, spec first — would automate host upgrades), #53 Cowork doorbell,
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

## #88 — stable node identity: creator-chosen keys, internal ids, paths as a shorthand (v2.0)  ·  **OPEN (next release)**
Robin, 2026-10-03: "moving a context is extremely messy … decoupling names/labels from what we log so the logs are more
agile". Today a node's PATH is its identity, so every move or rename has to rewrite history (#82's `moved_from` aliases,
replay rewriting older records through later moves, re-keying day files). Agreed design (Robin + Bridget):

- **Identity = creator + key.** The creator (an agent, or the session) names a node with a short KEY it chooses (`docs`,
  `review`, `fix-79`), unique within that creator: full identity `fix-79:docs`. The key never changes.
- **Label and location are attributes.** A node's label (what is shown), parent and rank are set by small node records
  and change at any time, from the tool, the script or the dashboard. A move or rename is ONE record; nothing is
  rewritten.
- **Create once, then address by key.** Location is given only at creation: `--key docs --under "@Next release" --label
  "Write the docs"`; afterwards `--key docs --state running --text "…"`, `--key docs --done`. Creating is IDEMPOTENT
  (registering an existing key updates it), so a retry after a lost response never duplicates, and there is no round trip.
  Plan items get keys too (`--item docs "Write the docs"`); insert/reorder/tick use keys.
- **Why not server-issued GUIDs:** an LLM agent must carry an opaque id across many calls and compactions (typos, lost
  ids), and a lost create response makes a retry duplicate. Readable keys can be reconstructed.
- **Paths become a shorthand.** `--path "@Next release/@Docs"` still works (old snippets, quick logging): it resolves
  against the CURRENT tree, or creates a node whose key is the last segment. After a move or rename the old path stays an
  ALIAS for that session, so an agent still writing it lands in the moved node.
- **Internal ids.** Each node has an internal id = a hash of (owner host, session, creator, key). Log entries, day files,
  a per-host index (id → day files) and gossip use it. A node's log is "entries whose node is in this subtree", computed
  from the current tree, so history follows moves for free. An entry may keep the label it had when written (an "at the
  time" tooltip).
- **Merge:** pointing node A at node B shows A's entries under B — the fix for a mistyped path like Bridget's stray `@#79`.
- **The dashboard acts on ids, never paths** (ends quoting trouble with `:`, `/`, `+` in names). Cross-session moves
  become possible later.
- **Migration:** on first start, existing path-keyed history converts; each legacy path gets the deterministic id
  hash(host, session, path) so every host derives the same ids and replay is reproducible.
- **Compatibility:** a v2 host can still feed v5 (path-based) slices, projected from its current tree, to ≤1.72 hosts;
  they see a move as remove + add, as today. The break is mainly inside `activity.js` and the dashboard tree.
- **Reusing a finished key** reopens that node; new work needs a new key (`docs-2`). The snippet says so.
- Complements #77 (topic tags): ids give the structure, tags the cross-cutting views.

**Plan:** spec first (record formats, the key/path/alias resolution rules, migration, wire projection, the API and
snippet, the dashboard changes, a build in steps), reviewed by Robin; then build step by step as v2.0.0.

## #87 — log panel order: oldest first, auto-scroll to the bottom  ·  **DONE (v1.72.0)**
Robin, 2026-10-03, asking whether the log panel should run the other way.
- **Today:** the log panel (6d) lists newest first; older pages load at the bottom.
- **Proposal:** chat-style. The oldest entry is at the top and the newest at the bottom. The panel opens scrolled to
  the bottom and follows new entries while the reader is at the bottom; scrolling up pauses following and shows an
  "N new ↓" chip. "Load older" moves to the top and keeps the scroll position when older entries are added.
- **Open question:** whether to keep a toggle for newest-first.
- **Decided (Robin, 2026-10-03):** oldest first WITH a toggle (per viewer).

**#87 as built (v1.72.0, 2026-10-03)** — see README "Details, data and the log order" and architecture.md §13 "Built (v1.72.0)".
- **Order:** the bridge still pages newest first; the page maps it (`AimbAct.logRows`): oldest first by default, the end-of-log
  row ("load older…", "start of this run · show earlier runs…", "earlier history pruned", "no entries") at the TOP, the "— earlier
  runs —" separator between the runs in either order; #82's history under a moved node's old path and the merged subtree log
  unchanged.
- **Following:** a new selection (and ↻, the chip, the toggle) opens at the newest end; the list follows it while the reader is
  within 24 px (`AimbAct.atEdge`, from the list's own scroll events). Scrolled away: new entries arrive without moving the view
  and the **"N new ↓"** chip floats at the bottom of the list (newest first: "N new ↑" at the top); a click jumps back and follows.
- **Keeping the place:** before each re-render the first visible ENTRY and its offset are noted (`logAnchor` — never the "load
  older" row, which goes away) and restored after it (`logScrollFix`), so a page added above (load older) or entries added
  below never move what the reader looks at.
- **New entries are merged, not re-read** (a 6d rough edge): when the board's count for the selection moves (≥ 1.5 s after the
  last read) or after one of our own actions, the panel reads the FIRST page again and `AimbAct.mergeNewest` puts only the newer
  entries on top of what it holds — the older pages, their cursor and the separator stay (6d dropped them; it also never
  refreshed once an older page was loaded, and lost the "new entries" signal while a page was loading). More than a page at
  once (no overlap) → that page replaces the list. A poll and a page never overlap.
- **Toggle:** "⇅ oldest first" / "⇅ newest first" in the panel header (a tooltip + aria-label); kept per viewer in
  `localStorage` `aimb.act.logOrder` (try/catch on read and write: a private window / blocked or throwing storage starts at
  oldest first and the toggle still works for the page).
- **Layout:** the panel is a column (header, the #86 details, the list with its own scroll — the chip floats over it); under
  900 px it sits below the tree at up to 85vh, so the list still scrolls by itself on a phone (6d let the page scroll).
- **Tests:** `test_dashboard_activity` — the pure helpers (logRows both orders + the separator, mergeNewest, atEdge), and with a
  fake layout (20 px rows, a 100 px list): oldest first + "load older" on top + opened at the bottom, scrolling up pauses, a
  merged poll (first page, no cursor; 2 new at the bottom, place kept, cursor kept, "2 new ↓"), the chip, load older keeping
  the first visible entry 10 px down, the toggle (newest first at the top, localStorage), newest first + a new entry on top
  without moving the view ("1 new ↑"), back; storage that throws (the toggle in memory; a fresh page loads oldest first with
  no script error) and a stored "newest" on a fresh page. 6 older checks now expect oldest first.

## #86 — click an item or log entry to see its details and data  ·  **DONE (v1.72.0)**
Robin, 2026-10-03.
- Entries already carry `details` (≤ 4 KB) and `data` (≤ 16 KB JSON); the dashboard doesn't show them.
- **Proposal:** clicking a node row or a log-panel entry opens a details pane: its text, state, progress, ETA, who and
  when, `details` as plain text, and `data` as a collapsible JSON tree with a copy button. A small marker on rows that
  have details or data.
- Remote entries fetch `details`/`data` on demand (`ACTIVITY_REQ`), not in gossip, to keep slices small.

**#86 as built (v1.72.0, 2026-10-03)** — see README "Details, data and the log order" and architecture.md §13 "Built (v1.72.0)".
- **What the dashboard had:** 6d's log panel already expanded a log ENTRY's details (a `<pre>`) and data (`JSON.stringify` in a
  `<pre>`), fetched by id; the node itself had nothing, and nothing marked a row's line.
- **Where it lives (chosen: the top of the log panel).** Selecting a row already opens the panel, so a DETAILS section sits
  between its header and the entries — collapsible (▾ / ▸, the ¶ {} marker stays on the folded header), at most 45vh with
  its own scroll; the entries below keep theirs. A session row (or one host's line of a multi-host session) shows that host's
  own line.
- **Contents:** the rendered line; Kind (agent / context / plan item / question / session), State (+ "was …" when stale /
  gone, host down, a plan item's state), Progress (#79's three parts + %, reported or rollup), ETA, Who (session · project ·
  user on host), Line set (when + "by its session" or #83's "edited by robin via dashboard (HOST)"), When (started / created ·
  last activity · finished / gone), a question's Choices / Asked / Expires / Answer / Answered, Log (the subtree's count);
  then `details` (plain text, Copy) and `data` as a collapsible JSON tree (Copy = pretty JSON). Log entries expand into the
  same details + tree block (it replaces 6d's `<pre>`).
- **On demand, no wire change (chosen over a new `activity_detail` request):** the board already carries the line's entry id
  + `has_details` / `has_data`, and the v1.60 `activity {entry:{id, host}}` request already returns a CURRENT line's details /
  data by id from its owner's memory (another host's over `ACTIVITY_REQ` op `entry`, queued at the owner's rate) and an older
  entry from the owner's day file. So nothing was added to the bridge or the hub protocol, no capability is needed, and every
  v5 owner (≥ 1.65) answers — checked live against a real 1.71 owner. The page asks outside the render, one fetch at a time per
  node, keeps the last entry shown while a newer line's is in flight ("updating — its line has changed…"), fetches nothing
  while the section is folded, and turns refusals into a sentence + Retry: "The details are on HOST-B, which can't be reached
  right now" (owner-unreachable), "… which runs an older bridge" (owner-unsupported — a pre-1.60 owner; none is on a v5
  board), "Not available on HOST-B any more …" (unknown-entry), "HOST-B is busy — retry in a moment", "No activity from …
  is held here any more" (unknown-host).
- **Markers:** "¶" = the line has details, "{}" = data — a small boxed marker right after a tree row's line text (after ✎;
  the bar column unchanged) and at the end of a log entry (replacing 6d's "⋯"); the legend names them.
- **Escaping:** the section, the facts, the details text and the JSON tree are DOM nodes with `textContent` only (the page's
  other rows stay escaped HTML via `esc`). `actReconcile` gained build rows (`{build, sig}`) for the entry blocks — rebuilt
  only when their fetch state changes, so a JSON node the viewer opened stays open across the 1 s re-render and deltas.
- **Also:** the panel title shows the display path ("@Next release/@Docs"; the quoted path on hover).
- **Tests:** `test_dashboard_activity` — nodeFacts (agent: three-part progress, ETA, who, the ✎ line, when, count; a question
  answered / open; a plan item; a session), jsonTree (an `<img onerror>` key and a `<script>` value are text; types; open depth;
  > 50 closed; `{}`), the markers (tree rows, session row, entries, tooltips, bar column), the section (above the list, the line,
  the facts, loading), the fetch by entry id + host after the board, ESCAPING of details with `<img onerror>` / `<b>` and data
  with `<script>` (no element, nothing ran), both Copy buttons, an opened JSON node surviving unrelated deltas, a new line →
  a new fetch with "updating", folded → no fetch, reopened → fetch, a remote node (host HOST-B), owner-unreachable → the
  sentence + Retry, owner-unsupported → "runs an older bridge", a session selection, a node without details, a log entry's
  block (escaped, right below its entry). New `test_activity_detail_live` (two loopback hosts): the board / delta frames and
  the `activity` tool carry the flags and the entry id, never the text; a remote current line's details + data from the
  owner (memory), a local one, a 300-row data value across the hub link, an older entry from the owner's day file, a line that
  moved on (new id; the old one now from the file), unknown id / host, an owner that went away refused promptly; + 1 with
  `AIMB_TEST_OLD_BRIDGE` (a real 1.71 owner answers the same way).

**Questions after #86 / #87 (not decided):**
- **Details of a node whose line has none:** the section says "Its line has no details or data." — an earlier line of the same
  node may have had some (they are on its log entries). Fall back to the newest entry with details?
- **Large data:** ≤ 16 KB is rendered whole (a 300-row array is fine); a viewer-side "show first 200" cut was not needed.
- **The 45vh cap** on the details section suits a laptop; on a tall monitor it could grow. A drag handle between the details
  and the list?
- **Remember the folded details section** per viewer (like the order)? Today it opens with every page load.

## #85 — questions as a type of context, answerable from the dashboard  ·  **DONE (v1.71.0)**
Robin, 2026-10-03.
- **Proposal:** a session or agent can post a QUESTION node (`--ask "<question>"`, optionally `--choices "A" "B"`,
  the tool's `ask`). It shows with a distinct glyph and an "awaiting answer" state, and counts as blocked for its plan.
- Robin answers on the dashboard (pick a choice or type free text). The answer is logged, attributed, and delivered to
  the asking session as a message (uses #80's notice path, or #78's channels when there).
- The asker reads the answer from the tool result or inbox; the node moves to answered.
- **Hook (built in v1.68.0):** `notifyActivitySession(ident, {verb:"activity_answer", subject, body}, {now:true})`.
- **To decide:** timeouts, who may answer (any viewer, or only the project's user), and whether an agent's question
  goes to its orchestrator first.
- **Decided (2026-10-03, Bridget's defaults):** any dashboard viewer answers (attributed like every action); no timeout by
  default, an optional `expires` marks it expired; an agent's question is answered like any other and the answer goes to its
  SESSION (the orchestrator relays it); a waiting agent (no inbox) uses the script's `--wait`.

**#85 as built (v1.71.0, 2026-10-03)** — see README "Questions" and architecture.md §13 "Built (v1.71.0)".
- **The model (chosen: the question rides the LINE).** A question is a CONTEXT whose current line carries `question`
  {status, choices, free, asked_at, expires_at?, answer?{choice?, text?}, by?, at?}; the line's text is the question. Why the
  line and not a new node kind: the line already travels everywhere (records, cp / cf, gossip, the replay, the boards) and #83
  proved the pattern (`line_by`), so no new record / slice format; a ≤1.70 host simply drops the field and — because the line's
  STATE follows the status (asked = blocked, answered = done, expired / withdrawn = abandoned) — shows an ordinary blocked /
  done / abandoned context whose text is the question. Agents never carry one.
- **Where it lands (chosen: both, by a simple rule).** `ask` on a CONTEXT that is new, line-less with no children (not a plan
  item), or already a question → that node; on anything else (an agent, the session, a context with a line or children, a
  plan item) → a new child `@?1`, `@?2` … (1 + the highest `?<digits>` sibling). So an agent asks with its own `--path` and gets
  `<agent>/@?1`, while `--path "lead/@db" --ask …` names the question. The result's `path` names it.
- **Asking:** the tool's `ask` + `choices` (≤ 8, each ≤ 60, distinct) + `free` (free text allowed; default only without
  choices) + `expires` (> 0, ≤ 7 days) + details / data; the script's `--ask "…" [--choice "A" --choice "B" …] [--free] [--expires 2h]` — ONE choice per `--choice`
  (review fix: an earlier `--choices "A" "B"` took every following argument, the positional footgun #79 removed; it was dropped
  before release, no alias); like `--item`, a `--choice` value that looks like status text or is a flag is refused.
  The question ≤ 240 characters — REFUSED (`question-too-long`) rather than cut: a cut question is no question. No text / state
  / bar / plan / position beside it, always logged (`bad-ask`). The tool form returns at once.
- **States:** asked → answered (the dashboard's `answer` {choice?, text?}: a choice matched to its canonical spelling, text only
  when free, ≤ 1000, newlines kept) | expired (the bridge, at `expires_at`: "expired — nobody answered within 2h", `by:"bridge"`)
  | withdrawn. **Withdraw (chosen: `--state withdrawn`, not re-asking):** the asker sends `state:"withdrawn"` (optional text =
  a note: "withdrawn: <note>"); the dashboard has **Withdraw question…**; any abandon of an open question (an ancestor's
  cascade, Abandon plan, a 1.70 dashboard's Abandon…) withdraws it too. Asking again on a CLOSED question starts a new one
  there; on an OPEN one it is refused `question-open` (withdraw it first) — so re-asking never silently replaces a question.
  Other lines on a question: `question-node` (a log-only message is fine); `edit_text` too.
- **Rollup:** a question is an ITEM in "N of M done" (open = remaining, answered = done, expired / withdrawn = skipped); under a
  node holding plan items it is one of that plan's items — an open question keeps the plan open (and protected from expiry).
- **Answering on the dashboard:** a speech-bubble "?" (fuchsia while open; green ✓ answered; dashed grey expired / withdrawn),
  an "awaiting answer" pill and a tinted row; an answered question shows "→ <answer>" after it. Click an open question (or
  right-click → **Answer…**): the shared `actFormDlg` with the question, its choices as a radio group of buttons, a text box when
  free, Answer disabled until something is picked / typed (≤ 1000). No Edit text… / Abandon… on a question.
- **The owner applies it** (forwarded as `ACTIVITY_ACT` for another host's node): an entry "answered by robin via dashboard
  (HOST): SQLite — smaller to ship" (`act:"answer"`), the line done with the answer, then it releases every waiting script and
  sends **`activity_answer`** at once (`now:true`): subject (PUBLIC) "robin answered @Next release/@#85/ask-85/@?1: Postgres or
  SQLite for the cache?" — the question's first words, never the answer; body {action, status, path, host, question, choices,
  free, answer, by, entry_id, session, project, agent, asked_at, ts}. A dashboard withdrawal ("robin withdrew …") and an expiry
  ("question expired …") send the same verb. The result says `released` and `delivery`; "not delivered" is warned only when
  nobody got it.
- **Waiting:** `aimb-log --ask … --wait 30m` asks, then waits on the SAME logger link: `{type:"wait_answer", ref, path,
  timeout_ms}` → one `{type:"answer", ref, result}` when the question closes or the time (≤ 24 h) runs out — a long poll on the
  gateway, no board polling; a dropped link is re-dialled and the wait resumed. `--wait-answer --path <q> [--wait 30m]` waits for
  an existing one. One JSON line {ok, outcome, path, question, choices, answer?, by?, at?, waited_ms, asked?}; **exit 0 answered ·
  10 the wait ran out (still open) · 11 expired · 12 withdrawn · 13 gone** (4 / 64 as always).
- **Attention badge** (deferred from #82): "? N" on a collapsed row with open questions below it, always on the session and
  project rows, and "? N open questions" in the section tag; rows keep their order.
- **Capability:** PEER_HELLO `activity_ask:1` → `remote_hosts[].ask`; answer / withdraw forwarded only to such owners (else
  `owner-unsupported`); the menu hides them for older hosts. A 1.71 follower / script refuses the question fields, `state
  withdrawn` and `--wait` against a ≤1.70 gateway (`gateway-unsupported`). `AI_BRIDGE_TEST_NO_ACTIVITY_ASK=1` (tests only).
- **Snippet + trust:** a seventh `{log_snippet}` line `- Need a decision? --ask "…" --choice "A" --choice "B" --wait 30m waits for the
  answer (exit 0 = answered).` and a `{log_tool_hint}` line (ask + choices, the answer as activity_answer), each ≤ 110
  characters (`test_activity_6c_live` pins 8 lines now). The server instructions and the `log` tool: an `activity_answer` is the
  dashboard viewer's answer to a question YOUR session asked — you may proceed on it within what your user already approved.
- **Tests:** unit (parsing + limits, where a question lands, every transition and refusal, cascade / abandon plan / a 1.70
  abandon, expiry, rollup + plans, notices, the waiter's view, views, gossip incl. junk, records + cf + a 1.70-shaped record, 4
  seeded replay == apply runs), dashboard (glyphs, checkAnswer, the menu per host, the row, the badge, the dialog — choices, free
  text, sending, results — withdraw, a delta), live `test_activity_ask_live` (tool ask, answer → notice at once, script `--wait`,
  an agent's question to its session, federated answers incl. a script waiting on the other host, expiry, withdraw (asker +
  dashboard), timeout, gone, script usage, an older owner refused, the trust wording; mixed vs a real 1.70 build: 41/41; review fix: `--choice` one per flag).
  Full parallel `npm test` (typecheck included): 2684 checks in 58 files, all green, 5m04s (an earlier run had one load failure in `mesh/test_mesh` — "Connection closed" from a bridge child; 22/22 alone three times).

**Questions after #85 (not decided):**
- **Several askers, one question?** Each ask is its own node; two agents asking the same thing make two rows. Fine, or
  de-duplicate by text under one parent?
- **The answer is realm-visible** (it is on the board for every dashboard and the `activity` tool) — only the notice subject
  keeps it out. Should a question be able to ask for a private answer (body only, not on the board)?
- **Answering from the phone / a notification:** the badge shows there is something to answer; a push (the doorbell, a
  topic) to the PERSON when a question is asked is not built.
- **A per-person identity** (#84's question) matters more now: an answer is attributed to the bridge's OS user.

## #84 — message the owning session about a context from the dashboard  ·  **DONE (v1.70.0)**
Robin, 2026-10-03.
- **Proposal:** right-click a node → **Message session…** opens a short text box. The bridge sends it to the owning
  session as a directed message whose subject names the node path, so the session knows what it is about.
- Attributed to the dashboard viewer; logged on the node ("Robin: …").
- Shares delivery with #80 (notices) and #85 (answers). Peer-relayed text is not authorization; the session still
  treats it as a request from the user.
- **Hook (built in v1.68.0):** `notifyActivitySession(ident, {verb:"activity_message", subject, body}, {now:true})` — `now`
  so a person's message isn't held for the batch window.

**#84 as built (v1.70.0, 2026-10-03)** — see README "Edit a line, message the session" and architecture.md §13 "Built (v1.70.0)".
- **Menu:** **Message session…** on any node, and on a session's own line (a multi-host session: each host line, never the
  session row) — only for a host that applies it (this gateway; another when `remote_hosts[].msg`).
- **Dialog:** "Message <session> about <path>" — a text box (≤ 2000 characters, newlines kept, a live counter; Send disabled
  with a reason while empty / too long; Ctrl+Enter sends, Escape cancels). It says the session reads it as a request and asks
  its user, and that the subject (public) carries only the path and the first few words.
- **Wire:** action `message`, `args:{text}` (`actActionQuery` passes `args.text`, ≤ 8192 UTF-16 units; the library checks
  ≤ 2000 code points → `message-too-long`; empty → `bad-args`). Control characters are dropped except newlines / tabs.
- **Owner:** `applyAction` logs ONE non-current SYSTEM entry on the node — text `robin via dashboard: <first 120 characters
  on one line>…`, the full text in `details` (cut to 4 KB only for a very long non-ASCII text), `act:"message"`, `by` — the
  line, state and activity are untouched. Then `notifyActivitySession(ident, messageNotice(r), {now:true})` (it flushes that
  session's queue too) and the result carries `delivered` + `delivery`: `live` (a live sub-peer, mesh-wide), `parked` (for its
  registration on the owning host), `none` (a script-only session: + warning `not-delivered` and `what: "not delivered: the
  session has no inbox (a script-only session) — the message is logged on the node"`).
- **Message:** verb `activity_message`, from the owning gateway (a `system` envelope, #80's path). Subject — PUBLIC — `robin
  about @Rel/@Code: Please also cover the empty-plan case…` (`firstWords`: ≤ 6 words / 40 characters, "…" after the last
  word). Body `{action:"message", path, host (the owner), text (all of it), by:{user, host}, entry_id, session, project, ts}`.
- **Dashboard feedback:** "✓ sent" + a toast "Message sent to Lead" / "Message parked for Lead (offline) — it gets it when
  it registers again"; for none an amber "⚠ logged · not delivered: the session has no inbox" + a toast. The log panel marks
  the entry 💬 (its details: the full text).
- **Trust:** one sentence, next to #80's, in the server instructions and the `log` tool's description, covering both verbs:
  a REQUEST relayed from a dashboard viewer, not authorization — summarise it for your user and act on it only with their
  permission.
- **Capability:** PEER_HELLO `activity_msg:1` (`p.act.msg`); `edit_text` / `message` (`MSG_ACTIONS`) are forwarded only to an
  owner that declared it — else `owner-unsupported` ("… runs a bridge older than 1.70.0 — messaging its sessions needs
  1.70.0+ …"), before anything is queued. `AI_BRIDGE_TEST_NO_ACTIVITY_MSG=1` (tests only) leaves the flag out.
- **Tests:** unit (the entry, details, limits, control characters, the root, messageNotice, firstWords), dashboard (menu,
  dialog, validation, Ctrl+Enter vs Enter, the three delivery outcomes, 💬), live `test_activity_msg_live` (live delivery at
  once with subject / body / entry id / details; federated B → A from A's gateway; script-only "not delivered" + still logged +
  nothing parked; offline parked + drained; an owner without `activity_msg` refused; the trust wording). **Mixed, live:** with
  `AIMB_TEST_OLD_BRIDGE` = a `git archive HEAD` (1.69.0) copy, 3 more checks — boards both ways (the 1.69 host shows B's
  edited text, without the ✎), edit / message on the 1.69 owner `owner-unsupported` while its skip still forwards, and the
  1.69 dashboard's skip on a 1.70 node applied + notified: 37/37.
- **Full suite:** parallel `npm test` (typecheck included): 2569 checks in 57 files, all green on the first run, 4m40s; no #74 flakes.

**Questions after #84 (not decided):**
- **Who may message.** As for every 6d action, any realm-token dashboard can write, attributed to the bridge's OS user (#70
  "Questions after 6d"). A message is the first action whose TEXT is free-form — a per-person identity would matter more now.
- **Replies.** The session can answer with `send_to_peer` to the gateway's id (the `from`), but nothing shows it on the
  dashboard. A reply path (an `activity_message_reply` logged on the node, or #85's answers) is for later.
- **Messages to a gone session** are parked forever (until it registers again) like any mail; should the dashboard say
  "parked" more loudly when the session has been gone for days?

## #83 — edit a context's text from the dashboard  ·  **DONE (v1.70.0)**
Robin, 2026-10-03.
- **Proposal:** right-click a node → **Edit text…** sets its current line (and optionally its state) from the dashboard.
- Goes through the 6d action path (`ACTIVITY_ACT`, routed to the owning host), is attributed ("edited by Robin"),
  logged, and notifies the owning session (#80).
- **Hook (built in v1.68.0):** `notifyActivitySession(ident, {verb:"activity_text_edited", subject, body})` — batched with
  the session's other notices; add an `ACT_NOTICE_COMBINE` entry if several edits should merge into one message.
- The session's next report overwrites the line as usual.

**#83 as built (v1.70.0, 2026-10-03)** — see README "Edit a line, message the session" and architecture.md §13 "Built (v1.70.0)".
- **Menu:** **Edit text…** on any node (a context, a plan item, an agent) and a session's own line, for a host that applies
  it (`remote_hosts[].msg`, as #84).
- **Dialog:** "Edit the line of <path>" — the RAW line prefilled and selected (`{progress}` etc. stay placeholders), a state
  picker "keep <state>" + the node's other valid states (`editStates`: a plan item any; another context all but todo /
  skipped; an agent / the session running · blocked · failed · done · idle, + abandoned only while it holds plan items), a
  "N / 240" counter, Save disabled with a reason (empty, too long, nothing changed); Enter saves, Escape cancels.
- **Wire:** action `edit_text`, `args:{text, state?}`. **Owner** (`applyAction`): `bad-args` (no text), `bad-state` (not in
  `editStates`), `no-change` (same text + state); the text is taken LITERALLY (parsed with a placeholder text, then set — a
  leading `@Docs` stays text), newlines → spaces, > 240 truncated with `text-truncated` (the report rule); no state = the
  line's (an edit never starts a ☐ item); the line keeps its details / data. Applied as a SYSTEM `@~` line (`by`, `act`; no
  activity), cascading like any abandoned line if the state is `abandoned`.
- **Attribution on the line (the unobtrusive way chosen):** the line object carries `by` ({kind:"dashboard", user, host})
  while its text is the viewer's — set by `edit_text`, KEPT by a tick that keeps the text (a session's `@~…/@~X` + state, or
  another dashboard state action), cleared by any other line (a log:false re-send of the same text too). Persisted as
  `line_by` on the entry record, inside a cp's / cf's `current`; the replay reads only `line_by` (never the entry's own `by`);
  gossip carries `current.by` (bounded by `normBy` on receipt); boards (raw + rendered, the `activity` tool) show
  `current.by:{user, host}`. The dashboard draws a small muted **✎** right after the text, inside the line (it stays visible
  when the text ellipsises); hover: "Edited by robin via dashboard (HOST) — its session's next report replaces it".
- **The entry:** text `<the line> (edited by robin via dashboard (HOST))` (the line cut to fit 240 with the suffix),
  `line_text` = the line, `act:"edit_text"`. The log panel marks it ✎.
- **Notice:** verb `activity_text_edited` (`EDIT_NOTICE_VERB`), batched; subject `robin edited @Rel/@Docs` (+ ` (todo →
  running)` when the state changed); body = #80's fields + `from_text` and `text` (the NEW line). `ACT_NOTICE_COMBINE` maps it to
  `combineActionNotices` (noun "line"): `robin edited 2 lines in @Rel`, body `{actions:[…], count, session, project, host}`.
- **Tests:** unit (editStates, literal text, ☐ kept, the record, no activity, boards + gossip + bounded junk, state + notice,
  the combined subject, refusals, truncation, details kept, agents + the root, tick keeps / report clears / log:false re-send
  clears, the replay via entries, cp and cf, a 1.69-shaped record without `line_by`, 4 seeded replay == apply runs with edits,
  messages, ticks and moves), dashboard (the ✎ placement, menu items per host, the dialog, validation, sending), live (local +
  federated both ways, the batch, refusals, the session taking the line back, gossip of the attribution).
: move nodes between contexts, agents shown on the item they work on, live item lines  ·  **DONE (v1.69.0)**
Robin, 2026-10-03, from using the live board.
1. **Move / re-parent.**
   - A `move` operation re-parents a node and its whole subtree to another path in the SAME session on the SAME
     host (per-host ownership).
   - Exposed as `aimb-log --move "<from>" --to "<to>"`, the `log` tool's `move`, and a dashboard right-click
     **Move to…** (a picker of valid targets, with confirmation).
   - It is logged as an entry ("moved by … from … to …") and honoured on restart.
   - **History follows the node:** it keeps a `moved_from` alias so its log, paging and counts include entries
     written under the old path.
   - A moved plan item is appended at the end of the target plan and stays a plan item.
   - The dashboard action is attributed like the other actions, and notifies the owning session once #80 lands.
   - Use case: `@Next release` ⇄ `@Potential changes`.
2. **Agents on the item they work on.**
   - Agents already can and should live UNDER the plan item they serve (`@Next release/@#79 …/fix-79`).
   - Briefings should give them that path (a briefing fix, not a feature).
   - **Dashboard:** a plan item with agent children shows a small agent glyph and the working agent's current line
     beside its box, even when collapsed.
   - Ticking stays explicit: an agent finishing doesn't tick the item; the orchestrator does after review.
3. **Live item lines** (briefing wording; do right after #79 lands).
   - Agents keep the item's CURRENT line telling the story:
     - on start: `@~<item> <scope>` with `--state running`;
     - at each sub-step: `@~<item> Writing README…`;
     - on finish: `@~<item> Finished …` with `--done`.
   - The line shows what's happening now; the item's log keeps the history.
   - Applies to `{log_snippet}`, `{log_tool_hint}`, the orchestrator briefing and the README.
4. **Abandon any context, not just plans** (Robin, 2026-10-03). Bridget logged to a wrong path (`@#79` instead of the
   plan item `@#79 three-part progress`), which made a stray context. It could only be marked done (`not-a-plan` refused
   abandoned), so the board said it was finished when it really was abandoned. Allow `abandoned` on any context; it
   greys out the context and everything under it (with the cascade below).
5. **Cascade abandon:** abandoning a plan or context by the tool or script abandons its open descendants too (today only
   the dashboard does), and the dashboard greys every descendant of an abandoned node.
6. **Ordering** (Robin, 2026-10-03: "the plan lacks ordering"; agreed as proposed). Today siblings sort by creation time
   and `plan_ix` only breaks ties inside one call, so a context created later lands in the middle of a plan.
   - **A stored position per node within its parent:** a fractional rank, so a reorder writes ONE record and nothing is
     renumbered. It is persisted in checkpoints and carried in gossip.
   - **Default order:** plan items by position, then other contexts, then agents. Rows never jump on a state change.
   - **Insert anywhere** (Robin: an agent must be able to insert steps into a plan at any position): `aimb-log --item "X"
     --before "Y"` / `--after "Y"` / `--first` / `--last` (default: the end), and the tool's `plan` takes the same
     (`before` / `after` / `position`). Several new items in one call keep their given order at that spot.
   - **Reorder:** the same flags on an existing node (`--path "@Plan/@~X" --before "Y"`); the dashboard gets right-click
     **Move up / Move down / Move to…** and drag-and-drop, attributed like the other actions (and #80-notified).
   - **Attention without reordering:** open questions (#85) and blocked items keep their place; a badge bubbles up to
     collapsed parents. An optional "needs attention first" filter may come later.

**#82 as built (v1.69.0, 2026-10-03)** — see README "The plan workflow" and architecture.md §13 "Built (v1.69.0)".
1. **Move / re-parent.** `log {move:"@Next release/@X", to:"@Potential changes"}` / `aimb-log --move … --to …` / the dashboard's
   **Move to…** (a picker of valid targets, then a confirm) and drag-and-drop onto another node. Same session, same host.
   Both paths relative to `path` / `--path` (`/` = absolute; `--to "/"` = the root); a new parent path is created implicit.
   The node keeps everything (line, state, bar, plan-item marker, created_at, log, count) and goes to the END of its kind
   there (a plan item at the end of the target plan) unless placed. One logged entry at the new path: "moved by <session |
   robin via dashboard (HOST)> from … to …" with `moved_from` + `rank`. **History follows it:** in memory its log moves; the
   replay maps every older record under the old path onto the new one, node by node (an old parent keeps those records'
   activity); `node.moved:[{from, at}]` (carried forward) gives its log aliases, so paging continues into the day files under
   the old path(s) — shown at the node's path now — and counts include them. Errors: unknown-node, no-change (a same-parent
   move with a position = a reorder), target-exists, bad-move, path-too-deep. Dashboard moves are attributed and #80-notified
   ("robin moved @Next release/@B to @Later").
2. **Agents on the item they work on.** A plan item with agent children shows the WORKING agent (the most recently active one
   still running, else the latest) beside its box — glyph, name, current line — even closed. Ticking stays explicit.
3. **Live item lines:** nothing more needed — the v1.66 snippet / briefing wording already covers it (confirmed: the
   `{log_snippet}` lines are unchanged in v1.69).
4. **Abandon any context.** `abandoned` is valid on every context; agents / the session keep their rule (only when holding plan
   items: it finishes them and ends their plan). The dashboard greys the abandoned node AND everything under it, and offers
   **Abandon…** (confirmed) on an ordinary context.
5. **Cascade.** An abandoned line (tool, script or dashboard) abandons every OPEN context / item under it (todo / running /
   blocked, or holding an open plan) — not inside another agent — deepest first, each logged "abandoned with <path>"; the result
   lists them (`cascade:[{path, from_state}]`); the dashboard's action reports them in `applied` (and the #80 notice's `items`).
6. **Ordering.** A fractional base-36 rank per node; most nodes store none and use their DERIVED rank (creation time + plan
   position) — so the default stays creation order for old and new nodes — and only a PLACED node stores one (one record per
   reorder, nothing renumbered). Siblings: plan items, then contexts, then agents, each by rank; a state change never moves a
   row. Insert anywhere: `--item "X" --before "Y"` / `--after` / `--first` / `--last` (tool `before` / `after` /
   `position`), several new items keep their order at that spot. Reorder: the same flags on an existing node, or the
   dashboard's **Move up / Move down** and drag-and-drop onto a sibling (attributed, #80-notified). Ranks persist in
   records / cp / cf and ride gossip (stored ones only). Open questions / blocked items keep their place; no attention badge
   (that is #85).
- **Wire:** format stays v5. New optional fields: gossip node `rank`; records `rank`, `moved_from`; cf `moved`. PEER_HELLO
  `activity_plan:1`; move / reorder are forwarded only to an owner that declared it (`owner-unsupported` otherwise; the board
  head's `remote_hosts[].plan` tells the dashboard). A 1.69 follower and the 1.69 script refuse move / to / before / after /
  position against a ≤1.68 gateway (`gateway-unsupported`), which would drop them silently. **Mixed versions, live:** a 1.68 and
  a 1.69 bridge on loopback test ports — boards both ways (the 1.68 one shows a move as removal + new node, no ranks), 6d
  actions both ways, move on a 1.68 node `owner-unsupported`, the script's `--before` refused against 1.68: 11/11.
- **Replay hardening found by fuzzing (400 random sequences with moves + dashboard actions + expiry, all equal to a
  chronological apply):** a record lands on a moved node only if that node's later moves carried it there; a dismissed /
  evicted path follows only its parent's later moves; two pre-existing 6d gaps closed — a dismissal entry is kept when its name
  was re-used later, and the ancestors of a record skipped for an ended descendant are kept (an implicit parent emptied by a
  dismissal, or a session whose only node was dismissed, now survive a restart as they are live).
- **Tests:** `test_activity_unit` 764 (+70: ranks, parsing, insert / reorder / groups, move + errors + replay, history under the
  old path via filePage, the cascade, dashboard move / reorder + notices, carry-forward, 10 seeded replay == apply runs with
  moves), `test_dashboard_activity` 230 (+25), new `test_activity_plan82_live` 26. Full `npm test`: 2472 checks in 56 files, all green
  on the first run (4m17s; no #74 flakes).

**Questions after #82 (not decided):**
- **Downgrade after a move** is unsupported (a ≤1.68 replay rebuilds the moved node at both paths). Mark move records with a
  newer record format so an old replay skips them instead (it would then show the node at its old path only)?
- **The new parent's merged log** stops at ITS run start, so a node moved in shows its older entries only after "show earlier
  runs". Fine, or should a subtree's run boundary ignore records of nodes moved in?
- **Moving a live agent** is allowed; its next report (to its old path) creates a new node there. Refuse moving an agent that
  is still running, or leave it to the orchestrator?
- **Anchors across kinds** are refused (`bad-anchor`): a context can't be placed among plan items. Allow it (a rank only, the
  group still wins), or keep the error?

## #81 — move the test suite to Node's built-in test runner (node:test), with live dashboard progress  ·  **OPEN — step 1 + "test groups" DONE (v1.67.0, tests only); later: native conversion**
Robin, 2026-10-03. No runner script and no CI for now: go straight to `node:test`, incrementally.

**Today:** `npm test` is `typecheck` plus 54 plain Node scripts chained with `&&`. Each script has its own `check()`
helper and prints PASS/FAIL lines. It stops at the first failure, runs strictly one file at a time (20–40 min),
and has no timing or summary.

**Step 1:**
- **`tests/suite.test.mjs`,** a single node:test file. It runs the CURRENT test files in the current order, each
  as a named sub-test that spawns `node tests/<file>.mjs` and passes on exit 0. Each file's PASS/FAIL counts are
  attached as diagnostics.
  - Files still run one at a time; parallelism comes after a port audit.
  - One failing file no longer stops the rest.
  - `npm test` becomes typecheck plus `node --test tests/suite.test.mjs`. The old chain stays as `test:legacy`
    until the move is done.
- **`tests/reporters/aimb-dashboard.mjs`,** a custom node:test reporter, used alongside `spec`:
  - it keeps one `aimb-log --stream` connection open for the whole run;
  - one plan item per test file (☐ → in progress → ☑ / failed);
  - a `log:false` progress update about every 10 s ("checks N · file i/54 · <file>"), with the three-part bar from
    #79 (passed / skipped / total);
  - a logged entry per failing file with its FAIL lines in details, and a final summary.
  - Session and path come from env (`AIMB_TEST_LOG_SESSION`, `AIMB_TEST_LOG_PATH`, `AIMB_TEST_LOG_PROJECT`), so an
    agent's run nests under that agent.
  - It is silent if no bridge is reachable.

**Later:** convert files to native node:test one by one (describe/it, before/after cleanup, `mock.timers` instead
of the clock env hooks, per-test timeouts). Turn on `--test-concurrency` once the ports are audited. The reporter
gets per-test detail as files convert.

**"Test groups" (Robin, 2026-10-03):** split the tests into functional node:test groups, runnable all together, by group,
by file or by single check, and run them in parallel — ports first (a disjoint range per file), temp dirs per file.

### #81 as built (v1.67.0 — step 1 + test groups; tests only, `BRIDGE_VERSION` unchanged)
- **Layout:** nine group folders, `tests/<group>/test_*.mjs` (a `git mv`; only the relative paths changed):
  `unit` (lib, persistence facet, activity core — no sockets) · `mesh` (10) · `security` (9: consent, grants, vault,
  token file, roster secrets, cap keys, facet probes, egress, grant notices) · `persistence` (4) · `federation` (9) ·
  `behaviors` (3) · `doorbell` (2) · `dashboard` (6) · `activity` (8). `tests/helpers/manifest.mjs` holds the groups and
  `ORDER` (the old chain order — also the port-block order, so append-only).
- **Drivers:** `tests/helpers/suite.mjs` runs a script as one node:test test (id `mesh/test_mesh`; spawn, pass on exit 0,
  counts + FAIL lines as diagnostics, a 15-min kill timeout). `tests/<group>/<group>.test.mjs` = that group, one script
  at a time (plus a guard that fails a script in the folder but not in the manifest); `tests/suite.test.mjs` = every
  script, serially, in ORDER (step 1 as specified).
- **Commands:** `npm test` = typecheck + `node tests/run.mjs` → `node --test --test-concurrency=4` over the nine drivers,
  longest group first, `spec` + the dashboard reporter. `npm run test:group -- <g…>`, `npm run test:file -- <name…>`
  (name, id or a part), `npm run test:serial`, `npm run test:legacy` (the old `&&` chain, new paths). One check:
  `TEST_ONLY=<text>` / `--only <text>` — the shared `tests/helpers/check.mjs` filter every script's `check()` calls first
  (the script still runs; only matching checks are printed and counted). No file is native yet, so `--test-name-pattern`
  has nothing to select below the script level.
- **Ports:** audited every literal; 12 pairs of files shared ports (harmless serially). Now script *i* of ORDER owns
  `20000 + 100·i … +99` (`tests/helpers/ports.mjs`, `AIMB_TEST_PORT_BASE` to move it); each file maps its old numbers
  with `tp(n)` (throws outside its block). Temp dirs were already `mkdtemp` per file.
- **Reporter:** `tests/reporters/aimb-dashboard.mjs` as specified — one `aimb-log --stream` child, a plan item per
  script (reset to ☐ each run), a 10 s `log:false` progress line with the three-part bar (done = passed checks; totals
  from a check-count cache in the temp dir; a crashed script's unreached checks count as skipped), a logged entry per
  failing script, a final summary; `AIMB_TEST_LOG_SESSION` / `_PROJECT` / `_PATH` / `_USER` / `_SCRIPT` / `_CONFIG`
  (config handed only to the logger child as `AI_BRIDGE_CONFIG`). Silent without a session; with no token it stops at
  once, with no bridge it costs ≤ 3 s at the end; never fails the run. **Deviation:** node:test replays each test file's
  events only after the files before it have reported, so in a parallel run only one group would show live; the
  reporter creates `AIMB_TEST_STATUS_DIR` and the drivers append start / end lines there (per process), with the
  node:test events as the fallback.
- **Fixes found on the way:** `test_grant_notice_live` inherited `stableIds` from the operator's `config.json` — without
  one (a worktree, CI) a re-register minted a new id, step 3's deregister missed it and 2 checks failed (4 announced, not
  3); now pinned `AI_BRIDGE_STABLE_IDS=1`. `test_dashboard` WROTE host aliases into `src/config.json` and `test_page_e2e`
  read the live realm token from it; both now use a temp config + a test token.
- **Proof:** serial, the old chain: 12m07s pre-move, 12m11s post-move (`test:legacy`, 2315 / 2315 green);
  `test:serial` 12m07s. Parallel `npm test` (typecheck included): **3m55s, 3m50s, 3m49s** — run 1 before the
  grant-notice fix (53/54), runs 2 and 3 all green (2315 checks, 54/54). Per group (s): activity 205, federation 151,
  security 112, persistence 90, mesh 90, dashboard 46, doorbell 26, behaviors 10, unit 1 — the same as serially, so no
  file slowed down under 4-way parallelism. Flakes: none in the three parallel runs; `test_retain_federate_live` died
  once in the `test:serial` run ("Not connected" after a restart — the #74 family), 3/3 standalone afterwards. No serial
  lane was needed.
- **Later:** native describe/it per file (then `--test-name-pattern`, per-test reporter detail); `mock.timers` for the
  clock hooks; the activity group is the critical path (~3.5 min of the ~3m50s) — split it if the suite grows.

## #80 — tell the owning session when the dashboard changes its activity  ·  **DONE (v1.68.0)**
Robin, 2026-10-03.
- **The gap:** dashboard actions (#70 6d) are only LOGGED on the node ("skipped by robin via dashboard (…)"). The
  session that owns the plan isn't told, so an orchestrator may keep working on something a human just skipped or
  abandoned.
- **Wanted:** the owning host's gateway sends the node's session a system message for every state-changing dashboard
  action: skip, abandon, abandon_plan, done, complete, reopen, reopen_plan, finish, dismiss. Copy, pin and hide
  are view-only and send nothing.
  - **Recipient:** the session's registered sub-peer (realm/project/user/session name). If it is offline, the
    message is parked like any mail. Script-only sessions (no sub-peer) get the log entry only.
  - **Message:**
    - verb `activity_changed`;
    - subject e.g. "robin skipped @Dashboard test/@Docs" (status paths are realm-visible anyway);
    - body: `{action, path, host, from_state, to_state, by:{user, host}, entry_id}`.
  - **Batched:** several actions on one session within a few seconds become ONE message ("robin skipped 2 items and
    abandoned 1 in @Dashboard test").
  - **Delivery:** it rides the existing system-message path (no consent bypass beyond what #72's notices use, since
    it is the session's own project). The doorbell wakes the session, and the receive reminder applies, so the
    session summarises for its user before acting.
- **Compatibility:** wire-compatible with 1.65, so no simultaneous redeploy.

**#80 as built (v1.68.0, 2026-10-03):**
- **When / who sends:** after every APPLIED state-changing action (`done`, `skip`, `reopen`, `abandon`, `complete`,
  `abandon_plan`, `reopen_plan`, `finish`, `dismiss`), from `actApplyAction` — so the gateway that OWNS the node sends it,
  also for an action forwarded as `ACTIVITY_ACT` from another host's dashboard. Copy / pin / hide are browser-only (the
  bridge never sees them); refused actions and reads send nothing.
- **Message:** a `system` envelope from the owning gateway, verb `activity_changed`. Subject e.g. `robin skipped @Dash
  test/@Docs` (display path: quotes dropped; the root = the session's name; agents: "completed the plan of lead",
  "abandoned the open plans of lead", "marked helper finished (failed)", "dismissed helper from the board"). Body
  `{action, path, host, from_state, to_state, of?, by:{user, host}, entry_id, session, project, text, ts, items?}` — `host`
  = the owner, `by.host` = the dashboard's host, `entry_id` = the logged entry; complete / abandon_plan / reopen_plan carry
  `of:"plan"` and the PLAN's states (open | done | all-done | abandoned); abandon_plan adds `items:[{path, from_state,
  to_state, entry_id}]`. A batch: subject e.g. `robin skipped 2 items and abandoned 1 in @Dash test`, body `{actions:[…],
  count, session, project, host}`.
- **Batching:** per session (realm + project + user + name, lower-cased), window `activity.notice_batch_sec` (3 s default,
  0–60, 0 = each at once; env `AI_BRIDGE_ACTIVITY_NOTICE_BATCH_SEC`); each notice re-arms it, capped at 5 windows after
  the first or 64 queued. `POST /admin/prepare-shutdown` flushes every queue before the going-down notice (`notices` in its
  answer); a clean exit flushes too (≤1.5 s).
- **Recipient:** every live sub-peer of the session, mesh-wide, matched case-insensitively (else a live bare session of that
  name); none live → PARKED for its durable registration in the owning host's store (drained on the next register_self);
  none → nothing but the log entry (a script-only session). Delivery is the normal sub-peer path, so the doorbell wakes.
- **Consent:** the `system` exemption #72's notices use, set only by bridge code — not widened.
- **The generic hook (for #83 / #84 / #85):** `notifyActivitySession(ident, {verb, subject, body}, {now?})` in `bridge.mjs`
  (`ident` = `{realm?, project, user, session}`, e.g. applyAction's `r.ident`) → `Promise<{ok, delivered|parked|none} |
  {queued, in_ms}>`. Several notices of one verb in a window merge through `ACT_NOTICE_COMBINE[verb]` (default: subject
  "<first> (+N more)", body `{notices, count}`); `now:true` sends at once (a message a person waits on). Planned verbs:
  `activity_text_edited` (#83), `activity_message` (#84), `activity_answer` (#85).
- **Library:** `applyAction` also returns `ident`, `kind`, `text`, `from_state`, `to_state`, `of`, `entry_id`; pure builders
  `actionNotice` + `combineActionNotices` + `displayPath`; `NOTICE_VERB`.
- **Session guidance:** one sentence in the server instructions and in the `log` tool description: summarise an
  `activity_changed` message for your user; don't act on it without their permission. No reminder text changed.
- **Compatibility:** no frame or format change; a ≤1.66 owner just sends nothing; any receiver accepts a `system` envelope.
- **Tests:** `test_activity_unit` 694 (+9), new `test_activity_notices_live` 26 (18 FAIL against the 1.66 bridge). Full
  parallel `npm test` (typecheck included): 2351 checks in 55 files, all green on the first run, 4m03s; no flakes.

## #79 — `--plan` swallows trailing text; three-part progress (done / skipped / total)  ·  **DONE (v1.66.0)**
Found by Bridget and Robin, 2026-10-02, on the first live use after the v1.65.0 deploy.

1. **`aimb-log --plan` swallows trailing text.**
   - What happened: `--plan` takes every argument after it as an item name, so
     `--plan "A" "B" "@~root headline"` treats the headline as a third item and the call fails with `bad-plan`.
     Retrying piecemeal then creates ordinary contexts instead of plan items.
   - Fix:
     - the snippet line teaches "put any text BEFORE --plan";
     - `bad-plan` for a name that looks like text (starts with `@`/`@~`, or contains spaces beyond a short name)
       says so explicitly;
     - the README and the tool description say the same.
2. **A done task counts as 100%,** and progress always has three parts.
   - A node whose state is **done** contributes **100% done** to its parents, and shows a full bar itself, whatever
     its own reported or rolled-up bar says. (Seen live: `@Test plan` was done but showed a partial striped bar.)
   - **Progress is {done, skipped, total}.** The bar draws done (green/blue), then **skipped** as a separate,
     non-green segment right after it, then the remainder. The label reads e.g. "1 of 5 done · 1 skipped".
   - Rollups carry all three parts:
     - a skipped plan item counts as skipped, not done and not remaining;
     - a done node counts as fully done;
     - with a common unit, the parts are summed;
     - with mixed units, they are averaged as fractions.
   - Pending decisions: how abandoned and failed count. (Proposed: abandoned in the skipped segment; failed as
     remaining.)

**#79 as built (v1.66.0, 2026-10-03):**
- **`--plan`:** `aimb-log` refuses a plan name that looks like status text — it starts with `@~`, or is "@ctx words"
  (an `@` plus a space) — with `bad-plan` (exit 64, locally): `"<name>" looks like
  status text — put text before --plan: "<text>" --plan "A" "B"`. "@Spec" alone stays a valid name. The snippet line reads
  `- "<text>" --plan "A" "B" creates ☐ plan items under --path, in that order; text goes BEFORE --plan.`; the README and
  the `log` tool description say the same (for the tool: text goes in `text`, never in `plan`).
- **Call signature (Robin, 2026-10-03: "do it ASAP, it improves reliability"):** `aimb-log --text "<text>"` and a repeatable
  `--item "A"` (one plan item per flag). No argument depends on its position any more. JSON on the command line was rejected
  (shell quoting differs across bash / PowerShell / cmd); programs use `--batch` / `--stream`. Positional text and `--plan`
  still work. The snippet now reads `--path <agent-path> --text "<text>"`, `--item "A" --item "B" …`, `--state running --text
  "<what>"`, `--text "@~root <summary>" --state done`. The 40-char "long phrase" rule was dropped at review (it refused real
  item names). The dashboard's copy-command keeps positional text: it may target a 1.65 host's script.
- **Decisions taken (the pending ones):** ABANDONED items count in the skipped part (they won't be done), and an abandoned
  NODE has its remainder skipped; FAILED counts as remaining (it may be retried), and a failed node keeps its bar.
- **Model:** `{done, skipped, total, unit}`; `skipped` defaults to 0. `parseProgress` also takes `{skipped}` and a trailing
  "N skipped" ("3/6 1 skipped"). Common unit: done, skipped and total are summed. Mixed units: each child's done fraction and
  skipped fraction are averaged, each child weighted 1. "N of M done": M = ALL items, done = done items, skipped = skipped +
  abandoned items (replaces 6b/6c's "skipped left out of M"; an all-skipped plan now has a bar). Reported progress wins
  as before, unless the node is done (then 100%). The plan END rule is unchanged (skipped items keep a plan open).
- **Text:** `{progress}` → "1 of 5 done · 1 skipped" (unchanged when skipped is 0), `{pct}` = the done %, new `{skipped}`.
- **Wire:** `skipped` rides progress objects (records, cp / cf, gossip units) only when > 0; format NOT bumped (v5).
- **Same change set (Robin, 2026-10-03):** the snippet keeps the checklist live (start an item with `--state running
  "<what>"`, tick it with `--done` the moment it is done, keep "@~root …" current); the realm reminders brief an
  orchestrator (`--path` = each agent's unique name, its checklist up front or `--plan` first, its own `@~root` current,
  its agents tracked as its own plan) within the 365-char reminder cap; the README gained "Briefing agents"; in-progress is
  CYAN everywhere (`--act-running`), green = done only; sessions have their own glyph (a window; code ">_", cowork a bubble,
  page a globe, else plain), one builder for the Activity tree, the legend, the Sessions table and the mesh map, with
  `client_kind` added to dashboard session units from the mesh roster.

## #78 — making use of latest Claude features  ·  **OPEN (after the #70 deploy)**
Robin, 2026-10-02. Prompted by: "Is the doorbell still the best way to wake a session? Is the MCP bridge still the
best approach?"

Research (claude-code-guide, docs at code.claude.com: channels, hooks, tools-reference, cross-session-messaging,
scheduled-tasks, routines, plugins):
- **MCP channels** (research preview): an MCP server can PUSH a message into a running Claude Code session, and
  an IDLE session starts a new turn. This is the real successor to the doorbell, and effectively the `set_wake`
  feature (T14).
  - It needs Claude Code ≥ 2.1.224 (Windows ≥ 2.1.234) and a session started with
    `--channels plugin:<name>@<marketplace>`.
  - Team/Enterprise need the admin setting `channelsEnabled`.
  - It works in the CLI and the desktop Code tab, but NOT in Cowork.
- **Native cross-session messaging** (`ListAgents` / `SendMessage`, Remote Control): plain text between local,
  cloud and Remote Control sessions, routed via Anthropic, and it wakes an idle receiver. It has no topics,
  ownership, pub/sub, parked mail, cross-project consent, page leaves or activity board. So it overlaps only the
  bridge's simplest feature and does not replace the mesh.
- **Hooks:**
  - They can inject `additionalContext` per turn, but cannot block on an external event and wake an idle session.
  - `asyncRewake` is unconfirmed in the docs.
  - `Monitor` streams events into a LIVE session; it doesn't help an idle one.
- **Plugins** can bundle an MCP server, hooks, skills and settings for a one-step install (Code tab confirmed; the
  Cowork component support is unclear).
- The research claimed a 2h maximum for background tasks, but that contradicts observed behaviour (a background
  doorbell has run hourly for days). Re-verify during the spike.

**Conclusion:** keep the MCP bridge. Nothing native covers multi-client (Code/Cowork/pages), self-hosted, topics,
consent, parking and the activity board. Evolve how it wakes sessions and how it is installed.

**Work:**
1. **Channels spike:**
   - Make the bridge a channel-capable MCP server, packaged as a channel plugin.
   - Prove an incoming `send_to_peer` wakes an IDLE Code session (CLI and the desktop Code tab).
   - Mark sub-peers `channel_capable: true` when it applies.
   - The connect reminder tells channel-capable sessions to skip the doorbell; the doorbell stays as the fallback
     for Cowork, older clients and unsupported plans/platforms.
   - Check how this interacts with shared bridges, followers, and multiple sub-peers per process (which session
     does the push wake?).
2. **Plugin packaging:** one install per machine bundling the MCP server config (with `AI_BRIDGE_TOKEN_FILE`, which
   prevents #75-style setups), hooks and skills (e.g. `/inbox`, `/doorbell`). Check what Cowork supports.
3. **An unread-count hook:** a `UserPromptSubmit` hook injecting "N unread on the bridge" as `additionalContext`
   each turn, so busy sessions notice mail without calling the inbox tool. It needs a cheap local query (e.g. a
   token-gated loopback endpoint).
4. **Re-check background-task limits and `asyncRewake`** against current docs and real behaviour.

## #77 — topics on the activity board: tag work by topic + a "By topic" view  ·  **OPEN (after the #70 deploy)**
Robin, 2026-10-02.
- **Background:** sessions stay the BACKBONE of the activity board. Liveness, stale and gone, and "each host writes
  only its own nodes" all need a concrete actor. But people often think in topics ("what's happening on Maps?"), and
  topics outlive sessions.
- **Agreed now:**
  1. **Topic-tagged messages.**
     - A `log` message (tool, script `--topic`, batch item) may carry `topic: "Maps"`, meaning this work is done on
       behalf of that topic.
     - It is validated like `from_topic` (#54): the session must currently own (or co-own) the topic, else a clear
       code and nothing is applied.
     - The tag rides the entry and the node (a node's topic is its most recent tagged message, or inherited from its
       nearest tagged ancestor; decide).
     - It is gossiped and shown as the topic's icon and name on the row.
  2. **A "By topic" view** on the dashboard, beside Projects / Sessions / Nodes:
     - topic → its owner session(s) from the claims roster → the activity tagged with that topic (falling back to
       the owner's whole tree when nothing is tagged; decide);
     - topic icons; "Active only" and "plans" apply.
     - It is purely dashboard logic over gossiped data, plus the tag.
- **Later, only if real use shows the need: topic-OWNED plans.**
  - A plan anchored to a topic (e.g. a "Maps roadmap") would survive the owner changing: the next holder inherits it
    and can tick items, rather than it being abandoned after 90 days with the old session.
  - It conflicts with per-host write ownership, since topic owners can move hosts, so it needs a handover step on
    claim change. Revisit after #77 parts 1–2 have been used for a while.

## #76 — a parent's merged log can miss a removed child's earlier-run entries  ·  **OPEN (low)**
Found during #70 6a/6c.
- **The gap:** a node's subtree log merges each node's in-memory entries, then continues into the day files below
  the subtree's floor. When a child was evicted or expired and later reappears, entries of its EARLIER run that are
  newer than the oldest in-memory entry of the merge can be skipped.
- **Impact:** rare (it needs eviction or expiry plus a re-used name) and cosmetic, since the history is still in
  the files.
- **Fix idea:** track per-subtree floors including removed children, or fall back to a file scan when a removed
  child's interval overlaps the in-memory range.

## #75 — doorbell can't find the realm token when the bridge reads it from a FILE  ·  **DONE (part 1 script; part 2 v1.64.0)**
Reported by Architect (Marz, Robins-Mac, 2026-10-02).
- **What happens:** the doorbell always exits 64 ("no realm token").
- **Why:**
  - The Mac's bridge gets its token via `AI_BRIDGE_TOKEN_FILE` in the MCP server env (`~/.claude.json`), so
    `src/config.json` has no `token`.
  - A session's shell does not inherit the MCP server's env.
  - The doorbell read only `--token`, `AI_BRIDGE_TOKEN` and `config.json`, never `AI_BRIDGE_TOKEN_FILE` (#46).
  - So following the connect reminder's `{doorbell_cmd}` verbatim can never work on such a host.
- **Why Ferret : Mac.1 could arm it:** its doorbell process has `AI_BRIDGE_TOKEN` in its environment, but neither
  Claude Code's own environment nor any settings file sets it. So the Ferret session must have read the token file
  itself and passed the value as an inline env var. It worked around the bug; it did not follow the reminder.
- **Part 1 (done):** `aimb-doorbell.mjs`
  - accepts `--token-file <path>` and `AI_BRIDGE_TOKEN_FILE`: a bare token or a KEY=VALUE env file, `~` expanded,
    as the bridge does;
  - treats an explicit `--token-file` as authoritative, so an unreadable file is exit 64 naming the file, never a
    silent fallback;
  - fixes the misleading "run beside src/config.json" hint: config.json is found relative to the SCRIPT and the
    working directory never matters.

  `test_doorbell_live` gained 5 checks (bare file, env file, env var, unreadable file, no token leak): 76/76.
- **Part 2 (DONE, v1.64.0, with #70 6c):** when the bridge itself read its token from a file (`AI_BRIDGE_TOKEN_FILE` with no
  `AI_BRIDGE_TOKEN` value set), `{doorbell_cmd}`, `set_wake`'s `command` / `hint` and #70's `{log_snippet}` end with
  `--token-file "<that path>"` (resolved, `~` expanded, forward slashes, quoted). Only the path is handed out; the token
  never appears in a reminder. A token from `config.json` adds nothing (the scripts read that file); a token passed as an
  env VALUE adds nothing either (it can't be handed on safely — such a host should switch to a token file).
  `tools/aimb-log.mjs` gained `--token-file` with the doorbell's semantics (explicit = authoritative; unreadable/empty =
  exit 64 naming the file, `token_file` in the JSON). New `test_activity_6c_live` proves the path is carried, the token is
  never in any response or script output, the snippet's command runs verbatim on its token file alone, and a wrong file
  fails even with a good env token.

## #74 — federation live tests flake under full-suite load  ·  **OPEN**
- `test_grants_federate_live` failed once in the #70 step 2 full run, with "MCP error -32000: Connection closed" at
  its after-restart `send_to_peer`.
- `test_federation_heal_live` lost a connection once in the step 4 full run.
- v1.65.0 (#70 6d): the full suite passed first time (2268 / 54 files); of 5 standalone `test_federation_heal_live` runs one
  ended without its summary line (output not kept), the other 4 passed 19/19; `test_grants_federate_live` 3/3.
- Both pass reliably when run alone (7/7 each), and neither touches the code that changed.
- v1.66.0 (#79): both federation tests passed in the full run. A DIFFERENT, time-of-day flake showed instead:
  `test_dashboard_activity` fails 2 tooltip checks when run between 00:00 and 01:00 local (its fixture "started 1 h ago"
  falls on yesterday, so the clock gets a date prefix the regex does not expect); it passes after 01:00. Fix: pin the
  fixture times to midday, or let the regex accept the date prefix.
- v1.67.0 (#81, parallel groups): three parallel full runs, heal + grants_federate green every time. A third member of
  the family: `test_retain_federate_live` lost its MCP connection ("Not connected") in a restart phase once, in the
  SERIAL `test:serial` run (near the end, after the oversized-value checks); 3/3 standalone right after. Parallelism did not make any of them
  worse, so none has a serial lane.
- Bridget's review run of v1.67.0 (parallel, 2026-10-03 ~03:00): `test_federation_heal_live` died with a NATIVE crash
  of the test process — exit 3221226505 = 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN, i.e. a Windows fail-fast abort) —
  after 8 of 19 checks, all passed. 3/3 standalone straight after. A native abort is a new symptom: worth capturing
  stderr and a crash dump next time.

**Suspicion:** a timing race around bridge restart/re-link under CPU load, or a test-harness port/timeout
assumption. **Wanted:** reproduce under load (e.g. run each in a loop alongside a CPU hog), then find whether a
bridge actually crashes (capture stderr) or the harness times out, and fix it or harden the test.

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

## #70 — agent activity board: live agent status by session, mesh-wide  ·  **OPEN (steps 1–5 built, v1.61.0; step 6a — the node tree + batch logging — built, v1.62.0; step 6b — todos + plans — built, v1.63.0; step 6c — the snippet + reminders, plan rules, counts, run-boundary history, dashboard polish — built, v1.64.0; step 6d — right-click actions, the log panel, pin / hide — built, v1.65.0: the build plan is COMPLETE; next: the deploy (RESUME STATE checklist) — Robin)**
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

**Script:** `tools/aimb-log.mjs`, token-gated like the doorbell, no registration needed. (BUILT v1.59.0; `--project` is
required, plus `--user`, `--stale-after`, `--no-log` and `--stream` — see build-plan step 3.)
```
node aimb-log.mjs --session <name> --project <P> [--user U] [--agent <label>] [--ctx "@~Ctx"] [--state S]
  [--progress 4812/12000:tiles] [--eta 1h25m] [--stale-after 60m] [--details "..."] [--data '{...}' | --data-file f.json]
  [--no-log] ["<text>"]
```
- It prints one JSON line. Exit codes: 0 ok, 4 bridge error, 64 usage.
- Anyone holding the realm token can report as any session via the script. That is the same trust as the doorbell,
  and was accepted (Robin); the bridge tool checks `as`/`secret`. Exception (2026-10-01): not as a session that is live
  on the mesh under another user (`session-user-mismatch`).

### Limits and configuration (decided, Robin, 2026-09-30)
**Fixed in code, versioned** (these change what crosses the mesh, so every bridge must agree):

| Limit | Value |
|---|---|
| Message text | 240 chars |
| Context name | 60 chars |
| Agent path depth | 3 (`a/b/c`) — **6a (v1.62.0): any path, depth ≤ 6** |
| Contexts per agent | 32 — **6a: replaced by 4096 nodes per session** |
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
| `finished_visible_hours` | 24 — **6b (v1.63.0): 168 (7 days)**, matching log retention; also the replay window |
| `memory_budget_mb` | 64. Over budget, the oldest finished agents are evicted first. |
| `abandoned_plan_days` | **6c (v1.64.0):** 90 (1–3650) — a gone session's open plans are abandoned by the bridge after this long |
| `finished_plan_open_min` | **6c (v1.64.0):** 120 (0–10080) — an ended plan stays expanded on dashboards this long (sent with the board) |
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

### Decisions before step 4 (Robin, 2026-10-01)
- **Identity includes the host.** Every entity is keyed by realm + project + user + session + **host** (+ agent path).
  This supersedes "the host is not part of it".
  - Each host only ever writes its own entities, matching per-origin gossip ownership, so the same session/agent name
    reporting from two hosts is simply two entities and nothing has to choose between them.
  - The board GROUPS entries with the same realm/project/user/session name under one session, tagging hosts when it
    spans more than one.
  - A session that moves machines leaves its old host's entries to go stale or gone.
- **User-mismatch check:** the few-seconds gossip lag is acceptable. Bare (process-level) sessions get the same rule
  as sub-peers: same user allowed, a different user refused.
- **Gossip rate:** at most ONE activity update per second per link, carrying only what changed.
- **"Going down" notice:** the prepare-shutdown request also tells peer hosts, so their boards show that host's
  agents as gone at once.
- **No realm flag on the script:** the gateway already refuses a realm other than its own.

### Decisions before step 5 (Robin, 2026-10-02)
1. **Dashboard updates:** dashboards get DELTAS, like the gossip, not the whole board every second.
2. **Stale slider:** the dashboard computes stale client-side from the raw fields, so the slider responds instantly.
3. **A session on several hosts:** one session row with a host tag for each host, and agents beneath tagged by host.
   The session headline comes from the most recently active host.
4. **"Host down" versus "session left":** distinct. "Host down" gets its own badge, since it affects every agent on
   that host.
5. **History paging** continues into the day files once the in-memory entries run out, covering the full retention
   window.
6. **Many remote fetches at once:** the requesting gateway QUEUES them (respecting the per-link rate) instead of
   surfacing `rate-limited` to dashboards.
7. **Who may read activity:** dashboards and registered sessions only, not page leaves.
8. **Duplicate hostnames:** accepted. A warning is logged when one is detected.

### Step 6 redesign: unified tree, todos and plans, batch logging (Robin, 2026-10-02)
None of this is deployed yet, so it reworks the internals of steps 1–5 rather than migrating live data.

**Unified tree.** One tree of NODES per session. Each node is one of two kinds, and keeps that kind's rules:
- **Agent** (an actor): it starts, finishes (when its `@~root` is set to done/failed), and can go stale or gone.
  Staleness belongs to agents.
- **Context** (a piece of work): it has a current line, progress and an ETA.

Any node may contain either kind, so agents can be grouped under the task they serve, and contexts can nest.

**Path notation.** One `/`-separated path; a segment starting with `@` is a context, anything else an agent.

| Path | Means |
|---|---|
| `spec-70` | an agent |
| `spec-70/research` | a sub-agent |
| `spec-70/@Tharsis` | a context of that agent |
| `spec-70/@Tharsis/@z12` | a nested context |
| `@#70/spec-70` | agent spec-70 grouped under the session's context #70 |
| `@#70/@step4/spec-70` | an agent under a nested task context |

- `@~` on the LAST segment sets that node's current line.
- Quote segments with spaces: `@"CTX strip 17"`.
- The old notation is a special case and stays valid: `--agent a/b` plus `@~Ctx` text means the path `a/b/@~Ctx`.

**Limits:** depth ≤ 6 segments, replacing "agent path depth 3" and "32 contexts per agent". Per session, 128 agents
(as before) and a total budget of 4096 nodes. Text, details and data limits are unchanged.

**Rollup** recurses through any depth. The order of precedence is:
1. the node's reported progress;
2. else the sum of its children with a common unit, else their mean %;
3. else, for a node with todo children, "N of M done".

**Todos and plans** (opt-in; ordinary contexts are unchanged and nothing becomes a todo unless created as one):

| State | Shown as | Meaning |
|---|---|---|
| `todo` | ☐ | planned, not started |
| `running` / `blocked` | the usual ring | in progress |
| `done` | ☑ | finished |
| `skipped` | ~~struck through~~ | dropped from the plan but kept visible, so the plan stays honest |

`skipped` is a new state, valid only for todos.

- **Creating a plan:** `--plan "A" "B" "C"` (the tool takes `plan:[...]`) creates ☐ children under the target
  context in the GIVEN order. Plans are shown in creation order, never sorted A→Z.
- **Ticking off:** `@~#70/@B` with `--state done`, or the `--done` shortcut. A todo may be ticked by the session
  itself or by **any agent under it**.
- **Stale:** a todo never goes stale in ANY state. Staleness belongs to agents.
- **Lifetime:**
  - Open todos never expire while their session exists.
  - A plan expires 24h after its last item is done or skipped, or when its parent finishes.
  - **Carry-forward:** at each local day rollover the gateway writes a checkpoint of every open plan (and other
    long-lived nodes) into the new day's JSONL. A plan open for weeks then survives the 24h replay window and the
    7-day file retention.

**Batch logging.** One call may log several items.
- The tool takes `items:[...]`. Each item has the same fields as a single message (path/context, text, state,
  progress, eta, stale_after, details, data, log, plan), plus an optional `ref` echoed in its result.
- Items are applied in order. The result is `{ok, results:[...]}` with one result per item; one bad item does not
  abort the others.
- Bounds: at most 64 items and 64 KB per call.
- Script: `--batch <file.json|->` reads a JSON array from a file or stdin. `--plan` is shorthand for a batch of
  todos.
- Each batch is gossiped as one coalesced update, as usual.

**Step 6 answers (Robin, 2026-10-02):**
1. No separate dashboard credential for now; revisit when the realm has outside users.
2. `{log_snippet}` teaches `--stale-after` for long silent steps (builds, test runs). No per-session default.
3. The Activity section opens by default.
4. The gossip carries each node's log entry count, so remote Log rows can say "N entries".
5. The history view stops at the start of the node's current run (the `new_entity` marker), with a "show earlier
   runs" link.
6. The connect reminder goes to Cowork too; its version points at the `log` tool instead of the script.

**Revised step 6:**
- **6a:** the unified tree (core, wire, JSONL, dashboard) plus batch logging. **BUILT (v1.62.0, 2026-10-02)** — see
  "6a as built" below and architecture.md §13 "Built (v1.62.0)".
- **6b:** todos and plans (states, `--plan`, rollup, lifetime and carry-forward, the ☐/☑ display). **BUILT (v1.63.0,
  2026-10-02)** — see "6b as built" below and architecture.md §13 "Built (v1.63.0)".
- **6c:** `{log_snippet}` plus the connect reminder (`client:code` with the script; Cowork with the tool), the
  default-open section, gossiped entry counts, and the run-boundary history view — plus "Decisions before 6c and 6d".
  **BUILT (v1.64.0, 2026-10-02)** — see "6c as built" below and architecture.md §13 "Built (v1.64.0)".
- **6d:** the dashboard's right-click actions ("Decisions before 6c and 6d" table) plus "Decisions after 6c, for 6d" (the
  agent-finish rule, abandon_plan on agents, the log panel, open ancestors, the cf entry count, unfiltered counts, the 0–7 d
  slider). **BUILT (v1.65.0, 2026-10-02)** — see "6d as built" below and architecture.md §13 "Built (v1.65.0)".

**6a as built (v1.62.0, 2026-10-02):**
- **Model** (`lib/activity.js`): `sess.nodes` (flat, keyed by `lc(canonical path)`) + `sess.kids`; the session is the
  root node (agent-like). Agents and contexts as specified; intermediates a path names are created **implicit** (no
  line); the OWNER of a message = its nearest agent (else the session).
- **Paths** exactly as the table above (`parsePath` / `resolveAddress`); `@~` / `@root` only on the last segment;
  quoting canonicalised; a context name may no longer contain `/`. **Old notation:** `agent` (agent segments only) +
  `path` + ONE trailing context (the `context` param, else a leading `@…` text prefix — itself a relative path);
  context beats a prefix, agent and path concatenate. New `path` field in the tool and `--path` in the script.
- **Staleness decision:** agents only (and the session; an implicit agent — or a session that only reports through its
  agents — never goes stale). A context shows its nearest agent ancestor's stale / gone, only while it has a live current
  line of its own (a grouping context with no line shows no state). **Contexts directly under the session follow the
  session's own reports** (any message the session owns, at any depth not crossing an agent) — as the session row always
  has. A message refreshes target..owner only, so a sub-agent doesn't keep its parent agent fresh.
- **Limits:** depth 6; 128 agents + 4096 nodes per session; room by evicting the oldest finished agent with its whole
  subtree (never an ancestor of the target); else `too-many-agents` / `too-many-nodes`.
- **Rollup** recursive (`rollupStrategies` = the hook for 6b's "N of M todos done").
- **Logs:** one bounded log per node; a node's Log = its subtree merged (k-way, cursor = any entry id); `own:true` for
  the node alone; memory is complete down to the subtree's floor, then the day files (local + remote).
- **Batch:** `items:[…]` (≤64, ≤64 KB) in order, `{ok, results, applied, failed}`; `log` beside items is a default,
  `path`/`agent`/`context` are address defaults only for items naming no path/agent of their own; follower = one frame;
  logger WS; `--batch <file|->`; `--stream` array lines; `plan` → `not-yet`.
- **Formats:** JSONL records v2 (`path`, `new_from`); v1 (1.58–1.61) records skipped. Gossip v2 (one unit per node);
  hubs declare `activity_gossip:2`; a 1.61 hub's frames are ignored and fetches to it are `owner-unsupported`.
- **Dashboard:** sessions + top-level nodes by default; every node expands into its subtree Log + its children (16 px per
  level); agents keep the ring, contexts a ring-less state mark; Projects / Sessions / **Nodes**.

### Questions before 6b (raised by the 6a build, 2026-10-02 — not decided)
- **Todos as contexts.** 6b's todos are context nodes with the new `todo` / `skipped` states. Should a todo be its own
  node kind (a third kind, with its own rules: never stale, `skipped` valid only there, creation order kept), or a
  context flagged `todo`? A flag keeps the path grammar unchanged (`@B`); a kind would need a marker in the path.
- **Who may tick a todo.** "The session itself or any agent under it": a todo under `@#70` (session-owned) ticked by
  agent `spec-70` (`@#70/spec-70`) addresses `@#70/@~B` — but the script reports as the SESSION identity, so any
  report naming that path can tick it today. Is that enough, or should the tick be restricted to the session or an
  agent whose path is under the plan's parent?
- **Plan expiry vs node eviction.** A plan "expires 24h after its last item is done/skipped, or when its parent
  finishes". With subtree eviction, a finished agent's plans go with it at once when room is needed — fine? And should
  an open plan count against the 4096-node budget (a long plan could crowd out agents)?
- **Carry-forward + the replay window.** A plan open for weeks is re-checkpointed at each day rollover; its todos'
  `log_floor` will then be the window start (older entries only in files). OK for the history view (6c stops at the
  run boundary anyway)?
- **Default ordering.** 6a lists children in CREATION order (stable; what plans need). Robin may prefer A→Z for agents
  and creation order only for todos.
- **The multi-host headline.** 6a picks the most recently active host's root **that has a line** (an agents-only host
  no longer blanks the headline). Confirm.
- **Batch address defaults.** Beside `items`, `path`/`agent`/`context` are address defaults only for items that name no
  `path`/`agent` of their own (an item's own path does NOT nest under the default path). `--plan` in 6b is "a batch of
  todos under the target context" — it will want the opposite (each title nested under the target). Keep the rule and
  let `--plan` build its own paths?

### Decisions before 6b (Robin, 2026-10-02)
1. **A todo is a context with a todo status.**
   - Contexts gain the states `todo` (☐) and `skipped` (struck through).
   - A context created with status `todo` is automatically remembered as a plan item. Once ticked it stays a plan
     item: it shows ☑ (not ✓) and keeps the plan lifetime rules. No caller-visible flag is needed.
2. **Ticking:** left as is. Any report naming the path may tick a todo.
3. **Finishing only changes status.**
   - The "Active only" filter is how finished work is hidden.
   - `finished_visible_hours` defaults to **168 (7 days)**, matching log retention; still per-host configurable.
   - Removal under the hard limits (the 128-agent / 4096-node caps, the memory budget) stays as a last-resort
     safety valve, and **never removes a subtree that still has open todos**. Plans count toward the node budget.
4. **Carry-forward:** the day-rollover checkpoint restores each plan with its current state (every todo's ☐/☑/skipped).
   Older history stays in the files and can be paged.
5. **Children** keep creation order everywhere.
6. **Multi-host headline:** whichever machine most recently set a headline. Each host's own line stays visible when
   the row is expanded.
7. **Batch paths are RELATIVE** to the batch's default path, as with folders. A leading `/` makes an item's path
   absolute from the session root. So `--path @#70 --plan "A" "B"` simply creates `@#70/@A` and `@#70/@B`. This
   changes 6a's "item path replaces the default" rule.
8. **Host tags:** shown only where a node's host differs from its parent's (6a showed one on every row of a
   multi-host session).

### 6b as built (v1.63.0, 2026-10-02)
- **The plan-item marker** is `node.plan` (+ `plan_ix`, its position in the plan call that made it) — no caller-visible
  flag. It is set when a plan creates (or adopts) the context, or when a context's FIRST current line has state `todo`, and
  it is never cleared. On the wire: every record of a plan item carries `plan_item:true` + `plan_ix`; gossip nodes and
  dashboard units carry the same two fields; the replay marks a node a plan item if any of its records says so.
- **States:** `ACTIVITY_STATES` + `todo`, `skipped`. Agents / the session → `bad-agent-state` (parse time). `skipped` on an
  ordinary context, `todo` on one that already has a line, or a plain (non-`@~`) todo on a new context →
  `not-a-plan-item`. An `@~` line with no state on a ☐ item starts it (running). An `@~` line WITH a state may omit text
  (`keepText`: the line keeps its text — else the node's name). A plan item never goes stale and never shows gone
  (`staleAt` / `effectiveState` return its own state); its owner agent's row still shows that agent's staleness.
- **Plan API:** `plan:[names]` on any message or batch item (`parsePlan`: 1..64 names, one context segment each, one
  leading `@` dropped, repeats folded with a `plan-duplicates` warning, else `bad-plan`; depth checked). Text optional
  (`planOnly`: the target gets no message of its own; with text, the target's message first). Each NEW or ADOPTED item
  gets a LOGGED ☐ entry whose text is its name — even with `log:false` — so a plan always reaches the files; `apply`
  returns `records:[…]` (target entry first, then the items) and `plan:[{name, path, created?, adopted?, plan_item, state}]`.
  **Re-plan merge rule:** an existing item is kept exactly as it is (state, place); a new name is appended at the END in
  the given order; a name left out stays; re-ordering moves nothing; an existing context with no line of its own is
  ADOPTED; one with a line is left alone (`plan_item:false`). Children keep creation order everywhere (created_at, then
  plan_ix, then key — the replay rebuilds it from the records' order too).
- **Rollup combination:** reported progress → SUM of the ORDINARY children's bars when they share a unit → their MEAN % →
  "N of M done" over the PLAN-ITEM children (`{done, total: items − skipped, unit:'done', todos:true, skipped, n}`; all
  skipped → no bar; failed counts as not done). A plan item counts only as a todo of its parent (its own bar never enters
  the parent's sum/mean). Plan bars sum up the tree like any shared unit (`todos` kept when every summed bar is one).
- **Lifetime:** `finished_visible_hours` 168. `expire`: nothing holding an OPEN item (todo / running / blocked) expires —
  a finished agent with one stays, and so does a GONE session with one (the build's reading of "while their session
  exists" — see the questions); a plan ENDS when its last item became done / skipped or its owner finished (whichever
  first; `planEndAt`) and expires a window later (`planRemoval`: its items, and the plan node when it is a plain context
  left with nothing else and no live line; a nested plan's node is an item of its parent plan and stays). **Eviction**
  (`evictionCandidates`, shared by `apply` and `enforceBudget`): finished agents and ended plans, oldest first, never a
  subtree holding an open item, never on the target's path; else `too-many-nodes` / `too-many-agents`.
- **Carry-forward** (`planCarryForward`): `cf` records `{v:3, kind:'cf', ts, path, …identity, current (full line), state,
  progress, eta_at, created_at, last_activity, stale_after_ms, implicit, plan_item?, plan_ix?, finished_at? (agents),
  new_from?}` for (1) every open plan item and all its ancestors and (2) every node whose own state (line / bar / ETA /
  reported activity) was last persisted before now − window + 25 h (`node.pt` tracks when each reached the files), parents
  first. The replay treats a `cf` as a snapshot of its TARGET only (its own created_at / last_activity / implicit; no
  activity refresh for anyone else). **Trigger:** the gateway checks the activity clock every `AI_BRIDGE_ACTIVITY_
  ROLLOVER_CHECK_MS` (30 s) and writes the cfs into the new day's file when the local day changed; after a restart's
  replay it writes them at once unless today's file already holds one (`finish().cf_today`). The test-only
  `AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS` shifts the whole activity clock.
- **6a adjustments:** `withDefaults` makes an item's path / agent RELATIVE to the default agent + path (a leading `/` on
  the item's first address field = absolute; an invalid item agent is passed through so its own error shows); the headline
  = the root with the newest current-line time (tie → most recently active; none → most recently active host) — 6a's
  "most recently active host WITH a line" differed when a host set its headline earlier but reported later; host tags only
  where a node's host differs from its parent's (a top-level node compares with the headline host); the expanded multi-host
  session shows each host's own line above its Log.
- **Formats:** records + slices v3; `recordKind` reads v2 and v3 (`cf` is a new kind); slices must be v3; hubs declare
  `activity_gossip:3`.

### Questions before 6c (raised by the 6b build, 2026-10-02 — not decided)
- **`{log_snippet}`** — should the agent snippet teach plans (`--plan`, `@~…/@Item --done`) or only `@~root` + milestones?
  Plans are mostly an orchestrator tool; agents mainly tick items. And `aimb-log.mjs` reads `AI_BRIDGE_TOKEN_FILE` but has
  no `--token-file` flag: the #75 part 2 fix for `{doorbell_cmd}` will want the same for the log snippet.
- **The connect reminder** — Cowork gets the tool form: should it mention `plan` / ticking too?
- **Activity open by default** (decided) — with plans, should a plan node also open by default (its items visible), or
  stay closed behind its "N of M done" bar?
- **Gossiped entry counts** (decided) — a node's own count, or its subtree's (what the Log row shows)?
- **The run-boundary history view** (decided) — a carried-forward plan's run can begin in a file the retention already
  pruned: should the view say "earlier history pruned" when the run start is older than `log_retention_days`?
- **Gone sessions holding open items** never expire (and the budget can't evict them). Keep, or expire a gone session's
  plans after N × the window?
- **Mixed rollup** — a node with plan items AND ordinary children with bars shows the ordinary children's rollup (6a's
  precedence, as decided). Should the plan's "N of M done" win on such a node instead?
- **failed / idle items** don't end a plan (only done / skipped do; the owner finishing does). OK?
- **Host tags at the top level** compare with the session's headline host (so the headline host's top-level rows are
  untagged). OK, or tag every top-level row of a multi-host session?
- **Replay length** — the window is now 7 days of files, so a restart reads up to 7× more (phase 1 still publishes early).
  Fine for now?
- **A "Plans" filter** for the dashboard was not built (kept small). Wanted?

### Decisions before 6c and 6d (Robin, 2026-10-02)
1. **`{log_snippet}` teaches `--plan` and `--done`,** one line each.
2. **`aimb-log.mjs` gets `--token-file`** (#75 part 2), like the doorbell.
3. **The Cowork connect reminder mentions plans,** via the `log` tool's `plan` field.
4. **Finished plans:**
   - They stay EXPANDED for `finished_plan_open_min` (per-host config, default **120**), then collapse out of the
     default view. They are not deleted; the 7-day window still applies.
   - A dashboard slider adjusts this live. It is NOT persisted, like the stale slider.
5. **Gossiped entry counts are per node;** the dashboard sums a subtree itself.
6. **History** shows "earlier history pruned" when a run began in a file that retention has deleted.
7. **Plan rules:**
   - **Abandoned is a NEW state** for plans and plan items (shown greyed). Open plan items of a gone session are
     **abandoned automatically after 90 days** (`abandoned_plan_days`, per-host config). They can also be abandoned
     by hand (6d).
   - **A plan does NOT end** while any item is anything but done. Skipped, failed and idle items keep it open;
     only all-done ends it. Otherwise it ends only when marked complete or abandoned (6d right-click).
     **This supersedes 6b's "done or skipped ends a plan".**
   - On a mixed node, ordinary children's bars win over "N of M".
   - **Top-level host tags compare with the session's HOME host** (the host it first registered on), not the
     headline host, so tags don't flip.
8. Replay reading up to 7 days of files at startup is accepted.
9. **A "Plans" filter** beside "Active only" shows only plans and their items, across all sessions.

**6d: dashboard right-click actions (the dashboard's first WRITE path):**

| On | Actions |
|---|---|
| Plan item | Mark done · Skip · Reopen (back to ☐) · Abandon |
| Plan | Mark complete · Abandon plan · Reopen |
| Agent or session that is stale or gone | Mark finished (done or failed) · Dismiss (remove it from the board now) |
| Any node | Copy path · Copy its `aimb-log` command · Copy entry id |
| Any node (view only, kept in the browser) | Pin · Hide |

- An action on another host's node is forwarded to that host's gateway, so each host still writes only its own nodes.
- Every action is logged as an entry ("… by <user> via dashboard (<host>)").
- Abandon plan, Dismiss and Mark finished ask for confirmation.
- Editing someone else's text and deleting history are NOT offered; the files stay append-only.
- Considered for later: messaging a node's session, and "nudging" a stale agent's orchestrator.

### 6c as built (v1.64.0, 2026-10-02)
- **Snippet + reminders** (`lib/log-snippet.js`): `{log_snippet}` = `Report your status with: "<node>" "<…/tools/aimb-log.mjs>"
  --session "<name>" --project "<project>" [--token-file "<path>"] --path <agent-path> "<text>"` + six lines (@ctx vs @~ctx;
  milestones + --no-log; --stale-after 60m; --plan "A" "B"; --done; finish @~root --state done / failed + no secrets);
  `{log_tool_hint}` = the `log({ as:"<name>", secret, text })` form with path / log:false / stale_after / plan:[…] / a tick /
  the finish. Expanded at emit time, lazily. `config.example.json` realm block (`updated_at` 2026-10-02): the doorbell
  reminder + `client:code` (put {log_snippet} in each agent's prompt; your own status with @~root via the log tool) +
  `client:cowork` ({log_tool_hint}), both `"id":"activity"` — **a config default may carry an optional `id`** (reminders.js
  `defKey`) so several share one (operation, scope, match); a session's own reminder still overrides all of them; a ≤1.63
  host ignores the id (last one wins). The live `src/config.json` was NOT edited. Server instructions: two lines on the
  `log` / `activity` tools. #75: `TOKEN_FILE_PATH` (only when the token really came from the file) → `tokenFileArg()` on
  `doorbellCmd` and the snippet; the `set_wake` hint says where the token comes from.
- **abandoned** (`ACTIVITY_STATES` + abandoned; `DONE_OR_FAILED` now also abandoned): valid on a plan item or a node holding
  plan items (an agent / the session too — it finishes); else `not-a-plan` (checked in `apply`; parse accepts it). Rollup:
  abandoned items stay in M as not done (`progress.abandoned`).
- **Plan end** (`planOf` → `allDoneAt`; `planEndAt` = all done, or the node's line done / abandoned; `PLAN_END`):
  `openPlanKeys` = every item of a NOT-ended plan + its ancestors (any item state) — expiry, eviction, active_only and the
  carry-forward all use it. 6b tests whose fixtures relied on "skipped ends a plan" / "a finished owner ends it" were
  updated to the new rule (all-done fixtures, failed instead of done for agents that must keep an open plan).
- **Auto-abandon** (`autoAbandon(state, now, {live})`, called from the gateway's GC sweep with live = on this host's
  roster): sessions not live and quiet / gone ≥ `abandoned_plan_days`; deepest open plans first: each todo / running / blocked
  item, then the plan node, gets an `@~` abandoned line through `apply(…, { by: 'bridge' })` — a SYSTEM message (no
  touch: last_activity / stale_after / gone / the owner's implicit untouched; `by` on the small entry + the record; the
  replay skips activity for `by` records too). Records persisted in order.
- **Counts:** `snapNode` + `log_n` (own entries = log + dropped; a remote node re-gossips its `log_n`) and `log_partial`
  (`node.partial` = the replay never saw the record that began the run); `boardView` `log` = `{entries, dropped, total,
  partial?}` / `{remote, total, partial?}`; the dashboard's `subtreeLog` sums and marks "N+".
- **Run boundary:** `fileRunStart(rec, target)` (a record of the session at or under the node with `new_from ≤ depth`) and
  `filePage(lv, files, records, {earlier})` — the bridge's day-file half of a page, now in the library: stops at the
  current run's first record (`run_start`; `earlier_cursor` when a bounded peek finds an older entry of the node), `pruned`
  when the files run out and `target.partial`; `earlier:true` ignores boundaries. The first file page starts in the day
  file of memory's oldest served entry. The tool schema has `log.earlier`.
- **Home host:** `s0` (the session's created_at) on every entry / cp / cf record (replay: `s.created = min(…, s0)`);
  `boardView` `home` = argmin(created_at, lc(host)) for a multi-host group; the dashboard's top-level `parentHost`.
- **Board extras:** `plan_node` + `plan_end_at` on plan nodes; `head.finished_plan_open_min` (dashboards + the tool).
- **Dashboard:** `DEFAULT_COLLAPSED` drops activity; `ACT.open[id]` tri-state (undefined = default: `planOpenDefault`);
  Collapse all sets every node explicitly closed; the "plans open" slider (`ACT.planOpenMin`, not persisted); the "plans"
  checkbox (`buildTree({plansOnly})`, persisted); with a filter on, `t.fbar` / `x.fbars` = `rollKids` (a port of the
  library's strategies) over what is shown; pills right after the name/tags; abandoned CSS + glyphs (agent, context, item)
  + legend; "N entries" from `subtreeLog`; the run-boundary rows ("start of this run · show earlier runs…", "— earlier runs
  —", "earlier history pruned"), `by` on entries; rows carry `data-kind`, `data-host`, `data-path`, `data-session`,
  `data-project`, `data-user` (+ `data-nkind`, `data-plan-item`, `data-plan-node`, `data-home`, `data-hosts`, `data-id`) and
  `AimbActView.rowInfo`.

### Questions before 6d (raised by the 6c build, 2026-10-02 — ANSWERED in "Decisions after 6c, for 6d"; built in v1.65.0)
- **An agent that finishes `done` "completes" its plan.** The rule "the plan node set done ends it" makes an agent holding
  a plan (e.g. `lead` with plan items) end its plan when its own line goes done — even with open items, which then expire a
  window later. A `failed` agent keeps its plan open (until auto-abandon). Intended, or should only an explicit "Mark
  complete" (6d) end a plan held by an agent?
- **Abandoning agents / the session.** `abandoned` is allowed on an agent or the session only when it holds plan items (it
  finishes them). 6d's "Abandon plan" on such a node would finish the agent — or should 6d abandon the open items only?
- **Skipped stays out of M** ("N of M done"); with skipped no longer ending a plan, a plan of [done, skipped] reads "1 of 1
  done" yet stays open until marked complete. Keep, or count skipped in M (or end a plan whose items are all done/skipped
  only via "Mark complete")?
- **Auto-abandon scope.** It abandons todo / running / blocked items and then the plan node; idle / failed / skipped items
  keep their state. "Gone" = not on the host's roster AND no message for the window (gone_at isn't kept across restarts;
  a script-only session is never marked gone). OK?
- **A parent's merged log can miss a REMOVED child's run** (an expired / evicted agent whose name came back): paging goes
  memory-first, then the files only BELOW the oldest in-memory entry, so the old run's entries newer than that are never
  shown in the PARENT's log (the child's own log reaches them via "show earlier runs"). Pre-existing since 6a; fix by
  tracking removed subtrees' time spans, or by scanning the files from the newest when the subtree had removals?
- **Default-open scope.** Only the plan NODE opens by default; a plan under a closed agent / context stays hidden until its
  ancestors are opened. Open ancestors too (a plan anywhere visible by default), or leave it to the Plans filter?
- **The Log row of a default-open plan** sits above its items (as for every expanded node) — noisy in a checklist. Hide it
  for default-open plans, or move a node's Log below its children?
- **Counts that understate** ("N+"): a node whose run began before the replay window counts only the window's entries. Carry
  the count in the `cf` record (exact across restarts), or keep "N+"?
- **Filters and the header counts.** With "plans" on, the project / header "N active agents" counts only what is shown (often
  0). Keep (consistent with "rollups follow the filters"), or always count every active agent?
- **The "plans open" slider** spans 0–8 h (it grows to the configured value if larger). Enough?
- **6d plumbing:** a dashboard action on another host's node goes to that host's gateway — reuse the ACTIVITY_REQ link with a
  new op, attribute it `by:"<user> via dashboard (<host>)"` like the bridge's `by`, and require which credential (the
  dashboard's realm token today)?
- **Deploy:** 1.63 and 1.64 hubs don't exchange activity (format v4); publish the realm block (new `updated_at`) only once
  every host runs 1.64 (the `id` field); a host whose MCP config passes the token as `AI_BRIDGE_TOKEN` gets no --token-file
  in its reminders (switch it to `AI_BRIDGE_TOKEN_FILE`).

### Decisions after 6c, for 6d (Robin, 2026-10-02)
1. **Finishing an agent never silently completes its plan.** Open items stay open until someone resolves them, and
   the plan ends only per the 6c rule. This reverses 6c's "an agent finishing done completes its plan".
2. **"Abandon plan" on an agent or session** abandons only its OPEN plan items and leaves the agent or session
   running. Normally this is the orchestrating session's call; the dashboard action is the manual override.
3. Skipped items stay out of M in "N of M".
4. The auto-abandon scope is confirmed: todo/running/blocked items, once the session is off the roster and silent
   for 90 days.
5. The 6a merged-log gap is logged as #76.
6. **Open plans also open their ANCESTORS by default,** so a plan under a collapsed agent is visible.
7. **Logs move out of the tree into a LOG PANEL.**
   - Selecting (clicking) a session, agent or context shows its log (its subtree's merged log, with paging, "show
     earlier runs" and "earlier history pruned") in a separate panel.
   - On narrow screens the panel goes below the tree.
   - No more "Log" rows in the tree.
8. The day-rollover carry-forward record carries the node's entry count, so counts stay exact across restarts
   (no "N+").
9. **Header and project counts ignore the filters**, so they always show the real totals.
10. **The "plans open" slider range is 0–7 days.**
11. **6d actions:**
    - They travel over the existing authenticated hub link (like remote fetches).
    - They are carried out by the owning host's gateway.
    - They are logged with the dashboard user's name.
    - They use the dashboard's realm-token connection.

    Also fix: the abandoned glyph is too faint in dark mode.

### 6d as built (v1.65.0, 2026-10-02)
- **The agent-finish rule** (decision 1): `planEndAt` ignores an agent's (or the session's) own line — finishing done or
  failed leaves its plan exactly as it is (open items never expire, are never evicted, are carried forward). A plan ends
  when every item is done, when a CONTEXT plan node's line is set done / abandoned (as in 6c), or when an agent / the session
  gets the new **plan-end marker** (`node.plan_end`, set by a logged entry `plan_end: done|abandoned`, cleared by `open`).
  Only the dashboard's complete / abandon plan set it — and the tool's `abandoned` line on an agent, which keeps 6c's
  meaning (it finishes the agent AND ends its plan; no conflict: that is explicit, not "silent"). The marker rides gossip,
  cp and cf; the board adds `plan_end_how` (all-done | done | abandoned). Auto-abandon now uses the same helper, so it ends
  an agent's plan through the marker instead of finishing the agent.
- **abandon_plan on an agent / the session** (decision 2), defined precisely: the OPEN plans it HOLDS — its own plan items
  and every plan under it reached WITHOUT crossing another agent (a sub-agent's plans are its own) — deepest first: each
  OPEN item (todo / running / blocked) gets an abandoned line, then each such plan ends (a context plan node by its line, the
  agent / session by the marker). Done / skipped / failed / idle items keep their state; the agent or session itself is not
  touched (its line, state and activity unchanged — it keeps running). `no-open-plan` when it holds none. On a plan node
  (a context) it is the same over that node's scope.
- **The actions** (`lib/activity.js` `applyAction`; wire names): plan item `done` / `skip` / `reopen` (→ todo) / `abandon`
  (`not-a-plan-item`, `no-change`; reopening an item of a plan marked complete / abandoned applies with a `plan-ended`
  warning — reopen the plan too); plan node `complete` (`not-a-plan`, `already-ended`), `abandon_plan` (`no-open-plan`),
  `reopen_plan` — the table's "Reopen" (`not-ended`; `all-items-done` when it ended because every item is done: reopen an
  item instead); agent / session `finish` (args `state` done|failed — `bad-args`; `already-finished`; `not-stale` unless it
  is QUIET: finished, stale or gone at the viewer's slider (`args.stale_min`), or never reported with every reported agent
  below it quiet) and `dismiss` (quiet or finished, every agent below it too — else `not-stale`; `has-open-items` when its
  subtree holds part of an open plan). Plus `bad-action`, `unknown-session`, `unknown-node`, `bad-path`, `not-an-agent`
  (finish / dismiss on a context). Dismiss allows a FINISHED agent too ("ahead of the 7-day window" — see the questions).
- **Attribution:** each applied action is a logged SYSTEM entry on the node (no activity, never un-gones) with `by:
  {kind:"dashboard", user, host}` + `act`; its text "marked done by robin via dashboard (ROBIN-Z790)" (finish: "marked
  finished (failed) by …", dismiss: "dismissed from the board by …"). A line-changing action keeps the line's TEXT (only the
  state changes; the record's `line_text`), so a ☑ item still reads "Build". user = the attached bridge's process user
  (`AI_BRIDGE_USER` / the OS login), else "dashboard"; host = that bridge's host — an owner takes it from the hub LINK.
- **Dismiss persistence:** a logged entry `{…, dismiss:true}` at the dismissed path (shown in the PARENT's merged log, with
  its own path). The replay treats it like an eviction (`evicted`): unless that path was re-created after it (a new run —
  sealed by its `new_from`), older records at or under it are skipped; a dismissed session root means the session is not
  rebuilt. A new report under the name starts a new run. The files stay append-only.
- **Protocol:** WS `{type:"activity_action", ref, host, session, project, user, path, action, args}` → `{type:
  "activity_action", ref, result}` (+ `activity_queued`), dashboard sockets only (`unauthorized` for a page leaf, a logger, a
  socket without a hello). host = this host → applied; another → hub frame `ACTIVITY_ACT {rid, q, by:{user}}` →
  `ACTIVITY_RES` on the existing link, sharing the fetch queue (`busy`) and the owner's per-link bucket; refused
  `unauthorized` on an unadopted socket or a forged origin, `not-owner` when `q.host` names another host,
  `owner-unreachable` / `owner-unsupported` as for fetches; `unknown-host` for a host the board doesn't hold. Followers serve
  no dashboard (the WS ingress is the gateway's), so they have nothing to forward. The MCP tools get no new actions.
- **The log panel** (decision 7): no Log rows; a click selects (highlight; `aria-selected`), the chevron / a double-click
  expands; the panel (right of the tree, below it under 900 px) shows the selection's merged subtree log with its path,
  host, count, the multi-host switch, entries + details / JSON, "load older", "show earlier runs", "earlier history
  pruned", ↻ / ×; a remote node's pages come through the queued remote fetch (spinner); the selection survives deltas,
  re-reads its first page when new entries arrive, and clears when the node leaves the board. Entries get the menu (copy
  entry id / path).
- **Pin / Hide** (per browser, `localStorage` with try/catch): pinned first among its siblings (📌); hidden ones collapse
  into "N hidden — show" on the parent ("hide N again" while shown); sessions per project too; undone from the menu.
- **Keyboard / touch:** focusable rows (`treeitem` / `listitem`), ↑ ↓ Home End, Enter = select, → ← = expand / collapse,
  the Menu key / Shift+F10 = the menu (↑ ↓ Enter Escape inside; focus returns to the row); a 550 ms long-press = the menu
  (the tap that ends it doesn't select).
- **The rest:** open plans expand their ancestors (decision 6); header + project counts from the unfiltered tree (decision
  9); the "plans open" slider = 0 – 7 days in 23 steps (decision 10; the config clamp 0–10080 already matched); the
  abandoned glyph's own colour token (#B8C2D0 in dark mode); a viewport meta tag; the phone rules (≤720 px) moved after the
  base rules — 6a's block came first and its bar / name widths never applied. The cf carries `log_n` (decision 8): a node
  whose run began before the window keeps its exact count (`cpartial`, the count understates, is now separate from
  `partial`, the run began before the window — still "earlier history pruned").
- **Format v5** records + slices (`activity_gossip:5`; v2–v4 records still read).

### Questions after 6d (raised by the 6d build, 2026-10-02 — not decided)
- **Who may act.** Any holder of the realm token whose WS hello says `kind:"dashboard"` can now WRITE (finish / dismiss
  another session's agents, resolve its items), and the entry names the attached bridge's OS user, not the person at the
  browser. Fine for one trusted realm (as step-6 answer 1 said for reads), or now a dashboard credential / a per-person
  identity?
- **Dismiss on a FINISHED agent.** Built as allowed (the "ahead of the 7-day window" wording), though the table said "stale
  or gone". Keep?
- **Reopening an item of a plan marked complete** leaves the plan ended (a `plan-ended` warning on the row). Reopen the plan
  automatically instead?
- **The tool's `abandoned` on an agent** sets the marker; a later running line on that agent revives it but does NOT reopen
  its plan (only the dashboard's Reopen plan clears the marker). OK, or should a revival clear a marker the agent set itself?
- **The tool and the actions.** The `log` tool keeps states only (a session resolves its own items and context plans; an
  agent-held plan can't be "completed" without finishing the agent except from the dashboard). Add `plan_end` to the tool,
  or an `activity {action}` for registered sessions (then followers would forward it like reads)?
- **Session-level actions on a multi-host session** sit on each host's own line (an action names one host's nodes); the
  session row offers only copies and pin / hide. OK?
- **Auto-refresh of the panel** re-reads the first page when the subtree's count changes (≥ 1.5 s apart, not after "load
  older"). Enough, or stream new entries in?
- **Hidden nodes** still count in the header / project totals (view-only). OK?

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
3. `tools/aimb-log.mjs`. **BUILT (v1.59.0, 2026-10-01)** — the script attaches to the GATEWAY's WS port as a
   token-gated `logger` leaf (`hello {kind:"logger", token, ident}` → `{type:"log", ref, input}` → `{type:"logged", ref,
   result}`; never on the roster), one JSON line out, exit 0 / 4 / 64, `--token` refused; `--stream` (NDJSON on stdin,
   one result per line in order, reconnect with backoff, in-flight line `link-lost` and not resent, exit 0 at EOF).
   Plus the Task Tray's prepare-shutdown flush (below). New `test_log_script_live` (40). See architecture.md §13
   "Built (v1.59.0)". **Decisions (Robin, 2026-10-01):**
   - The script reaches the gateway's WS port gated by the realm token, like the doorbell, and registers no sub-peer.
     Identity = `--session` + `--project` (both required) + `--user` (default: the OS login user; `AI_BRIDGE_USER`
     wins like the bridge) + the realm (the bridge's rule). Script-only sessions are never marked gone; they can go
     stale.
   - **Refuse to speak for another user's live session:** a report whose realm + project + session name matches a
     sub-peer currently REGISTERED on the mesh roster (any host) under a DIFFERENT user (case-insensitive) is rejected
     with `session-user-mismatch`. Otherwise anyone holding the realm token may report as any session (accepted).
   - **The tray persists before it kills:** Restart Bridges… and Quit → Shut down all used to `Process.Kill()` the
     bridges, losing the gateway's pending checkpoints (`log:false` progress since the last interval). The tray now first
     POSTs `http://127.0.0.1:<wsPort>/admin/prepare-shutdown` (bearer token, loopback only, 3 s timeout); the gateway
     writes the checkpoints + repeat line and drains its write queue, then answers; the kill follows either way (a
     pre-1.59 gateway answers 404). Followers have nothing to flush, so the request is not propagated. The new tray exe
     is NOT installed yet (Robin builds `tray/windows/build.cmd`).
4. Gossip, plus on-demand fetch of logs, details and data. **BUILT (v1.60.0, 2026-10-01)** — the host is in the identity
   (`sessionKey` + host; a local entity's host is always this origin; the replay keys pre-1.60 records with this host);
   `ACTIVITY_SLICE` full on (re)link / `resync`, then deltas against a per-link published view (`planSlice` /
   `applySlice`, epoch + seq), ≤1 frame/s per link (a change only kicks the link's timer), 256 KB cap newest-active first
   (`truncated`; the rest next second); ownership = the link's host, a frame naming another origin dropped; a dropped /
   retired / expired link or `ACTIVITY_DOWN` (prepare-shutdown, clean exit) marks that host's agents gone until its next
   full slice; the board GROUPS by realm + project + user + session name across hosts (`host` per entity, `hosts` +
   `selves` when a session spans several); remote `log` paged by the owner (50 entries / 32 KB, `cursor` →
   `next_cursor`), remote `entry:{id, host?}` with details/data, 4 fetches/s per link (`rate-limited`),
   `owner-unreachable` / `owner-unsupported`; followers keep forwarding reads; dashboards get `activity_board` pushes
   (≤1/s) + `{type:"activity"}` requests; bare sessions count for `session-user-mismatch`. `test_activity_unit` 427, new
   `test_activity_gossip_live` (44; 38 FAIL pre-change). See architecture.md §13 "Built (v1.60.0)". **Open before step
   5:** see "Questions before step 5" below.
5. The dashboard Activity tree. **BUILT (v1.61.0, 2026-10-02)** — the layout Robin approved in the mockups (tree only;
   project cycle + Projects / Sessions / Agents; one row per multi-host session with host tags; the status glyph whose
   ring empties toward stale; hover-only times; pills for blocked / failed / stale / gone + a distinct host-down badge;
   🔔 / ⌛; the stale slider client-side; active only; Expand / Collapse all; a legend; light + dark tokens) in a new
   collapsible **Activity** section of `dashboard.html`, plus the server side of "Decisions before step 5": deltas to
   SUBSCRIBED dashboards (full on `activity_sub`, then per-dashboard `activity_delta` ≤1/s, seq gap → resync; lib
   `boardView({raw})` / `dashUnits` / `planDashDelta`), paging into the day files (`logView({files})` + `actLogPage` +
   the facet's `readBackwards({before})`, file cursors `f1.<day>.<offset>`, ≤8 MB scanned per page), queued remote
   fetches (a per-link queue paced by a mirror of the owner's bucket; `busy` beyond 64 per link / 16 per dashboard /
   a caller's max wait; `activity_queued` + `queued_ms`), read access (WS activity for dashboards only; one hello per
   connection), `host_down` / `hosts_down`, the `bell` (doorbell listeners → `setBells`, gossiped in the header) and the
   duplicate-hostname WARN. `test_activity_unit` 448, new `test_dashboard_activity` (62, jsdom) and
   `test_activity_dashboard_live` (36; 28 FAIL pre-change). See architecture.md §13 "Built (v1.61.0)".
6. Revised into 6a / 6b / 6c (above). **6a BUILT (v1.62.0, 2026-10-02)** — the unified node tree + batch logging;
   `test_activity_unit` 516, `test_log_live` 66, `test_log_script_live` 50, `test_activity_gossip_live` 48,
   `test_activity_dashboard_live` 41, `test_dashboard_activity` 85. **6b BUILT (v1.63.0, 2026-10-02)** — todos + plans,
   lifetime + carry-forward, the 6a adjustments; `test_activity_unit` 588, `test_log_live` 75, `test_log_script_live` 54,
   `test_activity_gossip_live` 51, `test_activity_dashboard_live` 43, `test_dashboard_activity` 105, new
   `test_activity_carry_live` 11. **6c BUILT (v1.64.0, 2026-10-02)** — the snippet + reminders (+ #75 part 2), abandoned + the
   plan-end rule + auto-abandon, gossiped counts, run-boundary history, the finished-plan window, home-host tags, the Plans
   filter, the 6b rough edges, 6d hooks; `test_activity_unit` 630, `test_dashboard_activity` 132, new
   `test_activity_6c_live` 31 (+ updated `test_log_live`, `test_activity_gossip_live`, `test_activity_dashboard_live`,
   `test_activity_carry_live` for format v4 and the new rules). **6d BUILT (v1.65.0, 2026-10-02)** — the right-click actions
   (local, and forwarded to the owner as `ACTIVITY_ACT`), the agent-finish rule + the plan-end marker, abandon_plan on agents,
   dismiss (persisted, honoured by the replay), the cf entry count, the log panel, pin / hide, keyboard / touch, open
   ancestors, unfiltered counts, the 0–7 d slider, format v5; `test_activity_unit` 664, `test_dashboard_activity` 186, new
   `test_activity_actions_live` 43 (+ the format-v5 updates). **The #70 build plan is complete** — next: the deploy.

### Questions before step 6 (raised by the step-5 build, 2026-10-02 — not decided)
- **Who sees the board.** The WS rule is "dashboards only", but a dashboard is just a token holder that says
  `kind:"dashboard"` in its hello (a page holds the same token and could connect as one). Fine for a one-realm trust
  domain — or should dashboards get their own credential?
- **The snippet's stale_after.** Agents running long silent steps (builds, test suites) go stale at 15 min. Should
  `{log_snippet}` teach `--stale-after` for those steps, and/or should a session be able to set a default stale_after for
  its agents?
- **The Activity section is collapsed by default** (so a dashboard that never opens it costs nothing). Open it by
  default instead (Robin opens it once and the choice persists either way)?
- **Remote log counts.** A remote entity's Log row says "all contexts · HOST" (the gossip carries no entry count).
  Carry `log.entries` in the gossiped entity (a few bytes) so remote rows show "N entries" too?
- **Older instances in the files.** Paging into the day files follows the identity, so an agent name that finished and
  later reappeared shows its older instance's entries further down. Stop at the instance start (the `new_entity` marker)
  instead?
- **The connect reminder's audience** (step 6 as proposed): `client:code` only, or Cowork too (it can't run the script
  but has the `log` tool)?


### Questions before step 5 (raised by the step-4 build, 2026-10-01 — ANSWERED in "Decisions before step 5"; built in v1.61.0)
- **Dashboard data path.** v1.60.0 pushes the WHOLE merged board to dashboards (`activity_board`, ≤1/s, only while one
  is connected) and answers `{type:"activity", query}`. Fine for a few hosts; at a large mesh the dashboard may want the
  same deltas the hubs exchange. Keep full pushes, or send deltas?
- **Stale slider.** The board's `state` uses the gateway's `stale_after_min`; the raw `last_activity` / `stale_after_ms`
  are there, so the dashboard can recompute stale for its own slider client-side. Confirm it does that (no round trip).
- **A session on several hosts.** The group has `hosts`, `selves` (one per host) and `self` = the most recently active
  host's. Show one headline row (which?) with per-host sub-rows, or one row per host?
- **Gone vs host down.** Both show `gone` (a session that left its roster vs. its whole host down / unreachable).
  `remote_hosts[].down_at` / `linked` tell them apart — should the tree show a host-level "down" marker?
- **History depth.** Paging (local and remote) covers the in-memory log (`log_entries_per_agent`, 200); older entries
  are only in the owner's day files (an `entry` lookup still finds them by id). Page on into the files (needs a
  per-entity offset index), or is 200 enough for the tree?
- **Remote fetch budget.** The owner serves 4 fetches/s per link; a dashboard expanding many remote logs at once will
  hit `rate-limited` (`retry_after_ms`). Queue on the requesting gateway instead of failing back?
- **Who may read.** Reads stay realm-wide (status text is plaintext by decision); the WS request path is dashboards
  only. Should page leaves get it too?
- **Same hostname on two machines.** The origin is the hostname (from the peer gateway's session id); two machines with
  the same hostname would fight over one slice. Accept (it also confuses #63), or key by hostname + advertise address?

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
