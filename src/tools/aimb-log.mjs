#!/usr/bin/env node
// aimb-log (#70 step 3, v1.59.0; the 2.0 forms since #88 build step 9) — report an agent's / a script's status to this host's
// activity board WITHOUT registering.
//
// Why: an orchestrating session puts ONE line in each agent's prompt ("report with: node aimb-log.mjs --session X
// --project P --agent research --label "Research" --under fix-x"), and the agent (or any long-running script) reports
// progress with it. The bridge's `log` tool needs a registered sub-peer (as + secret); this script instead attaches to the
// GATEWAY's WS port as a token-gated `logger` leaf — the same trust as the doorbell (Robin, 2026-10-01: anyone holding the
// realm token may report as any session) — EXCEPT that the gateway refuses to speak for a session that is LIVE on the mesh
// roster under another user (code session-user-mismatch). A script-only session is never marked gone; it can go stale.
//
// #88 (2.0, docs/spec-88.md §4): THE 2.0 FORMS — and only those (Q19: every 1.7x form is refused `legacy-form`, exit 64,
// with a message naming the 2.0 form). Every node has a stable id, a KEY its creator chose and a LABEL (its name):
//   --agent <chain>            the agent you report as ("spec-88", "spec-88/research"): your keys live in its scope. A call
//                              with no --key / --id / --path targets the agent itself, and creates it when new (with --label).
//   --key <k>                  YOUR node — created by the first call that names it (a context; --label is REQUIRED then:
//                              label-required; --under / a position place it). Later calls: just --key <k> (§3.5: location
//                              and label are set only at creation; a different --under / --label is ignored, warning exists).
//   --id <id>                  a node by its internal id (the dashboard's copied command; a result's node.id).
//   --path "A/B"               the shorthand: labels from the session root (or from --agent), no @, a label holding "/"
//                              in double quotes; it walks the live tree, then the aliases of moved nodes, then creates.
//   --ctx "<label>"            (kept, §4.5) one more path segment below --agent / --path: --agent a --ctx Notes = the
//                              context "Notes" under a. A 1.7x "@Ctx" / "@~Ctx" is refused legacy-form.
//   --under <ref>  --label "<name>"   where / what a NEW target is (a sibling with that label → "<name> (2)", reported).
//   --text "<text>"            plain text only LOGS; a LEADING @ also SETS the node's line ("@Writing the docs"); @@ = a
//                              literal @. --state / --done / --progress / --eta / --stale-after change the node whatever
//                              the text. Finish with --state done --text "@<summary>".
//   --item <k> "<label>"       a ☐ plan item under the target (repeatable, in order); --item "<label>" (one value: the
//                              second argument starts with -- or the first isn't a valid key) = label only, key = its slug.
//   --before <ref> / --after <ref> / --first / --last    place new items / a new target / a --move; alone = reorder.
//   --move <ref> [--rename "<label>"]   re-parent the target (+ relabel: one checked change); --rename alone relabels.
//   --merge <ref> / --unmerge  merge the target into another context / undo it (§3.6).
//   --move-to "../X" | "/A/B"  after the report, move the target there (one all-or-nothing call; only ../X — beside its
//                              parent — or an absolute path; anything else is refused bad-path with suggest:"/…"); missing
//                              destinations are created TRANSIENT (they vanish when emptied).
//   --transient[=30s] / --keep a NEW context vanishes when its last child leaves (after the grace) / make one permanent.
//   --resolve "<path>"         print what a relative (or absolute) path resolves to NOW from the target's parent (Q46):
//                              { path:"/…", id, state, create } — changes nothing.
//   --context-type=<type>      a NEW context's type: context | plan | group | test-run.
//   --message-type=<type>      the entry's type (default note); a type's typed fields are flags of their own:
//                              --message-type=test-result --result pass --checks 22 --failed 0 --duration 4.1s.
//   --ask "<question>" --choice "A" --choice "B" [--free] [--expires 2h] [--wait 30m]   a question (state it only; the
//                              choices are listed below it as the answers); --wait waits on the same link for the answer.
//   --wait-answer [--key K | --id I | --path P] [--wait 30m]   wait for an existing question's answer.
//   --guide agent|session      print the how-to; `--guide agent` WITH --agent (+ --label, --under) is the agent's FIRST
//                              REPORT: it puts the agent on the board (state running, "reading the guide") when it is
//                              not there yet — and only prints when it is (a re-read never clobbers a line).
//   --batch <file.json|->      a JSON ARRAY of items (each the `log` tool's fields + ref) in ONE call → one line
//                              {ok, results:[…], applied, failed}; --agent / --no-log are defaults for every item.
//   --stream                   NDJSON on stdin (an object, or an array = a batch, per line) → one result line each, in
//                              order, over ONE connection; --agent / --no-log are defaults a line may override. Each
//                              result line is { line: <input line number>, ref?, …the result } — the result's own `line`
//                              flag (§4.2: the report set the line) is `line_set` there, so the two never collide.
// REMOVED (refused legacy-form, exit 64): positional text, --plan "A" "B", --move … --to, "@" at a path segment's start,
// "@~" (in a path, a text or an --item), and the tool's to / note / context fields in a batch or stream line.
// The 2.0 script talks only to a 2.0 gateway: the gateway's welcome says `activity_format: 6`; anything else → exit 4
// `gateway-unsupported` before a report is sent (apart from --guide, which prints its built-in text against anything).
//
// Identity: --session and --project are required; --user defaults to AI_BRIDGE_USER, else the OS login user
// (os.userInfo().username); the realm is AI_BRIDGE_REALM, else config.json `realm`, else "default" (as the bridge).
// Token / port: --token-file (#75), else AI_BRIDGE_TOKEN (or AI_BRIDGE_TOKEN_FILE, as the bridge #46) else config.json's
// `token`; --ws-port / --url / AI_BRIDGE_WS_PORT else config.json's `wsPort` (12318). config.json is found relative to THIS
// SCRIPT (../config.json), or AI_BRIDGE_CONFIG names it (tests). `--token` is REFUSED (exit 64): argv is world-readable in
// the process list and the realm token is also the body-encryption key. The token is never printed.
//
// Exit codes: 0 ok (stream: stdin EOF) · 4 the bridge said no / transport error (no bridge, link lost, timeout, a gateway
// that does not speak 2.0) · 64 bad usage (a missing flag, bad JSON, a 1.7x form, a report the bridge would reject).
// --wait / --wait-answer: 0 answered · 10 the wait ran out (still open) · 11 expired · 12 withdrawn · 13 gone.
// stdout is ONE JSON line (the bridge's `log` result, or {ok:false, code, what}); usage text goes to stderr.
// Protocol: hello {type:"hello", kind:"logger", token, ident:{session, project, user, realm}} → {type:"welcome", logger:true,
// bridge_version, activity_format, ident} | {type:"error", code, what}; then {type:"log", ref, input} → {type:"logged", ref,
// result}; {type:"wait_answer", ref, node_id | (agent?, key | id | path), timeout_ms} → {type:"answer", ref, result};
// {type:"resolve", ref, input} → {type:"resolved", ref, result}; {type:"guide", ref, kind, cmd, path, agent, label, under,
// script} → {type:"guide", ref, ok, kind, text|null, source, updated_at, board?, …}.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { parseDuration, validKey, formatPath2 } from '../lib/activity.js'
import { parseCall, splitBatch2, LOG2_FIELDS, LEGACY2_FIELDS, MESSAGE_TYPES } from '../lib/activity2.js'
import { logCmd, guideText, guideSourceLine, GUIDE_KINDS } from '../lib/log-snippet.js'   // v1.73.0 (#89): --guide; v1.74.0: + the realm's guide

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ACTIVITY_FORMAT = 6   // what a 2.0 gateway's welcome says (activity_format)
const USAGE = [
  'usage: aimb-log.mjs --session <name> --project <P> [--token-file f] [--user U] [--agent <chain>] [--key <k> | --id <id> | --path "A/B"] [--ctx "<label>"]',
  '         [--under <ref>] [--label "<name>"] [--text "<text>"  (a leading @ sets the line)] [--state S | --done] [--progress 3/6] [--eta 1h25m] [--stale-after 60m]',
  '         [--details "..."] [--data \'{...}\' | --data-file f.json] [--no-log] [--item <k> "<label>" | --item "<label>" …] [--before <ref> | --after <ref> | --first | --last]',
  '         [--move <ref>] [--rename "<label>"] [--merge <ref> | --unmerge] [--move-to "../X" | "/A/B"] [--transient[=30s] | --keep]',
  '         [--context-type=context|plan|group|test-run] [--message-type=test-result --result pass|fail|skip --checks N --failed N --duration 4.1s]',
  '       aimb-log.mjs … --ask "<question>" [--choice "A" --choice "B" …] [--free] [--expires 2h] [--details "..."] [--wait 30m]   (exit 0 answered, 10 still open, 11 expired, 12 withdrawn, 13 gone)',
  '       aimb-log.mjs … --wait-answer [--agent a] [--key K | --id I | --path P] [--wait 30m]   (wait for an existing question\'s answer)',
  '       aimb-log.mjs … --resolve "<path>" [--agent a] [--key K | --id I | --path P]   (what a path resolves to now; changes nothing)',
  '       aimb-log.mjs … --guide agent|session [--agent <key> --label "<name>" --under <item key>]   (print the rules; with --agent: your first report)',
  '       aimb-log.mjs --stream | --batch <items.json|-> --session <name> --project <P> [--user U] [--agent a] [--no-log]   (the log tool\'s fields per line / item)',
].join('\n')
// the typed fields of the settable message types, as flags (§1.7: "the flag is the field's name") → the types that declare it
const FIELD_FLAGS = new Map()
for (const [t, T] of Object.entries(MESSAGE_TYPES)) if (T.settable) for (const f of Object.keys(T.fields || {})) FIELD_FLAGS.set(f, [...(FIELD_FLAGS.get(f) || []), t])
const VALUE_FLAGS = new Set(['session', 'project', 'user', 'agent', 'key', 'id', 'path', 'ctx', 'under', 'label', 'state', 'progress', 'eta', 'stale-after', 'details', 'data', 'data-file', 'batch',
  'ws-port', 'url', 'token-file', 'text', 'move', 'rename', 'merge', 'move-to', 'resolve', 'before', 'after', 'ask', 'expires', 'wait', 'guide', 'context-type', 'message-type', ...FIELD_FLAGS.keys()])
