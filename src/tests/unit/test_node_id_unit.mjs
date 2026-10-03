// Fast UNIT tests for the #88 (v2.0) IDENTITY PRIMITIVES in lib/activity.js (docs/spec-88.md §8 build step 1): node ids
// (mintId / legacyId — the §1.2 vectors, case folding, an independent base32), keys (validKey's charset edges, slugKey,
// uniqueKey's clashes), labels (normLabel / labelKey), references (parseRef), `@`-free paths with quoting (parsePath2 /
// formatPath2, Q37), 1.7x `@` paths refused as `legacy-form` with the converted path, and the leading-`@` text rule
// (parseText, Q36). Pure: no bridge, no sockets, no clock. Step 11 deleted the 1.7x model these were built beside; its v5 readers live in lib/activity-v5.js.
import { createHash } from 'node:crypto'
import { testOnly } from '../helpers/check.mjs'
import * as A from '../../lib/activity.js'
import * as V5 from '../../lib/activity-v5.js'   // step 11: the 1.7x (v5) readers the migration keeps
let pass = 0, fail = 0
const check = (n, c, x = '') => { if (!testOnly(n)) return; let ok = false; try { ok = typeof c === 'function' ? !!c() : !!c } catch (e) { x = `threw: ${e && e.message} ${x}` } ok ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, x)) }
const J = JSON.stringify
async function section(fn) { try { await fn() } catch (e) { fail++; console.log('FAIL section crashed:', (e && e.message) || e) } }
const rep = (s, n) => s.repeat(n)
const BRIDGET = { host: 'ROBIN-Z790', realm: 'default', project: 'AIMB', user: 'robin', session: 'Bridget' }
// an INDEPENDENT reference id: the first 80 bits of the sha256 as 16 base32 digits, via BigInt (not the library's encoder)
const refId = parts => { const h = createHash('sha256').update(J(parts)).digest('hex').slice(0, 20); let v = BigInt('0x' + h), s = ''; for (let i = 0; i < 16; i++) { s = 'abcdefghijklmnopqrstuvwxyz234567'[Number(v & 31n)] + s; v >>= 5n } return s }

