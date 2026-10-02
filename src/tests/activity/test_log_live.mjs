// #70 step 2 (v1.58.0) — the `log` + `activity` tools, the gateway-owned activity state and the host's daily JSONL.
// One host: a GATEWAY (G) and a FOLLOWER (F) on the same port (F loses the bind and follows), one temp persist dir, a temp
// AI_BRIDGE_CONFIG (never src/config.json) with activity.log_entries_per_agent = 10, and env knobs: a 700 ms checkpoint
// interval and an id index of 3 (so older lookups take the day-file scan). Ports 13950-13951 (+ 13960-13961 for the
// disabled bridge). Covers: log via a gateway sub-peer AND a follower sub-peer (forwarded; one file per host), @ vs @~,
// text templates, log:false (board only — not in the log or the file), cp + rep lines (one cp + ONE rep whose n grows; a
// change → new cp + fresh rep), details/data lookups (memory / index / scan, after the in-memory copy is gone), session-
// level messages, limits, enabled:false, stale via stale_after, unauthenticated frames, gone on deregister, retention
// (a seeded old file), startup replay of a seeded day file, and restart replay (kill the gateway: the follower takes over
// and its board comes back from the files — the log:false bar included; then a fresh gateway does it again).
// v1.62.0 (#70 step 6a): the NODE TREE over the tool (every path form, nested nodes on the board, a subtree's merged log,
// nested nodes replayed after a restart), BATCH logging via the tool (order, per-item results + refs, partial failure, the
// bounds, a follower's batch forwarded in ONE frame — the gateway's test tap counts it), and a 1.61-format (v1) JSONL
// record in the seeded day file skipped cleanly.
// AIMB_TEST_BRIDGE=<file> runs it against another bridge copy (the pre-change proof).
import { testOnly } from '../helpers/check.mjs'
import { testPorts } from '../helpers/ports.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lslug } from '../../facets/persistence/file.js'
import * as Act from '../../lib/activity.js'
const tp = testPorts(import.meta.url, 13950)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const TOKEN = 'logtesttok', PORT = String(tp(13950)), OFF_PORT = String(tp(13960))
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-log-'))
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-logcfg-'))
const cfgFile = path.join(cfgDir, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_entries_per_agent: 10 } }))
const hostDir = path.join(persist, 'activity', lslug(os.hostname(), 80))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
const day = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

function spawn(name, port = PORT, extra = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_ADVERTISE_HOST: '127.0.0.1', AI_BRIDGE_USER: 'robin',
      AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persist, AI_BRIDGE_DISCOVERY: 'none',
      AI_BRIDGE_ACTIVITY_CHECKPOINT_MS: '700', AI_BRIDGE_ACTIVITY_INDEX_MAX: '3', AI_BRIDGE_TEST_ACTIVITY_TAP: '1', ...extra }, stderr: 'pipe' })
  const c = new Client({ name: `t-${name}`, version: '0' }, { capabilities: {} })
  return c.connect(transport).then(() => ({ c, transport, name }))
}
const call = async (b, n, a = {}) => { try { return JSON.parse((await b.c.callTool({ name: n, arguments: a })).content[0].text) } catch (e) { return { ok: false, code: 'call-threw', what: String(e && e.message) } } }
const reg = (h, name, secret, project) => call(h, 'register_self', { name, secret, project })
async function until(fn, want, ms = 6000) {
  const t0 = Date.now(); let r
  do { r = await fn(); if (want(r)) return r; await sleep(150) } while (Date.now() - t0 < ms)
  return r
}
/** every record in this host's day files, file order (oldest day first) */
function records() {
  const out = []
  let files = []; try { files = fs.readdirSync(hostDir).filter(f => f.endsWith('.jsonl')).sort() } catch { }
  for (const f of files) for (const line of fs.readFileSync(path.join(hostDir, f), 'utf8').split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)) } catch { } }
  return out
}
const board = async h => (await call(h, 'activity')).sessions || []
const sess = (b, name) => b.find(s => s.session === name)
const nodeOf = (b, sname, p) => (p === '' ? sess(b, sname)?.self : (sess(b, sname)?.nodes || []).find(x => x.path === p))   // v1.62.0: the flat node list
const agentOf = (b, sname, a) => nodeOf(b, sname, a)
const ctxOf = (b, sname, a, c) => (c === 'root' ? (a ? agentOf(b, sname, a) : sess(b, sname)?.self) : nodeOf(b, sname, a ? `${a}/@${c}` : `@${c}`))

// ---- seeded files: an OLD day (retention) and a recent day with one entry + a garbled final line (startup replay)
fs.mkdirSync(hostDir, { recursive: true })
fs.writeFileSync(path.join(hostDir, '2020-01-01.jsonl'), J({ v: 2, id: 'act_old_x-1', ts: Date.UTC(2020, 0, 1), session: 'Ancient', path: '', text: 'old', state: 'running' }) + '\n')
const seedTs = Date.now() - 20 * 3600000, seedId = `act_seed_${seedTs.toString(36)}-1`, v1Id = `act_v1_${(seedTs - 1000).toString(36)}-1`
fs.writeFileSync(path.join(hostDir, `${day(seedTs)}.jsonl`),
  J({ v: 1, id: v1Id, ts: seedTs - 1000, context: 'root', current: true, text: 'A 1.61-FORMAT LINE', state: 'running', origin: os.hostname(), realm: 'default', session: 'OldFormat', project: 'AIMB', user: 'robin',
    host: os.hostname(), agent: 'legacy', details: 'V1-DETAILS', data: null, new_session: true, new_entity: true, new_context: true, finished_at: null }) + '\n' +   // v1.62.0: a v1 record — skipped
  J({ v: 2, id: seedId, ts: seedTs, path: 'nightly', current: true, text: 'overnight batch {progress}', state: 'running',
  progress: { done: 7, total: 9, unit: 'jobs' }, origin: os.hostname(), realm: 'default', session: 'Yday', project: 'AIMB', user: 'robin', host: os.hostname(),
  details: 'SEEDED-DETAILS', data: null, new_from: 0, finished_at: null }) + '\n{"garbled-final-li')

