"""Phase 3 ("Invisible Network") security tests - Security-owned.

* ``security.verify_embedded_peer`` table tests (pure; fake whois callables).
* Inbox integration in embedded mode with a fake backend: direct loopback with
  unknown whois -> 403, foreign user -> 403, same user -> 201.
* ``netbackend.EmbeddedTailscale.whois`` against a fake LocalAPI on a Unix
  socket: the query must pin ``proto=tcp`` (a UDP ProxyMapper entry must never
  vouch for a TCP connection - see docs/PHASE3_SECURITY.md F-2).
* Outbox (AST): embedded mode uses ``socks5h://`` proxies and ``trust_env=False``.
* Desktop TS (static): no auth key in tailscaled/tailscale argv or env, and the
  fixed tailscaled argv contract.

Integration tests skip (with an explicit reason) only while the owning module
has not implemented embedded mode yet; once it has, they are hard requirements.
"""

from __future__ import annotations

import ast
import json
import re
import socket
import socketserver
import sys
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from airbridge_app import security
from airbridge_app.security import (
    PEER_BAD_WHOIS,
    PEER_FOREIGN_USER,
    PEER_NOT_LOOPBACK,
    PEER_UNKNOWN,
    EmbeddedPeerError,
    SecurityError,
    VerifiedPeer,
    embedded_peer_node_name,
    verify_embedded_peer,
)

AIRBRIDGE = Path(__file__).resolve().parents[1]
REPO = AIRBRIDGE.parent
APP = AIRBRIDGE / "airbridge_app"
DESKTOP_MAIN = REPO / "desktop" / "src" / "main"

SELF_UID = 7
SAME = {"node": "airbridge-laptop", "user_id": SELF_UID, "tailnet_ip": "100.64.0.9"}
FOREIGN = {"node": "airbridge-evil", "user_id": 8, "tailnet_ip": "100.64.0.66"}
RAW_SAME = {
    "Node": {
        "ID": 3,
        "StableID": "nStable3",
        "Name": "airbridge-laptop.u-abc.example.com.",
        "Addresses": ["100.64.0.9/32", "fd7a:115c:a1e0::9/128"],
        "Hostinfo": {"Hostname": "spoofed-hostname"},
        "User": SELF_UID,
    },
    "UserProfile": {"ID": SELF_UID, "LoginName": "u-abc", "DisplayName": "u-abc"},
    "CapMap": {},
}


class _Whois:
    """Recording fake whois."""

    def __init__(self, result: Any = None, exc: BaseException | None = None) -> None:
        self.result = result
        self.exc = exc
        self.calls: list[str] = []

    def __call__(self, addr: str) -> Any:
        self.calls.append(addr)
        if self.exc is not None:
            raise self.exc
        return self.result


def _reason(excinfo: pytest.ExceptionInfo[EmbeddedPeerError]) -> str:
    return excinfo.value.reason


# --------------------------------------------------------------------------- #
# verify_embedded_peer: source address
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "host",
    [
        "100.64.0.9",  # a tailnet IP is never valid on the embedded path
        "127.0.0.2",  # other loopback addresses: not what netstack dials
        "::ffff:127.0.0.1",  # mapped forms are not accepted (exact strings only)
        "[::1]",
        " 127.0.0.1",
        "127.0.0.1 ",
        "localhost",
        "0.0.0.0",
        "192.168.1.20",
        "",
        "testclient",
        "127.0.0.1\n",
        None,
        2130706433,
        b"127.0.0.1",
    ],
)
def test_rejects_non_loopback_without_calling_whois(host: Any) -> None:
    w = _Whois(SAME)
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer(host, 50000, w, SELF_UID)
    assert _reason(ei) == PEER_NOT_LOOPBACK
    assert w.calls == []


@pytest.mark.parametrize("port", [0, -1, 65536, 10**9, True, False, "50000", 50000.0, None])
def test_rejects_bad_port_without_calling_whois(port: Any) -> None:
    w = _Whois(SAME)
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1", port, w, SELF_UID)
    assert _reason(ei) == PEER_NOT_LOOPBACK
    assert w.calls == []