// ================================================================= ids (§1.2)
await section(() => {
  check('id: Bridget\'s session root on ROBIN-Z790 = mkjhhu3kyjf2gbcv (spec §1.2)', A.mintId(BRIDGET, '', '') === 'mkjhhu3kyjf2gbcv', A.mintId(BRIDGET, '', ''))
  check('id: the session\'s :spec-88 = uytyq4e6wsmtqsfq', A.mintId(BRIDGET, '', 'spec-88') === 'uytyq4e6wsmtqsfq')
  check('id: spec-88:docs = rtam3yvgwkzx5zbp', A.mintId(BRIDGET, 'spec-88', 'docs') === 'rtam3yvgwkzx5zbp')
  const LOUD = { host: 'robin-z790', realm: 'DEFAULT', project: 'aimb', user: 'ROBIN', session: 'BRIDGET' }
  check('id: case-insensitive in host / realm / project / user / session / chain / key', A.mintId(LOUD, 'SPEC-88', 'DOCS') === 'rtam3yvgwkzx5zbp' && A.mintId(LOUD, '', 'Spec-88') === 'uytyq4e6wsmtqsfq')
  check('id: a missing or empty realm is "default"', A.mintId({ ...BRIDGET, realm: undefined }, '', '') === 'mkjhhu3kyjf2gbcv' && A.mintId({ ...BRIDGET, realm: '' }, '', '') === 'mkjhhu3kyjf2gbcv')
  check('id: equals an independent sha256 → base32 computation (the exact formula)', A.mintId(BRIDGET, 'spec-88/research', 'notes') === refId(['aimb-node/2', 'robin-z790', 'default', 'aimb', 'robin', 'bridget', 'spec-88/research', 'notes']))
  check('id: 16 chars of lower-case RFC 4648 base32 [a-z2-7]', ['', 'a', 'spec-88', '?3', 'Über'].every(k => /^[a-z2-7]{16}$/.test(A.mintId(BRIDGET, '', k))))
  check('id: a chain given as an array = the same chain joined by /', A.mintId(BRIDGET, ['spec-88', 'research'], 'notes') === A.mintId(BRIDGET, 'spec-88/research', 'notes'))
  check('id: the same key under two creators is two nodes (spec-88:docs ≠ spec-89:docs ≠ :docs)', new Set([A.mintId(BRIDGET, 'spec-88', 'docs'), A.mintId(BRIDGET, 'spec-89', 'docs'), A.mintId(BRIDGET, '', 'docs')]).size === 3)
  check('id: another host / session / user / project / realm → another id', new Set([A.mintId(BRIDGET, '', 'docs'), A.mintId({ ...BRIDGET, host: 'LITTLE-001' }, '', 'docs'), A.mintId({ ...BRIDGET, session: 'Other' }, '', 'docs'),
    A.mintId({ ...BRIDGET, user: 'bob' }, '', 'docs'), A.mintId({ ...BRIDGET, project: 'X' }, '', 'docs'), A.mintId({ ...BRIDGET, realm: 'r2' }, '', 'docs')]).size === 6)
  check('id: deterministic (a retried create mints the same id)', A.mintId(BRIDGET, 'a', 'b') === A.mintId({ ...BRIDGET }, 'a', 'b'))
  const leg = A.legacyId(BRIDGET, '@next release/@docs')
  check('legacy id: ["aimb-node/legacy", …session…, pathKey] (independent computation)', leg === refId(['aimb-node/legacy', 'robin-z790', 'default', 'aimb', 'robin', 'bridget', '@next release/@docs']), leg)
  check('legacy id: case-insensitive (the v5 key is lc of the path)', A.legacyId({ ...BRIDGET, host: 'robin-z790' }, '@Next Release/@Docs') === leg)
  check('legacy id: a different family from v2 ids (same parts, other prefix)', A.legacyId(BRIDGET, '') !== A.mintId(BRIDGET, '', '') && /^[a-z2-7]{16}$/.test(leg))
})

// ================================================================= keys (§1.1)
await section(() => {
  const K = (k, o) => { const r = A.validKey(k, o); return r.ok ? r.key : r.code }
  check('key: plain keys are valid (docs, spec-88, _x, 9a, a.b#c+d-e)', ['docs', 'spec-88', '_x', '9a', 'a.b#c+d-e'].every(k => K(k) === k))
  check('key: letters of any script (café, Über, 日本, Ω7)', ['café', 'Über', '日本', 'Ω7'].every(k => K(k) === k))
  check('key: ":" is refused (hole H1 — it separates chain:key)', K('a:b') === 'bad-key' && K('fix-79:docs') === 'bad-key')
  check('key: "/", spaces, quotes, @ are refused', ['a/b', 'a b', '"a"', 'a@b', '@a', 'a~b'].every(k => K(k) === 'bad-key'))
  check('key: the first char must be a letter, digit or _ (-a, .a, #a, +a refused)', ['-a', '.a', '#a', '+a'].every(k => K(k) === 'bad-key'))
  check('key: empty / blank / non-string refused', K('') === 'bad-key' && K('   ') === 'bad-key' && K(null) === 'bad-key' && K(7) === 'bad-key')
  check('key: "root" in any case is reserved', ['root', 'ROOT', 'Root'].every(k => K(k) === 'bad-key') && K('roots') === 'roots' && K('root2') === 'root2')
  check('key: ?N is a bridge-made question key — refused by default', K('?1') === 'bad-key' && K('?12') === 'bad-key')
  check('key: ?N accepted with { question:true } (the bridge minting, a caller referencing)', K('?1', { question: true }) === '?1' && K('?12', { question: true }) === '?12')
  check('key: only ?<digits> is a question key (?x, ?, ?1a refused even with question)', ['?x', '?', '?1a', '??1'].every(k => K(k, { question: true }) === 'bad-key'))
  check('key: 48 code points ok, 49 refused', K(rep('a', 48)) === rep('a', 48) && K(rep('a', 49)) === 'bad-key' && A.KEY_LIMITS.key === 48)
  const astral = '\u{1D49C}'   // MATHEMATICAL SCRIPT CAPITAL A: a letter, 2 UTF-16 units
  check('key: the limit counts CODE POINTS (48 astral letters ok, 49 refused)', K(rep(astral, 48)) === rep(astral, 48) && K(rep(astral, 49)) === 'bad-key')
  check('key: trimmed and NFC-normalised (an NFD "café" → the NFC one)', K('  docs ') === 'docs' && K('café') === 'café')
  check('key: case-insensitive comparison keeps the spelling (validKey keeps "Docs"; lc folds it)', K('Docs') === 'Docs' && A.mintId(BRIDGET, '', K('Docs')) === A.mintId(BRIDGET, '', K('docs')))
})

