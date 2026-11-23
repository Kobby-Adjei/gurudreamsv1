"""Local control API for the AirBridge Pro desktop app (daemon mode only).

Binds ``127.0.0.1`` only. Every HTTP request and WebSocket handshake must:

1. carry no ``Origin`` header (browsers always send one; the Electron main
   process does not)                                   -> 403 / WS close 4403
2. have ``Host`` exactly ``127.0.0.1:<port>`` (anti DNS-rebinding)
                                                       -> 403 / WS close 4403
3. present ``Authorization: Bearer <token>`` matching the per-launch token
   (``hmac.compare_digest``)                           -> 401 / WS close 4401

Endpoints: ``GET /status``, ``GET /nodes``, ``GET /events``,
``WS /events/stream``, ``POST /send_task``. See docs/PHASE2_PLAN.md section 2.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import ipaddress
import json
import logging
import socket
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

CONTROL_HOST = "127.0.0.1"
WS_CLOSE_UNAUTHORIZED = 4401
WS_CLOSE_FORBIDDEN = 4403
MAX_SEND_BODY_BYTES = security.MAX_BODY_BYTES + 4096
_ZERO_TIME_PREFIX = "0001-01-01"


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
def _first_ipv4(ips: Any) -> str | None:
    if not isinstance(ips, list):
        return None
    for ip in ips:
        if isinstance(ip, str) and security.is_tailnet_ip(ip):
            try:
                if ipaddress.ip_address(ip.strip()).version == 4:
                    return ip.strip()
            except ValueError:
                continue
    return None


def _node_name(entry: dict[str, Any]) -> str | None:
    host = entry.get("HostName")
    if isinstance(host, str) and host.strip():
        return host.strip()[:64]
    dns = entry.get("DNSName")
    if isinstance(dns, str) and dns.strip():
        return dns.strip().rstrip(".").split(".", 1)[0][:64] or None
    return None


def _str_or_none(value: Any, limit: int = 64) -> str | None:
    return value.strip()[:limit] if isinstance(value, str) and value.strip() else None


def nodes_snapshot() -> dict[str, Any]:
    """``GET /nodes`` body. Never raises: Tailscale problems land in ``error``."""
    try:
        data = network._status_json()
    except network.TailscaleError as exc:
        return {"self": None, "nodes": [], "error": str(exc)[:200]}
    except Exception as exc:
        logger.exception("unexpected error reading tailscale status")
        return {"self": None, "nodes": [], "error": f"unexpected error: {type(exc).__name__}"}

    self_entry = data.get("Self") if isinstance(data.get("Self"), dict) else {}
    self_ips = {ip for ip in self_entry.get("TailscaleIPs") or [] if isinstance(ip, str)}
    me = {
        "hostname": _node_name(self_entry) or events.local_node_name(),
        "ip": _first_ipv4(self_entry.get("TailscaleIPs")),
        "os": _str_or_none(self_entry.get("OS")),
    }
    nodes: list[dict[str, Any]] = []
    peers = data.get("Peer")
    if isinstance(peers, dict):
        for entry in peers.values():
            if not isinstance(entry, dict):
                continue
            name = _node_name(entry)
            ip = _first_ipv4(entry.get("TailscaleIPs"))
            if not name or not ip or ip in self_ips:
                continue
            online = entry.get("Online") is True
            last_seen = _str_or_none(entry.get("LastSeen"))
            if last_seen and last_seen.startswith(_ZERO_TIME_PREFIX):
                last_seen = None
            nodes.append(
                {
                    "hostname": name,
                    "ip": ip,
                    "os": _str_or_none(entry.get("OS")),
                    "online": online,
                    "last_seen": last_seen,
                }
            )
    nodes.sort(key=lambda n: (not n["online"], n["hostname"].lower()))
    return {"self": me, "nodes": nodes, "error": None}


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

    def __init__(self, app: Any, *, token: str, port_getter: Callable[[], int]) -> None:
        self.app = app
        self._token = ("Bearer " + token).encode("utf-8")
        self._port_getter = port_getter

    def _verdict(self, scope: dict[str, Any]) -> tuple[int, str] | None:
        if not _is_loopback(scope):
            return 403, "forbidden: loopback only"
        if _header(scope, b"origin") is not None:
            return 403, "forbidden: browser origins are not allowed"
        expected_host = f"{CONTROL_HOST}:{self._port_getter()}".encode("ascii")
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
) -> Any:
    """Build the guarded control ASGI app."""
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

    return ControlGuard(app, token=token, port_getter=port_getter)


def bind_control_socket(port: int = 0) -> socket.socket:
    """Bind a listening TCP socket on 127.0.0.1 (port 0 = ephemeral)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows: no port hijacking
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind((CONTROL_HOST, int(port)))
        sock.listen(128)
        sock.setblocking(False)
    except BaseException:
        sock.close()
        raise
    return sock


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
    "ControlGuard",
    "DaemonState",
    "bind_control_socket",
    "build_control_server",
    "create_control_app",
    "nodes_snapshot",
]