@pytest.mark.parametrize(
    ("host", "port", "expected"),
    [("127.0.0.1", 50000, "127.0.0.1:50000"), ("::1", 1, "[::1]:1"), ("127.0.0.1", 65535, "127.0.0.1:65535")],
)
def test_whois_is_asked_for_exact_loopback_addr_port(host: str, port: int, expected: str) -> None:
    w = _Whois(SAME)
    assert verify_embedded_peer(host, port, w, SELF_UID) == "laptop"
    assert w.calls == [expected]


# --------------------------------------------------------------------------- #
# verify_embedded_peer: whois outcome
# --------------------------------------------------------------------------- #
def test_unknown_peer_when_whois_returns_none() -> None:
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1", 50000, _Whois(None), SELF_UID)
    assert _reason(ei) == PEER_UNKNOWN


@pytest.mark.parametrize("exc", [OSError("socket gone"), TimeoutError(), ValueError("bad json"), RuntimeError("x")])
def test_unknown_peer_when_whois_raises(exc: BaseException) -> None:
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1", 50000, _Whois(exc=exc), SELF_UID)
    assert _reason(ei) == PEER_UNKNOWN
    assert ei.value.__cause__ is None  # no chained lookup details leak into logs


def test_same_user_normalized_shape_returns_sanitized_node() -> None:
    peer = verify_embedded_peer("127.0.0.1", 50000, _Whois(SAME), SELF_UID)
    assert peer == "laptop"
    assert isinstance(peer, str) and isinstance(peer, VerifiedPeer)
    assert peer.user_id == "7"
    assert peer.tailnet_ip == "100.64.0.9"
    assert peer.get("ip") == "100.64.0.9"
    assert peer.get("node") == "laptop"
    assert peer.get("nope", "d") == "d"


def test_same_user_raw_localapi_shape_uses_control_assigned_name() -> None:
    peer = verify_embedded_peer("127.0.0.1", 50000, _Whois(RAW_SAME), SELF_UID)
    assert peer == "laptop"  # from Node.Name, never the peer-asserted Hostinfo.Hostname
    assert peer.node_id == "nStable3"
    assert peer.tailnet_ip == "100.64.0.9"


@pytest.mark.parametrize(("peer_uid", "self_uid"), [(7, 7), (7, "7"), ("7", 7), ("7", "7"), ("007", 7), ("u-abc", "u-abc")])
def test_user_ids_compared_as_strings(peer_uid: Any, self_uid: Any) -> None:
    w = _Whois({**SAME, "user_id": peer_uid})
    assert verify_embedded_peer("127.0.0.1", 50000, w, self_uid) == "laptop"


@pytest.mark.parametrize(("peer_uid", "self_uid"), [(8, 7), ("8", 7), (70, 7), ("u-abd", "u-abc"), (0, 7)])
def test_foreign_user_rejected(peer_uid: Any, self_uid: Any) -> None:
    w = _Whois({**SAME, "user_id": peer_uid})
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1", 50000, w, self_uid)
    assert _reason(ei) == PEER_FOREIGN_USER


def test_foreign_user_raw_shape_rejected() -> None:
    raw = json.loads(json.dumps(RAW_SAME))
    raw["UserProfile"]["ID"] = 99
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1", 50000, _Whois(raw), SELF_UID)
    assert _reason(ei) == PEER_FOREIGN_USER


