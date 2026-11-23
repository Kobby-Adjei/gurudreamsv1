"""Native desktop notifications, fire-and-forget.

``send_notification`` must never disturb the MCP stdio channel or the inbox
server: it never raises, never writes to stdout, never uses a shell, and never
blocks for longer than it takes to spawn a process. A daemon watchdog kills the
helper if it is still running after ``TIMEOUT_S`` seconds.

Remote text never gets interpolated into code:

* macOS: ``osascript`` reads title and body from ``argv``.
* Windows: strings are XML-escaped, then escaped for a PowerShell
  single-quoted literal, and the whole script travels base64-encoded via
  ``-EncodedCommand``.
* Linux: ``notify-send`` receives them as positional arguments after ``--``.
"""

from __future__ import annotations

import base64
import logging
import platform
import re
import shutil
import subprocess
import threading
from typing import Sequence

log = logging.getLogger(__name__)

TIMEOUT_S = 3.0
MAX_TITLE_CHARS = 64
MAX_BODY_CHARS = 200
APP_NAME = "AirBridge"

# Windows: no console window flashes up when PowerShell starts.
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

# PowerShell's AppUserModelID; lets an unregistered script raise a toast.
_PS_APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f  ]")
_WHITESPACE = re.compile(r"\s+")

_OSASCRIPT_SOURCE = (
    "on run argv",
    'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
    "end run",
)


# --------------------------------------------------------------------------- #
# Text hygiene
# --------------------------------------------------------------------------- #


def _clean(text: object, limit: int) -> str:
    """Single line, no control characters, no leading dash, at most ``limit``."""
    value = _CONTROL_CHARS.sub(" ", str(text if text is not None else ""))
    value = _WHITESPACE.sub(" ", value).strip()
    # A leading "-" could be read as a command-line option by the helper.
    value = value.lstrip("-").lstrip()
    if len(value) > limit:
        value = value[: limit - 1].rstrip() + "…"
    return value


def _xml_escape(text: str) -> str:
    """Escape for XML text; also removes every PowerShell quote character.

    PowerShell treats U+2018..U+201B as single quotes too, so those are emitted
    as numeric character references rather than literal characters.
    """
    out = []
    for ch in text:
        if ch == "&":
            out.append("&amp;")
        elif ch == "<":
            out.append("&lt;")
        elif ch == ">":
            out.append("&gt;")
        elif ch == '"':
            out.append("&quot;")
        elif ch == "'":
            out.append("&apos;")
        elif ch in "‘’‚‛":
            out.append(f"&#x{ord(ch):04X};")
        else:
            out.append(ch)
    return "".join(out)


def _ps_single_quote(text: str) -> str:
    """Return ``text`` as a PowerShell single-quoted literal."""
    for quote in ("'", "‘", "’", "‚", "‛"):
        text = text.replace(quote, quote * 2)
    return "'" + text + "'"


# --------------------------------------------------------------------------- #
# Per-platform command builders (pure, unit-tested)
# --------------------------------------------------------------------------- #


def build_macos_command(title: str, body: str) -> list[str]:
    cmd = ["osascript"]
    for line in _OSASCRIPT_SOURCE:
        cmd += ["-e", line]
    return cmd + [title, body]


def build_windows_script(title: str, body: str) -> str:
    xml = (
        "<toast><visual><binding template=\"ToastGeneric\">"
        f"<text>{_xml_escape(title)}</text>"
        f"<text>{_xml_escape(body)}</text>"
        "</binding></visual>"
        "<audio src=\"ms-winsoundevent:Notification.Default\"/></toast>"
    )
    return "\n".join(
        (
            "$ErrorActionPreference = 'Stop'",
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, "
            "ContentType = WindowsRuntime] | Out-Null",
            "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, "
            "ContentType = WindowsRuntime] | Out-Null",
            "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
            f"$xml.LoadXml({_ps_single_quote(xml)})",
            "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
            "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
            f"{_ps_single_quote(_PS_APP_ID)}).Show($toast)",
        )
    )


def build_windows_command(powershell: str, title: str, body: str) -> list[str]:
    encoded = base64.b64encode(build_windows_script(title, body).encode("utf-16-le")).decode("ascii")
    return [
        powershell,
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
    ]


def build_linux_command(notify_send: str, title: str, body: str) -> list[str]:
    return [
        notify_send,
        f"--app-name={APP_NAME}",
        "--expire-time=8000",
        "--",
        title,
        body,
    ]


# --------------------------------------------------------------------------- #
# Process handling
# --------------------------------------------------------------------------- #


def _reap(proc: subprocess.Popen) -> None:
    try:
        proc.wait(timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        log.debug("notification helper exceeded %.1fs; killing it", TIMEOUT_S)
        try:
            proc.kill()
            proc.wait(timeout=1)
        except Exception:  # noqa: BLE001 - best effort
            pass
    except Exception:  # noqa: BLE001 - best effort
        pass


def _spawn(cmd: Sequence[str], creationflags: int = 0) -> None:
    proc = subprocess.Popen(  # noqa: S603 - list args, shell=False
        list(cmd),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        shell=False,
        close_fds=True,
        creationflags=creationflags,
    )
    threading.Thread(target=_reap, args=(proc,), name="airbridge-notify", daemon=True).start()


def _which(*names: str) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


def send_notification(title: str, body: str) -> None:
    """Show a native desktop notification. Never raises; returns immediately."""
    try:
        clean_title = _clean(title, MAX_TITLE_CHARS) or APP_NAME
        clean_body = _clean(body, MAX_BODY_CHARS) or " "
        system = platform.system()

        if system == "Darwin":
            _spawn(build_macos_command(clean_title, clean_body))
        elif system == "Windows":
            powershell = _which("powershell.exe", "powershell", "pwsh.exe", "pwsh")
            if not powershell:
                log.debug("notification skipped: PowerShell not found")
                return
            _spawn(build_windows_command(powershell, clean_title, clean_body), CREATE_NO_WINDOW)
        elif system == "Linux":
            notify_send = _which("notify-send")
            if not notify_send:
                log.debug("notification skipped: notify-send not found")
                return
            _spawn(build_linux_command(notify_send, clean_title, clean_body))
        else:
            log.debug("notification skipped: unsupported platform %r", system)
    except Exception as exc:  # noqa: BLE001 - notifications are best effort
        log.debug("notification failed: %s", exc)


__all__ = ["send_notification"]
