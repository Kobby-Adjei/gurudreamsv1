/**
 * Repository secrets scan + renderer-bundle leak checks (Security-owned).
 *
 * Scans desktop/, license-server/ and airbridge/ (skipping dependency/build dirs) for
 * real-looking Stripe/Clerk secrets, webhook secrets, private-key PEMs and (Phase 3) Tailscale /
 * Headscale pre-auth + API keys, literal --auth-key values, and committed key drops / tailscaled state. Obvious placeholders
 * (REPLACE_ME, xxx, example, ...) are allowlisted. Patterns are assembled from fragments so this
 * file does not match itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
const ROOTS = ['desktop', 'license-server', 'airbridge'].map((d) => join(REPO, d));
const SKIP_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'out',
  'release',
  'build',
  '__pycache__',
  '.git',
  '.pytest_cache',
  '.mypy_cache',
  'coverage',
]);
const SKIP_REL = [join('desktop', 'resources', 'bin')];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const P = (...parts: string[]) => parts.join('');
const DASH5 = '-'.repeat(5);

interface Rule {
  name: string;
  re: RegExp;
}
const RULES: Rule[] = [
  // Stripe secret / restricted keys and Clerk secret keys (Clerk also uses sk_live_/sk_test_).
  { name: 'stripe/clerk secret key', re: new RegExp(P('\\b(?:sk|rk)_(?:live|test)_', '[A-Za-z0-9]{16,}'), 'g') },
  { name: 'stripe webhook secret', re: new RegExp(P('\\bwhsec_', '[A-Za-z0-9+/=]{20,}'), 'g') },
  {
    name: 'private key PEM',
    re: new RegExp(P(DASH5, 'BEGIN (?:[A-Z0-9]+ )*PRIV', 'ATE KEY', DASH5), 'g'),
  },
  { name: 'aws access key id', re: new RegExp(P('\\bAK', 'IA[0-9A-Z]{16}\\b'), 'g') },
  { name: 'github token', re: new RegExp(P('\\bgh[pousr]_', '[A-Za-z0-9]{36,}\\b'), 'g') },
  // Phase 3: Tailscale-format keys (tskey-auth-<id>-<secret>, tskey-client-, tskey-api-).
  { name: 'tailscale key', re: new RegExp(P('\\bts', 'key-[a-z]+-[A-Za-z0-9]{6,}-[A-Za-z0-9]{16,}'), 'g') },
  // Headscale v0.29 pre-auth / API keys: hskey-{auth|api}-{12-char prefix}-{secret}. The masked
  // display form "hskey-auth-<prefix>-***" never matches (needs >= 16 secret chars).
  { name: 'headscale key', re: new RegExp(P('\\bhs', 'key-(?:auth|api)-[A-Za-z0-9_-]{12}-[A-Za-z0-9_-]{16,}'), 'g') },
  // Legacy Headscale API key ("<7-10 char prefix>.<secret>") or any value assigned to a
  // Headscale/Tailscale key variable in config/env/compose/source.
  {
    name: 'headscale/tailscale key assignment',
    re: new RegExp(
      P(
        '\\b(?:HEADSCALE_API_KEY|HEADSCALE_APIKEY|TS_AUTH_?KEY|TAILSCALE_AUTH_?KEY|PREAUTH_KEY|AUTH_KEY)',
        '\\s*[:=]\\s*["\']?([A-Za-z0-9._~+/-]{20,})',
      ),
      'g',
    ),
  },
  // A literal key on a tailscale command line (only --auth-key=file:<path> is allowed).
  { name: 'auth key in argv', re: new RegExp(P('--auth-?key[= ]["\']?', '(?!file:)[A-Za-z0-9_-]{20,}'), 'g') },
];

/** Files that must never be committed at all (enrollment key drops, tailscaled state). */
const FORBIDDEN_FILES: Array<[string, RegExp]> = [
  ['enrollment key file', /(?:^|[\\/])\.authkey(?:-[^\\/]*)?$/],
  ['tailscaled state', /(?:^|[\\/])tailscaled\.state$/],
  ['tailscaled state dir', /(?:^|[\\/])tailscaled[\\/](?:tailscaled\.state|derpmap\.cached\.json|files[\\/])/],
  ['network.json', /(?:^|[\\/])network\.json$/],
];

