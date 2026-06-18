// Retained topic values (§12): publish {retain:true} keeps the last event per concrete topic; a new or
// returning subscriber is caught up on it immediately on subscribe (wildcard patterns match), and the
// retained value survives a bridge restart. Loopback-only, own persist dir.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const TOKEN = 'testtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, e)) }
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-retain-'))

async function spawn(port) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'R', AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
  const client = new Client({ name: 't-retain', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

// ---- run 1: publish retained, then a LATER subscriber is caught up on it ----
let B = await spawn(7991); await sleep(700)
await call(B, 'register_self', { name: 'Pub', secret: 'sp', project: 'shared' })
await call(B, 'register_self', { name: 'Late', secret: 'sl', project: 'shared' })
await sleep(150)
const pub = await call(B, 'publish', { topic: 'news/headline', subject: 'h', message: 'breaking', retain: true, as: 'Pub', secret: 'sp' })
check('retained publish accepted', pub.ok === true && pub.retained === true, JSON.stringify(pub))
await sleep(150)
// Late subscribes AFTER the publish (wildcard) -> should immediately receive the retained value
await call(B, 'subscribe', { pattern: 'news/#', as: 'Late', secret: 'sl' })
await sleep(250)
const lateIn = (await call(B, 'inbox', { for: 'Late', secret: 'sl', cursor: 0 })).messages.map(m => m.body)
check('a new subscriber gets the retained value on subscribe (wildcard match)', lateIn.includes('breaking'), JSON.stringify(lateIn))
// a fresh publish overwrites the retained value (last-value-wins)
await call(B, 'publish', { topic: 'news/headline', subject: 'h', message: 'updated', retain: true, as: 'Pub', secret: 'sp' })
await sleep(200)
await B.transport.close(); await sleep(700)

// ---- run 2: the retained value survived the restart and reaches a brand-new subscriber (newest wins) ----
B = await spawn(7993); await sleep(700)
await call(B, 'register_self', { name: 'Fresh', secret: 'sf', project: 'shared' })
await sleep(150)
await call(B, 'subscribe', { pattern: 'news/headline', as: 'Fresh', secret: 'sf' })
await sleep(250)
const freshIn = (await call(B, 'inbox', { for: 'Fresh', secret: 'sf', cursor: 0 })).messages.map(m => m.body)
check('retained value survives a restart and reaches a new subscriber', freshIn.includes('updated'), JSON.stringify(freshIn))
check('only the NEWEST retained value is delivered (last-value-wins)', !freshIn.includes('breaking'), JSON.stringify(freshIn))
await B.transport.close()

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
