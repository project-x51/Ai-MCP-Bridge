// #70 step 2 (v1.58.0), ported to the 2.0 board in #88 build step 9 — the `log` + `activity` tools on ONE host, the
// gateway-owned 2.0 store (lib/activity2-store.js over lib/activity2.js) and the host's v6 day files (docs/spec-88.md §2,
// §3, §4.0 – §4.2, §5.1 – §5.3). One host: a GATEWAY (G) and a FOLLOWER (F) on the same port (F loses the bind and follows),
// one temp persist dir, a fixed test host name (AI_BRIDGE_TEST_HOSTNAME), a temp AI_BRIDGE_CONFIG (never src/config.json)
// with activity.log_entries_per_agent = 10, and a 700 ms checkpoint interval. Ports 13950-13951 (+ 13960-13961 for the
// disabled bridge), moved into this file's port block (#81).
// Covers, in 2.0 forms: the SEEDED history is v6, written THROUGH a 2.0 gateway whose clock is 20 h back (a 2.0 gateway
// refuses v5 history), plus a planted old day file (retention, with its index file), a v5 record and a garbled final line
// (both skipped by the startup replay); log via a gateway sub-peer AND a follower sub-peer (forwarded; one directory per
// host); the §4.0 TEXT RULE (plain text only logs, a leading "@" also sets the line, a state change keeps the line's text —
// Q33); text templates rendered against the current bar (entry lookup) and against an entry's recorded bar (log pages);
// log:false (board only — no entry in the files); cp + rep lines (one cp + ONE rep whose n grows; a change → new cp + a
// fresh rep); details/data lookups (memory for a current line, the day file otherwise, via the follower too; past the
// per-node cap the log pages through the files by cursor); the session root's log; limits and codes (incl. the 2.0
// refusals: label-required, depth, legacy-form); the NODE TREE (agents by key chain, paths below an agent, implicit
// intermediates, a path through an agent's key, rollup bars, a subtree's merged log, own:true); BATCHES via the tool
// (order, per-item results + refs, partial failure, bounds, a follower's batch forwarded in ONE frame — the gateway's
// test tap counts it); an ETA-only report; stale via stale_after; unauthenticated frames; enabled:false; PLANS (items,
// ticks, re-plan, codes, a batch item's plan, a plan item never stale, node records in the files); and restart replay
// (kill the gateway: the follower takes over and its board comes back from the files — node ids, the log:false bar from
// the checkpoint, last_activity from the rep line; then a fresh gateway does it again).
// Retired in step 9 with 1.7x: the v1 / v2 seeded day files (2.0 seeds through a gateway), the `@~` / `@ctx` text and path
// forms (now refused legacy-form), batch item paths relative to a batch path, the entry lookup's `via: index | scan`
// (2.0 reads the day file its id's time names), the board's agent / path / active_only filters, and gone-on-deregister
// (syncActivityGone is 1.7x — not wired to the 2.0 board).
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
import * as Files from '../../lib/activity2-files.js'
const tp = testPorts(import.meta.url, 13950)   // #81: this file's historical ports, moved into its own port block
const SRCDIR = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE = process.env.AIMB_TEST_BRIDGE || 'bridge.mjs'
const TOKEN = 'logtesttok', PORT = String(tp(13950)), OFF_PORT = String(tp(13960)), HOST = 'LOGTEST-HOST'
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-log-'))
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-logcfg-'))
const cfgFile = path.join(cfgDir, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ activity: { log_entries_per_agent: 10 } }))
const hostDir = Files.hostDir(persist, HOST)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
const day = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const ID_RE = /^[a-z2-7]{16}$/

function spawn(name, port = PORT, extra = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [SRCDIR + BRIDGE], cwd: SRCDIR,
    env: { ...process.env, AI_BRIDGE_CONFIG: cfgFile, AI_BRIDGE_NAME: name, AI_BRIDGE_PORT: port, AI_BRIDGE_WS_PORT: String(Number(port) + 1),
      AI_BRIDGE_TOKEN: TOKEN, AI_BRIDGE_BIND: '127.0.0.1', AI_BRIDGE_ADVERTISE_HOST: '127.0.0.1', AI_BRIDGE_USER: 'robin', AI_BRIDGE_TEST_HOSTNAME: HOST,
      AI_BRIDGE_PERSISTENCE: 'file', AI_BRIDGE_PERSIST_DIR: persist, AI_BRIDGE_DISCOVERY: 'none',
      AI_BRIDGE_ACTIVITY_CHECKPOINT_MS: '700', AI_BRIDGE_TEST_ACTIVITY_TAP: '1', ...extra }, stderr: 'pipe' })
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
  let files = []; try { files = fs.readdirSync(hostDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() } catch { }
  for (const f of files) for (const line of fs.readFileSync(path.join(hostDir, f), 'utf8').split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)) } catch { } }
  return out
}
const isEntry = r => r && r.v === 6 && r.kind == null && !Array.isArray(r.rep) && typeof r.id === 'string'
const board = async h => (await call(h, 'activity')).sessions || []
const sess = (b, name) => b.find(s => s.session === name)
const nodeOf = (b, sname, p) => (sess(b, sname)?.nodes || []).find(x => x.path === p)   // 2.0: display paths (labels, no "@"); '' = the session root
const page = (h, q) => call(h, 'activity', { log: q })

