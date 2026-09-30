// #58 regression guard: on a CLI host each Claude Code session spawns its OWN follower bridge, which registers
// ONE sub-peer — one conversation that used to render twice (a bare-hex bridge row/bubble AND its sub-peer).
// Loads dashboard.html in jsdom (stubbed WebSocket) with a three-machine roster covering every case of the
// collapse rule, then asserts the sessions list (both views), the mesh map and the Computers counts agree:
//   phub-lnx-01      — a service gateway; a code follower with ONE sub-peer (collapses -> "Modell");
//                      a code follower with TWO sub-peers (unchanged)
//   Robins-Mac.local — a claude-code GATEWAY with one sub-peer (never collapsed); a bare code session, no sub-peer
//   ROBIN-Z790       — a tray gateway; the desktop's shared agent bridge with sub-peers (unchanged)
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import fs from 'fs'
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

const file = process.env.DASHBOARD_HTML || fileURLToPath(new URL('../dashboard.html', import.meta.url))
const html = fs.readFileSync(file, 'utf8')
class FakeWS { constructor(url) { this.url = url; this.readyState = 0; FakeWS.last = this } send() {} close() { this.readyState = 3; this.onclose && this.onclose() } }
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file:///dash.html?token=t&ws=ws://x',
  beforeParse(window) { window.WebSocket = FakeWS } })
const doc = dom.window.document

const V = '1.51.0', R = 'default'
const SOLO = 'phub-lnx-01/62bd6ec7', SOLO_SP = 'phub-lnx-01/62bd6ec7/modell-1a2b'
const MULTI = 'phub-lnx-01/9e0b6a8d', MULTI_A = 'phub-lnx-01/9e0b6a8d/renda-3c4d', MULTI_B = 'phub-lnx-01/9e0b6a8d/renda-sub-5e6f'
const MACGW = 'Robins-Mac.local/aa11bb22', MACGW_SP = 'Robins-Mac.local/aa11bb22/macpal-7a8b'
const BARE = 'Robins-Mac.local/43cbd85c'
const code = (session, extra) => ({ session, name: session.split('/')[1], host_label: session.split('/')[0], bridge_version: V, is_gateway: false,
  client: 'claude-code', client_kind: 'code', realm: R, project: 'AIMB', user: 'robin', connected_at: '2026-09-30T08:15:00.000Z', subpeers: [], topics: [], ...extra })
const sub = (id, name, extra) => ({ id, name, kind: 'subpeer', client: 'claude-code', client_kind: 'code', mode: 'push', channel_capable: true, project: 'AIMB', user: 'robin', realm: R, ...extra })
const roster = {
  type: 'welcome', gateway: 'ROBIN-Z790/aaa', hosts: {},
  sessions: [
    { session: 'ROBIN-Z790/aaa', name: 'aaa', host_label: 'ROBIN-Z790', bridge_version: V, is_gateway: true, client: 'Task Tray', client_kind: 'other', realm: R, subpeers: [], topics: [] },
    { session: 'ROBIN-Z790/bbb', name: 'bbb', host_label: 'ROBIN-Z790', bridge_version: V, is_gateway: false, client: 'local-agent', client_kind: 'agent', realm: R, topics: [],
      subpeers: [sub('ROBIN-Z790/bbb/robin-1', 'ROBIN-1', { client_kind: 'agent', client: 'local-agent', mode: 'poll', channel_capable: false }),
        sub('ROBIN-Z790/bbb/cow-1', 'Cowork-Conn', { client_kind: 'cowork', client: 'claude-desktop', mode: 'poll', channel_capable: false })] },
    { session: 'phub-lnx-01/gw01', name: 'gw01', host_label: 'phub-lnx-01', bridge_version: V, is_gateway: true, host: '100.64.0.5', client: 'aimb-bridge', client_kind: 'other', realm: R, subpeers: [], topics: [] },
    // the client string is peer-supplied: a quote in it must not break out of the hover title attribute
    code(SOLO, { host: '100.64.0.5', client: 'claude-code" data-x="1', subpeers: [sub(SOLO_SP, 'Modell')],
      topics: [{ pattern: 'models', role: 'owner', holder: SOLO_SP, exclusive: false, persistent: true }] }),
    code(MULTI, { host: '100.64.0.5', subpeers: [sub(MULTI_A, 'Renda'), sub(MULTI_B, 'Renda-Sub', { parent: MULTI_A })] }),
    code(MACGW, { is_gateway: true, host: '100.64.0.9', subpeers: [sub(MACGW_SP, 'MacPal')] }),
    code(BARE, { host: '100.64.0.9' }),
  ],
  pages: [],
}
const ws = FakeWS.last
ws.readyState = 1; ws.onopen && ws.onopen()
ws.onmessage({ data: JSON.stringify(roster) })

