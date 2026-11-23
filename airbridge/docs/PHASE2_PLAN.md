# AirBridge Pro — Phase 2 Build Plan (PM, frozen contract)

Phase-1 contracts in `airbridge/docs/PLAN.md` remain frozen unless changed here. Paths are repo-root-relative.
The root React app is off-limits. `desktop/` and `license-server/` each have their own `package.json` + `tsconfig.json`.

## 0. Shared npm dependencies (Systems creates `desktop/package.json` FIRST and runs `npm install`)
Others must NOT edit `desktop/package.json`; if a dep is missing, say so in your report.
desktop deps: `react@18 react-dom@18`; devDeps: `electron@33 electron-vite@2 vite@5 @vitejs/plugin-react typescript@5 tailwindcss@3 postcss autoprefixer vitest@2 jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event axe-core electron-builder @types/react @types/react-dom @types/node`.
Scripts: `dev`, `build`, `test` (`vitest run`), `typecheck`, `dist`. vitest config: `environment: 'jsdom'` for `tests/renderer/**`, node elsewhere.
license-server: SWE owns its own package.json (`stripe jose hono @hono/node-server` or express; vitest; typescript).

## 1. Ownership (one owner per file)
| Owner | Files |
|---|---|
| **Systems** | `airbridge/main.py` (`--daemon`), `airbridge_app/config.py`, NEW `airbridge_app/events.py`, `control.py`, `daemon.py`; Phase-2 edits to `inbox.py` + `outbox.py` (emit events; add `send_task_result()` structured helper); `requirements.txt`, `pyproject.toml`, `airbridge/build_backend.sh`, `build_backend.ps1`, `airbridge-core.spec`, `requirements-build.txt`, `airbridge/tests/test_events.py`, `test_control.py`, `test_daemon.py`, `test_build_spec.py`; `desktop/package.json`, `desktop/tsconfig*.json`, `desktop/electron.vite.config.ts`, `desktop/vitest.config.ts`, `desktop/electron-builder.yml`, `desktop/src/main/index.ts`, `src/main/processManager.ts`, `src/main/controlClient.ts`, `desktop/tests/processManager.test.ts` |
| **SWE** | `license-server/**` (except `SECURITY.md`); `desktop/src/shared/types.ts`, `src/shared/ipcChannels.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/auth/oidc.ts`, `src/main/auth/tokenStore.ts`, `src/main/license/gate.ts`, `src/main/mcpConfig.ts`, `src/main/devMocks.ts`, `desktop/.env.example`, `desktop/tests/{licenseGate,ipc,preload,mcpConfig}.test.ts` |
| **UI/UX** | `desktop/src/renderer/**` (index.html, main.tsx, App, views: SwarmMap, ActivityFeed, Settings, Onboarding/SignIn/Paywall/Starting; components; design tokens), `desktop/tailwind.config.ts`, `desktop/postcss.config.js`, `desktop/tests/renderer/*.test.tsx`, `desktop/README.md` |
| **Security** | `desktop/src/main/security.ts` (webPreferences, CSP, navigation/permission handlers), `src/main/license/verify.ts`, `src/main/license/publicKeys.ts`, `desktop/tests/{security,verify,secrets-scan}.test.ts`, `docs/PHASE2_SECURITY.md`, `license-server/SECURITY.md`, `airbridge/tests/test_phase2_security.py` |

## 2. Interface contracts
**Env vars.** Daemon: `AIRBRIDGE_CONTROL_TOKEN` (≥32 random bytes base64url; required else exit 2), `AIRBRIDGE_CONTROL_PORT` (0 = ephemeral), `AIRBRIDGE_DATA_DIR`, `AIRBRIDGE_PARENT_PID`; Phase-1 vars unchanged. On ready the daemon writes ONE stderr line: `AIRBRIDGE_READY {"control_port":N,"pid":P}`. Never stdout.
License server: `STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID_PRO, CLERK_ISSUER, CLERK_JWKS_URL, CLERK_AUDIENCE, LICENSE_SIGNING_KEY_PEM (Ed25519 PKCS8), LICENSE_KEY_ID, LICENSE_TTL_SECONDS=259200, DATABASE_URL`.
Desktop: `AIRBRIDGE_LICENSE_URL`, `CLERK_OAUTH_ISSUER`, `CLERK_OAUTH_CLIENT_ID` (public), `AIRBRIDGE_DEV_MOCKS` (honored only when `!app.isPackaged`).

