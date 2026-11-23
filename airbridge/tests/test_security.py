"""Tests for airbridge_app.security (pure security primitives)."""

from __future__ import annotations

import ipaddress
import os
import sys
import threading
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from airbridge_app import security as sec  # noqa: E402
from airbridge_app.security import (  # noqa: E402
    MAX_BODY_BYTES,
    MAX_CODE_BYTES,
    MAX_SENDER_LEN,
    MAX_TASK_BYTES,
    RateLimiter,
    SecurityError,
    check_secret,
    fence_for,
    is_tailnet_ip,
    neutralize_markdown,
    redact,
    safe_inbox_path,
    truncate_for_log,
    validate_bind_host,
    validate_sender,
    validate_task_text,
)


# --------------------------------------------------------------------------- #
# constants
# --------------------------------------------------------------------------- #
def test_constants():
    assert MAX_SENDER_LEN == 64
    assert MAX_TASK_BYTES == 64_000
    assert MAX_CODE_BYTES == 512_000
    assert MAX_BODY_BYTES == 600_000
    assert MAX_BODY_BYTES > MAX_TASK_BYTES + MAX_CODE_BYTES
    assert issubclass(SecurityError, ValueError)


# --------------------------------------------------------------------------- #
# is_tailnet_ip
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "ip, expected",
    [
        ("100.63.255.255", False),
        ("100.64.0.0", True),
        ("100.64.0.1", True),
        ("100.100.100.100", True),
        ("100.127.255.255", True),
        ("100.128.0.0", False),
        ("fd7a:115c:a1e0::1", True),
        ("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240", True),
        ("FD7A:115C:A1E0::1", True),
        ("[fd7a:115c:a1e0::1]", True),
        ("fd7a:115c:a1e1::1", False),
        ("fd7a:115c:a1df::1", False),
        ("::ffff:100.64.0.1", True),
        ("::ffff:192.168.1.1", False),
        ("0.0.0.0", False),
        ("127.0.0.1", False),
        ("::1", False),
        ("::", False),
        ("10.0.0.1", False),
        ("192.168.1.10", False),
        ("8.8.8.8", False),
        ("not-an-ip", False),
        ("", False),
        ("100.64.0.0/10", False),
        ("100.64.0.1:8989", False),
        ("100.64.0.1\n", True),  # surrounding whitespace is tolerated by strip
        ("100.64.1", False),
        ("fe80::1%eth0", False),
        ("fd7a:115c:a1e0::1%eth0", False),
        ("x" * 10_000, False),
        (None, False),
        (1684275201, False),
        (b"100.64.0.1", False),
        (["100.64.0.1"], False),
    ],
)
def test_is_tailnet_ip(ip, expected):
    assert is_tailnet_ip(ip) is expected


def test_is_tailnet_ip_accepts_address_objects():
    assert is_tailnet_ip(ipaddress.ip_address("100.64.0.5"))
    assert not is_tailnet_ip(ipaddress.ip_address("1.1.1.1"))


# --------------------------------------------------------------------------- #
# validate_bind_host
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "ip, expected",
    [
        ("100.64.0.1", "100.64.0.1"),
        ("100.101.102.103", "100.101.102.103"),
        ("fd7a:115c:a1e0::1", "fd7a:115c:a1e0::1"),
        ("::ffff:100.64.0.1", "100.64.0.1"),
    ],
)
def test_validate_bind_host_ok(ip, expected):
    assert validate_bind_host(ip) == expected


@pytest.mark.parametrize(
    "ip",
    ["0.0.0.0", "::", "127.0.0.1", "127.1.2.3", "::1", "192.168.1.2", "10.0.0.1",
     "8.8.8.8", "", "localhost", "not-an-ip", None, 0, "100.128.0.1"],
)
def test_validate_bind_host_rejects(ip):
    with pytest.raises(SecurityError):
        validate_bind_host(ip)


