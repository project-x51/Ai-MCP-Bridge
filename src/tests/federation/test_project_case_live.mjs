// #71 — project names show ONE canonical spelling mesh-wide (the first-seen one), while matching stays case-insensitive.
// Live 2026-09-30 (Ferret): allow_project(project:"AIMB") came back { from:"aimb", to:"Ferret" }, register_self listed
// access:["aimb"] while the AIMB session registers as "AIMB", and list_sessions showed both "Marz" (MapGuy2, Lighter) and
// "marz" (MapSeeder) — it read as two projects. Now each bridge holds a replicated first-seen map (projKey -> spelling,
// earliest wins) and every surface shows that spelling: list_sessions, register_self (identity + access), my_identity,
// the allow/revoke results, the #72 grant notices, request_project_access and the dashboard's roster.
// The audit also found a REAL case bug: the reply-cap (§5) bound the two projects by their DECLARED spelling, so a peer
// that re-registered as "BETA" (was "Beta") could no longer answer a cross-project message it was invited to reply to
// (project-denied). And allow_project let a caller declared "UNCLASSIFIED" grant as if it were a real project.
//
// Two gateways on distinct loopback IPs (127.0.0.1 / 127.0.0.2) stand in for two hosts, each with its own file store;
// host 1 also runs a FOLLOWER (same IP + port, so it loses the bind and follows) — the MapGuy2/Lighter shape.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import WebSocket from 'ws'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 13800)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-fix proof run this test against a reverted copy
const TOKEN = 'projcasetok'
const P1_PORT = String(tp(13800)), P2_PORT = String(tp(13802))
const persist1 = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-projcase1-'))
const persist2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-projcase2-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(name, bind, port, persistDir, extra) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: bind, AI_BRIDGE_ADVERTISE_HOST: bind, AI_BRIDGE_USER: 'robin',
      AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir, AI_BRIDGE_TEST_GOSSIP: '',
      AI_BRIDGE_GOSSIP_REFRESH_MS: '60000',   // a LONG #63 refresh: every propagation below must be change-driven
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: '', AI_BRIDGE_DISCOVERY_MS: '300', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)
const reg = (h, name, secret, project) => call(h, 'register_self', { name, secret, project })
// the project each named sub-peer is SHOWN with in list_sessions on bridge `h`
async function shown(h, names) {
  const subs = (await call(h, 'list_sessions')).sessions.flatMap(s => s.subpeers || [])
  const o = {}; for (const n of names) { const sp = subs.find(x => x.name === n); o[n] = sp ? sp.project : undefined }
  return o
}
async function until(fn, want, ms = 6000) {
  const t0 = Date.now(); let r
  do { r = await fn(); if (want(r)) return r; await sleep(250) } while (Date.now() - t0 < ms)
  return r
}
const inbox = async (h, name, secret) => (await call(h, 'inbox', { for: name, secret, cursor: 0 })).messages || []
const body = m => { try { return JSON.parse(m.body) } catch { return {} } }
const all = []

const H2 = await spawn('Host2', '127.0.0.2', P2_PORT, persist2); all.push(H2)
const H1 = await spawn('Host1', '127.0.0.1', P1_PORT, persist1, { AI_BRIDGE_SEEDS: '127.0.0.2:' + P2_PORT }); all.push(H1)
await sleep(700)
const F1 = await spawn('Host1F', '127.0.0.1', P1_PORT, persist1, { AI_BRIDGE_SEEDS: '127.0.0.2:' + P2_PORT }); all.push(F1)
await sleep(1000)
const roles = [(await call(H1, 'my_identity')).role, (await call(F1, 'my_identity')).role, (await call(H2, 'my_identity')).role]
check('harness: host 1 runs a gateway + a FOLLOWER, host 2 a gateway', roles.join('/') === 'gateway/follower/gateway', roles.join('/'))

// ---- 1. "Marz" first, then "marz" (another host) and "MARZ" (a follower): ONE spelling everywhere
const MARZ = ['MapGuy2', 'MapSeeder', 'Lighter']
await reg(H1, 'MapGuy2', 'mg', 'Marz')                        // first seen: "Marz"
await sleep(1500)                                            // host 2 learns it by gossip
const seeder = await reg(H2, 'MapSeeder', 'ms', 'marz')      // later, another host, another case
const lighter = await reg(F1, 'Lighter', 'li', 'MARZ')       // later, host 1's follower, a third case
check('a later registration as "marz" is SHOWN the canonical "Marz" in its own register_self identity',
  seeder.ok === true && seeder.identity?.project === 'Marz', JSON.stringify(seeder.identity))
