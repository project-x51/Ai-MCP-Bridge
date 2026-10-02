// #66(b) realm-wide DEFAULT reminders, as ONE replicated last-writer-wins record for the whole realm. The per-host
// `behaviors.default` lives in a config FILE, so a default added once (e.g. the #67 doorbell connect reminder) only
// reached hosts whose config was edited by hand. An operator now writes a `behaviors.realm` block in ANY host's config:
//   { "updated_at": "<ISO timestamp>", "default": [ {operation, scope, match, behavior}, ... ] }
// and it spreads mesh-wide. The record is { updated_at (ms epoch), default: [...], origin } and the greater
// `updated_at` wins. `updated_at` is EXPLICIT (set by the operator), never a file mtime, so an unrelated edit to some
// other host's config can't win. There is no local stamp bump either (unlike #62's allow/revoke): the operator's
// timestamp IS the order, so an OLDER block in a host's own config never overrides a newer one it learned. To clear
// the realm defaults, publish a newer record with `"default": []`.
// Same pattern as lib/consent.js's grant set (#62), but one record instead of one per edge: `merge()` keeps the record
// that wins `beatsRealm()`, a total order, so merge is idempotent + commutative and every host can re-gossip what it
// holds. bridge.mjs seeds the local candidate from its config (start + live-reload), moves the winner over PEER_ROSTER /
// ROSTER / REALM_DEFAULTS frames, and never touches the record directly; `onChange` hands the winner's list to the
// reminders module, which merges it UNDER the host's local defaults (lib/reminders.js effectiveDefaults).
import { normDefaults } from './reminders.js'

const MAX_ENTRIES = 64   // same cap as a session's own reminders (reminders.js MAX_COUNT) — bounds a junk/huge gossip record

// an operator timestamp: an ISO string (the config form) or ms epoch (the wire form). Returns ms > 0, else 0 (invalid).
function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
  if (typeof v === 'string' && v.trim()) { const n = Date.parse(v.trim()); return Number.isFinite(n) && n > 0 ? n : 0 }
  return 0
}
// canonical list: the behaviors.default validation (a string = one all-scope receive default), capped, then sorted so
// two records holding the same entries in a different order serialise identically (the tie rule compares JSON).
function canonList(d) {
  const arr = typeof d === 'string' ? [{ operation: 'receive', scope: 'all', match: null, behavior: d }] : d
  return normDefaults(arr).slice(0, MAX_ENTRIES)
    .map(x => ({ operation: x.operation, scope: x.scope, match: x.match, ...(x.id ? { id: x.id } : {}), behavior: x.behavior }))   // v1.64.0: + the optional id (#70 6c)
    .sort((a, b) => { const ja = JSON.stringify(a), jb = JSON.stringify(b); return ja < jb ? -1 : ja > jb ? 1 : 0 })
}

/** Canonicalise a realm-defaults record (from config, the wire, or the store). Null unless it has a valid updated_at
 *  AND a `default` list (array, or a string = one all-scope receive default). */
export function normRealmDefaults(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const updated_at = toMs(r.updated_at)
  if (!updated_at || !(Array.isArray(r.default) || typeof r.default === 'string')) return null
  return { updated_at, default: canonList(r.default), origin: typeof r.origin === 'string' ? r.origin.slice(0, 200) : '' }
}
/** The local CANDIDATE from a config's `behaviors.realm` block (origin = this host), or null if there's no valid block.
 *  A block with no `default` key means "no realm defaults" (an empty list), so it can clear an older record. */
export function realmFromConfig(cfg, origin) {
  const b = cfg && cfg.behaviors && cfg.behaviors.realm
  if (!b || typeof b !== 'object') return null
  return normRealmDefaults({ updated_at: b.updated_at, default: b.default == null ? [] : b.default, origin })
}
/** LWW total order: does record `a` beat record `b`? Greater updated_at wins; on a tie the greater canonical JSON of the
 *  list, then the greater origin — so two hosts holding the same pair always keep the same survivor. Identical
 *  records never beat each other (idempotent). Both must be normRealmDefaults() output. */
export function beatsRealm(a, b) {
  if (!a) return false
  if (!b) return true
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at
  const ja = JSON.stringify(a.default), jb = JSON.stringify(b.default)
  if (ja !== jb) return ja > jb
  return a.origin > b.origin
}
/** Pure merge: the winner of `cur` (a held record, or null) and `incoming` (raw — normalised here). */
export function mergeRealm(cur, incoming) {
  const r = normRealmDefaults(incoming)
  return r && beatsRealm(r, cur) ? r : cur
}

/**
 * @param {{ persistence: any, persist: boolean, writer: string, onChange?: (rec: any) => void }} ctx
 *   writer = this host's name: the durable copy is one file per host, so a shared store (the Dropbox pair) keeps one
 *   per machine and rehydrate() takes the LWW winner of them all.
 */
export function createRealmDefaults({ persistence, persist, writer, onChange }) {
  let cur = null   // the winning record { updated_at, default, origin } | null (no realm defaults known)
  /** Fold a record (a peer's, a follower's, or this host's own config candidate) in, last-writer-wins. Persists and
   *  fires onChange when it wins. Returns true if the held record changed. */
  function merge(incoming) {
    const next = mergeRealm(cur, incoming)
    if (next === cur) return false
    cur = next
    if (persist) persistence.realmDefaults.put(writer, cur).catch(() => {})
    if (onChange) onChange(cur)
    return true
  }
  /** The held record, for gossip (a copy; null when none). */
  const current = () => cur ? { updated_at: cur.updated_at, default: cur.default.map(d => ({ ...d })), origin: cur.origin } : null
  /** Re-hydrate the durable winner at startup, so a restarted host keeps the latest even if it can reach no one. */
  async function rehydrate() {
    if (!persist) return
    try {
      let best = cur
      for (const r of await persistence.realmDefaults.all()) best = mergeRealm(best, r)
      if (best !== cur) { cur = best; if (onChange) onChange(cur) }
    } catch { }
  }
  return { merge, current, rehydrate }
}
