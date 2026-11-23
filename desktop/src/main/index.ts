/**
 * AirBridge Pro — Electron main process entry.
 *
 * Wiring:
 *   single-instance lock + airbridge:// deep links -> OidcClient (Clerk, PKCE)
 *   Enforced (licenseEnforced(), build flag MAIN_VITE_AIRBRIDGE_ENFORCE_LICENSE=1):
 *     OidcClient -> LicenseGate -> (only on a valid license)
 *       TailscaleManager.start() -> ensureEnrolled() -> ProcessManager.start() (with AIRBRIDGE_TS_* env)
 *   Preview (default, PHASE3_PLAN.md §8): no sign-in required, gate runs in shadow mode;
 *     NetworkSupervisor starts the daemon right away: signed in + license server + enrolled -> embedded,
 *     otherwise AIRBRIDGE_NETWORK=system (the user's own Tailscale; no tailscaled spawned).
 *   ProcessManager READY -> ControlClient (HTTP + WS to [::1]) -> IPC push to the renderer
 *   sign-out / license lost -> stop daemon, `tailscale logout` (sign-out only), stop tailscaled
 *   before-quit -> ProcessManager.stop() then TailscaleManager.stop() (SIGTERM -> 3 s -> kill)
 *
 * Dev mocks (AIRBRIDGE_DEV_MOCKS=1, unpackaged only) replace auth/license/backend with demo data;
 * no daemon is spawned in that mode.
 */
import { app, BrowserWindow, safeStorage, session, shell } from 'electron';
import { join, resolve } from 'node:path';
import type { AirEvent, AuthState, BackendLifecycle, BackendStatus, LicenseStatus, NetStatus } from '../shared/types';
import { OidcClient } from './auth/oidc';
import { createSafeStorageTokenStore } from './auth/tokenStore';
import { ControlClient } from './controlClient';
import { createDevMocks, devMocksEnabled } from './devMocks';
import { registerIpc, type IpcDeps, type IpcHandle } from './ipc';
import { licenseEnforced } from './license/enforcement';
import { createFileLicenseCache, LicenseGate } from './license/gate';
import { getLicensePublicKeys } from './license/publicKeys';
import { getMcpConfigJson } from './mcpConfig';
import { resolveCoreCommand } from './mcpConfig';
import { defaultDataDir } from './network/dataDir';
import { EnrollError, ensureEnrolled } from './network/enroll';
import { TailscaleManager } from './network/TailscaleManager';
import { NetworkSupervisor, ProcessManager } from './processManager';
import { appOriginFor, applySecurityPolicies, enableGlobalSandbox, secureWebPreferences } from './security';

const PROTOCOL = 'airbridge';
const QUIT_TIMEOUT_MS = 8000; // daemon stop (<=3 s) + tailscaled stop (<=3 s) + slack

/** Runtime env first, then build-time MAIN_VITE_* values injected by electron-vite. */
function config(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const buildEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const v = buildEnv?.[`MAIN_VITE_${name}`];
  return v && v.trim() ? v.trim() : undefined;
}

function log(msg: string): void {
  console.error(`[airbridge] ${msg}`);
}

// ------------------------------------------------------------------ pre-ready

enableGlobalSandbox(app);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function registerProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    // `electron .` in development: register with the script path so the OS can relaunch us.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1]!)]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

function findDeepLink(argv: readonly string[]): string | null {
  const hit = argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL}://`));
  return hit && hit.length <= 4096 ? hit : null;
}

