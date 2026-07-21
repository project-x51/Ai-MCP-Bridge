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

## Layout

- **`src/`** — the bridge (`bridge.mjs`) and:
  - `lib/` — logic factored out of the core: **pure** helpers (topic matching, envelope ids, key
    canonicalisers, tool schemas, secret-reference resolver) and **encapsulated stateful** modules (consent,
    behaviour reminders, trace ring buffer, egress auth token sources).
  - `facets/` — the pluggable realm profile (auth, cipher, capsigner, identity, config, transport, discovery,
    persistence, authorizer, vault) — one file per implementation, "copy a file to add one".
  - `services/` — opt-in **in-process capability modules**, loaded only when configured. First inhabitant:
    **egress** (an `http_request` tool proxying to operator-declared backends, with optional server-side auth).
  - `tests/` — the suites; `npm test` runs them all (592 checks across 27 suites) behind a `checkJs`
    typecheck gate. `dashboard.html` / `chat.html` / `tools/*` are the bundled web clients.
- **`tray/`** — optional Windows system-tray supervisor (Open Dashboard / Quit; can auto-launch the bridge).
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
