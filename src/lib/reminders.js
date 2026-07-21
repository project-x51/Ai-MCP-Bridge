// Behaviour reminders (#29, generalized to operations in #44). A session registers short 'how to behave'
// prompts, each bound to an OPERATION (which bridge action fires the check) plus a SCOPE+MATCH (which instances
// of it). The bridge attaches the matching reminder(s) to that operation's result:
//   - operation 'deliver' (the DEFAULT — a reminder with no operation is a delivery reminder, so all pre-#44
//     behaviours keep working): attached to each delivered message, on-message.
//   - outbound operations ('send', 'publish', 'claim_topic', 'allow_project', …): echoed in that TOOL's RESPONSE.
//     Response-side is post-hoc for the message CONTENT, but lands exactly when the agent composes its transcript
//     line / follow-up / report — which is where reporting & consent conventions live.
// SCOPE matches against the operation's SUBJECT: 'deliver' matches the SENDER (its project/host, the arrival
// topic); outbound operations match the TARGET (the project/topic/host the action concerns). No config default
// AND no session reminder for an operation ⇒ nothing fires there, so an un-opted operation stays silent — that
// is the whole flexibility: supporting an operation costs nothing until someone opts in.
// Held in RAM per holder id, durable per identity (rehydrated on resync). bridge.mjs calls the API; never the map.
import { lc, projKey } from './keys.js'
import { patternKey, topicMatch } from './topics.js'

export const BEHAVIOR_SCOPES = ['topic', 'host', 'project', 'subscription', 'all']
// The operations a reminder can attach to. 'deliver' is the default. Adding one is: list it here + call
// remindersFor() at that bridge hook with a subject context. An operation that can't expose a given scope's
// subject (e.g. a topic scope on allow_project, which has no topic) simply never matches — harmless.
export const BEHAVIOR_OPERATIONS = ['deliver', 'send', 'publish', 'claim_topic', 'release_topic', 'subscribe', 'allow_project', 'revoke_project', 'request_project_access']
const ORDER = { topic: 0, subscription: 1, project: 2, host: 3, all: 4 }   // most-specific first in the returned list
const MAX_LEN = 280, MAX_COUNT = 64
const op0 = o => (BEHAVIOR_OPERATIONS.includes(o) ? o : 'deliver')   // normalize: unknown/absent ⇒ 'deliver' (back-compat)
// identity key for a (operation, scope, match) so re-registering the same one replaces it (case-insensitive).
const behKey = (operation, scope, match) => `${op0(operation)}|${scope}|${scope === 'topic' || scope === 'subscription' ? patternKey(match || '') : scope === 'all' ? '' : lc(match || '')}`

