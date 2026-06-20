// Consent suite: strict default denies cross-project; allow_project grants; signed reply-cap lets
// return-traffic through without a reverse grant; bidirectional; request_project_access flow; open mode.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))

const TOKEN = 'testtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) } }

async function spawnBridge(name, port, extraEnv = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1), AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_SWEEP_MS: '400', AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none', ...extraEnv }, stderr: 'pipe' })
  const client = new Client({ name: `test-${name}`, version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport, name }
}
const call = async (b, name, args = {}) => JSON.parse((await b.client.callTool({ name, arguments: args })).content[0].text)
const drain = async (b, who, secret) => (await call(b, 'inbox', { for: who, secret })).messages
// connect a probe page leaf and return the welcome roster it is served (visibility test).
// Retries transient WS failures and settles exactly once with full listener cleanup, so a late 'error'
// (e.g. the socket dropping during teardown, more likely when the machine is loaded by a live bridge)
// can't escape as an unhandled rejection and crash the whole suite.
function pageRoster(wsPort, project, seeAll) {
  const attempt = () => new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + wsPort)
    let done = false
    const settle = (fn, v) => { if (done) return; done = true; clearTimeout(t); try { ws.onopen = ws.onmessage = ws.onerror = null } catch {} ; try { ws.close() } catch {} ; fn(v) }
    const t = setTimeout(() => settle(reject, new Error('timeout')), 3000)
    ws.onerror = () => settle(reject, new Error('ws-error'))
    ws.onopen = () => { try { ws.send(JSON.stringify({ type: 'hello', kind: 'page', page_kind: 'probe',
      title: 'probe', project, user: 'p', seeAll, instance: 'probe-' + project + (seeAll ? '-all' : ''), token: TOKEN })) } catch {} }
    ws.onmessage = ev => { try { const m = JSON.parse(ev.data); if (m.type === 'welcome') settle(resolve, m) } catch {} }
  })
  return (async () => { let last; for (let i = 0; i < 3; i++) { try { return await attempt() } catch (e) { last = e; await sleep(200) } } throw last })()
}
const subNames = r => { const o = []; (r.sessions || []).forEach(s => (s.subpeers || []).forEach(sp => o.push(sp.name))); return o }

// ---- strict realm: two projects on one process ----
const S = await spawnBridge('Strict', 7900); await sleep(500)
await call(S, 'register_self', { name: 'a', secret: 'sa', project: 'alpha', user: 'ann' })
await call(S, 'register_self', { name: 'b', secret: 'sb', project: 'beta', user: 'bob' })
await sleep(200)

// 1. strict: alpha -> beta denied
const d1 = await call(S, 'send_to_peer', { target: 'b', subject: 'hi', message: 'cross', as: 'a', secret: 'sa' })
check('strict denies cross-project send', d1.ok === false && d1.code === 'project-denied', JSON.stringify(d1))
check('beta inbox empty after denial', (await drain(S, 'b', 'sb')).length === 0)

// 2. beta opens itself to alpha -> now allowed
const g = await call(S, 'send_to_peer', { target: 'b', subject: 'hi', message: 'cross', as: 'a', secret: 'sa' })   // still denied pre-grant
check('still denied before grant', g.ok === false)
const al = await call(S, 'allow_project', { project: 'alpha', as: 'b', secret: 'sb' })
check('allow_project ok', al.ok === true && al.allow.from === 'alpha' && al.allow.to === 'beta', JSON.stringify(al))
await sleep(150)
const s2 = await call(S, 'send_to_peer', { target: 'b', subject: 'hello beta', message: 'now allowed', as: 'a', secret: 'sa' })
check('granted cross-project send delivered', s2.ok === true, JSON.stringify(s2))
const bIn = await drain(S, 'b', 'sb')
const got = bIn.find(m => m.body === 'now allowed')
check('beta received it with sender project', !!got && got.from.project === 'alpha', JSON.stringify(got))

