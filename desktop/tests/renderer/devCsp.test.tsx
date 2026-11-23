import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEV_CSP, devCsp } from '../../src/renderer/devCsp'

const html = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8')

describe('renderer CSP', () => {
  it('ships a strict policy in index.html (no unsafe-inline / unsafe-eval)', () => {
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("style-src 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/)
  })

  it('relaxes the policy only on the dev server', () => {
    const plugin = devCsp()
    expect(plugin.apply).toBe('serve')
    const transform = plugin.transformIndexHtml as (h: string) => string
    const out = transform(html)
    expect(out).toContain(DEV_CSP)
    expect(out).not.toMatch(/content="default-src 'self'; script-src 'self'; style-src 'self';/)
    expect(DEV_CSP).not.toContain('unsafe-eval')
  })
})
