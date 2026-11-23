import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMcpConfig,
  getMcpConfigJson,
  mcpConfigLocation,
  packagedCorePath,
  resolveCoreCommand,
} from '../src/main/mcpConfig';

const RES = '/Applications/AirBridge Pro.app/Contents/Resources';

describe('mcpConfig', () => {
  it.each([
    ['darwin', 'arm64', join(RES, 'bin', 'darwin-arm64', 'airbridge-core')],
    ['darwin', 'x64', join(RES, 'bin', 'darwin-x64', 'airbridge-core')],
    ['win32', 'x64', join(RES, 'bin', 'win32-x64', 'airbridge-core.exe')],
    ['linux', 'x64', join(RES, 'bin', 'linux-x64', 'airbridge-core')],
  ] as const)('packaged %s/%s -> bundled binary, no args (MCP stdio default mode)', (platform, arch, expected) => {
    expect(packagedCorePath(RES, platform, arch)).toBe(expected);
    expect(resolveCoreCommand({ isPackaged: true, resourcesPath: RES, appPath: '/x', platform, arch })).toEqual({
      command: expected,
      args: [],
    });
  });

  it('never passes --daemon (that is the process manager mode, not MCP)', () => {
    const json = getMcpConfigJson('claude', { isPackaged: true, resourcesPath: RES, appPath: '/x', platform: 'darwin', arch: 'arm64' });
    expect(json).not.toMatch(/--daemon/);
  });

  it('Claude Desktop config shape', () => {
    const json = getMcpConfigJson('claude', { isPackaged: true, resourcesPath: RES, appPath: '/x', platform: 'darwin', arch: 'arm64' });
    expect(JSON.parse(json)).toEqual({
      mcpServers: { airbridge: { command: join(RES, 'bin', 'darwin-arm64', 'airbridge-core'), args: [] } },
    });
    expect(json).toContain('\n  '); // pretty-printed for pasting
  });

  it('Cursor config shape', () => {
    expect(buildMcpConfig('cursor', { command: '/bin/airbridge-core', args: [] })).toEqual({
      mcpServers: { airbridge: { type: 'stdio', command: '/bin/airbridge-core', args: [] } },
    });
  });

  it('Windows paths survive JSON escaping', () => {
    const res = 'C:\\Program Files\\AirBridge Pro\\resources';
    const json = getMcpConfigJson('claude', { isPackaged: true, resourcesPath: res, appPath: 'C:\\x', platform: 'win32', arch: 'x64' });
    expect(JSON.parse(json).mcpServers.airbridge.command).toMatch(/airbridge-core\.exe$/);
  });

  it('dev: uses a locally built binary when present', () => {
    const appPath = '/repo/desktop';
    const bin = join(appPath, 'resources', 'bin', 'linux-x64', 'airbridge-core');
    expect(
      resolveCoreCommand({ isPackaged: false, resourcesPath: '/ignored', appPath, platform: 'linux', arch: 'x64', exists: (p) => p === bin }),
    ).toEqual({ command: bin, args: [] });
  });

  it('dev fallback: python + airbridge/main.py', () => {
    const appPath = '/repo/desktop';
    const main = resolve('/repo/airbridge/main.py');
    expect(resolveCoreCommand({ isPackaged: false, resourcesPath: '/r', appPath, platform: 'darwin', arch: 'arm64', exists: () => false })).toEqual({
      command: 'python3',
      args: [main],
    });
    expect(
      resolveCoreCommand({ isPackaged: false, resourcesPath: '/r', appPath, platform: 'win32', arch: 'x64', exists: () => false }).command,
    ).toBe('python');
    expect(
      resolveCoreCommand({ isPackaged: false, resourcesPath: '/r', appPath, platform: 'linux', arch: 'x64', exists: () => false, python: '/venv/bin/python' })
        .command,
    ).toBe('/venv/bin/python');
  });

  it('config file locations', () => {
    expect(mcpConfigLocation('claude', 'darwin')).toContain('Library/Application Support/Claude');
    expect(mcpConfigLocation('claude', 'win32')).toContain('%APPDATA%');
    expect(mcpConfigLocation('cursor', 'linux')).toBe('~/.cursor/mcp.json');
  });
});
