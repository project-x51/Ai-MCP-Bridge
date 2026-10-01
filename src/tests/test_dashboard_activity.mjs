// #70 step 5 (v1.61.0): the dashboard's Activity view. Loads dashboard.html in jsdom with a stubbed WebSocket (like
// test_dashboard_collapse), then (1) unit-tests the PURE client logic it exposes as window.AimbAct — client-side stale
// (the slider, an item's own stale_after), the status glyph + its ring, the hover texts (actual times), placeholder
// rendering, progress/ETA tooltips, the project-level cycle, the delta store (seq gap → resync), the tree (nesting,
// active-only, counts) — and (2) drives the rendered tree: subscribe on open / unsubscribe on leave, rows, host tags,
// pills (blocked / failed / stale / gone vs a distinct host-down badge), the bell, ⌛, stale greying, the slider, the
// project cycle + depth control, active only, a log page + "load older", an entry's details/data, a queued fetch, deltas.
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import fs from 'fs'
let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
const MIN = 60000

const file = process.env.DASHBOARD_HTML || fileURLToPath(new URL('../dashboard.html', import.meta.url))
const html = fs.readFileSync(file, 'utf8')
class FakeWS { constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.last = this } send(s) { this.sent.push(JSON.parse(s)) } close() { this.readyState = 3; this.onclose && this.onclose() } }
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1:12318/dashboard.html?token=t&theme=dark', pretendToBeVisual: true,
  beforeParse(window) { window.WebSocket = FakeWS; try { window.localStorage.clear() } catch { } } })
const win = dom.window, doc = win.document, X = win.AimbAct, V = win.AimbActView
const ws = FakeWS.last
const recv = m => ws.onmessage({ data: J(m) })
const sentOf = t => ws.sent.filter(m => m.type === t)
const NOW = Date.now()

// ================================================================= (1) the pure logic
check('exposed: window.AimbAct + the view state', !!X && typeof X.effState === 'function' && !!V)
check('theme: ?theme=dark sets data-theme on <html> (the CSS tokens switch)', doc.documentElement.getAttribute('data-theme') === 'dark')
if (!X || !V) { console.log(`\n${pass} passed, ${fail} failed (no Activity view in this dashboard — nothing more to test)`); process.exit(1) }
// placeholders
const P = { done: 4812, total: 12000, unit: 'tiles' }
check('render: {progress} {pct} {done} {total} {unit}', X.renderText('{progress} · {pct} · {done}/{total} {unit}', P, null, NOW) === '4,812 of 12,000 tiles · 40% · 4,812/12,000 tiles')
check('render: {eta} from eta_at vs now; "?" without one', X.renderText('eta {eta}', null, NOW + 15 * MIN, NOW) === 'eta ~15m' && X.renderText('eta {eta}', null, null, NOW) === 'eta ?')
check('render: a % bar, {{ }} literals, an unknown / unfillable placeholder left as typed', X.renderText('{progress}', { done: 61, total: 100, unit: '%' }, null, NOW) === '61%'
  && X.renderText('{{x}} {foo} {progress}', null, null, NOW) === '{x} {foo} {progress}')
// stale, client-side
const run = (ago, extra = {}) => ({ state: 'running', started_at: NOW - 60 * MIN, last_activity: NOW - ago * MIN, ...extra })
check('stale: a running item quiet LONGER than the slider window is stale (was running)', X.effState(run(20), null, NOW, 15).state === 'stale' && X.effState(run(20), null, NOW, 15).was === 'running' && X.effState(run(20), null, NOW, 30).state === 'running')
check('stale: the item\'s own stale_after wins over the slider', X.effState(run(20, { stale_after_ms: 60 * MIN }), null, NOW, 15).state === 'running' && X.effState(run(70, { stale_after_ms: 60 * MIN }), null, NOW, 120).state === 'stale')
check('stale: blocked goes stale too; idle / done / failed never do', X.effState({ ...run(40), state: 'blocked' }, null, NOW, 15).state === 'stale'
  && ['idle', 'done', 'failed'].every(s => X.effState({ ...run(400), state: s }, null, NOW, 15).state === s))
