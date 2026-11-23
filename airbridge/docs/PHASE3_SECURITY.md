# AirBridge Phase 3 — Security Review ("Invisible Network", tsnet sidecar)

Owner: Security. Scope: the embedded **`airbridge-net` tsnet sidecar** (`tailscale.com/tsnet` v1.104.7) that
replaced bundled `tailscaled` (commit 43a26c0, contract `docs/PHASE3_PLAN.md` §9). The sidecar enrolls into
self-hosted Headscale v0.29.7 with single-use pre-auth keys from the license server.

Reviewed code:
- `desktop/sidecar/airbridge-net/*.go`
- `desktop/src/main/network/{NetManager.ts,enroll.ts}`
- `desktop/src/main/processManager.ts` (NetworkSupervisor)
- `airbridge/airbridge_app/{netbackend,inbox,outbox,daemon,config}.py`

Upstream code was checked against the module zips from `proxy.golang.org` (`tailscale.com@v1.104.7`,
`github.com/juanfont/headscale@v0.29.7`).
- Sidecar refs: `desktop/sidecar/airbridge-net/<file>:<line>`.
- Upstream refs: `<pkg path>:<line>` in those trees.

**Verdict: APPROVED (conditional on S-1 for the privacy claim).**
- The sidecar removes the structural problems of the tailscaled design: localhost port exposure (old F-1),
  the ProxyMapper/whois trust chain (F-2, F-5, F-6), the LocalAPI socket and pipe (F-4, F-8), and the open
  SOCKS proxy (F-9).
- No finding breaks the trust model.
- One finding contradicts the product claim that nothing talks to Tailscale-operated hosts: when DNS fails,
  tsnet's bootstrap-DNS fallback contacts Tailscale's DERP servers (S-1).

---

## 1. Trust model

```
peer device ──WireGuard──▶ tsnet netstack (in airbridge-net)
                            │  only listener: tcp/8989 (main.go:159)
                            ▼
                     meshHandler (mesh.go)
                       1. WhoIsProto("tcp", r.RemoteAddr) on the live conn
                       2. UserProfile.ID == Node.User == Self.UserID
                       3. per-peer rate limit, 600 000 B cap
                            │  NEW request to http://127.0.0.1:<inbox port>/incoming_task
                            │  X-AirBridge-Sidecar-Token, X-AirBridge-Peer-Node/IP/User
                            ▼
                     Python inbox (inbox.py sidecar mode)
                       loopback + token (compare_digest) → peer headers → validation
                       → sender bound to the verified node (F-13, reject on mismatch)
```

- tsnet does **not** forward unhandled flows to host loopback. `getTCPHandlerForFlow` returns
  `nil, true // don't handle, don't forward to localhost` (`tsnet/tsnet.go:1289-1303`), and the same holds
  for UDP (`tsnet.go:1305-1311`).
- The only port that exists on the mesh is :8989. The user's localhost services are unreachable from peers
  **regardless of the ACL**, which is now defense in depth. The ACL still limits peers to tcp/8989, which also
  hides tsnet's PeerAPI.
- `r.RemoteAddr` on a tsnet listener is the peer's real tailnet `IP:port` (the source IP is bound to the
  peer's WireGuard key). `WhoIs` resolves it via `NodeByAddr` directly, so no proxymap or 180 ms retry loop is
  involved.

## 2. Findings (sidecar)

### S-1 (Medium, privacy/contract; fix required for the "no Tailscale-operated hosts" claim) — bootstrap-DNS fallback contacts Tailscale DERP servers
- The control client resolves the Headscale hostname through `dnscache.Resolver{LookupIPFallback:
  dnsfallback.MakeLookupFunc(...)}` (`control/controlclient/direct.go:324-330`,
  `control/controlhttp/client.go:372-377`).
- If the system resolver errors or returns no IPs (offline, captive portal, broken or filtering DNS),
  `dnscache` calls the fallback (`net/dnscache/dnscache.go:373-382`).