const BOOL_FLAGS = new Set(['no-log', 'stream', 'help', 'done', 'first', 'last', 'free', 'wait-answer', 'unmerge', 'keep'])
const OPT_FLAGS = new Set(['transient'])   // a boolean, or =<value> (Q44: the = form only, so nothing is positional)
const STREAM_FLAGS = new Set(['session', 'project', 'user', 'agent', 'no-log', 'stream', 'ws-port', 'url', 'token-file'])
const BATCH_FLAGS = new Set(['session', 'project', 'user', 'agent', 'no-log', 'batch', 'ws-port', 'url', 'token-file'])
const ADDR_FLAGS = ['session', 'project', 'user', 'agent', 'key', 'id', 'path', 'ctx', 'ws-port', 'url', 'token-file']
const LINE_FIELDS = [...LOG2_FIELDS, ...LEGACY2_FIELDS]   // a stream line / batch item (the 1.7x ones only so the parser can name the 2.0 form)
const num = (v, d) => (Number(v) > 0 ? Number(v) : d)
const TIMEOUT_MS = num(process.env.AIMB_LOG_TIMEOUT_MS, 8000)          // one-shot: connect + hello + reply; stream: hello + each reply
const LINE_WAIT_MS = num(process.env.AIMB_LOG_LINE_WAIT_MS, 10000)     // stream: how long a line may wait for a (re)connected link
const BACKOFF_MAX_MS = num(process.env.AIMB_LOG_BACKOFF_MAX_MS, 5000)  // stream: reconnect backoff cap (starts at 200 ms, doubles)
const FATAL = new Set(['unauthorized', 'ident-required', 'bad-ident', 'realm-mismatch', 'gateway-unsupported', 'already-hello'])