@pytest.mark.parametrize(
    "result",
    [
        [],
        "laptop",
        42,
        {},
        {"unrelated": 1},
        {"node": "laptop"},  # no user id
        {"user_id": SELF_UID},  # no node
        {**SAME, "user_id": None},
        {**SAME, "user_id": True},  # bool is not an id
        {**SAME, "user_id": -1},
        {**SAME, "user_id": 7.0},
        {**SAME, "user_id": [7]},
        {**SAME, "user_id": ""},
        {**SAME, "user_id": "7 "},
        {**SAME, "user_id": "7\n"},
        {**SAME, "user_id": "x" * 65},
        {**SAME, "node": ""},
        {**SAME, "node": None},
        {**SAME, "node": 5},
        {**SAME, "node": "lap top"},
        {**SAME, "node": "../../etc/passwd"},
        {**SAME, "node": "evil\nINJECTED log line"},
        {**SAME, "node": "x" * 65},
        {**SAME, "node": "ｌａｐｔｏｐ"},  # fullwidth
        {**SAME, "tailnet_ip": "8.8.8.8"},
        {**SAME, "tailnet_ip": "127.0.0.1"},
        {**SAME, "tailnet_ip": "garbage"},
        {"node": "airbridge-laptop", "user_id": SELF_UID, "ip": "192.168.0.1"},
        {"Node": {"Name": "airbridge-laptop."}},  # no UserProfile
        {"UserProfile": {"ID": SELF_UID}},  # no Node
        {"Node": "x", "UserProfile": {"ID": SELF_UID}},
        {"Node": {"Name": "airbridge-laptop."}, "UserProfile": {"ID": "nope nope"}},
        {"Node": {"Name": "airbridge-laptop.", "Addresses": ["8.8.8.8/32"]}, "UserProfile": {"ID": SELF_UID}},
        {"Node": {"Name": "airbridge-laptop.", "Addresses": []}, "UserProfile": {"ID": SELF_UID}},
        {"Node": {"Name": "airbridge-laptop.", "Addresses": "100.64.0.9/32"}, "UserProfile": {"ID": SELF_UID}},
        # Name missing: Hostinfo.Hostname (peer-asserted) is NOT used as a fallback
        {"Node": {"Hostinfo": {"Hostname": "laptop"}}, "UserProfile": {"ID": SELF_UID}},
    ],
)
def test_bad_whois_schema_rejected(result: Any) -> None:
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1", 50000, _Whois(result), SELF_UID)
    assert _reason(ei) == PEER_BAD_WHOIS
    assert "\n" not in str(ei.value)


def test_schema_checked_before_user_comparison() -> None:
    # A malformed result for a foreign user is reported as bad_whois, never accepted.
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1", 50000, _Whois({**FOREIGN, "node": "bad name"}), SELF_UID)
    assert _reason(ei) == PEER_BAD_WHOIS


@pytest.mark.parametrize("self_uid", [None, True, -3, 7.5, "", "a b", [], {}])
def test_invalid_own_user_id_fails_closed(self_uid: Any) -> None:
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1", 50000, _Whois(SAME), self_uid)
    assert _reason(ei) == PEER_BAD_WHOIS


def test_self_user_id_may_be_a_lazy_callable() -> None:
    calls: list[int] = []

    def own() -> int:
        calls.append(1)
        return SELF_UID

    with pytest.raises(EmbeddedPeerError):
        verify_embedded_peer("127.0.0.1", 50000, _Whois(None), own)
    assert calls == []  # unknown local caller: no second LocalAPI round trip
    assert verify_embedded_peer("127.0.0.1", 50000, _Whois(SAME), own) == "laptop"
    assert calls == [1]


def test_self_user_id_callable_errors_fail_closed() -> None:
    def boom() -> int:
        raise OSError("LocalAPI down")

    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1", 50000, _Whois(SAME), boom)
    assert _reason(ei) == PEER_BAD_WHOIS
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1", 50000, _Whois(SAME), lambda: None)
    assert _reason(ei) == PEER_BAD_WHOIS


def test_embedded_peer_error_is_a_security_error() -> None:
    with pytest.raises(SecurityError):
        verify_embedded_peer("8.8.8.8", 1, _Whois(SAME), SELF_UID)


def test_error_messages_are_log_safe() -> None:
    with pytest.raises(EmbeddedPeerError) as ei:
        verify_embedded_peer("127.0.0.1\r\nFAKE LOG LINE" + "A" * 500, 1, _Whois(SAME), SELF_UID)
    msg = str(ei.value)
    assert "\n" not in msg and "\r" not in msg and len(msg) < 200


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("airbridge-laptop", "laptop"),
        ("AirBridge-Laptop", "Laptop"),
        ("airbridge-laptop.u-abc.example.com.", "laptop"),
        ("airbridge-laptop.", "laptop"),
        ("laptop", "laptop"),
        ("airbridge-", "airbridge-"),
        ("airbridge-my_box-2", "my_box-2"),
    ],
)
def test_node_name_normalization(name: str, expected: str) -> None:
    assert embedded_peer_node_name(name) == expected


