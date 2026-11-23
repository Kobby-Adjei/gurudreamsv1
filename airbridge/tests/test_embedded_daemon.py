"""Phase 3: inbox + daemon in embedded (userspace tailscaled) mode.

Inbound auth: client must be loopback -> LocalAPI whois of its host:port must
resolve -> whois user == own user -> (secret) -> validation -> 201.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import socket
import time

import pytest
from fastapi.testclient import TestClient

from airbridge_app import config, control, daemon, inbox, netbackend

pytestmark = pytest.mark.skipif(not hasattr(socket, "AF_UNIX"), reason="needs AF_UNIX")

from fake_localapi import OTHER_UID, SELF_UID, FakeLocalAPI, make_whois  # noqa: E402

URL = "/incoming_task"
PAYLOAD = {"sender_node": "desktop", "task_description": "Please review this.", "code_payload": None}


@pytest.fixture
def api():
    with FakeLocalAPI() as fake:
        yield fake


@pytest.fixture
def backend(api):
    return netbackend.EmbeddedTailscale(api.path, "127.0.0.1:41080")


@pytest.fixture(autouse=True)
def _reset_override():
    netbackend.set_backend_override(None)
    yield
    netbackend.set_backend_override(None)


def _client(settings, backend, client=("127.0.0.1", 50123)) -> TestClient:
    return TestClient(inbox.create_app(settings, backend=backend), client=client)


# --------------------------------------------------------------------------- #
# Inbox (TestClient)
# --------------------------------------------------------------------------- #
def test_loopback_with_unknown_whois_is_403(settings, backend, inbox_dir):
    with _client(settings, backend) as c:
        r = c.post(URL, json=PAYLOAD)
    assert r.status_code == 403
    assert "unknown_peer" in r.json()["detail"]
    assert not inbox_dir.exists() or not list(inbox_dir.glob("*.md"))


def test_different_user_is_403(settings, backend, api, inbox_dir):
    api.whois["127.0.0.1:50123"] = make_whois("airbridge-stranger", OTHER_UID, "100.64.0.9")
    with _client(settings, backend) as c:
        r = c.post(URL, json=PAYLOAD)
    assert r.status_code == 403
    assert "foreign_user" in r.json()["detail"]


def test_same_user_is_201_and_records_tailnet_ip(settings, backend, api, inbox_dir, notifications):
    api.whois["127.0.0.1:50123"] = make_whois("airbridge-desktop", SELF_UID, "100.64.0.2")
    with _client(settings, backend) as c:
        r = c.post(URL, json=PAYLOAD)
    assert r.status_code == 201, r.text
    files = list(inbox_dir.glob("*.md"))
    assert len(files) == 1
    text = files[0].read_text(encoding="utf-8")
    assert "100.64.0.2" in text and "127.0.0.1" not in text
    whois_reqs = [q for q in api.requests if q["path"] == "/localapi/v0/whois"]
    assert whois_reqs and whois_reqs[-1]["query"]["addr"] == ["127.0.0.1:50123"]
    assert whois_reqs[-1]["query"]["proto"] == ["tcp"]


def test_non_loopback_client_is_403_even_if_tailnet(settings, backend, api):
    api.whois["100.64.0.2:50123"] = make_whois("airbridge-desktop", SELF_UID, "100.64.0.2")
    with _client(settings, backend, client=("100.64.0.2", 50123)) as c:
        r = c.post(URL, json=PAYLOAD)
    assert r.status_code == 403
    assert "not_loopback" in r.json()["detail"]


def test_identity_checked_before_size_and_secret(settings, backend):
    s = dataclasses.replace(settings, shared_secret="s3cret")
    with _client(s, backend) as c:
        r = c.post(URL, content=b"x" * 700_000, headers={"content-type": "application/json"})
    assert r.status_code == 403  # not 413/401: step 1 runs first


def test_same_user_then_secret_still_enforced(settings, backend, api):
    api.whois["127.0.0.1:50123"] = make_whois("airbridge-desktop", SELF_UID, "100.64.0.2")
    s = dataclasses.replace(settings, shared_secret="s3cret")
    with _client(s, backend) as c:
        assert c.post(URL, json=PAYLOAD).status_code == 401
        assert c.post(URL, json=PAYLOAD, headers={config.SECRET_HEADER: "s3cret"}).status_code == 201


def test_own_identity_unavailable_is_403(settings, api):
    be = netbackend.EmbeddedTailscale(api.path, "127.0.0.1:41080")
    api.whois["127.0.0.1:50123"] = make_whois("airbridge-desktop", SELF_UID, "100.64.0.2")
    api.close()  # LocalAPI gone
    with _client(settings, be) as c:
        r = c.post(URL, json=PAYLOAD)
    assert r.status_code == 403


def test_health_requires_verified_peer(settings, backend, api):
    with _client(settings, backend) as c:
        assert c.get("/health").status_code == 403
    api.whois["127.0.0.1:50123"] = make_whois("airbridge-desktop", SELF_UID, "100.64.0.2")
    with _client(settings, backend) as c:
        assert c.get("/health").status_code == 200


def test_rate_limit_keyed_on_sender_node_not_loopback(settings, backend, api):
    s = dataclasses.replace(settings, rate_limit_per_minute=2)
    api.whois["127.0.0.1:50123"] = make_whois("airbridge-desktop", SELF_UID, "100.64.0.2")
    api.whois["127.0.0.1:50124"] = make_whois("airbridge-laptop", SELF_UID, "100.64.0.3")
    app = inbox.create_app(s, backend=backend)
    with TestClient(app, client=("127.0.0.1", 50123)) as a, TestClient(app, client=("127.0.0.1", 50124)) as b:
        assert [a.post(URL, json=PAYLOAD).status_code for _ in range(3)] == [201, 201, 429]
        assert b.post(URL, json=PAYLOAD).status_code == 201  # other node has its own bucket


# --------------------------------------------------------------------------- #
# Daemon supervisor + real uvicorn on loopback
# --------------------------------------------------------------------------- #
def test_supervisor_binds_loopback_in_embedded_mode(settings, backend):
    netbackend.set_backend_override(backend)
    state = control.DaemonState()
    sup = daemon._InboxSupervisor(settings, state, asyncio.Event())
    assert asyncio.run(sup._resolve_host()) == "127.0.0.1"
    assert state.tailnet_ip == "100.64.0.1"


def test_supervisor_refuses_non_loopback_embedded_bind(settings, backend, monkeypatch):
    monkeypatch.setattr(backend, "inbound_bind_host", lambda: "0.0.0.0")
    netbackend.set_backend_override(backend)
    state = control.DaemonState()
    sup = daemon._InboxSupervisor(settings, state, asyncio.Event())
    assert asyncio.run(sup._resolve_host()) is None
    assert "refusing" in state.degraded_reason


def test_supervisor_degraded_when_network_off(settings, monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "embedded")
    state = control.DaemonState()
    sup = daemon._InboxSupervisor(settings, state, asyncio.Event())
    assert asyncio.run(sup._resolve_host()) is None
    assert state.degraded_reason.startswith("AirBridge network is off")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _raw_post(port: int, src_port: int, body: bytes) -> int:
    """POST from a fixed loopback source port (what tailscaled's netstack dial looks like)."""
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", src_port))
        s.settimeout(5)
        s.connect(("127.0.0.1", port))
        s.sendall(
            b"POST /incoming_task HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
            + body
        )
        data = b""
        while chunk := s.recv(65536):
            data += chunk
    return int(data.split(b" ", 2)[1])


def test_daemon_end_to_end_embedded_whois_over_real_socket(settings, api, backend, inbox_dir, monkeypatch):
    port = _free_port()
    s = dataclasses.replace(settings, port=port)
    monkeypatch.setenv(config.ENV_NETWORK, "embedded")
    monkeypatch.setenv(config.ENV_TS_SOCKET, api.path)
    monkeypatch.setenv(config.ENV_TS_SOCKS5, "127.0.0.1:41080")
    good_src, bad_src = _free_port(), _free_port()
    api.whois[f"127.0.0.1:{good_src}"] = make_whois("airbridge-desktop", SELF_UID, "100.64.0.2")
    body = json.dumps(PAYLOAD).encode()

    async def scenario():
        stop = asyncio.Event()
        state = control.DaemonState(inbox_port=port)
        sup = daemon._InboxSupervisor(s, state, stop)
        task = asyncio.create_task(sup.run())
        try:
            deadline = time.monotonic() + 10
            while not state.inbox_listening:
                assert time.monotonic() < deadline, state.degraded_reason
                await asyncio.sleep(0.05)
            ok = await asyncio.to_thread(_raw_post, port, good_src, body)
            direct = await asyncio.to_thread(_raw_post, port, bad_src, body)
            return ok, direct, state.tailnet_ip
        finally:
            stop.set()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(task, 10)

    ok, direct, ip = asyncio.run(scenario())
    assert ok == 201
    assert direct == 403  # a local process hitting 127.0.0.1:port directly
    assert ip == "100.64.0.1"
    assert len(list(inbox_dir.glob("*.md"))) == 1
