# AirBridge Phase 3 — Security Review ("Invisible Network")

Owner: Security. Scope: bundled `tailscaled` v1.104.7 in userspace-networking mode, enrolled into self-hosted
Headscale v0.29.7 with single-use pre-auth keys from the license server (contract: `docs/PHASE3_PLAN.md`).
Source verified against the Go module zips from `proxy.golang.org` (`tailscale.com@v1.104.7`,
`github.com/juanfont/headscale@v0.29.7`). All `file:line` references are to those trees.

**Verdict: the design holds, provided the required fixes below land.** We found no flaw that breaks the
model, but one Windows item blocks the feature (F-4), and two configuration items fail open if they
are missed (F-1, F-3).

---

## 1. Trust model in one paragraph

In userspace mode there is no TUN device. tailscaled's netstack terminates inbound tailnet TCP and **re-dials
it to `127.0.0.1:<same dst port>`** (`wgengine/netstack/netstack.go:1799`: `case isTailscaleIP: dialIP =
ipv4Loopback`). It records the local end of that dial (`127.0.0.1:<ephemeral>`) → peer tailnet IP in its
ProxyMapper (`netstack.go:1857`, proto `"tcp"`). The inbox binds `127.0.0.1:8989`, sees every client as
`127.0.0.1`, and asks LocalAPI `GET /localapi/v0/whois?proto=tcp&addr=127.0.0.1:<client port>`. LocalBackend's
WhoIs resolves that through `ProxyMapper().WhoIsIPPort` (`ipn/ipnlocal/local.go:1771-1795`). A process on this
machine that connects to `127.0.0.1:8989` directly has no ProxyMapper entry, so whois returns 404 and the inbox
returns 403. `security.verify_embedded_peer` then requires the peer's Headscale user ID to equal ours.
Headscale's `autogroup:self` ACL already stops other customers at the packet filter. The inbox check is the
second layer.

## 2. `security.verify_embedded_peer` (implemented, Security-owned)

```python
verify_embedded_peer(client_host: str, client_port: int,
                     whois: Callable[[str], dict | None],
                     self_user_id: int | str | Callable[[], int | str]) -> VerifiedPeer  # a str
```

| Step | Rule | Failure `reason` |
|---|---|---|
| 1 | `client_host` exactly `"127.0.0.1"` or `"::1"` (no mapped forms, whitespace or `localhost`). `client_port` is an `int` in 1..65535 (not a `bool`) | `not_loopback` (whois not called) |
| 2 | `whois("127.0.0.1:<port>")` or `"[::1]:<port>"`. Returns `None` or raises | `unknown_peer` |
| 3 | The result must match one of the two shapes below, the user id must be well formed, and the node name must pass `validate_sender` after normalization | `bad_whois` |
| 4 | Own id: a value or a lazy zero-arg callable, called only after step 2 succeeds. Missing, invalid or raising | `bad_whois` |
| 5 | `str(peer_uid) == str(self_uid)`. Digit strings are canonicalized (`"007"` == `7`). Compared with `hmac.compare_digest` | `foreign_user` |

It raises `EmbeddedPeerError(SecurityError)` with `.reason`, and its messages are log-safe. It returns
`VerifiedPeer`, a `str` subclass equal to the sanitized node name that also carries `.user_id`, `.tailnet_ip`
and `.node_id`. For callers that treat it as a mapping, `.get("node"|"user_id"|"ip"|"tailnet_ip"|"node_id")`
also works.

**Normalized whois shape** (`netbackend.EmbeddedTailscale.whois` returns it; extra keys are ignored):

```json
{"node": "airbridge-laptop", "user_id": 7, "tailnet_ip": "100.64.0.9"}
```

`tailnet_ip` (alias `ip`) is optional. If it is present and not null, it must be in `100.64.0.0/10` or
`fd7a:115c:a1e0::/48`. The raw LocalAPI `apitype.WhoIsResponse` is also accepted
(`{"Node":{"Name","Addresses","StableID"},"UserProfile":{"ID"}}`). Its node name comes only from the
control-assigned `Node.Name`, never from the peer-asserted `Hostinfo.Hostname`.

Node name normalization: drop the trailing dot, keep the first DNS label, strip the `airbridge-` prefix
(case-insensitive), then apply `validate_sender` (`^[A-Za-z0-9._-]{1,64}$`).

