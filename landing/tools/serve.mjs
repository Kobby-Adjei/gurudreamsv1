// Tiny static server for landing/ with /v1/waitlist* stubbed. Used by shoot.mjs and render.mjs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const pw = (() => { try { return require('playwright'); } catch { return require('/opt/node-tools/node_modules/playwright'); } })();

const types = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif'
};

// extra: { '/path': () => ({ status, type, body }) } for stubbed responses (e.g. /downloads/latest.json).
export async function serve(extra = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (extra[url.pathname]) {
      const r = extra[url.pathname]();
      res.writeHead(r.status, { 'Content-Type': r.type || 'application/json' });
      return res.end(r.body || '');
    }
    if (url.pathname.startsWith('/v1/waitlist')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    const p = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
    try {
      const body = await readFile(join(root, p));
      res.writeHead(200, {
        'Content-Type': types[extname(p)] || 'application/octet-stream',
        // Same policy Caddy sends in production, so CSP violations show up here too.
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
      });
      res.end(body);
    } catch {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// Headless Chromium renders WebGL with SwiftShader (software): slow, but faithful.
export const launch = () => pw.chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });

// Render one still frame of the hero at flight time t. scale: cloud buffer size in CSS px multiples.
export async function still(browser, base, { t, scale, live = false, jitter, viewport, dpr = 2, query = '?v=private&p=8', path, hideCopy = false, clip, timeout = 900000 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((o) => { window.__hero = { still: { t: o.t, scale: o.scale, live: o.live }, jitter: o.jitter, passes: o.passes, ofs: o.ofs }; }, { t, scale, live, jitter: jitter ?? null, passes: +(process.env.PASSES || 0) || null, ofs: process.env.OFS || null });
  await page.goto(base + '/' + query);
  if (hideCopy) await page.addStyleTag({ content: '.bar,.copy{visibility:hidden}' });
  await page.waitForSelector('.hero[data-hero-done]', { timeout });
  await page.waitForTimeout(1800); // canvas fade-in
  const target = hideCopy ? page.locator('#sky') : page;
  await target.screenshot({ path, clip, animations: 'disabled' });
  await ctx.close();
  return errors;
}