let exiting = false
function finish(code, obj) {   // print ONE JSON line (if any), then exit once stdout has drained
  if (exiting) return
  exiting = true
  const out = obj ? JSON.stringify(obj) + '\n' : ''
  process.stdout.write(out, () => process.exit(code))
}
function usage(code, what, extra) { console.error(USAGE); finish(64, { ok: false, code, what, ...(extra || {}) }) }
const legacy = what => usage('legacy-form', what)
const short = (v, n = 60) => { const s = String(v); return s.length > n ? s.slice(0, n - 3) + '…' : s }

// ---- argv
const flags = /** @type {any} */ ({}), words = []
{
  const argv = process.argv.slice(2)
  let err = null
  for (let i = 0; i < argv.length && !err; i++) {
    const a = argv[i]
    if (a === '--') { words.push(...argv.slice(i + 1)); break }
    if (!a.startsWith('--') || a.length === 2) { words.push(a); continue }
    const eq = a.indexOf('=')
    const name = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase()
    if (name === 'token') { err = ['token-in-argv', '--token is refused: a token on the command line is visible in the process list. Pass --token-file <path>, set AI_BRIDGE_TOKEN (or AI_BRIDGE_TOKEN_FILE), or let it read the bridge\'s config.json']; break }
    // §4.5: the removed 1.7x flags, each refused with the 2.0 form
    if (name === 'plan') { err = ['legacy-form', '--plan was removed in 2.0: use --item "A" --item "B" (or --item <key> "<label>")']; break }
    if (name === 'to') { err = ['legacy-form', '--move … --to was removed in 2.0: use --key <node> --move <parent> (or --path … --move …)']; break }
    if (name === 'item') {   // --item <k> "<label>" (two values) | --item "<label>" (one) — §4.1's parse rule (H11)
      if (eq > 0) { flags.items = (flags.items || []).concat([a.slice(eq + 1)]); continue }
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) { err = ['usage', '--item needs a label: --item <key> "<label>" or --item "<label>"']; break }
      i++
      const w = argv[i + 1]
      if (w !== undefined && !w.startsWith('--') && validKey(v).ok) { i++; flags.items = (flags.items || []).concat([{ key: v, label: w }]) }
      else flags.items = (flags.items || []).concat([v])
      continue
    }
    if (name === 'choice') {   // ONE choice per --choice, repeatable, in command-line order (never positional)
      const v = eq > 0 ? a.slice(eq + 1) : argv[i + 1]
      if (eq < 0) { if (v === undefined || v.startsWith('--')) { err = ['usage', '--choice needs a value: --choice "A" --choice "B"']; break } i++ }
      flags.choices = (flags.choices || []).concat([v]); continue
    }
    if (OPT_FLAGS.has(name)) { flags[name] = eq > 0 ? a.slice(eq + 1) : true; continue }
    if (BOOL_FLAGS.has(name)) { if (eq > 0) err = ['usage', `--${name} takes no value`]; else flags[name] = true; continue }
    if (!VALUE_FLAGS.has(name)) { err = ['usage', `unknown flag --${name}`]; break }
    const v = eq > 0 ? a.slice(eq + 1) : argv[i + 1]
    // --text is explicit, so its value may itself start with "--" ("--text/--item built"); only a real flag name counts as missing
    const isFlag = s => { const m = /^--([A-Za-z-]+)(=|$)/.exec(s); return !!m && (VALUE_FLAGS.has(m[1].toLowerCase()) || BOOL_FLAGS.has(m[1].toLowerCase()) || OPT_FLAGS.has(m[1].toLowerCase()) || ['plan', 'to', 'item', 'token', 'choice'].includes(m[1].toLowerCase())) }
    const missing = v === undefined || (v.startsWith('--') && (name !== 'text' || isFlag(v)))
    if (eq < 0) { if (missing) { err = ['usage', `--${name} needs a value`]; break } i++ }
    flags[name] = v
  }
  if (err) usage(err[0], err[1])
}
if (!exiting && flags.help) { console.error(USAGE); finish(0, null) }
// positional text was removed (§4.5); `--` still ends the flags, but what follows is not text any more
if (!exiting && words.length) legacy(`positional text was removed in 2.0: use --text "…" (a leading @ sets the line) — got "${short(words.join(' '), 40)}"`)
// "@~" at the start of an item / a choice (the 1.7x "--plan … "@~root headline"" slip): refused, naming the 2.0 form
if (!exiting) for (const it of flags.items || []) { const l = typeof it === 'string' ? it : it.label; if (/^\s*@~/.test(l)) { legacy(`@~ was removed in 2.0: an --item is a label ("${short(l.replace(/^\s*@~/, ''))}"); set a line with --text "@…"`); break } }

// ---- config: token, port, realm (never printed)
function readTokenFile(p) {
  try {
    const raw = fs.readFileSync(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p, 'utf8')
    const m = raw.match(/^\s*AI_BRIDGE_TOKEN\s*=\s*(.+?)\s*$/m)
    return (m ? m[1] : raw).trim()
  } catch { return '' }
}
const CONFIG_FILE = process.env.AI_BRIDGE_CONFIG
  ? path.resolve(process.env.AI_BRIDGE_CONFIG.startsWith('~') ? path.join(os.homedir(), process.env.AI_BRIDGE_CONFIG.slice(1)) : process.env.AI_BRIDGE_CONFIG)
  : path.join(HERE, '..', 'config.json')
let CFG = {}
try { CFG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {} } catch { }
// v1.64.0 (#75): an EXPLICIT --token-file is the only source when given (unreadable / empty → exit 64 naming the file)
const TOKEN_FILE_ARG = typeof flags['token-file'] === 'string' ? flags['token-file'] : null
const TOKEN = TOKEN_FILE_ARG != null ? readTokenFile(TOKEN_FILE_ARG)
  : (process.env.AI_BRIDGE_TOKEN || (process.env.AI_BRIDGE_TOKEN_FILE ? readTokenFile(process.env.AI_BRIDGE_TOKEN_FILE) : '') || CFG.token || '')
