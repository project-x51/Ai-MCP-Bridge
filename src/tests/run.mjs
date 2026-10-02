#!/usr/bin/env node
// Test runner front-end (#81): picks the node:test drivers and runs `node --test` with the spec + dashboard reporters.
//   node tests/run.mjs                       every group, in parallel (what `npm test` runs)
//   node tests/run.mjs group <g> [<g> …]     those groups (in parallel when several)       npm run test:group -- mesh
//   node tests/run.mjs file <name> [<name> …] those scripts, through their groups' drivers   npm run test:file -- test_mesh
//   node tests/run.mjs serial                every script one at a time, historical order   npm run test:serial
// Options: --only <text>        TEST_ONLY: report only the checks whose name contains <text> (every selected script still runs)
//          --concurrency <n>    how many group drivers run at once (default 4)
//          --list               print the groups and their scripts, run nothing
// A <name> is a script name or id (test_mesh, mesh/test_mesh) or any part of one (activity_6c, federat): see manifest.selected.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS, ORDER, GROUP_OF, fileId, selected } from './helpers/manifest.mjs'

const SRC = fileURLToPath(new URL('../', import.meta.url))
const REPORTERS = ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=./tests/reporters/aimb-dashboard.mjs', '--test-reporter-destination=stdout']
const die = msg => { console.error(`run.mjs: ${msg}`); process.exit(64) }

const argv = process.argv.slice(2), words = []
let only = null, concurrency = 4, list = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--only') { only = argv[++i]; if (only == null) die('--only needs a value') }
  else if (a.startsWith('--only=')) only = a.slice(7)
  else if (a === '--concurrency') concurrency = Number(argv[++i])
  else if (a.startsWith('--concurrency=')) concurrency = Number(a.slice(14))
  else if (a === '--list') list = true
  else if (a.startsWith('--')) die(`unknown option ${a}`)
  else words.push(a)
}
if (!(concurrency >= 1)) die('--concurrency needs a number ≥ 1')
const mode = words.shift() || 'all'

if (list) {
  for (const [g, fs] of Object.entries(GROUPS)) console.log(`${g.padEnd(12)} ${fs.join(' ')}`)
  process.exit(0)
}

const env = { ...process.env }
let drivers
if (mode === 'all') drivers = Object.keys(GROUPS)
else if (mode === 'group') {
  if (!words.length) die(`group needs a name: ${Object.keys(GROUPS).join(', ')}`)
  const bad = words.filter(g => !GROUPS[g])
  if (bad.length) die(`unknown group ${bad.join(', ')} (have: ${Object.keys(GROUPS).join(', ')})`)
  drivers = words
} else if (mode === 'file') {
  if (!words.length) die('file needs a script name, e.g. test_mesh')
  const spec = words.join(',')
  const hit = ORDER.filter(f => selected(f, spec))
  if (!hit.length) die(`no test script matches "${spec}" (try: node tests/run.mjs --list)`)
  env.AIMB_TEST_SELECT = spec
  drivers = [...new Set(hit.map(f => GROUP_OF[f]))]
  console.error(`run.mjs: ${hit.map(fileId).join(', ')}`)
} else if (mode === 'serial') drivers = null
else die(`unknown mode "${mode}" — all | group <g…> | file <name…> | serial`)
if (only != null) env.TEST_ONLY = only

// longest group first (serial seconds, 2026-10-03: activity ~205, federation ~150, security ~110, persistence ~90, mesh ~90,
// dashboard ~45, doorbell ~25, behaviors ~10, unit ~1), so a long group never starts last
const LONGEST_FIRST = ['activity', 'federation', 'security', 'persistence', 'mesh', 'dashboard', 'doorbell', 'behaviors', 'unit']
const rank = g => { const i = LONGEST_FIRST.indexOf(g); return i < 0 ? LONGEST_FIRST.length : i }
if (drivers) drivers.sort((a, b) => rank(a) - rank(b))
const files = drivers ? drivers.map(g => `tests/${g}/${g}.test.mjs`) : ['tests/suite.test.mjs']
const args = ['--test', `--test-concurrency=${drivers ? concurrency : 1}`, ...REPORTERS, ...files]
console.error(`run.mjs: node ${args.join(' ')}${only != null ? `   (TEST_ONLY=${only})` : ''}`)
const child = spawn(process.execPath, args, { cwd: SRC, env, stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { try { child.kill(s) } catch { } })
