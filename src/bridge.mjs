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
import { procCapKeyInput, pageCapKeyInput } from './lib/capkeys.js'
import { createConsent, parseTtlMin } from './lib/consent.js'
import { createReminders } from './lib/reminders.js'
import { createRealmDefaults, realmFromConfig } from './lib/realm-defaults.js'
import { createProjectNames } from './lib/project-names.js'
import { createRetainedSet, envBytes, RETAIN_REPLICATE_MAX_BYTES, RETAIN_GOSSIP_MAX_BYTES } from './lib/retained.js'
import { createTraces } from './lib/traces.js'
import * as Act from './lib/activity.js'
import { create as createEgress } from './services/egress.js'

// ---------------------------------------------------------------- config / identity
const HERE = path.dirname(fileURLToPath(import.meta.url))
// The config file is config.json beside this script unless env AI_BRIDGE_CONFIG names another path (absolute, or
// relative to the working directory; a leading `~` expands to the home dir) — e.g. to run several bridges from one
// checkout with different configs (tests), or to keep the config outside the code folder. The live-reload watch
// (facets/config/file.js) and the alias write-back follow the same path.
const CONFIG_FILE = process.env.AI_BRIDGE_CONFIG
  ? path.resolve(process.env.AI_BRIDGE_CONFIG.startsWith('~') ? path.join(os.homedir(), process.env.AI_BRIDGE_CONFIG.slice(1)) : process.env.AI_BRIDGE_CONFIG)
  : path.join(HERE, 'config.json')
let CFG = {}
try { CFG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch {}
const PORT = Number(process.env.AI_BRIDGE_PORT || CFG.port || 12317)     // default moved off 7000: macOS Control Center AirPlay Receiver binds *:7000, so bind 0.0.0.0 there fails EADDRINUSE (MacDaddy). 12317/12318 are clear on macOS/Windows/Linux.
const WS_PORT = Number(process.env.AI_BRIDGE_WS_PORT || CFG.wsPort || 12318)
// One well-known control port (+ ws port) per host, shared by the whole realm: cross-host discovery hands each
// candidate the dialer's OWN port. (#57's transitional compatPorts/compatWsPorts were removed in v1.46.0 (#59)
// once every host had migrated to 12317/12318; a leftover key in a live config.json is simply ignored.)
// #46: read the realm token from a FILE when AI_BRIDGE_TOKEN_FILE is set, so an MCP client config can
// reference a PATH (harmless in `ps`/argv) instead of inlining the secret VALUE into the command line — argv
// is world-readable via the process list and captured by crash dumps / monitors / support bundles, and the
// realm token is both the membership gate AND the body-encryption key. Precedence: an explicit
// AI_BRIDGE_TOKEN value > AI_BRIDGE_TOKEN_FILE contents > config.json token. The file may be a bare token or a
// KEY=VALUE env file (e.g. ~/.aimb/bridge.env) — a leading `~` expands to the home dir.
function readTokenFile(p) {
  try {
    const resolved = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
    const raw = fs.readFileSync(resolved, 'utf8')
    const m = raw.match(/^\s*AI_BRIDGE_TOKEN\s*=\s*(.+?)\s*$/m)   // accept an env-file line, else the whole (trimmed) file
    return (m ? m[1] : raw).trim()
  } catch { return '' }
}
const TOKEN = process.env.AI_BRIDGE_TOKEN
  || (process.env.AI_BRIDGE_TOKEN_FILE ? readTokenFile(process.env.AI_BRIDGE_TOKEN_FILE) : '')
  || CFG.token || ''
const HOST = '127.0.0.1'                                                  // loopback: same-machine pair-dial + local-gateway connect
const BIND = process.env.AI_BRIDGE_BIND || CFG.bind || HOST               // interface to LISTEN on (0.0.0.0 / tailnet IP enables cross-host, §7)
let ADVERTISE = process.env.AI_BRIDGE_ADVERTISE_HOST || CFG.advertiseHost || (BIND && BIND !== '0.0.0.0' ? BIND : HOST)   // address peers DIAL me at (auto-derived from the discovery facet if left as loopback — §7)
const ADVERTISE_AUTO = !(process.env.AI_BRIDGE_ADVERTISE_HOST || (CFG && CFG.advertiseHost))   // no explicit advertise ⇒ may fill it from discovery.selfHost()
const DISCOVERY_MS = Number(process.env.AI_BRIDGE_DISCOVERY_MS || 5000)   // cross-host peer-hub discovery cadence (§7)
const VER = 1
const MODE_OVERRIDE = (process.env.AI_BRIDGE_MODE || CFG.mode || '') || null   // 'push' | 'poll' | null
const SWEEP_MS = Number(process.env.AI_BRIDGE_SWEEP_MS || 60000)
// #40 two-phase rollout. This bridge ALWAYS *reads* stable `peer:` ids; whether it *mints* them is opt-in.
// Compatibility is one-way — a pre-1.26 bridge cannot parse a `peer:` id — so phase 1 (default) ships the
// reader everywhere with zero coordination, and phase 2 flips minting on once every host is on 1.26+.
// Never enable this while any host in the realm is older than 1.26.0.
// env wins BOTH ways ('1' forces on, '0' forces off) so a test or a one-off run is deterministic regardless
// of what the operator's config.json happens to say; config is the fallback.
const STABLE_IDS = process.env.AI_BRIDGE_STABLE_IDS === '1' ? true
  : process.env.AI_BRIDGE_STABLE_IDS === '0' ? false
  : CFG.stableIds === true
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
    const p = CONFIG_FILE
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
    cfg.aliases = ALIASES
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
  } catch (e) { log('alias persist failed', e.message) }
}

const BRIDGE_VERSION = '1.62.0'           // bump on every behavioural change; surfaced in my_identity,
                                           // roster entries and the page welcome so peers can detect a changed bridge
// T14 feature detection. `wake` stays FALSE — the set_wake tool is still unsupported; `doorbell` (#39) is
// the WS `listener` attach point, which IS implemented and needs nothing durable to work.
// `stable_ids_read` is true on every 1.26+ bridge (it can RESOLVE a `peer:` id); `stable_ids_write` says
// whether it MINTS them. The split is the rollout gate: confirm read===true on every host in the realm
// (the dashboard surfaces it) BEFORE enabling write anywhere. #40.
// `recover_secret` / `presence_confirm` (#41) report VERIFIED capability, not configuration: `profile.names`
// says which facet the operator asked for, these say whether the platform can actually back it. They start
// FALSE and are raised only once a startup probe succeeds — never claim a capability we haven't checked,
// because the failure mode being fixed is a peer trusting `profile.vault = "tpm"` on a box with no TPM and
// only finding out when recovery is needed.
const CAPS = { wake: false, doorbell: true, park: false, retain: false, persistent_claims: false,
  stable_ids_read: true, stable_ids_write: STABLE_IDS, recover_secret: false, presence_confirm: false }
// AI_BRIDGE_TEST_HOSTNAME (test-only, v1.60.0): two loopback "hosts" on one machine need distinct host names — #70 step 4
// keys activity by host (the gateway session's hostname prefix is the origin a peer link speaks for)
const SESSION = `${process.env.AI_BRIDGE_TEST_HOSTNAME || os.hostname()}/${crypto.randomBytes(4).toString('hex')}`
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
const ctx = { TOKEN, REALM, CFG, HERE, CONFIG_FILE, SESSION, PORT, ADVERTISE, env: process.env, log }
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
// #62: runtime grants replicate mesh-wide as a last-writer-wins set (see lib/consent.js + announceGrants /
// gossipFrame / the GRANTS frame below); `origin` tags the records this process writes, and a revoke's tombstone
// is forgotten after AI_BRIDGE_GRANT_TOMBSTONE_TTL_MS (default 30 days).
const consent = createConsent({ persistence, persist: PERSIST, origin: SESSION,
  tombstoneTtlMs: Number(process.env.AI_BRIDGE_GRANT_TOMBSTONE_TTL_MS) || 30 * 86400000 })
const computeOpen = pol => process.env.AI_BRIDGE_OPEN === '1' || String((pol && pol.default) || 'strict') === 'open'
consent.setPolicy((CFG.projects && typeof CFG.projects === 'object') ? CFG.projects : { default: 'strict', allow: [] }, computeOpen(CFG.projects))
// live-reload via the ConfigSource facet: a synced edit to the policy propagates without a restart (the
// bridge only READS config). Realm/token changes still need a restart. fs.watchFile polls — cross-platform.
profile.config.watch(c => {
  if (c && c.projects && typeof c.projects === 'object') { consent.setPolicy(c.projects, computeOpen(c.projects)); log('project policy reloaded from config') }
  reminders.setDefaults(defaultBehaviors(c))   // #29: default behaviour reminders are live-reloadable too
  if (seedRealmDefaults(c, 'reload')) announceRealmDefaults()   // #66b: a newer behaviors.realm block spreads mesh-wide
})
await consent.rehydrate()   // §14: durable grants survive a restart
setInterval(() => consent.gc(), Number(process.env.AI_BRIDGE_GRANT_GC_MS) || 600000).unref()   // §14: sweep expired grants + stale pending requests
const CAP_TTL_MS = Number(process.env.AI_BRIDGE_CAP_TTL_MS) || 30 * 60000   // reply_exp stamp horizon (informational since Decision B; no longer gates delivery — see verifyReplyCap). Env-overridable for tests.
// #43: was capKeyFrom(SESSION) — SESSION is RANDOM per process (so a reply-cap died on restart, breaking
// Decision B's "a valid cap always gets through") and PUBLIC (published in the roster and every envelope,
// so anyone who could read the roster could recompute this key and mint a cap that bypasses the consent
// check). Now derived from the process IDENTITY + the realm token. See lib/capkeys.js.
const PROC_CAPKEY = capKeyFrom(procCapKeyInput({ token: TOKEN, realm: REALM, project: PROC_PROJECT, user: PROC_USER, host: HOSTNAME }))
function localCapKey(sessionId) {                  // reply-cap signing key for a LOCAL participant
  if (sessionId === SESSION) return PROC_CAPKEY
  const sp = subpeers.get(sessionId); if (sp) return sp.capKey
  if (String(sessionId).startsWith('page:')) { const p = pages.get(String(sessionId).slice(5)); return p ? p.capKey : null }
  return null
}
function projectOfTarget(to) {                     // resolve a target id's project from local state + roster
  if (to === SESSION) return PROC_IDENT?.project || 'unclassified'
  if (subpeers.has(to)) return subpeers.get(to).identity?.project || 'unclassified'
  if (String(to).startsWith('page:')) { const p = pageEntry(String(to).slice(5)); return p?.identity?.project || p?.project || 'unclassified' }   // #66d: remote pages carry a bare project
  if (roster.has(to)) return roster.get(to).project || 'unclassified'
  if (String(to).startsWith('peer:')) { const hit = rosterSub(to); return hit ? (hit.sp.project || 'unclassified') : null }
  const owner = roster.get(String(to).split('/').slice(0, 2).join('/'))   // legacy id: session is embedded
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
  // #71: the cap binds the two projects by projKey (minted that way in makeEnvelope), so a replier that re-registered
  // in another case ("Beta" -> "BETA") still gets its reply through. The declared-case form is still accepted: a cap
  // minted by a ≤1.56 process (an identity-derived capKey outlives the process, #43) was bound to the raw spellings.
  return profile.capSigner.verify(targetCapKey, env.reply_cap, `${projKey(toProject)}|${projKey(fromProject)}|${env.reply_to}|${exp}`)
    || profile.capSigner.verify(targetCapKey, env.reply_cap, `${toProject}|${fromProject}|${env.reply_to}|${exp}`)
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
let gwServer = null               // gateway: the :PORT control server
let wss = null                    // gateway: WS leaf server (on :WS_PORT)
let roster = new Map()            // session -> {session, name, port, kind:'session', subpeers:[], client}
let pages = new Map()             // instance -> {instance, page_kind, title, kind:'page'}  (gateway only)
let backoff = 200
let gatewayId = null             // session id of the current gateway (both roles)

const inbox = []                  // process inbox: delivered envelopes (cursor = index)
const seen = new Set()            // envelope dedupe (LRU-ish)
const followers = new Map()       // gateway: session -> control socket
const followerRetainedV = new Map()   // gateway: follower session -> the retained-set version it last got (#66c)
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
  if (typeof d === 'string') out.push({ operation: 'receive', scope: 'all', match: null, behavior: d })
  else if (Array.isArray(d)) for (const x of d) if (x && x.behavior) out.push({ operation: x.operation || 'receive', scope: x.scope, match: x.match, behavior: x.behavior })   // #44: config default may name an operation (#47: 'deliver' still folds to 'receive' in setDefaults)
  if (process.env.AI_BRIDGE_DEFAULT_BEHAVIOR) out.push({ operation: 'receive', scope: 'all', match: null, behavior: process.env.AI_BRIDGE_DEFAULT_BEHAVIOR })
  return out
}
// #44: the reminders whose OPERATION+subject match a bridge action, attached to that action's RESPONSE. `subject`
// carries the fields a scope can test — { project?, topic?, host? }. Returns undefined when there's nothing (so a
// caller can `...(opReminders(...) ? {reminders} : {})`). `receive` reminders ride the message itself, not this.
function opReminders(holderId, operation, subject) {
  if (!holderId) return undefined
  const rems = reminders.remindersFor(holderId, { operation, ...(subject || {}) })
  return rems.length ? rems : undefined
}
// #67: tell a session WHERE the doorbell is. Agents often don't know the script's path (and on macOS `node` may not
// be on PATH for a non-login shell), so a connect reminder may carry placeholders the bridge fills at EMIT time —
// {doorbell_cmd} {doorbell_path} {node} {name} {project} — from THIS bridge's own location, so each host hands out
// its own correct path. Forward slashes (node accepts them; the command runs from bash everywhere, Git Bash
// included) and double-quoted paths (they contain spaces). Unknown {tokens} are left untouched; the STORED reminder
// is never modified.
const DOORBELL_PATH = path.join(HERE, 'tools', 'aimb-doorbell.mjs').replace(/\\/g, '/')
const NODE_PATH = process.execPath.replace(/\\/g, '/')
const dq = v => `"${String(v).replace(/"/g, '\\"')}"`
function doorbellCmd(name, project) {
  return `${dq(NODE_PATH)} ${dq(DOORBELL_PATH)} --name ${dq(name)}` + (project ? ` --project ${dq(project)}` : '')
}
function expandPlaceholders(text, name, project) {
  const vars = { doorbell_cmd: doorbellCmd(name, project), doorbell_path: DOORBELL_PATH, node: NODE_PATH, name, project: project || '' }
  return String(text).replace(/\{(\w+)\}/g, (m, k) => Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m)
}
// register_self's connect_reminders (#64), placeholder-expanded for the registering session (#67).
function connectReminders(sp) {
  return (opReminders(sp.id, 'connect', { client_kind: sp.client_kind }) || [])
    .map(r => ({ ...r, behavior: expandPlaceholders(r.behavior, sp.name, sp.identity?.project) }))
}
// the context an ARRIVING message presents to the reminder matcher (operation 'receive' — matches the SENDER).
function receiveCtx(id, env) {
  return { operation: 'receive', project: env.from?.project, host: String(env.from?.session || '').split('/')[0],
    topic: env.topic, fromSelf: env.from?.session === id, system: !!env.system }
}
reminders.setDefaults(defaultBehaviors(CFG))
// #66b: REALM-WIDE default reminders — one replicated last-writer-wins record (lib/realm-defaults.js), published by
// writing a `behaviors.realm` block { updated_at, default:[...] } in ANY host's config. Each bridge seeds its local
// candidate from its own config (start + live-reload); the winner rides PEER_ROSTER / ROSTER as `realm_defaults` and
// goes up from a follower in a REALM_DEFAULTS frame. The reminders module layers it UNDER this host's own
// behaviors.default (a local entry wins its (operation,scope,match) key; realm entries are tagged realm:true).
const realmDefaults = createRealmDefaults({ persistence, persist: PERSIST, writer: HOSTNAME,
  onChange: r => reminders.setRealmDefaults(r ? r.default : []) })
function seedRealmDefaults(cfg, why) {
  if (!(cfg && cfg.behaviors && cfg.behaviors.realm)) return false
  const cand = realmFromConfig(cfg, HOSTNAME)
  if (!cand) { log(`behaviors.realm ignored (${why}): it needs an explicit "updated_at" ISO timestamp`); return false }
  const changed = realmDefaults.merge(cand)
  if (changed) log(`realm default reminders adopted from this host's config (${why}; updated_at ${new Date(cand.updated_at).toISOString()})`)
  return changed
}
await realmDefaults.rehydrate()   // the latest record this host learned survives a restart (when persistence is on)
seedRealmDefaults(CFG, 'startup')
// #71: ONE canonical DISPLAY spelling per project, mesh-wide — the first-seen spelling (lib/project-names.js). Matching
// stays projKey (case-insensitive) everywhere; this only maps what is SHOWN (allow/access/grant notices, list_sessions,
// my_identity, register_self, topic results, the dashboard). Sightings: a registration, a page, this bridge's own
// identity, a grant naming a project, and (on a gateway) every roster entry — so a ≤1.56 host's sessions get a spelling
// too. The map rides PEER_ROSTER / ROSTER as `project_names` and goes up from a follower in a PROJECT_NAMES frame;
// identities, persistence keys and the roster the wire carries keep the declared spelling.
const projectNames = createProjectNames({ persistence, persist: PERSIST, writer: HOSTNAME })
await projectNames.rehydrate()   // the spellings this host knew survive a restart (when persistence is on)
if (PROC_IDENT) projectNames.note(PROC_IDENT.project)
const projName = p => projectNames.display(p)
const displayIdent = i => (i && typeof i === 'object') ? { ...i, project: projName(i.project) } : i   // a display COPY — never the stored identity
const accessOf = p => { const r = consent.reachable(p); return Array.isArray(r) ? r.map(projName) : r }   // consent keys are projKey'd; show the canonical spelling
// #66c: RETAINED topic values replicate mesh-wide as a last-writer-wins set keyed by (realm, project, topic) — see
// lib/retained.js. Every process holds the set in RAM (so a gateway without persistence still relays it), rides it on
// PEER_ROSTER / ROSTER as `retained` (only to a link/follower that hasn't had the current version — it can be MBs) and
// sends a follower's own publishes UP in a RETAINED frame; what a process LEARNS it persists (when persistence is on),
// and the subscribe-time catch-up reads the store AND the set. A value over RETAIN_MAX_BYTES stays on the publishing
// host and replicates as a too-large marker instead. TTL = the store's retainedTtlDays (default 14), from publish time.
const RETAIN_MAX_BYTES = Number(process.env.AI_BRIDGE_RETAIN_REPLICATE_MAX_BYTES) || RETAIN_REPLICATE_MAX_BYTES
const retainedSet = createRetainedSet({ persistence, persist: PERSIST, writer: HOSTNAME, realm: REALM,
  ttlMs: persistence.limits.retainedTtlMs || 14 * 86400000, maxBytes: RETAIN_MAX_BYTES,
  gossipMaxBytes: Number(process.env.AI_BRIDGE_RETAIN_GOSSIP_MAX_BYTES) || RETAIN_GOSSIP_MAX_BYTES, log })
