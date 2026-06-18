// Authorizer facet: hello (Windows) — raises a REAL Windows Hello prompt (presence/PIN/face) to confirm a
// sensitive action, via the mechanism proven in experiments/hello-tpm-vault (UserConsentVerifier). NOT
// exercised in CI — it needs a human at the prompt, so verify it live. Falls back to DENIED whenever the
// helper isn't present or errors, so it can never silently approve.
//
// Shells out to HelloConfirm.exe (tray/windows/), which raises the prompt and reports the decision via
// exit code: 0=approved (Verified), 3=denied/cancelled, 2=Hello unavailable, 1=error. The exe is built by
// tray/windows/build-hello.cmd; if it's missing this builds it once, and otherwise denies (never silently
// approves). Override the path with AI_BRIDGE_HELLO_HELPER. Verified live (the experiment shows it works);
// the prompt needs a human, so it isn't exercised in CI.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
export const meta = { facet: 'authorizer', name: 'hello' }
export function create(ctx) {
  const here = ctx.HERE || '.'
  const exe = path.resolve(here, (ctx.env && ctx.env.AI_BRIDGE_HELLO_HELPER) || '../tray/windows/HelloConfirm.exe')
  const buildScript = path.resolve(here, '../tray/windows/build-hello.cmd')
  function ensureExe() {
    if (fs.existsSync(exe)) return true
    try { spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', buildScript], { timeout: 120000, windowsHide: true }) } catch { }
    return fs.existsSync(exe)
  }
  return {
    meta,
    async confirm({ subject, details } = {}) {
      if (process.platform !== 'win32') return { approved: false, reason: 'hello-unavailable-platform', by: 'hello' }
      if (!ensureExe()) return { approved: false, reason: 'hello-helper-missing', by: 'hello' }
      try {
        const msg = `${subject || 'Approve this Ai MCP Bridge action'}${details ? ' — ' + details : ''}`
        const r = spawnSync(exe, [msg], { timeout: 90000, windowsHide: true, encoding: 'utf8' })
        const approved = r.status === 0
        // exit: 0=verified, 3=denied/cancelled, 2=Hello unavailable, 1=error/timeout(null)
        const reason = approved ? 'hello-approve' : r.status === 3 ? 'hello-deny' : r.status === 2 ? 'hello-unavailable' : 'hello-error'
        return { approved, reason, by: 'hello', code: r.status }
      } catch (e) { return { approved: false, reason: 'hello-error:' + e.message, by: 'hello' } }
    },
  }
}
