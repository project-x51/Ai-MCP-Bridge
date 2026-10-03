// #70 step 5 (v1.61.0) + step 6a (v1.62.0): the dashboard's Activity view — PORTED to the 2.0 board in #88 build step 10.
// Loads dashboard.html in jsdom with a stubbed WebSocket (like test_dashboard_collapse), then (1) unit-tests the PURE client
// logic it exposes as window.AimbAct — client-side stale (the slider, an item's own stale_after; a CONTEXT shows its
// nearest agent's staleness / gone, an implicit agent never goes stale), the status glyph + its ring, the hover texts,
// placeholder rendering, progress / ETA tooltips, the project-level cycle, the delta store (seq gap → resync), the NODE
// TREE (nesting by parent_id, rank order, orphans, active-only, counts), the log-entry tags and the step-10 helpers (the
// view's LWW merge, open / closed, badges, "new since you last looked", the one-time import, moves / merges / drops by id,
// the depth rules, groups, TIME) — and (2) drives the rendered tree.
// FIXTURES (2.0): every board is built by the BRIDGE's own libraries — real 2.0 stores (lib/activity2-store.js createStore2
// + apply / action / markGone / setBells) turned into the units the bridge pushes (lib/activity2-dash.js dashUnits2, its
// deltas planDashDelta2, the type registry dashTypes2); the log pages the panel shows are the store's own logPage /
// entry answers, and the clash lists the owner's (applyAction2 duplicate-label). Only the pure-helper inputs are written
// by hand. Remote hosts = more stores fed to dashUnits2 as held remote boards (down_at for a host that went away).
//
// RETIRED in step 10 (what 2.0 removed — each check named where it stood):
// - 1.7x unit shapes: path keys / parent_key / "@" path segments / sibRef names ("@\"B\"") — units, rows, open state,
//   selection, pins, feedback and drag-and-drop key by NODE ID now (rows keep data-path for display and copying);
//   entryTag's "@root" / "@~root" / "@Tharsis/@~z12" forms (2.0: "here" / "@here" / "@Tharsis/z12", §4.0's leading @);
//   rankOf's 1.7x derived-rank string check (#82: the bridge sends the effective rank — kept: cmpRank's order);
// - PATH-ADDRESSED actions ({path, action}) and their args {before:'@"B"'} / {after} / {to:'@Old'} — 2.0 sends
//   {host, session, project, user, id, action, args} with before_id / after_id / to_id / into_id (checked below);
// - the log query by path ({log:{path}}) — by id ({log:{id}});
// - pins / hidden in localStorage (aimb.act.pins / aimb.act.hidden) as the store when a view exists — the per-USER view
//   on the bridge (§5.6: pin:<t> / hide:<t> via view_set); the localStorage keys are only READ once (the import) then
//   removed; "6c Plans filter remembered per browser" and "#87 the order remembered in localStorage" → the view's
//   opt:plans_only / opt:log_order (Q38); the newest-first toggle checks keep the storage-that-throws page;
// - menus the PAGE computed for 1.7x owners (menuFor17's node models: item_state, agent_ok, owns_open, holds_open,
//   plan_end_how, can_msg / can_ask / can_revise / can_plan) and the HOST VERSION GATES behind them (hostPlan / hostMsg /
//   hostAsk / hostRevise: remote_hosts[].plan / msg / ask / revise — every host is 2.0): the menu is the unit's `menu`
//   (the bridge's registry, menuStatic2) labelled by the board's `types`, finish / dismiss checked against the slider
//   (menuFor2). The 1.7x labels ("Mark plan complete", "Abandon item", "Withdraw question…") are the registry's now
//   ("Complete the plan", "Abandon", "Withdraw…"); kept: the log ENTRY's menu (Copy entry id / Copy path);
// - "#82 drag: another host's rows (≤1.68) are not draggable" — draggable = the unit's menu has Move (every 2.0 host);
// - "#83/#84 a node on an older host (no msg) hides Edit text… / Message session…", "#85 an older host's question: no
//   Answer… / a click only selects", "#90 an older host (no revise): no Change answer…" — no older hosts on a 2.0 board;
// - #79's 1.65 bar forms (norm3 widening a ≤1.65 "N of M" bar) stay as PURE checks only; the "client == bridge" rollup
//   checks now compare against the 2.0 bridge's bar2 (the units' `bar`); "#88 plan bar" against bar2 too;
// - 6b "host tags on a 1.70 vs ≤1.69 host", "the 1.7x `implicit` agent named by a path" (2.0: a path never creates an
//   agent — kept as a pure effState check), the 6b/6c fixtures' hand-written plan_ix / plan_end_how / plan_node flags
//   (the units carry the bridge's own).
// ADDED in step 10 (spec §8 step 10 Tests:): ids through deltas; a rename / move keeping the selection; open / closed
// beating defaults; a closed node gaining activity → "N new" / "? N", not reopened; Expand all then a new node → its
// default; the "new since you last looked" divider + seen:<t>; Reset view (live, defaults after it); the one-time import;
// drag-and-drop by id; a drop / Move to onto a same-label sibling → the CLASH dialog (both answers, "merge them" hidden for
// an agent, a nested clash listed); view pushes live vs sel / fold:details at load only (Q30); view_set debounced; options
// from the view; Q70's red rows; the Answer dialog's layout; a test-run's tests bar; a group's count; "took …" /
// "running …"; show removed; Rename…'s inline duplicate-label + suggestion; Merge into…; the registry menu; the copy
// command (--agent / --key / --id … --text "@<text>"); "view: <user>" in the header tag.
import { testOnly } from '../helpers/check.mjs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import fs from 'fs'
import { createStore2 } from '../../lib/activity2-store.js'
import { dashUnits2, dashTypes2, planDashDelta2 } from '../../lib/activity2-dash.js'
import { createRemote2, markOriginDown2 } from '../../lib/activity2-gossip.js'
import { createViewSet } from '../../lib/view-state.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
const MIN = 60000, HOUR = 60 * MIN

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
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))

// ---- 2.0 fixtures from the bridge's own libraries
const TYPES = dashTypes2()
const BY = { by: { kind: 'dashboard', user: 'robin', host: 'HOST-A' } }
const who = (session, project = 'AIMB') => ({ session, project, user: 'robin', realm: 'default' })
function say(st, w, input, at) { const r = st.apply(w, input, at); if (!r || r.ok === false) throw new Error(`fixture ${st.host} ${J(input)} → ${r && r.code} ${r && r.what}`); return r }
/** the held remote boards (gossip v6's holder): other hosts' stores as their slices; `down` = the host went away
 * (markOriginDown2: its sessions and agents gone, down_at — exactly what the gateway does when a link drops) */
function remoteOf(origin, stores, down = {}) {
  const r = createRemote2({ origin })
  for (const st of stores) r.hosts.set(st.host, { sessions: st.state.sessions, epoch: 'x', seq: 1, down_at: null, truncated: false })
  for (const [h, t] of Object.entries(down)) markOriginDown2(r, h, t)
  return r
}
/** the units the bridge pushes for `local` + the held remote boards (a Map, planDashDelta2's input) */
const unitMap = (local, remote = null, kindOf) => dashUnits2({ state: local.state, host: local.host, remote: remote || createRemote2({ origin: local.host }), kindOf })
const unitsOf = (...a) => [...unitMap(...a).values()].map(x => x.obj)
const head2 = (extra = {}) => ({ host: 'HOST-A', now: Date.now(), format: 6, stale_after_min: 15, finished_plan_open_min: 120, remote_hosts: [], log_cmd: null, user: 'robin', view_user: 'robin', ...extra })
/** a board FEED: a full board, then deltas of what changed (planDashDelta2 — exactly what the gateway sends) */
function feed(epoch, src, headOf = () => head2()) {
  const pub = new Map(); let seq = 0
  return {
    full() { const p = planDashDelta2(pub, src(), { full: true }); seq = 1; recv({ type: 'activity_board', full: true, epoch, seq, head: headOf(), types: TYPES, upsert: p.upsert }); return p },
    delta() { const p = planDashDelta2(pub, src()); recv({ type: 'activity_delta', epoch, seq: seq + 1, base: seq, head: headOf(), upsert: p.upsert, remove: p.remove }); seq++; return p },
  }
}
const sessU = (units, name) => units.find(u => u.kind === 'session' && u.session === name)
const nodeU = (units, name, path, host) => { const s = sessU(units, name); return units.find(u => u.kind === 'node' && u.group === s.key && u.path === path && (!host || u.host === host)) }

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
check('stale (6a): an IMPLICIT agent never goes stale', X.effState(run(400, { implicit: true }), null, NOW, 15).state === 'running' && X.effState(run(400, { implicit: true }), null, NOW, 15).staleAt === null)
check('stale (6a): a sub-agent under a finished agent still goes stale by itself', X.effState(run(400), { finished_at: NOW - MIN }, NOW, 15).state === 'stale')
check('gone comes from the data; host_down (own or owner\'s) marks a host that went away', X.effState({ nkind: 'agent', state: 'gone', was: 'blocked' }, null, NOW, 15).gone && X.effState({ nkind: 'agent', state: 'gone', was: 'blocked' }, null, NOW, 15).was === 'blocked'
  && !X.effState({ state: 'gone' }, null, NOW, 15).hostDown && X.effState({ state: 'gone', host_down: NOW }, null, NOW, 15).hostDown && X.effState({ state: 'gone' }, { host_down: NOW }, NOW, 15).hostDown)
const cx = (st, extra = {}) => ({ nkind: 'context', state: st, created_at: NOW - 60 * MIN, last_activity: NOW - 50 * MIN, current: { id: 'c', ts: NOW - 50 * MIN, text: 'x', state: st }, ...extra })
const freshAg = run(1), staleAg = run(30), doneAg = { ...run(300), state: 'done', finished_at: NOW - MIN, current: { state: 'done' } }
check('context (6a): a context quiet for 50 min under a FRESH agent is fresh (it never goes stale by itself)', X.effState(cx('running'), { ...freshAg, current: { state: 'running' } }, NOW, 15).state === 'running')
check('context (6a): ... and stale exactly when its agent is (was = its own state; no ring of its own)', (e => e.state === 'stale' && e.was === 'blocked' && !e.live)(X.effState(cx('blocked'), { ...staleAg, current: { state: 'running' } }, NOW, 15)))
check('context (6a): a done context under a stale agent stays done; nothing under a finished agent goes stale', X.effState(cx('done'), staleAg, NOW, 15).state === 'done' && X.effState(cx('running'), doneAg, NOW, 15).state === 'running')
check('context (6a): no current line → "none" (a grouping node: no state, no pills)', (e => e.state === 'none' && e.noLine)(X.effState({ nkind: 'context', created_at: NOW }, staleAg, NOW, 15)))
check('context (6a): gone when its agent is gone (unless done); its agent\'s host_down shows', X.effState(cx('running'), { state: 'gone', host_down: NOW }, NOW, 15).gone && X.effState(cx('running'), { state: 'gone', host_down: NOW }, NOW, 15).hostDown
  && X.effState(cx('done'), { state: 'gone' }, NOW, 15).state === 'done')
check('context (6a): directly under the session it follows the session\'s own line', X.effState(cx('running'), { state: 'running', current: { state: 'running' }, last_activity: NOW - 20 * MIN }, NOW, 15).state === 'stale')
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
check('tooltip (2.0 TIME): a node with the bridge\'s own time says it ("Took 4m 12s") instead of the page\'s guess', (t => /^Done at \d\d:\d\d:\d\d\n/.test(t) && /\nTook 4m 12s$/.test(t))(X.statusTip({ nkind: 'agent', state: 'done', started_at: NOW - 59 * MIN, finished_at: NOW - MIN, took: { text: 'took 4m 12s', took: 252000 } }, null, NOW, 15)))
check('tooltip: stale says was …; gone vs host down differ', /^Stale — was running/.test(X.statusTip(run(30), null, NOW, 15)) && /^Gone — the session left the mesh/.test(X.statusTip({ state: 'gone', was: 'running', gone_at: NOW }, null, NOW, 15))
  && /^Host H is down or unreachable/.test(X.statusTip({ state: 'gone', was: 'running', gone_at: NOW, host_down: NOW }, null, NOW, 15, 'H')))
check('tooltip (6a): a context names the agent its staleness follows; an implicit agent says it has not reported', /staleness follows agent research/.test(X.statusTip(cx('running'), { ...freshAg, path: 'research', current: { state: 'running' } }, NOW, 15))
  && /staleness follows the session/.test(X.statusTip(cx('running'), { state: 'running', current: { state: 'running' }, last_activity: NOW }, NOW, 15)) && /not reported yet/.test(X.statusTip(run(1, { implicit: true }), null, NOW, 15)))
check('tooltip: ETA = "ETA ~15m (estimated), about HH:MM"', /^ETA ~15m \(estimated\), about \d\d:\d\d$/.test(X.etaTip(NOW + 15 * MIN, NOW)), X.etaTip(NOW + 15 * MIN, NOW))
check('tooltip: progress — exact counts, reported vs rollup of what is below it', X.barTip(P) === '4,812 of 12,000 tiles (40%) — reported' && X.barTip({ done: 3, total: 6, unit: 'tasks', rollup: true, n: 2 }) === '3 of 6 tasks (50%) — rollup of 2 below it')
check('project level: all → sessions → collapsed → all', X.nextLevel('all') === 'sessions' && X.nextLevel('sessions') === 'collapsed' && X.nextLevel('collapsed') === 'all')
check('entry tags (2.0, §4.0): the node itself "here" / "@here" (the entry SET its line); a descendant by its path below it, "@" when it set that line — no 1.7x @ segments', X.entryTag({ rel: '' }) === 'here' && X.entryTag({ rel: '', current: true }) === '@here'
  && X.entryTag({ rel: 'Tharsis/z12', current: true }) === '@Tharsis/z12' && X.entryTag({ rel: 'Tharsis/z12' }) === 'Tharsis/z12' && X.entryTag({}) === 'here', J([X.entryTag({ rel: '' }), X.entryTag({ rel: 'Tharsis/z12', current: true })]))
const st0 = {}
check('store: a full board replaces; a delta on top of exactly (epoch, seq) applies', X.applyMsg(st0, { type: 'activity_board', full: true, epoch: 'e', seq: 1, upsert: [{ id: 'a', kind: 'session', key: 'k' }] }) === 'full'
  && X.applyMsg(st0, { type: 'activity_delta', epoch: 'e', seq: 2, base: 1, upsert: [{ id: 'b', kind: 'node', group: 'k', node_id: 'aaaaaaaaaaaaaaaa' }], remove: [] }) === 'delta' && st0.seq === 2 && !!st0.units.b)
check('store: a gap (base ≠ seq) or another epoch → resync, nothing applied', X.applyMsg(st0, { type: 'activity_delta', epoch: 'e', seq: 5, base: 4, upsert: [{ id: 'c' }] }) === 'resync' && !st0.units.c
  && X.applyMsg(st0, { type: 'activity_delta', epoch: 'z', seq: 3, base: 2 }) === 'resync' && X.applyMsg(st0, { type: 'activity_delta', epoch: 'e', seq: 3, base: 2, remove: ['b'] }) === 'delta' && !st0.units.b)
// ---- step 10's pure helpers (ids, the view, badges, TIME, groups, paths)
check('step 10 nidOf / pidOf / vt: a node unit\'s node_id / parent_id; the view target of a node = its id, of a session row = its unit id', X.nidOf({ node_id: 'n1', parent_id: 'p1', kind: 'node', id: 'u1' }) === 'n1' && X.pidOf({ node_id: 'n1', parent_id: 'p1' }) === 'p1'
  && X.vt({ kind: 'node', node_id: 'n1', id: 'u1' }) === 'n1' && X.vt({ kind: 'session', id: '["s","k"]' }) === '["s","k"]' && X.pidOf({ node_id: 'n1' }) === null)
check('step 10 idCmp: entry ids order by their TIME then sequence (the act_<gateway>_ prefix is ignored — it changes per gateway start)', X.idCmp('act_aa_musfiua6-8', 'act_zz_musfiua6-7') > 0 && X.idCmp('act_zz_musfiua5-9', 'act_aa_musfiua6-1') < 0 && X.idCmp('act_x_m1-1', 'act_y_m1-1') === 0 && X.idCmp('junk', 'act_m1-1') < 0)
{
  const v = X.newView()
  const c1 = X.viewMerge(v, [{ k: 'pin:a', v: 1, ts: 10, origin: 'H1' }, { k: 'open:a', v: { o: 0, n: 3, q: 0 }, ts: 10, origin: 'H1' }])
  const c2 = X.viewMerge(v, [{ k: 'pin:a', v: 1, ts: 9, origin: 'H2' }])                  // older: loses
  const c3 = X.viewMerge(v, [{ k: 'pin:a', v: null, ts: 10, origin: 'H0' }])              // a tie: the tombstone wins
  const c4 = X.viewMerge(v, [{ k: 'seen:a', v: 'act_m5-2', ts: 20, origin: 'H1' }, { k: 'seen:a', v: 'act_m4-9', ts: 30, origin: 'H1' }])   // a MAX register: the newer entry stays
  check('step 10 viewMerge (§5.6): newer ts wins, an older one changes nothing, a tie goes to the tombstone; seen:<t> is a MAX register (a later ts with an OLDER entry loses); → the keys that changed',
    J(c1) === J(['pin:a', 'open:a']) && !c2.length && J(c3) === J(['pin:a']) && X.viewGet(v, 'pin:a') === undefined && X.viewGet(v, 'seen:a') === 'act_m5-2' && J(c4) === J(['seen:a']), J([c1, c2, c3, c4, v.recs]))
  const c5 = X.viewMerge(v, [{ k: 'reset', v: 1, ts: 25, origin: 'H1' }])
  const c6 = X.viewMerge(v, [{ k: 'hide:b', v: 1, ts: 24, origin: 'H1' }, { k: 'hide:c', v: 1, ts: 26, origin: 'H1' }])
  check('step 10 viewMerge: a RESET voids every record older than it (they change → defaults), and a record older than the reset never comes back; a newer one does', c5.includes('open:a') && c5.includes('reset') && X.viewGet(v, 'open:a') === undefined && J(c6) === J(['hide:c']) && X.viewGet(v, 'hide:b') === undefined, J([c5, c6]))
  const w = X.newView(); X.viewMerge(w, [{ k: 'open:x', v: { o: 0, n: 1, q: 0 }, ts: 100 }, { k: 'all', v: { o: 1 }, ts: 50 }, { k: 'open:y', v: { o: 0 }, ts: 40 }])
  check('step 10 viewOpen (openState): an explicit open:<t> beats the default; Expand / Collapse all covers a node CREATED BEFORE it with no newer open: record; a node created after it → null (its default)',
    X.viewOpen(w, 'x', 10) === false && X.viewOpen(w, 'y', 10) === true && X.viewOpen(w, 'z', 10) === true && X.viewOpen(w, 'z', 60) === null && X.viewOpen(w, 'x', 200) === false && X.viewOpen(X.newView(), 'z', 1) === null)
}
check('step 10 closedBadge (§5.6, H16): a node the viewer CLOSED — "? N" for open questions since (beats "N new"), else "N new" entries since; nothing new → none; an open record → none',
  J(X.closedBadge({ o: 0, n: 3, q: 1 }, 2, 9)) === J({ kind: 'q', n: 1, text: '? 1' }) && J(X.closedBadge({ o: 0, n: 3, q: 0 }, 0, 5)) === J({ kind: 'new', n: 2, text: '2 new' }) && X.closedBadge({ o: 0, n: 3, q: 0 }, 0, 3) === null && X.closedBadge({ o: 1 }, 5, 50) === null)
check('step 10 newSinceCount: how many of the entries (newest first) are newer than seen — 0 without a seen', X.newSinceCount([{ id: 'act_m9-1' }, { id: 'act_m8-1' }, { id: 'act_m5-1' }, { id: 'act_m4-1' }], 'act_m5-1') === 2 && X.newSinceCount([{ id: 'act_m9-1' }], null) === 0 && X.newSinceCount([{ id: 'act_m3-1' }], 'act_m5-1') === 0)
check('step 10 logRows: the "new since you last looked" divider sits between the new and the older entries in BOTH orders (not when all or none is new)', (o => o(true) === 'dcNba' && o(false) === 'abNcd')(old => X.logRows(['a', 'b', 'c', 'd'].map(id => ({ id })), null, old, 2).map(r => r.newsep ? 'N' : r.e.id).join(''))
  && !X.logRows([{ id: 'a' }, { id: 'b' }], null, true, 2).some(r => r.newsep) && !X.logRows([{ id: 'a' }], null, true, 0).some(r => r.newsep))
check('step 10 legacyPath: a 1.7x path key → its 2.0 display path ("@\\"Next release\\"/@~Docs" → "Next release/Docs")', X.legacyPath('@"Next release"/@~Docs') === 'Next release/Docs' && X.legacyPath('research/@Tharsis') === 'research/Tharsis' && X.legacyPath('@"say ""hi"""') === 'say "hi"')
check('step 10 groupCount (§5.7): "N items" while none is resolved, else the non-zero parts of "N open · N done · N skipped"; abandoned children not counted; none → null',
  X.groupCount([{ u: { current: { state: 'running' } } }, { u: {} }]).text === '2 items' && X.groupCount([{ u: { current: { state: 'done' } } }, { u: { current: { state: 'todo' } } }, { u: { current: { state: 'skipped' } } }, { u: { current: { state: 'abandoned' } } }]).text === '1 open · 1 done · 1 skipped'
  && X.groupCount([{ u: { current: { state: 'abandoned' } } }]) === null)
check('step 10 fmtTook / tookText (§5.7 TIME): "850ms", "4.1s", "4m 12s", "1h 3m", "2d 3h"; the bridge\'s text, else "running 3m" from an open attempt\'s started_at; nothing when it never started',
  X.fmtTook(850) === '850ms' && X.fmtTook(4100) === '4.1s' && X.fmtTook(252000) === '4m 12s' && X.fmtTook(63 * MIN) === '1h 3m' && X.fmtTook(51 * HOUR) === '2d 3h'
  && X.tookText({ took: { text: 'took 30s (4m 42s over 2 runs)' } }, NOW) === 'took 30s (4m 42s over 2 runs)' && X.tookText({ took: { started_at: NOW - 3 * MIN } }, NOW) === 'running 3m' && X.tookText({}, NOW) === '' && X.tookText({ took: { started_at: NOW - MIN, ended_at: NOW } }, NOW) === '')
check('step 10 shortPath (Q11b): a long path shortened in the MIDDLE ("Next release/…/Docs"); a short one as is', X.shortPath('Next release/WIP/#88 stable node identity/Build step 10/Docs', 30) === 'Next release/…/Docs' && X.shortPath('a/b', 30) === 'a/b' && Array.from(X.shortPath('x'.repeat(100), 20)).length <= 20)
const LC = { node: 'C:/Program Files/nodejs/node.exe', script: 'D:/AIMB/src/tools/aimb-log.mjs', token_file: 'C:/Users/robin/.aimb/realm token.txt' }
check('6d / step 10 logCmd (§5.4): quoted absolute node + script paths, --session / --project, the token FILE path (never a token); the node BY KEY — an agent --agent <its chain>, a context --agent <its scope> --key <key> (the session\'s: --key alone), no key → --id; then --text "@<text>"',
  X.logCmd(LC, 'Sixd', 'SixD', { nkind: 'context', key: 'x', scope: 'lead' }) === '"C:/Program Files/nodejs/node.exe" "D:/AIMB/src/tools/aimb-log.mjs" --session "Sixd" --project "SixD" --token-file "C:/Users/robin/.aimb/realm token.txt" --agent "lead" --key "x" --text "@<text>"'
  && X.logCmd({ node: '/usr/bin/node', script: '/opt/t/aimb-log.mjs' }, 'S', 'P', null) === '"/usr/bin/node" "/opt/t/aimb-log.mjs" --session "S" --project "P" --text "@<text>"'
  && / --agent "lead\/sub" --text/.test(X.logCmd(LC, 'S', 'P', { nkind: 'agent', key: 'sub', scope: 'lead' })) && / --key "docs" --text/.test(X.logCmd(LC, 'S', 'P', { nkind: 'context', key: 'docs', scope: '' })) && !/--agent/.test(X.logCmd(LC, 'S', 'P', { nkind: 'context', key: 'docs', scope: '' }))
  && / --id "abcdefghijklmnop" --text/.test(X.logCmd(LC, 'S', 'P', { nkind: 'context', node_id: 'abcdefghijklmnop' })) && X.logCmd(null, 'S', 'P') === null, X.logCmd(LC, 'Sixd', 'SixD', { nkind: 'context', key: 'x', scope: 'lead' }))

// ---- the MAIN board (2.0, real stores): Orch on HOST-A (+ HOST-B: build / deploy; a doorbell), Leaver (left the mesh), Cee on
// HOST-C (down). Orch: research (an agent with progress + ETA) → Tharsis (a context with its own bar) → z12 / nol (no line),
// research → sub (a blocked sub-agent); old (quiet 31 min) → ctx; longrun (its own stale_after 60m); #70/step4 (path-made, no
// lines) → spec-70 (an agent) → Tharsis/z12 (implicit) → deep (depth 6, a bar that rolls up the chain)
const at = m => NOW - m * MIN
const sA = createStore2({ host: 'HOST-A' }), sB = createStore2({ host: 'HOST-B' }), sC = createStore2({ host: 'HOST-C' })
const OR = who('Orch'), LV = who('Leaver'), CE = who('Cee', 'Tools')
say(sA, OR, { text: '@coordinating {progress}', eta: '75m' }, at(60))   // ETA: due 15 min from now
say(sA, OR, { agent: 'research', label: 'research', text: '@reading {progress}', progress: '4812/12000 tiles', eta: '88m' }, at(58))   // 30 min from now
say(sA, OR, { agent: 'research', key: 'tharsis', label: 'Tharsis', text: '@tiling {progress}', progress: '2/8 tiles' }, at(40))
say(sA, OR, { agent: 'old', label: 'old', text: '@quiet one' }, at(32))
say(sA, OR, { agent: 'old', key: 'ctx', label: 'ctx', text: '@inherits the agent\'s stale', state: 'blocked' }, at(31))
say(sA, OR, { agent: 'longrun', label: 'longrun', text: '@long build', stale_after: '60m' }, at(30))
say(sA, OR, { path: '#70/step4' }, at(20))
say(sA, OR, { agent: 'sub', label: 'sub', under: 'research', text: '@waiting for a key', state: 'blocked' }, at(2))
say(sA, OR, { agent: 'research', key: 'z12', label: 'z12', under: 'tharsis', text: '@strip z12' }, at(1.5))
say(sA, OR, { agent: 'research', key: 'nol', label: 'nol', under: 'tharsis' }, at(1.45))
say(sA, OR, { agent: 'spec-70', label: 'spec-70', under: 'step4', text: '@spec agent under a task' }, at(1.4))
say(sA, OR, { agent: 'spec-70', path: 'Tharsis/z12/deep', text: '@six levels down {progress}', progress: '1/4 tiles' }, at(1.3))
say(sA, OR, { text: 'still coordinating' }, at(1.2))                       // logged (no @): the root stays fresh, its line stays
say(sA, OR, { agent: 'research', key: 'z12', text: '@with attachments', details: 'DETAIL TEXT', data: { rows: 42, ok: true } }, at(1))
say(sB, OR, { agent: 'build', label: 'build', text: '@built', state: 'done' }, at(5))
say(sB, OR, { agent: 'deploy', label: 'deploy', text: '@deploy failed', state: 'failed' }, at(4))
say(sA, LV, { text: '@leaving' }, at(3)); say(sA, LV, { agent: 'w', label: 'w', text: '@was working' }, at(2)); sA.markGone(LV, at(1))
say(sC, CE, { agent: 'c1', label: 'c1', text: '@on C' }, at(2))
sA.setBells([{ name: 'Orch', project: 'AIMB' }])
const REM = remoteOf('HOST-A', [sB, sC], { 'HOST-C': at(1) })
const mainMap = () => unitMap(sA, REM)
const units = [...mainMap().values()].map(x => x.obj)
const U = Object.fromEntries(units.map(u => [u.id, u]))
const uo = p => nodeU(units, 'Orch', p)
const orchS = sessU(units, 'Orch'), orchSelf = orchS.self
const tree = X.buildTree(U, {})
const orch = tree.find(p => p.key === 'aimb').sessions.find(x => x.s.session === 'Orch')
const kidsOf = t => t.kids.map(k => k.u.path)
const find = (list, path) => { for (const t of list) { if (t.u.path === path) return t; const f = find(t.kids, path); if (f) return f } return null }
const deepPath = '#70/step4/spec-70/Tharsis/z12/deep'
check('fixture (2.0): the units are the bridge\'s — sessions by group key with each host\'s ROOT as self / selves (node_id), nodes by ["n", group, host, node id] with parent_id; the root carries the doorbell', orchS.multi_host && J(orchS.hosts) === J(['HOST-A', 'HOST-B']) && orchS.bell === true && /^[a-z2-7]{16}$/.test(orchSelf.node_id)
  && J(JSON.parse(uo('research').id)) === J(['n', orchS.key, 'host-a', uo('research').node_id]) && uo('research').parent_id === orchSelf.node_id && uo('research/Tharsis').parent_id === uo('research').node_id, J(uo('research')))
check('tree: projects A→Z with counts (sessions; active agents)', J(tree.map(p => [p.name, p.nSessions, p.nActive])) === J([['AIMB', 2, 5], ['Tools', 1, 0]]), J(tree.map(p => [p.name, p.nSessions, p.nActive])))
check('tree (6a; #82; 2.0): the session\'s top level = nodes whose parent_id is a host\'s ROOT — contexts first, then agents, each by RANK (creation order unless placed), across its hosts', J(kidsOf(orch)) === J(['#70', 'research', 'old', 'longrun', 'build', 'deploy']), J(kidsOf(orch)))
check('tree (6a; 2.0): children nest by parent_id to any depth (agents and contexts alike)', J(kidsOf(find(orch.kids, 'research'))) === J(['research/Tharsis', 'research/sub']) && J(kidsOf(find(orch.kids, 'research/Tharsis'))) === J(['research/Tharsis/z12', 'research/Tharsis/nol'])
  && !!find(orch.kids, deepPath) && find(orch.kids, deepPath).u.depth === 6, J(kidsOf(find(orch.kids, 'research'))))
check('tree (6a): each node knows its OWNER — the nearest agent above it, else the session\'s self (for its host)', find(orch.kids, 'research/Tharsis/z12').owner.path === 'research' && find(orch.kids, 'research/sub').owner.path === 'research'
  && find(orch.kids, '#70/step4').owner.node_id === orchSelf.node_id && find(orch.kids, '#70/step4').owner.nkind === 'session' && find(orch.kids, deepPath).owner.path === '#70/step4/spec-70')
const orphanTree = X.buildTree({ s: { id: 's', kind: 'session', key: 'k', session: 'S', project: 'P', self: { host: 'H', node_id: 'rrrrrrrrrrrrrrrr', nkind: 'session' } }, o: { id: 'o', kind: 'node', group: 'k', host: 'H', node_id: 'oooooooooooooooo', parent_id: 'pppppppppppppppp', nkind: 'context', path: 'p/lost', current: { id: 'x', ts: NOW, text: 'orphan', state: 'running' } } }, {})
check('tree (6a): a node whose parent has not arrived (a truncated slice) sits at the top level until it does', J(kidsOf(orphanTree[0].sessions[0])) === J(['p/lost']))
const act = X.buildTree(U, { activeOnly: true })
check('tree: active only hides finished + gone agents (with their subtrees) and sessions with nothing active (Leaver: left; Cee: its host down)', J(act.map(p => p.name)) === J(['AIMB']) && J(act[0].sessions.map(x => x.s.session)) === J(['Orch'])
  && J(kidsOf(act[0].sessions[0])) === J(['#70', 'research', 'old', 'longrun']), J(act.map(p => [p.name, p.sessions.map(x => [x.s.session, kidsOf(x)])])))
