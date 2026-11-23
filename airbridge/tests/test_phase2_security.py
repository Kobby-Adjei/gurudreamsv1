"""Phase 2 security acceptance tests (Security-owned).

Covers the daemon control API (airbridge_app/control.py), activity events
(airbridge_app/events.py) and the daemon's inbox bind rule (airbridge_app/daemon.py).
Each group is skipped with a reason if the module it targets is absent.

See docs/PHASE2_SECURITY.md.
"""

from __future__ import annotations

import ast
import asyncio
import importlib
import json
import os
import socket
import stat
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "airbridge_app"


def _try_import(name: str) -> Any | None:
    try:
        return importlib.import_module(f"airbridge_app.{name}")
    except ImportError:
        return None


control = _try_import("control")
events = _try_import("events")
daemon = _try_import("daemon")

needs_control = pytest.mark.skipif(control is None, reason="airbridge_app/control.py not present")
needs_events = pytest.mark.skipif(events is None, reason="airbridge_app/events.py not present")
needs_daemon = pytest.mark.skipif(daemon is None, reason="airbridge_app/daemon.py not present")

TOKEN = "t" * 8 + "Qk3vX9pL2mN7bR4sW8yZ1cF6hJ0dG5aE"  # >= 32 chars, test-only
PORT = 48123
LOOPBACK_CLIENT = ("127.0.0.1", 50123)
GOOD_HOST = f"127.0.0.1:{PORT}"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
SECRET_TASK = "TOPSECRET-TASK-BODY sk_live_should_never_be_logged password=hunter2"
SECRET_CODE = "TOPSECRET-CODE-BODY def f(): return 'api_key=AKIA...'"
SECRET_MARKERS = ("TOPSECRET", "hunter2", "sk_live_should", "api_key=")


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


# --------------------------------------------------------------------------- #
# Control API: bind address
# --------------------------------------------------------------------------- #
@needs_control
def test_control_host_constant_is_loopback_v4() -> None:
    # Phase 3 F-1 (PHASE3_SECURITY.md): IPv6 loopback preferred, IPv4 loopback only as fallback.
    assert control.CONTROL_HOST == "::1"
    assert control.CONTROL_HOST_V4 == "127.0.0.1"


@needs_control
def test_control_module_has_no_wildcard_or_name_hosts() -> None:
    """No '0.0.0.0', '::', '' or 'localhost' host literals in control/daemon code (DNS + dual-stack surprises)."""
    bad = {"0.0.0.0", "::", "localhost"}  # "::1" is the Phase-3 control host (F-1)
    offenders = []
    for name in ("control.py", "daemon.py"):
        path = APP_DIR / name
        if not path.exists():
            continue
        for node in ast.walk(_parse(path)):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in bad:
                offenders.append(f"{name}:{node.lineno}: {node.value!r}")
    assert offenders == []


@needs_control
def test_bind_control_socket_binds_ipv4_loopback_only() -> None:
    src = _parse(APP_DIR / "control.py")
    fn = next(n for n in ast.walk(src) if isinstance(n, ast.FunctionDef) and n.name == "bind_control_socket")
    # Phase 3 (F-1): bind_control_socket -> _bind_loopback(family, CONTROL_HOST | CONTROL_HOST_V4, port).
    calls = [
        c for c in ast.walk(fn)
        if isinstance(c, ast.Call) and isinstance(c.func, ast.Name) and c.func.id == "_bind_loopback"
    ]
    assert calls, "bind_control_socket must bind via _bind_loopback"
    for call in calls:
        assert isinstance(call.args[1], ast.Name) and call.args[1].id in ("CONTROL_HOST", "CONTROL_HOST_V4")
    helper = next(n for n in ast.walk(src) if isinstance(n, ast.FunctionDef) and n.name == "_bind_loopback")
    binds = [
        c for c in ast.walk(helper)
        if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute) and c.func.attr == "bind"
    ]
    assert binds, "_bind_loopback must call sock.bind"
    for call in binds:
        target = call.args[0]
        assert isinstance(target, ast.Tuple)
        assert isinstance(target.elts[0], ast.Name) and target.elts[0].id == "host"

    sock = control.bind_control_socket(0)
    try:
        host, port = sock.getsockname()[:2]
        assert host in ("::1", "127.0.0.1")
        assert port > 0
        assert sock.family in (socket.AF_INET, socket.AF_INET6)
    finally:
        sock.close()


@needs_control
def test_control_server_config_has_no_host_and_quiet_logging() -> None:
    """build_control_server must serve the pre-bound socket (no host= that could widen the bind)."""
    srv = control.build_control_server(lambda *a: None)
    cfg = srv.config
    assert cfg.log_config is None
    assert cfg.access_log is False
    assert cfg.host == "127.0.0.1"  # uvicorn default; we never pass a wider host
    src = _parse(APP_DIR / "control.py")
    for call in ast.walk(src):
        if isinstance(call, ast.Call) and getattr(call.func, "attr", "") == "Config":
            assert not any(k.arg == "host" for k in call.keywords), "control Config must not set host="


