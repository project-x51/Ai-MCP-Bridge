// #88 (v2.0) build step 2a: the ID-KEYED MODEL's STRUCTURE and RESOLUTION (docs/spec-88.md §1 – §3, §5.1).
//
// Written BESIDE the 1.7x path model in lib/activity.js, which keeps serving the bridge (1.75 logic) until step 9 switches
// it; nothing imports this module yet except its tests (tests/unit/test_activity2_unit.mjs). It uses the step 1 identity
// primitives of lib/activity.js (mintId, validKey, slugKey, uniqueKey, normLabel, labelKey, parsePath2, parseRef,
// formatPath2) and #82's ranks (rankOf, rankBetween, derivedRank).
//
// WHAT IS HERE (2a):
// - A session holds its nodes KEYED BY ID (`nodes`), children by parent id (`kids`), the SCOPE index (creator id + lc(key)
//   → id; it holds GHOSTS' keys too, so a key names one node for good, §1.1), the SIBLING LABEL index (parent id +
//   labelKey(label) → id; live, non-merged nodes only, §1.6), the ALIAS table (labelKey(old display path) → id, §3.3) and
//   the GHOST table (removed nodes: id → { parent, key, creator, label, kind, removed_at … }, plus `gkids` by parent, §5.1).
// - applyCall(): target resolution (§3: --agent, --key, --id, --path, else the agent / the session root), references
//   (--under / --move / --merge, §3.2, with the `*_id` forms), the idempotent create (§3.5: location and label only at
//   creation, warning `exists`; `--label` equal to the `asked` label is no difference), ghost resurrection (§3.7: same id,
//   a new run), and the structural verbs: --move (+ --rename as one checked change), --rename, --merge, --unmerge,
//   --move-to (§3.8: create-if-missing, same-label ghost RESURRECTED, transient contexts, arrival last, the no-op retry,
//   Q45's bare-name refusal), --transient[=grace] (Q44) and --keep. Each structural change is a POINTER change that writes
//   ONE node record (move + rename: two records, one checked change).
// - The label rules (§1.6: label-required, AUTO-RENAME on create "x (2)" with `asked` + warning `relabelled`,
//   `duplicate-label` on a rename / move / merge / unmerge), the depth rules (Q11b: hard 32 → `depth`, naming the deepest
//   node; past 20 → warning `deep-tree`), and the refusals `cross-session`, `unknown-agent`, `not-an-agent`, `unknown-node`,
//   `bad-merge`, `bad-move`, `id-collision`.
// - Every call is ALL-OR-NOTHING: each mutation is journalled in a transaction and undone if any later check refuses.
// - Transient vanish (§3.8): when the last live child leaves a transient context it becomes a ghost (remove record
//   why:"transient"), bottom-up through emptied transient parents; with a grace period (Q44) it is only marked
//   `empty_since` and sweepTransients() (the owner's expiry pass) removes it later unless a child arrived meanwhile.
// - Alias lifetime (expireAliases) and ghost lifetime (pruneGhosts); capAt (the ~1 KB cap on an entry's `at`, Q11b) and
//   shortPath (the middle-cut display form).
//
// STUBS LEFT FOR LATER STEPS (said where they bite):
// - 2b (lines / plans / questions): there are no lines, no entries and no plans here. A node carries `current: null`; the
//   only question test (isOpenQuestion2: merge refuses a node holding an OPEN question) reads `current.question`, which 2b
//   fills. The ENTRIES a structural change also writes (§2.2: "moved by … from … to …", the transient vanish's "emptied —
//   removed from the board (transient)") are returned as `entries` STUBS { n, act, text } for 2b to turn into v6 entries.
//   `--item` (and `exists-elsewhere`) is 2b. A keep-on-own-line trigger is 2b's to call (keepNode).
// - 2c (actions / notices / positions): positions (--before / --after / --first / --last) are not parsed; a move / merge /
//   unmerge places the node LAST in its group (a stored rank after the last sibling). The dashboard clash answer
//   (`merges` / `label`), applyAction on ids, eviction and the per-session node limits are 2c.
// - Step 3 (records + replay): records are produced here (v:6, kind:"node") but not replayed; the session ROOT writes no
//   record (its id is mintId(session, "", "") — derivable). Step 6 rebuilds the ghost table at startup.
import { lc } from './keys.js'
import { DEPTH2, ACTIVITY_LIMITS, mintId, validKey, slugKey, uniqueKey, normLabel, labelKey, parsePath2, parseRef, formatPath2,
  parseDuration, sessionKey, rankOf, rankGroup, rankBetween, derivedRank } from './activity.js'

/** The v6 record format this model writes (spec §2). */
export const ACTIVITY2_FORMAT = 6
/** 2a's limits: depth (Q11b), the label length (§1.3), the `at` cap (Q11b), aliases per node (§3.3), the longest grace. */
export const LIMITS2 = Object.freeze({ depthMax: DEPTH2.max, depthWarn: DEPTH2.warn, label: ACTIVITY_LIMITS.context, atBytes: 1024, aliasesPerNode: 16, graceMaxMs: 24 * 3600000 })
const DAY = 86400000
const ID_RE = /^[a-z2-7]{16}$/

// ---------------------------------------------------------------------------------------------------------------
// small helpers
const cpLen = s => { let n = 0; for (const _ of s) n++; return n }
const cpSlice = (s, n) => Array.from(s).slice(0, n).join('')
/** @returns {any} */
const bad = (code, what, extra = {}) => ({ ok: false, code, what, ...extra })
const scopeKey = (creatorId, key) => creatorId + '\n' + lc(key)
const labelIx = (parentId, label) => parentId + '\n' + labelKey(label)
const brief = n => ({ id: n.id, key: n.key, label: n.label })
const has = (o, k) => o && o[k] !== undefined && o[k] !== null && o[k] !== false && o[k] !== ''

/**
 * A fresh 2.0 model: { v:6, origin, retentionMs, sessions: Map<sessionKey, Session2> }. `origin` is this host (every local
 * node's owner host, §1.2). `log_retention_days` (default 7) bounds alias lifetime (§3.3).
 * @param {{ origin?: string, config?: { log_retention_days?: number } }} [o]
 */
export function createModel({ origin = 'local', config = {} } = {}) {
  const days = Number(config && config.log_retention_days) > 0 ? Number(config.log_retention_days) : 7
  return { v: ACTIVITY2_FORMAT, origin: String(origin || 'local'), retentionMs: days * DAY, sessions: new Map() }
}

/**
 * A session of this host (created with its ROOT on first use when `now` is given). The root: kind "session", id =
 * mintId(session, "", ""), label = the session name, chain "" (it is the creator of the session's own keys).
 * @param {any} state @param {{ session: string, project?: string, user?: string, realm?: string }} ident @param {number} [now]
 */
export function getSession2(state, ident, now) {
  const i = ident && typeof ident === 'object' ? ident : /** @type {any} */ ({})
  const name = typeof i.session === 'string' ? i.session.trim() : ''
  if (!name) return null
  const id = { realm: (i.realm && String(i.realm).trim()) || 'default', project: i.project == null ? '' : String(i.project), user: i.user == null ? '' : String(i.user), session: name, host: state.origin }
  const key = sessionKey(id)
  let s = state.sessions.get(key)
  if (!s && Number.isFinite(now)) {
    const rootId = mintId(id, '', '')
    s = { key, ident: id, created_at: now, rootId, nodes: new Map(), kids: new Map(), scope: new Map(), labels: new Map(), aliases: new Map(), ghosts: new Map(), gkids: new Map() }
    s.nodes.set(rootId, newNode({ id: rootId, key: '', creator: null, chain: '', scope: '', kind: 'session', label: name, parent: null, now }))
    state.sessions.set(key, s)
  }
  return s || null
}
/** The session's root node. */
export const rootOf = sess => sess.nodes.get(sess.rootId)