await retainedSet.rehydrate()   // own + learned values survive a restart, and are re-gossiped even if their publisher is gone
setInterval(() => retainedSet.gc(), Number(process.env.AI_BRIDGE_RETAIN_GC_MS) || 600000).unref()   // age out expired values

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
  if (s.startsWith('page:')) { const p = pageEntry(s.slice(5)); return p ? (p.title || p.page_kind) : s }
  if (roster.has(s)) return roster.get(s).name
  if (subpeers.has(s)) return subpeers.get(s).name
  if (s.startsWith('peer:')) { const hit = rosterSub(s); return hit ? hit.sp.name : s.slice(5).replace(/-[0-9a-f]{8}$/, '') }
  const owner = roster.get(s.split('/').slice(0, 2).join('/'))   // legacy id: session is embedded
  if (owner) { const sp = (owner.subpeers || []).find(x => x.id === s); if (sp) return sp.name }
  return s.split('/').pop()
}
function kindOf(id) {
  const s = String(id || '')
  if (s.startsWith('page:')) return 'page'
  return (s.startsWith('peer:') || s.split('/').length >= 3) ? 'subpeer' : 'session'   // peer: = stable id, 3-segment = legacy
}
// --- stable peer ids (#40). A sub-peer id used to embed the MINTING PROCESS (`HOST/<session>/<name>-<rand>`,
// session = randomBytes at startup), so the id died with that process: it rotated on every restart and, because
// a bridge's lifetime is its MCP client's, often BETWEEN TURNS — any stored id went stale and id-addressed sends
// failed. The id is now derived from the peer's IDENTITY — the same (realm, project, user, name) tuple the
// DURABLE layer already keys by, which is why topics and parked mail always rehydrated correctly while the live
// id did not. WHICH process currently hosts a peer becomes a roster lookup instead of a substring of the id, so
// the peer can move process (or machine) without changing identity. The `peer:` prefix follows the existing
// `page:` convention, keeping kindOf a prefix test rather than segment-counting.
const slugOf = n => String(n || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'peer'
function stablePeerId(ident, name) {
  const key = `${ident?.realm || REALM}|${projKey(ident?.project || '')}|${lc(ident?.user || '')}|${lc(name || '')}`
  return `peer:${slugOf(name)}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)}`
}
/** Locate a sub-peer anywhere on the roster by id — stable ids carry no routing info BY DESIGN, so the
 *  owning session is looked up rather than parsed out. Returns {session, sp} or null. */
function rosterSub(id) {
  for (const s of roster.values()) { const sp = (s.subpeers || []).find(x => x.id === id); if (sp) return { session: s, sp } }
  return null
}
function emitTrace(dir, env, note) {
  emitTraceRaw({ envelope_id: env.id, from: env.from?.session, from_name: env.from?.name,
    to: env.to, to_name: nameOf(env.to), to_kind: kindOf(env.to),
    subject: env.subject || null, pattern: env.pattern || 'send', topic: env.topic || null,
    topic_icon: env.topic ? iconOf(env.topic, env.from?.project || 'unclassified') : null,
    ...(env.from_topic ? { from_topic: env.from_topic, from_topic_icon: env.from_topic_icon || null } : {}),   // #54
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
// "is this one of MY sub-peers?" — authoritative via the local map. The legacy prefix test is kept as a
// fallback for old `HOST/<session>/<name>` ids; a stable `peer:` id (#40) carries no session, by design.
function isLocalSubId(id) { return typeof id === 'string' && (subpeers.has(id) || id.startsWith(SESSION + '/')) }
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
// --- waiting-mail counts. "Uncollected" = queue items past the served high-water (what a poll would
// return next). Split by how each message was ADDRESSED so the dashboard can badge sessions and topics
// independently: a DIRECT send (env.topic null) counts for the recipient sub-peer only; a TOPIC send
// (env.topic set) counts for that topic only. Both are computed from the holder's own live queue, so a
// message never double-counts and the numbers stay in the process that owns the truth.
function unreadItems(spId) {
  const q = subQueues.get(spId); if (!q) return []
  const start = Math.min(Math.max((q.served || 0) - q.base, 0), q.items.length)
  return q.items.slice(start)
}
function unreadDirect(spId) { let n = 0; for (const e of unreadItems(spId)) if (!(e && e.topic)) n++; return n }
function topicWaiting(holderId, pattern) { let n = 0; for (const e of unreadItems(holderId)) if (e && e.topic && topicMatch(pattern, e.topic)) n++; return n }
function announceSubpeers() {
  // channel_capable = does THIS process's MCP client actually declare the claude/channel capability (i.e. can it
  // really receive push notifications). Attached per sub-peer so the dashboard shows "push" only when push is
  // genuinely live, not merely because the mode was optimistically set to push by the code-name heuristic (#2).
  const chan = !!(CLIENT && CLIENT.channel_capable)
  const list = [...subpeers.values()].map(s => ({ id: s.id, name: s.name, parent: s.parent, kind: 'subpeer', client: s.client || null, client_kind: s.client_kind || null, mode: s.mode || null, channel_capable: chan, project: s.identity?.project || null, user: s.identity?.user || null, realm: s.identity?.realm || REALM, unread_direct: unreadDirect(s.id) }))
  if (role === 'gateway') { const r = roster.get(SESSION); if (r) { r.subpeers = list }; broadcastRoster() }
  else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'SUBPEERS', session: SESSION, subpeers: list })
}
function topicList() { return [...myTopics.values()].map(t => ({ ...t, waiting: topicWaiting(t.holder, t.pattern) })) }
// #41(c): CAPS is mutated AFTER connect (the facet probe runs ~50ms in), but a follower only sent its
// capabilities once, in the REGISTER frame — so the gateway roster kept every follower's stale pre-probe
// value while only the gateway itself re-broadcast. Push an update the same way SUBPEERS/TOPICS do. (If the
// probe finishes before this follower has connected, the REGISTER frame already carries the post-probe CAPS,
// so the two paths together close the window either way.)
function announceCaps() {
  if (role === 'gateway') { const r = roster.get(SESSION); if (r) { r.capabilities = { ...CAPS } }; broadcastRoster() }
  else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'CAPS', session: SESSION, capabilities: CAPS })
}
// #62: a grant/revoke must reach the whole mesh. A gateway re-broadcasts (ROSTER to followers + PEER_ROSTER gossip,
// whose dedupe signature includes the grant set); a follower sends its set UP so its gateway merges + gossips it.
function announceGrants() {
  if (role === 'gateway') broadcastRoster()
  else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'GRANTS', session: SESSION, grants: consent.grantSet() })
}
// #66b: a changed realm-defaults record must reach the whole mesh — same shape as announceGrants.
function announceRealmDefaults() {
  if (role === 'gateway') broadcastRoster()
  else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'REALM_DEFAULTS', session: SESSION, realm_defaults: realmDefaults.current() })
}
// #71: a new project spelling must reach the whole mesh — same shape as announceGrants.
function announceProjectNames() {
  if (role === 'gateway') broadcastRoster()
  else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'PROJECT_NAMES', session: SESSION, project_names: projectNames.list() })
}
function noteProject(name) { if (name && !projectNames.has(name) && projectNames.note(name)) announceProjectNames() }   // a local sighting (registration / page / grant)
// #71 (gateway): every project on the roster — followers', peer hubs', pages' (a ≤1.56 host sends no map) — gets a
// spelling if it has none yet. One timestamp for the batch, so two spellings first seen together tie → the smaller wins.
function noteRosterProjects() {
  const now = Date.now(), fresh = []
  const add = p => { if (p && !projectNames.has(p)) fresh.push({ name: String(p), first_seen: now }) }
  for (const s of roster.values()) { add(s.project); for (const sp of (s.subpeers || [])) add(sp.project) }
  for (const p of [...pages.values(), ...remotePages.values()]) add(p.identity?.project || p.project)
  if (fresh.length) projectNames.merge(fresh)
}
// #71: a DISPLAY copy of a roster payload with every project in its canonical spelling (+ the map itself, for the
// dashboard's persistence view). Only what a caller/leaf is SHOWN — the ROSTER frame to followers stays raw.
function displayRoster(pl) {
  const pj = x => (x && typeof x === 'object' && x.project != null) ? { ...x, project: projName(x.project) } : x
  return { ...pl,
    sessions: (pl.sessions || []).map(s => ({ ...pj(s), ...(s.subpeers ? { subpeers: s.subpeers.map(pj) } : {}), ...(s.topics ? { topics: s.topics.map(pj) } : {}) })),
    pages: (pl.pages || []).map(p => { const q = pj(p); return q && q.identity ? { ...q, identity: displayIdent(q.identity) } : q }),
    project_names: projectNames.names() }
}
// #66c: a retained value published HERE must reach the whole mesh. A gateway re-broadcasts (the set rides ROSTER to
// followers + PEER_ROSTER gossip, whose dedupe signature includes the set's version); a follower sends the changed
// record(s) UP so its gateway merges + spreads them.
function announceRetained(recs) {
  if (role === 'gateway') broadcastRoster()
  else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'RETAINED', session: SESSION, retained: recs || retainedSet.list() })
}
function announceTopics() {
  if (role === 'gateway') { const r = roster.get(SESSION); if (r) { r.topics = topicList() }; broadcastRoster() }
  else if (gwSock && !gwSock.destroyed) sendFrame(gwSock, { t: 'TOPICS', session: SESSION, topics: topicList() })
}
// Waiting counts change on delivery + on poll, not just on register/claim — coalesce a roster re-gossip
// (250ms) so the dashboard badges update live without emitting a frame per message.
let countsTimer = null
function scheduleCounts() {
  if (countsTimer) return
  countsTimer = setTimeout(() => { countsTimer = null; announceSubpeers(); announceTopics() }, 250)
  if (countsTimer.unref) countsTimer.unref()
}
// every topic relationship visible from this bridge: roster (all sessions) + page leaves + local
// not-yet-round-tripped entries. Page subject = shared claim + subscription (T12).
function allTopicEntries() {
  const out = []
  const seenKeys = new Set()
  const add = e => { const k = `${e.holder}|${e.role}|${patternKey(e.pattern)}`; if (!seenKeys.has(k)) { seenKeys.add(k); out.push(e) } }
  for (const s of roster.values()) for (const e of (s.topics || [])) add(e)
  // #66d: pages on OTHER hosts count too (a gateway keeps them in remotePages; a follower's `pages` already holds them,
  // tagged `origin`) — but only those whose owning gateway accepts cross-host page delivery (`page_ingress`, 1.48+).
  // A page on an older gateway is display-only: it can't be reached, so it must not look like a subscriber/owner.
  for (const p of [...pages.values(), ...remotePages.values()]) {
    if (p.origin && !p.page_ingress) continue
    const pp = p.identity?.project || p.project || 'unclassified', pr = p.identity?.realm || p.realm || REALM
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
function isIdentityLive(rec) {   // #71 audit: user + name compared lower-case too (they were exact-case here only), like sameClaimHolder
  const want = `${projKey(rec.project)}|${lc(rec.user)}|${lc(rec.name)}`
  for (const sp of subpeers.values()) if (sp.identity && `${projKey(sp.identity.project)}|${lc(sp.identity.user)}|${lc(sp.name)}` === want) return true
  if (PROC_IDENT && `${projKey(PROC_IDENT.project)}|${lc(PROC_IDENT.user)}|${lc(HOSTNAME)}` === want) return true
  return false
}
// is a durable claim record held by this identity? user is the OS login — compare case-INSENSITIVELY (project
// already is): an older claim recorded under declared "Robin" must match the OS-authenticated "robin", else the
// owner is locked out of its own dormant topic as a phantom "different user". Name is also case-insensitive
// (presented in original case but stored/compared lower-case) so "Bolletta"/"bolletta" re-claim, not conflict.
const claimUserKey = u => String(u || '').trim().toLowerCase()
function sameClaimHolder(rec, ident) {
  return !!(rec && ident) && projKey(rec.project) === projKey(ident.project) && claimUserKey(rec.user) === claimUserKey(ident.user) && ciEq(rec.name, ident.name)
}
// #55: this holder's OWN durable record for exactly `topic` (an unidentifiable legacy record never matches), or null.
// claim_topic uses it as the existing claim when the claim is on disk but not in RAM, so a re-claim patches it.
async function ownDurableClaim(topic, holderIdentity, holderProject) {
  if (!(PERSIST && holderIdentity)) return null
  let recs = []
  try { recs = await persistence.claims.read(holderProject, topic) } catch { return null }
  return recs.find(rec => rec && rec.pattern === topic && rec.user && rec.name && sameClaimHolder(rec, holderIdentity)) || null
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
    if (sameClaimHolder(rec, holderIdentity)) continue  // my own durable claim — a re-claim, not a conflict
    if (isIdentityLive(rec)) continue                   // a live owner — the in-RAM blocker check governs that
    if (!(rec.exclusive || exclusive)) continue         // only exclusive overlaps conflict
    const sameUser = claimUserKey(rec.user) === claimUserKey(holderIdentity.user)
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
    persistent: true,   // reached here only by rehydrating a DURABLE claim, so it is durable by construction
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
// #54: the push-channel meta for an envelope sent on behalf of a topic — flat strings like the rest of the meta; nothing
// at all when absent (so a plain message's meta is unchanged).
function fromTopicMeta(env) {
  return env.from_topic ? { from_topic: String(env.from_topic), ...(env.from_topic_icon ? { from_topic_icon: String(env.from_topic_icon) } : {}) } : {}
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
    const rems = reminders.remindersFor(sp.id, receiveCtx(sp.id, env))   // #29/#44/#47: 'receive' reminders for this message
    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: plainBody(env),
        meta: { from: String(env.from?.session || ''), from_name: String(env.from?.name || ''),
                from_kind: String(env.from?.kind || 'session'), verb: String(env.verb || ''), envelope_id: env.id,
                subject: String(env.subject || ''), pattern: String(env.pattern || 'send'), topic: env.topic || null, ...fromTopicMeta(env),
                for: sp.id, for_name: sp.name, ...(rems.length ? { reminders: rems } : {}) } },
    }).catch(() => {})
  }
  scheduleCounts()   // waiting-mail badge went up
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
  if (added) { emitTraceRaw({ dir: 'recv', verb: 'rehydrate', from: sp.id, from_name: sp.name, to: SESSION, size: added, note: `${added} out-of-band parked message(s) surfaced on poll/reattach`, envelope_id: null }); scheduleCounts() }
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

