"""Network discovery helpers.

The public functions (``get_local_tailscale_ip``, ``get_airbridge_peers``,
``resolve_peer`` and the Phase-3 additions ``get_backend``,
``inbound_bind_host``, ``requests_proxies``, ``peer_details``, ``whois``) keep
their Phase-1 signatures and delegate to the selected backend
(:mod:`netbackend`): the system ``tailscale`` CLI or the desktop app's embedded
tailscaled. The CLI code below (``_cli_*``; list args, shell=False, short
timeout, defensive parsing) is the system backend. Never writes to stdout.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import shutil
import subprocess
import sys
from typing import Any

logger = logging.getLogger(__name__)

TIMEOUT_S = 5
TAILSCALE_CGNAT = ipaddress.ip_network("100.64.0.0/10")

FALLBACK_BINARIES = (
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    r"C:\Program Files\Tailscale\tailscale.exe",
)

MSG_NOT_INSTALLED = (
    "Tailscale CLI not found. Install Tailscale from https://tailscale.com/download "
    "and make sure the `tailscale` command is on your PATH, then retry."
)
MSG_NOT_RUNNING = "Tailscale is not running. Start the Tailscale app and sign in, then retry."


class TailscaleError(RuntimeError):
    """Base class for Tailscale problems; str() is a user-facing message."""


class TailscaleNotInstalled(TailscaleError):
    pass


class TailscaleNotRunning(TailscaleError):
    pass


# --------------------------------------------------------------------------- #
# Binary + subprocess
# --------------------------------------------------------------------------- #
def _on_path(found: str) -> bool:
    """On Windows, shutil.which() also searches the current directory first, so a
    planted ``tailscale.exe`` in the cwd could be executed. Accept a hit only if
    its directory is an explicit PATH entry. Other platforms: always True."""
    if os.name != "nt":
        return True
    try:
        found_dir = os.path.normcase(os.path.realpath(os.path.dirname(os.path.abspath(found))))
    except (OSError, ValueError):
        return False
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        entry = entry.strip().strip('"')
        if not entry or not os.path.isabs(entry):
            continue  # relative PATH entries resolve against the cwd too
        try:
            if os.path.normcase(os.path.realpath(entry)) == found_dir:
                return True
        except (OSError, ValueError):
            continue
    return False


def tailscale_binary() -> str:
    """Return the path of the tailscale CLI or raise TailscaleNotInstalled."""
    found = shutil.which("tailscale")
    if found and _on_path(found):
        return found
    for candidate in FALLBACK_BINARIES:
        if os.path.isfile(candidate):
            return candidate
    raise TailscaleNotInstalled(MSG_NOT_INSTALLED)


def _run(args: list[str]) -> subprocess.CompletedProcess:
    binary = tailscale_binary()
    kwargs: dict[str, Any] = {
        "capture_output": True,
        "text": True,
        "timeout": TIMEOUT_S,
        "check": False,
        "shell": False,
        "stdin": subprocess.DEVNULL,
    }
    if sys.platform == "win32":  # pragma: no cover - platform specific
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    cmd = [binary, *args]
    try:
        return subprocess.run(cmd, **kwargs)
    except FileNotFoundError as exc:
        raise TailscaleNotInstalled(MSG_NOT_INSTALLED) from exc
    except subprocess.TimeoutExpired as exc:
        raise TailscaleNotRunning(
            f"`tailscale {' '.join(args)}` timed out after {TIMEOUT_S}s. "
            "Tailscale may be stuck; restart the Tailscale app and retry."
        ) from exc
    except OSError as exc:
        raise TailscaleError(f"Could not run the Tailscale CLI ({binary}): {exc}") from exc


def _looks_not_running(text: str) -> bool:
    t = text.lower()
    return any(
        s in t
        for s in (
            "not running",
            "failed to connect",
            "is tailscaled running",
            "logged out",
            "needslogin",
            "needs login",
            "stopped",
            "no current tailscale ip",
        )
    )


# --------------------------------------------------------------------------- #
# Local IP
# --------------------------------------------------------------------------- #
def _is_tailscale_ipv4(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value.strip())
    except ValueError:
        return False
    return ip.version == 4 and ip in TAILSCALE_CGNAT


def _cli_local_ip() -> str:
    """Return this machine's Tailscale IPv4 (100.64.0.0/10) via ``tailscale ip -4``."""
    proc = _run(["ip", "-4"])
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0 or not out:
        logger.warning("tailscale ip -4 failed rc=%s stderr=%.200s", proc.returncode, err)
        raise TailscaleNotRunning(MSG_NOT_RUNNING)
    first = out.splitlines()[0].strip()
    if not _is_tailscale_ipv4(first):
        logger.warning("tailscale ip -4 returned unexpected output: %.200s", out)
        raise TailscaleError(
            f"Tailscale returned an unexpected address ({first[:64]!r}); "
            "expected a 100.x.y.z tailnet IPv4. Check `tailscale status`."
        )
    return first


