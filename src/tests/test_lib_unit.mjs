// Fast UNIT tests for the pure lib/ modules — no bridge spawn, no sockets, milliseconds. This is the payoff
// of extracting the pure logic from bridge.mjs: topic matching / ref parsing / envelope id can be exercised
// directly. (Behaviour is also covered end-to-end by the live suites; this pins the units in isolation.)
import { splitTopic, isWildcard, topicMatch, patternsOverlap, patternKey, parseTopicRef } from '../lib/topics.js'
import { envelopeId } from '../lib/envelope.js'
import { TOOLS } from '../lib/tool-schemas.js'
import { createConsent, parseTtlMin } from '../lib/consent.js'
import { createReminders } from '../lib/reminders.js'
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
check('parseTtlMin durations', parseTtlMin('24h') === 1440 && parseTtlMin('7d') === 10080 && parseTtlMin('30m') === 30 && parseTtlMin(45) === 45)
check('parseTtlMin forever/invalid -> null', parseTtlMin('forever') === null && parseTtlMin(0) === null && parseTtlMin('') === null && parseTtlMin('nope') === null)

// ---- reminders module (encapsulated state) ----
{
  const r = createReminders({ persistence: {}, persist: false })
  const ME = 'host/me', id = { realm: 'default', project: 'P', user: 'u', name: 'Me' }
  check('reminders: set ok + count', r.set(ME, id, 'topic', 'a/b', 'do x').count === 1)
  check('reminders: bad scope rejected', r.set(ME, id, 'nope', 'do').code === 'bad-scope')
  check('reminders: over-long rejected', r.set(ME, id, 'all', null, 'x'.repeat(400)).code === 'behavior-too-long')
  check('reminders: match required for non-all', r.set(ME, id, 'topic', '', 'x').code === 'match-required')
  r.set(ME, id, 'project', 'Acme', 'ack ops'); r.set(ME, id, 'all', null, 'be brief')
  // a topic message matches topic + project? no (project scope is sender's project) — set sender project to Acme
  const env = { from: { session: 'host/sender', project: 'Acme', name: 'S' }, topic: 'a/b' }
  const rs = r.remindersFor(ME, env)
  check('reminders: matches topic + project + all', rs.length === 3 && rs.map(x => x.scope).join(',') === 'topic,project,all')   // most-specific first
  check("reminders: 'all' skips self-sent", r.remindersFor(ME, { from: { session: ME }, topic: null }).length === 0)
  check('reminders: list returns all three', r.list(ME).length === 3)
  check('reminders: clear one', r.clear(ME, id, 'project', 'Acme').cleared === 1 && r.list(ME).length === 2)
  check('reminders: clear all', r.clear(ME, id).cleared === 2 && r.list(ME).length === 0)
  // #26 x #29 inheritance: topicBehaviors -> inherit onto a new holder
  r.set(ME, id, 'topic', 'reviews/api', 'review in 1 day')
  const carried = r.topicBehaviors(ME, 'reviews/api')
  check('reminders: topicBehaviors returns the strings to carry', carried.length === 1 && /review in 1 day/.test(carried[0]))
  const HEIR = 'host/heir'
  r.inherit(HEIR, { ...id, name: 'Heir' }, 'reviews/api', carried)
  check('reminders: inherit lands a topic reminder on the heir', r.list(HEIR).some(b => b.scope === 'topic' && b.match === 'reviews/api'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