- The fallback queries up to 6 servers from the **DERP map compiled into the binary**
  (`net/dnsfallback/dnsfallback.go:76-125`, embedded `dns-fallback-servers.json`, `:224-225`). These are
  Tailscale Inc.'s `derpN.tailscale.com` servers, which receive `GET /bootstrap-dns?q=<our Headscale host>`
  over HTTPS.
- That leaks the client IP and the fact it uses AirBridge's control server to Tailscale Inc. No credentials
  or traffic leave.
- `net/dnsfallback` is linked into the sidecar (`go list -deps`). It has no envknob to disable it, and
  Headscale's DERP map is only *merged into* the static map (`dnsfallback.go:177-210`); it never replaces it.
- **Required (Systems, `desktop/sidecar/airbridge-net/go.mod`):** vendor-patch `tailscale.com` with a
  `replace` to a pinned copy whose `net/dnsfallback/dns-fallback-servers.json` is `{"Regions":{}}`. `lookup`
  then returns "no DNS fallback options" (`dnsfallback.go:104-106`). Add a Go test asserting
  `dnsfallback.GetDERPMap()` has no `tailscale.com` hosts.
- Alternative: product accepts it and rewords the claim to "no logs or telemetry to Tailscale; a DNS-failure
  fallback may query Tailscale's public DNS bootstrap servers".
- Other Tailscale-host paths checked and clear:
  - **logtail:** off. `envknob.SetNoLogsNoSupport()` + `logtail.Disable()` run before `srv.Start()`
    (`main.go:77-78`). The upload transport becomes a no-op (`logpolicy/logpolicy.go:895-896`), and
    `sendLocked` drops entries before buffering (`logtail/logtail.go:766-770`), so no upload and no local
    filch content.
  - **netlog:** off under NoLogsNoSupport (`feature/netlog/netlog.go:76`).
  - **Captive-portal detection:** not linked. It would hit `controlplane.tailscale.com`
    (`net/captivedetection/endpoints.go:124-125`), but `feature/captiveportal` is not in the dependency graph.
  - **ControlURL:** always set and validated (`config.go` `validateControlURL`), so tsnet's
    `controlplane.tailscale.com` default is never used. The control URL is fixed at spawn, and Electron
    provides it.
  - **DERP/STUN:** use the DERP map from Headscale (`derp.urls: []` + embedded DERP).
  - **c2n:** linked (`tsnet.go:181`), but only the control server (our Headscale) can issue c2n requests.
  - **portmapper:** talks only to the local gateway.

### S-2 (Medium on multi-user hosts) — stale inbox registration: port squatting receives tasks and the inbox token
- The sidecar keeps the last `POST /inbox {port, token}` registration forever (`control.go:240-252`,
  `backend.go` `inboxTarget`). It forwards each verified task to `127.0.0.1:<port>` with the token **in
  cleartext** (`mesh.go:192-211`).
- If the daemon exits or restarts, another **local user** can bind the freed ephemeral port before the new
  daemon re-registers. That user then receives peers' task payloads, the shared secret, and the old inbox
  token. The old token is useless once the new daemon registers a fresh one.
- Same-user processes are inside the trust boundary anyway.
- **Required (Systems):**
  1. `mesh.go`: on a connection error to the inbox, clear the registration (`inbox.set(0, "")`) so the
     sidecar returns 503 until the daemon re-registers.
  2. `daemon.py`: deregister on shutdown with `POST /inbox {port:0}`. The sidecar would need to accept
     port 0 as "clear".
  3. Recommended: replace the bearer header with `X-AirBridge-Sidecar-Sig = HMAC-SHA256(token, ts|peer
     headers|sha256(body))` and a ±60 s timestamp, so the token never travels. Better still on POSIX, serve
     the inbox on a Unix socket in the 0700 data dir.

### S-3 (Low) — control token distribution
- The control token (≥ 32 random bytes, `NetManager.ts:404`) reaches:
  - the sidecar via stdin (closed after reading, `main.go:61-62`);
  - the daemon via env `AIRBRIDGE_NET_TOKEN`;
  - the MCP process via `<D>/network.json` (0600, atomic `wx`, `NetManager.ts:650-652`). Python rejects a
    `network.json` not owned by the user or writable by group/others (`config.py:110`).
