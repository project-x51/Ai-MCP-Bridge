// #55 — a claim_topic RE-CLAIM (same holder, same topic) is a PATCH, not a replace. Before the fix every field the
// caller omitted was rebuilt from the defaults, so a plain `claim_topic {topic}` after a compact/restart silently
// wiped the description/icon/continuity settings — and since #64 (exclusive/announce_offline default TRUE) it also
// flipped a SHARED topic to EXCLUSIVE. Now: explicit arg > the existing claim > kept-alive marker > default.
// Cases: (1) a new claim with no flags gets the defaults; (2) a re-claim passing ONLY topic keeps every field
// (response + list_sessions roster); (3) a re-claim passing one field changes only that field; (4) conflicts are
// judged on the EFFECTIVE exclusive — a plain re-claim of a co-owned shared topic stays shared + succeeds, an explicit
// flip to exclusive is refused `held`; (5) this holder's own DORMANT durable record (on disk, not in RAM) is patched
// the same way; (6) a re-claim with persistent:false drops the durable record; (7) across a bridge RESTART:
// re-register → rehydrate → re-claim with only topic keeps every field. One gateway, persistence 'file' in a temp
// dir, a temp AI_BRIDGE_CONFIG (never src/config.json), ports 14400-14405.
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { create as createPersistence } from '../../facets/persistence/file.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tp = testPorts(import.meta.url, 14400)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'   // lets the pre-fix proof run this test against a reverted copy
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-reclaim-'))
const PDIR = path.join(TMP, 'persist')
const cfg = path.join(TMP, 'config.json')
fs.writeFileSync(cfg, '{}')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, String(x).slice(0, 600))) }

