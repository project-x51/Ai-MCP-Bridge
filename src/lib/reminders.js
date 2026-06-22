// Per-session behaviour reminders (#29) as an encapsulated module that OWNS the behaviours map. A session
// registers short 'how to behave when a message arrives' prompts scoped to a topic it owns / a host / a
// project / a subscription pattern / all; the bridge attaches the matching ones to each delivered message.
// Held in RAM per holder id, durable per identity (rehydrated on resync). bridge.mjs calls the API and never
// touches the map. Pure matching helpers come from lib/keys.js + lib/topics.js.
import { lc, projKey } from './keys.js'
import { patternKey, topicMatch } from './topics.js'

export const BEHAVIOR_SCOPES = ['topic', 'host', 'project', 'subscription', 'all']
const ORDER = { topic: 0, subscription: 1, project: 2, host: 3, all: 4 }   // most-specific first in the returned list
const MAX_LEN = 280, MAX_COUNT = 64
// identity key for a (scope, match) so re-registering the same one replaces it (case-insensitive).
const behKey = (scope, match) => `${scope}|${scope === 'topic' || scope === 'subscription' ? patternKey(match || '') : scope === 'all' ? '' : lc(match || '')}`

/** @param {{ persistence: any, persist: boolean }} ctx */
export function createReminders({ persistence, persist }) {
  const behaviors = new Map()   // holderId -> [{ scope, match, behavior, set_at }]
  let defaults = []             // bridge-wide config defaults [{ scope, match, behavior }] — apply to every session, overridable
  const listOf = id => behaviors.get(id) || []
  const view = b => ({ scope: b.scope, match: b.match, behavior: b.behavior, set_at: b.set_at })

  // does behaviour `b` match THIS envelope being delivered to holder `id`?
  function matches(b, id, env, matchedPattern) {
    const fromHost = String(env.from?.session || '').split('/')[0], fromProj = env.from?.project, topic = env.topic
    if (b.scope === 'all') return !env.system && env.from?.session !== id
    if (b.scope === 'host') return !!fromHost && lc(b.match) === lc(fromHost)
    if (b.scope === 'project') return !!fromProj && projKey(b.match) === projKey(fromProj)
    if (b.scope === 'topic') return !!topic && patternKey(b.match) === patternKey(topic)
    if (b.scope === 'subscription') return !!(topic && (patternKey(b.match) === patternKey(topic) || (matchedPattern && patternKey(b.match) === patternKey(matchedPattern)) || topicMatch(b.match, topic)))
    return false
  }

  /** The reminders whose scope matches THIS envelope being delivered to holder `id` (most-specific first).
   *  Merges the session's OWN reminders with the bridge config DEFAULTS — a session's own (scope,match)
   *  overrides the same-keyed default; default-sourced reminders are tagged `default:true`. Skips self-sent +
   *  system messages for the catch-all 'all' scope. */
  function remindersFor(id, env, matchedPattern) {
    const own = listOf(id), ownKeys = new Set(own.map(b => behKey(b.scope, b.match)))
    const out = []
    for (const b of own) if (matches(b, id, env, matchedPattern)) out.push({ scope: b.scope, match: b.match, behavior: b.behavior })
    for (const d of defaults) if (!ownKeys.has(behKey(d.scope, d.match)) && matches(d, id, env, matchedPattern)) out.push({ scope: d.scope, match: d.match, behavior: d.behavior, default: true })
    out.sort((a, b2) => (ORDER[a.scope] ?? 9) - (ORDER[b2.scope] ?? 9))
    return out
  }

  /** Set the bridge-wide default reminders (from config; live-reloadable). Deduped by (scope,match). */
  function setDefaults(listIn) {
    const byKey = new Map()
    for (const d of (Array.isArray(listIn) ? listIn : [])) {
      if (!d || !d.behavior) continue
      const scope = BEHAVIOR_SCOPES.includes(d.scope) ? d.scope : 'all'
      const match = scope === 'all' ? null : (d.match || null)
      byKey.set(behKey(scope, match), { scope, match, behavior: String(d.behavior).slice(0, 280) })
    }
    defaults = [...byKey.values()]
  }
  const defaultList = () => defaults.map(d => ({ scope: d.scope, match: d.match, behavior: d.behavior }))

  /** What this holder has registered (for list_behaviors + the resync). */
  const list = id => listOf(id).map(view)

  // low-level: set a reminder in RAM (replacing same scope+match) and persist it. Returns the new count.
  function put(holderId, identity, scope, match, behavior) {
    const without = listOf(holderId).filter(b => behKey(b.scope, b.match) !== behKey(scope, match))
    behaviors.set(holderId, [...without, { scope, match, behavior, set_at: new Date().toISOString() }])
    if (persist && identity) persistence.behaviors.put(identity, scope, match, behavior).catch(() => {})
    return behaviors.get(holderId).length
  }

  /** Validate + register a behaviour (set_behavior). Returns {ok,...} | {ok:false, code,...}. */
  function set(holderId, identity, rawScope, rawMatch, rawBehavior) {
    const scope = String(rawScope || '').trim().toLowerCase()
    if (!BEHAVIOR_SCOPES.includes(scope)) return { ok: false, code: 'bad-scope', scopes: BEHAVIOR_SCOPES }
    const match = scope === 'all' ? null : String(rawMatch || '').trim()
    if (scope !== 'all' && !match) return { ok: false, code: 'match-required', scope }
    const behavior = String(rawBehavior || '').trim()
    if (!behavior) return { ok: false, code: 'behavior-required' }
    if (behavior.length > MAX_LEN) return { ok: false, code: 'behavior-too-long', max: MAX_LEN, got: behavior.length }
    if (listOf(holderId).filter(b => behKey(b.scope, b.match) !== behKey(scope, match)).length >= MAX_COUNT) return { ok: false, code: 'too-many-behaviors', max: MAX_COUNT }
    const count = put(holderId, identity, scope, match, behavior)
    return { ok: true, scope, match, behavior, count }
  }

  /** Clear one (scope + match) or, with no scope, ALL. Returns {ok, cleared}. */
  function clear(holderId, identity, rawScope, rawMatch) {
    const scope = rawScope != null ? String(rawScope).trim().toLowerCase() : null
    const match = scope && scope !== 'all' ? String(rawMatch || '').trim() : null
    const before = listOf(holderId)
    if (!scope) {
      behaviors.set(holderId, [])
      if (persist && identity) persistence.behaviors.clear(identity).catch(() => {})
      return { ok: true, cleared: before.length }
    }
    const kept = before.filter(b => behKey(b.scope, b.match) !== behKey(scope, match))
    behaviors.set(holderId, kept)
    if (persist && identity) persistence.behaviors.remove(identity, scope, match).catch(() => {})
    return { ok: true, cleared: before.length - kept.length }
  }

  /** Rehydrate an identity's durable behaviours into RAM under its (new) holder id, on register/reattach (§20). */
  async function load(holderId, identity) {
    if (!persist || !identity) return
    try { const recs = await persistence.behaviors.byHolder(identity); if (recs.length) behaviors.set(holderId, recs.map(r => ({ scope: r.scope, match: r.match, behavior: r.behavior, set_at: r.set_at }))) } catch { }
  }

  /** The behaviour STRINGS this holder has topic-scoped to `topic` — stashed in a kept-alive marker on release (#26 x #29). */
  const topicBehaviors = (holderId, topic) => listOf(holderId).filter(b => b.scope === 'topic' && patternKey(b.match) === patternKey(topic)).map(b => b.behavior)

  /** Inherit topic-scoped behaviours from a kept-alive marker onto the new owner on reclaim. */
  function inherit(holderId, identity, topic, behaviorStrings) {
    for (const beh of (Array.isArray(behaviorStrings) ? behaviorStrings : [])) {
      const b = String(beh || '').slice(0, MAX_LEN); if (!b) continue
      put(holderId, identity, 'topic', topic, b)
    }
  }

  return { remindersFor, list, set, clear, load, topicBehaviors, inherit, setDefaults, defaultList }
}
