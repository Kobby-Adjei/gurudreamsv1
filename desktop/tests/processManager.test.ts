import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProcessManager,
  daemonCwd,
  defaultBackoffMs,
  generateControlToken,
  licenseGateCallbacks,
  parseReadyLine,
} from '../src/main/processManager';
import { LicenseGate, createMemoryLicenseCache } from '../src/main/license/gate';

// ------------------------------------------------------------------ fake child_process

class FakeChild extends EventEmitter {
  stderr = new PassThrough();
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: Array<string | undefined> = [];
  /** When true, SIGTERM makes the child exit; otherwise only SIGKILL does. */
  exitsOnTerm = true;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(sig?: string): boolean {
    this.killed.push(sig);
    if (sig === 'SIGKILL' || this.exitsOnTerm || sig === undefined) this.exit(null, (sig ?? 'SIGTERM') as NodeJS.Signals);
    return true;
  }
  ready(port = 50123): void {
    this.stderr.write(`some log line\nAIRBRIDGE_READY {"control_port":${port},"pid":${this.pid}}\n`);
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
  child: FakeChild;
}

function makeSpawn() {
  const calls: SpawnCall[] = [];
  let pid = 1000;
  const spawn = vi.fn((command: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = new FakeChild(++pid);
    calls.push({ command, args, options, child });
    return child as never;
  });
  return { spawn, calls };
}

const TOKEN = 'A'.repeat(43);
const flush = () => new Promise((r) => setImmediate(r));

function makePm(extra: Partial<ConstructorParameters<typeof ProcessManager>[0]> = {}) {
  const { spawn, calls } = makeSpawn();
  const pm = new ProcessManager({
    core: { command: '/app/resources/bin/linux-x64/airbridge-core', args: [] },
    env: { PATH: '/usr/bin', HOME: '/home/u' },
    dataDir: '/data',
    spawn: spawn as never,
    platform: 'linux',
    parentPid: 4242,
    generateToken: () => TOKEN,
    backoffMs: () => 10,
    stopTimeoutMs: 50,
    log: () => undefined,
    ...extra,
  });
  return { pm, spawn, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------------ helpers

describe('helpers', () => {
  it('generates 32-byte base64url tokens', () => {
    const t = generateControlToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(generateControlToken()).not.toBe(t);
  });

  it('parses only valid READY lines', () => {
    expect(parseReadyLine('AIRBRIDGE_READY {"control_port":5000,"pid":12}')).toEqual({ port: 5000, pid: 12 });
    expect(parseReadyLine('AIRBRIDGE_READY {"control_port":0,"pid":12}')).toBeNull();
    expect(parseReadyLine('AIRBRIDGE_READY {"control_port":"5000","pid":12}')).toBeNull();
    expect(parseReadyLine('AIRBRIDGE_READY nope')).toBeNull();
    expect(parseReadyLine('xAIRBRIDGE_READY {"control_port":5000,"pid":12}')).toBeNull();
  });

  it('backoff grows and is capped', () => {
    expect([1, 2, 3, 4, 5].map(defaultBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(defaultBackoffMs(20)).toBe(30000);
  });

  it('daemon cwd is the binary dir (or main.py dir), never the inherited cwd', () => {
    expect(daemonCwd({ command: '/opt/app/bin/airbridge-core', args: [] })).toBe('/opt/app/bin');
    expect(daemonCwd({ command: 'python3', args: ['/repo/airbridge/main.py'] })).toBe('/repo/airbridge');
    expect(daemonCwd({ command: 'python3', args: [] }, '/data')).toBe('/data');
  });
});

// ------------------------------------------------------------------ spawning

describe('ProcessManager', () => {
  it('does not spawn until start() is called', async () => {
    const { pm, spawn } = makePm();
    await flush();
    expect(spawn).not.toHaveBeenCalled();
    expect(pm.getLifecycle()).toEqual({ phase: 'stopped' });
    expect(pm.getConnection()).toBeNull();
  });

  it('spawns --daemon with the token in env only, hidden window, stderr piped, explicit cwd', async () => {
    const { pm, calls } = makePm();
    const lifecycles: string[] = [];
    pm.on('lifecycle', (l) => lifecycles.push(l.phase));
    const started = pm.start();
    expect(calls).toHaveLength(1);
    const { command, args, options, child } = calls[0];
    expect(command).toBe('/app/resources/bin/linux-x64/airbridge-core');
    expect(args).toEqual(['--daemon']);
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(command).not.toContain(TOKEN);
    const env = options.env as Record<string, string>;
    expect(env.AIRBRIDGE_CONTROL_TOKEN).toBe(TOKEN);
    expect(env.AIRBRIDGE_CONTROL_PORT).toBe('0');
    expect(env.AIRBRIDGE_PARENT_PID).toBe('4242');
    expect(env.AIRBRIDGE_DATA_DIR).toBe('/data');
    expect(env.PATH).toBe('/usr/bin');
    expect(options.windowsHide).toBe(true);
    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(options.cwd).toBe('/app/resources/bin/linux-x64');

    child.ready(50123);
    await expect(started).resolves.toBe(true);
    expect(pm.getLifecycle()).toEqual({ phase: 'running' });
    expect(pm.getConnection()).toEqual({ port: 50123, pid: child.pid, token: TOKEN });
    expect(lifecycles).toEqual(['starting', 'running']);
  });

  it('start() is idempotent while running', async () => {
    const { pm, calls } = makePm();
    const p = pm.start();
    calls[0].child.ready();
    await p;
    await expect(pm.start()).resolves.toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('dev fallback runs python main.py --daemon', async () => {
    const { pm, calls } = makePm({ core: { command: 'python3', args: ['/repo/airbridge/main.py'] } });
    void pm.start();
    expect(calls[0].command).toBe('python3');
    expect(calls[0].args).toEqual(['/repo/airbridge/main.py', '--daemon']);
    expect(calls[0].options.cwd).toBe('/repo/airbridge');
    await pm.stop();
  });

  it('stop(): SIGTERM, phase stopped, no restart', async () => {
    const { pm, calls } = makePm();
    const p = pm.start();
    calls[0].child.ready();
    await p;
    await pm.stop();
    expect(calls[0].child.killed).toEqual(['SIGTERM']);
    expect(pm.getLifecycle().phase).toBe('stopped');
    expect(pm.getConnection()).toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toHaveLength(1);
  });

  it('stop(): escalates to SIGKILL after the timeout', async () => {
    const { pm, calls } = makePm();
    const p = pm.start();
    calls[0].child.exitsOnTerm = false;
    calls[0].child.ready();
    await p;
    await pm.stop();
    expect(calls[0].child.killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stop() on Windows uses taskkill /T /F', async () => {
    const { pm, calls } = makePm({ platform: 'win32', core: { command: 'C:\\app\\airbridge-core.exe', args: [] } });
    const p = pm.start();
    const daemon = calls[0].child;
    daemon.ready();
    await p;
    const stopping = pm.stop();
    expect(calls[1].command).toBe('taskkill');
    expect(calls[1].args).toEqual(['/PID', String(daemon.pid), '/T', '/F']);
    daemon.exit(1);
    await stopping;
    expect(pm.getLifecycle().phase).toBe('stopped');
  });

  it('restarts with backoff after a crash, with a fresh token, then gives up after max restarts', async () => {
    let n = 0;
    const backoff = vi.fn(() => 5);
    const { pm, calls } = makePm({ generateToken: () => `${'T'.repeat(42)}${n++}`, backoffMs: backoff, maxRestarts: 5 });
    const phases: string[] = [];
    pm.on('lifecycle', (l) => phases.push(l.phase));
    const p = pm.start();
    calls[0].child.ready();
    await p;
    const tokens = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const c = calls[i].child;
      tokens.add((calls[i].options.env as Record<string, string>).AIRBRIDGE_CONTROL_TOKEN);
      c.exit(1);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(calls).toHaveLength(6); // 1 start + 5 restarts
    expect(backoff.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 4, 5]);
    expect(tokens.size).toBe(6);
    expect(pm.getLifecycle().phase).toBe('crashed');
    expect(pm.getLifecycle().detail).toMatch(/Gave up after 5 restarts/);
    expect(phases).toContain('crashed');
  });

  it('a restart that reaches READY returns to running', async () => {
    const { pm, calls } = makePm();
    const p = pm.start();
    calls[0].child.ready();
    await p;
    const readies: number[] = [];
    pm.on('ready', (c) => readies.push(c.port));
    calls[0].child.stderr.write('AirBridge: fatal error: boom\n');
    await flush();
    calls[0].child.exit(1);
    expect(pm.getLifecycle().phase).toBe('crashed');
    expect(pm.getLifecycle().detail).toContain('fatal error: boom');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(2);
    calls[1].child.ready(6000);
    await flush();
    expect(pm.getLifecycle().phase).toBe('running');
    expect(readies).toEqual([6000]);
  });

  it('kills a daemon that never reports READY', async () => {
    const { pm, calls } = makePm({ readyTimeoutMs: 20, maxRestarts: 0 });
    const ok = await pm.start();
    expect(ok).toBe(false);
    expect(calls[0].child.killed[0]).toBe('SIGTERM');
    expect(pm.getLifecycle().phase).toBe('crashed');
  });

  it('spawn errors (ENOENT) surface as crashed without throwing', async () => {
    const pm = new ProcessManager({
      core: { command: '/missing/airbridge-core', args: [] },
      spawn: (() => {
        const c = new FakeChild(1);
        setImmediate(() => c.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
        return c as never;
      }) as never,
      maxRestarts: 0,
      log: () => undefined,
    });
    await expect(pm.start()).resolves.toBe(false);
    expect(pm.getLifecycle()).toMatchObject({ phase: 'crashed' });
    expect(pm.getLifecycle().detail).toContain('ENOENT');
  });

  it('block() stops the daemon and reports blocked', async () => {
    const { pm, calls } = makePm();
    const p = pm.start();
    calls[0].child.ready();
    await p;
    await pm.block('License check: inactive');
    expect(calls[0].child.killed).toEqual(['SIGTERM']);
    expect(pm.getLifecycle()).toEqual({ phase: 'blocked', detail: 'License check: inactive' });
  });

  it('simulated app quit (before-quit -> stop) kills the daemon', async () => {
    const { pm, calls } = makePm();
    const p = pm.start();
    calls[0].child.ready();
    await p;
    const app = new EventEmitter();
    let quitting: Promise<void> | null = null;
    app.on('before-quit', () => {
      quitting = pm.stop();
    });
    app.emit('before-quit');
    await quitting;
    expect(calls[0].child.killed).toContain('SIGTERM');
    expect(calls[0].child.signalCode).toBe('SIGTERM');
  });
});

// ------------------------------------------------------------------ license gate integration

describe('license gate -> process manager', () => {
  const claims = { iss: 'airbridge-license', aud: 'airbridge-desktop', sub: 'user_1', plan: 'airbridge_pro', status: 'active', iat: 0, exp: 4102444800, kid: 'k' };

  function gateWith(status: number, body: unknown, pm: ProcessManager) {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    const cb = licenseGateCallbacks(pm);
    return new LicenseGate({
      licenseUrl: 'https://license.example.com',
      getAuthToken: async () => 'clerk-jwt',
      getUserId: () => 'user_1',
      publicKeys: { k: 'unused' },
      onValid: cb.onValid,
      onInvalid: cb.onInvalid,
      cache: createMemoryLicenseCache(),
      verify: () => ({ ok: true, claims }),
      fetch: fetchFn as never,
      log: () => undefined,
    });
  }

  it('inactive license (402) never spawns the backend', async () => {
    const { pm, spawn } = makePm();
    const gate = gateWith(402, { status: 'inactive', checkout_url: 'https://checkout.stripe.com/c/1' }, pm);
    await gate.start();
    await flush();
    gate.dispose();
    expect(spawn).not.toHaveBeenCalled();
    expect(pm.getLifecycle().phase).toBe('blocked');
  });

  it('signed out never spawns the backend', async () => {
    const { pm, spawn } = makePm();
    const cb = licenseGateCallbacks(pm);
    const gate = new LicenseGate({
      licenseUrl: 'https://license.example.com',
      getAuthToken: async () => null,
      getUserId: () => null,
      publicKeys: {},
      ...cb,
      fetch: vi.fn() as never,
      log: () => undefined,
    });
    await gate.start();
    gate.dispose();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('valid license spawns the backend via start()', async () => {
    const { pm, calls } = makePm();
    const gate = gateWith(200, { token: 'x.y.z', status: 'active', exp: claims.exp }, pm);
    const checking = gate.start();
    for (let i = 0; i < 20 && calls.length === 0; i++) await flush();
    expect(calls).toHaveLength(1);
    calls[0].child.ready();
    await checking;
    gate.dispose();
    expect(pm.getLifecycle().phase).toBe('running');
    await pm.stop();
  });
});