// ---------------------------------------------------------------- #70 activity board (step 2: the `log` + `activity` tools)
// ONE WRITER PER HOST: this host's GATEWAY owns the activity state and its daily JSONL (activity/<host>/YYYY-MM-DD.jsonl
// under the persist dir, via the persistence facet). A follower authenticates its own sub-peer, then forwards the call UP
// its control link (ACTIVITY frame with a request id → ACTIVITY_R; a timeout and a clear code when there's no gateway).
// A newly elected gateway REPLAYS the host's files (newest first: lib/activity.js createReplay) before it serves a `log`
// call, so it continues the same history. The pure model is lib/activity.js; this section is the I/O around it: config,
// replay, appends + checkpoints (cp/rep), retention, expiry, the memory budget, the gone sweep, the id → offset index.
const ACT_FWD_MS = Number(process.env.AI_BRIDGE_ACTIVITY_FWD_MS) || 5000                // follower → gateway request timeout
const ACT_LOAD_WAIT_MS = Number(process.env.AI_BRIDGE_ACTIVITY_LOAD_WAIT_MS) || 15000   // a `log` call waits this long for a restart replay
const ACT_GC_MS = Number(process.env.AI_BRIDGE_ACTIVITY_GC_MS) || 60000                 // expire() + enforceBudget() cadence
const ACT_RETENTION_MS = Number(process.env.AI_BRIDGE_ACTIVITY_RETENTION_MS) || 86400000   // retention sweep cadence (also at gateway start)
const ACT_INDEX_MAX = Number(process.env.AI_BRIDGE_ACTIVITY_INDEX_MAX) || 100000          // id → (day, offset) entries kept; beyond, a lookup scans the day file
const ACT_PHASE1_MS = Number(process.env.AI_BRIDGE_ACTIVITY_PHASE1_MS) || 300            // a long replay publishes a provisional board after this
const LOG_FIELDS = [...Act.MESSAGE_FIELDS, 'items', 'plan']   // v1.62.0 (#70 step 6a): + path (the node tree) + items (a batch); plan is 6b (answered not-yet)
const ACT_TAP = process.env.AI_BRIDGE_TEST_ACTIVITY_TAP === '1'   // test-only (#70 step 4): `activity {tap:true}` returns the recent gossip frames sent/received
const BOARD_FIELDS = ['project', 'session', 'agent', 'path', 'host', 'active_only', 'log', 'entry', ...(ACT_TAP ? ['tap'] : [])]   // v1.60.0: + host (the mesh board); v1.62.0: + path (a node and its subtree)
function activityConfig(cfg) { const w = []; const c = Act.resolveConfig(cfg && cfg.activity, process.env, w); for (const x of w) log(`activity config: ${x}`); return c }
let ACT_CFG = activityConfig(CFG)
let activity = null        // the host's activity state — on the GATEWAY only (a follower forwards)
let actReplay = null       // { phase: 'replaying' | 'published' | 'done', promise, stats }
const actIndex = new Map() // entry id -> { day, offset, length } in this host's JSONL (details/data lookups)
const actPresent = new Set()   // session keys seen live on this host's roster (a present → absent transition marks them gone)
let actApplies = 0, actCpTimer = null, actCpEvery = 0, actCpBusy = false
const actCheckpointMs = () => Number(process.env.AI_BRIDGE_ACTIVITY_CHECKPOINT_MS) || ACT_CFG.progress_checkpoint_sec * 1000   // env: tests use a short interval
const tzOff = t => -new Date(t).getTimezoneOffset()
const actDisabled = () => ({ ok: false, code: 'activity-disabled', what: 'the activity board is disabled on this host (config activity.enabled / AI_BRIDGE_ACTIVITY_ENABLED)' })
profile.config.watch(c => {   // live-reload: the knobs apply to the next call / sweep (enabled, stale window, caps, cadence)
  const n = activityConfig(c)
  if (JSON.stringify(n) === JSON.stringify(ACT_CFG)) return
  ACT_CFG = n; if (activity) activity.config = n
  scheduleActivityCheckpoints(); log('activity config reloaded')
})
function indexEntry(id, day, offset, length) {
  actIndex.set(id, { day, offset, length })
  if (actIndex.size > ACT_INDEX_MAX) actIndex.delete(actIndex.keys().next().value)
}
// gateway promotion (becomeGateway): create the host's state and replay its files in the background (startup is never
// blocked on it); `log` calls wait for it, reads see the phase-1 board as soon as it's published
function startActivity() {
  if (activity) return
  activity = Act.createActivity({ config: ACT_CFG, origin: HOSTNAME, idPrefix: `act_${crypto.randomBytes(2).toString('hex')}_` })
  activity.config = ACT_CFG
  actReplay = { phase: 'replaying', stats: null, promise: null }
  actReplay.promise = replayActivity().catch(e => log(`activity replay failed: ${(e && e.message) || e}`))
    .finally(() => { actReplay.phase = 'done'; syncActivityGone(); syncActivityBells(); actChanged() })   // #70 step 4: the replayed board goes out to the peer hubs (step 5: with its bells)
  scheduleActivityCheckpoints()
}
async function replayActivity() {
  if (!PERSIST) return
  const t0 = Date.now()
  await pruneActivity(t0)   // retention first (startup), so the replay never reads a file it is about to delete
  const rp = Act.createReplay(activity, { now: t0 })
  const fromDay = Act.localDay(t0 - ACT_CFG.finished_visible_hours * 3600000)
  let n = 0
  for await (const r of persistence.activity.readBackwards(HOSTNAME, { fromDay })) {
    if (Act.recordKind(r.rec) === 'entry') indexEntry(r.rec.id, r.day, r.offset, r.length)   // v1.62.0: v2 entries only (a 1.61 v1 record is skipped)
    if (rp.feed(r.rec, r.day) === 'old' && !rp.wantsOlder(r.day)) break   // past the window (an older cp a rep line needs is still read)
    if (++n % 256 === 0 && actReplay.phase === 'replaying' && (rp.phase1Complete() || Date.now() - t0 > ACT_PHASE1_MS)) {
      rp.publish(); actReplay.phase = 'published'; actChanged()   // phase 1: current lines / bars / states visible now (and gossiped); history follows
      log(`activity: board published after ${n} records (${rp.phase1Complete() ? 'phase 1 complete' : 'provisional'}); replay continues`)
    }
  }
  const st = rp.finish()
  actReplay.stats = { ...st, ms: Date.now() - t0 }
  if (st.fed) log(`activity: replayed ${st.entries} entries, ${st.cps} checkpoints, ${st.reps} repeat lines → ${st.sessions} session(s) in ${Date.now() - t0}ms`)
}
async function pruneActivity(now) {   // retention: delete day files older than log_retention_days (gateway only — the host's one writer)
  if (!PERSIST || !activity || role !== 'gateway') return
  try {
    const gone = await persistence.activity.prune(HOSTNAME, Act.localDay(now - ACT_CFG.log_retention_days * 86400000))
    if (gone.length) log(`activity: retention removed ${gone.length} day file(s): ${gone.join(', ')}`)
  } catch (e) { log(`activity: retention failed: ${e.message}`) }
}
setInterval(() => { pruneActivity(Date.now()) }, ACT_RETENTION_MS).unref()
async function persistActivity(rec) {   // one JSONL line (a logged entry or a cp); never from a non-gateway process
  if (!PERSIST || !activity || role !== 'gateway') return null
  try {
    const loc = await persistence.activity.append(HOSTNAME, Act.localDay(rec.ts), JSON.stringify(rec))
    if (loc && typeof rec.id === 'string') indexEntry(rec.id, loc.day, loc.offset, loc.length)
    return loc
  } catch (e) { log(`activity: JSONL append failed: ${e.message}`); return null }
}
// checkpoints: every progress_checkpoint_sec, a cp line per context whose bar / line / ETA changed via log:false, and
// ONE trailing repeat line for the alive-but-unchanged ones (rewritten in place while the key set stays the same)
function scheduleActivityCheckpoints() {
  const ms = PERSIST && activity ? actCheckpointMs() : 0
  if (ms === actCpEvery) return
  if (actCpTimer) clearInterval(actCpTimer)
  actCpTimer = null; actCpEvery = ms
  if (ms > 0) { actCpTimer = setInterval(() => { checkpointActivity().catch(e => log(`activity: checkpoint failed: ${e.message}`)) }, ms); actCpTimer.unref() }
}
async function checkpointActivity() {
  if (!activity || role !== 'gateway' || !PERSIST || actCpBusy || (actReplay && actReplay.phase !== 'done')) return
  actCpBusy = true
  try { await writeCheckpoints(Act.planCheckpoints(activity, Date.now())) } finally { actCpBusy = false }
}
async function writeCheckpoints(writes) {   // the planned cp lines + the repeat line (appended, or rewritten in place) → { cp, rep }
  const day = activity.cp.day, n = { cp: 0, rep: 0 }
  for (const w of writes) {
    if (w.kind === 'cp') { if (await persistActivity(w.rec)) n.cp++; continue }
    const rep = activity.cp.rep, line = JSON.stringify(w.rec)   // a log entry may have closed it meanwhile (rep null): then just append
    const loc = w.rewrite && rep && rep.offset != null ? await persistence.activity.replaceTail(HOSTNAME, day, rep.offset, line) : await persistence.activity.append(HOSTNAME, day, line)
    if (rep && loc && activity.cp.rep === rep) rep.offset = loc.offset
    if (loc) n.rep++
  }
  return n
}
// #70 step 3 (v1.59.0): PREPARE-SHUTDOWN — the tray calls POST /admin/prepare-shutdown right before it TerminateProcess()es
// the bridges (a kill runs no 'exit' handler, so the log:false progress since the last checkpoint was lost). Waits out an
// in-flight tick, writes every dirty context's cp + the repeat line NOW (flushCheckpoints withRep), then drains the
// facet's write queues so every queued append (log entries too) is on disk before we answer. Followers write no activity
// files and keep no deferred writes (their persistence writes are issued immediately), so only the gateway needs it.
async function flushActivityNow() {
  const out = { cp: 0, rep: 0, files_drained: 0 }
  if (!activity || role !== 'gateway') return { ...out, skipped: 'no-activity-board' }
  if (!PERSIST) return { ...out, skipped: 'no-persistence' }
  for (const t0 = Date.now(); actCpBusy && Date.now() - t0 < 2000;) await new Promise(r => setTimeout(r, 20))   // a checkpoint tick is mid-write
  if (actReplay && actReplay.phase !== 'done') out.skipped = 'replaying'      // nothing new is applied before the replay ends
  else if (!actCheckpointMs()) out.skipped = 'checkpoints-off'               // progress_checkpoint_sec 0: log:false is memory-only by choice
  else if (!actCpBusy) {
    actCpBusy = true
    try { Object.assign(out, await writeCheckpoints(Act.flushCheckpoints(activity, Date.now(), { withRep: true }))) } finally { actCpBusy = false }
  }
  out.files_drained = await persistence.activity.drain()
  return out
}
process.on('exit', () => {   // a clean shutdown flushes the pending checkpoints (sync appends; a kill skips this — one interval lost)
  if (!activity || !PERSIST || !actCheckpointMs() || (actReplay && actReplay.phase !== 'done')) return
  try { for (const w of Act.flushCheckpoints(activity, Date.now())) persistence.activity.appendSync(HOSTNAME, activity.cp.day, JSON.stringify(w.rec)) } catch { }
})
function actBudget() {
  const r = Act.enforceBudget(activity, ACT_CFG.memory_budget_mb * 1048576)
  if (r.evicted.length || r.entries_dropped) log(`activity: over the ${ACT_CFG.memory_budget_mb} MB budget — evicted ${r.evicted.length} finished agent(s), dropped ${r.entries_dropped} log entries`)
  return r.evicted.length
}
setInterval(() => {   // expiry (finished/gone agents past finished_visible_hours leave the board) + the memory budget
  if (!activity || role !== 'gateway' || (actReplay && actReplay.phase !== 'done')) return
  const now = Date.now()
  let changed = Act.expire(activity, now).length > 0
  for (const k of [...actPresent]) if (!activity.local.has(k)) actPresent.delete(k)
  for (const o of Act.expireRemote(activity, now)) { actOwner.delete(o); changed = true }   // #70 step 4: a host down past the window leaves the board
  if (actBudget()) changed = true
  if (changed) actChanged()   // #70 step 4: removals reach the peer hubs as a delta
}, ACT_GC_MS).unref()
// GONE: a session whose sub-peer was live on this host's roster and then left (deregister, TTL expiry, its follower
// process exited) is marked gone; it is cleared when the session comes back (re-registers or reports again). A session
// never seen live here (e.g. one only replayed from the files) is not marked — it simply goes stale.
function syncActivityGone() {
  if (!activity || role !== 'gateway' || (actReplay && actReplay.phase !== 'done')) return
  const live = new Set()
  for (const s of roster.values()) { if (s.origin) continue; for (const sp of (s.subpeers || [])) live.add(Act.sessionKey({ realm: sp.realm || REALM, project: sp.project, user: sp.user, session: sp.name, host: HOSTNAME })) }   // v1.60.0: the key has the host
  const now = Date.now()
  let changed = false
  for (const [k, sess] of activity.local) {
    if (live.has(k)) { if (!actPresent.has(k)) { actPresent.add(k); if (sess.gone_at) { Act.markSessionGone(activity, sess, null); changed = true } } }
    else if (actPresent.has(k)) { actPresent.delete(k); Act.markSessionGone(activity, sess, now); changed = true }
  }
  if (changed) actChanged()   // #70 step 4: gone / back reaches the peer hubs
}
// ---- the gateway's handlers (a follower reaches them through activityCall → ACTIVITY frame)
async function activityLog(ident, input, opts = {}) {   // opts.script: an aimb-log.mjs report (#70 step 3) — never tracked for gone
  if (!ACT_CFG.enabled) return actDisabled()
  if (!activity) return { ok: false, code: 'not-gateway', what: 'this bridge does not hold the activity board' }
  const batch = !!input && typeof input === 'object' && input.items !== undefined
  const split = batch ? Act.splitBatch(input) : null   // v1.62.0 (#70 step 6a): a BATCH — its bounds refuse the whole call (before any wait)
  if (split && !split.ok) return split
  if (actReplay && actReplay.phase !== 'done') {   // a new gateway finishes the replay before it applies anything
    const ready = await Promise.race([actReplay.promise.then(() => true), new Promise(res => { setTimeout(() => res(false), ACT_LOAD_WAIT_MS).unref() })])
    if (!ready) return { ok: false, code: 'activity-loading', what: 'the activity board is still loading this host\'s log after a restart — retry in a moment' }
  }
  let res
  if (!batch) res = await actApplyOne(ident, input)
  else {   // items IN ORDER, one result each (+ its ref); one bad item never aborts the rest; ONE coalesced gossip / dashboard update
    const results = []
    for (const it of split.items) {
      const r = it.error ? it.error : await actApplyOne(ident, it.input)
      results.push(it.ref !== undefined ? { ref: it.ref, ...r } : r)
    }
    const failed = results.filter(r => !r.ok).length
    res = { ok: true, results, applied: results.length - failed, failed }
  }
  if (batch ? res.applied : res.ok) {
    actChanged()   // #70 step 4: coalesced into ≤1 gossip frame per second per peer link (a batch: one change)
    syncActivityBells()   // #70 step 5: a new session may be one an armed doorbell watches
    if (!opts.script) actPresent.add(Act.sessionKey({ ...ident, host: HOSTNAME }))   // a script-only session is never marked gone (it can still go stale)
  }
  return res
}
// one message (a single call or one batch item) → the `log` result shape; persisted in order (a batch awaits each append)
async function actApplyOne(ident, input) {
  const now = Date.now()
  const p = Act.parseMessage(input, { now, tzOffsetMin: tzOff(now) })
  if (!p.ok) return p
  const r = Act.apply(activity, ident, p.msg, now)
  if (!r.ok) return r
  const persisted = r.entry && PERSIST ? !!(await persistActivity(r.entry)) : null
  if (++actApplies % 50 === 0) actBudget()
  return { ok: true, id: r.id, ts: r.ts, session: ident.session, path: r.path, agent: r.agent, context: r.context, current: r.current, state: r.state, stale_at: r.stale_at, logged: r.logged,
    ...(persisted === false ? { persisted: false } : {}), ...(r.evicted.length ? { evicted: r.evicted } : {}), ...(r.warnings.length ? { warnings: r.warnings } : {}) }
}
const actShow = o => (o && typeof o === 'object' && o.project != null ? { ...o, project: projName(o.project) } : o)   // #71: canonical project spelling
// ctx (v1.61.0, #70 step 5): who is asking — { ws } a dashboard (its queued remote fetches are bounded per dashboard),
// onQueued(info) to hear a queued fetch's expected wait (the page shows a spinner), maxWaitMs (a follower's forwarded
// read must answer inside its own timeout, so it gets `busy` rather than a long queue)
async function activityRead(q, ctx = {}) {
  if (!ACT_CFG.enabled) return actDisabled()
  if (!activity) return { ok: false, code: 'not-gateway', what: 'this bridge does not hold the activity board' }
  q = q && typeof q === 'object' ? q : {}
  const now = Date.now()
  const head = { ok: true, host: HOSTNAME, now, stale_after_min: ACT_CFG.stale_after_min, ...(actReplay && actReplay.phase !== 'done' ? { loading: actReplay.phase } : {}),
    ...(activity.remote.size ? { remote_hosts: actRemoteInfo() } : {}), ...(ACT_TAP && q.tap ? { tap: actTap } : {}) }
  if (q.entry != null) {   // v1.60.0: a REMOTE entity's entry is fetched from its owner (entry:{id, host}; a remote CURRENT line is found by id)
    const e = q.entry && typeof q.entry === 'object' ? q.entry : { id: q.entry }
    const id = String(e.id || ''), want = typeof e.host === 'string' && e.host.trim() ? e.host.trim() : null
    if (!id) return { ok: false, code: 'id-required', what: 'entry needs { id } (+ host for a remote host\'s log entry)' }
    let remote = null
    if (want && lc(want) !== lc(HOSTNAME)) { remote = actKnownHost(want); if (!remote) return { ok: false, code: 'unknown-host', what: `no activity from a host "${want}" is held here` } }
    else if (!want && !Act.findEntry(activity, id, now)) { const loc = Act.locateEntry(activity, id); if (loc && !loc.local) remote = loc.host }
    if (remote) { const r = await activityRemote(remote, 'entry', { id }, ctx); return r.ok === false ? r : { ...head, from_host: remote, source: r.source, ...(r.via ? { via: r.via } : {}), ...(r.note ? { note: r.note } : {}), ...(r.queued_ms ? { queued_ms: r.queued_ms } : {}), entry: actShow(r.entry) } }
    const r = await lookupActivityEntry(id, now)
    if (r.ok === false && !want && activity.remote.size) r.what += ' — for another host\'s older log entry pass entry:{ id, host }'
    return r.ok === false ? r : { ...head, ...r }
  }
  if (q.log != null) {   // v1.60.0: the session is found on ANY host held; a remote one's log page is fetched from its owner
    const lq = typeof q.log === 'object' && q.log ? q.log : { session: q.log }
    let cands = Act.locateSessions(activity, lq)
    const nq = Act.queryNodeKey(lq)   // v1.62.0: the node (path / agent / context) — a name on several hosts narrows to those holding it
    if (cands.length > 1 && nq.ok && nq.key) { const f = cands.filter(c => c.session.nodes.has(nq.key)); if (f.length) cands = f }
    if (cands.length > 1) return { ok: false, code: 'ambiguous-session', what: 'several sessions match — pass project, user and/or host', candidates: cands.map(c => ({ session: c.session.session, project: projName(c.session.project), user: c.session.user, host: c.host })) }
    const c = cands[0]
    const sub = { ...lq, ...(c ? { session: c.session.session, project: c.session.project, user: c.session.user } : {}) }
    delete sub.host
    if (c && !c.local) { const r = await activityRemote(c.host, 'log', sub, ctx); return r.ok === false ? r : { ...head, from_host: c.host, ...(r.queued_ms ? { queued_ms: r.queued_ms } : {}), log: actShow(r.log) } }
    const lv = await actLogPage(sub, now)   // v1.61.0: continues into this host's day files once memory runs out
    if (!lv.ok) return lv
    const { ok: _ok, ...rest } = lv
    return { ...head, log: actShow({ ...rest, host: HOSTNAME }) }
  }
  return { ...head, sessions: Act.boardView(activity, now, { project: q.project, session: q.session, agent: q.agent, path: q.path, host: q.host, active_only: !!q.active_only }).map(actShow) }
}
// #70 step 5 (v1.61.0): HISTORY PAGING INTO THE DAY FILES. logView pages the in-memory log; once it runs out (or the
// cursor is a file cursor `f1.<day>.<offset>`) the page continues in this host's daily JSONL, read BACKWARDS in chunks
// (step 2's reader — async I/O per chunk, so it yields to the event loop) through log_retention_days: the entity's
// logged entries older than its oldest in-memory one, up to the page's room (entries + bytes; ACT_PAGE_* for a remote
// owner's page, the 32 KB cap for a local one). A page reads at most ACT_SCAN_BYTES of file — a sparse agent in a
// busy file gets a short (maybe empty) page with a cursor to go on. next_cursor = the file position before the last
// record taken (or scanned); null once the window is exhausted.
const ACT_SCAN_BYTES = Number(process.env.AI_BRIDGE_ACTIVITY_SCAN_BYTES) || 8 * 1048576
async function actLogPage(q, now, opts = {}) {
  const lv = Act.logView(activity, q, now, { ...opts, files: !!PERSIST })
  if (!lv.ok || !lv.files) return lv
  const f = lv.files; delete lv.files
  const maxB = Math.min(f.maxBytes, ACT_PAGE_BYTES), out = lv.entries
  const fromDay = Act.localDay(now - ACT_CFG.log_retention_days * 86400000)
  let bytes = f.bytes, scanned = 0, last = null, lastHit = null, stop = null, n = 0
  for await (const r of persistence.activity.readBackwards(HOSTNAME, { fromDay, before: f.from })) {
    scanned += r.length + 1; last = r
    const rec = r.rec
    if (rec && Act.fileEntryMatches(rec, f.target) && !(f.before && (rec.ts > f.before.ts || f.before.ids.has(rec.id)))) {
      const x = Act.fileEntryView(rec, now, lv.path), b = Buffer.byteLength(JSON.stringify(x)) + 1
      if (n >= f.need || (out.length && bytes + b > maxB)) { stop = 'full'; break }
      out.push(x); bytes += b; n++; lastHit = r
    }
    if (scanned >= ACT_SCAN_BYTES) { stop = 'scan'; break }
  }
  lv.from_files = n
  if (stop === 'full') lv.next_cursor = lastHit ? Act.fileCursor(lastHit.day, lastHit.offset) : (out.length ? out[out.length - 1].id : null)
  else if (stop === 'scan') lv.next_cursor = Act.fileCursor(last.day, last.offset)
  else lv.next_cursor = null
  return lv
}
// one entry in full: memory first (a current line holds its details/data), else this host's JSONL — by the id index,
// else a scan of the day file the id's timestamp names (± a day). Checkpoint / repeat lines never match.
async function lookupActivityEntry(id, now) {
  if (!id) return { ok: false, code: 'id-required', what: 'entry needs { id }' }
  const mem = Act.findEntry(activity, id, now)
  if (mem && mem.complete) return { source: 'memory', entry: actShow(mem.entry) }
  if (PERSIST) {
    let rec = null, via = null
    const ix = actIndex.get(id)
    if (ix) { const r = await persistence.activity.readAt(HOSTNAME, ix.day, ix.offset, ix.length); if (r && r.id === id && Act.recordKind(r) === 'entry') { rec = r; via = 'index' } }
    const t = rec ? null : Act.entryTime(id)
    if (t) for (const d of new Set([Act.localDay(t), Act.localDay(t - 86400000), Act.localDay(t + 86400000)])) { const r = await persistence.activity.find(HOSTNAME, d, id); if (r && Act.recordKind(r) === 'entry') { rec = r; via = 'scan'; break } }   // v1.62.0: a 1.61 (v1) record is not an entry
    if (rec) {
      const { v: _v, new_from: _n, ...e } = rec
      return { source: 'file', via, entry: actShow({ ...e, rendered: Act.renderText(e.text, e.progress, e.eta_at, now) }) }
    }
  }
  if (mem) return { source: 'memory', entry: actShow(mem.entry), note: 'details/data are not available: this entry is not in this host\'s log files' }
  return { ok: false, code: 'unknown-entry', what: `no entry ${id} on this host (in memory or in its daily log files)` }
}
// ---- the follower side: forward to this host's gateway over the control link, wait for its answer
const actPending = new Map()   // rid -> { resolve, timer }
let actRid = 0, gwRegistered = false
function failActivityPending(code, what) { for (const p of actPending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, code, what }) } actPending.clear() }
function activityForward(op, payload) {
  return new Promise(resolve => {
    const rid = String(++actRid)
    const timer = setTimeout(() => { actPending.delete(rid); resolve({ ok: false, code: 'gateway-timeout', what: `this host's gateway did not answer within ${ACT_FWD_MS}ms — retry` }) }, ACT_FWD_MS)
    timer.unref()
    actPending.set(rid, { resolve, timer })
    sendFrame(gwSock, { t: 'ACTIVITY', session: SESSION, rid, op, ...payload })
  })
}
const verLt = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false }
async function activityCall(op, payload) {   // op 'log' { ident, input } | 'read' { query }
  const t0 = Date.now()
  for (;;) {
    if (role === 'gateway') return op === 'log' ? activityLog(payload.ident, payload.input) : activityRead(payload.query, { maxWaitMs: ACT_TOOL_WAIT_MS })
    if (role === 'follower' && gwSock && !gwSock.destroyed && gwRegistered) {
      const gv = roster.get(gatewayId)?.bridge_version   // a ≤1.57 gateway ignores ACTIVITY frames: say so now, not after a timeout
      if (gv && verLt(gv, '1.58.0')) return { ok: false, code: 'gateway-unsupported', what: `this host's gateway runs bridge ${gv}; the activity board needs 1.58.0+ on the gateway (restart it on the new version)` }
      return activityForward(op, payload)
    }
    if (Date.now() - t0 >= ACT_FWD_MS) return { ok: false, code: 'no-gateway', what: 'no gateway on this host right now (re-election in progress?) — retry in a moment' }
    await new Promise(r => setTimeout(r, 100))
  }
}
// ---- #70 step 3 (v1.59.0): tools/aimb-log.mjs — a token-gated `logger` WS leaf on the GATEWAY's ws port (no sub-peer).
// Identity = realm + project + user + session from its hello (Robin, 2026-10-01: anyone holding the realm token may report
// as any session, like the doorbell) — EXCEPT a session that is LIVE on the mesh roster (a registered sub-peer on ANY
// host: our followers' and the gossiped remote slices) under a DIFFERENT user (case-insensitive): session-user-mismatch.
// Checked per report against the current roster. A script-only session is never marked gone; it can go stale.
const LOGGER_IDENT_MAX = 128
function loggerIdent(m) {   // the hello's ident → { realm, project, user, session } | { err }
  const i = m && m.ident && typeof m.ident === 'object' ? m.ident : {}
  const str = v => (typeof v === 'string' ? v.trim() : '')
  const session = str(i.session), project = str(i.project), user = str(i.user), realm = str(i.realm) || REALM
  if (!session || !project || !user) return { err: { code: 'ident-required', what: 'logger hello needs ident { session, project, user }' } }
  if ([session, project, user, realm].some(v => v.length > LOGGER_IDENT_MAX || /[\u0000-\u001f\u007f]/.test(v))) return { err: { code: 'bad-ident', what: `ident fields are one-line strings of at most ${LOGGER_IDENT_MAX} chars` } }
  if (lc(realm) !== lc(REALM)) return { err: { code: 'realm-mismatch', what: `this bridge serves realm "${REALM}"` } }
  return { ident: { realm: REALM, project, user, session } }
}
// v1.60.0 (#70 "Decisions before step 4"): BARE (process-level) sessions get the same rule as sub-peers — a roster entry
// with its own project + user (a bridge started with AI_BRIDGE_PROJECT, its name = the session name) under another user is
// a conflict; same user is allowed. Infrastructure processes (no project) never match.
function loggerUserConflict(ident) {   // a live sub-peer — or bare session — with this realm + project + name under another user, or null
  for (const s of roster.values()) {
    if (s.project && s.user && lc(s.realm || REALM) === lc(ident.realm) && projKey(s.project) === projKey(ident.project) && ciEq(s.name, ident.session) && lc(s.user) !== lc(ident.user)) return { ...s, bare: true }
    for (const sp of (s.subpeers || [])) {
      if (lc(sp.realm || s.realm || REALM) !== lc(ident.realm) || projKey(sp.project) !== projKey(ident.project) || !ciEq(sp.name, ident.session)) continue
      if (lc(sp.user) !== lc(ident.user)) return sp
    }
  }
  return null
}
async function loggerLog(ident, input) {
  if (role !== 'gateway') return { ok: false, code: 'not-gateway', what: 'this bridge does not hold the activity board' }
  if (!ACT_CFG.enabled) return actDisabled()
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'bad-input', what: 'log needs an input object' }
  if (loggerUserConflict(ident)) return { ok: false, code: 'session-user-mismatch', what: `session "${ident.session}" (${projName(ident.project)}) is live on the mesh under another user — a script may not report for it` }
  const clean = {}
  for (const k of LOG_FIELDS) if (input[k] !== undefined) clean[k] = input[k]   // v1.62.0: + items (a batch: each item's fields are checked by splitBatch)
  return activityLog({ ...ident, host: HOSTNAME }, clean, { script: true })
}

// ---- #70 step 4 (v1.60.0): MESH-WIDE GOSSIP of the board + ON-DEMAND remote history, over the existing peer-hub links.
// One-hop like the roster slices: each gateway sends ITS OWN host's units (lib/activity.js planSlice — current lines only,
// never details/data/log) to every peer hub that declared `activity_gossip` in PEER_HELLO: a FULL slice on every (re)link
// and on request (`ACTIVITY_REQ {op:"resync"}`), then DELTAS (changed entities + removals). At most ONE frame per
// ACT_GOSSIP_MS (1 s) per link: a change only KICKS a per-link timer, so any burst coalesces into the next frame; each
// frame is capped at ACT_SLICE_MAX_BYTES, newest-active entities first, the rest in the following second(s). Receivers
// merge per ORIGIN = the link's host (the hostname of the peer's authenticated PEER_HELLO session — never a field in the
// frame; a frame whose `origin` names another host is dropped), and a delta that doesn't follow the held (epoch, seq) is
// dropped and a full slice asked for. A dropped link, a retired / expired peer (#63) and an ACTIVITY_DOWN notice mark that
// origin's entities GONE: the last-known lines stay until the host returns with a fresh full slice (or past
// finished_visible_hours). History, details and data travel only on demand: ACTIVITY_REQ {rid, op:"log"|"entry", q} →
// ACTIVITY_RES {rid, result} on the same link, paged and rate-limited by the OWNER. Followers hold no board — they
// forward reads to their gateway (step 2's ACTIVITY frame), so the mesh board needs nothing new on that path.
const ACT_GOSSIP_MS = Number(process.env.AI_BRIDGE_ACTIVITY_GOSSIP_MS) || 1000              // ≤1 slice frame per link per this
const ACT_SLICE_MAX_BYTES = Number(process.env.AI_BRIDGE_ACTIVITY_SLICE_MAX_BYTES) || 256 * 1024   // per frame (frames die above 8 MB)
const ACT_PAGE_ENTRIES = Number(process.env.AI_BRIDGE_ACTIVITY_PAGE_ENTRIES) || 50          // a remote log page: entries …
const ACT_PAGE_BYTES = Number(process.env.AI_BRIDGE_ACTIVITY_PAGE_BYTES) || 32 * 1024      // … and bytes (the owner enforces both)
const ACT_FETCH_RATE = Number(process.env.AI_BRIDGE_ACTIVITY_FETCH_RATE) || 4              // remote fetches served per second per link (token bucket, burst = rate)
const ACT_REMOTE_MS = Number(process.env.AI_BRIDGE_ACTIVITY_REMOTE_MS) || 4000             // < ACT_FWD_MS: a follower hears owner-unreachable, not gateway-timeout
const ACT_DOWN_HOLD_MS = Number(process.env.AI_BRIDGE_ACTIVITY_DOWN_HOLD_MS) || 30000      // after our going-down notice, no slices for this long (then full ones, if still alive)
const ACT_EPOCH = crypto.randomBytes(4).toString('hex')   // this gateway's slice epoch: a receiver applies a delta only on top of (epoch, seq)
const actOwner = new Map()           // remote origin (host) -> the peer gateway session whose link owns its slice
const actRemotePending = new Map()   // rid -> { resolve, timer, sock } (our fetches in flight)
const actTap = { sent: [], recv: [] }   // test-only (AI_BRIDGE_TEST_ACTIVITY_TAP): recent frame summaries
let actRemoteRid = 0, actVer = 0, actUnits = null, actUnitsVer = -1, actDownUntil = 0, actDownTimer = null, actDashTimer = null, actDashLast = 0
const actLegacy = () => process.env.AI_BRIDGE_TEST_GOSSIP === 'legacy'   // test-only: mimic a ≤1.59 hub (no flag; ignores the frames)
const hostOfGw = gw => String(gw || '').split('/')[0]
function tapRec(dir, rec) { if (!ACT_TAP) return; const a = actTap[dir]; a.push({ ts: Date.now(), ...rec }); if (a.length > 500) a.shift() }
const tapSlice = f => ({ kind: f.full ? 'full' : f.beat ? 'beat' : 'delta', seq: f.seq, base: f.base, truncated: !!f.truncated, bytes: JSON.stringify(f).length,
  nodes: (f.sessions || []).flatMap(s => (s.nodes || []).filter(n => n && n.path).map(n => `${s.session}/${n.path}`)), sessions: (f.sessions || []).map(s => s.session), remove: (f.remove || []).length, v: f.v })   // v1.62.0: the non-root NODES a frame carries
