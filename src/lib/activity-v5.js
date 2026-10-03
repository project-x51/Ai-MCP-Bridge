// #88 (v2.0) build step 11: the 1.7x (v5) READERS — what is left of the 1.7x activity model once step 11 deleted it. Used by
// the migration only (lib/activity2-convert.js, driven by src/tools/aimb-migrate-v2.mjs and the 2.0 gateway's start check):
// a 1.7x day-file record's kind (formats v2 – v5) and the 1.7x PATH (`@` contexts, `@~` on the last segment, `@"…"` quoting,
// `@root`), its canonical spelling and its key. Nothing in the bridge reads or writes v5 any more (docs/spec-88.md §8 step 11:
// "the v2 – v5 readers … live on only in lib/activity-v5.js for the script").
//
// THE 1.7x PATH (for reading old records): one `/`-separated path; a segment starting with `@` is a context, anything else
// an agent: `spec-70`, `spec-70/@Tharsis`, `@#70/@step4/spec-70`; quote a context name with spaces: `@"CTX strip 17"`; `@~` on
// the LAST segment set that node's current line; `@root` as the last segment means the node itself. Agent segment: letters /
// digits / _ then `. : # + -` (≤ 48, no spaces); context name ≤ 60 code points, no `"`, `/` or control characters ("root"
// is reserved). The node KEY = lc(canonical path); depth ≤ 6 (1.7x's limit, ACTIVITY_LIMITS.depth).
import { lc } from './keys.js'
import { ACTIVITY_LIMITS, ACTIVITY_STATES } from './activity.js'

/** The last 1.7x record / slice format (6d, v1.65.0 – v1.75.1). */
export const ACTIVITY_FORMAT = 5
/** The 1.7x record formats a reader takes: v2 (6a) – v5 (6d); a v1 record of 1.58 – 1.61 is skipped, never misread. */
const RECORD_FORMATS = new Set([2, 3, 4, 5])

const cpLen = s => { let n = 0; for (const _ of s) n++; return n }   // length in code points
const cpSlice = (s, n) => Array.from(s).slice(0, n).join('')
/** @typedef {{ ok: boolean, code?: string, what?: string, [key: string]: any }} ActivityResult */
/** @returns {ActivityResult} */
const bad = (code, what) => ({ ok: false, code, what })
const finite = v => typeof v === 'number' && Number.isFinite(v)

/**
 * A 1.7x JSONL record's kind: 'entry' (a logged message), 'cp', 'rep', 'cf' (6b: a carry-forward snapshot) — or null for
 * anything unusable (skipped), INCLUDING a pre-6a v1 record (1.58–1.61: agent/context fields) — never misread as a node
 * record. v2 (1.62) – v5 (1.65 – 1.75) records are all read: each format only ADDS.
 */
export function recordKind(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || !RECORD_FORMATS.has(r.v)) return null
  if (Array.isArray(r.rep)) return finite(r.last) && r.rep.every(k => Number.isInteger(k)) ? 'rep' : null
  if (typeof r.session !== 'string' || !r.session.trim() || typeof r.path !== 'string' || !finite(r.ts)) return null
  if (r.kind === 'cp') return Number.isInteger(r.k) ? 'cp' : null
  if (r.kind === 'cf') return 'cf'
  if (r.kind != null) return null
  return typeof r.id === 'string' && typeof r.text === 'string' && r.text && ACTIVITY_STATES.includes(r.state) ? 'entry' : null
}

/**
 * Canonicalise a 1.7x context NAME (without its at-sign/tilde markers): whitespace runs → one space, trimmed, ≤ 60 code
 * points, no control chars, `"` or `/`. Any case of "root" → 'root'.
 * @param {any} raw
 * @returns {ActivityResult} { ok:true, name } or { ok:false, code, what }
 */