// ================================================================= slugs + clashes (§1.1)
await section(() => {
  check('slug: "#88 stable node identity (v2.0)" → 88-stable-node-identity-v2.0 (the spec\'s prototype)', A.slugKey('#88 stable node identity (v2.0)') === '88-stable-node-identity-v2.0')
  check('slug: "Next release" → Next-release (case kept)', A.slugKey('Next release') === 'Next-release')
  check('slug: drops chars outside [\\p{L}\\p{N}_.-] (":" "#" "+" "(" quotes)', A.slugKey('a: b') === 'a-b' && A.slugKey('c++ "x"') === 'c-x' && A.slugKey('Über café') === 'Über-café')
  check('slug: collapses dash runs, strips leading non-word and trailing - .', A.slugKey('  --a--b..  ') === 'a-b' && A.slugKey('(Draft) notes') === 'Draft-notes' && A.slugKey('.hidden.') === 'hidden')
  check('slug: empty / punctuation only / root (any case) → node', ['', '   ', '!!!', '...', 'root', 'ROOT', ' Root. '].every(l => A.slugKey(l) === 'node'))
  const long = A.slugKey(rep('word ', 20))
  check('slug: ≤ 40 code points, never ending in - or . after the cut', [...long].length <= 40 && !/[-.]$/.test(long) && long.startsWith('word-word'), long)
  check('slug: NFC first (an NFD é is kept as one letter, not dropped)', A.slugKey('café au lait') === 'café-au-lait')
  const labels = ['#88 stable node identity (v2.0)', 'Next release', 'a/b', '?3', '@home', '日本 語', rep('x', 90), '(1) one', '_x_', 'v2.0 — final', 'root', 'Ω']
  check('slug: every slug is a valid key', labels.every(l => A.validKey(A.slugKey(l)).ok), J(labels.map(A.slugKey)))
  const taken = new Set(['docs'])
  check('clash: a free key is kept as is', A.uniqueKey('notes', taken) === 'notes')
  check('clash: a taken key gets -2', A.uniqueKey('docs', taken) === 'docs-2')
  check('clash: then -3, -4 …', A.uniqueKey('docs', new Set(['docs', 'docs-2'])) === 'docs-3' && A.uniqueKey('docs', new Set(['docs', 'docs-2', 'docs-3'])) === 'docs-4')
  check('clash: compared case-insensitively (Docs vs docs)', A.uniqueKey('Docs', taken) === 'Docs-2')
  check('clash: a predicate works as the taken set', A.uniqueKey('a', k => k === 'a' || k === 'a-2') === 'a-3')
  const big = A.uniqueKey(rep('k', 48), new Set([rep('k', 48)]))
  check('clash: a 48-char key is cut so key-2 stays ≤ 48 and valid', [...big].length === 48 && big.endsWith('-2') && A.validKey(big).ok, big)
  // two path-created siblings labelled alike in one scope: slug + uniqueKey (the label itself is settled by §1.6 elsewhere)
  const scope = new Set(), mk = l => { const k = A.uniqueKey(A.slugKey(l), scope); scope.add(A.labelKey(k)); return k }
  const made = [mk('Next release'), mk('next release'), mk('Next  release!')]
  check('clash: slug clashes in one scope → Next-release, next-release-2, Next-release-3 (each keeps its own spelling)', J(made) === J(['Next-release', 'next-release-2', 'Next-release-3']), J(made))
})

