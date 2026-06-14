// ConfigSource facet — TEMPLATE. Copy to "<name>.js" and implement. Loads the realm policy and watches
// for changes so an edit propagates live (architecture.md §4). Default reads the shared JSON file; other
// impls could fetch a URL or a config service.
//
// Interface:
//   load() -> object                  the current realm config (projects policy, etc.)
//   watch(onChange) -> void           call onChange(newConfig) when the source changes (best-effort)
export const meta = { facet: 'config', name: 'template' }
export function create(ctx) {
  return {
    load() { throw new Error('config.load not implemented') },
    watch(onChange) { /* no-op acceptable */ },
  }
}
