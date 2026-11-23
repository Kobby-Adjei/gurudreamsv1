# AirBridge Pro: Phase 2 Security

Scope: the Electron desktop app (`desktop/`), the local daemon control API
(`airbridge/airbridge_app/control.py`, `daemon.py`, `events.py`), the IPC bridge, the license
server (`license-server/`) and the licensing gate. The Phase-1 threat model
(`docs/SECURITY.md`) still applies to the inbox and the MCP outbox and is not repeated here.
Contract: `docs/PHASE2_PLAN.md`.

## 1. Architecture and trust boundaries

```
             ┌───────────────── user's machine ───────────────────────────────────┐
  Browser    │  Electron main (Node, privileged)                                  │
  (Clerk     │   ├─ security.ts: CSP, permission/navigation/popup policy          │
  sign-in,   │   ├─ auth/oidc.ts + tokenStore.ts (refresh token in safeStorage)   │
  Stripe     │   ├─ license/gate.ts → verify.ts (Ed25519, node:crypto only)       │
  Checkout)  │   ├─ processManager.ts ── spawn(env: AIRBRIDGE_CONTROL_TOKEN) ──┐  │
     ▲       │   ├─ controlClient.ts ── HTTP/WS 127.0.0.1:<port> Bearer ──┐    │  │
     │ B6    │   └─ ipc.ts  ◄── B2: contextBridge / ipcMain (validated) ─┐ │    │  │
     │       │  Renderer (sandboxed, contextIsolation, CSP 'self')       │ │    │  │
     │       │   └─ preload/index.ts exposes window.airbridge only ──────┘ │    │  │
     │       │                                                         B3  ▼    ▼  │
     │       │  airbridge-core --daemon (PyInstaller)                              │
     │       │   ├─ control API 127.0.0.1 (Host+Origin+Bearer guard)               │
     │       │   ├─ inbox <tailnet-ip>:8989  (Phase-1 controls) ◄── B4 tailnet     │
     │       │   └─ activity.jsonl (0600)  ◄── also written by MCP stdio process   │
     │       └─────────────────────────────────────────────────────────────────────┘
     │                    B5 HTTPS (Bearer Clerk JWT)
     └──────────────  license server (Hono) ── Stripe API / webhooks, Clerk JWKS, Postgres
```

| ID | Boundary | What crosses it |
|---|---|---|
| B1 | Remote content → renderer | Nothing by design: the renderer loads only bundled files; all network goes through main |
| B2 | Renderer → main (IPC) | Invoke calls on `ab:*` channels; the renderer is treated as untrusted |
| B3 | Main → daemon | Control API on loopback, per-launch bearer token |
| B4 | Tailnet → daemon inbox | Phase-1 boundary TB1 (unchanged) |
| B5 | Desktop → license server | Clerk OIDC token in, signed license token out |
| B6 | Stripe/Clerk → license server | Webhooks (signed), JWKS |
| B7 | Other local processes / users / browser tabs → loopback control port | The thing the guard exists for |

## 2. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Control token | Main-process memory, daemon env, daemon memory | Anyone holding it can drive `/send_task` (exfiltration path, see Phase-1 I2) |
| Clerk refresh token | `safeStorage` (Keychain / DPAPI / libsecret) via tokenStore.ts | Long-lived account access |
| Clerk access/id token | Main-process memory | License fetches |
| License token | Main process + on-disk cache (signed, not secret) | Gate state |
| License signing private key | License server env/secret store only | Forging licenses for everyone |
| Stripe secret key, webhook secret | License server env only | Billing fraud, fake subscription events |
| Activity log | `<DATA_DIR>/activity.jsonl` 0600 | Metadata about who sent what |
| The user's AI tools | Phase-1 asset | Still the real prize |

## 3. STRIDE

### 3.1 Desktop app (Electron)

