// #66(b) — realm-wide DEFAULT reminders must replicate mesh-wide. `behaviors.default` is per config FILE, so a default
// added once (the #67 doorbell connect reminder) only reached hosts whose config was hand-edited. A `behaviors.realm`
// block { updated_at, default:[...] } in ANY host's config is now one last-writer-wins record gossiped to every host.
//
// Two gateways on distinct loopback IPs (127.0.0.1 / 127.0.0.2) stand in for two hosts; host A also runs a FOLLOWER
// (same IP + port, so it loses the bind and follows) where the code sessions register. Every bridge reads its OWN temp
// config via AI_BRIDGE_CONFIG (never src/config.json) and live-reloads it, so a case is "rewrite a host's config".
// Cases: (1) B's realm connect reminder reaches a code session on A's FOLLOWER, placeholders expanded there; (2) B
// raises updated_at → A adopts the new text; (3) an OLDER block in A's own configs doesn't override; (4) a LOCAL
// behaviors.default entry with the same key beats the realm one (the realm still fills the other keys); (5) a newer
// block in the FOLLOWER's own config goes up to A's gateway and out to B, replacing the whole record; (6) with file
// persistence, the record A learned survives A (gateway + follower) restarting with B down and no realm block left.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-change proof run this test against a reverted copy
const TOKEN = 'realmdeftok'
const A_PORT = '14000', B_PORT = '14002'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-realmdef-'))
const persistA = path.join(TMP, 'persistA')   // host A's store (gateway + follower share it, as on a real host)
const cfgA = path.join(TMP, 'configA.json'), cfgF = path.join(TMP, 'configAF.json'), cfgB = path.join(TMP, 'configB.json')
const writeCfg = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2))
const DOORBELL = path.join(SRCDIR, 'tools', 'aimb-doorbell.mjs').replace(/\\/g, '/')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(name, bind, port, cfg, extra) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfg, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_PERSISTENCE: 'none',
      AI_BRIDGE_TEST_GOSSIP: '', AI_BRIDGE_DEFAULT_BEHAVIOR: '',
      // a LONG #63 refresh, so every propagation below must be PROMPT (change-driven), not ride the periodic refresh
      AI_BRIDGE_GOSSIP_REFRESH_MS: '60000',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: '', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)
// (re-)register a code session and return its register_self response (connect_reminders + default_behaviors)
const regCode = (b, name) => call(b, 'register_self', { name, secret: 's-' + name, project: 'PH', client: 'claude-code' })
const connectTexts = r => (r.connect_reminders || []).map(x => x.behavior)
const hasText = (r, re) => connectTexts(r).some(t => re.test(t))
// poll a register until its response satisfies `want` (propagation + config live-reload are async, but must be prompt)
async function regUntil(b, name, want, ms = 10000) {
  const t0 = Date.now(); let r
  do { r = await regCode(b, name); if (want(r)) return r; await sleep(300) } while (Date.now() - t0 < ms)
  return r
}
const REALM_V1 = { updated_at: '2026-09-30T10:00:00Z', default: [
  { operation: 'connect', scope: 'client', match: 'code', behavior: 'REALM-V1 run: {doorbell_cmd} (for {name})' },
  { operation: 'publish', scope: 'all', behavior: 'REALM-PUBLISH' }] }
const REALM_V2 = { updated_at: '2026-09-30T11:00:00Z', default: [
  { operation: 'connect', scope: 'client', match: 'code', behavior: 'REALM-V2 run: {doorbell_cmd}' },
  { operation: 'publish', scope: 'all', behavior: 'REALM-PUBLISH' }] }
const STALE = { updated_at: '2026-09-30T09:00:00Z', default: [{ operation: 'connect', scope: 'client', match: 'code', behavior: 'STALE-A' }] }
const REALM_V3 = { updated_at: '2026-09-30T12:00:00Z', default: [{ operation: 'connect', scope: 'client', match: 'code', behavior: 'REALM-V3-FROM-F' }] }
const MARKER = { operation: 'claim_topic', scope: 'all', behavior: 'LOCAL-MARKER' }   // a local default with an unrelated key: proves a reload happened
const all = []

