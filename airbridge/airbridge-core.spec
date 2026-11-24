# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the airbridge-core backend binary bundled with AirBridge Pro.
#
#   pyinstaller --noconfirm --clean --distpath <out> --workpath <tmp> airbridge-core.spec
#
# Notes
# * Console bootloader on purpose (console=True): a windowed/--noconsole build
#   sets sys.stdout=None, which breaks the MCP stdio transport (the default
#   mode of this binary). The desktop app hides the window with
#   windowsHide/CREATE_NO_WINDOW instead.
# * Onefile: a single executable per OS/arch in
#   desktop/resources/bin/<os>-<arch>/airbridge-core[.exe].
# * uvicorn/fastapi/starlette/mcp/pydantic/anyio/websockets import parts of
#   themselves dynamically (uvicorn "auto" loops/protocols, pydantic plugins,
#   mcp transports), so they are collected whole.

import os
import sys

from PyInstaller.utils.hooks import collect_all

SPEC_DIR = os.path.abspath(SPECPATH)  # noqa: F821 - provided by PyInstaller

COLLECT_ALL = [
    "uvicorn",
    "fastapi",
    "starlette",
    "mcp",
    "pydantic",
    "anyio",
    "websockets",
]

HIDDEN_IMPORTS = [
    # uvicorn picks these by string at runtime.
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.websockets_sansio_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    # AirBridge modules imported lazily by main.py via importlib.
    "airbridge_app",
    "airbridge_app.config",
    "airbridge_app.control",
    "airbridge_app.daemon",
    "airbridge_app.events",
    "airbridge_app.formatting",
    "airbridge_app.inbox",
    "airbridge_app.logging_setup",
    "airbridge_app.netbackend",
    "airbridge_app.network",
    "airbridge_app.notify",
    "airbridge_app.outbox",
    "airbridge_app.security",
    "airbridge_app.selftest",
    # mcp.server.request_state imports cryptography (AES-GCM) at import time.
    "cryptography.hazmat.bindings._rust",
    "cryptography.hazmat.primitives.ciphers.aead",
    "cryptography.hazmat.primitives.kdf.hkdf",
]

# mcp.cli needs the optional `typer` extra and calls sys.exit(1) on import
# without it; AirBridge never uses the mcp CLI.
SKIP_SUBMODULES = ("mcp.cli",)

EXCLUDES = ["tkinter", "pytest", "IPython", "matplotlib", "numpy", "typer", *SKIP_SUBMODULES]


def _keep(name):
    return not any(name == s or name.startswith(s + ".") for s in SKIP_SUBMODULES)


datas, binaries, hiddenimports = [], [], list(HIDDEN_IMPORTS)
for pkg in COLLECT_ALL:
    d, b, h = collect_all(pkg, filter_submodules=_keep)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(  # noqa: F821
    [os.path.join(SPEC_DIR, "main.py")],
    pathex=[SPEC_DIR],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=EXCLUDES,
    noarchive=False,
    optimize=0,
)
# Never ship a Homebrew/MacPorts dylib: it is built for the build machine's macOS and, for
# OpenSSL, shadows (or is shadowed by) Python's own libssl.3.dylib inside the onefile bundle.
# A dynamically linked (source-built) cryptography is how one gets here; build_backend.sh
# installs wheels only and checks _rust.abi3.so with otool as well.
if sys.platform == "darwin":
    _foreign = sorted(
        src for _dest, src, _kind in a.binaries
        if src and os.path.realpath(src).startswith(("/usr/local/opt/", "/usr/local/Cellar/", "/opt/homebrew/", "/opt/local/"))
    )
    if _foreign:
        raise SystemExit("airbridge-core.spec: refusing to bundle Homebrew/MacPorts libraries: " + ", ".join(_foreign))

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="airbridge-core",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=os.environ.get("AIRBRIDGE_CODESIGN_IDENTITY") or None,
    entitlements_file=os.environ.get("AIRBRIDGE_ENTITLEMENTS_FILE") or None,
)
