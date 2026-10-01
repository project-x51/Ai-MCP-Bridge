// Fast UNIT tests for the pure lib/ modules — no bridge spawn, no sockets, milliseconds. This is the payoff
// of extracting the pure logic from bridge.mjs: topic matching / ref parsing / envelope id can be exercised
// directly. (Behaviour is also covered end-to-end by the live suites; this pins the units in isolation.)
import { splitTopic, isWildcard, topicMatch, patternsOverlap, patternKey, parseTopicRef } from '../lib/topics.js'
import { envelopeId } from '../lib/envelope.js'
import { createHash } from 'node:crypto'
import { TOOLS } from '../lib/tool-schemas.js'
import { createConsent, parseTtlMin } from '../lib/consent.js'
import { createReminders, effectiveDefaults } from '../lib/reminders.js'
import { createRealmDefaults, normRealmDefaults, mergeRealm, beatsRealm, realmFromConfig } from '../lib/realm-defaults.js'
import { createRetainedSet, normRetained, beatsRetained, retainedKey } from '../lib/retained.js'
import { createTraces } from '../lib/traces.js'
import { create as createEgress } from '../services/egress.js'
import { hostOf } from '../facets/discovery/tailscale.js'
import { makeResolver, envResolver } from '../lib/secret-resolver.js'
import { parseRegQuery } from '../lib/win-env.js'
import { procCapKeyInput, pageCapKeyInput } from '../lib/capkeys.js'
import { createProjectNames, normProjectName, beatsName } from '../lib/project-names.js'
import { create as createFilePersistence } from '../facets/persistence/file.js'
import fs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

// splitTopic: lower-cased, slash-split, empties dropped
check('splitTopic lowercases + splits', JSON.stringify(splitTopic('Retail/Contact-Energy')) === JSON.stringify(['retail', 'contact-energy']))
check('splitTopic drops empty segments', JSON.stringify(splitTopic('/a//b/')) === JSON.stringify(['a', 'b']))
check('patternKey canonicalises case', patternKey('Bills/Analysis') === 'bills/analysis')

// isWildcard
check('isWildcard true for + and #', isWildcard('a/+/b') && isWildcard('a/#') && !isWildcard('a/b'))

// topicMatch: concrete-under-pattern
check('topicMatch exact', topicMatch('a/b', 'a/b') && !topicMatch('a/b', 'a/c'))
check('topicMatch + one level', topicMatch('a/+/c', 'a/x/c') && !topicMatch('a/+/c', 'a/x/y/c'))
check('topicMatch # subtree', topicMatch('a/#', 'a/b/c') && topicMatch('a/#', 'a/b') && !topicMatch('a/#', 'b'))
check('topicMatch case-insensitive', topicMatch('A/B', 'a/b'))
check('topicMatch length mismatch fails', !topicMatch('a/b', 'a'))

// patternsOverlap: could any concrete topic match both?
check('patternsOverlap exact', patternsOverlap('a/b', 'a/b') && !patternsOverlap('a/b', 'a/c'))
check('patternsOverlap wildcard vs concrete', patternsOverlap('a/+', 'a/b') && patternsOverlap('a/#', 'a/b/c'))
check('patternsOverlap disjoint', !patternsOverlap('a/b', 'x/y'))

// parseTopicRef: bare = asker project; @project / @realm:project override; defaultRealm threaded (not a global)
check('parseTopicRef bare uses asker project + default realm', JSON.stringify(parseTopicRef('bills/x', 'CamelCo', 'default')) === JSON.stringify({ project: 'CamelCo', realm: 'default', path: 'bills/x' }))
check('parseTopicRef @project overrides project', (r => r.project === 'AIMB' && r.path === 'Bridge')(parseTopicRef('@AIMB/Bridge', 'CamelCo', 'default')))
check('parseTopicRef @realm:project overrides both', (r => r.realm === 'r2' && r.project === 'p2' && r.path === 'x/y')(parseTopicRef('@r2:p2/x/y', 'CamelCo', 'default')))
check('parseTopicRef has NO hidden global realm (uses the passed default)', parseTopicRef('t', 'p', 'custom-realm').realm === 'custom-realm')

// envelopeId: stable content hash over plaintext fields, dedupes identical, differs on change
const e1 = { from: { session: 's1' }, to: 'd', verb: 'note', subject: 'hi', pattern: 'send', topic: null, body: 'x', ts: '2026-01-01T00:00:00Z' }
check('envelopeId is env_<12hex>', /^env_[0-9a-f]{12}$/.test(envelopeId(e1)))
check('envelopeId stable for identical content', envelopeId(e1) === envelopeId({ ...e1 }))
check('envelopeId differs when body changes', envelopeId(e1) !== envelopeId({ ...e1, body: 'y' }))
check('#54: envelopeId covers from_topic (differs when present)', envelopeId(e1) !== envelopeId({ ...e1, from_topic: 'retail' }))
check('#54: a plain envelope\'s id is unchanged by the from_topic term', envelopeId(e1) === 'env_' + createHash('sha1').update('s1|d|note|hi|send|null|x|2026-01-01T00:00:00Z').digest('hex').slice(0, 12))

// tool-schemas: every entry well-formed + names unique (a moved-but-broken schema would surface here)
check('TOOLS all have name + object inputSchema', Array.isArray(TOOLS) && TOOLS.length > 10 && TOOLS.every(t => typeof t.name === 'string' && t.inputSchema && t.inputSchema.type === 'object'))
check('TOOLS names are unique', new Set(TOOLS.map(t => t.name)).size === TOOLS.length)