const all = []
const G = await spawn('LogGw'); all.push(G)
await sleep(600)
const F = await spawn('LogFol'); all.push(F)
await sleep(800)
const roles = [(await call(G, 'my_identity')).role, (await call(F, 'my_identity')).role]
check('harness: one host — a gateway + a FOLLOWER', roles.join('/') === 'gateway/follower', roles.join('/'))
check('harness: bridge version ≥ 1.58.0', (v => v[0] > 1 || (v[0] === 1 && v[1] >= 58))(String((await call(G, 'my_identity')).bridge_version).split('.').map(Number)))   // v1.59.0: ≥, so a later bump doesn't break it

// ---- retention + startup replay of the seeded files
check('retention: a day file older than log_retention_days is deleted at gateway start', !fs.existsSync(path.join(hostDir, '2020-01-01.jsonl')))
const b0 = await until(() => board(G), b => !!agentOf(b, 'Yday', 'nightly'))
check('startup replay: the seeded day file\'s current line is on the board (a garbled final line skipped)', agentOf(b0, 'Yday', 'nightly')?.current?.text === 'overnight batch {progress}'
  && agentOf(b0, 'Yday', 'nightly')?.current?.rendered === 'overnight batch 7 of 9 jobs', J(agentOf(b0, 'Yday', 'nightly')))
const seeded = await call(G, 'activity', { entry: { id: seedId } })
check('startup replay: a replayed current line keeps its details (entry lookup from memory)', seeded.ok && seeded.source === 'memory' && seeded.entry?.details === 'SEEDED-DETAILS', J(seeded))
const v1e = await call(G, 'activity', { entry: { id: v1Id } })
check('startup replay (6a): a 1.61-format (v1) record in the day file is SKIPPED — not on the board, not an entry', !sess(b0, 'OldFormat') && !J(b0).includes('1.61-FORMAT') && v1e.ok === false && v1e.code === 'unknown-entry', J([v1e, b0.map(s => s.session)]))

// ---- log via the gateway's sub-peer AND the follower's (forwarded)
await reg(G, 'Bridget', 'bg', 'AIMB')
await reg(F, 'Ferret', 'fe', 'AIMB')
const l1 = await call(G, 'log', { as: 'Bridget', secret: 'bg', text: '@~root orchestrating spec-70' })
check('log (gateway sub-peer, session-level): the #70 result shape (+ path)', l1.ok === true && typeof l1.id === 'string' && typeof l1.ts === 'number' && l1.agent === null && l1.context === 'root' && l1.path === ''
  && l1.current === true && l1.state === 'running' && typeof l1.stale_at === 'number' && l1.logged === true && l1.session === 'Bridget', J(l1))
const l2 = await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', text: '@~build compiling', progress: '1/4 files', eta: '10m', details: 'FULL-COMPILER-OUTPUT', data: { errors: 0 } })
check('log (FOLLOWER sub-peer): forwarded to the gateway, applied there', l2.ok === true && l2.agent === 'worker' && l2.context === 'build' && l2.path === 'worker/@build' && l2.current === true && l2.session === 'Ferret', J(l2))
check('log: the response carries the inbox hint (an identified caller)', !!l2.inbox && typeof l2.inbox.unread === 'number', J(l2))
const bg = await board(G), bf = await board(F)
check('activity (gateway): both sessions; the follower\'s line is on the gateway\'s board', sess(bg, 'Bridget')?.self?.current?.text === 'orchestrating spec-70' && ctxOf(bg, 'Ferret', 'worker', 'build')?.current?.text === 'compiling', J(bg))
check('activity (follower): forwarded — the same board', J(bf.map(s => s.session)) === J(bg.map(s => s.session)) && ctxOf(bf, 'Ferret', 'worker', 'build')?.progress?.done === 1, J(bf))
let recs = records()
check('JSONL: ONE file per host (both processes\' entries in it), entries carry details/data', fs.readdirSync(path.join(persist, 'activity')).length === 1
  && recs.some(r => r.id === l1.id) && recs.find(r => r.id === l2.id)?.details === 'FULL-COMPILER-OUTPUT' && recs.find(r => r.id === l2.id)?.data?.errors === 0, J(recs.slice(-2)))

// ---- @ vs @~
await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', text: '@build linking (log only)' })
await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', text: '@build oops?', state: 'failed' })
let b = await board(G)
check('@: log only — the current line and state stay', ctxOf(b, 'Ferret', 'worker', 'build')?.current?.text === 'compiling' && ctxOf(b, 'Ferret', 'worker', 'build')?.state === 'running', J(ctxOf(b, 'Ferret', 'worker', 'build')))
await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', text: '@~build waiting on review', state: 'blocked' })
b = await board(G)
check('@~: replaces the current line + sets the state', ctxOf(b, 'Ferret', 'worker', 'build')?.current?.text === 'waiting on review' && ctxOf(b, 'Ferret', 'worker', 'build')?.state === 'blocked')
const lv = await call(G, 'activity', { log: { session: 'Ferret', agent: 'worker' } })
check('activity log: newest first, @ and @~ entries tagged', lv.ok && lv.log?.entries?.length === 4 && lv.log.entries[0].text === 'waiting on review' && lv.log.entries[0].current === true && !lv.log.entries[1].current, J(lv))

