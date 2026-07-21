// #41(c) — a FOLLOWER's capabilities must reach the gateway roster AFTER the startup facet probe, not just
// its stale pre-probe values from the REGISTER frame.
//
// The bug: CAPS is mutated by the facet probe ~50ms after startup, but a follower only ever sent its
// capabilities once — in the REGISTER frame at connect. So if REGISTER went out before the probe finished,
// the gateway roster kept the follower's pre-probe values forever (recover_secret/presence_confirm = false),
// while the gateway's OWN entry re-broadcast correctly. Same install, two sessions, opposite roster values.
//
// To make the window deterministic, the follower is launched with AI_BRIDGE_PROBE_MS large, so it definitely
// REGISTERs (caps not yet probed) before its probe runs. The fix (a CAPS update frame) must then correct the
// gateway roster. A backed vault (`script`) is used so the probed value is TRUE and distinguishable from the
// false starting point.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const TOKEN = 'capstok', PORT = '7970', WSPORT = '7971'
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-caps-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

function spawn(port, extraEnv) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: 'C' + port, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_USER: 'robin', AI_BRIDGE_VAULT: 'script', AI_BRIDGE_AUTHORIZER: 'script',
      AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir, AI_BRIDGE_BIND: '127.0.0.1',
      AI_BRIDGE_DISCOVERY: 'none', ...extraEnv }, stderr: 'pipe' })
  const client = new Client({ name: 't-caps', version: '0' }, { capabilities: {} })
  return client.connect(transport).then(() => ({ client, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)

// gateway probes quickly (its own path always worked); follower probes LATE so it registers first
const GW = await spawn(PORT, { AI_BRIDGE_PROBE_MS: '20' }); await sleep(700)   // binds :7970 -> gateway
const FO = await spawn(PORT, { AI_BRIDGE_PROBE_MS: '1500' }); await sleep(900)   // same port -> loses election -> follower; probe NOT yet run

const gwId = await call(GW, 'my_identity'), foId = await call(FO, 'my_identity')
check('two sessions present, one gateway one follower', gwId.role === 'gateway' && foId.role === 'follower', `${gwId.role}/${foId.role}`)

// BEFORE the follower's probe fires: the gateway roster should still show it false (the pre-probe state)
const early = await call(GW, 'list_sessions')
const foEarly = (early.sessions || []).find(s => s.session === foId.session)
check('follower on the gateway roster starts recover_secret=false (pre-probe)', !!foEarly && foEarly.capabilities && foEarly.capabilities.recover_secret === false, JSON.stringify(foEarly && foEarly.capabilities))

// let the follower's late probe run + propagate
await sleep(2000)
const late = await call(GW, 'list_sessions')
const foLate = (late.sessions || []).find(s => s.session === foId.session)
check("follower's PROBED caps reached the gateway roster (recover_secret=true)", !!foLate && foLate.capabilities && foLate.capabilities.recover_secret === true, JSON.stringify(foLate && foLate.capabilities))
check('…and presence_confirm too', !!foLate && foLate.capabilities && foLate.capabilities.presence_confirm === true, JSON.stringify(foLate && foLate.capabilities))
// the follower's own view agrees — this is the value it should have advertised all along
const foSelf = await call(FO, 'my_identity')
check('follower self-report matches (no split-brain)', foSelf.capabilities.recover_secret === true, JSON.stringify(foSelf.capabilities))

console.log(`\n${pass} passed, ${fail} failed`)
await GW.transport.close(); await FO.transport.close()
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