// ---- consent module (encapsulated state) — persist:false so no persistence is touched ----
{
  const c = createConsent({ persistence: {}, persist: false })
  c.setPolicy({ default: 'strict', allow: [] }, false)
  check('consent: same-project always open', c.mayInitiate('p', 'p'))
  check('consent: cross-project denied by default', !c.mayInitiate('a', 'b'))
  c.allow('a', 'b', 'send', null)
  check('consent: one-way grant allows a->b only', c.mayInitiate('a', 'b') && !c.mayInitiate('b', 'a'))
  check('consent: reachable lists the grant (case-insensitive key)', JSON.stringify(c.mayInitiate('A', 'B')) === 'true' && c.reachable('a').includes('b'))
  c.allow('x', 'y', 'bidirectional', null)
  check('consent: bidirectional grant allows both directions', c.mayInitiate('x', 'y') && c.mayInitiate('y', 'x'))
  check('consent: revoke removes the edge', c.revoke('a', 'b') === true && !c.mayInitiate('a', 'b'))
  // TTL expiry: an already-expired grant does not authorise; gc() reaps it
  c.allow('e', 'f', 'send', Date.now() - 1000)
  check('consent: expired grant does not authorise', !c.mayInitiate('e', 'f'))
  // pending access requests
  c.addPending('req_1', { reqId: 'req_1', from: 'a', to: 'b', ts: Date.now() })
  check('consent: pendingFor finds the request', c.pendingFor('A', 'B').some(p => p.reqId === 'req_1'))
  c.deletePending('req_1')
  check('consent: deletePending removes it', c.pendingFor('a', 'b').length === 0)
  // open realm
  const o = createConsent({ persistence: {}, persist: false }); o.setPolicy({ default: 'open' }, true)
  check('consent: open realm allows any cross-project + reachable=all', o.mayInitiate('a', 'b') && o.reachable('a') === 'all')
}
// ---- #62: replicated grant set, last-writer-wins merge ----
{
  const mk = (origin = 'h1') => { const c = createConsent({ persistence: {}, persist: false, origin }); c.setPolicy({ default: 'strict', allow: [] }, false); return c }
  const G = (updated_at, extra = {}) => ({ from: 'aimb', to: 'marz', mode: 'send', exp: null, updated_at, revoked: false, origin: 'h1', ...extra })
  const T = (updated_at, extra = {}) => G(updated_at, { revoked: true, exp: updated_at, ...extra })
  const allowed = c => c.mayInitiate('AIMB', 'Marz')
  const state = c => JSON.stringify(c.grantSet())
  let c = mk()
  check('#62 merge: a learned grant authorises + reports a change', c.merge([G(100)]) === 1 && allowed(c))
  check('#62 merge: newer record wins (mode upgraded by a newer grant)', c.merge([G(200, { mode: 'bidirectional' })]) === 1 && c.mayInitiate('marz', 'aimb'))
  check('#62 merge: an OLDER record is ignored', c.merge([G(150)]) === 0 && c.grantSet()[0].mode === 'bidirectional')
  check('#62 merge: a newer tombstone beats an older grant', c.merge([T(300)]) === 1 && !allowed(c) && c.grantSet()[0].revoked === true)
  check('#62 merge: an older grant cannot resurrect a tombstone', c.merge([G(250)]) === 0 && !allowed(c))
  check('#62 merge: a newer grant beats an older tombstone (re-grant)', c.merge([G(400)]) === 1 && allowed(c))
  // idempotent: merging the same set again changes nothing
  const before = state(c)
  check('#62 merge: idempotent (re-merging the same set changes nothing)', c.merge(c.grantSet()) === 0 && state(c) === before)
  // commutative: every order of the same records converges to the same state
  const recs = [G(10), T(20, { origin: 'h2' }), G(20, { origin: 'h3' }), G(15, { mode: 'bidirectional' }), { from: 'x', to: 'y', mode: 'send', updated_at: 5 }]
  const perms = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 3, 0, 4, 2]]
  const outs = perms.map(p => { const k = mk(); for (const i of p) k.merge([recs[i]]); return state(k) })
  check('#62 merge: commutative (any order converges to one state)', outs.every(o => o === outs[0]), JSON.stringify(outs))
  const batch = mk(); batch.merge(recs)
  check('#62 merge: one batch == one-at-a-time', state(batch) === outs[0])
  // tie rule: same updated_at -> the tombstone wins, whichever arrives first
  const t1 = mk(); t1.merge([G(50, { origin: 'zz' })]); t1.merge([T(50, { origin: 'aa' })])
  const t2 = mk(); t2.merge([T(50, { origin: 'aa' })]); t2.merge([G(50, { origin: 'zz' })])
  check('#62 tie: on equal updated_at the tombstone wins (both orders)', !allowed(t1) && !allowed(t2) && state(t1) === state(t2))
  const o1 = mk(); o1.merge([G(60, { origin: 'a', mode: 'send' })]); o1.merge([G(60, { origin: 'b', mode: 'bidirectional' })])
  const o2 = mk(); o2.merge([G(60, { origin: 'b', mode: 'bidirectional' })]); o2.merge([G(60, { origin: 'a', mode: 'send' })])
  check('#62 tie: then the greater origin wins, deterministically', state(o1) === state(o2) && o1.grantSet()[0].origin === 'b')
  // expiry: a learned grant past its exp never authorises; gc turns it into a tombstone that still beats an older grant
  const e = mk(); e.merge([G(70, { exp: Date.now() - 1000 })])
  check('#62 expiry: a learned expired grant does not authorise', !allowed(e) && !e.reachable('aimb').includes('marz'))
  e.gc()
  check('#62 expiry: gc tombstones an expired grant, which still beats an older grant', e.grantSet()[0].revoked === true && e.merge([G(65)]) === 0 && !allowed(e))
  const f = mk(); f.merge([G(80, { exp: Date.now() + 60000 })])
  check('#62 expiry: an unexpired learned grant authorises', allowed(f))
  // legacy record (<=1.44 durable form): no updated_at -> dates from granted_at, and any newer write beats it
  const l = mk(); l.merge([{ from: 'AIMB', to: 'Marz', mode: 'send', exp: null, granted_at: '2026-01-01T00:00:00.000Z' }])
  check('#62 legacy: a record without updated_at is accepted, dated from granted_at', allowed(l) && l.grantSet()[0].updated_at === Date.parse('2026-01-01T00:00:00.000Z'))
  check('#62 legacy: a newer tombstone beats it', l.merge([T(Date.parse('2026-02-01'))]) === 1 && !allowed(l))
  const l0 = mk(); l0.merge([{ from: 'aimb', to: 'marz', mode: 'send' }])
  check('#62 legacy: no updated_at AND no granted_at -> 0 (any stamped write beats it)', l0.grantSet()[0].updated_at === 0 && l0.merge([T(1)]) === 1)
  // local writes: revoke tombstones (and replicates), re-allow beats the tombstone even if the clock lags it
  const w = mk('me'); w.allow('a', 'b', 'send', null)
  check('#62 local: revoke writes a tombstone (not a delete) and returns had', w.revoke('a', 'b') === true && w.grantSet().length === 1 && w.grantSet()[0].revoked === true && !w.mayInitiate('a', 'b'))
  w.merge([{ from: 'a', to: 'b', mode: 'send', revoked: true, exp: Date.now() + 1e9, updated_at: Date.now() + 1e9, origin: 'skewed' }])
  const re = w.allow('a', 'b', 'send', null)
  check('#62 local: a local allow beats a future-stamped tombstone (stamp = max(now, known+1))', w.mayInitiate('a', 'b') && re.origin === 'me')
  check('#62 local: revoke of an unknown edge still tombstones it (returns false)', w.revoke('q', 'r') === false && w.grantSet().some(g => g.from === 'q' && g.revoked))
  // tombstone GC honours the TTL
  const gcC = createConsent({ persistence: {}, persist: false, tombstoneTtlMs: 1000 })
  gcC.merge([T(Date.now() - 5000), { from: 'k', to: 'l', mode: 'send', revoked: true, exp: Date.now(), updated_at: Date.now() }])
  gcC.gc()
  check('#62 gc: tombstones older than the TTL are dropped, fresh ones kept', gcC.grantSet().length === 1 && gcC.grantSet()[0].from === 'k')
  check('#62 merge: junk records are ignored', mk().merge([null, 5, {}, { from: 'a' }, 'x']) === 0 && mk().merge(undefined) === 0)
}
check('parseTtlMin durations',parseTtlMin('24h') === 1440 && parseTtlMin('7d') === 10080 && parseTtlMin('30m') === 30 && parseTtlMin(45) === 45)
check('parseTtlMin forever/invalid -> null', parseTtlMin('forever') === null && parseTtlMin(0) === null && parseTtlMin('') === null && parseTtlMin('nope') === null)

