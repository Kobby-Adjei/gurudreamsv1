#!/usr/bin/env python3
"""AirBridge setup: a friendly, guided installer for macOS, Windows and Linux.

Most people never run this directly. They double-click
"Install AirBridge.command" (macOS) or "Install AirBridge.bat" (Windows).

    python3 install.py              # guided setup
    python3 install.py --yes        # accept every offer; never wait for input
    python3 install.py --dry-run    # change nothing; just show what would happen
    python3 install.py --json-only  # print only the JSON config (for scripts)
    python3 install.py --venv PATH  # keep AirBridge's private Python elsewhere

Standard library only, and written so it still *starts* on old Pythons and
can explain that 3.11 or newer is needed. This is the only AirBridge file that
is allowed to print.
"""

from __future__ import annotations

import argparse
import json
import ntpath
import os
import platform
import posixpath
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

MIN_PYTHON = (3, 11)
HERE = Path(__file__).resolve().parent
DEFAULT_VENV = HERE / ".venv"
MAIN_PY = HERE / "main.py"
REQUIREMENTS = HERE / "requirements.txt"
SERVER_NAME = "airbridge"
TOTAL_STEPS = 4

PYTHON_URL = "https://www.python.org/downloads/"
TAILSCALE_URL = "https://tailscale.com/download"
CLAUDE_URL = "https://claude.ai/download"

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


def build_server_entry(python_path: str, main_path: str) -> dict:
    return {"command": str(python_path), "args": [str(main_path)]}


def build_config_snippet(python_path: str, main_path: str) -> dict:
    """The ``mcpServers`` block used by Claude Desktop and Cursor."""
    return {"mcpServers": {SERVER_NAME: build_server_entry(python_path, main_path)}}


def build_codex_toml(python_path: str, main_path: str) -> str:
    """The Codex CLI equivalent (``~/.codex/config.toml``).

    JSON string escaping with ``ensure_ascii`` is a valid TOML basic string, so
    Windows backslashes and unusual characters are encoded correctly.
    """
    command = json.dumps(str(python_path), ensure_ascii=True)
    arg = json.dumps(str(main_path), ensure_ascii=True)
    return f"[mcp_servers.{SERVER_NAME}]\ncommand = {command}\nargs = [{arg}]\n"


def client_config_locations(system: str, home: str, appdata: str | None = None) -> dict:
    """Where each AI app keeps its MCP configuration on ``system``."""
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


class ConfigMergeError(ValueError):
    """The existing config can't be merged safely; it is left untouched."""


def merge_mcp_config(existing_text: str | None, entry: dict, name: str = SERVER_NAME) -> tuple[str, str]:
    """Merge ``entry`` as ``mcpServers[name]`` into a JSON config's text.

    Returns ``(new_text, status)`` where status is ``"created"`` (no file or an
    empty one), ``"added"``, ``"updated"`` or ``"unchanged"``. Every other key
    and every other server is preserved. Raises :class:`ConfigMergeError` for
    anything that is not a JSON object we understand, so a file the user is
    halfway through editing is never overwritten.
    """
    if existing_text is None or not existing_text.strip():
        data: dict = {}
        status = "created"
    else:
        try:
            data = json.loads(existing_text)
        except ValueError as exc:
            raise ConfigMergeError(f"the file is not valid JSON ({exc})") from None
        if not isinstance(data, dict):
            raise ConfigMergeError("the file does not contain a JSON object")
        status = None

    servers = data.get("mcpServers")
    if servers is None:
        servers = {}
    elif not isinstance(servers, dict):
        raise ConfigMergeError('"mcpServers" is not a JSON object')

    if status is None:
        if name not in servers:
            status = "added"
        elif servers[name] == entry:
            return existing_text, "unchanged"
        else:
            status = "updated"

    merged = dict(data)
    merged_servers = dict(servers)
    merged_servers[name] = entry
    merged["mcpServers"] = merged_servers
    return json.dumps(merged, indent=2, ensure_ascii=False) + "\n", status


def backup_path_for(path: Path, now: datetime | None = None) -> Path:
    """``<file>.bak-YYYYMMDD-HHMMSS``, with a counter if that already exists."""
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    candidate = path.with_name(f"{path.name}.bak-{stamp}")
    counter = 1
    while candidate.exists():
        candidate = path.with_name(f"{path.name}.bak-{stamp}-{counter}")
        counter += 1
    return candidate


