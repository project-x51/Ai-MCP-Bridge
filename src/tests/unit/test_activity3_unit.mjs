// Fast UNIT tests for #88 (v2.0) build step 3 — v6 records + replay (docs/spec-88.md §2, §5.1 – §5.3, §8 step 3, §10):
// what the records carry (create scope / implicit / runs, merge kid_ranks, entry line / test_cleared / caller),
// recordKind2, the expiry pass that writes its removals, checkpoints (cp / rep, the kept test-result), carry-forward
// (structure too), the REPLAY (a chronological fold — node records + entries by `n`), a seeded REPLAY FUZZ (replay ≡
// chronological apply: lines, bars, structure, logs, counts, runs — over the whole history AND over the window with day
// rollovers + cf), and the files (lib/activity2-files.js: day files, per-day index files, the ghost table they rebuild,
// the Dropbox rule: own directory only, conflicted copies warned about and never read). Temp dirs only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testOnly } from '../helpers/check.mjs'
import * as M from '../../lib/activity2.js'
import * as A from '../../lib/activity.js'
import * as F from '../../lib/activity2-files.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.message} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
async function section(fn) { try { await fn() } catch (e) { fail++; console.log('FAIL section crashed:', (e && e.stack) || e) } }
const BRIDGET = { session: 'Bridget', project: 'AIMB', user: 'robin' }
const KIM = { session: 'kim-s', project: 'Marz', user: 'kim' }
const DASH = { kind: 'dashboard', user: 'robin', host: 'ROBIN-Z790' }
const MIN = 60000, HOUR = 3600000, DAY = 86400000
const T0 = new Date(2026, 9, 1, 9, 0, 0).getTime()   // a LOCAL morning: day files are per local day
const parse = r => JSON.parse(J(r))
function firstDiff(a, b) { if (a === b) return ''; let i = 0; while (i < a.length && a[i] === b[i]) i++; return `@${i}: …${a.slice(Math.max(0, i - 160), i + 100)}\n  vs …${b.slice(Math.max(0, i - 160), i + 100)}` }

// ---- the live side: a model + every write kept as the day files would hold it ({ rec, day })
function world(o = {}) {
  const st = M.createModel({ origin: 'ROBIN-Z790', config: { log_entries_per_agent: 10, finished_visible_hours: 30, ...(o.config || {}) }, limits: o.limits })
  let now = o.t0 || T0
  const files = []   // [{ rec, day }] in write order
  const put = recs => { for (const r of recs || []) files.push({ rec: parse(r), day: A.localDay(r.ts) }) }
  const putW = ws => { for (const w of ws) { const rec = parse(w.rec), day = A.localDay(w.kind === 'rep' ? rec.last : rec.ts); if (w.rewrite && files.length && Array.isArray(files[files.length - 1].rec.rep)) files[files.length - 1] = { rec, day }; else files.push({ rec, day }) } }
  const call = (x, ident = BRIDGET, opt) => { const r = M.applyCall(st, ident, x, now, opt); if (r.ok) put(r.writes); return r }
  const act = (id, action, args = {}, ident = BRIDGET) => { const r = M.applyAction2(st, { ...ident, id, action, args }, now, { by: DASH }); if (r.ok) put(r.writes); return r }
  const sess = (ident = BRIDGET) => M.getSession2(st, ident)
  const get = (key, scope = null, ident = BRIDGET) => { const s = sess(ident); if (!s) return null; const c = scope ? get(scope, null, ident) : M.rootOf(s), id = c && s.scope.get(c.id + '\n' + key.toLowerCase()); return id ? s.nodes.get(id) || null : null }
  const tick = ms => { now += ms; return now }
  return { st, files, put, putW, call, act, sess, get, tick, at: () => now, set: t => { now = t } }
}
// ---- a model dump: what must be equal after a replay. opts: { activity (last_activity / stale_after / the session's), logs
// ('all' | a cutoff: only entries from it), ghosts, scope (every key, ghosts' too — else live nodes' only) }
function dump(st, o = {}) {
  const act = o.activity !== false, cut = typeof o.logs === 'number' ? o.logs : null
  const sorted = m => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out = []
  for (const [k, s] of sorted(st.sessions)) {
    const nodes = []
    for (const [, n] of sorted(s.nodes)) {
      const x = { ...n }
      delete x.cp_dirty; delete x.cp_sig; delete x.log_floor
      if (!act) { delete x.last_activity; delete x.stale_after_ms }
      if (cut != null) { x.log = n.log.filter(e => e.ts >= cut); x.log_n = n.log.length + n.log_dropped; delete x.log_dropped }
      x.bar = M.bar2(s, n); x.display = M.displayOf2(s, n); x.tests = M.testCounts2(s, n); x.plan_end_at = M.planEndAt2(s, n); x.path = M.pathOf(s, n)
      nodes.push(x)
    }
    const kids = sorted(s.kids).map(([p, ids]) => [p, [...ids].sort()]).filter(([, ids]) => ids.length)
    const scope = sorted(s.scope).filter(([, id]) => o.scope || s.nodes.has(id))
    const aliases = sorted(s.aliases).map(([k2, a]) => [k2, a.id, a.path, a.at])
    out.push({ k, ident: s.ident, created_at: s.created_at, ...(act ? { last_activity: s.last_activity } : {}), rootId: s.rootId, nodes, kids, labels: sorted(s.labels), scope, aliases,
      ...(o.ghosts ? { ghosts: sorted(s.ghosts), gkids: sorted(s.gkids).map(([p, ids]) => [p, [...ids].sort()]) } : {}) })
  }
  return J(out)
}

