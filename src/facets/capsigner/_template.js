// CapSigner facet — TEMPLATE. Copy to "<name>.js" and implement. Mints/verifies the unforgeable reply
// capability that lets cross-project return-traffic through (architecture.md §5). Keyed per-participant
// by a key derived from its secret, so a re-attached conversation keeps validity. (Default: HMAC.)
//
// Interface:
//   deriveKey(secret) -> key            per-participant signing key from its register_self secret
//   mint(key, fields) -> string         a compact tag over a `|`-joined field string
//   verify(key, tag, fields) -> boolean constant-time check that tag was minted by `key` over `fields`
export const meta = { facet: 'capsigner', name: 'template' }
export function create(ctx) {
  return {
    deriveKey(secret) { throw new Error('capsigner.deriveKey not implemented') },
    mint(key, fields) { throw new Error('capsigner.mint not implemented') },
    verify(key, tag, fields) { throw new Error('capsigner.verify not implemented') },
  }
}
