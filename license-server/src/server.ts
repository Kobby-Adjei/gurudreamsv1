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
const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: info.port }));
});

const shutdown = () => {
  server.close(() => {
    void store.close?.().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
