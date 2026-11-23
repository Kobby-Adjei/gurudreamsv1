"""Phase 3 §9: network backend selection + the airbridge-net sidecar control-API client."""

from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest
import requests

from airbridge_app import config, control, netbackend, network, outbox

sys.path.insert(0, os.path.dirname(__file__))
from fake_sidecar import TOKEN, FakeSidecar, write_network_json  # noqa: E402


@pytest.fixture
def sc():
    with FakeSidecar() as fake:
        yield fake


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in (config.ENV_NETWORK, config.ENV_NET_URL, config.ENV_NET_TOKEN):
        monkeypatch.delenv(name, raising=False)
    netbackend.set_backend_override(None)
    yield
    netbackend.set_backend_override(None)


def _no_system(monkeypatch):
    def missing():
        raise network.TailscaleNotInstalled("Tailscale CLI not found.")

    monkeypatch.setattr(network, "tailscale_binary", missing)


def _data_dir() -> str:
    return os.environ["AIRBRIDGE_DATA_DIR"]


# --------------------------------------------------------------------------- #
# Selection
# --------------------------------------------------------------------------- #
def test_no_network_json_selects_system():
    assert netbackend.select_backend().kind == "system"


def test_daemon_env_selects_sidecar(sc, monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "sidecar")
    monkeypatch.setenv(config.ENV_NET_URL, sc.url)
    monkeypatch.setenv(config.ENV_NET_TOKEN, TOKEN)
    be = netbackend.select_backend()
    assert be.kind == "sidecar" and be.port == sc.port
    assert TOKEN not in repr(be)


def test_sidecar_mode_without_endpoint_is_network_off(monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "sidecar")
    with pytest.raises(netbackend.NetworkOff, match="sign in to connect your devices"):
        netbackend.select_backend()


def test_sidecar_mode_never_falls_back_to_system(monkeypatch):
    """The app path has no system-Tailscale fallback (§9)."""
    monkeypatch.setattr(network, "tailscale_binary", lambda: "/usr/bin/tailscale")
    monkeypatch.setenv(config.ENV_NETWORK, "sidecar")
    with pytest.raises(netbackend.NetworkOff):
        netbackend.select_backend()


def test_live_network_json_selects_sidecar_for_mcp_process(sc):
    write_network_json(_data_dir(), sc.url)
    be = netbackend.select_backend()
    assert be.kind == "sidecar"


def test_dead_network_json_without_system_is_network_off(monkeypatch):
    _no_system(monkeypatch)
    write_network_json(_data_dir(), "http://127.0.0.1:9")
    with pytest.raises(netbackend.NetworkOff, match="AirBridge network is off"):
        netbackend.select_backend()


def test_stopped_network_json_without_system_is_network_off(monkeypatch):
    _no_system(monkeypatch)
    write_network_json(_data_dir(), "http://127.0.0.1:9", pid=None)
    with pytest.raises(netbackend.NetworkOff):
        netbackend.select_backend()


def test_dead_network_json_with_system_falls_back(monkeypatch):
    """Auto mode (free CLI on a machine that also has the app): system Tailscale is fine."""
    monkeypatch.setattr(network, "tailscale_binary", lambda: "/usr/bin/tailscale")
    write_network_json(_data_dir(), "http://127.0.0.1:9")
    assert netbackend.select_backend().kind == "system"


def test_env_override_system_ignores_network_json(sc, monkeypatch):
    write_network_json(_data_dir(), sc.url)
    monkeypatch.setenv(config.ENV_NETWORK, "system")
    assert netbackend.select_backend().kind == "system"


@pytest.mark.parametrize("url", [
    "http://10.0.0.5:4000", "https://127.0.0.1:4000", "http://localhost:4000", "http://[::2]:1",
    "http://127.0.0.1", "http://user:pw@127.0.0.1:1", "http://127.0.0.1:1/x", "http://127.0.0.1:1?a=b", 7,
])
def test_non_loopback_or_odd_sidecar_urls_rejected(url):
    assert netbackend.parse_sidecar_url(url) is None


def test_ipv6_loopback_url_accepted():
    assert netbackend.parse_sidecar_url("http://[::1]:41000") == ("::1", 41000)


def test_short_token_rejected(sc, monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "sidecar")
    monkeypatch.setenv(config.ENV_NET_URL, sc.url)
    monkeypatch.setenv(config.ENV_NET_TOKEN, "short")
    with pytest.raises(netbackend.NetworkOff):
        netbackend.select_backend()


def test_invalid_network_mode_means_auto(monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "embedded")  # removed mode
    assert config.network_mode() == "auto"