Call it **per request on the live connection, and never cache by port.**

---

## 3. Findings

Severity applies to this product's threat model: a single-user desktop by default, with multi-user hosts
noted where they matter.

### F-1 (Critical if missed) — netstack forwards ALL ports to localhost; only the ACL limits it to :8989

- `netstack.go:1799`: for any destination that is our tailnet IP, `dialIP = ipv4Loopback` with the
  **original port** (`netstack.go:1802`). The same applies to UDP (`netstack.go:2130-2133`). Every localhost
  TCP service on the user's machine can therefore be reached by any peer the packet filter admits: the
  AirBridge Control API (ephemeral 127.0.0.1 port), tailscaled's own SOCKS5 port (an open proxy into the
  victim's LAN and the internet, `net/tsdial/tsdial.go:609-624`), dev servers, databases, Jupyter, and so on.
- The packet filter does run before netstack: `net/tstun/wrap.go:1193` (`filt.RunIn`) precedes
  `PostFilterPacketInboundFromWireGuard` (`wrap.go:1246`), which netstack sets to `injectInbound`
  (`netstack.go:465`). So the ACL is a real control. It is the **only** control for ports other than 8989.
- Headscale's policy parser takes `"autogroup:self:8989"`: `AliasWithPorts.UnmarshalJSON`
  (`hscontrol/policy/v2/types.go:896-940`) splits on the last colon (`policy/v2/utils.go:36-80`).
  `autogroup:self` is valid only on the dst side (`types.go:2072-2073`). The ACL struct has a `proto` field
  (`types.go:1941-1946`).
- **Fail-open trap:** with no ACLs or grants (an empty `policy.path`, or an empty or missing policy), Headscale
  sends `FilterAllowAll` (`policy/v2/filter.go:142-143`, `policy/v2/policy.go:253-254`). Then **every
  customer's device can reach every localhost port of every other customer's device.** The inbox user check
  would still return 403 on :8989, but every other localhost service would be exposed.
- Required:
  1. Set the policy to exactly
     `{"acls":[{"action":"accept","proto":"tcp","src":["autogroup:member"],"dst":["autogroup:self:8989"]}]}`.
     Adding `proto: tcp` keeps UDP forwarding off as well; see F-2.
  2. Set `policy.mode: file` and a non-empty `policy.path` in `config.yaml.tmpl`.
  3. At startup and periodically, the license server calls `GET /api/v1/policy` (`hscontrol/grpcv1.go:691-721`),
     checks that the canonical JSON equals the expected policy, and refuses to issue pre-auth keys (503) if it
     does not.
- Defense in depth (recommended): bind the **Control API and the SOCKS5 listener to `[::1]`** instead of
  `127.0.0.1`. netstack only ever dials `127.0.0.1` for tailnet destinations (`netstack.go:1799`; `::1` is used
  only for the quad-100 service IP, `netstack.go:1764-1768`). A `[::1]` listener is therefore structurally
  unreachable from the tailnet, whatever the ACL says. Fall back to `127.0.0.1` only when `::1` is
  unavailable. The Control API already needs the bearer token, and a remote peer can forge the Host header,
  so the token is what protects it today. A per-request whois check on the Control API is **not**
  recommended: every legitimate local request misses the ProxyMapper and pays the 180 ms whois retry loop
  under LocalBackend's mutex (F-5).

### F-2 (High → fixed during review) — whois without `proto` lets a UDP mapping vouch for a TCP socket

- `LocalBackend.WhoIs` with an empty `proto` tries `tcp`, **then `udp`** (`ipn/ipnlocal/local.go:1775-1787`).
- `forwardUDP` binds `127.0.0.1:<the peer's own source port>` (`netstack.go:2133`) and registers
  `("udp", 127.0.0.1:<that port>)` for a 2-minute idle lifetime (`netstack.go:2179`, `2186`).
- Attack: a same-user peer sends UDP to us, so tailscaled registers udp `127.0.0.1:X`. A local process then
  connects over TCP from source port `X` (TCP port X is free) to `127.0.0.1:8989`. A whois without `proto`
  falls through to the UDP entry and attributes the local process to the peer.
- Fix: `netbackend.EmbeddedTailscale.whois` must query `?proto=tcp&addr=...`. **Systems has applied it**
  (`netbackend.py:426`). `test_netbackend_whois_pins_proto_tcp` enforces it against a fake LocalAPI. Adding
  `proto: tcp` to the ACL (F-1) removes the precondition.