function main(): void {
  const isPackaged = app.isPackaged;
  const devServerUrl = !isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const isDev = !isPackaged && !!devServerUrl;
  const useMocks = devMocksEnabled(app);

  let mainWindow: BrowserWindow | null = null;
  let ipc: IpcHandle | null = null;
  let pendingDeepLink: string | null = findDeepLink(process.argv);
  let deepLinkHandler: ((url: string) => void) | null = null;
  let shutdown: (() => Promise<void>) | null = null;

  registerProtocol();

  const onDeepLink = (url: string | null) => {
    if (!url) return;
    if (deepLinkHandler) deepLinkHandler(url);
    else pendingDeepLink = url;
  };

  app.on('second-instance', (_event, argv) => {
    onDeepLink(findDeepLink(argv));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    onDeepLink(url);
  });

  const push = {
    event: (e: AirEvent) => ipc?.push.backendEvent(e),
    status: (s: BackendStatus) => ipc?.push.backendStatus(s),
    lifecycle: (l: BackendLifecycle) => ipc?.push.backendLifecycle(l),
    auth: (s: AuthState) => ipc?.push.authChanged(s),
    license: (s: LicenseStatus) => ipc?.push.licenseChanged(s),
    network: (s: NetStatus) => ipc?.push.networkChanged(s),
  };

  const createWindow = (): BrowserWindow => {
    const win = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: 'AirBridge Pro',
      backgroundColor: '#0b0d12',
      autoHideMenuBar: true,
      webPreferences: {
        ...secureWebPreferences(join(__dirname, '../preload/index.js')),
        additionalArguments: [`--airbridge-app-version=${app.getVersion()}`],
      },
    });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });
    if (isDev && devServerUrl) void win.loadURL(devServerUrl);
    else void win.loadFile(join(__dirname, '../renderer/index.html'));
    return win;
  };

  void app.whenReady().then(async () => {
    const allowedOrigin = appOriginFor({ isDev, devServerUrl, rendererDir: join(__dirname, '../renderer') });
    const licenseUrl = config('AIRBRIDGE_LICENSE_URL');
    let licenseHost: string | null = null;
    try {
      licenseHost = licenseUrl ? new URL(licenseUrl).hostname : null;
    } catch {
      licenseHost = null;
    }
    applySecurityPolicies({
      app,
      session: session.defaultSession,
      isDev,
      allowedOrigin,
      devServerUrl,
      extraExternalHosts: licenseHost ? [licenseHost] : [],
    });

    const coreOptions = {
      isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      python: !isPackaged ? process.env.AIRBRIDGE_PYTHON : undefined,
    };
    const mcpJson: IpcDeps['getMcpConfigJson'] = (client) => getMcpConfigJson(client, coreOptions);

    let deps: Pick<IpcDeps, 'auth' | 'license' | 'backend' | 'network'>;
    let afterWindow: () => Promise<void> = async () => undefined;

    if (useMocks) {
      log('dev mocks enabled (AIRBRIDGE_DEV_MOCKS=1): no daemon, no Clerk, no license server');
      const mocks = createDevMocks({
        onEvent: push.event,
        onStatus: push.status,
        onLifecycle: push.lifecycle,
        onAuth: push.auth,
        onLicense: push.license,
        onNetwork: push.network,
      });
      deps = { auth: mocks.auth, license: mocks.license, backend: mocks.backend, network: mocks.network };
      afterWindow = async () => mocks.start();
      shutdown = async () => mocks.stop();
    } else {
      const real = createRealServices({ licenseUrl, isPackaged, coreOptions, push });
      deps = real.deps;
      deepLinkHandler = real.handleDeepLink;
      afterWindow = real.start;
      shutdown = real.stop;
    }

    ipc = registerIpc({
      allowedOrigin,
      ...deps,
      getMcpConfigJson: mcpJson,
      getWebContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
      log: (m) => log(`ipc: ${m}`),
    });

    mainWindow = createWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      void afterWindow().catch((e) => log(`startup failed: ${e instanceof Error ? e.message : String(e)}`));
    });
    if (pendingDeepLink && deepLinkHandler) {
      const url = pendingDeepLink;
      pendingDeepLink = null;
      deepLinkHandler(url);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Stop the daemon before quitting (it would also exit on its own via AIRBRIDGE_PARENT_PID).
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting || !shutdown) return;
    event.preventDefault();
    quitting = true;
    const done = shutdown().catch((e) => log(`shutdown error: ${e instanceof Error ? e.message : String(e)}`));
    const timeout = new Promise<void>((r) => setTimeout(r, QUIT_TIMEOUT_MS));
    void Promise.race([done, timeout]).finally(() => {
      ipc?.dispose();
      app.quit();
    });
  });
}

// ------------------------------------------------------------------ real services

interface RealServicesOptions {
  licenseUrl: string | undefined;
  isPackaged: boolean;
  coreOptions: Parameters<typeof resolveCoreCommand>[0];
  push: {
    event(e: AirEvent): void;
    status(s: BackendStatus): void;
    lifecycle(l: BackendLifecycle): void;
    auth(s: AuthState): void;
    license(s: LicenseStatus): void;
    network(s: NetStatus): void;
  };
}

