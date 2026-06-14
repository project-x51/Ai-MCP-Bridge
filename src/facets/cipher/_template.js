// BodyCipher facet — TEMPLATE. Copy to "<name>.js" and implement. Seals/opens the envelope BODY only;
// routing metadata (from/to/topic/verb/subject/ids) stays cleartext by design. (Default: AES-256-GCM.)
//
// Interface (operates on the envelope in place / by copy):
//   seal(env)  -> void       encrypt env.body in place and set an env.enc marker (no-op if already sealed)
//   open(env)  -> string     return the plaintext body (env unchanged)
//   view(env)  -> envelope   a copy of env with the body decrypted and the enc marker stripped
export const meta = { facet: 'cipher', name: 'template' }
export function create(ctx) {
  return {
    seal(env) { throw new Error('cipher.seal not implemented') },
    open(env) { throw new Error('cipher.open not implemented') },
    view(env) { throw new Error('cipher.view not implemented') },
  }
}
