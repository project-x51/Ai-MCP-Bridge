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
check('tree (6a): the session\'s top level = nodes whose parent is the session, in CREATION order', J(kidsOf(orch)) === J(['research', 'build', 'deploy', 'old', 'longrun', '@#70']), J(kidsOf(orch)))
check('tree (6a): children nest by parent_key to any depth (agents and contexts alike)', J(kidsOf(find(orch.kids, 'research'))) === J(['research/sub', 'research/@Tharsis']) && J(kidsOf(find(orch.kids, 'research/@Tharsis'))) === J(['research/@Tharsis/@z12', 'research/@Tharsis/@nol'])
  && !!find(orch.kids, deepPath) && find(orch.kids, deepPath).u.depth === 6)
check('tree (6a): each node knows its OWNER — the nearest agent above it, else the session\'s self (for its host)', find(orch.kids, 'research/@Tharsis/@z12').owner.path === 'research' && find(orch.kids, 'research/sub').owner.path === 'research'
  && find(orch.kids, '@#70/@step4').owner === orchSelf && find(orch.kids, deepPath).owner.path === '@#70/@step4/spec-70')
const orphanTree = X.buildTree({ s: { id: 's', kind: 'session', key: 'k', session: 'S', project: 'P', self: root('H') }, o: node('k', 'p/@lost', 'context', 'H', { current: { id: 'x', ts: NOW, text: 'orphan', state: 'running' } }) }, {})
check('tree (6a): a node whose parent has not arrived (a truncated slice) sits at the top level until it does', J(kidsOf(orphanTree[0].sessions[0])) === J(['p/@lost']))
const act = X.buildTree(U, { activeOnly: true })
check('tree: active only hides finished + gone agents (with their subtrees) and sessions with nothing active (Leaver, Cee)', J(act.map(p => p.name)) === J(['AIMB']) && J(act[0].sessions.map(x => x.s.session)) === J(['Orch'])
  && J(kidsOf(act[0].sessions[0])) === J(['research', 'old', 'longrun', '@#70']))
check('subtreeCount: a subtree\'s local entries; null when any of it lives on another host', X.subtreeCount(find(orch.kids, 'research')) === 10 && X.subtreeCount({ u: { log: { remote: true } }, kids: [] }) === null)

// ================================================================= (2) the rendered view
ws.readyState = 1; ws.onopen && ws.onopen()
recv({ type: 'welcome', gateway: 'HOST-A/aaa', sessions: [], pages: [], hosts: {}, bridge_version: '1.62.0', profile: {}, capabilities: {} })
const sec = doc.querySelector('section.sec[data-sec="activity"]')
check('view: the Activity section exists, collapsed by default, and a closed one does NOT subscribe', !!sec && sec.classList.contains('collapsed') && sentOf('activity_sub').length === 0)
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('view: opening it subscribes (activity_sub)', !sec.classList.contains('collapsed') && sentOf('activity_sub').length === 1 && !sentOf('activity_sub')[0].resync)
recv({ type: 'activity_board', full: true, epoch: 'E1', seq: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15, remote_hosts: [] }, upsert: units })
const T = doc.getElementById('acttree')
const rowsT = () => [...T.querySelectorAll('.ar')]
const rowOf = re => rowsT().find(r => re.test(r.textContent))
const nmRow = name => rowsT().find(r => r.querySelector('.nm')?.textContent === name)
const pathRow = p => rowsT().find(r => r.querySelector('.nm')?.getAttribute('title') === p)
const click = el => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const dOf = r => Number(r?.style.getPropertyValue('--d'))
check('view: project rows with their counts', /AIMB2 sessions · 5 active agents/.test(rowOf(/^▾📁 AIMB/)?.textContent || '') && /Tools1 session · 0 active agents/.test(rowOf(/📁 Tools/)?.textContent || ''), rowsT().slice(0, 3).map(r => r.textContent).join(' | '))
const orchRow = nmRow('Orch')
check('view: the session row — name, one host tag per host, its own line RENDERED, a rollup bar, ⌛, 🔔', !!orchRow && J([...orchRow.querySelectorAll('.htag')].map(h => h.textContent)) === J(['HOST-A', 'HOST-B'])
  && orchRow.querySelector('.ln').textContent === 'coordinating 3 of 6 tasks' && !!orchRow.querySelector('.pb.roll') && /⌛/.test(orchRow.textContent) && /🔔/.test(orchRow.textContent), orchRow && orchRow.innerHTML)
