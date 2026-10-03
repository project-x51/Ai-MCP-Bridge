// #88 (v2.0) build step 7: GOSSIP v6 — 2.0 gateways sharing their activity boards across hosts (docs/spec-88.md §6).
//
// THE STAGING (spec §8 step 7 "as built"): the bridge uses this module only with the pre-cutover switch
// AI_BRIDGE_ACTIVITY_V2=1 (as step 6's store); without it the 1.7x gossip v5 (lib/activity.js planSlice / applySlice)
// serves as before, until step 9 switches the bridge for good. bridge.mjs keeps the links, timers and frames; this module
// is the pure part, so the unit tests drive it without sockets.
//
// THE v6 SLICE (§6.1): one UNIT per NODE, keyed by its ID — `id`, `p` (the parent id; none for the session root, which
// carries `root:true`), `c` (the creator id), `key`, `scope`, `label`, `nk` (agent | context | session) and `type`, plus
// the node's own state as v5 sent it (the current line WITHOUT details / data — has_details / has_data flags instead —,
// progress, eta_at, rank (a stored one only), plan_item / plan_ix, log_n, plan_end, finished_at, …) and what 2.0 added
// (transient + grace_ms, the kept test-result `test`, the TIME `timing`). NO PATH: a rename or a move changes ONE unit,
// never its descendants'. Merged (hidden) nodes are not sent. A session record = its header (ident, times, `root_id`,
// `ghosts` = its ghost count) + `nodes:[units]`. Deltas, epochs, the byte cap, newest-active first and the 1 frame/s rule
// are v5's (planSlice2 / applySlice2); a removal is `{ …session, id }` = that node AND its subtree (the sender lists only
// the topmost of what it removes, and forgets the published subtree, so a node that moved out of it is sent again in full).
//
// THE RECEIVER holds each remote host's sessions as MODEL-SHAPED sessions (nodes by id, kids by parent id, the root) built
// from the units, so the 2.0 view functions (bar2, displayOf2, effectiveState2 …) and the store's board rows work on them
// unchanged. Per-origin ownership as v5: a slice REPLACES only its link's host (never our own), a delta applies only on
// top of the held (epoch, seq), a host that goes down (link lost, ACTIVITY_DOWN) shows its agents GONE until its next
// full slice, and a host down longer than finished_visible_hours leaves the board (expireRemote2).
import { lc, projKey } from './keys.js'
import { sessionKey, normLabel, normQuestion, normBy, parseProgress, validRank, ACTIVITY_LIMITS, ACTIVITY_STATES } from './activity.js'
import * as A2 from './activity2.js'
import { nodeRow2 } from './activity2-store.js'

/** The format number 2.0 announces (`activity_gossip:6`, §6.2) and every v6 slice carries (`v`). */
export const GOSSIP2_FORMAT = A2.ACTIVITY2_FORMAT
/** A bound on a junk / huge gossiped slice (as v5: a sane host never gets near it). */
export const MAX_SESSIONS_PER_ORIGIN = 1024
const ID_RE = /^[a-z2-7]{16}$/
const LIVE = new Set(['running', 'blocked'])
const bad = (code, what, extra = {}) => ({ ok: false, code, what, ...extra })
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const utf8 = s => Buffer.byteLength(s, 'utf8')
/** A plain JSON object (no undefined / null / false fields) — equal state serialises identically. */
function compact(o) { const r = {}; for (const k of Object.keys(o)) { const v = o[k]; if (v !== null && v !== undefined && v !== false) r[k] = v } return r }

// ---------------------------------------------------------------------------------------------------------------
// the SENDER: units, the per-link published view, the next frame

/** A line on the wire: never details / data (has_* flags), its writer (#83) and its question (#85). */
function snapLine2(l) {
  return l ? compact({ id: l.id, ts: l.ts, text: l.text, state: l.state, has_details: !!(l.details || l.has_details), has_data: !!(l.data != null || l.has_data),
    by: l.by && typeof l.by === 'object' ? { kind: 'dashboard', user: l.by.user, host: l.by.host } : null, question: l.question ? JSON.parse(JSON.stringify(l.question)) : null }) : null
}
const hasTiming = n => n.started_at != null || n.first_started_at != null || !!n.attempts
/**
 * A node's v6 UNIT (§6.1): its identity + structure by id and its OWN fields (never children, rollup, log, details / data).
 * @param {any} sess @param {any} n
 */
