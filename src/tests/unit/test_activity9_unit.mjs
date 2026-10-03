// Fast UNIT tests for #88 (v2.0) build step 9 — TOOL, SCRIPT, GUIDES (docs/spec-88.md §4, §8 step 9): no bridge, no sockets.
// Covered:
//   - the BATCH (lib/activity2.js splitBatch2): the bounds (empty, 64 items, 64 KB) refuse the whole call; beside the items
//     only `agent` / `log` (defaults; an item's own value wins); an unknown item field fails that item alone; a nested batch;
//     the 1.7x fields pass through so the parser names the 2.0 form; the STORE's batch (lib/activity2-store.js): each item
//     its own all-or-nothing call, in order, refs echoed, applied / failed counts, `left` collected;
//   - the legacy forms the parser refuses (§4.5): `to`, `note`, `context`, `@` paths, `@~` — each `legacy-form`, naming the
//     2.0 form;
//   - findTarget2 / the store's find: READ-ONLY (no create, no session made), key / id / path / agent, unknown-agent,
//     unknown-node, legacy paths; the store's resolve (Q46) and outcome (a waiter's view: open / answered / gone);
//   - `--guide agent`'s FIRST REPORT (the store's guideAgent, §4.4): created once (running, "reading the guide", under
//     `under`, a sibling clash → "(2)"), nothing written the second time, label-required for a new agent, a missing earlier
//     chain step → unknown-agent, a ghost agent comes back as a new run without a label;
//   - the 2.0 GUIDES (lib/log-snippet.js, §4.3): {log_snippet} (the 2.0 command + one line), the agent guide (the spec's rule
//     lines, each ≤ 110 characters, no 1.7x form), the session guide, the tool hint, gatewayNote, renderGuide's {agent};
//   - the TOOL SCHEMAS (lib/tool-schemas.js): `log` takes every 2.0 field (LOG2_FIELDS) and no 1.7x one (to, context);
//     `resolve` exists; `activity` reads by id (log.id, log.removed) without the 1.7x filters.
import { testOnly } from '../helpers/check.mjs'
import * as M from '../../lib/activity2.js'
import * as S from '../../lib/activity2-store.js'
import { logSnippet, logCmd, agentGuide, sessionGuide, gatewayNote, renderGuide, guideText, LOG_TOOL_LINES, LOG_SNIPPET_LINES, logToolHint } from '../../lib/log-snippet.js'
import { TOOLS } from '../../lib/tool-schemas.js'
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.stack} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
function section(name, fn) { try { fn() } catch (e) { fail++; console.log(`FAIL section "${name}" crashed:`, (e && e.stack) || e) } }
const ID = { session: 'Bridget', project: 'AIMB', user: 'robin', realm: 'default' }
const strip = r => { if (!r || typeof r !== 'object') return r; const { records, entries, writes, ...x } = r; return x }

section('batch', () => {
  const ok = M.splitBatch2({ items: [{ key: 'a', label: 'A', text: 'x', ref: 1 }, { text: 'y', agent: 'other' }, { key: 'b', log: true }], agent: 'w', log: false })
  check('splitBatch2: the defaults (agent, log) go to every item that has none; an item\'s own wins; ref split off', ok.ok && J(ok.items) === J([{ ref: 1, input: { key: 'a', label: 'A', text: 'x', agent: 'w', log: false } }, { input: { text: 'y', agent: 'other', log: false } }, { input: { key: 'b', log: true, agent: 'w' } }]), J(ok))
  check('splitBatch2: bounds — not an array / empty → bad-batch; 65 items → too-many-items; > 64 KB → batch-too-large',
    M.splitBatch2({ items: {} }).code === 'bad-batch' && M.splitBatch2({ items: [] }).code === 'bad-batch' && M.splitBatch2({ items: Array.from({ length: 65 }, () => ({})) }).code === 'too-many-items'
    && M.splitBatch2({ items: Array.from({ length: 20 }, () => ({ details: 'd'.repeat(4000) })) }).code === 'batch-too-large')
  check('splitBatch2: beside items only agent / log — a key or a path there refuses the whole call (bad-batch, naming it)', (r => r.code === 'bad-batch' && /key, path/.test(r.what))(M.splitBatch2({ items: [{}], key: 'k', path: 'p' })))
  const per = M.splitBatch2({ items: [{ text: 'x', bogus: 1 }, 'str', { items: [] }, { to: 'x', note: 'y', context: '@z' }] })
  check('splitBatch2: an unknown field / a non-object / a nested batch fails that item alone; the 1.7x fields pass through (the parser names the 2.0 form)', per.ok && per.items[0].error?.code === 'bad-field' && per.items[1].error?.code === 'bad-item'
    && per.items[2].error?.code === 'bad-item' && J(per.items[3].input) === J({ to: 'x', note: 'y', context: '@z' }), J(per))
  const st = S.createStore2({ host: 'H' })
  st.apply(ID, { agent: 'w', label: 'Worker', text: '@on' }, 1000)
  const r = st.batch(ID, { agent: 'w', items: [{ ref: 'one', key: 'tmp', label: 'Tmp', transient: true }, { ref: 'two', key: 'kid', label: 'Kid', under: 'tmp' }, { ref: 'bad', key: 'nolabel', text: 'x' }, { ref: 'mv', key: 'kid', move: 'w' }, { ref: 'old', path: '@x', text: 'y' }] }, 2000)
  check('store.batch: each item its own call, in order; refs echoed; a refusal fails alone (label-required, legacy-form); applied / failed', r.ok && r.applied === 3 && r.failed === 2
    && J(r.results.map(x => [x.ref, x.ok, x.code || x.node.path])) === J([['one', true, 'Worker/Tmp'], ['two', true, 'Worker/Tmp/Kid'], ['bad', false, 'label-required'], ['mv', true, 'Worker/Kid'], ['old', false, 'legacy-form']]), J(r.results.map(strip)))
  check('store.batch: what left the board in any item is collected once (the transient Tmp vanished when Kid moved out)', J(r.left) === J([r.results[0].node.id]) && !r.results.some(x => x.left), J(r.left))
  check('store.batch: the bounds refuse the whole call before anything is applied', st.batch(ID, { items: [] }, 3000).code === 'bad-batch' && st.batch(ID, { items: [{}], key: 'x' }, 3000).code === 'bad-batch')
})

