#!/usr/bin/env node
// Ai MCP Bridge — peer-to-peer AI session mesh (v1.3: topics, encryption, mandatory subject).
// One bridge per MCP stdio client. Claude Code: one process per session. Claude
// Desktop/Cowork: ONE process shared by all conversations — those register as
// sub-peers (register_self) with their own queues, secrets and roster presence.
// Port-bind election picks the per-host gateway; followers register over a control
// connection. Same-host pairs dial each other's loopback ports directly; the gateway
// is registry + WS ingress for page leaves + trace collector for the dashboard.
// Cross-host CONNECT splice implemented (untested until a second host joins the tailnet).
// Design + protocol reference: see README.md.
//         (supersedes the Responsibilities amendment pre-go-live: topics with subscribe/own,
//          publish/send patterns, mandatory subject, encrypted bodies, reserved wake/offline surface)

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { buildProfile } from './facets/index.js'
import { splitTopic, isWildcard, topicMatch, patternsOverlap, patternKey, parseTopicRef } from './lib/topics.js'
import { envelopeId } from './lib/envelope.js'
import { TOOLS } from './lib/tool-schemas.js'
import { lc, projKey } from './lib/keys.js'
import { hydrateEnvFromRegistry } from './lib/win-env.js'
import { createConsent, parseTtlMin } from './lib/consent.js'
import { createReminders } from './lib/reminders.js'
import { createTraces } from './lib/traces.js'
import { create as createEgress } from './services/egress.js'

// ---------------------------------------------------------------- config / identity
const HERE = path.dirname(fileURLToPath(import.meta.url))
let CFG = {}
try { CFG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) } catch {}
const PORT = Number(process.env.AI_BRIDGE_PORT || CFG.port || 7000)
const WS_PORT = Number(process.env.AI_BRIDGE_WS_PORT || CFG.wsPort || 7001)
const TOKEN = process.env.AI_BRIDGE_TOKEN || CFG.token || ''
const HOST = '127.0.0.1'                                                  // loopback: same-machine pair-dial + local-gateway connect
const BIND = process.env.AI_BRIDGE_BIND || CFG.bind || HOST               // interface to LISTEN on (0.0.0.0 / tailnet IP enables cross-host, §7)
let ADVERTISE = process.env.AI_BRIDGE_ADVERTISE_HOST || CFG.advertiseHost || (BIND && BIND !== '0.0.0.0' ? BIND : HOST)   // address peers DIAL me at (auto-derived from the discovery facet if left as loopback — §7)
const ADVERTISE_AUTO = !(process.env.AI_BRIDGE_ADVERTISE_HOST || (CFG && CFG.advertiseHost))   // no explicit advertise ⇒ may fill it from discovery.selfHost()
const DISCOVERY_MS = Number(process.env.AI_BRIDGE_DISCOVERY_MS || 5000)   // cross-host peer-hub discovery cadence (§7)
const VER = 1
const MODE_OVERRIDE = (process.env.AI_BRIDGE_MODE || CFG.mode || '') || null   // 'push' | 'poll' | null
const SWEEP_MS = Number(process.env.AI_BRIDGE_SWEEP_MS || 60000)
const SUB_TTL_MIN = Number(CFG.subpeerTtlMinutes || 720)
const CHILD_TTL_MIN = Number(CFG.subagentTtlMinutes || 60)

// realm = this bridge's trust domain (one shared config file = one realm); see docs/architecture.md.
const REALM = process.env.AI_BRIDGE_REALM || CFG.realm || 'default'
// a Code session may classify its own process via env; absent ⇒ the process is infrastructure
// (gateway/relay), which carries no project (see "participants vs infrastructure").
const PROC_PROJECT = process.env.AI_BRIDGE_PROJECT || CFG.project || null
// `user` is the human running this machine, derived from the OS-authenticated login — NOT
// session-declarable, so it can't be fabricated or misaligned. AI_BRIDGE_USER overrides it (tests +
// headless deployments). On a local Windows account this is the account name (e.g. "robin").
const OS_USER = (() => { try { return os.userInfo().username || null } catch { return process.env.USERNAME || process.env.USER || null } })()
const PROC_USER = process.env.AI_BRIDGE_USER || OS_USER

const ALIASES = CFG.aliases || {}          // hostname -> friendly alias (persisted)
function persistAliases() {
  try {
    const p = path.join(HERE, 'config.json')
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
    cfg.aliases = ALIASES
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
  } catch (e) { log('alias persist failed', e.message) }
}

const BRIDGE_VERSION = '1.24.14'          // bump on every behavioural change; surfaced in my_identity,
                                           // roster entries and the page welcome so peers can detect a changed bridge
const CAPS = { wake: false, park: false, retain: false, persistent_claims: false }   // T14 feature detection
const SESSION = `${os.hostname()}/${crypto.randomBytes(4).toString('hex')}`
let NAME = process.env.AI_BRIDGE_NAME || CFG.defaultName || SESSION.split('/')[1]
// a headless bridge (e.g. launched by the tray) has no MCP client to detect, so it can declare one
// via AI_BRIDGE_CLIENT (the tray passes "Task Tray"). A real MCP client overrides this at initialize.
let CLIENT = process.env.AI_BRIDGE_CLIENT
  ? { name: process.env.AI_BRIDGE_CLIENT, version: null, channel_capable: false, detected_mode: 'poll', mode: 'poll' }
  : null                                   // { name, version, channel_capable, detected_mode, mode }

const log = (...a) => console.error(`[aimb ${NAME}]`, ...a)
// Resilience (mesh daemon): a stray error in ONE connection's frame handler or an unobserved promise must
// never take the whole gateway down — that would drop every session on the mesh. Registered HERE, up front,
// so it also covers the election/discovery/inter-hub machinery that starts at module load. (Clean exit is
// only via the signal handlers at the bottom.) This also removed a class of test flakiness where a racy
// inter-hub frame crashed a bridge mid-suite.
process.on('uncaughtException', e => { try { log('uncaughtException (continuing):', (e && e.stack) || e) } catch {} })
process.on('unhandledRejection', (/** @type {any} */ e) => { try { log('unhandledRejection (continuing):', (e && e.message) || e) } catch {} })
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex')

// ---------------------------------------------------------------- realm profile (pluggable facets)
// docs/architecture.md §9: the core mesh logic is realm-agnostic and reaches security / identity /
// transport ONLY through `profile`, assembled from swappable facet modules in ./facets/. To change
// auth/cipher/identity/transport, add a facet impl file and select it (config.profile) — see
// facets/index.js. The locals below are the names the core uses, sourced from the active facets.
const ctx = { TOKEN, REALM, CFG, HERE, SESSION, PORT, ADVERTISE, env: process.env, log }
const profile = buildProfile(ctx)
const encryptEnvelope = profile.cipher.seal      // BodyCipher
const plainBody = profile.cipher.open
const decryptedView = profile.cipher.view
const capKeyFrom = profile.capSigner.deriveKey   // CapSigner
const classifyIdentity = profile.identity.classify   // IdentityModel
const sendFrame = profile.transport.frame.send   // Transport framing
const onFrames = profile.transport.frame.onFrames
const discovery = profile.discovery              // Discovery facet (§7): cross-host peer-hub enumeration
const persistence = profile.persistence          // Persistence facet (§12): durable mailboxes / claims / retained
const authorizer = profile.authorizer            // Authorizer facet (§16): human-in-the-loop confirmation (none/script/hello)
const vault = profile.vault                       // Vault facet (§21): seal/unseal a session's secret for presence-gated recovery (none/script/tpm)
const VAULT = profile.names.vault !== 'none'
// §21: when a caller presents a wrong/lost secret and the vault is on, point them at recover_secret — a
// presence check (Windows Hello in the tpm impl) returns their ORIGINAL sealed secret so they can retry.
// Empty when there's no vault (recovery is impossible, so the hint would be misleading).
const recoverHint = (name, project) => VAULT
  ? { recoverable: true, hint: `lost this secret (e.g. a compaction dropped it)? recover it — recover_secret { name: ${JSON.stringify(name || '')}${project ? `, project: ${JSON.stringify(project)}` : ''} } runs a presence check and returns the original secret; then retry with it` }
  : {}
const ALLOW_CROSS_USER = CFG.allowCrossUserTakeover === true   // §16 global: may a DIFFERENT user take over a dormant topic after grace?
const PERSIST = profile.names.persistence !== 'none'
const PERSIST_SUBS = PERSIST && ((CFG.persistence && CFG.persistence.persistSubscriptions) !== false)   // §20: durable subscriptions (default on; opt out with persistSubscriptions:false)
let procClaimsRehydrated = false                 // §12: restore THIS session's own (non-sub-peer) claims once, on connect
if (PERSIST) {                                   // park/retain/persistent-claims become real once persistence is on
  CAPS.park = true; CAPS.retain = true; CAPS.persistent_claims = true
  setInterval(() => {                            // age out parked mail + abandoned claims/registrations/subscriptions whose owner never returned
    persistence.mailbox.gcAll({ ttlMs: persistence.limits.messageTtlMs }).catch(() => {})
    persistence.claims.gcAll({ maxAgeMs: persistence.limits.hardExpiryMs }).catch(() => {})
    persistence.registrations.gcAll({ maxAgeMs: persistence.limits.hardExpiryMs }).catch(() => {})
    persistence.subscriptions.gcAll({ maxAgeMs: persistence.limits.hardExpiryMs }).catch(() => {})
    persistence.retained.gcAll({ ttlMs: persistence.limits.retainedTtlMs }).catch(() => {})
    persistence.keptTopics.gcAll({ ttlMs: persistence.limits.ownerlessTtlMs }).then(dropped => {   // #26: abandoned ownerless topics + their parked mail
      for (const d of (dropped || [])) {
        log(`gc: dropped abandoned kept-alive topic ${d.project}/${d.topic} (never reclaimed)`)
        const tident = topicMailIdent(d.realm, d.project, d.topic)
        persistence.mailbox.drain(tident).then(ps => ps.forEach(p => persistence.mailbox.ack(tident, p.envId).catch(() => {}))).catch(() => {})
      }
    }).catch(() => {})
  }, Number(process.env.AI_BRIDGE_PERSIST_GC_MS) || 1800000).unref()
}
// the process's own classification (null ⇒ infrastructure, not a participant)
const PROC_IDENT = (PROC_PROJECT && PROC_USER) ? profile.identity.classify({ project: PROC_PROJECT, user: PROC_USER, realm: REALM }) : null
const HOSTNAME = SESSION.split('/')[0]
// §12 persistence is keyed by (realm, project, user, NAME): the name distinguishes co-user holders so two
// sub-peers of the same human+project never share a mailbox/claim key. classify() omits name by design
// (identity = the human+work, not the session), so it's attached here. Sub-peers use their register name
// (stable across re-register, unique per logical peer); the process uses the hostname (stable per machine,
// distinct across machines on a shared persistence dir). Without a name everything same-user collided.
const pIdent = (identity, holderName) => identity ? { ...identity, name: holderName || '' } : null
// #26: a synthetic identity that keys the durable mailbox for a kept-alive OWNERLESS topic, so directed sends
// can park against the topic itself (no owner) and the next claimant drains them. The reserved user sentinel
// keeps it distinct from any real peer identity.
const topicMailIdent = (realm, project, topic) => ({ realm: realm || REALM, project: project || 'unclassified', user: '#ownerless', name: `topic:${topic}` })

// ---------------------------------------------------------------- project consent + reply-cap (§4-§5)
// Project consent (the runtime-grant map + pending requests + mayInitiate/reachable/allow/revoke) is
// encapsulated in lib/consent.js — bridge.mjs calls the API, never the Maps. Receiver-controlled inbound
// consent: a project may reach another only if same-project, the realm is `open`, a static config edge
// allows it, or a runtime grant does. The reply exception (firewall return-traffic) is gated by the signed
// reply-cap below, NOT by policy. `projKey`/`lc` are in lib/keys.js; `parseTtlMin` in lib/consent.js.
const consent = createConsent({ persistence, persist: PERSIST })
const computeOpen = pol => process.env.AI_BRIDGE_OPEN === '1' || String((pol && pol.default) || 'strict') === 'open'
consent.setPolicy((CFG.projects && typeof CFG.projects === 'object') ? CFG.projects : { default: 'strict', allow: [] }, computeOpen(CFG.projects))
// live-reload via the ConfigSource facet: a synced edit to the policy propagates without a restart (the
// bridge only READS config). Realm/token changes still need a restart. fs.watchFile polls — cross-platform.
profile.config.watch(c => {
  if (c && c.projects && typeof c.projects === 'object') { consent.setPolicy(c.projects, computeOpen(c.projects)); log('project policy reloaded from config') }
  reminders.setDefaults(defaultBehaviors(c))   // #29: default behaviour reminders are live-reloadable too
})
await consent.rehydrate()   // §14: durable grants survive a restart
setInterval(() => consent.gc(), Number(process.env.AI_BRIDGE_GRANT_GC_MS) || 600000).unref()   // §14: sweep expired grants + stale pending requests
const CAP_TTL_MS = Number(process.env.AI_BRIDGE_CAP_TTL_MS) || 30 * 60000   // reply_exp stamp horizon (informational since Decision B; no longer gates delivery — see verifyReplyCap). Env-overridable for tests.
const PROC_CAPKEY = capKeyFrom(SESSION)    // process reply-cap key (rotates per process = correct for Code)
function localCapKey(sessionId) {                  // reply-cap signing key for a LOCAL participant
  if (sessionId === SESSION) return PROC_CAPKEY
  const sp = subpeers.get(sessionId); if (sp) return sp.capKey
  if (String(sessionId).startsWith('page:')) { const p = pages.get(String(sessionId).slice(5)); return p ? p.capKey : null }
  return null
}
function projectOfTarget(to) {                     // resolve a target id's project from local state + roster
  if (to === SESSION) return PROC_IDENT?.project || 'unclassified'
  if (subpeers.has(to)) return subpeers.get(to).identity?.project || 'unclassified'
  if (String(to).startsWith('page:')) { const p = pages.get(String(to).slice(5)); return p?.identity?.project || 'unclassified' }
  if (roster.has(to)) return roster.get(to).project || 'unclassified'
  const owner = roster.get(String(to).split('/').slice(0, 2).join('/'))
  if (owner) { const sp = (owner.subpeers || []).find(x => x.id === to); if (sp) return sp.project || 'unclassified' }
  return null
}
function findStoredEnvelope(f, id) {               // the sender's copy of a message it received (to echo its cap)
  if (!f || !id) return null
  if (f.session === SESSION) return inbox.find(e => e.id === id)
  const q = subQueues.get(f.session); if (q) return q.items.find(e => e.id === id)
  return null
}
function verifyReplyCap(env, toProject, targetCapKey) {
  if (!env.reply_cap || !env.reply_to || !targetCapKey) return false
  const exp = Number(env.reply_exp || 0)
  if (!exp) return false                             // exp is part of the signed payload; must be present
  // Decision B (2026-06-14): replies ALWAYS get through. A genuine reply-cap (signed by the recipient's
  // capKey, bound to this exact thread) is honoured for the life of the minting process — it is NOT
  // time-expired here and (being an independent OR in deliveryAllowed) is NOT cancelled by a later
  // revoke. Once you invite a reply, the reply is not blocked by consent state or a clock. The cap dies
  // naturally when either process restarts (capKey rotates per process). reply_exp is retained only as a
  // stable, signed stamp — it no longer gates delivery. Trade-off: a party you revoke can still answer
  // messages you already sent it (per-thread, no new traffic), until one side restarts.
  const fromProject = env.from?.project || 'unclassified'
  return profile.capSigner.verify(targetCapKey, env.reply_cap, `${toProject}|${fromProject}|${env.reply_to}|${exp}`)
}
function deliveryAllowed(env, toProject, toRealm, targetCapKey) {
  if (env.system) return true                      // system control messages (e.g. project_access_request)
  const sameRealm = (env.from?.realm || REALM) === (toRealm || REALM)
  if (sameRealm && consent.mayInitiate(env.from?.project, toProject)) return true
  return verifyReplyCap(env, toProject, targetCapKey)   // signed reply exception
}