// ================================================================= labels (§1.3, §1.6)
await section(() => {
  const L = l => { const r = A.normLabel(l); return r.ok ? r.label : r.code }
  check('label: whitespace runs → one space, trimmed', L('  Write   the\tdocs ') === 'Write the docs')
  check('label: "/", quotes, @, root and ":" are all fine in a label', ['a/b', 'say "hi"', '@home', 'root', 'Notes: draft', '?3'].every(l => L(l) === l))
  check('label: 60 code points ok, 61 refused', L(rep('x', 60)) === rep('x', 60) && L(rep('x', 61)) === 'bad-label')
  check('label: empty / blank / non-string / control char refused', L('') === 'bad-label' && L('  ') === 'bad-label' && L(3) === 'bad-label' && L('a\u0007b') === 'bad-label')
  check('labelKey: case-insensitive (Notes = NOTES = notes)', A.labelKey('Notes') === A.labelKey('NOTES') && A.labelKey('notes') === 'notes')
  check('labelKey: NFC (an NFD é = the NFC é)', A.labelKey('Café') === A.labelKey('café'))
  check('labelKey: "Notes (2)" differs from "Notes"', A.labelKey('Notes (2)') !== A.labelKey('Notes'))
})

// ================================================================= paths (§3.3, Q37)
await section(() => {
  const P = p => A.parsePath2(p)
  const segs = p => { const r = P(p); return r.ok ? J(r.segs) : r.code }
  check('path: labels joined by / (spaces and # inside a label are fine)', segs('Next release/#88 stable node identity (v2.0)/Docs') === J(['Next release', '#88 stable node identity (v2.0)', 'Docs']))
  check('path: segments trimmed + whitespace-normalised; leading / trailing slashes dropped', segs(' /Next   release / Docs/ ') === J(['Next release', 'Docs']))
  check('path: "" (or "/" or "./") = the scope itself', ['', '/', './', '  '].every(p => { const r = P(p); return r.ok && r.segs.length === 0 && r.path === '' && r.key === '' }))
  check('path: one leading ./ is dropped (§3.2\'s "force a path")', segs('./Docs') === J(['Docs']) && segs('./a/b') === J(['a', 'b']))
  check('path: a quoted segment holds / ("a/b"/c)', segs('"a/b"/c') === J(['a/b', 'c']))
  check('path: "" inside quotes is a literal "', segs('"say ""hi"""/x') === J(['say "hi"', 'x']) && segs('""""') === J(['"']))
  check('path: a quote INSIDE an unquoted segment is literal', segs('say "hi"/x') === J(['say "hi"', 'x']))
  check('path: a quoted @ label is a label, not the 1.7x form', segs('"@home"/x') === J(['@home', 'x']))
  check('path: @ inside a label (a@b) is plain', segs('a@b/c @ d') === J(['a@b', 'c @ d']))
  check('path: an empty inner segment is refused', segs('a//b') === 'bad-path' && segs('a/ /b') === 'bad-path')
  check('path: an unterminated quote / text after a closing quote is refused', segs('"abc') === 'bad-path' && segs('"a"b/c') === 'bad-path')
  const deep = n => Array.from({ length: n }, (_, i) => 's' + i).join('/')
  check('path: 32 segments ok, 33 refused path-too-deep (Q11b: the 2.0 hard depth)', segs(deep(32)) !== 'path-too-deep' && segs(deep(33)) === 'path-too-deep' && A.DEPTH2.max === 32 && A.DEPTH2.warn === 20)
  check('path: a 61-code-point label is refused bad-label', segs(rep('x', 61)) === 'bad-label' && segs('"' + rep('x', 60) + '"') === J([rep('x', 60)]))
  check('path: key = labelKey of the display path (case-insensitive)', P('Next Release/DOCS').key === P('next release/docs').key && P('Next Release/DOCS').path === 'Next Release/DOCS')
  const tricky = [['a/b', 'c'], ['"q', 'x'], ['@home'], ['.', 'x'], ['..', 'x'], ['say "hi"'], ['Next release', 'Docs (2)'], ['?3'], ['root']]
  check('path: formatPath2 quotes a ".." label (step 2a: a leading .. navigates in --move-to)', A.formatPath2(['..', 'x']) === '".."/x' && A.formatPath2(['...']) === '...')
  check('path: formatPath2 → parsePath2 round-trips tricky labels (/, leading " or @, ".", quotes)', tricky.every(ls => { const r = P(A.formatPath2(ls)); return r.ok && J(r.segs) === J(ls) }), J(tricky.map(A.formatPath2)))
  check('path: formatPath2 quotes only where needed', A.formatPath2(['Next release', 'a/b', '@x', 'say "hi"']) === 'Next release/"a/b"/"@x"/say "hi"')
  check('path: non-string refused', P(null).code === 'bad-path' && P(5).code === 'bad-path')
})

