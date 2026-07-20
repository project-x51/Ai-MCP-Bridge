// Stable peer ids (#40) — two-phase rollout.
//
// PHASE 1 (default): the bridge READS `peer:` ids but still MINTS the legacy process-scoped form, so it can be
// rolled out one host at a time with no coordinated restart — an older bridge never receives an id it cannot
// parse, and a 1.26 bridge handles both forms.
// PHASE 2 (AI_BRIDGE_STABLE_IDS=1): it MINTS stable ids, which is only safe once every host reads them.
//
// The load-bearing test here is TOLERANCE: a reader-only bridge must route to a `peer:` id it would never
// have minted itself. That is the property that makes the uncoordinated rollout safe.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const TOKEN = 'stableidtok'
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-stableid-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

async function spawnBridge(port, extraEnv = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'SB' + port, AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none', ...extraEnv }, stderr: 'pipe' })
  const client = new Client({ name: 't-stableids', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

// ================= PHASE 1 (default): reads stable ids, still mints legacy =================
let A = await spawnBridge(7920, { AI_BRIDGE_STABLE_IDS: '0' }); await sleep(700)   // pin phase 1 (don't inherit config.json)
const idA = await call(A, 'my_identity')
check('phase 1: advertises stable_ids_read', idA.capabilities.stable_ids_read === true, JSON.stringify(idA.capabilities))
check('phase 1: does NOT advertise stable_ids_write', idA.capabilities.stable_ids_write === false, JSON.stringify(idA.capabilities))

const legacy = await call(A, 'register_self', { name: 'Legacy', secret: 'sl', project: 'idtest' })
check('phase 1 mints the LEGACY process-scoped id', /\/legacy-[0-9a-f]+$/.test(legacy.peer_id) && !legacy.peer_id.startsWith('peer:'), legacy.peer_id)

// legacy ids still route by id and by name on a 1.26 bridge
await call(A, 'register_self', { name: 'Probe', secret: 'sp', project: 'idtest' })
await sleep(200)
const byLegacyId = await call(A, 'send_to_peer', { target: legacy.peer_id, subject: 'x', message: 'to-legacy-id', as: 'Probe', secret: 'sp' })
check('phase 1: a legacy id still routes', byLegacyId.ok === true, JSON.stringify(byLegacyId))
await sleep(200)
const inLegacy = await call(A, 'inbox', { for: 'Legacy', secret: 'sl', cursor: 0 })
check('phase 1: legacy-id send was delivered', inLegacy.messages.some(m => m.body === 'to-legacy-id'), JSON.stringify(inLegacy.messages.map(m => m.body)))
await A.transport.close(); await sleep(600)

// ================= PHASE 2 (opt-in): mints stable ids =================
let S = await spawnBridge(7924, { AI_BRIDGE_STABLE_IDS: '1' }); await sleep(700)
const idS = await call(S, 'my_identity')
check('phase 2: advertises stable_ids_write', idS.capabilities.stable_ids_write === true, JSON.stringify(idS.capabilities))
const st1 = await call(S, 'register_self', { name: 'Stable', secret: 'ss', project: 'idtest' })
check('phase 2 mints a stable peer: id', /^peer:stable-[0-9a-f]{8}$/.test(st1.peer_id), st1.peer_id)
check('stable id embeds no session/process', !st1.peer_id.includes('/'), st1.peer_id)
await S.transport.close(); await sleep(600)

// THE POINT: a different process (new port, new random session) mints the SAME id
S = await spawnBridge(7926, { AI_BRIDGE_STABLE_IDS: '1' }); await sleep(700)
const st2 = await call(S, 'register_self', { name: 'Stable', secret: 'ss', project: 'idtest' })
check('stable id is IDENTICAL across a bridge restart', st2.peer_id === st1.peer_id, `${st1.peer_id} -> ${st2.peer_id}`)

// identity-derived: a DIFFERENT project (same name) must NOT collide with the one above
const other = await call(S, 'register_self', { name: 'Stable2', secret: 'ss2', project: 'idtest' })
check('a different peer gets a different stable id', other.peer_id !== st2.peer_id, `${other.peer_id} vs ${st2.peer_id}`)

// stable ids route locally by id and by name
await call(S, 'register_self', { name: 'Probe2', secret: 'sp2', project: 'idtest' })
await sleep(200)
const byStableId = await call(S, 'send_to_peer', { target: st2.peer_id, subject: 'y', message: 'to-stable-id', as: 'Probe2', secret: 'sp2' })
check('a stable id routes locally', byStableId.ok === true, JSON.stringify(byStableId))
await sleep(250)
const inStable = await call(S, 'inbox', { for: 'Stable', secret: 'ss', cursor: 0 })
check('stable-id send was delivered', inStable.messages.some(m => m.body === 'to-stable-id'), JSON.stringify(inStable.messages.map(m => m.body)))

// ============ TOLERANCE: a READER-ONLY bridge routes to a `peer:` id it would never mint ============
// This is what makes the uncoordinated rollout safe. R joins the SAME gateway as S (same port/token), so its
// roster carries S's stable-id sub-peer; R must resolve and deliver to it despite minting legacy ids itself.
const R = await spawnBridge(7928, { AI_BRIDGE_PORT: '7926', AI_BRIDGE_STABLE_IDS: '0' }); await sleep(900)   // reader-only: pin phase 1; 7926 = S's gateway
const idR = await call(R, 'my_identity')
check('reader-only bridge: read yes, write no', idR.capabilities.stable_ids_read === true && idR.capabilities.stable_ids_write === false, JSON.stringify(idR.capabilities))
const rProbe = await call(R, 'register_self', { name: 'ReaderProbe', secret: 'srp', project: 'idtest' })
check('reader-only bridge still mints legacy ids', !rProbe.peer_id.startsWith('peer:'), rProbe.peer_id)
await sleep(500)
const crossOk = await call(R, 'send_to_peer', { target: st2.peer_id, subject: 'z', message: 'reader-to-stable', as: 'ReaderProbe', secret: 'srp' })
check('READER-ONLY bridge resolves + routes a stable peer: id', crossOk.ok === true, JSON.stringify(crossOk))
await sleep(400)
const inCross = await call(S, 'inbox', { for: 'Stable', secret: 'ss', cursor: inStable.next_cursor })
check('…and the message actually arrived', inCross.messages.some(m => m.body === 'reader-to-stable'), JSON.stringify(inCross.messages.map(m => m.body)))

console.log(`\n${pass} passed, ${fail} failed`)
await R.transport.close(); await S.transport.close()
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