// ================================================================= the records carry what the replay needs
await section(() => {
  const w = world()
  const r1 = w.call({ path: 'Rel/Docs', text: 'hello' })
  const cr = r1.records.filter(x => x.op === 'create')
  check('create: `scope` (the creator\'s chain) on every create; a path\'s intermediate is `implicit`, its last segment is not',
    cr.length === 2 && cr.every(x => x.scope === '') && cr[0].implicit === true && !('implicit' in cr[1]), J(cr))
  w.tick(1000); w.call({ agent: 'a1', label: 'Agent one', text: '@working' })
  w.tick(1000); const r2 = w.call({ agent: 'a1', key: 'notes', label: 'Notes', text: 'x' })
  check('create: an agent\'s own key gets `scope` = its chain ("a1")', r2.records[0].op === 'create' && r2.records[0].scope === 'a1' && r2.records[0].c === w.get('a1').id)
  w.tick(1000); const e1 = w.call({ agent: 'a1', key: 'notes', text: '@a line' }).entries[0]
  w.tick(1000); const e2 = w.call({ agent: 'a1', key: 'notes', state: 'blocked' }).entries[0]
  check('entry: `line:true` when it SET the line\'s text; a state change keeps the text (no `line`)', e1.line === true && e1.current && !('line' in e2) && e2.current, J([e1, e2]))
  w.tick(1000); const e3 = w.call({ agent: 'a1', id: M.findPath(w.sess(), 'Rel/Docs').id, text: 'from a1' }).entries[0]
  check('entry: `caller` = the calling agent when it is not on target..owner (a1 reporting into the session\'s Rel/Docs)', e3.caller === w.get('a1').id, J(e3))
  w.tick(1000); const e4 = w.call({ agent: 'a1', key: 'notes', text: 'own' }).entries[0]
  check('entry: no `caller` when the caller is the owner', !('caller' in e4))
  w.tick(1000); w.call({ key: 't1', label: 'T1', state: 'done', message_type: 'test-result', fields: { result: 'pass' } })
  w.tick(1000); const e5 = w.call({ key: 't1', state: 'running' }).entries[0]
  check('entry: `test_cleared` when a restart dropped the kept test-result', e5.test_cleared === true && w.get('t1').test === null, J(e5))
  w.tick(1000); w.call({ key: 'A', label: 'A' }); w.call({ key: 'B', label: 'B' }); w.call({ key: 'x', label: 'X', under: 'A' }); w.call({ key: 'y', label: 'Y', under: 'A' })
  w.tick(1000); const m = w.call({ key: 'A', merge: 'B' }).records.find(x => x.op === 'merge')
  check('merge: `kid_ranks` beside `kids` (the rank each kid got under B)', m && m.kids.length === 2 && m.kid_ranks.length === 2 && m.kid_ranks.every(r => typeof r === 'string') && m.kid_ranks[0] === w.sess().nodes.get(m.kids[0]).rank, J(m))
  const t = M.createModel({ origin: 'H' })
  M.applyCall(t, BRIDGET, { key: 'g', label: 'G', transient: true, text: 'x' }, T0)
  M.applyCall(t, BRIDGET, { key: 'k', label: 'K', under: 'g', text: 'y' }, T0 + 1)
  const mv = M.applyCall(t, BRIDGET, { key: 'k', move_to: '/Other' }, T0 + 2)
  M.applyCall(t, BRIDGET, { key: 'k', move_to: '/G' }, T0 + 3)   // the vanished G comes back: a ghost's new run
  const back = M.applyCall(t, BRIDGET, { key: 'k', move_to: '/G' }, T0 + 4)
  const res = M.applyCall(t, BRIDGET, { key: 'z', label: 'Z', move_to: '/G' }, T0 + 5)
  check('create: a resurrected ghost\'s create carries `runs` (> 1)', mv.records.some(x => x.op === 'remove' && x.why === 'transient') && (() => { const s = M.getSession2(t, BRIDGET), g = [...s.nodes.values()].find(n => n.label === 'G'); return g && g.runs === 2 })(), J([back.records, res.records]))
})

// ================================================================= recordKind2: v6 only
await section(() => {
  const w = world()
  const r = w.call({ key: 'k', label: 'K', text: '@x' })
  const id = r.node.id, base = { v: 6, session: 'Bridget', ts: T0, n: id }
  check('recordKind2: a create record → node; an entry → entry', M.recordKind2(r.records[0]) === 'node' && M.recordKind2(r.entries[0]) === 'entry')
  check('recordKind2: cp (integer k), cf, rep (by its array; its n is a COUNT)', M.recordKind2({ ...base, kind: 'cp', k: 3 }) === 'cp' && M.recordKind2({ ...base, kind: 'cf' }) === 'cf' && M.recordKind2({ v: 6, rep: [1, 2], n: 245, since: T0, last: T0 }) === 'rep')
  check('recordKind2: v5 records, other kinds, a bad op / id / state are skipped (null)', [{ ...base, v: 5, kind: 'cf' }, { ...base, kind: 'node', op: 'explode' }, { ...base, n: 'NOT-AN-ID', kind: 'cf' }, { ...base, kind: 'weird' },
    { ...base, id: 'e', text: 'x', state: 'nope' }, { ...base, kind: 'cp', k: 1.5 }, { v: 6, rep: [1], n: 1, since: 0 }, null, [], 'x'].every(x => M.recordKind2(x) === null))
})

// ================================================================= the REPLAY FUZZ: replay ≡ chronological apply
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const LABELS = ['Notes', 'Build', 'Docs', 'Tests', 'notes', 'Pending', 'Done', 'Later', 'Spec']
const KEYS = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8']
const AGENTS = ['a1', 'a2', 'a1/b1', 'a3']
const PATHS = ['Rel/Docs', 'Rel/Build', 'Rel', 'Tests/Pending', 'Later/Docs', 'Notes']
const MOVE_TO = ['../Passed', '../Failed', '/Tests/In progress', '/Tests/Passed', '/Rel', '../Pending', '/Later']
const ACTS = ['done', 'skip', 'reopen', 'abandon', 'complete', 'abandon_plan', 'reopen_plan', 'finish', 'dismiss', 'move', 'reorder', 'rename', 'merge', 'edit_text', 'message', 'show_as_group', 'show_as_plan', 'answer', 'withdraw', 'change_answer']
/**
 * One seeded history: `ops` random calls / actions over `days` simulated days, with the owner's expiry pass, checkpoints
 * (when `unlogged`) and the day rollover's carry-forward. → the world after a final checkpoint flush.
 */
