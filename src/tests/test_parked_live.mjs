// §23 regression: a message written to a peer's DURABLE mailbox while that peer is already LIVE (the
// out-of-band / another-process / re-park case) must surface on a normal `inbox` poll AND on reattach —
// not only on a fresh register. We simulate "another process parked it" by writing straight into the same
// persistence dir via the facet, then assert the live peer's poll/reattach drains it (deduped, no doubling).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { create } from '../facets/persistence/file.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-parked-'))
const USER = 'tester', PROJECT = 'demo'

const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: 'Host', AI_BRIDGE_PORT: '7480', AI_BRIDGE_WS_PORT: '7481', AI_BRIDGE_TOKEN: 'testtok',
    AI_BRIDGE_USER: USER, AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
const B = { client: new Client({ name: 'test-parked', version: '0' }, { capabilities: {} }), transport }
await B.client.connect(transport); await sleep(500)
const call = async (n, a = {}) => JSON.parse((await B.client.callTool({ name: n, arguments: a })).content[0].text)

// the SAME persistence facet the bridge uses, pointed at the SAME dir — our "other process" parking mail
const store = create({ HERE: SRCDIR, CFG: { persistence: { dir: persistDir } }, env: {} })
const ownerIdentity = { realm: 'default', project: PROJECT, user: USER, name: 'Owner' }
const parkOutOfBand = (id, body) => store.mailbox.put(ownerIdentity, id, {
  id, ts: new Date().toISOString(), from: { session: 'x/probe', name: 'Probe', kind: 'session', project: PROJECT, user: USER, realm: 'default' },
  to: 'x/owner', verb: 'note', subject: 'oob ' + id, body, pattern: 'send', topic: null, hops: [] })   // plaintext env (no enc) → view() passes it through

// --- register a live Owner + a Probe sender
const ow = await call('register_self', { name: 'Owner', secret: 'os', project: PROJECT })
await call('register_self', { name: 'Probe', secret: 'ps', project: PROJECT })
check('Owner registered live', ow.ok === true && /\/owner-[0-9a-f]+$/.test(ow.peer_id), ow.peer_id)

// --- baseline: a normal live send is delivered exactly once and the drain does NOT duplicate it
await call('send_to_peer', { subject: 'live', target: 'Owner', verb: 'note', message: 'live-one', as: 'Probe', secret: 'ps' })
await sleep(250)
const in1 = await call('inbox', { for: 'Owner', secret: 'os', cursor: 0 })
check('baseline: live message delivered once (no drain dup)', in1.messages.length === 1 && in1.messages.filter(m => m.body === 'live-one').length === 1, JSON.stringify(in1.messages.map(m => m.body)))
const cur1 = in1.next_cursor

// --- THE BUG: park a message out-of-band while Owner is LIVE, then a PLAIN poll must surface it
await parkOutOfBand('env_oob1', 'out-of-band-1')
const in2 = await call('inbox', { for: 'Owner', secret: 'os', cursor: cur1 })
check('out-of-band parked mail surfaces on a plain poll', in2.messages.some(m => m.id === 'env_oob1' && m.body === 'out-of-band-1'), JSON.stringify(in2.messages.map(m => m.body)))
check('…and exactly once', in2.messages.filter(m => m.id === 'env_oob1').length === 1)
const cur2 = in2.next_cursor

// --- no re-duplication: polling again past the cursor returns nothing new
const in3 = await call('inbox', { for: 'Owner', secret: 'os', cursor: cur2 })
check('no re-drain duplication on the next poll', in3.messages.length === 0, JSON.stringify(in3.messages.map(m => m.body)))

// --- reattach path also surfaces out-of-band mail (the §20 resync hint should reflect it)
await parkOutOfBand('env_oob2', 'out-of-band-2')
const re = await call('register_self', { name: 'Owner', secret: 'os', project: PROJECT })
check('reattach reports the new parked mail in next_cursor', re.reattached === true && re.next_cursor > cur2, JSON.stringify({ reattached: re.reattached, next_cursor: re.next_cursor, cur2 }))
const in4 = await call('inbox', { for: 'Owner', secret: 'os', cursor: cur2 })
check('reattach surfaced out-of-band mail to the poll', in4.messages.some(m => m.id === 'env_oob2' && m.body === 'out-of-band-2'), JSON.stringify(in4.messages.map(m => m.body)))

console.log(`\n${pass} passed, ${fail} failed`)
await B.transport.close()
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
