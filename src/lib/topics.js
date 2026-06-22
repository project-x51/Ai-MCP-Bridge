// Pure topic-path logic (no shared state) — extracted from bridge.mjs so it can be reasoned about and
// unit-tested in isolation. Topics are /-separated paths, matched case-insensitively per level; wildcards
// (subscriptions + claims only): '+' = one level, '#' = the rest of the subtree. (architecture.md §6, T1/T4)

/** Split a topic/pattern into lower-cased path segments (the canonical, case-insensitive form). */
export function splitTopic(t) { return String(t || '').trim().toLowerCase().split('/').filter(Boolean) }

/** Does the pattern contain a wildcard ('+' one level, '#' subtree)? */
export function isWildcard(t) { const p = splitTopic(t); return p.includes('+') || p.includes('#') }

/** The canonical comparison key for a topic/pattern (lower-cased, slash-joined). */
export const patternKey = t => splitTopic(t).join('/')

/** Does a concrete topic fall under a (possibly wildcard) pattern? */
export function topicMatch(pattern, topic) {
  const p = splitTopic(pattern), t = splitTopic(topic)
  if (!p.length || !t.length) return false
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true
    if (i >= t.length) return false
    if (p[i] === '+') continue
    if (p[i] !== t[i]) return false
  }
  return p.length === t.length
}

/** Could ANY concrete topic match BOTH patterns? (used for exclusive-claim conflicts, T6) */
export function patternsOverlap(a, b) {
  const A = splitTopic(a), B = splitTopic(b)
  if (!A.length || !B.length) return false
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i], y = B[i]
    if (x === '#' || y === '#') return true
    if (x == null || y == null) return false
    if (x === '+' || y === '+') continue
    if (x !== y) return false
  }
  return true
}

// Topics are project-scoped (§6). A bare ref resolves in the asker's project; "@project/path" or
// "@realm:project/path" targets another project's topic (cross-project send is then consent-gated).
// `defaultRealm` is passed in (was a hidden global REALM dependency) so this stays pure.
/** @returns {{ project: string, realm: string, path: string }} */
export function parseTopicRef(ref, askerProject, defaultRealm = 'default') {
  let s = String(ref || '').trim()
  let project = askerProject || 'unclassified', realm = defaultRealm || 'default'
  if (s.startsWith('@')) {
    s = s.slice(1)
    const slash = s.indexOf('/')
    const head = slash >= 0 ? s.slice(0, slash) : s
    s = slash >= 0 ? s.slice(slash + 1) : ''
    if (head.includes(':')) { const [r, p] = head.split(':'); realm = r || realm; project = p || project }
    else project = head || project
  }
  return { project, realm, path: s }
}
