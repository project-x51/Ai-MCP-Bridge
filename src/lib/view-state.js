// #88 (v2.0) build step 8: PER-USER VIEW STATE (docs/spec-88.md §5.6, Q13 / Q28 / Q29 / Q30 / Q38 / Q41).
//
// What a viewer chooses about the activity tree and log — pins, hidden rows, open / closed, Expand / Collapse all, the
// log selection, the DETAILS fold, "last seen", the options and Reset view — kept PER USER on the gateway (the user = the
// serving gateway's OS login, Q29) and REPLICATED across the realm, so the same person sees the same board on every
// host. The patterns are architecture.md §13's: #62's last-writer-wins set with tombstones and local stamp bumps, #66c's
// "persist what you learn, one file per writing host". Keyed by NODE ID (a 16-char id; a non-node row — a project /
// session header — by its unit id string), so a choice survives a rename, a move and a restart.
//
// THE RECORD: { realm, user, k, v, ts, origin[, g] } — user = lc(an OS login), k = the choice (below), v = its value
// (null = a TOMBSTONE: "back to the default"), ts = ms, origin = the host that wrote it; `g` (seen: only) = its
// GENERATION (below). Keys:
//   pin:<t> 1 · hide:<t> 1 · open:<t> {o:1} | {o:0, n, q} · all {o:1|0} · sel "<t>" · fold:details 1|0 ·
//   seen:<t> "<entry id>" · opt:<name> a small scalar (show_removed, log_order, active_only, plans_only …) · reset 1
// A value is ≤ 128 bytes of JSON; a user holds ≤ 4 000 live records (the newest kept, a log line when trimmed).
//
// THE ORDER (beatsView, a TOTAL order, so merge is idempotent and commutative): greater ts; on a tie the tombstone, then
// the greater origin, then the greater canonical JSON of v. `seen:` is a MAX REGISTER instead: (g, then the entry order
// of v — time, then sequence, then the id; a tombstone lowest —, then ts, origin): merge keeps the newer entry, so it
// never moves back. Its generation `g` lets a FORGET win over it: a tombstone (the node left the board, or the page
// forgot it) and the first seen after a Reset view are written one generation up, so they beat every older value and a
// later seen of the same generation beats the tombstone again (a max register alone could never be pruned).
// A LOCAL write stamps ts = max(now, known + 1) for that key (and above the user's reset), so it beats what this host
// knows even under clock skew; a reset is stamped above every record of the user it knows, so it voids all of them.
// RESET VIEW (`reset`): every record of that user with an older ts is VOID — not served, dropped by gc() once 30 days old.
// EXPAND / COLLAPSE ALL (`all`): one record; it applies to every node CREATED BEFORE its ts that has no newer `open:`
// record (openState); later nodes take the default.
//
// bridge.mjs only calls set(), merge(), forUser(), rehydrate(), gc() (+ the gossip helpers list() / viewV(), the file
// image toFile(), tombstone() for pruning and pinned() for the transient-keep rule); this module never touches sockets
// or files, so the unit tests drive it directly.
import crypto from 'node:crypto'
import { lc } from './keys.js'
import { entryTime } from './activity.js'

export const VIEW_FORMAT = 1                          // the views/<host>.json file format
export const VIEW_TTL_MS = 30 * 86400000              // tombstones / voided / orphaned records: dropped after this (AI_BRIDGE_VIEW_TOMBSTONE_TTL_MS)
export const VIEW_VALUE_MAX_BYTES = 128               // a value's JSON
export const VIEW_MAX_LIVE_PER_USER = 4000            // live records per user (newest kept)
export const VIEW_GOSSIP_MAX_BYTES = 1024 * 1024      // a full VIEW frame's budget (newest first; the rest stays local)
export const VIEW_SET_MAX_RECS = 256                  // records per page view_set
export const VIEW_V_NEWEST = 64                       // view_v hashes the newest 64 (user, k, ts)
/** The option names the dashboard keeps (§5.1 show_removed, Q38). Any other `opt:<name>` ([a-z0-9_]{1,32}) is accepted too. */
export const VIEW_OPTIONS = Object.freeze(['show_removed', 'log_order', 'active_only', 'plans_only'])