function normContextName(raw) {
  if (typeof raw !== 'string') return bad('bad-context', 'context must be a string')
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) return bad('bad-context', 'context name is empty')
  if (/["\u0000-\u001f\u007f]/.test(name)) return bad('bad-context', 'context name may not contain quotes or control characters')
  if (name.includes('/')) return bad('bad-context', 'context name may not contain "/" (it separates path segments — nest with a path: "@a/@b")')
  if (cpLen(name) > ACTIVITY_LIMITS.context) return bad('context-too-long', `context name is longer than ${ACTIVITY_LIMITS.context} chars`)
  return { ok: true, name: lc(name) === 'root' ? 'root' : name }
}
const SEGMENT = /^[\p{L}\p{N}_][\p{L}\p{N}_.:#+-]*$/u
function normAgentSeg(raw) {
  const s = String(raw).trim()
  if (!s) return bad('bad-agent', 'agent path has an empty segment')
  if (cpLen(s) > ACTIVITY_LIMITS.pathSegment) return bad('bad-agent', `agent path segment "${cpSlice(s, 20)}…" is longer than ${ACTIVITY_LIMITS.pathSegment} chars`)
  if (!SEGMENT.test(s)) return bad('bad-agent', `agent path segment "${cpSlice(s, 40)}" may only use letters, digits and _ . : # + - (no spaces; a context segment starts with @)`)
  return { ok: true, name: s }
}
const tooDeep = n => bad('path-too-deep', `the path has ${n} segments; the limit is ${ACTIVITY_LIMITS.depth}`)
/** @typedef {{ kind: 'agent'|'context', name: string }} PathSeg */
const needsQuote = name => /\s/.test(name) || name[0] === '~'
const segText = s => (s.kind === 'context' ? '@' + (needsQuote(s.name) ? `"${s.name}"` : s.name) : s.name)
/** The canonical 1.7x display path of segments ('' = the session root). Its lc() is the v5 node KEY. @param {PathSeg[]} segs */
export const formatPath = segs => segs.map(segText).join('/')
/** The v5 node key of a 1.7x display path (case-insensitive). */
export const pathKey = p => lc(p)
/**
 * Scan a 1.7x path at `i` of `s`: segments split on `/` (outside quotes). A segment starting with `@` is a context (`@~` = the
 * current-line marker; `@"…"` quoted; `@root` = the node itself), anything else an agent segment.
 * @returns {ActivityResult} { ok, segs:[{kind,name,current,root}], end }
 */
function scanPath(s, i) {
  const out = []
  for (;;) {
    if (i >= s.length) { if (!out.length) return bad('bad-path', 'empty path'); break }
    if (s[i] === '/') return bad('bad-path', 'path has an empty segment')
    if (s[i] === '@') {
      let j = i + 1, current = false
      if (s[j] === '~') { current = true; j++ }
      let raw
      if (s[j] === '"') {
        const close = s.indexOf('"', j + 1)
        if (close < 0) return bad('bad-context', 'unterminated quoted context name (@"…")')
        raw = s.slice(j + 1, close); j = close + 1
        if (j < s.length && s[j] !== '/') return bad('bad-context', 'a quoted context name must end its segment')
        const n = normContextName(raw); if (!n.ok) return n
        out.push({ kind: 'context', name: n.name, current, root: n.name === 'root' })
      } else {
        let k = j
        while (k < s.length && s[k] !== '/') k++
        raw = s.slice(j, k); j = k
        const n = normContextName(raw); if (!n.ok) return n
        out.push({ kind: 'context', name: n.name, current, root: n.name === 'root' })
      }
      i = j
    } else {
      let k = i
      while (k < s.length && s[k] !== '/') k++
      const a = normAgentSeg(s.slice(i, k)); if (!a.ok) return a
      out.push({ kind: 'agent', name: a.name, current: false, root: false })
      i = k
    }
    if (s[i] === '/') { i++; if (i >= s.length) break }   // a trailing slash is tolerated
    else if (i < s.length) return bad('bad-path', 'unexpected character in the path')
  }
  return { ok: true, segs: out, end: i }
}
/** Normalise scanned segments: `@~` only on the last, `@root` only last (→ the node itself), depth ≤ 6. */
function finishSegs(raw) {
  const segs = [], n = raw.length
  let current = false
  for (let k = 0; k < n; k++) {
    const r = raw[k], last = k === n - 1
    if (r.current && !last) return bad('bad-path', '@~ (set the current line) may only mark the LAST segment')
    if (r.root && !last) return bad('bad-path', '@root (the node itself) may only be the last segment')
    if (last && r.current) current = true
    if (!r.root) segs.push({ kind: r.kind, name: r.name })
  }
  if (segs.length > ACTIVITY_LIMITS.depth) return tooDeep(segs.length)
  return { ok: true, segs, current }
}
/**
 * Parse a full 1.7x node PATH (a record's `path`): `spec-70/@Tharsis/@~z12`, `@#70/spec-70`, `@"CTX strip 17"`, `a/@~root`.
 * Leading/trailing slashes are dropped; '' (or just '@root') = the session itself.
 * @param {any} raw
 * @returns {ActivityResult} { ok:true, segs, current, path, key } or { ok:false, code, what }
 */
export function parsePath(raw) {
  if (typeof raw !== 'string') return bad('bad-path', 'path must be a string like "spec-70/@Tharsis"')
  const s = raw.trim().replace(/^\/+|\/+$/g, '')
  if (!s) return { ok: true, segs: [], current: false, path: '', key: '' }
  const r = scanPath(s, 0); if (!r.ok) return r
  const f = finishSegs(r.segs); if (!f.ok) return f
  const path = formatPath(f.segs)
  return { ok: true, segs: f.segs, current: f.current, path, key: pathKey(path) }
}
