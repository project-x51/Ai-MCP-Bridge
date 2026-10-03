# Ai MCP Bridge

A peer-to-peer mesh that lets **AI sessions** (Claude Code, Claude Desktop / Cowork, subagents) and
**web pages** talk to one another over MCP — directed messages, hierarchical topics, publish/subscribe,
durable offline mailboxes, receiver-controlled cross-project consent, and (opt-in) a single realm spanning
multiple machines over Tailscale. Message bodies are end-to-end encrypted; the bridge routes without reading
them.

It runs as a plain `node` **MCP stdio server** — no build step, no long-running service to install. One
bridge process per MCP client; the first process to bind the control port on a machine becomes that host's
**gateway** (roster holder + WebSocket ingress for page leaves + the debug dashboard). Everything else is a
follower or a sub-peer.

## Quickstart

1. **Node 20+**, then in `src/`: `npm install`.
2. Copy `src/config.example.json` → `src/config.json` and set a long random `token` (shared by every bridge
   in the realm). `config.json` is gitignored — it holds your token and must not be committed.
3. Register the MCP server with your client (template: `src/claude_code_mcp.example.json`):
   - **Claude Code** — project `.mcp.json` or `~/.claude.json`.
   - **Claude Desktop / Cowork** — `claude_desktop_config.json`. One process serves every Cowork
     conversation, so each conversation calls `register_self` (own name + self-invented secret) to get its
     own identity and private inbox.
4. Restart the client. The first session up becomes the gateway; open the live dashboard at
   `http://127.0.0.1:<wsPort>/?token=<token>`.

## 2.0 — upgrading from 1.7x