// Names (peer/sub-peer) are PRESENTED in their original case but STORED and COMPARED lower-case, so all
// name lookups are case-insensitive ("Bolletta" === "bolletta"). Display strings keep their original case.
// `lc` (lower-case/trim) and `projKey` live in lib/keys.js (imported above).
const ciEq = (a, b) => lc(a) === lc(b)

// ---------------------------------------------------------------- topic matching (T1/T4)
// splitTopic / isWildcard / topicMatch / patternsOverlap / patternKey / parseTopicRef are PURE — they live
// in lib/topics.js (imported above). Topics are /-separated paths, matched case-insensitively per level;
// wildcards (subscriptions + claims only): '+' = one level, '#' = the rest of the subtree.

// framing (sendFrame / onFrames) is provided by the transport facet — aliased above.

// ---------------------------------------------------------------- mesh state
let role = 'binding'              // binding | gateway | follower | stopping
let pairPort = 0                  // this bridge's own listener for inbound pair conns
let gwSock = null                 // follower: control connection to gateway
let gwServer = null               // gateway: the :PORT server
let wss = null                    // gateway: WS leaf server
let roster = new Map()            // session -> {session, name, port, kind:'session', subpeers:[], client}
let pages = new Map()             // instance -> {instance, page_kind, title, kind:'page'}  (gateway only)
let backoff = 200
let gatewayId = null             // session id of the current gateway (both roles)

const inbox = []                  // process inbox: delivered envelopes (cursor = index)
const seen = new Set()            // envelope dedupe (LRU-ish)
const followers = new Map()       // gateway: session -> control socket
const leaves = new Set()          // gateway: ws clients (dashboards + page leaves)
// fan a JSON string out to every connected dashboard (the observation sink) — shared by traces + persistence push
const dashSend = msg => { for (const ws of leaves) if (ws.kind === 'dashboard' && ws.readyState === 1) { try { ws.send(msg) } catch {} } }
const traces = createTraces({ broadcast: dashSend })   // owns the recent-traces ring + fan-out (lib/traces.js)

// sub-peers (conversations sharing this stdio: Cowork sessions, subagents)
const subpeers = new Map()        // id -> {id, name, secretHash, parent, kind:'subpeer', created, last_seen, ttl_ms, mode}
const subQueues = new Map()       // id -> {epoch, base, items:[], served}
const SUBQ_CAP = 300

// topics (Topics amendment 2026-06-12, T1-T15) — claims (role:owner) and subscriptions
// (role:subscriber) held by THIS process or its sub-peers; gossiped via the roster like
// sub-peers; vanish with their holder. Owners are auto-subscribed (T2).
const myTopics = new Map()        // `${holder}|${role}|${patternKey}` -> {pattern, role, description, exclusive, icon, holder, holder_name, claimed_at}
// #29: per-session BEHAVIOUR reminders — encapsulated in lib/reminders.js (it owns the behaviours map +
// matching). The bridge calls reminders.remindersFor(...) at delivery, .set/.clear/.list in the handlers,
// .load on resync, and .topicBehaviors/.inherit for the #26 kept-alive handoff.
const reminders = createReminders({ persistence, persist: PERSIST })
// #29: bridge-wide DEFAULT behaviour reminders from config (config.behaviors.default — a string = an all-scope
// default, or an array of {scope,match,behavior}). Applied to every session, overridable by a session's own
// reminder for the same scope+match, tagged `default:true` on delivery. Live-reloadable; env override for tests.
function defaultBehaviors(cfg) {
  const out = [], d = cfg && cfg.behaviors && cfg.behaviors.default
  if (typeof d === 'string') out.push({ scope: 'all', match: null, behavior: d })
  else if (Array.isArray(d)) for (const x of d) if (x && x.behavior) out.push({ scope: x.scope, match: x.match, behavior: x.behavior })
  if (process.env.AI_BRIDGE_DEFAULT_BEHAVIOR) out.push({ scope: 'all', match: null, behavior: process.env.AI_BRIDGE_DEFAULT_BEHAVIOR })
  return out
}
reminders.setDefaults(defaultBehaviors(CFG))

// envelopeId() (pure content hash) lives in lib/envelope.js (imported above).
function remember(id) {
  seen.add(id)
  if (seen.size > 500) { const it = seen.values(); seen.delete(it.next().value) }
}

// ---------------------------------------------------------------- client classification
function clientKind(name) {
  const n = String(name || '')
  if (!n) return null
  if (/code/i.test(n)) return 'code'
  if (/local-agent|agent-mode/i.test(n)) return 'agent'   // the desktop app's in-app agent mode (poll-based, registers sub-peers)
  if (/cowork|desktop|claude-ai/i.test(n)) return 'cowork'
  return 'other'
}

// ---------------------------------------------------------------- traces (observation plane)
const pendingTraces = []
function emitTraceRaw(trace) {
  const tr = { t: 'TRACE', trace: { ts: new Date().toISOString(), session: SESSION, ...trace } }
  if (role === 'gateway') traces.collect(tr.trace)
  else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, tr)
  else { pendingTraces.push(tr); if (pendingTraces.length > 20) pendingTraces.shift() }
}
function flushPendingTraces() {
  while (pendingTraces.length) {
    const tr = pendingTraces.shift()
    if (role === 'gateway') traces.collect(tr.trace)
    else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, tr)
    else { pendingTraces.unshift(tr); break }
  }
}
function nameOf(id) {                       // best-effort display name for a mesh id (trace plane)
  const s = String(id || '')
  if (!s) return null
  if (s.startsWith('page:')) { const p = pages.get(s.slice(5)); return p ? (p.title || p.page_kind) : s }
  if (roster.has(s)) return roster.get(s).name
  if (subpeers.has(s)) return subpeers.get(s).name
  const owner = roster.get(s.split('/').slice(0, 2).join('/'))
  if (owner) { const sp = (owner.subpeers || []).find(x => x.id === s); if (sp) return sp.name }
  return s.split('/').pop()
}
function kindOf(id) { const s = String(id || ''); return s.startsWith('page:') ? 'page' : (s.split('/').length >= 3 ? 'subpeer' : 'session') }
function emitTrace(dir, env, note) {
  emitTraceRaw({ envelope_id: env.id, from: env.from?.session, from_name: env.from?.name,
    to: env.to, to_name: nameOf(env.to), to_kind: kindOf(env.to),
    subject: env.subject || null, pattern: env.pattern || 'send', topic: env.topic || null,
    topic_icon: env.topic ? iconOf(env.topic, env.from?.project || 'unclassified') : null,
    verb: env.verb || null, dir, size: (env.body || '').length, note: note || null })
}
// trace collection (the ring + dashboard fan-out) lives in lib/traces.js — emit here, collect there.

// ---------------------------------------------------------------- services layer (#33; docs/web-edge-node.md)
// Opt-in IN-PROCESS capability modules. A service is loaded only when configured (config.services.<name>) —
// an unopened capability has no surface. Each contributes MCP tools (merged into tools/list, routed to its
// handle()) and is live-reloadable via setConfig. First inhabitant: egress (the http_request proxy).
const serviceTools = []                     // schemas contributed by services -> tools/list
const serviceHandlers = new Map()           // toolName -> service instance
function loadService(svc) {
  if (!svc) return
  for (const t of (svc.tools || [])) { serviceTools.push(t); serviceHandlers.set(t.name, svc) }
}
// egress config = config.services.egress, with an optional env override (AI_BRIDGE_EGRESS_BACKENDS = JSON
// backends map) for tests/automation; either present => the service (and its http_request tool) exists.
function egressConfig(cfg) {
  const c = (cfg && cfg.services && cfg.services.egress) ? { ...cfg.services.egress } : null
  const envB = process.env.AI_BRIDGE_EGRESS_BACKENDS
  if (envB) { try { return { backends: { ...((c && c.backends) || {}), ...JSON.parse(envB) } } } catch (e) { log('AI_BRIDGE_EGRESS_BACKENDS parse failed', e.message) } }
  return c
}
// #36/#33: when launched as an MCP server the host may have stripped our environment — rehydrate stripped
// user/machine vars from the registry (Windows) so ${env:VAR} secret refs in egress backends resolve.
if (egressConfig(CFG)) hydrateEnvFromRegistry(log)
const egc0 = egressConfig(CFG)
const egress = egc0 ? createEgress({ config: egc0, log, trace: emitTraceRaw }) : null
loadService(egress)
if (egress) profile.config.watch(c => egress.setConfig(egressConfig(c)))   // live-reload backends