export function snapNode2(sess, n) {
  const root = n.parent == null
  return compact({ id: n.id, ...(root ? { root: true } : { p: n.parent }), c: n.creator || null, key: n.key || null, scope: n.scope || null, label: n.label, nk: n.kind, type: n.type,
    created_at: n.created_at, run_at: n.run_at !== n.created_at ? n.run_at : null, runs: n.runs > 1 ? n.runs : null, last_activity: n.last_activity,
    finished_at: n.finished_at, gone_at: n.kind !== 'context' ? n.gone_at : null, stale_after_ms: n.stale_after_ms, implicit: n.implicit,
    progress: n.progress ? { done: n.progress.done, total: n.progress.total, unit: n.progress.unit, ...(n.progress.skipped > 0 ? { skipped: n.progress.skipped } : {}) } : null,
    eta_at: n.eta_at, current: snapLine2(n.current), plan_item: !!n.plan, plan_ix: n.plan && Number.isInteger(n.plan_ix) ? n.plan_ix : null,
    log_n: (n.log.length + (n.log_dropped || 0)) || null, plan_end: n.plan_end ? { state: n.plan_end.state, ts: n.plan_end.ts } : null, rank: validRank(n.rank),
    transient: !!n.transient, grace_ms: n.transient && n.grace_ms ? n.grace_ms : null, test: n.test ? { ...n.test } : null,
    timing: hasTiming(n) ? compact({ started_at: n.started_at, ended_at: n.ended_at, first_started_at: n.first_started_at, took: n.took, took_total: n.took_total || null, attempts: n.attempts || null }) : null })
}
const sessHeader2 = s => compact({ session: s.ident.session, project: s.ident.project, user: s.ident.user, realm: s.ident.realm, created_at: s.created_at, last_activity: s.last_activity,
  gone_at: s.gone_at || null, bell: !!s.bell, root_id: s.rootId, ghosts: s.ghosts.size || null })
/**
 * This host's gossip UNITS: one per visible-or-hidden-but-not-merged NODE, keyed `[sessionKey, id]`, with its canonical
 * JSON and last_activity, plus each session's header. Compute once per change and reuse for every link (planSlice2's
 * opts.units). @param {any} state the 2.0 model (lib/activity2.js createModel)
 * @returns {{ sessions: Map<string, any>, ents: Map<string, any> }}
 */
export function gossipUnits2(state) {
  const sessions = new Map(), ents = new Map()
  for (const s of state.sessions.values()) {
    const hdr = sessHeader2(s)
    sessions.set(s.key, { sk: s.key, hdr, hj: JSON.stringify(hdr), id: { realm: s.ident.realm, project: s.ident.project, user: s.ident.user, session: s.ident.session }, last: s.last_activity })
    for (const n of s.nodes.values()) {
      if (n.merged_into) continue   // §6.1: merged nodes are not sent (a merged node is a hidden child of the node it merged into)
      const ent = snapNode2(s, n), uk = JSON.stringify([s.key, n.id])
      ents.set(uk, { uk, sk: s.key, id: n.id, p: n.parent, ent, json: JSON.stringify(ent), last: n.last_activity })
    }
  }
  return { sessions, ents }
}
/** A link's published view — what it was last sent: hdrs sk -> { hj, id }, ents uk -> { uk, sk, id, p, json }. */
export const createPub2 = () => ({ hdrs: new Map(), ents: new Map() })
/**
 * The next frame body for ONE link: a FULL slice (`full:true`) or a DELTA against the link's `pub` — the changed / new units
 * (each inside its session record: the header + `nodes:[…]`) and `remove:[{realm, project, user, session[, id]}]` (no id =
 * the whole session; an id = that node AND its subtree on the receiver). Of the nodes gone since the last frame only the
 * TOPMOST is listed (its subtree goes with it), and the link FORGETS the whole published subtree of each — so a node that
 * moved out of a removed subtree (a merge's children) is sent again in full and the receiver never keeps a stale copy.
 * Units go NEWEST-ACTIVE FIRST until `maxBytes` of JSON; the first always goes; what didn't fit stays unpublished, so the
 * NEXT frame carries it (`truncated:true` / pending:true). Returns { body:null } when a delta has nothing to say.
 * @param {any} state @param {{ hdrs: Map<string, any>, ents: Map<string, any> }} pub
 * @param {{ full?: boolean, maxBytes?: number, units?: { sessions: Map<string, any>, ents: Map<string, any> } }} [opts]
 * @returns {{ body: any, pending: boolean, entities: number, bytes: number }}
 */
