/**
 * Electron hardening for AirBridge Pro (Security-owned).
 *
 * Usage from src/main/index.ts (Systems):
 *
 *   import { enableGlobalSandbox, applySecurityPolicies, secureWebPreferences, appOriginFor } from './security';
 *   enableGlobalSandbox(app);                       // BEFORE app 'ready'
 *   app.whenReady().then(() => {
 *     const allowedOrigin = appOriginFor({ isDev, devServerUrl: process.env.ELECTRON_RENDERER_URL,
 *                                          rendererDir: join(__dirname, '../renderer') });
 *     applySecurityPolicies({ app, session: session.defaultSession, isDev, allowedOrigin });
 *     new BrowserWindow({ ..., webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js')) });
 *   });
 *
 * From src/main/ipc.ts (SWE): `if (!isTrustedSender(event, allowedOrigin)) throw new Error('forbidden')`.
 *
 * See airbridge/docs/PHASE2_SECURITY.md for the rationale and the threat model.
 */
import { app as electronApp, shell } from 'electron';
import type { App, Session, WebContents, WebPreferences } from 'electron';

// ------------------------------------------------------------------------------------------
// webPreferences
// ------------------------------------------------------------------------------------------

/**
 * The only webPreferences any AirBridge window may use. The preload runs sandboxed and talks to
 * the renderer exclusively through contextBridge.
 */
export function secureWebPreferences(preloadPath: string): WebPreferences {
  if (typeof preloadPath !== 'string' || preloadPath.length === 0) {
    throw new Error('secureWebPreferences: preloadPath is required');
  }
  const isPackaged = Boolean(electronApp?.isPackaged);
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: !isPackaged,
  };
}

// ------------------------------------------------------------------------------------------
// Content-Security-Policy
// ------------------------------------------------------------------------------------------

const CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ['default-src', "'self'"],
  ['script-src', "'self'"],
  ['style-src', "'self'"],
  ['img-src', "'self' data:"],
  ['connect-src', "'self'"],
  ['font-src', "'self'"],
  ['object-src', "'none'"],
  ['base-uri', "'none'"],
  ['form-action', "'none'"],
  ['frame-ancestors', "'none'"],
];

/** Production CSP. No 'unsafe-inline', no 'unsafe-eval', no remote origins. */
export const CONTENT_SECURITY_POLICY: string = CSP_DIRECTIVES.map(([k, v]) => `${k} ${v}`).join('; ');

/**
 * Development CSP: additionally allows the Vite dev server (HTTP + HMR websocket) and the inline
 * React-refresh preamble / injected <style> tags Vite needs. Only ever used when !app.isPackaged.
 * Only loopback dev-server URLs are accepted; anything else falls back to the production CSP.
 */
export function devContentSecurityPolicy(devServerUrl: string | undefined): string {
  const origin = loopbackOrigin(devServerUrl);
  if (!origin) return CONTENT_SECURITY_POLICY;
  const ws = origin.replace(/^http/, 'ws');
  const extra: Record<string, string> = {
    'script-src': `${origin} 'unsafe-inline'`,
    'style-src': `${origin} 'unsafe-inline'`,
    'img-src': origin,
    'connect-src': `${origin} ${ws}`,
    'font-src': origin,
  };
  return CSP_DIRECTIVES.map(([k, v]) => (extra[k] ? `${k} ${v} ${extra[k]}` : `${k} ${v}`)).join('; ');
}

/** The CSP for this process: dev variant only when unpackaged AND isDev. */
export function contentSecurityPolicyFor(opts: { isPackaged: boolean; isDev: boolean; devServerUrl?: string }): string {
  return !opts.isPackaged && opts.isDev ? devContentSecurityPolicy(opts.devServerUrl) : CONTENT_SECURITY_POLICY;
}

function loopbackOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------
// Origin checks (reused by ipc.ts for senderFrame validation)
// ------------------------------------------------------------------------------------------

/**
 * Compute the app origin descriptor. Dev: the loopback Vite URL's origin. Prod: a file:// URL
 * of the renderer directory (with trailing slash) — file: URLs have an opaque ("null") origin,
 * so isAppOrigin compares them by directory prefix instead.
 */