// ---------------------------------------------------------------- sub-peer machinery
function isLocalSubId(id) { return typeof id === 'string' && id.startsWith(SESSION + '/') }
function resolveLocalSub(ref) {
  if (!ref) return null
  if (subpeers.has(ref)) return subpeers.get(ref)
  const full = `${SESSION}/${ref}`
  if (subpeers.has(full)) return subpeers.get(full)
  const byName = [...subpeers.values()].filter(s => ciEq(s.name, ref))
  return byName.length === 1 ? byName[0] : null
}
function newQueue() { return { epoch: crypto.randomBytes(4).toString('hex'), base: 0, items: [], served: 0 } }
// a compact "you have mail" hint piggybacked on tool responses (§ doorbell-lite): a registered caller
// learns whether new messages arrived since its last inbox poll — without a dedicated round-trip. unread
// = items past the served high-water; next_cursor is where to poll from; epoch change ⇒ reset cursor to 0.
function inboxHint(spId) {
  const q = subQueues.get(spId); if (!q) return null
  const end = q.base + q.items.length
  return { unread: Math.max(0, end - (q.served || 0)), next_cursor: end, queue_epoch: q.epoch }
}
function announceSubpeers() {
  // channel_capable = does THIS process's MCP client actually declare the claude/channel capability (i.e. can it
  // really receive push notifications). Attached per sub-peer so the dashboard shows "push" only when push is
  // genuinely live, not merely because the mode was optimistically set to push by the code-name heuristic (#2).
  const chan = !!(CLIENT && CLIENT.channel_capable)
  const list = [...subpeers.values()].map(s => ({ id: s.id, name: s.name, parent: s.parent, kind: 'subpeer', client: s.client || null, client_kind: s.client_kind || null, mode: s.mode || null, channel_capable: chan, project: s.identity?.project || null, user: s.identity?.user || null, realm: s.identity?.realm || REALM }))
  if (role === 'gateway') { const r = roster.get(SESSION); if (r) { r.subpeers = list }; broadcastRoster() }
  else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'SUBPEERS', session: SESSION, subpeers: list })
}
function topicList() { return [...myTopics.values()] }
function announceTopics() {
  if (role === 'gateway') { const r = roster.get(SESSION); if (r) { r.topics = topicList() }; broadcastRoster() }
  else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'TOPICS', session: SESSION, topics: topicList() })
}
// every topic relationship visible from this bridge: roster (all sessions) + page leaves + local
// not-yet-round-tripped entries. Page subject = shared claim + subscription (T12).
function allTopicEntries() {
  const out = []
  const seenKeys = new Set()
  const add = e => { const k = `${e.holder}|${e.role}|${patternKey(e.pattern)}`; if (!seenKeys.has(k)) { seenKeys.add(k); out.push(e) } }
  for (const s of roster.values()) for (const e of (s.topics || [])) add(e)
  for (const p of pages.values()) {
    const pp = p.identity?.project || 'unclassified', pr = p.identity?.realm || REALM
    if (p.subject) {
      add({ pattern: p.subject, role: 'owner', description: `Page: ${p.title || p.page_kind}`, exclusive: false,
        icon: p.icon || null, holder: 'page:' + p.instance, holder_name: p.title || p.page_kind, project: pp, realm: pr })
    }
    for (const sub of (p.subscriptions || [])) add({ pattern: sub, role: 'subscriber',
      holder: 'page:' + p.instance, holder_name: p.title || p.page_kind, project: pp, realm: pr })
  }
  for (const e of myTopics.values()) add(e)
  return out
}
// §12 durable claims: write/refresh a claim's durable record under its holder identity (volatile holder id
// is NOT stored — it's re-bound on rehydrate). The refreshed_at acts as the lease the hard-expiry GC reads.
function persistClaim(identity, project, topic, rec) {   // returns the write promise so a caller that needs durability before continuing can await it
  if (!(PERSIST && identity)) return Promise.resolve()
  return persistence.claims.put(project, topic, identity, {
    pattern: topic, role: 'owner', description: rec.description || '', exclusive: !!rec.exclusive, icon: rec.icon || null,
    holder_name: rec.holder_name || null, project, realm: rec.realm || REALM,
    user: identity.user || null, name: identity.name || null,         // §16: full identity so an OFFLINE owner can be parked to
    announce_offline: !!rec.announce_offline,                          // §16: owner opted in to telling senders it's offline
    grace_minutes: rec.grace_minutes ?? null, allow_other_user: rec.allow_other_user ?? null,   // §16: per-claim takeover policy
    keep_alive: !!rec.keep_alive,                                      // #26: survives a restart so a later release still keeps the topic alive
    claimed_at: rec.claimed_at || new Date().toISOString(), persistent: true, refreshed_at: new Date().toISOString(),
  }).catch(() => {})
}
// reconstruct the holder identity (realm:project:user:name) from a durable claim record, so a send to an
// OFFLINE owner can be parked to the right mailbox. Needs user+name (added to the record above).
function claimIdentity(rec, project) {
  if (!rec || !rec.name) return null
  return { realm: rec.realm || REALM, project: rec.project || project || 'unclassified', user: rec.user || 'unknown', name: rec.name }
}
// is the identity behind a durable claim record currently REGISTERED (live) on this host? (a live owner is
// governed by the in-RAM `blocker` check; only a NOT-live owner is "dormant" for §16 takeover purposes)
function isIdentityLive(rec) {
  const want = `${projKey(rec.project)}|${rec.user || ''}|${rec.name || ''}`
  for (const sp of subpeers.values()) if (sp.identity && `${projKey(sp.identity.project)}|${sp.identity.user || ''}|${sp.name || ''}` === want) return true
  if (PROC_IDENT && `${projKey(PROC_IDENT.project)}|${PROC_IDENT.user || ''}|${HOSTNAME}` === want) return true
  return false
}
// §16 re-claim conflict: a claimant wants `topic`, but a DORMANT (offline) durable owner holds an
// overlapping exclusive claim. Same-user -> human confirmation via the authorizer (Hello in prod, script in
// tests). Cross-user -> grace-then-displaceable, governed by the per-claim policy then the global config.
// Returns null/{ok:true} to allow (displacing the dormant claim), or {ok:false, code:'held'} to block.
async function resolveDormantConflict(topic, holderIdentity, holderProject, exclusive) {
  if (!PERSIST) return null
  let recs = []
  try { recs = await persistence.claims.read(holderProject, topic) } catch { return null }
  for (const rec of recs) {
    if (!rec || rec.pattern !== topic) continue
    // §16 back-compat: a claim written before v1.10.0 has no user/name (persistClaim didn't store them),
    // so it can't be ATTRIBUTED to a holder. Never let an unidentifiable legacy record block a claim —
    // that would wrongly read a returning owner's own dormant topic as another user's. Skip it; the claim
    // proceeds and rewrites a proper (identified) record over the top.
    if (!rec.user || !rec.name) continue
    // user is the OS login — compare case-INSENSITIVELY (project already is): an older claim recorded
    // under declared "Robin" must match the OS-authenticated "robin", else the owner is locked out of its
    // own dormant topic as a phantom "different user". Name is also case-insensitive (presented in original
    // case but stored/compared lower-case) so "Bolletta"/"bolletta" re-claim, not conflict.
    const userKey = u => String(u || '').trim().toLowerCase()
    const sameIdentity = projKey(rec.project) === projKey(holderIdentity.project) && userKey(rec.user) === userKey(holderIdentity.user) && ciEq(rec.name, holderIdentity.name)
    if (sameIdentity) continue                          // my own durable claim — a re-claim, not a conflict
    if (isIdentityLive(rec)) continue                   // a live owner — the in-RAM blocker check governs that
    if (!(rec.exclusive || exclusive)) continue         // only exclusive overlaps conflict
    const sameUser = userKey(rec.user) === userKey(holderIdentity.user)
    if (sameUser) {                                     // taking over your OWN dormant topic — confirm presence
      const v = await authorizer.confirm({ action: 'topic-takeover', topic, user: holderIdentity.user, requester: holderIdentity.name,
        subject: `Take over "${topic}" from your other session "${rec.name}"?`, details: `held by ${rec.name} (offline)` })
      if (!v || !v.approved) return { ok: false, code: 'held', topic, holder_name: rec.name, dormant: true, same_user: true,
        reason: v ? v.reason : 'no-authorizer', hint: 'confirm via the authorizer (e.g. Windows Hello) to take over your own dormant topic' }
      await persistence.claims.remove(holderProject, topic, claimIdentity(rec, holderProject)).catch(() => {})
      return { ok: true, displaced: rec.name, by: v.by }
    }
    // cross-user: grace window then displaceable, per-claim policy overriding the global config
    const graceMin = rec.grace_minutes != null ? Number(rec.grace_minutes) : (persistence.limits.graceMs / 60000)
    const since = Date.parse(rec.refreshed_at || rec.claimed_at || '') || 0
    const withinGrace = since > 0 && (Date.now() - since) < graceMin * 60000
    const allow = rec.allow_other_user != null ? !!rec.allow_other_user : ALLOW_CROSS_USER
    if (withinGrace || !allow) return { ok: false, code: 'held', topic, holder_name: rec.name, dormant: true, cross_user: true, within_grace: !!withinGrace,
      hint: withinGrace ? 'owner offline but within its grace window — try later or negotiate' : 'cross-user takeover is not permitted for this topic' }
    await persistence.claims.remove(holderProject, topic, claimIdentity(rec, holderProject)).catch(() => {})   // displaced after grace
    return { ok: true, displaced: rec.name }
  }
  return null
}
// Re-assert a durable claim under a (new) holder id when its identity returns. Won't clobber a live
// exclusive owner that took the topic while this holder was away — that's left for explicit negotiation.
function rehydrateClaim(rec, holderId, holderName, identity) {
  const topic = rec.pattern
  if (!topic || isWildcard(topic)) return false
  const proj = rec.project || identity.project || 'unclassified'
  const conflict = allTopicEntries().find(e => e.role === 'owner' && e.holder !== holderId &&
    projKey(e.project) === projKey(proj) && patternsOverlap(e.pattern, topic) && (e.exclusive || rec.exclusive))
  if (conflict) return false
  const k = `${holderId}|owner|${patternKey(topic)}`
  myTopics.set(k, { pattern: topic, role: 'owner', description: rec.description || '', exclusive: !!rec.exclusive,
    icon: rec.icon || null, holder: holderId, holder_name: holderName, project: proj,
    announce_offline: !!rec.announce_offline, grace_minutes: rec.grace_minutes ?? null, allow_other_user: rec.allow_other_user ?? null, keep_alive: !!rec.keep_alive,   // #26: keep_alive must survive a restart so a later release still keeps the topic alive
    realm: rec.realm || identity.realm || REALM, claimed_at: rec.claimed_at || new Date().toISOString() })
  persistClaim(identity, proj, topic, myTopics.get(k))   // refresh the lease + re-anchor to the live holder
  return true
}
// parseTopicRef() (project-scoped "@project/path" resolution) lives in lib/topics.js; callers pass REALM as
// the default realm so it stays pure.
function ownersOf(path, targetProject) {   // send topic:<t> -> owners in the target project only (T3/§6)
  const tp = projKey(targetProject), out = new Map()
  for (const e of allTopicEntries()) if (e.role === 'owner' && projKey(e.project) === tp && topicMatch(e.pattern, path)) if (!out.has(e.holder)) out.set(e.holder, e)
  return [...out.values()]
}
function subscribersOf(path, targetProject) {   // publish -> subscribers in the target project (T2/§6)
  const tp = projKey(targetProject), out = new Map()
  for (const e of allTopicEntries()) if (projKey(e.project) === tp && topicMatch(e.pattern, path)) if (!out.has(e.holder)) out.set(e.holder, e)
  return [...out.values()]
}
function iconOf(path, targetProject) {     // claim icon for a concrete topic (display affordance)
  const tp = projKey(targetProject)
  for (const e of allTopicEntries()) if (e.role === 'owner' && e.icon && projKey(e.project) === tp && topicMatch(e.pattern, path)) return e.icon
  return null
}
function deliverSub(id, env) {
  if (seen.has(env.id)) return { ok: true, dedup: true }
  remember(env.id)
  if ((env.hops || []).includes(SESSION)) { emitTrace('recv', env, 'loop-rejected'); return { ok: false, code: 'loop' } }
  if (!subpeers.has(id)) {     // unknown/expired handle: dead-letter straight to process inbox
    inbox.push({ ...env, dead_letter_for: id }); if (inbox.length > 500) inbox.shift()
    emitTrace('recv', env, `dead-letter:${id.split('/').pop()}`)
    return { ok: true, dead_lettered: true }
  }
  const sp = subpeers.get(id)
  if (!deliveryAllowed(env, sp.identity?.project || 'unclassified', sp.identity?.realm, sp.capKey)) { emitTrace('recv', env, 'project-denied'); return { ok: false, code: 'project-denied' } }
  const q = subQueues.get(id)
  q.items.push(env)
  if (PERSIST && sp.identity) persistence.mailbox.put(pIdent(sp.identity, sp.name), env.id, env).catch(() => {})   // §12: durable copy (keyed per peer name), redelivered on re-register after a restart
  if (q.items.length > SUBQ_CAP) { q.items.shift(); q.base++ }
  emitTrace('recv', env, `subpeer:${id.split('/').pop()}`)
  if (MODE_OVERRIDE !== 'poll' && sp && sp.mode === 'push') {      // streaming sub-peer (e.g. code session sharing this bridge)
    const rems = reminders.remindersFor(sp.id, env)   // #29: scoped 'how to behave' prompts for this message
    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: plainBody(env),
        meta: { from: String(env.from?.session || ''), from_name: String(env.from?.name || ''),
                from_kind: String(env.from?.kind || 'session'), verb: String(env.verb || ''), envelope_id: env.id,
                subject: String(env.subject || ''), pattern: String(env.pattern || 'send'), topic: env.topic || null,
                for: sp.id, for_name: sp.name, ...(rems.length ? { reminders: rems } : {}) } },
    }).catch(() => {})
  }
  return { ok: true }
}
// §23: pull durably-parked messages that AREN'T already in the live queue into it. Live delivery writes both
// the queue AND a durable copy, so the durable mailbox normally just mirrors unconsumed queue items — but mail
// parked OUT-OF-BAND (by another federated process, or while this peer was momentarily treated as offline) lands
// only in the durable store and, pre-§23, surfaced only on a FRESH register — a plain poll/reattach never drained
// it, so it stranded. We now sync on poll + reattach. Dedup by envelope id so live-delivered mail isn't doubled.
async function syncDurableMailbox(sp) {
  if (!PERSIST || !sp || !sp.identity) return 0
  const q = subQueues.get(sp.id); if (!q) return 0
  let parked
  try { parked = await persistence.mailbox.drain(pIdent(sp.identity, sp.name)) } catch { return 0 }
  if (!parked || !parked.length) return 0
  const have = new Set(q.items.map(e => e && e.id))
  let added = 0
  for (const p of parked) {
    const rec = p && p.record
    if (!rec || !rec.id || have.has(rec.id)) continue
    q.items.push(rec); have.add(rec.id); added++
    if (q.items.length > SUBQ_CAP) { q.items.shift(); q.base++ }
  }
  if (added) emitTraceRaw({ dir: 'recv', verb: 'rehydrate', from: sp.id, from_name: sp.name, to: SESSION, size: added, note: `${added} out-of-band parked message(s) surfaced on poll/reattach`, envelope_id: null })
  return added
}
function deadLetterStrays(sp) {
  const q = subQueues.get(sp.id); if (!q) return 0
  const start = Math.min(Math.max((q.served || 0) - q.base, 0), q.items.length)
  const strays = q.items.slice(start)
  if (strays.length) {
    const parent = sp.parent && subpeers.has(sp.parent) ? sp.parent : null
    for (const env of strays) {
      const tagged = { ...env, dead_letter_for: sp.id }
      if (parent) { const pq = subQueues.get(parent); pq.items.push(tagged); if (pq.items.length > SUBQ_CAP) { pq.items.shift(); pq.base++ } }
      else { inbox.push(tagged); if (inbox.length > 500) inbox.shift() }
    }
    emitTraceRaw({ dir: 'info', verb: 'dead-letter', from: sp.id, from_name: sp.name,
      to: parent || SESSION, size: strays.length, note: `${strays.length} unread -> ${parent ? 'parent' : 'process inbox'}`, envelope_id: null })
  }
  return strays.length
}
function removeSubpeer(id, reason) {
  const sp = subpeers.get(id); if (!sp) return
  for (const child of [...subpeers.values()].filter(s => s.parent === id)) removeSubpeer(child.id, reason)
  deadLetterStrays(sp)
  subQueues.delete(id)
  subpeers.delete(id)
  let topicsDropped = false
  for (const [k, r] of [...myTopics]) if (r.holder === id) { myTopics.delete(k); topicsDropped = true }   // topics vanish with their holder (T2/R6)
  if (topicsDropped) announceTopics()
  emitTraceRaw({ dir: 'con', verb: 'offline', from: id, from_name: sp.name, to: SESSION, size: 0,
    note: `sub-peer removed (${reason})`, envelope_id: null })
  log(`subpeer removed (${reason}): ${id}`)
}
setInterval(() => {
  const now = Date.now(); let changed = false
  for (const sp of [...subpeers.values()].sort((a, b) => (b.parent ? 1 : 0) - (a.parent ? 1 : 0))) {
    if (subpeers.has(sp.id) && now - sp.last_seen > sp.ttl_ms) { removeSubpeer(sp.id, 'ttl'); changed = true }
  }
  if (changed) announceSubpeers()
}, SWEEP_MS).unref()

// ---------------------------------------------------------------- delivery (inbound to THIS process)
async function deliver(env) {
  if (seen.has(env.id)) return { ok: true, dedup: true }
  remember(env.id)
  if ((env.hops || []).includes(SESSION)) { emitTrace('recv', env, 'loop-rejected'); return { ok: false, code: 'loop' } }
  if (!deliveryAllowed(env, PROC_IDENT?.project || 'unclassified', REALM, PROC_CAPKEY)) { emitTrace('recv', env, 'project-denied'); return { ok: false, code: 'project-denied' } }
  inbox.push(env)
  if (inbox.length > 500) inbox.shift()
  emitTrace('recv', env)
  if (MODE_OVERRIDE !== 'poll') {                       // queue is the truth; push is always attempted unless explicitly overridden (A9)
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: plainBody(env),
          meta: { from: String(env.from?.session || ''), from_name: String(env.from?.name || ''),
                  from_kind: String(env.from?.kind || 'session'), verb: String(env.verb || ''), envelope_id: env.id,
                  subject: String(env.subject || ''), pattern: String(env.pattern || 'send'), topic: env.topic || null },
        },
      })
    } catch {}
  }
  return { ok: true }
}

// ---------------------------------------------------------------- pair listener (every bridge)
const pairServer = profile.transport.createServer(sock => {
  let hello = null
  onFrames(sock, async f => {
    if (f.t === 'HELLO') {
      if (!profile.auth.verify(f.auth)) { sendFrame(sock, { t: 'REJECT', code: 'unauthorized' }); sock.end(); return }
      hello = f
    } else if (f.t === 'CONNECT') {
      if (!hello) { sendFrame(sock, { t: 'REJECT', code: 'no-hello' }); sock.end(); return }
      if (f.target !== SESSION && !isLocalSubId(f.target)) { sendFrame(sock, { t: 'REJECT', code: 'unknown-target' }); sock.end(); return }
      sendFrame(sock, { t: 'ACCEPT', connId: crypto.randomBytes(4).toString('hex') })
    } else if (f.t === 'MSG') {
      const env = f.body
      if (env && env.id) {
        if (env.to === SESSION) await deliver(env)
        else if (isLocalSubId(env.to)) deliverSub(env.to, env)
        else await deliver(env)            // pre-1.1 senders: target match already enforced at CONNECT
      }
      sendFrame(sock, { t: 'CLOSE', code: 'ok' })
    } else if (f.t === 'PING') sendFrame(sock, { t: 'PONG', seq: f.seq })
  })
  sock.on('error', () => {})
})
pairServer.listen(0, BIND, () => { pairPort = pairServer.address().port; election() })

// ---------------------------------------------------------------- page delivery (gateway)
function pageSockOf(instance) {
  for (const ws of leaves) if (ws.kind === 'page' && ws.instance === instance && ws.readyState === 1) return ws
  return null
}
function deliverPage(env) {
  const inst = String(env.to).slice(5)
  const sock = pageSockOf(inst)
  if (!sock) { emitTrace('send', env, 'page-gone'); return { ok: false, code: 'page-gone' } }
  const pg = pages.get(inst)
  if (!deliveryAllowed(env, pg?.identity?.project || 'unclassified', pg?.identity?.realm, pg?.capKey)) { emitTrace('send', env, 'project-denied'); return { ok: false, code: 'project-denied' } }
  // pages get the decrypted view: the leaf WS is loopback-only + token-gated (same trust domain)
  try { sock.send(JSON.stringify({ type: 'envelope', envelope: decryptedView(env) })) } catch (e) { return { ok: false, code: 'page-send-failed' } }
  emitTrace('send', env, 'to-page')
  return { ok: true }
}
function resolvePageTarget(target) {
  // 'page:<instance>' | bare instance | unique title | unique page_kind -> 'page:<instance>' or null
  const t = String(target)
  const inst = t.startsWith('page:') ? t.slice(5) : t
  if (pages.has(inst)) return 'page:' + inst
  const cand = [...pages.values()].filter(p => p.title === t || p.page_kind === t)
  return cand.length === 1 ? 'page:' + cand[0].instance : null
}

// ---------------------------------------------------------------- outbound routing
function ownerOf(target) {
  if (roster.has(target)) return roster.get(target)
  const parts = String(target).split('/')
  if (parts.length >= 3) return roster.get(parts.slice(0, 2).join('/')) || null
  return null
}
function knownIds() {
  const ids = [...roster.keys()]
  for (const s of roster.values()) for (const sp of (s.subpeers || [])) ids.push(sp.id)
  return ids
}
function dialAndSend(port, host, target, env) {
  return new Promise(resolve => {
    const sock = profile.transport.connect(port, host)
    let done = false
    const finish = r => { if (!done) { done = true; try { sock.destroy() } catch {}; resolve(r) } }
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), 5000)
    sock.on('connect', () => {
      sendFrame(sock, { t: 'HELLO', ver: VER, fromBridge: SESSION, fromSession: SESSION, name: NAME, auth: TOKEN })
      sendFrame(sock, { t: 'CONNECT', target })
    })
    onFrames(sock, f => {
      if (f.t === 'ACCEPT') sendFrame(sock, { t: 'MSG', seq: 1, body: env })
      else if (f.t === 'REJECT') { clearTimeout(timer); finish({ ok: false, code: f.code }) }
      else if (f.t === 'CLOSE') { clearTimeout(timer); finish({ ok: true }) }
    })
    sock.on('error', e => { clearTimeout(timer); finish({ ok: false, code: e.code || 'dial-failed' }) })
  })
}