// ---- reminders module (encapsulated state) — #44 operation-aware ----
{
  const r = createReminders({ persistence: {}, persist: false })
  const ME = 'peer:me', id = { realm: 'default', project: 'P', user: 'u', name: 'Me' }
  // receive context (operation 'receive', matches the SENDER); send/others match the TARGET
  const dctx = (from, topic) => ({ operation: 'receive', project: from && from.project, host: String((from && from.session) || '').split('/')[0], topic, fromSelf: from && from.session === ME, system: false })
  check('reminders: set ok + count (operation defaults to receive)', r.set(ME, id, undefined, 'topic', 'a/b', 'do x').count === 1)
  check('reminders: a set with no operation stores receive', r.list(ME)[0].operation === 'receive')
  // #47: 'deliver' is a legacy alias — accepted on input, folded to the canonical 'receive'
  check("#47: operation 'deliver' is accepted and folded to 'receive'", r.set(ME, id, 'deliver', 'topic', 'a/b', 'do x2').operation === 'receive' && r.list(ME)[0].operation === 'receive')
  check('reminders: bad scope rejected', r.set(ME, id, 'receive', 'nope', 'do').code === 'bad-scope')
  check('reminders: bad OPERATION rejected (#44)', r.set(ME, id, 'nonsense-op', 'all', null, 'x').code === 'bad-operation')
  check('reminders: over-long rejected', r.set(ME, id, 'receive', 'all', null, 'x'.repeat(400)).code === 'behavior-too-long')
  // v1.33: cap raised 280 -> 365. A 300-char reminder (rejected pre-1.33) is now accepted; 365 ok, 366 not. Use a throwaway holder so ME's later count assertions are untouched.
  check('reminders: 300-char reminder accepted at the raised cap', r.set('peer:lentest', id, 'receive', 'all', null, 'y'.repeat(300)).ok === true)
  check('reminders: cap boundary is 365 (365 ok, 366 rejected)', r.set('peer:lentest', id, 'receive', 'all', null, 'z'.repeat(365)).ok === true && r.set('peer:lentest', id, 'receive', 'all', null, 'z'.repeat(366)).code === 'behavior-too-long')
  check('reminders: match required for non-all', r.set(ME, id, 'receive', 'topic', '', 'x').code === 'match-required')
  r.set(ME, id, 'receive', 'project', 'Acme', 'ack ops'); r.set(ME, id, 'receive', 'all', null, 'be brief')
  const rs = r.remindersFor(ME, dctx({ session: 'peer:sender', project: 'Acme', name: 'S' }, 'a/b'))
  check('reminders: matches topic + project + all (most-specific first)', rs.length === 3 && rs.map(x => x.scope).join(',') === 'topic,project,all')
  check("reminders: 'all' skips self-sent", r.remindersFor(ME, dctx({ session: ME }, null)).length === 0)
  check('reminders: list returns all three', r.list(ME).length === 3)
  // #44: an outbound (send) reminder is a DIFFERENT key from the same scope+match on receive, and they don't cross
  r.set(ME, id, 'send', 'project', 'Acme', 'use the SENT glyph')
  const onSend = r.remindersFor(ME, { operation: 'send', project: 'Acme' })
  check('#44: send-op reminder fires on the send operation', onSend.length === 1 && onSend[0].behavior === 'use the SENT glyph' && onSend[0].operation === 'send')
  check('#44: send reminder does NOT leak onto receive', !r.remindersFor(ME, dctx({ session: 'peer:x', project: 'Acme' }, null)).some(x => x.operation === 'send'))
  check('#44: receive reminder does NOT leak onto send', !r.remindersFor(ME, { operation: 'send', project: 'Acme' }).some(x => x.scope === 'all'))
  check('#44: same scope+match on two operations COEXIST', r.list(ME).filter(b => b.scope === 'project' && b.match === 'Acme').length === 2)
  check('#44: clear targets ONE operation only', r.clear(ME, id, 'send', 'project', 'Acme').cleared === 1 && r.list(ME).filter(b => b.match === 'Acme').length === 1)
  check('reminders: clear one (receive)', r.clear(ME, id, 'receive', 'project', 'Acme').cleared === 1 && r.list(ME).length === 2)
  check('reminders: clear all', r.clear(ME, id).cleared === 2 && r.list(ME).length === 0)
  // #26 x #29 inheritance: only RECEIVE topic reminders ride a kept-alive handoff
  r.set(ME, id, 'receive', 'topic', 'reviews/api', 'review in 1 day')
  r.set(ME, id, 'send', 'topic', 'reviews/api', 'outbound-only, must NOT be inherited')
  const carried = r.topicBehaviors(ME, 'reviews/api')
  check('reminders: topicBehaviors carries only the RECEIVE topic reminder', carried.length === 1 && /review in 1 day/.test(carried[0]))
  const HEIR = 'peer:heir'
  r.inherit(HEIR, { ...id, name: 'Heir' }, 'reviews/api', carried)
  check('reminders: inherit lands a receive topic reminder on the heir', r.list(HEIR).some(b => b.scope === 'topic' && b.match === 'reviews/api' && b.operation === 'receive'))
}
// #32 config DEFAULT behaviours (now operation-aware, #44)
{
  const r = createReminders({ persistence: {}, persist: false })
  const dctx = (from, topic) => ({ operation: 'receive', project: from && from.project, host: String((from && from.session) || '').split('/')[0], topic, fromSelf: false, system: false })
  r.setDefaults([{ scope: 'all', match: null, behavior: 'Summarize; ask first' }])
  check('default: defaultList returns the configured default (operation receive)', r.defaultList().length === 1 && /Summarize/.test(r.defaultList()[0].behavior) && r.defaultList()[0].operation === 'receive')
  const ds = r.remindersFor('peer:fresh', dctx({ session: 'peer:sender', project: 'P' }, 'a/b'))
  check('default: fires for a session with none of its own, tagged default:true', ds.length === 1 && ds[0].default === true && ds[0].scope === 'all')
  r.set('peer:own', { realm: 'default', project: 'P', user: 'u', name: 'O' }, 'receive', 'all', null, 'my own rule')
  const os = r.remindersFor('peer:own', dctx({ session: 'peer:sender', project: 'P' }, 'a/b'))
  check('default: a session OWN all-scope overrides the default', os.length === 1 && os[0].default === undefined && /my own rule/.test(os[0].behavior))
  check('default: default all-scope still skips self-sent', r.remindersFor('peer:fresh', { operation: 'receive', fromSelf: true, topic: null }).length === 0)
  r.setDefaults([{ scope: 'all', behavior: 'one' }, { scope: 'all', behavior: 'two' }])
  check('default: setDefaults dedupes by operation+scope+match (last wins)', r.defaultList().length === 1 && r.defaultList()[0].behavior === 'two')
  // #44: an operator default can target an OUTBOUND operation
  r.setDefaults([{ operation: 'send', scope: 'all', behavior: 'log every send' }])
  check('#44: a send-operation default fires on send', r.remindersFor('peer:any', { operation: 'send', project: 'Z' }).some(x => x.operation === 'send' && x.default === true))
  check('#44: that send default does NOT fire on receive', r.remindersFor('peer:any', dctx({ session: 'peer:s', project: 'Z' }, null)).length === 0)
}

