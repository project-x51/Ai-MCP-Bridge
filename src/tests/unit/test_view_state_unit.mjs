// Fast UNIT tests for #88 (v2.0) build step 8 — PER-USER VIEW STATE (lib/view-state.js, docs/spec-88.md §5.6): no bridge,
// no sockets. Covered:
//   - keys and values: every kind (pin / hide / open / all / sel / fold:details / seen / opt / reset), the 128-byte value
//     bound, a reset that can't be undone, bad keys / values refused, another realm dropped;
//   - THE ORDER (beatsView): greater ts; on a tie the tombstone, then the greater origin, then the canonical JSON — and the
//     merge is IDEMPOTENT and COMMUTATIVE (every permutation of a seeded random history gives the same set);
//   - the LOCAL STAMP: max(now, known + 1) — a host whose clock is behind still beats what it knows; above the user's reset;
//   - seen: as a MAX REGISTER (never back; a concurrent older entry loses whatever its ts), its generations (a tombstone
//     beats it, a later seen beats the tombstone, a stale old-generation write loses to the tombstone, after a reset a new
//     seen wins);
//   - Reset view voids every older record of that user only (and is stamped above a far-future record);
//   - `all` vs a newer `open:` (openState), nodes created after `all` take the default;
//   - PRUNING: tombstone(targets) for every user's records of a node that left; pinned();
//   - GC: tombstones / voided / orphaned (node held by nobody) records past the TTL; an expired tombstone never comes back;
//   - the BUDGET (newest kept, a log line), the gossip list (newest first within the byte budget, logged), view_v (equal
//     sets → equal view_v), the file image + rehydrate (round trip; junk files skipped);
//   - the store's step-8 hooks (lib/activity2-store.js): `left` on a dismissal / a merge / a transient vanish, keepPinned
//     (a pin makes a transient context permanent: one keep record, survives the replay), applySlice2's `left`;
//   - the views/ files (lib/activity2-files.js): exact names only — a conflicted copy is warned and never read.
import { testOnly } from '../helpers/check.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as V from '../../lib/view-state.js'
import * as M from '../../lib/activity2.js'
import * as S from '../../lib/activity2-store.js'
import * as G from '../../lib/activity2-gossip.js'
import * as F from '../../lib/activity2-files.js'
import * as A from '../../lib/activity.js'
import { create as createPersistence } from '../../facets/persistence/file.js'
const fileFacet = dir => createPersistence({ CFG: { persistence: { dir } }, HERE: dir, env: {} }).activity2
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.stack} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
function section(name, fn) { try { fn() } catch (e) { fail++; console.log(`FAIL section "${name}" crashed:`, (e && e.stack) || e) } }
const NODE = 'abcdefghijklmnop', NODE2 = 'bcdefghijklmnopq', NODE3 = 'cdefghijklmnopqr'
const T0 = new Date(2026, 9, 3, 9, 0, 0).getTime()
const eid = (ms, seq = 1, pre = 'act_aa5e_') => `${pre}${ms.toString(36)}-${seq.toString(36)}`
const rec = (o) => ({ realm: 'default', user: 'robin', origin: 'A', ...o })
const snap = vs => J(vs.all().map(r => [r.user, r.k, r.v, r.ts, r.origin, r.g ?? null]).sort((a, b) => (J(a) < J(b) ? -1 : 1)))
// a seeded PRNG (mulberry32)
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