def apply_client_config(path: Path, entry: dict, now: datetime | None = None) -> tuple[str, Path | None]:
    """Safely add AirBridge to the JSON config at ``path``.

    Backs up any existing file before changing it, writes atomically, and
    raises :class:`ConfigMergeError` (touching nothing) if the file can't be
    understood. Returns ``(status, backup_path_or_None)``.
    """
    path = Path(path)
    existing = None
    if path.exists():
        if not path.is_file():
            raise ConfigMergeError("the path exists but is not a file")
        existing = path.read_text(encoding="utf-8-sig")

    new_text, status = merge_mcp_config(existing, entry)
    if status == "unchanged":
        return status, None

    path.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if existing is not None:
        backup = backup_path_for(path, now)
        shutil.copy2(path, backup)

    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(new_text)
        if existing is not None:
            try:
                shutil.copymode(path, tmp_name)
            except OSError:
                pass
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return status, backup


def parse_tailscale_status(text: str) -> tuple[bool, str | None, str | None]:
    """From ``tailscale status --json``: (running, this computer's name, its 100.x IP)."""
    try:
        data = json.loads(text)
    except ValueError:
        return False, None, None
    if not isinstance(data, dict):
        return False, None, None
    running = data.get("BackendState") == "Running"
    me = data.get("Self") if isinstance(data.get("Self"), dict) else {}
    name = me.get("HostName") or None
    ip = next((addr for addr in me.get("TailscaleIPs") or [] if "." in str(addr)), None)
    return running, name, ip


def find_tailscale() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    for candidate in TAILSCALE_FALLBACKS:
        if os.path.isfile(candidate):
            return candidate
    return None


def tailscale_state() -> tuple[str, str | None, str | None]:
    """``("missing" | "stopped" | "running", hostname, ip)``."""
    binary = find_tailscale()
    if not binary:
        return "missing", None, None
    try:
        result = _run([binary, "status", "--json"], timeout=8)
    except (OSError, subprocess.SubprocessError):
        return "stopped", None, None
    running, name, ip = parse_tailscale_status(result.stdout or "")
    return ("running" if running else "stopped"), name, ip


# --------------------------------------------------------------------------- #
# Terminal presentation
# --------------------------------------------------------------------------- #


