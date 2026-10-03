// #88 (v2.0) build step 10: the DASHBOARD's view of the 2.0 board (docs/spec-88.md §5.4, §5.6, §5.7). Pure: the bridge
// hands it this host's 2.0 model and the held remote boards (gossip v6) and gets the UNITS it pushes to every subscribed
// dashboard (as #70 step 5's pushes: one full board on subscribe, then deltas of what changed, ≤ 1 per second).
//
// UNITS (§5.4: units by node id; `parent_id`, was `parent_key`):
// - one per SESSION GROUP — realm + project + user + session, merged across hosts: id = JSON ["s", groupKey], kind
//   "session", key = the groupKey, the session's names, host (one host) | hosts + multi_host + home (the host it first
//   appeared on), created_at / last_activity, gone_at (every host's copy gone), bell (any), hosts_down, and the ROOT of
//   each host as `self` (the host that set a headline most recently) / `selves` (every host's, multi-host only) — the
//   root's node fields below, with its `node_id` (actions and log pages on the session name it).
// - one per NODE (not the root, not a merged node, not an orphan whose parent is not held): id = JSON ["n", groupKey,
//   lc(host), nodeId], kind "node", group, host, node_id, parent_id (the root's id for a top-level node), and the node's
//   OWN fields: key / scope / label / path / depth, nkind (agent | context), type (its glyph / show / menu labels come from
//   the registry the full board sends once: dashTypes2), the bar
//   (bar2: what it adds to its parent's rollup — null for a group / question), a group's children (the page counts them:
//   the viewer's hidden rows are not counted, §5.7), a test-run's tests bar (testBar2, Q56), its TIME (timing2 without a
//   clock: "took …"; an open attempt carries started_at and the page shows "running …"), the MENU (menuStatic2: the
//   registry's entries that apply now; finish / dismiss marked for the page's own stale slider), the edit states, plan
//   item / plan node / plan end, rank (the effective one: stored or derived — the page sorts siblings as childrenOf2),
//   RAW state (reported; gone for an agent / root whose session left or whose host is down) + raw times (the page computes
//   stale with its slider — time passing is never a change), the line without details / data, progress, ETA, the kept
//   test-result, transient, the entry count (log.total).
import { lc } from './keys.js'
import { groupKey, rankOf, validRank, stateOf } from './activity.js'
import * as A2 from './activity2.js'

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
function compact(o) { const r = {}; for (const k of Object.keys(o)) { const v = o[k]; if (v !== null && v !== undefined && v !== false) r[k] = v } return r }
const lineOf = l => (l ? compact({ id: l.id, ts: l.ts, text: l.text, state: l.state, has_details: !!(l.details || l.has_details), has_data: l.data != null || !!l.has_data,
  by: l.by && typeof l.by === 'object' ? { kind: 'dashboard', user: l.by.user, host: l.by.host } : (typeof l.by === 'string' ? l.by : null), question: l.question ? JSON.parse(JSON.stringify(l.question)) : null }) : null)

/**
 * One node's dashboard fields (raw). o = { host, down_at (its host is down), gone (its session left: the session's gone_at),
 * memo (bar2's cache) }.
 * @param {any} sess @param {any} n @param {{ host: string, down_at?: number|null, memo?: Map<string, any> }} o
 */
