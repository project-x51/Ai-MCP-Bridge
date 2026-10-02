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
check('a delta that doesn\'t follow (lost frames) → the page asks for a resync', sentOf('activity_sub').length === 3 && sentOf('activity_sub')[2].resync === true)
recv({ type: 'activity_board', full: true, epoch: 'E1', seq: 1, head: { host: 'HOST-A', now: Date.now(), stale_after_min: 15 }, upsert: units })
check('... and the full board restores the view', !!pathRow('deploy') && /coordinating/.test(nmRow('Orch').textContent))
doc.getElementById('actCollapse').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Collapse all closes every expanded row', !rowsT().some(r => r.classList.contains('lg') || r.classList.contains('le')))
const nReq = sentOf('activity').length
doc.getElementById('actExpand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Expand all opens every session and every node down to depth 6 (Log rows appear; no log is fetched by it)', logRows().length >= 10 && !!pathRow(deepPath) && sentOf('activity').length === nReq, `${logRows().length} ${sentOf('activity').length - nReq}`)
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('leaving (collapsing the section) unsubscribes', sentOf('activity_unsub').length === 2)
const legend = doc.getElementById('actlegend')
check('legend: the 7 agent glyphs + the context mark + (6b) the 4 plan-item marks + (6c) abandoned + the ring / hover hint', legend.querySelectorAll('svg').length === 13 && /skipped · abandoned/.test(legend.textContent) && /plan item: to do · in progress · done · skipped/.test(legend.textContent) && /ring is the time left before an agent goes stale/.test(legend.textContent) && /hover the icons/.test(legend.textContent) && /context \(no ring/.test(legend.textContent))

try {   // a crash (an older dashboard without the 6b helpers) counts as one failure
// ================================================================= 6b (v1.63.0): plan items, the plan bar, active only, host tags, per-host headlines
const pi = (key, path, host, st, extra = {}) => node(key, path, 'context', host, { plan_item: true, state: st, current: { id: `c-${path}`, ts: NOW - MIN, text: path.split('/').at(-1).replace(/^@/, ''), state: st }, ...extra })
check('6b glyph: ☐ todo = an empty box; ☑ done = a box + tick; skipped = a box struck through; running / blocked = the in-progress mark (no ring)', /s-todo.*<rect[^>]*rx="2\.2"[^>]*\/><\/svg>$/.test(X.planGlyph('todo')) && /s-done.*<rect.*<path d="M5 8\.2/.test(X.planGlyph('done'))
  && /s-skipped.*<path d="M4\.8 8 L11\.2 8"/.test(X.planGlyph('skipped')) && /s-running.*<rect x="4\.5"/.test(X.planGlyph('running')) && /s-blocked/.test(X.planGlyph('blocked')) && !/ring/.test(X.planGlyph('running')) && X.glyphSvg({ state: 'done' }, NOW, 'plan') === X.planGlyph('done'))
const quietAgent = run(600)
check('6b stale: a plan item never goes stale (any state), even under a stale or gone agent — its own state shows', ['todo', 'running', 'blocked'].every(s => (e => e.state === s && !e.stale && e.staleAt === null && e.plan)(X.effState(pi('k', '@p/@x', 'H', s, { last_activity: NOW - 600 * MIN }), quietAgent, NOW, 15)))
  && X.effState(pi('k', '@p/@x', 'H', 'todo'), { state: 'gone' }, NOW, 15).state === 'todo' && X.effState(quietAgent, null, NOW, 15).state === 'stale')
check('6b tooltip: a plan item says so (never goes stale), not "staleness follows"', (t => /^Plan item — To do/.test(t) && /never goes stale/.test(t) && !/staleness follows/.test(t))(X.statusTip(pi('k', '@p/@x', 'H', 'todo'), quietAgent, NOW, 15)))
check('6b bar tooltip: "2 of 4 done (50%) · 1 skipped (left out) — its plan: 5 items"', X.barTip({ done: 2, total: 4, unit: 'done', rollup: true, todos: true, skipped: 1, n: 5 }) === '2 of 4 done (50%) · 1 skipped (left out) — its plan: 5 items', X.barTip({ done: 2, total: 4, unit: 'done', rollup: true, todos: true, skipped: 1, n: 5 }))
// a plan fixture: session-level plan @#70 with items in every state (created in one call: equal created_at, plan_ix decides), an agent under one item, a nested plan,
// a finished agent holding an open item, an ended plan, a multi-host session (HOST-A headline; HOST-B nodes)
const T7 = NOW - 30 * MIN, at7 = { created_at: T7 }
const pselfA = root('HOST-A', { current: { id: 'pa', ts: NOW - 2 * MIN, text: 'planning #70', state: 'running' } }), pselfB = root('HOST-B', { current: { id: 'pb', ts: NOW - 20 * MIN, text: 'older headline on B', state: 'running' }, log: { remote: true } })
const plan = [
  sess('k-plan', 'Planner', 'AIMB', { hosts: ['HOST-A', 'HOST-B'], multi_host: true, self: pselfA, selves: [pselfA, pselfB] }),
  node('k-plan', '@#70', 'context', 'HOST-A', { implicit: true, bar: { done: 2, total: 5, unit: 'done', pct: 40, rollup: true, todos: true, skipped: 1, n: 6 }, created_at: T7 - 1000 }),
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
check('6b view: the plan node shows its "N of M done" bar (solid, class plan) with the plan tooltip', !!p70?.querySelector('.pb.plan') && (b => { b.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); return b.getAttribute('title') === '2 of 5 done (40%) · 1 skipped (left out) — its plan: 6 items' })(p70.querySelector('.pb')), p70 && p70.innerHTML)
click(p70)
const itemRows = () => rowsT().filter(r => r.classList.contains('pi') && dOf(r) === 3)
check('6b view: the items render in creation order with ☐ / the in-progress mark / ☑ / struck-through skipped', J(itemRows().map(r => r.querySelector('.nm').textContent)) === J(['Spec', 'Build', 'Test', 'Docs', 'Review', 'Ship'])
  && !!inPlanner('@#70/@Ship').querySelector('svg.s-todo rect[rx="2.2"]') && !!inPlanner('@#70/@Spec').querySelector('svg.s-done path') && inPlanner('@#70/@Spec').classList.contains('pdone')
  && !!inPlanner('@#70/@Build').querySelector('svg.s-running') && inPlanner('@#70/@Docs').classList.contains('skipped') && !!inPlanner('@#70/@Docs').querySelector('svg.s-skipped'), J(itemRows().map(r => r.className)))
const css6 = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n')
check('6b view: skipped = struck through (CSS); an item\'s line is hidden while it is just its name, shown once it says more', /\.ar\.skipped \.nm, \.ar\.skipped \.ln \{[^}]*line-through/.test(css6) && inPlanner('@#70/@Ship').querySelector('.ln').textContent === '' && inPlanner('@#70/@Review').querySelector('.ln').textContent === 'approved by Robin')
check('6b view: a plan item never shows a stale pill — under its quiet agent the agent row does (its own staleness)', !inPlanner('@#70/@Build').classList.contains('stale') && J(pills(inPlanner('@#70/@Test'))) === J(['blocked']))
click(inPlanner('@#70/@Build'))
check('6b view: the nested plan under an item and the agent working under it; the agent shows its own stale', !!inPlanner('@#70/@Build/@unit') && !!inPlanner('@#70/@Build/@e2e') && inPlanner('@#70/@Build/builder')?.classList.contains('stale') && J(pills(inPlanner('@#70/@Build/builder'))) === J(['stale']))
check('6b view (host tags): none on the headline host\'s top-level rows or on any child of a same-host parent; HOST-B\'s top-level node carries HOST-B', !p70.querySelector('.htag') && !inPlanner('@#70/@Ship').querySelector('.htag') && inPlanner('helper')?.querySelector('.htag')?.textContent === 'HOST-B')
const plRow = nmRow('Planner')
check('6b view: the multi-host session row keeps a tag for every host and the headline of the host that most recently set one', J([...plRow.querySelectorAll('.htag')].map(h => h.textContent)) === J(['HOST-A', 'HOST-B']) && plRow.querySelector('.ln').textContent === 'planning #70')
click(plRow)
const hselfRows = rowsT().filter(r => r.getAttribute('data-k') && dOf(r) === 2 && r.querySelector('.htag') && !r.classList.contains('lg') && !r.classList.contains('click'))
check('6b view: expanded, each host\'s OWN line shows (HOST-A\'s headline, HOST-B\'s older one), each above its Log', J(hselfRows.map(r => [r.querySelector('.htag').textContent, r.querySelector('.ln').textContent])) === J([['HOST-A', 'planning #70'], ['HOST-B', 'older headline on B']]), J(hselfRows.map(r => r.textContent)))
ao.checked = true; ao.dispatchEvent(new win.Event('change'))
check('6b view (active only): the open item under a finished agent stays visible; the ended plan is gone; the open plan stays complete', !!inPlanner('retired') && !inPlanner('@shipped') && !!inPlanner('@#70/@Spec') && !!inPlanner('@#70/@Docs'))
ao.checked = false; ao.dispatchEvent(new win.Event('change'))
recv({ type: 'activity_delta', epoch: 'E2', seq: 2, base: 1, head: { host: 'HOST-A', now: NOW, stale_after_min: 15 }, upsert: [pi('k-plan', '@#70/@Ship', 'HOST-A', 'done', { ...at7, plan_ix: 5 }), { ...plan[1], bar: { ...plan[1].bar, done: 3 } }], remove: [] })
check('6b view: a delta ticks an item in place (☐ → ☑) and moves the plan bar', !!inPlanner('@#70/@Ship')?.querySelector('svg.s-done') && inPlanner('@#70/@Ship').classList.contains('pdone') && inPlanner('@#70').querySelector('.pb.plan > i')?.style.width === '60%', J([inPlanner('@#70/@Ship')?.outerHTML, inPlanner('@#70')?.querySelector('.pb')?.outerHTML]))
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
const po = doc.getElementById('actPlanOpen'), poV = doc.getElementById('actPlanOpenV'), lsBefore = Object.keys(win.localStorage).sort().join()
check('6c slider: "plans open" sits beside "stale after", starting at the bridge\'s finished_plan_open_min', !!po && po.closest('.act-bar') === doc.getElementById('actStale').closest('.act-bar') && po.value === '120' && /2h \(bridge default\)/.test(poV.textContent), poV && poV.textContent)
po.value = '0'; po.dispatchEvent(new win.Event('input'))
check('6c slider: 0 → the recently ended plan collapses at once (live, no message to the bridge)', !inS('Sixc', '@recent/@x') && !!inS('Sixc', '@recent') && !!inS('Sixc', '@open/@a') && /^0m$/.test(poV.textContent))
po.value = '240'; po.dispatchEvent(new win.Event('input'))
check('6c slider: 240 → the plan that ended 3 h ago expands again; the slider is NOT persisted (like the stale slider)', !!inS('Sixc', '@old/@z') && !!inS('Sixc', '@recent/@x') && /4h/.test(poV.textContent) && Object.keys(win.localStorage).sort().join() === lsBefore)
po.value = '120'; po.dispatchEvent(new win.Event('input'))
click(inS('Sixc', '@open'))
check('6c open by default: the viewer\'s own click still wins (an open plan collapses on click)', !inS('Sixc', '@open/@a') && !!inS('Sixc', '@open'))
click(inS('Sixc', '@open'))
const abRow = inS('Sixc', '@open/@c')
check('6c abandoned: a greyed row (class abandoned) with its own dashed plan glyph; the plan bar tooltip counts it', abRow.classList.contains('abandoned') && !!abRow.querySelector('svg.s-abandoned rect[stroke-dasharray]') && /s-abandoned/.test(X.planGlyph('abandoned')) && X.planGlyph('abandoned') !== X.planGlyph('skipped')
  && /1 abandoned/.test(X.barTip({ done: 1, total: 2, unit: 'done', rollup: true, todos: true, skipped: 1, n: 3, abandoned: 1 })) && /color:var\(--faint\)/.test([...doc.querySelectorAll('style')].map(s => s.textContent).join('').match(/\.ar\.abandoned \.nm[^}]*\}/)?.[0] || ''))
