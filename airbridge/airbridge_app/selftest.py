"""``airbridge-core --self-test``: prove a frozen build can actually start.

Run by CI on every freshly built binary and on the copy inside the packaged
app (.app / win-unpacked). It catches what ``--help`` cannot: a dependency
that fails to import inside the PyInstaller bundle, e.g. cryptography's Rust
extension binding to the wrong OpenSSL (``Symbol not found:
_SSL_get0_group_name``), which made the daemon crash-loop on Intel Macs.

Steps (all output goes to stderr, never stdout):

1. import every runtime dependency and every ``airbridge_app`` module;
2. exercise the native code paths (cryptography AES-GCM/HKDF through the
   bundled OpenSSL, the stdlib ``ssl`` module, pydantic-core);
3. build the app objects the daemon and the MCP mode build (inbox app and
   server, MCP server and its tools, control app);
4. serve the guarded control API on an ephemeral loopback port and fetch
   ``/status`` through it, then shut it down.

Exit code 0 when everything passed, 1 otherwise. No network beyond loopback,
no Tailscale, no files outside ``AIRBRIDGE_DATA_DIR``.
"""

from __future__ import annotations

import asyncio
import contextlib
import http.client
import importlib
import json
import secrets
import sys
import time
from typing import Any, Callable

# Third-party modules the bundle must contain. Order matters only for the log.
RUNTIME_MODULES = (
    "pydantic",
    "pydantic_core",
    "anyio",
    "h11",
    "starlette",
    "starlette.concurrency",
    "fastapi",
    "fastapi.responses",
    "uvicorn",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.websockets_sansio_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "websockets",
    "requests",
    "requests.adapters",
    "urllib3",
    "certifi",
    "idna",
    "charset_normalizer",
    "ssl",
    "cryptography",
    "cryptography.hazmat.bindings._rust",
    "cryptography.hazmat.primitives.ciphers.aead",
    "cryptography.hazmat.primitives.kdf.hkdf",
    "jwt",
    "mcp",
    "mcp.server.mcpserver",
    "mcp.server.request_state",
)

AIRBRIDGE_MODULES = (
    "config",
    "logging_setup",
    "security",
    "events",
    "formatting",
    "network",
    "netbackend",
    "notify",
    "inbox",
    "outbox",
    "control",
    "daemon",
)


def _say(line: str) -> None:
    try:
        sys.stderr.write(f"self-test: {line}\n")
        sys.stderr.flush()
    except Exception:  # pragma: no cover - stderr closed
        pass


class _Runner:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def step(self, name: str, fn: Callable[[], Any]) -> Any:
        try:
            result = fn()
        except BaseException as exc:  # noqa: BLE001 - SystemExit from a bad import counts too
            if isinstance(exc, KeyboardInterrupt):
                raise
            self.failures.append(name)
            _say(f"FAIL {name}: {type(exc).__name__}: {exc}")
            return None
        _say(f"ok   {name}" + (f" ({result})" if isinstance(result, str) and result else ""))
        return result


def _crypto_roundtrip() -> str:
    from cryptography import __version__ as version
    from cryptography.hazmat.backends.openssl.backend import backend
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.hashes import SHA256
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    key = HKDF(algorithm=SHA256(), length=32, salt=b"airbridge", info=b"self-test").derive(secrets.token_bytes(32))
    nonce = secrets.token_bytes(12)
    aead = AESGCM(key)
    plain = b"airbridge self-test"
    if aead.decrypt(nonce, aead.encrypt(nonce, plain, b"ad"), b"ad") != plain:
        raise RuntimeError("AES-GCM round trip mismatch")
    return f"cryptography {version}, {backend.openssl_version_text()}"


def _stdlib_ssl() -> str:
    import ssl

    ssl.create_default_context()
    return ssl.OPENSSL_VERSION


def _pydantic_roundtrip() -> str:
    import pydantic

    class _M(pydantic.BaseModel):
        n: int

    if _M.model_validate_json('{"n": 3}').n != 3:
        raise RuntimeError("pydantic validation mismatch")
    return f"pydantic {pydantic.VERSION}"


