// Discovery: seeds — a static, explicit list of peer-hub addresses. Useful on hostile networks (no
// directory to enumerate) and as the deterministic backend for tests. Reads AI_BRIDGE_SEEDS (or
// CFG.seeds): a comma/space/newline separated list of host:port entries. A bare host gets this realm's
// control PORT. Self is included harmlessly — the caller skips its own address.
export const meta = { facet: 'discovery', name: 'seeds' }
export function create(ctx) {
  const raw = ctx.env.AI_BRIDGE_SEEDS || (ctx.CFG && ctx.CFG.seeds) || ''
  const list = (Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/)).map(s => String(s).trim()).filter(Boolean)
  const parsed = list.map(s => {
    const i = s.lastIndexOf(':')
    if (i > 0 && /^\d+$/.test(s.slice(i + 1))) return { host: s.slice(0, i), port: Number(s.slice(i + 1)) }
    return { host: s, port: ctx.PORT }
  })
  return { async candidates() { return parsed }, advertise() {} }
}
