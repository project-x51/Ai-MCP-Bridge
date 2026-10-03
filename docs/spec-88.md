# #88 spec (final pass) — stable node identity, v2.0

Status: FINAL, 2026-10-03. Robin has answered Q01 – Q41 and confirmed two follow-ups (no v5 network projection; how
duplicate labels behave). He then added `--move-to` and transient contexts (Q43, §3.8), answered its two follow-ups (Q44 grace period,
Q45 no bare names in `--move-to`) and revised the depth limit for 2.0 (Q11b: hard 32, warning past 20). During the build he
answered Q46 (only `/…` and single-step `../X` for `--move-to`, plus a resolve helper), added GROUPS (a context shown as a
list, not a plan), reversed 6c decision 7 for bars (ROLLUP: a plan node's bar is its items only) and made nodes and entries
TYPED (§1.7: a built-in registry of node types — a group is `--context-type=group`, a question a node of type `question` —
and of message types — an answer is an `answer` entry). All his decisions
are in §9 "Decisions". The build (§8) has started (steps 1, 2a and 2b done; 2c and 2d built, see §8 — 2d made `test-run` and
`test-result` real types and filled the registry's `menu` slot for #92; Robin then answered Q50 – Q60, changing Q56 (one
tests bar) and Q57 (with Q61 / Q62: state is progress, result is outcome — a test-result sets the state to done) and added
TIME in the logs (§5.7); step 3 built the v6 records + replay, the day / index files and the time; step 4 built the
conversion library — Robin accepted its Q63 – Q65 as built; no question is open).
The agreed design is in
`docs/issues.md` "#88"; this spec makes it exact. Code references are to v1.72.0 (`src/lib/activity.js` unless another file is
named); the guide references (#89) are to v1.74.0.

**One paragraph.** Today a node's PATH is its key (`newNode`: `key = lc(path)`), so a move rewrites history: `applyMove` /
`rekeySubtree` re-key memory, the replay remaps every older record through later moves (`createReplay`: `remapSegs`, `foreign`,
`goneAt`, `sealRuns`, `movedAt`), and log paging follows `moved_from` aliases (`nodeAliases`, `matchAlias`). v2.0 gives every
node a stable INTERNAL ID, minted once from (owner host, session, creator, key). Label, parent, rank and kind become attributes
set by small NODE RECORDS; log entries, checkpoints, gossip and the dashboard name the id. A move or rename is one record and
nothing is rewritten; a node's log is "entries whose id is in this subtree now". Paths stay as a shorthand (no `@` any more)
that resolves against the current tree, then aliases, then creates. **2.0 is a clean, no-legacy cutover:** every bridge on
every host stops, a standalone script converts each host's own history in place (from a backup that exists only while the
script runs), and the bridges start again in any order. A 2.0 bridge refuses to start on unconverted history. The 1.7x
command forms are gone from the API (an old form gets an error naming the new one), and 2.0 speaks only 2.0 on the wire: there
is no v5 projection and no support for a 1.7x host, so **every host is upgraded together**, with the stop-all runbook (§7.1).

---

## 1. Identity model

