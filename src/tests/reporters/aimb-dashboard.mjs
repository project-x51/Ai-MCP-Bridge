// aimb-dashboard — a node:test REPORTER (#81) that shows a test run live on the AIMB activity board. Use it beside `spec`:
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//               --test-reporter=./tests/reporters/aimb-dashboard.mjs --test-reporter-destination=stdout <files>
// (`npm test` and tests/run.mjs pass both). It prints NOTHING; it is SILENT and does nothing unless
// AIMB_TEST_LOG_SESSION is set, and it never fails the run (no bridge, a bad token, a dead link: it just stops reporting).
//
// What it reports, over ONE `tools/aimb-log.mjs --stream` child kept open for the whole run:
//   - the run node (AIMB_TEST_LOG_PATH, default "@tests") gets a plan: one ☐ item per test script (e.g. test_mesh), reset
//     to ☐ at the start of each run; an item goes running → done / failed as its script runs;
//   - about every 10 s a log:false progress line on the run node: "checks N · file i/T · <running scripts>", with the
//     three-part bar {done: passed checks, skipped, total} (total = each script's check count from the last full run,
//     cached in <tmp>/aimb-test-counts.json; a script that ended early has its unreached checks counted as skipped);
//   - a LOGGED entry for each failing script, its FAIL lines in `details` (≤ 4 KB); and a final logged summary.
// Env: AIMB_TEST_LOG_SESSION (required to report), AIMB_TEST_LOG_PROJECT (default AIMB), AIMB_TEST_LOG_PATH (default
// @tests), AIMB_TEST_LOG_USER (optional --user), AIMB_TEST_LOG_SCRIPT (the aimb-log script; default src/tools/aimb-log.mjs),
// AIMB_TEST_LOG_CONFIG (a bridge config file handed ONLY to the aimb-log child, as its AI_BRIDGE_CONFIG — never set
// AI_BRIDGE_CONFIG / AI_BRIDGE_TOKEN* in the test run's own environment: live tests spawn bridges that would inherit it).
//
// Live state: node:test replays a test file's events only once the files before it have reported, so with groups in
// parallel the events of all but one group arrive late. The drivers (tests/helpers/suite.mjs) therefore also append
// start / end lines to a per-process file in AIMB_TEST_STATUS_DIR, which this reporter creates (when active) and polls;
// the node:test events remain the fallback (and the only source when the drivers aren't ours).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORDER, GROUPS, GROUP_OF, groupFiles, selected } from '../helpers/manifest.mjs'

const env = process.env
const SESSION = String(env.AIMB_TEST_LOG_SESSION || '').trim()
const PROJECT = String(env.AIMB_TEST_LOG_PROJECT || '').trim() || 'AIMB'
const RUN_PATH = String(env.AIMB_TEST_LOG_PATH || '').trim() || '@tests'
const USER = String(env.AIMB_TEST_LOG_USER || '').trim()
const SCRIPT = String(env.AIMB_TEST_LOG_SCRIPT || '').trim() || fileURLToPath(new URL('../../tools/aimb-log.mjs', import.meta.url))
const CONFIG = String(env.AIMB_TEST_LOG_CONFIG || '').trim()
const ACTIVE = !!SESSION
const TICK_MS = Number(env.AIMB_TEST_LOG_TICK_MS) > 0 ? Number(env.AIMB_TEST_LOG_TICK_MS) : 10000
const COUNTS_FILE = path.join(os.tmpdir(), 'aimb-test-counts.json')
const DETAILS_MAX = 4000   // the board's details cap is 4 KB
const DEBUG = String(env.AIMB_TEST_LOG_DEBUG || '').trim()   // a file: every line sent (>) and every result (<) is appended there
const debug = (dir, s) => { if (DEBUG) try { fs.appendFileSync(DEBUG, `${dir} ${s}\n`) } catch { } }

