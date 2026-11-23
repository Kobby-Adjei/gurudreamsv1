/**
 * Demo data for `npm run dev` without Clerk/Stripe/Tailscale/daemon.
 * Enabled ONLY when the app is unpackaged AND AIRBRIDGE_DEV_MOCKS=1 (see devMocksEnabled()).
 * The returned object plugs straight into registerIpc() deps (auth/license/backend/network).
 */
import { randomUUID } from 'node:crypto';
import type {
  AirEvent,
  AirEventType,
  AuthState,
  BackendLifecycle,
  BackendStatus,
  LicenseStatus,
  NetStatus,
  Node,
  NodesResponse,
  SendTaskRequest,
  SendTaskResult,
} from '../shared/types';

export function devMocksEnabled(app: { isPackaged: boolean }, env: Record<string, string | undefined> = process.env): boolean {
  return !app.isPackaged && env.AIRBRIDGE_DEV_MOCKS === '1';
}

export interface DevMocksOptions {
  onEvent(e: AirEvent): void;
  onStatus(s: BackendStatus): void;
  onLifecycle(l: BackendLifecycle): void;
  onAuth?(s: AuthState): void;
  onLicense?(s: LicenseStatus): void;
  onNetwork?(s: NetStatus): void;
  intervalMs?: number;
  now?: () => number;
  random?: () => number;
}

const SELF = { hostname: 'Dev-Workstation', ip: '100.101.12.7', os: 'macOS' };
const PEERS: Node[] = [
  { hostname: 'MacBook-Pro', ip: '100.88.4.21', os: 'macOS', online: true, last_seen: null },
  { hostname: 'Desktop-PC', ip: '100.92.33.150', os: 'windows', online: true, last_seen: null },
  { hostname: 'Studio-Mac', ip: '100.77.120.9', os: 'macOS', online: true, last_seen: null },
];

const TASKS = [
  'Refactor the auth middleware',
  'Run the integration test suite',
  'Review the migration script',
  'Profile the image pipeline',
  'Draft release notes for v0.2',
];