section('keys and values', () => {
  check('keys: every kind parses (pin / hide / open / seen with a target, opt:<name>, fold:details, all, sel, reset)',
    ['pin:' + NODE, 'hide:' + NODE, 'open:' + NODE, 'seen:' + NODE, 'opt:show_removed', 'opt:log_order', 'fold:details', 'all', 'sel', 'reset', 'pin:proj:AIMB'].every(k => V.parseViewKey(k)))
  check('keys: junk refused (unknown kind, empty target, fold:other, opt with capitals, a control char, too long)',
    ['', 'x', 'pin:', 'fold:summary', 'opt:Show', 'pin:a\nb', 'pin:' + 'x'.repeat(201), 'pinned:' + NODE, ' all'].every(k => !V.parseViewKey(k)))
  check('values: pin / hide 1, open {o:1} | {o:0,n,q}, all {o:0|1}, fold 1|0, sel a target, seen an entry id, opt a scalar',
    V.normViewValue('pin', 1) === 1 && V.normViewValue('hide', true) === 1 && J(V.normViewValue('open', { o: 1 })) === '{"o":1}' && J(V.normViewValue('open', { o: 0, n: 12, q: 1 })) === '{"o":0,"n":12,"q":1}'
    && J(V.normViewValue('open', { o: 0 })) === '{"o":0,"n":0,"q":0}' && J(V.normViewValue('all', { o: 0 })) === '{"o":0}' && V.normViewValue('fold', 0) === 0 && V.normViewValue('sel', NODE) === NODE
    && V.normViewValue('seen', eid(T0)) === eid(T0) && V.normViewValue('opt', true) === true && V.normViewValue('opt', 'newest') === 'newest')
  check('values: refused — pin 2, open {o:2}, open with extra fields, all {}, seen not an entry id, opt an object, a reset tombstone',
    [['pin', 2], ['open', { o: 2 }], ['open', { o: 1, n: 3 }], ['open', { o: 0, n: -1 }], ['all', {}], ['seen', 'hello'], ['opt', { a: 1 }], ['reset', null], ['reset', 0]].every(([k, v]) => V.normViewValue(k, v) === undefined))
  check('values: tombstones (null) accepted for everything but reset', ['pin', 'hide', 'open', 'all', 'sel', 'fold', 'seen', 'opt'].every(k => V.normViewValue(k, null) === null))
  check('values: ≤ 128 bytes of JSON (a 200-char opt string refused, 64 accepted)', V.normViewValue('opt', 'x'.repeat(65)) === undefined && V.normViewValue('opt', 'x'.repeat(64)) === 'x'.repeat(64))
  check('records: another realm is dropped; the user is lower-cased; seen keeps a generation, others none',
    V.normViewRec(rec({ realm: 'other', k: 'all', v: { o: 1 }, ts: T0 }), 'default') === null && V.normViewRec(rec({ user: 'Robin', k: 'pin:' + NODE, v: 1, ts: T0 }), 'default').user === 'robin'
    && V.normViewRec(rec({ k: 'seen:' + NODE, v: eid(T0), ts: T0, g: 3 }), 'default').g === 3 && !('g' in V.normViewRec(rec({ k: 'pin:' + NODE, v: 1, ts: T0, g: 3 }), 'default')))
  const vs = V.createViewSet({ realm: 'default', origin: 'A' })
  const r = vs.set('robin', [{ k: 'pin:' + NODE, v: 1 }, { k: 'bogus', v: 1 }, { k: 'pin:' + NODE2, v: 7 }, { k: 'reset', v: null }], T0)
  check('set: good records stamped (user, ts, origin), bad ones refused with a code each', r.changed.length === 1 && r.changed[0].ts === T0 && r.changed[0].origin === 'A' && r.changed[0].user === 'robin'
    && J(r.refused.map(x => x.code)) === J(['bad-key', 'bad-value', 'bad-value']), J(r))
  const many = vs.set('robin', Array.from({ length: 300 }, (_, i) => ({ k: `opt:o${i}`, v: i })), T0)
  check('set: at most 256 records per view_set (too-many, the rest ignored)', many.changed.length === 256 && many.refused.some(x => x.code === 'too-many'), J(many.refused))
})