// ---- host B (gateway, realm block v1) + host A (gateway + FOLLOWER, no realm block)
writeCfg(cfgB, { behaviors: { realm: REALM_V1 } })
writeCfg(cfgA, {}); writeCfg(cfgF, {})
const fileA = { AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistA }
let B = await spawn('HostB', '127.0.0.2', B_PORT, cfgB); all.push(B)
let A = await spawn('HostA', '127.0.0.1', A_PORT, cfgA, { ...fileA, AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(A)
await sleep(700)
let F = await spawn('HostAF', '127.0.0.1', A_PORT, cfgF, { ...fileA, AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(F)
await sleep(900)
const aRole = (await call(A, 'my_identity')).role, fRole = (await call(F, 'my_identity')).role
check('harness: host A runs a gateway + a FOLLOWER', aRole === 'gateway' && fRole === 'follower', `${aRole}/${fRole}`)

// 1. B's realm connect reminder reaches a code session on A's FOLLOWER, with the #67 placeholders expanded there
const r1 = await regUntil(F, 'Coder', r => hasText(r, /^REALM-V1 /))
const t1 = connectTexts(r1).find(t => /^REALM-V1 /.test(t)) || ''
console.log('  expanded:', t1)
check('1: B\'s realm connect reminder reaches a code session on A\'s FOLLOWER', !!t1, JSON.stringify(r1.connect_reminders))
const proj = r1.identity && r1.identity.project
check('1: {doorbell_cmd} expanded on A to "<node>" "<A\'s doorbell path>" --name/--project of the session',
  /^REALM-V1 run: "[^"]*node(\.exe)?" /i.test(t1) && t1.includes(`"${DOORBELL}"`) && t1.includes(`--name "Coder" --project "${proj}"`) && !t1.includes('{doorbell_cmd}'), t1)
check('1: {name} expanded too', t1.endsWith('(for Coder)'), t1)
const c1 = (r1.connect_reminders || []).find(x => /^REALM-V1 /.test(x.behavior)) || {}
check('1: tagged default:true + realm:true', c1.default === true && c1.realm === true, JSON.stringify(c1))
check('1: register_self default_behaviors = the effective set (realm entries tagged)',
  (r1.default_behaviors || []).some(d => d.behavior === 'REALM-PUBLISH' && d.realm === true), JSON.stringify(r1.default_behaviors))

// 2. B raises updated_at with new content (live-reload of B's config) -> A adopts it
writeCfg(cfgB, { behaviors: { realm: REALM_V2 } })
const r2 = await regUntil(F, 'Coder', r => hasText(r, /^REALM-V2 /))
check('2: a NEWER block on B replaces the text on A\'s follower', hasText(r2, /^REALM-V2 /) && !hasText(r2, /REALM-V1/), JSON.stringify(connectTexts(r2)))
const ra2 = await regUntil(A, 'CoderA', r => hasText(r, /^REALM-V2 /))
check('2: ... and on A\'s gateway', hasText(ra2, /^REALM-V2 /), JSON.stringify(connectTexts(ra2)))

// 3. an OLDER updated_at in A's own configs (gateway + follower) does NOT override. The marker (an unrelated local
// default) shows each config really was reloaded before we look.
writeCfg(cfgA, { behaviors: { default: [MARKER], realm: STALE } })
writeCfg(cfgF, { behaviors: { default: [MARKER], realm: STALE } })
const hasMarker = r => (r.default_behaviors || []).some(d => d.behavior === 'LOCAL-MARKER')
const r3 = await regUntil(F, 'Coder', hasMarker)
const ra3 = await regUntil(A, 'CoderA', hasMarker)
check('3: harness: A\'s gateway + follower reloaded their configs', hasMarker(r3) && hasMarker(ra3))
await sleep(1500)   // give any (wrong) stale re-gossip time to travel
const r3b = await regCode(F, 'Coder'), ra3b = await regCode(A, 'CoderA'), rb3 = await regCode(B, 'CoderB')
check('3: an OLDER block on A\'s follower does not override (still V2)', hasText(r3b, /^REALM-V2 /) && !hasText(r3b, /STALE-A/), JSON.stringify(connectTexts(r3b)))
check('3: ... nor on A\'s gateway', hasText(ra3b, /^REALM-V2 /) && !hasText(ra3b, /STALE-A/), JSON.stringify(connectTexts(ra3b)))
check('3: ... and B keeps V2 (the stale candidate never spread)', hasText(rb3, /^REALM-V2 /) && !hasText(rb3, /STALE-A/), JSON.stringify(connectTexts(rb3)))

// 4. a LOCAL behaviors.default entry with the same (operation,scope,match) key beats the realm one
writeCfg(cfgF, { behaviors: { default: [MARKER, { operation: 'connect', scope: 'client', match: 'code', behavior: 'LOCAL-CONNECT for {name}' }], realm: STALE } })
const r4 = await regUntil(F, 'Coder', r => hasText(r, /^LOCAL-CONNECT /))
const c4 = (r4.connect_reminders || []).filter(x => x.operation === 'connect' && x.scope === 'client')
check('4: the LOCAL connect default wins its key on A\'s follower (the realm one is not also sent)',
  c4.length === 1 && c4[0].behavior === 'LOCAL-CONNECT for Coder' && c4[0].default === true && !c4[0].realm, JSON.stringify(r4.connect_reminders))
check('4: the realm still fills the other keys (REALM-PUBLISH, realm:true)', (r4.default_behaviors || []).some(d => d.behavior === 'REALM-PUBLISH' && d.realm === true), JSON.stringify(r4.default_behaviors))
const rb4 = await regCode(B, 'CoderB')
check('4: a local default stays local (B still gets the realm text)', hasText(rb4, /^REALM-V2 /) && !hasText(rb4, /LOCAL-CONNECT/), JSON.stringify(connectTexts(rb4)))

// 5. a NEWER block in the FOLLOWER's own config goes UP to A's gateway and OUT to B, replacing the WHOLE record
writeCfg(cfgF, { behaviors: { default: [MARKER, { operation: 'connect', scope: 'client', match: 'code', behavior: 'LOCAL-CONNECT for {name}' }], realm: REALM_V3 } })
const rb5 = await regUntil(B, 'CoderB', r => hasText(r, /^REALM-V3-FROM-F$/))
check('5: a block published from A\'s FOLLOWER config reaches host B', hasText(rb5, /^REALM-V3-FROM-F$/), JSON.stringify(connectTexts(rb5)))
check('5: ... as ONE record: B\'s REALM-PUBLISH is gone (v3 has no publish entry)', !(rb5.default_behaviors || []).some(d => d.behavior === 'REALM-PUBLISH'), JSON.stringify(rb5.default_behaviors))
const ra5 = await regUntil(A, 'CoderA', r => hasText(r, /^REALM-V3-FROM-F$/))
check('5: ... and A\'s gateway adopted it', hasText(ra5, /^REALM-V3-FROM-F$/), JSON.stringify(connectTexts(ra5)))
const r5 = await regCode(F, 'Coder')
check('5: the follower\'s own LOCAL connect default still wins there', connectTexts(r5).length === 1 && connectTexts(r5)[0] === 'LOCAL-CONNECT for Coder', JSON.stringify(connectTexts(r5)))

// 6. durability: with no realm block left in A's configs and B down, a restarted A (gateway + follower) keeps v3
writeCfg(cfgA, {}); writeCfg(cfgF, {})
await B.transport.close(); all.splice(all.indexOf(B), 1)
await sleep(300)
await F.transport.close(); await A.transport.close(); all.length = 0
await sleep(1000)
A = await spawn('HostA', '127.0.0.1', A_PORT, cfgA, { ...fileA, AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(A)
await sleep(700)
F = await spawn('HostAF', '127.0.0.1', A_PORT, cfgF, { ...fileA, AI_BRIDGE_SEEDS: '127.0.0.2:' + B_PORT }); all.push(F)
await sleep(900)
const r6 = await regUntil(F, 'Coder2', r => hasText(r, /^REALM-V3-FROM-F$/), 4000)
check('6: after A restarts (B down, no realm block in any A config): the learned record survives (persistence)', hasText(r6, /^REALM-V3-FROM-F$/), JSON.stringify(connectTexts(r6)))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch {} }
await sleep(300)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
