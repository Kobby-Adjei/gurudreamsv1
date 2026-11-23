"""Tests for daemon mode (airbridge_app.daemon + main.py --daemon)."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from airbridge_app import daemon, events, network

AIRBRIDGE_DIR = Path(__file__).resolve().parent.parent
MAIN_PY = AIRBRIDGE_DIR / "main.py"
TOKEN = secrets.token_urlsafe(32)

FAKE_TAILSCALE = """#!/bin/sh
case "$1" in
  ip) echo "100.101.102.103" ;;
  status) cat <<'J'
{"BackendState":"Running","Self":{"HostName":"thisbox","OS":"linux","TailscaleIPs":["100.101.102.103"]},
 "Peer":{"a":{"HostName":"Desktop-PC","OS":"windows","Online":true,"TailscaleIPs":["100.64.0.5"]}}}
J
  ;;
esac
"""


def _env(tmp_path: Path, **extra: str) -> dict[str, str]:
    env = dict(os.environ)
    for k in ("AIRBRIDGE_CONTROL_TOKEN", "AIRBRIDGE_CONTROL_PORT", "AIRBRIDGE_PARENT_PID", "AIRBRIDGE_SECRET"):
        env.pop(k, None)
    env.update(
        AIRBRIDGE_DATA_DIR=str(tmp_path / "data"),
        AIRBRIDGE_LOG_FILE=str(tmp_path / "airbridge.log"),
        AIRBRIDGE_INBOX_DIR=str(tmp_path / "inbox"),
        PATH=str(tmp_path / "nobin"),
    )
    env.update(extra)
    return env


def _run_main(tmp_path, *args, **env):
    return subprocess.run(
        [sys.executable, str(MAIN_PY), *args],
        env=_env(tmp_path, **env),
        cwd=str(tmp_path),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=60,
    )


# ------------------------------------------------------------------ CLI validation
def test_daemon_without_token_exits_2(tmp_path):
    proc = _run_main(tmp_path, "--daemon")
    assert proc.returncode == 2
    assert proc.stdout == b""
    assert b"AIRBRIDGE_CONTROL_TOKEN" in proc.stderr


@pytest.mark.parametrize("token", ["short", "x" * 20, "!" * 60, "QUJD"])
def test_daemon_short_or_bad_token_exits_2(tmp_path, token):
    proc = _run_main(tmp_path, "--daemon", AIRBRIDGE_CONTROL_TOKEN=token)
    assert proc.returncode == 2
    assert proc.stdout == b""
    assert b"AIRBRIDGE_CONTROL_TOKEN" in proc.stderr


@pytest.mark.parametrize("port", ["-1", "70000", "abc"])
def test_daemon_bad_port_exits_2(tmp_path, port):
    proc = _run_main(tmp_path, "--daemon", AIRBRIDGE_CONTROL_TOKEN=TOKEN, AIRBRIDGE_CONTROL_PORT=port)
    assert proc.returncode == 2
    assert b"AIRBRIDGE_CONTROL_PORT" in proc.stderr


def test_check_and_daemon_conflict(tmp_path):
    proc = _run_main(tmp_path, "--check", "--daemon")
    assert proc.returncode == 2


def test_token_validation_unit():
    import importlib.util

    spec = importlib.util.spec_from_file_location("ab_main_tok", MAIN_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod._token_ok(secrets.token_urlsafe(32))
    assert not mod._token_ok(secrets.token_urlsafe(16))
    assert not mod._token_ok("")
    assert not mod._token_ok("a b" * 30)


# ------------------------------------------------------------------ in-process daemon
@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "data"
    monkeypatch.setenv("AIRBRIDGE_DATA_DIR", str(d))
    events.configure(None)
    yield d
    events.set_origin("mcp")


def test_run_daemon_ready_status_and_degraded_without_tailscale(settings, data_dir, monkeypatch, capfd):
    def no_tailscale():
        raise network.TailscaleNotInstalled("Tailscale is not installed.")

    monkeypatch.setattr(network, "get_local_tailscale_ip", no_tailscale)
    nodes = {"self": None, "nodes": [], "error": "Tailscale is not installed."}

    async def scenario():
        stop = asyncio.Event()
        task = asyncio.create_task(
            daemon.run_daemon(settings, token=TOKEN, control_port=0, stop=stop, nodes_provider=lambda: nodes)
        )
        port = None
        for _ in range(500):
            err = capfd.readouterr().err
            if "AIRBRIDGE_READY" in err:
                line = next(l for l in err.splitlines() if l.startswith("AIRBRIDGE_READY "))
                payload = json.loads(line.split(" ", 1)[1])
                assert payload["pid"] == os.getpid()
                port = payload["control_port"]
                assert payload["control_host"] in ("::1", "127.0.0.1")
                base = f"http://[::1]:{port}" if payload["control_host"] == "::1" else f"http://127.0.0.1:{port}"
                break
            await asyncio.sleep(0.01)
        assert port, "no READY line"
        async with httpx.AsyncClient(trust_env=False) as client:
            for _ in range(100):
                r = await client.get(f"{base}/status",
                                     headers={"Authorization": f"Bearer {TOKEN}"})
                if r.json()["inbox"]["degraded_reason"]:
                    break
                await asyncio.sleep(0.02)
            status = r.json()
            nodes_r = await client.get(f"{base}/nodes",
                                       headers={"Authorization": f"Bearer {TOKEN}"})
        stop.set()
        rc = await asyncio.wait_for(task, timeout=10)
        return rc, status, nodes_r.json()

    rc, status, nodes_body = asyncio.run(scenario())
    assert rc == 0
    assert status["mode"] == "daemon"
    assert status["inbox"]["listening"] is False
    assert "not installed" in status["inbox"]["degraded_reason"]
    assert nodes_body["error"] == "Tailscale is not installed."
    out = capfd.readouterr()
    assert out.out == ""
    types = [e["type"] for e in events.read_recent()]
    assert types[0] == "daemon_started"
    assert "inbox_degraded" in types
    assert types[-1] == "daemon_stopping"
    assert all(e["origin"] == "daemon" for e in events.read_recent())


def test_node_watcher_emits_online_offline(data_dir):
    snaps = [
        {"nodes": [{"hostname": "a", "online": True}, {"hostname": "b", "online": False}], "error": None},
        {"nodes": [{"hostname": "a", "online": False}, {"hostname": "b", "online": True}], "error": None},
        {"nodes": [], "error": "tailscale down"},  # errors don't produce diffs
        {"nodes": [{"hostname": "b", "online": True}, {"hostname": "c", "online": True}], "error": None},
    ]
    calls = {"n": 0}

    def provider():
        i = min(calls["n"], len(snaps) - 1)
        calls["n"] += 1
        return snaps[i]

    async def scenario():
        stop = asyncio.Event()
        task = asyncio.create_task(daemon._watch_nodes(stop, provider, interval=0.01))
        while calls["n"] < len(snaps) + 1:
            await asyncio.sleep(0.01)
        stop.set()
        await asyncio.wait_for(task, timeout=5)

    asyncio.run(scenario())
    got = [(e["type"], e["peer"]) for e in events.read_recent()]
    # baseline snapshot is silent; then a goes offline, b online; then c online
    assert got == [("node_offline", "a"), ("node_online", "b"), ("node_online", "c")]


def test_pid_alive():
    assert daemon.pid_alive(os.getpid())
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    assert not daemon.pid_alive(proc.pid)
    assert not daemon.pid_alive(0)


def test_watch_parent_sets_stop_when_parent_dies(monkeypatch):
    monkeypatch.setattr(daemon, "PARENT_POLL_S", 0.01)
    alive = {"v": True}
    monkeypatch.setattr(daemon, "pid_alive", lambda pid: alive["v"])

    async def scenario():
        stop = asyncio.Event()
        task = asyncio.create_task(daemon._watch_parent(999999, stop))
        await asyncio.sleep(0.05)
        assert not stop.is_set()
        alive["v"] = False
        await asyncio.wait_for(task, timeout=2)
        return stop.is_set()

    assert asyncio.run(scenario())


# ------------------------------------------------------------------ subprocess end to end
@pytest.mark.skipif(sys.platform == "win32", reason="fake tailscale is a POSIX shell script")
def test_subprocess_daemon_ready_and_parent_watchdog(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake = bindir / "tailscale"
    fake.write_text(FAKE_TAILSCALE)
    fake.chmod(0o755)
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(4)"])
    env = _env(
        tmp_path,
        PATH=f"{bindir}{os.pathsep}/usr/bin{os.pathsep}/bin",
        AIRBRIDGE_CONTROL_TOKEN=TOKEN,
        AIRBRIDGE_CONTROL_PORT="0",
        AIRBRIDGE_PARENT_PID=str(parent.pid),
    )
    proc = subprocess.Popen(
        [sys.executable, str(MAIN_PY), "--daemon"],
        env=env, cwd=str(tmp_path), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        line = proc.stderr.readline().decode()
        assert line.startswith("AIRBRIDGE_READY "), line
        info = json.loads(line.split(" ", 1)[1])
        assert info["pid"] == proc.pid
        h = "[::1]" if info.get("control_host") == "::1" else "127.0.0.1"
        # READY is printed when the control API listens; the inbox supervisor resolves the tailnet IP
        # concurrently, so poll briefly instead of racing it.
        deadline = time.monotonic() + 10
        while True:
            r = httpx.get(f"http://{h}:{info['control_port']}/status",
                          headers={"Authorization": f"Bearer {TOKEN}"}, trust_env=False, timeout=5)
            assert r.status_code == 200
            if r.json()["tailnet_ip"] or time.monotonic() > deadline:
                break
            time.sleep(0.1)
        assert r.json()["tailnet_ip"] == "100.101.102.103"
        parent.kill()
        parent.wait()
        t0 = time.monotonic()
        rc = proc.wait(timeout=20)
        assert rc == 0
        assert time.monotonic() - t0 < 15
        assert proc.stdout.read() == b""
    finally:
        for p in (proc, parent):
            if p.poll() is None:
                p.kill()
                p.wait()
        proc.stdout.close()
        proc.stderr.close()


# ------------------------------------------------------------------ security review fixes
def test_daemon_env_pops_token_from_environment(monkeypatch):
    """The control token must not leak to child processes (tailscale, osascript...)."""
    import importlib.util

    from airbridge_app import config

    spec = importlib.util.spec_from_file_location("ab_main_env", MAIN_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setenv("AIRBRIDGE_CONTROL_TOKEN", TOKEN)
    monkeypatch.setenv("AIRBRIDGE_CONTROL_PORT", "0")
    token, port, ppid = mod._daemon_env(config)
    assert token == TOKEN and port == 0
    assert "AIRBRIDGE_CONTROL_TOKEN" not in os.environ
    # and a child process spawned afterwards does not see it
    out = subprocess.run([sys.executable, "-c", "import os;print(os.environ.get('AIRBRIDGE_CONTROL_TOKEN',''))"],
                         capture_output=True, text=True, timeout=30)
    assert out.stdout.strip() == ""


def test_windows_tailscale_lookup_ignores_cwd(monkeypatch, tmp_path):
    """On Windows shutil.which() searches the cwd first; such hits must be rejected."""
    good = tmp_path / "Program Files" / "Tailscale"
    good.mkdir(parents=True)
    planted = tmp_path / "cwd"
    planted.mkdir()
    (good / "tailscale.exe").write_text("")
    good_exe, planted_exe = str(good / "tailscale.exe"), str(planted / "tailscale.exe")
    rel_exe = str(Path("relative-dir").resolve() / "tailscale.exe")
    # compute all Path objects before pretending to be Windows (pathlib checks os.name)
    monkeypatch.setattr(network.shutil, "which", lambda name: planted_exe)
    monkeypatch.setattr(network, "FALLBACK_BINARIES", (good_exe,))
    monkeypatch.setenv("PATH", str(good))
    monkeypatch.setattr(network.os, "name", "nt")
    assert network._on_path(good_exe)
    assert not network._on_path(planted_exe)
    # tailscale_binary() falls through to the fixed install locations instead
    assert network.tailscale_binary() == good_exe
    monkeypatch.setenv("PATH", "relative-dir" + os.pathsep + str(good))
    assert not network._on_path(rel_exe)


def test_on_path_is_noop_on_posix(monkeypatch):
    monkeypatch.setattr(network.os, "name", "posix")
    assert network._on_path("/anywhere/tailscale")