const resRow = pathRow('research')
check('view (6a): the DEFAULT view = sessions + their top-level nodes; deeper nodes stay closed', !!resRow && !!pathRow('@#70') && !!pathRow('build') && !pathRow('research/sub') && !pathRow('research/@Tharsis') && !pathRow('@#70/@step4'))
check('view: an agent row — monospace name, glyph with the ring, rendered line, bar, ETA, host tag (multi-host)', resRow.querySelector('.nm.path')?.textContent === 'research' && resRow.querySelector('.ln').textContent === 'reading 4,812 of 12,000 tiles'
  && !!resRow.querySelector('svg.gl circle.ring') && /⌛/.test(resRow.textContent) && resRow.querySelector('.htag')?.textContent === 'HOST-A' && dOf(resRow) === 2)
const c70 = pathRow('@#70')
check('view (6a): an implicit grouping context — "@#70", no current line, the "none" mark, its rolled-up bar, no pills', c70.querySelector('.nm.ctx')?.textContent === '@#70' && /no current line/.test(c70.querySelector('.ln.none')?.textContent || '')
  && !!c70.querySelector('svg.s-none') && !!c70.querySelector('.pb.roll') && c70.querySelectorAll('.pill').length === 0)
// per-node expand: its subtree Log, then its children one level deeper
click(resRow)
const kidRows = () => rowsT().filter(r => dOf(r) === 3)
check('expand a node (6a): its Log row (the subtree) then its children (a sub-agent + a context), one level deeper', rowsT().some(r => r.classList.contains('lg') && dOf(r) === 3 && /10 entries, this node and below/.test(r.textContent))
  && !!pathRow('research/sub') && !!pathRow('research/@Tharsis') && dOf(pathRow('research/sub')) === 3 && dOf(pathRow('research/@Tharsis')) === 3, kidRows().map(r => r.textContent).join(' | '))
const thRow = pathRow('research/@Tharsis')
check('view (6a): a context row — "@Tharsis", a state MARK (no ring), its line rendered against its own bar, the bar; fresh because its agent is', thRow.querySelector('.nm.ctx')?.textContent === '@Tharsis' && !!thRow.querySelector('svg.gl.ctx') && !thRow.querySelector('circle.ring')
  && thRow.querySelector('.ln').textContent === 'tiling 2 of 8 tiles' && !!thRow.querySelector('.pb') && !thRow.classList.contains('stale'), thRow.innerHTML)
click(thRow)
const nol = pathRow('research/@Tharsis/@nol'), z12 = pathRow('research/@Tharsis/@z12')
check('view (6a): nested contexts (depth 3) under the open context; one with no line shows "no current line" and no pills', dOf(z12) === 4 && dOf(nol) === 4 && /no current line/.test(nol.textContent) && nol.querySelectorAll('.pill').length === 0 && z12.querySelector('.ln').textContent === 'strip z12')
const pills = r => [...(r?.querySelectorAll('.pill') || [])].map(p => p.className.replace('pill ', ''))
check('view: pills only for blocked / failed / stale / gone (running and done have none)', J(pills(pathRow('research/sub'))) === J(['blocked']) && J(pills(pathRow('deploy'))) === J(['failed']) && J(pills(pathRow('old'))) === J(['stale'])
  && J(pills(pathRow('w'))) === J(['gone']) && J(pills(resRow)) === '[]' && J(pills(pathRow('build'))) === '[]', J([pills(pathRow('research/sub')), pills(pathRow('deploy')), pills(pathRow('old')), pills(pathRow('w'))]))
