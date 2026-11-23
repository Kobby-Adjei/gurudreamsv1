"""REAL end-to-end test: Headscale v0.29.7 + three airbridge-net sidecars (tsnet v1.104.7) + AirBridge.

Skipped unless ``AIRBRIDGE_REAL_SIDECAR=1``. Run it with
``airbridge/tests/integration/run_real_sidecar.sh`` (builds what is missing).

Needs (env, absolute paths):
  AIRBRIDGE_HEADSCALE_BIN   headscale v0.29.7 binary
  AIRBRIDGE_NET_BIN         airbridge-net for this host (default desktop/resources/net/<platform>-<arch>)
  AIRBRIDGE_MESHPROBE_BIN   test-only raw tsnet client (desktop/sidecar/airbridge-net/internal/meshprobe)
Linux/macOS. Everything binds 127.0.0.1 / ::1 on free ports; no system Tailscale is used or needed.

Topology:  user A: A1, A2        user B: B1        (each: own sidecar process + state dir,
           own real ``main.py --daemon`` with its own inbox; all on ONE host)
Policy:    {"acls":[{"action":"accept","proto":"tcp","src":["autogroup:member"],"dst":["autogroup:self:8989"]}]}
Asserts:   A1 -> A2 delivered, recorded sender = verified "a1" (not the self-asserted name), A1's IP;
           A2 -> A1 delivered too (several receivers on one host: tsnet listeners are in-process);
           A2 /nodes lists a1 only; B1 sees no A nodes and B1 -> "a2" is refused (404, nothing stored);
           a raw user-B tsnet node POSTing straight to A2's IP:8989 is blocked by the packet filter;
           a raw user-A node (same user, not an AirBridge sidecar) IS accepted but recorded under its
           verified name, never its claimed one;
           local POST to A2's Python inbox without the sidecar token -> 403;
           sidecar control API without token -> 401, with Origin -> 403, raw IP target -> 400;
           A1 sidecar restart without a key reuses its node (same IP, no new key).
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("AIRBRIDGE_REAL_SIDECAR") != "1" or os.name == "nt",
    reason="real sidecar test: set AIRBRIDGE_REAL_SIDECAR=1 (see run_real_sidecar.sh)",
)

ROOT = Path(__file__).resolve().parents[3]
AIRBRIDGE = ROOT / "airbridge"
MAIN_PY = AIRBRIDGE / "main.py"
POLICY = {"acls": [{"action": "accept", "proto": "tcp", "src": ["autogroup:member"], "dst": ["autogroup:self:8989"]}]}


def _free_port(udp: bool = False) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM if udp else socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _net_bin() -> Path:
    env = os.environ.get("AIRBRIDGE_NET_BIN")
    if env:
        return Path(env)
    plat = {"linux": "linux", "darwin": "darwin"}.get(sys.platform, sys.platform)
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}[os.uname().machine.lower()]
    return ROOT / "desktop" / "resources" / "net" / f"{plat}-{arch}" / "airbridge-net"


def _clean_env(**extra: str) -> dict[str, str]:
    """No proxy variables (they would route the local control server through a proxy) and no TS_*."""
    keep = ("PATH", "HOME", "TMPDIR", "LANG")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env["TS_NO_LOGS_NO_SUPPORT"] = "true"
    env.update(extra)
    return env


def _wait(pred, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            v = pred()
            if v:
                return v
        except Exception as exc:  # noqa: BLE001
            last = exc
        time.sleep(0.25)
    raise AssertionError(f"timeout waiting for {what} (last error: {last!r})")


_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http(method: str, url: str, body: dict | None = None, headers: dict | None = None,
         timeout: float = 30) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json",
                                                                        **(headers or {})})
    try:
        with _NO_PROXY.open(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw.decode(errors="replace")}


class Sidecar:
    def __init__(self, lab: Lab, name: str) -> None:
        self.lab, self.name = lab, name
        self.dir = lab.dir / name
        self.dir.mkdir(mode=0o700, exist_ok=True)
        self.proc: subprocess.Popen | None = None
        self.url = ""
        self.token = ""

    def start(self, auth_key: str | None = None) -> None:
        self.token = secrets.token_urlsafe(32)
        cfg = {"control_url": self.lab.hs_url, "hostname": f"airbridge-{self.name}",
               "control_token": self.token, "state_dir": str(self.dir / "tsnet"), "parent_pid": os.getpid(),
               "verbose": os.environ.get("AIRBRIDGE_NET_VERBOSE") == "1"}
        if auth_key:
            cfg["auth_key"] = auth_key
        err = open(self.dir / "sidecar.log", "ab")  # noqa: SIM115
        # Test-only: Headscale's embedded DERP here is plain HTTP on localhost (production: TLS via Caddy).
        env = _clean_env(TS_DEBUG_USE_DERP_HTTP="1")
        self.proc = subprocess.Popen([str(self.lab.net_bin)], env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd=str(self.dir))
        self.lab.procs.append(self.proc)
        assert self.proc.stdin and self.proc.stderr
        self.proc.stdin.write((json.dumps(cfg) + "\n").encode())
        self.proc.stdin.close()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            line = self.proc.stderr.readline().decode(errors="replace")
            if not line:
                raise AssertionError(f"sidecar {self.name} exited early")
            err.write(line.encode())
            if line.startswith("AIRBRIDGE_NET_READY "):
                info = json.loads(line.split(" ", 1)[1])
                assert info["pid"] == self.proc.pid
                host = "[::1]" if info["host"] == "::1" else "127.0.0.1"
                self.url = f"http://{host}:{info['port']}"
                break
        else:
            raise AssertionError(f"sidecar {self.name}: no READY")
        # keep draining stderr into the log file
        import threading

        def drain(stream, fh):
            for chunk in iter(lambda: stream.readline(), b""):
                fh.write(chunk)
                fh.flush()

        threading.Thread(target=drain, args=(self.proc.stderr, err), daemon=True).start()

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            self.proc.wait(10)

    def api(self, method: str, path: str, body: dict | None = None, **kw) -> tuple[int, dict]:
        h = {"Authorization": f"Bearer {self.token}", **kw.pop("headers", {})}
        return http(method, self.url + path, body, h, **kw)

    def status(self) -> dict:
        return self.api("GET", "/status")[1]

    def connected(self) -> dict:
        return _wait(lambda: (s := self.status()).get("state") == "connected" and s, 60, f"{self.name} connected")


class Daemon:
    def __init__(self, lab: Lab, sc: Sidecar) -> None:
        self.sc = sc
        self.token = secrets.token_urlsafe(32)
        self.inbox = sc.dir / "inbox"
        env = _clean_env(
            AIRBRIDGE_NETWORK="sidecar", AIRBRIDGE_NET_URL=sc.url, AIRBRIDGE_NET_TOKEN=sc.token,
            AIRBRIDGE_CONTROL_TOKEN=self.token, AIRBRIDGE_CONTROL_PORT="0",
            AIRBRIDGE_DATA_DIR=str(sc.dir / "data"), AIRBRIDGE_INBOX_DIR=str(self.inbox),
            AIRBRIDGE_LOG_FILE=str(sc.dir / "airbridge.log"), PYTHONUNBUFFERED="1",
        )
        self.proc = subprocess.Popen([sys.executable, str(MAIN_PY), "--daemon"], env=env, cwd=str(sc.dir),
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        lab.procs.append(self.proc)
        assert self.proc.stderr
        line = self.proc.stderr.readline().decode()
        assert line.startswith("AIRBRIDGE_READY "), line
        info = json.loads(line.split(" ", 1)[1])
        host = "[::1]" if info.get("control_host") == "::1" else "127.0.0.1"
        self.url = f"http://{host}:{info['control_port']}"

    def api(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        return http(method, self.url + path, body, {"Authorization": f"Bearer {self.token}"}, timeout=40)

    def listening(self) -> dict:
        return _wait(lambda: (s := self.api("GET", "/status")[1])["inbox"]["listening"] and s, 60, "inbox listening")


class Lab:
    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="absc"))
        self.procs: list[subprocess.Popen] = []
        self.hs_bin = os.environ["AIRBRIDGE_HEADSCALE_BIN"]
        self.net_bin = _net_bin()
        self.probe_bin = os.environ.get("AIRBRIDGE_MESHPROBE_BIN", "")
        self.hs_port = _free_port()
        self.hs_url = f"http://127.0.0.1:{self.hs_port}"

    def close(self) -> None:
        for p in reversed(self.procs):
            with contextlib.suppress(Exception):
                p.send_signal(signal.SIGTERM)
        for p in reversed(self.procs):
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()

    def headscale(self, *args: str) -> str:
        out = subprocess.run([self.hs_bin, "-c", str(self.dir / "hs" / "config.yaml"), *args, "-o", "json"],
                             capture_output=True, text=True, timeout=30, env=_clean_env())
        assert out.returncode == 0, out.stderr[-500:]
        return out.stdout

    def start_headscale(self) -> None:
        hs = self.dir / "hs"
        hs.mkdir(mode=0o700)
        (hs / "policy.hujson").write_text(json.dumps(POLICY))
        (hs / "config.yaml").write_text(f"""
