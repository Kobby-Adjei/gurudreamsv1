"""CI startup smoke test for a frozen airbridge-core and the packaged desktop app.

    python airbridge/ci_smoke.py core <path/to/airbridge-core[.exe]>
    python airbridge/ci_smoke.py app  <path/to/packaged app executable> [--soft-no-output]

``core``: runs ``--self-test`` (imports and starts everything), then runs
``--daemon`` exactly like the desktop app does (control token, ephemeral port,
parent-PID watchdog), waits for ``AIRBRIDGE_READY``, fetches ``/status`` from the
control API and stops it. Fails on ``missing dependency``, an early exit, or no
READY within the timeout.

``app``: launches the packaged Electron app (preview build: no sign-in needed,
the daemon starts once the window has loaded) and watches its main-process log
for ``backend: engine: AIRBRIDGE_READY``. Fails on ``missing dependency``,
``engine exited unexpectedly`` or a restart loop. ``--soft-no-output``: if the app
produced no log output at all (GUI-subsystem stderr on Windows), only warn.

Standard library only; output goes to this script's stdout (CI log).
"""

from __future__ import annotations

import http.client
import json
import os
import queue
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time

READY_TIMEOUT_S = 120.0  # onefile unpacks itself on first start; slow CI disks
APP_TIMEOUT_S = 150.0
BAD_MARKERS = ("missing dependency", "exited unexpectedly", "Restarting in", "Symbol not found",
               "ImportError", "ModuleNotFoundError", "self-test crashed")


def fail(msg: str) -> None:
    print(f"SMOKE FAIL: {msg}", flush=True)
    sys.exit(1)


def _reader(stream, q: "queue.Queue[str | None]") -> None:
    for raw in iter(stream.readline, b""):
        q.put(raw.decode("utf-8", "replace").rstrip("\r\n"))
    q.put(None)


def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        if os.name != "nt":
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
        proc.kill()
        proc.wait(timeout=15)


def _popen(cmd: list[str], env: dict[str, str]) -> subprocess.Popen:
    kw: dict = {}
    if os.name == "nt":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    return subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=env, **kw)


def _base_env(tmp: str) -> dict[str, str]:
    env = dict(os.environ)
    for k in list(env):
        if k.startswith("AIRBRIDGE_") or k == "ELECTRON_RUN_AS_NODE":
            env.pop(k)
    env["AIRBRIDGE_DATA_DIR"] = os.path.join(tmp, "data")
    env["AIRBRIDGE_LOG_FILE"] = os.path.join(tmp, "airbridge.log")
    env["AIRBRIDGE_INBOX_DIR"] = os.path.join(tmp, "inbox")
    return env


