// Fast UNIT tests for #88 (v2.0) build step 4 — the CONVERSION LIBRARY (lib/activity2-convert.js; docs/spec-88.md §7.3, §8
// step 4): 1.7x history (written here by a FROZEN copy of the last 1.7x library, tests/fixtures/activity-v175.js) converted
// into v6 records, then (a) the 1.7x library's OWN replay of the original days and (b) the 2.0 replay of the converted days
// must give the same board — paths ↔ ids, labels, lines, states, bars, plans, ranks, questions, logs, counts, activity,
// sibling order, removals; the converter's own model must equal the replay of what it wrote; converting twice gives the
// same bytes; ids are legacy ids of the FINAL path (earlier runs share it, overlapping ones don't); the agent / context
// duplicate is relabelled; time (took) is derived; and the files (a directory in, another out, index files, the Dropbox
// rule: conflicted copies warned about, never read). A seeded CONVERSION FUZZ drives random 1.7x histories (reports, plans,
// ticks, moves, placements, dashboard actions, questions, expiry, restarts, day rollovers with cf). Temp dirs only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { testOnly } from '../helpers/check.mjs'
import * as V from '../fixtures/activity-v175.js'
import * as M from '../../lib/activity2.js'
import * as C from '../../lib/activity2-convert.js'
import * as F from '../../lib/activity2-files.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.stack} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
async function section(fn) { try { await fn() } catch (e) { fail++; console.log('FAIL section crashed:', (e && e.stack) || e) } }
const HOST = 'ROBIN-Z790'
const ALPHA = { session: 'Alpha', project: 'AIMB', user: 'robin' }
const BETA = { session: 'Beta', project: 'Marz', user: 'kim' }
const DASH = { kind: 'dashboard', user: 'robin', host: HOST }
const MIN = 60000, HOUR = 3600000, DAY = 86400000
const T0 = new Date(2026, 9, 1, 9, 0, 0).getTime()   // a LOCAL morning: day files are per local day
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const lineAddr = n => (!n.path ? '@~root' : n.kind === 'context' ? n.path.replace(/@(?=[^/]*$)/, '@~') : n.path + '/@~root')

// ---- the 1.7x side: a live 1.7x state writing its day files as the gateway does (entries, cp / rep every 5 min, its gc pass
// (expire) before each record, a cf at each local day rollover, a restart = a replay of the files so far + the cf the gateway writes when today has none)
function history(o = {}) {
  const cfg = { log_entries_per_agent: o.cap || 8, ...(o.config || {}) }
  let st = V.createActivity({ origin: HOST, config: cfg })
  const days = new Map()
  const put = (rec, day = V.localDay(rec.ts)) => { let a = days.get(day); if (!a) days.set(day, a = []); a.push(JSON.parse(J(rec))) }
  const putW = ws => { for (const w of ws) { const rec = JSON.parse(J(w.rec)), day = V.localDay(Array.isArray(rec.rep) ? rec.last : rec.ts), a = days.get(day); if (w.rewrite && a && a.length && Array.isArray(a[a.length - 1].rep)) a[a.length - 1] = rec; else put(rec, day) } }
  let t = o.t0 || T0, lastDay = V.localDay(t), nextCp = t + 5 * MIN, nextGc = t + MIN
  const flat = () => [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1)).flatMap(([, recs]) => recs)
  const h = {
    cfg, get st() { return st }, at: () => t,
    tick(ms) {
      t += ms
      // the gateway's timers in time order: a checkpoint every 5 min, its gc pass (expire) every minute
      while (nextCp <= t || nextGc <= t) { if (nextGc <= nextCp) { V.expire(st, nextGc); nextGc += MIN } else { putW(V.planCheckpoints(st, nextCp)); nextCp += 5 * MIN } }
      const d = V.localDay(t)
      if (d !== lastDay) { lastDay = d; putW(V.planCarryForward(st, t)) }
    },
    say(ident, input) { const p = V.parseMessage(input, { now: t, tzOffsetMin: 0 }); if (!p.ok) return p; const r = V.apply(st, ident, p.msg, t); if (r.ok) for (const x of r.records) put(x); return r },
    act(ident, p, action, args = {}) { const r = V.applyAction(st, { ...ident, path: p, action, args }, t, { by: DASH }); if (r.ok) for (const x of r.records) put(x); return r },
    expire() { return V.expire(st, t) },
    expireQ() { const r = V.expireQuestions(st, t); for (const x of r.records) put(x); return r },
    stop() { putW(V.flushCheckpoints(st, t, { withRep: true })) },   // a clean stop (the migration runbook stops every bridge first)
    restart() { const B = V.createActivity({ origin: HOST, config: cfg }); const s = V.replayNewestFirst(B, flat().slice().reverse(), t); st = B; nextCp = t + 5 * MIN; if (!s.cf_today) putW(V.planCarryForward(st, t)) },
    flat, days: () => [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, records]) => ({ day, records: records.map(r => JSON.parse(J(r))) })),
  }
  return h
}
/** The 1.7x board a restart at `now` rebuilds (its own replay of the files). */
function replay17(h, now, days = h.days()) { const A = V.createActivity({ origin: HOST, config: h.cfg }); V.replayNewestFirst(A, days.flatMap(d => d.records).reverse(), now); return A }
/** The 2.0 board a 2.0 bridge starting at `now` rebuilds from the converted days (its replay + its first expiry pass;
 * o.expire:false leaves the pass out). */
function replay20(conv, cfg, now, o = {}) {
  const B = M.createModel({ origin: HOST, config: cfg })
  M.replayRecords2(B, conv.days.flatMap(d => d.records.map(rec => ({ rec, day: d.day }))), now, o)
  if (o.expire !== false) M.expire2(B, now)
  return B
}

