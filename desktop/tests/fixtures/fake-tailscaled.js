#!/usr/bin/env node
// Fake userspace tailscaled for TailscaleManager tests. Records argv/env/cwd to
// <cwd>/fake-tailscaled.<pid>.json, listens on --socket (Unix), and obeys <cwd>/fake-mode:
//   "crash"        exit(1) right away
//   "ignore-term"  ignore SIGTERM (forces SIGKILL escalation)
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const cwd = process.cwd();
let mode = '';
try { mode = fs.readFileSync(path.join(cwd, 'fake-mode'), 'utf8').trim(); } catch { /* none */ }
fs.writeFileSync(path.join(cwd, `fake-tailscaled.${process.pid}.json`),
  JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd, pid: process.pid }));
if (mode === 'crash') process.exit(1);

const sockArg = process.argv.find((a) => a.startsWith('--socket='));
const sock = sockArg ? sockArg.slice('--socket='.length) : null;
let server = null;
if (sock && !sock.startsWith('\\\\.\\pipe\\')) {
  try { fs.rmSync(sock, { force: true }); } catch { /* ignore */ }
  server = net.createServer((c) => c.end());
  server.listen(sock);
}
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => { if (server) server.close(); process.exit(0); });
setInterval(() => {}, 1000);
