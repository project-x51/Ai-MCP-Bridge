// Dashboard Persistence view (#6): the gateway pushes a durable-state snapshot to the dashboard, which
// renders it as a Persistence section (count chips + a per-store expander). Real bridge (persistence=file,
// isolated temp dir) + the real dashboard.html in jsdom.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import WebSocket from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
const TOKEN = 'testtok'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-dashpers-'))

const t = new StdioClientTransport({ command: 'node', args: [SRCDIR + 'bridge.mjs'], cwd: SRCDIR,
  env: { ...process.env, AI_BRIDGE_NAME: 'DashHost', AI_BRIDGE_PORT: '7460', AI_BRIDGE_WS_PORT: '7461', AI_BRIDGE_TOKEN: TOKEN,
    AI_BRIDGE_USER: 'robin', AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persistDir, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_DISCOVERY: 'none',
    AI_BRIDGE_DASH_PERSIST_MS: '500' }, stderr: 'pipe' })
const c = new Client({ name: 't-dashpers', version: '0' }, { capabilities: {} })
await c.connect(t)
const call = async (n, a = {}) => JSON.parse((await c.callTool({ name: n, arguments: a })).content[0].text)
await sleep(500)

// lay down some durable state before the dashboard connects: a registration, a claim, and a subscription
await call('register_self', { name: 'Worker', secret: 'sw', project: 'ops' })
await call('claim_topic', { topic: 'builds', as: 'Worker', secret: 'sw', exclusive: true, announce_offline: true })
await call('claim_topic', { topic: 'online-tool/analysis', as: 'Worker', secret: 'sw', description: 'hyphen+slash display-case' })
await call('subscribe', { pattern: 'alerts/#', as: 'Worker', secret: 'sw' })
await sleep(300)

const DASH = fileURLToPath(new URL('../dashboard.html', import.meta.url))
const dom = new JSDOM(fs.readFileSync(DASH, 'utf8'), { runScripts: 'dangerously', url: `file:///dash.html?token=${TOKEN}&ws=ws://127.0.0.1:7461` })
await sleep(1500)   // connect + welcome + the 500ms persistence push
const doc = dom.window.document

check('dashboard connected (pip on)', doc.getElementById('pip').classList.contains('on'))
check('profile line shows version + persistence=file', /persistence=/.test(doc.getElementById('prof').textContent) && /v\d/.test(doc.getElementById('prof').textContent), doc.getElementById('prof').textContent)
check('Persistence section is visible', doc.getElementById('perssec').style.display !== 'none')
check('summary chips rendered', /claim/.test(doc.getElementById('perssum').textContent) && doc.querySelectorAll('#perssum .chip').length >= 5, doc.getElementById('perssum').textContent)
const persText = doc.getElementById('persistence').textContent
// #38 display-case: claimed lower-case ('builds' / 'alerts/#') but DISPLAYED Title-cased (compare lower, show Title)
check('claims store lists the durable claim, display-cased (builds -> Builds)', /Builds/.test(persText) && !/builds/.test(persText), persText.slice(0, 160))
check('registrations store lists the peer (Worker)', /Worker/.test(persText))
check('subscriptions store lists the pattern, display-cased (alerts/# -> Alerts/#)', /Alerts\/#/.test(persText) && !/alerts\/#/.test(persText))
check('#38: hyphen+slash topic Title-cased per word (online-tool/analysis -> Online-Tool/Analysis)', /Online-Tool\/Analysis/.test(persText) && !/online-tool\/analysis/.test(persText), persText.slice(0, 240))

// --- regression: an opened expander must SURVIVE a re-render. roster/persistence pushes rebuild the
// table (innerHTML=''), which used to snap any open inner expander shut "a moment later". The open state
// is now remembered by a stable key (here 'pers/claims').
const detOpen = r => !!(r && r.nextElementSibling && r.nextElementSibling.classList.contains('x-det') && r.nextElementSibling.style.display !== 'none')
const findClaims = () => [...doc.getElementById('persistence').querySelectorAll('tr.x-row')].find(r => /Claims/.test(r.textContent))
const claimRow = findClaims()
check('claims store expander present', !!claimRow)
claimRow.dispatchEvent(new dom.window.Event('click'))
check('expander opens on click', detOpen(claimRow))
await call('subscribe', { pattern: 'metrics/+', as: 'Worker', secret: 'sw' })   // mutate state + let the periodic push rebuild
await sleep(1300)                                                                // > one DASH_PERSIST_MS (500ms) push cycle
const claimRow2 = findClaims()
check('persistence table was rebuilt by the push', !!claimRow2 && claimRow2 !== claimRow)   // proves the bug path is exercised
check('opened expander stays open across the re-render', detOpen(claimRow2))

await t.close()
console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(persistDir, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
