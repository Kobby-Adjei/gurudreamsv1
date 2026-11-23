import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Phase 3: the app ships its own private network, so the renderer must never
 * name the underlying technology or ask people to install or sign in to it.
 * (No exceptions: not in copy, comments or identifiers.)
 */
const ROOT = resolve(__dirname, '../../src/renderer')
const FORBIDDEN = /tailscale|tailnet/i

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
        .map((line, i) => (FORBIDDEN.test(line) ? `${relative(ROOT, f)}:${i + 1}: ${line.trim()}` : null))
        .filter((x): x is string => x !== null)
    )
    expect(hits).toEqual([])
  })

  it('scans a meaningful number of files', () => {
    expect(files(ROOT).length).toBeGreaterThan(20)
  })
})