# --------------------------------------------------------------------------- #
# validate_sender
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("name", ["a", "macbook-pro", "Node_1.local", "A" * 64, "0", "..", "-"])
def test_validate_sender_ok(name):
    assert validate_sender(name) == name


@pytest.mark.parametrize(
    "name",
    ["", "A" * 65, "with space", "a/b", "../etc", "a\\b", "a\nb", "a\n", " a", "a\x00",
     "ümlaut", "ａ", "a:b", "<script>", "$(id)", "a;b", None, 1, b"abc", ["a"]],
)
def test_validate_sender_rejects(name):
    with pytest.raises(SecurityError):
        validate_sender(name)


# --------------------------------------------------------------------------- #
# validate_task_text
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "raw, expected",
    [
        ("hello", "hello"),
        ("", ""),
        ("a\tb\nc", "a\tb\nc"),
        ("a\r\nb\r\nc", "a\nb\nc"),
        ("a\rb", "a\nb"),
        ("nul\x00byte", "nulbyte"),
        ("bell\x07 esc\x1b[31m", "bell esc[31m"),
        ("vt\x0bff\x0c", "vtff"),
        ("del\x7f", "del"),
        ("c1\x80\x85\x9f", "c1"),
        # Trojan Source bidi controls
        ("if admin\u202e }\u2066 {\u2069", "if admin } {"),
        ("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069x", "x"),
        # Unicode tag "ASCII smuggling"
        ("hi\U000e0049\U000e0047\U000e004e", "hi"),
        # lone surrogates
        ("a\ud800b", "ab"),
        # legit unicode survives
        ("café ✓ 日本 👍🏽 \u200d", "café ✓ 日本 👍🏽 \u200d"),
        ("RLM \u200f LRM \u200e kept", "RLM \u200f LRM \u200e kept"),
    ],
)
def test_validate_task_text_cleans(raw, expected):
    assert validate_task_text(raw) == expected


def test_validate_task_text_byte_limit_exact():
    assert validate_task_text("a" * 10, max_bytes=10) == "a" * 10
    with pytest.raises(SecurityError):
        validate_task_text("a" * 11, max_bytes=10)


def test_validate_task_text_limit_counts_utf8_bytes_not_chars():
    s = "é" * 6  # 12 bytes, 6 chars
    with pytest.raises(SecurityError):
        validate_task_text(s, max_bytes=10)
    assert validate_task_text("é" * 5, max_bytes=10) == "é" * 5


def test_validate_task_text_limit_after_cleaning():
    # control chars stripped before measuring
    assert validate_task_text("a" * 10 + "\x00" * 5, max_bytes=10) == "a" * 10


def test_validate_task_text_default_limit():
    validate_task_text("a" * MAX_TASK_BYTES)
    with pytest.raises(SecurityError):
        validate_task_text("a" * (MAX_TASK_BYTES + 1))


def test_validate_task_text_huge_rejected_fast():
    with pytest.raises(SecurityError):
        validate_task_text("\x00" * 10_000_000, max_bytes=100)


@pytest.mark.parametrize("bad", [None, 1, b"bytes", ["x"], {"a": 1}])
def test_validate_task_text_type(bad):
    with pytest.raises(SecurityError):
        validate_task_text(bad)


@pytest.mark.parametrize("bad", [-1, "10", None, True])
def test_validate_task_text_bad_max(bad):
    with pytest.raises(SecurityError):
        validate_task_text("x", max_bytes=bad)


# --------------------------------------------------------------------------- #
# safe_inbox_path
# --------------------------------------------------------------------------- #
TS = datetime(2026, 11, 23, 14, 5, 9, 123456)


def test_safe_inbox_path_name(tmp_path):
    p = safe_inbox_path(tmp_path, TS)
    assert p.name == "task_20261123-140509-123456.md"
    assert p.parent == tmp_path.resolve()
    assert not p.exists()