// ---- templates + log:false (a progress update that is NOT logged)
await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', text: '@~tiles Seeding {progress} ({pct})', progress: '10/100 tiles' })
const nEntries = records().filter(r => r.id).length
const lf = await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', context: '@tiles', progress: '40/100 tiles', log: false })
b = await board(G)
check('log:false: ok, logged:false', lf.ok === true && lf.logged === false, J(lf))
check('template: the current line renders against the CURRENT bar (moved by log:false)', ctxOf(b, 'Ferret', 'worker', 'tiles')?.current?.rendered === 'Seeding 40 of 100 tiles (40%)'
  && ctxOf(b, 'Ferret', 'worker', 'tiles')?.current?.text === 'Seeding {progress} ({pct})', J(ctxOf(b, 'Ferret', 'worker', 'tiles')))
const lv2 = await call(G, 'activity', { log: { session: 'Ferret', agent: 'worker', context: '@tiles' } })
check('log:false: NOT in the in-memory log; the logged entry renders against ITS recorded bar', lv2.log?.entries?.length === 1 && lv2.log.entries[0].rendered === 'Seeding 10 of 100 tiles (10%)', J(lv2))
check('log:false: NOT written to the JSONL as an entry', records().filter(r => r.id).length === nEntries)

// ---- checkpoints: unchanged-but-alive → ONE cp + ONE rep line whose n grows; a change → a new cp + a fresh rep line
const tilesCps = rs => rs.filter(r => r.kind === 'cp' && r.session === 'Ferret' && r.path === 'worker/@tiles' && r.v === Act.ACTIVITY_FORMAT)
const reps = rs => rs.filter(r => Array.isArray(r.rep))
const repsBefore = reps(records()).length
for (const t0 = Date.now(); Date.now() - t0 < 3200;) { await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', context: '@tiles', progress: '40/100 tiles', log: false }); await sleep(120) }
await sleep(800)
recs = records()
const k1 = tilesCps(recs)
check('cp: the log:false change got ONE cp line (with a per-file key + the bar)', k1.length === 1 && Number.isInteger(k1[0].k) && k1[0].progress?.done === 40 && k1[0].current?.text === 'Seeding {progress} ({pct})', J(k1))
const r1 = reps(recs).slice(repsBefore)
check('rep: the unchanged stream is ONE repeat line (rewritten in place), n counting the intervals', r1.length === 1 && J(r1[0].rep) === J([k1[0]?.k]) && r1[0].n >= 3 && r1[0].last > r1[0].since, J(r1))
check('rep: nothing else was written by the stream (no log entries)', recs.filter(r => r.id).length === nEntries)
await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', context: '@tiles', progress: '41/100 tiles', log: false })
for (const t0 = Date.now(); Date.now() - t0 < 2400;) { await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', context: '@tiles', progress: '41/100 tiles', log: false }); await sleep(120) }
await sleep(800)
recs = records()
const k2 = tilesCps(recs), r2 = reps(recs).slice(repsBefore)
check('cp: a change mid-stream → a new cp (same key, the new bar)', k2.length === 2 && k2[1]?.k === k1[0]?.k && k2[1].progress?.done === 41, J(k2))
check('rep: ... and a FRESH repeat line after it (the first one closed)', r2.length === 2 && r2[0].n === r1[0].n && r2[1].n >= 2, J(r2))
const lastRep = r2[1] ? r2[1].last : -1

// ---- details/data lookups: memory (current line), file via the index, file via the day-file scan (after the copy is gone)
const spec = await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', text: '@~spec drafted', details: 'CURRENT-DETAILS', data: { cur: 1 } })
const cur = await call(G, 'activity', { entry: { id: spec.id } })
check('entry: a CURRENT line comes from memory with its details/data', cur.ok && cur.source === 'memory' && cur.entry?.details === 'CURRENT-DETAILS' && cur.entry?.data?.cur === 1, J(cur))
const old = await call(G, 'activity', { entry: { id: l2.id } })
check('entry: a REPLACED current line (no longer in memory with details) comes from the file', old.ok && old.source === 'file' && old.entry?.details === 'FULL-COMPILER-OUTPUT' && old.entry?.data?.errors === 0, J(old))
const note = await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', text: '@build note with details', details: 'LOGGED-DETAILS', data: { k: 'v' } })
const e1 = await call(F, 'activity', { entry: { id: note.id } })
check('entry: an @ entry\'s details come from the FILE (the index), via the follower too', e1.ok && e1.source === 'file' && e1.via === 'index' && e1.entry?.details === 'LOGGED-DETAILS' && e1.entry?.data?.k === 'v', J(e1))
for (let i = 0; i < 12; i++) await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', text: `@build flood ${i}` })
const gone = await call(G, 'activity', { log: { session: 'Ferret', agent: 'worker', limit: 100 } })
check('harness: log_entries_per_agent=10 dropped the note from memory', gone.log?.entries?.length === 10 && !gone.log.entries.some(e => e.id === note.id) && gone.log.dropped > 0, J(gone.log && gone.log.entries.length))
const e2 = await call(G, 'activity', { entry: { id: note.id } })
check('entry: after the in-memory copy is gone → the day-file scan (index evicted)', e2.ok && e2.source === 'file' && e2.via === 'scan' && e2.entry?.details === 'LOGGED-DETAILS', J(e2))
check('entry: an unknown id → unknown-entry; a cp is never an entry', (await call(G, 'activity', { entry: { id: 'act_nope_zz-1' } })).code === 'unknown-entry')

// ---- session-level log + limits + codes
await call(G, 'log', { as: 'Bridget', secret: 'bg', text: 'spawned 3 agents' })
const sl = await call(G, 'activity', { log: { session: 'Bridget' } })
check('session-level: the session\'s own log (no path = the root\'s subtree)', sl.ok && sl.log?.path === '' && sl.log.entries[0].text === 'spawned 3 agents' && sl.log.entries[1].text === 'orchestrating spec-70', J(sl))
const long = await call(G, 'log', { as: 'Bridget', secret: 'bg', text: 'x'.repeat(300) })
check('limits: text > 240 is truncated with a warning', long.ok && (long.warnings || []).includes('text-truncated'), J(long))
const codes = await Promise.all([
  call(G, 'log', { as: 'Bridget', secret: 'bg', text: `@${'c'.repeat(61)} x` }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', text: 'x', details: 'd'.repeat(4097) }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', text: 'x', data: { s: 'z'.repeat(17000) } }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', agent: 'a/b/c/d/e/f/g', text: 'x' }),
  call(F, 'log', { as: 'Ferret', secret: 'fe', text: 'x', state: 'stale' }),
  call(F, 'log', { as: 'Ferret', secret: 'fe' }),
  call(G, 'log', { text: 'no identity' }),
  call(G, 'log', { as: 'Bridget', secret: 'WRONG', text: 'x' }),
  call(F, 'log', { as: 'Ferret', secret: 'fe', text: 'x', log: 'maybe' }),
])
check('limits/codes: context-too-long, details-too-large, data-too-large, path-too-deep, bad-state, bad-text, as-required, bad-secret, bad-log',
  J(codes.map(c => c.code)) === J(['context-too-long', 'details-too-large', 'data-too-large', 'path-too-deep', 'bad-state', 'bad-text', 'as-required', 'bad-secret', 'bad-log']), J(codes.map(c => c.code)))
const pc = await Promise.all([
  call(G, 'log', { as: 'Bridget', secret: 'bg', path: 'a/@b/@c/d/@e/@f/@g', text: 'x' }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', path: 'a/@~b/@c', text: 'x' }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', path: 'a/@~b', text: '@c x' }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', text: 'x', plan: [] }),
])
check('6a codes: path-too-deep (7 segments), bad-path (@~ mid-path; a prefix after @~); 6b: bad-plan (plan is supported: an empty one is refused)', J(pc.map(c => c.code)) === J(['path-too-deep', 'bad-path', 'bad-path', 'bad-plan']), J(pc.map(c => c.code)))

// ---- 6a: the NODE TREE over the tool — every path form, nested nodes on the board, the subtree's merged log
const forms = [
  ['spec-70', 'spec-70', 'agent'], ['spec-70/research', 'spec-70/research', 'agent'], ['spec-70/@~Tharsis', 'spec-70/@Tharsis', 'context'],
  ['spec-70/@Tharsis/@~z12', 'spec-70/@Tharsis/@z12', 'context'], ['@#70/spec-70', '@#70/spec-70', 'agent'], ['@#70/@step4/spec-70', '@#70/@step4/spec-70', 'agent'],
  ['@~"CTX strip 17"', '@"CTX strip 17"', 'context'],
]
const fr = []
for (const [p] of forms) fr.push(await call(G, 'log', { as: 'Bridget', secret: 'bg', path: p, text: `form ${p}`, progress: '1/4 tiles' }))
let tb = await board(G)
check('tree: every path form logs ok and lands on the board as its node (path, kind)', fr.every(r => r.ok) && forms.every(([, p, k]) => nodeOf(tb, 'Bridget', p)?.kind === k), J([fr.map(r => r.code || r.path), forms.map(([, p]) => nodeOf(tb, 'Bridget', p)?.kind)]))
check('tree: implicit intermediates (@#70, @#70/@step4) + parents/depths', nodeOf(tb, 'Bridget', '@#70')?.implicit === true && nodeOf(tb, 'Bridget', '@#70/@step4/spec-70')?.parent === '@#70/@step4'
  && nodeOf(tb, 'Bridget', '@#70/@step4/spec-70')?.depth === 3, J(nodeOf(tb, 'Bridget', '@#70/@step4/spec-70')))
check('tree: the @~ forms set the current line; the others only log', nodeOf(tb, 'Bridget', 'spec-70/@Tharsis/@z12')?.current?.text === 'form spec-70/@Tharsis/@~z12' && !nodeOf(tb, 'Bridget', 'spec-70/research')?.current)
check('tree: rollup recurses (spec-70 = the sum of its own reported bar? no — it reported its own: 1/4; @#70 = its descendants\' sum)', nodeOf(tb, 'Bridget', 'spec-70')?.progress?.rollup === false
  && nodeOf(tb, 'Bridget', '@#70')?.progress?.done === 2 && nodeOf(tb, 'Bridget', '@#70')?.progress?.total === 8 && nodeOf(tb, 'Bridget', '@#70')?.progress?.rollup === true, J(nodeOf(tb, 'Bridget', '@#70')))
const old1 = await call(G, 'log', { as: 'Bridget', secret: 'bg', agent: 'spec-70', text: '@~Tharsis old notation line' })
tb = await board(G)
check('tree: the OLD notation (agent + @~Ctx) is the same node as the path form', old1.ok && old1.path === 'spec-70/@Tharsis' && nodeOf(tb, 'Bridget', 'spec-70/@Tharsis')?.current?.text === 'old notation line', J(old1))
const sub = await call(G, 'activity', { log: { session: 'Bridget', path: 'spec-70', limit: 50 } })
check('tree: a node\'s log = its SUBTREE merged, newest first, each entry with its path + rel', sub.ok && sub.log?.entries?.length === 5 && sub.log.entries[0].text === 'old notation line' && sub.log.entries[0].rel === '@Tharsis'
  && sub.log.entries.some(e => e.path === 'spec-70/@Tharsis/@z12' && e.rel === '@Tharsis/@z12') && sub.log.entries.some(e => e.path === 'spec-70/research'), J(sub.log?.entries?.map(e => [e.rel, e.text])))
check('tree: own:true = the node\'s own entries only; the path filter on the board keeps the subtree', (await call(G, 'activity', { log: { session: 'Bridget', path: 'spec-70', own: true } })).log?.entries?.length === 1
  && (await call(G, 'activity', { session: 'Bridget', path: 'spec-70' })).sessions?.[0]?.nodes?.length === 4)

// ---- 6a: BATCH via the tool — order, per-item results + refs, partial failure, bounds; a follower's batch is ONE frame
const bt = await call(G, 'log', { as: 'Bridget', secret: 'bg', path: 'batcher', items: [
  { ref: 'a', text: '@~step one', progress: '1/3' }, { ref: 'b', text: '@~step two', state: 'nope' }, { ref: 'c', text: '@~step three', progress: '3/3' }, { ref: 'd', path: 'x/@~y', text: 'relative to the default' }, { ref: 'e', path: '/x/@~y', text: 'absolute: no default for this one' }] })
tb = await board(G)
check('batch: { ok, results:[…] } one per item in order, refs echoed; a bad item fails alone (applied 4, failed 1); 6b: an item path is RELATIVE to the default path, "/…" absolute', bt.ok === true && J((bt.results || []).map(r => [r.ref, r.ok, r.code || r.path])) === J([['a', true, 'batcher/@step'], ['b', false, 'bad-state'], ['c', true, 'batcher/@step'], ['d', true, 'batcher/x/@y'], ['e', true, 'x/@y']]) && bt.applied === 4 && bt.failed === 1, J(bt))
check('batch: applied in order — the last good line + bar win; 6b: a relative item path nests under the default, an absolute one does not', nodeOf(tb, 'Bridget', 'batcher/@step')?.current?.text === 'three' && nodeOf(tb, 'Bridget', 'batcher/@step')?.progress?.done === 3 && nodeOf(tb, 'Bridget', 'batcher/x/@y')?.current?.text === 'relative to the default' && nodeOf(tb, 'Bridget', 'x/@y')?.current?.text === 'absolute: no default for this one')
const bb = await Promise.all([
  call(G, 'log', { as: 'Bridget', secret: 'bg', items: Array.from({ length: 65 }, (_, i) => ({ text: `x${i}` })) }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', items: Array.from({ length: 20 }, () => ({ text: 'x', details: 'd'.repeat(4000) })) }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', items: [] }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', items: [{ text: 'x' }], text: 'top-level text' }),
])
check('batch bounds: 65 items → too-many-items, > 64 KB → batch-too-large, empty / mixed → bad-batch (the WHOLE call, nothing applied)', J(bb.map(r => r.code)) === J(['too-many-items', 'batch-too-large', 'bad-batch', 'bad-batch'])
  && !(await board(G)).some(s => (s.nodes || []).some(n => /^x\d+$/.test(n.current?.text || ''))), J(bb.map(r => r.code)))
const tapBefore = ((await call(G, 'activity', { tap: true, session: '-none-' })).tap?.recv || []).filter(x => x.kind === 'fwd' && x.op === 'log').length
const fb2 = await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'fbatch', items: Array.from({ length: 10 }, (_, i) => ({ ref: i, text: `@~n${i % 3} line ${i}` })) })
const fwd = ((await call(G, 'activity', { tap: true, session: '-none-' })).tap?.recv || []).filter(x => x.kind === 'fwd' && x.op === 'log')
check('batch (FOLLOWER): 10 items forwarded in ONE ACTIVITY frame, applied in order on the gateway', fb2.ok && fb2.results?.length === 10 && fb2.results.every((r, i) => r.ok && r.ref === i) && fwd.length === tapBefore + 1 && fwd.at(-1).items === 10
  && ctxOf(await board(G), 'Ferret', 'fbatch', 'n0')?.current?.text === 'line 9', J([fb2.results?.length, fwd.slice(-2)]))
