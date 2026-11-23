"""Tests for airbridge_app.events (activity.jsonl v1)."""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from airbridge_app import events

AIRBRIDGE_DIR = Path(__file__).resolve().parent.parent
ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "data"
    monkeypatch.setenv("AIRBRIDGE_DATA_DIR", str(d))
    events.configure(None)
    events.set_origin("mcp")
    yield d
    events.configure(None)
    events.set_origin("mcp")


def _lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def test_schema(data_dir):
    events.emit("task_received", peer="MacBook", summary="Received task from MacBook", bytes=42, file="task_1.md")
    (ev,) = _lines(data_dir / "activity.jsonl")
    assert set(ev) == {"v", "id", "ts", "type", "origin", "local_node", "peer", "summary", "detail"}
    assert ev["v"] == 1
    assert uuid.UUID(ev["id"]).version == 4
    assert ISO_Z.match(ev["ts"])
    assert ev["type"] == "task_received"
    assert ev["origin"] == "mcp"
    assert ev["peer"] == "MacBook"
    assert ev["summary"] == "Received task from MacBook"
    assert ev["detail"] == {"bytes": 42, "file": "task_1.md"}
    assert ev["local_node"]


def test_origin_default_and_override(data_dir):
    events.set_origin("daemon")
    events.emit("daemon_started")
    events.emit("task_sent", peer="x", origin="mcp")
    a, b = _lines(data_dir / "activity.jsonl")
    assert a["origin"] == "daemon"
    assert b["origin"] == "mcp"
    with pytest.raises(ValueError):
        events.set_origin("browser")


@pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")
def test_file_mode_0600(data_dir):
    events.emit("daemon_started")
    mode = (data_dir / "activity.jsonl").stat().st_mode & 0o777
    assert mode == 0o600


def test_summary_neutralized_and_bounded(data_dir):
    evil = "# heading\n<script>alert(1)</script>\x1b[31m" + "A" * 500
    events.emit("task_received", peer="p\nq", summary=evil)
    (ev,) = _lines(data_dir / "activity.jsonl")
    s = ev["summary"]
    assert len(s) <= 120
    assert "\n" not in s and "\x1b" not in s
    assert "<script>" not in s
    assert "\n" not in ev["peer"]


def test_detail_whitelist_and_no_bodies(data_dir):
    events.emit("task_sent", peer="desk", summary="Sent code to desk", bytes=10,
                file="/etc/secret/dir/task.md", task_description="TOP SECRET BODY", code_payload="rm -rf /")
    raw = (data_dir / "activity.jsonl").read_text()
    assert "TOP SECRET" not in raw and "rm -rf" not in raw
    (ev,) = _lines(data_dir / "activity.jsonl")
    assert ev["detail"] == {"bytes": 10, "file": "task.md"}


def test_emit_never_raises(data_dir, monkeypatch):
    events.emit("not_a_type")  # unknown type: swallowed
    def boom(_ev):
        raise OSError("disk full")
    monkeypatch.setattr(events, "append", boom)
    events.emit("daemon_started")  # swallowed
    assert not (data_dir / "activity.jsonl").exists()


def test_rotation(data_dir, monkeypatch):
    monkeypatch.setattr(events, "MAX_FILE_BYTES", 2000)
    for i in range(60):
        events.emit("node_online", peer=f"n{i}", summary=f"n{i} came online")
    base = data_dir / "activity.jsonl"
    assert base.exists()
    assert (data_dir / "activity.jsonl.1").exists()
    assert (data_dir / "activity.jsonl.3").exists()
    assert not (data_dir / "activity.jsonl.4").exists()
    for f in [base] + [data_dir / f"activity.jsonl.{i}" for i in (1, 2, 3)]:
        assert f.stat().st_size <= 2000
        _lines(f)  # every line is valid JSON
    recent = events.read_recent(5)
    assert [e["peer"] for e in recent] == [f"n{i}" for i in range(55, 60)]


