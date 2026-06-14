# Ai MCP Bridge — tray component

A small system-tray app that supervises the bridge and gives you **Open Dashboard** and **Quit**.
The bridge itself is OS-agnostic; the tray is per-OS, so each platform has its own folder
implementing the same contract:

```
tray/
  windows/   AiMcpBridgeTray.cs + build.cmd + run.cmd   (this one — .NET Framework, no install)
  macos/     (future)
  linux/     (future)
```

## What it does

- **Open Dashboard** — opens `dashboard.html` in your browser with the token + ws port filled in.
- **Quit** — weighs what is connected and asks: **Cancel** / **Close tray only** (leave bridges
  running) / **Shut down all bridges** (disconnects every session + page on the machine).
- The icon shows green when at least one bridge is running, grey when none.

## Two launch modes

- **`--ephemeral`** — launched *by the first bridge instance*. It rides along and **exits once all
  bridges are gone**, so it never outlives the mesh.
- **default (persistent)** — launched *by you or at startup*. If no bridge is running it **launches
  one** and keeps a gateway alive across restarts, staying resident until you Quit.

A single-instance guard means only one tray ever runs, however it was started.

## Windows — build & run (no install)

Compiled by the **in-box** .NET Framework compiler (`csc.exe`, present on Windows 11). No SDK or
runtime download.

```bat
tray\windows\build.cmd       rem produces AiMcpBridgeTray.exe
tray\windows\run.cmd         rem build-if-needed, then launch (persistent)
```

`run.cmd` forwards args, e.g. `run.cmd --ephemeral --root C:\path\to\src`. `--root` points at the
folder holding `bridge.mjs` / `config.json` / `dashboard.html`; if omitted the tray finds it by
walking up from the exe.

## Auto-launch from the bridge

The first bridge to become gateway can start the tray itself (in `--ephemeral` mode) when enabled —
opt in with `"tray": true` in `config.json` or `AI_BRIDGE_TRAY=1`. It's **off by default** so dev/test
runs never spawn a window. The built `.exe` is git-ignored; it's compiled on first launch.
