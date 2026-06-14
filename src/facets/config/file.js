// ConfigSource — shared JSON file (default). The bridge only READS it, so a Dropbox/SMB-synced edit
// propagates to the realm without a restart; watch() polls (cross-platform, idempotent re-read).
import fs from 'node:fs'
import path from 'node:path'
export const meta = { facet: 'config', name: 'file' }
export function create(ctx) {
  const file = path.join(ctx.HERE, 'config.json')
  function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
  return {
    load,
    watch(onChange) { try { fs.watchFile(file, { interval: 2000 }, () => onChange(load())) } catch {} },
  }
}
