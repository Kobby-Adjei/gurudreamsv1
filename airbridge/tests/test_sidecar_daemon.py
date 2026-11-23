"""Phase 3 §9: the daemon in sidecar mode (AIRBRIDGE_NETWORK=sidecar) against a fake sidecar.

The inbox binds 127.0.0.1:<ephemeral>, registers {port, token} with the sidecar (POST /inbox),
accepts requests only with that token, and records the sidecar-verified sender.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import httpx
import pytest

from airbridge_app import config, daemon, netbackend

sys.path.insert(0, os.path.dirname(__file__))
from fake_sidecar import TOKEN, FakeSidecar  # noqa: E402

CTL_TOKEN = "daemon-control-token-0123456789abcdefghijkl"


@pytest.fixture
def sc(monkeypatch):
    with FakeSidecar() as fake:
        monkeypatch.setenv(config.ENV_NETWORK, "sidecar")
        monkeypatch.setenv(config.ENV_NET_URL, fake.url)
        monkeypatch.setenv(config.ENV_NET_TOKEN, TOKEN)
        netbackend.set_backend_override(None)
        yield fake


def _run(settings, scenario):
    async def main():
        stop = asyncio.Event()
        task = asyncio.create_task(daemon.run_daemon(settings, token=CTL_TOKEN, stop=stop,
                                                     nodes_provider=lambda: {"self": {}, "nodes": []}))
        try:
            return await scenario(stop)
        finally:
            stop.set()
            await asyncio.wait_for(task, 10)

    return asyncio.run(main())


async def _wait_for(pred, timeout=10.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        v = pred()
        if v:
            return v
        await asyncio.sleep(0.05)
    raise AssertionError("timeout")


def test_daemon_registers_loopback_inbox_and_enforces_token(sc, settings, inbox_dir: Path):
    payload = {"sender_node": "liar", "task_description": "hello from a2"}

    async def scenario(stop):
        port, token = await _wait_for(lambda: sc.inbox)
        assert port != config.PORT and len(token) >= 32
        async with httpx.AsyncClient(trust_env=False, timeout=5) as c:
            url = f"http://127.0.0.1:{port}/incoming_task"
            forged = {"X-AirBridge-Peer-Node": "airbridge-a2", "X-AirBridge-Peer-IP": "100.64.0.2"}
            r1 = await c.post(url, json=payload, headers=forged)
            r2 = await c.post(url, json=payload, headers={**forged, "X-AirBridge-Sidecar-Token": "x" * 43})
            r3 = await c.post(url, json=payload, headers={**forged, "X-AirBridge-Sidecar-Token": token})
            # F-13 (REJECT_SENDER_MISMATCH): "liar" does not name the verified a2 -> 400; "a2" -> 201.
            r4 = await c.post(url, json={**payload, "sender_node": "a2"},
                              headers={**forged, "X-AirBridge-Sidecar-Token": token})
        return r1.status_code, r2.status_code, r3.status_code, r4.status_code

    assert _run(settings, scenario) == (403, 403, 400, 201)
    files = list(inbox_dir.glob("*.md"))
    assert len(files) == 1
    text = files[0].read_text(encoding="utf-8")
    assert "a2" in text and "liar" not in text


def test_daemon_degraded_while_sidecar_needs_login(sc, settings):
    sc.state = "needs_login"

    async def scenario(stop):
        await asyncio.sleep(0.5)
        return sc.inbox

    assert _run(settings, scenario) is None


def test_daemon_without_sidecar_endpoint_stays_up_degraded(settings, monkeypatch):
    monkeypatch.setenv(config.ENV_NETWORK, "sidecar")
    monkeypatch.delenv(config.ENV_NET_URL, raising=False)
    monkeypatch.delenv(config.ENV_NET_TOKEN, raising=False)
    monkeypatch.setattr("airbridge_app.network.tailscale_binary", lambda: "/usr/bin/tailscale")

    async def scenario(stop):
        await asyncio.sleep(0.3)
        return True

    assert _run(settings, scenario) is True  # no system fallback attempted, no crash