check('stale: nothing under a FINISHED entity goes stale (a context with a finished parent)', X.effState(run(400), { finished_at: NOW - MIN }, NOW, 15).state === 'running')
check('gone comes from the data; host_down (own or parent\'s) marks a host that went away', X.effState({ state: 'gone', was: 'blocked' }, null, NOW, 15).gone && X.effState({ state: 'gone', was: 'blocked' }, null, NOW, 15).was === 'blocked'
  && !X.effState({ state: 'gone' }, null, NOW, 15).hostDown && X.effState({ state: 'gone', host_down: NOW }, null, NOW, 15).hostDown && X.effState({ state: 'gone' }, { host_down: NOW }, NOW, 15).hostDown)
// the ring
check('ring: full when fresh, half way at half the window, empty when stale / not live', Math.abs(X.ringFrac(X.effState(run(0), null, NOW, 10), NOW) - 1) < 1e-9 && Math.abs(X.ringFrac(X.effState(run(5), null, NOW, 10), NOW) - 0.5) < 1e-9
  && X.ringFrac(X.effState(run(11), null, NOW, 10), NOW) === 0 && X.ringFrac(X.effState({ ...run(1), state: 'done' }, null, NOW, 10), NOW) === 0)
const svg = (it, sm = 15) => X.glyphSvg(X.effState(it, null, NOW, sm), NOW)
check('glyph: running = a live ring (data-sa/data-win) + a dot; blocked coloured as blocked', /class="ring"/.test(svg(run(1))) && /data-sa="\d+" data-win="900000"/.test(svg(run(1))) && /s-blocked/.test(svg({ ...run(1), state: 'blocked' })))
check('glyph: done = a tick, failed = a cross (no ring), stale = no ring, gone = dashed', /s-done.*<path d="M4\.9/.test(svg({ ...run(1), state: 'done' })) && /s-failed.*<path d="M5\.6/.test(svg({ ...run(1), state: 'failed' }))
  && !/class="ring"/.test(svg({ ...run(1), state: 'done' })) && /s-stale/.test(svg(run(30))) && !/class="ring"/.test(svg(run(30))) && /s-gone.*stroke-dasharray="2\.2 2\.2"/.test(svg({ state: 'gone' })))
// hover texts: ACTUAL times
const tip = X.statusTip(run(3), null, NOW, 15, 'H')
check('tooltip: running → started (clock) + running for + last activity (clock, ago) + stale at', /^Running\nstarted \d\d:\d\d:\d\d · running for 1h\nlast activity \d\d:\d\d:\d\d \(3m ago\)\nstale at \d\d:\d\d:\d\d \(in 12m\)$/.test(tip), tip)
const tipD = X.statusTip({ state: 'done', started_at: NOW - 59 * MIN, finished_at: NOW - MIN, last_activity: NOW - MIN }, null, NOW, 15)
check('tooltip: done → done at + took', /^Done at \d\d:\d\d:\d\d · took 58m/.test(tipD), tipD)
check('tooltip: stale says was …; gone vs host down differ', /^Stale — was running/.test(X.statusTip(run(30), null, NOW, 15)) && /^Gone — the session left the mesh/.test(X.statusTip({ state: 'gone', was: 'running', gone_at: NOW }, null, NOW, 15))
  && /^Host H is down or unreachable/.test(X.statusTip({ state: 'gone', was: 'running', gone_at: NOW, host_down: NOW }, null, NOW, 15, 'H')))
check('tooltip: ETA = "ETA ~15m (estimated), about HH:MM"', /^ETA ~15m \(estimated\), about \d\d:\d\d$/.test(X.etaTip(NOW + 15 * MIN, NOW)), X.etaTip(NOW + 15 * MIN, NOW))
check('tooltip: progress — exact counts, reported vs rollup of its contexts', X.barTip(P) === '4,812 of 12,000 tiles (40%) — reported' && X.barTip({ done: 3, total: 6, unit: 'tasks', rollup: true, n: 2 }) === '3 of 6 tasks (50%) — rollup of its 2 contexts')
check('project level: all → sessions → collapsed → all', X.nextLevel('all') === 'sessions' && X.nextLevel('sessions') === 'collapsed' && X.nextLevel('collapsed') === 'all')
// the delta store
const st = {}
check('store: a full board replaces; a delta on top of exactly (epoch, seq) applies', X.applyMsg(st, { type: 'activity_board', full: true, epoch: 'e', seq: 1, upsert: [{ id: 'a', kind: 'session', key: 'k' }] }) === 'full'
  && X.applyMsg(st, { type: 'activity_delta', epoch: 'e', seq: 2, base: 1, upsert: [{ id: 'b', kind: 'agent', group: 'k', agent: 'x' }], remove: [] }) === 'delta' && st.seq === 2 && !!st.units.b)
