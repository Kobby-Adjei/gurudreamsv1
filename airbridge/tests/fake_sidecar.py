"""In-process fake of the airbridge-net sidecar's local control API (PHASE3_PLAN.md §9).

Serves the same guard (loopback, no Origin, exact Host, bearer token) and the endpoints
the Python side uses: GET /status, GET /nodes, POST /send, POST /inbox, POST /logout.
Records every request in ``.requests``.
"""

from __future__ import annotations

import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

TOKEN = "fake-sidecar-token-0123456789abcdefghijklmnop"
SELF_UID = 7


def make_nodes() -> list[dict[str, Any]]:
    return [
        {"hostname": "desktop", "ip": "100.64.0.2", "os": "windows", "online": True, "last_seen": None},
        {"hostname": "laptop", "ip": "100.64.0.3", "os": "macOS", "online": False,
         "last_seen": "2026-11-01T00:00:00Z"},
    ]


class FakeSidecar:
    def __init__(self, token: str = TOKEN) -> None:
        self.token = token
        self.state = "connected"
        self.self_info: dict[str, Any] = {"hostname": "a1", "ip": "100.64.0.1", "user_id": SELF_UID, "os": "linux"}
        self.nodes = make_nodes()
        self.requests: list[dict[str, Any]] = []
        self.inbox: tuple[int, str] | None = None
        # POST /send: (control status, response body) or a callable(body) -> that.
        self.send_reply: Any = (200, {"ok": True, "status": 201, "body": json.dumps({"status": "ok", "file": "t.md"})})
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def _reply(self, status: int, obj: Any) -> None:
                raw = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _handle(self, method: str) -> None:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"null") if n else None
                fake.requests.append({"method": method, "path": self.path, "headers": dict(self.headers),
                                      "body": body})
                if "Origin" in self.headers:
                    return self._reply(403, {"ok": False, "error": "forbidden"})
                if self.headers.get("Host") != f"127.0.0.1:{fake.port}":
                    return self._reply(403, {"ok": False, "error": "bad host"})
                if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + fake.token):
                    return self._reply(401, {"ok": False, "error": "unauthorized"})
                if method == "GET" and self.path == "/status":
                    return self._reply(200, {"state": fake.state, "self": fake.self_info})
                if method == "GET" and self.path == "/nodes":
                    return self._reply(200, {"state": fake.state, "self": fake.self_info, "nodes": fake.nodes})
                if method == "POST" and self.path == "/inbox":
                    fake.inbox = (body["port"], body["token"])
                    return self._reply(200, {"ok": True})
                if method == "POST" and self.path == "/send":
                    status, obj = fake.send_reply(body) if callable(fake.send_reply) else fake.send_reply
                    return self._reply(status, obj)
                if method == "POST" and self.path == "/logout":
                    return self._reply(200, {"ok": True})
                return self._reply(404, {"ok": False})

            def do_GET(self) -> None:  # noqa: N802
                self._handle("GET")

            def do_POST(self) -> None:  # noqa: N802
                self._handle("POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> FakeSidecar:
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()


def write_network_json(data_dir: str | Path, url: str, token: str = TOKEN, pid: int | None = 4242,
                       **extra: Any) -> Path:
    """network.json v2 as NetManager.ts writes it (0600)."""
    path = Path(data_dir) / "network.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    obj = {"v": 2, "mode": "sidecar", "control_url_local": url, "control_token": token, "pid": pid,
           "bin": "/app/airbridge-net", **extra}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(obj, fh)
    return path
