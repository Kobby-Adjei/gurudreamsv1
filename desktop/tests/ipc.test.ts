import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));

import { registerIpc, type IpcDeps } from '../src/main/ipc';
import { INVOKE_CHANNELS, PUSH_CHANNELS } from '../src/shared/ipcChannels';

const DEV_ORIGIN = 'http://localhost:5173';
const FILE_ORIGIN = 'file:///Applications/AirBridge%20Pro.app/Contents/Resources/app.asar/out/renderer/';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function setup(allowedOrigin: string | string[] = DEV_ORIGIN) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((ch: string, fn: Handler) => void handlers.set(ch, fn)),
    removeHandler: vi.fn((ch: string) => void handlers.delete(ch)),
  };
  const clipboard = { writeText: vi.fn() };
  const sent: Array<[string, unknown]> = [];
  const wc = {
    isDestroyed: () => false,
    mainFrame: { url: `${DEV_ORIGIN}/index.html`, parent: null },
    send: vi.fn((ch: string, p: unknown) => void sent.push([ch, p])),
  };
  const deps: IpcDeps = {
    allowedOrigin,
    auth: {
      getState: vi.fn(() => ({ state: 'signed_in' as const, user: { id: 'user_1', email: 'a@b.c' } })),
      signIn: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
    },
    license: {
      getStatus: vi.fn(() => ({ state: 'valid' as const, plan: 'airbridge_pro', exp: 1 })),
      refresh: vi.fn(async () => ({ state: 'valid' as const, plan: 'airbridge_pro', exp: 2 })),
      openCheckout: vi.fn(async () => {}),
    },
    backend: {
      getStatus: vi.fn(async () => null),
      getLifecycle: vi.fn(() => ({ phase: 'running' as const })),
      getNodes: vi.fn(async () => null),
      getEvents: vi.fn(async (_n: number) => []),
      sendTask: vi.fn(async () => ({ ok: true as const, file: 'f.md', target: 'Desktop-PC' })),
    },
    network: {
      getStatus: vi.fn(async () => ({ state: 'connected' as const, ip: '100.64.0.7' })),
      retry: vi.fn(async () => ({ state: 'connecting' as const })),
    },
    getMcpConfigJson: vi.fn((c) => `{"client":"${c}"}`),
    getWebContents: () => wc as never,
    ipcMain,
    clipboard,
    log: () => {},
  };
  const handle = registerIpc(deps);
  const call = (ch: string, frame: unknown, ...args: unknown[]) => handlers.get(ch)!({ senderFrame: frame }, ...args);
  const app = { url: `${DEV_ORIGIN}/index.html#/settings`, parent: null };
  return { deps, handle, handlers, call, app, clipboard, wc, sent, ipcMain };
}