// ================================================================= 1.7x `@` paths → legacy-form (§4.5)
await section(() => {
  const L = p => A.parsePath2(p)
  const lf = (p, conv) => { const r = L(p); return !r.ok && r.code === 'legacy-form' && r.path === conv && r.what.includes(conv) }
  check('legacy: @Next release/@Docs → "paths have no @ in 2.0: write Next release/Docs"', lf('@Next release/@Docs', 'Next release/Docs') && /^paths have no @ in 2\.0/.test(L('@Next release/@Docs').what), L('@Next release/@Docs').what)
  check('legacy: an @ on a LATER segment is caught too (spec-70/@Tharsis → spec-70/Tharsis)', lf('spec-70/@Tharsis', 'spec-70/Tharsis'))
  check('legacy: @"…" quoted names are unquoted (@"CTX strip 17" → CTX strip 17)', lf('@"CTX strip 17"', 'CTX strip 17'))
  check('legacy: a converted label holding / is re-quoted the 2.0 way', lf('@#70/spec-70', '#70/spec-70'))
  check('legacy: @root (the node itself) is dropped', lf('a/@root', 'a') && L('@root').code === 'legacy-form' && L('@root').path === '')
  check('legacy: @?3 → ?3 (a question matches by its key)', lf('lead/@?3', 'lead/?3'))
  check('legacy: an @ after spaces at a segment start is still the 1.7x form', lf('a/ @b', 'a/b'))
  const t = L('x/@~A')
  check('legacy: @~ in a path → "@~ was removed in 2.0", naming --text "@…" and the converted path', !t.ok && t.code === 'legacy-form' && /^@~ was removed in 2\.0/.test(t.what) && t.what.includes('--text "@') && t.path === 'x/A' && t.what.includes('x/A'), t.what)
  const own = L('@~root')
  check('legacy: @~root → @~ removed, your own node', !own.ok && own.code === 'legacy-form' && own.path === '' && own.what.includes('your own node'), own.what)
  check('legacy: a reference with an @ path is refused the same way', A.parseRef('@Next release/@Docs').code === 'legacy-form' && A.parseRef('@Docs').path === 'Docs')
})