const dflt = await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', context: '@~eta', eta: '90m' })
b = await board(G)
check('default text: an ETA-only message is the line "{eta}", rendered relative', dflt.ok && ctxOf(b, 'Ferret', 'worker', 'eta')?.current?.text === '{eta}' && /^~1h 2\dm$|^~1h 30m$/.test(ctxOf(b, 'Ferret', 'worker', 'eta')?.current?.rendered || ''), J(ctxOf(b, 'Ferret', 'worker', 'eta')))

// ---- stale (via the per-message stale_after override)
await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'sleepy', text: '@~root downloading', stale_after: '1s' })
check('stale: running inside its stale_after window', agentOf(await board(G), 'Ferret', 'sleepy')?.state === 'running')
await sleep(1600)
const sa = agentOf(await board(G), 'Ferret', 'sleepy')
check('stale: quiet past stale_after → stale, was running', sa?.state === 'stale' && sa?.was === 'running', J(sa))
check('activity: filters (agent / path, active_only, project)', (await call(G, 'activity', { agent: 'sleepy' })).sessions?.length === 1 && (await call(G, 'activity', { path: 'sleepy' })).sessions?.length === 1 && (await call(G, 'activity', { project: 'nope' })).sessions?.length === 0)

// ---- a frame from an unauthenticated / unregistered connection applies nothing
function rawFrames(frames) {
  return new Promise(resolve => {
    const sock = net.connect(Number(PORT), '127.0.0.1'), got = []
    let buf = Buffer.alloc(0)
    const send = o => { const body = Buffer.from(J(o)); const h = Buffer.alloc(4); h.writeUInt32BE(body.length); sock.write(Buffer.concat([h, body])) }
    sock.on('connect', () => { for (const f of frames) send(f) })
    sock.on('data', d => { buf = Buffer.concat([buf, d]); while (buf.length >= 4) { const n = buf.readUInt32BE(0); if (buf.length < 4 + n) break; try { got.push(JSON.parse(buf.subarray(4, 4 + n).toString())) } catch { } buf = buf.subarray(4 + n) } })
    sock.on('error', () => { })
    setTimeout(() => { try { sock.destroy() } catch { } resolve(got) }, 700)
  })
}
const forged = { t: 'ACTIVITY', session: 'FAKE/abcd', rid: 'r1', op: 'log', ident: { realm: 'default', project: 'AIMB', user: 'robin', session: 'Bridget' }, input: { text: 'FORGED-LINE' } }
const noHello = await rawFrames([forged])
const helloOnly = await rawFrames([{ t: 'HELLO', ver: 1, fromBridge: 'FAKE/abcd', fromSession: 'FAKE/abcd', name: 'x', auth: TOKEN }, forged])
check('frames: ACTIVITY without HELLO / from an unregistered connection → unauthorized', noHello[0]?.result?.code === 'unauthorized' && helloOnly[0]?.result?.code === 'unauthorized', J([noHello, helloOnly]))
check('frames: ... and nothing was applied', !J(await call(G, 'activity', { log: { session: 'Bridget' } })).includes('FORGED-LINE') && !records().some(r => r.text === 'FORGED-LINE'))