/** The local board changed: kick every peer link (and the dashboards). Never sends synchronously — see actKick. */
function actChanged() {
  actVer++
  if (role !== 'gateway') return
  for (const p of peerGw.values()) actKick(p)
  actDashKick()
}
function actUnitsNow() { if (!actUnits || actUnitsVer !== actVer) { actUnits = Act.gossipUnits(activity); actUnitsVer = actVer } return actUnits }
// adoptPeer: a fresh link state; a 1.60+ peer gets a FULL slice right away (#63 rule: a full slice on every (re)link)
function actLinkInit(p, gw, hello) {
  if (!p) return
  p.act = { gw, host: hostOfGw(gw), cap: !actLegacy() && !!(hello && hello.activity_gossip === Act.ACTIVITY_FORMAT), seq: 0, pub: Act.createPub(), needFull: true, last: 0, timer: null, beat: false,
    bucket: ACT_FETCH_RATE, bucketAt: Date.now(), resyncAt: 0 }
  if (p.act.cap) actKick(p)
}
// coalescing: one timer per link, due ACT_GOSSIP_MS after that link's last frame — every change before it fires rides it
function actKick(p) {
  const a = p && p.act
  if (!a || !a.cap || a.timer) return
  a.timer = setTimeout(() => { a.timer = null; try { actSendTo(p) } catch (e) { log(`activity: gossip to ${a.host} failed: ${(e && e.message) || e}`) } }, Math.max(0, a.last + ACT_GOSSIP_MS - Date.now()))
  a.timer.unref()
}
function actSendTo(p) {
  const a = p.act
  if (!a || !a.cap || peerGw.get(a.gw) !== p || !p.sock || p.sock.destroyed || role !== 'gateway' || !activity || process.env.AI_BRIDGE_TEST_GOSSIP === 'silent') return
  const now = Date.now()
  if (actDownUntil > now) return                                     // we announced going down: quiet (full slices follow the hold)
  if (actReplay && actReplay.phase === 'replaying') { setTimeout(() => actKick(p), 250).unref(); return }   // nothing to show before phase 1
  const full = a.needFull
  const plan = Act.planSlice(activity, a.pub, { full, maxBytes: ACT_SLICE_MAX_BYTES, units: actUnitsNow() })
  let frame = null
  if (plan.body) frame = { t: 'ACTIVITY_SLICE', origin: HOSTNAME, epoch: ACT_EPOCH, seq: a.seq + 1, ...(full ? {} : { base: a.seq }), ...plan.body }   // the body carries v:2 (#70 step 6a)
  else if (a.beat) frame = { t: 'ACTIVITY_SLICE', v: Act.ACTIVITY_FORMAT, origin: HOSTNAME, epoch: ACT_EPOCH, seq: a.seq, base: a.seq, sessions: [], beat: true }   // the #63 heartbeat: lets the receiver check it is in sync
  a.beat = false
  if (!frame) return
  if (plan.body) a.seq++
  a.needFull = false; a.last = now
  sendFrame(p.sock, frame)
  if (ACT_TAP) tapRec('sent', { peer: a.host, ...tapSlice(frame) })
  if (plan.pending) actKick(p)   // over the cap: the rest goes in the next frame (≥ ACT_GOSSIP_MS later)
}
function peerEntryOf(sock) { for (const [id, p] of peerGw) if (p.sock === sock) return [id, p]; return [null, null] }
function actAskResync(p, host) {   // our copy of `host` is out of step: ask the owner for a full slice (at most every 2 s per link)
  const now = Date.now()
  if (!p.act || now - p.act.resyncAt < 2000 || !p.sock || p.sock.destroyed) return
  p.act.resyncAt = now
  sendFrame(p.sock, { t: 'ACTIVITY_REQ', op: 'resync' })
  tapRec('sent', { peer: host, kind: 'resync' })
}
// every ACTIVITY_SLICE / ACTIVITY_DOWN / ACTIVITY_REQ / ACTIVITY_RES, from either end of a peer-hub link
function onActivityFrame(sock, f) {
  if (actLegacy()) return                         // test-only: a ≤1.59 hub ignores these frames
  const [gw, p] = peerEntryOf(sock)
  if (!gw || !p) return                           // only an ADOPTED peer-hub link (HELLO token + PEER_HELLO) speaks activity
  const host = hostOfGw(gw)
  p.seen = Date.now()
  if (!p.act || !p.act.cap) {   // v1.62.0 (#70 step 6a): a peer that didn't declare THIS activity format (a 1.60/1.61 hub: v1) — its frames are skipped, never misread
    if (p.act && !p.act.skipNoted) { p.act.skipNoted = true; log(`activity: ${host} speaks another activity format (${f.v != null ? 'v' + f.v : 'none'}) — its ${f.t} frames are ignored`) }
    tapRec('recv', { peer: host, kind: 'skipped-format', t: f.t, v: f.v }); return
  }
  if (f.origin != null && lc(String(f.origin)) !== lc(host)) {   // a frame claiming another host's slice: ownership is the link's
    log(`activity: dropped a ${f.t} from ${gw} claiming origin "${String(f.origin).slice(0, 80)}"`)
    tapRec('recv', { peer: host, kind: 'forged', t: f.t }); return
  }
  if (f.t === 'ACTIVITY_SLICE') {
    if (!activity || lc(host) === lc(HOSTNAME)) return   // never let a peer write our own host's entities
    if (!f.full && actOwner.get(host) !== gw) { actAskResync(p, host); return }   // a delta from a link that never sent us a full slice
    const r = Act.applySlice(activity, host, f)
    if (ACT_TAP) tapRec('recv', { peer: host, ...tapSlice(f), ok: r.ok, code: r.code })
    if (!r.ok) { if (r.code === 'out-of-sync') actAskResync(p, host); else if (r.code !== 'bad-version' || !p.act || !p.act.badVer) { if (r.code === 'bad-version' && p.act) p.act.badVer = true; log(`activity: slice from ${host} refused: ${r.code}`) } ; return }   // v1.62.0: an old-format (v1) slice is skipped, logged once per link
    if (f.full) actOwner.set(host, gw)
    if (r.changed) actDashKick()
  } else if (f.t === 'ACTIVITY_DOWN') {
    tapRec('recv', { peer: host, kind: 'down' })
    if (activity && actOwner.get(host) === gw && Act.markOriginDown(activity, host, Date.now())) { log(`activity: ${host} is going down (${String(f.reason || 'notice').slice(0, 40)}) — its agents show as gone`); actDashKick() }
  } else if (f.t === 'ACTIVITY_REQ') actServe(sock, p, host, f)
  else if (f.t === 'ACTIVITY_RES') {
    const q = actRemotePending.get(f.rid)
    if (q && q.sock === sock) { clearTimeout(q.timer); actRemotePending.delete(f.rid); q.resolve(f.result && typeof f.result === 'object' ? f.result : { ok: false, code: 'bad-response', what: 'the owning host sent no result' }) }
  }
}
// the OWNER side of a remote fetch: rate-limited per link (token bucket), paged (ACT_PAGE_ENTRIES / ACT_PAGE_BYTES), and
// only ever about this host's own entities. logView is an in-memory slice of ≤ a page; an entry's details/data are read
// back through lookupActivityEntry (id index → readAt, else a streamed day-file scan — async, never a big sync read).
function actServe(sock, p, host, f) {
  const reply = result => { try { sendFrame(sock, { t: 'ACTIVITY_RES', rid: f.rid, result }) } catch { } ; tapRec('sent', { peer: host, kind: 'res', op: f.op, ok: !!(result && result.ok), code: result && result.code }) }
  tapRec('recv', { peer: host, kind: f.op === 'resync' ? 'resync' : 'req', op: f.op })
  if (f.op === 'resync') { if (p.act && p.act.cap) { p.act.needFull = true; actKick(p) } return }   // no reply: the full slice is the answer
  if (role !== 'gateway' || !activity) return reply({ ok: false, code: 'not-gateway', what: 'this bridge does not hold the activity board' })
  if (!ACT_CFG.enabled) return reply({ ...actDisabled(), host: HOSTNAME })
  const a = p.act, now = Date.now()
  a.bucket = Math.min(ACT_FETCH_RATE, a.bucket + ((now - a.bucketAt) * ACT_FETCH_RATE) / 1000); a.bucketAt = now
  if (a.bucket < 1) return reply({ ok: false, code: 'rate-limited', host: HOSTNAME, rate: ACT_FETCH_RATE, retry_after_ms: Math.ceil(((1 - a.bucket) * 1000) / ACT_FETCH_RATE), what: `host ${HOSTNAME} serves at most ${ACT_FETCH_RATE} history fetches per second per link — retry shortly` })   // v1.61.0: + rate (a requester paces its queue to it)
  a.bucket -= 1
  const q = f.q && typeof f.q === 'object' ? f.q : {}
  if (f.op === 'log') {   // v1.61.0: a page continues into this host's day files once memory runs out (actLogPage)
    actLogPage(q, now, { maxEntries: ACT_PAGE_ENTRIES, maxBytes: ACT_PAGE_BYTES }).then(lv => {
      if (!lv.ok) return reply({ ...lv, host: HOSTNAME })
      const { ok: _ok, ...rest } = lv
      reply({ ok: true, host: HOSTNAME, log: { ...rest, host: HOSTNAME } })
    }, e => reply({ ok: false, code: 'owner-error', host: HOSTNAME, what: String((e && e.message) || e) }))
    return
  }
  if (f.op === 'entry') {
    lookupActivityEntry(String(q.id || ''), now).then(r => reply(r.ok === false ? { ...r, host: HOSTNAME } : { ok: true, host: HOSTNAME, ...r }),
      e => reply({ ok: false, code: 'owner-error', host: HOSTNAME, what: String((e && e.message) || e) }))
    return
  }
  reply({ ok: false, code: 'bad-op', what: `unknown activity request ${String(f.op).slice(0, 40)}` })
}
/**
 * The requester side: one remote fetch over the owning host's link → its result, or owner-unreachable /
 * owner-unsupported / busy. v1.61.0 (#70 step 5, "Decisions before step 5" 6): fetches are QUEUED per link and paced by
 * a mirror of the owner's token bucket (ACT_FETCH_RATE, or the `rate` an owner's rate-limited answer names), so a
 * dashboard expanding many remote logs waits instead of seeing `rate-limited`; an owner that still says rate-limited
 * puts the fetch back at the head of the queue for its retry_after_ms (≤ 4 times). Bounded: ACT_QUEUE_LINK waiting per
 * link and ACT_QUEUE_DASH queued + in flight per dashboard; beyond either (or a wait over ctx.maxWaitMs) → `busy` with
 * retry_after_ms. ctx.onQueued({ wait_ms, position }) hears a fetch that has to wait; a queued result carries queued_ms.
 */
const ACT_QUEUE_LINK = Number(process.env.AI_BRIDGE_ACTIVITY_QUEUE_LINK) || 64
const ACT_QUEUE_DASH = Number(process.env.AI_BRIDGE_ACTIVITY_QUEUE_DASH) || 16
const ACT_TOOL_WAIT_MS = Number(process.env.AI_BRIDGE_ACTIVITY_TOOL_WAIT_MS) || 10000   // the `activity` tool on the gateway waits at most this long in the queue
function actOut(a) {   // the link's outbound fetch queue + its token-bucket mirror (refilled on read)
  const o = a.out || (a.out = { rate: ACT_FETCH_RATE, bucket: ACT_FETCH_RATE, at: Date.now(), hold: 0, q: [], timer: null })
  const now = Date.now()
  o.bucket = Math.min(o.rate, o.bucket + ((now - o.at) * o.rate) / 1000); o.at = now
  return o
}
const actWaitMs = (o, pos) => Math.max(0, o.hold - Date.now(), Math.ceil(((pos - o.bucket) * 1000) / o.rate))   // the pos-th fetch in line (1 = next)
function activityRemote(host, op, q, ctx = {}) {
  const gw = actOwner.get(host), p = gw ? peerGw.get(gw) : null
  if (!p || !p.sock || p.sock.destroyed) return Promise.resolve({ ok: false, code: 'owner-unreachable', host, what: `host ${host} is down or unreachable right now — its history can't be fetched (its last-known lines show as gone)` })
  if (!p.act || !p.act.cap) return Promise.resolve({ ok: false, code: 'owner-unsupported', host, what: `host ${host} runs a bridge without this activity format (needs 1.62.0+)` })
  const o = actOut(p.act), ws = ctx && ctx.ws, wait = actWaitMs(o, o.q.length + 1)
  const busy = (why, after) => Promise.resolve({ ok: false, code: 'busy', host, retry_after_ms: Math.max(100, after), what: `too many history fetches are waiting (${why}) — retry in a moment` })
  if (ws && (ws.actFetches || 0) >= ACT_QUEUE_DASH) return busy(`${ACT_QUEUE_DASH} for this dashboard`, actWaitMs(o, o.q.length))
  if (o.q.length >= ACT_QUEUE_LINK) return busy(`${ACT_QUEUE_LINK} for host ${host}`, wait)
  if (ctx && Number.isFinite(ctx.maxWaitMs) && wait > ctx.maxWaitMs) return busy(`a ${wait}ms wait for host ${host}`, wait)
  if (ws) ws.actFetches = (ws.actFetches || 0) + 1
  return new Promise(resolve => {
    o.q.push({ host, op, q, resolve, t0: Date.now(), tries: 0 })
    if (wait > 0 && ctx && typeof ctx.onQueued === 'function') { try { ctx.onQueued({ host, wait_ms: wait, position: o.q.length }) } catch { } }
    actPump(p)
  }).finally(() => { if (ws) ws.actFetches = Math.max(0, (ws.actFetches || 1) - 1) })
}
function actPump(p) {
  const a = p.act, o = a && a.out
  if (!o || o.timer) return
  while (o.q.length) {
    if (peerGw.get(a.gw) !== p || !p.sock || p.sock.destroyed) { actFailQueue(a, 'the link to the owning host dropped while the fetch was queued'); return }
    actOut(a)
    const w = Math.max(o.hold - Date.now(), o.bucket < 1 ? Math.ceil(((1 - o.bucket) * 1000) / o.rate) : 0)
    if (w > 0) { o.timer = setTimeout(() => { o.timer = null; actPump(p) }, w); o.timer.unref(); return }
    o.bucket -= 1
    actDispatch(p, o.q.shift())
  }
}
function actFailQueue(a, what) {
  const o = a && a.out
  if (!o) return
  if (o.timer) { clearTimeout(o.timer); o.timer = null }
  for (const j of o.q.splice(0)) j.resolve({ ok: false, code: 'owner-unreachable', host: j.host, what })
}
function actDispatch(p, job) {
  const rid = `${ACT_EPOCH}-${++actRemoteRid}`, host = job.host, o = p.act.out
  job.sent = Date.now()
  const done = r => {
    if (r && r.code === 'rate-limited' && job.tries < 4 && peerGw.get(p.act.gw) === p) {   // the owner's bucket disagrees: wait its retry_after, then go first
      job.tries++
      if (Number(r.rate) > 0) o.rate = Number(r.rate)
      o.bucket = Math.min(o.bucket, 0); o.hold = Date.now() + Math.max(50, Number(r.retry_after_ms) || 250)
      o.q.unshift(job); actPump(p); return
    }
    const qd = job.sent - job.t0   // time spent waiting in the queue (not the round trip)
    job.resolve(r && typeof r === 'object' && r.ok !== false && qd > 0 ? { ...r, queued_ms: qd } : r)
  }
  const timer = setTimeout(() => { actRemotePending.delete(rid); done({ ok: false, code: 'owner-unreachable', host, what: `host ${host} did not answer within ${ACT_REMOTE_MS}ms — retry` }) }, ACT_REMOTE_MS)
  timer.unref()
  actRemotePending.set(rid, { resolve: done, timer, sock: p.sock })
  sendFrame(p.sock, { t: 'ACTIVITY_REQ', rid, op: job.op, q: job.q })
  tapRec('sent', { peer: host, kind: 'req', op: job.op })
}
/** A host name as held (case-insensitive), or null. */
function actKnownHost(h) {
  const k = lc(h)
  for (const o of activity.remote.keys()) if (lc(o) === k) return o
  for (const o of actOwner.keys()) if (lc(o) === k) return o
  return null
}
function actRemoteInfo() {
  return Act.remoteInfo(activity).map(x => { const p = peerGw.get(actOwner.get(x.host)); return { ...x, linked: !!(p && p.sock && !p.sock.destroyed) } })
}
// a peer link went away (dropPeer: closed, retired, expired): its in-flight fetches fail, and if it owned a host's slice
// that slice's agents show as GONE until the host returns
function actLinkLost(gw, p, why) {
  if (p && p.act && p.act.timer) { clearTimeout(p.act.timer); p.act.timer = null }
  if (p && p.act) actFailQueue(p.act, 'the link to the owning host dropped while the fetch was queued')   // v1.61.0: its queued fetches too
  for (const [rid, q] of [...actRemotePending]) if (p && q.sock === p.sock) { clearTimeout(q.timer); actRemotePending.delete(rid); q.resolve({ ok: false, code: 'owner-unreachable', host: hostOfGw(gw), what: 'the link to the owning host dropped mid-request' }) }
  const host = hostOfGw(gw)
  if (activity && actOwner.get(host) === gw && Act.markOriginDown(activity, host, Date.now())) { log(`activity: ${host}'s agents show as gone (${why || 'link lost'})`); actDashKick() }
}
// GOING DOWN (the tray's prepare-shutdown, or a clean exit): tell every peer hub now, so their boards show our agents gone
// at once instead of after the link times out. Resolves once the frames are written (≤300 ms) with the number sent.
function actAnnounceDown(reason) {
  if (role !== 'gateway' || !activity || actLegacy()) return Promise.resolve(0)
  const links = [...peerGw.values()].filter(p => p.act && p.act.cap && p.sock && !p.sock.destroyed)
  actDownUntil = Date.now() + ACT_DOWN_HOLD_MS
  if (actDownTimer) clearTimeout(actDownTimer)
  actDownTimer = setTimeout(() => { actDownTimer = null; actDownUntil = 0; for (const p of peerGw.values()) if (p.act && p.act.cap) { p.act.needFull = true; actKick(p) } }, ACT_DOWN_HOLD_MS)   // still alive: back on the boards
  actDownTimer.unref()
  for (const p of links) { sendFrame(p.sock, { t: 'ACTIVITY_DOWN', origin: HOSTNAME, reason }); tapRec('sent', { peer: p.act.host, kind: 'down' }) }
  if (!links.length) return Promise.resolve(0)
  return new Promise(resolve => {
    const t0 = Date.now()
    const tick = () => { if (links.every(p => !p.sock || p.sock.destroyed || !p.sock.writableLength) || Date.now() - t0 > 300) resolve(links.length); else setTimeout(tick, 10) }
    tick()
  })
}
// #70 step 5 (v1.61.0): DASHBOARDS get the merged board as DELTAS, like the gossip — only a dashboard that SUBSCRIBED
// (its Activity view is open: {type:"activity_sub"}; {type:"activity_unsub"} on leave), so one that never opens it pays
// nothing. On subscribe (or {type:"activity_sub", resync:true}): {type:"activity_board", full:true, epoch, seq, head,
// upsert:[every unit]}; then at most once per ACT_GOSSIP_MS, when anything changed (local or remote):
// {type:"activity_delta", epoch, seq, base, head, upsert:[changed units], remove:[unit ids]} — each dashboard diffed against
// its OWN published view (lib/activity.js dashUnits / planDashDelta over boardView raw: reported states + raw times, so
// time passing is never a change; the page computes stale with its own slider). A delta whose `base` isn't the page's
// seq means one was lost → the page asks for a resync. head = { host, now, stale_after_min, remote_hosts, loading? }.
// Requests {type:"activity", ref, query} → {type:"activity", ref, result} (a queued remote fetch first sends
// {type:"activity_queued", ref, wait_ms, position}). Pushes and reads are for DASHBOARDS only, never page leaves (#70
// "Decisions before step 5" 7: registered sessions read with the `activity` tool).
const actDashSubs = () => [...leaves].filter(ws => ws.kind === 'dashboard' && ws.actSub && ws.readyState === 1)
function actDashHead() {
  return { host: HOSTNAME, now: Date.now(), stale_after_min: ACT_CFG.stale_after_min, ...(actReplay && actReplay.phase !== 'done' ? { loading: actReplay.phase } : {}),
    remote_hosts: activity && activity.remote.size ? actRemoteInfo() : [] }
}
const actDashUnits = () => Act.dashUnits(Act.boardView(activity, Date.now(), { raw: true }).map(actShow))
function actDashSubscribe(ws) {   // a full board now (not throttled): the page's view starts from it
  ws.actSub = { pub: new Map(), seq: 1, head: '' }
  const plan = Act.planDashDelta(ws.actSub.pub, actDashUnits(), { full: true }), head = actDashHead()
  ws.actSub.head = JSON.stringify({ ...head, now: 0 })
  try { ws.send(JSON.stringify({ type: 'activity_board', full: true, epoch: ACT_EPOCH, seq: 1, head, upsert: plan.upsert })) } catch { }
}
function actDashKick() {
  if (actDashTimer || role !== 'gateway' || !activity || !actDashSubs().length) return
  actDashTimer = setTimeout(() => {
    actDashTimer = null; actDashLast = Date.now()
    const subs = actDashSubs()
    if (!subs.length || !activity) return
    const units = actDashUnits(), head = actDashHead(), hj = JSON.stringify({ ...head, now: 0 })
    for (const ws of subs) {
      const plan = Act.planDashDelta(ws.actSub.pub, units)
      if (plan.empty && hj === ws.actSub.head) continue
      const base = ws.actSub.seq++
      ws.actSub.head = hj
      try { ws.send(JSON.stringify({ type: 'activity_delta', epoch: ACT_EPOCH, seq: ws.actSub.seq, base, head, upsert: plan.upsert, remove: plan.remove })) } catch { }
    }
  }, Math.max(0, actDashLast + ACT_GOSSIP_MS - Date.now()))
  actDashTimer.unref()
}
// #70 step 5 (v1.61.0): the DOORBELL flag. A session is "armed" while a `listener` leaf on this gateway watches its name
// (+ project); a listener that just closed counts for ACT_BELL_GRACE_MS more (the doorbell script exits on mail and
// re-arms — the bell shouldn't flicker). lib/activity.js setBells marks the local sessions; it rides the gossip header.
const ACT_BELL_GRACE_MS = Number(process.env.AI_BRIDGE_ACTIVITY_BELL_GRACE_MS) || 5000
const actBellClosed = new Map()   // JSON watch -> closed-at
function syncActivityBells() {
  if (!activity || role !== 'gateway') return
  const now = Date.now(), watches = []
  for (const ws of leaves) if (ws.kind === 'listener' && ws.readyState === 1 && ws.watch) watches.push(ws.watch)
  for (const [k, t] of [...actBellClosed]) { if (now - t > ACT_BELL_GRACE_MS) actBellClosed.delete(k); else watches.push(JSON.parse(k)) }
  if (Act.setBells(activity, watches)) actChanged()
}
function actBellClose(ws) {
  if (!ws.watch || !ws.watch.name) return
  actBellClosed.set(JSON.stringify({ name: ws.watch.name, project: ws.watch.project || null }), Date.now())
  setTimeout(syncActivityBells, ACT_BELL_GRACE_MS + 50).unref()
}

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
                  subject: String(env.subject || ''), pattern: String(env.pattern || 'send'), topic: env.topic || null, ...fromTopicMeta(env) },
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
      let r = /** @type {any} */ ({ ok: true })
      if (env && env.id) {
        if (env.to === SESSION) r = await deliver(env)
        else if (isLocalSubId(env.to)) r = deliverSub(env.to, env)
        else r = await deliver(env)        // pre-1.1 senders: target match already enforced at CONNECT
      }
      // #61: CLOSE carries the REAL outcome (was an unconditional code:'ok', which made a project-denied /
      // dead-lettered cross-host send read as success). Pre-1.42 senders ignore the code and still read ok.
      sendFrame(sock, { t: 'CLOSE', code: r && r.ok ? 'ok' : ((r && r.code) || 'failed'),
        ...(r && r.dead_lettered ? { dead_lettered: true } : {}), ...(r && r.dedup ? { dedup: true } : {}) })
    } else if (f.t === 'PING') sendFrame(sock, { t: 'PONG', seq: f.seq })
  })
  sock.on('error', () => {})
})
// The pair port is a HOST-INTERNAL splice target: it is only ever dialed over loopback — the local gateway's
// cross-host CONNECT re-splice and same-host pair-dials both use HOST (127.0.0.1); cross-host peers reach the
// WELL-KNOWN port and the gateway re-splices locally (mergeRemoteRoster rewrites a remote session's port to the
// owning gateway's PORT, so pairPort never crosses a host). Binding it to BIND broke exactly that re-splice on a
// host whose bind is a specific tailnet IP (not 0.0.0.0): pairServer listened on the tailnet IP only, so the
// gateway's dial to 127.0.0.1:pairPort for its OWN sub-peer got ECONNREFUSED -> the peer was reachable inbound
// but undeliverable (target-unreachable) to everyone. Bind to loopback so delivery is independent of the bind IF.
pairServer.listen(0, HOST, () => { pairPort = pairServer.address().port; election() })

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
// #66d: a page by instance — a LOCAL leaf first, else one gossiped from a peer hub (a gateway keeps those in
// remotePages; a follower's `pages` mirror already holds both, the remote ones tagged `origin`).
function pageEntry(inst) { return pages.get(inst) || remotePages.get(inst) || null }
function resolvePageTarget(target) {
  // 'page:<instance>' | bare instance | unique title | unique page_kind -> 'page:<instance>' or null
  const t = String(target)
  const inst = t.startsWith('page:') ? t.slice(5) : t
  if (pageEntry(inst)) return 'page:' + inst
  const cand = [...pages.values()].filter(p => p.title === t || p.page_kind === t)
  if (cand.length === 1) return 'page:' + cand[0].instance
  // #66d: no local match — a unique title/kind among REMOTE pages (a gateway's view; local ones keep precedence)
  const rc = cand.length ? [] : [...remotePages.values()].filter(p => p.title === t || p.page_kind === t)
  return rc.length === 1 ? 'page:' + rc[0].instance : null
}
// #66d: deliver to a page owned by ANOTHER host's gateway: dial that gateway (its well-known port, like a remote
// session) with CONNECT page:<instance>; it hands the envelope to its deliverPage (consent checked THERE, where the
// page lives) and returns the real outcome in the #61 CLOSE code. A page whose gateway is ≤1.47 (no `page_ingress`)
// can't be reached across hosts — say so, don't dial it for a silent/misleading answer.
function routeRemotePage(p, env) {
  if (!p.page_ingress) { emitTrace('send', env, 'page-remote-unsupported'); return { ok: false, code: 'page-remote-unsupported' } }
  emitTrace('send', env, `to-page via ${p.host_label || p.origin}`)
  return dialAndSend(p.port, p.host || HOST, env.to, env)
}

// ---------------------------------------------------------------- outbound routing
function ownerOf(target) {
  if (roster.has(target)) return roster.get(target)
  // stable id (#40): the hosting session is looked up on the roster, not parsed out of the id
  if (String(target).startsWith('peer:')) { const hit = rosterSub(target); return hit ? hit.session : null }
  const parts = String(target).split('/')
  if (parts.length >= 3) return roster.get(parts.slice(0, 2).join('/')) || null   // legacy id: session is embedded
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
      else if (f.t === 'CLOSE') {   // #61: surface the receiver's outcome; a code-less CLOSE (older bridge) reads as ok
        clearTimeout(timer)
        const good = !f.code || f.code === 'ok'
        finish({ ok: good, ...(good ? {} : { code: f.code }), ...(f.dead_lettered ? { dead_lettered: true } : {}), ...(f.dedup ? { dedup: true } : {}) })
      }
    })
    sock.on('error', e => { clearTimeout(timer); finish({ ok: false, code: e.code || 'dial-failed' }) })
  })
}

