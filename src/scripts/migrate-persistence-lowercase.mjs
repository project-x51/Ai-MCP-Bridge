// One-shot migration for the v1.17 case-insensitive change: lower-case every persistence KEY so existing
// mixed-case data (projects/users/names like "CamelCo", "MyName") is found by the new lower-cased hashes and
// claim/topic paths. Without it, a 1.15→1.17 restart orphans parked mail and durable claims/registrations
// (they self-heal on re-claim/re-register, but parked MAIL would strand). Records are self-describing, so we
// recompute each new key from the record body using the FACET'S OWN key logic (identityKeys/lslug) — no drift.
//
//   node scripts/migrate-persistence-lowercase.mjs <persistence-dir>            # dry-run: print the plan
//   node scripts/migrate-persistence-lowercase.mjs <persistence-dir> --apply    # move files + verify
//
// Safe to re-run: once keys are canonical, new==old and nothing moves (idempotent). ALWAYS dry-run first,
// and run --apply only while the bridge is STOPPED (so it isn't writing concurrently).
import { identityKeys, lslug } from '../facets/persistence/file.js'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.argv[2] || '../persistence')
const APPLY = process.argv.includes('--apply')
if (!fs.existsSync(ROOT)) { console.error('persistence dir not found:', ROOT); process.exit(2) }
console.log(`\n=== persistence lower-case migration ===\ndir:   ${ROOT}\nmode:  ${APPLY ? 'APPLY (moving files)' : 'DRY-RUN (no changes)'}\n`)

const d = (...p) => path.join(ROOT, ...p)
const readdir = p => { try { return fs.readdirSync(p) } catch { return [] } }
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const idOf = r => ({ realm: r.realm || 'default', project: r.project, user: r.user, name: r.name })
const keyForm = oldKey => oldKey.startsWith('r-')   // preserve the on-disk form (readable r- vs hashed h-) per entry
const plan = []        // { store, old, new }
const skips = []       // { store, file, why }
let collisions = 0

// On a case-INSENSITIVE filesystem (NTFS/APFS) "CamelCo" and "camelco" are the SAME physical dir, so a
// case-only path change is a no-op there — detect this so the migration stays idempotent (re-running plans 0
// moves) and we don't churn on cosmetic dir casing. A hash that CHANGES VALUE (ce25→b319) still differs
// case-insensitively, so the identity re-key still happens; only pure-case diffs are treated as "already there".
function fsCaseInsensitive(dir) {
  try {
    const probe = path.join(dir, `.CaseProbe_${process.pid}`)
    fs.writeFileSync(probe, '')
    const ci = fs.existsSync(path.join(dir, `.caseprobe_${process.pid}`))
    fs.unlinkSync(probe)
    return ci
  } catch { return false }
}
const CI = fsCaseInsensitive(ROOT)
const samePlace = (a, b) => { const ra = path.resolve(a), rb = path.resolve(b); return CI ? ra.toLowerCase() === rb.toLowerCase() : ra === rb }
console.log(`filesystem: ${CI ? 'case-INSENSITIVE (dir casing is cosmetic; identity hashes still re-keyed)' : 'case-sensitive'}\n`)

function planMove(store, oldAbs, newAbs) {
  if (samePlace(oldAbs, newAbs)) return                                // already canonical (FS-case-aware) — nothing to do
  plan.push({ store, old: oldAbs, new: newAbs })
}

// ---- mailboxes/<idKey>/<env_*.msg>  (re-key the identity DIR; filename is content-addressed, kept) ----
for (const key of readdir(d('mailboxes'))) {
  const kdir = d('mailboxes', key); if (!fs.statSync(kdir).isDirectory()) continue
  for (const f of readdir(kdir)) {
    if (!f.endsWith('.msg')) continue
    const body = readJson(path.join(kdir, f))
    if (!body || !body.for || !body.for.project) { skips.push({ store: 'mailboxes', file: path.join('mailboxes', key, f), why: 'no recipient identity in body (for)' }); continue }
    const nk = identityKeys(idOf(body.for), keyForm(key)).primary
    planMove('mailboxes', path.join(kdir, f), d('mailboxes', nk, f))
  }
}