const resT = find(orch.kids, 'research'), resN = []; (function w(t) { resN.push(t.u.log.total); t.kids.forEach(w) })(resT)
check('subtreeCount: a subtree\'s entries (each node\'s gossiped log.total summed); null when one has no count', X.subtreeCount(resT) === resN.reduce((a, b) => a + b, 0) && X.subtreeCount({ u: { log: { remote: true } }, kids: [] }) === null, J(resN))

// ================================================================= (2) the rendered view
ws.readyState = 1; ws.onopen && ws.onopen()
recv({ type: 'welcome', gateway: 'HOST-A/aaa', sessions: [], pages: [], hosts: {}, bridge_version: '2.0.0', profile: {}, capabilities: {}, view: { user: 'robin', recs: [] } })
const sec = doc.querySelector('section.sec[data-sec="activity"]')
check('view (6c): the Activity section exists and is OPEN by default — it subscribes as soon as the bridge welcomes the page', !!sec && !sec.classList.contains('collapsed') && sentOf('activity_sub').length === 1 && !sentOf('activity_sub')[0].resync)
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('view: closing it unsubscribes (a closed one does not subscribe)', sec.classList.contains('collapsed') && sentOf('activity_unsub').length === 1 && sentOf('activity_sub').length === 1)
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('view: opening it again subscribes (activity_sub)', !sec.classList.contains('collapsed') && sentOf('activity_sub').length === 2 && !sentOf('activity_sub')[1].resync)
const mainHead = () => head2({ remote_hosts: [{ host: 'HOST-B', sessions: 1, nodes: 2, linked: true }, { host: 'HOST-C', sessions: 1, nodes: 1, down_at: at(1), linked: false }] })
const F1 = feed('E1', mainMap, mainHead)
F1.full()
const T = doc.getElementById('acttree')
const rowsT = () => [...T.querySelectorAll('.ar')]
const rowOf = re => rowsT().find(r => re.test(r.textContent))
const nmRow = name => rowsT().find(r => r.getAttribute('data-kind') === 'session' && r.querySelector('.nm')?.textContent === name)
const inS = (sname, p, host) => rowsT().find(r => r.getAttribute('data-kind') === 'node' && r.getAttribute('data-session') === sname && r.getAttribute('data-path') === p && (!host || r.getAttribute('data-host') === host)) || null
const pathRow = p => inS('Orch', p) || inS('Leaver', p) || inS('Cee', p)
const click = el => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const tog = el => click(el.querySelector('.chv'))   // 6d: the chevron expands; a click on the row SELECTS it (its log in the panel)
const PANEL = doc.getElementById('actpanel')
const pRows = () => [...(PANEL?.querySelectorAll('.ar') || [])]
const dOf = r => Number(r?.style.getPropertyValue('--d'))
const pills = r => [...(r?.querySelectorAll('.pill') || [])].map(p => p.className.replace('pill ', ''))
const tipOf = el => { el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); return el.getAttribute('title') }
check('view: project rows with their counts', /AIMB2 sessions · 5 active agents/.test(rowOf(/^▾📁 AIMB/)?.textContent || '') && /Tools1 session · 0 active agents/.test(rowOf(/📁 Tools/)?.textContent || ''), rowsT().slice(0, 3).map(r => r.textContent).join(' | '))
check('view (step 10, Q29 / Q41): the header tag names whose VIEW this is ("view: robin")', /· view: robin$/.test(doc.getElementById('acttag').textContent), doc.getElementById('acttag').textContent)
const orchRow = nmRow('Orch')
check('view: the session row — name, one host tag per host, its own line RENDERED against its rollup bar, ⌛, 🔔', !!orchRow && J([...orchRow.querySelectorAll('.htag')].map(h => h.textContent)) === J(['HOST-A', 'HOST-B'])
  && orchRow.querySelector('.ln').textContent === X.renderText('coordinating {progress}', X.barOf(orchSelf), null, NOW) && /^coordinating \d/.test(orchRow.querySelector('.ln').textContent) && !!orchRow.querySelector('.pb.roll') && /⌛/.test(orchRow.textContent) && /🔔/.test(orchRow.textContent), orchRow && orchRow.innerHTML)
const resRow = pathRow('research')
check('view (6a): the DEFAULT view = sessions + their top-level nodes; deeper nodes stay closed', !!resRow && !!pathRow('#70') && !!pathRow('build') && !pathRow('research/sub') && !pathRow('research/Tharsis') && !pathRow('#70/step4'))
check('view: an agent row — monospace name (its LABEL), glyph with the ring, rendered line, bar, ETA; 6b: NO host tag on the home host (as its parent row); data-path / data-nid', resRow.querySelector('.nm.path')?.textContent === 'research' && resRow.querySelector('.ln').textContent === 'reading 4,812 of 12,000 tiles'
  && !!resRow.querySelector('svg.gl circle.ring') && /⌛/.test(resRow.textContent) && !resRow.querySelector('.htag') && dOf(resRow) === 2 && resRow.getAttribute('data-nid') === uo('research').node_id && resRow.getAttribute('data-path') === 'research', resRow?.innerHTML)
check('view (6b): a host tag only where the host of a node differs from that of its parent — a top-level node on another host than the home host', pathRow('build')?.querySelector('.htag')?.textContent === 'HOST-B' && pathRow('deploy')?.querySelector('.htag')?.textContent === 'HOST-B' && !pathRow('old').querySelector('.htag'))
const c70 = pathRow('#70')
check('view (6a): a path-made grouping context — "#70" (2.0: no "@"), no current line (the line left EMPTY), the "none" mark, its rolled-up bar, no pills', c70.querySelector('.nm.ctx')?.textContent === '#70' && c70.querySelector('.ln.none')?.textContent === ''
  && !!c70.querySelector('svg.s-none') && !!c70.querySelector('.pb.roll') && c70.querySelectorAll('.pill').length === 0, c70?.innerHTML)
tog(resRow)
check('expand a node (6a; 6d: by its chevron): its children (a context + a sub-agent), one level deeper — no Log row in the tree; nothing selected or fetched', !rowsT().some(r => r.classList.contains('lg') || /\bLog\b/.test(r.querySelector('.nm')?.textContent || ''))
  && !!pathRow('research/sub') && !!pathRow('research/Tharsis') && dOf(pathRow('research/sub')) === 3 && dOf(pathRow('research/Tharsis')) === 3 && !resRow.classList.contains('sel') && sentOf('activity').length === 0)
check('expand (step 10, §5.6): the viewer\'s choice is an open:<node id> record of the per-user view ({o:1}), queued for the debounced view_set', J(V.viewQ['open:' + uo('research').node_id]) === J({ o: 1 }) && J(X.viewGet(V.view, 'open:' + uo('research').node_id)) === J({ o: 1 }), J(V.viewQ))
const thRow = pathRow('research/Tharsis')
check('view (6a): a context row — "Tharsis", a state MARK (no ring), its line rendered against its own bar, the bar; fresh because its agent is', thRow.querySelector('.nm.ctx')?.textContent === 'Tharsis' && !!thRow.querySelector('svg.gl.ctx') && !thRow.querySelector('circle.ring')
  && thRow.querySelector('.ln').textContent === 'tiling 2 of 8 tiles' && !!thRow.querySelector('.pb') && !thRow.classList.contains('stale'), thRow.innerHTML)
tog(thRow)
const nol = pathRow('research/Tharsis/nol'), z12 = pathRow('research/Tharsis/z12')
check('view (6a): nested contexts under the open context; one with no line shows an empty line and no pills', dOf(z12) === 4 && dOf(nol) === 4 && nol.querySelector('.ln.none')?.textContent === '' && nol.querySelectorAll('.pill').length === 0 && z12.querySelector('.ln .lt').textContent === 'with attachments' && z12.querySelector('.ln .ddm')?.textContent === '¶{}')
check('view: pills only for blocked / failed / stale / gone (running and done have none)', J(pills(pathRow('research/sub'))) === J(['blocked']) && J(pills(pathRow('deploy'))) === J(['failed']) && J(pills(pathRow('old'))) === J(['stale'])
  && J(pills(pathRow('w'))) === J(['gone']) && J(pills(resRow)) === '[]' && J(pills(pathRow('build'))) === '[]', J([pills(pathRow('research/sub')), pills(pathRow('deploy')), pills(pathRow('old')), pills(pathRow('w'))]))
tog(pathRow('old'))
const oc = pathRow('old/ctx')
check('view (6a): a context under a STALE agent shows stale (greyed + pill) — inherited, not its own', !!oc && oc.classList.contains('stale') && J(pills(oc)) === J(['stale']) && !!oc.querySelector('svg.gl.ctx.s-stale'), oc && oc.outerHTML)
check('view: host down is a DISTINCT badge (not "gone") on the host\'s session + agents; its host tag is marked', J(pills(pathRow('c1'))) === J(['hostdown']) && J(pills(nmRow('Cee'))) === J(['hostdown']) && !!nmRow('Cee').querySelector('.htag.down'), J([pills(pathRow('c1')), pills(nmRow('Cee'))]))
check('view: a stale row greys out (class stale); an item\'s own stale_after keeps it live', pathRow('old')?.classList.contains('stale') && !pathRow('longrun')?.classList.contains('stale') && !resRow.classList.contains('stale'))
check('view: no inline time text in the lines / names (times live in the hover tooltips; the TIME column is its own)', rowsT().every(r => !/\bago\b|\d\d:\d\d|\b\d+m\b|\b\d+s\b/.test(r.querySelector('.ln')?.textContent + (r.querySelector('.nm')?.textContent || ''))), rowsT().map(r => r.textContent).filter(t => /ago|\d\d:\d\d/.test(t)).join(' | '))
for (const p of ['#70', '#70/step4', '#70/step4/spec-70', '#70/step4/spec-70/Tharsis', '#70/step4/spec-70/Tharsis/z12']) tog(pathRow(p))
const deep = pathRow(deepPath)
check('view (6a): depth 6 — the chain opens node by node; the deepest row sits at --d 7 (one 16px step per level), its line rendered', !!deep && dOf(deep) === 7 && deep.querySelector('.ln').textContent === 'six levels down 1 of 4 tiles' && dOf(pathRow('#70/step4/spec-70')) === 4, deep && deep.outerHTML)
const css = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n')
check('view (6a): indentation is 16px per level (readable at depth 6), tighter on a phone; light/dark tokens kept', /\.ar \{[^}]*calc\(6px \+ var\(--d, 0\) \* 16px\)/.test(css) && /@media \(max-width: 720px\)/.test(css) && /:root\[data-theme="dark"\]/.test(css) && /\.ar \.nm\.ctx \{[^}]*var\(--info\)/.test(css))
check('view (6a): an agent under a task context gets the ring; a context in between shows "none" when it has no line', !!pathRow('#70/step4/spec-70').querySelector('circle.ring') && !!pathRow('#70/step4').querySelector('svg.s-none'))
const g = resRow.querySelector('[data-tip]')
check('view: hovering the glyph shows the actual times', /^Running\nstarted \d\d:\d\d:\d\d/.test(tipOf(g) || '') && /stale at/.test(g.getAttribute('title')), g.getAttribute('title'))
check('view (6a): hovering a context\'s mark names the agent its staleness follows', /staleness follows agent research/.test(tipOf(pathRow('research/Tharsis').querySelector('[data-tip]')) || ''))
const bar = resRow.querySelector('.pb'), eta = [...resRow.querySelectorAll('.ic')].find(i => i.textContent === '⌛'), bell = [...orchRow.querySelectorAll('.ic')].find(i => i.textContent === '🔔')
check('view: bar / ⌛ / 🔔 tooltips', tipOf(bar) === '4,812 of 12,000 tiles (40%) — reported' && /^ETA ~30m \(estimated\), about \d\d:\d\d$/.test(tipOf(eta)) && /^Doorbell armed/.test(tipOf(bell)), J([bar.getAttribute('title'), eta.getAttribute('title'), bell.getAttribute('title')]))
check('view (step 10 TIME): an agent with an open attempt shows "running …" beside its line (the page\'s clock; its tooltip says when it started)', /^running \d/.test(resRow.querySelector('.tk')?.textContent || '') && /started \d\d:\d\d/.test(tipOf(resRow.querySelector('.tk')) || ''), resRow.querySelector('.tk')?.outerHTML)
const nSent = ws.sent.length, sl = doc.getElementById('actStale')
sl.value = '45'; sl.dispatchEvent(new win.Event('input'))
check('slider: 45 min → the 31-min-quiet agent AND its context are live again at once, with no message to the bridge (and nothing for the view)', !pathRow('old').classList.contains('stale') && !pathRow('old/ctx').classList.contains('stale') && J(pills(pathRow('old'))) === '[]' && ws.sent.length === nSent && /45m/.test(doc.getElementById('actStaleV').textContent) && !Object.keys(V.viewQ).some(k => /stale/.test(k)))
sl.value = '15'; sl.dispatchEvent(new win.Event('input'))
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
check('active only (step 10, Q38): kept in the per-user view (opt:active_only), not in this browser', X.viewGet(V.view, 'opt:active_only') === true && win.localStorage.getItem('aimb.act.active') === null, J(V.viewQ))
ao.checked = false; ao.dispatchEvent(new win.Event('change'))
check('... unticked: a tombstone (back to the default)', V.viewQ['opt:active_only'] === null && X.viewGet(V.view, 'opt:active_only') === undefined)
doc.getElementById('actCollapse').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Collapse all closes every expanded row (back to the default view) — ONE view record (all {o:0}), not one per row', !pathRow('research/sub') && !!pathRow('research') && J(V.viewQ.all) === J({ o: 0 }), J(V.viewQ.all))
// the session's log (the whole session on its headline host)
check('log panel (6d): hidden while nothing is selected (the tree takes the width)', doc.getElementById('actmain').classList.contains('nosel') && PANEL.children.length === 0)
const answerLog = (st, m, o = {}) => { const q = { ...m.query.log, ...o }; const r = st.logPage(q, NOW); recv({ type: 'activity', ref: m.ref, result: r.ok === false ? r : { ok: true, log: { ...r, host: st.host } } }); return r }
click(nmRow('Orch'))
const lq = sentOf('activity').pop()
check('select a session (6d: a click): its row is highlighted and the LOG PANEL asks for the whole session\'s log — session, project, user, the headline host and (2.0) its ROOT\'s node id; no path', nmRow('Orch').classList.contains('sel') && nmRow('Orch').getAttribute('aria-selected') === 'true'
  && lq?.query?.log?.session === 'Orch' && lq.query.log.host === 'HOST-A' && lq.query.log.project === 'AIMB' && lq.query.log.user === 'robin' && lq.query.log.id === orchSelf.node_id && !('path' in lq.query.log) && lq.query.log.limit === 50 && !doc.getElementById('actmain').classList.contains('nosel'), J(lq))
check('select (step 10, §5.6): the selection is remembered in the view as sel = the node id (restored at the next load)', V.viewQ.sel === orchSelf.node_id)
check('log panel (6d): its header — "Log", the session, its host tag, the count; a multi-host session offers each host', /^Log/.test(PANEL.querySelector('.aph-t')?.textContent || '') && PANEL.querySelector('.aph-t .htag')?.textContent === 'HOST-A' && /whole session/.test(PANEL.querySelector('.aph-s')?.textContent || '')
  && J([...PANEL.querySelectorAll('[data-ph]')].map(b => b.getAttribute('data-ph'))) === J(['HOST-A', 'HOST-B']), PANEL.querySelector('.aph')?.textContent)
recv({ type: 'activity_queued', ref: lq.ref, wait_ms: 1500, position: 3 })
check('a queued fetch shows a spinner + its wait (in the panel)', /queued — about 2s/.test(PANEL.textContent) && !!PANEL.querySelector('.spin'))
const lp1 = answerLog(sA, lq, { limit: 4 })
const eRows = () => pRows().filter(r => r.classList.contains('le'))
check('log entries (#87: OLDEST first — the newest at the bottom): time, state dot, the entry\'s tag RELATIVE to the node (2.0: "@" when it set that line), rendered text — the store\'s own page', eRows().length === 4 && /^\d\d:\d\d:\d\d$/.test(eRows()[3].querySelector('.tm').textContent)
  && J(eRows().map(r => r.querySelector('.ctag').textContent)) === J(lp1.entries.slice().reverse().map(e => X.entryTag(e))) && eRows()[3].querySelector('.ctag').textContent === '@research/Tharsis/z12' && eRows()[2].querySelector('.ctag').textContent === 'here' && eRows().some(r => r.querySelector('.ctag').textContent === '@#70/step4/spec-70/Tharsis/z12/deep')
  && eRows()[3].getAttribute('data-id') === lp1.entries[0].id && !!eRows()[0].querySelector('.dot'), eRows().map(r => r.textContent).join(' | '))
const older = pRows().find(r => /load older/.test(r.textContent))
click(older)
const lq2 = sentOf('activity').pop()
check('"load older" asks for the next page with the cursor', lq2.query.log.cursor === lp1.next_cursor && !!lp1.next_cursor && lq2.query.log.host === 'HOST-A', J(lq2))
const lp2 = answerLog(sA, lq2, { limit: 100 })
check('... the page goes ABOVE (#87: oldest first), and the end of the log has no "load older"', eRows().length === 4 + lp2.entries.length && eRows()[0].getAttribute('data-id') === lp2.entries.at(-1).id && eRows().at(-1).getAttribute('data-id') === lp1.entries[0].id && !pRows().some(r => /load older/.test(r.textContent)))
const attRow = eRows().find(r => /with attachments/.test(r.textContent)), attId = attRow?.getAttribute('data-id')
click(attRow)
const eq = sentOf('activity').pop()
check('an entry with details/data expands → fetches it by id + host', eq.query.entry?.id === attId && eq.query.entry.host === 'HOST-A', J(eq))
recv({ type: 'activity', ref: eq.ref, result: sA.entry(attId, NOW) })
const det = PANEL.querySelector('.apb .ad')
check('... showing the details text and the data as a JSON TREE (#86) — the store\'s own entry', !!det && det.querySelector('pre.dtx')?.textContent === 'DETAIL TEXT' && det.querySelectorAll('pre').length === 1 && !!det.querySelector('.jt details[open]') && /rows: 42/.test(det.querySelector('.jt').textContent) && /ok: true/.test(det.querySelector('.jt').textContent), det && det.innerHTML)
click(pathRow('research'))
const aq = sentOf('activity').pop()
check('select a node (6d; 2.0): the selection MOVES and the panel asks BY ITS NODE ID (+ host) — the subtree merged by the bridge', aq.query.log.id === uo('research').node_id && aq.query.log.host === 'HOST-A' && !('path' in aq.query.log) && !('agent' in aq.query.log)
  && pathRow('research').classList.contains('sel') && !nmRow('Orch').classList.contains('sel') && /this node and below/.test(PANEL.querySelector('.aph-s')?.textContent || '') && PANEL.querySelector('.aph-t .nm')?.textContent === 'research', J(aq))
