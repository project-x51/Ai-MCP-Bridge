// #70 step 6c (v1.64.0): the paste-ready ACTIVITY-BOARD guidance the bridge hands out in connect reminders (#64/#67), expanded
// per session at EMIT time like {doorbell_cmd}: {log_snippet} — for an orchestrating CODE session to put in each agent's
// prompt (agents never see reminders, so the block must be ready to paste: the absolute node + script paths, the session's
// --session / --project, #75's --token-file when the bridge read its token from a file) — and {log_tool_hint}, the same
// guidance for a session WITHOUT a shell (Cowork), phrased for the `log` tool. Pure, so tests pin the exact text;
// bridge.mjs supplies the paths. v1.73.0 (#89): the rules moved into the guides the script prints (`--guide agent|session`).
//
// #88 build step 9 (2.0, docs/spec-88.md §4.3, §4.4): every text here speaks the 2.0 forms — a node is YOUR KEY (`--key`,
// made once with `--label`, never defaulted from the key, Q31), an agent is `--agent <key>` (made by its `--guide agent`
// run, with `--label` and `--under <item key>`), a leading `@` in the text sets the line and plain text only logs (§4.0;
// `@~` and `@` in paths are gone), the checklist is `--item <key> "<label>"`, a clashing label comes back as "<label> (2)"
// (§1.6), and an agent finishes with `--state done --text "@<summary>"` (Q33). Each guide line stays ≤ 110 characters.

/** Double-quote a value for a shell command line (paths contain spaces; the command runs from bash everywhere, Git Bash
 * included). @param {any} v */
export const dq = v => `"${String(v).replace(/"/g, '\\"')}"`

/**
 * The ready-to-run aimb-log command for a session (no address / text): `"<node>" "<script>" --session "<name>" --project
 * "<project>"` + ` --token-file "<path>"` when given (#75 — the PATH, never the token). Forward slashes are the caller's job.
 * @param {{ node: string, script: string, session: string, project?: string|null, tokenFile?: string|null }} o
 */
export function logCmd(o) {
  return `${dq(o.node)} ${dq(o.script)} --session ${dq(o.session)} --project ${dq(o.project || 'unclassified')}` + (o.tokenFile ? ` --token-file ${dq(o.tokenFile)}` : '')
}

/** #89: ONE guidance line under the command — the rules come from the script (`--guide agent`), which (2.0, §4.4) is also
 * the agent's first report: it puts the agent on the board. */
export const LOG_SNIPPET_LINES = Object.freeze([
  '- First run it with --guide agent in place of --text: that puts you on the board and prints the rules.',
])

/**
 * {log_snippet} (§4.3): the 2.0 command — `--agent <your-key> --label "<your name>" --under <item-key>` for the orchestrator
 * to fill in (the label is required to create the agent, Q31; repeating it later is harmless, §3.5) — + the guidance line.
 * @param {{ node: string, script: string, session: string, project?: string|null, tokenFile?: string|null }} o
 */
export function logSnippet(o) {
  return [`Report your status with: ${logCmd(o)} --agent <your-key> --label "<your name>" --under <item-key>`, ...LOG_SNIPPET_LINES].join('\n')
}

/**
 * `aimb-log --guide agent` — the AGENT'S how-to (2.0, §4.3), printed by the script itself (and by the `log` tool's guide).
 * `agent` = the agent's key chain when known (the --agent the guide was run with); `gateway` = this host's gateway version
 * when the script reached it, `gateway2` = false when that gateway does not speak 2.0 (a 1.7x one: the forms below won't
 * work there). Pure; tests pin the text.
 * @param {{ cmd: string, agent?: string|null, gateway?: string|null, gateway2?: boolean, script?: string|null }} o
 */
