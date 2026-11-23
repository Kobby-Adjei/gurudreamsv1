"""Local control API for the AirBridge Pro desktop app (daemon mode only).

Binds IPv6 loopback ``::1`` (fallback ``127.0.0.1`` only where the host has
no IPv6 loopback). Phase 3 (PHASE3_SECURITY.md F-1): the embedded tailscaled's
netstack forwards inbound tailnet connections for ANY port to
``127.0.0.1:<port>`` - never to ``::1`` - so a ``::1`` listener is unreachable
from the tailnet regardless of the ACL. Every HTTP request and WebSocket
handshake must:

1. carry no ``Origin`` header (browsers always send one; the Electron main
   process does not)                                   -> 403 / WS close 4403
2. have ``Host`` exactly ``[::1]:<port>`` (or ``127.0.0.1:<port>`` on the
   IPv4 fallback; anti DNS-rebinding)
                                                       -> 403 / WS close 4403
3. present ``Authorization: Bearer <token>`` matching the per-launch token
   (``hmac.compare_digest``)                           -> 401 / WS close 4401

Endpoints: ``GET /status``, ``GET /nodes``, ``GET /events``,
``WS /events/stream``, ``POST /send_task``. See docs/PHASE2_PLAN.md section 2.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import hmac
import ipaddress
import json
import logging
import socket
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError

from . import __version__, config, events, network, outbox, security

logger = logging.getLogger("airbridge.control")

CONTROL_HOST = "::1"  # preferred: not reachable through tailscaled's netstack forwarding
CONTROL_HOST_V4 = "127.0.0.1"  # fallback when the host has no IPv6 loopback
WS_CLOSE_UNAUTHORIZED = 4401
WS_CLOSE_FORBIDDEN = 4403
MAX_SEND_BODY_BYTES = security.MAX_BODY_BYTES + 4096
# EAFNOSUPPORT / EADDRNOTAVAIL (POSIX + WinSock): no IPv6 loopback on this host.
_NO_IPV6_ERRNOS = {errno.EAFNOSUPPORT, errno.EADDRNOTAVAIL, errno.EPROTONOSUPPORT,
                   10047, 10049, 10043}


# --------------------------------------------------------------------------- #
# Daemon state shared with the control API
# --------------------------------------------------------------------------- #
@dataclass
class DaemonState:
    tailnet_ip: str | None = None
    inbox_listening: bool = False
    inbox_port: int = config.PORT
    degraded_reason: str | None = None
    started_monotonic: float = field(default_factory=time.monotonic)

    def status(self) -> dict[str, Any]:
        return {
            "version": __version__,
            "mode": "daemon",
            "tailnet_ip": self.tailnet_ip,
            "inbox": {
                "listening": bool(self.inbox_listening),
                "port": self.inbox_port,
                "degraded_reason": self.degraded_reason,
            },
            "uptime_s": round(max(0.0, time.monotonic() - self.started_monotonic), 1),
        }


# --------------------------------------------------------------------------- #
# Node snapshot (online and offline peers, with OS / last seen)
# --------------------------------------------------------------------------- #
def _local_os() -> str:
    if sys.platform == "darwin":
        return "macOS"
    if sys.platform.startswith("win"):
        return "windows"
    return "linux"


def _fallback_self() -> dict[str, Any]:
    return {"hostname": events.local_node_name(), "ip": None, "os": _local_os()}


def nodes_snapshot() -> dict[str, Any]:
    """``GET /nodes`` body via the selected backend's ``peer_details()``.
    Never raises: network problems land in ``error`` (``self`` is then this
    machine's hostname with ``ip: null``)."""
    try:
        details = network.peer_details()
    except network.TailscaleError as exc:
        return {"self": _fallback_self(), "nodes": [], "error": str(exc)[:200]}
    except Exception as exc:
        logger.exception("unexpected error reading network status")
        return {"self": _fallback_self(), "nodes": [], "error": f"unexpected error: {type(exc).__name__}"}
    return {"self": details.get("self") or _fallback_self(), "nodes": list(details.get("nodes") or []),
            "error": None}


# --------------------------------------------------------------------------- #
# Guard middleware (pure ASGI: covers HTTP and WebSocket alike)
# --------------------------------------------------------------------------- #
def _header(scope: dict[str, Any], name: bytes) -> bytes | None:
    for key, value in scope.get("headers") or []:
        if key.lower() == name:
            return value
    return None


def _is_loopback(scope: dict[str, Any]) -> bool:
    client = scope.get("client")
    if not client:
        return False
    try:
        return ipaddress.ip_address(client[0]).is_loopback
    except ValueError:
        return False


class ControlGuard:
    """Rejects requests with an Origin, a wrong Host, or a bad bearer token."""

    def __init__(self, app: Any, *, token: str, port_getter: Callable[[], int], host: str = CONTROL_HOST_V4) -> None:
        self.app = app
        self._token = ("Bearer " + token).encode("utf-8")
        self._port_getter = port_getter
        self._host = f"[{host}]" if ":" in host else host

    def _verdict(self, scope: dict[str, Any]) -> tuple[int, str] | None:
        if not _is_loopback(scope):
            return 403, "forbidden: loopback only"
        if _header(scope, b"origin") is not None:
            return 403, "forbidden: browser origins are not allowed"
        expected_host = f"{self._host}:{self._port_getter()}".encode("ascii")
        if _header(scope, b"host") != expected_host:
            return 403, "forbidden: bad host"
        provided = _header(scope, b"authorization") or b""
        if not hmac.compare_digest(provided, self._token):
            return 401, "unauthorized"
        return None

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        kind = scope.get("type")
        if kind not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        verdict = self._verdict(scope)
        if verdict is None:
            await self.app(scope, receive, send)
            return
        status, detail = verdict
        logger.warning("control API rejected %s %s: %s", kind, scope.get("path"), detail)
        if kind == "http":
            body = json.dumps({"ok": False, "error": detail}).encode("utf-8")
            headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
            if status == 401:
                headers.append((b"www-authenticate", b"Bearer"))
            await send({"type": "http.response.start", "status": status, "headers": headers})
            await send({"type": "http.response.body", "body": body})
            return
        # WebSocket: accept then close with an application code so the client
        # can tell "bad auth" (4401) from "forbidden" (4403).
        message = await receive()
        if message.get("type") != "websocket.connect":
            return
        await send({"type": "websocket.accept"})
        code = WS_CLOSE_UNAUTHORIZED if status == 401 else WS_CLOSE_FORBIDDEN
        await send({"type": "websocket.close", "code": code, "reason": detail})


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
class SendTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_hostname: str
    task_description: str
    code_payload: str | None = None


def _json(status: int, content: dict[str, Any]) -> JSONResponse:
    return JSONResponse(status_code=status, content=content, headers={"Cache-Control": "no-store"})


def create_control_app(
    *,
    token: str,
    port_getter: Callable[[], int],
    state: DaemonState,
    settings: config.Settings,
    nodes_provider: Callable[[], dict[str, Any]] = nodes_snapshot,
    host: str = CONTROL_HOST_V4,
) -> Any:
    """Build the guarded control ASGI app. ``host`` is the bound loopback
    address (:func:`bound_host`); the Host header must name it exactly."""
    if host not in (CONTROL_HOST, CONTROL_HOST_V4):
        raise ValueError("control host must be a loopback literal")
    if not isinstance(token, str) or len(token) < 32:
        raise ValueError("control token too short")
    app = FastAPI(
        title="AirBridge Control",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        swagger_ui_oauth2_redirect_url=None,
    )
    app.state.daemon_state = state

    @app.get("/status")
    async def status() -> JSONResponse:
        return _json(200, state.status())

    @app.get("/nodes")
    async def nodes() -> JSONResponse:
        return _json(200, await asyncio.to_thread(nodes_provider))

    @app.get("/events")
    async def list_events(limit: int = 100, after_id: str | None = None) -> JSONResponse:
        limit = max(1, min(limit, 1000))
        if after_id is not None and len(after_id) > 64:
            return _json(400, {"ok": False, "error": "after_id too long"})
        items = await asyncio.to_thread(events.read_recent, limit, after_id or None)
        return _json(200, {"events": items})

    @app.websocket("/events/stream")
    async def stream(ws: WebSocket) -> None:
        await ws.accept()

        async def _drain_client() -> None:
            with contextlib.suppress(WebSocketDisconnect, RuntimeError):
                while True:
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return

        async def _pump() -> None:
            async for ev in events.tail():
                await ws.send_text(json.dumps(ev, separators=(",", ":")))

        reader = asyncio.create_task(_drain_client())
        pump = asyncio.create_task(_pump())
        try:
            await asyncio.wait({reader, pump}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in (reader, pump):
                t.cancel()
            for t in (reader, pump):
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t
            with contextlib.suppress(Exception):
                await ws.close()

    @app.post("/send_task")
    async def send_task(request: Request) -> JSONResponse:
        declared = request.headers.get("content-length")
        if declared is not None:
            try:
                if int(declared) > MAX_SEND_BODY_BYTES:
                    return _json(413, {"ok": False, "error": "payload too large"})
            except ValueError:
                return _json(400, {"ok": False, "error": "invalid Content-Length"})
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_SEND_BODY_BYTES:
                return _json(413, {"ok": False, "error": "payload too large"})
        try:
            req = SendTaskRequest.model_validate_json(bytes(body))
        except ValidationError:
            return _json(400, {"ok": False, "error": "invalid request: expected target_hostname, task_description, code_payload?"})
        result = await outbox.send_task_result(
            settings, req.target_hostname, req.task_description, req.code_payload, origin="daemon"
        )
        if result.get("ok"):
            return _json(200, {"ok": True, "file": result.get("file"), "target": result.get("target")})
        code = int(result.get("status") or 502)
        if not (400 <= code < 500 or code == 502):
            code = 502
        return _json(code, {"ok": False, "error": result.get("error") or "send failed"})

    return ControlGuard(app, token=token, port_getter=port_getter, host=host)


def _bind_loopback(family: socket.AddressFamily, host: str, port: int) -> socket.socket:
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows: no port hijacking
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        if family == socket.AF_INET6 and hasattr(socket, "IPV6_V6ONLY"):
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        sock.bind((host, int(port)))
        sock.listen(128)
        sock.setblocking(False)
    except BaseException:
        sock.close()
        raise
    return sock


def bind_control_socket(port: int = 0) -> socket.socket:
    """Bind a listening TCP socket on ``[::1]`` (port 0 = ephemeral), falling
    back to ``127.0.0.1`` only when the host has no IPv6 loopback at all.
    A busy *port* on ``::1`` is an error, never a reason to fall back."""
    if socket.has_ipv6:
        try:
            return _bind_loopback(socket.AF_INET6, CONTROL_HOST, port)
        except OSError as exc:
            if exc.errno not in _NO_IPV6_ERRNOS:
                raise
    logger.warning("IPv6 loopback unavailable; control API falls back to %s", CONTROL_HOST_V4)
    return _bind_loopback(socket.AF_INET, CONTROL_HOST_V4, port)


def bound_host(sock: socket.socket) -> str:
    """The loopback literal *sock* is bound to (``::1`` or ``127.0.0.1``)."""
    return CONTROL_HOST if sock.family == socket.AF_INET6 else CONTROL_HOST_V4


def build_control_server(app: Any) -> uvicorn.Server:
    """uvicorn server for *app*; served via ``server.serve(sockets=[sock])``."""
    cfg = uvicorn.Config(
        app,
        log_config=None,
        access_log=False,
        server_header=False,
        date_header=False,
        ws="websockets-sansio",
        ws_max_size=64 * 1024,
        lifespan="off",
    )
    return uvicorn.Server(cfg)


__all__ = [
    "CONTROL_HOST",
    "CONTROL_HOST_V4",
    "bound_host",
    "ControlGuard",
    "DaemonState",
    "bind_control_socket",
    "build_control_server",
    "create_control_app",
    "nodes_snapshot",
]