recv({ type: 'activity', ref: aq.ref, result: { ok: false, code: 'busy', retry_after_ms: 800, what: 'too many history fetches are waiting' } })
check('a busy answer offers a retry', /busy: too many history fetches are waiting — click to retry/.test(PANEL.textContent))
tog(pathRow('research'))
// deltas (planDashDelta2 of the store's changes), a gap → resync, expand / collapse all, unsubscribe
say(sA, OR, { agent: 'research', text: '@writing up' }, at(0.5))
say(sA, OR, { agent: 'research', key: 'fresh', label: 'new', text: '@a context that just appeared' }, at(0.4))
const dep = nodeU(units, 'Orch', 'deploy')
const dm = sB.action({ ...OR, id: dep.node_id, action: 'dismiss', args: {} }, at(0.3), BY)
const d1 = F1.delta()
check('a delta updates a row in place, adds a nested node under its (open) parent, and removes another (the dismissed deploy: its unit id left)', dm.ok && pathRow('research').querySelector('.ln').textContent === 'writing up' && !pathRow('deploy') && !!pathRow('research/new') && dOf(pathRow('research/new')) === 3 && d1.remove.includes(dep.id), J([dm.code, d1.remove]))
recv({ type: 'activity_delta', epoch: 'E1', seq: 9, base: 8, upsert: [], remove: [] })
check('a delta that doesn\'t follow (lost frames) → the page asks for a resync', sentOf('activity_sub').length === 3 && sentOf('activity_sub')[2].resync === true)
F1.full()
check('... and the full board restores the view', !!pathRow('research/new') && /coordinating/.test(nmRow('Orch').textContent) && !!pathRow('research/sub'))
doc.getElementById('actCollapse').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Collapse all closes every expanded row', !pathRow('research/sub') && !pathRow('#70/step4'))
const nReq = sentOf('activity').length
doc.getElementById('actExpand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('Expand all opens every session and every node down to depth 6 (no log is fetched by it) — the view\'s all {o:1}', !!pathRow(deepPath) && !!pathRow('research/Tharsis/nol') && sentOf('activity').length === nReq && J(V.viewQ.all) === J({ o: 1 }), `${sentOf('activity').length - nReq}`)
// ---- step 10: view_set is DEBOUNCED (~1 s): the clicks above went out as ONE view_set with the latest value of each key
const vs0 = sentOf('view_set').length
await tick(1150)
const vsm = sentOf('view_set').slice(vs0)
check('step 10 view_set (§5.6): debounced — about a second after the first change ONE view_set carries every queued record (the latest value per key: all {o:1}, sel, open:<id> …); then the queue is empty',
  vsm.length === 1 && J(vsm[0].recs.find(r => r.k === 'all')?.v) === J({ o: 1 }) && vsm[0].recs.filter(r => r.k === 'all').length === 1 && vsm[0].recs.some(r => r.k === 'open:' + uo('research').node_id) && vsm[0].recs.every(r => !('ts' in r)) && !Object.keys(V.viewQ).length, J(vsm.map(m => m.recs)))
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
check('leaving (collapsing the section) unsubscribes', sentOf('activity_unsub').length === 2)
const legend = doc.getElementById('actlegend')
check('legend: the agent glyphs + the context mark + the plan-item marks + the session glyphs + the question bubbles + the ring / hover hint; step 10: types, TIME and your view', legend.querySelectorAll('svg').length >= 20 && /question: awaiting an answer/.test(legend.textContent) && /plan item: to do · in progress · done · skipped/.test(legend.textContent) && /ring is the time left before an agent goes stale/.test(legend.textContent) && /hover the icons/.test(legend.textContent) && /context \(no ring/.test(legend.textContent)
  && /a group \(a list, not a plan/.test(legend.textContent) && /a test run/.test(legend.textContent) && /took 4m 12s/.test(legend.textContent) && /your VIEW/.test(legend.textContent) && /new since you last looked/.test(legend.textContent), legend.querySelectorAll('svg').length)
try {   // a crash counts as one failure
// ================================================================= 6b (v1.63.0): plan items, the plan bar, active only, host tags, per-host headlines — on 2.0 units
const pi = (path, st, extra = {}) => ({ kind: 'node', nkind: 'context', plan_item: true, path, state: st, current: { id: `c-${path}`, ts: NOW - MIN, text: path, state: st }, ...extra })
check('6b glyph: ☐ todo = an empty box; ☑ done = a box + tick; skipped = a box struck through; running / blocked = the in-progress mark (no ring)', /s-todo.*<rect[^>]*rx="2\.2"[^>]*\/><\/svg>$/.test(X.planGlyph('todo')) && /s-done.*<rect.*<path d="M5 8\.2/.test(X.planGlyph('done'))
  && /s-skipped.*<path d="M4\.8 8 L11\.2 8"/.test(X.planGlyph('skipped')) && /s-running.*<rect x="4\.5"/.test(X.planGlyph('running')) && /s-blocked/.test(X.planGlyph('blocked')) && !/ring/.test(X.planGlyph('running')) && X.glyphSvg({ state: 'done' }, NOW, 'plan') === X.planGlyph('done'))
const quietAgent = run(600)
check('6b stale: a plan item never goes stale (any state), even under a stale or gone agent — its own state shows', ['todo', 'running', 'blocked'].every(s => (e => e.state === s && !e.stale && e.staleAt === null && e.plan)(X.effState(pi('x', s, { last_activity: NOW - 600 * MIN }), quietAgent, NOW, 15)))
  && X.effState(pi('x', 'todo'), { state: 'gone' }, NOW, 15).state === 'todo' && X.effState(quietAgent, null, NOW, 15).state === 'stale')
check('6b tooltip: a plan item says so (never goes stale), not "staleness follows"', (t => /^Plan item — To do/.test(t) && /never goes stale/.test(t) && !/staleness follows/.test(t))(X.statusTip(pi('x', 'todo'), quietAgent, NOW, 15)))
check('#79 bar tooltip: "2 of 5 done · 1 skipped (40%) — its plan: 5 items" (skipped inside M); a 1.65 bridge\'s bar form (skipped left OUT of M) reads the same (norm3, pure)', X.barTip({ done: 2, skipped: 1, total: 5, unit: 'done', rollup: true, todos: true, items: true, n: 5 }) === '2 of 5 done · 1 skipped (40%) — its plan: 5 items'
  && X.barTip({ done: 2, total: 4, unit: 'done', rollup: true, todos: true, skipped: 1, n: 5 }) === '2 of 5 done · 1 skipped (40%) — its plan: 5 items')
// the plan fixture (2.0 stores): Planner (HOST-A, + HOST-B: helper) — a session-level plan #70 with items in every state (created in one call), an agent
// under an item, a nested plan under an item, a failed agent holding an open item, a plan that ended (all done); Sixc (home HOST-B: B was first) — an
// open plan (a skipped + an abandoned item), plans ended 28 min and 3 h ago, agents on both hosts; Rollup — a root rolling up a finished and a live agent;
// Sixd (+ HOST-C, not down) — a stale lead holding an open plan, an agent holding a plan under a line-less context, a finished agent, a fresh one, a
// plan ended by its items, one ended by "complete" with an item still open, a remote agent
const sP = createStore2({ host: 'HOST-A' }), sPB = createStore2({ host: 'HOST-B' }), sPC = createStore2({ host: 'HOST-C' })
const PL = who('Planner'), SX = who('Sixc', 'SixC'), RO = who('Rollup', 'SixC'), SD = who('Sixd', 'SixD')
say(sP, PL, { key: 'p70', label: '#70', plan: ['Spec', 'Build', 'Test', 'Docs', 'Review', 'Ship'].map(l => ({ key: l.toLowerCase(), label: l })) }, at(30))
say(sP, PL, { key: 'spec', state: 'done' }, at(29)); say(sP, PL, { key: 'build', state: 'running' }, at(28)); say(sP, PL, { key: 'test', state: 'blocked' }, at(27))
say(sP, PL, { key: 'docs', state: 'skipped' }, at(26))
say(sP, PL, { agent: 'builder', label: 'builder', under: 'build', text: '@compiling' }, at(40))
say(sP, PL, { key: 'build', plan: [{ key: 'unit', label: 'unit' }, { key: 'e2e', label: 'e2e' }] }, at(25)); say(sP, PL, { key: 'unit', state: 'done' }, at(24))
say(sP, PL, { agent: 'retired', label: 'retired', plan: [{ key: 'leftover', label: 'leftover' }] }, at(30)); say(sP, PL, { agent: 'retired', text: '@stopped', state: 'failed' }, at(5))
say(sP, PL, { key: 'shipped', label: 'shipped', plan: [{ key: 'sa', label: 'a' }, { key: 'sb', label: 'b' }] }, at(30)); say(sP, PL, { key: 'sa', state: 'done' }, at(29)); say(sP, PL, { key: 'sb', state: 'done' }, at(28))
say(sP, PL, { key: 'review', text: '@approved by Robin', state: 'done' }, at(1.5)); say(sP, PL, { text: '@planning #70' }, at(1))
say(sPB, PL, { text: '@older headline on B' }, at(20)); say(sPB, PL, { agent: 'helper', label: 'helper', text: '@on B' }, at(1)); say(sPB, PL, { agent: 'helper', key: 'ctx', label: 'ctx', text: '@B context' }, at(1))
say(sPB, SX, { text: '@B was here first' }, at(300)); say(sPB, SX, { agent: 'bnode', label: 'bnode', text: '@on B, the home host' }, at(1)); say(sPB, SX, { agent: 'bnode', key: 'bctx', label: 'ctx', text: '@b ctx' }, at(1))
say(sP, SX, { key: 'opn', label: 'open', plan: [{ key: 'oa', label: 'a' }, { key: 'ob', label: 'b' }, { key: 'oc', label: 'c' }] }, at(240)); say(sP, SX, { key: 'oa', state: 'done' }, at(239)); say(sP, SX, { key: 'ob', state: 'skipped' }, at(238)); say(sP, SX, { key: 'oc', state: 'abandoned' }, at(238))
say(sP, SX, { key: 'recent', label: 'recent', plan: [{ key: 'rx', label: 'x' }, { key: 'ry', label: 'y' }] }, at(60)); say(sP, SX, { key: 'rx', state: 'done' }, at(31)); say(sP, SX, { key: 'ry', state: 'done' }, at(28))
say(sP, SX, { key: 'old', label: 'old', plan: [{ key: 'oz', label: 'z' }] }, at(200)); say(sP, SX, { key: 'oz', state: 'done' }, at(180))
say(sP, SX, { agent: 'anode', label: 'anode', text: '@on A, the non-home host', state: 'blocked' }, at(1)); say(sP, SX, { text: '@headline from A (newer)' }, at(1))
say(sP, RO, { text: '@rolling {progress}' }, at(10)); say(sP, RO, { agent: 'worker', label: 'worker', text: '@all files', progress: '6/6 files', state: 'done' }, at(5)); say(sP, RO, { agent: 'live', label: 'live', text: '@some files', progress: '2/6 files' }, at(1)); say(sP, RO, { text: 'rolling on' }, at(1))
say(sP, SD, { agent: 'lead', label: 'lead', text: '@leading', plan: [{ key: 'x', label: 'x' }, { key: 'y', label: 'y' }] }, at(41)); say(sP, SD, { agent: 'lead', key: 'y', state: 'done' }, at(40))
say(sP, SD, { path: 'grp' }, at(39)); say(sP, SD, { agent: 'deep', label: 'deep', under: 'grp', text: '@deep agent', plan: [{ key: 'p1', label: 'p1' }] }, at(1))
say(sP, SD, { agent: 'done1', label: 'done1', text: '@finished', state: 'done' }, at(10))
say(sP, SD, { agent: 'fresh', label: 'fresh', text: '@fresh work' }, at(1))
say(sP, SD, { key: 'alldone', label: 'alldone', plan: [{ key: 'ada', label: 'a' }] }, at(9)); say(sP, SD, { key: 'ada', state: 'done' }, at(5))
say(sP, SD, { key: 'cmpl', label: 'cmpl', plan: [{ key: 'cmo', label: 'open' }] }, at(9))
say(sP, SD, { text: '@orchestrating 6d' }, at(1))
say(sPC, SD, { agent: 'rem', label: 'rem', text: '@remote work' }, at(50))
{ const u0 = unitsOf(sP), r = sP.action({ ...SD, id: nodeU(u0, 'Sixd', 'cmpl').node_id, action: 'complete', args: {} }, at(5), BY); if (!r.ok) throw new Error('fixture complete: ' + r.code) }
const REM6 = remoteOf('HOST-A', [sPB, sPC])
const map6 = () => new Map([...mainMap(), ...unitMap(sP, REM6)])
const u6 = () => [...map6().values()].map(x => x.obj)
const U6 = Object.fromEntries(u6().map(u => [u.id, u]))
const pt = X.buildTree(U6, {}).find(p => p.key === 'aimb').sessions.find(x => x.s.session === 'Planner')
check('6b tree: plan items in CREATION order — one call\'s items keep the given order (their derived ranks), never A→Z', J(kidsOf(find(pt.kids, '#70'))) === J(['#70/Spec', '#70/Build', '#70/Test', '#70/Docs', '#70/Review', '#70/Ship']), J(kidsOf(find(pt.kids, '#70'))))
check('6b tree (#82 order): under an item, its nested plan\'s items first, then the agent working under it', J(kidsOf(find(pt.kids, '#70/Build'))) === J(['#70/Build/unit', '#70/Build/e2e', '#70/Build/builder']), J(kidsOf(find(pt.kids, '#70/Build'))))
check('6b/6c open / ended (pure): isOpenItem (todo / running / blocked); planEnded = EVERY item done, or the plan node marked done / abandoned (skipped keeps it open); a plan node: its plan_end_at', X.isOpenItem(pi('a', 'todo')) && X.isOpenItem(pi('a', 'blocked')) && !X.isOpenItem(pi('a', 'done')) && !X.isOpenItem({ nkind: 'context', state: 'running' })
  && X.planEnded([pi('a', 'done'), pi('b', 'done')]) && !X.planEnded([pi('a', 'done'), pi('b', 'skipped')]) && !X.planEnded([pi('a', 'done'), pi('b', 'todo')]) && !X.planEnded([{ nkind: 'context' }])
  && X.planEnded([pi('a', 'todo')], { current: { state: 'abandoned' } }) && X.planEnded([pi('a', 'failed')], { current: { state: 'done' } }) && !X.planEnded([pi('a', 'todo')], { current: { state: 'failed' } })
  && X.planEnded([pi('a', 'todo')], { plan_node: true, plan_end_at: NOW }) && !X.planEnded([pi('a', 'done')], { plan_node: true }))
const pa = X.buildTree(U6, { activeOnly: true }).find(p => p.key === 'aimb').sessions.find(x => x.s.session === 'Planner')
check('6b active only: a finished agent holding an OPEN item stays (with it); an ENDED plan disappears (its items and its plain node); an open plan keeps its done / skipped items', !!find(pa.kids, 'retired') && !!find(pa.kids, 'retired/leftover') && !find(pa.kids, 'shipped') && !find(pa.kids, 'shipped/a')
  && J(kidsOf(find(pa.kids, '#70'))) === J(['#70/Spec', '#70/Build', '#70/Test', '#70/Docs', '#70/Review', '#70/Ship']), J(pa.kids.map(t => t.u.path)))
check('6b host tags: hostTagOn — only where a node\'s host differs from its parent\'s (a top-level node: the home host\'s)', !X.hostTagOn(find(pt.kids, '#70'), true) && X.hostTagOn(find(pt.kids, 'helper'), true) && !X.hostTagOn(find(pt.kids, 'helper/ctx'), true)
  && !X.hostTagOn(find(pt.kids, '#70/Build/unit'), true) && !X.hostTagOn(find(pt.kids, 'helper'), false) && X.hostTagOn({ u: { host: 'B' }, parentHost: 'A' }, true))
// ---- step 10: RESET VIEW (the main section left Expand all + open / closed records) — asked first, then every choice back to its default, live
sec.querySelector('.sech').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const F6 = feed('E6', map6, () => head2({ log_cmd: LC, remote_hosts: [{ host: 'HOST-B', sessions: 2, nodes: 4, linked: true }, { host: 'HOST-C', sessions: 1, nodes: 1, linked: true, log_cmd: { node: '/usr/bin/node', script: '/opt/aimb/tools/aimb-log.mjs', token_file: null } }] }))
F6.full()
check('step 10 (before the reset): the main board\'s Expand all still covers its nodes (all {o:1} — research\'s subtree is open)', !!pathRow('research/sub') && X.viewGet(V.view, 'all')?.o === 1)
const nVs = sentOf('view_set').length
click(doc.getElementById('actReset'))
const rdl = doc.querySelector('.act-dlg')
check('step 10 Reset view: a CONFIRM first (what goes back to the defaults, everywhere; whose view) — nothing changed or sent yet', !!rdl && /Reset your view\?/.test(rdl.querySelector('h3')?.textContent || '') && /pins, hidden rows, open \/ closed/.test(rdl.textContent) && /robin/.test(rdl.textContent) && X.viewGet(V.view, 'all')?.o === 1 && !('reset' in V.viewQ))
click(rdl.querySelector('[data-dlg="ok"]'))
check('step 10 Reset view → the reset record, SENT AT ONCE (not debounced: whatever was queued is void anyway) as view_set {reset:1} — the bridge stamps it above every record of this user; every older record of the view VOID: the main board back to its defaults (research closed again, the options off)', !Object.keys(V.viewQ).length && sentOf('view_set').length === nVs + 1 && J(sentOf('view_set').at(-1).recs) === J([{ k: 'reset', v: 1 }]) && !Object.keys(V.view.recs).length && V.view.reset > 0 && !pathRow('research/sub') && !!pathRow('research') && !ao.checked && !doc.querySelector('.act-dlg'), J([V.viewQ, Object.keys(V.view.recs), V.view.reset, !!pathRow('research/sub'), !!pathRow('research'), ao.checked, !!doc.querySelector('.act-dlg')]))
const inPlanner = p => inS('Planner', p)
const p70 = inPlanner('#70')
check('6b view: the plan node shows its "N of M done" bar (solid, class plan) with the plan tooltip; its type glyph (a context holding items: no ☰)', !!p70?.querySelector('.pb.plan') && tipOf(p70.querySelector('.pb')) === '2 of 6 done · 1 skipped (33%) — its plan: 6 items', p70 && p70.innerHTML)
const itemRows = () => rowsT().filter(r => r.classList.contains('pi') && r.getAttribute('data-session') === 'Planner' && dOf(r) === 3 && r.getAttribute('data-path').startsWith('#70/'))
check('6b view (+ 6c: an OPEN plan is open by default): the items render in creation order with ☐ / the in-progress mark / ☑ / struck-through skipped', J(itemRows().map(r => r.querySelector('.nm').textContent)) === J(['Spec', 'Build', 'Test', 'Docs', 'Review', 'Ship'])
  && !!inPlanner('#70/Ship').querySelector('svg.s-todo rect[rx="2.2"]') && !!inPlanner('#70/Spec').querySelector('svg.s-done path') && inPlanner('#70/Spec').classList.contains('pdone')
  && !!inPlanner('#70/Build').querySelector('svg.s-running') && inPlanner('#70/Docs').classList.contains('skipped') && !!inPlanner('#70/Docs').querySelector('svg.s-skipped'), J(itemRows().map(r => r.className)))
check('6b view: skipped = struck through (CSS); an item\'s line is hidden while it is just its name, shown once it says more', /\.ar\.skipped \.nm, \.ar\.skipped \.ln \{[^}]*line-through/.test(css) && inPlanner('#70/Ship').querySelector('.ln').textContent === '' && inPlanner('#70/Review').querySelector('.ln').textContent === 'approved by Robin')
check('6b view: a plan item never shows a stale pill — under its quiet agent the agent row does (its own staleness)', !inPlanner('#70/Build').classList.contains('stale') && J(pills(inPlanner('#70/Test'))) === J(['blocked']))
check('6b view (6d: an item holding an open plan is open by default): the nested plan under an item and the agent working under it; the agent shows its own stale', !!inPlanner('#70/Build/unit') && !!inPlanner('#70/Build/e2e') && inPlanner('#70/Build/builder')?.classList.contains('stale') && J(pills(inPlanner('#70/Build/builder'))) === J(['stale']))
check('6b view (host tags): none on the home host\'s top-level rows or on any child of a same-host parent; HOST-B\'s top-level node carries HOST-B', !p70.querySelector('.htag') && !inPlanner('#70/Ship').querySelector('.htag') && inPlanner('helper')?.querySelector('.htag')?.textContent === 'HOST-B')
const plRow = nmRow('Planner')
check('6b view: the multi-host session row keeps a tag for every host and the headline of the host that most recently set one', J([...plRow.querySelectorAll('.htag')].map(h => h.textContent)) === J(['HOST-A', 'HOST-B']) && plRow.querySelector('.ln').textContent === 'planning #70')
tog(plRow)
const hselfRows = rowsT().filter(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Planner')
check('6b view: expanded, each host\'s OWN line shows (HOST-A\'s headline, HOST-B\'s older one) — the session row\'s open state is the view\'s open:<its unit id>', J(hselfRows.map(r => [r.querySelector('.htag').textContent, r.querySelector('.ln').textContent])) === J([['HOST-A', 'planning #70'], ['HOST-B', 'older headline on B']]) && X.viewGet(V.view, 'open:' + sessU(u6(), 'Planner').id)?.o === 1, J(hselfRows.map(r => r.textContent)))
ao.checked = true; ao.dispatchEvent(new win.Event('change'))
check('6b view (active only): the open item under a finished agent stays visible; the ended plan is gone; the open plan stays complete', !!inPlanner('retired') && !inPlanner('shipped') && !!inPlanner('#70/Spec') && !!inPlanner('#70/Docs'))
ao.checked = false; ao.dispatchEvent(new win.Event('change'))
say(sP, PL, { key: 'ship', state: 'done' }, at(0.5))
F6.delta()
check('6b view: a delta ticks an item in place (☐ → ☑) and moves the plan bar', !!inPlanner('#70/Ship')?.querySelector('svg.s-done') && inPlanner('#70/Ship').classList.contains('pdone') && parseFloat(inPlanner('#70').querySelector('.pb.plan > i')?.style.width) === 50, J([inPlanner('#70/Ship')?.outerHTML.slice(0, 300), inPlanner('#70')?.querySelector('.pb')?.outerHTML]))
try {   // a crash counts as one failure
// ================================================================= 6c (v1.64.0): open plans expanded, the finished-plan window + slider, abandoned, home-host tags,
// the Plans filter, rollups that follow the filters, the aligned bar column, gossiped counts, the run boundary, the 6d row hooks
const SXr = p => inS('Sixc', p)
check('6c open by default: an OPEN plan renders expanded (its items show without a click), even with a skipped and an abandoned item', !!SXr('open/a') && !!SXr('open/b') && !!SXr('open/c'))
check('6c finished-plan window: an ended plan stays expanded inside finished_plan_open_min (the board\'s head: 120 min) and collapses after it (not removed)', !!SXr('recent/x') && !!SXr('old') && !SXr('old/z'), J([!!SXr('recent/x'), !!SXr('old'), !!SXr('old/z')]))
check('6c planOpenDefault: open → true; ended inside the window → true; past it → false; a node without plan items → false', X.planOpenDefault({ planNode: true, endedPlan: false, u: {} }, NOW, 120) && X.planOpenDefault({ planNode: true, endedPlan: true, u: { plan_end_at: NOW - 30 * MIN } }, NOW, 120)
  && !X.planOpenDefault({ planNode: true, endedPlan: true, u: { plan_end_at: NOW - 3 * HOUR } }, NOW, 120) && !X.planOpenDefault({ planNode: false, u: {} }, NOW, 120))
const po = doc.getElementById('actPlanOpen'), poV = doc.getElementById('actPlanOpenV'), lsBefore = Object.keys(win.localStorage).sort().join(), PI = m => String(X.planOpenIndex(m))
check('6c slider: "plans open" sits beside "stale after", starting at the bridge\'s finished_plan_open_min', !!po && po.closest('.act-bar') === doc.getElementById('actStale').closest('.act-bar') && po.value === PI(120) && /2h \(bridge default\)/.test(poV.textContent), poV && poV.textContent)
po.value = PI(0); po.dispatchEvent(new win.Event('input'))
check('6c slider: 0 → the recently ended plan collapses at once (live, no message to the bridge)', !SXr('recent/x') && !!SXr('recent') && !!SXr('open/a') && /^0m$/.test(poV.textContent))
po.value = PI(240); po.dispatchEvent(new win.Event('input'))
check('6c slider: 240 → the plan that ended 3 h ago expands again; the slider is NOT kept (not in this browser, not in the view)', !!SXr('old/z') && !!SXr('recent/x') && /4h/.test(poV.textContent) && Object.keys(win.localStorage).sort().join() === lsBefore && !Object.keys(V.viewQ).some(k => /plan_open|slider/.test(k)))
po.value = PI(120); po.dispatchEvent(new win.Event('input'))
tog(SXr('open'))
check('6c open by default: the viewer\'s own click still wins (an open plan collapses on click — step 10: open:<id> {o:0} beats the default)', !SXr('open/a') && !!SXr('open') && X.viewGet(V.view, 'open:' + SXr('open').getAttribute('data-nid'))?.o === 0)
tog(SXr('open'))
const abRow = SXr('open/c')
check('6c abandoned: a greyed row (class abandoned) with its own dashed plan glyph; the plan bar tooltip counts it', abRow.classList.contains('abandoned') && !!abRow.querySelector('svg.s-abandoned rect[stroke-dasharray]') && /s-abandoned/.test(X.planGlyph('abandoned')) && X.planGlyph('abandoned') !== X.planGlyph('skipped')
  && /1 abandoned/.test(tipOf(SXr('open').querySelector('.pb'))) && /color:var\(--faint\)/.test(css.match(/\.ar\.abandoned \.nm[^}]*\}/)?.[0] || ''), SXr('open').querySelector('.pb').getAttribute('title'))
check('6c abandoned: an agent or a plan node set abandoned gets a distinct glyph too (not gone\'s, not done\'s)', /s-abandoned/.test(X.glyphSvg({ state: 'abandoned' }, NOW)) && X.glyphSvg({ state: 'abandoned' }, NOW) !== X.glyphSvg({ state: 'gone', gone: true }, NOW) && /s-abandoned/.test(X.glyphSvg({ state: 'abandoned' }, NOW, 'ctx')))
check('6c home host: top-level host tags compare with the session\'s HOME host (B — where it first appeared), not the headline host (A)', SXr('anode')?.querySelector('.htag')?.textContent === 'HOST-A' && !SXr('bnode')?.querySelector('.htag') && SXr('open')?.querySelector('.htag')?.textContent === 'HOST-A' && !SXr('open/a')?.querySelector('.htag')
  && sessU(u6(), 'Sixc').home === 'HOST-B', J([SXr('anode')?.querySelector('.htag')?.textContent, SXr('bnode')?.querySelector('.htag')?.textContent]))
tog(nmRow('Sixc'))
const hselfSix = rowsT().filter(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Sixc')
check('6c home host: expanded, the home host\'s own line says so (hover)', hselfSix.length === 2 && /HOME host/.test(tipOf(hselfSix.find(r => r.getAttribute('data-host') === 'HOST-B').querySelector('.ln')) || ''), J(hselfSix.map(r => r.outerHTML.slice(0, 200))))
tog(nmRow('Sixc'))
const withBar = rowsT().filter(r => r.querySelector('.pb') && !r.classList.contains('proj'))
const anodeRow = SXr('anode')
check('6c bar column (6b rough edge): the bar sits at the same place on a row WITH a pill as on one without — pills come right after the name', withBar.length > 10 && withBar.every(r => r.children[r.children.length - 3] === r.querySelector('.pb'))
  && pills(anodeRow).includes('blocked') && [...anodeRow.children].indexOf(anodeRow.querySelector('.pills')) < [...anodeRow.children].indexOf(anodeRow.querySelector('.ln')), J(withBar.filter(r => r.children[r.children.length - 3] !== r.querySelector('.pb')).map(r => r.textContent)))
click(SXr('bnode'))
const bHead = PANEL.querySelector('.aph-t')?.textContent || '', bN = nodeU(u6(), 'Sixc', 'bnode').log.total + nodeU(u6(), 'Sixc', 'bnode/ctx').log.total
check('6c counts: a REMOTE node\'s log (6d: the panel header) says "N entries" — its subtree\'s gossiped counts (log.total) summed here; "+" when one understates (partial, pure)', /bnode/.test(bHead) && /HOST-B/.test(bHead) && new RegExp(`${bN} entries`).test(bHead) && X.subtreeLog({ u: { log: { total: 5 } }, kids: [{ u: { log: { total: 2, partial: true } }, kids: [] }] }).n === 7
  && X.subtreeLog({ u: { log: { total: 5 } }, kids: [{ u: { log: { total: 2, partial: true } }, kids: [] }] }).partial === true, bHead)
check('6c / step 10: the remote node\'s log is asked BY ID with ITS host (the gateway forwards it to the owner)', sentOf('activity').at(-1).query.log.id === nodeU(u6(), 'Sixc', 'bnode').node_id && sentOf('activity').at(-1).query.log.host === 'HOST-B')
// the run boundary + pruned + by (the log page's own flags — hand-written pages)
click(inS('Rollup', 'live'))
const rq = sentOf('activity').pop()
recv({ type: 'activity', ref: rq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'act_m2-2', ts: NOW - MIN, path: 'live', rel: '', current: true, text: 'run 2', rendered: 'run 2', state: 'running' }, { id: 'act_m2-1', ts: NOW - 2 * MIN, path: 'live', rel: '', text: 'abandoned by the bridge', rendered: 'abandoned by the bridge', state: 'abandoned', by: 'bridge' }], next_cursor: null, run_start: true, earlier_cursor: 'f2.2026-10-01.900' } } })
const sre = pRows().find(r => /start of this run · show earlier runs/.test(r.textContent))
check('6c run boundary: the log stops at the start of the CURRENT run with a "show earlier runs" control; an entry the bridge wrote says "by bridge"', !!sre && pRows().some(r => r.querySelector('.by')?.textContent === 'by bridge') && !pRows().some(r => /load older/.test(r.textContent)))
click(sre)
const rq2 = sentOf('activity').pop()
check('6c run boundary: "show earlier runs" asks for the next page past the boundary — cursor = earlier_cursor, earlier:true (by id)', rq2.query.log.cursor === 'f2.2026-10-01.900' && rq2.query.log.earlier === true && rq2.query.log.id === nodeU(u6(), 'Rollup', 'live').node_id, J(rq2.query))
recv({ type: 'activity', ref: rq2.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'act_m1-1', ts: NOW - 3 * HOUR, path: 'live', rel: '', text: 'an earlier run', rendered: 'an earlier run', state: 'done' }], next_cursor: null } } })
const sep = pRows().find(r => r.classList.contains('sep')), eo1 = pRows().find(r => /an earlier run/.test(r.textContent))
check('6c run boundary: the earlier run\'s entries follow a "— earlier runs —" separator', !!sep && !!eo1 && pRows().indexOf(sep) > pRows().indexOf(eo1) && pRows().indexOf(sep) < pRows().indexOf(pRows().find(r => /run 2/.test(r.textContent))))
click(SXr('anode'))
const rq3 = sentOf('activity').pop()
recv({ type: 'activity', ref: rq3.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'act_m3-1', ts: NOW - MIN, path: 'anode', rel: '', text: 'x', rendered: 'x', state: 'blocked' }], next_cursor: null, pruned: true } } })
check('6c pruned: a run that began in a deleted day file ends in "earlier history pruned" (not a silent gap)', pRows().some(r => r.classList.contains('pruned') && /earlier history pruned/.test(r.textContent)))
// rollups follow the filters
const rollRow = () => nmRow('Rollup')
const unf = tipOf(rollRow().querySelector('.pb'))
ao.checked = true; ao.dispatchEvent(new win.Event('change'))
const fil = tipOf(rollRow().querySelector('.pb'))
check('6c rollup vs filter: with Active only the session\'s rolled-up bar counts only what is shown (the finished worker\'s 6/6 drops out: 8 of 12 → 2 of 6 files); its line renders against it', unf === '8 of 12 files (66%) — rollup of 2 below it' && fil === '2 of 6 files (33%) — rollup of 1 below it' && rollRow().querySelector('.ln').textContent === 'rolling 2 of 6 files', J([unf, fil]))
check('6c rollKids: the same strategies as the bridge — sum, mean %, then N of M done (#79: three parts; M = every item, skipped + abandoned → skipped)', J(X.rollKids([{ u: { key: 'a' }, fbar: { done: 1, total: 4, unit: 'x' } }, { u: { key: 'b' }, fbar: { done: 1, total: 4, unit: 'x' } }])) === J({ done: 2, skipped: 0, total: 8, unit: 'x', pct: 25, rollup: true, n: 2 })
  && X.rollKids([{ u: { key: 'a' }, fbar: { done: 50, total: 100, unit: '%' } }, { u: { key: 'b' }, fbar: { done: 1, total: 4, unit: 'x' } }]).pct === 37.5
  && (r => r.todos && r.done === 1 && r.total === 3 && r.skipped === 2 && r.abandoned === 1)(X.rollKids([{ u: { key: 'a', plan_item: true, current: { state: 'done' } } }, { u: { key: 'b', plan_item: true, current: { state: 'skipped' } } }, { u: { key: 'c', plan_item: true, current: { state: 'abandoned' } } }])))
check('6c active only (6c plan rule): the ended plans are hidden, the open one (skipped + abandoned items) stays', !SXr('recent') && !SXr('old') && !!SXr('open/b'))
const pf = doc.getElementById('actPlans')
ao.checked = false; ao.dispatchEvent(new win.Event('change'))
pf.checked = true; pf.dispatchEvent(new win.Event('change'))
check('6c Plans filter: beside "active only"; only plan nodes, plan items and what holds them — across all sessions (sessions without plans disappear)', pf.closest('.act-bar') === ao.closest('.act-bar') && !!SXr('open') && !!SXr('open/a') && !!SXr('recent') && !!SXr('old')
  && !SXr('anode') && !SXr('bnode') && !nmRow('Rollup') && !nmRow('Orch') && !!nmRow('Planner') && !!inPlanner('#70/Spec') && !inPlanner('helper'))
check('6c Plans filter: an agent holding an open plan stays (it is a plan node); the agent working UNDER an item does not', !!inPlanner('retired') && !inPlanner('#70/Build/builder') && !!inPlanner('#70/Build/unit'))
ao.checked = true; ao.dispatchEvent(new win.Event('change'))
check('6c Plans + Active only: combined — open plans only (ended ones hidden too)', !!SXr('open') && !SXr('recent') && !SXr('old') && !inPlanner('shipped'))
check('6c / step 10 (Q38): the Plans filter is kept in the per-user view (opt:plans_only), not in this browser', X.viewGet(V.view, 'opt:plans_only') === true && win.localStorage.getItem('aimb.act.plans') === null, J(V.viewQ))
pf.checked = false; pf.dispatchEvent(new win.Event('change')); ao.checked = false; ao.dispatchEvent(new win.Event('change'))
const nr = SXr('anode'), sr = nmRow('Sixc')
check('6d hooks: every node row carries data-kind / data-host (its ORIGIN host) / data-path / data-nid (step 10) / data-session / data-project / data-user, and ACT.rowInfo holds the same', nr.getAttribute('data-kind') === 'node' && nr.getAttribute('data-host') === 'HOST-A' && nr.getAttribute('data-path') === 'anode' && nr.getAttribute('data-session') === 'Sixc' && nr.getAttribute('data-project') === 'SixC' && nr.getAttribute('data-user') === 'robin'
  && nr.getAttribute('data-nkind') === 'agent' && nr.getAttribute('data-nid') === nodeU(u6(), 'Sixc', 'anode').node_id && V.rowInfo[nr.getAttribute('data-k')]?.path === 'anode' && SXr('open/a').getAttribute('data-plan-item') === '1' && SXr('open').getAttribute('data-plan-node') === '1', nr.outerHTML.slice(0, 400))
check('6d hooks: session rows (data-kind session, its hosts + home, its root\'s data-nid), project rows and log entries (data-kind entry + data-id) are tagged too', sr.getAttribute('data-kind') === 'session' && sr.getAttribute('data-home') === 'HOST-B' && sr.getAttribute('data-hosts') === 'HOST-A,HOST-B' && /^[a-z2-7]{16}$/.test(sr.getAttribute('data-nid') || '') && rowOf(/📁 SixC/).getAttribute('data-kind') === 'project'
  && pRows().filter(r => r.getAttribute('data-kind') === 'entry').length > 0 && pRows().filter(r => r.getAttribute('data-kind') === 'entry').every(r => !!r.getAttribute('data-id')))
