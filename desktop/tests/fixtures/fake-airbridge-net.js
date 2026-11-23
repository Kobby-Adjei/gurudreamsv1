#!/usr/bin/env node
/* Fake airbridge-net sidecar for netManager.test.ts (POSIX only: copied as an executable script).
 *
 * Reads ONE JSON config line from stdin (like the real sidecar), records what it got in
 * <cwd>/fake-net.<pid>.json (argv, env, config), serves a guarded control API and prints
 * AIRBRIDGE_NET_READY on stderr. Behaviour comes from <cwd>/fake-net-behavior.json:
 *   {crash: true}        exit 3 right after reading the config
 *   {noReady: true}      never print READY
 *   {ignoreTerm: true}   ignore SIGTERM (stop must escalate to SIGKILL)
 *   {state: "..."}       force the /status state
 */
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const cwd = process.cwd();
let behavior = {};
try {
  behavior = JSON.parse(fs.readFileSync(path.join(cwd, 'fake-net-behavior.json'), 'utf8'));
} catch {
  /* defaults */
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => main(input));

function main(raw) {
  const line = raw.split('\n')[0];
  const cfg = JSON.parse(line);
  const record = { argv: process.argv.slice(2), env: process.env, config: cfg, stdinClosed: true, pid: process.pid };
  fs.writeFileSync(path.join(cwd, `fake-net.${process.pid}.json`), JSON.stringify(record));
  if (behavior.crash) process.exit(3);
  if (behavior.ignoreTerm) process.on('SIGTERM', () => undefined);
  else process.on('SIGTERM', () => process.exit(0));

  const stateFile = path.join(cfg.state_dir, 'tailscaled.state');
  if (cfg.auth_key) {
    fs.mkdirSync(cfg.state_dir, { recursive: true });
    fs.writeFileSync(stateFile, 'node');
  }
  let loggedOut = false;
  // A log line with secrets: the manager must redact it before it reaches the log file.
  process.stderr.write(`airbridge-net: go to: https://hs.example.com/register/abc key ${['hskey', 'auth', 'leakme0123456789'].join('-')}\n`);

  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const port = server.address().port;
    const host = server.address().family === 'IPv6' ? `[::1]:${port}` : `127.0.0.1:${port}`;
    if (req.headers.origin !== undefined || req.headers.host !== host) return send(403, { ok: false });
    if (req.headers.authorization !== `Bearer ${cfg.control_token}`) return send(401, { ok: false });
    if (req.method === 'GET' && req.url === '/status') {
      const enrolled = fs.existsSync(stateFile) && !loggedOut;
      const state = behavior.state || (enrolled ? 'connected' : 'needs_login');
      return send(200, { state, self: { hostname: 'a1', ip: state === 'connected' ? '100.64.0.7' : '' } });
    }
    if (req.method === 'POST' && req.url === '/logout') {
      loggedOut = true;
      fs.writeFileSync(path.join(cwd, `fake-net.${process.pid}.logout`), '1');
      return send(200, { ok: true });
    }
    return send(404, { ok: false });
  });
  const ready = () => {
    const a = server.address();
    if (!behavior.noReady) {
      process.stderr.write(
        `AIRBRIDGE_NET_READY ${JSON.stringify({ port: a.port, pid: process.pid, host: a.family === 'IPv6' ? '::1' : '127.0.0.1' })}\n`,
      );
    }
  };
  server.once('error', () => server.listen(0, '127.0.0.1', ready));
  server.listen(0, '::1', ready);
}
