"""Runtime configuration for AirBridge.

All values are read from the environment at ``load()`` call time (never at
import time) so tests and launchers can adjust the environment freely.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
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


@dataclass(frozen=True)
class Settings:
    port: int = PORT
    inbox_dir: Path = Path.home() / "Desktop" / DEFAULT_INBOX_DIRNAME
    log_file: Path = DEFAULT_LOG_FILE
    shared_secret: str | None = None
    http_timeout_s: float = 10
    rate_limit_per_minute: int = 30

    def __repr__(self) -> str:  # never leak the secret into logs
        secret = "<set>" if self.shared_secret else None
        return (
            f"Settings(port={self.port!r}, inbox_dir={str(self.inbox_dir)!r}, "
            f"log_file={str(self.log_file)!r}, shared_secret={secret!r}, "
            f"http_timeout_s={self.http_timeout_s!r}, "
            f"rate_limit_per_minute={self.rate_limit_per_minute!r})"
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
    log_file = _env_path(ENV_LOG_FILE) or DEFAULT_LOG_FILE
    secret = os.environ.get(ENV_SECRET)
    shared_secret = secret if secret else None
    return Settings(
        port=PORT,
        inbox_dir=inbox_dir,
        log_file=log_file,
        shared_secret=shared_secret,
    )
