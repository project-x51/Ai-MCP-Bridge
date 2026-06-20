// Shared types for the Ai MCP Bridge, consumed via JSDoc `import('./types').X` annotations (#31).
// ZERO BUILD: `checkJs` type-checks the .mjs/.js sources against these; nothing is emitted (noEmit).
// The bridge still runs as plain `node bridge.mjs`. Run the checker with `npm run typecheck`.
// These describe the SHAPES where bugs have historically hidden (identity keys, claim/mailbox records,
// envelopes) so a missing/renamed field is caught at author time. Annotate more of bridge.mjs over time.

/** A normalized identity — the human + work, independent of the volatile session id. Durable state is keyed by (realm,project,user,name). */
export interface Identity {
  realm?: string
  project?: string
  user?: string
  name?: string
  scheme?: string
  id?: string
  display?: string
  assurance?: string
}
/** Loose identity input — classify()/pIdent() accept partials. */
export type IdentityInput = Partial<Identity>

/** A message envelope as it travels the mesh. Bodies are AES-GCM ciphertext in transit (see BodyCipher); routing metadata is cleartext. */
export interface Envelope {
  id?: string
  ts?: string
  from?: EnvelopeFrom
  to: string
  verb?: string
  subject?: string
  pattern?: string
  topic?: string | null
  body?: string
  enc?: string
  reply_to?: string | null
  reply_cap?: string
  reply_exp?: number
  hops?: string[]
  system?: boolean
  retained?: boolean
  dead_letter_for?: string
}
export interface EnvelopeFrom { session?: string; name?: string; kind?: string; project?: string; user?: string; realm?: string; hops?: string[] }
/** What makeEnvelope() accepts — `to` required; the rest optional. verb/body/subject/etc. are app-defined values
 *  that flow in from untyped JSON, so they're permissive — the bug-catching value is in the identity/record shapes. */
export interface EnvelopeInput { to: string; from?: EnvelopeFrom; verb?: any; body?: any; subject?: any; pattern?: any; topic?: any; reply_to?: any }

/** A durable claim record (responsibility for a topic), self-describing so an OFFLINE owner can be parked to (§12/§16). */
export interface ClaimRecord {
  pattern: string
  role: 'owner'
  description?: string
  exclusive?: boolean
  icon?: string | null
  holder_name?: string | null
  project?: string
  realm?: string
  user?: string | null
  name?: string | null
  announce_offline?: boolean
  grace_minutes?: number | null
  allow_other_user?: boolean | null
  keep_alive?: boolean
  claimed_at?: string
  refreshed_at?: string
  persistent?: boolean
}
/** A durable name->identity registration (offline-by-name delivery, §19). */
export interface Registration { name: string; realm?: string; project?: string; user?: string; secret_hash?: string | null; client_kind?: string | null; last_seen?: string }
/** A durable cross-project consent edge (§14). */
export interface Grant { from: string; to: string; mode: 'send' | 'bidirectional'; exp?: number | null; granted_at?: string }
/** A kept-alive (ownerless) topic marker — sends park against it until reclaimed (#26). */
export interface KeptTopic { realm?: string; project: string; topic: string; description?: string; icon?: string | null; exclusive?: boolean; announce_offline?: boolean; keep_alive?: boolean; behaviors?: string[]; ownerless_since?: string }
/** A per-session behaviour reminder (#29). */
export interface Behavior { scope: 'topic' | 'host' | 'project' | 'subscription' | 'all'; match: string | null; behavior: string; set_at?: string }
/** The per-sub-peer in-RAM delivery queue. */
export interface SubQueue { epoch: string; base: number; items: Envelope[]; served?: number }

/** Options for the Authorizer.confirm() human-in-the-loop check (§16). */
export interface AuthorizerConfirmOpts { action?: string; topic?: string; user?: string; requester?: string; subject?: string; details?: string }

// ---- pluggable facets (docs/architecture.md "profiles") — each `src/facets/<facet>/<impl>.js` exports
// `meta` + `create(ctx)`. These interfaces document the contracts; annotate impls' create() returns over time. ----
/** What every facet impl is handed at bind time (buildProfile). */
export interface FacetContext {
  CFG?: any
  env?: Record<string, string | undefined>
  HERE?: string
  TOKEN?: string
  REALM?: string
  log?: (...a: any[]) => void
}
export interface FacetMeta { facet: string; name: string }
export interface BodyCipher { meta: FacetMeta; seal(env: Envelope): void; open(env: Envelope): string; view(env: Envelope): Envelope }
export interface Authorizer { meta: FacetMeta; confirm(opts?: AuthorizerConfirmOpts): Promise<{ approved: boolean; reason?: string; by?: string }> }
export interface Vault { meta: FacetMeta; enabled?: boolean; seal(plaintext: string): Promise<string | null>; unseal(ct: string, opts?: { subject?: string }): Promise<{ ok: boolean; plaintext?: string; reason?: string; by?: string; code?: number }> }
export interface IdentityModel { meta: FacetMeta; classify(id?: IdentityInput): Identity }
