// E2E: real bridge gateway + the reusable page widget (aimb-page-bridge.js + aimb-bridge-ui.js)
// rendered in jsdom against the generic demo fixture (test_page.html) + real clicks.
// Tests the WIDGET CONTRACT only — session/topic dropdown, selection, send, sub-peers, offline,
// bridge-down — not any host application's page structure. Point AIMB_TEST_PAGE at another page
// that follows the same contract (mount #aimb-mount, button.aimb-discuss) to reuse this harness.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
import { JSDOM } from 'jsdom'
import { spawn } from 'child_process'
import fs from 'fs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

// one bridge on an ISOLATED port (so a live mesh on the canonical 7000/7001 can't make this bridge a
// follower), named so the widget shows it (unnamed hex processes are hidden by design).
const PORT = '7852', WSPORT = '7853'
const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'],
  cwd: SRCDIR, env: { ...process.env, AI_BRIDGE_NAME: 'Gateway', AI_BRIDGE_PROJECT: 'demo', AI_BRIDGE_USER: 'tester', AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: WSPORT }, stderr: 'pipe' })
const client = new Client({ name: 'e2e', version: '0' }, { capabilities: {} })
const pushed = []
client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') pushed.push(n.params) }
await client.connect(transport)
await sleep(500)
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text)
const id = await call('my_identity')
check('bridge is gateway', id.role === 'gateway', id.role)

// load the fixture; inline the sibling widget scripts so jsdom executes them deterministically
// (a browser keeps the <script src> form; a host page that already inlines is a no-op replace).
const PAGE = process.env.AIMB_TEST_PAGE || new URL('../test_page.html', import.meta.url)
let html = fs.readFileSync(PAGE, 'utf8')
for (const f of ['aimb-page-bridge.js', 'aimb-bridge-ui.js']) {
  const js = fs.readFileSync(new URL('../tools/' + f, import.meta.url), 'utf8')
  html = html.replace(`<script src="./tools/${f}"></script>`, `<script>\n${js}\n</script>`)
}
// the fixture reads its mesh token from ?token= (a browser user appends it); supply the canonical one
const TOKEN = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).token || ''
const PAGE_URL = 'file:///demo.html?token=' + encodeURIComponent(TOKEN) + '&ws=ws://127.0.0.1:' + WSPORT
const dom = new JSDOM(html, { runScripts: 'dangerously', url: PAGE_URL })
const doc = dom.window.document
check('jsdom has WebSocket', typeof dom.window.WebSocket === 'function')
await sleep(1200)  // page connects + hello + welcome

const pip = doc.getElementById('aimb-pip')
const sel = doc.getElementById('aimb-target')
const btn = doc.querySelector('button.aimb-discuss')
const change = () => sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))

// --- no auto-selection: ready pip, empty selection, disabled buttons
const gopt = [...sel.options].find(o => o.dataset && o.dataset.name === 'Gateway')
check('dropdown lists the named session', !!gopt, sel.innerHTML)
check('named session carries a client-kind type label', gopt && /(Coder|Coworker)\s*$/.test(gopt.textContent) && ['aimb-code', 'aimb-cw'].includes(gopt.className), gopt && gopt.textContent + '/' + gopt.className)
check('online circle in option text', gopt && gopt.textContent.indexOf('\u{1F7E2}') === 0, gopt && gopt.textContent)
check('no auto-selection (placeholder)', sel.value === '', sel.value)
check('pip green when sessions exist', pip.classList.contains('on'), pip.className)
check('select untinted before selection', sel.className === '', sel.className)
check('button visible but disabled before selection', !!btn && btn.disabled === true, btn && String(btn.disabled))

// --- select the session -> URL persistence, button enabled, tint matches
gopt.selected = true; change()
check('selection persisted to URL', (dom.window.location.search + dom.window.location.hash).includes('session=Gateway'), dom.window.location.search + ' ' + dom.window.location.hash)
check('pip stays green after selection', pip.classList.contains('on'), pip.className)
check('select tint matches selected option type', sel.className === gopt.className, sel.className + ' vs ' + gopt.className)
check('button enabled after selection', btn.disabled === false)

// page appears on the mesh roster
const ls = await call('list_sessions')
check('page on roster (demo leaf)', ls.pages.some(p => p.page_kind === 'demo'), JSON.stringify(ls.pages))

// --- click Discuss -> app verb + subject + payload reach the selected session
btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
await sleep(800)
check('button acked', /Sent/.test(btn.textContent), btn.textContent)
const inbox = await call('inbox')
const msg = inbox.messages.find(m => m.verb === 'demo_action')
check('session inbox got the app verb', !!msg)
check('message carries the mandatory subject', msg && /^demo action demo-/.test(msg.subject || ''), msg && msg.subject)
const body = msg && JSON.parse(msg.body)
check('payload carries the app data', body && /^demo-/.test(body.ref || ''), JSON.stringify(body))
check('from is the page leaf', msg && msg.from.kind === 'page' && msg.from.name === 'demo')
check('channel push fired too', pushed.some(p => p.meta.verb === 'demo_action'))

