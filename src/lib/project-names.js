// #71 ONE canonical DISPLAY spelling per project, mesh-wide. Project MATCHING has always been case-insensitive
// (projKey), but every surface showed whatever spelling it happened to hold: a grant came back `{from:"aimb"}` (the
// consent layer stores projKey'd edges), `access` listed "aimb" while the AIMB session registered as "AIMB", and
// list_sessions showed "Marz" and "marz" side by side, which reads as two projects.
// The rule: the FIRST-SEEN spelling of a project is canonical. A record is { name, first_seen (ms epoch) } per
// projKey(name); a sighting (a registration, a page, a bridge's own identity, a grant naming the project, or a roster
// entry a gateway sees) folds in as { name, first_seen: now }, and the EARLIEST first_seen wins, then (a tie) the
// lexically smallest name — so an uppercase spelling beats its lowercase twin seen in the same millisecond. That order
// is total, so merge is idempotent + commutative and every host can re-gossip the whole map (like #62's grants and
// #66b's realm defaults): bridge.mjs carries list() on PEER_ROSTER / ROSTER as `project_names` and sends a follower's
// sightings UP in a PROJECT_NAMES frame. A later sighting in another case never changes an existing entry, so a new
// registration as "marz" shows as "Marz" once "Marz" is canonical. This module only maps what is SHOWN — identities,
// persistence keys and the wire keep the declared spelling, and nothing compares the display name.
import { projKey } from './keys.js'

const MAX_ENTRIES = 1000   // bounds a junk/huge gossip map (a new project beyond it keeps its declared spelling)
const MAX_NAME = 100

/** Canonicalise one record (local, durable or gossiped). Null for anything without a usable name + first_seen, and
 *  for the 'unclassified' bucket (infrastructure — never a project to spell). */
export function normProjectName(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, MAX_NAME) : ''
  if (!name || projKey(name) === 'unclassified') return null
  const fs = Number(r.first_seen)
  if (!Number.isFinite(fs) || fs <= 0) return null
  return { name, first_seen: Math.floor(fs) }
}
/** Total order for the same projKey: does `a` beat `b`? Earlier first_seen wins; on a tie the lexically smaller name
 *  (code-unit order: "AIMB" < "aimb", "Marz" < "marz"). A record never beats itself (idempotent). Both normalised. */
export function beatsName(a, b) {
  if (!a) return false
  if (!b) return true
  if (a.first_seen !== b.first_seen) return a.first_seen < b.first_seen
  return a.name < b.name
}

/**
 * @param {{ persistence: any, persist: boolean, writer: string }} ctx
 *   writer = this host's name: the durable copy is one file per host (like #66b), so a shared store keeps one per
 *   machine and rehydrate() folds them all.
 */
export function createProjectNames({ persistence, persist, writer }) {
  const map = new Map()   // projKey -> { name, first_seen }
  let listCache = null
  const save = () => { if (persist && persistence.projectNames) persistence.projectNames.put(writer, list()).catch(() => {}) }
  function fold(raw) {
    const r = normProjectName(raw); if (!r) return false
    const k = projKey(r.name), cur = map.get(k)
    if (!cur && map.size >= MAX_ENTRIES) return false
    if (!beatsName(r, cur)) return false
    map.set(k, r); return true
  }
  /** Fold records in (a peer's map, a follower's, the store). Persists on change. Returns how many entries changed. */
  function merge(records) {
    if (!Array.isArray(records)) return 0   // a ≤1.56 peer sends no map
    let n = 0
    for (const r of records) if (fold(r)) n++
    if (n) { listCache = null; save() }
    return n
  }
  /** A sighting of `name` at `ts` (default now). Changes nothing when the project already has an earlier spelling. */
  const note = (name, ts = Date.now()) => merge([{ name, first_seen: ts }]) > 0
  /** Is a spelling for this project already known? (lets a caller skip a no-op note cheaply) */
  const has = name => map.has(projKey(name))
  /** The canonical display spelling for `p` — the declared value itself when the project is unknown (or empty). */
  function display(p) {
    if (p == null) return p
    const s = String(p).trim(); if (!s) return p
    const r = map.get(projKey(s))
    return r ? r.name : s
  }
  /** The whole map for gossip, key-sorted so equal state serialises identically (gossip dedupe). Cached until it changes. */
  function list() {
    if (!listCache) listCache = [...map.keys()].sort().map(k => ({ ...map.get(k) }))
    return listCache
  }
  /** { projKey: name } — the lookup a dashboard needs for stores that hold a lower-cased or other spelling. */
  const names = () => { const o = {}; for (const [k, r] of map) o[k] = r.name; return o }
  /** Re-hydrate every host's durable copy at startup, so a restarted host keeps the spellings it knew. */
  async function rehydrate() {
    if (!persist || !persistence.projectNames) return
    try {
      let n = 0
      for (const recs of await persistence.projectNames.all()) if (Array.isArray(recs)) for (const r of recs) if (fold(r)) n++
      if (n) listCache = null
    } catch { }
  }
  return { merge, note, has, display, list, names, rehydrate, size: () => map.size }
}
