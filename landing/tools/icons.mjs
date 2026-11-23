// Renders assets/og.png (1200x630), assets/favicon-32.png and assets/apple-touch-icon.png.
//   node landing/tools/icons.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const b = await pw.chromium.launch();

// The share card reuses the hero figure from index.html, shown in its finished state.
const { readFile } = await import('node:fs/promises');
const html = await readFile(join(root, 'index.html'), 'utf8');
const figure = html.slice(html.indexOf('<figure class="viz"'), html.indexOf('</figure>') + 9);
const ctx = await b.newContext({ viewport: { width: 1200, height: 630 }, reducedMotion: 'reduce' });
const og = await ctx.newPage();
await og.goto(pathToFileURL(join(root, 'tools/og.html')).href);
await og.evaluate((f) => {
  const c = Array.from(document.querySelector('.og').childNodes).find((n) => n.nodeType === 8 && n.data.includes('FIGURE'));
  const t = document.createElement('template'); t.innerHTML = f; c.replaceWith(t.content);
}, figure);
await og.screenshot({ path: join(root, 'assets/og.png') });

const svg = pathToFileURL(join(root, 'assets/favicon.svg')).href;
for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180]]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<style>html,body{margin:0;background:#0D0C0B}</style><img src="${svg}" width="${size}" height="${size}" style="display:block">`);
  await p.waitForLoadState('load');
  await p.screenshot({ path: join(root, 'assets', name) });
}
await b.close();
