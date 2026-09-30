// #66(c) retained topic values, replicated mesh-wide as a last-writer-wins SET keyed by (realm, project, topic).
// A `publish {retain:true}` used to live only in the PUBLISHING host's persistence store, so a subscriber that joined
// on another machine (a separate store) never got the value. Each bridge now also holds, in RAM, the newest retained
// record per (realm, project, topic) it knows — its own publishes plus what it learned — and re-gossips the set, so a
// value published anywhere reaches every host; what a host learns it persists into its own store (one file per writing
// host per topic, like #66b's realm defaults), so it survives a restart and its publisher going offline.
// A record is { realm, project, topic, ts (ms epoch = the publish time), env (the stored, body-ciphered envelope),
// origin } and the greater `ts` wins (then the greater envelope id — a total order, so merge is idempotent +
// commutative, exactly like #62's grants). There are no tombstones: a newer publish simply replaces the value.
// SIZE CAP: a record whose envelope serialises to more than `maxBytes` (default 64KB) is NOT replicated. The publisher
// keeps it locally (as before) and gossips a small MARKER in its place, { …, env:null, too_large:<bytes> }, which
// beats any older replicated value for that topic, so no host serves a stale value it can't replace. A subscriber on
// another host then gets nothing for that topic (the value is only on the publishing host's store).
// TTL: a record older than `ttlMs` (the store's retainedTtlDays, measured from the ORIGINAL publish time) is never
// accepted, is dropped by gc(), and is never listed or gossiped — the same expiry the store's own gcAll applies.
// bridge.mjs moves the set over PEER_ROSTER / ROSTER / RETAINED frames and never touches the map directly.
import { projKey } from './keys.js'
import { patternKey, isWildcard } from './topics.js'

export const RETAIN_REPLICATE_MAX_BYTES = 64 * 1024        // per-record cap (the envelope's JSON size)
export const RETAIN_GOSSIP_MAX_BYTES = 4 * 1024 * 1024     // per-frame budget for the whole set (frames die above 8MB)
const MARKER_BYTES = 256                                   // budget charge for a too-large marker

/** The replication key: realm | project (case-insensitive) | topic (case-insensitive per level). */
export const retainedKey = r => `${r.realm}|${projKey(r.project)}|${patternKey(r.topic)}`
/** The size a record's envelope costs on the wire (its JSON, UTF-8). */
export function envBytes(env) { try { return Buffer.byteLength(JSON.stringify(env), 'utf8') } catch { return Infinity } }
const str = (v, max = 500) => typeof v === 'string' ? v.trim().slice(0, max) : ''

/** Canonicalise a record (local, durable or gossiped). Null unless it names a CONCRETE topic, has a publish time and
 *  either an envelope within `maxBytes` or is a too-large marker. An envelope over the cap becomes a marker.
 *  @returns {import('../types').RetainedRecord | null} */
export function normRetained(r, maxBytes = RETAIN_REPLICATE_MAX_BYTES) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const realm = str(r.realm, 200), project = str(r.project, 200), topic = str(r.topic)
  if (!realm || !project || !topic || isWildcard(topic)) return null
  const ts = Number(r.ts)
  if (!Number.isFinite(ts) || ts <= 0) return null
  const origin = str(r.origin, 200)
  const env = r.env && typeof r.env === 'object' && !Array.isArray(r.env) && typeof r.env.id === 'string' ? r.env : null
  if (env) {
    const bytes = envBytes(env)
    if (bytes <= maxBytes) return { realm, project, topic, ts: Math.floor(ts), env, origin }
    return { realm, project, topic, ts: Math.floor(ts), env: null, too_large: bytes, origin }
  }
  const tl = Number(r.too_large)
  return Number.isFinite(tl) && tl > 0 ? { realm, project, topic, ts: Math.floor(ts), env: null, too_large: Math.floor(tl), origin } : null
}
/** LWW total order for the same key: greater ts wins; on a tie the greater envelope id (a marker's is ''), then the
 *  greater too_large. Identical records never beat each other (idempotent). Both must be normRetained() output. */
export function beatsRetained(a, b) {
  if (!a) return false
  if (!b) return true
  if (a.ts !== b.ts) return a.ts > b.ts
  const ia = a.env ? a.env.id : '', ib = b.env ? b.env.id : ''
  if (ia !== ib) return ia > ib
  return (a.too_large || 0) > (b.too_large || 0)
}
/** A record from the file store's { project, topic, record:{ ts, env } } shape (for rehydrate). */
export function retainedFromStore(s, realm, origin, maxBytes) {
  const rec = s && s.record
  if (!rec || !rec.env) return null
  return normRetained({ realm, project: s.project, topic: s.topic, ts: Date.parse(rec.ts || rec.env.ts || ''), env: rec.env, origin }, maxBytes)
}