const sb = doc.getElementById('sessions'), map = doc.getElementById('map')
const rows = () => [...sb.querySelectorAll('tr.x-row')]
// the Name cell's bubble text for each row (cell 0 is the chevron)
const names = () => rows().map(r => { const b = r.children[1] && r.children[1].querySelector('.bub'); return b ? b.textContent : '' })
const nameCount = n => names().filter(t => t === n).length
const idCell = () => rows().map(r => r.children[2] ? r.children[2].textContent : '')

// ---- sessions list, CONNECTIONS view (the default)
const gb = doc.getElementById('groupBy'); gb.value = 'none'; gb.dispatchEvent(new dom.window.Event('change'))
check('conn view: the one-sub-peer code follower renders ONCE, as its sub-peer (Modell)', nameCount('Modell') === 1, JSON.stringify(names()))
check('conn view: no separate bare-hex row for that bridge (62bd6ec7)', nameCount('62bd6ec7') === 0 && !idCell().includes(SOLO), JSON.stringify(names()))
const modellBub = rows().map(r => r.children[1].querySelector('.bub')).find(b => b && b.textContent === 'Modell')
check('conn view: the collapsed row carries the bridge detail on hover (session id + version)', !!modellBub && (modellBub.getAttribute('title') || '').includes(SOLO) && (modellBub.getAttribute('title') || '').includes('v' + V), modellBub && modellBub.getAttribute('title'))
check('conn view: a quote in the bridge client stays inside the hover title (no attribute injection)', !!modellBub && !modellBub.hasAttribute('data-x') && (modellBub.getAttribute('title') || '').includes('claude-code" data-x="1'), modellBub && modellBub.outerHTML)
const modellDet = rows().find(r => r.children[1].textContent.includes('Modell'))?.nextElementSibling
check('conn view: the collapsed row expander shows the bridge + connected time', !!modellDet && modellDet.textContent.includes(SOLO) && modellDet.textContent.includes('2026-09-30 08:15:00'), modellDet && modellDet.textContent)
check('conn view: the collapsed row keeps the sub-peer topics', !!rows().find(r => r.children[1].textContent.includes('Modell') && r.textContent.includes('Models')))
check('conn view: a bare code session (no sub-peer) still renders (43cbd85c)', nameCount('43cbd85c') === 1, JSON.stringify(names()))
check('conn view: the multi-sub-peer bridge is unchanged (bridge row + both sub-peers)', nameCount('9e0b6a8d') === 1 && nameCount('Renda') === 1 && nameCount('Renda-Sub') === 1, JSON.stringify(names()))
check('conn view: the code GATEWAY is not collapsed (gateway row + its sub-peer)', nameCount('aa11bb22') === 1 && nameCount('MacPal') === 1, JSON.stringify(names()))
check('conn view: the shared agent bridge stays hidden, its sub-peers promoted', nameCount('Bbb') === 0 && nameCount('ROBIN-1') === 1 && nameCount('Cowork-Conn') === 1, JSON.stringify(names()))
check('conn view: row count = 9 (one per conversation, no double count)', rows().length === 9, rows().length + ' ' + JSON.stringify(names()))

// ---- sessions list, SHOW BRIDGES (nested process) view
const cb = doc.getElementById('showBridges'); cb.checked = true; cb.dispatchEvent(new dom.window.Event('change'))
check('bridges view: Modell renders ONCE and 62bd6ec7 has no row of its own', nameCount('Modell') === 1 && nameCount('62bd6ec7') === 0 && !idCell().includes(SOLO), JSON.stringify(names()))
const modellRow = rows().find(r => r.children[1].textContent.includes('Modell'))
check('bridges view: the collapsed row is top-level (not indented as a leaf)', !!modellRow && !modellRow.children[1].textContent.includes('↳'))
check('bridges view: the bare session, the multi-sub-peer bridge and the shared agent bridge keep their rows', nameCount('43cbd85c') === 1 && nameCount('9e0b6a8d') === 1 && nameCount('Bbb') === 1, JSON.stringify(names()))
const rendaRow = rows().find(r => r.children[1].textContent.includes('Renda') && !r.children[1].textContent.includes('Sub'))
const macpalRow = rows().find(r => r.children[1].textContent.includes('MacPal'))
check('bridges view: multi-sub-peer + gateway sub-peers still nest under their bridge (↳)', !!rendaRow && rendaRow.children[1].textContent.includes('↳') && !!macpalRow && macpalRow.children[1].textContent.includes('↳'))
check('bridges view: all three gateways still tagged GATEWAY', (sb.textContent.match(/GATEWAY/g) || []).length === 3, (sb.textContent.match(/GATEWAY/g) || []).length)
check('bridges view: row count = 12 (13 before the collapse)', rows().length === 12, rows().length + ' ' + JSON.stringify(names()))

