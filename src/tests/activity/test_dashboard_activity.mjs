// #70 step 5 (v1.61.0) + step 6a (v1.62.0): the dashboard's Activity view. Loads dashboard.html in jsdom with a stubbed
// WebSocket (like test_dashboard_collapse), then (1) unit-tests the PURE client logic it exposes as window.AimbAct —
// client-side stale (the slider, an item's own stale_after; 6a: a CONTEXT shows its nearest agent's staleness / gone, an
// implicit agent never goes stale), the status glyph + its ring (contexts: no ring), the hover texts (actual times),
// placeholder rendering, progress/ETA tooltips, the project-level cycle, the delta store (seq gap → resync), the NODE TREE
// (nesting by parent_key to any depth, creation order, orphans, active-only, counts) and the log-entry tags — and (2)
// drives the rendered tree: subscribe on open / unsubscribe on leave, session rows + their top-level nodes by default,
// per-node expand (its subtree Log + its children) down to depth 6 with readable indentation, agents with the ring and
// contexts with a state mark, host tags, pills (blocked / failed / stale incl. inherited / gone vs host down), the bell, ⌛,
// the slider, the project cycle + depth control (Projects / Sessions / Nodes), active only, a subtree log page + "load
// older", an entry's details/data, a queued fetch, deltas, Expand / Collapse all.
import { testOnly } from '../helpers/check.mjs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import fs from 'fs'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
const MIN = 60000

const file = process.env.DASHBOARD_HTML || fileURLToPath(new URL('../../dashboard.html', import.meta.url))
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
const P = { done: 4812, total: 12000, unit: 'tiles' }
check('render: {progress} {pct} {done} {total} {unit}', X.renderText('{progress} · {pct} · {done}/{total} {unit}', P, null, NOW) === '4,812 of 12,000 tiles · 40% · 4,812/12,000 tiles')
check('render: {eta} from eta_at vs now; "?" without one', X.renderText('eta {eta}', null, NOW + 15 * MIN, NOW) === 'eta ~15m' && X.renderText('eta {eta}', null, null, NOW) === 'eta ?')
check('render: a % bar, {{ }} literals, an unknown / unfillable placeholder left as typed', X.renderText('{progress}', { done: 61, total: 100, unit: '%' }, null, NOW) === '61%'
  && X.renderText('{{x}} {foo} {progress}', null, null, NOW) === '{x} {foo} {progress}')
// stale, client-side (agents)
const run = (ago, extra = {}) => ({ nkind: 'agent', state: 'running', started_at: NOW - 60 * MIN, created_at: NOW - 60 * MIN, last_activity: NOW - ago * MIN, ...extra })
check('stale: a running agent quiet LONGER than the slider window is stale (was running)', X.effState(run(20), null, NOW, 15).state === 'stale' && X.effState(run(20), null, NOW, 15).was === 'running' && X.effState(run(20), null, NOW, 30).state === 'running')
check('stale: the item\'s own stale_after wins over the slider', X.effState(run(20, { stale_after_ms: 60 * MIN }), null, NOW, 15).state === 'running' && X.effState(run(70, { stale_after_ms: 60 * MIN }), null, NOW, 120).state === 'stale')
check('stale: blocked goes stale too; idle / done / failed never do', X.effState({ ...run(40), state: 'blocked' }, null, NOW, 15).state === 'stale'
  && ['idle', 'done', 'failed'].every(s => X.effState({ ...run(400), state: s }, null, NOW, 15).state === s))
check('stale (6a): an IMPLICIT agent (never reported, named by a path below it) never goes stale', X.effState(run(400, { implicit: true }), null, NOW, 15).state === 'running' && X.effState(run(400, { implicit: true }), null, NOW, 15).staleAt === null)
check('stale (6a): a sub-agent under a finished agent still goes stale by itself', X.effState(run(400), { finished_at: NOW - MIN }, NOW, 15).state === 'stale')
check('gone comes from the data; host_down (own or owner\'s) marks a host that went away', X.effState({ nkind: 'agent', state: 'gone', was: 'blocked' }, null, NOW, 15).gone && X.effState({ nkind: 'agent', state: 'gone', was: 'blocked' }, null, NOW, 15).was === 'blocked'
  && !X.effState({ state: 'gone' }, null, NOW, 15).hostDown && X.effState({ state: 'gone', host_down: NOW }, null, NOW, 15).hostDown && X.effState({ state: 'gone' }, { host_down: NOW }, NOW, 15).hostDown)
// 6a: CONTEXTS inherit staleness / gone from their nearest agent
const cx = (st, extra = {}) => ({ nkind: 'context', state: st, created_at: NOW - 60 * MIN, last_activity: NOW - 50 * MIN, current: { id: 'c', ts: NOW - 50 * MIN, text: 'x', state: st }, ...extra })
const freshAg = run(1), staleAg = run(30), doneAg = { ...run(300), state: 'done', finished_at: NOW - MIN, current: { state: 'done' } }
check('context (6a): a context quiet for 50 min under a FRESH agent is fresh (it never goes stale by itself)', X.effState(cx('running'), { ...freshAg, current: { state: 'running' } }, NOW, 15).state === 'running')
check('context (6a): ... and stale exactly when its agent is (was = its own state; no ring of its own)', (e => e.state === 'stale' && e.was === 'blocked' && !e.live)(X.effState(cx('blocked'), { ...staleAg, current: { state: 'running' } }, NOW, 15)))
check('context (6a): a done context under a stale agent stays done; nothing under a finished agent goes stale', X.effState(cx('done'), staleAg, NOW, 15).state === 'done' && X.effState(cx('running'), doneAg, NOW, 15).state === 'running')
check('context (6a): no current line → "none" (a grouping node: no state, no pills)', (e => e.state === 'none' && e.noLine)(X.effState({ nkind: 'context', created_at: NOW }, staleAg, NOW, 15)))
check('context (6a): gone when its agent is gone (unless done); its agent\'s host_down shows', X.effState(cx('running'), { state: 'gone', host_down: NOW }, NOW, 15).gone && X.effState(cx('running'), { state: 'gone', host_down: NOW }, NOW, 15).hostDown
  && X.effState(cx('done'), { state: 'gone' }, NOW, 15).state === 'done')
check('context (6a): directly under the session it follows the session\'s own line', X.effState(cx('running'), { state: 'running', current: { state: 'running' }, last_activity: NOW - 20 * MIN }, NOW, 15).state === 'stale')
// the ring
check('ring: full when fresh, half way at half the window, empty when stale / not live', Math.abs(X.ringFrac(X.effState(run(0), null, NOW, 10), NOW) - 1) < 1e-9 && Math.abs(X.ringFrac(X.effState(run(5), null, NOW, 10), NOW) - 0.5) < 1e-9
  && X.ringFrac(X.effState(run(11), null, NOW, 10), NOW) === 0 && X.ringFrac(X.effState({ ...run(1), state: 'done' }, null, NOW, 10), NOW) === 0)
const svg = (it, sm = 15) => X.glyphSvg(X.effState(it, null, NOW, sm), NOW)
check('glyph: running = a live ring (data-sa/data-win) + a dot; blocked coloured as blocked', /class="ring"/.test(svg(run(1))) && /data-sa="\d+" data-win="900000"/.test(svg(run(1))) && /s-blocked/.test(svg({ ...run(1), state: 'blocked' })))
check('glyph: done = a tick, failed = a cross (no ring), stale = no ring, gone = dashed', /s-done.*<path d="M4\.9/.test(svg({ ...run(1), state: 'done' })) && /s-failed.*<path d="M5\.6/.test(svg({ ...run(1), state: 'failed' }))
  && !/class="ring"/.test(svg({ ...run(1), state: 'done' })) && /s-stale/.test(svg(run(30))) && !/class="ring"/.test(svg(run(30))) && /s-gone.*stroke-dasharray="2\.2 2\.2"/.test(svg({ state: 'gone' })))
check('glyph (6a): a context = a state mark with NO ring (class ctx), stale greyed via its agent', (g => /class="gl ctx s-running"/.test(g) && !/class="ring"/.test(g) && !/var\(--track\)/.test(g))(X.glyphSvg(X.effState(cx('running'), { ...freshAg, current: { state: 'running' } }, NOW, 15), NOW, 'ctx'))
  && /gl ctx s-stale/.test(X.glyphSvg(X.effState(cx('running'), { ...staleAg, current: { state: 'running' } }, NOW, 15), NOW, 'ctx')))
const tip = X.statusTip(run(3), null, NOW, 15, 'H')
check('tooltip: running → started (clock) + running for + last activity (clock, ago) + stale at', /^Running\nstarted \d\d:\d\d:\d\d · running for 1h\nlast activity \d\d:\d\d:\d\d \(3m ago\)\nstale at \d\d:\d\d:\d\d \(in 12m\)$/.test(tip), tip)
const tipD = X.statusTip({ nkind: 'agent', state: 'done', started_at: NOW - 59 * MIN, finished_at: NOW - MIN, last_activity: NOW - MIN }, null, NOW, 15)
check('tooltip: done → done at + took', /^Done at \d\d:\d\d:\d\d · took 58m/.test(tipD), tipD)
check('tooltip: stale says was …; gone vs host down differ', /^Stale — was running/.test(X.statusTip(run(30), null, NOW, 15)) && /^Gone — the session left the mesh/.test(X.statusTip({ state: 'gone', was: 'running', gone_at: NOW }, null, NOW, 15))
  && /^Host H is down or unreachable/.test(X.statusTip({ state: 'gone', was: 'running', gone_at: NOW, host_down: NOW }, null, NOW, 15, 'H')))
check('tooltip (6a): a context names the agent its staleness follows; an implicit agent says it has not reported', /staleness follows agent research/.test(X.statusTip(cx('running'), { ...freshAg, path: 'research', current: { state: 'running' } }, NOW, 15))
  && /staleness follows the session/.test(X.statusTip(cx('running'), { state: 'running', current: { state: 'running' }, last_activity: NOW }, NOW, 15)) && /not reported yet/.test(X.statusTip(run(1, { implicit: true }), null, NOW, 15)))
check('tooltip: ETA = "ETA ~15m (estimated), about HH:MM"', /^ETA ~15m \(estimated\), about \d\d:\d\d$/.test(X.etaTip(NOW + 15 * MIN, NOW)), X.etaTip(NOW + 15 * MIN, NOW))
check('tooltip: progress — exact counts, reported vs rollup of what is below it', X.barTip(P) === '4,812 of 12,000 tiles (40%) — reported' && X.barTip({ done: 3, total: 6, unit: 'tasks', rollup: true, n: 2 }) === '3 of 6 tasks (50%) — rollup of 2 below it')
check('project level: all → sessions → collapsed → all', X.nextLevel('all') === 'sessions' && X.nextLevel('sessions') === 'collapsed' && X.nextLevel('collapsed') === 'all')
check('entry tags (6a): the node itself @root / @~root; a descendant by its relative path, @~ on a current line\'s last context; an agent\'s own line /@~root', X.entryTag({ rel: '' }) === '@root' && X.entryTag({ rel: '', current: true }) === '@~root'
  && X.entryTag({ rel: '@Tharsis/@z12', current: true }) === '@Tharsis/@~z12' && X.entryTag({ rel: '@Tharsis/@z12' }) === '@Tharsis/@z12' && X.entryTag({ rel: 'sub', current: true }) === 'sub/@~root')
const st = {}
check('store: a full board replaces; a delta on top of exactly (epoch, seq) applies', X.applyMsg(st, { type: 'activity_board', full: true, epoch: 'e', seq: 1, upsert: [{ id: 'a', kind: 'session', key: 'k' }] }) === 'full'
  && X.applyMsg(st, { type: 'activity_delta', epoch: 'e', seq: 2, base: 1, upsert: [{ id: 'b', kind: 'node', group: 'k', path: 'x' }], remove: [] }) === 'delta' && st.seq === 2 && !!st.units.b)
check('store: a gap (base ≠ seq) or another epoch → resync, nothing applied', X.applyMsg(st, { type: 'activity_delta', epoch: 'e', seq: 5, base: 4, upsert: [{ id: 'c' }] }) === 'resync' && !st.units.c
  && X.applyMsg(st, { type: 'activity_delta', epoch: 'z', seq: 3, base: 2 }) === 'resync' && X.applyMsg(st, { type: 'activity_delta', epoch: 'e', seq: 3, base: 2, remove: ['b'] }) === 'delta' && !st.units.b)

// ---- a board fixture (raw units, as the bridge sends them: one per session group + one per NODE)
const root = (host, extra = {}) => ({ path: '', kind: 'agent', depth: 0, host, state: 'running', active: true, created_at: NOW - 60 * MIN, last_activity: NOW - MIN, log: { entries: 3, dropped: 0 }, ...extra })
const sess = (key, session, project, extra = {}) => ({ id: `s|${key}`, kind: 'session', key, session, project, user: 'robin', realm: 'default', created_at: NOW - 2 * 60 * MIN, last_activity: NOW - MIN, ...extra })
let seq = 0
const node = (key, path, nkind, host, extra = {}) => {
  const segs = path.split('/'), name = segs.at(-1).replace(/^@/, '').replace(/^"|"$/g, ''), pk = segs.slice(0, -1).join('/').toLowerCase()
  return { id: `n|${key}|${host}|${path.toLowerCase()}`, kind: 'node', nkind, group: key, host, path, key: path.toLowerCase(), parent_key: pk, name, depth: segs.length,
    state: 'running', active: nkind === 'agent' ? true : undefined, created_at: NOW - 60 * MIN + (++seq) * 1000, last_activity: NOW - MIN, log: { entries: 2, dropped: 0 }, ...extra }
}
const orchSelf = root('HOST-A', { current: { id: 'l1', ts: NOW - MIN, text: 'coordinating {progress}', state: 'running' }, bar: { done: 3, total: 6, unit: 'tasks', pct: 50, rollup: true, n: 2 }, eta_at: NOW + 15 * MIN, log: { entries: 7, dropped: 0 } })
const deepPath = '@#70/@step4/spec-70/@Tharsis/@z12/@deep'
const units = [
  sess('k-orch', 'Orch', 'AIMB', { hosts: ['HOST-A', 'HOST-B'], multi_host: true, bell: true, self: orchSelf, selves: [orchSelf, root('HOST-B', { log: { remote: true } })] }),
  node('k-orch', 'research', 'agent', 'HOST-A', { current: { id: 'r1', ts: NOW - MIN, text: 'reading {progress}', state: 'running' }, progress: { done: 4812, total: 12000, unit: 'tiles' }, eta_at: NOW + 30 * MIN }),
  node('k-orch', 'research/sub', 'agent', 'HOST-A', { state: 'blocked', current: { id: 'r2', ts: NOW - MIN, text: 'waiting for a key', state: 'blocked' } }),
  node('k-orch', 'research/@Tharsis', 'context', 'HOST-A', { current: { id: 'r3', ts: NOW - 40 * MIN, text: 'tiling {progress}', state: 'running' }, progress: { done: 2, total: 8, unit: 'tiles' }, last_activity: NOW - 40 * MIN }),
  node('k-orch', 'research/@Tharsis/@z12', 'context', 'HOST-A', { current: { id: 'r4', ts: NOW - MIN, text: 'strip z12', state: 'running' } }),
  node('k-orch', 'research/@Tharsis/@nol', 'context', 'HOST-A', {}),
  node('k-orch', 'build', 'agent', 'HOST-B', { state: 'done', active: false, finished_at: NOW - 5 * MIN, current: { id: 'b1', ts: NOW - 5 * MIN, text: 'built', state: 'done' } }),
  node('k-orch', 'deploy', 'agent', 'HOST-B', { state: 'failed', active: false, finished_at: NOW - 4 * MIN, current: { id: 'd1', ts: NOW - 4 * MIN, text: 'deploy failed', state: 'failed' } }),
  node('k-orch', 'old', 'agent', 'HOST-A', { last_activity: NOW - 30 * MIN, current: { id: 'o1', ts: NOW - 30 * MIN, text: 'quiet one', state: 'running' } }),
  node('k-orch', 'old/@ctx', 'context', 'HOST-A', { current: { id: 'o2', ts: NOW - 31 * MIN, text: 'inherits the agent\'s stale', state: 'blocked' } }),
  node('k-orch', 'longrun', 'agent', 'HOST-A', { last_activity: NOW - 30 * MIN, stale_after_ms: 60 * MIN, current: { id: 'lr', ts: NOW - 30 * MIN, text: 'long build', state: 'running' } }),
  node('k-orch', '@#70', 'context', 'HOST-A', { implicit: true, bar: { done: 1, total: 4, unit: 'tiles', pct: 25, rollup: true, n: 1 } }),
  node('k-orch', '@#70/@step4', 'context', 'HOST-A', { implicit: true }),
  node('k-orch', '@#70/@step4/spec-70', 'agent', 'HOST-A', { current: { id: 's70', ts: NOW - MIN, text: 'spec agent under a task', state: 'running' } }),
  node('k-orch', '@#70/@step4/spec-70/@Tharsis', 'context', 'HOST-A', { implicit: true }),
  node('k-orch', '@#70/@step4/spec-70/@Tharsis/@z12', 'context', 'HOST-A', { implicit: true }),
  node('k-orch', deepPath, 'context', 'HOST-A', { current: { id: 'dp', ts: NOW - MIN, text: 'six levels down {progress}', state: 'running' }, progress: { done: 1, total: 4, unit: 'tiles' } }),
  sess('k-leaver', 'Leaver', 'AIMB', { host: 'HOST-A', self: root('HOST-A', { state: 'gone', was: 'running', gone_at: NOW - MIN }) }),
  node('k-leaver', 'w', 'agent', 'HOST-A', { state: 'gone', was: 'running', active: false, gone_at: NOW - MIN, current: { id: 'w1', ts: NOW - 2 * MIN, text: 'was working', state: 'running' } }),
  sess('k-cee', 'Cee', 'Tools', { host: 'HOST-C', hosts_down: ['HOST-C'], self: root('HOST-C', { state: 'gone', was: 'running', host_down: NOW - MIN, gone_at: NOW - MIN, log: { remote: true } }) }),
  node('k-cee', 'c1', 'agent', 'HOST-C', { state: 'gone', was: 'running', active: false, host_down: NOW - MIN, gone_at: NOW - MIN, current: { id: 'c1', ts: NOW - 2 * MIN, text: 'on C', state: 'running' }, log: { remote: true } }),
]
const U = Object.fromEntries(units.map(u => [u.id, u]))
const tree = X.buildTree(U, {})
const orch = tree.find(p => p.key === 'aimb').sessions.find(x => x.s.session === 'Orch')
const kidsOf = t => t.kids.map(k => k.u.path)
const find = (list, path) => { for (const t of list) { if (t.u.path === path) return t; const f = find(t.kids, path); if (f) return f } return null }
check('tree: projects A→Z with counts (sessions; active, REPORTED agents — implicit ones not counted)', J(tree.map(p => [p.name, p.nSessions, p.nActive])) === J([['AIMB', 2, 5], ['Tools', 1, 0]]), J(tree.map(p => [p.name, p.nSessions, p.nActive])))
check('tree (6a; #82): the session\'s top level = nodes whose parent is the session — contexts first, then agents, each in creation order (their derived rank)', J(kidsOf(orch)) === J(['@#70', 'research', 'build', 'deploy', 'old', 'longrun']), J(kidsOf(orch)))
check('tree (6a): children nest by parent_key to any depth (agents and contexts alike)', J(kidsOf(find(orch.kids, 'research'))) === J(['research/@Tharsis', 'research/sub']) && J(kidsOf(find(orch.kids, 'research/@Tharsis'))) === J(['research/@Tharsis/@z12', 'research/@Tharsis/@nol'])
  && !!find(orch.kids, deepPath) && find(orch.kids, deepPath).u.depth === 6)
check('tree (6a): each node knows its OWNER — the nearest agent above it, else the session\'s self (for its host)', find(orch.kids, 'research/@Tharsis/@z12').owner.path === 'research' && find(orch.kids, 'research/sub').owner.path === 'research'
  && find(orch.kids, '@#70/@step4').owner === orchSelf && find(orch.kids, deepPath).owner.path === '@#70/@step4/spec-70')
const orphanTree = X.buildTree({ s: { id: 's', kind: 'session', key: 'k', session: 'S', project: 'P', self: root('H') }, o: node('k', 'p/@lost', 'context', 'H', { current: { id: 'x', ts: NOW, text: 'orphan', state: 'running' } }) }, {})
check('tree (6a): a node whose parent has not arrived (a truncated slice) sits at the top level until it does', J(kidsOf(orphanTree[0].sessions[0])) === J(['p/@lost']))
const act = X.buildTree(U, { activeOnly: true })
check('tree: active only hides finished + gone agents (with their subtrees) and sessions with nothing active (Leaver, Cee)', J(act.map(p => p.name)) === J(['AIMB']) && J(act[0].sessions.map(x => x.s.session)) === J(['Orch'])
  && J(kidsOf(act[0].sessions[0])) === J(['@#70', 'research', 'old', 'longrun']))
check('subtreeCount: a subtree\'s local entries; null when any of it lives on another host', X.subtreeCount(find(orch.kids, 'research')) === 10 && X.subtreeCount({ u: { log: { remote: true } }, kids: [] }) === null)

// ================================================================= (2) the rendered view
ws.readyState = 1; ws.onopen && ws.onopen()
recv({ type: 'welcome', gateway: 'HOST-A/aaa', sessions: [], pages: [], hosts: {}, bridge_version: '1.62.0', profile: {}, capabilities: {} })
const sec = doc.querySelector('section.sec[data-sec="activity"]')
check('view (6c): the Activity section exists and is OPEN by default — it subscribes as soon as the bridge welcomes the page', !!sec && !sec.classList.contains('collapsed') && sentOf('activity_sub').length === 1 && !sentOf('activity_sub')[0].resync)
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('view: closing it unsubscribes (a closed one does not subscribe)', sec.classList.contains('collapsed') && sentOf('activity_unsub').length === 1 && sentOf('activity_sub').length === 1)
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('view: opening it again subscribes (activity_sub)', !sec.classList.contains('collapsed') && sentOf('activity_sub').length === 2 && !sentOf('activity_sub')[1].resync)
recv({ type: 'activity_board', full: true, epoch: 'E1', seq: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15, remote_hosts: [] }, upsert: units })
const T = doc.getElementById('acttree')
const rowsT = () => [...T.querySelectorAll('.ar')]
const rowOf = re => rowsT().find(r => re.test(r.textContent))
const nmRow = name => rowsT().find(r => r.querySelector('.nm')?.textContent === name)
const pathRow = p => rowsT().find(r => r.querySelector('.nm')?.getAttribute('title') === p)
const click = el => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const tog = el => click(el.querySelector('.chv'))   // 6d: the chevron expands; a click on the row SELECTS it (its log in the panel)
const PANEL = doc.getElementById('actpanel')
const pRows = () => [...(PANEL?.querySelectorAll('.ar') || [])]
const dOf = r => Number(r?.style.getPropertyValue('--d'))
check('view: project rows with their counts', /AIMB2 sessions · 5 active agents/.test(rowOf(/^▾📁 AIMB/)?.textContent || '') && /Tools1 session · 0 active agents/.test(rowOf(/📁 Tools/)?.textContent || ''), rowsT().slice(0, 3).map(r => r.textContent).join(' | '))
const orchRow = nmRow('Orch')
check('view: the session row — name, one host tag per host, its own line RENDERED, a rollup bar, ⌛, 🔔', !!orchRow && J([...orchRow.querySelectorAll('.htag')].map(h => h.textContent)) === J(['HOST-A', 'HOST-B'])
  && orchRow.querySelector('.ln').textContent === 'coordinating 3 of 6 tasks' && !!orchRow.querySelector('.pb.roll') && /⌛/.test(orchRow.textContent) && /🔔/.test(orchRow.textContent), orchRow && orchRow.innerHTML)
const resRow = pathRow('research')
check('view (6a): the DEFAULT view = sessions + their top-level nodes; deeper nodes stay closed', !!resRow && !!pathRow('@#70') && !!pathRow('build') && !pathRow('research/sub') && !pathRow('research/@Tharsis') && !pathRow('@#70/@step4'))
check('view: an agent row — monospace name, glyph with the ring, rendered line, bar, ETA; 6b: NO host tag on the headline host (as its parent row)', resRow.querySelector('.nm.path')?.textContent === 'research' && resRow.querySelector('.ln').textContent === 'reading 4,812 of 12,000 tiles'
  && !!resRow.querySelector('svg.gl circle.ring') && /⌛/.test(resRow.textContent) && !resRow.querySelector('.htag') && dOf(resRow) === 2)
check('view (6b): a host tag only where the host of a node differs from that of its parent — a top-level node on another host than the headline', pathRow('build')?.querySelector('.htag')?.textContent === 'HOST-B' && pathRow('deploy')?.querySelector('.htag')?.textContent === 'HOST-B' && !pathRow('old').querySelector('.htag'))
const c70 = pathRow('@#70')
check('view (6a): an implicit grouping context — "@#70", no current line (the line is left EMPTY — Robin, 2026-10-03), the "none" mark, its rolled-up bar, no pills', c70.querySelector('.nm.ctx')?.textContent === '@#70' && c70.querySelector('.ln.none')?.textContent === ''
  && !!c70.querySelector('svg.s-none') && !!c70.querySelector('.pb.roll') && c70.querySelectorAll('.pill').length === 0)
// per-node expand: its subtree Log, then its children one level deeper
tog(resRow)
const kidRows = () => rowsT().filter(r => dOf(r) === 3)
check('expand a node (6a; 6d: by its chevron): its children (a sub-agent + a context), one level deeper — and NO Log row in the tree (6d: logs live in the panel)', !rowsT().some(r => r.classList.contains('lg') || /\bLog\b/.test(r.querySelector('.nm')?.textContent || ''))
  && !!pathRow('research/sub') && !!pathRow('research/@Tharsis') && dOf(pathRow('research/sub')) === 3 && dOf(pathRow('research/@Tharsis')) === 3 && !resRow.classList.contains('sel') && sentOf('activity').length === 0, kidRows().map(r => r.textContent).join(' | '))
