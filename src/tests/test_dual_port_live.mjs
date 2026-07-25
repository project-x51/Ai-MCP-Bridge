// #57 dual-port: during a port migration a gateway opts into listening on the OLD control/ws ports too
// (compatPorts), so a bridge still configured for the old port JOINS it as a follower instead of standing up a
// rival gateway on the new port. This is what removes the coordinated-restart requirement from the realm move.
// All on ONE loopback machine, which is exactly the "two bridges, same host, mid-migration" case.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const NEW = '13100', OLD = '13102', TOKEN = 'dualporttok'   // control ports; ws is +1 (13101 / 13103)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

// spawn a bridge. `compat` = comma-sep old control ports it ALSO listens on (ws compat derived as port+1).
function spawn(name, port, compat) {
  const wsPort = String(Number(port) + 1)
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: wsPort,
      AI_BRIDGE_COMPAT_PORTS: compat || '', AI_BRIDGE_COMPAT_WS_PORTS: compat ? String(Number(compat) + 1) : '',
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none' }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport }))
}
const call = async (b, n, a = {}) => JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text)

// ---- 1. NEW gateway (12317-style, compat on the OLD port). A bridge configured for the OLD port must JOIN it. ----
const GW = await spawn('GW', NEW, OLD); await sleep(800)
const gw = await call(GW, 'my_identity')
check('new-port gateway is gateway', gw.role === 'gateway', gw.role)

const F = await spawn('OldF', OLD, '');  await sleep(900)   // configured for the OLD port only, no compat
const f = await call(F, 'my_identity')
check('an OLD-port bridge JOINS the new-port gateway via its compat listener (no rival gateway)', f.role === 'follower' && f.gateway === gw.session, `${f.role} gw=${f.gateway} want=${gw.session}`)

// a message routes across the compat-port join
await call(GW, 'register_self', { name: 'GwPeer', secret: 'sg', project: 'DP' })
await call(F, 'register_self', { name: 'OldPeer', secret: 'sf', project: 'DP' })
await sleep(300)
await call(F, 'send_to_peer', { target: 'GwPeer', subject: 'x', message: 'crossed on the compat port', as: 'OldPeer', secret: 'sf' })
await sleep(300)
const inbox = await call(GW, 'inbox', { for: 'GwPeer', secret: 'sg', cursor: 0 })
check('a message routes across the compat-port join', (inbox.messages || []).some(m => m.body === 'crossed on the compat port'), JSON.stringify((inbox.messages || []).map(m => m.body)))

// ---- 2. WS compat: a doorbell/listener hitting the OLD ws port reaches the new-port gateway ----
const wsOld = new WebSocket(`ws://127.0.0.1:${Number(OLD) + 1}`)
const welcome = await new Promise(res => {
  let done = false
  wsOld.on('open', () => wsOld.send(JSON.stringify({ type: 'hello', kind: 'listener', token: TOKEN, watch: { name: 'GwPeer', project: 'DP' } })))
  wsOld.on('message', r => { if (done) return; let m = null; try { m = JSON.parse(r.toString()) } catch { return } if (m.type === 'welcome') { done = true; res(m) } })
  wsOld.on('error', () => { if (!done) { done = true; res(null) } })
  setTimeout(() => { if (!done) { done = true; res(null) } }, 2500)
})
check('a listener on the OLD ws port reaches the gateway (ws compat)', !!(welcome && welcome.gateway === gw.session), JSON.stringify(welcome))
try { wsOld.close() } catch {}

for (const b of [GW, F]) { try { await b.transport.close() } catch {} }
await sleep(500)

// ---- 3. REVERSE start order: OLD-port bridge is up FIRST; the NEW-port+compat bridge must STEP DOWN and follow it. ----
const OLDGW = await spawn('OldGW', OLD, ''); await sleep(800)
const oldgw = await call(OLDGW, 'my_identity')
check('old-port bridge (started first) is gateway', oldgw.role === 'gateway', oldgw.role)

const NEWF = await spawn('NewF', NEW, OLD); await sleep(900)   // wants NEW primary, compat OLD — but OLD is already held
const newf = await call(NEWF, 'my_identity')
check('new-port bridge grabs its primary then finds the compat port HELD, so it follows the old gateway (no split-brain)',
  newf.role === 'follower' && newf.gateway === oldgw.session, `${newf.role} gw=${newf.gateway} want=${oldgw.session}`)

for (const b of [OLDGW, NEWF]) { try { await b.transport.close() } catch {} }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
