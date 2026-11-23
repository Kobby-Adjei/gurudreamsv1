// Download button checks + screenshots (desktop Mac and iPhone, reduced motion):
//   node landing/tools/downloads.mjs [https://host]   -> docs/downloads-desktop.png, docs/downloads-mobile.png
// Without a host it serves landing/ with a stubbed /downloads/latest.json; with one it checks the live site.
import { join } from 'node:path';
import { serve, launch, root, pw } from './serve.mjs';

const live = process.argv[2] || null;
const manifest = {
  version: '0.2.0', id: '0.2.0-abcdef0', commit: 'abcdef0'.padEnd(40, '0'), published_at: '2026-11-23T00:00:00Z', previous: null,
  files: [
    { platform: 'mac', arch: 'arm64', kind: 'dmg', name: 'AirBridge-Pro-0.2.0-mac-arm64.dmg', size: 123456789, sha256: '0'.repeat(64), url: '/downloads/0.2.0-abcdef0/AirBridge-Pro-0.2.0-mac-arm64.dmg' },
    { platform: 'mac', arch: 'x64', kind: 'dmg', name: 'AirBridge-Pro-0.2.0-mac-x64.dmg', size: 128456789, sha256: '0'.repeat(64), url: '/downloads/0.2.0-abcdef0/AirBridge-Pro-0.2.0-mac-x64.dmg' },
    { platform: 'win', arch: 'x64', kind: 'exe', name: 'AirBridge-Pro-0.2.0-win-x64.exe', size: 98765432, sha256: '0'.repeat(64), url: '/downloads/0.2.0-abcdef0/AirBridge-Pro-0.2.0-win-x64.exe' },
  ],
};
let mode = 'ok';
const srv = live ? null : await serve({
  '/downloads/latest.json': () => (mode === 'ok' ? { status: 200, body: JSON.stringify(manifest) } : { status: 404, type: 'text/plain', body: '404' }),
});
const base = live || srv.base;
const browser = await launch();
const { devices } = pw;
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let failures = 0;
const report = (name, ok, detail) => { if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + name, detail === undefined ? '' : JSON.stringify(detail)); };

// arch: what Chromium's client hints report (null = a browser without them, like Safari or Firefox).
async function open({ arch = null, ...opts }) {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...opts });
  const page = await ctx.newPage();
  await page.addInitScript((a) => {
    const uad = a ? { platform: 'macOS', mobile: false, brands: [], getHighEntropyValues: async () => ({ architecture: a }) } : undefined;
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => uad, configurable: true });
  }, arch);
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(base + '/?v=private&p=8');
  await page.waitForFunction(() => document.getElementById('get').getAttribute('data-state') !== 'loading');
  await page.waitForSelector('.hero[data-hero="poster-ready"]');
  const state = await page.evaluate(() => ({
    state: document.getElementById('get').dataset.state,
    label: document.getElementById('dl-label').textContent,
    href: document.getElementById('dl-main').getAttribute('href'),
    mainVisible: !!document.getElementById('dl-main').offsetParent,
    meta: document.getElementById('dl-meta').textContent,
    other: document.getElementById('dl-other').textContent,
    links: [...document.querySelectorAll('#dl-other a')].map((a) => a.getAttribute('href')),
    note: document.getElementById('dl-note').textContent,
    email: document.getElementById('email-label').textContent,
    soonVisible: !!document.getElementById('get-soon').offsetParent,
    scrollW: document.documentElement.scrollWidth, w: innerWidth,
  }));
  return { ctx, page, errs, state };
}