const WSPORT = flags['ws-port'] || process.env.AI_BRIDGE_WS_PORT || CFG.wsPort || 12318
const URL_ = flags.url || `ws://127.0.0.1:${WSPORT}`
const REALM = process.env.AI_BRIDGE_REALM || CFG.realm || 'default'
const OS_USER = (() => { try { return os.userInfo().username || '' } catch { return process.env.USERNAME || process.env.USER || '' } })()
const ident = { session: String(flags.session || '').trim(), project: String(flags.project || '').trim(), user: String(flags.user || process.env.AI_BRIDGE_USER || OS_USER || '').trim(), realm: REALM }
const nowOpts = () => ({ now: Date.now(), tzOffsetMin: -new Date().getTimezoneOffset() })

/** The command line's ADDRESS (§3): --agent, --key | --id | --path, --ctx (a label below --agent / --path). → { addr } | { err } */
function addressOf() {
  const a = /** @type {any} */ ({})
  if (flags.agent != null) a.agent = flags.agent
  for (const k of ['key', 'id', 'path']) if (flags[k] != null) a[k] = flags[k]
  if (flags.ctx != null) {
    const c = String(flags.ctx).trim()
    if (c.startsWith('@')) return { err: ['legacy-form', `--ctx takes a label in 2.0 (no @): --ctx "${short(c.replace(/^@~?/, '').replace(/^"(.*)"$/, '$1'))}" — set its line with --text "@…"`] }
    if (a.key != null || a.id != null) return { err: ['bad-address', '--ctx names a context below --agent / --path — not with --key / --id'] }
    if (!c) return { err: ['usage', '--ctx needs a label'] }
    a.path = (a.path != null && String(a.path).trim() ? String(a.path).trim().replace(/\/+$/, '') + '/' : '') + formatPath2([c])
  }
  return { addr: a }
}