try {   // a crash counts as one failure
// ================================================================= 6d (v1.65.0) on 2.0: the right-click menu (the REGISTRY's, step 10) + actions BY ID, copies, pin / hide (the
// per-user view), the log panel, keyboard / touch, open ancestors, unfiltered counts, the 0 – 7 day slider, the viewport tag, the dark-mode abandoned glyph
const ids = items => items.filter(i => !i.sep).map(i => i.id)
const AL = TYPES.agent.menu, CL = TYPES.context.menu
check('step 10 menuFor (menuFor2, §5.4 / #92): the unit\'s menu (the bridge\'s registry) labelled by the board\'s types, a separator between groups, then the copies and Pin / Hide; the destructive ones are confirmed ("…")',
  J(ids(X.menuFor({ kind: 'node', menu: ['done', 'skip', 'abandon', 'show_as_plan', 'move', 'rename'], labels: CL, plan_item: true, up: null, down: { after_id: 'b' } }))) === J(['done', 'skip', 'abandon', 'show-as-plan', 'move-down', 'move-to', 'rename', 'copy-path', 'pin', 'hide'])
  && X.menuFor({ kind: 'node', menu: ['done'], labels: CL }).find(i => i.id === 'done').label === 'Mark done' && X.menuFor({ kind: 'node', menu: ['abandon'], labels: CL }).find(i => i.id === 'abandon').confirm === true && X.menuFor({ kind: 'node', menu: ['abandon'], labels: CL, plan_item: true }).find(i => i.id === 'abandon').confirm === false
  && X.menuFor({ kind: 'node', menu: ['abandon_plan'], labels: CL }).find(i => i.id === 'abandon-plan').label === 'Abandon the plan…' && X.menuFor({ kind: 'node', menu: ['move'], labels: CL, up: { before_id: 'a' } }).find(i => i.id === 'move-up').args.before_id === 'a')
check('step 10 menuFor: finish / dismiss come marked for the viewer\'s slider — "finish|quiet" only while the agent is quiet, "dismiss|quiet-tree" only while it (or its whole subtree) is; finish = done / failed, both confirmed',
  J(ids(X.menuFor({ kind: 'node', menu: ['finish|quiet', 'dismiss|quiet-tree'], labels: AL, quiet: true, subtree_quiet: true })).slice(0, 3)) === J(['finish-done', 'finish-failed', 'dismiss']) && !X.menuFor({ kind: 'node', menu: ['finish|quiet', 'dismiss|quiet-tree'], labels: AL, quiet: false, subtree_quiet: true }).some(i => i.act)
  && !X.menuFor({ kind: 'node', menu: ['dismiss|quiet-tree'], labels: AL, quiet: true, subtree_quiet: false }).some(i => i.act) && X.menuFor({ kind: 'node', menu: ['dismiss|quiet-tree'], labels: AL, finished: true, subtree_quiet: true }).some(i => i.id === 'dismiss')
  && X.menuFor({ kind: 'node', menu: ['finish|quiet'], labels: AL, quiet: true }).filter(i => i.act).every(i => i.confirm) && X.menuFor({ kind: 'node', menu: ['finish|quiet'], labels: AL, quiet: true }).find(i => i.id === 'finish-failed').args.state === 'failed')
check('6d menuFor: a log ENTRY → Copy entry id (+ Copy path); a session → Copy session name (+ the command when known); a host line → no Pin / Hide; a project row → nothing', J(ids(X.menuFor({ kind: 'entry', has_path: true }))) === J(['copy-id', 'copy-path'])
  && ids(X.menuFor({ kind: 'session', menu: [], has_cmd: true })).includes('copy-session') && ids(X.menuFor({ kind: 'session', menu: [], has_cmd: true })).includes('copy-cmd') && !ids(X.menuFor({ kind: 'session', menu: [], no_view: true })).includes('pin') && X.menuFor({ kind: 'project' }).length === 0)
check('6d slider: "plans open" spans 0 – 7 days in steps (minutes → hours → days); its value is an index; the bridge clamp (0..10080) matches', X.PLAN_OPEN_STEPS[0] === 0 && X.PLAN_OPEN_STEPS.at(-1) === 10080 && X.PLAN_OPEN_STEPS.includes(120) && X.PLAN_OPEN_STEPS.includes(1440)
  && X.PLAN_OPEN_STEPS.every((v, i, a) => !i || v > a[i - 1]) && X.planOpenValue(X.planOpenIndex(120)) === 120 && X.planOpenValue(999) === 10080 && doc.getElementById('actPlanOpen').max === String(X.PLAN_OPEN_STEPS.length - 1))
const po6 = doc.getElementById('actPlanOpen'); po6.value = po6.max; po6.dispatchEvent(new win.Event('input'))
check('6d slider: at its top the label says 7d (live, not persisted)', /^7d/.test(doc.getElementById('actPlanOpenV').textContent), doc.getElementById('actPlanOpenV').textContent)
po6.value = String(X.planOpenIndex(120)); po6.dispatchEvent(new win.Event('input'))
check('6d page: a viewport meta tag (the narrow layout really applies on a phone)', /width=device-width/.test(doc.querySelector('meta[name="viewport"]')?.getAttribute('content') || ''))
const darkTok = n => (css.match(new RegExp(':root\\[data-theme="dark"\\][^}]*--' + n + ':(#[0-9A-Fa-f]{6})')) || [])[1]
check('6d dark mode: the abandoned glyph has its own token, clearly lighter than the faint grey (#6B7280) in dark mode', !!darkTok('abandon') && darkTok('abandon') !== darkTok('faint') && parseInt(darkTok('abandon').slice(1, 3), 16) > 0xA0 && /\.s-abandoned \{ color:var\(--abandon\); \}/.test(css), J([darkTok('abandon'), darkTok('faint')]))
check('6d layout: the log panel sits beside the tree, below it (full width) under 900px; the phone rules come LAST so their bar / name widths apply (CSS)', /\.act-main \{ display:flex;/.test(css) && /@media \(max-width: 900px\) \{ \.act-main \{ flex-direction:column; align-items:stretch; \}/.test(css) && /@media \(max-width: 720px\) \{[^}]*\}[^}]*\.ar \.pb \{ width:56px; \}/.test(css.slice(css.lastIndexOf('.act-toast'))))
const inD = p => inS('Sixd', p)
const uD = p => nodeU(u6(), 'Sixd', p)
check('6d open ancestors: an open plan under a line-less context expands its ancestors — grp opens, its agent shows, and the agent\'s plan item too, without a click', !!inD('grp') && !!inD('grp/deep') && !!inD('grp/deep/p1') && inD('grp').getAttribute('aria-expanded') === 'true')
check('6d open ancestors: X.nodeOpenDefault — a node holding part of an open plan (t.open) is open by default; one that doesn\'t is not', X.nodeOpenDefault({ open: true, planNode: false, u: {} }, NOW, 120) && !X.nodeOpenDefault({ open: false, planNode: false, u: {} }, NOW, 120))
check('6d rows are FOCUSABLE: every session / node row has tabindex 0 and role treeitem; the tree is role tree', rowsT().filter(r => ['node', 'session'].includes(r.getAttribute('data-kind'))).every(r => r.getAttribute('tabindex') === '0' && r.getAttribute('role') === 'treeitem') && T.getAttribute('role') === 'tree')
const tagT = () => doc.getElementById('acttag').textContent, projCnt = () => rowOf(/📁 SixD/)?.querySelector('.cnt')?.textContent
const t0 = tagT(), c0 = projCnt()
pf.checked = true; pf.dispatchEvent(new win.Event('change'))
const t1 = tagT(), c1 = projCnt()
ao.checked = true; ao.dispatchEvent(new win.Event('change'))
const t2 = tagT()
pf.checked = false; pf.dispatchEvent(new win.Event('change')); ao.checked = false; ao.dispatchEvent(new win.Event('change'))
check('6d counts: the header and the project counts IGNORE the filters (Plans, Active only) — always the real totals', t0 === t1 && t1 === t2 && c0 === c1 && /active agents?/.test(t0) && /4 active agents/.test(c0 || ''), J([t0, t1, t2, c0, c1]))
// ---- the menu, opened by a right-click
const menuEl = () => doc.querySelector('.act-menu')
const menuLabels = () => [...(menuEl()?.querySelectorAll('.mi') || [])].map(b => b.textContent)
const rclick = el => el.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
const pickMenu = label => { const b = [...(menuEl()?.querySelectorAll('.mi') || [])].find(x => x.textContent === label); if (b) click(b); return !!b }
const escD = () => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
rclick(inD('lead'))
check('6d / step 10 menu (right-click): a STALE agent holding an open plan — the registry\'s plan actions (Complete its plan, Abandon its plan…), Mark finished done / failed (quiet by the slider), no Dismiss (part of an open plan); then Move down + Move to…, Rename…, Edit text…, Message the session…; then the copies, Pin, Hide',
  !!menuEl() && J(menuLabels()) === J(['Complete its plan', 'Abandon its plan…', 'Mark finished — done…', 'Mark finished — failed…', 'Move down', 'Move to…', 'Rename…', 'Edit text…', 'Message the session…', 'Copy path', 'Copy its aimb-log command', 'Pin to the top', 'Hide']), J(menuLabels()))
check('6d menu: it is a role=menu of menuitems with the first one focused', menuEl().getAttribute('role') === 'menu' && [...menuEl().querySelectorAll('.mi')].every(b => b.getAttribute('role') === 'menuitem') && doc.activeElement === menuEl().querySelector('.mi'))
pickMenu('Copy its aimb-log command')
check('6d / step 10 copy: "Copy its aimb-log command" = the session\'s command for THIS node on ITS host, by its KEY (an agent: --agent <its chain>), --text "@<text>" — the token FILE path, never a token; the menu closes', V.lastCopy === X.logCmd(LC, 'Sixd', 'SixD', uD('lead')) && / --agent "lead" --text "@<text>"$/.test(V.lastCopy) && /--token-file "C:\/Users\/robin\/\.aimb\/realm token\.txt"/.test(V.lastCopy) && !/token=|--token /.test(V.lastCopy) && !menuEl(), V.lastCopy)
rclick(inD('lead/x')); pickMenu('Copy its aimb-log command')
check('step 10 copy: a CONTEXT (a plan item in the agent\'s scope) is --agent <its scope> --key <its key>', / --agent "lead" --key "x" --text "@<text>"$/.test(V.lastCopy), V.lastCopy)
rclick(inD('grp')); pickMenu('Copy its aimb-log command')
check('step 10 copy: a path-made context in the session\'s scope is --key <its key> alone', / --key "grp" --text "@<text>"$/.test(V.lastCopy) && !/--agent/.test(V.lastCopy), V.lastCopy)
rclick(inD('lead')); pickMenu('Copy path')
check('6d copy: "Copy path" = the node\'s path', V.lastCopy === 'lead')
rclick(inD('rem')); pickMenu('Copy its aimb-log command')
check('6d copy: a REMOTE node\'s command uses ITS host\'s paths (from the board\'s remote_hosts) — no --token-file when that host has none', V.lastCopy === '"/usr/bin/node" "/opt/aimb/tools/aimb-log.mjs" --session "Sixd" --project "SixD" --agent "rem" --text "@<text>"', V.lastCopy)
rclick(nmRow('Sixd')); const sessLabels = menuLabels(); pickMenu('Copy session name')
check('6d menu: the SESSION row of a multi-host session (Sixd: + HOST-C) — no actions on it (an action names ONE host\'s root: they sit on each host\'s line), copies + Pin / Hide; "Copy session name"', V.lastCopy === 'Sixd' && J(sessLabels) === J(['Copy session name', 'Copy its aimb-log command', 'Pin to the top', 'Hide']), J(sessLabels))
rclick(inD('fresh')); const freshL = menuLabels(); escD()
check('6d menu: a FRESH agent offers no finish / dismiss (only the node items, copies, Pin, Hide); Escape closes the menu', !freshL.some(l => /Mark|Abandon|Dismiss/.test(l)) && freshL.includes('Pin to the top') && freshL.includes('Rename…') && !menuEl(), J(freshL))
rclick(inD('done1')); const doneL = menuLabels(); escD()
check('6d menu: a FINISHED agent → Dismiss from the board…, not Mark finished', doneL.includes('Dismiss from the board…') && !doneL.some(l => /Mark finished/.test(l)), J(doneL))
rclick(inD('lead/x')); const itemL = menuLabels(); escD()
rclick(inD('alldone')); const adL = menuLabels(); escD()
rclick(inD('cmpl')); const cmL = menuLabels(); escD()
check('6d menu (rendered rows): a ☐ item → Mark done / Skip / Abandon (the registry\'s item group); a plan ended by its items → no plan action; a plan marked complete → Reopen the plan', J(itemL.slice(0, 3)) === J(['Mark done', 'Skip', 'Abandon']) && !adL.some(l => /Complete|Reopen the plan|Abandon the plan/.test(l)) && cmL.includes('Reopen the plan') && !cmL.includes('Complete the plan'), J([itemL, adL, cmL]))
// ---- an action BY ID: pending → ✓ (the store's own answer), the message the bridge gets, an error code inline
const nAct0 = sentOf('activity_action').length
rclick(inD('lead/x')); pickMenu('Mark done')
const am = sentOf('activity_action').at(-1)
check('6d / step 10 action: "Mark done" sends {type:"activity_action", host (the node\'s ORIGIN), session, project, user, ID, action, args.stale_min (the slider)} — no path; no confirmation for a tick', sentOf('activity_action').length === nAct0 + 1 && am.host === 'HOST-A' && am.session === 'Sixd' && am.project === 'SixD' && am.user === 'robin' && am.id === uD('lead/x').node_id && !('path' in am) && am.action === 'done' && am.args.stale_min === 15 && !doc.querySelector('.act-dlg'), J(am))
check('6d feedback: the row shows a pending spinner while the bridge works', !!inD('lead/x')?.querySelector('.fb.pending .spin'))
recv({ type: 'activity_action', ref: am.ref, result: sP.action({ session: am.session, project: am.project, user: am.user, id: am.id, action: am.action, args: am.args }, Date.now(), BY) })
check('6d feedback: then ✓ marked done (the owner applied it)', /✓ marked done/.test(inD('lead/x')?.querySelector('.fb.ok')?.textContent || ''), inD('lead/x')?.innerHTML)
rclick(inD('lead/y')); pickMenu('Reopen (to do)')
const am2 = sentOf('activity_action').at(-1)
recv({ type: 'activity_action', ref: am2.ref, result: { ok: false, code: 'not-a-plan-item', host: 'HOST-A', what: 'not a plan item' } })
check('6d feedback: an error shows its CODE inline on the row (the what on hover)', am2.action === 'reopen' && inD('lead/y')?.querySelector('.fb.err')?.textContent === '✗ not-a-plan-item' && inD('lead/y').querySelector('.fb.err').getAttribute('title') === 'not a plan item')
const dlg = () => doc.querySelector('.act-dlg')
rclick(inD('lead')); pickMenu('Abandon its plan…')
check('6d confirm: Abandon its plan asks first (a modal dialog: how many open items, that the agent keeps running, how it is logged) and sends nothing yet', !!dlg() && dlg().querySelector('[role="dialog"]')?.getAttribute('aria-modal') === 'true' && /1 open item/.test(dlg().textContent) && /keeps running/.test(dlg().textContent)
  && /abandoned by robin via dashboard \(HOST-A\)/.test(dlg().textContent) && sentOf('activity_action').length === nAct0 + 2 && doc.activeElement === dlg().querySelector('[data-dlg="cancel"]'), dlg()?.textContent)
click(dlg().querySelector('[data-dlg="cancel"]'))
check('6d confirm: Cancel closes it — nothing sent', !dlg() && sentOf('activity_action').length === nAct0 + 2)
rclick(inD('lead')); pickMenu('Abandon its plan…'); click(dlg().querySelector('[data-dlg="ok"]'))
check('6d confirm: OK sends abandon_plan for the agent (by its id)', !dlg() && sentOf('activity_action').at(-1).action === 'abandon_plan' && sentOf('activity_action').at(-1).id === uD('lead').node_id)
rclick(inD('lead')); pickMenu('Mark finished — failed…')
check('6d confirm: Mark finished asks first ("It is stale"), then sends finish with args.state', !!dlg() && /It is stale/.test(dlg().textContent) && /open plan items it holds stay open/.test(dlg().textContent) && (click(dlg().querySelector('[data-dlg="ok"]')), sentOf('activity_action').at(-1).action === 'finish' && sentOf('activity_action').at(-1).args.state === 'failed'))
rclick(inD('done1')); pickMenu('Dismiss from the board…')
const dtext = dlg()?.textContent || ''
doc.querySelector('.act-dlg').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
check('6d confirm: Dismiss asks first — it leaves the board now, nothing is deleted (the day files keep its history); Escape cancels', /leaves the board now/.test(dtext) && /Nothing is deleted/.test(dtext) && !dlg() && sentOf('activity_action').at(-1).action === 'finish', dtext)
rclick(inD('rem')); pickMenu('Mark finished — done…'); click(dlg().querySelector('[data-dlg="ok"]'))
const am5 = sentOf('activity_action').at(-1)
recv({ type: 'activity_queued', ref: am5.ref, wait_ms: 900, position: 2 })
check('6d action on ANOTHER host\'s node: sent with that host and the node\'s id (the bridge forwards it to the owner); a queued forward shows on the row', am5.host === 'HOST-C' && am5.id === uD('rem').node_id && /queued/.test(inD('rem')?.querySelector('.fb.pending')?.textContent || ''), J(am5))
// ---- keyboard + touch
const fr = inD('fresh'); fr.focus()
fr.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }))
check('6d keyboard: the Menu key on a focused row opens its menu', !!menuEl() && menuLabels().includes('Pin to the top'))
doc.activeElement.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
check('6d keyboard: arrows move through the menu items', doc.activeElement === menuEl().querySelectorAll('.mi')[1])
escD()
check('6d keyboard: Escape closes it and gives the focus back to the row', !menuEl() && doc.activeElement === inD('fresh'))
inD('fresh').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
check('6d keyboard: Shift+F10 opens it too', !!menuEl()); escD()
inD('fresh').focus(); inD('fresh').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
check('6d keyboard: ArrowDown moves the focus to the next row', doc.activeElement !== inD('fresh') && doc.activeElement.getAttribute('tabindex') === '0' && !!doc.activeElement.closest('#acttree'))
inD('fresh').focus(); inD('fresh').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
check('6d keyboard: Enter selects the focused row (its log in the panel, by id)', inD('fresh').classList.contains('sel') && sentOf('activity').at(-1).query.log.id === uD('fresh').node_id)
const ts = new win.Event('touchstart', { bubbles: true }); Object.defineProperty(ts, 'touches', { value: [{ clientX: 30, clientY: 30 }] })
inD('done1').dispatchEvent(ts)
await tick(650)
check('6d touch: a LONG-PRESS opens the row\'s menu', !!menuEl() && menuLabels().includes('Dismiss from the board…'))
click(inD('done1'))
check('6d touch: the click that ends the long-press does not select the row', !inD('done1').classList.contains('sel') && inD('fresh').classList.contains('sel'))
escD()
// ---- the log panel: entries + their menu, the selection across deltas, cleared when the node goes
const fq = sentOf('activity').at(-1)
recv({ type: 'activity', ref: fq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'act_mf2-2', ts: NOW - MIN, node_id: uD('fresh').node_id, path: 'fresh', rel: '', current: true, text: 'fresh work', rendered: 'fresh work', state: 'running' },
  { id: 'act_mf1-1', ts: NOW - 2 * MIN, node_id: uD('fresh').node_id, path: 'fresh', rel: '', text: 'marked done by robin via dashboard (HOST-A)', rendered: 'marked done by robin via dashboard (HOST-A)', state: 'done', by: { kind: 'dashboard', user: 'robin', host: 'HOST-A' }, act: 'done' }], next_cursor: null } } })
const ent = pRows().find(r => r.getAttribute('data-id') === 'act_mf1-1')
check('6d panel (#87: oldest first): entries with time, state dot, relative tag ("here" / "@here"), text — an action\'s entry reads "… by <user> via dashboard (<host>)"', !!ent && /marked done by robin via dashboard \(HOST-A\)/.test(ent.textContent) && pRows().at(-1).getAttribute('data-id') === 'act_mf2-2' && pRows()[0] === ent && ent.getAttribute('role') === 'listitem'
  && ent.querySelector('.ctag').textContent === 'here' && pRows().at(-1).querySelector('.ctag').textContent === '@here')
rclick(ent)
check('6d panel: a log entry\'s menu → Copy entry id / Copy path', J(menuLabels()) === J(['Copy entry id', 'Copy path']) && (pickMenu('Copy entry id'), V.lastCopy === 'act_mf1-1'), J(menuLabels()))
say(sP, SD, { agent: 'fresh', text: '@fresher work' }, at(0.5))
F6.delta()
check('6d / step 10 selection: survives a board delta (the row still highlighted, the panel still open) — it names the node by id', inD('fresh')?.classList.contains('sel') && !doc.getElementById('actmain').classList.contains('nosel') && inD('fresh').querySelector('.ln').textContent === 'fresher work' && V.sel?.nid === uD('fresh').node_id)
say(sP, SD, { agent: 'fresh', text: '@done for now', state: 'done' }, at(0.4))
const dmf = sP.action({ ...SD, id: uD('fresh').node_id, action: 'dismiss', args: {} }, Date.now(), BY)
const dlt = F6.delta()
check('6d selection: cleared when its node leaves the board (dismissed: its unit id is in the delta\'s remove; the panel closes)', dmf.ok && dlt.remove.length > 0 && !V.sel && doc.getElementById('actmain').classList.contains('nosel') && !inD('fresh'), J([dmf.code, dlt.remove]))
const freshNid = dmf.id
say(sP, SD, { agent: 'fresh', label: 'fresh', text: '@back again' }, at(0.3))
F6.delta()
check('step 10 ids through deltas (§3.7): a removed agent reported again under its key comes back as a NEW RUN of the SAME node — the same node id, the same unit id', inD('fresh')?.getAttribute('data-nid') === freshNid && !!U6[nodeU(u6(), 'Sixd', 'fresh').id], J([inD('fresh')?.getAttribute('data-nid'), freshNid]))
click(inD('lead')); click(PANEL.querySelector('[data-pa="close"]'))
check('6d panel: its × clears the selection', !V.sel && doc.getElementById('actmain').classList.contains('nosel') && !inD('lead').classList.contains('sel'))
// ---- PIN / HIDE — step 10: the per-USER view (pin:<id> / hide:<id>), not this browser
const topOrder = () => rowsT().filter(r => r.getAttribute('data-session') === 'Sixd' && r.getAttribute('data-kind') === 'node' && dOf(r) === 2).map(r => r.getAttribute('data-path'))
const before6 = topOrder()
const freshId = uD('fresh').node_id
rclick(inD('fresh')); pickMenu('Pin to the top')
check('6d / step 10 pin: a pinned node sorts to the TOP of its parent, marked 📌, kept in your VIEW (pin:<its node id> = 1, queued for view_set) — not in localStorage', topOrder()[0] === 'fresh' && before6[0] !== 'fresh' && !!inD('fresh').querySelector('.pin') && X.viewGet(V.view, 'pin:' + freshId) === 1 && win.localStorage.getItem('aimb.act.pins') === null, J([before6, topOrder(), V.viewQ]))
rclick(inD('fresh')); const pinL = menuLabels(); pickMenu('Unpin')
check('6d pin: reversible from the menu (Unpin) — back to rank order; a TOMBSTONE in the view (pin:<id> = null)', pinL.includes('Unpin') && J(topOrder()) === J(before6) && V.view.recs['pin:' + freshId]?.v === null)
const done1Id = uD('done1').node_id
rclick(inD('done1')); pickMenu('Hide')
const hidRow = () => rowsT().find(r => /hidden — show/.test(r.textContent) && dOf(r) === 2)
check('6d hide: a hidden node collapses away, with a small "1 hidden — show" control under its parent; kept in your view (hide:<id>)', !inD('done1') && !!hidRow() && /^1 hidden — show$/.test(hidRow().textContent) && X.viewGet(V.view, 'hide:' + done1Id) === 1)
click(hidRow())
check('6d hide: "show" reveals it (greyed, class hid) with a "hide 1 again" control', inD('done1')?.classList.contains('hid') && rowsT().some(r => /hide 1 again/.test(r.textContent)))
rclick(inD('done1')); const hidL = menuLabels(); pickMenu('Unhide')
check('6d hide: reversible from the menu (Unhide)', hidL.includes('Unhide') && !inD('done1').classList.contains('hid') && V.view.recs['hide:' + done1Id]?.v === null && !rowsT().some(r => /hidden — show|hide \d+ again/.test(r.textContent)), J([hidL, inD('done1')?.className, V.view.recs['hide:' + done1Id], rowsT().filter(r => /hidden — show|again/.test(r.textContent)).map(r => r.textContent)]))
check('6d counts: pin / hide never change the header counts', tagT() === t0, J([tagT(), t0]))
} catch (e) { fail++; console.log('FAIL 6d block crashed:', (e && e.stack) || e) }
} catch (e) { fail++; console.log('FAIL 6c block crashed:', (e && e.stack) || e) }
} catch (e) { fail++; console.log('FAIL 6b block crashed:', (e && e.stack) || e) }
try {   // ================================================================= #79 (v1.66.0): THREE-PART bars (done / skipped / total), a done node = 100%, and
// the client rollup == the bridge's (2.0: the same fixture's units — bar2 — against this page's force + ownBar + rollKids)
check('#79 render: {progress} → "1 of 5 done · 1 skipped"; unchanged without skipped; {pct} = the done %; {skipped}; a % bar', X.renderText('{progress}|{pct}|{skipped}', { done: 1, skipped: 1, total: 5, unit: 'done' }, null, NOW) === '1 of 5 done · 1 skipped|20%|1'
  && X.renderText('{progress}|{skipped}', P, null, NOW) === '4,812 of 12,000 tiles|0' && X.renderText('{progress}', { done: 37.5, skipped: 12.5, total: 100, unit: '%' }, null, NOW) === '37.5% · 12.5% skipped')
check('#79 norm3 (pure): a bar without skipped has skipped 0; a 1.65 "N of M" bar (skipped OUT of M, abandoned in M) is widened: 1 of 2 · 1 skipped · 1 abandoned → 1 of 3 · 2 skipped', (q => q.skipped === 0 && q.total === 12000)(X.norm3(P))
  && (q => q.done === 1 && q.total === 3 && q.skipped === 2 && q.items === true)(X.norm3({ done: 1, total: 2, unit: 'done', rollup: true, todos: true, skipped: 1, n: 3, abandoned: 1 }))
  && (q => q.done === 2 && q.skipped === 1 && q.total === 6 && q.items === true && Math.abs(q.pct - 100 / 3) < 1e-9)(X.norm3({ done: 2, skipped: 1, total: 6, unit: 'done', pct: 33.3, rollup: true, todos: true, items: true, n: 6 }))
  && (q => q.total === 5 && q.skipped === 1)(X.norm3({ done: 2, skipped: 1, total: 5, unit: 'done', rollup: true, todos: true, n: 2 })))
check('#79 force: a DONE node shows a FULL bar whatever its own / rolled-up bar says; ABANDONED → its remainder skipped; failed keeps its bar', (q => q.done === 10 && q.skipped === 0 && q.pct === 100 && q.forced === 'done')(X.barOf({ current: { state: 'done' }, bar: { done: 3, total: 10, unit: 'tiles', rollup: true, n: 2 } }))
  && (q => q.done === 1 && q.skipped === 3 && q.forced === 'abandoned')(X.barOf({ current: { state: 'abandoned' }, bar: { done: 1, skipped: 1, total: 4, unit: 'done', todos: true, items: true, n: 4 } }))
  && (q => q.done === 3 && !q.forced)(X.barOf({ current: { state: 'failed' }, progress: { done: 3, total: 10, unit: '' } })))
// the fixture, built by the BRIDGE's own 2.0 library (what a 2.0 gateway sends)
const s79 = createStore2({ host: 'HOST-A' }), B79 = who('Bars79', 'Bars79')
const s79say = (input, m) => say(s79, B79, input, at(m))
s79say({ text: '@bars for #79' }, 20)
s79say({ key: 'rel', label: 'Release', text: '@release {progress}', plan: ['Spec', 'Docs', 'Port', 'Build', 'Ship'].map(l => ({ key: 'r' + l.toLowerCase(), label: l })) }, 19.9)
s79say({ key: 'rspec', state: 'done' }, 19.8); s79say({ key: 'rdocs', state: 'skipped' }, 19.7); s79say({ key: 'rport', state: 'abandoned' }, 19.6); s79say({ key: 'rbuild', text: '@compiling' }, 19.5)
s79say({ key: 'tp', label: 'Test plan', text: '@testing', plan: ['X', 'Y', 'Z'].map(l => ({ key: 't' + l.toLowerCase(), label: l })) }, 19.4); s79say({ key: 'tx', state: 'done' }, 19.3); s79say({ key: 'tp', text: '@tests signed off', state: 'done' }, 19.2)
s79say({ key: 'tiles', label: 'Tiles', text: '@tiling' }, 19.1); s79say({ key: 'ta', label: 'a', under: 'tiles', text: '@a', progress: '3/10 tiles' }, 19); s79say({ key: 'tb', label: 'b', under: 'tiles', text: '@b', progress: '5/10 tiles' }, 18.9); s79say({ key: 'tiles', text: '@tiles done', state: 'done' }, 18.8)
s79say({ agent: 'worker', label: 'worker', text: '@working' }, 18.7); s79say({ agent: 'worker', key: 'sum', label: 'sum' }, 18.6)
s79say({ agent: 'worker', key: 's1', label: 's1', under: 'sum', text: '@s1', progress: '3/10 tiles 1 skipped' }, 18.5); s79say({ agent: 'worker', key: 's2', label: 's2', under: 'sum', text: '@s2', progress: '2/10 tiles' }, 18.4)
s79say({ agent: 'worker', key: 'mixed', label: 'mixed' }, 18.3); s79say({ agent: 'worker', key: 'mp', label: 'p', under: 'mixed', text: '@p', progress: '50%' }, 18.2); s79say({ agent: 'worker', key: 'mq', label: 'q', under: 'mixed', text: '@q', progress: '2/8 files 2 skipped' }, 18.1)
s79say({ key: 'aband', label: 'aband', text: '@maybe later', plan: [{ key: 'aa', label: 'A' }, { key: 'ab', label: 'B' }] }, 18); s79say({ key: 'aa', state: 'done' }, 17.9); s79say({ key: 'aband', text: '@dropped', state: 'abandoned' }, 17.8)
s79say({ key: 'lint', label: 'Lint', text: '@lint', plan: [{ key: 'l1', label: 'L1' }, { key: 'l2', label: 'L2' }] }, 17.7); s79say({ key: 'l1', text: '@broke', state: 'failed' }, 17.6)
s79say({ agent: 'worker', text: 'still working' }, 1)
const U79 = Object.fromEntries(unitsOf(s79).map(u => [u.id, u]))
const tree79 = X.buildTree(U79, {}).find(p => p.key === 'bars79').sessions[0]
const all79 = []; (function walk(l) { l.forEach(t => { all79.push(t); walk(t.kids) }) })(tree79.kids)
const cbar = t => { t.kids.forEach(cbar); t.cb = X.force(t.u, t.u.progress ? X.ownBar(t.u.progress) : X.rollKids(t.kids.map(k => ({ u: k.u, fbar: k.cb })))); return t.cb }
tree79.kids.forEach(cbar)
const same = (a, b) => (!a && !b) || (!!a && !!b && ['done', 'skipped', 'total', 'unit', 'forced', 'todos', 'items', 'abandoned'].every(k => (a[k] ?? null) === (b[k] ?? null)) && Math.abs((a.pct ?? 0) - (b.pct ?? 0)) < 1e-6)
const bOf = u => u.bar ? X.force(u, X.norm3(u.bar)) : null
check('#79 client == bridge (2.0): the dashboard\'s own rollup (force + ownBar + rollKids — used when a filter is on) equals the bridge\'s bar (bar2, the units\' `bar`) for EVERY node of the fixture (plan items in every state, common + mixed units, done / abandoned overrides)',
  all79.length >= 20 && all79.every(t => same(t.cb, bOf(t.u))), J(all79.filter(t => !same(t.cb, bOf(t.u))).map(t => [t.u.path, t.cb, t.u.bar])))
const selfU = tree79.s.self, selfC = X.force(selfU, X.rollKids(tree79.kids.map(k => ({ u: k.u, fbar: k.cb }))))
check('#79 client == bridge: ... and for the session root (mixed units → the mean of the done and skipped fractions)', same(selfC, bOf(selfU)) && selfU.bar.unit === '%' && selfU.bar.skipped > 0, J([selfC, selfU.bar]))
const ft79 = X.buildTree(U79, { plansOnly: true }).find(p => p.key === 'bars79').sessions[0], fall = []; (function walk(l) { l.forEach(t => { fall.push(t); walk(t.kids) }) })(ft79.kids)
const nDesc = (list, id) => { const f = l => l.reduce((n, t) => n + 1 + f(t.kids), 0); const fd = l => { for (const t of l) { if (t.u.id === id) return t; const x = fd(t.kids); if (x) return x } return null }; const t = fd(list); return t ? f(t.kids) : -1 }
const whole = fall.filter(t => nDesc(ft79.kids, t.u.id) === nDesc(tree79.kids, t.u.id))
check('#79 client == bridge (buildTree, Plans filter): every node whose subtree the filter left whole shows the bridge\'s bar — Release 1 of 5 · 2 skipped, the done Test plan full', whole.length >= 8 && whole.every(t => same(t.fbar, bOf(t.u)))
  && (b => b.done === 1 && b.skipped === 2 && b.total === 5 && b.abandoned === 1)(fall.find(t => t.u.path === 'Release').fbar) && (b => b.done === 3 && b.total === 3 && b.forced === 'done')(fall.find(t => t.u.path === 'Test plan').fbar), J(whole.filter(t => !same(t.fbar, bOf(t.u))).map(t => [t.u.path, t.fbar, t.u.bar])))
// #88 (seen live): an OPEN plan whose node also holds FINISHED helper agents (their own plans all done → full bars) and a context with its own bar
// shows its ITEMS (2 of 3) — never a full bar; the helpers keep their own full bars on their rows
const s88 = createStore2({ host: 'HOST-A' }), B88 = who('Bar88', 'Bar88'), s88say = (input, m) => say(s88, B88, input, at(m))
s88say({ key: 'p88', label: 'P88', text: '@building', plan: [{ key: 'q_spec', label: 'Spec' }, { key: 'b1', label: 'Build 1' }, { key: 'b2a', label: 'Build 2a' }] }, 20)
s88say({ key: 'q_spec', state: 'done' }, 19); s88say({ key: 'b1', state: 'done' }, 18); s88say({ key: 'b2a', text: '@in progress' }, 17)
s88say({ agent: 'spec88', label: 'spec88', under: 'p88', plan: ['r1', 'r2', 'r3', 'r4'].map(k => ({ key: k, label: k })) }, 16); for (const k of ['r1', 'r2', 'r3', 'r4']) s88say({ agent: 'spec88', key: k, state: 'done' }, 15.9); s88say({ agent: 'spec88', text: '@spec done', state: 'done' }, 15.5)
s88say({ agent: 'q88', label: 'q88', under: 'p88', plan: [{ key: 'q1', label: 'q1' }, { key: 'q2', label: 'q2' }] }, 15); s88say({ agent: 'q88', key: 'q1', state: 'done' }, 14.9); s88say({ agent: 'q88', key: 'q2', state: 'done' }, 14.8); s88say({ agent: 'q88', text: '@posted', state: 'done' }, 14.7)
s88say({ key: 'notes', label: 'Notes', under: 'p88', text: '@notes', progress: '9/10 done' }, 14)
const U88 = Object.fromEntries(unitsOf(s88).map(u => [u.id, u]))
const p88 = o => X.buildTree(U88, o).find(p => p.key === 'bar88').sessions[0].kids.find(t => t.u.path === 'P88')
const is2of3 = b => !!b && b.done === 2 && b.total === 3 && b.items === true && b.pct < 100 && !b.forced
check('#88 plan bar: an OPEN plan whose node also holds finished helper agents + a context with its own bar shows its ITEMS (2 of 3 done) — the bridge (bar2), no filter, Active only, Plans, both; never a full bar',
  is2of3(p88({}).u.bar) && is2of3(X.barOf(p88({}).u)) && ['activeOnly', 'plansOnly'].every(k => is2of3(p88({ [k]: true }).fbar)) && is2of3(p88({ activeOnly: true, plansOnly: true }).fbar), J([p88({}).u.bar, p88({ plansOnly: true }).fbar, p88({ activeOnly: true }).fbar]))
check('#88 plan bar: ... the helpers keep their own full bars on their rows', (t => ['spec88', 'q88'].every(n => (b => b && b.pct === 100)(X.barOf(t.kids.find(k => k.u.label === n).u))))(p88({})))
// rendered
const F79 = feed('E79', () => unitMap(s79, null, () => 'code'))
F79.full()
const r79 = p => inS('Bars79', p), pb79 = p => r79(p)?.querySelector('.pb'), wI = p => pb79(p)?.querySelector(':scope > i')?.style.width, wS = p => pb79(p)?.querySelector(':scope > b.sk')?.style.width ?? null
check('#79 bar: a plan with done, skipped, abandoned, running and todo items draws THREE parts — done 20% (green, class plan), then a skipped segment 40% (b.sk; skipped + abandoned), then the track',
  pb79('Release')?.classList.contains('plan') && pb79('Release').classList.contains('sk2') && wI('Release') === '20%' && wS('Release') === '40%' && [...pb79('Release').children].map(c => c.tagName).join() === 'I,B', pb79('Release')?.outerHTML)
check('#79 label: the plan line renders "release 1 of 5 done · 2 skipped"; the bar tooltip "1 of 5 done · 2 skipped (20%) · incl. 1 abandoned — its plan: 5 items"', r79('Release').querySelector('.ln').textContent === 'release 1 of 5 done · 2 skipped' && tipOf(pb79('Release')) === '1 of 5 done · 2 skipped (20%) · incl. 1 abandoned — its plan: 5 items', J([r79('Release')?.querySelector('.ln')?.textContent, tipOf(pb79('Release'))]))
check('#79 done = full: the done plan (1 of 3 items done) and the done context whose children roll up 8 of 20 tiles both show a FULL bar (no skipped segment); striped stays the rollup marker',
  wI('Test plan') === '100%' && wS('Test plan') === null && pb79('Test plan').classList.contains('full') && wI('Tiles') === '100%' && pb79('Tiles').classList.contains('roll') && pb79('Tiles').classList.contains('full') && /20 of 20 tiles \(100%\) · done: counts as 100% — rollup of 2 below it/.test(tipOf(pb79('Tiles'))), J([wI('Test plan'), wI('Tiles'), tipOf(pb79('Tiles'))]))
tog(r79('worker'))
check('#79 bar: common unit sums skipped (5 of 20 tiles · 1 skipped: 25% + 5%); mixed units average it (37.5% + 12.5%); an abandoned plan\'s remainder is skipped; a failed item is remaining (no skipped segment)', wI('worker/sum') === '25%' && wS('worker/sum') === '5%' && wI('worker/mixed') === '37.5%' && wS('worker/mixed') === '12.5%'
  && wI('aband') === '50%' && wS('aband') === '50%' && wI('Lint') === '0%' && wS('Lint') === null, J(['worker/sum', 'worker/mixed', 'aband', 'Lint'].map(p => [p, wI(p), wS(p)])))
const tok = (blk, k) => (blk.match(new RegExp(`--${k}:(#[0-9A-Fa-f]{6})`)) || [])[1]
const blocks79 = [css.match(/:root \{[^}]*\}/)?.[0] || '', css.match(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{[^}]*\}/)?.[0] || '', css.match(/:root\[data-theme="dark"\] \{[^}]*\}/)?.[0] || '']
check('#79 CSS: the skipped segment is a hatch of its own tokens (light, dark, dark forced), neutral — never the plan green (--ok) nor the bar blue', /\.ar \.pb > b\.sk \{[^}]*repeating-linear-gradient\([^)]*var\(--bar-skip\)[^)]*var\(--bar-skip-2\)/.test(css)
  && blocks79.every(b => tok(b, 'bar-skip') && tok(b, 'bar-skip-2') && tok(b, 'bar-skip') !== tok(b, 'ok') && tok(b, 'bar-skip') !== tok(b, 'bar')) && tok(blocks79[0], 'bar-skip') !== tok(blocks79[1], 'bar-skip') && tok(blocks79[1], 'bar-skip') === tok(blocks79[2], 'bar-skip'), J(blocks79.map(b => [tok(b, 'bar-skip'), tok(b, 'bar-skip-2'), tok(b, 'ok')])))