// 3. reply exception: beta replies to alpha's thread (no beta->alpha grant) -> allowed via reply-cap
const rep = await call(S, 'send_to_peer', { target: 'a', subject: 're: hello', message: 'reply back', as: 'b', secret: 'sb', reply_to: got.id })
check('reply to a granted thread is allowed', rep.ok === true, JSON.stringify(rep))
const aIn = await drain(S, 'a', 'sa')
check('alpha received the reply', aIn.some(m => m.body === 'reply back'), JSON.stringify(aIn.map(m => m.body)))
// but a fresh (non-reply) beta -> alpha is still denied
const fresh = await call(S, 'send_to_peer', { target: 'a', subject: 'unsolicited', message: 'no cap', as: 'b', secret: 'sb' })
check('fresh reverse send still denied (no reverse grant)', fresh.ok === false && fresh.code === 'project-denied', JSON.stringify(fresh))

// 4. revoke
await call(S, 'revoke_project', { project: 'alpha', as: 'b', secret: 'sb' })
await sleep(150)
const afterRevoke = await call(S, 'send_to_peer', { target: 'b', subject: 'hi', message: 'revoked', as: 'a', secret: 'sa' })
check('revoke restores denial', afterRevoke.ok === false && afterRevoke.code === 'project-denied', JSON.stringify(afterRevoke))

// 5. bidirectional grant works both ways
await call(S, 'register_self', { name: 'g', secret: 'sg', project: 'gamma', user: 'gil' })
await call(S, 'allow_project', { project: 'gamma', mode: 'bidirectional', as: 'a', secret: 'sa' })   // alpha<->gamma
await sleep(150)
const ag = await call(S, 'send_to_peer', { target: 'g', subject: 'x', message: 'a->g', as: 'a', secret: 'sa' })
const ga = await call(S, 'send_to_peer', { target: 'a', subject: 'x', message: 'g->a', as: 'g', secret: 'sg' })
check('bidirectional: alpha->gamma allowed', ag.ok === true, JSON.stringify(ag))
check('bidirectional: gamma->alpha allowed', ga.ok === true, JSON.stringify(ga))

// 6. request_project_access reaches the target project's session
const req = await call(S, 'request_project_access', { to: 'beta', reason: 'need to collaborate', as: 'g', secret: 'sg' })
check('request returns id + delivered', req.ok === true && req.request_id.startsWith('req_') && req.delivered_to >= 1, JSON.stringify(req))
await sleep(150)
const bReq = await drain(S, 'b', 'sb')
const rmsg = bReq.find(m => m.verb === 'project_access_request')
check('target project session got the request', !!rmsg && JSON.parse(rmsg.body).from_project === 'gamma', JSON.stringify(rmsg && rmsg.body))

// 7. project-scoped topics: alpha and beta each exclusively own the SAME topic name
const ca = await call(S, 'claim_topic', { topic: 'svc/api', exclusive: true, as: 'a', secret: 'sa' })
const cb = await call(S, 'claim_topic', { topic: 'svc/api', exclusive: true, as: 'b', secret: 'sb' })
check('same topic name owned exclusively in two projects', ca.ok === true && cb.ok === true, JSON.stringify([ca, cb]))
await sleep(120)
// bare topic resolves in the sender's own project (alpha -> alpha's owner = self)
const ownT = await call(S, 'send_to_peer', { target: 'topic:svc/api', subject: 'mine', message: 'own project topic', as: 'a', secret: 'sa' })
check('bare topic stays in sender project', ownT.ok === true && ownT.project === 'alpha' && ownT.fanout.length === 1 && ownT.fanout[0].to === ca.holder, JSON.stringify(ownT))
check('alpha got its own-project topic msg', (await drain(S, 'a', 'sa')).some(m => m.body === 'own project topic'))
// cross-project @beta/topic: denied without grant, allowed with
const xDenied = await call(S, 'send_to_peer', { target: 'topic:@beta/svc/api', subject: 'x', message: 'cross denied', as: 'a', secret: 'sa' })
check('cross-project topic denied without grant', xDenied.ok === false, JSON.stringify(xDenied))
await call(S, 'allow_project', { project: 'alpha', as: 'b', secret: 'sb' })
await sleep(120)
const xOk = await call(S, 'send_to_peer', { target: 'topic:@beta/svc/api', subject: 'x', message: 'cross granted', as: 'a', secret: 'sa' })
check('cross-project @beta/topic allowed once granted', xOk.ok === true && xOk.fanout.some(f => f.ok), JSON.stringify(xOk))
check('beta owner received the cross-project topic msg', (await drain(S, 'b', 'sb')).some(m => m.body === 'cross granted'))