/** @param {{ persistence: any, persist: boolean }} ctx */
export function createReminders({ persistence, persist }) {
  const behaviors = new Map()   // holderId -> [{ operation, scope, match, behavior, set_at }]
  let defaults = []             // bridge-wide config defaults [{ operation, scope, match, behavior }]
  const listOf = id => behaviors.get(id) || []
  const view = b => ({ operation: op0(b.operation), scope: b.scope, match: b.match, behavior: b.behavior, set_at: b.set_at })

  // does behaviour `b` match THIS operation context for holder `id`?
  // ctx = { operation, project?, host?, topic?, matchedPattern?, fromSelf?, system? }
  function matches(b, id, ctx) {
    if (op0(b.operation) !== op0(ctx.operation)) return false
    // 'all' skips self-sent + system messages on DELIVER (as before); on outbound ops there is no such notion.
    if (b.scope === 'all') return op0(ctx.operation) === 'deliver' ? (!ctx.system && !ctx.fromSelf) : true
    if (b.scope === 'host') return !!ctx.host && lc(b.match) === lc(ctx.host)
    if (b.scope === 'project') return !!ctx.project && projKey(b.match) === projKey(ctx.project)
    if (b.scope === 'topic') return !!ctx.topic && patternKey(b.match) === patternKey(ctx.topic)
    if (b.scope === 'subscription') return !!(ctx.topic && (patternKey(b.match) === patternKey(ctx.topic) || (ctx.matchedPattern && patternKey(b.match) === patternKey(ctx.matchedPattern)) || topicMatch(b.match, ctx.topic)))
    return false
  }

  /** The reminders matching THIS operation context for holder `id` (most-specific first). Merges the session's
   *  OWN reminders with the bridge config DEFAULTS — a session's own (operation,scope,match) overrides the
   *  same-keyed default; default-sourced reminders are tagged `default:true`. */
  function remindersFor(id, ctx) {
    const own = listOf(id), ownKeys = new Set(own.map(b => behKey(b.operation, b.scope, b.match)))
    const out = []
    for (const b of own) if (matches(b, id, ctx)) out.push({ operation: op0(b.operation), scope: b.scope, match: b.match, behavior: b.behavior })
    for (const d of defaults) if (!ownKeys.has(behKey(d.operation, d.scope, d.match)) && matches(d, id, ctx)) out.push({ operation: op0(d.operation), scope: d.scope, match: d.match, behavior: d.behavior, default: true })
    out.sort((a, b2) => (ORDER[a.scope] ?? 9) - (ORDER[b2.scope] ?? 9))
    return out
  }

  /** Set the bridge-wide default reminders (from config; live-reloadable). Deduped by (operation,scope,match). */
  function setDefaults(listIn) {
    const byKey = new Map()
    for (const d of (Array.isArray(listIn) ? listIn : [])) {
      if (!d || !d.behavior) continue
      const operation = op0(d.operation)
      const scope = BEHAVIOR_SCOPES.includes(d.scope) ? d.scope : 'all'
      const match = scope === 'all' ? null : (d.match || null)
      byKey.set(behKey(operation, scope, match), { operation, scope, match, behavior: String(d.behavior).slice(0, 280) })
    }
    defaults = [...byKey.values()]
  }
  const defaultList = () => defaults.map(d => ({ operation: d.operation, scope: d.scope, match: d.match, behavior: d.behavior }))

  /** What this holder has registered (for list_behaviors + the resync). */
  const list = id => listOf(id).map(view)

  // low-level: set a reminder in RAM (replacing same operation+scope+match) and persist it. Returns the new count.
  function put(holderId, identity, operation, scope, match, behavior) {
    const op = op0(operation)
    const without = listOf(holderId).filter(b => behKey(b.operation, b.scope, b.match) !== behKey(op, scope, match))
    behaviors.set(holderId, [...without, { operation: op, scope, match, behavior, set_at: new Date().toISOString() }])
    if (persist && identity) persistence.behaviors.put(identity, op, scope, match, behavior).catch(() => {})
    return behaviors.get(holderId).length
  }

  /** Validate + register a behaviour (set_behavior). Returns {ok,...} | {ok:false, code,...}. */
  function set(holderId, identity, rawOperation, rawScope, rawMatch, rawBehavior) {
    const operation = String(rawOperation || 'deliver').trim().toLowerCase() || 'deliver'
    if (!BEHAVIOR_OPERATIONS.includes(operation)) return { ok: false, code: 'bad-operation', operations: BEHAVIOR_OPERATIONS }
    const scope = String(rawScope || '').trim().toLowerCase()
    if (!BEHAVIOR_SCOPES.includes(scope)) return { ok: false, code: 'bad-scope', scopes: BEHAVIOR_SCOPES }
    const match = scope === 'all' ? null : String(rawMatch || '').trim()
    if (scope !== 'all' && !match) return { ok: false, code: 'match-required', scope }
    const behavior = String(rawBehavior || '').trim()
    if (!behavior) return { ok: false, code: 'behavior-required' }
    if (behavior.length > MAX_LEN) return { ok: false, code: 'behavior-too-long', max: MAX_LEN, got: behavior.length }
    if (listOf(holderId).filter(b => behKey(b.operation, b.scope, b.match) !== behKey(operation, scope, match)).length >= MAX_COUNT) return { ok: false, code: 'too-many-behaviors', max: MAX_COUNT }
    const count = put(holderId, identity, operation, scope, match, behavior)
    return { ok: true, operation, scope, match, behavior, count }
  }

  /** Clear one (operation + scope + match), or ALL if neither operation nor scope is given. Returns {ok, cleared}.
   *  A scope with no operation targets 'deliver' (so a pre-#44 `clear_behavior {scope}` still clears the right one). */
  function clear(holderId, identity, rawOperation, rawScope, rawMatch) {
    const scope = rawScope != null ? String(rawScope).trim().toLowerCase() : null
    const operation = rawOperation != null ? (String(rawOperation).trim().toLowerCase() || 'deliver') : null
    const match = scope && scope !== 'all' ? String(rawMatch || '').trim() : null
    const before = listOf(holderId)
    if (!scope && !operation) {
      behaviors.set(holderId, [])
      if (persist && identity) persistence.behaviors.clear(identity).catch(() => {})
      return { ok: true, cleared: before.length }
    }
    const op = op0(operation || 'deliver')
    const kept = before.filter(b => behKey(b.operation, b.scope, b.match) !== behKey(op, scope, match))
    behaviors.set(holderId, kept)
    if (persist && identity) persistence.behaviors.remove(identity, op, scope, match).catch(() => {})
    return { ok: true, cleared: before.length - kept.length }
  }

  /** Rehydrate an identity's durable behaviours into RAM under its (new) holder id, on register/reattach (§20). */
  async function load(holderId, identity) {
    if (!persist || !identity) return
    try { const recs = await persistence.behaviors.byHolder(identity); if (recs.length) behaviors.set(holderId, recs.map(r => ({ operation: op0(r.operation), scope: r.scope, match: r.match, behavior: r.behavior, set_at: r.set_at }))) } catch { }
  }

  /** The topic-scoped DELIVER reminder strings for a topic — ride along a kept-alive handoff (#26 × #29).
   *  Only delivery reminders are inherited (an outbound reminder is the sender's habit, not the topic's). */
  const topicBehaviors = (holderId, topic) => listOf(holderId).filter(b => op0(b.operation) === 'deliver' && b.scope === 'topic' && patternKey(b.match) === patternKey(topic)).map(b => b.behavior)

  /** Inherit topic-scoped DELIVER behaviours from a kept-alive marker onto the new owner on reclaim. */
  function inherit(holderId, identity, topic, behaviorStrings) {
    for (const beh of (Array.isArray(behaviorStrings) ? behaviorStrings : [])) {
      const b = String(beh || '').slice(0, MAX_LEN); if (!b) continue
      put(holderId, identity, 'deliver', 'topic', topic, b)
    }
  }

  return { remindersFor, list, set, clear, load, topicBehaviors, inherit, setDefaults, defaultList }
}