// ---- what to do: one report (oneShot), a wait, a resolve, a batch, a stream or a guide
const STREAM = !!flags.stream, BATCH = flags.batch != null
const defaults = /** @type {any} */ ({})
if (flags.agent != null) defaults.agent = flags.agent
if (flags['no-log']) defaults.log = false
let oneShot = /** @type {any} */ (null), RESOLVE = /** @type {any} */ (null)
let WAIT = /** @type {{ ms: number, addr: any }|null} */ (null)   // wait for an answer (addr = an existing question's address; null = the one --ask posts)
const EXIT_OF = { answered: 0, timeout: 10, expired: 11, withdrawn: 12, gone: 13 }   // #85: the wait's outcome → exit code
if (!exiting && flags.guide != null) {
  if (!GUIDE_KINDS.includes(String(flags.guide).toLowerCase())) usage('usage', `--guide takes one of: ${GUIDE_KINDS.join(' / ')}`)
  else {
    const extra = Object.keys(flags).filter(k => !['guide', 'session', 'project', 'user', 'agent', 'label', 'under', 'path', 'ws-port', 'url', 'token-file'].includes(k))
    if (extra.length) usage('usage', `--guide prints the rules (and, with --agent, puts you on the board) — not --${extra.join(' / --')}`)
    else setImmediate(runGuide)
  }
}
if (!exiting && flags.guide == null) {
  if (!ident.session) usage('usage', '--session <name> is required')
  else if (!ident.project) usage('usage', '--project <P> is required')
  else if (!ident.user) usage('usage', 'no user: pass --user (the OS login user could not be read)')
  else if (!TOKEN && TOKEN_FILE_ARG != null) usage('no-token', `no realm token: --token-file ${TOKEN_FILE_ARG} could not be read (or is empty)`, { token_file: TOKEN_FILE_ARG })
  else if (!TOKEN) usage('no-token', `no realm token: pass --token-file <path> (the file the bridge reads with AI_BRIDGE_TOKEN_FILE), set AI_BRIDGE_TOKEN_FILE / AI_BRIDGE_TOKEN, or put it in ${CONFIG_FILE} (read relative to this script, not the working directory)`)
  else if (STREAM && BATCH) usage('usage', '--stream and --batch are exclusive (a stream line may itself be an array)')
  else if (BATCH) {
    const extra = Object.keys(flags).filter(k => !BATCH_FLAGS.has(k))
    if (extra.length) usage('usage', `--batch takes the report fields per item, not --${extra.join(' / --')} (beside the items: --agent / --no-log)`)
  } else if (STREAM) {
    const extra = Object.keys(flags).filter(k => !STREAM_FLAGS.has(k))
    if (extra.length) usage('usage', `--stream takes the report fields per line, not --${extra.join(' / --')} (defaults: --agent / --no-log)`)
  } else if (flags.resolve != null) {
    const extra = Object.keys(flags).filter(k => k !== 'resolve' && !ADDR_FLAGS.includes(k))
    const ad = addressOf()
    if (extra.length) usage('usage', `--resolve changes nothing: it takes --agent / --key / --id / --path (the node it is relative to) — not --${extra.join(' / --')}`)
    else if (ad.err) usage(ad.err[0], ad.err[1])
    else {
      const pc = parseCall(ad.addr)
      if (!pc.ok) usage(pc.code || 'bad-input', pc.what || 'invalid address')
      else RESOLVE = { ...ad.addr, resolve: flags.resolve }
    }
  } else {
    const ad = addressOf()
    if (ad.err) usage(ad.err[0], ad.err[1])
    const input = /** @type {any} */ ({ ...(ad.addr || {}) })
    if (flags['no-log']) input.log = false
    for (const [f, k] of [['under', 'under'], ['label', 'label'], ['text', 'text'], ['state', 'state'], ['progress', 'progress'], ['eta', 'eta'], ['stale-after', 'stale_after'], ['details', 'details'],
      ['move', 'move'], ['rename', 'rename'], ['merge', 'merge'], ['move-to', 'move_to'], ['before', 'before'], ['after', 'after'], ['context-type', 'context_type'], ['message-type', 'message_type'],
      ['ask', 'ask'], ['expires', 'expires']]) if (flags[f] != null) input[k] = flags[f]
    if (flags.items) input.plan = flags.items
    if (flags.choices) input.choices = flags.choices
    if (flags.free) input.free = true
    if (flags.unmerge) input.unmerge = true
    if (flags.keep) input.keep = true
    if (flags.transient != null) input.transient = flags.transient === true ? true : flags.transient
    // the typed fields (§1.7): each flag is its field's name, for the --message-type that declares it
    const typed = [...FIELD_FLAGS.keys()].filter(f => flags[f] != null)
    if (typed.length) {
      const mt = flags['message-type'] != null ? String(flags['message-type']).trim().toLowerCase() : null
      const stray = typed.filter(f => !mt || !FIELD_FLAGS.get(f).includes(mt))
      if (!exiting && stray.length) usage('bad-fields', `--${stray.join(' / --')} ${stray.length > 1 ? 'are fields' : 'is a field'} of --message-type=${FIELD_FLAGS.get(stray[0]).join('|')}${mt ? ` (not of ${mt})` : ' — give the type too'}`)
      input.fields = Object.fromEntries(typed.map(f => [f, flags[f]]))
    }
    if (exiting) { /* usage printed */ } else if (flags.first && flags.last) usage('usage', '--first and --last are exclusive')
    else if (flags.first || flags.last) input.position = flags.first ? 'first' : 'last'
    if (exiting) { /* usage printed */ } else if (flags.done && flags.state != null) usage('usage', '--done and --state are exclusive (--done = --state done)')
    else if (flags.done) input.state = 'done'
    if (exiting) { /* usage printed */ } else if (flags.data != null && flags['data-file'] != null) usage('usage', '--data and --data-file are exclusive')
    else if (flags.data != null) { try { input.data = JSON.parse(flags.data) } catch (e) { usage('bad-data', `--data is not JSON: ${e.message}`) } }
    else if (flags['data-file'] != null) {
      let raw = null
      try { raw = fs.readFileSync(String(flags['data-file']), 'utf8') } catch (e) { usage('bad-data', `--data-file unreadable: ${e.code || e.message}`) }
      if (raw != null) { try { input.data = JSON.parse(raw.replace(/^﻿/, '')) } catch (e) { usage('bad-data', `--data-file is not JSON: ${e.message}`) } }
    }
    // #85: --wait (with --ask) / --wait-answer (an existing question): how long to wait for the answer
    if (!exiting && (flags.wait != null || flags['wait-answer'])) {
      const ms = flags.wait != null ? parseDuration(flags.wait) : 30 * 60000
      if (!Number.isFinite(ms) || ms <= 0 || ms > 24 * 3600000) usage('usage', '--wait takes a duration > 0 and ≤ 24h, e.g. 30m or 2h')
      else if (flags['wait-answer']) {
        const extra = Object.keys(flags).filter(k => !ADDR_FLAGS.includes(k) && !['wait', 'wait-answer'].includes(k))
        if (extra.length) usage('usage', `--wait-answer waits for an existing question (--key / --id / --path, + --agent) — not --${extra.join(' / --')}`)
        else if (ad.addr && ad.addr.key == null && ad.addr.id == null && ad.addr.path == null) usage('usage', '--wait-answer needs the question: --key <its key> (e.g. ?1), --id <its node.id> or --path <its path>')
        else { const pc = parseCall(ad.addr || {}); if (!pc.ok) usage(pc.code || 'bad-input', pc.what || 'invalid address'); else WAIT = { ms, addr: ad.addr } }
      } else if (flags.ask == null) usage('usage', '--wait waits for the answer to a question: use it with --ask "…" (or --wait-answer --key <question>)')
      else WAIT = { ms, addr: null }
    }
    if (!exiting && !flags['wait-answer']) {   // --wait-answer sends no report
      const p = parseCall(input, nowOpts())   // the gateway's own parser: a bad report costs no connection (exit 64)
      if (!p.ok) usage(p.code || 'bad-input', p.what || 'invalid report', p.suggest ? { suggest: p.suggest } : undefined)
      else oneShot = input
    }
  }
}

// ---- the link
function hello(ws) { ws.send(JSON.stringify({ type: 'hello', kind: 'logger', token: TOKEN, ident })) }
const is2 = m => !!m && m.logger === true && Number(m.activity_format) === ACTIVITY_FORMAT
const unsupported = m => ({ ok: false, code: 'gateway-unsupported', what: !m || !m.logger ? `the bridge on ${URL_} is not a gateway that takes reports (bridge ${(m && m.bridge_version) || '?'})`
  : `the gateway on ${URL_} runs bridge ${m.bridge_version || '?'}, which does not speak the 2.0 activity forms — this aimb-log needs a 2.0 gateway (upgrade every host together: docs/spec-88.md §7.1)` })

// ---- a batch: read the array (file or stdin), check it locally, then ONE call like a one-shot (exit 0 only when every item applied)
function batchInput(items) {
  if (!Array.isArray(items)) return { err: { code: 'bad-batch', what: 'a batch is a JSON array of items' } }
  const input = { ...defaults, items }
  const sp = splitBatch2(input)
  return sp.ok ? { input } : { err: { code: sp.code, what: sp.what } }
}
async function readBatch() {
  let raw
  try {
    if (flags.batch === '-') { const chunks = []; for await (const c of process.stdin) chunks.push(c); raw = Buffer.concat(chunks).toString('utf8') }
    else raw = fs.readFileSync(String(flags.batch), 'utf8')
  } catch (e) { return usage('bad-batch', `--batch unreadable: ${e.code || e.message}`) }
  let items
  try { items = JSON.parse(raw.replace(/^﻿/, '')) } catch (e) { return usage('bad-batch', `--batch is not JSON: ${e.message}`) }
  const b = batchInput(items)
  if (b.err) return usage(b.err.code, b.err.what)
  oneShot = b.input
  sendOne()
}
if (!exiting && flags.guide == null && BATCH) readBatch()
else if (!exiting && RESOLVE) sendResolve()
else if (!exiting && oneShot) sendOne()
else if (!exiting && WAIT && WAIT.addr) waitAnswer(WAIT.addr, Date.now() + WAIT.ms, null)

