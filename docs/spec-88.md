# #88 spec (draft for Robin) — stable node identity, v2.0

Status: DRAFT, 2026-10-03, by spec-88 (an agent of Bridget). Nothing is built. Robin answers the numbered OPEN QUESTIONS (§9)
by number; the build (§8) starts after that. The agreed design is in `docs/issues.md` "#88"; this spec makes it exact and
names the holes it found (§9 "Holes"). Code references are to v1.72.0 (`src/lib/activity.js` unless another file is named).

**One paragraph.** Today a node's PATH is its key (`newNode`: `key = lc(path)`), so a move rewrites history: `applyMove` /
`rekeySubtree` re-key memory, the replay remaps every older record through later moves (`createReplay`: `remapSegs`, `foreign`,
`goneAt`, `sealRuns`, `movedAt`), and log paging follows `moved_from` aliases (`nodeAliases`, `matchAlias`). v2.0 gives every
node a stable INTERNAL ID, minted once from (owner host, session, creator, key). Label, parent, rank and kind become attributes
set by small NODE RECORDS; log entries, checkpoints, gossip and the dashboard name the id. A move or rename is one record and
nothing is rewritten; a node's log is "entries whose id is in this subtree now". Paths stay as a shorthand that resolves
against the current tree, then aliases, then creates. Old hosts (1.65 – 1.72, all format v5) keep working: a v2 host projects
v5 slices for them and accepts their path-based requests and actions. Existing history converts once, deterministically,
ALONGSIDE the v5 files (which stay byte-identical — the persistence folder is Dropbox-shared, §10), so a rollback is free.

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
  `pathKey` = the v5 key (`lc` canonical path) the node has when it is converted. The two prefixes keep the two families apart.
- **Why a hash and not a counter:** no allocator state to persist; a retried create mints the same id; re-running the
  conversion gives the same ids; a v2 host derives the same legacy id for a 1.72 host's node (from its v5 slice) as that host
  will at its own upgrade, so dashboard pins / open state survive the peer's upgrade (§6.2).
- **Collisions:** at 80 bits and ≤ 10⁶ nodes per host over retention, p ≈ 4·10⁻¹³. A mint that hits a DIFFERENT live node's
  id (creator / key differ) is refused `id-collision` and logged; nothing silently merges.