check('6c abandoned: an agent or a plan node set abandoned gets a distinct glyph too (not gone\'s, not done\'s)', /s-abandoned/.test(X.glyphSvg({ state: 'abandoned' }, NOW)) && X.glyphSvg({ state: 'abandoned' }, NOW) !== X.glyphSvg({ state: 'gone', gone: true }, NOW) && /s-abandoned/.test(X.glyphSvg({ state: 'abandoned' }, NOW, 'ctx')))
check('6c home host: top-level host tags compare with the session\'s HOME host (B — where it first appeared), not the headline host (A)', inS('Sixc', 'anode')?.querySelector('.htag')?.textContent === 'HOST-A' && !inS('Sixc', 'bnode')?.querySelector('.htag') && inS('Sixc', '@open')?.querySelector('.htag')?.textContent === 'HOST-A' && !inS('Sixc', '@open/@a')?.querySelector('.htag'),
  J([inS('Sixc', 'anode')?.querySelector('.htag')?.textContent, inS('Sixc', 'bnode')?.querySelector('.htag')?.textContent]))
click(nmRow('Sixc'))
const hselfSix = rowsT().filter(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Sixc')
check('6c home host: expanded, the home host\'s own line says so (hover)', hselfSix.length === 2 && (r => { const l = r.querySelector('.ln'); l.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); return /HOME host/.test(l.getAttribute('title') || '') })(hselfSix.find(r => r.getAttribute('data-host') === 'HOST-B')), J(hselfSix.map(r => r.outerHTML.slice(0, 200))))
click(nmRow('Sixc'))
// the bar column: pills sit right after the name, so .pb is always 3rd from the end of a row
const withBar = rowsT().filter(r => r.querySelector('.pb') && !r.classList.contains('proj'))
const anodeRow = inS('Sixc', 'anode')
check('6c bar column (6b rough edge): the bar sits at the same place on a row WITH a pill as on one without — pills come right after the name', withBar.length > 10 && withBar.every(r => r.children[r.children.length - 3] === r.querySelector('.pb'))
  && pills(anodeRow).includes('blocked') && [...anodeRow.children].indexOf(anodeRow.querySelector('.pills')) < [...anodeRow.children].indexOf(anodeRow.querySelector('.ln')), J(withBar.filter(r => r.children[r.children.length - 3] !== r.querySelector('.pb')).map(r => r.textContent)))