@pytest.mark.parametrize("name", ["", ".", "..", "a b.example.", "x" * 300, None, 3, "airbridge-" + "x" * 65])
def test_node_name_rejects(name: Any) -> None:
    with pytest.raises(SecurityError):
        embedded_peer_node_name(name)


# --------------------------------------------------------------------------- #
# Inbox integration (embedded mode, fake backend)
# --------------------------------------------------------------------------- #
def _inbox_supports_embedded() -> bool:
    src = (APP / "inbox.py").read_text(encoding="utf-8")
    return "verify_embedded_peer" in src


class FakeEmbeddedBackend:
    kind = "embedded"

    def __init__(self, whois_result: Any, self_uid: Any = SELF_UID) -> None:
        self.whois_result = whois_result
        self.self_uid = self_uid
        self.whois_calls: list[str] = []

    def whois(self, remote_addr: str) -> Any:
        self.whois_calls.append(remote_addr)
        return self.whois_result

    def self_user_id(self) -> Any:
        return self.self_uid

    def inbound_bind_host(self) -> str:
        return "127.0.0.1"

    def requests_proxies(self) -> dict[str, str]:
        return {"http": "socks5h://127.0.0.1:1080"}

    def local_ip(self) -> str:
        return "100.64.0.1"

    def peers(self) -> dict[str, str]:
        return {}

    def peer_details(self) -> dict[str, Any]:
        return {"self": {}, "nodes": []}

    def resolve(self, host: str) -> str | None:
        return None


def _payload() -> dict[str, Any]:
    return {
        "sender_node": "laptop",
        "task_description": "Phase 3 security test task",
        "code_payload": "print('hi')\n",
    }


@pytest.fixture
def embedded_client(settings):  # noqa: ANN001, ANN201
    if not _inbox_supports_embedded():
        pytest.skip("PENDING (Systems): inbox.py has no embedded mode yet (no verify_embedded_peer call)")
    from fastapi.testclient import TestClient

    from airbridge_app import inbox

    def make(backend: FakeEmbeddedBackend, client: tuple[str, int] = ("127.0.0.1", 41234)) -> TestClient:
        app = inbox.create_app(settings, peers_provider=lambda: {}, backend=backend)
        return TestClient(app, client=client)

    return make


def _md(inbox_dir: Path) -> list[Path]:
    return sorted(inbox_dir.glob("*.md")) if inbox_dir.exists() else []


def test_embedded_direct_local_connection_unknown_whois_403(embedded_client, inbox_dir) -> None:  # noqa: ANN001
    backend = FakeEmbeddedBackend(None)
    r = embedded_client(backend).post("/incoming_task", json=_payload())
    assert r.status_code == 403
    assert backend.whois_calls == ["127.0.0.1:41234"]
    assert _md(inbox_dir) == []
    h = embedded_client(FakeEmbeddedBackend(None)).get("/health")
    assert h.status_code == 403


def test_embedded_foreign_user_403(embedded_client, inbox_dir) -> None:  # noqa: ANN001
    r = embedded_client(FakeEmbeddedBackend(FOREIGN)).post("/incoming_task", json=_payload())
    assert r.status_code == 403
    assert _md(inbox_dir) == []


def test_embedded_bad_whois_403(embedded_client, inbox_dir) -> None:  # noqa: ANN001
    r = embedded_client(FakeEmbeddedBackend({"node": "x y", "user_id": SELF_UID})).post(
        "/incoming_task", json=_payload()
    )
    assert r.status_code == 403
    assert _md(inbox_dir) == []


def test_embedded_unknown_own_identity_403(embedded_client, inbox_dir) -> None:  # noqa: ANN001
    r = embedded_client(FakeEmbeddedBackend(SAME, self_uid=None)).post("/incoming_task", json=_payload())
    assert r.status_code == 403
    assert _md(inbox_dir) == []


def test_embedded_same_user_201(embedded_client, inbox_dir) -> None:  # noqa: ANN001
    r = embedded_client(FakeEmbeddedBackend(SAME)).post("/incoming_task", json=_payload())
    assert r.status_code == 201, r.text
    assert len(_md(inbox_dir)) == 1