server_url: {self.hs_url}
listen_addr: 127.0.0.1:{self.hs_port}
metrics_listen_addr: 127.0.0.1:{_free_port()}
grpc_listen_addr: 127.0.0.1:{_free_port()}
grpc_allow_insecure: false
noise: {{private_key_path: {hs}/noise.key}}
prefixes: {{v4: 100.64.0.0/10, v6: "fd7a:115c:a1e0::/48", allocation: sequential}}
derp:
  server:
    enabled: true
    region_id: 999
    region_code: airbridge
    region_name: AirBridge Relay
    verify_clients: true
    stun_listen_addr: 127.0.0.1:{_free_port(udp=True)}
    private_key_path: {hs}/derp.key
    automatically_add_embedded_derp_region: true
    ipv4: 127.0.0.1
  urls: []
  paths: []
  auto_update_enabled: false
disable_check_updates: true
node: {{expiry: 0}}
database: {{type: sqlite, sqlite: {{path: {hs}/db.sqlite, write_ahead_log: true}}}}
log: {{level: info, format: text}}
policy: {{mode: file, path: {hs}/policy.hujson}}
dns: {{magic_dns: false, base_domain: "", override_local_dns: false}}
unix_socket: {hs}/hs.sock
unix_socket_permission: "0770"
logtail: {{enabled: false}}
""")
        log = open(self.dir / "headscale.log", "wb")  # noqa: SIM115
        p = subprocess.Popen([self.hs_bin, "-c", str(hs / "config.yaml"), "serve"], env=_clean_env(),
                             stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, cwd=str(self.dir))
        self.procs.append(p)
        _wait(lambda: (hs / "hs.sock").exists() and http("GET", self.hs_url + "/health")[0] == 200, 30, "headscale")

    def create_user(self, name: str) -> int:
        return int(json.loads(self.headscale("users", "create", name))["id"])

    def preauth_key(self, user_id: int) -> str:
        return json.loads(self.headscale("preauthkeys", "create", "--user", str(user_id), "--expiration", "10m"))["key"]

    def probe(self, user_id: int, target_ip: str, body: dict) -> dict:
        d = self.dir / f"probe-{secrets.token_hex(3)}"
        d.mkdir(mode=0o700)
        inp = {"control_url": self.hs_url, "auth_key": self.preauth_key(user_id), "dir": str(d),
               "target_ip": target_ip, "body": json.dumps(body)}
        out = subprocess.run([self.probe_bin], input=json.dumps(inp), capture_output=True, text=True,
                             timeout=120, env=_clean_env(TS_DEBUG_USE_DERP_HTTP="1"))
        return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.fixture(scope="module")
def lab():
    assert Path(os.environ.get("AIRBRIDGE_HEADSCALE_BIN", "")).is_file(), "AIRBRIDGE_HEADSCALE_BIN"
    lab = Lab()
    assert lab.net_bin.is_file(), lab.net_bin
    lab.start_headscale()
    ua, ub = lab.create_user("u-a"), lab.create_user("u-b")
    lab.users = {"a": ua, "b": ub}
    lab.sc = {}
    lab.dm = {}
    for name, uid in (("a1", ua), ("a2", ua), ("b1", ub)):
        sc = Sidecar(lab, name)
        sc.start(auth_key=lab.preauth_key(uid))
        lab.sc[name] = sc
    for name, sc in lab.sc.items():
        sc.connected()
        lab.dm[name] = Daemon(lab, sc)
    for dm in lab.dm.values():
        dm.listening()
    yield lab
    lab.close()
    print(f"\nlab dir (logs): {lab.dir}", file=sys.stderr)


def _md(d: Path) -> list[Path]:
    return sorted(d.glob("*.md")) if d.exists() else []


def _wait_peer(sc: Sidecar, name: str) -> dict:
    return _wait(lambda: next((n for n in sc.api("GET", "/nodes")[1]["nodes"] if n["hostname"] == name and n["online"]),
                              None), 60, f"{sc.name} sees {name}")


def test_status_shape_and_no_login_url(lab):
    for name, sc in lab.sc.items():
        st = sc.status()
        assert st["state"] == "connected" and st["self"]["hostname"] == name
        assert st["self"]["ip"].startswith("100.")
        assert "http" not in json.dumps(st)
    a1, b1 = lab.sc["a1"].status(), lab.sc["b1"].status()
    assert a1["self"]["user_id"] != b1["self"]["user_id"]


def test_a1_to_a2_delivered_with_verified_sender(lab):
    a2_node = _wait_peer(lab.sc["a1"], "a2")
    before = _md(lab.dm["a2"].inbox)
    code, res = lab.dm["a1"].api("POST", "/send_task", {"target_hostname": "a2", "task_description": "hello A2 from A1"})
    assert code == 200 and res["ok"] is True, res
    files = [f for f in _md(lab.dm["a2"].inbox) if f not in before]
    assert len(files) == 1
    text = files[0].read_text(encoding="utf-8")
    assert "hello A2 from A1" in text
    a1_ip = lab.sc["a1"].status()["self"]["ip"]
    assert "a1" in text and a1_ip in text
    assert a2_node["ip"] == lab.sc["a2"].status()["self"]["ip"]


def test_several_receivers_on_one_host_a2_to_a1(lab):
    _wait_peer(lab.sc["a2"], "a1")
    code, res = lab.dm["a2"].api("POST", "/send_task", {"target_hostname": "airbridge-a1", "task_description": "reply"})
    assert code == 200 and res["ok"] is True, res
    assert any("reply" in f.read_text(encoding="utf-8") for f in _md(lab.dm["a1"].inbox))


def test_nodes_same_user_only(lab):
    _wait_peer(lab.sc["a2"], "a1")
    names = {n["hostname"] for n in lab.sc["a2"].api("GET", "/nodes")[1]["nodes"]}
    assert names == {"a1"}
    b_names = {n["hostname"] for n in lab.sc["b1"].api("GET", "/nodes")[1]["nodes"]}
    assert b_names == set()
    _, dnodes = lab.dm["a2"].api("GET", "/nodes")
    assert [n["hostname"] for n in dnodes["nodes"]] == ["a1"]


def test_b1_to_a2_refused(lab):
    before = _md(lab.dm["a2"].inbox)
    code, res = lab.dm["b1"].api("POST", "/send_task", {"target_hostname": "a2", "task_description": "intrusion"})
    assert code == 404 and res["ok"] is False, res
    code, res = lab.sc["b1"].api("POST", "/send", {"target_hostname": "a2", "payload": {"x": 1}})
    assert code == 404 and res["error"] == "unknown_target"
    assert _md(lab.dm["a2"].inbox) == before


def test_raw_foreign_node_blocked_by_packet_filter(lab):
    if not lab.probe_bin:
        pytest.skip("AIRBRIDGE_MESHPROBE_BIN not set")
    before = _md(lab.dm["a2"].inbox)
    a2_ip = lab.sc["a2"].status()["self"]["ip"]
    res = lab.probe(lab.users["b"], a2_ip, {"sender_node": "a1", "task_description": "spoof"})
    assert "error" in res, res  # connection never established: autogroup:self drops it
    assert _md(lab.dm["a2"].inbox) == before


def test_raw_same_user_node_recorded_under_verified_name(lab):
    if not lab.probe_bin:
        pytest.skip("AIRBRIDGE_MESHPROBE_BIN not set")
    before = _md(lab.dm["a2"].inbox)
    a2_ip = lab.sc["a2"].status()["self"]["ip"]
    res = lab.probe(lab.users["a"], a2_ip, {"sender_node": "a1", "task_description": "claims to be a1"})
    assert res.get("status") == 201, res
    files = [f for f in _md(lab.dm["a2"].inbox) if f not in before]
    text = files[0].read_text(encoding="utf-8")
    assert "meshprobe" in text  # the verified (control-assigned) name, never the claimed "a1"


def test_direct_local_post_to_python_inbox_without_token_403(lab):
    port = lab.dm["a2"].api("GET", "/status")[1]["inbox"]["port"]
    assert port != 8989
    forged = {"X-AirBridge-Peer-Node": "airbridge-a1", "X-AirBridge-Peer-IP": "100.64.0.1"}
    code, res = http("POST", f"http://127.0.0.1:{port}/incoming_task",
                     {"sender_node": "a1", "task_description": "local forgery"}, forged)
    assert code == 403, res
    code, _ = http("POST", f"http://127.0.0.1:{port}/incoming_task",
                   {"sender_node": "a1", "task_description": "x"}, {**forged, "X-AirBridge-Sidecar-Token": "x" * 43})
    assert code == 403


def test_sidecar_control_api_guards(lab):
    sc = lab.sc["a2"]
    assert http("GET", sc.url + "/status")[0] == 401
    assert http("GET", sc.url + "/status", headers={"Authorization": "Bearer " + "x" * 43})[0] == 401
    code, _ = http("GET", sc.url + "/status", headers={"Authorization": f"Bearer {sc.token}",
                                                       "Origin": "https://evil.example"})
    assert code == 403
    code, res = sc.api("POST", "/send", {"target_hostname": lab.sc["a1"].status()["self"]["ip"], "payload": {}})
    assert code == 400 and res["error"] == "hostname_required"


def test_restart_reuses_node_state_without_key(lab):
    sc = lab.sc["a1"]
    ip_before = sc.status()["self"]["ip"]
    nodes_before = len(json.loads(lab.headscale("nodes", "list")))
    sc.stop()
    sc.start(auth_key=None)
    st = sc.connected()
    assert st["self"]["ip"] == ip_before
    assert len(json.loads(lab.headscale("nodes", "list"))) == nodes_before
    assert not any(p.name.startswith(".authkey") for p in sc.dir.rglob("*"))


def test_no_tailscale_operated_hosts_and_no_secrets_in_logs(lab):
    for sc in lab.sc.values():
        log = (sc.dir / "sidecar.log").read_text(errors="replace")
        assert "hskey-" not in log and sc.token not in log
        assert "log.tailscale.com" not in log and "controlplane.tailscale.com" not in log
        # logtail.Disable(): the local upload buffer files stay empty
        for f in (sc.dir / "tsnet").glob("tailscaled.log*.txt"):
            assert f.stat().st_size == 0, f