// ---- #66b: realm-wide default reminders — ONE replicated last-writer-wins record ----
{
  const E = (op, scope, match, behavior) => ({ operation: op, scope, match, behavior })
  const R = (ts, list, origin = 'h') => ({ updated_at: ts, default: list, origin })
  const L1 = [E('connect', 'client', 'code', 'ring the doorbell')], L2 = [E('connect', 'client', 'code', 'ring it LOUDER')]
  const text = r => r && r.default.map(d => d.behavior).join('|')
  check('#66b merge: a first record is adopted', text(mergeRealm(null, R(100, L1))) === 'ring the doorbell')
  check('#66b merge: a newer updated_at wins', text(mergeRealm(mergeRealm(null, R(100, L1)), R(200, L2))) === 'ring it LOUDER')
  check('#66b merge: an OLDER updated_at does not override', text(mergeRealm(mergeRealm(null, R(200, L2)), R(100, L1))) === 'ring it LOUDER')
  check('#66b merge: ISO updated_at (the config form) orders like ms', text(mergeRealm(mergeRealm(null, R('2026-09-30T10:00:00Z', L1)), R('2026-09-30T09:00:00Z', L2))) === 'ring the doorbell'
    && normRealmDefaults(R('2026-09-30T10:00:00Z', L1)).updated_at === Date.parse('2026-09-30T10:00:00Z'))
  const held = mergeRealm(null, R(300, L1))
  check('#66b merge: idempotent (re-merging the held record keeps the SAME object)', mergeRealm(held, held) === held && mergeRealm(held, JSON.parse(JSON.stringify(held))) === held)
  // tie rule: equal updated_at -> the greater canonical list JSON, then the greater origin; both orders agree
  const a = R(500, L1, 'x'), b = R(500, L2, 'y'), c = R(500, L1, 'z')
  const w1 = mergeRealm(mergeRealm(null, a), b), w2 = mergeRealm(mergeRealm(null, b), a)
  check('#66b tie: equal updated_at -> the same survivor in both orders', JSON.stringify(w1) === JSON.stringify(w2))
  const o1 = mergeRealm(mergeRealm(null, a), c), o2 = mergeRealm(mergeRealm(null, c), a)
  check('#66b tie: same list -> the greater origin, deterministically', o1.origin === 'z' && o2.origin === 'z')
  check('#66b tie: beatsRealm never lets a record beat itself', !beatsRealm(normRealmDefaults(a), normRealmDefaults(a)))
  // commutative across every order of a batch
  const recs = [R(100, L1, 'p'), R(700, L2, 'q'), R(700, L1, 'r'), R(400, [E('publish', 'all', null, 'p')], 's'), R(700, L2, 'a')]
  const perms = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2], [3, 2, 1, 4, 0]]
  const outs = perms.map(p => JSON.stringify(p.reduce((cur, i) => mergeRealm(cur, recs[i]), null)))
  check('#66b merge: commutative (every order converges to one record)', outs.every(o => o === outs[0]), JSON.stringify(outs))
  // canonical form: order-insensitive + normalised with the behaviors.default rules
  const n1 = normRealmDefaults(R(1, [E('send', 'all', null, 's'), E('connect', 'client', 'code', 'c')])), n2 = normRealmDefaults(R(1, [E('connect', 'client', 'code', 'c'), E('send', 'all', null, 's')]))
  check('#66b norm: entry order does not matter (canonical JSON)', JSON.stringify(n1) === JSON.stringify(n2))
  const nv = normRealmDefaults(R(1, [{ behavior: 'bare' }, { scope: 'bogus', behavior: 'b2' }, { operation: 'deliver', scope: 'topic', match: 'a/b', behavior: 'd' }, { scope: 'all' }, 'junk']))
  check('#66b norm: same validation as behaviors.default (op->receive, bad scope->all, deliver->receive, no-behavior dropped)',
    nv.default.length === 2 && nv.default.every(d => d.operation === 'receive') && nv.default.some(d => d.scope === 'topic' && d.match === 'a/b'), JSON.stringify(nv))
  check('#66b norm: a string default = one all-scope receive default', JSON.stringify(normRealmDefaults(R(1, 'be nice')).default) === JSON.stringify([E('receive', 'all', null, 'be nice')]))
  check('#66b norm: text capped at 365, list capped at 64', normRealmDefaults(R(1, [E('receive', 'all', null, 'x'.repeat(999))])).default[0].behavior.length === 365
    && normRealmDefaults(R(1, Array.from({ length: 90 }, (_, i) => E('receive', 'host', 'h' + i, 'b')))).default.length === 64)
  // junk input: never adopted, never throws
  const junk = [null, undefined, 5, 'x', [], {}, { default: L1 }, R(0, L1), R(-5, L1), R('not a date', L1), R(NaN, L1), R(100, null), R(100, 7), R(100, { a: 1 })]
  check('#66b merge: junk records are ignored', junk.every(j => mergeRealm(null, j) === null) && junk.every(j => mergeRealm(held, j) === held))
  // config candidate: needs an explicit updated_at; a block without `default` = an empty list (clears)
  check('#66b config: behaviors.realm -> candidate tagged with this host as origin', (() => { const r = realmFromConfig({ behaviors: { realm: { updated_at: '2026-09-30T00:00:00Z', default: L1 } } }, 'ROBIN'); return r && r.origin === 'ROBIN' && text(r) === 'ring the doorbell' })())
  check('#66b config: no updated_at -> ignored (never the file mtime)', realmFromConfig({ behaviors: { realm: { default: L1 } } }, 'h') === null && realmFromConfig({}, 'h') === null)
  check('#66b config: a block with no default list = an empty realm list', JSON.stringify(realmFromConfig({ behaviors: { realm: { updated_at: 5 } } }, 'h').default) === '[]')
  // the stateful wrapper: persists + fires onChange on a win only; rehydrate picks the LWW winner of the stored copies
  const stored = [], seen = []
  const rd = createRealmDefaults({ persistence: { realmDefaults: { put: async (w, r) => { stored.push([w, r]) }, all: async () => [] } }, persist: true, writer: 'HOST', onChange: r => seen.push(text(r)) })
  check('#66b module: a win persists (per writer) + notifies', rd.merge(R(10, L1)) === true && stored.length === 1 && stored[0][0] === 'HOST' && seen.join() === 'ring the doorbell')
  check('#66b module: a loss changes nothing (no write, no notify)', rd.merge(R(5, L2)) === false && stored.length === 1 && seen.length === 1)
  check('#66b module: current() is a copy', (() => { const c1 = rd.current(); c1.default[0].behavior = 'mutated'; return text(rd.current()) === 'ring the doorbell' })())
  const rd2 = createRealmDefaults({ persistence: { realmDefaults: { put: async () => {}, all: async () => [R(10, L1, 'a'), R(30, L2, 'b'), { junk: 1 }, R(20, L1, 'c')] } }, persist: true, writer: 'H', onChange: r => seen.push('re:' + text(r)) })
  await rd2.rehydrate()
  check('#66b module: rehydrate keeps the newest stored copy', rd2.current().updated_at === 30 && text(rd2.current()) === 'ring it LOUDER' && seen.at(-1) === 're:ring it LOUDER')
}
// #66b effective defaults: realm defaults layered UNDER the local behaviors.default (local key wins; realm fills gaps)
{
  const E = (op, scope, match, behavior) => ({ operation: op, scope, match, behavior })
  const eff = effectiveDefaults([E('connect', 'client', 'code', 'LOCAL'), E('send', 'all', null, 'L-send')], [E('connect', 'client', 'CODE', 'REALM'), E('publish', 'all', null, 'R-pub')])
  check('#66b effective: a LOCAL entry beats the realm one for the same (operation,scope,match) key (case-insensitive match)',
    eff.filter(d => d.operation === 'connect').length === 1 && eff.find(d => d.operation === 'connect').behavior === 'LOCAL' && !eff.find(d => d.operation === 'connect').realm)
  check('#66b effective: the realm fills the gaps (tagged realm:true)', eff.some(d => d.operation === 'publish' && d.behavior === 'R-pub' && d.realm === true) && eff.some(d => d.behavior === 'L-send' && !d.realm))
  const r = createReminders({ persistence: {}, persist: false })
  r.setRealmDefaults([E('connect', 'client', 'code', 'REALM-CONNECT'), E('send', 'all', null, 'REALM-SEND')])
  const c0 = r.remindersFor('peer:x', { operation: 'connect', client_kind: 'code' })
  check('#66b reminders: a realm default fires with default:true + realm:true', c0.length === 1 && c0[0].behavior === 'REALM-CONNECT' && c0[0].default === true && c0[0].realm === true)
  r.setDefaults([E('connect', 'client', 'code', 'LOCAL-CONNECT')])
  const c1 = r.remindersFor('peer:x', { operation: 'connect', client_kind: 'code' })
  check('#66b reminders: a local default replaces the realm one for its key (and survives a later realm update)', (() => {
    r.setRealmDefaults([E('connect', 'client', 'code', 'REALM-CONNECT-2'), E('send', 'all', null, 'REALM-SEND')])
    const c2 = r.remindersFor('peer:x', { operation: 'connect', client_kind: 'code' })
    return c1.length === 1 && c1[0].behavior === 'LOCAL-CONNECT' && !c1[0].realm && c2.length === 1 && c2[0].behavior === 'LOCAL-CONNECT'
  })())
  check('#66b reminders: defaultList() = the effective set (realm gap-filler tagged)', r.defaultList().length === 2 && r.defaultList().some(d => d.behavior === 'REALM-SEND' && d.realm === true) && r.defaultList().some(d => d.behavior === 'LOCAL-CONNECT' && !d.realm))
  r.set('peer:own', { realm: 'default', project: 'P', user: 'u', name: 'O' }, 'send', 'all', null, 'MY-SEND')
  const s0 = r.remindersFor('peer:own', { operation: 'send', project: 'Z' })
  check('#66b reminders: a session\'s OWN reminder beats the realm default', s0.length === 1 && s0[0].behavior === 'MY-SEND' && !s0[0].default)
  r.setRealmDefaults([])
  check('#66b reminders: an empty realm list clears the realm entries only', r.defaultList().length === 1 && r.defaultList()[0].behavior === 'LOCAL-CONNECT')
}