### 1.1 Creator and key
- **A node's identity is (owner host, session, creator, key).** The owner host is the host whose gateway holds it (unchanged:
  `sessionKey` already includes the host; each host writes only its own nodes). The session is realm + project + user + session
  name (`groupKey`'s four parts). The CREATOR is the session itself or one of its AGENT nodes. The KEY is a short name the
  creator chooses.
- **Written form:** `<creator chain>:<key>`. The creator chain is the creator agent's own key, prefixed by ITS creator's chain
  with `/` (`spec-88`, `spec-88/research`); the session is the empty chain. So `spec-88:docs`, `spec-88/research:notes`,
  `:88` (a key of the session). Nobody has to type this form for their OWN nodes (§3).
- **Key rules (fixed in code, like every #70 limit):**
  - 1 – 48 code points; first `\p{L}`, `\p{N}` or `_`, then those plus `. # + -`. That is today's agent-segment rule
    (`SEGMENT`, `normAgentSeg`) **minus `:`** (hole H1: `:` is legal in agent names today and would make `a:b:c` ambiguous).
  - Compared case-insensitively (`lc`), first-seen spelling kept (the #71 rule, as paths today).
  - Reserved: `root` (any case). Bridge-made question keys are `?<digits>` (`?1`, `?2`; #85's `@?N`) — valid only when the
    bridge mints them; a caller may reference them.
  - A key never changes. A label does (§1.3).
- **Scope:** keys are unique per (owner host, session, creator). Contexts and agents share the creator's one namespace (so
  `--key spec-88` from the session finds the agent `spec-88`). The same key under two creators is two nodes (`spec-88:docs`,
  `spec-89:docs`): two agents can each have a `notes` key.
- **A duplicate key is never accepted** (Q31). Within one creator a key names ONE node: a create with a key that exists
  reaches that node (§3.5, idempotent), `--item <k>` for a key that exists elsewhere in the scope makes nothing new
  (`exists-elsewhere`), and a slug-made key gets `-2`, `-3` … Keys are never auto-renamed the way labels are (§1.6).
- **Slug** (a key made from a label, for path-created nodes and label-only `--item`): NFC, whitespace runs → `-`, drop
  everything outside `[\p{L}\p{N}_.-]`, collapse `--`, strip leading non-`[\p{L}\p{N}_]` and trailing `-` / `.`, ≤ 40 code
  points; empty or `root` → `node`. On a clash in that scope: `-2`, `-3` … (prototyped: "#88 stable node identity (v2.0)" →
  `88-stable-node-identity-v2.0`, "Next release" → `Next-release`).

### 1.2 The internal id
- **Minted once, stored, never recomputed.** Every node carries `id` in memory, in every record, on the wire.
- **v2-born node:** `id = base32(sha256(JSON.stringify(["aimb-node/2", lc(host), lc(realm)||"default", lc(project),
  lc(user), lc(session), lc(creatorChain), lc(key)])))`, the first **16** characters (80 bits), RFC 4648 alphabet lower-case
  `[a-z2-7]`, no padding. The session root: creator chain `""`, key `""`.
- **Migrated node (§7):** `id = base32(sha256(JSON.stringify(["aimb-node/legacy", lc(host), …session…, pathKey])))[0..16]`,
  `pathKey` = the v5 key (`lc` canonical path) of the node's FINAL path in the converted history. The two prefixes keep the
  two families apart.
- **Why a hash and not a counter:** no allocator state to persist; a retried create mints the same id; re-running the
  migration gives the same ids (a crashed run resumes to the same bytes, §7.2).
- **Collisions:** at 80 bits and ≤ 10⁶ nodes per host over retention, p ≈ 4·10⁻¹³. A mint that hits a DIFFERENT live node's
  id (creator / key differ) is refused `id-collision` and logged; nothing silently merges.
- Prototyped (scratch, Node's `crypto`): Bridget's root on ROBIN-Z790 = `mkjhhu3kyjf2gbcv`, `:spec-88` = `uytyq4e6wsmtqsfq`,
  `spec-88:docs` = `rtam3yvgwkzx5zbp` (the same for any letter case of host / session / chain / key).

### 1.3 Attributes (all set by node records, §2.1)
| Attribute | Rule |
|---|---|
| `label` | the node's NAME, what is shown; 1 – 60 code points, no control characters (today's context-name rule `normContextName` minus the `/` and `"` bans). **Required at creation, never defaulted from the key** (Q31): `--label` / `label`, the `--item` label, or the path segment that creates it; only bridge-made nodes (the session root, questions `?N`) are labelled by the bridge, as today. **Unique among its siblings** (§1.6). |
| `parent` | an id in the same session on the same host (cross-session moves: later, Q14). Never the node itself or below it. |
| `rank` | #82's fractional base-36 rank, unchanged (`rankBetween`, `placeRanks`, `derivedRank`, `siblingCmp`): stored only when placed, else derived from created_at + plan_ix. |
| `kind` | fixed at creation: `agent` or `context`. Never changes. |
| `plan` | a context becomes a PLAN ITEM for good (6b) — the one kind change, its own record (`op:"item"`). |
| `type` | (TYPES, §1.7) the node's TYPE from the built-in registry: a context's is `context` (the default), `plan`, `group` or `question`; an agent's `agent`, the root's `session`. Given at creation (`--context-type=<type>`, on the create record); changed only by the dashboard (Show as group / Show as plan: an `op:"type"` record) or by `--ask` (a line-less context becomes a `question`). A GROUP (§5.7) is a context of type `group`. |
| question | a node of TYPE `question` (§1.7, §5.8); its current line carries the question object (`line.question`, #85). |
| `merged_into` | §3.6. |

**Depth (Q11b — revises Q11 for 2.0; 1.7x keeps its limit of 6).** A node's depth is its number of steps below the session
root (a child of the root is depth 1). Checked on every create and every move (incl. merge, unmerge and `--move-to`):
- **Hard limit 32** (`depth_max`): a create or move that would put ANY node deeper than 32 is refused `depth`, nothing
  written. For a move the whole moved subtree counts (its deepest node lands at new parent depth + 1 + the subtree's height);
  the error names that deepest node (`{id, key, label}`) and the depth it would reach. The dashboard's Move-to picker greys
  out such targets.
- **Soft warning past 20** (`depth_warn`): a create or move that leaves a node at depth 21 – 32 succeeds, with warning
  `deep-tree` `{depth: N}` (N = the deepest depth it produced) in its result. The dashboard's Move-to dialog shows the same
  warning before the user confirms.
- **Display:** a long path is shortened in the MIDDLE (`Next release/…/Write the docs`) wherever it is shown, with the full
  path on hover. Stored paths are never shortened — except `at` (§2.2), which is capped at about 1 KB.

**Terms, used precisely from here on.** The **label** is the node's name (what the tree shows). The **current line** (or just
"line") is its status text — the one-line "what it is doing now", with its state, bar and ETA. An **entry** is one line of the
node's log. A report LOGS an entry; it SETS the line only when asked to (§4.0).

### 1.4 Kinds
- **session** — the root node of a (session, host); id = mint(host, session, "", ""). Agent-like lifecycle, as today.
- **agent** — an actor (start / finish / stale / gone). An agent is created by its creator (the session, or another agent) and
  is ALSO a creator: its key chain is how a script names it (`--agent spec-88`). Agents create their own node (Q17, §4.4).
- **context** — a piece of work (line, bar, ETA). **Plan item** = a context with `plan` (6b). Every node also has a TYPE
  (§1.7): a context's is `context`, `plan`, `group` or `question` (**Question** = a context of type `question`, #85).
- Ownership (who goes stale for whom) stays TREE-derived: `ownerOf` = the nearest agent at or above (6a, Q04). The creator is a
  namespace, not an owner: `spec-88:docs` placed under the session's `:88` is owned by the session for staleness. Activity
  from a call refreshes target..owner as today PLUS the calling agent (§4.1 `--agent`), which today's path-only model can't name.

### 1.5 How agents and sessions are identified
- A **session** is unchanged: realm + project + user + session name (+ host for ownership). The script's `--session` /
  `--project` / `--user`, the tool's `as`.
- An **agent** is named by its key chain from the session: `--agent spec-88`, `--agent spec-88/research`. The LAST step, when
  it doesn't exist yet, is CREATED by a call that targets the agent itself — `--guide agent` (§4.4), or a report with no
  `--key` / `--id` / `--path` — and that call must give its label (`--label "Spec final pass"`; the label never defaults to
  the key, Q31 → `label-required`). It goes under its creator unless `--under` places it (§4.1). A missing EARLIER step, or a
  missing agent on a call that targets another node, → `unknown-agent` ("start it first: --agent <chain> --label "…" --guide
  agent"). A step that names a context → `not-an-agent`. (Q40: agents are not exempt from the label rule.)
- Migrated agents (§7.3) get creator = their OWNER at the time (§3.4), key = their v5 segment — so `--agent a/b` names the
  node the old `--agent a/b` path named, and it keeps naming it after a move.
- **Moving a running agent** is allowed (Q15) — within its session only. Its next report (`--agent` / `--key`) lands in the
  moved node. A move to another session is refused `cross-session` even once cross-session moves of contexts arrive (Q14):
  an agent's identity includes its session.

### 1.6 Labels are unique among siblings (Q05, reconciled by Q31 / Q32)
- Two children of one parent never have the same label, compared like keys (NFC, case-insensitive). Agents and contexts share
  this (a path segment no longer says which kind it means, §3.3). How a clash is settled depends on how deliberate the label is:
- **Create → AUTO-RENAME.** A new node whose label a sibling already has gets the first free `"<label> (2)"`, `"(3)"` … (the
  suffix counts in the same comparison; a label that would pass 60 code points is cut before the suffix). The node is created,
  the result reports the label it GOT (`node.label`) with warning `relabelled` `{asked, got, sibling:{label, key, id}}`, and
  the create record keeps `asked` (§2.1). This covers `--key` / `--agent` creates, `--item` and `--guide agent`; a path never
  clashes with itself (below).
- **A deliberate change through the tool or the script → REFUSED.** A **rename** (`--rename`), **move** (`--move`), **merge**
  (A's children land under B) or **unmerge** (A goes back to its old parent) that would give a node a label one of its new
  siblings already has is refused `duplicate-label`, naming the sibling (`{label, key, id}`) and the free suggestion
  (`"Notes (2)"`). Nothing is written. `--move <ref> --rename "<label>"` in one call is one checked change (both records or
  neither), so a caller can move and relabel at once.
- **On the dashboard → a dialog (Q32).** A Move to… / drag-and-drop / Merge into… that would clash asks, per clash: **merge
  them** (the moved node is merged into its same-label sibling, §3.6) or **use a different label** (a field pre-filled with
  the suggestion, e.g. "Notes (2)"). "Merge them" is offered only where a merge is allowed (two contexts / plan items, §3.6);
  for an agent only the label choice is. A merge whose children clash lists each clash — and the clashes a "merge them" choice
  would create one level down — in the same dialog. The whole answer is sent as ONE action, checked by the owner before
  anything is written, and refused as a whole if the tree changed meanwhile (the dialog reopens with the new state). Rename…
  onto a sibling's label shows the error inline with the suggestion.
- Not counted: GHOSTS (removed nodes, §5.1) and hidden MERGED nodes (§3.6). A label freed by a removal can be used again.
- Path resolution finds an existing child by label (§3.3), so a path never collides with itself: a second `--path "88/notes"`
  reports into the first `notes`.
- The migration makes existing trees conform (§7.3): the one case v5 allowed — an agent `x` and a context `@x` under one
  parent — gets the younger node relabelled `x (2)`.

### 1.7 Types: typed nodes and typed entries (TYPES — Robin, 2026-10-03)
Two small built-in REGISTRIES, held as DATA (`lib/activity2.js` `NODE_TYPES`, `MESSAGE_TYPES`): the code asks the registry
what a type allows and how it shows, instead of special-casing groups or questions.

**Node types.** Every node has a `type`. Per type the registry declares: the `kind` it belongs to (context / agent /
session — the kind never changes), whether a caller may give it (`settable`), the report FIELDS a node of that type takes
(others are refused `bad-field`), its DISPLAY (`glyph`, and what `show`s where a bar would: `bar` | `count` | `status` |
`tests`), its ROLLUP behaviour (`bar`: its own bar — `auto` / `items` / `none`; `items` (2d): where its plan items are —
`children`, or `tree` for a test-run: below it, through its buckets; `counts_as`: what it adds to its parent's rollup — `bar` /
`item` / `none`), whether it can hold a plan that ENDS (`plan_end`, and `ends` (2d): the states of its own line that end it —
`done` / `abandoned`, a test-run's `failed` too), the node types allowed under it (`children`), and its MENU — the
context-aware menu of #92, folded into this slot in step 2d: `[{ action, label, group, when }]` in display order, `action`
being a dashboard action (§5.4, `applyAction2`) and `when` the condition under which it shows (`menuOf2`: the entries that
apply to a node now; Q60).
| Type | Kind | Set by | Bar / display | Adds to its parent | Notes |
|---|---|---|---|---|---|
| `context` | context | default; `--context-type=context` | `auto`: its plan items only when it holds any (ROLLUP), else its children's bars | its bar | plan-capable (an `--item` makes it a plan node) |
| `plan` | context | `--context-type=plan`; Show as plan | `items`: always "N of M" over its items | its bar | "Next release" is a plan |
| `group` | context | `--context-type=group`; Show as group | `none` — a COUNT instead (§5.7) | nothing | no plan end; takes no `progress` |
| `question` | context | `--ask` (§5.8) | `status` (asked / answered / …) | one ITEM | holds no children; takes no `plan` / `progress` |
| `agent` | agent | `--agent` | `auto` | its bar | |
| `session` | session | the bridge (the root) | `auto` | — | |
| `test-run` | context | `--context-type=test-run` (step 2d) | `items` over its items across its BUCKETS (`items: tree`) — what it adds to its parent; its ROW shows ONE bar of its tests, passed (green) vs failed (red) vs total, the counts in its tooltip (`show: tests`, Q56 CHANGED, §5.7) | its bar | its plan also ends on a `failed` line; #81's dashboard test reporter is its first user (§3.8, Q59) |
- **The flag** is `--context-type=<type>` (the tool's `context_type`), lower-case kebab-case flag style, values
  case-insensitive. It gives a NEW context its type (on an existing node it is ignored with `exists`, §3.5); only the
  settable context types are taken (`bad-type` otherwise; `question` only with `--ask`); a reserved one → `type-reserved`.
  It REPLACES the first draft's `--group` / `group:true`. A type changes later only by the dashboard's Show as group /
  Show as plan (an `op:"type"` record; a plan item can't become a group; a question stays a question) or by `--ask` on a
  line-less context (it becomes a `question`).
- A plan item is still an ATTRIBUTE (`plan`, §1.3), not a type: it counts as an item of its parent's plan whatever its type.

**Message (entry) types.** Every entry has a `type` (`--message-type=<type>`, the tool's `message_type`; default `note`)
and, when its type declares any, typed `fields` — VALIDATED against the registry (unknown fields refused `bad-fields`,
values normalised: a duration → ms …), so the bridge can count them. `--data` stays the free-form extra the bridge does
not interpret.
| Type | Written by | Typed fields |
|---|---|---|
| `note` | any report (the default) | — |
| `question` | the bridge, for an `--ask` | `choices`, `free`, `expires_at` |
| `answer` | the bridge, for an answer / a changed answer | `choice`, `text`, `revised` |
| `withdrawal` | the bridge, for a withdrawn question | `note` |
| `expiry` | the bridge, for an expired question | `after_ms` |
| `event` | the bridge, for a structural change (moved, renamed, merged, unmerged, emptied, a type change) | — |
| `test-result` | any report (step 2d): one test's outcome | `result` (pass / fail / skip, REQUIRED), `checks`, `failed` (≤ `checks`), `duration` (ms; Q58) |
- A caller may give only the settable types (`note`, and `test-result` since step 2d: `--message-type=test-result --result
  pass --checks 22 --duration 4.1s`); a bridge type → `bad-message-type`, a reserved one → `type-reserved` (none is left).
  The tool takes the typed fields as `fields:{…}`; the script maps a type's field flags (`--result`, `--checks`, `--failed`,
  `--duration` — the flag is the field's name) onto them (step 9). A duration is kept in ms: a NUMBER is ms, a string needs a
  unit ("4.1s", "250ms", "2m", "1h25m").
- **A node keeps its latest test-result** (the registry's `keep: "test"` → the node's `test`: the fields, the entry id, and
  the state the report left it in) — so the bridge COUNTS them per run (a test-run's counts, §5.7) after the entry has left
  the in-memory log, and with `log:false` too (the checkpoint carries it, step 3). The result stands while the node is in
  that state: a later state change wins (the latest word), and a restart (todo / running / blocked without a test-result)
  clears it, so a second run starts clean. **State is progress, result is outcome** (Q57 / Q61 / Q62, Robin): a test's
  STATE is its progress (todo / running / blocked / done / abandoned), its test-result (pass / fail / skip) its OUTCOME.
  Logging a test-result means the test FINISHED: it sets the state to **done** for all three results (a test-result alone
  is a report); the colour, the Passed / Failed bucket and the tests bar (`testBar2`) come from the result. `--state done`
  with a result is consistent; any other state with it (running / todo / blocked / abandoned / failed / skipped) is refused
  `bad-state` ("a test-result means the test finished"). ANY context that takes a test-result is a test — a skip works on
  it whether or not it is a plan item; an agent or the session can't take one (`not-a-test`: an agent runs tests, it isn't
  one). The `failed` state stays for non-test work (a failed deploy, a run that ended failed). The 2d warning
  `result-state` is gone. Other information — the names of the failing checks — goes in `--details` (Q58).
- Answers are entries of type `answer`; the node's STATE (done / failed …) still drives plans and progress.

---

## 2. Record formats (day files, format v6)

Day files, retention, one writer per host, the backwards reader and the cp / rep mechanism are unchanged
(`facets/persistence/file.js` `activity.*`, `bridge.mjs` `persistActivity` / `writeCheckpoints`). v6 day files are the SAME
files as today — `activity/<host>/YYYY-MM-DD.jsonl` — converted in place by the migration (§7). Every v6 record keeps the
identity fields today's records carry (`origin realm session project user host s0`) so a file stays self-describing; they are
shown as `…ident` below. The bridge's `RECORD_FORMATS` becomes {6}: v2 – v5 records are read ONLY by the migration script's
library (§7.3). The 2.0 bridge has no v5 detection: any other record is skipped like any line it can't read (§7.5).

```json
…ident = "realm":"default","project":"AIMB","user":"robin","session":"Bridget","host":"ROBIN-Z790","origin":"ROBIN-Z790","s0":1790900000000
```

### 2.1 Node records (`kind:"node"`) — structure only, never in a log view
Each changes ONE thing. `by` / `act` as 6d when a dashboard did it (a system record: no activity). `was` = the node's display
path BEFORE the change (it seeds the alias table, §3.3, and lets a log say "moved from"). Display paths are labels joined by
`/`, without `@` (§3.3).

```json
{"v":6,"kind":"node","op":"create","ts":1790984000000,"n":"uytyq4e6wsmtqsfq","c":"mkjhhu3kyjf2gbcv","key":"spec-88","nk":"agent","label":"spec-88","p":"bpcw6vw4rsnpwtxl","run":true,…ident}
{"v":6,"kind":"node","op":"create","ts":1790984000001,"n":"rtam3yvgwkzx5zbp","c":"uytyq4e6wsmtqsfq","key":"docs","nk":"context","label":"Write the docs","p":"bpcw6vw4rsnpwtxl","rank":null,"run":true,…ident}
{"v":6,"kind":"node","op":"label","ts":1790985000000,"n":"rtam3yvgwkzx5zbp","label":"Write the README","was":"Next release/#88/Write the docs",…ident}
{"v":6,"kind":"node","op":"move","ts":1790986000000,"n":"rtam3yvgwkzx5zbp","p":"2lneiezs5pgo7ghf","rank":"0f","was":"Next release/#88/Write the README","by":{"kind":"dashboard","user":"robin","host":"ROBIN-Z790"},"act":"move",…ident}
{"v":6,"kind":"node","op":"rank","ts":1790986500000,"n":"rtam3yvgwkzx5zbp","rank":"0fi",…ident}
{"v":6,"kind":"node","op":"item","ts":1790987000000,"n":"rtam3yvgwkzx5zbp","plan_ix":3,…ident}
{"v":6,"kind":"node","op":"merge","ts":1790988000000,"n":"2czd5q2puuwp5xi4","into":"hijrhd6rgrortbzg","from":"o4qpehqjcrade6ca","was":"Next release/#79","kids":["…id","…id"],…ident}
{"v":6,"kind":"node","op":"unmerge","ts":1790989000000,"n":"2czd5q2puuwp5xi4","p":"o4qpehqjcrade6ca",…ident}
{"v":6,"kind":"node","op":"remove","ts":1790990000000,"n":"uytyq4e6wsmtqsfq","why":"dismiss","was":"Next release/#88/spec-88",…ident}
```
- `create`: `n` id, `c` creator id (the session root's id for the session), `key`, `nk` (agent | context), `label`, `p` parent,
  `rank` (null = derived), `plan_item` / `plan_ix` when born a plan item, `run:true` (it BEGINS a run — replaces `new_from`;
  §5.3), and `asked` when the label was auto-renamed (§1.6: `"label":"notes (2)","asked":"notes"`). A create for a key whose
  node is a GHOST (§5.1) re-uses its id and starts a new run. `transient:true` marks a transient context (§3.8), with
  `grace_ms` when it was created with a grace period (Q44). It also carries the node's `type` (§1.7; `nk` stays the kind).
  Step 3 added what the replay needs: `scope` (the creator's chain, so an agent's chain is known even when its creator is
  gone), `implicit:true` (a path's intermediate) and `runs` (> 1: a resurrected ghost's run number).
- `type`: `{"op":"type","n":…,"type":"group"}` — the dashboard's Show as group / Show as plan, or `--ask` turning a
  line-less context into a `question` (§1.7); nothing else changes (its children keep their states).
- `move`: new `p` (+ the rank it got there). `label`, `rank`, `item`: the one attribute. `keep`: a transient context becomes
  permanent (§3.8), with no other field.
- `merge`: A (`n`) into B (`into`); `from` = A's parent then (for an unmerge); `kids` = A's children at that moment, which
  move under B (no separate move records), and `kid_ranks` (step 3) = the rank each got under B.
- `remove`: the node and its subtree leave memory (`why`: dismiss | evict | expire | transient, §3.8). Replaces 6d's `dismiss:true` replay rule and the
  entry's `evicted:[paths]`. The 6d dismissal ENTRY ("dismissed from the board by …") is still written, on the PARENT (§2.2).
  **Expiry writes its removals too** (step 3, changed from "expiry writes nothing"): the owner's pass (`expire2`) writes a
  `remove` with why `expire`, so the replay folds it where it happened instead of re-deciding it later — a removal it
  decided late would let a later record (a new run of that key, a new item under that plan) land on the wrong tree.

### 2.2 Entries — keyed by id
```json
{"v":6,"id":"act_9164_murlfkk7-3gk","ts":1790984100000,"n":"rtam3yvgwkzx5zbp","current":true,"text":"Writing the README section","state":"running","at":"Next release/#88/Write the docs",…ident,"details":null,"data":null}
```
- Today's entry fields (`apply` → `res.entry`) MINUS `path`, `new_from`, `evicted`, `moved_from`, `plan_item` / `plan_ix`
  (structure moved to node records) PLUS `n` (the node id), `at`, and (TYPES, §1.7) `type` — the MESSAGE type (`note`
  by default) — with its validated typed `fields` when it has any (`{"type":"answer","fields":{"choice":"Postgres"}}`).
- **`at` = the node's full display path when written** (Q08). The log panel shows it on hover when it differs from the node's
  path now ("logged as #88/Docs"); it stays greppable. ~60 – 150 bytes per entry. **Capped at 1 024 UTF-8 bytes** (Q11b: a
  32-deep path of 60-code-point labels could reach ~8 KB): a longer path keeps its head and tail and is cut in the MIDDLE with
  `…` (on code-point boundaries), so both the top of the tree and the node's own label survive.
- `current:true` marks an entry that CHANGED the line (§4.0) — its text (a leading `@`) or its state (`line_text` then names
  the line's text when the entry's own text differs, as 6d's ticks); `false` = logged only. Kept: `current text state progress eta_at
  stale_after_ms details data by act line_text line_by question plan_end finished_at`, and `dismiss:true` on the parent-log
  dismissal entry (`n` = the PARENT, `of` = the removed id). `rank` leaves entries: a placement writes a `rank` node record
  plus its "placed before Build" entry. Step 3 added what the replay needs to rebuild the line exactly: `line:true` (the entry
  SET the line's text — its details / data are the line's; without it a state change keeps the line's text, details and
  data), `test_cleared:true` (a restart dropped the node's kept test-result) and `caller` (the calling agent the report also
  refreshed, when it is not on target..owner, §1.4). **TIME** (§5.7): the entry that ENDS an attempt carries `took` (ms),
  and after a re-run also `took_total` and `attempts` — written by the bridge beside the message type's own `fields` (any
  entry type can end an attempt, so it is not one type's typed field), and the replay re-derives the node's times from
  the same state changes.
- A move / rename / merge also writes a normal ENTRY on the node ("moved by robin via dashboard (ROBIN-Z790) from #88 to
  Later", `act`) so the log tells the story; the node record carries the structure. Two lines, one call.

### 2.3 Checkpoints and carry-forward
- **cp** (`checkpointOf`): `path` → `n`. `{"v":6,"kind":"cp","k":17,"ts":…,"n":"rtam3yvgwkzx5zbp","current":{…},"state":"running","progress":{…},"eta_at":null,"created_at":…,"rank":null,…ident}`.
  `rep` lines unchanged (`{"v":6,"rep":[17,18],"n":245,"since":…,"last":…}` — keys per file, as today; a rep's `n` is its
  repeat COUNT, as today, never a node id — `recordKind` tells a rep by its `rep` array). As built (step 3,
  `planCheckpoints2`): a cp also carries the node's kept `test` (2d), `last_activity`, `stale_after_ms` and — an agent / the
  root — `finished_at` + `plan_end`, and the node's TIME as `timing: { started_at, ended_at, first_started_at, took,
  took_total, attempts }` (when it ever started or ended a timed attempt); a node is "unchanged" (→ the rep line) when its line state equals what its newest record
  left (`cp_sig`); a log:false report through a calling agent outside target..owner checkpoints that agent too.
- **cf** (`planCarryForward` / `carryOf`) carries STRUCTURE too, because a node's `create` may be older than the replay window:
  `{"v":6,"kind":"cf","ts":…,"n":…,"c":…,"key":"docs","nk":"context","label":"Write the README","p":…,"rank":"0fi","plan_item":true,"plan_ix":3,
  "aliases":[{"path":"next release/#88/write the docs","at":1790986000000}],"merged_into":null,"current":{…},"state":…,"progress":…,"eta_at":…,"created_at":…,"last_activity":…,"stale_after_ms":null,"implicit":false,"log_n":12,"run_at":1790984000000,…ident}`.
- **What is carried** (`carryDue`): every node whose state OR structure (its newest create / move / label / rank / item record)
  would fall out of the window before the next rollover, every open plan item, and every ANCESTOR of a carried node (parents
  first, as today). `run_at` = when its current run began (its create's ts), so the run boundary survives (§5.3). `pt` gains
  `s` (structure persisted). **As built (step 3, `planCarryForward2`): EVERY node in memory is carried** at each rollover — a
  daily snapshot of the whole board (parents first, hidden merged nodes after their visible siblings; no `pt` bookkeeping).
  Carrying only what would fall out is not enough: an ancestor created inside the window would miss the activity a child
  whose run began earlier gave it before that child's cf (the window fuzz found it); with the whole board in each cf, every
  node alive at the newest rollover is known from there on. A cf also carries `scope`, `asked`, `type`, `transient` +
  `grace_ms` + `empty_since`, `merged_from`, `runs`, the line state and `timing` as a cp does, and — the root's — the
  session's `session_last_activity`.
- Unchanged: `cf` written at the local day rollover and after a restart without one (`actRollover`, `cf_today`).

### 2.4 The per-day index files (id → offsets)
- Today: `actIndex` in `bridge.mjs` maps ENTRY id → (day, offset), in memory, ≤ 100 000, rebuilt only for the replay window.
  Paging a node's history scans files backwards and filters by path (`filePage` + `fileEntryMatches`).
- v6 adds an INDEX FILE per closed day: `activity/<host>/YYYY-MM-DD.idx.json`, written once (atomically) at the day rollover
  for yesterday's file, by the migration for every converted day (§7.3), and rebuilt by one scan when missing or when `size`
  doesn't match the day file:
```json
{"v":1,"day":"2026-10-02","size":1843211,
 "nodes":{"rtam3yvgwkzx5zbp":[10240,1831002,57],"uytyq4e6wsmtqsfq":[11002,1840100,23]},
 "struct":[{"op":"create","ts":1790984000001,"n":"rtam3yvgwkzx5zbp","c":"uytyq4e6wsmtqsfq","key":"docs","nk":"context","label":"Write the docs","p":"bpcw6vw4rsnpwtxl"},
           {"op":"move","ts":1790986000000,"n":"rtam3yvgwkzx5zbp","p":"2lneiezs5pgo7ghf"}]}
```
  `nodes[id]` = [first entry offset, last entry offset, entry count] (entries only; cp / cf not counted); `struct` = that
  day's node records, compact. Today's file has the same map in memory, updated on every append. As built (step 3,
  `lib/activity2-files.js`): the index also has `sessions` (each `{ realm, project, user, session, s0 }`) and every `struct`
  entry an `s` (its session there — a ghost needs its session); `struct` also holds the STRUCTURE of the day's cf lines
  (`op:"cf"`), so a node created before retention and removed later still has its key / label / parent for the ghost table.
- Uses: paging (§5.2 — read only the days and byte ranges that hold the subtree's ids), the GHOST table (§5.1 — structure of
  nodes no longer in memory, read from `struct` across retention at startup), and the entry index (an entry id's day is still
  in the id itself, `entryTime`).
- Retention deletes a day's `<day>.jsonl` and `<day>.idx.json` together (`prune` and `days()` learn the second name — exact-name
  patterns only, §10).

---

## 3. Resolution rules

Every call has a SCOPE: the session, or the agent `--agent` / `agent` names (§1.5). A call's TARGET is: `--key`'s node, else
`--id`'s, else `--path`'s, else the `--agent` node, else the session root.

### 3.1 `--key` (your own node)
- Looks in YOUR scope only. Found → that node. Not found → CREATED there (a context; `--label` is REQUIRED — `label-required`
  without it, Q31; `--under` / a position apply, §3.5; a sibling with that label → auto-renamed, §1.6). Never looks in another
  scope: an agent's `--key docs` never lands in the session's `docs`.

### 3.2 References (`--under`, `--before`, `--after`, `--move`, `--merge`)
A reference is, by its syntax (keys can't contain `/` or `:` outside the chain, or spaces):
- `chain:key` — exactly that scope (`spec-89:docs`; `:88` = the session's `88`). Missing → `unknown-node`.
- a bare key — YOUR scope, then your creator's, … up to the session's (lexical scoping). First hit wins. So an agent's
  `--under 88` finds the orchestrator's `:88` without knowing the notation.
- a path (contains `/`, or isn't a valid key — a label with spaces) — §3.3, without creating (`unknown-node`). A one-segment
  label that is also a valid key is read as a KEY; write it `./Docs` to force a path.
- the tool and the dashboard also take `*_id` fields (`under_id`, `to_id`, `before_id`, `into_id`) — exact, no lookup.

### 3.3 `--path` (the shorthand)
`--path` stays after 2.0 (Q04): it is the quick way to log by hand and the form a person reads. Keys are what briefings use.
- **Syntax:** segments separated by `/`, each a LABEL; no `@` (Q01 FINAL, Q19 FINAL — a path containing `@` at a segment start
  is refused `legacy-form`, §4.5). A segment holding `/` or starting/ending with a space is written in double quotes, `""`
  inside for a literal `"` (Q37). A path walks from the session root, or from the `--agent` node when one is given (the old
  `agent` + `path` concatenation, `resolveAddress`).
1. **The current tree.** Each segment matches the CHILD whose label equals it (case-insensitive; §1.6 makes it unique). No
   label matches → an AGENT child whose key equals it (so `spec-88/…` still finds the agent `spec-88` labelled "Spec final
   pass"). A question child also matches by its key (`?3`).
2. **Aliases.** No match → the session's ALIAS table: `lc(old display path) → id`, filled by every move / label / merge
   (`was`) and by the migration (§7.3: each node's earlier v5 paths, written without `@`). The longest alias that is a prefix
   of the path wins; the rest of the path resolves below that node. Warning `alias` ("#88/Docs is now Later/Docs") so a caller
   learns the new name.
3. **Create.** Still nothing → the missing tail is created as CONTEXTS (intermediates implicit, as 6a), each with key =
   slug(segment) (`-2` on a clash), creator = its OWNER (§3.4), label = the segment. A path never creates an AGENT: agents
   come from `--agent` (§1.5) and `--guide agent` (§4.4).
- **Alias lifetime:** an alias lives while it is useful and safe: (a) the LIVE tree always wins (an alias is consulted only
  when the path names no live node), (b) it is dropped when its node is removed or merged-away-and-gone, and (c) it expires
  `log_retention_days` after it was made unless used (each hit refreshes it; carried in `cf.aliases`, ≤ 16 per node, newest
  kept). **Collision:** two aliases with the same path → the NEWEST wins (the most recent thing that was there).
- No `ambiguous-path` warning any more: labels are unique among siblings (§1.6).

### 3.4 Who creates a path-created node
- Its OWNER at creation: the nearest agent at or above its new parent, else the session (today's `ownerIndex`; Q04). Path
  callers report as the session (`aimb-log --session`), so "the caller" would put every node in the session's scope and clash
  keys across agents; the owner rule gives `spec-70/Tharsis` the key `spec-70:Tharsis`, as a human reads it.

### 3.5 Create is idempotent; location only at creation (Q02)
- `--key docs --under X --label L` on an EXISTING node changes NOTHING structural: `--under`, `--label`, `--before` / `--after`
  are ignored with warning `exists` when they differ (hole H2: re-applying them would let an agent's retry, or a prompt
  replayed after a compaction, undo a human's dashboard move or rename). A `--label` equal to the create's `asked` label (the
  node was auto-renamed, §1.6) is not a difference — so a snippet that repeats `--label "notes"` on every call raises no
  warning on its `notes (2)`. Changes are explicit verbs: `--move`, `--rename`, a position alone (reorder: no `--under`,
  existing node — as #82).
- So a retry after a lost response never duplicates and never moves anything; the text / state / bar of the retry apply as a
  normal report (a logged retry logs twice — as today; `--stream`'s "not resent" rule is unchanged).
- `--item docs "…"` when `docs` exists ELSEWHERE in your scope: no new item; result `{key, created:false, path, warning:
  "exists-elsewhere"}` (a dashboard may have moved it).

### 3.6 Merge (Q06, Q20)
- `--key A --merge B` (dashboard: Merge into…): A's line ends (its last line stays an entry), A leaves the board, A's CHILDREN
  move under B (end of their groups), and A becomes a hidden child of B (`merged_into`): B's subtree log therefore includes
  A's entries with no rewrite (§5.1). A's key and A's paths become aliases of B (`--key A` in A's scope now targets B, warning
  `merged`) until unmerged.
- Allowed: context → context, plan item → plan item or context, same session and host. Refused `bad-merge`: A = B, B under A,
  A or B an agent (an agent is a key namespace), the session root, A holding an OPEN question. From the tool / script: refused
  `duplicate-label` when one of A's children has the label of one of B's (§1.6; the error lists every clash with its
  suggested label). On the dashboard the Merge dialog settles each clash instead (merge them too, or relabel — §1.6, Q32).
- Plans: A leaves its plan ("N of M" drops it); if A was the last open item, the plan may end as usual.
- **Reversible:** `--key A --unmerge` puts A back under its pre-merge parent (the merge record's `from`) as a plain context,
  line-less; its children stay with B (move them back if wanted). The scope index still maps A's key to A's id — only target
  RESOLUTION redirects a merged node to B, and `--unmerge` skips that redirect. The entries were never touched, so the split
  is exact. Refused `duplicate-label` if the old parent has gained a child with A's label (`--unmerge --label "…"` names A
  anew). 2.0: tool + script only, not on the dashboard.

### 3.7 Reusing a finished key
- The node still exists (done / failed / abandoned / skipped, in memory) → the SAME node, revived exactly as today (a running
  line revives an agent — `apply`'s `finished_at = null`; a plan item reopens). The guide says new work takes a new key.
- The node was removed (expired / evicted / dismissed: a GHOST) → `create` with the SAME id and `run:true` → a NEW RUN of it;
  its old entries are an earlier run ("show earlier runs", §5.3). Same rule as today's re-used path name.

### 3.8 Report and move in one call (`--move-to`); transient contexts (Q43)
**Motivating example: a test run under `Tests`.** The reporter creates `Tests/Pending` with `--transient` and one plan item
per test. Each test then moves `--move-to "../In progress"` when it starts and `--move-to "../Passed"` or `"../Failed"` when
it ends, each bucket created on first use. `Pending` and `In progress` vanish once they are empty, which leaves `Passed`, plus
`Failed` if anything failed. The `Tests` bar rolls up across the buckets, so it reads done / total for the whole run. The next
run brings the same buckets back (same ids, a new run each). The report for one test is a single call:
`--key t42 --state done --text "@22/22 passed" --move-to "../Passed"`.

**`--move-to "<path>"`** (the tool's `move_to`, also per item in `--batch` / `--stream`). This is a report that also moves its
target.
- **Order and atomicity.** The report's state, line and log entry are applied first, then the node moves. It is ONE
  all-or-nothing change: the destination is resolved and every check below passes BEFORE anything is written. A refused move
  refuses the whole call, including the report.
- **The path** is a §3.3 path (labels, quoting per Q37, no `@`) in one of two forms (Q45, Q46):
  - A LEADING `/` makes it absolute from the session root, even with `--agent`.
  - `../X` — exactly ONE leading `..` and ONE label — is RELATIVE to the node's CURRENT parent: the `..` goes up one level,
    so `../X` is a sibling of the parent. `..` is navigation only as a leading segment. A label that is literally `..` is
    written quoted (`".."`), and going above the session root → `bad-path`.
  - **Anything else is refused `bad-path`** (Q45, Q46 FINAL): a bare destination (`X`, `X/Y`) would be resolved one level
    DOWN from the parent, and a deeper relative path (`../A/B`, `../../X`, `../../R/X`) resolves differently from the NEW
    parent on a retry; none is retry-safe. The error suggests both forms (`use "../X" (beside the node's parent) or "/…/X"
    (from the session root)`) and, when the path could be resolved now, carries **`suggest: "/…"`** — the ABSOLUTE path it
    would have resolved to from the node's current parent (live labels as spelt on the board, the missing tail as given) — so
    the caller retries with that retry-safe form. So is a path of only `..` segments with nothing after them (`..`, `../..`):
    there is no destination label (no `suggest`). (`../..` alone would be "the grandparent itself"; write it absolutely.)
  - **The resolve helper (Q46):** `aimb-log --resolve "<relative path>" [--key X | --id I | --path P]` (the tool `resolve`)
    answers the absolute path (and id) a relative path resolves to NOW, from the named node's current parent (the same base
    as `--move-to`; with no `--key` / `--id` / `--path`, the `--agent` node, and the session root is refused as having no
    parent), and CHANGES NOTHING. It takes any relative form (bare `X`, `../A/B`, `../../X`) and the absolute form, walks the
    tree as `--move-to` would (a live child, else this parent's same-label ghost, else "would be created"), and answers
    `{ path:"/…", id, state:"live"|"ghost"|"new", node?, create:[labels a move there would create], from:{ id, path } }`.
- **Resolution, segment by segment, from that base:**
  1. a LIVE child with that label (§3.3 step 1: by label, else an agent by key), whoever created it;
  2. else a GHOST (§5.1) whose last parent is this node and whose label matches (labelKey), the newest if there are several.
     It is RESURRECTED: same id, same key, same creator, back in the tree under this parent, transient (below). This is
     §3.7's rule: the resurrection is a `create` with the ghost's id and `run:true`, so it starts a NEW RUN. Its log shows the
     current run, and its earlier uses sit behind "show earlier runs" (§5.3);
  3. else a NEW context is created: label = the segment, creator = the CALLER (the call's `--agent`, else the session), key =
     the first of `slug(segment)`, `-2`, `-3` … (§1.1) that no node in the caller's scope holds, live or ghost (a ghost key
     elsewhere is never pulled here), transient. Staleness ownership stays tree-derived (§1.4).

  In the normal case steps 2 and 3 agree: a bucket's key comes from its label under the same creator, so bringing it back IS
  that key. Each bucket keeps one id for its whole life; a test run does not leave a new ghost behind.
- **Arrival:** the node goes LAST in the destination (a stored rank after the last child, §1.3). The label rule is that of
  `--move` (§1.6): a destination child that already has the node's label → `duplicate-label` (nothing is written). The other
  `--move` rules also apply: the same session only (`cross-session`), never under itself, the depth rules for the node's whole
  subtree (§1.3, Q11b: refused past 32 — the contexts it would create count too — and `deep-tree` past 20), and the session
  root cannot move. Agents may move (Q15). `--move-to` with `--move` → `bad-input` (one destination
  per call). `--move-to` is not the removed `--to` (§4.5): it is a path, and it travels with a report.
- **Idempotent on retry.** When the node's current parent already IS the resolved destination, the move part is a no-op: no
  `move` record and no rank change. The report applies again as a normal report (a logged retry logs twice, §3.5). Absolute
  paths and `../X` resolve to the same place on a retry. A bare `X` (one level DOWN) would not — a retry after a lost response
  would move it again, into `X/X` — which is why it is refused (Q45). By the same reasoning every deeper relative path is
  refused `bad-path` with the absolute form as `suggest` (Q46 FINAL, option 1): `../A/B` (a retry from the new parent `B`
  would land in `A/A/B`), `../../X` (a retry would climb one level higher) and `../../R/X` (it lands in the same place only
  while the tree around it doesn't change; the absolute form says exactly where). The guide teaches `../X` and `/…`, and
  `--resolve` for turning any relative path into the absolute one first.
- **Records:** the report's entry; any `create` records for created or resurrected contexts (`transient:true`, `c` = the
  caller); the `move` record plus its move entry (§2.2); then any `remove` records for transient contexts that emptied (below).
  All belong to one call, in that order.

**Transient contexts.** This behaviour is gated, so an ordinary empty context never vanishes.
- **Which contexts are transient:** those auto-created (or resurrected) by `--move-to`, and those created explicitly with
  `--transient` (the tool's `transient:true`). The flag is set only when the call CREATES the node (on an existing node
  `--transient` is ignored with warning `exists`, §3.5), and contexts only (never an agent). Every other context is permanent,
  as today.
- **Grace period (Q44): an OPTIONAL parameter of `--transient`, default none.** `--transient=30s` (the `=` form only, so
  there is no positional ambiguity; the duration syntax of `--stale-after`), the tool's `transient: "30s"` (`transient:
  true` = no grace). With `--move-to`, `--transient=30s` also applies to every destination context the call auto-creates or
  resurrects (without `--move-to` it applies to the target the call creates). The create record keeps `grace_ms` beside
  `transient:true`.
- **Vanishing:** a transient context disappears as soon as its LAST LIVE CHILD LEAVES. That means the child moves out, merges
  away, or is removed (dismissed, evicted, expired). It becomes a GHOST (§5.1, with its history kept): one entry on itself
  ("emptied — removed from the board (transient)"), then a `remove` record with `why:"transient"`. If its parent is
  transient and now empty too, the parent vanishes the same way (bottom-up, in the same call). A transient context that
  never had a child does not vanish, because nothing left it.
  - **With a grace period** the emptied context is not removed at once: it is marked `empty_since` (in memory and in `cf`,
    no record) and the owner's expiry pass removes it — with the same entry and `remove` record, and the same bottom-up chain,
    each parent getting its own grace from that moment — once `grace_ms` has passed with no child. If a child ARRIVES during
    the grace period the context stays (the mark is cleared); it vanishes again only when that child leaves in turn. The
    replay re-runs the pass, as for expiry.
- **Becoming PERMANENT** (for good; a permanent context never auto-disappears, and an unpin does not undo it):
  - a user PINS it (the owner sees a live `pin:<id>` record of any user in the view set it holds, §5.6);
  - it is RENAMED (`--rename`, or the dashboard's Rename…);
  - it gets its OWN LINE (a call that sets its line: a leading `@` text on it, §4.0);
  - `--keep` (the tool's `keep:true`) on it.

  Each writes one `keep` node record (`{"v":6,"kind":"node","op":"keep","ts":…,"n":…,…ident}`, with `by` / `act` when a
  dashboard did it). `create`, `cf` and the v6 slice unit carry `transient:true` while it holds.
- **Ghosts and resurrection:** a resurrected context is no longer a ghost. It leaves the ghost table and is live again, still
  transient. Its earlier-run entries remain its OWN entries (same id), reachable through "show earlier runs" (§5.3) rather
  than "show removed". When it vanishes again it re-enters the ghost table. The ghost lifetime (§5.1: until retention drops
  its last entry) counts the entries of all its runs, since they share one id. Ghost children it had when it vanished stay
  ghosts under it (visible with "show removed").
- **A side effect of sequential runs:** in a sequential run, `In progress` empties between two tests. It therefore vanishes and
  comes back once per test, one run each (a `create` + `remove` pair and two entries per test). This is correct by the rules
  above, and it is the default; a reporter that would rather keep the bucket between tests creates it with
  `--transient=30s` (Q44).

---

## 4. API

2.0 has ONE set of command forms. Every 1.7x-only form is removed and answered with an error that names the 2.0 form (§4.5;
Q19 FINAL).

### 4.0 Text: logging vs setting the line (Q01 FINAL)
- **Plain text only LOGS** an entry on the target. The line stays as it was.
- **A LEADING `@` means "this message also sets the node's current line"**: the text after the `@` is logged AND becomes the
  line (`current:true`). This replaces today's `@~` (in paths and in text); `@~` is gone.
- **Escaping (Q36):** count the run of `@` at the very start of the text. Each PAIR `@@` stands for one literal `@`; an odd one
  left over (the first `@`) is the set-the-line marker. So `@@home` logs "@home"; `@@@home` sets the line to "@home"; an `@`
  anywhere else is just a character.
- `--state`, `--progress`, `--eta`, `--done`, `--stale-after` change the node whatever the text (they are not line text);
  `--ask` always sets the line (a question IS a line, #85). A state change with plain text logs the text and leaves the old
  line text in place: the bridge keeps ONE rule, no implied line, for finishing states too (Q33). The 2.0 guides tell agents
  to finish with `--state done --text "@<summary>"` (§4.3); the result's `line:false` shows a caller that it only logged.
- The same rule for the `log` tool's `text`, batch items and `--stream` lines.
- PowerShell note for the guide: always quote the text (`"@Writing the docs"`) — an unquoted `@word` is a splat there.

### 4.1 Script flags (`tools/aimb-log.mjs`)
| Flag | Meaning |
|---|---|
| `--agent <chain>` | the agent you report as (your scope); created if new by a call that targets it, with `--label` (§1.5) |
| `--key <k>` | your node (§3.1); created if new (a context, with `--label`) |
| `--id <id>` | a node by internal id (the dashboard's copied command) |
| `--path "<label>/<label>"` | the shorthand (§3.3); no `@` |
| `--under <ref>` | where a NEW target goes (default: under the scope — the session root or your agent node) |
| `--label "<text>"` | a NEW target's label — REQUIRED when the call creates it (`label-required`; never the key, Q31); a sibling clash → `"<text> (2)"`, reported (§1.6); on an existing node ignored (`exists` unless equal to the label asked at creation, §3.5) |
| `--item <k> "<label>"` | a ☐ plan item under the target, repeatable, in order; `--item "<label>"` (one value) = label only, key = slug, matched by LABEL under the target first (today's re-plan rule) |
| `--before <ref>` / `--after <ref>` / `--first` / `--last` | place new items or a new target; on an existing target alone = reorder (#82) |
| `--move <ref>` | move the TARGET under `<ref>` (+ a position); a label clash → `duplicate-label` (§1.6) |
| `--rename "<label>"` | the target's new label; a clash → `duplicate-label`; with `--move`, one checked change (§1.6) |
| `--merge <ref>` / `--unmerge` | §3.6 |
| `--move-to "<path>"` | after the report is applied, move the target there (relative: `../X` only, one step; absolute: `/…`; a bare `X` or a deeper relative path → `bad-path` with `suggest:"/…"`, Q45 / Q46), creating missing transient contexts; one all-or-nothing change (§3.8) |
| `--resolve "<path>"` | (Q46) print the absolute path + id a relative (or absolute) path resolves to NOW from the target's current parent (`--key` / `--id` / `--path`, else the `--agent` node); changes nothing (§3.8) |
| `--context-type=<type>` | (TYPES, §1.7) a NEW context's type: `context` (default) \| `plan` \| `group` (a list, not a plan, §5.7); case-insensitive; on an existing node ignored with `exists`; replaces the draft's `--group` |
| `--message-type=<type>` | (TYPES, §1.7) the entry's message type (default `note`); a type's typed fields as flags of their own (`--result pass --checks 22 --failed 0 --duration 4.1s` for `test-result`, step 2d), validated; `--data` stays free-form |
| `--transient[=<dur>]` / `--keep` | a NEW context is transient (it vanishes when its last child leaves; `=30s` = after a grace period with no child, Q44 — with `--move-to` it applies to the contexts that call creates) / make a transient context permanent (§3.8) |
| `--text "<text>"` | log an entry; a leading `@` also sets the line (§4.0) |
| `--guide agent\|session` | print the guide; with `--agent` it is also the agent's first report (§4.4) |
| `--ctx`, `--state`, `--done`, `--progress`, `--eta`, `--stale-after`, `--details`, `--data`, `--no-log`, `--ask` …, `--stream`, `--batch` | unchanged |
- `--item k "label"` parsing: two values unless the second starts with `--`; a first value that isn't a valid key (spaces …)
  is the one-value label form. `--key` with `--path` → `bad-address` (one way to name the target).
- `--note` (the first draft's log-only flag) is NOT added: plain text logs (§4.0).
- The 2.0 script talks only to a ≥ 2.0.0 gateway (`gateway-unsupported` before anything is sent, from the welcome's
  `bridge_version`), apart from `--guide`, which prints its built-in text against anything (§4.4).

### 4.2 The `log` and `activity` tools
- `log` takes `agent` (the chain), `key`, `id`, `path`, `under` / `under_id`, `label`, `plan:[ "label" | { key, label } ]`,
  `before` / `after` / `*_id`, `move` / `move_id`, `move_to`, `transient` (`true | "30s"`, Q44), `keep` (§3.8), `rename`, `merge` / `merge_id`,
  `unmerge`, `text` (§4.0), `context_type`, `message_type` + `fields` (§1.7), `guide`. A separate read-only tool `resolve` takes `agent`, `key` | `id` |
  `path` and `resolve` (the path) and answers as `--resolve` (§3.8, Q46). Batch
  items take the same; `agent` is a batch default. The tool's `plan` field is the `--item` list, kept (it is the tool's only
  form for items).
- **Results always name the node:** `{ ok, id:<ENTRY id, as today>, ts, node:{ id, key, scope:"spec-88", label, path, kind,
  created? }, state, current, line:<true when the line was set>, logged, stale_at, … }`; `plan:[{ key, id, label, path,
  created, plan_item, state, warning? }]`; `moved:{ from, to, parent_id }`, `merged:{ into_id, path }`, `warnings` (`exists`,
  `exists-elsewhere`, `alias`, `merged`, `relabelled` — §1.6: `node.label` / `plan[].label` is the label the node GOT;
  `deep-tree` `{depth}` — §1.3, Q11b). A refused relative `--move-to` carries `suggest:"/…"` (Q46). The
  top-level `id` stays the entry id (hole H10) — the node id is `node.id`. A create without a label → `label-required`.
- An ask whose question text repeats two or more of its choices succeeds with warning `choices-in-question` (§5.8).
- `activity` board nodes gain `id`, `parent_id`, `key`, `scope`, `label`, `type` (+ the registry's glyph / show); `path` (computed now, no `@`), `parent` (path) and
  `kind` stay; `log:{ id | path …, earlier?, removed? }`; `entry:{ id }` unchanged. The logger WS `wait_answer` takes `node_id`
  (its `path` form is the 2.0 path).

### 4.3 `{log_snippet}` and the guides
- `{log_snippet}` keeps its 1.73 shape — the command + ONE line — with the 2.0 command: `Report your status with: "<node>"
  "<script>" --session "S" --project "P" [--token-file "…"] --agent <your-key> --label "<your name>" --under <item-key>` and
  "First run it with --guide agent in place of --text: that puts you on the board and prints the rules." The orchestrator
  fills `--agent`, `--label` and `--under` (the label is required to create the agent, Q31; repeating it on later calls is
  harmless, §3.5).
- `agentGuide` (`lib/log-snippet.js`) gets the 2.0 rules (each line ≤ 110 characters):
```
- --key <k> names YOUR node. Make it once with --label "<name>" (needed) and --under <k>; then just --key <k>.
- --text "@<what>" sets the node's line; plain --text "…" only logs. No --key = your own node.
- Make your checklist first: --item <k> "<label>" (repeat it); tick one with --key <k> --done.
- A name a sibling already has becomes "<name> (2)": the result says which label you got.
- Report at milestones only (calls cost tokens); add --stale-after 60m before a long silent step.
- A used key reopens its node: new work gets a new key (docs-2). Keys: letters, digits and _ . # + -
- Finish with --state done --text "@<summary>" (or failed): the @ makes the summary your line.
- Never put secrets in status text.
- Need a decision? --ask "…" --choice "A" --choice "B" --wait 30m waits for the answer (exit 0 = answered).
- Ask the question only, then one --choice per option: don't list the choices in the question.
```
  `sessionGuide` gets the session's version (its own `--key` items; "give each agent `--agent <key> --under <item key>`");
  `{log_tool_hint}` the same rules in tool form (`key:"…"`, `plan:[{key, label}]`, `text:"@…"`). The realm reminders'
  orchestrator briefing ships in `config.example.json` (Robin publishes it, §10).
- **Realm-published guides (#89 part 2)** are REWRITTEN for 2.0 as part of the cutover (Q34), like the built-in ones: there
  is no 2.0-specific `min_bridge` gating and no fallback logic — a 2.0 gateway serves realm guides by 1.74's rules (an
  author's optional `min_bridge` works as today). Rewriting any realm guide in the shared `config.json` is a step of the
  runbook (§7.1), done while every bridge is stopped.

### 4.4 `--guide agent` is the agent's first report (Q17)
- `aimb-log --session S --project P --agent <key> --label "<name>" --under <item> --guide agent` prints the guide AND, when the
  agent node does not exist yet, creates it under `<item>` (label = `--label`, required; a sibling clash → `"<name> (2)"`,
  §1.6) with state running and the line "reading the guide" — so an agent appears on the board the moment it starts, with no
  extra call. The result line names the label it got.
- The node already exists (a re-read mid-work, a retry) → print only, nothing written (result line `(already on the board as
  …)`), so a re-read never clobbers a running line (the spirit of §3.5: "location only at creation").
- A refused create (`label-required`, `unknown-node` for `--under`) prints the guide, then the error, exit 64 — the agent
  sees how to fix it.
- Without `--agent` (or with `--guide session`): print only, as in 1.74. Not back-ported to 1.7x: 2.0 is the next release.

### 4.5 Removed 1.7x forms (Q19 FINAL)
Each is refused BEFORE anything is written, code `legacy-form`, with a message that names the 2.0 form. The script refuses
them on its command line; the gateway refuses them in `log` tool calls, batches, streams and `wait_answer` (an old script or
an old prompt pasted into a tool call).
| 1.7x form | Error message (abridged) |
|---|---|
| positional text (`aimb-log … "text"`) | "positional text was removed in 2.0: use --text "…" (a leading @ sets the line)" |
| `--plan "A" "B"` | "--plan was removed in 2.0: use --item "A" --item "B" (or --item <key> "<label>")" |
| `--move <node> --to <parent>` | "--move … --to was removed in 2.0: use --key <node> --move <parent> (or --path … --move …)" |
| `@` at the start of a path segment (`@Next release/@Docs`, `@"…"`, `@root`, `@?3`) | "paths have no @ in 2.0: write Next release/Docs" (the message shows the converted path) |
| `@~` in a path or text (`…/@~A`, `"@~root …"`) | "@~ was removed in 2.0: use --text "@…" on the node (--key A, or no --key for your own node)" |
| tool `to` (with `move`) / `note` | as the script's |
- Not removed: `--path` itself (§3.3), the one-value `--item "<label>"`, `--ctx`, `--batch`, `--stream`.

### 4.6 Path-only callers
- Results carry `node` (key + id) and an `alias` warning when the path was stale, so a caller can switch to `--key`.
- After a move or rename the old path is an alias, so a path caller still lands in the moved node (today it would recreate the
  node at the old path).

---

## 5. Logs and display

### 5.1 A subtree's merged log; ghosts (Q18 FINAL)
- MEMBERSHIP = the queried node + every node whose parent chain reaches it NOW: live nodes (`sess.nodes`), hidden merged nodes
  (§3.6), and GHOSTS — nodes no longer in memory (expired, evicted, dismissed) whose last parent is in the subtree. The ghost
  table (id → { parent, key, creator, label, kind, removed_at }) is rebuilt at startup from the index files' `struct` across
  retention plus the replay, and gains a row whenever a node leaves memory. Without ghosts a parent's log would LOSE a removed
  child's entries (hole H5); with them #76 is fixed.
- **A ghost lives until retention drops its last entry** — and while a ghost BELOW it still has entries (a ghost chain links
  a removed grandchild to its live ancestor). Checked at each rollover / prune: a ghost whose subtree has no entry in any
  retained day leaves the table.
- **"Show removed" toggle (off by default):** a parent's log shows its removed children's entries only when the viewer turns
  it on (a log-panel switch, kept per user in §5.6 as `opt:show_removed`). Off, ghost members are left out of the page
  request (`log:{…, removed:false}`); the node's OWN entries always show, and so do a dismissal's parent-log entry. On, the
  ghost entries show with a "(removed)" mark on their `at`.
- Memory: `logView`'s k-way merge over the members' own logs, unchanged except keys → ids. A move changes membership, so the
  old parent's log no longer shows the moved child's entries and the new parent's does — "history follows the node".

### 5.2 Paging the day files through the index
- `filePage` keeps its shape (newest first, `need`, `maxBytes`, `scanBytes`, cursor `f1.<day>.<offset>`), but `target` is a
  SET of ids and the match is `ids.has(rec.n)` — no path, no aliases, no `matchAlias`.
- `actLogPage` asks the index which days hold any member and the byte range [min first, max last] in each; it reads only those
  ranges (today: every file of the retention, `ACT_SCAN_BYTES` ≤ 8 MB per page). A day without an index file is scanned whole
  (and its index rebuilt). Converted days are ordinary v6 days (§7): there is no second reader.

### 5.3 Runs and "show earlier runs" (Q07)
- A node's run begins at its `create` (`run:true`) or a carry-forward's `run_at`. Paging stops at the queried node's run
  start (`run_start`, `earlier_cursor`, `pruned` — 6c's contract, unchanged for the page).
- **Per member:** each member contributes the entries of ITS OWN current run; "show earlier runs" adds earlier runs. So a node
  MOVED IN shows its whole run at once (answers #82's "the new parent's merged log stops at ITS run start").

### 5.4 The dashboard tree
- Units: `dashUnits` id = `["n", groupKey, lc(host), nodeId]` (was the path key); `parent_id` (was `parent_key`); rows,
  open state, selection (`selKey`), pins / hidden, feedback and drag-and-drop all key by id. Rows keep `data-path` for display
  and copying.
- Actions send `{type:"activity_action", ref, host, session, project, user, id, action, args}` with id-valued args (`to_id`,
  `before_id`, `after_id`, `into_id`) — no path quoting, no `sibRef` names.
- New menu items: **Rename…** (label ≤ 60), **Merge into…** (picker: contexts of the same session and host, then confirm).
  Unmerge: not on the dashboard in 2.0 (Q06). A move or merge onto a same-label sibling opens the clash dialog — merge them,
  or a different label pre-filled with the suggestion ("Notes (2)") — and sends the answer as one action (§1.6, Q32).
- Depth (Q11b): the Move to… picker greys out targets where the moved subtree would pass depth 32 (with the reason on
  hover); a target that would take it past 20 shows the `deep-tree` warning in the dialog before the user confirms. Long
  paths (row tooltips, the log's `at`, dialogs, notices) are shortened in the middle (`Next release/…/Docs`), the full path on
  hover.
- **The Answer dialog** (#85 / #90, §5.8) reads like a question in Claude Desktop: the question text on its own, then its
  options listed BELOW it as the answers to pick (the `choices`, one each), then the free-text field when the question
  allows one. The dialog never parses options out of the text; the choices are structured fields.
- Rows show their TYPE's glyph and, where a bar would be, what the type `show`s (a bar, a group's count, a question's
  status, a test-run's bar and counts — §1.7); the right-click menu comes from the registry's `menu` slot (#92, filled in
  step 2d: `menuOf2`).
- Log entries show `at` on hover when it differs from the node's path now. Copy command = `--agent <scope> --key <key>` (or
  `--id <id>` when the node has no key path).
- The view state (pins, hidden, open / closed, selection, DETAILS fold, last seen) is per USER on the bridge (§5.6), no longer
  per browser.
- No path fallback in the page: after the cutover every host is 2.0 and every unit carries an id (§6).

### 5.5 Notice subjects
- #80 / #83 / #84 / #85 subjects use `displayPath` of the node's CURRENT path at SEND time (a batch is flushed seconds later:
  computed at flush, from the id). Bodies gain `node_id`, `key`, `scope` beside `path`. New verbs: none; `rename` / `merge`
  are `activity_changed` actions ("robin renamed Rel/Docs to "Write the README"", "robin merged Rel/#79 into
  Rel/#79 three-part progress").

### 5.6 Per-user view state (Q13 FINAL + Q28)
What a viewer chooses about the tree and the log is stored PER USER on the bridge and REPLICATED across the realm, so robin
sees the same board on ROBIN-Z790, LITTLE-001 and the Mac. It follows the realm-replication patterns of architecture.md §13:
#62's last-writer-wins set with tombstones and local stamp bumps (grants, v1.45.0), #66c's version-gated gossip and
"persist what you learn, one file per writing host" (retained values, v1.48.0).

**What is kept, and the rules it follows (Q28):**
| Choice | Record key `k` | Value `v` | Rule |
|---|---|---|---|
| a pin | `pin:<t>` | `1` | as today's pins |
| a hidden row | `hide:<t>` | `1` | as today's hidden |
| open / closed | `open:<t>` | `{o:1}` or `{o:0, n:<subtree entry count at close>, q:<open questions at close>}` | an explicit open / close BEATS the default rule (`isOpen`'s `def`: open plans, their ancestors …). New activity never reopens a closed node: it shows a badge instead — "? N" (N = open questions in the subtree now − `q`, when > 0) else "N new" (subtree count now − `n`). Opening clears the badge. |
| Expand all / Collapse all | `all` | `{o:1\|0}` | one record, not one per row: it applies to every node CREATED BEFORE its `ts` that has no newer `open:` record. Nodes created later take the default — unless under a closed node, where they are not visible anyway. |
| the log selection | `sel` | `<t>` | restored at page load; new activity never steals the selection or the scroll (as #87) |
| the DETAILS fold | `fold:details` | `1\|0` | the #86 details section open / closed |
| last seen | `seen:<t>` | `<entry id>` | the newest entry the user has had on screen in that node's log. A refresh follows the newest entries and draws a "new since you last looked" divider above the first entry newer than `seen`. A MAX register: merge keeps the greater entry id (entry ids sort by time), so it never moves back. |
| options | `opt:show_removed` (§5.1), and per Q38 `opt:log_order`, `opt:active_only`, `opt:plans_only` | small scalars | |
| Reset view | `reset` | `1` | voids every record of that user with an older `ts` (the page shows defaults; GC drops the voided records). |
`<t>` = a node id (16 chars), or for a non-node row (a project / session header) its unit id string. Entries of the log list
are not remembered (Q28). Values are bounded (≤ 128 bytes JSON); a user holds ≤ 4 000 live records (newest kept, a log line
when trimmed).

**Whose view (Q29):** "the user" is the OS LOGIN of the gateway that serves the dashboard page (`OS_USER` in `bridge.mjs`,
`os.userInfo().username`), standing in for the person at that machine — NOT `PROC_USER` and never the `AI_BRIDGE_USER`
override. A browser page can't reveal its own OS user, so the serving gateway's login is the proxy. The welcome names it
(`view.user`) and the board head shows it ("view: robin"). Tests that need two users set a test-only env hook
(`AIMB_TEST_VIEW_USER`). Action attribution (`by.user`) is unchanged (`PROC_USER`).

**Record and order (the #62 shape):** `{ realm, user, k, v, ts, origin }` — `user` = lc(that OS login), `ts` = ms,
`origin` = the host that wrote it; `v:null` is a TOMBSTONE ("back to the default"; unpin, unhide, forget). `beatsView`: greater
`ts`; on a tie the tombstone, then the greater origin, then the greater canonical JSON of `v` — a total order, so merge is
idempotent and commutative. `seen:` merges as a max of `v` instead. A local write stamps `max(now, known + 1)` for that key, so
it beats what the host knows even under clock skew. New `lib/view-state.js` holds the set; bridge.mjs only calls `set()`,
`merge()`, `forUser()`, `rehydrate()`, `gc()`.

**Page ↔ gateway (WS, dashboard sockets only):**
- The `welcome` (or the first `activity` board) carries `view:{user, recs:[…]}` — that user's live records.
- The page sends `{type:"view_set", recs:[{k, v}]}` (debounced ~1 s; a click on a pin is one record). The gateway stamps
  `ts` / `origin` / `user`, merges, answers nothing, and pushes `{type:"view", recs}` (the changed records) to every OTHER
  dashboard socket of the same user on that gateway, and gossips them (below).
- How a page applies a remote change (Q30, decided): the TREE choices — pins, hidden, open / closed, `all`, `reset` and
  options — apply LIVE in every open window; `sel` and `fold:details` apply only when a page LOADS (newest wins), so two open
  windows don't steal each other's selection; `seen:` is merged silently (the divider moves at the next refresh).
- One-time import (Q13): on its first 2.0 load the page maps its `localStorage` `aimb.act.pins` / `aimb.act.hidden` (path-keyed
  unit ids) to node ids by the units' paths, sends them as `view_set`, then deletes those keys (try/catch throughout).

**Replication between gateways:**
- Sent on every activity link: every host is 2.0, and `activity_gossip:6` (§6.2) includes the `VIEW` frame — no separate
  capability flag.
- On link adoption each side sends its whole set (all users of the realm) in a new hub↔hub frame `VIEW {recs, full:true}`,
  newest first within a 1 MB budget (the rest stays local, logged; the next refresh retries). Afterwards each local or learned
  CHANGE goes on as `VIEW {recs}` within ≤ 1 s (batched, as the activity frames' 1 frame/s rule). LWW makes transitive re-gossip
  safe, so a change crosses any number of hubs; an idempotent merge ends the loop (only records that changed the set are
  forwarded).
- Anti-entropy: `PEER_ROSTER` carries `view_v` (record count + a hash of the newest 64 (k, ts) pairs). A link whose peer shows
  a different `view_v` on the #63 refresh sends its full set once.
- Followers serve no dashboard (architecture.md: the WS ingress is the gateway's), so they neither hold nor forward the set.
- **Persistence:** every gateway writes the set it holds (own + learned) to its OWN file, `persistence/views/<lslug(host)>.json`,
  whole and atomically (`writeAtomic`), at most every 10 s while it changes. `rehydrate()` merges every `views/*.json` it finds
  (on the Dropbox pair that includes the other host's file — read only), so a restarted host keeps the latest even if it can
  reach no one. Exact-name pattern `^[a-z0-9._-]+\.json$`; conflicted copies are skipped and warned (§10).
- **Pruned when the node is gone:** a gateway that holds a record whose node `<t>` has LEFT the board (a `remove` it applied or
  received in a slice `remove:[…]`, or a merge-away) writes a tombstone for it (stamped as above, so every host converges even
  if several write one). A node that never comes back from a host that is gone: records older than 30 days whose node no
  gateway holds are dropped locally at `gc()` (every 10 min), with no tombstone (as #62's tombstone TTL).
- **GC:** tombstones and reset-voided records older than 30 days are dropped (`AI_BRIDGE_VIEW_TOMBSTONE_TTL_MS`). The known
  limit is #62's: a host offline longer than that can re-gossip a record everyone else has forgotten.
- **Trust:** any realm member can gossip view records — the level of today's unsigned roster gossip. They name node ids and
  hold no text, so nothing private leaks; a far-future `ts` would win until a later one beats it (as #62).
- **Size:** a busy user: a few hundred pins / hidden / open records + one `seen:` per node read ≈ 50 – 200 KB.

### 5.7 Bars, plans and groups (ROLLUP, GROUPS — Robin, 2026-10-03)
- **A node's bar** is its REPORTED progress, else rolled up from its children (#79's three parts — done, skipped, total — and
  `forceBar`: a done node is 100% done, an abandoned one has its remainder skipped), with ONE change (ROLLUP, reversing 6c
  decision 7 "ordinary children win"):
  - **A node holding plan items rolls up ONLY its items: "N of M"** (M = every item; done → done; skipped and abandoned →
    skipped; todo / running / blocked / idle / failed → remaining; a question under it counts as an item: open = remaining,
    answered = done, withdrawn / expired = skipped). Its helper agents and other contexts keep their own bars on their own
    rows and never mix into it — so an OPEN plan whose helper agents have finished no longer shows a full bar (the #88 case,
    seen live). v1.75.1 ships the same rule for 1.7x (`rollup` + the dashboard's `rollKids`).
  - A node with NO plan items rolls up as before: the SUM of its ordinary children's bars when they share a unit, else their
    MEAN %, else "N of M" over its questions.
  - The TYPE registry (§1.7) carries this: a `context` / agent / session rolls up `auto` as above, a `plan` always by its
    items, a `group` and a `question` have no bar; a child adds its bar, one ITEM (a plan item or a question) or — a
    group — nothing.
- **Plans** (6b / 6c / 6d, on ids): `--item` makes plan items under the target (§4.1; labels required, Q31); "N of M" as above;
  a plan ENDS when every item is done, when a CONTEXT plan node's own line is set done / abandoned, or by the plan-end marker
  of an agent / the session (the dashboard's complete / abandon plan, or an `abandoned` line on it); abandoning a node
  CASCADES to the open contexts and open plans under it (not crossing another agent), each with an "abandoned with …" entry;
  an open question in the cascade is withdrawn. Items created by one call get DERIVED ranks (creation order, then their
  position in the call); a stored rank only where a derived one would sort before an existing item (positions are step 2c).
- **Groups:** a context can be a GROUP — a list, not a plan: a context of TYPE `group` (§1.7; candidates: Potential
  changes, Planned changes, Deployed releases, Questions; Next release stays a plan — type `plan`). A group:
  - has **no bar** (whatever it holds, and even with reported progress) and **no plan-end**;
  - **adds nothing to its parent's rollup** (it is neither one of the parent's bars nor one of its items);
  - shows, where the bar would be, an optional **COUNT** of its visible children: "4 items" when none is resolved, else the
    non-zero parts of "3 open · 1 done" (+ "· 1 skipped"). ABANDONED children (incl. withdrawn / expired questions) and the
    viewer's HIDDEN rows (§5.6) are not counted; done = done (an answered question too), skipped = skipped, everything else
    is open;
  - is set at creation (`--context-type=group`, the tool's `context_type:"group"`; contexts only) or toggled from the
    dashboard (right-click **Show as group** / **Show as plan**: an `op:"type"` record, §2.1, to type `group` / `plan`).
    Its children keep their states either way (plan items stay plan items; under a plan again they count in its "N of M").
    A plan item can't be a group (`bad-type`): it counts in its own parent's plan. A group takes no `progress`
    (`bad-field`: it has no bar).
- **Test runs** (step 2d; §3.8's `Tests`): a context of TYPE `test-run`. Its ITEMS are every plan item (and question) BELOW
  it reached through contexts — its BUCKETS (`Pending` / `In progress` / `Passed` / `Failed`) and nested test-runs — never
  through an agent or a group. Its bar is "N of M" over them — a FINISHED test is done whatever its result (Q62), so a
  failed test counts as done here — that is what it adds to its parent's rollup; its plan ends when every item is done (every
  test finished) or when its own line is done, abandoned or FAILED (the reporter ends a run with a failed line when any test
  failed). A bucket's own plan can end too (the Failed bucket's tests are done items) — it is still never evicted or
  expired alone: it goes with its run.
  **Its ROW shows ONE bar of its TESTS** (Q56 CHANGED, Robin): passed (green) vs failed (red) vs total — the rest (skipped,
  running, to go) neither — with the pass / fail counts in its TOOLTIP ("2 passed · 1 failed · 1 to go of 4 · 27 checks (2
  failed)"), in place of the items bar + counts text of 2d. Its TESTS are those items, minus questions, plus any other context
  there holding a test-result, each by outcome — passed / failed / skipped / running / pending — with the checks, failed
  checks and duration their test-results add up to (§1.7's kept `test`); `displayOf2` → `tests: testBar2(…)` = { passed,
  failed, total, pct_passed, pct_failed, tooltip, counts }. A bucket is not evicted alone: an ended run goes whole (Q59).
- **Time** (Robin, 2026-10-03: "when the task is finished the time between it being started and finished should be
  recorded in the task"; built in step 3). Every node times its ATTEMPTS from its line's state changes:
  - an attempt STARTS when the line goes `running` (and no attempt is open); blocked / idle keep it open;
  - it ENDS when the line reaches done / failed / skipped / abandoned: `took` = end − start (ms) on the node, and the
    ending entry carries `took` (§2.2). A test-result's `duration`, when given, IS the test's took (it also times a test
    that reports a duration without ever going running);
  - a REOPEN / restart (running again after an end) is a new attempt: the node keeps the LATEST `took`, plus `took_total`
    and `attempts` over every finished attempt (a test re-run is the main case; the entry carries the total once there are
    two);
  - back to `todo` mid-attempt drops that attempt (no took); an item ticked straight from todo (never running) has no
    start, so no took — none is invented;
  - a PLAN (a plan node, a test-run, an agent or the session holding plan items) also gets its own start-to-end time: from
    the first start among it and its items (`first_started_at`, kept across attempts) to the plan's end (`planEndAt2`); an
    agent's own line times its work like any node.
  The node holds `started_at`, `ended_at`, `first_started_at`, `took`, `took_total`, `attempts`; a cp / cf carries them
  (`timing`, so `log:false` and the replay window keep them). `displayOf2` gives `took: timing2(…)` = { started_at,
  ended_at, took, took_total, attempts, running_ms (an open attempt, with `now`), plan?: { started_at, ended_at, took },
  text: "took 4m 12s" | "took 30s (4m 42s over 2 runs)" | "running 3m" } — the plan's took when it has one — for the
  dashboard (step 10).

### 5.8 Questions (#85 / #90 on ids; TYPES)
- **Ask:** `--ask "<question>" --choice "A" --choice "B" [--free] [--expires 2h] [--details …]`. The question goes on the
  addressed node itself when that is already a question (a CLOSED one starts a new question there; an OPEN one →
  `question-open`) or a plain line-less, childless `context` that is not a plan item (it BECOMES type `question`: an
  `op:"type"` record; a context the same call creates is created as one); otherwise on a new child of type `question`,
  keyed `?<n>` in the ASKER's scope (n = 1 + the highest `?<digits>` key that scope holds, live or ghost) and labelled `?<n>`
  by the bridge. Its line: text = the question, state blocked, `question` = { status:"asked", choices, free, asked_at,
  expires_at? }; its entry is a `question` entry (§1.7) with those typed fields.
- **How a question reads (Robin, 2026-10-03):** like a question in Claude Desktop — state the question; its options are
  listed below it as the answers. The question text must NOT restate the options ("Which database should the cache use?",
  not "Postgres or SQLite?"), and choices stay STRUCTURED fields (`--choice`, the tool's `choices`), never formatting
  embedded in the text. An ask whose text repeats two or more of its choices succeeds with warning `choices-in-question`.
  The 2.0 agent guide says it: "don't list the choices in the question" (§4.3); the Answer dialog shows it (§5.4).
- **The question's line is the question:** a plain report may LOG on it; a `@` line or a state on it is refused
  `question-node`; abandoned on an OPEN one (the asker's state, or a cascade) withdraws it. It holds no children (type
  `question`, `children: []`) and takes no plan or progress.
- **Status changes** keep the line's id, text, details and data; each writes its own typed entry with details of its own
  (#90): the asker's `state withdrawn` (+ a note) → a `withdrawal` entry; the dashboard's Answer / Change answer → an
  `answer` entry (`choice`, `text`, `revised`; state done — the STATE still drives plans and bars); the dashboard's
  Withdraw → `withdrawal`; the bridge's expiry → `expiry` (`after_ms`). Answer / withdraw / expiry are SYSTEM messages (no
  activity).
- **Never stale while open:** an open question has no stale time (its agent may go stale); closed, it follows the context
  rules. In a plan node it counts as one item (open = remaining, answered = done, withdrawn / expired = skipped); in a group
  it counts in the group's count (withdrawn / expired = abandoned: not counted).

---

## 6. Gossip (2.0 only)

2.0 speaks only 2.0 between hosts (Q39, confirmed): no v5 projection, no dual handshake, no translation toward an old owner,
no handling of a stray 1.7x peer. **Every host is upgraded together**, with the stop-all runbook (§7.1).

### 6.1 The v6 slice
- `ACTIVITY_SLICE` body `v:6`: one unit per node (`snapNode`), `path` replaced by `id`, `p` (parent id), `c` (creator id),
  `key`, `label`, `nk`; everything else as v5 (`current` without details/data, `progress`, `rank`, `plan_item`, `log_n`,
  `plan_end` …). No path in the unit: a rename or move then changes ONE unit, not every descendant's. The root unit carries
  `root:true`. Merged nodes are not sent. `remove:[{…session, id}]` (a node and its subtree, as today).
- Deltas, epochs, the byte cap, newest-active first, the 1 frame/s rule: unchanged (`planSlice` / `applySlice`).

### 6.2 The handshake: `activity_gossip:6`
- **Hole H3:** a peer adopts activity only when `hello.activity_gossip` EQUALS its own `ACTIVITY_FORMAT` (`bridge.mjs`
  `actLinkInit`). 2.0 announces `activity_gossip:6` and needs 6 from its peer. That one number now means "v6 slices,
  id-addressed `ACTIVITY_REQ` / `ACTIVITY_ACT`, the rename / merge / unmerge actions and the `VIEW` frame (§5.6)"; the 1.7x
  feature flags it implies (`activity_plan:1`, `activity_msg:1`, `activity_ask:1`) are no longer sent or read. No
  `activity_ids` flag, no `view_state` flag, no v5 fallback.
- Not a supported state, and nothing is built for it: a host left on 1.7x by mistake fails that same equality check in both
  directions, so it shares no activity with the 2.0 hosts (its board and theirs simply don't meet) until it is upgraded.
  #88 does not change the message mesh.

### 6.3 Requests and actions by id
- `ACTIVITY_REQ {op:"log", q:{id, removed?, …}}` — the owner pages the subtree by id (§5.2); entries carry `n` and `at`.
  `entry:{id}` is unchanged (entry ids are unchanged).
- `ACTIVITY_ACT {…session, id, action, args}` with id-valued args (`to_id`, `before_id`, `after_id`, `into_id`, `label`,
  `merges:[…]` for the clash dialog's answer, §1.6) — the dashboard's §5.4 message, forwarded to the owner as today. No path
  quoting, no `sibRef` names, no translation.

---

## 7. Migration and cutover

**The cutover (Q09, Q16, Q21, Q22, Q24 – Q26, Q34, Q35, Q39).** 1.7 was experimental, so 2.0 has no rollback, no
side-by-side layout, no legacy reader and no support for old bridges. Every bridge stops; each host converts its OWN history
in place with a standalone script; then the bridges start in any order. **All hosts are upgraded together:** 2.0 shares no
activity with a 1.7x host (§6.2), so there is no "late host" window.

### 7.1 The runbook (the RESUME STATE deploy notes say this)
1. **Stop every bridge on every host** — gateways and followers, ROBIN-Z790, LITTLE-001, the Mac, phub-lnx-01 (tray,
   services, auto-start). On the Dropbox pair (`src/` is shared) this also keeps a still-running 1.7x process from meeting
   2.0 code.
2. **Update the code** on each host (the Dropbox pair: once). **Rewrite the realm guides** for 2.0, if any are published in
   `config.json` (Robin's manual step, Q34; the built-in guides are already 2.0).
3. **On each host:** `node src/tools/aimb-migrate-v2.mjs --dry-run` (reads, reports, writes nothing), then
   `node src/tools/aimb-migrate-v2.mjs`. Each converts only `persistence/activity/<that host>/`. The hosts can do this in any
   order, at the same time, or minutes apart. When it finishes, the host's history is v6 and its backup is gone (Q35) — a
   person who wants a lasting copy of the v5 files takes one by hand before this step.
4. **Start the bridges in any order** — all of them, in the same window. A host that is not converted yet (or whose
   migration did not finish) refuses to start and says which command to run (§7.5), so a forgotten step fails loudly
   instead of showing an empty board.

### 7.2 The script: `src/tools/aimb-migrate-v2.mjs`
```
node src/tools/aimb-migrate-v2.mjs [--dry-run] [--dir <persistence dir>] [--host <name>] [--port <n>] [--config <file>] [--json]
```
*(As built in step 5 — see "5 as built" in §8: `--backup` is not built (Q67), `--port` / `--config` are; the bridge check
is a TCP connect that sends nothing (Q66); a FAILED run restores the v5 files and removes the backup (Q68).)*
- `--dir`: the persistence directory (default: what the bridge would use — `persistence.dir` from the config, via the bridge's
  own config loader, else `<repo>/persistence`). `--host`: the bridge's host name (default: the bridge's `HOSTNAME` rule, the
  same `lslug(host)` function, so the script converts exactly the directory the gateway owns). `--json`: one JSON report line.
- **Preconditions** (each refusal exits 2 with one line naming the fix):
  - the host's gateway must NOT be running: the script dials the bridge's well-known port on this machine; an answer →
    "a bridge is running on this host — stop it first". It also refuses if any `*.tmp` newer than 10 s sits in the host's
    directory (a writer is active).
  - `activity/<host>/format.json` with `v:6` exists and NO backup directory → "already converted (format v6, 2026-10-04 by
    aimb-migrate-v2 2.0.0) — nothing to do", exit 0 (the idempotent re-run). With a backup directory still there, the run
    RESUMES at step 5 (a crash after the marker).
  - no `YYYY-MM-DD.jsonl` in the directory → a fresh host: write the marker, exit 0.
- **Steps** (each step's output is complete before the next starts; a crash anywhere leaves a state the next run handles).
  **The backup exists only DURING the migration (Q35):**
  1. **Backup.** Copy every exact-name day file of the directory to `persistence/activity-v5-backup/<host>/` (outside
     `activity/`, so no reader ever lists it), then write `activity-v5-backup/<host>/COMPLETE` with the files' names, sizes
     and sha256. A backup with `COMPLETE` is never overwritten — a re-run after a crash reuses it, so the backup always holds
     the PRISTINE v5 files. A backup without `COMPLETE` (a crash while copying) is redone.
  2. **Convert.** Read the v5 days from the BACKUP, oldest first, run the forward pass (§7.3), and write each converted day as
     `<day>.jsonl.tmp`, then rename it over `activity/<host>/<day>.jsonl` (the host's own file; every bridge is stopped).
     Converting from the backup, never from the half-converted directory, makes a re-run after a crash produce the same bytes.
  3. **Index files.** Write `<day>.idx.json` for every converted day (§2.4).
  4. **Marker:** `activity/<host>/format.json` = `{"v":6,"by":"aimb-migrate-v2 2.0.0","at":"<ISO>","host":"ROBIN-Z790",
     "days":{"2026-10-01":{"size":…,"sha256":…},…},"records":41233,"nodes":812,"ghosts":17,"relabelled":2}`.
  5. **Verify.** Re-read every converted day from disk: its size and sha256 equal the marker's, every line is a v6 record,
     every index file parses and matches its day (`size`, entry counts), and a fresh 2.0 replay of the converted days builds
     a tree with the report's node count. Any mismatch → exit 3 "verification failed", the marker removed and the backup
     KEPT (the next run redoes steps 2 – 5 from it). *As built (Q68): the failed run RESTORES instead — the v5 files are put
     back from the backup (checked against `COMPLETE`), the index files and marker go, then the backup is removed, so the
     directory is exactly as before the run; only if the restore fails is the backup kept (and named).*
  6. **Delete the backup**, `COMPLETE` LAST. A crash mid-delete: the next run finds files missing from `COMPLETE`'s list —
     the delete had begun, so verification had passed — and just finishes it. Then the report.
- **`--dry-run`:** runs the preconditions and the whole forward pass in memory and prints the report — days, records, nodes,
  ghosts, the relabelled duplicate labels, keys slugged from names with `:`, conflicted copies seen, bytes it would write —
  and writes NOTHING (no backup, no `.tmp`, no marker). Exit 0, or 2 on a refused precondition.
- **Report** (both modes): "activity/ROBIN-Z790: 7 day files, 41 233 records → 812 nodes (17 ghosts), 2 labels made unique,
  verified, backup (12.4 MB) removed, 1.4 s" (dry-run: "would write …").
- Conflicted copies in the directory (`… (LITTLE-001's conflicted copy …).jsonl`) are listed as WARNs, never read, never
  converted, never deleted (Q23, Q27: warn only — they stay for a person to inspect).
- Stale `*.tmp` (older than 10 s) in the host's own directory are deleted before step 2.

### 7.3 The conversion (pure: `lib/activity-v5.js` `convertV5(days) → { days: v6 lines per day, report }`)
One CHRONOLOGICAL forward pass, far simpler than #82's newest-first remapping:
- A path map `pathKey → run`. A v5 record at a path joins the run there, or starts one (and its missing ancestors). A record
  whose `new_from` is at or above a held node starts a NEW run there (the old one ended unseen — expiry). `moved_from` re-keys
  the run (and its subtree) to the new path. `dismiss:true` and `evicted:[…]` end the runs at / under that path.
- At the end every run has a FINAL path. **Id = legacy id of the final path** (hole H7: a moved node has several paths; the
  final one is the path it has when converted, the one the one-time pins import maps by, §5.6). Runs that share a final path
  share the id — earlier runs of one node, exactly as today's run boundary treats a re-used name.
- Keys: agents get key = their segment (slugged if it has `:`); contexts key = slug(segment) in their owner's scope, `-2` … on
  a clash, in created order. Labels = the segment without `@`. Where an agent `x` and a context `@x` share a parent (the one
  duplicate v5 allowed), the younger gets the label `x (2)` (§1.6), listed in the report.
- **Output = the v6 records 2.0 would have written**, in the original order, one input record → its v6 form, plus node
  records where the structure changed:
  - the first record of a run → a `create` (`run:true`, ts = that record's) before it; `moved_from` → a `move` (+ the old
    path into the node's aliases); `plan_item` / `plan_ix` → `item`; `dismiss:true` / `evicted:[…]` → `remove` records
    (the dismissal entry stays, on the parent); a relabel → a `label` record at the node's `create` ts.
  - entries → v6 entries (`n`, `at` = the v5 path at the time written without `@`); cp → v6 cp; cf → v6 cf with the structure
    the pass holds at that point (`run_at`, `aliases`, the v6 fields); rep lines unchanged (cp `k` numbers are kept).
  - questions: the line's `question` unchanged; `@?N` → key `?N`. Ranks: stored ranks copied (a rank is relative to siblings).
    `plan_end`, `line_by`, `cpartial` / `log_n`: kept.
- So after the migration there is ONE format on disk and ONE reader: the 2.0 replay reads converted days like any other v6
  day (the cf at the newest converted day carries the structure, as §2.3). No map, no baseline, no state file.
- **Deterministic:** the output is a pure function of the v5 files (no wall-clock time, no machine name; the marker's `at` is
  the only exception and is not part of any day file), so a re-run gives byte-identical day files.

### 7.4 Shared folder: two hosts, one Dropbox
- Each host converts ONLY `activity/<its own host>/` — the directory its gateway already owns (`persistActivity` writes only
  `HOSTNAME`'s files; `pruneActivity` prunes only them) — and its own backup directory. ROBIN-Z790 converting never touches
  LITTLE-001's files and vice versa, so the two can convert at the same moment.
- The in-place rewrite is safe in the Dropbox folder because (a) only that host ever writes its directory (no conflicted copy
  can arise from it), (b) every bridge is stopped, so no reader on either machine reads it mid-change, and (c) no other host
  ever reads another host's activity directory. Dropbox simply syncs the new versions.
- **Ids can't collide across hosts:** every id hashes `lc(host)` (§1.2).
- The full rule set is §10.

### 7.5 The 2.0 bridge on unconverted (or half-converted) history
- At start, before the replay, a 2.0 GATEWAY lists its own `activity/<host>/`. Exact-name day files present and no
  `format.json` with `v:6` → it REFUSES TO START: exit 78 with "activity history in persistence/activity/ROBIN-Z790 is format
  v5 (pre-2.0). Stop every bridge, then run: node src/tools/aimb-migrate-v2.mjs (see docs/spec-88.md §7.1)". The tray shows
  the same line. Followers own no activity: no check.
- `activity-v5-backup/<host>/` still present (a migration that crashed or failed verification) → it REFUSES TO START the
  same way: "the migration of persistence/activity/ROBIN-Z790 did not finish — run node src/tools/aimb-migrate-v2.mjs again".
  The re-run resumes from the backup (§7.2).
- No day files and no marker (a fresh install, or persistence just enabled) → the gateway writes the marker and starts.
- There is no way back to 1.7x and no stray-v5 handling (Q09, Q25, Q39): old bridges are not supported, and once the
  migration has verified, the v5 files are gone (Q35). The 2.0 reader takes v6 records only; any other line is skipped by
  the reader's generic rule (`recordKind` → null, as an unreadable line is today), with no special detection or WARN.

### 7.6 How long it takes
- Prototype (scratch, this machine): parse + legacy-id + stringify of synthetic v5 records ran at ~230 – 260 MB/s — 10 000
  records (3.9 MB) 17 ms, 50 000 (19 MB) 80 ms, 200 000 (77 MB) 300 ms. The forward pass adds a Map lookup per record.
- Realistic: 7 days of retention at 1 – 10 MB a day = 7 – 70 MB read → under 1 s CPU. It writes the converted days (about the
  same size: `n` + `at` replace `path`, node records add ~2 %), the index files and the short-lived backup copy (Dropbox may
  upload it before the script deletes it) — so Dropbox moves up to twice the activity history of that host once. The bridges
  are stopped meanwhile; nothing waits on it at start.

---

## 8. Build plan
Each step lands green (`npm test`, typecheck included) and is reviewable alone. Steps 1 – 3 are pure library work: the new
model is built beside the old one (`lib/activity.js` keeps serving 1.74 until step 9 switches the bridge), so the 2 740-odd
existing checks keep passing while the core is written.

1. **Identity primitives** (`lib/activity.js`, new section): `mintId`, `legacyId`, `validKey`, `slugKey`, `uniqueKey`,
   `parseRef`, `parsePath2` (no `@`, quoting), `parseText` (the leading-`@` rule, §4.0), `labelKey` (NFC + lc for uniqueness).
   *Tests:* unit — id vectors (§1.2), case-folding, charset edges (`:`, `?N`, `root`, 48 / 49), slug clashes, the `@` run
   table (`@x`, `@@x`, `@@@x`, `x@`), path quoting, `@`-paths refused as `legacy-form` with the converted path in the message.
2. **The id-keyed model.** `sess.nodes` keyed by id; `sess.kids` by parent id; the scope index (creator id + lc(key) → id);
   the sibling label index; aliases; ghosts (+ their lifetime, §5.1). `apply` resolves the target (§3) and writes node records
   + entries; move / rename / merge / unmerge / item / remove become pointer changes + one record each. The label rules
   (§1.6): `label-required` on create, AUTO-RENAME on create (`"x (2)"`, `asked`, warning `relabelled`), `duplicate-label`
   on a tool / script rename / move / merge / unmerge, move + rename as one checked change, the dashboard's clash answer
   (`merges` / `label`) applied as one all-or-nothing action; `cross-session` / `unknown-agent` refusals; plans, questions,
   cascade, ranks, plan-end, eviction, expiry, `applyAction` on ids. 2a structure + resolution, 2b lines (§4.0) / plans /
   questions / the type registries (§1.7), 2c actions + notices + moves, 2d the first user types (test-run, test-result). 2c includes **`--move-to` and transient contexts (§3.8, Q43)**:
   - the `move_to` field (message, batch and stream items);
   - its path parser (a leading `/`, leading `..`; `formatPath2` also quotes a `..` label);
   - report-then-move as one checked change, with the no-op move on a retry;
   - the per-segment walk: live child → this parent's same-label ghost RESURRECTED (same id, `create` + `run:true`) → a new
     context in the caller's scope with a key unused there, live or ghost;
   - arrival last; the `--move` refusals;
   - the `transient` flag (`--transient` / `transient:true` on create), the bottom-up vanish when the last live child leaves
     (an entry + `remove` `why:"transient"`, chained up through emptied transient parents);
   - the grace period (`--transient=30s` / `transient:"30s"`, Q44: removed by the expiry pass; an arrival keeps it), the
     bare-name refusal (Q45) and the depth rules (Q11b: `depth` past 32 for the whole subtree, `deep-tree` past 20; `at`
     capped at ~1 KB);
   - permanence: the `keep` record on `--keep` / `keep:true`, a rename, or a line of its own (the PIN trigger lands with
     step 8's view state).

   **2c as built** (2026-10-03): in `src/lib/activity2.js`, still beside the 1.7x model and wired into nothing.
   POSITIONS (#82's ranks on ids): `before` / `after` (a §3.2 reference to a SIBLING, or `before_id` / `after_id`; a bare
   key that names no sibling is also tried as a sibling's label) and `position: "first" | "last"` (the script's `--first` /
   `--last`) — on a NEW target, on the plan items a call CREATES (none created → warning `position-unused`), on `--move`
   (where it lands; a same-parent move with a position = a reorder), and alone on an existing target = a REORDER (one `rank`
   record + its "placed before Build" entry; a no-op when it is already there, so a retry reorders nothing). A position on an
   existing target in a call that gives `--under` is ignored with `exists` (H2). Refused with `--move-to`, `--merge`,
   `--unmerge` (`bad-position`) and `--ask`; `unknown-anchor`, `bad-anchor` (not a sibling there, or another rank group),
   `rank-exhausted`. Stored ranks only where needed (a new node placed last keeps its derived rank). NODE LIMITS (≤ 4 096
   nodes, ≤ 128 agents per session; `createModel({ limits })` lowers them for tests): a call that creates past them EVICTS
   the oldest finished agents / ended plans (`remove` `why:"evict"`, `evicted` in the result; never anything the call
   touches or an ancestor of it, never part of an open plan), else `too-many-nodes` / `too-many-agents`, nothing written.
   `applyAction2` = the dashboard's actions on ids (done / skip / reopen / abandon, complete / reopen_plan / abandon_plan,
   finish, dismiss — its entry on the PARENT with `dismiss:true` + `of`, the session root's on itself and the whole session
   leaves —, move (+ a position), reorder, rename, merge, edit_text, message, answer / change_answer / withdraw wired to
   2b's calls, show_as_group / show_as_plan wired to `setType2`); each all-or-nothing, attributed, a system change. The CLASH
   DIALOG: `clashes2` (read-only) lists what a move / merge would clash with, `can_merge` (never for an agent), the
   suggestion and the clashes "merge them" would make one level down; the answer rides the move / merge action as `label`
   and `merges:[{ id, into_id } | { id, label }]` and is applied as one checked change — an unanswered clash →
   `duplicate-label`, an answer that no longer fits → `clash-changed`, both carrying the fresh list. NOTICES (§5.5, model
   output): `actionNotice2` (→ `{ verb, subject, body, to, agent, now }`), `messageNotice2`, `answerNotice2`,
   `combineActionNotices2` — verbs as 1.7x (`activity_changed` incl. rename / merge / Show as …, `activity_text_edited`,
   `activity_message` and `activity_answer` sent at once), subjects with the node's path at SEND time from its id (shortened
   in the middle), bodies with `node_id` / `key` / `scope`, addressed to the node's session with its nearest agent named.
   Tests: `tests/unit/test_activity2c_unit.mjs`.

   **2b as built** (2026-10-03): in `src/lib/activity2.js`, still beside the 1.7x model. Lines and entries (§4.0: the
   leading-`@` rule through `parseText`, `@@`, no implied line — a state / bar / ETA change keeps the line's text, Q33; a
   context's own line makes a transient context permanent); v6 entries with `n`, `at` (capped at 1 KB) and `current` = the
   entry changed the line (its text OR its state; `line_text` names the line's text when the entry's differs), the
   structural verbs' entries (moved / renamed / merged / unmerged / emptied) as real entries, and `writes` = every record and
   entry of a call in order; plans (`plan:[ "label" | { key, label } ]`: keep / adopt / create / `exists-elsewhere`,
   label-required, auto-rename, derived ranks + a stored one where needed, the `item` record); the ROLLUP rule (`bar2`), the
   plan end (`planOf2` / `planEndAt2` / `planEndHow2`, the agent's plan-end marker), the cascade; questions (ask with the
   `?N` key in the asker's scope, the asker's withdrawal, `answerQuestion2` incl. change answer, `withdrawQuestion2`,
   `expireQuestions2`, `questionOutcome2`, never stale while open: `staleAt2` / `effectiveState2`); TYPES (§1.7: the
   `NODE_TYPES` and `MESSAGE_TYPES` registries, `parseContextType`, `validateEntryFields`, `context_type` on create,
   `message_type` + `fields` on a report, `setType2` = Show as group / plan, `displayOf2`; a question is type `question`, an
   answer an `answer` entry; GROUPS = type `group`: `groupCount2`, no bar / plan end / rollup contribution); Q46
   (`parseMoveTo` refuses every deeper relative form, the call answers `suggest`; `resolveCall` = the `resolve` tool). Left
   for 2c: positions (`before` / `after` / `first` / `last`), `applyAction` on ids (the dashboard actions incl. Show as
   group / plan wired to `setType2`, answer / withdraw wired to `answerQuestion2` / `withdrawQuestion2`, edit text,
   message, complete / reopen plan, finish, dismiss with its parent entry), eviction + node limits, notices, `log:false`
   checkpoints (step 3: the entry is just not written; `cp_dirty` marks the node). Tests:
   `tests/unit/test_activity2b_unit.mjs`.

   **2a as built** (2026-10-03): `src/lib/activity2.js` (beside `lib/activity.js`, used by nothing but its tests yet) —
   `applyCall` (target resolution + the structural verbs, all-or-nothing through an undo journal), `parseCall`,
   `parseMoveTo`, `sweepTransients` (the grace pass), `expireAliases`, `pruneGhosts`, `removeById`, `capAt`, `shortPath`;
   `--move-to` / transient contexts were pulled forward from 2c into 2a. Entries are returned as stubs for 2b; positions,
   the dashboard clash answer, eviction and node limits stay in 2c. Tests: `tests/unit/test_activity2_unit.mjs`.

   After the 2.0 cutover, the #81 dashboard test reporter (`tests/reporters/aimb-dashboard.mjs`) switches to this pattern:
   §3.8's `Tests` / `Pending` / `In progress` / `Passed` / `Failed` example.
   *Tests:* new resolution / idempotency / label-uniqueness (auto-rename incl. the 60-code-point cut, a retry not making
   `(3)`, `--label` = `asked` raising no `exists`; refusals; a clash answer that went stale) / duplicate-key / merge (incl.
   clashes) / unmerge / alias / ghost / running-agent-move checks. For `--move-to`:
   - §3.8's test-run example end to end: buckets created on first use; `Pending` / `In progress` vanish; the `Tests` bar
     across the buckets;
   - a second run resurrects the same bucket ids, each with a new run and earlier runs behind "show earlier runs";
   - a retry is a no-op move;
   - refusals: `duplicate-label` on arrival (nothing written, report included), depth, `..` above the root, cross-session;
   - permanence by `--keep` / rename / own line;
   - a non-transient empty context never vanishes.

   Plus the existing `test_activity_unit` behaviours, re-expressed in 2.0 forms.

   **2d — Types: test-run + message types** (TYPES, Robin 2026-10-03; after 2c, before the dashboard step; pure library
   work like 2a – 2c). The registries and the mechanism are built in 2b (§1.7); 2d builds the first USER types on them:
   - the `test-run` node type (reserved until now): a run's buckets and items (§3.8's `Tests` / `Pending` / `In progress` /
     `Passed` / `Failed`), its bar = its items, what it shows in place of a bar (passed / failed / total) and its menu slot;
   - the `test-result` message type: `--message-type=test-result --result pass --checks 22 --duration 4.1s` (the typed
     fields validated by the registry — `result` pass / fail / skip, `checks`, `duration`), and the counts the bridge keeps
     from them (passed / failed / checks per run);
   - the script's field flags for typed messages (wired with step 9's 2.0 flags);
   - **#81's dashboard test reporter** (`tests/reporters/aimb-dashboard.mjs`) is the first user of `test-run` (after the
     cutover); **#92 (the context-aware menu) folds into the registry's `menu` slot**.
   *Tests:* unit — a test-run's bar and counts across its buckets, `test-result` field validation (good, bad enum, negative
   count, duration forms), the reserved names now accepted.

   **2d as built** (2026-10-03): in `src/lib/activity2.js`, still beside the 1.7x model and wired into nothing. The
   reserved names are real types (no reserved type is left; the mechanism stays). `test-run`: a settable context type
   (`--context-type=test-run`) with `bar: items`, `items: tree` (`runItems2`: its plan items / questions below it through
   context buckets and nested runs, not through an agent or a group — so §3.8's Pending / In progress / Passed / Failed
   work unchanged, the buckets being plain transient contexts), `show: tests` (`displayOf2` gives the bar AND
   `testCounts2` = { tests, passed, failed, skipped, running, pending, checks, failed_checks, duration_ms, text }),
   `counts_as: bar`, `ends: done | failed | abandoned` (a new registry slot; every other type `done | abandoned`), children
   any. `planOf2` / `planEndAt2` / `bar2` read the `items` and `ends` slots; eviction takes an ended run WHOLE (a bucket is
   never a candidate of its own; a run whose line is still live keeps its node and loses only its items, as 6b).
   `test-result`: settable; fields `result` (pass | fail | skip, `required` — a new field-spec flag), `checks`, `failed`
   (`at_most: checks` — a new flag; added so #81's "N checks (M failed)" maps across), `duration` (ms: a number is ms, a
   string needs a unit, "250ms" accepted); `validateEntryFields` checks required fields even with no `fields` given. The
   registry's `keep: "test"` makes the node keep its latest one (`node.test` = fields + `ts` + `entry` + the `state` it
   left; in `nodeView`); `testOutcome2` = that result while the node is in that state, else by state (done → pass, failed →
   fail, skipped / abandoned → skip, running / blocked → running, else pending); a restart clears it; `result-state`
   warning on a contradiction in one call; with `log:false` it is kept with `entry: null`. #92: every type's `menu`
   filled (data: `{ action, label, group, when }`), `menuOf2(sess, node, { now, staleMin })` answers the entries that apply
   now (the `when` predicates mirror `applyAction2`'s own checks; Pin / Hide / Copy command stay dashboard-side). #81's
   reporter is NOT rewired (cutover, step 9+); `test_activity2d_unit` shows its calls mapped onto the model: run start =
   `--key tests --context-type=test-run` + a transient `Pending` holding one plan item per script; a script start =
   `--state running --move-to "../In progress"`; its end = `--state done --message-type=test-result --result …
   --checks … --failed … --duration … --move-to "../Passed"|"../Failed"` (FAIL lines in `--details`); the tick = a
   `log:false` line on the run (no progress needed: the bar and counts come from the items); the end = a `done` / `failed`
   line on the run. A second run: the known scripts answer `exists-elsewhere` to the re-plan, so the reporter moves them
   back with `--state todo --move-to "../Pending"` (their kept results drop; every bucket keeps its id). Left for later:
   checkpoints carrying `test` (step 3), the script's field flags (step 9), the dashboard's use of `tests` and `menuOf2`
   (step 10). Questions Q56 – Q60 (§9). Tests: `tests/unit/test_activity2d_unit.mjs` (+ 2b's reserved-name checks
   updated). *Changed during step 3 by Robin's answers:* Q56 — a test-run row shows ONE tests bar (passed / failed / total,
   counts in the tooltip: `testBar2`), not the items bar + counts; Q57 / Q61 / Q62 — state is progress, result is outcome:
   a test-result sets the state to DONE whatever the result (`--state done` with it is fine, any other state → `bad-state`;
   any context can take one, a skip too; an agent can't: `not-a-test`), and the `result-state` warning is gone. So a failed
   test is a done item: the reporter's fail end is `--state done` (or none), a run's items bar counts it done, and the
   Failed bucket's own plan ends (it still goes only with its run).
3. **v6 records + replay.** `recordKind` v6 only; `createReplay` folds node records (newest wins per field, `create` seals
   the run) and attaches entries by `n` — no remapping. cp / cf / rep v6; `planCarryForward` carries structure. *Tests:* a
   seeded REPLAY FUZZ like #82's (400 random sequences of reports, plans, moves, `--move-to` with transient vanish /
   resurrect / keep, renames, merges, unmerges, dismissals, evictions, expiry, day rollovers with cf) — replay ≡ chronological apply (lines, bars, structure, logs, counts, runs).

   **3 as built** (2026-10-03): in `src/lib/activity2.js` (the section at its end) + the new `src/lib/activity2-files.js`,
   still wired into nothing. RECORDS — what the replay needs, added to the v6 writers (§2.1 – §2.4): `create` + `scope` /
   `implicit` / `runs`, `merge` + `kid_ranks`, entries + `line` / `test_cleared` / `caller`; EXPIRY WRITES its removals
   (`expire2`, `remove` why `expire`; `expirePass2` = question expiry + the grace sweep + expiry, in that order) instead of
   the replay re-running it. `recordKind2` reads v6 only. CHECKPOINTS: `planCheckpoints2` / `flushCheckpoints2` (cp / rep on
   ids; a cp carries the kept `test`, 2d's note; "unchanged" = its line state equals what its newest record left,
   `cp_sig`); CARRY-FORWARD: `planCarryForward2` (structure too; every node in memory, each rollover).
   REPLAY: `createReplay2(state, { now, from })` — `feed(rec, day)` newest first (answers `old` before the window; keeps
   reading a day while a rep line there still needs an older cp's key: `wantsOlder`), `finish()` folds CHRONOLOGICALLY into
   fresh sessions and installs them: node records change one thing each (a `create` begins a run — of a ghost: same id, its
   leftover children gone; `remove` of the root drops the session), entries attach by `n` (line, state, bar, ETA,
   finished_at, plan-end marker, kept test-result, activity of target..owner + `caller`; the node's bounded log), cp / rep /
   cf restate; no expiry, eviction or grace sweep is re-run (they are records). The window: a node whose run began earlier is
   restated by the window's cf; its entries fed before that cf become its log's head and it gets `log_floor` = the window
   start (step 6's paging). `replayRecords2` = the convenience. `state.seq` continues past the replayed entry ids; today's cp
   keys are re-derived. GHOSTS: `rebuildGhosts2(state, indexes)` folds the index files' `struct` across retention and adds
   the ghosts the window did not see (key held, `last_ts` = the start of the newest retained day holding its entries).
   FILES (`lib/activity2-files.js`, synchronous, every call takes the persistence dir): `hostDir` = `activity/<lslug(host)>`;
   `createDayWriter({ dir, host })` (`append` / `replaceTail` / `writeAll` of a plan or a call's `writes`, today's index in
   memory, `rollover` writes each closed day's index, `prune` deletes a day with its index); `buildIndex` / `ensureIndex`
   (rebuilt when missing or its `size` is stale) / `readIndexes`; `readBackwards`, `readDay`, `readSpan` + `spansOf` (paging
   reads only the byte ranges the index names); the Dropbox rule — `classifyNames` (exact names; `.tmp`; "conflicted copy" /
   "Case Conflict"; unknown), `scanHostDir` / `scanViewsDir` (each odd name's WARN line once per name with a `seen` set,
   `fs_warnings` = all), conflicted copies never read and never pruned; `writeAtomic`. The REPLAY FUZZ found a 2a bug, fixed:
   `--move-to` (and a path) could RESURRECT an AGENT's ghost as a transient bucket — `ghostUnder` now takes context ghosts
   only. Robin's answers to Q56 (one tests bar: `testBar2`) and Q57 / Q61 / Q62 (a test-result sets the state to done; any
   context can take one, an agent can't; only `--state done` goes with it) were built here too,
   and his TIME requirement (§5.7): `timingStep` on every line-state change (attempts: start on running, end on done /
   failed / skipped / abandoned, a test-result's duration as its took, re-runs adding up), `took` (+ `took_total` /
   `attempts`) on the ending entry, `timing` in cp / cf, the replay re-deriving it, `timing2` / `fmtTook` and `took` in
   `displayOf2`. The window fuzz also changed the carry-forward to the WHOLE board each day (§2.3).
   Left for later: wiring all of it into the bridge (step 6: the facet appends through the writer, the index at rollover,
   paging via `spansOf`, `rebuildGhosts2` + `pruneGhosts` at startup and rollover, the conflicted-copy WARN at start /
   rollover, `fs_warnings` in the board head); the conversion that writes these records from v5 (steps 4 – 5). Its questions
   Q61 / Q62 are answered (§9). Tests: `tests/unit/test_activity3_unit.mjs` — the record fields, `recordKind2`, checkpoints (the kept result,
   rep lines in place, a new day's keys, the caller's cp), expiry records, cf + the window (`log_floor`, exact `log_n`, old
   aliases), TIME (start / end / took on the node and its ending entry, a reopen's new attempt + total, no took for a
   straight tick or a dropped attempt, a test-result's duration, a plan's / test-run's / agent's time, log:false via cp,
   cf, replay, `fmtTook`), the files (index written = rebuilt, stale size, paging spans, rep rewrite in place, a garbled tail, two hosts in
   one dir, conflicted copies warned once and never read or pruned, `views/`), the ghost rebuild (+ resurrection after it,
   pruning), and three seeded REPLAY FUZZES — 400 whole histories (everything equal: structure, lines, bars, test counts,
   logs, runs, ghosts, the scope index, labels, aliases, activity; every node op, cf and every entry type covered), 200
   windowed 4-day histories with cf at each rollover (equal but for entries older than the window), 100 with 45 % log:false
   (lines, bars, states, kept results equal; activity within one checkpoint interval).
4. **Conversion library** (`lib/activity-v5.js`: the v5 record reader moved out of `activity.js` + `convertV5`, pure).
   *Tests:* a CONVERSION FUZZ — random histories applied with a FROZEN copy of the last 1.7x library
   (`tests/fixtures/activity-v174.js`, from `git show`), then (a) its own replay and (b) the converted days through the 2.0
   replay and paging must give the same tree and pages (paths ↔ ids, lines, states, bars, plans, ranks, logs, counts, run
   boundaries); converting twice gives byte-identical days; the agent / context duplicate is relabelled.
   **4 as built** (2026-10-03): `src/lib/activity2-convert.js` (not `lib/activity-v5.js`: the v5 reading primitives —
   `recordKind`, `parsePath`, `formatPath`, `pathKey`, `normBy`, `normQuestion` — are still imported from `lib/activity.js`,
   so step 11 must keep them there or move them into this module), still wired into nothing. `convertV5(days, { host,
   config, forget? })` → `{ days, report, model, paths }`: the same days (each record filed in the day file its source came
   from), the report (records in / out, skipped lines, entries, created / restated / moved, `removed` by why, `relabelled`,
   `keyed` — agent names that are not valid keys, `per_day`), the 2.0 model the converted days replay to, and each live
   node's final v5 path → id. `readV5Dir(dir)` (exact day-file names only; a conflicted copy or any odd name is listed with
   its WARN line and never read) and `convertDir({ srcDir, dstDir, host, config })` (another directory only, never its own
   input: every day file + its index file written atomically, `files` with size + sha256 for step 5's marker).
   HOW IT WORKS: one chronological forward pass, record by record; every v6 record it writes is FOLDED at once into a 2.0
   model by the replay's own fold (`createFold2`, split out of `createReplay2` for this — the replay is that fold over its
   buffer), so the converted model IS the replay of what was written. Beside it, per session, the v5 PATH MAP (lc v5 path
   → the id there now) finds each record's node: held → used; not held and `new_from` at or above it → `create` (`run:true`;
   a held node there ended unseen → `remove` why expire first; `new_from` 0 → the root's `remove`, the whole session); not
   held and not new (it began before the history held — the oldest day, or a node the pass had dropped) → RESTATED by a
   `cf`. `evicted` → `remove` why evict; `dismiss` → the 2.0 dismissal (an event entry on the PARENT with `of`, Q54, then
   `remove` why dismiss); `moved_from` → `move` (+ `label`), the subtree re-keyed in the map; `plan_item` → `item` (a create
   carries it when it has a plan position, else an `item` record follows: the fold makes a plan item only from an
   integer `plan_ix`); a first question line → `type` question; `rank` → on the create / move, else a `rank` record (a cp
   restates it too, as 1.7x's replay reads it). EXPIRY: 1.7x's gc pass wrote nothing but ran every minute, so before each
   record at T the pass removes (`remove` why expire, at T) what 1.7x's `expire` had certainly removed by T — finished
   agents, ended plans by 1.7x's plan rules (`planOf17`: a question node's own plan counts, unlike 2.0's `planOf2`), never
   part of an open plan — once a gc minute has passed after both its due time and the record that made it a candidate (an
   item added to a plan that had ended); in the order they fell due (a pass per due time) and, within one, in 1.7x's node
   order (a moved subtree goes last) — the order decides what an ended plan takes; never a node the record itself names
   (1.7x still held it), never between the records of one call; checked fully only after a change that can make something
   due now (structure, a final state, a plan end), else at the next due time. TIME: the entry that ends an attempt gets
   `took` (+ `took_total` / `attempts`) as 2.0 writes it; a cp whose line changed carries its stepped `timing`.
   DECISIONS (mechanics): ids — two passes, the first with provisional ids learns each run's final path; runs that share a
   final path share the id (a later run reuses the first's key, creator and kind, `runs` counted) unless their lifetimes
   overlap (a node moved onto a path another had held): the one that ends last keeps the plain legacy id, the other
   `legacyId(…, path + "\u0001<n>")`; the root keeps `mintId(session, "", "")`. Every DAY FILE starts with a whole-board
   `cf` (planCarryForward2 at the day's first record — what a 2.0 bridge writes at each rollover; the 2.0 window needs every
   node's structure restated): the day's leading 1.7x cf lines are folded first, silently, then the board is written once
   (a mid-day 1.7x cf group after a restart → v6 cf lines for its nodes). A RESTATED node's created_at / last activity are
   what 1.7x's replay made of it (the record's time, or a carried descendant's created_at for the ancestors it names). Keys:
   an agent's segment (slugged when invalid — a `:`; reported), a context's slug(label), `?N` (the next free `?M` on a
   clash), `-2` … per creator (the owner at creation); two agents of one name under one owner → `sub`, `sub-2` (the second's
   chain is `w1/sub-2`). Labels: the segment; the agent / context duplicate → the YOUNGER gets "x (2)" — on a create
   (`asked`), and on a move onto it (a `label` record for whichever is younger). The `line` flag: every v5 line entry sets
   the line's details / data (1.7x's rule), so `line:true` unless it is a tick that changes none of them.
   Tests: `tests/unit/test_activity4_unit.mjs` with a FROZEN copy of the 1.7x library, `tests/fixtures/activity-v175.js`
   (v1.75.1, the last 1.7x release — not `-v174`), which writes the history (entries, cp / rep every 5 min, the gc pass
   every minute, a cf at each rollover, restarts, a clean stop's flush): hand-made cases (the records, ids, keys,
   moves, questions, time, eviction, dismissal + a new run, the session dismissed, relabels, overlapping runs, a question
   holding children, forgetting) and four seeded CONVERSION FUZZES, each comparing the 2.0 bridge's start on the converted
   days (its replay + its first expiry pass) with 1.7x's LIVE board at the stop (+ its gc pass) — base (12 histories × 500
   calls, up to ~9 days: paths ↔ ids, kind, label, parent, created_at, line, bar, plan, rank, question, log + count (within
   the 7-day window), activity, sibling order, all exact; also = 1.7x's own replay for a history inside the window but for
   created_at / order / activity of a moved-in node and the logs, where 1.7x's replay is lossy; the converter's model = the
   replay of its output; converting twice = the same bytes), 1.7x RESTARTS + 30 % log:false (no moves; counts and
   created_at aside — a restart makes them its replay's), EXPIRY (a 3 h window: paths re-used after expiry) and RETENTION
   + the WINDOW (only the newest 3 days, a 24 h window, entries within it) — and the files (a directory in, another out,
   index = buildIndex, the conflicted copy warned about and never read, the written days replayed backwards through the
   files as a bridge reads them). Sweeps of ~400 seeds per fuzz during the build: base, restarts and retention clean; the
   3 h EXPIRY fuzz differs in about 1 history in 400, always at the moment 1.7x's minute gc ran relative to a plan change
   in the same minute (no record says when it ran); with the real 7-day window such coincidences are far rarer. Speed:
   22 000 records (8 MB, one session of 2 400 nodes — far more than a real one) convert in ~3 s, both passes. Where the
   fuzz found 1.7x's own replay LOSSY (its live board and its replay differ), the conversion follows the live board and the
   evidence in the files: created_at / activity of an ancestor a moved node came under, a moved node's log; a plan item
   1.7x's gc had expired that an older cf in the window restates; after a restart, nodes 1.7x's replay mixed up.
   Left for later: the migration script (step 5: backup, marker, verify, the start check), wiring (step 6). Questions
   Q63 – Q65: accepted as built (§9).
5. **The migration script** `src/tools/aimb-migrate-v2.mjs` (§7.2) + the bridge's start check (§7.5). *Tests* (new
   `test_migrate_v2`, temp persistence dirs, fixture days WRITTEN BY A REAL 1.7x GATEWAY — `git archive v1.74.0` build,
   `AIMB_TEST_OLD_BRIDGE` — with moves, plans, questions, dismissals over 3 days):
   - **dry-run:** report correct, the directory's file list + every file's sha256 unchanged, no backup directory, no `.tmp`.
   - **run:** day files are v6; index files exist; the marker's sizes / sha256 match the files; verification passed; the
     backup directory is GONE; a 2.0 gateway then starts and its board + log pages equal the 1.7x gateway's.
   - **backup during the run** (test hooks that stop the script after each step): after step 1 it holds byte-identical
     copies of every v5 day + `COMPLETE`; it is never overwritten once `COMPLETE`; a backup without `COMPLETE` is redone.
   - **resume:** a forced crash after converting 2 of 3 days → the next run completes from the backup and the days equal a
     clean run's, byte for byte; a crash after the marker → the next run verifies and deletes; a crash mid-delete → the next
     run finishes the delete; a planted corruption → exit 3, marker removed, backup kept, the next run repairs it.
   - **idempotent re-run:** a run after a finished one exits 0 "already converted" and changes no byte.
   - **refusals:** a 2.0 gateway on unconverted days exits 78 with the command in its message (and starts after the script);
     a 2.0 gateway with a leftover backup directory exits 78 "did not finish"; the script refuses while a gateway answers on
     this host; a fresh empty directory → marker, gateway starts.
   - **shared folder:** two hosts' directories (two `--host` names) converted at once in one persistence dir touch only
     their own; a planted `2026-10-01 (LITTLE-001's conflicted copy 2026-10-03).jsonl` is warned about, left in place, and
     not converted.

   **5 as built** (2026-10-03): `src/tools/aimb-migrate-v2.mjs` (the command line, the bridge's own rules for the config
   file — `--config` > `AI_BRIDGE_CONFIG` > `src/config.json`, read only —, the persistence dir — `--dir` >
   `AI_BRIDGE_PERSIST_DIR` > `persistence.dir` > `<repo>/persistence` —, the host — `--host` > `AI_BRIDGE_TEST_HOSTNAME` >
   the machine name —, the port — `--port` > `AI_BRIDGE_PORT` > `port` > 12317 — and `bind`; the activity block through
   `resolveConfig` with the environment, as the bridge) + the library `src/lib/activity2-migrate.js` (`migrate`,
   `probeGateway` / `probePort`, `startCheck2` + `writeFreshMarker` for §7.5, `readMarker`, `readBackup`, `backupDir`,
   `dumpModel2`), on a persistence DIRECTORY so the tests run it on temp dirs. Exit codes: 0 done / nothing to do, 2
   refused (nothing written), 3 failed, 64 the command line (78 is the gateway's, §7.5). `--json` = one report line.
   IS A BRIDGE UP (Q66): the bridge keeps no lock, pid or port file — whoever binds the well-known port IS the host's
   gateway (`election()`), so the script makes a TCP connect to `127.0.0.1:<port>` (and to `bind` when that is a specific
   address) and hangs up at once WITHOUT SENDING A BYTE: the gateway's control handler does nothing until a HELLO frame (no
   state, no log line), so nothing in a running bridge changes. Accepted → refused "a bridge is running on this host (it
   answers on …) — stop every bridge first"; no answer in time → refused "could not tell". It probes again after the
   verification: a bridge that started during the run fails it (restored). Plus §7.2's writer check: a `*.tmp` newer than
   10 s in the host's directory → refused; older ones are deleted before step 2.
   THE STEPS as §7.2, with these mechanics: the backup copies are read back and compared before `COMPLETE` is written; the
   conversion reads the BACKUP's files checked against `COMPLETE` (a mismatch = "the backup is damaged": exit 3, nothing
   restored, the backup kept for a person); each day + its index file is written atomically (retried on Windows'
   EPERM / EBUSY / EACCES — Dropbox or an indexer holding a file open for a moment; removals likewise); the marker =
   `{ v:6, by:"aimb-migrate-v2 2.0.0", at, host, days:{ day:{ size, sha256 } }, records, sessions, nodes, ghosts,
   relabelled }` (`nodes` counts the session roots too, as the converter's report). VERIFY: the directory's day files are
   exactly the marker's days; each file's size + sha256 = the marker's AND its bytes = the conversion's; every line a v6
   record; every index file = `buildIndex` of its day; a fresh 2.0 replay of the written days (`from: 0`) = the converter's
   own model (`dumpModel2`: every node field, the indexes, aliases, ghosts) and its node / ghost counts = the report's; the
   bridge still down. A FAILED run (an error, a failed verification, a bridge appearing — not a crash) RESTORES (Q68): the
   marker and the index files go, every v5 file comes back from the backup (checked), then the backup is removed — the
   directory is byte for byte as before (exit 3, "RESTORED … nothing changed"); if the restore fails, the backup is kept and
   named. RESUME after a crash: a backup with `COMPLETE` and no marker → convert again from the backup; with the marker →
   verify, then delete; listed files missing + the marker → the delete had begun, finish it; listed files missing + no
   marker (a restore's delete cut short) → the directory must hold the original files (checked), the leftover is removed
   and the run starts fresh; a backup without `COMPLETE` → redone (with the marker: removed if empty, else refused "check
   by hand"). OTHER CASES: the marker and no backup → "already converted (format v6, <day> by …) — nothing to do", no byte
   written (dry run too); a marker that is unreadable or not v6 → refused; v6 records but no marker (a deleted marker) →
   refused, never converted as 1.7x; an empty host directory → the marker is written ("a fresh host"); NO host directory →
   exit 0 "nothing to convert", nothing created, the other hosts' directories named (a mistyped `--host` shows; the 2.0
   gateway writes the marker at its first start); conflicted copies and other odd names → WARN lines (report
   `conflicted` / `unknown`), never read, converted or deleted. `--dry-run` reads the host's files (or, after a crash, the
   backup — and says a real run would resume), converts in memory, reports days / records / nodes / ghosts / relabelled
   labels / slugged agent keys / bytes, and writes nothing. NOT BUILT: `--backup <dir>` (Q67: the backup always lives at
   `persistence/activity-v5-backup/<host>/`, where §7.5's start check looks for it). TEST HOOKS (env, tests only):
   `AIMB_TEST_MIGRATE_STOP=backup | day:N | marker | delete` exits 9 there, as a crash; `AIMB_TEST_MIGRATE_CORRUPT=1`
   appends a byte to the first converted day before the verification. Tests: `tests/unit/test_activity5_unit.mjs` — the
   script as a CHILD PROCESS on temp dirs only (always `--dir`, `--host`, `--port` from the file's port block, a temp
   `--config`), on 3 days of history written by the FROZEN 1.7x library (`tests/fixtures/activity-v175.js`: plans, a move,
   a question + answer, a dismissal, cp / rep, the gc pass, a cf at each rollover; not a real `v1.74.0` gateway build as
   planned above — the frozen library writes the same records): dry run (report = the converter's, every file's sha256
   unchanged, no backup, no `.tmp`), run (v6 days byte-identical to `convertV5`, index files = `buildIndex`, the marker's
   sizes + sha256, no backup, `activity-v5-backup/` gone, the files replayed backwards through the files layer = the
   converter's board, the start check passes), the idempotent re-run (and its dry run) changing no byte, refusals (a fake
   "bridge" listening on the port, a fresh `.tmp`, v6 records without a marker, a missing dir, a bad argument → 64), a
   stale `.tmp` deleted, the planted corruption (exit 3, every byte as before, start check still 78, the next run
   converts), crashes after the backup (byte-identical copies + `COMPLETE`; start check "did not finish"), after 2 of 3 days
   (the next run converts from the backup: the clean run's bytes), after the marker, mid-delete, a backup without
   `COMPLETE`, a damaged backup (exit 3, kept), the conflicted copy (warned, unchanged, not converted), two hosts in one
   persistence dir (one run leaves the other's directory byte for byte; both at once each convert only their own), an
   empty host directory (marker) and a missing one (nothing created). Left for later: wiring `startCheck2` /
   `writeFreshMarker` into the gateway's start and the tray message (step 6); a live test with a 2.0 gateway starting on
   the converted days (needs step 6 / 9); the README / runbook text (step 12). Questions Q66 – Q68 (§9).
6. **Bridge files** (§2.4, §5). Index files at rollover + rebuild, `prune` deleting `<day>.idx.json` with its day,
   `actLogPage` via the index, the ghost table at startup, "show removed", the conflicted-copy check at start / rollover.
   *Tests:* paging reads only indexed ranges (a counter in the facet), ghost entries appear only with `removed:true`, a ghost
   leaves when its last day is pruned, a rebuilt index equals the written one.
7. **Gossip v6** (§6). `activity_gossip:6` (the 1.7x feature flags no longer sent or read), v6 slices, id-addressed
   `ACTIVITY_REQ` / `ACTIVITY_ACT`, the rename / merge / unmerge actions and the clash answer across hosts. No projection, no
   translation, no mixed-version code. *Tests:* unit (slice deltas by id: a rename / move changes one unit); live between
   2.0 gateways only — boards both ways, a move / rename / merge on one host seen as one changed unit on the other, a
   dashboard's skip / move / rename / merge on a remote node, remote log pages both ways.
8. **Per-user view state** (§5.6). `lib/view-state.js` (LWW set, max register for `seen:`, `reset`, `all`, GC, budget),
   `view_set` / `view` WS messages, the `VIEW` frame + `view_v`, the user = the serving gateway's OS login (Q29; the
   `AIMB_TEST_VIEW_USER` hook for tests), `views/<host>.json` persistence + rehydrate, pruning on remove, a pin making a
   transient context permanent (the owner writes `keep`, §3.8). *Tests:* unit
   (order + ties, idempotent + commutative merge, stamp bump under skew, max register, reset voids older, `all` vs newer
   `open:`, tombstone GC, budget); live `test_view_state_live` — two gateways + a third via the first: a pin on A shows on
   C, a close on B survives new activity on A (badge "N new"), Reset view everywhere, a selection change NOT applied live
   in a second window but applied at its next load (Q30), a dismissed node's records tombstoned on all, a host restarted
   with its peers down keeps the set, `AI_BRIDGE_USER` set to another name does not change whose view it is.
9. **Tool, script, guides** (§4). The 2.0 flags + fields, the leading-`@` rule, `label-required` / `relabelled`, every §4.5
   `legacy-form` error (script AND gateway), results, `gateway-unsupported` against < 2.0.0, `--guide agent` as the first
   report (with `--label`), `{log_snippet}` / `agentGuide` / `sessionGuide` / `{log_tool_hint}` rewritten for 2.0 (finish
   with `"@<summary>"`, Q33), the briefing in `config.example.json`, server instructions, README. No realm-guide gating or
   fallback (Q34). The bridge switches to the 2.0 model here. *Tests:* `test_log_script_live` rewritten for 2.0 forms, one
   check per removed form (message names the new form), a create without `--label` refused, a clashing create reported as
   `"… (2)"`, `--guide agent` creates once and prints only on the second run, `test_activity_6c_live` (the pinned guide
   lines), the tool schema.
10. **Dashboard** (§5.4, §5.6). Units / rows / actions by id, Rename…, Merge into…, the clash dialog (merge them / a
    pre-filled "Notes (2)", Q32), the `at` tooltip, the copy command, "show removed", the view state (badges, "new since
    you last looked", Reset view, live vs load-time application, the one-time `localStorage` import). *Tests:*
    `test_dashboard_activity` (jsdom) — ids through deltas, a rename / move keeping selection, open / closed beating
    defaults, a closed node gaining activity → badge not reopen, Expand all then a new node → default, the divider, Reset
    view, the import, drag-and-drop by id, a drop onto a same-label sibling opening the dialog (both answers; "merge them"
    hidden for an agent; a nested clash listed).
11. **Delete the old machinery** (unused by now): #82's path code — `rekeySubtree`, `applyMove`'s re-keying, `remapSegs`,
    `remapGone`, `ensureIn`'s move use, `foreign`, `goneAt`, `deadAt`'s move clause, `sealRuns` / `sealNode`'s `except` /
    `recTs` / `own`, `movedAt`, `mv` / `mvAlias`, `node.moved` + `pt.m`, `nodeAliases`, `matchAlias`, `fileEntryMatches`' path
    match, `fileEntryView`'s alias remap, `fileRunStart`'s move clause, `moved_from` writers, the `cpLive` re-key — and the
    v2 – v5 readers in the bridge (they live on only in `lib/activity-v5.js` for the script), the v5 slice code and the
    path-addressed `ACTIVITY_REQ` / `ACTIVITY_ACT` handling (`sibRef` names, the `activity_plan` / `activity_msg` /
    `activity_ask` gates), `@` / `@~` path parsing, the positional / `--plan` / `--to` handling (only the §4.5 detector that
    names the new form is left), the page's `localStorage` pins. KEPT from #82: ranks (`rankBetween`, `placeRanks`,
    `siblingCmp`, `derivedRank`), the cascade, positions, the actions. *Tests:* the full suite; a grep check that no
    `moved_from` reader and no `@~` parser is left outside `activity-v5.js` and the `legacy-form` detector.
12. **Release 2.0.0**: architecture.md §12 (the v6 layout, `views/`, the migration's temporary `activity-v5-backup/`) + §13,
    README (2.0 forms, the removed-forms table, "all hosts upgrade together"), the RESUME STATE deploy notes = the §7.1
    runbook, the live cutover on EVERY host in one window (dry-run on each first). In `config.json`: the briefing and the
    realm guides rewritten for 2.0 (Robin's step, during the stop).

---

## 9. Decisions, holes and questions

### Decisions (Robin, 2026-10-03)
Q01 – Q28 answer the first draft, Q29 – Q39 the revision, Q40 – Q41 the final pass, Q43 a design Robin added during the
build and Q44 / Q45 / Q11b its follow-ups, Q46 the question build step 2a raised, Q47 – Q49 those of step 2b (accepted as built), Q50 – Q55 those of step 2c (accepted as built), Q56 – Q60 those of step 2d (Q56 and Q57 changed), Q61 / Q62 those of step 3, Q63 – Q65 those of step 4 (accepted as built) and Q66 – Q68 those of step 5 (open, below); GROUPS, ROLLUP and TYPES are decisions
Robin made in chat during the build; C1 / C2 are the two follow-ups Robin
confirmed in chat. A later
answer overrides an earlier one (noted in the earlier row).

| Q | Question | Decision |
|---|---|---|
| 01 | Does `--text` set the line in key mode? | **Changed.** No `@` in paths. A LEADING `@` in the text sets the node's current line (it replaces `@~`, which goes); plain text only logs; `@@` = a literal leading `@`. Terms: label = the node's name, line = its status text (§4.0, §1.3). |
| 02 | Idempotent create ignores location / label on an existing node? | **Accepted** — warning `exists` (§3.5). |
| 03 | Key charset | **Accepted** — agent-name chars minus `:`, ≤ 48, case-insensitive (§1.1). |
| 04 | Creator of a path-created node = its owner | **Accepted** — nearest agent above. Note for Robin: not purely transitional — `--path` stays after 2.0 as a shorthand (quick logging by hand), just rarer (§3.3). |
| 05 | Labels unique among siblings? | **Changed** — yes, unique. How a clash is settled was then refined by Q31 / Q32 and confirmation C2: auto-rename on create, refuse a deliberate rename / move, a dialog on the dashboard (§1.6). |
| 06 | Merge scope | **Accepted** — contexts / plan items only; unmerge by tool / script only in 2.0 (§3.6). |
| 07 | Subtree log runs per member | **Accepted** — each child shows its own whole current run (§5.3). |
| 08 | `at` on every entry | **Accepted** — the full path at the time (§2.2). |
| 09 | Rollback | **Changed** — none ("1.7 was experimental"): no state files, tail maps or newer-wins (§7). |
| 10 | Hello: keep `activity_gossip:5`, add `activity_ids:1` | Accepted at first; **superseded by Q39 / C1:** no v5 at all — 2.0 announces `activity_gossip:6` only, no dual handshake, no 2.1 step (§6.2). |
| 11 | Depth limit 6 | **Accepted** (§1.3) — for 1.7x; **revised for 2.0 by Q11b** below. |
| 11b | (Robin, 2026-10-03) Depth in 2.0 | **Changed:** HARD limit 32 — a create or move that would put any node deeper is refused `depth`; for a move the whole moved subtree counts and the error names the deepest node and the depth it would reach; the dashboard's Move-to picker greys such targets out. SOFT warning past 20 — the call succeeds with warning `deep-tree` (depth N); the Move-to dialog shows it before confirming. Long paths are shortened in the middle ("…") for display, full path on hover; the stored `at` (Q08) is capped at about 1 KB, cut in the middle. 1.7x keeps 6 (§1.3, §2.2, §3.8, §5.4). |
| 12 | Id = 16 base32 chars | **Accepted** (§1.2). |
| 13 | Pins / hidden mapped to node ids once | **Accepted, then extended (FINAL):** view state is stored per USER on the bridge and replicated across the realm; the browser's pins / hidden are imported once (§5.6). |
| 14 | Cross-session / cross-host moves | **Accepted** — later, not 2.0. |
| 15 | Moving a live agent | **Accepted** — allowed, but never to another session (§1.5). |
| 16 | Version 2.0.0, any order, all hosts within a day | **Accepted**, with Q26's change: stop all, migrate, start in any order (§7.1). |
| 17 | Agents create themselves | **Accepted** — and `--guide agent` is the agent's first report: it registers the node under its item with the line "reading the guide" (§4.4). |
| 18 | Ghosts + index files in 2.0 | **Option 1 (FINAL):** ghosts + per-day index files; removed children's entries behind a "show removed" toggle (off by default); a ghost lives until retention drops its last entry (§5.1). |
| 19 | Keep the old `--move --to`? | **Changed (FINAL):** drop ALL 1.7x command forms — positional text, `--plan`, `--move … --to`, `@` in paths, `@~`; each gets an error naming the new form (§4.5). (The v5 network format it kept for the cutover went too: Q39 / C1.) |
| 20 | A merged key resolves to B | **Accepted** — until unmerged (§3.6). |
| 21 | Side-by-side v6 directory vs in place | **Changed** — in place, each host its own directory, a backup that lives only during the migration (Q35); no `v6/`, no map reader (§7). |
| 22 | The map's grain | **Changed** — moot: a standalone migration script converts the days in place (`--dry-run`, backup, format marker); 2.0 refuses unconverted data (§7.2, §7.5). |
| 23 | Conflicted copies | **Accepted** — warn + show, never read or delete (§10). |
| 24 | Keep the legacy reader in 2.0? | **Changed** — no legacy reader after the cutover; the script converts everything (§7.3). |
| 25 | Re-upgrade after rollback: newer wins | **Changed** — no rollback, so no re-upgrade machinery. |
| 26 | Restart the Dropbox pair together? | **Changed** — stop ALL bridges on every host, migrate, then start in any order (§7.1). |
| 27 | Refuse to convert on conflicted copies? | **Accepted** — warn only (§7.2). |
| 28 | (Robin, new) Tree / log view-state rules | **Accepted into 2.0:** explicit open / close beats defaults, per user; new activity never reopens a closed node ("? N" / "N new" badges); Expand / Collapse all are choices; Reset view; choices pruned with their node; the log keeps selection + DETAILS fold, not entries; a "new since you last looked" divider; nothing steals selection or scroll (§5.6). |
| 29 | Who is "the user" of the view state? | **Changed:** the OS LOGIN of the gateway that serves the dashboard page (standing in for the person at that machine) — not `AI_BRIDGE_USER` / `PROC_USER`. A page can't reveal its OS user; the serving gateway's login is the proxy (§5.6). |
| 30 | Live vs at-load across open windows | **Accepted** — tree choices (pins, hidden, open / closed, Expand / Collapse all, Reset view, options) apply live; the selection and the DETAILS fold only at page load (§5.6). |
| 31 | Default labels and uniqueness | **Changed:** a label NEVER defaults to the key — creating a node requires one (`label-required`). On create, a clashing sibling label is AUTO-RENAMED ("notes (2)", "(3)" …) and the result reports the label it got. Duplicate keys within one creator are never accepted; keys are per creator, so two agents can each have `notes` (§1.1, §1.3, §1.6). |
| 32 | Moves / merges onto a same-label sibling (dashboard) | **Changed:** the dialog asks — MERGE them, or use a different label, pre-filled with the suggestion ("Notes (2)"); the tool / script refuse (§1.6, §5.4). |
| 33 | Finishing states and the line | **Accepted (in effect):** one rule in the bridge, no implied line; the 2.0 guide tells agents to finish with `"@<summary>"`. Revisit only if it becomes an ongoing issue (§4.0, §4.3). |
| 34 | Realm guides written for 1.7x | **Changed:** no `min_bridge` gating or fallback logic; the built-in guides and any realm guides are rewritten for 2.0 as part of the cutover (§4.3, §7.1). |
| 35 | Backup location and lifetime | **Changed:** the backup exists only DURING the migration — the script deletes it once the conversion has completed and been verified, so a crashed run can still resume from it (§7.2, §7.5). |
| 36 | The `@` escape | **Accepted** — `@@` = a literal `@`; an odd leading `@` sets the line (§4.0). |
| 37 | Labels containing `/` | **Accepted** — double-quoted path segments (`""` = `"`) (§3.3). |
| 38 | Other per-browser settings | **Accepted** — log order, Active only, Plans only into the view state as `opt:` records; the depth slider stays per browser (§5.6). |
| 39 | Starting 1.7x on converted history by mistake | **Changed:** old bridges are NOT supported; 2.0 is a clean, no-legacy cutover — no stray-v5 handling, no way back (§7.5). |
| 40 | Do agents need a label too? | **Accepted** — yes, one rule for every create: the orchestrator's `{log_snippet}` fills in `--agent <key> --label "<name>" --under <item>`, so it costs the agent nothing; a missing agent is never made as a side effect of a call aimed at another node (`unknown-agent`, §1.5, §4.3). |
| 41 | Hosts whose OS logins differ | **Accepted for 2.0** — the view state follows the serving gateway's OS login (Q29); the board head shows "view: <login>" so a mismatch is visible. A realm-level login alias map only if it bites; no per-host `view_user` setting now (§5.6). |
| 43 | (Robin, 2026-10-03, new) Report + move in one call; transient contexts | **Accepted into 2.0:** `--move-to "<path>"` / `move_to` (also per batch / stream item) applies the report, then moves the node, as one all-or-nothing change that is idempotent on retry. The path is relative to the node's current parent (`../X`, `X`) or absolute (`/…`). Missing contexts are created on the way (creator = the caller, label = the segment, key = its slug), and the node arrives LAST. The `--move` checks apply (`duplicate-label`, no cross-session, depth — ≤ 6 then, 32 since Q11b). TRANSIENT contexts (auto-created by `--move-to`, or `--transient` / `transient:true`) vanish into ghosts when their last live child leaves. They become permanent for good on a pin, a rename, their own line, or `--keep` / `keep:true`; every other context is permanent. **Correction (same day):** a move into a path whose transient context has vanished RESURRECTS that ghost (same id, key and creator, still transient) as a NEW RUN, so its log shows the current run and earlier uses sit behind "show earlier runs". It leaves the ghost table, and each bucket keeps one id for its whole life (§3.8, §3.7). |
| 44 | Grace period for emptied transient contexts? | **Changed (Robin):** an OPTIONAL parameter of `--transient`, default none — the context vanishes the moment it empties. `--transient=30s` (the `=` form, no positional ambiguity); the tool's `transient: true \| "30s"`. With `--move-to`, `--transient=30s` also applies to every destination context it auto-creates. Something arriving during the grace period keeps the context (§3.8). |
| 45 | `--move-to "X"` (one level down) is not retry-safe | **Changed (Robin):** no bare names — a bare destination is refused `bad-path`; only `../X` (from the node's current parent) and `/X` (absolute). The error suggests both forms (§3.8). Build 2a also refused relative paths whose segment count differs from their `..` count (`../A/B`, `../../X`) for the same retry reason — settled by Q46. |
| 46 | Relative `--move-to` paths other than `../X` | **FINAL (Robin), option 1:** only `/absolute` and single-step `../X` are accepted (so `../../R/X` is refused too). A refused deeper relative move (`bad-path`) answers with `suggest:"/…"`, the absolute path it would have resolved to, so the caller retries with that retry-safe form. PLUS a RESOLVE helper: `aimb-log --resolve "<relative path>" [--key X \| --path P]` (the tool `resolve`) returns the absolute path and id a relative path resolves to NOW, and changes nothing (§3.8, §4.1, §4.2). |
| 47 | (build step 2b) Type `plan` vs a plan-capable `context` | **Accepted as built:** a `plan`'s bar is ALWAYS its items ("N of M"; ordinary children never mix in, even before it has items); a `context` rolls up its items only once it holds any, else its children's bars; Show as plan sets type `plan` (§1.7, §5.7). |
| 48 | (build step 2b) A question whose text repeats its choices | **Accepted as built:** the ask succeeds with warning `choices-in-question`; it is not refused (§5.8). |
| 49 | (build step 2b) A `@` line with no `--state` on a FINISHED agent | **Accepted as built (as 1.7x):** it keeps the node's state (still done) — it does not revive the agent; reviving takes `--state running` (§4.0). |
| 50 | (build step 2c) How `--before` / `--after` find their anchor | **Accepted as built** (Robin: "use your recommendations"): a §3.2 reference; a bare key that names no sibling is also tried as the label (or agent key) of a child of the destination, as is a one-segment path; `*_id` exact (§3.2, §4.1). |
| 51 | (build step 2c) A position on an EXISTING target | **Accepted as built:** it reorders (a `rank` record + its entry); a reorder to where the node already is writes nothing (retry-safe); only a call that also gives `--under` ignores it with `exists` (§3.5, §4.1). |
| 52 | (build step 2c) The tool's form of `--first` / `--last` | **Accepted as built:** `position: "first" \| "last"` (1.7x's field; the script maps its flags onto it). |
| 53 | (build step 2c) The clash dialog's answer format | **Accepted as built:** the move / merge action carries `label` and `merges:[{ id, into_id } \| { id, label }]`; an unanswered clash → `duplicate-label`, an answer that no longer fits → `clash-changed`, both with the fresh list (§1.6, §6.3). |
| 54 | (build step 2c) The dismissal entry on the parent | **Accepted as built:** type `event`, `dismiss:true`, `of` = the removed id, state = the dismissed node's, `at` = the PARENT's path; the session root's on itself (§2.1, §2.2). |
| 55 | (build step 2c) Message types of the dashboard's entries | **Accepted as built:** a state tick and a dashboard message are `note` entries carrying `act`; only structural changes are `event` (§1.7). |
| 56 | (build step 2d) What a test-run row shows | **Changed (Robin):** ONE bar of its tests — passed (green) vs failed (red) vs total — with the pass / fail counts in its tooltip, replacing the items bar + counts text (`testBar2`, built in step 3; §1.7, §5.7). Its items bar stays what it adds to its parent. |
| 57 | (build step 2d) A test-result vs the test's state | **Changed (Robin, revised with Q61 / Q62: "state is progress, result is outcome"):** logging a test-result means the test FINISHED — it sets the state to DONE for pass, fail and skip; the result is the outcome (colour, Passed / Failed bucket, `testBar2`); a restart (todo / running) still clears the old result; the `result-state` warning is dropped; `failed` stays for non-test work (built in step 3; §1.7, §5.7). |
| 58 | (build step 2d) The test-result fields | **Accepted as built:** `result` (required), `checks`, `failed` (≤ `checks`), `duration`; other information, such as the names of the failing checks, goes in `--details` (§1.7). |
| 59 | (build step 2d) A test-run's tests and plan | **Accepted as built:** its items are the plan items below it through context buckets and nested runs; any other context there with a test-result is a test too; its plan also ends on a `failed` line; an ended run is evicted whole (§5.7). |
| 60 | (build step 2d) The per-type menus | **Accepted as built:** the registry lists the model's actions only; Robin gives feedback once he uses the menus; Kick comes after 2.0 (§1.7, §5.4). |
| 61 | (build step 3) A test-result `skip` on a test that is not a plan item | **Option C (Robin):** any CONTEXT that receives a test-result counts as a test; a skip works on it whether or not it is a plan item (no `not-a-plan-item` refusal — the state is just done). An agent or the session can't take a test-result at all (`not-a-test`: an agent runs tests, it isn't one) (§1.7). |
| 62 | (build step 3) A test-result whose call also gives a `--state` | **Decided (Robin):** `--state done` with a result is consistent and accepted; a result with `--state` running / todo / blocked / abandoned (or failed / skipped) is refused `bad-state` — a test can't have an outcome while unfinished; the error says a result means done (§1.7). |
| 63 | (build step 4) An empty grouping context (no line, no children) no 1.7x record has named for longer than the replay window | **Accepted as built (Robin):** Dropped by the conversion at the next day start (a `remove`, why expire) — the rule a 1.7x restart applies (its replay never rebuilds it); 2.0 would keep it for good. `forget:false` keeps the live tree instead (§8 step 4). |
| 64 | (build step 4) A 1.7x question that also holds children (items added under it after it was asked) | **Accepted as built (Robin):** It stays type `question`: answerable, one item of its parent's plan; its children stay under it but are no plan in 2.0 after the cutover (no plan end / expiry of their own, no protection for their agent). The conversion follows 1.7x's rules up to the cutover (§8 step 4). |
| 65 | (build step 4) The message type of converted 1.7x move / placement entries | **Accepted as built (Robin):** `note` with their `act` (move / reorder), as 1.7x applied them (the session's own move refreshed its activity; any made the node non-implicit) — not `event` as 2.0 writes them (Q55); dismissals are events (Q54) (§8 step 4). |
| TIME | (Robin, 2026-10-03) Time in the logs | **Accepted into 2.0 (built in step 3):** a node times each attempt from running to done / failed / skipped / abandoned (`took`, on the node and the ending entry); a reopen / restart is a new attempt (latest `took` + `took_total` / `attempts`); no start → no took; a test-result's duration is its took; plans, test runs and agents get their own start-to-end time; it survives checkpoints and the replay and shows in `displayOf2` ("took 4m 12s") (§2.2, §5.7). |
| GROUPS | (Robin, 2026-10-03, new) Lists that are not plans | **Accepted into 2.0 (step 2b):** a context can be a GROUP — a list, not a plan: no bar, no plan-end, nothing added to its parent's rollup; where the bar would be, an optional COUNT ("4 items" / "3 open · 1 done"; abandoned and hidden items not counted). Set at creation (`--group` / `group:true`) or toggled from the dashboard (Show as group / Show as plan); its items keep their states. Candidates: Potential changes, Planned changes, Deployed releases, Questions; Next release stays a plan (§1.3, §2.1, §5.7). *The flag was then folded into TYPES: a group is `--context-type=group`.* |
| TYPES | (Robin, 2026-10-03, "typed nodes and entries") | **Accepted into 2.0:** every node has a `type` from a small built-in REGISTRY held as data — per type its allowed fields, display (glyph, what shows in place of a bar), rollup behaviour, allowed children and menu actions (the slot the context-aware menu, #92, folds into). Types: `context` (the default, plan-capable), `plan`, `group`, `agent`, `question`, and `test-run` (reserved; built in step 2d). The flag is `--context-type=<type>` (tool `context_type`; kebab-case flag, values case-insensitive); it REPLACES `--group` / `group:true`; a question is a node of type `question`. ENTRIES are typed too: `--message-type=<type>` (tool `message_type`; default `note`), each type declaring typed fields that are validated so the bridge can count them (later: `--message-type=test-result --result pass --checks 22 --duration 4.1s`); `--data` stays free-form. Answers are `answer` entries; the node state still drives plans and progress. 2b builds the registries, the mechanism and the types questions need (`note`, `question`, `answer`, `withdrawal`, `expiry`, + `event` for structural entries); a new step 2d builds `test-run` + `test-result`; #81's test reporter is the first user of `test-run`. QUESTIONS read naturally: state the question, its options listed below it as the answers; the text never restates the options; choices stay structured (`--choice`) — in §5.8, the Answer dialog (§5.4) and the agent guide (§4.3) (§1.7, §2, §4, §5.7, §5.8, §8). |
| ROLLUP | (Robin, 2026-10-03) A plan node's bar beside finished helpers | **Changed — reverses 6c decision 7 ("ordinary children win"):** a node holding plan items rolls up ONLY its items ("N of M"); helper agents and contexts keep their own bars on their own rows; a node with no plan items rolls up as before. Shipped for 1.7x as v1.75.1 (`rollup` + the dashboard's `rollKids`); 2.0 ports the same rule in step 2b (§5.7). |
| C1 | (confirmation) Drop the v5 network projection? | **Yes** — 2.0 speaks only 2.0; no `activity_gossip:5` / `activity_ids:1` dual handshake, no 2.1 cleanup step; every host is upgraded together with the stop-all runbook (§6, §7.1). |
| C2 | (confirmation) Duplicate labels, all cases | **Yes** — auto-rename on CREATE; refuse a deliberate rename / move through the tool or script (`duplicate-label`); the dashboard's clash dialog offers merge or a suggested label — "see how it plays out" (§1.6). |

### Holes found in the #88 design (and the fixes above)
- **H1** `:` is legal in agent names today (`SEGMENT`), so `fix-79:docs` is ambiguous → keys exclude `:` (§1.1).
- **H2** "registering an existing key updates it" lets a retry or a replayed prompt undo a dashboard move / rename → create
  attributes apply only at creation; changes are explicit verbs (§3.5).
- **H3** the PEER_HELLO check is an equality on `activity_gossip`, so announcing 6 cuts every 1.7x peer off activity → the
  first revision kept 5 plus `activity_ids:1` for a cutover window; with Q39 / C1 there is no window: every host upgrades
  together and 2.0 announces 6 (§6.2).
- **H4** "a path creates a node whose key is the last segment": segments have spaces / `#` / `(`, and a path caller reports
  as the session, so whose key? → slug + creator = owner (§1.1, §3.4).
- **H5** a log "computed from the current tree" loses removed children's history → ghosts (§5.1); this also closes #76.
- **H6** merging agents (key namespaces) and merging into one's own descendant are undefined → refused (§3.6).
- **H7** "hash(host, session, path)" for legacy ids: which path of a moved node? → the final path; reused paths share the id
  as earlier runs (§7.3).
- **H8** "a per-host index (id → day files)": today's `actIndex` is entry-id → offset, in memory, capped → persisted per-day
  index files (§2.4).
- **H9** free-text labels can't always be v5 path segments → moot since Q39 / C1 (no v5 projection); depth: Q11b (32).
- **H10** the tool result's `id` is already the ENTRY id → the node id goes in `node.id` (§4.2).
- **H11** `--item <key> "<label>"` vs the one-value `--item "A"` → the parse rule in §4.1.
- **H12** (revised) the persistence folder is Dropbox-shared (ROBIN-Z790 + LITTLE-001) and the project's rule was "no
  file-rename migration" (issues.md #47) because a 1.7x reader might read mid-change → the in-place rewrite happens only with
  EVERY bridge stopped, by the one host that owns the directory, from a pristine backup (§7.2, §7.4).
- **H13** (revised) the Dropbox pair shares `src/`: a 1.7x process restarted after the update would run 2.0 code on v5 data →
  the 2.0 start check refuses it with the fix (§7.5). The first draft's dashboard path fallback is no longer needed (§5.4).
- **H14** (new) with no `@`, a path segment no longer says agent or context → labels unique across both kinds (§1.6), label
  before agent key in matching (§3.3), and the migration relabels the one v5 duplicate (§7.3).
- **H15** (new) the dashboard has no per-person identity: actions are attributed to the gateway's `PROC_USER` → Q29: the
  view state belongs to the serving gateway's OS login (§5.6).
- **H16** (new) a closed node's "N new" badge needs a baseline → the close record stores the subtree count and open questions
  at close (§5.6).
- **H17** (new) "Expand all" as one record per row would write hundreds of replicated records and freeze new nodes open → one
  `all` record that covers only nodes created before it (§5.6).
- **H18** (new) `{log_snippet}` already shrank to one line in 1.73 (#89); the first draft's 7-line snippet belongs in
  `agentGuide` now, and realm guides written for 1.7x would teach removed forms → all guides rewritten at the cutover (§4.3,
  Q34).
- **H19** (final pass) an auto-renamed node ("notes (2)") would raise `exists` on every later call of a snippet that repeats
  `--label "notes"` → the create keeps `asked`, and a `--label` equal to it is no difference (§2.1, §3.5).
- **H20** (final pass) with a required label, a missing agent can no longer be created as a side effect of a call aimed at
  another node (it would have no label) → only a call that targets the agent creates it; earlier chain steps must exist
  (§1.5) — Q40 (accepted).
- **H21** (final pass) the OS login is per machine: if a host's gateway runs under another login (a service account, a
  Linux user), its "robin" is a different user and the view does not follow him there → shown in the board head; Q41
  (accepted for 2.0).

### Risks
- The replay and the conversion are the risky parts; both get seeded fuzzing against a ground truth (chronological apply; the
  frozen 1.74 library), and the migration test converts days written by a real 1.74 gateway. There is no mixed-version live
  test any more: 2.0 never meets 1.7x.
- A conversion fault is caught by the script's own verification while the backup still exists (§7.2: exit 3, backup kept,
  re-run). Once verified, the backup is gone (Q35): a fault found later is fixed forward in 2.0 — the converted days are
  still a complete record — or from a copy a person took before step 3 (on the Dropbox pair, Dropbox's version history
  also holds the v5 files for a while). A host that refuses to start is the visible failure mode, not a silently empty board.
- **All hosts must be upgraded together.** The cutover needs every bridge down at once — a few minutes of no mesh; messages
  are parked as usual (durable mailboxes). A host that is missed stays off the shared board (no activity either way, §6.2)
  until it is upgraded; nothing degrades gracefully, by design (Q39).
- Duplicate host names on two machines would make two writers of one host directory — today's files have the same risk
  (#70's duplicate-hostname WARN); §10's conflicted-copy check makes it visible.
- Bigger dashboard change than #82 (ids + the view state); the id-keyed units keep the delta machinery as is.
- Labels: a create that clashes is auto-renamed ("notes (2)"), which a caller may not notice — the result and the guide say
  so, and the board shows it; a deliberate rename / move that clashes is refused. Robin: "see how it plays out" (C2).
- The required label adds one flag to every first call (`--label`); a briefing that forgets it gets `label-required` on the
  agent's first report — loud, and the guide names the fix.

### Open questions
Q40 – Q65, Q11b, GROUPS, ROLLUP, TYPES and TIME are decided (Decisions above). Open — step 5's, each built as described
(posted on the board under Questions / "Step 5 (Q66–Q68)"):
- **Q66** How the migration script tells that a bridge is running on this host: there is no lock, pid or port file, so it
  makes a TCP connect to the gateway's port and hangs up without sending a byte (the gateway ignores such a connection).
- **Q67** The `--backup <dir>` option of §7.2: not built — the backup always lives at `persistence/activity-v5-backup/<host>/`,
  where the 2.0 gateway's start check looks for an unfinished migration.
- **Q68** What a failed migration run leaves: the v5 files restored and the backup removed (the directory exactly as before,
  exit 3) — §7.2 had the backup kept and the directory half-converted until the next run.

---

## 10. Shared-folder (Dropbox) rules

ROBIN-Z790 and LITTLE-001 share the WHOLE repo folder through Dropbox — `src/` (code, `src/config.json`), the `persistence/`
store and so every `activity/<host>/` directory. The Mac and phub-lnx-01 have their own checkouts and configs. Dropbox gives no
locks and eventual consistency, and it makes a "conflicted copy" when two machines change one file. The persistence layout is
conflict-free because no two machines ever write one file (architecture.md §12 "The substrate": its four invariants), and the
shared config is read-only to the bridge (architecture.md "Policy file discipline"). #88 keeps both.

1. **Per-host writes only.** Every file #88 writes lives under the WRITING host's own name and only that host writes it: its
   day files and index files (`activity/<lslug(host)>/`), its marker (`activity/<host>/format.json`), its backup
   (`activity-v5-backup/<host>/`, which exists only while the migration runs) and its view-state copy (`views/<lslug(host)>.json`). Node records and aliases live inside
   the host's own day files and `cf`s; the ghost and alias tables are in-memory, rebuilt from those files. No host ever writes
   another host's file; reading another host's `views/*.json` at rehydrate is read-only.
2. **Atomic always.** Day files are appended (single writer, as today, with the in-place rewrite of the trailing `rep` line).
   Every other file is written WHOLE through the facet's `writeAtomic` (`*.tmp` then rename of that file; readers skip `.tmp`).
3. **The migration rewrites day files in place only while every bridge is stopped**, only in the host's own directory, and
   only from the pristine backup (§7.2, §7.4). Retention deletes old days as today (by date, own directory only).
4. **Each host converts only its own directory**; two hosts converting at once write disjoint directories, and every id
   hashes the host (§1.2), so ids never collide across hosts.
5. **Nothing in #88 writes `config.json`.** The bridge never writes the shared `src/config.json` (unchanged policy); the
   migration script only READS it, to find `persistence.dir`. #88's text changes (the guides, `{log_snippet}`,
   `{log_tool_hint}`, the tool descriptions) are code; the briefing change in the realm reminders ships in
   `config.example.json`, and publishing it — and rewriting any realm guide for 2.0 (Q34, runbook step 2) — into the shared
   `config.json` stays Robin's manual step, as every release. No new config key is needed.
6. **Conflicted copies are detected and ignored (Q23, Q27).**
   - Dropbox names them like `2026-10-02 (LITTLE-001's conflicted copy 2026-10-03).jsonl` (also "Case Conflict" variants) —
     the original name with a parenthesised note before the extension.
   - **Ignored:** every reader matches EXACT names: `^\d{4}-\d{2}-\d{2}\.jsonl$` (today's `DAY_RE` filter in `days()` already
     rejects such a name), `^\d{4}-\d{2}-\d{2}\.idx\.json$`, `^format\.json$`, and in `views/` `^[a-z0-9._-]+\.json$`.
     Anything else is never read.
   - **Detected:** at gateway start and at each day rollover the gateway lists its own `activity/<host>/` (it already does, for
     `days()`) and `views/`; any name containing "conflicted copy" or "Case Conflict" — or any non-`.tmp` name matching none of
     the patterns — is logged once as a WARN ("activity: Dropbox conflicted copy '…' in activity/ROBIN-Z790 — two machines may
     be writing as host ROBIN-Z790 (a duplicate hostname?); it is ignored — check it and delete it by hand") and listed in the
     board head (`fs_warnings`). The migration script reports them the same way. Never deleted automatically: it may hold the
     only copy of some records.
   - With single writers a conflicted copy should never appear; one means two machines wrote as one host (duplicate
     hostnames — #70 already WARNs on those) or a hand edit. Other hosts' activity directories are not checked.
7. **Shared code:** both hosts run the same `src/` files. Under the cutover every bridge is stopped before the update, so no
   1.7x process meets 2.0 code; a 1.7x process restarted by accident after the update runs 2.0 code and is refused by the
   start check until its host is converted (§7.5).
