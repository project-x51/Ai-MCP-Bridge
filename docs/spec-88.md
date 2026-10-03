# #88 spec (revised with Robin's answers) — stable node identity, v2.0

Status: REVISED, 2026-10-03. Robin has answered all 28 open questions of the first draft; his decisions are in §9
"Decisions (Robin, 2026-10-03)", and the new questions this revision raises are Q29 – Q39 (§9). Nothing is built. The build
(§8) starts once the new questions are answered. The agreed design is in `docs/issues.md` "#88"; this spec makes it exact.
Code references are to v1.72.0 (`src/lib/activity.js` unless another file is named); the guide references (#89) are to v1.74.0.

**One paragraph.** Today a node's PATH is its key (`newNode`: `key = lc(path)`), so a move rewrites history: `applyMove` /
`rekeySubtree` re-key memory, the replay remaps every older record through later moves (`createReplay`: `remapSegs`, `foreign`,
`goneAt`, `sealRuns`, `movedAt`), and log paging follows `moved_from` aliases (`nodeAliases`, `matchAlias`). v2.0 gives every
node a stable INTERNAL ID, minted once from (owner host, session, creator, key). Label, parent, rank and kind become attributes
set by small NODE RECORDS; log entries, checkpoints, gossip and the dashboard name the id. A move or rename is one record and
nothing is rewritten; a node's log is "entries whose id is in this subtree now". Paths stay as a shorthand (no `@` any more)
that resolves against the current tree, then aliases, then creates. **2.0 is a clean cutover:** every bridge on every host
stops, a standalone script converts each host's own history in place (with a one-off backup), and the bridges start again in
any order. A 2.0 bridge refuses to start on unconverted history. The 1.7x command forms are gone from the API (an old form gets
an error naming the new one); only the v5 network projection stays, for the cutover window, so a host that is upgraded late
still sees and is seen.

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
  `spec-89:docs`).
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
  migration gives the same ids; during the cutover window a 2.0 host derives the same legacy id for a late 1.7x host's node
  (from its v5 slice, §6.2) as that host will get when it is converted, so the viewer's pins / open state survive the peer's
  upgrade (§5.6).
- **Collisions:** at 80 bits and ≤ 10⁶ nodes per host over retention, p ≈ 4·10⁻¹³. A mint that hits a DIFFERENT live node's
  id (creator / key differ) is refused `id-collision` and logged; nothing silently merges.
- Prototyped (scratch, Node's `crypto`): Bridget's root on ROBIN-Z790 = `mkjhhu3kyjf2gbcv`, `:spec-88` = `uytyq4e6wsmtqsfq`,
  `spec-88:docs` = `rtam3yvgwkzx5zbp` (the same for any letter case of host / session / chain / key).

### 1.3 Attributes (all set by node records, §2.1)
| Attribute | Rule |
|---|---|
| `label` | the node's NAME, what is shown; 1 – 60 code points, no control characters (today's context-name rule `normContextName` minus the `/` and `"` bans). Default: the key (agents) / the key or the path segment (contexts). **Unique among its siblings** (§1.6). |
| `parent` | an id in the same session on the same host (cross-session moves: later, Q14). Never the node itself or below it. |
| `rank` | #82's fractional base-36 rank, unchanged (`rankBetween`, `placeRanks`, `derivedRank`, `siblingCmp`): stored only when placed, else derived from created_at + plan_ix. |
| `kind` | fixed at creation: `agent` or `context`. Never changes. |
| `plan` | a context becomes a PLAN ITEM for good (6b) — the one kind change, its own record (`op:"item"`). |
| question | unchanged from #85: a property of the current line (`line.question`), not a kind. |
| `merged_into` | §3.6. |

Depth stays ≤ 6 below the session (`ACTIVITY_LIMITS.depth`), checked on create and move (Q11).

**Terms, used precisely from here on.** The **label** is the node's name (what the tree shows). The **current line** (or just
"line") is its status text — the one-line "what it is doing now", with its state, bar and ETA. An **entry** is one line of the
node's log. A report LOGS an entry; it SETS the line only when asked to (§4.0).

### 1.4 Kinds
- **session** — the root node of a (session, host); id = mint(host, session, "", ""). Agent-like lifecycle, as today.
- **agent** — an actor (start / finish / stale / gone). An agent is created by its creator (the session, or another agent) and
  is ALSO a creator: its key chain is how a script names it (`--agent spec-88`). Agents create their own node (Q17, §4.4).
- **context** — a piece of work (line, bar, ETA). **Plan item** = a context with `plan` (6b). **Question** = a context whose
  line carries `question` (#85).
- Ownership (who goes stale for whom) stays TREE-derived: `ownerOf` = the nearest agent at or above (6a, Q04). The creator is a
  namespace, not an owner: `spec-88:docs` placed under the session's `:88` is owned by the session for staleness. Activity
  from a call refreshes target..owner as today PLUS the calling agent (§4.1 `--agent`), which today's path-only model can't name.

### 1.5 How agents and sessions are identified
- A **session** is unchanged: realm + project + user + session name (+ host for ownership). The script's `--session` /
  `--project` / `--user`, the tool's `as`.
- An **agent** is named by its key chain from the session: `--agent spec-88`, `--agent spec-88/research`. A chain step that
  doesn't exist yet is CREATED (an agent, label = key, under its creator unless `--under` places it — §4.1). A step that names
  a context → `not-an-agent`.
- Migrated agents (§7.3) get creator = their OWNER at the time (§3.4), key = their v5 segment — so `--agent a/b` names the
  node the old `--agent a/b` path named, and it keeps naming it after a move.
- **Moving a running agent** is allowed (Q15) — within its session only. Its next report (`--agent` / `--key`) lands in the
  moved node. A move to another session is refused `cross-session` even once cross-session moves of contexts arrive (Q14):
  an agent's identity includes its session.

### 1.6 Labels are unique among siblings (Q05)
- Two children of one parent never have the same label, compared like keys (NFC, case-insensitive). Agents and contexts share
  this (a path segment no longer says which kind it means, §3.3).
- A **create**, **rename** (`--rename`, Rename…), **move** (`--move`, drag-and-drop, Move to…), **merge** (A's children land
  under B) or **unmerge** (A goes back to its old parent) that would give a node a label one of its new siblings already has is
  REFUSED `duplicate-label`, naming the sibling (`{label, key, id}`) and suggesting `--label` / `--rename`. Nothing is
  written. Q31 / Q32 ask about default labels and the dashboard dialogs.
- Not counted: GHOSTS (removed nodes, §5.1) and hidden MERGED nodes (§3.6). A label freed by a removal can be used again.
- Path resolution finds an existing child by label (§3.3), so a path never collides with itself: a second `--path "88/notes"`
  reports into the first `notes`.
- The migration makes existing trees conform (§7.3): the one case v5 allowed — an agent `x` and a context `@x` under one
  parent — gets the younger node relabelled `x (2)`.

---

## 2. Record formats (day files, format v6)

Day files, retention, one writer per host, the backwards reader and the cp / rep mechanism are unchanged
(`facets/persistence/file.js` `activity.*`, `bridge.mjs` `persistActivity` / `writeCheckpoints`). v6 day files are the SAME
files as today — `activity/<host>/YYYY-MM-DD.jsonl` — converted in place by the migration (§7). Every v6 record keeps the
identity fields today's records carry (`origin realm session project user host s0`) so a file stays self-describing; they are
shown as `…ident` below. The bridge's `RECORD_FORMATS` becomes {6}: v2 – v5 records are read ONLY by the migration script's
library (§7.3); a v2 – v5 record met by the 2.0 bridge is skipped with one WARN per file (§7.5 — someone ran a 1.7x bridge
on converted history).

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
  §5.3). A create for a key whose node is a GHOST (§5.1) re-uses its id and starts a new run.