// #66c retained values: a replicated last-writer-wins set keyed by (realm, project, topic)
{
  const env = (id, body = 'x') => ({ id, ts: 'z', body })
  const R = (ts, id, o = {}) => ({ realm: 'default', project: 'News', topic: 'news/live', ts, env: env(id), origin: 'H', ...o })
  check('#66c key: project + topic are case-insensitive', retainedKey(R(1, 'a')) === retainedKey(R(1, 'a', { project: 'NEWS', topic: 'News/Live' })))
  check('#66c norm: junk / wildcard / no-ts / no-env records are refused',
    [null, 5, [], {}, R(0, 'a'), R(NaN, 'a'), R(1, 'a', { topic: 'news/#' }), R(1, 'a', { project: '' }), R(1, 'a', { env: null }), R(1, 'a', { env: { body: 1 } })].every(r => normRetained(r) === null))
  const big = normRetained(R(5, 'b', { env: env('b', 'y'.repeat(2000)) }), 1000)
  check('#66c norm: an envelope over the cap becomes a too-large MARKER (no env)', big && big.env === null && big.too_large > 1000, JSON.stringify(big && { ...big, env: !!big.env }))
  check('#66c beats: newer ts wins, older loses, identical never beats', beatsRetained(normRetained(R(2, 'a')), normRetained(R(1, 'z'))) && !beatsRetained(normRetained(R(1, 'z')), normRetained(R(2, 'a'))) && !beatsRetained(normRetained(R(1, 'a')), normRetained(R(1, 'a'))))
  check('#66c beats: a ts tie is broken by envelope id (both orders agree)', beatsRetained(normRetained(R(1, 'b')), normRetained(R(1, 'a'))) && !beatsRetained(normRetained(R(1, 'a')), normRetained(R(1, 'b'))))
  const stored = []
  const mk = (o = {}) => createRetainedSet({ persistence: { retained: { put: async (p, t, id, rec) => { stored.push({ p, t, id, rec }) }, all: async () => [] } }, persist: true, writer: 'HOSTX', ttlMs: 60000, ...o })
  const s = mk()
  check('#66c set: a learned record is adopted + persisted under the #replicated/<writer> identity', s.merge([R(Date.now() - 10, 'a')]) === 1 && stored.length === 1 && stored[0].id.user === '#replicated' && stored[0].id.name === 'HOSTX' && stored[0].rec.env.id === 'a')
  const v0 = s.version()
  check('#66c set: an older value changes nothing (no write, same version)', s.merge([R(Date.now() - 5000, 'z')]) === 0 && stored.length === 1 && s.version() === v0)
  check('#66c set: a re-merge of the same record is idempotent', s.merge([R(stored[0].rec ? Date.parse(stored[0].rec.ts) : 0, 'a')]) === 0 && s.version() === v0)
  check('#66c set: a newer publish replaces it (version bumps)', s.merge([R(Date.now(), 'n')]) === 1 && s.version() === v0 + 1 && s.forProject('default', 'news')[0].env.id === 'n')
  check('#66c set: a local publish (persist:false) is held but not re-written', s.merge([R(Date.now() + 5, 'loc', { topic: 'news/other' })], { persist: false }) === 1 && stored.length === 2 && s.size() === 2)
  check('#66c set: forProject filters by realm + project', s.forProject('default', 'Other').length === 0 && s.forProject('realm2', 'News').length === 0 && s.forProject('default', 'NEWS').length === 2)
  check('#66c set: get() returns the held record', s.get('default', 'news', 'NEWS/OTHER').env.id === 'loc' && s.get('default', 'news', 'nope') === null)
  check('#66c TTL: an expired record is refused on merge', s.merge([R(Date.now() - 120000, 'old', { topic: 'news/stale' })]) === 0 && !s.get('default', 'news', 'news/stale'))
  const t = mk({ ttlMs: 50 })
  t.merge([R(Date.now(), 'a')])
  await new Promise(r => setTimeout(r, 80))
  check('#66c TTL: a record that ages out is not listed or served, and gc() drops it', t.list().length === 0 && t.forProject('default', 'news').length === 0 && t.gc() === 1 && t.size() === 0)
  const m = mk({ maxBytes: 1000 })
  m.merge([R(Date.now() - 50, 'small')])
  check('#66c cap: a too-large newer value replaces the older one with a marker (no stale value survives)', m.merge([R(Date.now(), 'huge', { env: env('huge', 'y'.repeat(5000)) })]) === 1 && m.get('default', 'news', 'news/live').env === null && m.get('default', 'news', 'news/live').too_large > 1000)
  const g = mk({ gossipMaxBytes: 300 })
  g.merge([R(Date.now() - 20, 'o1', { topic: 'a/1', env: env('o1', 'p'.repeat(200)) }), R(Date.now() - 10, 'o2', { topic: 'a/2', env: env('o2', 'p'.repeat(200)) })])
  check('#66c gossip budget: newest first, older beyond the budget stay local', g.list().length === 1 && g.list()[0].env.id === 'o2' && g.size() === 2)
  const orders = [[R(3, 'c'), R(1, 'a'), R(2, 'b')], [R(1, 'a'), R(2, 'b'), R(3, 'c')], [R(2, 'b'), R(3, 'c'), R(1, 'a')]].map(l => { const x = mk({ ttlMs: 0 }); for (const r of l) x.merge([r]); return x.get('default', 'news', 'news/live').env.id })
  check('#66c merge: commutative (every order converges)', orders.every(o => o === 'c'), JSON.stringify(orders))
  const rh = createRetainedSet({ persistence: { retained: { put: async () => {}, all: async () => [
    { project: 'News', topic: 'news/live', record: { ts: new Date(Date.now() - 1000).toISOString(), env: env('st') } },
    { project: 'News', topic: 'news/big', record: { ts: new Date(Date.now() - 1000).toISOString(), env: null, too_large: 99999 } },
    { junk: 1 }] } }, persist: true, writer: 'W', realm: 'default', ttlMs: 60000 })
  await rh.rehydrate()
  check('#66c rehydrate: stored values + markers come back from the store', rh.get('default', 'news', 'news/live')?.env?.id === 'st' && rh.get('default', 'news', 'news/big')?.too_large === 99999 && rh.size() === 2)
}

