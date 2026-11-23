#!/usr/bin/env python3
"""AirBridge installer: one command on macOS, Windows and Linux.

    python3 install.py              # create .venv, install deps, print config
    python3 install.py --dry-run    # skip venv and pip; just print config
    python3 install.py --json-only  # machine-friendly: print only the JSON
    python3 install.py --venv PATH  # use a different virtual environment

Standard library only, and deliberately written to *start* on old Pythons so
it can explain that 3.11+ is required instead of crashing on syntax.
This is the only AirBridge file that is allowed to print.
"""

from __future__ import annotations

import argparse
import json
import ntpath
import os
import posixpath
import shutil
import subprocess
import sys
from pathlib import Path

MIN_PYTHON = (3, 11)
HERE = Path(__file__).resolve().parent
DEFAULT_VENV = HERE / ".venv"
MAIN_PY = HERE / "main.py"
REQUIREMENTS = HERE / "requirements.txt"

TAILSCALE_FALLBACKS = (
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    r"C:\Program Files\Tailscale\tailscale.exe",
)


# --------------------------------------------------------------------------- #
# Pure helpers (unit-tested)
# --------------------------------------------------------------------------- #


def venv_python_path(venv_dir: str | os.PathLike, os_name: str | None = None) -> str:
    """Path of the interpreter inside ``venv_dir`` for ``os_name`` ("nt"/"posix")."""
    os_name = os.name if os_name is None else os_name
    if os_name == "nt":
        return ntpath.join(str(venv_dir), "Scripts", "python.exe")
    return posixpath.join(str(venv_dir), "bin", "python")


def build_config_snippet(python_path: str, main_path: str) -> dict:
    """The ``mcpServers`` block used by Claude Desktop and Cursor."""
    return {"mcpServers": {"airbridge": {"command": str(python_path), "args": [str(main_path)]}}}


def build_codex_toml(python_path: str, main_path: str) -> str:
    """The Codex CLI equivalent (``~/.codex/config.toml``).

    JSON string escaping with ``ensure_ascii`` is a valid TOML basic string, so
    Windows backslashes and any unusual characters are encoded correctly.
    """
    command = json.dumps(str(python_path), ensure_ascii=True)
    arg = json.dumps(str(main_path), ensure_ascii=True)
    return f"[mcp_servers.airbridge]\ncommand = {command}\nargs = [{arg}]\n"


def client_config_locations(system: str, home: str, appdata: str | None = None) -> dict:
    """Where each AI client keeps its MCP configuration on ``system``."""
    if system == "Windows":
        join = ntpath.join
        base = appdata or ntpath.join(home, "AppData", "Roaming")
        claude = ntpath.join(base, "Claude", "claude_desktop_config.json")
    else:
        join = posixpath.join
        if system == "Darwin":
            claude = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        else:
            claude = join(home, ".config", "Claude", "claude_desktop_config.json")
    return {
        "Claude Desktop": claude,
        "Cursor": join(home, ".cursor", "mcp.json"),
        "Codex": join(home, ".codex", "config.toml"),
    }


def find_tailscale() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    for candidate in TAILSCALE_FALLBACKS:
        if os.path.isfile(candidate):
            return candidate
    return None


# --------------------------------------------------------------------------- #
# Terminal presentation
# --------------------------------------------------------------------------- #


def _supports_unicode(stream) -> bool:
    encoding = getattr(stream, "encoding", None) or "ascii"
    try:
        "✓•✗─…→".encode(encoding)
    except (UnicodeEncodeError, LookupError):
        return False
    return True


def _enable_windows_ansi() -> bool:
    if os.name != "nt":
        return True
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:  # noqa: BLE001
        return False


