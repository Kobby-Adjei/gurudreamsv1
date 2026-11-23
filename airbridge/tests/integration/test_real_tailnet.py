"""REAL end-to-end test: Headscale v0.29.7 + three userspace tailscaled v1.104.7 + AirBridge.

Skipped unless ``AIRBRIDGE_REAL_TAILNET=1``. Run it with
``airbridge/tests/integration/run_real_tailnet.sh`` (builds what is missing).

Needs (env, all absolute paths):
  AIRBRIDGE_HEADSCALE_BIN   headscale v0.29.7 binary
  AIRBRIDGE_TAILSCALE_DIR   dir with tailscaled + tailscale (default:
                            desktop/resources/tailscale/<platform>-<arch>)
Linux/macOS only. Uses 127.0.0.1:8989 (only one inbox per host can own it:
tailscaled's netstack forwards tailnet :8989 to localhost:8989 on this host,
so this single-machine topology has exactly one receiver).

Topology:  user A: A1 (sender), A2 (receiver: real `main.py --daemon`)
           user B: B1 (sender)
Policy:    {"acls":[{"action":"accept","src":["autogroup:member"],"dst":["autogroup:self:8989"]}]}
Asserts:   A1 -> A2 delivered (whois = A1, recorded tailnet IP = A1's);
           B1 -> A2 blocked; A1 -> A2 on another port blocked;
           local process -> 127.0.0.1:8989 directly -> 403;
           A2's /nodes lists A1 only (no B1, no airbridge- prefix).
"""

from __future__ import annotations

import asyncio
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
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("AIRBRIDGE_REAL_TAILNET") != "1" or os.name == "nt",
    reason="real tailnet test: set AIRBRIDGE_REAL_TAILNET=1 (see run_real_tailnet.sh)",
)

ROOT = Path(__file__).resolve().parents[3]
AIRBRIDGE = ROOT / "airbridge"
HS_PORT, HS_METRICS, HS_GRPC, HS_STUN = 28281, 29291, 50643, 23579
SOCKS = {"a1": 21181, "a2": 21182, "b1": 21183}
INBOX_PORT = 8989


def _ts_dir() -> Path:
    env = os.environ.get("AIRBRIDGE_TAILSCALE_DIR")
    if env:
        return Path(env)
    plat = {"linux": "linux", "darwin": "darwin"}.get(sys.platform, sys.platform)
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}[os.uname().machine.lower()]
    return ROOT / "desktop" / "resources" / "tailscale" / f"{plat}-{arch}"


def _clean_env(**extra: str) -> dict[str, str]:
    """No proxy variables: they would hijack (or bypass) the tailnet path."""
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


def _port_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