async function routeEnvelope(env) {
  if (String(env.to).startsWith('page:')) {
    if (role === 'gateway') return deliverPage(env)
    if (gwSock && !gwSock.destroyed && pages.has(String(env.to).slice(5))) {
      sendFrame(gwSock, { t: 'PAGE_MSG', env })
      emitTrace('send', env, 'to-page via gateway')
      return { ok: true, forwarded: 'gateway' }
    }
    return { ok: false, code: 'page-unknown-or-gateway-down' }
  }
  if (env.to === SESSION) { emitTrace('send', env, 'self'); return deliver(env) }
  if (isLocalSubId(env.to)) { emitTrace('send', env, 'self-sub'); return deliverSub(env.to, env) }
  const peer = ownerOf(env.to)
  if (!peer) return { ok: false, code: 'unknown-target', known: knownIds() }
  emitTrace('send', env)
  return dialAndSend(peer.port, peer.host || HOST, env.to, env)   // local pair-dial; cross-host: peer.host/port point at the owning gateway, which splices (§7)
}

// deliver a SYSTEM control message (bypasses project consent) to every participant in a project —
// used by request_project_access to reach a project the requester cannot otherwise see.
async function deliverSystemToProject(toProject, verb, body) {
  const want = projKey(toProject)
  const targets = []
  for (const sp of subpeers.values()) if (projKey(sp.identity?.project) === want) targets.push(sp.id)   // sub-peer tier
  for (const s of roster.values()) {
    if (projKey(s.project) === want) targets.push(s.session)
    for (const sp of (s.subpeers || [])) if (projKey(sp.project) === want) targets.push(sp.id)
  }
  for (const p of pages.values()) if (projKey(p.identity?.project) === want) targets.push('page:' + p.instance)
  let n = 0
  for (const to of [...new Set(targets)]) {
    const env = makeEnvelope({ to, verb, body, subject: `project access request: ${verb}`, from: { session: SESSION, name: NAME, kind: 'session' } })
    env.system = true
    const r = await routeEnvelope(env)
    if (r && r.ok) n++
  }
  return n
}
// deliver a SYSTEM control message to a SINGLE target id (e.g. project_access_granted back to a requester —
// Bug 3: the requester must be told its access request was approved instead of polling-by-retry).
async function deliverSystemTo(toId, verb, body, subject) {
  const env = makeEnvelope({ to: toId, verb, body, subject: subject || `system: ${verb}`, from: { session: SESSION, name: NAME, kind: 'session' } })
  env.system = true
  return routeEnvelope(env)
}

// the first bridge to become gateway can launch the Windows tray (in --ephemeral mode, so it exits
// when the mesh does). Opt-in only — `tray: true` in config or AI_BRIDGE_TRAY=1 — so dev/test never
// spawns a window. The tray's single-instance mutex makes a repeat launch a no-op.
let trayLaunched = false
function maybeLaunchTray() {
  if (trayLaunched || process.platform !== 'win32') return
  if (!(process.env.AI_BRIDGE_TRAY === '1' || CFG.tray === true)) return
  trayLaunched = true
  try {
    const trayDir = path.join(HERE, '..', 'tray', 'windows')
    spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'run.cmd', '--ephemeral', '--root', HERE],
      { cwd: trayDir, detached: true, stdio: 'ignore', windowsHide: true }).unref()
    log('tray launch requested')
  } catch (e) { log('tray launch failed', e.message) }
}

// sender classification for the envelope metadata plane (cleartext; read by receiver-side enforcement)
function senderIdent(f) {
  if (!f) return { realm: REALM }
  if (f.session === SESSION) return PROC_IDENT ? { project: PROC_IDENT.project, user: PROC_IDENT.user, realm: PROC_IDENT.realm } : { realm: REALM }
  const sp = subpeers.get(f.session); if (sp && sp.identity) return { project: sp.identity.project, user: sp.identity.user, realm: sp.identity.realm }
  if (String(f.session).startsWith('page:')) { const p = pages.get(String(f.session).slice(5)); if (p && p.identity) return { project: p.identity.project, user: p.identity.user, realm: p.identity.realm } }
  return { realm: REALM }
}
/** @param {import('./types').EnvelopeInput} input @returns {import('./types').Envelope} */
function makeEnvelope({ to, verb, body, reply_to, from, subject, pattern, topic }) {
  const base = from || /** @type {import('./types').EnvelopeFrom} */ ({ session: SESSION, name: NAME, kind: 'session' })
  const f = base.project ? base : { ...base, ...senderIdent(base) }
  const hops = [...(from?.hops || [])]
  // sender joins the chain unless delivering within its own process (itself, or its own sub-peer —
  // otherwise the loop guard in deliverSub would reject a process publishing to its own conversations)
  if (f.session !== to && !String(to).startsWith(`${f.session}/`)) hops.push(f.session)
  const env = { ts: new Date().toISOString(), from: f,
    to, verb: verb || 'message', subject: String(subject || ''),
    pattern: pattern || 'send', topic: topic || null,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    reply_to: reply_to || null, hops }
  env.id = envelopeId(env)
  // reply capability (§5): a reply ECHOES the cap of the message it answers; otherwise mint a fresh
  // cap bound to (senderProject | targetProject | envId | expiry), keyed by the sender's capKey.
  if (reply_to) {
    const orig = findStoredEnvelope(base, reply_to)
    if (orig && orig.reply_cap) { env.reply_cap = orig.reply_cap; env.reply_exp = orig.reply_exp }
  }
  if (!env.reply_cap) {
    const ck = localCapKey(f.session), tp = projectOfTarget(to)
    if (ck && tp) {
      const exp = Date.now() + CAP_TTL_MS
      env.reply_cap = profile.capSigner.mint(ck, `${f.project || 'unclassified'}|${tp}|${env.id}|${exp}`)
      env.reply_exp = exp
    }
  }
  encryptEnvelope(env)                          // body ciphered from here; decryptedView at consumption
  return env
}

// topic:<topic> send targeting (T3/T5): explicit prefix only. Delivered to the topic's OWNERS —
// exclusive topic = exactly one; shared = every co-owner (one envelope each; dedupe is free).
function askerProjectOf(from) { return (senderIdent(from && from.session ? from : { session: SESSION }).project) || 'unclassified' }
// §16: a directed send to a topic whose durable owner is OFFLINE parks to that owner's mailbox (delivered
// on its return) instead of bouncing no-owner. Consent is checked at park-time (you can only park what you
// could send live). The sender is told it's offline ONLY if the owner opted in at claim time (announce_offline).
async function parkToOfflineOwners(from, project, path, verb, body, reply_to, subject, askerProject, ref) {
  if (!PERSIST) return { ok: false, code: 'no-owner', topic: ref }
  let dormant = []
  try { dormant = await persistence.claims.read(project, path) } catch { }
  const ap = projKey(askerProject || 'unclassified')
  const parked = [], announce = []
  for (const rec of dormant) {
    if (!rec || rec.pattern !== path) continue
    const ident = claimIdentity(rec, project)
    if (!ident) continue
    if (!consent.mayInitiate(ap, projKey(rec.project || project))) continue   // park only what you could send live
    const env = makeEnvelope({ to: `topic:${path}`, verb, body, reply_to, from, subject, pattern: 'send', topic: path })
    try { await persistence.mailbox.put(ident, env.id, env) } catch { continue }
    parked.push(env.id)
    if (rec.announce_offline) announce.push(rec.holder_name || ident.name)
    emitTraceRaw({ dir: 'send', verb: verb || 'message', from: from?.session || SESSION, from_name: from?.name || NAME,
      to: `topic:${path}`, to_name: path, to_kind: 'topic', subject: subject || null, pattern: 'send', topic: path,
      size: String(body || '').length, note: `parked for offline owner ${ident.name}`, envelope_id: env.id })
  }
  if (!parked.length) {
    // #26: no live or dormant owner — but if the topic was kept ALIVE (ownerless) on release, park against the
    // TOPIC itself (synthetic topic-mailbox); the next claimant drains it. Consent-checked against the topic's project.
    let kept = null
    try { kept = await persistence.keptTopics.get(project, path) } catch { }
    if (kept && consent.mayInitiate(ap, projKey(kept.project || project))) {
      const env = makeEnvelope({ to: `topic:${path}`, verb, body, reply_to, from, subject, pattern: 'send', topic: path })
      try { await persistence.mailbox.put(topicMailIdent(kept.realm, kept.project || project, path), env.id, env) }
      catch { return { ok: false, code: 'no-owner', topic: ref } }
      emitTraceRaw({ dir: 'send', verb: verb || 'message', from: from?.session || SESSION, from_name: from?.name || NAME,
        to: `topic:${path}`, to_name: path, to_kind: 'topic', subject: subject || null, pattern: 'send', topic: path,
        size: String(body || '').length, note: 'parked for ownerless kept-alive topic', envelope_id: env.id })
      return { ok: true, parked: true, ownerless: true, topic: path, project: kept.project || project, envelope_id: env.id,
        ...(kept.announce_offline ? { offline: true } : {}) }
    }
    return { ok: false, code: 'no-owner', topic: ref }
  }
  if (announce.length) return { ok: true, parked: true, offline: true, topic: path, project, owners: parked.length, offline_owners: announce }
  return { ok: true, topic: path, project }   // owner chose silence: looks like a normal accept
}
// §19: a directed send to a peer BY NAME that has no LIVE registration but DOES have a durable one (it's
// just offline / its gateway restarted) parks to that peer's mailbox instead of bouncing unknown-target.
// Returns the park result, or null to let the caller fall through to a clear unknown-target.
async function parkToOfflineName(from, name, verb, body, reply_to, subject, askerProject) {
  if (!PERSIST) return null
  let regs = []
  try { regs = await persistence.registrations.byName(name) } catch { return null }
  if (!regs.length) return null
  const ap = projKey(askerProject || 'unclassified')
  const reachable = regs.filter(r => consent.mayInitiate(ap, projKey(r.project)))   // only park what you could send live
  if (!reachable.length) return null
  if (reachable.length > 1) return { ok: false, code: 'ambiguous-name', candidates: reachable.map(r => `${r.project}:${r.name}`) }
  const r = reachable[0]
  const ident = { realm: r.realm || REALM, project: r.project, user: r.user, name: r.name }
  const env = makeEnvelope({ to: `name:${r.name}`, verb, body, reply_to, from, subject })
  try { await persistence.mailbox.put(ident, env.id, env) } catch { return null }
  emitTraceRaw({ dir: 'send', verb: verb || 'message', from: from?.session || SESSION, from_name: from?.name || NAME,
    to: r.name, to_name: r.name, to_kind: 'subpeer', subject: subject || null, pattern: 'send',
    size: String(body || '').length, note: `parked for offline peer ${r.name}`, envelope_id: env.id })
  return { ok: true, parked: true, offline: true, to: r.name, project: r.project, envelope_id: env.id }
}
async function routeToTopicOwners(from, ref, verb, body, reply_to, subject, askerProject) {
  const explicit = String(ref || '').trim().startsWith('@')   // "@project/path" names a project — respect it, no cross-project fallback
  const { project, path } = parseTopicRef(ref, askerProject, REALM)
  if (isWildcard(path)) return { ok: false, code: 'wildcard-target', topic: ref }
  let owners = ownersOf(path, project), routedProject = project
  // First-class cross-project topic send (#27/#28): a BARE ref with no owner in the SENDER'S OWN project
  // resolves to a live owner in another project — consent-gated. Auto-route when exactly ONE grant-reachable
  // project owns it; otherwise a DISTINCT code, so "no-owner" stops doubling as "owned in another project".
  if (!owners.length && !explicit) {
    const ap = projKey(askerProject || 'unclassified'), foreign = new Map()   // projKey -> { name, owners[] }
    for (const e of allTopicEntries()) {
      if (e.role !== 'owner' || !topicMatch(e.pattern, path)) continue
      const pk = projKey(e.project); if (pk === projKey(project)) continue
      if (!foreign.has(pk)) foreign.set(pk, { name: e.project, owners: [] })
      foreign.get(pk).owners.push(e)
    }
    if (foreign.size) {
      const reachable = [...foreign].filter(([pk]) => consent.mayInitiate(ap, pk))
      if (!reachable.length) return { ok: false, code: 'cross-project-no-grant', topic: path,
        owner_projects: [...foreign.values()].map(f => f.name),
        hint: `"${path}" is owned in another project — request_project_access first, or target it explicitly as @<project>/${path}` }
      if (reachable.length > 1) return { ok: false, code: 'cross-project-ambiguous', topic: path,
        owner_projects: reachable.map(([, f]) => f.name),
        hint: `"${path}" is owned in several projects you can reach — target one explicitly as @<project>/${path}` }
      owners = reachable[0][1].owners; routedProject = reachable[0][1].name
    }
  }
  if (!owners.length) return parkToOfflineOwners(from, project, path, verb, body, reply_to, subject, askerProject, ref)
  const fanout = []
  for (const h of owners) {
    const env = makeEnvelope({ to: h.holder, verb, body, reply_to, from, subject, pattern: 'send', topic: path })
    const r = await routeEnvelope(env)
    fanout.push({ to: h.holder, holder_name: h.holder_name || null, ok: !!r.ok, code: r.code || null, envelope_id: env.id })
  }
  return { ok: fanout.some(f => f.ok), topic: path, project: routedProject,
    ...(routedProject !== project ? { cross_project: routedProject } : {}), fanout,
    ...(fanout.length === 1 ? { envelope_id: fanout[0].envelope_id, to: fanout[0].to } : {}) }
}
// publish (T3/T5): event to every subscriber in the target project (wildcards + owners included).
// Zero subscribers is fine — events are fire-and-forget.
async function publishToTopic(from, ref, verb, body, subject, askerProject) {
  const { project, path } = parseTopicRef(ref, askerProject, REALM)
  if (isWildcard(path)) return { ok: false, code: 'wildcard-target', topic: ref }
  const subs = subscribersOf(path, project)
  const fanout = []
  for (const h of subs) {
    const env = makeEnvelope({ to: h.holder, verb, body, from, subject, pattern: 'publish', topic: path })
    const r = await routeEnvelope(env)
    fanout.push({ to: h.holder, holder_name: h.holder_name || null, ok: !!r.ok, code: r.code || null, envelope_id: env.id })
  }
  if (!subs.length) emitTraceRaw({ dir: 'send', verb: verb || 'message', from: from?.session || SESSION, from_name: from?.name || NAME,
    to: `topic:${path}`, to_name: path, to_kind: 'topic', subject: subject || null, pattern: 'publish', topic: path,
    size: String(body || '').length, note: 'no subscribers', envelope_id: null })
  return { ok: true, topic: path, project, subscribers: subs.length, fanout }
}

