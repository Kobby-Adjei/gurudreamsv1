# AirBridge Phase 3 — Invisible Network (PM plan, frozen contract)

Decision (product owner): control server = **self-hosted Headscale v0.29.7** (one Headscale user per AirBridge customer, isolated with `autogroup:self`). Tailscale client v1.104.7 built from source. Phase 1/2 contracts still apply unless changed here. Paths are repo-root-relative.

Verified in source (PM):
- Headscale v0.29.7: go.mod needs Go 1.27.3 → `GOTOOLCHAIN=auto`; `autogroup:self` supported (CHANGELOG #3036, #3501); `CreatePreAuthKeyRequest{user: uint64 id, reusable, ephemeral, expiration, acl_tags}`.
- Tailscale v1.104.7 (Go 1.27.4): netstack forwards inbound to `127.0.0.1:<port>` and calls `pm.RegisterIPPortIdentity` (netstack.go:1857); LocalAPI WhoIs resolves `127.0.0.1:<srcport>` via `ProxyMapper().WhoIsIPPort` (local.go:1785); `up --auth-key=file:` supported (up.go:102); `--no-logs-no-support` exists.

**Spec deviation:** state lives in the shared data dir `D` = Python `config.default_data_dir()` (macOS `~/Library/Application Support/AirBridge`, Windows `%APPDATA%\AirBridge`, Linux `~/.local/share/airbridge`), not `~/.airbridge`.

## 1. Ownership (one owner per file)
| Owner | Files |
|---|---|
| **Systems** | `desktop/scripts/build-tailscale.sh`, `.ps1`, `desktop/scripts/tailscale-mod/{go.mod,go.sum}`, `desktop/resources/tailscale/**` (gitignored binaries; manifest + licenses committed only if small text), `desktop/src/main/network/TailscaleManager.ts`, `src/main/network/dataDir.ts`, `src/main/index.ts`, `src/main/processManager.ts`, `electron-builder.yml`, `desktop/package.json`; Python: new `airbridge_app/netbackend.py`, `network.py`, `config.py`, `inbox.py`, `outbox.py`, `daemon.py`, `control.py`, `requirements*.txt`, `airbridge-core.spec`; tests `desktop/tests/{tailscaleManager,dataDir}.test.ts`, `airbridge/tests/{test_netbackend,test_embedded_daemon}.py`, `airbridge/tests/integration/test_real_tailnet.py` (stretch) |
| **SWE** | `license-server/src/{headscale.ts,network.ts}`, `app.ts` wiring, `config.ts`, `license-server/headscale/**` (config.yaml.tmpl, policy.hujson, docker-compose.yml, Caddyfile, README.md), `license-server/tests/network.test.ts`, `license-server/README.md`, `.env.example`; `desktop/src/main/network/enroll.ts`, `src/shared/{types,ipcChannels}.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/devMocks.ts`, `desktop/tests/{enroll,ipc,preload}.test.ts` |
| **UI/UX** | `desktop/src/renderer/**` (App error states, Devices map, Settings, SignIn, Paywall, SendTaskSheet copy, new `PrivateNetworkCard`), `desktop/tests/renderer/*`, `desktop/README.md`, `airbridge/README.md` (CLI path still documents installing Tailscale) |
| **Security** | `airbridge_app/security.py` (`verify_embedded_peer`), `airbridge/tests/test_phase3_security.py`, `desktop/tests/secrets-scan.test.ts` (extend), `airbridge/docs/PHASE3_SECURITY.md`; review (not edit) of `license-server/headscale/policy.hujson`, enroll.ts, TailscaleManager.ts, netbackend.py |

## 2. Interface contracts
**tailscaled argv** (fixed order, never user-controlled): `--tun=userspace-networking --statedir=<D>/tailscaled --socket=<S> --socks5-server=127.0.0.1:<P> --port=0 --no-logs-no-support`.
- `<S>` Unix: `<D>/tailscaled.sock`; if > 100 bytes (macOS sun_path limit) use `$TMPDIR/airbridge-<uid>/ts.sock` in a 0700 dir. Windows: `\\.\pipe\airbridge-tailscaled-<sha256(username)[:12]>`.
- `<P>`: free ephemeral port chosen at spawn.
- Env scrubbed to PATH, HOME/USERPROFILE/APPDATA/LOCALAPPDATA, TMPDIR/TEMP, SystemRoot (Windows), `TS_NO_LOGS_NO_SUPPORT=true`.

**`<D>/network.json`** (0600, atomic write by TailscaleManager): `{"v":1,"socket":S,"socks5":"127.0.0.1:P","pid":N,"bin":"<abs tailscaled path>","login_server":URL,"enrolled_sub_hash":"sha256(clerk sub)"}`.

**Env vars:** `AIRBRIDGE_NETWORK=auto|embedded|system` (default auto); `AIRBRIDGE_TS_SOCKET`, `AIRBRIDGE_TS_SOCKS5` (ProcessManager → daemon; MCP stdio process reads network.json instead); `AIRBRIDGE_HMAC_SECRET` optional. License server: `HEADSCALE_URL`, `HEADSCALE_API_KEY`, `HEADSCALE_PUBLIC_URL`, `PREAUTH_TTL_SECONDS=600`.

**Python `netbackend.py`:** `NetBackend` protocol: `local_ip()`, `peers()->{host: ip}`, `peer_details()` (for /nodes: hostname, ip, os, online, last_seen), `resolve(host)`, `inbound_bind_host()` (system: tailnet IP; embedded: `127.0.0.1`), `requests_proxies()` (system: None; embedded: `{"http": "socks5h://127.0.0.1:P"}`), `whois(remote_addr)->{node, user_id}|None`, `self_user_id()`. Implementations: `SystemTailscale` (Phase-1 CLI code, unchanged behavior) and `EmbeddedTailscale` (LocalAPI only `GET /localapi/v0/status`, `GET /localapi/v0/whois?addr=127.0.0.1:<port>`; HTTP/1.1 over AF_UNIX or Windows named pipe `open(r'\\.\pipe\…','r+b')`; headers `Host: local-tailscaled.sock`, `Sec-Tailscale: localapi`). Selection: env override → network.json present and socket answers → embedded → else system; network.json present but socket dead and no system Tailscale → error "AirBridge network is off — open the AirBridge app". Embedded peers are reported without the `airbridge-` hostname prefix; `resolve()` accepts with or without it. Existing `network.get_local_tailscale_ip/get_airbridge_peers/resolve_peer` keep their signatures and delegate to the selected backend.

**Inbound auth (embedded):** client must be 127.0.0.1 → `whois(client host:port)` must resolve, else 403 → `whois.user_id == self_user_id()`, else 403 → optional HMAC/secret → validation → 201 as before. `is_tailnet_ip` check is skipped only in this path. Implemented via `security.verify_embedded_peer(...)` (Security) called from inbox.py (Systems).

**TailscaleManager API:** `start(): Promise<void>`, `stop(): Promise<void>`, `status(): Promise<NetStatus>`, `up(authKeyFile, hostname, loginServer)`, `logout()`, `on('status', cb)`; `NetStatus = {state:'stopped'|'starting'|'needs_login'|'connecting'|'connected'|'error', detail?, ip?}`. Health: `tailscale --socket=S status --json` every 5 s. Restart backoff 1,2,4…30 s; 5 failures in 2 min → `error`. Stop: SIGTERM → SIGKILL after 3 s; Windows `taskkill /PID /T /F`. Spawn: `windowsHide`, `detached:false`, `cwd=<D>`. Logs `<D>/logs/tailscaled.log` rotated 5 MB × 3. Stale cleanup on startup: if network.json pid is alive AND its executable path equals our bundled binary → kill; else ignore (pid reuse). Runs under the single-instance lock.

**Enrollment (`enroll.ts`):** enroll only if status NeedsLogin/NoState, or login_server / sub hash differs (then `logout` first) → `POST /v1/network/preauth-key` with Clerk token → write key to `<D>/.authkey-<rand>` (0600; Windows: user-only ACL) → `tailscale --socket=S up --reset --login-server=L --auth-key=file:<f> --hostname=airbridge-<sanitized [a-z0-9-] ≤50> --accept-routes=false --accept-dns=false --timeout=60s` → unlink key file in `finally`. Key never logged, never in argv.

**Startup order:** license valid → `tm.start()` → `ensureEnrolled()` → `pm.start()` with TS env. Sign-out → `logout` → `tm.stop()`. `before-quit`: stop daemon, then tailscaled.

**IPC additions:** invoke `ab:network:status` → `NetStatus`, `ab:network:retry` → `NetStatus` (tech-lead amendment: restarts tailscaled if stopped/error and re-runs ensureEnrolled); push `ab:network:changed`. Preload adds `network:{getStatus(), retry(), onChange(cb)→unsub}`. No other surface changes.

**License server:** `POST /v1/network/preauth-key` — Clerk JWT + `isEntitled(status)` else 401/402; rate limit 5/min/user + 1000/day global; ensure Headscale user `name = "u-" + sha256(sub)[:20]` (no PII) via `GET /api/v1/user?name=` then `POST /api/v1/user` (409 → re-GET); `POST /api/v1/preauthkey {user:id, reusable:false, ephemeral:false, expiration: now+600s}` → `200 {auth_key, login_server, expires_at}` with `Cache-Control: no-store`. `POST /v1/network/devices/:id/remove` — `GET /api/v1/node/:id`, user mismatch → 404, else DELETE. Headscale errors → 502 without upstream body.

**Headscale kit:** `policy.hujson` = `{"acls":[{"action":"accept","src":["autogroup:member"],"dst":["autogroup:self:8989"]}]}` (port restriction matters: userspace forwarding would otherwise expose all localhost ports). `config.yaml.tmpl`: `node.expiry: 0`, `dns.magic_dns: false`, embedded DERP + STUN 3478/udp, `derp.urls: []` (no Tailscale public DERP), SQLite; gRPC/API reachable only by the license server. docker-compose: `headscale/headscale:v0.29.7` + Caddy TLS. README: API key rotation (`headscale apikeys create --expiration 90d`), backups.

## 3. Build
`build-tailscale.sh [os arch]`: `cd scripts/tailscale-mod && GOTOOLCHAIN=auto CGO_ENABLED=0 GOOS GOARCH go build -trimpath -ldflags "-s -w" -o ../../resources/tailscale/<platform>-<arch>/ tailscale.com/cmd/tailscaled tailscale.com/cmd/tailscale` (pinned module because `go install pkg@ver` can't cross-compile with GOBIN). Writes `manifest.json` (version + sha256 per file), copies Tailscale BSD-3 LICENSE to `resources/licenses/`. electron-builder: extraResources `resources/tailscale/${platform}-${arch}` + licenses; `mac.binaries` so both are signed (hardened runtime) and notarized.

## 4. Acceptance tests
- **Offline Python:** fake LocalAPI on a unix socket → backend selection, peers, whois, `inbound_bind_host` == 127.0.0.1; loopback with unknown whois → 403; different-user whois → 403; same-user → 201; outbox passes socks5h proxies with `trust_env=False`; all Phase 1/2 tests green.
- **Offline TS:** fake tailscaled (node script): spawn argv/env, no key in argv, backoff, stop escalation, stale-pid kill vs pid-reuse no-op, enroll flow, key file deleted even on failure, dataDir parity with Python (table test).
- **License server:** mocked Headscale fetch → 401/402/429, idempotent user creation, single-use non-ephemeral 600 s keys, cross-user remove → 404.
- **Renderer:** copy scan — no "Tailscale" in app-path UI strings.
- **Stretch (real, Linux, Systems):** build tailscaled + headscale v0.29.7 from source, headscale on localhost HTTP; three userspace tailscaled (A1, A2 user A; B1 user B) with own statedir/socket/SOCKS port. Assert A1 → A2:8989 via SOCKS works and whois resolves A1; B1 → A2 blocked; local curl straight to 127.0.0.1:8989 → 403.

## 5. Definition of done
App path never mentions or needs system Tailscale; shows "Private network: Connected/Connecting"; restart reuses state (no new key); no tailscaled left after quit on any OS, forced crash cleaned up on next launch; no secrets in logs/argv (secrets scan green); PHASE3_SECURITY.md signed off; all suites green.

## 6. Risks
Headscale ops burden (uptime, DB backups, upgrades, API-key rotation). Own DERP = single point of failure for NAT'd users (budget a second region). Windows: unprivileged userspace tailscaled (console, not service) + custom pipe name unproven — day-1 spike; fallback default pipe name with per-user suffix. macOS: `CGO_ENABLED=0` tailscaled needs the same spike. SOCKS5 proxy is unauthenticated: any local process can reach the user's own devices (ACL limits to :8989). macOS notarization of extra binaries. ~2×30 MB per platform. Go 1.27 toolchain download needed in CI. Trademark: no "Tailscale" in branding/UI; license notices only. Subscription lapse: nodes stay enrolled → follow-up: Stripe webhook expires user's nodes.

## 7. Tech-lead amendments after security review (see PHASE3_SECURITY.md F-1…F-12)
- **F-1 (critical):** netstack forwards ALL inbound tailnet ports to 127.0.0.1. Control API and tailscaled SOCKS5 bind to `[::1]` (never 127.0.0.1) so they're unreachable from the tailnet regardless of ACL; `network.json.socks5` becomes `"[::1]:P"`. Policy is exactly `{"action":"accept","proto":"tcp","src":["autogroup:member"],"dst":["autogroup:self:8989"]}`; license server verifies `GET /api/v1/policy` at boot and refuses to mint keys on mismatch; never send `acl_tags`.
- **F-3:** Caddy 404s `/api/*` and `/swagger*` publicly; license server reaches Headscale over an internal network; gRPC loopback only.
- **F-4 (Windows):** custom pipe requires `--windows-mode=dev`; pipe name gets a random per-launch suffix (recorded in network.json); Python verifies pipe owner where feasible.
- **F-5:** inbox applies a global concurrency semaphore + token bucket before any LocalAPI whois call.
- **F-2/F-7:** whois always `proto=tcp`; prefer `Node.Name` (done).
- **F-8:** `<D>` and socket dir 0700 with lstat/owner checks; `read_network_json` rejects files not owned by the user or group/other-writable.

## 8. Preview mode — license wired, not enforced (product owner, until app approval)
- Build-time flag `MAIN_VITE_AIRBRIDGE_ENFORCE_LICENSE` (`"1"` = enforce). **Default for now: not enforced.** Compile-time only, so a packaged build can't be flipped by env at runtime.
- Not enforced: no sign-in wall and no Paywall; backend always starts. Sign-in remains available (Settings → Account) and the gate still runs in **shadow mode**: verifies normally, logs the would-be verdict, exposes `LicenseStatus.state` as-is plus `enforced:false`, but never blocks `processManager.start()`.
- Network in preview: if signed in AND license server/Headscale configured → embedded network enrollment as designed; otherwise run the backend with `AIRBRIDGE_NETWORK=system` (user's own Tailscale), so the app is fully testable today without any servers.
- License server: env `ENFORCE_ENTITLEMENT` (default `true` in production config; set `false` during preview) — when false, `/v1/network/preauth-key` issues keys to any signed-in Clerk user (still rate-limited, still logs entitlement).
- UI: quiet "Preview" label in the account footer; Paywall and Subscribe stay reachable from Settings → Account ("Plans") but never block.
- Turning on enforcement = set both flags; documented in desktop/README.md "Launch checklist".