describe('registerIpc', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('registers exactly the frozen invoke channels', () => {
    expect([...s.handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('frozen channel sets include exactly the Phase 3 network additions', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(
      [
        'ab:auth:get', 'ab:auth:signin', 'ab:auth:signout',
        'ab:license:get', 'ab:license:refresh', 'ab:license:checkout',
        'ab:backend:status', 'ab:backend:lifecycle', 'ab:backend:nodes', 'ab:backend:events', 'ab:backend:send',
        'ab:settings:mcp', 'ab:settings:copy',
        'ab:network:status', 'ab:network:retry',
      ].sort(),
    );
    expect([...PUSH_CHANNELS].sort()).toEqual(
      ['ab:auth:changed', 'ab:license:changed', 'ab:backend:event', 'ab:backend:status', 'ab:backend:lifecycle', 'ab:network:changed'].sort(),
    );
  });

  it('network: status/retry delegate, validate args, sanitize output and hide internal errors', async () => {
    await expect(s.call('ab:network:status', s.app)).resolves.toEqual({ state: 'connected', ip: '100.64.0.7' });
    await expect(s.call('ab:network:retry', s.app)).resolves.toEqual({ state: 'connecting' });
    expect(s.deps.network!.retry).toHaveBeenCalledTimes(1);
    await expect(s.call('ab:network:status', s.app, 'x')).rejects.toThrow(/invalid_payload/);
    await expect(s.call('ab:network:retry', s.app, {})).rejects.toThrow(/invalid_payload/);
    expect(s.deps.network!.retry).toHaveBeenCalledTimes(1);

    (s.deps.network!.getStatus as any).mockResolvedValueOnce({
      state: 'connected',
      ip: 'not-an-ip; rm -rf /',
      detail: 'line1\nline2',
      socket: '/Users/x/Library/Application Support/AirBridge/tailscaled.sock',
    });
    await expect(s.call('ab:network:status', s.app)).resolves.toEqual({ state: 'connected', detail: 'line1 line2' });
    (s.deps.network!.getStatus as any).mockResolvedValueOnce({ state: 'bogus' });
    await expect(s.call('ab:network:status', s.app)).resolves.toEqual({ state: 'error' });

    (s.deps.network!.retry as any).mockRejectedValueOnce(new Error('spawn /opt/tailscaled EACCES authkey=secret'));
    const r = await s.call('ab:network:retry', s.app);
    expect(r).toMatchObject({ state: 'error' });
    expect(JSON.stringify(r)).not.toMatch(/secret|EACCES|tailscaled/);
  });

  it('network: absent dep -> stopped; retry falls back to getStatus', async () => {
    const base = setup();
    const handlers = new Map<string, Handler>();
    registerIpc({
      ...base.deps,
      network: undefined,
      ipcMain: { handle: (ch: string, fn: Handler) => void handlers.set(ch, fn), removeHandler: () => {} } as never,
    });
    expect([...handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
    await expect(handlers.get('ab:network:status')!({ senderFrame: base.app })).resolves.toEqual({ state: 'stopped' });
    await expect(handlers.get('ab:network:retry')!({ senderFrame: base.app })).resolves.toEqual({ state: 'stopped' });

    const r = setup();
    delete (r.deps.network as { retry?: unknown }).retry;
    await expect(r.call('ab:network:retry', r.app)).resolves.toEqual({ state: 'connected', ip: '100.64.0.7' });
  });


  it.each([
    ['foreign https page', { url: 'https://evil.example/index.html', parent: null }],
    ['other localhost port', { url: 'http://localhost:6666/', parent: null }],
    ['sub-frame on app origin', { url: `${DEV_ORIGIN}/index.html`, parent: {} }],
    ['about:blank', { url: 'about:blank', parent: null }],
    ['data: url', { url: 'data:text/html,hi', parent: null }],
    ['destroyed frame', null],
  ])('rejects every channel from a %s', async (_name, frame) => {
    for (const ch of INVOKE_CHANNELS) {
      await expect(s.call(ch, frame), ch).rejects.toThrow(/forbidden/);
    }
    expect(s.deps.auth.signIn).not.toHaveBeenCalled();
    expect(s.deps.backend.sendTask).not.toHaveBeenCalled();
    expect(s.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('accepts the app frame (dev origin)', async () => {
    await expect(s.call('ab:auth:get', s.app)).resolves.toEqual({ state: 'signed_in', user: { id: 'user_1', email: 'a@b.c' } });
    await expect(s.call('ab:license:get', s.app)).resolves.toMatchObject({ state: 'valid' });
    await expect(s.call('ab:backend:lifecycle', s.app)).resolves.toEqual({ phase: 'running' });
  });

  it('accepts only file:// frames inside the packaged renderer dir', async () => {
    const p = setup(FILE_ORIGIN);
    await expect(p.call('ab:auth:get', { url: `${FILE_ORIGIN}index.html`, parent: null })).resolves.toBeTruthy();
    await expect(p.call('ab:auth:get', { url: 'file:///tmp/evil.html', parent: null })).rejects.toThrow(/forbidden/);
    await expect(p.call('ab:auth:get', { url: `${FILE_ORIGIN}../../evil.html`, parent: null })).rejects.toThrow(/forbidden/);
  });

  it('validates getEvents limit', async () => {
    for (const bad of [0, -1, 1.5, 1001, '10', null, NaN]) {
      await expect(s.call('ab:backend:events', s.app, bad), String(bad)).rejects.toThrow(/invalid_payload/);
    }
    await expect(s.call('ab:backend:events', s.app)).rejects.toThrow(/invalid_payload/);
    await s.call('ab:backend:events', s.app, 100);
    expect(s.deps.backend.getEvents).toHaveBeenCalledWith(100);
  });

  it('validates sendTask payloads', async () => {
    const ok = { target_hostname: 'Desktop-PC', task_description: 'do it' };
    const bad: unknown[] = [
      undefined,
      null,
      'string',
      [],
      {},
      { ...ok, target_hostname: '../etc' },
      { ...ok, target_hostname: 'a b' },
      { ...ok, target_hostname: 'x'.repeat(65) },
      { ...ok, task_description: '' },
      { ...ok, task_description: '   ' },
      { ...ok, task_description: 'x'.repeat(64_001) },
      { ...ok, code_payload: 5 },
      { ...ok, code_payload: 'x'.repeat(512_001) },
      { ...ok, extra: 'nope' },
      Object.assign(Object.create({ polluted: true }), ok),
    ];
    for (const b of bad) {
      await expect(s.call('ab:backend:send', s.app, b)).rejects.toThrow(/invalid_payload/);
    }
    await expect(s.call('ab:backend:send', s.app, ok, 'extra-arg')).rejects.toThrow(/invalid_payload/);
    expect(s.deps.backend.sendTask).not.toHaveBeenCalled();

    await expect(s.call('ab:backend:send', s.app, { ...ok, code_payload: 'print(1)' })).resolves.toEqual({
      ok: true,
      file: 'f.md',
      target: 'Desktop-PC',
    });
    expect(s.deps.backend.sendTask).toHaveBeenCalledWith({ ...ok, code_payload: 'print(1)' });
  });

  it('sendTask returns a structured failure (not an internal error) when the backend throws', async () => {
    (s.deps.backend.sendTask as any).mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:51234 token=abc'));
    const r = await s.call('ab:backend:send', s.app, { target_hostname: 'a', task_description: 'b' });
    expect(r).toEqual({ ok: false, error: 'Backend is not running.' });
    expect(JSON.stringify(r)).not.toMatch(/token|ECONN/);
  });

  it('rejects unexpected args on no-arg channels', async () => {
    await expect(s.call('ab:auth:signin', s.app, { evil: 1 })).rejects.toThrow(/invalid_payload/);
    expect(s.deps.auth.signIn).not.toHaveBeenCalled();
  });

  it('settings: validates the client and copies via the clipboard', async () => {
    await expect(s.call('ab:settings:mcp', s.app, 'vscode')).rejects.toThrow(/invalid_payload/);
    await expect(s.call('ab:settings:copy', s.app, { client: 'claude' })).rejects.toThrow(/invalid_payload/);
    await expect(s.call('ab:settings:mcp', s.app, 'claude')).resolves.toEqual({ json: '{"client":"claude"}' });
    await expect(s.call('ab:settings:copy', s.app, 'cursor')).resolves.toBeUndefined();
    expect(s.clipboard.writeText).toHaveBeenCalledWith('{"client":"cursor"}');
  });

  it('push helpers send on the frozen channels, and never to a foreign page', () => {
    s.handle.push.backendEvent({ id: 'e1' } as never);
    s.handle.push.authChanged({ state: 'signed_out' });
    s.handle.push.licenseChanged({ state: 'inactive', plan: null, exp: null });
    s.handle.push.backendStatus({} as never);
    s.handle.push.backendLifecycle({ phase: 'blocked' });
    s.handle.push.networkChanged({ state: 'connected', ip: '100.64.0.9', socket: '/secret/path' } as never);
    expect(s.sent.map(([c]) => c)).toEqual([
      'ab:backend:event',
      'ab:auth:changed',
      'ab:license:changed',
      'ab:backend:status',
      'ab:backend:lifecycle',
      'ab:network:changed',
    ]);
    expect(s.sent[5]![1]).toEqual({ state: 'connected', ip: '100.64.0.9' });
    s.wc.mainFrame.url = 'https://evil.example/';
    s.handle.push.backendEvent({ id: 'e2' } as never);
    s.handle.push.networkChanged({ state: 'connected' });
    expect(s.sent).toHaveLength(6);
  });

  it('dispose removes all handlers', () => {
    s.handle.dispose();
    expect(s.handlers.size).toBe(0);
  });
});