- All three readers are same-user. Anyone holding the token can call `/send`, `/inbox` (re-route incoming
  tasks) and `/logout`. That is the documented same-user trust boundary; on macOS and Linux, other users
  cannot read another user's process environment or the 0700 `<D>`.
- Windows: `<D>` sits under `%APPDATA%` (inherited per-user ACL). The sidecar skips the owner check on Windows
  (`platform_windows.go:9`, `ownedByMe` returns true). Low: Electron chooses the path, so it is not attacker
  controlled.
- **Recommended:** a Windows ACL check (owner SID == current user, no Everyone/Users write) in
  `ensurePrivateDir`.

### S-4 (Low) — control-API server timeouts
- `ctlSrv` sets only `ReadHeaderTimeout`/`MaxHeaderBytes` (`main.go:138`). A token holder (same user) could
  hold `/send` bodies open.
- **Recommended:** `ReadTimeout: 30s, WriteTimeout: 30s, IdleTimeout: 60s`.

### S-5 (Low) — environment scrub is an allowlist in Electron and a denylist in the sidecar
- Electron passes only an allowlist plus proxy variables (`NetManager.ts:93-107`); that is the real control.
- The sidecar unsets 9 named `TS_*` variables (`main.go:46-49`). Other `TS_DEBUG_*` envknobs would be honored
  if the sidecar were started some other way.
- **Recommended:** unset every `TS_*`/`TSNET_*` except `TS_NO_LOGS_NO_SUPPORT` in `main.go`.
- Proxy variables are deliberately honored (`feature/condregister/useproxy`, corporate networks). The control
  and DERP connections are TLS or Noise, and WireGuard traffic is end-to-end encrypted.

### Verified OK (sidecar line-by-line)

| Check | Evidence |
|---|---|
| WhoIs on the live connection, never cached, `proto=tcp` | `mesh.go:148`, `backend.go:37` |
| Same-user check, both `UserProfile.ID` and `Node.User`; own id 0 → 503 | `mesh.go:155-163` |
| Control-assigned name only (`Node.Name`), validated | `mesh.go:166-170` |
| Per-peer rate limit (StableID) before the body; 16 in flight; 20 s deadline; Read/Write timeouts | `mesh.go:127-176`, `main.go:162-168` |
| Body cap 600 000 (declared + actual), reply cap 64 KiB, equal to Python `MAX_BODY_BYTES` | `mesh.go:17,178-189,226` |
| Forwarded request is new; only identity headers + `X-AirBridge-Secret` (≤ 1 KiB) are set; no proxy, no redirects | `mesh.go:196-212`, `loopbackClient` |
| Inbox target restricted to `http://127.0.0.1:<port>` | `config.go` `inboxPortFromURL`, `mesh.go:196` |
| Control API: loopback peer, no `Origin`, exact Host, constant-time bearer, all before routing | `control.go:69-87` |
| Control API bound to `[::1]`, else `127.0.0.1`; unreachable from the mesh in both cases (tsnet never forwards) | `main.go:202-212` |
| `/send` refuses IPs; exact-name match among **online same-user** peers; JSON object payload; caps | `control.go:154-228,230-238` |
| Secrets only from stdin (one line, ≤ 64 KiB, `DisallowUnknownFields`, regex-validated); stdin closed; no argv or env config | `config.go:52-118`, `main.go:61-62` |
| Redaction: exact run secrets + `(hs\|ts)key-…` + every URL (no interactive login URL in logs); stdout never written | `logging.go:23-49`, `main.go:66-68` |
| AuthKey only when Electron saw `needs_login`; dropped from memory after the stdin write; never logged | `NetManager.ts:429-433`, `enroll.ts:224-229` |
| No interactive login: without state or a key, tsnet is not started; `AuthURL` is never relayed | `main.go:141-178`, `control.go:120` |
| State dir 0700, lstat (no symlink), owner == uid, chmod repair, before `srv.Start` | `main.go:80,238-262` |
| Parent watchdog (Unix: ppid change or ESRCH; Windows: process handle wait) | `platform_unix.go:18-32`, `platform_windows.go:13-29` |
| Mesh exposes exactly one listener; no Funnel, Serve, SSH, routes or exit node; `Ephemeral=false` | `main.go:104-112,159` |