// ---- compare a 1.7x board (A) with a 2.0 board (B) through the converter's final path map: every 1.7x node must be there as
// itself (and nothing else), with the same everything. o.activity:false skips last_activity / stale_after_ms; o.logs: false
// skips the log contents (counts too); o.window: entries older than it are not compared (a windowed replay)
const lineOf = c => (c ? { id: c.id, ts: c.ts, text: c.text, state: c.state, details: c.details || null, data: c.data != null ? c.data : null, by: c.by || null, question: c.question || null } : null)
const barOf = b => (b ? { done: b.done, skipped: b.skipped || 0, total: b.total, unit: b.unit || '', pct: Math.round((b.pct || 0) * 1000) } : null)
const eKey = e => `${e.id}|${e.ts}|${!!e.current}|${e.text}|${e.state}`
const ord = (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
function compare(A, B, paths, o = {}) {
  const diffs = []
  const d = (what, a, b) => { if (diffs.length < 8) diffs.push(`${what}: 1.7x ${J(a)} vs 2.0 ${J(b)}`) }
  const seenSess = new Set()
  for (const sA of A.local.values()) {
    const sk = V.sessionKey({ realm: sA.realm, project: sA.project, user: sA.user, session: sA.session, host: HOST }), sB = B.sessions.get(sk), pm = paths[sk] || {}
    seenSess.add(sk)
    if (!sB) { d(`session ${sA.session}`, 'present', 'missing'); continue }
    if (sA.created_at !== sB.created_at) d(`${sA.session} created_at`, sA.created_at, sB.created_at)
    if (o.activity !== false && sA.last_activity !== sB.last_activity) d(`${sA.session} last_activity`, sA.last_activity, sB.last_activity)
    const idOf = k => (k === '' ? sB.rootId : pm[k])
    let count = 0
    for (const n of sA.nodes.values()) {
      const id = idOf(n.key), x = id && sB.nodes.get(id), w = `${sA.session}:${n.path || '(root)'}`
      if (!x && o.forgettable && n.key && n.implicit && !n.current && !V.childrenOf(sA, n).length) continue   // nothing the files hold names it (a restart forgets it too)
      if (!x) { d(w, 'present', `missing (${id})`); continue }
      if (n.key) count++
      if (n.key) {
        if (x.kind !== n.kind) d(`${w} kind`, n.kind, x.kind)
        if (x.label !== n.name && x.asked !== n.name && !(x.label.startsWith(n.name + ' (') && /\(\d+\)$/.test(x.label))) d(`${w} label`, n.name, x.label)
        if (x.parent !== idOf(n.parent)) d(`${w} parent`, n.parent, x.parent)
        if (o.created !== false && x.created_at !== n.created_at) d(`${w} created_at`, n.created_at, x.created_at)
        if (!!x.plan !== !!n.plan || (n.plan && (x.plan_ix ?? null) !== (n.plan_ix ?? null))) d(`${w} plan`, [n.plan, n.plan_ix], [x.plan, x.plan_ix])
        if ((x.rank || null) !== (n.rank || null)) d(`${w} rank`, n.rank, x.rank)
        // a question is type question (one that ever holds children converts as a context: its line keeps the question)
        if ((x.type === 'question') !== V.isQuestion(n)) d(`${w} type`, V.isQuestion(n), x.type)
      }
      if (J(lineOf(n.current)) !== J(lineOf(x.current))) d(`${w} line`, lineOf(n.current), lineOf(x.current))
      if (J(n.progress || null) !== J(x.progress || null)) d(`${w} progress`, n.progress, x.progress)
      if ((n.eta_at || null) !== (x.eta_at || null)) d(`${w} eta`, n.eta_at, x.eta_at)
      if (n.kind === 'agent' && (n.finished_at || null) !== (x.finished_at || null)) d(`${w} finished_at`, n.finished_at, x.finished_at)
      if (n.kind === 'agent' && J(n.plan_end || null) !== J(x.plan_end || null)) d(`${w} plan_end`, n.plan_end, x.plan_end)
      if (o.implicit !== false && !!n.implicit !== !!x.implicit) d(`${w} implicit`, n.implicit, x.implicit)
      if (o.activity !== false && n.last_activity !== x.last_activity) d(`${w} last_activity`, n.last_activity, x.last_activity)
      if (o.activity !== false && (n.stale_after_ms || null) !== (x.stale_after_ms || null)) d(`${w} stale_after_ms`, n.stale_after_ms, x.stale_after_ms)
      if (!V.isQuestion(n) && J(barOf(V.rollup(sA, n))) !== J(barOf(M.bar2(sB, x)))) d(`${w} bar`, barOf(V.rollup(sA, n)), barOf(M.bar2(sB, x)))
      const kA = V.childrenOf(sA, n).sort(V.siblingCmp).map(c => idOf(c.key)).filter(id => !o.forgettable || (id && sB.nodes.has(id))), kB = M.childrenOf2(sB, x).map(c => c.id)
      if (o.order !== false && J(kA) !== J(kB)) d(`${w} children (in order)`, V.childrenOf(sA, n).sort(V.siblingCmp).map(c => c.name), M.childrenOf2(sB, x).map(c => c.label))
      if (o.logs !== false) {
        const cut = o.window || -Infinity
        const lA = n.log.filter(e => e.ts >= cut).slice().sort(ord).map(eKey), lB = x.log.filter(e => e.ts >= cut).slice().sort(ord).map(eKey)
        if (J(lA) !== J(lB)) d(`${w} log`, lA.slice(-4), lB.slice(-4))
        if (o.counts !== false && n.log.length + n.log_dropped !== x.log.length + x.log_dropped) d(`${w} log count`, n.log.length + n.log_dropped, x.log.length + x.log_dropped)
      }
    }
    if (count !== sB.nodes.size - 1) d(`${sA.session} node count`, count, sB.nodes.size - 1)
  }
  for (const [k, s] of B.sessions) if (!seenSess.has(k)) d(`session ${s.ident.session}`, 'absent', `present (${s.nodes.size} nodes)`)
  return diffs
}

// ---- a whole 2.0 model as text (every node field, the indexes, aliases, ghosts) — the converter's model vs the replay
function dump(st) {
  const sorted = m => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out = []
  for (const [k, s] of sorted(st.sessions)) {
    const nodes = sorted(s.nodes).map(([, n]) => { const x = { ...n }; delete x.cp_dirty; delete x.cp_sig; delete x.log_floor; return x })
    out.push({ k, ident: s.ident, created_at: s.created_at, last_activity: s.last_activity, rootId: s.rootId, nodes, kids: sorted(s.kids).map(([p, ids]) => [p, [...ids].sort()]).filter(([, ids]) => ids.length),
      labels: sorted(s.labels), scope: sorted(s.scope), aliases: sorted(s.aliases), ghosts: sorted(s.ghosts), gkids: sorted(s.gkids).map(([p, ids]) => [p, [...ids].sort()]).filter(([, ids]) => ids.length) })
  }
  return J(out)
}
function firstDiff(a, b) { if (a === b) return ''; let i = 0; while (i < a.length && a[i] === b[i]) i++; return `@${i}: …${a.slice(Math.max(0, i - 200), i + 120)}\n  vs …${b.slice(Math.max(0, i - 200), i + 120)}` }

// ---- random 1.7x histories (seeded)
const SAY_PATHS = ['@P/@~a', '@Q/@~b', 'w1/@~root', 'w1/@R/@~c', '@P/@sub/@~d', 'w2/@~root', '@~P', 'w2/@x/@~y', '@~root', 'w2/sub/@~root', '@P/@a', 'w1', '@Q/@"x y"/@~z',
  'w1/@x', 'w3/@~root', 'w3/deep/@~root', '@#88/spec-88/@~root', '@#88/spec-88/@docs/@~e']
const PLAN_PATHS = ['@P', '@Q', 'w1/@R', '@P/@sub', 'w2', '@#88', 'w3']
function genHistory(seed, n, o = {}) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)]
  const h = history(o)
  const idents = o.idents || [ALPHA, BETA]
  const stats = { moves: 0, asks: 0, closed: 0, actions: 0, restarts: 0, expiries: 0, plans: 0 }
  for (let i = 0; i < n; i++) {
    h.tick(1000 + Math.floor(r() * (o.gap || 60000)) + (o.jump && r() < o.jump ? Math.floor(r() * (o.jumpMs || 30 * HOUR)) : 0))
    const id = pick(idents), s = V.getSession(h.st, id)
    const nodes = s ? [...s.nodes.values()].filter(x => x.key) : []
    const ctxs = nodes.filter(x => x.kind === 'context' && !V.isQuestion(x)), items = nodes.filter(x => x.plan), open = nodes.filter(x => V.isOpenQuestion(x))
    const x = r()
    if (x < 0.06) { const res = h.say(id, { path: pick(PLAN_PATHS), plan: [`i${i}`, pick(['a', 'b', 'c', 'd'])], ...(r() < 0.3 ? { position: pick(['first', 'last']) } : {}) }); if (res.ok) stats.plans++ }
    else if (x < 0.16 && items.length) { const it = pick(items); h.say(id, { path: lineAddr(it), state: pick(['done', 'done', 'running', 'skipped', 'todo', 'blocked']), ...(r() < 0.4 ? { text: `t${i}` } : {}) }) }
    else if (x < 0.21 && nodes.length && !o.noMoves) {   // the session's own move
      const nd = pick(nodes), tg = pick([...ctxs.map(c => '/' + c.path), '/', '/@fresh' + (i % 5), '/w1'])
      const res = h.say(id, { move: '/' + nd.path, to: tg, ...(r() < 0.3 ? { position: pick(['first', 'last']) } : {}) }); if (res.ok && res.moved) stats.moves++
    } else if (x < 0.24 && nodes.length) h.say(id, { path: pick(nodes).path || '', position: pick(['first', 'last']) })
    else if (x < 0.33 && nodes.length) {   // a dashboard action
      const nd = pick(nodes), act = pick([...(o.noMoves ? [] : ['move']), 'reorder', 'abandon', 'done', 'skip', 'reopen', 'dismiss', 'finish', 'abandon_plan', 'complete', 'reopen_plan', 'edit_text', 'message'])
      const args = act === 'move' ? { to: r() < 0.3 ? '' : (pick(ctxs) || { path: '' }).path } : act === 'reorder' ? { position: pick(['first', 'last']) } : act === 'finish' ? { state: pick(['done', 'failed']), stale_min: 1 }
        : act === 'edit_text' ? { text: `edited ${i}`, ...(r() < 0.3 ? { state: 'blocked' } : {}) } : act === 'message' ? { text: `hello ${i}` } : { stale_min: 1 }
      const res = h.act(id, nd.path, act, args); if (res.ok) { stats.actions++; if (act === 'move') stats.moves++ }
    } else if (x < 0.39) {   // an ask: on an agent / the session (a ?N child) or a leaf nothing is ever reported under (a question
      // that later holds children follows 2.0's rules after the cutover: its own unit case)
      const res = h.say(id, { path: pick(['w1', 'w3', '@Asks/@q' + i, '', '@Asks/@q' + (i % 7), 'w2']), ask: `q${i}?`, ...(r() < 0.5 ? { choices: ['A', 'B'] } : {}), ...(r() < 0.3 ? { free: true } : {}), ...(r() < 0.3 ? { expires: `${1 + Math.floor(r() * 20)}m` } : {}) }); if (res.ok) stats.asks++ }
    else if (x < 0.44 && open.length) {
      const q = pick(open), qq = q.current.question, y = r()
      const res = y < 0.5 ? h.act(id, q.path, 'answer', qq.choices.length ? { choice: pick(qq.choices) } : { text: `ans ${i}` }) : y < 0.75 ? h.say(id, { path: q.path, state: 'withdrawn', text: `nvm ${i}` }) : h.act(id, q.path, 'withdraw')
      if (res.ok) stats.closed++
    } else if (x < 0.45) { const ans = nodes.filter(m => V.isQuestion(m) && m.current.question.status === 'answered'); if (ans.length) { const q = pick(ans), qq = q.current.question; h.act(id, q.path, 'change_answer', qq.choices.length ? { choice: pick(qq.choices) } : { text: `again ${i}` }) } }
    else if (x < 0.47) { const e = h.expireQ(); stats.closed += e.expired.length }
    else if (x < 0.49) { if (h.expire().length) stats.expiries++ }
    else if (x < 0.50 && o.restarts) { h.restart(); stats.restarts++ }
    else if (x < 0.53 && ctxs.length) h.say(id, { path: lineAddr(pick(ctxs)), state: 'abandoned', ...(r() < 0.5 ? { text: `gave up ${i}` } : {}) })
    else {   // a report (a line or a plain log entry)
      const input = { path: pick(SAY_PATHS), text: `m${i}${r() < 0.2 ? ' {progress}' : ''}` }
      if (r() < 0.3) input.state = pick(['running', 'blocked', 'failed', 'done', 'idle'])
      if (r() < 0.25) input.progress = r() < 0.15 ? 'none' : `${Math.floor(r() * 50)}/${50 + Math.floor(r() * 50)} ${pick(['tiles', 'files', ''])}`
      if (r() < 0.15) input.eta = r() < 0.2 ? 'none' : `${1 + Math.floor(r() * 90)}m`
      if (r() < 0.1) input.stale_after = `${5 + Math.floor(r() * 120)}m`
      if (r() < 0.1) input.details = `details ${i}`
      if (r() < 0.1) input.data = { i, v: [i, 'x'] }
      if (o.unlogged && r() < o.unlogged) input.log = false
      h.say(id, input)
    }
  }
  h.tick(1000); h.say(idents[0], { path: '@~root', text: 'the last record before the stop' })   // (so no gc pass ran after the last record)
  h.stop()
  return { h, stats }
}