section('legacy forms', () => {
  const st = S.createStore2({ host: 'H' })
  const L = input => st.apply(ID, input, 1000)
  const rs = [L({ move: 'x', to: 'y' }), L({ note: 'n' }), L({ context: '@~Ctx', text: 'x' }), L({ path: '@Next release/@Docs', text: 'x' }), L({ path: 'Rel/@~x', text: 'y' }), L({ text: '@~root headline' })]
  check('§4.5: to, note, context, an @ path, an @~ path and @~ text → legacy-form each, nothing written (no session made)', rs.every(r => r.ok === false && r.code === 'legacy-form') && st.state.sessions.size === 0, J(rs))
  check('§4.5: each message names the 2.0 form', /use --key <node> --move <parent>/.test(rs[0].what) && /plain text only logs/.test(rs[1].what) && /context was removed in 2\.0: name the node with key/.test(rs[2].what)
    && /write "Next release\/Docs"/.test(rs[3].what) && /@~ was removed/.test(rs[4].what) && /use --text "@headline"/.test(rs[5].what), J(rs.map(r => r.what)))
})

section('find / resolve / outcome', () => {
  const st = S.createStore2({ host: 'H' })
  check('find: an unknown session → unknown-session, and the read made none', st.find(ID, { key: 'x' }).code === 'unknown-session' && st.state.sessions.size === 0)
  st.apply(ID, { agent: 'a', label: 'Agent A', text: '@on' }, 1000)
  const doc = st.apply(ID, { agent: 'a', key: 'docs', label: 'Docs', text: 'x' }, 1001)
  const f1 = st.find(ID, { agent: 'a', key: 'docs' }), f2 = st.find(ID, { id: doc.node.id }), f3 = st.find(ID, { agent: 'a', path: 'Docs' }), f4 = st.find(ID, { agent: 'a' })
  check('find: by agent + key, by id, by agent + path, the agent itself — all the same node / the agent', f1.ok && f1.id === doc.node.id && f2.id === doc.node.id && f3.id === doc.node.id && f4.ok && f4.node.kind === 'agent' && f1.node.path === 'Agent A/Docs', J([f1, f4]))
  const n0 = [...st.state.sessions.values()][0].nodes.size
  const nf = [st.find(ID, { key: 'docs' }), st.find(ID, { agent: 'zz' }), st.find(ID, { path: 'Nope/Missing' }), st.find(ID, { path: '@Agent A' })]
  check('find: READ-ONLY — a key in another scope, a missing agent, a missing path, a 1.7x path → refusals, nothing created', J(nf.map(r => r.code)) === J(['unknown-node', 'unknown-agent', 'unknown-node', 'legacy-form']) && [...st.state.sessions.values()][0].nodes.size === n0, J(nf))
  const q = st.apply(ID, { agent: 'a', ask: 'Which one should we ship?', choices: ['A', 'B'] }, 2000)
  check('outcome: an open question → open; by id; a non-question → gone', st.outcome(ID, q.node.id).outcome === 'open' && st.outcome(ID, doc.node.id).outcome === 'gone' && st.outcome(ID, 'aaaaaaaaaaaaaaaa').outcome === 'gone', J(st.outcome(ID, q.node.id)))
  const an = st.action({ ...ID, id: q.node.id, action: 'answer', args: { choice: 'B' } }, 3000, { by: { kind: 'dashboard', user: 'robin', host: 'H' } })
  check('outcome: answered (from the dashboard action) → outcome answered with the choice', an.ok && st.outcome(ID, q.node.id).outcome === 'answered' && st.outcome(ID, q.node.id).answer?.choice === 'B', J([strip(an), st.outcome(ID, q.node.id)]))
  const rv = st.resolve(ID, { agent: 'a', key: 'docs', resolve: '../Done' })
  check('resolve: "../Done" from Agent A/Docs → /Done would be created; nothing changes', rv.ok && rv.path === '/Done' && rv.state === 'new' && J(rv.create) === J(['Done']) && !st.find(ID, { path: 'Done' }).ok, J(rv))
})