export function planSlice2(state, pub, opts = {}) {
  const u = opts.units || gossipUnits2(state), full = !!opts.full
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : Infinity
  if (full) { pub.hdrs.clear(); pub.ents.clear() }
  const remove = []
  if (!full) {
    const goneS = new Set()
    for (const [sk, h] of pub.hdrs) if (!u.sessions.has(sk)) { remove.push({ ...h.id }); pub.hdrs.delete(sk); goneS.add(sk) }
    const removed = []
    for (const [uk, e] of pub.ents) { if (goneS.has(e.sk)) { pub.ents.delete(uk); continue } if (!u.ents.has(uk)) removed.push(e) }
    if (removed.length) {
      const kidsOf = new Map()   // the PUBLISHED tree (what the receiver holds): sk \n parent id -> [entries]
      for (const e of pub.ents.values()) if (e.p != null) { const k = e.sk + '\n' + e.p; let a = kidsOf.get(k); if (!a) kidsOf.set(k, a = []); a.push(e) }
      const gone = new Set(removed.map(e => e.sk + '\n' + e.id))
      for (const e of removed.sort((a, b) => cmp(a.uk, b.uk))) if (!(e.p != null && gone.has(e.sk + '\n' + e.p))) remove.push({ ...pub.hdrs.get(e.sk).id, id: e.id })
      const stack = [...removed]
      while (stack.length) { const e = stack.pop(); if (!pub.ents.delete(e.uk)) continue; for (const c of kidsOf.get(e.sk + '\n' + e.id) || []) stack.push(c) }
    }
  }
  const cand = [], withEnt = new Set()
  for (const x of u.ents.values()) { const p = pub.ents.get(x.uk); if (!p || p.json !== x.json) { cand.push(x); withEnt.add(x.sk) } }
  for (const s of u.sessions.values()) { const p = pub.hdrs.get(s.sk); if ((!p || p.hj !== s.hj) && !withEnt.has(s.sk)) cand.push({ sk: s.sk, uk: JSON.stringify([s.sk]), hdrOnly: true, last: s.last }) }
  cand.sort((a, b) => b.last - a.last || cmp(a.uk, b.uk))
  const out = new Map()
  let bytes = 64 + (remove.length ? utf8(JSON.stringify(remove)) : 0), n = 0, pending = false
  for (const c of cand) {
    const s = u.sessions.get(c.sk), rec = out.get(c.sk)
    const add = (rec ? 0 : utf8(s.hj) + 16) + (c.hdrOnly ? 0 : utf8(c.json) + 2)
    if ((n || out.size) && bytes + add > maxBytes) { pending = true; break }
    let r = rec
    if (!r) { r = { ...s.hdr }; out.set(c.sk, r); pub.hdrs.set(c.sk, { hj: s.hj, id: s.id }) }
    if (!c.hdrOnly) { (r.nodes || (r.nodes = [])).push(c.ent); pub.ents.set(c.uk, { uk: c.uk, sk: c.sk, id: c.id, p: c.p, json: c.json }); n++ }
    bytes += add
  }
  if (!full && !out.size && !remove.length) return { body: null, pending: false, entities: 0, bytes: 0 }
  const body = /** @type {any} */ (full ? { v: GOSSIP2_FORMAT, full: true, sessions: [...out.values()] } : { v: GOSSIP2_FORMAT, sessions: [...out.values()], ...(remove.length ? { remove } : {}) })
  if (pending) body.truncated = true
  return { body, pending, entities: n, bytes }
}

// ---------------------------------------------------------------------------------------------------------------
// the RECEIVER: other hosts' boards, per origin (wire → model-shaped sessions; everything re-validated)

/** The holder of every other host's board: { origin (this host), hosts: Map<host, { sessions, epoch, seq, down_at, truncated }> }. */
export function createRemote2({ origin = 'local' } = {}) { return { origin: String(origin), hosts: new Map() } }

