"""Tests for airbridge/main.py. Sibling modules (security/inbox/outbox) are faked
via sys.modules so these tests don't depend on their implementation."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

AIRBRIDGE_DIR = Path(__file__).resolve().parent.parent
MAIN_PY = AIRBRIDGE_DIR / "main.py"
sys.path.insert(0, str(AIRBRIDGE_DIR))

from airbridge_app import network  # noqa: E402


def _load_main():
    spec = importlib.util.spec_from_file_location("airbridge_main_under_test", MAIN_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def main_mod(monkeypatch, tmp_path):
    monkeypatch.setenv("AIRBRIDGE_LOG_FILE", str(tmp_path / "airbridge.log"))
    monkeypatch.setenv("AIRBRIDGE_INBOX_DIR", str(tmp_path / "inbox"))
    monkeypatch.delenv("AIRBRIDGE_SECRET", raising=False)
    return _load_main()


# ------------------------------------------------------------------ fakes
class FakeServer:
    def __init__(self, fail_bind=False):
        self.should_exit = False
        self.force_exit = False
        self.fail_bind = fail_bind
        self.served = False
        self.stopped = False

    def capture_signals(self):  # pragma: no cover - must be replaced by main
        raise AssertionError("uvicorn signal capture must be disabled")

    async def serve(self):
        self.capture_signals()
        self.served = True
        if self.fail_bind:
            raise SystemExit(3)  # what uvicorn does when the port is in use
        while not self.should_exit:
            await asyncio.sleep(0.01)
        self.stopped = True


class FakeMCP:
    def __init__(self):
        self.ran = False

    async def run_stdio_async(self):
        await asyncio.sleep(0.05)  # pretend a session happened, then stdin EOF
        self.ran = True


class SecurityError(ValueError):
    pass


def _install_fakes(monkeypatch, fail_bind=False, reject_host=False):
    state = types.SimpleNamespace(server=FakeServer(fail_bind=fail_bind), mcp=FakeMCP(), calls=[])

    def validate_bind_host(ip):
        state.calls.append(("validate_bind_host", ip))
        if reject_host:
            raise SecurityError("not a tailnet address")
        return ip

    def create_app(settings, peers_provider=None):
        state.calls.append(("create_app", settings))
        return "APP"

    def build_server(app, host, port):
        state.calls.append(("build_server", app, host, port))
        return state.server

    def build_mcp_server(settings=None):
        state.calls.append(("build_mcp_server", settings))
        return state.mcp

    sec = types.ModuleType("airbridge_app.security")
    sec.validate_bind_host = validate_bind_host
    sec.SecurityError = SecurityError
    inbox = types.ModuleType("airbridge_app.inbox")
    inbox.create_app = create_app
    inbox.build_server = build_server
    outbox = types.ModuleType("airbridge_app.outbox")
    outbox.build_mcp_server = build_mcp_server
    monkeypatch.setitem(sys.modules, "airbridge_app.security", sec)
    monkeypatch.setitem(sys.modules, "airbridge_app.inbox", inbox)
    monkeypatch.setitem(sys.modules, "airbridge_app.outbox", outbox)
    return state


def _no_tailscale(monkeypatch):
    monkeypatch.setattr(network.shutil, "which", lambda name: None)
    monkeypatch.setattr(network.os.path, "isfile", lambda p: False)


def _tailscale_ok(monkeypatch, ip="100.101.102.103", peers=None):
    monkeypatch.setattr(network.shutil, "which", lambda name: "/usr/bin/tailscale")
    status = {
        "BackendState": "Running",
        "Self": {"HostName": "me", "TailscaleIPs": [ip], "Online": True},
        "Peer": peers or {},
    }

    def run(cmd, **kwargs):
        if cmd[1:] == ["ip", "-4"]:
            return subprocess.CompletedProcess(cmd, 0, ip + "\n", "")
        if cmd[1:] == ["status", "--json"]:
            return subprocess.CompletedProcess(cmd, 0, json.dumps(status), "")
        raise AssertionError(cmd)

    monkeypatch.setattr(network.subprocess, "run", run)


# ------------------------------------------------------------------ tests
def test_tailscale_missing_returns_2_with_empty_stdout(main_mod, monkeypatch, capfd):
    _no_tailscale(monkeypatch)
    state = _install_fakes(monkeypatch)
    assert main_mod.main([]) == 2
    out, err = capfd.readouterr()
    assert out == ""
    assert "Tailscale CLI not found" in err
    assert "Hint:" in err
    assert state.calls == []  # never got as far as binding


def test_tailscale_not_running_returns_2(main_mod, monkeypatch, capfd):
    monkeypatch.setattr(network.shutil, "which", lambda name: "/usr/bin/tailscale")
    monkeypatch.setattr(
        network.subprocess,
        "run",
        lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, "", "failed to connect to local tailscaled"),
    )
    _install_fakes(monkeypatch)
    assert main_mod.main([]) == 2
    out, err = capfd.readouterr()
    assert out == ""
    assert "Tailscale is not running" in err


def test_bind_host_rejected_returns_2(main_mod, monkeypatch, capfd):
    _tailscale_ok(monkeypatch)
    state = _install_fakes(monkeypatch, reject_host=True)
    assert main_mod.main([]) == 2
    out, err = capfd.readouterr()
    assert out == ""
    assert "refusing to bind" in err
    assert ("validate_bind_host", "100.101.102.103") in state.calls
    assert not any(c[0] == "build_server" for c in state.calls)


def test_happy_path_runs_both_and_shuts_down_inbox(main_mod, monkeypatch, capfd):
    _tailscale_ok(monkeypatch)
    state = _install_fakes(monkeypatch)
    assert main_mod.main([]) == 0
    out, _err = capfd.readouterr()
    assert out == ""
    assert state.mcp.ran
    assert state.server.served and state.server.should_exit and state.server.stopped
    build = [c for c in state.calls if c[0] == "build_server"][0]
    assert build[2:] == ("100.101.102.103", 8989)


def test_port_in_use_degrades_to_outbox_only(main_mod, monkeypatch, capfd):
    _tailscale_ok(monkeypatch)
    state = _install_fakes(monkeypatch, fail_bind=True)
    assert main_mod.main([]) == 0
    out, err = capfd.readouterr()
    assert out == ""
    assert "outbox-only" in err
    assert state.mcp.ran  # MCP kept running despite the inbox failure


def test_mcp_crash_returns_1(main_mod, monkeypatch, capfd):
    _tailscale_ok(monkeypatch)
    state = _install_fakes(monkeypatch)

    async def boom():
        raise RuntimeError("stdio exploded")

    state.mcp.run_stdio_async = boom
    assert main_mod.main([]) == 1
    out, err = capfd.readouterr()
    assert out == ""
    assert "fatal error" in err
    assert state.server.should_exit


def test_stray_print_during_construction_goes_to_stderr(main_mod, monkeypatch, capfd):
    _tailscale_ok(monkeypatch)
    state = _install_fakes(monkeypatch)
    inbox = sys.modules["airbridge_app.inbox"]
    real_create = inbox.create_app

    def noisy_create(settings, peers_provider=None):
        sys.stdout.write("stray noise\n")
        return real_create(settings)

    inbox.create_app = noisy_create
    assert main_mod.main([]) == 0
    out, err = capfd.readouterr()
    assert out == ""
    assert "stray noise" in err
    assert state.mcp.ran


def test_check_ok(main_mod, monkeypatch, capfd):
    peers = {
        "k1": {"HostName": "Desk", "TailscaleIPs": ["100.80.0.2"], "Online": True},
        "k2": {"HostName": "gone", "TailscaleIPs": ["100.80.0.3"], "Online": False},
    }
    _tailscale_ok(monkeypatch, peers=peers)
    _install_fakes(monkeypatch)
    assert main_mod.main(["--check"]) == 0
    out, err = capfd.readouterr()
    assert out == ""
    assert "100.101.102.103" in err
    assert "online peers: 1" in err
    assert "desk (100.80.0.2)" in err


def test_check_without_tailscale(main_mod, monkeypatch, capfd):
    _no_tailscale(monkeypatch)
    assert main_mod.main(["--check"]) == 2
    out, err = capfd.readouterr()
    assert out == ""
    assert "ERROR" in err


def test_help_and_unknown_args(main_mod, capfd):
    assert main_mod.main(["--help"]) == 0
    assert main_mod.main(["--bogus"]) == 2
    out, err = capfd.readouterr()
    assert out == ""
    assert "usage:" in err


def test_logging_goes_to_file(main_mod, monkeypatch, tmp_path, capfd):
    _no_tailscale(monkeypatch)
    main_mod.main([])
    log = (tmp_path / "airbridge.log").read_text(encoding="utf-8")
    assert "Tailscale unavailable" in log


def test_config_load_reads_env_at_call_time(monkeypatch, tmp_path):
    from airbridge_app import config

    monkeypatch.setenv("AIRBRIDGE_INBOX_DIR", str(tmp_path / "a"))
    monkeypatch.setenv("AIRBRIDGE_SECRET", "s3cret")
    s = config.load()
    assert s.inbox_dir == tmp_path / "a"
    assert s.shared_secret == "s3cret"
    assert s.port == config.PORT == 8989
    assert "s3cret" not in repr(s)
    monkeypatch.delenv("AIRBRIDGE_SECRET")
    monkeypatch.delenv("AIRBRIDGE_INBOX_DIR")
    monkeypatch.delenv("AIRBRIDGE_LOG_FILE", raising=False)
    s2 = config.load()
    assert s2.shared_secret is None
    assert s2.inbox_dir == Path.home() / "Desktop" / "AirBridge_Inbox"
    assert s2.log_file == AIRBRIDGE_DIR / "airbridge.log"
    with pytest.raises(Exception):
        s2.port = 1  # frozen


def test_configure_logging_strips_stream_handlers(tmp_path):
    import logging

    from airbridge_app.logging_setup import configure_logging

    root = logging.getLogger()
    saved = list(root.handlers)
    uv = logging.getLogger("uvicorn.error")
    uv_saved = (list(uv.handlers), uv.propagate)
    try:
        root.addHandler(logging.StreamHandler(sys.stdout))
        uv.addHandler(logging.StreamHandler(sys.stderr))
        configure_logging(tmp_path / "x.log")
        for lg in (root, uv, logging.getLogger("mcp"), logging.getLogger("fastapi")):
            assert lg.handlers, lg.name
            assert all(isinstance(h, logging.FileHandler) for h in lg.handlers), lg.name
        assert uv.propagate is False
        logging.getLogger("uvicorn.error").error("hello-file")
        for h in uv.handlers:
            h.flush()
        assert "hello-file" in (tmp_path / "x.log").read_text(encoding="utf-8")
    finally:
        for h in list(root.handlers):
            root.removeHandler(h)
        for h in saved:
            root.addHandler(h)
        uv.handlers[:] = uv_saved[0]
        uv.propagate = uv_saved[1]


# ------------------------------------------------------------------ real process
def test_subprocess_from_other_cwd_without_tailscale(tmp_path):
    """`python /abs/main.py` from an unrelated cwd: exit 2, empty stdout, clear stderr."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("AIRBRIDGE_")}
    env["PATH"] = str(tmp_path)  # no tailscale here
    env["AIRBRIDGE_LOG_FILE"] = str(tmp_path / "log.txt")
    proc = subprocess.run(
        [sys.executable, str(MAIN_PY)],
        cwd=str(tmp_path),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        stdin=subprocess.DEVNULL,
    )
    if any(os.path.isfile(p) for p in network.FALLBACK_BINARIES):  # pragma: no cover
        pytest.skip("a real Tailscale install is present on this machine")
    assert proc.returncode == 2, proc.stderr
    assert proc.stdout == ""
    assert "Tailscale" in proc.stderr


