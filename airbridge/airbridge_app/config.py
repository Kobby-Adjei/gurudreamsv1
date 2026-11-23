"""Runtime configuration for AirBridge.

All values are read from the environment at ``load()`` call time (never at
import time) so tests and launchers can adjust the environment freely.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

PORT = 8989
SECRET_HEADER = "X-AirBridge-Secret"

# <repo>/airbridge/ -- the directory that holds main.py.
AIRBRIDGE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_LOG_FILE = AIRBRIDGE_DIR / "airbridge.log"
DEFAULT_INBOX_DIRNAME = "AirBridge_Inbox"

ENV_INBOX_DIR = "AIRBRIDGE_INBOX_DIR"
ENV_LOG_FILE = "AIRBRIDGE_LOG_FILE"
ENV_SECRET = "AIRBRIDGE_SECRET"

# Phase 2 (daemon / desktop app).
ENV_DATA_DIR = "AIRBRIDGE_DATA_DIR"
ENV_CONTROL_TOKEN = "AIRBRIDGE_CONTROL_TOKEN"
ENV_CONTROL_PORT = "AIRBRIDGE_CONTROL_PORT"
ENV_PARENT_PID = "AIRBRIDGE_PARENT_PID"
APP_DIRNAME = "AirBridge"


def is_frozen() -> bool:
    """True when running from a PyInstaller bundle (airbridge-core binary)."""
    return bool(getattr(sys, "frozen", False))


def default_data_dir() -> Path:
    """Per-user data directory for activity.jsonl (and logs in frozen builds).

    macOS ``~/Library/Application Support/AirBridge``, Windows
    ``%APPDATA%\\AirBridge``, Linux ``$XDG_DATA_HOME/airbridge`` (default
    ``~/.local/share/airbridge``). ``AIRBRIDGE_DATA_DIR`` overrides all of them.
    """
    override = _env_path(ENV_DATA_DIR)
    if override is not None:
        return override
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIRNAME
    if os.name == "nt":
        appdata = os.environ.get("APPDATA", "").strip()
        base = Path(appdata) if appdata else Path.home() / "AppData" / "Roaming"
        return base / APP_DIRNAME
    xdg = os.environ.get("XDG_DATA_HOME", "").strip()
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "share"
    return base / "airbridge"


@dataclass(frozen=True)
class Settings:
    port: int = PORT
    inbox_dir: Path = Path.home() / "Desktop" / DEFAULT_INBOX_DIRNAME
    log_file: Path = DEFAULT_LOG_FILE
    shared_secret: str | None = None
    http_timeout_s: float = 10
    rate_limit_per_minute: int = 30
    data_dir: Path = field(default_factory=lambda: default_data_dir())

    def __repr__(self) -> str:  # never leak the secret into logs
        secret = "<set>" if self.shared_secret else None
        return (
            f"Settings(port={self.port!r}, inbox_dir={str(self.inbox_dir)!r}, "
            f"log_file={str(self.log_file)!r}, shared_secret={secret!r}, "
            f"http_timeout_s={self.http_timeout_s!r}, "
            f"rate_limit_per_minute={self.rate_limit_per_minute!r}, "
            f"data_dir={str(self.data_dir)!r})"
        )

    __str__ = __repr__


def _env_path(name: str) -> Path | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    return Path(raw).expanduser()


def load() -> Settings:
    """Build Settings from the current environment."""
    inbox_dir = _env_path(ENV_INBOX_DIR) or (Path.home() / "Desktop" / DEFAULT_INBOX_DIRNAME)
    data_dir = default_data_dir()
    # Inside a PyInstaller onefile bundle the package lives in a temp dir that
    # is deleted on exit, so frozen builds log into the per-user data dir.
    default_log = (data_dir / "airbridge.log") if is_frozen() else DEFAULT_LOG_FILE
    log_file = _env_path(ENV_LOG_FILE) or default_log
    secret = os.environ.get(ENV_SECRET)
    shared_secret = secret if secret else None
    return Settings(
        port=PORT,
        inbox_dir=inbox_dir,
        log_file=log_file,
        shared_secret=shared_secret,
        data_dir=data_dir,
    )
