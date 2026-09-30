// Project consent (§4/§14) as an encapsulated module that OWNS its state — the runtime-grant map and the
// pending-access requests — instead of leaving them as module globals poked from handlers + a GC timer.
// bridge.mjs calls the API (mayInitiate / reachable / allow / revoke / addPending / …) and never touches the
// Maps directly. Receiver-controlled inbound consent: a project may reach another only if same-project, the
// realm is `open`, a static config edge allows it, or a runtime grant does. The reply exception (firewall
// return-traffic via the signed reply-cap) is handled in bridge.mjs, NOT here.
//
// #62 (v1.45.0): runtime grants are a REPLICATED set with last-writer-wins. Each edge `(from,to)` holds ONE record
// { from, to, mode, exp, updated_at, revoked, origin }; a revoke writes a TOMBSTONE (revoked:true, newer updated_at)
// instead of deleting, so it can propagate and beat an older grant. `merge()` keeps, per edge, the record that wins
// `beats()` — idempotent + commutative, so every host can re-gossip the FULL set it knows (local + learned) and all
// converge. bridge.mjs moves the set (grantSet()/merge()) over PEER_ROSTER / ROSTER / GRANTS frames; this module
// only owns the records. Static config edges (POLICY.allow) are per-config and are NOT part of the set.
import { projKey } from './keys.js'

// A TTL is minutes (number) or a duration string ("30m"/"24h"/"7d"); null/0/"forever"/"" = no expiry.
export function parseTtlMin(v) {
  if (v == null || v === '' || v === 0) return null
  if (typeof v === 'number') return v > 0 ? v : null
  const s = String(v).trim().toLowerCase()
  if (s === 'forever' || s === 'never' || s === '0') return null
  const m = s.match(/^([\d.]+)\s*(m|min|h|hr|hour|d|day|w|week)?s?$/)
  if (!m) return null
  const n = parseFloat(m[1]); if (!isFinite(n) || n <= 0) return null
  const u = (m[2] || 'm')[0]
  return Math.round(n * (u === 'w' ? 10080 : u === 'd' ? 1440 : u === 'h' ? 60 : 1))
}

/** Canonicalise a grant record (local, durable or gossiped). A legacy durable record (≤1.44: no updated_at) dates
 *  from its granted_at, else 0 — so any 1.45+ write beats it. Returns null for anything that isn't an edge. */
export function normGrant(r) {
  if (!r || typeof r !== 'object' || !r.from || !r.to) return null
  const ua = Number(r.updated_at), exp = Number(r.exp)
  return { from: projKey(r.from), to: projKey(r.to), mode: r.mode === 'bidirectional' ? 'bidirectional' : 'send',
    exp: exp > 0 ? exp : null, updated_at: Number.isFinite(ua) && ua > 0 ? ua : (Date.parse(r.granted_at || '') || 0),
    revoked: !!r.revoked, origin: typeof r.origin === 'string' ? r.origin.slice(0, 200) : '' }
}
/** LWW total order: does record `a` beat record `b` for the same edge? Greater updated_at wins; on a tie a tombstone
 *  wins (a revoke is never lost to a simultaneous grant), then the greater origin, then the greater canonical JSON —
 *  so two hosts holding the same pair always pick the same survivor (merge is commutative). */
export function beats(a, b) {
  if (!b) return true
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at
  if (a.revoked !== b.revoked) return a.revoked
  if (a.origin !== b.origin) return a.origin > b.origin
  return JSON.stringify(a) > JSON.stringify(b)
}
const live = (g, now = Date.now()) => !g.revoked && !(g.exp && g.exp <= now)   // does this record authorise right now?

/**
 * @param {{ persistence: any, persist: boolean, origin?: string, tombstoneTtlMs?: number }} ctx
 */