// 7b. first-class cross-project BARE topic send (#27/#28): a bare ref owned ONLY in another project resolves
// cross-project — auto-routed WITH a grant, a DISTINCT code without (not the overloaded bare 'no-owner').
await call(S, 'register_self', { name: 'd', secret: 'sd', project: 'delta', user: 'dan' })
await call(S, 'claim_topic', { topic: 'delta/work', exclusive: true, as: 'd', secret: 'sd' })
await sleep(120)
const noGrant = await call(S, 'send_to_peer', { target: 'topic:delta/work', subject: 'x', message: 'xproj nogrant', as: 'a', secret: 'sa' })
check('bare cross-project topic w/o grant -> cross-project-no-grant (not no-owner)', noGrant.ok === false && noGrant.code === 'cross-project-no-grant' && (noGrant.owner_projects || []).includes('delta'), JSON.stringify(noGrant))
const unknown = await call(S, 'send_to_peer', { target: 'topic:nope/nothere', subject: 'x', message: 'void', as: 'a', secret: 'sa' })
check('genuinely ownerless topic still -> no-owner', unknown.ok === false && unknown.code === 'no-owner', JSON.stringify(unknown))
await call(S, 'allow_project', { project: 'alpha', as: 'd', secret: 'sd' })   // delta opens to alpha
await sleep(150)
const xauto = await call(S, 'send_to_peer', { target: 'topic:delta/work', subject: 'x', message: 'xproj auto', as: 'a', secret: 'sa' })
check('bare cross-project topic auto-routes once granted (first-class)', xauto.ok === true && xauto.cross_project === 'delta' && xauto.fanout.some(f => f.ok), JSON.stringify(xauto))
check('delta owner received the auto-routed cross-project send', (await drain(S, 'd', 'sd')).some(m => m.body === 'xproj auto'))
// ambiguous: a bare topic owned in TWO projects the sender can reach -> distinct ambiguous code (alpha reaches beta + gamma)
await call(S, 'claim_topic', { topic: 'shared/x', exclusive: true, as: 'b', secret: 'sb' })
await call(S, 'claim_topic', { topic: 'shared/x', exclusive: true, as: 'g', secret: 'sg' })
await sleep(120)
const amb = await call(S, 'send_to_peer', { target: 'topic:shared/x', subject: 'x', message: 'which?', as: 'a', secret: 'sa' })
check('bare topic owned in 2 reachable projects -> cross-project-ambiguous', amb.ok === false && amb.code === 'cross-project-ambiguous' && (amb.owner_projects || []).length === 2, JSON.stringify(amb))

// 8. visibility: a beta page sees only beta-reachable sub-peers by default; seeAll sees everything
const vF = subNames(await pageRoster(7901, 'beta', false))
check('filtered page view excludes unreachable projects', vF.includes('b') && !vF.includes('a') && !vF.includes('g'), JSON.stringify(vF))
const vA = subNames(await pageRoster(7901, 'beta', true))
check('seeAll page view includes all projects', vA.includes('a') && vA.includes('b') && vA.includes('g'), JSON.stringify(vA))

// 9. case-insensitive project matching (mixed-case names like CamelCo/AIMB tripped a half-lowercased path)
await call(S, 'register_self', { name: 'cc', secret: 'scc', project: 'CamelCo', user: 'P' })
await call(S, 'register_self', { name: 'ai2', secret: 'sai', project: 'AIMB', user: 'A' })
await sleep(150)
const mcDenied = await call(S, 'send_to_peer', { target: 'ai2', subject: 'x', message: 'mc denied', as: 'cc', secret: 'scc' })
check('mixed-case cross-project denied by default', mcDenied.ok === false && mcDenied.code === 'project-denied', JSON.stringify(mcDenied))
await call(S, 'allow_project', { project: 'CAMELCO', as: 'ai2', secret: 'sai' })   // grant with a DIFFERENT case
await sleep(150)
const mcOk = await call(S, 'send_to_peer', { target: 'ai2', subject: 'x', message: 'mc allowed', as: 'cc', secret: 'scc' })
check('mixed-case grant works regardless of declared case', mcOk.ok === true, JSON.stringify(mcOk))
check('AIMB sub-peer received the mixed-case send', (await drain(S, 'ai2', 'sai')).some(m => m.body === 'mc allowed'))
const mcReq = await call(S, 'request_project_access', { to: 'AiMb', reason: 'collab', as: 'cc', secret: 'scc' })
check('request_project_access reaches a sub-peer member (case-insensitive)', mcReq.ok === true && mcReq.delivered_to >= 1, JSON.stringify(mcReq))

