// Fast UNIT tests for the pure lib/ modules — no bridge spawn, no sockets, milliseconds. This is the payoff
// of extracting the pure logic from bridge.mjs: topic matching / ref parsing / envelope id can be exercised
// directly. (Behaviour is also covered end-to-end by the live suites; this pins the units in isolation.)
import { splitTopic, isWildcard, topicMatch, patternsOverlap, patternKey, parseTopicRef } from '../lib/topics.js'
import { envelopeId } from '../lib/envelope.js'
import { TOOLS } from '../lib/tool-schemas.js'
import { createConsent, parseTtlMin } from '../lib/consent.js'
import { createReminders } from '../lib/reminders.js'
import { createTraces } from '../lib/traces.js'
import { create as createEgress } from '../services/egress.js'
import { hostOf } from '../facets/discovery/tailscale.js'
import { makeResolver, envResolver } from '../lib/secret-resolver.js'
import { parseRegQuery } from '../lib/win-env.js'
import { procCapKeyInput, pageCapKeyInput } from '../lib/capkeys.js'
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
