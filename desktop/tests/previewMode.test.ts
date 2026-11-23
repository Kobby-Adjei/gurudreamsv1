/**
 * Preview mode (PHASE3_PLAN.md §8): license wired but not enforced.
 * Wiring mirrors src/main/index.ts createRealServices: LicenseGate -> NetworkSupervisor -> ProcessManager.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetStatus } from '../src/shared/types';
import { createMemoryLicenseCache, LicenseGate } from '../src/main/license/gate';
import { TailscaleManager } from '../src/main/network/TailscaleManager';
import { NetworkSupervisor, ProcessManager, type NetworkSupervisorTm } from '../src/main/processManager';

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

/** In-memory TailscaleManager double (embedded network). */
function fakeTm() {
  let running = false;
  const em = new EventEmitter();
  const tm = Object.assign(em, {
    start: vi.fn(async () => {
      running = true;
    }),
    stop: vi.fn(async () => {
      running = false;
    }),
    logout: vi.fn(async () => undefined),
    status: vi.fn(async (): Promise<NetStatus> => ({ state: running ? 'connected' : 'stopped' })),
    lastStatus: (): NetStatus => ({ state: running ? 'connected' : 'stopped' }),
    daemonEnv: () =>
      running
        ? { AIRBRIDGE_NETWORK: 'embedded', AIRBRIDGE_TS_SOCKET: '/d/tailscaled.sock', AIRBRIDGE_TS_SOCKS5: '[::1]:41641' }
        : null,
  });
  return tm as typeof tm & NetworkSupervisorTm;
}

const stopList: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stopList.splice(0)) await s();
});