def test_embedded_same_user_raw_shape_201(embedded_client, inbox_dir) -> None:  # noqa: ANN001
    r = embedded_client(FakeEmbeddedBackend(RAW_SAME)).post("/incoming_task", json=_payload())
    assert r.status_code == 201, r.text


def test_embedded_rejects_non_loopback_source_even_if_tailnet(embedded_client) -> None:  # noqa: ANN001
    backend = FakeEmbeddedBackend(SAME)
    r = embedded_client(backend, client=("100.64.0.9", 41234)).post("/incoming_task", json=_payload())
    assert r.status_code == 403
    assert backend.whois_calls == []


def test_system_mode_still_rejects_loopback(settings) -> None:  # noqa: ANN001
    """Phase-1 path is unchanged: without an embedded backend 127.0.0.1 is not a tailnet address."""
    from fastapi.testclient import TestClient

    from airbridge_app import inbox

    app = inbox.create_app(settings, peers_provider=lambda: {})
    r = TestClient(app, client=("127.0.0.1", 41234)).post("/incoming_task", json=_payload())
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# netbackend.EmbeddedTailscale.whois against a fake LocalAPI (Unix socket)
# --------------------------------------------------------------------------- #
class _UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


@pytest.fixture
def fake_localapi(tmp_path: Path):  # noqa: ANN201
    if not hasattr(socket, "AF_UNIX") or sys.platform.startswith("win"):
        pytest.skip("Unix sockets only")
    if not (APP / "netbackend.py").exists():
        pytest.skip("PENDING (Systems): netbackend.py not present yet")
    seen: list[dict[str, Any]] = []
    whois_body = json.dumps(RAW_SAME).encode()
    status_body = json.dumps({"BackendState": "Running", "Self": {"UserID": SELF_UID, "HostName": "airbridge-me",
                                                                  "TailscaleIPs": ["100.64.0.1"]}, "Peer": {}}).encode()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a: Any) -> None:  # client_address is '' on AF_UNIX
            pass

        def do_GET(self) -> None:  # noqa: N802
            u = urlsplit(self.path)
            seen.append({"path": u.path, "query": parse_qs(u.query), "headers": dict(self.headers)})
            body = whois_body if u.path == "/localapi/v0/whois" else status_body
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

    sock_path = tmp_path / "ts.sock"
    srv = _UnixHTTPServer(str(sock_path), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield str(sock_path), seen
    finally:
        srv.shutdown()
        srv.server_close()


def test_netbackend_whois_pins_proto_tcp(fake_localapi) -> None:  # noqa: ANN001
    """F-2: tailscaled's WhoIs tries tcp *then udp* when proto is omitted
    (ipn/ipnlocal/local.go:1775-1787). netstack registers UDP flows to
    127.0.0.1:<peer-chosen src port> for 2 min (netstack.go:2133,2179), so a
    local process that connects over TCP from that same port number would be
    attributed to the peer. The LocalAPI query must carry proto=tcp."""
    from airbridge_app import netbackend

    sock, seen = fake_localapi
    be = netbackend.EmbeddedTailscale(sock, "127.0.0.1:1080")
    res = be.whois("127.0.0.1:41234")
    assert res is not None
    whois_reqs = [s for s in seen if s["path"] == "/localapi/v0/whois"]
    assert len(whois_reqs) == 1
    q = whois_reqs[0]["query"]
    assert q.get("addr") == ["127.0.0.1:41234"]
    assert q.get("proto") == ["tcp"], f"whois must pin proto=tcp, got query {q}"
    hdrs = {k.lower(): v for k, v in whois_reqs[0]["headers"].items()}
    assert hdrs.get("sec-tailscale") == "localapi"


def test_netbackend_whois_output_verifies(fake_localapi) -> None:  # noqa: ANN001
    """Shape compatibility: whatever netbackend.whois returns must pass verify_embedded_peer."""
    from airbridge_app import netbackend

    sock, _ = fake_localapi
    be = netbackend.EmbeddedTailscale(sock, "127.0.0.1:1080")
    peer = verify_embedded_peer("127.0.0.1", 41234, be.whois, be.self_user_id)
    assert peer == "laptop"  # control-assigned Node.Name, not the peer-asserted Hostinfo.Hostname (F-7)
    assert peer.user_id == str(SELF_UID)


def test_netbackend_embedded_proxies_are_socks5h_loopback() -> None:
    if not (APP / "netbackend.py").exists():
        pytest.skip("PENDING (Systems): netbackend.py not present yet")
    from airbridge_app import netbackend

    proxies = netbackend.EmbeddedTailscale("/nonexistent.sock", "127.0.0.1:1080").requests_proxies()
    assert proxies and "http" in proxies
    for scheme, url in proxies.items():
        # socks5h: hostname resolution happens inside tailscaled (no local DNS leak of peer names)
        assert re.fullmatch(r"socks5h://127\.0\.0\.1:\d{1,5}", url), (scheme, url)


def test_netbackend_rejects_non_loopback_socks5_endpoint() -> None:
    if not (APP / "netbackend.py").exists():
        pytest.skip("PENDING (Systems): netbackend.py not present yet")
    from airbridge_app import netbackend

    validate = getattr(netbackend, "_valid_socks5", None)
    if validate is None:
        pytest.skip("no socks5 validator exposed")
    for bad in ["0.0.0.0:1080", "localhost:1080", "10.0.0.1:1080", "127.0.0.1:0", "127.0.0.1:99999", "127.0.0.1"]:
        assert validate(bad) is None, bad
    assert validate("127.0.0.1:1080") == "127.0.0.1:1080"


# --------------------------------------------------------------------------- #
# Outbox (AST): proxies + trust_env
# --------------------------------------------------------------------------- #
def _outbox_tree() -> ast.Module:
    return ast.parse((APP / "outbox.py").read_text(encoding="utf-8"))


def test_outbox_session_never_trusts_env() -> None:
    tree = _outbox_tree()
    found = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Attribute) and tgt.attr == "trust_env":
                    assert isinstance(node.value, ast.Constant) and node.value.value is False
                    found = True
    assert found, "outbox must set session.trust_env = False (env NO_PROXY/HTTP_PROXY must not bypass socks5h)"
    # No module-level requests.post/get (they always trust the environment).
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            base = node.func.value
            if isinstance(base, ast.Name) and base.id == "requests":
                assert node.func.attr not in {"get", "post", "put", "request", "head", "delete", "patch"}, (
                    f"requests.{node.func.attr}() at line {node.lineno} bypasses trust_env=False"
                )


