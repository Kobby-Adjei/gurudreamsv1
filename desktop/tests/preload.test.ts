import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    exposed: {} as Record<string, unknown>,
    listeners,
    invoke: vi.fn(async (..._a: unknown[]) => 'ok'),
    on: vi.fn((ch: string, fn: (...a: unknown[]) => void) => {
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch)!.add(fn);
    }),
    removeListener: vi.fn((ch: string, fn: (...a: unknown[]) => void) => {
      listeners.get(ch)?.delete(fn);
    }),
  };
});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      h.exposed[key] = value;
    },
  },
  ipcRenderer: { invoke: h.invoke, on: h.on, removeListener: h.removeListener },
}));

/** Frozen contract (PHASE2_PLAN.md §2 "Preload window.airbridge" + PHASE3_PLAN.md §2 network). */
const CONTRACT: Record<string, string[]> = {
  auth: ['getState', 'signIn', 'signOut', 'onChange'],
  license: ['getStatus', 'refresh', 'openCheckout', 'onChange'],
  backend: ['getStatus', 'getLifecycle', 'getNodes', 'getEvents', 'sendTask', 'onEvent', 'onStatus', 'onLifecycle'],
  network: ['getStatus', 'retry', 'onChange'],
  settings: ['getMcpConfig', 'copyMcpConfig'],
  app: ['version', 'platform'],
};

async function load() {
  vi.resetModules();
  for (const k of Object.keys(h.exposed)) delete h.exposed[k];
  h.listeners.clear();
  await import('../src/preload/index');
  return h.exposed.airbridge as Record<string, Record<string, unknown>>;
}

describe('preload window.airbridge', () => {
  beforeEach(() => {
    h.invoke.mockClear();
    h.on.mockClear();
    h.removeListener.mockClear();
  });

  it('exposes exactly one global, "airbridge"', async () => {
    await load();
    expect(Object.keys(h.exposed)).toEqual(['airbridge']);
  });

  it('exposes exactly the frozen key set (no extras, nothing missing, no raw ipcRenderer)', async () => {
    const api = await load();
    expect(Object.keys(api).sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const [ns, keys] of Object.entries(CONTRACT)) {
      expect(Object.keys(api[ns]!).sort(), ns).toEqual([...keys].sort());
    }
    for (const [ns, keys] of Object.entries(CONTRACT)) {
      for (const k of keys) {
        const v = api[ns]![k];
        if (ns === 'app') expect(typeof v).toBe('string');
        else expect(typeof v, `${ns}.${k}`).toBe('function');
        expect(v).not.toBe(h.invoke);
      }
    }
    expect(JSON.stringify(Object.keys(api))).not.toMatch(/ipc/i);
  });

  it('maps every method to its frozen invoke channel and arguments', async () => {
    const api = await load() as any;
    const cases: Array<[() => unknown, string, unknown[]]> = [
      [() => api.auth.getState(), 'ab:auth:get', []],
      [() => api.auth.signIn(), 'ab:auth:signin', []],
      [() => api.auth.signOut(), 'ab:auth:signout', []],
      [() => api.license.getStatus(), 'ab:license:get', []],
      [() => api.license.refresh(), 'ab:license:refresh', []],
      [() => api.license.openCheckout(), 'ab:license:checkout', []],
      [() => api.backend.getStatus(), 'ab:backend:status', []],
      [() => api.backend.getLifecycle(), 'ab:backend:lifecycle', []],
      [() => api.backend.getNodes(), 'ab:backend:nodes', []],
      [() => api.backend.getEvents(50), 'ab:backend:events', [50]],
      [() => api.backend.sendTask({ target_hostname: 'a', task_description: 'b' }), 'ab:backend:send', [{ target_hostname: 'a', task_description: 'b' }]],
      [() => api.network.getStatus(), 'ab:network:status', []],
      [() => api.network.retry(), 'ab:network:retry', []],
      [() => api.settings.getMcpConfig('claude'), 'ab:settings:mcp', ['claude']],
      [() => api.settings.copyMcpConfig('cursor'), 'ab:settings:copy', ['cursor']],
    ];
    for (const [call, channel, args] of cases) {
      h.invoke.mockClear();
      await expect(call()).resolves.toBe('ok');
      expect(h.invoke).toHaveBeenCalledWith(channel, ...args);
    }
  });

  it('subscriptions pass only the payload (never the Electron event) and return working unsubscribe fns', async () => {
    const api = await load() as any;
    const subs: Array<[string, (cb: (p: unknown) => void) => () => void]> = [
      ['ab:auth:changed', api.auth.onChange],
      ['ab:license:changed', api.license.onChange],
      ['ab:backend:event', api.backend.onEvent],
      ['ab:backend:status', api.backend.onStatus],
      ['ab:backend:lifecycle', api.backend.onLifecycle],
      ['ab:network:changed', api.network.onChange],
    ];
    for (const [channel, subscribe] of subs) {
      const cb = vi.fn();
      const unsub = subscribe(cb);
      expect(typeof unsub).toBe('function');
      const fakeEvent = { sender: { secret: 'ipc-internals' } };
      for (const l of h.listeners.get(channel) ?? []) l(fakeEvent, { hello: channel });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({ hello: channel });
      unsub();
      unsub(); // idempotent
      expect(h.listeners.get(channel)?.size ?? 0).toBe(0);
      expect(h.removeListener).toHaveBeenCalledWith(channel, expect.any(Function));
    }
  });

  it('app.version comes from the main-process argument, sanitized', async () => {
    const orig = process.argv;
    process.argv = [...orig, '--airbridge-app-version=1.2.3'];
    try {
      expect((await load()).app!.version).toBe('1.2.3');
      process.argv = [...orig, '--airbridge-app-version=<script>'];
      expect((await load()).app!.version).toBe('0.0.0');
    } finally {
      process.argv = orig;
    }
    expect((await load()).app!.platform).toBe(process.platform);
  });
});
