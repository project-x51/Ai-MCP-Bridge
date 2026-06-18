// MANUAL / INTERACTIVE — not part of `npm test` (it raises a real Windows Hello prompt you must answer).
// Exercises the whole §16 chain live: claim_topic -> authorizer(hello) -> HelloConfirm.exe -> Windows Hello
// -> dormant-topic takeover. Run it AT THE KEYBOARD:  node tests/manual/test_hello_authorizer.mjs
//
// Flow: A1 (you) claims a durable topic and goes offline (its claim is now dormant). A2 — a DIFFERENT
// session of the SAME user — tries to claim it. The bridge must get your physical presence first: a Hello
// prompt appears. Approve it -> the takeover succeeds. (Re-run and DENY to see it held.)
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))   // src/
const sleep = ms => new Promise(r => setTimeout(r, ms))
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-hello-'))
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

async function spawn(port) {
  const t = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'H', AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: 'testtok', AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir,
      AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none', AI_BRIDGE_AUTHORIZER: 'hello' }, stderr: 'inherit' })
  const c = new Client({ name: 'hello-manual', version: '0' }, { capabilities: {} })
  await c.connect(t); return { client: c, transport: t }
}

console.log('\n=== Windows Hello authorizer — live experiment ===\n')
const exe = path.resolve(SRCDIR, '../tray/windows/HelloConfirm.exe')
if (!fs.existsSync(exe)) { console.log('Building HelloConfirm.exe ...'); spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', path.resolve(SRCDIR, '../tray/windows/build-hello.cmd')], { stdio: 'inherit' }) }
const avail = spawnSync(exe, ['--check'], { encoding: 'utf8' })
console.log('Hello availability check -> exit', avail.status, '(0 = available)\n', (avail.stdout || '').trim())
if (avail.status !== 0) { console.log('\nWindows Hello is not available on this machine — cannot run the live prompt.'); process.exit(2) }

let B = await spawn(7990); await sleep(800)
await call(B, 'register_self', { name: 'A1', secret: 's1', project: 'shared' })
await call(B, 'claim_topic', { topic: 'lead', as: 'A1', secret: 's1', exclusive: true })
console.log('A1 claimed durable topic "lead", then goes offline (dormant claim) ...')
const a1 = (await call(B, 'list_sessions')).sessions.flatMap(s => s.subpeers || []).find(s => s.name === 'A1').id
await call(B, 'deregister', { peer_id: a1, secret: 's1' })
await sleep(300)
await call(B, 'register_self', { name: 'A2', secret: 's2', project: 'shared' })

console.log('\n>>> A2 (same user) now claims "lead". A WINDOWS HELLO PROMPT SHOULD APPEAR — approve it. <<<\n')
const res = await call(B, 'claim_topic', { topic: 'lead', as: 'A2', secret: 's2', exclusive: true })
console.log('\nclaim_topic result:', JSON.stringify(res))
if (res.ok) console.log('\nRESULT: APPROVED -> takeover succeeded (A2 now owns "lead").')
else console.log('\nRESULT: NOT APPROVED -> held (code=' + res.code + ', reason=' + (res.reason || '') + ').');

await B.transport.close()
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(0)