// ---- gone on deregister (a FOLLOWER's sub-peer leaves; the gateway sweeps), cleared when it returns
const fer = await reg(F, 'Ferret', 'fe', 'AIMB')
await call(F, 'deregister', { peer_id: fer.peer_id, secret: 'fe' })
const gb = await until(() => board(G), x => agentOf(x, 'Ferret', 'worker')?.state === 'gone')
check('gone: the session deregistered → its agents show gone', agentOf(gb, 'Ferret', 'worker')?.state === 'gone' && !!sess(gb, 'Ferret')?.gone_at, J(agentOf(gb, 'Ferret', 'worker')))
await reg(F, 'Ferret', 'fe', 'AIMB')
const gb2 = await until(() => board(G), x => agentOf(x, 'Ferret', 'worker')?.state !== 'gone')
check('gone: cleared when the session comes back', agentOf(gb2, 'Ferret', 'worker')?.state === 'blocked' || agentOf(gb2, 'Ferret', 'worker')?.state === 'running', J(agentOf(gb2, 'Ferret', 'worker')))

// ---- enabled:false (a separate bridge with AI_BRIDGE_ACTIVITY_ENABLED=0)
const D = await spawn('LogOff', OFF_PORT, { AI_BRIDGE_ACTIVITY_ENABLED: '0', AI_BRIDGE_PERSISTENCE: 'none' }); all.push(D)
await sleep(600)
await reg(D, 'Off', 'off', 'AIMB')
const off1 = await call(D, 'log', { as: 'Off', secret: 'off', text: 'hello' }), off2 = await call(D, 'activity')
check('enabled:false: log and activity return activity-disabled', off1.code === 'activity-disabled' && off2.code === 'activity-disabled', J([off1, off2]))