class UI:
    """Calm, consistent step output. Quiet mode prints nothing at all."""

    def __init__(self, stream=None, quiet: bool = False, color: bool | None = None):
        self.stream = stream or sys.stdout
        self.quiet = quiet
        unicode_ok = _supports_unicode(self.stream)
        self.sym = (
            {"ok": "✓", "info": "•", "warn": "•", "fail": "✗", "rule": "─", "arrow": "→", "dots": "…"}
            if unicode_ok
            else {"ok": "+", "info": "*", "warn": "!", "fail": "x", "rule": "-", "arrow": "->", "dots": "..."}
        )
        if color is None:
            isatty = getattr(self.stream, "isatty", lambda: False)
            color = bool(isatty()) and "NO_COLOR" not in os.environ and _enable_windows_ansi()
        self.color = color

    def _c(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.color else text

    def bold(self, text: str) -> str:
        return self._c("1", text)

    def dim(self, text: str) -> str:
        return self._c("2", text)

    def _emit(self, line: str = "") -> None:
        if not self.quiet:
            print(line, file=self.stream, flush=True)

    def blank(self) -> None:
        self._emit()

    def title(self, text: str) -> None:
        self._emit()
        self._emit("  " + self.bold(text))
        self._emit("  " + self.dim(self.sym["rule"] * len(text)))

    def section(self, text: str) -> None:
        self._emit()
        self._emit("  " + self.bold(text))

    def ok(self, text: str, detail: str = "") -> None:
        self._step(self._c("32", self.sym["ok"]), text, detail)

    def info(self, text: str, detail: str = "") -> None:
        self._step(self.dim(self.sym["info"]), text, detail)

    def warn(self, text: str, detail: str = "") -> None:
        self._step(self._c("33", self.sym["warn"]), text, detail)

    def fail(self, text: str, detail: str = "") -> None:
        self._step(self._c("31", self.sym["fail"]), text, detail)

    def _step(self, marker: str, text: str, detail: str) -> None:
        self._emit(f"  {marker} {text}" + (f"  {self.dim(detail)}" if detail else ""))

    def hint(self, text: str) -> None:
        self._emit("    " + self.dim(text))

    def block(self, text: str) -> None:
        for line in text.rstrip("\n").splitlines():
            self._emit("    " + line)


def _short(path: Path | str) -> str:
    """Show paths under the home directory as ``~/...`` for calmer output."""
    path = str(path)
    home = str(Path.home())
    if path == home or path.startswith(home + os.sep):
        return "~" + path[len(home):]
    return path


# --------------------------------------------------------------------------- #
# Steps
# --------------------------------------------------------------------------- #


class InstallError(RuntimeError):
    def __init__(self, message: str, hint: str = "", output: str = ""):
        super().__init__(message)
        self.hint = hint
        self.output = output


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(  # noqa: S603 - list args, shell=False
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, shell=False, check=False, **kwargs
    )


def check_python(ui: UI, version: tuple = tuple(sys.version_info[:3])) -> None:
    pretty = ".".join(str(part) for part in version[:3])
    if tuple(version[:2]) < MIN_PYTHON:
        raise InstallError(
            f"Python {pretty} is too old",
            hint="AirBridge needs Python 3.11 or newer. Get it from https://www.python.org/downloads/ "
            "and run this installer again with that interpreter.",
        )
    ui.ok(f"Python {pretty}")


def create_venv(ui: UI, venv_dir: Path) -> str:
    python = venv_python_path(venv_dir)
    if Path(python).is_file():
        ui.ok("Virtual environment ready", _short(venv_dir))
        return python
    ui.info(f"Creating virtual environment{ui.sym['dots']}")
    result = _run([sys.executable, "-m", "venv", str(venv_dir)])
    if result.returncode != 0 or not Path(python).is_file():
        hint = "On Debian/Ubuntu, install the venv module first: sudo apt install python3-venv"
        raise InstallError("Could not create the virtual environment", hint=hint, output=result.stdout)
    ui.ok("Virtual environment created", _short(venv_dir))
    return python


def install_requirements(ui: UI, python: str) -> None:
    if not REQUIREMENTS.is_file():
        raise InstallError("requirements.txt is missing", hint=f"Expected it at {REQUIREMENTS}")
    ui.info(f"Installing dependencies{ui.sym['dots']}", "this can take a minute")
    result = _run(
        [python, "-m", "pip", "install", "--disable-pip-version-check", "--quiet", "-r", str(REQUIREMENTS)]
    )
    if result.returncode != 0:
        raise InstallError(
            "Dependency installation failed",
            hint="Check your internet connection, then run the installer again.",
            output=result.stdout,
        )
    ui.ok("Dependencies installed")


def check_tailscale(ui: UI) -> None:
    path = find_tailscale()
    if path:
        ui.ok("Tailscale found", _short(path))
    else:
        ui.warn("Tailscale not found", "AirBridge needs it at runtime")
        ui.hint("Install it from https://tailscale.com/download and sign in on every computer.")


def show_config(ui: UI, python: str, main: str) -> None:
    snippet = json.dumps(build_config_snippet(python, main), indent=2)
    places = client_config_locations(
        _platform_system(), str(Path.home()), os.environ.get("APPDATA")
    )

    ui.section("Connect your AI client")
    ui.hint("Add AirBridge to the client you use, then restart it.")

    ui.blank()
    ui.info(ui.bold("Claude Desktop"), _short(places["Claude Desktop"]))
    ui.hint("Merge into the file (keep any servers you already have):")
    ui.blank()
    ui.block(snippet)

    ui.blank()
    ui.info(ui.bold("Cursor"), _short(places["Cursor"]))
    ui.hint("Same JSON as above.")

    ui.blank()
    ui.info(ui.bold("Codex"), _short(places["Codex"]))
    ui.blank()
    ui.block(build_codex_toml(python, main))

    ui.section("Next")
    ui.hint(f"Check everything works:  {_short(python)} {_short(main)} --check")
    ui.hint("Then ask your assistant: \u201cList my AirBridge nodes.\u201d")
    ui.blank()


def _platform_system() -> str:
    import platform

    return platform.system()


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="install.py",
        description="Set up AirBridge and print the MCP configuration for your AI client.",
    )
    parser.add_argument("--dry-run", action="store_true", help="skip venv and pip; just print the config")
    parser.add_argument("--json-only", action="store_true", help="print only the JSON config (machine-friendly)")
    parser.add_argument("--venv", metavar="PATH", default=str(DEFAULT_VENV), help="virtual environment location")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    venv_dir = Path(args.venv).expanduser().resolve()
    python = venv_python_path(venv_dir)
    main_py = str(MAIN_PY)
    ui = UI(quiet=args.json_only)

    ui.title("AirBridge setup" + (" (dry run)" if args.dry_run else ""))
    try:
        check_python(ui)
        if args.dry_run:
            ui.info("Skipping virtual environment and dependencies", "dry run")
        else:
            python = create_venv(ui, venv_dir)
            install_requirements(ui, python)
        check_tailscale(ui)
    except InstallError as exc:
        err = UI(stream=sys.stderr)
        err.fail(str(exc))
        if exc.hint:
            err.hint(exc.hint)
        if exc.output:
            tail = exc.output.strip().splitlines()[-12:]
            err.blank()
            err.block("\n".join(tail))
        err.blank()
        return 1

    if args.json_only:
        print(json.dumps(build_config_snippet(python, main_py), indent=2))
        return 0

    ui.blank()
    ui.ok(ui.bold("AirBridge is installed." if not args.dry_run else "Configuration ready."))
    show_config(ui, python, main_py)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n  Cancelled.", file=sys.stderr)
        sys.exit(130)
