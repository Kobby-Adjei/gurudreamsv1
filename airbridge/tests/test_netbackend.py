"""Phase 3: network backend selection + embedded tailscaled LocalAPI client."""

from __future__ import annotations

import os
import sys

import pytest
import requests

from airbridge_app import config, netbackend, network, outbox

pytestmark = pytest.mark.skipif(not hasattr(__import__("socket"), "AF_UNIX"), reason="needs AF_UNIX")

from fake_localapi import OTHER_UID, SELF_UID, FakeLocalAPI, make_status, make_whois, write_network_json  # noqa: E402


@pytest.fixture
def api():
    with FakeLocalAPI() as fake:
        yield fake


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in (config.ENV_NETWORK, config.ENV_TS_SOCKET, config.ENV_TS_SOCKS5):
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
    assert isinstance(netbackend.select_backend(), netbackend.SystemTailscale)


def test_live_network_json_selects_embedded(api):
    write_network_json(_data_dir(), api.path, "127.0.0.1:41080")
    be = netbackend.select_backend()
    assert isinstance(be, netbackend.EmbeddedTailscale)
    assert be.socket_path == api.path and be.socks5 == "127.0.0.1:41080"


def test_dead_network_json_without_system_is_network_off(tmp_path, monkeypatch):
    _no_system(monkeypatch)
    write_network_json(_data_dir(), "/tmp/abla-does-not-exist/ts.sock")
    with pytest.raises(network.TailscaleError) as ei:
        netbackend.select_backend()
    assert isinstance(ei.value, netbackend.NetworkOff)
    assert str(ei.value) == "AirBridge network is off \u2014 open the AirBridge app"
    # Public network helpers surface the same error (and it is a TailscaleNotRunning).
    with pytest.raises(network.TailscaleNotRunning):
        network.get_airbridge_peers()


def test_dead_network_json_with_system_falls_back(monkeypatch):
    monkeypatch.setattr(network, "tailscale_binary", lambda: "/usr/bin/tailscale")
    write_network_json(_data_dir(), "/tmp/abla-does-not-exist/ts.sock")
    assert isinstance(netbackend.select_backend(), netbackend.SystemTailscale)


def test_env_override_system_ignores_network_json(api, monkeypatch):
    write_network_json(_data_dir(), api.path)
    monkeypatch.setenv(config.ENV_NETWORK, "system")
    assert isinstance(netbackend.select_backend(), netbackend.SystemTailscale)


def test_env_override_embedded_uses_env_endpoint(api, monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "embedded")
    monkeypatch.setenv(config.ENV_TS_SOCKET, api.path)
    monkeypatch.setenv(config.ENV_TS_SOCKS5, "127.0.0.1:5555")
    be = netbackend.select_backend()
    assert isinstance(be, netbackend.EmbeddedTailscale)
    assert be.requests_proxies() == {"http": "socks5h://127.0.0.1:5555"}


def test_env_override_embedded_without_endpoint_is_network_off(monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "embedded")
    with pytest.raises(netbackend.NetworkOff):
        netbackend.select_backend()


@pytest.mark.parametrize("socks", ["0.0.0.0:1080", "192.168.1.2:1080", "127.0.0.1:0", "127.0.0.1:x", "localhost:1080"])
def test_network_json_with_non_loopback_socks_is_rejected(api, monkeypatch, socks):
    _no_system(monkeypatch)
    write_network_json(_data_dir(), api.path, socks)
    with pytest.raises(netbackend.NetworkOff):
        netbackend.select_backend()


def test_network_json_relative_socket_rejected(monkeypatch):
    _no_system(monkeypatch)
    write_network_json(_data_dir(), "relative/ts.sock")
    with pytest.raises(netbackend.NetworkOff):
        netbackend.select_backend()


def test_invalid_network_mode_means_auto(monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "bogus")
    assert config.network_mode() == "auto"
    assert config.load().network == "auto"


def test_read_network_json_rejects_garbage(tmp_path):
    (tmp_path / "network.json").write_text("{not json")
    assert config.read_network_json(tmp_path) is None
    (tmp_path / "network.json").write_text('{"v": 2}')
    assert config.read_network_json(tmp_path) is None
    (tmp_path / "network.json").write_text('{"v": 1, "socket": "/s"}')
    assert config.read_network_json(tmp_path) == {"v": 1, "socket": "/s"}


# --------------------------------------------------------------------------- #
# Embedded backend over the fake LocalAPI
# --------------------------------------------------------------------------- #
def test_embedded_requests_carry_localapi_headers(api):
    be = netbackend.EmbeddedTailscale(api.path, "127.0.0.1:41080")
    be.status()
    req = api.requests[-1]
    assert req["path"] == "/localapi/v0/status"
    assert req["headers"]["Host"] == "local-tailscaled.sock"
    assert req["headers"]["Sec-Tailscale"] == "localapi"