section('the order and the merge', () => {
  const a = rec({ k: 'pin:' + NODE, v: 1, ts: 10 }), b = rec({ k: 'pin:' + NODE, v: 1, ts: 11 })
  check('order: greater ts wins', V.beatsView(b, a) && !V.beatsView(a, b))
  const tomb = rec({ k: 'pin:' + NODE, v: null, ts: 10, origin: 'A' }), val = rec({ k: 'pin:' + NODE, v: 1, ts: 10, origin: 'Z' })
  check('order: a ts tie → the tombstone wins (whatever the origins)', V.beatsView(tomb, val) && !V.beatsView(val, tomb))
  const oa = rec({ k: 'all', v: { o: 1 }, ts: 10, origin: 'A' }), ob = rec({ k: 'all', v: { o: 0 }, ts: 10, origin: 'B' })
  check('order: then the greater origin', V.beatsView(ob, oa) && !V.beatsView(oa, ob))
  const ca = rec({ k: 'all', v: { o: 0 }, ts: 10, origin: 'A' }), cb = rec({ k: 'all', v: { o: 1 }, ts: 10, origin: 'A' })
  check('order: then the greater canonical JSON of v; identical records never beat each other', V.beatsView(cb, ca) && !V.beatsView(ca, cb) && !V.beatsView(ca, { ...ca }))
  // idempotent + commutative: a seeded random history merged in every order gives one set
  const R = rng(88)
  const keys = ['pin:' + NODE, 'hide:' + NODE, 'open:' + NODE2, 'all', 'sel', 'seen:' + NODE3, 'opt:show_removed', 'reset']
  const users = ['robin', 'alice'], origins = ['A', 'B', 'C']
  const hist = []
  for (let i = 0; i < 160; i++) {
    const k = keys[Math.floor(R() * keys.length)], ts = T0 + Math.floor(R() * 40) * 1000, tombstone = k !== 'reset' && R() < 0.25
    const v = tombstone ? null : k.startsWith('pin') || k.startsWith('hide') || k === 'reset' ? 1 : k.startsWith('open') ? (R() < 0.5 ? { o: 1 } : { o: 0, n: Math.floor(R() * 9), q: 0 }) : k === 'all' ? { o: R() < 0.5 ? 1 : 0 }
      : k === 'sel' ? [NODE, NODE2][Math.floor(R() * 2)] : k.startsWith('seen') ? eid(T0 + Math.floor(R() * 30) * 997, 1 + Math.floor(R() * 3)) : R() < 0.5
    hist.push(rec({ user: users[Math.floor(R() * 2)], origin: origins[Math.floor(R() * 3)], k, v, ts, ...(k.startsWith('seen') ? { g: Math.floor(R() * 3) } : {}) }))
  }
  const ref = V.createViewSet({ realm: 'default', origin: 'X' }); ref.merge(hist, T0)
  let allSame = true, idem = true
  for (let p = 0; p < 30; p++) {
    const R2 = rng(1000 + p), perm = hist.slice().sort(() => R2() - 0.5)
    const vs = V.createViewSet({ realm: 'default', origin: 'X' })
    // in chunks, some twice
    for (let i = 0; i < perm.length; i += 7) vs.merge(perm.slice(i, i + 7), T0)
    if (snap(vs) !== snap(ref)) allSame = false
    if (vs.merge(perm, T0).length !== 0 || snap(vs) !== snap(ref)) idem = false
  }
  check('merge: COMMUTATIVE — 30 random orders (in chunks) of 160 random records give the same set', allSame)
  check('merge: IDEMPOTENT — merging everything again changes nothing', idem)
  const two = V.createViewSet({ realm: 'default' }), back = V.createViewSet({ realm: 'default' })
  two.merge(hist.slice(0, 80), T0); back.merge(hist.slice(80), T0)
  const x = two.merge(back.all(), T0); back.merge(two.all(), T0)
  check('merge: two halves exchanged both ways converge (and merge() returns only the records that changed the set)', snap(two) === snap(back) && snap(two) === snap(ref) && x.length > 0 && x.length <= 80)
})