const thRow = pathRow('research/@Tharsis')
check('view (6a): a context row — "@Tharsis", a state MARK (no ring), its line rendered against its own bar, the bar; fresh because its agent is', thRow.querySelector('.nm.ctx')?.textContent === '@Tharsis' && !!thRow.querySelector('svg.gl.ctx') && !thRow.querySelector('circle.ring')
  && thRow.querySelector('.ln').textContent === 'tiling 2 of 8 tiles' && !!thRow.querySelector('.pb') && !thRow.classList.contains('stale'), thRow.innerHTML)
tog(thRow)
const nol = pathRow('research/@Tharsis/@nol'), z12 = pathRow('research/@Tharsis/@z12')
check('view (6a): nested contexts (depth 3) under the open context; one with no line shows an empty line and no pills', dOf(z12) === 4 && dOf(nol) === 4 && !/no current line/.test(nol.textContent) && nol.querySelector('.ln.none')?.textContent === '' && nol.querySelectorAll('.pill').length === 0 && z12.querySelector('.ln').textContent === 'strip z12')
const pills = r => [...(r?.querySelectorAll('.pill') || [])].map(p => p.className.replace('pill ', ''))
check('view: pills only for blocked / failed / stale / gone (running and done have none)', J(pills(pathRow('research/sub'))) === J(['blocked']) && J(pills(pathRow('deploy'))) === J(['failed']) && J(pills(pathRow('old'))) === J(['stale'])
  && J(pills(pathRow('w'))) === J(['gone']) && J(pills(resRow)) === '[]' && J(pills(pathRow('build'))) === '[]', J([pills(pathRow('research/sub')), pills(pathRow('deploy')), pills(pathRow('old')), pills(pathRow('w'))]))
tog(pathRow('old'))
const oc = pathRow('old/@ctx')
check('view (6a): a context under a STALE agent shows stale (greyed + pill) — inherited, not its own', !!oc && oc.classList.contains('stale') && J(pills(oc)) === J(['stale']) && !!oc.querySelector('svg.gl.ctx.s-stale'), oc && oc.outerHTML)
check('view: host down is a DISTINCT badge (not "gone") on the host\'s session + agents; its host tag is marked', J(pills(pathRow('c1'))) === J(['hostdown']) && J(pills(nmRow('Cee'))) === J(['hostdown']) && !!nmRow('Cee').querySelector('.htag.down'), J([pills(pathRow('c1')), pills(nmRow('Cee'))]))
check('view: a stale row greys out (class stale); an item\'s own stale_after keeps it live', pathRow('old')?.classList.contains('stale') && !pathRow('longrun')?.classList.contains('stale') && !resRow.classList.contains('stale'))
check('view: no inline time text on status rows (times live in the hover tooltips)', rowsT().every(r => !/\bago\b|\d\d:\d\d|\b\d+m\b|\b\d+s\b/.test(r.querySelector('.ln')?.textContent + (r.querySelector('.nm')?.textContent || ''))), rowsT().map(r => r.textContent).filter(t => /ago|\d\d:\d\d/.test(t)).join(' | '))
// depth 6: open the chain down to the deepest node; indentation stays one step per level
for (const p of ['@#70', '@#70/@step4', '@#70/@step4/spec-70', '@#70/@step4/spec-70/@Tharsis', '@#70/@step4/spec-70/@Tharsis/@z12']) tog(pathRow(p))
const deep = pathRow(deepPath)
check('view (6a): depth 6 — the chain opens node by node; the deepest row sits at --d 7 (one 16px step per level), its line rendered', !!deep && dOf(deep) === 7 && deep.querySelector('.ln').textContent === 'six levels down 1 of 4 tiles' && dOf(pathRow('@#70/@step4/spec-70')) === 4, deep && deep.outerHTML)
const css = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n')
check('view (6a): indentation is 16px per level (readable at depth 6), tighter on a phone; light/dark tokens kept', /\.ar \{[^}]*calc\(6px \+ var\(--d, 0\) \* 16px\)/.test(css) && /@media \(max-width: 720px\)/.test(css) && /:root\[data-theme="dark"\]/.test(css) && /\.ar \.nm\.ctx \{[^}]*var\(--info\)/.test(css))
check('view (6a): an agent under a task context gets the ring; a context in between shows "none" when it has no line', !!pathRow('@#70/@step4/spec-70').querySelector('circle.ring') && !!pathRow('@#70/@step4').querySelector('svg.s-none'))
// tooltips on hover
const g = resRow.querySelector('[data-tip]')
g.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
check('view: hovering the glyph shows the actual times', /^Running\nstarted \d\d:\d\d:\d\d/.test(g.getAttribute('title') || '') && /stale at/.test(g.getAttribute('title')), g.getAttribute('title'))
const cg = pathRow('research/@Tharsis').querySelector('[data-tip]'); cg.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
check('view (6a): hovering a context\'s mark names the agent its staleness follows', /staleness follows agent research/.test(cg.getAttribute('title') || ''), cg.getAttribute('title'))
const bar = resRow.querySelector('.pb'); bar.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
const eta = [...resRow.querySelectorAll('.ic')].find(i => i.textContent === '⌛'); eta.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
const bell = [...orchRow.querySelectorAll('.ic')].find(i => i.textContent === '🔔'); bell.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
check('view: bar / ⌛ / 🔔 tooltips', bar.getAttribute('title') === '4,812 of 12,000 tiles (40%) — reported' && /^ETA ~30m \(estimated\), about \d\d:\d\d$/.test(eta.getAttribute('title')) && bell.getAttribute('title') === 'Doorbell armed', J([bar.getAttribute('title'), eta.getAttribute('title')]))
// the slider (client-side stale: instant, no round trip) — the inherited context follows too
const nSent = ws.sent.length, sl = doc.getElementById('actStale')
sl.value = '45'; sl.dispatchEvent(new win.Event('input'))
check('slider: 45 min → the 30-min-quiet agent AND its context are live again at once, with no message to the bridge', !pathRow('old').classList.contains('stale') && !pathRow('old/@ctx').classList.contains('stale') && J(pills(pathRow('old'))) === '[]' && ws.sent.length === nSent && /45m/.test(doc.getElementById('actStaleV').textContent))
sl.value = '15'; sl.dispatchEvent(new win.Event('input'))
// the project cycle + the depth control
const projRow = () => rowOf(/📁 AIMB/)
click(projRow())
check('project click 1: sessions only (nodes hidden, sessions shown)', !pathRow('research') && !!nmRow('Orch') && !!nmRow('Leaver'))
click(projRow())
check('project click 2: collapsed (only the heading; the other project untouched)', !nmRow('Orch') && !!projRow() && !!nmRow('Cee'))
click(projRow())
check('project click 3: back to sessions + their top-level nodes (opened nodes stay open)', !!pathRow('research') && !!nmRow('Orch') && !!pathRow('research/sub'))
const depth = l => click(doc.querySelector(`#actDepth button[data-l="${l}"]`))
depth('collapsed')
check('depth control: Projects → every project collapsed', !nmRow('Orch') && !nmRow('Cee') && rowsT().length === 2 && doc.querySelector('#actDepth button[data-l="collapsed"]').className === 'on')
depth('sessions')
check('depth control: Sessions → sessions everywhere, no nodes', !!nmRow('Orch') && !!nmRow('Cee') && !pathRow('research') && !pathRow('c1'))
depth('all')
check('depth control (6a): Nodes → sessions + their top-level nodes (the default view)', !!pathRow('research') && !!pathRow('c1') && doc.querySelector('#actDepth button[data-l="all"]').className === 'on' && doc.querySelector('#actDepth button[data-l="all"]').textContent === 'Nodes')
const ao = doc.getElementById('actActive'); ao.checked = true; ao.dispatchEvent(new win.Event('change'))
check('active only: finished + gone agents and sessions with nothing active disappear', !pathRow('build') && !pathRow('deploy') && !nmRow('Leaver') && !nmRow('Cee') && !!pathRow('research') && !!pathRow('old'))
ao.checked = false; ao.dispatchEvent(new win.Event('change'))
doc.getElementById('actCollapse').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Collapse all closes every expanded row (back to the default view)', !rowsT().some(r => r.classList.contains('le')) && !pathRow('research/sub') && !!pathRow('research'))
// the session's Log (the whole session, per host)
check('log panel (6d): hidden while nothing is selected (the tree takes the width)', doc.getElementById('actmain').classList.contains('nosel') && PANEL.children.length === 0)
click(nmRow('Orch'))
const lq = sentOf('activity').pop()
check('select a session (6d: a click): its row is highlighted and the LOG PANEL asks for the whole session\'s log (session, project, user, the headline host; no path = the root\'s subtree)', nmRow('Orch').classList.contains('sel') && nmRow('Orch').getAttribute('aria-selected') === 'true'
  && lq?.query?.log?.session === 'Orch' && lq.query.log.host === 'HOST-A' && lq.query.log.project === 'AIMB' && lq.query.log.user === 'robin' && !('path' in lq.query.log) && lq.query.log.limit === 50 && !doc.getElementById('actmain').classList.contains('nosel'), J(lq))
check('log panel (6d): its header — "Log", the session, its host tag, the count; a multi-host session offers each host', /^Log/.test(PANEL.querySelector('.aph-t')?.textContent || '') && PANEL.querySelector('.aph-t .htag')?.textContent === 'HOST-A' && /whole session/.test(PANEL.querySelector('.aph-s')?.textContent || '')
  && J([...PANEL.querySelectorAll('[data-ph]')].map(b => b.getAttribute('data-ph'))) === J(['HOST-A', 'HOST-B']), PANEL.querySelector('.aph')?.textContent)
recv({ type: 'activity_queued', ref: lq.ref, wait_ms: 1500, position: 3 })
check('a queued fetch shows a spinner + its wait (in the panel)', /queued — about 2s/.test(PANEL.textContent) && !!PANEL.querySelector('.spin'))
recv({ type: 'activity', ref: lq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [
  { id: 'e3', ts: NOW - MIN, path: '', rel: '', current: true, text: 'coordinating {progress}', rendered: 'coordinating 3 of 6 tasks', state: 'running' },
  { id: 'e2', ts: NOW - 2 * MIN, path: 'research/@Tharsis/@z12', rel: 'research/@Tharsis/@z12', current: true, text: 'with attachments', rendered: 'with attachments', state: 'blocked', has_details: true, has_data: true }], next_cursor: 'f1.2026-10-02.120', total: 7 } } })
const eRows = () => pRows().filter(r => r.classList.contains('le'))
check('log entries (#87: OLDEST first — the newest at the bottom): time, state dot, the entry\'s path RELATIVE to the node (@~ on a current line), rendered text', eRows().length === 2 && /^\d\d:\d\d:\d\d$/.test(eRows()[1].querySelector('.tm').textContent) && eRows()[1].querySelector('.ctag').textContent === '@~root'
  && eRows()[0].querySelector('.ctag').textContent === 'research/@Tharsis/@~z12' && eRows()[0].querySelector('.dot').classList.contains('bg-blocked') && eRows()[1].querySelector('.ln').textContent === 'coordinating 3 of 6 tasks', eRows().map(r => r.textContent).join(' | '))
const older = pRows().find(r => /load older/.test(r.textContent))
click(older)
const lq2 = sentOf('activity').pop()
check('"load older" asks for the next page with the cursor', lq2.query.log.cursor === 'f1.2026-10-02.120' && lq2.query.log.host === 'HOST-A', J(lq2))
recv({ type: 'activity', ref: lq2.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'e1', ts: NOW - 3 * MIN, path: '', rel: '', text: 'started', rendered: 'started', state: 'running' }], next_cursor: null } } })
check('... the page goes ABOVE (#87: oldest first), and the end of the log has no "load older"', eRows().length === 3 && eRows()[0].getAttribute('data-id') === 'e1' && eRows()[2].getAttribute('data-id') === 'e3' && !pRows().some(r => /load older/.test(r.textContent)))
click(eRows()[1])
const eq = sentOf('activity').pop()
check('an entry with details/data expands → fetches it by id + host', eq.query.entry?.id === 'e2' && eq.query.entry.host === 'HOST-A', J(eq))
recv({ type: 'activity', ref: eq.ref, result: { ok: true, entry: { id: 'e2', details: 'DETAIL TEXT', data: { rows: 42, ok: true } } } })
const det = PANEL.querySelector('.ad')
check('... showing the details text and the data as a JSON TREE (#86: no longer a <pre>)', !!det && det.querySelector('pre.dtx')?.textContent === 'DETAIL TEXT' && det.querySelectorAll('pre').length === 1 && !!det.querySelector('.jt details[open]') && /rows: 42/.test(det.querySelector('.jt').textContent) && /ok: true/.test(det.querySelector('.jt').textContent), det && det.innerHTML)
click(pathRow('research'))
const aq = sentOf('activity').pop()
check('select a node (6d): the selection MOVES (the session row is no longer highlighted) and the panel asks with its PATH (+ host) — the subtree merged by the bridge', aq.query.log.path === 'research' && aq.query.log.host === 'HOST-A' && !('agent' in aq.query.log)
  && pathRow('research').classList.contains('sel') && !nmRow('Orch').classList.contains('sel') && /this node and below/.test(PANEL.querySelector('.aph-s')?.textContent || '') && PANEL.querySelector('.aph-t .nm')?.textContent === 'research', J(aq))
recv({ type: 'activity', ref: aq.ref, result: { ok: false, code: 'busy', retry_after_ms: 800, what: 'too many history fetches are waiting' } })
check('a busy answer offers a retry', /busy: too many history fetches are waiting — click to retry/.test(PANEL.textContent))
tog(pathRow('research'))
// deltas, a gap → resync, expand / collapse all, unsubscribe
recv({ type: 'activity_delta', epoch: 'E1', seq: 2, base: 1, head: { host: 'HOST-A', now: Date.now(), stale_after_min: 15 }, upsert: [{ ...units[1], current: { id: 'r9', ts: NOW, text: 'writing up', state: 'running' } }, node('k-orch', 'research/@new', 'context', 'HOST-A', { current: { id: 'nw', ts: NOW, text: 'a context that just appeared', state: 'running' } })], remove: [units[7].id] })
check('a delta updates a row in place, adds a nested node under its (open) parent, and removes another', pathRow('research').querySelector('.ln').textContent === 'writing up' && !pathRow('deploy') && !!pathRow('research/@new') && dOf(pathRow('research/@new')) === 3)
recv({ type: 'activity_delta', epoch: 'E1', seq: 9, base: 8, upsert: [], remove: [] })
check('a delta that doesn\'t follow (lost frames) → the page asks for a resync', sentOf('activity_sub').length === 3 && sentOf('activity_sub')[2].resync === true)
recv({ type: 'activity_board', full: true, epoch: 'E1', seq: 1, head: { host: 'HOST-A', now: Date.now(), stale_after_min: 15 }, upsert: units })
check('... and the full board restores the view', !!pathRow('deploy') && /coordinating/.test(nmRow('Orch').textContent))
doc.getElementById('actCollapse').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Collapse all closes every expanded row', !pathRow('research/sub') && !pathRow('@#70/@step4'))
const nReq = sentOf('activity').length
doc.getElementById('actExpand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Expand all opens every session and every node down to depth 6 (no log is fetched by it)', !!pathRow(deepPath) && !!pathRow('research/@Tharsis/@nol') && sentOf('activity').length === nReq, `${sentOf('activity').length - nReq}`)
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('leaving (collapsing the section) unsubscribes', sentOf('activity_unsub').length === 2)
const legend = doc.getElementById('actlegend')
check('legend: the 7 agent glyphs + the context mark + (6b) the 4 plan-item marks + (6c) abandoned + (#79) the 4 session glyphs + (#85) the 3 question bubbles + the ring / hover hint', legend.querySelectorAll('svg').length === 20 && /question: awaiting an answer/.test(legend.textContent) && /skipped · abandoned/.test(legend.textContent) && /plan item: to do · in progress · done · skipped/.test(legend.textContent) && /ring is the time left before an agent goes stale/.test(legend.textContent) && /hover the icons/.test(legend.textContent) && /context \(no ring/.test(legend.textContent))

try {   // a crash (an older dashboard without the 6b helpers) counts as one failure
// ================================================================= 6b (v1.63.0): plan items, the plan bar, active only, host tags, per-host headlines
const pi = (key, path, host, st, extra = {}) => node(key, path, 'context', host, { plan_item: true, state: st, current: { id: `c-${path}`, ts: NOW - MIN, text: path.split('/').at(-1).replace(/^@/, ''), state: st }, ...extra })
check('6b glyph: ☐ todo = an empty box; ☑ done = a box + tick; skipped = a box struck through; running / blocked = the in-progress mark (no ring)', /s-todo.*<rect[^>]*rx="2\.2"[^>]*\/><\/svg>$/.test(X.planGlyph('todo')) && /s-done.*<rect.*<path d="M5 8\.2/.test(X.planGlyph('done'))
  && /s-skipped.*<path d="M4\.8 8 L11\.2 8"/.test(X.planGlyph('skipped')) && /s-running.*<rect x="4\.5"/.test(X.planGlyph('running')) && /s-blocked/.test(X.planGlyph('blocked')) && !/ring/.test(X.planGlyph('running')) && X.glyphSvg({ state: 'done' }, NOW, 'plan') === X.planGlyph('done'))
const quietAgent = run(600)
check('6b stale: a plan item never goes stale (any state), even under a stale or gone agent — its own state shows', ['todo', 'running', 'blocked'].every(s => (e => e.state === s && !e.stale && e.staleAt === null && e.plan)(X.effState(pi('k', '@p/@x', 'H', s, { last_activity: NOW - 600 * MIN }), quietAgent, NOW, 15)))
  && X.effState(pi('k', '@p/@x', 'H', 'todo'), { state: 'gone' }, NOW, 15).state === 'todo' && X.effState(quietAgent, null, NOW, 15).state === 'stale')
check('6b tooltip: a plan item says so (never goes stale), not "staleness follows"', (t => /^Plan item — To do/.test(t) && /never goes stale/.test(t) && !/staleness follows/.test(t))(X.statusTip(pi('k', '@p/@x', 'H', 'todo'), quietAgent, NOW, 15)))
check('#79 bar tooltip: "2 of 5 done · 1 skipped (40%) — its plan: 5 items" (skipped inside M); a 1.65 bridge\'s bar (skipped left OUT of M: n = total + skipped) reads the same', X.barTip({ done: 2, skipped: 1, total: 5, unit: 'done', rollup: true, todos: true, items: true, n: 5 }) === '2 of 5 done · 1 skipped (40%) — its plan: 5 items'
  && X.barTip({ done: 2, total: 4, unit: 'done', rollup: true, todos: true, skipped: 1, n: 5 }) === '2 of 5 done · 1 skipped (40%) — its plan: 5 items', X.barTip({ done: 2, total: 4, unit: 'done', rollup: true, todos: true, skipped: 1, n: 5 }))
// a plan fixture: session-level plan @#70 with items in every state (created in one call: equal created_at, plan_ix decides), an agent under one item, a nested plan,
// a finished agent holding an open item, an ended plan, a multi-host session (HOST-A headline; HOST-B nodes)
const T7 = NOW - 30 * MIN, at7 = { created_at: T7 }
const pselfA = root('HOST-A', { current: { id: 'pa', ts: NOW - 2 * MIN, text: 'planning #70', state: 'running' } }), pselfB = root('HOST-B', { current: { id: 'pb', ts: NOW - 20 * MIN, text: 'older headline on B', state: 'running' }, log: { remote: true } })
const plan = [
  sess('k-plan', 'Planner', 'AIMB', { hosts: ['HOST-A', 'HOST-B'], multi_host: true, self: pselfA, selves: [pselfA, pselfB] }),
  node('k-plan', '@#70', 'context', 'HOST-A', { implicit: true, bar: { done: 2, skipped: 1, total: 6, unit: 'done', pct: 33.3, rollup: true, todos: true, items: true, n: 6 }, created_at: T7 - 1000 }),   // #79: M = every item
  pi('k-plan', '@#70/@Ship', 'HOST-A', 'todo', { ...at7, plan_ix: 5 }), pi('k-plan', '@#70/@Spec', 'HOST-A', 'done', { ...at7, plan_ix: 0 }), pi('k-plan', '@#70/@Build', 'HOST-A', 'running', { ...at7, plan_ix: 1 }),
  pi('k-plan', '@#70/@Test', 'HOST-A', 'blocked', { ...at7, plan_ix: 2 }), pi('k-plan', '@#70/@Docs', 'HOST-A', 'skipped', { ...at7, plan_ix: 3 }), pi('k-plan', '@#70/@Review', 'HOST-A', 'done', { ...at7, plan_ix: 4, current: { id: 'rv', ts: NOW - MIN, text: 'approved by Robin', state: 'done' } }),
  node('k-plan', '@#70/@Build/builder', 'agent', 'HOST-A', { current: { id: 'bd', ts: NOW - 40 * MIN, text: 'compiling', state: 'running' }, last_activity: NOW - 40 * MIN }),
  pi('k-plan', '@#70/@Build/@unit', 'HOST-A', 'done', { ...at7, plan_ix: 0 }), pi('k-plan', '@#70/@Build/@e2e', 'HOST-A', 'todo', { ...at7, plan_ix: 1 }),
  node('k-plan', 'retired', 'agent', 'HOST-A', { state: 'failed', active: false, finished_at: NOW - 5 * MIN, current: { id: 'rt', ts: NOW - 5 * MIN, text: 'stopped', state: 'failed' } }),   // 6c: failed (done would mark its plan complete)
  pi('k-plan', 'retired/@leftover', 'HOST-A', 'todo', at7),
  node('k-plan', '@shipped', 'context', 'HOST-A', { implicit: true }), pi('k-plan', '@shipped/@a', 'HOST-A', 'done', at7), pi('k-plan', '@shipped/@b', 'HOST-A', 'done', at7),   // 6c: all done = ended (skipped would keep it open)
  node('k-plan', 'helper', 'agent', 'HOST-B', { current: { id: 'hp', ts: NOW - MIN, text: 'on B', state: 'running' } }),
  node('k-plan', 'helper/@ctx', 'context', 'HOST-B', { current: { id: 'hc', ts: NOW - MIN, text: 'B context', state: 'running' } }),
]
const PU = Object.fromEntries(plan.map(u => [u.id, u]))
const pt = X.buildTree(PU, {}).find(p => p.key === 'aimb').sessions.find(x => x.s.session === 'Planner')
check('6b tree: plan items in CREATION order — the same created_at → plan_ix (the given order), never A→Z', J(kidsOf(find(pt.kids, '@#70'))) === J(['@#70/@Spec', '@#70/@Build', '@#70/@Test', '@#70/@Docs', '@#70/@Review', '@#70/@Ship']), J(kidsOf(find(pt.kids, '@#70'))))
check('6b tree: the nested plan + the agent under an item nest under it', J(kidsOf(find(pt.kids, '@#70/@Build'))) === J(['@#70/@Build/builder', '@#70/@Build/@unit', '@#70/@Build/@e2e']) || J(kidsOf(find(pt.kids, '@#70/@Build'))) === J(['@#70/@Build/@unit', '@#70/@Build/@e2e', '@#70/@Build/builder']), J(kidsOf(find(pt.kids, '@#70/@Build'))))
check('6b/6c open / ended: isOpenItem (todo / running / blocked); 6c planEnded = EVERY item done, or the plan node marked done / abandoned (skipped keeps it open)', X.isOpenItem(pi('k', 'a', 'H', 'todo')) && X.isOpenItem(pi('k', 'a', 'H', 'blocked')) && !X.isOpenItem(pi('k', 'a', 'H', 'done')) && !X.isOpenItem(node('k', 'a', 'context', 'H', { state: 'running' }))
  && X.planEnded([pi('k', 'a', 'H', 'done'), pi('k', 'b', 'H', 'done')]) && !X.planEnded([pi('k', 'a', 'H', 'done'), pi('k', 'b', 'H', 'skipped')]) && !X.planEnded([pi('k', 'a', 'H', 'done'), pi('k', 'b', 'H', 'todo')]) && !X.planEnded([node('k', 'a', 'context', 'H', {})])
  && X.planEnded([pi('k', 'a', 'H', 'todo')], { current: { state: 'abandoned' } }) && X.planEnded([pi('k', 'a', 'H', 'failed')], { current: { state: 'done' } }) && !X.planEnded([pi('k', 'a', 'H', 'todo')], { current: { state: 'failed' } })
  && X.planEnded([pi('k', 'a', 'H', 'todo')], { plan_node: true, plan_end_at: NOW }) && !X.planEnded([pi('k', 'a', 'H', 'done')], { plan_node: true }))
const pa = X.buildTree(PU, { activeOnly: true }).find(p => p.key === 'aimb').sessions.find(x => x.s.session === 'Planner')
check('6b active only: a finished agent holding an OPEN item stays (with it); an ENDED plan disappears (its items and its plain node); an open plan keeps its done / skipped items', !!find(pa.kids, 'retired') && !!find(pa.kids, 'retired/@leftover') && !find(pa.kids, '@shipped') && !find(pa.kids, '@shipped/@a')
  && J(kidsOf(find(pa.kids, '@#70'))) === J(['@#70/@Spec', '@#70/@Build', '@#70/@Test', '@#70/@Docs', '@#70/@Review', '@#70/@Ship']), J(pa.kids.map(t => t.u.path)))
check('6b host tags: hostTagOn — only where a node\'s host differs from its parent\'s (a top-level node: the headline host\'s)', !X.hostTagOn(find(pt.kids, '@#70'), true) && X.hostTagOn(find(pt.kids, 'helper'), true) && !X.hostTagOn(find(pt.kids, 'helper/@ctx'), true)
  && !X.hostTagOn(find(pt.kids, '@#70/@Build/@unit'), true) && !X.hostTagOn(find(pt.kids, 'helper'), false) && X.hostTagOn({ u: { host: 'B' }, parentHost: 'A' }, true))
// rows of the Planner session only (another session has an @#70 too)
const inPlanner = p => { const rs = rowsT(), i = rs.indexOf(nmRow('Planner')); for (let j = i + 1; j < rs.length && dOf(rs[j]) > 1; j++) if (rs[j].querySelector('.nm')?.getAttribute('title') === p) return rs[j]; return null }
// ---- rendered
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
recv({ type: 'activity_board', full: true, epoch: 'E2', seq: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15, remote_hosts: [] }, upsert: [...units, ...plan] })
doc.getElementById('actCollapse').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const p70 = inPlanner('@#70')
check('6b view: the plan node shows its "N of M done" bar (solid, class plan) with the plan tooltip', !!p70?.querySelector('.pb.plan') && (b => { b.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); return b.getAttribute('title') === '2 of 6 done · 1 skipped (33%) — its plan: 6 items' })(p70.querySelector('.pb')), p70 && p70.innerHTML)
tog(p70)
const itemRows = () => rowsT().filter(r => r.classList.contains('pi') && dOf(r) === 3)
check('6b view: the items render in creation order with ☐ / the in-progress mark / ☑ / struck-through skipped', J(itemRows().map(r => r.querySelector('.nm').textContent)) === J(['Spec', 'Build', 'Test', 'Docs', 'Review', 'Ship'])
  && !!inPlanner('@#70/@Ship').querySelector('svg.s-todo rect[rx="2.2"]') && !!inPlanner('@#70/@Spec').querySelector('svg.s-done path') && inPlanner('@#70/@Spec').classList.contains('pdone')
  && !!inPlanner('@#70/@Build').querySelector('svg.s-running') && inPlanner('@#70/@Docs').classList.contains('skipped') && !!inPlanner('@#70/@Docs').querySelector('svg.s-skipped'), J(itemRows().map(r => r.className)))