async function routeEnvelope(env) {
  if (String(env.to).startsWith('page:')) {
    const inst = String(env.to).slice(5)
    if (role === 'gateway') {
      if (!pages.has(inst) && remotePages.has(inst)) return routeRemotePage(remotePages.get(inst), env)   // #66d: another host's page
      return deliverPage(env)
    }
    const rp = pages.get(inst)
    if (rp && rp.origin) return routeRemotePage(rp, env)   // #66d: a follower dials the owning gateway itself (like a remote session)
    if (gwSock && !gwSock.destroyed && pages.has(inst)) {
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

// every LIVE participant of a project, mesh-wide (the roster carries every host's sessions + sub-peers): the audience
// of a system notice to a project (request_project_access; #72 project_access_granted / _revoked).
function projectTargets(toProject) {
  const want = projKey(toProject)
  const targets = []
  for (const sp of subpeers.values()) if (projKey(sp.identity?.project) === want) targets.push(sp.id)   // sub-peer tier
  for (const s of roster.values()) {
    if (projKey(s.project) === want) targets.push(s.session)
    for (const sp of (s.subpeers || [])) if (projKey(sp.project) === want) targets.push(sp.id)
  }
  for (const p of pages.values()) if (projKey(p.identity?.project) === want) targets.push('page:' + p.instance)
  return [...new Set(targets)]
}
// deliver a SYSTEM control message (bypasses project consent) to every participant in a project —
// used by request_project_access to reach a project the requester cannot otherwise see.
async function deliverSystemToProject(toProject, verb, body) {
  let n = 0
  for (const to of projectTargets(toProject)) {
    const env = makeEnvelope({ to, verb, body, subject: `project access request: ${verb}`, from: { session: SESSION, name: NAME, kind: 'session' } })
    env.system = true
    const r = await routeEnvelope(env)
    if (r && r.ok) n++
  }
  return n
}

// #72: tell the GRANTED project that its access to the granting project was granted / changed / revoked. Called ONLY
// from the allow_project / revoke_project handlers, i.e. on the bridge where the grant was MADE — a grant learned via
// GRANTS / PEER_ROSTER gossip goes through consent.merge(), which announces nothing — so the mesh sees ONE notice per
// change. Audience: every live member of the project (projectTargets, mesh-wide) now, plus `extra` ids (a pending
// requester, echoed its request_id — Bug 3 — and never sent twice); a DURABLE registration of that project that is
// live nowhere on the roster gets it PARKED (drained on its next register_self, as §19 parking). Consent: the notice
// runs granting -> granted, which a one-way grant leaves CLOSED, so it rides as `system` — the exemption
// project_access_request and the Bug-3 ack already use. `system` is only ever set by the bridge's own code (never
// from a tool/page argument) and only for these fixed verbs, so it opens no general path. Returns { live, parked, extra }.
async function announceProjectAccess({ verb, subject, body, from, project, extra = new Map(), onlyExtra = false }) {
  const mk = (to, add) => { const env = makeEnvelope({ to, verb, body: JSON.stringify({ ...body, ...(add || {}) }), subject, from }); env.system = true; return env }
  const targets = onlyExtra ? [] : projectTargets(project).filter(t => !extra.has(t))   // onlyExtra: an unchanged re-grant acks requesters only
  const res = await Promise.all([...targets.map(t => ({ t, add: null, x: false })), ...[...extra].map(([t, add]) => ({ t, add, x: true }))]
    .map(async ({ t, add, x }) => { try { const r = await routeEnvelope(mk(t, add)); return { x, ok: !!(r && r.ok) } } catch { return { x, ok: false } } }))
  let parked = 0
  if (PERSIST && !onlyExtra) {   // offline durable members: park (only identities live NOWHERE on the roster — a live one already got it)
    const want = projKey(project), key = (p, u, n) => `${projKey(p)}|${lc(u || '')}|${lc(n || '')}`, liveKeys = new Set()
    for (const sp of subpeers.values()) liveKeys.add(key(sp.identity?.project, sp.identity?.user, sp.name))
    for (const s of roster.values()) for (const sp of (s.subpeers || [])) liveKeys.add(key(sp.project, sp.user, sp.name))
    let regs = []
    try { regs = await persistence.registrations.all() } catch { }
    for (const r of regs) {
      if (!r || !r.name || projKey(r.project) !== want || (r.realm || REALM) !== REALM || liveKeys.has(key(r.project, r.user, r.name))) continue
      liveKeys.add(key(r.project, r.user, r.name))   // one per identity
      const env = mk(`name:${r.name}`)
      try { await persistence.mailbox.put({ realm: r.realm || REALM, project: r.project, user: r.user, name: r.name }, env.id, env); parked++ } catch { continue }
      emitTraceRaw({ dir: 'send', verb, from: from?.session || SESSION, from_name: from?.name || NAME, to: r.name, to_name: r.name, to_kind: 'subpeer',
        subject, pattern: 'send', size: 0, note: `parked for offline peer ${r.name}`, envelope_id: env.id })
    }
  }
  return { live: res.filter(r => !r.x && r.ok).length, extra: res.filter(r => r.x && r.ok).length, parked }
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
function makeEnvelope({ to, verb, body, reply_to, from, subject, pattern, topic, from_topic, from_topic_icon }) {
  const base = from || /** @type {import('./types').EnvelopeFrom} */ ({ session: SESSION, name: NAME, kind: 'session' })
  const f = base.project ? base : { ...base, ...senderIdent(base) }
  const hops = [...(from?.hops || [])]
  // sender joins the chain unless delivering within its own process (itself, or its own sub-peer —
  // otherwise the loop guard in deliverSub would reject a process publishing to its own conversations).
  // "its own sub-peer" must be an OWNERSHIP test, not a prefix test: a stable id (#40) carries no session,
  // so the legacy `to.startsWith(session + '/')` form is kept only for old ids.
  const toOwnSub = (f.session === SESSION && isLocalSubId(to)) || String(to).startsWith(`${f.session}/`)
  if (f.session !== to && !toOwnSub) hops.push(f.session)
  const env = { ts: new Date().toISOString(), from: f,
    to, verb: verb || 'message', subject: String(subject || ''),
    pattern: pattern || 'send', topic: topic || null,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    reply_to: reply_to || null, hops }
  // #54: "sent on behalf of topic X" — ADDITIVE attribution beside `from` (never replacing it: accountability, reply
  // routing, reply-caps and the hop guard all key off the real peer). Callers pass it only after fromTopicOf()
  // validated ownership on THIS bridge, so receivers can trust it like `from`. Absent ⇒ the fields are not set at all.
  if (from_topic) { env.from_topic = from_topic; if (from_topic_icon) env.from_topic_icon = from_topic_icon }
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
      env.reply_cap = profile.capSigner.mint(ck, `${projKey(f.project || 'unclassified')}|${projKey(tp)}|${env.id}|${exp}`)   // #71: projKey'd — case-insensitive like every other project comparison
      env.reply_exp = exp
    }
  }
  encryptEnvelope(env)                          // body ciphered from here; decryptedView at consumption
  return env
}

// #54: may `holder` (a local sub-peer, this process, or a page leaf) speak FOR topic `ref` (send_to_peer `from_topic`)?
// Only a CURRENT owner may: a live role:'owner' claim held by the caller, in the caller's project (any co-owner of a
// shared topic qualifies; a page owns exactly its auto-claimed `subject`). A dormant durable record doesn't count — it
// is not holding the topic now. Checked on the SENDING bridge before the envelope exists; anything else is spoofing.
// Returns { ft } (makeEnvelope fields: the claim's own spelling + its icon — the caller's own claim icon, else any
// co-owner's, so a shared topic reads the same whichever owner speaks) or { err }.
function fromTopicOf(holder, holderProject, ref) {
  const { project, path } = parseTopicRef(ref, holderProject, REALM)
  if (!path || isWildcard(path)) return { err: { ok: false, code: 'wildcard-from-topic', topic: String(ref), hint: 'from_topic must be one concrete topic you own' } }
  let claim = null
  if (projKey(project) === projKey(holderProject)) {
    if (String(holder).startsWith('page:')) {
      const p = pages.get(String(holder).slice(5))
      if (p && p.subject && patternKey(p.subject) === patternKey(path)) claim = { pattern: p.subject, icon: p.icon || null }
    } else {
      const e = myTopics.get(`${holder}|owner|${patternKey(path)}`)
      if (e && projKey(e.project) === projKey(holderProject)) claim = e
    }
  }
  if (!claim) return { err: { ok: false, code: 'not-topic-owner', topic: path, hint: 'you can only send on behalf of a topic you currently own (claim_topic it first)' } }
  const icon = claim.icon || iconOf(path, holderProject)
  return { ft: { from_topic: claim.pattern, ...(icon ? { from_topic_icon: icon } : {}) } }
}
// topic:<topic> send targeting (T3/T5): explicit prefix only. Delivered to the topic's OWNERS —
// exclusive topic = exactly one; shared = every co-owner (one envelope each; dedupe is free).
function askerProjectOf(from) { return (senderIdent(from && from.session ? from : { session: SESSION }).project) || 'unclassified' }
// §16: a directed send to a topic whose durable owner is OFFLINE parks to that owner's mailbox (delivered
// on its return) instead of bouncing no-owner. Consent is checked at park-time (you can only park what you
// could send live). The sender is told it's offline ONLY if the owner opted in at claim time (announce_offline).
async function parkToOfflineOwners(from, project, path, verb, body, reply_to, subject, askerProject, ref, ft) {
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
    const env = makeEnvelope({ to: `topic:${path}`, verb, body, reply_to, from, subject, pattern: 'send', topic: path, ...ft })
    try { await persistence.mailbox.put(ident, env.id, env) } catch { continue }
    parked.push(env.id)
    if (rec.announce_offline) announce.push(rec.holder_name || ident.name)
    emitTraceRaw({ dir: 'send', verb: verb || 'message', from: from?.session || SESSION, from_name: from?.name || NAME,
      to: `topic:${path}`, to_name: path, to_kind: 'topic', subject: subject || null, pattern: 'send', topic: path,
      size: String(body || '').length, note: `parked for offline owner ${ident.name}`, envelope_id: env.id, ...ft })
  }
  if (!parked.length) {
    // #26: no live or dormant owner — but if the topic was kept ALIVE (ownerless) on release, park against the
    // TOPIC itself (synthetic topic-mailbox); the next claimant drains it. Consent-checked against the topic's project.
    let kept = null
    try { kept = await persistence.keptTopics.get(project, path) } catch { }
    if (kept && consent.mayInitiate(ap, projKey(kept.project || project))) {
      const env = makeEnvelope({ to: `topic:${path}`, verb, body, reply_to, from, subject, pattern: 'send', topic: path, ...ft })
      try { await persistence.mailbox.put(topicMailIdent(kept.realm, kept.project || project, path), env.id, env) }
      catch { return { ok: false, code: 'no-owner', topic: ref } }
      emitTraceRaw({ dir: 'send', verb: verb || 'message', from: from?.session || SESSION, from_name: from?.name || NAME,
        to: `topic:${path}`, to_name: path, to_kind: 'topic', subject: subject || null, pattern: 'send', topic: path,
        size: String(body || '').length, note: 'parked for ownerless kept-alive topic', envelope_id: env.id, ...ft })
      return { ok: true, parked: true, ownerless: true, topic: path, project: projName(kept.project || project), envelope_id: env.id,
        ...(kept.announce_offline ? { offline: true } : {}) }
    }
    return { ok: false, code: 'no-owner', topic: ref }
  }
  if (announce.length) return { ok: true, parked: true, offline: true, topic: path, project: projName(project), owners: parked.length, offline_owners: announce }
  return { ok: true, topic: path, project: projName(project) }   // owner chose silence: looks like a normal accept
}
// §19: a directed send to a peer BY NAME that has no LIVE registration but DOES have a durable one (it's
// just offline / its gateway restarted) parks to that peer's mailbox instead of bouncing unknown-target.
// Returns the park result, or null to let the caller fall through to a clear unknown-target.
async function parkToOfflineName(from, name, verb, body, reply_to, subject, askerProject, ft) {
  if (!PERSIST) return null
  let regs = []
  try { regs = await persistence.registrations.byName(name) } catch { return null }
  if (!regs.length) return null
  const ap = projKey(askerProject || 'unclassified')
  const reachable = regs.filter(r => consent.mayInitiate(ap, projKey(r.project)))   // only park what you could send live
  if (!reachable.length) return null
  if (reachable.length > 1) return { ok: false, code: 'ambiguous-name', candidates: reachable.map(r => `${projName(r.project)}:${r.name}`) }
  const r = reachable[0]
  const ident = { realm: r.realm || REALM, project: r.project, user: r.user, name: r.name }
  const env = makeEnvelope({ to: `name:${r.name}`, verb, body, reply_to, from, subject, ...ft })
  try { await persistence.mailbox.put(ident, env.id, env) } catch { return null }
  emitTraceRaw({ dir: 'send', verb: verb || 'message', from: from?.session || SESSION, from_name: from?.name || NAME,
    to: r.name, to_name: r.name, to_kind: 'subpeer', subject: subject || null, pattern: 'send',
    size: String(body || '').length, note: `parked for offline peer ${r.name}`, envelope_id: env.id, ...ft })
  return { ok: true, parked: true, offline: true, to: r.name, project: projName(r.project), envelope_id: env.id }
}
async function routeToTopicOwners(from, ref, verb, body, reply_to, subject, askerProject, ft) {   // ft: #54 validated from_topic fields (or undefined)
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
        owner_projects: [...foreign.values()].map(f => projName(f.name)),
        hint: `"${path}" is owned in another project — request_project_access first, or target it explicitly as @<project>/${path}` }
      if (reachable.length > 1) return { ok: false, code: 'cross-project-ambiguous', topic: path,
        owner_projects: reachable.map(([, f]) => projName(f.name)),
        hint: `"${path}" is owned in several projects you can reach — target one explicitly as @<project>/${path}` }
      owners = reachable[0][1].owners; routedProject = reachable[0][1].name
    }
  }
  if (!owners.length) return parkToOfflineOwners(from, project, path, verb, body, reply_to, subject, askerProject, ref, ft)
  const fanout = []
  for (const h of owners) {
    const env = makeEnvelope({ to: h.holder, verb, body, reply_to, from, subject, pattern: 'send', topic: path, ...ft })
    const r = await routeEnvelope(env)
    fanout.push({ to: h.holder, holder_name: h.holder_name || null, ok: !!r.ok, code: r.code || null, envelope_id: env.id })
  }
  return { ok: fanout.some(f => f.ok), topic: path, project: projName(routedProject),   // #71: canonical spelling
    ...(projKey(routedProject) !== projKey(project) ? { cross_project: projName(routedProject) } : {}), fanout,
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
  return { ok: true, topic: path, project: projName(project), subscribers: subs.length, fanout }   // #71: canonical spelling
}

// ---------------------------------------------------------------- roster sync
// #68: the PUBLIC view of a page entry — an explicit ALLOW-LIST (like localPagesSlice), never a spread. The stored
// entry also holds `capKey`, the page's reply-cap signing key: it stays in the in-memory `pages` map (makeEnvelope
// mints with it, verifyReplyCap checks against it) and must NEVER leave the process — whoever holds it can mint a
// valid reply cap and deliver to that page from a project with no grant (a cross-project consent bypass). Every
// page that goes out (list_sessions, follower ROSTER, WS welcome/roster, dashboards) passes through here. A function
// declaration (hoisted, literals inside) so it is usable from any point of module init.
function publicPage(p) {
  const o = {}
  for (const k of ['instance', 'page_kind', 'title', 'subject', 'subscriptions', 'icon', 'kind', 'project', 'user', 'realm',
    'host_label', 'origin', 'host', 'port', 'page_ingress']) if (p[k] !== undefined) o[k] = p[k]
  if (p.identity && typeof p.identity === 'object') {   // the identity facet's label fields only
    const i = {}
    for (const k of ['realm', 'scheme', 'id', 'project', 'user', 'display', 'assurance']) if (p.identity[k] !== undefined) i[k] = p.identity[k]
    o.identity = i
  }
  return o
}
function rosterPayload() {
  const HOSTNAME = String(SESSION).split('/')[0]
  const localPages = [...pages.values()].map(p => publicPage({ ...p, host_label: HOSTNAME }))   // #68: allow-listed — no capKey
  // is_gateway is true for THIS host's gateway AND for each remote host's gateway (a gossiped entry whose
  // session id equals its origin) — so the dashboard can mark and structure every machine, not just ours.
  return { sessions: [...roster.values()].map(s => ({ ...s, is_gateway: s.session === gatewayId || (!!s.origin && s.session === s.origin), host_label: String(s.session).split('/')[0] })),
    pages: [...localPages, ...[...remotePages.values()].map(publicPage)], hosts: ALIASES, gateway: gatewayId || (role === 'gateway' ? SESSION : null) }
}
// VISIBILITY (§4): a page sees only the projects it may reach (same project / open / static edge),
// so "can't see → can't address" matches the delivery gate. Enforced by default; a page opts out with
// hello { seeAll:true }. Honors the shared-config policy + the runtime grants this bridge knows (since #62 that
// includes grants learned from peers). The raw list_sessions tool stays full (observability).
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
  return displayRoster((ws.kind === 'dashboard' || ws.seeAll || !ws.project || projKey(ws.project) === 'unclassified')   // #71: "Unclassified" is unclassified too
    ? rosterPayload() : rosterPayloadFor(ws.project, ws.realm))
}
function broadcastRoster() {
  syncActivityGone()     // #70: a session that left this host's roster shows as gone (cleared when it returns)
  noteRosterProjects()   // #71: give every roster project a canonical spelling before it goes out
  const frame = { type: 'ROSTER', ...rosterPayload(), grants: consent.grantSet(), realm_defaults: realmDefaults.current(), project_names: projectNames.list() }   // #62: followers merge the grant set (consent is checked in the process hosting the target); #66b: and the realm defaults
  // #66c: the retained set rides a follower's ROSTER only when that follower hasn't had the current version (a new
  // follower has none → the whole set); a follower computes its own sub-peers' subscribe-time catch-up.
  const rv = retainedSet.version()
  for (const [fs0, sock] of followers) {
    if (followerRetainedV.get(fs0) !== rv) { followerRetainedV.set(fs0, rv); sendFrame(sock, { ...frame, retained: retainedSet.list() }) }
    else sendFrame(sock, frame)   // bridges get full; each filters its own leaves
  }
  // listeners are deliberately EXCLUDED from the roster fan-out — a doorbell gets counts, not the mesh (see below)
  for (const ws of leaves) if (ws.readyState === 1 && ws.kind !== 'listener') { try { ws.send(JSON.stringify({ type: 'roster', ...rosterFor(ws) })) } catch {} }
  notifyListeners()
  gossipToPeers()   // §7: push my local slice to peer hubs (no-op unless it actually changed)
}
// --- doorbell (#39). A `listener` leaf watches ONE peer (and/or one topic) and is pushed a compact frame
// the moment mail is WAITING for it, so an idle AI session can block on a script instead of polling every
// few seconds. Deliberately COUNTS ONLY — no sender identities, no roster, no traces, no persistence — which
// is why it needs no per-peer secret (the realm token already gates the socket, and these integers are the
// same ones already gossiped to every dashboard). The woken session then polls its own inbox over MCP, where
// behaviour reminders (#29/#32) ride along on the messages as usual — so "how to act" needs nothing new here.
function listenerState(watch) {
  const nameLc = watch && watch.name ? lc(watch.name) : null
  const projK = watch && watch.project ? projKey(watch.project) : null
  const topicK = watch && watch.topic ? patternKey(watch.topic) : null
  let found = null, direct = 0
  if (nameLc) for (const s of roster.values()) for (const sp of (s.subpeers || [])) {
    if (lc(sp.name) === nameLc && (!projK || projKey(sp.project || '') === projK)) { found = sp.id; direct += Number(sp.unread_direct || 0) }
  }
  const topics = {}
  for (const s of roster.values()) for (const t of (s.topics || [])) {
    const w = Number(t.waiting || 0); if (!w) continue
    if (topicK && patternKey(t.pattern) === topicK) topics[t.pattern] = w
    else if (found && t.holder === found) topics[t.pattern] = w
  }
  return { found, direct, topics }
}
function notifyOne(ws) {
  if (!ws || ws.readyState !== 1 || ws.kind !== 'listener') return
  const st = listenerState(ws.watch || {})
  if (st.found) ws.watchSeen = true   // #73: the watched name was on the roster at some point while this listener was armed
  // a watched NAME that is not on the roster: say so, so the caller re-registers instead of waiting forever.
  // #73: `unknown` = never seen since this listener armed (e.g. not re-registered after a bridge restart) — re-register,
  // don't silently re-arm (that looped); `gone` = it WAS here during this watch and then left.
  if (ws.watch && ws.watch.name && !st.found) { try { ws.send(JSON.stringify({ type: ws.watchSeen ? 'gone' : 'unknown', watch: ws.watch })) } catch {} ; return }
  const total = st.direct + Object.values(st.topics).reduce((a, b) => a + b, 0)
  if (total > 0) { try { ws.send(JSON.stringify({ type: 'mail', peer: st.found, unread_direct: st.direct, topics: st.topics, total })) } catch {} }
}
function notifyListeners() { for (const ws of leaves) if (ws.kind === 'listener') notifyOne(ws) }
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
// #41: verify the CONFIGURED facets are actually backed by this platform and report the truth in CAPS.
// `profile.names` is what the operator asked for (intent); CAPS.recover_secret / presence_confirm are what
// this host can really do. Runs async so a missing/slow helper never blocks startup, and re-broadcasts once
// known so the roster and dashboard stop advertising a capability that isn't there.
async function probeFacet(f) {
  try {
    if (!f || typeof f.probe !== 'function') return { ok: true }   // un-probed facets are assumed backed
    return (await f.probe()) || { ok: false, reason: 'no-result' }
  } catch (e) { return { ok: false, reason: 'probe-error:' + ((e && e.message) || e) } }
}
// #42: the last probe result per facet, surfaced in my_identity as `facet_probe` so the REASON a capability
// is false (and any fix hint, e.g. "tpm helper not built — run build-tpm.cmd") is visible, not just the bit.
const FACET_PROBE = { vault: null, authorizer: null }
async function probeFacets() {
  const v = await probeFacet(profile.vault), a = await probeFacet(profile.authorizer)
  FACET_PROBE.vault = { facet: profile.names.vault, ...v }; FACET_PROBE.authorizer = { facet: profile.names.authorizer, ...a }
  CAPS.recover_secret = !!v.ok
  CAPS.presence_confirm = !!a.ok
  // configured-but-unbacked is the case worth shouting about: it only bites at the moment of need
  if (profile.names.vault !== 'none' && !v.ok) log(`WARN vault="${profile.names.vault}" is NOT backed on this host (${v.reason}${v.detail ? `: ${v.detail}` : ''}) — recover_secret will fail; capabilities.recover_secret=false${v.hint ? ` — ${v.hint}` : ''}`)
  if (profile.names.authorizer !== 'none' && !a.ok) log(`WARN authorizer="${profile.names.authorizer}" is NOT backed on this host (${a.reason}${a.detail ? `: ${a.detail}` : ''}) — presence confirmation will deny; capabilities.presence_confirm=false${a.hint ? ` — ${a.hint}` : ''}`)
  announceCaps()   // #41(c): propagate the probed result — a follower must not leave its stale REGISTER-time caps on the gateway roster
}
setTimeout(() => { probeFacets().catch(() => {}) }, Number(process.env.AI_BRIDGE_PROBE_MS || 50)).unref()   // delay env-tunable so a test can force the register-before-probe ordering (#41c)
// doorbell heartbeat (#39): a watcher that may block for an hour needs to know the link is still alive
// (and to notice a dead bridge) without polling anything.
setInterval(() => {
  const p = JSON.stringify({ type: 'ping', ts: Date.now() })
  for (const ws of leaves) if (ws.kind === 'listener' && ws.readyState === 1) { try { ws.send(p) } catch {} }
}, Number(process.env.AI_BRIDGE_DOORBELL_PING_MS) || 30000).unref()

