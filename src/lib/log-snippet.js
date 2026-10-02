// #70 step 6c (v1.64.0): the paste-ready ACTIVITY-BOARD guidance the bridge hands out in connect reminders (#64/#67), expanded
// per session at EMIT time like {doorbell_cmd}: {log_snippet} — for an orchestrating CODE session to put in each agent's
// prompt (agents never see reminders, so the block must be ready to paste: the absolute node + script paths, the session's
// --session / --project, #75's --token-file when the bridge read its token from a file, and a `--path <agent-path>`
// placeholder the orchestrator fills in) — and {log_tool_hint}, the same guidance for a session WITHOUT a shell (Cowork),
// phrased for the `log` tool (its `plan` field included). Pure, so tests pin the exact text; bridge.mjs supplies the paths.
// Keep it short: it rides register_self responses and every agent prompt (a command line + six guidance lines each).

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

/** The six guidance lines under the command (shell form). */
export const LOG_SNIPPET_LINES = Object.freeze([
  '- Text "@ctx …" logs to a context; "@~ctx …" also sets its current line; "@~root …" sets your own headline.',
  '- Report at milestones only (every call costs tokens); a script reporting often adds --no-log.',
  '- Before a long silent step (a build, a test run) add --stale-after 60m so you don\'t show as stale.',
  '- --plan "A" "B" creates ☐ plan items under --path, in that order.',
  '- --done ticks one: --path "<agent-path>/@~A" --done (no text needed).',
  '- Finish with "@~root <summary>" --state done (or --state failed). Never put secrets in status text.',
])

/**
 * {log_snippet}: the command (with `--path <agent-path> "<text>"` for the orchestrator to fill in) + the guidance lines.
 * @param {{ node: string, script: string, session: string, project?: string|null, tokenFile?: string|null }} o
 */
export function logSnippet(o) {
  return [`Report your status with: ${logCmd(o)} --path <agent-path> "<text>"`, ...LOG_SNIPPET_LINES].join('\n')
}

/** The guidance lines of the tool form (a session without a shell: Cowork). */
export const LOG_TOOL_LINES = Object.freeze([
  '- Text "@ctx …" logs to a context; "@~ctx …" also sets its current line; "@~root …" sets your own headline.',
  '- Log at milestones only (every call costs tokens); log:false updates the board without logging.',
  '- Before a long silent step add stale_after:"60m" so you don\'t show as stale.',
  '- plan:["A","B"] creates ☐ plan items under path, in that order.',
  '- Tick one with path:"<path>/@~A", state:"done" (no text needed).',
  '- Finish with text "@~root <summary>", state:"done" (or "failed"). Never put secrets in status text.',
])

/**
 * {log_tool_hint}: the `log` tool form for a session that has the bridge but no shell.
 * @param {{ session: string }} o
 */
export function logToolHint(o) {
  return [`Report your status with the log tool: log({ as:${dq(o.session)}, secret, text }) — add path:"<agent-path>" for an agent or a task.`, ...LOG_TOOL_LINES].join('\n')
}