const NODE_ID_RE = /^[a-z2-7]{16}$/
const OPT_RE = /^[a-z0-9_]{1,32}$/
const ENTRY_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/
const T_MAX = 200
const utf8 = s => Buffer.byteLength(s, 'utf8')
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
/** Canonical JSON (sorted keys) — the last tie-break of the order. */
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v)
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
}
/** A target <t>: a node id (16 chars a-z 2-7) or a non-node row's unit id string (printable, ≤ 200 chars). */
export function validTarget(t) { return typeof t === 'string' && t.length > 0 && t.length <= T_MAX && !/[\u0000-\u001f\u007f]/.test(t) && t.trim() === t }
export const isNodeId = t => typeof t === 'string' && NODE_ID_RE.test(t)
/** The user a view belongs to: lc(trimmed login), ≤ 64 chars, or null. */
export function viewUser(name) { const s = typeof name === 'string' ? name.trim().toLowerCase().slice(0, 64) : ''; return s && !/[\u0000-\u001f\u007f]/.test(s) ? s : null }

/**
 * Parse a record key → { k, kind, t?, name? } or null. Kinds: pin, hide, open, seen (with a target), opt (with a name),
 * fold ("fold:details" only), all, sel, reset.
 */
export function parseViewKey(k) {
  if (typeof k !== 'string' || !k || k.length > T_MAX + 8) return null
  if (k === 'all' || k === 'sel' || k === 'reset') return { k, kind: k }
  if (k === 'fold:details') return { k, kind: 'fold' }
  const i = k.indexOf(':')
  if (i < 0) return null
  const kind = k.slice(0, i), rest = k.slice(i + 1)
  if (kind === 'opt') return OPT_RE.test(rest) ? { k, kind, name: rest } : null
  if (kind === 'pin' || kind === 'hide' || kind === 'open' || kind === 'seen') return validTarget(rest) ? { k, kind, t: rest } : null
  return null
}
/** The target a key names (pin / hide / open / seen), else null. */
export const targetOf = k => { const p = parseViewKey(k); return p && p.t ? p.t : null }
const nat = v => Number.isInteger(v) && v >= 0 && v <= 1e9
/**
 * Validate a value for its key kind → the value (null = a tombstone) or undefined (refused). `reset` takes 1 only (a
 * reset is never undone); everything else may be a tombstone.
 */
export function normViewValue(kind, v) {
  if (v === null) return kind === 'reset' ? undefined : null
  let out
  switch (kind) {
    case 'pin': case 'hide': case 'reset': out = v === 1 || v === true ? 1 : undefined; break
    case 'fold': out = v === 1 || v === true ? 1 : v === 0 || v === false ? 0 : undefined; break
    case 'all': out = v && typeof v === 'object' && !Array.isArray(v) && (v.o === 1 || v.o === 0) && Object.keys(v).length === 1 ? { o: v.o } : undefined; break
    case 'open':
      if (!v || typeof v !== 'object' || Array.isArray(v)) out = undefined
      else if (v.o === 1 && Object.keys(v).length === 1) out = { o: 1 }
      else if (v.o === 0 && Object.keys(v).every(x => x === 'o' || x === 'n' || x === 'q') && (v.n === undefined || nat(v.n)) && (v.q === undefined || nat(v.q))) out = { o: 0, n: v.n || 0, q: v.q || 0 }
      else out = undefined
      break
    case 'sel': out = validTarget(v) ? v : undefined; break
    case 'seen': out = typeof v === 'string' && ENTRY_ID_RE.test(v) && entryTime(v) != null ? v : undefined; break
    case 'opt': out = typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v)) ? v : undefined; break
    default: out = undefined
  }
  if (out !== undefined && utf8(JSON.stringify(out)) > VIEW_VALUE_MAX_BYTES) return undefined
  return out
}
/**
 * Canonicalise a record (local, gossiped or from a file) of `realm` → the record, or null (another realm, a bad key /
 * user / value / ts). The generation `g` is kept on `seen:` records only.
 */