interface WireOpts {
  enforced: boolean;
  tm: NetworkSupervisorTm;
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
  const net = new NetworkSupervisor({
    tm: o.tm,
    enforced: o.enforced,
    canEmbed: () => !!licenseUrl && signedIn(),
    enroll: o.enroll ?? (async () => false),
    onNetwork: (s) => network.push(s),
    log: () => undefined,
  });
  const pm = new ProcessManager({
    core: { command: '/app/airbridge-core', args: [] },
    env: { PATH: '/usr/bin', AIRBRIDGE_NETWORK: 'embedded', AIRBRIDGE_TS_SOCKET: '/stale' },
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

describe('preview (licenseEnforced() === false)', () => {
  it('signed out: backend starts with AIRBRIDGE_NETWORK=system and tailscaled is never spawned', async () => {
    const tsSpawn = vi.fn();
    const tm = new TailscaleManager({ binDir: '/nonexistent', dataDir: '/nonexistent-d', spawn: tsSpawn as never, log: () => undefined });
    const tmStart = vi.spyOn(tm, 'start');
    const enroll = vi.fn(async () => true);
    const w = wire({ enforced: false, tm, enroll });

    await w.start();

    expect(w.spawn).toHaveBeenCalledTimes(1);
    expect(w.pm.getLifecycle().phase).toBe('running');
    expect(w.envs[0]!.AIRBRIDGE_NETWORK).toBe('system');
    expect(w.envs[0]!.AIRBRIDGE_TS_SOCKET).toBeUndefined(); // stale app env scrubbed
    expect(w.envs[0]!.AIRBRIDGE_TS_SOCKS5).toBeUndefined();
    expect(tsSpawn).not.toHaveBeenCalled();
    expect(tmStart).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
    expect(w.net.currentNetwork()).toBe('system');
    // gate ran in shadow mode: verdict reported, nothing blocked
    expect(w.gate!.getStatus()).toMatchObject({ state: 'unknown', enforced: false });
  });

  it('no sign-in / license server configured at all: backend still starts on the system network', async () => {
    const tm = fakeTm();
    const w = wire({ enforced: false, tm, licenseUrl: null });
    await w.start();
    expect(w.pm.getLifecycle().phase).toBe('running');
    expect(w.envs[0]!.AIRBRIDGE_NETWORK).toBe('system');
    expect(tm.start).not.toHaveBeenCalled();
  });

  it('a would-block verdict (402 while signed in) never stops the backend', async () => {
    const tm = fakeTm();
    const w = wire({ enforced: false, tm, signedIn: () => true, enroll: async () => false });
    await w.start();
    await w.gate!.check();
    expect(w.gate!.getStatus()).toMatchObject({ state: 'inactive', enforced: false });
    expect(w.pm.getLifecycle().phase).toBe('running');
    await w.net.licenseInvalid('inactive');
    expect(w.pm.getLifecycle().phase).toBe('running');
  });

  it('signed in + enrollment succeeds: embedded network env', async () => {
    const tm = fakeTm();
    const w = wire({ enforced: false, tm, signedIn: () => true, enroll: async () => true });
    await w.start();
    expect(tm.start).toHaveBeenCalled();
    expect(w.spawn).toHaveBeenCalledTimes(1);
    expect(w.envs[0]).toMatchObject({ AIRBRIDGE_NETWORK: 'embedded', AIRBRIDGE_TS_SOCKET: '/d/tailscaled.sock' });
  });

  it('signed in but enrollment fails: tailscaled stopped, system network', async () => {
    const tm = fakeTm();
    const w = wire({ enforced: false, tm, signedIn: () => true, enroll: async () => false });
    await w.start();
    expect(tm.start).toHaveBeenCalled();
    expect(tm.stop).toHaveBeenCalled();
    expect(w.envs[0]!.AIRBRIDGE_NETWORK).toBe('system');
  });

  it('later sign-in switches the running daemon to embedded; sign-out switches back to system', async () => {
    const tm = fakeTm();
    let signed = false;
    const w = wire({ enforced: false, tm, signedIn: () => signed, enroll: async () => true });
    await w.start();
    expect(w.envs.map((e) => e.AIRBRIDGE_NETWORK)).toEqual(['system']);

    signed = true;
    await w.net.signedIn();
    expect(w.pm.getLifecycle().phase).toBe('running');
    expect(w.envs.map((e) => e.AIRBRIDGE_NETWORK)).toEqual(['system', 'embedded']);
    expect(w.envs[1]!.AIRBRIDGE_TS_SOCKS5).toBe('[::1]:41641');

    signed = false;
    await w.net.signedOut();
    expect(tm.logout).toHaveBeenCalled();
    expect(w.pm.getLifecycle().phase).toBe('running');
    expect(w.envs.map((e) => e.AIRBRIDGE_NETWORK)).toEqual(['system', 'embedded', 'system']);
  });

  it('system network status follows the daemon /status (connected / error)', async () => {
    const tm = fakeTm();
    const w = wire({ enforced: false, tm });
    await w.start();
    w.net.onBackendStatus({
      version: '1',
      mode: 'daemon',
      tailnet_ip: null,
      inbox: { listening: false, port: 8989, degraded_reason: 'Could not run the Tailscale CLI (tailscale): ENOENT' },
      uptime_s: 1,
    });
    expect(w.network.at(-1)!.state).toBe('error');
    expect((await w.net.status()).state).toBe('error');
    w.net.onBackendStatus({
      version: '1',
      mode: 'daemon',
      tailnet_ip: '100.64.0.7',
      inbox: { listening: true, port: 8989, degraded_reason: null },
      uptime_s: 2,
    });
    expect(w.network.at(-1)).toEqual({ state: 'connected', ip: '100.64.0.7' });
  });
});

describe('enforced (licenseEnforced() === true): unchanged Phase-3 behaviour', () => {
  it('signed out: backend is never started', async () => {
    const tm = fakeTm();
    const w = wire({ enforced: true, tm });
    await w.start();
    expect(w.spawn).not.toHaveBeenCalled();
    expect(tm.start).not.toHaveBeenCalled();
    expect(w.pm.getLifecycle().phase).toBe('blocked');
    expect(w.gate!.getStatus()).toMatchObject({ state: 'inactive', enforced: true });
  });

  it('inactive license (402) while signed in: backend is never started', async () => {
    const tm = fakeTm();
    const w = wire({ enforced: true, tm, signedIn: () => true, enroll: async () => true });
    await w.start();
    await w.net.signedIn(); // no-op when enforced: the gate drives start
    expect(w.spawn).not.toHaveBeenCalled();
    expect(w.pm.getLifecycle().phase).toBe('blocked');
  });

  it('valid license: tailscaled -> enrollment -> daemon on the embedded network', async () => {
    const tm = fakeTm();
    const enroll = vi.fn(async () => true);
    const w = wire({ enforced: true, tm, enroll });
    await w.net.licenseValid();
    expect(tm.start).toHaveBeenCalled();
    expect(enroll).toHaveBeenCalled();
    expect(w.envs[0]).toMatchObject({ AIRBRIDGE_NETWORK: 'embedded' });
  });
});
