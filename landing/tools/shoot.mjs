// Screenshots + animation rest check. Run from anywhere:
//   NODE_PATH=/opt/node-tools/node_modules node landing/tools/shoot.mjs
// Serves landing/ on a local port, stubs /v1/waitlist*, writes landing/docs/*.png.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const { chromium, devices } = pw;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/v1/waitlist')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }
  const p = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const body = await readFile(join(root, p));
    res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const settle = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished'), null, { timeout: 8000 });

async function shot(name, query, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(`${base}/${query}`);
  await settle(page);
  await page.screenshot({ path: join(docs, name), fullPage: !!ctxOpts.fullPage });
  await ctx.close();
}

const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
await shot('desktop-private.png', '?v=private&p=8', desktop);
await shot('desktop-cross.png', '?v=cross&p=15', desktop);
await shot('desktop-private-1280.png', '?v=private&p=15', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await shot('desktop-bridge.png', '?v=bridge&p=8', desktop);
await shot('mobile-private.png', '?v=private&p=8', { ...devices['iPhone 14'], deviceScaleFactor: 2 });
if (process.argv.includes('--extra')) {
  await shot('desktop-current.png', '?v=current&p=15', desktop);
  await shot('desktop-full.png', '?v=private&p=8', { ...desktop, fullPage: true });
  await shot('mobile-full.png', '?v=cross&p=15', { ...devices['iPhone 14'], deviceScaleFactor: 2, fullPage: true });
}

// Animation check: runs exactly once, ends with the card on the desktop and the span drawn; reduced motion is static.
{
  const ctx = await browser.newContext(desktop);
  const page = await ctx.newPage();
  await page.goto(`${base}/?v=private&p=8`);
  const early = await page.evaluate(() => getComputedStyle(document.querySelector('.card')).transform);
  await settle(page);
  const r = await page.evaluate(() => ({
    anims: document.getAnimations().map((a) => ({ name: a.animationName, state: a.playState, iterations: a.effect.getTiming().iterations })),
    card: [...document.querySelectorAll('.card')].map((c) => getComputedStyle(c).transform + '/' + getComputedStyle(c).opacity),
    span: [...document.querySelectorAll('.span')].map((c) => parseFloat(getComputedStyle(c).strokeDashoffset))
  }));
  await page.waitForTimeout(1500);
  const later = await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => getComputedStyle(c).transform + '/' + getComputedStyle(c).opacity));
  const ok = r.anims.length === 4 && r.anims.every((a) => a.state === 'finished' && a.iterations === 1) &&
    r.card.every((c) => c === 'none/1' || c === 'matrix(1, 0, 0, 1, 0, 0)/1') && r.span.every((v) => v === 0) &&
    JSON.stringify(later) === JSON.stringify(r.card);
  console.log('animation start', early, '-> rest', JSON.stringify(r), ok ? 'PASS' : 'FAIL');
  await ctx.close();

  const rm = await browser.newContext({ ...desktop, reducedMotion: 'reduce' });
  const p2 = await rm.newPage();
  await p2.goto(`${base}/?v=private&p=8`);
  const s = await p2.evaluate(() => ({ n: document.getAnimations().length, card: getComputedStyle(document.querySelector('.card')).transform }));
  console.log('reduced motion', JSON.stringify(s), s.n === 0 ? 'PASS' : 'FAIL');
  await rm.close();
}

// Form check: invalid email shows an error, valid one shows the inline success state.
{
  const ctx = await browser.newContext(desktop);
  const page = await ctx.newPage();
  let sent = null;
  page.on('request', (req) => { if (req.url().endsWith('/v1/waitlist')) sent = req.postDataJSON(); });
  await page.goto(`${base}/?v=cross&p=15&utm_source=hn&utm_medium=post`);
  await page.fill('#email', 'nope');
  await page.press('#email', 'Enter');
  const err = await page.textContent('#form-msg');
  await page.fill('#email', 'dev@example.com');
  await page.click('#submit');
  await page.waitForSelector('#done:not([hidden])');
  console.log('form', JSON.stringify({ err, sent, hash: new URL(page.url()).hash, cookies: (await ctx.cookies()).length }));
  if (process.argv.includes('--extra')) await page.screenshot({ path: join(docs, 'desktop-thanks.png') });
  await ctx.close();
}

await browser.close();
server.close();