function sendOne() {
  // ONE report (or one batch): connect → hello → welcome (a 2.0 gateway?) → log → logged → print → exit
  const ws = new WebSocket(URL_)
  let welcomed = false, handedOff = false   // handedOff = the link now serves the wait (waitAnswer owns it)
  const timer = setTimeout(() => { finish(4, { ok: false, code: 'timeout', what: `no answer from ${URL_} within ${TIMEOUT_MS}ms` }); try { ws.terminate() } catch { } }, TIMEOUT_MS)
  const done = (code, obj) => { if (handedOff) return; clearTimeout(timer); try { ws.close() } catch { } finish(code, obj) }
  ws.on('open', () => hello(ws))
  ws.on('message', raw => {
    let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.type === 'welcome' && !welcomed) {
      welcomed = true
      if (!is2(m)) return done(4, unsupported(m))   // §4.1: nothing is sent to a gateway that does not speak 2.0
      ws.send(JSON.stringify({ type: 'log', ref: 1, input: oneShot }))
    } else if (m.type === 'logged') {
      const r = m.result || { ok: false, code: 'bad-reply' }
      if (WAIT && r.ok && r.question && r.node && r.node.id) {   // asked — now wait for the answer, on this same link
        clearTimeout(timer); handedOff = true
        return waitAnswer({ node_id: r.node.id }, Date.now() + WAIT.ms, { ws, asked: { id: r.id, ts: r.ts, node: r.node } })
      }
      done(r.ok && !(r.failed > 0) ? 0 : 4, r)   // a batch with a failed item → 4
    }
    else if (m.type === 'error') done(4, { ok: false, code: m.code || 'error', what: m.what || null })
  })
  ws.on('close', () => done(4, { ok: false, code: 'link-closed', what: welcomed ? 'the bridge closed the link before answering' : 'the bridge closed the link (bad token?)' }))
  ws.on('error', e => done(4, { ok: false, code: 'link-error', what: String((e && e.message) || e) }))
}

/** --resolve (Q46): connect → hello → welcome → {type:"resolve"} → {type:"resolved"} → print → exit (0 resolved, 4 refused). */
function sendResolve() {
  const ws = new WebSocket(URL_)
  let welcomed = false
  const timer = setTimeout(() => { finish(4, { ok: false, code: 'timeout', what: `no answer from ${URL_} within ${TIMEOUT_MS}ms` }); try { ws.terminate() } catch { } }, TIMEOUT_MS)
  const done = (code, obj) => { clearTimeout(timer); try { ws.close() } catch { } finish(code, obj) }
  ws.on('open', () => hello(ws))
  ws.on('message', raw => {
    let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.type === 'welcome' && !welcomed) { welcomed = true; if (!is2(m)) return done(4, unsupported(m)); ws.send(JSON.stringify({ type: 'resolve', ref: 1, input: RESOLVE })) }
    else if (m.type === 'resolved') { const r = m.result || { ok: false, code: 'bad-reply' }; done(r.ok ? 0 : 4, r) }
    else if (m.type === 'error') done(4, { ok: false, code: m.code || 'error', what: m.what || null })
  })
  ws.on('close', () => done(4, { ok: false, code: 'link-closed', what: welcomed ? 'the bridge closed the link before answering' : 'the bridge closed the link (bad token?)' }))
  ws.on('error', e => done(4, { ok: false, code: 'link-error', what: String((e && e.message) || e) }))
}

/**
 * #85 → 2.0: WAIT for the answer to a question until `deadline` — {type:"wait_answer", ref, node_id | (agent?, key | id |
 * path), timeout_ms} on a logger link (the one --ask just used, else a new one), then ONE {type:"answer"} → print + exit
 * (EXIT_OF). A dropped link is re-dialled with backoff and the wait sent again for the time left; at the deadline with no
 * link → outcome "timeout" (exit 10). Once the gateway named the question's id, a re-dial waits by node_id.
 * @param {any} addr @param {number} deadline @param {{ ws?: any, asked?: any }|null} o
 */
function waitAnswer(addr, deadline, o) {
  let ws = o && o.ws, backoff = 200, n = 0, cur = null, retry = null, lastErr = null
  const t0 = Date.now(), asked = o && o.asked ? o.asked : null
  const out = (code, r) => { if (retry) clearTimeout(retry); clearTimeout(stop); try { cur && cur.close() } catch { } finish(code, { ...r, ...(asked ? { asked } : {}) }) }
  const stop = setTimeout(() => out(EXIT_OF.timeout, { ok: true, outcome: 'timeout', ...addr, waited_ms: Date.now() - t0, ...(lastErr ? { note: `no link to the bridge at the end (${lastErr})` } : {}) }), Math.max(0, deadline - Date.now()) + 3000)   // the bridge answers "timeout" itself; this covers a bridge that can't
  const ask = sock => { const left = deadline - Date.now(); sock.send(JSON.stringify({ type: 'wait_answer', ref: `w${++n}`, ...addr, timeout_ms: Math.max(1, left) })) }
  const onMsg = (sock, raw) => {
    let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.type === 'welcome') {
      if (!is2(m)) return out(4, unsupported(m))
      backoff = 200; ask(sock)
    } else if (m.type === 'answer') {
      const r = m.result || { ok: false, code: 'bad-reply' }
      if (!r.ok) return out(4, r)
      out(EXIT_OF[r.outcome] != null ? EXIT_OF[r.outcome] : 4, { ...r, waited_ms: Date.now() - t0 })
    } else if (m.type === 'error') { if (FATAL.has(m.code)) out(4, { ok: false, code: m.code, what: m.what || null }); else lastErr = m.code }
  }
  const redial = () => {
    retry = null
    if (exiting) return
    if (Date.now() >= deadline) return out(EXIT_OF.timeout, { ok: true, outcome: 'timeout', ...addr, waited_ms: Date.now() - t0, note: `no link to the bridge at the end${lastErr ? ` (${lastErr})` : ''}` })
    const sock = new WebSocket(URL_)
    cur = sock
    sock.on('open', () => hello(sock))
    sock.on('message', raw => onMsg(sock, raw))
    sock.on('close', () => { if (cur !== sock || exiting) return; cur = null; lastErr = lastErr || 'link-closed'; retry = setTimeout(redial, backoff); backoff = Math.min(backoff * 2, BACKOFF_MAX_MS) })
    sock.on('error', e => { lastErr = String((e && e.code) || (e && e.message) || e) })
  }
  if (ws) {   // the link the ask went over: reuse it (already welcomed)
    cur = ws
    ws.removeAllListeners('message'); ws.removeAllListeners('close')
    ws.on('message', raw => onMsg(ws, raw))
    ws.on('close', () => { if (cur !== ws || exiting) return; cur = null; lastErr = 'link-closed'; retry = setTimeout(redial, backoff) })
    ask(ws)
  } else redial()
}

