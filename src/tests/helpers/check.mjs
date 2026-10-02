// The shared check() filter (#81): TEST_ONLY=<substring> keeps only the checks whose NAME contains it (case-insensitive).
// Each script's own check() starts with `if (!testOnly(name)) return`, so a non-matching check is neither printed nor
// counted. The script still RUNS end to end (its checks are steps of one scenario, not isolated tests) — TEST_ONLY just
// narrows what is reported: `TEST_ONLY="host alias" node tests/dashboard/test_dashboard.mjs`, or
// `npm run test:file -- test_dashboard --only "host alias"`.
const ONLY = String(process.env.TEST_ONLY || '').trim().toLowerCase()
export const testOnly = name => !ONLY || String(name).toLowerCase().includes(ONLY)