export function createDevMocks(opts: DevMocksOptions) {
  const now = opts.now ?? Date.now;
  const rnd = opts.random ?? Math.random;
  const startedAt = now();
  const nodes: Node[] = PEERS.map((n) => ({ ...n, last_seen: new Date(startedAt).toISOString() }));
  const events: AirEvent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let lifecycle: BackendLifecycle = { phase: 'running', detail: 'Demo mode (AIRBRIDGE_DEV_MOCKS=1)' };

  const auth: AuthState = {
    state: 'signed_in',
    user: { id: 'user_dev_mock', email: 'dev@airbridge.local', name: 'Demo User' },
  };
  const license: LicenseStatus = {
    state: 'valid',
    plan: 'airbridge_pro',
    exp: Math.floor(startedAt / 1000) + 72 * 3600,
  };

  const network: NetStatus = { state: 'connected', ip: SELF.ip };

  const status = (): BackendStatus => ({
    version: '0.2.0-dev',
    mode: 'daemon',
    tailnet_ip: SELF.ip,
    inbox: { listening: true, port: 8989, degraded_reason: null },
    uptime_s: Math.floor((now() - startedAt) / 1000),
  });

  const make = (type: AirEventType, peer: string | null, summary: string, detail: AirEvent['detail'] = {}): AirEvent => ({
    v: 1,
    id: randomUUID(),
    ts: new Date(now()).toISOString(),
    type,
    origin: type === 'task_sent' || type === 'send_failed' ? 'mcp' : 'daemon',
    local_node: SELF.hostname,
    peer,
    summary: summary.slice(0, 120),
    detail,
  });

  const emit = (e: AirEvent) => {
    events.push(e);
    if (events.length > 500) events.shift();
    opts.onEvent(e);
  };

  // Seed history so the feed isn't empty on first paint.
  const seed = [
    make('daemon_started', null, 'AirBridge daemon started'),
    make('inbox_listening', null, `Inbox listening on ${SELF.ip}:8989`),
    make('node_online', 'MacBook-Pro', 'MacBook-Pro came online'),
    make('node_online', 'Desktop-PC', 'Desktop-PC came online'),
    make('node_online', 'Studio-Mac', 'Studio-Mac came online'),
    make('task_received', 'MacBook-Pro', 'Received task from MacBook-Pro', { bytes: 1840, file: 'task_20261123-091502-118204.md' }),
    make('task_sent', 'Desktop-PC', 'Sent code to Desktop-PC', { bytes: 5321 }),
  ];
  seed.forEach((e) => events.push(e));

  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length]!;

  const tick = () => {
    const r = rnd();
    const peer = pick(nodes);
    if (r < 0.4) {
      if (!peer.online) return tick2(peer);
      const file = `task_${new Date(now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${String(Math.floor(rnd() * 1e6)).padStart(6, '0')}.md`;
      emit(make('task_received', peer.hostname, `Received task from ${peer.hostname}: ${pick(TASKS)}`, { bytes: 500 + Math.floor(rnd() * 20000), file }));
    } else if (r < 0.75) {
      if (!peer.online) {
        emit(make('send_failed', peer.hostname, `Could not reach ${peer.hostname}`, { error: 'peer offline' }));
        return;
      }
      emit(make('task_sent', peer.hostname, `Sent code to ${peer.hostname}`, { bytes: 200 + Math.floor(rnd() * 50000) }));
    } else {
      tick2(peer);
    }
    opts.onStatus(status());
  };

  const tick2 = (peer: Node) => {
    peer.online = !peer.online;
    peer.last_seen = new Date(now()).toISOString();
    emit(make(peer.online ? 'node_online' : 'node_offline', peer.hostname, `${peer.hostname} ${peer.online ? 'came online' : 'went offline'}`));
  };

  return {
    auth: {
      getState: (): AuthState => ({ ...auth, user: { ...auth.user! } }),
      signIn: async () => opts.onAuth?.(auth),
      signOut: async () => opts.onAuth?.(auth), // demo stays signed in
    },
    license: {
      getStatus: (): LicenseStatus => ({ ...license }),
      refresh: async (): Promise<LicenseStatus> => ({ ...license }),
      openCheckout: async () => undefined,
    },
    backend: {
      getStatus: async (): Promise<BackendStatus | null> => status(),
      getLifecycle: (): BackendLifecycle => ({ ...lifecycle }),
      getNodes: async (): Promise<NodesResponse> => ({ self: { ...SELF }, nodes: nodes.map((n) => ({ ...n })), error: null }),
      getEvents: async (limit: number): Promise<AirEvent[]> => events.slice(-limit),
      sendTask: async (req: SendTaskRequest): Promise<SendTaskResult> => {
        const n = nodes.find((x) => x.hostname.toLowerCase() === req.target_hostname.toLowerCase());
        if (!n || !n.online) {
          emit(make('send_failed', req.target_hostname, `Could not reach ${req.target_hostname}`, { error: 'peer offline' }));
          return { ok: false, error: `Node '${req.target_hostname}' is not online in your tailnet.` };
        }
        const bytes = Buffer.byteLength(req.task_description) + Buffer.byteLength(req.code_payload ?? '');
        emit(make('task_sent', n.hostname, `${req.code_payload ? 'Sent code' : 'Sent task'} to ${n.hostname}`, { bytes }));
        return { ok: true, file: `task_${Date.now()}.md`, target: n.hostname };
      },
    },
    network: {
      getStatus: async (): Promise<NetStatus> => ({ ...network }),
      retry: async (): Promise<NetStatus> => {
        opts.onNetwork?.({ ...network });
        return { ...network };
      },
    },
    start(): void {
      if (timer) return;
      opts.onNetwork?.({ ...network });
      opts.onLifecycle(lifecycle);
      opts.onStatus(status());
      opts.onLicense?.(license);
      opts.onAuth?.(auth);
      timer = setInterval(tick, opts.intervalMs ?? 4000);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      lifecycle = { phase: 'stopped' };
    },
  };
}

export type DevMocks = ReturnType<typeof createDevMocks>;