### F-3 (High, config) — Headscale API key is full-admin and `/api/v1` is served on the public listener

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

### F-4 (Blocker on Windows) — a custom named pipe needs `--windows-mode=dev`, and the pipe name can be squatted

- tailscaled v1.104.7 **refuses** a `--socket` outside `\\.\pipe\ProtectedPrefix\Administrators\` unless it runs
  with `--windows-mode=dev` (`cmd/tailscaled/tailscaled.go:363-385`, `paths/paths.go:28`). The planned argv
  `--socket=\\.\pipe\airbridge-tailscaled-<hash>` will fail to start as written.
- With `--windows-mode=dev`, tailscaled listens through `ListenCurrentUser` (`tailscaled.go:604-608`), using
  the owner-only SDDL `O:<sid>D:P(A;;GWGR;;;<sid>)` (`safesocket/pipe_windows.go:144`). The default SDDL
  allows all Builtin Users: `D:P(A;;GWGR;;;BU)(A;;GWGR;;;SY)` (`pipe_windows.go:112`).
- Squatting: the pipe name is predictable (`sha256(username)[:12]`). Another local user can create the pipe
  first. tailscaled then fails to start (DoS), and `netbackend`'s plain `open(r'\\.\pipe\…')` would talk to
  the attacker's fake LocalAPI. A fake whois would bypass the inbox auth, and fake status data could redirect
  traffic.
- Required:
  1. Add `--windows-mode=dev` to the Windows argv (TailscaleManager.ts). The test
     `test_ts_tailscaled_argv_contract` checks it.
  2. Add a random per-launch suffix to the pipe name (≥ 64 bits, recorded in network.json).
  3. Python: after `open()`, verify that the pipe server is owned by the current user. That needs
     `GetSecurityInfo` on the handle, the same check as `checkPipeExclusiveToCurrentUser`,
     `pipe_windows.go:46-100`. Alternatively, accept the random name as the mitigation for v1 and track the
     owner check as a follow-up.

### F-5 (Medium) — the whois miss path is a local DoS amplifier

`LocalBackend.WhoIs` holds `b.mu` (`local.go:1760`) while `ProxyMapper.WhoIsIPPort` sleeps through
`0+10+20+50+100 ms` retries (`proxymap/proxymap.go:84-108`, a workaround for issue #1616). Every unverifiable
local connection to `:8989`, including `/health`, therefore holds LocalBackend's main lock for about 180 ms. A
local flood stalls tailscaled. Today the inbox rate limiter is keyed by the verified node, so unverified
requests are not limited at all.

Required (inbox.py):
1. Put a global semaphore around embedded verification (≤ 4 concurrent).
2. Add a global token bucket for verification attempts (for example, 20/s) that returns 429 before any
   LocalAPI call.
3. Keep `LOCALAPI_TIMEOUT_S` short (≤ 2 s).

### F-6 (Info, verified OK) — ProxyMapper lifetime and races

- tailscaled dials `127.0.0.1:8989` **before** it registers the mapping (`netstack.go:1845-1861`, issue #1616).
  The peer's handshake only completes at `getClient()` (`netstack.go:1871`), after registration. No request
  byte can reach the inbox before the mapping exists, so the race only produces false negatives, which the
  WhoIsIPPort retry loop covers. It fails closed.
- Unregistration is deferred (`netstack.go:1861`) and runs before `backend.Close()` (LIFO defers). The mapping
  therefore never outlives the backend socket, and the 4-tuple stays reserved while it exists. A local process
  cannot bind that source port while tailscaled's socket holds it (no `SO_REUSEADDR` on the dialer). A stale
  mapping cannot be inherited.
- After the forwarded connection closes, whois for that port returns 404. The inbox must verify **per
  request** (it does) and never cache by port.

### F-7 (Low → fixed during review) — node identity source

`Hostinfo.Hostname` is reported by the peer itself. `Node.Name` is assigned by control and is unique.
`netbackend.parse_whois` now prefers `Node.Name` (`netbackend.py:336-339`). `verify_embedded_peer`'s raw-shape
path uses only `Node.Name`. Recommended (inbox): log or bind `sender_node` to the verified peer name. Today
`sender_node` is asserted by the peer, but the peer is same-user and trusted.

### F-8 (Medium on multi-user hosts) — LocalAPI socket permissions (macOS/Linux)

- The socket is created with mode `0666` whenever the platform uses peer credentials (Linux and darwin:
  `safesocket/unixsocket.go:85-91`, `safesocket.go:146-160`). If the directory is missing, tailscaled creates
  it with mode `0755` (`unixsocket.go:47-60`).
- Permissions: any connecting Unix user gets **read** (`ipnserver/server.go:336-353`). That covers `status` and
  `whois`, which reveal peers, IPs and the Headscale user. **Write** (`up`, `logout`, prefs) goes to root, the
  same uid as tailscaled, the configured operator, or members of the `admin` group on macOS
  (`ipnauth/ipnauth.go:166-207`, `210-225`). On macOS that lets **any other admin user on the machine drive
  our tailscaled**.
- Required (TailscaleManager.ts):
  1. Before spawning, create the socket's parent directory with mode `0700`. That is `<D>` itself, or the
     `$TMPDIR/airbridge-<uid>` fallback.
  2. Verify with `lstat` that the directory is a real directory (not a symlink), owned by our uid, with
     `mode & 0o077 == 0`. Abort otherwise; on Linux, `/tmp/airbridge-1000` can be pre-created by another user.
  3. Make `<D>` itself `0700`.

  The `0666` socket is then unreachable by other users. Root is always trusted.
- Python `config.read_network_json` (Systems) should also reject `network.json` unless `st_uid == getuid()` and
  `mode & 0o022 == 0`. A writable `network.json` lets an attacker point `socket` at a fake LocalAPI (whois
  bypass) and `socks5` at a capturing proxy that receives task payloads and the shared secret.

### F-9 (Medium, accepted) — the SOCKS5 server has no authentication

- tailscaled's SOCKS server is built without `Username`/`Password` (`cmd/tailscaled/proxy.go:98-101`). Auth is
  supported only by the `socks5.Server` struct (`net/socks5/socks5.go:104-106,171`), and tsnet is the only user
  of it. No flag or environment variable enables it.
- Any local process (any user) can use `127.0.0.1:<P>` to reach our same-user devices' `:8989`, which the ACL
  restricts. Those devices still run their own whois and user checks, so the caller can only submit tasks *as
  this device*. Non-tailnet destinations are dialed through the host network (`tsdial.go:620-624`), which
  grants nothing new locally.
- Accepted for v1 with mitigations: the ACL, the `[::1]` bind (F-1), and port-squat awareness (F-10).
  Follow-up: patch tailscaled in `tailscale-mod` to read SOCKS credentials from a 0600 file. Then
  `requests_proxies` → `socks5h://user:pass@…`.