// ===============================================================================================================
await section(async () => {
  // ---- a small hand-made history: the records the conversion writes
  const h = history()
  h.say(ALPHA, { path: '@"Next release"/@WIP/spec-88/@~root', text: 'writing the spec', state: 'running', stale_after: '30m' })
  h.tick(MIN)
  h.say(ALPHA, { path: '@"Next release"/@WIP/spec-88', plan: ['Read', 'Design'] })
  h.tick(MIN)
  h.say(ALPHA, { path: '@"Next release"/@WIP/spec-88/@~Read', state: 'running', text: 'reading' })
  h.tick(5 * MIN)
  h.say(ALPHA, { path: '@"Next release"/@WIP/spec-88/@~Read', state: 'done' })
  h.tick(MIN)
  h.act(ALPHA, '@"Next release"/@WIP/spec-88/@Design', 'move', { to: '@"Next release"' })
  h.tick(MIN)
  h.say(ALPHA, { path: '@Questions', ask: 'Which database?', choices: ['Postgres', 'SQLite'] })
  h.tick(MIN)
  h.act(ALPHA, '@Questions', 'answer', { choice: 'SQLite' })
  h.tick(MIN)
  h.say(ALPHA, { path: '@"Next release"/@WIP/spec-88/@~root', text: 'done', state: 'done' })
  const days = h.days(), conv = C.convertV5(days, { host: HOST, config: h.cfg })
  const recs = conv.days.flatMap(d => d.records)
  const pm = conv.paths[V.sessionKey({ ...ALPHA, host: HOST })]
  const sess = conv.model.sessions.get(V.sessionKey({ ...ALPHA, host: HOST }))
  check('convertV5: one v6 day per v5 day; every record is v6 (recordKind2) and every v5 entry is there with its id', conv.days.length === days.length && recs.every(r => M.recordKind2(r))
    && days.flatMap(d => d.records).filter(r => V.recordKind(r) === 'entry').every(e => recs.some(x => x.id === e.id && M.recordKind2(x) === 'entry')), J(recs.filter(r => !M.recordKind2(r)).slice(0, 2)))
  const spec = pm && pm['@"next release"/@wip/spec-88'], read = pm && pm['@"next release"/@wip/spec-88/@read'], design = pm && pm['@"next release"/@design']
  check('ids: legacy ids of the FINAL v5 path; the root keeps its minted id', spec === V.legacyId({ ...ALPHA, host: HOST }, '@"next release"/@wip/spec-88') && design === V.legacyId({ ...ALPHA, host: HOST }, '@"next release"/@design')
    && sess.rootId === V.mintId({ ...ALPHA, host: HOST }, '', ''), J(pm))
  const cr = id => recs.find(r => r.kind === 'node' && r.op === 'create' && r.n === id)
  check('create records: an agent keyed by its segment (creator = its owner then: the session), a context by slug(label) in its owner\'s scope (the agent), intermediates implicit',
    cr(spec) && cr(spec).key === 'spec-88' && cr(spec).nk === 'agent' && cr(spec).c === sess.rootId && cr(spec).scope === '' && cr(spec).run === true
    && cr(read) && cr(read).key === 'Read' && cr(read).c === spec && cr(read).scope === 'spec-88' && cr(read).plan_item === true && cr(read).plan_ix === 0
    && cr(pm['@"next release"']).implicit === true && cr(pm['@"next release"']).label === 'Next release' && cr(pm['@"next release"']).key === 'Next-release', J([cr(spec), cr(read)]))
  const mv = recs.find(r => r.kind === 'node' && r.op === 'move' && r.n === design)
  const mvE = recs.find(r => r.n === design && r.act === 'move' && M.recordKind2(r) === 'entry')
  check('a move: a `move` record (new parent, was = the old display path, by / act of the dashboard), its entry (a note with act move, as 1.7x applied it) at the new path', mv && mv.p === pm['@"next release"'] && mv.was === 'Next release/WIP/spec-88/Design'
    && J(mv.by) === J(DASH) && mvE && mvE.type === 'note' && mvE.act === 'move' && mvE.at === 'Next release/Design', J([mv, mvE]))
  const q = pm['@questions'], qE = recs.filter(r => r.n === q && M.recordKind2(r) === 'entry')
  check('a question: created as type question; its ask a `question` entry (choices), its answer an `answer` entry (choice) keeping the line id',
    cr(q) && cr(q).type === 'question' && qE.length === 2 && qE[0].type === 'question' && J(qE[0].fields) === J({ choices: ['Postgres', 'SQLite'], free: false }) && qE[1].type === 'answer' && qE[1].fields.choice === 'SQLite' && qE[1].line_id === qE[0].id, J(qE))
  const done = recs.find(r => r.n === read && r.state === 'done' && M.recordKind2(r) === 'entry')
  check('TIME: the entry that ends an attempt carries took (running 5 min → done)', done && done.took === 5 * MIN && sess.nodes.get(read).took === 5 * MIN, J(done))
  const A = replay17(h, h.at() + MIN), B = replay20(conv, h.cfg, h.at() + MIN)
  const df = compare(A, B, conv.paths)
  check('the 2.0 replay of the converted days = the 1.7x replay of the original ones (hand-made history)', !df.length, df.join('\n  '))
})

