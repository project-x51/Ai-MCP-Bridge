// Fast UNIT tests for the pure lib/ modules — no bridge spawn, no sockets, milliseconds. This is the payoff
// of extracting the pure logic from bridge.mjs: topic matching / ref parsing / envelope id can be exercised
// directly. (Behaviour is also covered end-to-end by the live suites; this pins the units in isolation.)
import { splitTopic, isWildcard, topicMatch, patternsOverlap, patternKey, parseTopicRef } from '../lib/topics.js'
import { envelopeId } from '../lib/envelope.js'
import { TOOLS } from '../lib/tool-schemas.js'
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
