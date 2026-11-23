/**
 * Preview mode (PHASE3_PLAN.md §8) with the airbridge-net sidecar (§9): license wired but not enforced,
 * and the app path NEVER uses a system Tailscale (signed out -> needs_login, no backend network).
 * Wiring mirrors src/main/index.ts createRealServices: LicenseGate -> NetworkSupervisor -> ProcessManager.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetStatus } from '../src/shared/types';
import { createMemoryLicenseCache, LicenseGate } from '../src/main/license/gate';
import { NetworkSupervisor, ProcessManager, type NetworkSupervisorNm } from '../src/main/processManager';

class FakeChild extends EventEmitter {
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(public pid: number) {
    super();
  }
  kill(sig?: string): boolean {
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = (sig ?? 'SIGTERM') as NodeJS.Signals;
      this.emit('exit', null, this.signalCode);
    }
    return true;
  }
}

/** Daemon spawn double: every child reports READY on the next tick. */
function daemonSpawn() {
  const envs: NodeJS.ProcessEnv[] = [];
  let pid = 2000;
  const spawn = vi.fn((_cmd: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    const child = new FakeChild(++pid);
    envs.push(options.env ?? {});
    setImmediate(() => child.stderr.write(`AIRBRIDGE_READY {"control_port":5${pid},"pid":${child.pid}}\n`));
    return child as never;
  });
  return { spawn, envs };
}

const NET_TOKEN = 'sidecar-control-token-0123456789abcdefghijk';

/** In-memory NetManager double (the airbridge-net sidecar). */
function fakeNm() {
  let running = false;
  let port = 41000;
  const em = new EventEmitter();
  const nm = Object.assign(em, {
    start: vi.fn(async () => {
      running = true;
    }),
    stop: vi.fn(async () => {
      running = false;
    }),
    logout: vi.fn(async () => undefined),
    wipeState: vi.fn(async () => undefined),
    isRunning: () => running,
    status: vi.fn(async (): Promise<NetStatus> => ({ state: running ? 'connected' : 'stopped', ...(running ? { ip: '100.64.0.7' } : {}) })),
    lastStatus: (): NetStatus => ({ state: running ? 'connected' : 'stopped' }),
    daemonEnv: () =>
      running ? { AIRBRIDGE_NETWORK: 'sidecar', AIRBRIDGE_NET_URL: `http://[::1]:${port}`, AIRBRIDGE_NET_TOKEN: NET_TOKEN } : null,
    /** Simulate a crash-restart: new control port, status event. */
    restartWithNewPort() {
      port += 1;
      em.emit('status', { state: 'connected', ip: '100.64.0.7' });
    },
  });
  return nm as typeof nm & NetworkSupervisorNm;
}

const stopList: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stopList.splice(0)) await s();
});

interface WireOpts {
  enforced: boolean;
  nm: ReturnType<typeof fakeNm>;
  signedIn?: () => boolean;
  licenseUrl?: string | null;
  enroll?: () => Promise<boolean>;
}