check('store: a gap (base ≠ seq) or another epoch → resync, nothing applied', X.applyMsg(st, { type: 'activity_delta', epoch: 'e', seq: 5, base: 4, upsert: [{ id: 'c' }] }) === 'resync' && !st.units.c
  && X.applyMsg(st, { type: 'activity_delta', epoch: 'z', seq: 3, base: 2 }) === 'resync' && X.applyMsg(st, { type: 'activity_delta', epoch: 'e', seq: 3, base: 2, remove: ['b'] }) === 'delta' && !st.units.b)

// ---- a board fixture (raw units, as the bridge sends them)
const ctx = (name, extra = {}) => ({ name, state: 'running', created_at: NOW - 60 * MIN, last_activity: NOW - MIN, ...extra })
const ent = (agent, host, extra = {}) => ({ agent, host, state: 'running', active: true, started_at: NOW - 60 * MIN, last_activity: NOW - MIN, contexts: [ctx('root')], log: { entries: 3, dropped: 0 }, ...extra })
const sess = (key, session, project, extra = {}) => ({ id: `s|${key}`, kind: 'session', key, session, project, user: 'robin', realm: 'default', created_at: NOW - 2 * 60 * MIN, last_activity: NOW - MIN, ...extra })
const agent = (key, a, host, extra = {}) => ({ id: `a|${key}|${host}|${a}`, kind: 'agent', group: key, ...ent(a, host, extra) })
const orchSelf = ent(null, 'HOST-A', { current: { id: 'l1', ts: NOW - MIN, text: 'coordinating {progress}', state: 'running' }, progress: { done: 3, total: 6, unit: 'tasks', pct: 50, rollup: true, n: 2 }, eta_at: NOW + 15 * MIN,
  contexts: [ctx('root', { current: { id: 'l1', ts: NOW - MIN, text: 'coordinating {progress}', state: 'running' } }), ctx('plan', { current: { id: 'l2', ts: NOW - MIN, text: 'step {progress}', state: 'running' }, progress: { done: 1, total: 4, unit: '' } })], log: { entries: 7, dropped: 0 } })
