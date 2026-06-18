// Authorizer facet: script/stub — the decision comes from an env var or a file, so the human-in-the-loop
// flow (e.g. dormant-topic takeover) is fully testable headlessly with NO real prompt. This is what CI uses;
// the real Windows Hello prompt ('hello') is the only piece a human must verify live.
//   AI_BRIDGE_AUTHORIZER_DECISION = approve | deny   (default deny)
//   AI_BRIDGE_AUTHORIZER_FILE     = path; its trimmed contents ('approve'/'deny') are re-read each call,
//                                   so a test can flip the decision mid-run.
import fs from 'node:fs'
export const meta = { facet: 'authorizer', name: 'script' }
export function create(ctx) {
  const env = (ctx && ctx.env) || {}
  const isYes = s => ['approve', 'allow', 'yes', 'y', '1', 'true'].includes(String(s || '').trim().toLowerCase())
  return {
    meta,
    async confirm() {
      let d = env.AI_BRIDGE_AUTHORIZER_DECISION
      if (env.AI_BRIDGE_AUTHORIZER_FILE) { try { d = fs.readFileSync(env.AI_BRIDGE_AUTHORIZER_FILE, 'utf8') } catch { } }
      const approved = isYes(d)
      return { approved, reason: approved ? 'script-approve' : 'script-deny', by: 'script' }
    },
  }
}