function history(seed, { ops = 160, unlogged = 0, days = 3, limits = { nodesPerSession: 30, agentsPerSession: 4 } } = {}) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)], chance = p => r() < p
  const w = world({ limits })
  const span = days * DAY / ops
  let lastDay = A.localDay(w.at()), nextCp = w.at() + 5 * MIN
  const stats = { ok: 0, refused: 0, acts: 0, cfs: 0, cps: 0, removes: 0 }
  const ids = ident => { const s = w.sess(ident); return s ? [...s.nodes.values()].filter(n => !n.merged_into).map(n => n.id) : [] }
  for (let i = 0; i < ops; i++) {
    // time: mostly seconds to minutes, sometimes hours (expiry, rollovers)
    const before = w.at()
    w.tick(chance(0.08) ? Math.floor(span * (1 + r() * 6)) : 1000 + Math.floor(r() * 9 * MIN))
    const now = w.at()
    while (unlogged && nextCp <= now) { const cw = M.planCheckpoints2(w.st, nextCp); stats.cps += cw.length; w.putW(cw); nextCp += 5 * MIN }
    if (A.localDay(now) !== lastDay) {   // the local day rolled over: the carry-forward goes first into the new day's file
      lastDay = A.localDay(now)
      const day0 = new Date(now); day0.setHours(0, 0, 0, 0)
      const at = Math.max(before + 1, day0.getTime())
      const cf = M.planCarryForward2(w.st, at); stats.cfs += cf.length; w.putW(cf)
    }
    if (chance(0.12)) { const p = M.expirePass2(w.st, now); w.put(p.writes); stats.removes += p.removed.length }
    const ident = chance(0.85) ? BRIDGET : KIM
    const ag = chance(0.4) ? pick(AGENTS) : null
    const x = {}
    const roll = r()
    if (roll < 0.06) Object.assign(x, { agent: pick(AGENTS), label: pick(LABELS) + (chance(0.5) ? ' agent' : ''), text: chance(0.5) ? '@starting' : 'hello' }, chance(0.4) ? { state: pick(['done', 'failed']) } : {})
    else if (roll < 0.12) Object.assign(x, { path: pick(PATHS), text: chance(0.5) ? `@p${i}` : `p${i}` })
    else if (roll < 0.2) Object.assign(x, { key: pick(KEYS), label: pick(LABELS), plan: [pick(LABELS), pick(LABELS), { key: pick(KEYS), label: pick(LABELS) }].slice(0, 1 + Math.floor(r() * 3)) })
    else if (roll < 0.27) Object.assign(x, { key: pick(KEYS), label: pick(LABELS), move: chance(0.5) ? pick(KEYS) : pick(PATHS) }, chance(0.3) ? { rename: pick(LABELS) + ' m' } : {})
    else if (roll < 0.37) Object.assign(x, { key: pick(KEYS), label: pick(LABELS), move_to: pick(MOVE_TO), text: `@mt${i}`, state: pick(['running', 'done', 'failed', 'todo']) },
      chance(0.25) ? { transient: chance(0.5) ? '2m' : true } : {}, chance(0.3) ? { message_type: 'test-result', fields: { result: pick(['pass', 'fail', 'skip']), checks: 4, failed: 1, duration: '2s' } } : {})
    else if (roll < 0.41) Object.assign(x, { key: pick(KEYS), rename: pick(LABELS) + (chance(0.5) ? ' r' : '') })
    else if (roll < 0.45) Object.assign(x, { key: pick(KEYS), merge: pick(KEYS) })
    else if (roll < 0.47) Object.assign(x, { key: pick(KEYS), unmerge: true }, chance(0.3) ? { label: pick(LABELS) + ' u' } : {})
    else if (roll < 0.5) Object.assign(x, { key: pick(KEYS), label: pick(LABELS), ask: `q${i}?`, choices: ['yes', 'no'] }, chance(0.3) ? { expires: '20m' } : {})
    else if (roll < 0.52) Object.assign(x, { key: pick(KEYS), keep: true })
    else if (roll < 0.54) Object.assign(x, { key: pick(KEYS), label: pick(LABELS), transient: chance(0.5) ? '3m' : true, under: chance(0.5) ? pick(KEYS) : undefined })
    else if (roll < 0.56) Object.assign(x, { key: pick(KEYS), position: pick(['first', 'last']) })
    else if (roll < 0.58) Object.assign(x, { key: pick(KEYS), label: pick(LABELS), context_type: pick(['group', 'plan', 'test-run', 'context']), text: 'typed' })
    else if (roll < 0.76) {   // a dashboard action on a random node
      const pool = ids(ident)
      if (pool.length) {
        const id = pick(pool), a = pick(ACTS), args = {}
        if (a === 'move') args.to_id = pick(pool)
        if (a === 'merge') args.into_id = pick(pool)
        if (a === 'reorder') args.position = pick(['first', 'last'])
        if (a === 'rename') args.label = pick(LABELS) + ' d'
        if (a === 'edit_text' || a === 'message') args.text = `edited ${i}`
        if (a === 'finish') args.state = pick(['done', 'failed'])
        if (a === 'answer' || a === 'change_answer') args.choice = pick(['yes', 'no'])
        if (a === 'dismiss' || a === 'finish') args.stale_min = 1
        const res = w.act(id, a, args, ident)
        stats.acts++; res.ok ? stats.ok++ : stats.refused++
      }
      continue
    } else Object.assign(x, { key: pick(KEYS), label: pick(LABELS) })
    // the report part
    if (!x.ask && !x.plan && !('text' in x) && chance(0.85)) x.text = chance(0.5) ? `@line ${i}` : `log ${i}`
    if (!x.ask && chance(0.25)) x.state = pick(['running', 'blocked', 'done', 'failed', 'idle', 'todo', 'skipped', 'abandoned'])
    if (!x.ask && chance(0.15)) x.progress = chance(0.2) ? 'none' : `${Math.floor(r() * 5)}/5 files`
    if (!x.ask && chance(0.1)) x.eta = chance(0.2) ? 'none' : `${1 + Math.floor(r() * 50)}m`
    if (chance(0.08)) x.stale_after = `${5 + Math.floor(r() * 50)}m`
    if (chance(0.08)) x.details = `details ${i}`
    if (chance(0.06)) x.data = { i }
    if (!x.ask && unlogged && chance(unlogged)) x.log = false
    if (ag && !x.agent) x.agent = ag
    if (x.message_type && chance(0.7)) delete x.state   // Q57: a test-result sets the state (a contradicting one is refused)
    for (const k of Object.keys(x)) if (x[k] === undefined) delete x[k]
    const res = w.call(x, ident)
    res.ok ? stats.ok++ : stats.refused++
  }
  w.tick(MIN)
  w.putW(M.flushCheckpoints2(w.st, w.at(), { withRep: true }))
  return { w, stats }
}
// a debugging aid: AIMB_FUZZ_SEED=<n> [AIMB_FUZZ_MODE=window|unlogged] prints one seed's differing nodes and their records
if (process.env.AIMB_FUZZ_SEED) {
  const seed = Number(process.env.AIMB_FUZZ_SEED), mode = process.env.AIMB_FUZZ_MODE || 'whole'
  const { w } = history(seed, mode === 'window' ? { days: 4, ops: 180 } : mode === 'unlogged' ? { unlogged: 0.45 } : {})
  const now = w.at() + 1, cutoff = now - 30 * HOUR
  const B = M.createModel({ origin: 'ROBIN-Z790', config: { log_entries_per_agent: 10, finished_visible_hours: 30 } })
  console.log(J(M.replayRecords2(B, w.files, now, mode === 'window' ? {} : { from: 0 })), 'cutoff', cutoff)
  if (process.env.AIMB_FUZZ_GREP) for (const f of w.files) if (J(f.rec).includes(process.env.AIMB_FUZZ_GREP)) console.log('GREP', f.day, J(f.rec).slice(0, 700))
  const o = mode === 'window' ? { logs: cutoff } : mode === 'unlogged' ? { activity: false, ghosts: true, scope: true } : { ghosts: true, scope: true }
  const a = JSON.parse(dump(w.st, o)), b = JSON.parse(dump(B, o))
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || {}, y = b[i] || {}
    for (const k of Object.keys({ ...x, ...y })) {
      if (J(x[k]) === J(y[k])) continue
      if (k !== 'nodes') { console.log('DIFF', k, '\n live  ', J(x[k]).slice(0, 3000), '\n replay', J(y[k]).slice(0, 3000)); continue }
      const ids = new Set([...(x.nodes || []), ...(y.nodes || [])].map(n => n.id))
      for (const id of ids) {
        const p = (x.nodes || []).find(n => n.id === id), q = (y.nodes || []).find(n => n.id === id)
        if (J(p) === J(q)) continue
        console.log('NODE', id, '\n live  ', J(p), '\n replay', J(q))
        for (const f of w.files) if (f.rec.n === id || (f.rec.kids || []).includes(id) || f.rec.p === id) console.log('   ', f.day, J(f.rec).slice(0, 400))
      }
    }
  }
  process.exit(0)
}
await section(() => {
  // 1) the WHOLE history replayed (from the first record): everything equal — lines, bars, structure, logs, counts, runs,
  //    ghosts, the scope index (ghost keys too), labels, aliases, activity
  let fuzzed = 0, bad = 0, firstBad = '', totals = { ok: 0, refused: 0, cfs: 0, removes: 0, recs: 0 }
  const ops = {}
  for (let seed = 1; seed <= Number(process.env.AIMB_FUZZ_WHOLE || 400); seed++) {
    const { w, stats } = history(seed)
    for (const f of w.files) { const k = f.rec.kind === 'node' ? f.rec.op + (f.rec.op === 'remove' ? ':' + f.rec.why : f.rec.op === 'create' && f.rec.runs ? ':run' : '') : f.rec.kind || (f.rec.type === 'note' ? (f.rec.current ? 'line' : 'note') : f.rec.type); ops[k] = (ops[k] || 0) + 1 }
    const now = w.at() + 1
    const B = M.createModel({ origin: 'ROBIN-Z790', config: { log_entries_per_agent: 10, finished_visible_hours: 30 } })
    M.replayRecords2(B, w.files, now, { from: 0 })
    const a = dump(w.st, { ghosts: true, scope: true }), b = dump(B, { ghosts: true, scope: true })
    fuzzed++; totals.ok += stats.ok; totals.refused += stats.refused; totals.cfs += stats.cfs; totals.removes += stats.removes; totals.recs += w.files.length
    if (a !== b) { bad++; if (!firstBad) firstBad = `seed ${seed}: ${firstDiff(a, b)}` }
  }
  check(`REPLAY FUZZ, whole history: ${fuzzed} seeded histories (${totals.ok} calls applied, ${totals.refused} refused, ${totals.recs} records, ${totals.cfs} cf, ${totals.removes} expired) — replay ≡ chronological apply (structure, lines, bars, test counts, logs, runs, ghosts, scope, labels, aliases, activity)`,
    bad === 0, `${bad} differ — ${firstBad}`)
  const need = ['create', 'create:run', 'move', 'label', 'rank', 'item', 'type', 'keep', 'merge', 'unmerge', 'remove:dismiss', 'remove:evict', 'remove:expire', 'remove:transient', 'cf', 'line', 'note', 'event', 'test-result', 'question', 'answer', 'withdrawal', 'expiry']
  console.log('   fuzz coverage:', J(Object.fromEntries(Object.entries(ops).sort())))
  check('the fuzz covers every node op (creates, new runs, moves, renames, ranks, items, types, keeps, merges, unmerges, removals by dismiss / evict / expire / transient), cf, and every entry type',
    need.every(k => ops[k] > 0), J(need.filter(k => !(ops[k] > 0))))
})
await section(() => {
  // 2) the WINDOW (now − finished_visible_hours, as the bridge reads it) with day rollovers + cf: the same tree, lines, bars,
  //    counts; each node's log = its entries in the window (older ones are only in the files), its entry count exact
  let bad = 0, firstBad = '', cfUsed = 0
  for (let seed = 1001; seed <= 1000 + Number(process.env.AIMB_FUZZ_WINDOW || 200); seed++) {
    const { w } = history(seed, { days: 4, ops: 180 })
    const now = w.at() + 1, cutoff = now - 30 * HOUR
    const B = M.createModel({ origin: 'ROBIN-Z790', config: { log_entries_per_agent: 10, finished_visible_hours: 30 } })
    const st = M.replayRecords2(B, w.files, now)
    cfUsed += st.cfs
    const a = dump(w.st, { logs: cutoff }), b = dump(B, { logs: cutoff })
    if (a !== b) { bad++; if (!firstBad) firstBad = `seed ${seed}: ${firstDiff(a, b)}` }
  }
  check(`REPLAY FUZZ, the window only (30 h of 4 days, cf at each rollover): ${Number(process.env.AIMB_FUZZ_WINDOW || 200)} seeds — replay ≡ apply (structure, lines, bars, counts, runs, aliases, activity; logs from the window, exact entry counts) — ${cfUsed} cf lines used`,
    bad === 0, `${bad} differ — ${firstBad}`)
})
await section(() => {
  // 3) log:false (45 %): checkpoints + repeat lines carry the line state — lines / bars / states / kept test-results agree
  let bad = 0, firstBad = '', cps = 0
  for (let seed = 2001; seed <= 2100; seed++) {
    const { w, stats } = history(seed, { unlogged: 0.45 })
    cps += stats.cps
    const now = w.at() + 1
    const B = M.createModel({ origin: 'ROBIN-Z790', config: { log_entries_per_agent: 10, finished_visible_hours: 30 } })
    M.replayRecords2(B, w.files, now, { from: 0 })
    const a = dump(w.st, { activity: false, ghosts: true, scope: true }), b = dump(B, { activity: false, ghosts: true, scope: true })
    if (a !== b) { bad++; if (!firstBad) firstBad = `seed ${seed}: ${firstDiff(a, b)}` }
  }
  check(`REPLAY FUZZ with log:false (45 %): 100 seeds, ${cps} cp / rep lines — lines, bars, states, kept test-results, structure and logs agree`, bad === 0, `${bad} differ — ${firstBad}`)
})

