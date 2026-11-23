"""Network backends: how AirBridge talks to the private network (Phase 3).

Two implementations of one small protocol (:class:`NetBackend`):

* :class:`SystemTailscale` - the Phase-1 path of the free CLI: a system-wide
  Tailscale install, queried through the ``tailscale`` CLI (code lives in
  :mod:`network`, behaviour unchanged). The inbox binds the machine's tailnet
  IP and outbound requests go straight to peers' tailnet IPs.
* :class:`SidecarBackend` - the desktop app's ``airbridge-net`` sidecar
  (embedded ``tsnet``, PHASE3_PLAN.md §9). The sidecar owns the private
  network; this process only talks to its local control API
  (``http://[::1]:<port>``, bearer token, no Origin):

  - ``GET /status`` / ``GET /nodes`` for this node and its same-user peers;
  - ``POST /send {target_hostname, payload}`` for outbound tasks (the sidecar
    resolves the name to a peer itself; raw IPs are never sent);
  - ``POST /inbox {port, token}`` to register the inbox, which binds
    ``127.0.0.1:<ephemeral>`` and only accepts requests carrying that token
    (``X-AirBridge-Sidecar-Token``); the sidecar forwards WhoIs-verified,
    same-user mesh requests there with ``X-AirBridge-Peer-Node`` /
    ``X-AirBridge-Peer-IP``.

Selection (:func:`select_backend`): ``AIRBRIDGE_NETWORK`` override, else the
sidecar endpoint from ``AIRBRIDGE_NET_URL``/``AIRBRIDGE_NET_TOKEN`` (daemon) or
``<data dir>/network.json`` v2 (MCP stdio process), else system. A
``network.json`` whose sidecar does not answer with no system Tailscale
installed is the "AirBridge network is off" error.

Never writes to stdout.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import logging
import os
import re
import sys
from typing import Any, Protocol
from urllib.parse import urlsplit

from . import config, network

logger = logging.getLogger("airbridge.netbackend")

SIDECAR_TIMEOUT_S = 5.0
SIDECAR_SEND_TIMEOUT_S = 15.0
SIDECAR_MAX_BYTES = 4 * 1024 * 1024
HOST_PREFIX = "airbridge-"
_ZERO_TIME_PREFIX = "0001-01-01"
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,256}$")

MSG_NETWORK_OFF = "AirBridge network is off \u2014 open the AirBridge app"
MSG_NOT_CONNECTED = "AirBridge network is not connected yet"


class NetworkOff(network.TailscaleNotRunning):
    """The app's network is configured (network.json / env) but not reachable."""


class SidecarError(network.TailscaleError):
    pass


# --------------------------------------------------------------------------- #
# Protocol
# --------------------------------------------------------------------------- #
class NetBackend(Protocol):
    kind: str  # "system" | "sidecar"

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
# airbridge-net sidecar (desktop app)
# --------------------------------------------------------------------------- #
def parse_sidecar_url(value: Any) -> tuple[str, int] | None:
    """``http://[::1]:P`` (preferred) or ``http://127.0.0.1:P`` -> (host, port); else None."""
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != "http" or parts.hostname not in ("::1", "127.0.0.1") or not port:
        return None
    if parts.username or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment:
        return None
    return parts.hostname, port


def valid_token(value: Any) -> str | None:
    return value if isinstance(value, str) and _TOKEN_RE.match(value) else None


