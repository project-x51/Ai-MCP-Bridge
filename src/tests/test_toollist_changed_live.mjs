// #45 — the bridge NOTIFIES tools/list_changed after a client initializes, so a client that upgraded the
// bridge under a running session refreshes its cached tool schema (and stops stripping a new param like
// #44's set_behavior `operation`) WITHOUT a full client restart.
//
// This test verifies the BRIDGE's half of the contract: it declares the listChanged capability and emits the
// notification post-initialize. The CLIENT's half (does it re-fetch and update its cache) is client-specific
// and is verified live against a real Claude Code client — a test double like the SDK Client here doesn't
// prove Claude Code's behaviour, only that the signal is on the wire.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { fileURLToPath } from 'node:url'

const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

const t = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: 'GW', AI_BRIDGE_PORT: '7997', AI_BRIDGE_WS_PORT: '7998', AI_BRIDGE_TOKEN: 'tlctok',
    AI_BRIDGE_USER: 'robin', AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
const c = new Client({ name: 'code-t-tlc', version: '0' }, { capabilities: {} })

// capture the notification the moment it arrives
let listChanged = 0
c.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged++ })

await c.connect(t)

// the server must ADVERTISE the capability so a client knows it can expect the notification
const caps = c.getServerCapabilities ? c.getServerCapabilities() : null
check('bridge advertises tools.listChanged capability', !!(caps && caps.tools && caps.tools.listChanged === true), JSON.stringify(caps && caps.tools))

// and it must EMIT the notification shortly after initialize (the fix nudges at ~300ms)
await sleep(1200)
check('bridge emits tools/list_changed after the client initializes', listChanged >= 1, `count=${listChanged}`)

// the refreshed list still contains the tool + its new param, i.e. the notification points at a real change
const tools = await c.listTools()
const sb = (tools.tools || []).find(x => x.name === 'set_behavior')
check('set_behavior is present after the refresh', !!sb)
check('#44: the refreshed set_behavior schema carries the `operation` param', !!(sb && sb.inputSchema && sb.inputSchema.properties && sb.inputSchema.properties.operation), JSON.stringify(sb && sb.inputSchema && Object.keys(sb.inputSchema.properties || {})))

console.log(`\n${pass} passed, ${fail} failed`)
await c.close()
process.exit(fail ? 1 : 0)