| # | Threat | Control | Code / status |
|---|---|---|---|
| D-S1 | A remote page loaded in an app window impersonates the app and calls `window.airbridge` | Navigation to any non-app origin is blocked (`will-navigate`, `will-redirect`, `will-frame-navigate`); `window.open` always denied; IPC handlers check `isTrustedSender` (top-level frame + app origin) | `security.ts` `hardenWebContents`, `isTrustedSender`; SWE `ipc.ts` must call it in every handler |
| D-T1 | XSS in the renderer (event summaries, hostnames, error strings come from the network) | React escaping; CSP `script-src 'self'` with no `unsafe-inline`/`unsafe-eval`; secrets-scan test forbids `dangerouslySetInnerHTML`, `eval`, `new Function` in renderer sources; Phase-1 events are neutralised and length-capped | `CONTENT_SECURITY_POLICY`, `index.html` meta CSP, `tests/secrets-scan.test.ts` |
| D-E1 | XSS → Node/RCE | `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false` (also in workers/subframes), `webviewTag:false`, `app.enableSandbox()`; preload exposes a fixed Promise API, never `ipcRenderer` itself | `secureWebPreferences`, `enableGlobalSandbox` |
| D-E2 | XSS → abuse of the exposed API (e.g. `sendTask` to exfiltrate) | Not preventable by isolation alone: the API *is* the capability. Mitigated by CSP (no injected script), payload validation in main, and Phase-1 limits in the daemon | `ipc.ts` validation (SWE) |
| D-I1 | Renderer learns the control token or Clerk tokens | Tokens never cross IPC; renderer sources may not reference `process.env`, `AIRBRIDGE_CONTROL_TOKEN`, `electron`, `ipcRenderer`; built bundle is scanned | `tests/secrets-scan.test.ts` |
| D-I2 | Permission prompts (camera, mic, geolocation, notifications, HID/USB) | All denied; only `clipboard-sanitized-write` from the app origin is granted (Copy buttons). Device permission handler returns false | `applySecurityPolicies` |
| D-T2 | Malicious link in an event opens a phishing/`file:`/`smb:` URL | `shell.openExternal` only for https on 443, no userinfo, host in the allowlist (Stripe Checkout/Billing, `*.clerk.accounts.dev`, `*.clerk.com`, the AirBridge site, plus hosts passed in `extraExternalHosts` such as the license server) | `isAllowedExternalUrl` |
| D-T3 | Tampering with the app on disk / via Node flags (`ELECTRON_RUN_AS_NODE`, `--inspect`, `NODE_OPTIONS`) | Electron fuses (see §5) and asar integrity, code signing | electron-builder config (Systems) |
| D-S2 | Deep-link (`airbridge://`) injection: a web page triggers the protocol with a forged `code`/`state` | OIDC PKCE + `state` check in `oidc.ts`; deep links must be ignored unless a sign-in is in progress; parse with `new URL`, accept only the callback path | SWE `oidc.ts` |
| D-D1 | Second instance hijacks the deep link or spawns a second daemon | `requestSingleInstanceLock()` | `index.ts` (Systems) |
| D-R1 | Dev mocks enabled in production | `AIRBRIDGE_DEV_MOCKS` honoured only when `!app.isPackaged`; same rule for the dev CSP, devTools and `AIRBRIDGE_LICENSE_PUBKEYS` | `security.ts`, `publicKeys.ts`, `devMocks.ts` |

### 3.2 Daemon control API (`control.py`)

