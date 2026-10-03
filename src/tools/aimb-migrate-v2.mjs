#!/usr/bin/env node
// aimb-migrate-v2 — #88 (v2.0): convert THIS host's 1.7x activity history (v5 day files) into 2.0 history (v6 day files,
// index files, the format marker), in place, with a temporary backup. docs/spec-88.md §7.1 (the runbook), §7.2 (this
// script), §10 (the Dropbox rules); the work is in lib/activity2-migrate.js.
//
//   node src/tools/aimb-migrate-v2.mjs --dry-run      # reads, reports, writes nothing — run it first
//   node src/tools/aimb-migrate-v2.mjs                # converts, verifies, removes the backup
//
// Options:
//   --dry-run          run the checks and the whole conversion in memory; print the report; write nothing
//   --dir <path>       the persistence directory (default: the bridge's own — AI_BRIDGE_PERSIST_DIR, else
//                      persistence.dir in the config, else <repo>/persistence)
//   --host <name>      the host whose directory to convert (default: the bridge's — AI_BRIDGE_TEST_HOSTNAME, else the
//                      machine name); each host converts ONLY its own activity/<host>/ (the Dropbox pair: run it on each)
//   --port <n>         the bridge's control port to check (default: AI_BRIDGE_PORT, else `port` in the config, else 12317)
//   --config <file>    the bridge config to read (default: AI_BRIDGE_CONFIG, else src/config.json) — READ only, for
//                      persistence.dir, port, bind and the activity block
//   --json             print one JSON line (the report) instead of text
// Exit: 0 converted / nothing to do; 2 refused (a bridge is running, a writer is active, …: nothing was written);
//       3 failed (the v5 files restored — or, if that failed too, the backup kept and named); 64 a bad command line.
// Run it only with EVERY bridge on this host stopped (tray, service, auto-start, MCP-spawned bridges): it refuses while
// this host's gateway answers on its port.
//
// Test hooks (tests only): AIMB_TEST_MIGRATE_STOP=<point> exits 9 at that point, as a crash would ('backup', 'day:N',
// 'marker', 'delete'); AIMB_TEST_MIGRATE_CORRUPT=1 appends a byte to the first converted day file before verifying.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../lib/activity.js'
import { hostDir } from '../lib/activity2-files.js'
import { migrate, probeGateway, EXIT } from '../lib/activity2-migrate.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')
const USAGE = 'usage: node src/tools/aimb-migrate-v2.mjs [--dry-run] [--dir <persistence dir>] [--host <name>] [--port <n>] [--config <file>] [--json]'

function parseArgs(argv) {
  const o = { dryRun: false, json: false, dir: null, host: null, port: null, config: null, help: false }
  const takes = { '--dir': 'dir', '--host': 'host', '--port': 'port', '--config': 'config' }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v = null
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq) }
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--json') o.json = true
    else if (a === '--help' || a === '-h') o.help = true
    else if (takes[a]) {
      if (v === null) { v = argv[++i]; if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` } }
      if (!String(v).trim()) return { error: `${a} needs a value` }
      o[takes[a]] = v
    } else return { error: `unknown argument ${a}` }
  }
  if (o.port != null && !(/^\d+$/.test(o.port) && +o.port > 0 && +o.port < 65536)) return { error: `--port ${o.port}: not a port number` }
  return o
}

const tilde = p => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)
function out(o, res) {
  if (o.json) { process.stdout.write(JSON.stringify({ code: res.code, status: res.status, message: res.message, lines: res.lines, warnings: res.warnings, report: res.report }) + '\n'); return }
  for (const w of res.warnings) process.stdout.write(`WARN ${w}\n`)
  const r = res.report || {}
  for (const x of r.relabelled || []) process.stdout.write(`  label made unique: session ${x.session}, under ${x.path || '(root)'}: "${x.label}" → "${x.got}"\n`)
  for (const x of r.keyed || []) process.stdout.write(`  agent key slugged: session ${x.session}: "${x.name}" → key ${x.key}\n`)
  for (const l of res.lines) process.stdout.write(`  ${l}\n`)
  process.stdout.write(`${res.code === EXIT.ok ? '' : res.code === EXIT.refused ? 'REFUSED: ' : 'FAILED: '}${res.message}\n`)
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.error) { process.stderr.write(`aimb-migrate-v2: ${o.error}\n${USAGE}\n`); return EXIT.usage }
  if (o.help) { process.stdout.write(USAGE + '\n'); return EXIT.ok }
  // the bridge's own rules (bridge.mjs: CONFIG_FILE, PORT, BIND, HOSTNAME; facets/persistence/file.js: the root)
  const env = process.env
  const cfgFile = path.resolve(tilde(o.config || env.AI_BRIDGE_CONFIG || path.join(SRC, 'config.json')))
  let CFG = {}
  if (fs.existsSync(cfgFile)) {
    try { CFG = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {} } catch (e) { process.stderr.write(`aimb-migrate-v2: the config ${cfgFile} is not valid JSON (${e.message})\n`); return EXIT.refused }
  } else if (o.config) { process.stderr.write(`aimb-migrate-v2: the config ${cfgFile} does not exist\n`); return EXIT.usage }
  const dir = path.resolve(o.dir ? tilde(o.dir) : path.resolve(SRC, env.AI_BRIDGE_PERSIST_DIR || (CFG.persistence && CFG.persistence.dir) || '../persistence'))
  const host = String(o.host || env.AI_BRIDGE_TEST_HOSTNAME || os.hostname()).trim()
  const port = Number(o.port || env.AI_BRIDGE_PORT || CFG.port || 12317)
  const bind = env.AI_BRIDGE_BIND || CFG.bind || '127.0.0.1'
  const cfgWarn = []
  const config = resolveConfig(CFG.activity, env, cfgWarn)
  if (!o.json) process.stdout.write(`aimb-migrate-v2${o.dryRun ? ' (dry run)' : ''}: host ${host}, ${hostDir(dir, host)}\n`)
  for (const w of cfgWarn) if (!o.json) process.stdout.write(`WARN activity config: ${w}\n`)

  const hook = (point, ctx) => {
    if (env.AIMB_TEST_MIGRATE_CORRUPT && point === 'verify') {
      const d = hostDir(ctx.dir, ctx.host), first = fs.readdirSync(d).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()[0]
      if (first) fs.appendFileSync(path.join(d, first), '\n')
    }
    if (env.AIMB_TEST_MIGRATE_STOP && env.AIMB_TEST_MIGRATE_STOP === point) { process.stdout.write(`(test hook: stopped at ${point})\n`); process.exit(EXIT.crashed) }
  }
  const res = await migrate({ dir, host, config, dryRun: o.dryRun, probe: () => probeGateway({ port, bind }), hook })
  out(o, res)
  return res.code
}

main().then(code => { process.exitCode = code }, e => { process.stderr.write(`aimb-migrate-v2: ${(e && e.stack) || e}\n`); process.exitCode = EXIT.failed })
