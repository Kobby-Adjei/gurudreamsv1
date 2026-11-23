import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Optional renderer setup file (owned by UI/UX); only referenced if present.
const rendererSetup = resolve(__dirname, 'tests/renderer/setup.ts')

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [['tests/renderer/**', 'jsdom']],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: existsSync(rendererSetup) ? [rendererSetup] : [],
    restoreMocks: true,
    testTimeout: 10_000
  }
})
