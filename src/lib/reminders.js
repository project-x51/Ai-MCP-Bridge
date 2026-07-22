// Behaviour reminders (#29, generalized to operations in #44; the incoming operation renamed 'deliver'→'receive'
// in #47). A session registers short 'how to behave' prompts, each bound to an OPERATION (which bridge action
// fires the check) plus a SCOPE+MATCH (which instances of it). The bridge attaches the matching reminder(s) to
// that operation's result:
//   - operation 'receive' (the DEFAULT — a reminder with no operation is a receive reminder, so all pre-#44
//     behaviours keep working): attached to each message that ARRIVES, on-message. ('deliver' is accepted as a
//     legacy alias for 'receive' — see OP_ALIASES — so stale clients and existing durable .beh files still work.)
//   - outbound operations ('send', 'publish', 'claim_topic', 'allow_project', …): echoed in that TOOL's RESPONSE.
//     Response-side is post-hoc for the message CONTENT, but lands exactly when the agent composes its transcript
//     line / follow-up / report — which is where reporting & consent conventions live.
// SCOPE matches against the operation's SUBJECT: 'receive' matches the SENDER (its project/host, the arrival
// topic); outbound operations match the TARGET (the project/topic/host the action concerns). No config default
// AND no session reminder for an operation ⇒ nothing fires there, so an un-opted operation stays silent — that
// is the whole flexibility: supporting an operation costs nothing until someone opts in.
// Held in RAM per holder id, durable per identity (rehydrated on resync). bridge.mjs calls the API; never the map.
import { lc, projKey } from './keys.js'
import { patternKey, topicMatch } from './topics.js'

export const BEHAVIOR_SCOPES = ['topic', 'host', 'project', 'subscription', 'all']
// The operations a reminder can attach to. 'receive' is the default. Adding one is: list it here + call
// remindersFor() at that bridge hook with a subject context. An operation that can't expose a given scope's
// subject (e.g. a topic scope on allow_project, which has no topic) simply never matches — harmless.
export const BEHAVIOR_OPERATIONS = ['receive', 'send', 'publish', 'claim_topic', 'release_topic', 'subscribe', 'allow_project', 'revoke_project', 'request_project_access']
// #47: 'deliver' was renamed 'receive'. The old name stays accepted everywhere as an alias — both from a stale
// client that still sends operation:'deliver', and from durable .beh files written before the rename — so nothing
// re-anchors: op0 folds it to the canonical name on the way in.
export const OP_ALIASES = { deliver: 'receive' }
const ORDER = { topic: 0, subscription: 1, project: 2, host: 3, all: 4 }   // most-specific first in the returned list
const MAX_LEN = 280, MAX_COUNT = 64
const op0 = o => { const x = OP_ALIASES[o] || o; return BEHAVIOR_OPERATIONS.includes(x) ? x : 'receive' }   // normalize: alias/unknown/absent ⇒ canonical, default 'receive'
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
    // 'all' skips self-sent + system messages on RECEIVE (as before); on outbound ops there is no such notion.
    if (b.scope === 'all') return op0(ctx.operation) === 'receive' ? (!ctx.system && !ctx.fromSelf) : true
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
    const rawOp = String(rawOperation || 'receive').trim().toLowerCase() || 'receive'
    const operation = OP_ALIASES[rawOp] || rawOp   // #47: fold 'deliver'→'receive' BEFORE validating, so a stale client isn't rejected
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
   *  A scope with no operation targets 'receive' (so a pre-#44 `clear_behavior {scope}` still clears the right one). */
  function clear(holderId, identity, rawOperation, rawScope, rawMatch) {
    const scope = rawScope != null ? String(rawScope).trim().toLowerCase() : null
    const operation = rawOperation != null ? (String(rawOperation).trim().toLowerCase() || 'receive') : null
    const match = scope && scope !== 'all' ? String(rawMatch || '').trim() : null
    const before = listOf(holderId)
    if (!scope && !operation) {
      behaviors.set(holderId, [])
      if (persist && identity) persistence.behaviors.clear(identity).catch(() => {})
      return { ok: true, cleared: before.length }
    }
    const op = op0(operation || 'receive')   // op0 also folds a stale 'deliver' to 'receive'
    const kept = before.filter(b => behKey(b.operation, b.scope, b.match) !== behKey(op, scope, match))
    behaviors.set(holderId, kept)
    if (persist && identity) persistence.behaviors.remove(identity, op, scope, match).catch(() => {})
    return { ok: true, cleared: before.length - kept.length }
  }

  /** Rehydrate an identity's durable behaviours into RAM under its (new) holder id, on register/reattach (§20). */
  async function load(holderId, identity) {
    if (!persist || !identity) return
    try {
      const recs = await persistence.behaviors.byHolder(identity)
      if (!recs.length) return
      // Dedup by (operation,scope,match) key: after #47 a legacy 'deliver'-named file and a canonical 'receive'
      // file can co-exist on disk for one logical reminder (op0 folds both to 'receive'); collapse them so the
      // holder doesn't get the same reminder twice. Last record wins.
      const byKey = new Map()
      for (const r of recs) byKey.set(behKey(r.operation, r.scope, r.match), { operation: op0(r.operation), scope: r.scope, match: r.match, behavior: r.behavior, set_at: r.set_at })
      behaviors.set(holderId, [...byKey.values()])
    } catch { }
  }

  /** The topic-scoped RECEIVE reminder strings for a topic — ride along a kept-alive handoff (#26 × #29).
   *  Only receive reminders are inherited (an outbound reminder is the sender's habit, not the topic's). */
  const topicBehaviors = (holderId, topic) => listOf(holderId).filter(b => op0(b.operation) === 'receive' && b.scope === 'topic' && patternKey(b.match) === patternKey(topic)).map(b => b.behavior)

  /** Inherit topic-scoped RECEIVE behaviours from a kept-alive marker onto the new owner on reclaim. */
  function inherit(holderId, identity, topic, behaviorStrings) {
    for (const beh of (Array.isArray(behaviorStrings) ? behaviorStrings : [])) {
      const b = String(beh || '').slice(0, MAX_LEN); if (!b) continue
      put(holderId, identity, 'receive', 'topic', topic, b)
    }
  }

  return { remindersFor, list, set, clear, load, topicBehaviors, inherit, setDefaults, defaultList }
}