// ================================================================= checkpoints: log:false, the kept test-result (2d), repeat lines
const fresh = () => M.createModel({ origin: 'ROBIN-Z790', config: { log_entries_per_agent: 10, finished_visible_hours: 30 } })
await section(() => {
  const w = world()
  w.call({ agent: 'run', label: 'Runner', text: '@go' })
  w.tick(1000); w.call({ agent: 'run', key: 't1', label: 'T1', text: '@started' })
  w.tick(1000); const r = w.call({ agent: 'run', key: 't1', state: 'done', message_type: 'test-result', fields: { result: 'pass', checks: 22, duration: '4.1s' }, log: false })
  check('log:false test-result: no entry, the node keeps its result (entry null) and is cp_dirty', r.ok && !r.entries.length && w.get('t1', 'run').test.result === 'pass' && w.get('t1', 'run').test.entry === null && w.get('t1', 'run').cp_dirty)
  w.tick(1000); const cps = M.planCheckpoints2(w.st, w.at()); w.putW(cps)
  check('the checkpoint carries the kept test-result (2d\'s note for step 3) and the line state', cps.length === 1 && cps[0].kind === 'cp' && cps[0].rec.k === 1 && cps[0].rec.test.result === 'pass' && cps[0].rec.test.checks === 22 && cps[0].rec.state === 'done' && cps[0].rec.n === w.get('t1', 'run').id, J(cps))
  const B = fresh(); M.replayRecords2(B, w.files, w.at() + 1, { from: 0 })
  const t1 = M.getSession2(B, BRIDGET).nodes.get(w.get('t1', 'run').id)
  check('replayed: the kept result (entry null), the state and the counts come back from the cp', t1 && J(t1.test) === J(w.get('t1', 'run').test) && t1.current.state === 'done' && M.testOutcome2(t1) === 'pass')
  check('replayed: the cp restates the node\'s exact activity', t1.last_activity === w.get('t1', 'run').last_activity)
  // unchanged log:false heartbeats → one repeat line, rewritten in place
  w.tick(1000); w.call({ agent: 'run', key: 't1', progress: '3/5', log: false })
  w.tick(MIN); const p0 = M.planCheckpoints2(w.st, w.at())
  w.tick(1000); w.call({ agent: 'run', key: 't1', progress: '3/5', log: false })
  w.tick(MIN); const p1 = M.planCheckpoints2(w.st, w.at())
  w.tick(1000); w.call({ agent: 'run', key: 't1', progress: '3/5', log: false })
  w.tick(MIN); const p2 = M.planCheckpoints2(w.st, w.at())
  check('a CHANGED log:false report → a cp (same key in today\'s file); an unchanged one → its key on a repeat line; the next interval with the same keys REWRITES it (n 2)',
    p0.length === 1 && p0[0].kind === 'cp' && p0[0].rec.k === 1 && p1.length === 1 && p1[0].kind === 'rep' && J(p1[0].rec.rep) === '[1]' && !p1[0].rewrite && p2[0].kind === 'rep' && p2[0].rewrite && p2[0].rec.n === 2, J([p0, p1, p2]))
  w.putW([...p0, ...p1, ...p2])
  w.tick(1000); w.call({ agent: 'run', key: 't1', text: 'a logged line' })
  w.tick(1000); w.call({ agent: 'run', key: 't1', progress: '3/5', log: false })
  w.tick(MIN); const p3 = M.planCheckpoints2(w.st, w.at())
  check('any other write closes the open repeat line (a new one is appended)', p3.length === 1 && p3[0].kind === 'rep' && !p3[0].rewrite, J(p3))
  w.putW(p3)
  const R = fresh(); M.replayRecords2(R, w.files, w.at() + 1, { from: 0 })
  const rt = M.getSession2(R, BRIDGET).nodes.get(w.get('t1', 'run').id)
  check('replayed through cp + rep lines: the bar and line agree; a rep line refreshes activity to its interval\'s time (at most one interval late)',
    rt.progress.done === 3 && J(rt.current) === J(w.get('t1', 'run').current) && rt.last_activity >= w.get('t1', 'run').last_activity && rt.last_activity - w.get('t1', 'run').last_activity <= MIN + 1000)
  // a log:false report on a node outside the caller's subtree also checkpoints the CALLER (its activity)
  w.call({ key: 'shared', label: 'Shared', text: 'x' })
  w.tick(1000); w.call({ agent: 'run', id: w.get('shared').id, progress: '1/3', log: false })
  w.tick(MIN); const p4 = M.planCheckpoints2(w.st, w.at())
  check('log:false via a calling agent outside target..owner: the target AND the caller get a cp', p4.filter(x => x.kind === 'cp').map(x => x.rec.n).sort().join() === [w.get('shared').id, w.get('run').id].sort().join(), J(p4.map(x => x.rec.n)))
  // a new local day: keys restart at 1
  w.set(T0 + DAY); w.call({ agent: 'run', key: 't1', state: 'done', log: false })
  const p5 = M.planCheckpoints2(w.st, w.at())
  check('a new local day starts a new file: keys restart at 1 (a full cp there)', p5.length === 1 && p5[0].kind === 'cp' && p5[0].rec.k === 1)
  // the replay re-derives today's keys, so new cps keep numbering past them
  w.putW(p5)
  const C = fresh(); M.replayRecords2(C, w.files, w.at() + 1, { from: 0 })
  check('replay: today\'s cp keys are re-derived (the next new key continues past them)', C.cp && C.cp.day === A.localDay(w.at()) && C.cp.keys.get(w.get('t1', 'run').id) === 1 && C.cp.next === 2, J(C.cp && [...C.cp.keys]))
  const maxSeq = Math.max(...w.files.filter(f => M.recordKind2(f.rec) === 'entry').map(f => parseInt(f.rec.id.split('-').pop(), 36)))
  check('replay: entry ids continue past the replayed ones (state.seq = the highest written)', C.seq === maxSeq && maxSeq > 0, `${C.seq} vs ${maxSeq}`)
})

