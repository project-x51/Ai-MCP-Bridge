// Reply-cap KEY MATERIAL (§5). The capsigner derives the actual key with HKDF; what matters — and what
// lives here so it can be unit-tested — is WHAT GOES IN, because the CapSigner mixes in no other entropy:
//
//     deriveKey(secret) = HKDF-SHA256(secret, salt='aimb-reply-cap', info='cap')
//
// so the input alone decides both the key's SECRECY and its STABILITY.
//
// Two properties are required, and the original inputs had neither for processes and pages:
//
//  1. STABLE — Decision B promises a valid reply-cap "always gets through", but a process key derived from
//     the random per-process SESSION rotated on every restart, silently breaking that promise. Since a
//     bridge's lifetime is its MCP client's, that window is far shorter than the design assumed. The process
//     key is therefore derived from the process's IDENTITY, which survives a restart.
//
//  2. NOT PUBLICLY DERIVABLE — SESSION and a page `instance` are PUBLISHED (list_sessions returns every
//     session id; envelopes carry from.session; the roster carries page instances). Deriving key material
//     from a public identifier meant anyone who could read the roster could recompute the key and mint a
//     valid cap — and a valid cap is an independent allow OR'd after the consent check, so that bypassed
//     cross-project isolation. Mixing the realm TOKEN raises the bar to "realm member", which matches the
//     documented trust-domain posture (members already share the body-encryption key). It is defence in
//     depth, not a defence against a hostile realm member — the realm is one trust domain by design.
//
// Sub-peer keys are unchanged: they derive from the peer's own self-invented secret, which is already both
// unguessable and stable across re-registration.

/** Key material for a PROCESS's reply-cap key: stable across restarts, token-gated. */
export function procCapKeyInput({ token, realm, project, user, host }) {
  return [String(token || ''), 'proc', String(realm || 'default'),
    String(project || 'unclassified').toLowerCase(), String(user || '').toLowerCase(),
    String(host || '').toLowerCase()].join('|')
}

/** Key material for a PAGE leaf's reply-cap key. Still per-instance — a browser tab genuinely IS ephemeral,
 *  so rotation is correct here — but no longer computable from the published instance id alone. */
export function pageCapKeyInput({ token, instance }) {
  return [String(token || ''), 'page', String(instance || '')].join('|')
}
