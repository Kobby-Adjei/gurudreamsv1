import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Phase 3: the app ships its own private network, so the renderer must never
 * name the underlying technology or ask people to install or sign in to it.
 * (Not in copy, comments or identifiers.)
 *
 * One exception, by exact line: in preview mode without sign-in the backend
 * uses the computer's own network client (PHASE3_PLAN.md §8), so when that
 * reports trouble we may tell people to make sure it's running. That hint is
 * a single constant, shown only in preview + system mode. Nothing else.
 */
const ROOT = resolve(__dirname, '../../src/renderer')
const FORBIDDEN = /tailscale|tailnet/i
const ALLOWLIST = new Set([
  "lib/preview.ts: export const SYSTEM_NETWORK_HINT = 'Make sure Tailscale is running on this computer.'"
])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|html)$/.test(name) ? [p] : []
  })
}

describe('Renderer copy', () => {
  it('never mentions the network vendor anywhere in src/renderer', () => {
    const hits = files(ROOT).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line) => (FORBIDDEN.test(line) ? `${relative(ROOT, f)}: ${line.trim()}` : null))
        .filter((x): x is string => x !== null)
    )
    expect(hits.filter((h) => !ALLOWLIST.has(h))).toEqual([])
  })

  it('the allowlisted preview hint exists exactly once (so the exception can’t silently grow)', () => {
    const hits = files(ROOT).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((line) => FORBIDDEN.test(line))
        .map((line) => `${relative(ROOT, f)}: ${line.trim()}`)
    )
    expect(hits).toEqual([...ALLOWLIST])
  })

  it('scans a meaningful number of files', () => {
    expect(files(ROOT).length).toBeGreaterThan(20)
  })
})