if (!exiting && STREAM) {
  // MANY reports over ONE connection: NDJSON on stdin, one result line each IN INPUT ORDER, reconnect with backoff.
  // The queue holds every line: a pending report { n, ref, input, deadline } or an already-answered one { n, ref, result }
  // (a bad line) that waits its turn behind the reports before it.
  const queue = []
  let ws = null, ready = false, inflight = null, backoff = 200, eof = false, nextRef = 0, retry = null
  // `line` stays the INPUT line number (the stream protocol is unchanged, §4.1); a 2.0 result's own `line` flag (§4.2: the
  // report set the node's line) is passed on as `line_set`, so the two never collide
  const emit = (item, result) => { const { line: set, ...r } = result || {}; process.stdout.write(JSON.stringify({ line: item.n, ...(item.ref !== undefined ? { ref: item.ref } : {}), ...r, ...(set !== undefined ? { line_set: set } : {}) }) + '\n') }
  function settle() { if (eof && !queue.length && !inflight && !exiting) { clearInterval(sweep); if (retry) clearTimeout(retry); try { ws && ws.close() } catch { } finish(0, null) } }
  function pump() {   // emit answered heads; send the next report when the link is up and nothing is in flight
    if (inflight || exiting) return
    while (queue.length && queue[0].result) { const it = queue.shift(); emit(it, it.result) }
    if (ready && ws && queue.length) {
      const it = queue.shift()
      it.wire = ++nextRef
      inflight = it
      it.timer = setTimeout(() => { if (inflight === it) { inflight = null; emit(it, { ok: false, code: 'timeout', what: `no answer within ${TIMEOUT_MS}ms` }); pump() } }, TIMEOUT_MS)
      try { ws.send(JSON.stringify({ type: 'log', ref: it.wire, input: it.input })) } catch { }
    }
    settle()
  }
  function fatal(r) {   // the bridge will never accept these reports (bad token / ident, a gateway without 2.0): report them all, exit 4
    if (inflight) { clearTimeout(inflight.timer); emit(inflight, r); inflight = null }
    for (const it of queue.splice(0)) emit(it, it.result || r)
    try { ws && ws.close() } catch { }
    finish(4, { ...r, fatal: true })
  }
  function connect() {
    retry = null
    if (exiting) return
    const sock = new WebSocket(URL_)
    ws = sock
    const helloTimer = setTimeout(() => { if (!ready && ws === sock) { try { sock.terminate() } catch { } } }, TIMEOUT_MS)
    sock.on('open', () => hello(sock))
    sock.on('message', raw => {
      let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.type === 'welcome' && !ready) {
        clearTimeout(helloTimer)
        if (!is2(m)) return fatal(unsupported(m))
        ready = true; backoff = 200; pump()
      } else if (m.type === 'logged') {
        if (!inflight || m.ref !== inflight.wire) return   // a late answer to a line already reported (timeout)
        const it = inflight; inflight = null; clearTimeout(it.timer)
        emit(it, m.result || { ok: false, code: 'bad-reply' }); pump()
      } else if (m.type === 'error' && FATAL.has(m.code)) fatal({ ok: false, code: m.code, what: m.what || null })
    })
    sock.on('close', () => {
      clearTimeout(helloTimer)
      if (ws !== sock) return
      ready = false; ws = null
      if (inflight) { const it = inflight; inflight = null; clearTimeout(it.timer); emit(it, { ok: false, code: 'link-lost', what: 'the link dropped before the bridge answered; not resent (it may or may not have been applied)' }) }
      pump()
      if (!exiting && !retry) { retry = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, BACKOFF_MAX_MS) }
    })
    sock.on('error', () => { })   // 'close' follows
  }
  const sweep = setInterval(() => {   // with no link, a report that waited longer than LINE_WAIT_MS is reported (in order)
    if (ready || inflight || exiting) return
    const now = Date.now()
    while (queue.length && (queue[0].result || queue[0].deadline <= now)) { const it = queue.shift(); emit(it, it.result || { ok: false, code: 'no-bridge', what: `no link to ${URL_} within ${LINE_WAIT_MS}ms` }) }
    settle()
  }, 200)
  let n = 0
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', raw => {
    const item = /** @type {any} */ ({ n: ++n })
    const line = raw.trim()
    if (!line) return
    let o
    try { o = JSON.parse(line) } catch (e) { item.result = { ok: false, code: 'bad-json', what: e.message } }
    if (!item.result && Array.isArray(o)) {   // a batch line — one call, one result line {line, ok, results}
      const b = batchInput(o)
      if (b.err) item.result = { ok: false, ...b.err }
      else { item.input = b.input; item.deadline = Date.now() + LINE_WAIT_MS }
      queue.push(item); pump(); return
    }
    if (!item.result && (!o || typeof o !== 'object')) item.result = { ok: false, code: 'bad-line', what: 'each line must be a JSON object (or an array of them: a batch)' }
    if (!item.result) {
      const { ref, ...fields } = o
      item.ref = ref
      const extra = Object.keys(fields).filter(k => !LINE_FIELDS.includes(k))
      if (extra.length) item.result = { ok: false, code: 'bad-field', what: `unknown field(s) ${extra.join(', ')}: a line carries the log tool's fields (${LOG2_FIELDS.join(', ')}) + ref; the identity comes from the command line` }
      else {
        item.input = { ...fields }
        for (const k of Object.keys(defaults)) if (item.input[k] === undefined) item.input[k] = defaults[k]   // --agent / --no-log: defaults a line may override
        const p = parseCall(item.input, nowOpts())
        if (!p.ok) item.result = { ok: false, code: p.code || 'bad-input', what: p.what || null, ...(p.suggest ? { suggest: p.suggest } : {}) }
        else item.deadline = Date.now() + LINE_WAIT_MS
      }
    }
    queue.push(item)
    pump()
  })
  rl.on('close', () => { eof = true; pump() })
  connect()
}