export function normViewRec(r, realm) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  if (realm != null && r.realm !== realm) return null
  const user = viewUser(r.user), p = parseViewKey(r.k)
  if (!user || !p) return null
  const ts = Number(r.ts)
  if (!Number.isFinite(ts) || ts <= 0 || ts > 8.64e15) return null
  const v = normViewValue(p.kind, r.v === undefined ? null : r.v)
  if (v === undefined) return null
  const origin = typeof r.origin === 'string' ? r.origin.trim().slice(0, 200) : ''
  const out = /** @type {any} */ ({ realm: String(r.realm == null ? realm : r.realm), user, k: p.k, v, ts: Math.floor(ts), origin })
  if (p.kind === 'seen') out.g = Number.isInteger(r.g) && r.g >= 0 && r.g <= 1e9 ? r.g : 0
  return out
}
/** The order of two entry ids: their time, then sequence, then the id string (null = lowest). */
export function entryCmp(a, b) {
  if (a === b) return 0
  if (a == null) return -1
  if (b == null) return 1
  const ta = entryTime(a), tb = entryTime(b)
  if (ta !== tb) return (ta == null ? -1 : tb == null ? 1 : ta - tb) < 0 ? -1 : 1
  const sq = id => { const m = id.match(/-([0-9a-z]+)$/); const n = m ? parseInt(m[1], 36) : 0; return Number.isFinite(n) ? n : 0 }
  const sa = sq(a), sb = sq(b)
  if (sa !== sb) return sa < sb ? -1 : 1
  return cmp(a, b)
}
/**
 * Does record `a` beat `b` (same user and key)? A TOTAL order: identical records never beat each other.
 * Everything but seen: greater ts; on a tie the tombstone, then the greater origin, then the greater canonical JSON of v.
 * seen: (greater g, greater entry, greater ts, greater origin) — a max register that a generation-up tombstone can beat.
 */
export function beatsView(a, b) {
  if (!a) return false
  if (!b) return true
  if (a.k.startsWith('seen:')) {
    const ga = a.g || 0, gb = b.g || 0
    if (ga !== gb) return ga > gb
    const e = entryCmp(a.v, b.v)
    if (e) return e > 0
    if (a.ts !== b.ts) return a.ts > b.ts
    return a.origin > b.origin
  }
  if (a.ts !== b.ts) return a.ts > b.ts
  if ((a.v === null) !== (b.v === null)) return a.v === null
  if (a.origin !== b.origin) return a.origin > b.origin
  return canon(a.v) > canon(b.v)
}
/**
 * Is node `t` open for this user? `recs` = the user's LIVE records as a Map k → record (forUser's list keyed), `createdAt`
 * = the node's creation time. → 1 (open) | 0 (closed) | null (the default rule decides). An `open:` record beats the
 * default; `all` covers the nodes created before its ts that have no NEWER `open:` record (§5.6, H17).
 */
export function openState(recs, t, createdAt) {
  const get = k => (recs instanceof Map ? recs.get(k) : Array.isArray(recs) ? recs.find(r => r.k === k) : null) || null
  const o = get(`open:${t}`), all = get('all')
  const oLive = o && o.v != null ? o : null, aLive = all && all.v != null ? all : null
  if (aLive && Number.isFinite(createdAt) && createdAt < aLive.ts && (!oLive || oLive.ts < aLive.ts)) return aLive.v.o
  return oLive ? oLive.v.o : null
}

