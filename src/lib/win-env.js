// Rehydrate environment variables that were STRIPPED when this process was launched as an MCP server. Some
// MCP hosts (Claude Desktop among them) spawn servers with a curated, MINIMAL environment — arbitrary user
// variables aren't forwarded unless named in the server's `env` block. That silently breaks ${env:VAR}
// secret references (egress auth #36): the var is set in the user environment, present in every normal
// process, but absent from the bridge's process.env. On Windows we read the LIVE registry
// (HKCU\Environment, then the HKLM system environment) and fill in any variable MISSING from process.env —
// we never override what the launcher already provided (PATH etc. stay as given). No-op off Windows;
// best-effort (never throws). This is the "discover the variable" fix: the secret stays exactly where the
// operator set it, no new files, no plaintext in any launcher config.
import { execFileSync } from 'node:child_process'

// Parse `reg query <key>` output into { NAME: { type, value } } for the string value types (env vars).
// reg formats value rows as: 4-space indent, NAME, gap, TYPE, gap, VALUE (NAME/VALUE may contain spaces).
export function parseRegQuery(out) {
  const map = {}
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^ {4}(.+?) {2,}(REG_SZ|REG_EXPAND_SZ) {2,}(.*)$/)
    if (m) map[m[1]] = { type: m[2], value: m[3] }
  }
  return map
}

const expand = v => String(v).replace(/%([^%]+)%/g, (_, n) => process.env[n] ?? `%${n}%`)

function readRegEnv(key) {
  try { return parseRegQuery(execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 4000 })) }
  catch { return {} }
}

/** Fill process.env with any User/Machine env var the launcher stripped. Windows-only; never throws. Returns the count added. */
export function hydrateEnvFromRegistry(log) {
  if (process.platform !== 'win32') return 0
  let added = 0
  try {
    const sources = [
      readRegEnv('HKCU\\Environment'),
      readRegEnv('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    ]
    for (const src of sources) for (const [name, rec] of Object.entries(src)) {
      if (name in process.env) continue                              // never override what we were given
      process.env[name] = rec.type === 'REG_EXPAND_SZ' ? expand(rec.value) : rec.value
      added++
    }
    if (added && log) log(`env: rehydrated ${added} var(s) from registry (launcher-stripped env)`)
  } catch { /* best-effort */ }
  return added
}