// #89 → 2.0: --guide agent|session — print the how-to (plain text, not JSON). The command it shows is the one this script
// was run as (node + script + --session / --project / --token-file). The guide is PULLED from the gateway first —
// {type:"guide", ref, kind, cmd, path, agent, label, under, script} on the logger link → the realm's published guide, else
// the script's OWN built-in text (also when the gateway can't be reached within AIMB_LOG_GUIDE_MS, default 2500, or does
// not speak 2.0). §4.4: with --agent the same request is the agent's FIRST REPORT — the gateway puts the agent on the board
// (state running, "reading the guide") when it is not there yet, and writes nothing when it is; the last lines say which
// (and the label it got). A refused create (label-required, unknown-node for --under …) prints the guide, then the error,
// and exits 64. The last line says where the guide came from.
function runGuide() {
  const kind = String(flags.guide).toLowerCase(), fwd = p => String(p).split(path.sep).join('/')
  let ver = null
  try { ver = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || null } catch { }
  const cmd = logCmd({ node: fwd(process.execPath), script: fwd(fileURLToPath(import.meta.url)), session: ident.session || '<session>', project: ident.project || '<project>', tokenFile: TOKEN_FILE_ARG })
  const by = `aimb-log ${ver || '?'}`, agent = flags.agent != null ? String(flags.agent).trim() : null
  const wantBoard = kind === 'agent' && !!agent
  const out = (text, board) => {
    const lines = [text]
    let code = 0
    if (wantBoard) {
      if (!board) lines.push(`(Not on the board yet: this host's gateway could not register you — your first report with --label "…" will.)`)
      else if (!board.ok) { lines.push(`(Not on the board: ${board.code} — ${board.what || ''})`, JSON.stringify(board)); code = board.code === 'session-user-mismatch' ? 4 : 64 }
      else if (board.created) lines.push(`(You are on the board now as "${board.node && board.node.label}" — ${board.node && board.node.path}; key ${board.node && board.node.key}, id ${board.node && board.node.id}${(board.warnings || []).some(w => w && w.code === 'relabelled') ? ` — a sibling had your label, so you got "${board.node.label}"` : ''}.)`)
      else lines.push(`(Already on the board as "${board.node && board.node.label}" — ${board.node && board.node.path}: nothing written.)`)
    }
    process.stdout.write(lines.join('\n') + '\n', () => process.exit(code))
  }
  const builtin = (gw, why, gateway2, board) => out(guideText({ kind: /** @type {any} */ (kind), cmd, path: flags.path || null, agent, gateway: gw, gateway2, script: ver }) + '\n' + guideSourceLine({ source: 'builtin', kind, by, gateway: gw, ...why }), board)
  if (!TOKEN || !ident.session || !ident.project || !ident.user) return builtin(null, { reason: 'unreachable' }, undefined, null)
  let ws, settled = false, gw = null
  const end = fn => { if (settled) return; settled = true; clearTimeout(t); try { ws.close() } catch { } fn() }
  const t = setTimeout(() => end(() => builtin(gw, { reason: gw ? 'old-gateway' : 'unreachable' }, gw ? false : undefined, null)), num(process.env.AIMB_LOG_GUIDE_MS, 2500))
  try { ws = new WebSocket(URL_) } catch { return end(() => builtin(null, { reason: 'unreachable' }, undefined, null)) }
  ws.on('open', () => hello(ws))
  ws.on('message', raw => {
    let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.type === 'welcome') {
      if (!m.logger) return end(() => builtin(null, { reason: 'unreachable' }, undefined, null))
      gw = m.bridge_version || null
      if (!is2(m)) return end(() => builtin(gw, { reason: 'old-gateway' }, false, null))   // a 1.7x gateway: the built-in 2.0 text, + a note that it won't take these forms
      const g = { type: 'guide', ref: 1, kind, cmd, path: flags.path || null, script: ver }
      if (wantBoard) { g.agent = agent; for (const k of ['label', 'under']) if (flags[k] != null) g[k] = flags[k] }
      ws.send(JSON.stringify(g))
    } else if (m.type === 'guide' && m.ref === 1) {
      const board = wantBoard ? (m.board || null) : null
      if (m.ok && m.source === 'realm' && typeof m.text === 'string') return end(() => out(m.text + '\n' + guideSourceLine({ source: 'realm', kind, updated_at: m.updated_at, origin: m.origin }), board))
      end(() => builtin(gw, m.ok ? { reason: m.reason || 'none', min_bridge: m.min_bridge || null } : { reason: 'unreachable' }, true, board))
    } else if (m.type === 'logged' || m.type === 'error') end(() => builtin(gw, { reason: gw ? 'old-gateway' : 'unreachable' }, gw ? false : undefined, null))   // bad-op = no guide request there
  })
  ws.on('error', () => end(() => builtin(gw, { reason: 'unreachable' }, undefined, null)))
  ws.on('close', () => end(() => builtin(gw, { reason: 'unreachable' }, undefined, null)))
}