def test_outbox_passes_backend_proxies_in_embedded_mode() -> None:
    src = (APP / "outbox.py").read_text(encoding="utf-8")
    if "requests_proxies" not in src:
        pytest.skip("PENDING (Systems): outbox.py does not use network.requests_proxies() yet")
    tree = _outbox_tree()
    calls_with_proxies = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in {"post", "get", "request", "send"}:
                kws = {k.arg for k in node.keywords}
                if "proxies" in kws:
                    calls_with_proxies.append(node.lineno)
    assignments = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Assign)
        and any(isinstance(t, ast.Attribute) and t.attr == "proxies" for t in n.targets)
    ]
    session_updates = [
        n.lineno for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "update"
        and isinstance(n.func.value, ast.Attribute) and n.func.value.attr == "proxies"
    ]
    assert calls_with_proxies or assignments or session_updates, (
        "outbox must pass proxies=network.requests_proxies() to the session"
    )
    assert not re.search(r"socks5://", src), "use socks5h:// (remote DNS), never socks5://"


# --------------------------------------------------------------------------- #
# Desktop TS (static): auth keys never in argv/env; argv contract
# --------------------------------------------------------------------------- #
def _network_ts_files() -> list[Path]:
    d = DESKTOP_MAIN / "network"
    return sorted(d.glob("*.ts")) if d.is_dir() else []


def _strip_ts_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(?m)^\s*//.*$", "", src)


@pytest.fixture
def network_ts() -> dict[str, str]:
    files = _network_ts_files()
    if not files:
        pytest.skip("PENDING (Systems/SWE): desktop/src/main/network/*.ts not present yet")
    return {f.name: _strip_ts_comments(f.read_text(encoding="utf-8")) for f in files}


