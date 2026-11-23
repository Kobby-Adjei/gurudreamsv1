// Screenshots + behaviour checks for the landing page. Run from anywhere:
//   node landing/tools/shoot.mjs            (checks + docs/hero-desktop-1.png, -2.png, hero-mobile.png)
// Serves landing/ with the production CSP and /v1/waitlist* stubbed. Headless Chromium renders WebGL with
// SwiftShader, so the live canvas runs at a few frames per second here: checks wait for frames, not time.
import { join } from 'node:path';
import { serve, launch, still, root, pw } from './serve.mjs';

const { devices } = pw;
const docs = join(root, 'docs');
const srv = await serve();
const base = srv.base;
const browser = await launch();
const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const iphone = { ...devices['iPhone 14'] };
let failures = 0;
const report = (name, ok, detail) => { if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + name, detail === undefined ? '' : JSON.stringify(detail)); };

function watchErrors(page, into) {
  page.on('console', (m) => { if (m.type() === 'error') into.push(m.text()); });
  page.on('pageerror', (e) => into.push(String(e)));
}
// Count requestAnimationFrame calls so "no animation" can be checked, not assumed.
const countRaf = () => {
  window.__raf = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { window.__raf++; return raf(cb); };
};
// Luminance spread of a PNG, measured in a scratch page (no server, no CSP).
async function pixelStats(png) {
  const p = await browser.newPage();
  const r = await p.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, s = 0, s2 = 0, max = 0;
    for (let i = 0; i < d.length; i += 16) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; s += l; s2 += l * l; if (l > max) max = l; }
    const m = s / n; return { mean: +m.toFixed(1), std: +Math.sqrt(s2 / n - m * m).toFixed(1), max: Math.round(max) };
  }, png.toString('base64'));
  await p.close();
  return r;
}

// 1. Review screenshots: stills of the flight at live quality, with the page copy on top.
{
  const errs = [];
  errs.push(...await still(browser, base, { t: 3.2, scale: 0.6, live: true, ...desktop, path: join(docs, 'hero-desktop-1.png') }));
  errs.push(...await still(browser, base, { t: 12, scale: 0.6, live: true, ...desktop, query: '?v=bridge&p=15', path: join(docs, 'hero-desktop-2.png') }));
  errs.push(...await still(browser, base, { t: 12, scale: 0.5, live: true, viewport: iphone.viewport, dpr: 3, path: join(docs, 'hero-mobile.png') }));
  report('stills rendered without console errors', errs.length === 0, errs);
}

// 2. Live canvas: starts, draws a non-blank sky with clouds and keeps animating.
{
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = []; watchErrors(page, errs);
  await page.addInitScript(() => { window.__hero = { allowSoftware: true }; });
  await page.addInitScript(countRaf);
  await page.goto(`${base}/?v=private&p=8`);
  await page.waitForSelector('.hero[data-hero="live"]', { timeout: 120000 });
  const r0 = await page.evaluate(() => window.__raf);
  await page.waitForFunction((n) => window.__raf >= n + 3, r0, { timeout: 120000 });
  await page.waitForTimeout(1800); // fade-in
  const stats = await pixelStats(await page.locator('#sky').screenshot());
  const state = await page.evaluate(() => ({ hero: document.querySelector('.hero').dataset.hero, opacity: getComputedStyle(document.getElementById('sky')).opacity, raf: window.__raf }));
  report('live canvas renders non-blank and animates', stats.std > 12 && stats.max > 120 && state.hero === 'live' && state.raf > r0 + 3, { stats, state });
  // Hidden tab pauses the loop.
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(500);
  const a = await page.evaluate(() => window.__raf); await page.waitForTimeout(1500); const b = await page.evaluate(() => window.__raf);
  report('hidden tab pauses rendering', b === a, { a, b });
  report('live page has no console errors', errs.length === 0, errs);
  await ctx.close();
}

// 3. Reduced motion: the poster, no canvas loop, no CSS animation.
{
  const ctx = await browser.newContext({ ...desktop, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errs = []; watchErrors(page, errs);
  await page.addInitScript(countRaf);
  await page.goto(`${base}/?v=private&p=8`);
  await page.waitForSelector('.hero[data-hero="poster-ready"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const img = document.querySelector('.poster img');
    return { raf: window.__raf, anims: document.getAnimations().length, poster: img.currentSrc.split('/').pop(), w: img.naturalWidth, visible: getComputedStyle(img).opacity, reason: document.querySelector('.hero').dataset.heroReason };
  });
  report('reduced motion shows the poster without animating', r.raf === 0 && r.anims === 0 && r.w > 0 && r.visible === '1' && r.reason === 'reduced-motion', r);
  report('reduced-motion page has no console errors', errs.length === 0, errs);
  await page.screenshot({ path: join(docs, 'hero-reduced-motion.png') });
  await ctx.close();
}

// 4. No WebGL at all (software rendering refused): falls back to the poster.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, o) { return /webgl/.test(t) ? null : g.call(this, t, o); }; });
  await page.goto(`${base}/`);
  await page.waitForSelector('.hero[data-hero="poster-ready"]', { timeout: 20000 });
  report('no WebGL falls back to the poster', true, await page.evaluate(() => document.querySelector('.hero').dataset.heroReason));
  await ctx.close();
}

// 5. Every headline variant: at most 2 lines on desktop and on a 390px phone, and never mentions computers.
{
  const out = {};
  let ok = true;
  for (const [label, opts] of [['desktop', desktop], ['mobile', iphone]]) {
    const ctx = await browser.newContext({ ...opts, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    for (const v of ['private', 'cross', 'bridge', 'current']) {
      await page.goto(`${base}/?v=${v}&p=8`);
      const r = await page.evaluate(() => {
        const h = document.getElementById('headline'); const cs = getComputedStyle(h);
        return { text: h.textContent, lines: Math.round(h.getBoundingClientRect().height / parseFloat(cs.lineHeight)), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      if (r.lines > 2 || r.overflow || /computer|machine|\bmac\b|\bpc\b|airdrop/i.test(r.text)) ok = false;
      out[label + ':' + v] = r.lines + ' ' + r.text;
    }
    await ctx.close();
  }
  report('headlines fit in two lines, no computer talk', ok, out);
}

// 6. Form: invalid email shows an error, valid one shows the inline success state; no cookies.
{
  const ctx = await browser.newContext({ ...desktop, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errs = []; watchErrors(page, errs);
  let sent = null;
  page.on('request', (req) => { if (req.url().endsWith('/v1/waitlist')) sent = req.postDataJSON(); });
  await page.goto(`${base}/?v=cross&p=15&utm_source=hn&utm_medium=post`);
  await page.fill('#email', 'nope');
  await page.press('#email', 'Enter');
  const err = await page.textContent('#form-msg');
  const invalid = await page.getAttribute('#email', 'aria-invalid');
  await page.fill('#email', 'dev@example.com');
  await page.click('#submit');
  await page.waitForSelector('#done:not([hidden])');
  const focused = await page.evaluate(() => document.activeElement.id);
  const r = { err, invalid, sent, focused, hash: new URL(page.url()).hash, cookies: (await ctx.cookies()).length };
  report('form validates, submits and confirms', err === 'Enter a valid email address.' && invalid === 'true' && sent && sent.email === 'dev@example.com' &&
    sent.variant === 'cross' && sent.price === 15 && sent.utm_source === 'hn' && focused === 'done' && r.hash === '#thanks' && r.cookies === 0, r);
  report('form page has no console errors', errs.length === 0, errs);
  await ctx.close();
}

await browser.close();
srv.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exitCode = failures ? 1 : 0;
