// Authorizer facet: hello (Windows) — raises a REAL Windows Hello prompt (presence/PIN/face) to confirm a
// sensitive action, via the mechanism proven in experiments/hello-tpm-vault (UserConsentVerifier). NOT
// exercised in CI — it needs a human at the prompt, so verify it live. Falls back to DENIED whenever the
// helper isn't present or errors, so it can never silently approve.
//
// WIRING STATUS: the bridge runs headless (MCP stdio); the actual prompt belongs in the Windows tray
// (a GUI process). This impl shells out to a tray helper `tray/windows/hello-confirm.cmd <message>` that
// returns exit 0 on approve / non-zero on deny. That helper is the remaining piece to wire to the tray's
// Hello integration (the experiment shows it works); until then this returns 'hello-helper-missing'.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
export const meta = { facet: 'authorizer', name: 'hello' }
export function create(ctx) {
  const helper = path.resolve(ctx.HERE || '.', (ctx.env && ctx.env.AI_BRIDGE_HELLO_HELPER) || '../tray/windows/hello-confirm.cmd')
  return {
    meta,
    async confirm({ subject, details } = {}) {
      if (process.platform !== 'win32') return { approved: false, reason: 'hello-unavailable-platform', by: 'hello' }
      if (!fs.existsSync(helper)) return { approved: false, reason: 'hello-helper-missing', by: 'hello' }
      try {
        const msg = `${subject || 'Approve Ai MCP Bridge action'}${details ? ' — ' + details : ''}`
        const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', helper, msg], { timeout: 60000, windowsHide: true })
        const approved = r.status === 0
        return { approved, reason: approved ? 'hello-approve' : 'hello-deny', by: 'hello' }
      } catch (e) { return { approved: false, reason: 'hello-error:' + e.message, by: 'hello' } }
    },
  }
}