def test_read_network_json_rejects_v1_and_garbage(tmp_path):
    p = tmp_path / "network.json"
    for content in ("not json", "[]", json.dumps({"v": 1, "socket": "/x"}), json.dumps({"v": 2, "mode": "x"})):
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, content.encode())
        os.close(fd)
        assert config.read_network_json(tmp_path) is None
    write_network_json(tmp_path, "http://127.0.0.1:1")
    assert config.read_network_json(tmp_path)["mode"] == "sidecar"


# --------------------------------------------------------------------------- #
# Sidecar backend
# --------------------------------------------------------------------------- #
def test_requests_carry_bearer_and_exact_host_no_origin(sc):
    be = netbackend.SidecarBackend(sc.url, TOKEN)
    be.status()
    h = sc.requests[-1]["headers"]
    assert h["Authorization"] == "Bearer " + TOKEN
    assert h["Host"] == f"127.0.0.1:{sc.port}"
    assert "Origin" not in h


def test_wrong_token_is_network_off(sc):
    be = netbackend.SidecarBackend(sc.url, "x" * 40)
    with pytest.raises(netbackend.NetworkOff):
        be.status()


def test_peers_online_only(sc):
    be = netbackend.SidecarBackend(sc.url, TOKEN)
    assert be.peers() == {"desktop": "100.64.0.2"}
    assert be.local_ip() == "100.64.0.1"
    assert be.self_user_id() == 7
    assert be.inbound_bind_host() == "127.0.0.1"
    assert be.requests_proxies() is None


def test_peer_details_include_offline_and_strip_prefix(sc):
    sc.nodes.append({"hostname": "airbridge-nas", "ip": "100.64.0.4", "online": True})
    sc.nodes.append({"hostname": "evil", "ip": "8.8.8.8", "online": True})  # not a tailnet IP: dropped
    d = netbackend.SidecarBackend(sc.url, TOKEN).peer_details()
    names = [n["hostname"] for n in d["nodes"]]
    assert names == ["desktop", "nas", "laptop"]
    assert d["self"]["hostname"] == "a1"


@pytest.mark.parametrize("name", ["desktop", "DESKTOP", "airbridge-desktop", "desktop."])
def test_resolve_with_or_without_prefix(sc, name):
    assert netbackend.SidecarBackend(sc.url, TOKEN).resolve(name) == "100.64.0.2"


def test_resolve_offline_unknown(sc):
    be = netbackend.SidecarBackend(sc.url, TOKEN)
    assert be.resolve("laptop") is None and be.resolve("nope") is None


def test_not_connected_state(sc):
    sc.state = "needs_login"
    be = netbackend.SidecarBackend(sc.url, TOKEN)
    with pytest.raises(network.TailscaleNotRunning, match="not connected"):
        be.local_ip()
    with pytest.raises(network.TailscaleNotRunning):
        be.peers()


def test_dead_sidecar_is_network_off():
    be = netbackend.SidecarBackend("http://127.0.0.1:9", TOKEN)
    with pytest.raises(netbackend.NetworkOff):
        be.status()
    assert be.alive() is False


def test_register_inbox(sc):
    netbackend.SidecarBackend(sc.url, TOKEN).register_inbox(4321, "t" * 43)
    assert sc.inbox == (4321, "t" * 43)


def test_public_network_api_delegates_to_sidecar(sc, monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "sidecar")
    monkeypatch.setenv(config.ENV_NET_URL, sc.url)
    monkeypatch.setenv(config.ENV_NET_TOKEN, TOKEN)
    assert network.get_local_tailscale_ip() == "100.64.0.1"
    assert network.get_airbridge_peers() == {"desktop": "100.64.0.2"}
    assert network.resolve_peer("airbridge-desktop") == "100.64.0.2"
    assert network.inbound_bind_host() == "127.0.0.1"


def test_control_nodes_snapshot_sidecar(sc, monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "sidecar")
    monkeypatch.setenv(config.ENV_NET_URL, sc.url)
    monkeypatch.setenv(config.ENV_NET_TOKEN, TOKEN)
    snap = control.nodes_snapshot()
    assert snap["error"] is None and [n["hostname"] for n in snap["nodes"]] == ["desktop", "laptop"]


def test_control_nodes_snapshot_network_off(monkeypatch):
    _no_system(monkeypatch)
    write_network_json(_data_dir(), "http://127.0.0.1:9")
    snap = control.nodes_snapshot()
    assert snap["nodes"] == [] and snap["error"].startswith("AirBridge network is off")


def test_no_stdout_from_netbackend(sc, capsys):
    be = netbackend.SidecarBackend(sc.url, TOKEN)
    be.peers()
    be.status()
    assert capsys.readouterr().out == ""


# --------------------------------------------------------------------------- #
# Outbox through the sidecar (POST /send, hostname only)
# --------------------------------------------------------------------------- #
@pytest.fixture
def sidecar_env(sc, monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "sidecar")
    monkeypatch.setenv(config.ENV_NET_URL, sc.url)
    monkeypatch.setenv(config.ENV_NET_TOKEN, TOKEN)
    return sc