// ================================================================= references (§3.2)
await section(() => {
  const R = r => { const x = A.parseRef(r); return x.ok ? `${x.kind}:${x.kind === 'chain' ? x.chain + '|' : ''}${x.kind === 'path' ? J(x.segs) : x.key}` : x.code }
  check('ref: a bare key = kind key (your scope, then up the creators)', R('docs') === 'key:docs' && R('spec-88') === 'key:spec-88')
  check('ref: :88 = the session\'s 88 (empty chain)', R(':88') === 'chain:|88' && J(A.parseRef(':88').creators) === '[]')
  check('ref: spec-89:docs and spec-88/research:notes = exactly that scope', R('spec-89:docs') === 'chain:spec-89|docs' && R('spec-88/research:notes') === 'chain:spec-88/research|notes' && J(A.parseRef('spec-88/research:notes').creators) === J(['spec-88', 'research']))
  check('ref: a question key ?3 is a key (bare or chained)', R('?3') === 'key:?3' && R('lead:?3') === 'chain:lead|?3')
  check('ref: contains / → a path', R('a/b') === 'path:' + J(['a', 'b']) && R('Next release/Docs') === 'path:' + J(['Next release', 'Docs']))
  check('ref: not a valid key (a label with spaces) → a path', R('My notes') === 'path:' + J(['My notes']))
  check('ref: ./Docs forces a path for a one-segment label that is also a key', R('./Docs') === 'path:' + J(['Docs']) && R('Docs') === 'key:Docs')
  check('ref: a quoted segment is a path', R('"Docs"') === 'path:' + J(['Docs']))
  check('ref: a:b:c (no valid chain) and root (reserved) are read as labels', R('a:b:c') === 'path:' + J(['a:b:c']) && R('root') === 'path:' + J(['root']))
  check('ref: a ?N chain step is not a creator → read as a label', R('?1:x') === 'path:' + J(['?1:x']))
  check('ref: trimmed; empty / non-string refused bad-ref', R('  docs ') === 'key:docs' && R('') === 'bad-ref' && R('  ') === 'bad-ref' && R(null) === 'bad-ref')
})

// ================================================================= text: the leading-@ rule (§4.0, Q36)
await section(() => {
  const T = t => { const r = A.parseText(t); return r.ok ? `${r.line ? 'LINE' : 'LOG'} ${r.text}` : r.code }
  check('text: @x → sets the line to "x"', T('@x') === 'LINE x')
  check('text: @@x → logs "@x" (a pair = one literal @)', T('@@x') === 'LOG @x')
  check('text: @@@x → sets the line to "@x"', T('@@@x') === 'LINE @x')
  check('text: @@@@x → logs "@@x"', T('@@@@x') === 'LOG @@x')
  check('text: x@ (an @ not at the start) is plain', T('x@') === 'LOG x@' && T('mail a@b.c') === 'LOG mail a@b.c')
  check('text: plain text only logs', T('Writing the docs') === 'LOG Writing the docs')
  check('text: "@Writing the docs" sets the line', T('@Writing the docs') === 'LINE Writing the docs')
  check('text: @@ alone logs "@"', T('@@') === 'LOG @')
  check('text: leading spaces are trimmed before the run is counted', T('  @x') === 'LINE x' && T(' @ x ') === 'LINE x')
  check('text: @~… (the 1.7x marker) is refused legacy-form, naming --text "@…"', T('@~root done') === 'legacy-form' && A.parseText('@~root done').what.includes('--text "@done"'), A.parseText('@~root done').what)
  check('text: @~Ctx … names the converted path', A.parseText('@~build compiling').what.includes('--path "build"') && A.parseText('@~"a b" go').what.includes('--path "a b"'))
  check('text: @@~x is an ESCAPED @ → logs "@~x" (not legacy)', T('@@~x') === 'LOG @~x')
  check('text: non-string refused', A.parseText(null).code === 'bad-text')
})

// ================================================================= the 1.7x (v5) readers (step 11: lib/activity-v5.js, for the migration)
await section(() => {
  const p = V5.parsePath('spec-70/@Tharsis/@~z12')
  check('1.7x: the v5 parsePath still reads @ paths (the converter reads 1.7x records with it)', p.ok && p.path === 'spec-70/@Tharsis/@z12' && p.current === true)
  check('1.7x: the v5 ACTIVITY_FORMAT is 5; lib/activity.js no longer exports the 1.7x parser', V5.ACTIVITY_FORMAT === 5 && A.parsePath === undefined && A.ACTIVITY_FORMAT === undefined)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