// ---- 6b (v1.63.0): TODOS AND PLANS over the tool — gateway + follower, ticks, re-plan, codes, a batch item's plan, the JSONL
const pl = await call(G, 'log', { as: 'Bridget', secret: 'bg', path: '@#71', plan: ['Spec', 'Build', 'Test', 'Ship'] })
check('6b plan (tool): plan:[…] creates ☐ items under the target in the GIVEN order; result.plan names each', pl.ok && J((pl.plan || []).map(p => [p.name, p.path, p.created, p.plan_item, p.state])) === J([['Spec', '@#71/@Spec', true, true, 'todo'], ['Build', '@#71/@Build', true, true, 'todo'], ['Test', '@#71/@Test', true, true, 'todo'], ['Ship', '@#71/@Ship', true, true, 'todo']]), J(pl))
const pt1 = await call(G, 'log', { as: 'Bridget', secret: 'bg', path: '@#71/@~Spec', state: 'done' })
const pt2 = await call(G, 'log', { as: 'Bridget', secret: 'bg', path: '@#71/@~Build', text: 'compiling' })
const pt3 = await call(G, 'log', { as: 'Bridget', secret: 'bg', path: '@#71/@~Test', state: 'skipped' })
const rpl = await call(G, 'log', { as: 'Bridget', secret: 'bg', path: '@#71', plan: ['Build', 'Docs'] })
check('6b tick (tool): "@~…/@Spec" + state done needs no text; a line starts an item; skipped; re-plan keeps Build as it is and adds Docs at the end', pt1.ok && pt1.state === 'done' && pt2.ok && pt2.state === 'running' && pt3.ok && pt3.state === 'skipped'
  && rpl.ok && J(rpl.plan.map(p => [p.name, !!p.created, p.state])) === J([['Build', false, 'running'], ['Docs', true, 'todo']]), J([pt1, pt2, pt3, rpl]))
