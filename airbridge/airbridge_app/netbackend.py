"""Network backends: how AirBridge talks to the private network (Phase 3).

Two implementations of one small protocol (:class:`NetBackend`):

* :class:`SystemTailscale` - the Phase-1 path: a system-wide Tailscale install,
  queried through the ``tailscale`` CLI (code lives in :mod:`network`,
  behaviour unchanged). The inbox binds the machine's tailnet IP and outbound
  requests go straight to peers' tailnet IPs.
* :class:`EmbeddedTailscale` - the desktop app's bundled ``tailscaled`` running
  in userspace-networking mode. There is no TUN device, so:

  - inbound tailnet connections to :8989 are forwarded by tailscaled's
    netstack to ``127.0.0.1:8989`` (the inbox binds loopback), and the
    real sender is recovered with LocalAPI ``whois`` on the proxied
    ``127.0.0.1:<srcport>`` address;
  - outbound requests go through tailscaled's SOCKS5 server
    (``socks5h://127.0.0.1:<P>``).

  It talks to tailscaled only through two read-only LocalAPI endpoints
  (``/localapi/v0/status`` and ``/localapi/v0/whois``) over a Unix socket or,
  on Windows, a named pipe.

Selection (:func:`select_backend`): ``AIRBRIDGE_NETWORK`` override, else a
live ``<data dir>/network.json`` (written by the desktop app) means embedded,
else system. A ``network.json`` whose socket is dead with no system Tailscale
installed is the "AirBridge network is off" error.

Never writes to stdout.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import logging
import os
import socket
import sys
from typing import Any, Protocol
from urllib.parse import quote

from . import config, network

logger = logging.getLogger("airbridge.netbackend")

LOCALAPI_HOST = "local-tailscaled.sock"
LOCALAPI_TIMEOUT_S = 5.0
LOCALAPI_MAX_BYTES = 8 * 1024 * 1024
HOST_PREFIX = "airbridge-"
_ZERO_TIME_PREFIX = "0001-01-01"

MSG_NETWORK_OFF = "AirBridge network is off \u2014 open the AirBridge app"
MSG_NOT_CONNECTED = "AirBridge network is not connected yet"


class NetworkOff(network.TailscaleNotRunning):
    """The embedded network is configured (network.json) but not reachable."""


# --------------------------------------------------------------------------- #
# Protocol
# --------------------------------------------------------------------------- #
class NetBackend(Protocol):
    kind: str  # "system" | "embedded"

    def local_ip(self) -> str: ...
    def peers(self) -> dict[str, str]: ...
    def peer_details(self) -> dict[str, Any]: ...
    def resolve(self, host: str) -> str | None: ...
    def inbound_bind_host(self) -> str: ...
    def requests_proxies(self) -> dict[str, str] | None: ...
    def whois(self, remote_addr: str) -> dict[str, Any] | None: ...
    def self_user_id(self) -> int | None: ...


# --------------------------------------------------------------------------- #
# Shared parsing of ipnstate.Status JSON (CLI `status --json` == LocalAPI /status)
# --------------------------------------------------------------------------- #
def _first_tailnet_ipv4(ips: Any) -> str | None:
    if not isinstance(ips, list):
        return None
    for ip in ips:
        if not isinstance(ip, str):
            continue
        cand = ip.strip().split("/", 1)[0]  # whois Addresses are prefixes ("100.64.0.1/32")
        try:
            addr = ipaddress.ip_address(cand)
        except ValueError:
            continue
        if addr.version == 4 and addr in network.TAILSCALE_CGNAT:
            return cand
    return None


def _str_or_none(value: Any, limit: int = 64) -> str | None:
    return value.strip()[:limit] if isinstance(value, str) and value.strip() else None


def strip_prefix(name: str) -> str:
    """``airbridge-macbook`` -> ``macbook`` (case-insensitive prefix)."""
    if name.lower().startswith(HOST_PREFIX) and len(name) > len(HOST_PREFIX):
        return name[len(HOST_PREFIX):]
    return name


def _node_name(entry: dict[str, Any], *, strip: bool) -> str | None:
    name = None
    host = entry.get("HostName")
    if isinstance(host, str) and host.strip():
        name = host.strip()
    else:
        dns = entry.get("DNSName")
        if isinstance(dns, str) and dns.strip():
            name = dns.strip().rstrip(".").split(".", 1)[0] or None
    if name and strip:
        name = strip_prefix(name)
    return name[:64] if name else None


def _local_os() -> str:
    if sys.platform == "darwin":
        return "macOS"
    if sys.platform.startswith("win"):
        return "windows"
    return "linux"


def _user_id(entry: Any) -> int | None:
    if isinstance(entry, dict):
        uid = entry.get("UserID")
        if isinstance(uid, int) and not isinstance(uid, bool):
            return uid
    return None


def details_from_status(data: dict[str, Any], *, strip: bool = False, same_user_only: bool = False,
                        fallback_hostname: str = "") -> dict[str, Any]:
    """``{self:{hostname, ip, os}, nodes:[{hostname, ip, os, online, last_seen}]}``.

    Includes offline peers. ``strip`` drops the ``airbridge-`` hostname prefix;
    ``same_user_only`` keeps only peers owned by Self's user.
    """
    self_entry = data.get("Self") if isinstance(data.get("Self"), dict) else {}
    self_ips = {ip for ip in self_entry.get("TailscaleIPs") or [] if isinstance(ip, str)}
    self_uid = _user_id(self_entry)
    me = {
        "hostname": _node_name(self_entry, strip=strip) or fallback_hostname,
        "ip": _first_tailnet_ipv4(self_entry.get("TailscaleIPs")),
        "os": _str_or_none(self_entry.get("OS")) or _local_os(),
    }
    nodes: list[dict[str, Any]] = []
    peers = data.get("Peer")
    if isinstance(peers, dict):
        for entry in peers.values():
            if not isinstance(entry, dict):
                continue
            if same_user_only and (self_uid is None or _user_id(entry) != self_uid):
                continue
            name = _node_name(entry, strip=strip)
            ip = _first_tailnet_ipv4(entry.get("TailscaleIPs"))
            if not name or not ip or ip in self_ips:
                continue
            last_seen = _str_or_none(entry.get("LastSeen"))
            if last_seen and last_seen.startswith(_ZERO_TIME_PREFIX):
                last_seen = None
            nodes.append({
                "hostname": name,
                "ip": ip,
                "os": _str_or_none(entry.get("OS")),
                "online": entry.get("Online") is True,
                "last_seen": last_seen,
            })
    nodes.sort(key=lambda n: (not n["online"], n["hostname"].lower()))
    return {"self": me, "nodes": nodes}


# --------------------------------------------------------------------------- #
# System Tailscale (Phase-1 CLI)
# --------------------------------------------------------------------------- #
class SystemTailscale:
    """System-wide Tailscale via the ``tailscale`` CLI (Phase-1 behaviour).

    Every call goes through the module-level helpers in :mod:`network` at call
    time, so existing monkeypatches of ``network._status_json`` etc. apply.
    """

    kind = "system"

    def local_ip(self) -> str:
        return network._cli_local_ip()

    def peers(self) -> dict[str, str]:
        return network._cli_peers()

    def peer_details(self) -> dict[str, Any]:
        from . import events  # local import: events is heavier and optional here

        return details_from_status(network._status_json(), fallback_hostname=events.local_node_name())

    def resolve(self, host: str) -> str | None:
        return network._cli_resolve(host)

    def inbound_bind_host(self) -> str:
        return network.get_local_tailscale_ip()

    def requests_proxies(self) -> dict[str, str] | None:
        return None

    def whois(self, remote_addr: str) -> dict[str, Any] | None:
        """Best effort ``tailscale whois --json``; not used on the inbound path
        in system mode (the source IP itself is the tailnet address)."""
        try:
            proc = network._run(["whois", "--json", str(remote_addr)[:80]])
        except network.TailscaleError:
            return None
        if proc.returncode != 0:
            return None
        try:
            return parse_whois(json.loads(proc.stdout or ""))
        except (ValueError, TypeError):
            return None

    def self_user_id(self) -> int | None:
        return _user_id(network._status_json().get("Self"))


# --------------------------------------------------------------------------- #
# LocalAPI transport (AF_UNIX / Windows named pipe)
# --------------------------------------------------------------------------- #
class LocalAPIError(network.TailscaleError):
    pass


class _PipeSock:  # pragma: no cover - Windows only
    """Just enough of a socket for http.client.HTTPResponse over a named pipe."""

    def __init__(self, path: str) -> None:
        self._f = open(path, "r+b", buffering=0)  # noqa: SIM115 - closed in close()

    def sendall(self, data: bytes) -> None:
        self._f.write(data)

    def makefile(self, mode: str = "rb", *a: Any, **k: Any) -> Any:
        return self._f

    def close(self) -> None:
        try:
            self._f.close()
        except OSError:
            pass


def _is_pipe(path: str) -> bool:
    return path.startswith("\\\\.\\pipe\\") or path.startswith("//./pipe/")


def _open_transport(path: str, timeout: float) -> Any:
    if _is_pipe(path):  # pragma: no cover - Windows only
        if os.name != "nt":
            raise LocalAPIError("named pipes are only supported on Windows")
        return _PipeSock(path)
    if not hasattr(socket, "AF_UNIX"):  # pragma: no cover
        raise LocalAPIError("Unix sockets are not supported on this platform")
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(path)
    except BaseException:
        sock.close()
        raise
    return sock


def localapi_get(path: str, url_path: str, timeout: float = LOCALAPI_TIMEOUT_S) -> tuple[int, bytes]:
    """``GET url_path`` on tailscaled's LocalAPI at *path*. Returns (status, body)."""
    try:
        transport = _open_transport(path, timeout)
    except OSError as exc:
        raise NetworkOff(MSG_NETWORK_OFF) from exc
    try:
        req = (
            f"GET {url_path} HTTP/1.1\r\n"
            f"Host: {LOCALAPI_HOST}\r\n"
            "Sec-Tailscale: localapi\r\n"
            "Accept: application/json\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        transport.sendall(req)
        resp = http.client.HTTPResponse(transport)  # type: ignore[arg-type]
        try:
            resp.begin()
            body = resp.read(LOCALAPI_MAX_BYTES + 1)
        finally:
            resp.close()
        if len(body) > LOCALAPI_MAX_BYTES:
            raise LocalAPIError("LocalAPI response too large")
        return resp.status, body
    except (OSError, http.client.HTTPException) as exc:
        raise NetworkOff(MSG_NETWORK_OFF) from exc
    finally:
        try:
            transport.close()
        except OSError:
            pass


def socket_answers(path: str, timeout: float = 1.0) -> bool:
    """Cheap liveness probe: can we connect to the LocalAPI endpoint?"""
    try:
        t = _open_transport(path, timeout)
    except (OSError, LocalAPIError):
        return False
    try:
        t.close()
    except OSError:
        pass
    return True


def parse_whois(data: Any) -> dict[str, Any] | None:
    """apitype.WhoIsResponse -> ``{node, user_id, ip, node_id}`` (or None if unusable).

    ``proto=tcp`` is always sent so a UDP proxymap entry never vouches for a
    TCP connection (security.verify_embedded_peer contract).
    """
    if not isinstance(data, dict):
        return None
    node = data.get("Node") if isinstance(data.get("Node"), dict) else {}
    profile = data.get("UserProfile") if isinstance(data.get("UserProfile"), dict) else {}
    uid = profile.get("ID")
    if not isinstance(uid, int) or isinstance(uid, bool):
        uid = node.get("User")
    if not isinstance(uid, int) or isinstance(uid, bool):
        return None
    # Prefer the control-assigned Node.Name over the peer-asserted Hostinfo.Hostname.
    name = None
    if isinstance(node.get("Name"), str):
        name = node["Name"].strip().rstrip(".").split(".", 1)[0] or None
    if not name:
        name = _str_or_none(node.get("ComputedName"))
    if not name:
        return None
    return {
        "node": strip_prefix(name)[:64],
        "user_id": uid,
        "ip": _first_tailnet_ipv4(node.get("Addresses")),
        "node_id": node.get("StableID") if isinstance(node.get("StableID"), str) else None,
    }


# --------------------------------------------------------------------------- #
# Embedded tailscaled (desktop app)
# --------------------------------------------------------------------------- #
class EmbeddedTailscale:
    kind = "embedded"

    def __init__(self, socket_path: str, socks5: str) -> None:
        self.socket_path = socket_path
        self.socks5 = socks5

    def __repr__(self) -> str:
        return f"EmbeddedTailscale(socket={self.socket_path!r}, socks5={self.socks5!r})"

    def _get_json(self, url_path: str) -> Any:
        status, body = localapi_get(self.socket_path, url_path)
        if status != 200:
            raise LocalAPIError(f"AirBridge network error (HTTP {status})")
        try:
            return json.loads(body)
        except ValueError as exc:
            raise LocalAPIError("AirBridge network returned invalid data") from exc

    def status(self) -> dict[str, Any]:
        data = self._get_json("/localapi/v0/status")
        if not isinstance(data, dict):
            raise LocalAPIError("AirBridge network returned invalid status")
        return data

    def _running_status(self) -> dict[str, Any]:
        data = self.status()
        state = data.get("BackendState")
        if state != "Running":
            raise network.TailscaleNotRunning(f"{MSG_NOT_CONNECTED} (state: {str(state)[:32]})")
        return data

    def local_ip(self) -> str:
        data = self._running_status()
        self_entry = data.get("Self") if isinstance(data.get("Self"), dict) else {}
        ip = _first_tailnet_ipv4(self_entry.get("TailscaleIPs"))
        if not ip:
            raise network.TailscaleNotRunning(MSG_NOT_CONNECTED)
        return ip

    def peer_details(self) -> dict[str, Any]:
        from . import events

        return details_from_status(self._running_status(), strip=True, same_user_only=True,
                                   fallback_hostname=events.local_node_name())

    def peers(self) -> dict[str, str]:
        result: dict[str, str] = {}
        for n in self.peer_details()["nodes"]:
            if n["online"]:
                result.setdefault(n["hostname"].lower(), n["ip"])
        return result

    def resolve(self, host: str) -> str | None:
        if not isinstance(host, str):
            return None
        wanted = host.strip().rstrip(".").lower()
        if not wanted:
            return None
        wanted = strip_prefix(wanted.split(".", 1)[0])
        return self.peers().get(wanted)

    def inbound_bind_host(self) -> str:
        return "127.0.0.1"

    def requests_proxies(self) -> dict[str, str] | None:
        return {"http": f"socks5h://{self.socks5}"}

    def whois(self, remote_addr: str) -> dict[str, Any] | None:
        addr = str(remote_addr)[:80]
        try:
            status, body = localapi_get(self.socket_path, "/localapi/v0/whois?proto=tcp&addr=" + quote(addr, safe=""))
        except network.TailscaleError:
            logger.warning("whois lookup failed for %s", addr)
            return None
        if status != 200:
            return None
        try:
            return parse_whois(json.loads(body))
        except ValueError:
            return None

    def self_user_id(self) -> int | None:
        return _user_id(self.status().get("Self"))


# --------------------------------------------------------------------------- #
# Selection
# --------------------------------------------------------------------------- #
_override: NetBackend | None = None


def set_backend_override(backend: NetBackend | None) -> None:
    """Tests / embedding: force a backend (None restores normal selection)."""
    global _override
    _override = backend


def _valid_socks5(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    host, sep, port = value.strip().rpartition(":")
    if not sep or host != "127.0.0.1" or not port.isdigit() or not (0 < int(port) < 65536):
        return None
    return f"127.0.0.1:{int(port)}"


def _valid_socket(value: Any) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 512 or "\x00" in value:
        return None
    if _is_pipe(value) or os.path.isabs(value):
        return value
    return None


def _embedded_endpoint() -> tuple[str | None, str | None, bool]:
    """(socket, socks5, network_json_present) from env first, then network.json."""
    info = config.read_network_json()
    present = info is not None
    sock = _valid_socket(os.environ.get(config.ENV_TS_SOCKET, "").strip()) or (
        _valid_socket(info.get("socket")) if info else None)
    socks = _valid_socks5(os.environ.get(config.ENV_TS_SOCKS5, "").strip()) or (
        _valid_socks5(info.get("socks5")) if info else None)
    return sock, socks, present


def _system_available() -> bool:
    try:
        network.tailscale_binary()
        return True
    except network.TailscaleError:
        return False


def select_backend() -> NetBackend:
    """Pick the backend for this call (cheap: env + a small file + a connect probe)."""
    if _override is not None:
        return _override
    mode = config.network_mode()
    if mode == "system":
        return SystemTailscale()
    sock, socks, present = _embedded_endpoint()
    if mode == "embedded":
        if not sock or not socks:
            raise NetworkOff(MSG_NETWORK_OFF)
        return EmbeddedTailscale(sock, socks)
    # auto
    if sock and socks and (present or os.environ.get(config.ENV_TS_SOCKET)):
        if socket_answers(sock):
            return EmbeddedTailscale(sock, socks)
        if _system_available():
            return SystemTailscale()
        raise NetworkOff(MSG_NETWORK_OFF)
    if present and not _system_available():
        raise NetworkOff(MSG_NETWORK_OFF)
    return SystemTailscale()


__all__ = [
    "EmbeddedTailscale",
    "HOST_PREFIX",
    "LocalAPIError",
    "MSG_NETWORK_OFF",
    "NetBackend",
    "NetworkOff",
    "SystemTailscale",
    "details_from_status",
    "localapi_get",
    "parse_whois",
    "select_backend",
    "set_backend_override",
    "socket_answers",
    "strip_prefix",
]