// ---- reply-caps always get through: no TTL expiry + survives a later revoke (Decision B, 2026-06-14) ----
// CAP_TTL_MS=1 mints every reply-cap already-stale, so a reply that relies on the cap proves the expiry
// gate is gone (old code denied an expired cap). Then a reply on an existing thread after a revoke proves
// the cap is an independent allow that revoke does not cancel.
const R = await spawnBridge('ReplyCap', 7920, { AI_BRIDGE_CAP_TTL_MS: '1' }); await sleep(500)
await call(R, 'register_self', { name: 'ra', secret: 'sra', project: 'alpha', user: 'ann' })
await call(R, 'register_self', { name: 'rb', secret: 'srb', project: 'beta', user: 'bob' })
await sleep(200)
await call(R, 'allow_project', { project: 'alpha', as: 'rb', secret: 'srb' })   // beta accepts alpha (forward only)
await sleep(150)
const rfwd = await call(R, 'send_to_peer', { target: 'rb', subject: 'open thread', message: 'seed', as: 'ra', secret: 'sra' })
check('reply-cap: forward send delivered', rfwd.ok === true, JSON.stringify(rfwd))
const seed = (await drain(R, 'rb', 'srb')).find(m => m.body === 'seed')
check('reply-cap: beta got the seed message', !!seed, JSON.stringify(seed && seed.id))
await sleep(50)   // ensure the 1ms cap is now "past" by wall clock
const rrep = await call(R, 'send_to_peer', { target: 'ra', subject: 're: open thread', message: 'stale-cap reply', as: 'rb', secret: 'srb', reply_to: seed.id })
check('reply with an already-expired cap still gets through (no TTL gate)', rrep.ok === true, JSON.stringify(rrep))
check('alpha received the stale-cap reply', (await drain(R, 'ra', 'sra')).some(m => m.body === 'stale-cap reply'))
// second thread, then beta revokes alpha and replies on the existing thread -> still delivered
const rfwd2 = await call(R, 'send_to_peer', { target: 'rb', subject: 'thread 2', message: 'second', as: 'ra', secret: 'sra' })
check('reply-cap: second forward send delivered', rfwd2.ok === true, JSON.stringify(rfwd2))
const seed2 = (await drain(R, 'rb', 'srb')).find(m => m.body === 'second')
await call(R, 'revoke_project', { project: 'alpha', as: 'rb', secret: 'srb' })
await sleep(150)
const fresh2 = await call(R, 'send_to_peer', { target: 'rb', subject: 'no', message: 'post-revoke fresh', as: 'ra', secret: 'sra' })
check('reply-cap: a fresh (non-reply) send is denied after revoke', fresh2.ok === false && fresh2.code === 'project-denied', JSON.stringify(fresh2))
const rrep2 = await call(R, 'send_to_peer', { target: 'ra', subject: 're: thread 2', message: 'reply after revoke', as: 'rb', secret: 'srb', reply_to: seed2.id })
check('a reply on an existing thread survives a revoke', rrep2.ok === true, JSON.stringify(rrep2))
check('alpha received the post-revoke reply', (await drain(R, 'ra', 'sra')).some(m => m.body === 'reply after revoke'))

// ---- open realm: cross-project flows freely ----
const O = await spawnBridge('Open', 7910, { AI_BRIDGE_OPEN: '1' }); await sleep(500)
await call(O, 'register_self', { name: 'x', secret: 'sx', project: 'projx', user: 'xena' })
await call(O, 'register_self', { name: 'y', secret: 'sy', project: 'projy', user: 'yan' })
await sleep(150)
const ox = await call(O, 'send_to_peer', { target: 'y', subject: 'open', message: 'free', as: 'x', secret: 'sx' })
check('open mode allows cross-project', ox.ok === true, JSON.stringify(ox))
check('open: target received', (await drain(O, 'y', 'sy')).some(m => m.body === 'free'))

console.log(`\n${pass} passed, ${fail} failed`)
await S.transport.close(); await R.transport.close(); await O.transport.close()
process.exit(fail ? 1 : 0)