check('#79 colours: in progress is CYAN everywhere (the running ring / dot, a context\'s running mark, the in-progress plan item, a running log dot) through ONE token, --act-running; done stays green (--ok); the cyan differs from the green and the bar blue in light and dark',
  /\.s-running \{ color:var\(--act-running\); \}/.test(css) && /\.bg-running \{ background:var\(--act-running\) !important; \}/.test(css) && /\.bg-done \{ background:var\(--ok\) !important; \}/.test(css) && /\.s-done \{ color:var\(--ok\); \}/.test(css)
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
// the Activity tree: session rows + host lines use the session glyph (the bridge's client_kind — dashUnits2's kindOf); agents keep the ring
const s79b = createStore2({ host: 'HOST-B' }), M79 = who('Multi79', 'Bars79')
say(s79, M79, { text: '@from A' }, at(1)); say(s79b, M79, { text: '@from B' }, at(30))
say(s79, B79, { text: '@bars for #79 (quiet)' }, at(25))
const F79b = feed('E79b', () => unitMap(s79, remoteOf('HOST-A', [s79b]), id => (id.session === 'Multi79' ? 'cowork' : 'code')))
F79b.full()
const sRow = nmRow('Bars79'), mRow = nmRow('Multi79')
check('#79 tree: a SESSION row shows the session glyph (a window; client kind code → ">_"; this one is quiet → stale, grey); an AGENT row keeps the ring glyph (a circle)', !!sRow?.querySelector('svg.sg.k-code.s-stale rect') && !sRow.querySelector('svg.sg circle')
  && !!r79('worker')?.querySelector('svg.gl circle') && !r79('worker').querySelector('svg.sg'), J([sRow?.innerHTML.slice(0, 300), r79('worker')?.innerHTML.slice(0, 200)]))
tog(mRow)
const hl79 = rowsT().filter(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Multi79')
check('#79 tree: a multi-host session (cowork) — its row AND each host line use the same session glyph (speech bubble); B\'s quiet line shows stale (grey, no countdown)', !!mRow?.querySelector('svg.sg.k-cowork') && hl79.length === 2 && hl79.every(r => !!r.querySelector('svg.sg.k-cowork'))
  && !!hl79.find(r => r.getAttribute('data-host') === 'HOST-B')?.querySelector('svg.sg.s-stale') && !!hl79.find(r => r.getAttribute('data-host') === 'HOST-A')?.querySelector('svg.sg.s-running rect.ring'), J(hl79.map(r => r.querySelector('svg')?.getAttribute('class'))))
const lgd = doc.getElementById('actlegend')
check('#79 legend: the session glyph in its four variants (code · cowork · page · other) + "green = done only, cyan = in progress" + the skipped hatch', lgd.querySelectorAll('svg.sg').length === 4 && ['k-code', 'k-cowork', 'k-page', 'k-other'].every(k => !!lgd.querySelector(`svg.sg.${k}`))
  && /session: code · cowork · page · other/.test(lgd.textContent) && /green = done only, cyan = in progress/.test(lgd.textContent) && !!lgd.querySelector('.pb b.sk') && /grey hatch = skipped/.test(lgd.textContent))
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
const mEl = () => doc.querySelector('.act-menu'), mLab = () => [...(mEl()?.querySelectorAll('.mi') || [])].map(b => b.textContent)
const rc = el => el.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
const pick = label => { const b = [...(mEl()?.querySelectorAll('.mi') || [])].find(x => x.textContent === label); if (b) click(b); return !!b }
const escK = el => (el || doc).dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
const dlg = () => doc.querySelector('.act-dlg')
const typeIn = (el, v) => { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })) }
const lastAct = () => sentOf('activity_action').at(-1)
/** the OWNER's answer to an action the page sent (the store applies it — exactly what the gateway forwards back) */
const own = (st, m) => { const r = st.action({ session: m.session, project: m.project, user: m.user, id: m.id, action: m.action, args: m.args }, Date.now(), { by: { kind: 'dashboard', user: 'robin', host: st.host } }); recv({ type: 'activity_action', ref: m.ref, result: { ...r, host: st.host } }); return r }

