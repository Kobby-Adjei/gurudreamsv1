"""TEMPORARY Railway smoke client for the AirBridge cloud (deploy/railway/README.md, "Smoke test").

Runs two real airbridge-net sidecars (tsnet v1.104.7) + two real AirBridge daemons in this container,
enrolls both against the public control server with two single-use pre-auth keys, and checks:
connected, mutual visibility in /nodes, and real /send_task deliveries both ways (with timings).
Logs which DERP region / path the sidecars report when verbose. Prints one line:
  SMOKE_RESULT {...json...}
Env: SMOKE_CONTROL_URL (https://<domain>), SMOKE_KEY_1, SMOKE_KEY_2, SMOKE_ROUNDS (default 5).
Pre-auth keys are never printed. The process sleeps afterwards so the logs stay readable.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

NET_BIN = "/usr/local/bin/airbridge-net"
MAIN_PY = "/app/airbridge/main.py"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def log(msg: str, **kw) -> None:
    print(json.dumps({"smoke": msg, **kw}), flush=True)


def http(method: str, url: str, body=None, headers=None, timeout: float = 40):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with OPENER.open(req, timeout=timeout) as r:
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


def env_base(**extra):
    env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG") if k in os.environ}
    env["TS_NO_LOGS_NO_SUPPORT"] = "true"
    env.update(extra)
    return env


def pump(name: str, stream) -> None:
    for line in iter(stream.readline, b""):
        text = line.decode(errors="replace").rstrip()
        low = text.lower()
        # Keep the interesting connectivity lines; drop anything key-shaped.
        if "key" in low and ("auth" in low or "hskey" in low or "tskey" in low):
            continue
        if any(s in low for s in ("derp", "magicsock", "control", "ts2021", "noise", "error", "endpoint", "disco")):
            print(f"[{name}] {text[:300]}", flush=True)


class Sidecar:
    def __init__(self, root: Path, name: str, control_url: str):
        self.name, self.dir, self.control_url = name, root / name, control_url
        self.dir.mkdir(mode=0o700)
        self.token = secrets.token_urlsafe(32)

    def start(self, auth_key: str) -> None:
        cfg = {"control_url": self.control_url, "hostname": f"airbridge-{self.name}", "control_token": self.token,
               "state_dir": str(self.dir / "tsnet"), "parent_pid": os.getpid(), "verbose": True, "auth_key": auth_key}
        self.proc = subprocess.Popen([NET_BIN], env=env_base(), stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
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
                host = "[::1]" if info["host"] == "::1" else "127.0.0.1"
                self.url = f"http://{host}:{info['port']}"
                break
        else:
            raise RuntimeError(f"sidecar {self.name}: no READY")
        threading.Thread(target=pump, args=(self.name, self.proc.stderr), daemon=True).start()

    def api(self, method, path, body=None):
        return http(method, self.url + path, body, {"Authorization": f"Bearer {self.token}"})


class Daemon:
    def __init__(self, sc: Sidecar):
        self.token = secrets.token_urlsafe(32)
        self.inbox = sc.dir / "inbox"
        env = env_base(AIRBRIDGE_NETWORK="sidecar", AIRBRIDGE_NET_URL=sc.url, AIRBRIDGE_NET_TOKEN=sc.token,
                       AIRBRIDGE_CONTROL_TOKEN=self.token, AIRBRIDGE_CONTROL_PORT="0",
                       AIRBRIDGE_DATA_DIR=str(sc.dir / "data"), AIRBRIDGE_INBOX_DIR=str(self.inbox),
                       AIRBRIDGE_LOG_FILE=str(sc.dir / "airbridge.log"), PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen([sys.executable, MAIN_PY, "--daemon"], env=env, cwd=str(sc.dir),
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        line = self.proc.stderr.readline().decode()
        if not line.startswith("AIRBRIDGE_READY "):
            raise RuntimeError(f"daemon: {line[:200]}")
        info = json.loads(line.split(" ", 1)[1])
        host = "[::1]" if info.get("control_host") == "::1" else "127.0.0.1"
        self.url = f"http://{host}:{info['control_port']}"

    def api(self, method, path, body=None):
        return http(method, self.url + path, body, {"Authorization": f"Bearer {self.token}"})


def main() -> int:
    subprocess.run([sys.executable, "/app/probe.py"], check=False)
    result: dict = {"ok": False}
    try:
        control = os.environ["SMOKE_CONTROL_URL"]
        keys = [os.environ.pop("SMOKE_KEY_1"), os.environ.pop("SMOKE_KEY_2")]
        rounds = int(os.environ.get("SMOKE_ROUNDS", "5"))
        root = Path(tempfile.mkdtemp(prefix="absmoke"))
        t0 = time.monotonic()
        scs = {n: Sidecar(root, n, control) for n in ("s1", "s2")}
        for (n, sc), k in zip(scs.items(), keys):
            sc.start(k)
        del keys
        for n, sc in scs.items():
            st = wait(lambda sc=sc: (s := sc.api("GET", "/status")[1]).get("state") == "connected" and s, 120,
                      f"{n} connected")
            result[f"{n}_status"] = {"state": st["state"], "ip": st["self"]["ip"], "hostname": st["self"]["hostname"]}
        result["enroll_seconds"] = round(time.monotonic() - t0, 2)
        log("both connected", seconds=result["enroll_seconds"])
        dms = {n: Daemon(sc) for n, sc in scs.items()}
        for n, dm in dms.items():
            wait(lambda dm=dm: dm.api("GET", "/status")[1]["inbox"]["listening"], 60, f"{n} inbox")
        for a, b in (("s1", "s2"), ("s2", "s1")):
            node = wait(lambda a=a, b=b: next((x for x in scs[a].api("GET", "/nodes")[1]["nodes"]
                                               if x["hostname"] == b and x["online"]), None), 90, f"{a} sees {b}")
            result[f"{a}_sees_{b}"] = node["ip"]
        timings: dict[str, list[float]] = {"s1->s2": [], "s2->s1": []}
        for i in range(rounds):
            for a, b in (("s1", "s2"), ("s2", "s1")):
                before = set(dms[b].inbox.glob("*.md")) if dms[b].inbox.exists() else set()
                marker = f"smoke {a}->{b} #{i} {secrets.token_hex(4)}"
                t = time.monotonic()
                code, res = dms[a].api("POST", "/send_task", {"target_hostname": b, "task_description": marker})
                dt = time.monotonic() - t
                if code != 200 or not res.get("ok"):
                    raise RuntimeError(f"send {a}->{b} #{i}: {code} {str(res)[:200]}")
                new = [f for f in dms[b].inbox.glob("*.md") if f not in before]
                if not any(marker in f.read_text(encoding="utf-8") for f in new):
                    raise RuntimeError(f"send {a}->{b} #{i}: not in inbox")
                timings[f"{a}->{b}"].append(round(dt * 1000, 1))
            time.sleep(0.5)
        result["send_ms"] = timings
        allv = sorted(v for vs in timings.values() for v in vs)
        result["send_ms_summary"] = {"first": timings["s1->s2"][0], "min": allv[0], "median": allv[len(allv) // 2],
                                     "max": allv[-1]}
        result["ok"] = True
    except Exception as exc:  # noqa: BLE001
        result["error"] = str(exc)[:500]
    print("SMOKE_RESULT " + json.dumps(result), flush=True)
    # Stay up (Railway would otherwise restart us) so logs remain; the service is deleted after the test.
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    sys.exit(main())
