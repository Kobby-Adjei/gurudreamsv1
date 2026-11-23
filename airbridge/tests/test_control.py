"""Tests for the daemon control API (airbridge_app.control) against a real
uvicorn server on an ephemeral 127.0.0.1 port. Tailscale and outbound HTTP are
mocked."""

from __future__ import annotations

import asyncio
import json
import secrets
import socket
import threading
import time

import httpx
import pytest
import requests
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect as ws_connect

from airbridge_app import config, control, events, network

TOKEN = secrets.token_urlsafe(32)


class _ServerThread:
    def __init__(self, app, sock):
        self.server = control.build_control_server(app)
        self.server.capture_signals = __import__("contextlib").nullcontext
        self.sock = sock
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        asyncio.run(self.server.serve(sockets=[self.sock]))

    def start(self):
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started:
            assert time.time() < deadline, "control server did not start"
            time.sleep(0.01)

    def stop(self):
        self.server.should_exit = True
        self.thread.join(timeout=10)
        self.sock.close()


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "data"
    monkeypatch.setenv("AIRBRIDGE_DATA_DIR", str(d))
    events.configure(None)
    events.set_origin("daemon")
    yield d
    events.set_origin("mcp")


@pytest.fixture
def api(settings, data_dir, fake_peers):
    sock = control.bind_control_socket(0)
    port = sock.getsockname()[1]
    state = control.DaemonState(tailnet_ip="100.101.102.103", inbox_listening=True)
    nodes = {
        "self": {"hostname": "me", "ip": "100.101.102.103", "os": "linux"},
        "nodes": [{"hostname": "desktop", "ip": "100.64.0.5", "os": "windows", "online": True, "last_seen": None}],
        "error": None,
    }
    app = control.create_control_app(
        token=TOKEN, port_getter=lambda: port, state=state, settings=settings, nodes_provider=lambda: nodes
    )
    srv = _ServerThread(app, sock)
    srv.start()
    base = f"http://127.0.0.1:{port}"
    client = httpx.Client(base_url=base, headers={"Authorization": f"Bearer {TOKEN}"}, timeout=10, trust_env=False)
    yield {"port": port, "base": base, "client": client, "state": state}
    client.close()
    srv.stop()


# ------------------------------------------------------------------ guard
def test_binds_loopback_only():
    sock = control.bind_control_socket(0)
    try:
        assert sock.getsockname()[0] == "127.0.0.1"
    finally:
        sock.close()
    assert control.CONTROL_HOST == "127.0.0.1"


def test_no_token_401(api):
    r = httpx.get(api["base"] + "/status", trust_env=False)
    assert r.status_code == 401
    assert r.json()["ok"] is False


def test_wrong_token_401(api):
    r = httpx.get(api["base"] + "/status", headers={"Authorization": "Bearer " + "x" * 43}, trust_env=False)
    assert r.status_code == 401
    r = httpx.get(api["base"] + "/status", headers={"Authorization": TOKEN}, trust_env=False)
    assert r.status_code == 401


@pytest.mark.parametrize("host", ["localhost:{port}", "127.0.0.1", "evil.example:{port}", "127.0.0.1:1"])
def test_bad_host_403(api, host):
    r = api["client"].get("/status", headers={"Host": host.format(port=api["port"])})
    assert r.status_code == 403


def test_origin_rejected_403(api):
    for origin in ("http://evil.example", "null", f"http://127.0.0.1:{api['port']}"):
        r = api["client"].get("/status", headers={"Origin": origin})
        assert r.status_code == 403


def test_create_app_rejects_short_token(settings):
    with pytest.raises(ValueError):
        control.create_control_app(token="short", port_getter=lambda: 1, state=control.DaemonState(), settings=settings)


# ------------------------------------------------------------------ endpoints
def test_status_shape(api):
    r = api["client"].get("/status")
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "daemon"
    assert body["tailnet_ip"] == "100.101.102.103"
    assert body["inbox"] == {"listening": True, "port": 8989, "degraded_reason": None}
    assert isinstance(body["uptime_s"], (int, float))
    assert isinstance(body["version"], str)


def test_nodes(api):
    body = api["client"].get("/nodes").json()
    assert body["self"]["hostname"] == "me"
    assert body["nodes"][0] == {"hostname": "desktop", "ip": "100.64.0.5", "os": "windows", "online": True, "last_seen": None}
    assert body["error"] is None


def test_events_endpoint(api):
    for i in range(5):
        events.emit("node_online", peer=f"n{i}")
    body = api["client"].get("/events", params={"limit": 3}).json()
    assert [e["peer"] for e in body["events"]] == ["n2", "n3", "n4"]
    after = body["events"][0]["id"]
    body = api["client"].get("/events", params={"after_id": after}).json()
    assert [e["peer"] for e in body["events"]] == ["n3", "n4"]


def test_ws_stream_delivers_event_under_1s(api):
    url = f"ws://127.0.0.1:{api['port']}/events/stream"
    with ws_connect(url, additional_headers={"Authorization": f"Bearer {TOKEN}"}, open_timeout=5) as ws:
        time.sleep(0.3)  # let the tail start
        t0 = time.monotonic()
        events.emit("task_received", peer="MacBook", summary="Received task from MacBook")
        msg = json.loads(ws.recv(timeout=2))
        assert time.monotonic() - t0 < 1.0
    assert msg["type"] == "task_received"
    assert msg["summary"] == "Received task from MacBook"


