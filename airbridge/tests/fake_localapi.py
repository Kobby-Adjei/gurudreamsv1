"""A fake tailscaled LocalAPI served over a Unix socket (test helper).

Serves ``GET /localapi/v0/status`` and ``GET /localapi/v0/whois?addr=`` from
in-memory data, records every request (path + headers) and runs in a
background thread. Socket paths live in a short ``/tmp`` dir because
``sun_path`` is limited to ~100 bytes (pytest's tmp_path is often longer).
"""

from __future__ import annotations

import json
import os
import shutil
import socketserver
import tempfile
import threading
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.parse import parse_qs, urlsplit

SELF_UID = 1001
OTHER_UID = 2002


def make_status(state: str = "Running") -> dict[str, Any]:
    return {
        "BackendState": state,
        "Self": {
            "HostName": "airbridge-thismac",
            "DNSName": "airbridge-thismac.u-abc.airbridge.internal.",
            "TailscaleIPs": ["100.64.0.1", "fd7a:115c:a1e0::1"],
            "OS": "macOS",
            "UserID": SELF_UID,
            "Online": True,
        },
        "Peer": {
            "nodekey:a": {
                "HostName": "airbridge-desktop",
                "DNSName": "airbridge-desktop.u-abc.airbridge.internal.",
                "TailscaleIPs": ["100.64.0.2"],
                "OS": "windows",
                "UserID": SELF_UID,
                "Online": True,
                "LastSeen": "0001-01-01T00:00:00Z",
            },
            "nodekey:b": {
                "HostName": "airbridge-old-laptop",
                "DNSName": "airbridge-old-laptop.u-abc.airbridge.internal.",
                "TailscaleIPs": ["100.64.0.3"],
                "OS": "linux",
                "UserID": SELF_UID,
                "Online": False,
                "LastSeen": "2026-11-01T10:00:00Z",
            },
            "nodekey:c": {  # another customer's node: must never be listed
                "HostName": "airbridge-stranger",
                "TailscaleIPs": ["100.64.0.9"],
                "OS": "linux",
                "UserID": OTHER_UID,
                "Online": True,
            },
        },
    }


def make_whois(name: str, uid: int, ip: str) -> dict[str, Any]:
    return {
        "Node": {
            "ID": 7,
            "StableID": f"n-{name}",
            "Name": f"{name}.u-abc.airbridge.internal.",
            "Addresses": [f"{ip}/32"],
            "User": uid,
            "Hostinfo": {"Hostname": "peer-asserted-name", "OS": "linux"},
        },
        "UserProfile": {"ID": uid, "LoginName": "u-abc", "DisplayName": "u-abc"},
    }


class FakeLocalAPI:
    def __init__(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="abla", dir="/tmp" if os.path.isdir("/tmp") else None)
        self.path = os.path.join(self.dir, "ts.sock")
        self.status: dict[str, Any] = make_status()
        self.whois: dict[str, dict[str, Any]] = {}  # "127.0.0.1:port" -> WhoIsResponse
        self.requests: list[dict[str, Any]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a: Any) -> None:  # never print
                pass

            def address_string(self) -> str:
                return "unix"

            def _send(self, code: int, body: Any) -> None:
                raw = json.dumps(body).encode() if not isinstance(body, bytes) else body
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self) -> None:  # noqa: N802
                parts = urlsplit(self.path)
                q = parse_qs(parts.query)
                fake.requests.append({"path": parts.path, "query": q, "headers": dict(self.headers)})
                if self.headers.get("Sec-Tailscale") != "localapi":
                    self._send(403, b"missing Sec-Tailscale header")
                    return
                if parts.path == "/localapi/v0/status":
                    self._send(200, fake.status)
                elif parts.path == "/localapi/v0/whois":
                    addr = (q.get("addr") or [""])[0]
                    hit = fake.whois.get(addr)
                    if hit is None:
                        self._send(404, b"no match for IP:port")
                    else:
                        self._send(200, hit)
                else:
                    self._send(404, b"not found")

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

        self.server = Server(self.path, Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)

    def __enter__(self) -> FakeLocalAPI:
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)


def write_network_json(data_dir: Any, socket_path: str, socks5: str = "127.0.0.1:41080") -> None:
    path = os.path.join(str(data_dir), "network.json")
    os.makedirs(str(data_dir), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"v": 1, "socket": socket_path, "socks5": socks5, "pid": 1, "bin": "/x/tailscaled",
                   "login_server": "https://hs.example", "enrolled_sub_hash": "0" * 64}, fh)
    os.chmod(path, 0o600)