section('the local stamp', () => {
  const A = V.createViewSet({ realm: 'default', origin: 'A' }), B = V.createViewSet({ realm: 'default', origin: 'B' })
  A.set('robin', [{ k: 'pin:' + NODE, v: 1 }], T0 + 60000)            // A's clock is a minute ahead
  B.merge(A.all(), T0)
  const u = B.set('robin', [{ k: 'pin:' + NODE, v: null }], T0)         // B (behind) unpins
  check('stamp: a write on a host whose clock is BEHIND still beats what it knows (ts = known + 1)', u.changed.length === 1 && u.changed[0].ts === T0 + 60001 && B.forUser('robin').length === 0, J(u))
  A.merge(B.all(), T0 + 60000)
  check('stamp: … and wins on the other host too (the unpin replicates)', A.forUser('robin').length === 0)
  const same = A.set('robin', [{ k: 'pin:' + NODE2, v: 1 }], T0); const again = A.set('robin', [{ k: 'pin:' + NODE2, v: 1 }], T0 + 5)
  check('stamp: setting what is already so writes nothing (no echo)', same.changed.length === 1 && again.changed.length === 0)
  const forget = A.set('robin', [{ k: 'hide:' + NODE3, v: null }], T0)
  check('stamp: forgetting what was never set writes nothing', forget.changed.length === 0)
})

section('seen: a max register with generations', () => {
  const A = V.createViewSet({ realm: 'default', origin: 'A' }), B = V.createViewSet({ realm: 'default', origin: 'B' })
  const k = 'seen:' + NODE
  A.set('robin', [{ k, v: eid(T0 + 5000) }], T0 + 5000)
  B.set('robin', [{ k, v: eid(T0 + 3000) }], T0 + 9000)   // a LATER write of an OLDER entry (a window that had not refreshed)
  A.merge(B.all(), T0 + 9000); B.merge(A.all(), T0 + 9000)
  check('seen: merge keeps the NEWER entry whatever the ts — it never moves back (both hosts)', A.get('robin', k).v === eid(T0 + 5000) && B.get('robin', k).v === eid(T0 + 5000), J([A.get('robin', k), B.get('robin', k)]))
  const back = A.set('robin', [{ k, v: eid(T0 + 1000) }], T0 + 10000)
  check('seen: a local write of an older entry changes nothing', back.changed.length === 0 && A.get('robin', k).v === eid(T0 + 5000))
  check('seen: entry order is by time, not by the id prefix (another gateway start\'s prefix)', V.entryCmp(eid(T0 + 2000, 1, 'act_ffff_'), eid(T0 + 3000, 1, 'act_0000_')) < 0 && V.entryCmp(eid(T0, 2), eid(T0, 10)) < 0)
  const tb = A.tombstone([NODE], T0 + 11000)
  check('seen: a tombstone (the node left) goes a GENERATION up and beats the max register', tb.length === 1 && tb[0].v === null && tb[0].g === 1 && A.forUser('robin').every(r => r.k !== k))
  B.set('robin', [{ k, v: eid(T0 + 9500) }], T0 + 11500)   // B had not heard of the tombstone: an old-generation write
  A.merge(B.all(), T0 + 12000); B.merge(A.all(), T0 + 12000)
  check('seen: a concurrent OLD-generation seen loses to the tombstone on both hosts', A.get('robin', k).v === null && B.get('robin', k).v === null, J([A.get('robin', k), B.get('robin', k)]))
  const again = A.set('robin', [{ k, v: eid(T0 + 1000) }], T0 + 13000)
  check('seen: after the tombstone a new seen (same generation) wins — even an "older" entry (the node came back)', again.changed.length === 1 && again.changed[0].g === 1 && A.forUser('robin').some(r => r.k === k))
  A.set('robin', [{ k: 'reset', v: 1 }], T0 + 14000)
  const after = A.set('robin', [{ k, v: eid(T0 + 500) }], T0 + 15000)
  check('seen: after a Reset view the first seen goes a generation up (so it beats the voided max)', after.changed.length === 1 && after.changed[0].g === 2 && A.forUser('robin').find(r => r.k === k)?.v === eid(T0 + 500), J(after))
})