// ================================================================= TIME in the logs: start → end of an attempt, on the node and its ending entry
await section(() => {
  const w = world()
  w.call({ agent: 'dev', label: 'Dev', text: '@starting', state: 'running' })
  w.tick(1000); w.call({ agent: 'dev', key: 'rel', label: 'Release', plan: [{ key: 'a', label: 'Spec' }, { key: 'b', label: 'Build' }, { key: 'c', label: 'Docs' }] })
  const a = () => w.get('a', 'dev'), b = () => w.get('b', 'dev'), c = () => w.get('c', 'dev')
  w.tick(MIN); const t0 = w.at(); w.call({ agent: 'dev', key: 'a', state: 'running', text: '@writing' })
  check('an item going running STARTS an attempt (started_at; no took yet); timing2 says "running …" with a now', a().started_at === t0 && a().took === null && M.timing2(w.sess(), a(), t0 + 3 * MIN).text === 'running 3m')
  w.tick(4 * MIN + 12000); const e1 = w.call({ agent: 'dev', key: 'a', state: 'done', text: '@spec written' }).entries[0]
  check('…done ENDS it: took = 4m 12s on the node, and the ending entry carries took (ms)', a().took === 252000 && a().ended_at === w.at() && e1.took === 252000 && !('attempts' in e1), J(e1))
  check('displayOf2 shows it: took.text "took 4m 12s"', M.displayOf2(w.sess(), a()).took.text === 'took 4m 12s', J(M.displayOf2(w.sess(), a()).took))
  w.tick(MIN); w.act(a().id, 'reopen')
  check('a reopen (back to todo) keeps the latest took; nothing open', a().took === 252000 && a().ended_at != null && a().attempts === 1)
  w.tick(MIN); w.call({ agent: 'dev', key: 'a', state: 'running', text: '@again' })
  w.tick(30000); const e2 = w.call({ agent: 'dev', key: 'a', state: 'failed', text: '@broke' }).entries[0]
  check('a RESTART is a new attempt: took = the latest (30s), took_total adds up (4m 42s over 2 runs); the ending entry carries total + attempts',
    a().took === 30000 && a().took_total === 282000 && a().attempts === 2 && e2.took === 30000 && e2.took_total === 282000 && e2.attempts === 2 && M.timing2(w.sess(), a()).text === 'took 30s (4m 42s over 2 runs)', J([e2, M.timing2(w.sess(), a())]))
  w.tick(MIN); w.act(b().id, 'done')
  check('an item ticked straight from todo (never running): no start, no took — none is invented', b().took === null && b().started_at === null && M.timing2(w.sess(), b()) === null)
  w.tick(MIN); w.call({ agent: 'dev', key: 'c', state: 'running' }); w.tick(MIN); w.call({ agent: 'dev', key: 'c', state: 'todo' })
  w.tick(MIN); w.call({ agent: 'dev', key: 'c', state: 'done' })
  check('back to todo mid-attempt drops it (no took for the abandoned try); done afterwards has no start', c().took === null && c().attempts === 0 && c().first_started_at != null)
  w.tick(MIN); w.act(a().id, 'done')
  const pt = M.timing2(w.sess(), w.get('rel', 'dev'))
  check('a PLAN gets its own start-to-end time: from its first item\'s first start to the plan\'s end', pt && pt.plan.started_at === t0 && pt.plan.ended_at === M.planEndAt2(w.sess(), w.get('rel', 'dev')) && pt.plan.took === pt.plan.ended_at - t0 && pt.text === `took ${M.fmtTook(pt.plan.took)}`, J(pt))
  w.tick(MIN); const ea = w.call({ agent: 'dev', text: '@all done', state: 'done' }).entries[0]
  check('an AGENT\'s own attempt: running → done', w.get('dev').took === w.at() - T0 && ea.took === w.get('dev').took)
  // test-results: the duration IS the took
  w.tick(MIN); w.call({ key: 'tests', label: 'Tests', context_type: 'test-run', state: 'running', text: '@run' })
  w.call({ key: 'pend', label: 'Pending', under: 'tests', transient: true, plan: [{ key: 't1', label: 'test_a' }, { key: 't2', label: 'test_b' }] })
  w.tick(1000); w.call({ key: 't1', state: 'running', move_to: '../In progress' })
  w.tick(9000); w.call({ key: 't1', message_type: 'test-result', fields: { result: 'pass', duration: '4.1s' }, text: 'ok', move_to: '../Passed' })
  check('a test-result\'s duration, when given, IS the test\'s took (4.1s, not the 9s between its state changes)', w.get('t1').took === 4100 && w.get('t1').test.duration === 4100)
  w.tick(1000); w.call({ key: 't2', message_type: 'test-result', fields: { result: 'fail', duration: 2500 }, text: 'bad', move_to: '../Failed' })
  check('…and a test that never ran but reports a duration gets it (2.5s); without a duration it would get none', w.get('t2').took === 2500 && w.get('t2').started_at === null)
  w.tick(1000); w.call({ key: 'tests', state: 'failed', text: '@run failed' })
  const rt = M.timing2(w.sess(), w.get('tests'))
  check('a TEST-RUN gets its start-to-end time: its own line\'s attempt (and its plan\'s time)', w.get('tests').took === 12000 && rt.plan && rt.plan.took != null && rt.text.startsWith('took '), J(rt))
  // log:false: the checkpoint carries it; the replay rebuilds all of it
  w.tick(MIN); w.call({ key: 'quiet', label: 'Quiet', state: 'running', log: false })
  w.tick(2 * MIN); w.call({ key: 'quiet', state: 'done', log: false })
  w.tick(MIN); const cps = M.planCheckpoints2(w.st, w.at()); w.putW(cps)
  check('log:false: no entries, the node still timed (2m); its cp carries the timing', w.get('quiet').took === 120000 && cps.some(x => x.rec.n === w.get('quiet').id && x.rec.timing && x.rec.timing.took === 120000), J(cps.map(x => x.rec.timing)))
  const B = fresh(); M.replayRecords2(B, w.files, w.at() + 1, { from: 0 })
  check('REPLAY: every node\'s timing (started / ended / took / total / attempts) and the plans\' times equal the live model', dump(B, { ghosts: true, scope: true }) === dump(w.st, { ghosts: true, scope: true }), firstDiff(dump(w.st, { ghosts: true }), dump(B, { ghosts: true })))
  const day2 = new Date(w.at() + DAY); day2.setHours(0, 0, 0, 0)
  const cf = M.planCarryForward2(w.st, day2.getTime() + 30 * HOUR)
  check('a carry-forward carries it too (cf.timing)', cf.some(x => x.rec.n === a().id && x.rec.timing.took_total === 282000 && x.rec.timing.attempts === 2))
  check('fmtTook: 850ms · 4.1s · 4m 12s · 1h 3m · 2d 3h', J([850, 4100, 252000, 3780000, 183600000].map(M.fmtTook)) === J(['850ms', '4.1s', '4m 12s', '1h 3m', '2d 3h']))
})

