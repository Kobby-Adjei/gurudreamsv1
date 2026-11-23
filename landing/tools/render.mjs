// Renders the hero's static assets from the live shader (headless Chromium + SwiftShader, slow but faithful):
//   assets/hero.{avif,webp,jpg}       2880x1800 poster (reduced motion, no WebGL, slow devices)
//   assets/hero-tall.{avif,webp,jpg}  1170x2532 portrait poster (phones)
//   assets/og.png                     1200x630 share card with the headline
//   assets/favicon-32.png, assets/apple-touch-icon.png from assets/favicon.svg
// Usage: node landing/tools/render.mjs [--only=poster,tall,og,icons]   (needs python3 + Pillow for encoding)
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { serve, launch, still, root } from './serve.mjs';

const only = (process.argv.find((a) => a.startsWith('--only=')) || '--only=poster,tall,og,icons').slice(7).split(',');
const docs = join(root, 'docs');
const assets = join(root, 'assets');
const T = 12; // flight time of the still: the plane settled into its cruise
const srv = await serve();
const browser = await launch();

function encode(png, base, maxKB) {
  // Pick the best quality that fits the budget, per format.
  execFileSync('python3', ['-I', '-c', `
import sys, io
from PIL import Image
src, base, cap = sys.argv[1], sys.argv[2], int(sys.argv[3]) * 1024
im = Image.open(src).convert('RGB')
for ext, kw in (('avif', {}), ('webp', {'method': 6}), ('jpg', {'optimize': True, 'progressive': True, 'subsampling': 0})):
    for q in range(90, 30, -4):
        b = io.BytesIO(); im.save(b, 'AVIF' if ext == 'avif' else 'WEBP' if ext == 'webp' else 'JPEG', quality=q, **kw)
        if b.tell() <= cap: break
    open(base + '.' + ext, 'wb').write(b.getvalue())
    print(base + '.' + ext, q, b.tell() // 1024, 'KB')
`, png, base, String(maxKB)], { stdio: 'inherit' });
}

async function timed(label, fn) { const t = Date.now(); const r = await fn(); console.log(label, ((Date.now() - t) / 1000).toFixed(0) + 's', r && r.length ? r : ''); }

if (only.includes('poster')) {
  const png = join(docs, 'poster.png');
  await timed('poster', () => still(browser, srv.base, { t: T, scale: 2, viewport: { width: 1440, height: 900 }, dpr: 2, path: png, hideCopy: true }));
  encode(png, join(assets, 'hero'), 240);
}
if (only.includes('tall')) {
  const png = join(docs, 'poster-tall.png');
  await timed('poster-tall', () => still(browser, srv.base, { t: T, scale: 3, viewport: { width: 390, height: 844 }, dpr: 3, path: png, hideCopy: true }));
  encode(png, join(assets, 'hero-tall'), 200);
}
if (only.includes('og')) {
  // The page itself at share-card size: logo, headline and sky; the form and sub-line are hidden.
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.__hero = { still: { t: 12, scale: 1 } }; });
  await page.goto(srv.base + '/?v=private&p=8');
  await page.addStyleTag({ content: `
    .sub, .cta { display: none !important; }
    .bar { height: 88px; } .brand { font-size: 22px; gap: 12px; } .mark { width: 26px; height: 26px; }
    .copy { padding-top: 34px; } h1 { font-size: 64px; max-width: 13em; }` });
  await page.waitForSelector('.hero[data-hero-done]', { timeout: 900000 });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: join(assets, 'og.png') });
  await ctx.close();
  console.log('og.png');
}
if (only.includes('icons')) {
  const svg = pathToFileURL(join(assets, 'favicon.svg')).href;
  for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180]]) {
    const p = await browser.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<style>html,body{margin:0;background:#070B14}</style><img src="${svg}" width="${size}" height="${size}" style="display:block">`);
    await p.waitForLoadState('load');
    await p.screenshot({ path: join(assets, name) });
    await p.close();
  }
  console.log('icons');
}
await browser.close();
srv.close();
