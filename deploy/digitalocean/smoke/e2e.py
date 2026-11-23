"""End-to-end smoke test for the AirBridge cloud droplet (deploy/digitalocean/README.md "End-to-end smoke test").

Runs on any Linux machine with outbound HTTPS. Gets a throwaway Headscale user + 2 single-use pre-auth keys from the
TEMPORARY admin endpoint (SMOKE_TEST=1, bearer = waitlist admin token), starts two real airbridge-net sidecars
(separate state dirs) and two real AirBridge daemons in sidecar mode, and checks: both `connected`, mutual
visibility in /nodes, and real deliveries both ways (/send_task -> sidecar /send -> peer mesh :8989 -> peer inbox).
With --cleanup it then stops everything, calls POST /v1/admin/smoke/cleanup (deletes the smoke user + nodes and turns
the endpoints off for good) and checks that both endpoints answer 404.

  python3 deploy/digitalocean/smoke/e2e.py --base https://<host> --token-file <file> [--cleanup]
      [--net-bin desktop/resources/net/linux-x64/airbridge-net] [--python <venv python with airbridge deps>]

Pre-auth keys and the admin token are never printed. Prints one line: SMOKE_RESULT {...}. Proxy env (HTTPS_PROXY,
NO_PROXY) and SSL_CERT_FILE are passed to the sidecars, so it also works behind an egress proxy (DERP over 443 then).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback APIs: never via a proxy
DERP_RE = re.compile(r"derp|magicsock|netcheck|home is now|endpoints changed", re.I)
SECRETISH = re.compile(r"(hskey|tskey|nodekey|privkey|auth[_-]?key)", re.I)


def log(msg: str, **kw) -> None:
    print(json.dumps({"smoke": msg, **kw}), file=sys.stderr, flush=True)


def http(opener, method: str, url: str, body=None, headers=None, timeout: float = 40):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with opener.open(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw.decode(errors="replace")[:200]}


def wait(pred, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            v = pred()
            if v:
                return v
        except Exception as exc:  # noqa: BLE001
            last = exc
        time.sleep(0.25)
    raise RuntimeError(f"timeout waiting for {what} (last: {last!r})")


def child_env(**extra):
    keep = ("PATH", "HOME", "LANG", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
            "SSL_CERT_FILE")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env["TS_NO_LOGS_NO_SUPPORT"] = "true"
    env.update(extra)
    return env


class Sidecar:
    def __init__(self, root: Path, name: str, control_url: str, net_bin: str):
        self.name, self.dir, self.control_url, self.bin = name, root / name, control_url, net_bin
        self.dir.mkdir(mode=0o700)
        self.token = secrets.token_urlsafe(32)
        self.derp_lines: list[str] = []

    def start(self, auth_key: str) -> None:
        cfg = {"control_url": self.control_url, "hostname": f"airbridge-{self.name}", "control_token": self.token,
               "state_dir": str(self.dir / "tsnet"), "parent_pid": os.getpid(), "verbose": True, "auth_key": auth_key}
        self.proc = subprocess.Popen([self.bin], env=child_env(), stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.PIPE, cwd=str(self.dir))
        self.proc.stdin.write((json.dumps(cfg) + "\n").encode())
        self.proc.stdin.close()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            line = self.proc.stderr.readline().decode(errors="replace")
            if not line:
                raise RuntimeError(f"sidecar {self.name} exited early")
            if line.startswith("AIRBRIDGE_NET_READY "):
                info = json.loads(line.split(" ", 1)[1])
                host = "[::1]" if info.get("host") == "::1" else "127.0.0.1"
                self.url = f"http://{host}:{info['port']}"
                break
        else:
            raise RuntimeError(f"sidecar {self.name}: no READY line")
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        for raw in iter(self.proc.stderr.readline, b""):
            text = raw.decode(errors="replace").rstrip()
            if DERP_RE.search(text) and not SECRETISH.search(text):
                self.derp_lines.append(text[:240])

    def api(self, method, path, body=None):
        return http(LOCAL, method, self.url + path, body, {"Authorization": f"Bearer {self.token}"})

    def stop(self) -> None:
        if getattr(self, "proc", None) and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class Daemon:
    def __init__(self, sc: Sidecar, python: str):
        self.token = secrets.token_urlsafe(32)
        self.inbox = sc.dir / "inbox"
        env = child_env(AIRBRIDGE_NETWORK="sidecar", AIRBRIDGE_NET_URL=sc.url, AIRBRIDGE_NET_TOKEN=sc.token,
                        AIRBRIDGE_CONTROL_TOKEN=self.token, AIRBRIDGE_CONTROL_PORT="0",
                        AIRBRIDGE_DATA_DIR=str(sc.dir / "data"), AIRBRIDGE_INBOX_DIR=str(self.inbox),
                        AIRBRIDGE_LOG_FILE=str(sc.dir / "airbridge.log"), PYTHONUNBUFFERED="1")
        for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
            env.pop(k, None)  # the daemon only talks to loopback
        self.proc = subprocess.Popen([python, str(REPO / "airbridge" / "main.py"), "--daemon"], env=env,
                                     cwd=str(sc.dir), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.PIPE)
        line = self.proc.stderr.readline().decode()
        if not line.startswith("AIRBRIDGE_READY "):
            raise RuntimeError(f"daemon did not start: {line[:200]}")
        info = json.loads(line.split(" ", 1)[1])
        host = "[::1]" if info.get("control_host") == "::1" else "127.0.0.1"
        self.url = f"http://{host}:{info['control_port']}"
        threading.Thread(target=lambda: [None for _ in iter(self.proc.stderr.readline, b"")], daemon=True).start()

    def api(self, method, path, body=None):
        return http(LOCAL, method, self.url + path, body, {"Authorization": f"Bearer {self.token}"})

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="https://<host>")
    ap.add_argument("--token-file", required=True, help="file holding the waitlist admin token")
    ap.add_argument("--net-bin", default=str(REPO / "desktop/resources/net/linux-x64/airbridge-net"))
    ap.add_argument("--python", default=sys.executable, help="python with airbridge/requirements.txt installed")
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--cleanup", action="store_true")
    ap.add_argument("--cafile", default=os.environ.get("SSL_CERT_FILE"))
    args = ap.parse_args()

    base = args.base.rstrip("/")
    ctx = ssl.create_default_context(cafile=args.cafile) if args.cafile else ssl.create_default_context()
    remote = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
    token = Path(args.token_file).read_text().strip()
    admin = {"Authorization": f"Bearer {token}"}
    result: dict = {"ok": False, "base": base}
    scs: dict[str, Sidecar] = {}
    dms: dict[str, Daemon] = {}
    try:
        code, keys = http(remote, "POST", f"{base}/v1/admin/smoke/keys", {}, admin)
        if code != 200:
            raise RuntimeError(f"smoke keys: HTTP {code} {keys}")
        result["smoke_user"] = keys["user"]
        control = keys["login_server"]
        result["login_server"] = control
        auth_keys = list(keys.pop("auth_keys"))
        root = Path(tempfile.mkdtemp(prefix="absmoke"))
        t0 = time.monotonic()
        scs = {n: Sidecar(root, n, control, args.net_bin) for n in ("s1", "s2")}
        for sc, k in zip(scs.values(), auth_keys):
            sc.start(k)
        del auth_keys, keys
        for n, sc in scs.items():
            st = wait(lambda sc=sc: (s := sc.api("GET", "/status")[1]).get("state") == "connected" and s, 120,
                      f"{n} connected")
            result[f"{n}_status"] = {"state": st["state"], "ip": st["self"]["ip"], "hostname": st["self"]["hostname"]}
        result["enroll_seconds"] = round(time.monotonic() - t0, 2)
        log("both connected", seconds=result["enroll_seconds"])
        # Control-assigned names (Headscale suffixes -1, -2, ... when a name is taken), as /status reports them.
        name = {n: result[f"{n}_status"]["hostname"] for n in scs}
        for a, b in (("s1", "s2"), ("s2", "s1")):
            node = wait(lambda a=a, b=b: next((x for x in scs[a].api("GET", "/nodes")[1]["nodes"]
                                               if x["hostname"] == name[b] and x["online"]), None), 90, f"{a} sees {b}")
            result[f"{a}_sees_{b}"] = {"ip": node["ip"], "online": node["online"]}
        log("mutual visibility ok")
        dms = {n: Daemon(sc, args.python) for n, sc in scs.items()}
        for n, dm in dms.items():
            wait(lambda dm=dm: dm.api("GET", "/status")[1]["inbox"]["listening"], 60, f"{n} inbox")
        timings: dict[str, list[float]] = {"s1->s2": [], "s2->s1": []}
        for i in range(args.rounds):
            for a, b in (("s1", "s2"), ("s2", "s1")):
                before = set(dms[b].inbox.glob("*.md")) if dms[b].inbox.exists() else set()
                marker = f"smoke {a} to {b} round {i} {secrets.token_hex(4)}"
                t = time.monotonic()
                code, res = dms[a].api("POST", "/send_task", {"target_hostname": name[b], "task_description": marker})
                dt = time.monotonic() - t
                if code != 200 or not res.get("ok"):
                    raise RuntimeError(f"send {a}->{b} #{i}: {code} {str(res)[:200]}")
                new = [f for f in dms[b].inbox.glob("*.md") if f not in before]
                if not any(marker in f.read_text(encoding="utf-8") for f in new):
                    raise RuntimeError(f"send {a}->{b} #{i}: delivered but not found in the inbox")
                timings[f"{a}->{b}"].append(round(dt * 1000, 1))
            time.sleep(0.3)
        result["send_ms"] = timings
        allv = sorted(v for vs in timings.values() for v in vs)
        result["send_ms_summary"] = {"first": timings["s1->s2"][0], "min": allv[0], "median": allv[len(allv) // 2],
                                     "max": allv[-1]}
        result["ok"] = True
    except Exception as exc:  # noqa: BLE001
        result["error"] = str(exc)[:500]
    finally:
        for dm in dms.values():
            dm.stop()
        for n, sc in scs.items():
            sc.stop()
            result[f"{n}_derp_log_tail"] = sc.derp_lines[-6:]
    if args.cleanup:
        code, body = http(remote, "POST", f"{base}/v1/admin/smoke/cleanup", {}, admin)
        result["cleanup"] = {"status": code, **(body if isinstance(body, dict) else {})}
        time.sleep(3)  # the host's smoke-off path unit flips SMOKE_TEST=0 and restarts the license server
        result["after_cleanup"] = {
            p: http(remote, "POST", f"{base}{p}", {}, admin)[0]
            for p in ("/v1/admin/smoke/keys", "/v1/admin/smoke/cleanup")
        }
    print("SMOKE_RESULT " + json.dumps(result), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