### Headscale (unchanged from the tailscaled review)

### H-1 (High, config; fixed) — was F-3: — Headscale API key is full-admin and `/api/v1` is served on the public listener

- API keys carry no scopes. Any valid key passes both the gRPC interceptor (`hscontrol/app.go:406-460`) and
  the HTTP middleware (`app.go:464-500`).
- `/api/v1/*` is mounted on the **main router** (`app.go:600-602`), the same listener that serves the control
  protocol to clients. `/swagger` is public too (`app.go:588-589`). Anyone holding the key can create
  pre-auth keys for any user, delete nodes, and change the policy.
- Required:
  1. Caddy returns 404 for `/api/*` and `/swagger*` on the public site.
  2. The license server reaches Headscale over the internal docker network (or a localhost URL).
  3. Set `grpc_listen_addr` to `127.0.0.1:50443` (the default in `config-example.yaml:34`), or disable it, and
     keep `grpc_allow_insecure: false`.
  4. Keep `metrics_listen_addr` on loopback.
  5. Rotate the API key every 90 days or less (`headscale apikeys create --expiration 90d`, then expire the
     old key).
  6. Keep the key only in the license server's secret store. It must never reach the client.


Status: fixed (Caddy `@admin path /api /api/* /swagger /swagger*` → 404, `control` network
`internal: true`, gRPC and metrics on loopback). Not yet validated against a running Caddy.

### H-2 (Info, verified OK) — was F-12: — Headscale pre-auth keys and `autogroup:self`

- **Single use** (`reusable:false`): `Validate` rejects keys already used (`preauth_key.go:137-142`).
  Consumption is an atomic compare-and-set (`UPDATE … WHERE id=? AND used=false`, checked by `RowsAffected`,
  `hscontrol/db/preauth_keys.go:343-357`) in the same transaction as node creation (`state/state.go:2203-2208`),
  so two concurrent registrations cannot both claim one key.
- Re-registering the same node key skips validation by design (`state.go:2723-2750`). That covers restarts,
  not new devices: a new node key or a different machine needs a fresh valid key.
- **Expiry**: `Expiration.Before(now)` gives `authkey expired` (`preauth_key.go:131-133`). The license server
  sets 600 s.
- Format: `hskey-auth-{12}-{64}` (`db/preauth_keys.go:41-43`); API keys are `hskey-api-{12}-{…}`
  (`db/api_key.go:16-18`). Both are covered by the secrets scan.
- **`autogroup:self`**: rules are compiled per node from `userNodeIndex`, which holds only **untagged** nodes,
  grouped by user (`policy/v2/compiled.go:122-136`). `compileSelfForUser` intersects the sources with the same
  user's devices (`compiled.go:760-800`, `filterSourcesToSameUser` `compiled.go:851-873`), and tagged nodes get
  no self rules (`compiled.go:711-720`). With the required policy, **cross-user traffic is denied by default**:
  the Tailscale packet filter is default-deny whenever rules exist. The license server must never set
  `acl_tags`, because a tagged node would fall out of `autogroup:self`.
- Prefixes must remain within `100.64.0.0/10` and `fd7a:115c:a1e0::/48` (`config-example.yaml:60-77`).
  `sidecar_identity` (inbox) rejects a peer IP header outside them.



## 3. F-13: sender identity (sidecar mode) — `REJECT_SENDER_MISMATCH = True`

- The sidecar sends the verified control-assigned label in `X-AirBridge-Peer-Node`. The inbox normalizes it
  (`security.embedded_peer_node_name`), and **only that name** is stored, logged and notified.
- The outbox now sends its own control-assigned name: sidecar `/status` `self.hostname`, the first label of
  `Self.DNSName` with the prefix stripped (`outbox.py` `_send_via_sidecar`). That is exactly what the
  receiver's WhoIs reports. So Security **enabled rejection**: a `sender_node` that does not name the verified
  device returns `400 sender_mismatch`.
