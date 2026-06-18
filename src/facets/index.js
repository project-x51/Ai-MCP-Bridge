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
import * as discoveryNone from './discovery/none.js'
import * as discoverySeeds from './discovery/seeds.js'
import * as discoveryTailscale from './discovery/tailscale.js'
import * as persistenceNone from './persistence/none.js'
import * as persistenceFile from './persistence/file.js'
import * as authorizerNone from './authorizer/none.js'
import * as authorizerScript from './authorizer/script.js'
import * as authorizerHello from './authorizer/hello.js'
import * as vaultNone from './vault/none.js'
import * as vaultScript from './vault/script.js'
import * as vaultTpm from './vault/tpm.js'

const IMPLS = {
  auth:      { token: authToken },
  cipher:    { aesgcm: cipherAesgcm },
  capsigner: { hmac: capHmac },
  identity:  { label: identityLabel },
  config:    { file: configFile },
  transport: { tcp: transportTcp },
  discovery: { none: discoveryNone, seeds: discoverySeeds, tailscale: discoveryTailscale },
  persistence: { none: persistenceNone, file: persistenceFile },
  authorizer: { none: authorizerNone, script: authorizerScript, hello: authorizerHello },
  vault: { none: vaultNone, script: vaultScript, tpm: vaultTpm },
}
// discovery + persistence + authorizer default to 'none' (single-host, no durability, no interactive
// confirmation — unchanged behaviour). Opt in with config profile.<facet> or env AI_BRIDGE_<FACET>.
const DEFAULTS = { auth: 'token', cipher: 'aesgcm', capsigner: 'hmac', identity: 'label', config: 'file', transport: 'tcp', discovery: 'none', persistence: 'none', authorizer: 'none', vault: 'none' }
const PROP = { auth: 'auth', cipher: 'cipher', capsigner: 'capSigner', identity: 'identity', config: 'config', transport: 'transport', discovery: 'discovery', persistence: 'persistence', authorizer: 'authorizer', vault: 'vault' }

export function buildProfile(ctx) {
  const spec = { ...DEFAULTS, ...((ctx.CFG && ctx.CFG.profile) || {}) }
  if (ctx.env && ctx.env.AI_BRIDGE_DISCOVERY) spec.discovery = ctx.env.AI_BRIDGE_DISCOVERY
  if (ctx.env && ctx.env.AI_BRIDGE_PERSISTENCE) spec.persistence = ctx.env.AI_BRIDGE_PERSISTENCE
  if (ctx.env && ctx.env.AI_BRIDGE_AUTHORIZER) spec.authorizer = ctx.env.AI_BRIDGE_AUTHORIZER
  if (ctx.env && ctx.env.AI_BRIDGE_VAULT) spec.vault = ctx.env.AI_BRIDGE_VAULT
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
