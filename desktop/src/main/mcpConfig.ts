/**
 * MCP client configuration snippets (Claude Desktop / Cursor) pointing at the bundled
 * `airbridge-core` binary. The binary's default mode (no args) is MCP stdio.
 *
 * Packaged:  <process.resourcesPath>/bin/<platform>-<arch>/airbridge-core[.exe]
 * Dev:       <repo>/desktop/resources/bin/<platform>-<arch>/airbridge-core[.exe] if built,
 *            else python3 (python on Windows) <repo>/airbridge/main.py
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { McpClient } from '../shared/types';

export const MCP_SERVER_NAME = 'airbridge';

export interface CoreCommand {
  command: string;
  args: string[];
}

export interface ResolveCoreOptions {
  isPackaged: boolean;
  /** process.resourcesPath (packaged) */
  resourcesPath: string;
  /** app.getAppPath() — the desktop/ dir in dev */
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (p: string) => boolean;
  /** Dev override for the Python interpreter (AIRBRIDGE_PYTHON). */
  python?: string;
}

export function coreBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'airbridge-core.exe' : 'airbridge-core';
}

/** `<platform>-<arch>` directory name, e.g. darwin-arm64, win32-x64, linux-x64. */
export function platformDir(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}

export function packagedCorePath(resourcesPath: string, platform: NodeJS.Platform, arch: string): string {
  return join(resourcesPath, 'bin', platformDir(platform, arch), coreBinaryName(platform));
}

export function resolveCoreCommand(o: ResolveCoreOptions): CoreCommand {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const exists = o.exists ?? existsSync;
  if (o.isPackaged) {
    return { command: packagedCorePath(o.resourcesPath, platform, arch), args: [] };
  }
  const devBinary = join(o.appPath, 'resources', 'bin', platformDir(platform, arch), coreBinaryName(platform));
  if (exists(devBinary)) return { command: devBinary, args: [] };
  const mainPy = resolve(o.appPath, '..', 'airbridge', 'main.py');
  const python = o.python || (platform === 'win32' ? 'python' : 'python3');
  return { command: python, args: [mainPy] };
}

/** Both Claude Desktop (claude_desktop_config.json) and Cursor (~/.cursor/mcp.json) use the `mcpServers` shape. */
export function buildMcpConfig(client: McpClient, cmd: CoreCommand): Record<string, unknown> {
  const server: Record<string, unknown> = { command: cmd.command, args: [...cmd.args] };
  if (client === 'cursor') server.type = 'stdio';
  return { mcpServers: { [MCP_SERVER_NAME]: server } };
}

export function getMcpConfigJson(client: McpClient, o: ResolveCoreOptions): string {
  return JSON.stringify(buildMcpConfig(client, resolveCoreCommand(o)), null, 2);
}

/** Where the user should paste the snippet (shown in Settings copy by UI). */
export function mcpConfigLocation(client: McpClient, platform: NodeJS.Platform = process.platform): string {
  if (client === 'cursor') return platform === 'win32' ? '%USERPROFILE%\\.cursor\\mcp.json' : '~/.cursor/mcp.json';
  if (platform === 'darwin') return '~/Library/Application Support/Claude/claude_desktop_config.json';
  if (platform === 'win32') return '%APPDATA%\\Claude\\claude_desktop_config.json';
  return '~/.config/Claude/claude_desktop_config.json';
}
