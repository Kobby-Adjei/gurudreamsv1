"""Phase 3 §9: the daemon in sidecar mode (AIRBRIDGE_NETWORK=sidecar) against a fake sidecar.

The inbox binds 127.0.0.1:<ephemeral>, registers {port, token} with the sidecar (POST /inbox),
accepts requests only with that token, and records the sidecar-verified sender.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import sys
from pathlib import Path

import httpx
import pytest

from airbridge_app import config, daemon, netbackend
from airbridge_app import inbox as inbox_mod

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


def test_daemon_registers_loopback_inbox_and_enforces_signature(sc, settings, inbox_dir: Path):
    payload = {"sender_node": "a2", "task_description": "hello from a2"}
    raw = json.dumps(payload).encode()

    async def scenario(stop):
        port, token = await _wait_for(lambda: sc.inbox)
        assert port != config.PORT and len(token) >= 32
        forged = {"X-AirBridge-Peer-Node": "airbridge-a2", "X-AirBridge-Peer-IP": "100.64.0.2",
                  "X-AirBridge-Peer-User": "7", "Content-Type": "application/json"}

        def signed(key: str) -> dict:
            t = str(int(time.time()))
            sig = inbox_mod.sign_forward(key, "POST", "/incoming_task", t, raw, "airbridge-a2", "100.64.0.2", "7")
            return {**forged, "X-AirBridge-Sidecar-Ts": t, "X-AirBridge-Sidecar-Sig": sig}

        async with httpx.AsyncClient(trust_env=False, timeout=5) as c:
            url = f"http://127.0.0.1:{port}/incoming_task"
            r1 = await c.post(url, content=raw, headers=forged)  # no signature
            r2 = await c.post(url, content=raw, headers=signed("x" * 43))  # wrong key
            good = signed(token)  # what the sidecar sends
            r3 = await c.post(url, content=raw, headers=good)
            r4 = await c.post(url, content=raw, headers=good)  # replay
        return r1.status_code, r2.status_code, r3.status_code, r4.status_code

    assert _run(settings, scenario) == (403, 403, 201, 403)
    files = list(inbox_dir.glob("*.md"))
    assert len(files) == 1
    text = files[0].read_text(encoding="utf-8")
    assert 'sender: "a2"' in text
    # S-2: the inbox deregistered itself from the sidecar when the daemon stopped
    assert sc.inbox is None and sc.deregistered


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
