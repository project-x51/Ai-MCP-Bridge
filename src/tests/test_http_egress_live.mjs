// #33 live: a session calls http_request, the bridge proxies to an operator-declared backend (a tiny local
// echo server), enforcing the project allowlist + origin containment. The backend config comes via
// AI_BRIDGE_EGRESS_BACKENDS (the same path as config.services.egress.backends).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const PORT = 7655

// tiny echo backend on 127.0.0.1:PORT — replies JSON describing what it received
const echo = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body })) })
})
await new Promise(r => echo.listen(PORT, '127.0.0.1', r))

const backends = { echo: { base: `http://127.0.0.1:${PORT}`, methods: ['GET', 'POST'], projects: ['ops'], allowHeaders: ['x-test'], headers: { 'x-injected': 'yes' } } }
const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: 'Host', AI_BRIDGE_PORT: '7660', AI_BRIDGE_WS_PORT: '7661', AI_BRIDGE_TOKEN: 'testtok',
    AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'none', AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none',
    AI_BRIDGE_EGRESS_BACKENDS: JSON.stringify(backends) }, stderr: 'pipe' })
const B = { client: new Client({ name: 'test-egress', version: '0' }, { capabilities: {} }), transport }
await B.client.connect(transport); await sleep(500)
const call = async (n, a = {}) => JSON.parse((await B.client.callTool({ name: n, arguments: a })).content[0].text)

// http_request shows up in the tool list
const tools = (await B.client.listTools()).tools.map(t => t.name)
check('http_request tool is exposed when a backend is configured', tools.includes('http_request'))

await call('register_self', { name: 'Worker', secret: 'w', project: 'ops' })
await call('register_self', { name: 'Outsider', secret: 'o', project: 'other' })
await sleep(150)

// GET through the bridge to the backend
const g = await call('http_request', { backend: 'echo', method: 'GET', path: '/hello', query: { q: '1' }, headers: { 'x-test': 'abc', 'x-evil': 'no' }, as: 'Worker', secret: 'w' })
check('GET ok (200) via the bridge', g.ok === true && g.status === 200, JSON.stringify({ ok: g.ok, status: g.status, code: g.code }))
const seen = g.ok ? JSON.parse(g.body) : {}
check('backend received the GET at the contained path', seen.method === 'GET' && seen.url === '/hello?q=1', g.body)
check('allowed caller header passed; disallowed stripped', seen.headers && seen.headers['x-test'] === 'abc' && !('x-evil' in seen.headers))
check('server-side header injected to the backend', seen.headers && seen.headers['x-injected'] === 'yes')

// POST json
const p = await call('http_request', { backend: 'echo', method: 'POST', path: '/submit', json: { a: 1 }, as: 'Worker', secret: 'w' })
const pseen = p.ok ? JSON.parse(p.body) : {}
check('POST json reaches the backend with body + content-type', pseen.method === 'POST' && pseen.body === '{"a":1}' && pseen.headers['content-type'] === 'application/json', p.body)

// project allowlist: Outsider (project 'other') is denied
const f = await call('http_request', { backend: 'echo', path: '/x', as: 'Outsider', secret: 'o' })
check('a session whose project is not allowed -> forbidden', f.ok === false && f.code === 'forbidden', JSON.stringify(f))

// containment + unknown backend
check('//host path is rejected (no SSRF)', (await call('http_request', { backend: 'echo', path: '//169.254.169.254/x', as: 'Worker', secret: 'w' })).code === 'bad-path')
check('unknown backend rejected', (await call('http_request', { backend: 'nope', as: 'Worker', secret: 'w' })).code === 'unknown-backend')

console.log(`\n${pass} passed, ${fail} failed`)
await B.transport.close()
await new Promise(r => echo.close(r))
process.exit(fail ? 1 : 0)