def _no_direct_http(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("sidecar mode must not open direct HTTP connections to peers")

    monkeypatch.setattr(requests.Session, "post", boom)


def test_outbox_sends_hostname_only_via_sidecar(sidecar_env, settings, monkeypatch):
    _no_direct_http(monkeypatch)
    result = asyncio.run(outbox.send_task_result(settings, "desktop", "do the thing", "print(1)"))
    assert result["ok"] is True, result
    assert result["file"] == "t.md"
    send = [r for r in sidecar_env.requests if r["path"] == "/send"][-1]["body"]
    assert send["target_hostname"] == "desktop"
    assert "target_ip" not in send and "100.64" not in json.dumps(send)
    # F-13: the sender is our control-assigned name from /status, not socket.gethostname().
    assert send["payload"] == {"sender_node": "a1", "task_description": "do the thing", "code_payload": "print(1)"}
    assert "secret" not in send


def test_outbox_forwards_shared_secret(sidecar_env, secret_settings, monkeypatch):
    _no_direct_http(monkeypatch)
    asyncio.run(outbox.send_task_result(secret_settings, "desktop", "x"))
    send = [r for r in sidecar_env.requests if r["path"] == "/send"][-1]["body"]
    assert send["secret"] == "s3cret-value"


@pytest.mark.parametrize("reply,status,needle", [
    ((404, {"ok": False, "error": "unknown_target"}), 404, "no online device named"),
    ((503, {"ok": False, "error": "not_connected"}), 502, "not connected"),
    ((502, {"ok": False, "error": "unreachable"}), 502, "could not connect"),
    ((504, {"ok": False, "error": "timeout"}), 502, "timed out"),
    ((200, {"ok": True, "status": 403, "body": "{\"detail\":\"forbidden: foreign_user\"}"}), 502, "same AirBridge account"),
    ((200, {"ok": True, "status": 429, "body": "{}"}), 429, "rate-limiting"),
    ((200, {"ok": True, "status": 413, "body": "{}"}), 413, "too large"),
    ((200, {"ok": True, "status": 503, "body": "{}"}), 502, "not ready"),
])
def test_outbox_sidecar_error_mapping(sidecar_env, settings, monkeypatch, reply, status, needle):
    _no_direct_http(monkeypatch)
    sidecar_env.send_reply = reply
    result = asyncio.run(outbox.send_task_result(settings, "desktop", "x"))
    assert result["ok"] is False and result["status"] == status
    assert needle in result["message"]


def test_outbox_sidecar_validates_target_locally(sidecar_env, settings):
    result = asyncio.run(outbox.send_task_result(settings, "../etc", "x"))
    assert result["status"] == 400
    assert not [r for r in sidecar_env.requests if r["path"] == "/send"]


def test_outbox_system_mode_posts_directly_without_env_proxies(settings, monkeypatch, fake_peers):
    seen = {}

    class _Resp:
        status_code = 201

        def json(self):
            return {"status": "ok", "file": "task_x.md"}

    def fake_post(self, url, **kw):
        seen.update(url=url, trust_env=self.trust_env, proxies=dict(self.proxies))
        return _Resp()

    monkeypatch.setenv(config.ENV_NETWORK, "system")
    monkeypatch.setenv("HTTP_PROXY", "http://corp-proxy.invalid:3128")
    monkeypatch.setattr(requests.Session, "post", fake_post)
    result = asyncio.run(outbox.send_task_result(settings, "desktop", "hi"))
    assert result["ok"] is True
    assert seen == {"url": "http://100.64.0.5:8989/incoming_task", "trust_env": False, "proxies": {}}


# --------------------------------------------------------------------------- #
# network.json F-8 checks (kept for v2)
# --------------------------------------------------------------------------- #
@pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")
def test_network_json_group_writable_rejected(tmp_path):
    write_network_json(tmp_path, "http://127.0.0.1:1")
    os.chmod(tmp_path / "network.json", 0o620)
    assert config.read_network_json(tmp_path) is None
    os.chmod(tmp_path / "network.json", 0o600)
    assert config.read_network_json(tmp_path) is not None


@pytest.mark.skipif(os.name == "nt", reason="POSIX ownership")
def test_network_json_foreign_owner_rejected(tmp_path, monkeypatch):
    write_network_json(tmp_path, "http://127.0.0.1:1")
    me = os.getuid()
    monkeypatch.setattr(config.os, "getuid", lambda: me + 4242)
    assert config.read_network_json(tmp_path) is None


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlinks")
def test_network_json_symlink_rejected(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    write_network_json(real, "http://127.0.0.1:1")
    (tmp_path / "network.json").symlink_to(real / "network.json")
    assert config.read_network_json(tmp_path) is None