export function agentGuide(o) {
  const a = o.agent || '<your-key>', g = o.gateway || null
  const L = [
    `ACTIVITY BOARD — how to report your work${o.script ? ` (aimb-log ${o.script}` + (g ? `, gateway ${g})` : ')') : ''}`,
    `You are the agent ${a} on the Ai MCP Bridge dashboard. Every report is this command + the flags below:`,
    `  ${o.cmd} --agent ${dq(a)} --text "<text>"`,
    `- --key <k> names YOUR node. Make it once with --label "<name>" (needed) and --under <k>; then just --key <k>.`,
    `- --text "@<what>" sets the node's line; plain --text "…" only logs. No --key = your own node.`,
    `- Make your checklist first: --item <k> "<label>" (repeat it); tick one with --key <k> --done.`,
    `- Start an item with --key <k> --state running --text "@<what you are doing>"; keep its line current.`,
    `- Work that is not on your checklist: add it as an item FIRST. Back on a ticked item: --state running.`,
    `- A name a sibling already has becomes "<name> (2)": the result says which label you got.`,
    `- Report at milestones only (calls cost tokens); add --stale-after 60m before a long silent step.`,
    `- A used key reopens its node: new work gets a new key (docs-2). Keys: letters, digits and _ . # + -`,
    `- Finish with --state done --text "@<summary>" (or failed): the @ makes the summary your line.`,
    `- Never put secrets in status text.`,
    `- Need a decision? --ask "…" --choice "A" --choice "B" --wait 30m waits for the answer (exit 0 = answered).`,
    `- Ask the question only, then one --choice per option: don't list the choices in the question.`,
    `- Always quote the text ("@…"): in PowerShell an unquoted @word is a splat.`,
    `Each call prints one JSON line; "ok":false says what went wrong (exit 64: the command line, 4: the bridge).`,
  ]
  L.push(...gatewayNote(g, o.gateway2))
  return L.join('\n')
}

/** The note at the end of a guide about this host's gateway: unreachable just now, or not on 2.0 (the 2.0 script talks
 * only to a 2.0 gateway, §4.1). Appended to a realm-published guide too (guideText), whatever its source.
 * @param {string|null|undefined} g the gateway's version (null: it could not be reached) @param {boolean} [gateway2] false = it does not speak 2.0 */
export function gatewayNote(g, gateway2) {
  if (!g) return [`(This host's gateway could not be reached just now: if a report says no-bridge or timeout, try again later.)`]
  if (gateway2 === false) return [`This host's gateway runs ${g}, not 2.0: reports are refused (gateway-unsupported) until it is upgraded.`]
  return []
}

/**
 * `aimb-log --guide session` — the ORCHESTRATING session's how-to (2.0, §4.3): its own reports by key, a truthful plan,
 * and how to brief an agent in two lines (`--agent <key> --label "…" --under <item key>`; the agent then runs
 * `--guide agent`, which puts it on the board).
 * @param {{ cmd: string, gateway?: string|null, gateway2?: boolean, script?: string|null }} o
 */
export function sessionGuide(o) {
  const g = o.gateway || null
  const rules = [
    [`Keep your headline current: --text "@<what you are doing now>" (no --key = your own session line).`],
    [`Plan the work under a context made once by key: --key rel --label "Next release",`,
      `then --key rel --item fix-x "Fix X" --item docs "Docs" (one --item per item: its key and its label).`],
    [`Start an item with --key fix-x --state running --text "@<what>"; keep its line telling the story.`],
    [`Work not on the plan: add it as an item FIRST. Work resumes on a ticked item: --state running again.`],
    [`Tick an item only after you have checked the work: --key fix-x --done.`],
    [`Spawning an agent: give it a key, put it UNDER the item it serves, brief it with only this + your words:`,
      `  Before you start, run: ${o.cmd} --agent <key> --label "<its name>" --under fix-x --guide agent`,
      `  — and follow it. Your checklist: "A", "B", … (it makes it with --item).`],
    [`A name a sibling already has becomes "<name> (2)": the result says which label it got.`],
    [`Need a decision from the human? --ask "<question>" --choice "A" --choice "B" (add --wait 30m to block);`,
      `ask the question only — the choices are listed below it as the answers.`],
    [`Dashboard changes, messages and answers reach you as activity_changed / activity_message / activity_answer:`,
      `summarise them for your user; act only with their permission (your own question's answer you may act on).`],
  ]
  const L = [
    `ACTIVITY BOARD — how a session reports its work and briefs its agents${o.script ? ` (aimb-log ${o.script}` + (g ? `, gateway ${g})` : ')') : ''}`,
    `Your reports are this command plus the flags below:`,
    `  ${o.cmd} --text "<text>"`,
    ...rules.flatMap((r, i) => r.map((l, j) => (j ? '   ' : `${i + 1}. `) + l)),
    `Report at milestones only (calls cost tokens). Never put secrets in status text: the realm can read the board.`,
    `Finish with --state done --text "@<summary>" (or failed): the @ makes the summary the line.`,
  ]
  L.push(...gatewayNote(g, o.gateway2))
  return L.join('\n')
}

