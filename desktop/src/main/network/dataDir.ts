/**
 * The shared per-user data dir `D` (PHASE3_PLAN.md "Spec deviation"): byte-for-byte the same rule as
 * Python `airbridge_app.config.default_data_dir()`, so the desktop app (NetManager writes
 * `<D>/network.json`, the sidecar's tsnet state, logs), the daemon and the MCP stdio process all agree.
 *
 *   AIRBRIDGE_DATA_DIR (stripped, `~` expanded)   overrides everything
 *   macOS    ~/Library/Application Support/AirBridge
 *   Windows  %APPDATA%\AirBridge   (fallback ~\AppData\Roaming\AirBridge)
 *   Linux    $XDG_DATA_HOME/airbridge (fallback ~/.local/share/airbridge)
 */
import { homedir as osHomedir } from 'node:os';
import { posix, win32 } from 'node:path';

export const APP_DIRNAME = 'AirBridge';

export interface DataDirOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/** Python `Path(raw).expanduser()` for the leading `~` / `~/...` form. */
function expandUser(raw: string, home: string, p: typeof posix): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return p.join(home, raw.slice(2));
  return raw;
}

export function defaultDataDir(o: DataDirOptions = {}): string {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const home = o.homedir ?? osHomedir();
  const p = platform === 'win32' ? win32 : posix;

  const override = (env.AIRBRIDGE_DATA_DIR ?? '').trim();
  if (override) return p.normalize(expandUser(override, home, p));

  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', APP_DIRNAME);
  if (platform === 'win32') {
    const appdata = (env.APPDATA ?? '').trim();
    const base = appdata ? appdata : p.join(home, 'AppData', 'Roaming');
    return p.join(base, APP_DIRNAME);
  }
  const xdg = (env.XDG_DATA_HOME ?? '').trim();
  const base = xdg ? expandUser(xdg, home, p) : p.join(home, '.local', 'share');
  return p.join(base, 'airbridge');
}
