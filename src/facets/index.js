// Profile loader (docs/architecture.md §9). A realm's security/transport is a set of swappable
// FACETS. Each facet lives in its own folder with interchangeable implementations; a "profile" binds
// exactly one implementation per facet. The core bridge reaches every facet only through the object
// this returns, so swapping in a different auth / cipher / transport is local and obvious.
//
//   To ADD an implementation:  copy a facet's `_template.js` (or an existing impl) to `<name>.js`,
//                              fill in the methods, `import` it below, and add it to IMPLS.
//   To SWAP an implementation: change the name in DEFAULTS, or set `"profile": { <facet>: "<name>" }`
//                              in config.json.
//
// Every impl exports:  `export const meta = { facet, name }`  and  `export function create(ctx) {...}`
// where ctx = { TOKEN, REALM, CFG, HERE, SESSION, env, log }.
import * as authToken from './auth/token.js'
import * as cipherAesgcm from './cipher/aesgcm.js'
import * as capHmac from './capsigner/hmac.js'
import * as identityLabel from './identity/label.js'
import * as configFile from './config/file.js'
import * as transportTcp from './transport/tcp.js'

const IMPLS = {
  auth:      { token: authToken },
  cipher:    { aesgcm: cipherAesgcm },
  capsigner: { hmac: capHmac },
  identity:  { label: identityLabel },
  config:    { file: configFile },
  transport: { tcp: transportTcp },
}
const DEFAULTS = { auth: 'token', cipher: 'aesgcm', capsigner: 'hmac', identity: 'label', config: 'file', transport: 'tcp' }
const PROP = { auth: 'auth', cipher: 'cipher', capsigner: 'capSigner', identity: 'identity', config: 'config', transport: 'transport' }

export function buildProfile(ctx) {
  const spec = { ...DEFAULTS, ...((ctx.CFG && ctx.CFG.profile) || {}) }
  const profile = { realm: ctx.REALM, names: {} }
  for (const facet of Object.keys(DEFAULTS)) {
    const name = spec[facet]
    const mod = IMPLS[facet] && IMPLS[facet][name]
    if (!mod) throw new Error(`unknown ${facet} impl "${name}" — add it to facets/index.js`)
    profile[PROP[facet]] = mod.create(ctx)
    profile.names[facet] = name
  }
  return profile
}