async function spawnBridge(port) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfg, AI_BRIDGE_NAME: 'Host', AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: 'reclaimtok', AI_BRIDGE_USER: 'robin', AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none',
      AI_BRIDGE_DEFAULT_BEHAVIOR: '', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: PDIR }, stderr: 'pipe' })
  const client = new Client({ name: 'test-reclaim', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}
let B = null
const call = async (n, a = {}) => JSON.parse((await B.client.callTool({ name: n, arguments: a })).content[0].text)
const A = { as: 'Alpha', secret: 'sa' }, Bt = { as: 'Beta', secret: 'sb' }, G = { as: 'Gamma', secret: 'sg' }
// the roster entry for `topic` held by the sub-peer named `holderName`
async function row(topic, holderName) {
  const sess = (await call('list_sessions')).sessions || []
  return sess.flatMap(s => s.topics || []).find(t => t.role === 'owner' && t.pattern === topic && t.holder_name === holderName) || null
}
const FIELDS = ['description', 'exclusive', 'icon', 'announce_offline', 'grace_minutes', 'allow_other_user', 'keep_alive', 'persistent', 'claimed_at']
const pickF = r => r ? Object.fromEntries(FIELDS.map(f => [f, r[f] ?? null])) : null
const diff = (x, y) => FIELDS.filter(f => JSON.stringify((x || {})[f] ?? null) !== JSON.stringify((y || {})[f] ?? null))

// ================================ run 1 ================================
B = await spawnBridge(tp(14400)); await sleep(600)
const regA = await call('register_self', { name: 'Alpha', secret: 'sa', project: 'rc' })
await call('register_self', { name: 'Beta', secret: 'sb', project: 'rc' })
const regG = await call('register_self', { name: 'Gamma', secret: 'sg', project: 'rc' })
check('sub-peers registered', regA.ok === true && regG.ok === true, JSON.stringify(regA))
await sleep(150)

// (1) a NEW claim with no flags gets the defaults
const c1 = await call('claim_topic', { topic: 'rc/defaults', ...A })
const r1 = await row('rc/defaults', 'Alpha')
check('(1) new claim, no flags: response exclusive + persistent true, not a re-claim', c1.ok === true && c1.exclusive === true && c1.persistent === true && !c1.reclaimed, JSON.stringify(c1))
check('(1) new claim, no flags: roster exclusive/announce_offline/persistent all true', !!r1 && r1.exclusive === true && r1.announce_offline === true && r1.persistent === true, JSON.stringify(r1))

// (2) claim with every field set, then re-claim passing ONLY topic: nothing changes
const FULL = { description: 'the bills', exclusive: false, announce_offline: false, icon: '🧾', grace_minutes: 7, allow_other_user: true, keep_alive: true }
const c2 = await call('claim_topic', { topic: 'rc/bills', ...FULL, ...A })
const before2 = pickF(await row('rc/bills', 'Alpha'))
check('(2) full claim recorded as given', !!before2 && before2.description === 'the bills' && before2.exclusive === false && before2.icon === '🧾' &&
  before2.announce_offline === false && before2.grace_minutes === 7 && before2.allow_other_user === true && before2.keep_alive === true && before2.persistent === true, JSON.stringify(before2))
await sleep(20)
const rc2 = await call('claim_topic', { topic: 'rc/bills', ...A })
const after2 = pickF(await row('rc/bills', 'Alpha'))
check('(2) plain re-claim: ok + reclaimed', rc2.ok === true && rc2.reclaimed === true, JSON.stringify(rc2))
check('(2) plain re-claim response keeps exclusive:false, icon, keep_alive, persistent',
  rc2.exclusive === false && rc2.icon === '🧾' && rc2.keep_alive === true && rc2.persistent === true, JSON.stringify(rc2))
check('(2) plain re-claim: EVERY roster field unchanged (incl. claimed_at)', diff(before2, after2).length === 0, `changed: ${diff(before2, after2)} ${JSON.stringify(after2)}`)

// (3) a re-claim that passes ONE field changes only that field
const rc3 = await call('claim_topic', { topic: 'rc/bills', description: 'bills + invoices', ...A })
const after3 = pickF(await row('rc/bills', 'Alpha'))
check('(3) re-claim with description only: description changed', rc3.ok === true && after3 && after3.description === 'bills + invoices', JSON.stringify(after3))
check('(3) re-claim with description only: nothing else changed', JSON.stringify(diff(after2, after3)) === '["description"]', `changed: ${diff(after2, after3)}`)
const rc3b = await call('claim_topic', { topic: 'rc/bills', announce_offline: true, ...A })
const after3b = pickF(await row('rc/bills', 'Alpha'))
check('(3) re-claim with announce_offline only: only announce_offline changed', rc3b.ok === true && after3b.announce_offline === true &&
  JSON.stringify(diff(after3, after3b)) === '["announce_offline"]', `changed: ${diff(after3, after3b)}`)
const rc3c = await call('claim_topic', { topic: 'rc/bills', announce_offline: false, ...A })   // back to silent for the restart case
check('(3) an explicit false is a real value (announce_offline back off)', rc3c.ok === true && (await row('rc/bills', 'Alpha')).announce_offline === false)

// (4) conflicts use the EFFECTIVE exclusive: a shared topic co-owned by Alpha + Beta
const s1 = await call('claim_topic', { topic: 'rc/co', exclusive: false, description: 'co-owned', ...A })
const s2 = await call('claim_topic', { topic: 'rc/co', exclusive: false, ...Bt })
check('(4) two holders co-own a shared topic', s1.ok === true && s2.ok === true && s2.exclusive === false, JSON.stringify(s2))
const p4a = await call('claim_topic', { topic: 'rc/co', ...A })
check('(4) PLAIN re-claim by Alpha stays shared + succeeds (not held)', p4a.ok === true && p4a.exclusive === false && p4a.reclaimed === true, JSON.stringify(p4a))
const p4b = await call('claim_topic', { topic: 'rc/co', ...Bt })
check('(4) PLAIN re-claim by Beta stays shared + succeeds (not held)', p4b.ok === true && p4b.exclusive === false && p4b.reclaimed === true, JSON.stringify(p4b))
const f4 = await call('claim_topic', { topic: 'rc/co', exclusive: true, ...A })
check('(4) re-claim flipping exclusive false→true with a co-owner is refused held', f4.ok === false && f4.code === 'held' && f4.holder_name === 'Beta', JSON.stringify(f4))
const r4 = await row('rc/co', 'Alpha')
check('(4) the refused flip left Alpha\'s claim shared + intact', !!r4 && r4.exclusive === false && r4.description === 'co-owned', JSON.stringify(r4))
const p4c = await call('claim_topic', { topic: 'rc/co', ...Bt })
check('(4) after the refused flip a plain re-claim still succeeds shared', p4c.ok === true && p4c.exclusive === false, JSON.stringify(p4c))

// (5) Gamma's own DORMANT durable record (on disk, not in RAM — as when a rehydrate was refused) is patched too
const pers = createPersistence({ HERE: SRCDIR, env: { AI_BRIDGE_PERSIST_DIR: PDIR }, CFG: {}, log: () => {} })
const gIdent = { ...regG.identity, name: 'Gamma' }
const DORMANT_AT = '2026-01-02T03:04:05.000Z'
await pers.claims.put('rc', 'rc/dormant', gIdent, { pattern: 'rc/dormant', role: 'owner', description: 'dormant duty', exclusive: false, icon: '🛌',
  holder_name: 'Gamma', project: gIdent.project, realm: gIdent.realm, user: gIdent.user, name: 'Gamma', announce_offline: false, grace_minutes: 3,
  allow_other_user: true, keep_alive: true, claimed_at: DORMANT_AT, persistent: true, refreshed_at: new Date().toISOString() })
check('(5) dormant record planted, not in RAM', !(await row('rc/dormant', 'Gamma')))
const d5 = await call('claim_topic', { topic: 'rc/dormant', ...G })
const r5 = pickF(await row('rc/dormant', 'Gamma'))
check('(5) claim over own dormant record is a re-claim', d5.ok === true && d5.reclaimed === true, JSON.stringify(d5))
check('(5) own dormant record\'s fields are kept (not defaulted)', !!r5 && r5.description === 'dormant duty' && r5.exclusive === false && r5.icon === '🛌' &&
  r5.announce_offline === false && r5.grace_minutes === 3 && r5.allow_other_user === true && r5.keep_alive === true && r5.persistent === true && r5.claimed_at === DORMANT_AT, JSON.stringify(r5))

// (6) persistent:false on a re-claim drops the durable record (it must NOT rehydrate after the restart below)
await call('claim_topic', { topic: 'rc/eph', description: 'ephemeral later', ...A })
const e6 = await call('claim_topic', { topic: 'rc/eph', persistent: false, ...A })
const r6 = await row('rc/eph', 'Alpha')
check('(6) re-claim persistent:false: now non-durable, other fields kept', e6.ok === true && !e6.persistent && !!r6 && r6.persistent === false && r6.description === 'ephemeral later' && r6.exclusive === true, JSON.stringify(r6))
const recs6 = await pers.claims.read('rc', 'rc/eph')
check('(6) its durable record was removed', recs6.length === 0, JSON.stringify(recs6))

const keep7 = pickF(await row('rc/bills', 'Alpha'))
await sleep(300)
await B.transport.close(); await sleep(800)

// ================================ run 2: restart ================================
B = await spawnBridge(tp(14402)); await sleep(600)
await call('register_self', { name: 'Alpha', secret: 'sa', project: 'rc' })   // fresh registration → rehydrates Alpha's durable claims
await sleep(200)
const h7 = pickF(await row('rc/bills', 'Alpha'))
check('(7) rehydrated after restart with every field intact', diff(keep7, h7).length === 0, `changed: ${diff(keep7, h7)} ${JSON.stringify(h7)}`)
check('(6) the persistent:false claim did not rehydrate', !(await row('rc/eph', 'Alpha')))
const rc7 = await call('claim_topic', { topic: 'rc/bills', ...A })
const a7 = pickF(await row('rc/bills', 'Alpha'))
check('(7) re-claim with ONLY topic after rehydrate: ok + reclaimed + still shared', rc7.ok === true && rc7.reclaimed === true && rc7.exclusive === false, JSON.stringify(rc7))
check('(7) re-claim after rehydrate: every field unchanged', diff(keep7, a7).length === 0, `changed: ${diff(keep7, a7)} ${JSON.stringify(a7)}`)
const recs7 = (await pers.claims.read('rc', 'rc/bills')).filter(r => r.name && r.name.toLowerCase() === 'alpha')
check('(7) the durable record still carries the preserved fields', recs7.length === 1 && recs7[0].description === 'bills + invoices' && recs7[0].exclusive === false &&
  recs7[0].icon === '🧾' && recs7[0].announce_offline === false && recs7[0].grace_minutes === 7 && recs7[0].allow_other_user === true && recs7[0].keep_alive === true, JSON.stringify(recs7))
await B.transport.close(); await sleep(300)

// a later restart keeps them too (the re-claim rewrote the record from the preserved values, not from defaults)
B = await spawnBridge(tp(14404)); await sleep(600)
await call('register_self', { name: 'Alpha', secret: 'sa', project: 'rc' })
await sleep(200)
const h8 = pickF(await row('rc/bills', 'Alpha'))
check('(7) a second restart still restores every field', diff(keep7, h8).length === 0, `changed: ${diff(keep7, h8)} ${JSON.stringify(h8)}`)

console.log(`\n${pass} passed, ${fail} failed`)
await B.transport.close()
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