| # | Threat | Control | Verified by |
|---|---|---|---|
| C-S1 | Another machine reaches the API | Socket bound to `127.0.0.1` only (literal constant, no `host=` in uvicorn config); peer must be loopback | `test_phase2_security.py::test_bind_control_socket_binds_ipv4_loopback_only`, `test_control_server_config_has_no_host_and_quiet_logging`, `test_non_loopback_peer_is_403` |
| C-S2 | Another local process/user calls the API | Bearer token (32+ random bytes, per launch, env-only, never argv) compared with `hmac.compare_digest` | `test_missing_or_wrong_token_is_401`, `test_token_compared_in_constant_time`, `test_daemon_token_comes_from_env_not_argv` |
| C-S3 | A web page in the user's browser calls the API (CSRF, DNS rebinding, cross-site WS hijacking) | Any `Origin` header → 403/4403; `Host` must equal `127.0.0.1:<port>` exactly; bearer header cannot be set cross-origin without CORS preflight, and no CORS is served | `test_any_origin_header_is_403_even_with_token`, `test_wrong_host_is_403_even_with_token`, `test_websocket_with_origin_is_rejected` |
| C-S4 | WS without auth | Guard runs before routing: close 4401 | `test_websocket_without_token_closes_4401` |
| C-I1 | Token in logs | Not logged (AST test); 401 bodies do not echo it | `test_token_never_logged` |
| C-I2 | Activity log leaks task bodies | Events carry only type, peer, ≤120-char neutralised summary, bytes, file name, ≤200-char error; `events.py` never references task fields; file 0600, dir 0700 | `test_outbox_events_never_contain_task_or_code`, `test_inbox_events_never_contain_task_or_code`, `test_events_file_is_0600_and_dir_0700` |
| C-D1 | Large `/send_task` bodies | Declared and streamed size cap (Phase-1 limit + 4 KB), `ws_max_size` 64 KB | `control.py` |
| C-E1 | Daemon mode widens the inbox bind | Inbox host still goes through `validate_bind_host`; non-tailnet IPs → degraded, never bound | `test_daemon_refuses_non_tailnet_inbox_host`, AST test |
| C-T1 | Port squatting on Windows | `SO_EXCLUSIVEADDRUSE` | `bind_control_socket` |

Residual: a process running as the **same user** can read the daemon's environment
(`/proc/<pid>/environ`, debugger attach) and so the token. That is outside the boundary: a
same-user process can already read the Claude/Cursor config and the user's files.

### 3.3 IPC (renderer ↔ main)

Rules for `ipc.ts` / `preload/index.ts` (SWE), checked in review:

1. Every `ipcMain.handle` starts with `if (!isTrustedSender(event, allowedOrigin)) throw new Error('forbidden')`.
2. Every payload is validated (types, lengths, enums: `McpClient` ∈ {claude,cursor}, `limit` integer 1..1000, `SendTaskRequest` fields are strings within Phase-1 byte limits). Unknown keys rejected.
3. The preload exposes exactly the frozen `window.airbridge` key set; it never exposes `ipcRenderer`, `send`, `on` with arbitrary channel names, or Node objects. Listeners strip the `event` argument before calling user callbacks (the IPC event holds `sender`).
4. Push channels (`ab:*:changed`, `ab:backend:*`) are sent only to the app's own `webContents`.
5. No secrets in any response: `AuthState.user` is `{id,email,name?}` only; `LicenseStatus` has no token.

### 3.4 License server

See `license-server/SECURITY.md` for the full table. Summary: Stripe webhooks are verified on
the raw body with `constructEvent` (300 s tolerance) and are idempotent; subscription state is
re-fetched from Stripe rather than trusted from the event; `/v1/license/verify` requires a
Clerk JWT verified against JWKS with issuer and audience; tokens are signed with an Ed25519 key
held only in the server's secret store; responses are `no-store`.

### 3.5 Licensing bypass (honest assessment)

The desktop gate is a **deterrent, not DRM**. The app runs on the user's machine, so a
determined user can patch `gate.ts` out of the asar, run `airbridge-core --daemon` by hand, or
skip the app entirely and use the free Phase-1 MCP server, which needs no license.

What the design does guarantee:

| Attack | Result |
|---|---|
| Forge or edit a license token (change `status`, `exp`, `sub`, `plan`) | Fails: Ed25519 signature over header+payload (`bad_signature`) |
| `alg:none`, HS256 with the public key as HMAC secret, RS/ES alg confusion, `jwk`/`jku` header injection | Fails: header must be exactly `{alg:"EdDSA", typ, kid}`, verification is hard-wired to Ed25519 via `node:crypto` |
| Replay another user's token | Fails when `expectedSub` is passed (gate must pass the signed-in user id): `wrong_sub` |
| Keep using an old token after cancelling | Works until `exp` (72 h offline grace by design), then `expired`; re-checked every 6 h online |
| Set `AIRBRIDGE_LICENSE_PUBKEYS` to trust a self-made key | Ignored in packaged builds |
| Wind the clock back | Works for an expired cached token (client-side time). Mitigation: gate may store the max `iat` seen and treat `now < lastSeenIat - skew` as clock tampering (recommended, not required) |
| Patch the binary | Not prevented. Asar integrity + code signing make it visible and break auto-update, nothing more |

Server-side entitlements that matter (anything beyond the local app) must be enforced on the
server, not by the client gate.

### 3.6 Supply chain and distribution

| Risk | Control |
|---|---|
| Malicious or hijacked npm dependency | `package-lock.json` committed for `desktop/` and `license-server/`; CI uses `npm ci`; `npm audit --omit=dev` in CI; dependabot/renovate with review; keep the dependency set to the contract list. The renderer bundle gets only `react`/`react-dom` |
| Install scripts | Prefer `npm ci --ignore-scripts` in CI except for `electron` (which downloads its binary) and verify its checksum (electron's own SHASUMS check) |
| Python dependency drift | `requirements.txt` uses ranges. For release builds pin exact versions with hashes in `requirements-build.txt` (`pip install --require-hashes`), build in a clean venv per OS/arch |
| Tampered `airbridge-core` binary | Sign it: macOS Developer ID + hardened runtime + notarization (the embedded binary is signed inside the app bundle, not just the outer app); Windows Authenticode on both `airbridge-core.exe` and the installer. The app spawns the binary only from `resources/bin` inside the signed bundle, never from PATH |
| Unsigned onefile binary triggers AV / Gatekeeper | Expected until signing is in place (PLAN §5) |
| Auto-update hijack | If electron-updater is added: HTTPS feed + code-signature verification (default on macOS; set `publisherName` on Windows) |
| Secrets committed | `tests/secrets-scan.test.ts` (Stripe `sk_/rk_/whsec_`, Clerk `sk_`, PEM private keys, AWS/GitHub tokens) over `desktop/`, `license-server/`, `airbridge/`; `.env.example` must hold placeholders only; `license-server/.gitignore` ignores `.env` and `*.pem` |

## 4. Token and secret handling matrix

| Secret | Created by | Stored at rest | In memory | Crosses | Never |
|---|---|---|---|---|---|
| `AIRBRIDGE_CONTROL_TOKEN` | Main, `crypto.randomBytes(32)` base64url per daemon launch | Nowhere | Main (`controlClient`), daemon | Child env only (B3), `Authorization` header to 127.0.0.1 | argv, logs, disk, renderer, IPC |
| Clerk refresh token | Clerk (OIDC + PKCE) | `safeStorage`-encrypted file in userData (OS keychain key) | Main | HTTPS to Clerk | Renderer, logs, plain-text file |
| Clerk access / id token | Clerk | Not persisted | Main | HTTPS to license server (B5) | Renderer, logs |
| PKCE verifier / `state` | Main | Not persisted | Main, single use | Browser sees only the challenge and `state` | Reuse across attempts |
| License token | License server | Cached in userData (signed, not secret) | Main | IPC sends only `LicenseStatus` | Trusted without `verifyLicenseToken` |
| License public keys | Security / release | Compiled into main bundle (`MAIN_VITE_AIRBRIDGE_LICENSE_PUBKEYS`) | Main | — | Runtime override in packaged builds |
| License signing private key | `npm run keys:generate` on an admin machine | Server secret store (`LICENSE_SIGNING_KEY_PEM`) | License server | — | Repo, desktop app, logs, CI logs |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe dashboard | Server secret store | License server | HTTPS to Stripe | Repo, desktop, logs |
| `CLERK_OAUTH_CLIENT_ID` | Clerk | Desktop build config (public) | Main | Browser | Treated as a secret (it isn't) |
| `AIRBRIDGE_SECRET` (Phase 1) | User | MCP client config env | Daemon/MCP | `X-AirBridge-Secret` inside WireGuard | Logs |
| `DATABASE_URL` | Hosting provider | Server secret store | License server | TLS to Postgres | Repo |

## 5. Electron fuses (electron-builder)

Set in `electron-builder.yml` (Systems) via `electronFuses`:

```yaml
electronFuses:
  runAsNode: false                               # ELECTRON_RUN_AS_NODE can't turn the app into node
  enableNodeOptionsEnvironmentVariable: false    # NODE_OPTIONS ignored
  enableNodeCliInspectArguments: false           # --inspect / --inspect-brk ignored
  enableEmbeddedAsarIntegrityValidation: true    # asar hash checked against the signed Info.plist / resource
  onlyLoadAppFromAsar: true                      # no loose app/ directory side-loading
  enableCookieEncryption: true
  loadBrowserProcessSpecificV8Snapshot: false
  grantFileProtocolExtraPrivileges: false        # only if the renderer is not loaded via file:// (see note)
```

Note on `grantFileProtocolExtraPrivileges`: electron-vite loads the production renderer from
`file://`. Turning this fuse off requires serving the renderer through a custom
`protocol.handle('app', ...)` scheme instead. Until that migration, leave it at the default and
rely on the file-directory check in `isAppOrigin`. Also set `asar: true`, macOS
`hardenedRuntime: true` with minimal entitlements (`com.apple.security.cs.allow-jit` only if
required by V8; no `disable-library-validation` unless the embedded Python binary needs it), and
`notarize: true` in CI.

## 6. Implementation notes for other owners

* **index.ts (Systems):** call `enableGlobalSandbox(app)` before `ready`; call
  `applySecurityPolicies({app, session: session.defaultSession, isDev, allowedOrigin, devServerUrl})`
  after `ready` and before creating windows; create every `BrowserWindow` with
  `webPreferences: secureWebPreferences(preloadPath)`; pass `allowedOrigin` from `appOriginFor()`
  to `ipc.ts`. Pass the license server host in `extraExternalHosts` if checkout links go there.
* **processManager.ts (Systems):** spawn with an explicit `cwd` (the binary's directory or the
  data dir) so Windows' `shutil.which("tailscale")` can't pick up a planted `tailscale.exe` from
  the inherited working directory; put the token only in `env`; consider deleting
  `AIRBRIDGE_CONTROL_TOKEN` from the daemon's `os.environ` after reading it (child processes such as
  `tailscale`, `osascript` and PowerShell otherwise inherit it).
* **gate.ts (SWE):** always pass `expectedSub` = signed-in Clerk user id and
  `getLicensePublicKeys({isPackaged: app.isPackaged})`. Treat any `ok:false` as not licensed.
* **Renderer (UI/UX):** keep the meta CSP in `index.html` identical to `CONTENT_SECURITY_POLICY`
  (it is the only CSP for `file://` loads). For `npm run dev`, Vite's React-refresh preamble is an
  inline script, which that meta tag blocks; relax it only in dev (e.g. a `transformIndexHtml`
  plugin with `apply: 'serve'`), never in the built file. `frame-ancestors` is ignored in a meta
  tag; the header covers it where headers exist.

### verify.ts reason mapping (contract has no dedicated codes for these)

| Situation | Reason |
|---|---|
| Oversized (> 4096 chars), not 3 parts, bad/padded/non-canonical base64url, bad JSON, extra header fields, wrong `typ`, missing/ill-typed claims, `exp <= iat`, array `aud` | `malformed` |
| `alg` not exactly `EdDSA` | `bad_alg` |
| kid absent, or configured key not a valid Ed25519 SPKI public key | `unknown_kid` |
| Signature not 64 bytes or does not verify | `bad_signature` |
| `now >= exp + skew`, or `iat`/`nbf` more than `skew` in the future | `expired` |
| `plan !== "airbridge_pro"`, `status` not `active`/`trialing` | `inactive` |

`now` is epoch seconds; a `Date` or a millisecond value (> 1e11) is accepted. `skewSec` is
clamped to [0, 300].

### Public key injection

`publicKeys.ts` ships one clearly labelled dev key (`airbridge-dev-2026-11`) whose private half
was discarded at generation time, so it verifies nothing (fails closed). Release builds set
`MAIN_VITE_AIRBRIDGE_LICENSE_PUBKEYS='{"<kid>":"-----BEGIN PUBLIC KEY-----\n...\n"}'` at
`electron-vite build` time; the dev key is then not included. Rotation: ship the new kid next to
the old one, wait for clients to update, then switch the server's `LICENSE_KEY_ID`. Developers
can set `AIRBRIDGE_LICENSE_PUBKEYS` (same JSON) at run time in unpackaged builds only.

## 7. Sign-off checklist

Tick after review (Security engineer).

- [x] `secureWebPreferences`: contextIsolation, sandbox, nodeIntegration off (incl. workers/subframes), webSecurity, no insecure content, no webview, devTools only unpackaged (`tests/security.test.ts`)
- [x] Production CSP has no `unsafe-inline`/`unsafe-eval`/remote origins; dev CSP only for loopback dev server and never when packaged (`tests/security.test.ts`)
- [x] Renderer `index.html` carries the strict meta CSP (`tests/security.test.ts`)
- [x] Navigation, redirects, frame navigation, `window.open`, `<webview>` and permission requests denied; external links allowlisted to https (`tests/security.test.ts`)
- [x] `verifyLicenseToken`: tamper, `alg:none`, HS256/RS256 confusion, header injection, unknown kid, non-Ed25519 key, expiry, skew boundary, nbf/iat, aud/iss/sub, inactive status, wrong plan, oversized and non-canonical input all rejected (`tests/verify.test.ts`)
- [x] Only a public dev key in the repo; runtime key override disabled when packaged (`tests/verify.test.ts`)
- [x] Secrets scan clean; `.env.example` placeholders only; renderer sources free of `electron`/`ipcRenderer`/`process.env`/control token (`tests/secrets-scan.test.ts`)
- [x] Control API: 127.0.0.1 only, 401 without/with wrong token, 403 bad Host, 403 any Origin, WS 4401, constant-time compare, token not logged (`tests/test_phase2_security.py`)
- [x] Events: no task/code bodies, 0600 file / 0700 dir (`tests/test_phase2_security.py`)
- [x] Daemon inbox still bound only to the tailnet IP (`tests/test_phase2_security.py`)
- [ ] `ipc.ts` uses `isTrustedSender` on every handler and validates payloads (SWE; review when written)
- [ ] `index.ts` wires `enableGlobalSandbox`, `applySecurityPolicies`, `secureWebPreferences` and the single-instance lock (Systems; review when written)
- [ ] `gate.ts` passes `expectedSub` and `getLicensePublicKeys({isPackaged})` (SWE)
- [ ] Electron fuses and hardened runtime set in `electron-builder.yml` (Systems)
- [ ] Release pipeline: real license public key injected, binaries signed + notarized, `npm ci`, hashed Python build requirements (release owner)
- [ ] Built renderer bundle scanned (`npm run build` then `npx vitest run tests/secrets-scan.test.ts`)