- `move`: new `p` (+ the rank it got there). `label`, `rank`, `item`: the one attribute.
- `merge`: A (`n`) into B (`into`); `from` = A's parent then (for an unmerge); `kids` = A's children at that moment, which
  move under B (no separate move records).
- `remove`: the node and its subtree leave memory (`why`: dismiss | evict). Replaces 6d's `dismiss:true` replay rule and the
  entry's `evicted:[paths]`. The 6d dismissal ENTRY ("dismissed from the board by …") is still written, on the PARENT (§2.2).
  Expiry writes nothing (as today; the replay re-runs `expire`).

### 2.2 Entries — keyed by id
```json
{"v":6,"id":"act_9164_murlfkk7-3gk","ts":1790984100000,"n":"rtam3yvgwkzx5zbp","current":true,"text":"Writing the README section","state":"running","at":"Next release/#88/Write the docs",…ident,"details":null,"data":null}
```
- Today's entry fields (`apply` → `res.entry`) MINUS `path`, `new_from`, `evicted`, `moved_from`, `plan_item` / `plan_ix`
  (structure moved to node records) PLUS `n` (the node id) and `at`.
- **`at` = the node's full display path when written** (Q08). The log panel shows it on hover when it differs from the node's
  path now ("logged as #88/Docs"); it stays greppable. ~60 – 150 bytes per entry.
- `current:true` marks an entry that SET the line (§4.0); `false` = logged only. Kept: `current text state progress eta_at
  stale_after_ms details data by act line_text line_by question plan_end finished_at`, and `dismiss:true` on the parent-log
  dismissal entry (`n` = the PARENT, `of` = the removed id). `rank` leaves entries: a placement writes a `rank` node record
  plus its "placed before Build" entry.