const convert = (h, o = {}) => C.convertV5(h.days(), { host: HOST, config: h.cfg, ...o })
const recsOf = conv => conv.days.flatMap(d => d.records)
const node2 = (conv, ident, v5key) => { const sk = V.sessionKey({ ...ident, host: HOST }), s = conv.model.sessions.get(sk), id = conv.paths[sk] && conv.paths[sk][v5key]; return s && id ? s.nodes.get(id) || null : null }
/** 1.7x's LIVE board (its gc pass at `now`, as the stop before the migration leaves it) vs the 2.0 bridge's start (replay +
 * its first expiry pass) — the one comparison the cutover is about. */
const boardsEqual = (h, conv, o = {}) => { const now = h.at() + MIN, B = replay20(conv, h.cfg, now); V.expire(h.st, now); return compare(h.st, B, conv.paths, o) }

await section(async () => {
  // ---- removals: EVICTION (1.7x's `evicted` on the record that made room), DISMISSAL (its entry on the parent + remove), a
  // dismissed path used again (a new RUN of the same id), the whole session dismissed
  const h = history()
  for (let i = 0; i < 128; i++) { h.say(ALPHA, { path: `w${i}/@~root`, text: `a${i}`, state: 'running' }); h.tick(1000) }
  h.say(ALPHA, { path: 'w0/@~root', text: 'finished', state: 'done' }); h.tick(MIN)
  const ev = h.say(ALPHA, { path: 'w128/@~root', text: 'one too many', state: 'running' }); h.tick(MIN)
  h.say(ALPHA, { path: 'w5/@~root', text: 'done too', state: 'done' }); h.tick(MIN)
  const dm = h.act(ALPHA, 'w5', 'dismiss', { stale_min: 1 }); h.tick(MIN)
  h.say(ALPHA, { path: 'w5/@~root', text: 'back again', state: 'running' }); h.tick(MIN)
  h.say(BETA, { path: 'x/@~root', text: 'beta', state: 'done' }); h.tick(MIN)
  const dms = h.act(BETA, '', 'dismiss', { stale_min: 1 }); h.tick(MIN)
  const conv = convert(h), recs = recsOf(conv), sk = V.sessionKey({ ...ALPHA, host: HOST }), sess = conv.model.sessions.get(sk)
  const w0id = V.legacyId({ ...ALPHA, host: HOST }, 'w0'), w5id = conv.paths[sk].w5
  const rmEvict = recs.find(r => r.kind === 'node' && r.op === 'remove' && r.n === w0id)
  check('eviction: 1.7x evicted the finished w0 for w128 → a `remove` why evict (was its path) before w128\'s create', ev.ok && J(ev.evicted) === J(['w0']) && rmEvict && rmEvict.why === 'evict' && rmEvict.was === 'w0'
    && recs.indexOf(rmEvict) < recs.findIndex(r => r.op === 'create' && r.key === 'w128') && sess.ghosts.has(w0id) && !sess.nodes.has(w0id), J(rmEvict))
  const de = recs.find(r => r.dismiss === true && r.of === w5id), dr = recs.find(r => r.op === 'remove' && r.n === w5id && r.why === 'dismiss')
  check('dismissal: its entry on the PARENT (type event, dismiss, of = the removed id, at = the parent\'s path) then `remove` why dismiss', dm.ok && de && de.n === sess.rootId && de.type === 'event' && de.at === '' && dr && recs.indexOf(de) < recs.indexOf(dr), J([de, dr]))
  const cr5 = recs.filter(r => r.op === 'create' && r.n === w5id)
  check('a dismissed path used again: a NEW RUN of the same id (its final path) — a second `create`, runs 2, same key and creator', cr5.length === 2 && cr5[1].runs === 2 && cr5[1].key === 'w5' && cr5[1].c === cr5[0].c && sess.nodes.get(w5id).runs === 2 && sess.nodes.get(w5id).current.text === 'back again', J(cr5))
  const bk = V.sessionKey({ ...BETA, host: HOST }), broot = V.mintId({ ...BETA, host: HOST }, '', '')
  const rsd = recs.find(r => r.op === 'remove' && r.n === broot)
  check('the session dismissed: its entry on the root itself, then the root\'s `remove` (the whole session leaves)', dms.ok && rsd && rsd.why === 'dismiss' && recs.some(r => r.dismiss === true && r.n === broot && r.of === broot) && !conv.model.sessions.has(bk), J(rsd))
  const df = boardsEqual(h, conv)
  check('… and the 2.0 board = the 1.7x board after all of it', !df.length, df.join('\n  '))
})

