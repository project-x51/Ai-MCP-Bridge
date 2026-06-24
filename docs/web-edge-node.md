# Web edge node — north-star architecture (roadmap)

Status: **direction**, not built. Step 1 (the in-process egress proxy) is built (v1.23); the rest is a
deliberate, incremental path. This doc records the end-state so the pieces (#24/#25/#30/#33) hang off one
coherent shape instead of accreting as one-offs.

## The idea

Today the elected **gateway** bridge process conflates two responsibilities: the **mesh protocol**
(MCP sessions, topics, routing, consent, persistence, federation) and the **web surface** (the WebSocket
server for page leaves + the dashboard, serving the bundled pages). The north-star is to split the web
surface out into a **specialized "web edge" node** — a tier whose only job is web interfaces — leaving the
core bridge focused on the protocol.

This is the classic **edge-gateway / BFF (backend-for-frontend)** pattern applied to the mesh: a web tier in
front, a protocol core behind. It isolates the higher-risk, browser- and internet-facing surface from the
control plane that holds the realm token and durable state.

```
   browsers / pages / internet                 AI sessions (MCP stdio)
            │  HTTP / WSS                                │  MCP
            ▼                                            ▼
   ┌──────────────────────┐   connects as a       ┌───────────────────────┐
   │  WEB EDGE NODE        │   privileged          │  CORE BRIDGE          │
   │  (own process)        │   participant         │  (mesh source of      │
   │  - static folders     │ ───────────────────▶  │   truth)              │
   │  - dashboard          │   over the mesh        │  - sessions/topics    │
   │  - page-leaf WS relay │   transport            │  - routing/consent    │
   │  - reverse proxy      │                        │  - persistence        │
   │  - Firebase gate (#25)│                        │  - federation         │
   └──────────────────────┘                        └───────────────────────┘
```

## The load-bearing invariant

**The core stays the single source of truth for the mesh** (peers, topics, consent, durable state). The web
edge node never *owns* mesh state — it **fronts** it: it connects to the core as a privileged participant and
translates browser/HTTP/WS into mesh participation. Hold that line and the re-tiering stays reversible and
safe; break it (two places own the same state) and it becomes a distributed-systems problem.

## Two distinct mechanisms (don't conflate them)

- **In-process capability modules** (`src/services/`): code that runs *inside* a bridge process and exposes a
  capability — an MCP tool and/or a bound port. Pattern: `meta` + `create(ctx) -> { tools?, handle?, start?,
  stop?, setConfig? }`. Loaded by a small loader, gated by `config.services.<name>`. A service that isn't
  configured doesn't exist — and a capability that doesn't exist can't be attacked. **#33 egress is the first
  one.**
- **A separate participant process** (the web edge node, and #24's "service connection" daemon): a process
  that *connects* to the bridge like a session/page and serves. Not an in-process module — a node on the mesh.

Egress is in-process (Pattern A) because it's request-scoped, must enforce the backend allowlist + project
consent centrally, needs the bridge's network, and serves MCP sessions that have no other way to make HTTP.
The static web server is a separate process (Pattern B-ish) because of blast radius (it must not share the
token+state crash domain), lifecycle (a singleton listener, not a per-session process), and because it mirrors
the common static-hosting + backend-API tiering of a typical web app.

## Where the pieces fit

- **#33 egress** — in-process proxy: the `http_request` MCP tool, gated to operator-declared backends + per-
  backend project allowlists. **Built (v1.23).** Lives in the core bridge process (no port); it is NOT part of
  the web edge node.
- **#30 file server** — static mounts over an HTTP listener. The **first brick of the web edge node**: a
  separate, gateway-supervised process serving local folders.
- **#24 service connection** — an out-of-process daemon that registers on the mesh and answers read-only state
  queries. A Pattern-B participant; the live-state source the rendering pages read from.
- **#25 secure internet access** — the Firebase-JWT gate + TLS tunnel terminate on the web edge node, in front
  of the static + proxy surface.

## The incremental path (each step shippable; reach the end-state by accretion, not a big-bang)

1. **In-process MCP→proxy** *(done, v1.23)* — the egress tool. No port, no re-tiering; solves cowork→localhost.
2. **Static web server as a separate, gateway-supervised process** *(next, when the rendering pages need it)* —
   the first brick of the web edge node. It can reverse-proxy the bridge's WS + `/api` so browsers keep a
   single origin while the processes stay in separate crash domains.
3. **Move the dashboard onto it** *(easy)* — the dashboard is a passive **observer**; it only needs the
   roster/traces/persistence snapshot. Low-risk migration.
4. **Move the page-leaf WS onto it** *(the hard one, last, deliberate)* — page leaves are **active
   participants** (claim topics, send/receive), so the edge node must relay their participation into the core.
   Defer until the tier boundary has earned its keep.

The 3→4 split is the crux: the dashboard is cheap to move (read-only); the page leaves are expensive (live
participants). Doing them in that order grows the edge node safely.