const css6 = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n')
check('6b view: skipped = struck through (CSS); an item\'s line is hidden while it is just its name, shown once it says more', /\.ar\.skipped \.nm, \.ar\.skipped \.ln \{[^}]*line-through/.test(css6) && inPlanner('@#70/@Ship').querySelector('.ln').textContent === '' && inPlanner('@#70/@Review').querySelector('.ln').textContent === 'approved by Robin')
check('6b view: a plan item never shows a stale pill — under its quiet agent the agent row does (its own staleness)', !inPlanner('@#70/@Build').classList.contains('stale') && J(pills(inPlanner('@#70/@Test'))) === J(['blocked']))
tog(inPlanner('@#70/@Build'))
check('6b view: the nested plan under an item and the agent working under it; the agent shows its own stale', !!inPlanner('@#70/@Build/@unit') && !!inPlanner('@#70/@Build/@e2e') && inPlanner('@#70/@Build/builder')?.classList.contains('stale') && J(pills(inPlanner('@#70/@Build/builder'))) === J(['stale']))
check('6b view (host tags): none on the headline host\'s top-level rows or on any child of a same-host parent; HOST-B\'s top-level node carries HOST-B', !p70.querySelector('.htag') && !inPlanner('@#70/@Ship').querySelector('.htag') && inPlanner('helper')?.querySelector('.htag')?.textContent === 'HOST-B')
const plRow = nmRow('Planner')
check('6b view: the multi-host session row keeps a tag for every host and the headline of the host that most recently set one', J([...plRow.querySelectorAll('.htag')].map(h => h.textContent)) === J(['HOST-A', 'HOST-B']) && plRow.querySelector('.ln').textContent === 'planning #70')
tog(plRow)
const hselfRows = rowsT().filter(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Planner')
check('6b view: expanded, each host\'s OWN line shows (HOST-A\'s headline, HOST-B\'s older one)', J(hselfRows.map(r => [r.querySelector('.htag').textContent, r.querySelector('.ln').textContent])) === J([['HOST-A', 'planning #70'], ['HOST-B', 'older headline on B']]), J(hselfRows.map(r => r.textContent)))
ao.checked = true; ao.dispatchEvent(new win.Event('change'))
check('6b view (active only): the open item under a finished agent stays visible; the ended plan is gone; the open plan stays complete', !!inPlanner('retired') && !inPlanner('@shipped') && !!inPlanner('@#70/@Spec') && !!inPlanner('@#70/@Docs'))
ao.checked = false; ao.dispatchEvent(new win.Event('change'))
recv({ type: 'activity_delta', epoch: 'E2', seq: 2, base: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15 }, upsert: [pi('k-plan', '@#70/@Ship', 'HOST-A', 'done', { ...at7, plan_ix: 5 }), { ...plan[1], bar: { ...plan[1].bar, done: 3 } }], remove: [] })
check('6b view: a delta ticks an item in place (☐ → ☑) and moves the plan bar', !!inPlanner('@#70/@Ship')?.querySelector('svg.s-done') && inPlanner('@#70/@Ship').classList.contains('pdone') && inPlanner('@#70').querySelector('.pb.plan > i')?.style.width === '50%', J([inPlanner('@#70/@Ship')?.outerHTML, inPlanner('@#70')?.querySelector('.pb')?.outerHTML]))
try {   // a crash (an older dashboard without the 6c helpers) counts as one failure
const HOUR = 60 * MIN
// ================================================================= 6c (v1.64.0): open plans expanded, the finished-plan window + slider, abandoned, home-host tags,
// the Plans filter, rollups that follow the filters, the aligned bar column, gossiped counts, the run boundary, the 6d row hooks
const pi6 = (key, path, host, st, extra = {}) => node(key, path, 'context', host, { plan_item: true, state: st, current: { id: `c6-${path}`, ts: NOW - 4 * HOUR, text: path.split('/').at(-1).replace(/^@/, ''), state: st }, ...extra })
const selfA6 = root('HOST-A', { current: { id: 's6a', ts: NOW - MIN, text: 'headline from A (newer)', state: 'running' } }), selfB6 = root('HOST-B', { current: { id: 's6b', ts: NOW - 30 * MIN, text: 'B was here first', state: 'running' }, created_at: NOW - 3 * 60 * MIN, log: { remote: true, total: 4 } })
const rootR = root('HOST-A', { current: { id: 'rr', ts: NOW - MIN, text: 'rolling {progress}', state: 'running' }, bar: { done: 8, total: 12, unit: 'files', pct: 66.7, rollup: true, n: 2 } })
const six = [
  sess('k-six', 'Sixc', 'SixC', { hosts: ['HOST-A', 'HOST-B'], multi_host: true, home: 'HOST-B', self: selfA6, selves: [selfA6, selfB6] }),
  node('k-six', '@open', 'context', 'HOST-A', { implicit: true, plan_node: true, bar: { done: 1, total: 2, unit: 'done', pct: 50, rollup: true, todos: true, skipped: 1, n: 3, abandoned: 1 } }),
  pi6('k-six', '@open/@a', 'HOST-A', 'done', { plan_ix: 0 }), pi6('k-six', '@open/@b', 'HOST-A', 'skipped', { plan_ix: 1 }), pi6('k-six', '@open/@c', 'HOST-A', 'abandoned', { plan_ix: 2 }),
  node('k-six', '@recent', 'context', 'HOST-A', { implicit: true, plan_node: true, plan_end_at: NOW - 30 * MIN }),
  pi6('k-six', '@recent/@x', 'HOST-A', 'done'), pi6('k-six', '@recent/@y', 'HOST-A', 'done'),
  node('k-six', '@old', 'context', 'HOST-A', { implicit: true, plan_node: true, plan_end_at: NOW - 3 * HOUR }),
  pi6('k-six', '@old/@z', 'HOST-A', 'done'),
  node('k-six', 'anode', 'agent', 'HOST-A', { state: 'blocked', current: { id: 'an', ts: NOW - MIN, text: 'on A, the non-home host', state: 'blocked' } }),
  node('k-six', 'bnode', 'agent', 'HOST-B', { current: { id: 'bn', ts: NOW - MIN, text: 'on B, the home host', state: 'running' }, log: { remote: true, total: 5 } }),
  node('k-six', 'bnode/@ctx', 'context', 'HOST-B', { current: { id: 'bc', ts: NOW - MIN, text: 'b ctx', state: 'running' }, log: { remote: true, total: 2, partial: true } }),
  sess('k-roll', 'Rollup', 'SixC', { host: 'HOST-A', self: rootR }),
  node('k-roll', 'worker', 'agent', 'HOST-A', { state: 'done', active: false, finished_at: NOW - 5 * MIN, current: { id: 'wk', ts: NOW - 5 * MIN, text: 'all files', state: 'done' }, progress: { done: 6, total: 6, unit: 'files' } }),
  node('k-roll', 'live', 'agent', 'HOST-A', { current: { id: 'lv', ts: NOW - MIN, text: 'some files', state: 'running' }, progress: { done: 2, total: 6, unit: 'files' } }),
]
ao.checked = false; ao.dispatchEvent(new win.Event('change'))
recv({ type: 'activity_board', full: true, epoch: 'E3', seq: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15, finished_plan_open_min: 120, remote_hosts: [] }, upsert: [...units, ...plan, ...six] })
const inS = (sname, p) => { const rs = rowsT(), i = rs.indexOf(nmRow(sname)); if (i < 0) return null; for (let j = i + 1; j < rs.length && dOf(rs[j]) > 1; j++) if (rs[j].querySelector('.nm')?.getAttribute('title') === p) return rs[j]; return null }
check('6c open by default: an OPEN plan renders expanded (its items show without a click), even with a skipped and an abandoned item', !!inS('Sixc', '@open/@a') && !!inS('Sixc', '@open/@b') && !!inS('Sixc', '@open/@c'))
check('6c finished-plan window: an ended plan stays expanded inside finished_plan_open_min (the board\'s head: 120 min) and collapses after it (not removed)', !!inS('Sixc', '@recent/@x') && !!inS('Sixc', '@old') && !inS('Sixc', '@old/@z'),
  J([!!inS('Sixc', '@recent/@x'), !!inS('Sixc', '@old'), !!inS('Sixc', '@old/@z')]))
check('6c planOpenDefault: open → true; ended inside the window → true; past it → false; a node without plan items → false', X.planOpenDefault({ planNode: true, endedPlan: false, u: {} }, NOW, 120) && X.planOpenDefault({ planNode: true, endedPlan: true, u: { plan_end_at: NOW - 30 * MIN } }, NOW, 120)
  && !X.planOpenDefault({ planNode: true, endedPlan: true, u: { plan_end_at: NOW - 3 * HOUR } }, NOW, 120) && !X.planOpenDefault({ planNode: false, u: {} }, NOW, 120))
const po = doc.getElementById('actPlanOpen'), poV = doc.getElementById('actPlanOpenV'), lsBefore = Object.keys(win.localStorage).sort().join(), PI = m => String(X.planOpenIndex(m))   // 6d: the slider's value is an index into 0 – 7 days
check('6c slider: "plans open" sits beside "stale after", starting at the bridge\'s finished_plan_open_min', !!po && po.closest('.act-bar') === doc.getElementById('actStale').closest('.act-bar') && po.value === PI(120) && /2h \(bridge default\)/.test(poV.textContent), poV && poV.textContent)
po.value = PI(0); po.dispatchEvent(new win.Event('input'))
check('6c slider: 0 → the recently ended plan collapses at once (live, no message to the bridge)', !inS('Sixc', '@recent/@x') && !!inS('Sixc', '@recent') && !!inS('Sixc', '@open/@a') && /^0m$/.test(poV.textContent))
po.value = PI(240); po.dispatchEvent(new win.Event('input'))
check('6c slider: 240 → the plan that ended 3 h ago expands again; the slider is NOT persisted (like the stale slider)', !!inS('Sixc', '@old/@z') && !!inS('Sixc', '@recent/@x') && /4h/.test(poV.textContent) && Object.keys(win.localStorage).sort().join() === lsBefore)
po.value = PI(120); po.dispatchEvent(new win.Event('input'))
tog(inS('Sixc', '@open'))
check('6c open by default: the viewer\'s own click still wins (an open plan collapses on click)', !inS('Sixc', '@open/@a') && !!inS('Sixc', '@open'))
tog(inS('Sixc', '@open'))
const abRow = inS('Sixc', '@open/@c')
check('6c abandoned: a greyed row (class abandoned) with its own dashed plan glyph; the plan bar tooltip counts it', abRow.classList.contains('abandoned') && !!abRow.querySelector('svg.s-abandoned rect[stroke-dasharray]') && /s-abandoned/.test(X.planGlyph('abandoned')) && X.planGlyph('abandoned') !== X.planGlyph('skipped')
  && /1 abandoned/.test(X.barTip({ done: 1, total: 2, unit: 'done', rollup: true, todos: true, skipped: 1, n: 3, abandoned: 1 })) && /color:var\(--faint\)/.test([...doc.querySelectorAll('style')].map(s => s.textContent).join('').match(/\.ar\.abandoned \.nm[^}]*\}/)?.[0] || ''))
check('6c abandoned: an agent or a plan node set abandoned gets a distinct glyph too (not gone\'s, not done\'s)', /s-abandoned/.test(X.glyphSvg({ state: 'abandoned' }, NOW)) && X.glyphSvg({ state: 'abandoned' }, NOW) !== X.glyphSvg({ state: 'gone', gone: true }, NOW) && /s-abandoned/.test(X.glyphSvg({ state: 'abandoned' }, NOW, 'ctx')))
check('6c home host: top-level host tags compare with the session\'s HOME host (B — where it first appeared), not the headline host (A)', inS('Sixc', 'anode')?.querySelector('.htag')?.textContent === 'HOST-A' && !inS('Sixc', 'bnode')?.querySelector('.htag') && inS('Sixc', '@open')?.querySelector('.htag')?.textContent === 'HOST-A' && !inS('Sixc', '@open/@a')?.querySelector('.htag'),
  J([inS('Sixc', 'anode')?.querySelector('.htag')?.textContent, inS('Sixc', 'bnode')?.querySelector('.htag')?.textContent]))
tog(nmRow('Sixc'))
const hselfSix = rowsT().filter(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Sixc')
check('6c home host: expanded, the home host\'s own line says so (hover)', hselfSix.length === 2 && (r => { const l = r.querySelector('.ln'); l.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); return /HOME host/.test(l.getAttribute('title') || '') })(hselfSix.find(r => r.getAttribute('data-host') === 'HOST-B')), J(hselfSix.map(r => r.outerHTML.slice(0, 200))))
tog(nmRow('Sixc'))
// the bar column: pills sit right after the name, so .pb is always 3rd from the end of a row
const withBar = rowsT().filter(r => r.querySelector('.pb') && !r.classList.contains('proj'))
const anodeRow = inS('Sixc', 'anode')
check('6c bar column (6b rough edge): the bar sits at the same place on a row WITH a pill as on one without — pills come right after the name', withBar.length > 10 && withBar.every(r => r.children[r.children.length - 3] === r.querySelector('.pb'))
  && pills(anodeRow).includes('blocked') && [...anodeRow.children].indexOf(anodeRow.querySelector('.pills')) < [...anodeRow.children].indexOf(anodeRow.querySelector('.ln')), J(withBar.filter(r => r.children[r.children.length - 3] !== r.querySelector('.pb')).map(r => r.textContent)))
// gossiped counts
click(inS('Sixc', 'bnode'))
const bHead = PANEL.querySelector('.aph-t')?.textContent || ''
check('6c counts: a REMOTE node\'s log (6d: the panel header) says "N entries" — its subtree\'s gossiped own counts summed here; "+" when one understates (partial)', /bnode/.test(bHead) && /HOST-B/.test(bHead) && /7\+ entries/.test(bHead) && X.subtreeLog({ u: { log: { remote: true, total: 5 } }, kids: [{ u: { log: { remote: true, total: 2, partial: true } }, kids: [] }] }).n === 7
  && X.subtreeCount({ u: { log: { remote: true } }, kids: [] }) === null, bHead)
// the run boundary + pruned + by
click(inS('Rollup', 'live'))
const rq = sentOf('activity').pop()
recv({ type: 'activity', ref: rq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'r2', ts: NOW - MIN, path: 'live', rel: '', current: true, text: 'run 2', rendered: 'run 2', state: 'running' }, { id: 'r1', ts: NOW - 2 * MIN, path: 'live', rel: '', text: 'abandoned by the bridge', rendered: 'abandoned by the bridge', state: 'abandoned', by: 'bridge' }], next_cursor: null, run_start: true, earlier_cursor: 'f1.2026-10-01.900' } } })
const sre = pRows().find(r => /start of this run · show earlier runs/.test(r.textContent))
check('6c run boundary: the log stops at the start of the CURRENT run with a "show earlier runs" control; an entry the bridge wrote says "by bridge"', !!sre && pRows().some(r => r.querySelector('.by')?.textContent === 'by bridge') && !pRows().some(r => /load older/.test(r.textContent)))
click(sre)
const rq2 = sentOf('activity').pop()
check('6c run boundary: "show earlier runs" asks for the next page past the boundary — cursor = earlier_cursor, earlier:true', rq2.query.log.cursor === 'f1.2026-10-01.900' && rq2.query.log.earlier === true && rq2.query.log.path === 'live', J(rq2.query))
recv({ type: 'activity', ref: rq2.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'o1', ts: NOW - 3 * HOUR, path: 'live', rel: '', text: 'an earlier run', rendered: 'an earlier run', state: 'done' }], next_cursor: null } } })
const sep = pRows().find(r => r.classList.contains('sep')), eo1 = pRows().find(r => /an earlier run/.test(r.textContent))
check('6c run boundary: the earlier run\'s entries follow a "— earlier runs —" separator', !!sep && !!eo1 && pRows().indexOf(sep) > pRows().indexOf(eo1) && pRows().indexOf(sep) < pRows().indexOf(pRows().find(r => /run 2/.test(r.textContent))))   // #87: oldest first — the earlier run ABOVE the separator
click(inS('Sixc', 'anode'))
const rq3 = sentOf('activity').pop()
recv({ type: 'activity', ref: rq3.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'p1', ts: NOW - MIN, path: 'anode', rel: '', text: 'x', rendered: 'x', state: 'blocked' }], next_cursor: null, pruned: true } } })
check('6c pruned: a run that began in a deleted day file ends in "earlier history pruned" (not a silent gap)', pRows().some(r => r.classList.contains('pruned') && /earlier history pruned/.test(r.textContent)))
// rollups follow the filters (the 6b rough edge: a session's rollup counted what the filter hid)
const rollRow = () => nmRow('Rollup')
const tipOf = el => { el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); return el.getAttribute('title') }
const unf = tipOf(rollRow().querySelector('.pb'))
ao.checked = true; ao.dispatchEvent(new win.Event('change'))
const fil = tipOf(rollRow().querySelector('.pb'))
check('6c rollup vs filter: with Active only the session\'s rolled-up bar counts only what is shown (the finished worker\'s 6/6 drops out: 8 of 12 → 2 of 6 files); its line renders against it', unf === '8 of 12 files (66%) — rollup of 2 below it' && fil === '2 of 6 files (33%) — rollup of 1 below it' && rollRow().querySelector('.ln').textContent === 'rolling 2 of 6 files', J([unf, fil]))
check('6c rollKids: the same strategies as the bridge — sum, mean %, then N of M done (#79: three parts; M = every item, skipped + abandoned → skipped)', J(X.rollKids([{ u: { key: 'a' }, fbar: { done: 1, total: 4, unit: 'x' } }, { u: { key: 'b' }, fbar: { done: 1, total: 4, unit: 'x' } }])) === J({ done: 2, skipped: 0, total: 8, unit: 'x', pct: 25, rollup: true, n: 2 })
  && X.rollKids([{ u: { key: 'a' }, fbar: { done: 50, total: 100, unit: '%' } }, { u: { key: 'b' }, fbar: { done: 1, total: 4, unit: 'x' } }]).pct === 37.5
  && (r => r.todos && r.done === 1 && r.total === 3 && r.skipped === 2 && r.abandoned === 1)(X.rollKids([{ u: { key: 'a', plan_item: true, current: { state: 'done' } } }, { u: { key: 'b', plan_item: true, current: { state: 'skipped' } } }, { u: { key: 'c', plan_item: true, current: { state: 'abandoned' } } }])))
check('6c active only (6c plan rule): the ended plans are hidden, the open one (skipped + abandoned items) stays', !inS('Sixc', '@recent') && !inS('Sixc', '@old') && !!inS('Sixc', '@open/@b'))
// the Plans filter
const pf = doc.getElementById('actPlans')
ao.checked = false; ao.dispatchEvent(new win.Event('change'))
pf.checked = true; pf.dispatchEvent(new win.Event('change'))
check('6c Plans filter: beside "active only"; only plan nodes, plan items and what holds them — across all sessions (sessions without plans disappear)', pf.closest('.act-bar') === ao.closest('.act-bar') && !!inS('Sixc', '@open') && !!inS('Sixc', '@open/@a') && !!inS('Sixc', '@recent') && !!inS('Sixc', '@old')
  && !inS('Sixc', 'anode') && !inS('Sixc', 'bnode') && !nmRow('Rollup') && !nmRow('Orch') && !!nmRow('Planner') && !!inPlanner('@#70/@Spec') && !inPlanner('helper'))
check('6c Plans filter: an agent holding an open plan stays (it is a plan node — closed here by an earlier Collapse all); the agent working UNDER an item does not', !!inPlanner('retired') && !inPlanner('@#70/@Build/builder') && !!inPlanner('@#70/@Build/@unit'))
ao.checked = true; ao.dispatchEvent(new win.Event('change'))
check('6c Plans + Active only: combined — open plans only (ended ones hidden too)', !!inS('Sixc', '@open') && !inS('Sixc', '@recent') && !inS('Sixc', '@old') && !inPlanner('@shipped'))
pf.checked = false; pf.dispatchEvent(new win.Event('change')); ao.checked = false; ao.dispatchEvent(new win.Event('change'))
check('6c Plans filter: remembered per browser like active only', win.localStorage.getItem('aimb.act.plans') === '0')
// the 6d hooks
const nr = inS('Sixc', 'anode'), sr = nmRow('Sixc')
check('6d hooks: every node row carries data-kind / data-host (its ORIGIN host) / data-path / data-session / data-project / data-user, and ACT.rowInfo holds the same', nr.getAttribute('data-kind') === 'node' && nr.getAttribute('data-host') === 'HOST-A' && nr.getAttribute('data-path') === 'anode' && nr.getAttribute('data-session') === 'Sixc' && nr.getAttribute('data-project') === 'SixC' && nr.getAttribute('data-user') === 'robin'
  && nr.getAttribute('data-nkind') === 'agent' && V.rowInfo[nr.getAttribute('data-k')]?.path === 'anode' && inS('Sixc', '@open/@a').getAttribute('data-plan-item') === '1' && inS('Sixc', '@open').getAttribute('data-plan-node') === '1', nr.outerHTML.slice(0, 400))
check('6d hooks: session rows (data-kind session, its hosts + home), project rows and log entries (data-kind entry + data-id) are tagged too', sr.getAttribute('data-kind') === 'session' && sr.getAttribute('data-home') === 'HOST-B' && sr.getAttribute('data-hosts') === 'HOST-A,HOST-B' && rowOf(/📁 SixC/).getAttribute('data-kind') === 'project'
  && pRows().filter(r => r.getAttribute('data-kind') === 'entry').length > 0 && pRows().filter(r => r.getAttribute('data-kind') === 'entry').every(r => !!r.getAttribute('data-id')))