const fpl = await call(F, 'log', { as: 'Ferret', secret: 'fe', path: 'rel', text: '@~root planning the release', plan: ['lint', 'pack'] })
check('6b plan (FOLLOWER): forwarded with its text — the agent\'s own line + 2 items under it', fpl.ok && fpl.path === 'rel' && fpl.logged === true && J(fpl.plan.map(p => p.path)) === J(['rel/@lint', 'rel/@pack']), J(fpl))
const pc6 = await Promise.all([
  call(G, 'log', { as: 'Bridget', secret: 'bg', path: 'spec-70/@~root', text: 'x', state: 'todo' }),
  call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', text: '@~build x', state: 'skipped' }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', path: '@#71', plan: ['a/b'] }),
  call(G, 'log', { as: 'Bridget', secret: 'bg', path: '@#71/@Ship', state: 'done' }),
])
check('6b codes: bad-agent-state (an agent can\'t be todo), not-a-plan-item (skipped on an ordinary context), bad-plan, bad-text (a state without @~ and without text)', J(pc6.map(c => c.code)) === J(['bad-agent-state', 'not-a-plan-item', 'bad-plan', 'bad-text']), J(pc6.map(c => c.code)))
const pbt = await call(G, 'log', { as: 'Bridget', secret: 'bg', path: '@#72', items: [{ ref: 'p', plan: ['a', 'b'] }, { ref: 't', path: '@~a', state: 'done' }] })
check('6b batch: an item may carry a plan; item paths are relative to the batch path', pbt.ok && pbt.applied === 2 && J(pbt.results.map(r => [r.ref, r.ok])) === J([['p', true], ['t', true]]) && pbt.results[1].path === '@#72/@a', J(pbt))
await call(G, 'log', { as: 'Bridget', secret: 'bg', path: '@#73', plan: ['slow'] })
await call(G, 'log', { as: 'Bridget', secret: 'bg', path: '@#73/@~slow', text: 'quiet for a while', stale_after: '1s' })
await sleep(1500)
let pb = await board(G)
check('6b board: plan items (plan_item, plan_ix, their own states) + the "N of M done" bar (#79: skipped stays in M, as its own part: 1 of 5 · 1 skipped)', J(['Spec', 'Build', 'Test', 'Ship', 'Docs'].map(n => [nodeOf(pb, 'Bridget', `@#71/@${n}`)?.state, nodeOf(pb, 'Bridget', `@#71/@${n}`)?.plan_item])) === J([['done', true], ['running', true], ['skipped', true], ['todo', true], ['todo', true]])
  && nodeOf(pb, 'Bridget', '@#71/@Docs')?.plan_ix === 1 && (b => b && b.todos && b.done === 1 && b.total === 5 && b.skipped === 1)(nodeOf(pb, 'Bridget', '@#71')?.progress) && nodeOf(pb, 'Bridget', '@#72/@a')?.state === 'done', J(nodeOf(pb, 'Bridget', '@#71')))
check('6b stale: a plan item never goes stale (quiet past its stale_after: still running)', nodeOf(pb, 'Bridget', '@#73/@slow')?.state === 'running' && !nodeOf(pb, 'Bridget', '@#73/@slow')?.stale_at, J(nodeOf(pb, 'Bridget', '@#73/@slow')))
const prec = records().filter(r => r.session === 'Bridget' && String(r.path).startsWith('@#71/'))
check('6b JSONL: v4 entries — one ☐ creation record per item (plan_item, plan_ix) and each tick, in order', prec.filter(r => r.state === 'todo' && r.plan_item).map(r => r.path).join() === '@#71/@Spec,@#71/@Build,@#71/@Test,@#71/@Ship,@#71/@Docs'
  && prec.find(r => r.id === pt1.id)?.plan_item === true && prec.find(r => r.id === pt1.id)?.text === 'Spec' && prec.every(r => r.v === Act.ACTIVITY_FORMAT), J(prec.map(r => [r.path, r.state, r.plan_ix])))
const beforePlanKill = { b: J(['Spec', 'Build', 'Test', 'Ship', 'Docs'].map(n => [nodeOf(pb, 'Bridget', `@#71/@${n}`)?.state, nodeOf(pb, 'Bridget', `@#71/@${n}`)?.created_at, nodeOf(pb, 'Bridget', `@#71/@${n}`)?.plan_ix])) }

// ---- restart replay #1: kill the GATEWAY → the follower takes over and replays the host's files
const beforeKill = await board(G)
await G.transport.close(); all.splice(all.indexOf(G), 1)
const fb = await until(async () => (await call(F, 'my_identity')).role === 'gateway' ? board(F) : [], x => !!ctxOf(x, 'Ferret', 'worker', 'tiles'), 10000)
check('restart: the follower is the gateway now', (await call(F, 'my_identity')).role === 'gateway')
check('restart: current lines come back from the files (gateway-sub-peer + follower-sub-peer sessions)', sess(fb, 'Bridget')?.self?.current?.text === 'orchestrating spec-70'
  && ctxOf(fb, 'Ferret', 'worker', 'build')?.current?.text === 'waiting on review' && ctxOf(fb, 'Ferret', 'worker', 'build')?.state !== 'stale', J(sess(fb, 'Ferret')))
