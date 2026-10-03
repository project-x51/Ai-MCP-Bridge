# Cutover to 2.0.0 — the runbook

#88 ("stable node identity") makes the bridge **2.0.0**. It is a **clean cutover**: 2.0 speaks only 2.0 on the wire, so
**every bridge on every host stops**, then **each host converts its own activity history** with
`src/tools/aimb-migrate-v2.mjs`, then **the bridges start again, in any order**. The design is in
[`spec-88.md`](spec-88.md) §7 (cutover, migration), §10 (the Dropbox rules) and §4 (the 2.0 command forms).

The realm: **ROBIN-Z790** and **LITTLE-001** (Windows; one repo, one `src/config.json` and one `persistence/` through
Dropbox), **Robins-Mac** and **phub-lnx-01** (their own checkouts and configs), joined over Tailscale. Before the cutover
ROBIN runs 1.73 and the other three 1.65; only ROBIN has activity history (`persistence/activity/robin-z790/`).

**Time:** about 20 – 30 minutes, most of it waiting for Dropbox and walking between machines. The mesh is down meanwhile
(messages park in the durable mailboxes as usual).

> **There is no way back to 1.7x after a host's migration** (spec Q09 / Q35 / Q39: "1.7 was experimental"). The last point
> where you can simply abort is **before the first real (non-dry-run) migration** in step 5 — see "Aborting" at the end.

Paths below: `$repo` is the repo root on that machine. On ROBIN-Z790:

```powershell
$repo = 'D:\Dropbox\Projects\Companies and Trusts\Crypto CrayZ\Dev\Ai MCP Bridge'
```

On LITTLE-001 it is the same folder inside LITTLE's Dropbox. On phub-lnx-01 it is `~/Ai-MCP-Bridge`; on the Mac, your
checkout.

---

## 0. Before the day (integration, done once on ROBIN)

- [ ] `v2` holds the whole release: build steps 1 – 12 merged and green (`npm test` in `src/`, typecheck included).
- [ ] `src/bridge.mjs` `BRIDGE_VERSION` and `src/package.json` both say **2.0.0** (set at the step-12 integration). The
      dashboard, `list_sessions` and the logger welcome show the first, the tray menu the second, and
      `test_activity_6c_live` / `test_realm_guides_live` compare the two.
- [ ] `v2` is pushed (`git push origin v2`), so the Mac and phub can fetch it.

## 1. Pre-checks (5 min)

On **ROBIN** (PowerShell):

```powershell
cd $repo
git status --short                 # must be empty: main's working tree is clean
git rev-parse --abbrev-ref HEAD    # main
git fetch origin
git merge-base --is-ancestor main v2; if ($?) { 'OK: main fast-forwards to v2' } else { 'STOP: main is not an ancestor of v2' }
git log --oneline -1 v2            # the release commit you expect
git rev-parse v1.75.1              # the tag exists (the last 1.7x code)
node --version                     # 20+
```

- [ ] **Finish or park running agent work.** An agent mid-task holds a 1.7x `{log_snippet}`; after the cutover its
      reports are refused `legacy-form` (exit 64) and it loses its bridge when the bridges stop.
- [ ] **Dropbox is up to date on both Windows hosts** (tray icon: "Up to date").
- [ ] Tailscale is up on all four (`tailscale status`); you can reach LITTLE's desktop (RDP via the dyndns name, port
      3390), the Mac (`ssh mac`) and phub (`ssh phub1`).
- [ ] Optional — a lasting copy of ROBIN's 1.7x history (the migration's own backup lives only while it runs; Dropbox's
      version history also keeps the old files for a while). `persistence.bak-*/` is git-ignored:

```powershell
cd $repo
Copy-Item -Recurse persistence\activity\robin-z790 "persistence.bak-v5-$(Get-Date -Format yyyy-MM-dd)\activity\robin-z790"
```

## 2. Stop EVERY bridge on EVERY host (5 min)

**Why all:** a 2.0 gateway shares no activity with a 1.7x one (the `activity_gossip` check fails both ways), a gateway must
be down while its host is migrated (the script refuses otherwise), and on the Dropbox pair a 1.7x process still running
would meet 2.0 code once the files change under it.

### ROBIN-Z790 (Windows, the tray)