class SidecarBackend:
    kind = "sidecar"

    def __init__(self, url: str, token: str) -> None:
        parsed = parse_sidecar_url(url)
        if parsed is None or valid_token(token) is None:
            raise NetworkOff(MSG_NETWORK_OFF)
        self.host, self.port = parsed
        self._token = token

    def __repr__(self) -> str:  # never the token
        return f"SidecarBackend(host={self.host!r}, port={self.port!r})"

    # -- transport -----------------------------------------------------------
    def _host_header(self) -> str:
        return f"[{self.host}]:{self.port}" if ":" in self.host else f"{self.host}:{self.port}"

    def request(self, method: str, path: str, body: Any = None,
                timeout: float = SIDECAR_TIMEOUT_S) -> tuple[int, Any]:
        """One request to the control API -> (status, parsed JSON or None)."""
        conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        try:
            payload = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
            conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            conn.putheader("Host", self._host_header())
            conn.putheader("Authorization", "Bearer " + self._token)
            conn.putheader("Accept", "application/json")
            if payload is not None:
                conn.putheader("Content-Type", "application/json")
                conn.putheader("Content-Length", str(len(payload)))
            conn.endheaders(payload)
            resp = conn.getresponse()
            raw = resp.read(SIDECAR_MAX_BYTES + 1)
        except (OSError, http.client.HTTPException) as exc:
            raise NetworkOff(MSG_NETWORK_OFF) from exc
        finally:
            conn.close()
        if len(raw) > SIDECAR_MAX_BYTES:
            raise SidecarError("AirBridge network returned too much data")
        try:
            data = json.loads(raw) if raw else None
        except ValueError:
            data = None
        return resp.status, data

    def _get(self, path: str) -> dict[str, Any]:
        status, data = self.request("GET", path)
        if status == 401 or status == 403:
            raise NetworkOff(MSG_NETWORK_OFF)
        if status != 200 or not isinstance(data, dict):
            raise SidecarError(f"AirBridge network error (HTTP {status})")
        return data

    def alive(self) -> bool:
        try:
            self._get("/status")
            return True
        except network.TailscaleError:
            return False

    # -- NetBackend ----------------------------------------------------------
    def status(self) -> dict[str, Any]:
        return self._get("/status")

    def _connected_status(self) -> dict[str, Any]:
        data = self.status()
        state = data.get("state")
        if state != "connected":
            raise network.TailscaleNotRunning(f"{MSG_NOT_CONNECTED} (state: {str(state)[:32]})")
        return data

    def local_ip(self) -> str:
        me = self._connected_status().get("self")
        ip = me.get("ip") if isinstance(me, dict) else None
        if not isinstance(ip, str) or not network._is_tailscale_ipv4(ip):
            raise network.TailscaleNotRunning(MSG_NOT_CONNECTED)
        return ip

    def self_hostname(self) -> str | None:
        """This node's control-assigned name (what receivers verify), prefix stripped."""
        me = self.status().get("self")
        name = me.get("hostname") if isinstance(me, dict) else None
        return _str_or_none(name)

    def peer_details(self) -> dict[str, Any]:
        from . import events

        data = self._get("/nodes")
        if data.get("state") not in (None, "connected"):
            raise network.TailscaleNotRunning(f"{MSG_NOT_CONNECTED} (state: {str(data.get('state'))[:32]})")
        me_raw = data.get("self") if isinstance(data.get("self"), dict) else {}
        me = {
            "hostname": _str_or_none(me_raw.get("hostname")) or events.local_node_name(),
            "ip": me_raw.get("ip") if isinstance(me_raw.get("ip"), str) and network._is_tailscale_ipv4(me_raw["ip"]) else None,
            "os": _str_or_none(me_raw.get("os")) or _local_os(),
        }
        nodes: list[dict[str, Any]] = []
        for n in data.get("nodes") or []:
            if not isinstance(n, dict):
                continue
            name = _str_or_none(n.get("hostname"))
            ip = n.get("ip")
            if not name or not isinstance(ip, str) or not network._is_tailscale_ipv4(ip):
                continue
            last_seen = _str_or_none(n.get("last_seen"))
            nodes.append({
                "hostname": strip_prefix(name),
                "ip": ip,
                "os": _str_or_none(n.get("os")),
                "online": n.get("online") is True,
                "last_seen": None if (last_seen or "").startswith(_ZERO_TIME_PREFIX) else last_seen,
            })
        nodes.sort(key=lambda n: (not n["online"], n["hostname"].lower()))
        return {"self": me, "nodes": nodes}

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
        return self.peers().get(strip_prefix(wanted.split(".", 1)[0]))

    def inbound_bind_host(self) -> str:
        return "127.0.0.1"

    def requests_proxies(self) -> dict[str, str] | None:
        return None

    def whois(self, remote_addr: str) -> dict[str, Any] | None:
        """Not used: the sidecar verifies peers itself (WhoIs on the mesh connection)."""
        return None

    def self_user_id(self) -> int | None:
        me = self.status().get("self")
        uid = me.get("user_id") if isinstance(me, dict) else None
        return uid if isinstance(uid, int) and not isinstance(uid, bool) else None

    # -- sidecar-only --------------------------------------------------------
    def register_inbox(self, port: int, token: str) -> None:
        status, _ = self.request("POST", "/inbox", {"port": int(port), "token": token})
        if status != 200:
            raise SidecarError(f"could not register the inbox with the AirBridge network (HTTP {status})")

    def send(self, target_hostname: str, payload: dict[str, Any], secret: str | None = None,
             timeout: float = SIDECAR_SEND_TIMEOUT_S) -> tuple[int, dict[str, Any]]:
        """``POST /send``. Returns (control-API status, response object)."""
        body: dict[str, Any] = {"target_hostname": target_hostname, "payload": payload}
        if secret:
            body["secret"] = secret
        status, data = self.request("POST", "/send", body, timeout=timeout)
        return status, data if isinstance(data, dict) else {}