// ---------------------------------------------------------------- roster sync
function rosterPayload() {
  const HOSTNAME = String(SESSION).split('/')[0]
  const localPages = [...pages.values()].map(p => ({ ...p, host_label: HOSTNAME }))
  // is_gateway is true for THIS host's gateway AND for each remote host's gateway (a gossiped entry whose
  // session id equals its origin) — so the dashboard can mark and structure every machine, not just ours.
  return { sessions: [...roster.values()].map(s => ({ ...s, is_gateway: s.session === gatewayId || (!!s.origin && s.session === s.origin), host_label: String(s.session).split('/')[0] })),
    pages: [...localPages, ...remotePages.values()], hosts: ALIASES, gateway: gatewayId || (role === 'gateway' ? SESSION : null) }
}
// VISIBILITY (§4): a page sees only the projects it may reach (same project / open / static edge),
// so "can't see → can't address" matches the delivery gate. Enforced by default; a page opts out with
// hello { seeAll:true }. Honors the shared-config policy; remote runtime grants don't widen a view
// (delivery still enforces them). The raw list_sessions tool stays full (observability).
function rosterPayloadFor(viewerProject, viewerRealm) {
  const vp = viewerProject || 'unclassified'
  const reach = p => consent.mayInitiate(vp, p || 'unclassified')
  const base = rosterPayload()
  const sessions = []
  for (const s of base.sessions) {
    const subs = (s.subpeers || []).filter(sp => reach(sp.project))
    if (!reach(s.project) && subs.length === 0) continue
    sessions.push({ ...s, subpeers: subs, topics: (s.topics || []).filter(t => reach(t.project)) })
  }
  return { ...base, sessions, pages: base.pages.filter(p => reach(p.project)) }
}
function rosterFor(ws) {
  return (ws.kind === 'dashboard' || ws.seeAll || !ws.project || ws.project === 'unclassified')
    ? rosterPayload() : rosterPayloadFor(ws.project, ws.realm)
}
function broadcastRoster() {
  const frame = { type: 'ROSTER', ...rosterPayload() }
  for (const sock of followers.values()) sendFrame(sock, frame)   // bridges get full; each filters its own leaves
  for (const ws of leaves) if (ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'roster', ...rosterFor(ws) })) } catch {} }
  gossipToPeers()   // §7: push my local slice to peer hubs (no-op unless it actually changed)
}
// push the durable-state snapshot to dashboard(s) (the Persistence view). `target` = one ws, else all.
async function pushPersistence(target) {
  if (!PERSIST) return
  let snap; try { snap = await persistence.snapshot() } catch { return }
  const msg = JSON.stringify({ type: 'persistence', snapshot: snap })
  if (target) { if (target.readyState === 1) { try { target.send(msg) } catch {} } ; return }
  dashSend(msg)
}
setInterval(() => { for (const ws of leaves) { if (ws.kind === 'dashboard' && ws.readyState === 1) { pushPersistence(); break } } },
  Number(process.env.AI_BRIDGE_DASH_PERSIST_MS) || 5000).unref()   // live-refresh the persistence view while a dashboard watches

// ---------------------------------------------------------------- cross-host federation (§7)
// Co-equal per-host hubs find each other through the discovery facet and gossip their LOCAL roster slice
// peer-to-peer. Remote sessions are merged in tagged with `origin` + their owning gateway's address, so
// the existing CONNECT-splice (gateway ingress) delivers to them with no special routing. No central
// node; the smaller ADVERTISE:PORT initiates each link, so there is exactly one connection per pair.
const peerGw = new Map()        // peerGatewaySession -> { sock, host, port, name }
const peerByAddr = new Set()    // "host:port" we hold an OUTBOUND link to (dedupe re-dials)
const remotePages = new Map()   // instance -> page (display fields only) gossiped from a peer hub, tagged with origin + host
let lastGossip = ''
const selfAddr = () => `${ADVERTISE}:${PORT}`
const localRosterSlice = () => [...roster.values()].filter(s => !s.origin)   // my own session + my followers (never relayed entries)
// pages live only on a gateway; gossip DISPLAY fields only (never capKey or other secrets) so remote dashboards can show web sessions
const localPagesSlice = () => [...pages.values()].map(p => ({ instance: p.instance, page_kind: p.page_kind, title: p.title || '', subject: p.subject || null, icon: p.icon || null, project: p.project || null, user: p.user || null }))
const gossipFrame = () => ({ t: 'PEER_ROSTER', gateway: SESSION, host: ADVERTISE, port: PORT, sessions: localRosterSlice(), pages: localPagesSlice() })
function gossipToPeers(force) {
  if (role !== 'gateway' || !peerGw.size) return
  const slice = localRosterSlice(), pg = localPagesSlice(), sig = JSON.stringify([slice, pg])
  if (!force && sig === lastGossip) return                         // only send when MY locals changed (breaks the merge→broadcast→gossip loop)
  lastGossip = sig
  const frame = { t: 'PEER_ROSTER', gateway: SESSION, host: ADVERTISE, port: PORT, sessions: slice, pages: pg }
  for (const p of peerGw.values()) if (p.sock && !p.sock.destroyed) sendFrame(p.sock, frame)
}
function mergeRemoteRoster(fromGw, host, port, sessions, pages) {
  if (!fromGw || fromGw === SESSION) return
  for (const [k, v] of [...roster]) if (v.origin === fromGw) roster.delete(k)   // replace this gateway's slice wholesale
  for (const s of (sessions || [])) {
    if (!s || s.session === SESSION || s.origin) continue          // never let a peer override my own / never re-host a relayed entry
    roster.set(s.session, { ...s, origin: fromGw, host: host || HOST, port: port || PORT })   // dial via the owning gateway
  }
  for (const [k, v] of [...remotePages]) if (v.origin === fromGw) remotePages.delete(k)
  const rhost = String(fromGw).split('/')[0]
  for (const p of (pages || [])) if (p && p.instance) remotePages.set(p.instance, { ...p, origin: fromGw, host_label: rhost })
  broadcastRoster()
}
function adoptPeer(peerSession, sock, host, port, name) {
  if (!peerSession || peerSession === SESSION) return
  const existing = peerGw.get(peerSession)
  if (existing && existing.sock && existing.sock !== sock) { try { existing.sock.destroy() } catch {} }
  peerGw.set(peerSession, { sock, host, port, name: name || peerSession })
  emitTraceRaw({ dir: 'con', verb: 'peer', from: peerSession, from_name: name || peerSession, to: SESSION, size: 0,
    note: `peer hub linked (${host}:${port})`, envelope_id: null })
}
function dropPeer(peerSession) {
  if (!peerGw.has(peerSession)) return
  peerGw.delete(peerSession)
  let changed = false
  for (const [k, v] of [...roster]) if (v.origin === peerSession) { roster.delete(k); changed = true }
  for (const [k, v] of [...remotePages]) if (v.origin === peerSession) { remotePages.delete(k); changed = true }
  emitTraceRaw({ dir: 'con', verb: 'offline', from: peerSession, from_name: peerSession, to: SESSION, size: 0,
    note: 'peer hub offline', envelope_id: null })
  if (changed) broadcastRoster()
}
function connectToPeer(host, port) {
  const addr = `${host}:${port}`
  if (peerByAddr.has(addr)) return
  peerByAddr.add(addr)
  let peerSession = null
  const sock = profile.transport.connect(port, host)
  sock.on('connect', () => {
    sendFrame(sock, { t: 'HELLO', ver: VER, fromBridge: SESSION, fromSession: SESSION, name: NAME, auth: TOKEN })
    sendFrame(sock, { t: 'PEER_HELLO', session: SESSION, name: NAME, host: ADVERTISE, port: PORT, realm: REALM })
    sendFrame(sock, gossipFrame())
  })
  onFrames(sock, f => {
    if (f.t === 'PEER_HELLO') { peerSession = f.session; adoptPeer(f.session, sock, f.host || host, f.port || port, f.name) }
    else if (f.t === 'PEER_ROSTER') mergeRemoteRoster(f.gateway, f.host, f.port, f.sessions, f.pages)
    else if (f.t === 'REJECT') { try { sock.destroy() } catch {} }
  })
  sock.on('close', () => { peerByAddr.delete(addr); if (peerSession && peerGw.get(peerSession)?.sock === sock) dropPeer(peerSession) })
  sock.on('error', () => {})
}
// §7/#35: the advertise host is the one per-machine value that can't live in a shared config, so when left
// auto (no advertiseHost, bind 0.0.0.0 ⇒ ADVERTISE starts as loopback) we derive it from the discovery
// backend (tailscale Self). That derivation must be ROBUST to a backend that isn't ready yet: a bridge that
// starts before Tailscale has assigned this node its tailnet IP would otherwise latch the bare hostname,
// which sorts ABOVE peer IPs and permanently breaks the "smaller ADVERTISE:PORT dials" tie-break (nobody
// dials ⇒ split brain). So we RETRY every tick and refuse to dial until a routable address is in hand.
const CAN_DERIVE = ADVERTISE_AUTO && ADVERTISE === HOST && !!(discovery && discovery.selfHost)
let advertiseReady = !CAN_DERIVE   // backends that can't/needn't derive (seeds/none, pinned, bind-IP) are ready now
async function deriveAdvertise() {
  if (advertiseReady) return
  try { const h = await discovery.selfHost(); if (h && h !== HOST) { ADVERTISE = h; advertiseReady = true; log(`advertise host auto-derived: ${h}`) } } catch {}
}
async function discoveryTick() {
  if (role !== 'gateway') return
  await deriveAdvertise()
  if (!advertiseReady) return   // #35: don't run the dial tie-break on an un-derived (loopback/hostname) advertise
  let cands = []
  try { cands = await discovery.candidates() } catch {}
  const me = selfAddr()
  for (const c of (cands || [])) {
    if (!c || !c.host || !c.port) continue
    const addr = `${c.host}:${c.port}`
    if (addr === me || peerByAddr.has(addr)) continue
    if (me < addr) connectToPeer(c.host, c.port)   // deterministic: the smaller ADVERTISE:PORT dials → exactly one link per pair
  }
}
let discoveryTimer = null
async function startDiscovery() {
  await deriveAdvertise()
  if (CAN_DERIVE && !advertiseReady)
    log('cross-host discovery on but advertise host not derived yet (tailscale not ready?) — retrying each tick, not dialing until routable')
  else if (discovery.selfHost && BIND === HOST && ADVERTISE === HOST)
    log('cross-host discovery is on but bind+advertise are loopback — peers cannot reach this hub; set "bind":"0.0.0.0" (or a tailnet IP)')
  try { discovery.advertise && discovery.advertise() } catch {}
  discoveryTick()
  if (!discoveryTimer) discoveryTimer = setInterval(discoveryTick, DISCOVERY_MS).unref()
}
function teardownPeers() {
  for (const p of peerGw.values()) { try { p.sock && p.sock.destroy() } catch {} }
  peerGw.clear(); peerByAddr.clear(); lastGossip = ''
}