const units = [
  sess('k-orch', 'Orch', 'AIMB', { hosts: ['HOST-A', 'HOST-B'], multi_host: true, bell: true, self: orchSelf, selves: [orchSelf, ent(null, 'HOST-B', { log: { remote: true } })] }),
  agent('k-orch', 'research', 'HOST-A', { current: { id: 'r1', ts: NOW - MIN, text: 'reading {progress}', state: 'running' }, progress: { done: 4812, total: 12000, unit: 'tiles', pct: 40.1, rollup: false, n: 1 }, eta_at: NOW + 30 * MIN }),
  agent('k-orch', 'research/sub', 'HOST-A', { state: 'blocked', current: { id: 'r2', ts: NOW - MIN, text: 'waiting for a key', state: 'blocked' } }),
  agent('k-orch', 'build', 'HOST-B', { state: 'done', active: false, finished_at: NOW - 5 * MIN, current: { id: 'b1', ts: NOW - 5 * MIN, text: 'built', state: 'done' } }),
  agent('k-orch', 'deploy', 'HOST-B', { state: 'failed', active: false, finished_at: NOW - 4 * MIN, current: { id: 'd1', ts: NOW - 4 * MIN, text: 'deploy failed', state: 'failed' } }),
  agent('k-orch', 'old', 'HOST-A', { last_activity: NOW - 30 * MIN, current: { id: 'o1', ts: NOW - 30 * MIN, text: 'quiet one', state: 'running' } }),
  agent('k-orch', 'longrun', 'HOST-A', { last_activity: NOW - 30 * MIN, stale_after_ms: 60 * MIN, current: { id: 'lr', ts: NOW - 30 * MIN, text: 'long build', state: 'running' } }),
  sess('k-leaver', 'Leaver', 'AIMB', { host: 'HOST-A', self: ent(null, 'HOST-A', { state: 'gone', was: 'running', gone_at: NOW - MIN }) }),
  agent('k-leaver', 'w', 'HOST-A', { state: 'gone', was: 'running', active: false, gone_at: NOW - MIN, current: { id: 'w1', ts: NOW - 2 * MIN, text: 'was working', state: 'running' } }),
  sess('k-cee', 'Cee', 'Tools', { host: 'HOST-C', hosts_down: ['HOST-C'], self: ent(null, 'HOST-C', { state: 'gone', was: 'running', host_down: NOW - MIN, gone_at: NOW - MIN, log: { remote: true } }) }),
  agent('k-cee', 'c1', 'HOST-C', { state: 'gone', was: 'running', active: false, host_down: NOW - MIN, gone_at: NOW - MIN, current: { id: 'c1', ts: NOW - 2 * MIN, text: 'on C', state: 'running' }, log: { remote: true } }),
]
const tree = X.buildTree(Object.fromEntries(units.map(u => [u.id, u])), {})
const orch = tree.find(p => p.key === 'aimb').sessions.find(x => x.s.session === 'Orch')
check('tree: projects A→Z with counts (sessions; active agents)', J(tree.map(p => [p.name, p.nSessions, p.nActive])) === J([['AIMB', 2, 4], ['Tools', 1, 0]]), J(tree.map(p => [p.name, p.nSessions, p.nActive])))
check('tree: agents in path order, a/b nested under a (depth + dimmed prefix)', J(orch.agents.map(x => [x.a.agent, x.depth, x.pre])) === J([['build', 0, ''], ['deploy', 0, ''], ['longrun', 0, ''], ['old', 0, ''], ['research', 0, ''], ['research/sub', 1, 'research/']]), J(orch.agents.map(x => [x.a.agent, x.depth])))
const act = X.buildTree(Object.fromEntries(units.map(u => [u.id, u])), { activeOnly: true })
check('tree: active only hides finished + gone agents, and sessions with nothing active (Leaver, Cee); counts stay', J(act.map(p => p.name)) === J(['AIMB']) && J(act[0].sessions.map(x => x.s.session)) === J(['Orch'])
  && J(act[0].sessions[0].agents.map(x => x.a.agent)) === J(['longrun', 'old', 'research', 'research/sub']))

// ================================================================= (2) the rendered view
ws.readyState = 1; ws.onopen && ws.onopen()
recv({ type: 'welcome', gateway: 'HOST-A/aaa', sessions: [], pages: [], hosts: {}, bridge_version: '1.61.0', profile: {}, capabilities: {} })
const sec = doc.querySelector('section.sec[data-sec="activity"]')
check('view: the Activity section exists, collapsed by default, and a closed one does NOT subscribe', !!sec && sec.classList.contains('collapsed') && sentOf('activity_sub').length === 0)
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('view: opening it subscribes (activity_sub)', !sec.classList.contains('collapsed') && sentOf('activity_sub').length === 1 && !sentOf('activity_sub')[0].resync)
recv({ type: 'activity_board', full: true, epoch: 'E1', seq: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15, remote_hosts: [] }, upsert: units })
const T = doc.getElementById('acttree')
const rowsT = () => [...T.querySelectorAll('.ar')]
const rowOf = re => rowsT().find(r => re.test(r.textContent))
const nmRow = name => rowsT().find(r => r.querySelector('.nm')?.textContent === name)
check('view: project rows with their counts', /AIMB2 sessions · 4 active agents/.test(rowOf(/^▾📁 AIMB/)?.textContent || '') && /Tools1 session · 0 active agents/.test(rowOf(/📁 Tools/)?.textContent || ''), rowsT().slice(0, 3).map(r => r.textContent).join(' | '))
const orchRow = nmRow('Orch')
check('view: the session row — name, one host tag per host, its @root line RENDERED, a rollup bar, ⌛, 🔔', !!orchRow && J([...orchRow.querySelectorAll('.htag')].map(h => h.textContent)) === J(['HOST-A', 'HOST-B'])
  && orchRow.querySelector('.ln').textContent === 'coordinating 3 of 6 tasks' && !!orchRow.querySelector('.pb.roll') && /⌛/.test(orchRow.textContent) && /🔔/.test(orchRow.textContent), orchRow && orchRow.innerHTML)
