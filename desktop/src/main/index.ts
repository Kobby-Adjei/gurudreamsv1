/**
 * AirBridge Pro — Electron main process entry.
 *
 * Wiring:
 *   single-instance lock + airbridge:// deep links -> OidcClient (Clerk, PKCE)
 *   OidcClient -> LicenseGate -> (only on a valid license) ProcessManager.start()
 *   ProcessManager READY -> ControlClient (HTTP + WS to 127.0.0.1) -> IPC push to the renderer
 *   before-quit -> ProcessManager.stop() (SIGTERM -> 3 s -> kill)
 *
 * Dev mocks (AIRBRIDGE_DEV_MOCKS=1, unpackaged only) replace auth/license/backend with demo data;
 * no daemon is spawned in that mode.
 */
import { app, BrowserWindow, safeStorage, session, shell } from 'electron';
import { join, resolve } from 'node:path';
import type { AirEvent, AuthState, BackendLifecycle, BackendStatus, LicenseStatus } from '../shared/types';
import { OidcClient } from './auth/oidc';
import { createSafeStorageTokenStore } from './auth/tokenStore';
import { ControlClient } from './controlClient';
import { createDevMocks, devMocksEnabled } from './devMocks';
import { registerIpc, type IpcDeps, type IpcHandle } from './ipc';
import { createFileLicenseCache, LicenseGate } from './license/gate';
import { getLicensePublicKeys } from './license/publicKeys';
import { getMcpConfigJson } from './mcpConfig';
import { resolveCoreCommand } from './mcpConfig';
import { licenseGateCallbacks, ProcessManager } from './processManager';
import { appOriginFor, applySecurityPolicies, enableGlobalSandbox, secureWebPreferences } from './security';

const PROTOCOL = 'airbridge';
const QUIT_TIMEOUT_MS = 6000;

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

    let deps: Pick<IpcDeps, 'auth' | 'license' | 'backend'>;
    let afterWindow: () => Promise<void> = async () => undefined;

    if (useMocks) {
      log('dev mocks enabled (AIRBRIDGE_DEV_MOCKS=1): no daemon, no Clerk, no license server');
      const mocks = createDevMocks({
        onEvent: push.event,
        onStatus: push.status,
        onLifecycle: push.lifecycle,
        onAuth: push.auth,
        onLicense: push.license,
      });
      deps = { auth: mocks.auth, license: mocks.license, backend: mocks.backend };
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
  };
}

function createRealServices(o: RealServicesOptions) {
  const userData = app.getPath('userData');
  const openExternal = (url: string) => shell.openExternal(url);

  // --- backend (daemon) -------------------------------------------------------------------
  // AIRBRIDGE_DATA_DIR is deliberately NOT set: the daemon and the MCP stdio process launched by
  // Claude/Cursor must share the same default data dir so the feed shows both origins.
  const pm = new ProcessManager({
    core: () => resolveCoreCommand(o.coreOptions),
    log: (m) => log(`backend: ${m}`),
  });
  const control = new ControlClient({ log: (m) => log(`control: ${m}`) });
  pm.on('lifecycle', o.push.lifecycle);
  pm.on('ready', (conn) => control.connect({ port: conn.port, token: conn.token }));
  pm.on('exit', () => control.disconnect());
  control.on('event', o.push.event);
  control.on('status', o.push.status);

  const backend: IpcDeps['backend'] = {
    getStatus: async () => (control.isConnected() ? control.getStatus() : null),
    getLifecycle: () => pm.getLifecycle(),
    getNodes: async () => (control.isConnected() ? control.getNodes() : null),
    getEvents: async (limit) => (control.isConnected() ? control.getEvents(limit) : []),
    sendTask: async (req) =>
      control.isConnected() ? control.sendTask(req) : { ok: false, error: 'The AirBridge engine is not running.' },
  };

  // --- auth + license ---------------------------------------------------------------------
  const issuer = config('CLERK_OAUTH_ISSUER');
  const clientId = config('CLERK_OAUTH_CLIENT_ID');
  if (!issuer || !clientId || !o.licenseUrl) {
    log('auth/license not configured (CLERK_OAUTH_ISSUER, CLERK_OAUTH_CLIENT_ID, AIRBRIDGE_LICENSE_URL); backend stays blocked');
    const blocked: BackendLifecycle = { phase: 'blocked', detail: 'Sign-in is not configured in this build.' };
    return {
      deps: {
        auth: {
          getState: (): AuthState => ({ state: 'signed_out' }),
          signIn: async () => {
            throw new Error('not_configured');
          },
          signOut: async () => undefined,
        },
        license: {
          getStatus: (): LicenseStatus => ({ state: 'unknown', plan: null, exp: null }),
          refresh: async (): Promise<LicenseStatus> => ({ state: 'unknown', plan: null, exp: null }),
          openCheckout: async () => undefined,
        },
        backend: { ...backend, getLifecycle: () => blocked },
      },
      handleDeepLink: (_url: string) => undefined,
      start: async () => o.push.lifecycle(blocked),
      stop: async () => pm.stop(),
    };
  }

  const oidc = new OidcClient({
    config: { issuer, clientId },
    tokenStore: createSafeStorageTokenStore({ filePath: join(userData, 'session.bin'), safeStorage }),
    openExternal,
    log: (m) => log(`auth: ${m}`),
  });
  const gate = new LicenseGate({
    licenseUrl: o.licenseUrl,
    getAuthToken: () => oidc.getApiToken(),
    getUserId: () => oidc.getUserId(),
    publicKeys: getLicensePublicKeys({ isPackaged: o.isPackaged }),
    isPackaged: o.isPackaged,
    ...licenseGateCallbacks(pm),
    cache: createFileLicenseCache(join(userData, 'license.jwt')),
    openExternal,
    log: (m) => log(`license: ${m}`),
  });
  gate.onChange(o.push.license);

  let lastAuth = oidc.getState().state;
  oidc.onChange((s) => {
    o.push.auth(s);
    if (s.state === lastAuth) return;
    lastAuth = s.state;
    if (s.state === 'signed_in') void gate.check();
    else if (s.state === 'signed_out') void gate.reset();
  });

  return {
    deps: {
      auth: {
        getState: () => oidc.getState(),
        signIn: () => oidc.signIn(),
        signOut: async () => {
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
    } satisfies Pick<IpcDeps, 'auth' | 'license' | 'backend'>,
    handleDeepLink: (url: string) => {
      if (!OidcClient.isCallbackUrl(url)) return;
      void oidc.handleCallback(url).catch((e) => log(`deep link rejected: ${e instanceof Error ? e.message : String(e)}`));
    },
    start: async () => {
      await oidc.restore().catch(() => undefined);
      // gate.start() runs the first check; onValid -> pm.start() is the only spawn path.
      await gate.start();
    },
    stop: async () => {
      gate.dispose();
      control.disconnect();
      await pm.stop();
    },
  };
}
