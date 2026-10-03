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
//
// v1.74.0 (#89 part 2): the record may also carry GUIDES — `behaviors.realm.guides` = { agent?: { text, min_bridge? },
// session?: { text, min_bridge? } }: the realm's own text for `aimb-log --guide agent|session` (and the log tool's guide),
// PULLED on request from a gateway, never pushed (no register_self, no connect reminder carries it). Each text ≤ 4 KB (UTF-8
// bytes; separate from the 365-char reminder cap), a string or an array of lines (joined with "\n"), no control characters
// but newline / tab; placeholders {cmd} {path} {gateway} {script} are filled when served (lib/log-snippet.js guideText).
// min_bridge (optional, "1.75" or "1.75.0") = the guide is served only to a requester (and by a gateway) on that version or
// newer; others get the built-in text. An invalid guide is DROPPED (never cut: a cut guide loses its ending), the rest of the
// record stands. Guides ride the same record, so they replicate (and are replaced, and cleared) exactly as the reminders do.
// Mixed versions: a ≤1.73 host keeps the reminders and drops `guides` from what it holds and re-gossips, so guides travel
// only across 1.74+ hops; beatsRealm() therefore ranks a record WITH guides above the same record without (same updated_at),
// so a guide-less copy relayed by an old host never blocks the real one.
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

// ---- v1.74.0 (#89 part 2): realm GUIDES
export const GUIDE_KINDS = Object.freeze(['agent', 'session'])
export const GUIDE_MAX_BYTES = 4096
export const GUIDE_PLACEHOLDERS = Object.freeze(['cmd', 'path', 'gateway', 'script'])
/** "1.75" / "1.75.0" → "1.75.0"; anything else → null */
export function normVersion(v) {
  const m = typeof v === 'string' ? /^\s*(\d{1,4})\.(\d{1,5})(?:\.(\d{1,6}))?\s*$/.exec(v) : null
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3] || 0)}` : null
}
/** a < b for "x.y.z" versions (missing parts = 0) */
export const verLt = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false }
/** One guide → { guide: { text, min_bridge? } } | { problem: "<why it is dropped>" }. A bare string / array = the text alone. */
export function normGuide(g) {
  if (typeof g === 'string' || Array.isArray(g)) g = { text: g }
  if (!g || typeof g !== 'object') return { problem: 'not an object { text, min_bridge? }' }
  let t = g.text
  if (Array.isArray(t)) { if (!t.every(x => typeof x === 'string')) return { problem: 'text as an array must hold only strings (one per line)' }; t = t.join('\n') }
  if (typeof t !== 'string') return { problem: 'text is missing (a string, or an array of lines)' }
  t = t.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '')
  if (!t.trim()) return { problem: 'text is empty' }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) return { problem: 'text has control characters (only newline and tab are allowed)' }
  const bytes = Buffer.byteLength(t, 'utf8')
  if (bytes > GUIDE_MAX_BYTES) return { problem: `text is ${bytes} bytes (at most ${GUIDE_MAX_BYTES})` }
  let min_bridge = null
  if (g.min_bridge != null && g.min_bridge !== '') { min_bridge = normVersion(String(g.min_bridge)); if (!min_bridge) return { problem: `min_bridge "${String(g.min_bridge).slice(0, 20)}" is not a version like "1.74.0"` } }
  return { guide: { text: t, ...(min_bridge ? { min_bridge } : {}) } }
}
/** A raw `guides` object → { guides: canonical { agent?, session? } | null, problems: ["agent: …", …] }. Unknown kinds are
 *  reported and ignored. Key order is fixed (agent, session; text, min_bridge) so equal guides serialise identically. */
export function checkGuides(raw) {
  const problems = []
  if (raw == null) return { guides: null, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { guides: null, problems: ['guides must be an object { agent?, session? }'] }
  const out = {}
  for (const k of Object.keys(raw)) if (!GUIDE_KINDS.includes(k)) problems.push(`${String(k).slice(0, 40)}: unknown guide kind (agent / session)`)
  for (const k of GUIDE_KINDS) {
    if (raw[k] == null) continue
    const r = normGuide(raw[k])
    if (r.problem) problems.push(`${k}: ${r.problem}`)
    else out[k] = r.guide
  }
  return { guides: Object.keys(out).length ? out : null, problems }
}

/** Canonicalise a realm-defaults record (from config, the wire, or the store). Null unless it has a valid updated_at
 *  AND a `default` list (array, or a string = one all-scope receive default). v1.74.0: + `guides` (only when one is valid). */
export function normRealmDefaults(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const updated_at = toMs(r.updated_at)
  if (!updated_at || !(Array.isArray(r.default) || typeof r.default === 'string')) return null
  const { guides } = checkGuides(r.guides)
  return { updated_at, default: canonList(r.default), ...(guides ? { guides } : {}), origin: typeof r.origin === 'string' ? r.origin.slice(0, 200) : '' }
}
/** The local CANDIDATE from a config's `behaviors.realm` block (origin = this host), or null if there's no valid block.
 *  A block with no `default` key means "no realm defaults" (an empty list), so it can clear an older record. */
export function realmFromConfig(cfg, origin) {
  const b = cfg && cfg.behaviors && cfg.behaviors.realm
  if (!b || typeof b !== 'object') return null
  return normRealmDefaults({ updated_at: b.updated_at, default: b.default == null ? [] : b.default, guides: b.guides, origin })
}
/** v1.74.0: why a config block's guides (or some of them) are dropped — for the bridge's log at load. */
export function realmGuideProblems(cfg) {
  const b = cfg && cfg.behaviors && cfg.behaviors.realm
  return b && typeof b === 'object' ? checkGuides(b.guides).problems : []
}
/** v1.74.0: the guide a held record publishes for `kind`, or why not: { guide, updated_at, origin } | { reason: 'none' } |
 *  { reason: 'min_bridge', min_bridge }. `version` must meet min_bridge: the bridge passes the LOWER of the requester's and
 *  the serving gateway's (a guide naming newer flags is wrong if either side lacks them); unknown → never meets one. */
export function realmGuideFor(rec, kind, version) {
  const g = rec && rec.guides && rec.guides[kind]
  if (!g) return { reason: 'none' }
  const v = normVersion(String(version || ''))
  if (g.min_bridge && (!v || verLt(v, g.min_bridge))) return { reason: 'min_bridge', min_bridge: g.min_bridge }
  return { guide: g, updated_at: rec.updated_at, origin: rec.origin || '' }
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
  const ga = JSON.stringify(a.guides || null), gb = JSON.stringify(b.guides || null)   // v1.74.0: with guides ('{…}') > without ('null')
  if (ga !== gb) return ga > gb
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
  let cur = null   // the winning record { updated_at, default, guides?, origin } | null (no realm defaults known)
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
  const current = () => cur ? { updated_at: cur.updated_at, default: cur.default.map(d => ({ ...d })), ...(cur.guides ? { guides: JSON.parse(JSON.stringify(cur.guides)) } : {}), origin: cur.origin } : null
  /** Re-hydrate the durable winner at startup, so a restarted host keeps the latest even if it can reach no one. */
  async function rehydrate() {
    if (!persist) return
    try {
      let best = cur
      for (const r of await persistence.realmDefaults.all()) best = mergeRealm(best, r)
      if (best !== cur) { cur = best; if (onChange) onChange(cur) }
    } catch { }
  }
  /** v1.74.0 (#89 part 2): the held record's guide for `kind` (see realmGuideFor). */
  const guide = (kind, version) => realmGuideFor(cur, kind, version)
  return { merge, current, rehydrate, guide }
}