const all = []
try {
  // ---- SEEDED history, v6, written through a 2.0 gateway whose clock is 20 h back (a 2.0 gateway refuses v5 history)
  const S = await spawn('LogSeed', PORT, { AI_BRIDGE_TEST_ACTIVITY_CLOCK_OFFSET_MS: String(-20 * 3600000) }); all.push(S)
  await sleep(600)
  await reg(S, 'Yday', 'yd', 'AIMB')
  const seed = await call(S, 'log', { as: 'Yday', secret: 'yd', agent: 'nightly', label: 'Nightly', text: '@overnight batch {progress}', progress: '7/9 jobs', details: 'SEEDED-DETAILS' })
  check('harness: the seed gateway (clock 20 h back) wrote v6 history through the log tool', seed.ok === true && ID_RE.test(seed.node?.id || '') && fs.existsSync(path.join(hostDir, 'format.json')), J(seed))
  await S.transport.close(); all.splice(all.indexOf(S), 1)
  await sleep(800)
  const seedId = seed.id, seedTs = seed.ts || Date.now() - 20 * 3600000, v5Id = `act_v5_${(seedTs - 1000).toString(36)}-1`
  const seedFile = path.join(hostDir, `${day(seedTs)}.jsonl`)
  fs.appendFileSync(seedFile, J({ v: 5, id: v5Id, ts: seedTs - 1000, path: 'legacy', current: true, text: 'A 1.7x-FORMAT LINE', state: 'running', origin: HOST, realm: 'default', session: 'OldFormat', project: 'AIMB', user: 'robin',
    host: HOST, details: 'V5-DETAILS', data: null, new_from: 0, finished_at: null }) + '\n{"garbled-final-li')   // a v5 record + a garbled final line: both skipped
  fs.writeFileSync(path.join(hostDir, '2020-01-01.jsonl'), J({ v: 6, id: 'act_old_x-1', ts: Date.UTC(2020, 0, 1), n: seed.node.id, type: 'note', current: false, text: 'old', state: 'running', at: 'Nightly',
    realm: 'default', session: 'Ancient', project: 'AIMB', user: 'robin', host: HOST, origin: HOST, details: null, data: null }) + '\n')
  fs.writeFileSync(path.join(hostDir, '2020-01-01.idx.json'), J({ v: 1, day: '2020-01-01', size: 1, nodes: {}, struct: [] }))

  const G = await spawn('LogGw'); all.push(G)
  await sleep(600)
  const F = await spawn('LogFol'); all.push(F)
  await sleep(800)
  const roles = [(await call(G, 'my_identity')).role, (await call(F, 'my_identity')).role]
  check('harness: one host — a gateway + a FOLLOWER', roles.join('/') === 'gateway/follower', roles.join('/'))
  check('harness: the board is the 2.0 board (format 6)', (await call(G, 'activity', { session: '-none-' })).format === 6)

  // ---- retention + startup replay of the seeded files
  check('retention: a day file older than log_retention_days is deleted at gateway start — with its index file', !fs.existsSync(path.join(hostDir, '2020-01-01.jsonl')) && !fs.existsSync(path.join(hostDir, '2020-01-01.idx.json')))
  const b0 = await until(() => board(G), b => !!nodeOf(b, 'Yday', 'Nightly'))
  const night = nodeOf(b0, 'Yday', 'Nightly')
  check('startup replay: the seeded day file\'s line is on the board — same node id, the template and its bar (a garbled final line skipped)', night?.id === seed.node.id && night?.kind === 'agent' && night?.current?.text === 'overnight batch {progress}' && night?.progress?.done === 7, J(night))
  const seeded = await call(G, 'activity', { entry: { id: seedId } })
  check('startup replay: a replayed current line keeps its details (entry lookup from memory) and renders against its bar', seeded.ok && seeded.source === 'memory' && seeded.entry?.details === 'SEEDED-DETAILS' && seeded.entry?.rendered === 'overnight batch 7 of 9 jobs', J(seeded))
  const v5e = await call(G, 'activity', { entry: { id: v5Id } })
  check('startup replay: a v5 (1.7x) record in a day file is SKIPPED — not on the board, not an entry', !sess(b0, 'OldFormat') && !J(b0).includes('1.7x-FORMAT') && v5e.ok === false && v5e.code === 'unknown-entry', J([v5e, b0.map(s => s.session)]))

  // ---- log via the gateway's sub-peer AND the follower's (forwarded)
  await reg(G, 'Bridget', 'bg', 'AIMB')
  await reg(F, 'Ferret', 'fe', 'AIMB')
  const lgB = (input, h = G) => call(h, 'log', { as: 'Bridget', secret: 'bg', ...input })
  const lgF = input => call(F, 'log', { as: 'Ferret', secret: 'fe', ...input })
  const l1 = await lgB({ text: '@orchestrating spec-70' })
  check('log (gateway sub-peer, the session root): the 2.0 result shape — entry id, node { id, key, path, kind }, line', l1.ok === true && typeof l1.id === 'string' && typeof l1.ts === 'number' && ID_RE.test(l1.node?.id || '') && l1.node?.kind === 'session'
    && l1.node?.path === '' && l1.current === true && l1.line === true && l1.state === 'running' && typeof l1.stale_at === 'number' && l1.logged === true && l1.session === 'Bridget', J(l1))
  const w0 = await lgF({ agent: 'worker', label: 'Worker' })
  const l2 = await lgF({ agent: 'worker', key: 'build', label: 'Build', text: '@compiling', progress: '1/4 files', eta: '10m', details: 'FULL-COMPILER-OUTPUT', data: { errors: 0 } })
  check('log (FOLLOWER sub-peer): forwarded to the gateway, applied there — the agent made first (label), then its context by key', w0.ok && w0.node?.kind === 'agent' && w0.logged === false && l2.ok === true && l2.node?.key === 'build' && l2.node?.path === 'Worker/Build'
    && l2.node?.kind === 'context' && l2.node?.created === true && l2.agent?.key === 'worker' && l2.current === true && l2.line === true && l2.session === 'Ferret', J([w0, l2]))
  check('log: the response carries the inbox hint (an identified caller)', !!l2.inbox && typeof l2.inbox.unread === 'number', J(l2))
  const bg = await board(G), bf = await board(F)
  check('activity (gateway): both sessions; the follower\'s line is on the gateway\'s board', nodeOf(bg, 'Bridget', '')?.current?.text === 'orchestrating spec-70' && nodeOf(bg, 'Ferret', 'Worker/Build')?.current?.text === 'compiling', J(bg))
  check('activity (follower): forwarded — the same board', J(bf.map(s => s.session)) === J(bg.map(s => s.session)) && nodeOf(bf, 'Ferret', 'Worker/Build')?.progress?.done === 1, J(bf))
  let recs = records()
  const e2rec = recs.find(r => r.id === l2.id)
  check('day files: ONE directory per host (both processes\' entries in it), v6 entries by node id carrying at + details/data', fs.readdirSync(path.join(persist, 'activity')).filter(n => fs.statSync(path.join(persist, 'activity', n)).isDirectory()).length === 1
    && recs.some(r => r.id === l1.id && r.n === l1.node.id) && e2rec?.v === 6 && e2rec?.n === l2.node.id && e2rec?.at === 'Worker/Build' && e2rec?.details === 'FULL-COMPILER-OUTPUT' && e2rec?.data?.errors === 0, J([fs.readdirSync(path.join(persist, 'activity')), e2rec]))

  // ---- the TEXT RULE (§4.0): plain text only logs; a leading "@" also sets the line; a state change keeps the line's text (Q33)
  const pl1 = await lgF({ agent: 'worker', key: 'build', text: 'linking (log only)' })
  let b = await board(G)
  check('text: plain text only LOGS — the line and state stay (line:false, current:false)', pl1.ok && pl1.line === false && pl1.current === false && pl1.logged === true && nodeOf(b, 'Ferret', 'Worker/Build')?.current?.text === 'compiling' && nodeOf(b, 'Ferret', 'Worker/Build')?.state === 'running', J([pl1, nodeOf(b, 'Ferret', 'Worker/Build')]))
  const pl2 = await lgF({ agent: 'worker', key: 'build', text: 'oops?', state: 'failed' })
  b = await board(G)
  check('text (Q33): a state with plain text changes the STATE, keeps the line\'s text (line:false, current:true)', pl2.ok && pl2.line === false && pl2.current === true && nodeOf(b, 'Ferret', 'Worker/Build')?.current?.text === 'compiling' && nodeOf(b, 'Ferret', 'Worker/Build')?.state === 'failed', J([pl2, nodeOf(b, 'Ferret', 'Worker/Build')]))
  await lgF({ agent: 'worker', key: 'build', text: '@waiting on review', state: 'blocked' })
  b = await board(G)
  check('text: a leading "@" replaces the line + sets the state', nodeOf(b, 'Ferret', 'Worker/Build')?.current?.text === 'waiting on review' && nodeOf(b, 'Ferret', 'Worker/Build')?.state === 'blocked')
  const at2 = await lgF({ agent: 'worker', key: 'atlit', label: 'At', text: '@@home is logged, not a line' })
  check('text: "@@" is a literal "@" (logs "@home …", sets no line)', at2.ok && at2.line === false && nodeOf(await board(G), 'Ferret', 'Worker/At')?.current == null && records().find(r => r.id === at2.id)?.text === '@home is logged, not a line', J(at2))
  const lv = await page(G, { session: 'Ferret', path: 'Worker/Build' })
  check('activity log: newest first; entries that changed the line tagged current', lv.ok && lv.log?.entries?.length === 4 && lv.log.entries[0].text === 'waiting on review' && lv.log.entries[0].current === true
    && lv.log.entries[1].text === 'oops?' && lv.log.entries[1].current === true && lv.log.entries[2].text === 'linking (log only)' && !lv.log.entries[2].current, J(lv.log?.entries))

  // ---- templates + log:false (a progress update that is NOT logged)
  const tiles0 = await lgF({ agent: 'worker', key: 'tiles', label: 'Tiles', text: '@Seeding {progress} ({pct})', progress: '10/100 tiles' })
  const tilesId = tiles0.node?.id
  const nEntries = records().filter(isEntry).length
  const lf = await lgF({ agent: 'worker', key: 'tiles', progress: '40/100 tiles', log: false })
  b = await board(G)
  check('log:false: ok, logged:false', lf.ok === true && lf.logged === false, J(lf))
  const tcur = await call(G, 'activity', { entry: { id: nodeOf(b, 'Ferret', 'Worker/Tiles')?.current?.id } })
  check('template: the current line renders against the CURRENT bar (moved by log:false)', nodeOf(b, 'Ferret', 'Worker/Tiles')?.progress?.done === 40 && nodeOf(b, 'Ferret', 'Worker/Tiles')?.current?.text === 'Seeding {progress} ({pct})'
    && tcur.source === 'memory' && tcur.entry?.rendered === 'Seeding 40 of 100 tiles (40%)', J([nodeOf(b, 'Ferret', 'Worker/Tiles'), tcur]))
  const lv2 = await page(G, { session: 'Ferret', path: 'Worker/Tiles' })
  check('log:false: NOT in the log; the logged entry renders against ITS recorded bar', lv2.log?.entries?.length === 1 && lv2.log.entries[0].rendered === 'Seeding 10 of 100 tiles (10%)', J(lv2))
  check('log:false: NOT written to the day file as an entry', records().filter(isEntry).length === nEntries)

  // ---- checkpoints: unchanged-but-alive → ONE cp + ONE rep line whose n grows; a change → a new cp + a fresh rep line
  const tilesCps = rs => rs.filter(r => r.kind === 'cp' && r.n === tilesId && r.v === 6)
  const reps = rs => rs.filter(r => Array.isArray(r.rep))
  const repsBefore = reps(records()).length
  for (const t0 = Date.now(); Date.now() - t0 < 3200;) { await lgF({ agent: 'worker', key: 'tiles', progress: '40/100 tiles', log: false }); await sleep(120) }
  await sleep(800)
  recs = records()
  const k1 = tilesCps(recs)
  check('cp: the log:false change got ONE cp line (by node id, with a per-file key + the bar + the line)', k1.length === 1 && Number.isInteger(k1[0].k) && k1[0].progress?.done === 40 && k1[0].current?.text === 'Seeding {progress} ({pct})', J(k1))
  const r1 = reps(recs).slice(repsBefore)
  check('rep: the unchanged stream is ONE repeat line (rewritten in place), n counting the intervals', r1.length === 1 && J(r1[0].rep) === J([k1[0]?.k]) && r1[0].n >= 3 && r1[0].last > r1[0].since, J(r1))
  check('rep: nothing else was written by the stream (no entries)', recs.filter(isEntry).length === nEntries)
  await lgF({ agent: 'worker', key: 'tiles', progress: '41/100 tiles', log: false })
  for (const t0 = Date.now(); Date.now() - t0 < 2400;) { await lgF({ agent: 'worker', key: 'tiles', progress: '41/100 tiles', log: false }); await sleep(120) }
  await sleep(800)
  recs = records()
  const k2 = tilesCps(recs), r2 = reps(recs).slice(repsBefore)
  check('cp: a change mid-stream → a new cp (same key, the new bar)', k2.length === 2 && k2[1]?.k === k1[0]?.k && k2[1].progress?.done === 41, J(k2))
  check('rep: ... and a FRESH repeat line after it (the first one closed)', r2.length === 2 && r2[0].n === r1[0].n && r2[1].n >= 2, J(r2))
  const lastRep = r2[1] ? r2[1].last : -1

  // ---- details/data lookups: memory (a current line), the day file otherwise; past the per-node cap, paging by cursor
  const spec = await lgF({ agent: 'worker', key: 'spec', label: 'Spec', text: '@drafted', details: 'CURRENT-DETAILS', data: { cur: 1 } })
  const cur = await call(G, 'activity', { entry: { id: spec.id } })
  check('entry: a CURRENT line comes from memory with its details/data', cur.ok && cur.source === 'memory' && cur.entry?.details === 'CURRENT-DETAILS' && cur.entry?.data?.cur === 1 && cur.entry?.node_id === spec.node?.id, J(cur))
  const old = await call(G, 'activity', { entry: { id: l2.id } })
  check('entry: a REPLACED current line comes from the day file', old.ok && old.source === 'file' && old.entry?.details === 'FULL-COMPILER-OUTPUT' && old.entry?.data?.errors === 0 && old.entry?.node_id === l2.node.id, J(old))
  const note = await lgF({ agent: 'worker', key: 'build', text: 'note with details', details: 'LOGGED-DETAILS', data: { k: 'v' } })
  const e1 = await call(F, 'activity', { entry: { id: note.id } })
  check('entry: a logged entry\'s details come from the day file, via the follower too', e1.ok && e1.source === 'file' && e1.entry?.details === 'LOGGED-DETAILS' && e1.entry?.data?.k === 'v', J(e1))
  for (let i = 0; i < 12; i++) await lgF({ agent: 'worker', key: 'build', text: `flood ${i}` })
  const p1 = await page(G, { session: 'Ferret', path: 'Worker', limit: 100 })
  const bBuild = nodeOf(await board(G), 'Ferret', 'Worker/Build')
  let found = null, cursor = p1.log?.next_cursor, pages = 1
  while (!found && cursor && pages < 10) { const p = await page(G, { session: 'Ferret', path: 'Worker', limit: 100, cursor }); pages++; found = (p.log?.entries || []).find(e => e.id === note.id) || null; cursor = p.log?.next_cursor }
  check('log_entries_per_agent=10: a page holds 10 (the note is not on it) and the rest pages through the files by cursor (the note on a later page)', p1.log?.entries?.length === 10 && !p1.log.entries.some(e => e.id === note.id) && !!p1.log.next_cursor && !!found && found.text === 'note with details'
    && bBuild?.log_n === 17, J([p1.log && p1.log.entries.length, p1.log?.next_cursor, pages, !!found, bBuild?.log_n]))
  const e2 = await call(G, 'activity', { entry: { id: note.id } })
  check('entry: after the flood the note\'s details still come from the day file', e2.ok && e2.source === 'file' && e2.entry?.details === 'LOGGED-DETAILS', J(e2))
  check('entry: an unknown id → unknown-entry', (await call(G, 'activity', { entry: { id: 'act_nope_zz-1' } })).code === 'unknown-entry')

  // ---- the session root's log + limits + codes
  await lgB({ text: 'spawned 3 agents' })
  const sl = await page(G, { session: 'Bridget' })
  check('session-level: the session\'s own log (no id / path = the root\'s subtree)', sl.ok && sl.log?.node?.path === '' && sl.log.entries[0].text === 'spawned 3 agents' && sl.log.entries[1].text === 'orchestrating spec-70', J(sl))
  const long = await lgB({ text: 'x'.repeat(300) })
  check('limits: text > 240 is truncated with a warning', long.ok && (long.warnings || []).some(w => w === 'text-truncated' || w?.code === 'text-truncated'), J(long))
  const deep = n => Array.from({ length: n }, (_, i) => `d${i}`).join('/')
  const codes = await Promise.all([
    lgB({ key: 'lbl', label: 'c'.repeat(61), text: 'x' }),
    lgB({ text: 'x', details: 'd'.repeat(4097) }),
    lgB({ text: 'x', data: { s: 'z'.repeat(17000) } }),
    lgB({ path: deep(33), text: 'x' }),
    lgF({ agent: 'worker', path: deep(32), text: 'x' }),
    lgF({ text: 'x', state: 'stale' }),
    call(G, 'log', { text: 'no identity' }),
    lgB({ secret: 'WRONG', text: 'x' }),
    lgF({ text: 'x', log: 'maybe' }),
    lgB({ key: 'nolabel', text: 'x' }),
    lgF({ agent: 'nobody/deeper', text: 'x' }),
  ])
  check('limits/codes: bad-label (61 code points), details-too-large, data-too-large, path-too-deep (33 segments), depth (32 below an agent = depth 33 > 32, nothing created), bad-state, as-required, bad-secret, bad-log, label-required, unknown-agent',
    J(codes.map(c => c.code)) === J(['bad-label', 'details-too-large', 'data-too-large', 'path-too-deep', 'depth', 'bad-state', 'as-required', 'bad-secret', 'bad-log', 'label-required', 'unknown-agent'])
    && codes[4].depth === 33 && !nodeOf(await board(G), 'Bridget', 'd0') && !nodeOf(await board(G), 'Ferret', 'Worker/d0'), J(codes.map(c => c.code)))
  const empty = await lgF({})
  check('codes: a call with nothing to report is a no-op on the session root (ok, logged:false, no entry)', empty.ok === true && empty.logged === false && empty.id == null, J(empty))
  const legacy = await Promise.all([
    lgB({ text: '@~root x' }),
    lgB({ path: '@#70/x', text: 'x' }),
    lgB({ agent: 'worker', context: '@build', text: 'x' }),
    lgB({ path: 'a', move: 'b', to: 'c' }),
    lgB({ note: 'x' }),
    lgB({ text: 'x', plan: [] }),
  ])
  check('2.0 codes: the 1.7x forms are refused legacy-form (@~ in text, @ in a path, context, to, note); an empty plan → bad-plan', J(legacy.map(c => c.code)) === J(['legacy-form', 'legacy-form', 'legacy-form', 'legacy-form', 'legacy-form', 'bad-plan']), J(legacy.map(c => [c.code, c.what])))

  // ---- the NODE TREE over the tool — agents by key chain, paths below an agent, implicit intermediates, rollup, merged logs
  const t1 = await lgB({ agent: 'spec-70', label: 'Spec 70', text: 'form agent spec-70', progress: '1/4 tiles' })
  const t2 = await lgB({ agent: 'spec-70/research', label: 'Research', text: 'form research', progress: '1/4 tiles' })
  const t3 = await lgB({ agent: 'spec-70', path: 'Tharsis', text: '@form Tharsis', progress: '1/4 tiles' })
  const t4 = await lgB({ agent: 'spec-70', path: 'Tharsis/z12', text: '@form z12', progress: '1/4 tiles' })
  const t5 = await lgB({ path: '#70/a', text: 'form #70/a', progress: '1/4 tiles' })
  const t6 = await lgB({ path: '#70/step4/b', text: 'form #70/step4/b', progress: '1/4 tiles' })
  const t7 = await lgB({ key: 'strip17', label: 'CTX strip 17', text: '@form strip 17', progress: '1/4 tiles' })
  const forms = [['Spec 70', 'agent'], ['Spec 70/Research', 'agent'], ['Spec 70/Tharsis', 'context'], ['Spec 70/Tharsis/z12', 'context'], ['#70/a', 'context'], ['#70/step4/b', 'context'], ['CTX strip 17', 'context']]
  let tb = await board(G)
  check('tree: every form logs ok and lands on the board as its node (path, kind; a path never makes an agent)', [t1, t2, t3, t4, t5, t6, t7].every(r => r.ok) && forms.every(([p, k]) => nodeOf(tb, 'Bridget', p)?.kind === k)
    && t2.node?.scope === 'spec-70' && t3.node?.scope === 'spec-70', J([[t1, t2, t3, t4, t5, t6, t7].map(r => r.code || r.node?.path), forms.map(([p]) => nodeOf(tb, 'Bridget', p)?.kind)]))
  check('tree: implicit intermediates (#70, #70/step4) + parent ids / depths', nodeOf(tb, 'Bridget', '#70')?.implicit === true && nodeOf(tb, 'Bridget', '#70/step4')?.implicit === true
    && nodeOf(tb, 'Bridget', '#70/step4/b')?.parent_id === nodeOf(tb, 'Bridget', '#70/step4')?.id && nodeOf(tb, 'Bridget', '#70/step4/b')?.depth === 3, J(nodeOf(tb, 'Bridget', '#70/step4/b')))
  check('tree: the "@" forms set the line; the plain ones only log', nodeOf(tb, 'Bridget', 'Spec 70/Tharsis/z12')?.current?.text === 'form z12' && !nodeOf(tb, 'Bridget', 'Spec 70/Research')?.current && !nodeOf(tb, 'Bridget', '#70/a')?.current)
  check('tree: rollup (Spec 70 shows the bar it reported: 1/4; #70 = its descendants\' sum: 2/8)', nodeOf(tb, 'Bridget', 'Spec 70')?.display?.bar?.rollup === false && nodeOf(tb, 'Bridget', 'Spec 70')?.display?.bar?.done === 1
    && nodeOf(tb, 'Bridget', '#70')?.display?.bar?.done === 2 && nodeOf(tb, 'Bridget', '#70')?.display?.bar?.total === 8 && nodeOf(tb, 'Bridget', '#70')?.display?.bar?.rollup === true, J(nodeOf(tb, 'Bridget', '#70')?.display))
  const viaKey = await lgB({ path: 'spec-70/Tharsis', text: '@via the agent key' })
  tb = await board(G)
  check('tree: a path segment finds an agent by its KEY — the same node as the agent-relative path', viaKey.ok && viaKey.node?.id === t3.node?.id && viaKey.node?.path === 'Spec 70/Tharsis' && nodeOf(tb, 'Bridget', 'Spec 70/Tharsis')?.current?.text === 'via the agent key', J(viaKey))
  const sub = await page(G, { session: 'Bridget', id: t1.node?.id, limit: 50 })
  check('tree: a node\'s log = its SUBTREE merged, newest first, each entry with its path + rel', sub.ok && sub.log?.entries?.length === 5 && sub.log.entries[0].text === 'via the agent key' && sub.log.entries[0].rel === 'Tharsis'
    && sub.log.entries.some(e => e.path === 'Spec 70/Tharsis/z12' && e.rel === 'Tharsis/z12') && sub.log.entries.some(e => e.path === 'Spec 70/Research'), J(sub.log?.entries?.map(e => [e.rel, e.text])))
  const own = await page(G, { session: 'Bridget', path: 'Spec 70', own: true })
  check('tree: own:true = the node\'s own entries only (by path too)', own.log?.entries?.length === 1 && own.log.entries[0].text === 'form agent spec-70', J(own.log?.entries))

  // ---- BATCH via the tool — order, per-item results + refs, partial failure, bounds; a follower's batch is ONE frame
  await lgB({ agent: 'batcher', label: 'Batcher' })
  const bt = await lgB({ agent: 'batcher', items: [
    { ref: 'a', key: 'step', label: 'Step', text: '@step one', progress: '1/3' }, { ref: 'b', key: 'step', text: '@step two', state: 'nope' }, { ref: 'c', key: 'step', text: '@step three', progress: '3/3' },
    { ref: 'd', path: 'x/y', text: '@below the default agent' }, { ref: 'e', id: t7.node?.id, text: '@by id, outside the default agent' }] })
  tb = await board(G)
  check('batch: { ok, results:[…] } one per item in order, refs echoed; a bad item fails alone (applied 4, failed 1); items are addressed from the default agent (or by id)', bt.ok === true
    && J((bt.results || []).map(r => [r.ref, r.ok, r.code || r.node?.path])) === J([['a', true, 'Batcher/Step'], ['b', false, 'bad-state'], ['c', true, 'Batcher/Step'], ['d', true, 'Batcher/x/y'], ['e', true, 'CTX strip 17']]) && bt.applied === 4 && bt.failed === 1, J(bt))
  check('batch: applied in order — the last good line + bar win', nodeOf(tb, 'Bridget', 'Batcher/Step')?.current?.text === 'step three' && nodeOf(tb, 'Bridget', 'Batcher/Step')?.progress?.done === 3
    && nodeOf(tb, 'Bridget', 'Batcher/x/y')?.current?.text === 'below the default agent' && nodeOf(tb, 'Bridget', 'CTX strip 17')?.current?.text === 'by id, outside the default agent')
  const bb = await Promise.all([
    lgB({ items: Array.from({ length: 65 }, (_, i) => ({ text: `@x${i}` })) }),
    lgB({ items: Array.from({ length: 20 }, () => ({ text: '@x0', details: 'd'.repeat(4000) })) }),
    lgB({ items: [] }),
    lgB({ items: [{ text: '@x1' }], text: 'top-level text' }),
  ])
  check('batch bounds: 65 items → too-many-items, > 64 KB → batch-too-large, empty / mixed → bad-batch (the WHOLE call, nothing applied)', J(bb.map(r => r.code)) === J(['too-many-items', 'batch-too-large', 'bad-batch', 'bad-batch'])
    && !(await board(G)).some(s => (s.nodes || []).some(n => /^x\d+$/.test(n.current?.text || ''))), J(bb.map(r => r.code)))
  await lgF({ agent: 'fbatch', label: 'F batch' })
  const fwdOf = async () => ((await call(G, 'activity', { tap: true, session: '-none-' })).tap?.recv || []).filter(x => x.kind === 'fwd' && x.op === 'log')
  const tapBefore = (await fwdOf()).length
  const fb2 = await lgF({ agent: 'fbatch', items: Array.from({ length: 10 }, (_, i) => ({ ref: i, key: `n${i % 3}`, label: `N${i % 3}`, text: `@line ${i}` })) })
  const fwd = await fwdOf()
  check('batch (FOLLOWER): 10 items forwarded in ONE ACTIVITY frame, applied in order on the gateway', fb2.ok && fb2.results?.length === 10 && fb2.results.every((r, i) => r.ok && r.ref === i) && fwd.length === tapBefore + 1 && fwd.at(-1).items === 10
    && nodeOf(await board(G), 'Ferret', 'F batch/N0')?.current?.text === 'line 9', J([fb2.results?.map(r => r.code || r.ok), tapBefore, fwd.slice(-2)]))
  const dflt = await lgF({ agent: 'worker', key: 'eta', label: 'ETA', eta: '90m' })
  b = await board(G)
  const etaLog = await page(G, { session: 'Ferret', path: 'Worker/ETA' })
  check('default text (Q33): an ETA-only report logs the entry "{eta}" (rendered relative) and sets no line', dflt.ok && dflt.logged === true && dflt.line === false && nodeOf(b, 'Ferret', 'Worker/ETA')?.current == null && !!nodeOf(b, 'Ferret', 'Worker/ETA')?.eta_at
    && etaLog.log?.entries?.[0]?.text === '{eta}' && /^~1h 2\dm$|^~1h 30m$/.test(etaLog.log?.entries?.[0]?.rendered || ''), J([dflt, nodeOf(b, 'Ferret', 'Worker/ETA'), etaLog.log?.entries]))

  // ---- stale (via the per-message stale_after override)
  await lgF({ agent: 'sleepy', label: 'Sleepy', text: '@downloading', stale_after: '1s' })
  check('stale: running inside its stale_after window', nodeOf(await board(G), 'Ferret', 'Sleepy')?.state === 'running')
  await sleep(1600)
  const sa = nodeOf(await board(G), 'Ferret', 'Sleepy')
  check('stale: quiet past stale_after → stale, was running', sa?.state === 'stale' && sa?.was === 'running', J(sa))
  check('activity: filters (session, project)', (await call(G, 'activity', { session: 'Ferret' })).sessions?.length === 1 && (await call(G, 'activity', { project: 'nope' })).sessions?.length === 0)

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
  const forged = { t: 'ACTIVITY', session: 'FAKE/abcd', rid: 'r1', op: 'log', ident: { realm: 'default', project: 'AIMB', user: 'robin', session: 'Bridget' }, input: { text: '@FORGED-LINE' } }
  const noHello = await rawFrames([forged])
  const helloOnly = await rawFrames([{ t: 'HELLO', ver: 1, fromBridge: 'FAKE/abcd', fromSession: 'FAKE/abcd', name: 'x', auth: TOKEN }, forged])
  check('frames: ACTIVITY without HELLO / from an unregistered connection → unauthorized', noHello[0]?.result?.code === 'unauthorized' && helloOnly[0]?.result?.code === 'unauthorized', J([noHello, helloOnly]))
  check('frames: ... and nothing was applied', !J(await page(G, { session: 'Bridget' })).includes('FORGED-LINE') && !J(await board(G)).includes('FORGED-LINE') && !records().some(r => r.text === 'FORGED-LINE'))

  // ---- enabled:false (a separate bridge with AI_BRIDGE_ACTIVITY_ENABLED=0)
  const D = await spawn('LogOff', OFF_PORT, { AI_BRIDGE_ACTIVITY_ENABLED: '0', AI_BRIDGE_PERSISTENCE: 'none' }); all.push(D)
  await sleep(600)
  await reg(D, 'Off', 'off', 'AIMB')
  const off1 = await call(D, 'log', { as: 'Off', secret: 'off', text: 'hello' }), off2 = await call(D, 'activity')
  check('enabled:false: log and activity return activity-disabled', off1.code === 'activity-disabled' && off2.code === 'activity-disabled', J([off1, off2]))

  // ---- PLANS over the tool — gateway + follower, ticks, re-plan, codes, a batch item's plan, the day file
  const pl = await lgB({ path: '#71', plan: ['Spec', 'Build', 'Test', 'Ship'] })
  check('plan (tool): plan:[…] creates ☐ items under the target in the GIVEN order; result.plan names each (id, label, path)', pl.ok && (pl.plan || []).every(p => ID_RE.test(p.id || ''))
    && J((pl.plan || []).map(p => [p.label, p.path, p.created, p.plan_item, p.state])) === J([['Spec', '#71/Spec', true, true, 'todo'], ['Build', '#71/Build', true, true, 'todo'], ['Test', '#71/Test', true, true, 'todo'], ['Ship', '#71/Ship', true, true, 'todo']]), J(pl))
  const pt1 = await lgB({ path: '#71/Spec', state: 'done' })
  const pt2 = await lgB({ path: '#71/Build', text: '@compiling' })
  const pt3 = await lgB({ path: '#71/Test', state: 'skipped' })
  const rpl = await lgB({ path: '#71', plan: ['Build', 'Docs'] })
  check('tick (tool): state done alone ticks an item; a "@" line starts one; skipped; re-plan keeps Build as it is and adds Docs at the end', pt1.ok && pt1.state === 'done' && pt2.ok && pt2.state === 'running' && pt3.ok && pt3.state === 'skipped'
    && rpl.ok && J(rpl.plan.map(p => [p.label, !!p.created, p.state])) === J([['Build', false, 'running'], ['Docs', true, 'todo']]) && rpl.plan[0].id === pl.plan[1].id, J([pt1, pt2, pt3, rpl]))
  const fpl = await lgF({ agent: 'rel', label: 'Release', text: '@planning the release', plan: ['lint', 'pack'] })
  check('plan (FOLLOWER): forwarded with its text — the agent\'s own line + 2 items under it', fpl.ok && fpl.node?.path === 'Release' && fpl.logged === true && fpl.line === true && J(fpl.plan.map(p => p.path)) === J(['Release/lint', 'Release/pack']), J(fpl))
  const pc6 = await Promise.all([
    lgB({ agent: 'spec-70', text: 'x', state: 'todo' }),
    lgF({ agent: 'worker', key: 'build', text: 'x', state: 'skipped' }),
    lgB({ path: '#71', plan: [{ key: 'bad key', label: 'X' }] }),
    lgB({ path: '#71', plan: [{ key: 'newone' }] }),
  ])
  check('plan codes: bad-agent-state (an agent can\'t be todo), not-a-plan-item (skipped on an ordinary context), bad-plan (a bad item key), label-required (a new item needs its label)', J(pc6.map(c => c.code)) === J(['bad-agent-state', 'not-a-plan-item', 'bad-plan', 'label-required']), J(pc6.map(c => [c.code, c.what])))
  const pbt = await lgB({ items: [{ ref: 'p', path: '#72', plan: ['a', 'b'] }, { ref: 't', path: '#72/a', state: 'done' }] })
  check('batch: an item may carry a plan; a later item ticks it', pbt.ok && pbt.applied === 2 && J(pbt.results.map(r => [r.ref, r.ok])) === J([['p', true], ['t', true]]) && pbt.results[1].node?.path === '#72/a', J(pbt))
  await lgB({ path: '#73', plan: ['slow'] })
  await lgB({ path: '#73/slow', text: '@quiet for a while', stale_after: '1s' })
  await sleep(1500)
  const pb = await board(G)
  const P71 = ['Spec', 'Build', 'Test', 'Ship', 'Docs']
  const kids71 = (sess(pb, 'Bridget')?.nodes || []).filter(n => n.parent_id === nodeOf(pb, 'Bridget', '#71')?.id).map(n => n.label)
  check('board: plan items (plan_item, their own states, the given order) + the "N of M done" bar (#79: skipped stays in M, as its own part: 1 of 5 · 1 skipped)', J(P71.map(n => [nodeOf(pb, 'Bridget', `#71/${n}`)?.state, nodeOf(pb, 'Bridget', `#71/${n}`)?.plan_item])) === J([['done', true], ['running', true], ['skipped', true], ['todo', true], ['todo', true]])
    && J(kids71) === J(P71) && (x => x && x.todos && x.done === 1 && x.total === 5 && x.skipped === 1)(nodeOf(pb, 'Bridget', '#71')?.display?.bar) && nodeOf(pb, 'Bridget', '#72/a')?.state === 'done', J([kids71, nodeOf(pb, 'Bridget', '#71')?.display]))
  check('stale: a plan item never goes stale (quiet past its stale_after: still running)', nodeOf(pb, 'Bridget', '#73/slow')?.state === 'running' && !nodeOf(pb, 'Bridget', '#73/slow')?.stale_at, J(nodeOf(pb, 'Bridget', '#73/slow')))
  const ids71 = [...pl.plan.map(p => p.id), rpl.plan[1].id]
  recs = records()
  const creates71 = recs.filter(r => r.kind === 'node' && r.op === 'create' && ids71.includes(r.n))
  const tick = recs.find(r => r.id === pt1.id)
  check('day file: v6 node records — one create per item (plan_item + plan_ix), in order; each tick an entry by node id', creates71.map(r => r.label).join() === P71.join() && creates71.every(r => r.v === 6 && r.plan_item === true && Number.isInteger(r.plan_ix))
    && tick?.v === 6 && tick?.n === pl.plan[0].id && tick?.state === 'done' && tick?.at === '#71/Spec', J([creates71.map(r => [r.label, r.plan_item, r.plan_ix]), tick]))
  const snap71 = bd => J(P71.map(n => [nodeOf(bd, 'Bridget', `#71/${n}`)?.id, nodeOf(bd, 'Bridget', `#71/${n}`)?.state, nodeOf(bd, 'Bridget', `#71/${n}`)?.created_at]))
  const beforePlanKill = snap71(pb)

  // ---- restart replay #1: kill the GATEWAY → the follower takes over and replays the host's files
  const beforeKill = await board(G)
  const buildBefore = nodeOf(beforeKill, 'Ferret', 'Worker/Build')
  const subBefore = J(sub.log.entries.map(e => [e.id, e.text]))
  await G.transport.close(); all.splice(all.indexOf(G), 1)
  const fb = await until(async () => (await call(F, 'my_identity')).role === 'gateway' ? board(F) : [], x => !!nodeOf(x, 'Ferret', 'Worker/Tiles'), 10000)
  check('restart: the follower is the gateway now', (await call(F, 'my_identity')).role === 'gateway')
  check('restart: lines come back from the files (gateway-sub-peer + follower-sub-peer sessions)', nodeOf(fb, 'Bridget', '')?.current?.text === 'orchestrating spec-70'
    && nodeOf(fb, 'Ferret', 'Worker/Build')?.current?.text === 'waiting on review' && nodeOf(fb, 'Ferret', 'Worker/Build')?.state === 'blocked', J(sess(fb, 'Ferret')))
  const tl = nodeOf(fb, 'Ferret', 'Worker/Tiles')
  const tle = await call(F, 'activity', { entry: { id: tl?.current?.id } })
  check('restart: the log:false bar survives (from the checkpoint) and the template renders against it', tl?.id === tilesId && tl?.progress?.done === 41 && tle.entry?.rendered === 'Seeding 41 of 100 tiles (41%)', J([tl, tle]))
  check('restart: last_activity comes from the rep line (not stale; later than its cp)', tl?.last_activity === lastRep && tl?.last_activity > (k2[1] ? k2[1].ts : Infinity) && tl?.state === 'running', J([tl && tl.last_activity, lastRep, k2[1] && k2[1].ts]))
  check('restart: the node\'s entry count comes back (log_n) and a page still holds the per-node cap', nodeOf(fb, 'Ferret', 'Worker/Build')?.log_n === buildBefore?.log_n && (await page(F, { session: 'Ferret', path: 'Worker', limit: 100 })).log?.entries?.length === 10, J([nodeOf(fb, 'Ferret', 'Worker/Build')?.log_n, buildBefore?.log_n]))
  check('restart: the board matches the one before the kill (sessions)', J((await board(F)).map(s => s.session)) === J(beforeKill.map(s => s.session)))
  const rb2 = await board(F)
  const shape = bd => J((sess(bd, 'Bridget')?.nodes || []).map(n => [n.id, n.path, n.kind, !!n.implicit]))
  check('restart: the nested nodes come back from the files — SAME ids, paths, kinds, lines, implicit intermediates', nodeOf(rb2, 'Bridget', 'Spec 70/Tharsis/z12')?.current?.text === 'form z12'
    && nodeOf(rb2, 'Bridget', 'Spec 70/Research')?.kind === 'agent' && nodeOf(rb2, 'Bridget', '#70')?.implicit === true && nodeOf(rb2, 'Bridget', 'Batcher/Step')?.current?.text === 'step three'
    && shape(rb2) === shape(beforeKill), J([shape(rb2), shape(beforeKill)]))
  const rsub = await page(F, { session: 'Bridget', id: t1.node?.id, limit: 50 })
  check('restart: the subtree log is back (the same entries, newest first)', J((rsub.log?.entries || []).map(e => [e.id, e.text])) === subBefore, J(rsub.log?.entries?.map(e => e.text)))
  const rpb = await board(F)
  check('restart: the plans come back from the files — every item a plan item with its id, state, created_at and order', snap71(rpb) === beforePlanKill && P71.every(n => nodeOf(rpb, 'Bridget', `#71/${n}`)?.plan_item === true)
    && nodeOf(rpb, 'Ferret', 'Release/pack')?.plan_item === true && (x => x && x.todos && x.done === 1)(nodeOf(rpb, 'Bridget', '#71')?.display?.bar), J([beforePlanKill, snap71(rpb)]))
  const e3 = await call(F, 'activity', { entry: { id: note.id } })
  check('restart: entry details still come from the day file', e3.ok && e3.source === 'file' && e3.entry?.details === 'LOGGED-DETAILS', J(e3))
  const after = await lgF({ agent: 'worker', key: 'build', text: '@resumed after the restart', state: 'running' })
  check('restart: the new gateway logs into the SAME host directory', after.ok && fs.readdirSync(path.join(persist, 'activity')).filter(n => fs.statSync(path.join(persist, 'activity', n)).isDirectory()).length === 1 && records().some(r => r.id === after.id), J(after))

  // ---- restart replay #2: the old gateway comes back as a follower (forwards), then a fresh gateway replays alone
  const G2 = await spawn('LogGw2'); all.push(G2)
  await sleep(800)
  await reg(G2, 'Bridget', 'bg', 'AIMB')
  const viaG2 = await lgB({ text: '@back, as a follower' }, G2)
  check('restart: the restarted bridge is a follower and forwards', (await call(G2, 'my_identity')).role === 'follower' && viaG2.ok && nodeOf(await board(G2), 'Bridget', '')?.current?.text === 'back, as a follower', J(viaG2))
  await F.transport.close(); all.splice(all.indexOf(F), 1)
  const g2b = await until(async () => (await call(G2, 'my_identity')).role === 'gateway' ? board(G2) : [], x => !!nodeOf(x, 'Ferret', 'Worker/Build'), 10000)
  check('restart #2: a fresh gateway replays everything both earlier gateways (and the seed) wrote', nodeOf(g2b, 'Ferret', 'Worker/Build')?.current?.text === 'resumed after the restart'
    && nodeOf(g2b, 'Bridget', '')?.current?.text === 'back, as a follower' && nodeOf(g2b, 'Yday', 'Nightly')?.current?.text === 'overnight batch {progress}' && nodeOf(g2b, 'Yday', 'Nightly')?.id === seed.node.id, J(g2b.map(s => [s.session, nodeOf(g2b, s.session, '')?.current?.text])))
} catch (e) { fail++; console.log('FAIL crashed:', (e && e.stack) || e) }

console.log(`\n${pass} passed, ${fail} failed`)
for (const b2 of all) { try { await b2.transport.close() } catch { } }
await sleep(400)
for (const d of [persist, cfgDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
process.exit(fail ? 1 : 0)
