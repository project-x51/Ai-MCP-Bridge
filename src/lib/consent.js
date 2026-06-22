// Project consent (§4/§14) as an encapsulated module that OWNS its state — the runtime-grant map and the
// pending-access requests — instead of leaving them as module globals poked from handlers + a GC timer.
// bridge.mjs calls the API (mayInitiate / reachable / allow / revoke / addPending / …) and never touches the
// Maps directly. Receiver-controlled inbound consent: a project may reach another only if same-project, the
// realm is `open`, a static config edge allows it, or a runtime grant does. The reply exception (firewall
// return-traffic via the signed reply-cap) is handled in bridge.mjs, NOT here.
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

/**
 * @param {{ persistence: any, persist: boolean }} ctx
 */
export function createConsent({ persistence, persist }) {
  let POLICY = { default: 'strict', allow: [] }   // static config edges + default mode
  let open = false                                 // realm-wide open (no consent gating)
  const runtimeAllow = new Map()   // `${from}>${to}` -> { mode, exp } — runtime grants, keys are projKey'd; exp = ms epoch or null=forever
  const pendingAccess = new Map()  // reqId -> { reqId, from, to, requester, requesterName, ttlMin, ts } — so a grant can notify the requester

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
    for (const [k, g] of runtimeAllow) {
      if (g.exp && g.exp <= Date.now()) continue   // expired grant doesn't authorise (swept lazily + by gc())
      const [f, t] = k.split('>'), m = g.mode
      if ((f === from && t === to) || (m === 'bidirectional' && f === to && t === from)) return true
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
    const out = new Set()
    for (const e of (POLICY.allow || [])) { const f = projKey(e.from), t = projKey(e.to), m = e.mode || 'send'; if (f === fp) out.add(t); if (m === 'bidirectional' && t === fp) out.add(f) }
    for (const [k, g] of runtimeAllow) { if (g.exp && g.exp <= Date.now()) continue; const [f, t] = k.split('>'); if (f === fp) out.add(t); if (g.mode === 'bidirectional' && t === fp) out.add(f) }
    out.delete(fp)
    return [...out]
  }
  /** Add/replace a runtime grant edge (durable when persistence is on). exp = ms epoch or null=forever. */
  function allow(from, to, mode, exp) {
    const f = projKey(from), t = projKey(to)
    runtimeAllow.set(`${f}>${t}`, { mode, exp: exp || null })
    if (persist) persistence.grants.put(f, t, { from: f, to: t, mode, exp: exp || null, granted_at: new Date().toISOString() }).catch(() => {})
  }
  /** Drop a runtime grant edge (+ its durable copy). Returns whether one existed. */
  function revoke(from, to) {
    const f = projKey(from), t = projKey(to)
    const had = runtimeAllow.delete(`${f}>${t}`)
    if (persist) persistence.grants.remove(f, t).catch(() => {})
    return had
  }
  /** Re-hydrate durable grants at startup so cross-project consent survives a restart (§14). */
  async function rehydrate() {
    if (!persist) return
    try {
      for (const g of await persistence.grants.all()) {
        if (g && g.from && g.to && (!g.exp || g.exp > Date.now())) runtimeAllow.set(`${projKey(g.from)}>${projKey(g.to)}`, { mode: g.mode === 'bidirectional' ? 'bidirectional' : 'send', exp: g.exp || null })
      }
    } catch { }
  }
  /** Sweep expired grants + stale pending requests; gc the durable grant store. */
  function gc(now = Date.now()) {
    for (const [k, g] of runtimeAllow) if (g.exp && g.exp <= now) runtimeAllow.delete(k)
    for (const [id, p] of pendingAccess) if (now - p.ts > 3600000) pendingAccess.delete(id)
    if (persist) persistence.grants.gcAll({ now }).catch(() => {})
  }
  // ---- pending access requests (request_project_access -> allow_project notifies the requester) ----
  const addPending = (reqId, rec) => pendingAccess.set(reqId, rec)
  const pendingFor = (from, to) => { const f = projKey(from), t = projKey(to); return [...pendingAccess.values()].filter(p => p.from === f && p.to === t) }
  const deletePending = reqId => pendingAccess.delete(reqId)

  return { setPolicy, mayInitiate, reachable, allow, revoke, rehydrate, gc, addPending, pendingFor, deletePending, get isOpen() { return open } }
}