// ---- traces module (owns the ring buffer + dashboard fan-out) ----
{
  const sent = []
  const t = createTraces({ broadcast: m => sent.push(m), cap: 3 })
  t.collect({ verb: 'a' })
  check('traces: collect broadcasts a {type:trace} message', sent.length === 1 && JSON.parse(sent[0]).type === 'trace' && JSON.parse(sent[0]).trace.verb === 'a')
  check('traces: history holds the collected trace', t.history().length === 1 && t.history()[0].verb === 'a')
  t.collect({ verb: 'b' }); t.collect({ verb: 'c' }); t.collect({ verb: 'd' })
  check('traces: ring is capped (oldest dropped)', t.history().length === 3 && t.history().map(x => x.verb).join('') === 'bcd')
  check('traces: history is a copy (mutating it does not corrupt the ring)', (() => { const h = t.history(); h.push({ verb: 'x' }); return t.history().length === 3 })())
}

// ---- egress service (#33): named-backend HTTP proxy with project allowlist + origin containment (fake fetch) ----
{
  const fakeRes = (status, body, ct = 'text/plain') => ({
    ok: status >= 200 && status < 300, status, statusText: 'X',
    headers: { _h: { 'content-type': ct }, get(k) { return this._h[k.toLowerCase()] }, forEach(fn) { for (const [k, v] of Object.entries(this._h)) fn(v, k) } },
    async arrayBuffer() { return new TextEncoder().encode(body).buffer },
  })
  let last = null
  const fakeFetch = async (url, opts) => { last = { url, opts }; return fakeRes(200, 'ok ' + url) }
  const e = createEgress({ fetchImpl: fakeFetch, config: { backends: { be: { base: 'http://localhost:8080', methods: ['GET', 'POST'], projects: ['ops'], allowHeaders: ['x-test'], headers: { 'x-api-key': 'secret' } } } } })
  const call = (a, project = 'ops') => e.handle('http_request', a, { project, holder: 'h', name: 'H' })
  check('egress: exposes http_request tool', e.tools.some(t => t.name === 'http_request'))
  check('egress: unknown backend', (await call({ backend: 'nope' })).code === 'unknown-backend')
  check('egress: project not allowed -> forbidden', (await call({ backend: 'be' }, 'other')).code === 'forbidden')
  check('egress: project allowlist is case-insensitive', (await call({ backend: 'be', path: '/x' }, 'OPS')).ok === true)
  check('egress: method not allowed', (await call({ backend: 'be', method: 'DELETE' })).code === 'method-not-allowed')
  check('egress: absolute-URL path rejected', (await call({ backend: 'be', path: 'http://evil/x' })).code === 'bad-path')
  check('egress: //host path rejected', (await call({ backend: 'be', path: '//evil.com/x' })).code === 'bad-path')
  check('egress: ".." escape rejected', (await call({ backend: 'be', path: '/a/../../x' })).code === 'bad-path')
  const r = await call({ backend: 'be', path: '/foo', query: { q: '1' }, headers: { 'x-test': '1', 'x-evil': '2' } })
  check('egress: GET ok + URL contained to base origin', r.ok && last.url === 'http://localhost:8080/foo?q=1')
  check('egress: caller headers filtered to allowHeaders', last.opts.headers['x-test'] === '1' && !('x-evil' in last.opts.headers))
  check('egress: server-side header injected and NOT echoed', last.opts.headers['x-api-key'] === 'secret' && !JSON.stringify(r).includes('x-api-key'))
  const rp = await call({ backend: 'be', method: 'POST', path: '/p', json: { a: 1 } })
  check('egress: POST json sets body + content-type', rp.ok && last.opts.method === 'POST' && last.opts.body === '{"a":1}' && last.opts.headers['content-type'] === 'application/json')
  const e2 = createEgress({ fetchImpl: async () => fakeRes(200, 'PNGDATA', 'image/png'), config: { backends: { be: { base: 'http://localhost:8080', methods: ['GET'], projects: ['ops'] } } } })
  const rb = await e2.handle('http_request', { backend: 'be', path: '/img' }, { project: 'ops' })
  check('egress: binary response returned as base64', rb.encoding === 'base64' && typeof rb.body === 'string')
}

// ---- #36: secret-resolver — ${scheme:key} refs so secrets live outside config text ----
{
  const r = makeResolver({ env: k => ({ TOK: 'abc', PW: 'p@ss' })[k] })
  check('resolver: full ${env:VAR}', r('${env:TOK}') === 'abc')
  check('resolver: embedded ref', r('Bearer ${env:TOK}!') === 'Bearer abc!')
  check('resolver: deep object/array', JSON.stringify(r({ a: '${env:PW}', b: [1, '${env:TOK}'] })) === JSON.stringify({ a: 'p@ss', b: [1, 'abc'] }))
  check('resolver: non-ref passthrough', r('plain') === 'plain' && r(5) === 5)
  check('resolver: missing env throws secret-unresolved', (() => { try { r('${env:NOPE}'); return false } catch (e) { return e.code === 'secret-unresolved' } })())
  check('resolver: unwired scheme throws (vault seam)', (() => { try { r('${vault:k}'); return false } catch (e) { return e.code === 'secret-scheme-unsupported' } })())
}