export function appOriginFor(opts: { isDev: boolean; devServerUrl?: string; rendererDir?: string }): string {
  if (opts.isDev) {
    const o = loopbackOrigin(opts.devServerUrl);
    if (o) return o;
  }
  if (!opts.rendererDir) throw new Error('appOriginFor: rendererDir required in production');
  // Build a file URL without importing node:url so this module stays trivially mockable.
  let p = opts.rendererDir.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p; // Windows drive paths: C:/... -> /C:/...
  if (!p.endsWith('/')) p += '/';
  return new URL('file://' + encodeURI(p).replace(/\?/g, '%3F').replace(/#/g, '%23')).href;
}

/**
 * True iff `url` belongs to the app. `allowedOrigin` is either an http(s) origin
 * (exact scheme+host+port match) or a file:// directory URL (url must be a file: URL inside it).
 * Anything unparsable, `about:blank`, `data:`, `javascript:`, devtools: etc. is false.
 */
export function isAppOrigin(url: unknown, allowedOrigin: string | readonly string[]): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 8192) return false;
  const allowed = Array.isArray(allowedOrigin) ? allowedOrigin : [allowedOrigin as string];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  for (const a of allowed) {
    if (typeof a !== 'string' || a.length === 0) continue;
    let base: URL;
    try {
      base = new URL(a);
    } catch {
      continue;
    }
    if (base.protocol === 'file:') {
      if (u.protocol !== 'file:' || u.host !== base.host) continue;
      const dir = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
      // WHATWG URL parsing already resolved "." / ".." / "%2e" segments.
      if (u.pathname.startsWith(dir) && !/%2f|%5c/i.test(u.pathname)) return true;
      continue;
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') continue;
    if (u.origin !== 'null' && u.origin === base.origin && u.username === '' && u.password === '') return true;
  }
  return false;
}

interface SenderFrameLike {
  url?: string;
  parent?: unknown;
}

/**
 * Validate an IPC event's sender: must be a live, top-level frame whose URL is the app origin.
 * Use in every ipcMain.handle / ipcMain.on handler.
 */
export function isTrustedSender(
  event: { senderFrame?: SenderFrameLike | null } | null | undefined,
  allowedOrigin: string | readonly string[],
): boolean {
  const frame = event?.senderFrame;
  if (!frame) return false; // frame navigated away or destroyed
  if (frame.parent !== null && frame.parent !== undefined) return false; // sub-frames never talk to main
  return isAppOrigin(frame.url, allowedOrigin);
}

// ------------------------------------------------------------------------------------------
// External links
// ------------------------------------------------------------------------------------------

/** Hosts that may be opened in the user's default browser (https only, port 443). */
export const DEFAULT_EXTERNAL_HOSTS: readonly string[] = Object.freeze([
  'checkout.stripe.com',
  'billing.stripe.com',
  'airbridge.app',
  'www.airbridge.app',
]);
/** Host suffixes (subdomains only) that may be opened externally. */
export const DEFAULT_EXTERNAL_HOST_SUFFIXES: readonly string[] = Object.freeze(['.clerk.accounts.dev', '.clerk.com']);

export function isAllowedExternalUrl(
  url: unknown,
  extraHosts: readonly string[] = [],
): boolean {
  if (typeof url !== 'string' || url.length > 4096) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || (u.port !== '' && u.port !== '443')) {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if ([...DEFAULT_EXTERNAL_HOSTS, ...extraHosts.map((h) => h.toLowerCase())].includes(host)) return true;
  return DEFAULT_EXTERNAL_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

// ------------------------------------------------------------------------------------------
// Session / app policies
// ------------------------------------------------------------------------------------------

/** Must be called before the app 'ready' event. Forces the sandbox for every renderer. */
export function enableGlobalSandbox(app: Pick<App, 'enableSandbox' | 'isReady'>): void {
  if (!app.isReady()) app.enableSandbox();
}

/** Permissions the renderer may be granted (from the app origin only). Everything else is denied. */
export const ALLOWED_PERMISSIONS: readonly string[] = Object.freeze(['clipboard-sanitized-write']);

export interface ApplySecurityOptions {
  app: Pick<App, 'on' | 'isPackaged' | 'isReady' | 'enableSandbox'>;
  session: Session;
  isDev: boolean;
  /** Value from appOriginFor(). */
  allowedOrigin: string | readonly string[];
  /** Dev server URL (for the dev CSP); ignored when packaged. */
  devServerUrl?: string;
  /** Extra https hosts allowed for shell.openExternal (e.g. the license server's host). */
  extraExternalHosts?: readonly string[];
  /** Injected for tests; defaults to electron.shell.openExternal. */
  openExternal?: (url: string) => Promise<void> | void;
}

type HeaderMap = Record<string, string | string[]>;

export function applySecurityPolicies(opts: ApplySecurityOptions): void {
  const { app, session, allowedOrigin } = opts;
  const isPackaged = Boolean(app.isPackaged);
  const isDev = !isPackaged && opts.isDev; // a packaged app is never "dev"
  const csp = contentSecurityPolicyFor({ isPackaged, isDev, devServerUrl: opts.devServerUrl });
  const openExternal = opts.openExternal ?? ((u: string) => shell.openExternal(u));
  const extraHosts = opts.extraExternalHosts ?? [];

  enableGlobalSandbox(app);

  // 1. CSP + a few hardening headers on every response that reaches a renderer.
  //    (file:// loads have no response headers; the renderer index.html must ALSO carry a
  //    <meta http-equiv="Content-Security-Policy"> with the production policy.)
  session.webRequest.onHeadersReceived((details, callback) => {
    const headers: HeaderMap = {};
    for (const [k, v] of Object.entries((details.responseHeaders ?? {}) as HeaderMap)) {
      const lk = k.toLowerCase();
      if (lk === 'content-security-policy' || lk === 'content-security-policy-report-only') continue;
      headers[k] = v;
    }
    headers['Content-Security-Policy'] = [csp];
    headers['X-Content-Type-Options'] = ['nosniff'];
    headers['Cross-Origin-Opener-Policy'] = ['same-origin'];
    callback({ responseHeaders: headers });
  });

  // 2. Permissions: deny everything except a write-only clipboard for the app itself.
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = (details as { requestingUrl?: string } | undefined)?.requestingUrl ?? webContents?.getURL?.();
    callback(ALLOWED_PERMISSIONS.includes(permission) && isAppOrigin(origin, allowedOrigin));
  });
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const origin = (details as { requestingUrl?: string } | undefined)?.requestingUrl ?? requestingOrigin;
    return ALLOWED_PERMISSIONS.includes(permission) && isAppOrigin(origin, allowedOrigin);
  });
  const s = session as Session & { setDevicePermissionHandler?: (h: () => boolean) => void };
  if (typeof s.setDevicePermissionHandler === 'function') s.setDevicePermissionHandler(() => false);

  // 3. Every web contents (windows, devtools, anything else): lock navigation and popups.
  app.on('web-contents-created', (_event: unknown, contents: WebContents) => {
    hardenWebContents(contents, { allowedOrigin, openExternal, extraHosts });
  });
}

export function hardenWebContents(
  contents: WebContents,
  opts: {
    allowedOrigin: string | readonly string[];
    openExternal: (url: string) => Promise<void> | void;
    extraHosts?: readonly string[];
  },
): void {
  const { allowedOrigin, openExternal } = opts;
  const extraHosts = opts.extraHosts ?? [];

  const blockForeign = (event: { preventDefault: () => void; url?: string }, url?: string): void => {
    const target = typeof url === 'string' ? url : event?.url;
    if (!isAppOrigin(target, allowedOrigin)) event.preventDefault();
  };
  contents.on('will-navigate', blockForeign as never);
  contents.on('will-redirect', blockForeign as never);
  contents.on('will-frame-navigate' as never, blockForeign as never);

  // No <webview>, ever (webviewTag:false already; belt and braces).
  contents.on('will-attach-webview', ((event: { preventDefault: () => void }) => event.preventDefault()) as never);

  // window.open / target=_blank: never create a window. Allowlisted https links open in the
  // system browser; everything else is dropped silently.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url, extraHosts)) {
      try {
        void Promise.resolve(openExternal(url)).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
    return { action: 'deny' };
  });
}
