// Egress service (#33) — the FIRST in-process capability module (services layer; see docs/web-edge-node.md).
// Lets an AI session perform GET/POST to OPERATOR-DECLARED backends via the bridge — e.g. cowork sessions
// calling a local GCloud emulator. NAMED BACKENDS ONLY (no arbitrary URLs) + a PER-BACKEND PROJECT ALLOWLIST,
// so sessions can't run rampant on any URL. Runs in the bridge process the caller is attached to (no port);
// only configured when config.services.egress (or AI_BRIDGE_EGRESS_BACKENDS) is present — a capability that
// isn't opened can't be attacked.
import { projKey } from '../lib/keys.js'
import { parseSize } from '../facets/persistence/file.js'

export const meta = { service: 'egress' }

function normalize(rawBackends) {
  const out = {}
  for (const [name, b] of Object.entries(rawBackends || {})) {
    if (!b || !b.base) continue
    out[name] = {
      base: String(b.base),
      methods: (Array.isArray(b.methods) ? b.methods : ['GET']).map(m => String(m).toUpperCase()),
      projects: (Array.isArray(b.projects) ? b.projects : []).map(p => projKey(p)),   // explicit allowlist — no '*'
      headers: (b.headers && typeof b.headers === 'object') ? b.headers : {},          // injected server-side; never echoed
      allowHeaders: (Array.isArray(b.allowHeaders) ? b.allowHeaders : []).map(h => String(h).toLowerCase()),
      timeoutMs: Number(b.timeoutMs) > 0 ? Number(b.timeoutMs) : 15000,
      maxResponseBytes: parseSize(b.maxResponseBytes) ?? 8 * 1024 * 1024,
      followRedirects: !!b.followRedirects,
    }
  }
  return out
}

const TEXTY = /^(text\/|application\/(json|xml|.*\+json|.*\+xml|javascript|x-www-form-urlencoded|graphql))/i

