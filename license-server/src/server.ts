import { serve } from '@hono/node-server';
import { buildFromEnv } from './bootstrap.js';
import { ConfigError } from './config.js';

let built: ReturnType<typeof buildFromEnv>;
try {
  built = buildFromEnv();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(2);
  }
  throw e;
}

const { app, config, store } = built;
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: info.port }));
});

// Installer uploads (≤ 400 MB, POST /v1/releases/upload) can take longer than Node's 5-minute default.
(server as unknown as { requestTimeout: number }).requestTimeout = 30 * 60_000;

const shutdown = () => {
  server.close(() => {
    void store.close?.().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