// ---- mesh map
const node = id => doc.getElementById('n-' + id)
const labels = () => [...map.querySelectorAll('.n-label')].map(e => e.textContent)
check('map: the collapsed pair is ONE node — the sub-peer — and no bridge node', !!node(SOLO_SP) && !node(SOLO) && labels().filter(t => t === 'Modell').length === 1 && !labels().includes('62bd6ec7'), JSON.stringify(labels()))
check('map: the collapsed node is drawn as a sub-peer (n-subp code), not a bridge-sized session', !!node(SOLO_SP) && node(SOLO_SP).classList.contains('n-subp') && node(SOLO_SP).classList.contains('code') && !node(SOLO_SP).classList.contains('n-sess'))
check('map: the collapsed node carries the bridge detail on hover', !!node(SOLO_SP) && !!node(SOLO_SP).querySelector('title') && node(SOLO_SP).querySelector('title').textContent.includes(SOLO) && node(SOLO_SP).querySelector('title').textContent.includes('v' + V))
check('map: the collapsed node links to its gateway', !!doc.getElementById('e-' + SOLO_SP))
check('map: the bare code session still has its node', !!node(BARE) && node(BARE).classList.contains('n-sess') && node(BARE).classList.contains('code'))
check('map: the multi-sub-peer bridge keeps its node + both sub-peer nodes', !!node(MULTI) && node(MULTI).classList.contains('n-sess') && !!node(MULTI_A) && !!node(MULTI_B))
check('map: the code GATEWAY is not collapsed (gateway node + separate sub-peer node)', !!node(MACGW) && node(MACGW).classList.contains('gw') && !!node(MACGW_SP) && node(MACGW_SP) !== node(MACGW))
check('map: the shared agent bridge keeps its node + sub-peers', !!node('ROBIN-Z790/bbb') && !!node('ROBIN-Z790/bbb/robin-1') && !!node('ROBIN-Z790/bbb/cow-1'))
const nodeCount = map.querySelectorAll('g.n-sess, g.n-subp').length
check('map: node count = 12 (one per conversation; 13 before the collapse)', nodeCount === 12, 'nodes=' + nodeCount)
// a trace from either id lights the one node
ws.onmessage({ data: JSON.stringify({ type: 'trace', trace: { ts: '2026-09-30T08:20:00.000Z', dir: 'send', from: SOLO_SP, to: MACGW_SP, verb: 'hi', subject: 's', envelope_id: 'e1', size: 1 } }) })
check('map: a trace from the sub-peer pulses the collapsed node and its gateway edge', !!node(SOLO_SP) && node(SOLO_SP).classList.contains('pulse') && doc.getElementById('e-' + SOLO_SP).classList.contains('pulse-e'))

// ---- Computers counts: Sessions = bridges shown as bridges; Connections = conversations (no double count)
const compRows = [...doc.querySelectorAll('#computers tr')]
const counts = h => { const r = compRows.find(x => x.textContent.includes(h)); return r ? [r.children[3].textContent, r.children[4].textContent].join('/') : null }
check('computers: phub-lnx-01 = 2 sessions / 3 connections (gateway + multi bridge; Modell, Renda, Renda-Sub)', counts('phub-lnx-01') === '2/3', counts('phub-lnx-01'))
check('computers: Robins-Mac.local = 2 sessions / 1 connection (gateway + bare; MacPal)', counts('Robins-Mac.local') === '2/1', counts('Robins-Mac.local'))
check('computers: ROBIN-Z790 = 2 sessions / 2 connections (unchanged)', counts('ROBIN-Z790') === '2/2', counts('ROBIN-Z790'))

console.log(`\n${pass} passed, ${fail} failed`)
dom.window.close()
process.exit(fail ? 1 : 0)