def test_embedded_peers_strip_prefix_same_user_online_only(api):
    be = netbackend.EmbeddedTailscale(api.path, "127.0.0.1:41080")
    assert be.local_ip() == "100.64.0.1"
    assert be.peers() == {"desktop": "100.64.0.2"}
    assert be.inbound_bind_host() == "127.0.0.1"
    assert be.self_user_id() == SELF_UID


def test_embedded_peer_details_include_offline(api):
    be = netbackend.EmbeddedTailscale(api.path, "127.0.0.1:41080")
    d = be.peer_details()
    assert d["self"] == {"hostname": "thismac", "ip": "100.64.0.1", "os": "macOS"}
    assert d["nodes"] == [
        {"hostname": "desktop", "ip": "100.64.0.2", "os": "windows", "online": True, "last_seen": None},
        {"hostname": "old-laptop", "ip": "100.64.0.3", "os": "linux", "online": False,
         "last_seen": "2026-11-01T10:00:00Z"},
    ]
    assert all(n["hostname"] != "stranger" for n in d["nodes"])


@pytest.mark.parametrize("name", ["desktop", "DESKTOP", "airbridge-desktop", "airbridge-desktop.u-abc.airbridge.internal."])
def test_embedded_resolve_with_or_without_prefix(api, name):
    be = netbackend.EmbeddedTailscale(api.path, "127.0.0.1:41080")
    assert be.resolve(name) == "100.64.0.2"


def test_embedded_resolve_unknown_and_foreign(api):
    be = netbackend.EmbeddedTailscale(api.path, "127.0.0.1:41080")
    assert be.resolve("stranger") is None
    assert be.resolve("old-laptop") is None  # offline
    assert be.resolve("") is None


def test_embedded_not_running_state(api):
    api.status = make_status("NeedsLogin")
    be = netbackend.EmbeddedTailscale(api.path, "127.0.0.1:41080")
    with pytest.raises(network.TailscaleNotRunning) as ei:
        be.local_ip()
    assert "NeedsLogin" in str(ei.value)
    assert "Tailscale" not in str(ei.value)


def test_embedded_whois_known_unknown(api):
    api.whois["127.0.0.1:50123"] = make_whois("airbridge-desktop", SELF_UID, "100.64.0.2")
    be = netbackend.EmbeddedTailscale(api.path, "127.0.0.1:41080")
    who = be.whois("127.0.0.1:50123")
    assert who == {"node": "desktop", "user_id": SELF_UID, "ip": "100.64.0.2", "node_id": "n-airbridge-desktop"}
    req = api.requests[-1]
    assert req["path"] == "/localapi/v0/whois"
    assert req["query"] == {"proto": ["tcp"], "addr": ["127.0.0.1:50123"]}
    assert be.whois("127.0.0.1:1") is None


def test_parse_whois_prefers_control_name_over_hostinfo():
    who = netbackend.parse_whois(make_whois("airbridge-x", OTHER_UID, "100.64.0.4"))
    assert who["node"] == "x" and who["user_id"] == OTHER_UID
    assert netbackend.parse_whois({"Node": {}, "UserProfile": {}}) is None
    assert netbackend.parse_whois("nope") is None


def test_dead_socket_errors_are_network_off():
    be = netbackend.EmbeddedTailscale("/tmp/abla-nope/ts.sock", "127.0.0.1:41080")
    with pytest.raises(netbackend.NetworkOff):
        be.peers()
    assert be.whois("127.0.0.1:5") is None


def test_public_network_api_delegates_to_embedded(api):
    write_network_json(_data_dir(), api.path, "127.0.0.1:41080")
    assert network.get_local_tailscale_ip() == "100.64.0.1"
    assert network.get_airbridge_peers() == {"desktop": "100.64.0.2"}
    assert network.resolve_peer("airbridge-desktop") == "100.64.0.2"
    assert network.inbound_bind_host() == "127.0.0.1"
    assert network.requests_proxies() == {"http": "socks5h://127.0.0.1:41080"}
    assert network.peer_details()["self"]["hostname"] == "thismac"


def test_control_nodes_snapshot_embedded(api):
    from airbridge_app import control

    write_network_json(_data_dir(), api.path)
    snap = control.nodes_snapshot()
    assert snap["error"] is None
    assert [n["hostname"] for n in snap["nodes"]] == ["desktop", "old-laptop"]


def test_control_nodes_snapshot_network_off(monkeypatch):
    from airbridge_app import control

    _no_system(monkeypatch)
    write_network_json(_data_dir(), "/tmp/abla-nope/ts.sock")
    snap = control.nodes_snapshot()
    assert snap["nodes"] == [] and snap["error"].startswith("AirBridge network is off")