// the side channel: created HERE (module load, before node:test spawns the test files, so they inherit it)
let statusDir = null, ownStatusDir = false
if (ACTIVE) {
  try {
    if (env.AIMB_TEST_STATUS_DIR) statusDir = env.AIMB_TEST_STATUS_DIR
    else { statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-test-status-')); ownStatusDir = true; env.AIMB_TEST_STATUS_DIR = statusDir }
  } catch { statusDir = null }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const fmtDur = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }
const capBytes = (s, max) => { const b = Buffer.from(s, 'utf8'); return b.length <= max ? s : b.subarray(0, max - 4).toString('utf8').replace(/�+$/, '') + ' …' }
const nameOf = id => { const m = /^([a-z]+)\/(test_[\w]+)$/.exec(String(id || '')); return m && GROUP_OF[m[2]] === m[1] ? m[2] : null }

// ---- the aimb-log --stream child (one for the run); every failure just marks it dead
function openLink() {
  const link = { dead: false, ok: 0, failed: 0, child: null }
  try {
    const cenv = { ...env }
    delete cenv.AIMB_TEST_STATUS_DIR
    if (CONFIG) cenv.AI_BRIDGE_CONFIG = CONFIG   // ONLY the logger child sees it
    const args = [SCRIPT, '--stream', '--session', SESSION, '--project', PROJECT, '--path', RUN_PATH, ...(USER ? ['--user', USER] : [])]
    const child = spawn(process.execPath, args, { env: cenv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    link.child = child
    child.on('error', () => { link.dead = true })
    child.on('exit', () => { link.dead = true })
    child.stdin.on('error', () => { link.dead = true })
    let buf = ''
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); debug('<', line); try { const r = JSON.parse(line); if (r.ok) link.ok++; else link.failed++ } catch { } }
    })
  } catch { link.dead = true }
  link.send = obj => { if (link.dead || !link.child) return; try { const l = JSON.stringify(obj); debug('>', l); link.child.stdin.write(l + '\n') } catch { link.dead = true } }
  link.close = async () => {
    const c = link.child
    if (!c || c.exitCode !== null) return
    try { c.stdin.end() } catch { }
    // a reachable bridge answers within a second or two; with none ever reached, don't hold the run up
    const limit = link.ok ? 15000 : 3000
    const t0 = Date.now()
    while (c.exitCode === null && Date.now() - t0 < limit) await sleep(50)
    if (c.exitCode === null) { try { c.kill() } catch { } }
  }
  return link
}

// ---- which scripts this run covers: the drivers named on the node --test command line (else learnt as they appear)
function plannedNames() {
  const args = [...process.argv.slice(1), ...process.execArgv].map(a => String(a).replace(/\\/g, '/'))
  const names = new Set()
  let suite = false
  for (const a of args) {
    if (/(^|\/)suite\.test\.mjs$/.test(a)) suite = true
    else if (/\*/.test(a) && /\.test\.mjs$/.test(a)) Object.keys(GROUPS).forEach(g => groupFiles(g).forEach(f => names.add(f)))
    else { const m = /(?:^|\/)([a-z]+)\/\1\.test\.mjs$/.exec(a); if (m && GROUPS[m[1]]) groupFiles(m[1]).forEach(f => names.add(f)) }
  }
  const order = suite ? ORDER : Object.keys(GROUPS).flatMap(g => groupFiles(g))
  return order.filter(f => (suite || names.has(f)) && selected(f))
}