section('reset view', () => {
  const A = V.createViewSet({ realm: 'default', origin: 'A' })
  A.set('robin', [{ k: 'pin:' + NODE, v: 1 }, { k: 'open:' + NODE2, v: { o: 0, n: 3, q: 0 } }, { k: 'opt:show_removed', v: true }], T0)
  A.set('alice', [{ k: 'pin:' + NODE, v: 1 }], T0)
  A.merge([rec({ k: 'hide:' + NODE3, v: 1, ts: T0 + 3600000, origin: 'Z' })], T0)   // a far-future record (clock skew elsewhere)
  const r = A.set('robin', [{ k: 'reset', v: 1 }], T0 + 1000)
  const live = A.forUser('robin')
  check('reset: voids EVERY older record of that user — even a far-future one (it is stamped above them)', r.changed[0].ts === T0 + 3600001 && live.length === 1 && live[0].k === 'reset', J(live))
  check('reset: another user\'s view is untouched', A.forUser('alice').length === 1)
  const p = A.set('robin', [{ k: 'pin:' + NODE, v: 1 }], T0 + 2000)
  check('reset: a later write is stamped above the reset, so it counts', p.changed.length === 1 && p.changed[0].ts > r.changed[0].ts && A.forUser('robin').some(x => x.k === 'pin:' + NODE))
  const B = V.createViewSet({ realm: 'default', origin: 'B' }); B.merge(A.all(), T0)
  check('reset: replicated, the other host voids the same records', J(B.forUser('robin').map(x => x.k)) === J(A.forUser('robin').map(x => x.k)))
  const r2 = A.set('robin', [{ k: 'reset', v: 1 }], T0 + 3000)
  check('reset: a second Reset view is written again (never "already so")', r2.changed.length === 1 && A.forUser('robin').length === 1)
})

section('all vs open', () => {
  const vs = V.createViewSet({ realm: 'default', origin: 'A' })
  vs.set('robin', [{ k: 'open:' + NODE, v: { o: 1 } }], T0)
  vs.set('robin', [{ k: 'all', v: { o: 0 } }], T0 + 1000)          // Collapse all
  vs.set('robin', [{ k: 'open:' + NODE2, v: { o: 1 } }], T0 + 2000) // then one node opened again
  const m = new Map(vs.forUser('robin').map(r => [r.k, r]))
  check('all: covers a node created before it whose open: record is OLDER (collapsed)', V.openState(m, NODE, T0 - 5000) === 0)
  check('all: a NEWER open: record beats it (open)', V.openState(m, NODE2, T0 - 5000) === 1)
  check('all: a node created AFTER it takes the default (null)', V.openState(m, NODE3, T0 + 1500) === null)
  check('all: no record at all → the default (null); an explicit close beats the default', V.openState(new Map(), NODE, T0) === null && V.openState(new Map([['open:' + NODE, { k: 'open:' + NODE, v: { o: 0, n: 1, q: 0 }, ts: T0 }]]), NODE, T0) === 0)
})

section('pruning, pins, gc', () => {
  const vs = V.createViewSet({ realm: 'default', origin: 'A' })
  vs.set('robin', [{ k: 'pin:' + NODE, v: 1 }, { k: 'open:' + NODE, v: { o: 1 } }, { k: 'seen:' + NODE, v: eid(T0) }, { k: 'pin:' + NODE2, v: 1 }], T0)
  vs.set('alice', [{ k: 'hide:' + NODE, v: 1 }], T0)
  check('pinned(): every target with a live pin of any user', J([...vs.pinned()].sort()) === J([NODE, NODE2]))
  const t = vs.tombstone(new Set([NODE]), T0 + 1000)
  check('tombstone(): every user\'s records of the node that left (4 = robin\'s pin / open / seen + alice\'s hide), the rest kept',
    t.length === 4 && t.every(r => r.v === null && r.origin === 'A') && vs.forUser('robin').map(r => r.k).join() === 'pin:' + NODE2 && vs.forUser('alice').length === 0, J(t))
  check('tombstone(): a second call writes nothing (already tombstones)', vs.tombstone([NODE], T0 + 2000).length === 0)
  const TTL = V.VIEW_TTL_MS
  vs.set('robin', [{ k: 'reset', v: 1 }], T0 + 3000); vs.set('robin', [{ k: 'pin:' + NODE3, v: 1 }], T0 + 4000)
  vs.merge([rec({ user: 'bob', k: 'pin:' + 'ddddddddddddddd2', v: 1, ts: T0 }), rec({ user: 'bob', k: 'pin:proj:AIMB', v: 1, ts: T0 })], T0)
  const g0 = vs.gc(T0 + TTL - 1, { isHeld: () => false })
  check('gc: nothing younger than the TTL is dropped', g0.dropped === 0, J(g0))
  const g1 = vs.gc(T0 + 5000 + TTL, { isHeld: id => id === NODE3 })
  check('gc: past the TTL — tombstones, reset-voided records and a LIVE record whose node no gateway holds go; a held node\'s and a non-node row\'s stay',
    g1.tombstones === 4 && g1.voided === 1 && g1.orphans === 1 && !!vs.get('robin', 'pin:' + NODE3) && !!vs.get('bob', 'pin:proj:AIMB') && !vs.get('bob', 'pin:ddddddddddddddd2'), J(g1))
  const re = vs.merge([rec({ k: 'pin:' + NODE, v: null, ts: T0 + 1000 })], T0 + 5000 + TTL)
  check('gc: an expired tombstone is never taken back in', re.length === 0 && !vs.get('robin', 'pin:' + NODE))
})