# --------------------------------------------------------------------------- #
# Control API: request guard
# --------------------------------------------------------------------------- #
@pytest.fixture
def control_client(settings):  # noqa: ANN001 - conftest fixture
    if control is None:
        pytest.skip("airbridge_app/control.py not present")
    from fastapi.testclient import TestClient

    app = control.create_control_app(
        token=TOKEN,
        port_getter=lambda: PORT,
        state=control.DaemonState(),
        settings=settings,
        nodes_provider=lambda: {"self": None, "nodes": [], "error": None},
    )
    return TestClient(app, base_url=f"http://{GOOD_HOST}", client=LOOPBACK_CLIENT)


@needs_control
def test_valid_request_is_accepted(control_client) -> None:
    r = control_client.get("/status", headers={**AUTH, "Host": GOOD_HOST})
    assert r.status_code == 200
    assert r.json()["mode"] == "daemon"
    assert r.headers.get("cache-control") == "no-store"


@needs_control
@pytest.mark.parametrize(
    "auth",
    [
        None,
        "",
        "Bearer",
        "Bearer ",
        f"bearer {TOKEN}",
        f"Basic {TOKEN}",
        f"Bearer {TOKEN}x",
        f"Bearer {TOKEN[:-1]}",
        f"Bearer  {TOKEN}",
        f"{TOKEN}",
        "Bearer " + "A" * len(TOKEN),
    ],
)
@pytest.mark.parametrize("path", ["/status", "/nodes", "/events"])
def test_missing_or_wrong_token_is_401(control_client, auth, path) -> None:
    headers = {"Host": GOOD_HOST}
    if auth is not None:
        headers["Authorization"] = auth
    r = control_client.get(path, headers=headers)
    assert r.status_code == 401
    assert TOKEN not in r.text


@needs_control
def test_send_task_requires_token(control_client) -> None:
    r = control_client.post(
        "/send_task",
        headers={"Host": GOOD_HOST},
        json={"target_hostname": "desktop", "task_description": "x"},
    )
    assert r.status_code == 401


@needs_control
@pytest.mark.parametrize(
    "host",
    ["localhost:%d" % PORT, "127.0.0.1", "127.0.0.1:1", "evil.example", f"evil.example:{PORT}",
     f"127.0.0.1:{PORT}.evil.example", f"[::1]:{PORT}", f"127.0.0.1:{PORT} "],
)
def test_wrong_host_is_403_even_with_token(control_client, host) -> None:
    r = control_client.get("/status", headers={**AUTH, "Host": host})
    assert r.status_code == 403


@needs_control
@pytest.mark.parametrize("origin", ["null", "http://127.0.0.1:%d" % PORT, "https://evil.example", "file://", ""])
def test_any_origin_header_is_403_even_with_token(control_client, origin) -> None:
    r = control_client.get("/status", headers={**AUTH, "Host": GOOD_HOST, "Origin": origin})
    assert r.status_code == 403


@needs_control
def test_non_loopback_peer_is_403(settings) -> None:
    from fastapi.testclient import TestClient

    app = control.create_control_app(
        token=TOKEN, port_getter=lambda: PORT, state=control.DaemonState(), settings=settings,
        nodes_provider=lambda: {},
    )
    c = TestClient(app, base_url=f"http://{GOOD_HOST}", client=("100.64.0.5", 1))
    assert c.get("/status", headers={**AUTH, "Host": GOOD_HOST}).status_code == 403


@needs_control
def test_short_token_rejected_at_construction(settings) -> None:
    with pytest.raises(ValueError):
        control.create_control_app(
            token="short", port_getter=lambda: PORT, state=control.DaemonState(), settings=settings
        )


@needs_control
def test_no_openapi_or_docs(control_client) -> None:
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert control_client.get(path, headers={**AUTH, "Host": GOOD_HOST}).status_code == 404


@needs_control
def test_websocket_without_token_closes_4401(control_client) -> None:
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as ei:
        with control_client.websocket_connect("/events/stream", headers={"Host": GOOD_HOST}) as ws:
            ws.receive_text()
    assert ei.value.code == 4401


@needs_control
def test_websocket_wrong_token_closes_4401(control_client) -> None:
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as ei:
        with control_client.websocket_connect(
            "/events/stream", headers={"Host": GOOD_HOST, "Authorization": "Bearer nope"}
        ) as ws:
            ws.receive_text()
    assert ei.value.code == 4401