# --------------------------------------------------------------------------- #
# Selection
# --------------------------------------------------------------------------- #
_override: NetBackend | None = None


def set_backend_override(backend: NetBackend | None) -> None:
    """Tests / embedding: force a backend (None restores normal selection)."""
    global _override
    _override = backend


def _sidecar_endpoint() -> tuple[str | None, str | None, bool]:
    """(url, token, network_json_present): env first (daemon), then network.json (MCP)."""

    env_url = os.environ.get(config.ENV_NET_URL, "").strip()
    env_tok = os.environ.get(config.ENV_NET_TOKEN, "").strip()
    if parse_sidecar_url(env_url) and valid_token(env_tok):
        return env_url, env_tok, False
    info = config.read_network_json()
    if not info:
        return None, None, False
    url = info.get("control_url_local")
    tok = info.get("control_token")
    if parse_sidecar_url(url) and valid_token(tok) and info.get("pid"):
        return url, tok, True
    return None, None, True


def _system_available() -> bool:
    try:
        network.tailscale_binary()
        return True
    except network.TailscaleError:
        return False


def select_backend() -> NetBackend:
    """Pick the backend for this call (cheap: env + a small file + maybe one local request)."""
    if _override is not None:
        return _override
    mode = config.network_mode()
    if mode == "system":
        return SystemTailscale()
    url, token, present = _sidecar_endpoint()
    if mode == "sidecar":
        if not url or not token:
            raise NetworkOff(MSG_NETWORK_OFF)
        return SidecarBackend(url, token)
    # auto (MCP stdio process of the free CLI or of the app)
    if url and token:
        backend = SidecarBackend(url, token)
        if backend.alive():
            return backend
        if _system_available():
            return SystemTailscale()
        raise NetworkOff(MSG_NETWORK_OFF)
    if present and not _system_available():
        raise NetworkOff(MSG_NETWORK_OFF)
    return SystemTailscale()


__all__ = [
    "HOST_PREFIX",
    "MSG_NETWORK_OFF",
    "NetBackend",
    "NetworkOff",
    "SidecarBackend",
    "SidecarError",
    "SystemTailscale",
    "details_from_status",
    "parse_sidecar_url",
    "parse_whois",
    "select_backend",
    "set_backend_override",
    "strip_prefix",
]
