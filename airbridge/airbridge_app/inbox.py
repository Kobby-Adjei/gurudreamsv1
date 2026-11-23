"""AirBridge inbound HTTP server (the "inbox").

Receives tasks from other AirBridge nodes on the tailnet and stores each one as
a Markdown file in the local inbox directory.

Inbound checks run in a fixed order (see docs/PLAN.md section 3.2):

1. source IP must be a Tailscale address           -> 403
2. body size (declared and actual) <= MAX_BODY_BYTES -> 413
3. per-IP rate limit                                -> 429
4. shared secret, if one is configured              -> 401
5. payload validation                               -> 400

Sidecar network (desktop app, PHASE3_PLAN.md §9): the ``airbridge-net``
sidecar (embedded tsnet) owns the private network. It identifies every mesh
connection with WhoIs, requires the same Headscale user, rate-limits per peer
and forwards to this inbox on ``127.0.0.1:<ephemeral>`` with
``X-AirBridge-Peer-Node`` / ``-IP`` / ``-User`` plus ``X-AirBridge-Sidecar-Ts`` and
``X-AirBridge-Sidecar-Sig``: an HMAC keyed with a per-daemon random token that
the daemon registered with the sidecar (the token itself is never sent; S-2).
Step 1 is then: loopback, a valid MAC over method/path/time/body/peer headers
within 60 s and never seen before (:class:`ForwardVerifier`), else 403 - only
then are the peer headers trusted. Steps 2-5 are unchanged (the rate limit is
keyed on the verified sender node).

Sender identity (sidecar): the payload's ``sender_node`` is self-asserted, so
after validation it is compared with the verified node name (control-assigned
name, ``airbridge-`` prefix stripped) and the payload value is REPLACED by the
verified name - that is what gets stored, logged and notified. A mismatch is
logged; with ``REJECT_SENDER_MISMATCH`` it is a 400 ``sender_mismatch``.
Matching is on a canonical form (NFKD, lowercase, ``airbridge-`` stripped,
ASCII alphanumerics only) and tolerates Headscale's global collision bump
(``macbook-pro`` vs verified ``macbook-pro-3``).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import tempfile
import threading
import time
import unicodedata
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

from . import config, events, formatting, network, notify, security

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


def _client_port(request: Request) -> int:
    return int(request.client.port) if request.client and request.client.port else 0


#: F-13. The stored/notified sender is ALWAYS the verified node name, and a self-asserted
#: ``sender_node`` that does not name the verified device is refused (400 sender_mismatch).
#: Enabled by Security after the sidecar switch (§9): the outbox now sends its own
#: control-assigned name (sidecar ``/status`` self.hostname = first label of Self.DNSName),
#: exactly what the receiving sidecar verifies with WhoIs (Node.Name), so legitimate
#: app-to-app tasks always match. See docs/PHASE3_SECURITY.md section 8.
REJECT_SENDER_MISMATCH = True

_CANON_DROP_RE = re.compile(r"[^a-z0-9]")


def _canonical_sender(name: str) -> str:
    n = unicodedata.normalize("NFKD", name)
    n = "".join(c for c in n if not unicodedata.combining(c)).lower()
    if n.startswith("airbridge-"):
        n = n[len("airbridge-"):]
    return _CANON_DROP_RE.sub("", n)


def sender_matches_verified(claimed: str, verified: str) -> bool:
    """True iff the self-asserted *claimed* sender names the whois-*verified* node.

    Equal canonical forms, or *verified* = *claimed* + a decimal suffix
    (Headscale bumps GivenName ``base``, ``base-1``, ``base-2``... globally on
    collision, headscale hscontrol/state/node_store.go resolveGivenName).
    """
    c, v = _canonical_sender(claimed), _canonical_sender(verified)
    if not c or not v:
        return False
    return v == c or (v.startswith(c) and v[len(c):].isdigit())


_LOOPBACK_HOSTS = ("127.0.0.1", "::1")
#: Allowed clock skew between the sidecar's signature timestamp and now (same machine).
FORWARD_WINDOW_S = 60
_FORWARD_DOMAIN = "AIRBRIDGE-FWD-1"
_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


def sign_forward(token: str, method: str, path: str, ts: str, body: bytes, node: str, ip: str, user: str) -> str:
    """HMAC-SHA256 (key = per-daemon inbox token) the sidecar puts in ``X-AirBridge-Sidecar-Sig``.

    Message: ``AIRBRIDGE-FWD-1\\n<METHOD>\\n<path>\\n<unix ts>\\n<hex sha256(body)>\\n<node>\\n<ip>\\n<user>``
    (byte-identical to ``signForward`` in desktop/sidecar/airbridge-net/mesh.go).
    """
    msg = "\n".join([_FORWARD_DOMAIN, method, path, ts, hashlib.sha256(body).hexdigest(), node, ip, user])
    return hmac.new(token.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


class ForwardVerifier:
    """Sidecar-mode step 1 (PHASE3_SECURITY.md S-2).

    The sidecar never sends the inbox token: every forwarded request carries a timestamp and an HMAC
    over method, path, timestamp, body hash and the verified peer headers. A process that squats a
    stale inbox port therefore receives nothing it can reuse, a local process without the token
    cannot forge a request, and a captured request cannot be replayed (60 s window + seen-signature
    cache). Only after the MAC checks out are the peer headers trusted.
    """

    MAX_SEEN = 10_000

    def __init__(self, token: str, clock: Callable[[], float] = time.time) -> None:
        self._token = token
        self._clock = clock
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    @staticmethod
    def precheck(headers: Any, client_host: str) -> str:
        """Cheap checks before the body is read: "" if plausible, else the 403 reason."""
        if client_host not in _LOOPBACK_HOSTS:
            return "forbidden: not_loopback"
        if not _HEX64_RE.match(headers.get(config.SIDECAR_SIG_HEADER) or "") or \
                not (headers.get(config.SIDECAR_TS_HEADER) or "").isdigit():
            return "forbidden: missing or invalid sidecar signature"
        return ""

    def verify(self, method: str, path: str, headers: Any, client_host: str, body: bytes) -> tuple[Any, str]:
        """-> ``(security.VerifiedPeer, "")`` or ``(None, reason)``."""
        reason = self.precheck(headers, client_host)
        if reason:
            return None, reason
        ts = headers.get(config.SIDECAR_TS_HEADER) or ""
        now = self._clock()
        if len(ts) > 12 or abs(now - int(ts)) > FORWARD_WINDOW_S:
            return None, "forbidden: stale sidecar signature"
        raw_node = headers.get(config.PEER_NODE_HEADER) or ""
        raw_ip = headers.get(config.PEER_IP_HEADER) or ""
        raw_user = headers.get(config.PEER_USER_HEADER) or ""
        sig = headers.get(config.SIDECAR_SIG_HEADER) or ""
        want = sign_forward(self._token, method, path, ts, body, raw_node, raw_ip, raw_user)
        if not self._token or not hmac.compare_digest(sig.encode("ascii"), want.encode("ascii")):
            return None, "forbidden: missing or invalid sidecar signature"
        with self._lock:
            for k in [k for k, exp in self._seen.items() if exp < now]:
                del self._seen[k]
            if sig in self._seen or len(self._seen) >= self.MAX_SEEN:
                return None, "forbidden: replayed sidecar signature"
            self._seen[sig] = now + 2 * FORWARD_WINDOW_S
        try:
            node = security.embedded_peer_node_name(raw_node)
        except security.SecurityError:
            return None, "forbidden: bad_peer"
        ip = raw_ip.strip() or None
        if ip is not None and not security.is_tailnet_ip(ip):
            return None, "forbidden: bad_peer"
        user_id = raw_user if raw_user.isdigit() and len(raw_user) <= 20 else ""
        return security.VerifiedPeer(node, user_id, ip, None), ""


def create_app(
    settings: config.Settings,
    peers_provider: Callable[[], dict[str, str]] = network.get_airbridge_peers,
    *,
    sidecar_token: str | None = None,
) -> FastAPI:
    """Build the inbox FastAPI application.

    ``peers_provider`` is kept for API compatibility and future use (verifying
    that the sender is a known peer); the required check is the tailnet range.
    ``sidecar_token``: set -> sidecar mode (loopback + sidecar token + verified
    peer headers); None (default) keeps the Phase-1 tailnet-source-IP check.
    """
    sidecar = sidecar_token is not None
    forward = ForwardVerifier(sidecar_token or "") if sidecar else None
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
        if forward is not None:
            peer, reason = forward.verify("GET", "/health", request.headers, _client_ip(request), b"")
            if peer is None:
                return _error(403, reason)
        elif not security.is_tailnet_ip(_client_ip(request)):
            return _error(403, "forbidden: not a tailnet address")
        return JSONResponse(status_code=200, content={"status": "ok"})

    @app.post("/incoming_task")
    async def incoming_task(request: Request, background_tasks: BackgroundTasks) -> JSONResponse:
        source_ip = _client_ip(request)
        limit_key = source_ip

        # 1. Tailnet only. Sidecar: loopback + a well-formed signature now; the HMAC itself is checked
        #    once the body is read (it covers the body), BEFORE any peer header is trusted or used.
        if forward is not None:
            detail = forward.precheck(request.headers, source_ip)
            if detail:
                logger.warning("rejected task from unverified local connection %s:%s (%s)",
                               source_ip, _client_port(request), detail)
                return _error(403, detail)
        elif not security.is_tailnet_ip(source_ip):
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
        # 3. Rate limit per source IP (before reading the body, so floods stay cheap). Sidecar mode
        #    rate-limits per verified node after the MAC check below (the sidecar already limits per peer).
        if forward is None and not limiter.allow(limit_key):
            logger.warning("rate limit exceeded for %s", source_ip)
            return _error(429, "too many requests, slow down")

        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > security.MAX_BODY_BYTES:
                logger.warning("rejected oversized task (>%s bytes) from %s", security.MAX_BODY_BYTES, source_ip)
                return _error(413, f"payload too large (max {security.MAX_BODY_BYTES} bytes)")
            chunks.append(chunk)
        body = b"".join(chunks)

        if forward is not None:
            peer, detail = forward.verify("POST", "/incoming_task", request.headers, source_ip, body)
            if peer is None:
                logger.warning("rejected task from unverified local connection %s:%s (%s)",
                               source_ip, _client_port(request), detail)
                return _error(403, detail)
            source_ip = peer.tailnet_ip or source_ip
            if not limiter.allow("node:" + str(peer.node)):
                logger.warning("rate limit exceeded for %s", peer)
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

        # 5b. Sidecar: the sender identity comes from the sidecar's WhoIs, never from the payload.
        if sidecar:
            verified = str(peer)
            if not sender_matches_verified(payload.sender_node, verified):
                if REJECT_SENDER_MISMATCH:
                    logger.warning("rejected task: sender_node %r does not match verified node %s (%s)",
                                   security.truncate_for_log(payload.sender_node, 64), verified, source_ip)
                    return _error(400, "sender_mismatch: sender_node does not match the verified sending device")
                logger.warning("sender_node %r does not match verified node %s (%s); using the verified name",
                               security.truncate_for_log(payload.sender_node, 64), verified, source_ip)
            payload = payload.model_copy(update={"sender_node": verified})

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
        what = "code" if payload.code_payload else "task"
        # Sync file I/O + cross-process lock: run after the response, in the threadpool.
        background_tasks.add_task(
            events.emit,
            "task_received",
            peer=payload.sender_node,
            summary=f"Received {what} from {payload.sender_node}",
            bytes=len(body),
            file=path.name,
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

