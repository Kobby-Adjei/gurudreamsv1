"""Tests for airbridge_app.notify: dispatch, argument safety, never raising."""

from __future__ import annotations

import base64
import re
import subprocess

import pytest

from airbridge_app import notify


class FakePopen:
    calls: list = []

    def __init__(self, cmd, **kwargs):
        FakePopen.calls.append((cmd, kwargs))

    def wait(self, timeout=None):
        return 0

    def kill(self):
        pass


@pytest.fixture
def popen(monkeypatch):
    FakePopen.calls = []
    monkeypatch.setattr(notify.subprocess, "Popen", FakePopen)
    return FakePopen.calls


def set_platform(monkeypatch, system, which=None):
    monkeypatch.setattr(notify.platform, "system", lambda: system)
    table = which or {}
    monkeypatch.setattr(notify.shutil, "which", lambda name: table.get(name))


def decode_ps(cmd):
    return base64.b64decode(cmd[cmd.index("-EncodedCommand") + 1]).decode("utf-16-le")


def assert_quiet(kwargs):
    assert kwargs["shell"] is False
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["stdout"] is subprocess.DEVNULL
    assert kwargs["stderr"] is subprocess.DEVNULL


def test_macos_uses_argv_not_interpolation(monkeypatch, popen):
    set_platform(monkeypatch, "Darwin")
    title, body = 'Air"Bridge', 'end tell" & do shell script "rm -rf ~"'
    notify.send_notification(title, body)
    (cmd, kwargs), = popen
    assert cmd[0] == "osascript"
    script = " ".join(cmd[1:-2])
    assert "on run argv" in script
    assert 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"' in script
    assert cmd[-2:] == [title, body]
    assert body not in script
    assert_quiet(kwargs)


def test_windows_encoded_toast(monkeypatch, popen):
    set_platform(monkeypatch, "Windows", {"powershell.exe": r"C:\WINDOWS\powershell.exe"})
    notify.send_notification("AirBridge", "it's <b>bold</b> & \u2019sneaky\u2019 '); Remove-Item C:\\ #")
    (cmd, kwargs), = popen
    assert cmd[0] == r"C:\WINDOWS\powershell.exe"
    assert "-EncodedCommand" in cmd and "-NoProfile" in cmd
    assert kwargs["creationflags"] == notify.CREATE_NO_WINDOW
    assert_quiet(kwargs)

    script = decode_ps(cmd)
    load = next(line for line in script.splitlines() if line.startswith("$xml.LoadXml("))
    literal = load[len("$xml.LoadXml(") : -1]
    # One single-quoted literal with no PowerShell quote characters inside it.
    assert literal[0] == "'" and literal[-1] == "'"
    assert not re.search("['\u2018\u2019\u201a\u201b]", literal[1:-1])
    assert "&lt;b&gt;bold&lt;/b&gt; &amp;" in literal
    assert "it&apos;s" in literal and "&#x2019;sneaky&#x2019;" in literal


def test_windows_without_powershell_is_noop(monkeypatch, popen):
    set_platform(monkeypatch, "Windows", {})
    notify.send_notification("t", "b")
    assert popen == []


def test_linux_notify_send(monkeypatch, popen):
    set_platform(monkeypatch, "Linux", {"notify-send": "/usr/bin/notify-send"})
    notify.send_notification("--title", "-b body")
    (cmd, kwargs), = popen
    assert cmd[0] == "/usr/bin/notify-send"
    sep = cmd.index("--")
    assert cmd[sep + 1 :] == ["title", "b body"]
    assert_quiet(kwargs)


def test_linux_without_notify_send_is_noop(monkeypatch, popen):
    set_platform(monkeypatch, "Linux", {})
    notify.send_notification("t", "b")
    assert popen == []


def test_unknown_platform_is_noop(monkeypatch, popen):
    set_platform(monkeypatch, "Plan9")
    notify.send_notification("t", "b")
    assert popen == []


def test_body_truncated_and_single_line(monkeypatch, popen):
    set_platform(monkeypatch, "Darwin")
    notify.send_notification("t" * 300, "line1\nline2\x00\x1b[31m " + "x" * 500)
    (cmd, _), = popen
    title, body = cmd[-2:]
    assert len(title) <= notify.MAX_TITLE_CHARS
    assert len(body) <= notify.MAX_BODY_CHARS and body.endswith("\u2026")
    assert "\n" not in body and "\x00" not in body and "\x1b" not in body
    assert body.startswith("line1 line2")


def test_empty_title_falls_back(monkeypatch, popen):
    set_platform(monkeypatch, "Darwin")
    notify.send_notification("", "")
    (cmd, _), = popen
    assert cmd[-2] == "AirBridge"


@pytest.mark.parametrize("exc", [FileNotFoundError("osascript"), OSError("boom"), RuntimeError("x")])
def test_never_raises(monkeypatch, exc, caplog):
    set_platform(monkeypatch, "Darwin")

    def explode(*args, **kwargs):
        raise exc

    monkeypatch.setattr(notify.subprocess, "Popen", explode)
    with caplog.at_level("DEBUG", logger="airbridge_app.notify"):
        assert notify.send_notification("t", "b") is None
    assert "notification failed" in caplog.text


def test_never_raises_when_platform_lookup_fails(monkeypatch):
    def explode():
        raise RuntimeError("no platform")

    monkeypatch.setattr(notify.platform, "system", explode)
    notify.send_notification(object(), None)  # type: ignore[arg-type]


def test_reaper_kills_slow_helper(monkeypatch):
    class Slow:
        killed = False

        def wait(self, timeout=None):
            if not Slow.killed:
                raise subprocess.TimeoutExpired("x", timeout)
            return 0

        def kill(self):
            Slow.killed = True

    notify._reap(Slow())
    assert Slow.killed


def test_no_stdout(monkeypatch, popen, capsys):
    set_platform(monkeypatch, "Linux", {"notify-send": "/usr/bin/notify-send"})
    notify.send_notification("t", "b")
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err == ""