### F-10 (Low, multi-user) — loopback port squatting

Before AirBridge binds them, another local user could bind `127.0.0.1:8989` (and receive peers' task payloads
forwarded by tailscaled) or the SOCKS port `<P>` (and receive our outbound payloads plus the shared secret).
Our bind then fails visibly. Required:
- The daemon treats an inbox bind failure as fatal in embedded mode. It reports degraded and refuses to run.
- TailscaleManager writes `network.json` only after the health check confirms tailscaled is up. If tailscaled
  exits with `SOCKS5 listener:` in its log (`proxy.go:62-64`), it treats that as an error and never publishes
  the port.

### F-11 (Info, verified OK) — `--auth-key=file:` handling

- `up --auth-key` accepts `file:<path>` (`cmd/tailscale/cli/up.go:102`). `resolveValueFromFile` reads and trims
  the file (`up.go:215-224`). A read error prints `os.ReadFile`'s error, which names the path but never the
  content.
- The key travels to tailscaled in `ipn.Options.AuthKey` over the LocalAPI socket (`up.go:686-689`). It is not
  persisted in prefs or state, and it is not logged. `controlclient` passes it to `tka.DecodeWrappedAuthkey`,
  whose log lines contain only the error text (`tka/sig.go:467-495`). Syspolicy logs only `len=`
  (`ipnlocal/local.go:3122`).
- Headscale errors are fixed strings: `invalid authkey`, `authkey expired`, `authkey already used`
  (`hscontrol/types/preauth_key.go:120-145`), and its own debug log masks keys as `hskey-auth-<prefix>-***`
  (`preauth_key.go:101,180`). The key never appears in output.