click(pathRow('old'))
const oc = pathRow('old/@ctx')
check('view (6a): a context under a STALE agent shows stale (greyed + pill) — inherited, not its own', !!oc && oc.classList.contains('stale') && J(pills(oc)) === J(['stale']) && !!oc.querySelector('svg.gl.ctx.s-stale'), oc && oc.outerHTML)
check('view: host down is a DISTINCT badge (not "gone") on the host\'s session + agents; its host tag is marked', J(pills(pathRow('c1'))) === J(['hostdown']) && J(pills(nmRow('Cee'))) === J(['hostdown']) && !!nmRow('Cee').querySelector('.htag.down'), J([pills(pathRow('c1')), pills(nmRow('Cee'))]))
check('view: a stale row greys out (class stale); an item\'s own stale_after keeps it live', pathRow('old')?.classList.contains('stale') && !pathRow('longrun')?.classList.contains('stale') && !resRow.classList.contains('stale'))
check('view: no inline time text on status rows (times live in the hover tooltips)', rowsT().every(r => !/\bago\b|\d\d:\d\d|\b\d+m\b|\b\d+s\b/.test(r.querySelector('.ln')?.textContent + (r.querySelector('.nm')?.textContent || ''))), rowsT().map(r => r.textContent).filter(t => /ago|\d\d:\d\d/.test(t)).join(' | '))
// depth 6: open the chain down to the deepest node; indentation stays one step per level
for (const p of ['@#70', '@#70/@step4', '@#70/@step4/spec-70', '@#70/@step4/spec-70/@Tharsis', '@#70/@step4/spec-70/@Tharsis/@z12']) click(pathRow(p))
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
check('Collapse all closes every expanded row (back to the default view)', !rowsT().some(r => r.classList.contains('lg') || r.classList.contains('le')) && !pathRow('research/sub') && !!pathRow('research'))
// the session's Log (the whole session, per host)
click(nmRow('Orch'))
const logRows = () => rowsT().filter(r => r.classList.contains('lg'))
check('expand a multi-host session: one Log row per host (its whole subtree; a remote one says it lives there)', logRows().length === 2 && /entries, the whole session · HOST-A/.test(logRows()[0].textContent) && /the whole session · HOST-B/.test(logRows()[1].textContent), logRows().map(r => r.textContent).join(' | '))
click(logRows()[0])
const lq = sentOf('activity').pop()
check('the session Log asks for its page (session, project, user, host; no path = the session root\'s subtree)', lq?.query?.log?.session === 'Orch' && lq.query.log.host === 'HOST-A' && lq.query.log.project === 'AIMB' && lq.query.log.user === 'robin' && !('path' in lq.query.log) && lq.query.log.limit === 50, J(lq))
recv({ type: 'activity_queued', ref: lq.ref, wait_ms: 1500, position: 3 })
check('a queued fetch shows a spinner + its wait', /queued — about 2s/.test(T.textContent) && !!T.querySelector('.spin'))
recv({ type: 'activity', ref: lq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [
  { id: 'e3', ts: NOW - MIN, path: '', rel: '', current: true, text: 'coordinating {progress}', rendered: 'coordinating 3 of 6 tasks', state: 'running' },
  { id: 'e2', ts: NOW - 2 * MIN, path: 'research/@Tharsis/@z12', rel: 'research/@Tharsis/@z12', current: true, text: 'with attachments', rendered: 'with attachments', state: 'blocked', has_details: true, has_data: true }], next_cursor: 'f1.2026-10-02.120', total: 7 } } })
const eRows = () => rowsT().filter(r => r.classList.contains('le'))
check('log entries newest first: time, state dot, the entry\'s path RELATIVE to the node (@~ on a current line), rendered text', eRows().length === 2 && /^\d\d:\d\d:\d\d$/.test(eRows()[0].querySelector('.tm').textContent) && eRows()[0].querySelector('.ctag').textContent === '@~root'
  && eRows()[1].querySelector('.ctag').textContent === 'research/@Tharsis/@~z12' && eRows()[1].querySelector('.dot').classList.contains('bg-blocked') && eRows()[0].querySelector('.ln').textContent === 'coordinating 3 of 6 tasks', eRows().map(r => r.textContent).join(' | '))