/** Bundled tailscaled/tailscale for this platform (electron-builder extraResources). */
function tailscaleBinDir(o: Parameters<typeof resolveCoreCommand>[0]): string {
  const dir = `${process.platform}-${process.arch}`;
  return o.isPackaged ? join(o.resourcesPath, 'tailscale', dir) : join(o.appPath, 'resources', 'tailscale', dir);
}

function createRealServices(o: RealServicesOptions) {
  const userData = app.getPath('userData');
  const openExternal = (url: string) => shell.openExternal(url);
  const enforced = licenseEnforced();
  log(enforced ? 'license enforcement: on' : 'license enforcement: off (preview; PHASE3_PLAN.md §8)');

  // --- private network (bundled userspace tailscaled) ----------------------------------------
  // AIRBRIDGE_DATA_DIR is deliberately NOT set on the daemon: it and the MCP stdio process launched by
  // Claude/Cursor must share the same default data dir so the feed shows both origins.
  const dataDir = defaultDataDir();
  const tm = new TailscaleManager({
    binDir: tailscaleBinDir(o.coreOptions),
    dataDir,
    log: (m) => log(`network: ${m}`),
  });

  // --- auth (optional in preview) ----------------------------------------------------------
  const issuer = config('CLERK_OAUTH_ISSUER');
  const clientId = config('CLERK_OAUTH_CLIENT_ID');
  const authConfigured = !!issuer && !!clientId;
  const oidc = authConfigured
    ? new OidcClient({
        config: { issuer: issuer!, clientId: clientId! },
        tokenStore: createSafeStorageTokenStore({ filePath: join(userData, 'session.bin'), safeStorage }),
        openExternal,
        log: (m) => log(`auth: ${m}`),
      })
    : null;

  // ensureEnrolled has no lock of its own: serialize startup vs. retry. Resolves true when enrolled.
  let enrolling: Promise<boolean> | null = null;
  const enroll = (): Promise<boolean> => {
    if (!oidc || !o.licenseUrl) return Promise.resolve(false);
    const licenseUrl = o.licenseUrl;
    enrolling ??= ensureEnrolled({
      tm,
      getAuthToken: () => oidc.getApiToken(),
      getUserSub: () => oidc.getUserId(),
      licenseUrl,
      dataDir,
      log: (m) => log(`network: ${m}`),
    })
      .then((outcome) => outcome !== 'signed_out')
      .catch((e: unknown) => {
        // Only the fixed code: never the message of anything that touched the key.
        log(`network: enrollment failed: ${e instanceof EnrollError ? e.code : 'unexpected'}`);
        return false;
      })
      .finally(() => {
        enrolling = null;
      });
    return enrolling;
  };

  const net = new NetworkSupervisor({
    tm,
    enforced,
    canEmbed: () => !!oidc && !!o.licenseUrl && oidc.getState().state === 'signed_in',
    enroll,
    onNetwork: o.push.network,
    log: (m) => log(m),
  });

  // --- backend (daemon) -------------------------------------------------------------------
  const pm = new ProcessManager({
    core: () => resolveCoreCommand(o.coreOptions),
    extraEnv: () => net.daemonEnv(),
    log: (m) => log(`backend: ${m}`),
  });
  net.attach(pm);
  const control = new ControlClient({ log: (m) => log(`control: ${m}`) });
  pm.on('lifecycle', o.push.lifecycle);
  pm.on('ready', (conn) =>
    control.connect({ port: conn.port, token: conn.token, ...(conn.host ? { host: conn.host } : {}) }),
  );
  pm.on('exit', () => control.disconnect());
  control.on('event', o.push.event);
  control.on('status', (s) => {
    o.push.status(s);
    net.onBackendStatus(s);
  });

  const backend: IpcDeps['backend'] = {
    getStatus: async () => (control.isConnected() ? control.getStatus() : null),
    getLifecycle: () => pm.getLifecycle(),
    getNodes: async () => (control.isConnected() ? control.getNodes() : null),
    getEvents: async (limit) => (control.isConnected() ? control.getEvents(limit) : []),
    sendTask: async (req) =>
      control.isConnected() ? control.sendTask(req) : { ok: false, error: 'The AirBridge engine is not running.' },
  };
  const fetchBackendStatus = async () => (control.isConnected() ? control.getStatus() : null);
  const stopAll = async () => {
    control.disconnect();
    await net.stop();
  };

  const missing = !authConfigured || !o.licenseUrl;
  if (missing && enforced) {
    log('auth/license not configured (CLERK_OAUTH_ISSUER, CLERK_OAUTH_CLIENT_ID, AIRBRIDGE_LICENSE_URL); backend stays blocked');
    const blocked: BackendLifecycle = { phase: 'blocked', detail: 'Sign-in is not configured in this build.' };
    return {
      deps: {
        auth: notConfiguredAuth(),
        license: notConfiguredLicense(enforced),
        backend: { ...backend, getLifecycle: () => blocked },
      },
      handleDeepLink: (_url: string) => undefined,
      start: async () => o.push.lifecycle(blocked),
      stop: stopAll,
    };
  }

  let entitled = (): boolean => false; // enforced retry: restart the daemon only while licensed
  const network: IpcDeps['network'] = {
    getStatus: () => net.status(fetchBackendStatus),
    retry: () => net.retry(() => entitled()),
  };

  if (!oidc || !o.licenseUrl) {
    // Preview without sign-in configured: the backend runs on this computer's Tailscale.
    log('auth/license not configured: preview runs on this computer\'s Tailscale (AIRBRIDGE_NETWORK=system)');
    return {
      deps: { auth: notConfiguredAuth(), license: notConfiguredLicense(enforced), backend, network },
      handleDeepLink: (_url: string) => undefined,
      start: () => net.start(),
      stop: stopAll,
    };
  }

  const gate = new LicenseGate({
    licenseUrl: o.licenseUrl,
    getAuthToken: () => oidc.getApiToken(),
    getUserId: () => oidc.getUserId(),
    publicKeys: getLicensePublicKeys({ isPackaged: o.isPackaged }),
    isPackaged: o.isPackaged,
    enforce: enforced,
    // Enforced startup order (PHASE3_PLAN.md §2): license valid -> tailscaled -> enrollment -> daemon.
    // Preview: verdicts are logged only; the supervisor ignores them.
    onValid: () => net.licenseValid(),
    onInvalid: (reason: string) => net.licenseInvalid(reason),
    cache: createFileLicenseCache(join(userData, 'license.jwt')),
    openExternal,
    log: (m) => log(`license: ${m}`),
  });
  gate.onChange(o.push.license);
  entitled = () => gate.getStatus().state === 'valid' || gate.getStatus().state === 'grace';

  let lastAuth = oidc.getState().state;
  oidc.onChange((s) => {
    o.push.auth(s);
    if (s.state === lastAuth) return;
    lastAuth = s.state;
    if (s.state === 'signed_in') {
      void gate.check();
      void net.signedIn();
    } else if (s.state === 'signed_out') void net.signedOut().finally(() => void gate.reset());
  });

  return {
    deps: {
      auth: {
        getState: () => oidc.getState(),
        signIn: () => oidc.signIn(),
        signOut: async () => {
          await net.signedOut();
          await oidc.signOut();
          await gate.reset();
        },
      },
      license: {
        getStatus: () => gate.getStatus(),
        refresh: () => gate.check(),
        openCheckout: () => gate.openCheckout(),
      },
      backend,
      network,
    } satisfies Pick<IpcDeps, 'auth' | 'license' | 'backend' | 'network'>,
    handleDeepLink: (url: string) => {
      if (!OidcClient.isCallbackUrl(url)) return;
      void oidc.handleCallback(url).catch((e) => log(`deep link rejected: ${e instanceof Error ? e.message : String(e)}`));
    },
    start: async () => {
      await oidc.restore().catch(() => undefined);
      // Preview: the backend starts right away (embedded if signed in + enrolled, else system Tailscale).
      const preview = net.start();
      // Enforced: gate.start() runs the first check; onValid -> pm.start() is the only spawn path.
      await gate.start();
      await preview;
    },
    stop: async () => {
      gate.dispose();
      await stopAll();
    },
  };
}

function notConfiguredAuth(): IpcDeps['auth'] {
  return {
    getState: (): AuthState => ({ state: 'signed_out' }),
    signIn: async () => {
      throw new Error('not_configured');
    },
    signOut: async () => undefined,
  };
}

function notConfiguredLicense(enforced: boolean): IpcDeps['license'] {
  const unknown = (): LicenseStatus => ({ state: 'unknown', plan: null, exp: null, enforced });
  return {
    getStatus: unknown,
    refresh: async () => unknown(),
    openCheckout: async () => undefined,
  };
}
