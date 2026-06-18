// Authorizer facet: none (default) — no interactive confirmation is available, so any decision that needs
// human presence is DENIED (held). Safe default: a same-user dormant-topic takeover simply can't proceed
// here; opt in to 'script' (tests/headless) or 'hello' (Windows presence) to enable it.
export const meta = { facet: 'authorizer', name: 'none' }
export function create() {
  return { meta, async confirm() { return { approved: false, reason: 'no-authorizer', by: 'none' } } }
}