/**
 * @param {{ persistence: any, persist: boolean, writer: string, ttlMs?: number, maxBytes?: number, gossipMaxBytes?: number,
 *   realm?: string, log?: (...a: any[]) => void }} ctx
 *   writer = this host's name: a LEARNED record is persisted under a synthetic identity { user:'#replicated', name:writer }
 *   — one file per writing host per topic — so a shared store keeps one copy per machine and read() takes the newest.
 */
export function createRetainedSet({ persistence, persist, writer, ttlMs = 0, maxBytes = RETAIN_REPLICATE_MAX_BYTES,
  gossipMaxBytes = RETAIN_GOSSIP_MAX_BYTES, realm = 'default', log = () => {} }) {
  const map = new Map()   // retainedKey -> record
  let version = 0, listCache = null, listV = -1, overBudgetLogged = -1
  const expired = (r, now = Date.now()) => !!ttlMs && now - r.ts > ttlMs
  function store(r) {   // durable copy of a LEARNED record (the publisher's own copy is written by the publish path)
    const ident = { realm: r.realm, project: r.project, user: '#replicated', name: writer }
    const rec = r.env ? { ts: new Date(r.ts).toISOString(), env: r.env } : { ts: new Date(r.ts).toISOString(), env: null, too_large: r.too_large }
    persistence.retained.put(r.project, r.topic, ident, rec).catch(() => {})
  }
  /** Fold records in (a peer's set, a follower's, or this host's own publish). `opts.persist:false` for a local publish
   *  (already stored under the publisher) or a rehydrate. Returns the number of records that changed. */
  function merge(list, opts = {}) {
    if (!Array.isArray(list)) return 0
    let n = 0
    const now = Date.now()
    for (const raw of list) {
      const r = normRetained(raw, maxBytes)
      if (!r || expired(r, now)) continue
      const k = retainedKey(r)
      if (!beatsRetained(r, map.get(k))) continue
      map.set(k, r); n++
      if (persist && opts.persist !== false) store(r)
    }
    if (n) version++
    return n
  }
  /** The set to gossip: live records, newest first, within the per-frame byte budget (older ones beyond it stay
   *  local — logged once per version). Cached per version. */
  function list() {
    if (listV === version && listCache) return listCache
    const now = Date.now(), out = []
    let total = 0, skipped = 0
    for (const r of [...map.values()].sort((a, b) => b.ts - a.ts)) {
      if (expired(r, now)) continue
      const cost = r.env ? envBytes(r.env) : MARKER_BYTES
      if (total + cost > gossipMaxBytes) { skipped++; continue }
      total += cost; out.push(r)
    }
    if (skipped && overBudgetLogged !== version) { overBudgetLogged = version; log(`retained: ${skipped} older value(s) over the ${gossipMaxBytes}-byte gossip budget stay local (not replicated this round)`) }
    listCache = out; listV = version
    return out
  }
  /** Live records for one (realm, project) — the subscribe-time catch-up source (markers included; the caller skips
   *  them, and they suppress an older value from the store). */
  function forProject(rlm, project) {
    const now = Date.now(), pk = projKey(project), out = []
    for (const r of map.values()) if (r.realm === rlm && projKey(r.project) === pk && !expired(r, now)) out.push(r)
    return out
  }
  /** Drop expired records. Returns the count dropped. */
  function gc() {
    const now = Date.now(); let n = 0
    for (const [k, r] of [...map]) if (expired(r, now)) { map.delete(k); n++ }
    if (n) version++
    return n
  }
  /** Re-hydrate from the durable store at startup (own publishes + what was learned), so a restarted host keeps
   *  serving AND re-gossiping values whose publisher is offline. An over-cap stored value comes back as a marker. */
  async function rehydrate() {
    if (!persist || !persistence.retained.all) return
    try {
      const recs = []
      for (const s of await persistence.retained.all()) {
        const r = retainedFromStore(s, realm, writer, maxBytes)
        if (r) recs.push(r)
        else if (s && s.record && s.record.too_large) recs.push({ realm, project: s.project, topic: s.topic, ts: Date.parse(s.record.ts || ''), env: null, too_large: s.record.too_large, origin: writer })
      }
      merge(recs, { persist: false })
    } catch { }
  }
  /** The held record for one (realm, project, topic), or null — e.g. the normalised form of a publish (a marker when
   *  it was over the cap) to send up from a follower without re-sending the whole set. */
  const get = (rlm, project, topic) => map.get(retainedKey({ realm: rlm, project, topic })) || null
  return { merge, list, get, forProject, gc, rehydrate, version: () => version, size: () => map.size }
}
