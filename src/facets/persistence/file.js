// Persistence facet: file (docs/architecture.md §12) — a plain directory tree that works on ANY shared
// backend (local disk, Dropbox, SMB/NFS). `persistence.dir` may be local or a synced folder; the facet
// doesn't care. The layout is conflict-free even with NO file locking: one writer per file, names are
// content-addressed (envelope id) or per-writer (holder/publisher identity), and effective state is
// COMPUTED from the file set — so a no-lock backend never sees a concurrent edit to one file.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export const meta = { facet: 'persistence', name: 'file' }

// "16MB" / "12.5 MB" / "1 GB" / "1024" -> bytes. Space optional, decimals OK, unit-less = bytes.
// Returns null on unparseable input (the caller falls back to a default).
export function parseSize(v) {
  if (v == null) return null
  if (typeof v === 'number') return v >= 0 ? Math.floor(v) : null
  const m = String(v).trim().match(/^([\d.]+)\s*(b|byte|bytes|k|kb|m|mb|g|gb|t|tb)?$/i)
  if (!m) return null
  const n = parseFloat(m[1]); if (!isFinite(n) || n < 0) return null
  const u = (m[2] || 'b').toLowerCase()[0]
  const mult = u === 't' ? 1024 ** 4 : u === 'g' ? 1024 ** 3 : u === 'm' ? 1024 ** 2 : u === 'k' ? 1024 : 1
  return Math.floor(n * mult)
}

// exported so the v1.17 key-lowercasing migration (scripts/migrate-persistence-lowercase.mjs) re-keys with
// the EXACT same logic the running facet uses — no drift between migrator and reader.
export const slug = (s, max = 48) => String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || '_'
// case-INSENSITIVE slug for names/topics/projects: lower-case first, so "Bills" and "bills" share one path.
// (Plain `slug` stays case-sensitive — used for content-addressed envelope ids.) Display case is preserved
// in the record bodies; only the on-disk KEY is canonicalised.
export const lslug = (s, max = 48) => slug(String(s == null ? '' : s).toLowerCase(), max)

// Stable, format-prefixed on-disk key for an identity (§12). `primary` is the form for the current mode;
// `both` is [hashed, readable] so a drain finds data written under the OTHER mode — flipping
// devReadableKeys with files already on disk strands nothing. The tuple is LOWER-CASED so the identity is
// case-insensitive ("Robin"/"robin", "Bolletta"/"bolletta" share one mailbox/claim/vault key).
export function identityKeys(identity, readable) {
  const tuple = [identity.realm || 'default', identity.project || 'unclassified', identity.user || 'unknown', identity.name || ''].map(t => String(t).trim().toLowerCase())
  const sha = crypto.createHash('sha256').update(tuple.join('|')).digest('hex')
  const hashed = 'h-' + sha
  const human = 'r-' + tuple.map(t => slug(t, 24)).join('__') + '-' + sha.slice(0, 4)
  return { primary: readable ? human : hashed, both: [hashed, human] }
}

