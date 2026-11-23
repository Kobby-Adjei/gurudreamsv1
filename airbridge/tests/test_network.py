"""Tests for airbridge_app.network (no real Tailscale: subprocess.run / shutil.which mocked)."""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from airbridge_app import network  # noqa: E402

FAKE_BIN = "/usr/local/bin/tailscale"

# Realistic `tailscale status --json` output (trimmed), shape as of Tailscale 1.7x.
STATUS_RUNNING = {
    "Version": "1.76.6-t1234567-gabcdef",
    "TUN": True,
    "BackendState": "Running",
    "AuthURL": "",
    "TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1234:5678"],
    "Self": {
        "ID": "nSelf123CNTRL",
        "PublicKey": "nodekey:aaaa",
        "HostName": "Alices-MacBook-Pro",
        "DNSName": "alices-macbook-pro.tail1a2b3.ts.net.",
        "OS": "macOS",
        "TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1234:5678"],
        "Online": True,
        "Active": False,
    },
    "MagicDNSSuffix": "tail1a2b3.ts.net",
    "CurrentTailnet": {"Name": "alice@example.com", "MagicDNSSuffix": "tail1a2b3.ts.net"},
    "Peer": {
        "nodekey:bbbb": {
            "ID": "nPeerB",
            "HostName": "DESKTOP-WIN11",
            "DNSName": "desktop-win11.tail1a2b3.ts.net.",
            "OS": "windows",
            "TailscaleIPs": ["fd7a:115c:a1e0::aaaa:bbbb", "100.88.1.2"],
            "Online": True,
            "Active": True,
        },
        "nodekey:cccc": {
            "ID": "nPeerC",
            "HostName": "old-laptop",
            "DNSName": "old-laptop.tail1a2b3.ts.net.",
            "OS": "linux",
            "TailscaleIPs": ["100.77.7.7"],
            "Online": False,
        },
        "nodekey:dddd": {
            "ID": "nPeerD",
            "HostName": "localhost",
            "DNSName": "bobs-studio.tail1a2b3.ts.net.",
            "OS": "macOS",
            "TailscaleIPs": ["100.66.5.4", "fd7a:115c:a1e0::5:4"],
            "Online": True,
        },
        "nodekey:eeee": {
            "ID": "nPeerE",
            "HostName": "phone",
            "DNSName": "phone.tail1a2b3.ts.net.",
            "OS": "iOS",
            "TailscaleIPs": ["fd7a:115c:a1e0::9"],  # IPv6 only -> skipped
            "Online": True,
        },
        "nodekey:ffff": "garbage-entry",
    },
}

STATUS_STOPPED = {
    "Version": "1.76.6",
    "BackendState": "Stopped",
    "TailscaleIPs": None,
    "Self": {"HostName": "Alices-MacBook-Pro", "TailscaleIPs": None, "Online": False},
    "Peer": None,
}

STATUS_NEEDS_LOGIN = {"BackendState": "NeedsLogin", "AuthURL": "https://login.tailscale.com/a/xyz", "Peer": None}


def _proc(stdout="", stderr="", rc=0):
    return subprocess.CompletedProcess(args=[FAKE_BIN], returncode=rc, stdout=stdout, stderr=stderr)


@pytest.fixture
def which_ok(monkeypatch):
    monkeypatch.setattr(network.shutil, "which", lambda name: FAKE_BIN)


@pytest.fixture
def fake_run(monkeypatch, which_ok):
    """Install a fake subprocess.run; returns a dict to configure responses and inspect calls."""
    state = {"calls": [], "responses": {}}

    def run(cmd, **kwargs):
        state["calls"].append((cmd, kwargs))
        key = " ".join(cmd[1:])
        resp = state["responses"].get(key)
        if isinstance(resp, BaseException):
            raise resp
        if resp is None:
            return _proc(rc=1, stderr="unexpected")
        return resp

    monkeypatch.setattr(network.subprocess, "run", run)
    return state


# ---------------------------------------------------------------- binary lookup
def test_tailscale_binary_uses_which(which_ok):
    assert network.tailscale_binary() == FAKE_BIN


def test_tailscale_binary_fallback(monkeypatch):
    monkeypatch.setattr(network.shutil, "which", lambda name: None)
    mac = network.FALLBACK_BINARIES[0]
    monkeypatch.setattr(network.os.path, "isfile", lambda p: p == mac)
    assert network.tailscale_binary() == mac


def test_tailscale_binary_missing(monkeypatch):
    monkeypatch.setattr(network.shutil, "which", lambda name: None)
    monkeypatch.setattr(network.os.path, "isfile", lambda p: False)
    with pytest.raises(network.TailscaleNotInstalled) as ei:
        network.tailscale_binary()
    assert "Install Tailscale" in str(ei.value)
    assert isinstance(ei.value, network.TailscaleError)
    assert isinstance(ei.value, RuntimeError)


# ---------------------------------------------------------------- local IP
def test_get_local_ip_ok_and_subprocess_args(fake_run):
    fake_run["responses"]["ip -4"] = _proc("100.101.102.103\n")
    assert network.get_local_tailscale_ip() == "100.101.102.103"
    cmd, kw = fake_run["calls"][0]
    assert cmd == [FAKE_BIN, "ip", "-4"]
    assert kw["shell"] is False
    assert kw["check"] is False
    assert kw["timeout"] == 5