section('guide agent = the first report', () => {
  const st = S.createStore2({ host: 'H' })
  st.apply(ID, { key: 'rel', label: 'Next release', plan: [{ key: 'fix-x', label: 'Fix X' }] }, 1000)
  const g1 = st.guideAgent(ID, { agent: 'helper', label: 'Helper', under: 'fix-x' }, 2000)
  const row = () => st.board({}, 2500)[0].nodes.find(n => n.key === 'helper')
  check('guideAgent: a NEW agent is created under `under` — running, its line "reading the guide", created:true', g1.ok && g1.created === true && g1.node.path === 'Next release/Fix X/Helper' && row()?.state === 'running' && row()?.current?.text === 'reading the guide', J([strip(g1), row()]))
  st.apply(ID, { agent: 'helper', text: '@working on it' }, 3000)
  const before = row().log_n, g2 = st.guideAgent(ID, { agent: 'helper', label: 'Helper', under: 'fix-x' }, 4000)
  check('guideAgent: the agent is already there → created:false, NOTHING written (its running line kept)', g2.ok && g2.created === false && g2.node.key === 'helper' && row().current.text === 'working on it' && row().log_n === before, J([g2, row()]))
  check('guideAgent: a new agent without a label → label-required; a missing earlier chain step → unknown-agent; an unknown under → unknown-node',
    st.guideAgent(ID, { agent: 'nolabel' }, 5000).code === 'label-required' && st.guideAgent(ID, { agent: 'missing/child', label: 'C' }, 5000).code === 'unknown-agent'
    && st.guideAgent(ID, { agent: 'x2', label: 'X2', under: 'nope' }, 5000).code === 'unknown-node')
  const g3 = st.guideAgent(ID, { agent: 'twin', label: 'Helper', under: 'fix-x' }, 6000)
  check('guideAgent: a sibling has the label → "Helper (2)" with the relabelled warning', g3.ok && g3.created && g3.node.label === 'Helper (2)' && (g3.warnings || []).some(w => w.code === 'relabelled'), J(strip(g3)))
  const g4 = st.guideAgent(ID, { agent: 'helper/sub', label: 'Sub' }, 7000)
  check('guideAgent: a sub-agent of an existing agent (a chain) is created under its creator', g4.ok && g4.created && g4.node.scope === 'helper' && g4.node.path === 'Next release/Fix X/Helper/Sub', J(strip(g4)))
})