# --------------------------------------------------------------------------- #
# Peers
# --------------------------------------------------------------------------- #
def _status_json() -> dict[str, Any]:
    proc = _run(["status", "--json"])
    out = proc.stdout or ""
    err = (proc.stderr or "").strip()
    if proc.returncode != 0 and not out.strip():
        logger.warning("tailscale status failed rc=%s stderr=%.200s", proc.returncode, err)
        if _looks_not_running(err) or not err:
            raise TailscaleNotRunning(MSG_NOT_RUNNING)
        raise TailscaleError(f"`tailscale status` failed: {err[:200]}")
    try:
        data = json.loads(out)
    except (ValueError, TypeError) as exc:
        logger.warning("tailscale status --json returned invalid JSON: %.200s", out)
        raise TailscaleError("Could not parse `tailscale status --json` output.") from exc
    if not isinstance(data, dict):
        raise TailscaleError("Unexpected `tailscale status --json` output (not an object).")
    state = data.get("BackendState")
    if state is not None and state != "Running":
        raise TailscaleNotRunning(f"{MSG_NOT_RUNNING} (Tailscale state: {state})")
    return data


def _first_tailnet_ipv4(ips: Any) -> str | None:
    if not isinstance(ips, list):
        return None
    for ip in ips:
        if isinstance(ip, str) and _is_tailscale_ipv4(ip):
            return ip.strip()
    return None


def _short_dns_name(dns_name: Any) -> str | None:
    if not isinstance(dns_name, str) or not dns_name.strip():
        return None
    short = dns_name.strip().rstrip(".").split(".", 1)[0].lower()
    return short or None


def _iter_online_peers(data: dict[str, Any]):
    """Yield (hostname_lower, dns_short_lower|None, ipv4) for online peers, Self excluded."""
    peers = data.get("Peer")
    if not isinstance(peers, dict):
        return
    self_ips = set()
    self_node = data.get("Self")
    if isinstance(self_node, dict) and isinstance(self_node.get("TailscaleIPs"), list):
        self_ips = {ip for ip in self_node["TailscaleIPs"] if isinstance(ip, str)}
    for peer in peers.values():
        if not isinstance(peer, dict):
            continue
        if peer.get("Online") is not True:
            continue
        ip = _first_tailnet_ipv4(peer.get("TailscaleIPs"))
        if ip is None or ip in self_ips:
            continue
        host = peer.get("HostName")
        dns_short = _short_dns_name(peer.get("DNSName"))
        host_l = host.strip().lower() if isinstance(host, str) and host.strip() else None
        name = host_l or dns_short
        if not name:
            continue
        yield name, dns_short, ip


def _cli_peers() -> dict[str, str]:
    """Online peers as {hostname.lower(): first tailnet IPv4}. Self excluded."""
    data = _status_json()
    result: dict[str, str] = {}
    for name, _dns, ip in _iter_online_peers(data):
        result.setdefault(name, ip)
    return result


def _cli_resolve(hostname: str) -> str | None:
    """Resolve an online peer by HostName or MagicDNS short name (case-insensitive)."""
    if not isinstance(hostname, str):
        return None
    wanted = hostname.strip().rstrip(".").lower()
    if not wanted:
        return None
    data = _status_json()
    peers = list(_iter_online_peers(data))
    for name, _dns, ip in peers:
        if name == wanted:
            return ip
    wanted_short = wanted.split(".", 1)[0]
    for _name, dns_short, ip in peers:
        if dns_short is not None and dns_short in (wanted, wanted_short):
            return ip
    return None


# --------------------------------------------------------------------------- #
# Public API: delegate to the selected backend (netbackend.select_backend)
# --------------------------------------------------------------------------- #
def get_backend():
    """The backend for this call (system CLI or embedded tailscaled).

    Raises :class:`TailscaleError` (``netbackend.NetworkOff``) when the
    desktop app's network is configured but off and no system Tailscale exists.
    """
    from . import netbackend

    return netbackend.select_backend()


def get_local_tailscale_ip() -> str:
    """This machine's tailnet IPv4 (100.64.0.0/10)."""
    return get_backend().local_ip()


def get_airbridge_peers() -> dict[str, str]:
    """Online peers as {hostname.lower(): first tailnet IPv4}. Self excluded."""
    return get_backend().peers()


def resolve_peer(hostname: str) -> str | None:
    """Resolve an online peer by name (case-insensitive) to its tailnet IPv4."""
    if not isinstance(hostname, str):
        return None
    return get_backend().resolve(hostname)


def peer_details() -> dict:
    """``{self:{hostname, ip, os}, nodes:[{hostname, ip, os, online, last_seen}]}``."""
    return get_backend().peer_details()


def inbound_bind_host() -> str:
    """Where the inbox listens: tailnet IP (system) or 127.0.0.1 (embedded)."""
    return get_backend().inbound_bind_host()


def requests_proxies() -> dict | None:
    """Proxies for outbound requests (embedded: tailscaled's SOCKS5)."""
    return get_backend().requests_proxies()


def whois(remote_addr: str) -> dict | None:
    """``{node, user_id, ip}`` for a connection's remote ``host:port``, or None."""
    return get_backend().whois(remote_addr)