try {   // a crash (an older dashboard without the 6d view) counts as one failure
// ================================================================= 6d (v1.65.0): the right-click menu + actions, copies, pin / hide, the log panel, keyboard / touch,
// open ancestors, unfiltered counts, the 0 – 7 day slider, the viewport tag, the dark-mode abandoned glyph
const ids = items => items.filter(i => !i.sep).map(i => i.id)
check('6d menuFor: a plan ITEM (☐ todo) → Mark done · Skip · Abandon (no Reopen); copies; Pin / Hide', J(ids(X.menuFor({ kind: 'node', nkind: 'context', plan_item: true, item_state: 'todo' }))) === J(['done', 'skip', 'abandon', 'copy-path', 'pin', 'hide']))
check('6d menuFor: a ☑ done item → Skip · Reopen · Abandon; a skipped one → Mark done · Reopen · Abandon; an abandoned one → no Abandon', J(ids(X.menuFor({ kind: 'node', plan_item: true, item_state: 'done' })).slice(0, 3)) === J(['skip', 'reopen', 'abandon'])
  && J(ids(X.menuFor({ kind: 'node', plan_item: true, item_state: 'skipped' })).slice(0, 3)) === J(['done', 'reopen', 'abandon']) && !ids(X.menuFor({ kind: 'node', plan_item: true, item_state: 'abandoned' })).includes('abandon'))
check('6d menuFor: a PLAN node — open: Mark plan complete + Abandon plan… (confirmed); ended by "complete" / abandoned: Reopen plan; ended because ALL items are done: no plan action (reopen an item)', J(ids(X.menuFor({ kind: 'node', nkind: 'context', plan_node: true })).slice(0, 2)) === J(['complete', 'abandon_plan'])
  && X.menuFor({ kind: 'node', plan_node: true }).find(i => i.id === 'abandon_plan').confirm === true && J(ids(X.menuFor({ kind: 'node', plan_node: true, plan_end_how: 'done' })).slice(0, 1)) === J(['reopen_plan'])
  && J(ids(X.menuFor({ kind: 'node', plan_node: true, plan_end_how: 'abandoned' })).slice(0, 1)) === J(['reopen_plan']) && !X.menuFor({ kind: 'node', plan_node: true, plan_end_how: 'all-done' }).some(i => i.act))
check('6d menuFor: an AGENT that is stale and holds an open plan → Abandon open plan items… + Mark finished done / failed (all confirmed), NO Dismiss (open items); a finished one without plans → Dismiss… only; a fresh one → no action',
  J(ids(X.menuFor({ kind: 'node', nkind: 'agent', agent_ok: true, owns_open: true, quiet: true, subtree_quiet: true, holds_open: true })).slice(0, 3)) === J(['abandon_plan', 'finish-done', 'finish-failed'])
  && X.menuFor({ kind: 'node', agent_ok: true, owns_open: true, quiet: true, holds_open: true }).filter(i => i.act).every(i => i.confirm) && X.menuFor({ kind: 'node', agent_ok: true, quiet: true }).find(i => i.id === 'finish-failed').args.state === 'failed'
  && J(ids(X.menuFor({ kind: 'node', nkind: 'agent', agent_ok: true, quiet: true, finished: true, subtree_quiet: true })).slice(0, 1)) === J(['dismiss']) && !X.menuFor({ kind: 'node', agent_ok: true }).some(i => i.act)
  && !X.menuFor({ kind: 'node', agent_ok: true, quiet: true, finished: true, subtree_quiet: false }).some(i => i.id === 'dismiss'))
check('6d menuFor: a log ENTRY → Copy entry id (+ Copy path); a session → Copy session name (+ the command when known); a host line → no Pin / Hide; a project row → nothing', J(ids(X.menuFor({ kind: 'entry', has_path: true }))) === J(['copy-id', 'copy-path'])
  && ids(X.menuFor({ kind: 'session', has_cmd: true })).includes('copy-session') && ids(X.menuFor({ kind: 'session', has_cmd: true })).includes('copy-cmd') && !ids(X.menuFor({ kind: 'session', no_view: true })).includes('pin') && X.menuFor({ kind: 'project' }).length === 0)
const LC = { node: 'C:/Program Files/nodejs/node.exe', script: 'D:/AIMB/src/tools/aimb-log.mjs', token_file: 'C:/Users/robin/.aimb/realm token.txt' }
check('6d logCmd: the session\'s {log_snippet} command — quoted absolute node + script paths, --session / --project, the token FILE path (never a token), --path for a node, the text placeholder',
  X.logCmd(LC, 'Sixd', 'SixD', 'lead/@x') === '"C:/Program Files/nodejs/node.exe" "D:/AIMB/src/tools/aimb-log.mjs" --session "Sixd" --project "SixD" --token-file "C:/Users/robin/.aimb/realm token.txt" --path "lead/@x" "<text>"'
  && X.logCmd({ node: '/usr/bin/node', script: '/opt/t/aimb-log.mjs' }, 'S', 'P', null) === '"/usr/bin/node" "/opt/t/aimb-log.mjs" --session "S" --project "P" "<text>"' && X.logCmd(null, 'S', 'P') === null, X.logCmd(LC, 'Sixd', 'SixD', 'lead/@x'))
check('6d slider: "plans open" spans 0 – 7 days in steps (minutes → hours → days); its value is an index; the bridge clamp (0..10080) matches', X.PLAN_OPEN_STEPS[0] === 0 && X.PLAN_OPEN_STEPS.at(-1) === 10080 && X.PLAN_OPEN_STEPS.includes(120) && X.PLAN_OPEN_STEPS.includes(1440)
  && X.PLAN_OPEN_STEPS.every((v, i, a) => !i || v > a[i - 1]) && X.planOpenValue(X.planOpenIndex(120)) === 120 && X.planOpenValue(999) === 10080 && doc.getElementById('actPlanOpen').max === String(X.PLAN_OPEN_STEPS.length - 1))
const po6 = doc.getElementById('actPlanOpen'); po6.value = po6.max; po6.dispatchEvent(new win.Event('input'))
check('6d slider: at its top the label says 7d (live, not persisted)', /^7d/.test(doc.getElementById('actPlanOpenV').textContent), doc.getElementById('actPlanOpenV').textContent)
po6.value = String(X.planOpenIndex(120)); po6.dispatchEvent(new win.Event('input'))
check('6d page: a viewport meta tag (the narrow layout really applies on a phone)', /width=device-width/.test(doc.querySelector('meta[name="viewport"]')?.getAttribute('content') || ''))
const css7 = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n')
const darkTok = n => (css7.match(new RegExp(':root\\[data-theme="dark"\\][^}]*--' + n + ':(#[0-9A-Fa-f]{6})')) || [])[1]
check('6d dark mode: the abandoned glyph has its own token, clearly lighter than the faint grey (#6B7280) in dark mode', !!darkTok('abandon') && darkTok('abandon') !== darkTok('faint') && parseInt(darkTok('abandon').slice(1, 3), 16) > 0xA0 && /\.s-abandoned \{ color:var\(--abandon\); \}/.test(css7), J([darkTok('abandon'), darkTok('faint')]))
check('6d layout: the log panel sits beside the tree, below it (full width) under 900px; the phone rules come LAST so their bar / name widths apply (CSS)', /\.act-main \{ display:flex;/.test(css7) && /@media \(max-width: 900px\) \{ \.act-main \{ flex-direction:column; align-items:stretch; \}/.test(css7) && /@media \(max-width: 720px\) \{[^}]*\}[^}]*\.ar \.pb \{ width:56px; \}/.test(css7.slice(css7.lastIndexOf('.act-toast'))))
// ---- the 6d fixture: a session with a stale lead holding an open plan, an agent holding a plan under a context (ancestors), a finished agent, a fresh one, plans ended both ways; a remote node
const st6 = (p, extra = {}) => node('k-sixd', p, p.split('/').at(-1).startsWith('@') ? 'context' : 'agent', 'HOST-A', extra)
const pi7 = (p, stt, extra = {}) => pi('k-sixd', p, 'HOST-A', stt, extra)
const selfD = root('HOST-A', { current: { id: 'sd', ts: NOW - MIN, text: 'orchestrating 6d', state: 'running' } })
const sixd = [
  sess('k-sixd', 'Sixd', 'SixD', { host: 'HOST-A', self: selfD }),
  st6('lead', { plan_node: true, last_activity: NOW - 40 * MIN, current: { id: 'ld', ts: NOW - 40 * MIN, text: 'leading', state: 'running' } }), pi7('lead/@x', 'todo'), pi7('lead/@y', 'done'),
  st6('@grp', { implicit: true }), st6('@grp/deep', { plan_node: true, current: { id: 'dp2', ts: NOW - MIN, text: 'deep agent', state: 'running' } }), pi7('@grp/deep/@p1', 'todo'),
  st6('done1', { state: 'done', active: false, finished_at: NOW - 10 * MIN, current: { id: 'd1x', ts: NOW - 10 * MIN, text: 'finished', state: 'done' } }),
  st6('fresh', { current: { id: 'fr', ts: NOW - MIN, text: 'fresh work', state: 'running' } }),
  st6('@alldone', { implicit: true, plan_node: true, plan_end_at: NOW - 5 * MIN, plan_end_how: 'all-done' }), pi7('@alldone/@a', 'done'),
  st6('@cmpl', { plan_node: true, plan_end_at: NOW - 5 * MIN, plan_end_how: 'done', current: { id: 'cp', ts: NOW - 5 * MIN, text: 'cmpl', state: 'done' } }), pi7('@cmpl/@open', 'todo'),
  node('k-sixd', 'rem', 'agent', 'HOST-C', { last_activity: NOW - 50 * MIN, current: { id: 'rm', ts: NOW - 50 * MIN, text: 'remote work', state: 'running' }, log: { remote: true, total: 3 } }),
]
const head6 = { host: 'HOST-A', now: NOW, stale_after_min: 15, finished_plan_open_min: 120, user: 'robin', log_cmd: LC, remote_hosts: [{ host: 'HOST-C', log_cmd: { node: '/usr/bin/node', script: '/opt/aimb/tools/aimb-log.mjs', token_file: null } }] }
recv({ type: 'activity_board', full: true, epoch: 'E6', seq: 1, head: head6, upsert: [...units, ...plan, ...six, ...sixd] })
const inD = p => inS('Sixd', p)
check('6d open ancestors: an open plan under a COLLAPSED-by-default context expands its ancestors — @grp opens, its agent shows, and the agent\'s plan item too, without a click', !!inD('@grp') && !!inD('@grp/deep') && !!inD('@grp/deep/@p1') && inD('@grp').getAttribute('aria-expanded') === 'true')
check('6d open ancestors: X.nodeOpenDefault — a node holding part of an open plan (t.open) is open by default; one that doesn\'t is not', X.nodeOpenDefault({ open: true, planNode: false, u: {} }, NOW, 120) && !X.nodeOpenDefault({ open: false, planNode: false, u: {} }, NOW, 120))
check('6d rows are FOCUSABLE: every session / node row has tabindex 0 and role treeitem (projects too); the tree is role tree', rowsT().filter(r => ['node', 'session'].includes(r.getAttribute('data-kind'))).every(r => r.getAttribute('tabindex') === '0' && r.getAttribute('role') === 'treeitem') && T.getAttribute('role') === 'tree')
// header counts ignore the filters
const tagT = () => doc.getElementById('acttag').textContent, projCnt = () => rowOf(/📁 SixD/)?.querySelector('.cnt')?.textContent
const t0 = tagT(), c0 = projCnt()
const pf6 = doc.getElementById('actPlans'), ao6 = doc.getElementById('actActive')
pf6.checked = true; pf6.dispatchEvent(new win.Event('change'))
const t1 = tagT(), c1 = projCnt()
ao6.checked = true; ao6.dispatchEvent(new win.Event('change'))
const t2 = tagT()
pf6.checked = false; pf6.dispatchEvent(new win.Event('change')); ao6.checked = false; ao6.dispatchEvent(new win.Event('change'))
check('6d counts: the header and the project counts IGNORE the filters (Plans, Active only) — always the real totals', t0 === t1 && t1 === t2 && c0 === c1 && /active agents?/.test(t0) && /4 active agents/.test(c0 || ''), J([t0, t1, t2, c0, c1]))
// ---- the menu, opened by a right-click
const menuEl = () => doc.querySelector('.act-menu')
const menuLabels = () => [...(menuEl()?.querySelectorAll('.mi') || [])].map(b => b.textContent)
const rclick = el => el.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
const pickMenu = label => { const b = [...(menuEl()?.querySelectorAll('.mi') || [])].find(x => x.textContent === label); if (b) click(b); return !!b }
const leadRow = inD('lead')
rclick(leadRow)
check('6d menu (right-click): a STALE agent holding an open plan (itself a plan node) — Mark plan complete, Abandon plan…, Mark finished done / failed, no Dismiss (open items); (#83 / #84: then Edit text… + Message session…; #82: then Move down + Move to…); then Copy path, Copy its aimb-log command, Pin, Hide', !!menuEl() && J(menuLabels()) === J(['Mark plan complete', 'Abandon plan…', 'Mark finished — done…', 'Mark finished — failed…', 'Edit text…', 'Message session…', 'Move down', 'Move to…', 'Copy path', 'Copy its aimb-log command', 'Pin to the top', 'Hide']), J(menuLabels()))
check('6d menu: it is a role=menu of menuitems with the first one focused', menuEl().getAttribute('role') === 'menu' && [...menuEl().querySelectorAll('.mi')].every(b => b.getAttribute('role') === 'menuitem') && doc.activeElement === menuEl().querySelector('.mi'))
pickMenu('Copy its aimb-log command')
check('6d copy: "Copy its aimb-log command" = the session\'s command for THIS node on ITS host — the token FILE path, never a token; the menu closes', V.lastCopy === X.logCmd(LC, 'Sixd', 'SixD', 'lead') && /--token-file "C:\/Users\/robin\/\.aimb\/realm token\.txt"/.test(V.lastCopy) && !/token=|--token /.test(V.lastCopy) && !menuEl(), V.lastCopy)
rclick(inD('lead')); pickMenu('Copy path')
check('6d copy: "Copy path" = the node\'s path', V.lastCopy === 'lead')
rclick(inD('rem')); pickMenu('Copy its aimb-log command')
check('6d copy: a REMOTE node\'s command uses ITS host\'s paths (from the board\'s remote_hosts) — no --token-file when that host has none', V.lastCopy === '"/usr/bin/node" "/opt/aimb/tools/aimb-log.mjs" --session "Sixd" --project "SixD" --path "rem" "<text>"', V.lastCopy)
rclick(nmRow('Sixd')); const sessLabels = menuLabels(); pickMenu('Copy session name')
check('6d menu: the SESSION row (fresh) — copies + Pin / Hide, no finish / dismiss; "Copy session name"', V.lastCopy === 'Sixd' && !sessLabels.some(l => /finished|Dismiss/.test(l)) && sessLabels.includes('Copy its aimb-log command'), J(sessLabels))
rclick(inD('fresh')); const freshL = menuLabels(); doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
check('6d menu: a FRESH agent offers no action (only copies, Pin, Hide); Escape closes the menu', !freshL.some(l => /Mark|Abandon|Dismiss/.test(l)) && freshL.includes('Pin to the top') && !menuEl(), J(freshL))
rclick(inD('done1')); const doneL = menuLabels(); doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
check('6d menu: a FINISHED agent (no plans) → Dismiss from the board…, not Mark finished', doneL.includes('Dismiss from the board…') && !doneL.some(l => /Mark finished/.test(l)), J(doneL))
rclick(inD('lead/@x')); const itemL = menuLabels(); doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
rclick(inD('@alldone')); const adL = menuLabels(); doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
rclick(inD('@cmpl')); const cmL = menuLabels(); doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
check('6d menu (rendered rows): a ☐ item → Mark done / Skip / Abandon item; an all-done plan → no plan action; a plan marked complete → Reopen plan', J(itemL.slice(0, 3)) === J(['Mark done', 'Skip', 'Abandon item']) && !adL.some(l => /plan/.test(l)) && cmL[0] === 'Reopen plan', J([itemL, adL, cmL]))
// ---- an action: pending → ✓, the message the bridge gets, an error code inline
const nAct0 = sentOf('activity_action').length
rclick(inD('lead/@x')); pickMenu('Mark done')
const am = sentOf('activity_action').at(-1)
check('6d action: "Mark done" sends {type:"activity_action", host (the node\'s ORIGIN), session, project, user, path, action, args.stale_min (the slider)} — no confirmation for a tick', sentOf('activity_action').length === nAct0 + 1 && am.host === 'HOST-A' && am.session === 'Sixd' && am.project === 'SixD' && am.user === 'robin' && am.path === 'lead/@x' && am.action === 'done' && am.args.stale_min === 15 && !doc.querySelector('.act-dlg'), J(am))
check('6d feedback: the row shows a pending spinner while the bridge works', !!inD('lead/@x')?.querySelector('.fb.pending .spin'))
recv({ type: 'activity_action', ref: am.ref, result: { ok: true, host: 'HOST-A', action: 'done', path: 'lead/@x', applied: [{ path: 'lead/@x', state: 'done' }] } })
check('6d feedback: then ✓ marked done', /✓ marked done/.test(inD('lead/@x')?.querySelector('.fb.ok')?.textContent || ''), inD('lead/@x')?.innerHTML)
rclick(inD('lead/@y')); pickMenu('Skip')
const am2 = sentOf('activity_action').at(-1)
recv({ type: 'activity_action', ref: am2.ref, result: { ok: false, code: 'not-a-plan-item', host: 'HOST-A', what: 'not a plan item' } })
check('6d feedback: an error shows its CODE inline on the row (the what on hover)', inD('lead/@y')?.querySelector('.fb.err')?.textContent === '✗ not-a-plan-item' && inD('lead/@y').querySelector('.fb.err').getAttribute('title') === 'not a plan item')
// confirmations
const dlg = () => doc.querySelector('.act-dlg')
rclick(inD('lead')); pickMenu('Abandon plan…')
check('6d confirm: Abandon plan asks first (a modal dialog: how many open items, that the agent keeps running, how it is logged) and sends nothing yet', !!dlg() && dlg().querySelector('[role="dialog"]')?.getAttribute('aria-modal') === 'true' && /1 open item/.test(dlg().textContent) && /keeps running/.test(dlg().textContent)
  && /abandoned by robin via dashboard \(HOST-A\)/.test(dlg().textContent) && sentOf('activity_action').length === nAct0 + 2 && doc.activeElement === dlg().querySelector('[data-dlg="cancel"]'), dlg()?.textContent)
click(dlg().querySelector('[data-dlg="cancel"]'))
check('6d confirm: Cancel closes it — nothing sent', !dlg() && sentOf('activity_action').length === nAct0 + 2)
rclick(inD('lead')); pickMenu('Abandon plan…'); click(dlg().querySelector('[data-dlg="ok"]'))
check('6d confirm: OK sends abandon_plan for the agent', !dlg() && sentOf('activity_action').at(-1).action === 'abandon_plan' && sentOf('activity_action').at(-1).path === 'lead')
rclick(inD('lead')); pickMenu('Mark finished — failed…')
check('6d confirm: Mark finished asks first ("It is stale"), then sends finish with args.state', !!dlg() && /It is stale/.test(dlg().textContent) && /open plan items it holds stay open/.test(dlg().textContent) && (click(dlg().querySelector('[data-dlg="ok"]')), sentOf('activity_action').at(-1).action === 'finish' && sentOf('activity_action').at(-1).args.state === 'failed'))
rclick(inD('done1')); pickMenu('Dismiss from the board…')
const dtext = dlg()?.textContent || ''
doc.querySelector('.act-dlg').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
check('6d confirm: Dismiss asks first — it leaves the board now, nothing is deleted (the day files keep its history); Escape cancels', /leaves the board now/.test(dtext) && /Nothing is deleted/.test(dtext) && !dlg() && sentOf('activity_action').at(-1).action === 'finish', dtext)
rclick(inD('rem')); pickMenu('Mark finished — done…'); click(dlg().querySelector('[data-dlg="ok"]'))
const am5 = sentOf('activity_action').at(-1)
recv({ type: 'activity_queued', ref: am5.ref, wait_ms: 900, position: 2 })
check('6d action on ANOTHER host\'s node: sent with that host (the bridge forwards it to the owner); a queued forward shows on the row', am5.host === 'HOST-C' && am5.path === 'rem' && /queued/.test(inD('rem')?.querySelector('.fb.pending')?.textContent || ''), J(am5))
// ---- keyboard + touch
const fr = inD('fresh'); fr.focus()
fr.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }))
check('6d keyboard: the Menu key on a focused row opens its menu', !!menuEl() && menuLabels().includes('Pin to the top'))
doc.activeElement.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
const second = menuEl().querySelectorAll('.mi')[1]
check('6d keyboard: arrows move through the menu items', doc.activeElement === second)
doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
check('6d keyboard: Escape closes it and gives the focus back to the row', !menuEl() && doc.activeElement === inD('fresh'))
inD('fresh').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
check('6d keyboard: Shift+F10 opens it too', !!menuEl()); doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
inD('fresh').focus(); inD('fresh').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
check('6d keyboard: ArrowDown moves the focus to the next row', doc.activeElement !== inD('fresh') && doc.activeElement.getAttribute('tabindex') === '0' && !!doc.activeElement.closest('#acttree'))
inD('fresh').focus(); inD('fresh').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
check('6d keyboard: Enter selects the focused row (its log in the panel)', inD('fresh').classList.contains('sel') && sentOf('activity').at(-1).query.log.path === 'fresh')
const ts = new win.Event('touchstart', { bubbles: true }); Object.defineProperty(ts, 'touches', { value: [{ clientX: 30, clientY: 30 }] })
inD('done1').dispatchEvent(ts)
await new Promise(r => setTimeout(r, 650))
check('6d touch: a LONG-PRESS opens the row\'s menu', !!menuEl() && menuLabels().includes('Dismiss from the board…'))
click(inD('done1'))
check('6d touch: the click that ends the long-press does not select the row', !inD('done1').classList.contains('sel') && inD('fresh').classList.contains('sel'))
doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
// ---- the log panel: entries + their menu, the selection across deltas, cleared when the node goes
const fq = sentOf('activity').at(-1)
recv({ type: 'activity', ref: fq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'act_f-2', ts: NOW - MIN, path: 'fresh', rel: '', current: true, text: 'fresh work', rendered: 'fresh work', state: 'running' },
  { id: 'act_f-1', ts: NOW - 2 * MIN, path: 'fresh', rel: '', text: 'marked done by robin via dashboard (HOST-A)', rendered: 'marked done by robin via dashboard (HOST-A)', state: 'done', by: { kind: 'dashboard', user: 'robin', host: 'HOST-A' }, act: 'done' }], next_cursor: null } } })
const ent = pRows().find(r => r.getAttribute('data-id') === 'act_f-1')
check('6d panel (#87: oldest first): entries with time, state dot, relative tag, text — an action\'s entry reads "… by <user> via dashboard (<host>)"', !!ent && /marked done by robin via dashboard \(HOST-A\)/.test(ent.textContent) && pRows().at(-1).getAttribute('data-id') === 'act_f-2' && pRows()[0] === ent && ent.getAttribute('role') === 'listitem')
rclick(ent)
check('6d panel: a log entry\'s menu → Copy entry id / Copy path', J(menuLabels()) === J(['Copy entry id', 'Copy path']) && (pickMenu('Copy entry id'), V.lastCopy === 'act_f-1'), J(menuLabels()))
recv({ type: 'activity_delta', epoch: 'E6', seq: 2, base: 1, head: head6, upsert: [st6('fresh', { current: { id: 'fr2', ts: NOW, text: 'fresher work', state: 'running' } })], remove: [] })
check('6d selection: survives a board delta (the row still highlighted, the panel still open)', inD('fresh')?.classList.contains('sel') && !doc.getElementById('actmain').classList.contains('nosel') && inD('fresh').querySelector('.ln').textContent === 'fresher work' && V.sel?.path === 'fresh')
const freshId = sixd.find(u => u.path === 'fresh').id
recv({ type: 'activity_delta', epoch: 'E6', seq: 3, base: 2, head: head6, upsert: [], remove: [freshId] })
check('6d selection: cleared when its node leaves the board (the panel closes)', !V.sel && doc.getElementById('actmain').classList.contains('nosel') && !inD('fresh'))
recv({ type: 'activity_delta', epoch: 'E6', seq: 4, base: 3, head: head6, upsert: [sixd.find(u => u.path === 'fresh')], remove: [] })
click(inD('lead')); click(PANEL.querySelector('[data-pa="close"]'))
check('6d panel: its × clears the selection', !V.sel && doc.getElementById('actmain').classList.contains('nosel') && !inD('lead').classList.contains('sel'))
// ---- PIN / HIDE (this browser only)
const topOrder = () => rowsT().filter(r => r.getAttribute('data-session') === 'Sixd' && r.getAttribute('data-kind') === 'node' && dOf(r) === 2).map(r => r.getAttribute('data-path'))
const before6 = topOrder()
rclick(inD('fresh')); pickMenu('Pin to the top')
const pins = JSON.parse(win.localStorage.getItem('aimb.act.pins') || '[]')
check('6d pin: a pinned node sorts to the TOP of its parent, marked 📌, kept in localStorage', topOrder()[0] === 'fresh' && before6[0] !== 'fresh' && !!inD('fresh').querySelector('.pin') && pins.includes(freshId), J([before6, topOrder()]))
rclick(inD('fresh')); const pinL = menuLabels(); pickMenu('Unpin')
check('6d pin: reversible from the menu (Unpin) — back to creation order', pinL.includes('Unpin') && J(topOrder()) === J(before6) && !JSON.parse(win.localStorage.getItem('aimb.act.pins')).includes(freshId))
const done1Id = sixd.find(u => u.path === 'done1').id
rclick(inD('done1')); pickMenu('Hide')
const hidRow = () => rowsT().find(r => /hidden — show/.test(r.textContent) && dOf(r) === 2)
check('6d hide: a hidden node collapses away, with a small "1 hidden — show" control under its parent; kept in localStorage', !inD('done1') && !!hidRow() && /^1 hidden — show$/.test(hidRow().textContent) && JSON.parse(win.localStorage.getItem('aimb.act.hidden')).includes(done1Id))
click(hidRow())
check('6d hide: "show" reveals it (greyed, class hid) with a "hide 1 again" control', inD('done1')?.classList.contains('hid') && rowsT().some(r => /hide 1 again/.test(r.textContent)))
rclick(inD('done1')); const hidL = menuLabels(); pickMenu('Unhide')
check('6d hide: reversible from the menu (Unhide)', hidL.includes('Unhide') && !inD('done1').classList.contains('hid') && !JSON.parse(win.localStorage.getItem('aimb.act.hidden')).includes(done1Id) && !rowsT().some(r => /hidden — show|again/.test(r.textContent)))
check('6d counts: pin / hide never change the header counts', tagT() === t0, J([tagT(), t0]))
} catch (e) { fail++; console.log('FAIL 6d block crashed:', (e && e.stack) || e) }
} catch (e) { fail++; console.log('FAIL 6c block crashed:', (e && e.stack) || e) }
} catch (e) { fail++; console.log('FAIL 6b block crashed:', (e && e.message) || e) }

