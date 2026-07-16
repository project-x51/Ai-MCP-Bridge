// Multi-machine dashboard rendering (§7 visualisation): two real bridges on loopback share one
// hostname, so we can't simulate two machines that way. Instead we load dashboard.html in jsdom with a
// stubbed WebSocket and feed it a hand-crafted two-machine roster (a remote gateway via is_gateway, a
// code sub-peer, a remote page), then assert the by-machine grouping, gateway markers, code=orange, and
// the cross-host edge.
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import fs from 'fs'
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }

const html = fs.readFileSync(fileURLToPath(new URL('../dashboard.html', import.meta.url)), 'utf8')
class FakeWS { constructor(url) { this.url = url; this.readyState = 0; FakeWS.last = this } send() {} close() { this.readyState = 3; this.onclose && this.onclose() } }
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file:///dash.html?token=t&ws=ws://x',
  beforeParse(window) { window.WebSocket = FakeWS } })
const doc = dom.window.document

const roster = {
  type: 'welcome', gateway: 'ROBIN-Z790/aaa', hosts: { 'ROBIN-Z790': 'Lab PC' },
  sessions: [
    { session: 'ROBIN-Z790/aaa', name: 'aaa', host_label: 'ROBIN-Z790', is_gateway: true, client: 'Task Tray', client_kind: 'other', realm: 'default', subpeers: [], topics: [] },
    { session: 'ROBIN-Z790/bbb', name: 'bbb', host_label: 'ROBIN-Z790', is_gateway: false, client: 'local-agent', client_kind: 'agent', realm: 'default', topics: [],
      subpeers: [{ id: 'ROBIN-Z790/bbb/robin-1', name: 'ROBIN-1', client_kind: 'agent', project: 'AIMB', user: 'Robin', realm: 'default' }] },
    { session: 'VOLT-001/ccc', name: 'ccc', host_label: 'VOLT-001', is_gateway: true, origin: 'VOLT-001/ccc', host: '100.115.125.90', client: 'Task Tray', client_kind: 'other', realm: 'default', subpeers: [], topics: [] },
    { session: 'VOLT-001/ddd', name: 'ddd', host_label: 'VOLT-001', is_gateway: false, origin: 'VOLT-001/ccc', host: '100.115.125.90', client: 'local-agent', client_kind: 'agent', realm: 'default', topics: [],
      subpeers: [{ id: 'VOLT-001/ddd/volt-1', name: 'VOLT-1', client_kind: 'code', mode: 'push', channel_capable: true, project: 'AIMB', user: 'Robin', realm: 'default' }] },
  ],
  pages: [{ instance: 'pg1', page_kind: 'chat', title: 'Chat — Robin', project: 'AIMB', user: 'Robin', host_label: 'ROBIN-Z790' }],
}
const ws = FakeWS.last
ws.readyState = 1; ws.onopen && ws.onopen()
ws.onmessage({ data: JSON.stringify(roster) })

const sb = doc.getElementById('sessions'), map = doc.getElementById('map')

// default view is CONNECTIONS-ONLY: bridge/gateway process rows are hidden; their sub-peers/pages are promoted
check('default hides bridge rows (no GATEWAY badge) but keeps connections', !sb.textContent.includes('GATEWAY') && sb.textContent.includes('VOLT-1') && sb.textContent.includes('ROBIN-1'), sb.textContent.slice(0, 140))
// enable "show bridges" for the full nested view asserted below
const bridgesCb = doc.getElementById('showBridges'); bridgesCb.checked = true; bridgesCb.dispatchEvent(new dom.window.Event('change'))

// by-machine grouping: a header row per machine, both hostnames present
const machRows = [...sb.querySelectorAll('tr.mach-row')]
check('one header row per machine', machRows.length === 2, 'rows=' + machRows.length)
check('ROBIN-Z790 machine header present', sb.textContent.includes('ROBIN-Z790'))
check('VOLT-001 machine header present', sb.textContent.includes('VOLT-001'))

// remote gateway is marked GATEWAY in the list (both gateways carry the badge)
check('both gateways tagged GATEWAY in list', (sb.textContent.match(/GATEWAY/g) || []).length >= 2, sb.textContent.match(/GATEWAY/g))

// code session = orange (b-code); non-code sub-peer = yellow (b-subp)
const codeBadge = [...sb.querySelectorAll('.b-code')].find(e => e.textContent.includes('VOLT-1'))
check('code sub-peer VOLT-1 uses orange b-code badge', !!codeBadge)
const robinBadge = [...sb.querySelectorAll('.b-subp')].find(e => e.textContent.includes('ROBIN-1'))
check('non-code (agent) sub-peer ROBIN-1 uses yellow b-subp badge', !!robinBadge)
// #2/push-honesty: a channel-capable push sub-peer shows "· push" (renamed from "streaming"); it is NOT
// shown for a mode:push sub-peer that lacks channel capability (so it doesn't claim an unimplemented push)
check('channel-capable push sub-peer shows "· push" not "streaming"', sb.textContent.includes('· push') && !sb.textContent.includes('streaming'))
check('agent client-kind surfaced (not lumped as cowork)', sb.textContent.includes('agent') && !sb.textContent.includes('cowork'))

// web session folded into its machine group
check('web page listed under its machine', [...sb.querySelectorAll('.b-page')].some(e => e.textContent.includes('Chat')))

// MAP: remote gateway node marked gw; code node marked code; cross-host edge drawn
const vgw = doc.getElementById('n-VOLT-001/ccc')
check('remote gateway node drawn + marked gw', !!vgw && vgw.classList.contains('gw'))
const vcode = doc.getElementById('n-VOLT-001/ddd/volt-1')
check('remote code sub-peer node marked code', !!vcode && vcode.classList.contains('code'))
check('cross-host gateway edge drawn', !!map.querySelector('.edge.xhost'))
check('two host boxes drawn', map.querySelectorAll('.n-host-label').length === 2)
// remote followers connect to THEIR gateway, not ours
check('remote follower edge to remote gateway drawn', !!doc.getElementById('e-VOLT-001/ddd'))

// z-order fix: boxes < edges < nodes, so a second host's opaque box can't paint over its own edges
const groups = [...map.children].filter(c => c.tagName === 'g')
check('map uses 3 z-layers (box/edge/node)', groups.length === 3, 'groups=' + groups.length)
const edgeLayer = doc.getElementById('e-VOLT-001/ddd')?.parentNode
const nodeLayer = doc.getElementById('n-VOLT-001/ccc')?.parentNode
check('edges layered beneath nodes (the second-box-hides-edges fix)',
  groups.indexOf(edgeLayer) >= 0 && groups.indexOf(edgeLayer) < groups.indexOf(nodeLayer),
  'edge@' + groups.indexOf(edgeLayer) + ' node@' + groups.indexOf(nodeLayer))

console.log(`\n${pass} passed, ${fail} failed`)
dom.window.close()
process.exit(fail ? 1 : 0)
