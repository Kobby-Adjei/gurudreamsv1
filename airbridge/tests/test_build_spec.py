"""Static checks on the PyInstaller spec and build scripts (no build is run)."""

from __future__ import annotations

import ast
import re
from pathlib import Path

AIRBRIDGE_DIR = Path(__file__).resolve().parent.parent
SPEC = AIRBRIDGE_DIR / "airbridge-core.spec"
BUILD_SH = AIRBRIDGE_DIR / "build_backend.sh"
BUILD_PS1 = AIRBRIDGE_DIR / "build_backend.ps1"
REPO_ROOT = AIRBRIDGE_DIR.parent


def _spec_tree() -> ast.Module:
    return ast.parse(SPEC.read_text(encoding="utf-8"))


def _list_assign(name: str) -> list[str]:
    for node in ast.walk(_spec_tree()):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return [ast.literal_eval(e) for e in node.value.elts]
    raise AssertionError(f"{name} not found in spec")


def _exe_kwargs() -> dict[str, ast.expr]:
    for node in ast.walk(_spec_tree()):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "EXE":
            return {kw.arg: kw.value for kw in node.keywords}
    raise AssertionError("EXE(...) not found in spec")


def test_collect_all_packages():
    required = {"uvicorn", "fastapi", "starlette", "mcp", "pydantic", "anyio", "websockets"}
    assert required <= set(_list_assign("COLLECT_ALL"))
    assert "collect_all(pkg" in SPEC.read_text(encoding="utf-8")


def test_uvicorn_auto_hidden_imports():
    hidden = set(_list_assign("HIDDEN_IMPORTS"))
    for mod in (
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.websockets_sansio_impl",
        "uvicorn.lifespan.on",
    ):
        assert mod in hidden, mod


def test_all_airbridge_modules_are_hidden_imports():
    hidden = set(_list_assign("HIDDEN_IMPORTS"))
    modules = {f"airbridge_app.{p.stem}" for p in (AIRBRIDGE_DIR / "airbridge_app").glob("*.py") if p.stem != "__init__"}
    assert modules <= hidden, sorted(modules - hidden)


def test_onefile_console_named_airbridge_core():
    kw = _exe_kwargs()
    assert ast.literal_eval(kw["name"]) == "airbridge-core"
    # console bootloader: --noconsole sets sys.stdout=None and breaks MCP stdio
    assert ast.literal_eval(kw["console"]) is True
    # onefile: binaries/datas go into the EXE and there is no COLLECT step
    assert "COLLECT(" not in SPEC.read_text(encoding="utf-8")
    assert "main.py" in SPEC.read_text(encoding="utf-8")


def test_build_sh_contract():
    text = BUILD_SH.read_text(encoding="utf-8")
    assert text.startswith("#!/usr/bin/env bash")
    assert "set -euo pipefail" in text
    assert "requirements.txt" in text and "requirements-build.txt" in text
    assert "airbridge-core.spec" in text
    assert "desktop/resources/bin/$OS-$ARCH" in text
    assert "--check" in text and "--help" in text


def test_build_ps1_contract():
    text = BUILD_PS1.read_text(encoding="utf-8")
    assert re.search(r"\$ErrorActionPreference\s*=\s*['\"]Stop['\"]", text)
    assert "requirements-build.txt" in text
    assert "airbridge-core.spec" in text
    assert "airbridge-core.exe" in text
    assert "--check" in text


def test_build_outputs_are_gitignored():
    gi = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "desktop/resources/bin/" in gi
    assert "airbridge/.build-venv/" in gi


def test_requirements_include_phase2_deps():
    req = (AIRBRIDGE_DIR / "requirements.txt").read_text(encoding="utf-8")
    assert re.search(r"^websockets>=", req, re.M)
    build = (AIRBRIDGE_DIR / "requirements-build.txt").read_text(encoding="utf-8")
    assert re.search(r"^pyinstaller>=6", build, re.M | re.I)


def test_build_scripts_use_binary_wheels_and_self_test():
    """Wheels only: a source-built cryptography links Homebrew OpenSSL dynamically and the
    frozen binary then crash-loops with 'Symbol not found: _SSL_get0_group_name' (Intel Mac)."""
    for path in (BUILD_SH, BUILD_PS1):
        text = path.read_text(encoding="utf-8")
        assert "--only-binary=:all:" in text, path.name
        assert "--self-test" in text, path.name
    req = (AIRBRIDGE_DIR / "requirements.txt").read_text(encoding="utf-8")
    assert 'cryptography<49; sys_platform == "darwin" and platform_machine == "x86_64"' in req
    assert "airbridge_app.selftest" in set(_list_assign("HIDDEN_IMPORTS"))
