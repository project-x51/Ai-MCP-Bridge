# Linux / headless setup

The bridge is OS-agnostic — plain Node, no native dependencies, no build step. Only two things are
Windows-specific, and both are **facets you turn off**: the `tpm` vault and the `hello` authorizer. There is
no tray on Linux (the tray is per-OS and only Windows exists today), which is fine: on a headless box the
gateway wants to be a **systemd user service**, not a tray app.

Field-verified on `phub-lnx-gold` (Ubuntu 24.04, headless, reached over Tailscale + SSH).

## 1. Install

```bash
git clone https://github.com/project-x51/Ai-MCP-Bridge.git ~/Ai-MCP-Bridge
cd ~/Ai-MCP-Bridge/src && npm install       # Node 20+
```

Take the **code from git** — it is the canonical source. Do not try to sync the checkout from a shared
folder; see "Keeping machines in step" below.

## 2. `src/config.json`

This file is **gitignored** — create it locally. Do **NOT** copy a Windows machine's config verbatim: its
`vault: "tpm"` / `authorizer: "hello"` facets need `Tpm.exe` / `HelloConfirm.exe` and will not work here.

```json
{
  "port": 7000, "wsPort": 7001,
  "realm": "default",
  "bind": "0.0.0.0",
  "behaviors": { "default": "Summarize but don't act without user permission" },
  "profile": { "discovery": "tailscale", "persistence": "file", "authorizer": "none", "vault": "none" },
  "persistence": { "dir": "/home/<you>/.aimb/persistence" }
}
```

- `advertiseHost` **auto-derives** from `tailscale status`, so this file needs no per-machine address.
- `vault: "none"` means a session that loses its `register_self` secret cannot recover it (no TPM/Hello here),
  so keep sub-peer secrets somewhere retrievable. **Be concrete about what "retrievable" means:** with no vault,
  the practical fallback is the session transcript (which holds the secret in the original `register_self` call)
  — i.e. the secret's real durability is *whatever the transcript retains*. Don't assume `recover_secret` is
  there as a backstop. **This applies to a Windows box too if its TPM is absent or disabled** — `profile`
  advertises the vault it is *configured* with, not one the platform can actually back, so a `vault: "tpm"`
  machine with fTPM off fails `recover_secret` with `tpm-unavailable` at the exact moment recovery is needed.
- Leave `token` out of this file and supply it via `AI_BRIDGE_TOKEN` (below) — cleaner, and keeps the realm
  secret out of the repo tree entirely.

## 3. The realm token

The token is the **membership gate and the body-encryption key**: it must be byte-identical on every machine
in the realm. Copy it from an existing machine's `src/config.json` and move it **out of band** over the
Tailscale SSH link you already have. Never put it in a synced file, a URL, or a command argument.

A good shape (as used on `phub-lnx-gold`): pipe it over **ssh stdin only** — never as an argument and never
echoed — so it reaches neither `ps` nor shell history, then length-check on arrival to prove it landed intact
without printing it. Store it at `~/.aimb/bridge.env`, mode `0600`:

```bash
chmod 700 ~/.aimb && chmod 600 ~/.aimb/bridge.env
# contents:
AI_BRIDGE_TOKEN=<the realm token>
AI_BRIDGE_PROJECT=<YourProject>
```

## 4. Claude Code wiring

`~/.claude.json` (mode `0600`), under `mcpServers`:

```json
"ai-mcp-bridge": {
  "command": "node",
  "args": ["/home/<you>/Ai-MCP-Bridge/src/bridge.mjs"],
  "env": { "AI_BRIDGE_TOKEN_FILE": "/home/<you>/.aimb/bridge.env", "AI_BRIDGE_PROJECT": "<YourProject>" }
}
```