section('budget, gossip list, view_v, files', () => {
  const lines = []
  const vs = V.createViewSet({ realm: 'default', origin: 'A', maxLive: 10, gossipMaxBytes: 2000, log: l => lines.push(l) })
  const r = vs.set('robin', Array.from({ length: 14 }, (_, i) => ({ k: `pin:proj:p${String(i).padStart(2, '0')}`, v: 1 })), T0)
  check('budget: a user keeps ≤ maxLive live records — the newest (the dropped ones are not reported as changed), with a log line',
    vs.forUser('robin').length === 10 && r.changed.length === 10 && lines.some(l => l.includes('the 4 oldest were dropped')), J([vs.forUser('robin').length, r.changed.length, lines]))
  vs.set('robin', [{ k: 'reset', v: 1 }], T0 + 10)
  check('budget: the reset record is exempt', !!vs.get('robin', 'reset'))
  const big = V.createViewSet({ realm: 'default', origin: 'A', gossipMaxBytes: 1200, log: l => lines.push(l) })
  big.set('robin', Array.from({ length: 30 }, (_, i) => ({ k: `pin:proj:q${i}`, v: 1 })).map((x, i) => x), T0)
  for (let i = 0; i < 30; i++) big.set('robin', [{ k: `hide:proj:q${i}`, v: 1 }], T0 + i * 1000)
  const L = big.list()
  check('list: newest first within the byte budget, the rest stays local (logged once)', L.skipped > 0 && L.recs.length + L.skipped === big.size() && L.recs[0].ts >= L.recs[L.recs.length - 1].ts && lines.some(l => l.includes('over the 1200-byte VIEW budget')), J([L.recs.length, L.skipped]))
  const a = V.createViewSet({ realm: 'default', origin: 'A' }), b = V.createViewSet({ realm: 'default', origin: 'B' })
  a.set('robin', [{ k: 'pin:' + NODE, v: 1 }, { k: 'all', v: { o: 1 } }], T0)
  check('view_v: differs while the sets differ', J(a.viewV()) !== J(b.viewV()))
  b.merge(a.all(), T0)
  check('view_v: equal sets → equal view_v (count + hash of the newest 64)', J(a.viewV()) === J(b.viewV()) && a.viewV().n === 2 && /^[0-9a-f]{16}$/.test(a.viewV().h))
  const img = a.toFile('ROBIN-Z790', T0)
  const c = V.createViewSet({ realm: 'default', origin: 'C' })
  const rh = c.rehydrate([{ name: 'robin-z790.json', data: JSON.parse(J(img)) }, { name: 'junk.json', data: null }, { name: 'old.json', data: { v: 99, recs: [] } }], T0)
  check('files: the image round-trips through rehydrate (junk / wrong-format files skipped)', rh.files === 1 && rh.merged === 2 && rh.bad === 2 && snap(c) === snap(a), J(rh))
  // the files lib: exact names; a conflicted copy is warned and never read
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-view8-'))
  try {
    F.writeView(dir, 'ROBIN-Z790', img)
    F.writeView(dir, 'LITTLE-001', { ...img, host: 'LITTLE-001', recs: [rec({ user: 'robin', k: 'hide:' + NODE2, v: 1, ts: T0 + 5, origin: 'LITTLE-001' })] })
    fs.writeFileSync(path.join(dir, 'views', "robin-z790 (LITTLE-001's conflicted copy 2026-10-03).json"), J({ ...img, recs: [rec({ k: 'pin:' + NODE3, v: 1, ts: T0 + 9 })] }))
    fs.writeFileSync(path.join(dir, 'views', 'robin-z790.json.tmp-abcd1234'), 'half')
    const names = fs.readdirSync(path.join(dir, 'views')).sort()
    const got = F.readViews(dir), sc = F.scanViewsDir(dir)
    check('files: views/<lslug(host)>.json per host (lower-case slug), written whole', names.includes('robin-z790.json') && names.includes('little-001.json'), J(names))
    check('files: readViews reads ONLY the exact names (both hosts\' files; the conflicted copy and the .tmp never)', J(got.map(x => x.name)) === J(['little-001.json', 'robin-z790.json']), J(got.map(x => x.name)))
    check('files: the conflicted copy is warned (scanViewsDir: a WARN line naming it, fs_warnings)', sc.odd.length === 1 && sc.warnings[0].includes('conflicted copy') && sc.fs_warnings.length === 1, J(sc))
    const d = V.createViewSet({ realm: 'default', origin: 'D' }); d.rehydrate(got, T0)
    check('files: rehydrate merges both hosts\' files (the conflicted copy\'s pin never)', !!d.get('robin', 'hide:' + NODE2) && !!d.get('robin', 'pin:' + NODE) && !d.get('robin', 'pin:' + NODE3))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

section('the store hooks (left, keepPinned) and applySlice2 left', () => {
  const LEAD = { session: 'Lead', project: 'AIMB', user: 'robin', realm: 'default' }
  const DASH = { kind: 'dashboard', user: 'robin', host: 'A' }
  const st = S.createStore2({ host: 'A', config: { log_entries_per_agent: 50 } })
  let now = T0
  const call = i => { const r = st.apply(LEAD, i, now += 1000); if (!r.ok) throw new Error(J(r)); return r }
  const w = call({ agent: 'w1', label: 'Worker', text: '@go', state: 'running' })
  const a = call({ agent: 'w1', key: 'a', label: 'A', text: '@a' }), b = call({ agent: 'w1', key: 'b', label: 'B', text: '@b' })
  const mg = st.action({ ...LEAD, id: a.node.id, action: 'merge', args: { into_id: b.node.id } }, now += 1000, { by: DASH })
  check('store: a merge reports the merged node as left', mg.ok && J(mg.left) === J([a.node.id]), J(mg))
  const t1 = call({ agent: 'w1', key: 't1', label: 'T1', text: '@t', move_to: '/Worker/Pending' })
  const pend = M.findPath(M.getSession2(st.state, LEAD), 'Worker/Pending')
  const mv = call({ agent: 'w1', key: 't1', text: '@done', state: 'done', move_to: '/Worker/Passed' })
  check('store: a transient bucket that vanishes is reported as left (its id)', pend && pend.transient && (mv.left || []).includes(pend.id), J([pend && pend.transient, mv.left]))
  const back = call({ agent: 'w1', key: 't1', text: '@again', state: 'running', move_to: '/Worker/Pending' })
  check('store: a call that resurrects it reports nothing left for it', !(back.left || []).includes(pend.id))
  call({ agent: 'w1', state: 'done', text: '@finished' })
  const dm = st.action({ ...LEAD, id: w.node.id, action: 'dismiss' }, now += 3600000, { by: DASH })
  check('store: a dismissal reports the agent and its whole subtree as left', dm.ok && [w.node.id, b.node.id, t1.node.id].every(id => (dm.left || []).includes(id)), J([dm.code, dm.left]))
  // keepPinned: a pin makes a transient context permanent (one keep record), on files it survives the replay
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-view8s-'))
  try {
    const mk = () => S.createStore2({ host: 'A', fsx: fileFacet(dir), config: A.resolveConfig({ log_entries_per_agent: 50, log_retention_days: 7 }, {}) })
    const s1 = mk(); s1.start(T0); s1.open(T0)
    const c1 = s1.apply(LEAD, { agent: 'w1', label: 'Worker', text: '@go', state: 'running' }, T0 + 1000)
    const c2 = s1.apply(LEAD, { agent: 'w1', key: 'x', label: 'Bucket', transient: true }, T0 + 2000)
    const kp = s1.keepPinned([c2.node.id, 'zzzzzzzzzzzzzzzz', c1.node.id], T0 + 3000, { by: DASH })
    const n1 = M.getSession2(s1.state, LEAD).nodes.get(c2.node.id)
    check('keepPinned: the pinned transient context becomes permanent (an agent / unknown id ignored)', c2.ok && J(kp.kept.map(x => x.id)) === J([c2.node.id]) && n1.transient === false, J(kp))
    check('keepPinned: a second call writes nothing', s1.keepPinned([c2.node.id], T0 + 4000, { by: DASH }).kept.length === 0)
    const day = F.readDay(dir, 'A', F.recordDay({ ts: T0 + 3000 }))
    const kr = day.map(l => l.rec).filter(r => r && r.kind === 'node' && r.op === 'keep')
    check('keepPinned: ONE keep record on file, attributed (by the pinning user, act "pin")', kr.length === 1 && kr[0].n === c2.node.id && kr[0].act === 'pin' && kr[0].by && kr[0].by.user === 'robin', J(kr))
    const s2 = mk(); s2.start(T0 + 5000); s2.open(T0 + 5000)
    check('keepPinned: the replay keeps it permanent', M.getSession2(s2.state, LEAD)?.nodes.get(c2.node.id)?.transient === false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  // applySlice2: a delta's removals → left (minus what the same frame put back)
  const owner = S.createStore2({ host: 'OWN', config: { log_entries_per_agent: 50 } })
  let n2 = T0
  const oc = i => { const r = owner.apply(LEAD, i, n2 += 1000); if (!r.ok) throw new Error(J(r)); return r }
  const ow = oc({ agent: 'w1', label: 'Worker', text: '@go', state: 'running' })
  const ox = oc({ agent: 'w1', key: 'x', label: 'X', text: '@x' }), oy = oc({ agent: 'w1', key: 'y', label: 'Y', text: '@y' })
  const oz = oc({ agent: 'w1', key: 'z', label: 'Z', text: '@z', under: 'x' })
  const pub = G.createPub2(), remote = G.createRemote2({ origin: 'RCV' })
  let seq = 0
  const send = full => { const p = G.planSlice2(owner.state, pub, { full, units: G.gossipUnits2(owner.state) }); if (!p.body) return null; seq++; return G.applySlice2(remote, 'OWN', { ...p.body, epoch: 'e', seq, ...(full ? {} : { base: seq - 1 }) }) }
  send(true)
  owner.action({ ...LEAD, id: ox.node.id, action: 'merge', args: { into_id: oy.node.id } }, n2 += 1000, { by: DASH })
  const d1 = send(false)
  check('applySlice2: a merge delta reports the merged node as left — not its child, which the same frame re-sent under its new parent', d1 && d1.ok && J(d1.left) === J([ox.node.id]), J(d1))
  oc({ agent: 'w1', state: 'done', text: '@bye' })
  owner.action({ ...LEAD, id: ow.node.id, action: 'dismiss' }, n2 += 3600000, { by: DASH })
  const d2 = send(false)
  check('applySlice2: a dismissal delta reports the removed subtree (the topmost removal takes its held children)', d2 && d2.ok && [ow.node.id, oy.node.id, oz.node.id].every(id => (d2.left || []).includes(id)), J(d2))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