def test_read_recent_after_id(data_dir):
    for i in range(5):
        events.emit("node_online", peer=f"n{i}")
    allev = events.read_recent(100)
    assert [e["peer"] for e in allev] == [f"n{i}" for i in range(5)]
    after = events.read_recent(100, after_id=allev[1]["id"])
    assert [e["peer"] for e in after] == ["n2", "n3", "n4"]
    assert [e["peer"] for e in events.read_recent(2, after_id=allev[0]["id"])] == ["n1", "n2"]
    assert events.read_recent(100, after_id=allev[-1]["id"]) == []


def test_read_recent_skips_garbage(data_dir):
    data_dir.mkdir(parents=True)
    (data_dir / "activity.jsonl").write_text('not json\n{"v":2,"id":"x"}\n')
    events.emit("daemon_started")
    assert [e["type"] for e in events.read_recent()] == ["daemon_started"]


_WRITER = """
import sys
sys.path.insert(0, sys.argv[1])
from airbridge_app import events
for i in range(int(sys.argv[3])):
    events.emit("task_sent", peer=sys.argv[2], summary="Sent task to " + sys.argv[2] + " " + "x" * 80, bytes=i)
"""


def test_two_process_concurrent_appends_no_torn_lines(data_dir, monkeypatch):
    n = 300
    env = dict(os.environ, AIRBRIDGE_DATA_DIR=str(data_dir))
    procs = [
        subprocess.Popen([sys.executable, "-c", _WRITER, str(AIRBRIDGE_DIR), name, str(n)], env=env)
        for name in ("alpha", "beta")
    ]
    for p in procs:
        assert p.wait(timeout=60) == 0
    lines = (data_dir / "activity.jsonl").read_text().splitlines()
    assert len(lines) == 2 * n
    parsed = [json.loads(line) for line in lines]
    assert sum(1 for e in parsed if e["peer"] == "alpha") == n
    assert sum(1 for e in parsed if e["peer"] == "beta") == n
    assert len({e["id"] for e in parsed}) == 2 * n


def test_tail_delivers_new_events_and_survives_rotation(data_dir, monkeypatch):
    events.emit("daemon_started")  # pre-existing: not replayed without after_id

    async def scenario():
        got: list[dict] = []
        agen = events.tail(poll_s=0.02)

        async def collect():
            async for ev in agen:
                got.append(ev)
                if len(got) >= 3:
                    return

        task = asyncio.create_task(collect())
        await asyncio.sleep(0.1)
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        events.emit("node_online", peer="one")
        while not got and loop.time() - t0 < 1.0:
            await asyncio.sleep(0.01)
        latency = loop.time() - t0
        monkeypatch.setattr(events, "MAX_FILE_BYTES", 1)  # force rotation on next write
        events.emit("node_online", peer="two")
        events.emit("node_online", peer="three")
        await asyncio.wait_for(task, timeout=3)
        await agen.aclose()
        return got, latency

    got, latency = asyncio.run(scenario())
    assert latency < 1.0
    assert [e["peer"] for e in got] == ["one", "two", "three"]


def test_tail_replays_after_id(data_dir):
    for i in range(3):
        events.emit("node_online", peer=f"n{i}")
    first = events.read_recent()[0]["id"]

    async def scenario():
        out = []
        agen = events.tail(after_id=first, poll_s=0.02)
        async for ev in agen:
            out.append(ev["peer"])
            if len(out) == 2:
                break
        await agen.aclose()
        return out

    assert asyncio.run(scenario()) == ["n1", "n2"]


def test_default_data_dir_per_platform(monkeypatch, tmp_path):
    from airbridge_app import config

    monkeypatch.delenv("AIRBRIDGE_DATA_DIR", raising=False)
    monkeypatch.setattr(config.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(config.sys, "platform", "darwin")
    assert config.default_data_dir() == tmp_path / "Library" / "Application Support" / "AirBridge"
    monkeypatch.setattr(config.sys, "platform", "linux")
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    if os.name != "nt":
        assert config.default_data_dir() == tmp_path / ".local" / "share" / "airbridge"
    monkeypatch.setenv("AIRBRIDGE_DATA_DIR", str(tmp_path / "x"))
    assert config.default_data_dir() == tmp_path / "x"