def _status(host: str, port: int, token: str) -> dict:
    conn = http.client.HTTPConnection(host, port, timeout=10)
    try:
        conn.putrequest("GET", "/status", skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", f"[{host}]:{port}" if ":" in host else f"{host}:{port}")
        conn.putheader("Authorization", f"Bearer {token}")
        conn.endheaders()
        resp = conn.getresponse()
        body = resp.read()
        if resp.status != 200:
            fail(f"/status answered HTTP {resp.status}: {body[:200]!r}")
        return json.loads(body)
    finally:
        conn.close()


def smoke_core(binary: str) -> None:
    with tempfile.TemporaryDirectory(prefix="ab-smoke-") as tmp:
        env = _base_env(tmp)
        print(f"== {binary} --self-test", flush=True)
        t0 = time.monotonic()
        proc = subprocess.run([binary, "--self-test"], stdin=subprocess.DEVNULL, capture_output=True,
                              env=env, timeout=300)
        err = proc.stderr.decode("utf-8", "replace")
        print(err, flush=True)
        if proc.stdout:
            fail(f"--self-test wrote to stdout: {proc.stdout[:200]!r}")
        if proc.returncode != 0 or "self-test: PASSED" not in err:
            fail(f"--self-test exited {proc.returncode}")
        print(f"   --self-test passed in {time.monotonic() - t0:.1f}s", flush=True)

        print(f"== {binary} --daemon (as launched by the app)", flush=True)
        token = secrets.token_urlsafe(32)
        denv = dict(env, AIRBRIDGE_CONTROL_TOKEN=token, AIRBRIDGE_CONTROL_PORT="0",
                    AIRBRIDGE_PARENT_PID=str(os.getpid()))
        proc = _popen([binary, "--daemon"], denv)
        q: "queue.Queue[str | None]" = queue.Queue()
        threading.Thread(target=_reader, args=(proc.stdout, q), daemon=True).start()
        lines: list[str] = []
        ready = None
        deadline = time.monotonic() + READY_TIMEOUT_S
        try:
            while ready is None:
                left = deadline - time.monotonic()
                if left <= 0:
                    fail("daemon did not print AIRBRIDGE_READY within %.0fs:\n%s" % (READY_TIMEOUT_S, "\n".join(lines)))
                try:
                    line = q.get(timeout=min(left, 1.0))
                except queue.Empty:
                    continue
                if line is None:
                    fail(f"daemon exited (code {proc.wait()}) before READY:\n" + "\n".join(lines))
                lines.append(line)
                print(f"   daemon: {line}", flush=True)
                if any(m in line for m in BAD_MARKERS):
                    fail(f"daemon reported: {line}")
                if line.startswith("AIRBRIDGE_READY "):
                    ready = json.loads(line.split(" ", 1)[1])
            status = _status(ready.get("control_host", "::1"), int(ready["control_port"]), token)
            print(f"   /status: {json.dumps(status)[:300]}", flush=True)
            # Let the inbox supervisor and node watcher run a little; nothing may crash.
            end = time.monotonic() + 5
            while time.monotonic() < end:
                try:
                    line = q.get(timeout=0.5)
                except queue.Empty:
                    continue
                if line is None:
                    fail(f"daemon exited (code {proc.wait()}) after READY:\n" + "\n".join(lines))
                print(f"   daemon: {line}", flush=True)
                if any(m in line for m in BAD_MARKERS):
                    fail(f"daemon reported: {line}")
            if proc.poll() is not None:
                fail(f"daemon exited (code {proc.returncode}) after READY")
        finally:
            _kill_tree(proc)
        print("   daemon OK", flush=True)


def smoke_app(app: str, soft_no_output: bool) -> None:
    with tempfile.TemporaryDirectory(prefix="ab-app-") as tmp:
        env = _base_env(tmp)
        env.pop("AIRBRIDGE_DEV_MOCKS", None)
        print(f"== launch {app}", flush=True)
        proc = _popen([app], env)
        q: "queue.Queue[str | None]" = queue.Queue()
        threading.Thread(target=_reader, args=(proc.stdout, q), daemon=True).start()
        lines: list[str] = []
        ok = False
        deadline = time.monotonic() + APP_TIMEOUT_S
        try:
            while not ok and time.monotonic() < deadline:
                try:
                    line = q.get(timeout=1.0)
                except queue.Empty:
                    continue
                if line is None:
                    fail(f"app exited (code {proc.wait()}) before the engine was ready:\n" + "\n".join(lines))
                lines.append(line)
                if "[airbridge]" in line:
                    print(f"   {line}", flush=True)
                if "[airbridge]" in line and any(m in line for m in BAD_MARKERS):
                    fail(f"app log: {line}")
                if "engine: AIRBRIDGE_READY" in line:
                    ok = True
            if ok:
                # Keep watching ~20s for a crash loop after READY.
                end = time.monotonic() + 20
                while time.monotonic() < end:
                    try:
                        line = q.get(timeout=1.0)
                    except queue.Empty:
                        continue
                    if line is None:
                        break
                    if "[airbridge]" in line:
                        print(f"   {line}", flush=True)
                        if any(m in line for m in BAD_MARKERS):
                            fail(f"app log: {line}")
        finally:
            _kill_tree(proc)
        if ok:
            print("   app started the engine OK", flush=True)
            return
        if not any("[airbridge]" in l for l in lines) and soft_no_output:
            print("::warning::packaged app produced no main-process log output; launch check skipped", flush=True)
            return
        fail("app did not report engine READY within %.0fs; last output:\n%s" % (APP_TIMEOUT_S, "\n".join(lines[-60:])))


def main() -> None:
    if len(sys.argv) < 3 or sys.argv[1] not in ("core", "app"):
        print(__doc__)
        sys.exit(2)
    target = sys.argv[2]
    if not os.path.isfile(target):
        fail(f"not a file: {target}")
    if sys.argv[1] == "core":
        smoke_core(target)
    else:
        smoke_app(target, "--soft-no-output" in sys.argv[3:])
    print("SMOKE OK", flush=True)


if __name__ == "__main__":
    main()