// ---- #36: egress server-side auth — bridge mints/caches/refreshes/injects the token; caller never sees it ----
{
  const jsonRes = (status, obj) => ({
    ok: status >= 200 && status < 300, status, statusText: 'X',
    headers: { _h: { 'content-type': 'application/json' }, get(k) { return this._h[k.toLowerCase()] }, forEach(fn) { for (const [k, v] of Object.entries(this._h)) fn(v, k) } },
    async arrayBuffer() { return new TextEncoder().encode(JSON.stringify(obj)).buffer },
    async json() { return obj },
  })
  const MINT = 'http://auth.local/mint', API = 'http://api.local'
  const resolveSecret = envResolver({ PW: 'dev-password' })
  let mintCount = 0, sentAuth = [], plan = {}
  const fetchImpl = async (url, opts) => {
    if (url.startsWith(MINT)) {
      mintCount++
      plan.mintBodyPw = JSON.parse(opts.body || '{}').password    // proves ${env:PW} resolved into the mint request
      if (plan.mintFail) return jsonRes(401, { error: 'bad' })
      return jsonRes(200, { idToken: 'tok-' + mintCount, expiresIn: String(plan.expiresIn ?? 3600) })
    }
    sentAuth.push((opts.headers || {})['Authorization'])
    if (plan.api401Once && !plan.api401Done) { plan.api401Done = true; return jsonRes(401, { e: 'stale' }) }
    return jsonRes(200, { ok: true })
  }
  const httpBackend = () => ({ base: API, methods: ['GET'], projects: ['ops'], allowHeaders: ['authorization'],
    auth: { inject: { header: 'Authorization', format: 'Bearer {token}' }, refreshOn401: true,
      source: { type: 'http', url: MINT, method: 'POST', json: { email: 'dev@x', password: '${env:PW}', returnSecureToken: true }, tokenPath: 'idToken', expiryPath: 'expiresIn' } } })
  const mk = backend => createEgress({ fetchImpl, resolveSecret, config: { backends: { be: backend } } })
  const call = (eg, a = {}) => eg.handle('http_request', { backend: 'be', path: '/x', ...a }, { project: 'ops', holder: 'h', name: 'H' })

  mintCount = 0; sentAuth = []; plan = {}
  let eg = mk(httpBackend())
  const r1 = await call(eg)
  check('#36: http-auth mints + injects Bearer token', r1.ok && sentAuth.at(-1) === 'Bearer tok-1')
  check('#36: credential reached the mint request (${env:PW} resolved)', plan.mintBodyPw === 'dev-password')
  check('#36: token + credential NOT in the caller response', !JSON.stringify(r1).includes('tok-1') && !JSON.stringify(r1).includes('dev-password'))
  await call(eg)
  check('#36: token cached across calls (single mint)', mintCount === 1)
  sentAuth = []; await call(eg, { headers: { Authorization: 'Bearer HACK' } })
  check('#36: caller cannot override the injected auth header', sentAuth.at(-1) === 'Bearer tok-1')

  mintCount = 0; sentAuth = []; plan = { api401Once: true }
  eg = mk(httpBackend())
  const r401 = await call(eg)
  check('#36: 401 -> invalidate + re-mint + retry once', r401.ok && mintCount === 2 && sentAuth[0] === 'Bearer tok-1' && sentAuth[1] === 'Bearer tok-2')

  mintCount = 0; plan = { expiresIn: 0 }
  eg = mk(httpBackend()); await call(eg); await call(eg)
  check('#36: expired token re-minted on next call', mintCount === 2)

  mintCount = 0; plan = { mintFail: true }
  const rf = await call(mk(httpBackend()))
  check('#36: mint failure -> auth-failed, no credential leak', rf.ok === false && rf.code === 'auth-failed' && !JSON.stringify(rf).includes('dev-password'))

  sentAuth = []; mintCount = 0
  const egS = createEgress({ fetchImpl, resolveSecret: envResolver({ T: 'statictok' }), config: { backends: { be: {
    base: API, methods: ['GET'], projects: ['ops'], allowHeaders: [],
    auth: { inject: { header: 'Authorization', format: 'Bearer {token}' }, source: { type: 'static', token: '${env:T}' } } } } } })
  const rs = await egS.handle('http_request', { backend: 'be', path: '/x' }, { project: 'ops' })
  check('#36: static source injects the resolved token (no mint)', rs.ok && sentAuth.at(-1) === 'Bearer statictok' && mintCount === 0)
}

// ---- win-env: parse `reg query` output — rehydrate env vars the MCP launcher stripped so ${env:} resolves ----
{
  const sample = [
    'HKEY_CURRENT_USER\\Environment',
    '    OneDrive    REG_SZ    C:\\Users\\robin\\OneDrive',
    '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps',
    '    SOME_SECRET    REG_SZ    s3cr3t-value',
    '',
  ].join('\r\n')
  const m = parseRegQuery(sample)
  check('win-env: parses a REG_SZ value', m.SOME_SECRET && m.SOME_SECRET.type === 'REG_SZ' && m.SOME_SECRET.value === 's3cr3t-value')
  check('win-env: parses REG_EXPAND_SZ', m.Path && m.Path.type === 'REG_EXPAND_SZ' && m.Path.value.includes('WindowsApps'))
  check('win-env: skips the key-header line + only string types', !('HKEY_CURRENT_USER\\Environment' in m) && Object.keys(m).length === 3)
}

// #35: tailscale hostOf returns ONLY tailnet-routable forms; a partial `tailscale status` (node up, no IP
// assigned yet) must yield null so advertise-derivation retries instead of latching the bare hostname — which
// would sort above peer IPs and break the "smaller ADVERTISE:PORT dials" tie-break (nobody dials).
check('hostOf prefers the tailnet IP', hostOf({ TailscaleIPs: ['100.64.0.1'], DNSName: 'x.ts.net.', HostName: 'X' }) === '100.64.0.1')
check('hostOf falls back to MagicDNS FQDN (trailing dot stripped)', hostOf({ TailscaleIPs: [], DNSName: 'little-001.tail.ts.net.', HostName: 'LITTLE-001' }) === 'little-001.tail.ts.net')
check('hostOf returns null on a partial status (HostName only) — no bare-hostname latch (#35)', hostOf({ TailscaleIPs: [], DNSName: '', HostName: 'ROBIN-Z790' }) === null)
check('hostOf null for empty/absent node', hostOf(null) === null && hostOf({}) === null)

// ---- reply-cap key material (#43). The CapSigner mixes in NO other entropy - deriveKey is HKDF over this
// string alone - so these inputs decide both the key's stability and its secrecy.
const capBase = { token: 'tok-abc', realm: 'default', project: 'AIMB', user: 'Robin', host: 'ROBIN-Z790' }
check('#43 proc cap input is DETERMINISTIC (same identity -> same key material across restarts)',
  procCapKeyInput(capBase) === procCapKeyInput({ ...capBase }))
