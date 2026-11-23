"""Static (AST) guards for the AirBridge runtime.

stdout belongs to the MCP stdio JSON-RPC stream: a single stray byte corrupts
the protocol. These tests scan the runtime sources and fail on:

* ``print(...)`` and writes to ``sys.stdout`` / ``sys.__stdout__`` / fd 1, and
  ``logging.StreamHandler(sys.stdout)``           (runtime files only; not install.py)
* ``shell=`` anything but literal ``False``, ``os.system``, ``os.popen``,
  ``subprocess.getoutput/getstatusoutput``, ``asyncio.create_subprocess_shell``
* ``eval`` / ``exec``
* binding to all interfaces via a ``"0.0.0.0"`` / ``"::"`` literal as a host

Files that do not exist yet are skipped; the detectors themselves are unit
tested against synthetic snippets so a green run is meaningful.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "airbridge_app"

RUNTIME_FILES: list[Path] = sorted(
    [p for p in [ROOT / "main.py"] if p.exists()]
    + [p for p in APP.glob("*.py") if p.name != "install.py"]
)
INSTALL_FILES: list[Path] = [p for p in [ROOT / "install.py", APP / "install.py"] if p.exists()]
ALL_FILES: list[Path] = RUNTIME_FILES + INSTALL_FILES

BAD_HOSTS = {"0.0.0.0", "::", ""}
SHELL_FUNCS = {
    ("os", "system"),
    ("os", "popen"),
    ("subprocess", "getoutput"),
    ("subprocess", "getstatusoutput"),
    ("asyncio", "create_subprocess_shell"),
}
STDOUT_NAMES = {"stdout", "__stdout__"}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _dotted(node: ast.AST) -> str:
    """Return 'a.b.c' for Name/Attribute chains (else '')."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return ""


def _is_stdout_expr(node: ast.AST) -> bool:
    d = _dotted(node)
    return any(d == f"sys.{n}" or d.startswith(f"sys.{n}.") for n in STDOUT_NAMES)


def _loc(path: str, node: ast.AST) -> str:
    return f"{path}:{getattr(node, 'lineno', '?')}"


def find_stdout_violations(src: str, path: str = "<src>") -> list[str]:
    """print() / sys.stdout writes / os.write(1, ...) / StreamHandler(sys.stdout)."""
    out: list[str] = []
    for node in ast.walk(ast.parse(src, filename=path)):
        if not isinstance(node, ast.Call):
            continue
        name = _dotted(node.func)
        if name in {"print", "builtins.print"}:
            out.append(f"{_loc(path, node)} print()")
        elif isinstance(node.func, ast.Attribute) and node.func.attr in {"write", "writelines"} \
                and _is_stdout_expr(node.func.value):
            out.append(f"{_loc(path, node)} sys.stdout write")
        elif name == "os.write" and node.args and isinstance(node.args[0], ast.Constant) \
                and node.args[0].value == 1:
            out.append(f"{_loc(path, node)} os.write(1, ...)")
        elif name.endswith("StreamHandler") and (
            any(_is_stdout_expr(a) for a in node.args)
            or any(k.arg == "stream" and _is_stdout_expr(k.value) for k in node.keywords)
        ):
            out.append(f"{_loc(path, node)} StreamHandler(sys.stdout)")
        elif name in {"contextlib.redirect_stdout", "redirect_stdout"}:
            pass  # redirecting *away* from stdout is fine
    return out


def find_dangerous_calls(src: str, path: str = "<src>") -> list[str]:
    """shell=True-ish, os.system & friends, eval/exec."""
    out: list[str] = []
    for node in ast.walk(ast.parse(src, filename=path)):
        if not isinstance(node, ast.Call):
            continue
        name = _dotted(node.func)
        for kw in node.keywords:
            if kw.arg == "shell" and not (isinstance(kw.value, ast.Constant) and kw.value.value is False):
                out.append(f"{_loc(path, node)} shell= not literal False")
        parts = tuple(name.split("."))
        if len(parts) >= 2 and parts[-2:] in SHELL_FUNCS:
            out.append(f"{_loc(path, node)} {name}()")
        if name in {"system", "popen", "getoutput", "getstatusoutput", "create_subprocess_shell"}:
            out.append(f"{_loc(path, node)} {name}() (imported shell helper)")
        if name in {"eval", "exec", "builtins.eval", "builtins.exec"}:
            out.append(f"{_loc(path, node)} {name}()")
    return out