/**
 * The view set of one gateway: every user's records of its realm (own + learned).
 * @param {{ realm?: string, origin?: string, ttlMs?: number, maxLive?: number, gossipMaxBytes?: number, log?: (line: string) => void }} [o]
 */
export function createViewSet(o = {}) {
  const realm = String(o.realm || 'default'), origin = String(o.origin || 'host')
  const ttlMs = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : VIEW_TTL_MS
  const maxLive = Number(o.maxLive) > 0 ? Math.floor(Number(o.maxLive)) : VIEW_MAX_LIVE_PER_USER
  const gossipMax = Number(o.gossipMaxBytes) > 0 ? Number(o.gossipMaxBytes) : VIEW_GOSSIP_MAX_BYTES
  const log = typeof o.log === 'function' ? o.log : () => { }
  const map = new Map()          // `${user}\n${k}` -> record
  const resets = new Map()       // user -> its reset record (also in map)
  let version = 0, listCache = null, listV = -1, overLogged = -1, vvCache = null, vvV = -1
  const keyOf = r => `${r.user}\n${r.k}`
  const resetTs = user => { const r = resets.get(user); return r ? r.ts : -Infinity }
  const voided = r => r.k !== 'reset' && r.ts < resetTs(r.user)
  const live = r => r.v !== null && !voided(r)
  function put(r) {
    map.set(keyOf(r), r)
    if (r.k === 'reset') resets.set(r.user, r)
  }
  function del(key) {
    const r = map.get(key)
    if (!r) return
    map.delete(key)
    if (r.k === 'reset' && resets.get(r.user) === r) resets.delete(r.user)
  }
  /** Keep a user's LIVE records within the budget (the reset record exempt): the oldest go, with a log line. → keys dropped */
  function trim(user) {
    const mine = []
    for (const r of map.values()) if (r.user === user && r.k !== 'reset' && live(r)) mine.push(r)
    if (mine.length <= maxLive) return new Set()
    mine.sort((a, b) => a.ts - b.ts || cmp(a.k, b.k))
    const drop = mine.slice(0, mine.length - maxLive), out = new Set()
    for (const r of drop) { const k = keyOf(r); del(k); out.add(k) }
    log(`view: ${user} holds more than ${maxLive} view records — the ${drop.length} oldest were dropped (newest kept)`)
    return out
  }
  const bump = () => { version++ }

  /** Fold records in (a peer's VIEW frame, a file at rehydrate). → the records that CHANGED the set (to forward / push). */
  function merge(list, now = Date.now()) {
    if (!Array.isArray(list)) return []
    const changed = new Map()
    for (const raw of list) {
      const r = normViewRec(raw, realm)
      if (!r) continue
      if (r.v === null && now - r.ts > ttlMs) continue          // an expired tombstone is never taken back in (#62)
      const key = keyOf(r)
      if (!beatsView(r, map.get(key))) continue
      put(r); changed.set(key, r)
    }
    if (changed.size) {
      for (const u of new Set([...changed.values()].map(r => r.user))) for (const k of trim(u)) changed.delete(k)
      bump()
    }
    return [...changed.values()]
  }
  /**
   * A LOCAL write by `user` (the page's view_set): each { k, v } validated and STAMPED here — ts = max(now, known + 1, the
   * user's reset + 1) (a reset: above every record of the user), origin = this host; a seen: keeps the greater entry (an
   * older one changes nothing) and goes a generation up after a tombstone-free void. → { changed:[records], refused:[{ k, code, what }] }
   */
  function set(userName, recs, now = Date.now()) {
    const user = viewUser(userName), refused = [], changed = new Map()
    if (!user) return { changed: [], refused: [{ k: null, code: 'bad-user', what: 'no view user' }] }
    const items = Array.isArray(recs) ? recs : []
    if (items.length > VIEW_SET_MAX_RECS) refused.push({ k: null, code: 'too-many', what: `at most ${VIEW_SET_MAX_RECS} records per view_set — the rest were ignored` })
    for (const it of items.slice(0, VIEW_SET_MAX_RECS)) {
      const p = it && typeof it === 'object' ? parseViewKey(it.k) : null
      if (!p) { refused.push({ k: it && typeof it.k === 'string' ? it.k.slice(0, 80) : null, code: 'bad-key', what: 'k must be pin:<t> | hide:<t> | open:<t> | seen:<t> | all | sel | fold:details | opt:<name> | reset' }); continue }
      const v = normViewValue(p.kind, it.v === undefined ? null : it.v)
      if (v === undefined) { refused.push({ k: p.k, code: 'bad-value', what: `a value ${p.kind === 'reset' ? '1' : 'valid'} for ${p.k} (≤ ${VIEW_VALUE_MAX_BYTES} bytes of JSON)` }); continue }
      const r = stamp(user, p, v, now)
      if (!r) continue
      put(r); changed.set(keyOf(r), r)
    }
    if (changed.size) { for (const k of trim(user)) changed.delete(k); bump() }
    return { changed: [...changed.values()], refused }
  }
  /** One locally stamped record, or null when it would change nothing. */
  function stamp(user, p, v, now) {
    const key = `${user}\n${p.k}`, known = map.get(key) || null
    let ts = Math.max(Math.floor(now), known ? known.ts + 1 : 0)
    if (p.kind === 'reset') { for (const r of map.values()) if (r.user === user && r.ts >= ts) ts = r.ts + 1 }
    else ts = Math.max(ts, resetTs(user) + 1)
    const r = /** @type {any} */ ({ realm, user, k: p.k, v, ts, origin })
    if (p.kind === 'seen') {
      const kLive = known && known.v !== null && !voided(known)
      if (v === null) { if (!known || !kLive) return null; r.g = (known.g || 0) + 1 }   // forget: a generation up
      else if (!known) r.g = 0
      else if (known.v === null) r.g = known.g || 0                                    // after a tombstone: same generation, any entry beats it
      else if (voided(known)) r.g = (known.g || 0) + 1                                 // after a reset: a generation up
      else { if (entryCmp(v, known.v) <= 0) return null; r.g = known.g || 0 }          // a max register: never back
    } else if (p.kind !== 'reset') {
      const kLive = known && known.v !== null && !voided(known)
      if (v === null && !kLive) return null                                            // forgetting what is not set
      if (kLive && canon(known.v) === canon(v)) return null                            // already so
    }
    return r
  }
  /**
   * PRUNING (§5.6): node `t` LEFT the board (a remove applied or received, a merge-away) → a tombstone, stamped locally,
   * for every live record of any user whose key names one of `targets`. → the tombstones written.
   */
  function tombstone(targets, now = Date.now()) {
    const want = targets instanceof Set ? targets : new Set(targets || [])
    if (!want.size) return []
    const out = []
    for (const r of [...map.values()]) {
      if (r.v === null || voided(r)) continue
      const t = targetOf(r.k)
      if (!t || !want.has(t)) continue
      const p = parseViewKey(r.k), n = stamp(r.user, p, null, now)
      if (n) { put(n); out.push(n) }
    }
    if (out.length) bump()
    return out
  }
  /** The user's LIVE records (no tombstones, nothing a reset voided; its reset record included), by key. */
  function forUser(userName) {
    const user = viewUser(userName), out = []
    if (!user) return out
    for (const r of map.values()) if (r.user === user && live(r)) out.push(r)
    return out.sort((a, b) => cmp(a.k, b.k))
  }
  /**
   * GC (every 10 min): tombstones and reset-voided records older than the TTL are dropped; so is a LIVE record older than
   * the TTL whose node no gateway holds any more (`isHeld(t)` false — a node id only; no tombstone, as #62's TTL).
   * → { dropped, tombstones, voided, orphans }
   */
  function gc(now = Date.now(), opts = {}) {
    const isHeld = typeof opts.isHeld === 'function' ? opts.isHeld : null
    const out = { dropped: 0, tombstones: 0, voided: 0, orphans: 0 }
    for (const [key, r] of [...map]) {
      if (now - r.ts <= ttlMs) continue
      if (r.v === null) { del(key); out.tombstones++ }
      else if (voided(r)) { del(key); out.voided++ }
      else if (isHeld) { const t = targetOf(r.k); if (t && isNodeId(t) && !isHeld(t)) { del(key); out.orphans++ } }
    }
    out.dropped = out.tombstones + out.voided + out.orphans
    if (out.dropped) bump()
    return out
  }
  /** Re-hydrate from the views/*.json images (own + other hosts', read only): [{ name, data }] → { files, merged, bad } */
  function rehydrate(files, now = Date.now()) {
    let merged = 0, bad = 0, n = 0
    for (const f of Array.isArray(files) ? files : []) {
      const d = f && f.data
      if (!d || typeof d !== 'object' || d.v !== VIEW_FORMAT || !Array.isArray(d.recs)) { bad++; continue }
      n++
      merged += merge(d.recs, now).length
    }
    return { files: n, merged, bad }
  }
  /** The whole set NEWEST FIRST within the gossip budget (a full VIEW frame); older ones beyond it stay local (logged once
   * per version). → { recs, skipped } */
  function list() {
    if (listV === version && listCache) return listCache
    const recs = [], all = [...map.values()].sort((a, b) => b.ts - a.ts || cmp(a.user, b.user) || cmp(a.k, b.k))
    let bytes = 0, skipped = 0
    for (const r of all) { const b = utf8(JSON.stringify(r)) + 1; if (bytes + b > gossipMax) { skipped++; continue } bytes += b; recs.push(r) }
    if (skipped && overLogged !== version) { overLogged = version; log(`view: ${skipped} older view record(s) over the ${gossipMax}-byte VIEW budget stay local (not sent this round)`) }
    listCache = { recs, skipped }; listV = version
    return listCache
  }
  /** Anti-entropy (PEER_ROSTER `view_v`): the record count + a hash of the newest 64 (user, k, ts). */
  function viewV() {
    if (vvV === version && vvCache) return vvCache
    const newest = [...map.values()].sort((a, b) => b.ts - a.ts || cmp(a.user, b.user) || cmp(a.k, b.k)).slice(0, VIEW_V_NEWEST)
    const h = crypto.createHash('sha1').update(newest.map(r => `${r.user}\n${r.k}\n${r.ts}`).join('\n')).digest('hex').slice(0, 16)
    vvCache = { n: map.size, h }; vvV = version
    return vvCache
  }
  /** The file image this host writes (views/<lslug(host)>.json): the WHOLE set it holds, own + learned. */
  function toFile(host, now = Date.now()) {
    return { v: VIEW_FORMAT, host: String(host || origin), realm, written_at: now, recs: [...map.values()].sort((a, b) => cmp(a.user, b.user) || cmp(a.k, b.k)) }
  }
  /** Every target with a LIVE pin of any user (the owner's transient-keep rule, §3.8). */
  function pinned() {
    const out = new Set()
    for (const r of map.values()) if (r.k.startsWith('pin:') && live(r)) out.add(r.k.slice(4))
    return out
  }
  /** Users and their live record counts (the tap). */
  function users() {
    const out = {}
    for (const r of map.values()) if (live(r)) out[r.user] = (out[r.user] || 0) + 1
    return out
  }
  return {
    realm, origin, merge, set, tombstone, forUser, gc, rehydrate, list, viewV, toFile, pinned, users,
    get: (user, k) => map.get(`${viewUser(user)}\n${k}`) || null,
    all: () => [...map.values()],
    version: () => version, size: () => map.size,
  }
}