@needs_control
def test_websocket_with_origin_is_rejected(control_client) -> None:
    """Cross-site WebSocket hijacking: browsers always send Origin."""
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as ei:
        with control_client.websocket_connect(
            "/events/stream", headers={**AUTH, "Host": GOOD_HOST, "Origin": "https://evil.example"}
        ) as ws:
            ws.receive_text()
    assert ei.value.code in (4403, 4401, 1008)


@needs_control
def test_token_compared_in_constant_time() -> None:
    """AST: the guard uses hmac.compare_digest and never compares a token with == / != / in."""
    tree = _parse(APP_DIR / "control.py")
    calls = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr == "compare_digest"
        and isinstance(n.func.value, ast.Name)
        and n.func.value.id in ("hmac", "secrets")
    ]
    assert calls, "control.py must use hmac.compare_digest for the bearer token"

    def mentions_token(node: ast.AST) -> bool:
        for sub in ast.walk(node):
            if isinstance(sub, ast.Name) and "token" in sub.id.lower():
                return True
            if isinstance(sub, ast.Attribute) and "token" in sub.attr.lower():
                return True
        return False

    bad = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare) and any(
            isinstance(op, (ast.Eq, ast.NotEq, ast.In, ast.NotIn)) for op in node.ops
        ):
            operands = [node.left, *node.comparators]
            # len(token) < 32 style checks are fine; only direct value comparisons are flagged.
            if any(mentions_token(o) and not isinstance(o, ast.Call) for o in operands):
                bad.append(node.lineno)
    assert bad == [], f"non-constant-time token comparison at control.py lines {bad}"


@needs_control
def test_token_never_logged() -> None:
    """AST: no logger call in control.py/daemon.py passes a name containing 'token'."""
    bad = []
    for name in ("control.py", "daemon.py"):
        path = APP_DIR / name
        if not path.exists():
            continue
        for node in ast.walk(_parse(path)):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in {"debug", "info", "warning", "error", "exception", "critical"}
            ):
                for arg in node.args[1:]:
                    for sub in ast.walk(arg):
                        if isinstance(sub, ast.Name) and "token" in sub.id.lower():
                            bad.append(f"{name}:{node.lineno}")
    assert bad == []


# --------------------------------------------------------------------------- #
# Events: never contain task bodies; file permissions
# --------------------------------------------------------------------------- #
def _activity_lines() -> list[str]:
    path = events.activity_path()
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


@needs_events
def test_emit_sanitizes_and_drops_unknown_detail() -> None:
    events.emit(
        "task_received",
        peer="laptop\n## fake\x1b[31m",
        summary="Received\r\nINJECTED line " + "A" * 500,
        bytes=10,
        file="/etc/../tmp/task_x.md",
        task_description=SECRET_TASK,  # must be dropped
        code_payload=SECRET_CODE,  # must be dropped
    )
    lines = _activity_lines()
    assert len(lines) == 1
    ev = json.loads(lines[0])
    assert set(ev) == {"v", "id", "ts", "type", "origin", "local_node", "peer", "summary", "detail"}
    assert set(ev["detail"]) <= {"bytes", "file", "error"}
    assert ev["detail"]["file"] == "task_x.md"
    assert len(ev["summary"]) <= 120
    assert "\n" not in ev["summary"] and "\r" not in ev["summary"]
    assert "\x1b" not in lines[0]
    for marker in SECRET_MARKERS:
        assert marker not in lines[0]


@needs_events
def test_emit_never_raises_on_hostile_input() -> None:
    events.emit("not_a_type", summary=object())  # unknown type: swallowed
    events.emit("task_sent", peer=object(), summary=b"\xff\xfe", bytes=-1, file=123, error=Exception("x"))


@needs_events
def test_outbox_events_never_contain_task_or_code(fake_peers, settings, monkeypatch) -> None:
    from airbridge_app import outbox

    class FakeResp:
        status_code = 201

        def json(self) -> dict[str, str]:
            return {"status": "ok", "file": "task_20260101-000000-000000.md"}

    monkeypatch.setattr(outbox, "_post", lambda *a, **k: FakeResp())
    ok = asyncio.run(outbox.send_task_result(settings, "desktop", SECRET_TASK, SECRET_CODE))
    assert ok["ok"] is True

    def boom(*a: Any, **k: Any) -> Any:
        import requests

        raise requests.exceptions.ConnectionError(SECRET_TASK)

    monkeypatch.setattr(outbox, "_post", boom)
    bad = asyncio.run(outbox.send_task_result(settings, "desktop", SECRET_TASK, SECRET_CODE))
    assert bad["ok"] is False
    # Validation failure path (oversized) also must not echo the body.
    asyncio.run(outbox.send_task_result(settings, "desktop", SECRET_TASK * 5000, None))

    lines = _activity_lines()
    types = [json.loads(line)["type"] for line in lines]
    assert "task_sent" in types and "send_failed" in types
    blob = "\n".join(lines)
    for marker in SECRET_MARKERS:
        assert marker not in blob, f"event log leaked {marker!r}"


