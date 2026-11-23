import type { Plugin } from 'vite'

/**
 * Dev-server-only CSP relaxation.
 *
 * index.html ships a strict CSP (script-src 'self'; style-src 'self'). During
 * `npm run dev`, Vite injects an inline React-refresh preamble, injects CSS via
 * <style> tags and opens an HMR WebSocket – all of which that policy blocks.
 * This plugin rewrites the meta tag ONLY when serving (apply: 'serve'); the
 * production build keeps the strict policy byte-for-byte.
 */
export const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*; " +
  "img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

export function devCsp(): Plugin {
  return {
    name: 'airbridge-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
        `$1${DEV_CSP}$2`
      )
    }
  }
}

export default devCsp