const tl = ctxOf(fb, 'Ferret', 'worker', 'tiles')
check('restart: the log:false bar survives (from the checkpoint) and the template renders against it', tl?.progress?.done === 41 && tl?.current?.rendered === 'Seeding 41 of 100 tiles (41%)', J(tl))
check('restart: last_activity comes from the rep line (not stale; later than its cp)', tl?.last_activity === lastRep && tl?.last_activity > (k2[1] ? k2[1].ts : Infinity) && tl?.state === 'running', J([tl && tl.last_activity, lastRep, k2[1] && k2[1].ts]))
check('restart: the in-memory history is back (chronological, capped)', (await call(F, 'activity', { log: { session: 'Ferret', agent: 'worker', limit: 100 } })).log?.entries?.length === 10)
check('restart: the board matches the one before the kill (sessions)', J((await board(F)).map(s => s.session)) === J(beforeKill.map(s => s.session)))
const rb2 = await board(F)
check('restart (6a): the nested nodes come back from the files — paths, kinds, current lines, implicit intermediates', nodeOf(rb2, 'Bridget', 'spec-70/@Tharsis/@z12')?.current?.text === 'form spec-70/@Tharsis/@~z12'
  && nodeOf(rb2, 'Bridget', '@#70/@step4/spec-70')?.kind === 'agent' && nodeOf(rb2, 'Bridget', '@#70')?.implicit === true && nodeOf(rb2, 'Bridget', 'batcher/@step')?.current?.text === 'three'
  && J(rb2.find(s => s.session === 'Bridget').nodes.map(n => n.path)) === J(beforeKill.find(s => s.session === 'Bridget').nodes.map(n => n.path)), J(rb2.find(s => s.session === 'Bridget')?.nodes?.map(n => n.path)))
const rsub = await call(F, 'activity', { log: { session: 'Bridget', path: 'spec-70', limit: 50 } })
check('restart (6a): the subtree log is back (merged from the nodes\' replayed logs)', rsub.log?.entries?.length === 5 && rsub.log.entries[0].text === 'old notation line', J(rsub.log?.entries?.map(e => e.text)))
const rpb = await board(F)
check('6b restart: the plans come back from the files — every item a plan item with its state, created_at and plan position (so its given order)', J(['Spec', 'Build', 'Test', 'Ship', 'Docs'].map(n => [nodeOf(rpb, 'Bridget', `@#71/@${n}`)?.state, nodeOf(rpb, 'Bridget', `@#71/@${n}`)?.created_at, nodeOf(rpb, 'Bridget', `@#71/@${n}`)?.plan_ix])) === beforePlanKill.b
  && ['Spec', 'Build', 'Test', 'Ship', 'Docs'].every(n => nodeOf(rpb, 'Bridget', `@#71/@${n}`)?.plan_item === true) && nodeOf(rpb, 'Ferret', 'rel/@pack')?.plan_item === true && (b => b && b.todos && b.done === 1)(nodeOf(rpb, 'Bridget', '@#71')?.progress), J([beforePlanKill.b, (rpb.find(s => s.session === 'Bridget')?.nodes || []).filter(n => n.path.startsWith('@#71')).map(n => [n.path, n.state, n.plan_item])]))
const e3 = await call(F, 'activity', { entry: { id: note.id } })
check('restart: entry details still come from the file', e3.ok && e3.source === 'file' && e3.entry?.details === 'LOGGED-DETAILS', J(e3))
await reg(F, 'Ferret', 'fe', 'AIMB')
const after = await call(F, 'log', { as: 'Ferret', secret: 'fe', agent: 'worker', text: '@~build resumed after the restart', state: 'running' })
check('restart: the new gateway logs into the SAME host file', after.ok && fs.readdirSync(path.join(persist, 'activity')).length === 1 && records().some(r => r.id === after.id), J(after))

// ---- restart replay #2: the old gateway comes back as a follower (forwards), then a fresh gateway replays alone
const G2 = await spawn('LogGw2'); all.push(G2)
await sleep(800)
await reg(G2, 'Bridget', 'bg', 'AIMB')
const viaG2 = await call(G2, 'log', { as: 'Bridget', secret: 'bg', text: '@~root back, as a follower' })
check('restart: the restarted bridge is a follower and forwards', (await call(G2, 'my_identity')).role === 'follower' && viaG2.ok && sess(await board(G2), 'Bridget')?.self?.current?.text === 'back, as a follower', J(viaG2))
await F.transport.close(); all.splice(all.indexOf(F), 1)
const g2b = await until(async () => (await call(G2, 'my_identity')).role === 'gateway' ? board(G2) : [], x => !!ctxOf(x, 'Ferret', 'worker', 'build'), 10000)
check('restart #2: a fresh gateway replays everything both earlier gateways wrote', ctxOf(g2b, 'Ferret', 'worker', 'build')?.current?.text === 'resumed after the restart'
  && sess(g2b, 'Bridget')?.self?.current?.text === 'back, as a follower' && agentOf(g2b, 'Yday', 'nightly')?.current?.text === 'overnight batch {progress}', J(g2b.map(s => [s.session, s.self && s.self.current && s.self.current.text])))

console.log(`\n${pass} passed, ${fail} failed`)
for (const b2 of all) { try { await b2.transport.close() } catch { } }
await sleep(400)
for (const d of [persist, cfgDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
process.exit(fail ? 1 : 0)