- An `hskey-…` key is not mistaken for an OAuth client secret: that hook only fires for the `tskey-client-`
  prefix (`feature/oauthkey/oauthkey.go:38-41`).
- Required (enroll.ts): write the key file `0600` with `O_EXCL` in `<D>` (0700); unlink it in `finally`; on
  startup, sweep stale `<D>/.authkey-*` files, since a crash between write and unlink leaves a key valid for up
  to 600 s; never log `tailscale up` stdout or stderr without redacting `/(?:hs|ts)key-[\w-]+/`.

### F-12 (Info, verified OK) — Headscale pre-auth keys and `autogroup:self`

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
  `verify_embedded_peer` rejects whois addresses outside them.

---

## 4. STRIDE — embedded network

| Threat | Vector | Control | Residual |
|---|---|---|---|
| **S**poofing a peer to the inbox | Local process connects to `127.0.0.1:8989` | whois(proto=tcp) has no entry → 403 (`verify_embedded_peer`) | none |
| Spoofing via a UDP mapping | F-2 | `proto=tcp` (fixed) + ACL `proto: tcp` | none once both are in place |
| Spoofing across customers | Another customer's device | `autogroup:self` ACL, then the `user_id == self` check | depends on the ACL being loaded (F-1 check) |
| Spoofing tailscaled (fake LocalAPI) | Squatting the socket or pipe, or tampering with network.json | 0700 socket dir; owner and mode check on network.json; Windows random pipe name + owner check (F-4, F-8) | pending fixes |
| Spoofing the control server | MITM on enrollment | HTTPS login server (Caddy TLS); `redirect:'error'` on the license→Headscale API | — |
| **T**ampering with tasks in transit | Network | WireGuard (Noise IK), end to end between nodes | — |
| Tampering with the policy | Holder of the Headscale API key | F-3: API not public, key kept server-side and rotated | admin compromise = full tailnet |
| **R**epudiation | Peer denies sending | Inbox logs the verified node name, StableID and tailnet IP | same-user devices are mutually trusted |
| **I**nfo disclosure: other localhost services | Peer → `100.x:<any port>` → `127.0.0.1:<port>` | ACL `autogroup:self:8989` with `proto:tcp`; recommended `[::1]` binds for Control API and SOCKS | F-1 policy check required |
| Info disclosure: LocalAPI read by other Unix users | 0666 socket | 0700 parent directory (F-8) | root |
| Info disclosure: pre-auth key leak | argv, logs, env, disk | `file:` + 0600 + unlink; never in argv or env; tests | 600 s TTL, single use |
| Info disclosure: telemetry | logtail | `--no-logs-no-support` + `TS_NO_LOGS_NO_SUPPORT=true`; `derp.urls: []` | Headscale operator sees metadata |
| Info disclosure: DNS leak of peer names | Local DNS lookups | `socks5h` (remote resolution); `--accept-dns=false`; outbox uses IP literals | — |
| **D**oS: whois lock amplification | Local flood on :8989 | F-5: semaphore + global bucket | — |
| DoS: port or pipe squat | Another local user | Fail visibly (F-10, F-4) | multi-user hosts |
| DoS: Headscale/DERP outage | Single region | Ops (second DERP region) | accepted, see plan §6 |
| **E**levation: remote peer reaching the Control API | F-1 | Bearer token + ACL; recommended `[::1]` bind | — |
| Elevation: local admin user drives tailscaled (macOS) | `admin` group gets write (F-8) | 0700 directory | root |
| Elevation: open SOCKS proxy | F-9 | ACL; follow-up: SOCKS credentials | accepted v1 |

## 5. Key and credential lifecycle