// ---- claims/<project>/<topic>/<idKey>.claim  (lower-case project+topic dirs AND the identity filename) ----
for (const proj of readdir(d('claims'))) {
  const pdir = d('claims', proj); if (!fs.existsSync(pdir) || !fs.statSync(pdir).isDirectory()) continue
  for (const topic of readdir(pdir)) {
    const tdir = path.join(pdir, topic); if (!fs.statSync(tdir).isDirectory()) continue
    for (const f of readdir(tdir)) {
      if (!f.endsWith('.claim')) continue
      const r = readJson(path.join(tdir, f))
      if (!r || !r.project || !r.pattern || !(r.name || r.user)) { skips.push({ store: 'claims', file: path.join('claims', proj, topic, f), why: 'record missing project/pattern/identity' }); continue }
      const nk = identityKeys(idOf(r), keyForm(f.replace(/\.claim$/, ''))).primary
      planMove('claims', path.join(tdir, f), d('claims', lslug(r.project), lslug(r.pattern), nk + '.claim'))
    }
  }
}

// ---- registrations/<idKey>.reg ----
for (const f of readdir(d('registrations'))) {
  if (!f.endsWith('.reg')) continue
  const r = readJson(d('registrations', f))
  if (!r || !r.project || !(r.name || r.user)) { skips.push({ store: 'registrations', file: path.join('registrations', f), why: 'record missing identity' }); continue }
  const nk = identityKeys(idOf(r), keyForm(f.replace(/\.reg$/, ''))).primary
  planMove('registrations', d('registrations', f), d('registrations', nk + '.reg'))
}

// ---- subscriptions/<idKey>/<pattern>.sub  (re-key dir + lower-case the pattern filename) ----
for (const key of readdir(d('subscriptions'))) {
  const kdir = d('subscriptions', key); if (!fs.existsSync(kdir) || !fs.statSync(kdir).isDirectory()) continue
  for (const f of readdir(kdir)) {
    if (!f.endsWith('.sub')) continue
    const r = readJson(path.join(kdir, f))
    if (!r || !r.project || !r.pattern || !(r.name || r.user)) { skips.push({ store: 'subscriptions', file: path.join('subscriptions', key, f), why: 'record missing identity/pattern' }); continue }
    const nk = identityKeys(idOf(r), keyForm(key)).primary
    planMove('subscriptions', path.join(kdir, f), d('subscriptions', nk, lslug(r.pattern, 80) + '.sub'))
  }
}

// ---- vault/<idKey>.vault ----
for (const f of readdir(d('vault'))) {
  if (!f.endsWith('.vault')) continue
  const r = readJson(d('vault', f))
  if (!r || !r.project || !(r.name || r.user)) { skips.push({ store: 'vault', file: path.join('vault', f), why: 'record missing identity' }); continue }
  const nk = identityKeys(idOf(r), keyForm(f.replace(/\.vault$/, ''))).primary
  planMove('vault', d('vault', f), d('vault', nk + '.vault'))
}

// ---- retained/<project>/<topic>/<file>.val  (no identity in body → lower-case PATH only, keep filename) ----
for (const proj of readdir(d('retained'))) {
  const pdir = d('retained', proj); if (!fs.existsSync(pdir) || !fs.statSync(pdir).isDirectory()) continue
  for (const topic of readdir(pdir)) {
    const tdir = path.join(pdir, topic); if (!fs.statSync(tdir).isDirectory()) continue
    for (const f of readdir(tdir)) {
      if (!f.endsWith('.val')) continue
      const r = readJson(path.join(tdir, f))
      if (!r || !r.project || !r.topic) { skips.push({ store: 'retained', file: path.join('retained', proj, topic, f), why: 'record missing project/topic' }); continue }
      planMove('retained', path.join(tdir, f), d('retained', lslug(r.project), lslug(r.topic), f))
    }
  }
}