try {   // a crash (a dashboard without the #79 helpers) counts as one failure
// ================================================================= #79 (v1.66.0): THREE-PART bars (done / skipped / total), a done node = 100%,
// the 1.65 bar form widened, and the client rollup == the bridge's (the same fixture through lib/activity.js and through this page)
const A = await import('../../lib/activity.js')
check('#79 render: {progress} → "1 of 5 done · 1 skipped"; unchanged without skipped; {pct} = the done %; {skipped}; a % bar', X.renderText('{progress}|{pct}|{skipped}', { done: 1, skipped: 1, total: 5, unit: 'done' }, null, NOW) === '1 of 5 done · 1 skipped|20%|1'
  && X.renderText('{progress}|{skipped}', P, null, NOW) === '4,812 of 12,000 tiles|0' && X.renderText('{progress}', { done: 37.5, skipped: 12.5, total: 100, unit: '%' }, null, NOW) === '37.5% · 12.5% skipped'
  && ['1 of 5 done · 1 skipped', '4,812 of 12,000 tiles', '37.5% · 12.5% skipped'].every((t, i) => A.renderText('{progress}', [{ done: 1, skipped: 1, total: 5, unit: 'done' }, P, { done: 37.5, skipped: 12.5, total: 100, unit: '%' }][i], null, NOW) === t))
check('#79 norm3: a bar without skipped (a 1.65 bridge, any old progress) has skipped 0; a 1.65 "N of M" bar (skipped OUT of M, abandoned in M) is widened: 1 of 2 · 1 skipped · 1 abandoned → 1 of 3 · 2 skipped', (q => q.skipped === 0 && q.total === 12000)(X.norm3(P))
  && (q => q.done === 1 && q.total === 3 && q.skipped === 2 && q.items === true)(X.norm3({ done: 1, total: 2, unit: 'done', rollup: true, todos: true, skipped: 1, n: 3, abandoned: 1 }))
  && (q => q.done === 2 && q.skipped === 1 && q.total === 6 && q.items === true && Math.abs(q.pct - 100 / 3) < 1e-9)(X.norm3({ done: 2, skipped: 1, total: 6, unit: 'done', pct: 33.3, rollup: true, todos: true, items: true, n: 6 }))
  && (q => q.total === 5 && q.skipped === 1)(X.norm3({ done: 2, skipped: 1, total: 5, unit: 'done', rollup: true, todos: true, n: 2 })))   // a 1.66 SUM of two plans is never mistaken for the 1.65 form
check('#79 force: a DONE node shows a FULL bar whatever its own / rolled-up bar says; ABANDONED → its remainder skipped; failed keeps its bar', (q => q.done === 10 && q.skipped === 0 && q.pct === 100 && q.forced === 'done')(X.barOf({ current: { state: 'done' }, bar: { done: 3, total: 10, unit: 'tiles', rollup: true, n: 2 } }))
  && (q => q.done === 1 && q.skipped === 3 && q.forced === 'abandoned')(X.barOf({ current: { state: 'abandoned' }, bar: { done: 1, skipped: 1, total: 4, unit: 'done', todos: true, items: true, n: 4 } }))
  && (q => q.done === 3 && !q.forced)(X.barOf({ current: { state: 'failed' }, progress: { done: 3, total: 10, unit: '' } })))
// the fixture, built by the BRIDGE's own library (what a 1.66 gateway sends)
const st79 = A.createActivity({ config: {}, origin: 'HOST-A' }), I79 = { session: 'Bars79', project: 'Bars79', user: 'robin', host: 'HOST-A' }, t79 = NOW - 20 * MIN
const say79 = (input, dt = 0) => { const p = A.parseMessage(input, { now: t79 + dt, tzOffsetMin: 0 }); if (!p.ok) throw new Error(`fixture: ${J(input)} → ${p.code} ${p.what}`); const r = A.apply(st79, I79, p.msg, t79 + dt); if (!r.ok) throw new Error(`fixture apply: ${J(input)} → ${r.code}`); return r }
say79({ text: '@~root bars for #79' })
say79({ path: '@~Release', text: 'release {progress}', plan: ['Spec', 'Docs', 'Port', 'Build', 'Ship'] }, 1000)
say79({ path: '@Release/@~Spec', state: 'done' }, 2000); say79({ path: '@Release/@~Docs', state: 'skipped' }, 3000); say79({ path: '@Release/@~Port', state: 'abandoned' }, 4000); say79({ path: '@Release/@~Build', text: 'compiling' }, 5000)
say79({ path: '@~Test plan', text: 'testing', plan: ['X', 'Y', 'Z'] }, 6000); say79({ path: '@"Test plan"/@~X', state: 'done' }, 7000); say79({ path: '@~Test plan', text: 'tests signed off', state: 'done' }, 8000)
say79({ path: '@Tiles/@~a', text: 'a', progress: '3/10 tiles' }, 9000); say79({ path: '@Tiles/@~b', text: 'b', progress: '5/10 tiles' }, 9500); say79({ path: '@~Tiles', text: 'tiles done', state: 'done' }, 10000)
say79({ path: 'worker/@sum/@~s1', text: 's1', progress: '3/10 tiles 1 skipped' }, 11000); say79({ path: 'worker/@sum/@~s2', text: 's2', progress: '2/10 tiles' }, 11500)
say79({ path: 'worker/@mixed/@~p', text: 'p', progress: '50%' }, 12000); say79({ path: 'worker/@mixed/@~q', text: 'q', progress: '2/8 files 2 skipped' }, 12500)
say79({ path: '@~aband', text: 'maybe later', plan: ['A', 'B'] }, 13000); say79({ path: '@aband/@~A', state: 'done' }, 13500); say79({ path: '@~aband', text: 'dropped', state: 'abandoned' }, 14000)
say79({ path: '@~Lint', text: 'lint', plan: ['L1', 'L2'] }, 15000); say79({ path: '@Lint/@~L1', text: 'broke', state: 'failed' }, 15500)
const U79 = Object.fromEntries([...A.dashUnits(A.boardView(st79, NOW, { raw: true })).values()].map(u => [u.obj.id, u.obj]))
const tree79 = X.buildTree(U79, {}).find(p => p.key === 'bars79').sessions[0]
const all79 = []; (function walk(l) { l.forEach(t => { all79.push(t); walk(t.kids) }) })(tree79.kids)
const cbar = t => { t.kids.forEach(cbar); t.cb = X.force(t.u, t.u.progress ? X.ownBar(t.u.progress) : X.rollKids(t.kids.map(k => ({ u: k.u, fbar: k.cb })))); return t.cb }
tree79.kids.forEach(cbar)
const same = (a, b) => (!a && !b) || (!!a && !!b && ['done', 'skipped', 'total', 'unit', 'forced', 'todos', 'items', 'abandoned'].every(k => (a[k] ?? null) === (b[k] ?? null)) && Math.abs((a.pct ?? 0) - (b.pct ?? 0)) < 1e-9)
const bridgeBar = p => A.rollup(A.getSession(st79, I79), A.getNode(st79, I79, p))
check('#79 client == bridge: the dashboard\'s own rollup (force + ownBar + rollKids, used when a filter is on) equals the bridge\'s bar for EVERY node of the fixture (plan items in every state, common + mixed units, done / abandoned overrides)',
  all79.length >= 20 && all79.every(t => same(t.cb, t.u.bar)) && all79.every(t => same(X.barOf(t.u), bridgeBar(t.u.path))), J(all79.filter(t => !same(t.cb, t.u.bar)).map(t => [t.u.path, t.cb, t.u.bar])))
const selfU = tree79.s.self, selfC = X.force(selfU, X.rollKids(tree79.kids.map(k => ({ u: k.u, fbar: k.cb }))))
check('#79 client == bridge: ... and for the session root (mixed units → the mean of the done and skipped fractions)', same(selfC, selfU.bar) && selfU.bar.unit === '%' && selfU.bar.skipped > 0, J([selfC, selfU.bar]))
const ft79 = X.buildTree(U79, { plansOnly: true }).find(p => p.key === 'bars79').sessions[0], fall = []; (function walk(l) { l.forEach(t => { fall.push(t); walk(t.kids) }) })(ft79.kids)
const nDesc = (list, id) => { const f = (l) => l.reduce((n, t) => n + 1 + f(t.kids), 0); const find = l => { for (const t of l) { if (t.u.id === id) return t; const x = find(t.kids); if (x) return x } return null }; const t = find(list); return t ? f(t.kids) : -1 }
const whole = fall.filter(t => nDesc(ft79.kids, t.u.id) === nDesc(tree79.kids, t.u.id))
check('#79 client == bridge (buildTree, Plans filter): every node whose subtree the filter left whole shows the bridge\'s bar — @Release 1 of 5 · 2 skipped, the done @Test plan full', whole.length >= 8 && whole.every(t => same(t.fbar, t.u.bar))
  && (b => b.done === 1 && b.skipped === 2 && b.total === 5 && b.abandoned === 1)(fall.find(t => t.u.path === '@Release').fbar) && (b => b.done === 3 && b.total === 3 && b.forced === 'done')(fall.find(t => t.u.path === '@"Test plan"').fbar), J(whole.filter(t => !same(t.fbar, t.u.bar)).map(t => [t.u.path, t.fbar, t.u.bar])))
// rendered
doc.getElementById('actPlans').checked = false; doc.getElementById('actPlans').dispatchEvent(new win.Event('change'))
ao.checked = false; ao.dispatchEvent(new win.Event('change'))
recv({ type: 'activity_board', full: true, epoch: 'E79', seq: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15, finished_plan_open_min: 120, user: 'robin', remote_hosts: [] }, upsert: Object.values(U79) })
const tipOf = el => { el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); return el.getAttribute('title') }
const r79 = p => { const rs = rowsT(), i = rs.indexOf(nmRow('Bars79')); if (i < 0) return null; for (let j = i + 1; j < rs.length && dOf(rs[j]) > 1; j++) if (rs[j].querySelector('.nm')?.getAttribute('title') === p) return rs[j]; return null }, pb79 = p => r79(p)?.querySelector('.pb'), wI = p => pb79(p)?.querySelector(':scope > i')?.style.width, wS = p => pb79(p)?.querySelector(':scope > b.sk')?.style.width ?? null
check('#79 bar: a plan with done, skipped, abandoned, running and todo items draws THREE parts — done 20% (green, class plan), then a skipped segment 40% (b.sk; skipped + abandoned), then the track',
  pb79('@Release')?.classList.contains('plan') && pb79('@Release').classList.contains('sk2') && wI('@Release') === '20%' && wS('@Release') === '40%' && [...pb79('@Release').children].map(c => c.tagName).join() === 'I,B', pb79('@Release')?.outerHTML)
check('#79 label: the plan line renders "release 1 of 5 done · 2 skipped"; the bar tooltip "1 of 5 done · 2 skipped (20%) · incl. 1 abandoned — its plan: 5 items"', r79('@Release').querySelector('.ln').textContent === 'release 1 of 5 done · 2 skipped' && tipOf(pb79('@Release')) === '1 of 5 done · 2 skipped (20%) · incl. 1 abandoned — its plan: 5 items', J([r79('@Release')?.querySelector('.ln')?.textContent, tipOf(pb79('@Release'))]))
check('#79 done = full: the done plan (1 of 3 items done) and the done context whose children roll up 8 of 20 tiles both show a FULL bar (no skipped segment); striped stays the rollup marker',
  wI('@"Test plan"') === '100%' && wS('@"Test plan"') === null && pb79('@"Test plan"').classList.contains('full') && wI('@Tiles') === '100%' && pb79('@Tiles').classList.contains('roll') && pb79('@Tiles').classList.contains('full') && /20 of 20 tiles \(100%\) · done: counts as 100% — rollup of 2 below it/.test(tipOf(pb79('@Tiles'))), J([wI('@"Test plan"'), wI('@Tiles'), tipOf(pb79('@Tiles'))]))
tog(r79('worker'))
check('#79 bar: common unit sums skipped (5 of 20 tiles · 1 skipped: 25% + 5%); mixed units average it (37.5% + 12.5%); an abandoned plan\'s remainder is skipped; a failed item is remaining (no skipped segment)', wI('worker/@sum') === '25%' && wS('worker/@sum') === '5%' && wI('worker/@mixed') === '37.5%' && wS('worker/@mixed') === '12.5%'
  && wI('@aband') === '50%' && wS('@aband') === '50%' && wI('@Lint') === '0%' && wS('@Lint') === null, J(['worker/@sum', 'worker/@mixed', '@aband', '@Lint'].map(p => [p, wI(p), wS(p)])))
const css79 = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n'), tok = (blk, k) => (blk.match(new RegExp(`--${k}:(#[0-9A-Fa-f]{6})`)) || [])[1]
const blocks79 = [css79.match(/:root \{[^}]*\}/)?.[0] || '', css79.match(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{[^}]*\}/)?.[0] || '', css79.match(/:root\[data-theme="dark"\] \{[^}]*\}/)?.[0] || '']
check('#79 CSS: the skipped segment is a hatch of its own tokens (light, dark, dark forced), neutral — never the plan green (--ok) nor the bar blue', /\.ar \.pb > b\.sk \{[^}]*repeating-linear-gradient\([^)]*var\(--bar-skip\)[^)]*var\(--bar-skip-2\)/.test(css79)
  && blocks79.every(b => tok(b, 'bar-skip') && tok(b, 'bar-skip-2') && tok(b, 'bar-skip') !== tok(b, 'ok') && tok(b, 'bar-skip') !== tok(b, 'bar')) && tok(blocks79[0], 'bar-skip') !== tok(blocks79[1], 'bar-skip') && tok(blocks79[1], 'bar-skip') === tok(blocks79[2], 'bar-skip'), J(blocks79.map(b => [tok(b, 'bar-skip'), tok(b, 'bar-skip-2'), tok(b, 'ok')])))
// ---- #79 (v1.66.0): GREEN = DONE ONLY (in progress is cyan: one token per theme), and SESSIONS get their own glyph
check('#79 colours: in progress is CYAN everywhere (the running ring / dot, a context\'s running mark, the in-progress plan item, a running log dot) through ONE token, --act-running; done stays green (--ok); the cyan differs from the green and the bar blue in light and dark',
  /\.s-running \{ color:var\(--act-running\); \}/.test(css79) && /\.bg-running \{ background:var\(--act-running\) !important; \}/.test(css79) && /\.bg-done \{ background:var\(--ok\) !important; \}/.test(css79) && /\.s-done \{ color:var\(--ok\); \}/.test(css79)
  && blocks79.every(b => tok(b, 'act-running') && tok(b, 'act-running') !== tok(b, 'ok') && tok(b, 'act-running') !== tok(b, 'bar')) && tok(blocks79[0], 'act-running') !== tok(blocks79[1], 'act-running')
  && /class="gl ctx s-running"/.test(X.planGlyph('running')) && /s-running/.test(X.glyphSvg({ state: 'running', live: true, staleAt: NOW + 5 * MIN, win: 10 * MIN }, NOW)) && /s-done/.test(X.planGlyph('done')), J(blocks79.map(b => [tok(b, 'act-running'), tok(b, 'ok'), tok(b, 'bar')])))
const SG = (k, e, o) => X.sessGlyph(k, e, NOW, o)
const liveE = { state: 'running', live: true, staleAt: NOW + 6 * MIN, win: 10 * MIN }
check('#79 sessGlyph: a rounded WINDOW (rect), never the agent ring (circle); the face by client kind — code ">_", cowork a speech bubble, page / browser a globe, unknown / other a plain window; four distinct faces',
  ['code', 'cowork', 'page', 'other'].every(k => (g => /<rect /.test(g) && !/<circle class="ring"/.test(g) && new RegExp(`class="gl sg k-${k} `).test(g))(SG(k, liveE))) && X.sessKind('browser') === 'page' && X.sessKind(null) === 'other' && X.sessKind('agent') === 'other'
  && new Set(['code', 'cowork', 'page', 'other'].map(k => SG(k, { state: 'done' }).replace(/k-\w+/, ''))).size === 4)
check('#79 sessGlyph: live → the border EMPTIES towards stale like the ring (rect.ring, pathLength 100, data-sa / data-win, 60 of 100 left); done green / blocked / failed / stale / gone by class (gone dashed); no line → faint',
  (g => /<rect class="ring"[^>]*pathLength="100"[^>]*stroke-dasharray="60\.00 100"[^>]*data-sa="\d+"[^>]*data-win="600000"/.test(g) && /s-running/.test(g))(SG('code', liveE))
  && ['done', 'blocked', 'failed', 'stale'].every(st => new RegExp(`s-${st}`).test(SG('code', { state: st })) && !/class="ring"/.test(SG('code', { state: st }))) && /stroke-dasharray="2\.2 2\.2"/.test(SG('cowork', { state: 'gone', gone: true }))
  && /s-none/.test(SG('code', liveE, { none: true })) && /var\(--faint\)/.test(SG('code', liveE, { none: true })), SG('code', liveE))
// the Activity tree: session rows + host lines use the session glyph (with the bridge's client_kind); agents keep the ring
const U79k = Object.fromEntries(Object.entries(U79).map(([id, u]) => [id, u.kind === 'session' ? { ...u, client_kind: 'code' } : u]))
const mselfA = root('HOST-A', { current: { id: 'mA', ts: NOW - MIN, text: 'from A', state: 'running' }, last_activity: NOW - MIN }), mselfB = root('HOST-B', { current: { id: 'mB', ts: NOW - 30 * MIN, text: 'from B', state: 'running' }, last_activity: NOW - 30 * MIN })
const multi79 = [sess('k-m79', 'Multi79', 'Bars79', { hosts: ['HOST-A', 'HOST-B'], multi_host: true, client_kind: 'cowork', self: mselfA, selves: [mselfA, mselfB] })]
recv({ type: 'activity_board', full: true, epoch: 'E79b', seq: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15, finished_plan_open_min: 120, user: 'robin', remote_hosts: [] }, upsert: [...Object.values(U79k), ...multi79] })
const sRow = nmRow('Bars79'), mRow = nmRow('Multi79')
tog(r79('worker'))
check('#79 tree: a SESSION row shows the session glyph (a window; client kind code → ">_"; this one is quiet → stale, grey); an AGENT row keeps the ring glyph (a circle)', !!sRow?.querySelector('svg.sg.k-code.s-stale rect') && !sRow.querySelector('svg.sg circle')
  && !!r79('worker')?.querySelector('svg.gl circle') && !r79('worker').querySelector('svg.sg'), J([sRow?.innerHTML.slice(0, 300), r79('worker')?.innerHTML.slice(0, 200)]))
tog(mRow)
const hl79 = rowsT().filter(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Multi79')
check('#79 tree: a multi-host session (cowork) — its row AND each host line use the same session glyph (speech bubble); B\'s quiet line shows stale (grey, no countdown)', !!mRow?.querySelector('svg.sg.k-cowork') && hl79.length === 2 && hl79.every(r => !!r.querySelector('svg.sg.k-cowork'))
  && !!hl79.find(r => r.getAttribute('data-host') === 'HOST-B')?.querySelector('svg.sg.s-stale') && !!hl79.find(r => r.getAttribute('data-host') === 'HOST-A')?.querySelector('svg.sg.s-running rect.ring'), J(hl79.map(r => r.querySelector('svg')?.getAttribute('class'))))
const lgd = doc.getElementById('actlegend')
check('#79 legend: the session glyph in its four variants (code · cowork · page · other) + "green = done only, cyan = in progress" + the skipped hatch', lgd.querySelectorAll('svg.sg').length === 4 && ['k-code', 'k-cowork', 'k-page', 'k-other'].every(k => !!lgd.querySelector(`svg.sg.${k}`))
  && /session: code · cowork · page · other/.test(lgd.textContent) && /green = done only, cyan = in progress/.test(lgd.textContent) && !!lgd.querySelector('.pb b.sk') && /grey hatch = skipped/.test(lgd.textContent))
// the Sessions section + the mesh map: the SAME builder (live roster entries = in progress)
recv({ type: 'roster', gateway: 'HOST-A/gw1', hosts: {}, sessions: [
  { session: 'HOST-A/gw1', name: 'gw1', is_gateway: true, client_kind: 'host', realm: 'default', subpeers: [{ id: 'HOST-A/gw1/Orch-1', name: 'Orch', client_kind: 'code', project: 'AIMB', user: 'robin', realm: 'default' }, { id: 'HOST-A/gw1/Cow-1', name: 'Cow', client_kind: 'cowork', project: 'AIMB', user: 'robin', realm: 'default' }], topics: [] },
  { session: 'HOST-A/c1', name: 'c1', client_kind: 'code', project: 'AIMB', user: 'robin', realm: 'default', subpeers: [], topics: [] }],
  pages: [{ instance: 'p79', page_kind: 'chat', title: 'Chat79', project: 'AIMB', user: 'robin', host_label: 'HOST-A' }] })
const sTb = doc.getElementById('sessions'), sgIn = sTb.querySelectorAll('svg.sg.inl')
check('#79 Sessions section: each sub-peer / session / page row carries the SAME session glyph (code ">_", cowork bubble, page globe) — byte-identical to the builder\'s output', sgIn.length >= 3 && !!sTb.querySelector('svg.sg.k-code') && !!sTb.querySelector('svg.sg.k-cowork') && !!sTb.querySelector('svg.sg.k-page')
  && [...sgIn].some(g => g.outerHTML === (() => { const d = doc.createElement('div'); d.innerHTML = X.sessGlyph('code', { state: 'running' }, 0, { cls: 'inl' }); return d.firstChild.outerHTML })()), J([...sgIn].map(g => g.getAttribute('class'))))
const mapG = doc.querySelectorAll('g.n-glyph svg.sg')
check('#79 mesh map: session / sub-peer nodes carry the same glyph at their centre (none on the gateway, which keeps its GATEWAY tag)', mapG.length >= 3 && [...mapG].some(g => g.classList.contains('k-code')) && [...mapG].some(g => g.classList.contains('k-cowork')) && !doc.querySelector('g.n-sess.gw g.n-glyph'), J([...mapG].map(g => g.getAttribute('class'))))
} catch (e) { fail++; console.log('FAIL #79 block crashed:', (e && e.stack) || e) }