def test_ts_auth_key_only_passed_as_file(network_ts: dict[str, str]) -> None:
    problems = []
    for name, src in network_ts.items():
        for m in re.finditer(r"--auth-?key\b", src, flags=re.I):
            window = src[m.end(): m.end() + 40]
            if not re.match(r"""\s*=?\s*['"`]?\s*(?:\$\{\s*)?['"`]?file:""", window) and "file:" not in window:
                problems.append(f"{name}: --auth-key not followed by file: ({window!r})")
        if re.search(r"""['"`]--auth-?key['"`]\s*,""", src):
            problems.append(f"{name}: --auth-key passed as a separate argv element (value would be the key)")
        if re.search(r"TS_AUTH_?KEY", src):
            problems.append(f"{name}: auth key passed through the environment (TS_AUTHKEY)")
        if re.search(r"""['"`](?:tskey|hskey)-""", src):
            problems.append(f"{name}: literal key prefix in source")
    assert problems == []


def test_ts_auth_key_variable_not_in_argv_arrays(network_ts: dict[str, str]) -> None:
    """The fetched key (e.g. `auth_key`/`authKey`/`key`) must only be written to the key file."""
    problems = []
    for name, src in network_ts.items():
        for m in re.finditer(r"\[[^\[\]]*['\"`]up['\"`][^\[\]]*\]", src, flags=re.S):
            arr = m.group(0)
            if re.search(r"\bauth_?key\b(?!\s*File|\s*Path|_file|_path)", arr, flags=re.I) and "file:" not in arr:
                problems.append(f"{name}: auth key variable inside `up` argv: {arr[:120]!r}")
    assert problems == []


def test_ts_tailscaled_argv_contract(network_ts: dict[str, str]) -> None:
    mgr = network_ts.get("TailscaleManager.ts")
    if mgr is None:
        pytest.skip("PENDING (Systems): TailscaleManager.ts not present yet")
    assert "--tun=userspace-networking" in mgr
    assert "--no-logs-no-support" in mgr
    assert re.search(r"--socks5-server=127\.0\.0\.1:", mgr), "SOCKS5 must bind 127.0.0.1 only"
    for forbidden in ("--socks5-server=0.0.0.0", "--socks5-server=localhost", "--socks5-server=:",
                      "--outbound-http-proxy-listen", "--debug=", "--tun=tailscale0", "--port=41641"):
        assert forbidden not in mgr, forbidden
    if re.search(r"pipe", mgr, flags=re.I):
        # tailscaled v1.104.7 refuses a --socket outside \\.\pipe\ProtectedPrefix\Administrators\ unless
        # --windows-mode=dev (cmd/tailscaled/tailscaled.go:363-385); dev mode also makes the pipe user-only.
        assert "--windows-mode=dev" in mgr, "Windows custom pipe needs --windows-mode=dev (F-4)"


def test_ts_spawn_env_is_scrubbed(network_ts: dict[str, str]) -> None:
    mgr = network_ts.get("TailscaleManager.ts")
    if mgr is None:
        pytest.skip("PENDING (Systems): TailscaleManager.ts not present yet")
    assert not re.search(r"env\s*:\s*process\.env\b", mgr), "do not pass the full parent env to tailscaled"
    assert not re.search(r"\.\.\.\s*process\.env\b", mgr), "do not spread process.env into tailscaled's env"


def test_ts_no_key_logging(network_ts: dict[str, str]) -> None:
    problems = []
    for name, src in network_ts.items():
        for m in re.finditer(r"(?:console\.\w+|log(?:ger)?\.\w+)\s*\(([^;]*?)\)\s*;", src, flags=re.S):
            args = m.group(1)
            if re.search(r"\bauth_?key\b(?!\s*File|\s*Path|_file|_path)|\bpreauth", args, flags=re.I):
                problems.append(f"{name}: possible key in log call: {args[:100]!r}")
    assert problems == []


def test_security_module_exports() -> None:
    for name in ("verify_embedded_peer", "EmbeddedPeerError", "VerifiedPeer", "embedded_peer_node_name"):
        assert name in security.__all__