section('guides (§4.3)', () => {
  const cmd = logCmd({ node: 'C:/node.exe', script: 'D:/x/aimb-log.mjs', session: 'Bridget', project: 'AIMB', tokenFile: 'C:/t.env' })
  check('{log_snippet}: the 2.0 command (--agent <your-key> --label "<your name>" --under <item-key>) + ONE line (--guide agent puts you on the board)',
    logSnippet({ node: 'C:/node.exe', script: 'D:/x/aimb-log.mjs', session: 'Bridget', project: 'AIMB', tokenFile: 'C:/t.env' }) === `Report your status with: ${cmd} --agent <your-key> --label "<your name>" --under <item-key>\n- First run it with --guide agent in place of --text: that puts you on the board and prints the rules.`
    && LOG_SNIPPET_LINES.length === 1)
  const ag = agentGuide({ cmd, agent: 'spec-88', gateway: '2.0.0', script: '2.0.0' }), lines = ag.split('\n')
  const SPEC_RULES = [
    '- --key <k> names YOUR node. Make it once with --label "<name>" (needed) and --under <k>; then just --key <k>.',
    '- --text "@<what>" sets the node\'s line; plain --text "…" only logs. No --key = your own node.',
    '- Make your checklist first: --item <k> "<label>" (repeat it); tick one with --key <k> --done.',
    '- A name a sibling already has becomes "<name> (2)": the result says which label you got.',
    '- Report at milestones only (calls cost tokens); add --stale-after 60m before a long silent step.',
    '- A used key reopens its node: new work gets a new key (docs-2). Keys: letters, digits and _ . # + -',
    '- Finish with --state done --text "@<summary>" (or failed): the @ makes the summary your line.',
    '- Never put secrets in status text.',
    '- Need a decision? --ask "…" --choice "A" --choice "B" --wait 30m waits for the answer (exit 0 = answered).',
    '- Ask the question only, then one --choice per option: don\'t list the choices in the question.',
  ]
  check('agent guide: every rule line of §4.3, verbatim, in order', (() => { let i = -1; return SPEC_RULES.every(r => { const j = lines.indexOf(r); const ok = j > i; i = j; return ok }) })(), J(SPEC_RULES.filter(r => !lines.includes(r))))
  check('agent guide: each rule line ≤ 110 characters; the command line names the agent; no 1.7x form (@~, --path "…/@…", --plan)', lines.filter(l => !l.startsWith('  ')).every(l => [...l].length <= 110)
    && lines.includes(`  ${cmd} --agent "spec-88" --text "<text>"`) && !/@~|--plan|\/@/.test(ag), J(lines.filter(l => [...l].length > 110)))
  check('agent guide: no agent known → "<your-key>"; a gateway that is not on 2.0 → one note line; unreachable → the unreachable note', /--agent "<your-key>"/.test(agentGuide({ cmd: 'c' }))
    && /This host's gateway runs 1\.75\.1, not 2\.0/.test(agentGuide({ cmd: 'c', gateway: '1.75.1', gateway2: false })) && /could not be reached just now/.test(agentGuide({ cmd: 'c' })) && J(gatewayNote('2.0.0')) === '[]')
  const sg = sessionGuide({ cmd: 'c', gateway: '2.0.0', script: '2.0.0' })
  check('session guide: its own reports by key, items as --item <key> "<label>", briefing an agent with --agent <key> --label "…" --under <item key> --guide agent; no 1.7x form', /--key rel --item fix-x "Fix X"/.test(sg)
    && /c --agent <key> --label "<its name>" --under fix-x --guide agent/.test(sg) && /--state done --text "@<summary>"/.test(sg) && !/@~|--plan|\/@/.test(sg) && sg.split('\n').every(l => [...l].length <= 110), sg)
  check('tool hint ({log_tool_hint}): key / label, plan items as { key, label }, a leading @ in text; each line ≤ 110; no 1.7x form', LOG_TOOL_LINES.every(l => [...l].length <= 110) && !/@~|path:"/.test(logToolHint({ session: 'S' }))
    && /key:"docs", label:"Write the docs"/.test(logToolHint({ session: 'S' })) && /plan:\[\{ key:"a", label:"A" \}/.test(logToolHint({ session: 'S' })), logToolHint({ session: 'S' }))
  check('guideText: no template → the built-in 2.0 guide (agent passed through); a realm template gets {agent} filled', guideText({ kind: 'agent', cmd: 'c', agent: 'x' }) === agentGuide({ cmd: 'c', agent: 'x' })
    && guideText({ kind: 'agent', template: 'run {cmd} --agent {agent}', cmd: 'c', agent: 'x', gateway: '2.0.0' }) === 'run c --agent x' && renderGuide('{agent}', {}) === '<your-key>')
})

section('tool schemas', () => {
  const T = n => TOOLS.find(t => t.name === n)
  const lp = Object.keys(T('log').inputSchema.properties)
  check('log: takes every 2.0 field (LOG2_FIELDS) + as / secret / guide / items', [...M.LOG2_FIELDS, 'as', 'secret', 'guide', 'items'].every(f => lp.includes(f)), J(M.LOG2_FIELDS.filter(f => !lp.includes(f))))
  check('log: no 1.7x field in the schema (to, context) and no @~ in its description', !lp.includes('to') && !lp.includes('context') && !/@~root|"@ctx/.test(T('log').description) && /legacy-form/.test(T('log').description))
  check('resolve: a read-only tool taking as / secret / resolve / agent / key / id / path', !!T('resolve') && ['as', 'secret', 'resolve', 'agent', 'key', 'id', 'path'].every(f => f in T('resolve').inputSchema.properties) && J(T('resolve').inputSchema.required) === J(['as', 'secret', 'resolve']))
  const ap = T('activity').inputSchema.properties
  check('activity: reads by id (log.id, log.removed, earlier) and the 2.0 filters; the 1.7x agent / context / active_only are gone', 'id' in ap.log.properties && 'removed' in ap.log.properties && 'earlier' in ap.log.properties && 'user' in ap
    && !('agent' in ap) && !('active_only' in ap) && !('context' in ap.log.properties) && !('agent' in ap.log.properties))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