export function createConsent({ persistence, persist, origin = '', tombstoneTtlMs = 30 * 86400000 }) {
  let POLICY = { default: 'strict', allow: [] }   // static config edges + default mode
  let open = false                                 // realm-wide open (no consent gating)
  const runtimeAllow = new Map()   // `${from}>${to}` -> normGrant record (grant OR tombstone); projKey'd; exp = ms epoch or null=forever
  const pendingAccess = new Map()  // reqId -> { reqId, from, to, requester, requesterName, ttlMin, ts } — so a grant can notify the requester
  const edgeKey = (f, t) => `${f}>${t}`
  // durable copy of one record; granted_at is kept so the ≤1.44 dashboard/store readers still see a date
  const put = g => persistence.grants.put(g.from, g.to, { ...g, granted_at: new Date(g.updated_at || Date.now()).toISOString() }).catch(() => {})

  /** Replace the policy (config load / live-reload). */
  function setPolicy(projects, isOpen) {
    POLICY = (projects && typeof projects === 'object') ? projects : { default: 'strict', allow: [] }
    open = !!isOpen
  }
  function edgeAllows(from, to) {
    for (const e of (POLICY.allow || [])) {
      const f = projKey(e.from), t = projKey(e.to), m = e.mode || 'send'
      if (f === from && t === to) return true
      if (m === 'bidirectional' && f === to && t === from) return true
    }
    const now = Date.now()
    for (const g of runtimeAllow.values()) {
      if (!live(g, now)) continue   // a tombstone or an expired grant doesn't authorise (expiry swept by gc())
      if ((g.from === from && g.to === to) || (g.mode === 'bidirectional' && g.from === to && g.to === from)) return true
    }
    return false
  }
  /** May project `from` initiate to project `to`? */
  function mayInitiate(fromProject, toProject) {
    const fp = projKey(fromProject), tp = projKey(toProject)
    if (fp === tp) return true       // same project always open
    if (open) return true            // realm-wide open
    return edgeAllows(fp, tp)
  }
  /** The FOREIGN projects `fromProject` may currently initiate to (besides its own); 'all' when the realm is open (§20). */
  function reachable(fromProject) {
    const fp = projKey(fromProject)
    if (open) return 'all'
    const out = new Set(), now = Date.now()
    for (const e of (POLICY.allow || [])) { const f = projKey(e.from), t = projKey(e.to), m = e.mode || 'send'; if (f === fp) out.add(t); if (m === 'bidirectional' && t === fp) out.add(f) }
    for (const g of runtimeAllow.values()) { if (!live(g, now)) continue; if (g.from === fp) out.add(g.to); if (g.mode === 'bidirectional' && g.to === fp) out.add(g.from) }
    out.delete(fp)
    return [...out]
  }
  // a LOCAL write must beat whatever this host already knows for the edge, even under a little clock skew
  const stamp = k => Math.max(Date.now(), ((runtimeAllow.get(k) || {}).updated_at || 0) + 1)
  /** Add/replace a runtime grant edge (durable when persistence is on). exp = ms epoch or null=forever. */
  function allow(from, to, mode, exp) {
    const f = projKey(from), t = projKey(to), k = edgeKey(f, t)
    const g = { from: f, to: t, mode: mode === 'bidirectional' ? 'bidirectional' : 'send', exp: exp || null, updated_at: stamp(k), revoked: false, origin }
    runtimeAllow.set(k, g); if (persist) put(g)
    return g
  }
  /** Revoke a runtime grant edge: write a TOMBSTONE (so the revoke replicates and beats the older grant) rather than
   *  deleting. Always tombstones, even an edge this host hasn't seen granted (the grant may still be in flight). Its
   *  exp is set to the revoke time so a ≤1.44 bridge sharing the store never rehydrates it as a grant. Returns
   *  whether a live grant existed. */
  function revoke(from, to) {
    const f = projKey(from), t = projKey(to), k = edgeKey(f, t)
    const prev = runtimeAllow.get(k), had = !!prev && live(prev)
    const ts = stamp(k)
    const g = { from: f, to: t, mode: (prev && prev.mode) || 'send', exp: ts, updated_at: ts, revoked: true, origin }
    runtimeAllow.set(k, g); if (persist) put(g)
    return had
  }
  /** Fold a peer's grant set into ours, per edge last-writer-wins. Persists each record that changed (so a LEARNED
   *  grant survives a restart and its origin going offline). Returns how many edges changed (0 = nothing new). */
  function merge(records) {
    if (!Array.isArray(records)) return 0   // a ≤1.44 peer sends no grant set
    let changed = 0
    for (const r of records) {
      const g = normGrant(r); if (!g) continue
      const k = edgeKey(g.from, g.to)
      if (!beats(g, runtimeAllow.get(k))) continue
      runtimeAllow.set(k, g); if (persist) put(g)
      changed++
    }
    return changed
  }
  /** The full replicated set (grants + tombstones), edge-sorted so equal state serialises identically (gossip dedupe). */
  function grantSet() {
    return [...runtimeAllow.keys()].sort().map(k => ({ ...runtimeAllow.get(k) }))
  }
  /** Re-hydrate durable grants (and tombstones) at startup so cross-project consent survives a restart (§14). */
  async function rehydrate() {
    if (!persist) return
    try {
      for (const r of await persistence.grants.all()) {
        const g = normGrant(r); if (!g) continue
        const k = edgeKey(g.from, g.to)
        if (beats(g, runtimeAllow.get(k))) runtimeAllow.set(k, g)
      }
    } catch { }
  }
  /** Sweep expired grants + old tombstones + stale pending requests; gc the durable grant store. An EXPIRED grant
   *  becomes a tombstone (same updated_at, so it still beats any older grant a long-offline host re-gossips). A
   *  tombstone is dropped once older than tombstoneTtlMs — the known limit: a host offline for longer than that can
   *  re-gossip a grant whose revoke has already been forgotten everywhere else. */
  function gc(now = Date.now()) {
    const writes = []
    for (const [k, g] of runtimeAllow) {
      if (!g.revoked && g.exp && g.exp <= now) {
        const t = { ...g, revoked: true }; runtimeAllow.set(k, t)
        if (persist) writes.push(put(t))
      } else if (g.revoked && now - Math.max(g.updated_at || 0, g.exp || 0) > tombstoneTtlMs) {
        runtimeAllow.delete(k)
        if (persist) writes.push(persistence.grants.remove(g.from, g.to).catch(() => {}))
      }
    }
    for (const [id, p] of pendingAccess) if (now - p.ts > 3600000) pendingAccess.delete(id)
    if (persist) Promise.all(writes).then(() => persistence.grants.gcAll({ now })).catch(() => {})   // after the tombstone writes land
  }
  // ---- pending access requests (request_project_access -> allow_project notifies the requester) ----
  const addPending = (reqId, rec) => pendingAccess.set(reqId, rec)
  const pendingFor = (from, to) => { const f = projKey(from), t = projKey(to); return [...pendingAccess.values()].filter(p => p.from === f && p.to === t) }
  const deletePending = reqId => pendingAccess.delete(reqId)

  return { setPolicy, mayInitiate, reachable, allow, revoke, merge, grantSet, rehydrate, gc, addPending, pendingFor, deletePending, get isOpen() { return open } }
}
