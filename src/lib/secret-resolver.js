// Resolve ${scheme:key} references in config values so a secret lives OUTSIDE the config/code text — the
// config holds a reference, not the literal. Schemes are pluggable (a map of scheme -> (key) => value):
// today only `env` is wired; `vault` / `service` are intentional SEAMS — referencing an unwired scheme
// throws a clear error rather than silently leaking or ignoring it, so the swap-in point is explicit.
//
// Used by egress auth (#36): a backend's credential is written as e.g. ${env:DEV_API_PASSWORD}, so the
// value never appears in config.json (gitignored but Dropbox-synced) or anywhere on disk in the repo. NB
// this does NOT hide the secret from a local, shell-capable process running as the same user — it prevents
// the DURABLE / off-machine leaks (repo, synced config, transcript) and gives a clean path to move the
// secret behind a real boundary (vault/off-box minter) later with no schema change.

const REF = /\$\{([a-z]+):([^}]+)\}/gi   // ${env:NAME}, ${vault:key}, ${service:ref}, ...

/**
 * Build a resolver that deep-walks strings/arrays/objects and expands ${scheme:key} refs.
 * @param {Record<string, (key: string) => (string|undefined|null)>} schemes
 */
export function makeResolver(schemes = {}) {
  const resolveString = s => String(s).replace(REF, (_m, scheme, key) => {
    const fn = schemes[String(scheme).toLowerCase()]
    if (!fn) throw Object.assign(new Error(`secret ref uses unsupported scheme "${scheme}" (not wired)`), { code: 'secret-scheme-unsupported', scheme })
    const v = fn(String(key).trim())
    if (v == null || v === '') throw Object.assign(new Error(`secret ref ${scheme}:${key} resolved empty`), { code: 'secret-unresolved', scheme, key: String(key).trim() })
    return String(v)
  })
  const resolve = v => {
    if (typeof v === 'string') return resolveString(v)
    if (Array.isArray(v)) return v.map(resolve)
    if (v && typeof v === 'object') { const o = {}; for (const [k, val] of Object.entries(v)) o[k] = resolve(val); return o }
    return v
  }
  return resolve
}

/** The default resolver: only the `env` scheme, reading from process.env (or an injected env for tests). */
export const envResolver = (env = process.env) => makeResolver({ env: name => env[name] })