check('... and so is one as "MARZ" on a follower', lighter.ok === true && lighter.identity?.project === 'Marz', JSON.stringify(lighter.identity))
const want3 = o => MARZ.every(n => o[n] === 'Marz')
const v1 = await until(() => shown(H1, MARZ), want3), v2 = await until(() => shown(H2, MARZ), want3), vf = await until(() => shown(F1, MARZ), want3)
check('list_sessions on host 1 shows ONE spelling ("Marz") for all three Marz sessions', want3(v1), JSON.stringify(v1))
check('list_sessions on host 2 shows the same one spelling', want3(v2), JSON.stringify(v2))
check('list_sessions on host 1\'s follower shows it too', want3(vf), JSON.stringify(vf))
const idH2 = await call(H2, 'my_identity')
check('my_identity lists the sub-peer registered as "marz" under "Marz"', idH2.subpeers.find(s => s.name === 'MapSeeder')?.project === 'Marz', JSON.stringify(idH2.subpeers))
// matching was already case-insensitive: the three spellings are ONE project (same-project traffic needs no grant)
const same = await call(H2, 'send_to_peer', { as: 'MapSeeder', secret: 'ms', target: 'MapGuy2', verb: 'test', subject: 'marz->Marz', message: 'x' })
check('"marz" -> "Marz" is same-project (no grant needed) across hosts', same.ok === true, JSON.stringify(same))

// ---- 2. two spellings first seen on two hosts at the SAME time converge to one, mesh-wide (after gossip)
await Promise.all([reg(H1, 'OpsOne', 'o1', 'ops'), reg(H2, 'OpsTwo', 'o2', 'Ops')])
const agree = o => !!o.OpsOne && o.OpsOne === o.OpsTwo
const o1 = await until(() => shown(H1, ['OpsOne', 'OpsTwo']), agree), o2 = await until(() => shown(H2, ['OpsOne', 'OpsTwo']), agree)
check('concurrent "ops"/"Ops" on two hosts: host 1 shows one spelling for both', agree(o1), JSON.stringify(o1))
check('... and host 2 shows the SAME spelling (canonical agreement after gossip)', agree(o2) && o1.OpsOne === o2.OpsOne, JSON.stringify([o1, o2]))

// ---- 3. grants: allow_project(project:"AIMB") shows "AIMB" — in `allow`, in the grantee's access, in the notice
await reg(H1, 'Bridget', 'bg', 'AIMB')                       // AIMB's canonical spelling: "AIMB"
await reg(H2, 'Ferret', 'fe', 'Ferret')
await sleep(1200)
const g1 = await call(H2, 'allow_project', { project: 'AIMB', as: 'Ferret', secret: 'fe' })
check('allow_project(project:"AIMB") returns allow.from "AIMB" (was "aimb") and to "Ferret"',
  g1.ok === true && g1.allow?.from === 'AIMB' && g1.allow?.to === 'Ferret', JSON.stringify(g1.allow))
const bAccess = await until(async () => (await reg(H1, 'Bridget', 'bg', 'AIMB')).access, a => Array.isArray(a) && a.includes('Ferret'))
check('the grantee (AIMB, on another host) lists access ["Ferret"] (was "ferret")', Array.isArray(bAccess) && bAccess.includes('Ferret') && !bAccess.includes('ferret'), JSON.stringify(bAccess))
// the issue's exact call shape: a bidirectional grant, the project typed in lower case — still shown "AIMB"
const g2 = await call(H2, 'allow_project', { project: 'aimb', mode: 'bidirectional', as: 'Ferret', secret: 'fe' })
check('allow_project(project:"aimb", bidirectional) still shows allow.from "AIMB"', g2.ok === true && g2.allow?.from === 'AIMB' && g2.announced >= 1, JSON.stringify(g2))
const fReg = await reg(H2, 'Ferret', 'fe', 'Ferret')
check('the granter\'s register_self access lists "AIMB" (was "aimb")', Array.isArray(fReg.access) && fReg.access.includes('AIMB') && !fReg.access.includes('aimb'), JSON.stringify(fReg.access))
await sleep(800)
const notes = (await inbox(H1, 'Bridget', 'bg')).filter(m => m.verb === 'project_access_granted')
const nb = notes.length ? body(notes[notes.length - 1]) : {}
check('the #72 notice subject uses the canonical spelling', notes[notes.length - 1]?.subject === 'Ferret granted AIMB access (bidirectional)', JSON.stringify(notes.map(m => m.subject)))
check('... and so does its body (granted/granting project, direction, from/to)',
  nb.granted_project === 'AIMB' && nb.granting_project === 'Ferret' && nb.direction === 'AIMB <-> Ferret' && nb.from === 'AIMB' && nb.to === 'Ferret', JSON.stringify(nb))
