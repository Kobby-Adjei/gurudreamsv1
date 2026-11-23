"""Phase 3 ("Invisible Network") security tests - Security-owned.

* ``security.verify_embedded_peer`` table tests (pure; fake whois callables).
* Inbox integration in sidecar mode (PHASE3_PLAN.md §9; the airbridge-net sidecar does the
  WhoIs + same-user check and forwards with a per-daemon token): direct loopback without the
  sidecar token -> 403 (whatever peer headers it forges), wrong token -> 403, non-loopback
  -> 403, token + verified peer -> 201 with the verified sender recorded.
  (The bundled-tailscaled LocalAPI whois path was removed with §9; the WhoIs/same-user
  checks now live in the sidecar's Go tests: desktop/sidecar/airbridge-net/handlers_test.go.)
* Sidecar client: bearer + exact Host on every control-API request, no proxies.
* Outbox (AST): ``trust_env=False``; sidecar mode sends a hostname, never an IP.
* Desktop TS (static): the pre-auth key travels only on the sidecar's stdin (never argv,
  env, a file or a log line); fixed sidecar spawn contract.
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
# Inbox integration (sidecar mode)
# --------------------------------------------------------------------------- #
SIDECAR_TOKEN = "sidecar-token-0123456789abcdefghijklmnopqrstuv"


def _payload() -> dict[str, Any]:
    return {
        "sender_node": "laptop",
        "task_description": "Phase 3 security test task",
        "code_payload": "print('hi')\n",
    }


def _peer_headers(node: str = "airbridge-laptop", ip: str | None = "100.64.0.9",
                  token: str | None = SIDECAR_TOKEN) -> dict[str, str]:
    h = {"X-AirBridge-Peer-Node": node}
    if ip is not None:
        h["X-AirBridge-Peer-IP"] = ip
    if token is not None:
        h["X-AirBridge-Sidecar-Token"] = token
    return h


@pytest.fixture
def sidecar_client(settings):  # noqa: ANN001, ANN201
    from fastapi.testclient import TestClient

    from airbridge_app import inbox

    def make(client: tuple[str, int] = ("127.0.0.1", 41234)) -> TestClient:
        app = inbox.create_app(settings, peers_provider=lambda: {}, sidecar_token=SIDECAR_TOKEN)
        return TestClient(app, client=client)

    return make


def _md(inbox_dir: Path) -> list[Path]:
    return sorted(inbox_dir.glob("*.md")) if inbox_dir.exists() else []


def test_sidecar_direct_local_connection_without_token_403(sidecar_client, inbox_dir) -> None:  # noqa: ANN001
    """A local process that forges the peer headers but has no sidecar token is refused."""
    r = sidecar_client().post("/incoming_task", json=_payload(), headers=_peer_headers(token=None))
    assert r.status_code == 403
    assert "sidecar token" in r.json()["detail"]
    assert _md(inbox_dir) == []
    assert sidecar_client().get("/health").status_code == 403


@pytest.mark.parametrize("token", ["", "wrong", SIDECAR_TOKEN + "x", SIDECAR_TOKEN[:-1], SIDECAR_TOKEN.upper()])
def test_sidecar_wrong_token_403(sidecar_client, inbox_dir, token) -> None:  # noqa: ANN001
    r = sidecar_client().post("/incoming_task", json=_payload(), headers=_peer_headers(token=token))
    assert r.status_code == 403
    assert _md(inbox_dir) == []


def test_sidecar_token_compared_in_constant_time() -> None:
    src = (APP / "inbox.py").read_text(encoding="utf-8")
    assert "hmac.compare_digest" in src


def test_sidecar_rejects_non_loopback_source_even_with_token(sidecar_client, inbox_dir) -> None:  # noqa: ANN001
    r = sidecar_client(client=("100.64.0.9", 41234)).post("/incoming_task", json=_payload(),
                                                         headers=_peer_headers())
    assert r.status_code == 403
    assert _md(inbox_dir) == []


@pytest.mark.parametrize("node,ip", [("", "100.64.0.9"), ("x y", "100.64.0.9"), ("a/b", None),
                                     ("airbridge-laptop", "8.8.8.8"), ("airbridge-laptop", "127.0.0.1")])
def test_sidecar_bad_peer_headers_403(sidecar_client, inbox_dir, node, ip) -> None:  # noqa: ANN001
    r = sidecar_client().post("/incoming_task", json=_payload(), headers=_peer_headers(node=node, ip=ip))
    assert r.status_code == 403
    assert _md(inbox_dir) == []


def test_sidecar_same_user_201(sidecar_client, inbox_dir) -> None:  # noqa: ANN001
    r = sidecar_client().post("/incoming_task", json=_payload(), headers=_peer_headers())
    assert r.status_code == 201, r.text
    files = _md(inbox_dir)
    assert len(files) == 1
    assert "100.64.0.9" in files[0].read_text(encoding="utf-8")  # verified tailnet IP recorded


def test_sidecar_mode_is_off_without_a_token(settings) -> None:  # noqa: ANN001
    """No sidecar token configured -> Phase-1 rules: loopback is not a tailnet address."""
    from fastapi.testclient import TestClient

    from airbridge_app import inbox

    app = inbox.create_app(settings, peers_provider=lambda: {})
    r = TestClient(app, client=("127.0.0.1", 41234)).post("/incoming_task", json=_payload(),
                                                         headers=_peer_headers())
    assert r.status_code == 403


def _payload_from(sender: str) -> dict[str, Any]:
    return {**_payload(), "sender_node": sender}


def test_sidecar_sender_mismatch_400_by_default(sidecar_client, inbox_dir) -> None:  # noqa: ANN001
    """F-13: REJECT_SENDER_MISMATCH is enabled (sidecar outbox sends its verified name)."""
    from airbridge_app import inbox

    assert inbox.REJECT_SENDER_MISMATCH is True
    r = sidecar_client().post("/incoming_task", json=_payload_from("desktop"), headers=_peer_headers())
    assert r.status_code == 400
    assert "sender_mismatch" in r.json()["detail"]
    assert _md(inbox_dir) == []


def test_sidecar_sender_mismatch_overwritten_if_reject_disabled(sidecar_client, inbox_dir, monkeypatch) -> None:  # noqa: ANN001
    from airbridge_app import inbox

    monkeypatch.setattr(inbox, "REJECT_SENDER_MISMATCH", False)
    r = sidecar_client().post("/incoming_task", json=_payload_from("desktop"), headers=_peer_headers())
    assert r.status_code == 201
    text = _md(inbox_dir)[0].read_text(encoding="utf-8")
    assert "laptop" in text and "desktop" not in text  # self-asserted name never recorded


@pytest.mark.parametrize(
    ("claimed", "verified_name", "stored"),
    [
        ("laptop", "airbridge-laptop", "laptop"),
        ("Laptop", "airbridge-laptop", "laptop"),
        ("airbridge-laptop", "airbridge-laptop", "laptop"),
        ("MacBook-Pro", "airbridge-macbook-pro-3", "macbook-pro-3"),  # Headscale global collision bump
        ("Jane-s-MacBook-Pro", "airbridge-janes-macbook-pro", "janes-macbook-pro"),
    ],
)
def test_sidecar_sender_replaced_by_verified_name(sidecar_client, inbox_dir, claimed, verified_name, stored) -> None:  # noqa: ANN001
    r = sidecar_client().post("/incoming_task", json=_payload_from(claimed), headers=_peer_headers(node=verified_name))
    assert r.status_code == 201, r.text
    files = _md(inbox_dir)
    assert len(files) == 1
    text = files[0].read_text(encoding="utf-8")
    assert stored in text
    if claimed != stored and claimed.lower() != stored:
        assert claimed not in text  # the self-asserted name is never what gets recorded


@pytest.mark.parametrize(
    ("claimed", "verified", "ok"),
    [
        ("laptop", "laptop", True),
        ("LAPTOP", "laptop", True),
        ("airbridge-laptop", "laptop", True),
        ("pc", "pc2", True),
        ("macbook-pro", "macbook-pro-12", True),
        ("laptop2", "laptop", False),
        ("desktop", "laptop", False),
        ("lap", "laptop", False),
        ("", "laptop", False),
        ("---", "laptop", False),
        ("laptop", "", False),
    ],
)
def test_sender_matches_verified(claimed: str, verified: str, ok: bool) -> None:
    from airbridge_app import inbox

    assert inbox.sender_matches_verified(claimed, verified) is ok


def test_system_mode_keeps_payload_sender(settings, inbox_dir) -> None:  # noqa: ANN001
    from fastapi.testclient import TestClient

    from airbridge_app import inbox

    app = inbox.create_app(settings, peers_provider=lambda: {})
    r = TestClient(app, client=("100.64.0.9", 41234)).post("/incoming_task", json=_payload_from("anything-goes"))
    assert r.status_code == 201
    assert "anything-goes" in _md(inbox_dir)[0].read_text(encoding="utf-8")


def test_system_mode_still_rejects_loopback(settings) -> None:  # noqa: ANN001
    """Phase-1 path is unchanged: without an embedded backend 127.0.0.1 is not a tailnet address."""
    from fastapi.testclient import TestClient

    from airbridge_app import inbox

    app = inbox.create_app(settings, peers_provider=lambda: {})
    r = TestClient(app, client=("127.0.0.1", 41234)).post("/incoming_task", json=_payload())
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# Sidecar control-API client
# --------------------------------------------------------------------------- #
def test_sidecar_client_sends_bearer_and_exact_host(tmp_path) -> None:  # noqa: ANN001
    sys.path.insert(0, str(Path(__file__).parent))
    from fake_sidecar import TOKEN, FakeSidecar

    from airbridge_app import netbackend

    with FakeSidecar() as sc:
        be = netbackend.SidecarBackend(sc.url, TOKEN)
        be.status()
        be.peer_details()
        assert be.requests_proxies() is None
        for req in sc.requests:
            assert req["headers"]["Authorization"] == "Bearer " + TOKEN
            assert req["headers"]["Host"] == f"127.0.0.1:{sc.port}"
            assert "Origin" not in req["headers"]


def test_sidecar_client_refuses_non_loopback_endpoints() -> None:
    from airbridge_app import netbackend

    for bad in ["http://0.0.0.0:1080", "http://localhost:1080", "http://10.0.0.1:1080", "http://127.0.0.1:0",
                "http://100.64.0.2:8989", "https://127.0.0.1:1"]:
        assert netbackend.parse_sidecar_url(bad) is None, bad


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


def test_outbox_sidecar_sends_hostname_never_ip() -> None:
    """§9: /send takes target_hostname only; the outbox must not resolve or send an IP in sidecar mode."""
    tree = _outbox_tree()
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "_send_via_sidecar")
    src = ast.get_source_segment((APP / "outbox.py").read_text(encoding="utf-8"), fn) or ""
    assert "backend.send" in src
    assert "resolve_peer" not in src and ".resolve(" not in src and "target_ip" not in src and "http://" not in src
    assert "socks" not in (APP / "outbox.py").read_text(encoding="utf-8").lower()


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


def test_ts_auth_key_never_in_argv_env_or_files(network_ts: dict[str, str]) -> None:
    """§9: the pre-auth key reaches airbridge-net only on stdin (one JSON line, then stdin closes)."""
    problems = []
    for name, src in network_ts.items():
        if re.search(r"--auth-?key", src, flags=re.I):
            problems.append(f"{name}: --auth-key on a command line")
        if re.search(r"TS_AUTH_?KEY", src):
            problems.append(f"{name}: auth key passed through the environment (TS_AUTHKEY)")
        if re.search(r"""['"`](?:tskey|hskey)-""", src):
            problems.append(f"{name}: literal key prefix in source")
        if re.search(r"writeFile[^;]*auth_?key", src, flags=re.I):
            problems.append(f"{name}: auth key written to a file")
    assert problems == []


def _net_manager(network_ts: dict[str, str]) -> str:
    mgr = network_ts.get("NetManager.ts")
    if mgr is None:
        pytest.skip("PENDING (Systems): NetManager.ts not present yet")
    return mgr


def test_ts_sidecar_spawn_contract(network_ts: dict[str, str]) -> None:
    mgr = _net_manager(network_ts)
    assert "TailscaleManager.ts" not in network_ts, "bundled tailscaled manager must be gone (§9)"
    assert not re.search(r"tailscaled(?!\.state)", mgr), "no tailscaled anywhere (tsnet's own state file name is fine)"
    # fixed, empty argv; secrets on stdin which is then closed
    assert re.search(r"spawnFn\(\s*this\.binPath\s*,\s*\[\]\s*,", mgr), "sidecar argv must be fixed and empty"
    assert re.search(r"stdin\??\.end\(", mgr), "stdin must be closed after the config line"
    assert "windowsHide: true" in mgr and "shell: false" in mgr
    assert "AIRBRIDGE_NET_READY" in mgr


def test_ts_spawn_env_is_scrubbed(network_ts: dict[str, str]) -> None:
    mgr = _net_manager(network_ts)
    assert not re.search(r"env\s*:\s*process\.env\b", mgr), "do not pass the full parent env to the sidecar"
    assert not re.search(r"\.\.\.\s*process\.env\b", mgr), "do not spread process.env into the sidecar env"


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