try {   // ================================================================= #82 (v1.69.0): ORDER by rank, the agent on its item, greyed abandoned
  // subtrees, Move up / down / to… (a picker + a confirm), Abandon… on any context, drag and drop
  const n82 = (p, nk, extra = {}) => node('k-p82', p, nk, extra.host || 'HOST-A', extra)
  const i82 = (p, rank, st = 'todo', extra = {}) => node('k-p82', p, 'context', 'HOST-A', { plan_item: true, state: st, rank, current: { id: `c-${p}`, ts: NOW - MIN, text: p.split('/').at(-1).replace(/^@/, ''), state: st }, ...extra })
  const self82 = root('HOST-A', { current: { id: 's82', ts: NOW - MIN, text: 'planning', state: 'running' } })
  const u82 = [
    sess('k-p82', 'Plan82', 'P82', { host: 'HOST-A', self: self82 }),
    n82('@Next', 'context', { plan_node: true, implicit: true }),
    i82('@Next/@A', '0m5'), i82('@Next/@B', '0m3'), i82('@Next/@C', '0m7'),
    n82('@Next/@notes', 'context', { created_at: NOW - 3 * 60 * MIN, current: { id: 'nt', ts: NOW - MIN, text: 'some notes', state: 'running' } }),
    n82('@Next/helper', 'agent', { created_at: NOW - 4 * 60 * MIN, current: { id: 'hp', ts: NOW - MIN, text: 'helping', state: 'running' } }),
    n82('@Next/@A/builder', 'agent', { last_activity: NOW - MIN, current: { id: 'bd', ts: NOW - MIN, text: 'compiling the docs', state: 'running' } }),
    n82('@Next/@A/old-agent', 'agent', { last_activity: NOW - 30 * MIN, finished_at: NOW - 20 * MIN, state: 'done', current: { id: 'oa', ts: NOW - 20 * MIN, text: 'earlier pass', state: 'done' } }),
    n82('@Old', 'context', { current: { id: 'od', ts: NOW - MIN, text: 'dropped', state: 'abandoned' } }),
    n82('@Old/@k', 'context', { current: { id: 'ok', ts: NOW - MIN, text: 'was underway', state: 'running' } }),
    n82('@Old/@k/w', 'agent', { current: { id: 'ow', ts: NOW - MIN, text: 'still going', state: 'running' } }),
    n82('rem82', 'agent', { host: 'HOST-C', current: { id: 'rm2', ts: NOW - MIN, text: 'on C', state: 'running' }, log: { remote: true, total: 1 } }),
  ]
  const head82 = { host: 'HOST-A', now: NOW, stale_after_min: 15, finished_plan_open_min: 120, user: 'robin', log_cmd: null, remote_hosts: [{ host: 'HOST-C' }] }
  recv({ type: 'activity_board', full: true, epoch: 'E82', seq: 1, head: head82, upsert: u82 })
  const U82 = Object.fromEntries(u82.map(u => [u.id, u]))
  const tr82 = X.buildTree(U82, {})[0].sessions.find(x => x.s.session === 'Plan82'), f82 = (l, p) => { for (const t of l) { if (t.u.path === p) return t; const r = f82(t.kids, p); if (r) return r } return null }
  const next = f82(tr82.kids, '@Next')
  // ---- the pure part
  check('#82 rankOf: a stored rank wins; else DERIVED from created_at (+ the plan position) — the same string as lib/activity.js derivedRank', X.rankOf({ rank: '0m5', created_at: 5 }) === '0m5' && X.rankOf({ created_at: 1790748000000, plan_item: true, plan_ix: 2 }) === Number(1790748000000).toString(36).padStart(9, '0') + '03i'
    && X.rankOf({ created_at: 1790748000000 }).endsWith('00i'))
  check('#82 order: plan items first (by rank: B A C), then the other contexts, then agents — whatever the creation order', J(next.kids.map(t => t.u.name)) === J(['B', 'A', 'C', 'notes', 'helper']), J(next.kids.map(t => t.u.name)))
  const stA = X.moveSteps(f82(tr82.kids, '@Next/@A'), next.kids), stB = X.moveSteps(f82(tr82.kids, '@Next/@B'), next.kids), stC = X.moveSteps(f82(tr82.kids, '@Next/@C'), next.kids)
  check('#82 moveSteps: Move up = before the previous of its OWN kind, Move down = after the next; none at the ends (C is the last plan item, notes a context)', J(stA) === J({ up: { before: '@"B"' }, down: { after: '@"C"' } }) && stB.up === null && stC.down === null
    && J(X.moveSteps(f82(tr82.kids, '@Next/helper'), next.kids)) === J({ up: null, down: null }), J([stA, stB, stC]))
  const tC = f82(tr82.kids, '@Next/@C'), tOld = f82(tr82.kids, '@Old'), tK = f82(tr82.kids, '@Old/@k')
  check('#82 canMoveInto: not into itself / below itself, not where it already is, not onto another host, not the depth limit; a name clash (target-exists) refused',
    X.canMoveInto(tC, tOld) && !X.canMoveInto(tC, next) && !X.canMoveInto(tOld, tK) && !X.canMoveInto(tC, f82(tr82.kids, 'rem82')) && !X.canMoveInto({ u: { ...tC.u, name: 'k', nkind: 'context' }, kids: [] }, tOld)
    && !X.canMoveInto(tC, { u: { key: 'd', depth: 6, host: 'HOST-A', path: 'd' }, kids: [] }))
  const tg = X.moveTargets(tr82.kids, tC, 'Plan82')
  check('#82 moveTargets (the picker): the session root first, then every node of its host it may go under, in tree order — never its own parent, a node on another host, or itself', tg[0].path === '' && /Plan82 \(the session root\)/.test(tg[0].label)
    && tg.some(t => t.path === '@Old') && tg.some(t => t.path === '@Next/@A') && !tg.some(t => t.path === '@Next' || t.path === 'rem82' || t.path === '@Next/@C'), J(tg.map(t => t.path)))
  check('#82 dropPlan: on a sibling of its kind → reorder before (upper half) / after (lower half); on another node → move into it; on itself / below itself / another host → nothing',
    J(X.dropPlan(tC, f82(tr82.kids, '@Next/@B'), 0.2)) === J({ act: 'reorder', args: { before: '@"B"' } }) && J(X.dropPlan(tC, f82(tr82.kids, '@Next/@B'), 0.8)) === J({ act: 'reorder', args: { after: '@"B"' } })
    && J(X.dropPlan(tC, tOld, 0.5)) === J({ act: 'move', args: { to: '@Old' } }) && X.dropPlan(tC, tC, 0.5) === null && X.dropPlan(tOld, tK, 0.5) === null && X.dropPlan(tC, f82(tr82.kids, 'rem82'), 0.5) === null
    && J(X.dropPlan(tC, f82(tr82.kids, '@Next/@notes'), 0.2)) === J({ act: 'move', args: { to: '@Next/@notes' } }))
  check('#82 workingAgent: the most recently active agent child still running (a finished one only when none is)', X.workingAgent(f82(tr82.kids, '@Next/@A')).u.name === 'builder' && X.workingAgent(tC) === null
    && X.workingAgent({ kids: [{ u: { nkind: 'agent', name: 'x', finished_at: 1, last_activity: 5 } }] }).u.name === 'x')
  // ---- the rendered tree
  const in82 = p => { const rs = rowsT(), i = rs.indexOf(nmRow('Plan82')); if (i < 0) return null; for (let j = i + 1; j < rs.length && dOf(rs[j]) > 1; j++) if (rs[j].querySelector('.nm')?.getAttribute('title') === p) return rs[j]; return null }
  const rA = in82('@Next/@A')
  check('#82 tree: the rows under @Next in rank order (B A C, then notes, then helper)', (() => { const rs = rowsT(), idx = p => rs.indexOf(in82(p)); return ['@Next/@B', '@Next/@A', '@Next/@C', '@Next/@notes', '@Next/helper'].map(idx).every((v, i, a) => v > 0 && (!i || v > a[i - 1])) })())
  check('#82 agent on its item: the plan item A (closed) shows the WORKING agent beside its box — its glyph, its name and its current line', !!rA && rA.getAttribute('aria-expanded') !== 'true' && !!rA.querySelector('.ln .agon svg.gl') && rA.querySelector('.agon .agn')?.textContent === 'builder' && /compiling the docs/.test(rA.querySelector('.agon').textContent)
    && !in82('@Next/@C').querySelector('.agon'), rA?.innerHTML.slice(0, 600))
  tog(in82('@Old')); tog(in82('@Old/@k'))
  check('#82 greyed: an abandoned context is greyed AND everything under it (abd) — its open child context and the agent below that too', /\babandoned\b/.test(in82('@Old').className) && /\babd\b/.test(in82('@Old/@k')?.className || '') && /\babd\b/.test(in82('@Old/@k/w')?.className || '')
    && !/\babd\b/.test(in82('@Next/@A').className) && /\.ar\.abd \.nm/.test([...doc.querySelectorAll('style')].map(s => s.textContent).join('')), J([in82('@Old')?.className, in82('@Old/@k')?.className, in82('@Old/@k/w')?.className]))
  check('#82 drag: node rows of this host are draggable; another host\'s (it may run ≤1.68) are not', rA.getAttribute('draggable') === 'true' && in82('rem82')?.getAttribute('draggable') !== 'true')
  // ---- the menu
  const mEl = () => doc.querySelector('.act-menu'), mLab = () => [...(mEl()?.querySelectorAll('.mi') || [])].map(b => b.textContent)
  const rc = el => el.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
  const pick = label => { const b = [...(mEl()?.querySelectorAll('.mi') || [])].find(x => x.textContent === label); if (b) click(b); return !!b }
  const esc82 = () => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  rc(rA)
  check('#82 menu: a plan item in the middle → Move up · Move down · Move to… (after its item actions)', mLab().includes('Move up') && mLab().includes('Move down') && mLab().includes('Move to…') && mLab().indexOf('Move up') > mLab().indexOf('Mark done'), J(mLab()))
  const nA0 = sentOf('activity_action').length
  pick('Move up')
  const mu = sentOf('activity_action').at(-1)
  check('#82 Move up: sends reorder with args.before = the previous plan item ("@\\"B\\""), no confirmation', sentOf('activity_action').length === nA0 + 1 && mu.action === 'reorder' && mu.path === '@Next/@A' && mu.args.before === '@"B"' && mu.host === 'HOST-A' && !doc.querySelector('.act-dlg'), J(mu))
  rc(in82('@Next/@B'))
  check('#82 menu: the first plan item has no Move up', !mLab().includes('Move up') && mLab().includes('Move down'), J(mLab()))
  esc82()
  rc(in82('@Next/@notes'))
  check('#82 menu: an ordinary context → Abandon… (confirmed: it cascades) + Move to…; an agent row of another host → no Move items', mLab().includes('Abandon…') && mLab().includes('Move to…') && (() => { esc82(); rc(in82('rem82')); const l = mLab(); esc82(); return !l.includes('Move to…') && !l.includes('Move up') })(), J(mLab()))
  rc(in82('@Next/@notes')); pick('Abandon…')
  check('#82 Abandon…: asks first — the cascade explained, how it is logged — and sends nothing yet', !!doc.querySelector('.act-dlg') && /every OPEN context or plan item under it/.test(doc.querySelector('.act-dlg').textContent) && /abandoned with/.test(doc.querySelector('.act-dlg').textContent) && sentOf('activity_action').length === nA0 + 1)
  click(doc.querySelector('.act-dlg [data-dlg="ok"]'))
  check('#82 Abandon… confirmed: sends abandon on the context', sentOf('activity_action').at(-1).action === 'abandon' && sentOf('activity_action').at(-1).path === '@Next/@notes')
  rc(in82('@Next/@C')); pick('Move to…')
  const pk = doc.querySelector('.act-dlg select.act-pick')
  check('#82 Move to…: a PICKER of valid new parents (the session root first; never its own parent) — nothing sent yet', !!pk && pk.options[0].textContent.includes('the session root') && [...pk.options].some(o => /@Old$/.test(o.textContent.trim())) && ![...pk.options].some(o => o.textContent.trim() === '@Next') && sentOf('activity_action').length === nA0 + 2, J([...(pk?.options || [])].map(o => o.textContent)))
  pk.value = String([...pk.options].findIndex(o => /@Old$/.test(o.textContent.trim())))
  click(doc.querySelector('.act-dlg [data-dlg="ok"]'))
  check('#82 Move to… → then a CONFIRM naming both ends; still nothing sent', /Move @Next\/@C to @Old\?/.test(doc.querySelector('.act-dlg h3')?.textContent || '') && /stays a plan item/.test(doc.querySelector('.act-dlg').textContent) && sentOf('activity_action').length === nA0 + 2, doc.querySelector('.act-dlg')?.textContent)
  click(doc.querySelector('.act-dlg [data-dlg="ok"]'))
  const mt = sentOf('activity_action').at(-1)
  check('#82 Move to… confirmed: sends {action:"move", path, args:{to}} for the node\'s host', mt.action === 'move' && mt.path === '@Next/@C' && mt.args.to === '@Old' && mt.host === 'HOST-A' && sentOf('activity_action').length === nA0 + 3, J(mt))
  // ---- drag and drop
  const drag = (el, type) => { const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientY: 0 }); Object.defineProperty(ev, 'dataTransfer', { value: { setData() { }, effectAllowed: '', dropEffect: '' } }); el.dispatchEvent(ev); return ev }
  drag(in82('@Next/@C'), 'dragstart')
  const ov = drag(in82('@Next/@B'), 'dragover')
  check('#82 drag over a sibling: the drop is allowed (preventDefault) and marked (drop-before / -after)', ov.defaultPrevented && /drop-(before|after)/.test(in82('@Next/@B').className), in82('@Next/@B').className)
  drag(in82('@Next/@B'), 'drop')
  const dd = sentOf('activity_action').at(-1)
  check('#82 drop on a sibling: a reorder relative to it (no confirmation)', dd.action === 'reorder' && dd.path === '@Next/@C' && (dd.args.before === '@"B"' || dd.args.after === '@"B"') && sentOf('activity_action').length === nA0 + 4, J(dd))
  drag(in82('@Next/@C'), 'dragstart'); drag(in82('@Old'), 'dragover'); drag(in82('@Old'), 'drop')
  check('#82 drop on another node: asks first (Move … to @Old?), then moves', /Move @Next\/@C to @Old\?/.test(doc.querySelector('.act-dlg h3')?.textContent || '') && sentOf('activity_action').length === nA0 + 4)
  click(doc.querySelector('.act-dlg [data-dlg="ok"]'))
  check('#82 drop on another node, confirmed: sends the move', sentOf('activity_action').at(-1).action === 'move' && sentOf('activity_action').at(-1).args.to === '@Old' && sentOf('activity_action').length === nA0 + 5)
  check('#82 legend: says how order, drag and drop, the agent on its item and the greyed subtrees work', /plan items first, then contexts, then agents/.test(doc.getElementById('actlegend').textContent) && /drag a row/.test(doc.getElementById('actlegend').textContent))
} catch (e) { fail++; console.log('FAIL #82 block crashed:', (e && e.stack) || e) }


try {   // ================================================================= #83 / #84 (v1.70.0): EDIT TEXT… and MESSAGE SESSION… — the menu items (only
  // for hosts that apply them), the two dialogs (prefill, the state picker, validation, sending), the result ("not delivered"), the ✎ on an
  // edited line, the 💬 / ✎ log entries, the legend
  // ---- the pure part
  check('#83 editStates (the bridge\'s rule): a plan item any state; another context no todo / skipped; an agent / the session no plan states, abandoned only while it holds plan items',
    J(X.editStates({ nkind: 'context', plan_item: true })) === J(['running', 'blocked', 'failed', 'done', 'idle', 'todo', 'skipped', 'abandoned']) && J(X.editStates({ nkind: 'context' })) === J(['running', 'blocked', 'failed', 'done', 'idle', 'abandoned'])
    && J(X.editStates({ nkind: 'agent' })) === J(['running', 'blocked', 'failed', 'done', 'idle']) && J(X.editStates({ nkind: 'agent', holds_plan: true })) === J(['running', 'blocked', 'failed', 'done', 'idle', 'abandoned']))
  const cur = { text: 'Docs', state: 'todo' }
  check('#83 checkEdit: empty → "can\'t be empty"; over 240 characters (code points, one line) → "Too long"; the same text + state → "Nothing changed"; a new text, or the same text with a new state, is fine',
    !X.checkEdit('  ', '', cur).ok && /can't be empty/.test(X.checkEdit('', '', cur).why) && (c => !c.ok && c.n === 241 && /Too long: 241 of 240/.test(c.why))(X.checkEdit('é'.repeat(241), '', cur))
    && X.checkEdit('é'.repeat(240), '', cur).ok && /Nothing changed/.test(X.checkEdit('Docs', '', cur).why) && /Nothing changed/.test(X.checkEdit(' Docs ', 'todo', cur).why) && X.checkEdit('Docs', 'done', cur).ok && X.checkEdit('Docs v2', '', cur).ok
    && X.checkEdit('a\nb', '', null).ok && X.checkEdit('a\nb', '', null).n === 3)
  check('#84 checkMsg: empty → "Write something"; ≤ 2000 characters fine (newlines kept and counted); 2001 → "Too long"', !X.checkMsg(' \n ').ok && /Write something/.test(X.checkMsg('').why) && X.checkMsg('x'.repeat(2000)).ok && (c => !c.ok && /Too long: 2001 of 2000/.test(c.why))(X.checkMsg('x'.repeat(2001))) && X.checkMsg('a\r\nb').n === 3)
  check('#83 dispPath: a path for people (quotes dropped), as the bridge\'s displayPath', X.dispPath('@"Next release"/@"#83 x"/w') === '@Next release/@#83 x/w' && X.dispPath('') === '')
  check('#83 editedBy: "edited by robin via dashboard (HOST-A)" for a line with by; "" without', X.editedBy({ text: 'x', by: { user: 'robin', host: 'HOST-A' } }) === 'edited by robin via dashboard (HOST-A)' && X.editedBy({ text: 'x' }) === '' && X.editedBy(null) === '')
  // ---- the board: a local session (HOST-A), a node on HOST-B (1.70: msg) and one on HOST-C (≤1.69: no msg)
  const n83 = (p, nk, extra = {}) => node('k-e83', p, nk, extra.host || 'HOST-A', extra)
  const self83 = root('HOST-A', { current: { id: 's83', ts: NOW - MIN, text: 'running the release', state: 'running' } })
  const u83 = [
    sess('k-e83', 'Edit83', 'E83', { hosts: ['HOST-A', 'HOST-B', 'HOST-C'], multi_host: true, self: self83, selves: [self83, root('HOST-B', { current: { id: 'sb', ts: NOW - 2 * MIN, text: 'on B', state: 'running' } }), root('HOST-C', { current: { id: 'sc', ts: NOW - 3 * MIN, text: 'on C', state: 'running' } })] }),
    sess('k-s83', 'Solo83', 'E83', { host: 'HOST-A', self: root('HOST-A', { current: { id: 'so', ts: NOW - MIN, text: 'solo line', state: 'running', by: { user: 'robin', host: 'HOST-A' } } }) }),
    n83('@Rel', 'context', { plan_node: true, implicit: true }),
    n83('@Rel/@Docs', 'context', { plan_item: true, state: 'todo', current: { id: 'd1', ts: NOW - MIN, text: 'Docs: {progress}', state: 'todo' }, progress: { done: 2, total: 5, unit: 'pages' } }),
    n83('@Rel/@Code', 'context', { plan_item: true, state: 'running', current: { id: 'c1', ts: NOW - MIN, text: 'Code: merging', state: 'running', by: { user: 'robin', host: 'HOST-A' } } }),
    n83('wB', 'agent', { host: 'HOST-B', current: { id: 'wb', ts: NOW - MIN, text: 'on B', state: 'running' }, log: { remote: true, total: 1 } }),
    n83('wC', 'agent', { host: 'HOST-C', current: { id: 'wc', ts: NOW - MIN, text: 'on C', state: 'running' }, log: { remote: true, total: 1 } }),
  ]
  recv({ type: 'activity_board', full: true, epoch: 'E83', seq: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15, finished_plan_open_min: 120, user: 'robin', log_cmd: null, remote_hosts: [{ host: 'HOST-B', plan: true, msg: true }, { host: 'HOST-C', plan: true }] }, upsert: u83 })
  const in83 = p => { const rs = rowsT(), i = rs.indexOf(nmRow('Edit83')); if (i < 0) return null; for (let j = i + 1; j < rs.length && dOf(rs[j]) > 1; j++) if (rs[j].querySelector('.nm')?.getAttribute('title') === p) return rs[j]; return null }
  if (!in83('@Rel')) tog(nmRow('Edit83'))
  if (in83('@Rel') && !in83('@Rel/@Docs')) tog(in83('@Rel'))
  const mEl = () => doc.querySelector('.act-menu'), mLab = () => [...(mEl()?.querySelectorAll('.mi') || [])].map(b => b.textContent)
  const rc = el => el.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
  const pick = label => { const b = [...(mEl()?.querySelectorAll('.mi') || [])].find(x => x.textContent === label); if (b) click(b); return !!b }
  const escK = el => (el || doc).dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const dlg = () => doc.querySelector('.act-dlg')
  const typeIn = (el, v) => { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })) }
  // ---- the ✎ on an edited line
  const rCode = in83('@Rel/@Code'), rDocs = in83('@Rel/@Docs')
  check('#83 tree: a line edited from the dashboard shows ✎ right after its text, inside the line (the text ellipsises, the ✎ stays) — its tooltip: who, and that the session\'s next report replaces it; an ordinary line has none',
    !!rCode?.querySelector('.ln.ed > .lt + .edby') && rCode.querySelector('.ln.ed > .lt').textContent === 'Code: merging' && !!rCode?.querySelector('.edby') && rCode.querySelector('.edby').textContent === '✎' && rCode.querySelector('.edby').getAttribute('aria-label') === 'edited by robin via dashboard (HOST-A)' && !!rCode.querySelector('.edby').getAttribute('data-tip')
    && !rDocs?.querySelector('.edby'), rCode?.innerHTML.slice(0, 500))
  check('#83 tree: a SESSION row\'s headline shows ✎ too', !!nmRow('Solo83')?.querySelector('.edby'))
  // ---- the menu: local nodes and the session's own host line get both items; HOST-B (msg) too; HOST-C (≤1.69) never
  rc(rDocs)
  check('#83/#84 menu: a plan item → Edit text… + Message session… (after its item actions, before Move…)', mLab().includes('Edit text…') && mLab().includes('Message session…') && mLab().indexOf('Edit text…') > mLab().indexOf('Mark done') && mLab().indexOf('Message session…') < mLab().indexOf('Move to…'), J(mLab()))
  escK(); rc(in83('wB'))
  const labB = mLab(); escK(); rc(in83('wC'))
  const labC = mLab(); escK()
  check('#83/#84 menu: a node on a 1.70 host (remote_hosts[].msg) offers them; on an older host (no msg) they are HIDDEN', labB.includes('Edit text…') && labB.includes('Message session…') && !labC.includes('Edit text…') && !labC.includes('Message session…'), J([labB, labC]))
  rc(nmRow('Edit83'))
  const labM = mLab(); escK()
  check('#83/#84 menu: a multi-host session\'s own row has none (an action names one host\'s line) …', !labM.includes('Edit text…') && !labM.includes('Message session…'), J(labM))
  const hlOf = h => rowsT().find(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Edit83' && r.getAttribute('data-host') === h)
  if (!hlOf('HOST-A')) tog(nmRow('Edit83'))
  const hlA = rowsT().find(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Edit83' && r.getAttribute('data-host') === 'HOST-A'), hlC = rowsT().find(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Edit83' && r.getAttribute('data-host') === 'HOST-C')
  let labHA = [], labHC = []
  if (hlA) { rc(hlA); labHA = mLab(); escK() }
  if (hlC) { rc(hlC); labHC = mLab(); escK() }
  check('#83/#84 menu: … each host\'s own line does (this host\'s), unless that host is older', labHA.includes('Edit text…') && labHA.includes('Message session…') && !!hlC && !labHC.includes('Edit text…'), J([labHA, labHC]))
  rc(nmRow('Solo83'))
  check('#83/#84 menu: a single-host session row → Edit text… + Message session…', mLab().includes('Edit text…') && mLab().includes('Message session…'), J(mLab()))
  escK()
  // ---- the EDIT dialog
  const nA0 = sentOf('activity_action').length
  rc(in83('@Rel/@Docs')); pick('Edit text…')
  const ed = dlg(), tIn = ed?.querySelector('#actEdT'), sIn = ed?.querySelector('#actEdS'), okB = ed?.querySelector('[data-dlg="ok"]')
  check('#83 Edit text…: a dialog prefilled with the RAW line ({progress} stays a placeholder), focused; the state picker = "keep todo" + the node\'s other valid states; Save disabled ("Nothing changed"); a counter "16 / 240"',
    !!ed && ed.querySelector('[role="dialog"]')?.getAttribute('aria-modal') === 'true' && tIn?.value === 'Docs: {progress}' && doc.activeElement === tIn
    && J([...sIn.options].map(o => o.value)) === J(['', 'running', 'blocked', 'failed', 'done', 'idle', 'skipped', 'abandoned']) && sIn.options[0].textContent === 'keep todo'
    && okB.disabled && /Nothing changed/.test(ed.querySelector('.dlg-why').textContent) && ed.querySelector('.dlg-n').textContent === '16 / 240' && /Placeholders such as \{progress\}/.test(ed.textContent) && /edited by robin via dashboard \(HOST-A\)/.test(ed.textContent), ed?.outerHTML.slice(0, 900))
  typeIn(tIn, '')
  const emptyWhy = ed.querySelector('.dlg-why').textContent, emptyDis = okB.disabled
  typeIn(tIn, 'x'.repeat(241))
  const longWhy = ed.querySelector('.dlg-why').textContent, longDis = okB.disabled, overCls = ed.querySelector('.dlg-n').className
  check('#83 validation: empty → disabled "The line can\'t be empty."; 241 characters → disabled "Too long: 241 of 240", the counter red', emptyDis && /can't be empty/.test(emptyWhy) && longDis && /Too long: 241 of 240/.test(longWhy) && /over/.test(overCls) && sentOf('activity_action').length === nA0)
  typeIn(tIn, 'Docs: writing the README {progress}'); sIn.value = 'running'; sIn.dispatchEvent(new win.Event('change', { bubbles: true }))
  check('#83 a valid edit: Save enabled, no reason shown', !okB.disabled && ed.querySelector('.dlg-why').textContent === '')
  click(okB)
  const se = sentOf('activity_action').at(-1)
  check('#83 Save: sends {action:"edit_text", path, host, session, project, args:{text, state}} and closes the dialog', sentOf('activity_action').length === nA0 + 1 && se.action === 'edit_text' && se.path === '@Rel/@Docs' && se.host === 'HOST-A' && se.session === 'Edit83' && se.project === 'E83'
    && se.args.text === 'Docs: writing the README {progress}' && se.args.state === 'running' && !dlg(), J(se))
  recv({ type: 'activity_action', ref: se.ref, result: { ok: true, host: 'HOST-A', action: 'edit_text', path: '@Rel/@Docs', applied: [{ path: '@Rel/@Docs', state: 'running' }], text: 'Docs: writing the README {progress}' } })
  check('#83 the result: ✓ edited on the row', /✓ edited/.test(in83('@Rel/@Docs')?.querySelector('.fb')?.textContent || ''), in83('@Rel/@Docs')?.querySelector('.fb')?.outerHTML)
  rc(in83('@Rel/@Code')); pick('Edit text…')
  const ed2 = dlg(), t2 = ed2.querySelector('#actEdT')
  typeIn(t2, '  Code: merged and tagged '); t2.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const se2 = sentOf('activity_action').at(-1)
  check('#83 Enter in the line sends (no state chosen → none sent: the line keeps its state); the text trimmed', sentOf('activity_action').length === nA0 + 2 && se2.action === 'edit_text' && se2.args.text === 'Code: merged and tagged' && !('state' in se2.args) && !dlg(), J(se2))
  rc(in83('@Rel/@Code')); pick('Edit text…'); escK(dlg())
  check('#83 Escape closes the dialog and sends nothing', !dlg() && sentOf('activity_action').length === nA0 + 2)
  // ---- the MESSAGE dialog
  rc(in83('wB')); pick('Message session…')
  const md = dlg(), ta = md?.querySelector('textarea#actMsgT'), sB = md?.querySelector('[data-dlg="ok"]')
  check('#84 Message session…: a dialog titled "Message Edit83 about wB" with a focused, empty text box; Send disabled ("Write something…"); it says the session treats it as a request and what the public subject shows',
    !!md && /Message Edit83 about wB/.test(md.querySelector('h3').textContent) && !!ta && doc.activeElement === ta && ta.value === '' && sB.disabled && /Write something/.test(md.querySelector('.dlg-why').textContent)
    && /request from you/.test(md.textContent) && /subject \(not encrypted\) names only the path and your first few words/.test(md.textContent) && md.querySelector('.dlg-n').textContent === '0 / 2000', md?.textContent)
  typeIn(ta, 'y'.repeat(2001))
  const mLong = sB.disabled && /Too long: 2001 of 2000/.test(md.querySelector('.dlg-why').textContent)
  typeIn(ta, 'Please also cover the empty-plan case.\nThanks!')
  check('#84 validation: 2001 characters → disabled "Too long"; a real message → Send enabled', mLong && !sB.disabled)
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  check('#84 a plain Enter in the text box is a newline, not a send', !!dlg() && sentOf('activity_action').length === nA0 + 2)
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  const sm = sentOf('activity_action').at(-1)
  check('#84 Ctrl+Enter sends {action:"message", host HOST-B (the node\'s owner), path, args:{text} — newlines kept}', sentOf('activity_action').length === nA0 + 3 && sm.action === 'message' && sm.host === 'HOST-B' && sm.path === 'wB' && sm.args.text === 'Please also cover the empty-plan case.\nThanks!' && !dlg(), J(sm))
  const toasts0 = doc.querySelectorAll('.act-toast').length
  recv({ type: 'activity_action', ref: sm.ref, result: { ok: true, host: 'HOST-B', action: 'message', path: 'wB', applied: [{ path: 'wB', state: 'running' }], delivered: true, delivery: 'live' } })
  check('#84 delivered: ✓ sent on the row + a toast "Message sent to Edit83"', /✓ sent/.test(in83('wB')?.querySelector('.fb')?.textContent || '') && [...doc.querySelectorAll('.act-toast')].some(t => t.textContent === 'Message sent to Edit83') && doc.querySelectorAll('.act-toast').length > toasts0)
  rc(nmRow('Solo83')); pick('Message session…'); const ta2 = dlg().querySelector('textarea'); typeIn(ta2, 'are you still there?'); click(dlg().querySelector('[data-dlg="ok"]'))
  const sm2 = sentOf('activity_action').at(-1)
  recv({ type: 'activity_action', ref: sm2.ref, result: { ok: true, host: 'HOST-A', action: 'message', path: '', applied: [{ path: '', state: 'running' }], delivered: false, delivery: 'none', warnings: ['not-delivered'], what: 'not delivered: the session has no inbox (a script-only session) — the message is logged on the node' } })
  const fbS = nmRow('Solo83')?.querySelector('.fb')
  check('#84 NOT delivered (a script-only session): the row says "⚠ logged · not delivered: the session has no inbox" (amber, not a ✓) and a toast says so', sm2.path === '' && sm2.session === 'Solo83' && !!fbS && /⚠ logged · not delivered: the session has no inbox/.test(fbS.textContent) && fbS.classList.contains('wn')
    && [...doc.querySelectorAll('.act-toast')].some(t => /Not delivered: Solo83 has no inbox/.test(t.textContent)), fbS?.outerHTML)
  rc(in83('wB')); pick('Message session…'); typeIn(dlg().querySelector('textarea'), 'x'); click(dlg().querySelector('[data-dlg="ok"]'))
  const sm3 = sentOf('activity_action').at(-1)
  recv({ type: 'activity_action', ref: sm3.ref, result: { ok: false, code: 'owner-unsupported', host: 'HOST-B', what: 'host HOST-B runs a bridge older than 1.70.0' } })
  check('#84 a refusal shows its code on the row (✗ owner-unsupported)', /✗ owner-unsupported/.test(in83('wB')?.querySelector('.fb')?.textContent || ''))
  // ---- the log panel: 💬 on a message entry, ✎ on an edit entry
  click(in83('@Rel/@Docs'))
  const lq83 = sentOf('activity').pop()
  recv({ type: 'activity', ref: lq83.ref, result: { ok: true, log: { host: 'HOST-A', entries: [
    { id: 'm1', ts: NOW - MIN, path: '@Rel/@Docs', text: 'robin via dashboard: Please also cover the empty-plan case. Thanks!', rendered: 'robin via dashboard: Please also cover the empty-plan case. Thanks!', state: 'todo', act: 'message', has_details: true, by: { kind: 'dashboard', user: 'robin', host: 'HOST-A' } },
    { id: 'm2', ts: NOW - 2 * MIN, path: '@Rel/@Docs', current: true, text: 'Docs: writing (edited by robin via dashboard (HOST-A))', rendered: 'Docs: writing (edited by robin via dashboard (HOST-A))', state: 'running', act: 'edit_text', by: { kind: 'dashboard', user: 'robin', host: 'HOST-A' } }], next_cursor: null } } })
  const les = [...PANEL.querySelectorAll('.ar.le')]
  check('#84 / #83 log panel: a message entry is marked 💬 (class msg; its details hold the full text), an edit entry ✎', les.length === 2 && /💬/.test(les[1].querySelector('.msgic')?.textContent || '') && les[1].classList.contains('msg') && /✎/.test(les[0].querySelector('.msgic')?.textContent || '') && !les[0].classList.contains('msg'), les.map(e => e.innerHTML.slice(0, 200)).join(' | '))
  check('#83 / #84 legend: names Edit text… (✎) and Message session… (💬)', /Edit text…/.test(doc.getElementById('actlegend').textContent) && /Message session…/.test(doc.getElementById('actlegend').textContent) && /✎/.test(doc.getElementById('actlegend').textContent))
  const css83 = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n')
  check('#83 / #84 CSS: the form dialog (inputs, the reason in --bad, the counter), the primary Send / Save button and the amber warning use theme tokens', /\.act-dlg \.act-in \{[^}]*var\(--bg\)[^}]*var\(--fg\)/.test(css83) && /\.act-btn\.primary \{[^}]*var\(--info\)/.test(css83) && /\.ar \.fb\.wn \{[^}]*var\(--warn\)/.test(css83) && /\.act-dlg \.dlg-why \{[^}]*var\(--bad\)/.test(css83))
} catch (e) { fail++; console.log('FAIL #83/#84 block crashed:', (e && e.stack) || e) }