class Lab:
    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="abrt", dir="/tmp"))  # short: sun_path limit
        self.procs: list[subprocess.Popen] = []
        self.hs_bin = os.environ.get("AIRBRIDGE_HEADSCALE_BIN", "")
        self.ts = _ts_dir()

    # -- processes ---------------------------------------------------------
    def spawn(self, name: str, argv: list[str], env: dict[str, str]) -> subprocess.Popen:
        log = open(self.dir / f"{name}.log", "wb")  # noqa: SIM115
        p = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                             cwd=str(self.dir), start_new_session=True)
        self.procs.append(p)
        return p

    def close(self) -> None:
        for p in reversed(self.procs):
            with contextlib.suppress(Exception):
                p.send_signal(signal.SIGTERM)
        for p in reversed(self.procs):
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()

    # -- headscale ---------------------------------------------------------
    def headscale(self, *args: str) -> str:
        out = subprocess.run([self.hs_bin, "-c", str(self.dir / "hs" / "config.yaml"), *args, "-o", "json"],
                             capture_output=True, text=True, timeout=30, env=_clean_env())
        assert out.returncode == 0, out.stderr[-500:]
        return out.stdout

    def start_headscale(self) -> None:
        hs = self.dir / "hs"
        hs.mkdir(mode=0o700)
        (hs / "policy.hujson").write_text(json.dumps(
            {"acls": [{"action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:self:8989"]}]}))
        (hs / "config.yaml").write_text(f"""
server_url: http://127.0.0.1:{HS_PORT}
listen_addr: 127.0.0.1:{HS_PORT}
metrics_listen_addr: 127.0.0.1:{HS_METRICS}
grpc_listen_addr: 127.0.0.1:{HS_GRPC}
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
    stun_listen_addr: 127.0.0.1:{HS_STUN}
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
        self.spawn("headscale", [self.hs_bin, "-c", str(hs / "config.yaml"), "serve"], _clean_env())
        _wait(lambda: (hs / "hs.sock").exists() and not _port_free(HS_PORT), 30, "headscale")

    def create_user(self, name: str) -> int:
        return int(json.loads(self.headscale("users", "create", name))["id"])

    def preauth_key(self, user_id: int) -> str:
        return json.loads(self.headscale("preauthkeys", "create", "--user", str(user_id), "--expiration", "10m"))["key"]

    # -- tailscaled --------------------------------------------------------
    def sock(self, n: str) -> str:
        return str(self.dir / n / "ts.sock")

    def start_node(self, n: str) -> None:
        d = self.dir / n
        d.mkdir(mode=0o700)
        # The exact argv contract TailscaleManager uses (PHASE3_PLAN.md section 2).
        self.spawn(f"tailscaled-{n}", [
            str(self.ts / "tailscaled"), "--tun=userspace-networking", f"--statedir={d / 'state'}",
            f"--socket={self.sock(n)}", f"--socks5-server=127.0.0.1:{SOCKS[n]}", "--port=0", "--no-logs-no-support",
        ], _clean_env())
        _wait(lambda: Path(self.sock(n)).exists(), 20, f"tailscaled {n} socket")

    def up(self, n: str, user_id: int) -> None:
        keyfile = self.dir / n / f".authkey-{secrets.token_hex(4)}"
        fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, self.preauth_key(user_id).encode())
            os.close(fd)
            out = subprocess.run([
                str(self.ts / "tailscale"), f"--socket={self.sock(n)}", "up", "--reset",
                f"--login-server=http://127.0.0.1:{HS_PORT}", f"--auth-key=file:{keyfile}",
                f"--hostname=airbridge-{n}", "--accept-routes=false", "--accept-dns=false", "--timeout=60s",
            ], capture_output=True, text=True, timeout=90, env=_clean_env())
            assert out.returncode == 0, out.stderr[-500:]
        finally:
            keyfile.unlink(missing_ok=True)


@pytest.fixture(scope="module")
def lab():
    lab = Lab()
    assert lab.hs_bin and os.access(lab.hs_bin, os.X_OK), "set AIRBRIDGE_HEADSCALE_BIN"
    assert (lab.ts / "tailscaled").exists(), f"build tailscaled first ({lab.ts})"
    assert _port_free(INBOX_PORT), "127.0.0.1:8989 is busy (another AirBridge inbox?)"
    try:
        lab.start_headscale()
        ua, ub = lab.create_user("u-a"), lab.create_user("u-b")
        for n in ("a1", "a2", "b1"):
            lab.start_node(n)
        lab.up("a1", ua)
        lab.up("a2", ua)
        lab.up("b1", ub)
        yield lab
    finally:
        lab.close()


@pytest.fixture(scope="module")
def receiver(lab):
    """The real daemon for A2, exactly as the desktop app's ProcessManager starts it."""
    token = secrets.token_urlsafe(32)
    inbox = lab.dir / "inbox-a2"
    env = _clean_env(
        AIRBRIDGE_CONTROL_TOKEN=token, AIRBRIDGE_CONTROL_PORT="0",
        AIRBRIDGE_DATA_DIR=str(lab.dir / "data-a2"), AIRBRIDGE_INBOX_DIR=str(inbox),
        AIRBRIDGE_LOG_FILE=str(lab.dir / "daemon-a2-app.log"),
        AIRBRIDGE_NETWORK="embedded", AIRBRIDGE_TS_SOCKET=lab.sock("a2"),
        AIRBRIDGE_TS_SOCKS5=f"127.0.0.1:{SOCKS['a2']}",
    )
    p = subprocess.Popen([sys.executable, str(AIRBRIDGE / "main.py"), "--daemon"], env=env,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                         cwd=str(lab.dir))
    lab.procs.append(p)
    line = p.stderr.readline().decode()
    assert line.startswith("AIRBRIDGE_READY "), line
    port = json.loads(line.split(" ", 1)[1])["control_port"]

    import httpx

    def get(path: str):
        return httpx.get(f"http://127.0.0.1:{port}{path}", headers={"Authorization": f"Bearer {token}"},
                         trust_env=False, timeout=10).json()

    _wait(lambda: get("/status")["inbox"]["listening"], 40, "A2 inbox listening")
    return {"get": get, "inbox": inbox}


def _send_from(lab: Lab, n: str, target: str, text: str) -> dict:
    """Real outbox (requests + socks5h) on sender node *n*."""
    from airbridge_app import config, netbackend, outbox

    netbackend.set_backend_override(netbackend.EmbeddedTailscale(lab.sock(n), f"127.0.0.1:{SOCKS[n]}"))
    try:
        s = config.Settings(inbox_dir=lab.dir / f"unused-{n}", log_file=lab.dir / f"{n}.app.log", http_timeout_s=10)
        return asyncio.run(outbox.send_task_result(s, target, text))
    finally:
        netbackend.set_backend_override(None)


def test_a2_status_and_nodes_show_same_user_only(lab, receiver):
    st = receiver["get"]("/status")
    assert st["tailnet_ip"] and st["tailnet_ip"].startswith("100.")
    nodes = _wait(lambda: (lambda r: r if any(n["hostname"] == "a1" and n["online"] for n in r["nodes"]) else None)(
        receiver["get"]("/nodes")), 30, "A1 online in A2's /nodes")
    assert nodes["error"] is None
    assert nodes["self"]["hostname"] == "a2"
    assert [n["hostname"] for n in nodes["nodes"]] == ["a1"], nodes  # B1 invisible (autogroup:self)


def test_a1_to_a2_delivered_with_whois_identity(lab, receiver):
    from airbridge_app import netbackend

    a1_ip = netbackend.EmbeddedTailscale(lab.sock("a1"), "127.0.0.1:1").local_ip()
    # First connection right after `up` can race the peer's packet filter / path setup: retry briefly.
    result = _wait(lambda: (lambda r: r if r["ok"] else None)(_send_from(lab, "a1", "a2", "hello from A1")),
                   45, "A1 -> A2 delivery")
    files = sorted(receiver["inbox"].glob("*.md"))
    assert files and result["file"] == files[-1].name
    text = files[-1].read_text(encoding="utf-8")
    assert f'source_ip: "{a1_ip}"' in text, text[:400]  # whois-resolved, not 127.0.0.1
    assert "hello from A1" in text


def test_b1_to_a2_blocked(lab, receiver):
    from airbridge_app import netbackend

    # B1 cannot even resolve A2 (other user's node is not in its netmap)...
    r = _send_from(lab, "b1", "a2", "hello from B1")
    assert r["ok"] is False and r["status"] == 404, r
    # ...and dialing A2's tailnet IP through B1's SOCKS5 is refused by the ACL.
    a2_ip = netbackend.EmbeddedTailscale(lab.sock("a2"), "127.0.0.1:1").local_ip()
    import requests

    with requests.Session() as s:
        s.trust_env = False
        s.proxies.update({"http": f"socks5h://127.0.0.1:{SOCKS['b1']}"})
        with pytest.raises(requests.exceptions.RequestException):
            s.post(f"http://{a2_ip}:{INBOX_PORT}/incoming_task", json={"sender_node": "b1", "task_description": "x"},
                   timeout=10)


def test_a1_to_a2_other_port_blocked_by_acl(lab, receiver):
    from airbridge_app import netbackend
    import requests

    a2_ip = netbackend.EmbeddedTailscale(lab.sock("a2"), "127.0.0.1:1").local_ip()
    with requests.Session() as s:
        s.trust_env = False
        s.proxies.update({"http": f"socks5h://127.0.0.1:{SOCKS['a1']}"})
        with pytest.raises(requests.exceptions.RequestException):
            s.get(f"http://{a2_ip}:{HS_PORT}/", timeout=10)  # headscale's port on the same host


def test_local_direct_connection_is_403(lab, receiver):
    import httpx

    r = httpx.post(f"http://127.0.0.1:{INBOX_PORT}/incoming_task", trust_env=False, timeout=10,
                   json={"sender_node": "evil", "task_description": "local process"})
    assert r.status_code == 403
    assert "unknown_peer" in r.json()["detail"]