// ---------------------------------------------------------------- cross-host federation (§7)
// Co-equal per-host hubs find each other through the discovery facet and gossip their LOCAL roster slice
// peer-to-peer. Remote sessions are merged in tagged with `origin` + their owning gateway's address, so
// the existing CONNECT-splice (gateway ingress) delivers to them with no special routing. No central
// node; the smaller ADVERTISE:PORT initiates each link, so there is exactly one connection per pair.
const peerGw = new Map()        // peerGatewaySession -> { sock, host, port, name, outbound, refresh, refresh_ms, seen, sig }
const peerByAddr = new Set()    // "host:port" we hold an OUTBOUND link to (dedupe re-dials)
const remotePages = new Map()   // instance -> page (display fields only) gossiped from a peer hub, tagged with origin + host
let lastGossip = ''
// #63 self-healing federation. Gossip is change-driven and a slice used to go only when its link's socket closed,
// so a peer that restarted/moved port behind a half-open link left stale routing on other hubs FOREVER (LITTLE kept
// the Mac's old port until a manual restart). Now: every link gets a full slice on (re)link; a same-host peer with
// a new session RETIRES the old one; and every GOSSIP_REFRESH_MS each hub re-sends its full slice (+ a PING) to
// every linked peer, and expires a peer not heard from within PEER_EXPIRY_MS. Mixed-version rule: expire ONLY a peer
// that can be proven quiet — one that DECLARES `gossip_refresh` (1.44+, so it really does refresh + PONG), or a link
// WE dialed (every bridge since 1.0 answers PING on its control port). An older peer that dialed US is never expired
// for being quiet (it can neither refresh nor PONG); our periodic writes still surface a truly dead TCP link as RST.
const GOSSIP_REFRESH_MS = Number(process.env.AI_BRIDGE_GOSSIP_REFRESH_MS) || 60000
const PEER_EXPIRY_MS = Number(process.env.AI_BRIDGE_PEER_EXPIRY_MS) || 3 * GOSSIP_REFRESH_MS
const PEER_PROBE_MS = Number(process.env.AI_BRIDGE_PEER_PROBE_MS) || 5000   // same-host/other-port rival: PONG deadline before it's retired
const TEST_GOSSIP = process.env.AI_BRIDGE_TEST_GOSSIP || ''   // test-only: 'silent' = link up, then no gossip/refresh/PONG; 'legacy' = behave like <=1.43 (no flag, no refresh)
const selfAddr = () => `${ADVERTISE}:${PORT}`
const localRosterSlice = () => [...roster.values()].filter(s => !s.origin)   // my own session + my followers (never relayed entries)
// pages live only on a gateway; gossip DISPLAY fields only (never capKey or other secrets) so remote dashboards can show web sessions.
// #66d: plus what a peer needs to ADDRESS the page — its `subscriptions` and `realm` (so allTopicEntries/subscribersOf
// see it) and `page_ingress:true` (this gateway accepts CONNECT page:<instance> from another host). The owning
// gateway's dial address comes from the PEER_ROSTER frame itself. ('legacy' test gossip mimics a ≤1.47 gateway.)
const localPagesSlice = () => [...pages.values()].map(p => ({ instance: p.instance, page_kind: p.page_kind, title: p.title || '', subject: p.subject || null, icon: p.icon || null, project: p.project || null, user: p.user || null,
  ...(TEST_GOSSIP === 'legacy' ? {} : { realm: p.identity?.realm || REALM, subscriptions: (p.subscriptions || []).slice(0, 32), page_ingress: true }) }))
const refreshCap = () => TEST_GOSSIP === 'legacy' ? {} : { gossip_refresh: true, refresh_ms: GOSSIP_REFRESH_MS }   // #63 capability flag
// #62: `grants` = the FULL replicated grant set this hub knows (local + learned), so a grant spreads transitively
// even though the roster slice is one-hop. LWW makes re-gossip safe; a ≤1.44 receiver ignores the field.
// #66b: `realm_defaults` = the winning realm-wide default-reminders record (or null) — same transitive LWW spread; a
// ≤1.46 receiver ignores it.
// #71: `project_names` = the canonical project-spelling map (same transitive spread; a ≤1.56 receiver ignores it).
const gossipFrame = (slice = localRosterSlice(), pg = localPagesSlice(), gr = consent.grantSet(), rd = realmDefaults.current(), pn = projectNames.list()) => ({ t: 'PEER_ROSTER', gateway: SESSION, host: ADVERTISE, port: PORT, sessions: slice, pages: pg, grants: gr, realm_defaults: rd, project_names: pn, ...refreshCap() })
// #70 step 4 (v1.60.0): `activity_gossip:N` = this hub sends + understands ACTIVITY_SLICE / _DOWN / _REQ / _RES in format N (a ≤1.59
// peer ignores the field, never gets the frames, and ignores them if it did; 'legacy' test gossip mimics that). v1.62.0 (#70
// step 6a, the node tree): N = 2 — a 1.60/1.61 peer (N = 1) and this hub exchange no slices or fetches (owner-unsupported)
const peerHello = () => ({ t: 'PEER_HELLO', session: SESSION, name: NAME, host: ADVERTISE, port: PORT, realm: REALM, ...refreshCap(), ...(TEST_GOSSIP === 'legacy' ? {} : { activity_gossip: Act.ACTIVITY_FORMAT }) })
// #66c: `retained` (the replicated retained-value set) is NOT in gossipFrame — it can be MBs and the roster is re-gossiped
// on every unread-count change — so it rides a PEER_ROSTER only when that link hasn't had the set's current version yet
// (a fresh link has none → it gets the whole set). LWW makes a repeat harmless; a ≤1.47 receiver ignores the field.
function sendGossip(p, frame) {
  if (!p || !p.sock || p.sock.destroyed) return
  const v = retainedSet.version()
  if (p.retainedV !== v) { p.retainedV = v; frame = { ...frame, retained: retainedSet.list() } }
  sendFrame(p.sock, frame)
}
function gossipToPeers(force) {
  if (role !== 'gateway' || !peerGw.size || TEST_GOSSIP === 'silent') return
  const slice = localRosterSlice(), pg = localPagesSlice(), gr = consent.grantSet(), rd = realmDefaults.current(), pn = projectNames.list(), sig = JSON.stringify([slice, pg, gr, rd, pn, retainedSet.version()])
  if (!force && sig === lastGossip) return                         // only send when MY locals (or the grant set / realm defaults / project names / retained set) changed (breaks the merge→broadcast→gossip loop)
  lastGossip = sig
  const frame = gossipFrame(slice, pg, gr, rd, pn)
  for (const p of peerGw.values()) sendGossip(p, frame)
}
function mergeRemoteRoster(fromGw, host, port, sessions, pages, sock, grants, realmDefs, retained, projNames) {
  if (!fromGw || fromGw === SESSION) return
  // #63: only the CURRENT link for that gateway may write its slice — a late frame on a retired/replaced socket
  // would otherwise resurrect entries that no peerGw entry owns, and nothing would ever clean them up again.
  const peer = peerGw.get(fromGw)
  if (!peer || peer.sock !== sock) return
  peer.seen = Date.now()
  // #62: fold the peer's grant set in BEFORE the slice dedupe — a grant-only change arrives with an unchanged slice.
  // A change re-broadcasts (followers get it in ROSTER) and re-gossips it onward; an idempotent merge ends the loop.
  const grantsChanged = consent.merge(grants) > 0
  const realmChanged = realmDefaults.merge(realmDefs)   // #66b: likewise the realm defaults (a ≤1.46 peer sends none → no-op)
  const retainedChanged = retainedSet.merge(retained) > 0   // #66c: and retained values (learned ones are persisted; absent field → no-op)
  const namesChanged = projectNames.merge(projNames) > 0     // #71: and the canonical project spellings (a ≤1.56 peer sends none → no-op)
  const sig = JSON.stringify([host, port, sessions, pages])
  if (sig === peer.sig) { if (grantsChanged || realmChanged || retainedChanged || namesChanged) broadcastRoster(); return }   // a periodic refresh of an unchanged slice: stamp only, no broadcast
  peer.sig = sig
  for (const [k, v] of [...roster]) if (v.origin === fromGw) roster.delete(k)   // replace this gateway's slice wholesale
  for (const s of (sessions || [])) {
    if (!s || s.session === SESSION || s.origin) continue          // never let a peer override my own / never re-host a relayed entry
    roster.set(s.session, { ...s, origin: fromGw, host: host || HOST, port: port || PORT })   // dial via the owning gateway
  }
  for (const [k, v] of [...remotePages]) if (v.origin === fromGw) remotePages.delete(k)
  const rhost = String(fromGw).split('/')[0]
  for (const p of (pages || [])) if (p && p.instance) remotePages.set(p.instance, { ...publicPage(p), origin: fromGw, host_label: rhost, host: host || HOST, port: port || PORT })   // #66d: dial the page via its owning gateway; #68: keep only public fields of what a peer sent
  broadcastRoster()
}
function touchPeer(sock) { for (const p of peerGw.values()) if (p.sock === sock) p.seen = Date.now() }
// #63: can we PROVE this peer quiet? A declared refresher PONGs + refreshes; any bridge PONGs on its control port,
// which is the far end of a link WE dialed. An undeclared peer that dialed us can do neither -> never expired.
const provable = p => !!(p.refresh || p.outbound)
const expiryOf = p => Math.max(PEER_EXPIRY_MS, 2 * GOSSIP_REFRESH_MS, 3 * (Number(p.refresh_ms) || 0))   // never tighter than the sender's own cadence
function adoptPeer(peerSession, sock, host, port, name, hello, outbound) {
  if (!peerSession || peerSession === SESSION) return
  const existing = peerGw.get(peerSession)
  if (existing && existing.sock && existing.sock !== sock) { try { existing.sock.destroy() } catch {} }
  const now = Date.now()
  peerGw.set(peerSession, { sock, host, port, name: name || peerSession, outbound: !!outbound,
    refresh: !!(hello && hello.gossip_refresh), refresh_ms: (hello && hello.refresh_ms) || 0, seen: now, sig: null })
  actLinkInit(peerGw.get(peerSession), peerSession, hello)   // #70 step 4: a full activity slice on every (re)link
  emitTraceRaw({ dir: 'con', verb: 'peer', from: peerSession, from_name: name || peerSession, to: SESSION, size: 0,
    note: `peer hub linked (${host}:${port})`, envelope_id: null })
  // #63: a RESTARTED peer (same machine = same hostname prefix AND same advertised host, new gateway session) makes
  // its old entry stale — retire it NOW rather than whenever that socket finally dies. Same port ⇒ certainly a
  // restart (two live gateways can't both hold one host:port). Other port ⇒ it may be a live rival (split-brain /
  // two loopback test "hosts"), so PING it and retire only if a provable peer stays silent. Different machines never match.
  const hn = s => String(s).split('/')[0]
  if (lc(hn(peerSession)) === lc(HOSTNAME)) warnDupHost(hn(peerSession), `this hub (${SESSION} at ${ADVERTISE}:${PORT})`, `peer hub ${peerSession} at ${host}:${port}`)   // #70 step 5
  for (const [id, p] of [...peerGw]) {
    if (id === peerSession || hn(id) !== hn(peerSession)) continue
    if (p.host !== host) { warnDupHost(hn(id), `peer hub ${id} at ${p.host}:${p.port}`, `peer hub ${peerSession} at ${host}:${port}`); continue }   // #70 step 5: two machines, one name
    if (Number(p.port) === Number(port)) { retirePeer(id, `replaced by restarted ${peerSession}`); continue }
    if (!provable(p) || !p.sock || p.sock.destroyed) continue
    const t0 = Date.now()
    sendFrame(p.sock, { t: 'PING', seq: 0 })
    const tm = setTimeout(() => {
      if (peerGw.get(id) === p && p.seen < t0) retirePeer(id, `silent after same-host peer ${peerSession} linked`)
      else if (peerGw.get(id) === p && peerGw.has(peerSession)) warnDupHost(hn(id), `peer hub ${id} at ${p.host}:${p.port}`, `peer hub ${peerSession} at ${host}:${port}`)   // #70 step 5: both alive — a live duplicate, not a restart
    }, PEER_PROBE_MS)
    if (tm.unref) tm.unref()
  }
}
// #70 step 5 (v1.61.0, "Decisions before step 5" 8): DUPLICATE HOST NAMES are accepted, but logged. The host name (the
// prefix of a gateway's session id) is the activity origin and #63's same-machine test, so two live hubs with the same
// name and different addresses / sessions fight over one activity slice. One WARN per name per DUP_HOST_WARN_MS.
const DUP_HOST_WARN_MS = Number(process.env.AI_BRIDGE_DUP_HOST_WARN_MS) || 600000
const dupHostWarned = new Map()   // lc(host name) -> last warned at
function warnDupHost(name, a, b) {
  const k = lc(name), now = Date.now()
  if (now - (dupHostWarned.get(k) || 0) < DUP_HOST_WARN_MS) return
  dupHostWarned.set(k, now)
  log(`WARN duplicate host name "${name}": ${a} and ${b} both claim it — the activity board keys a host by its name, so their activity slices will overwrite each other (#70)`)
}
function dropPeer(peerSession, why) {
  if (!peerGw.has(peerSession)) return
  const gone = peerGw.get(peerSession)
  peerGw.delete(peerSession)
  actLinkLost(peerSession, gone, why)   // #70 step 4: its fetches fail; the host's activity shows as gone until it returns
  let changed = false
  for (const [k, v] of [...roster]) if (v.origin === peerSession) { roster.delete(k); changed = true }
  for (const [k, v] of [...remotePages]) if (v.origin === peerSession) { remotePages.delete(k); changed = true }
  emitTraceRaw({ dir: 'con', verb: 'offline', from: peerSession, from_name: peerSession, to: SESSION, size: 0,
    note: why ? `peer hub offline (${why})` : 'peer hub offline', envelope_id: null })
  if (changed) broadcastRoster()
}
// #63: drop a peer's slice AND its socket (an outbound close frees peerByAddr, so discovery re-dials it)
function retirePeer(peerSession, why) {
  const p = peerGw.get(peerSession)
  if (!p) return
  log(`peer hub ${peerSession} retired: ${why}`)
  dropPeer(peerSession, why)
  try { p.sock && p.sock.destroy() } catch {}
}
function connectToPeer(host, port) {
  const addr = `${host}:${port}`
  if (peerByAddr.has(addr)) return
  peerByAddr.add(addr)
  // One dial on the candidate's port (discovery hands us the realm's shared port). If it yields no peer link we
  // free the address so a later discovery tick retries it.
  let linked = false, peerSession = null
  const sock = profile.transport.connect(port, host)
  const giveUp = setTimeout(() => { if (!linked) { try { sock.destroy() } catch {} } }, 4000)
  if (giveUp.unref) giveUp.unref()
  sock.on('connect', () => {
    sendFrame(sock, { t: 'HELLO', ver: VER, fromBridge: SESSION, fromSession: SESSION, name: NAME, auth: TOKEN })
    sendFrame(sock, peerHello())
    sendFrame(sock, gossipFrame())
  })
  onFrames(sock, f => {
    if (f.t === 'PEER_HELLO') {
      linked = true; clearTimeout(giveUp); peerSession = f.session; adoptPeer(f.session, sock, f.host || host, f.port || port, f.name, f, true)
      sendGossip(peerGw.get(f.session), gossipFrame())   // #63: the connect-time frame may predate a change gossipToPeers sent before this link was adopted (#66c: + the retained set)
    }
    else if (f.t === 'PEER_ROSTER') mergeRemoteRoster(f.gateway, f.host, f.port, f.sessions, f.pages, sock, f.grants, f.realm_defaults, f.retained, f.project_names)
    else if (f.t === 'ACTIVITY_SLICE' || f.t === 'ACTIVITY_DOWN' || f.t === 'ACTIVITY_REQ' || f.t === 'ACTIVITY_RES') onActivityFrame(sock, f)   // #70 step 4
    else if (f.t === 'PING') { if (!TEST_GOSSIP) sendFrame(sock, { t: 'PONG', seq: f.seq }) }   // #63: the accepting hub probes us too (<=1.43 dialers ignore PING — 'legacy' mimics that)
    else if (f.t === 'PONG') touchPeer(sock)
    else if (f.t === 'REJECT') { try { sock.destroy() } catch {} }
  })
  sock.on('close', () => {
    clearTimeout(giveUp)
    peerByAddr.delete(addr)   // linked or not, let a later discovery tick re-dial this address
    if (linked && peerSession && peerGw.get(peerSession)?.sock === sock) dropPeer(peerSession)
  })
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
// #63 peer-link heartbeat: expire provably-quiet peers, then re-send the full slice to every refresh-capable peer
// (re-stamping its view of our port) and PING every link (liveness for links we dialed; any write also surfaces a
// dead half-open TCP link as RST). A receiver stamps only on an unchanged slice, so this costs ~2 frames/peer/min.
let pingSeq = 0
setInterval(() => {
  if (role !== 'gateway' || !peerGw.size || TEST_GOSSIP === 'legacy') return   // test-only 'legacy' mimics <=1.43: no expiry, no refresh
  const now = Date.now()
  for (const [id, p] of [...peerGw]) if (provable(p) && now - p.seen > expiryOf(p)) retirePeer(id, `expired: nothing heard for ${now - p.seen}ms`)
  if (TEST_GOSSIP) return   // test-only: a silent/legacy peer sends no refreshes and no probes
  const frame = gossipFrame(), ping = { t: 'PING', seq: ++pingSeq }
  actUnits = null   // #70 step 4: recompute the activity units once a minute whatever the change signals said
  for (const p of peerGw.values()) {
    if (!p.sock || p.sock.destroyed) continue
    if (p.refresh) sendGossip(p, frame)   // an older receiver would re-merge + re-broadcast an unchanged slice; it can't expire, so skip it
    sendFrame(p.sock, ping)
    if (p.act && p.act.cap) { p.act.beat = true; actKick(p) }   // #70 step 4: a sync beat (or the pending delta) through the 1/s scheduler
  }
}, GOSSIP_REFRESH_MS).unref()

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
  server.on('connection', onControlConn)
  failActivityPending('gateway-lost', 'this bridge became the gateway mid-call — retry'); gwRegistered = false
  startActivity()    // #70: this host's activity board + its daily JSONL are owned here now (replayed in the background)
  startWsIngress(WS_PORT)
  broadcastRoster()
  maybeLaunchTray()
  startDiscovery()   // §7: begin enumerating + linking peer hubs across machines (no-op for discovery=none)
}

// A follower/peer control connection on :PORT. `who` is per-connection (set by HELLO before any privileged frame
// is honoured).
function onControlConn(sock) {
    let who = null
    let pageTarget = null   // #66d: set by an accepted CONNECT page:<instance>
    onFrames(sock, async f => {
      if (f.t === 'HELLO') {
        if (!profile.auth.verify(f.auth)) { sendFrame(sock, { t: 'REJECT', code: 'unauthorized' }); sock.end(); return }
        who = f
      } else if (f.t === 'REGISTER') {                       // follower control connection
        if (!who) { sendFrame(sock, { t: 'REJECT', code: 'no-hello' }); sock.end(); return }
        roster.set(f.session, { session: f.session, name: f.name, port: f.port, kind: 'session', subpeers: f.subpeers || [], topics: f.topics || [], bridge_version: f.bridge_version || null, capabilities: f.capabilities || null, connected_at: new Date().toISOString(), realm: f.realm || REALM, project: f.project || null, user: f.user || null, client: f.client || null, client_kind: clientKind(f.client) })
        followers.set(f.session, sock); followerRetainedV.delete(f.session)   // #66c: a (re)registered follower gets the whole retained set
        emitTraceRaw({ dir: 'con', verb: 'connect', from: f.session, from_name: f.name, to: SESSION, size: 0,
          note: `session joined${f.client ? ' (' + f.client + ')' : ''}`, envelope_id: null })
        sock.on('close', () => {
          followers.delete(f.session); followerRetainedV.delete(f.session); const gone = roster.get(f.session); roster.delete(f.session)
          emitTraceRaw({ dir: 'con', verb: 'offline', from: f.session, from_name: gone ? gone.name : f.name, to: SESSION, size: 0,
            note: 'session offline', envelope_id: null })
          broadcastRoster()
        })
        sendFrame(sock, { t: 'REGISTERED', session: f.session })
        broadcastRoster()
      } else if (f.t === 'SET_NAME') {
        const r = roster.get(f.session); if (r) { r.name = f.name; broadcastRoster() }
      } else if (f.t === 'CAPS') {                          // #41(c): a follower's capabilities changed post-connect (facet probe)
        const r = roster.get(f.session); if (r) { r.capabilities = f.capabilities || r.capabilities; broadcastRoster() }
      } else if (f.t === 'SUBPEERS') {
        const r = roster.get(f.session); if (r) { r.subpeers = f.subpeers || []; broadcastRoster() }
      } else if (f.t === 'TOPICS') {
        const r = roster.get(f.session); if (r) { r.topics = f.topics || []; broadcastRoster() }
      } else if (f.t === 'SET_CLIENT') {
        const r = roster.get(f.session); if (r) { r.client = f.client || null; r.client_kind = clientKind(f.client); broadcastRoster() }
      } else if (f.t === 'GRANTS') {                        // #62: a follower's grant set (its own allow/revoke) goes UP to be merged + gossiped
        if (!who) return                                     // policy frame: only on an authenticated (HELLO'd) connection
        if (consent.merge(f.grants) > 0) broadcastRoster()   // → ROSTER to every follower + gossip to every peer hub
      } else if (f.t === 'REALM_DEFAULTS') {                // #66b: a follower's realm-defaults record (from its own config) goes UP
        if (!who) return                                     // policy frame: only on an authenticated (HELLO'd) connection
        if (realmDefaults.merge(f.realm_defaults)) broadcastRoster()   // LWW: an older record changes nothing
      } else if (f.t === 'PROJECT_NAMES') {                 // #71: a follower's project sightings go UP to be merged + spread
        if (!who) return                                     // only on an authenticated (HELLO'd) connection
        if (projectNames.merge(f.project_names) > 0) broadcastRoster()   // earliest first_seen wins: a later spelling changes nothing
      } else if (f.t === 'RETAINED') {                      // #66c: a follower's retained publish(es) go UP to be merged + spread
        if (!who) return                                     // policy frame: only on an authenticated (HELLO'd) connection
        if (retainedSet.merge(f.retained) > 0) broadcastRoster()   // LWW: an older value changes nothing
      } else if (f.t === 'ACTIVITY') {                      // #70: a follower's log / activity call (it authenticated its own sub-peer)
        const reply = result => { try { sendFrame(sock, { t: 'ACTIVITY_R', rid: f.rid, result }) } catch { } }
        if (!who || !f.session || followers.get(f.session) !== sock) { reply({ ok: false, code: 'unauthorized', what: 'activity frames are accepted only from a registered follower' }); return }
        tapRec('recv', { peer: 'follower', kind: 'fwd', op: f.op, items: f.input && Array.isArray(f.input.items) ? f.input.items.length : null })   // test-only: v1.62.0 — a batch arrives as ONE frame
        if (f.op === 'log') {
          const id = f.ident || {}, fr = roster.get(f.session)
          const known = !!fr && (fr.subpeers || []).some(sp => ciEq(sp.name, id.session) && projKey(sp.project) === projKey(id.project) && lc(sp.user) === lc(id.user) && (sp.realm || REALM) === (id.realm || REALM))
          if (!known) { reply({ ok: false, code: 'unknown-subpeer', what: 'that session is not registered on the forwarding bridge' }); return }
          activityLog({ realm: id.realm || REALM, project: id.project, user: id.user, session: id.session, host: HOSTNAME }, f.input || {}).then(reply, e => reply({ ok: false, code: 'gateway-error', what: String((e && e.message) || e) }))
        } else if (f.op === 'read') activityRead(f.query || {}, { maxWaitMs: Math.max(0, ACT_FWD_MS - ACT_REMOTE_MS - 300) }).then(reply, e => reply({ ok: false, code: 'gateway-error', what: String((e && e.message) || e) }))   // v1.61.0: a queued remote fetch must answer inside the follower's timeout
        else reply({ ok: false, code: 'bad-op', what: `unknown activity op ${f.op}` })
      } else if (f.t === 'TRACE') {
        traces.collect(f.trace)
      } else if (f.t === 'PAGE_MSG') {                       // follower forwarding an envelope to a page leaf
        // #66d: routeEnvelope = deliverPage for a local page, or the cross-host dial for a remote one (a ≤1.47 follower
        // forwards every page it sees here, remote ones included)
        if (f.env && String(f.env.to || '').startsWith('page:')) routeEnvelope(f.env).catch(() => {})
      } else if (f.t === 'CONNECT') {                        // cross-host ingress: splice to local target
        if (!who) { sendFrame(sock, { t: 'REJECT', code: 'no-hello' }); sock.end(); return }
        // #66d: a PAGE target is delivered by THIS gateway (pages live here, not behind a pair port): ACCEPT, then the
        // MSG below goes to deliverPage and its real outcome returns in the #61 CLOSE code. ('legacy' mimics ≤1.47,
        // which fell through to ownerOf → unknown-target.)
        if (String(f.target || '').startsWith('page:') && TEST_GOSSIP !== 'legacy') {
          if (!pages.has(String(f.target).slice(5))) { sendFrame(sock, { t: 'REJECT', code: 'page-gone' }); sock.end(); return }
          pageTarget = String(f.target)
          sendFrame(sock, { t: 'ACCEPT', connId: crypto.randomBytes(4).toString('hex') })
          return
        }
        const peer = ownerOf(f.target)
        if (!peer) { sendFrame(sock, { t: 'REJECT', code: 'unknown-target' }); sock.end(); return }
        const out = profile.transport.connect(peer.port, peer.host || HOST)
        out.on('connect', () => {
          sendFrame(out, { t: 'HELLO', ver: VER, fromBridge: who.fromBridge, fromSession: who.fromSession, name: who.name, auth: profile.auth.credential() })
          sendFrame(out, { t: 'CONNECT', target: f.target })
          sock.removeAllListeners('data'); out.pipe(sock); sock.pipe(out)   // splice-opaque from here
        })
        out.on('error', () => { sendFrame(sock, { t: 'REJECT', code: 'target-unreachable' }); sock.end() })
      } else if (f.t === 'MSG') {                            // #66d: the envelope for an ACCEPTed page target
        if (!pageTarget) return
        const env = f.body
        const r = /** @type {any} */ (env && env.id && env.to === pageTarget ? deliverPage(env) : { ok: false, code: 'target-mismatch' })
        sendFrame(sock, { t: 'CLOSE', code: r && r.ok ? 'ok' : ((r && r.code) || 'failed') })
      } else if (f.t === 'PEER_HELLO') {                     // inbound cross-host hub link (§7)
        if (!who) { sendFrame(sock, { t: 'REJECT', code: 'no-hello' }); sock.end(); return }
        if (f.realm && f.realm !== REALM) { sendFrame(sock, { t: 'REJECT', code: 'realm-mismatch' }); sock.end(); return }
        adoptPeer(f.session, sock, f.host, f.port, f.name, f, false)
        sendFrame(sock, peerHello())
        sendGossip(peerGw.get(f.session), gossipFrame())   // #63: full slice on every (re)link, independent of lastGossip (#66c: + the retained set)
        sock.on('close', () => { if (peerGw.get(f.session)?.sock === sock) dropPeer(f.session) })
      } else if (f.t === 'PEER_ROSTER') {
        mergeRemoteRoster(f.gateway, f.host, f.port, f.sessions, f.pages, sock, f.grants, f.realm_defaults, f.retained, f.project_names)
      } else if (f.t === 'ACTIVITY_SLICE' || f.t === 'ACTIVITY_DOWN' || f.t === 'ACTIVITY_REQ' || f.t === 'ACTIVITY_RES') {   // #70 step 4: only from an adopted peer-hub link
        onActivityFrame(sock, f)
      } else if (f.t === 'PONG') {
        touchPeer(sock)
      } else if (f.t === 'PING') { if (TEST_GOSSIP !== 'silent') sendFrame(sock, { t: 'PONG', seq: f.seq }) }
    })
    sock.on('error', () => {})
}