export function create(ctx) {
  const cfg = (ctx.CFG && ctx.CFG.persistence) || {}
  const root = path.resolve(ctx.HERE || '.', (ctx.env && ctx.env.AI_BRIDGE_PERSIST_DIR) || cfg.dir || '../persistence')
  const readable = cfg.devReadableKeys === true
  const dir = (...p) => path.join(root, ...p)

  async function ensure(d) { await fsp.mkdir(d, { recursive: true }) }
  async function writeAtomic(file, data) {
    await ensure(path.dirname(file))
    const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex')
    await fsp.writeFile(tmp, data)
    await fsp.rename(tmp, file)   // atomic on one fs; on a synced backend it propagates as a new file
  }
  const readDirSafe = async d => { try { return await fsp.readdir(d) } catch { return [] } }
  const readJson = async f => { try { return JSON.parse(await fsp.readFile(f, 'utf8')) } catch { return null } }

  // ---- mailboxes: one IMMUTABLE file per parked message, content-addressed by envelope id ----
  // the envelope id ALREADY carries the "env_" prefix (envelopeId() returns "env_<hash>"), so the on-disk
  // file is just `<envId>.msg` — NOT `env_<envId>.msg`, which double-prefixed to "env_env_…". `msgFile`
  // also accepts the legacy double-prefixed name so ack still cleans files written before this fix.
  const msgFile = envId => `${slug(envId, 80)}.msg`
  const legacyMsgFile = envId => `env_${slug(envId, 80)}.msg`
  const mailbox = {
    async put(identity, envId, record) {
      const { primary } = identityKeys(identity, readable)
      // self-describing: store the RECIPIENT identity in the body (not only the hashed dir key) so the parked
      // message can be attributed/migrated/audited without reversing the key (the lesson from the claim records).
      await writeAtomic(dir('mailboxes', primary, msgFile(envId)),
        JSON.stringify({ envId, ts: record.ts || new Date().toISOString(),
          for: { realm: identity.realm, project: identity.project, user: identity.user, name: identity.name }, record }))
    },
    // every parked message for an identity, across BOTH key forms, oldest first
    async drain(identity) {
      const { both } = identityKeys(identity, readable)
      const out = []
      for (const key of new Set(both)) {
        const mdir = dir('mailboxes', key)
        for (const f of await readDirSafe(mdir)) {
          if (!f.endsWith('.msg')) continue
          const file = path.join(mdir, f)
          let st; try { st = await fsp.stat(file) } catch { continue }
          const j = await readJson(file)
          if (j) out.push({ envId: j.envId, ts: j.ts, record: j.record, _file: file, _size: st.size })
        }
      }
      out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      return out
    },
    async ack(identity, envId) {   // delete after delivery (try both key forms + new/legacy filename)
      const { both } = identityKeys(identity, readable)
      for (const key of new Set(both)) for (const fn of [msgFile(envId), legacyMsgFile(envId)]) { try { await fsp.unlink(dir('mailboxes', key, fn)) } catch {} }
    },
    // TTL + per-mailbox caps; returns the dropped entries so the caller can LOG them (no silent truncation, §12)
    async gc(identity, { now = Date.now(), ttlMs = 0, maxCount = 0, maxBytes = 0 } = {}) {
      const items = await this.drain(identity), dropped = []
      const drop = (it, why) => { dropped.push({ envId: it.envId, why }); try { fs.unlinkSync(it._file) } catch {} }
      let live = []
      for (const it of items) (ttlMs && now - Date.parse(it.ts) > ttlMs) ? drop(it, 'ttl') : live.push(it)
      while (maxCount && live.length > maxCount) drop(live.shift(), 'count')      // oldest first
      if (maxBytes) { let total = live.reduce((s, it) => s + it._size, 0); while (live.length && total > maxBytes) { const it = live.shift(); total -= it._size; drop(it, 'size') } }
      return dropped
    },
    // sweep EVERY mailbox for TTL-expired messages (owners who never returned). Per-mailbox caps are
    // enforced on drain; this only handles age. Returns the count dropped.
    async gcAll({ now = Date.now(), ttlMs = 0 } = {}) {
      if (!ttlMs) return 0
      let dropped = 0
      const base = dir('mailboxes')
      for (const keyDir of await readDirSafe(base)) {
        const mdir = path.join(base, keyDir)
        for (const f of await readDirSafe(mdir)) {
          if (!f.endsWith('.msg')) continue
          const file = path.join(mdir, f)
          const j = await readJson(file)
          if (j && now - Date.parse(j.ts) > ttlMs) { try { await fsp.unlink(file) } catch { } dropped++ }
        }
      }
      return dropped
    },
  }

  // ---- claims: one file per holder; ownership is COMPUTED from the set, not stored authoritatively ----
  const claims = {
    async put(project, topic, identity, record) {
      const { primary } = identityKeys(identity, readable)
      await writeAtomic(dir('claims', lslug(project), lslug(topic), `${primary}.claim`), JSON.stringify(record))
    },
    async read(project, topic) {
      const cdir = dir('claims', lslug(project), lslug(topic)), out = []
      for (const f of await readDirSafe(cdir)) { if (!f.endsWith('.claim')) continue; const j = await readJson(path.join(cdir, f)); if (j) out.push(j) }
      return out
    },
    // every claim FILED BY an identity (across BOTH key forms), so a returning holder can re-assert all of
    // its responsibilities on register. The record carries its own project/topic, so a lossy slug never strands it.
    async byHolder(identity) {
      const { both } = identityKeys(identity, readable)
      const names = new Set(both.map(k => `${k}.claim`))
      const out = [], cbase = dir('claims')
      for (const proj of await readDirSafe(cbase)) {
        const pdir = path.join(cbase, proj)
        for (const topic of await readDirSafe(pdir)) {
          const tdir = path.join(pdir, topic)
          for (const f of await readDirSafe(tdir)) { if (names.has(f)) { const j = await readJson(path.join(tdir, f)); if (j) out.push(j) } }
        }
      }
      return out
    },
    async remove(project, topic, identity) {
      const { both } = identityKeys(identity, readable)
      for (const key of new Set(both)) { try { await fsp.unlink(dir('claims', lslug(project), lslug(topic), `${key}.claim`)) } catch {} }
    },
    // hard expiry: a claim whose holder hasn't re-registered within hardExpiryMs is abandoned. Returns count dropped.
    async gcAll({ now = Date.now(), maxAgeMs = 0 } = {}) {
      if (!maxAgeMs) return 0
      let dropped = 0, cbase = dir('claims')
      for (const proj of await readDirSafe(cbase)) for (const topic of await readDirSafe(path.join(cbase, proj))) {
        const tdir = path.join(cbase, proj, topic)
        for (const f of await readDirSafe(tdir)) {
          if (!f.endsWith('.claim')) continue
          const file = path.join(tdir, f), j = await readJson(file)
          const t = j && Date.parse(j.refreshed_at || j.claimed_at || '')
          if (j && t && now - t > maxAgeMs) { try { await fsp.unlink(file) } catch {} dropped++ }
        }
      }
      return dropped
    },
  }

  // ---- grants: durable cross-project consent edges (one file per from->to edge). Project names + mode +
  // expiry are routing metadata (already cleartext in the roster/traces), so stored as plain JSON. ----
  const grants = {
    async put(from, to, record) { await writeAtomic(dir('grants', `${slug(from)}__${slug(to)}.grant`), JSON.stringify(record)) },
    async all() {
      const gdir = dir('grants'), out = []
      for (const f of await readDirSafe(gdir)) { if (!f.endsWith('.grant')) continue; const j = await readJson(path.join(gdir, f)); if (j) out.push(j) }
      return out
    },
    async remove(from, to) { try { await fsp.unlink(dir('grants', `${slug(from)}__${slug(to)}.grant`)) } catch {} },
    async gcAll({ now = Date.now() } = {}) {   // drop expired edges (exp in the past); forever (exp null) survives
      let dropped = 0, gdir = dir('grants')
      for (const f of await readDirSafe(gdir)) {
        if (!f.endsWith('.grant')) continue
        const file = path.join(gdir, f), j = await readJson(file)
        if (j && j.exp && j.exp < now) { try { await fsp.unlink(file) } catch {} dropped++ }
      }
      return dropped
    },
  }

  // ---- registrations: durable (name -> identity) so a directed send to an OFFLINE peer BY NAME can resolve
  // and park, and a returning peer is recognised. Self-describing (stores the full identity + name), one file
  // per identity (per-writer). secret_hash + last_seen are kept for verification/audit and dormancy GC. ----
  const registrations = {
    async put(identity, record) {
      const { primary } = identityKeys(identity, readable)
      await writeAtomic(dir('registrations', `${primary}.reg`), JSON.stringify({
        name: record.name, realm: identity.realm, project: identity.project, user: identity.user,
        secret_hash: record.secret_hash || null, client_kind: record.client_kind || null,
        last_seen: record.last_seen || new Date().toISOString() }))
    },
    async all() {
      const rdir = dir('registrations'), out = []
      for (const f of await readDirSafe(rdir)) { if (!f.endsWith('.reg')) continue; const j = await readJson(path.join(rdir, f)); if (j) out.push(j) }
      return out
    },
    async byName(name) {   // every durable registration with this name (case-insensitive); caller scopes by project/consent
      const want = String(name || '').trim().toLowerCase()
      return (await this.all()).filter(r => String(r.name || '').trim().toLowerCase() === want)
    },
    async remove(identity) {
      const { both } = identityKeys(identity, readable)
      for (const key of new Set(both)) { try { await fsp.unlink(dir('registrations', `${key}.reg`)) } catch {} }
    },
    async gcAll({ now = Date.now(), maxAgeMs = 0 } = {}) {   // drop registrations whose peer hasn't been seen within maxAgeMs
      if (!maxAgeMs) return 0
      let dropped = 0, rdir = dir('registrations')
      for (const f of await readDirSafe(rdir)) {
        if (!f.endsWith('.reg')) continue
        const file = path.join(rdir, f), j = await readJson(file)
        const t = j && Date.parse(j.last_seen || '')
        if (j && t && now - t > maxAgeMs) { try { await fsp.unlink(file) } catch {} dropped++ }
      }
      return dropped
    },
  }

  // ---- subscriptions: durable per-holder interest, so a returning session keeps its subscriptions and the
  // register_self resync can hand them back. One file per (holder, pattern); self-describing. ----
  const subscriptions = {
    async put(identity, pattern, record = {}) {
      const { primary } = identityKeys(identity, readable)
      await writeAtomic(dir('subscriptions', primary, `${lslug(pattern, 80)}.sub`), JSON.stringify({
        pattern, realm: identity.realm, project: identity.project, user: identity.user, name: identity.name,
        subscribed_at: record.subscribed_at || new Date().toISOString() }))
    },
    async byHolder(identity) {
      const { both } = identityKeys(identity, readable), out = []
      for (const key of new Set(both)) {
        const sdir = dir('subscriptions', key)
        for (const f of await readDirSafe(sdir)) { if (!f.endsWith('.sub')) continue; const j = await readJson(path.join(sdir, f)); if (j) out.push(j) }
      }
      return out
    },
    async remove(identity, pattern) {
      const { both } = identityKeys(identity, readable)
      for (const key of new Set(both)) { try { await fsp.unlink(dir('subscriptions', key, `${lslug(pattern, 80)}.sub`)) } catch {} }
    },
    async gcAll({ now = Date.now(), maxAgeMs = 0 } = {}) {
      if (!maxAgeMs) return 0
      let dropped = 0, base = dir('subscriptions')
      for (const keyDir of await readDirSafe(base)) {
        const sdir = path.join(base, keyDir)
        for (const f of await readDirSafe(sdir)) {
          if (!f.endsWith('.sub')) continue
          const file = path.join(sdir, f), j = await readJson(file)
          const t = j && Date.parse(j.subscribed_at || '')
          if (j && t && now - t > maxAgeMs) { try { await fsp.unlink(file) } catch {} dropped++ }
        }
      }
      return dropped
    },
  }

  // ---- vault: the user-sealed secret per identity, for presence-gated recovery (§21). Ciphertext only
  // (sealed to the user's TPM); never the plaintext secret. One file per identity. ----
  const vault = {
    async put(identity, record) {
      const { primary } = identityKeys(identity, readable)
      await writeAtomic(dir('vault', `${primary}.vault`), JSON.stringify({
        realm: identity.realm, project: identity.project, user: identity.user, name: identity.name,
        sealed: record.sealed, sealed_at: record.sealed_at || new Date().toISOString() }))
    },
    async get(identity) {
      const { both } = identityKeys(identity, readable)
      for (const key of new Set(both)) { const j = await readJson(dir('vault', `${key}.vault`)); if (j) return j }
      return null
    },
    async remove(identity) {
      const { both } = identityKeys(identity, readable)
      for (const key of new Set(both)) { try { await fsp.unlink(dir('vault', `${key}.vault`)) } catch {} }
    },
  }

  // ---- retained: one file per publisher; effective value = newest ts. The topic is stored in-body (the
  // dir slug is lossy) so allForProject can recover it for wildcard subscribe-time catch-up. ----
  const retained = {
    async put(project, topic, identity, record) {
      const { primary } = identityKeys(identity, readable)
      await writeAtomic(dir('retained', lslug(project), lslug(topic), `${primary}.val`),
        JSON.stringify({ ts: record.ts || new Date().toISOString(), topic, project, record }))
    },
    async read(project, topic) {
      const rdir = dir('retained', lslug(project), lslug(topic)); let best = null
      for (const f of await readDirSafe(rdir)) { if (!f.endsWith('.val')) continue; const j = await readJson(path.join(rdir, f)); if (j && (!best || j.ts > best.ts)) best = j }
      return best ? best.record : null
    },
    async allForProject(project) {   // newest value per topic in this project: [{ topic, record }]
      const pdir = dir('retained', lslug(project)), out = []
      for (const topicSlug of await readDirSafe(pdir)) {
        const tdir = path.join(pdir, topicSlug); let best = null
        for (const f of await readDirSafe(tdir)) { if (!f.endsWith('.val')) continue; const j = await readJson(path.join(tdir, f)); if (j && (!best || j.ts > best.ts)) best = j }
        if (best) out.push({ topic: best.topic, record: best.record })
      }
      return out
    },
    async gcAll({ now = Date.now(), ttlMs = 0 } = {}) {   // drop retained values older than ttlMs
      if (!ttlMs) return 0
      let dropped = 0, base = dir('retained')
      for (const proj of await readDirSafe(base)) for (const topicSlug of await readDirSafe(path.join(base, proj))) {
        const tdir = path.join(base, proj, topicSlug)
        for (const f of await readDirSafe(tdir)) {
          if (!f.endsWith('.val')) continue
          const file = path.join(tdir, f), j = await readJson(file)
          if (j && now - Date.parse(j.ts) > ttlMs) { try { await fsp.unlink(file) } catch {} dropped++ }
        }
      }
      return dropped
    },
  }

  // ---- kept-alive (ownerless) topics (#26): when an owner releases a topic with keep_alive (or it was claimed
  // keep_alive), the topic survives as a durable OWNERLESS marker so directed sends PARK against it (in the
  // mailbox, keyed by a synthetic topic identity) until someone reclaims it and drains the queue. A safety TTL
  // (ownerless_since + limits.ownerlessTtlMs) drops abandoned ones. Self-describing: carries the topic metadata
  // to hand to the next owner. One file per topic. ----
  const keptTopics = {
    async put(project, topic, record) {
      await writeAtomic(dir('kept', lslug(project), `${lslug(topic, 80)}.kept`),
        JSON.stringify({ realm: record.realm || 'default', project, topic,
          description: record.description || '', icon: record.icon || null, exclusive: !!record.exclusive,
          announce_offline: !!record.announce_offline, keep_alive: true,
          behaviors: Array.isArray(record.behaviors) ? record.behaviors : [],   // #29: topic-scoped reminders ride along to the next owner
          ownerless_since: record.ownerless_since || new Date().toISOString() }))
    },
    async get(project, topic) { return readJson(dir('kept', lslug(project), `${lslug(topic, 80)}.kept`)) },
    async remove(project, topic) { try { await fsp.unlink(dir('kept', lslug(project), `${lslug(topic, 80)}.kept`)) } catch {} },
    async all() {
      const out = [], base = dir('kept')
      for (const proj of await readDirSafe(base)) for (const f of await readDirSafe(path.join(base, proj))) {
        if (!f.endsWith('.kept')) continue; const j = await readJson(path.join(base, proj, f)); if (j) out.push(j)
      }
      return out
    },
    // drop ownerless topics past the safety TTL; returns the dropped markers so the caller can also clear their parked mail + LOG it
    async gcAll({ now = Date.now(), ttlMs = 0 } = {}) {
      if (!ttlMs) return []
      const dropped = [], base = dir('kept')
      for (const proj of await readDirSafe(base)) for (const f of await readDirSafe(path.join(base, proj))) {
        if (!f.endsWith('.kept')) continue
        const file = path.join(base, proj, f), j = await readJson(file)
        const t = j && Date.parse(j.ownerless_since || '')
        if (j && t && now - t > ttlMs) { try { await fsp.unlink(file) } catch {} dropped.push({ realm: j.realm, project: j.project, topic: j.topic }) }
      }
      return dropped
    },
  }

  // ---- behaviors (#29): a session's own 'how to behave when a message arrives' reminders, scoped to a topic it
  // owns / a host / a project / a subscription pattern / all. Durable per-identity (rehydrated on resync), one
  // file per (scope, match). Self-describing. The bridge returns the matching ones alongside each delivered message. ----
  const behaviors = {
    async put(identity, scope, match, behavior) {
      await writeAtomic(dir('behaviors', identityKeys(identity, readable).primary, `${slug(scope, 16)}__${lslug(match || '', 80)}.beh`),
        JSON.stringify({ realm: identity.realm, project: identity.project, user: identity.user, name: identity.name,
          scope, match: match || null, behavior: String(behavior || ''), set_at: new Date().toISOString() }))
    },
    async byHolder(identity) {
      const { both } = identityKeys(identity, readable), out = []
      for (const key of new Set(both)) {
        const bdir = dir('behaviors', key)
        for (const f of await readDirSafe(bdir)) { if (!f.endsWith('.beh')) continue; const j = await readJson(path.join(bdir, f)); if (j) out.push(j) }
      }
      return out
    },
    async remove(identity, scope, match) {
      const { both } = identityKeys(identity, readable)
      for (const key of new Set(both)) { try { await fsp.unlink(dir('behaviors', key, `${slug(scope, 16)}__${lslug(match || '', 80)}.beh`)) } catch {} }
    },
    async clear(identity) {   // drop ALL of an identity's behaviors
      const { both } = identityKeys(identity, readable)
      for (const key of new Set(both)) { const bdir = dir('behaviors', key); for (const f of await readDirSafe(bdir)) { if (f.endsWith('.beh')) try { await fsp.unlink(path.join(bdir, f)) } catch {} } }
    },
    async all() {
      const out = [], base = dir('behaviors')
      for (const key of await readDirSafe(base)) for (const f of await readDirSafe(path.join(base, key))) {
        if (!f.endsWith('.beh')) continue; const j = await readJson(path.join(base, key, f)); if (j) out.push(j)
      }
      return out
    },
  }

  // a read-only summary of every store for the dashboard's persistence view. Records are self-describing,
  // so this shows real identities/topics (not opaque hashes). Capped per store to bound the payload.
  async function snapshot() {
    const cap = 400
    const readAll = async (sub, ext, map) => {
      const out = [], base = dir(sub)
      const walk = async (d, depth) => {
        for (const f of await readDirSafe(d)) {
          if (out.length >= cap) return
          const p = path.join(d, f)
          let st; try { st = await fsp.stat(p) } catch { continue }
          if (st.isDirectory()) { if (depth < 4) await walk(p, depth + 1) }
          else if (f.endsWith(ext)) { const j = await readJson(p); if (j) out.push(map(j, st)) }
        }
      }
      await walk(base, 0)
      return out
    }
    const msgs = await readAll('mailboxes', '.msg', (j, st) => ({ for: j.for || null, ts: j.ts, bytes: st.size }))
    const mboxes = {}
    for (const m of msgs) { const who = m.for ? `${m.for.project}/${m.for.user}/${m.for.name}` : '(unknown)'; const e = mboxes[who] || (mboxes[who] = { who, count: 0, bytes: 0, oldest: m.ts }); e.count++; e.bytes += m.bytes; if (m.ts < e.oldest) e.oldest = m.ts }
    const claims = await readAll('claims', '.claim', j => ({ project: j.project, topic: j.pattern, holder_name: j.holder_name, user: j.user, exclusive: !!j.exclusive, announce_offline: !!j.announce_offline, refreshed_at: j.refreshed_at }))
    const grants = await readAll('grants', '.grant', j => ({ from: j.from, to: j.to, mode: j.mode, exp: j.exp || null, granted_at: j.granted_at }))
    const registrations = await readAll('registrations', '.reg', j => ({ name: j.name, project: j.project, user: j.user, client_kind: j.client_kind, last_seen: j.last_seen }))
    const subscriptions = await readAll('subscriptions', '.sub', j => ({ name: j.name, project: j.project, user: j.user, pattern: j.pattern }))
    const retained = await readAll('retained', '.val', j => ({ project: j.project, topic: j.topic, ts: j.ts }))
    const vaults = await readAll('vault', '.vault', j => ({ name: j.name, project: j.project, user: j.user, sealed_at: j.sealed_at }))   // identities only — never the sealed value
    const kept = await readAll('kept', '.kept', j => ({ project: j.project, topic: j.topic, icon: j.icon, exclusive: !!j.exclusive, ownerless_since: j.ownerless_since }))
    const behaviors = await readAll('behaviors', '.beh', j => ({ name: j.name, project: j.project, user: j.user, scope: j.scope, match: j.match, behavior: j.behavior }))
    return {
      enabled: true, readable, dir: root,
      counts: { parked: msgs.length, mailboxes: Object.keys(mboxes).length, claims: claims.length, grants: grants.length, registrations: registrations.length, subscriptions: subscriptions.length, vault: vaults.length, retained: retained.length, kept: kept.length, behaviors: behaviors.length },
      vault: vaults, kept, behaviors,
      mailboxes: Object.values(mboxes).sort((a, b) => b.count - a.count), claims, grants, registrations, subscriptions, retained,
    }
  }

  return {
    meta, root, readable, mailbox, claims, grants, registrations, subscriptions, vault, retained, keptTopics, behaviors, snapshot,
    // config-resolved knobs (parsed once) for the bridge to apply in later stages
    limits: {
      messageTtlMs: (Number(cfg.messageTtlDays) || 14) * 86400000,
      retainedTtlMs: (Number(cfg.retainedTtlDays) || 14) * 86400000,
      graceMs: (Number(cfg.claimGraceMinutes) || 60) * 60000,
      hardExpiryMs: (Number(cfg.claimHardExpiryDays) || 14) * 86400000,
      ownerlessTtlMs: (Number(cfg.ownerlessTtlDays) || 7) * 86400000,   // #26: abandoned kept-alive topics drop after this
      mailboxMaxCount: Number(cfg.mailboxMaxCount) || 1000,
      mailboxMaxBytes: parseSize(cfg.mailboxMaxSize) ?? (16 * 1024 * 1024),
    },
  }
}
