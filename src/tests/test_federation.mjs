// Cross-host federation (§7): two bridges on distinct ports act as two "machines". They discover each
// other via the `seeds` backend, gossip rosters peer-to-peer (no central node), and deliver envelopes
// host-to-host through the gateway CONNECT-splice. Loopback-simulated; the smaller ADVERTISE:PORT
// initiates the single inter-hub link. A departing host falls out of the roster with no bookkeeping.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))

const TOKEN = 'testtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) } }

async function spawnBridge(name, port, seeds) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: String(port), AI_BRIDGE_WS_PORT: String(port + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_SWEEP_MS: '500',
      AI_BRIDGE_DISCOVERY: 'seeds', AI_BRIDGE_SEEDS: seeds, AI_BRIDGE_DISCOVERY_MS: '300' }, stderr: 'pipe' })
  const client = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport, name }
}
const call = async (b, n, a = {}) => JSON.parse((await b.client.callTool({ name: n, arguments: a })).content[0].text)
const drain = async (b, who, secret) => (await call(b, 'inbox', { for: who, secret })).messages
const subNamesOf = ls => { const o = []; (ls.sessions || []).forEach(s => (s.subpeers || []).forEach(sp => o.push(sp.name))); return o }

// two "machines": HostX on :7700, HostY on :7710, each seeding the other
const X = await spawnBridge('HostX', 7700, '127.0.0.1:7710')
const Y = await spawnBridge('HostY', 7710, '127.0.0.1:7700')
await sleep(500)

const lsX0 = await call(X, 'list_sessions'), lsY0 = await call(Y, 'list_sessions')
check('X is its own gateway', lsX0.role === 'gateway', JSON.stringify(lsX0.role))
check('Y is its own gateway', lsY0.role === 'gateway', JSON.stringify(lsY0.role))

await call(X, 'register_self', { name: 'alpha-x', secret: 'sx', project: 'shared', user: 'rx' })
await call(Y, 'register_self', { name: 'beta-y', secret: 'sy', project: 'shared', user: 'ry' })
await sleep(1800)   // discovery tick + inter-hub link + roster gossip settle

// 1. gossip: each host sees the other's sub-peer in its merged roster
const lsX = await call(X, 'list_sessions'), lsY = await call(Y, 'list_sessions')
check('X sees Y sub-peer via gossip', subNamesOf(lsX).includes('beta-y'), JSON.stringify(subNamesOf(lsX)))
check('Y sees X sub-peer via gossip', subNamesOf(lsY).includes('alpha-x'), JSON.stringify(subNamesOf(lsY)))
// the remote entry is tagged with its origin gateway + that gateway's dial address (so the splice reaches it)
const yOnX = (lsX.sessions || []).find(s => (s.subpeers || []).some(sp => sp.name === 'beta-y'))
check('remote session carries origin + owning-gateway dial address',
  !!yOnX && !!yOnX.origin && yOnX.host === '127.0.0.1' && Number(yOnX.port) === 7710,
  JSON.stringify(yOnX && { origin: yOnX.origin, host: yOnX.host, port: yOnX.port }))

// 2. cross-host delivery X -> Y (envelope crosses machines via the owning gateway's CONNECT-splice)
const sXY = await call(X, 'send_to_peer', { target: 'beta-y', subject: 'hello Y', message: 'from X across the mesh', as: 'alpha-x', secret: 'sx' })
check('X->Y cross-host send accepted', sXY.ok === true, JSON.stringify(sXY))
await sleep(300)
check('Y sub-peer received the cross-host message', (await drain(Y, 'beta-y', 'sy')).some(m => m.body === 'from X across the mesh'))

// 3. cross-host delivery Y -> X (other direction)
const sYX = await call(Y, 'send_to_peer', { target: 'alpha-x', subject: 'hello X', message: 'from Y across the mesh', as: 'beta-y', secret: 'sy' })
check('Y->X cross-host send accepted', sYX.ok === true, JSON.stringify(sYX))
await sleep(300)
check('X sub-peer received the cross-host message', (await drain(X, 'alpha-x', 'sx')).some(m => m.body === 'from Y across the mesh'))

// 4. a host leaving drops its entries with no central bookkeeping
await Y.transport.close()   // HostY goes offline
await sleep(1300)
check('departed host falls out of the roster', !subNamesOf(await call(X, 'list_sessions')).includes('beta-y'))

console.log(`\n${pass} passed, ${fail} failed`)
await X.transport.close()
process.exit(fail ? 1 : 0)