const wTime = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null }
const wPos = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null }
const wInt = (v, max = 1e9) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null)
const wStr = (v, max) => (typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : null)
// eslint-disable-next-line no-control-regex
const normText = s => s.replace(/\s*[\r\n\t\f\v]+\s*/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim()
function wText(v) {
  if (typeof v !== 'string') return null
  const t = normText(v), cps = Array.from(t)
  return !t ? null : cps.length > ACTIVITY_LIMITS.text ? cps.slice(0, ACTIVITY_LIMITS.text - 1).join('') + '…' : t
}
function wLine2(l, kind) {
  if (!l || typeof l !== 'object') return null
  const text = wText(l.text)
  if (!text) return null
  const by = l.by && typeof l.by === 'object' ? normBy({ ...l.by, kind: 'dashboard' }) : null
  const question = kind === 'context' ? normQuestion(l.question) : null
  return { id: typeof l.id === 'string' ? l.id.slice(0, 100) : '', ts: wTime(l.ts) || 0, text, state: ACTIVITY_STATES.includes(l.state) ? l.state : 'running',
    details: null, data: null, has_details: !!l.has_details, has_data: !!l.has_data, ...(by && typeof by === 'object' ? { by } : {}), ...(question ? { question } : {}) }
}
function wTest(t) {
  if (!t || typeof t !== 'object' || !['pass', 'fail', 'skip'].includes(t.result)) return null
  return compact({ result: t.result, checks: wInt(t.checks), failed: wInt(t.failed), duration: wInt(t.duration, 1e12), ts: wTime(t.ts), entry: typeof t.entry === 'string' ? t.entry.slice(0, 100) : null,
    state: ACTIVITY_STATES.includes(t.state) ? t.state : null })
}
const NK = new Set(['agent', 'context', 'session'])
/** A node from the wire (a validated unit → a model-shaped node), or null. */
function wNode2(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null
  const root = r.root === true
  if (!root && (typeof r.p !== 'string' || !ID_RE.test(r.p) || r.p === r.id)) return null
  const kind = root ? 'session' : NK.has(r.nk) && r.nk !== 'session' ? r.nk : null
  if (!kind) return null
  const lb = normLabel(typeof r.label === 'string' ? r.label : '')
  if (!lb.ok) return null
  const T = A2.NODE_TYPES[r.type]
  const type = T && T.kind === kind ? r.type : kind === 'context' ? 'context' : kind
  const created = wTime(r.created_at) || 0
  const n = /** @type {any} */ ({ id: r.id, key: wStr(r.key, 64) || '', creator: typeof r.c === 'string' && ID_RE.test(r.c) ? r.c : null, chain: wStr(r.scope, 1024) || '', scope: wStr(r.scope, 1024) || '',
    kind, type, label: lb.label, asked: null, parent: root ? null : r.p, rank: kind === 'session' ? null : validRank(r.rank), created_at: created, run_at: wTime(r.run_at) || created,
    runs: wPos(r.runs) || 1, last_activity: wTime(r.last_activity) || 0, transient: kind === 'context' && r.transient === true, grace_ms: null, empty_since: null, merged_into: null, merged_from: null,
    implicit: r.implicit === true, plan: false, plan_ix: null, current: wLine2(r.current, kind), progress: null, eta_at: wPos(r.eta_at),
    stale_after_ms: wPos(r.stale_after_ms) ? Math.min(wPos(r.stale_after_ms), ACTIVITY_LIMITS.staleAfterMaxMs) : null,
    finished_at: kind !== 'context' ? wPos(r.finished_at) : null, gone_at: kind !== 'context' ? wPos(r.gone_at) : null,
    plan_end: kind !== 'context' && r.plan_end && typeof r.plan_end === 'object' && ['done', 'abandoned'].includes(r.plan_end.state) ? { state: r.plan_end.state, ts: wTime(r.plan_end.ts) || 0 } : null,
    log: [], log_dropped: wInt(r.log_n) || 0, cp_dirty: false, cp_sig: null, test: kind === 'context' ? wTest(r.test) : null,
    started_at: null, ended_at: null, first_started_at: null, took: null, took_total: 0, attempts: 0, remote: true })
  if (n.transient && wPos(r.grace_ms)) n.grace_ms = Math.min(wPos(r.grace_ms), A2.LIMITS2.graceMaxMs)
  const pr = r.progress ? parseProgress(r.progress) : null
  n.progress = pr && pr.ok && type !== 'group' && type !== 'question' ? pr.value : null
  if (kind === 'context' && r.plan_item === true) { n.plan = true; n.plan_ix = Number.isInteger(r.plan_ix) && r.plan_ix >= 0 && r.plan_ix <= ACTIVITY_LIMITS.nodesPerSession ? r.plan_ix : null }
  if (r.timing && typeof r.timing === 'object') {
    const t = r.timing
    n.started_at = wTime(t.started_at); n.ended_at = wTime(t.ended_at); n.first_started_at = wTime(t.first_started_at); n.took = wTime(t.took); n.took_total = wTime(t.took_total) || 0; n.attempts = wInt(t.attempts, 1e6) || 0
  }
  return n
}
// a session's identity from the wire (a session record, or a removal); host = the ORIGIN (the link's host — never a field of the record)
function wIdent2(r, origin) {
  if (!r || typeof r !== 'object') return null
  const session = str(r.session)
  if (!session) return null
  const ident = { realm: str(r.realm) || 'default', project: str(r.project) || 'unclassified', user: str(r.user) || '', session, host: origin }
  return { key: sessionKey(ident), ident }
}
// a session record's header from the wire
function wHeader2(r, origin) {
  const w = wIdent2(r, origin)
  if (!w || typeof r.root_id !== 'string' || !ID_RE.test(r.root_id)) return null   // a 2.0 session record always names its root's id
  const ident = w.ident
  return { key: sessionKey(ident), ident, created_at: wTime(r.created_at) || 0, last_activity: wTime(r.last_activity) || 0, gone_at: wPos(r.gone_at), bell: r.bell === true,
    root_id: typeof r.root_id === 'string' && ID_RE.test(r.root_id) ? r.root_id : null, ghosts_n: wInt(r.ghosts, 1e7) || 0 }
}
/** A fresh remote session (model-shaped: nodes by id, kids by parent id, no ghosts / scope / labels — those stay with the owner). */
function newRemoteSession(h) {
  return { key: h.key, ident: h.ident, created_at: h.created_at, last_activity: h.last_activity, gone_at: h.gone_at, bell: h.bell, ghosts_n: h.ghosts_n, rootId: h.root_id,
    nodes: new Map(), kids: new Map(), scope: new Map(), labels: new Map(), aliases: new Map(), ghosts: new Map(), gkids: new Map(), nAgents: 0, remote: true }
}
const kidSet = (s, id) => { let k = s.kids.get(id); if (!k) s.kids.set(id, k = new Set()); return k }
function detach2(s, n) { if (n.parent == null) return; const k = s.kids.get(n.parent); if (k) { k.delete(n.id); if (!k.size) s.kids.delete(n.parent) } }
/** Would `parentId` put `id` under itself (a cycle)? Walks the held parents (bounded). */
function cycles(s, id, parentId) {
  let x = parentId
  for (let i = 0; x != null && i <= A2.LIMITS2.depthMax + 8; i++) { if (x === id) return true; const p = s.nodes.get(x); x = p ? p.parent : null }
  return x === id
}
/** Put a wire node into a remote session (REPLACING the one held at its id); false when refused (limits, a cycle, a second root). */
function wPut2(s, n) {
  const old = s.nodes.get(n.id)
  if (n.kind === 'session') { if (n.id !== s.rootId) return false }   // one root per session: the header's root_id
  else {
    if (n.id === s.rootId) return false
    if (cycles(s, n.id, n.parent)) return false
    if (!old) {
      if (s.nodes.size - 1 >= ACTIVITY_LIMITS.nodesPerSession) return false
      if (n.kind === 'agent' && s.nAgents >= ACTIVITY_LIMITS.agentsPerSession) return false
    }
  }
  if (old) { detach2(s, old); if (old.kind === 'agent') s.nAgents-- }
  s.nodes.set(n.id, n)
  if (n.kind === 'agent') s.nAgents++
  if (n.parent != null) kidSet(s, n.parent).add(n.id)
  return true
}
/** Remove a node and its held subtree (by the kids index). Returns how many nodes went. */
function wRemove2(s, id) {
  if (id === s.rootId) return 0
  const n0 = s.nodes.get(id)
  if (!n0) return 0
  detach2(s, n0)
  let gone = 0
  const stack = [id]
  while (stack.length) {
    const x = stack.pop(), n = s.nodes.get(x)
    if (n) { s.nodes.delete(x); gone++; if (n.kind === 'agent') s.nAgents-- }
    for (const c of s.kids.get(x) || []) stack.push(c)
    s.kids.delete(x)
  }
  return gone
}
/** The session's ROOT: the root unit when held, else a placeholder (implicit, labelled with the session's name) so its
 * held units hang somewhere until the root unit arrives (a truncated frame). */
function ensureRoot(s) {
  if (s.nodes.has(s.rootId)) return
  const id = s.rootId
  s.nodes.set(id,/** @type {any} */ ({ id, key: '', creator: null, chain: '', scope: '', kind: 'session', type: 'session', label: s.ident.session, asked: null, parent: null, rank: null, created_at: s.created_at,
    run_at: s.created_at, runs: 1, last_activity: s.last_activity, transient: false, grace_ms: null, empty_since: null, merged_into: null, merged_from: null, implicit: true, plan: false, plan_ix: null,
    current: null, progress: null, eta_at: null, stale_after_ms: null, finished_at: null, gone_at: s.gone_at, plan_end: null, log: [], log_dropped: 0, cp_dirty: false, cp_sig: null, test: null,
    started_at: null, ended_at: null, first_started_at: null, took: null, took_total: 0, attempts: 0, remote: true, placeholder: true }))
}
function wSession2(r, origin) {
  const h = wHeader2(r, origin)
  if (!h) return null
  const s = newRemoteSession(h)
  const units = (Array.isArray(r.nodes) ? r.nodes : []).map(wNode2).filter(Boolean)
  for (const n of units) if (n.kind === 'session') wPut2(s, n)   // the root first, then the rest (in any order: kids by parent id)
  for (const n of units) if (n.kind !== 'session' && !s.nodes.has(n.id)) wPut2(s, n)
  ensureRoot(s)
  return s
}
function setHeader(s, h) { s.created_at = h.created_at; s.last_activity = h.last_activity; s.gone_at = h.gone_at; s.bell = h.bell; s.ghosts_n = h.ghosts_n }
const badVersion2 = v => bad('bad-version', `activity slice format v${v == null ? '?' : v}; this bridge speaks v${GOSSIP2_FORMAT} (a 2.0 bridge shares activity only with 2.0 bridges — docs/spec-88.md §6.2)`)
/**
 * Fold one wire frame body from `fromOrigin` (the LINK's host). A body whose `v` isn't 6 → 'bad-version' (never misread).
 * A FULL body REPLACES everything held for that origin (and clears a down mark) and records its (epoch, seq). A DELTA
 * applies only on top of exactly the held position — else 'out-of-sync' (ask for a full one). Removals first (a node
 * removal takes its held subtree; no id = the whole session), then each session record: a new session is created, an
 * existing one gets its header and each listed unit REPLACED (a new one beyond the limits, a cycle or a second root is
 * dropped). Everything is re-validated; our own origin is refused.
 * @param {any} remote createRemote2() @param {string} fromOrigin @param {any} body
 * @returns {any} { ok:true, changed, full, sessions } or { ok:false, code, what }
 */
export function applySlice2(remote, fromOrigin, body) {
  const origin = typeof fromOrigin === 'string' ? fromOrigin.trim() : ''
  if (!origin) return bad('bad-origin', 'applySlice2 needs the owning origin')
  if (lc(origin) === lc(remote.origin)) return bad('own-origin', 'a remote slice may not touch this host\'s own nodes')
  if (!body || typeof body !== 'object' || (body.sessions != null && !Array.isArray(body.sessions)) || (body.remove != null && !Array.isArray(body.remove))) return bad('bad-slice', 'expected { v:6, full?, epoch, seq, base?, sessions:[…], remove?:[…] }')
  if (body.v !== GOSSIP2_FORMAT) return badVersion2(body.v)
  const epoch = body.epoch != null ? String(body.epoch) : null, seq = Number.isFinite(Number(body.seq)) ? Number(body.seq) : 0
  if (body.full) {
    const sessions = new Map()
    for (const r of body.sessions || []) {
      if (sessions.size >= MAX_SESSIONS_PER_ORIGIN) break
      const s = wSession2(r, origin)
      if (s && !sessions.has(s.key)) sessions.set(s.key, s)
    }
    remote.hosts.set(origin, { sessions, epoch, seq, down_at: null, truncated: !!body.truncated })
    return { ok: true, changed: true, full: true, sessions: sessions.size }
  }
  const held = remote.hosts.get(origin)
  if (!held || held.down_at || held.epoch !== epoch || held.seq !== Number(body.base)) return bad('out-of-sync', 'this delta does not follow the held slice — ask for a full one')
  let changed = false
  const gone = new Map()   // step 8: node id -> its session key, for the ids this delta REMOVED (the view state's pruning)
  for (const r of body.remove || []) {
    const h = wIdent2(r, origin)
    if (!h) continue
    const s = held.sessions.get(h.key)
    if (!s) continue
    if (r.id == null) { for (const id of s.nodes.keys()) gone.set(id, null); held.sessions.delete(h.key); changed = true; continue }
    if (typeof r.id !== 'string') continue
    const before = new Set(s.nodes.keys())
    if (wRemove2(s, r.id)) { changed = true; for (const id of before) if (!s.nodes.has(id)) gone.set(id, h.key) }
  }
  for (const r of body.sessions || []) {
    const h = wHeader2(r, origin)
    if (!h) continue
    const s = held.sessions.get(h.key)
    if (!s) {
      if (held.sessions.size >= MAX_SESSIONS_PER_ORIGIN) continue
      const ns = wSession2(r, origin)
      if (ns) { held.sessions.set(h.key, ns); changed = true }
      continue
    }
    setHeader(s, h)
    const units = (Array.isArray(r.nodes) ? r.nodes : []).map(wNode2).filter(Boolean)
    for (const n of units) if (n.kind === 'session') wPut2(s, n)
    for (const n of units) if (n.kind !== 'session') wPut2(s, n)
    ensureRoot(s)
    changed = true
  }
  held.seq = seq
  held.truncated = !!body.truncated
  // the removed ids that did not come back in the same frame (a merge's children are removed with it, then re-sent)
  const left = [...gone].filter(([id, sk]) => !(sk != null && held.sessions.get(sk) && held.sessions.get(sk).nodes.has(id))).map(([id]) => id)
  return { ok: true, changed, full: false, sessions: held.sessions.size, ...(left.length ? { left } : {}) }
}
/**
 * The origin went DOWN or became unreachable (its link dropped, a retired / expired peer, its ACTIVITY_DOWN notice): every
 * session and AGENT of its slice not already gone is marked gone at `now` (a context shows its owner's). Kept until a
 * fresh full slice replaces it (which clears the marks) or expireRemote2 drops it. → whether a slice was held.
 */
export function markOriginDown2(remote, origin, now) {
  const sl = remote.hosts.get(origin)
  if (!sl) return false
  if (sl.down_at) return true
  const at = Number.isFinite(now) ? now : Date.now()
  sl.down_at = at
  for (const s of sl.sessions.values()) {
    if (!s.gone_at) s.gone_at = at
    for (const n of s.nodes.values()) if (n.kind !== 'context' && !n.gone_at) n.gone_at = at
  }
  return true
}
/** Drop the slices of hosts DOWN for at least `windowMs` (finished_visible_hours). → the hosts dropped. */
export function expireRemote2(remote, now, windowMs) {
  const out = []
  for (const [o, sl] of [...remote.hosts]) if (sl.down_at && now - sl.down_at >= Math.max(0, Number(windowMs) || 0)) { remote.hosts.delete(o); out.push(o) }
  return out
}
/** One line per remote host held: { host, sessions, nodes, seq, down_at?, truncated? } (sorted by host). */
export function remoteInfo2(remote) {
  return [...remote.hosts.keys()].sort(cmp).map(o => { const sl = remote.hosts.get(o); let nodes = 0; for (const s of sl.sessions.values()) nodes += s.nodes.size; return compact({ host: o, sessions: sl.sessions.size, nodes, seq: sl.seq || 0, down_at: sl.down_at || null, truncated: !!sl.truncated }) })
}
/** The host name as held (case-insensitive), or null. */
export function knownHost2(remote, h) { const k = lc(String(h || '')); for (const o of remote.hosts.keys()) if (lc(o) === k) return o; return null }

// ---------------------------------------------------------------------------------------------------------------
// reads over the held boards

const ownerOf = (s, n) => { let x = n, guard = 0; while (x && x.kind === 'context' && x.parent != null && guard++ < 64) x = s.nodes.get(x.parent); return x || null }
/** A held session's board rows (store.board's shape + host / remote), depth first in sibling order from the root; a node
 * of a host that went DOWN shows `gone` (an agent / the session, and a context's live line through its owner). */
function remoteRows(s, now, staleMin) {
  const memo = new Map(), nodes = []
  const seen = new Set()
  const walk = (n, depth) => {
    if (seen.has(n.id) || depth > A2.LIMITS2.depthMax + 1) return
    seen.add(n.id)
    const row = nodeRow2(s, n, depth, now, memo, staleMin)
    const o = n.kind === 'context' ? ownerOf(s, n) : n
    const st = row.stale ? row.was : row.state
    if (!n.plan && LIVE.has(st) && o && (o.gone_at || s.gone_at) && !o.finished_at) { row.state = 'gone'; row.was = st; delete row.stale }
    nodes.push(row)
    for (const c of A2.childrenOf2(s, n)) walk(c, depth + 1)
  }
  const root = s.nodes.get(s.rootId)
  if (root) walk(root, 0)
  return nodes
}
const matches = (s, q) => !(str(q.session) && lc(q.session) !== lc(s.ident.session)) && !(str(q.project) && projKey(q.project) !== projKey(s.ident.project)) && !(str(q.user) && lc(q.user) !== lc(s.ident.user))
/**
 * Every held remote session (filtered by q.session / project / user / host) as board rows: { session, project, user,
 * realm, host, remote:true, down_at?, created_at, last_activity, root_id, ghosts, nodes:[rows] } — sorted by host, then key.
 * @param {any} remote @param {{ session?, project?, user?, host? }} q @param {number} now @param {number} staleMin
 */
export function remoteBoard2(remote, q = {}, now, staleMin) {
  const out = []
  for (const o of [...remote.hosts.keys()].sort(cmp)) {
    if (str(q.host) && lc(q.host) !== lc(o)) continue
    const sl = remote.hosts.get(o)
    for (const s of [...sl.sessions.values()].sort((a, b) => cmp(a.key, b.key))) {
      if (!matches(s, q)) continue
      out.push({ session: s.ident.session, project: s.ident.project, user: s.ident.user, realm: s.ident.realm, host: o, remote: true, ...(sl.down_at ? { down_at: sl.down_at } : {}),
        created_at: s.created_at, last_activity: s.last_activity, root_id: s.rootId,
        ...(s.gone_at ? { gone_at: s.gone_at } : {}), ...(s.bell ? { bell: true } : {}),   // #88 step 10 (Q72): the owner's gone / doorbell marks (its header)
        ghosts: s.ghosts_n || 0, nodes: remoteRows(s, now, staleMin) })
    }
  }
  return out
}
/** The held remote sessions a log query names (session + project? + user? + host?) → [{ host, sess }]. */
export function locateRemote2(remote, q = {}) {
  const out = []
  for (const [o, sl] of remote.hosts) {
    if (str(q.host) && lc(q.host) !== lc(o)) continue
    for (const s of sl.sessions.values()) if (str(q.session) && matches(s, q)) out.push({ host: o, sess: s })
  }
  return out
}
/** The remote host whose held board has a CURRENT line with this entry id, or null (a remote current line is found by id alone). */
export function findRemoteLine2(remote, id) {
  if (typeof id !== 'string' || !id) return null
  for (const [o, sl] of remote.hosts) for (const s of sl.sessions.values()) for (const n of s.nodes.values()) if (n.current && n.current.id === id) return o
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// actions by id (§6.3): what a dashboard / a hub frame may carry

/** A dashboard action's fields → the bounded, id-addressed query applyAction2 takes: { session, project, user, id, action,
 * args: { state, stale_min, to_id, before_id, after_id, into_id, position, label, merges:[{ id, into_id } | { id, label }],
 * text, choice } } (anything else is dropped; the owner's applyAction2 validates the rest). */
export function actionQuery2(m) {
  const q = /** @type {any} */ ({}), src = m && typeof m === 'object' ? m : {}
  for (const k of ['session', 'project', 'user', 'id', 'action']) if (src[k] != null && typeof src[k] !== 'object') q[k] = String(src[k]).slice(0, 512)
  const a = src.args && typeof src.args === 'object' && !Array.isArray(src.args) ? src.args : null
  if (a) {
    q.args = {}
    if (typeof a.state === 'string') q.args.state = a.state.slice(0, 16)
    if (Number.isFinite(Number(a.stale_min)) && a.stale_min !== null && a.stale_min !== '') q.args.stale_min = Number(a.stale_min)
    for (const k of ['to_id', 'before_id', 'after_id', 'into_id', 'position']) if (typeof a[k] === 'string') q.args[k] = a[k].slice(0, 64)
    if (typeof a.label === 'string') q.args.label = a.label.slice(0, 1024)
    if (typeof a.text === 'string') q.args.text = a.text.slice(0, 8192)
    if (typeof a.choice === 'string') q.args.choice = a.choice.slice(0, 512)
    if (Array.isArray(a.merges)) q.args.merges = a.merges.slice(0, ACTIVITY_LIMITS.nodesPerSession).map(x => x && typeof x === 'object' ? compact({ id: wStr(x.id, 64), into_id: wStr(x.into_id, 64), label: wStr(x.label, 1024) }) : {})
  }
  return q
}