/** Only obviously-fake values are allowed. */
const PLACEHOLDER_RE = /x{3,}|replace|placeholder|example|dummy|fake|changeme|your[_-]|redacted|<.*>|\.\.\./i;

function isPlaceholder(match: string, line: string, rule: Rule): boolean {
  if (rule.name === 'private key PEM') {
    // A PEM header is only OK in a doc/comment line that clearly isn't a key (no base64 body follows).
    return false;
  }
  if (PLACEHOLDER_RE.test(match)) return true;
  if (rule.name === 'headscale/tailscale key assignment') {
    // Only the captured value matters; references like `process.env.X` / `${X}` / config lookups are fine.
    const value = match.replace(/^[^:=]*[:=]\s*["']?/, '');
    if (/^(?:process\.env|env\.|config\.|opts\.|cfg\.|settings\.)/.test(value)) return true;
    if (/^[A-Za-z_.]+$/.test(value) && !/\d/.test(value)) return true; // identifiers, not secrets
    return new Set(value).size < 8;
  }
  // Very low-entropy bodies (e.g. sk_test_0000000000000000) are fake.
  const body = match.replace(/^[a-z]+_(?:live_|test_)?/, '');
  if (new Set(body).size < 6) return true;
  void line;
  return false;
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const rel = relative(REPO, full);
    if (SKIP_DIRS.has(name) || SKIP_REL.some((s) => rel === s || rel.startsWith(s + sep))) continue;
    if (existsSync(join(full, 'pyvenv.cfg'))) continue; // any Python virtualenv (.venv, .build-venv, ...)
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && st.size <= MAX_FILE_BYTES) yield full;
  }
}

function readText(file: string): string | null {
  const buf = readFileSync(file);
  if (buf.includes(0)) return null; // binary
  return buf.toString('utf8');
}

interface Finding {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

function isSkipped(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p) || /venv/i.test(p))) return true;
  return SKIP_REL.some((s) => rel === s || rel.startsWith(s + sep) || rel.startsWith(s + '/'));
}

/**
 * Files that are (or would be) committed: tracked + untracked-but-not-ignored, via git.
 * Falls back to a directory walk when git is unavailable.
 */
function candidateFiles(): string[] {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'desktop', 'license-server', 'airbridge'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split('\0')
      .filter((rel) => rel && !isSkipped(rel))
      .map((rel) => join(REPO, rel))
      .filter((f) => {
        try {
          const st = statSync(f);
          return st.isFile() && st.size <= MAX_FILE_BYTES;
        } catch {
          return false;
        }
      });
  } catch {
    return ROOTS.filter((r) => existsSync(r)).flatMap((r) => [...walk(r)]);
  }
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  {
    for (const file of candidateFiles()) {
      const text = readText(file);
      if (text === null) continue;
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const rule of RULES) {
          rule.re.lastIndex = 0;
          for (const m of line.matchAll(rule.re)) {
            if (isPlaceholder(m[0], line, rule)) continue;
            findings.push({
              file: relative(REPO, file),
              line: i + 1,
              rule: rule.name,
              // Never echo the full secret into CI logs.
              snippet: m[0].slice(0, 12) + '…',
            });
          }
        }
      });
    }
  }
  return findings;
}