> **Do NOT inline the token as `AI_BRIDGE_TOKEN` in an MCP config that becomes a command line (#46).** Some MCP
> clients (e.g. Claude Code with an inline `--mcp-config`) put the whole `env` block into the process's argv,
> where the realm token is **world-readable via `ps`** and captured by crash dumps / monitors / support bundles
> — and the token is both the membership gate *and* the body-encryption key. Use **`AI_BRIDGE_TOKEN_FILE`**
> (a path is harmless in argv); the bridge reads the token from it. It accepts a bare-token file or a
> `KEY=VALUE` env file, so `~/.aimb/bridge.env` (0600, from §3) works directly. Precedence:
> `AI_BRIDGE_TOKEN` value → `AI_BRIDGE_TOKEN_FILE` contents → `config.json` token.

For channel push (messages arrive without polling) start Code with
`claude --dangerously-load-development-channels server:ai-mcp-bridge`. Otherwise the session is poll-mode —
in which case use **the doorbell** (§7) rather than a polling loop.

## 5. A persistent gateway: systemd user service

Claude Code launches its own bridge per session, but on a headless box you usually want a gateway that stays
up **between** sessions so the machine remains federated. That is a `systemd --user` unit —
`~/.config/systemd/user/aimb-bridge.service`:

```ini
[Unit]
Description=Ai MCP Bridge (gateway)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.aimb/bridge.env
ExecStart=/usr/bin/node %h/Ai-MCP-Bridge/src/bridge.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
loginctl enable-linger "$USER"          # REQUIRED — see below
systemctl --user daemon-reload
systemctl --user enable --now aimb-bridge.service
systemctl --user status aimb-bridge.service
```

> **`loginctl enable-linger` is required, not optional.** Without it systemd tears down your user manager —
> and therefore the gateway — when your last SSH session closes. That defeats the entire purpose of the unit,
> which exists precisely to survive between logins. This is the single easiest step to miss on a headless box.

Keeping the token in `EnvironmentFile` (0600) rather than inline in the unit keeps the secret out of the unit
file and out of `systemctl show` output.

**To restart after a `git pull` on such a box the step is the service, not a Claude Code session:**

```bash
cd ~/Ai-MCP-Bridge && git pull && cd src && npm install
systemctl --user restart aimb-bridge.service
```

> **"Restart the bridge" is not the same operation on every host — check which owns the process.**
> Where a lingering `systemd --user` unit owns it (as here), a restart is **invisible to everything else**:
> no session is disturbed. Where **Claude Code** owns the bridge process (the default on a machine with no
> such service, e.g. a Windows box driven from the tray/Code), restarting the bridge means restarting Code —
> which **ends every session on that host** and the gateway they attach to. That is a session-ending action
> that belongs to the human at a natural break, not to an agent mid-task. Say which one you mean when asking
> someone else to do it.
>
> Also **verify the checkout is actually on the new commit before restarting.** If the code hasn't reached the
> box yet (e.g. a shared-folder sync still pending), the restart is a no-op that looks like a success.

## 6. Firewall (only if you actually run one)

Cross-host federation needs the control port reachable **on the tailnet interface**:

```bash
sudo ufw status                                              # check FIRST
sudo ufw allow in on tailscale0 to any port 7000 proto tcp   # only if ufw is active
```

On stock Ubuntu Desktop images **ufw is inactive by default**, in which case this rule is a no-op — don't
conclude your firewall is misconfigured when it appears to do nothing.

## 7. Verify

```bash
tailscale status            # the node must be up; advertiseHost derives from this
```

> **Verify ON the box, not from another machine.** `my_identity` reports the bridge your session is
> **attached to** — so running it from a session on a *different* host confirms the wrong machine and looks
> like a pass. For a remote host, check on the box itself (`git log --oneline -1`, `src/package.json`,
> `systemctl --user status aimb-bridge.service`); use `my_identity` only for the machine you are attached to.

Then from a Claude Code session **on that machine**, call `my_identity` and check:

- `bridge_version` — matches the other machines (the dashboard's **Computers → Bridge** column shows every
  machine's version, so skew is visible at a glance)
- `capabilities.doorbell === true` — you can use `tools/aimb-doorbell.mjs` instead of polling
- `host_label` is this machine and `is_gateway: true` — the VM comes up as its **own co-equal gateway**; it
  does not join another host's bridge. Federation joins them into one realm over Tailscale.

**Stop polling** once you are on ≥1.25.0:

```bash
node ~/Ai-MCP-Bridge/src/tools/aimb-doorbell.mjs --name <YourPeerName> --project <YourProject> \
     --timeout 1800 --status ~/.aimb/doorbell.json
```

Run it backgrounded. The exit code is a success/failure signal for systemd/the harness: **`0`** = did its job
(mail / timeout / peer-gone / post-arm link drop — re-arm, and poll the inbox first if `reason=="mail"`),
**`4`** = couldn't (never armed / bridge error — investigate), **`64`** = bad usage. The specific outcome is in
`reason` on stdout + the `--status` file, and a routine no-mail wake carries `guidance:"silent re-arm…"` so a
loop stays quiet (#52). Every exit line is self-timestamped — `exited_at` (local ISO-8601 with tz offset) +
`exited_at_unix` — so a wake after a quiet stretch tells you *when* it fired. See `src/README.md` → "Doorbell".

## 8. Keeping machines in step (and what may differ)

Split configuration three ways and never sync them the same way:

| Layer | Source of truth | Must match across machines? |
|---|---|---|
| **Code** (`src/`, facets, tools) | **git** — `git pull` to update | Yes — version skew disables features (see the Bridge column) |
| **Realm token** | one canonical value, delivered out of band | **Yes, byte-identical** — it gates membership and decrypts bodies |
| **Profile / paths** (`vault`, `authorizer`, `persistence.dir`, `bind`) | each machine's own `config.json` | **No — these are *meant* to differ** |

> **Check whether `config.json` is actually machine-local before you rely on it.** "Gitignored" means *not in
> git* — it says nothing about a file-sync tool. If a host runs the bridge out of a **synced folder** (Dropbox,
> OneDrive, an SMB share), its `config.json` is the *same file* as every other host doing the same, and the
> "per-machine" leg of the table above silently collapses: setting `stableIds`, a `profile` entry, or even the
> realm token on one box applies to all of them, invisibly. Verified in this realm — two Windows hosts running
> from a Dropbox checkout share one `config.json`, while a Linux host with a plain `$HOME` checkout is genuinely
> independent. Before treating a config edit as local, confirm the path is not inside a synced folder.

`vault: tpm` + `authorizer: hello` on Windows versus `none` on Linux is **correct divergence**, not drift to
be eliminated. The only value that must be identical everywhere is the token.

## 9. Peer ids (stable ids land in v1.26.0, in two phases)

**v1.26.0 ships phase 1: it READS stable ids but still MINTS the old form.** That is deliberate — it makes the
upgrade safe to do **one machine at a time, at any pace, with no coordinated restart**. Just `git pull` and
restart each host whenever suits.

**Phase 2 turns minting on** (`AI_BRIDGE_STABLE_IDS=1`, or `"stableIds": true` in `config.json`), giving ids of
the form `peer:<slug>-<hash>` derived from `(realm, project, user, name)` rather than the minting process — so
they are **stable across restarts** and stop rotating. Only enable it once **every** host in the realm is on
1.26.0+; check `my_identity` → `capabilities.stable_ids_read === true` on each. Flipping it also needs no
coordination: a host still minting old ids and one minting stable ids interoperate.

**Before v1.26.0** the id was `HOST/<session>/<name>-<rand>` with a random per-process session, and because a
bridge's lifetime is its MCP client's, ids rotated **between turns** (observed: `virtualguy-16c4 → -c892 →
-ce45 → -3581` over ~2 days). A session returning as `unknown-subpeer` just needs `register_self` again;
topics and parked mail rehydrate either way.

**The rule still holds on any version: address peers by NAME (or by `topic:`), not by a stored peer id.** Name
targeting resolves the live peer and parks durably if it is offline, and it is the only form that works across
a version-mixed mesh. The doorbell's exit code `3` exists for this — it tells a watcher to re-register rather
than block forever.

> **Why two phases?** Compatibility is one-way: a 1.26.0 bridge understands old-format ids, but an older bridge
> **cannot parse a `peer:` id**. Shipping the reader first (phase 1) means no host ever meets an id it can't
> handle, so the rollout needs no synchronised restart. The dashboard's **Computers → Bridge** column shows each
> machine's version, so you can confirm the mesh is uniform before flipping phase 2.
