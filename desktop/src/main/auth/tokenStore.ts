/**
 * Persists the Clerk refresh token (+ non-secret profile) encrypted with Electron safeStorage
 * (Keychain / DPAPI / libsecret) in a 0600 file under userData.
 *
 * If OS-backed encryption is unavailable (or Linux falls back to the "basic_text" backend, which
 * is plaintext in disguise) we REFUSE to persist: the session lives in memory only and the user
 * signs in again next launch.
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { AuthUser } from '../../shared/types';

export interface StoredSession {
  refreshToken: string;
  user: AuthUser;
}

export interface TokenStore {
  load(): Promise<StoredSession | null>;
  /** Returns false when the session could not be persisted securely (kept in memory only). */
  save(session: StoredSession): Promise<boolean>;
  clear(): Promise<void>;
  readonly persistent: boolean;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
  getSelectedStorageBackend?(): string;
}

const MAGIC = 'ABT1';

export function canPersistSecurely(safeStorage: SafeStorageLike, platform: string = process.platform): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === 'basic_text' || backend === 'unknown') return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isStoredSession(v: unknown): v is StoredSession {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const u = o.user as Record<string, unknown> | undefined;
  return (
    typeof o.refreshToken === 'string' &&
    o.refreshToken.length > 0 &&
    o.refreshToken.length < 8192 &&
    !!u &&
    typeof u.id === 'string' &&
    typeof u.email === 'string' &&
    (u.name === undefined || typeof u.name === 'string')
  );
}

export function createSafeStorageTokenStore(opts: {
  filePath: string;
  safeStorage: SafeStorageLike;
  platform?: string;
}): TokenStore {
  const { filePath, safeStorage } = opts;
  const secure = () => canPersistSecurely(safeStorage, opts.platform);
  let memory: StoredSession | null = null;

  return {
    get persistent() {
      return secure();
    },
    async load() {
      if (memory) return memory;
      if (!secure()) return null;
      try {
        const buf = await fs.readFile(filePath);
        if (buf.subarray(0, 4).toString('ascii') !== MAGIC) return null;
        const parsed: unknown = JSON.parse(safeStorage.decryptString(buf.subarray(4)));
        if (!isStoredSession(parsed)) return null;
        memory = parsed;
        return parsed;
      } catch {
        return null; // missing, corrupt, or keychain denied -> signed out
      }
    },
    async save(session) {
      memory = session;
      if (!secure()) {
        await fs.rm(filePath, { force: true }).catch(() => undefined);
        return false;
      }
      const enc = safeStorage.encryptString(JSON.stringify(session));
      const data = Buffer.concat([Buffer.from(MAGIC, 'ascii'), enc]);
      await fs.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.rename(tmp, filePath);
      return true;
    },
    async clear() {
      memory = null;
      await fs.rm(filePath, { force: true }).catch(() => undefined);
    },
  };
}