- Prototyped (scratch, Node's `crypto`): Bridget's root on ROBIN-Z790 = `mkjhhu3kyjf2gbcv`, `:spec-88` = `uytyq4e6wsmtqsfq`,
  `spec-88:docs` = `rtam3yvgwkzx5zbp` (the same for any letter case of host / session / chain / key).

### 1.3 Attributes (all set by node records, §2.1)
| Attribute | Rule |
|---|---|
| `label` | what is shown; 1 – 60 code points, no control characters (today's context-name rule `normContextName` minus the `/` and `"` bans — a label is no longer parsed). Default: the key (agents) / the key or the path segment (contexts). Not unique (§3.3). |
| `parent` | an id in the same session on the same host (cross-session moves: later, §9 Q14). Never the node itself or below it. |
| `rank` | #82's fractional base-36 rank, unchanged (`rankBetween`, `placeRanks`, `derivedRank`, `siblingCmp`): stored only when placed, else derived from created_at + plan_ix. |
| `kind` | fixed at creation: `agent` or `context`. Never changes. |
| `plan` | a context becomes a PLAN ITEM for good (6b) — the one kind change, its own record (`op:"item"`). |
| question | unchanged from #85: a property of the current LINE (`line.question`), not a kind. |
| `merged_into` | §3.6. |

Depth stays ≤ 6 below the session (`ACTIVITY_LIMITS.depth`), checked on create and move — v5 projection needs it (§9 Q11).

### 1.4 Kinds
- **session** — the root node of a (session, host); id = mint(host, session, "", ""). Agent-like lifecycle, as today.
- **agent** — an actor (start / finish / stale / gone). An agent is created by its creator (the session, or another agent) and
  is ALSO a creator: its key chain is how a script names it (`--agent spec-88`).
- **context** — a piece of work (line, bar, ETA). **Plan item** = a context with `plan` (6b). **Question** = a context whose
  line carries `question` (#85).
- Ownership (who goes stale for whom) stays TREE-derived: `ownerOf` = the nearest agent at or above (6a). The creator is a
  namespace, not an owner: `spec-88:docs` placed under the session's `:88` is owned by the session for staleness. Activity
  from a call refreshes target..owner as today PLUS the calling agent (§4.1 `--agent`), which today's path-only model can't name.

### 1.5 How agents and sessions are identified
- A **session** is unchanged: realm + project + user + session name (+ host for ownership). The script's `--session` /
  `--project` / `--user`, the tool's `as`.
- An **agent** is named by its key chain from the session: `--agent spec-88`, `--agent spec-88/research`. A chain step that
  doesn't exist yet is CREATED (an agent, label = key, under its creator unless `--under` places it — §4.1). A step that names
  a context → `not-an-agent`.
- Compatibility: an agent created through a path (`--path "@#70/spec-70"`) gets creator = its OWNER at creation (§3.4), key =
  its segment — so for every path-created agent tree `--agent a/b` names the same node the old `--agent a/b` path named, and it
  keeps naming it after a move.

---

## 2. Record formats (day files, format v6)

Day files, retention, one writer per host, the backwards reader and the cp / rep mechanism are unchanged
(`facets/persistence/file.js` `activity.*`, `bridge.mjs` `persistActivity` / `writeCheckpoints`), but v6 day files live in a
NEW subdirectory, `activity/<host>/v6/YYYY-MM-DD.jsonl`, beside the untouched v5 files (§7, §10). Every v6 record keeps the
identity fields today's records carry (`origin realm session project user host s0`) so a file stays self-describing; they are
shown as `…ident` below. `RECORD_FORMATS` becomes {2,3,4,5,6}; v2–v5 records are read only by the conversion and, through its maps, by the
history pager (§7).

```json
…ident = "realm":"default","project":"AIMB","user":"robin","session":"Bridget","host":"ROBIN-Z790","origin":"ROBIN-Z790","s0":1790900000000
```

### 2.1 Node records (`kind:"node"`) — structure only, never in a log view
Each changes ONE thing. `by` / `act` as 6d when a dashboard did it (a system record: no activity). `was` = the node's display
path BEFORE the change (it seeds the alias table, §3.3, and lets a log say "moved from").

```json
{"v":6,"kind":"node","op":"create","ts":1790984000000,"n":"uytyq4e6wsmtqsfq","c":"mkjhhu3kyjf2gbcv","key":"spec-88","nk":"agent","label":"spec-88","p":"bpcw6vw4rsnpwtxl","run":true,…ident}
{"v":6,"kind":"node","op":"create","ts":1790984000001,"n":"rtam3yvgwkzx5zbp","c":"uytyq4e6wsmtqsfq","key":"docs","nk":"context","label":"Write the docs","p":"bpcw6vw4rsnpwtxl","rank":null,"run":true,…ident}
{"v":6,"kind":"node","op":"label","ts":1790985000000,"n":"rtam3yvgwkzx5zbp","label":"Write the README","was":"@\"Next release\"/@#88/@\"Write the docs\"",…ident}
{"v":6,"kind":"node","op":"move","ts":1790986000000,"n":"rtam3yvgwkzx5zbp","p":"2lneiezs5pgo7ghf","rank":"0f","was":"@\"Next release\"/@#88/@\"Write the README\"","by":{"kind":"dashboard","user":"robin","host":"ROBIN-Z790"},"act":"move",…ident}
{"v":6,"kind":"node","op":"rank","ts":1790986500000,"n":"rtam3yvgwkzx5zbp","rank":"0fi",…ident}
{"v":6,"kind":"node","op":"item","ts":1790987000000,"n":"rtam3yvgwkzx5zbp","plan_ix":3,…ident}
{"v":6,"kind":"node","op":"merge","ts":1790988000000,"n":"2czd5q2puuwp5xi4","into":"hijrhd6rgrortbzg","from":"o4qpehqjcrade6ca","was":"@\"Next release\"/@#79","kids":["…id","…id"],…ident}
{"v":6,"kind":"node","op":"unmerge","ts":1790989000000,"n":"2czd5q2puuwp5xi4","p":"o4qpehqjcrade6ca",…ident}
{"v":6,"kind":"node","op":"remove","ts":1790990000000,"n":"uytyq4e6wsmtqsfq","why":"dismiss","was":"@\"Next release\"/@#88/spec-88",…ident}
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
{"v":6,"id":"act_9164_murlfkk7-3gk","ts":1790984100000,"n":"rtam3yvgwkzx5zbp","current":true,"text":"Writing the README section","state":"running","at":"@\"Next release\"/@#88/@\"Write the docs\"",…ident,"details":null,"data":null}
```
- Today's entry fields (`apply` → `res.entry`) MINUS `path`, `new_from`, `evicted`, `moved_from`, `plan_item` / `plan_ix`
  (structure moved to node records) PLUS `n` (the node id) and `at`.
- **`at` = the node's display path when written** (the v5 projection of it, §6.2 — so it is always a valid v5 path). It is what
  keeps an "at the time" label: the log panel shows it on hover when it differs from the node's path now ("logged as
  @#88/@Docs"), and §6.3 hands it to old hosts. ~60–150 bytes per entry (§9 Q8: or the label only).
- Kept: `current text state progress eta_at stale_after_ms details data by act line_text line_by question plan_end
  finished_at`, and `dismiss:true` on the parent-log dismissal entry (`n` = the PARENT, `of` = the removed id). `rank` leaves
  entries: a placement writes a `rank` node record plus its "placed before @Build" entry.
- A move / rename / merge also writes a normal ENTRY on the node ("moved by robin via dashboard (ROBIN-Z790) from @#88 to
  @Later", `act`) so the log tells the story; the node record carries the structure. Two lines, one call.

### 2.3 Checkpoints and carry-forward
- **cp** (`checkpointOf`): `path` → `n`. `{"v":6,"kind":"cp","k":17,"ts":…,"n":"rtam3yvgwkzx5zbp","current":{…},"state":"running","progress":{…},"eta_at":null,"created_at":…,"rank":null,…ident}`.
  `rep` lines unchanged (`{"v":6,"rep":[17,18],"n":245,"since":…,"last":…}` — keys per file, as today; a rep's `n` is its
  repeat COUNT, as today, never a node id — `recordKind` tells a rep by its `rep` array).
- **cf** (`planCarryForward` / `carryOf`) carries STRUCTURE too, because a node's `create` may be older than the replay window:
  `{"v":6,"kind":"cf","ts":…,"n":…,"c":…,"key":"docs","nk":"context","label":"Write the README","p":…,"rank":"0fi","plan_item":true,"plan_ix":3,
  "aliases":[{"path":"@\"next release\"/@#88/@\"write the docs\"","at":1790986000000}],"merged_into":null,"current":{…},"state":…,"progress":…,"eta_at":…,"created_at":…,"last_activity":…,"stale_after_ms":null,"implicit":false,"log_n":12,"run_at":1790984000000,…ident}`.
- **What is carried** (`carryDue`): every node whose state OR structure (its newest create / move / label / rank / item record)
  would fall out of the window before the next rollover, every open plan item, and every ANCESTOR of a carried node (parents
  first, as today). `run_at` = when its current run began (its create's ts), so the run boundary survives (§5.3). `pt` gains
  `s` (structure persisted).
- Unchanged: `cf` written at the local day rollover and after a restart without one (`actRollover`, `cf_today`).

### 2.4 The per-host index (id → day files)
- Today: `actIndex` in `bridge.mjs` maps ENTRY id → (day, offset), in memory, ≤ 100 000, rebuilt only for the replay window.
  Paging a node's history scans files backwards and filters by path (`filePage` + `fileEntryMatches`).
- v6 adds a SIDECAR per closed day: `activity/<host>/v6/YYYY-MM-DD.idx.json`, written once (atomically) at the day rollover
  for yesterday's v6 file, and rebuilt by one scan when missing or when `size` doesn't match the file (v5 days have the
  conversion's `legacy/<day>.map.json` instead, §7.1):
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
- Retention deletes a day's files together: the v5 `<day>.jsonl` (as today), `v6/<day>.jsonl`, `v6/<day>.idx.json` and
  `v6/legacy/<day>*.map.json` (`prune` and `days()` learn the new names — exact-name patterns only, §10).

---

## 3. Resolution rules

Every call has a SCOPE: the session, or the agent `--agent` / `agent` names (§1.5). A call's TARGET is: `--key`'s node, else
`--id`'s, else `--path`'s, else the `--agent` node, else the session root.

### 3.1 `--key` (your own node)
- Looks in YOUR scope only. Found → that node. Not found → CREATED there (a context; `--under` / `--label` / a position apply,
  §3.5). Never looks in another scope: an agent's `--key docs` never lands in the session's `docs`.

### 3.2 References (`--under`, `--before`, `--after`, `--move`, `--merge`, `--to`)
A reference is, by its syntax (keys can't contain `@`, `/` or `:` outside the chain):
- `chain:key` — exactly that scope (`spec-89:docs`; `:88` = the session's `88`). Missing → `unknown-node`.
- a bare key — YOUR scope, then your creator's, … up to the session's (lexical scoping). First hit wins. So an agent's
  `--under 88` finds the orchestrator's `:88` without knowing the notation.
- a path (starts with `@`, or contains `/`) — §3.3, without creating (`unknown-node`).
- the tool and the dashboard also take `*_id` fields (`under_id`, `to_id`, `before_id`, `into_id`) — exact, no lookup.

### 3.3 `--path` (the shorthand)
1. **The current tree.** Walk from the session root (or from the `--agent` node when one is given: the old `agent` + `path`
   concatenation, `resolveAddress`), each segment matching a CHILD by kind (`@` = context, else agent) and label
   (case-insensitive). An agent segment also matches by key (paths of path-created agents are keys anyway).
   - **Same label twice** (labels aren't unique, §9 Q5): prefer a child created by the caller's scope, else the OLDEST
     (created_at, then id) — deterministic, never a failure — and warn `ambiguous-path` with the candidates' keys + ids.
2. **Aliases.** No match → the session's ALIAS table: `lc(old display path) → id`, filled by every move / label / merge
   (`was`) and by the conversion (§7). The longest alias that is a prefix of the path wins; the rest of the path resolves
   below that node. Warning `alias` ("@#88/@Docs is now @Later/@Docs") so a caller learns the new name.
3. **Create.** Still nothing → the missing tail is created (intermediates implicit, as 6a), each with key = slug(segment)
   (`-2` on a clash), creator = its OWNER (§3.4), label = the segment. An `@~` last segment, text prefixes, `@root` — unchanged
   (`parsePath`, `splitPrefix`, `finishSegs`).
- **Alias lifetime:** an alias lives while it is useful and safe: (a) the LIVE tree always wins (an alias is consulted only
  when the path names no live node), (b) it is dropped when its node is removed or merged-away-and-gone, and (c) it expires
  `log_retention_days` after it was made unless used (each hit refreshes it; carried in `cf.aliases`, ≤ 16 per node, newest
  kept). **Collision:** two aliases with the same path → the NEWEST wins (the most recent thing that was there).

### 3.4 Who creates a path-created node
- Its OWNER at creation: the nearest agent at or above its new parent, else the session (today's `ownerIndex`). Path callers
  report as the session (`aimb-log --session`), so "the caller" would put every node in the session's scope and clash keys
  across agents; the owner rule gives `spec-70/@Tharsis` the key `spec-70:Tharsis`, as a human reads it.

### 3.5 Create is idempotent; location only at creation
- `--key docs --under X --label L` on an EXISTING node changes NOTHING structural: `--under`, `--label`, `--before` / `--after`
  are ignored with warning `exists` when they differ (hole H2: re-applying them would let an agent's retry, or a prompt
  replayed after a compaction, undo a human's dashboard move or rename). Changes are explicit verbs: `--move`, `--rename`,
  a position alone (reorder: no `--under`, existing node — as #82).
- So a retry after a lost response never duplicates and never moves anything; the text / state / bar of the retry apply as a
  normal report (a logged retry logs twice — as today; `--stream`'s "not resent" rule is unchanged).
- `--item docs "…"` when `docs` exists ELSEWHERE in your scope: no new item; result `{key, created:false, path, warning:
  "exists-elsewhere"}` (a dashboard may have moved it).

### 3.6 Merge
- `--key A --merge B` (dashboard: Merge into…): A's line ends (its last line stays an entry), A leaves the board, A's CHILDREN
  move under B (end of their groups), and A becomes a hidden child of B (`merged_into`): B's subtree log therefore includes
  A's entries with no rewrite (§5.1). A's key and A's paths become aliases of B (`--key A` in A's scope now targets B, warning
  `merged`).
- Allowed: context → context, plan item → plan item or context, same session and host. Refused `bad-merge`: A = B, B under A,
  A or B an agent (an agent is a key namespace — §9 Q6), the session root, A holding an OPEN question.
- Plans: A leaves its plan ("N of M" drops it); if A was the last open item, the plan may end as usual.
- **Reversible:** `--key A --unmerge` puts A back under its pre-merge parent (the merge record's `from`) as a plain context,
  line-less; its children stay with B (move them back if wanted). The scope index still maps A's key to A's id — only target
  RESOLUTION redirects a merged node to B, and `--unmerge` skips that redirect. The entries were never touched, so the split
  is exact. v2.0: tool + script only, not on the dashboard (§9 Q6).

### 3.7 Reusing a finished key
- The node still exists (done / failed / abandoned / skipped, in memory) → the SAME node, revived exactly as today (a running
  line revives an agent — `apply`'s `finished_at = null`; a plan item reopens). The snippet says new work takes a new key.
- The node was removed (expired / evicted / dismissed: a GHOST) → `create` with the SAME id and `run:true` → a NEW RUN of it;
  its old entries are an earlier run ("show earlier runs", §5.3). Same rule as today's re-used path name.

---

## 4. API

### 4.1 Script flags (`tools/aimb-log.mjs`)
| Flag | Meaning |
|---|---|
| `--agent <chain>` | the agent you report as (your scope); created if new — a NEW meaning that equals the old one for path-created agents (§1.5) |
| `--key <k>` | your node (§3.1); created if new (a context) |
| `--id <id>` | a node by internal id (the dashboard's copied command) |
| `--under <ref>` | where a NEW target goes (default: under the scope — the session root or your agent node) |
| `--label "<text>"` | a NEW target's label (default: the key) |
| `--item <k> "<label>"` | a ☐ plan item under the target, repeatable, in order; `--item "<label>"` (one value) = label only, key = slug — the 1.66 form, matched by LABEL under the target first (today's re-plan rule) |
| `--before <ref>` / `--after <ref>` / `--first` / `--last` | place new items or a new target; on an existing target alone = reorder (#82) |
| `--move <ref>` | move the TARGET under `<ref>` (+ a position); the old `--move <node> --to <parent>` path form still works (told apart by `--to`) |
| `--rename "<label>"` | the target's new label |
| `--merge <ref>` / `--unmerge` | §3.6 |
| `--text "<text>"` | KEY MODE (`--key` / `--id` / `--agent` without `--path`): sets the target's current line (with `--state`); PATH MODE: as today (`@~` prefix sets the line, else logs only) |
| `--note "<text>"` | key mode: log only, the line unchanged (§9 Q1) |
| `--path`, `--ctx`, `--state`, `--done`, `--progress`, `--eta`, `--stale-after`, `--details`, `--data`, `--no-log`, `--ask` …, `--stream`, `--batch` | unchanged |
- `--item k "label"` parsing: two values unless the second starts with `--`; a first value that isn't a valid key (spaces …)
  is the one-value legacy form. `--key` with `--path` → `bad-address` (one way to name the target).
- Against a gateway older than 2.0.0 every new flag is refused `gateway-unsupported` (the `verLt(m.bridge_version, …)` gate,
  as #82 / #85 do), before anything is sent.

### 4.2 The `log` and `activity` tools
- `log` adds `agent` (now the chain; the old agent-path form is the same string), `key`, `id`, `under` / `under_id`, `label`,
  `plan:[ "label" | { key, label } ]`, `before` / `after` / `*_id`, `move` (with `key` / `id`: the new parent; with `to`: the
  old form), `move_id`, `rename`, `merge` / `merge_id`, `unmerge`, `note`. Batch items take the same; `agent` is a batch default.
- **Results always name the node:** `{ ok, id:<ENTRY id, as today>, ts, node:{ id, key, scope:"spec-88", label, path, kind,
  created? }, state, current, logged, stale_at, … }`; `plan:[{ key, id, label, path, created, plan_item, state, warning? }]`;
  `moved:{ from, to, parent_id }`, `merged:{ into_id, path }`, `warnings` (`exists`, `exists-elsewhere`, `alias`,
  `ambiguous-path`, `merged`). The top-level `id` stays the entry id (hole H13) — the node id is `node.id`.
- `activity` board nodes gain `id`, `parent_id`, `key`, `scope`, `label`; `path` (computed now), `parent` (path) and `kind`
  stay; `log:{ id | path …, earlier? }`; `entry:{ id }` unchanged. The logger WS `wait_answer` takes `node_id` beside `path`.

### 4.3 `{log_snippet}` (each line ≤ 110 characters — measured)
The command line becomes `Report your status with: "<node>" "<script>" --session "S" --project "P" [--token-file "…"]
--agent <your-key> --under <item-key>` (the orchestrator fills both; `--under` only matters on the first call). Lines:
```
- --key <k> names YOUR node: made on first use (--under <k> sets where, --label "…" its name); then --key <k>.
- --key <k> --state running --text "<what>" sets its line; --note "…" only logs; no --key = your own line.
- Report at milestones only (calls cost tokens); add --stale-after 60m before a long silent step.
- --item <k> "<label>" (repeat it) adds ☐ plan items under the node; tick one with --key <k> --done.
- A used key reopens its node: new work gets a new key (docs-2). Keys: letters, digits and _ . # + -
- Finish with --state done --text "<summary>" (or failed). Never put secrets in status text.
- Need a decision? --ask "…" --choice "A" --choice "B" --wait 30m waits for the answer (exit 0 = answered).
```
(110, 106, 97, 100, 100, 92, 107 characters.) `{log_tool_hint}` gets the same seven in tool form (`key:"…"`, `plan:[{key,
label}]`); the realm reminders' orchestrator briefing says "give each agent `--agent <key> --under <item key>`".

### 4.4 Path-only callers
- Old snippets, 1.66 – 1.72 scripts, briefings: `--path` keeps working, resolved by §3.3 — after a move or rename the old path
  is an alias, so an agent still writing it lands in the moved node (today it would recreate the node at the old path).
- Results carry `node` (key + id) and an `alias` warning when the path was stale, so a caller can switch.
- Nothing is deprecated in 2.0. The snippet and the tool description lead with keys.

---

## 5. Logs and display

### 5.1 A subtree's merged log
- MEMBERSHIP = the queried node + every node whose parent chain reaches it NOW: live nodes (`sess.nodes`), hidden merged nodes
  (§3.6), and GHOSTS — nodes no longer in memory (expired, evicted, dismissed) whose last parent is in the subtree. The ghost
  table (id → { parent, key, creator, label, kind, removed_at }) is rebuilt at startup from the sidecars' `struct` across
  retention plus the replay, and gains a row whenever a node leaves memory. Without ghosts a parent's log would LOSE a removed
  child's entries (hole H5 — worse than today's #76 gap); with them #76 is fixed.
- Memory: `logView`'s k-way merge over the members' own logs, unchanged except keys → ids. A move changes membership, so the
  old parent's log no longer shows the moved child's entries and the new parent's does — "history follows the node".

### 5.2 Paging the day files through the index
- `filePage` keeps its shape (newest first, `need`, `maxBytes`, `scanBytes`, cursor `f1.<day>.<offset>`), but `target` is a
  SET of ids and the match is `ids.has(rec.n)` — no path, no aliases, no `matchAlias`.
- `actLogPage` asks the index which days hold any member and the byte range [min first, max last] in each; it reads only those
  ranges (today: every file of the retention, `ACT_SCAN_BYTES` ≤ 8 MB per page). A day without a sidecar is scanned whole.
  Below the v6 days it continues into the v5 days (until retention removes them): same ranges from the map's `nodes`, and
  each record's id from the map (offset → id), never from its path.

### 5.3 Runs and "show earlier runs"
- A node's run begins at its `create` (`run:true`) or a carry-forward's `run_at`. Paging stops at the queried node's run
  start (`run_start`, `earlier_cursor`, `pruned` — 6c's contract, unchanged for the page).
- **Per member:** each member contributes the entries of ITS OWN current run; "show earlier runs" adds earlier runs. So a node
  MOVED IN shows its whole run at once (answers #82's "the new parent's merged log stops at ITS run start").

### 5.4 The dashboard tree
- Units: `dashUnits` id = `["n", groupKey, lc(host), nodeId]` (was the path key); `parent_id` (was `parent_key`); rows,
  `ACT.open`, selection (`selKey`), pins / hidden, feedback and drag-and-drop all key by id. Rows keep `data-path` for display
  and copying.
- Actions send `{type:"activity_action", ref, host, session, project, user, id, action, args}` with id-valued args (`to_id`,
  `before_id`, `after_id`, `into_id`) — no path quoting, no `sibRef` names (`@"name"` breaks on a `"`).
- New menu items: **Rename…** (label ≤ 60), **Merge into…** (picker: contexts of the same session and host, then confirm).
  Unmerge: not on the dashboard in 2.0.
- Log entries show `at` on hover when it differs from the node's path now. Copy command = `--agent <scope> --key <key>` (or
  `--id <id>` when the node has no key path).
- Per-viewer storage (pins, hidden — `aimb.act.pins` / `aimb.act.hidden`) is keyed by unit id: on the first board after the
  upgrade the page maps each stored `["n",gk,host,pathKey]` id to the unit with that path (once, try/catch), so pins survive.

### 5.5 Notice subjects
- #80 / #83 / #84 / #85 subjects use `displayPath` of the node's CURRENT path at SEND time (a batch is flushed seconds later:
  computed at flush, from the id). Bodies gain `node_id`, `key`, `scope` beside `path`. New verbs: none; `rename` / `merge`
  are `activity_changed` actions ("robin renamed @Rel/@Docs to "Write the README"", "robin merged @Rel/@#79 into
  @Rel/@#79 three-part progress").

---

## 6. Gossip and compatibility

### 6.1 The v6 slice
- `ACTIVITY_SLICE` body `v:6`: one unit per node (`snapNode`), `path` replaced by `id`, `p` (parent id), `c` (creator id),
  `key`, `label`, `nk`; everything else as v5 (`current` without details/data, `progress`, `rank`, `plan_item`, `log_n`,
  `plan_end` …). No path in the unit: a rename or move then changes ONE unit, not every descendant's (a path would). The root
  unit carries `root:true`. Merged nodes are not sent. `remove:[{…session, id}]` (a node and its subtree, as today).
- Deltas, epochs, the byte cap, newest-active first, the 1 frame/s rule: unchanged (`planSlice` / `applySlice`).

### 6.2 Projecting v5 for hosts up to 1.72
- A link to a peer WITHOUT `activity_ids` gets v5 slices computed from the current tree (`snapNode` v5 shape): `path` = each
  node's v5 PROJECTION — agent segment = its KEY (keys are valid agent segments), context segment = its label sanitised to v5
  rules (`/` → `∕`, `"` → `”`, control → space, > 60 → cut), `@~` impossible. Two siblings whose projections collide (same
  label) → ` (2)`, ` (3)` by created order. Hidden merged nodes are left out. The same projection is the entry's `at` (§2.2).
- A v5 slice FROM an old host is converted on receipt: id = legacy id (§1.2) of each path, parent id from the parent path,
  key = slug(segment), label = segment. Stable while the path is; a move there is remove + add, as today.

### 6.3 What an old host sees
- **Move / rename** on a v2 host: the node's v5 path changes → the old host gets a removal at the old path + a new node at the
  new path (`planSlice`'s per-unit diff does it) — the same as an old host's own moves look to it today.
- **Merge:** A disappears; B's counts / log grow.
- **History:** a 1.72 dashboard asks `ACTIVITY_REQ {op:"log", q:{path…}}` → the v2 owner resolves the path (§3.3, aliases
  too) and serves the id-based page; entries carry `path` = the node's projected path now and `rel` (v5 shape). `entry:{id}`:
  entry ids are unchanged.
- **Actions from a 1.66 – 1.72 dashboard** (`ACTIVITY_ACT` with `path`, `args.to` a path, `before` / `after` names): the v2
  owner resolves them to ids (`applyAction` takes `id` OR `path`) — they keep working.

### 6.4 Capability flags
- **Hole H3:** a 1.72 peer adopts activity only when `hello.activity_gossip === 5` (`bridge.mjs` `actLinkInit`: `cap: …
  hello.activity_gossip === Act.ACTIVITY_FORMAT`). A v2 hello saying `activity_gossip:6` would cut every old peer off. So the
  v2 `peerHello` KEEPS `activity_gossip:5` (plus `activity_plan:1`, `activity_msg:1`, `activity_ask:1`) and ADDS
  `activity_ids:1` = "I speak v6 slices, id-addressed ACTIVITY_REQ / ACTIVITY_ACT and the rename / merge actions".
- Per link: both `activity_ids` → v6 frames; else v5 projection both ways. A v2 receiver accepts body `v:5` and `v:6`.

### 6.5 Mixed-mesh actions
- v2 dashboard → v2 owner: by id.
- v2 dashboard → OLD owner (its units came from v5 slices): the v2 gateway translates to the v5 form from the units it holds —
  `path`, `args.to` = the target's path, `before` / `after` = `sibRef`-style names. `rename`, `merge`, `unmerge` → refused
  `owner-unsupported` ("… runs a bridge older than 2.0.0") before anything is queued (as #82 / #83 / #85 gate theirs).
- Old dashboard → v2 owner: §6.3. A v2 FOLLOWER never meets a 1.7x gateway (one install per host); a 1.7x script against a
  v2 gateway: path-only, fine.

---

## 7. Migration

**The persistence folder is Dropbox-shared** between ROBIN-Z790 and LITTLE-001 (one repo folder, `src/` and `persistence/`
included), and either may still run 1.7x while the other runs 2.0. So the migration follows §10's rules: it never rewrites or
renames an existing day file. The v6 world is written ALONGSIDE the v5 files, in the host's own `activity/<host>/v6/`
directory, and the v5 files stay byte-identical (a 1.7x bridge's `days()` lists only `YYYY-MM-DD.jsonl` names in the host
directory itself, so it never sees `v6/`). An in-place rewrite isn't needed: a per-day MAP (legacy record → node id) gives the
v6 reader everything a rewrite would have, without a second copy of the history.

```
activity/<host>/                    (lslug(host) — written ONLY by that host's gateway, as today)
  2026-10-01.jsonl …                v2–v5 day files: after the upgrade READ-ONLY to 2.0; pruned by retention as today
  v6/
    2026-10-03.jsonl …              v6 day files (every record 2.0 writes)
    2026-10-02.idx.json …           per-day sidecars of v6 days (§2.4)
    legacy/
      2026-10-01.map.json …         one per v5 day file: its records → node ids (+ the day's id offsets, for paging)
      baseline.jsonl                the converted board: one v6 cf per live node + one node record per ghost
      state.json                    the forward pass's end state (path → run id), for a re-upgrade after a rollback
    format.json                     the conversion marker — written LAST
```

### 7.1 What converts, when
- On the first start of a v2 GATEWAY whose `activity/<host>/v6/format.json` is missing (or lists a v5 day file at a smaller
  size than it has now, §7.3), BEFORE the replay: `convertActivity()` reads the host's retained v5 day files OLDEST FIRST
  (read-only) and runs a CHRONOLOGICAL forward pass (pure: `lib/activity.js convertV5(records)`), which is far simpler than
  #82's newest-first remapping:
  - a path map `pathKey → run`; a record at a path joins the run there, or starts one (and its missing ancestors); a record
    whose `new_from` is at or above a node that is held starts a NEW run there (the old one ended unseen — expiry); `moved_from`
    re-keys the run (and its subtree) to the new path; `dismiss:true` and `evicted:[…]` end the runs at / under that path.
  - At the end every run has a FINAL path. **Id = legacy id of the final path** (hole H7: "hash(host, session, path)" didn't
    say which path — a moved node has several; the final one is what a peer derived from the last v5 slice, §6.2). Runs that
    share a final path share the id — earlier runs of one node, exactly as today's run boundary treats a re-used name.
  - Keys: the live tree's nodes get key = slug(segment) in their owner's scope (agents: the segment itself unless it has a `:`),
    `-2` … on a clash, in created order. Dead runs get a key only if their id isn't live (a ghost).
- **Outputs** (all NEW files in `v6/legacy/`, each written whole and atomically with the facet's `writeAtomic` — `*.tmp` then
  rename OF THAT NEW FILE, the established pattern of architecture.md §12 "The substrate", invariant 4; readers skip `.tmp`):
  - **`<day>.map.json`** per v5 day file — exact, per record, so the reader needs no logic of its own:
```json
{"v":1,"day":"2026-10-01","size":1843211,"sha256":"9f2c…","ids":["2czd5q2puuwp5xi4","hijrhd6rgrortbzg"],
 "at":[0,412,1290,1702],"ix":[0,0,1,1],"nodes":{"2czd5q2puuwp5xi4":[0,412,2],"hijrhd6rgrortbzg":[1290,1702,2]},
 "runs":{"hijrhd6rgrortbzg":[1290]}}
```
    `at[i]` = a record's byte offset (entries, cp, cf — the records the forward pass assigned), `ids[ix[i]]` = its node;
    `nodes` = [first, last, count] of ENTRY offsets per id (the sidecar's shape, §2.4); `runs[id]` = offsets of records that
    BEGAN a run of it (§5.3); `size` / `sha256` = the bytes it covers. ~12 bytes per record.
  - **`baseline.jsonl`** — one v6 `cf` per live node (structure, aliases = the old paths of its runs and its `moved` list,
    state, `log_n`, `run_at`, `floor` = the conversion point) and one `node` `remove` record per ghost with entries in
    retention (parent / key / label / kind, for §5.1). Its `ts` values are the newest legacy record's time, never "now".
  - **`state.json`** — the pass's end state: every live run's v5 path key → its id, and the ids taken (§7.3).
  - **`format.json`** LAST: `{"v":6,"bridge":"2.0.0","days":{"2026-10-01":{"size":1843211,"sha256":"9f2c…"},…}}`.
  - Every output is a PURE FUNCTION of the v5 files (no wall-clock time, no machine name): converting twice — or on two
    machines — gives byte-identical files.
- **Reading afterwards:** the v6 replay reads `v6/` day files newest first and then the newest `baseline*.jsonl` as the oldest
  v6 input — always, whatever its age (its `ts` is the newest legacy record's, which may lie outside the window); anything
  newer in `v6/` overrides it, and the `cf` written right after the conversion (`actRollover('startup')`, as today when a day
  has none) carries everything forward from then on. The usual `expire` runs at the end of the replay, as today. In-memory logs start
  empty at the conversion point (`floor`), so a log page goes to the files below it (6a's floor rule): `v6/` days by
  `n`, then v5 days through their map (offset → id) — the v5 reader is ~20 lines (a binary search over `at`).
- The v5 files are pruned by retention as today (`prune` keeps deleting `YYYY-MM-DD.jsonl` by date; it now also deletes the
  same day's `v6/<day>.jsonl`, `.idx.json` and `legacy/<day>.map.json`). After `log_retention_days` (7) no v5 day is left and
  the legacy reader goes quiet; it can be deleted in a later release (§9 Q24).

### 7.2 Questions, plans, ranks, `moved_from` (#82, #85)
- Plan items: `plan_item` / `plan_ix` → the node's attributes (baseline `cf`). Questions: the line's `question` unchanged;
  `@?N` → key `?N`. Ranks: stored ranks copied as they are (a rank is relative to siblings, never to a path). `plan_end`,
  `line_by`, `cpartial` / `log_n`: kept. `moved_from` / `cf.moved`: consumed by the forward pass; the OLD paths become aliases.
- 6d dismissals: end runs (no `remove` records are invented for history; the baseline lists ghosts).

### 7.3 Safe to run twice; rollback; re-upgrade
- **Idempotent:** nothing existing is touched; each output is a whole new file written atomically; `format.json` is last.
  A crash midway → no `format.json` → the next start converts again and writes the same bytes (an output that already exists
  with the same content is left alone). Stale `*.tmp` files in the host's own `v6/` are deleted on start (own directory only).
- **Rollback is free:** stop 2.0, start 1.7x. It reads `activity/<host>/YYYY-MM-DD.jsonl` — byte-identical to before the
  upgrade — and never lists `v6/`. Its board is the board AT THE UPGRADE; what 2.0 did meanwhile is in `v6/`, invisible to it.
  No file operation, no lost history.
- **Re-upgrade after a rollback:** 1.7x appended to the v5 day files (today's grew; new days appeared). `format.json` records
  each converted day's size, so 2.0 sees which files grew and converts only the TAILS — the forward pass SEEDED from
  `state.json` (1.7x continued from the at-upgrade paths, so its records map to the same ids even where 2.0 has moved those
  nodes since); runs that are new in the tail get fresh legacy ids (a clash with a taken id → the path + `#2`). Outputs, all
  NEW write-once files: a TAIL map per grown or new day (`<day>.<fromOffset>.map.json`, covering the bytes after the old size),
  a `baseline-2.jsonl` of snapshots for what the tail changed, `state-2.json`, then `format.json` again (the marker is the one
  file the host rewrites — atomically, its own, last). Where 2.0 and 1.7x both
  changed the same node (a line, a parent), the NEWER change wins (by time). The one seam left (§9 Q25).

### 7.4 Shared folder: two hosts, one Dropbox
- Each host converts ONLY `activity/<its own host>/` — the directory its gateway already owns (`persistActivity` writes only
  `HOSTNAME`'s files; `pruneActivity` prunes only them). ROBIN-Z790 converting never touches LITTLE-001's files and vice versa,
  so the two can convert at the same moment, or days apart, or one can stay on 1.7x for good.
- **Ids can't collide across hosts:** every id hashes `lc(host)` (§1.2), and each host's ids are a pure function of its own
  files. A peer that derives a legacy id from a v5 slice (§6.2) uses the same function on the same inputs (origin = the link's
  host, the session, the lower-cased path), so it gets the id the owner will convert to.
- A 1.7x bridge on the other host keeps working against the same folder: it never reads another host's activity directory,
  never lists `v6/`, and its own files are its own.
- The full rule set is §10.

### 7.5 How long it takes
- Prototype (scratch, this machine): parse + legacy-id + stringify of synthetic v5 records ran at ~230 – 260 MB/s — 10 000
  records (3.9 MB) 17 ms, 50 000 (19 MB) 80 ms, 200 000 (77 MB) 300 ms. The forward pass adds a Map lookup per record.
- Realistic: 7 days of retention at 1 – 10 MB a day (a busy agent day is ~5 000 entries ≈ 2 MB) = 7 – 70 MB read → under 1 s
  CPU. It WRITES only the maps (~12 bytes a record: 0.1 – 2 MB), the baseline and two small files — so Dropbox uploads a
  few hundred KB, not a second copy of the history. It runs before the replay; `log` calls wait for it as for the replay
  (`ACT_LOAD_WAIT_MS`, 15 s, then `activity-loading`). It logs what it did ("activity: converted 7 day files, 41 233 records,
  812 nodes (17 ghosts) in 1.4 s").

---

## 8. Build plan
Each step lands green (`npm test`, typecheck included) and is reviewable alone. Steps 1 – 4 are pure library work behind a
PATH-COMPATIBLE surface (`parseMessage` / `apply` / `applyAction` still accept paths), so the bridge and the 2 740 existing
checks keep passing while the core changes underneath.

1. **Identity primitives** (`lib/activity.js`, new section): `mintId`, `legacyId`, `validKey`, `slugKey`, `uniqueKey`, `parseRef`.
   *Tests:* unit — vectors (the ids in §1.2), case-folding, charset edges (`:`, `?N`, `root`, 48 / 49), slug clashes.
2. **The id-keyed model.** `sess.nodes` keyed by id; `sess.kids` by parent id; the scope index (creator id + lc(key) → id);
   aliases; ghosts. `apply` resolves the target (§3) and writes node records + entries; move / rename / merge / unmerge /
   item / remove become pointer changes + one record each; plans, questions, cascade, ranks, plan-end, eviction, expiry,
   `applyAction` (id or path) re-expressed on ids. 2a structure + resolution, 2b lines / plans / questions, 2c actions + notices.
   *Tests:* the existing `test_activity_unit` checks through the path surface (expected record shapes updated), plus new
   resolution / idempotency / merge / alias / ghost checks.
3. **v6 records + replay.** `recordKind` v6; `createReplay` folds node records (newest wins per field, `create` seals the run)
   and attaches entries by `n` — no remapping. cp / cf / rep v6; `planCarryForward` carries structure. *Tests:* a seeded
   REPLAY FUZZ like #82's (400 random sequences of reports, plans, moves, renames, merges, unmerges, dismissals, evictions,
   expiry, day rollovers with cf) — replay ≡ chronological apply (lines, bars, structure, logs, counts, runs).
4. **Conversion** (`convertV5` → maps + baseline + state, pure; `legacyNode(map, offset)`). *Tests:* a CONVERSION FUZZ —
   random histories applied with a FROZEN copy of the 1.72 library (`tests/fixtures/activity-v172.js`, from `git show`), then
   (a) its own replay and (b) baseline + v6 replay + map-based paging must give the same tree and pages (paths ↔ ids, lines,
   states, bars, plans, ranks, logs, counts, run boundaries); converting twice gives byte-identical outputs; a tail conversion
   (more 1.72 records after the first) ≡ converting everything with the frozen ids.
5. **Bridge files** (§7, §10). The `v6/` layout in the facet (`activity6.*`: append / replaceTail / readBackwards / days /
   prune under `v6/`, `writeAtomic` for the one-shot files), `convertActivity` (outputs, `format.json` last, the tail on a
   re-upgrade, stale `.tmp` cleanup), sidecars at rollover + rebuild, `prune` by date across both layouts, `actLogPage` via the
   index and the maps, the ghost table at startup, the conflicted-copy check. *Tests:* live — a fixture directory WRITTEN BY A
   REAL 1.72 GATEWAY (`git archive v1.72.0` build, `AIMB_TEST_OLD_BRIDGE`) with moves, plans, questions, dismissals over 3 days;
   hash every v5 file before; upgrade → board + logs equal AND every v5 file byte-identical; kill mid-conversion → restart
   converts again, same bytes; roll back to the 1.72 build ON THE SAME DIRECTORY → its board is the at-upgrade board, it
   appends; re-upgrade → the tail converts, a 1.72-era move of a node 2.0 had moved resolves newest-wins; a planted
   `2026-10-01 (LITTLE-001's conflicted copy 2026-10-03).jsonl` and `…idx (… conflicted copy …).json` are ignored and warned
   about; two gateways with DIFFERENT hostnames converting in one shared persistence dir at once write only their own
   directories.
6. **Gossip v6 + compat.** `activity_ids:1`, v6 frames, v5 projection, v5 receive → legacy ids, path-based ACTIVITY_REQ /
   ACTIVITY_ACT on a v2 owner, translation + `owner-unsupported` toward old owners. *Tests:* unit (projection: sanitising,
   collisions, depth); live mixed against the 1.72 `git archive` build — boards both ways, a move / rename / merge on the v2
   host as remove + add on 1.72, a 1.72 dashboard's skip / move on a v2 node, a v2 dashboard's skip on a 1.72 node, rename on
   it `owner-unsupported`, remote log pages both ways.
7. **Tool, script, snippet.** Flags + fields (§4), results, `gateway-unsupported` against < 2.0.0, `{log_snippet}` /
   `{log_tool_hint}` / the briefing, server instructions, README. *Tests:* `test_log_script_live`, `test_activity_6c_live`
   (the 8 pinned snippet lines), the tool schema.
8. **Dashboard.** Units / rows / actions / pins by id (+ the one-time pin map), Rename…, Merge into…, the `at` tooltip, the copy
   command — and the PATH FALLBACK: the page is served from disk, so on LITTLE-001 the 2.0 page can be served by a still-1.7x
   gateway (shared `src/`, §10); units without `id` → today's path-keyed behaviour, no Rename / Merge. *Tests:*
   `test_dashboard_activity` (jsdom) — ids through deltas, a rename / move keeping selection, pins and open state,
   drag-and-drop by id, the dialogs, a board with a v5 host's nodes, the whole page against a 1.72-shaped board.
9. **Delete #82's path machinery** (by now unused): `rekeySubtree`, `applyMove`'s re-keying, `remapSegs`, `remapGone`,
   `ensureIn`'s move use, `foreign`, `goneAt`, `deadAt`'s move clause, `sealRuns` / `sealNode`'s `except` / `recTs` / `own`,
   `movedAt`, `mv` / `mvAlias`, `node.moved` + `pt.m`, `nodeAliases`, `matchAlias`, `fileEntryMatches`' path match,
   `fileEntryView`'s alias remap, `fileRunStart`'s move clause, `moved_from` writers, the `cpLive` re-key. KEPT from #82: ranks
   (`rankBetween`, `placeRanks`, `siblingCmp`, `derivedRank`), the cascade, positions, the actions. The frozen 1.72 copy stays
   in `tests/fixtures` for the conversion fuzz. *Tests:* the full suite; a grep check that no `moved_from` reader is left.
   (The small map-based v5 reader stays until a later release, §9 Q24.)
10. **Release 2.0.0**: architecture.md §12 (the `v6/` layout) + §13, the RESUME STATE deploy notes (any order; ROBIN-Z790 and
    LITTLE-001 share `src/`, so updating one updates the other's next restart — restart both gateways together; nothing to
    publish in `config.json`), the live check on two real hosts.

---

## 9. Risks, holes and OPEN QUESTIONS

### Holes found in the #88 design (and the fixes proposed above)
- **H1** `:` is legal in agent names today (`SEGMENT`), so `fix-79:docs` is ambiguous → keys exclude `:` (§1.1).
- **H2** "registering an existing key updates it" lets a retry or a replayed prompt undo a dashboard move / rename → create
  attributes apply only at creation; changes are explicit verbs (§3.5).
- **H3** the PEER_HELLO check is an equality on `activity_gossip`, so announcing 6 would disconnect every 1.7x peer → keep 5,
  add `activity_ids:1` (§6.4).
- **H4** "a path creates a node whose key is the last segment": segments have spaces / `#` / `(`, and a path caller reports
  as the session, so whose key? → slug + creator = owner (§1.1, §3.4).
- **H5** a log "computed from the current tree" loses removed children's history (expired / evicted / dismissed) → ghosts
  (§5.1); this also closes #76.
- **H6** merging agents (key namespaces) and merging into one's own descendant are undefined → refused (§3.6).
- **H7** "hash(host, session, path)" for legacy ids: which path of a moved node? → the final path; reused paths share the id
  as earlier runs (§7.1).
- **H8** "a per-host index (id → day files)": today's `actIndex` is entry-id → offset, in memory, capped, rebuilt only for
  the window → persisted per-day sidecars (§2.4).
- **H9** free-text labels can't always be v5 path segments (`/`, `"`, agent labels with spaces) → the projection rules
  (§6.2); depth stays ≤ 6.
- **H10** the tool result's `id` is already the ENTRY id → the node id goes in `node.id` (§4.2).
- **H11** `--item <key> "<label>"` vs the 1.66 `--item "A"` → the parse rule in §4.1.
- **H12** "on first start, existing path-keyed history converts" reads as a rewrite — but the persistence folder is
  Dropbox-shared (ROBIN-Z790 + LITTLE-001) with a host that may still run 1.7x, and the project's rule is no file-rename
  migrations there (issues.md #47: "No file-rename migration on purpose"; architecture.md §12 invariants) → the conversion writes a map ALONGSIDE, in the host's
  own `v6/` directory, and never touches a v5 file (§7, §10).
- **H13** the shared folder also shares `src/`: the 2.0 `dashboard.html` and `aimb-log.mjs` can run against LITTLE-001's
  still-1.7x gateway (it serves the page from disk) → the page falls back to paths when units carry no `id` (§8 step 8); the
  script already refuses new flags by `bridge_version` (§4.1).

### Risks
- The replay and conversion are the risky parts; both get seeded fuzzing against a ground truth (chronological apply; the
  frozen 1.72 library). The live mixed test runs against a real 1.72 build, as every release since 1.69 has.
- A botched conversion costs nothing permanent: the v5 files are never touched, so deleting `v6/legacy/` + `format.json`
  (by hand, on that host) re-runs it; rollback needs no file operation (§7.3).
- Duplicate host names on two machines would make two writers of one host directory — today's files have the same risk
  (#70's duplicate-hostname WARN); §10's conflicted-copy check makes it visible.
- Bigger dashboard change than #82; the id-keyed units keep the delta machinery as is.

### OPEN QUESTIONS for Robin (answer by number; my recommendation after each)
1. **Line vs log in key mode.** Should `--text` with `--key` SET the node's line (and `--note` only log), or keep 6a's rule
   (only `@~` sets the line)? *Recommend: set the line* — agents almost always want "@~…", and with keys there is no `@~` to
   type; `--note` covers the rest. Path mode keeps 6a's rule.
2. **Idempotent create ignores location / label on an existing node** (warning `exists`) instead of "updating it". *Recommend:
   yes* (H2).
3. **Key charset** = today's agent-segment charset minus `:`, ≤ 48, case-insensitive; legacy agents with `:` get a slugged
   key. *Recommend: yes.*
4. **Creator of a path-created node = its owner** (nearest agent), not the reporting session. *Recommend: yes* (H4).
5. **Labels need not be unique** among siblings; a path picks the caller's own, else the oldest, with `ambiguous-path`.
   Alternative: refuse a create / rename / move that duplicates a sibling label. *Recommend: allow + warn* (merge fixes
   duplicates; refusing would make two agents' `--key notes --under 88` fail).
6. **Merge scope:** contexts / plan items only (no agents), reversible by `--unmerge` from the tool / script only. *Recommend:
   yes for 2.0*; a dashboard Unmerge later if wanted.
7. **Subtree log runs per member** (a node moved in shows its whole current run). *Recommend: yes* (closes #82's question).
8. **`at` on every entry** = the projected display path at the time (~100 bytes each), vs only the node's label then.
   *Recommend: the path* — it also serves old hosts' log pages and stays greppable.
9. **Rollback** (revised for the shared folder): with the side-by-side layout it is FREE — 1.7x reads its byte-identical
   v5 files and shows the board as it was at the upgrade; nothing is lost (2.0's work waits in `v6/`). A re-upgrade converts
   the 1.7x-era tails with the frozen ids; where both eras changed one node, the newer change wins. *Recommend: accept; the
   deploy notes say rollback is safe, with that one caveat.*
10. **Hello:** keep `activity_gossip:5`, add `activity_ids:1`. *Recommend: yes* (H3) — and drop v5 projection only in a later
    release once every host runs ≥ 2.0.
11. **Depth limit stays 6** (the v5 projection needs it; deeper trees later). *Recommend: keep.*
12. **Id = 16 base32 chars of sha256** (80 bits). *Recommend: yes* (12 would do; 16 costs ~4 bytes a record).
13. **Dashboard pins / hidden** mapped once from path ids to node ids. *Recommend: yes* (cheap; otherwise every pin is lost
    once).
14. **Cross-session / cross-host moves** stay out of 2.0 (ids allow them later: a cross-host move is a copy, since each host
    writes only its own). *Recommend: later.*
15. **Moving a LIVE agent** (#82's open question): with keys its next report (`--agent` / `--key`) lands in the moved node, and
    a path-only agent's lands there through the alias. *Recommend: allow, no refusal.*
16. **Version number** 2.0.0 (the record format and the identity change). Deploy in any order (compat both ways), all hosts
    within a day. *Recommend: yes.*
17. **Agents create themselves:** the briefing gives `--agent <key> --under <item key>` and the agent's first report makes its
    node, vs the orchestrator pre-creating each agent node. *Recommend: self-create* (one line in the prompt, no extra call).
18. **Ghosts + sidecars in 2.0** (they fix #76 and keep parent logs whole). *Recommend: yes* — without them id-based logs
    regress (H5).
19. **Old `--move <node> --to <parent>`** stays beside the new `--key X --move <parent>` (told apart by `--to`). *Recommend:
    keep both in 2.0; drop the old form from the docs only.*
20. **A merged node's key** keeps resolving to B (`merged` warning) until unmerged. *Recommend: yes* — an agent still writing
    to `#79` lands in `#79 three-part progress`, which is the point of merge.
21. **Side-by-side, not in place:** v6 day files in `activity/<host>/v6/`, v5 files left byte-identical and read through a
    per-day map, rather than rewriting v5 files with `n`. *Recommend: side-by-side* — no rewrite or rename in the Dropbox
    folder, free rollback, ~12 bytes a record of new data instead of a second copy (§7, §10).
22. **The map's grain:** exact per-record offsets (`at` / `ix`, ~12 bytes a record) vs per-run path intervals (smaller, but
    the reader re-derives ids from paths and times). *Recommend: per-record* — the reader stays trivial and can't drift
    from the conversion.
23. **Conflicted copies:** log a WARN (once per file per start / rollover) and show it in the board head (`fs_warnings`,
    a small notice on the dashboard); never read them, never delete them automatically. *Recommend: yes* — a conflicted
    copy may hold the only copy of some records, so a person decides.
24. **The legacy reader** (map-based paging of v5 days) goes quiet once retention has removed the last v5 day (7 days after
    the upgrade). *Recommend: keep it in 2.0, delete it in a later release* together with `convertV5`'s tail mode.
25. **Re-upgrade after a rollback:** both eras' changes to one node → the newer wins (by time). *Recommend: accept*; the
    deploy notes say "if you roll back, re-upgrade soon".
26. **Restart the two Dropbox hosts together?** Not needed for correctness — each converts only its own directory, and the
    page / script fall back against a 1.7x gateway. But `src/` is shared, so LITTLE-001 runs 2.0 at its next restart anyway.
    *Recommend: restart both gateways together*, as for earlier releases — one board version on both.
27. **Guard against a duplicate hostname** (two machines writing one host directory): refuse to CONVERT when the host's
    directory already shows conflicted copies of activity files, rather than just warn? *Recommend: warn only* (the same
    risk exists for today's day files; a refusal would leave that host's board empty).

---

## 10. Shared-folder (Dropbox) rules

ROBIN-Z790 and LITTLE-001 share the WHOLE repo folder through Dropbox — `src/` (code, `src/config.json`), the `persistence/`
store and so every `activity/<host>/` directory. The Mac and phub-lnx-01 have their own checkouts and configs. Dropbox gives no
locks and eventual consistency, and it makes a "conflicted copy" when two machines change one file. The persistence layout is
conflict-free because no two machines ever write one file (architecture.md §12 "The substrate": its four invariants), and the
shared config is read-only to the bridge (architecture.md "Policy file discipline"). #88 keeps both.

1. **Per-host writes only.** Every file #88 adds lives under the WRITING host's own `activity/<lslug(host)>/` directory, and
   only that host's gateway writes it — as today's day files (`persistActivity` → `HOSTNAME`): the v6 day files, the per-day
   sidecars (`v6/<day>.idx.json`), the conversion's maps / baseline / state (`v6/legacy/`) and the marker (`v6/format.json`).
   Node records and aliases live inside the host's own v6 day files and `cf`s; the ghost table and the alias table are
   in-memory, rebuilt from those files — no separate shared file. Nothing goes in a shared directory and no host ever writes
   another host's directory.
2. **Write-once where possible; atomic always.** The v6 day files are appended (single writer, as today, with the existing
   in-place rewrite of the trailing `rep` line — the host's own file). Every other new file is written WHOLE, once, through the
   facet's `writeAtomic` (`*.tmp` then rename of that new file; readers skip `.tmp`). The only file a host ever replaces is its
   own `v6/format.json`, last, atomically (§7.3).
3. **The migration never rewrites or renames an existing day file.** It reads the v5 files and writes NEW files beside them
   (§7). The v5 files stay byte-identical (the live test hashes them before and after), so a 1.7x bridge — on the other host,
   or after a rollback on this one — reads exactly what it wrote. Retention deletes old days as it does today (by date, own
   directory only); deleting is not rewriting, and a 1.7x host prunes the same names the same way.
4. **Each host converts only its own directory** and is correct while the other host runs an older bridge on the same folder:
   a 1.7x gateway reads only `activity/<its host>/`, lists only `YYYY-MM-DD.jsonl` names there (`days()`), and never sees `v6/`.
5. **Two hosts converting at once:** disjoint directories, so no file collides; every id hashes the host (§1.2), so ids never
   collide across hosts; and every conversion output is a pure function of that host's own v5 files (no wall-clock time, no
   machine name inside), so a repeat — even a race between two writers — produces the same bytes. Each host's legacy ids equal
   what its peers derive from its v5 slices (§6.2, §7.4).
6. **Nothing in #88 writes `config.json`.** The bridge never writes the shared `src/config.json` (unchanged policy). #88's
   text changes (the snippet, `{log_tool_hint}`, the tool descriptions) are code; the briefing change in the realm reminders
   ships in `config.example.json`, and publishing it into the shared `config.json` stays Robin's manual step, as every release.
   No new config key is needed (§9 asks none).
7. **Conflicted copies are detected and ignored.**
   - Dropbox names them like `2026-10-02 (LITTLE-001's conflicted copy 2026-10-03).jsonl` (also "Case Conflict" variants) —
     the original name with a parenthesised note before the extension.
   - **Ignored:** every reader matches EXACT names: `^\d{4}-\d{2}-\d{2}\.jsonl$` (today's `DAY_RE` filter in `days()` already
     rejects such a name), `^\d{4}-\d{2}-\d{2}\.idx\.json$`, `^\d{4}-\d{2}-\d{2}(\.\d+)?\.map\.json$`, `^baseline(-\d+)?\.jsonl$`,
     `^state(-\d+)?\.json$`, `^format\.json$`. Anything else is never read.
   - **Detected:** at gateway start and at each day rollover the gateway lists its own `activity/<host>/` (it already does, for
     `days()`), and any name containing "conflicted copy" or "Case Conflict" — or any non-`.tmp` name matching none of the
     patterns — is logged once as a WARN ("activity: Dropbox conflicted copy '…' in activity/ROBIN-Z790 — two machines may be
     writing as host ROBIN-Z790 (a duplicate hostname?); it is ignored — check it and delete it by hand") and listed in the
     board head (`fs_warnings`, §9 Q23). It is never deleted automatically: it may hold the only copy of some records.
   - With single writers a conflicted copy should never appear; one means two machines wrote as one host (duplicate
     hostnames — #70 already WARNs on those) or a hand edit. Other hosts' directories are not checked (each host checks its own).
8. **Shared code:** both hosts run the same `src/` files. A gateway started before the update keeps the old code in memory;
   anything loaded fresh — a script run, the dashboard page (served from disk on each request) — is the NEW code, possibly
   against an OLD gateway. So the 2.0 `aimb-log.mjs` refuses new flags against a gateway below 2.0.0 (`bridge_version`), and the
   2.0 `dashboard.html` falls back to paths when the board's units carry no `id` (H13).