// gossiped counts
click(inS('Sixc', 'bnode'))
const bLog = rowsT().find(r => r.classList.contains('lg') && r.getAttribute('data-host') === 'HOST-B' && r.getAttribute('data-path') === 'bnode')
check('6c counts: a REMOTE node\'s Log row says "N entries" — its subtree\'s gossiped own counts summed here; "+" when one understates (partial)', !!bLog && /7\+ entries, this node and below/.test(bLog.textContent) && X.subtreeLog({ u: { log: { remote: true, total: 5 } }, kids: [{ u: { log: { remote: true, total: 2, partial: true } }, kids: [] }] }).n === 7
  && X.subtreeCount({ u: { log: { remote: true } }, kids: [] }) === null, bLog && bLog.textContent)
click(inS('Sixc', 'bnode'))
// the run boundary + pruned + by
click(inS('Rollup', 'live'))
const liveLog = rowsT().find(r => r.classList.contains('lg') && r.getAttribute('data-path') === 'live')
click(liveLog)
const rq = sentOf('activity').pop()
recv({ type: 'activity', ref: rq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'r2', ts: NOW - MIN, path: 'live', rel: '', current: true, text: 'run 2', rendered: 'run 2', state: 'running' }, { id: 'r1', ts: NOW - 2 * MIN, path: 'live', rel: '', text: 'abandoned by the bridge', rendered: 'abandoned by the bridge', state: 'abandoned', by: 'bridge' }], next_cursor: null, run_start: true, earlier_cursor: 'f1.2026-10-01.900' } } })
const sre = rowsT().find(r => /start of this run · show earlier runs/.test(r.textContent))
check('6c run boundary: the log stops at the start of the CURRENT run with a "show earlier runs" control; an entry the bridge wrote says "by bridge"', !!sre && rowsT().some(r => r.querySelector('.by')?.textContent === 'by bridge') && !rowsT().some(r => /load older/.test(r.textContent)))
click(sre)
const rq2 = sentOf('activity').pop()
check('6c run boundary: "show earlier runs" asks for the next page past the boundary — cursor = earlier_cursor, earlier:true', rq2.query.log.cursor === 'f1.2026-10-01.900' && rq2.query.log.earlier === true && rq2.query.log.path === 'live', J(rq2.query))
recv({ type: 'activity', ref: rq2.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'o1', ts: NOW - 3 * HOUR, path: 'live', rel: '', text: 'an earlier run', rendered: 'an earlier run', state: 'done' }], next_cursor: null } } })
const sep = rowsT().find(r => r.classList.contains('sep')), eo1 = rowsT().find(r => /an earlier run/.test(r.textContent))
check('6c run boundary: the earlier run\'s entries follow a "— earlier runs —" separator', !!sep && !!eo1 && rowsT().indexOf(sep) < rowsT().indexOf(eo1) && rowsT().indexOf(sep) > rowsT().indexOf(rowsT().find(r => /run 2/.test(r.textContent))))
click(liveLog)
click(inS('Rollup', 'live'))
click(inS('Sixc', 'anode'))
const aLog = rowsT().find(r => r.classList.contains('lg') && r.getAttribute('data-path') === 'anode')
click(aLog)
const rq3 = sentOf('activity').pop()
recv({ type: 'activity', ref: rq3.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'p1', ts: NOW - MIN, path: 'anode', rel: '', text: 'x', rendered: 'x', state: 'blocked' }], next_cursor: null, pruned: true } } })
check('6c pruned: a run that began in a deleted day file ends in "earlier history pruned" (not a silent gap)', rowsT().some(r => r.classList.contains('pruned') && /earlier history pruned/.test(r.textContent)))
click(aLog); click(inS('Sixc', 'anode'))
// rollups follow the filters (the 6b rough edge: a session's rollup counted what the filter hid)
const rollRow = () => nmRow('Rollup')
const tipOf = el => { el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); return el.getAttribute('title') }
const unf = tipOf(rollRow().querySelector('.pb'))
ao.checked = true; ao.dispatchEvent(new win.Event('change'))
const fil = tipOf(rollRow().querySelector('.pb'))
check('6c rollup vs filter: with Active only the session\'s rolled-up bar counts only what is shown (the finished worker\'s 6/6 drops out: 8 of 12 → 2 of 6 files); its line renders against it', unf === '8 of 12 files (66%) — rollup of 2 below it' && fil === '2 of 6 files (33%) — rollup of 1 below it' && rollRow().querySelector('.ln').textContent === 'rolling 2 of 6 files', J([unf, fil]))
check('6c rollKids: the same strategies as the bridge — sum, mean %, then N of M done (skipped out, abandoned counted)', J(X.rollKids([{ u: { key: 'a' }, fbar: { done: 1, total: 4, unit: 'x' } }, { u: { key: 'b' }, fbar: { done: 1, total: 4, unit: 'x' } }])) === J({ done: 2, total: 8, unit: 'x', pct: 25, rollup: true, n: 2 })
  && X.rollKids([{ u: { key: 'a' }, fbar: { done: 50, total: 100, unit: '%' } }, { u: { key: 'b' }, fbar: { done: 1, total: 4, unit: 'x' } }]).pct === 37.5
  && (r => r.todos && r.done === 1 && r.total === 2 && r.abandoned === 1)(X.rollKids([{ u: { key: 'a', plan_item: true, current: { state: 'done' } } }, { u: { key: 'b', plan_item: true, current: { state: 'skipped' } } }, { u: { key: 'c', plan_item: true, current: { state: 'abandoned' } } }])))
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
  && rowsT().filter(r => r.getAttribute('data-kind') === 'entry').every(r => !!r.getAttribute('data-id')))
} catch (e) { fail++; console.log('FAIL 6c block crashed:', (e && e.stack) || e) }
} catch (e) { fail++; console.log('FAIL 6b block crashed:', (e && e.message) || e) }

console.log(`\n${pass} passed, ${fail} failed`)
dom.window.close()
process.exit(fail ? 1 : 0)