describe('secrets scan', () => {
  it('rules detect real-looking secrets and allow obvious placeholders (self-test)', () => {
    const find = (s: string) =>
      RULES.flatMap((r) => [...s.matchAll(new RegExp(r.re.source, 'g'))].filter((m) => !isPlaceholder(m[0], s, r)));
    expect(find(P('sk_', 'live_', '51Hq8ZkLmNoPqRsTuVwXyZ012345'))).toHaveLength(1);
    expect(find(P('sk_', 'test_', '4eC39HqLyjWDarjtT1zdp7dc'))).toHaveLength(1);
    expect(find(P('rk_', 'live_', 'aB3dE5gH7jK9mN1pQ3sT5vX7'))).toHaveLength(1);
    expect(find(P('wh', 'sec_', 'Qm9vYmFyQmF6UXV4MTIzNDU2Nzg5'))).toHaveLength(1);
    expect(find(P(DASH5, 'BEGIN PRIV', 'ATE KEY', DASH5))).toHaveLength(1);
    expect(find(P(DASH5, 'BEGIN OPENSSH PRIV', 'ATE KEY', DASH5))).toHaveLength(1);
    expect(find(P(DASH5, 'BEGIN EC PRIV', 'ATE KEY', DASH5))).toHaveLength(1);
    // placeholders
    expect(find(P('sk_', 'test_', 'xxxxxxxxxxxxxxxxxxxxxxxx'))).toHaveLength(0);
    expect(find(P('sk_', 'live_', 'REPLACE_ME_WITH_REAL_KEY'))).toHaveLength(0);
    expect(find(P('sk_', 'test_', '0000000000000000000000'))).toHaveLength(0);
    expect(find(P('wh', 'sec_', 'your_webhook_secret_goes_here'))).toHaveLength(0);
    expect(find('STRIPE_SECRET_KEY=REPLACE_ME')).toHaveLength(0);
    // Phase 3: Tailscale / Headscale keys
    expect(find(P('ts', 'key-auth-', 'kQ7wXz3CNTRL-', 'Zk2mN8pQ4rS6tU1vW3xY5aB7cD9eF'))).toHaveLength(1);
    expect(find(P('ts', 'key-client-', 'kAbCdEf123-', 'q1W2e3R4t5Y6u7I8o9P0aSdF'))).toHaveLength(1);
    expect(find(P('hs', 'key-auth-', 'a1B2c3D4e5F6', '-', 'Q9w8E7r6T5y4U3i2O1p0LkJhGfDsAzXc'))).toHaveLength(1);
    expect(find(P('hs', 'key-api-', 'Zx9Yw8Vu7Ts6', '-', 'mN3bV5cX7zL9kJ1hG3fD5sA7qW9eR1tY'))).toHaveLength(1);
    expect(find(P('HEADSCALE_', 'API_KEY=', 'Ab3dEf.9kLmN0pQr5sTuV7wXyZ1a2B3c4D'))).toHaveLength(1);
    expect(find(P('tailscale up --auth', '-key=', 'Zk2mN8pQ4rS6tU1vW3xY5aB7'))).toHaveLength(1);
    // allowed
    expect(find(P('hs', 'key-auth-', 'a1B2c3D4e5F6', '-***'))).toHaveLength(0); // Headscale's masked form
    expect(find(P('ts', 'key-auth-', 'xxxxxxxxxxxx-', 'xxxxxxxxxxxxxxxxxxxxxxxx'))).toHaveLength(0);
    expect(find(P('--auth', '-key=file:', '/Users/me/Library/Application Support/AirBridge/.authkey-abc'))).toHaveLength(0);
    expect(find(P('HEADSCALE_', 'API_KEY=', 'REPLACE_ME_WITH_HEADSCALE_API_KEY'))).toHaveLength(0);
    expect(find(P('HEADSCALE_', 'API_KEY: process.env.HEADSCALE_API_KEY_FROM_ENVIRONMENT'))).toHaveLength(0);
    expect(find(P('HEADSCALE_', 'API_KEY=', ''))).toHaveLength(0);
  });

  it('forbidden-file rules match key drops and tailscaled state (self-test)', () => {
    const hit = (p: string) => FORBIDDEN_FILES.some(([, re]) => re.test(p));
    expect(hit('desktop/.authkey-3f9a')).toBe(true);
    expect(hit('airbridge/data/.authkey')).toBe(true);
    expect(hit('x/tailscaled/tailscaled.state')).toBe(true);
    expect(hit('x/tailscaled.state')).toBe(true);
    expect(hit('desktop/network.json')).toBe(true);
    expect(hit('desktop/src/main/network/enroll.ts')).toBe(false);
    expect(hit('desktop/package.json')).toBe(false);
  });

  it('no enrollment key files, tailscaled state or network.json are committed', () => {
    const offenders = candidateFiles()
      .map((f) => relative(REPO, f))
      .filter((rel) => FORBIDDEN_FILES.some(([, re]) => re.test(rel)));
    expect(offenders).toEqual([]);
  });

  it('no committed secrets in desktop/, license-server/, airbridge/', () => {
    const files = candidateFiles();
    expect(files.length).toBeGreaterThan(20); // the scan really ran
    expect(files.some((f) => f.endsWith(join('license', 'publicKeys.ts')))).toBe(true);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    const findings = scan();
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('.env.example files contain placeholders only for secret-bearing keys', () => {
    const files = [join(REPO, 'desktop', '.env.example'), join(REPO, 'license-server', '.env.example')];
    for (const f of files) {
      if (!existsSync(f)) continue;
      for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (!/SECRET|PRIVATE|SIGNING_KEY|_PEM$|PASSWORD|API_KEY|CONTROL_TOKEN|AUTH_?KEY$|PREAUTH_KEY/.test(key)) continue;
        expect(value === '' || PLACEHOLDER_RE.test(value), `${relative(REPO, f)}: ${key} must be a placeholder`).toBe(true);
      }
    }
  });
});

describe('renderer isolation', () => {
  const rendererSrc = join(REPO, 'desktop', 'src', 'renderer');
  const FORBIDDEN_SRC: Array<[string, RegExp]> = [
    ['electron import', /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/],
    ['ipcRenderer', /\bipcRenderer\b/],
    ['control token', /AIRBRIDGE_CONTROL_TOKEN/],
    ['node builtins', /from\s+['"]node:|require\(\s*['"](?:fs|child_process|net|http)['"]\s*\)/],
    ['process.env', /\bprocess\.env\b/],
    ['tailscale/headscale key', /\b(?:ts|hs)key-|HEADSCALE_API_KEY|authKey|auth_key/],
    ['eval', /\beval\s*\(|new\s+Function\s*\(/],
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ];

  it('renderer sources do not touch Node/Electron/secrets', () => {
    if (!existsSync(rendererSrc)) return;
    const problems: string[] = [];
    for (const file of walk(rendererSrc)) {
      if (!/\.(ts|tsx|js|jsx|html)$/.test(file)) continue;
      const text = readText(file) ?? '';
      for (const [name, re] of FORBIDDEN_SRC) {
        if (re.test(text)) problems.push(`${relative(REPO, file)}: ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('built renderer bundle (if present) leaks no control token, ipcRenderer or secrets', () => {
    const outDir = join(REPO, 'desktop', 'out', 'renderer');
    if (!existsSync(outDir)) return; // not built in this run
    const problems: string[] = [];
    const walkAll = function* (d: string): Generator<string> {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) yield* walkAll(f);
        else yield f;
      }
    };
    for (const file of walkAll(outDir)) {
      const text = readText(file);
      if (text === null) continue;
      if (/AIRBRIDGE_CONTROL_TOKEN/.test(text)) problems.push(`${file}: AIRBRIDGE_CONTROL_TOKEN`);
      if (/\bipcRenderer\b/.test(text)) problems.push(`${file}: ipcRenderer`);
      if (/LICENSE_SIGNING_KEY|STRIPE_SECRET_KEY|CLERK_SECRET|HEADSCALE_API_KEY/.test(text)) problems.push(`${file}: server secret name`);
      for (const rule of RULES) {
        for (const m of text.matchAll(new RegExp(rule.re.source, 'g'))) {
          if (!isPlaceholder(m[0], '', rule)) problems.push(`${file}: ${rule.name}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
