// Disjoint port blocks per test FILE (#81 "test groups"), so any two files can run at the same time.
//
// File i of manifest ORDER owns ports PORT_BASE + i*BLOCK … + BLOCK-1 (20000 + i*100 by default: 20000–25399 for the 54
// files today — clear of the live bridge's 12317/12318 and of Windows' default excluded/ephemeral ranges).
// AIMB_TEST_PORT_BASE moves the whole space (e.g. two worktrees running their suites at once: 20000 and 30000).
//
// A file keeps its historical port numbers as NAMES and maps them into its block:
//   const tp = testPorts(import.meta.url, 7950)   // 7950 = the lowest port this file used before the move
//   spawnBridge(tp(7950)) … tp(7952) …            // → its block's base + 0, + 2, …
// tp() throws for a number outside the block, so a new port can't silently stray into another file's block.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORDER } from './manifest.mjs'

export const BLOCK = 100
export const PORT_BASE = Number(process.env.AIMB_TEST_PORT_BASE) || 20000
const LIVE = [12317, 12318]   // the live bridge's control + ws ports: never handed to a test
if (PORT_BASE < 1024 || PORT_BASE + ORDER.length * BLOCK > 65535) throw new RangeError(`AIMB_TEST_PORT_BASE ${PORT_BASE}: the ${ORDER.length} blocks of ${BLOCK} must fit in 1024–65535`)
if (LIVE.some(p => p >= PORT_BASE && p < PORT_BASE + ORDER.length * BLOCK)) throw new RangeError(`AIMB_TEST_PORT_BASE ${PORT_BASE}: the test port space would cover the live bridge ports ${LIVE.join('/')}`)

/** the first port of a test file's block (by its file name, from import.meta.url or a path) */
export function portBase(fileOrUrl) {
  const f = String(fileOrUrl)
  const name = path.basename(f.startsWith('file:') ? fileURLToPath(f) : f, '.mjs')
  const slot = ORDER.indexOf(name)
  if (slot < 0) throw new Error(`${name}: no port block — append it to ORDER in tests/helpers/manifest.mjs`)
  return PORT_BASE + slot * BLOCK
}

/** tp(n) = this file's block base + (n − legacyLow): the file's historical port n, moved into its own block */
export function testPorts(fileOrUrl, legacyLow) {
  const base = portBase(fileOrUrl)
  return n => {
    const off = Number(n) - legacyLow
    if (!(off >= 0 && off < BLOCK)) throw new RangeError(`test port ${n} is outside this file's block (${legacyLow}…${legacyLow + BLOCK - 1})`)
    return base + off
  }
}
