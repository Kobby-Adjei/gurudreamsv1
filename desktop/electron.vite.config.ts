import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Main + preload are bundled as CommonJS for Electron (the sandboxed preload
// must be CJS). The renderer is a plain Vite/React SPA rooted at src/renderer.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
