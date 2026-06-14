// BodyCipher — AES-256-GCM (default). Key HKDF-derived from the shared token. Trust-domain encryption
// (anyone with config.token can decrypt); per-pair E2E is a future profile. Empty token = passthrough.
import crypto from 'node:crypto'
export const meta = { facet: 'cipher', name: 'aesgcm' }
export function create(ctx) {
  const KEY = ctx.TOKEN ? Buffer.from(crypto.hkdfSync('sha256', ctx.TOKEN, 'aimb-body-v1', 'body', 32)) : null
  function open(env) {
    if (!env || env.enc !== 'gcm1') return env ? String(env.body || '') : ''
    if (!KEY) return '[decrypt-failed: no token]'
    try {
      const raw = Buffer.from(env.body, 'base64')
      const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12))
      d.setAuthTag(raw.subarray(raw.length - 16))
      return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8')
    } catch { return '[decrypt-failed]' }
  }
  return {
    seal(env) {
      if (!KEY || env.enc) return
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-256-gcm', KEY, iv)
      const ct = Buffer.concat([c.update(String(env.body || ''), 'utf8'), c.final()])
      env.body = Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
      env.enc = 'gcm1'
    },
    open,
    view(env) { if (!env || env.enc !== 'gcm1') return env; const { enc, ...rest } = env; return { ...rest, body: open(env) } },
  }
}