**2.0.0 (#88, "stable node identity") is a clean cutover.** Every activity-board node gets a stable internal id; a move or
rename is one record, nothing is rewritten. 2.0 speaks only 2.0 between hosts (activity format 6), so **all hosts upgrade
together**: stop every bridge on every host, update the code, run `node src/tools/aimb-migrate-v2.mjs --dry-run` and then
`node src/tools/aimb-migrate-v2.mjs` on each host (it converts that host's own `persistence/activity/<host>/` in place,
verifies it and restores on any failure), then start the bridges in any order. A 2.0 gateway refuses to start (exit 78,
with the command to run) on history that is not converted. There is no rollback once a host is migrated. The step-by-step
runbook, per host (Windows tray, Mac, Linux), is **[`docs/cutover-2.0.md`](docs/cutover-2.0.md)**.

## The activity board (2.0 forms)

Sessions and their agents report what they are doing to a shared board on the dashboard: from a shell with
`src/tools/aimb-log.mjs`, from Cowork (no shell) with the `log` tool. The full rules are
[`docs/spec-88.md`](docs/spec-88.md) §3 – §5; in short:

```bash
# an agent's first report: prints the rules and puts it on the board under its plan item
node src/tools/aimb-log.mjs --session S --project P --agent docs-agent --label "Docs agent" --under docs --guide agent
# its checklist, then work on an item, tick it, finish
node src/tools/aimb-log.mjs --session S --project P --agent docs-agent --item readme "Rewrite the README" --item arch "Architecture entry"
node src/tools/aimb-log.mjs --session S --project P --agent docs-agent --key readme --state running --text "@Rewriting the README"
node src/tools/aimb-log.mjs --session S --project P --agent docs-agent --key readme --done
node src/tools/aimb-log.mjs --session S --project P --agent docs-agent --state done --text "@README and architecture done"
```

- **Naming a node.** `--key <k>` names YOUR node (made once with `--label "<name>"`, which is required, placed with
  `--under <ref>`); later calls just give the key. `--agent <chain>` is the agent you report as (its keys live in its
  scope); `--id <id>` names any node by its stable id (the dashboard's copied command); `--path "Next release/Docs"` is the
  shorthand by labels — no `@`. A label a sibling already has becomes `"<name> (2)"` (the result says which you got).
- **Text.** Plain `--text "…"` only LOGS an entry; a LEADING `@` also sets the node's line (`--text "@Writing the docs"`);
  `@@` is a literal `@`. Always quote it (in PowerShell an unquoted `@word` is a splat).
- **Plans.** `--item <k> "<label>"` (repeatable); tick with `--key <k> --done`; `--before` / `--after` / `--first` /
  `--last` place or reorder.
- **Structure.** `--move <ref>`, `--rename "<label>"`, `--merge <ref>` / `--unmerge`, `--move-to "../X" | "/A/B"` (report,
  then move; missing destinations are made as transient contexts), `--transient[=30s]` / `--keep`, `--resolve "<path>"`
  (read-only).
- **Types.** Nodes are typed: `--context-type=plan | group | test-run` (a group is a list, not a plan; a question is a node of
  type `question`); entries too: `--message-type=test-result --result pass --checks 22 --failed 0 --duration 4.1s`.
- **Questions.** `--ask "<the question only>" --choice "A" --choice "B" [--free] --wait 30m` (exit 0 = answered on the
  dashboard); `--wait-answer --key <k>` waits for an existing one.
- **Batches.** `--batch <file|->` (a JSON array) and `--stream` (NDJSON on stdin); each item is its own all-or-nothing call.
- **The `log` tool** takes the same fields (`agent`, `key`, `id`, `path`, `under`, `label`, `plan:[{key, label}]`, `text`,
  `move_to`, `context_type`, `message_type` + `fields`, `guide` …); the read-only `resolve` tool answers like `--resolve`;
  the `activity` tool reads the board, a node's log (`log:{ session, id | path, removed, earlier }`) or an entry.
- **Guides.** `aimb-log --guide agent|session` prints the rules (with `--agent`, the agent's first report). A realm may
  publish its own guide text in `behaviors.realm.guides` (placeholders `{cmd}`, `{agent}`, `{path}`, `{gateway}`,
  `{script}`); the built-in text is the 2.0 one. An orchestrator puts `{log_snippet}` (the ready command + one line) in each
  agent's prompt with `--agent <key> --label "<name>" --under <item key>`.
- **Exit codes:** 0 ok · 4 the bridge said no (or no 2.0 gateway: `gateway-unsupported`) · 64 the command line ·
  10 / 11 / 12 / 13 a wait ran out / the question expired / was withdrawn / its session left.

**Removed 1.7x forms** — refused `legacy-form` (exit 64) before anything is written, with a message naming the 2.0 form:

| 1.7x form | 2.0 form |
|---|---|
| positional text: `aimb-log … "text"` | `--text "…"` (a leading `@` sets the line) |
| `--plan "A" "B"` | `--item "A" --item "B"` (or `--item <key> "<label>"`) |
| `--move <node> --to <parent>` | `--key <node> --move <parent>` |
| `@` in a path: `--path '@"Next release"/@Docs'`, `@root`, `@?3` | `--path "Next release/Docs"` |
| `@~` in a path or text: `…/@~A`, `"@~root …"` | `--text "@…"` on the node (`--key A`, or no `--key` for your own node) |
| the `log` tool's `to` / `note` / `context` | `move` / plain `text` / `path` |

The dashboard shows the board by node id: labels without `@`, the type's glyph (☰ plan, ▤ group, ⚑ test run), each node's
time ("took 4m 12s"), a right-click menu per type (Rename…, Merge into…, Move to…), a clash dialog when a move meets a
same-label sibling, and a per-user VIEW (pins, hidden, open / closed, "N new" badges) that follows your OS login across the
realm's 2.0 hosts. A host still on 1.7x is a RED row at the top of the board ("… is still on 1.7x: not on this board").

## Learn more

- **[`src/README.md`](src/README.md)** — full setup, the complete MCP tool set, realms / identity / consent,
  topics, sub-peers, pages, services (HTTP egress + server-side auth), and the test suites.
- **[`docs/architecture.md`](docs/architecture.md)** — design rationale (realms, pluggable facets, consent,
  cross-host mesh, persistence, vault) plus the numbered **version history** (§13) that serves as the
  changelog.
- **[`docs/linux-setup.md`](docs/linux-setup.md)** — Linux / headless setup: which facets to turn off, a
  `systemd --user` gateway (incl. the mandatory `enable-linger`), out-of-band token delivery, and what must
  stay identical across machines vs what is meant to differ.
- **[`docs/web-edge-node.md`](docs/web-edge-node.md)** — the "web edge node" roadmap; the in-process HTTP
  egress service is step 1.
- **[`docs/spec-88.md`](docs/spec-88.md)** — the 2.0 activity board: identity, record formats, the command forms,
  gossip v6, migration; **[`docs/cutover-2.0.md`](docs/cutover-2.0.md)** — the 1.7x → 2.0 runbook.

## Layout

- **`src/`** — the bridge (`bridge.mjs`) and:
  - `lib/` — logic factored out of the core: **pure** helpers (topic matching, envelope ids, key
    canonicalisers, tool schemas, secret-reference resolver) and **encapsulated stateful** modules (consent,
    behaviour reminders, trace ring buffer, egress auth token sources).
  - `facets/` — the pluggable realm profile (auth, cipher, capsigner, identity, config, transport, discovery,
    persistence, authorizer, vault) — one file per implementation, "copy a file to add one".
  - `services/` — opt-in **in-process capability modules**, loaded only when configured. First inhabitant:
    **egress** (an `http_request` tool proxying to operator-declared backends, with optional server-side auth).
  - `tests/` — the suites; `npm test` runs them all behind a `checkJs` typecheck gate. `dashboard.html` /
    `chat.html` are the bundled web pages; `tools/` holds `aimb-log.mjs` (the activity board), `aimb-doorbell.mjs`
    and `aimb-migrate-v2.mjs` (the one-time 1.7x → 2.0 history conversion).
- **`tray/`** — optional Windows system-tray supervisor (Open Dashboard / Restart Bridges… / Quit; keeps a gateway
  alive; shows a gateway's refusal to start, exit 78, instead of relaunching it).
- **`docs/`** — architecture + roadmap.

## Type safety, zero build

The bridge ships as `node bridge.mjs` with no compile step. Types are applied via **JSDoc + `checkJs`**
(`tsconfig.json` + shared shapes in `src/types.d.ts`); `npm run typecheck` (`tsc --noEmit`) catches
missing/renamed fields without emitting anything, and `npm test` runs it first as a pretest gate.

## Security posture (short version)

Message bodies are AES-256-GCM encrypted with a key derived from the realm `token`; routing metadata
(subjects, roster) stays cleartext by design. Cross-project delivery is denied by default and opened only by
the **receiver** (`allow_project` / `request_project_access`), with signed reply capabilities for
return-traffic. Cross-host links ride the Tailscale (WireGuard) overlay, with the realm token gating
membership. See `docs/architecture.md` for the full model.