def test_get_local_ip_takes_first_line(fake_run):
    fake_run["responses"]["ip -4"] = _proc("100.64.0.9\n100.64.0.10\n")
    assert network.get_local_tailscale_ip() == "100.64.0.9"


@pytest.mark.parametrize("out", ["192.168.1.5\n", "garbage\n", "fd7a:115c:a1e0::1\n", "100.128.0.1\n"])
def test_get_local_ip_rejects_non_tailnet(fake_run, out):
    fake_run["responses"]["ip -4"] = _proc(out)
    with pytest.raises(network.TailscaleError):
        network.get_local_tailscale_ip()


def test_get_local_ip_not_running(fake_run):
    fake_run["responses"]["ip -4"] = _proc(
        "", "failed to connect to local tailscaled; it doesn't appear to be running\n", rc=1
    )
    with pytest.raises(network.TailscaleNotRunning) as ei:
        network.get_local_tailscale_ip()
    assert "Start the Tailscale app" in str(ei.value)


def test_get_local_ip_empty_output(fake_run):
    fake_run["responses"]["ip -4"] = _proc("", "", rc=0)
    with pytest.raises(network.TailscaleNotRunning):
        network.get_local_tailscale_ip()


def test_get_local_ip_timeout(fake_run):
    fake_run["responses"]["ip -4"] = subprocess.TimeoutExpired(cmd="tailscale", timeout=5)
    with pytest.raises(network.TailscaleNotRunning) as ei:
        network.get_local_tailscale_ip()
    assert "timed out" in str(ei.value)


def test_get_local_ip_binary_vanished(fake_run):
    fake_run["responses"]["ip -4"] = FileNotFoundError("tailscale")
    with pytest.raises(network.TailscaleNotInstalled):
        network.get_local_tailscale_ip()


def test_get_local_ip_not_installed(monkeypatch):
    monkeypatch.setattr(network.shutil, "which", lambda name: None)
    monkeypatch.setattr(network.os.path, "isfile", lambda p: False)

    def boom(*a, **k):  # pragma: no cover - must not be called
        raise AssertionError("subprocess.run should not be called")

    monkeypatch.setattr(network.subprocess, "run", boom)
    with pytest.raises(network.TailscaleNotInstalled):
        network.get_local_tailscale_ip()


# ---------------------------------------------------------------- peers
def test_get_peers_parses_realistic_status(fake_run):
    fake_run["responses"]["status --json"] = _proc(json.dumps(STATUS_RUNNING))
    peers = network.get_airbridge_peers()
    assert peers == {"desktop-win11": "100.88.1.2", "localhost": "100.66.5.4"}
    assert "alices-macbook-pro" not in peers  # Self excluded
    assert "old-laptop" not in peers  # offline excluded
    assert "phone" not in peers  # no IPv4
    cmd, kw = fake_run["calls"][0]
    assert cmd == [FAKE_BIN, "status", "--json"]
    assert kw["shell"] is False


def test_get_peers_empty_peer_map(fake_run):
    data = dict(STATUS_RUNNING, Peer=None)
    fake_run["responses"]["status --json"] = _proc(json.dumps(data))
    assert network.get_airbridge_peers() == {}


@pytest.mark.parametrize("status", [STATUS_STOPPED, STATUS_NEEDS_LOGIN])
def test_get_peers_backend_not_running(fake_run, status):
    fake_run["responses"]["status --json"] = _proc(json.dumps(status), rc=1)
    with pytest.raises(network.TailscaleNotRunning) as ei:
        network.get_airbridge_peers()
    assert status["BackendState"] in str(ei.value)


def test_get_peers_daemon_down(fake_run):
    fake_run["responses"]["status --json"] = _proc(
        "", "failed to connect to local tailscaled (which appears to be running)", rc=1
    )
    with pytest.raises(network.TailscaleNotRunning):
        network.get_airbridge_peers()


def test_get_peers_invalid_json(fake_run):
    fake_run["responses"]["status --json"] = _proc("{not json")
    with pytest.raises(network.TailscaleError):
        network.get_airbridge_peers()


def test_get_peers_non_object_json(fake_run):
    fake_run["responses"]["status --json"] = _proc("[1, 2]")
    with pytest.raises(network.TailscaleError):
        network.get_airbridge_peers()


# ---------------------------------------------------------------- resolve
@pytest.mark.parametrize(
    "query,expected",
    [
        ("DESKTOP-WIN11", "100.88.1.2"),
        ("desktop-win11", "100.88.1.2"),
        ("  Desktop-Win11 ", "100.88.1.2"),
        ("bobs-studio", "100.66.5.4"),  # MagicDNS short name
        ("bobs-studio.tail1a2b3.ts.net.", "100.66.5.4"),  # FQDN
        ("old-laptop", None),  # offline
        ("alices-macbook-pro", None),  # self
        ("nobody", None),
        ("", None),
    ],
)
def test_resolve_peer(fake_run, query, expected):
    fake_run["responses"]["status --json"] = _proc(json.dumps(STATUS_RUNNING))
    assert network.resolve_peer(query) == expected


def test_resolve_peer_non_string():
    assert network.resolve_peer(None) is None  # type: ignore[arg-type]


def test_resolve_peer_propagates_not_running(fake_run):
    fake_run["responses"]["status --json"] = _proc(json.dumps(STATUS_STOPPED))
    with pytest.raises(network.TailscaleNotRunning):
        network.resolve_peer("desktop-win11")
