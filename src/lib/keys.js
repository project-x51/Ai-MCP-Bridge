// Pure case-insensitive canonicalisation helpers, shared across the orchestrator + the stateful modules
// (consent, reminders). Display strings keep their declared case everywhere; these produce the COMPARISON
// key. Mixed-case project names like "CamelCo"/"AIMB" tripped a half-lowercased path once — keep it central.

/** Lower-case + trim (names, hosts, matches). */
export const lc = s => String(s == null ? '' : s).trim().toLowerCase()

/** Canonical project key — like lc() but empty/undefined collapses to 'unclassified'. */
export const projKey = p => (String(p == null ? '' : p).trim().toLowerCase() || 'unclassified')
