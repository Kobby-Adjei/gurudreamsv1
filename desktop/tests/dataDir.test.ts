import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDataDir } from '../src/main/network/dataDir';

type Case = { name: string; platform: NodeJS.Platform; env: Record<string, string>; home: string; want: string };

// Mirrors airbridge/airbridge_app/config.py default_data_dir() (the shared data dir D).
const CASES: Case[] = [
  { name: 'linux default', platform: 'linux', env: {}, home: '/home/ann', want: '/home/ann/.local/share/airbridge' },
  { name: 'linux XDG', platform: 'linux', env: { XDG_DATA_HOME: '/data/x' }, home: '/home/ann', want: '/data/x/airbridge' },
  { name: 'linux XDG ~', platform: 'linux', env: { XDG_DATA_HOME: '~/xdg' }, home: '/home/ann', want: '/home/ann/xdg/airbridge' },
  { name: 'linux XDG blank', platform: 'linux', env: { XDG_DATA_HOME: '   ' }, home: '/home/ann', want: '/home/ann/.local/share/airbridge' },
  { name: 'linux override', platform: 'linux', env: { AIRBRIDGE_DATA_DIR: ' /opt/ab ', XDG_DATA_HOME: '/x' }, home: '/home/ann', want: '/opt/ab' },
  { name: 'linux override ~', platform: 'linux', env: { AIRBRIDGE_DATA_DIR: '~/ab' }, home: '/home/ann', want: '/home/ann/ab' },
  { name: 'mac default', platform: 'darwin', env: { XDG_DATA_HOME: '/ignored' }, home: '/Users/ann', want: '/Users/ann/Library/Application Support/AirBridge' },
  { name: 'mac override', platform: 'darwin', env: { AIRBRIDGE_DATA_DIR: '/tmp/ab' }, home: '/Users/ann', want: '/tmp/ab' },
  { name: 'win APPDATA', platform: 'win32', env: { APPDATA: 'C:\\Users\\ann\\AppData\\Roaming' }, home: 'C:\\Users\\ann', want: 'C:\\Users\\ann\\AppData\\Roaming\\AirBridge' },
  { name: 'win no APPDATA', platform: 'win32', env: {}, home: 'C:\\Users\\ann', want: 'C:\\Users\\ann\\AppData\\Roaming\\AirBridge' },
  { name: 'win override', platform: 'win32', env: { AIRBRIDGE_DATA_DIR: 'D:\\ab', APPDATA: 'C:\\x' }, home: 'C:\\Users\\ann', want: 'D:\\ab' },
];

describe('defaultDataDir (parity with Python config.default_data_dir)', () => {
  it.each(CASES)('$name', (c) => {
    expect(defaultDataDir({ platform: c.platform, env: c.env, homedir: c.home })).toBe(c.want);
  });

  // Live cross-check against the real Python function for the POSIX cases (skipped without Python).
  const python = process.env.AIRBRIDGE_PYTHON || '/tmp/claude-0/abvenv/bin/python';
  let havePython = false;
  try {
    execFileSync(python, ['-c', 'import sys'], { stdio: 'ignore' });
    havePython = true;
  } catch {
    havePython = false;
  }
  const posix = CASES.filter((c) => c.platform !== 'win32');
  it.skipIf(!havePython).each(posix)('python agrees: $name', (c) => {
    const script = [
      'import sys, os',
      `sys.path.insert(0, ${JSON.stringify(resolve(__dirname, '../../airbridge'))})`,
      `sys.platform = ${JSON.stringify(c.platform)}`,
      'from airbridge_app import config',
      'sys.stderr.write(str(config.default_data_dir()))',
    ].join('\n');
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: c.home, ...c.env };
    const r = spawnSync(python, ['-I', '-c', script], { env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(c.want);
  });
});