- A move / rename / merge also writes a normal ENTRY on the node ("moved by robin via dashboard (ROBIN-Z790) from #88 to
  Later", `act`) so the log tells the story; the node record carries the structure. Two lines, one call.

### 2.3 Checkpoints and carry-forward
- **cp** (`checkpointOf`): `path` → `n`. `{"v":6,"kind":"cp","k":17,"ts":…,"n":"rtam3yvgwkzx5zbp","current":{…},"state":"running","progress":{…},"eta_at":null,"created_at":…,"rank":null,…ident}`.
  `rep` lines unchanged (`{"v":6,"rep":[17,18],"n":245,"since":…,"last":…}` — keys per file, as today; a rep's `n` is its
  repeat COUNT, as today, never a node id — `recordKind` tells a rep by its `rep` array).
- **cf** (`planCarryForward` / `carryOf`) carries STRUCTURE too, because a node's `create` may be older than the replay window:
  `{"v":6,"kind":"cf","ts":…,"n":…,"c":…,"key":"docs","nk":"context","label":"Write the README","p":…,"rank":"0fi","plan_item":true,"plan_ix":3,
  "aliases":[{"path":"next release/#88/write the docs","at":1790986000000}],"merged_into":null,"current":{…},"state":…,"progress":…,"eta_at":…,"created_at":…,"last_activity":…,"stale_after_ms":null,"implicit":false,"log_n":12,"run_at":1790984000000,…ident}`.
- **What is carried** (`carryDue`): every node whose state OR structure (its newest create / move / label / rank / item record)
  would fall out of the window before the next rollover, every open plan item, and every ANCESTOR of a carried node (parents
  first, as today). `run_at` = when its current run began (its create's ts), so the run boundary survives (§5.3). `pt` gains
  `s` (structure persisted).
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
  day's node records, compact. Today's file has the same map in memory, updated on every append.
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
- Looks in YOUR scope only. Found → that node. Not found → CREATED there (a context; `--under` / `--label` / a position apply,
  §3.5). Never looks in another scope: an agent's `--key docs` never lands in the session's `docs`.

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
   label matches → an AGENT child whose key equals it (agents created by `--agent x` have label = key anyway). A question
   child also matches by its key (`?3`).
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
  replayed after a compaction, undo a human's dashboard move or rename). Changes are explicit verbs: `--move`, `--rename`,
  a position alone (reorder: no `--under`, existing node — as #82).
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
  A or B an agent (an agent is a key namespace), the session root, A holding an OPEN question. Refused `duplicate-label` when
  one of A's children has the label of one of B's (§1.6; the error lists every clash — Q32).
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
  line text in place — Q33 asks whether finishing states should imply a line.
- The same rule for the `log` tool's `text`, batch items and `--stream` lines.
- PowerShell note for the guide: always quote the text (`"@Writing the docs"`) — an unquoted `@word` is a splat there.

### 4.1 Script flags (`tools/aimb-log.mjs`)
| Flag | Meaning |
|---|---|
| `--agent <chain>` | the agent you report as (your scope); created if new (§1.5) |
| `--key <k>` | your node (§3.1); created if new (a context) |
| `--id <id>` | a node by internal id (the dashboard's copied command) |
| `--path "<label>/<label>"` | the shorthand (§3.3); no `@` |
| `--under <ref>` | where a NEW target goes (default: under the scope — the session root or your agent node) |
| `--label "<text>"` | a NEW target's label (default: the key) |
| `--item <k> "<label>"` | a ☐ plan item under the target, repeatable, in order; `--item "<label>"` (one value) = label only, key = slug, matched by LABEL under the target first (today's re-plan rule) |
| `--before <ref>` / `--after <ref>` / `--first` / `--last` | place new items or a new target; on an existing target alone = reorder (#82) |
| `--move <ref>` | move the TARGET under `<ref>` (+ a position) |
| `--rename "<label>"` | the target's new label (§1.6) |
| `--merge <ref>` / `--unmerge` | §3.6 |
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
  `before` / `after` / `*_id`, `move` / `move_id`, `rename`, `merge` / `merge_id`, `unmerge`, `text` (§4.0), `guide`. Batch
  items take the same; `agent` is a batch default. The tool's `plan` field is the `--item` list, kept (it is the tool's only
  form for items).
- **Results always name the node:** `{ ok, id:<ENTRY id, as today>, ts, node:{ id, key, scope:"spec-88", label, path, kind,
  created? }, state, current, line:<true when the line was set>, logged, stale_at, … }`; `plan:[{ key, id, label, path,
  created, plan_item, state, warning? }]`; `moved:{ from, to, parent_id }`, `merged:{ into_id, path }`, `warnings` (`exists`,
  `exists-elsewhere`, `alias`, `merged`). The top-level `id` stays the entry id (hole H10) — the node id is `node.id`.
- `activity` board nodes gain `id`, `parent_id`, `key`, `scope`, `label`; `path` (computed now, no `@`), `parent` (path) and
  `kind` stay; `log:{ id | path …, earlier?, removed? }`; `entry:{ id }` unchanged. The logger WS `wait_answer` takes `node_id`
  (its `path` form is the 2.0 path).

### 4.3 `{log_snippet}` and the guides
- `{log_snippet}` keeps its 1.73 shape — the command + ONE line — with the 2.0 command: `Report your status with: "<node>"
  "<script>" --session "S" --project "P" [--token-file "…"] --agent <your-key> --under <item-key>` and "First run it with
  --guide agent in place of --text: that puts you on the board and prints the rules." The orchestrator fills `--agent` and
  `--under`.
- `agentGuide` (`lib/log-snippet.js`) gets the 2.0 rules (each line ≤ 110 characters):
```
- --key <k> names YOUR node: made on first use (--under <k> sets where, --label "…" its name); then --key <k>.
- --text "@<what>" sets the node's line; plain --text "…" only logs. No --key = your own node.
- Make your checklist first: --item <k> "<label>" (repeat it); tick one with --key <k> --done.
- Report at milestones only (calls cost tokens); add --stale-after 60m before a long silent step.
- A used key reopens its node: new work gets a new key (docs-2). Keys: letters, digits and _ . # + -
- Finish with --state done --text "@<summary>" (or failed). Never put secrets in status text.
- Need a decision? --ask "…" --choice "A" --choice "B" --wait 30m waits for the answer (exit 0 = answered).
```
  `sessionGuide` gets the session's version (its own `--key` items; "give each agent `--agent <key> --under <item key>`");
  `{log_tool_hint}` the same rules in tool form (`key:"…"`, `plan:[{key, label}]`, `text:"@…"`). The realm reminders'
  orchestrator briefing ships in `config.example.json` (Robin publishes it, §10).
- **Realm-published guides (#89 part 2)** written for 1.7x teach removed forms: a 2.0 gateway serves a realm guide only when
  its `min_bridge` is ≥ 2.0.0, else `text:null` and the script prints its built-in text (Q34).

### 4.4 `--guide agent` is the agent's first report (Q17)
- `aimb-log --session S --project P --agent <key> --under <item> --guide agent` prints the guide AND, when the agent node
  does not exist yet, creates it under `<item>` (label = `--label` or the key) with state running and the line "reading the
  guide" — so an agent appears on the board the moment it starts, with no extra call.
- The node already exists (a re-read mid-work, a retry) → print only, nothing written (result line `(already on the board as
  …)`), so a re-read never clobbers a running line (the spirit of §3.5: "location only at creation").
- A refused create (`duplicate-label`, `unknown-node` for `--under`) prints the guide, then the error, exit 64 — the agent
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
  Unmerge: not on the dashboard in 2.0 (Q06). A move or merge refused `duplicate-label` shows the clash in the dialog (Q32).
- Log entries show `at` on hover when it differs from the node's path now. Copy command = `--agent <scope> --key <key>` (or
  `--id <id>` when the node has no key path).
- The view state (pins, hidden, open / closed, selection, DETAILS fold, last seen) is per USER on the bridge (§5.6), no longer
  per browser.
- No path fallback in the page: after the cutover every gateway that serves a dashboard is 2.0, and a late 1.7x host's units
  reach a 2.0 page as id-carrying units (§6.2).

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

**Record and order (the #62 shape):** `{ realm, user, k, v, ts, origin }` — `user` = lc(the dashboard's user, Q29), `ts` = ms,
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
- How a page applies a remote change: pins, hidden, open / closed, `all`, `reset` and options apply LIVE; `sel` and
  `fold:details` apply only at page load, so two open windows don't steal each other's selection (Q30); `seen:` is merged
  silently (the divider moves at the next refresh).
- One-time import (Q13): on its first 2.0 load the page maps its `localStorage` `aimb.act.pins` / `aimb.act.hidden` (path-keyed
  unit ids) to node ids by the units' paths, sends them as `view_set`, then deletes those keys (try/catch throughout).

**Replication between gateways:**
- Capability `view_state:1` in `PEER_HELLO`; nothing is sent to a link without it (a late 1.7x host keeps its own browser-only
  pins).
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

---

## 6. Gossip and compatibility

### 6.1 The v6 slice
- `ACTIVITY_SLICE` body `v:6`: one unit per node (`snapNode`), `path` replaced by `id`, `p` (parent id), `c` (creator id),
  `key`, `label`, `nk`; everything else as v5 (`current` without details/data, `progress`, `rank`, `plan_item`, `log_n`,
  `plan_end` …). No path in the unit: a rename or move then changes ONE unit, not every descendant's. The root unit carries
  `root:true`. Merged nodes are not sent. `remove:[{…session, id}]` (a node and its subtree, as today).
- Deltas, epochs, the byte cap, newest-active first, the 1 frame/s rule: unchanged (`planSlice` / `applySlice`).

### 6.2 The v5 projection — for the cutover window only (Q10)
After the cutover every host runs 2.0. A host upgraded LATE (its own checkout — the Mac, phub-lnx-01 — or one that was missed)
still runs 1.7x for a while; for that window only, a 2.0 gateway keeps speaking v5 to it. All of §6.2 – §6.5 is deleted in
2.1, once every host runs ≥ 2.0.
- A link to a peer WITHOUT `activity_ids` gets v5 slices computed from the current tree (`snapNode` v5 shape): `path` = each
  node's v5 PROJECTION — agent segment = its KEY (keys are valid agent segments), context segment = `@` + its label sanitised
  to v5 rules (`/` → `∕`, `"` → `”`, control → space, > 60 → cut). Two siblings whose projections collide after sanitising →
  ` (2)`, ` (3)` by created order. Hidden merged nodes are left out.
- A v5 slice FROM an old host is converted on receipt: id = legacy id (§1.2) of each path, parent id from the parent path,
  key = slug(segment), label = the segment without `@`. Stable while the path is; a move there is remove + add, as today. The
  ids equal what that host's own migration will mint (final path = its path now), so view-state records survive its upgrade.

### 6.3 What an old host sees
- **Move / rename** on a 2.0 host: the node's v5 path changes → the old host gets a removal at the old path + a new node at the
  new path (`planSlice`'s per-unit diff does it) — the same as an old host's own moves look to it today.
- **Merge:** A disappears; B's counts / log grow.
- **History:** a 1.7x dashboard asks `ACTIVITY_REQ {op:"log", q:{path…}}` with a v5 path → the 2.0 owner maps it through its
  projection (v5 path → id) and serves the id-based page; entries carry `path` = the node's projected path now and `rel` (v5
  shape). `entry:{id}`: entry ids are unchanged.
- **Actions from a 1.7x dashboard** (`ACTIVITY_ACT` with a v5 `path`, `args.to` a path, `before` / `after` names): the 2.0
  owner maps them to ids through the same projection — they keep working for the window. (This is the network protocol of a
  peer, not the API: §4.5's `legacy-form` applies to the tool and the script.)

### 6.4 Capability flags (Q10)
- **Hole H3:** a 1.7x peer adopts activity only when `hello.activity_gossip === 5` (`bridge.mjs` `actLinkInit`: `cap: …
  hello.activity_gossip === Act.ACTIVITY_FORMAT`). A 2.0 hello saying `activity_gossip:6` would cut every old peer off. So the
  2.0 `peerHello` KEEPS `activity_gossip:5` (plus `activity_plan:1`, `activity_msg:1`, `activity_ask:1`) and ADDS
  `activity_ids:1` = "I speak v6 slices, id-addressed ACTIVITY_REQ / ACTIVITY_ACT and the rename / merge actions" and
  `view_state:1` (§5.6). 2.1 announces `activity_gossip:6` and drops the rest.
- Per link: both `activity_ids` → v6 frames; else v5 projection both ways. A 2.0 receiver accepts body `v:5` (window only) and
  `v:6`.

### 6.5 Mixed-mesh actions (window only)
- 2.0 dashboard → 2.0 owner: by id.
- 2.0 dashboard → OLD owner (its units came from v5 slices): the 2.0 gateway translates to the v5 form from the units it holds —
  `path`, `args.to` = the target's path, `before` / `after` = `sibRef`-style names. `rename`, `merge`, `unmerge` → refused
  `owner-unsupported` ("… runs a bridge older than 2.0.0") before anything is queued (as #82 / #83 / #85 gate theirs).
- Old dashboard → 2.0 owner: §6.3.

---

## 7. Migration and cutover

**The cutover (Q09, Q16, Q21, Q22, Q24 – Q26).** 1.7 was experimental, so 2.0 has no rollback, no side-by-side layout and no
legacy reader. Every bridge stops; each host converts its OWN history in place with a standalone script; then the bridges
start in any order.

### 7.1 The runbook (the RESUME STATE deploy notes say this)
1. **Stop every bridge on every host** — gateways and followers, ROBIN-Z790, LITTLE-001, the Mac, phub-lnx-01 (tray,
   services, auto-start). On the Dropbox pair (`src/` is shared) this also keeps a still-running 1.7x process from meeting
   2.0 code.
2. **Update the code** on each host (the Dropbox pair: once).
3. **On each host:** `node src/tools/aimb-migrate-v2.mjs --dry-run` (reads, reports, writes nothing), then
   `node src/tools/aimb-migrate-v2.mjs`. Each converts only `persistence/activity/<that host>/`. The hosts can do this in any
   order, at the same time, or minutes apart.
4. **Start the bridges in any order.** A host that is not converted yet refuses to start and says which command to run
   (§7.5), so a forgotten step fails loudly instead of showing an empty board.
- A host left on 1.7x past the window still works with the 2.0 hosts through the v5 projection (§6.2) until 2.1; its own
  history converts whenever it does step 1 – 4.

### 7.2 The script: `src/tools/aimb-migrate-v2.mjs`
```
node src/tools/aimb-migrate-v2.mjs [--dry-run] [--dir <persistence dir>] [--host <name>] [--backup <dir>] [--json]
```
- `--dir`: the persistence directory (default: what the bridge would use — `persistence.dir` from the config, via the bridge's
  own config loader, else `<repo>/persistence`). `--host`: the bridge's host name (default: the bridge's `HOSTNAME` rule, the
  same `lslug(host)` function, so the script converts exactly the directory the gateway owns). `--json`: one JSON report line.
- **Preconditions** (each refusal exits 2 with one line naming the fix):
  - the host's gateway must NOT be running: the script dials the bridge's well-known port on this machine; an answer →
    "a bridge is running on this host — stop it first". It also refuses if any `*.tmp` newer than 10 s sits in the host's
    directory (a writer is active).
  - `activity/<host>/format.json` with `v:6` exists → "already converted (format v6, 2026-10-04 by aimb-migrate-v2 2.0.0) —
    nothing to do", exit 0 (the idempotent re-run).
  - no `YYYY-MM-DD.jsonl` in the directory → a fresh host: write the marker, exit 0.
- **Steps** (each step's output is complete before the next starts; a crash anywhere leaves a state the next run handles):
  1. **Backup (one-off).** Copy every exact-name day file of the directory to `persistence/activity-v5-backup/<host>/`
     (outside `activity/`, so no reader ever lists it), then write `activity-v5-backup/<host>/COMPLETE` with the files' names, sizes and
     sha256. A backup with `COMPLETE` is never overwritten — a re-run after a crash reuses it, so the backup always holds the
     PRISTINE v5 files. A backup without `COMPLETE` (a crash while copying) is redone. (Q35.)
  2. **Convert.** Read the v5 days from the BACKUP, oldest first, run the forward pass (§7.3), and write each converted day as
     `<day>.jsonl.tmp`, then rename it over `activity/<host>/<day>.jsonl` (the host's own file; every bridge is stopped).
     Converting from the backup, never from the half-converted directory, makes a re-run after a crash produce the same bytes.
  3. **Index files.** Write `<day>.idx.json` for every converted day (§2.4).
  4. **Marker, LAST:** `activity/<host>/format.json` = `{"v":6,"by":"aimb-migrate-v2 2.0.0","at":"<ISO>","host":"ROBIN-Z790",
     "days":{"2026-10-01":{"size":…,"sha256":…},…},"records":41233,"nodes":812,"ghosts":17,"relabelled":2}`.
- **`--dry-run`:** runs the preconditions and the whole forward pass in memory and prints the report — days, records, nodes,
  ghosts, the relabelled duplicate labels, keys slugged from names with `:`, conflicted copies seen, bytes it would write —
  and writes NOTHING (no backup, no `.tmp`, no marker). Exit 0, or 2 on a refused precondition.
- **Report** (both modes): "activity/ROBIN-Z790: 7 day files, 41 233 records → 812 nodes (17 ghosts), 2 labels made unique,
  backup in persistence/activity-v5-backup/ROBIN-Z790 (12.4 MB), 1.4 s".
- Conflicted copies in the directory (`… (LITTLE-001's conflicted copy …).jsonl`) are listed as WARNs, never read, never
  converted, never deleted (Q23, Q27: warn only — they stay for a person to inspect).
- Stale `*.tmp` (older than 10 s) in the host's own directory are deleted before step 2.

### 7.3 The conversion (pure: `lib/activity-v5.js` `convertV5(days) → { days: v6 lines per day, report }`)
One CHRONOLOGICAL forward pass, far simpler than #82's newest-first remapping:
- A path map `pathKey → run`. A v5 record at a path joins the run there, or starts one (and its missing ancestors). A record
  whose `new_from` is at or above a held node starts a NEW run there (the old one ended unseen — expiry). `moved_from` re-keys
  the run (and its subtree) to the new path. `dismiss:true` and `evicted:[…]` end the runs at / under that path.
- At the end every run has a FINAL path. **Id = legacy id of the final path** (hole H7: a moved node has several paths; the
  final one is what a peer derives from the last v5 slice, §6.2). Runs that share a final path share the id — earlier runs of
  one node, exactly as today's run boundary treats a re-used name.
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

### 7.5 The 2.0 bridge on unconverted (or reconverted) history
- At start, before the replay, a 2.0 GATEWAY lists its own `activity/<host>/`. Exact-name day files present and no
  `format.json` with `v:6` → it REFUSES TO START: exit 78 with "activity history in persistence/activity/ROBIN-Z790 is format
  v5 (pre-2.0). Stop every bridge, then run: node src/tools/aimb-migrate-v2.mjs (see docs/spec-88.md §7.1)". The tray shows
  the same line. Followers own no activity: no check.
- No day files and no marker (a fresh install, or persistence just enabled) → the gateway writes the marker and starts.
- A v2 – v5 record inside a v6 day file (someone started a 1.7x bridge on converted history) → skipped, one WARN per file
  per start ("activity: a pre-2.0 record in 2026-10-05.jsonl — a 1.7x bridge wrote here after the migration; ignored"). No
  rollback is planned (Q09, Q25): the way back is by hand — stop, copy the backup over `activity/<host>/`, delete
  `format.json`, start 1.7x — and it loses the 2.0-era history (Q39).

### 7.6 How long it takes
- Prototype (scratch, this machine): parse + legacy-id + stringify of synthetic v5 records ran at ~230 – 260 MB/s — 10 000
  records (3.9 MB) 17 ms, 50 000 (19 MB) 80 ms, 200 000 (77 MB) 300 ms. The forward pass adds a Map lookup per record.
- Realistic: 7 days of retention at 1 – 10 MB a day = 7 – 70 MB read → under 1 s CPU. It writes the converted days (about the
  same size: `n` + `at` replace `path`, node records add ~2 %), the index files and the backup copy — so Dropbox uploads
  roughly twice the activity history of that host once. The bridges are stopped meanwhile; nothing waits on it at start.

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
   + entries; move / rename / merge / unmerge / item / remove become pointer changes + one record each, with the
   `duplicate-label` and `cross-session` refusals; plans, questions, cascade, ranks, plan-end, eviction, expiry, `applyAction`
   on ids. 2a structure + resolution, 2b lines (§4.0) / plans / questions, 2c actions + notices. *Tests:* new resolution /
   idempotency / label-uniqueness / merge (incl. clashes) / unmerge / alias / ghost / running-agent-move checks, and the
   existing `test_activity_unit` behaviours re-expressed in 2.0 forms.
3. **v6 records + replay.** `recordKind` v6 only; `createReplay` folds node records (newest wins per field, `create` seals
   the run) and attaches entries by `n` — no remapping. cp / cf / rep v6; `planCarryForward` carries structure. *Tests:* a
   seeded REPLAY FUZZ like #82's (400 random sequences of reports, plans, moves, renames, merges, unmerges, dismissals,
   evictions, expiry, day rollovers with cf) — replay ≡ chronological apply (lines, bars, structure, logs, counts, runs).
4. **Conversion library** (`lib/activity-v5.js`: the v5 record reader moved out of `activity.js` + `convertV5`, pure).
   *Tests:* a CONVERSION FUZZ — random histories applied with a FROZEN copy of the last 1.7x library
   (`tests/fixtures/activity-v174.js`, from `git show`), then (a) its own replay and (b) the converted days through the 2.0
   replay and paging must give the same tree and pages (paths ↔ ids, lines, states, bars, plans, ranks, logs, counts, run
   boundaries); converting twice gives byte-identical days; the agent / context duplicate is relabelled.
5. **The migration script** `src/tools/aimb-migrate-v2.mjs` (§7.2) + the bridge's start check (§7.5). *Tests* (new
   `test_migrate_v2`, temp persistence dirs, fixture days WRITTEN BY A REAL 1.7x GATEWAY — `git archive v1.74.0` build,
   `AIMB_TEST_OLD_BRIDGE` — with moves, plans, questions, dismissals over 3 days):
   - **dry-run:** report correct, the directory's file list + every file's sha256 unchanged, no backup directory, no `.tmp`.
   - **run:** backup holds byte-identical copies of every v5 day + `COMPLETE`; day files are v6; index files exist; marker
     last (its mtime ≥ every day file's); a 2.0 gateway then starts and its board + log pages equal the 1.7x gateway's.
   - **idempotent re-run:** a second run exits 0 "already converted" and changes no byte; a forced crash after converting
     2 of 3 days (test hook) → the next run completes from the backup and the days equal a clean run's, byte for byte.
   - **backup:** never overwritten once `COMPLETE`; a backup without `COMPLETE` is redone.
   - **refusals:** a 2.0 gateway on unconverted days exits 78 with the command in its message (and starts after the script);
     the script refuses while a gateway answers on this host; a fresh empty directory → marker, gateway starts.
   - **shared folder:** two hosts' directories (two `--host` names) converted at once in one persistence dir touch only
     their own; a planted `2026-10-01 (LITTLE-001's conflicted copy 2026-10-03).jsonl` is warned about, left in place, and
     not converted; a v5 record appended after the migration is skipped with one WARN.
6. **Bridge files** (§2.4, §5). Index files at rollover + rebuild, `prune` deleting `<day>.idx.json` with its day,
   `actLogPage` via the index, the ghost table at startup, "show removed", the conflicted-copy check at start / rollover.
   *Tests:* paging reads only indexed ranges (a counter in the facet), ghost entries appear only with `removed:true`, a ghost
   leaves when its last day is pruned, a rebuilt index equals the written one.
7. **Gossip v6 + the window's v5 projection** (§6). `activity_ids:1`, v6 frames, v5 projection, v5 receive → legacy ids,
   v5-path ACTIVITY_REQ / ACTIVITY_ACT on a 2.0 owner, translation + `owner-unsupported` toward old owners. *Tests:* unit
   (projection: sanitising, collisions, depth); live mixed against the 1.74 `git archive` build — boards both ways, a move /
   rename / merge on the 2.0 host as remove + add on 1.74, a 1.74 dashboard's skip / move on a 2.0 node, a 2.0 dashboard's
   skip on a 1.74 node, rename on it `owner-unsupported`, remote log pages both ways; a late host's legacy ids equal its own
   migration's.
8. **Per-user view state** (§5.6). `lib/view-state.js` (LWW set, max register for `seen:`, `reset`, `all`, GC, budget),
   `view_set` / `view` WS messages, the `VIEW` frame + `view_state:1` + `view_v`, `views/<host>.json` persistence +
   rehydrate, pruning on remove. *Tests:* unit (order + ties, idempotent + commutative merge, stamp bump under skew, max
   register, reset voids older, `all` vs newer `open:`, tombstone GC, budget); live `test_view_state_live` — two gateways
   + a third via the first: a pin on A shows on C, a close on B survives new activity on A (badge "N new"), Reset view
   everywhere, a dismissed node's records tombstoned on all, a host restarted with its peers down keeps the set, a 1.74
   peer gets no `VIEW` frame.
9. **Tool, script, guides** (§4). The 2.0 flags + fields, the leading-`@` rule, every §4.5 `legacy-form` error (script AND
   gateway), results, `gateway-unsupported` against < 2.0.0, `--guide agent` as the first report, `{log_snippet}` /
   `agentGuide` / `sessionGuide` / `{log_tool_hint}` / the briefing in `config.example.json`, realm guides gated by
   `min_bridge` ≥ 2.0.0, server instructions, README. The bridge switches to the 2.0 model here. *Tests:*
   `test_log_script_live` rewritten for 2.0 forms, one check per removed form (message names the new form),
   `--guide agent` creates once and prints only on the second run, `test_activity_6c_live` (the pinned guide lines), the tool
   schema.
10. **Dashboard** (§5.4, §5.6). Units / rows / actions by id, Rename…, Merge into…, `duplicate-label` in the dialogs, the `at`
    tooltip, the copy command, "show removed", the view state (badges, "new since you last looked", Reset view, live vs
    load-time application, the one-time `localStorage` import). *Tests:* `test_dashboard_activity` (jsdom) — ids through
    deltas, a rename / move keeping selection, open / closed beating defaults, a closed node gaining activity → badge not
    reopen, Expand all then a new node → default, the divider, Reset view, the import, drag-and-drop by id, a board with a
    late 1.74 host's nodes.
11. **Delete the old machinery** (unused by now): #82's path code — `rekeySubtree`, `applyMove`'s re-keying, `remapSegs`,
    `remapGone`, `ensureIn`'s move use, `foreign`, `goneAt`, `deadAt`'s move clause, `sealRuns` / `sealNode`'s `except` /
    `recTs` / `own`, `movedAt`, `mv` / `mvAlias`, `node.moved` + `pt.m`, `nodeAliases`, `matchAlias`, `fileEntryMatches`' path
    match, `fileEntryView`'s alias remap, `fileRunStart`'s move clause, `moved_from` writers, the `cpLive` re-key — and the
    v2 – v5 readers in the bridge (they live on only in `lib/activity-v5.js` for the script), `@` / `@~` path parsing, the
    positional / `--plan` / `--to` handling (only the §4.5 detector that names the new form is left), the page's
    `localStorage` pins. KEPT from #82: ranks (`rankBetween`, `placeRanks`, `siblingCmp`, `derivedRank`), the cascade,
    positions, the actions. *Tests:* the full suite; a grep check that no `moved_from` reader and no `@~` parser is left
    outside `activity-v5.js` and the `legacy-form` detector.
12. **Release 2.0.0**: architecture.md §12 (the v6 layout, `views/`, `activity-v5-backup/`) + §13, README (2.0 forms, the
    removed-forms table), the RESUME STATE deploy notes = the §7.1 runbook, the live cutover on the real hosts (dry-run on
    each first). Nothing to publish in `config.json` beyond the briefing and, if wanted, 2.0 realm guides (Robin's step).
13. **2.1 (later, not 2.0):** delete the v5 projection and `activity_gossip:5` (§6.2 – §6.5) once every host runs ≥ 2.0.

---

## 9. Decisions, holes and questions

### Decisions (Robin, 2026-10-03)
| Q | Question (first draft) | Decision |
|---|---|---|
| 01 | Does `--text` set the line in key mode? | **Changed.** No `@` in paths. A LEADING `@` in the text sets the node's current line (it replaces `@~`, which goes); plain text only logs; `@@` = a literal leading `@`. Terms: label = the node's name, line = its status text (§4.0, §1.3). |
| 02 | Idempotent create ignores location / label on an existing node? | **Accepted** — warning `exists` (§3.5). |
| 03 | Key charset | **Accepted** — agent-name chars minus `:`, ≤ 48, case-insensitive (§1.1). |
| 04 | Creator of a path-created node = its owner | **Accepted** — nearest agent above. Note for Robin: not purely transitional — `--path` stays after 2.0 as a shorthand (quick logging by hand), just rarer (§3.3). |
| 05 | Labels unique among siblings? | **Changed** — yes: a create / rename / move (and merge / unmerge) that duplicates a sibling label is refused (§1.6). |
| 06 | Merge scope | **Accepted** — contexts / plan items only; unmerge by tool / script only in 2.0 (§3.6). |
| 07 | Subtree log runs per member | **Accepted** — each child shows its own whole current run (§5.3). |
| 08 | `at` on every entry | **Accepted** — the full path at the time (§2.2). |
| 09 | Rollback | **Changed** — none ("1.7 was experimental"): no state files, tail maps or newer-wins (§7). |
| 10 | Hello: keep `activity_gossip:5`, add `activity_ids:1` | **Accepted** — v5 dropped once every host is ≥ 2.0 (2.1) (§6.4). |
| 11 | Depth limit 6 | **Accepted** (§1.3). |
| 12 | Id = 16 base32 chars | **Accepted** (§1.2). |
| 13 | Pins / hidden mapped to node ids once | **Accepted, then extended (FINAL):** view state is stored per USER on the bridge and replicated across the realm; the browser's pins / hidden are imported once (§5.6). |
| 14 | Cross-session / cross-host moves | **Accepted** — later, not 2.0. |
| 15 | Moving a live agent | **Accepted** — allowed, but never to another session (§1.5). |
| 16 | Version 2.0.0, any order, all hosts within a day | **Accepted**, with Q26's change: stop all, migrate, start in any order (§7.1). |
| 17 | Agents create themselves | **Accepted** — and `--guide agent` is the agent's first report: it registers the node under its item with the line "reading the guide" (§4.4). |
| 18 | Ghosts + index files in 2.0 | **Option 1 (FINAL):** ghosts + per-day index files; removed children's entries behind a "show removed" toggle (off by default); a ghost lives until retention drops its last entry (§5.1). |
| 19 | Keep the old `--move --to`? | **Changed (FINAL):** drop ALL 1.7x command forms — positional text, `--plan`, `--move … --to`, `@` in paths, `@~`; each gets an error naming the new form. Only the v5 network format stays, for the cutover (§4.5, §6.2). |
| 20 | A merged key resolves to B | **Accepted** — until unmerged (§3.6). |
| 21 | Side-by-side v6 directory vs in place | **Changed** — in place, each host its own directory, a one-off backup; no `v6/`, no map reader (§7). |
| 22 | The map's grain | **Changed** — moot: a standalone migration script converts the days in place (`--dry-run`, backup, format marker); 2.0 refuses unconverted data (§7.2, §7.5). |
| 23 | Conflicted copies | **Accepted** — warn + show, never read or delete (§10). |
| 24 | Keep the legacy reader in 2.0? | **Changed** — no legacy reader after the cutover; the script converts everything (§7.3). |
| 25 | Re-upgrade after rollback: newer wins | **Changed** — no rollback, so no re-upgrade machinery. |
| 26 | Restart the Dropbox pair together? | **Changed** — stop ALL bridges on every host, migrate, then start in any order (§7.1). |
| 27 | Refuse to convert on conflicted copies? | **Accepted** — warn only (§7.2). |
| 28 | (Robin, new) Tree / log view-state rules | **Accepted into 2.0:** explicit open / close beats defaults, per user; new activity never reopens a closed node ("? N" / "N new" badges); Expand / Collapse all are choices; Reset view; choices pruned with their node; the log keeps selection + DETAILS fold, not entries; a "new since you last looked" divider; nothing steals selection or scroll (§5.6). |

### Holes found in the #88 design (and the fixes above)
- **H1** `:` is legal in agent names today (`SEGMENT`), so `fix-79:docs` is ambiguous → keys exclude `:` (§1.1).
- **H2** "registering an existing key updates it" lets a retry or a replayed prompt undo a dashboard move / rename → create
  attributes apply only at creation; changes are explicit verbs (§3.5).
- **H3** the PEER_HELLO check is an equality on `activity_gossip`, so announcing 6 would disconnect every 1.7x peer → keep 5,
  add `activity_ids:1` for the window (§6.4).
- **H4** "a path creates a node whose key is the last segment": segments have spaces / `#` / `(`, and a path caller reports
  as the session, so whose key? → slug + creator = owner (§1.1, §3.4).
- **H5** a log "computed from the current tree" loses removed children's history → ghosts (§5.1); this also closes #76.
- **H6** merging agents (key namespaces) and merging into one's own descendant are undefined → refused (§3.6).
- **H7** "hash(host, session, path)" for legacy ids: which path of a moved node? → the final path; reused paths share the id
  as earlier runs (§7.3).
- **H8** "a per-host index (id → day files)": today's `actIndex` is entry-id → offset, in memory, capped → persisted per-day
  index files (§2.4).
- **H9** free-text labels can't always be v5 path segments → the window's projection rules (§6.2); depth stays ≤ 6.
- **H10** the tool result's `id` is already the ENTRY id → the node id goes in `node.id` (§4.2).
- **H11** `--item <key> "<label>"` vs the one-value `--item "A"` → the parse rule in §4.1.
- **H12** (revised) the persistence folder is Dropbox-shared (ROBIN-Z790 + LITTLE-001) and the project's rule was "no
  file-rename migration" (issues.md #47) because a 1.7x reader might read mid-change → the in-place rewrite happens only with
  EVERY bridge stopped, by the one host that owns the directory, from a pristine backup (§7.2, §7.4).
- **H13** (revised) the Dropbox pair shares `src/`: a 1.7x process restarted after the update would run 2.0 code on v5 data →
  the 2.0 start check refuses it with the fix (§7.5). The first draft's dashboard path fallback is no longer needed (§5.4).
- **H14** (new) with no `@`, a path segment no longer says agent or context → labels unique across both kinds (§1.6), label
  before agent key in matching (§3.3), and the migration relabels the one v5 duplicate (§7.3).
- **H15** (new) the dashboard has no per-person identity: actions are attributed to the gateway's `PROC_USER` → Q29.
- **H16** (new) a closed node's "N new" badge needs a baseline → the close record stores the subtree count and open questions
  at close (§5.6).
- **H17** (new) "Expand all" as one record per row would write hundreds of replicated records and freeze new nodes open → one
  `all` record that covers only nodes created before it (§5.6).
- **H18** (new) `{log_snippet}` already shrank to one line in 1.73 (#89); the first draft's 7-line snippet belongs in
  `agentGuide` now, and realm guides written for 1.7x would teach removed forms → §4.3, Q34.

### Risks
- The replay and the conversion are the risky parts; both get seeded fuzzing against a ground truth (chronological apply; the
  frozen 1.74 library). The live mixed test runs against a real 1.74 build, as every release since 1.69 has.
- A botched conversion is recoverable: the backup holds the pristine v5 days; delete the marker, copy the backup back, fix,
  re-run. A host that refuses to start is the visible failure mode, not a silently empty board.
- The cutover needs every bridge down at once — a few minutes of no mesh. Messages are parked as usual (durable mailboxes).
- Duplicate host names on two machines would make two writers of one host directory — today's files have the same risk
  (#70's duplicate-hostname WARN); §10's conflicted-copy check makes it visible.
- Bigger dashboard change than #82 (ids + the view state); the id-keyed units keep the delta machinery as is.
- Label uniqueness turns some silent successes into refusals (two agents both defaulting to `notes` under one item) — Q31.

### New questions for Robin (answer by number; my recommendation after each)
29. **Who is "the user" of the view state?** A dashboard socket has no per-person identity: actions are attributed to the
    gateway's `PROC_USER` (AI_BRIDGE_USER, else the OS login). So "per user" = per gateway user, and two people using one
    gateway's dashboard share one view. *Recommend: accept for 2.0* (robin is robin on every host); a per-person dashboard
    login is its own issue.
30. **Live vs at-load for the view state across open windows.** *Recommend:* pins, hidden, open / closed, Expand / Collapse
    all, Reset view and options apply LIVE in every window; the log SELECTION and the DETAILS fold apply only at page load
    (newest wins), so two open windows never steal each other's selection; `seen` merges silently.
31. **Default labels and uniqueness.** Two agents doing `--key notes --under 88` (label defaults to the key) — the second is
    refused `duplicate-label`. Alternative: suffix a DEFAULT label automatically ("notes (2)") and refuse only a label that
    was given (`--label`, `--rename`, a move). *Recommend: refuse in both cases* — one rule, as you decided; the error names
    the sibling and says `--label "…"`, and the guide tells agents to give a label when they make a node under a shared item.
32. **Moves and merges onto a same-label sibling (dashboard).** *Recommend:* the Move / Merge dialogs show the clash and offer
    "rename and move" (a new label field, pre-filled "Docs (2)") — one action, two records; the tool / script just refuse.
33. **Finishing states and the line.** `--state done --text "summary"` without `@` logs the summary but leaves the last
    running text as the line. *Recommend: keep the one rule* (no implied line) — the result carries `line:false` and the
    guide's finish line shows `--text "@<summary>"`. Alternative: `--state done|failed|skipped` with text implies `@`.
34. **Realm guides from 1.7x.** *Recommend:* a 2.0 gateway serves a realm guide only when its `min_bridge` ≥ 2.0.0; older ones
    fall back to the built-in text. You re-publish guides with `"min_bridge": "2.0"` if you want custom ones.
35. **Backup location and lifetime.** *Recommend:* `persistence/activity-v5-backup/<host>/` (beside `activity/`, follows the
    host, ~10 – 70 MB each, Dropbox-synced on the pair), deleted by hand; a 2.0 gateway logs one reminder per start once the
    backup is older than `log_retention_days`. Alternative: outside the persistence folder (not synced).
36. **The `@` escape.** *Recommend* the rule in §4.0: in the leading run of `@`, each pair is a literal `@` and an odd one left
    over sets the line (`@@x` logs "@x", `@@@x` sets the line "@x").
37. **Labels containing `/`.** Labels may now hold `/` (no longer parsed). *Recommend:* a path segment may be double-quoted
    (`"a/b"`, `""` = `"`) — the quoting today's `@"…"` has, without the `@`; otherwise such nodes are reachable only by key / id.
38. **Other per-browser settings.** The #87 log order, "Active only", "Plans only" are in `localStorage` today. *Recommend:*
    move them into the view state as `opt:` records (tiny), so the board looks the same on every host; the depth slider stays
    per browser (it depends on the screen).
39. **Starting 1.7x on converted history by mistake.** *Recommend: document only* — 2.0 skips the v5 records it finds with a
    WARN; the manual way back (copy the backup over, delete `format.json`) loses the 2.0-era history. No machinery.

---

## 10. Shared-folder (Dropbox) rules

ROBIN-Z790 and LITTLE-001 share the WHOLE repo folder through Dropbox — `src/` (code, `src/config.json`), the `persistence/`
store and so every `activity/<host>/` directory. The Mac and phub-lnx-01 have their own checkouts and configs. Dropbox gives no
locks and eventual consistency, and it makes a "conflicted copy" when two machines change one file. The persistence layout is
conflict-free because no two machines ever write one file (architecture.md §12 "The substrate": its four invariants), and the
shared config is read-only to the bridge (architecture.md "Policy file discipline"). #88 keeps both.

1. **Per-host writes only.** Every file #88 writes lives under the WRITING host's own name and only that host writes it: its
   day files and index files (`activity/<lslug(host)>/`), its marker (`activity/<host>/format.json`), its backup
   (`activity-v5-backup/<host>/`) and its view-state copy (`views/<lslug(host)>.json`). Node records and aliases live inside
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
   `config.example.json`, and publishing it — and any 2.0 realm guide (Q34) — into the shared `config.json` stays Robin's
   manual step, as every release. No new config key is needed.
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