**Control API** (binds `127.0.0.1` only). Every request needs `Authorization: Bearer <token>` (`hmac.compare_digest`); `Host` must equal `127.0.0.1:<port>` (anti DNS-rebinding); any request with an `Origin` header is rejected. WS auth: same bearer header.
- `GET /status` → `{version, mode:"daemon", tailnet_ip, inbox:{listening:bool, port:8989, degraded_reason:str|null}, uptime_s}`
- `GET /nodes` → `{self:{hostname, ip, os}, nodes:[{hostname, ip, os, online:bool, last_seen:str|null}], error:str|null}`
- `GET /events?limit=100&after_id=` → `{events:[Event]}`
- `WS /events/stream` → one Event JSON per text frame; close 4401 on bad auth
- `POST /send_task {target_hostname, task_description, code_payload?}` → 200 `{ok:true, file, target}` | 4xx/502 `{ok:false, error}` (Phase-1 validation/limits)

**Event (JSONL v1).** `{v:1, id:uuid4, ts:ISO8601Z, type, origin:"daemon"|"mcp", local_node, peer:str|null, summary:str(≤120, neutralized), detail:{bytes?, file?, error?}}`; `type ∈ task_received|task_sent|send_failed|node_online|node_offline|inbox_listening|inbox_degraded|daemon_started|daemon_stopping`. Never write task/code bodies. File `<DATA_DIR>/activity.jsonl`, 0o600, single-line O_APPEND writes, rotate 5 MB × 3 with file lock. API: `events.emit(type, *, peer=None, summary="", **detail) -> None` (never raises); `events.tail(after_id=None) -> AsyncIterator[Event]`. Default DATA_DIR: macOS `~/Library/Application Support/AirBridge`, Windows `%APPDATA%\AirBridge`, Linux `~/.local/share/airbridge`.

**Shared TS types** (`desktop/src/shared/types.ts`, SWE): `BackendStatus`, `Node`, `NodesResponse`, `AirEvent`, `SendTaskRequest`, `SendTaskResult`, `AuthState {state:"signed_out"|"signing_in"|"signed_in", user?:{id,email,name?}}`, `LicenseStatus {state:"valid"|"grace"|"inactive"|"unknown", plan:string|null, exp:number|null}`, `BackendLifecycle {phase:"stopped"|"starting"|"running"|"crashed"|"blocked", detail?:string}`, `McpClient = "claude"|"cursor"`, and `AirbridgeApi` (shape below). Mirror the Python shapes exactly.

**Preload `window.airbridge`** (frozen; Promise-based):
`auth:{getState(), signIn(), signOut(), onChange(cb)→unsub}`; `license:{getStatus(), refresh(), openCheckout(), onChange(cb)→unsub}` (amended by tech lead: added onChange for `ab:license:changed`); `backend:{getStatus(), getLifecycle(), getNodes(), getEvents(limit), sendTask(req), onEvent(cb)→unsub, onStatus(cb)→unsub, onLifecycle(cb)→unsub}`; `settings:{getMcpConfig(client)→{json:string}, copyMcpConfig(client)}`; `app:{version, platform}`.
**IPC channels**: invoke `ab:auth:get|signin|signout`, `ab:license:get|refresh|checkout`, `ab:backend:status|lifecycle|nodes|events|send`, `ab:settings:mcp|copy`; push `ab:auth:changed`, `ab:license:changed`, `ab:backend:event`, `ab:backend:status`, `ab:backend:lifecycle`. Main validates `event.senderFrame.url` against the app origin and validates every payload. Renderer never sees the control token or Clerk tokens.

**License token**: compact JWS, header `{alg:"EdDSA", typ:"airbridge-license+jwt", kid}`, payload `{iss:"airbridge-license", aud:"airbridge-desktop", sub:<clerk user id>, plan:"airbridge_pro", status, iat, exp}`.
`verifyLicenseToken(token, {publicKeys:Record<kid,string /*PEM SPKI*/>, expectedSub?, now?, skewSec=60}) → {ok:true, claims} | {ok:false, reason:"malformed"|"unknown_kid"|"bad_alg"|"bad_signature"|"expired"|"wrong_aud"|"wrong_iss"|"wrong_sub"|"inactive"}` — `node:crypto` Ed25519; accepts status `active|trialing` only. `publicKeys.ts` exports `LICENSE_PUBLIC_KEYS` (dev placeholder key, clearly labeled; real key injected at build).

