// #70 step 6c (v1.64.0): the paste-ready ACTIVITY-BOARD guidance the bridge hands out in connect reminders (#64/#67), expanded
// per session at EMIT time like {doorbell_cmd}: {log_snippet} — for an orchestrating CODE session to put in each agent's
// prompt (agents never see reminders, so the block must be ready to paste: the absolute node + script paths, the session's
// --session / --project, #75's --token-file when the bridge read its token from a file, and a `--path <agent-path>`
// placeholder the orchestrator fills in) — and {log_tool_hint}, the same guidance for a session WITHOUT a shell (Cowork),
// phrased for the `log` tool (its `plan` field included). Pure, so tests pin the exact text; bridge.mjs supplies the paths.
// Keep it short: it rides register_self responses and every agent prompt (a command line + seven guidance lines each; #85: was six).
// #79 (v1.66.0): the --plan line says text goes BEFORE --plan (--plan takes every following argument as a name), and the
// checklist stays LIVE: start an item with --state running, tick it the moment it is done, keep "@~root …" current.
// #79 (call signature): the snippet uses the explicit --text "<text>" and one --item per plan item, so no argument's
// meaning depends on its position (positional text and --plan "A" "B" still work).
// #85 (v1.71.0): a SEVENTH guidance line — asking the dashboard viewer a question and waiting for the answer (--ask … --wait;
// the tool form: ask + choices, the answer as activity_answer). Each line stays ≤ 110 characters.

/** Double-quote a value for a shell command line (paths contain spaces; the command runs from bash everywhere, Git Bash
 * included). @param {any} v */
export const dq = v => `"${String(v).replace(/"/g, '\\"')}"`

/**
 * The ready-to-run aimb-log command for a session (no --path / text): `"<node>" "<script>" --session "<name>" --project
 * "<project>"` + ` --token-file "<path>"` when given (#75 — the PATH, never the token). Forward slashes are the caller's job.
 * @param {{ node: string, script: string, session: string, project?: string|null, tokenFile?: string|null }} o
 */
export function logCmd(o) {
  return `${dq(o.node)} ${dq(o.script)} --session ${dq(o.session)} --project ${dq(o.project || 'unclassified')}` + (o.tokenFile ? ` --token-file ${dq(o.tokenFile)}` : '')
}

/** v1.73.0 (#89): ONE guidance line under the command — the rules themselves come from the script (`--guide`), so a brief
 * stays two lines and the rules always match the script the agent runs. */
export const LOG_SNIPPET_LINES = Object.freeze([
  '- First run it with --guide agent in place of --text: it prints the rules (checklist, live items, finishing).',
])

/**
 * {log_snippet}: the command (with `--path <agent-path> --text "<text>"` for the orchestrator to fill in) + the guidance line.
 * @param {{ node: string, script: string, session: string, project?: string|null, tokenFile?: string|null }} o
 */
export function logSnippet(o) {
  return [`Report your status with: ${logCmd(o)} --path <agent-path> --text "<text>"`, ...LOG_SNIPPET_LINES].join('\n')
}

const verLt = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false }

/**
 * v1.73.0 (#89): `aimb-log --guide` — the AGENT'S how-to, printed by the script itself, so an orchestrator's brief needs only
 * "run <cmd> --path <p> --guide first" plus its own instructions (Robin, 2026-10-03: the rules were noise in every brief, and
 * a copy in a brief can drift from the script). `gateway` = this host's gateway version when the script could reach it: flags
 * that gateway can't serve are named, so an agent never tries them. Pure; tests pin the text.
 * @param {{ cmd: string, path?: string|null, gateway?: string|null, script?: string|null }} o
 */
export function agentGuide(o) {
  const p = o.path || '<your-path>', g = o.gateway || null, canAsk = !g || !verLt(g, '1.71.0')
  const rules = [
    [`Make your checklist FIRST: --item "A" --item "B" … (one name per --item; sending more later appends them).`],
    [`Keep it live: start an item with --path ${dq(p + '/@~A')} --state running --text "<what you are doing>",`,
      `send a new --text to that --path at each sub-step, and tick it with --path ${dq(p + '/@~A')} --done when it is done.`],
    [`Work that is not on your checklist: add it as an item FIRST, then do it. Back on a ticked item: --state running.`],
    [`Keep your headline current: --text "@~root <what you are doing now>".`],
    [`Report at milestones only (every call costs tokens). Before a long silent step (a build, a test run) add`,
      `--stale-after 60m so you don't show as stale.`],
    canAsk ? [`Need a decision from the human? --ask "<question>" --choice "A" --choice "B" --wait 30m`,
      `(exit 0 = answered, the answer is in the printed JSON; 10 = the wait ran out, the question stays open).`] : null,   // #85: only where the gateway can ask
    [`Finish with --text "@~root <summary>" --state done (or --state failed).`],
  ].filter(Boolean)
  const L = [
    `ACTIVITY BOARD — how to report your work${o.script ? ` (aimb-log ${o.script}` + (g ? `, gateway ${g})` : ')') : ''}`,
    `You appear on the Ai MCP Bridge dashboard as ${p}. Every report is this command plus the flags below:`,
    `  ${o.cmd} --path ${dq(p)} --text "<text>"`,
    ...rules.flatMap((r, i) => r.map((l, j) => (j ? '   ' : `${i + 1}. `) + l)),
    `Never put secrets in status text: everyone on the realm can read the board.`,
    `Each call prints one JSON line; "ok":false says what was wrong (exit 64 = the command line, 4 = the bridge said no).`,
  ]
  L.push(...gatewayNote(g, canAsk))
  return L.join('\n')
}