// ---- report the plan ----
const rel = p => path.relative(ROOT, p)
for (const m of plan) console.log(`  [${m.store}] ${rel(m.old)}\n        -> ${rel(m.new)}`)
if (skips.length) { console.log('\n  SKIPPED (left in place):'); for (const s of skips) console.log(`    [${s.store}] ${s.file} — ${s.why}`) }
console.log(`\nplanned moves: ${plan.length}  |  skipped: ${skips.length}`)

if (!APPLY) { console.log('\nDRY-RUN only. Re-run with --apply (bridge STOPPED) to perform the moves.\n'); process.exit(0) }

// ---- apply: move files, then prune empty source dirs ----
let moved = 0
for (const m of plan) {
  fs.mkdirSync(path.dirname(m.new), { recursive: true })
  if (fs.existsSync(m.new)) { collisions++; console.log(`  ! collision (same canonical key) — overwriting: ${rel(m.new)}`) }
  fs.renameSync(m.old, m.new)
  moved++
}
// prune now-empty dirs under the identity/path stores (bottom-up)
function prune(base) {
  const walk = dir => {
    for (const e of readdir(dir)) { const p = path.join(dir, e); if (fs.existsSync(p) && fs.statSync(p).isDirectory()) walk(p) }
    if (fs.existsSync(dir) && dir !== base && readdir(dir).length === 0) { try { fs.rmdirSync(dir) } catch {} }
  }
  if (fs.existsSync(base)) walk(base)
}
for (const s of ['mailboxes', 'claims', 'registrations', 'subscriptions', 'vault', 'retained']) prune(d(s))
console.log(`\nAPPLIED: ${moved} moved, ${collisions} collision-overwrites.`)

// ---- verify: reload the facet against the migrated dir and confirm every record reads back ----
console.log('\n=== verify (reading through the v1.17 facet) ===')
const { create } = await import('../facets/persistence/file.js')
const facet = create({ HERE: ROOT, CFG: { persistence: { dir: '.' } }, env: {} })
let ok = 0, bad = 0
const check = (n, c) => { c ? (ok++, console.log('  PASS', n)) : (bad++, console.log('  FAIL', n)) }

// claims: every claim is found by byHolder under its (now lower-cased) identity, and by read(project,topic)
const claimIds = new Map()
for (const proj of readdir(d('claims'))) for (const topic of readdir(d('claims', proj))) for (const f of readdir(d('claims', proj, topic))) {
  if (!f.endsWith('.claim')) continue; const r = readJson(d('claims', proj, topic, f)); if (r) claimIds.set(JSON.stringify(idOf(r)) + '|' + r.pattern, r)
}
for (const [, r] of claimIds) {
  const byh = await facet.claims.byHolder(idOf(r))
  check(`claims.byHolder finds ${r.holder_name || r.name}/${r.pattern}`, byh.some(x => x.pattern === r.pattern))
  const rd = await facet.claims.read(r.project, r.pattern)
  check(`claims.read(${r.project},${r.pattern}) returns ${rd.length} record(s)`, rd.length >= 1)
}
// mailboxes: every parked msg drains for its recipient
const mboxIds = new Map()
for (const key of readdir(d('mailboxes'))) for (const f of readdir(d('mailboxes', key))) {
  if (!f.endsWith('.msg')) continue; const b = readJson(d('mailboxes', key, f)); if (b && b.for && b.for.project) { const k = JSON.stringify(idOf(b.for)); mboxIds.set(k, (mboxIds.get(k) || 0) + 1) }
}
for (const [k, n] of mboxIds) {
  const drained = await facet.mailbox.drain(JSON.parse(k))
  check(`mailbox.drain returns ${n} for ${JSON.parse(k).name}`, drained.length === n)
}
// registrations: each name resolves
for (const f of readdir(d('registrations'))) {
  if (!f.endsWith('.reg')) continue; const r = readJson(d('registrations', f)); if (!r) continue
  const byName = await facet.registrations.byName(r.name)
  check(`registrations.byName(${r.name}) resolves`, byName.length >= 1)
}
console.log(`\nverify: ${ok} passed, ${bad} failed`)
process.exit(bad ? 1 : 0)