const older = rowsT().find(r => /load older/.test(r.textContent))
click(older)
const lq2 = sentOf('activity').pop()
check('"load older" asks for the next page with the cursor', lq2.query.log.cursor === 'f1.2026-10-02.120' && lq2.query.log.host === 'HOST-A', J(lq2))
recv({ type: 'activity', ref: lq2.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'e1', ts: NOW - 3 * MIN, path: '', rel: '', text: 'started', rendered: 'started', state: 'running' }], next_cursor: null } } })
check('... the page appends, and the end of the log has no "load older"', eRows().length === 3 && !rowsT().some(r => /load older/.test(r.textContent)))
click(eRows()[1])
const eq = sentOf('activity').pop()
check('an entry with details/data expands → fetches it by id + host', eq.query.entry?.id === 'e2' && eq.query.entry.host === 'HOST-A', J(eq))
recv({ type: 'activity', ref: eq.ref, result: { ok: true, entry: { id: 'e2', details: 'DETAIL TEXT', data: { rows: 42, ok: true } } } })
const det = T.querySelector('.ad')
check('... showing the details text and the pretty-printed JSON', !!det && /DETAIL TEXT/.test(det.textContent) && det.querySelectorAll('pre')[1]?.textContent === J({ rows: 42, ok: true }, null, 2), det && det.innerHTML)
click(pathRow('research'))
const rLog = rowsT().find(x => x.classList.contains('lg') && /this node and below/.test(x.textContent))
click(rLog)
const aq = sentOf('activity').pop()
check('a node\'s Log asks with its PATH (+ host) — the subtree merged by the bridge', aq.query.log.path === 'research' && aq.query.log.host === 'HOST-A' && !('agent' in aq.query.log), J(aq))
recv({ type: 'activity', ref: aq.ref, result: { ok: false, code: 'busy', retry_after_ms: 800, what: 'too many history fetches are waiting' } })
check('a busy answer offers a retry', /busy: too many history fetches are waiting — click to retry/.test(T.textContent))
// deltas, a gap → resync, expand / collapse all, unsubscribe
recv({ type: 'activity_delta', epoch: 'E1', seq: 2, base: 1, head: { host: 'HOST-A', now: Date.now(), stale_after_min: 15 }, upsert: [{ ...units[1], current: { id: 'r9', ts: NOW, text: 'writing up', state: 'running' } }, node('k-orch', 'research/@new', 'context', 'HOST-A', { current: { id: 'nw', ts: NOW, text: 'a context that just appeared', state: 'running' } })], remove: [units[7].id] })
check('a delta updates a row in place, adds a nested node under its (open) parent, and removes another', pathRow('research').querySelector('.ln').textContent === 'writing up' && !pathRow('deploy') && !!pathRow('research/@new') && dOf(pathRow('research/@new')) === 3)
recv({ type: 'activity_delta', epoch: 'E1', seq: 9, base: 8, upsert: [], remove: [] })
check('a delta that doesn\'t follow (lost frames) → the page asks for a resync', sentOf('activity_sub').length === 2 && sentOf('activity_sub')[1].resync === true)
recv({ type: 'activity_board', full: true, epoch: 'E1', seq: 1, head: { host: 'HOST-A', now: Date.now(), stale_after_min: 15 }, upsert: units })
check('... and the full board restores the view', !!pathRow('deploy') && /coordinating/.test(nmRow('Orch').textContent))
doc.getElementById('actCollapse').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Collapse all closes every expanded row', !rowsT().some(r => r.classList.contains('lg') || r.classList.contains('le')))
const nReq = sentOf('activity').length
doc.getElementById('actExpand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Expand all opens every session and every node down to depth 6 (Log rows appear; no log is fetched by it)', logRows().length >= 10 && !!pathRow(deepPath) && sentOf('activity').length === nReq, `${logRows().length} ${sentOf('activity').length - nReq}`)
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('leaving (collapsing the section) unsubscribes', sentOf('activity_unsub').length === 1)
const legend = doc.getElementById('actlegend')
check('legend: the 7 agent glyphs + the context mark + the ring / hover hint', legend.querySelectorAll('svg').length === 8 && /ring is the time left before an agent goes stale/.test(legend.textContent) && /hover the icons/.test(legend.textContent) && /context \(no ring/.test(legend.textContent))

console.log(`\n${pass} passed, ${fail} failed`)
dom.window.close()
process.exit(fail ? 1 : 0)