// ---------------------------------------------------------------- gateway role
function becomeGateway(server) {
  role = 'gateway'; gwServer = server; backoff = 200; gatewayId = SESSION
  log(`gateway on :${PORT} (session ${SESSION})`)
  emitTraceRaw({ dir: 'con', verb: 'gateway', from: SESSION, from_name: NAME, to: SESSION, size: 0,
    note: 'promoted to gateway', envelope_id: null })
  roster = new Map([[SESSION, { session: SESSION, name: NAME, port: pairPort, kind: 'session',
    subpeers: [...subpeers.values()].map(s => ({ id: s.id, name: s.name, parent: s.parent, kind: 'subpeer', client: s.client || null, client_kind: s.client_kind || null, project: s.identity?.project || null, user: s.identity?.user || null, realm: s.identity?.realm || REALM })),
    topics: topicList(), bridge_version: BRIDGE_VERSION, capabilities: CAPS, connected_at: new Date().toISOString(),
    realm: REALM, project: PROC_IDENT?.project || null, user: PROC_IDENT?.user || null,
    client: CLIENT ? CLIENT.name : null, client_kind: CLIENT ? clientKind(CLIENT.name) : null }]])
  flushPendingTraces()
  server.on('connection', sock => {
    let who = null
    onFrames(sock, async f => {
      if (f.t === 'HELLO') {
        if (!profile.auth.verify(f.auth)) { sendFrame(sock, { t: 'REJECT', code: 'unauthorized' }); sock.end(); return }
        who = f
      } else if (f.t === 'REGISTER') {                       // follower control connection
        if (!who) { sendFrame(sock, { t: 'REJECT', code: 'no-hello' }); sock.end(); return }
        roster.set(f.session, { session: f.session, name: f.name, port: f.port, kind: 'session', subpeers: f.subpeers || [], topics: f.topics || [], bridge_version: f.bridge_version || null, capabilities: f.capabilities || null, connected_at: new Date().toISOString(), realm: f.realm || REALM, project: f.project || null, user: f.user || null, client: f.client || null, client_kind: clientKind(f.client) })
        followers.set(f.session, sock)
        emitTraceRaw({ dir: 'con', verb: 'connect', from: f.session, from_name: f.name, to: SESSION, size: 0,
          note: `session joined${f.client ? ' (' + f.client + ')' : ''}`, envelope_id: null })
        sock.on('close', () => {
          followers.delete(f.session); const gone = roster.get(f.session); roster.delete(f.session)
          emitTraceRaw({ dir: 'con', verb: 'offline', from: f.session, from_name: gone ? gone.name : f.name, to: SESSION, size: 0,
            note: 'session offline', envelope_id: null })
          broadcastRoster()
        })
        sendFrame(sock, { t: 'REGISTERED', session: f.session })
        broadcastRoster()
      } else if (f.t === 'SET_NAME') {
        const r = roster.get(f.session); if (r) { r.name = f.name; broadcastRoster() }
      } else if (f.t === 'SUBPEERS') {
        const r = roster.get(f.session); if (r) { r.subpeers = f.subpeers || []; broadcastRoster() }
      } else if (f.t === 'TOPICS') {
        const r = roster.get(f.session); if (r) { r.topics = f.topics || []; broadcastRoster() }
      } else if (f.t === 'SET_CLIENT') {
        const r = roster.get(f.session); if (r) { r.client = f.client || null; r.client_kind = clientKind(f.client); broadcastRoster() }
      } else if (f.t === 'TRACE') {
        traces.collect(f.trace)
      } else if (f.t === 'PAGE_MSG') {                       // follower forwarding an envelope to a page leaf
        if (f.env && String(f.env.to || '').startsWith('page:')) deliverPage(f.env)
      } else if (f.t === 'CONNECT') {                        // cross-host ingress: splice to local target
        if (!who) { sendFrame(sock, { t: 'REJECT', code: 'no-hello' }); sock.end(); return }
        const peer = ownerOf(f.target)
        if (!peer) { sendFrame(sock, { t: 'REJECT', code: 'unknown-target' }); sock.end(); return }
        const out = profile.transport.connect(peer.port, peer.host || HOST)
        out.on('connect', () => {
          sendFrame(out, { t: 'HELLO', ver: VER, fromBridge: who.fromBridge, fromSession: who.fromSession, name: who.name, auth: profile.auth.credential() })
          sendFrame(out, { t: 'CONNECT', target: f.target })
          sock.removeAllListeners('data'); out.pipe(sock); sock.pipe(out)   // splice-opaque from here
        })
        out.on('error', () => { sendFrame(sock, { t: 'REJECT', code: 'target-unreachable' }); sock.end() })
      } else if (f.t === 'PEER_HELLO') {                     // inbound cross-host hub link (§7)
        if (!who) { sendFrame(sock, { t: 'REJECT', code: 'no-hello' }); sock.end(); return }
        if (f.realm && f.realm !== REALM) { sendFrame(sock, { t: 'REJECT', code: 'realm-mismatch' }); sock.end(); return }
        adoptPeer(f.session, sock, f.host, f.port, f.name)
        sendFrame(sock, { t: 'PEER_HELLO', session: SESSION, name: NAME, host: ADVERTISE, port: PORT, realm: REALM })
        sendFrame(sock, gossipFrame())
        sock.on('close', () => { if (peerGw.get(f.session)?.sock === sock) dropPeer(f.session) })
      } else if (f.t === 'PEER_ROSTER') {
        mergeRemoteRoster(f.gateway, f.host, f.port, f.sessions, f.pages)
      } else if (f.t === 'PING') sendFrame(sock, { t: 'PONG', seq: f.seq })
    })
    sock.on('error', () => {})
  })
  // WS leaf ingress — served on an HTTP server so the dashboard loads from http://127.0.0.1:WS_PORT
  // (same origin as the WS). file:// pages are blocked from ws://127.0.0.1 by Chrome PNA; http isn't.
  try {
    const httpd = profile.transport.createHttpServer((req, res) => {
      let u = decodeURIComponent(String(req.url || '/').split('?')[0])
      if (u === '/') u = '/dashboard.html'
      // serve the bundled client pages + the page-client tools over http (same origin as the WS, so
      // they aren't subject to the file:// restrictions). Allowlisted paths only — no traversal.
      const okHtml = /^\/(dashboard|chat|test_page)\.html$/.test(u)
      const okTool = /^\/tools\/[a-z0-9_.-]+\.js$/i.test(u)
      if (okHtml || okTool) {
        try { res.writeHead(200, { 'Content-Type': okTool ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(HERE, u.slice(1)))); return } catch {}
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found')
    })
    httpd.on('error', e => log('http server error', e.code))
    httpd.listen(WS_PORT, BIND)
    wss = profile.transport.createWsServer({ server: httpd })
    wss.on('connection', ws => {
      ws.on('message', async raw => {
        let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
        if (m.type === 'hello') {
          if (!profile.auth.verify(m.token)) { ws.close(); return }
          if (m.kind === 'listener') {     // T14 wake attach point — reserved, not implemented
            try { ws.send(JSON.stringify({ type: 'error', code: 'unsupported', what: 'listener' })) } catch {}
            ws.close(); return
          }
          ws.kind = m.kind === 'dashboard' ? 'dashboard' : 'page'
          ws.instance = m.instance || crypto.randomBytes(4).toString('hex')
          if (ws.kind === 'page') {
            // subject = the page's topic path: auto-claimed (shared) + auto-subscribed (T12). A wildcard
            // subject is NOT a valid responsibility (unaddressable, §6) — drop it from the auto-claim so a
            // page can't sneak a wildcard claim in via the leaf path; its subscribe list stays wildcard-OK.
            const pident = profile.identity.classify({ project: m.project, user: m.user, realm: REALM })
            const pSubject = (m.subject && !isWildcard(m.subject)) ? m.subject : null
            if (m.subject && !pSubject) log(`page ${ws.instance}: wildcard subject "${m.subject}" not auto-claimed (responsibilities are concrete); subscribe patterns stay wildcard-OK`)
            pages.set(ws.instance, { instance: ws.instance, page_kind: m.page_kind || 'page', title: m.title || '',
              subject: pSubject, subscriptions: Array.isArray(m.subscribe) ? m.subscribe.slice(0, 32) : [],
              icon: m.icon || null, kind: 'page', capKey: capKeyFrom(ws.instance),
              identity: pident, project: pident.project, user: pident.user })
            ws.project = pident.project; ws.realm = pident.realm; ws.seeAll = !!m.seeAll   // visibility scope (§4)
          }
          leaves.add(ws)
          log(`${ws.kind} connected: ${m.page_kind || ws.kind} "${m.title || ''}" (${ws.instance})`)
          if (ws.kind === 'page') emitTraceRaw({ dir: 'con', verb: 'connect', from: `page:${ws.instance}`, from_name: m.title || m.page_kind || 'page', to: SESSION, size: 0, note: `page joined (${m.page_kind || 'page'})`, envelope_id: null })
          ws.send(JSON.stringify({ type: 'welcome', instance: ws.instance, gateway: SESSION, bridge_version: BRIDGE_VERSION, profile: profile.names, capabilities: CAPS, realm: REALM, ...rosterFor(ws) }))
          if (ws.kind === 'dashboard') { ws.send(JSON.stringify({ type: 'trace_history', traces: traces.history() })); pushPersistence(ws) }
          broadcastRoster()
        } else if (m.type === 'set_alias' && ws.kind === 'dashboard') {
          if (m.scope === 'host') { ALIASES[m.target] = m.alias; persistAliases() }
          else if (m.scope === 'session') {
            const r = roster.get(m.target); if (r) r.name = m.alias
            if (m.target === SESSION) NAME = m.alias                       // gateway renamed itself
            else { const fs2 = followers.get(m.target); if (fs2) sendFrame(fs2, { t: 'RENAME', name: m.alias }) }
          }
          else if (m.scope === 'page') { const p = pages.get(m.target); if (p) p.title = m.alias }
          log(`alias set (${m.scope}): ${m.target} -> "${m.alias}"`)
          broadcastRoster()
        } else if (m.type === 'send' || m.type === 'publish') {
          const from = { session: `page:${ws.instance}`, name: m.page_kind || pages.get(ws.instance)?.page_kind || 'page', kind: 'page' }
          if (!String(m.subject || '').trim()) {                         // T7: no lazy callers
            ws.send(JSON.stringify({ type: 'sent', ref: m.ref || null, ok: false, code: 'subject-required' }))
            return
          }
          if (m.type === 'publish') {                                    // page event -> subscribers
            const r = await publishToTopic(from, String(m.topic || '').trim(), m.verb, m.body, String(m.subject).trim(), askerProjectOf(from))
            ws.send(JSON.stringify({ type: 'sent', ref: m.ref || null, ok: !!r.ok, code: r.code || null,
              subscribers: r.subscribers ?? null, fanout: r.fanout || null }))
            return
          }
          if (String(m.to || '').startsWith('topic:')) {                 // page -> topic owners (T3)
            const r = /** @type {any} */ (await routeToTopicOwners(from, String(m.to).slice(6).trim(), m.verb, m.body, null, String(m.subject).trim(), askerProjectOf(from)))
            ws.send(JSON.stringify({ type: 'sent', ref: m.ref || null, ok: !!r.ok, code: r.code || null,
              envelope_id: r.envelope_id || null, fanout: r.fanout || null }))
            return
          }
          const env = makeEnvelope({ to: m.to, verb: m.verb, body: m.body, from, subject: String(m.subject).trim() })
          let r
          if (m.to === SESSION) { r = await deliver(env); emitTrace('send', env, 'leaf->gateway') }
          else if (isLocalSubId(m.to)) { r = deliverSub(m.to, env); emitTrace('send', env, 'leaf->subpeer') }
          else if (String(m.to || '').startsWith('page:')) { r = deliverPage(env) }   // page -> page (gateway-side)
          else {
            const peer = ownerOf(m.to)
            if (!peer) r = { ok: false, code: 'unknown-target' }
            else { emitTrace('send', env, 'leaf'); r = await dialAndSend(peer.port, peer.host || HOST, m.to, env) }
          }
          ws.send(JSON.stringify({ type: 'sent', ref: m.ref || null, ok: !!r.ok, code: r.code || null, envelope_id: env.id }))
        }
      })
      ws.on('close', () => {
        if (ws.kind) log(`${ws.kind} disconnected (${ws.instance})`)
        if (ws.kind === 'page') {
          const p = pages.get(ws.instance)
          emitTraceRaw({ dir: 'con', verb: 'offline', from: `page:${ws.instance}`, from_name: p ? (p.title || p.page_kind) : 'page', to: SESSION, size: 0, note: 'page offline', envelope_id: null })
        }
        leaves.delete(ws); if (ws.kind === 'page') pages.delete(ws.instance); broadcastRoster()
      })
      ws.on('error', () => {})
    })
    wss.on('error', e => log('ws server error', e.code))
  } catch (e) { log('ws listener failed', e.code) }
  broadcastRoster()
  maybeLaunchTray()
  startDiscovery()   // §7: begin enumerating + linking peer hubs across machines (no-op for discovery=none)
}

// ---------------------------------------------------------------- follower role
function becomeFollower() {
  role = 'follower'
  teardownPeers()   // §7: a follower reaches remote hubs via its gateway's merged roster, not its own peer links
  const sock = profile.transport.connect(PORT, HOST)
  gwSock = sock
  sock.on('connect', () => {
    backoff = 200
    sendFrame(sock, { t: 'HELLO', ver: VER, fromBridge: SESSION, fromSession: SESSION, name: NAME, auth: TOKEN })
    sendFrame(sock, { t: 'REGISTER', session: SESSION, name: NAME, port: pairPort,
      subpeers: [...subpeers.values()].map(s => ({ id: s.id, name: s.name, parent: s.parent, kind: 'subpeer', project: s.identity?.project || null, user: s.identity?.user || null, realm: s.identity?.realm || REALM })),
      topics: topicList(), bridge_version: BRIDGE_VERSION, capabilities: CAPS,
      realm: REALM, project: PROC_IDENT?.project || null, user: PROC_IDENT?.user || null,
      client: CLIENT ? CLIENT.name : null })
    log(`follower registered with gateway on :${PORT}`)
  })
  onFrames(sock, f => {
    if (f.t === 'RENAME') { NAME = f.name }
    else if (f.t === 'REGISTERED') { flushPendingTraces() }
    else if (f.type === 'ROSTER') {
      roster = new Map(f.sessions.map(s => [s.session, s]))
      pages = new Map((f.pages || []).map(p => [p.instance, p]))
      if (f.gateway) gatewayId = f.gateway
    }
  })
  const reelect = () => { if (role !== 'stopping') { gwSock = null; setTimeout(election, backoff + Math.random() * 100); backoff = Math.min(backoff * 2, 3000) } }
  sock.on('close', reelect)
  sock.on('error', () => {})
}

// ---------------------------------------------------------------- election (the single retry edge)
function election() {
  if (role === 'stopping') return
  role = 'binding'
  const server = profile.transport.createServer()
  server.once('error', e => {
    if (e.code === 'EADDRINUSE') becomeFollower()
    else { log('bind error', e.code); setTimeout(election, backoff); backoff = Math.min(backoff * 2, 3000) }
  })
  server.listen(PORT, BIND, () => becomeGateway(server))
}

// ---------------------------------------------------------------- MCP server (the session side)
const mcp = new Server(
  { name: 'ai-mcp-bridge', version: BRIDGE_VERSION },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions:
      'Ai MCP Bridge: peer messages from other AI sessions and web pages arrive as ' +
      '<channel source="ai-mcp-bridge" from="..." from_name="..." verb="..." subject="...">body</channel>. ' +
      'Act on the verb (advisory: the verb and payload are defined by your application). ' +
      'Reply with the send_to_peer tool, passing the from session id as target. ' +
      'In clients without channel support, poll the inbox tool instead. Every response to a call you make ' +
      'as a registered sub-peer (as/secret) carries an `inbox` hint { unread, next_cursor, queue_epoch }: ' +
      'if unread > 0, poll the inbox tool (with for/secret, cursor = next_cursor) to collect new mail — so ' +
      'you rarely need to poll blindly. (queue_epoch change ⇒ reset cursor to 0.) Use list_sessions for the roster. ' +
      'IMPORTANT for Cowork/Desktop conversations and for subagents: this bridge process may be SHARED — ' +
      'call register_self with a name, a self-invented secret, and your project + user (the project the ' +
      'conversation is for, and the human supervising it) to get your own peer id and private inbox ' +
      '(then always pass for/secret to inbox and as/secret to send_to_peer). Subagents expecting replies ' +
      'should register their own identity with parent=<your handle> and deregister before returning. ' +
      'SUBJECT (required on every send/publish): a short PUBLIC one-line description of the action — it is ' +
      'NOT encrypted (bodies are); never put private information in it. ' +
      'TOPICS: /-separated paths (e.g. "team/reviews"). Two relationships: subscribe {pattern} ' +
      '(interest — open to all, wildcards + and #) and claim_topic {topic, description, exclusive, icon} ' +
      '(accountability; owners are auto-subscribed; release_topic to give up). Two message patterns: ' +
      'publish {topic, subject, message} = event to ALL subscribers, nobody obliged to act; ' +
      'send_to_peer {target:"topic:<topic>"} = directed work to the topic OWNER(S) only (prefix required). ' +
      'If claim_topic returns code "held", do not seize: send the holder verb request_responsibility ' +
      '{topic, reason}; the holder answers grant_responsibility (after releasing), refuse_responsibility, ' +
      'or asks its human operator.',
  },
)

