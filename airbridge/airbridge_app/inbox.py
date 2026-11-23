"""AirBridge inbound HTTP server (the "inbox").

Receives tasks from other AirBridge nodes on the tailnet and stores each one as
a Markdown file in the local inbox directory.

Inbound checks run in a fixed order (see docs/PLAN.md section 3.2):

1. source IP must be a Tailscale address           -> 403
2. body size (declared and actual) <= MAX_BODY_BYTES -> 413
3. per-IP rate limit                                -> 429
4. shared secret, if one is configured              -> 401
5. payload validation                               -> 400
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

from . import config, formatting, network, notify, security

logger = logging.getLogger("airbridge.inbox")

_DIR_MODE = 0o700
_FILE_MODE = 0o600
_MAX_ERROR_DETAIL = 200


class TaskPayload(BaseModel):
    """JSON body accepted by ``POST /incoming_task``."""

    model_config = ConfigDict(extra="forbid")

    sender_node: str
    task_description: str
    code_payload: str | None = None

    @field_validator("sender_node")
    @classmethod
    def _check_sender(cls, value: str) -> str:
        return security.validate_sender(value)

    @field_validator("task_description")
    @classmethod
    def _check_task(cls, value: str) -> str:
        cleaned = security.validate_task_text(value, security.MAX_TASK_BYTES)
        if not cleaned.strip():
            raise ValueError("task_description must not be empty")
        return cleaned

    @field_validator("code_payload")
    @classmethod
    def _check_code(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return security.validate_task_text(value, security.MAX_CODE_BYTES)


def _error(status: int, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"status": "error", "detail": detail})


def _summarize_validation_error(exc: ValidationError) -> str:
    """Concise, payload-free description of what was wrong with the request."""
    parts: list[str] = []
    for err in exc.errors(include_url=False, include_input=False, include_context=False):
        loc = ".".join(str(p) for p in err.get("loc", ())) or "body"
        msg = str(err.get("msg", "invalid"))
        if msg.startswith("Value error, "):
            msg = msg[len("Value error, "):]
        parts.append(f"{loc}: {msg}")
    detail = "invalid payload: " + "; ".join(parts) if parts else "invalid payload"
    if len(detail) > _MAX_ERROR_DETAIL:
        detail = detail[: _MAX_ERROR_DETAIL - 3] + "..."
    return detail


def _ensure_private_dir(path: Path) -> None:
    path.mkdir(mode=_DIR_MODE, parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            os.chmod(path, _DIR_MODE)
        except OSError:
            logger.warning("could not set permissions on inbox directory %s", path)


def _write_task_file(inbox_dir: Path, received_at: datetime, content: str, lock: threading.Lock) -> Path:
    """Atomically write *content* to a fresh, safely named file in *inbox_dir*."""
    _ensure_private_dir(inbox_dir)
    data = content.encode("utf-8")
    fd, tmp_name = tempfile.mkstemp(dir=inbox_dir, prefix=".incoming_", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        if os.name != "nt":
            os.chmod(tmp_name, _FILE_MODE)
        # Choosing the name and moving the file into place must not interleave
        # with another request, or two tasks could claim the same name.
        with lock:
            target = security.safe_inbox_path(inbox_dir, received_at)
            os.replace(tmp_name, target)
        return target
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _notify_new_task(sender: str) -> None:
    try:
        notify.send_notification("AirBridge", f"New AirBridge Task received from {sender}")
    except Exception:  # notify must never break the request path
        logger.exception("notification failed")


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def create_app(
    settings: config.Settings,
    peers_provider: Callable[[], dict[str, str]] = network.get_airbridge_peers,
) -> FastAPI:
    """Build the inbox FastAPI application.

    ``peers_provider`` is kept for API compatibility and future use (verifying
    that the sender is a known peer); the required check is the tailnet range.
    """
    app = FastAPI(
        title="AirBridge Inbox",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        swagger_ui_oauth2_redirect_url=None,
    )
    limiter = security.RateLimiter(per_minute=settings.rate_limit_per_minute)
    write_lock = threading.Lock()
    inbox_dir = Path(settings.inbox_dir).expanduser()
    app.state.settings = settings
    app.state.peers_provider = peers_provider

    @app.get("/health")
    async def health(request: Request) -> JSONResponse:
        if not security.is_tailnet_ip(_client_ip(request)):
            return _error(403, "forbidden: not a tailnet address")
        return JSONResponse(status_code=200, content={"status": "ok"})

    @app.post("/incoming_task")
    async def incoming_task(request: Request, background_tasks: BackgroundTasks) -> JSONResponse:
        source_ip = _client_ip(request)

        # 1. Tailnet only.
        if not security.is_tailnet_ip(source_ip):
            logger.warning("rejected task from non-tailnet address %s", source_ip)
            return _error(403, "forbidden: not a tailnet address")

        # 2. Size: declared length first, then the bytes actually received.
        declared = request.headers.get("content-length")
        if declared is not None:
            try:
                declared_len = int(declared)
            except ValueError:
                return _error(400, "invalid Content-Length header")
            if declared_len > security.MAX_BODY_BYTES:
                logger.warning("rejected oversized task (%s bytes declared) from %s", declared_len, source_ip)
                return _error(413, f"payload too large (max {security.MAX_BODY_BYTES} bytes)")
        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > security.MAX_BODY_BYTES:
                logger.warning("rejected oversized task (>%s bytes) from %s", security.MAX_BODY_BYTES, source_ip)
                return _error(413, f"payload too large (max {security.MAX_BODY_BYTES} bytes)")
            chunks.append(chunk)
        body = b"".join(chunks)

        # 3. Rate limit per source IP.
        if not limiter.allow(source_ip):
            logger.warning("rate limit exceeded for %s", source_ip)
            return _error(429, "too many requests, slow down")

        # 4. Shared secret (only when configured).
        expected = settings.shared_secret
        if expected is not None:
            provided = request.headers.get(config.SECRET_HEADER) or ""
            if not security.check_secret(provided, expected):
                logger.warning("rejected task with bad or missing shared secret from %s", source_ip)
                return _error(401, "unauthorized: missing or wrong shared secret")

        # 5. Validation.
        try:
            payload = TaskPayload.model_validate_json(body)
        except ValidationError as exc:
            detail = _summarize_validation_error(exc)
            logger.warning("rejected invalid task from %s: %s", source_ip, detail)
            return _error(400, detail)

        received_at = datetime.now().astimezone()
        try:
            content = formatting.render_task_markdown(payload, received_at, source_ip)
            path = await run_in_threadpool(_write_task_file, inbox_dir, received_at, content, write_lock)
        except Exception:
            logger.exception("failed to store task from %s", source_ip)
            return _error(500, "could not store task")

        logger.info(
            "stored task from %s (%s) as %s: %s",
            payload.sender_node,
            source_ip,
            path.name,
            security.truncate_for_log(payload.task_description, 200),
        )
        background_tasks.add_task(_notify_new_task, payload.sender_node)
        return JSONResponse(status_code=201, content={"status": "ok", "file": path.name})

    return app


def build_server(app: FastAPI, host: str, port: int) -> uvicorn.Server:
    """Wrap *app* in a uvicorn server that never writes to stdout."""
    cfg = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_config=None,
        access_log=False,
        server_header=False,
        date_header=False,
    )
    return uvicorn.Server(cfg)


__all__ = ["TaskPayload", "build_server", "create_app"]

