"""File-only logging. Nothing may ever reach stdout (it carries MCP JSON-RPC)."""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
MAX_BYTES = 1_000_000
BACKUP_COUNT = 3

# Third-party loggers that like to install their own (stream) handlers.
MUTED_LOGGERS = (
    "uvicorn",
    "uvicorn.error",
    "uvicorn.access",
    "fastapi",
    "mcp",
)


def _is_stream_handler(handler: logging.Handler) -> bool:
    # FileHandler subclasses StreamHandler; only strip true console streams.
    return isinstance(handler, logging.StreamHandler) and not isinstance(
        handler, logging.FileHandler
    )


def _make_handler(log_file: Path) -> logging.Handler:
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handler: logging.Handler = RotatingFileHandler(
            log_file, maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
        )
    except OSError as exc:
        # Can't open the log file: fall back to stderr (never stdout).
        sys.stderr.write(f"AirBridge: cannot open log file {log_file}: {exc}; logging to stderr\n")
        handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    handler.setLevel(logging.INFO)
    return handler


def configure_logging(log_file: Path) -> None:
    """Route root + noisy third-party loggers to a rotating file only."""
    log_file = Path(log_file)
    handler = _make_handler(log_file)

    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
        try:
            h.close()
        except Exception:  # pragma: no cover - defensive
            pass
    root.addHandler(handler)
    root.setLevel(logging.INFO)

    for name in MUTED_LOGGERS:
        lg = logging.getLogger(name)
        for h in list(lg.handlers):
            if _is_stream_handler(h) or isinstance(h, logging.FileHandler):
                lg.removeHandler(h)
        lg.addHandler(handler)
        lg.propagate = False
        if lg.level == logging.NOTSET:
            lg.setLevel(logging.INFO)

    # Silence logging's own "last resort" stderr handler and its error dumps.
    logging.lastResort = None
    logging.raiseExceptions = False
    logging.captureWarnings(True)