// ================================================================= the expiry pass writes its removals
await section(() => {
  const w = world()
  w.call({ agent: 'old', label: 'Old agent', text: '@work' })
  w.tick(1000); w.call({ agent: 'old', key: 'k', label: 'K', text: 'kid' })
  w.tick(1000); w.call({ agent: 'old', text: '@done', state: 'done' })
  w.tick(1000); w.call({ agent: 'keeper', label: 'Keeper', plan: ['Open item'] })
  w.tick(1000); w.call({ agent: 'keeper', text: '@done', state: 'done' })
  w.tick(29 * HOUR)
  check('expire2: nothing before finished_visible_hours', M.expire2(w.st, w.at()).writes.length === 0)
  w.tick(2 * HOUR)
  const e = M.expire2(w.st, w.at()); w.put(e.writes)
  check('expire2: a finished agent past the window → ONE `remove` record why "expire" (its subtree goes with it, as ghosts)',
    e.records.length === 1 && e.records[0].op === 'remove' && e.records[0].why === 'expire' && e.records[0].n === e.removed[0].id && !w.get('old') && w.sess().ghosts.get(w.get('k', null) ? 'x' : e.removed[0].id).why === 'expire', J(e.records))
  check('expire2: an agent holding an OPEN plan item never expires', !!w.get('keeper'))
  const B = fresh(); M.replayRecords2(B, w.files, w.at() + 1, { from: 0 })
  check('replay: the expired agent is gone (a ghost, its kid too) exactly as live', dump(B, { ghosts: true, scope: true }) === dump(w.st, { ghosts: true, scope: true }), firstDiff(dump(w.st, { ghosts: true }), dump(B, { ghosts: true })))
  const p = M.expirePass2(w.st, w.at() + 1)
  check('expirePass2: questions + the grace sweep + expiry in one pass (nothing more due)', Array.isArray(p.writes) && p.writes.length === 0)
})

// ================================================================= carry-forward: structure, the window, log_floor, log_n
await section(() => {
  const w = world({ config: { finished_visible_hours: 30 } })
  w.call({ agent: 'a1', label: 'Agent one', text: '@long job' })
  w.tick(1000); w.call({ agent: 'a1', key: 'docs', label: 'Write the docs', text: '@drafting', progress: '1/4 pages' })
  w.tick(1000); w.call({ key: 'rel', label: 'Next release', plan: ['Spec', 'Build'] })
  w.tick(1000); w.call({ agent: 'a1', key: 'docs', move: 'rel' })
  w.tick(1000); w.call({ agent: 'a1', key: 'docs', rename: 'Write the README' })
  for (let i = 0; i < 14; i++) { w.tick(1000); w.call({ agent: 'a1', key: 'docs', text: `step ${i}` }) }
  const day2 = new Date(T0 + DAY); day2.setHours(0, 0, 0, 0)
  w.set(day2.getTime())
  const cf = M.planCarryForward2(w.st, w.at())
  w.putW(cf)
  const docs = cf.find(x => x.rec.key === 'docs')
  check('cf: carries the STRUCTURE (creator + scope, key, kind, type, label + asked, parent, rank, plan item) and the line, log_n, aliases',
    docs && docs.rec.c === w.get('a1').id && docs.rec.scope === 'a1' && docs.rec.nk === 'context' && docs.rec.label === 'Write the README' && docs.rec.p === w.get('rel').id
    && docs.rec.current.text === 'drafting' && docs.rec.progress.done === 1 && docs.rec.log_n === w.get('docs', 'a1').log.length + w.get('docs', 'a1').log_dropped && docs.rec.aliases.length === 2, J(docs))
  check('cf: parents first (the root, then the plan node, its items, the agent …); the root\'s carries the session\'s last activity',
    cf[0].rec.n === w.sess().rootId && Number.isFinite(cf[0].rec.session_last_activity) && cf.findIndex(x => x.rec.key === 'rel') < cf.findIndex(x => x.rec.key === 'docs'))
  w.tick(20 * HOUR); w.call({ agent: 'a1', key: 'docs', text: '@nearly there' })
  w.tick(10 * HOUR)
  const now = w.at(), cutoff = now - 30 * HOUR
  const B = fresh(), st = M.replayRecords2(B, w.files, now)
  const d = M.getSession2(B, BRIDGET) && M.findPath(M.getSession2(B, BRIDGET), 'Next release/Write the README')
  check('window replay: the create is outside the window — the cf restores the node whole (key, scope, label, parent, line)', st.cfs > 0 && d && d.key === 'docs' && d.scope === 'a1' && d.current.text === 'nearly there' && d.progress.done === 1, J(st))
  check('window replay: its log = the window\'s entries (older ones are only in the files): log_floor = the window start, its entry count exact (log_n)',
    d.log_floor === cutoff && d.log.length + d.log_dropped === w.get('docs', 'a1').log.length + w.get('docs', 'a1').log_dropped && d.log.every(e => e.ts >= cutoff))
  check('window replay ≡ live (logs from the window)', dump(B, { logs: cutoff }) === dump(w.st, { logs: cutoff }), firstDiff(dump(w.st, { logs: cutoff }), dump(B, { logs: cutoff })))
  check('window replay: the old alias (Next release/Write the docs) still resolves', (() => { const s = M.getSession2(B, BRIDGET); return [...s.aliases.values()].some(a => a.path === 'Next release/Write the docs' && a.id === d.id) })())
  const rp = M.createReplay2(fresh(), { now })
  const old = w.files.find(f => f.rec.ts < cutoff && M.recordKind2(f.rec) === 'entry')
  check('feed(): a record before the window answers "old" (the reader stops)', rp.feed(old.rec, old.day) === 'old' && !rp.wantsOlder(old.day))
})

