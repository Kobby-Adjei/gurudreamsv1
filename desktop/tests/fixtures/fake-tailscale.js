#!/usr/bin/env node
// Fake `tailscale` CLI for TailscaleManager tests. State lives in <cwd>/fake-ts-state
// (BackendState, default "NeedsLogin"); every invocation is appended to <cwd>/fake-cli.log.
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const cwd = process.cwd();
const args = process.argv.slice(2);
fs.appendFileSync(path.join(cwd, 'fake-cli.log'), JSON.stringify(args) + '\n');
const stateFile = path.join(cwd, 'fake-ts-state');
const sock = (args.find((a) => a.startsWith('--socket=')) || '').slice('--socket='.length);
const cmd = args.find((a) => !a.startsWith('--'));
const getState = () => { try { return fs.readFileSync(stateFile, 'utf8').trim(); } catch { return 'NeedsLogin'; } };

const c = net.connect(sock);
c.on('error', () => { process.stderr.write('failed to connect to local tailscaled; it doesn\'t appear to be running\n'); process.exit(1); });
c.on('connect', () => {
  c.destroy();
  if (cmd === 'status') {
    const st = getState();
    process.stdout.write(JSON.stringify({ BackendState: st, Self: { TailscaleIPs: st === 'Running' ? ['100.64.0.7', 'fd7a:115c:a1e0::7'] : [] } }));
    process.exit(0);
  } else if (cmd === 'up') {
    const keyArg = args.find((a) => a.startsWith('--auth-key=')) || '';
    const file = keyArg.replace(/^--auth-key=file:/, '');
    let ok = false;
    try { ok = fs.readFileSync(file, 'utf8').length > 0; } catch { ok = false; }
    fs.writeFileSync(path.join(cwd, 'fake-up.json'), JSON.stringify({ args, keyFileReadable: ok }));
    if (!ok || getState() === 'FailUp') { process.stderr.write('up failed\n'); process.exit(1); }
    fs.writeFileSync(stateFile, 'Running');
    process.exit(0);
  } else if (cmd === 'logout') {
    fs.writeFileSync(stateFile, 'NeedsLogin');
    process.exit(0);
  } else {
    process.exit(2);
  }
});