// --- sub-peers replace their parent process node in the dropdown
const reg = await call('register_self', { name: 'Worker', secret: 'e2e-sub-secret', client: 'cowork' })
check('sub-peer registered', reg.ok === true, JSON.stringify(reg))
await sleep(800)  // roster broadcast reaches the page

const offo = [...sel.options].find(o => o.className === 'aimb-offline' && o.dataset.name === 'Gateway')
check('selected-but-offline keeps name in dropdown', !!offo, sel.innerHTML)
check('offline circle in offline option', offo && offo.textContent.indexOf('⚪') === 0, offo && offo.textContent)
check('select tinted offline-grey', sel.className === 'aimb-offline', sel.className)
check('button disabled when selected session offline', btn.disabled === true)
const sopt = [...sel.options].find(o => o.dataset && o.dataset.name === 'Worker')
check('dropdown lists sub-peer', !!sopt && sopt.value === reg.peer_id, sel.innerHTML)
check('sub-peer labelled Coworker', sopt && sopt.textContent.includes('Coworker') && sopt.className === 'aimb-cw', sopt && sopt.textContent + '/' + sopt.className)
check('parent process hidden once it has sub-peers', ![...sel.options].some(o => o.value === ls.gateway), sel.innerHTML)

// Discuss routed to the sub-peer's PRIVATE queue, no double delivery to the process
sopt.selected = true; change()
check('URL updated to sub-peer name', (dom.window.location.search + dom.window.location.hash).includes('session=Worker'), dom.window.location.search)
btn.textContent = 'Discuss'
btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
await sleep(800)
check('button acked (sub-peer target)', /Sent/.test(btn.textContent), btn.textContent)
const sin = await call('inbox', { for: reg.peer_id, secret: 'e2e-sub-secret' })
check('sub-peer inbox got the app verb', (sin.messages || []).some(m => m.verb === 'demo_action'), JSON.stringify(sin))
const main2 = await call('inbox')
check('process queue not double-delivered', (main2.messages || []).filter(m => m.verb === 'demo_action').length === 1,
  JSON.stringify((main2.messages || []).map(m => m.verb)))

// --- topics (v1.3): a claimed topic appears in the Ai Topics group and is sendable
const claim = await call('claim_topic', { topic: 'demo/claims', description: 'e2e test claim', icon: '\u{1F9EA}' })
check('topic claimed', claim.ok === true, JSON.stringify(claim))
await sleep(900)  // roster gossip reaches the page
const tgroup = [...sel.querySelectorAll('optgroup')].find(g => g.label === 'Ai Topics')
check('Ai Topics group renders', !!tgroup, [...sel.querySelectorAll('optgroup')].map(g => g.label).join('|'))
const topt = tgroup && [...tgroup.children].find(o => o.dataset.name === 'topic:demo/claims')
check('claimed topic listed', !!topt && topt.textContent.includes('demo/claims'), topt && topt.textContent)
topt.selected = true; change()
btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
await sleep(800)
const tin = await call('inbox')
check('topic owner inbox got the send', (tin.messages || []).filter(m => m.verb === 'demo_action').length >= 2, JSON.stringify((tin.messages || []).length))

// restore sub-peer selection
sopt.selected = true; change(); await sleep(100)

// --- named-conversations-only: an UNNAMED process (default hex id) must not appear
const fol = spawn('node', [SRCDIR + 'bridge.mjs'], { cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: '', AI_BRIDGE_MODE: 'poll', AI_BRIDGE_PORT: PORT, AI_BRIDGE_WS_PORT: WSPORT }, stdio: ['pipe', 'ignore', 'ignore'] })
await sleep(1800)
const ls2 = await call('list_sessions')
check('unnamed follower joined roster', (ls2.sessions || []).length === 2, JSON.stringify((ls2.sessions || []).map(s => s.session)))
const named = [...sel.options].filter(o => o.dataset && o.dataset.name && o.dataset.name.indexOf('topic:') !== 0).map(o => o.dataset.name)
check('unnamed process hidden from dropdown', named.length === 1 && named[0] === 'Worker', JSON.stringify(named))
fol.kill()

// --- fresh page load with ?session= re-selects automatically
const dom2 = new JSDOM(html, { runScripts: 'dangerously', url: PAGE_URL + '#session=Worker' })
await sleep(1200)
const sel2 = dom2.window.document.getElementById('aimb-target')
const cur2 = sel2.selectedOptions[0]
check('reload auto-selects persisted session', cur2 && cur2.dataset.name === 'Worker' && cur2.value === reg.peer_id, sel2.innerHTML)
check('reloaded page button enabled', dom2.window.document.querySelector('button.aimb-discuss').disabled === false)
dom2.window.close()

// --- pip goes grey, controls disabled, when the bridge dies
await transport.close()
await sleep(600)
check('pip grey when bridge offline', !pip.classList.contains('on') && !pip.classList.contains('idle'), pip.className)
check('pip shows offline glyph', pip.textContent === '⚪', pip.textContent)
check('selector disabled when bridge offline', sel.disabled === true)
check('button disabled when bridge offline', btn.disabled === true)

console.log(`\n${pass} passed, ${fail} failed`)
dom.window.close()
process.exit(fail ? 1 : 0)
