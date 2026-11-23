"""Tests for install.py: pure helpers, safe config merging, and the wizard flows."""

from __future__ import annotations

import builtins
import importlib.util
import io
import json
import sys
import tomllib
from datetime import datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ENTRY = {"command": "/v/bin/python", "args": ["/a/main.py"]}


@pytest.fixture(scope="module")
def install():
    spec = importlib.util.spec_from_file_location("airbridge_install", ROOT / "install.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------- #
# Paths and snippets
# --------------------------------------------------------------------------- #


def test_venv_python_path_posix(install):
    assert install.venv_python_path("/home/me/airbridge/.venv", "posix") == "/home/me/airbridge/.venv/bin/python"


def test_venv_python_path_nt(install):
    assert (
        install.venv_python_path(r"C:\Users\Me\airbridge\.venv", "nt")
        == r"C:\Users\Me\airbridge\.venv\Scripts\python.exe"
    )


def test_build_config_snippet_shape(install):
    snippet = install.build_config_snippet("/v/bin/python", "/a/main.py")
    assert snippet == {"mcpServers": {"airbridge": ENTRY}}


def test_windows_paths_survive_json(install):
    py = install.venv_python_path(r"C:\Users\Me\air bridge\.venv", "nt")
    snippet = install.build_config_snippet(py, r"C:\Users\Me\air bridge\main.py")
    text = json.dumps(snippet)
    assert "C:\\\\Users\\\\Me\\\\air bridge\\\\.venv\\\\Scripts\\\\python.exe" in text
    assert json.loads(text)["mcpServers"]["airbridge"]["command"] == py


def test_codex_toml_parses(install):
    py = r"C:\Users\Me\.venv\Scripts\python.exe"
    main = r'C:\Users\Me\"quoted"\main.py'
    parsed = tomllib.loads(install.build_codex_toml(py, main))
    assert parsed == {"mcp_servers": {"airbridge": {"command": py, "args": [main]}}}


def test_client_config_locations(install):
    mac = install.client_config_locations("Darwin", "/Users/me")
    assert mac["Claude Desktop"] == "/Users/me/Library/Application Support/Claude/claude_desktop_config.json"
    assert mac["Cursor"] == "/Users/me/.cursor/mcp.json"
    assert mac["Codex"] == "/Users/me/.codex/config.toml"

    win = install.client_config_locations("Windows", r"C:\Users\Me", r"C:\Users\Me\AppData\Roaming")
    assert win["Claude Desktop"] == r"C:\Users\Me\AppData\Roaming\Claude\claude_desktop_config.json"
    assert win["Cursor"] == r"C:\Users\Me\.cursor\mcp.json"
    assert win["Codex"] == r"C:\Users\Me\.codex\config.toml"

    win_no_env = install.client_config_locations("Windows", r"C:\Users\Me", None)
    assert win_no_env["Claude Desktop"].startswith(r"C:\Users\Me\AppData\Roaming\Claude")


# --------------------------------------------------------------------------- #
# merge_mcp_config (pure)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("text", [None, "", "  \n"])
def test_merge_into_missing_or_empty(install, text):
    new_text, status = install.merge_mcp_config(text, ENTRY)
    assert status == "created"
    assert json.loads(new_text) == {"mcpServers": {"airbridge": ENTRY}}


def test_merge_preserves_everything_else(install):
    existing = json.dumps(
        {"globalShortcut": "Ctrl+Space", "mcpServers": {"files": {"command": "npx", "args": ["fs"]}}}
    )
    new_text, status = install.merge_mcp_config(existing, ENTRY)
    assert status == "added"
    data = json.loads(new_text)
    assert data["globalShortcut"] == "Ctrl+Space"
    assert data["mcpServers"]["files"] == {"command": "npx", "args": ["fs"]}
    assert data["mcpServers"]["airbridge"] == ENTRY
    assert new_text.endswith("\n")


def test_merge_without_mcpservers_key(install):
    new_text, status = install.merge_mcp_config('{"theme": "dark"}', ENTRY)
    assert status == "added"
    assert json.loads(new_text) == {"theme": "dark", "mcpServers": {"airbridge": ENTRY}}


def test_merge_unchanged_returns_original_text(install):
    existing = '{"mcpServers":{"airbridge":{"command":"/v/bin/python","args":["/a/main.py"]}}}'
    assert install.merge_mcp_config(existing, ENTRY) == (existing, "unchanged")


def test_merge_updates_stale_entry(install):
    existing = json.dumps({"mcpServers": {"airbridge": {"command": "/old/python", "args": []}}})
    new_text, status = install.merge_mcp_config(existing, ENTRY)
    assert status == "updated"
    assert json.loads(new_text)["mcpServers"]["airbridge"] == ENTRY


def test_merge_keeps_unicode_readable(install):
    new_text, _ = install.merge_mcp_config('{"name": "Café ☕"}', ENTRY)
    assert "Café ☕" in new_text


@pytest.mark.parametrize(
    "text",
    ['{"mcpServers": {', "not json", "[1, 2]", '"string"', '{"mcpServers": []}', '{"mcpServers": "x"}'],
)
def test_merge_refuses_what_it_cannot_understand(install, text):
    with pytest.raises(install.ConfigMergeError):
        install.merge_mcp_config(text, ENTRY)


# --------------------------------------------------------------------------- #
# apply_client_config (filesystem, tmp_path)
# --------------------------------------------------------------------------- #

NOW = datetime(2026, 11, 23, 9, 41, 0)


def test_apply_creates_file_and_folders(install, tmp_path):
    path = tmp_path / "Claude" / "claude_desktop_config.json"
    status, backup = install.apply_client_config(path, ENTRY, NOW)
    assert (status, backup) == ("created", None)
    assert json.loads(path.read_text()) == {"mcpServers": {"airbridge": ENTRY}}
    assert list(path.parent.iterdir()) == [path]  # no stray temp files


def test_apply_backs_up_and_merges(install, tmp_path):
    path = tmp_path / "claude_desktop_config.json"
    original = '{\n  "mcpServers": {"other": {"command": "x"}}\n}\n'
    path.write_text(original)
    status, backup = install.apply_client_config(path, ENTRY, NOW)
    assert status == "added"
    assert backup == tmp_path / "claude_desktop_config.json.bak-20261123-094100"
    assert backup.read_text() == original
    data = json.loads(path.read_text())
    assert data["mcpServers"] == {"other": {"command": "x"}, "airbridge": ENTRY}


def test_apply_never_overwrites_backups(install, tmp_path):
    path = tmp_path / "mcp.json"
    path.write_text("{}")
    first = install.backup_path_for(path, NOW)
    first.write_text("older backup")
    _, backup = install.apply_client_config(path, ENTRY, NOW)
    assert backup.name == "mcp.json.bak-20261123-094100-1"
    assert first.read_text() == "older backup"


def test_apply_leaves_invalid_json_untouched(install, tmp_path):
    path = tmp_path / "claude_desktop_config.json"
    broken = '{"mcpServers": {"other": {"command": "x"},}'  # trailing comma
    path.write_text(broken)
    with pytest.raises(install.ConfigMergeError):
        install.apply_client_config(path, ENTRY, NOW)
    assert path.read_text() == broken
    assert sorted(p.name for p in tmp_path.iterdir()) == ["claude_desktop_config.json"]


def test_apply_unchanged_makes_no_backup(install, tmp_path):
    path = tmp_path / "mcp.json"
    path.write_text(json.dumps({"mcpServers": {"airbridge": ENTRY}}))
    assert install.apply_client_config(path, ENTRY, NOW) == ("unchanged", None)
    assert len(list(tmp_path.iterdir())) == 1


def test_apply_handles_utf8_bom(install, tmp_path):
    path = tmp_path / "claude_desktop_config.json"
    path.write_bytes(b'\xef\xbb\xbf{"mcpServers": {}}')
    status, _ = install.apply_client_config(path, ENTRY, NOW)
    assert status == "added"
    assert json.loads(path.read_text(encoding="utf-8"))["mcpServers"]["airbridge"] == ENTRY


def test_apply_refuses_directory(install, tmp_path):
    path = tmp_path / "mcp.json"
    path.mkdir()
    with pytest.raises(install.ConfigMergeError):
        install.apply_client_config(path, ENTRY, NOW)


# --------------------------------------------------------------------------- #
# Tailscale status parsing
# --------------------------------------------------------------------------- #


def test_parse_tailscale_status(install):
    running = json.dumps(
        {"BackendState": "Running", "Self": {"HostName": "studio-mac", "TailscaleIPs": ["fd7a::1", "100.64.0.9"]}}
    )
    assert install.parse_tailscale_status(running) == (True, "studio-mac", "100.64.0.9")
    assert install.parse_tailscale_status('{"BackendState": "NeedsLogin"}') == (False, None, None)
    assert install.parse_tailscale_status("garbage")[0] is False
    assert install.parse_tailscale_status("[]")[0] is False


def test_tailscale_missing(install, monkeypatch):
    monkeypatch.setattr(install, "find_tailscale", lambda: None)
    assert install.tailscale_state() == ("missing", None, None)


# --------------------------------------------------------------------------- #
# Wizard flows
# --------------------------------------------------------------------------- #


@pytest.fixture
def wizard(install, monkeypatch, tmp_path):
    """Fake home with Claude Desktop + Cursor installed; no real venv/pip/Tailscale."""
    home = tmp_path / "home"
    claude_dir = home / ".config" / "Claude"
    claude_dir.mkdir(parents=True)
    (home / ".cursor").mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("NO_COLOR", "1")
    monkeypatch.setattr(install.platform, "system", lambda: "Linux")
    monkeypatch.setattr(install, "create_venv", lambda ui, d: "/v/bin/python")
    monkeypatch.setattr(install, "install_requirements", lambda ui, py: None)
    monkeypatch.setattr(install, "tailscale_state", lambda: ("running", "studio-mac", "100.64.0.9"))
    monkeypatch.setattr(install, "_stdin_is_interactive", lambda: False)

    def no_input(*args):
        raise AssertionError("the installer must not wait for input here")

    monkeypatch.setattr(builtins, "input", no_input)
    return {"home": home, "claude": claude_dir / "claude_desktop_config.json", "cursor": home / ".cursor" / "mcp.json"}


def feed(monkeypatch, install, answers):
    monkeypatch.setattr(install, "_stdin_is_interactive", lambda: True)
    prompts = []
    queue = list(answers)

    def fake_input(prompt=""):
        prompts.append(prompt)
        return queue.pop(0)

    monkeypatch.setattr(builtins, "input", fake_input)
    return prompts


def test_yes_configures_claude_and_cursor(install, wizard, capsys):
    wizard["claude"].write_text('{"mcpServers": {"other": {"command": "x"}}}')
    assert install.main(["--yes"]) == 0
    out = capsys.readouterr().out
    claude = json.loads(wizard["claude"].read_text())
    assert claude["mcpServers"]["other"] == {"command": "x"}
    assert claude["mcpServers"]["airbridge"]["command"] == "/v/bin/python"
    assert json.loads(wizard["cursor"].read_text())["mcpServers"]["airbridge"]["args"] == [str(ROOT / "main.py")]
    assert list(wizard["claude"].parent.glob("claude_desktop_config.json.bak-*"))
    for expected in ("Step 1 of 4 — Checking your computer…", "Step 4 of 4 — Connecting to Claude…",
                     "Tailscale is on", "“studio-mac”", "AirBridge added to Claude Desktop",
                     "Restart Claude Desktop, then ask Claude: “List my AirBridge nodes”"):
        assert expected in out
    assert "venv" not in out.lower().replace(".venv", "")  # no jargon in the wizard


def test_non_interactive_without_yes_changes_nothing(install, wizard, capsys):
    assert install.main([]) == 0
    out = capsys.readouterr().out
    assert not wizard["claude"].exists() and not wizard["cursor"].exists()
    assert "--yes" in out and '"mcpServers"' in out


def test_interactive_default_yes_and_decline(install, wizard, monkeypatch, capsys):
    prompts = feed(monkeypatch, install, ["", "n"])  # Claude: Enter (yes), Cursor: no
    assert install.main([]) == 0
    assert wizard["claude"].exists() and not wizard["cursor"].exists()
    assert "[Y/n]" in prompts[0] and "Claude Desktop" in prompts[0]
    assert "Cursor was left as it is" in capsys.readouterr().out


def test_invalid_claude_config_is_not_clobbered(install, wizard, capsys):
    broken = "{ this is not json"
    wizard["claude"].write_text(broken)
    assert install.main(["--yes"]) == 0
    out = capsys.readouterr().out
    assert wizard["claude"].read_text() == broken
    assert "couldn't be read safely, so it wasn't changed" in out
    assert '"mcpServers"' in out  # manual snippet shown instead


def test_tailscale_retry_on_enter(install, wizard, monkeypatch, capsys):
    states = iter([("stopped", None, None), ("running", "pc", "100.64.0.2")])
    monkeypatch.setattr(install, "tailscale_state", lambda: next(states))
    prompts = feed(monkeypatch, install, ["", "", ""])  # Enter to re-check, then yes, yes
    assert install.main([]) == 0
    assert "Open the Tailscale app and sign in, then press Enter to check again." in prompts[0]
    assert "Tailscale is on" in capsys.readouterr().out


def test_tailscale_missing_never_blocks_non_interactive(install, wizard, monkeypatch, capsys):
    monkeypatch.setattr(install, "tailscale_state", lambda: ("missing", None, None))
    assert install.main(["--yes"]) == 0
    out = capsys.readouterr().out
    assert "Tailscale isn't installed yet." in out and "https://tailscale.com/download" in out
    assert "Almost there" in out


def test_claude_not_installed(install, wizard, capsys):
    wizard["claude"].parent.rmdir()
    assert install.main(["--yes"]) == 0
    out = capsys.readouterr().out
    assert "Claude Desktop isn't installed on this computer yet." in out
    assert not wizard["claude"].exists()


def test_dry_run_changes_nothing(install, wizard, capsys):
    assert install.main(["--dry-run", "--yes"]) == 0
    out = capsys.readouterr().out
    assert not wizard["claude"].exists() and not wizard["cursor"].exists()
    assert "Would add AirBridge to Claude Desktop" in out and "Practice run finished" in out
    assert "\033[" not in out
    assert "[mcp_servers.airbridge]" in out


def test_json_only_dry_run_prints_only_json(install, wizard, capsys, tmp_path):
    venv = tmp_path / "venv"
    assert install.main(["--dry-run", "--json-only", "--venv", str(venv)]) == 0
    data = json.loads(capsys.readouterr().out)
    entry = data["mcpServers"]["airbridge"]
    assert entry["command"] == install.venv_python_path(venv.resolve())
    assert entry["args"] == [str(ROOT / "main.py")]
    assert not venv.exists() and not wizard["claude"].exists()


def test_failure_goes_to_stderr_with_next_step(install, wizard, monkeypatch, capsys):
    def boom(ui, venv_dir):
        raise install.InstallError("AirBridge couldn't create its private workspace.",
                                   hint="Reinstall Python, then run Install AirBridge again.", output="err1\nerr2")

    monkeypatch.setattr(install, "create_venv", boom)
    assert install.main([]) == 1
    err = capsys.readouterr().err
    assert "AirBridge couldn't create its private workspace." in err
    assert "Reinstall Python, then run Install AirBridge again." in err
    assert "err2" in err


def test_check_python_rejects_old(install):
    ui = install.UI(stream=io.StringIO())
    with pytest.raises(install.InstallError) as info:
        install.check_python(ui, (3, 10, 9))
    assert "python.org" in info.value.hint
    install.check_python(ui, (3, 11, 0))


def test_ascii_fallback(install):
    class Ascii(io.StringIO):
        encoding = "ascii"

    ui = install.UI(stream=Ascii(), color=False)
    ui.ok("done")
    ui.fail("bad")
    ui.step(1, "Checking")
    text = ui.stream.getvalue()
    assert "+ done" in text and "x bad" in text and "Step 1 of 4 - Checking" in text
    text.encode("ascii")


# --------------------------------------------------------------------------- #
# Launchers and hygiene
# --------------------------------------------------------------------------- #


def test_install_script_has_no_shell_true():
    source = (ROOT / "install.py").read_text(encoding="utf-8")
    assert "shell=True" not in source
    assert "os.system" not in source


def test_macos_launcher(install):
    launcher = ROOT / "Install AirBridge.command"
    text = launcher.read_text()
    assert text.startswith("#!/bin/bash\n")
    assert 'cd "$(dirname "$0")"' in text and "install.py" in text
    assert "https://www.python.org/downloads/" in text and "Press Enter to close" in text
    if sys.platform != "win32":
        assert launcher.stat().st_mode & 0o111


def test_windows_launcher(install):
    raw = (ROOT / "Install AirBridge.bat").read_bytes()
    assert b"\r\n" in raw and b"\n" not in raw.replace(b"\r\n", b"")  # CRLF only
    text = raw.decode("ascii")
    assert 'cd /d "%~dp0"' in text and "install.py" in text and "pause" in text
    assert "py %%V" in text and "https://www.python.org/downloads/" in text


@pytest.mark.skipif(sys.platform == "win32", reason="posix path layout")
def test_default_venv_inside_airbridge(install):
    assert install.DEFAULT_VENV == ROOT / ".venv"