// ================================================================= the FILES: day files, index files, the Dropbox rule
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-act3-'))
await section(() => {
  const dir = path.join(tmpRoot, 'p1')
  const { w } = history(4242, { days: 3, ops: 150, unlogged: 0.2 })
  const W = F.createDayWriter({ dir, host: 'ROBIN-Z790' })
  W.writeAll(w.files.map(f => f.rec))
  const hd = F.hostDir(dir, 'ROBIN-Z790')
  check('writer: files under activity/<lslug(host)>/ — one day file per local day, exact names', hd.endsWith(path.join('activity', 'robin-z790')) && J(W.days()) === J([...new Set(w.files.map(f => f.day))].sort()), J(W.days()))
  const today = W.days().at(-1)
  check('writer: today\'s index is kept in memory and equals one scan of the file', J(W.index(today)) === J(F.buildIndex(today, fs.readFileSync(F.dayFile(dir, 'ROBIN-Z790', today)))))
  const rolled = W.rollover(today)
  check('rollover: an index file for every CLOSED day (not today)', J(rolled) === J(W.days().slice(0, -1)) && rolled.every(d => fs.existsSync(F.indexFile(dir, 'ROBIN-Z790', d))) && !fs.existsSync(F.indexFile(dir, 'ROBIN-Z790', today)))
  const d0 = W.days()[0], written = F.readIndex(dir, 'ROBIN-Z790', d0)
  check('index: { v:1, day, size, sessions, nodes:{ id:[first, last, count] }, struct } — entries only in `nodes`; node records + cf structure in `struct`',
    written.v === 1 && written.day === d0 && written.size === fs.statSync(F.dayFile(dir, 'ROBIN-Z790', d0)).size && Object.values(written.nodes).every(a => a.length === 3 && a[0] <= a[1] && a[2] >= 1)
    && written.struct.some(s => s.op === 'create' && s.label && s.key) && written.sessions.some(s => s.session === 'Bridget'))
  fs.unlinkSync(F.indexFile(dir, 'ROBIN-Z790', d0))
  const re = F.ensureIndex(dir, 'ROBIN-Z790', d0)
  check('a missing index is REBUILT by one scan and equals the written one', re.rebuilt && J(re.index) === J(written))
  fs.writeFileSync(F.indexFile(dir, 'ROBIN-Z790', d0), J({ ...written, size: 1 }))
  check('an index whose size does not match its day file is rebuilt', F.ensureIndex(dir, 'ROBIN-Z790', d0).rebuilt && F.readIndex(dir, 'ROBIN-Z790', d0).size === written.size)
  check('no .tmp file is left behind (atomic writes)', !fs.readdirSync(hd).some(n => /\.tmp/.test(n)))
  // the files replay to the live model
  const recs = [...F.readBackwards(dir, 'ROBIN-Z790')]
  check('readBackwards: every record, newest first, with its day and offset', recs.length === w.files.length && recs[0].rec.ts >= recs.at(-1).rec.ts && recs.every(r => r.rec && typeof r.offset === 'number'))
  const B = fresh(), rp = M.createReplay2(B, { now: w.at() + 1, from: 0 })
  for (const r of recs) rp.feed(r.rec, r.day)
  rp.finish()
  check('the day files on disk replay to the live model (log:false 20 %: lines, bars, structure, logs)', dump(B, { activity: false, ghosts: true, scope: true }) === dump(w.st, { activity: false, ghosts: true, scope: true }), firstDiff(dump(w.st, { activity: false }), dump(B, { activity: false })))
  // paging through the index: only the byte ranges that hold the members
  const sess = w.sess(), some = [...sess.nodes.values()].filter(n => n.log.length)[0]
  const idxs = F.readIndexes(dir, 'ROBIN-Z790').concat([W.index(today)])
  const spans = F.spansOf(idxs, [some.id])
  const got = spans.flatMap(s => F.readSpan(dir, 'ROBIN-Z790', s.day, s.from, s.to)).filter(l => l.rec && l.rec.n === some.id && M.recordKind2(l.rec) === 'entry')
  const all = recs.filter(r => r.rec.n === some.id && M.recordKind2(r.rec) === 'entry')
  check('paging via the index: the spans hold exactly the node\'s entries (newest day first; other days not read)', spans.length >= 1 && got.length === all.length && got.length === spans.reduce((a, s) => a + s.count, 0), J({ spans, got: got.length, all: all.length }))
  // a repeat line is rewritten in place
  const dir2 = path.join(tmpRoot, 'p2'), W2 = F.createDayWriter({ dir: dir2, host: 'H' })
  const rep = { v: 6, rep: [1, 2], n: 1, since: T0, last: T0 }
  W2.append({ v: 6, kind: 'cp', k: 1, ts: T0, n: 'aaaaaaaaaaaaaaaa', session: 'S' })
  W2.writeAll([{ kind: 'rep', rec: rep }]); W2.writeAll([{ kind: 'rep', rewrite: true, rec: { ...rep, n: 2, last: T0 + 1 } }])
  const lines = F.readDay(dir2, 'H', A.localDay(T0))
  check('writer: a repeat line marked rewrite replaces the open one IN PLACE', lines.length === 2 && lines[1].rec.n === 2)
  W2.append({ v: 6, id: 'e1', ts: T0 + 2, n: 'aaaaaaaaaaaaaaaa', session: 'S', text: 'x', state: 'running' })
  W2.writeAll([{ kind: 'rep', rewrite: true, rec: { ...rep, n: 3, last: T0 + 3 } }])
  check('writer: once something else was written, a rewrite appends instead', F.readDay(dir2, 'H', A.localDay(T0)).length === 4)
  // a garbled tail (a crash mid-write) gets a newline before the next append
  fs.appendFileSync(F.dayFile(dir2, 'H', A.localDay(T0)), '{"v":6,"garb')
  const W3 = F.createDayWriter({ dir: dir2, host: 'H' })
  W3.append({ v: 6, id: 'e2', ts: T0 + 4, n: 'aaaaaaaaaaaaaaaa', session: 'S', text: 'y', state: 'running' })
  const l3 = F.readDay(dir2, 'H', A.localDay(T0))
  check('writer: a garbled last line (no newline) is closed first — the next record is intact, the garbled one reads null', l3.length === 6 && l3[4].rec === null && l3[5].rec.id === 'e2')
})
await section(() => {
  // THE DROPBOX RULE: two hosts in one persistence dir write only their own directory; a conflicted copy is warned, never read
  const dir = path.join(tmpRoot, 'shared')
  const A1 = F.createDayWriter({ dir, host: 'ROBIN-Z790' }), A2 = F.createDayWriter({ dir, host: 'LITTLE-001' })
  const wa = world(), wb = world()
  wa.call({ key: 'a', label: 'From Robin', text: '@x' }); wb.call({ key: 'b', label: 'From Little', text: '@y' }, KIM)
  A1.writeAll(wa.files.map(f => f.rec)); A2.writeAll(wb.files.map(f => f.rec))
  const day = A.localDay(T0)
  check('two hosts write disjoint directories (activity/robin-z790, activity/little-001)', J(fs.readdirSync(path.join(dir, 'activity')).sort()) === J(['little-001', 'robin-z790'])
    && F.readDay(dir, 'ROBIN-Z790', day).every(l => l.rec.session === 'Bridget') && F.readDay(dir, 'LITTLE-001', day).every(l => l.rec.session === 'kim-s'))
  const hd = F.hostDir(dir, 'ROBIN-Z790'), cc = `${day} (LITTLE-001's conflicted copy 2026-10-03).jsonl`
  fs.writeFileSync(path.join(hd, cc), J({ v: 6, kind: 'node', op: 'create', ts: T0, n: 'zzzzzzzzzzzzzzzz', session: 'Bridget', key: 'evil', label: 'Evil' }) + '\n')
  fs.writeFileSync(path.join(hd, `${day} (Case Conflict).idx.json`), '{}')
  fs.writeFileSync(path.join(hd, 'notes.txt'), 'hand edit')
  fs.writeFileSync(path.join(hd, `${day}.jsonl.tmp-1a2b3c4d`), 'half')
  const seen = new Set(), s1 = F.scanHostDir(dir, 'ROBIN-Z790', { seen }), s2 = F.scanHostDir(dir, 'ROBIN-Z790', { seen })
  check('scan: the conflicted copies (incl. "Case Conflict") and an unknown name are listed with a WARN each; .tmp is skipped silently',
    s1.conflicted.length === 2 && J(s1.unknown) === J(['notes.txt']) && s1.tmp.length === 1 && s1.warnings.length === 3 && s1.warnings.some(x => x.includes("conflicted copy '" + cc + "'") && x.includes('a duplicate hostname?') && x.includes('delete it by hand')), J(s1))
  check('scan: a warning is printed ONCE per name (seen); fs_warnings keeps listing them', s2.warnings.length === 0 && s2.fs_warnings.length === 3)
  check('readers take exact names only: the conflicted copy is never read (days, readBackwards, the replay)',
    J(F.days(dir, 'ROBIN-Z790')) === J([day]) && [...F.readBackwards(dir, 'ROBIN-Z790')].every(r => r.rec.n !== 'zzzzzzzzzzzzzzzz'))
  const p = A1.prune('2999-01-01')
  check('prune deletes the host\'s day files with their index files — never a conflicted copy or another host\'s files',
    J(p) === J([day]) && fs.existsSync(path.join(hd, cc)) && fs.existsSync(path.join(hd, 'notes.txt')) && F.days(dir, 'LITTLE-001').length === 1)
  fs.mkdirSync(path.join(dir, 'views'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'views', 'robin-z790.json'), '{}'); fs.writeFileSync(path.join(dir, 'views', "robin-z790 (LITTLE-001's conflicted copy).json"), '{}')
  const v = F.scanViewsDir(dir)
  check('views/: only ^[a-z0-9._-]+\\.json$ is read; a conflicted copy there is warned about', J(v.views) === J(['robin-z790.json']) && v.warnings.length === 1 && /conflicted copy/.test(v.warnings[0]))
})