def _supports_unicode(stream) -> bool:
    encoding = getattr(stream, "encoding", None) or "ascii"
    try:
        "✓•✗─…→—“”".encode(encoding)
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
    """Calm, consistent output and prompts. Quiet mode prints nothing at all."""

    def __init__(self, stream=None, quiet: bool = False, color: bool | None = None, interactive: bool = False):
        self.stream = stream or sys.stdout
        self.quiet = quiet
        self.interactive = interactive and not quiet
        self.unicode = _supports_unicode(self.stream)
        self.sym = (
            {"ok": "✓", "info": "•", "warn": "•", "fail": "✗", "rule": "─", "dash": "—", "dots": "…",
             "lq": "“", "rq": "”"}
            if self.unicode
            else {"ok": "+", "info": "*", "warn": "!", "fail": "x", "rule": "-", "dash": "-", "dots": "...",
                  "lq": '"', "rq": '"'}
        )
        if color is None:
            isatty = getattr(self.stream, "isatty", lambda: False)
            color = bool(isatty()) and "NO_COLOR" not in os.environ and _enable_windows_ansi()
        self.color = color

    # styling -------------------------------------------------------------
    def _c(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.color else text

    def bold(self, text: str) -> str:
        return self._c("1", text)

    def dim(self, text: str) -> str:
        return self._c("2", text)

    def quote(self, text: str) -> str:
        return f"{self.sym['lq']}{text}{self.sym['rq']}"

    # output --------------------------------------------------------------
    def _emit(self, line: str = "") -> None:
        if not self.quiet:
            print(line, file=self.stream, flush=True)

    def blank(self) -> None:
        self._emit()

    def title(self, text: str) -> None:
        self._emit()
        self._emit("  " + self.bold(text))
        self._emit("  " + self.dim(self.sym["rule"] * len(text)))

    def step(self, number: int, text: str) -> None:
        self._emit()
        self._emit("  " + self.bold(f"Step {number} of {TOTAL_STEPS} {self.sym['dash']} {text}"))

    def section(self, text: str) -> None:
        self._emit()
        self._emit("  " + self.bold(text))

    def ok(self, text: str, detail: str = "") -> None:
        self._line(self._c("32", self.sym["ok"]), text, detail)

    def info(self, text: str, detail: str = "") -> None:
        self._line(self.dim(self.sym["info"]), text, detail)

    def warn(self, text: str, detail: str = "") -> None:
        self._line(self._c("33", self.sym["warn"]), text, detail)

    def fail(self, text: str, detail: str = "") -> None:
        self._line(self._c("31", self.sym["fail"]), text, detail)

    def _line(self, marker: str, text: str, detail: str) -> None:
        self._emit(f"  {marker} {text}" + (f"  {self.dim(detail)}" if detail else ""))

    def hint(self, text: str) -> None:
        self._emit("    " + text)

    def note(self, text: str) -> None:
        self._emit("    " + self.dim(text))

    def block(self, text: str) -> None:
        for line in text.rstrip("\n").splitlines():
            self._emit("      " + line)

    # input ---------------------------------------------------------------
    def _input(self, prompt: str) -> str | None:
        try:
            return input(prompt)
        except (EOFError, KeyboardInterrupt):
            self._emit()
            return None

    def ask_yes_no(self, question: str, default: bool = True) -> bool | None:
        """Ask a yes/no question. Returns None when we can't ask (non-interactive)."""
        if not self.interactive:
            return None
        choices = "[Y/n]" if default else "[y/N]"
        while True:
            answer = self._input(f"    {question} {self.dim(choices)} ")
            if answer is None:
                return default
            answer = answer.strip().lower()
            if not answer:
                return default
            if answer in ("y", "yes"):
                return True
            if answer in ("n", "no"):
                return False
            self.note("Please type Y for yes or N for no, then press Enter.")

    def wait_for_enter(self, message: str) -> bool:
        """Wait for Enter (True) or S to skip (False). Never blocks when non-interactive."""
        if not self.interactive:
            return False
        answer = self._input(f"    {message} {self.dim('(or type S and Enter to skip)')} ")
        if answer is None:
            return False
        return answer.strip().lower() not in ("s", "skip")


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
    """A step failed. ``hint`` is one sentence saying exactly what to do next."""

    def __init__(self, message: str, hint: str = "", output: str = ""):
        super().__init__(message)
        self.hint = hint
        self.output = output


def _run(cmd: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(  # noqa: S603 - list args, shell=False
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=False,
        check=False,
        timeout=timeout,
        **kwargs,
    )


def check_python(ui: UI, version: tuple = tuple(sys.version_info[:3])) -> None:
    pretty = ".".join(str(part) for part in version[:3])
    if tuple(version[:2]) < MIN_PYTHON:
        raise InstallError(
            f"This computer has Python {pretty}, but AirBridge needs 3.11 or newer.",
            hint=f"Install the latest Python from {PYTHON_URL}, then run Install AirBridge again.",
        )
    ui.ok("Your computer is ready", f"Python {pretty}")


def create_venv(ui: UI, venv_dir: Path) -> str:
    python = venv_python_path(venv_dir)
    if Path(python).is_file():
        ui.ok("AirBridge's private workspace is ready", _short(venv_dir))
        return python
    ui.info(f"Preparing a private workspace for AirBridge{ui.sym['dots']}")
    result = _run([sys.executable, "-m", "venv", str(venv_dir)])
    if result.returncode != 0 or not Path(python).is_file():
        if platform.system() == "Linux":
            hint = "Run  sudo apt install python3-venv  in a terminal, then run the installer again."
        else:
            hint = f"Reinstall Python from {PYTHON_URL}, then run Install AirBridge again."
        raise InstallError("AirBridge couldn't create its private workspace.", hint=hint, output=result.stdout)
    ui.ok("Private workspace created", _short(venv_dir))
    return python


def install_requirements(ui: UI, python: str) -> None:
    if not REQUIREMENTS.is_file():
        raise InstallError(
            "Some AirBridge files are missing.",
            hint="Download AirBridge again and run the installer from the new folder.",
        )
    ui.info(f"Downloading AirBridge's components{ui.sym['dots']}", "about a minute")
    result = _run(
        [python, "-m", "pip", "install", "--disable-pip-version-check", "--quiet", "-r", str(REQUIREMENTS)]
    )
    if result.returncode != 0:
        raise InstallError(
            "AirBridge couldn't download its components.",
            hint="Check that you're connected to the internet, then run the installer again.",
            output=result.stdout,
        )
    ui.ok("AirBridge is installed")


def check_tailscale(ui: UI) -> bool:
    """Make sure Tailscale is installed and signed in, helping the user if not."""
    while True:
        state, name, ip = tailscale_state()
        if state == "running":
            detail = f"this computer is {ui.quote(name)}" if name else (ip or "")
            ui.ok("Tailscale is on", detail)
            return True
        if state == "missing":
            ui.warn("Tailscale isn't installed yet.")
            ui.hint(f"Get it from {TAILSCALE_URL} and sign in, on this computer and the other one.")
            prompt = "When it's installed and you've signed in, press Enter to check again."
        else:
            ui.warn("Tailscale is installed but not connected.")
            prompt = "Open the Tailscale app and sign in, then press Enter to check again."
        if not ui.wait_for_enter(prompt):
            if ui.interactive:
                ui.note("Skipped for now. AirBridge will start working as soon as Tailscale is on.")
            elif state == "stopped":
                ui.hint("Open the Tailscale app and sign in; AirBridge will start working as soon as it's on.")
            else:
                ui.note("AirBridge will start working as soon as Tailscale is on.")
            return False


def offer_client_config(ui: UI, app: str, path: Path, entry: dict, auto_yes: bool, dry_run: bool) -> str:
    """Offer to add AirBridge to one app's config. Returns a short outcome code."""
    if dry_run:
        ui.info(f"Would add AirBridge to {app}", _short(path))
        return "dry-run"

    if auto_yes:
        accepted = True
    else:
        answer = ui.ask_yes_no(f"Add AirBridge to {app} for you?", default=True)
        if answer is None:
            ui.info(f"{app} found", "run again with --yes to set it up automatically")
            return "not-asked"
        accepted = answer
    if not accepted:
        ui.info(f"Okay, {app} was left as it is.")
        return "declined"

    try:
        status, backup = apply_client_config(path, entry)
    except ConfigMergeError as exc:
        ui.warn(f"{app}'s settings file couldn't be read safely, so it wasn't changed.", str(exc))
        ui.hint("Fix or remove that file, or add the settings shown at the end by hand.")
        return "error"
    except OSError as exc:
        ui.warn(f"AirBridge couldn't save {app}'s settings.", exc.strerror or str(exc))
        ui.hint("Add the settings shown at the end by hand.")
        return "error"

    if status == "unchanged":
        ui.ok(f"{app} already knows about AirBridge")
    else:
        ui.ok(f"AirBridge added to {app}", _short(path))
        if backup:
            ui.note(f"Your previous settings were saved to {_short(backup)}")
    return "configured"


def connect_apps(ui: UI, python: str, main: str, auto_yes: bool, dry_run: bool) -> dict:
    entry = build_server_entry(python, main)
    places = client_config_locations(platform.system(), str(Path.home()), os.environ.get("APPDATA"))
    outcomes: dict = {}

    claude = Path(places["Claude Desktop"])
    if claude.exists() or claude.parent.is_dir():
        outcomes["Claude Desktop"] = offer_client_config(ui, "Claude Desktop", claude, entry, auto_yes, dry_run)
    else:
        ui.info("Claude Desktop isn't installed on this computer yet.")
        ui.hint(f"Get it from {CLAUDE_URL}, open it once, then run Install AirBridge again.")
        outcomes["Claude Desktop"] = "missing"

    cursor = Path(places["Cursor"])
    if cursor.exists() or cursor.parent.is_dir():
        outcomes["Cursor"] = offer_client_config(ui, "Cursor", cursor, entry, auto_yes, dry_run)
    return outcomes


def show_manual_config(ui: UI, python: str, main: str, outcomes: dict) -> None:
    places = client_config_locations(platform.system(), str(Path.home()), os.environ.get("APPDATA"))
    snippet = json.dumps(build_config_snippet(python, main), indent=2)
    needs_json = [app for app in ("Claude Desktop", "Cursor") if outcomes.get(app) != "configured"]

    ui.section("For other AI apps (optional)")
    if needs_json:
        for app in needs_json:
            ui.info(f"{app}: add this to", _short(places[app]))
        ui.note("Keep any servers already in the file; add the \"airbridge\" entry.")
        ui.blank()
        ui.block(snippet)
        ui.blank()
    ui.info("Codex: add this to", _short(places["Codex"]))
    ui.blank()
    ui.block(build_codex_toml(python, main))


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="install.py",
        description="Set up AirBridge and connect it to Claude Desktop or Cursor.",
    )
    parser.add_argument("--yes", "-y", action="store_true", help="accept every offer; never wait for input")
    parser.add_argument("--dry-run", action="store_true", help="change nothing; show what would happen")
    parser.add_argument("--json-only", action="store_true", help="print only the JSON config (machine-friendly)")
    parser.add_argument("--venv", metavar="PATH", default=str(DEFAULT_VENV), help="where AirBridge's private Python lives")
    return parser.parse_args(argv)


def _stdin_is_interactive() -> bool:
    try:
        return bool(sys.stdin and sys.stdin.isatty())
    except (AttributeError, ValueError):
        return False


def _report_error(exc: InstallError) -> None:
    err = UI(stream=sys.stderr)
    err.blank()
    err.fail(str(exc))
    if exc.hint:
        err.hint(exc.hint)
    if exc.output:
        err.blank()
        err.note("Details, in case you need to ask for help:")
        err.block("\n".join(exc.output.strip().splitlines()[-12:]))
    err.blank()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    venv_dir = Path(args.venv).expanduser().resolve()
    python = venv_python_path(venv_dir)
    main_py = str(MAIN_PY)

    if args.json_only:
        try:
            check_python(UI(quiet=True))
            if not args.dry_run:
                quiet = UI(quiet=True)
                python = create_venv(quiet, venv_dir)
                install_requirements(quiet, python)
        except InstallError as exc:
            _report_error(exc)
            return 1
        print(json.dumps(build_config_snippet(python, main_py), indent=2))
        return 0

    interactive = _stdin_is_interactive() and not args.yes and not args.dry_run
    ui = UI(interactive=interactive)

    ui.title("Welcome to AirBridge" + (" (practice run: nothing will be changed)" if args.dry_run else ""))
    ui.note("This takes about two minutes. You can press Ctrl+C at any time to stop.")

    try:
        ui.step(1, f"Checking your computer{ui.sym['dots']}")
        check_python(ui)

        ui.step(2, f"Installing AirBridge{ui.sym['dots']}")
        if args.dry_run:
            ui.info("Skipped in a practice run")
        else:
            python = create_venv(ui, venv_dir)
            install_requirements(ui, python)
    except InstallError as exc:
        _report_error(exc)
        return 1

    ui.step(3, f"Checking Tailscale{ui.sym['dots']}")
    tailscale_ok = check_tailscale(ui)

    ui.step(4, f"Connecting to Claude{ui.sym['dots']}")
    outcomes = connect_apps(ui, python, main_py, auto_yes=args.yes, dry_run=args.dry_run)

    show_manual_config(ui, python, main_py, outcomes)

    if args.dry_run:
        ui.section("Practice run finished")
        ui.hint("Nothing was changed. Run the installer without --dry-run to set AirBridge up.")
        ui.blank()
        return 0

    ui.section("You're all set" if tailscale_ok else "Almost there")
    if not tailscale_ok:
        ui.hint("Open the Tailscale app and sign in on this computer.")
    if outcomes.get("Claude Desktop") == "configured":
        ui.hint(
            f"Restart Claude Desktop, then ask Claude: {ui.quote('List my AirBridge nodes')}"
        )
        system = platform.system()
        if system == "Darwin":
            ui.note("To restart: click Claude in the menu bar, choose Quit Claude, then open it again.")
        elif system == "Windows":
            ui.note("To restart: right-click the Claude icon near the clock, choose Quit, then open it again.")
    else:
        ui.hint(
            f"Add AirBridge to your AI app as shown above, restart it, then ask: "
            f"{ui.quote('List my AirBridge nodes')}"
        )
    ui.hint("Do the same on your other computer, so they can find each other.")
    ui.blank()
    ui.note(f"Having trouble? Run:  {_short(python)} {_short(main_py)} --check")
    ui.blank()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        # Output was piped into something that closed early (e.g. `| head`).
        try:
            sys.stdout = open(os.devnull, "w")
        except OSError:
            pass
        sys.exit(0)
    except KeyboardInterrupt:
        print("\n  Stopped. Nothing else was changed; run the installer again whenever you like.", file=sys.stderr)
        sys.exit(130)