try {   // ================================================================= #85 (v1.71.0): QUESTIONS — the "?" bubble, the awaiting-answer row, the answer
  // after the question, the "? N" attention badge (collapsed ancestors, the session / project headers, the section tag), the menu (Answer… /
  // Withdraw question… only for a 1.71 owner; no Edit text… / Abandon… on a question), the Answer… dialog (choices + free text), withdraw
  // ---- the pure part
  const qn = (status, extra = {}) => ({ nkind: 'context', current: { id: 'q', ts: NOW, text: 'Postgres or SQLite?', state: status === 'asked' ? 'blocked' : status === 'answered' ? 'done' : 'abandoned', question: { status, choices: ['Postgres', 'SQLite'], free: false, asked_at: NOW - MIN, ...extra } } })
  check('#85 qOf / isQuestion / isOpenQuestion: a context whose line carries question; never an agent; open only while asked',
    X.isQuestion(qn('asked')) && X.isOpenQuestion(qn('asked')) && X.isQuestion(qn('answered')) && !X.isOpenQuestion(qn('answered')) && !X.isQuestion({ nkind: 'agent', current: qn('asked').current }) && !X.isQuestion(cx('blocked')) && X.qOf(qn('expired')).status === 'expired')
  const ga = X.questionGlyph('asked'), gb = X.questionGlyph('answered'), gc = X.questionGlyph('expired'), gw = X.questionGlyph('withdrawn')
  check('#85 glyph: a speech bubble — asked: filled, "?" (s-asked); answered: a tick (s-answered); expired / withdrawn: dashed (greyed classes)',
    /class="gl ctx q s-asked"/.test(ga) && />\?<\/text>/.test(ga) && /fill="currentColor"/.test(ga) && /s-answered/.test(gb) && /<path d="M5\.2 7\.1/.test(gb) && !/<text/.test(gb) && /s-expired/.test(gc) && /stroke-dasharray/.test(gc) && /s-withdrawn/.test(gw)
    && X.glyphSvg({ qstatus: 'answered' }, NOW, 'question') === gb && X.effState(qn('asked'), null, NOW, 15).qstatus === 'asked')
  const qq = { choices: ['Postgres', 'SQLite'], free: false }, qf = { choices: ['Postgres', 'SQLite'], free: true }, qt = { choices: [], free: true }
  check('#85 checkAnswer: a choice is needed ("Pick a choice."); one of its choices (exact); free text only when allowed; with free text: a choice OR text; ≤ 1000 characters',
    /Pick a choice/.test(X.checkAnswer(null, '', qq).why) && X.checkAnswer('SQLite', '', qq).ok && !X.checkAnswer('MySQL', '', qq).ok && /takes one of its choices/.test(X.checkAnswer('SQLite', 'because', qq).why)
    && /Pick a choice or write an answer/.test(X.checkAnswer(null, ' ', qf).why) && X.checkAnswer(null, 'smaller', qf).ok && X.checkAnswer('SQLite', 'smaller', qf).ok
    && /Write an answer/.test(X.checkAnswer(null, '', qt).why) && X.checkAnswer(null, 'x'.repeat(1000), qt).ok && (c => !c.ok && /Too long: 1001 of 1000/.test(c.why))(X.checkAnswer(null, 'x'.repeat(1001), qt)))
  check('#85 answerText: "choice — text" on one line, cut with "…"', X.answerText({ choice: 'SQLite', text: 'smaller\nto ship' }) === 'SQLite — smaller to ship' && X.answerText({ text: 'x'.repeat(200) }, 10) === 'xxxxxxxxx…' && X.answerText({ choice: 'A' }) === 'A')
  const roll = X.rollKids([{ u: { key: 'a', plan_item: true, current: { state: 'done' } } }, { u: { key: 'b', ...qn('asked') } }, { u: { key: 'c', ...qn('answered') } }, { u: { key: 'd', ...qn('withdrawn') } }])
  check('#85 rollup (as the bridge): a question counts as an item — open = remaining, answered = done, withdrawn / expired = skipped', roll && roll.items && roll.total === 4 && roll.done === 2 && roll.skipped === 1, J(roll))
  const mq = X.menuFor({ kind: 'node', nkind: 'context', question: { status: 'asked' }, can_ask: true, can_msg: true, can_plan: true })
  const mq2 = X.menuFor({ kind: 'node', nkind: 'context', question: { status: 'asked' }, can_ask: false, can_msg: true, can_plan: true })
  const mq3 = X.menuFor({ kind: 'node', nkind: 'context', question: { status: 'answered' }, can_ask: true, can_msg: true, can_plan: true })
  const lab = m => m.filter(i => !i.sep).map(i => i.label)
  check('#85 menu (pure): an OPEN question on a 1.71 host → Answer… + Withdraw question… (asked first); never Edit text… or Abandon… on a question; Message session… stays',
    lab(mq)[0] === 'Answer…' && lab(mq)[1] === 'Withdraw question…' && mq[1].confirm === true && !lab(mq).includes('Edit text…') && !lab(mq).includes('Abandon…') && lab(mq).includes('Message session…') && lab(mq).includes('Move to…'), J(lab(mq)))
  check('#85 menu (pure): an older owner (no ask) → no Answer… / Withdraw; an answered question → neither either', !lab(mq2).includes('Answer…') && !lab(mq2).includes('Withdraw question…') && !lab(mq3).includes('Answer…') && !lab(mq3).includes('Edit text…'), J([lab(mq2), lab(mq3)]))
  // ---- the board: Ask85 on HOST-A (agent lead: an open question with choices, an answered one; @Rel: a free-text question) + a question on HOST-C (≤1.70: no ask)
  const n85 = (p, nk, extra = {}) => node('k-a85', p, nk, extra.host || 'HOST-A', extra)
  const qline = (id, text, status, q = {}) => ({ id, ts: NOW - MIN, text, state: status === 'asked' ? 'blocked' : status === 'answered' ? 'done' : 'abandoned', question: { status, choices: [], free: true, asked_at: NOW - 5 * MIN, ...q } })
  const u85 = [
    sess('k-a85', 'Ask85', 'A85', { hosts: ['HOST-A', 'HOST-C'], multi_host: true, self: root('HOST-A', { current: { id: 'sa', ts: NOW - MIN, text: 'asking', state: 'running' } }), selves: [root('HOST-A', { current: { id: 'sa', ts: NOW - MIN, text: 'asking', state: 'running' } }), root('HOST-C', { current: { id: 'sc', ts: NOW - MIN, text: 'on C', state: 'running' } })] }),
    n85('lead', 'agent', { current: { id: 'l', ts: NOW - MIN, text: 'deciding', state: 'running' } }),
    n85('lead/@?1', 'context', { state: 'blocked', current: qline('q1', 'Postgres or SQLite for the cache?', 'asked', { choices: ['Postgres', 'SQLite'], free: false, expires_at: NOW + 60 * MIN }) }),
    n85('lead/@?2', 'context', { state: 'done', current: qline('q2', 'Ship on Friday?', 'answered', { choices: ['Yes', 'No'], free: true, answer: { choice: 'Yes', text: 'after the review' }, by: { user: 'robin', host: 'HOST-A' }, at: NOW - MIN }) }),
    n85('@Rel', 'context', { current: { id: 'r', ts: NOW - MIN, text: 'release', state: 'running' } }),
    n85('@Rel/@?1', 'context', { state: 'blocked', current: qline('q3', 'Which changelog wording?', 'asked') }),
    n85('@Rel/@?2', 'context', { state: 'abandoned', current: qline('q4', 'Old question', 'withdrawn', { at: NOW - MIN }) }),
    n85('wc', 'agent', { host: 'HOST-C', current: { id: 'wc', ts: NOW - MIN, text: 'on C', state: 'running' }, log: { remote: true, total: 1 } }),
    n85('wc/@?1', 'context', { host: 'HOST-C', state: 'blocked', current: qline('q5', 'Question on an older host?', 'asked') }),
  ]
  recv({ type: 'activity_board', full: true, epoch: 'E85', seq: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15, finished_plan_open_min: 120, user: 'robin', log_cmd: null, remote_hosts: [{ host: 'HOST-C', plan: true, msg: true }] }, upsert: u85 })
  const in85 = pth => { const rs = rowsT(), i = rs.indexOf(nmRow('Ask85')); if (i < 0) return null; for (let j = i + 1; j < rs.length && dOf(rs[j]) > 1; j++) if (rs[j].querySelector('.nm')?.getAttribute('title') === pth && (rs[j].getAttribute('data-host') || '') === (pth.startsWith('wc') ? 'HOST-C' : 'HOST-A')) return rs[j]; return null }
  for (const pth of ['lead', '@Rel', 'wc']) if (in85(pth) && in85(pth).getAttribute('aria-expanded') === 'false') tog(in85(pth))
  const rq1 = in85('lead/@?1'), rq2 = in85('lead/@?2'), rq4 = in85('@Rel/@?2')
  check('#85 tree: an OPEN question — the fuchsia "?" bubble, a tinted "awaiting answer" row (class qopen), the pill "awaiting answer" (not "blocked"), the question as its line, its short name ?1',
    !!rq1 && rq1.classList.contains('qopen') && !!rq1.querySelector('svg.gl.q.s-asked') && /awaiting answer/.test(rq1.querySelector('.pills')?.textContent || '') && !/blocked/.test(rq1.querySelector('.pills')?.textContent || '')
    && rq1.querySelector('.ln')?.textContent === 'Postgres or SQLite for the cache?' && rq1.querySelector('.nm')?.textContent === '?1', rq1?.innerHTML.slice(0, 700))
  check('#85 tree: an ANSWERED question shows its answer after the question ("→ Yes — after the review", green), a ticked bubble, no pill; a withdrawn one a dashed bubble + "withdrawn"',
    !!rq2 && !rq2.classList.contains('qopen') && !!rq2.querySelector('svg.s-answered') && rq2.querySelector('.qa')?.textContent === '→ Yes — after the review' && !rq2.querySelector('.pill')
    && !!rq4 && !!rq4.querySelector('svg.s-withdrawn') && /withdrawn/.test(rq4.querySelector('.pills')?.textContent || ''), rq2?.innerHTML.slice(0, 600))
  check('#85 tree: the question\'s tooltip names its choices and when it expires', (() => { const el = rq1.querySelector('.ln[data-tip]'); if (!el) return false; el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); const t = el.getAttribute('title') || ''; return /choices: Postgres · SQLite/.test(t) && /expires/.test(t) && /click \(or right-click → Answer…\)/.test(t) })())
  // the badge: collapse lead → "? 1"; the session header "? 3" (lead/@?1 + @Rel/@?1 + wc/@?1); the project header too; the section tag
  tog(in85('lead'))
  const rl = in85('lead')
  check('#85 badge: a COLLAPSED ancestor of an open question shows "? 1" (the answered one does not count); expanded it shows none', rl?.getAttribute('aria-expanded') === 'false' && rl.querySelector('.qbadge')?.textContent === '? 1' && !in85('@Rel')?.querySelector('.qbadge'), rl?.innerHTML.slice(0, 400))
  check('#85 badge: the SESSION header counts every open question in it ("? 3", the older host\'s too), the PROJECT header too, and the section tag "? N open questions"',
    nmRow('Ask85')?.querySelector('.qbadge')?.textContent === '? 3' && /\? 3/.test(rowsT().find(r => r.classList.contains('proj') && /A85/i.test(r.textContent))?.querySelector('.qbadge')?.textContent || '') && /\? \d+ open questions?/.test(doc.getElementById('acttag').textContent), doc.getElementById('acttag').textContent)
  const ord = rowsT().map(r => r.querySelector('.nm')?.getAttribute('title')).filter(Boolean)
  check('#85 rows keep their order (a question is a context: after plan items, by rank — nothing jumps to the top)', ord.indexOf('@Rel/@?1') < ord.indexOf('@Rel/@?2'), J(ord))
  tog(in85('lead'))
  // the menu
  const mEl = () => doc.querySelector('.act-menu'), mLab = () => [...(mEl()?.querySelectorAll('.mi') || [])].map(b => b.textContent)
  const rc = el => el.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
  const pick = label => { const b = [...(mEl()?.querySelectorAll('.mi') || [])].find(x => x.textContent === label); if (b) click(b); return !!b }
  const escK = el => (el || doc).dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const dlg = () => doc.querySelector('.act-dlg')
  const typeIn = (el, v) => { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })) }
  rc(in85('lead/@?1')); const l1 = mLab(); escK()
  rc(in85('wc/@?1')); const l5 = mLab(); escK()
  rc(in85('lead/@?2')); const l2 = mLab(); escK()
  check('#85 menu: an open question on this host → Answer… + Withdraw question… (no Edit text…, no Abandon…); on an OLDER host (no remote_hosts[].ask) → hidden; an answered one → neither',
    l1[0] === 'Answer…' && l1[1] === 'Withdraw question…' && !l1.includes('Edit text…') && !l1.includes('Abandon…') && !l5.includes('Answer…') && !l5.includes('Withdraw question…') && !l2.includes('Answer…'), J([l1, l5, l2]))
  // the ANSWER dialog — from the menu
  const nA = sentOf('activity_action').length
  rc(in85('lead/@?1')); pick('Answer…')
  const ad = dlg(), okA = ad?.querySelector('[data-dlg="ok"]'), cbs = [...(ad?.querySelectorAll('[data-qc]') || [])]
  check('#85 Answer…: a dialog with the question, its CHOICES as buttons (a radio group, none picked), no text box (choices only); Answer disabled ("Pick a choice."); it says the subject carries only the path + first words',
    !!ad && /Answer Ask85 — lead\/@\?1/.test(ad.querySelector('h3').textContent) && ad.querySelector('.qtext')?.textContent === 'Postgres or SQLite for the cache?' && cbs.length === 2 && cbs.every(b => b.getAttribute('aria-checked') === 'false' && b.getAttribute('role') === 'radio')
    && !!ad.querySelector('[role="radiogroup"]') && !ad.querySelector('textarea') && okA.disabled && /Pick a choice/.test(ad.querySelector('.dlg-why').textContent) && /first words/.test(ad.textContent) && /expires/.test(ad.textContent), ad?.outerHTML.slice(0, 800))
  click(cbs[1])
  check('#85 picking a choice: it is checked (aria-checked), the others not; Answer enabled', cbs[1].getAttribute('aria-checked') === 'true' && cbs[0].getAttribute('aria-checked') === 'false' && !okA.disabled)
  click(cbs[1])
  const unp = cbs[1].getAttribute('aria-checked') === 'false' && okA.disabled
  click(cbs[0]); click(okA)
  const sa = sentOf('activity_action').at(-1)
  check('#85 clicking it again un-picks it; Answer sends {action:"answer", host HOST-A, session, path, args:{choice:"Postgres"}} (no text) and closes', unp && sentOf('activity_action').length === nA + 1 && sa.action === 'answer' && sa.host === 'HOST-A' && sa.session === 'Ask85' && sa.path === 'lead/@?1' && sa.args.choice === 'Postgres' && !('text' in sa.args) && !dlg(), J(sa))
  recv({ type: 'activity_action', ref: sa.ref, result: { ok: true, host: 'HOST-A', action: 'answer', path: 'lead/@?1', applied: [{ path: 'lead/@?1', state: 'done' }], delivered: true, delivery: 'live', released: 1 } })
  check('#85 the result: ✓ answered on the row + a toast "Answer sent — a waiting script got it and Ask85 was told"', /✓ answered/.test(in85('lead/@?1')?.querySelector('.fb')?.textContent || '') && [...doc.querySelectorAll('.act-toast')].some(t => t.textContent === 'Answer sent — a waiting script got it and Ask85 was told'), [...doc.querySelectorAll('.act-toast')].map(t => t.textContent).join(' | '))
  // a CLICK on an open free-text question opens the dialog (and selects it)
  click(in85('@Rel/@?1'))
  const fd = dlg(), ta = fd?.querySelector('textarea#actAnsT'), okF = fd?.querySelector('[data-dlg="ok"]')
  check('#85 a click on an OPEN question opens Answer… (a free-text one: a focused text box, no choice buttons; "Write an answer.")', !!fd && !!ta && !fd.querySelector('[data-qc]') && doc.activeElement === ta && okF.disabled && /Write an answer/.test(fd.querySelector('.dlg-why').textContent) && fd.querySelector('.dlg-n').textContent === '0 / 1000', fd?.outerHTML.slice(0, 500))
  typeIn(ta, 'x'.repeat(1001))
  const tooLong = okF.disabled && /Too long: 1001 of 1000/.test(fd.querySelector('.dlg-why').textContent)
  typeIn(ta, 'Use "Fixed" and "Added".\nKeep it short.')
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  const sf = sentOf('activity_action').at(-1)
  check('#85 free text: 1001 characters → disabled; Ctrl+Enter sends {action:"answer", args:{text} — newlines kept, no choice}', tooLong && sf.action === 'answer' && sf.path === '@Rel/@?1' && sf.args.text === 'Use "Fixed" and "Added".\nKeep it short.' && !('choice' in sf.args) && !dlg(), J(sf))
  recv({ type: 'activity_action', ref: sf.ref, result: { ok: true, host: 'HOST-A', action: 'answer', path: '@Rel/@?1', applied: [], delivered: false, delivery: 'none', released: 0, warnings: ['not-delivered'] } })
  check('#85 an answer nobody received (no inbox, no waiting script): an amber "⚠ answered · nobody was waiting" and a toast saying it is on the board', /⚠ answered · nobody was waiting/.test(in85('@Rel/@?1')?.querySelector('.fb')?.textContent || '') && [...doc.querySelectorAll('.act-toast')].some(t => /on the board/.test(t.textContent)))
  // a click on an older host's open question: selected, no dialog
  click(in85('wc/@?1'))
  check('#85 a click on an open question on an OLDER host only selects it (no dialog)', !dlg() && V.sel && V.sel.path === 'wc/@?1')
  // WITHDRAW
  rc(in85('lead/@?1')); pick('Withdraw question…')
  const wd = dlg()
  check('#85 Withdraw question… asks first (Cancel focused), naming the question', !!wd && /Withdraw this question/.test(wd.querySelector('h3').textContent) && /Postgres or SQLite for the cache\?/.test(wd.textContent) && doc.activeElement === wd.querySelector('[data-dlg="cancel"]'))
  click(wd.querySelector('[data-dlg="ok"]'))
  const sw = sentOf('activity_action').at(-1)
  check('#85 confirming sends {action:"withdraw", path}', sw.action === 'withdraw' && sw.path === 'lead/@?1' && sw.host === 'HOST-A', J(sw))
  // the answered question after a delta: the row turns green, the badge drops
  recv({ type: 'activity_delta', epoch: 'E85', seq: 2, base: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15, finished_plan_open_min: 120, user: 'robin', log_cmd: null, remote_hosts: [{ host: 'HOST-C', plan: true, msg: true }] },
    upsert: [n85('lead/@?1', 'context', { state: 'done', current: qline('q1b', 'Postgres or SQLite for the cache?', 'answered', { choices: ['Postgres', 'SQLite'], free: false, answer: { choice: 'Postgres' }, by: { user: 'robin', host: 'HOST-A' }, at: NOW }) })], remove: [] })
  const r1b = in85('lead/@?1')
  check('#85 a delta: the answered question turns green (no "awaiting answer"), the session badge drops to "? 2"', !!r1b && !r1b.classList.contains('qopen') && r1b.querySelector('.qa')?.textContent === '→ Postgres' && nmRow('Ask85')?.querySelector('.qbadge')?.textContent === '? 2', r1b?.innerHTML.slice(0, 300))
  const css85 = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n')
  check('#85 CSS: the question colours are theme tokens (--ask, --ask-bg) defined for light AND dark', /--ask:#[0-9A-F]{6}; --ask-bg:#[0-9A-F]{6}/.test(css85) && (css85.match(/--ask:#/g) || []).length === 3 && /\.qbadge \{[^}]*var\(--ask\)/.test(css85) && /\.ar\.qopen \{[^}]*var\(--ask-bg\)/.test(css85))
} catch (e) { fail++; console.log('FAIL #85 block crashed:', (e && e.stack) || e) }

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))
try {   // ================================================================= #86 (v1.72.0): the DETAILS section (a node's line, facts, details + data fetched on
  // demand by its entry id), the JSON tree + Copy, the ¶ {} markers, ESCAPING; #87 (v1.72.0): the log ORDER — oldest first (chat-style), following
  // the newest end, the "N new ↓" chip, load older keeping the reader's place, the newest-first toggle (per viewer) with storage that throws
  // ---- the pure part
  const ents = ['a', 'b', 'c', 'd'].map(id => ({ id }))   // newest first, as the bridge pages them
  const ord = (rows) => rows.map(r => r.sep ? '|' : r.e.id).join('')
  check('#87 logRows: oldest first reverses the bridge\'s newest-first list; the "earlier runs" separator sits between the runs in BOTH orders (sepAt = the first earlier-run entry)',
    ord(X.logRows(ents, null, true)) === 'dcba' && ord(X.logRows(ents, null, false)) === 'abcd' && ord(X.logRows(ents, 2, true)) === 'dc|ba' && ord(X.logRows(ents, 2, false)) === 'ab|cd'
    && ord(X.logRows(ents, 4, true)) === 'dcba' && ord(X.logRows([], 0, true)) === '', J([ord(X.logRows(ents, 2, true)), ord(X.logRows(ents, 2, false))]))
  const m1 = X.mergeNewest([{ id: 'c3' }, { id: 'c2' }, { id: 'c1' }], [{ id: 'c5' }, { id: 'c4' }, { id: 'c3' }, { id: 'c2' }]), m2 = X.mergeNewest([{ id: 'c3' }], [{ id: 'x2' }, { id: 'x1' }]), m3 = X.mergeNewest([], [{ id: 'y' }])
  check('#87 mergeNewest: a fresh first page puts only the NEWER entries on top (older pages kept); no overlap (more than a page arrived) or nothing held → replace',
    !m1.replace && m1.added === 2 && m1.entries.map(e => e.id).join() === 'c5,c4,c3,c2,c1' && m2.replace && m2.entries.map(e => e.id).join() === 'x2,x1' && m3.replace && m3.added === 1, J([m1, m2]))
  check('#87 atEdge: oldest first = within 24 px of the BOTTOM, newest first = of the TOP', X.atEdge(476, 1000, 500, true) && !X.atEdge(400, 1000, 500, true) && X.edgeDist(400, 1000, 500, true) === 100 && X.atEdge(0, 1000, 500, false) && !X.atEdge(30, 1000, 500, false) && X.EDGE_PX === 24)
  const factsOf = (u, o) => Object.fromEntries(X.nodeFacts(u, null, { now: NOW, sm: 15, ...o }).map(f => [f.k, f.v]))
  const fa = factsOf({ nkind: 'agent', path: 'worker', host: 'HOST-A', created_at: NOW - 60 * MIN, last_activity: NOW - MIN, eta_at: NOW + 30 * MIN, progress: { done: 3, skipped: 1, total: 8, unit: 'files' },
    current: { id: 'w', ts: NOW - MIN, text: 'crunching', state: 'running', by: { kind: 'dashboard', user: 'robin', host: 'HOST-A' } } }, { session: 'Det86', project: 'D86', user: 'robin', n: 12, partial: true })
  check('#86 nodeFacts: an agent — kind, state, THREE-PART progress (done · skipped of total, %), ETA, who (session · project · user on its host), when its line was set and by whom (#83 line_by), when (started · last activity), the log count',
    fa.Kind === 'agent' && fa.State === 'running' && fa.Progress === '3 of 8 files · 1 skipped (37%) — reported' && /^ETA ~30m/.test(fa.ETA) && fa.Who === 'Det86 · D86 · robin on HOST-A' && !('Path' in fa)
    && /edited by robin via dashboard \(HOST-A\)/.test(fa['Line set']) && /^started .*\d\d:\d\d:\d\d · last activity .*\d\d:\d\d:\d\d$/.test(fa.When)   /* (a date prefix before 01:00: not today) */ && fa.Log === '12+ entries (this node and below)', J(fa))
  const fq = factsOf({ nkind: 'context', path: 'w/@?1', host: 'HOST-A', created_at: NOW - 5 * MIN, current: { id: 'q', ts: NOW - MIN, text: 'Ship?', state: 'done', question: { status: 'answered', choices: ['Yes', 'No'], free: true, asked_at: NOW - 5 * MIN, answer: { choice: 'Yes', text: 'after review' }, by: { user: 'robin', host: 'HOST-A' }, at: NOW - MIN } } }, {})
  const fq2 = factsOf({ nkind: 'context', path: 'w/@?2', host: 'HOST-A', current: { id: 'q2', ts: NOW, text: 'Which?', state: 'blocked', question: { status: 'asked', choices: [], free: true, asked_at: NOW - MIN, expires_at: NOW + 60 * MIN } } }, {})
  check('#86 nodeFacts: a QUESTION — its status, choices (or free text), asked, expires (while open), the answer and who answered when; a plan item says its item state; a root says "session"',
    fq.Kind === 'question' && fq.State === 'answered' && fq.Choices === 'Yes · No (or free text)' && fq.Answer === 'Yes — after review' && /^by robin via dashboard \(HOST-A\) at /.test(fq.Answered) && !!fq.Asked && !fq.Expires
    && fq2.State === 'awaiting an answer' && fq2.Choices === 'free text' && !!fq2.Expires && !fq2.Answer
    && / · item done$/.test(factsOf({ nkind: 'context', plan_item: true, current: { id: 'p', ts: NOW, text: 'X', state: 'done' } }, {}).State) && /^session — its own line on HOST-A$/.test(factsOf({ nkind: 'agent', host: 'HOST-A' }, { kind: 'session' }).Kind), J([fq, fq2]))
  const evil = { '<img src=x onerror="window.__pwned=1">': '<script>window.__pwned=2</script>', list: [1, null, true, 'two'], nested: { a: { b: { c: 'deep' } } }, big: Array.from({ length: 60 }, (_, i) => i), empty: {} }
  const jt = X.jsonTree(evil, doc)
  check('#86 jsonTree: DOM + textContent only — a key or value holding HTML is TEXT (no <img> / <script> element), strings quoted, types classed; open to depth 2, deeper / > 50 items closed; empty {} shown',
    !jt.querySelector('img, script, b') && jt.textContent.includes('<img src=x onerror="window.__pwned=1">') && jt.textContent.includes('"<script>window.__pwned=2</script>"') && !!jt.querySelector('.j-null') && !!jt.querySelector('.j-bool') && !!jt.querySelector('.j-num')
    && jt.querySelector('details').open && [...jt.querySelectorAll('summary')].find(s => /^a: /.test(s.textContent))?.parentElement.open === false && [...jt.querySelectorAll('summary')].find(s => /^nested: /.test(s.textContent))?.parentElement.open === true
    && [...jt.querySelectorAll('summary')].find(s => /^big: \[ 60 items \]/.test(s.textContent))?.parentElement.open === false && /empty: \{\}/.test(jt.textContent) && X.jsonTree('just text', doc).textContent === '"just text"', jt.innerHTML.slice(0, 400))
  check('#86 ddGlyph / ddWhat: ¶ = details, {} = data', X.ddGlyph({ has_details: true, has_data: true }) === '¶{}' && X.ddGlyph({ has_data: true }) === '{}' && X.ddWhat({ has_details: true, has_data: true }) === 'details and data' && X.ddGlyph(null) === '')
  // ---- the board: Det86 (HOST-A + HOST-B): worker (a line with details + data, edited from the dashboard), plain (no details), remote (on B, data)
  const n86 = (p, nk, extra = {}) => node('k-d86', p, nk, extra.host || 'HOST-A', extra)
  const self86 = root('HOST-A', { current: { id: 's86', ts: NOW - MIN, text: 'detailing', state: 'running', has_details: true } })
  const plainLog = { entries: 8, dropped: 0 }
  const u86 = () => [
    sess('k-d86', 'Det86', 'D86', { hosts: ['HOST-A', 'HOST-B'], multi_host: true, self: self86, selves: [self86, root('HOST-B', { log: { remote: true } })] }),
    n86('worker', 'agent', { current: { id: 'w86', ts: NOW - MIN, text: 'crunching {progress}', state: 'running', has_details: true, has_data: true, by: { kind: 'dashboard', user: 'robin', host: 'HOST-A' } }, progress: { done: 3, skipped: 1, total: 8, unit: 'files' }, eta_at: NOW + 30 * MIN }),
    n86('plain', 'agent', { current: { id: 'p86', ts: NOW - MIN, text: 'nothing extra', state: 'running' }, log: plainLog }),
    n86('remote', 'agent', { host: 'HOST-B', current: { id: 'rm86', ts: NOW - MIN, text: 'over there', state: 'running', has_data: true }, log: { remote: true, total: 1 } }),
  ]
  const head86 = { host: 'HOST-A', now: NOW, stale_after_min: 15, finished_plan_open_min: 120, user: 'robin', log_cmd: null, remote_hosts: [{ host: 'HOST-B', plan: true, msg: true, ask: true }] }
  recv({ type: 'activity_board', full: true, epoch: 'E86', seq: 1, head: head86, upsert: u86() })
  const in86 = (pth, host = 'HOST-A') => rowsT().find(r => r.getAttribute('data-session') === 'Det86' && r.getAttribute('data-path') === pth && (r.getAttribute('data-host') || '') === host)
  const wRow = in86('worker'), pRow = in86('plain'), rRow = in86('remote', 'HOST-B')
  const mkTip = el => { el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); return el.getAttribute('title') || '' }
  check('#86 markers: a row whose line has details + data shows "¶{}" inside its line (after ✎, the bar column untouched); data only "{}"; none without; the session row "¶"; hover says to select it',
    wRow?.querySelector('.ln .ddm')?.textContent === '¶{}' && wRow.querySelector('.ln .ddm').getAttribute('aria-label') === 'has details and data' && [...wRow.querySelector('.ln').children].map(c => c.className).join() === 'lt,edby,ddm'
    && wRow.children[wRow.children.length - 3] === wRow.querySelector('.pb') && rRow?.querySelector('.ddm')?.textContent === '{}' && !pRow?.querySelector('.ddm') && nmRow('Det86')?.querySelector('.ddm')?.textContent === '¶'
    && /select it to see them in the panel/.test(mkTip(wRow.querySelector('.ddm'))), wRow?.innerHTML.slice(0, 600))
  // ---- select the worker: the details section, then the on-demand fetch
  const nE0 = sentOf('activity').length
  click(wRow)
  const lq86 = sentOf('activity').at(-1)
  const PD = () => doc.getElementById('actpd')
  const dd = () => PD()?.querySelector('.apd-d'), facts = () => Object.fromEntries([...(PD()?.querySelectorAll('.apd-f dt') || [])].map(dt => [dt.textContent, dt.nextElementSibling?.textContent]))
  check('#86 details section: at the TOP of the panel (above the log list), open, the node\'s rendered line and its facts (three-part progress, ETA, the ✎ attribution); "loading its details…" while the fetch is scheduled',
    lq86.query.log?.path === 'worker' && !!PD() && !PD().hidden && PD().nextElementSibling?.classList.contains('apw') && PD().previousElementSibling?.id === 'actph' && PD().querySelector('.apd-t').getAttribute('aria-expanded') === 'true'
    && PD().querySelector('.apd-l').textContent === 'crunching 3 of 8 files · 1 skipped' && facts().Progress === '3 of 8 files · 1 skipped (37%) — reported' && /^ETA/.test(facts().ETA) && /edited by robin via dashboard/.test(facts()['Line set'])
    && PD().querySelector('.apd-m').textContent === '¶{}' && /loading its details/.test(dd()?.textContent || '') && sentOf('activity').length === nE0 + 1, J([facts(), PD()?.textContent.slice(0, 300)]))
  await tick()
  const eq86 = sentOf('activity').at(-1)
  check('#86 on demand: the details are fetched by the line\'s ENTRY id + the node\'s host (activity {entry:{id, host}}) — nothing about them came with the board', eq86.query.entry?.id === 'w86' && eq86.query.entry.host === 'HOST-A' && sentOf('activity').length === nE0 + 2, J(eq86))
  const evilDetails = '<img src=x onerror="window.__pwned=1">\nline two & <b>three</b>'
  recv({ type: 'activity', ref: eq86.ref, result: { ok: true, entry: { id: 'w86', details: evilDetails, data: evil } } })
  check('#86 ESCAPING: details holding <img onerror> / <b> and data whose keys and values hold <script> render as TEXT — no such element anywhere in the panel, nothing ran',
    !PANEL.querySelector('img, script, b') && win.__pwned === undefined && dd().querySelector('pre.dtx')?.textContent === evilDetails && dd().querySelector('.jt')?.textContent.includes('<script>window.__pwned=2</script>'), dd()?.innerHTML.slice(0, 500))
  const copies = [...dd().querySelectorAll('.cp')]
  click(copies[1])
  const cData = V.lastCopy
  click(copies[0])
  check('#86 Copy: the data as pretty JSON, the details as text (one button each)', copies.length === 2 && cData === J(evil, null, 2) && V.lastCopy === evilDetails, J([copies.length, cData?.slice(0, 60)]))
  const aSum = [...dd().querySelectorAll('.jt summary')].find(s => /^a: /.test(s.textContent)), aDet = aSum.parentElement
  aDet.open = true
  recv({ type: 'activity_delta', epoch: 'E86', seq: 2, base: 1, head: head86, upsert: [n86('plain', 'agent', { current: { id: 'p86b', ts: NOW, text: 'still nothing extra', state: 'running' }, log: plainLog })], remove: [] })
  check('#86 the tree is not rebuilt by unrelated deltas or the 1 s re-render: a node the viewer opened stays open (same element)', dd().contains(aDet) && aDet.open)
  // the line moves on → the next fetch; the last details stay shown ("updating") until it lands
  recv({ type: 'activity_delta', epoch: 'E86', seq: 3, base: 2, head: head86, upsert: [n86('worker', 'agent', { current: { id: 'w86b', ts: NOW, text: 'crunching more', state: 'running', has_data: true }, progress: { done: 4, skipped: 1, total: 8, unit: 'files' } })], remove: [] })
  await tick()
  const eq86b = sentOf('activity').at(-1)
  check('#86 a new line → its entry is fetched; meanwhile the previous details stay, marked "updating"', eq86b.query.entry?.id === 'w86b' && /updating/.test(dd().textContent) && !!dd().querySelector('pre.dtx') && PD().querySelector('.apd-l').textContent === 'crunching more' && PD().querySelector('.apd-m').textContent === '{}', J(eq86b))
  recv({ type: 'activity', ref: eq86b.ref, result: { ok: true, entry: { id: 'w86b', data: { files: ['a.txt', 'b.txt'] } } } })
  check('#86 ... then the new data (a JSON array tree), no details, no "updating"', !/updating/.test(dd().textContent) && !dd().querySelector('pre') && /files: \[ 2 items \]/.test(dd().textContent) && /"a\.txt"/.test(dd().textContent))
  // collapse the section: nothing more is fetched while it is closed
  click(PD().querySelector('[data-pa="det"]'))
  check('#86 the section collapses to its header (aria-expanded false; the marker stays visible)', PD().querySelector('.apd-b').hidden && PD().querySelector('.apd-t').getAttribute('aria-expanded') === 'false' && PD().querySelector('.apd-m').textContent === '{}')
  const nClosed = sentOf('activity').length
  recv({ type: 'activity_delta', epoch: 'E86', seq: 4, base: 3, head: head86, upsert: [n86('worker', 'agent', { current: { id: 'w86c', ts: NOW, text: 'crunching still', state: 'running', has_data: true } })], remove: [] })
  await tick()
  check('#86 ... and a closed section fetches nothing', sentOf('activity').length === nClosed)
  click(PD().querySelector('[data-pa="det"]'))
  await tick()
  check('#86 opened again → it fetches the current line\'s entry', sentOf('activity').at(-1).query.entry?.id === 'w86c' && !PD().querySelector('.apd-b').hidden)
  // a REMOTE node: fetched from its owner; an unreachable owner degrades to a sentence + Retry
  click(rRow)
  await tick()
  const eqR = sentOf('activity').at(-1)
  check('#86 a remote node (HOST-B): its entry is asked for WITH its host (the gateway forwards it to the owner over the hub link)', eqR.query.entry?.id === 'rm86' && eqR.query.entry.host === 'HOST-B', J(eqR))
  recv({ type: 'activity', ref: eqR.ref, result: { ok: false, code: 'owner-unreachable', what: 'host HOST-B is not linked' } })
  check('#86 an unreachable owner: "The details are on HOST-B, which can\'t be reached right now" + a Retry button', /The details are on HOST-B, which can't be reached right now/.test(dd().textContent) && !!dd().querySelector('button'), dd()?.textContent)
  click(dd().querySelector('button'))
  check('#86 Retry asks again', sentOf('activity').at(-1).query.entry?.id === 'rm86')
  recv({ type: 'activity', ref: sentOf('activity').at(-1).ref, result: { ok: false, code: 'owner-unsupported', what: 'older' } })
  check('#86 an owner that cannot answer says it runs an older bridge (the sentence, not a code)', /The details are on HOST-B, which runs an older bridge/.test(dd().textContent))
  // the session row: its own line on that host
  click(nmRow('Det86'))
  check('#86 a SESSION selected: the section shows its own line on that host ("session — its own line on HOST-A")', /^session — its own line on HOST-A$/.test(facts().Kind || '') && PD().querySelector('.apd-l').textContent === 'detailing' && /^Det86 · D86 · robin on HOST-A$/.test(facts().Who || ''), J(facts()))
  click(pRow)
  check('#86 a node without details or data: the facts, and "Its line has no details or data." (nothing fetched)', /Its line has no details or data/.test(dd().textContent) && !!facts().State)
  // ---- a LOG ENTRY's details: the same block (marker, escaping, JSON tree)
  const lqP = sentOf('activity').filter(m => m.query.log).at(-1)
  recv({ type: 'activity', ref: lqP.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'pe2', ts: NOW - MIN, path: 'plain', rel: '', text: 'with data', rendered: 'with data', state: 'running', has_details: true, has_data: true }, { id: 'pe1', ts: NOW - 2 * MIN, path: 'plain', rel: '', text: 'first', rendered: 'first', state: 'running' }], next_cursor: null } } })
  const le86 = pRows().find(r => r.getAttribute('data-id') === 'pe2')
  check('#86 a log entry with details / data carries the same ¶{} marker (6d had "⋯")', le86?.querySelector('.ddm')?.textContent === '¶{}' && !/⋯/.test(le86.textContent) && !pRows().find(r => r.getAttribute('data-id') === 'pe1').querySelector('.ddm'))
  click(le86)
  const eqE = sentOf('activity').at(-1)
  recv({ type: 'activity', ref: eqE.ref, result: { ok: true, entry: { id: 'pe2', details: '<img src=y onerror="window.__pwned=3">', data: { '<b>k</b>': [1, 2] } } } })
  const adE = PANEL.querySelector('.apb .ad')
  check('#86 ... expanded: details as text + data as a JSON tree, escaped (no <img> / <b> element), right BELOW its entry (oldest first too)', eqE.query.entry?.id === 'pe2' && !!adE && !adE.querySelector('img, b') && win.__pwned === undefined && adE.querySelector('pre.dtx')?.textContent === '<img src=y onerror="window.__pwned=3">' && /<b>k<\/b>: \[ 2 items \]/.test(adE.textContent) && adE.previousElementSibling === le86, adE?.innerHTML.slice(0, 300))
  // ================= #87: oldest first, following, the chip, load older keeping the place, the toggle
  // a fake LAYOUT (jsdom has none): rows in the log list are 20 px each, the list shows 100 px
  const RH = 20, CH = 100, proto = win.HTMLElement.prototype
  const savedTop = Object.getOwnPropertyDescriptor(proto, 'offsetTop'), savedH = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get() { return this.parentElement && this.parentElement.id === 'actpb' ? RH : 0 } })
  Object.defineProperty(proto, 'offsetTop', { configurable: true, get() { const p = this.parentElement; return p && p.id === 'actpb' ? [...p.children].indexOf(this) * RH : 0 } })
  const PB = () => doc.getElementById('actpb')
  const layout = pb => { if (pb._fake) return; pb._fake = true; let st = 0
    Object.defineProperty(pb, 'scrollHeight', { configurable: true, get() { return pb.children.length * RH } }); Object.defineProperty(pb, 'clientHeight', { configurable: true, get() { return CH } })
    Object.defineProperty(pb, 'scrollTop', { configurable: true, get() { return st }, set(v) { st = Math.max(0, Math.min(Number(v) || 0, Math.max(0, pb.scrollHeight - CH))) } }) }
  const scrollTo = y => { PB().scrollTop = y; PB().dispatchEvent(new win.Event('scroll')) }
  const ids = () => [...PB().children].map(r => r.getAttribute('data-id') || (r.classList.contains('more') ? 'more' : r.className))
  const chip = () => doc.getElementById('actnew')
  const pl = i => ({ id: `p${i}`, ts: NOW - (20 - i) * MIN, path: 'plain', rel: '', text: `entry ${i}`, rendered: `entry ${i}`, state: 'running' })
  layout(PB())
  click(in86('remote', 'HOST-B')); click(pRow)   // a fresh selection of plain (at the edge again)
  const lq1 = sentOf('activity').filter(m => m.query.log).at(-1)
  recv({ type: 'activity', ref: lq1.ref, result: { ok: true, log: { host: 'HOST-A', entries: [8, 7, 6, 5, 4, 3, 2, 1].map(pl), next_cursor: 'cur-1', total: 8 } } })
  check('#87 oldest first: "load older…" at the TOP, then the oldest … newest at the bottom; the list opens at the BOTTOM (following)', J(ids()) === J(['more', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) && /load older/.test(PB().children[0].textContent) && PB().scrollTop === 9 * RH - CH && V.follow === true, J([ids(), PB().scrollTop]))
  scrollTo(0)
  check('#87 scrolling up (away from the bottom) pauses following', V.follow === false && chip().hidden)
  for (const L of Object.values(V.logs)) L.at = 0   // (the poll waits 1.5 s after the last read)
  recv({ type: 'activity_delta', epoch: 'E86', seq: 5, base: 4, head: head86, upsert: [n86('plain', 'agent', { current: { id: 'p10', ts: NOW, text: 'entry 10', state: 'running' }, log: { entries: 10, dropped: 0 } })], remove: [] })
  const pq = sentOf('activity').filter(m => m.query.log).at(-1)
  check('#87 new entries (the board\'s count moved) → the FIRST page is read again (no cursor) — not the whole log', pq !== lq1 && !pq.query.log.cursor && pq.query.log.path === 'plain', J(pq.query))
  recv({ type: 'activity', ref: pq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(pl), next_cursor: 'cur-x', total: 10 } } })
  check('#87 ... MERGED: the 2 new entries go to the bottom, the reader\'s place is kept (scrollTop unchanged), the cursor of the older pages kept, and a "2 new ↓" chip shows',
    J(ids().slice(-3)) === J(['p8', 'p9', 'p10']) && ids().length === 11 && PB().scrollTop === 0 && !chip().hidden && chip().textContent === '2 new ↓' && Object.values(V.logs).some(L => L.next === 'cur-1'), J([ids(), PB().scrollTop, chip().textContent]))
  click(chip())
  check('#87 the chip jumps to the newest and follows again (it hides)', PB().scrollTop === 11 * RH - CH && V.follow === true && chip().hidden && V.newN === 0)
  // load older: the place is kept (the first visible entry stays where it was)
  scrollTo(10)   // p1 (row 1, at 20 px) is the first visible entry, 10 px down the view
  click(PB().children[0])
  const oq = sentOf('activity').filter(m => m.query.log).at(-1)
  check('#87 "load older…" (at the top) asks with the cursor', oq.query.log.cursor === 'cur-1' && V.follow === false, J(oq.query))
  recv({ type: 'activity', ref: oq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [0, -1, -2].map(pl), next_cursor: null } } })
  const p1Row = [...PB().children].find(r => r.getAttribute('data-id') === 'p1')
  check('#87 ... the older entries go ABOVE and the view does not jump: p1 stays 10 px down the view (scrollTop moves by what was added)', J(ids().slice(0, 4)) === J(['p-2', 'p-1', 'p0', 'p1']) && p1Row.offsetTop - PB().scrollTop === 10 && V.follow === false, J([ids().slice(0, 5), PB().scrollTop]))
  // the TOGGLE: newest first, kept per viewer
  const ordB = () => PANEL.querySelector('[data-pa="order"]')
  check('#87 the header toggle says the order ("⇅ oldest first"), with a tooltip and an aria-label', /⇅ oldest first/.test(ordB()?.textContent || '') && /chat-style/.test(ordB().getAttribute('title')) && /Switch to newest first/.test(ordB().getAttribute('aria-label')))
  click(ordB())
  check('#87 toggled: newest first — the newest on top, the list at the TOP (following), remembered in localStorage', ids()[0] === 'p10' && ids().at(-1) === 'p-2' && PB().scrollTop === 0 && V.follow === true && win.localStorage.getItem('aimb.act.logOrder') === 'newest' && /⇅ newest first/.test(ordB().textContent), J(ids()))
  scrollTo(60)   // away from the top
  for (const L of Object.values(V.logs)) L.at = 0
  recv({ type: 'activity_delta', epoch: 'E86', seq: 6, base: 5, head: head86, upsert: [n86('plain', 'agent', { current: { id: 'p11', ts: NOW, text: 'entry 11', state: 'running' }, log: { entries: 11, dropped: 0 } })], remove: [] })
  const pq2 = sentOf('activity').filter(m => m.query.log).at(-1)
  recv({ type: 'activity', ref: pq2.ref, result: { ok: true, log: { host: 'HOST-A', entries: [11, 10, 9].map(pl), next_cursor: 'cur-y', total: 11 } } })
  check('#87 newest first, scrolled down: a new entry goes on top WITHOUT moving the view (scrollTop + one row) and the chip says "1 new ↑"', ids()[0] === 'p11' && PB().scrollTop === 80 && chip().textContent === '1 new ↑' && !chip().hidden && chip().classList.contains('top'), J([ids().slice(0, 3), PB().scrollTop, chip().textContent]))
  click(ordB())
  check('#87 toggled back: oldest first again (stored "oldest"), at the bottom', win.localStorage.getItem('aimb.act.logOrder') === 'oldest' && ids().at(-1) === 'p11' && V.follow === true && PB().scrollTop === PB().scrollHeight - CH)
  // storage that THROWS: the toggle still works (in memory); a page loaded with throwing / stored storage
  const realLS = Object.getOwnPropertyDescriptor(win, 'localStorage')
  Object.defineProperty(win, 'localStorage', { configurable: true, get() { throw new win.DOMException('denied', 'SecurityError') } })
  let threw = null; try { click(ordB()) } catch (e) { threw = e }
  check('#87 with storage that THROWS, the toggle still flips the order (kept for this page only)', !threw && ids()[0] === 'p11' && V.logOrder === 'newest', String(threw))
  click(ordB())
  if (realLS) Object.defineProperty(win, 'localStorage', realLS); else delete win.localStorage
  if (savedTop) Object.defineProperty(proto, 'offsetTop', savedTop); if (savedH) Object.defineProperty(proto, 'offsetHeight', savedH)
  // fresh pages: one whose storage throws on every access (it must load and default to oldest first), one that stored "newest"
  async function miniPage(before) {
    class WS2 { constructor() { this.readyState = 0; this.sent = []; WS2.last = this } send(s) { this.sent.push(JSON.parse(s)) } close() { this.readyState = 3 } }
    const errs = []
    const { VirtualConsole } = await import('jsdom')
    const vc = new VirtualConsole(); vc.on('jsdomError', e => errs.push(String(e && (e.stack || e.message || e))))
    const d2 = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1:12318/dashboard.html?token=t', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) { w.WebSocket = WS2; before(w) } })
    const w2 = d2.window, s2 = WS2.last, rc2 = m => s2.onmessage({ data: J(m) })
    try {
      s2.readyState = 1; s2.onopen && s2.onopen()
      rc2({ type: 'welcome', gateway: 'HOST-A/aaa', sessions: [], pages: [], hosts: {}, bridge_version: '1.72.0', profile: {}, capabilities: {} })
      rc2({ type: 'activity_board', full: true, epoch: 'M1', seq: 1, head: head86, upsert: u86() })
      const r2 = [...w2.document.querySelectorAll('#acttree .ar')].find(r => r.getAttribute('data-path') === 'plain')
      r2.dispatchEvent(new w2.MouseEvent('click', { bubbles: true }))
      const q2 = s2.sent.filter(m => m.type === 'activity' && m.query.log).at(-1)
      rc2({ type: 'activity', ref: q2.ref, result: { ok: true, log: { host: 'HOST-A', entries: [3, 2, 1].map(pl), next_cursor: null } } })
      const order = [...w2.document.querySelectorAll('#actpb .ar.le')].map(r => r.getAttribute('data-id'))
      return { order, errs, logOrder: w2.AimbActView.logOrder, btn: w2.document.querySelector('[data-pa="order"]')?.textContent }
    } finally { d2.window.close() }
  }
  const mThrow = await miniPage(w => Object.defineProperty(w, 'localStorage', { configurable: true, get() { throw new w.DOMException('denied', 'SecurityError') } }))
  check('#87 a page whose localStorage THROWS loads, renders the board and the log, oldest first (no script error)', J(mThrow.order) === J(['p1', 'p2', 'p3']) && mThrow.logOrder === 'oldest' && !mThrow.errs.length, J(mThrow))
  const mNew = await miniPage(w => { try { w.localStorage.setItem('aimb.act.logOrder', 'newest') } catch { } })
  check('#87 a viewer who chose newest first gets it on the next load (per viewer, localStorage)', J(mNew.order) === J(['p3', 'p2', 'p1']) && mNew.logOrder === 'newest' && /newest first/.test(mNew.btn || '') && !mNew.errs.length, J(mNew))
  const css86 = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n')
  check('#86 / #87 CSS: the panel is a column (header, details ≤ 45vh, the list scrolls by itself); 85vh on a narrow screen; the JSON tree + chip + marker use theme tokens',
    /\.act-panel \{[^}]*display:flex; flex-direction:column;/.test(css86) && /\.apd \{[^}]*max-height:45vh; overflow:auto;/.test(css86) && /\.act-panel \.apb \{[^}]*overflow:auto;/.test(css86) && /@media \(max-width: 900px\) \{[^\n]*\.act-panel \{[^}]*max-height:85vh;/.test(css86)
    && /\.jt \{[^}]*var\(--surface\)/.test(css86) && /\.jt \.j-str \{ color:var\(--ok\); \}/.test(css86) && /\.apnew \{[^}]*var\(--info\)/.test(css86) && /\.ddm \{[^}]*var\(--muted\)/.test(css86) && !/:has\(/.test(css86))
  check('#86 legend: names ¶ / {} and the log order', /¶ = its line has details/.test(doc.getElementById('actlegend').textContent) && /oldest first/.test(doc.getElementById('actlegend').textContent))
} catch (e) { fail++; console.log('FAIL #86/#87 block crashed:', (e && e.stack) || e) }
console.log(`\n${pass} passed, ${fail} failed`)
dom.window.close()
process.exit(fail ? 1 : 0)
