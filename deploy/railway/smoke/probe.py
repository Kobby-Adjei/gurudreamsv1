"""Raw HTTP/1.1 Upgrade probes against the public domain (evidence for Railway edge behaviour)."""
import base64, json, os, socket, ssl, sys

host = os.environ["SMOKE_CONTROL_URL"].split("://", 1)[1].rstrip("/")
ws_key = base64.b64encode(os.urandom(16)).decode()
CASES = {
    "ts2021_tailscale_upgrade": ("POST", "/ts2021?X-Tailscale-Handshake=AAAA", {"Upgrade": "tailscale-control-protocol", "Connection": "Upgrade", "X-Tailscale-Handshake": "AAAA"}),
    "ts2021_websocket_upgrade": ("GET", "/ts2021?X-Tailscale-Handshake=AAAA", {"Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": ws_key, "Sec-WebSocket-Protocol": "tailscale-control-protocol"}),
    "derp_DERP_upgrade": ("GET", "/derp", {"Upgrade": "DERP", "Connection": "Upgrade"}),
    "derp_websocket_upgrade": ("GET", "/derp", {"Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": ws_key, "Sec-WebSocket-Protocol": "derp"}),
    "derp_probe_plain": ("GET", "/derp/probe", {}),
}
out = {}
for name, (method, path, hdrs) in CASES.items():
    try:
        ctx = ssl.create_default_context()
        ctx.set_alpn_protocols(["http/1.1"])
        with socket.create_connection((host, 443), timeout=10) as raw, ctx.wrap_socket(raw, server_hostname=host) as s:
            req = f"{method} {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: airbridge-probe\r\n" + "".join(f"{k}: {v}\r\n" for k, v in hdrs.items()) + "\r\n"
            s.sendall(req.encode())
            data = b""
            while b"\r\n\r\n" not in data and len(data) < 8192:
                chunk = s.recv(4096)
                if not chunk:
                    break
                data += chunk
            head = data.split(b"\r\n\r\n", 1)[0].decode(errors="replace").split("\r\n")
            out[name] = {"status": head[0], "headers": [h for h in head[1:] if h.split(":")[0].lower() in ("upgrade", "connection", "sec-websocket-protocol", "content-type", "server", "x-railway-edge")]}
    except Exception as exc:  # noqa: BLE001
        out[name] = {"error": repr(exc)[:200]}
print("PROBE_RESULT " + json.dumps(out), flush=True)