await section(async () => {
  // ---- labels (the one duplicate 1.7x allowed: an agent `x` beside a context `@x`), keys, questions' keys, overlapping runs
  const h = history()
  h.say(ALPHA, { path: '@Work/x/@~root', text: 'the agent x', state: 'running' }); h.tick(MIN)
  h.say(ALPHA, { path: '@Work/@x/@~root', text: 'the context x' }); h.tick(MIN)
  h.say(ALPHA, { path: 'w1/@A/sub/@~root', text: 'sub under A' }); h.tick(MIN)
  h.say(ALPHA, { path: 'w1/@B/sub/@~root', text: 'sub under B' }); h.tick(MIN)
  h.say(ALPHA, { path: 'fix-79:docs/@~root', text: 'a colon in a 1.7x agent name' }); h.tick(MIN)
  h.say(ALPHA, { path: '@"Next release"/@"Write the docs"/@~root', text: 'spaces' }); h.tick(MIN)
  h.say(ALPHA, { path: '@Asks/@q', ask: 'Which one?', choices: ['a', 'b'] }); h.tick(MIN)
  h.say(ALPHA, { path: '@Asks/@r', text: 'a plain log entry: @r has no line' }); h.tick(MIN)
  h.say(ALPHA, { path: '@Asks/@r', ask: 'And here?' }); h.tick(MIN)
  h.say(ALPHA, { path: 'w1', ask: 'On the agent?' }); h.tick(MIN)
  h.say(ALPHA, { path: 'w1/@A', ask: 'On a node with children?' }); h.tick(MIN)
  // overlapping lifetimes on one final path: P moves onto the path Q held before Q was dismissed
  h.say(ALPHA, { path: 'p1/@~root', text: 'P', state: 'done' }); h.tick(MIN)
  h.say(ALPHA, { path: '@Box/p1/@~root', text: 'Q (another p1)', state: 'done' }); h.tick(MIN)
  h.act(ALPHA, '@Box/p1', 'dismiss', { stale_min: 1 }); h.tick(MIN)
  h.say(ALPHA, { move: '/p1', to: '/@Box' }); h.tick(MIN)
  // a move onto a same-label sibling: the YOUNGER of the two is relabelled
  h.say(ALPHA, { path: '@Old/@y/@~root', text: 'older context y' }); h.tick(MIN)
  h.say(ALPHA, { path: '@Dest/y/@~root', text: 'younger agent y' }); h.tick(MIN)
  h.say(ALPHA, { move: '/@Old/@y', to: '/@Dest' }); h.tick(MIN)
  const conv = convert(h), recs = recsOf(conv)
  const ax = node2(conv, ALPHA, '@work/x'), cx = node2(conv, ALPHA, '@work/@x')
  check('labels: an agent x and a context @x under one parent — the younger (the context) gets "x (2)", asked "x"; reported', ax && cx && ax.label === 'x' && cx.label === 'x (2)' && cx.asked === 'x'
    && conv.report.relabelled.some(r => r.label === 'x' && r.got === 'x (2)'), J([ax && ax.label, cx && cx.label, conv.report.relabelled]))
  const sa = node2(conv, ALPHA, 'w1/@a/sub'), sb = node2(conv, ALPHA, 'w1/@b/sub'), w1 = node2(conv, ALPHA, 'w1')
  check('keys: two agents named sub under one owner (w1) → sub and sub-2 in w1\'s scope; the label stays sub', sa && sb && sa.key === 'sub' && sb.key === 'sub-2' && sa.creator === w1.id && sb.creator === w1.id && sb.label === 'sub' && sb.chain === 'w1/sub-2', J([sa && sa.key, sb && sb.key]))
  const fx = node2(conv, ALPHA, 'fix-79:docs'), wd = node2(conv, ALPHA, '@"next release"/@"write the docs"')
  check('keys: a 1.7x agent name with ":" is slugged (reported); a context\'s key is slug(label)', fx && fx.key === 'fix-79docs' && fx.label === 'fix-79:docs' && conv.report.keyed.some(k => k.name === 'fix-79:docs' && k.key === 'fix-79docs')
    && wd && wd.key === 'Write-the-docs' && wd.label === 'Write the docs', J([fx && fx.key, wd && wd.key]))
  const q1 = node2(conv, ALPHA, '@asks/@q'), q2 = node2(conv, ALPHA, '@asks/@r'), q3 = node2(conv, ALPHA, 'w1/@?1'), q4 = node2(conv, ALPHA, 'w1/@a/@?1')
  check('questions: a new context asked on is created a question; a line-less one becomes one (a `type` record)', q1 && q1.type === 'question' && q1.current.question.status === 'asked' && recs.some(r => r.op === 'create' && r.n === q1.id && r.type === 'question')
    && q2 && q2.type === 'question' && recs.some(r => r.op === 'type' && r.n === q2.id && r.type === 'question'), J([q1 && q1.type, q2 && q2.type]))
  check('questions: 1.7x\'s @?N children keep the key ?N in their owner\'s scope (the next free ?M on a clash; the label stays)', q3 && q3.key === '?1' && q3.label === '?1' && q3.creator === w1.id && q4 && q4.key === '?2' && q4.label === '?1' && q4.creator === w1.id, J([q3 && q3.key, q4 && q4.key]))
  const pP = node2(conv, ALPHA, '@box/p1'), runsOn = recs.filter(r => r.op === 'create' && r.label === 'p1').map(r => r.n)
  check('ids: two runs whose lifetimes overlap on one final path get two ids — the one there at the end the plain legacy id', pP && pP.id === V.legacyId({ ...ALPHA, host: HOST }, '@box/p1') && new Set(runsOn).size === 2
    && recs.some(r => r.op === 'remove' && r.why === 'dismiss' && r.n !== pP.id && runsOn.includes(r.n)), J(runsOn))
  const oy = node2(conv, ALPHA, '@dest/@y'), ay = node2(conv, ALPHA, '@dest/y')
  check('a move onto a same-label sibling: the younger (the agent already there) is relabelled "y (2)" (a `label` record), the moved one keeps "y"', oy && ay && oy.label === 'y' && ay.label === 'y (2)'
    && recs.some(r => r.op === 'label' && r.n === ay.id && r.label === 'y (2)'), J([oy && oy.label, ay && ay.label]))
  const df = boardsEqual(h, conv)
  check('… and the 2.0 board = the 1.7x board', !df.length, df.join('\n  '))
})

