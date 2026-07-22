// #47 back-compat: the incoming operation was renamed 'deliver'→'receive'. This proves the rename does NOT
// strand data that predates it. Two flavours of legacy durable reminder exist in the wild and are pre-seeded
// here into a real (hashed) holder directory before the bridge starts:
//   1. a #44-era file whose JSON carries operation:"deliver"
//   2. a pre-#44 file whose JSON has NO operation field at all
// Both must (a) rehydrate as operation 'receive', (b) fire on a real delivered message, and — the subtle one —
// (c) be REMOVED when cleared, even though their on-disk filename is the legacy shape, so a cleared reminder
// can't be resurrected by a stale-named file on the next restart.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { identityKeys } from '../facets/persistence/file.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-rename-'))
const PORT = '7602'

// --- pre-seed two legacy behaviour files under the identity's REAL hashed holder dir (before any bridge runs) ---
const IDENT = { realm: 'default', project: 'ops', user: 'robin', name: 'Legacy' }
const holderDir = path.join(persistDir, 'behaviors', identityKeys(IDENT, false).both[0])
fs.mkdirSync(holderDir, { recursive: true })
// (1) #44-era, explicit operation:"deliver"
fs.writeFileSync(path.join(holderDir, 'deliver__project__ops.beh'),
  JSON.stringify({ realm: 'default', project: 'ops', user: 'robin', name: 'Legacy', operation: 'deliver', scope: 'project', match: 'ops', behavior: 'LEGACY-deliver-project', set_at: '2026-01-01T00:00:00.000Z' }))
// (2) pre-#44, NO operation field, unprefixed filename
fs.writeFileSync(path.join(holderDir, 'all__.beh'),
  JSON.stringify({ realm: 'default', project: 'ops', user: 'robin', name: 'Legacy', scope: 'all', match: null, behavior: 'LEGACY-noop-all', set_at: '2026-01-01T00:00:00.000Z' }))

const spawn = () => {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'Host', AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: String(Number(PORT) + 1), AI_BRIDGE_TOKEN: 'renametok',
      AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
  const client = new Client({ name: 'test-rename', version: '0' }, { capabilities: {} })
  return client.connect(transport).then(() => ({ client, transport }))
}
const behFilesOnDisk = () => fs.readdirSync(holderDir).filter(f => f.endsWith('.beh'))

let B = await spawn(); await sleep(500)
const call = async (n, a = {}) => JSON.parse((await B.client.callTool({ name: n, arguments: a })).content[0].text)

// --- (a) both legacy reminders rehydrate, both as operation 'receive' ---
const reg = await call('register_self', { name: 'Legacy', secret: 'lg', project: 'ops', user: 'robin' })
const seen = reg.behaviors || []
check('legacy behaviours rehydrate on register', seen.length === 2, JSON.stringify(seen))
check("#44-era operation:'deliver' loads as 'receive'", seen.some(b => b.scope === 'project' && b.match === 'ops' && b.operation === 'receive'), JSON.stringify(seen))
check("pre-#44 no-operation file loads as 'receive'", seen.some(b => b.scope === 'all' && b.operation === 'receive'), JSON.stringify(seen))
check('no legacy reminder leaks the old operation name', !seen.some(b => b.operation === 'deliver'), JSON.stringify(seen))

// --- (b) they actually FIRE on a delivered message (project-scope + all-scope, most-specific first) ---
await call('register_self', { name: 'Sender', secret: 'sn', project: 'ops', user: 'robin' })
await sleep(120)
await call('send_to_peer', { target: 'Legacy', subject: 'ping', message: 'legacy-check', as: 'Sender', secret: 'sn' })
await sleep(200)
const msg = (await call('inbox', { for: 'Legacy', secret: 'lg', cursor: 0 })).messages.find(m => m.body === 'legacy-check')
const rms = (msg && msg.reminders) || []
check('legacy reminders ride the delivered message as receive', rms.length === 2 && rms.every(r => r.operation === 'receive'), JSON.stringify(rms))
check('project reminder is most-specific (before all)', rms[0].scope === 'project' && rms[1].scope === 'all', JSON.stringify(rms.map(r => r.scope)))

// --- (c) clearing removes the legacy-NAMED files (content sweep), so nothing resurrects on restart ---
// clear the all-scope one with NO operation (defaults to receive) — its file is the unprefixed pre-#44 name.
// (persistence removal is fire-and-forget behind the tool response, so settle briefly before reading the dir.)
const clAll = await call('clear_behavior', { scope: 'all', as: 'Legacy', secret: 'lg' })
check('clear (no operation) clears the pre-#44 all reminder', clAll.cleared === 1, JSON.stringify(clAll))
await sleep(200)
check('the legacy-named all__.beh file is gone', !behFilesOnDisk().includes('all__.beh'), behFilesOnDisk().join(','))
// clear the project one passing the LEGACY 'deliver' alias — must still delete deliver__project__ops.beh
const clProj = await call('clear_behavior', { operation: 'deliver', scope: 'project', match: 'ops', as: 'Legacy', secret: 'lg' })
check("clear via legacy 'deliver' alias clears the project reminder", clProj.cleared === 1, JSON.stringify(clProj))
await sleep(200)
check('the legacy-named deliver__project__ops.beh file is gone', !behFilesOnDisk().includes('deliver__project__ops.beh'), behFilesOnDisk().join(','))
check('no .beh files remain for the holder', behFilesOnDisk().length === 0, behFilesOnDisk().join(','))

// --- restart: the cleared legacy reminders must NOT come back ---
await B.transport.close(); await sleep(300)
B = await spawn(); await sleep(500)
const reg2 = await call('register_self', { name: 'Legacy', secret: 'lg', project: 'ops', user: 'robin' })
check('after clear + restart, no reminders resurrect', (reg2.behaviors || []).length === 0, JSON.stringify(reg2.behaviors))

console.log(`\n${pass} passed, ${fail} failed`)
await B.transport.close()
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