const resRow = nmRow('research'), subRow = rowsT().find(r => r.querySelector('.nm')?.textContent === 'research/sub')
check('view: agent rows — monospace path, glyph, rendered line, bar, ETA; the sub-agent nested one level deeper with its prefix dimmed', resRow?.querySelector('.nm.path') && resRow.querySelector('.ln').textContent === 'reading 4,812 of 12,000 tiles'
  && Number(subRow?.style.getPropertyValue('--d')) === Number(resRow.style.getPropertyValue('--d')) + 1 && subRow.querySelector('.nm .pre')?.textContent === 'research/' && !!resRow.querySelector('svg.gl circle.ring'), subRow && subRow.outerHTML)
check('view: multi-host session → agents tagged by host', resRow?.querySelector('.htag')?.textContent === 'HOST-A' && nmRow('build')?.querySelector('.htag')?.textContent === 'HOST-B')
const pills = r => [...(r?.querySelectorAll('.pill') || [])].map(p => p.className.replace('pill ', ''))
check('view: pills only for blocked / failed / stale / gone (running and done have none)', J(pills(subRow)) === J(['blocked']) && J(pills(nmRow('deploy'))) === J(['failed']) && J(pills(nmRow('old'))) === J(['stale'])
  && J(pills(nmRow('w'))) === J(['gone']) && J(pills(resRow)) === '[]' && J(pills(nmRow('build'))) === '[]', J([pills(subRow), pills(nmRow('deploy')), pills(nmRow('old')), pills(nmRow('w'))]))
