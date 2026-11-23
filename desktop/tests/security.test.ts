import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ isPackaged: true, openExternal: vi.fn() }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
  },
  shell: { openExternal: electronState.openExternal },
}));

import {
  ALLOWED_PERMISSIONS,
  CONTENT_SECURITY_POLICY,
  appOriginFor,
  applySecurityPolicies,
  contentSecurityPolicyFor,
  devContentSecurityPolicy,
  enableGlobalSandbox,
  isAllowedExternalUrl,
  isAppOrigin,
  isTrustedSender,
  secureWebPreferences,
} from '../src/main/security';

// ---- fakes --------------------------------------------------------------------------------

type Handler = (...args: any[]) => any;

function fakeApp(opts: { isPackaged: boolean; ready?: boolean }) {
  const listeners: Record<string, Handler[]> = {};
  return {
    isPackaged: opts.isPackaged,
    isReady: vi.fn(() => opts.ready ?? true),
    enableSandbox: vi.fn(),
    on: vi.fn((ev: string, cb: Handler) => {
      (listeners[ev] ??= []).push(cb);
    }),
    emit(ev: string, ...args: unknown[]) {
      for (const cb of listeners[ev] ?? []) cb(...args);
    },
  };
}

function fakeSession() {
  const s = {
    headersCb: undefined as Handler | undefined,
    requestHandler: undefined as Handler | undefined,
    checkHandler: undefined as Handler | undefined,
    deviceHandler: undefined as Handler | undefined,
    webRequest: { onHeadersReceived: vi.fn((cb: Handler) => (s.headersCb = cb)) },
    setPermissionRequestHandler: vi.fn((cb: Handler) => (s.requestHandler = cb)),
    setPermissionCheckHandler: vi.fn((cb: Handler) => (s.checkHandler = cb)),
    setDevicePermissionHandler: vi.fn((cb: Handler) => (s.deviceHandler = cb)),
  };
  return s;
}

function fakeContents(url = 'file:///opt/AirBridge/resources/app.asar/out/renderer/index.html') {
  const listeners: Record<string, Handler[]> = {};
  const c = {
    windowOpenHandler: undefined as Handler | undefined,
    on: vi.fn((ev: string, cb: Handler) => {
      (listeners[ev] ??= []).push(cb);
      return c;
    }),
    setWindowOpenHandler: vi.fn((cb: Handler) => (c.windowOpenHandler = cb)),
    getURL: () => url,
    fire(ev: string, url?: string) {
      const event = { preventDefault: vi.fn(), url };
      for (const cb of listeners[ev] ?? []) cb(event, url);
      return event;
    },
    has: (ev: string) => (listeners[ev] ?? []).length > 0,
  };
  return c;
}

const PROD_ORIGIN = 'file:///opt/AirBridge/resources/app.asar/out/renderer/';
const APP_URL = PROD_ORIGIN + 'index.html';

function setup(isPackaged = true, isDev = false, allowedOrigin: string = PROD_ORIGIN) {
  const app = fakeApp({ isPackaged });
  const session = fakeSession();
  const openExternal = vi.fn();
  applySecurityPolicies({
    app: app as never,
    session: session as never,
    isDev,
    allowedOrigin,
    devServerUrl: 'http://localhost:5173',
    openExternal,
  });
  const contents = fakeContents();
  app.emit('web-contents-created', {}, contents);
  return { app, session, contents, openExternal };
}

beforeEach(() => {
  electronState.isPackaged = true;
});

// ---- webPreferences -----------------------------------------------------------------------

