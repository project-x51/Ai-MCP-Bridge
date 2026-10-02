// node:test glue (#81): each test SCRIPT (tests/<group>/test_*.mjs, a plain Node script with its own check() and PASS /
// FAIL lines) runs as one node:test test named by its id ("mesh/test_mesh"). The test spawns `node <script>` from src/,
// passes on exit 0, and attaches the script's counts ("22 passed, 0 failed · 12.4 s") and its FAIL lines as diagnostics.
// A failing script fails only its own test; the rest still run.
//
// Drivers: tests/<group>/<group>.test.mjs = defineGroup(group) (that group's scripts, one at a time — the groups run in
// parallel under --test-concurrency); tests/suite.test.mjs = defineAll() (every script, one at a time, in manifest ORDER).
// AIMB_TEST_SELECT (tests/run.mjs file …) narrows either to the matching scripts. AIMB_TEST_FILE_TIMEOUT_MS (default 15 min)
// kills a hung script (and its child bridges).
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORDER, GROUPS, GROUP_OF, fileId, groupFiles, selected } from './manifest.mjs'

export const TESTS_DIR = fileURLToPath(new URL('../', import.meta.url))
export const SRC_DIR = fileURLToPath(new URL('../../', import.meta.url))
const TIMEOUT_MS = Number(process.env.AIMB_TEST_FILE_TIMEOUT_MS) > 0 ? Number(process.env.AIMB_TEST_FILE_TIMEOUT_MS) : 15 * 60 * 1000
const KEEP = 1 << 20   // keep the last 1 MB of a script's output (the summary + FAIL lines are what matter)

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  else { try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { } } }
}

/** Run one script → { code, signal, timedOut, pass, fail, fails:[FAIL lines], tail, ms } (never throws) */
export function runScript(name) {
  const file = path.join(TESTS_DIR, GROUP_OF[name], name + '.mjs')
  const t0 = Date.now()
  return new Promise(resolve => {
    let out = '', err = '', timedOut = false
    const child = spawn(process.execPath, [file], { cwd: SRC_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    child.stdout.on('data', d => { out += d; if (out.length > 2 * KEEP) out = out.slice(-KEEP) })
    child.stderr.on('data', d => { err += d; if (err.length > 2 * KEEP) err = err.slice(-KEEP) })
    const timer = setTimeout(() => { timedOut = true; killTree(child) }, TIMEOUT_MS)
    const done = (code, signal) => {
      clearTimeout(timer)
      const sums = [...out.matchAll(/^(\d+) passed, (\d+) failed/gm)], last = sums[sums.length - 1]
      const lines = out.split(/\r?\n/), fails = lines.filter(l => l.startsWith('FAIL '))
      // no summary line (the script crashed): count its PASS / FAIL lines instead
      resolve({ code, signal, timedOut, pass: last ? Number(last[1]) : lines.filter(l => l.startsWith('PASS ')).length, fail: last ? Number(last[2]) : fails.length, counted: !!last, fails, tail: (out + (err ? '\n[stderr]\n' + err : '')).split(/\r?\n/).slice(-30).join('\n'), ms: Date.now() - t0 })
    }
    child.on('error', e => { err += String(e && e.message || e); done(-1, null) })
    child.on('close', done)
  })
}

const secs = ms => (ms / 1000).toFixed(1) + ' s'

// The live side channel for the dashboard reporter (tests/reporters/aimb-dashboard.mjs creates AIMB_TEST_STATUS_DIR when
// it is active): node:test replays a test file's events only after the files before it have reported, so with groups in
// parallel the reporter would see most scripts late. Each driver process appends {t:"start"|"end", name, …} lines to its
// OWN file there (no cross-process interleaving); never fatal.
const STATUS_FILE = process.env.AIMB_TEST_STATUS_DIR ? path.join(process.env.AIMB_TEST_STATUS_DIR, `${process.pid}.ndjson`) : null
function status(o) {
  if (!STATUS_FILE) return
  let line = JSON.stringify(o)
  while (line.length > 16000 && o.fails && o.fails.length) { o.fails = o.fails.slice(0, Math.floor(o.fails.length / 2)); line = JSON.stringify(o) }
  try { fs.appendFileSync(STATUS_FILE, line + '\n') } catch { }
}

/** One script as one node:test test */
export function defineScript(name) {
  test(fileId(name), async t => {
    status({ t: 'start', name })
    const r = await runScript(name)
    status({ t: 'end', name, ok: r.code === 0, pass: r.pass, fail: r.fail, ms: r.ms, fails: r.fails.slice(0, 40), why: r.code === 0 ? '' : (r.timedOut ? 'timed out' : `exit ${r.code}`), tail: r.code === 0 || r.fails.length ? '' : r.tail.slice(-1500) })
    // diagnostic #1 is machine-readable for the dashboard reporter: "<pass> passed, <fail> failed · <secs>"
    t.diagnostic(`${r.pass} passed, ${r.fail} failed · ${secs(r.ms)}${r.counted ? '' : ' (no summary line)'}`)
    for (const l of r.fails.slice(0, 40)) t.diagnostic(l)
    if (r.fails.length > 40) t.diagnostic(`… ${r.fails.length - 40} more FAIL lines`)
    if (r.code !== 0) {
      const why = r.timedOut ? `timed out after ${secs(TIMEOUT_MS)} (killed)` : `exit ${r.code}${r.signal ? ' (' + r.signal + ')' : ''}`
      const e = new Error(`${fileId(name)}: ${why} — ${r.pass} passed, ${r.fail} failed` + (r.fails.length ? '\n' + r.fails.slice(0, 20).join('\n') : '\n' + r.tail))
      e.stack = e.message   // the script's own output is the useful part, not this helper's stack
      throw e
    }
  })
}

/** A guard test: every test_*.mjs in the group's folder is in the manifest (a new file can't silently not run) */
function defineFolderGuard(group) {
  test(`${group}/(manifest)`, () => {
    const listed = new Set(GROUPS[group])
    const stray = fs.readdirSync(path.join(TESTS_DIR, group)).filter(f => /^test_.*\.mjs$/.test(f) && !listed.has(f.slice(0, -4)))
    if (stray.length) throw new Error(`tests/${group}/ has scripts not in tests/helpers/manifest.mjs (add them to GROUPS and append them to ORDER): ${stray.join(', ')}`)
  })
}

/** tests/<group>/<group>.test.mjs: that group's scripts, in ORDER, one at a time */
export function defineGroup(group) {
  if (!GROUPS[group]) throw new Error(`unknown test group "${group}" (have: ${Object.keys(GROUPS).join(', ')})`)
  const files = groupFiles(group).filter(f => selected(f))
  if (!process.env.AIMB_TEST_SELECT) defineFolderGuard(group)
  for (const f of files) defineScript(f)
}

/** tests/suite.test.mjs: every script, in ORDER (the historical `npm test` chain), one at a time */
export function defineAll() {
  for (const f of ORDER) if (selected(f)) defineScript(f)
}
