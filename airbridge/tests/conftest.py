"""Shared pytest fixtures for AirBridge.

* ``settings`` / ``secret_settings``: Settings pointing at a temporary inbox.
* ``fake_peers``: replaces Tailscale discovery with an in-memory peer table.
* ``notifications`` (autouse): stubs ``notify.send_notification`` so tests never
  pop real desktop notifications. Tests in ``test_notify.py`` or marked
  ``@pytest.mark.real_notify`` keep the real function.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from airbridge_app import config, network, notify

TAILNET_CLIENT = ("100.101.102.103", 50000)
NON_TAILNET_CLIENT = ("192.168.1.20", 50000)

FAKE_PEERS: dict[str, str] = {
    "desktop": "100.64.0.5",
    "laptop": "100.101.102.104",
}


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "real_notify: do not stub notify.send_notification")


@pytest.fixture
def inbox_dir(tmp_path: Path) -> Path:
    return tmp_path / "AirBridge_Inbox"


@pytest.fixture
def settings(tmp_path: Path, inbox_dir: Path) -> config.Settings:
    return config.Settings(
        port=config.PORT,
        inbox_dir=inbox_dir,
        log_file=tmp_path / "airbridge.log",
        shared_secret=None,
        http_timeout_s=10,
        rate_limit_per_minute=30,
    )


@pytest.fixture
def secret_settings(tmp_path: Path, inbox_dir: Path) -> config.Settings:
    return config.Settings(
        port=config.PORT,
        inbox_dir=inbox_dir,
        log_file=tmp_path / "airbridge.log",
        shared_secret="s3cret-value",
        http_timeout_s=10,
        rate_limit_per_minute=30,
    )


@pytest.fixture
def fake_peers(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """Replace Tailscale discovery with FAKE_PEERS (mutable per test)."""
    peers = dict(FAKE_PEERS)

    def get_peers() -> dict[str, str]:
        return dict(peers)

    def resolve(hostname: str) -> str | None:
        return peers.get((hostname or "").lower())

    monkeypatch.setattr(network, "get_airbridge_peers", get_peers)
    monkeypatch.setattr(network, "resolve_peer", resolve)
    return peers


@pytest.fixture(autouse=True)
def notifications(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Record notifications instead of showing them."""
    calls: list[tuple[str, str]] = []
    module_file = Path(str(getattr(request.node, "fspath", ""))).name
    if module_file == "test_notify.py" or request.node.get_closest_marker("real_notify"):
        return calls

    def fake_send(title: str, body: str) -> None:
        calls.append((title, body))

    monkeypatch.setattr(notify, "send_notification", fake_send)
    return calls
