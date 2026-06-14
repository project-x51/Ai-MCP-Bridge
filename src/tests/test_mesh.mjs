// Mesh test harness: 3 bridges as MCP stdio children + WS leaves.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
import WebSocket from 'ws'

const PORT = '7100', WSPORT = '7101', TOKEN = 'testtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, cond, extra='') => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) } }

async function spawnBridge(name) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: WSPORT, AI_BRIDGE_TOKEN: TOKEN }, stderr: 'pipe' })
  const client = new Client({ name: `test-${name}`, version: '0' }, { capabilities: {} })
  const pushed = []
  client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') pushed.push(n.params) }
  await client.connect(transport)
  return { client, transport, pushed, name }
}
const call = async (b, name, args={}) => JSON.parse((await b.client.callTool({ name, arguments: args })).content[0].text)

const A = await spawnBridge('Alpha');  await sleep(400)
const B = await spawnBridge('Bravo'); const C = await spawnBridge('Charlie')
await sleep(800)

// --- roster / election
const idA = await call(A, 'my_identity'), idB = await call(B, 'my_identity'), idC = await call(C, 'my_identity')
check('A is gateway', idA.role === 'gateway', idA.role)
check('B,C followers', idB.role === 'follower' && idC.role === 'follower')
const ls = await call(B, 'list_sessions')
check('roster has 3 sessions', ls.sessions.length === 3, JSON.stringify(ls.sessions.map(s=>s.name)))

// --- session -> session by friendly name (direct loopback)
const r1 = await call(A, 'send_to_peer', { target: 'Charlie', verb: 'discuss_issue', subject: 'discuss issue (test)', message: '{"issue_ref":"issue_8b1220c810e0-ebc1"}' })
check('A->C send ok', r1.ok === true, JSON.stringify(r1))
await sleep(300)
const inboxC = await call(C, 'inbox', {})
check('C inbox got it', inboxC.messages.length === 1 && inboxC.messages[0].verb === 'discuss_issue')
check('C channel push fired', C.pushed.length === 1 && C.pushed[0].meta.verb === 'discuss_issue', JSON.stringify(C.pushed))
check('push meta has from', C.pushed[0]?.meta.from === idA.session)

// --- dedupe: identical envelope routed twice should deliver once
const r1b = await call(A, 'send_to_peer', { target: 'Charlie', verb: 'discuss_issue', subject: 'discuss issue (test)', message: '{"issue_ref":"issue_8b1220c810e0-ebc1"}' })
await sleep(250)
const inboxC2 = await call(C, 'inbox', {})
check('distinct envelope delivered (new ts => new id)', inboxC2.messages.length === 2)

// --- self send
const rself = await call(B, 'send_to_peer', { target: 'Bravo', subject: 'self note (test)', message: 'note to self' })
check('self-send ok', rself.ok === true)

// --- WS page leaf
const wsPage = new WebSocket(`ws://127.0.0.1:${WSPORT}`)
const pageEvents = []
let welcome = null
wsPage.on('message', d => { const m = JSON.parse(d.toString()); pageEvents.push(m); if (m.type === 'welcome') welcome = m })
await new Promise(r => wsPage.on('open', r))
wsPage.send(JSON.stringify({ type: 'hello', kind: 'page', page_kind: 'demo', title: 'Demo Page', instance: 'pg1', token: TOKEN }))
await sleep(300)
check('leaf welcomed with roster', welcome && welcome.sessions.length === 3, JSON.stringify(welcome?.sessions?.length))
wsPage.send(JSON.stringify({ type: 'send', to: idB.session, verb: 'discuss_issue', subject: 'page discuss (test)', body: '{"issue_ref":"issue_eab6efe7eeb2-bdac"}', ref: 'click1', page_kind: 'demo' }))
await sleep(400)
const sent = pageEvents.find(m => m.type === 'sent')
check('leaf send acked ok', sent && sent.ok === true, JSON.stringify(sent))
const inboxB = await call(B, 'inbox', {})
const pageMsg = inboxB.messages.find(m => m.from.kind === 'page')
check('B received page message', !!pageMsg && pageMsg.verb === 'discuss_issue')
check('B channel push from page', B.pushed.some(p => p.meta.from_kind === 'page'))

// --- dashboard leaf gets traces
const wsDash = new WebSocket(`ws://127.0.0.1:${WSPORT}`)
const traces = []
wsDash.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'trace') traces.push(m.trace); if (m.type === 'trace_history') traces.push(...m.traces) })
await new Promise(r => wsDash.on('open', r))
wsDash.send(JSON.stringify({ type: 'hello', kind: 'dashboard', instance: 'dash1', token: TOKEN }))
await sleep(300)
check('dashboard has trace history', traces.length > 0, String(traces.length))
const before = traces.length
await call(A, 'send_to_peer', { target: 'Bravo', subject: 'trace probe (test)', message: 'trace me' })
await sleep(400)
check('live trace arrived (send+recv pair)', traces.length >= before + 2, `${before} -> ${traces.length}`)
const ids = traces.slice(-2).map(t => t.envelope_id)
check('send/recv share envelope_id', ids[0] === ids[1], JSON.stringify(ids))

// --- bad token rejected
const wsBad = new WebSocket(`ws://127.0.0.1:${WSPORT}`)
let badClosed = false
wsBad.on('close', () => badClosed = true)
await new Promise(r => wsBad.on('open', r))
wsBad.send(JSON.stringify({ type: 'hello', kind: 'page', token: 'WRONG' }))
await sleep(300)
check('bad token closed', badClosed)

// --- failover: kill gateway A
await A.transport.close()
await sleep(2500)   // re-election backoff
const idB2 = await call(B, 'my_identity'), idC2 = await call(C, 'my_identity')
check('new gateway elected', (idB2.role === 'gateway') !== (idC2.role === 'gateway') && [idB2.role, idC2.role].includes('gateway'), `${idB2.role}/${idC2.role}`)
const ls2 = await call(B, 'list_sessions')
check('roster reformed (2 sessions)', ls2.sessions.length === 2, JSON.stringify(ls2.sessions.map(s=>s.name)))
const r2 = await call(B, 'send_to_peer', { target: 'Charlie', subject: 'failover probe (test)', message: 'post-failover hello' })
check('B->C works after failover', r2.ok === true, JSON.stringify(r2))
await sleep(200)
const inboxC3 = await call(C, 'inbox', {})
check('C got post-failover msg', inboxC3.messages.some(m => m.body === 'post-failover hello'))

// --- leaf reconnects to new gateway
const wsPage2 = new WebSocket(`ws://127.0.0.1:${WSPORT}`)
let welcome2 = null
wsPage2.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'welcome') welcome2 = m })
await new Promise((res, rej) => { wsPage2.on('open', res); wsPage2.on('error', rej) }).catch(()=>{})
wsPage2.send(JSON.stringify({ type: 'hello', kind: 'page', page_kind: 'demo', instance: 'pg2', token: TOKEN }))
await sleep(300)
check('leaf reconnected to new gateway', welcome2 && welcome2.sessions.length === 2, JSON.stringify(welcome2?.gateway))

console.log(`\n${pass} passed, ${fail} failed`)
try { wsPage.close(); wsDash.close(); wsPage2.close() } catch {}
await B.transport.close(); await C.transport.close()
process.exit(fail ? 1 : 0)