function newNode({ id, key, creator, chain, scope, kind, label, parent, now, asked = null, transient = false, grace_ms = null, implicit = false, runs = 1 }) {
  return { id, key, creator, chain, scope, kind, label, asked, parent, rank: null, created_at: now, run_at: now, runs, last_activity: now,
    transient: !!transient, grace_ms: transient && grace_ms ? grace_ms : null, empty_since: null, merged_into: null, merged_from: null,
    implicit: !!implicit, plan: false, plan_ix: null, current: null }
}

// ---------------------------------------------------------------------------------------------------------------
// the tree: paths, depth, children

/** The labels root → node (the root itself has none: its path is ""). */
export function labelsOf(sess, node) {
  const out = []
  for (let n = node; n && n.parent != null; n = sess.nodes.get(n.parent)) out.unshift(n.label)
  return out
}
/** A node's display path NOW (§3.3: labels joined by "/", no "@", quoted where needed). */
export const pathOf = (sess, node) => formatPath2(labelsOf(sess, node))
/** Steps below the session root (a child of the root is depth 1, Q11b). */
export function depthOf(sess, node) { let d = 0; for (let n = node; n && n.parent != null; n = sess.nodes.get(n.parent)) d++; return d }
/** Every child id (merged ones included: a merged node is a HIDDEN child of the node it merged into, §3.6). */
const kidIds = (sess, id) => { const k = sess.kids.get(id); return k ? [...k] : [] }
/** The visible (live, non-merged) children, in sibling order (#82: group, then rank, then key). */
export function childrenOf2(sess, node) {
  return kidIds(sess, node.id).map(id => sess.nodes.get(id)).filter(n => n && !n.merged_into)
    .sort((a, b) => rankGroup(a) - rankGroup(b) || (rankOf(a) < rankOf(b) ? -1 : rankOf(a) > rankOf(b) ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
/** Is `node` at or below `anc`? */
function atOrUnder(sess, node, anc) { for (let n = node; n; n = n.parent != null ? sess.nodes.get(n.parent) : null) if (n.id === anc.id) return true; return false }
/** The deepest node of a subtree (hidden merged nodes count) and its depth. */
function deepestIn(sess, node) {
  let best = { node, depth: depthOf(sess, node) }
  const walk = (n, d) => { if (d > best.depth) best = { node: n, depth: d }; for (const id of kidIds(sess, n.id)) { const c = sess.nodes.get(id); if (c) walk(c, d + 1) } }
  walk(node, best.depth)
  return best
}
/** The nearest AGENT at or above a node, else the root (§1.4, §3.4: a path-created node's creator). */
function ownerOf2(sess, node) { let n = node; while (n && n.kind !== 'agent' && n.parent != null) n = sess.nodes.get(n.parent); return n && n.kind === 'agent' ? n : rootOf(sess) }
/** The child of `parent` a path SEGMENT names (§3.3 step 1): by label, else an agent (or a question, `?N`) by its key. */
function childBySeg(sess, parent, seg) {
  const id = sess.labels.get(labelIx(parent.id, seg))
  if (id) return sess.nodes.get(id)
  for (const c of childrenOf2(sess, parent)) if ((c.kind === 'agent' || c.key.startsWith('?')) && lc(c.key) === lc(seg)) return c
  return null
}
/**
 * A LOOKUP of a display path in the live tree only (no aliases, never creates): the node, or null. For views and tests.
 * @param {any} sess @param {string} path @returns {any}
 */
export function findPath(sess, path) {
  const p = parsePath2(path)
  if (!p.ok || !sess) return null
  let n = rootOf(sess)
  for (const seg of p.segs) { n = childBySeg(sess, n, seg); if (!n) return null }
  return n
}
/** 2b fills a node's line; until then nothing holds a question. */
export const isOpenQuestion2 = n => !!(n && n.current && n.current.question && n.current.question.status === 'asked')

/** A node as results name it (§4.2): { id, key, scope, label, path, kind } (+ transient / merged_into when set). */
export function nodeView(sess, n) {
  if (!n) return null
  return { id: n.id, key: n.key, scope: n.scope, label: n.label, path: pathOf(sess, n), kind: n.kind,
    ...(n.transient ? { transient: true, ...(n.grace_ms ? { grace_ms: n.grace_ms } : {}) } : {}), ...(n.merged_into ? { merged_into: n.merged_into } : {}) }
}
/** The visible tree below a node, for tests and debugging: { label, key, id, kids:[…] }. */
export function treeOf(sess, node = rootOf(sess)) {
  return { label: node.label, key: node.key, id: node.id, ...(node.transient ? { transient: true } : {}), kids: childrenOf2(sess, node).map(c => treeOf(sess, c)) }
}

// ---------------------------------------------------------------------------------------------------------------
// display forms (Q11b)

/**
 * Cap a stored path (an entry's `at`, Q08) at `max` UTF-8 bytes: a longer one keeps its head and its tail and is cut in the
 * MIDDLE with "…", on code-point boundaries, so the top of the tree and the node's own label both survive.
 * @param {string} path @param {number} [max] @returns {string}
 */
export function capAt(path, max = LIMITS2.atBytes) {
  const s = String(path == null ? '' : path)
  if (Buffer.byteLength(s, 'utf8') <= max) return s
  const cps = Array.from(s), budget = max - 3   // "…" is 3 bytes
  let head = '', hb = 0, i = 0, tail = '', tb = 0, j = cps.length - 1
  for (; i < cps.length; i++) { const b = Buffer.byteLength(cps[i], 'utf8'); if (hb + b > Math.floor(budget / 2)) break; head += cps[i]; hb += b }
  for (; j >= i; j--) { const b = Buffer.byteLength(cps[j], 'utf8'); if (hb + tb + b > budget) break; tail = cps[j] + tail; tb += b }
  return head + '…' + tail
}

/**
 * The DISPLAY form of a long path (Q11b): at most `max` code points, shortened in the MIDDLE by whole segments — the first
 * segment, "…", then as many trailing segments as fit (`Next release/…/Write the docs`). A path whose last segment alone is
 * too long is cut in the middle of the text. The full path goes on hover.
 * @param {string} path @param {number} [max] @returns {string}
 */
export function shortPath(path, max = 80) {
  const s = String(path == null ? '' : path)
  if (cpLen(s) <= max) return s
  const parsed = parsePath2(s), segs = parsed.ok ? parsed.segs : s.split('/')
  if (segs.length > 2) {
    const first = formatPath2([segs[0]])
    let tail = [], n = segs.length - 1
    while (n > 0 && cpLen(first + '/…/' + formatPath2([segs[n], ...tail])) <= max) tail = [segs[n--], ...tail]
    if (tail.length && n >= 1) return first + '/…/' + formatPath2(tail)
  }
  const keep = Math.max(2, max - 1), h = Math.ceil(keep / 2), cps = Array.from(s)
  return cps.slice(0, h).join('') + '…' + cps.slice(cps.length - (keep - h)).join('')
}

// ---------------------------------------------------------------------------------------------------------------
// transactions: every mutation is journalled, so a refused call is undone exactly (all-or-nothing, §3.8 / §1.6)

function newTx(state, sess, now, o = {}) {
  return { state, sess, now, by: o.by || null, act: o.act || null, undo: [], records: [], entries: [], warnings: [], deepest: 0 }
}
function mset(t, map, k, v) { const had = map.has(k), old = map.get(k); map.set(k, v); t.undo.push(() => { if (had) map.set(k, old); else map.delete(k) }) }
function mdel(t, map, k) { if (!map.has(k)) return; const old = map.get(k); map.delete(k); t.undo.push(() => map.set(k, old)) }
function sadd(t, map, k, v) {
  let s = map.get(k); const fresh = !s
  if (fresh) { s = new Set(); map.set(k, s) }
  if (s.has(v)) return
  s.add(v); t.undo.push(() => { s.delete(v); if (fresh && !s.size && map.get(k) === s) map.delete(k) })
}
function sdel(t, map, k, v) {
  const s = map.get(k); if (!s || !s.has(v)) return
  s.delete(v); const emptied = !s.size; if (emptied) map.delete(k)
  t.undo.push(() => { if (emptied) map.set(k, s); s.add(v) })
}
function fset(t, obj, f, v) { const old = obj[f]; if (old === v) return; obj[f] = v; t.undo.push(() => { obj[f] = old }) }
function rollback(t) { while (t.undo.length) t.undo.pop()() }

const identOf = sess => ({ realm: sess.ident.realm, session: sess.ident.session, project: sess.ident.project, user: sess.ident.user, host: sess.ident.host, origin: sess.ident.host, s0: sess.created_at })
/** One NODE RECORD (§2.1): { v:6, kind:"node", op, ts, n, …fields, …ident } (+ by / act when a dashboard did it). */
function record(t, op, n, fields = {}) {
  const r = { v: ACTIVITY2_FORMAT, kind: 'node', op, ts: t.now, n: n.id, ...fields, ...(t.by ? { by: t.by } : {}), ...(t.act ? { act: t.act } : {}), ...identOf(t.sess) }
  t.records.push(r)
  return r
}
/** An ENTRY STUB (2b turns it into a v6 entry: §2.2's "moved by …", the transient vanish's line). */
const entryStub = (t, n, act, text) => t.entries.push({ n: n.id, act, text })
const warn = (t, w) => t.warnings.push(w)
function noteDepth(t, d) { if (d > t.deepest) t.deepest = d }

// ---------------------------------------------------------------------------------------------------------------
// labels (§1.6)

/** The live sibling under `parentId` holding `label` (labelKey), other than `selfId`; else null. */
function clashAt(sess, parentId, label, selfId = null) {
  const id = sess.labels.get(labelIx(parentId, label))
  return id && id !== selfId ? sess.nodes.get(id) || null : null
}
/**
 * The first free label among `parentId`'s children (§1.6): `label` itself, else "<label> (2)", "(3)" … — the suffix counts
 * in the comparison, and a label that would pass 60 code points is cut BEFORE the suffix.
 * @returns {{ label: string, sibling: any }}
 */
export function freeLabel(sess, parentId, label, selfId = null) {
  const sibling = clashAt(sess, parentId, label, selfId)
  if (!sibling) return { label, sibling: null }
  for (let n = 2; ; n++) {
    const sfx = ` (${n})`, cand = cpSlice(label, LIMITS2.label - cpLen(sfx)).trimEnd() + sfx
    if (!clashAt(sess, parentId, cand, selfId)) return { label: cand, sibling }
  }
}
const dupLabel = (sess, parentId, label, sib, selfId, what) => bad('duplicate-label',
  `${what}: "${sib.label}" already has that label there (key ${sib.key}) — pick another label, e.g. "${freeLabel(sess, parentId, label, selfId).label}"`,
  { sibling: brief(sib), suggestion: freeLabel(sess, parentId, label, selfId).label })

// ---------------------------------------------------------------------------------------------------------------
// structural primitives (journalled)

/** Put a node into the live tree: nodes, kids, the label index (unless merged), the scope index; leaves the ghost table. */
function addLive(t, node) {
  const { sess } = t
  const g = sess.ghosts.get(node.id)
  if (g) { mdel(t, sess.ghosts, node.id); sdel(t, sess.gkids, g.parent, node.id) }
  mset(t, sess.nodes, node.id, node)
  if (node.parent != null) {
    sadd(t, sess.kids, node.parent, node.id)
    if (!node.merged_into) mset(t, sess.labels, labelIx(node.parent, node.label), node.id)
    arrived(t, node.parent)
  }
  if (node.creator != null) mset(t, sess.scope, scopeKey(node.creator, node.key), node.id)
}
/** Take a node out of its parent (kids + label index); it keeps its own subtree. */
function detach(t, node) {
  const { sess } = t
  if (node.parent == null) return
  sdel(t, sess.kids, node.parent, node.id)
  const ix = labelIx(node.parent, node.label)
  if (sess.labels.get(ix) === node.id) mdel(t, sess.labels, ix)
}
/** Hang a node under `parent` (visible unless merged); clears a transient parent's grace mark. */
function attach(t, node, parent) {
  const { sess } = t
  fset(t, node, 'parent', parent.id)
  sadd(t, sess.kids, parent.id, node.id)
  if (!node.merged_into) mset(t, sess.labels, labelIx(parent.id, node.label), node.id)
  arrived(t, parent.id)
}
/** The stored rank that puts a node LAST in its group under `parent` (§3.8 "arrival"; 2c adds positions). */
function lastRank(t, parent, node) {
  const g = rankGroup(node)
  let hi = null
  for (const c of childrenOf2(t.sess, parent)) if (c.id !== node.id && rankGroup(c) === g) { const r = rankOf(c); if (hi === null || r > hi) hi = r }
  return rankBetween(hi, derivedRank(t.now + 1, null))
}
/** Q11b after a structural change: the moved / created subtree must stay ≤ 32 deep (the deepest node named), past 20 warns. */
function checkDepth(t, node) {
  const d = deepestIn(t.sess, node)
  if (d.depth > LIMITS2.depthMax) return bad('depth', `that would put "${d.node.label}" (key ${d.node.key}) at depth ${d.depth}; the limit is ${LIMITS2.depthMax} below the session`, { node: brief(d.node), depth: d.depth })
  noteDepth(t, d.depth)
  return null
}

/**
 * CREATE a node (§2.1 `create`): mint its id (or re-use a GHOST's: a new run, §3.7), settle its label (AUTO-RENAME on a
 * sibling clash, `asked` + warning `relabelled`, §1.6), check the depth, write the record.
 * @returns {any} the node, or a refusal
 */
function createNode(t, { creator, key, kind, label, parent, transient = false, grace_ms = null, implicit = false, ghost = null }) {
  const { sess } = t
  // a GHOST comes back as itself: its id, key, kind and creator (the key's namespace — even if that agent is gone too)
  const cId = ghost ? ghost.creator : creator.id, cChain = ghost ? ghost.scope : creator.chain
  if (ghost) { key = ghost.key; kind = ghost.kind }
  const id = ghost ? ghost.id : mintId(sess.ident, cChain, key)
  const other = sess.nodes.get(id) || (!ghost && sess.ghosts.get(id))
  if (other && (other.creator !== cId || lc(other.key) !== lc(key))) return bad('id-collision', `the id ${id} minted for ${cChain}:${key} is already held by another node (${other.scope}:${other.key}) — nothing was merged; use another key`)
  if (other) return bad('exists', `${cChain}:${key} exists`)   // callers look the scope up first: a guard, never reached
  const d = depthOf(sess, parent) + 1
  if (d > LIMITS2.depthMax) return bad('depth', `that would put "${label}" (key ${key}) at depth ${d}; the limit is ${LIMITS2.depthMax} below the session`, { node: { id, key, label }, depth: d })
  noteDepth(t, d)
  const fl = freeLabel(sess, parent.id, label)
  const chain = kind === 'agent' ? (cChain ? cChain + '/' : '') + key : null
  const node = newNode({ id, key, creator: cId, chain, scope: cChain, kind, label: fl.label, parent: parent.id, now: t.now,
    asked: fl.sibling ? label : null, transient: kind === 'context' && transient, grace_ms, implicit, runs: ghost ? (ghost.runs || 1) + 1 : 1 })
  addLive(t, node)
  if (fl.sibling) warn(t, { code: 'relabelled', asked: label, got: fl.label, sibling: brief(fl.sibling), what: `"${label}" is taken under "${pathOf(sess, sess.nodes.get(parent.id)) || sess.ident.session}": created as "${fl.label}"` })
  record(t, 'create', node, { c: cId, key: node.key, nk: kind, label: node.label, p: parent.id, rank: null, run: true,
    ...(node.asked ? { asked: node.asked } : {}), ...(node.transient ? { transient: true, ...(node.grace_ms ? { grace_ms: node.grace_ms } : {}) } : {}) })
  return node
}

/** A transient context whose last live child just LEFT vanishes (or starts its grace period, Q44) — §3.8. */
function left(t, parentId) {
  const { sess } = t
  const p = sess.nodes.get(parentId)
  if (!p || p.kind !== 'context' || !p.transient || p.merged_into) return
  if (childrenOf2(sess, p).length) return
  if (p.grace_ms) { if (p.empty_since == null) fset(t, p, 'empty_since', t.now); return }
  removeNode(t, p, 'transient')
}
/** A child ARRIVED: a transient context in its grace period stays (Q44). */
function arrived(t, parentId) { const p = t.sess.nodes.get(parentId); if (p && p.empty_since != null) fset(t, p, 'empty_since', null) }

/** Drop the aliases that point at any of `ids` (§3.3 (b): its node was removed). */
function dropAliases(t, ids) { for (const [k, a] of [...t.sess.aliases]) if (ids.has(a.id)) mdel(t, t.sess.aliases, k) }
/** Record `path` (a node's display path BEFORE a change) as an alias of `id` (§3.3): newest wins; ≤ 16 per node, newest kept. */
function addAlias(t, path, id) {
  if (!path) return
  const { sess } = t
  mset(t, sess.aliases, labelKey(path), { id, path, at: t.now, used: t.now })
  const mine = [...sess.aliases].filter(([, a]) => a.id === id).sort((x, y) => x[1].used - y[1].used)
  for (let i = 0; i < mine.length - LIMITS2.aliasesPerNode; i++) mdel(t, sess.aliases, mine[i][0])
}

/**
 * REMOVE a node and its subtree (§2.1 `remove`, why: dismiss | evict | expire | transient): each node leaves memory into
 * the GHOST table (§5.1: its last parent, key, creator, label, kind, removed_at; keys stay held in the scope index), the
 * aliases to them are dropped, one record is written for the top node (+ the transient vanish's entry stub before it), and
 * a transient parent that emptied vanishes in turn.
 */
export function removeNode(t, node, why) {
  const { sess } = t
  if (!node || node.parent == null) return
  const was = pathOf(sess, node), parentId = node.parent
  if (why === 'transient') entryStub(t, node, 'transient', 'emptied — removed from the board (transient)')
  const ids = new Set(), stack = [node]
  while (stack.length) { const n = stack.pop(); ids.add(n.id); for (const id of kidIds(sess, n.id)) { const c = sess.nodes.get(id); if (c) stack.push(c) } }
  detach(t, node)
  for (const id of ids) {
    const n = sess.nodes.get(id)
    if (id !== node.id && !n.merged_into) { const ix = labelIx(n.parent, n.label); if (sess.labels.get(ix) === id) mdel(t, sess.labels, ix) }
    mdel(t, sess.kids, id)
    mdel(t, sess.nodes, id)
    mset(t, sess.ghosts, id, { id, key: n.key, creator: n.creator, chain: n.chain, scope: n.scope, kind: n.kind, label: n.label, parent: n.parent,
      removed_at: t.now, last_ts: t.now, why: id === node.id ? why : 'parent', transient: n.transient, grace_ms: n.grace_ms, runs: n.runs })
    sadd(t, sess.gkids, n.parent, id)
  }
  dropAliases(t, ids)
  record(t, 'remove', node, { why, was })
  left(t, parentId)
}

/** Make a transient context PERMANENT (§3.8: --keep, a rename, its own line (2b), a pin (step 8)) — one `keep` record. */
export function keepNode(t, node) {
  if (!node || !node.transient) return false
  fset(t, node, 'transient', false); fset(t, node, 'grace_ms', null); fset(t, node, 'empty_since', null)
  record(t, 'keep', node)
  return true
}

/** RENAME (§1.6: a clash → duplicate-label, nothing written): one `label` record; the old path becomes an alias. */
function renameNode(t, node, label) {
  const { sess } = t
  if (node.parent == null) return bad('bad-rename', 'the session root is labelled by its session name')
  if (node.merged_into) return bad('bad-rename', `"${node.label}" is merged — unmerge it first`)
  if (label === node.label) return null
  const sib = clashAt(sess, node.parent, label, node.id)
  if (sib) return dupLabel(sess, node.parent, label, sib, node.id, `can't rename "${node.label}" to "${label}"`)
  const was = pathOf(sess, node), old = node.label
  const ix = labelIx(node.parent, node.label)
  if (sess.labels.get(ix) === node.id) mdel(t, sess.labels, ix)
  fset(t, node, 'label', label)
  mset(t, sess.labels, labelIx(node.parent, label), node.id)
  record(t, 'label', node, { label, was })
  addAlias(t, was, node.id)
  entryStub(t, node, 'rename', `renamed from "${old}" to "${label}"`)
  keepNode(t, node)
  return null
}

/**
 * MOVE under `dest` (§1.6, §3.8 arrival): the root can't move, never under itself, a merged node can't move, same session
 * (callers resolve `dest` in the session: `cross-session` is raised there), the label (or `rename`, one checked change)
 * must be free at the destination, the whole subtree must stay ≤ 32 deep. Already there → a no-op (no record; a rename
 * still applies). Arrives LAST in its group. One `move` record (+ a `label` record with a rename); the old path is an alias;
 * a transient old parent that emptied vanishes.
 * @returns {any} { moved } | { noop:true } | a refusal
 */
function moveNode(t, node, dest, rename = null) {
  const { sess } = t
  if (node.parent == null) return bad('bad-move', 'the session root cannot move')
  if (node.merged_into) return bad('bad-move', `"${node.label}" is merged — unmerge it first`)
  if (atOrUnder(sess, dest, node)) return bad('bad-move', `can't move "${node.label}" under itself`)
  if (dest.merged_into) return bad('bad-move', `"${dest.label}" is merged into another node`)
  const label = rename != null ? rename : node.label
  if (node.parent === dest.id) {
    if (rename != null) { const e = renameNode(t, node, rename); if (e) return e }
    return { noop: true }
  }
  const sib = clashAt(sess, dest.id, label, node.id)
  if (sib) return dupLabel(sess, dest.id, label, sib, node.id, `can't move "${node.label}" under "${pathOf(sess, dest) || sess.ident.session}"${rename != null ? ` as "${label}"` : ''}`)
  const was = pathOf(sess, node), from = node.parent, relabel = label !== node.label
  detach(t, node)
  if (relabel) fset(t, node, 'label', label)   // before attach: the label index must take the NEW label
  attach(t, node, dest)
  const rank = lastRank(t, dest, node)
  fset(t, node, 'rank', rank)
  const e = checkDepth(t, node); if (e) return e
  record(t, 'move', node, { p: dest.id, rank, was })
  if (relabel) { record(t, 'label', node, { label, was }); keepNode(t, node) }
  addAlias(t, was, node.id)
  entryStub(t, node, 'move', `moved from ${was} to ${pathOf(sess, node)}`)
  left(t, from)
  return { moved: { from: was, to: pathOf(sess, node), parent_id: dest.id } }
}

/**
 * MERGE A into B (§3.6): contexts / plan items only, same session; refused `bad-merge` for A = B, B under A, an agent, the
 * root, A holding an OPEN question; `duplicate-label` listing EVERY clash of A's children with B's. A's children move under
 * B (last in their groups), A becomes a HIDDEN child of B (`merged_into`, `merged_from` = its parent then). One `merge`
 * record (kids listed, no move records); A's path becomes an alias (resolution redirects A to B).
 */
function mergeNode(t, a, b) {
  const { sess } = t
  if (a.id === b.id) return bad('bad-merge', "can't merge a node into itself")
  if (a.parent == null || b.parent == null) return bad('bad-merge', "the session root can't be merged (or merged into)")
  if (a.kind !== 'context' || b.kind !== 'context') return bad('bad-merge', `only contexts merge: "${(a.kind !== 'context' ? a : b).label}" is an agent (a key namespace)`)
  if (a.merged_into) return bad('bad-merge', `"${a.label}" is already merged`)
  if (atOrUnder(sess, b, a)) return bad('bad-merge', `can't merge "${a.label}" into its own descendant "${b.label}"`)
  if (isOpenQuestion2(a)) return bad('bad-merge', `"${a.label}" holds an open question — answer or withdraw it first`)
  const kids = childrenOf2(sess, a)
  const clashes = []
  for (const k of kids) { const s = clashAt(sess, b.id, k.label); if (s) clashes.push({ label: k.label, key: k.key, id: k.id, sibling: brief(s), suggestion: freeLabel(sess, b.id, k.label).label }) }
  if (clashes.length) return bad('duplicate-label', `can't merge "${a.label}" into "${b.label}": ${clashes.map(c => `"${c.label}" is already there (suggest "${c.suggestion}")`).join('; ')}`, { clashes })
  const was = pathOf(sess, a), from = a.parent
  for (const k of kids) {
    detach(t, k); attach(t, k, b)
    fset(t, k, 'rank', lastRank(t, b, k))
    const e = checkDepth(t, k); if (e) return e
  }
  detach(t, a)
  fset(t, a, 'merged_into', b.id); fset(t, a, 'merged_from', from)
  attach(t, a, b)
  const e = checkDepth(t, a); if (e) return e
  record(t, 'merge', a, { into: b.id, from, was, kids: kids.map(k => k.id) })
  addAlias(t, was, a.id)
  entryStub(t, a, 'merge', `merged into ${pathOf(sess, b)}`)
  left(t, from)
  return { merged: { into_id: b.id, path: pathOf(sess, b), kids: kids.map(k => k.id) } }
}

/**
 * UNMERGE (§3.6): A goes back under its pre-merge parent as a plain context (its children stay with B). Refused
 * `duplicate-label` when the old parent has gained a child with A's label (`label` names A anew), `bad-unmerge` when A is
 * not merged or its old parent is gone. One `unmerge` record (+ a `label` record when relabelled).
 */
function unmergeNode(t, a, label = null) {
  const { sess } = t
  if (!a.merged_into) return bad('bad-unmerge', `"${a.label}" is not merged`)
  const from = sess.nodes.get(a.merged_from)
  if (!from) return bad('bad-unmerge', `"${a.label}"'s old parent is no longer on the board — it stays merged`)
  const want = label != null ? label : a.label
  const sib = clashAt(sess, from.id, want, a.id)
  if (sib) return dupLabel(sess, from.id, want, sib, a.id, `can't unmerge "${a.label}" back under "${pathOf(sess, from) || sess.ident.session}"${label != null ? ` as "${want}"` : ''}`)
  const relabel = want !== a.label
  detach(t, a)
  fset(t, a, 'merged_into', null); fset(t, a, 'merged_from', null)
  if (relabel) fset(t, a, 'label', want)
  attach(t, a, from)
  const rank = lastRank(t, from, a)
  fset(t, a, 'rank', rank)
  const e = checkDepth(t, a); if (e) return e
  record(t, 'unmerge', a, { p: from.id, rank })
  if (relabel) record(t, 'label', a, { label: want })
  entryStub(t, a, 'unmerge', `unmerged back to ${pathOf(sess, a)}`)
  return { unmerged: { parent_id: from.id, path: pathOf(sess, a) } }
}

// ---------------------------------------------------------------------------------------------------------------
// resolution (§3)

/** A merged node resolves to the node it merged into (§3.6, §3.2), with warning `merged`. */
function redirect(t, node) {
  let n = node, hops = 0
  while (n && n.merged_into && hops++ < 64) n = t.sess.nodes.get(n.merged_into)
  if (n !== node) warn(t, { code: 'merged', what: `"${node.label}" was merged into ${pathOf(t.sess, n)}`, from: node.id, to: n.id })
  return n
}
/** A node by id: this session's (live); another session's → cross-session; a ghost / nothing → unknown-node. */
function byId(t, id, what) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return bad('bad-ref', `${what} must be a node id (16 chars of a-z 2-7)`)
  const n = t.sess.nodes.get(id)
  if (n) return { node: n }
  for (const s of t.state.sessions.values()) if (s !== t.sess && s.nodes.has(id)) return bad('cross-session', `${what} ${id} belongs to another session (${s.ident.session}): moves stay within a session`)
  return bad('unknown-node', `${what} ${id} is not on the board${t.sess.ghosts.has(id) ? ' (it was removed)' : ''}`)
}
/** Walk the creator chain from the root (each step a LIVE agent). */
function creatorByChain(t, creators) {
  let c = rootOf(t.sess)
  for (const k of creators) {
    const id = t.sess.scope.get(scopeKey(c.id, k)), n = id && t.sess.nodes.get(id)
    if (!n || n.kind !== 'agent') return null
    c = n
  }
  return c
}
/**
 * Resolve a REFERENCE (§3.2) — never creates: `chain:key` (exactly that scope), a bare key (the call's scope, then its
 * creator's … up to the session's), a path (§3.3 from the scope node: live tree, then aliases), or an id (`*_id`).
 * A merged node resolves to its target.
 */
function resolveRef(t, raw, rawId, scopeNode, what) {
  const { sess } = t
  let r
  if (rawId != null) r = byId(t, rawId, what)
  else {
    const p = parseRef(raw)
    if (!p.ok) return p
    if (p.kind === 'chain') {
      const c = creatorByChain(t, p.creators)
      const id = c && sess.scope.get(scopeKey(c.id, p.key)), n = id && sess.nodes.get(id)
      r = n ? { node: n } : bad('unknown-node', `${what} "${raw}" names no node on the board`)
    } else if (p.kind === 'key') {
      let n = null
      for (let s = scopeNode; s && !n; s = s.creator != null ? sess.nodes.get(s.creator) : null) { const id = sess.scope.get(scopeKey(s.id, p.key)); n = (id && sess.nodes.get(id)) || null }
      r = n ? { node: n } : bad('unknown-node', `${what} "${raw}": no node has that key in your scope or above`)
    } else {
      const w = walkPath(t, scopeNode, p.segs, false)
      r = w.ok === false ? bad('unknown-node', `${what} "${raw}" names no node on the board`) : w
    }
  }
  if (r.ok === false) return r
  return { node: redirect(t, r.node) }
}

/**
 * Walk a PATH (§3.3) from `base`: (1) the live tree, segment by segment (label, else an agent / question by key); (2) the
 * ALIAS table — the longest alias that is a prefix of the full path and covers more than the live tree matched (the live
 * tree always wins), with warning `alias`; the rest resolves below it; (3) with `create`, the missing tail is CREATED as
 * contexts (intermediates implicit), creator = the OWNER (§3.4), key = slug (-2 … on a clash, live or ghost), label = the
 * segment — or, where a GHOST under that parent has the segment's label, that ghost is RESURRECTED (a new run, §3.7).
 * @returns {any} { node, created:boolean } or a refusal
 */
function walkPath(t, base, segs, create, o = {}) {
  const { sess } = t
  let n = base, i = 0
  for (; i < segs.length; i++) { const c = childBySeg(sess, n, segs[i]); if (!c) break; n = c }
  if (i < segs.length) {
    const baseLabels = labelsOf(sess, base), full = [...baseLabels, ...segs]
    for (let j = full.length; j > baseLabels.length + i; j--) {
      const k = labelKey(formatPath2(full.slice(0, j))), a = sess.aliases.get(k), hit = a && sess.nodes.get(a.id)
      if (!hit) continue
      fset(t, a, 'used', t.now)
      const to = redirect(t, hit)
      warn(t, { code: 'alias', what: `${formatPath2(full.slice(0, j))} is now ${pathOf(sess, to)}`, was: formatPath2(full.slice(0, j)), now: pathOf(sess, to), id: to.id })
      n = to; i = j - baseLabels.length
      for (; i < segs.length; i++) { const c = childBySeg(sess, n, segs[i]); if (!c) break; n = c }
      break
    }
  }
  if (i === segs.length) return { node: n, created: false }
  if (!create) return bad('unknown-node', `no node at ${formatPath2(segs)}`)
  for (; i < segs.length; i++) {
    const last = i === segs.length - 1
    const ghost = ghostUnder(sess, n, segs[i])
    const c = ghost
      ? createNode(t, { ghost, creator: null, key: null, kind: null, label: segs[i], parent: n, implicit: !last, transient: last && !!o.transient, grace_ms: o.grace_ms })
      : createNode(t, { creator: ownerOf2(sess, n), key: freeKey(sess, ownerOf2(sess, n), segs[i]), kind: 'context', label: segs[i], parent: n, implicit: !last, transient: last && !!o.transient, grace_ms: o.grace_ms })
    if (c.ok === false) return c
    n = c
  }
  return { node: n, created: true }
}
/** The first of slug(label), -2, -3 … that NO node in `creator`'s scope holds, live or ghost (§3.3, §3.8). */
const freeKey = (sess, creator, label) => uniqueKey(slugKey(label), k => sess.scope.has(scopeKey(creator.id, k)))
/** The newest GHOST whose last parent is `parent` and whose label matches (labelKey) — §3.8 step 2. */
function ghostUnder(sess, parent, label) {
  const ids = sess.gkids.get(parent.id)
  if (!ids) return null
  let best = null
  for (const id of ids) { const g = sess.ghosts.get(id); if (g && labelKey(g.label) === labelKey(label) && (!best || g.removed_at > best.removed_at)) best = g }
  return best
}

/**
 * Parse a `--move-to` path (§3.8, Q45): `/…` = absolute from the session root; otherwise it must START with `..` segments
 * (relative to the node's current parent, each going up one level) followed by EXACTLY as many label segments, so a
 * retry lands in the same place (`../X`, `../../R/X`). A bare `X` — and `../A/B`, `../../X`, `..` alone — is refused
 * `bad-path`, suggesting `../X` and the absolute form. A label that is literally `..` is written quoted (`".."`).
 * @param {any} raw @returns {any} { ok:true, abs, up, segs } or { ok:false, code, what }
 */
export function parseMoveTo(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return bad('bad-path', 'move_to must be a path: "../X" (beside the node\'s parent) or "/A/X" (from the session root)')
  let s = raw.trim()
  if (s.startsWith('/')) {
    const p = parsePath2(s)
    if (!p.ok) return p
    if (!p.segs.length) return bad('bad-path', 'move_to "/" names the session root: give the destination, e.g. "/Later"')
    return { ok: true, abs: true, up: 0, segs: p.segs }
  }
  let up = 0, m
  while ((m = /^\.\.[ ]*(?:\/[ ]*|$)/.exec(s))) { up++; s = s.slice(m[0].length) }
  const p = parsePath2(s)
  if (!p.ok) return p
  const dest = p.segs.length ? formatPath2(p.segs) : null
  if (!up) return bad('bad-path', `move_to "${raw.trim()}" is a bare name — not allowed (a retry would move the node again, one level down): use "../${dest}" (beside the node's parent) or "/…/${dest}" (from the session root)`)
  if (!p.segs.length) return bad('bad-path', `move_to "${raw.trim()}" has no destination after the ".." — name it, e.g. "../Done", or give an absolute path "/…"`)
  if (p.segs.length !== up) return bad('bad-path', `move_to "${raw.trim()}" is not retry-safe (${up} ".." but ${p.segs.length} segment${p.segs.length > 1 ? 's' : ''} after them: a retry would resolve from the new parent and land elsewhere) — use as many ".." as segments ("../X", "../../R/X"), or the absolute form "/…"`)
  return { ok: true, abs: false, up, segs: p.segs }
}

/**
 * `--move-to` (§3.8): resolve the destination from the node's current parent (or the root), segment by segment — a LIVE
 * child (label, else agent key) → a same-label GHOST of that parent RESURRECTED (same id / key / creator, a new run,
 * transient) → a NEW transient context (creator = the CALLER, key unused in its scope, live or ghost) — then move the node
 * there (last; the --move refusals). Already there → no move (and nothing created): a retry is a no-op.
 */
function moveToPath(t, node, mt, caller, grace_ms) {
  const { sess } = t
  if (node.parent == null) return bad('bad-move', 'the session root cannot move')
  let base = mt.abs ? rootOf(sess) : sess.nodes.get(node.parent)
  for (let k = 0; k < mt.up; k++) {
    if (base.parent == null) return bad('bad-path', `move_to goes above the session root (${mt.up} ".." from ${pathOf(sess, node)})`)
    base = sess.nodes.get(base.parent)
  }
  let n = base, i = 0
  for (; i < mt.segs.length; i++) { const c = childBySeg(sess, n, mt.segs[i]); if (!c) break; n = c }
  if (i === mt.segs.length && n.id === node.parent) return { noop: true }
  if (i === mt.segs.length && atOrUnder(sess, n, node)) return bad('bad-move', `can't move "${node.label}" under itself`)
  for (; i < mt.segs.length; i++) {
    if (atOrUnder(sess, n, node)) return bad('bad-move', `can't move "${node.label}" under itself`)
    const ghost = ghostUnder(sess, n, mt.segs[i])
    const c = ghost
      ? createNode(t, { ghost, creator: null, key: null, kind: null, label: mt.segs[i], parent: n, transient: true, grace_ms })
      : createNode(t, { creator: caller, key: freeKey(sess, caller, mt.segs[i]), kind: 'context', label: mt.segs[i], parent: n, transient: true, grace_ms })
    if (c.ok === false) return c
    if (ghost && !c.transient) { fset(t, c, 'transient', true); fset(t, c, 'grace_ms', grace_ms || null) }
    n = c
  }
  return moveNode(t, node, n)
}

// ---------------------------------------------------------------------------------------------------------------
// the call

const CALL_FIELDS = ['agent', 'key', 'id', 'path', 'under', 'under_id', 'label', 'move', 'move_id', 'move_to', 'rename', 'merge', 'merge_id', 'unmerge', 'transient', 'keep']

/**
 * Validate a call's STRUCTURAL fields (the 2.0 `log` tool's names, §4.2). Line / plan / position fields are ignored here
 * (2b / 2c). `transient`: true, or a grace duration ("30s" — the `--transient=30s` form, Q44).
 * @returns {any} { ok:true, q } or a refusal
 */
export function parseCall(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('bad-input', 'expected an object { agent?, key? | id? | path?, label?, under?, move? | move_to?, rename?, merge?, unmerge?, transient?, keep? }')
  const q = /** @type {any} */ ({})
  if (has(input, 'agent')) {
    if (typeof input.agent !== 'string') return bad('bad-agent', 'agent must be a key chain like "spec-88" or "spec-88/research"')
    const steps = input.agent.trim().replace(/^\/+|\/+$/g, '').split('/').map(s => validKey(s))
    const badStep = steps.find(s => !s.ok)
    if (badStep) return bad('bad-agent', `agent "${input.agent}": ${badStep.what}`)
    q.agent = steps.map(s => s.key)
  }
  const addr = ['key', 'id', 'path'].filter(k => has(input, k))
  if (addr.length > 1) return bad('bad-address', `give one of --key / --id / --path, not ${addr.join(' + ')}`)
  if (has(input, 'key')) { const k = validKey(input.key, { question: true }); if (!k.ok) return k; q.key = k.key }
  if (has(input, 'id')) { if (typeof input.id !== 'string' || !ID_RE.test(input.id)) return bad('bad-id', 'id must be a node id (16 chars of a-z 2-7)'); q.id = input.id }
  if (has(input, 'path')) { const p = parsePath2(input.path); if (!p.ok) return p; q.segs = p.segs }
  if (q.segs && (has(input, 'under') || has(input, 'under_id'))) return bad('bad-address', '--under places a NEW --key / --agent node; a --path names its own place')
  for (const f of ['label', 'rename']) if (has(input, f)) { const l = normLabel(input[f]); if (!l.ok) return bad(l.code, `${f}: ${l.what}`); q[f] = l.label }
  for (const f of ['under', 'move', 'merge']) {
    if (has(input, f) && has(input, f + '_id')) return bad('bad-input', `give ${f} or ${f}_id, not both`)
    if (has(input, f)) { if (typeof input[f] !== 'string') return bad('bad-ref', `${f} must be a reference: a key, chain:key or a path`); q[f] = input[f] }
    if (has(input, f + '_id')) q[f + '_id'] = input[f + '_id']
  }
  if (has(input, 'move_to')) { const m = parseMoveTo(input.move_to); if (!m.ok) return m; q.move_to = m }
  q.unmerge = input.unmerge === true
  q.keep = input.keep === true
  if (has(input, 'transient')) {
    if (input.transient === true) q.transient = { grace_ms: null }
    else if (typeof input.transient === 'string') {
      const ms = parseDuration(input.transient)
      if (!Number.isFinite(ms) || ms <= 0 || ms > LIMITS2.graceMaxMs || /^\s*[\d.]+\s*$/.test(input.transient)) return bad('bad-input', `transient "${input.transient}": give a grace period like "30s", "2m" (≤ 24h), or true for none`)
      q.transient = { grace_ms: ms }
    } else return bad('bad-input', 'transient must be true or a grace period like "30s"')
  }
  const verbs = ['move', 'move_to', 'merge', 'unmerge'].filter(v => v === 'move' ? q.move != null || q.move_id != null : v === 'merge' ? q.merge != null || q.merge_id != null : v === 'unmerge' ? q.unmerge : !!q.move_to)
  if (verbs.length > 1) return bad('bad-input', `one structural change per call: ${verbs.join(' + ')} (--move-to with --move: one destination per call)`)
  if (q.rename != null && (q.merge != null || q.merge_id != null || q.unmerge || q.move_to)) return bad('bad-input', '--rename goes alone or with --move (one checked change)')
  if (q.keep && q.transient) return bad('bad-input', '--keep with --transient: pick one')
  return { ok: true, q }
}

/**
 * Resolve the agent chain (§1.5): each step a LIVE agent in its creator's scope. The LAST step, when missing, is CREATED —
 * only by a call that TARGETS the agent (no key / id / path), with its label (`label-required`; under `under` or its
 * creator; a ghost agent comes back as a new run). A missing earlier step, or a missing agent on a call aimed elsewhere →
 * `unknown-agent`; a step that names a context → `not-an-agent`.
 */
function resolveAgent(t, steps, q, targetsAgent) {
  const { sess } = t
  let creator = rootOf(sess), created = false
  for (let i = 0; i < steps.length; i++) {
    const chain = steps.slice(0, i + 1).join('/')
    const id = sess.scope.get(scopeKey(creator.id, steps[i])), live = id && sess.nodes.get(id), ghost = id && !live ? sess.ghosts.get(id) : null
    if (live) { if (live.kind !== 'agent') return bad('not-an-agent', `--agent ${chain}: "${steps[i]}" is a context (${pathOf(sess, live)}), not an agent`); creator = live; continue }
    if (ghost && ghost.kind !== 'agent') return bad('not-an-agent', `--agent ${chain}: "${steps[i]}" was a context, not an agent`)
    if (i < steps.length - 1 || !targetsAgent) return bad('unknown-agent', `--agent ${chain} is not on the board — start it first: --agent ${chain} --label "…" --guide agent`)
    if (!q.label && !ghost) return bad('label-required', `creating the agent ${chain} needs its name: --label "…" (a label never defaults to the key)`)
    let parent = creator
    if (q.under != null || q.under_id != null) { const r = resolveRef(t, q.under, q.under_id, creator, 'under'); if (r.ok === false) return r; parent = r.node }
    if (q.transient) return bad('bad-input', 'only a context can be transient, not an agent')
    const n = ghost ? createNode(t, { ghost, creator, key: steps[i], kind: 'agent', label: q.label || ghost.label, parent })
      : createNode(t, { creator, key: steps[i], kind: 'agent', label: q.label, parent })
    if (n.ok === false) return n
    creator = n; created = true
  }
  return { agent: creator, created }
}

/** `exists` (§3.5): a create's location / label / transient flag given for a node that already exists is ignored. */
function existsCheck(t, node, q, scopeNode) {
  const ignored = []
  if (q.label != null && labelKey(q.label) !== labelKey(node.label) && !(node.asked && labelKey(q.label) === labelKey(node.asked))) ignored.push('label')
  if (q.under != null || q.under_id != null) {
    const r = resolveRef(t, q.under, q.under_id, scopeNode, 'under')
    if (r.ok === false || r.node.id !== node.parent) ignored.push('under')
  }
  if (q.transient && !q.move_to) ignored.push('transient')
  if (ignored.length) warn(t, { code: 'exists', ignored, what: `${node.scope}:${node.key} exists — ${ignored.map(f => '--' + f).join(', ')} ignored (location and label are set only at creation; use --move / --rename)` })
}

/**
 * Apply one call's STRUCTURE (2a): resolve the session, the agent (§1.5) and the TARGET (§3: key → id → path → the agent →
 * the session root), creating what the rules create, then the structural verb (--move [+ --rename], --rename, --move-to,
 * --merge, --unmerge, --keep). ALL-OR-NOTHING: a refusal undoes every change of the call and writes no record.
 * @param {any} state  createModel()
 * @param {{ session: string, project?: string, user?: string, realm?: string }} ident  the reporting session
 * @param {any} input  parseCall()'s input (the 2.0 `log` tool's structural fields)
 * @param {number} now
 * @param {{ by?: any, act?: string }} [opts]  by / act (6d) on the records when a dashboard did it
 * @returns {any} { ok:true, node, created, agent?, records, entries, warnings, moved?, merged?, unmerged? } or a refusal
 */
export function applyCall(state, ident, input, now, opts = {}) {
  if (!state || !(state.sessions instanceof Map)) return bad('bad-state-object', 'pass a createModel() state')
  if (!Number.isFinite(now)) return bad('bad-now', 'now must be a ms epoch')
  const pc = parseCall(input)
  if (!pc.ok) return pc
  const q = pc.q
  const fresh = !getSession2(state, ident)
  const sess = getSession2(state, ident, now)
  if (!sess) return bad('bad-session', 'the reporting session needs a name')
  const t = newTx(state, sess, now, opts)
  const r = run(t, q)
  if (r.ok === false) { rollback(t); if (fresh) state.sessions.delete(sess.key); return r }
  if (t.deepest > LIMITS2.depthWarn) warn(t, { code: 'deep-tree', depth: t.deepest, what: `the tree is ${t.deepest} deep here (over ${LIMITS2.depthWarn}; the limit is ${LIMITS2.depthMax})` })
  return { ok: true, ...r, records: t.records, entries: t.entries, warnings: t.warnings }
}

function run(t, q) {
  const { sess } = t
  let scopeNode = rootOf(sess), agentCreated = false
  const targetsAgent = q.key == null && q.id == null && !q.segs
  if (q.agent) {
    const a = resolveAgent(t, q.agent, q, targetsAgent)
    if (a.ok === false) return a
    scopeNode = a.agent; agentCreated = a.created
  }
  let node, created = false
  const grace = q.transient ? q.transient.grace_ms : null
  if (q.key != null) {
    const id = sess.scope.get(scopeKey(scopeNode.id, q.key)), live = id && sess.nodes.get(id), ghost = id && !live ? sess.ghosts.get(id) : null
    if (live) { node = q.unmerge ? live : redirect(t, live); if (!q.unmerge) existsCheck(t, live, q, scopeNode) }   // existsCheck ignores --transient with --move-to (it is for the destinations)
    else {
      if (q.key.startsWith('?')) return bad('unknown-node', `no question ${q.key} in your scope (question keys are made by the bridge)`)
      if (!q.label && !ghost) return bad('label-required', `creating ${scopeNode.chain}:${q.key} needs a label: --label "…" (a label never defaults to the key)`)
      let parent = scopeNode
      if (q.under != null || q.under_id != null) { const r = resolveRef(t, q.under, q.under_id, scopeNode, 'under'); if (r.ok === false) return r; parent = r.node }
      if (q.transient && ghost && ghost.kind !== 'context') return bad('bad-input', 'only a context can be transient, not an agent')
      const n = createNode(t, ghost ? { ghost, creator: scopeNode, key: q.key, kind: 'context', label: q.label || ghost.label, parent, transient: !!q.transient, grace_ms: grace }
        : { creator: scopeNode, key: q.key, kind: 'context', label: q.label, parent, transient: !!q.transient, grace_ms: grace })
      if (n.ok === false) return n
      node = n; created = true
    }
  } else if (q.id != null) {
    const r = byId(t, q.id, 'id')
    if (r.ok === false) return r
    node = q.unmerge ? r.node : redirect(t, r.node)
    if (!q.unmerge) existsCheck(t, r.node, q, scopeNode)
  } else if (q.segs) {
    const w = walkPath(t, scopeNode, q.segs, true, { transient: !!q.transient, grace_ms: grace })
    if (w.ok === false) return w
    node = q.unmerge ? w.node : redirect(t, w.node); created = w.created
    if (!created && q.transient) existsCheck(t, node, { transient: q.transient, move_to: q.move_to }, scopeNode)
  } else {
    node = scopeNode; created = agentCreated
    if (q.agent && !agentCreated) existsCheck(t, node, q, sess.nodes.get(node.creator) || rootOf(sess))
    else if (!q.agent && q.transient && !q.move_to) return bad('bad-input', '--transient needs a node the call creates (--key, --path, or with --move-to)')
  }
  const out = /** @type {any} */ ({ node: null, created })
  const hasMove = q.move != null || q.move_id != null
  if (hasMove) {
    const d = resolveRef(t, q.move, q.move_id, scopeNode, 'move')
    if (d.ok === false) return d
    const m = moveNode(t, node, d.node, q.rename != null ? q.rename : null)
    if (m.ok === false) return m
    if (m.moved) out.moved = m.moved
  } else if (q.rename != null) {
    const e = renameNode(t, node, q.rename); if (e) return e
  } else if (q.move_to) {
    const m = moveToPath(t, node, q.move_to, scopeNode, grace)
    if (m.ok === false) return m
    if (m.moved) out.moved = m.moved
  } else if (q.merge != null || q.merge_id != null) {
    const d = resolveRef(t, q.merge, q.merge_id, scopeNode, 'merge')
    if (d.ok === false) return d
    const m = mergeNode(t, node, d.node)
    if (m.ok === false) return m
    out.merged = m.merged
  } else if (q.unmerge) {
    const m = unmergeNode(t, node, q.label != null ? q.label : null)
    if (m.ok === false) return m
    out.unmerged = m.unmerged
  }
  if (q.keep) { if (node.kind !== 'context') return bad('bad-input', '--keep applies to a transient context'); keepNode(t, node) }
  out.node = nodeView(sess, node)
  if (q.agent) out.agent = nodeView(sess, scopeNode)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// passes (the owner's expiry pass; retention)

/**
 * The grace pass (Q44): every transient context EMPTY for at least its grace period vanishes (entry stub + `remove`
 * why:"transient"); an emptied transient parent then starts ITS grace (or vanishes at once without one). Returns the
 * records / entry stubs written. Run it with the owner's expiry pass (and the replay re-runs it, step 3).
 * @param {any} state @param {number} now
 */
export function sweepTransients(state, now) {
  const records = [], entries = []
  for (const sess of state.sessions.values()) {
    const due = [...sess.nodes.values()].filter(n => n.transient && n.empty_since != null && n.grace_ms && now - n.empty_since >= n.grace_ms)
    for (const n of due) {
      if (!sess.nodes.has(n.id) || n.empty_since == null || childrenOf2(sess, n).length) continue
      const t = newTx(state, sess, now)
      removeNode(t, n, 'transient')
      records.push(...t.records); entries.push(...t.entries)
    }
  }
  return { records, entries }
}

/**
 * Alias lifetime (§3.3 (c)): an alias expires `log_retention_days` after it was made or last used; one whose node is gone
 * (removed: no longer live) is dropped too. Returns how many were dropped.
 * @param {any} state @param {number} now
 */
export function expireAliases(state, now) {
  let n = 0
  for (const sess of state.sessions.values()) for (const [k, a] of [...sess.aliases]) if (now - a.used > state.retentionMs || !sess.nodes.has(a.id)) { sess.aliases.delete(k); n++ }
  return n
}

/**
 * Ghost lifetime (§5.1): a ghost lives until retention drops its last entry — and while a ghost BELOW it still lives (a
 * ghost chain links a removed grandchild to its live ancestor). `retainFrom` = the oldest retained ms. A ghost that
 * leaves the table frees its key (the scope index entry). 2a's stand-in for "its last entry" is `last_ts` (the removal;
 * step 6 reads the index files). Returns the ids dropped.
 * @param {any} state @param {number} retainFrom
 */
export function pruneGhosts(state, retainFrom) {
  const dropped = []
  for (const sess of state.sessions.values()) {
    const memo = new Map()
    const keep = id => {
      if (memo.has(id)) return memo.get(id)
      memo.set(id, true)   // a cycle guard (never expected)
      const g = sess.ghosts.get(id)
      let k = !!g && g.last_ts >= retainFrom
      for (const c of sess.gkids.get(id) || []) if (keep(c)) k = true
      memo.set(id, k)
      return k
    }
    for (const id of [...sess.ghosts.keys()]) {
      if (keep(id)) continue
      const g = sess.ghosts.get(id)
      sess.ghosts.delete(id)
      const s = sess.gkids.get(g.parent); if (s) { s.delete(id); if (!s.size) sess.gkids.delete(g.parent) }
      if (g.creator != null && sess.scope.get(scopeKey(g.creator, g.key)) === id) sess.scope.delete(scopeKey(g.creator, g.key))
      dropped.push(id)
    }
  }
  return dropped
}

/**
 * Remove a node from the board (dismiss / evict / expire — the callers are 2c's actions and the expiry pass): a
 * transaction of its own, returning the records and entry stubs. The session root can't be removed.
 * @param {any} state @param {any} sess @param {string} id @param {string} why @param {number} now
 */
export function removeById(state, sess, id, why, now) {
  const n = sess.nodes.get(id)
  if (!n) return bad('unknown-node', `${id} is not on the board`)
  if (n.parent == null) return bad('bad-remove', 'the session root cannot be removed')
  const t = newTx(state, sess, now)
  removeNode(t, n, why)
  return { ok: true, records: t.records, entries: t.entries }
}
