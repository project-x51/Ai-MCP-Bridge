// Server-side auth token sources for egress backends (#36). The bridge MINTS, CACHES, REFRESHES a bearer
// token and INJECTS it into the request — the caller never supplies, sees, or can override the credential or
// the token. This is "approach A": authenticated egress with the secret held by the operator side, not the
// AI session. Pluggable by `source.type`:
//   static — the token IS the resolved secret (e.g. ${env:SOME_TOKEN}); optional ttlSec.
//   http   — mint by an HTTP request (url/method/headers/json|body); read the token at `tokenPath`, its TTL
//            from `expiryPath` (seconds) or `ttlSec` (fallback); re-mint on expiry and on a 401 from the
//            target backend (refreshOn401) via invalidate().
//
// Secrets in the source config are ${scheme:key} references resolved through an injected resolver (env now;
// vault/service later — see lib/secret-resolver.js), so nothing sensitive is held longer than a mint needs.
// The token/credential are NEVER returned to the caller and NEVER logged/traced. Mints are single-flighted
// (concurrent callers share one in-flight mint) and cached with a refresh skew.

const dig = (obj, path) => String(path || '').split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

/**
 * @param {any} auth  a backend's `auth` config: { inject?: {header,format}, source: {type,...}, refreshOn401?, refreshSkewSec? }
 * @param {{ fetchImpl: Function, resolveSecret: (v:any)=>any, log?: Function }} deps
 * @returns {{ headerName: string, refreshOn401: boolean, header: () => Promise<{name:string,value:string}>, invalidate: () => void } | null}
 */
export function createAuthProvider(auth, { fetchImpl, resolveSecret, log } = /** @type {any} */ ({})) {
  if (!auth || !auth.source) return null
  const src = auth.source
  const inject = auth.inject || {}
  const headerName = String(inject.header || 'Authorization')
  const fmt = String(inject.format || 'Bearer {token}')
  const skewMs = Number(auth.refreshSkewSec) > 0 ? Number(auth.refreshSkewSec) * 1000 : 60000
  let cache = null       // { token, expMs }
  let inflight = null

  async function mint() {
    if (src.type === 'static') {
      const token = resolveSecret(src.token)
      if (!token) throw Object.assign(new Error('static source resolved empty'), { code: 'auth-no-token' })
      return { token: String(token), expMs: Number(src.ttlSec) > 0 ? Date.now() + Number(src.ttlSec) * 1000 : Infinity }
    }
    if (src.type === 'http') {
      const url = String(resolveSecret(src.url))
      const method = String(src.method || 'POST').toUpperCase()
      const headers = resolveSecret(src.headers && typeof src.headers === 'object' ? { ...src.headers } : {})
      let body
      if (src.json !== undefined) {
        body = JSON.stringify(resolveSecret(src.json))
        if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
      } else if (src.body !== undefined) body = String(resolveSecret(src.body))
      const res = await fetchImpl(url, { method, headers, body })
      if (!res.ok) throw Object.assign(new Error(`mint request failed (${res.status})`), { code: 'auth-mint-failed', status: res.status })
      let data = {}
      try { data = await res.json() } catch { data = {} }
      const token = dig(data, src.tokenPath || 'token')
      if (!token) throw Object.assign(new Error('mint response had no token at tokenPath'), { code: 'auth-no-token' })
      let expMs
      const expRaw = src.expiryPath ? dig(data, src.expiryPath) : null
      if (expRaw != null && Number.isFinite(Number(expRaw))) expMs = Date.now() + Number(expRaw) * 1000
      else expMs = Date.now() + (Number(src.ttlSec) > 0 ? Number(src.ttlSec) : 3600) * 1000
      return { token: String(token), expMs }
    }
    throw Object.assign(new Error(`unknown auth source type "${src.type}"`), { code: 'auth-bad-source' })
  }

  async function ensure() {
    if (cache && Date.now() < cache.expMs - skewMs) return cache
    if (inflight) return inflight
    inflight = (async () => { try { cache = await mint(); return cache } finally { inflight = null } })()
    return inflight
  }

  return {
    headerName,
    refreshOn401: auth.refreshOn401 !== false,   // default ON
    async header() { const c = await ensure(); return { name: headerName, value: fmt.replace('{token}', c.token) } },
    invalidate() { cache = null },
  }
}