// ================================================================= the GHOST table from the index files (§5.1)
await section(() => {
  const dir = path.join(tmpRoot, 'ghosts')
  const w = world()
  w.call({ key: 'tests', label: 'Tests', context_type: 'test-run', text: '@run 1' })
  w.tick(1000); w.call({ key: 't1', label: 'T1', under: 'tests', text: 'x' })
  w.tick(1000); w.call({ key: 't1', move_to: '/Tests/Passed', state: 'done' })
  w.tick(1000); w.call({ key: 't1', move_to: '/Later' })   // Passed empties: a transient ghost (key "Passed")
  const passed = w.sess().ghosts.get([...w.sess().ghosts.keys()][0])
  w.set(T0 + 3 * DAY)   // days later: the removal is far outside the replay window (the rollover's cf carries the tree)
  w.putW(M.planCarryForward2(w.st, w.at()))
  w.tick(1000); w.call({ key: 'other', label: 'Other', text: 'later work' })
  const W = F.createDayWriter({ dir, host: 'ROBIN-Z790' })
  W.writeAll(w.files.map(f => f.rec))
  W.rollover(A.localDay(w.at()))
  const B = fresh()
  const recs = [...F.readBackwards(dir, 'ROBIN-Z790')], rp = M.createReplay2(B, { now: w.at() + 1 })
  for (const r of recs) if (rp.feed(r.rec, r.day) === 'old' && !rp.wantsOlder(r.day)) break
  rp.finish()
  const sb = M.getSession2(B, BRIDGET)
  check('harness: the window replay alone does not know the ghost (removed before the window)', passed && passed.label === 'Passed' && !sb.ghosts.has(passed.id))
  const g = M.rebuildGhosts2(B, F.readIndexes(dir, 'ROBIN-Z790'))
  const gb = sb.ghosts.get(passed.id)
  check('rebuildGhosts2: the index files\' struct brings the ghost back — its key, creator, label, kind, last parent, why — and its key stays held',
    g.added >= 1 && gb && gb.key === passed.key && gb.label === 'Passed' && gb.kind === 'context' && gb.parent === passed.parent && gb.why === 'transient' && sb.scope.get(gb.creator + '\n' + gb.key.toLowerCase()) === passed.id, J(gb))
  check('rebuildGhosts2: last_ts = the start of the newest retained day holding one of its entries', gb.last_ts === new Date(new Date(T0).setHours(0, 0, 0, 0)).getTime())
  const r = M.applyCall(B, BRIDGET, { key: 't1', move_to: '/Tests/Passed' }, w.at() + 2)
  check('after the rebuild, a move into the vanished bucket RESURRECTS the same id as a new run (§3.8)', r.ok && r.records.some(x => x.op === 'create' && x.n === passed.id && x.runs === 2), J(r.records))
  const B2 = fresh(); M.replayRecords2(B2, recs.slice().reverse(), w.at() + 1); M.rebuildGhosts2(B2, F.readIndexes(dir, 'ROBIN-Z790'))
  const dropped = M.pruneGhosts(B2, new Date(new Date(T0 + DAY).setHours(0, 0, 0, 0)).getTime())
  check('pruneGhosts: a rebuilt ghost leaves once retention drops the day of its last entry', dropped.includes(passed.id) && !M.getSession2(B2, BRIDGET).ghosts.has(passed.id))
})
try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