// TOOLS schema array (the tools/list payload) lives in lib/tool-schemas.js (imported above).

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS, ...serviceTools] }))   // core tools + any loaded service tools
mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const a = req.params.arguments || {}
  let callerId = null   // the calling sub-peer (if it authenticates); drives the inbox hint, below
  // every response to an identified caller carries `inbox` so it knows whether to poll (the `inbox` verb
  // already returns the queue state, so skip it there to avoid redundancy).
  const ok = o => {
    if (callerId && req.params.name !== 'inbox' && o && typeof o === 'object' && o.inbox === undefined) {
      const h = inboxHint(callerId); if (h) o = { ...o, inbox: h }
    }
    return { content: [{ type: 'text', text: JSON.stringify(o, null, 1) }] }
  }
  const authSub = (ref, secret) => {
    const sp = resolveLocalSub(ref)
    if (!sp) return { err: { ok: false, code: 'unknown-subpeer', ref } }
    if (sp.secretHash !== sha(secret || '')) return { err: { ok: false, code: 'bad-secret', ref: sp.id, ...recoverHint(sp.name, sp.identity?.project) } }
    sp.last_seen = Date.now()
    return { sp }
  }
  if (a.as && a.secret != null) { const r = authSub(String(a.as), a.secret); if (!r.err) callerId = r.sp.id }   // identify the caller for the hint
  switch (req.params.name) {
    case 'my_identity': return ok({ session: SESSION, name: NAME, role, host: SESSION.split('/')[0], gateway: gatewayId, pair_port: pairPort, gateway_port: PORT,
      bridge_version: BRIDGE_VERSION, capabilities: CAPS, realm: REALM, profile: profile.names, identity: PROC_IDENT,
      client: CLIENT, mode_override: MODE_OVERRIDE, subpeers: [...subpeers.values()].map(s => ({ id: s.id, name: s.name, parent: s.parent, project: s.identity?.project, user: s.identity?.user })),
      topics: topicList() })
    case 'set_name': {
      NAME = String(a.name || NAME)
      if (role === 'gateway') { const r = roster.get(SESSION); if (r) r.name = NAME; broadcastRoster() }
      else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'SET_NAME', session: SESSION, name: NAME })
      return ok({ session: SESSION, name: NAME })
    }
    case 'register_self': {
      const name = String(a.name || '').trim(), secret = String(a.secret || '')
      if (!name || !secret) return ok({ ok: false, code: 'name-and-secret-required' })
      const existing = [...subpeers.values()].find(s => ciEq(s.name, name))
      if (existing) {
        if (existing.secretHash !== sha(secret)) return ok({ ok: false, code: 'name-taken', name, ...recoverHint(name, existing.identity?.project) })
        existing.last_seen = Date.now()
        const q = subQueues.get(existing.id)
        await syncDurableMailbox(existing)   // §23: a returning peer also picks up out-of-band parked mail
        callerId = existing.id   // §20 resync on reattach too: hand back current topics + access + the inbox hint
        const reTopics = [...myTopics.values()].filter(e => e.holder === existing.id).map(e => ({ pattern: e.pattern, role: e.role, exclusive: e.exclusive || undefined, icon: e.icon || undefined }))
        return ok({ ok: true, peer_id: existing.id, name, queue_epoch: q.epoch, next_cursor: q.base + q.items.length, reattached: true, identity: existing.identity, topics: reTopics, access: consent.reachable(existing.identity?.project), behaviors: reminders.list(existing.id), default_behaviors: reminders.defaultList() })
      }
      let parent = null
      if (a.parent) {
        const p = resolveLocalSub(String(a.parent))
        if (!p) return ok({ ok: false, code: 'unknown-parent', parent: a.parent })
        parent = p.id
      }
      const slug = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'peer'
      const id = `${SESSION}/${slug}-${crypto.randomBytes(2).toString('hex')}`
      const ttl = Math.max(Number(a.ttl_minutes) > 0 ? Number(a.ttl_minutes) : (parent ? CHILD_TTL_MIN : SUB_TTL_MIN), 0.01)
      const declaredClient = String(a.client || '').trim() || (CLIENT ? CLIENT.name : null)
      const ckind = clientKind(declaredClient)
      const mode = (a.mode === 'push' || a.mode === 'poll') ? a.mode : (ckind === 'code' ? 'push' : null)
      // mandatory classification: project is session-declared (it's about the work); user is the
      // OS-authenticated login (a.user is IGNORED — can't be fabricated). A child inherits its parent's.
      const parentSp = parent ? subpeers.get(parent) : null
      const ident = profile.identity.classify({
        project: a.project || (parentSp && parentSp.identity.project) || PROC_PROJECT,
        user: (parentSp && parentSp.identity.user) || PROC_USER, realm: REALM })
      subpeers.set(id, { id, name, secretHash: sha(secret), parent, kind: 'subpeer',
        created: Date.now(), last_seen: Date.now(), ttl_ms: ttl * 60000, mode,
        client: declaredClient, client_kind: ckind,
        identity: ident, capKey: capKeyFrom(secret) })   // capKey: RAM-only reply-cap signing key (§5)
      subQueues.set(id, newQueue())
      if (PERSIST && ident.project) {                  // §12: re-hydrate parked mail for this identity (survives restart/TTL)
        const pid = pIdent(ident, name)                // keyed per peer name so co-user peers don't share a mailbox
        try {
          const L = persistence.limits
          await persistence.mailbox.gc(pid, { ttlMs: L.messageTtlMs, maxCount: L.mailboxMaxCount, maxBytes: L.mailboxMaxBytes })
          const parked = await persistence.mailbox.drain(pid)
          const q0 = subQueues.get(id)
          for (const p of parked) if (p && p.record && p.record.id) q0.items.push(p.record)
          if (parked.length) emitTraceRaw({ dir: 'recv', verb: 'rehydrate', from: id, from_name: name, to: SESSION, size: parked.length, note: `${parked.length} parked message(s) restored`, envelope_id: null })
        } catch { }
        try {                                          // §12: re-assert this identity's durable claims (responsibilities)
          const dc = await persistence.claims.byHolder(pid)
          let n = 0; for (const rec of dc) if (rehydrateClaim(rec, id, name, pid)) n++
          if (n) { announceTopics(); emitTraceRaw({ dir: 'con', verb: 'rehydrate', from: id, from_name: name, to: SESSION, size: n, note: `${n} responsibility(ies) restored`, envelope_id: null }) }
        } catch { }
        if (PERSIST_SUBS) {                            // §20: re-establish this identity's durable subscriptions
          try {
            const subs = await persistence.subscriptions.byHolder(pid)
            let n = 0
            for (const s of subs) {
              if (!s.pattern) continue
              const sk = `${id}|subscriber|${patternKey(s.pattern)}`
              if (!myTopics.has(sk)) { myTopics.set(sk, { pattern: s.pattern, role: 'subscriber', holder: id, holder_name: name, project: ident.project, realm: ident.realm, claimed_at: s.subscribed_at || new Date().toISOString() }); n++ }
              persistence.subscriptions.put(pid, s.pattern, { subscribed_at: new Date().toISOString() }).catch(() => {})   // refresh the lease
            }
            if (n) { announceTopics(); emitTraceRaw({ dir: 'con', verb: 'rehydrate', from: id, from_name: name, to: SESSION, size: n, note: `${n} subscription(s) restored`, envelope_id: null }) }
          } catch { }
        }
        await reminders.load(id, pid)   // #29: rehydrate this identity's durable behaviour reminders into RAM
        // §19: record a DURABLE registration (name -> identity) so a directed send to this peer BY NAME can
        // resolve + park while it's offline, and a returning peer is recognised across a gateway restart.
        persistence.registrations.put(pid, { name, secret_hash: sha(secret), client_kind: ckind, last_seen: new Date().toISOString() }).catch(() => {})
        if (VAULT) {   // §21: SEAL the secret to the user (silent) so a session that loses it can recover via Hello
          try { const sealed = await vault.seal(secret); if (sealed) await persistence.vault.put(pid, { sealed }) } catch { }
        }
      }
      announceSubpeers()
      emitTraceRaw({ dir: 'con', verb: 'connect', from: id, from_name: name, to: SESSION, size: 0,
        note: (parent ? `child of ${parent.split('/').pop()}` : 'sub-peer registered') + (ckind ? ` [${ckind}]` : '') + ` {${ident.project}/${ident.user}}`, envelope_id: null })
      const q = subQueues.get(id)
      callerId = id   // so the response's inbox hint reflects any rehydrated parked mail this returning peer has waiting
      // §20 resync: hand back the identity's current topics (owned + subscribed, post-rehydration) and the
      // projects it may reach — so a reconnecting/compacted session relearns its state without re-attaching.
      const myTopicsNow = [...myTopics.values()].filter(e => e.holder === id).map(e => ({ pattern: e.pattern, role: e.role, exclusive: e.exclusive || undefined, icon: e.icon || undefined }))
      return ok({ ok: true, peer_id: id, name, queue_epoch: q.epoch, next_cursor: 0, client: declaredClient, client_kind: ckind, mode, identity: ident, topics: myTopicsNow, access: consent.reachable(ident.project), behaviors: reminders.list(id), default_behaviors: reminders.defaultList() })
    }
    case 'deregister': {
      const { sp, err } = authSub(String(a.peer_id || ''), a.secret)
      if (err) return ok(err)
      const children = [...subpeers.values()].filter(s => s.parent === sp.id).length
      removeSubpeer(sp.id, 'deregister')
      announceSubpeers()
      return ok({ ok: true, removed: sp.id, children_removed: children })
    }
    case 'recover_secret': {
      // §21: recover a lost secret via the USER's presence. No secret is required (you lost it); the vault
      // unseal is presence-gated (Windows Hello in the tpm impl) and the secret was encrypted to the user's
      // TPM, so only the real human at their own machine can recover it. Returns the original secret.
      if (!VAULT) return ok({ ok: false, code: 'unsupported', what: 'secret recovery (no vault facet)' })
      const name = String(a.name || '').trim()
      if (!name) return ok({ ok: false, code: 'name-required' })
      let regs = []
      try { regs = await persistence.registrations.byName(name) } catch { }
      const wantProj = a.project ? projKey(a.project) : null
      const cands = regs.filter(r => !wantProj || projKey(r.project) === wantProj)
      if (!cands.length) return ok({ ok: false, code: 'unknown-identity', name })
      if (cands.length > 1) return ok({ ok: false, code: 'ambiguous-name', candidates: cands.map(r => `${r.project}:${r.name}`) })
      const r = cands[0]
      const ident = { realm: r.realm || REALM, project: r.project, user: r.user, name: r.name }
      const v = await persistence.vault.get(ident)
      if (!v || !v.sealed) return ok({ ok: false, code: 'no-vault-entry', name })
      const res = await vault.unseal(v.sealed, { subject: `Recover the Ai MCP Bridge secret for session "${r.name}" (${r.project}).` })
      if (!res || !res.ok) return ok({ ok: false, code: 'recovery-denied', reason: res ? res.reason : 'unseal-failed' })
      emitTraceRaw({ dir: 'con', verb: 'recover_secret', from: SESSION, from_name: NAME, to: SESSION, size: 0, note: `secret recovered for "${r.name}" (${res.by})`, envelope_id: null })
      return ok({ ok: true, name: r.name, project: r.project, secret: res.plaintext, by: res.by,
        hint: 're-register with name + this secret to reattach (you get your topics + parked mail back), then use it as as/secret on send_to_peer and for/secret on inbox' })
    }
    case 'list_sessions': return ok({ role, host: SESSION.split('/')[0], ...rosterPayload() })
    case 'claim_topic': {
      const topic = String(a.topic || '').trim()
      if (!topic) return ok({ ok: false, code: 'topic-required' })
      // §6: a responsibility (claim) must be CONCRETE and addressable. A wildcard claim ('+'/'#') is
      // unsendable — routeToTopicOwners refuses a wildcard target — so it silently breaks any UI that
      // offers it as a target. Banned for BOTH exclusive and shared claims. (subscribe stays wildcard-capable:
      // watching a subtree is fine; owning one is not.) Decision 2026-06-16 (design review).
      if (isWildcard(topic)) return ok({ ok: false, code: 'wildcard-claim', hint: "claim the concrete base instead, e.g. 'retail' not 'retail/#'" })
      if (a.force) return ok({ ok: false, code: 'unsupported', what: 'forced takeover (offline delivery, T14)' })
      // §12: when persistence is on a claim is durable BY DEFAULT (responsibilities survive a restart);
      // opt out with persistent:false. Without persistence the flag is a no-op (nothing to write).
      const persistent = PERSIST && a.persistent !== false
      const description = String(a.description || '')
      const exclusive = !!a.exclusive
      const icon = String(a.icon || '').trim().slice(0, 16) || null
      const announce_offline = !!a.announce_offline                       // §16: tell senders when I'm offline (else parked silently)
      const grace_minutes = a.grace_minutes != null ? Number(a.grace_minutes) : null   // §16: per-claim takeover grace
      const allow_other_user = a.allow_other_user != null ? !!a.allow_other_user : null // §16: per-claim cross-user takeover
      let holder = SESSION, holderName = NAME, holderProject = PROC_IDENT?.project || 'unclassified', holderRealm = REALM, holderIdentity = pIdent(PROC_IDENT, HOSTNAME)
      if (a.as) {
        const { sp, err } = authSub(String(a.as), a.secret)
        if (err) return ok(err)
        holder = sp.id; holderName = sp.name; holderProject = sp.identity?.project || 'unclassified'; holderRealm = sp.identity?.realm || REALM; holderIdentity = pIdent(sp.identity, sp.name)
      }
      // T6/§6: an exclusive claim conflicts with overlapping claims IN THE SAME PROJECT only
      const others = allTopicEntries().filter(e => e.role === 'owner' && e.holder !== holder && projKey(e.project) === projKey(holderProject) && patternsOverlap(e.pattern, topic))
      const blocker = others.find(e => e.exclusive) || (exclusive && others.length ? others[0] : null)
      if (blocker) return ok({ ok: false, code: 'held', topic,
        holder: blocker.holder, holder_name: blocker.holder_name || null, holder_pattern: blocker.pattern, holder_exclusive: !!blocker.exclusive,
        holders: others.map(o => o.holder),
        hint: 'negotiate: send the holder verb request_responsibility {topic, reason}' })
      // §16: a DORMANT (offline) durable owner of an overlapping topic isn't in myTopics, so guard it here —
      // same-user takeover needs human confirmation (authorizer); cross-user runs grace-then-displaceable.
      if (persistent && holderIdentity) {
        const verdict = await resolveDormantConflict(topic, holderIdentity, holderProject, exclusive)
        if (verdict && !verdict.ok) return ok(verdict)
      }
      // #26: if this topic was kept ALIVE (ownerless) it has a durable marker — inherit its metadata where the
      // claimer left a field unset, preserve the keep_alive intent unless overridden, and drain its parked queue below.
      let kept = null
      if (persistent) { try { kept = await persistence.keptTopics.get(holderProject, topic) } catch { } }
      const keep_alive = a.keep_alive != null ? !!a.keep_alive : !!kept   // claim-time property: this topic should survive handoffs
      const eDesc = description || (kept && kept.description) || ''
      const eIcon = icon || (kept && kept.icon) || null
      const eAnnounce = a.announce_offline != null ? announce_offline : !!(kept && kept.announce_offline)
      const k = `${holder}|owner|${patternKey(topic)}`
      const reclaim = myTopics.has(k)
      myTopics.set(k, { pattern: topic, role: 'owner', description: eDesc, exclusive, icon: eIcon, holder, holder_name: holderName, project: holderProject, realm: holderRealm,
        announce_offline: eAnnounce, grace_minutes, allow_other_user, keep_alive,
        claimed_at: reclaim ? myTopics.get(k).claimed_at : new Date().toISOString() })
      if (persistent) await persistClaim(holderIdentity, holderProject, topic, myTopics.get(k))   // §12: durable responsibility (awaited so a later release reliably sees + removes it)
      // #26: a (re)claim of a kept-alive topic drains its ownerless parked queue to the new owner and clears the marker.
      let drained = 0
      if (kept) {
        try {
          const tident = topicMailIdent(kept.realm || holderRealm, holderProject, topic)
          for (const p of await persistence.mailbox.drain(tident)) {
            if (!p.record || !p.record.id) continue
            await routeEnvelope({ ...p.record, to: holder }); await persistence.mailbox.ack(tident, p.record.id); drained++
          }
        } catch { }
        reminders.inherit(holder, holderIdentity, topic, kept.behaviors)   // #29: new owner inherits the topic's reminders
        persistence.keptTopics.remove(holderProject, topic).catch(() => {})
        if (drained) emitTraceRaw({ dir: 'recv', verb: 'rehydrate', from: holder, from_name: holderName, to: SESSION, size: drained, note: `${drained} parked message(s) delivered on reclaim of kept-alive "${topic}"`, envelope_id: null })
      }
      announceTopics()
      emitTraceRaw({ dir: 'con', verb: 'claim', from: holder, from_name: holderName, to: SESSION, size: 0,
        note: `${reclaim ? 're-claimed' : 'claimed'} "${topic}"${exclusive ? ' (exclusive)' : ''}${persistent ? ' [durable]' : ''}${keep_alive ? ' [keep-alive]' : ''}${eIcon ? ' ' + eIcon : ''}`, envelope_id: null })
      return ok({ ok: true, topic, holder, exclusive, icon: eIcon, persistent: persistent || undefined, keep_alive: keep_alive || undefined, reclaimed: reclaim || undefined, ...(drained ? { drained } : {}) })
    }
    case 'release_topic': {
      const topic = String(a.topic || '').trim()
      let holder = SESSION, holderName = NAME, holderProject = PROC_IDENT?.project || 'unclassified', holderIdentity = pIdent(PROC_IDENT, HOSTNAME)
      if (a.as) {
        const { sp, err } = authSub(String(a.as), a.secret)
        if (err) return ok(err)
        holder = sp.id; holderName = sp.name; holderProject = sp.identity?.project || 'unclassified'; holderIdentity = pIdent(sp.identity, sp.name)
      }
      const k = `${holder}|owner|${patternKey(topic)}`
      if (!myTopics.has(k)) return ok({ ok: false, code: 'not-held', topic, holder })
      const rec = myTopics.get(k)
      // #26: keep the topic ALIVE (ownerless) after release if the caller asks OR the claim was marked keep_alive —
      // so directed sends PARK against it until reclaimed, instead of bouncing no-owner during a handoff. Only when
      // no OTHER live owner remains for it in this project (a shared co-owner means it's still owned).
      const keepAlive = (a.keep_alive != null ? !!a.keep_alive : !!rec.keep_alive)
        && !allTopicEntries().some(e => e.role === 'owner' && e.holder !== holder && projKey(e.project) === projKey(holderProject) && patternKey(e.pattern) === patternKey(topic))
      myTopics.delete(k)
      // AWAIT both the durable claim removal AND the marker write (not fire-and-forget): a handoff often sends to
      // the topic immediately after release, and that send must see NO dormant claim (else it parks to the
      // just-released owner) and DOES see the kept-alive marker (so it parks ownerless rather than bouncing no-owner).
      if (PERSIST && holderIdentity) { try { await persistence.claims.remove(holderProject, topic, holderIdentity) } catch { } }   // §12: drop durable responsibility
      if (PERSIST && keepAlive) {
        // #29: topic-scoped behaviour reminders for THIS topic ride along to the next owner via the kept marker
        const topicBeh = reminders.topicBehaviors(holder, topic)
        try { await persistence.keptTopics.put(holderProject, topic, { realm: rec.realm || REALM, description: rec.description, icon: rec.icon, exclusive: rec.exclusive, announce_offline: rec.announce_offline, behaviors: topicBeh }) } catch { }
      }
      announceTopics()
      emitTraceRaw({ dir: 'con', verb: 'release', from: holder, from_name: holderName, to: SESSION, size: 0,
        note: `released "${topic}"${keepAlive ? ' [kept alive — sends park until reclaimed]' : ''}`, envelope_id: null })
      return ok({ ok: true, topic, holder, ...(keepAlive ? { kept_alive: true } : {}) })
    }
    case 'subscribe': {
      const pattern = String(a.pattern || '').trim()
      if (!pattern) return ok({ ok: false, code: 'pattern-required' })
      let holder = SESSION, holderName = NAME, holderProject = PROC_IDENT?.project || 'unclassified', holderRealm = REALM, holderIdentity = pIdent(PROC_IDENT, HOSTNAME)
      if (a.as) {
        const { sp, err } = authSub(String(a.as), a.secret)
        if (err) return ok(err)
        holder = sp.id; holderName = sp.name; holderProject = sp.identity?.project || 'unclassified'; holderRealm = sp.identity?.realm || REALM; holderIdentity = pIdent(sp.identity, sp.name)
      }
      const k = `${holder}|subscriber|${patternKey(pattern)}`
      const existed = myTopics.has(k)
      myTopics.set(k, { pattern, role: 'subscriber', holder, holder_name: holderName, project: holderProject, realm: holderRealm,
        claimed_at: existed ? myTopics.get(k).claimed_at : new Date().toISOString() })
      if (PERSIST_SUBS && holderIdentity) persistence.subscriptions.put(holderIdentity, pattern, {}).catch(() => {})   // §20: durable interest, rehydrated on re-register
      announceTopics()
      if (!existed) emitTraceRaw({ dir: 'con', verb: 'subscribe', from: holder, from_name: holderName, to: SESSION, size: 0,
        note: `subscribed "${pattern}"`, envelope_id: null })
      if (PERSIST && !existed) {   // §12 retain: catch the NEW subscriber up on retained values it matches
        try {
          const rl = await persistence.retained.allForProject(holderProject)
          let n = 0
          for (const { topic: rt, record } of rl) {
            if (!record || !record.env || !rt || !topicMatch(pattern, rt)) continue
            const env0 = record.env
            const env = makeEnvelope({ to: holder, verb: env0.verb, body: plainBody(env0), from: env0.from, subject: env0.subject, pattern: 'publish', topic: rt })
            env.retained = true
            await routeEnvelope(env); n++
          }
          if (n) emitTraceRaw({ dir: 'send', verb: 'message', from: SESSION, from_name: NAME, to: holder, to_name: holderName, to_kind: 'subpeer', subject: `retained catch-up (${n})`, pattern: 'publish', size: 0, note: `${n} retained value(s) delivered on subscribe`, envelope_id: null })
        } catch { }
      }
      return ok({ ok: true, pattern, holder, resubscribed: existed || undefined })
    }
    case 'unsubscribe': {
      const pattern = String(a.pattern || '').trim()
      let holder = SESSION, holderIdentity = pIdent(PROC_IDENT, HOSTNAME)
      if (a.as) {
        const { sp, err } = authSub(String(a.as), a.secret)
        if (err) return ok(err)
        holder = sp.id; holderIdentity = pIdent(sp.identity, sp.name)
      }
      const k = `${holder}|subscriber|${patternKey(pattern)}`
      if (!myTopics.has(k)) return ok({ ok: false, code: 'not-subscribed', pattern, holder })
      myTopics.delete(k)
      if (PERSIST_SUBS && holderIdentity) persistence.subscriptions.remove(holderIdentity, pattern).catch(() => {})   // §20: drop durable interest
      announceTopics()
      return ok({ ok: true, pattern, holder })
    }
    case 'publish': {
      if (!String(a.subject || '').trim()) return ok({ ok: false, code: 'subject-required' })
      const subject = String(a.subject).trim()
      let from, fromIdentity = pIdent(PROC_IDENT, HOSTNAME)
      if (a.as) {
        const { sp, err } = authSub(String(a.as), a.secret)
        if (err) return ok(err)
        from = { session: sp.id, name: sp.name, kind: 'subpeer' }
        fromIdentity = pIdent(sp.identity, sp.name)
      }
      const ref = String(a.topic || '').trim()
      const r = await publishToTopic(from, ref, a.verb, a.message, subject, askerProjectOf(from))
      const retain = PERSIST && !!a.retain
      if (retain) {   // §12 retain: keep the last event per CONCRETE topic; delivered to a (re)subscriber on subscribe
        const { project, path } = parseTopicRef(ref, askerProjectOf(from), REALM)
        if (path && !isWildcard(path) && fromIdentity) {
          const env = makeEnvelope({ to: `topic:${path}`, verb: a.verb, body: a.message, from, subject, pattern: 'publish', topic: path })
          persistence.retained.put(project, path, fromIdentity, { ts: env.ts, env }).catch(() => {})
        }
      }
      return ok({ ...r, retained: retain || undefined, as: from ? from.session : SESSION })
    }
    case 'allow_project': {
      let me0 = { project: PROC_IDENT?.project, user: PROC_IDENT?.user }
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); me0 = { project: sp.identity?.project, user: sp.identity?.user } }
      if (!me0.project || me0.project === 'unclassified') return ok({ ok: false, code: 'caller-unclassified' })
      if (!a.project) return ok({ ok: false, code: 'project-required' })
      const from = projKey(a.project), to = projKey(me0.project)
      const mode = a.mode === 'bidirectional' ? 'bidirectional' : 'send'
      // §14 TTL: the operator may CAP (shorten) what the requester asked for. Effective = the operator's ttl
      // if given, else the matching pending request's ttl, else forever; with both present, the operator can
      // only shorten. forever is a null expiry.
      const opTtl = parseTtlMin(a.ttl_minutes ?? a.ttl)
      const pend = consent.pendingFor(from, to)
      let reqTtl = null, sawReq = false
      for (const p of pend) if (p.ttlMin != null) { sawReq = true; reqTtl = reqTtl == null ? p.ttlMin : Math.min(reqTtl, p.ttlMin) }
      let effTtl = opTtl != null ? opTtl : (sawReq ? reqTtl : null)
      if (opTtl != null && sawReq) effTtl = Math.min(opTtl, reqTtl)
      const exp = effTtl != null ? Date.now() + effTtl * 60000 : null
      consent.allow(from, to, mode, exp)         // §14: runtime grant + durable copy (survives a restart)
      broadcastRoster()                          // visibility may widen
      emitTraceRaw({ dir: 'con', verb: 'allow', from: me0.project, from_name: me0.user || NAME, to: from, size: 0,
        note: `allow ${from} -> ${me0.project} (${mode}, ${exp ? effTtl + 'm' : 'forever'})`, envelope_id: null })
      // Bug 3: tell the original requester(s) their access landed, echoing request_id + the permitted TTL
      for (const p of pend) {
        consent.deletePending(p.reqId)
        deliverSystemTo(p.requester, 'project_access_granted', JSON.stringify({ to: me0.project, from, mode, request_id: p.reqId, ttl_minutes: effTtl, expires_at: exp ? new Date(exp).toISOString() : null }), `project access granted: ${from} -> ${me0.project}`).catch(() => {})
      }
      return ok({ ok: true, allow: { from, to: me0.project, mode, ttl_minutes: effTtl, expires_at: exp ? new Date(exp).toISOString() : null }, notified: pend.length })
    }
    case 'revoke_project': {
      let myProj = PROC_IDENT?.project
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); myProj = sp.identity?.project }
      const from = projKey(a.project), to = projKey(myProj)
      const had = consent.revoke(from, to)   // §14: drop the runtime grant + its durable edge
      if (had) broadcastRoster()
      return ok({ ok: true, revoked: had, from, to: myProj })
    }
    case 'request_project_access': {
      let me0 = { project: PROC_IDENT?.project, user: PROC_IDENT?.user }, requester = SESSION
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); me0 = { project: sp.identity?.project, user: sp.identity?.user }; requester = sp.id }
      const to = String(a.to || '').trim().toLowerCase()
      if (!to) return ok({ ok: false, code: 'project-required' })
      const ttlMin = parseTtlMin(a.ttl_minutes ?? a.ttl)   // null = requesting forever; the operator can shorten
      const reqId = 'req_' + crypto.randomBytes(5).toString('hex')
      const fromProj = projKey(me0.project || 'unclassified')
      consent.addPending(reqId, { reqId, from: fromProj, to, requester, requesterName: me0.user || NAME, ttlMin, ts: Date.now() })
      const payload = JSON.stringify({ from_project: me0.project || 'unclassified', from_user: me0.user || 'unknown', reason: String(a.reason || ''), request_id: reqId, ttl_minutes: ttlMin })
      const reached = await deliverSystemToProject(to, 'project_access_request', payload)
      return ok({ ok: true, request_id: reqId, to, ttl_minutes: ttlMin, delivered_to: reached })
    }
    case 'set_wake': return ok({ ok: false, code: 'unsupported', what: 'wake (T14 — reserved for the watcher/doorbell feature)' })
    case 'send_to_peer': {
      if (!String(a.subject || '').trim()) return ok({ ok: false, code: 'subject-required' })   // T7: no lazy callers
      if (a.park) return ok({ ok: false, code: 'unsupported', what: 'park (offline delivery, T14)' })
      const subject = String(a.subject).trim()
      let from
      if (a.as) {
        const { sp, err } = authSub(String(a.as), a.secret)
        if (err) return ok(err)
        from = { session: sp.id, name: sp.name, kind: 'subpeer' }
      }
      let target = String(a.target || '')
      if (target.startsWith('topic:')) {                 // topic targeting (T3): explicit prefix only -> owners
        const r = await routeToTopicOwners(from, target.slice(6).trim(), a.verb, a.message, a.reply_to, subject, askerProjectOf(from))
        return ok({ ...r, as: from ? from.session : SESSION })
      }
      if (!roster.has(target) && !ownerOf(target)) {
        const pt = resolvePageTarget(target)
        if (pt) target = pt
      }
      if (!target.startsWith('page:') && !roster.has(target) && !ownerOf(target)) {
        const cand = []
        for (const s of roster.values()) {
          if (ciEq(s.name, target)) cand.push(s.session)
          for (const sp of (s.subpeers || [])) if (ciEq(sp.name, target)) cand.push(sp.id)
        }
        for (const sp of subpeers.values()) if (ciEq(sp.name, target) && !cand.includes(sp.id)) cand.push(sp.id)
        const uniq = [...new Set(cand)]
        if (uniq.length === 1) target = uniq[0]
        else if (uniq.length > 1) return ok({ ok: false, code: 'ambiguous-name', candidates: uniq })
        else {
          // §19: no LIVE peer by this name — if it has a durable registration (offline/gateway-restarted),
          // park for its return; otherwise fall through to a clear unknown-target.
          const parked = await parkToOfflineName(from, target, a.verb, a.message, a.reply_to, subject, askerProjectOf(from))
          if (parked) return ok({ ...parked, as: from ? from.session : SESSION })
        }
      }
      const env = makeEnvelope({ to: target, verb: a.verb, body: a.message, reply_to: a.reply_to, from, subject })
      const r = await routeEnvelope(env)
      return ok({ ...r, envelope_id: env.id, to: target, as: from ? from.session : SESSION })
    }
    case 'inbox': {
      if (a.for) {
        const { sp, err } = authSub(String(a.for), a.secret)
        if (err) return ok(err)
        const q = subQueues.get(sp.id)
        await syncDurableMailbox(sp)   // §23: surface any out-of-band parked mail before serving
        const cur = Number(a.cursor || 0)
        const start = Math.min(Math.max(cur - q.base, 0), q.items.length)
        const next = q.base + q.items.length
        q.served = Math.max(q.served || 0, next)
        // §12/#34: drop the durable copy ON SERVE (the messages being returned now), NOT on the next cursor
        // advance — else a session that reads-then-reattaches (or a fresh register after a restart, which starts
        // a queue at base 0) re-drains the still-undeleted copies and the same mail is redelivered every time.
        if (PERSIST && sp.identity) { const pid = pIdent(sp.identity, sp.name); for (const m of q.items.slice(start)) persistence.mailbox.ack(pid, m.id).catch(() => {}) }
        return ok({ peer_id: sp.id, queue_epoch: q.epoch, next_cursor: next,
          messages: q.items.slice(start).map(e => { const v = decryptedView(e), r = reminders.remindersFor(sp.id, e); return r.length ? { ...v, reminders: r } : v }) })   // #29: attach scoped behaviour reminders
      }
      const cur = Number(a.cursor || 0)
      return ok({ messages: inbox.slice(cur).map(decryptedView), next_cursor: inbox.length })
    }
    case 'set_behavior': {   // #29: register a 'how to behave when a message arrives' reminder for a scope
      let holder = SESSION, holderIdentity = pIdent(PROC_IDENT, HOSTNAME)
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); holder = sp.id; holderIdentity = pIdent(sp.identity, sp.name) }
      return ok(reminders.set(holder, holderIdentity, a.scope, a.match, a.behavior))
    }
    case 'list_behaviors': {
      let holder = SESSION
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); holder = sp.id }
      return ok({ ok: true, behaviors: reminders.list(holder) })
    }
    case 'clear_behavior': {   // omit scope to clear ALL; else clear the one (scope + match)
      let holder = SESSION, holderIdentity = pIdent(PROC_IDENT, HOSTNAME)
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); holder = sp.id; holderIdentity = pIdent(sp.identity, sp.name) }
      return ok(reminders.clear(holder, holderIdentity, a.scope, a.match))
    }
    default: {
      // #33 services layer: route a service-contributed tool to its handle(), with the caller's resolved
      // identity (project) so the service can enforce its own consent (e.g. egress's per-backend allowlist).
      const svc = serviceHandlers.get(req.params.name)
      if (svc) {
        let caller = { project: PROC_IDENT?.project || 'unclassified', holder: SESSION, name: NAME }
        if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); caller = { project: sp.identity?.project || 'unclassified', holder: sp.id, name: sp.name } }
        return ok(await svc.handle(req.params.name, a, caller))
      }
      throw new Error(`unknown tool: ${req.params.name}`)
    }
  }
})