- Matching (`inbox.sender_matches_verified`) is canonical and tolerates Headscale's global `GivenName` bump
  (`base`, `base-1`, …, `hscontrol/state/node_store.go` `resolveGivenName`).
- Verified:
  - unit tests (`test_phase3_security.py`, `test_sidecar_daemon.py`);
  - the real 3-sidecar integration **11/11 with the flag on**. A same-user node claiming "a1" gets 400; the
    same node claiming its own name gets 201 and is recorded under its verified name.

## 4. STRIDE (sidecar)

| Threat | Vector | Control | Residual |
|---|---|---|---|
| Spoofing a peer to the inbox | Local process → Python inbox | Loopback + per-daemon sidecar token (compare_digest) → 403 | S-2 (squat on a stale port) |
| Spoofing a peer on the mesh | Forged source IP | WireGuard binds the source IP to the peer key; WhoIs on the live connection | — |
| Spoofing across customers | Another user's node | `autogroup:self` ACL, then the user-id check in `mesh.go` | ACL integrity (policy guard) |
| Sender-name spoofing | Payload `sender_node` | Verified name recorded; mismatch → 400 | — |
| Tampering | Network | WireGuard / Noise | — |
| Repudiation | — | Verified node name, IP and user logged | same-user devices are mutually trusted |
| Info disclosure: localhost services | Peer → other ports | None exist (tsnet never forwards) + ACL tcp/8989 | — |
| Info disclosure: keys and tokens | argv, env, logs, files | stdin only; redactor; key never on disk; `network.json` 0600 | same-user readers (S-3) |
| Info disclosure: metadata to Tailscale Inc. | logtail, netlog, captive portal, DNS fallback | logtail/netlog off; captive portal not linked | **S-1 DNS fallback** |
| DoS | Mesh flood | Per-peer bucket, 16 in flight, timeouts, body cap | Headscale/DERP availability |
| Elevation via the control API | Browser, remote peer, other user | Loopback, no Origin, Host, bearer; unreachable from the mesh | token holders = same user |

## 5. Key and credential lifecycle

| Secret | Origin | Transport / storage | Lifetime | Never |
|---|---|---|---|---|
| Headscale API key | Ops | License-server secret store; internal network only | ≤ 90 d rotation | client, logs, repo, public `/api` |
| Pre-auth key `hskey-auth-…` | License server (`reusable:false`, 600 s) | HTTPS (`no-store`) → Electron memory → sidecar **stdin** → tsnet (memory) | single use, ≤ 600 s | argv, env, disk, logs, renderer |
| Node and machine keys | tsnet | `<D>/tsnet/tailscaled.state` (dir 0700) | `node.expiry: 0`; revoked via the license-server remove endpoint / logout | committed (scan) |
| Control token | NetManager per spawn (32 B) | stdin; daemon env; `network.json` 0600 | sidecar lifetime | logs (redacted) |
| Inbox token | Daemon per inbox start (`token_urlsafe(32)`) | `POST /inbox` (control-token auth); sidecar → inbox header | daemon lifetime | logs; see S-2 |

## 6. Required fixes for other owners