// WS leaf ingress on ONE ws port — served on an HTTP server so the dashboard loads from http://127.0.0.1:<port>
// (same origin as the WS). file:// pages are blocked from ws://127.0.0.1 by Chrome PNA; http isn't.
function startWsIngress(wsPort) {
  try {
    const httpd = profile.transport.createHttpServer((req, res) => {
      let u = decodeURIComponent(String(req.url || '/').split('?')[0])
      if (u.startsWith('/admin/')) { adminHttp(req, res, u); return }   // #70 step 3: /admin/prepare-shutdown (loopback + bearer token)
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
    httpd.listen(wsPort, BIND)
    wss = profile.transport.createWsServer({ server: httpd })
    wss.on('connection', onWsConnection)
    wss.on('error', e => log('ws server error', e.code))
  } catch (e) { log('ws listener failed', e.code) }
}

// #70 step 3 (v1.59.0): the gateway's admin endpoint, for the Task Tray. POST /admin/prepare-shutdown with
// `Authorization: Bearer <realm token>` (never in the URL), from a LOOPBACK caller only → flushActivityNow() → 200
// { ok, flushed:{cp, rep, files_drained[, skipped]}, ms }. Wrong method 405, non-loopback 403, missing/bad token 401,
// unknown path 404. The tray calls it right before it kills the bridges, then kills them whatever the answer.
const isLoopback = a => { const s = String(a || '').toLowerCase().replace(/^::ffff:/, ''); return s === '::1' || /^127\./.test(s) }
const bearerOf = req => { const m = String(req.headers.authorization || '').match(/^\s*Bearer\s+(\S+)\s*$/i); return m ? m[1] : '' }
function adminHttp(req, res, u) {
  const reply = (code, body) => { try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) } catch { } }
  req.resume()   // no request body is needed — drain whatever came
  if (!isLoopback(req.socket && req.socket.remoteAddress)) { log(`admin: refused ${u} from non-loopback ${req.socket && req.socket.remoteAddress}`); return reply(403, { ok: false, code: 'loopback-only', what: 'admin endpoints answer loopback callers only' }) }
  if (u !== '/admin/prepare-shutdown') return reply(404, { ok: false, code: 'not-found' })
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, { ok: false, code: 'method-not-allowed', what: 'POST only' }) }
  const tok = bearerOf(req)
  if (!profile.auth.verify(tok)) return reply(401, { ok: false, code: tok ? 'unauthorized' : 'token-required', what: 'send Authorization: Bearer <realm token>' })
  const t0 = Date.now()
  flushActivityNow().then(async flushed => {
    const down = await actAnnounceDown('prepare-shutdown')   // #70 step 4: after the flush, tell the peer hubs (their boards show our agents gone at once)
    log(`admin: prepare-shutdown — flushed ${flushed.cp} checkpoint(s), ${flushed.rep} repeat line(s)${flushed.skipped ? ` (${flushed.skipped})` : ''}, going-down notice to ${down} peer hub(s), in ${Date.now() - t0}ms`)
    reply(200, { ok: true, role, bridge_version: BRIDGE_VERSION, flushed, down_notified: down, ms: Date.now() - t0 })
  }, e => reply(500, { ok: false, code: 'flush-failed', what: String((e && e.message) || e) }))
}

// A WS leaf connection (listener / page / dashboard).
function onWsConnection(ws) {
      ws.on('message', async raw => {
        let m = null; try { m = JSON.parse(raw.toString()) } catch { return }
        if (m.type === 'hello') {
          if (ws.kind && ws.kind !== 'logger') { try { ws.send(JSON.stringify({ type: 'error', code: 'already-hello', what: 'one hello per connection' })) } catch {} ; return }   // v1.61.0 (#70 step 5): a page can't re-hello into a dashboard
          if (!profile.auth.verify(m.token)) {
            if (m.kind === 'logger') { try { ws.send(JSON.stringify({ type: 'error', code: 'unauthorized', what: 'bad realm token' })) } catch {} }   // #70 step 3: the script says why
            ws.close(); return
          }
          if (m.kind === 'listener') {     // T14 wake attach point — the doorbell (#39). Counts-only, no secret.
            ws.kind = 'listener'
            ws.instance = m.instance || crypto.randomBytes(4).toString('hex')
            const w = m.watch || {}
            ws.watch = { name: w.name || m.name || null, project: w.project || m.project || null, topic: w.topic || null }
            if (!ws.watch.name && !ws.watch.topic) {
              try { ws.send(JSON.stringify({ type: 'error', code: 'watch-required', what: 'listener needs watch.name and/or watch.topic' })) } catch {}
              ws.close(); return
            }
            leaves.add(ws)
            syncActivityBells()   // #70 step 5: the watched session's 🔔 on the activity board
            log(`listener connected: watch=${JSON.stringify(ws.watch)} (${ws.instance})`)
            try { ws.send(JSON.stringify({ type: 'welcome', instance: ws.instance, gateway: SESSION, bridge_version: BRIDGE_VERSION, capabilities: CAPS, realm: REALM, watch: ws.watch })) } catch {}
            notifyOne(ws)   // fire IMMEDIATELY if mail is already waiting — arming must not miss what's already there
            return
          }
          if (m.kind === 'logger' || ws.kind === 'logger') {   // #70 step 3: tools/aimb-log.mjs — token-gated, no sub-peer; NOT in leaves/pages (never on the roster)
            if (ws.kind) { try { ws.send(JSON.stringify({ type: 'error', code: 'already-hello', what: 'one hello per connection' })) } catch {} ; ws.close(); return }
            const li = loggerIdent(m)
            if (li.err) { try { ws.send(JSON.stringify({ type: 'error', ...li.err })) } catch {} ; ws.close(); return }
            ws.kind = 'logger'; ws.ident = li.ident; ws.instance = crypto.randomBytes(4).toString('hex')
            try { ws.send(JSON.stringify({ type: 'welcome', logger: true, instance: ws.instance, gateway: SESSION, bridge_version: BRIDGE_VERSION, realm: REALM, host: HOSTNAME,
              ident: { project: projName(li.ident.project), user: li.ident.user, session: li.ident.session } })) } catch {}
            return
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
              icon: m.icon || null, kind: 'page', capKey: capKeyFrom(pageCapKeyInput({ token: TOKEN, instance: ws.instance })),   // #43: not derivable from the published instance
              identity: pident, project: pident.project, user: pident.user })
            ws.project = pident.project; ws.realm = pident.realm; ws.seeAll = !!m.seeAll   // visibility scope (§4)
            if (projKey(pident.project) !== 'unclassified') noteProject(pident.project)   // #71: a page is a sighting too (broadcastRoster below spreads it)
          }
          leaves.add(ws)
          log(`${ws.kind} connected: ${m.page_kind || ws.kind} "${m.title || ''}" (${ws.instance})`)
          if (ws.kind === 'page') emitTraceRaw({ dir: 'con', verb: 'connect', from: `page:${ws.instance}`, from_name: m.title || m.page_kind || 'page', to: SESSION, size: 0, note: `page joined (${m.page_kind || 'page'})`, envelope_id: null })
          ws.send(JSON.stringify({ type: 'welcome', instance: ws.instance, gateway: SESSION, bridge_version: BRIDGE_VERSION, profile: profile.names, capabilities: CAPS, realm: REALM, ...rosterFor(ws) }))
          if (ws.kind === 'dashboard') { ws.send(JSON.stringify({ type: 'trace_history', traces: traces.history() })); pushPersistence(ws) }
          broadcastRoster()
        } else if (m.type === 'log' && ws.kind === 'logger') {   // #70 step 3: one report → { type:'logged', ref, result } (the `log` tool's result shape)
          let result
          try { result = await loggerLog(ws.ident, m.input) } catch (e) { result = { ok: false, code: 'gateway-error', what: String((e && e.message) || e) } }
          try { ws.send(JSON.stringify({ type: 'logged', ref: m.ref != null ? m.ref : null, result })) } catch {}
        } else if (ws.kind === 'logger') {
          try { ws.send(JSON.stringify({ type: 'logged', ref: m.ref != null ? m.ref : null, result: { ok: false, code: 'bad-op', what: `a logger sends only {type:"log"} (got ${JSON.stringify(String(m.type)).slice(0, 40)})` } })) } catch {}
        } else if ((m.type === 'activity' || m.type === 'activity_sub' || m.type === 'activity_unsub') && ws.kind !== 'dashboard') {   // #70 step 5: dashboards only — never a page leaf
          const deny = { ok: false, code: 'dashboard-only', what: 'the activity board is for dashboards and registered sessions (the activity tool), not page leaves' }
          try { ws.send(JSON.stringify(m.type === 'activity' ? { type: 'activity', ref: m.ref != null ? m.ref : null, result: deny } : { type: 'activity_board', ...deny })) } catch {}
        } else if (m.type === 'activity_sub') {   // #70 step 5: the Activity view opened (or a resync after a seq gap) → a full board, then deltas
          if (role !== 'gateway' || !activity) { try { ws.send(JSON.stringify({ type: 'activity_board', ok: false, code: 'not-gateway', what: 'this bridge does not hold the activity board' })) } catch {} ; return }
          if (!ACT_CFG.enabled) { try { ws.send(JSON.stringify({ type: 'activity_board', ...actDisabled() })) } catch {} ; return }
          actDashSubscribe(ws)
        } else if (m.type === 'activity_unsub') {
          ws.actSub = null
        } else if (m.type === 'activity') {   // #70 step 4: the mesh board / a log page / an entry (the `activity` tool's query)
          const q = {}, ref = m.ref != null ? m.ref : null
          for (const k of BOARD_FIELDS) if (m.query && typeof m.query === 'object' && m.query[k] !== undefined) q[k] = m.query[k]
          let result
          const onQueued = info => { try { ws.send(JSON.stringify({ type: 'activity_queued', ref, ...info })) } catch {} }   // v1.61.0: the page shows a spinner
          try { result = await activityRead(q, { ws, onQueued }) } catch (e) { result = { ok: false, code: 'gateway-error', what: String((e && e.message) || e) } }
          try { ws.send(JSON.stringify({ type: 'activity', ref, result })) } catch {}
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
          // #54: a page may send on behalf of the topic it owns — its auto-claimed `subject` — validated like send_to_peer
          let ft
          if (m.from_topic != null && String(m.from_topic).trim()) {
            const v = fromTopicOf(from.session, askerProjectOf(from), String(m.from_topic).trim())
            if (v.err) { ws.send(JSON.stringify({ type: 'sent', ref: m.ref || null, ok: false, code: v.err.code, topic: v.err.topic })); return }
            ft = v.ft
          }
          if (String(m.to || '').startsWith('topic:')) {                 // page -> topic owners (T3)
            const r = /** @type {any} */ (await routeToTopicOwners(from, String(m.to).slice(6).trim(), m.verb, m.body, null, String(m.subject).trim(), askerProjectOf(from), ft))
            ws.send(JSON.stringify({ type: 'sent', ref: m.ref || null, ok: !!r.ok, code: r.code || null,
              envelope_id: r.envelope_id || null, fanout: r.fanout || null }))
            return
          }
          const env = makeEnvelope({ to: m.to, verb: m.verb, body: m.body, from, subject: String(m.subject).trim(), ...ft })
          let r
          if (m.to === SESSION) { r = await deliver(env); emitTrace('send', env, 'leaf->gateway') }
          else if (isLocalSubId(m.to)) { r = deliverSub(m.to, env); emitTrace('send', env, 'leaf->subpeer') }
          else if (String(m.to || '').startsWith('page:')) { r = await routeEnvelope(env) }   // page -> page (gateway-side; #66d: a remote page via its owning gateway)
          else {
            const peer = ownerOf(m.to)
            if (!peer) r = { ok: false, code: 'unknown-target' }
            else { emitTrace('send', env, 'leaf'); r = await dialAndSend(peer.port, peer.host || HOST, m.to, env) }
          }
          ws.send(JSON.stringify({ type: 'sent', ref: m.ref || null, ok: !!r.ok, code: r.code || null, envelope_id: env.id }))
        }
      })
      ws.on('close', () => {
        if (ws.kind === 'logger') return   // #70 step 3: never on the roster — nothing to announce (and a 1/s script would flood the log)
        if (ws.kind) log(`${ws.kind} disconnected (${ws.instance})`)
        if (ws.kind === 'listener') actBellClose(ws)   // #70 step 5: the bell stays for a short grace (the doorbell re-arms)
        ws.actSub = null
        if (ws.kind === 'page') {
          const p = pages.get(ws.instance)
          emitTraceRaw({ dir: 'con', verb: 'offline', from: `page:${ws.instance}`, from_name: p ? (p.title || p.page_kind) : 'page', to: SESSION, size: 0, note: 'page offline', envelope_id: null })
        }
        leaves.delete(ws); if (ws.kind === 'page') pages.delete(ws.instance); broadcastRoster()
      })
      ws.on('error', () => {})
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
    sendFrame(sock, { t: 'GRANTS', session: SESSION, grants: consent.grantSet() })   // #62: anything granted/learned while not following (a ≤1.44 gateway ignores it)
    if (realmDefaults.current()) sendFrame(sock, { t: 'REALM_DEFAULTS', session: SESSION, realm_defaults: realmDefaults.current() })   // #66b: likewise (a ≤1.46 gateway ignores it)
    if (retainedSet.size()) sendFrame(sock, { t: 'RETAINED', session: SESSION, retained: retainedSet.list() })   // #66c: likewise (a ≤1.47 gateway ignores it)
    if (projectNames.size()) sendFrame(sock, { t: 'PROJECT_NAMES', session: SESSION, project_names: projectNames.list() })   // #71: likewise (a ≤1.56 gateway ignores it)
    log(`follower registered with gateway on :${PORT}`)
  })
  onFrames(sock, f => {
    if (f.t === 'RENAME') { NAME = f.name }
    else if (f.t === 'REGISTERED') { gwRegistered = true; flushPendingTraces() }
    else if (f.t === 'ACTIVITY_R') { const p = actPending.get(f.rid); if (p) { clearTimeout(p.timer); actPending.delete(f.rid); p.resolve(f.result) } }   // #70
    else if (f.type === 'ROSTER') {
      roster = new Map(f.sessions.map(s => [s.session, s]))
      pages = new Map((f.pages || []).filter(p => p && p.instance).map(p => [p.instance, publicPage(p)]))   // #68: a ≤1.48 gateway still sends page capKeys — never keep (or re-emit) one here; a follower never uses a page's key
      if (f.gateway) gatewayId = f.gateway
      consent.merge(f.grants)   // #62: consent for MY sub-peers is checked here, so learn the realm's grants from the gateway
      realmDefaults.merge(f.realm_defaults)   // #66b: MY sub-peers' reminders are computed here too
      retainedSet.merge(f.retained)   // #66c: and MY sub-peers' subscribe-time retained catch-up (only sent when it changed)
      projectNames.merge(f.project_names)   // #71: and the realm's canonical project spellings (for what MY tools show)
    }
  })
  const reelect = () => {
    gwRegistered = false; failActivityPending('gateway-lost', 'this host\'s gateway went away mid-call (re-election) — retry')   // #70
    if (role !== 'stopping') { gwSock = null; setTimeout(election, backoff + Math.random() * 100); backoff = Math.min(backoff * 2, 3000) }
  }
  sock.on('close', reelect)
  sock.on('error', () => {})
}

// ---------------------------------------------------------------- election (the single retry edge)
// Whoever binds the well-known PORT is this host's gateway; EADDRINUSE means one already holds it, so follow it.
function election() {
  if (role === 'stopping') return
  role = 'binding'
  const server = profile.transport.createServer()
  server.once('error', e => {
    if (e.code === 'EADDRINUSE') becomeFollower()
    else { log('bind error', PORT, e.code); setTimeout(election, backoff); backoff = Math.min(backoff * 2, 3000) }
  })
  server.listen(PORT, BIND, () => becomeGateway(server))
}