/** @param {{ config?: any, log?: Function, trace?: Function, fetchImpl?: Function }} [ctx] */
export function create({ config, log, trace, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  let backends = normalize(config && config.backends)
  const setConfig = cfg => { backends = normalize(cfg && cfg.backends) }

  const tools = [{
    name: 'http_request',
    description: 'Perform an HTTP request to an OPERATOR-DECLARED backend (config.services.egress.backends) — e.g. a local dev/emulator API. You may NOT pass an arbitrary URL: you name a configured backend + a path, and the bridge joins them (the final URL is contained to the backend\'s origin). Your project must be in the backend\'s allowlist. Methods are per-backend; request headers you set are filtered to the backend\'s allowHeaders; the operator may inject auth headers server-side (never returned). Response body is text, or base64 for binary (encoding:"base64"), capped at the backend\'s maxResponseBytes (truncated:true if clipped). Sub-peers pass as + secret.',
    inputSchema: {
      type: 'object',
      properties: {
        backend: { type: 'string', description: 'a configured backend name' },
        method: { type: 'string', description: 'HTTP method (default GET); must be allowed by the backend' },
        path: { type: 'string', description: 'path joined onto the backend base (default "/"). NOT a full URL — no scheme, no "//host", no ".." escape.' },
        query: { type: 'object', description: 'key→value query params, URL-encoded onto the request' },
        headers: { type: 'object', description: 'request headers — only those in the backend allowHeaders pass through' },
        body: { type: 'string', description: 'request body (for POST/PUT/PATCH)' },
        json: { type: 'object', description: 'convenience: sets body = JSON.stringify(json) + content-type application/json' },
        as: { type: 'string', description: 'your registered sub-peer handle (id, suffix, or name)' },
        secret: { type: 'string', description: 'the secret used at register_self' },
      },
      required: ['backend'],
    },
  }]

  /** @param {string} name @param {any} a @param {{ project?: string, holder?: string, name?: string }} caller */
  async function handle(name, a, caller) {
    if (name !== 'http_request') return { ok: false, code: 'unknown-tool' }
    const bname = String(a.backend || '').trim()
    const b = backends[bname]
    if (!b) return { ok: false, code: 'unknown-backend', backend: bname, available: Object.keys(backends) }
    if (!b.projects.includes(projKey(caller && caller.project))) return { ok: false, code: 'forbidden', reason: 'project-not-allowed', backend: bname }
    const method = String(a.method || 'GET').toUpperCase()
    if (!b.methods.includes(method)) return { ok: false, code: 'method-not-allowed', method, allowed: b.methods }

    // --- build + CONTAIN the URL: the final origin must equal the backend base origin (core SSRF defense) ---
    let url, baseOrigin
    try {
      baseOrigin = new URL(b.base).origin
      const rel = String(a.path || '')
      if (/:\/\//.test(rel) || rel.startsWith('//') || rel.split(/[/\\]/).includes('..')) return { ok: false, code: 'bad-path', reason: 'path-not-relative' }
      url = new URL(b.base.replace(/\/+$/, '') + '/' + rel.replace(/^\/+/, ''))
      if (url.origin !== baseOrigin) return { ok: false, code: 'bad-path', reason: 'origin-escape' }
    } catch { return { ok: false, code: 'bad-path' } }
    if (a.query && typeof a.query === 'object') for (const [k, v] of Object.entries(a.query)) url.searchParams.append(k, String(v))

    // --- headers: caller's filtered to allowHeaders; backend's injected server-side (override + never echoed) ---
    const headers = {}
    if (a.headers && typeof a.headers === 'object') for (const [k, v] of Object.entries(a.headers)) if (b.allowHeaders.includes(k.toLowerCase())) headers[k] = String(v)
    let body = a.body
    if (a.json !== undefined) { body = JSON.stringify(a.json); if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json' }
    for (const [k, v] of Object.entries(b.headers)) headers[k] = String(v)

    // --- perform with timeout ---
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), b.timeoutMs)
    const noBody = method === 'GET' || method === 'HEAD'
    let res
    try {
      res = await doFetch(url.href, { method, headers, body: noBody ? undefined : body, redirect: b.followRedirects ? 'follow' : 'manual', signal: ctrl.signal })
    } catch (e) {
      clearTimeout(timer)
      trace && trace({ dir: 'send', verb: 'http_request', from: caller && caller.holder, from_name: caller && caller.name, to: bname, to_kind: 'backend', size: 0, note: `${method} ${bname}${url.pathname} -> ${e && e.name === 'AbortError' ? 'timeout' : 'failed'}` })
      return { ok: false, code: (e && e.name === 'AbortError') ? 'timeout' : 'request-failed', reason: String((e && e.message) || e), backend: bname }
    }
    clearTimeout(timer)

    // --- read body up to the cap; text vs base64 by content-type ---
    let buf
    try { buf = Buffer.from(await res.arrayBuffer()) } catch { buf = Buffer.alloc(0) }
    const truncated = buf.length > b.maxResponseBytes
    const slice = truncated ? buf.subarray(0, b.maxResponseBytes) : buf
    const ct = res.headers.get('content-type') || ''
    const texty = TEXTY.test(ct)
    const resHeaders = {}; res.headers.forEach((v, k) => { resHeaders[k] = v })
    trace && trace({ dir: 'send', verb: 'http_request', from: caller && caller.holder, from_name: caller && caller.name, to: bname, to_kind: 'backend', size: buf.length, note: `${method} ${bname}${url.pathname} -> ${res.status} (${buf.length}b)` })
    return {
      ok: res.ok, status: res.status, statusText: res.statusText,
      headers: resHeaders, body: texty ? slice.toString('utf8') : slice.toString('base64'),
      ...(texty ? {} : { encoding: 'base64' }), ...(truncated ? { truncated: true } : {}),
      backend: bname, method, url: url.href,
    }
  }

  if (log) log(`service egress: ${Object.keys(backends).length} backend(s) [${Object.keys(backends).join(', ')}]`)
  return { meta, tools, handle, setConfig, backendNames: () => Object.keys(backends) }
}