def test_safe_inbox_path_accepts_str(tmp_path):
    assert safe_inbox_path(str(tmp_path), TS).parent == tmp_path.resolve()


def test_safe_inbox_path_collisions(tmp_path):
    names = []
    for _ in range(4):
        p = safe_inbox_path(tmp_path, TS)
        p.write_text("x")
        names.append(p.name)
    assert names == [
        "task_20261123-140509-123456.md",
        "task_20261123-140509-123456-1.md",
        "task_20261123-140509-123456-2.md",
        "task_20261123-140509-123456-3.md",
    ]


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_safe_inbox_path_skips_dangling_symlink(tmp_path):
    target = tmp_path.parent / "outside_target.md"
    (tmp_path / "task_20261123-140509-123456.md").symlink_to(target)
    p = safe_inbox_path(tmp_path, TS)
    assert p.name == "task_20261123-140509-123456-1.md"
    assert not target.exists()


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_safe_inbox_path_through_symlinked_dir(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    p = safe_inbox_path(link, TS)
    assert p.parent == real.resolve()


@pytest.mark.parametrize(
    "bad_dir_suffix",
    ["../..", "sub/../../x", "./.", "a/b/../../.."],
)
def test_safe_inbox_path_traversal_in_dir_stays_inside_resolved(tmp_path, bad_dir_suffix):
    # whatever dir is passed, result is always a direct child of its resolved form
    d = tmp_path / bad_dir_suffix
    p = safe_inbox_path(d, TS)
    assert p.parent == d.resolve()
    assert ".." not in p.parts
    assert p.name.startswith("task_") and p.name.endswith(".md")


@pytest.mark.parametrize("bad", ["../../etc/passwd", "2026-11-23", None, 1700000000])
def test_safe_inbox_path_requires_datetime(tmp_path, bad):
    with pytest.raises(SecurityError):
        safe_inbox_path(tmp_path, bad)


def test_safe_inbox_path_too_many_collisions(tmp_path, monkeypatch):
    monkeypatch.setattr(sec, "_MAX_COLLISIONS", 3)
    for _ in range(3):
        safe_inbox_path(tmp_path, TS).write_text("x")
    with pytest.raises(SecurityError):
        safe_inbox_path(tmp_path, TS)


def test_safe_inbox_path_escape_detected(tmp_path, monkeypatch):
    # Simulate a resolution that escapes (e.g. race replacing a path component)
    outside = tmp_path.parent / "elsewhere.md"
    real_resolve = Path.resolve

    def fake_resolve(self, strict=False):
        if self.name.startswith("task_"):
            return outside
        return real_resolve(self, strict=strict)

    monkeypatch.setattr(Path, "resolve", fake_resolve)
    with pytest.raises(SecurityError):
        safe_inbox_path(tmp_path, TS)


# --------------------------------------------------------------------------- #
# check_secret
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "provided, expected, ok",
    [
        (None, None, True),
        ("anything", None, True),
        ("", None, True),
        (None, "", True),
        ("s3cret", "s3cret", True),
        ("s3cret", "s3creT", False),
        ("s3cre", "s3cret", False),
        ("s3cret ", "s3cret", False),
        (None, "s3cret", False),
        ("", "s3cret", False),
        (b"s3cret", "s3cret", False),
        (123, "123", False),
        ("pässwörd", "pässwörd", True),
        ("a\ud800", "a\ud800", False),  # unencodable -> False, no exception
    ],
)
def test_check_secret(provided, expected, ok):
    assert check_secret(provided, expected) is ok


def test_check_secret_uses_compare_digest(monkeypatch):
    calls = []
    import hmac as _hmac

    real = _hmac.compare_digest

    def spy(a, b):
        calls.append((type(a), type(b)))
        return real(a, b)

    monkeypatch.setattr(sec.hmac, "compare_digest", spy)
    check_secret("x", "y")
    assert calls == [(bytes, bytes)]


