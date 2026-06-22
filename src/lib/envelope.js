// Pure envelope identity — extracted from bridge.mjs. The id is a content hash over the PLAINTEXT fields
// (computed BEFORE body encryption, T8/T9), so the same logical message dedupes across hops/retries.
// NOTE: makeEnvelope() stays in bridge.mjs — it reads live SESSION/NAME and signs a reply-cap, so it is
// coupled to bridge state and is NOT a pure extraction.
import crypto from 'node:crypto'

/** @param {import('../types').Envelope} env @returns {string} stable "env_<hash>" id */
export function envelopeId(env) {
  return 'env_' + crypto.createHash('sha1')
    .update(`${env.from?.session}|${env.to}|${env.verb}|${env.subject}|${env.pattern}|${env.topic}|${env.body}|${env.ts}`).digest('hex').slice(0, 12)
}