def _is_bad_host_literal(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in BAD_HOSTS \
        and node.value != ""  # empty string only flagged in host= keyword


def find_wildcard_bind(src: str, path: str = "<src>") -> list[str]:
    """'0.0.0.0' / '::' literal used as a host (keyword, assignment, bind tuple, default)."""
    out: list[str] = []
    for node in ast.walk(ast.parse(src, filename=path)):
        if isinstance(node, ast.keyword) and node.arg and node.arg.lower() in {"host", "bind", "bind_host"}:
            if isinstance(node.value, ast.Constant) and node.value.value in BAD_HOSTS:
                out.append(f"{_loc(path, node.value)} {node.arg}={node.value.value!r}")
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = " ".join(_dotted(t) for t in targets).lower()
            if ("host" in names or "bind" in names) and node.value is not None \
                    and _is_bad_host_literal(node.value):
                out.append(f"{_loc(path, node)} {names} = {node.value.value!r}")
        elif isinstance(node, ast.Call) and _dotted(node.func).endswith("bind") and node.args:
            a = node.args[0]
            if isinstance(a, ast.Tuple) and a.elts and _is_bad_host_literal(a.elts[0]):
                out.append(f"{_loc(path, node)} bind(({a.elts[0].value!r}, ...))")
        elif isinstance(node, ast.arguments):
            pos = node.posonlyargs + node.args
            defaults = list(zip(pos[len(pos) - len(node.defaults):], node.defaults))
            defaults += [(a, d) for a, d in zip(node.kwonlyargs, node.kw_defaults) if d is not None]
            for arg, d in defaults:
                if "host" in arg.arg.lower() and _is_bad_host_literal(d):
                    out.append(f"{_loc(path, d)} default {arg.arg}={d.value!r}")
    return out


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def _ids(paths: list[Path]) -> list[str]:
    return [str(p.relative_to(ROOT)) for p in paths]


# --------------------------------------------------------------------------- #
# scans of the real code base
# --------------------------------------------------------------------------- #
def test_runtime_files_discovered():
    # security.py is ours and always present; guards against a broken glob.
    assert APP / "security.py" in RUNTIME_FILES


@pytest.mark.parametrize("path", RUNTIME_FILES, ids=_ids(RUNTIME_FILES))
def test_no_stdout_in_runtime(path: Path):
    assert find_stdout_violations(_read(path), str(path)) == []


@pytest.mark.parametrize("path", ALL_FILES, ids=_ids(ALL_FILES))
def test_no_shell_eval_exec(path: Path):
    assert find_dangerous_calls(_read(path), str(path)) == []


@pytest.mark.parametrize("path", ALL_FILES, ids=_ids(ALL_FILES))
def test_no_wildcard_bind(path: Path):
    assert find_wildcard_bind(_read(path), str(path)) == []


# --------------------------------------------------------------------------- #
# detector self-tests (so a green scan actually means something)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "src",
    [
        "print('x')",
        "print()",
        "import builtins\nbuiltins.print(1)",
        "import sys\nsys.stdout.write('x')",
        "import sys\nsys.stdout.writelines(['x'])",
        "import sys\nsys.stdout.buffer.write(b'x')",
        "import sys\nsys.__stdout__.write('x')",
        "import os\nos.write(1, b'x')",
        "import logging, sys\nlogging.StreamHandler(sys.stdout)",
        "import logging, sys\nlogging.StreamHandler(stream=sys.stdout)",
        "def f():\n    if True:\n        print('nested')",
    ],
)
def test_detector_stdout_positive(src):
    assert find_stdout_violations(src)


@pytest.mark.parametrize(
    "src",
    [
        "import sys\nsys.stderr.write('x')",
        "import logging\nlogging.getLogger(__name__).info('print')",
        "import sys\nprint_ = None",
        "import sys\nx = sys.stdout is None",
        "import logging, sys\nlogging.StreamHandler(sys.stderr)",
        "import os\nos.write(2, b'x')",
        "s = 'print(1)'",
    ],
)
def test_detector_stdout_negative(src):
    assert find_stdout_violations(src) == []


@pytest.mark.parametrize(
    "src",
    [
        "import subprocess\nsubprocess.run('ls', shell=True)",
        "import subprocess\nsubprocess.Popen(['ls'], shell=1)",
        "import subprocess\nflag=True\nsubprocess.run('ls', shell=flag)",
        "import os\nos.system('ls')",
        "import os\nos.popen('ls')",
        "from os import system\nsystem('ls')",
        "import subprocess\nsubprocess.getoutput('ls')",
        "import asyncio\nasyncio.create_subprocess_shell('ls')",
        "eval('1')",
        "exec('x=1')",
        "import builtins\nbuiltins.eval('1')",
    ],
)
def test_detector_dangerous_positive(src):
    assert find_dangerous_calls(src)


@pytest.mark.parametrize(
    "src",
    [
        "import subprocess\nsubprocess.run(['ls'], shell=False, timeout=5, check=False)",
        "import subprocess\nsubprocess.run(['ls'])",
        "import ast\nast.literal_eval('1')",
        "x = 'eval'",
        "import re\nre.compile('x').search('eval(')",
    ],
)
def test_detector_dangerous_negative(src):
    assert find_dangerous_calls(src) == []


@pytest.mark.parametrize(
    "src",
    [
        "uvicorn.Config(app, host='0.0.0.0', port=8989)",
        "uvicorn.run(app, host='::')",
        "HOST = '0.0.0.0'",
        "bind_host: str = '0.0.0.0'",
        "self.host = '::'",
        "sock.bind(('0.0.0.0', 8989))",
        "def serve(host='0.0.0.0'):\n    pass",
        "def serve(*, host='::'):\n    pass",
        "uvicorn.Config(app, host='', port=1)",
    ],
)
def test_detector_wildcard_positive(src):
    assert find_wildcard_bind(src)


@pytest.mark.parametrize(
    "src",
    [
        "uvicorn.Config(app, host=ip, port=8989)",
        "HOST = validate_bind_host(ip)",
        "REJECTED = {'0.0.0.0', '127.0.0.1'}",
        "assert ip != '0.0.0.0'",
        "def f(host=None):\n    pass",
        "msg = 'never bind to 0.0.0.0'",
    ],
)
def test_detector_wildcard_negative(src):
    assert find_wildcard_bind(src) == []