/** Same wiring as index.ts (gate callbacks -> supervisor; supervisor.daemonEnv -> pm.extraEnv). */
function wire(o: WireOpts) {
  const { spawn, envs } = daemonSpawn();
  const network: NetStatus[] = [];
  const signedIn = o.signedIn ?? (() => false);
  const licenseUrl = o.licenseUrl === undefined ? 'https://license.example.com' : o.licenseUrl;
  // index.ts: enroll = ensureEnrolled, which spawns the sidecar (nm.start) when it succeeds.
  const enroll = o.enroll ?? (async () => false);
  const net = new NetworkSupervisor({
    nm: o.nm,
    enforced: o.enforced,
    canEnroll: () => !!licenseUrl && signedIn(),
    enroll: async () => {
      const ok = await enroll();
      if (ok) await o.nm.start({ controlUrl: 'https://hs.example.com', hostname: 'airbridge-a1' });
      return ok;
    },
    onNetwork: (s) => network.push(s),
    log: () => undefined,
  });
  const pm = new ProcessManager({
    core: { command: '/app/airbridge-core', args: [] },
    env: { PATH: '/usr/bin', AIRBRIDGE_NETWORK: 'system', AIRBRIDGE_NET_URL: 'http://127.0.0.1:1', AIRBRIDGE_TS_SOCKET: '/stale' },
    extraEnv: () => net.daemonEnv(),
    spawn: spawn as never,
    platform: 'linux',
    stopTimeoutMs: 50,
    log: () => undefined,
  });
  net.attach(pm);
  const gate = licenseUrl
    ? new LicenseGate({
        enforce: o.enforced,
        licenseUrl,
        getAuthToken: async () => (signedIn() ? 'clerk-jwt' : null),
        getUserId: () => (signedIn() ? 'user_1' : null),
        publicKeys: {},
        isPackaged: false,
        onValid: () => net.licenseValid(),
        onInvalid: (r) => net.licenseInvalid(r),
        cache: createMemoryLicenseCache(),
        fetch: vi.fn(async () => new Response('{}', { status: 402 })) as never,
        log: () => undefined,
      })
    : null;
  stopList.push(async () => {
    gate?.dispose();
    await net.stop();
  });
  /** index.ts start(): preview supervisor start + gate start. */
  const start = async () => {
    const preview = net.start();
    await gate?.start();
    await preview;
  };
  return { net, pm, gate, spawn, envs, network, start };
}

const SIGNED_OUT = { state: 'needs_login', mode: 'embedded' };

describe('preview (licenseEnforced() === false)', () => {
  it('signed out: backend starts with NO network (never system Tailscale), status needs_login', async () => {
    const nm = fakeNm();
    const enroll = vi.fn(async () => true);
    const w = wire({ enforced: false, nm, enroll });

    await w.start();

    expect(w.spawn).toHaveBeenCalledTimes(1);
    expect(w.pm.getLifecycle().phase).toBe('running');
    expect(w.envs[0]!.AIRBRIDGE_NETWORK).toBe('sidecar'); // no system fallback in the app path
    expect(w.envs[0]!.AIRBRIDGE_NET_URL).toBeUndefined(); // stale app env scrubbed
    expect(w.envs[0]!.AIRBRIDGE_NET_TOKEN).toBeUndefined();
    expect(w.envs[0]!.AIRBRIDGE_TS_SOCKET).toBeUndefined();
    expect(nm.start).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
    expect(await w.net.status()).toEqual(SIGNED_OUT);
    expect(w.network.at(-1)).toEqual(SIGNED_OUT);
    expect(JSON.stringify(w.network)).not.toContain('system');
    // gate ran in shadow mode: verdict reported, nothing blocked
    expect(w.gate!.getStatus()).toMatchObject({ state: 'unknown', enforced: false });
  });

  it('no sign-in / license server configured at all: backend starts, network needs_login', async () => {
    const nm = fakeNm();
    const w = wire({ enforced: false, nm, licenseUrl: null });
    await w.start();
    expect(w.pm.getLifecycle().phase).toBe('running');
    expect(w.envs[0]!.AIRBRIDGE_NETWORK).toBe('sidecar');
    expect(nm.start).not.toHaveBeenCalled();
    expect(await w.net.status()).toEqual(SIGNED_OUT);
  });

  it('a would-block verdict (402 while signed in) never stops the backend', async () => {
    const nm = fakeNm();
    const w = wire({ enforced: false, nm, signedIn: () => true, enroll: async () => false });
    await w.start();
    await w.gate!.check();
    expect(w.gate!.getStatus()).toMatchObject({ state: 'inactive', enforced: false });
    expect(w.pm.getLifecycle().phase).toBe('running');
    await w.net.licenseInvalid('inactive');
    expect(w.pm.getLifecycle().phase).toBe('running');
  });

  it('signed in + enrollment succeeds: daemon gets the sidecar endpoint', async () => {
    const nm = fakeNm();
    const w = wire({ enforced: false, nm, signedIn: () => true, enroll: async () => true });
    await w.start();
    expect(nm.start).toHaveBeenCalled();
    expect(w.spawn).toHaveBeenCalledTimes(1);
    expect(w.envs[0]).toMatchObject({ AIRBRIDGE_NETWORK: 'sidecar', AIRBRIDGE_NET_URL: 'http://[::1]:41000', AIRBRIDGE_NET_TOKEN: NET_TOKEN });
    expect(await w.net.status()).toEqual({ state: 'connected', ip: '100.64.0.7', mode: 'embedded' });
  });

  it('signed in but enrollment fails: daemon runs without a network, status is the sidecar\'s (never system)', async () => {
    const nm = fakeNm();
    const w = wire({ enforced: false, nm, signedIn: () => true, enroll: async () => false });
    await w.start();
    expect(w.envs[0]!.AIRBRIDGE_NETWORK).toBe('sidecar');
    expect(w.envs[0]!.AIRBRIDGE_NET_URL).toBeUndefined();
    expect((await w.net.status()).mode).toBe('embedded');
  });

  it('later sign-in respawns the daemon with the sidecar endpoint; sign-out logs out, wipes, and drops it', async () => {
    const nm = fakeNm();
    let signed = false;
    const w = wire({ enforced: false, nm, signedIn: () => signed, enroll: async () => true });
    await w.start();
    expect(w.envs.map((e) => e.AIRBRIDGE_NET_URL)).toEqual([undefined]);

    signed = true;
    await w.net.signedIn();
    expect(w.pm.getLifecycle().phase).toBe('running');
    expect(w.envs.map((e) => e.AIRBRIDGE_NET_URL)).toEqual([undefined, 'http://[::1]:41000']);

    signed = false;
    await w.net.signedOut();
    await w.gate!.reset(); // index.ts order; shadow gate re-fires onValid -> supervisor ignores it (idempotent)
    expect(nm.logout).toHaveBeenCalled();
    expect(nm.stop).toHaveBeenCalled();
    expect(nm.wipeState).toHaveBeenCalled();
    expect(w.pm.getLifecycle().phase).toBe('running');
    expect(w.envs.map((e) => e.AIRBRIDGE_NET_URL)).toEqual([undefined, 'http://[::1]:41000', undefined]);
    expect(w.network.at(-1)).toEqual(SIGNED_OUT);
  });

  it('a sidecar restarted with a new endpoint respawns the daemon with it', async () => {
    const nm = fakeNm();
    const w = wire({ enforced: false, nm, signedIn: () => true, enroll: async () => true });
    await w.start();
    nm.restartWithNewPort();
    await vi.waitFor(() => expect(w.envs.length).toBe(2));
    await vi.waitFor(() => expect(w.pm.getLifecycle().phase).toBe('running'));
    expect(w.envs[1]!.AIRBRIDGE_NET_URL).toBe('http://[::1]:41001');
    expect(w.network.at(-1)).toMatchObject({ mode: 'embedded' });
  });
});