1. Tray icon → **Quit** → **Shut down all**. This asks the gateway to flush (`/admin/prepare-shutdown`), kills every
   `bridge.mjs` (the tray gateway and every Claude Code / Desktop session's bridge) and closes the tray — so it does not
   relaunch a gateway 3 s later, which **Restart Bridges…** would.
2. **Don't use Claude Desktop / Cowork on this machine until step 6** — it relaunches its bridge on the next tool use. Claude
   Code sessions just lose the `ai-mcp-bridge` server until you reconnect it (`/mcp`).
3. Check that nothing is left:

```powershell
Get-Process AiMcpBridgeTray -ErrorAction SilentlyContinue          # nothing
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*bridge.mjs*' |
  Select-Object ProcessId, CommandLine                             # nothing
```

If something is left (a bridge started by an app), stop it:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*bridge.mjs*' |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### LITTLE-001 (Windows, the tray, over Dropbox)

Its tray runs on its interactive desktop. Either RDP in and do as on ROBIN (Quit → Shut down all), or from ROBIN over SSH
(`ssh little1`, PowerShell) — tray first, so it cannot relaunch the gateway:

```powershell
cd $repo   # LITTLE's path to the same Dropbox folder
$tok = (Get-Content src\config.json -Raw | ConvertFrom-Json).token    # read, never printed
try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:12318/admin/prepare-shutdown -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 5 } catch { 'no gateway answered (fine)' }
Stop-Process -Name AiMcpBridgeTray -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*bridge.mjs*' |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*bridge.mjs*'   # nothing
```

(Use `wsPort` from the config if it is not 12318.) **The tray must be stopped before step 3:** the rebuilt tray exe
arrives through Dropbox, and Dropbox cannot replace an exe that is running.

### Robins-Mac (`ssh mac`)

```bash
pgrep -fl bridge.mjs                         # what runs (Claude Code sessions' bridges, a gateway)
launchctl list | grep -i -E 'aimb|bridge'    # a LaunchAgent that keeps one alive? then: launchctl unload <its plist>
```

Quit the Claude Code sessions (or the Claude app) that use the bridge, then make sure:

```bash
pkill -f 'src/bridge.mjs'; sleep 2; pgrep -fl bridge.mjs     # nothing
```

### phub-lnx-01 (`ssh phub1`)

```bash
systemctl --user stop aimb-bridge.service 2>/dev/null; systemctl --user is-active aimb-bridge.service
pkill -f 'src/bridge.mjs'; sleep 2; pgrep -af bridge.mjs     # nothing
```

## 3. Update the code (5 min)

### The Dropbox pair — ONCE, on ROBIN

Fast-forward `main` to `v2` in the Dropbox checkout. That changes the files of **both** hosts (LITTLE runs the same
`src/` through Dropbox). Do NOT run git on LITTLE.

```powershell
cd $repo
git merge --ff-only v2             # main = v2
git tag -a v2.0.0 -m "2.0.0: stable node identity (#88)"   # pushed in step 8, once the post-checks pass
(Get-Content src\package.json -Raw | ConvertFrom-Json).version     # 2.0.0
Select-String -Path src\bridge.mjs -Pattern "^const BRIDGE_VERSION = '2.0.0'"   # one line
```

**Rebuild the tray** (the 2.0 exe knows a refused start, exit 78 — §7 below). The exe is git-ignored and compiled with the
in-box .NET Framework `csc`; Dropbox carries it to LITTLE:

```powershell
& "$repo\tray\windows\build.cmd"; $LASTEXITCODE                     # 0
Get-Item "$repo\tray\windows\AiMcpBridgeTray.exe" | Select-Object Length, LastWriteTime   # now
```

No `npm install` is needed: the runtime dependencies (`@modelcontextprotocol/sdk`, `ws`) have not changed.

**Wait for Dropbox to finish syncing** on ROBIN and then on LITTLE ("Up to date"; a few hundred files changed). Check on
LITTLE that the new code is there, read-only (no git):

```powershell
(Get-Content "$repo\src\package.json" -Raw | ConvertFrom-Json).version     # 2.0.0
(Get-FileHash "$repo\src\bridge.mjs").Hash                                  # equal to ROBIN's
Test-Path "$repo\src\tools\aimb-migrate-v2.mjs"                             # True
```

### Robins-Mac and phub-lnx-01

```bash
cd ~/Ai-MCP-Bridge          # the Mac: your checkout
git status --short          # clean (config.json is git-ignored)
git rev-parse HEAD          # note it: the commit this host ran (for "Aborting")
git fetch origin && git checkout main && git merge --ff-only origin/v2
git log --oneline -1        # the 2.0.0 commit (= ROBIN's main)
node -p "require('./src/package.json').version"    # 2.0.0
```

## 4. The realm's guides and briefing in `config.json` (Robin, while everything is stopped)

The built-in guides are 2.0 already. What lives in a **config** is yours to rewrite (spec Q34, §4.3, §10.5):

1. **The realm block** (`behaviors.realm` in the shared `src/config.json` on the Dropbox pair — publish it in ONE config):
   - replace the two connect reminders with `"id": "activity"` (`client:code`, `client:cowork`) by the 2.0 text in
     `src/config.example.json`: they brief agents with `--agent <its key> --label "<its name>" --under <its plan item's
     key>` and finish with `text:"@<summary>"` — no `--path "<item>/<agent>"`, no `@~root`;
   - keep the doorbell reminder as it is;
   - **set `updated_at` to now** (ISO, e.g. `"2026-10-04T20:00:00Z"`) — newest wins realm-wide, so an unchanged stamp is
     ignored. (This is also the "Republish realm reminders" item that has waited on the board.)
2. **Realm guides** (`behaviors.realm.guides`, #89 part 2), if you published any: a 1.7x guide teaches removed forms
   (`--path "@…"`, `@~`, `--plan`) that are now refused. Either **delete `guides`** (the built-in 2.0 text is served —
   recommended) or rewrite each in 2.0 forms. Placeholders: `{cmd}`, `{agent}` (new in 2.0), `{path}`, `{gateway}`,
   `{script}`; each text ≤ 4 KB; no `min_bridge` is needed (every host is 2.0).
3. **Each host's own `behaviors.default`** (the Mac's and phub's configs, and the shared one): a local reminder with the
   same (operation, scope, match) beats the realm's. Look for 1.7x forms:

```bash
grep -n -E '@~|--plan|<item>/<agent>' src/config.json    # Mac / phub; nothing expected
```

```powershell
Select-String -Path "$repo\src\config.json" -Pattern '@~|--plan|<item>/<agent>'   # the Dropbox pair; only lines you will replace
```

Check that the file is still valid JSON before going on: `node -e "JSON.parse(require('fs').readFileSync('src/config.json','utf8'))"`
(from `$repo`).

## 5. Migrate each host's history (2 min per host)

Run on **each** host, from its repo root, with that host's bridges stopped. Each converts ONLY
`persistence/activity/<its own host>/`, so the hosts can do this in any order or at the same time. **Dry run first.**

```powershell
cd $repo
node src/tools/aimb-migrate-v2.mjs --dry-run ; "exit $LASTEXITCODE"
node src/tools/aimb-migrate-v2.mjs ; "exit $LASTEXITCODE"
```

(Mac / Linux: the same two commands, `; echo "exit $?"`.)

**Exit codes:** `0` done or nothing to do · `2` refused, nothing written (a bridge answers on this host's port, a writer is
active, a marker without v6 …: the line says the fix) · `3` failed — the 1.7x files were **restored** (see §7) · `64` a bad
command line. (`78` is the gateway's: §7.)

**Expected output — ROBIN** (illustrative: the numbers grow with the history; the conversion of a copy taken 2026-10-04
01:42 had 3 day files, 5 259 records → 1 451 nodes, 0 ghosts, 0 labels made unique, and wrote 4.5 MB of v6 day files):

```
aimb-migrate-v2 (dry run): host ROBIN-Z790, D:\…\persistence\activity\robin-z790
activity/robin-z790 (dry run): would convert 3 day files, 5 259 records → 1 451 nodes (0 ghosts); would write 3 day files + 3 index files (4.6 MB), backup 2.7 MB during the run — nothing written
exit 0
aimb-migrate-v2: host ROBIN-Z790, D:\…\persistence\activity\robin-z790
activity/robin-z790: 3 day files, 5 259 records → 1 451 nodes (0 ghosts), verified, backup (2.7 MB) removed, 1.4 s
exit 0
```

`WARN` lines name Dropbox conflicted copies (left in place, never read — check and delete them by hand); `label made
unique` / `agent key slugged` lines list what the conversion renamed. Running it again prints `already converted (format
v6, … by aimb-migrate-v2 2.0.0) — nothing to do` (exit 0).

**Expected — LITTLE, the Mac, phub** (no activity history):

```
activity/little-001: no activity history for host LITTLE-001 in …\persistence — nothing to convert (a 2.0 gateway writes its marker at its first start); other hosts' directories here: robin-z790 (each host converts its own: --host)
exit 0
```

(or `no 1.7x day files — format marker written (a fresh host)` if the directory exists but is empty). A host with
persistence off gets the same "nothing to convert"; its 2.0 board is memory-only, as before.

Then let Dropbox upload ROBIN's converted files (≈ 2× the history moves once; nothing waits on it).

## 6. Start the hosts — any order (5 min)

- **ROBIN:** start the tray as usual (its Startup shortcut, or `& "$repo\tray\windows\run.cmd"`). The menu header reads
  **Ai MCP Bridge v2.0.0**; it launches the gateway. Reconnect Claude Code sessions (`/mcp` → `ai-mcp-bridge`), restart
  Claude Desktop.
- **LITTLE:** **only after Dropbox shows "Up to date"** (the code AND the rebuilt tray exe). The tray must be started **on
  LITTLE's desktop** (RDP via the dyndns name, port 3390) — SSH cannot show it: run `tray\windows\AiMcpBridgeTray.exe`.
- **Mac:** start the gateway / sessions the way they normally start (Claude Code sessions spawn their bridges; a LaunchAgent
  you unloaded: `launchctl load <its plist>`).
- **phub:** `systemctl --user start aimb-bridge.service && systemctl --user status aimb-bridge.service`

### Post-checks

1. **Versions** — dashboard (`http://127.0.0.1:12318/?token=…`, or the tray's Open Dashboard; reload an open tab): the
   Computers table shows **2.0.0** for all four hosts. (Or `list_sessions` from any session.)
2. **The 2.0 format** — the dashboard's header tag reads `view: robin`; a session's `activity` tool call answers
   `"format": 6`; ROBIN's marker exists:

```powershell
Get-Content "$repo\persistence\activity\robin-z790\format.json" | ConvertFrom-Json | Select-Object v, by, records, nodes
```

3. **The board** — Activity shows the Bridget session with **Next release → WIP → #88 stable node identity (v2.0)** and
   its plan bar, Planned changes, Potential changes, Deployed releases. ONE Bridget session (two would mean a realm or
   user mismatch). Labels show without `@`; plans ☰, groups ▤, test runs ⚑.
4. **No red rows** at the top of the board ("… is still on 1.7x … not on this board" = that host was missed: stop it,
   update, migrate, start) and no amber `fs_warnings` rows (a Dropbox conflicted copy).
5. **Questions and history** — the header counts open questions (`? N`); #88's Questions groups (Spec Q1 – Q41 … Step 10,
   Step 12) are there; select #88 and its log panel shows entries back to the first retained day; "show earlier runs" works.
6. **A report in the 2.0 form** (it lands on the existing node — `created:false` — and sets its line):

```powershell
cd $repo
node src/tools/aimb-log.mjs --session Bridget --project AIMB --path "Deployed releases" --text "@2.0.0 on all four hosts (cutover $(Get-Date -Format yyyy-MM-dd))"
```

   Expect one JSON line with `"ok":true`, `"created":false`, `"line":true`. A 1.7x form is refused, by design:
   `node src/tools/aimb-log.mjs --session Bridget --project AIMB --path '@"Deployed releases"' --text x` → `legacy-form`,
   exit 64.
7. **Across hosts** — from each of the other three hosts, one report (on the Mac / phub add `--token-file <the file your
   MCP config's AI_BRIDGE_TOKEN_FILE names>` if the token is not in `config.json`):

```bash
node src/tools/aimb-log.mjs --session Cutover --project AIMB --path "Hosts" --text "@$(hostname) on 2.0.0"
```

   All of them appear under the `Cutover` session on ROBIN's dashboard (gossip v6 works both ways); right-click → Dismiss
   it afterwards.
8. **The tray** on both Windows hosts: green icon, header v2.0.0, no "Bridge refused to start" item.

## 7. If something goes wrong

### A gateway refuses to start (exit 78)

The 2.0 gateway checks its own history before it serves: v5 day files without the v6 marker, or a migration backup still
there, and it exits **78** with one line:

- `activity history in persistence/activity/robin-z790 is format v5 (pre-2.0). Stop every bridge, then run: node
  src/tools/aimb-migrate-v2.mjs (see docs/spec-88.md §7.1)` — this host was not migrated: do step 5 on it.
- `the migration of persistence/activity/robin-z790 did not finish — run node src/tools/aimb-migrate-v2.mjs again` — a
  run crashed: run it again; it resumes from its backup.

Where you see it:
- **Windows tray** — a balloon "Ai MCP Bridge did not start" and a menu item **Bridge refused to start - details…**; the tray
  stops relaunching (it no longer retries every 3 s). Fix it, then **Restart Bridges…** (clears it and tries again). The
  message is also in `%TEMP%\aimb-start-refused-12318.txt`.
- **A terminal** — `cd $repo\src; node bridge.mjs` prints `activity: REFUSED TO START (exit 78): …` on stderr.
- **phub (systemd)** — `journalctl --user -u aimb-bridge.service -n 20`. `Restart=on-failure` restarts it every 5 s and
  fails again each time; add `RestartPreventExitStatus=78` to the unit (docs/linux-setup.md shows it) so it stops.
- **A Claude Code session** — `/mcp` shows the server failed; reconnect after the fix.

Only a gateway checks (followers own no activity), so a refused host shows "offline" while its sessions wait for a
gateway.

### The migration fails (exit 3)

A failed run **restores**: the v5 files come back from the backup (checked against its `COMPLETE` list), the index files
and the marker go, the backup is removed — the directory is byte for byte as before. The line ends `— the v5 history was
RESTORED from the backup and the backup removed: nothing changed — …` and says what to do:
- `… stop every bridge, then run this again` — a bridge came up during the run (its port answered after the
  verification): stop it (step 2), run again.
- `… please report this (the converter needs a fix); the bridges cannot start on 1.7x history` — a conversion or
  verification fault. Stop here, keep everything as it is, and send the full output (add `--json` for the report).
  The other hosts can still go ahead; this one stays down (or see "Aborting").

Other exit-3 messages: `the backup is damaged: … the backup in activity-v5-backup/<host> is kept: check it by hand`, and a
restore that itself failed names the kept backup — copy that folder somewhere safe before anything else.

Exit **2** writes nothing: `a bridge is running on this host (it answers on 127.0.0.1:12317)` → step 2 again; `could not
tell whether a bridge is running` → check by hand, then again; `a writer is active in …` → a bridge is still writing.

### Aborting

- **Before any real migration** (only dry runs so far): go back to 1.7x. On ROBIN `git reset --hard v1.75.1` and
  `git tag -d v2.0.0` (Dropbox carries the files to LITTLE; nothing was pushed yet — step 8 pushes), rebuild the tray
  (`tray\windows\build.cmd`); on the Mac / phub `git checkout <the commit they ran before>` (`git reflog` shows it); then
  start the bridges. The history is still v5, so the 1.7x bridges start as before.
- **After a host's migration verified:** there is no rollback (spec §7, Q09 / Q35). A 1.7x bridge cannot read v6 history —
  it would show an empty board and write v5 records on top. A problem found later is fixed forward in 2.0. The v5 files
  survive only in the by-hand copy from step 1 (`persistence.bak-v5-…`) and, for a while, Dropbox's version history.

**What the `v1.75.1` tag is for:** it marks the last 1.7x code (`main` before the cutover — the release the live bridges
ran, with #88 steps 2 – 8 dormant behind the pre-cutover switch). Use it to read or diff the old code, to abort before any
migration as above, or to build an old bridge for a test (the 2.0 test suite no longer can: it uses a v5 stand-in). It is
not a way back after migration.

## 8. Afterwards

- [ ] Push the release from ROBIN: `git push origin main v2.0.0` (the Mac and phub then sit on `main` as before; their
      next `git pull` is a no-op).
- [ ] Board: tick **Build step 12** under #88; set **Deployed releases** to 2.0.0; dismiss the `Cutover` session.
- [ ] `docs/issues.md`: #88 deployed; the live-mesh note (every host on 2.0.0). The RESUME STATE notes point here.
- [ ] **#81's test reporter** (`src/tests/reporters/aimb-dashboard.mjs`) still sends 1.7x stream lines (`@`-paths, `@~`): with
      `AIMB_TEST_LOG_SESSION` set, a 2.0 gateway refuses them (`legacy-form`). Switch it to the 2.0 test-run pattern
      (spec §3.8 and build step 2d: a `--context-type=test-run` node, one context per suite, `--message-type=test-result
      --result pass|fail --checks N --failed N --duration …` per test, `--move-to` the Passed / Failed buckets). Until then
      run the suite without `AIMB_TEST_LOG_SESSION`.
- [ ] Old 1.7x runs on the board: the failed "review run" under *Build step 1* (62 tests) is an open plan that never ends
      (one failed item), so it opens expanded at every load — collapse it once (the view remembers it now) or right-click
      → Abandon.
- [ ] phub's unit: `RestartPreventExitStatus=78` (docs/linux-setup.md).
- [ ] Delete the `v2` branch once nothing points at it (`git branch -d v2; git push origin :v2`), or keep it as the 2.x line.
