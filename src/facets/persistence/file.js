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
  const root = path.resolve(ctx.HERE || '.', cfg.dir || '../persistence')
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
      await writeAtomic(dir('mailboxes', primary, `env_${slug(envId, 80)}.msg`),
        JSON.stringify({ envId, ts: record.ts || new Date().toISOString(), record }))
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
    async remove(project, topic, identity) {
      const { both } = identityKeys(identity, readable)
      for (const key of new Set(both)) { try { await fsp.unlink(dir('claims', slug(project), slug(topic), `${key}.claim`)) } catch {} }
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
    meta, root, readable, mailbox, claims, retained,
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