| Secret | Created by | Stored | Lifetime | In transit | Revocation | Must never |
|---|---|---|---|---|---|---|
| Headscale API key `hskey-api-…` | Ops (`headscale apikeys create --expiration 90d`) | License-server secret store only (`HEADSCALE_API_KEY`) | ≤ 90 d, then rotate | License server → Headscale over the internal network, `Authorization: Bearer` | `headscale apikeys expire` | reach clients, logs or the repo; be exposed through a public `/api` |
| Pre-auth key `hskey-auth-…` | License server `POST /api/v1/preauthkey {reusable:false, ephemeral:false, expiration:+600s}` | Response (`no-store`), then `<D>/.authkey-<rand>` (0600, O_EXCL), unlinked in `finally` | ≤ 600 s, single use (atomic CAS) | HTTPS response; LocalAPI `ipn.Options.AuthKey` | expires; used once | appear in argv, env, logs or IPC to the renderer; be reusable; be tagged |
| Node key / machine key | tailscaled | `<D>/tailscaled/` state (dir 0700) | `node.expiry: 0` (no expiry) | — | license server `devices/:id/remove`; `logout` on sign-out | be committed (scan); be world-readable |
| WireGuard session keys | tailscaled | memory | rotating | — | — | — |
| Control API token | ProcessManager per launch | memory / env of the daemon | process lifetime | loopback `Authorization` | restart | be reachable from the tailnet (F-1) |
| Clerk JWT | Clerk | main-process memory | short | HTTPS to the license server | Clerk | be logged |
| `enrolled_sub_hash` | TailscaleManager | network.json (0600) | until re-enroll | — | — | be a raw `sub` |