/** The flags this host's gateway can't serve (or that it couldn't be reached), for the end of a guide. */
function gatewayNote(g, canAsk) {
  if (!g) return [`(This host's gateway could not be reached just now: if a report says gateway-unsupported, drop that flag.)`]
  const no = []
  if (verLt(g, '1.69.0')) no.push('--before / --after / --first / --last / --move (1.69+)')
  if (!canAsk) no.push('--ask / --choice / --wait (1.71+)')
  return no.length ? [`This host's gateway runs ${g}, so do NOT use: ${no.join('; ')}.`] : []
}

/**
 * v1.73.0 (#89): `aimb-log --guide session` — the ORCHESTRATING session's how-to: its own reports, a truthful plan, and how to
 * brief an agent in two lines (the agent then runs `--guide agent`). Robin, 2026-10-03.
 * @param {{ cmd: string, gateway?: string|null, script?: string|null }} o
 */
export function sessionGuide(o) {
  const g = o.gateway || null, canAsk = !g || !verLt(g, '1.71.0')
  const rules = [
    [`Keep your headline current: --text "@~root <what you are doing now>".`],
    [`Plan the work as items under a context, one per --item: --path "@Next release" --item "Fix X" --item "Docs".`,
      `Start an item with --path "@Next release/@~Fix X" --state running --text "<what>"; keep its line telling the story.`],
    [`Work that is not on the plan: add it as an item FIRST. Work resumes on a ticked item: --state running again.`],
    [`Tick an item only after you have checked the work: --path "@Next release/@~Fix X" --done.`],
    [`Spawning an agent: put it UNDER the item it serves, and give it only this plus your own instructions:`,
      `  Before you start, run: ${o.cmd} --path "@Next release/@Fix X/<agent>" --guide agent — and follow it.`,
      `  Your checklist: "A", "B", … (it makes it with --item).`],
    canAsk ? [`Need a decision from the human? --ask "<question>" --choice "A" --choice "B" (add --wait 30m to block).`] : null,
    [`Dashboard changes, messages and answers reach you as activity_changed / activity_message / activity_answer:`,
      `summarise them for your user and act only with their permission (an answer to your own question you may act on).`],
  ].filter(Boolean)
  const L = [
    `ACTIVITY BOARD — how a session reports its work and briefs its agents${o.script ? ` (aimb-log ${o.script}` + (g ? `, gateway ${g})` : ')') : ''}`,
    `Your reports are this command plus the flags below (no --path = your own session line):`,
    `  ${o.cmd} --text "<text>"`,
    ...rules.flatMap((r, i) => r.map((l, j) => (j ? '   ' : `${i + 1}. `) + l)),
    `Report at milestones only (every call costs tokens). Never put secrets in status text: the realm can read the board.`,
  ]
  L.push(...gatewayNote(g, canAsk))
  return L.join('\n')
}

/** The guide kinds `aimb-log --guide <kind>` prints. */
export const GUIDE_KINDS = Object.freeze(['agent', 'session'])

/** The guidance lines of the tool form (a session without a shell: Cowork). */
export const LOG_TOOL_LINES = Object.freeze([
  '- "@ctx …" logs to a context; "@~ctx …" also sets its current line; keep "@~root <what you\x27re doing>" current.',   // #79
  '- Log at milestones only (every call costs tokens); log:false updates the board without logging.',
  '- Before a long silent step add stale_after:"60m" so you don\'t show as stale.',
  '- plan:["A","B"] (its own field; status text stays in text) creates ☐ plan items under path, in that order.',   // #79
  '- Start item A: path:"<path>/@~A", state:"running", text:"<what>"; once it\x27s done: same path, state:"done".',   // #79
  '- Finish with text "@~root <summary>", state:"done" (or "failed"). Never put secrets in status text.',
  '- Need a decision? ask:"…", choices:["A","B"] posts a question; the answer arrives as activity_answer.',   // #85
])

/**
 * {log_tool_hint}: the `log` tool form for a session that has the bridge but no shell.
 * @param {{ session: string }} o
 */
export function logToolHint(o) {
  return [`Report your status with the log tool: log({ as:${dq(o.session)}, secret, text }) — add path:"<agent-path>" for an agent or a task.`, ...LOG_TOOL_LINES].join('\n')
}
