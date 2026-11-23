"""Runtime configuration for AirBridge.

All values are read from the environment at ``load()`` call time (never at
import time) so tests and launchers can adjust the environment freely.
"""

from __future__ import annotations

import json
import logging
import os
import stat
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

# Phase 3 (private network). PHASE3_PLAN.md §9: the desktop app's network is the
# airbridge-net sidecar (embedded tsnet); "system" is the Phase-1 free CLI's own Tailscale.
ENV_NETWORK = "AIRBRIDGE_NETWORK"  # auto | sidecar | system
ENV_NET_URL = "AIRBRIDGE_NET_URL"  # sidecar control API, http://[::1]:<port> (daemon env)
ENV_NET_TOKEN = "AIRBRIDGE_NET_TOKEN"  # sidecar control token (daemon env; never logged)
NETWORK_MODES = ("auto", "sidecar", "system")
SIDECAR_TOKEN_HEADER = "X-AirBridge-Sidecar-Token"
PEER_NODE_HEADER = "X-AirBridge-Peer-Node"
PEER_IP_HEADER = "X-AirBridge-Peer-IP"
NETWORK_JSON = "network.json"
_NETWORK_JSON_MAX_BYTES = 64 * 1024

_logger = logging.getLogger("airbridge.config")


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


def network_mode() -> str:
    """``AIRBRIDGE_NETWORK`` (auto|sidecar|system); anything else means auto."""
    raw = os.environ.get(ENV_NETWORK, "").strip().lower()
    if raw in NETWORK_MODES:
        return raw
    if raw:
        _logger.warning("ignoring invalid %s=%.20r (using auto)", ENV_NETWORK, raw)
    return "auto"


def network_json_path(data_dir: Path | None = None) -> Path:
    return (data_dir if data_dir is not None else default_data_dir()) / NETWORK_JSON


def read_network_json(data_dir: Path | None = None) -> dict | None:
    """Parse ``<data dir>/network.json`` (v2, written by the desktop app's
    NetManager: ``{v:2, mode:"sidecar", control_url_local, control_token, pid,
    bin, ...}``). Returns None when absent, unreadable, not a regular file,
    oversized, not ours / group-other-writable (POSIX), or not a v2 sidecar
    object. Values are validated by the caller."""
    path = network_json_path(data_dir)
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > _NETWORK_JSON_MAX_BYTES:
            return None
        # F-8: on POSIX the file must be ours and not group/other-writable,
        # or another local user could point us at a fake sidecar.
        if os.name != "nt":
            if st.st_uid != os.getuid() or st.st_mode & 0o022:
                _logger.warning("ignoring %s: wrong owner or group/other-writable", path)
                return None
        with os.fdopen(fd, "rb") as fh:
            fd = -1
            data = json.loads(fh.read(_NETWORK_JSON_MAX_BYTES + 1))
    except (OSError, ValueError):
        return None
    finally:
        if fd >= 0:
            os.close(fd)
    if not isinstance(data, dict) or data.get("v") != 2 or data.get("mode") != "sidecar":
        return None
    return data


@dataclass(frozen=True)
class Settings:
    port: int = PORT
    inbox_dir: Path = Path.home() / "Desktop" / DEFAULT_INBOX_DIRNAME
    log_file: Path = DEFAULT_LOG_FILE
    shared_secret: str | None = None
    http_timeout_s: float = 10
    rate_limit_per_minute: int = 30
    data_dir: Path = field(default_factory=lambda: default_data_dir())
    network: str = "auto"

    def __repr__(self) -> str:  # never leak the secret into logs
        secret = "<set>" if self.shared_secret else None
        return (
            f"Settings(port={self.port!r}, inbox_dir={str(self.inbox_dir)!r}, "
            f"log_file={str(self.log_file)!r}, shared_secret={secret!r}, "
            f"http_timeout_s={self.http_timeout_s!r}, "
            f"rate_limit_per_minute={self.rate_limit_per_minute!r}, "
            f"data_dir={str(self.data_dir)!r}, network={self.network!r})"
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
        network=network_mode(),
    )