check('view: host down is a DISTINCT badge (not "gone") on the host\'s session + agents; its host tag is marked', J(pills(nmRow('c1'))) === J(['hostdown']) && J(pills(nmRow('Cee'))) === J(['hostdown']) && !!nmRow('Cee').querySelector('.htag.down'), J([pills(nmRow('c1')), pills(nmRow('Cee'))]))
check('view: a stale row greys out (class stale); an item\'s own stale_after keeps it live', nmRow('old')?.classList.contains('stale') && !nmRow('longrun')?.classList.contains('stale') && !resRow.classList.contains('stale'))
check('view: no inline time text on status rows (times live in the hover tooltips)', rowsT().every(r => !/\bago\b|\d\d:\d\d|\b\d+m\b|\b\d+s\b/.test(r.querySelector('.ln')?.textContent + (r.querySelector('.nm')?.textContent || ''))), rowsT().map(r => r.textContent).filter(t => /ago|\d\d:\d\d/.test(t)).join(' | '))
// tooltips on hover
const g = resRow.querySelector('[data-tip]')
g.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
check('view: hovering the glyph shows the actual times', /^Running\nstarted \d\d:\d\d:\d\d/.test(g.getAttribute('title') || '') && /stale at/.test(g.getAttribute('title')), g.getAttribute('title'))
const bar = resRow.querySelector('.pb'); bar.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
const eta = [...resRow.querySelectorAll('.ic')].find(i => i.textContent === '⌛'); eta.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
const bell = [...orchRow.querySelectorAll('.ic')].find(i => i.textContent === '🔔'); bell.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
check('view: bar / ⌛ / 🔔 tooltips', bar.getAttribute('title') === '4,812 of 12,000 tiles (40%) — reported' && /^ETA ~30m \(estimated\), about \d\d:\d\d$/.test(eta.getAttribute('title')) && bell.getAttribute('title') === 'Doorbell armed', J([bar.getAttribute('title'), eta.getAttribute('title')]))
// the slider (client-side stale: instant, no round trip)
const nSent = ws.sent.length, sl = doc.getElementById('actStale')
sl.value = '45'; sl.dispatchEvent(new win.Event('input'))
check('slider: 45 min → the 30-min-quiet agent is live again at once, with no message to the bridge', !nmRow('old').classList.contains('stale') && J(pills(nmRow('old'))) === '[]' && ws.sent.length === nSent && /45m/.test(doc.getElementById('actStaleV').textContent))
sl.value = '15'; sl.dispatchEvent(new win.Event('input'))
// the project cycle + the depth control
const projRow = () => rowOf(/📁 AIMB/)
projRow().dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('project click 1: sessions only (agents hidden, sessions shown)', !nmRow('research') && !!nmRow('Orch') && !!nmRow('Leaver'))
projRow().dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('project click 2: collapsed (only the heading; the other project untouched)', !nmRow('Orch') && !!projRow() && !!nmRow('Cee'))
projRow().dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('project click 3: back to all', !!nmRow('research') && !!nmRow('Orch'))
const depth = l => doc.querySelector(`#actDepth button[data-l="${l}"]`).dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
depth('collapsed')
check('depth control: Projects → every project collapsed', !nmRow('Orch') && !nmRow('Cee') && rowsT().length === 2 && doc.querySelector('#actDepth button[data-l="collapsed"]').className === 'on')
depth('sessions')
check('depth control: Sessions → sessions everywhere, no agents', !!nmRow('Orch') && !!nmRow('Cee') && !nmRow('research') && !nmRow('c1'))
depth('all')
check('depth control: Agents → everything (the default view)', !!nmRow('research') && !!nmRow('c1') && doc.querySelector('#actDepth button[data-l="all"]').className === 'on')
// active only
const ao = doc.getElementById('actActive'); ao.checked = true; ao.dispatchEvent(new win.Event('change'))
check('active only: finished + gone agents and sessions with nothing active disappear', !nmRow('build') && !nmRow('deploy') && !nmRow('Leaver') && !nmRow('Cee') && !!nmRow('research') && !!nmRow('old'))
ao.checked = false; ao.dispatchEvent(new win.Event('change'))
// expanding: an agent → Log + its contexts; the Log loads a page; an entry → details + data
check('default: contexts and logs are closed', !rowsT().some(r => r.classList.contains('lg')))
nmRow('Orch').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const logRows = () => rowsT().filter(r => r.classList.contains('lg'))
check('expand a multi-host session: one Log row per host ("N entries, all contexts"), then its contexts', logRows().length === 2 && /7 entries, all contexts · HOST-A/.test(logRows()[0].textContent) && /all contexts · HOST-B/.test(logRows()[1].textContent)
  && !!rowsT().find(r => r.querySelector('.nm')?.textContent === '@plan' && /step 1 of 4/.test(r.textContent)), logRows().map(r => r.textContent).join(' | '))
logRows()[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const lq = sentOf('activity').pop()
check('the Log asks the bridge for a page of that entity (session, project, user, host; no agent = the session itself)', lq?.query?.log?.session === 'Orch' && lq.query.log.host === 'HOST-A' && lq.query.log.project === 'AIMB' && lq.query.log.user === 'robin' && !('agent' in lq.query.log) && lq.query.log.limit === 50, J(lq))
recv({ type: 'activity_queued', ref: lq.ref, wait_ms: 1500, position: 3 })
check('a queued fetch shows a spinner + its wait', /queued — about 2s/.test(T.textContent) && !!T.querySelector('.spin'))
recv({ type: 'activity', ref: lq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [
  { id: 'e3', ts: NOW - MIN, context: 'root', current: true, text: 'coordinating {progress}', rendered: 'coordinating 3 of 6 tasks', state: 'running' },
  { id: 'e2', ts: NOW - 2 * MIN, context: 'plan', text: 'with attachments', rendered: 'with attachments', state: 'blocked', has_details: true, has_data: true }], next_cursor: 'f1.2026-10-02.120', total: 7 } } })
const eRows = () => rowsT().filter(r => r.classList.contains('le'))
check('log entries newest first: time, state dot, @~ctx / @ctx tag, rendered text', eRows().length === 2 && /^\d\d:\d\d:\d\d$/.test(eRows()[0].querySelector('.tm').textContent) && eRows()[0].querySelector('.ctag').textContent === '@~root'
  && eRows()[1].querySelector('.ctag').textContent === '@plan' && eRows()[1].querySelector('.dot').classList.contains('bg-blocked') && eRows()[0].querySelector('.ln').textContent === 'coordinating 3 of 6 tasks', eRows().map(r => r.textContent).join(' | '))