const want = live ? null : manifest;
{
  const { ctx, page, errs, state } = await open({ userAgent: MAC });
  report('mac: big "Download for Mac" button (Apple silicon default)', state.label === 'Download for Mac' && (!want || state.href === want.files[0].url), state);
  report('mac: "Intel Mac?" and Windows links', /Intel Mac\?/.test(state.other) && /Windows/.test(state.other) && state.links.length === 2);
  report('mac: version, size, beta line, first-run note', /Version .* · Apple silicon · .* MB · Beta · free while in preview/.test(state.meta) && /Open Anyway/.test(state.note), state.meta);
  report('mac: no console errors', errs.length === 0, errs);
  // Keyboard: the download button is the first focus stop after the brand link.
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  report('keyboard: Tab reaches the download button', await page.evaluate(() => document.activeElement.id === 'dl-main'));
  await page.keyboard.press('Tab');
  report('keyboard: then the Intel link', await page.evaluate(() => document.activeElement.textContent === 'Intel Mac?'));
  report('mac: email form folded behind "Get updates by email"', await page.evaluate(() => document.getElementById('cta').hidden));
  await page.evaluate(() => document.activeElement.blur());
  await page.screenshot({ path: join(root, 'docs', 'downloads-desktop.png') });
  await page.focus('#dl-main');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
  const at = await page.evaluate(() => document.activeElement.id);
  report('keyboard: Tab order brand, download, Intel, Windows, Get updates', at === 'updates-toggle', at);
  if (at === 'updates-toggle') await page.keyboard.press('Enter');
  const opened = await page.evaluate(() => ({ open: !document.getElementById('cta').hidden, focus: document.activeElement.id, exp: document.getElementById('updates-toggle').getAttribute('aria-expanded') }));
  report('keyboard: "Get updates by email" opens the form and focuses the email field', opened.open && opened.focus === 'email' && opened.exp === 'true', opened);
  await page.screenshot({ path: join(root, 'docs', 'downloads-desktop-email.png') });
  await ctx.close();
}
{
  const { ctx, state } = await open({ userAgent: MAC.replace('Version/18.1 Safari', 'Chrome/131.0.0.0 Safari'), arch: 'x86' });
  report('mac (Chrome, Intel): "Download for Mac" gets the Intel build', /mac-x64\.dmg$/.test(state.href) && /Apple silicon Mac\?/.test(state.other) && / · Intel · /.test(state.meta), state);
  await ctx.close();
}
{
  const { ctx, state } = await open({ userAgent: MAC.replace('Version/18.1 Safari', 'Chrome/131.0.0.0 Safari'), arch: 'arm' });
  report('mac (Chrome, Apple silicon): the arm64 build', /mac-arm64\.dmg$/.test(state.href), state.href);
  await ctx.close();
}
{
  const { ctx, errs, state } = await open({ userAgent: WIN });
  report('windows: "Download for Windows"', state.label === 'Download for Windows' && /\.exe$/.test(state.href) && /More info → Run anyway/.test(state.note), state);
  report('windows: Mac links', state.links.length === 2 && /Mac \(Apple silicon\)/.test(state.other), state.other);
  report('windows: no console errors', errs.length === 0, errs);
  await ctx.close();
}
{
  const { ctx, state } = await open({ userAgent: LINUX });
  report('linux: no big button, every build listed', !state.mainVisible && state.links.length === 3 && /runs on Mac and Windows/.test(state.other), state);
  await ctx.close();
}
{
  const { ctx, page, errs, state } = await open({ ...devices['iPhone 14'], reducedMotion: 'reduce' });
  report('iphone: no big button; runs on Mac and Windows + links + email', !state.mainVisible && state.links.length === 3 && /runs on Mac and Windows/.test(state.other) && /Get updates/.test(state.email), state);
  report('iphone: no horizontal scroll', state.scrollW <= state.w, state);
  report('iphone: no console errors', errs.length === 0, errs);
  await page.screenshot({ path: join(root, 'docs', 'downloads-mobile.png') });
  await ctx.close();
}
if (!live) {
  mode = 'missing';
  const { ctx, errs, state } = await open({ userAgent: MAC });
  report('no manifest: "Downloads coming soon" + email', state.state === 'soon' && state.soonVisible && !state.mainVisible && /ready/.test(state.email), state);
  report('no manifest: only the expected 404 in the console', errs.every((e) => /404/.test(e)), errs);
  await ctx.close();
}
await browser.close();
srv?.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