@pytest.mark.skipif(sys.platform == "win32", reason="fake tailscale is a POSIX shell script")
def test_subprocess_mcp_handshake_with_fake_tailscale(tmp_path):
    """End to end: real inbox/outbox, fake tailscale CLI; stdout must be pure JSON-RPC."""
    try:
        import airbridge_app.inbox  # noqa: F401
        import airbridge_app.outbox  # noqa: F401
        import airbridge_app.security  # noqa: F401
    except Exception as exc:  # pragma: no cover - sibling modules not ready
        pytest.skip(f"sibling modules unavailable: {exc}")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake = bindir / "tailscale"
    status = json.dumps({"BackendState": "Running", "Self": {"TailscaleIPs": ["100.101.102.103"]}, "Peer": {}})
    fake.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "ip" ]; then echo 100.101.102.103; exit 0; fi\n'
        f"echo '{status}'\n",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith("AIRBRIDGE_")}
    env["PATH"] = f"{bindir}{os.pathsep}/usr/bin{os.pathsep}/bin"
    env["AIRBRIDGE_LOG_FILE"] = str(tmp_path / "log.txt")
    env["AIRBRIDGE_INBOX_DIR"] = str(tmp_path / "inbox")
    msgs = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "pytest", "version": "0"},
            },
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    proc = subprocess.Popen(
        [sys.executable, str(MAIN_PY)],
        cwd=str(tmp_path),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    import threading

    watchdog = threading.Timer(60, proc.kill)  # never hang the suite
    watchdog.start()
    parsed = []
    try:
        for m in msgs:
            proc.stdin.write(json.dumps(m) + "\n")
            proc.stdin.flush()
            if "id" in m:
                line = proc.stdout.readline()  # every stdout line must be JSON-RPC
                parsed.append(json.loads(line))
        proc.stdin.close()  # EOF -> MCP ends -> inbox shut down -> exit 0
        rest, err = proc.communicate(timeout=30)
    finally:
        watchdog.cancel()
        if proc.poll() is None:  # pragma: no cover
            proc.kill()
            proc.communicate()
    assert rest.strip() == "", rest
    assert all(p.get("jsonrpc") == "2.0" for p in parsed), parsed
    by_id = {p.get("id"): p for p in parsed}
    assert by_id[1]["result"]["serverInfo"]["name"] == "airbridge", err
    names = sorted(t["name"] for t in by_id[2]["result"]["tools"])
    assert names == ["list_airbridge_nodes", "send_task_to_node"]
    assert proc.returncode == 0, err


def test_self_test_passes_with_empty_stdout(tmp_path):
    """--self-test (CI startup smoke test of the frozen binary) imports and starts everything."""
    env = dict(os.environ, AIRBRIDGE_LOG_FILE=str(tmp_path / "ab.log"), AIRBRIDGE_DATA_DIR=str(tmp_path / "data"))
    env.pop("AIRBRIDGE_CONTROL_TOKEN", None)
    proc = subprocess.run([sys.executable, str(MAIN_PY), "--self-test"], cwd=str(tmp_path), env=env,
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == ""
    assert "self-test: PASSED" in proc.stderr
    assert "cryptography AES-GCM" in proc.stderr
    assert "/status ok" in proc.stderr


def test_self_test_reports_import_failure(main_mod, monkeypatch, capfd):
    from airbridge_app import selftest

    monkeypatch.setattr(selftest, "RUNTIME_MODULES", ("airbridge_no_such_module_xyz",))
    assert selftest.run_self_test(main_mod._mod("config").load()) == 1
    err = capfd.readouterr().err
    assert "FAIL import airbridge_no_such_module_xyz" in err and "FAILED" in err


def test_self_test_cannot_combine(main_mod, capfd):
    assert main_mod.main(["--self-test", "--daemon"]) == 2