const older = rowsT().find(r => /load older/.test(r.textContent))
older.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const lq2 = sentOf('activity').pop()
check('"load older" asks for the next page with the cursor', lq2.query.log.cursor === 'f1.2026-10-02.120' && lq2.query.log.host === 'HOST-A', J(lq2))
recv({ type: 'activity', ref: lq2.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'e1', ts: NOW - 3 * MIN, context: 'root', text: 'started', rendered: 'started', state: 'running' }], next_cursor: null } } })
check('... the page appends, and the end of the log has no "load older"', eRows().length === 3 && !rowsT().some(r => /load older/.test(r.textContent)))
eRows()[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const eq = sentOf('activity').pop()
check('an entry with details/data expands → fetches it by id + host', eq.query.entry?.id === 'e2' && eq.query.entry.host === 'HOST-A', J(eq))
recv({ type: 'activity', ref: eq.ref, result: { ok: true, entry: { id: 'e2', details: 'DETAIL TEXT', data: { rows: 42, ok: true } } } })
const det = T.querySelector('.ad')
check('... showing the details text and the pretty-printed JSON', !!det && /DETAIL TEXT/.test(det.textContent) && det.querySelectorAll('pre')[1]?.textContent === J({ rows: 42, ok: true }, null, 2), det && det.innerHTML)
const agQ = () => { nmRow('research').dispatchEvent(new win.MouseEvent('click', { bubbles: true })); const r = rowsT().find(x => x.classList.contains('lg') && /3 entries/.test(x.textContent)); r.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); return sentOf('activity').pop() }
const aq = agQ()
check('an agent\'s Log asks with its agent path', aq.query.log.agent === 'research' && aq.query.log.host === 'HOST-A', J(aq))
recv({ type: 'activity', ref: aq.ref, result: { ok: false, code: 'busy', retry_after_ms: 800, what: 'too many history fetches are waiting' } })
check('a busy answer offers a retry', /busy: too many history fetches are waiting — click to retry/.test(T.textContent))
// deltas, a gap → resync, collapse → unsubscribe
recv({ type: 'activity_delta', epoch: 'E1', seq: 2, base: 1, head: { host: 'HOST-A', now: Date.now(), stale_after_min: 15 }, upsert: [{ ...units[1], current: { id: 'r9', ts: NOW, text: 'writing up', state: 'running' } }], remove: [units[4].id] })
check('a delta updates a row in place and removes another', nmRow('research').querySelector('.ln').textContent === 'writing up' && !nmRow('deploy'))
recv({ type: 'activity_delta', epoch: 'E1', seq: 9, base: 8, upsert: [], remove: [] })
check('a delta that doesn\'t follow (lost frames) → the page asks for a resync', sentOf('activity_sub').length === 2 && sentOf('activity_sub')[1].resync === true)
recv({ type: 'activity_board', full: true, epoch: 'E1', seq: 1, head: { host: 'HOST-A', now: Date.now(), stale_after_min: 15 }, upsert: units })
check('... and the full board restores the view', !!nmRow('deploy') && /coordinating/.test(nmRow('Orch').textContent))
doc.getElementById('actCollapse').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Collapse all closes every expanded row', !rowsT().some(r => r.classList.contains('lg') || r.classList.contains('le')))
const nReq = sentOf('activity').length
doc.getElementById('actExpand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Expand all opens every session and agent (Log rows appear; no log is fetched by it)', logRows().length >= 8 && sentOf('activity').length === nReq, `${logRows().length} ${sentOf('activity').length - nReq}`)
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('leaving (collapsing the section) unsubscribes', sentOf('activity_unsub').length === 1)
const legend = doc.getElementById('actlegend')
check('legend: the state glyphs + the ring / hover hint', legend.querySelectorAll('svg').length === 7 && /ring is the time left before an item goes stale/.test(legend.textContent) && /hover the icons/.test(legend.textContent))

console.log(`\n${pass} passed, ${fail} failed`)
dom.window.close()
process.exit(fail ? 1 : 0)