| # | Owner | File | Fix | Blocking? |
|---|---|---|---|---|
| 1 | Systems | `desktop/sidecar/airbridge-net/go.mod` (+ vendored `tailscale.com` copy) | `replace tailscale.com` with a pinned copy whose `net/dnsfallback/dns-fallback-servers.json` is `{"Regions":{}}`; Go test that the fallback map has no `tailscale.com` hosts (S-1) | Yes, for the "no Tailscale hosts" claim; otherwise product rewords it |
| 2 | Systems | `desktop/sidecar/airbridge-net/mesh.go` (~line 213) | On an inbox connection error, `m.inbox.set(0, "")` (S-2) | No (multi-user hosts) |
| 3 | Systems | `desktop/sidecar/airbridge-net/control.go:240-252` + `airbridge/airbridge_app/daemon.py` | Accept `{port:0}` as deregister; the daemon deregisters on shutdown (S-2) | No |
| 4 | Systems | `mesh.go` / `inbox.py` | Recommended: HMAC-signed forwarding instead of the bearer header, or a Unix-socket inbox on POSIX (S-2) | No |
| 5 | Systems | `desktop/sidecar/airbridge-net/main.go:138` | `ReadTimeout`/`WriteTimeout`/`IdleTimeout` on `ctlSrv` (S-4) | No |
| 6 | Systems | `desktop/sidecar/airbridge-net/main.go:46-49,75-76` | Unset all `TS_*`/`TSNET_*` except `TS_NO_LOGS_NO_SUPPORT` (S-5) | No |
| 7 | Systems | `desktop/sidecar/airbridge-net/platform_windows.go` | Owner-SID/DACL check in `ensurePrivateDir` (S-3) | No |
| 8 | Ops/SWE | Production Caddy | Smoke test: `/api/v1/user` and `/swagger` → 404 on the public host (H-1) | Yes, before launch |

## 7. Tests (Security-owned)

- `airbridge/tests/test_phase3_security.py`:
  - `verify_embedded_peer` table tests.
  - Sidecar-mode inbox: no token, wrong token, non-loopback, bad peer headers → 403; same user → 201.
    Sender: mismatch → 400 by default, overwrite with the flag off, collision bump accepted.
  - Sidecar client loopback-only; outbox `trust_env=False` and hostname-only `/send`.
  - TS checks: pre-auth key only on stdin; fixed empty argv; scrubbed env; no key logging.
  - **New Go static checks** on `desktop/sidecar/airbridge-net/*.go`:
    - WhoIsProto tcp on the live connection, plus the same-user check;
    - body caps equal to Python's;
    - exactly one `srv.Listen("tcp", ":8989")` and no Funnel, Serve or fallback handlers;
    - control-API guards before routing, with loopback-only binds;
    - secrets only from stdin, with no `os.Getenv`, argv or stdout;
    - `SetNoLogsNoSupport` and `logtail.Disable` before `srv.Start`;
    - no hardcoded Tailscale hosts;
    - private state dir before start;
    - loopback-only inbox target, with `/inbox` behind auth.
- `desktop/tests/secrets-scan.test.ts`: Tailscale and Headscale key rules, literal `--auth-key`, forbidden
  committed `.authkey*`, `tailscaled.state` and `network.json` (all still apply to the sidecar state dir).

## 8. Sign-off

- [x] Mesh trust: WhoIs tcp on the live connection, same-user check, control-assigned name, caps, rate
  limits, single listener.
- [x] Local trust: inbox token, control-API guards, loopback binds, `/send` hostname-only.
- [x] Secrets: stdin only, redaction, no argv or env, no key on disk; secrets scan green.
- [x] Log upload and netlog disabled before start; captive portal not linked; control URL always ours.
- [x] F-13: sender bound to WhoIs; **`REJECT_SENDER_MISMATCH` enabled**; real integration 11/11.
- [x] Headscale policy, guard, API isolation (H-1, H-2).
- [ ] S-1 DNS-fallback fix (#1), or product accepts and rewords the claim.
- [ ] Production Caddy smoke test (#8).
- [ ] Windows and macOS end-to-end run of the real integration (only Linux has been exercised).

**Status: APPROVED for beta on Linux/macOS/Windows** with residual risks S-1 (until #1), S-2 (multi-user
hosts), and the untested Windows/macOS paths. GA sign-off requires #1 (or explicit product acceptance), #8,
and one real run per OS.

## Appendix — superseded tailscaled findings
F-1 (localhost forwarding), F-2/F-5/F-6 (ProxyMapper whois), F-4 (Windows pipe), F-8 (LocalAPI socket),
F-9 (open SOCKS5), F-10 (SOCKS/inbox port squat) and F-11 (`--auth-key=file:`) no longer apply: there is
no tailscaled, LocalAPI socket, SOCKS proxy or key file. Their analysis is in git history (commit 00a4c5b).
`security.verify_embedded_peer` remains, unit-tested, for any future embedded-tailscaled path.