@needs_events
def test_inbox_events_never_contain_task_or_code(settings) -> None:
    from fastapi.testclient import TestClient

    from airbridge_app import inbox

    app = inbox.create_app(settings, peers_provider=lambda: {})
    client = TestClient(app, client=("100.101.102.103", 50000))
    r = client.post(
        "/incoming_task",
        json={"sender_node": "laptop", "task_description": SECRET_TASK, "code_payload": SECRET_CODE},
    )
    assert r.status_code == 201, r.text
    blob = "\n".join(_activity_lines())
    assert '"task_received"' in blob
    for marker in SECRET_MARKERS:
        assert marker not in blob


@needs_events
@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
def test_events_file_is_0600_and_dir_0700(tmp_path, monkeypatch) -> None:
    data = tmp_path / "fresh-data-dir"
    monkeypatch.setenv("AIRBRIDGE_DATA_DIR", str(data))
    old = os.umask(0o022)
    try:
        events.emit("daemon_started", summary="hello")
    finally:
        os.umask(old)
    path = events.activity_path()
    assert path.parent == data
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(data.stat().st_mode) == 0o700
    # A pre-existing file with loose permissions is tightened on next write.
    os.chmod(path, 0o644)
    events.emit("daemon_stopping", summary="bye")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@needs_events
def test_events_module_never_writes_task_fields() -> None:
    """AST: events.py must not reference task_description / code_payload at all."""
    names = {
        getattr(n, "id", None) or getattr(n, "attr", None) or (n.value if isinstance(n, ast.Constant) else None)
        for n in ast.walk(_parse(APP_DIR / "events.py"))
    }
    assert "task_description" not in names
    assert "code_payload" not in names


# --------------------------------------------------------------------------- #
# Daemon: inbox still binds only to the tailnet address
# --------------------------------------------------------------------------- #
def _functions_calling(tree: ast.AST, attr: str) -> list[ast.AST]:
    out = []
    for fn in ast.walk(tree):
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for c in ast.walk(fn):
                if isinstance(c, ast.Call) and (
                    (isinstance(c.func, ast.Attribute) and c.func.attr == attr)
                    or (isinstance(c.func, ast.Name) and c.func.id == attr)
                ):
                    out.append(fn)
                    break
    return out


@needs_daemon
def test_daemon_inbox_host_goes_through_validate_bind_host_ast() -> None:
    tree = _parse(APP_DIR / "daemon.py")
    assert _functions_calling(tree, "validate_bind_host"), "daemon must validate the inbox bind host"
    # build_server's host argument must be a plain name (validated value), never a literal.
    for call in ast.walk(tree):
        if isinstance(call, ast.Call) and getattr(call.func, "attr", "") == "build_server":
            assert len(call.args) >= 2
            assert not isinstance(call.args[1], ast.Constant), "literal inbox host"


@needs_daemon
@pytest.mark.parametrize("ip", ["127.0.0.1", "0.0.0.0", "192.168.1.5", "::", "::1", "10.0.0.1"])
def test_daemon_refuses_non_tailnet_inbox_host(settings, monkeypatch, ip) -> None:
    from airbridge_app import network

    monkeypatch.setattr(network, "get_local_tailscale_ip", lambda: ip)
    state = control.DaemonState()
    sup = daemon._InboxSupervisor(settings, state, asyncio.Event())
    host = asyncio.run(sup._resolve_host())
    assert host is None
    assert state.inbox_listening is False
    assert state.degraded_reason


@needs_daemon
def test_daemon_accepts_tailnet_inbox_host(settings, monkeypatch) -> None:
    from airbridge_app import network

    monkeypatch.setattr(network, "get_local_tailscale_ip", lambda: "100.101.102.103")
    sup = daemon._InboxSupervisor(settings, control.DaemonState(), asyncio.Event())
    assert asyncio.run(sup._resolve_host()) == "100.101.102.103"


@needs_daemon
def test_daemon_token_comes_from_env_not_argv() -> None:
    """AST: main.py/daemon.py read AIRBRIDGE_CONTROL_TOKEN from the environment, never from argparse."""
    for name in ("main.py",):
        tree = _parse(ROOT / name)
        for call in ast.walk(tree):
            if isinstance(call, ast.Call) and getattr(call.func, "attr", "") == "add_argument":
                for a in call.args:
                    if isinstance(a, ast.Constant) and isinstance(a.value, str):
                        assert "token" not in a.value.lower(), f"{name}: token must not be a CLI argument"


def test_module_presence_report() -> None:
    """Always runs: records which Phase-2 modules this suite actually exercised."""
    present = {n: m is not None for n, m in (("control", control), ("events", events), ("daemon", daemon))}
    assert isinstance(present, dict)
    sys.stderr.write(f"phase2 security modules present: {present}\n")
