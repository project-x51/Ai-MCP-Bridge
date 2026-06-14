// CapSigner — truncated HMAC-SHA256 (default). ~128-bit forgery resistance, stateless, verified by
// recomputation. A future asymmetric variant would let third parties verify (architecture.md §5/§7).
import crypto from 'node:crypto'
export const meta = { facet: 'capsigner', name: 'hmac' }
export function create(ctx) {
  return {
    deriveKey(secret) { return Buffer.from(crypto.hkdfSync('sha256', String(secret || ''), 'aimb-reply-cap', 'cap', 32)) },
    mint(key, fields) { return crypto.createHmac('sha256', key).update(fields).digest('base64').slice(0, 22) },
    verify(key, tag, fields) {
      const want = crypto.createHmac('sha256', key).update(fields).digest('base64').slice(0, 22)
      try { return tag && crypto.timingSafeEqual(Buffer.from(tag), Buffer.from(want)) } catch { return false }
    },
  }
}