describe('enforced (licenseEnforced() === true)', () => {
  it('signed out: backend is never started', async () => {
    const nm = fakeNm();
    const w = wire({ enforced: true, nm });
    await w.start();
    expect(w.spawn).not.toHaveBeenCalled();
    expect(nm.start).not.toHaveBeenCalled();
    expect(w.pm.getLifecycle().phase).toBe('blocked');
    expect(w.gate!.getStatus()).toMatchObject({ state: 'inactive', enforced: true });
  });

  it('inactive license (402) while signed in: backend is never started', async () => {
    const nm = fakeNm();
    const w = wire({ enforced: true, nm, signedIn: () => true, enroll: async () => true });
    await w.start();
    await w.net.signedIn(); // no-op when enforced: the gate drives start
    expect(w.spawn).not.toHaveBeenCalled();
    expect(w.pm.getLifecycle().phase).toBe('blocked');
  });

  it('valid license: enrollment (sidecar) -> daemon with the sidecar endpoint', async () => {
    const nm = fakeNm();
    const enroll = vi.fn(async () => true);
    const w = wire({ enforced: true, nm, signedIn: () => true, enroll });
    await w.net.licenseValid();
    expect(enroll).toHaveBeenCalled();
    expect(w.envs[0]).toMatchObject({ AIRBRIDGE_NETWORK: 'sidecar', AIRBRIDGE_NET_TOKEN: NET_TOKEN });
  });
});