**License server**: `POST /v1/stripe/webhook` (raw body + `stripe.webhooks.constructEvent`; checkout.session.completed, customer.subscription.created|updated|deleted; map via `metadata.clerk_user_id`; idempotent on `event.id`); `POST /v1/license/verify` (Bearer Clerk JWT verified against JWKS, iss/aud) → 200 `{token,status,exp}` | 401 | 402 `{status, checkout_url}`; `POST /v1/billing/checkout` → `{url}`; `GET /healthz`. `SubscriptionStore` interface with in-memory + Postgres implementations.

**Gate flow**: launch → Clerk OIDC auth-code + PKCE in system browser via `airbridge://` deep link (refresh token in `safeStorage`) → verify → local signature check → cache token, offline OK until `exp` (72h) → `processManager.start()` ONLY on ok → re-check every 6h; invalid → stop backend, show Paywall. Dev mocks (`AIRBRIDGE_DEV_MOCKS=1`, unpackaged only): fake signed-in user + valid license + mock backend data so the UI is demoable.

**Process manager** (`processManager.ts`): spawn `resources/bin/airbridge-core[.exe] --daemon` with `windowsHide:true`, `stdio:["ignore","ignore","pipe"]`, token in env only; parse `AIRBRIDGE_READY`; restart with backoff (max 5); stop = SIGTERM → kill after 3 s (Windows `taskkill /T /F`), on `before-quit`; daemon self-exits if `AIRBRIDGE_PARENT_PID` dies; single-instance lock in `index.ts`. In dev, may run `python airbridge/main.py --daemon` when binary absent.

**PyInstaller**: console bootloader (a `--noconsole` build sets `sys.stdout=None`, which breaks MCP stdio; hide via `windowsHide`/CREATE_NO_WINDOW instead). `--onefile`, `--collect-all uvicorn fastapi starlette mcp pydantic anyio websockets` + `uvicorn.*.auto` hidden imports. Output → `desktop/resources/bin/<os>-<arch>/`. Default (no flag) mode = MCP stdio, so MCP config points to this binary.

## 3. Acceptance tests (offline; no real Clerk/Stripe/Tailscale)
- **Systems** (pytest): event schema, 0o600, rotation, 2-process concurrent appends no torn lines; Control API 401/403 for no token, bad Host, Origin; binds only 127.0.0.1; WS delivers appended event <1 s; `/nodes` & `/send_task` with mocked network/requests; daemon exits 2 without token; spec includes required hidden imports. (vitest) backend not spawned without license; kill on quit; token in env not argv.
- **SWE** (vitest): webhook bad signature → 400; subscription transitions persisted; mock JWKS (locally generated keys) → token accepted by `verify.ts`; inactive → 402; gate cache/offline grace/expiry stops backend; preload exposes exactly the frozen key set; IPC rejects foreign frames.
- **UI/UX** (vitest + Testing Library, mocked `window.airbridge`): Swarm Map green Online dots + empty state explaining Tailscale; feed renders "Received task from MacBook" / "Sent code to Desktop-PC"; Copy buttons; onboarding states (signed out / paywall / starting / ready); axe no violations; system dark mode; full keyboard access.
- **Security**: webPreferences (contextIsolation, sandbox, no nodeIntegration, webSecurity); CSP `default-src 'self'; connect-src 'self'` no unsafe-eval; deny navigation/window.open/permissions; verify rejects tamper, `alg:none`, wrong kid, expiry, skew; secrets scan (no `sk_live`/`sk_test`/PEM private keys committed); token absent from renderer bundle; Python control-host bind test + AST inbox-bind rule; STRIDE in `PHASE2_SECURITY.md`.

## 4. Definition of done
`pytest -q` green; `npm test` green in `desktop/` and `license-server/` (offline); `build_backend.sh` produces a working `airbridge-core` (`--check`, daemon start, MCP stdio handshake); `npm run dev` with `AIRBRIDGE_DEV_MOCKS=1` shows all views with live events; inactive license never spawns backend; `.env.example` placeholders only; Security sign-off in `PHASE2_SECURITY.md`.

## 5. Honest limits
No real Stripe/Clerk/Tailscale accounts here (mocks/placeholders only). Real distribution needs Apple Developer ID signing + notarization (hardened runtime entitlements for the embedded binary) and Windows Authenticode; unsigned onefile binaries trip Gatekeeper/SmartScreen/AV. PyInstaller can't cross-compile (CI runner per OS/arch). Onefile adds ~1–2 s startup. A client-side gate deters casual misuse, it isn't DRM. Clerk OAuth app + Stripe webhooks require a deployed HTTPS host.