export default async function* aimbDashboard(source) {
  if (!ACTIVE) { for await (const _ of source) { } return }   // silent: consume and do nothing
  const t0 = Date.now()
  let link = null
  try { link = openLink() } catch { }
  const send = o => { try { link && link.send(o) } catch { } }

  let est = {}
  try { est = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8')) || {} } catch { }
  const known = Object.values(est).map(Number).filter(n => n > 0).sort((a, b) => a - b)
  const avg = known.length ? known[Math.floor(known.length / 2)] : 20   // the median: one 700-check unit file mustn't skew it

  const files = new Map()   // name → { state, pass, fail, est, fails, ms, why, tail }
  const add = (name, announce) => {
    if (files.has(name)) return files.get(name)
    const f = { name, state: 'todo', pass: 0, fail: 0, est: Number(est[name]) > 0 ? Number(est[name]) : avg, fails: [], ms: 0 }
    files.set(name, f)
    if (announce) send({ plan: [name], log: false })   // keep-and-append: a script the command line didn't name
    return f
  }
  const planned = (() => { try { return plannedNames() } catch { return [] } })()
  planned.forEach(n => add(n, false))
  const others = []   // failures that aren't a script (a driver's manifest guard, a crashed driver)

  const header = () => `${files.size} test script${files.size === 1 ? '' : 's'}${planned.length ? '' : ' (learnt as they run)'}`
  send({ text: `@~root test run started: ${header()}`, state: 'running', ...(planned.length ? { plan: planned } : {}) })
  if (planned.length) for (let i = 0; i < planned.length; i += 60) send(planned.slice(i, i + 60).map(n => ({ path: `@~${n}`, state: 'todo', text: 'queued', log: false })))

  const progress = () => {
    let done = 0, skipped = 0, total = 0, finished = 0, failedChecks = 0
    for (const f of files.values()) {
      const ran = f.pass + f.fail
      if (f.state === 'done' || f.state === 'failed') {
        finished++
        const t = Math.max(ran, f.state === 'failed' ? f.est : ran)
        total += t; skipped += t - ran
      } else total += f.est
      done += f.pass; failedChecks += f.fail
    }
    return { done, skipped, total: Math.max(total, done + skipped), finished, failedChecks }
  }
  const running = () => [...files.values()].filter(f => f.state === 'running').map(f => f.name)
  const tick = () => {
    const p = progress(), r = running()
    const text = `@~root checks ${p.done}${p.failedChecks ? ` (${p.failedChecks} failed)` : ''} · file ${p.finished}/${files.size}${r.length ? ' · ' + r.join(', ') : ''}`
    send({ text: capBytes(text, 300), progress: { done: p.done, total: p.total, unit: 'checks', ...(p.skipped ? { skipped: p.skipped } : {}) }, log: false })
  }

  const onStart = name => {
    const f = add(name, !planned.includes(name))
    if (f.state !== 'todo') return
    f.state = 'running'
    send({ path: `@~${name}`, state: 'running', text: `running · ${GROUP_OF[name] || ''}`.trim(), log: false })
  }
  const onEnd = (name, r) => {
    const f = add(name, !planned.includes(name))
    if (f.state === 'done' || f.state === 'failed') return
    Object.assign(f, { pass: r.pass || 0, fail: r.fail || 0, fails: r.fails || [], ms: r.ms || 0, why: r.why || '', tail: r.tail || '', state: r.ok ? 'done' : 'failed' })
    const counts = `${f.pass} passed, ${f.fail} failed · ${fmtDur(f.ms)}`
    if (r.ok) send({ path: `@~${name}`, state: 'done', text: counts, log: false })
    else {
      const why = r.why ? ` (${r.why})` : ''
      const details = capBytes([`${name}: ${counts}${why}`, ...(f.fails.length ? f.fails : [r.tail || ''])].join('\n'), DETAILS_MAX)
      send({ path: `@~${name}`, state: 'failed', text: capBytes(`FAILED: ${counts}${why}`, 300), details })
    }
  }

  // the side channel: each driver process appends {t:"start"|"end", name, …} lines to <dir>/<pid>.ndjson
  const offsets = new Map()
  const poll = () => {
    if (!statusDir) return
    let list = []
    try { list = fs.readdirSync(statusDir).filter(f => f.endsWith('.ndjson')) } catch { return }
    for (const fn of list) {
      try {
        const p = path.join(statusDir, fn), size = fs.statSync(p).size, from = offsets.get(fn) || 0
        if (size <= from) continue
        const fd = fs.openSync(p, 'r'), b = Buffer.alloc(size - from)
        fs.readSync(fd, b, 0, b.length, from); fs.closeSync(fd)
        const text = b.toString('utf8'), lastNl = text.lastIndexOf('\n')
        if (lastNl < 0) continue
        offsets.set(fn, from + Buffer.byteLength(text.slice(0, lastNl + 1)))
        for (const line of text.slice(0, lastNl).split('\n')) {
          let o; try { o = JSON.parse(line) } catch { continue }
          if (o.t === 'start' && o.name) onStart(o.name)
          else if (o.t === 'end' && o.name) onEnd(o.name, o)
        }
      } catch { }
    }
  }
  // poll the side channel every second; the progress line goes out every TICK_MS (also a heartbeat: a long script
  // that reports nothing for minutes doesn't make the run look stale)
  let lastTick = 0
  const loop = setInterval(() => { try { poll(); if (Date.now() - lastTick >= TICK_MS) { lastTick = Date.now(); tick() } } catch { } }, Math.min(1000, TICK_MS))

  // the node:test events (the fallback; late for all but the head file when groups run in parallel)
  let ended = null   // { name, ok, diags: [] } — a script's pass/fail; its diagnostics follow it
  const flushEnded = () => {
    if (!ended) return
    const e = ended; ended = null
    const sum = e.diags.map(d => /^(\d+) passed, (\d+) failed · ([\d.]+) s/.exec(d)).find(Boolean)
    onEnd(e.name, { ok: e.ok, pass: sum ? Number(sum[1]) : 0, fail: sum ? Number(sum[2]) : 0, ms: sum ? Number(sum[3]) * 1000 : e.ms, fails: e.diags.filter(d => d.startsWith('FAIL ')), why: (/: (exit -?\d+(?: \(\w+\))?|timed out after [\d.]+ s)/.exec(e.error) || [])[1] || '', tail: e.error })
  }
  try {
    for await (const ev of source) {
      try {
        const d = ev.data || {}
        if (ev.type === 'test:diagnostic' && ended && d.nesting === 0) { ended.diags.push(String(d.message)); continue }
        flushEnded()
        if (d.nesting !== 0) continue
        const name = nameOf(d.name)
        if (ev.type === 'test:dequeue' && name) onStart(name)
        else if ((ev.type === 'test:pass' || ev.type === 'test:fail') && name) {
          const err = d.details && d.details.error
          ended = { name, ok: ev.type === 'test:pass', diags: [], ms: (d.details && d.details.duration_ms) || 0, error: err ? String((err.cause && err.cause.message) || err.message || err).slice(0, 2000) : '' }
        } else if (ev.type === 'test:fail' && d.name && !/\.test\.mjs$/.test(d.name)) {
          others.push(`${d.name}: ${String((d.details && d.details.error && ((d.details.error.cause && d.details.error.cause.message) || d.details.error.message)) || 'failed').split('\n')[0].slice(0, 300)}`)
        }
      } catch { }
    }
    flushEnded()
  } finally {
    clearInterval(loop)
    try { poll() } catch { }
    try {
      const p = progress(), all = [...files.values()]
      const bad = all.filter(f => f.state === 'failed'), notRun = all.filter(f => f.state === 'todo' || f.state === 'running')
      const ok = !bad.length && !others.length && !notRun.length
      const parts = [`${p.done} passed, ${p.failedChecks} failed`, `${all.length - notRun.length}/${all.length} scripts${bad.length ? `, ${bad.length} failed (${bad.map(f => f.name).join(', ')})` : ''}`]
      if (notRun.length) parts.push(`${notRun.length} not finished`)
      if (others.length) parts.push(`${others.length} other failure${others.length === 1 ? '' : 's'}`)
      parts.push(fmtDur(Date.now() - t0))
      const details = capBytes([...bad.map(f => [`${f.name}: ${f.pass} passed, ${f.fail} failed${f.why ? ` (${f.why})` : ''}`, ...(f.fails.length ? f.fails.slice(0, 8) : [String(f.tail).split('\n').slice(-8).join('\n')])].join('\n')), ...others, ...(notRun.length ? [`not finished: ${notRun.map(f => f.name).join(', ')}`] : [])].join('\n\n'), DETAILS_MAX)
      send({ text: capBytes(`@~root ${ok ? 'tests passed' : 'TESTS FAILED'}: ${parts.join(' · ')}`, 400), state: ok ? 'done' : 'failed', progress: { done: p.done, total: p.total, unit: 'checks', ...(p.skipped ? { skipped: p.skipped } : {}) }, ...(details ? { details } : {}) })
      // the check-count cache: a script that finished cleanly tells the next run how many checks it has (not under
      // TEST_ONLY, which counts only the matching checks)
      if (!String(env.TEST_ONLY || '').trim()) {
        const next = { ...est }
        for (const f of all) if (f.state === 'done' && f.pass > 0) next[f.name] = f.pass + f.fail
        try { fs.writeFileSync(COUNTS_FILE, JSON.stringify(next, null, 1)) } catch { }
      }
    } catch { }
    try { link && await link.close() } catch { }
    if (ownStatusDir) { try { fs.rmSync(statusDir, { recursive: true, force: true }) } catch { } }
  }
}