Gaps:
- Subscription lapse leaves nodes enrolled forever (`node.expiry: 0`). The follow-up from plan §6 (a Stripe
  webhook that expires or deletes the user's nodes) is required before GA.
- An uninstall without sign-out leaves the node registered. The devices list in the app plus the remove
  endpoint cover it.

## 6. Required fixes for other owners

| # | Owner | File | Fix | Finding |
|---|---|---|---|---|
| 1 | SWE | `license-server/headscale/policy.hujson` | `{"acls":[{"action":"accept","proto":"tcp","src":["autogroup:member"],"dst":["autogroup:self:8989"]}]}`. No other rules, no tags. | F-1, F-2 |
| 2 | SWE | `license-server/headscale/config.yaml.tmpl` | `policy.mode: file`, non-empty `policy.path`; `grpc_listen_addr: 127.0.0.1:50443` (or unset); `grpc_allow_insecure: false`; `metrics_listen_addr: 127.0.0.1:9090`; default prefixes; `derp.urls: []`; `dns.magic_dns: false`; `node.expiry: 0` | F-1, F-3 |
| 3 | SWE | `license-server/headscale/Caddyfile` | Public site: `@internal path /api/* /swagger*` → `respond 404`. Proxy only the control-protocol paths (`/ts2021`, `/key`, `/machine/*`, `/register/*`, `/derp*`, `/bootstrap-dns`, `/health`) | F-3 |
| 4 | SWE | `license-server/headscale/docker-compose.yml` | License server → Headscale over an internal network; the Headscale API port is not published to the host or internet | F-3 |
| 5 | SWE | `license-server/src/network.ts` / `headscale.ts` | Startup and periodic `GET /api/v1/policy` compared with the expected canonical policy. On mismatch, 503 on `/v1/network/preauth-key` and an alert. Never send `acl_tags` | F-1, F-12 |
| 6 | SWE | `desktop/src/main/network/enroll.ts` | Key file `0600` + `O_EXCL` (`wx` flag) in `<D>`; `finally` unlink; startup sweep of `.authkey-*`; redact `/(?:hs|ts)key-[\w-]+/` from any logged CLI output; argv uses only `--auth-key=file:<path>` | F-11 |
| 7 | Systems | `desktop/src/main/network/TailscaleManager.ts` | Windows: add `--windows-mode=dev` and a random per-launch pipe suffix | F-4 |
| 8 | Systems | `TailscaleManager.ts` | Before spawn: `mkdir` socket dir `0700`, `lstat` check (dir, not a symlink, owner == uid, `mode & 077 == 0`), else abort; `<D>` mode `0700` | F-8 |
| 9 | Systems | `TailscaleManager.ts` | Write `network.json` only after a healthy `status`; treat a `SOCKS5 listener:` fatal error as an error state | F-10 |
| 10 | Systems | `TailscaleManager.ts` (recommended) | `--socks5-server=[::1]:<P>` (fallback `127.0.0.1`) | F-1, F-9 |
| 11 | Systems | `airbridge/airbridge_app/control.py` (recommended) | Bind the Control API to `::1` when available (Host check becomes `[::1]:<port>`) | F-1 |
| 12 | Systems | `airbridge/airbridge_app/inbox.py` | Global semaphore (≤ 4) + global token bucket on embedded verification before any LocalAPI call; inbox bind failure fatal in embedded mode | F-5, F-10 |
| 13 | Systems | `airbridge/airbridge_app/config.py` `read_network_json` | On POSIX, reject unless `st_uid == os.getuid()` and `st_mode & 0o022 == 0` | F-8 |
| 14 | Systems | `airbridge/airbridge_app/netbackend.py` (Windows) | After opening the pipe, verify that the server's owner SID is the current user (or rely on the random name for v1) | F-4 |
| ✔ | Systems | `netbackend.py` | `whois?proto=tcp&addr=` (**done**) | F-2 |
| ✔ | Systems | `netbackend.py` `parse_whois` | Prefer `Node.Name` over `Hostinfo.Hostname` (**done**) | F-7 |

## 7. Tests (Security-owned)

- `airbridge/tests/test_phase3_security.py`:
  - `verify_embedded_peer` table tests: source address, port, whois outcome, schema, user ids, lazy own id,
    log safety.
  - Embedded inbox integration with a fake backend: unknown whois → 403, foreign user → 403, bad whois → 403,
    unknown own id → 403, non-loopback → 403, same user → 201 (normalized and raw shapes). Phase-1 mode still
    rejects loopback.
  - A fake LocalAPI on a Unix socket checks that `netbackend` pins `proto=tcp` and that its output passes
    verification.
  - `requests_proxies` is `socks5h://127.0.0.1:P`.
  - Outbox AST: `trust_env=False`, no module-level `requests.*`, proxies applied, no `socks5://`.
  - Static TS checks on `desktop/src/main/network/*.ts`: `--auth-key` only with `file:`, no key variable in
    `up` argv, no `TS_AUTHKEY`, no key in log calls, argv contract (`userspace-networking`,
    `--no-logs-no-support`, SOCKS on loopback, no debug or HTTP-proxy listeners, `--windows-mode=dev` with a
    custom pipe), env not inherited wholesale.
  - Tests for a module that does not exist yet are skipped with `PENDING (owner)`. Once the module exists,
    they become hard requirements.
- `desktop/tests/secrets-scan.test.ts`:
  - New rules for `tskey-…`, `hskey-auth-…` / `hskey-api-…` (the masked `-***` form is allowed),
    `HEADSCALE_API_KEY=` / `TS_AUTHKEY=` literal assignments, and a literal `--auth-key=<value>`.
  - Committed `.authkey*`, `tailscaled.state` and `network.json` files are forbidden.
  - `.env.example` placeholder enforcement extended to `*AUTH_KEY` / `PREAUTH_KEY`.
  - The renderer must not reference key material or `HEADSCALE_API_KEY`.

## 8. Sign-off checklist

- [x] `verify_embedded_peer` implemented and unit-tested (fail closed on every branch).
- [x] Netstack → 127.0.0.1 forwarding, ProxyMapper registration and unregistration, race behavior verified (F-6).
- [x] LocalAPI whois path verified; `proto=tcp` pinned in netbackend (F-2).
- [x] `--auth-key=file:` verified to keep the key out of argv and logs (F-11).
- [x] Headscale single-use and expiry enforcement and `autogroup:self` semantics verified (F-12).
- [x] Secrets scan extended for Tailscale and Headscale keys.
- [ ] Policy file deployed with `proto: tcp` + `autogroup:self:8989`; license-server policy self-check (#1, #2, #5).
- [ ] Headscale API not reachable publicly; gRPC on loopback; key rotation documented (#3, #4).
- [ ] Windows `--windows-mode=dev` + random pipe name (#7). **Blocks Windows.**
- [ ] Socket directory 0700 with owner check; `<D>` 0700; `network.json` owner check (#8, #13).
- [ ] Inbox verification throttling (#12).
- [ ] enroll.ts key-file handling verified by `test_phase3_security.py` TS checks once the file exists (#6).
- [ ] Stretch real-tailnet test: A1→A2:8989 OK, B1→A2 blocked, local curl → 403, **and A1→A2:<control port> blocked**.
- [ ] Follow-ups tracked: SOCKS credentials (F-9), subscription-lapse node expiry, `[::1]` binds (#10, #11).

Sign-off: **conditional**. Security approves once the unchecked items #1–#5, #7, #8, #12 and #13 are done.
#10, #11 and #14 are recommended, not blocking.
