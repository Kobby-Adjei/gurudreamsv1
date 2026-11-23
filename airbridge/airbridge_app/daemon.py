"""AirBridge daemon mode (``airbridge-core --daemon``), supervised by the desktop app.

Runs concurrently:

* the inbox (tailnet HTTP on :8989) - started when Tailscale is up and the
  port is free; otherwise the daemon stays up in a *degraded* state and
  retries every ``RETRY_S`` seconds;
* the control API on ``[::1]:<AIRBRIDGE_CONTROL_PORT>`` (IPv4 loopback only as a
  fallback; see control.py);
* a node watcher that diffs online peers every ``NODE_POLL_S`` seconds and
  emits ``node_online`` / ``node_offline``;
* a parent watchdog: exits when ``AIRBRIDGE_PARENT_PID`` disappears.

When the control API is listening, exactly one line is written to stderr::

    AIRBRIDGE_READY {"control_port":N,"pid":P,"control_host":"::1"|"127.0.0.1"}

Nothing is ever written to stdout.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
import sys
from typing import Any

from . import config, control, events, inbox, network, security

logger = logging.getLogger("airbridge.daemon")

READY_PREFIX = "AIRBRIDGE_READY"
NODE_POLL_S = 10.0
RETRY_S = 10.0
PARENT_POLL_S = 2.0
SHUTDOWN_GRACE_S = 5.0
STARTUP_TIMEOUT_S = 15.0
EMBEDDED_BIND_HOST = "127.0.0.1"


def _stderr(line: str) -> None:
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:  # pragma: no cover - stderr closed
        pass


def _disable_signal_capture(server: Any) -> None:
    with contextlib.suppress(Exception):
        server.capture_signals = contextlib.nullcontext
    with contextlib.suppress(Exception):
        server.install_signal_handlers = lambda *a, **k: None


# --------------------------------------------------------------------------- #
# Parent watchdog
# --------------------------------------------------------------------------- #
def pid_alive(pid: int) -> bool:
    """Best-effort liveness check for *pid* (no signals are delivered)."""
    if pid <= 0:
        return False
    if os.name == "nt":  # pragma: no cover - Windows only
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5  # access denied => exists
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


async def _watch_parent(parent_pid: int, stop: asyncio.Event) -> None:
    original_ppid = os.getppid() if os.name != "nt" else None
    while not stop.is_set():
        reparented = original_ppid is not None and original_ppid == parent_pid and os.getppid() != parent_pid
        if reparented or not pid_alive(parent_pid):
            logger.warning("parent process %s is gone; shutting down", parent_pid)
            stop.set()
            return
        with contextlib.suppress(asyncio.TimeoutError, TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=PARENT_POLL_S)


# --------------------------------------------------------------------------- #
# Node watcher
# --------------------------------------------------------------------------- #
async def _watch_nodes(stop: asyncio.Event, nodes_provider=None, interval: float = NODE_POLL_S) -> None:
    provider = nodes_provider or control.nodes_snapshot
    known: dict[str, bool] | None = None  # hostname -> online
    while not stop.is_set():
        try:
            snap = await asyncio.to_thread(provider)
            if not snap.get("error"):
                current = {n["hostname"]: bool(n.get("online")) for n in snap.get("nodes") or []}
                if known is not None:
                    for name, online in sorted(current.items()):
                        was = known.get(name)
                        if online and was is not True:
                            events.emit("node_online", peer=name, summary=f"{name} came online")
                        elif not online and was is True:
                            events.emit("node_offline", peer=name, summary=f"{name} went offline")
                    for name, was in sorted(known.items()):
                        if was and name not in current:
                            events.emit("node_offline", peer=name, summary=f"{name} went offline")
                known = current
        except Exception:
            logger.exception("node watcher iteration failed")
        with contextlib.suppress(asyncio.TimeoutError, TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)


# --------------------------------------------------------------------------- #
# Inbox supervisor
# --------------------------------------------------------------------------- #
async def _guarded_serve(server: Any, **kwargs: Any) -> str:
    """Run ``server.serve()``; uvicorn calls sys.exit() on bind failure, and a
    SystemExit escaping a task would tear down the whole event loop."""
    try:
        await server.serve(**kwargs)
        return "stopped"
    except SystemExit as exc:
        logger.error("server failed to start (exit %s)", exc.code)
        return "bind_failed"
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("server crashed")
        return "crashed"


class _InboxSupervisor:
    def __init__(self, settings: config.Settings, state: control.DaemonState, stop: asyncio.Event) -> None:
        self.settings = settings
        self.state = state
        self.stop = stop
        self.server: Any = None
        self.backend: Any = None
        self._last_reason: str | None = None

    def _degraded(self, reason: str) -> None:
        self.state.inbox_listening = False
        self.state.degraded_reason = reason
        if reason != self._last_reason:
            self._last_reason = reason
            logger.warning("inbox degraded: %s", reason)
            events.emit("inbox_degraded", summary=f"Inbox unavailable: {reason}", error=reason)

    async def _resolve_host(self) -> str | None:
        """Inbox bind host for the selected backend, or None (degraded).

        System Tailscale: this machine's tailnet IP (validate_bind_host).
        Embedded tailscaled: loopback only - its netstack forwards inbound
        tailnet connections for :8989 to 127.0.0.1:8989 and the inbox then
        authenticates every caller with LocalAPI whois.
        """
        try:
            backend = await asyncio.to_thread(network.get_backend)
        except network.TailscaleError as exc:
            self.state.tailnet_ip = None
            self.backend = None
            self._degraded(str(exc))
            return None
        self.backend = backend
        if getattr(backend, "kind", "system") == "embedded":
            return await self._resolve_embedded_host(backend)
        try:
            ip = await asyncio.to_thread(network.get_local_tailscale_ip)
        except network.TailscaleError as exc:
            self.state.tailnet_ip = None
            self._degraded(str(exc))
            return None
        try:
            host = security.validate_bind_host(ip)
        except ValueError as exc:
            self.state.tailnet_ip = None
            self._degraded(f"refusing to bind to {ip}: {exc}")
            return None
        self.state.tailnet_ip = host
        return host

    async def _resolve_embedded_host(self, backend: Any) -> str | None:
        try:
            ip = await asyncio.to_thread(backend.local_ip)
        except network.TailscaleError as exc:
            self.state.tailnet_ip = None
            self._degraded(str(exc))
            return None
        self.state.tailnet_ip = ip
        bind = backend.inbound_bind_host()
        if bind != EMBEDDED_BIND_HOST:  # never widen beyond loopback
            self._degraded(f"refusing to bind the inbox to {bind!r} in embedded mode")
            return None
        return EMBEDDED_BIND_HOST

    async def run(self) -> None:
        while not self.stop.is_set():
            host = await self._resolve_host()
            if host is not None:
                await self._serve_once(host)
            if self.stop.is_set():
                return
            with contextlib.suppress(asyncio.TimeoutError, TimeoutError):
                await asyncio.wait_for(self.stop.wait(), timeout=RETRY_S)

    async def _serve_once(self, host: str) -> None:
        port = self.settings.port
        backend = self.backend if getattr(self.backend, "kind", "system") == "embedded" else None
        app = inbox.create_app(self.settings, backend=backend)
        server = inbox.build_server(app, host, port)
        _disable_signal_capture(server)
        self.server = server
        serve_task = asyncio.create_task(_guarded_serve(server), name="airbridge-inbox")
        announced = False
        try:
            while not serve_task.done():
                if not announced and getattr(server, "started", False):
                    announced = True
                    self.state.inbox_listening = True
                    self.state.degraded_reason = None
                    self._last_reason = None
                    events.emit("inbox_listening", summary=f"Inbox listening on {host}:{port}")
                if self.stop.is_set():
                    server.should_exit = True
                await asyncio.wait({serve_task}, timeout=0.2)
            outcome = serve_task.result()
            if outcome == "bind_failed":
                self._degraded(f"port {port} on {host} is unavailable (in use?)")
            elif outcome == "crashed":
                self._degraded("inbox crashed (see log)")
            elif not self.stop.is_set():
                self._degraded("inbox stopped unexpectedly")
        finally:
            self.state.inbox_listening = False
            if not serve_task.done():
                server.should_exit = True
                try:
                    await asyncio.wait_for(asyncio.shield(serve_task), timeout=SHUTDOWN_GRACE_S)
                except (asyncio.TimeoutError, TimeoutError):
                    server.force_exit = True
                    serve_task.cancel()
                    with contextlib.suppress(BaseException):
                        await serve_task
                except BaseException:
                    serve_task.cancel()
            self.server = None


# --------------------------------------------------------------------------- #
# Main daemon coroutine
# --------------------------------------------------------------------------- #
def _install_signal_handlers(stop: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for name in ("SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError, ValueError):  # Windows
            with contextlib.suppress(Exception):
                signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))


async def run_daemon(
    settings: config.Settings,
    *,
    token: str,
    control_port: int = 0,
    parent_pid: int | None = None,
    stop: asyncio.Event | None = None,
    nodes_provider=None,
) -> int:
    """Run until signalled, the parent dies, or *stop* is set. Returns an exit code."""
    stop = stop or asyncio.Event()
    events.set_origin("daemon")
    state = control.DaemonState(inbox_port=settings.port)
    _install_signal_handlers(stop)

    try:
        sock = control.bind_control_socket(control_port)
    except OSError as exc:
        logger.error("cannot bind control API on %s:%s: %s", control.CONTROL_HOST, control_port, exc)
        _stderr(f"AirBridge: cannot bind control API on {control.CONTROL_HOST}:{control_port}: {exc}")
        return 1
    port = sock.getsockname()[1]
    host = control.bound_host(sock)
    app = control.create_control_app(
        token=token,
        port_getter=lambda: port,
        state=state,
        settings=settings,
        nodes_provider=nodes_provider or control.nodes_snapshot,
        host=host,
    )
    ctl_server = control.build_control_server(app)
    _disable_signal_capture(ctl_server)
    ctl_task = asyncio.create_task(_guarded_serve(ctl_server, sockets=[sock]), name="airbridge-control")

    loop = asyncio.get_running_loop()
    deadline = loop.time() + STARTUP_TIMEOUT_S
    while not getattr(ctl_server, "started", False):
        if ctl_task.done() or loop.time() > deadline:
            logger.error("control API failed to start")
            _stderr("AirBridge: control API failed to start")
            with contextlib.suppress(BaseException):
                ctl_task.cancel()
                await ctl_task
            sock.close()
            return 1
        await asyncio.sleep(0.02)

    events.emit("daemon_started", summary=f"AirBridge daemon started (v{state.status()['version']})")
    logger.info("control API listening on [%s]:%s (pid %s)", host, port, os.getpid())
    ready = {"control_port": port, "pid": os.getpid(), "control_host": host}
    _stderr(f"{READY_PREFIX} " + json.dumps(ready, separators=(",", ":")))

    supervisor = _InboxSupervisor(settings, state, stop)
    tasks = [
        asyncio.create_task(supervisor.run(), name="airbridge-inbox-supervisor"),
        asyncio.create_task(_watch_nodes(stop, nodes_provider), name="airbridge-node-watcher"),
    ]
    if parent_pid:
        tasks.append(asyncio.create_task(_watch_parent(parent_pid, stop), name="airbridge-parent-watchdog"))

    try:
        stop_wait = asyncio.create_task(stop.wait())
        await asyncio.wait({stop_wait, ctl_task}, return_when=asyncio.FIRST_COMPLETED)
        stop_wait.cancel()
        if ctl_task.done() and not stop.is_set():
            logger.error("control API stopped unexpectedly")
    finally:
        stop.set()
        events.emit("daemon_stopping", summary="AirBridge daemon stopping")
        ctl_server.should_exit = True
        pending = [t for t in tasks + [ctl_task] if not t.done()]
        if pending:
            done, still = await asyncio.wait(pending, timeout=SHUTDOWN_GRACE_S)
            for t in still:
                t.cancel()
            for t in still:
                with contextlib.suppress(BaseException):
                    await t
        with contextlib.suppress(Exception):
            sock.close()
    logger.info("daemon stopped")
    return 0


__all__ = ["READY_PREFIX", "pid_alive", "run_daemon"]
