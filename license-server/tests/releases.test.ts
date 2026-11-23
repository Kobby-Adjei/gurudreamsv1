import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';
import { createGithubOidcVerifier, GITHUB_OIDC_ISSUER } from '../src/githubOidc.js';
import { DownloadCounter, parseInstallerName, ReleaseStore } from '../src/releases.js';
import { JsonlWaitlistStore } from '../src/waitlist.js';
import { makeHarness } from './helpers.js';

const REPO = 'Kobby-Adjei/gurudreamsv1';
const REF = 'refs/heads/claude/airbridge-p2p-network-ha3opt';
const BUILD = '.github/workflows/desktop-build.yml';
const DEPLOY = '.github/workflows/server-deploy.yml';
const SHA = 'a'.repeat(40);
const ADMIN = 'b'.repeat(40);

async function github() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'gh-1', alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const mint = (claims: JWTPayload = {}, o: { aud?: string; iss?: string; wrongKey?: boolean; exp?: number } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      repository: REPO,
      ref: REF,
      sha: SHA,
      workflow_ref: `${REPO}/${BUILD}@${REF}`,
      run_id: '123456',
      run_number: '7',
      event_name: 'push',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'gh-1' })
      .setIssuer(o.iss ?? GITHUB_OIDC_ISSUER)
      .setAudience(o.aud ?? 'airbridge-releases')
      .setSubject(`repo:${REPO}:ref:${REF}`)
      .setIssuedAt(now)
      .setExpirationTime(o.exp ?? now + 300)
      .sign(o.wrongKey ? other.privateKey : privateKey);
  };
  return { jwks, mint };
}