await section(async () => {
  // ---- TIME from a log:false change (the cp's `timing`), a question asked on a node that later gets children (converted as a
  // context: 2.0's question holds none), FORGETTING (an empty grouping node no record names within the window)
  const h = history({ config: { finished_visible_hours: 24 } })
  h.say(ALPHA, { path: '@T/@~a', text: 'start', state: 'running' }); h.tick(10 * MIN)
  h.say(ALPHA, { path: '@T/@~a', text: 'ended quietly', state: 'done', log: false }); h.tick(6 * MIN)   // its cp at the next 5-min tick
  h.say(ALPHA, { path: '@Q1', ask: 'Go?', choices: ['yes', 'no'] }); h.tick(MIN)
  h.say(ALPHA, { path: '@Q1', plan: ['step one'] }); h.tick(MIN)
  h.say(ALPHA, { path: '@Empty/w9/@~root', text: 'brief', state: 'done' }); h.tick(MIN)
  h.tick(2 * DAY)   // w9 expires; @Empty is left empty and nothing names it
  h.say(ALPHA, { path: '@T/@~b', text: 'later' }); h.tick(MIN)
  h.stop()
  const conv = convert(h), recs = recsOf(conv)
  const a = node2(conv, ALPHA, '@t/@a'), cp = recs.find(r => r.kind === 'cp' && a && r.n === a.id)
  check('TIME: a log:false end seen only by its checkpoint — the cp carries `timing` (took = 10 min), the node keeps it', a && cp && cp.timing && cp.timing.took === 10 * MIN && a.took === 10 * MIN, J(cp))
  const q = node2(conv, ALPHA, '@q1')
  check('a 1.7x question that later holds children stays a QUESTION (answerable; an item of its parent\'s plan) — its children keep their place under it', q && q.type === 'question' && q.current.question.status === 'asked' && M.childrenOf2(conv.model.sessions.get(V.sessionKey({ ...ALPHA, host: HOST })), q).length === 1, J(q && [q.type, q.current]))
  const em = V.legacyId({ ...ALPHA, host: HOST }, '@empty')
  const fg = recs.find(r => r.op === 'remove' && r.n === em)
  check('forgetting: an implicit, empty grouping node no record named within the window leaves at the next day start (why expire), as a 1.7x restart forgets it', fg && fg.why === 'expire' && !node2(conv, ALPHA, '@empty') && conv.report.removed.forgotten >= 1, J(fg))
  const kept = convert(h, { forget: false })
  check('… and with forget:false it is kept (the live tree as it was)', !!node2(kept, ALPHA, '@empty'), J(kept.report.removed))
})