/** The guide kinds `aimb-log --guide <kind>` prints. */
export const GUIDE_KINDS = Object.freeze(['agent', 'session'])

/**
 * v1.74.0 (#89 part 2): fill a REALM-published guide's placeholders — {cmd} (the requester's ready command), {path} (its
 * --path, else "<your-path>"), {gateway} (the serving gateway's version), {script} (the requester's aimb-log / bridge
 * version) and (2.0, step 9) {agent} (its --agent key chain, else "<your-key>"). Only these five are replaced; any other
 * {word} (a JSON example, say) stays as written. Pure.
 * @param {string} text @param {{ cmd?: string|null, path?: string|null, agent?: string|null, gateway?: string|null, script?: string|null }} v
 */
export function renderGuide(text, v) {
  const vars = { cmd: v.cmd || '<command>', path: v.path || '<your-path>', agent: v.agent || '<your-key>', gateway: v.gateway || '?', script: v.script || '?' }
  return String(text).replace(/\{(cmd|path|agent|gateway|script)\}/g, (m, k) => vars[k])
}

/**
 * v1.74.0 (#89 part 2): the guide text to hand out — the realm's `template` (rendered, see renderGuide) when given, else the
 * built-in agentGuide / sessionGuide. The gateway note is ALWAYS appended for the gateway that serves the reports, whatever
 * the source. Pure. (2.0, Q34: no min_bridge gating or fallback is added — realm guides are rewritten for 2.0 at the cutover.)
 * @param {{ kind: 'agent'|'session', template?: string|null, cmd: string, path?: string|null, agent?: string|null, gateway?: string|null, gateway2?: boolean, script?: string|null }} o
 */
export function guideText(o) {
  if (!o.template) return o.kind === 'session' ? sessionGuide(o) : agentGuide(o)
  return [renderGuide(o.template, o), ...gatewayNote(o.gateway || null, o.gateway2)].join('\n')
}

/**
 * v1.74.0 (#89 part 2): the ONE short line saying where a printed guide came from.
 * @param {{ source: 'realm'|'builtin', kind: string, updated_at?: number|null, origin?: string|null, by?: string|null, reason?: string|null, min_bridge?: string|null, gateway?: string|null }} o
 *   by = what holds the built-in text ("aimb-log 1.74.0" / "bridge 1.74.0"); reason = why not the realm's: 'none' |
 *   'min_bridge' | 'old-gateway' | 'unreachable'
 */
export function guideSourceLine(o) {
  if (o.source === 'realm') return `(Guide source: the realm's published ${o.kind} guide, updated_at ${new Date(o.updated_at || 0).toISOString()}${o.origin ? ` from ${o.origin}` : ''}.)`
  const why = o.reason === 'min_bridge' ? `the realm's ${o.kind} guide needs ${o.min_bridge}+`
    : o.reason === 'old-gateway' ? `gateway ${o.gateway || '?'} does not speak 2.0`
      : o.reason === 'unreachable' ? 'the gateway could not be asked for the realm\'s'
        : `the realm publishes no ${o.kind} guide`
  return `(Guide source: built into ${o.by || 'this version'}; ${why}.)`
}

/** The guidance lines of the tool form (a session without a shell: Cowork) — 2.0 (§4.3): key / label, plan items as
 * { key, label }, a leading @ in text for the line. */
export const LOG_TOOL_LINES = Object.freeze([
  '- text:"@<what>" sets the node\'s line; plain text only logs. No key = your own session node.',
  '- Make a task once: key:"docs", label:"Write the docs" (under:"<k>" nests it); later just key:"docs".',
  '- Checklist: plan:[{ key:"a", label:"A" }, …] under the target; tick one with key:"a", state:"done".',
  '- A label a sibling already has becomes "<label> (2)": node.label in the result says which you got.',
  '- Log at milestones only (calls cost tokens); before a long silent step add stale_after:"60m".',
  '- Finish with state:"done", text:"@<summary>" (or "failed"). Never put secrets in status text.',
  '- Need a decision? ask:"…", choices:["A","B"] — the question only; the answer arrives as activity_answer.',
])

/**
 * {log_tool_hint}: the `log` tool form for a session that has the bridge but no shell.
 * @param {{ session: string }} o
 */
export function logToolHint(o) {
  return [`Report your status with the log tool: log({ as:${dq(o.session)}, secret, text }) — add key:"<k>" (+ label the first time) for a task.`, ...LOG_TOOL_LINES].join('\n')
}