export function dashNode2(sess, n, o) {
  const T = A2.typeOf(n), p = A2.planOf2(sess, n), end = p ? A2.planEndAt2(sess, n, p) : null
  const st = stateOf(n), agentish = n.kind !== 'context'
  const goneAt = agentish ? (n.gone_at || (n.parent == null ? sess.gone_at : null) || null) : null
  const gone = !!goneAt && !n.finished_at
  const tests = T.show === 'tests' ? A2.testBar2(sess, n) : null
  const took = A2.timing2(sess, n)   // no clock: an open attempt's "running …" is the page's (started_at), so time passing changes no unit
  const lg = (n.log ? n.log.length : 0) + (n.log_dropped || 0)
  return compact({
    node_id: n.id, parent_id: n.parent != null ? n.parent : null, host: o.host, key: n.key || null, scope: n.scope || null, label: n.label, name: n.label,
    path: A2.pathOf(sess, n), depth: A2.depthOf(sess, n), nkind: n.kind === 'session' ? 'session' : n.kind, type: n.type,
    bar: T.bar !== 'none' ? A2.bar2(sess, n, o.memo) : null, tests, took: took && (took.text || took.started_at != null) ? compact({ ...took, plan: took.plan ? compact(took.plan) : null }) : null,
    menu: A2.menuStatic2(sess, n).map(m => (m.when ? `${m.action}|${m.when}` : m.action)), edit_states: A2.editStates2(sess, n),
    plan_item: !!n.plan, plan_ix: n.plan && Number.isInteger(n.plan_ix) ? n.plan_ix : null, plan_node: !!p, plan_end_at: end, plan_end_how: p ? A2.planEndHow2(sess, n, p) : null,
    rank: n.parent != null ? rankOf(n) : null, rank_set: !!validRank(n.rank),
    state: gone ? 'gone' : st, was: gone ? st : null, implicit: !!n.implicit, current: lineOf(n.current), progress: n.progress ? { ...n.progress } : null, eta_at: n.eta_at || null,
    created_at: n.created_at, run_at: n.run_at !== n.created_at ? n.run_at : null, runs: n.runs > 1 ? n.runs : null, last_activity: n.last_activity, finished_at: n.finished_at || null, gone_at: goneAt,
    stale_after_ms: n.stale_after_ms || null, host_down: o.down_at || null, transient: !!n.transient, test: n.test ? { ...n.test } : null,
    log: { total: lg },
  })
}

/**
 * The TYPE registry as the page needs it (sent once, with each full board): per node type its kind, glyph, what it shows
 * where a bar would be, and its menu's labels and groups by action — a unit's `menu` then names only its actions (each
 * "action" or "action|quiet" / "action|quiet-tree": the page checks those against its own stale slider).
 * @returns {Record<string, { kind: string, glyph: string, show: string, menu: Record<string, { label: string, group: string }> }>}
 */
export function dashTypes2() {
  const out = /** @type {Record<string, any>} */ ({})
  for (const [t, T] of Object.entries(A2.NODE_TYPES)) out[t] = { kind: T.kind, glyph: T.glyph, show: T.show, menu: Object.fromEntries(T.menu.map(m => [m.action, { label: m.label, group: m.group }])) }
  return out
}

/** The visible nodes of a session below its root, depth first in sibling order (an orphan — its parent not held — is left out). */
function walkNodes(sess) {
  const out = [], root = sess.nodes.get(sess.rootId), seen = new Set()
  if (!root) return out
  const walk = (n, d) => { if (seen.has(n.id) || d > A2.LIMITS2.depthMax + 1) return; seen.add(n.id); if (n !== root) out.push(n); for (const c of A2.childrenOf2(sess, n)) walk(c, d + 1) }
  walk(root, 0)
  return out
}

/**
 * The dashboard UNITS of the merged board: this host's sessions + every held remote session (gossip v6), grouped by
 * session across hosts. → Map(unit id → { json, obj }) (planDashDelta's input).
 * @param {{ state: any, host: string, remote?: any, project?: (p: string) => string, kindOf?: (g: any) => string|null }} o
 *   state = this host's 2.0 model; remote = lib/activity2-gossip.js createRemote2(); project = the canonical spelling (#71);
 *   kindOf = the session's client kind (#79: code / cowork / page …) or null
 */