describe('secureWebPreferences', () => {
  it('locks down every renderer', () => {
    const wp = secureWebPreferences('/app/out/preload/index.js');
    expect(wp).toMatchObject({
      preload: '/app/out/preload/index.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    });
    expect(wp).not.toHaveProperty('enableRemoteModule');
    expect(wp).not.toHaveProperty('experimentalFeatures', true);
  });
  it('devTools only when unpackaged', () => {
    electronState.isPackaged = true;
    expect(secureWebPreferences('/p.js').devTools).toBe(false);
    electronState.isPackaged = false;
    expect(secureWebPreferences('/p.js').devTools).toBe(true);
  });
  it('requires a preload path', () => {
    expect(() => secureWebPreferences('')).toThrow();
  });
});

// ---- CSP ----------------------------------------------------------------------------------

describe('Content-Security-Policy', () => {
  it('production policy is strict', () => {
    const csp = CONTENT_SECURITY_POLICY;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|wasm-unsafe-eval|\*|https?:|ws:/);
  });
  it('dev policy only for loopback dev servers and never when packaged', () => {
    const dev = devContentSecurityPolicy('http://localhost:5173/');
    expect(dev).toContain('ws://localhost:5173');
    expect(dev).not.toContain('unsafe-eval');
    expect(devContentSecurityPolicy('http://evil.example:5173')).toBe(CONTENT_SECURITY_POLICY);
    expect(devContentSecurityPolicy(undefined)).toBe(CONTENT_SECURITY_POLICY);
    expect(contentSecurityPolicyFor({ isPackaged: true, isDev: true, devServerUrl: 'http://localhost:5173' })).toBe(
      CONTENT_SECURITY_POLICY,
    );
  });
  it('onHeadersReceived replaces any upstream CSP with ours (packaged)', () => {
    const { session } = setup(true, true);
    const cb = vi.fn();
    session.headersCb!(
      { url: APP_URL, responseHeaders: { 'content-security-policy': ["default-src *"], 'X-Other': ['1'] } },
      cb,
    );
    const headers = cb.mock.calls[0][0].responseHeaders;
    expect(headers['Content-Security-Policy']).toEqual([CONTENT_SECURITY_POLICY]);
    expect(headers['content-security-policy']).toBeUndefined();
    expect(headers['X-Other']).toEqual(['1']);
    expect(headers['X-Content-Type-Options']).toEqual(['nosniff']);
  });
  it('renderer index.html carries a strict meta CSP (file:// loads have no headers)', () => {
    const html = resolve(__dirname, '../src/renderer/index.html');
    if (!existsSync(html)) return; // UI/UX file not written yet
    const text = readFileSync(html, 'utf8');
    const m = text.match(/http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]+)"/i);
    expect(m, 'index.html must declare a CSP meta tag').toBeTruthy();
    expect(m![1]).not.toMatch(/unsafe-eval|unsafe-inline/);
    expect(m![1]).toMatch(/default-src 'self'/);
    expect(m![1]).toMatch(/object-src 'none'/);
  });
});

// ---- navigation / popups / webviews --------------------------------------------------------