// ---------------------------------------------------------------- MCP server (the session side)
const mcp = new Server(
  { name: 'ai-mcp-bridge', version: BRIDGE_VERSION },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: { listChanged: true } },   // #45: we notify tools/list_changed so an upgraded bridge refreshes a running client's cached schema
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
      bridge_version: BRIDGE_VERSION, capabilities: CAPS, facet_probe: FACET_PROBE, realm: REALM, profile: profile.names, identity: displayIdent(PROC_IDENT),   // #71: canonical project spelling
      client: CLIENT, mode_override: MODE_OVERRIDE, subpeers: [...subpeers.values()].map(s => ({ id: s.id, name: s.name, parent: s.parent, project: projName(s.identity?.project), user: s.identity?.user })),
      topics: topicList().map(t => t.project != null ? { ...t, project: projName(t.project) } : t) })
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
        return ok({ ok: true, peer_id: existing.id, name, queue_epoch: q.epoch, next_cursor: q.base + q.items.length, reattached: true, identity: displayIdent(existing.identity), topics: reTopics, access: accessOf(existing.identity?.project), behaviors: reminders.list(existing.id), default_behaviors: reminders.defaultList(), connect_reminders: connectReminders(existing) })
      }
      let parent = null
      if (a.parent) {
        const p = resolveLocalSub(String(a.parent))
        if (!p) return ok({ ok: false, code: 'unknown-parent', parent: a.parent })
        parent = p.id
      }
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
      // #40: identity-derived (survives a process restart) once minting is enabled; legacy process-scoped
      // form until then, so a mesh containing pre-1.26 bridges never sees an id it cannot parse.
      const id = STABLE_IDS ? stablePeerId(ident, name)
        : `${SESSION}/${slugOf(name)}-${crypto.randomBytes(2).toString('hex')}`
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
      noteProject(ident.project)   // #71: a registration is a sighting — the first spelling of a project becomes its canonical one
      announceSubpeers()
      emitTraceRaw({ dir: 'con', verb: 'connect', from: id, from_name: name, to: SESSION, size: 0,
        note: (parent ? `child of ${parent.split('/').pop()}` : 'sub-peer registered') + (ckind ? ` [${ckind}]` : '') + ` {${projName(ident.project)}/${ident.user}}`, envelope_id: null })
      const q = subQueues.get(id)
      callerId = id   // so the response's inbox hint reflects any rehydrated parked mail this returning peer has waiting
      // §20 resync: hand back the identity's current topics (owned + subscribed, post-rehydration) and the
      // projects it may reach — so a reconnecting/compacted session relearns its state without re-attaching.
      const myTopicsNow = [...myTopics.values()].filter(e => e.holder === id).map(e => ({ pattern: e.pattern, role: e.role, exclusive: e.exclusive || undefined, icon: e.icon || undefined }))
      return ok({ ok: true, peer_id: id, name, queue_epoch: q.epoch, next_cursor: 0, client: declaredClient, client_kind: ckind, mode, identity: displayIdent(ident), topics: myTopicsNow, access: accessOf(ident.project), behaviors: reminders.list(id), default_behaviors: reminders.defaultList(), connect_reminders: connectReminders(subpeers.get(id)) })
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
      if (cands.length > 1) return ok({ ok: false, code: 'ambiguous-name', candidates: cands.map(r => `${projName(r.project)}:${r.name}`) })
      const r = cands[0]
      const ident = { realm: r.realm || REALM, project: r.project, user: r.user, name: r.name }
      const v = await persistence.vault.get(ident)
      if (!v || !v.sealed) return ok({ ok: false, code: 'no-vault-entry', name })
      const res = await vault.unseal(v.sealed, { subject: `Recover the Ai MCP Bridge secret for session "${r.name}" (${r.project}).` })
      if (!res || !res.ok) return ok({ ok: false, code: 'recovery-denied', reason: res ? res.reason : 'unseal-failed', ...(res && res.detail ? { detail: res.detail } : {}) })
      emitTraceRaw({ dir: 'con', verb: 'recover_secret', from: SESSION, from_name: NAME, to: SESSION, size: 0, note: `secret recovered for "${r.name}" (${res.by})`, envelope_id: null })
      return ok({ ok: true, name: r.name, project: projName(r.project), secret: res.plaintext, by: res.by,
        hint: 're-register with name + this secret to reattach (you get your topics + parked mail back), then use it as as/secret on send_to_peer and for/secret on inbox' })
    }
    case 'list_sessions': return ok({ role, host: SESSION.split('/')[0], ...displayRoster(rosterPayload()) })   // #71: one spelling per project
    case 'claim_topic': {
      const topic = String(a.topic || '').trim()
      if (!topic) return ok({ ok: false, code: 'topic-required' })
      // §6: a responsibility (claim) must be CONCRETE and addressable. A wildcard claim ('+'/'#') is
      // unsendable — routeToTopicOwners refuses a wildcard target — so it silently breaks any UI that
      // offers it as a target. Banned for BOTH exclusive and shared claims. (subscribe stays wildcard-capable:
      // watching a subtree is fine; owning one is not.) Decision 2026-06-16 (design review).
      if (isWildcard(topic)) return ok({ ok: false, code: 'wildcard-claim', hint: "claim the concrete base instead, e.g. 'retail' not 'retail/#'" })
      if (a.force) return ok({ ok: false, code: 'unsupported', what: 'forced takeover (offline delivery, T14)' })
      let holder = SESSION, holderName = NAME, holderProject = PROC_IDENT?.project || 'unclassified', holderRealm = REALM, holderIdentity = pIdent(PROC_IDENT, HOSTNAME)
      if (a.as) {
        const { sp, err } = authSub(String(a.as), a.secret)
        if (err) return ok(err)
        holder = sp.id; holderName = sp.name; holderProject = sp.identity?.project || 'unclassified'; holderRealm = sp.identity?.realm || REALM; holderIdentity = pIdent(sp.identity, sp.name)
      }
      // #55: a RE-CLAIM (same holder, same topic) is a PATCH, not a replace — every field the caller omits keeps the
      // EXISTING claim's value, and the defaults below apply only to a NEW claim. The existing claim is the live one
      // (incl. one rehydrateClaim restored after a restart) or else this holder's own DORMANT durable record (ours on
      // disk but not in RAM — e.g. its rehydrate was refused, or a process claim raced the async rehydrate): that
      // record is exactly what a rehydrate would restore, so it is treated the same. Per field the precedence is
      // explicit arg > existing claim > kept-alive marker (#26, new claims only; read below) > default. An explicit
      // false / '' / null is a real value (it clears), not "omitted".
      const k = `${holder}|owner|${patternKey(topic)}`
      const prev = myTopics.get(k) || await ownDurableClaim(topic, holderIdentity, holderProject)
      const reclaim = !!prev
      const given = f => a[f] !== undefined                                // passed at all (null included: it clears)
      // §12: when persistence is on a claim is durable BY DEFAULT (responsibilities survive a restart);
      // opt out with persistent:false. Without persistence the flag is a no-op (nothing to write).
      const persistent = PERSIST && (a.persistent != null ? a.persistent !== false : prev ? prev.persistent !== false : true)
      const exclusive = a.exclusive != null ? !!a.exclusive : prev ? !!prev.exclusive : true   // §6: single-owner BY DEFAULT (opt out: exclusive:false for a shared topic)
      const grace_minutes = given('grace_minutes') ? (a.grace_minutes == null ? null : Number(a.grace_minutes)) : prev ? (prev.grace_minutes ?? null) : null   // §16: per-claim takeover grace
      const allow_other_user = given('allow_other_user') ? (a.allow_other_user == null ? null : !!a.allow_other_user) : prev ? (prev.allow_other_user ?? null) : null   // §16: per-claim cross-user takeover
      // T6/§6: an exclusive claim conflicts with overlapping claims IN THE SAME PROJECT only (judged on the EFFECTIVE
      // exclusive: a re-claim that keeps a shared topic shared stays compatible; one that flips it exclusive is refused)
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
      // #26: if this topic was kept ALIVE (ownerless) it has a durable marker — a NEW claim inherits its metadata where
      // the claimer left a field unset (a re-claim's existing claim outranks it), and its parked queue drains below.
      let kept = null
      if (persistent) { try { kept = await persistence.keptTopics.get(holderProject, topic) } catch { } }
      const keep_alive = a.keep_alive != null ? !!a.keep_alive : prev ? !!prev.keep_alive : !!kept   // claim-time property: this topic should survive handoffs
      const eDesc = given('description') ? String(a.description || '') : prev ? (prev.description || '') : ((kept && kept.description) || '')
      const eIcon = given('icon') ? (String(a.icon || '').trim().slice(0, 16) || null) : prev ? (prev.icon || null) : ((kept && kept.icon) || null)
      const eAnnounce = a.announce_offline != null ? !!a.announce_offline : prev ? !!prev.announce_offline   // §16: tell senders when I'm offline BY DEFAULT (pass false to park silently)
        : (kept && kept.announce_offline != null ? !!kept.announce_offline : true)
      myTopics.set(k, { pattern: topic, role: 'owner', description: eDesc, exclusive, icon: eIcon, holder, holder_name: holderName, project: holderProject, realm: holderRealm,
        announce_offline: eAnnounce, grace_minutes, allow_other_user, keep_alive, persistent,   // `persistent` rides the roster so the dashboard can show durability (it was only ever written to the .claim file)
        claimed_at: (prev && prev.claimed_at) || new Date().toISOString() })
      if (persistent) await persistClaim(holderIdentity, holderProject, topic, myTopics.get(k))   // §12: durable responsibility (awaited so a later release reliably sees + removes it)
      else if (prev && prev.persistent !== false && PERSIST && holderIdentity) {   // #55: a re-claim with persistent:false drops the durable record, else it would rehydrate after a restart
        try { await persistence.claims.remove(holderProject, topic, holderIdentity) } catch { }
      }
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
      return ok({ ok: true, topic, holder, exclusive, icon: eIcon, persistent: persistent || undefined, keep_alive: keep_alive || undefined, reclaimed: reclaim || undefined, ...(drained ? { drained } : {}), reminders: opReminders(holder, 'claim_topic', { topic, project: holderProject }) })
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
      return ok({ ok: true, topic, holder, ...(keepAlive ? { kept_alive: true } : {}), reminders: opReminders(holder, 'release_topic', { topic, project: holderProject }) })
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
          // #66c: this host's store (its own publishes + what it learned) AND the replicated set (values published on
          // other hosts, possibly not yet on disk) — newest per topic; on a tie the store's copy (a too-large value is
          // there on its publishing host, while the set holds only its marker). A marker (env:null) delivers nothing.
          const best = new Map()
          for (const { topic: rt, record } of await persistence.retained.allForProject(holderProject)) {
            if (!record || !rt) continue
            const ts = Date.parse(record.ts || (record.env && record.env.ts) || '') || 0, k = patternKey(rt), cur = best.get(k)
            if (!cur || ts > cur.ts) best.set(k, { topic: rt, ts, env: record.env || null })
          }
          for (const r of retainedSet.forProject(holderRealm, holderProject)) {
            const k = patternKey(r.topic), cur = best.get(k)
            if (!cur || r.ts > cur.ts) best.set(k, { topic: r.topic, ts: r.ts, env: r.env })
          }
          let n = 0
          for (const { topic: rt, env: env0 } of best.values()) {
            if (!env0 || !rt || !topicMatch(pattern, rt)) continue
            const env = makeEnvelope({ to: holder, verb: env0.verb, body: plainBody(env0), from: env0.from, subject: env0.subject, pattern: 'publish', topic: rt })
            env.retained = true
            await routeEnvelope(env); n++
          }
          if (n) emitTraceRaw({ dir: 'send', verb: 'message', from: SESSION, from_name: NAME, to: holder, to_name: holderName, to_kind: 'subpeer', subject: `retained catch-up (${n})`, pattern: 'publish', size: 0, note: `${n} retained value(s) delivered on subscribe`, envelope_id: null })
        } catch { }
      }
      return ok({ ok: true, pattern, holder, resubscribed: existed || undefined, reminders: opReminders(holder, 'subscribe', { topic: pattern, project: holderProject }) })
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
      let retainInfo = {}
      if (retain) {   // §12 retain: keep the last event per CONCRETE topic; delivered to a (re)subscriber on subscribe
        const { project, path, realm } = parseTopicRef(ref, askerProjectOf(from), REALM)
        if (path && !isWildcard(path) && fromIdentity) {
          const env = makeEnvelope({ to: `topic:${path}`, verb: a.verb, body: a.message, from, subject, pattern: 'publish', topic: path })
          persistence.retained.put(project, path, fromIdentity, { ts: env.ts, env }).catch(() => {})
          // #66c: replicate mesh-wide (the set is LWW by publish time). Over the size cap the value stays on THIS host's
          // store only and a too-large marker replicates instead (it retires any older value elsewhere) — said honestly.
          const bytes = envBytes(env)
          if (retainedSet.merge([{ realm: realm || REALM, project, topic: path, ts: Date.parse(env.ts), env, origin: HOSTNAME }], { persist: false }) > 0) announceRetained([retainedSet.get(realm || REALM, project, path)])
          if (bytes > RETAIN_MAX_BYTES) {
            log(`retained value for ${project}/${path} is ${bytes} bytes > the ${RETAIN_MAX_BYTES}-byte replication cap — kept on this host only (other hosts get a too-large marker)`)
            retainInfo = { retained_replicated: false, retained_bytes: bytes, retained_cap_bytes: RETAIN_MAX_BYTES,
              retained_note: 'value exceeds the replication cap: retained on this host only; subscribers on other hosts will not get it' }
          }
        }
      }
      return ok({ ...r, retained: retain || undefined, ...retainInfo, as: from ? from.session : SESSION, reminders: opReminders(from ? from.session : SESSION, 'publish', { topic: r.topic, project: r.project }) })
    }
    case 'allow_project': {
      let me0 = { project: PROC_IDENT?.project, user: PROC_IDENT?.user }, holderId = SESSION
      let by = { session: SESSION, name: NAME, kind: 'session' }   // #72: the granter — the notice's `from` (so from.project = the granting project)
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); me0 = { project: sp.identity?.project, user: sp.identity?.user }; holderId = sp.id; by = { session: sp.id, name: sp.name, kind: 'subpeer' } }
      if (!me0.project || projKey(me0.project) === 'unclassified') return ok({ ok: false, code: 'caller-unclassified' })   // #71: any case of it
      if (!a.project) return ok({ ok: false, code: 'project-required' })
      const from = projKey(a.project), to = projKey(me0.project)
      noteProject(String(a.project).trim())   // #71: a grant naming a project is a sighting (its spelling is canonical only if the project is new)
      const fromName = projName(String(a.project).trim()), toName = projName(me0.project)   // #71: what is SHOWN (the edge itself stays projKey'd)
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
      // #72: does this call CHANGE anything? A re-grant of a live edge with the same mode and the same TTL (forever, or
      // the same minutes — read back from the record as exp - updated_at) is not re-announced to the granted project.
      const prev = consent.edge(from, to), prevTtl = prev && prev.exp ? (prev.exp - prev.updated_at) / 60000 : null
      const unchanged = !!prev && prev.live && prev.mode === mode && (effTtl == null ? !prev.exp : prevTtl != null && Math.abs(prevTtl - effTtl) < 0.05)
      consent.allow(from, to, mode, exp)         // §14: runtime grant + durable copy (survives a restart)
      announceGrants()                           // #62: replicate mesh-wide (+ visibility may widen)
      emitTraceRaw({ dir: 'con', verb: 'allow', from: toName, from_name: me0.user || NAME, to: fromName, size: 0,
        note: `allow ${fromName} -> ${toName} (${mode}, ${exp ? effTtl + 'm' : 'forever'})`, envelope_id: null })
      // Bug 3: the original requester(s) are told their access landed, echoing request_id + the permitted TTL — they ride
      // the #72 announcement as `extra` targets (one notice each, never a second copy), and still get it on an unchanged re-grant.
      const extra = new Map()
      for (const p of pend) { consent.deletePending(p.reqId); extra.set(p.requester, { request_id: p.reqId }) }
      const expiresAt = exp ? new Date(exp).toISOString() : null
      let sent = { live: 0, extra: 0, parked: 0 }
      if (from !== to && (!unchanged || extra.size)) {
        const granted = fromName, granting = toName, oneWay = mode !== 'bidirectional'   // #71: canonical spellings in the notice
        const body = { action: 'granted', granting_project: granting, granted_project: granted, mode, one_way: oneWay,
          direction: oneWay ? `${granted} -> ${granting}` : `${granted} <-> ${granting}`,
          ttl_minutes: effTtl, expires_at: expiresAt, granted_by: { name: by.name, session: by.session, project: granting, user: me0.user || null },
          note: `${granted} sessions may now initiate messages to ${granting}` + (oneWay ? ` (one-way: ${granting} may not initiate to ${granted} through this grant)` : ` and ${granting} sessions may initiate to ${granted} (bidirectional)`) + (expiresAt ? `, until ${expiresAt}` : ''),
          to: granting, from: granted }   // `to`/`from`: the Bug-3 ack's original fields, kept for older readers (compare them case-insensitively)
        sent = await announceProjectAccess({ verb: 'project_access_granted', from: by, project: granted, body,
          subject: `${granting} granted ${granted} access (${oneWay ? 'one-way' : 'bidirectional'}${effTtl != null ? `, ${effTtl}m` : ''})`,
          extra, onlyExtra: unchanged })
      }
      return ok({ ok: true, allow: { from: fromName, to: toName, mode, ttl_minutes: effTtl, expires_at: expiresAt },   // #71: was { from: projKey } — "aimb" for an "AIMB" grant
        notified: sent.extra + sent.live + sent.parked, notified_pending: sent.extra, announced: sent.live, parked: sent.parked,   // #72: notified = every notice sent (was: pending requesters only)
        ...(unchanged ? { announce: 'unchanged' } : {}), reminders: opReminders(holderId, 'allow_project', { project: a.project }) })
    }
    case 'revoke_project': {
      let myProj = PROC_IDENT?.project, myUser = PROC_IDENT?.user, holderId = SESSION, by = { session: SESSION, name: NAME, kind: 'session' }
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); myProj = sp.identity?.project; myUser = sp.identity?.user; holderId = sp.id; by = { session: sp.id, name: sp.name, kind: 'subpeer' } }
      const from = projKey(a.project), to = projKey(myProj)
      const prev = consent.edge(from, to)
      const had = consent.revoke(from, to)   // §14/#62: tombstone the edge (durable) so the revoke replicates
      announceGrants()
      // #72: announce the revoke to the granted project — same path + rules as the grant notice; a revoke of an edge that
      // wasn't live here (already revoked / expired / never seen) changes nothing and is not announced
      let sent = { live: 0, extra: 0, parked: 0 }
      const fromName = projName(String(a.project || '').trim()), toName = projName(myProj)   // #71: canonical spellings for what is shown
      if (had && from !== to) {
        const granted = fromName, granting = toName, mode = (prev && prev.mode) || 'send'
        sent = await announceProjectAccess({ verb: 'project_access_revoked', from: by, project: granted,
          subject: `${granting} revoked ${granted} access`,
          body: { action: 'revoked', granting_project: granting, granted_project: granted, mode, one_way: mode !== 'bidirectional',
            revoked_by: { name: by.name, session: by.session, project: granting, user: myUser || null },
            note: `the runtime grant letting ${granted} initiate to ${granting}` + (mode === 'bidirectional' ? ' (and the reverse direction)' : '') + ' was revoked; a static config edge or another grant may still allow it',
            to: granting, from: granted } })
      }
      return ok({ ok: true, revoked: had, from: fromName, to: toName, notified: sent.live + sent.parked, announced: sent.live, parked: sent.parked,
        reminders: opReminders(holderId, 'revoke_project', { project: a.project }) })
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
      const payload = JSON.stringify({ from_project: projName(me0.project || 'unclassified'), from_user: me0.user || 'unknown', reason: String(a.reason || ''), request_id: reqId, ttl_minutes: ttlMin })
      const reached = await deliverSystemToProject(to, 'project_access_request', payload)
      return ok({ ok: true, request_id: reqId, to: projName(String(a.to).trim()), ttl_minutes: ttlMin, delivered_to: reached, reminders: opReminders(requester, 'request_project_access', { project: to }) })   // #71: `to` was lower-cased
    }
    case 'set_wake': {   // T14 wake is unsupported (CAPS.wake=false); tell the caller their fallback, RESOLVED BY SESSION TYPE
      const kind = (callerId && subpeers.get(callerId)?.client_kind) || clientKind(CLIENT && CLIENT.name)
      const fallback = kind === 'code'   // only a code session can run the doorbell script + be re-woken by its harness
      const wsp = callerId ? subpeers.get(callerId) : null
      const cmd = fallback ? doorbellCmd(wsp ? wsp.name : NAME, wsp ? wsp.identity?.project : PROC_IDENT?.project) : null   // #67: ready-to-run, for THIS caller
      return ok({ ok: false, code: 'unsupported',
        what: fallback ? 'Not implemented, but you can use the doorbell service as a fallback'
                       : 'Not implemented for your session with no fallback supported',
        fallback: fallback ? 'doorbell' : null,
        ...(fallback ? { hint: `run this backgrounded: ${cmd} — it blocks on a socket at ~zero cost and wakes you when mail is waiting, or at the top of each hour by default (a chime: display the time to the user, then re-arm; the 00/06/12/18:00 chimes add inbox_check:true — call your inbox tool first even if nothing is waiting, which keeps the bridge loaded); token/port default from the bridge's config.json`, command: cmd } : {}) })
    }
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
      // #54: send ON BEHALF OF a topic the caller currently owns — validated here, before anything is routed or parked
      let ft
      if (a.from_topic != null && String(a.from_topic).trim()) {
        const v = fromTopicOf(from ? from.session : SESSION, askerProjectOf(from), String(a.from_topic).trim())
        if (v.err) return ok(v.err)
        ft = v.ft
      }
      const ftOut = ft ? { from_topic: ft.from_topic } : {}
      let target = String(a.target || '')
      if (target.startsWith('topic:')) {                 // topic targeting (T3): explicit prefix only -> owners
        const r = await routeToTopicOwners(from, target.slice(6).trim(), a.verb, a.message, a.reply_to, subject, askerProjectOf(from), ft)
        return ok({ ...r, ...ftOut, as: from ? from.session : SESSION, reminders: opReminders(from ? from.session : SESSION, 'send', { topic: r.topic || target.slice(6).trim(), project: r.project }) })
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
          const parked = await parkToOfflineName(from, target, a.verb, a.message, a.reply_to, subject, askerProjectOf(from), ft)
          if (parked) return ok({ ...parked, ...ftOut, as: from ? from.session : SESSION })
        }
      }
      const env = makeEnvelope({ to: target, verb: a.verb, body: a.message, reply_to: a.reply_to, from, subject, ...ft })
      const r = await routeEnvelope(env)
      const tOwner = ownerOf(target)   // #44: 'send' reminders match the TARGET's project/host
      return ok({ ...r, envelope_id: env.id, to: target, ...ftOut, as: from ? from.session : SESSION,
        reminders: opReminders(from ? from.session : SESSION, 'send', { project: projectOfTarget(target), host: tOwner ? tOwner.host_label : undefined }) })
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
        if (start < q.items.length) scheduleCounts()   // served advanced → waiting-mail badge went down
        return ok({ peer_id: sp.id, queue_epoch: q.epoch, next_cursor: next,
          messages: q.items.slice(start).map(e => { const v = decryptedView(e), r = reminders.remindersFor(sp.id, receiveCtx(sp.id, e)); return r.length ? { ...v, reminders: r } : v }) })   // #29/#44/#47: attach 'receive' reminders
      }
      const cur = Number(a.cursor || 0)
      return ok({ messages: inbox.slice(cur).map(decryptedView), next_cursor: inbox.length })
    }
    case 'log': {   // #70: report status to this host's activity board (the gateway applies it; a follower forwards it up)
      if (!a.as) return ok({ ok: false, code: 'as-required', what: 'log reports as a registered session: pass as + secret (register_self first)' })
      const { sp, err } = authSub(String(a.as), a.secret)
      if (err) return ok(err)
      if (!ACT_CFG.enabled) return ok(actDisabled())
      const input = {}
      for (const k of LOG_FIELDS) if (a[k] !== undefined) input[k] = a[k]
      const pre = input.items !== undefined ? Act.splitBatch(input) : Act.parseMessage(input, { now: Date.now(), tzOffsetMin: tzOff(Date.now()) })   // validate here: a bad call costs no round trip (v1.62.0: a batch's bounds; its items are answered one by one)
      if (!pre.ok) return ok(pre)
      const ident = { realm: sp.identity?.realm || REALM, project: sp.identity?.project || 'unclassified', user: sp.identity?.user || null, session: sp.name, host: HOSTNAME }
      return ok(await activityCall('log', { ident, input }))
    }
    case 'activity': {   // #70: read this host's activity board (+ one agent's log, or one entry in full)
      const query = {}
      for (const k of BOARD_FIELDS) if (a[k] !== undefined) query[k] = a[k]
      return ok(await activityCall('read', { query }))
    }
    case 'set_behavior': {   // #29: register a 'how to behave when a message arrives' reminder for a scope
      let holder = SESSION, holderIdentity = pIdent(PROC_IDENT, HOSTNAME)
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); holder = sp.id; holderIdentity = pIdent(sp.identity, sp.name) }
      return ok(reminders.set(holder, holderIdentity, a.operation, a.scope, a.match, a.behavior))
    }
    case 'list_behaviors': {
      let holder = SESSION
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); holder = sp.id }
      return ok({ ok: true, behaviors: reminders.list(holder) })
    }
    case 'clear_behavior': {   // omit scope to clear ALL; else clear the one (scope + match)
      let holder = SESSION, holderIdentity = pIdent(PROC_IDENT, HOSTNAME)
      if (a.as) { const { sp, err } = authSub(String(a.as), a.secret); if (err) return ok(err); holder = sp.id; holderIdentity = pIdent(sp.identity, sp.name) }
      return ok(reminders.clear(holder, holderIdentity, a.operation, a.scope, a.match))
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
    // #45: nudge the client to re-fetch tools/list. A client that connected to an OLDER bridge caches the
    // tool schema at initialize and STRIPS unknown args — so after a bridge upgrade UNDER a running client
    // (the common case here: the tray/stdio bridge is replaced but the client session lives on), a new tool
    // PARAMETER (e.g. #44's set_behavior `operation`) never reaches the bridge until the client refreshes.
    // Emitting tools/list_changed right after `initialized` prompts that refresh without a full client restart.
    // A bridge restart alone did NOT refresh it (observed in the field); this is the missing signal.
    setTimeout(() => { try { mcp.sendToolListChanged() } catch {} }, 300).unref()
  } catch (e) { log('client-detect failed', e.message) }
}

await mcp.connect(new StdioServerTransport())
// #70 step 4: a clean exit tells the peer hubs first (best effort, ≤300 ms; a hard kill can't — the link drop does it then)
let exiting = false
function cleanExit() { if (exiting) return; exiting = true; const down = actAnnounceDown('exit'); role = 'stopping'; down.finally(() => process.exit(0)) }
process.on('SIGTERM', cleanExit)
process.on('SIGINT', cleanExit)