try {   // ================================================================= #82 (v1.69.0) on ids: ORDER by rank, the agent on its item, greyed abandoned subtrees,
  // Move up / down / to… (a picker + a confirm), Abandon… on any context, drag and drop — step 10: by ID (before_id / after_id / to_id), the depth rules,
  // Merge into…, and the CLASH DIALOG (§1.6, Q32: a move / merge / drop onto a same-label sibling)
  const s82 = createStore2({ host: 'HOST-A' }), s82c = createStore2({ host: 'HOST-C' }), P82 = who('Plan82', 'P82'), s82say = (input, m) => say(s82, P82, input, at(m))
  s82say({ text: '@planning' }, 30)
  s82say({ key: 'next', label: 'Next', plan: ['A', 'B', 'C'].map(l => ({ key: l.toLowerCase(), label: l })) }, 29)
  s82say({ key: 'notes', label: 'notes', under: 'next', text: '@some notes' }, 28); s82say({ key: 'nx', label: 'x', under: 'notes', text: '@nx' }, 27.9)
  s82say({ agent: 'helper', label: 'helper', under: 'next', text: '@helping' }, 27)
  s82say({ agent: 'old-agent', label: 'old-agent', under: 'a', text: '@earlier pass', state: 'done' }, 20)
  s82say({ agent: 'builder', label: 'builder', under: 'a', text: '@compiling the docs' }, 1)
  s82say({ key: 'old', label: 'Old', text: '@underway' }, 26); s82say({ key: 'k', label: 'k', under: 'old', text: '@was underway' }, 25.9); s82say({ agent: 'w', label: 'w', under: 'k', text: '@still going' }, 1)
  s82say({ key: 'old', text: '@dropped', state: 'abandoned' }, 2)
  s82say({ key: 'ideas', label: 'Ideas', text: '@ideas' }, 24); s82say({ key: 'inotes', label: 'notes', under: 'ideas', text: '@other notes' }, 23.9); s82say({ key: 'ix', label: 'x', under: 'inotes', text: '@ix' }, 23.8)
  s82say({ key: 'ihelper', label: 'helper', under: 'ideas', text: '@a context named helper' }, 23.7)
  say(s82c, P82, { agent: 'rem82', label: 'rem82', text: '@on C' }, at(1))
  { const u0 = unitsOf(s82), r = s82.action({ ...P82, id: nodeU(u0, 'Plan82', 'Next/B').node_id, action: 'reorder', args: { before_id: nodeU(u0, 'Plan82', 'Next/A').node_id } }, at(19), BY); if (!r.ok) throw new Error('fixture reorder: ' + r.code) }
  s82say({ text: 'still planning' }, 1)
  const REM82 = remoteOf('HOST-A', [s82c]), map82 = () => unitMap(s82, REM82), u82 = () => [...map82().values()].map(x => x.obj), n82 = p => nodeU(u82(), 'Plan82', p)
  const U82 = Object.fromEntries(u82().map(u => [u.id, u]))
  const tr82 = X.buildTree(U82, {})[0].sessions.find(x => x.s.session === 'Plan82'), f82 = p => find(tr82.kids, p)
  const next = f82('Next')
  check('#82 order (2.0 ranks): plan items first (by rank — B moved before A), then the other contexts, then agents — whatever the creation order', J(next.kids.map(t => t.u.label)) === J(['B', 'A', 'C', 'notes', 'helper']), J(next.kids.map(t => t.u.label)))
  const stA = X.moveSteps(f82('Next/A'), next.kids), stB = X.moveSteps(f82('Next/B'), next.kids), stC = X.moveSteps(f82('Next/C'), next.kids)
  check('#82 / step 10 moveSteps: Move up = before the previous of its OWN kind, Move down = after the next — BY ID (before_id / after_id), never a quoted name; none at the ends', J(stA) === J({ up: { before_id: n82('Next/B').node_id }, down: { after_id: n82('Next/C').node_id } }) && stB.up === null && stC.down === null
    && J(X.moveSteps(f82('Next/helper'), next.kids)) === J({ up: null, down: null }), J([stA, stB, stC]))
  const tC = f82('Next/C'), tOld = f82('Old'), tK = f82('Old/k')
  check('#82 canMoveInto: not into itself / below itself, not where it already is, not onto another host; step 10: past depth 32 refused (its reason), past 20 → deep; a same-label sibling there is a CLASH (allowed: the dialog asks)',
    X.canMoveInto(tC, tOld) && !X.canMoveInto(tC, next) && !X.canMoveInto(tOld, tK) && !X.canMoveInto(tC, f82('rem82'))
    && (c => !c.ok && /too deep/.test(c.why) && c.depth === 33)(X.moveCheck(tC, { u: { node_id: 'dddddddddddddddd', depth: 32, host: 'HOST-A', path: 'd' }, kids: [] }))
    && (c => c.ok && c.deep === 22)(X.moveCheck(tC, { u: { node_id: 'dddddddddddddddd', depth: 21, host: 'HOST-A', path: 'd' }, kids: [] })) && (c => c.ok && !c.deep)(X.moveCheck(tC, tOld))
    && (c => c.ok && c.clash?.node_id === n82('Ideas/notes').node_id)(X.moveCheck(f82('Next/notes'), f82('Ideas'))) && X.DEPTH_MAX === 32 && X.DEPTH_WARN === 20)
  const tg = X.moveTargets(tr82.kids, tC, 'Plan82', tr82.s.self)
  check('#82 / step 10 moveTargets (the picker): the session root first (its ROOT\'s id), then every node of its host it may go under, in tree order, by id — never its own parent, a node on another host, or itself', tg[0].id === tr82.s.self.node_id && /Plan82 \(the session root\)/.test(tg[0].label)
    && tg.some(t => t.path === 'Old' && t.id === n82('Old').node_id) && tg.some(t => t.path === 'Next/A') && !tg.some(t => t.path === 'Next' || t.path === 'rem82' || t.path === 'Next/C') && tg.every(t => t.ok), J(tg.map(t => t.path)))
  check('#82 / step 10 dropPlan: on a sibling of its kind → reorder before_id (upper half) / after_id (lower half); on another node → move to_id (with the check: deep / clash); on itself / below itself / another host → nothing',
    J(X.dropPlan(tC, f82('Next/B'), 0.2)) === J({ act: 'reorder', args: { before_id: n82('Next/B').node_id } }) && J(X.dropPlan(tC, f82('Next/B'), 0.8)) === J({ act: 'reorder', args: { after_id: n82('Next/B').node_id } })
    && (d => d.act === 'move' && d.args.to_id === n82('Old').node_id && d.to === 'Old')(X.dropPlan(tC, tOld, 0.5)) && X.dropPlan(tC, tC, 0.5) === null && X.dropPlan(tOld, tK, 0.5) === null && X.dropPlan(tC, f82('rem82'), 0.5) === null
    && (d => d.act === 'move' && d.args.to_id === n82('Next/notes').node_id)(X.dropPlan(tC, f82('Next/notes'), 0.2)) && (d => d.check.clash.node_id === n82('Ideas/helper').node_id)(X.dropPlan(f82('Next/helper'), f82('Ideas'), 0.5)))
  check('step 10 mergeTargets (Merge into…): the contexts of its session on its host — never itself or below it, never an agent', (t => t.some(x => x.path === 'Ideas/notes' && x.id === n82('Ideas/notes').node_id) && t.some(x => x.path === 'Old') && !t.some(x => x.path === 'Next/notes' || x.path === 'Next/notes/x' || x.path === 'Next/helper' || x.path === 'rem82'))(X.mergeTargets(tr82.kids, f82('Next/notes')))
    && !X.mergeTargets(tr82.kids, f82('Next/helper')).length)
  check('#82 workingAgent: the most recently active agent child still running (a finished one only when none is)', X.workingAgent(f82('Next/A')).u.label === 'builder' && X.workingAgent(tC) === null
    && X.workingAgent({ kids: [{ u: { nkind: 'agent', name: 'x', finished_at: 1, last_activity: 5 } }] }).u.name === 'x')
  // ---- rendered
  const I82 = Object.fromEntries(['Next/notes', 'Next/notes/x', 'Ideas/notes', 'Ideas/notes/x', 'Ideas', 'Next/helper'].map(p => [p, n82(p).node_id]))
  const F82 = feed('E82', map82, () => head2({ remote_hosts: [{ host: 'HOST-C', sessions: 1, nodes: 1, linked: true }] }))
  F82.full()
  const in82 = p => inS('Plan82', p)
  const rA = in82('Next/A')
  check('#82 tree: the rows under Next in rank order (B A C, then notes, then helper)', (() => { const rs = rowsT(), idx = p => rs.indexOf(in82(p)); return ['Next/B', 'Next/A', 'Next/C', 'Next/notes', 'Next/helper'].map(idx).every((v, i, a) => v > 0 && (!i || v > a[i - 1])) })())
  check('#82 agent on its item: the plan item A (closed) shows the WORKING agent beside its box — its glyph, its label and its current line', !!rA && rA.getAttribute('aria-expanded') !== 'true' && !!rA.querySelector('.ln .agon svg.gl') && rA.querySelector('.agon .agn')?.textContent === 'builder' && /compiling the docs/.test(rA.querySelector('.agon').textContent)
    && !in82('Next/C').querySelector('.agon'), rA?.innerHTML.slice(0, 600))
  tog(in82('Old')); tog(in82('Old/k'))
  check('#82 greyed: an abandoned context is greyed AND everything under it — the context the cascade abandoned with it, and the agent below that (abd)', /\babandoned\b/.test(in82('Old').className) && /\b(abd|abandoned)\b/.test(in82('Old/k')?.className || '') && /\babd\b/.test(in82('Old/k/w')?.className || '')
    && !/\babd\b/.test(in82('Next/A').className) && /\.ar\.abd \.nm/.test(css), J([in82('Old')?.className, in82('Old/k')?.className, in82('Old/k/w')?.className]))
  check('#82 / step 10 drag: a node row is draggable when its menu has Move (every 2.0 host, another host\'s too); the session root is not', rA.getAttribute('draggable') === 'true' && in82('rem82')?.getAttribute('draggable') === 'true' && nmRow('Plan82').getAttribute('draggable') !== 'true')
  // ---- the menu
  rc(rA)
  check('#82 menu: a plan item in the middle → Move up · Move down · Move to… (after its item actions)', mLab().includes('Move up') && mLab().includes('Move down') && mLab().includes('Move to…') && mLab().indexOf('Move up') > mLab().indexOf('Mark done'), J(mLab()))
  const nA0 = sentOf('activity_action').length
  pick('Move up')
  const mu = lastAct()
  check('#82 / step 10 Move up: sends reorder with args.before_id = the previous plan item\'s id, no confirmation', sentOf('activity_action').length === nA0 + 1 && mu.action === 'reorder' && mu.id === n82('Next/A').node_id && mu.args.before_id === n82('Next/B').node_id && !('before' in mu.args) && mu.host === 'HOST-A' && !dlg(), J(mu))
  rc(in82('Next/B'))
  check('#82 menu: the first plan item has no Move up', !mLab().includes('Move up') && mLab().includes('Move down'), J(mLab()))
  escK()
  rc(in82('Next/notes'))
  check('#82 / step 10 menu: an ordinary context → Abandon… (confirmed: it cascades), Merge into…, Move to…, Rename…', ['Abandon…', 'Merge into…', 'Move to…', 'Rename…'].every(l => mLab().includes(l)), J(mLab()))
  pick('Abandon…')
  check('#82 Abandon…: asks first — the cascade explained, how it is logged — and sends nothing yet', !!dlg() && /every OPEN context or plan item under it/.test(dlg().textContent) && /abandoned with/.test(dlg().textContent) && sentOf('activity_action').length === nA0 + 1)
  click(dlg().querySelector('[data-dlg="ok"]'))
  check('#82 Abandon… confirmed: sends abandon on the context (by id)', lastAct().action === 'abandon' && lastAct().id === n82('Next/notes').node_id)
  rc(in82('Next/C')); pick('Move to…')
  const pk = dlg()?.querySelector('select.act-pick')
  check('#82 Move to…: a PICKER of valid new parents (the session root first; never its own parent) — nothing sent yet', !!pk && pk.options[0].textContent.includes('the session root') && [...pk.options].some(o => /Old$/.test(o.textContent.trim())) && ![...pk.options].some(o => o.textContent.trim() === 'Next') && sentOf('activity_action').length === nA0 + 2, J([...(pk?.options || [])].map(o => o.textContent)))
  pk.value = String([...pk.options].findIndex(o => /^\s*Old$/.test(o.textContent)))
  click(dlg().querySelector('[data-dlg="ok"]'))
  check('#82 Move to… → then a CONFIRM naming both ends; still nothing sent', /Move Next\/C to Old\?/.test(dlg()?.querySelector('h3')?.textContent || '') && /stays a plan item/.test(dlg().textContent) && sentOf('activity_action').length === nA0 + 2, dlg()?.textContent)
  click(dlg().querySelector('[data-dlg="ok"]'))
  const mt = lastAct()
  check('#82 / step 10 Move to… confirmed: sends {action:"move", id, args:{to_id}} for the node\'s host', mt.action === 'move' && mt.id === n82('Next/C').node_id && mt.args.to_id === n82('Old').node_id && !('to' in mt.args) && mt.host === 'HOST-A' && sentOf('activity_action').length === nA0 + 3, J(mt))
  // ---- drag and drop by id
  const drag = (el, type) => { const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientY: 0 }); Object.defineProperty(ev, 'dataTransfer', { value: { setData() { }, effectAllowed: '', dropEffect: '' } }); el.dispatchEvent(ev); return ev }
  drag(in82('Next/C'), 'dragstart')
  const ov = drag(in82('Next/B'), 'dragover')
  check('#82 drag over a sibling: the drop is allowed (preventDefault) and marked (drop-before / -after)', ov.defaultPrevented && /drop-(before|after)/.test(in82('Next/B').className), in82('Next/B').className)
  drag(in82('Next/B'), 'drop')
  const dd = lastAct()
  check('#82 / step 10 drop on a sibling: a reorder relative to it BY ID (before_id / after_id; no confirmation)', dd.action === 'reorder' && dd.id === n82('Next/C').node_id && (dd.args.before_id === n82('Next/B').node_id || dd.args.after_id === n82('Next/B').node_id) && sentOf('activity_action').length === nA0 + 4, J(dd))
  drag(in82('Next/C'), 'dragstart'); drag(in82('Old'), 'dragover'); drag(in82('Old'), 'drop')
  check('#82 drop on another node: asks first (Move … to Old?), then moves', /Move Next\/C to Old\?/.test(dlg()?.querySelector('h3')?.textContent || '') && sentOf('activity_action').length === nA0 + 4)
  click(dlg().querySelector('[data-dlg="ok"]'))
  check('#82 / step 10 drop on another node, confirmed: sends the move with to_id', lastAct().action === 'move' && lastAct().args.to_id === n82('Old').node_id && lastAct().id === n82('Next/C').node_id && sentOf('activity_action').length === nA0 + 5)
  // ---- step 10: MERGE INTO… — a picker of contexts, a confirm, {action:"merge", args:{into_id}}; a child clash → the clash dialog (merge them / a label)
  rc(in82('Next/notes')); pick('Merge into…')
  const mpk = dlg()?.querySelector('select.act-pick')
  check('step 10 Merge into…: a PICKER of the contexts of its session on its host (not itself or below it, no agent) — nothing sent yet', !!mpk && /Merge Next\/notes into…/.test(dlg().querySelector('h3').textContent) && [...mpk.options].some(o => /Ideas\/notes$/.test(o.textContent.trim())) && ![...mpk.options].some(o => /^\s*(Next\/notes|Next\/helper|rem82)/.test(o.textContent)) && sentOf('activity_action').length === nA0 + 5, J([...(mpk?.options || [])].map(o => o.textContent.trim())))
  mpk.value = String([...mpk.options].findIndex(o => /Ideas\/notes$/.test(o.textContent.trim())))
  click(dlg().querySelector('[data-dlg="ok"]'))
  check('step 10 Merge into… → a CONFIRM (its line ends, its children move there, its history shows in that log; Undo with --unmerge)', /Merge Next\/notes into Ideas\/notes\?/.test(dlg()?.querySelector('h3')?.textContent || '') && /children move under/.test(dlg().textContent) && /unmerge/.test(dlg().textContent) && sentOf('activity_action').length === nA0 + 5, dlg()?.textContent)
  click(dlg().querySelector('[data-dlg="ok"]'))
  const mg = lastAct()
  check('step 10 Merge into… confirmed: sends {action:"merge", id, args:{into_id}}', mg.action === 'merge' && mg.id === n82('Next/notes').node_id && mg.args.into_id === n82('Ideas/notes').node_id && sentOf('activity_action').length === nA0 + 6, J(mg))
  const mgr = own(s82, mg)
  const cdl = dlg()
  check('step 10 CLASH (merge): the owner refuses duplicate-label for a child landing next to a same-label one ("x") and lists it — the page opens the CLASH dialog (nothing written)', mgr.code === 'duplicate-label' && !!cdl && /^Merging Next\/notes: a label is taken$/.test(cdl.querySelector('h3').textContent) && cdl.querySelectorAll('.clash').length === 1 && cdl.querySelector('.clash').getAttribute('data-cid') === n82('Next/notes/x').node_id, J([mgr.code, cdl?.querySelector('h3')?.textContent]))
  click(cdl.querySelector('[data-dlg="ok"]'))
  const mg2 = lastAct()
  check('step 10 CLASH (merge) → "Merge them" (the default where a merge is allowed): ONE merge action with args.merges [{id, into_id}]', mg2.action === 'merge' && mg2.args.into_id === n82('Ideas/notes').node_id && J(mg2.args.merges) === J([{ id: n82('Next/notes/x').node_id, into_id: n82('Ideas/notes/x').node_id }]) && !dlg(), J(mg2))
  recv({ type: 'activity_action', ref: mg2.ref, result: { ok: false, code: 'gone-meanwhile', what: 'not applied (test)' } })
  // ---- step 10: Move to… onto a parent holding a SAME-LABEL sibling → the clash dialog: both answers; a nested clash listed
  rc(in82('Next/notes')); pick('Move to…')
  const pk2 = dlg().querySelector('select.act-pick'), ideasOpt = [...pk2.options].find(o => /^\s*Ideas\b/.test(o.textContent))
  check('step 10 Move to…: a target holding a node of the same label is marked in the picker ("same label there")', !!ideasOpt && /same label there/.test(ideasOpt.textContent) && /"notes" is there already: you will be asked/.test(ideasOpt.getAttribute('title')), ideasOpt?.textContent)
  pk2.value = ideasOpt.value; click(dlg().querySelector('[data-dlg="ok"]'))
  check('step 10 ... and its confirm says the clash will be asked about', /"notes" is there already — you will be asked to merge them or pick another label/.test(dlg()?.textContent || ''), dlg()?.textContent)
  click(dlg().querySelector('[data-dlg="ok"]'))
  const mv1 = lastAct(), mvr = own(s82, mv1)
  const cd2 = dlg(), clashes = [...(cd2?.querySelectorAll('.clash') || [])]
  check('step 10 CLASH (move): the owner\'s duplicate-label with its clash list → the dialog — per clash "Merge them" (contexts: allowed) / "Use a different label" pre-filled with the suggestion ("notes (2)"); a NESTED clash ("x", which merging would bring together) listed under it',
    mvr.code === 'duplicate-label' && mv1.args.to_id === n82('Ideas').node_id && /^Moving Next\/notes: a label is taken$/.test(cd2?.querySelector('h3')?.textContent || '') && clashes.length === 2 && !!clashes[0].querySelector('input[value="merge"]:checked')
    && clashes[0].querySelector('input.cll')?.value === 'notes (2)' && !!clashes[0].querySelector('.cln .clash[data-cid="' + n82('Next/notes/x').node_id + '"]') && !clashes[0].querySelector('.cln').hidden, J([mvr.code, mvr.clashes, cd2?.textContent]))
  const lab0 = clashes[0].querySelector('input[value="label"]'); lab0.checked = true; lab0.dispatchEvent(new win.Event('change', { bubbles: true }))
  check('step 10 CLASH: choosing "Use a different label" hides the nested clashes (they only arise from a merge)', clashes[0].querySelector('.cln').hidden === true)
  click(cd2.querySelector('[data-dlg="ok"]'))
  const mv2 = lastAct()
  check('step 10 CLASH → "Use a different label": ONE move action with args.label = the (pre-filled) new label, no merges', mv2.action === 'move' && mv2.id === n82('Next/notes').node_id && mv2.args.to_id === n82('Ideas').node_id && mv2.args.label === 'notes (2)' && !mv2.args.merges && !dlg(), J(mv2))
  recv({ type: 'activity_action', ref: mv2.ref, result: { ok: false, code: 'gone-meanwhile', what: 'not applied (test)' } })
  rc(in82('Next/notes')); pick('Move to…'); { const p3 = dlg().querySelector('select.act-pick'); p3.value = [...p3.options].find(o => /^\s*Ideas\b/.test(o.textContent)).value } click(dlg().querySelector('[data-dlg="ok"]')); click(dlg().querySelector('[data-dlg="ok"]'))
  own(s82, lastAct())
  click(dlg().querySelector('[data-dlg="ok"]'))   // the defaults: merge them (and the nested one)
  const mv3 = lastAct(), mvr3 = own(s82, mv3)
  check('step 10 CLASH → "Merge them" (+ the nested clash merged too): ONE move action with merges [{id, into_id} …] — the owner applies it whole (merged into the one there)', J(mv3.args.merges) === J([{ id: I82['Next/notes'], into_id: I82['Ideas/notes'] }, { id: I82['Next/notes/x'], into_id: I82['Ideas/notes/x'] }]) && mvr3.ok === true && !!mvr3.into_id
    && [...doc.querySelectorAll('.act-toast')].some(t => /^Merged Next\/notes into/.test(t.textContent)), J([mv3.args, mvr3.code, mvr3.what]))
  // a DROP of an AGENT onto a parent holding a same-label node: the dialog offers only the label ("merge them" hidden: an agent is never merged)
  drag(in82('Next/helper'), 'dragstart'); drag(in82('Ideas'), 'dragover'); drag(in82('Ideas'), 'drop')
  check('step 10 drop onto a same-label sibling: the move\'s confirm first (it names the clash)', /Move Next\/helper to Ideas\?/.test(dlg()?.querySelector('h3')?.textContent || '') && /"helper" is there already/.test(dlg().textContent))
  click(dlg().querySelector('[data-dlg="ok"]'))
  const dv = lastAct(), dvr = own(s82, dv), cd3 = dlg()
  check('step 10 CLASH (an AGENT): "Merge them" is HIDDEN — only "Use a different label" (checked, pre-filled "helper (2)"), the dialog says why', dv.args.to_id === n82('Ideas').node_id && dvr.code === 'duplicate-label' && !!cd3 && !cd3.querySelector('input[value="merge"]') && !!cd3.querySelector('input[value="label"]:checked') && cd3.querySelector('input.cll')?.value === 'helper (2)' && /an agent: only a different label/.test(cd3.textContent), J([dvr.code, dvr.clashes, cd3?.textContent]))
  typeIn(cd3.querySelector('input.cll'), 'helper')
  check('step 10 CLASH: the label that is taken can\'t be sent (the button disabled, the reason shown)', cd3.querySelector('[data-dlg="ok"]').disabled && /is the label that is taken/.test(cd3.querySelector('.dlg-why').textContent))
  typeIn(cd3.querySelector('input.cll'), 'helper (2)')
  click(cd3.querySelector('[data-dlg="ok"]'))
  const dv2 = lastAct(), dvr2 = own(s82, dv2)
  check('step 10 CLASH (agent) answered: ONE move with args.label — applied by the owner', dv2.action === 'move' && dv2.args.label === 'helper (2)' && dv2.args.to_id === n82('Ideas').node_id && dvr2.ok === true, J([dv2.args, dvr2.code]))
  F82.delta()
  if (in82('Ideas')?.getAttribute('aria-expanded') === 'false') tog(in82('Ideas'))
  check('step 10 ids through deltas: the moved agent keeps its row (its unit id, data-nid) under its new parent, relabelled; the merged notes left the board', !!in82('Ideas/helper (2)') && in82('Ideas/helper (2)').getAttribute('data-nid') === dv.id && !in82('Next/helper') && !in82('Next/notes'))
  check('#82 legend: says how order, drag and drop, the agent on its item and the greyed subtrees work', /plan items first, then contexts, then agents/.test(doc.getElementById('actlegend').textContent) && /drag a row/.test(doc.getElementById('actlegend').textContent))
} catch (e) { fail++; console.log('FAIL #82 block crashed:', (e && e.stack) || e) }
try {   // ================================================================= #83 / #84 (v1.70.0) on 2.0: EDIT TEXT… and MESSAGE THE SESSION… — the menu items (the
  // registry's), the two dialogs (prefill, the state picker = the unit's edit_states, validation, sending by id), the result ("not delivered"), the ✎ on
  // an edited line, the 💬 / ✎ log entries, the legend
  check('#83 editStates (pure; 2.0 units carry the bridge\'s edit_states): a plan item any state; another context no todo / skipped; an agent / the session no plan states, abandoned only while it holds plan items',
    J(X.editStates({ nkind: 'context', plan_item: true })) === J(['running', 'blocked', 'failed', 'done', 'idle', 'todo', 'skipped', 'abandoned']) && J(X.editStates({ nkind: 'context' })) === J(['running', 'blocked', 'failed', 'done', 'idle', 'abandoned'])
    && J(X.editStates({ nkind: 'agent' })) === J(['running', 'blocked', 'failed', 'done', 'idle']) && J(X.editStates({ nkind: 'agent', holds_plan: true })) === J(['running', 'blocked', 'failed', 'done', 'idle', 'abandoned']))
  const cur = { text: 'Docs', state: 'todo' }
  check('#83 checkEdit: empty → "can\'t be empty"; over 240 characters (code points, one line) → "Too long"; the same text + state → "Nothing changed"; a new text, or the same text with a new state, is fine',
    !X.checkEdit('  ', '', cur).ok && /can't be empty/.test(X.checkEdit('', '', cur).why) && (c => !c.ok && c.n === 241 && /Too long: 241 of 240/.test(c.why))(X.checkEdit('é'.repeat(241), '', cur))
    && X.checkEdit('é'.repeat(240), '', cur).ok && /Nothing changed/.test(X.checkEdit('Docs', '', cur).why) && /Nothing changed/.test(X.checkEdit(' Docs ', 'todo', cur).why) && X.checkEdit('Docs', 'done', cur).ok && X.checkEdit('Docs v2', '', cur).ok
    && X.checkEdit('a\nb', '', null).ok && X.checkEdit('a\nb', '', null).n === 3)
  check('#84 checkMsg: empty → "Write something"; ≤ 2000 characters fine (newlines kept and counted); 2001 → "Too long"', !X.checkMsg(' \n ').ok && /Write something/.test(X.checkMsg('').why) && X.checkMsg('x'.repeat(2000)).ok && (c => !c.ok && /Too long: 2001 of 2000/.test(c.why))(X.checkMsg('x'.repeat(2001))) && X.checkMsg('a\r\nb').n === 3)
  check('#83 dispPath: a 2.0 path reads as is; a 1.7x one loses its quotes (pure)', X.dispPath('Next release/#83 x/w') === 'Next release/#83 x/w' && X.dispPath('@"Next release"/@"#83 x"/w') === '@Next release/@#83 x/w' && X.dispPath('') === '')
  check('#83 editedBy: "edited by robin via dashboard (HOST-A)" for a line with by; "" without', X.editedBy({ text: 'x', by: { user: 'robin', host: 'HOST-A' } }) === 'edited by robin via dashboard (HOST-A)' && X.editedBy({ text: 'x' }) === '' && X.editedBy(null) === '')
  // ---- the board: Edit83 on HOST-A + HOST-B + HOST-C (multi-host), Solo83 (its line edited from the dashboard)
  const s83 = createStore2({ host: 'HOST-A' }), s83b = createStore2({ host: 'HOST-B' }), s83c = createStore2({ host: 'HOST-C' }), E83 = who('Edit83', 'E83'), S83 = who('Solo83', 'E83')
  say(s83, E83, { text: '@running the release' }, at(1)); say(s83b, E83, { agent: 'wB', label: 'wB', text: '@on B' }, at(1)); say(s83c, E83, { agent: 'wC', label: 'wC', text: '@on C' }, at(1))
  say(s83, E83, { key: 'rel', label: 'Rel', plan: [{ key: 'docs', label: 'Docs' }, { key: 'code', label: 'Code' }] }, at(3))
  say(s83, E83, { key: 'docs', text: '@Docs: {progress}', progress: '2/5 pages', state: 'todo' }, at(2)); say(s83, E83, { key: 'code', state: 'running' }, at(2))
  say(s83, S83, { text: '@solo line' }, at(2))
  { const u0 = unitsOf(s83), a1 = s83.action({ ...E83, id: nodeU(u0, 'Edit83', 'Rel/Code').node_id, action: 'edit_text', args: { text: 'Code: merging', state: 'running' } }, at(1), BY)
    const a2 = s83.action({ ...S83, id: sessU(u0, 'Solo83').self.node_id, action: 'edit_text', args: { text: 'solo line, edited' } }, at(1), BY); if (!a1.ok || !a2.ok) throw new Error('fixture edit_text: ' + a1.code + a2.code) }
  const map83 = () => unitMap(s83, remoteOf('HOST-A', [s83b, s83c])), n83 = p => nodeU([...map83().values()].map(x => x.obj), 'Edit83', p)
  const F83 = feed('E83', map83); F83.full()
  const in83 = p => inS('Edit83', p)
  const rCode = in83('Rel/Code'), rDocs = in83('Rel/Docs')
  check('#83 tree: a line edited from the dashboard shows ✎ right after its text, inside the line (the text ellipsises, the ✎ stays) — its tooltip: who, and that the session\'s next report replaces it; an ordinary line has none',
    !!rCode?.querySelector('.ln.ed > .lt + .edby') && rCode.querySelector('.ln.ed > .lt').textContent === 'Code: merging' && rCode.querySelector('.edby').textContent === '✎' && rCode.querySelector('.edby').getAttribute('aria-label') === 'edited by robin via dashboard (HOST-A)' && !!rCode.querySelector('.edby').getAttribute('data-tip')
    && !rDocs?.querySelector('.edby'), rCode?.innerHTML.slice(0, 500))
  check('#83 tree: a SESSION row\'s headline shows ✎ too', !!nmRow('Solo83')?.querySelector('.edby'))
  rc(rDocs)
  check('#83/#84 menu (the registry\'s): a plan item → its item actions, then Edit text… + Message the session… (the node group)', mLab().includes('Edit text…') && mLab().includes('Message the session…') && mLab().indexOf('Edit text…') > mLab().indexOf('Mark done'), J(mLab()))
  escK(); rc(in83('wC')); const labC = mLab(); escK()
  check('#83/#84 menu: a node on any other host offers them too (every host is 2.0 — no version gate)', labC.includes('Edit text…') && labC.includes('Message the session…'), J(labC))
  rc(nmRow('Edit83')); const labM = mLab(); escK()
  check('#83/#84 menu: a multi-host session\'s own row has none (an action names one host\'s line) …', !labM.includes('Edit text…') && !labM.includes('Message the session…'), J(labM))
  if (!rowsT().some(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Edit83')) tog(nmRow('Edit83'))
  const hlOf = h => rowsT().find(r => r.getAttribute('data-kind') === 'host-line' && r.getAttribute('data-session') === 'Edit83' && r.getAttribute('data-host') === h)
  rc(hlOf('HOST-A')); const labHA = mLab(); escK(); rc(hlOf('HOST-C')); const labHC = mLab(); escK()
  check('#83/#84 menu: … each host\'s own line does (that host\'s root)', labHA.includes('Edit text…') && labHA.includes('Message the session…') && labHC.includes('Edit text…'), J([labHA, labHC]))
  rc(nmRow('Solo83'))
  check('#83/#84 menu: a single-host session row → Edit text… + Message the session…', mLab().includes('Edit text…') && mLab().includes('Message the session…'), J(mLab()))
  escK()
  // ---- the EDIT dialog
  const nA0 = sentOf('activity_action').length
  rc(in83('Rel/Docs')); pick('Edit text…')
  const ed = dlg(), tIn = ed?.querySelector('#actEdT'), sIn = ed?.querySelector('#actEdS'), okB = ed?.querySelector('[data-dlg="ok"]')
  check('#83 Edit text…: a dialog prefilled with the RAW line ({progress} stays a placeholder), focused; the state picker = "keep todo" + the node\'s other valid states (the unit\'s edit_states); Save disabled ("Nothing changed"); a counter "16 / 240"',
    !!ed && ed.querySelector('[role="dialog"]')?.getAttribute('aria-modal') === 'true' && tIn?.value === 'Docs: {progress}' && doc.activeElement === tIn
    && J([...sIn.options].map(o => o.value)) === J(['', ...n83('Rel/Docs').edit_states.filter(s => s !== 'todo')]) && sIn.options[0].textContent === 'keep todo'
    && okB.disabled && /Nothing changed/.test(ed.querySelector('.dlg-why').textContent) && ed.querySelector('.dlg-n').textContent === '16 / 240' && /Placeholders such as \{progress\}/.test(ed.textContent) && /edited by robin via dashboard \(HOST-A\)/.test(ed.textContent), ed?.outerHTML.slice(0, 900))
  typeIn(tIn, '')
  const emptyWhy = ed.querySelector('.dlg-why').textContent, emptyDis = okB.disabled
  typeIn(tIn, 'x'.repeat(241))
  const longWhy = ed.querySelector('.dlg-why').textContent, longDis = okB.disabled, overCls = ed.querySelector('.dlg-n').className
  check('#83 validation: empty → disabled "The line can\'t be empty."; 241 characters → disabled "Too long: 241 of 240", the counter red', emptyDis && /can't be empty/.test(emptyWhy) && longDis && /Too long: 241 of 240/.test(longWhy) && /over/.test(overCls) && sentOf('activity_action').length === nA0)
  typeIn(tIn, 'Docs: writing the README {progress}'); sIn.value = 'running'; sIn.dispatchEvent(new win.Event('change', { bubbles: true }))
  check('#83 a valid edit: Save enabled, no reason shown', !okB.disabled && ed.querySelector('.dlg-why').textContent === '')
  click(okB)
  const se = lastAct()
  check('#83 Save: sends {action:"edit_text", id, host, session, project, args:{text, state}} and closes the dialog', sentOf('activity_action').length === nA0 + 1 && se.action === 'edit_text' && se.id === n83('Rel/Docs').node_id && se.host === 'HOST-A' && se.session === 'Edit83' && se.project === 'E83'
    && se.args.text === 'Docs: writing the README {progress}' && se.args.state === 'running' && !dlg(), J(se))
  const ser = own(s83, se)
  check('#83 the result (the owner applied it): ✓ edited on the row', ser.ok && /✓ edited/.test(in83('Rel/Docs')?.querySelector('.fb')?.textContent || ''), J([ser.code, in83('Rel/Docs')?.querySelector('.fb')?.outerHTML]))
  rc(in83('Rel/Code')); pick('Edit text…')
  const t2 = dlg().querySelector('#actEdT')
  typeIn(t2, '  Code: merged and tagged '); t2.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const se2 = lastAct()
  check('#83 Enter in the line sends (no state chosen → none sent: the line keeps its state); the text trimmed', sentOf('activity_action').length === nA0 + 2 && se2.action === 'edit_text' && se2.args.text === 'Code: merged and tagged' && !('state' in se2.args) && !dlg(), J(se2))
  rc(in83('Rel/Code')); pick('Edit text…'); escK(dlg())
  check('#83 Escape closes the dialog and sends nothing', !dlg() && sentOf('activity_action').length === nA0 + 2)
  // ---- the MESSAGE dialog
  rc(in83('wB')); pick('Message the session…')
  const md = dlg(), ta = md?.querySelector('textarea#actMsgT'), sB = md?.querySelector('[data-dlg="ok"]')
  check('#84 Message the session…: a dialog titled "Message Edit83 about wB" with a focused, empty text box; Send disabled ("Write something…"); it says the session treats it as a request and what the public subject shows',
    !!md && /Message Edit83 about wB/.test(md.querySelector('h3').textContent) && !!ta && doc.activeElement === ta && ta.value === '' && sB.disabled && /Write something/.test(md.querySelector('.dlg-why').textContent)
    && /request from you/.test(md.textContent) && /subject \(not encrypted\) names only the path and your first few words/.test(md.textContent) && md.querySelector('.dlg-n').textContent === '0 / 2000', md?.textContent)
  typeIn(ta, 'y'.repeat(2001))
  const mLong = sB.disabled && /Too long: 2001 of 2000/.test(md.querySelector('.dlg-why').textContent)
  typeIn(ta, 'Please also cover the empty-plan case.\nThanks!')
  check('#84 validation: 2001 characters → disabled "Too long"; a real message → Send enabled', mLong && !sB.disabled)
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  check('#84 a plain Enter in the text box is a newline, not a send', !!dlg() && sentOf('activity_action').length === nA0 + 2)
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  const sm = lastAct()
  check('#84 Ctrl+Enter sends {action:"message", host HOST-B (the node\'s owner), id, args:{text} — newlines kept}', sentOf('activity_action').length === nA0 + 3 && sm.action === 'message' && sm.host === 'HOST-B' && sm.id === n83('wB').node_id && sm.args.text === 'Please also cover the empty-plan case.\nThanks!' && !dlg(), J(sm))
  const toasts0 = doc.querySelectorAll('.act-toast').length
  recv({ type: 'activity_action', ref: sm.ref, result: { ok: true, host: 'HOST-B', action: 'message', id: sm.id, path: 'wB', applied: [{ id: sm.id, path: 'wB', state: 'running' }], delivered: true, delivery: 'live' } })
  check('#84 delivered: ✓ sent on the row + a toast "Message sent to Edit83"', /✓ sent/.test(in83('wB')?.querySelector('.fb')?.textContent || '') && [...doc.querySelectorAll('.act-toast')].some(t => t.textContent === 'Message sent to Edit83') && doc.querySelectorAll('.act-toast').length > toasts0)
  rc(nmRow('Solo83')); pick('Message the session…'); typeIn(dlg().querySelector('textarea'), 'are you still there?'); click(dlg().querySelector('[data-dlg="ok"]'))
  const sm2 = lastAct()
  recv({ type: 'activity_action', ref: sm2.ref, result: { ok: true, host: 'HOST-A', action: 'message', id: sm2.id, path: '', applied: [{ id: sm2.id, path: '', state: 'running' }], delivered: false, delivery: 'none', warnings: ['not-delivered'], what: 'not delivered: the session has no inbox (a script-only session) — the message is logged on the node' } })
  const fbS = nmRow('Solo83')?.querySelector('.fb')
  check('#84 NOT delivered (a script-only session): the session row\'s message names its ROOT by id; the row says "⚠ logged · not delivered: the session has no inbox" (amber) and a toast says so', sm2.id === sessU([...map83().values()].map(x => x.obj), 'Solo83').self.node_id && sm2.session === 'Solo83' && !!fbS && /⚠ logged · not delivered: the session has no inbox/.test(fbS.textContent) && fbS.classList.contains('wn')
    && [...doc.querySelectorAll('.act-toast')].some(t => /Not delivered: Solo83 has no inbox/.test(t.textContent)), fbS?.outerHTML)
  rc(in83('wB')); pick('Message the session…'); typeIn(dlg().querySelector('textarea'), 'x'); click(dlg().querySelector('[data-dlg="ok"]'))
  const sm3 = lastAct()
  recv({ type: 'activity_action', ref: sm3.ref, result: { ok: false, code: 'owner-unreachable', host: 'HOST-B', what: 'host HOST-B is not linked' } })
  check('#84 a refusal shows its code on the row (✗ owner-unreachable)', /✗ owner-unreachable/.test(in83('wB')?.querySelector('.fb')?.textContent || ''))
  // ---- the log panel: 💬 on a message entry, ✎ on an edit entry (the plan item's own glyph, not a dot)
  click(in83('Rel/Docs'))
  const lq83 = sentOf('activity').pop(), dnid = n83('Rel/Docs').node_id
  recv({ type: 'activity', ref: lq83.ref, result: { ok: true, log: { host: 'HOST-A', entries: [
    { id: 'act_m83-2', ts: NOW - MIN, node_id: dnid, path: 'Rel/Docs', rel: '', text: 'robin via dashboard: Please also cover the empty-plan case. Thanks!', rendered: 'robin via dashboard: Please also cover the empty-plan case. Thanks!', state: 'todo', act: 'message', has_details: true, by: { kind: 'dashboard', user: 'robin', host: 'HOST-A' } },
    { id: 'act_m83-1', ts: NOW - 2 * MIN, node_id: dnid, path: 'Rel/Docs', rel: '', current: true, text: 'Docs: writing (edited by robin via dashboard (HOST-A))', rendered: 'Docs: writing (edited by robin via dashboard (HOST-A))', state: 'running', act: 'edit_text', by: { kind: 'dashboard', user: 'robin', host: 'HOST-A' } }], next_cursor: null } } })
  const les = [...PANEL.querySelectorAll('.ar.le')]
  check('#84 / #83 log panel: a message entry is marked 💬 (class msg; its details hold the full text), an edit entry ✎', les.length === 2 && /💬/.test(les[1].querySelector('.msgic')?.textContent || '') && les[1].classList.contains('msg') && /✎/.test(les[0].querySelector('.msgic')?.textContent || '') && !les[0].classList.contains('msg'), les.map(e => e.innerHTML.slice(0, 200)).join(' | '))
  check('log panel (Robin, 2026-10-03; step 10: by the entry\'s node_id): an entry about a PLAN ITEM draws the tree\'s own glyph (☐ todo, ■ running …), not a state dot',
    les.length === 2 && les.every(r => !r.querySelector('.dot') && !!r.querySelector('.edg'))
    && (gl => les.some(r => r.querySelector('.edg').innerHTML === gl('todo')) && les.some(r => r.querySelector('.edg').innerHTML === gl('running')))(st => { const sp = doc.createElement('span'); sp.innerHTML = X.planGlyph(st); return sp.innerHTML }), les.map(r => r.querySelector('.edg, .dot')?.outerHTML).join(' | '))
  check('#83 / #84 legend: names Edit text… (✎) and Message session… (💬)', /Edit text…/.test(doc.getElementById('actlegend').textContent) && /Message session…/.test(doc.getElementById('actlegend').textContent) && /✎/.test(doc.getElementById('actlegend').textContent))
  check('#83 / #84 CSS: the form dialog (inputs, the reason in --bad, the counter), the primary Send / Save button and the amber warning use theme tokens', /\.act-dlg \.act-in \{[^}]*var\(--bg\)[^}]*var\(--fg\)/.test(css) && /\.act-btn\.primary \{[^}]*var\(--info\)/.test(css) && /\.ar \.fb\.wn \{[^}]*var\(--warn\)/.test(css) && /\.act-dlg \.dlg-why \{[^}]*var\(--bad\)/.test(css))
} catch (e) { fail++; console.log('FAIL #83/#84 block crashed:', (e && e.stack) || e) }

try {   // ================================================================= #85 (v1.71.0) on 2.0: QUESTIONS — the "?" bubble, the awaiting-answer row, the answer
  // after the question, the "? N" badge, the menu (the registry's: Answer… / Withdraw… / Change answer…), the Answer dialog (step 10: the question, then its
  // options BELOW it as the answers, then free text), withdraw
  const qn = (status, extra = {}) => ({ nkind: 'context', current: { id: 'q', ts: NOW, text: 'Which database should the cache use?', state: status === 'asked' ? 'blocked' : status === 'answered' ? 'done' : 'abandoned', question: { status, choices: ['Postgres', 'SQLite'], free: false, asked_at: NOW - MIN, ...extra } } })
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
  const QL = TYPES.question.menu, labs = m => X.menuFor(m).filter(i => !i.sep).map(i => i.label)
  const mq = X.menuFor({ kind: 'node', nkind: 'context', menu: ['answer', 'withdraw', 'move', 'message'], labels: QL, question: { status: 'asked' } })
  check('#85 / step 10 menu (pure, the registry\'s question menu): an OPEN question → Answer… (its dialog) + Withdraw… (asked first); never Edit text… or Abandon…; Move to… and Message the session… stay',
    labs({ kind: 'node', menu: ['answer', 'withdraw', 'move', 'message'], labels: QL })[0] === 'Answer…' && mq[0].dlg === 'answer' && mq[1].label === 'Withdraw…' && mq[1].confirm === true && !labs({ kind: 'node', menu: ['answer', 'withdraw', 'move', 'message'], labels: QL }).some(l => /Edit text|Abandon/.test(l))
    && labs({ kind: 'node', menu: ['answer', 'withdraw', 'move', 'message'], labels: QL }).includes('Message the session…'), J(labs({ kind: 'node', menu: ['answer', 'withdraw', 'move', 'message'], labels: QL })))
  // ---- the board: Ask85 on HOST-A (agent lead: an open question with choices, an answered one; Rel: a free-text question, a withdrawn one) + HOST-C (a question)
  const s85 = createStore2({ host: 'HOST-A' }), s85c = createStore2({ host: 'HOST-C' }), A85 = who('Ask85', 'A85')
  say(s85, A85, { text: '@asking' }, at(10))
  say(s85, A85, { agent: 'lead', label: 'lead', text: '@deciding' }, at(9))
  say(s85, A85, { agent: 'lead', ask: 'Which database should the cache use?', choices: ['Postgres', 'SQLite'], expires: '1h' }, at(5))
  say(s85, A85, { agent: 'lead', ask: 'Ship on Friday?', choices: ['Yes', 'No'], free: true }, at(5))
  say(s85, A85, { key: 'rel', label: 'Rel', text: '@release' }, at(5)); say(s85, A85, { key: 'rel', ask: 'Which changelog wording?', free: true }, at(4)); say(s85, A85, { key: 'rel', ask: 'Old question', free: true }, at(4))
  say(s85c, A85, { agent: 'wc', label: 'wc', text: '@on C' }, at(2)); say(s85c, A85, { agent: 'wc', ask: 'A question on another host?', free: true }, at(2))
  say(s85, A85, { agent: 'lead', text: 'still deciding' }, at(1))
  const map85 = () => unitMap(s85, remoteOf('HOST-A', [s85c])), u85 = () => [...map85().values()].map(x => x.obj), n85 = (p, h) => nodeU(u85(), 'Ask85', p, h)
  { const r1 = s85.action({ ...A85, id: n85('lead/?2').node_id, action: 'answer', args: { choice: 'Yes', text: 'after the review' } }, at(1), BY), r2 = s85.action({ ...A85, id: n85('Rel/?2').node_id, action: 'withdraw', args: {} }, at(1), BY); if (!r1.ok || !r2.ok) throw new Error('fixture answer / withdraw: ' + r1.code + ' ' + r2.code) }
  const F85 = feed('E85', map85, () => head2({ remote_hosts: [{ host: 'HOST-C', sessions: 1, nodes: 2, linked: true }] })); F85.full()
  const in85 = (p, h) => inS('Ask85', p, h)
  for (const p of ['lead', 'Rel', 'wc']) if (in85(p) && in85(p).getAttribute('aria-expanded') === 'false') tog(in85(p))
  const rq1 = in85('lead/?1'), rq2 = in85('lead/?2'), rq4 = in85('Rel/?2')
  check('#85 tree: an OPEN question — the fuchsia "?" bubble, a tinted "awaiting answer" row (class qopen), the pill "awaiting answer" (not "blocked"), the question as its line, its label ?1 (the bridge\'s)',
    !!rq1 && rq1.classList.contains('qopen') && !!rq1.querySelector('svg.gl.q.s-asked') && /awaiting answer/.test(rq1.querySelector('.pills')?.textContent || '') && !/blocked/.test(rq1.querySelector('.pills')?.textContent || '')
    && rq1.querySelector('.ln')?.textContent === 'Which database should the cache use?' && rq1.querySelector('.nm')?.textContent === '?1' && n85('lead/?1').type === 'question', rq1?.innerHTML.slice(0, 700))
  check('#85 tree: an ANSWERED question shows its answer after the question ("→ Yes — after the review", green), a ticked bubble, no pill; a withdrawn one a dashed bubble + "withdrawn"',
    !!rq2 && !rq2.classList.contains('qopen') && !!rq2.querySelector('svg.s-answered') && rq2.querySelector('.qa')?.textContent === '→ Yes — after the review' && !rq2.querySelector('.pill')
    && !!rq4 && !!rq4.querySelector('svg.s-withdrawn') && /withdrawn/.test(rq4.querySelector('.pills')?.textContent || ''), rq2?.innerHTML.slice(0, 600))
  check('#85 tree: the question\'s tooltip names its choices and when it expires', (() => { const t = tipOf(rq1.querySelector('.ln[data-tip]')) || ''; return /choices: Postgres · SQLite/.test(t) && /expires/.test(t) && /click \(or right-click → Answer…\)/.test(t) })())
  tog(in85('lead'))
  const rl = in85('lead')
  check('#85 badge: a COLLAPSED ancestor of an open question shows "? 1" (the answered one does not count); expanded it shows none', rl?.getAttribute('aria-expanded') === 'false' && rl.querySelector('.qbadge')?.textContent === '? 1' && !in85('Rel')?.querySelector('.qbadge'), rl?.innerHTML.slice(0, 400))
  check('#85 badge: the SESSION header counts every open question in it ("? 3", the other host\'s too), the PROJECT header too, and the section tag "? N open questions"',
    nmRow('Ask85')?.querySelector('.qbadge')?.textContent === '? 3' && /\? 3/.test(rowsT().find(r => r.classList.contains('proj') && /A85/i.test(r.textContent))?.querySelector('.qbadge')?.textContent || '') && /\? \d+ open questions?/.test(doc.getElementById('acttag').textContent), doc.getElementById('acttag').textContent)
  const ord = rowsT().map(r => r.getAttribute('data-path')).filter(Boolean)
  check('#85 rows keep their order (a question is a context: by rank — nothing jumps to the top)', ord.indexOf('Rel/?1') < ord.indexOf('Rel/?2'), J(ord))
  tog(in85('lead'))
  rc(in85('lead/?1')); const l1 = mLab(); escK()
  rc(in85('wc/?1')); const l5 = mLab(); escK()
  rc(in85('lead/?2')); const l2 = mLab(); escK()
  check('#85 / step 10 menu: an open question → Answer… + Withdraw… (no Edit text…, no Abandon…) — on another host too (every host is 2.0); an answered one → Change answer…, not Answer…',
    l1[0] === 'Answer…' && l1[1] === 'Withdraw…' && !l1.includes('Edit text…') && !l1.includes('Abandon…') && l5[0] === 'Answer…' && !l2.includes('Answer…') && l2[0] === 'Change answer…', J([l1, l5, l2]))
  // the ANSWER dialog — from the menu
  const nA = sentOf('activity_action').length
  rc(in85('lead/?1')); pick('Answer…')
  const ad = dlg(), okA = ad?.querySelector('[data-dlg="ok"]'), cbs = [...(ad?.querySelectorAll('[data-qc]') || [])]
  check('#85 Answer…: a dialog with the question, its CHOICES as radio rows (none picked), no text box (choices only); Answer disabled ("Pick a choice."); it says the subject carries only the path + first words',
    !!ad && /A question from Ask85 — lead\/\?1/.test(ad.querySelector('h3').textContent) && ad.querySelector('.qtext')?.textContent === 'Which database should the cache use?' && cbs.length === 2 && cbs.every(b => b.getAttribute('aria-checked') === 'false' && b.getAttribute('role') === 'radio')
    && !!ad.querySelector('[role="radiogroup"]') && !ad.querySelector('textarea') && okA.disabled && /Pick a choice/.test(ad.querySelector('.dlg-why').textContent) && /first words/.test(ad.textContent) && /expires/.test(ad.textContent), ad?.outerHTML.slice(0, 800))
  const qtx = ad.querySelector('.qtext'), qop = ad.querySelector('.qopts')
  check('step 10 (§5.4 / §5.8) the Answer dialog\'s LAYOUT: the question text ONCE on its own, then its options listed BELOW it as the answers (.qopt rows, one per choice) — the question is never restated with its options',
    (qtx.compareDocumentPosition(qop) & win.Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && J(cbs.map(b => b.textContent)) === J(['Postgres', 'SQLite']) && cbs.every(b => b.classList.contains('qopt')) && !/Postgres|SQLite/.test(qtx.textContent)
    && ad.textContent.split('Which database should the cache use?').length === 2 && ad.querySelectorAll('.qtext').length === 1)
  click(cbs[1])
  check('#85 picking a choice: it is checked (aria-checked), the others not; Answer enabled', cbs[1].getAttribute('aria-checked') === 'true' && cbs[0].getAttribute('aria-checked') === 'false' && !okA.disabled)
  click(cbs[1])
  const unp = cbs[1].getAttribute('aria-checked') === 'false' && okA.disabled
  click(cbs[0]); click(okA)
  const sa = lastAct()
  check('#85 clicking it again un-picks it; Answer sends {action:"answer", host HOST-A, session, id, args:{choice:"Postgres"}} (no text) and closes', unp && sentOf('activity_action').length === nA + 1 && sa.action === 'answer' && sa.host === 'HOST-A' && sa.session === 'Ask85' && sa.id === n85('lead/?1').node_id && sa.args.choice === 'Postgres' && !('text' in sa.args) && !dlg(), J(sa))
  const sar = s85.action({ ...A85, id: sa.id, action: 'answer', args: sa.args }, Date.now(), BY)   // the owner applies it (the delta below shows it); the gateway adds who heard it
  recv({ type: 'activity_action', ref: sa.ref, result: { ...sar, host: 'HOST-A', delivered: true, delivery: 'live', released: 1 } })
  check('#85 the result: ✓ answered on the row + a toast "Answer sent — a waiting script got it and Ask85 was told"', sar.ok && /✓ answered/.test(in85('lead/?1')?.querySelector('.fb')?.textContent || '') && [...doc.querySelectorAll('.act-toast')].some(t => t.textContent === 'Answer sent — a waiting script got it and Ask85 was told'), [...doc.querySelectorAll('.act-toast')].map(t => t.textContent).join(' | '))
  click(in85('Rel/?1'))
  const fd = dlg(), fta = fd?.querySelector('textarea#actAnsT'), okF = fd?.querySelector('[data-dlg="ok"]')
  check('#85 a click on an OPEN question opens Answer… (a free-text one: a focused text box, no choice rows; "Write an answer.")', !!fd && !!fta && !fd.querySelector('[data-qc]') && doc.activeElement === fta && okF.disabled && /Write an answer/.test(fd.querySelector('.dlg-why').textContent) && fd.querySelector('.dlg-n').textContent === '0 / 1000', fd?.outerHTML.slice(0, 500))
  typeIn(fta, 'x'.repeat(1001))
  const tooLong = okF.disabled && /Too long: 1001 of 1000/.test(fd.querySelector('.dlg-why').textContent)
  typeIn(fta, 'Use "Fixed" and "Added".\nKeep it short.')
  fta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  const sf = lastAct()
  check('#85 free text: 1001 characters → disabled; Ctrl+Enter sends {action:"answer", args:{text} — newlines kept, no choice}', tooLong && sf.action === 'answer' && sf.id === n85('Rel/?1').node_id && sf.args.text === 'Use "Fixed" and "Added".\nKeep it short.' && !('choice' in sf.args) && !dlg(), J(sf))
  recv({ type: 'activity_action', ref: sf.ref, result: { ok: true, host: 'HOST-A', action: 'answer', id: sf.id, applied: [], delivered: false, delivery: 'none', released: 0, warnings: ['not-delivered'] } })
  check('#85 an answer nobody received (no inbox, no waiting script): an amber "⚠ answered · nobody was waiting" and a toast saying it is on the board', /⚠ answered · nobody was waiting/.test(in85('Rel/?1')?.querySelector('.fb')?.textContent || '') && [...doc.querySelectorAll('.act-toast')].some(t => /on the board/.test(t.textContent)))
  click(in85('wc/?1'))
  const wd0 = dlg()
  check('#85 / step 10 a click on an open question on ANOTHER host opens Answer… too (and selects it) — every host is 2.0', !!wd0 && /A question from Ask85 — wc\/\?1/.test(wd0.querySelector('h3').textContent) && V.sel && V.sel.path === 'wc/?1' && V.sel.host === 'HOST-C')
  escK(wd0)
  rc(in85('lead/?1')); pick('Withdraw…')
  const wd = dlg()
  check('#85 Withdraw… asks first (Cancel focused), naming the question', !!wd && /Withdraw this question/.test(wd.querySelector('h3').textContent) && /Which database should the cache use\?/.test(wd.textContent) && doc.activeElement === wd.querySelector('[data-dlg="cancel"]'))
  click(wd.querySelector('[data-dlg="ok"]'))
  const sw = lastAct()
  check('#85 confirming sends {action:"withdraw", id}', sw.action === 'withdraw' && sw.id === n85('lead/?1').node_id && sw.host === 'HOST-A', J(sw))
  F85.delta()
  const r1b = in85('lead/?1')
  check('#85 a delta (the owner applied the answer): the answered question turns green (no "awaiting answer"), the session badge drops to "? 2"', !!r1b && !r1b.classList.contains('qopen') && r1b.querySelector('.qa')?.textContent === '→ Postgres' && nmRow('Ask85')?.querySelector('.qbadge')?.textContent === '? 2', r1b?.innerHTML.slice(0, 300))
  check('#85 CSS: the question colours are theme tokens (--ask, --ask-bg) defined for light AND dark', /--ask:#[0-9A-F]{6}; --ask-bg:#[0-9A-F]{6}/.test(css) && (css.match(/--ask:#/g) || []).length === 3 && /\.qbadge \{[^}]*var\(--ask\)/.test(css) && /\.ar\.qopen \{[^}]*var\(--ask-bg\)/.test(css))
} catch (e) { fail++; console.log('FAIL #85 block crashed:', (e && e.stack) || e) }
/** a view as the welcome carries it — built by the bridge's own view set (lib/view-state.js set → forUser, the gateway's viewWire) */
const viewOf = (recs, at0 = Date.now()) => { const vs = createViewSet({ origin: 'HOST-A' }); if (recs.length) vs.set('robin', recs, at0); return { user: 'robin', recs: vs.forUser('robin').map(r => ({ k: r.k, v: r.v, ts: r.ts, origin: r.origin })) } }
try {   // ================================================================= #86 (v1.72.0): the DETAILS section (a node's line, facts, details + data fetched on
  // demand by its entry id), the JSON tree + Copy, the ¶ {} markers, ESCAPING; #87: the log ORDER — oldest first, following the newest end, the "N new ↓"
  // chip, load older keeping the reader's place, the newest-first toggle (step 10: the view's opt:log_order) with storage that throws
  const ents = ['a', 'b', 'c', 'd'].map(id => ({ id }))
  const ord = rows => rows.map(r => r.sep ? '|' : r.e.id).join('')
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
  check('#86 nodeFacts: an agent — kind, state, THREE-PART progress, ETA, who (session · project · user on its host), when its line was set and by whom, when (started · last activity), the log count',
    fa.Kind === 'agent' && fa.State === 'running' && fa.Progress === '3 of 8 files · 1 skipped (37%) — reported' && /^ETA ~30m/.test(fa.ETA) && fa.Who === 'Det86 · D86 · robin on HOST-A' && !('Path' in fa)
    && /edited by robin via dashboard \(HOST-A\)/.test(fa['Line set']) && /^started .*\d\d:\d\d:\d\d · last activity .*\d\d:\d\d:\d\d$/.test(fa.When) && fa.Log === '12+ entries (this node and below)', J(fa))
  check('step 10 nodeFacts (2.0): its KEY in the written form <creator chain>:<key> (transient said), its TYPE (a group / test-run …), its TIME, a group\'s count, a test-run\'s tests',
    (f => f.Key === 'lead:docs (transient: it goes when emptied)' && f.Kind === 'group' && f.Time === 'took 4m 12s' && f.Count === '2 items')(factsOf({ nkind: 'context', type: 'group', key: 'docs', scope: 'lead', transient: true, took: { text: 'took 4m 12s' } }, { gcount: { text: '2 items' } }))
    && (f => f.Key === ':notes' && f.Tests === '2 passed · 1 failed of 3')(factsOf({ nkind: 'context', type: 'test-run', key: 'notes', tests: { tooltip: '2 passed · 1 failed of 3' } }, {})))
  const fq = factsOf({ nkind: 'context', path: 'w/?1', host: 'HOST-A', created_at: NOW - 5 * MIN, current: { id: 'q', ts: NOW - MIN, text: 'Ship?', state: 'done', question: { status: 'answered', choices: ['Yes', 'No'], free: true, asked_at: NOW - 5 * MIN, answer: { choice: 'Yes', text: 'after review' }, by: { user: 'robin', host: 'HOST-A' }, at: NOW - MIN } } }, {})
  const fq2 = factsOf({ nkind: 'context', path: 'w/?2', host: 'HOST-A', current: { id: 'q2', ts: NOW, text: 'Which?', state: 'blocked', question: { status: 'asked', choices: [], free: true, asked_at: NOW - MIN, expires_at: NOW + 60 * MIN } } }, {})
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
  // ---- the board: Det86 (HOST-A + HOST-B): worker (a line with details + data), plain (none), remote (on B, data only); the root's line has details
  const s86 = createStore2({ host: 'HOST-A' }), s86b = createStore2({ host: 'HOST-B' }), D86 = who('Det86', 'D86')
  say(s86, D86, { text: '@detailing', details: 'the root\'s details' }, at(3))
  say(s86, D86, { agent: 'worker', label: 'worker', text: '@crunching {progress}', details: 'first details', data: { first: true }, progress: '3/8 files 1 skipped', eta: '31m' }, at(1))
  say(s86, D86, { agent: 'plain', label: 'plain', text: '@nothing extra' }, at(1))
  say(s86b, D86, { agent: 'remote', label: 'remote', text: '@over there', data: { x: 1 } }, at(1))
  const map86 = () => unitMap(s86, remoteOf('HOST-A', [s86b])), u86 = () => [...map86().values()].map(x => x.obj), n86 = p => nodeU(u86(), 'Det86', p)
  const head86 = () => head2({ remote_hosts: [{ host: 'HOST-B', sessions: 1, nodes: 1, linked: true }] })
  const F86 = feed('E86', map86, head86); F86.full()
  const in86 = (p, host = 'HOST-A') => inS('Det86', p, host)
  const wRow = in86('worker'), pRow = in86('plain'), rRow = in86('remote', 'HOST-B')
  check('#86 markers: a row whose line has details + data shows "¶{}" inside its line (the bar column untouched); data only "{}"; none without; the session row "¶"; hover says to select it',
    wRow?.querySelector('.ln .ddm')?.textContent === '¶{}' && wRow.querySelector('.ln .ddm').getAttribute('aria-label') === 'has details and data' && [...wRow.querySelector('.ln').children].map(c => c.className).join() === 'lt,ddm'
    && wRow.children[wRow.children.length - 3] === wRow.querySelector('.pb') && rRow?.querySelector('.ddm')?.textContent === '{}' && !pRow?.querySelector('.ddm') && nmRow('Det86')?.querySelector('.ddm')?.textContent === '¶'
    && /select it to see them in the panel/.test(tipOf(wRow.querySelector('.ddm'))), wRow?.innerHTML.slice(0, 600))
  const nE0 = sentOf('activity').length
  click(wRow)
  const lq86 = sentOf('activity').at(-1)
  const PD = () => doc.getElementById('actpd')
  const dd = () => PD()?.querySelector('.apd-d'), facts = () => Object.fromEntries([...(PD()?.querySelectorAll('.apd-f dt') || [])].map(dt => [dt.textContent, dt.nextElementSibling?.textContent]))
  check('#86 details section: at the TOP of the panel (above the log list), open, the node\'s rendered line and its facts (three-part progress, ETA, its key, set by its session); "loading its details…" while the fetch is scheduled',
    lq86.query.log?.id === n86('worker').node_id && !!PD() && !PD().hidden && PD().nextElementSibling?.classList.contains('apw') && PD().previousElementSibling?.id === 'actph' && PD().querySelector('.apd-t').getAttribute('aria-expanded') === 'true'
    && PD().querySelector('.apd-l').textContent === 'crunching 3 of 8 files · 1 skipped' && facts().Progress === '3 of 8 files · 1 skipped (37%) — reported' && /^ETA/.test(facts().ETA) && facts().Key === ':worker' && /by its session/.test(facts()['Line set'])
    && PD().querySelector('.apd-m').textContent === '¶{}' && /loading its details/.test(dd()?.textContent || '') && sentOf('activity').length === nE0 + 1, J([facts(), PD()?.textContent.slice(0, 300)]))
  await tick()
  const eq86 = sentOf('activity').at(-1), w86 = n86('worker').current.id
  check('#86 on demand: the details are fetched by the line\'s ENTRY id + the node\'s host (activity {entry:{id, host}}) — nothing about them came with the board', eq86.query.entry?.id === w86 && eq86.query.entry.host === 'HOST-A' && sentOf('activity').length === nE0 + 2 && !('details' in n86('worker').current), J(eq86))
  const evilDetails = '<img src=x onerror="window.__pwned=1">\nline two & <b>three</b>'
  recv({ type: 'activity', ref: eq86.ref, result: { ok: true, entry: { id: w86, details: evilDetails, data: evil } } })
  check('#86 ESCAPING: details holding <img onerror> / <b> and data whose keys and values hold <script> render as TEXT — no such element anywhere in the panel, nothing ran',
    !PANEL.querySelector('img, script, b') && win.__pwned === undefined && dd().querySelector('pre.dtx')?.textContent === evilDetails && dd().querySelector('.jt')?.textContent.includes('<script>window.__pwned=2</script>'), dd()?.innerHTML.slice(0, 500))
  const copies = [...dd().querySelectorAll('.cp')]
  click(copies[1]); const cData = V.lastCopy; click(copies[0])
  check('#86 Copy: the data as pretty JSON, the details as text (one button each)', copies.length === 2 && cData === J(evil, null, 2) && V.lastCopy === evilDetails, J([copies.length, cData?.slice(0, 60)]))
  const aDet = [...dd().querySelectorAll('.jt summary')].find(s => /^a: /.test(s.textContent)).parentElement
  aDet.open = true
  say(s86, D86, { agent: 'plain', text: '@still nothing extra' }, at(0.9)); F86.delta()
  check('#86 the tree is not rebuilt by unrelated deltas or the 1 s re-render: a node the viewer opened stays open (same element)', dd().contains(aDet) && aDet.open)
  say(s86, D86, { agent: 'worker', text: '@crunching more', data: { files: ['a.txt', 'b.txt'] }, progress: '4/8 files 1 skipped' }, at(0.8)); F86.delta()
  await tick()
  const eq86b = sentOf('activity').at(-1)
  check('#86 a new line → its entry is fetched; meanwhile the previous details stay, marked "updating"', eq86b.query.entry?.id === n86('worker').current.id && eq86b.query.entry.id !== w86 && /updating/.test(dd().textContent) && !!dd().querySelector('pre.dtx') && PD().querySelector('.apd-l').textContent === 'crunching more' && PD().querySelector('.apd-m').textContent === '{}', J(eq86b))
  recv({ type: 'activity', ref: eq86b.ref, result: { ok: true, entry: { id: eq86b.query.entry.id, data: { files: ['a.txt', 'b.txt'] } } } })
  check('#86 ... then the new data (a JSON array tree), no details, no "updating"', !/updating/.test(dd().textContent) && !dd().querySelector('pre') && /files: \[ 2 items \]/.test(dd().textContent) && /"a\.txt"/.test(dd().textContent))
  click(PD().querySelector('[data-pa="det"]'))
  check('#86 the section collapses to its header (aria-expanded false; the marker stays visible); step 10: kept as the view\'s fold:details 0 (applied at the next LOAD — Q30)', PD().querySelector('.apd-b').hidden && PD().querySelector('.apd-t').getAttribute('aria-expanded') === 'false' && PD().querySelector('.apd-m').textContent === '{}' && X.viewGet(V.view, 'fold:details') === 0)
  const nClosed = sentOf('activity').length
  say(s86, D86, { agent: 'worker', text: '@crunching still', data: { n: 3 } }, at(0.7)); F86.delta()
  await tick()
  check('#86 ... and a closed section fetches nothing', sentOf('activity').length === nClosed)
  click(PD().querySelector('[data-pa="det"]'))
  await tick()
  check('#86 opened again → it fetches the current line\'s entry', sentOf('activity').at(-1).query.entry?.id === n86('worker').current.id && !PD().querySelector('.apd-b').hidden && X.viewGet(V.view, 'fold:details') === 1)
  click(rRow)
  await tick()
  const eqR = sentOf('activity').at(-1)
  check('#86 a remote node (HOST-B): its entry is asked for WITH its host (the gateway forwards it to the owner over the hub link)', eqR.query.entry?.id === n86('remote').current.id && eqR.query.entry.host === 'HOST-B', J(eqR))
  recv({ type: 'activity', ref: eqR.ref, result: { ok: false, code: 'owner-unreachable', what: 'host HOST-B is not linked' } })
  check('#86 an unreachable owner: "The details are on HOST-B, which can\'t be reached right now" + a Retry button', /The details are on HOST-B, which can't be reached right now/.test(dd().textContent) && !!dd().querySelector('button'), dd()?.textContent)
  click(dd().querySelector('button'))
  check('#86 Retry asks again', sentOf('activity').at(-1).query.entry?.id === n86('remote').current.id)
  recv({ type: 'activity', ref: sentOf('activity').at(-1).ref, result: { ok: false, code: 'unknown-entry', what: 'gone' } })
  check('#86 an entry the owner no longer has says so (a sentence, not a code)', /Not available on HOST-B any more/.test(dd().textContent))
  click(nmRow('Det86'))
  check('#86 a SESSION selected: the section shows its own line on that host ("session — its own line on HOST-A")', /^session — its own line on HOST-A$/.test(facts().Kind || '') && PD().querySelector('.apd-l').textContent === 'detailing' && /^Det86 · D86 · robin on HOST-A$/.test(facts().Who || ''), J(facts()))
  click(pRow)
  check('#86 a node without details or data: the facts, and "Its line has no details or data." (nothing fetched)', /Its line has no details or data/.test(dd().textContent) && !!facts().State)
  const lqP = sentOf('activity').filter(m => m.query.log).at(-1), pnid = n86('plain').node_id
  recv({ type: 'activity', ref: lqP.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'act_mp-2', ts: NOW - MIN, node_id: pnid, path: 'plain', rel: '', text: 'with data', rendered: 'with data', state: 'running', has_details: true, has_data: true }, { id: 'act_mp-1', ts: NOW - 2 * MIN, node_id: pnid, path: 'plain', rel: '', text: 'first', rendered: 'first', state: 'running' }], next_cursor: null } } })
  const le86 = pRows().find(r => r.getAttribute('data-id') === 'act_mp-2')
  check('#86 a log entry with details / data carries the same ¶{} marker', le86?.querySelector('.ddm')?.textContent === '¶{}' && !pRows().find(r => r.getAttribute('data-id') === 'act_mp-1').querySelector('.ddm'))
  click(le86)
  const eqE = sentOf('activity').at(-1)
  recv({ type: 'activity', ref: eqE.ref, result: { ok: true, entry: { id: 'act_mp-2', details: '<img src=y onerror="window.__pwned=3">', data: { '<b>k</b>': [1, 2] } } } })
  const adE = PANEL.querySelector('.apb .ad')
  check('#86 ... expanded: details as text + data as a JSON tree, escaped (no <img> / <b> element), right BELOW its entry (oldest first too)', eqE.query.entry?.id === 'act_mp-2' && !!adE && !adE.querySelector('img, b') && win.__pwned === undefined && adE.querySelector('pre.dtx')?.textContent === '<img src=y onerror="window.__pwned=3">' && /<b>k<\/b>: \[ 2 items \]/.test(adE.textContent) && adE.previousElementSibling === le86, adE?.innerHTML.slice(0, 300))
  // ================= #87: oldest first, following, the chip, load older keeping the place, the toggle (a fake LAYOUT: jsdom has none — 20 px rows, a 100 px list)
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
  const pl = i => ({ id: `p${i}`, ts: NOW - (20 - i) * MIN, node_id: pnid, path: 'plain', rel: '', text: `entry ${i}`, rendered: `entry ${i}`, state: 'running' })
  layout(PB())
  click(in86('remote', 'HOST-B')); click(pRow)
  const lq1 = sentOf('activity').filter(m => m.query.log).at(-1)
  recv({ type: 'activity', ref: lq1.ref, result: { ok: true, log: { host: 'HOST-A', entries: [8, 7, 6, 5, 4, 3, 2, 1].map(pl), next_cursor: 'cur-1', total: 8 } } })
  check('#87 oldest first: "load older…" at the TOP, then the oldest … newest at the bottom; the list opens at the BOTTOM (following)', J(ids()) === J(['more', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) && /load older/.test(PB().children[0].textContent) && PB().scrollTop === 9 * RH - CH && V.follow === true, J([ids(), PB().scrollTop]))
  scrollTo(0)
  check('#87 scrolling up (away from the bottom) pauses following', V.follow === false && chip().hidden)
  for (const L of Object.values(V.logs)) L.at = 0
  say(s86, D86, { agent: 'plain', text: 'logged on (the count moves)' }, at(0.5)); F86.delta()
  const pq = sentOf('activity').filter(m => m.query.log).at(-1)
  check('#87 new entries (the board\'s count moved) → the FIRST page is read again (no cursor) — not the whole log', pq !== lq1 && !pq.query.log.cursor && pq.query.log.id === pnid, J(pq.query))
  recv({ type: 'activity', ref: pq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(pl), next_cursor: 'cur-x', total: 10 } } })
  check('#87 ... MERGED: the 2 new entries go to the bottom, the reader\'s place is kept (scrollTop unchanged), the cursor of the older pages kept, and a "2 new ↓" chip shows',
    J(ids().slice(-3)) === J(['p8', 'p9', 'p10']) && ids().length === 11 && PB().scrollTop === 0 && !chip().hidden && chip().textContent === '2 new ↓' && Object.values(V.logs).some(L => L.next === 'cur-1'), J([ids(), PB().scrollTop, chip().textContent]))
  click(chip())
  check('#87 the chip jumps to the newest and follows again (it hides)', PB().scrollTop === 11 * RH - CH && V.follow === true && chip().hidden && V.newN === 0)
  scrollTo(10)
  click(PB().children[0])
  const oq = sentOf('activity').filter(m => m.query.log).at(-1)
  check('#87 "load older…" (at the top) asks with the cursor', oq.query.log.cursor === 'cur-1' && V.follow === false, J(oq.query))
  recv({ type: 'activity', ref: oq.ref, result: { ok: true, log: { host: 'HOST-A', entries: [0, -1, -2].map(pl), next_cursor: null } } })
  const p1Row = [...PB().children].find(r => r.getAttribute('data-id') === 'p1')
  check('#87 ... the older entries go ABOVE and the view does not jump: p1 stays 10 px down the view (scrollTop moves by what was added)', J(ids().slice(0, 4)) === J(['p-2', 'p-1', 'p0', 'p1']) && p1Row.offsetTop - PB().scrollTop === 10 && V.follow === false, J([ids().slice(0, 5), PB().scrollTop]))
  const ordB = () => PANEL.querySelector('[data-pa="order"]')
  check('#87 the header toggle says the order ("⇅ oldest first"), with a tooltip and an aria-label', /⇅ oldest first/.test(ordB()?.textContent || '') && /chat-style/.test(ordB().getAttribute('title')) && /Switch to newest first/.test(ordB().getAttribute('aria-label')))
  click(ordB())
  check('#87 / step 10 toggled: newest first — the newest on top, the list at the TOP (following), kept in your VIEW (opt:log_order, Q38 — not this browser)', ids()[0] === 'p10' && ids().at(-1) === 'p-2' && PB().scrollTop === 0 && V.follow === true && X.viewGet(V.view, 'opt:log_order') === 'newest' && win.localStorage.getItem('aimb.act.logOrder') === null && /⇅ newest first/.test(ordB().textContent), J(ids()))
  scrollTo(60)
  for (const L of Object.values(V.logs)) L.at = 0
  say(s86, D86, { agent: 'plain', text: 'and on' }, at(0.4)); F86.delta()
  const pq2 = sentOf('activity').filter(m => m.query.log).at(-1)
  recv({ type: 'activity', ref: pq2.ref, result: { ok: true, log: { host: 'HOST-A', entries: [11, 10, 9].map(pl), next_cursor: 'cur-y', total: 11 } } })
  check('#87 newest first, scrolled down: a new entry goes on top WITHOUT moving the view (scrollTop + one row) and the chip says "1 new ↑"', ids()[0] === 'p11' && PB().scrollTop === 80 && chip().textContent === '1 new ↑' && !chip().hidden && chip().classList.contains('top'), J([ids().slice(0, 3), PB().scrollTop, chip().textContent]))
  click(ordB())
  check('#87 toggled back: oldest first again (the view\'s opt:log_order "oldest"), at the bottom', X.viewGet(V.view, 'opt:log_order') === 'oldest' && ids().at(-1) === 'p11' && V.follow === true && PB().scrollTop === PB().scrollHeight - CH)
  const realLS = Object.getOwnPropertyDescriptor(win, 'localStorage')
  Object.defineProperty(win, 'localStorage', { configurable: true, get() { throw new win.DOMException('denied', 'SecurityError') } })
  let threw = null; try { click(ordB()) } catch (e) { threw = e }
  check('#87 with storage that THROWS, the toggle still flips the order', !threw && ids()[0] === 'p11' && V.logOrder === 'newest', String(threw))
  click(ordB())
  if (realLS) Object.defineProperty(win, 'localStorage', realLS); else delete win.localStorage
  if (savedTop) Object.defineProperty(proto, 'offsetTop', savedTop); if (savedH) Object.defineProperty(proto, 'offsetHeight', savedH)
  // fresh pages (a 2.0 gateway: the welcome carries the view): one whose storage throws on every access, one whose VIEW says newest first
  const det86 = u86()
  async function miniPage(before, view) {
    class WS2 { constructor() { this.readyState = 0; this.sent = []; WS2.last = this } send(s) { this.sent.push(JSON.parse(s)) } close() { this.readyState = 3 } }
    const errs = []
    const { VirtualConsole } = await import('jsdom')
    const vc = new VirtualConsole(); vc.on('jsdomError', e => errs.push(String(e && (e.stack || e.message || e))))
    const d2 = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1:12318/dashboard.html?token=t', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) { w.WebSocket = WS2; before(w) } })
    const w2 = d2.window, s2 = WS2.last, rc2 = m => s2.onmessage({ data: J(m) })
    try {
      s2.readyState = 1; s2.onopen && s2.onopen()
      rc2({ type: 'welcome', gateway: 'HOST-A/aaa', sessions: [], pages: [], hosts: {}, bridge_version: '2.0.0', profile: {}, capabilities: {}, view })
      rc2({ type: 'activity_board', full: true, epoch: 'M1', seq: 1, head: head86(), types: TYPES, upsert: det86 })
      const r2 = [...w2.document.querySelectorAll('#acttree .ar')].find(r => r.getAttribute('data-path') === 'plain')
      r2.dispatchEvent(new w2.MouseEvent('click', { bubbles: true }))
      const q2 = s2.sent.filter(m => m.type === 'activity' && m.query.log).at(-1)
      rc2({ type: 'activity', ref: q2.ref, result: { ok: true, log: { host: 'HOST-A', entries: [3, 2, 1].map(pl), next_cursor: null } } })
      const order = [...w2.document.querySelectorAll('#actpb .ar.le')].map(r => r.getAttribute('data-id'))
      return { order, errs, logOrder: w2.AimbActView.logOrder, btn: w2.document.querySelector('[data-pa="order"]')?.textContent }
    } finally { d2.window.close() }
  }
  const mThrow = await miniPage(w => Object.defineProperty(w, 'localStorage', { configurable: true, get() { throw new w.DOMException('denied', 'SecurityError') } }), viewOf([]))
  check('#87 a page whose localStorage THROWS loads, renders the board and the log, oldest first (no script error)', J(mThrow.order) === J(['p1', 'p2', 'p3']) && mThrow.logOrder === 'oldest' && !mThrow.errs.length, J(mThrow))
  const mNew = await miniPage(w => { try { w.localStorage.setItem('aimb.act.logOrder', 'oldest') } catch { } }, viewOf([{ k: 'opt:log_order', v: 'newest' }]))
  check('#87 / step 10 (Q38) a viewer whose VIEW says newest first gets it on the next load — on any browser (the view wins over what this browser kept)', J(mNew.order) === J(['p3', 'p2', 'p1']) && mNew.logOrder === 'newest' && /newest first/.test(mNew.btn || '') && !mNew.errs.length, J(mNew))
  check('#86 / #87 CSS: the panel is a column (header, details ≤ 45vh, the list scrolls by itself); 85vh on a narrow screen; the JSON tree + chip + marker use theme tokens',
    /\.act-panel \{[^}]*display:flex; flex-direction:column;/.test(css) && /\.apd \{[^}]*max-height:45vh; overflow:auto;/.test(css) && /\.act-panel \.apb \{[^}]*overflow:auto;/.test(css) && /@media \(max-width: 900px\) \{[^\n]*\.act-panel \{[^}]*max-height:85vh;/.test(css)
    && /\.jt \{[^}]*var\(--surface\)/.test(css) && /\.jt \.j-str \{ color:var\(--ok\); \}/.test(css) && /\.apnew \{[^}]*var\(--info\)/.test(css) && /\.ddm \{[^}]*var\(--muted\)/.test(css) && !/:has\(/.test(css))
  check('#86 legend: names ¶ / {} and the log order', /¶ = its line has details/.test(doc.getElementById('actlegend').textContent) && /oldest first/.test(doc.getElementById('actlegend').textContent))
} catch (e) { fail++; console.log('FAIL #86/#87 block crashed:', (e && e.stack) || e) }

try {   // ================================================================= #90 (v1.75.0) on 2.0: CHANGE ANSWER… on an answered question (the registry's
  // answered-question entry), the facts show the latest answer + that it was changed, and an OPEN question never goes stale or gone (only its host down greys it)
  const f90 = (u, o) => Object.fromEntries(X.nodeFacts(u, null, { now: NOW, sm: 15, ...o }).map(f => [f.k, f.v]))
  const qa = (extra = {}) => ({ nkind: 'context', host: 'HOST-A', current: { id: 'q', ts: NOW - MIN, text: 'Ship?', state: 'done', question: { status: 'answered', choices: ['Yes', 'No'], free: true, asked_at: NOW - 10 * MIN, answer: { choice: 'No', text: 'wait' }, by: { user: 'robin', host: 'HOST-A' }, at: NOW - MIN, ...extra } } })
  const fr = f90(qa({ revised: 2, previous: { answer: { choice: 'Yes' }, by: { user: 'robin', host: 'HOST-A' }, at: NOW - 5 * MIN } })), f0 = f90(qa())
  check('#90 nodeFacts: a CHANGED answer — Answer = the LATEST one "(changed)", "Answer changed" by whom / when (+ "changed 2 times"), "Previous answer" with who / when; an unchanged one says "Answered" and has no previous',
    fr.Answer === 'No — wait (changed)' && /^by robin via dashboard \(HOST-A\) at .+ · changed 2 times$/.test(fr['Answer changed']) && /^Yes — by robin via dashboard \(HOST-A\) at /.test(fr['Previous answer']) && !('Answered' in fr)
    && f0.Answer === 'No — wait' && /^by robin via dashboard/.test(f0.Answered) && !('Previous answer' in f0) && !('Answer changed' in f0), J([fr, f0]))
  const q0 = qa().current.question
  check('#90 checkChange: the current answer → refused ("That is the current answer"); another choice, or the same choice with another note → ok; an invalid one → checkAnswer\'s reason',
    (c => !c.ok && /current answer/.test(c.why))(X.checkChange('No', 'wait', q0)) && X.checkChange('Yes', 'wait', q0).ok && X.checkChange('No', 'wait longer', q0).ok && X.checkChange(null, 'wait', q0).ok
    && /Pick one of its choices/.test(X.checkChange('Maybe', '', q0).why) && /Too long/.test(X.checkChange('No', 'x'.repeat(1001), q0).why))
  const QL = TYPES.question.menu, mA = X.menuFor({ kind: 'node', nkind: 'context', menu: ['change_answer', 'move', 'message'], labels: QL, question: { status: 'answered' } })
  check('#90 / step 10 menu (pure, the registry\'s): an ANSWERED question → "Change answer…" (the answer dialog, act change_answer) — no Answer… / Withdraw…', mA[0].label === 'Change answer…' && mA[0].act === 'change_answer' && mA[0].dlg === 'answer' && !mA.some(i => i.label === 'Answer…' || /Withdraw/.test(i.label || '')), J(mA))
  check('#90 ACTION_DONE: change_answer → "answer changed"', X.ACTION_DONE.change_answer === 'answer changed')
  const qOpen = (extra = {}) => ({ nkind: 'context', host: 'HOST-A', current: { id: 'o', ts: NOW - 90 * MIN, text: 'Waiting?', state: 'blocked', question: { status: 'asked', choices: [], free: true, asked_at: NOW - 90 * MIN } }, ...extra })
  const stOwner = run(60), goneOwner = { ...run(60), state: 'gone', gone_at: NOW - 30 * MIN }
  const e1 = X.effState(qOpen(), stOwner, NOW, 15), e2 = X.effState(qOpen(), goneOwner, NOW, 15), e3 = X.effState(qOpen({ host_down: true }), goneOwner, NOW, 15), eC = X.effState(cx('blocked'), stOwner, NOW, 15)
  check('#90 an OPEN question never goes stale (its agent quiet 60m) nor gone (its agent left) — an ordinary blocked context under the same agent IS stale; its HOST down → it looks stale (hostDown)',
    e1.state === 'blocked' && !e1.stale && !e1.gone && e2.state === 'blocked' && !e2.gone && !e2.stale && e3.stale && e3.hostDown && e3.state === 'stale' && eC.stale === true, J([e1, e2, e3, eC]))
  check('#90 an ANSWERED question follows the normal rules (a done line: not stale)', (e => e.state === 'done' && !e.stale)(X.effState(qa(), stOwner, NOW, 15)))
  // ---- the board: Rev90 on HOST-A (lead QUIET for 60m: an answered + changed question, an open one, a blocked context) + HOST-C (an answered one; an open one)
  const s90 = createStore2({ host: 'HOST-A' }), s90c = createStore2({ host: 'HOST-C' }), R90 = who('Rev90', 'R90')
  say(s90, R90, { agent: 'lead', label: 'lead', text: '@waiting on Robin' }, at(60))
  say(s90, R90, { agent: 'lead', ask: 'Ship v1.75 today?', choices: ['Yes', 'No'], free: true }, at(60)); say(s90, R90, { agent: 'lead', ask: 'Which changelog wording?', choices: ['Yes', 'No'], free: true }, at(60))
  say(s90, R90, { agent: 'lead', key: 'ctx', label: 'ctx', text: '@blocked on CI', state: 'blocked' }, at(60))
  say(s90c, R90, { agent: 'wc', label: 'wc', text: '@on C' }, at(1)); say(s90c, R90, { agent: 'wc', ask: 'Answered on C?', choices: ['Yes', 'No'] }, at(1)); say(s90c, R90, { agent: 'wc', ask: 'Still open on C?', free: true }, at(1))
  const REM90 = remoteOf('HOST-A', [s90c]), map90 = () => unitMap(s90, REM90), n90 = p => nodeU([...map90().values()].map(x => x.obj), 'Rev90', p)
  { const q1 = n90('lead/?1').node_id; const a = s90.action({ ...R90, id: q1, action: 'answer', args: { choice: 'Yes' } }, at(20), BY), b = s90.action({ ...R90, id: q1, action: 'change_answer', args: { choice: 'No', text: 'wait for the review' } }, at(2), BY)
    const c = s90c.action({ ...R90, id: n90('wc/?1').node_id, action: 'answer', args: { choice: 'Yes' } }, at(1), BY); if (!a.ok || !b.ok || !c.ok) throw new Error('fixture answers: ' + [a.code, b.code, c.code]) }
  const F90 = feed('E90', map90, () => head2({ remote_hosts: [{ host: 'HOST-C', sessions: 1, nodes: 3, linked: true, ...(REM90.hosts.get('HOST-C').down_at ? { down_at: REM90.hosts.get('HOST-C').down_at } : {}) }] })); F90.full()
  const in90 = p => inS('Rev90', p)
  for (const p of ['lead', 'wc']) if (in90(p) && in90(p).getAttribute('aria-expanded') === 'false') tog(in90(p))
  const ro = in90('lead/?2'), rcx = in90('lead/ctx'), r1 = in90('lead/?1')
  check('#90 tree: the OPEN question under a quiet agent is NOT stale ("awaiting answer", no stale pill / class) while the blocked context beside it is',
    !!ro && !ro.classList.contains('stale') && /awaiting answer/.test(ro.querySelector('.pills')?.textContent || '') && !/stale/.test(ro.querySelector('.pills')?.textContent || '') && !!rcx && rcx.classList.contains('stale'), J([ro?.className, rcx?.className]))
  check('#90 tree: the changed answer shows the LATEST answer ("→ No — wait for the review"); its tooltip says "answer changed", the old one ("was: Yes") and how to change it',
    r1?.querySelector('.qa')?.textContent === '→ No — wait for the review' && (() => { const t = tipOf(r1.querySelector('.ln[data-tip]')) || ''; return /answer changed by robin/.test(t) && /\(was: Yes\)/.test(t) && /Change answer…/.test(t) })())
  rc(in90('lead/?1')); const lA = mLab(); escK()
  rc(in90('wc/?1')); const lC = mLab(); escK()
  check('#90 / step 10 menu: an answered question → "Change answer…" (no Answer… / Withdraw / Edit text…) — on another host too', lA[0] === 'Change answer…' && !lA.includes('Answer…') && !lA.some(l => /Withdraw/.test(l)) && !lA.includes('Edit text…') && lC[0] === 'Change answer…', J([lA, lC]))
  const n0 = sentOf('activity_action').length
  rc(in90('lead/?1')); pick('Change answer…')
  const cd = dlg(), okC = cd?.querySelector('[data-dlg="ok"]'), cbs = [...(cd?.querySelectorAll('[data-qc]') || [])], cta = cd?.querySelector('textarea#actAnsT')
  check('#90 Change answer…: the same dialog, titled "Change the answer — lead/?1", the current answer shown, PREFILLED (choice "No" checked, the note in the text box); "Change answer" disabled — it is the current answer; the previous answer stays in the log',
    !!cd && /^Change the answer — lead\/\?1$/.test(cd.querySelector('h3').textContent) && /Current answer: No — wait for the review/.test(cd.querySelector('.qcur')?.textContent || '') && cbs.length === 2 && cbs[1].getAttribute('aria-checked') === 'true' && cbs[0].getAttribute('aria-checked') === 'false'
    && cta?.value === 'wait for the review' && okC.textContent === 'Change answer' && okC.disabled && /current answer/.test(cd.querySelector('.dlg-why').textContent) && /previous answer stays in the log/.test(cd.textContent), cd?.outerHTML.slice(0, 900))
  click(cbs[0])
  const en = !okC.disabled
  click(okC)
  const sc = lastAct()
  check('#90 picking "Yes" enables it; it sends {action:"change_answer", host HOST-A, id, args:{choice:"Yes", text:"wait for the review"}} and closes', en && sentOf('activity_action').length === n0 + 1 && sc.action === 'change_answer' && sc.host === 'HOST-A' && sc.id === n90('lead/?1').node_id && sc.args.choice === 'Yes' && sc.args.text === 'wait for the review' && !dlg(), J(sc))
  const scr = s90.action({ ...R90, id: sc.id, action: sc.action, args: sc.args }, Date.now(), BY)
  recv({ type: 'activity_action', ref: sc.ref, result: { ...scr, host: 'HOST-A', delivered: true, delivery: 'live', released: 0 } })
  check('#90 the result (the owner applied it): ✓ answer changed on the row + a toast "Answer changed — Rev90 was told"', scr.ok && /✓ answer changed/.test(in90('lead/?1')?.querySelector('.fb')?.textContent || '') && [...doc.querySelectorAll('.act-toast')].some(t => t.textContent === 'Answer changed — Rev90 was told'), [...doc.querySelectorAll('.act-toast')].map(t => t.textContent).join(' | '))
  click(in90('lead/?1'))
  const cd2 = dlg()
  check('#90 a CLICK on an answered question offers Change answer… (the dialog, prefilled) and selects it', !!cd2 && /^Change the answer/.test(cd2.querySelector('h3').textContent) && V.sel && V.sel.path === 'lead/?1')
  escK(cd2)
  markOriginDown2(REM90, 'HOST-C', Date.now()); F90.delta()
  const ro2 = in90('wc/?2')
  check('#90 its HOST down (the link dropped: markOriginDown2): the open question there looks stale (greyed) with a "host down" pill — never "gone"', !!ro2 && ro2.classList.contains('stale') && /host down/.test(ro2.querySelector('.pills')?.textContent || '') && !/gone/.test(ro2.querySelector('.pills')?.textContent || ''), ro2?.innerHTML.slice(0, 500))
  check('#90 CSS: the current answer in the dialog uses theme tokens', /\.act-dlg \.qcur b \{[^}]*var\(--ok\)/.test(css) && /\.act-dlg \.qcur \.k \{[^}]*var\(--muted\)/.test(css))
} catch (e) { fail++; console.log('FAIL #90 block crashed:', (e && e.stack) || e) }
try {   // ================================================================= #88 STEP 10 (§5.4, §5.6, §5.7, Q30, Q70): what the 2.0 board adds to the page
  const s10 = createStore2({ host: 'HOST-A' }), S10 = who('Step10', 'S10'), s10say = (input, t) => say(s10, S10, input, t)
  s10say({ text: '@step ten' }, at(30))
  s10say({ key: 'g', label: 'G', context_type: 'group' }, at(29)); s10say({ key: 'g1', label: 'one', under: 'g', text: '@one' }, at(28)); s10say({ key: 'g2', label: 'two', under: 'g', text: '@two', state: 'done' }, at(28)); s10say({ key: 'g3', label: 'three', under: 'g', text: '@three', state: 'abandoned' }, at(28))
  s10say({ key: 'tr', label: 'Tests', context_type: 'test-run', plan: [{ key: 't1', label: 'T1' }, { key: 't2', label: 'T2' }, { key: 't3', label: 'T3' }] }, at(27))
  s10say({ key: 't1', text: 'ok', message_type: 'test-result', fields: { result: 'pass', checks: 3 } }, at(26)); s10say({ key: 't2', text: 'bad', message_type: 'test-result', fields: { result: 'fail', checks: 2, failed: 1 } }, at(26))
  s10say({ key: 'tt', label: 'T', text: '@timed', state: 'running' }, at(10)); s10say({ key: 'tt', state: 'done' }, at(10) + 252000)
  s10say({ key: 'rr', label: 'R', text: '@running', state: 'running' }, at(3)); for (const i of [1, 2, 3]) s10say({ key: 'rr', text: `R line ${i}` }, at(3) + i * 1000)
  s10say({ key: 'rel', label: 'Rel', context_type: 'plan', plan: [{ key: 'a', label: 'a' }, { key: 'b', label: 'b' }] }, at(25))
  s10say({ key: 'box', label: 'Box', text: '@a box' }, at(24)); s10say({ key: 'inner', label: 'inner', under: 'box', text: '@inside' }, at(24))
  let unshared = [{ host: 'LITTLE-001', bridge_version: '1.75.1', since: at(5), seen_by: ['HOST-A'] }, { host: 'MAC-1', since: at(4), seen_by: ['HOST-A'] }], fsw = ['views/host-b (conflicted copy 2026-10-03).json: a conflicted copy — skipped']
  const U10 = () => Object.fromEntries([...map10().values()].map(x => [x.obj.id, x.obj]))
  const map10 = () => unitMap(s10), u10 = () => [...map10().values()].map(x => x.obj), n10 = p => nodeU(u10(), 'Step10', p)
  const F10 = feed('E10', map10, () => head2({ ...(unshared.length ? { unshared_hosts: unshared } : {}), ...(fsw.length ? { fs_warnings: fsw } : {}) })); F10.full()
  const in10 = p => inS('Step10', p)
  // ---- Q70: linked hosts still on 1.7x — RED rows at the TOP of the board; the Dropbox file warnings (amber) beside them
  const top3 = rowsT().slice(0, 3)
  check('step 10 Q70: each head.unshared_hosts entry is a RED row at the TOP of the board — "LITTLE-001 is still on 1.7x (1.75.1): not on this board" (the version when known), role alert, why on hover',
    top3[0].classList.contains('unshared') && top3[0].textContent === '⚠ LITTLE-001 is still on 1.7x (1.75.1): not on this board' && top3[1].textContent === '⚠ MAC-1 is still on 1.7x: not on this board' && top3[0].querySelector('.unsh').getAttribute('role') === 'alert'
    && /nothing of LITTLE-001's activity is on this board/.test(tipOf(top3[0].querySelector('.unsh')) || '') && /linked to: HOST-A/.test(top3[0].querySelector('.unsh').getAttribute('title')) && /\.ar\.unshared \{[^}]*var\(--bad\)/.test(css) && /\.ar\.unshared \.unsh \{ color:var\(--bad\)/.test(css), J(top3.map(r => r.textContent)))
  check('step 10 fs_warnings (§10): each Dropbox-file warning of the head is an amber row up there too', top3[2].classList.contains('fswarn') && /conflicted copy — skipped/.test(top3[2].textContent) && /\.ar\.fswarn \.fsw \{ color:var\(--warn\)/.test(css))
  unshared = []; fsw = []; F10.delta()
  check('step 10 Q70: the row goes when the head no longer lists the host (its link dropped, or it came back on 2.0)', !rowsT().some(r => r.classList.contains('unshared') || r.classList.contains('fswarn')))
  // ---- TYPES (§1.7, §5.7): a group's COUNT and a test-run's TESTS bar where a bar would be; TIME; the type glyphs
  const gRow = in10('G'), trRow = in10('Tests'), tb = n10('Tests').tests
  check('step 10 §5.7: a GROUP shows its COUNT where the bar would be — "1 open · 1 done" (the abandoned child not counted); ▤; no bar', gRow?.querySelector('.pb.gcount')?.textContent === '1 open · 1 done' && /▤/.test(gRow.querySelector('.nm .tg')?.textContent || '') && !gRow.querySelector('.pb > i') && /a list, not a plan/.test(tipOf(gRow.querySelector('.pb.gcount')) || ''), gRow?.innerHTML.slice(0, 500))
  check('step 10 Q56: a TEST-RUN shows ONE bar of its TESTS — passed (green) vs failed (red) of the total, the counts in its tooltip; ⚑', !!trRow?.querySelector('.pb.tests') && parseFloat(trRow.querySelector('.pb.tests > i.tp').style.width) === Math.round(tb.pct_passed * 10) / 10 && parseFloat(trRow.querySelector('.pb.tests > b.tf').style.width) === Math.round(tb.pct_failed * 10) / 10
    && tb.passed === 1 && tb.failed === 1 && tb.total === 3 && (tipOf(trRow.querySelector('.pb.tests')) || '').startsWith('Tests: ' + tb.tooltip) && /⚑/.test(trRow.querySelector('.nm .tg')?.textContent || ''), J([tb, trRow?.querySelector('.pb')?.outerHTML]))
  check('step 10 TIME (§5.7): a finished node says "took 4m 12s" (the bridge\'s), an open attempt "running 3m" (the page\'s clock) — beside the line; ☰ on a plan', in10('T')?.querySelector('.tk')?.textContent === 'took 4m 12s' && /^running 3m( \d+s)?$/.test(in10('R')?.querySelector('.tk')?.textContent || '') && /☰/.test(in10('Rel')?.querySelector('.nm .tg')?.textContent || ''), J([in10('T')?.querySelector('.tk')?.textContent, in10('R')?.querySelector('.tk')?.textContent]))
  tog(gRow); rc(in10('G/one')); pick('Hide')
  check('step 10 §5.7: the viewer\'s HIDDEN rows are not counted either ("1 done")', in10('G')?.querySelector('.pb.gcount')?.textContent === '1 done', in10('G')?.querySelector('.pb')?.outerHTML)
  rc(in10('G/two')); pick('Hide'); click(rowsT().find(r => /2 hidden — show/.test(r.textContent))); rc(in10('G/one')); pick('Unhide'); rc(in10('G/two')); pick('Unhide')
  // ---- SHOW REMOVED (§5.1): the panel's button → the log query with removed:true, kept as opt:show_removed; a removed child's entry is marked
  click(in10('G'))
  const sq0 = sentOf('activity').at(-1), rmB = () => PANEL.querySelector('[data-pa="removed"]')
  check('step 10 show removed: OFF by default (aria-pressed false); the log query has no removed', rmB()?.getAttribute('aria-pressed') === 'false' && !('removed' in sq0.query.log) && sq0.query.log.id === n10('G').node_id)
  click(rmB())
  const sq1 = sentOf('activity').at(-1)
  check('step 10 show removed: ON → the log is read again with removed:true (by id), kept in the view (opt:show_removed true), the button pressed', sq1 !== sq0 && sq1.query.log.removed === true && sq1.query.log.id === n10('G').node_id && X.viewGet(V.view, 'opt:show_removed') === true && rmB().getAttribute('aria-pressed') === 'true', J(sq1.query))
  recv({ type: 'activity', ref: sq1.ref, result: { ok: true, log: { host: 'HOST-A', entries: [{ id: 'act_mr-2', ts: NOW - MIN, node_id: 'gggggggggggggggg', path: 'G/gone one', rel: 'gone one', text: 'was here', rendered: 'was here', state: 'done', removed: true }, { id: 'act_mr-1', ts: NOW - 2 * MIN, node_id: n10('G/one').node_id, path: 'G/one', rel: 'one', text: 'one', rendered: 'one', state: 'running' }], next_cursor: null } } })
  const rmRow = pRows().find(r => r.getAttribute('data-id') === 'act_mr-2')
  check('step 10 show removed: a removed child\'s entry is marked "removed" (class rmd); the others are not', !!rmRow && rmRow.classList.contains('rmd') && rmRow.querySelector('.rmk')?.textContent === 'removed' && !pRows().find(r => r.getAttribute('data-id') === 'act_mr-1').querySelector('.rmk'))
  click(rmB())
  check('step 10 show removed: OFF again → a TOMBSTONE in the view, the log read without removed', sentOf('activity').at(-1).query.log.removed === undefined && V.view.recs['opt:show_removed']?.v === null && rmB().getAttribute('aria-pressed') === 'false')
  // ---- RENAME… (§1.6): a sibling's label → the owner refuses duplicate-label → INLINE, with the free suggestion; the selection survives a rename and a move
  click(in10('T'))
  const tNid = n10('T').node_id, tId = n10('T').id
  rc(in10('T')); pick('Rename…')
  const rd = dlg(), rIn = rd?.querySelector('#actRnT'), rOk = rd?.querySelector('[data-dlg="ok"]')
  check('step 10 Rename…: a dialog prefilled with its LABEL (≤ 60), "Nothing changed" while it is; it says the key stays the same', !!rd && rIn?.value === 'T' && rOk.disabled && /Nothing changed/.test(rd.querySelector('.dlg-why').textContent) && /key .* stays the same/.test(rd.textContent) && rd.querySelector('.dlg-n').textContent === '1 / 60', rd?.textContent)
  typeIn(rIn, 'G'); click(rOk)
  const rn1 = lastAct()
  check('step 10 Rename… sends {action:"rename", id, args:{label}} and WAITS for the owner (the dialog stays open, the button busy)', rn1.action === 'rename' && rn1.id === tNid && rn1.args.label === 'G' && !!dlg() && rOk.disabled, J(rn1))
  const rnr = own(s10, rn1), sugB = rd.querySelector('.rnsug button')
  check('step 10 Rename… onto a sibling\'s label: the owner\'s duplicate-label is shown INLINE (the dialog stays) — "\\"G\\" is taken here (by g) — \\"G (2)\\" is free." — with a "Use “G (2)”" button', rnr.code === 'duplicate-label' && !!dlg() && /"G" is taken here \(by g\) — "G \(2\)" is free\./.test(rd.querySelector('.dlg-why').textContent) && sugB?.textContent === 'Use “G (2)”' && !rd.querySelector('.rnsug').hidden, J([rnr.code, rd.querySelector('.dlg-why')?.textContent]))
  click(sugB)
  check('step 10 ... the suggestion fills the field (and clears the refusal)', rIn.value === 'G (2)' && !rOk.disabled && rd.querySelector('.dlg-why').textContent === '')
  click(rOk)
  const rn2 = lastAct(), rnr2 = own(s10, rn2)
  check('step 10 Rename… accepted: the dialog closes, ✓ renamed, a toast', rn2.args.label === 'G (2)' && rnr2.ok && !dlg() && /✓ renamed/.test(in10('T')?.querySelector('.fb')?.textContent || '') && [...doc.querySelectorAll('.act-toast')].some(t => t.textContent === 'Renamed to “G (2)”'))
  F10.delta()
  check('step 10 a RENAME keeps the selection — the same unit id / node id under its new label and path (the row and the panel follow it)', V.sel?.id === tId && V.sel?.nid === tNid && in10('G (2)')?.classList.contains('sel') && in10('G (2)').getAttribute('data-nid') === tNid && !in10('T') && PANEL.querySelector('.aph-t .nm')?.textContent === 'G (2)', J([V.sel?.path, PANEL.querySelector('.aph-t .nm')?.textContent]))
  rc(in10('G (2)')); pick('Move to…'); { const p = dlg().querySelector('select.act-pick'); p.value = [...p.options].find(o => /^\s*Box$/.test(o.textContent)).value } click(dlg().querySelector('[data-dlg="ok"]')); click(dlg().querySelector('[data-dlg="ok"]'))
  const mvT = lastAct(), mvTr = own(s10, mvT); F10.delta()
  check('step 10 a MOVE keeps the selection too (by id: the panel names it by its NEW path)', mvT.args.to_id === n10('Box').node_id && mvTr.ok && V.sel?.id === tId && !doc.getElementById('actmain').classList.contains('nosel') && PANEL.querySelector('.aph-t .nm')?.textContent === 'Box/G (2)' && n10('Box/G (2)').node_id === tNid && !!U10()[tId], J([mvTr.code, PANEL.querySelector('.aph-t .nm')?.textContent]))
  // ---- the per-user VIEW, live: a push from another window / host (Q30) — tree choices apply LIVE; sel and fold:details only at a page's load
  const push = (recs, dt = 1) => recv({ type: 'view', recs: viewOf(recs, Date.now() + dt).recs })
  check('step 10 defaults: an open plan (Rel) is open, a plain context (Box) is closed', !!in10('Rel/a') && in10('Box')?.getAttribute('aria-expanded') === 'false')
  push([{ k: 'open:' + n10('Rel').node_id, v: { o: 0, n: 0, q: 0 } }, { k: 'open:' + n10('Box').node_id, v: { o: 1 } }])
  check('step 10 open / closed BEAT the defaults, applied LIVE from a push: the open plan closed, the closed context opened', !in10('Rel/a') && in10('Rel').getAttribute('aria-expanded') === 'false' && !!in10('Box/inner') && in10('Box').getAttribute('aria-expanded') === 'true')
  const selBefore = V.sel?.id, detBefore = V.detOpen
  push([{ k: 'sel', v: n10('G').node_id }, { k: 'fold:details', v: detBefore ? 0 : 1 }, { k: 'pin:' + n10('R').node_id, v: 1 }, { k: 'opt:active_only', v: true }])
  check('step 10 Q30: a pushed sel / fold:details are NOT applied in an open window (no stolen selection); pins and options ARE (live)', V.sel?.id === selBefore && V.detOpen === detBefore && !!in10('R')?.querySelector('.pin') && ao.checked === true && X.viewGet(V.view, 'sel') === n10('G').node_id, J([V.sel?.id, selBefore, V.detOpen]))
  recv({ type: 'view', recs: [{ k: 'opt:active_only', v: null, ts: Date.now() + 2, origin: 'HOST-B' }] })   // a tombstone (another window unticked it)
  check('step 10 ... and a pushed tombstone puts the option back (active only off)', ao.checked === false)
  // ---- a node the viewer CLOSED gains activity → a badge, never reopened
  tog(in10('Box'))
  const boxRec = X.viewGet(V.view, 'open:' + n10('Box').node_id)
  check('step 10 closing a node records its subtree\'s entry count and open questions at the close ({o:0, n, q})', boxRec?.o === 0 && boxRec.n === X.subtreeCount(V.fullIdx[n10('Box').id]) && boxRec.q === 0, J(boxRec))
  s10say({ key: 'inner', text: 'more inside' }, Date.now()); s10say({ key: 'inner', text: 'and more' }, Date.now() + 1); F10.delta()
  check('step 10 a CLOSED node gaining activity is NOT reopened: it shows "2 new" (entries since you closed it)', in10('Box')?.getAttribute('aria-expanded') === 'false' && !in10('Box/inner') && in10('Box').querySelector('.nbadge')?.textContent === '2 new' && /2 new entries below since you closed it/.test(tipOf(in10('Box').querySelector('.nbadge')) || ''), in10('Box')?.innerHTML.slice(0, 400))
  s10say({ key: 'inner', ask: 'Ready to ship the box?', free: true }, Date.now() + 2); F10.delta()
  check('step 10 ... a new OPEN question below it shows "? 1" instead (questions beat entries), still closed', in10('Box')?.getAttribute('aria-expanded') === 'false' && in10('Box').querySelector('.qbadge')?.textContent === '? 1' && !in10('Box').querySelector('.nbadge'), in10('Box')?.innerHTML.slice(0, 400))
  tog(in10('Box'))
  check('step 10 opening it clears the badge (an open record)', in10('Box')?.getAttribute('aria-expanded') === 'true' && !in10('Box').querySelector('.qbadge, .nbadge') && X.viewGet(V.view, 'open:' + n10('Box').node_id)?.o === 1)
  // ---- Expand all, then a NEW node → its default (the `all` record covers only the nodes created before it)
  click(doc.getElementById('actExpand'))
  const allTs = V.view.recs.all.ts
  check('step 10 Expand all = ONE record: every node created before it opens (Rel, closed by your earlier choice, too — the newer record wins)', !!in10('Rel/a') && in10('Box/inner')?.getAttribute('aria-expanded') === 'true' && X.viewGet(V.view, 'all')?.o === 1)
  s10say({ key: 'later', label: 'Later', text: '@later' }, allTs + 5000); s10say({ key: 'lx', label: 'x', under: 'later', text: '@x' }, allTs + 5001); F10.delta()
  check('step 10 Expand all, then a NEW node (created after it) → its DEFAULT (closed), while the older ones stay open', in10('Later')?.getAttribute('aria-expanded') === 'false' && !in10('Later/x') && in10('Box')?.getAttribute('aria-expanded') === 'true' && X.viewOpen(V.view, n10('Later').node_id, n10('Later').created_at) === null, J([in10('Later')?.getAttribute('aria-expanded'), n10('Later').created_at - allTs]))
  // ---- "NEW SINCE YOU LAST LOOKED": seen:<t> (a max register) → a divider above the first newer entry; what is on screen becomes the new seen
  const rNid = n10('R').node_id, rPage = s10.logPage({ session: 'Step10', project: 'S10', user: 'robin', id: rNid }, Date.now())
  push([{ k: 'seen:' + rNid, v: rPage.entries[2].id }])
  click(in10('R'))
  const rq10 = sentOf('activity').at(-1)
  recv({ type: 'activity', ref: rq10.ref, result: { ok: true, log: { ...s10.logPage(rq10.query.log, Date.now()), host: 'HOST-A' } } })
  const pr = pRows(), nsep = pr.findIndex(r => r.classList.contains('newsep'))
  check('step 10 the divider: "— new since you last looked ↓ —" sits right after the entry you had seen (oldest first): the 2 newer entries below it', nsep > 0 && /new since you last looked ↓/.test(pr[nsep].textContent) && pr[nsep - 1].getAttribute('data-id') === rPage.entries[2].id && pr.slice(nsep + 1).map(r => r.getAttribute('data-id')).join() === [rPage.entries[1].id, rPage.entries[0].id].join(), J(pr.map(r => r.getAttribute('data-id') || r.textContent)))
  check('step 10 seen:<t> is sent: the newest entry now on screen (a max register on the bridge)', X.viewGet(V.view, 'seen:' + rNid) === rPage.entries[0].id && (V.viewQ['seen:' + rNid] === rPage.entries[0].id || sentOf('view_set').some(m => m.recs.some(r => r.k === 'seen:' + rNid && r.v === rPage.entries[0].id))))
  // ---- RESET VIEW arriving from elsewhere (a push) applies LIVE: every choice back to its default
  push([{ k: 'reset', v: 1 }], 5)
  check('step 10 Reset view from another window (a push) applies LIVE: pins gone, Expand all / open / closed void → the defaults (Rel open — its plan; Box closed; Later closed), options off', !in10('R')?.querySelector('.pin') && !!in10('Rel/a') && in10('Box')?.getAttribute('aria-expanded') === 'false' && !in10('Box/inner') && !ao.checked && X.viewGet(V.view, 'all') === undefined)
  // ---- a fresh PAGE LOAD: the view's sel + fold:details apply (Q30), its options, and the ONE-TIME localStorage import (Q13)
  const units10 = u10(), gk10 = sessU(units10, 'Step10').key
  const legacy = { pins: [J(['n', gk10, 'host-a', '@Rel/@a']), J(['s', gk10]), J(['n', gk10, 'host-a', '@"No longer"/@here'])], hidden: [J(['n', gk10, 'HOST-A', '@G/@two'])] }
  async function loadPage(view, ls) {
    class WS3 { constructor() { this.readyState = 0; this.sent = []; WS3.last = this } send(s) { this.sent.push(JSON.parse(s)) } close() { this.readyState = 3 } }
    const errs = [], { VirtualConsole } = await import('jsdom'), vc = new VirtualConsole(); vc.on('jsdomError', e => errs.push(String(e && (e.stack || e.message || e))))
    const d3 = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1:12318/dashboard.html?token=t', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) { w.WebSocket = WS3; try { for (const [k, v] of Object.entries(ls || {})) w.localStorage.setItem(k, v) } catch { } } })
    const s3 = WS3.last, r3 = m => s3.onmessage({ data: J(m) })
    s3.readyState = 1; s3.onopen && s3.onopen()
    r3({ type: 'welcome', gateway: 'HOST-A/bbb', sessions: [], pages: [], hosts: {}, bridge_version: '2.0.0', profile: {}, capabilities: {}, view })
    return { d3, w3: d3.window, s3, r3, errs }
  }
  const pg = await loadPage(viewOf([{ k: 'sel', v: tNid }, { k: 'fold:details', v: 0 }, { k: 'opt:active_only', v: true }, { k: 'opt:log_order', v: 'newest' }]), { 'aimb.act.pins': J(legacy.pins), 'aimb.act.hidden': J(legacy.hidden), 'aimb.act.active': '0' })
  try {
    const A3 = pg.w3.AimbActView, D3 = pg.w3.document
    check('step 10 page LOAD: the options come from the VIEW (active only ticked, newest first) — not this browser\'s', D3.getElementById('actActive').checked === true && A3.activeOnly === true && A3.logOrder === 'newest')
    pg.r3({ type: 'activity_board', full: true, epoch: 'L1', seq: 1, head: head2(), types: TYPES, upsert: units10 })
    const vs3 = pg.s3.sent.filter(m => m.type === 'view_set'), recs3 = vs3.flatMap(m => m.recs), lq3 = pg.s3.sent.filter(m => m.type === 'activity' && m.query.log).at(-1)
    check('step 10 page LOAD (Q30): the remembered selection is restored once the board has it (its log asked BY ID) and the DETAILS fold applies (closed)', A3.sel?.nid === tNid && lq3?.query.log.id === tNid && A3.detOpen === false, J([A3.sel, lq3?.query, A3.detOpen]))
    check('step 10 the ONE-TIME IMPORT (Q13): this browser\'s 1.7x pins / hidden (path-keyed unit ids) are mapped to node ids by the units\' paths and SENT as view_set (a session row keeps its unit id; a path no longer on the board is dropped)',
      recs3.some(r => r.k === 'pin:' + nodeU(units10, 'Step10', 'Rel/a').node_id && r.v === 1) && recs3.some(r => r.k === 'pin:' + sessU(units10, 'Step10').id && r.v === 1) && recs3.some(r => r.k === 'hide:' + nodeU(units10, 'Step10', 'G/two').node_id && r.v === 1) && recs3.filter(r => /^(pin|hide):/.test(r.k)).length === 3, J(recs3))
    check('step 10 ... then the localStorage keys are REMOVED, and a toast says what moved', (() => { try { return pg.w3.localStorage.getItem('aimb.act.pins') === null && pg.w3.localStorage.getItem('aimb.act.hidden') === null } catch { return false } })()
      && [...D3.querySelectorAll('.act-toast')].some(t => /Moved this browser's 2 pins \(1 no longer on the board\) and 1 hidden row into your view on the bridge/.test(t.textContent)), [...D3.querySelectorAll('.act-toast')].map(t => t.textContent).join(' | '))
    const nVs3 = pg.s3.sent.filter(m => m.type === 'view_set').length
    pg.r3({ type: 'activity_board', full: true, epoch: 'L2', seq: 1, head: head2(), types: TYPES, upsert: units10 })
    check('step 10 ... ONCE: a later board imports nothing more; the imported pin shows (📌 on Rel/a), the imported hidden row is hidden', pg.s3.sent.filter(m => m.type === 'view_set').length === nVs3 && !![...D3.querySelectorAll('#acttree .ar')].find(r => r.getAttribute('data-path') === 'Rel/a')?.querySelector('.pin') && ![...D3.querySelectorAll('#acttree .ar')].some(r => r.getAttribute('data-path') === 'G/two'))
    check('step 10 page LOAD: no script error', !pg.errs.length, J(pg.errs))
  } finally { pg.d3.window.close() }
} catch (e) { fail++; console.log('FAIL step 10 block crashed:', (e && e.stack) || e) }
console.log(`\n${pass} passed, ${fail} failed`)
dom.window.close()
process.exit(fail ? 1 : 0)