# --------------------------------------------------------------------------- #
# Outbox through the SOCKS5 proxy
# --------------------------------------------------------------------------- #
class _Resp:
    status_code = 201

    def json(self):
        return {"status": "ok", "file": "task_x.md"}


def test_outbox_uses_socks5h_proxies_with_trust_env_false(api, settings, monkeypatch):
    write_network_json(_data_dir(), api.path, "127.0.0.1:41080")
    monkeypatch.setenv("HTTP_PROXY", "http://corp-proxy.invalid:3128")
    seen = {}

    def fake_post(self, url, **kw):
        seen.update(url=url, trust_env=self.trust_env, proxies=dict(self.proxies), kw=kw)
        return _Resp()

    monkeypatch.setattr(requests.Session, "post", fake_post)
    import asyncio

    result = asyncio.run(outbox.send_task_result(settings, "desktop", "do the thing"))
    assert result["ok"] is True, result
    assert seen["url"] == "http://100.64.0.2:8989/incoming_task"
    assert seen["trust_env"] is False
    assert seen["proxies"] == {"http": "socks5h://127.0.0.1:41080"}
    assert "proxies" not in seen["kw"]


def test_outbox_system_mode_has_no_proxies(settings, monkeypatch, fake_peers):
    seen = {}

    def fake_post(self, url, **kw):
        seen.update(trust_env=self.trust_env, proxies=dict(self.proxies))
        return _Resp()

    monkeypatch.setattr(network, "requests_proxies", lambda: None)
    monkeypatch.setattr(requests.Session, "post", fake_post)
    import asyncio

    result = asyncio.run(outbox.send_task_result(settings, "desktop", "hi"))
    assert result["ok"] is True
    assert seen == {"trust_env": False, "proxies": {}}


def test_pysocks_available():
    """requests needs PySocks for socks5h:// proxies (requirements.txt)."""
    import socks  # noqa: F401
    from urllib3.contrib import socks as u3socks  # noqa: F401


def test_no_stdout_from_netbackend(api, capsys):
    be = netbackend.EmbeddedTailscale(api.path, "127.0.0.1:41080")
    be.peers()
    be.whois("127.0.0.1:9")
    assert capsys.readouterr().out == ""


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX socket path length")
def test_fake_socket_path_is_short(api):
    assert len(api.path.encode()) < 100


# --------------------------------------------------------------------------- #
# Security review fixes (PHASE3_SECURITY.md F-1, F-8)
# --------------------------------------------------------------------------- #
def test_ipv6_loopback_socks5_accepted(api):
    write_network_json(_data_dir(), api.path, "[::1]:41080")
    be = netbackend.select_backend()
    assert be.requests_proxies() == {"http": "socks5h://[::1]:41080"}


@pytest.mark.parametrize("socks", ["[::]:1080", "[fe80::1]:1080", "::1:1080", "[::1]:99999"])
def test_other_ipv6_socks5_rejected(socks):
    assert netbackend._valid_socks5(socks) is None


def test_socks_adapter_strips_ipv6_brackets(monkeypatch):
    """urllib3 keeps "[::1]" as the SOCKS host; PySocks must get "::1"."""
    seen = {}

    def fake_create_connection(dest_pair, **kw):
        seen.update(dest=dest_pair, **kw)
        raise OSError("stop here")

    import socks

    monkeypatch.setattr(socks, "create_connection", fake_create_connection)
    with pytest.raises(requests.exceptions.RequestException):
        outbox._post("http://100.64.0.2:8989/incoming_task", {}, {}, 2, {"http": "socks5h://[::1]:41080"})
    assert seen["proxy_addr"] == "::1" and seen["proxy_port"] == 41080
    assert seen["proxy_rdns"] is True
    assert seen["dest"] == ("100.64.0.2", 8989)


@pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")
def test_network_json_group_writable_rejected(api, tmp_path):
    write_network_json(tmp_path, api.path)
    os.chmod(tmp_path / "network.json", 0o620)
    assert config.read_network_json(tmp_path) is None
    os.chmod(tmp_path / "network.json", 0o600)
    assert config.read_network_json(tmp_path) is not None


@pytest.mark.skipif(os.name == "nt", reason="POSIX ownership")
def test_network_json_foreign_owner_rejected(api, tmp_path, monkeypatch):
    write_network_json(tmp_path, api.path)
    me = os.getuid()
    monkeypatch.setattr(config.os, "getuid", lambda: me + 4242)
    assert config.read_network_json(tmp_path) is None


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlinks")
def test_network_json_symlink_rejected(api, tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    write_network_json(real, api.path)
    (tmp_path / "network.json").symlink_to(real / "network.json")
    assert config.read_network_json(tmp_path) is None