def test_ws_bad_auth_closes_4401(api):
    url = f"ws://127.0.0.1:{api['port']}/events/stream"
    with ws_connect(url, additional_headers={"Authorization": "Bearer nope"}, open_timeout=5) as ws:
        with pytest.raises(ConnectionClosed) as info:
            ws.recv(timeout=2)
    assert info.value.rcvd.code == 4401


def test_ws_origin_rejected(api):
    url = f"ws://127.0.0.1:{api['port']}/events/stream"
    with ws_connect(url, origin="http://evil.example",
                    additional_headers={"Authorization": f"Bearer {TOKEN}"}, open_timeout=5) as ws:
        with pytest.raises(ConnectionClosed) as info:
            ws.recv(timeout=2)
    assert info.value.rcvd.code == 4403


# ------------------------------------------------------------------ send_task
class _Resp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        return self._payload


def test_send_task_success_emits_daemon_event(api, monkeypatch):
    sent = []

    def fake_post(self, url, json=None, headers=None, timeout=None, allow_redirects=True):
        sent.append((url, json))
        return _Resp(201, {"status": "ok", "file": "task_x.md"})

    monkeypatch.setattr(requests.Session, "post", fake_post)
    r = api["client"].post("/send_task", json={"target_hostname": "desktop", "task_description": "do it",
                                               "code_payload": "print(1)"})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "file": "task_x.md", "target": "desktop"}
    assert sent[0][0] == "http://100.64.0.5:8989/incoming_task"
    evs = events.read_recent()
    assert evs[-1]["type"] == "task_sent"
    assert evs[-1]["origin"] == "daemon"
    assert evs[-1]["summary"] == "Sent code to desktop"
    assert "print(1)" not in json.dumps(evs) and "do it" not in json.dumps(evs)


def test_send_task_unknown_node_404(api):
    r = api["client"].post("/send_task", json={"target_hostname": "nosuch", "task_description": "x"})
    assert r.status_code == 404
    assert r.json()["ok"] is False
    assert events.read_recent()[-1]["type"] == "send_failed"


def test_send_task_validation_400(api):
    r = api["client"].post("/send_task", json={"target_hostname": "bad host!", "task_description": "x"})
    assert r.status_code == 400
    r = api["client"].post("/send_task", json={"task_description": "x"})
    assert r.status_code == 400
    r = api["client"].post("/send_task", content=b"not json", headers={"content-type": "application/json"})
    assert r.status_code == 400


def test_send_task_too_large_413(api):
    r = api["client"].post("/send_task", json={"target_hostname": "desktop", "task_description": "x" * 700_000})
    assert r.status_code == 413


def test_send_task_remote_down_502(api, monkeypatch):
    def fake_post(self, *a, **k):
        raise requests.exceptions.ConnectionError("refused")

    monkeypatch.setattr(requests.Session, "post", fake_post)
    r = api["client"].post("/send_task", json={"target_hostname": "desktop", "task_description": "x"})
    assert r.status_code == 502
    assert "could not connect" in r.json()["error"]


# ------------------------------------------------------------------ nodes_snapshot
def test_nodes_snapshot_parses_status(monkeypatch):
    status = {
        "BackendState": "Running",
        "Self": {"HostName": "me", "OS": "linux", "TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1"]},
        "Peer": {
            "a": {"HostName": "Desktop-PC", "OS": "windows", "Online": True, "TailscaleIPs": ["100.64.0.5"],
                  "LastSeen": "0001-01-01T00:00:00Z"},
            "b": {"HostName": "MacBook", "OS": "macOS", "Online": False, "TailscaleIPs": ["100.64.0.6"],
                  "LastSeen": "2026-11-20T10:00:00Z"},
            "c": {"HostName": "bogus", "Online": True, "TailscaleIPs": ["8.8.8.8"]},
        },
    }
    monkeypatch.setattr(network, "_status_json", lambda: status)
    snap = control.nodes_snapshot()
    assert snap["error"] is None
    assert snap["self"] == {"hostname": "me", "ip": "100.101.102.103", "os": "linux"}
    assert snap["nodes"] == [
        {"hostname": "Desktop-PC", "ip": "100.64.0.5", "os": "windows", "online": True, "last_seen": None},
        {"hostname": "MacBook", "ip": "100.64.0.6", "os": "macOS", "online": False, "last_seen": "2026-11-20T10:00:00Z"},
    ]


def test_nodes_snapshot_tailscale_error(monkeypatch):
    def boom():
        raise network.TailscaleNotRunning("Tailscale is not running.")

    monkeypatch.setattr(network, "_status_json", boom)
    snap = control.nodes_snapshot()
    assert snap["nodes"] == [] and snap["error"] == "Tailscale is not running."
    assert snap["self"]["ip"] is None and snap["self"]["hostname"]


def test_status_reflects_degraded():
    st = control.DaemonState(inbox_listening=False, degraded_reason="Tailscale is not running.")
    s = st.status()
    assert s["inbox"]["listening"] is False
    assert s["inbox"]["degraded_reason"] == "Tailscale is not running."
    assert s["tailnet_ip"] is None
