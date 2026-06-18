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

const slug = (s, max = 48) => String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || '_'

// Stable, format-prefixed on-disk key for an identity (§12). `primary` is the form for the current mode;
// `both` is [hashed, readable] so a drain finds data written under the OTHER mode — flipping
// devReadableKeys with files already on disk strands nothing.
export function identityKeys(identity, readable) {
  const tuple = [identity.realm || 'default', identity.project || 'unclassified', identity.user || 'unknown', identity.name || '']
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
  const mailbox = {
    async put(identity, envId, record) {
      const { primary } = identityKeys(identity, readable)
      // self-describing: store the RECIPIENT identity in the body (not only the hashed dir key) so the parked
      // message can be attributed/migrated/audited without reversing the key (the lesson from the claim records).
      await writeAtomic(dir('mailboxes', primary, `env_${slug(envId, 80)}.msg`),
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
    async ack(identity, envId) {   // delete after delivery (try both forms)
      const { both } = identityKeys(identity, readable)
      for (const key of new Set(both)) { try { await fsp.unlink(dir('mailboxes', key, `env_${slug(envId, 80)}.msg`)) } catch {} }
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
      await writeAtomic(dir('claims', slug(project), slug(topic), `${primary}.claim`), JSON.stringify(record))
    },
    async read(project, topic) {
      const cdir = dir('claims', slug(project), slug(topic)), out = []
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
      for (const key of new Set(both)) { try { await fsp.unlink(dir('claims', slug(project), slug(topic), `${key}.claim`)) } catch {} }
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

  // ---- retained: one file per publisher; effective value = newest ts ----
  const retained = {
    async put(project, topic, identity, record) {
      const { primary } = identityKeys(identity, readable)
      await writeAtomic(dir('retained', slug(project), slug(topic), `${primary}.val`),
        JSON.stringify({ ts: record.ts || new Date().toISOString(), record }))
    },
    async read(project, topic) {
      const rdir = dir('retained', slug(project), slug(topic)); let best = null
      for (const f of await readDirSafe(rdir)) { if (!f.endsWith('.val')) continue; const j = await readJson(path.join(rdir, f)); if (j && (!best || j.ts > best.ts)) best = j }
      return best ? best.record : null
    },
  }

  return {
    meta, root, readable, mailbox, claims, grants, registrations, retained,
    // config-resolved knobs (parsed once) for the bridge to apply in later stages
    limits: {
      messageTtlMs: (Number(cfg.messageTtlDays) || 14) * 86400000,
      retainedTtlMs: (Number(cfg.retainedTtlDays) || 14) * 86400000,
      graceMs: (Number(cfg.claimGraceMinutes) || 60) * 60000,
      hardExpiryMs: (Number(cfg.claimHardExpiryDays) || 14) * 86400000,
      mailboxMaxCount: Number(cfg.mailboxMaxCount) || 1000,
      mailboxMaxBytes: parseSize(cfg.mailboxMaxSize) ?? (16 * 1024 * 1024),
    },
  }
}
