"""AirBridge activity events (JSONL v1).

Both the MCP stdio process (origin ``"mcp"``) and the desktop daemon (origin
``"daemon"``) append one JSON object per line to ``<DATA_DIR>/activity.jsonl``.
The daemon tails that file and streams it to the desktop UI.

Event shape::

    {v:1, id:uuid4, ts:ISO8601Z, type, origin, local_node, peer, summary, detail}

Rules:

* Never write task descriptions or code bodies: only hostnames, sizes, file
  names and short error strings. ``summary`` is neutralized and <= 120 chars.
* The file is created 0o600; every event is one ``os.write`` on an
  ``O_APPEND`` descriptor, so concurrent writers never tear lines.
* Rotation at 5 MB keeps ``.1`` .. ``.3``; writers serialize on a sidecar lock
  file (``fcntl.flock`` / ``msvcrt.locking``) so rotation is race-free across
  processes.
* ``emit()`` never raises: telemetry must not break the request path.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import socket
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config, security

logger = logging.getLogger("airbridge.events")

SCHEMA_VERSION = 1
FILE_NAME = "activity.jsonl"
LOCK_SUFFIX = ".lock"
MAX_FILE_BYTES = 5 * 1024 * 1024
BACKUP_COUNT = 3
MAX_SUMMARY_CHARS = 120
MAX_PEER_CHARS = 64
MAX_ERROR_CHARS = 200
MAX_FILE_FIELD_CHARS = 128
TAIL_POLL_S = 0.2

EVENT_TYPES = frozenset(
    {
        "task_received",
        "task_sent",
        "send_failed",
        "node_online",
        "node_offline",
        "inbox_listening",
        "inbox_degraded",
        "daemon_started",
        "daemon_stopping",
    }
)
ORIGINS = frozenset({"daemon", "mcp"})
DETAIL_KEYS = ("bytes", "file", "error")

_FILE_MODE = 0o600
_DIR_MODE = 0o700

_state_lock = threading.Lock()
_write_lock = threading.Lock()
_origin = "mcp"
_data_dir_override: Path | None = None


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
def set_origin(origin: str) -> None:
    """Set the process-wide default origin (``"mcp"`` or ``"daemon"``)."""
    global _origin
    if origin not in ORIGINS:
        raise ValueError(f"origin must be one of {sorted(ORIGINS)}")
    with _state_lock:
        _origin = origin


def get_origin() -> str:
    return _origin


def configure(data_dir: Path | str | None) -> None:
    """Pin the data directory (``None`` = resolve from the environment per call)."""
    global _data_dir_override
    with _state_lock:
        _data_dir_override = Path(data_dir).expanduser() if data_dir is not None else None


def data_dir() -> Path:
    override = _data_dir_override
    return override if override is not None else config.default_data_dir()


def activity_path() -> Path:
    return data_dir() / FILE_NAME


# --------------------------------------------------------------------------- #
# Sanitizing
# --------------------------------------------------------------------------- #
_WS_RE = re.compile(r"\s+")


def _clean_line(value: object, limit: int) -> str:
    """Single-line, control-char-free, markdown-neutralized, <= *limit* chars."""
    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    text = text[: limit * 4]  # bound the work before escaping
    try:
        text = security.neutralize_markdown(text)
    except Exception:
        text = ""
    text = _WS_RE.sub(" ", text).strip()
    text = security.truncate_for_log(text, len(text))  # escape remaining controls/bidi
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def _clean_peer(peer: object) -> str | None:
    if peer is None:
        return None
    cleaned = _clean_line(peer, MAX_PEER_CHARS)
    return cleaned or None


def _clean_detail(detail: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    raw_bytes = detail.get("bytes")
    if isinstance(raw_bytes, int) and not isinstance(raw_bytes, bool) and raw_bytes >= 0:
        out["bytes"] = raw_bytes
    raw_file = detail.get("file")
    if isinstance(raw_file, str) and raw_file:
        name = re.split(r"[\\/]", raw_file)[-1]
        name = _clean_line(name, MAX_FILE_FIELD_CHARS)
        if name:
            out["file"] = name
    raw_error = detail.get("error")
    if raw_error is not None and raw_error != "":
        err = _clean_line(raw_error, MAX_ERROR_CHARS)
        if err:
            out["error"] = err
    return out


def local_node_name() -> str:
    raw = (socket.gethostname() or "").split(".")[0]
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "-", raw).strip("-.")[: security.MAX_SENDER_LEN]
    try:
        return security.validate_sender(cleaned or "airbridge-node")
    except Exception:
        return "airbridge-node"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def make_event(
    type: str,
    *,
    peer: object = None,
    summary: object = "",
    origin: str | None = None,
    **detail: Any,
) -> dict[str, Any]:
    """Build a sanitized event dict (does not write it)."""
    if type not in EVENT_TYPES:
        raise ValueError(f"unknown event type {type!r}")
    org = origin if origin in ORIGINS else _origin
    return {
        "v": SCHEMA_VERSION,
        "id": str(uuid.uuid4()),
        "ts": _now_iso(),
        "type": type,
        "origin": org,
        "local_node": local_node_name(),
        "peer": _clean_peer(peer),
        "summary": _clean_line(summary, MAX_SUMMARY_CHARS),
        "detail": _clean_detail(detail),
    }


# --------------------------------------------------------------------------- #
# Writing
# --------------------------------------------------------------------------- #
@contextlib.contextmanager
def _file_lock(lock_path: Path) -> Iterator[None]:
    """Exclusive cross-process lock on a sidecar file."""
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, _FILE_MODE)
    try:
        if os.name == "nt":  # pragma: no cover - exercised on Windows CI
            import msvcrt

            os.lseek(fd, 0, os.SEEK_SET)
            while True:
                try:
                    msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    continue
            try:
                yield
            finally:
                os.lseek(fd, 0, os.SEEK_SET)
                with contextlib.suppress(OSError):
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _rotate(path: Path) -> None:
    for i in range(BACKUP_COUNT - 1, 0, -1):
        src = path.with_name(f"{path.name}.{i}")
        if src.exists():
            os.replace(src, path.with_name(f"{path.name}.{i + 1}"))
    os.replace(path, path.with_name(f"{path.name}.1"))


def _ensure_dir(directory: Path) -> None:
    if not directory.exists():
        directory.mkdir(mode=_DIR_MODE, parents=True, exist_ok=True)


def append(event: dict[str, Any]) -> None:
    """Append one event as a single line (raises on I/O errors)."""
    path = activity_path()
    _ensure_dir(path.parent)
    line = (json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")
    lock_path = path.with_name(path.name + LOCK_SUFFIX)
    with _write_lock, _file_lock(lock_path):
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            size = 0
        if size and size + len(line) > MAX_FILE_BYTES:
            _rotate(path)
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_BINARY", 0)
        fd = os.open(str(path), flags, _FILE_MODE)
        try:
            if os.name != "nt":
                with contextlib.suppress(OSError):
                    os.fchmod(fd, _FILE_MODE)
            os.write(fd, line)
        finally:
            os.close(fd)


def emit(type: str, *, peer: object = None, summary: object = "", origin: str | None = None, **detail: Any) -> None:
    """Record an activity event. Never raises."""
    try:
        event = make_event(type, peer=peer, summary=summary, origin=origin, **detail)
        append(event)
        logger.info("event %s peer=%s %s", event["type"], event["peer"], event["summary"])
    except Exception:
        with contextlib.suppress(Exception):
            logger.exception("failed to record %s event", security.truncate_for_log(type, 40))


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #
def _parse_line(raw: bytes) -> dict[str, Any] | None:
    raw = raw.strip()
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(obj, dict) or obj.get("v") != SCHEMA_VERSION or not isinstance(obj.get("id"), str):
        return None
    return obj


def _read_file_events(path: Path) -> list[dict[str, Any]]:
    try:
        data = path.read_bytes()
    except (FileNotFoundError, PermissionError, OSError):
        return []
    out = []
    for raw in data.split(b"\n"):
        ev = _parse_line(raw)
        if ev is not None:
            out.append(ev)
    return out


def read_recent(limit: int = 100, after_id: str | None = None) -> list[dict[str, Any]]:
    """Chronological events. Without *after_id*: the last *limit*. With it: up to
    *limit* events that follow it (all retained events if the id is unknown)."""
    limit = max(1, min(int(limit), 1000))
    path = activity_path()
    files = [path.with_name(f"{path.name}.{i}") for i in range(BACKUP_COUNT, 0, -1)] + [path]
    events: list[dict[str, Any]] = []
    for f in files:
        events.extend(_read_file_events(f))
    if after_id:
        for idx, ev in enumerate(events):
            if ev.get("id") == after_id:
                return events[idx + 1 : idx + 1 + limit]
        return events[-limit:]
    return events[-limit:]


def _file_id(st: os.stat_result) -> tuple[int, int]:
    return (st.st_dev, st.st_ino)


async def tail(after_id: str | None = None, *, poll_s: float = TAIL_POLL_S) -> AsyncIterator[dict[str, Any]]:
    """Yield events as they are appended, forever (cancel to stop).

    With *after_id*, first replays retained events after that id. Survives
    rotation: when the live file is replaced, the remainder of the old file
    (now ``.1``) is drained first.
    """
    path = activity_path()
    if after_id:
        for ev in read_recent(1000, after_id):
            yield ev

    cur_id: tuple[int, int] | None = None
    offset = 0
    try:
        st = path.stat()
        cur_id, offset = _file_id(st), st.st_size
    except FileNotFoundError:
        pass
    pending = b""

    def _read_from(p: Path, start: int) -> tuple[bytes, int]:
        try:
            with open(p, "rb") as fh:
                fh.seek(start)
                data = fh.read()
            return data, start + len(data)
        except FileNotFoundError:
            return b"", start

    while True:
        chunks: list[bytes] = []
        try:
            st = path.stat()
            new_id = _file_id(st)
        except FileNotFoundError:
            st, new_id = None, None
        if cur_id is not None and new_id != cur_id:
            # The file we were reading has been rotated (possibly several
            # times): finish it, then read any newer backups in full.
            backups = [path.with_name(f"{path.name}.{i}") for i in range(1, BACKUP_COUNT + 1)]
            found = None
            for idx, b in enumerate(backups):
                with contextlib.suppress(FileNotFoundError):
                    if _file_id(b.stat()) == cur_id:
                        found = idx
                        break
            if found is not None:
                data, _ = await asyncio.to_thread(_read_from, backups[found], offset)
                chunks.append(data)
                for b in reversed(backups[:found]):
                    data, _ = await asyncio.to_thread(_read_from, b, 0)
                    chunks.append(data)
            cur_id, offset = new_id, 0
        elif cur_id is None and new_id is not None:
            cur_id, offset = new_id, 0
        if st is not None and st.st_size < offset:  # truncated in place
            offset = 0
        if st is not None and st.st_size > offset:
            data, offset = await asyncio.to_thread(_read_from, path, offset)
            chunks.append(data)
        if chunks:
            buf = pending + b"".join(chunks)
            *lines, pending = buf.split(b"\n")
            for raw in lines:
                ev = _parse_line(raw)
                if ev is not None:
                    yield ev
        await asyncio.sleep(poll_s)


__all__ = [
    "EVENT_TYPES",
    "activity_path",
    "configure",
    "emit",
    "make_event",
    "read_recent",
    "set_origin",
    "tail",
]
