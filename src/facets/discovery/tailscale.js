// Discovery: tailscale — enumerate the tailnet as a passive, symmetric directory (docs/architecture.md
// §7). Runs `tailscale status --json` (local, no auth, already on every machine) and offers each ONLINE
// peer's address paired with this realm's control PORT. No tags (tagging a device transfers its
// ownership from the user to the tag — these are user-logged-in machines); the realm-token handshake,
// not the tailnet, decides membership. A peer that isn't running a bridge just refuses the connection.
//
// selfHost() returns THIS machine's tailnet IP, so the bridge can auto-derive its advertise address —
// the one per-machine value that can't live in a Dropbox-shared config.json. advertise() is a no-op: a
// hub is found by listening on the well-known port over the tailnet (WireGuard encrypts the link).
import { execFile } from 'node:child_process'
export const meta = { facet: 'discovery', name: 'tailscale' }

function bins(ctx) {
  const o = []
  if (ctx.env.AI_BRIDGE_TAILSCALE_BIN) o.push(ctx.env.AI_BRIDGE_TAILSCALE_BIN)
  o.push('tailscale')
  if (process.platform === 'win32') o.push('C:\\Program Files\\Tailscale\\tailscale.exe')
  else o.push('/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  return o
}
function run(bin, args) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''))
    })
  })
}
const hostOf = node => node && ((node.TailscaleIPs && node.TailscaleIPs[0]) || (node.DNSName ? String(node.DNSName).replace(/\.$/, '') : null) || node.HostName) || null

export function create(ctx) {
  async function status() {
    let out = null
    for (const b of bins(ctx)) { out = await run(b, ['status', '--json']); if (out) break }
    if (!out) { ctx.log && ctx.log('discovery(tailscale): could not run `tailscale status` — is Tailscale installed/up?'); return null }
    try { return JSON.parse(out) } catch { return null }
  }
  return {
    async candidates() {
      const st = await status()
      const peers = st && st.Peer ? Object.values(st.Peer) : []
      const out = []
      for (const p of peers) {
        if (!p || p.Online !== true) continue
        const host = hostOf(p)
        if (host) out.push({ host, port: ctx.PORT })
      }
      return out
    },
    // this machine's own tailnet address (for advertise auto-derivation); null if Tailscale is down
    async selfHost() {
      const st = await status()
      return st ? hostOf(st.Self) : null
    },
    advertise() {},
  }
}