mcp.oninitialized = () => {
  try {
    const ci = mcp.getClientVersion ? mcp.getClientVersion() : null
    const caps = mcp.getClientCapabilities ? mcp.getClientCapabilities() : null
    const channelCapable = !!(caps && caps.experimental && Object.prototype.hasOwnProperty.call(caps.experimental, 'claude/channel'))
    const looksLikeCode = /code/i.test(String(ci?.name || ''))
    const detected = channelCapable || looksLikeCode ? 'push' : 'poll'
    CLIENT = { name: ci?.name || null, version: ci?.version || null,
      channel_capable: channelCapable, detected_mode: detected, mode: MODE_OVERRIDE || detected }
    log(`client connected: ${CLIENT.name}@${CLIENT.version} mode=${CLIENT.mode}${MODE_OVERRIDE ? ' (override)' : ''}`)
    emitTraceRaw({ dir: 'info', verb: 'client-connect', from: SESSION, from_name: NAME, to: SESSION, size: 0, envelope_id: null,
      note: `client=${CLIENT.name || '?'}@${CLIENT.version || '?'} channel=${channelCapable} mode=${CLIENT.mode}${MODE_OVERRIDE ? ' (override)' : ''}` })
    if (role === 'gateway') { const r = roster.get(SESSION); if (r) { r.client = CLIENT.name; r.client_kind = clientKind(CLIENT.name); broadcastRoster() } }
    else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'SET_CLIENT', session: SESSION, client: CLIENT.name })
    if (PERSIST && PROC_IDENT && !procClaimsRehydrated) {   // §12: restore this session's OWN claims (re-keyed to the new SESSION id)
      procClaimsRehydrated = true
      persistence.claims.byHolder(pIdent(PROC_IDENT, HOSTNAME)).then(dc => {
        let n = 0; for (const rec of dc) if (rehydrateClaim(rec, SESSION, NAME, pIdent(PROC_IDENT, HOSTNAME))) n++
        if (n) { announceTopics(); emitTraceRaw({ dir: 'con', verb: 'rehydrate', from: SESSION, from_name: NAME, to: SESSION, size: n, note: `${n} responsibility(ies) restored`, envelope_id: null }) }
      }).catch(() => {})
    }
  } catch (e) { log('client-detect failed', e.message) }
}

await mcp.connect(new StdioServerTransport())
process.on('SIGTERM', () => { role = 'stopping'; process.exit(0) })
process.on('SIGINT', () => { role = 'stopping'; process.exit(0) })
