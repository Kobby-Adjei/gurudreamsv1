"""Tests for install.py: pure helpers and the --dry-run / --json-only flows."""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def install():
    spec = importlib.util.spec_from_file_location("airbridge_install", ROOT / "install.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_venv_python_path_posix(install):
    assert install.venv_python_path("/home/me/airbridge/.venv", "posix") == "/home/me/airbridge/.venv/bin/python"


def test_venv_python_path_nt(install):
    assert (
        install.venv_python_path(r"C:\Users\Me\airbridge\.venv", "nt")
        == r"C:\Users\Me\airbridge\.venv\Scripts\python.exe"
    )


def test_build_config_snippet_shape(install):
    snippet = install.build_config_snippet("/v/bin/python", "/a/main.py")
    assert snippet == {"mcpServers": {"airbridge": {"command": "/v/bin/python", "args": ["/a/main.py"]}}}


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


def test_check_python_rejects_old(install):
    ui = install.UI(stream=io.StringIO())
    with pytest.raises(install.InstallError):
        install.check_python(ui, (3, 10, 9))
    install.check_python(ui, (3, 11, 0))


def test_json_only_dry_run_prints_only_json(install, capsys, tmp_path, monkeypatch):
    monkeypatch.setattr(install, "find_tailscale", lambda: None)
    venv = tmp_path / "venv"
    assert install.main(["--dry-run", "--json-only", "--venv", str(venv)]) == 0
    out = capsys.readouterr().out
    data = json.loads(out)
    entry = data["mcpServers"]["airbridge"]
    assert entry["command"] == install.venv_python_path(venv.resolve())
    assert entry["args"] == [str(ROOT / "main.py")]
    assert not venv.exists()


def test_dry_run_human_output(install, capsys, tmp_path, monkeypatch):
    monkeypatch.setattr(install, "find_tailscale", lambda: None)
    monkeypatch.setenv("NO_COLOR", "1")
    assert install.main(["--dry-run", "--venv", str(tmp_path / "v")]) == 0
    out = capsys.readouterr().out
    assert "\033[" not in out  # NO_COLOR / not a tty
    for expected in ("AirBridge setup", "Tailscale not found", "Claude Desktop", "Cursor", "Codex",
                     '"mcpServers"', "[mcp_servers.airbridge]"):
        assert expected in out


def test_ascii_fallback(install):
    class Latin1(io.StringIO):
        encoding = "ascii"

    ui = install.UI(stream=Latin1(), color=False)
    ui.ok("done")
    ui.fail("bad")
    text = ui.stream.getvalue()
    assert "+ done" in text and "x bad" in text
    text.encode("ascii")


def test_failure_goes_to_stderr(install, capsys, monkeypatch, tmp_path):
    def boom(ui, venv_dir):
        raise install.InstallError("Could not create the virtual environment", hint="try again", output="err1\nerr2")

    monkeypatch.setattr(install, "create_venv", boom)
    assert install.main(["--venv", str(tmp_path / "v")]) == 1
    captured = capsys.readouterr()
    assert "Could not create the virtual environment" in captured.err
    assert "err2" in captured.err


def test_install_script_has_no_shell_true():
    source = (ROOT / "install.py").read_text(encoding="utf-8")
    assert "shell=True" not in source
    assert "os.system" not in source


@pytest.mark.skipif(sys.platform == "win32", reason="posix path layout")
def test_default_venv_inside_airbridge(install):
    assert install.DEFAULT_VENV == ROOT / ".venv"
