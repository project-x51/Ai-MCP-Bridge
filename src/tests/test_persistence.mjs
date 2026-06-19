// Persistence facet (§12) unit tests: the size-string parser, format-prefixed stable identity keys
// (+ both-form lookup so flipping devReadableKeys strands nothing), and the conflict-free
// mailbox/claims/retained file store (content-addressing, caps, TTL gc). No bridge spawn — pure facet.
import { create, parseSize, identityKeys } from '../facets/persistence/file.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0, fail = 0
const check = (n, c, x = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimb-persist-'))
const mk = (readable = false) => create({ HERE: tmp, CFG: { persistence: { dir: '.', devReadableKeys: readable, mailboxMaxSize: '1MB' } }, log: () => {} })
const ID = { realm: 'default', project: 'AIMB', user: 'Robin', name: 'Bridget' }

// ---- size-string parser ----
check('parseSize 16MB', parseSize('16MB') === 16 * 1024 * 1024)
check('parseSize decimals + space', parseSize('12.5 MB') === Math.floor(12.5 * 1024 * 1024))
check('parseSize 1 GB', parseSize('1 GB') === 1024 ** 3)
check('parseSize unitless bytes', parseSize('1048576') === 1048576)
check('parseSize kb/k lowercase', parseSize('1kb') === 1024 && parseSize('2 k') === 2048)
check('parseSize number passthrough', parseSize(4096) === 4096)
check('parseSize invalid -> null', parseSize('') === null && parseSize('big') === null && parseSize('-5MB') === null)
check('config size parsed into limits', mk(false).limits.mailboxMaxBytes === 1024 * 1024)

// ---- format-prefixed stable keys ----
const kH = identityKeys(ID, false), kR = identityKeys(ID, true)
check('hashed key h- prefix + stable', kH.primary.startsWith('h-') && identityKeys(ID, false).primary === kH.primary)
check('readable key r- + lower-slug + 4hash', kR.primary.startsWith('r-') && kR.primary.includes('bridget') && /-[0-9a-f]{4}$/.test(kR.primary))
check('different identity -> different key', identityKeys({ ...ID, name: 'Other' }, false).primary !== kH.primary)
check('both forms returned regardless of mode', kH.both.length === 2 && kH.both.join() === kR.both.join())
// identity keys are CASE-INSENSITIVE: case/whitespace variants of the same identity collapse to one key,
// so "Bridget"/"bridget"/"Robin"/"robin" never split a mailbox/claim/vault (the case-insensitive design).
check('identity key is case-insensitive', identityKeys({ ...ID, user: 'robin', name: 'BRIDGET' }, false).primary === kH.primary
  && identityKeys({ ...ID, name: '  bridget  ' }, true).primary === kR.primary)

// ---- mailbox round-trip + content-addressing ----
const fR = mk(true), fH = mk(false)
await fR.mailbox.put(ID, 'e1', { ts: '2026-06-17T00:00:00.000Z', body: 'one' })
await fR.mailbox.put(ID, 'e2', { ts: '2026-06-17T00:00:01.000Z', body: 'two' })
await fR.mailbox.put(ID, 'e1', { ts: '2026-06-17T00:00:00.000Z', body: 'one' })   // same envId -> idempotent
const d = await fR.mailbox.drain(ID)
check('mailbox drains parked messages', d.length === 2, 'len=' + d.length)
check('content-addressed: duplicate envId not double-stored', d.filter(m => m.envId === 'e1').length === 1)
check('drain oldest-first', d[0].envId === 'e1' && d[1].envId === 'e2')

// ---- both-form lookup: written readable, drained hashed -> still found ----
check('flip devReadableKeys: mail under other prefix still found', (await fH.mailbox.drain(ID)).length === 2)

// ---- ack ----
await fR.mailbox.ack(ID, 'e1')
check('ack removes the message', (await fR.mailbox.drain(ID)).length === 1)

// ---- caps (drop oldest) + TTL gc, drops reported for logging ----
const cid = { ...ID, name: 'CapTest' }
for (let i = 0; i < 5; i++) await fH.mailbox.put(cid, 'c' + i, { ts: `2026-06-17T00:00:0${i}.000Z`, body: i })
const dCount = await fH.mailbox.gc(cid, { maxCount: 3 })
check('gc drops oldest over count cap + reports them', dCount.length === 2 && dCount.every(x => x.why === 'count'), JSON.stringify(dCount))
check('gc leaves exactly the cap', (await fH.mailbox.drain(cid)).length === 3)
const tid = { ...ID, name: 'TtlTest' }
await fH.mailbox.put(tid, 'old', { ts: '2000-01-01T00:00:00.000Z', body: 'stale' })
const dTtl = await fH.mailbox.gc(tid, { ttlMs: 86400000 })
check('gc drops expired by ttl', dTtl.length === 1 && dTtl[0].why === 'ttl' && (await fH.mailbox.drain(tid)).length === 0)

// ---- claims: per-holder files, ownership computed by caller ----
const A = { ...ID, name: 'A' }, B = { ...ID, name: 'B' }
await fH.claims.put('AIMB', 'Bridge', A, { topic: 'Bridge', holder: 'A', claimed_at: '2026-06-17T00:00:00Z' })
await fH.claims.put('AIMB', 'Bridge', B, { topic: 'Bridge', holder: 'B', claimed_at: '2026-06-17T00:00:01Z' })
check('claims: per-holder files, read returns all claimants', (await fH.claims.read('AIMB', 'Bridge')).length === 2)
await fH.claims.remove('AIMB', 'Bridge', B)
check('claims: remove one holder', (await fH.claims.read('AIMB', 'Bridge')).length === 1)
await fH.claims.put('AIMB', 'online-tool/retail', A, { topic: 'online-tool/retail', holder: 'A' })
check('claims: topic path with slash stored + read', (await fH.claims.read('AIMB', 'online-tool/retail')).length === 1)
// byHolder: every claim filed by an identity, across projects/topics (drives rehydrate-on-register)
const byA = await fH.claims.byHolder(A)
check('claims.byHolder returns all of one holder\'s claims', byA.length === 2 && byA.every(r => r.holder === 'A'), JSON.stringify(byA.map(r => r.topic)))
check('claims.byHolder is holder-scoped (B removed earlier -> none)', (await fH.claims.byHolder(B)).length === 0)
// both-form lookup: a claim written readable is still found by a hashed-mode drain
await fR.claims.put('AIMB', 'flip', A, { topic: 'flip', holder: 'A' })
check('claims.byHolder finds claims under the other key form', (await fH.claims.byHolder(A)).some(r => r.topic === 'flip'))
// gcAll: a claim past hard expiry (stale refreshed_at) is dropped; a fresh one survives. Own dir so the
// drop COUNT is deterministic (the shared root above holds unrelated claims).
const fG = create({ HERE: tmp, CFG: { persistence: { dir: './gctest' } }, log: () => {} })
const gid = { ...ID, name: 'StaleClaim' }
await fG.claims.put('AIMB', 'old-resp', gid, { topic: 'old-resp', refreshed_at: '2000-01-01T00:00:00.000Z' })
await fG.claims.put('AIMB', 'fresh-resp', gid, { topic: 'fresh-resp', refreshed_at: new Date(Date.now() - 1000).toISOString() })
const droppedC = await fG.claims.gcAll({ maxAgeMs: 86400000 })
const gAfter = (await fG.claims.byHolder(gid)).map(r => r.topic)
check('claims.gcAll drops claims past hard expiry only', droppedC === 1 && gAfter.includes('fresh-resp') && !gAfter.includes('old-resp'), 'dropped=' + droppedC + ' after=' + JSON.stringify(gAfter))

// ---- registrations: durable name->identity, case-insensitive byName, self-describing, gc by last_seen ----
const now = new Date().toISOString()
await fH.registrations.put({ ...ID, name: 'Scout' }, { name: 'Scout', secret_hash: 'abc', client_kind: 'code', last_seen: now })
await fH.registrations.put({ ...ID, name: 'Other' }, { name: 'Other', last_seen: now })
check('registrations.byName is case-insensitive', (await fH.registrations.byName('scout')).length === 1 && (await fH.registrations.byName('SCOUT')).length === 1)
const regRec = (await fH.registrations.byName('scout'))[0]
check('registration record is self-describing (carries identity)', regRec.user === ID.user && regRec.project === ID.project && regRec.name === 'Scout')
check('byName matches only the named registration', (await fH.registrations.byName('other')).length === 1)
await fH.registrations.put({ ...ID, name: 'Stale' }, { name: 'Stale', last_seen: '2000-01-01T00:00:00.000Z' })
const dropReg = await fH.registrations.gcAll({ maxAgeMs: 86400000 })
check('registrations.gcAll drops only the unseen-past-maxAge one', dropReg === 1 && (await fH.registrations.byName('stale')).length === 0 && (await fH.registrations.byName('scout')).length === 1, 'dropped=' + dropReg)
await fH.registrations.remove({ ...ID, name: 'Scout' })
check('registrations.remove', (await fH.registrations.byName('scout')).length === 0)

// ---- subscriptions: durable per-holder interest, self-describing, gc by subscribed_at ----
await fH.subscriptions.put({ ...ID, name: 'Sub1' }, 'team/#')
await fH.subscriptions.put({ ...ID, name: 'Sub1' }, 'alerts/+')
check('subscriptions.byHolder returns the holder\'s patterns', (await fH.subscriptions.byHolder({ ...ID, name: 'Sub1' })).map(s => s.pattern).sort().join() === 'alerts/+,team/#')
check('subscription record is self-describing', (await fH.subscriptions.byHolder({ ...ID, name: 'Sub1' }))[0].user === ID.user)
await fH.subscriptions.remove({ ...ID, name: 'Sub1' }, 'team/#')
check('subscriptions.remove', (await fH.subscriptions.byHolder({ ...ID, name: 'Sub1' })).map(s => s.pattern).join() === 'alerts/+')
await fH.subscriptions.put({ ...ID, name: 'StaleSub' }, 'old/#', { subscribed_at: '2000-01-01T00:00:00.000Z' })
const dropSub = await fH.subscriptions.gcAll({ maxAgeMs: 86400000 })
check('subscriptions.gcAll drops unseen-past-maxAge', dropSub >= 1 && (await fH.subscriptions.byHolder({ ...ID, name: 'StaleSub' })).length === 0, 'dropped=' + dropSub)

// ---- vault: the user-sealed secret per identity (ciphertext only) ----
await fH.vault.put({ ...ID, name: 'Vaulted' }, { sealed: 'tpm:abc123' })
const got = await fH.vault.get({ ...ID, name: 'Vaulted' })
check('vault.get returns the sealed ciphertext + identity', !!got && got.sealed === 'tpm:abc123' && got.name === 'Vaulted' && got.user === ID.user, JSON.stringify(got))
check('vault is identity-scoped (different name -> none)', (await fH.vault.get({ ...ID, name: 'Other' })) === null)
await fH.vault.remove({ ...ID, name: 'Vaulted' })
check('vault.remove', (await fH.vault.get({ ...ID, name: 'Vaulted' })) === null)

// ---- mailbox stores the recipient identity (self-describing), not only the hashed key ----
await fH.mailbox.put({ ...ID, name: 'SelfDesc' }, 'sd1', { ts: '2026-06-18T00:00:00.000Z', body: 'x' })
const sd = (await fH.mailbox.drain({ ...ID, name: 'SelfDesc' }))[0]
const sdRaw = JSON.parse(fs.readFileSync(sd._file, 'utf8'))
check('parked .msg carries the recipient identity (for)', !!sdRaw.for && sdRaw.for.user === ID.user && sdRaw.for.name === 'SelfDesc', JSON.stringify(sdRaw.for))

// ---- retained: newest publisher value wins ----
await fH.retained.put('AIMB', 'news', A, { ts: '2026-06-17T00:00:00.000Z', body: 'old' })
await fH.retained.put('AIMB', 'news', B, { ts: '2026-06-17T00:00:05.000Z', body: 'new' })
const ret = await fH.retained.read('AIMB', 'news')
check('retained: newest value wins', !!ret && ret.body === 'new', JSON.stringify(ret))
const allRet = await fH.retained.allForProject('AIMB')
check('retained.allForProject returns newest per topic, tagged with topic', allRet.some(x => x.topic === 'news' && x.record.body === 'new'), JSON.stringify(allRet.map(x => x.topic)))
await fH.retained.put('AIMB', 'stale-news', A, { ts: '2000-01-01T00:00:00.000Z', body: 'ancient' })
const dropRet = await fH.retained.gcAll({ ttlMs: 86400000 })
check('retained.gcAll drops values older than ttl', dropRet >= 1 && !(await fH.retained.allForProject('AIMB')).some(x => x.topic === 'stale-news'), 'dropped=' + dropRet)

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