def _get_status(host: str, port: int, token: str) -> dict[str, Any]:
    conn = http.client.HTTPConnection(host, port, timeout=10)
    try:
        conn.putrequest("GET", "/status", skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", f"[{host}]:{port}" if ":" in host else f"{host}:{port}")
        conn.putheader("Authorization", f"Bearer {token}")
        conn.endheaders()
        resp = conn.getresponse()
        body = resp.read()
        if resp.status != 200:
            raise RuntimeError(f"/status answered HTTP {resp.status}: {body[:200]!r}")
        return json.loads(body)
    finally:
        conn.close()


async def _serve_control(settings: Any) -> str:
    control = importlib.import_module("airbridge_app.control")
    daemon = importlib.import_module("airbridge_app.daemon")
    token = secrets.token_urlsafe(32)
    sock = control.bind_control_socket(0)
    port = sock.getsockname()[1]
    host = control.bound_host(sock)
    app = control.create_control_app(
        token=token,
        port_getter=lambda: port,
        state=control.DaemonState(inbox_port=settings.port),
        settings=settings,
        nodes_provider=lambda: {"self": None, "nodes": [], "error": None},
        host=host,
    )
    server = control.build_control_server(app)
    daemon._disable_signal_capture(server)
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        deadline = time.monotonic() + 15
        while not getattr(server, "started", False):
            if task.done():
                task.result()
                raise RuntimeError("control server exited during startup")
            if time.monotonic() > deadline:
                raise RuntimeError("control server did not start within 15s")
            await asyncio.sleep(0.02)
        status = await asyncio.to_thread(_get_status, host, port, token)
        if not isinstance(status, dict):
            raise RuntimeError(f"unexpected /status body {status!r}")
        return f"[{host}]:{port} /status ok"
    finally:
        server.should_exit = True
        with contextlib.suppress(BaseException):
            await asyncio.wait_for(task, timeout=5)
        with contextlib.suppress(Exception):
            sock.close()


async def _mcp_tools(settings: Any) -> str:
    outbox = importlib.import_module("airbridge_app.outbox")
    with contextlib.redirect_stdout(sys.stderr):
        server = outbox.build_mcp_server(settings)
    names = sorted(t.name for t in await server.list_tools())
    if not names:
        raise RuntimeError("MCP server exposes no tools")
    return ", ".join(names)


def run_self_test(settings: Any) -> int:
    """Run all checks; return 0 if every one passed, else 1."""
    r = _Runner()
    _say(f"python {sys.version.split()[0]} frozen={bool(getattr(sys, 'frozen', False))} ({sys.executable})")
    for name in RUNTIME_MODULES:
        r.step(f"import {name}", lambda name=name: importlib.import_module(name) and "")
    for name in AIRBRIDGE_MODULES:
        r.step(f"import airbridge_app.{name}", lambda name=name: importlib.import_module(f"airbridge_app.{name}") and "")

    r.step("cryptography AES-GCM/HKDF via bundled OpenSSL", _crypto_roundtrip)
    r.step("stdlib ssl default context", _stdlib_ssl)
    r.step("pydantic-core validation", _pydantic_roundtrip)

    def _inbox_objects() -> str:
        inbox = importlib.import_module("airbridge_app.inbox")
        with contextlib.redirect_stdout(sys.stderr):
            app = inbox.create_app(settings)
            inbox.build_server(app, "127.0.0.1", 0)
        return ""

    r.step("build inbox app + uvicorn server", _inbox_objects)
    r.step("build MCP server + list tools", lambda: asyncio.run(_mcp_tools(settings)))
    r.step("serve control API on loopback", lambda: asyncio.run(_serve_control(settings)))

    if r.failures:
        _say(f"FAILED ({len(r.failures)}): {', '.join(r.failures)}")
        return 1
    _say("PASSED")
    return 0


__all__ = ["AIRBRIDGE_MODULES", "RUNTIME_MODULES", "run_self_test"]