export function dashUnits2(o) {
  const parts = new Map()   // groupKey -> [{ sess, host, local, down_at }]
  const add = (sess, host, local, down) => {
    const gk = groupKey(sess.ident)
    if (!parts.has(gk)) parts.set(gk, [])
    parts.get(gk).push({ sess, host, local, down_at: down || null })
  }
  for (const s of o.state.sessions.values()) add(s, o.host, true, null)
  if (o.remote) for (const [h, sl] of o.remote.hosts) for (const s of sl.sessions.values()) add(s, h, false, sl.down_at || null)
  const proj = typeof o.project === 'function' ? o.project : p => p
  const units = new Map()
  const put = obj => units.set(obj.id, { json: JSON.stringify(obj), obj })
  for (const gk of [...parts.keys()].sort(cmp)) {
    const ps = parts.get(gk).sort((a, b) => (a.local !== b.local ? (a.local ? -1 : 1) : cmp(lc(a.host), lc(b.host))))
    const hosts = ps.map(p => p.host), multi = hosts.length > 1, lead = ps[0].sess.ident
    for (const p of ps) p.memo = new Map()
    const rootOf = p => p.sess.nodes.get(p.sess.rootId)
    const selfOf = p => { const r = rootOf(p); return r ? { ...dashNode2(p.sess, r, { host: p.host, down_at: p.down_at, memo: p.memo }), kind: 'session' } : { host: p.host, nkind: 'session', label: lead.session, name: lead.session, path: '', depth: 0, implicit: true, kind: 'session' } }
    // the headline: the host that most recently SET one (its root's line time), then the more recently active (6b)
    const lineTs = p => { const r = rootOf(p); return r && r.current ? r.current.ts || 0 : -1 }
    const newest = ps.reduce((b, p) => (lineTs(p) > lineTs(b) || (lineTs(p) === lineTs(b) && p.sess.last_activity > b.sess.last_activity) ? p : b), ps[0])
    const home = multi ? ps.reduce((b, p) => (p.sess.created_at < b.sess.created_at || (p.sess.created_at === b.sess.created_at && cmp(lc(p.host), lc(b.host)) < 0) ? p : b), ps[0]).host : null
    const down = ps.filter(p => p.down_at).map(p => p.host)
    const goneAll = ps.every(p => p.sess.gone_at || p.down_at)
    const hdr = compact({ session: lead.session, project: proj(lead.project), user: lead.user, realm: lead.realm, host: multi ? null : hosts[0], hosts: multi ? hosts : null, multi_host: multi, home,
      created_at: Math.min(...ps.map(p => p.sess.created_at || 0)), last_activity: Math.max(...ps.map(p => p.sess.last_activity || 0)),
      gone_at: goneAll ? Math.max(...ps.map(p => p.sess.gone_at || p.down_at || 0)) : null, bell: ps.some(p => p.sess.bell), hosts_down: down.length ? down : null,
      client_kind: typeof o.kindOf === 'function' ? o.kindOf(lead) : null })
    put({ id: JSON.stringify(['s', gk]), kind: 'session', key: gk, ...hdr, self: selfOf(newest), ...(multi ? { selves: ps.map(selfOf) } : {}) })
    for (const p of ps) {
      for (const n of walkNodes(p.sess)) {
        const nu = dashNode2(p.sess, n, { host: p.host, down_at: p.down_at, memo: p.memo })
        put({ id: JSON.stringify(['n', gk, lc(p.host), n.id]), kind: 'node', group: gk, ...nu })
      }
    }
  }
  return units
}

/**
 * One dashboard's next delta against its published view `pub` (unit id → json): the changed / new units (`upsert`,
 * sessions before nodes, parents before children) and the ids that left (`remove`). `full` resets the view; `pub` is
 * updated. (#70 step 5's planDashDelta, unchanged.)
 * @param {Map<string, string>} pub @param {Map<string, { json: string, obj: any }>} units @param {{ full?: boolean }} [opts]
 * @returns {{ upsert: any[], remove: string[], empty: boolean }}
 */
export function planDashDelta2(pub, units, opts = {}) {
  if (opts && opts.full) pub.clear()
  const upsert = [], remove = []
  for (const [id, u] of units) if (pub.get(id) !== u.json) { upsert.push(u.obj); pub.set(id, u.json) }
  for (const id of [...pub.keys()]) if (!units.has(id)) { remove.push(id); pub.delete(id) }
  upsert.sort((a, b) => (a.kind === b.kind ? (a.depth || 0) - (b.depth || 0) : a.kind === 'session' ? -1 : 1))
  return { upsert, remove, empty: !upsert.length && !remove.length }
}
