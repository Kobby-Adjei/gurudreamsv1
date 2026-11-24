"""AirBridge entry point (launched by Claude Desktop as an MCP stdio server).

stdout is reserved exclusively for MCP JSON-RPC. Everything human-readable goes
to stderr (which Claude Desktop captures into its MCP log) or to the log file.

Usage:
    python /abs/path/to/airbridge/main.py           # run inbox (HTTP) + outbox (MCP stdio)
    python /abs/path/to/airbridge/main.py --check   # diagnose Tailscale/config, then exit
    python /abs/path/to/airbridge/main.py --daemon  # desktop-app daemon (inbox + local control API)
    airbridge-core --self-test                      # build check: import + start everything, exit 0/1

Daemon mode (Phase 2) is launched by the AirBridge Pro desktop app with
AIRBRIDGE_CONTROL_TOKEN (>= 32 random bytes, base64url; required),
AIRBRIDGE_CONTROL_PORT (0 = ephemeral), AIRBRIDGE_PARENT_PID and optionally
AIRBRIDGE_DATA_DIR in its environment. It writes one stderr line
``AIRBRIDGE_READY {"control_port":N,"pid":P}`` once the control API listens.

Exit codes: 0 ok, 1 unexpected error / missing dependency, 2 Tailscale or
configuration problem (or bad CLI usage), 130 interrupted.

Inbox bind failure policy (e.g. port 8989 already in use): AirBridge logs the
problem, writes one line to stderr and keeps the MCP outbox running in a
degraded "outbox-only" mode, so Claude can still *send* tasks. Exiting would
make Claude Desktop show the whole server as failed, which is worse UX.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import importlib
import logging
import os
import sys

# --- sys.path bootstrap: make `python /abs/path/main.py` work from any cwd. ---
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

logger = logging.getLogger("airbridge.main")

SHUTDOWN_GRACE_S = 5.0

USAGE = (
    "usage: main.py [--check | --daemon] [--help]\n"
    "  (no args)  run AirBridge as an MCP stdio server (launched by Claude Desktop)\n"
    "  --check    print a Tailscale/configuration diagnostic to stderr and exit\n"
    "  --daemon   run the desktop-app daemon (needs AIRBRIDGE_CONTROL_TOKEN)\n"
)

MIN_TOKEN_BYTES = 32


def _err(message: str) -> None:
    """Write one human-readable line to stderr (never stdout)."""
    try:
        sys.stderr.write(f"AirBridge: {message}\n")
        sys.stderr.flush()
    except Exception:  # pragma: no cover - stderr closed
        pass


def _mod(name: str):
    """Import a sibling module lazily (via sys.modules, so tests can substitute it)."""
    return importlib.import_module(f"airbridge_app.{name}")


def _disable_signal_capture(server) -> None:
    """Stop uvicorn from hijacking SIGINT/SIGTERM.

    The MCP stdio transport owns the process lifecycle: we shut uvicorn down
    ourselves when stdin reaches EOF. uvicorn>=0.29 uses ``capture_signals()``
    (a context manager); older versions use ``install_signal_handlers()``.
    Patching the instance covers both and is harmless if inbox already did it.
    """
    try:
        server.capture_signals = contextlib.nullcontext
    except Exception:  # pragma: no cover - exotic server object
        pass
    try:
        server.install_signal_handlers = lambda *a, **k: None
    except Exception:  # pragma: no cover
        pass


def _tailscale_hint(exc: Exception) -> str:
    network = _mod("network")
    if isinstance(exc, network.TailscaleNotInstalled):
        return "Hint: install Tailscale, sign in, then restart Claude Desktop."
    if isinstance(exc, network.TailscaleNotRunning):
        return "Hint: open the Tailscale app, make sure it shows Connected, then restart Claude Desktop."
    return "Hint: run `tailscale status` to diagnose, or run main.py --check."


# --------------------------------------------------------------------------- #
# --check diagnostic
# --------------------------------------------------------------------------- #
def _run_check(settings) -> int:
    network = _mod("network")
    _err("diagnostic (--check)")
    _err(f"  python      : {sys.version.split()[0]} ({sys.executable})")
    _err(f"  port        : {settings.port}")
    _err(f"  inbox_dir   : {settings.inbox_dir}")
    _err(f"  log_file    : {settings.log_file}")
    _err(f"  secret      : {'configured' if settings.shared_secret else 'not set'}")
    try:
        binary = network.tailscale_binary()
        _err(f"  tailscale   : {binary}")
        ip = network.get_local_tailscale_ip()
        _err(f"  tailnet ip  : {ip}")
    except network.TailscaleError as exc:
        _err(f"  tailscale   : ERROR - {exc}")
        _err(_tailscale_hint(exc))
        return 2
    try:
        security = _mod("security")
        security.validate_bind_host(ip)
        _err(f"  bind host   : {ip}:{settings.port} OK")
    except ImportError as exc:
        _err(f"  bind host   : skipped (security module unavailable: {exc})")
    except ValueError as exc:
        _err(f"  bind host   : REJECTED - {exc}")
        return 2
    try:
        peers = network.get_airbridge_peers()
    except network.TailscaleError as exc:
        _err(f"  peers       : ERROR - {exc}")
        return 2
    _err(f"  online peers: {len(peers)}")
    for name, peer_ip in sorted(peers.items()):
        _err(f"    - {name} ({peer_ip})")
    _err("OK - AirBridge is ready.")
    return 0


# --------------------------------------------------------------------------- #
# Runtime
# --------------------------------------------------------------------------- #
async def _serve_inbox(server, host: str, port: int) -> bool:
    """Run uvicorn; return False if it failed (bind error etc.) instead of raising."""
    try:
        await server.serve()
        return True
    except SystemExit as exc:  # uvicorn calls sys.exit(STARTUP_FAILURE) on bind failure
        logger.error("Inbox failed to start on %s:%s (exit %s)", host, port, exc.code)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Inbox crashed on %s:%s", host, port)
    _err(
        f"inbox could not listen on {host}:{port} (port in use?). "
        "Continuing in outbox-only mode: you can send tasks but not receive them. "
        "See the log file for details."
    )
    return False


async def _run(settings, host: str) -> int:
    inbox = _mod("inbox")
    outbox = _mod("outbox")

    # Guard against stray prints from app/server construction.
    with contextlib.redirect_stdout(sys.stderr):
        app = inbox.create_app(settings)
        server = inbox.build_server(app, host, settings.port)
        mcp = outbox.build_mcp_server(settings)
    _disable_signal_capture(server)

    inbox_task = asyncio.create_task(_serve_inbox(server, host, settings.port), name="airbridge-inbox")
    logger.info("AirBridge starting: inbox http://%s:%s, outbox MCP over stdio", host, settings.port)
    try:
        # run_stdio_async claims fd 0/1 synchronously before its first await, so
        # the wire is diverted before uvicorn's startup code runs.
        await mcp.run_stdio_async()
        logger.info("MCP stdio closed; shutting down inbox")
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(asyncio.shield(inbox_task), timeout=SHUTDOWN_GRACE_S)
        except (asyncio.TimeoutError, TimeoutError):
            logger.warning("Inbox did not stop within %.0fs; forcing exit", SHUTDOWN_GRACE_S)
            server.force_exit = True
            inbox_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await inbox_task
        except asyncio.CancelledError:
            inbox_task.cancel()
            raise
        except Exception:  # pragma: no cover - _serve_inbox swallows errors
            logger.exception("Inbox shutdown error")
    logger.info("AirBridge stopped")
    return 0


# --------------------------------------------------------------------------- #
# --daemon (Phase 2)
# --------------------------------------------------------------------------- #
def _token_ok(token: str) -> bool:
    """True if *token* is base64url (no padding needed) decoding to >= 32 bytes."""
    if not token or len(token) > 512:
        return False
    if any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=" for c in token):
        return False
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
    except (binascii.Error, ValueError):
        return False
    return len(raw) >= MIN_TOKEN_BYTES


def _daemon_env(config) -> tuple[str, int, int | None] | None:
    """Read and validate daemon env vars; on error write to stderr and return None."""
    # Pop (not get): the token must not be inherited by child processes we
    # spawn later (tailscale CLI, osascript, powershell, notify-send).
    token = os.environ.pop(config.ENV_CONTROL_TOKEN, "").strip()
    if not _token_ok(token):
        _err(
            f"--daemon requires {config.ENV_CONTROL_TOKEN} (at least {MIN_TOKEN_BYTES} random "
            "bytes, base64url). It is set by the AirBridge Pro app; refusing to start."
        )
        return None
    raw_port = os.environ.get(config.ENV_CONTROL_PORT, "0").strip() or "0"
    try:
        port = int(raw_port)
        if not 0 <= port <= 65535:
            raise ValueError
    except ValueError:
        _err(f"invalid {config.ENV_CONTROL_PORT}={raw_port!r} (expected 0-65535)")
        return None
    raw_ppid = os.environ.get(config.ENV_PARENT_PID, "").strip()
    parent_pid: int | None = None
    if raw_ppid:
        try:
            parent_pid = int(raw_ppid)
            if parent_pid <= 0:
                raise ValueError
        except ValueError:
            _err(f"invalid {config.ENV_PARENT_PID}={raw_ppid!r}")
            return None
    return token, port, parent_pid


def _run_daemon(config, settings) -> int:
    env = _daemon_env(config)
    if env is None:
        return 2
    token, port, parent_pid = env
    # Nothing in daemon mode may reach stdout (the desktop app ignores it, but
    # keep the invariant): route any stray writes to stderr.
    sys.stdout = sys.stderr
    try:
        daemon = _mod("daemon")
        return asyncio.run(daemon.run_daemon(settings, token=token, control_port=port, parent_pid=parent_pid))
    except ImportError as exc:
        logger.exception("dependency import failed")
        _err(f"missing dependency: {exc}")
        return 1
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        logger.exception("daemon crashed")
        _err(f"fatal error: {type(exc).__name__}: {exc}. See {settings.log_file}")
        return 1


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    check = False
    daemon_mode = False
    self_test = False
    for arg in args:
        if arg == "--check":
            check = True
        elif arg == "--self-test":  # hidden: CI startup smoke test of the frozen binary
            self_test = True
        elif arg == "--daemon":
            daemon_mode = True
        elif arg in ("-h", "--help"):
            sys.stderr.write(USAGE)
            return 0
        else:
            _err(f"unknown argument {arg!r}")
            sys.stderr.write(USAGE)
            return 2
    if check + daemon_mode + self_test > 1:
        _err("--check, --daemon and --self-test cannot be combined")
        sys.stderr.write(USAGE)
        return 2

    try:
        config = _mod("config")
        logging_setup = _mod("logging_setup")
        network = _mod("network")
    except ImportError as exc:  # pragma: no cover - broken install
        _err(f"failed to import AirBridge modules: {exc}. Re-run install.py.")
        return 1

    settings = config.load()
    logging_setup.configure_logging(settings.log_file)
    logger.info("AirBridge launching (pid %s) %r", os.getpid(), settings)

    if check:
        return _run_check(settings)

    if self_test:
        sys.stdout = sys.stderr  # keep the no-stdout invariant
        try:
            return _mod("selftest").run_self_test(settings)
        except BaseException as exc:  # noqa: BLE001 - report, never crash-loop silently
            if isinstance(exc, KeyboardInterrupt):
                return 130
            _err(f"self-test crashed: {type(exc).__name__}: {exc}")
            return 1

    if daemon_mode:
        return _run_daemon(config, settings)

    try:
        ip = network.get_local_tailscale_ip()
    except network.TailscaleError as exc:
        logger.error("Tailscale unavailable: %s", exc)
        _err(str(exc))
        _err(_tailscale_hint(exc))
        return 2

    try:
        security = _mod("security")
        host = security.validate_bind_host(ip)
    except ImportError as exc:
        logger.error("security module import failed: %s", exc)
        _err(f"missing dependency: {exc}. Re-run install.py.")
        return 1
    except ValueError as exc:  # security.SecurityError subclasses ValueError
        logger.error("Refusing bind host %r: %s", ip, exc)
        _err(f"refusing to bind to {ip!r}: {exc}")
        return 2

    try:
        return asyncio.run(_run(settings, host))
    except ImportError as exc:
        logger.exception("dependency import failed")
        _err(f"missing dependency: {exc}. Re-run install.py.")
        return 1
    except KeyboardInterrupt:
        logger.info("Interrupted")
        return 130
    except Exception as exc:
        logger.exception("AirBridge crashed")
        _err(f"fatal error: {type(exc).__name__}: {exc}. See {settings.log_file}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