check('#43 proc cap input has NO random/per-process component (exactly what rotated before)',
  !/[0-9a-f]{8}/.test(procCapKeyInput(capBase)) && procCapKeyInput(capBase).indexOf('/') === -1, procCapKeyInput(capBase))
check('#43 proc cap input is TOKEN-gated (not computable from public roster data alone)',
  procCapKeyInput(capBase) !== procCapKeyInput({ ...capBase, token: 'different' }))
check('#43 proc cap input separates distinct identities',
  procCapKeyInput(capBase) !== procCapKeyInput({ ...capBase, project: 'PowerHub' }) &&
  procCapKeyInput(capBase) !== procCapKeyInput({ ...capBase, user: 'someone-else' }) &&
  procCapKeyInput(capBase) !== procCapKeyInput({ ...capBase, host: 'LITTLE-001' }))
check('#43 proc cap input is case-insensitive on identity (matches identity comparison elsewhere)',
  procCapKeyInput(capBase) === procCapKeyInput({ ...capBase, project: 'aimb', user: 'robin', host: 'robin-z790' }))
check('#43 page cap input still rotates per instance (a browser tab IS ephemeral)',
  pageCapKeyInput({ token: 't', instance: 'a1' }) !== pageCapKeyInput({ token: 't', instance: 'b2' }))
check('#43 page cap input is token-gated too',
  pageCapKeyInput({ token: 't', instance: 'a1' }) !== pageCapKeyInput({ token: 'other', instance: 'a1' }))

// ---- #71: one canonical DISPLAY spelling per project — the replicated first-seen map ----
{
  const N = (name, first_seen) => ({ name, first_seen })
  const mk = () => createProjectNames({ persistence: null, persist: false, writer: 'h' })
  const p = mk()
  check('#71 note: the first spelling of a project is adopted', p.note('Marz', 100) === true && p.display('marz') === 'Marz' && p.display('MARZ') === 'Marz')
  check('#71 note: a LATER sighting in another case changes nothing (first-seen wins)', p.note('marz', 200) === false && p.display('marz') === 'Marz')
  check('#71 merge: an EARLIER first_seen replaces it (the true first spelling)', p.merge([N('marz', 50)]) === 1 && p.display('Marz') === 'marz')
  check('#71 display: an unknown project keeps its declared spelling (trimmed); empty/null pass through',
    p.display(' Ops ') === 'Ops' && p.display('') === '' && p.display(null) === null && p.display(undefined) === undefined)
  check('#71 unclassified is never given a spelling', p.note('Unclassified', 1) === false && !p.has('unclassified') && p.display('UNCLASSIFIED') === 'UNCLASSIFIED')
  check('#71 junk records are ignored (no name / bad first_seen / non-object)', p.merge([{ name: '', first_seen: 1 }, { name: 'X', first_seen: 0 }, { name: 'Y' }, null, 'Z', [1]]) === 0 && !p.has('x') && !p.has('y'))
  check('#71 merge: a non-array (a ≤1.56 peer sends no map) is a no-op', p.merge(undefined) === 0 && p.merge({ name: 'Q', first_seen: 1 }) === 0)
  // tie rule: same first_seen -> the lexically smaller name ("AIMB" < "aimb"), in either order
  const t1 = mk(); t1.merge([N('aimb', 500)]); t1.merge([N('AIMB', 500)])
  const t2 = mk(); t2.merge([N('AIMB', 500)]); t2.merge([N('aimb', 500)])
  check('#71 tie: equal first_seen -> the smaller spelling, whichever arrives first', t1.display('aimb') === 'AIMB' && t2.display('aimb') === 'AIMB')
  check('#71 beatsName: never beats itself; earlier beats later; tie -> smaller name',
    !beatsName(N('A', 1), N('A', 1)) && beatsName(N('b', 1), N('A', 2)) && beatsName(N('A', 3), N('a', 3)) && !beatsName(N('a', 3), N('A', 3)))
  // commutative + idempotent: every order of a batch converges to one map (what makes re-gossip safe)
  const recs = [N('Marz', 300), N('marz', 200), N('MARZ', 200), N('AIMB', 100), N('aimb', 50), N('Ops', 10), N('ops', 10)]
  const perms = [[0, 1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1, 0], [2, 0, 4, 6, 1, 3, 5], [3, 6, 1, 5, 0, 2, 4]]
  const outs = perms.map(order => { const m = mk(); for (const i of order) m.merge([recs[i]]); m.merge(recs); return JSON.stringify(m.list()) })
  check('#71 merge: commutative + idempotent (every order -> the same map)', outs.every(o => o === outs[0]), JSON.stringify(outs))
  const one = mk(); one.merge(recs)
  check('#71 merge: the winners are the earliest spellings (tie -> smaller)', one.display('marz') === 'MARZ' && one.display('AIMB') === 'aimb' && one.display('ops') === 'Ops', JSON.stringify(one.list()))
  check('#71 list: key-sorted copies (stable gossip signature); names() maps projKey -> spelling',
    JSON.stringify(one.list().map(r => r.name)) === JSON.stringify(['aimb', 'MARZ', 'Ops']) && one.names().marz === 'MARZ' && one.names().aimb === 'aimb')
  check('#71 normProjectName: trims + caps the name, floors first_seen', normProjectName({ name: '  Marz  ', first_seen: 12.7 }).name === 'Marz' && normProjectName({ name: 'Marz', first_seen: 12.7 }).first_seen === 12
    && normProjectName({ name: 'x'.repeat(500), first_seen: 1 }).name.length === 100)
}
// #71: the durable copy round-trips through the file store (one file per writing host; rehydrate folds them all)
{
  const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'aimb-pnames-'))
  const store0 = createFilePersistence({ CFG: {}, HERE: dir, env: { AI_BRIDGE_PERSIST_DIR: dir } })
  const writes = []   // the module's put() is fire-and-forget: track the promises and AWAIT them (was a fixed 150 ms sleep — flaky)
  const store = { ...store0, projectNames: { ...store0.projectNames, put: (...a) => { const p = store0.projectNames.put(...a); writes.push(p); return p } } }
  const h1 = createProjectNames({ persistence: store, persist: true, writer: 'HOST-1' })
  const h2 = createProjectNames({ persistence: store, persist: true, writer: 'HOST-2' })
  h1.note('Marz', 100); h2.note('marz', 50); h2.note('AIMB', 70)
  await Promise.all(writes)
  check('#71 durable: every save landed, and back-to-back saves of one host land in order (its newest map on disk)', writes.length === 3
    && JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'project-names', 'host-2.pnames'), 'utf8'))) === JSON.stringify(h2.list()))
  const back = createProjectNames({ persistence: store, persist: true, writer: 'HOST-3' })
  await back.rehydrate()
  check('#71 durable: rehydrate folds every host\'s file (earliest first_seen wins)', back.display('MARZ') === 'marz' && back.display('aimb') === 'AIMB' && back.size() === 2, JSON.stringify(back.list()))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