await section(async () => {
  // ---- the FILES: a directory of 1.7x day files in, another directory out (day + index files), the Dropbox rule
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-conv4-'))
  try {
    const { h } = genHistory(4242, 300, { gap: 6 * MIN, jump: 0.02, jumpMs: 20 * HOUR })
    const src = path.join(tmp, 'v5'), dst = path.join(tmp, 'v6')
    fs.mkdirSync(src)
    const days = h.days()
    for (const d of days) fs.writeFileSync(path.join(src, `${d.day}.jsonl`), d.records.map(r => J(r) + '\n').join('') + 'not json at all\n')
    const conflicted = `${days[0].day} (LITTLE-001's conflicted copy 2026-10-03).jsonl`
    fs.writeFileSync(path.join(src, conflicted), J({ ...days[0].records.find(r => V.recordKind(r) === 'entry'), id: 'act_conflicted-1', text: 'from the conflicted copy' }) + '\n')
    const before = fs.readdirSync(src).map(n => n + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(src, n))).digest('hex')).sort()
    const r1 = C.convertDir({ srcDir: src, dstDir: dst, host: HOST, config: h.cfg })
    const names = fs.readdirSync(dst).sort()
    check('convertDir: a day file + its index file per v5 day (exact names), nothing else', J(names) === J(days.flatMap(d => [`${d.day}.idx.json`, `${d.day}.jsonl`]).sort()), J(names))
    const v6 = days.map(d => F.linesOf(fs.readFileSync(path.join(dst, `${d.day}.jsonl`))).map(l => l.rec))
    check('convertDir: every line of the written days is a v6 record; the garbled v5 lines are skipped and counted', v6.every(ls => ls.every(r => M.recordKind2(r))) && r1.report.skipped >= days.length, J(r1.report.skipped))
    check('convertDir: each index file = the index of its day file (buildIndex: entries by id, the struct)', days.every(d => J(JSON.parse(fs.readFileSync(path.join(dst, `${d.day}.idx.json`), 'utf8'))) === J(F.buildIndex(d.day, fs.readFileSync(path.join(dst, `${d.day}.jsonl`))))))
    check('the Dropbox rule: the conflicted copy is warned about, never read (its record is not converted) and left as it was', r1.report.conflicted.includes(conflicted) && r1.report.warnings.some(w => w.includes('conflicted copy') && w.includes(conflicted))
      && !v6.flat().some(r => r.id === 'act_conflicted-1') && J(fs.readdirSync(src).map(n => n + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(src, n))).digest('hex')).sort()) === J(before))
    const dst2 = path.join(tmp, 'v6b'), r2 = C.convertDir({ srcDir: src, dstDir: dst2, host: HOST, config: h.cfg })
    check('convertDir twice: byte-identical day files (sha256) and index files', J(r1.files) === J(r2.files) && days.every(d => fs.readFileSync(path.join(dst, `${d.day}.idx.json`), 'utf8') === fs.readFileSync(path.join(dst2, `${d.day}.idx.json`), 'utf8')), J([r1.files[0], r2.files[0]]))
    let refused = false
    try { C.convertDir({ srcDir: src, dstDir: src, host: HOST }) } catch { refused = true }
    check('convertDir refuses to write into its own input directory', refused)
    // the converted files as a 2.0 bridge reads them: newest first through the day files (readBackwards → createReplay2)
    const pdir = path.join(tmp, 'persist'), hd = F.hostDir(pdir, HOST)
    fs.mkdirSync(path.dirname(hd), { recursive: true }); fs.cpSync(dst, hd, { recursive: true })
    const now = h.at() + MIN, R = M.createModel({ origin: HOST, config: h.cfg }), rp = M.createReplay2(R, { now })
    for (const x of F.readBackwards(pdir, HOST)) { if (!x.rec) continue; const a = rp.feed(x.rec, x.day); if (a === 'old' && !rp.wantsOlder(x.day)) break }
    rp.finish(); M.expire2(R, now)
    const df = compare(replay17(h, now), R, r1.paths, { created: false, order: false })
    check('the written days replayed as a 2.0 bridge reads them (backwards through the files) = 1.7x\'s replay', !df.length, df.join('\n  '))
    check('convertDir with no host refuses', (() => { try { C.convertDir({ srcDir: src, dstDir: path.join(tmp, 'x'), host: '' }); return false } catch { return true } })())
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

await section(async () => {
  // ---- the CONVERSION FUZZ: random 1.7x histories inside one replay window — the 2.0 bridge's start on the converted days (its
  // replay + its first expiry pass) = 1.7x's LIVE board at the stop (+ its gc pass), exactly; = 1.7x's own replay of the
  // original days (created_at / order of a moved-in node excepted); the converter's model = the replay of what it wrote;
  // converting twice gives the same bytes. AIMB_FUZZ4_SEEDS / _RESTART / _EXPIRY / _RETAIN=1,2,… run other seeds.
  const seeds = (process.env.AIMB_FUZZ4_SEEDS || '').split(',').filter(Boolean).map(Number)
  const list = seeds.length ? seeds : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  const bad = [], badR = [], badM = [], badD = []
  let tot = { moves: 0, asks: 0, closed: 0, actions: 0, plans: 0, expiries: 0, entries: 0, records: 0 }
  for (const seed of list) {
    const { h, stats } = genHistory(seed, 500, { gap: 4 * MIN, jump: 0.01, jumpMs: 20 * HOUR })
    const days = h.days(), now = h.at() + MIN
    let conv
    try { conv = C.convertV5(days, { host: HOST, config: h.cfg }) } catch (e) { bad.push(`seed ${seed}: threw ${e.stack}`); continue }
    for (const k of Object.keys(stats)) if (k in tot) tot[k] += stats[k]
    tot.entries += conv.report.entries; tot.records += conv.report.records_out
    const B = replay20(conv, h.cfg, now)
    V.expire(h.st, now)
    // (a history longer than the 7-day window: the 2.0 bridge replays only the window — entries before it are in the files —
    // and an empty grouping node no record named within it is forgotten, as a 1.7x restart forgets it)
    const W = { window: now - 168 * HOUR, forgettable: true }
    const dl = compare(h.st, B, conv.paths, W)
    if (dl.length) bad.push(`seed ${seed} (${J(stats)}):\n    ${dl.join('\n    ')}`)
    // 1.7x's own replay: the same board, but for created_at (and so the derived sibling order) and the activity of a node a
    // move put under a newer parent — 1.7x's replay re-derives them from the records it remaps there; its live tree (above)
    // keeps them — and for the logs (compared exactly against the live board above: a moved node's log is where 1.7x's
    // replay is lossy)
    // (only for a history inside the window: past it, 1.7x's windowed replay is lossy — an older cf in the window restates an
    // item its gc had expired, a count is the window's — and the live board above is the reference)
    const dr = now - T0 > 168 * HOUR ? [] : compare(replay17(h, now), B, conv.paths, { created: false, order: false, logs: false, activity: false })
    if (dr.length) badR.push(`seed ${seed}:\n    ${dr.join('\n    ')}`)
    // the converter's model IS the replay of what it wrote (structure, lines, logs, ghosts, the scope index, aliases …)
    const R = M.createModel({ origin: HOST, config: h.cfg })
    M.replayRecords2(R, conv.days.flatMap(d => d.records.map(rec => ({ rec, day: d.day }))), now, { from: 0 })
    if (dump(R) !== dump(conv.model)) badM.push(`seed ${seed}: ${firstDiff(dump(conv.model), dump(R))}`)
    // deterministic: converting again gives the same bytes
    const again = C.convertV5(h.days(), { host: HOST, config: h.cfg })
    if (J(again.days) !== J(conv.days)) badD.push(`seed ${seed}`)
  }
  check(`conversion fuzz: ${list.length} random histories (${J(tot)}) — the 2.0 replay of the converted days (+ its first expiry pass) = the 1.7x board: every node by its final path, kind, label, parent, line, bar, plan, rank, question, log + count, activity, sibling order`, !bad.length, bad.slice(0, 3).join('\n  '))
  check('conversion fuzz: … = 1.7x\'s own replay of the original days (a history inside the window: structure, lines, bars, states, plans, questions; see above for what is not compared)', !badR.length, badR.slice(0, 3).join('\n  '))
  check('conversion fuzz: the converter\'s model = the replay of the records it wrote (createFold2 = the replay\'s fold)', !badM.length, badM.slice(0, 2).join('\n  '))
  check('conversion fuzz: converting the same days twice gives byte-identical days', !badD.length, badD.join(', '))
})