# --------------------------------------------------------------------------- #
# RateLimiter
# --------------------------------------------------------------------------- #
class FakeClock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, s: float) -> None:
        self.t += s


def test_rate_limiter_burst_then_block():
    clk = FakeClock()
    rl = RateLimiter(per_minute=30, clock=clk)
    assert all(rl.allow("1.2.3.4") for _ in range(30))
    assert rl.allow("1.2.3.4") is False
    assert rl.allow("1.2.3.4") is False


def test_rate_limiter_refill():
    clk = FakeClock()
    rl = RateLimiter(per_minute=30, clock=clk)  # 0.5 token/s
    for _ in range(30):
        rl.allow("k")
    assert not rl.allow("k")
    clk.advance(1.0)  # +0.5 token
    assert not rl.allow("k")
    clk.advance(1.0)  # +0.5 -> 1.0
    assert rl.allow("k")
    assert not rl.allow("k")
    clk.advance(60)  # full refill, capped at capacity
    assert sum(rl.allow("k") for _ in range(100)) == 30


def test_rate_limiter_keys_independent():
    clk = FakeClock()
    rl = RateLimiter(per_minute=2, clock=clk)
    assert rl.allow("a") and rl.allow("a") and not rl.allow("a")
    assert rl.allow("b")


def test_rate_limiter_clock_going_backwards():
    clk = FakeClock()
    rl = RateLimiter(per_minute=1, clock=clk)
    assert rl.allow("a")
    clk.advance(-100)
    assert not rl.allow("a")


def test_rate_limiter_burst_param():
    clk = FakeClock()
    rl = RateLimiter(per_minute=60, burst=5, clock=clk)
    assert sum(rl.allow("a") for _ in range(10)) == 5


def test_rate_limiter_bounded_memory():
    clk = FakeClock()
    rl = RateLimiter(per_minute=10, max_keys=100, clock=clk)
    for i in range(1000):
        rl.allow(f"k{i}")
    assert len(rl) <= 100


def test_rate_limiter_eviction_prefers_idle_and_keeps_active_limited():
    clk = FakeClock()
    rl = RateLimiter(per_minute=2, max_keys=3, clock=clk)
    assert rl.allow("hot") and rl.allow("hot") and not rl.allow("hot")
    rl.allow("idle1")
    rl.allow("idle2")
    clk.advance(61)  # idle buckets are now full -> evictable
    assert rl.allow("hot") and rl.allow("hot")  # refilled; now depleted & non-idle
    assert rl.allow("new1")
    assert len(rl) <= 3
    assert "hot" in rl._buckets
    assert "idle1" not in rl._buckets and "idle2" not in rl._buckets
    # hot keeps its (depleted) state: it is not reset by eviction
    assert not rl.allow("hot")


def test_rate_limiter_thread_safe():
    rl = RateLimiter(per_minute=1000, clock=lambda: 0.0)
    results = []
    lock = threading.Lock()

    def worker():
        local = [rl.allow("x") for _ in range(200)]
        with lock:
            results.extend(local)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(results) == 1000


@pytest.mark.parametrize("kwargs", [{"per_minute": 0}, {"per_minute": -1}, {"max_keys": 0}, {"burst": 0}])
def test_rate_limiter_bad_args(kwargs):
    with pytest.raises(ValueError):
        RateLimiter(**kwargs)


# --------------------------------------------------------------------------- #
# fence_for
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "content, fence",
    [
        ("", "```"),
        ("no ticks", "```"),
        ("`inline`", "```"),
        ("``double``", "```"),
        ("```py\nx\n```", "````"),
        ("````", "`````"),
        ("a ``````` b ``` c", "````````"),
        (None, "```"),
    ],
)
def test_fence_for(content, fence):
    assert fence_for(content) == fence


def test_fence_for_cannot_be_closed_by_content():
    content = "x\n```\n# injected heading\n````\n"
    f = fence_for(content)
    for line in content.split("\n"):
        assert not line.strip().startswith(f)