async function setup(opts: { maxUploadBytes?: number; now?: () => number } = {}) {
  const gh = await github();
  const root = mkdtempSync(join(tmpdir(), 'ab-rel-'));
  const dir = join(root, 'releases');
  const deployDir = join(root, 'deploy');
  mkdirSync(deployDir);
  const store = new ReleaseStore(dir, opts.now);
  await store.init();
  const counter = new DownloadCounter(join(root, 'data', 'downloads', 'counts.json'));
  let ip = '198.51.100.7';
  const wl = new JsonlWaitlistStore(join(root, 'wl.jsonl'));
  wl.open();
  const h = await makeHarness({
    now: opts.now,
    getClientIp: () => ip,
    waitlist: { store: wl, adminToken: ADMIN },
    releases: {
      store,
      counter,
      verifyOidc: createGithubOidcVerifier({ jwks: gh.jwks }),
      releasePolicy: { repository: REPO, ref: REF, workflows: [BUILD], audience: 'airbridge-releases' },
      deployPolicy: { repository: REPO, ref: REF, workflows: [DEPLOY], audience: 'airbridge-deploy' },
      deployDir,
      maxUploadBytes: opts.maxUploadBytes,
    },
  });
  const upload = async (name: string, body: string | Uint8Array, token?: string) =>
    h.app.request(`/v1/releases/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body,
      headers: { authorization: `Bearer ${token ?? (await gh.mint())}`, 'content-type': 'application/octet-stream' },
    });
  const publish = async (version: string, token?: string) =>
    h.app.request('/v1/releases/publish', {
      method: 'POST',
      body: JSON.stringify({ version }),
      headers: { authorization: `Bearer ${token ?? (await gh.mint())}`, 'content-type': 'application/json' },
    });
  const count = (uri: string, extra: Record<string, string> = {}) =>
    h.app.request('/v1/downloads/count', { headers: { 'x-forwarded-method': 'GET', 'x-forwarded-uri': uri, ...extra } });
  const stats = async () =>
    (await (await h.app.request('/v1/waitlist/stats', { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as {
      downloads: { total: number; by_platform: Record<string, number> };
    };
  return { ...h, gh, dir, deployDir, store, counter, upload, publish, count, stats, setIp: (v: string) => (ip = v) };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('installer names', () => {
  it('accepts only the whitelisted pattern', () => {
    expect(parseInstallerName('AirBridge-Pro-0.2.0-mac-arm64.dmg')).toEqual({ version: '0.2.0', platform: 'mac', arch: 'arm64', kind: 'dmg' });
    expect(parseInstallerName('AirBridge-Pro-1.0.0-beta.2-win-x64.exe')?.version).toBe('1.0.0-beta.2');
    for (const bad of [
      'AirBridge-Pro-0.2.0-mac-arm64.exe',
      'AirBridge-Pro-0.2.0-win-x64.dmg',
      '../AirBridge-Pro-0.2.0-mac-x64.dmg',
      'AirBridge-Pro-0.2.0-linux-x64.AppImage',
      'AirBridge Pro-0.2.0-arm64.dmg',
      'latest.json',
      'AirBridge-Pro-0.2.0-mac-arm64.dmg/x',
    ]) {
      expect(parseInstallerName(bad), bad).toBeNull();
    }
  });
});

describe('GitHub OIDC', () => {
  it('rejects missing, forged, wrong-audience, wrong-issuer and expired tokens', async () => {
    const t = await setup();
    const name = 'AirBridge-Pro-0.2.0-mac-arm64.dmg';
    expect((await t.app.request(`/v1/releases/upload?name=${name}`, { method: 'POST', body: 'x' })).status).toBe(401);
    expect((await t.upload(name, 'x', await t.gh.mint({}, { wrongKey: true }))).status).toBe(401);
    expect((await t.upload(name, 'x', await t.gh.mint({}, { aud: 'airbridge-deploy' }))).status).toBe(401);
    expect((await t.upload(name, 'x', await t.gh.mint({}, { iss: 'https://evil.example' }))).status).toBe(401);
    expect((await t.upload(name, 'x', await t.gh.mint({}, { exp: Math.floor(Date.now() / 1000) - 120 }))).status).toBe(401);
  });

  it('rejects other repositories, branches, workflows and events', async () => {
    const t = await setup();
    const name = 'AirBridge-Pro-0.2.0-mac-arm64.dmg';
    const cases: [JWTPayload, string][] = [
      [{ repository: 'someone/fork' }, 'wrong_repository'],
      [{ ref: 'refs/heads/main' }, 'wrong_ref'],
      [{ workflow_ref: `${REPO}/.github/workflows/other.yml@${REF}` }, 'wrong_workflow'],
      [{ workflow_ref: `${REPO}/${BUILD}@refs/heads/main` }, 'wrong_workflow'],
      [{ workflow_ref: `someone/fork/${BUILD}@${REF}` }, 'wrong_workflow'],
      [{ event_name: 'pull_request' }, 'wrong_event'],
      [{ sha: 'nothex' }, 'bad_sha'],
    ];
    for (const [claims, reason] of cases) {
      const res = await t.upload(name, 'x', await t.gh.mint(claims));
      expect(res.status, reason).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe(reason);
    }
    expect(readdirSync(t.dir).filter((n) => !n.startsWith('.'))).toEqual([]);
  });
});

describe('upload + publish', () => {
  it('streams files to <version>-<sha7>/, hashes them and writes latest.json', async () => {
    const t = await setup();
    const files: Record<string, string> = {
      'AirBridge-Pro-0.2.0-mac-arm64.dmg': 'arm bytes '.repeat(1000),
      'AirBridge-Pro-0.2.0-mac-x64.dmg': 'intel bytes',
      'AirBridge-Pro-0.2.0-win-x64.exe': 'windows bytes',
    };
    for (const [name, body] of Object.entries(files)) {
      const res = await t.upload(name, body);
      expect(res.status).toBe(201);
      const j = (await res.json()) as { sha256: string; size: number; url: string };
      expect(j.sha256).toBe(sha256(body));
      expect(j.size).toBe(body.length);
      expect(j.url).toBe(`/downloads/0.2.0-aaaaaaa/${name}`);
      const st = statSync(join(t.dir, '0.2.0-aaaaaaa', name));
      expect(st.mode & 0o777).toBe(0o644);
    }
    expect(readdirSync(join(t.dir, '.incoming'))).toEqual([]);
    const res = await t.publish('0.2.0');
    expect(res.status).toBe(200);
    const latest = JSON.parse(readFileSync(join(t.dir, 'latest.json'), 'utf8'));
    expect(latest.version).toBe('0.2.0');
    expect(latest.commit).toBe(SHA);
    expect(latest.previous).toBeNull();
    expect(latest.files.map((f: { platform: string; arch: string }) => `${f.platform}-${f.arch}`)).toEqual(['mac-arm64', 'mac-x64', 'win-x64']);
    for (const f of latest.files) expect(f.sha256).toBe(sha256(files[f.name]!));
    expect(statSync(join(t.dir, 'latest.json')).mode & 0o777).toBe(0o644);
    // A published release is immutable.
    expect((await t.upload('AirBridge-Pro-0.2.0-mac-x64.dmg', 'other')).status).toBe(409);
  });

  it('refuses bad names, empty and oversized bodies without leaving files behind', async () => {
    const t = await setup({ maxUploadBytes: 1024 });
    expect((await t.upload('evil.sh', 'x')).status).toBe(400);
    expect((await t.upload('AirBridge-Pro-0.2.0-mac-x64.dmg', 'x'.repeat(2048))).status).toBe(413);
    // Streamed without Content-Length: the cap is enforced while writing.
    const stream = new ReadableStream({
      start(ctl) {
        for (let i = 0; i < 4; i++) ctl.enqueue(new Uint8Array(600));
        ctl.close();
      },
    });
    const res = await t.app.request('/v1/releases/upload?name=AirBridge-Pro-0.2.0-mac-x64.dmg', {
      method: 'POST',
      body: stream,
      headers: { authorization: `Bearer ${await t.gh.mint()}` },
      duplex: 'half',
    });
    expect(res.status).toBe(413);
    expect(readdirSync(join(t.dir, '.incoming'))).toEqual([]);
    expect(existsSync(join(t.dir, '0.2.0-aaaaaaa', 'AirBridge-Pro-0.2.0-mac-x64.dmg'))).toBe(false);
    expect((await t.publish('0.2.0')).status).toBe(400);
    expect((await t.publish('../x')).status).toBe(400);
  });

  it('keeps the previous release for rollback and prunes beyond three', async () => {
    let now = Date.now();
    const t = await setup({ now: () => now });
    const shas = ['1', '2', '3', '4'].map((d) => d.repeat(40));
    for (const [i, sha] of shas.entries()) {
      now += 1000;
      const tok = await t.gh.mint({ sha });
      expect((await t.upload(`AirBridge-Pro-0.2.${i}-win-x64.exe`, `v${i}`, tok)).status).toBe(201);
      expect((await t.publish(`0.2.${i}`, tok)).status).toBe(200);
    }
    const latest = JSON.parse(readFileSync(join(t.dir, 'latest.json'), 'utf8'));
    expect(latest.id).toBe('0.2.3-4444444');
    expect(latest.previous).toEqual({ id: '0.2.2-3333333', version: '0.2.2' });
    const dirs = readdirSync(t.dir).filter((n) => !n.startsWith('.') && !n.endsWith('.json')).sort();
    expect(dirs).toEqual(['0.2.1-2222222', '0.2.2-3333333', '0.2.3-4444444']);

    // Unpublished uploads (a failed run) are pruned after a day, not before.
    const orphan = await t.gh.mint({ sha: '9'.repeat(40) });
    expect((await t.upload('AirBridge-Pro-0.3.0-win-x64.exe', 'orphan', orphan)).status).toBe(201);
    const tok5 = await t.gh.mint({ sha: '5'.repeat(40) });
    await t.upload('AirBridge-Pro-0.2.4-win-x64.exe', 'v4', tok5);
    await t.publish('0.2.4', tok5);
    expect(existsSync(join(t.dir, '0.3.0-9999999'))).toBe(true);
    const old = new Date(Date.now() - 2 * 86400_000);
    utimesSync(join(t.dir, '0.3.0-9999999'), old, old);
    const tok6 = await t.gh.mint({ sha: '6'.repeat(40) });
    await t.upload('AirBridge-Pro-0.2.5-win-x64.exe', 'v5', tok6);
    await t.publish('0.2.5', tok6);
    expect(existsSync(join(t.dir, '0.3.0-9999999'))).toBe(false);

    // Rollback: admin only, to a kept release.
    const rb = (id: string, auth = ADMIN) =>
      t.app.request('/v1/releases/rollback', { method: 'POST', body: JSON.stringify({ id }), headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' } });
    expect((await rb('0.2.4-5555555', 'c'.repeat(40))).status).toBe(401);
    expect((await rb('0.2.0-1111111')).status).toBe(404);
    expect((await rb('0.2.4-5555555')).status).toBe(200);
    expect(JSON.parse(readFileSync(join(t.dir, 'latest.json'), 'utf8')).id).toBe('0.2.4-5555555');
  });
});

describe('download counts', () => {
  it('counts full and first-range GETs once per client and file, and reports them in waitlist stats', async () => {
    const t = await setup();
    const a = '/downloads/0.2.0-aaaaaaa/AirBridge-Pro-0.2.0-mac-arm64.dmg';
    const w = '/downloads/0.2.0-aaaaaaa/AirBridge-Pro-0.2.0-win-x64.exe';
    expect((await t.count(a)).status).toBe(200);
    await t.count(a); // same client again: not counted
    await t.count(a, { range: 'bytes=1000-' }); // resume: not counted
    await t.count(a, { 'x-forwarded-method': 'HEAD' });
    await t.count('/downloads/latest.json');
    await t.count('/downloads/../../etc/passwd');
    t.setIp('198.51.100.8');
    await t.count(a, { range: 'bytes=0-' });
    await t.count(w);
    const s = await t.stats();
    expect(s.downloads.total).toBe(3);
    expect(s.downloads.by_platform).toEqual({ 'mac-arm64': 2, 'win-x64': 1 });
    await t.counter.flush();
    const again = new DownloadCounter((t.counter as unknown as { file: string }).file);
    expect(again.stats().total).toBe(3);
  });
});

describe('self-deploy request', () => {
  it('writes the commit from a server-deploy token only', async () => {
    const t = await setup();
    const deployTok = (c: JWTPayload = {}) =>
      t.gh.mint({ workflow_ref: `${REPO}/${DEPLOY}@${REF}`, sha: 'c'.repeat(40), ...c }, { aud: 'airbridge-deploy' });
    const post = (tok: string) => t.app.request('/v1/deploy', { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
    expect((await post(await t.gh.mint({}, { aud: 'airbridge-deploy' }))).status).toBe(401); // build workflow
    expect((await post(await t.gh.mint({ workflow_ref: `${REPO}/${DEPLOY}@${REF}` }))).status).toBe(401); // wrong aud
    expect((await post(await deployTok({ ref: 'refs/heads/main', workflow_ref: `${REPO}/${DEPLOY}@refs/heads/main` }))).status).toBe(401);
    expect(existsSync(join(t.deployDir, 'request.json'))).toBe(false);
    const res = await post(await deployTok());
    expect(res.status).toBe(202);
    const req = JSON.parse(readFileSync(join(t.deployDir, 'request.json'), 'utf8'));
    expect(req.commit).toBe('c'.repeat(40));
    const st = (await (await t.app.request('/v1/deploy/status')).json()) as { state: string };
    expect(st.state).toBe('unknown');
  });
});