describe('navigation and window policies', () => {
  it('allows in-app navigation, blocks everything else', () => {
    const { contents } = setup();
    expect(contents.fire('will-navigate', APP_URL + '#/settings').preventDefault).not.toHaveBeenCalled();
    for (const url of [
      'https://evil.example/',
      'file:///etc/passwd',
      'file:///opt/AirBridge/resources/app.asar/out/renderer/../../../../../etc/passwd',
      'file:///opt/AirBridge/resources/app.asar/out/renderer%2F..%2Fsecret',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'about:blank',
      'http://127.0.0.1:8765/status',
    ]) {
      expect(contents.fire('will-navigate', url).preventDefault, url).toHaveBeenCalled();
      expect(contents.fire('will-redirect', url).preventDefault, url).toHaveBeenCalled();
      expect(contents.fire('will-frame-navigate', url).preventDefault, url).toHaveBeenCalled();
    }
  });
  it('reads the URL from event.url when the positional arg is absent', () => {
    const { contents } = setup();
    const ev = { preventDefault: vi.fn(), url: 'https://evil.example' };
    contents.on.mock.calls.find((c) => c[0] === 'will-navigate')![1](ev);
    expect(ev.preventDefault).toHaveBeenCalled();
  });
  it('blocks <webview> attachment', () => {
    const { contents } = setup();
    expect(contents.fire('will-attach-webview').preventDefault).toHaveBeenCalled();
  });
  it('window.open is always denied; only allowlisted https links go to the system browser', () => {
    const { contents, openExternal } = setup();
    const h = contents.windowOpenHandler!;
    expect(h({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_abc');
    openExternal.mockClear();
    for (const url of [
      'https://evil.example/',
      'http://checkout.stripe.com/',
      'https://checkout.stripe.com.evil.example/',
      'https://user:pw@checkout.stripe.com/',
      'https://checkout.stripe.com:8443/',
      'file:///etc/passwd',
      'smb://host/share',
      'javascript:alert(1)',
      APP_URL,
    ]) {
      expect(h({ url })).toEqual({ action: 'deny' });
    }
    expect(openExternal).not.toHaveBeenCalled();
  });
  it('external allowlist covers clerk subdomains but not the bare suffix', () => {
    expect(isAllowedExternalUrl('https://foo-bar-1.clerk.accounts.dev/sign-in')).toBe(true);
    expect(isAllowedExternalUrl('https://clerk.accounts.dev/')).toBe(false);
    expect(isAllowedExternalUrl('https://license.example.com/x', ['license.example.com'])).toBe(true);
  });
});

// ---- permissions ---------------------------------------------------------------------------

describe('permissions', () => {
  it('denies every permission request except clipboard write from the app', () => {
    const { session, contents } = setup();
    for (const perm of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'hid', 'usb', 'fullscreen', 'pointerLock']) {
      const cb = vi.fn();
      session.requestHandler!(contents, perm, cb, { requestingUrl: APP_URL });
      expect(cb, perm).toHaveBeenCalledWith(false);
      expect(session.checkHandler!(contents, perm, 'file://', { requestingUrl: APP_URL }), perm).toBe(false);
    }
    expect(ALLOWED_PERMISSIONS).toEqual(['clipboard-sanitized-write']);
    const ok = vi.fn();
    session.requestHandler!(contents, 'clipboard-sanitized-write', ok, { requestingUrl: APP_URL });
    expect(ok).toHaveBeenCalledWith(true);
    const foreign = vi.fn();
    session.requestHandler!(contents, 'clipboard-sanitized-write', foreign, { requestingUrl: 'https://evil.example' });
    expect(foreign).toHaveBeenCalledWith(false);
    expect(session.deviceHandler!()).toBe(false);
  });
});

// ---- sandbox, origins, IPC sender --------------------------------------------------------

describe('sandbox and origins', () => {
  it('enableGlobalSandbox only before ready', () => {
    const notReady = fakeApp({ isPackaged: true, ready: false });
    enableGlobalSandbox(notReady as never);
    expect(notReady.enableSandbox).toHaveBeenCalled();
    const ready = fakeApp({ isPackaged: true, ready: true });
    enableGlobalSandbox(ready as never);
    expect(ready.enableSandbox).not.toHaveBeenCalled();
  });
  it('isAppOrigin (http dev origin)', () => {
    const o = 'http://localhost:5173';
    expect(isAppOrigin('http://localhost:5173/index.html', o)).toBe(true);
    expect(isAppOrigin('http://localhost:5174/', o)).toBe(false);
    expect(isAppOrigin('http://localhost.evil.example:5173/', o)).toBe(false);
    expect(isAppOrigin('http://user@localhost:5173/', o)).toBe(false);
    expect(isAppOrigin(undefined, o)).toBe(false);
    expect(isAppOrigin('', o)).toBe(false);
    expect(isAppOrigin('not a url', o)).toBe(false);
  });
  it('isAppOrigin (file:// renderer dir)', () => {
    expect(isAppOrigin(APP_URL, PROD_ORIGIN)).toBe(true);
    expect(isAppOrigin('file:///opt/AirBridge/resources/app.asar/out/renderer-evil/index.html', PROD_ORIGIN)).toBe(false);
    expect(isAppOrigin('file:///tmp/evil.html', PROD_ORIGIN)).toBe(false);
    expect(isAppOrigin('file://remotehost/opt/AirBridge/resources/app.asar/out/renderer/index.html', PROD_ORIGIN)).toBe(false);
  });
  it('appOriginFor', () => {
    expect(appOriginFor({ isDev: true, devServerUrl: 'http://localhost:5173/' })).toBe('http://localhost:5173');
    expect(appOriginFor({ isDev: true, devServerUrl: 'http://evil.example', rendererDir: '/a/out/renderer' })).toBe(
      'file:///a/out/renderer/',
    );
    expect(appOriginFor({ isDev: false, rendererDir: 'C:\\Program Files\\AirBridge\\out\\renderer' })).toBe(
      'file:///C:/Program%20Files/AirBridge/out/renderer/',
    );
    expect(() => appOriginFor({ isDev: false })).toThrow();
  });
  it('isTrustedSender requires a live top-level app frame', () => {
    expect(isTrustedSender({ senderFrame: { url: APP_URL, parent: null } }, PROD_ORIGIN)).toBe(true);
    expect(isTrustedSender({ senderFrame: { url: APP_URL, parent: {} } }, PROD_ORIGIN)).toBe(false);
    expect(isTrustedSender({ senderFrame: { url: 'https://evil.example', parent: null } }, PROD_ORIGIN)).toBe(false);
    expect(isTrustedSender({ senderFrame: null }, PROD_ORIGIN)).toBe(false);
    expect(isTrustedSender(undefined, PROD_ORIGIN)).toBe(false);
  });
});