# --------------------------------------------------------------------------- #
# neutralize_markdown
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "raw, expected",
    [
        ("plain text", "plain text"),
        ("# Heading", "\\# Heading"),
        ("   ## h2", "   \\## h2"),
        ("    # indented code is inert", "    # indented code is inert"),
        ("not # a heading", "not # a heading"),
        ("> quote", "&gt; quote"),
        ("---", "\\---"),
        ("+++", "\\+++"),
        ("===", "\\==="),
        ("=", "\\="),
        ("- - -", "\\- - -"),
        ("***", "\\***"),
        ("___", "\\___"),
        ("- list item", "- list item"),
        ("```bash", "\\```bash"),
        ("~~~", "\\~~~"),
        ("<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"),
        ("<img src=http://evil/x.png>", "&lt;img src=http://evil/x.png&gt;"),
        ("<https://evil.example>", "&lt;https://evil.example&gt;"),
        ("![pixel](http://evil/t.gif)", "!\\[pixel](http://evil/t.gif)"),
        ("x ![a][ref] y", "x !\\[a][ref] y"),
        ("[link](https://example.com)", "[link](https://example.com)"),
        ("a & b", "a &amp; b"),
        ("&lt;b&gt;", "&amp;lt;b&amp;gt;"),
        ("\\<b>", "\\&lt;b&gt;"),
        ("C:\\Users\\me", "C:\\Users\\me"),
        ("line1\r\nline2", "line1\nline2"),
        ("", ""),
    ],
)
def test_neutralize_markdown(raw, expected):
    assert neutralize_markdown(raw) == expected


def test_neutralize_markdown_front_matter_block():
    raw = "---\ntitle: pwned\nsender: admin\n---\nbody"
    out = neutralize_markdown(raw)
    assert "\n---" not in "\n" + out
    assert out.splitlines()[0] == "\\---"
    assert out.splitlines()[3] == "\\---"


def test_neutralize_markdown_no_raw_angle_brackets():
    raw = "<div onclick=x>\n<!-- hidden instructions -->\n<iframe src=//e>"
    out = neutralize_markdown(raw)
    assert "<" not in out and ">" not in out


def test_neutralize_markdown_no_line_starts_with_structure():
    raw = "\n".join(["# a", "## b", "> c", "---", "+++", "```", "~~~", "===", "![x](y)"])
    for line in neutralize_markdown(raw).split("\n"):
        s = line.lstrip(" ")
        assert not s.startswith(("#", ">", "---", "+++", "```", "~~~", "===", "!["))


def test_neutralize_markdown_type():
    with pytest.raises(SecurityError):
        neutralize_markdown(None)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# logging helpers
# --------------------------------------------------------------------------- #
def test_truncate_for_log_short():
    assert truncate_for_log("hello") == "hello"


def test_truncate_for_log_long():
    s = "a" * 500
    out = truncate_for_log(s)
    assert out.startswith("a" * 200)
    assert out.endswith("...(+300 chars)")
    assert len(out) < 230


def test_truncate_for_log_custom_n():
    assert truncate_for_log("abcdef", n=3) == "abc...(+3 chars)"


def test_truncate_for_log_no_newlines_or_controls():
    out = truncate_for_log("ok\nFAKE LOG LINE\r\x1b[31m\u202e")
    assert "\n" not in out and "\r" not in out and "\x1b" not in out and "\u202e" not in out
    assert "\\n" in out


@pytest.mark.parametrize("v, expected", [(None, "None"), (123, "123"), (b"ab", "b'ab'")])
def test_truncate_for_log_non_str(v, expected):
    assert truncate_for_log(v) == expected


@pytest.mark.parametrize("v, expected", [(None, "<unset>"), ("", "<unset>"), ("hunter2", "<redacted>"), (b"k", "<redacted>")])
def test_redact(v, expected):
    out = redact(v)
    assert out == expected
    if isinstance(v, str) and v:
        assert v not in out