await section(async () => {
  // ---- VARIANTS of the fuzz: (1) 1.7x RESTARTS mid-history (the gateway's replay + its cf) and log:false reports (cp / rep
  // lines) — activity aside (a 1.7x cp does not carry a log:false report's stale_after); (2) EXPIRY: a short window
  // (finished_visible_hours 3) so agents and ended plans expire live (the converter's gc emulation) and their paths are used
  // again (new_from → a new run of the same id) — against 1.7x's live board over the whole history; (3) RETENTION + the
  // WINDOW (below)
  const pick = (k, d) => { const v = (process.env['AIMB_FUZZ4_' + k] || '').split(',').filter(Boolean).map(Number); return v.length ? v : d }
  const run = (seeds, gen, cmp, copts = {}) => {
    const bad = []
    for (const seed of seeds) {
      const g = gen(seed), now = g.h.at() + MIN, days = g.days || g.h.days()
      let conv
      try { conv = C.convertV5(days, { host: HOST, config: g.h.cfg, ...copts }) } catch (e) { bad.push(`seed ${seed}: threw ${e.stack}`); continue }
      const df = cmp(g, conv, now, days)
      if (df.length) bad.push(`seed ${seed} (${J(g.stats)}):\n    ${df.join('\n    ')}`)
    }
    return bad
  }
  const b1 = run(pick('RESTART', [21, 22, 23, 24, 25, 26]), seed => genHistory(seed, 500, { gap: 4 * MIN, jump: 0.01, jumpMs: 20 * HOUR, restarts: true, unlogged: 0.3, noMoves: true }), (g, conv, now) => {
    const B = replay20(conv, g.h.cfg, now)
    V.expire(g.h.st, now)
    // a 1.7x restart re-derives created_at (so the derived sibling order) the way its replay does — the live tree carries
    // that on, and the conversion follows the records: created_at / order are compared in the fuzz without restarts
    const W = { window: now - 168 * HOUR }
    // (after a restart, 1.7x's live counts are its replay's — the window's + a cf's: the counts are compared without restarts)
    return [...compare(g.h.st, B, conv.paths, { activity: false, created: false, order: false, ...W, counts: false }), ...compare(replay17(g.h, now), B, conv.paths, { activity: false, created: false, order: false, ...W, counts: false })]
  })
  check('conversion fuzz with 1.7x restarts + log:false (cp / rep): the same board (lines, bars, states, logs, structure)', !b1.length, b1.slice(0, 3).join('\n  '))
  const fvh3 = { finished_visible_hours: 3 }
  const b2 = []
  for (const seed of pick('EXPIRY', [31, 32, 33, 34, 35, 36])) {
    const g = genHistory(seed, 700, { gap: 3 * MIN, jump: 0.01, jumpMs: 4 * HOUR, config: fvh3 }), now = g.h.at() + MIN
    let conv
    try { conv = C.convertV5(g.h.days(), { host: HOST, config: g.h.cfg, forget: false }) } catch (e) { b2.push(`seed ${seed}: threw ${e.stack}`); continue }
    const B = replay20(conv, g.h.cfg, now, { from: 0 })   // the whole history (a 3 h window holds no carry-forward)
    V.expire(g.h.st, now)
    g.stats.removed = conv.report.removed.expire; g.stats.runs = conv.report.runs
    const df = compare(g.h.st, B, conv.paths)
    if (df.length) b2.push(`seed ${seed} (${J(g.stats)}):\n    ${df.join('\n    ')}`)
    else if (!(conv.report.removed.expire > 0)) b2.push(`seed ${seed}: no run ended unseen (${J(g.stats)})`)
  }
  check('conversion fuzz with EXPIRY (a 3 h window): agents / plans expire live, their paths are used again (new_from → `remove` why expire + a new run) — the same board as 1.7x\'s live one', !b2.length, b2.slice(0, 3).join('\n  '))
  // RETENTION + the WINDOW: a 1-day window (finished_visible_hours 24, so 1.7x's rollover cf carries every node with a state
  // of its own) and only the newest 3 days retained; the 2.0 side replays the window, as its bridge does at start. Against
  // 1.7x's LIVE board: its own windowed replay can bring back a plan item its gc had expired (expiry writes nothing, and an
  // older cf in the window still restates it) — the conversion follows the evidence (the next cf no longer carried it)
  const b3 = run(pick('RETAIN', [41, 42, 43, 44, 45, 46]), seed => {
    const g = genHistory(seed, 800, { gap: 6 * MIN, jump: 0.03, jumpMs: 20 * HOUR, config: { finished_visible_hours: 24 } })
    const all = g.h.days()
    return { ...g, days: all.slice(Math.max(1, all.length - 3)) }
  }, (g, conv, now) => {
    const B = replay20(conv, g.h.cfg, now)
    V.expire(g.h.st, now)
    return compare(g.h.st, B, conv.paths, { activity: false, created: false, order: false, window: now - 24 * HOUR, counts: false, forgettable: true })
  }, { forget: false })   // (live keeps an empty grouping node a restart would forget)
  check('conversion fuzz with RETENTION + the replay WINDOW (the oldest days gone, the first converted day starts with 1.7x\'s cf; the 2.0 side replays the last 24 h): the same board as 1.7x\'s live one (entries within the window)', !b3.length, b3.slice(0, 3).join('\n  '))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