const rq = await call(H2, 'request_project_access', { to: 'marz', reason: 'case test', as: 'Ferret', secret: 'fe' })
check('request_project_access echoes the target in its canonical spelling ("Marz", was lower-cased)', rq.ok === true && rq.to === 'Marz', JSON.stringify(rq))
const rv = await call(H2, 'revoke_project', { project: 'Aimb', as: 'Ferret', secret: 'fe' })
check('revoke_project(project:"Aimb") shows from "AIMB"', rv.ok === true && rv.revoked === true && rv.from === 'AIMB' && rv.to === 'Ferret', JSON.stringify(rv))
await sleep(800)
const rn = (await inbox(H1, 'Bridget', 'bg')).filter(m => m.verb === 'project_access_revoked')
check('... and its notice subject too', rn[0]?.subject === 'Ferret revoked AIMB access', JSON.stringify(rn.map(m => m.subject)))

// ---- 4. the dashboard's roster carries the canonical spellings (+ the map, for its persistence view)
const dash = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.2:${Number(P2_PORT) + 1}`)
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN, kind: 'dashboard', instance: 'dash-case' })))
  ws.on('message', raw => { let m = null; try { m = JSON.parse(String(raw)) } catch { return }; if (m.type === 'welcome') { ws.close(); resolve(m) } })
  ws.on('error', reject)
})
const dSubs = (dash.sessions || []).flatMap(s => s.subpeers || [])
check('the dashboard roster shows every Marz session as "Marz"', MARZ.every(n => dSubs.find(s => s.name === n)?.project === 'Marz'), JSON.stringify(dSubs.map(s => [s.name, s.project])))
check('... and carries the map (marz -> "Marz", aimb -> "AIMB") for stores that hold another spelling',
  dash.project_names?.marz === 'Marz' && dash.project_names?.aimb === 'AIMB', JSON.stringify(dash.project_names))

// ---- 5. REAL case bug: a reply-cap must survive the replier re-registering in another case
await reg(H1, 'Alfa', 'al', 'Alpha')
const bee = await reg(H1, 'Bee', 'be', 'Beta')
await call(H1, 'allow_project', { project: 'Alpha', as: 'Bee', secret: 'be' })   // one-way: Alpha may initiate to Beta, NOT back
const q1 = await call(H1, 'send_to_peer', { as: 'Alfa', secret: 'al', target: bee.peer_id, verb: 'ask', subject: 'q1', message: 'please answer' })
check('harness: Alpha -> Beta (granted) is delivered', q1.ok === true && !!q1.envelope_id, JSON.stringify(q1))
const noCap = await call(H1, 'send_to_peer', { as: 'Bee', secret: 'be', target: 'Alfa', verb: 'test', subject: 'unsolicited', message: 'x' })
check('harness: an UNSOLICITED Beta -> Alpha send is project-denied (one-way grant)', noCap.ok === false && noCap.code === 'project-denied', JSON.stringify(noCap))
await call(H1, 'deregister', { peer_id: bee.peer_id, secret: 'be' })   // Bee goes away before reading q1 (its durable copy stays) ...
const bee2 = await reg(H1, 'Bee', 'be', 'BETA')                        // ... and comes back declaring "BETA"
check('the returning "BETA" session is shown as "Beta" (first-seen) and gets q1 back', bee2.identity?.project === 'Beta' && (await inbox(H1, 'Bee', 'be')).some(m => m.subject === 'q1'), JSON.stringify(bee2.identity))
const reply = await call(H1, 'send_to_peer', { as: 'Bee', secret: 'be', target: 'Alfa', verb: 'answer', subject: 're: q1', message: 'answer', reply_to: q1.envelope_id })
check('its REPLY to q1 (reply-cap) gets through — the cap binds projects case-insensitively (was project-denied)', reply.ok === true, JSON.stringify(reply))
check('... and lands', (await inbox(H1, 'Alfa', 'al')).some(m => m.subject === 're: q1'))

// ---- 6. case bug: a caller declared "UNCLASSIFIED" is unclassified — it may not grant
await reg(H1, 'Nobody', 'nb', 'UNCLASSIFIED')
const gu = await call(H1, 'allow_project', { project: 'Alpha', as: 'Nobody', secret: 'nb' })
check('allow_project from a session declared "UNCLASSIFIED" is refused caller-unclassified (was a grant from "unclassified")', gu.ok === false && gu.code === 'caller-unclassified', JSON.stringify(gu))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b of all) { try { await b.transport.close() } catch {} }
await sleep(300)
for (const d of [persist1, persist2]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
process.exit(fail ? 1 : 0)
