"""Security primitives for AirBridge.

Everything in this module is pure (no I/O except filesystem existence checks in
:func:`safe_inbox_path`), stdlib-only and side-effect free, so it can be imported
by every other module (inbox, outbox, formatting, main) without creating cycles.

Contract: see ``docs/PLAN.md`` section 2 ("security.py").  Threat model and the
mapping of these controls to threats: see ``docs/SECURITY.md``.
"""

from __future__ import annotations

import hmac
import ipaddress
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

__all__ = [
    "SecurityError",
    "MAX_SENDER_LEN",
    "MAX_TASK_BYTES",
    "MAX_CODE_BYTES",
    "MAX_BODY_BYTES",
    "TAILNET_V4",
    "TAILNET_V6",
    "is_tailnet_ip",
    "validate_bind_host",
    "validate_sender",
    "validate_task_text",
    "safe_inbox_path",
    "check_secret",
    "RateLimiter",
    "fence_for",
    "neutralize_markdown",
    "truncate_for_log",
    "redact",
]


class SecurityError(ValueError):
    """Raised when an input violates a security invariant."""


# --------------------------------------------------------------------------- #
# Limits
# --------------------------------------------------------------------------- #
MAX_SENDER_LEN: int = 64
MAX_TASK_BYTES: int = 64_000
MAX_CODE_BYTES: int = 512_000
MAX_BODY_BYTES: int = 600_000

#: Tailscale CGNAT range used for tailnet IPv4 addresses.
TAILNET_V4: ipaddress.IPv4Network = ipaddress.IPv4Network("100.64.0.0/10")
#: Tailscale ULA range used for tailnet IPv6 addresses.
TAILNET_V6: ipaddress.IPv6Network = ipaddress.IPv6Network("fd7a:115c:a1e0::/48")

_MAX_IP_STR_LEN = 64  # longer than any legitimate textual IP; caps parsing cost


# --------------------------------------------------------------------------- #
# IP checks
# --------------------------------------------------------------------------- #
def _parse_ip(ip: object) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """Parse *ip* into an address object, unwrapping IPv4-mapped IPv6.

    Returns ``None`` for anything that is not a well-formed IP address
    (including non-strings, zone-scoped addresses and CIDR notation).
    """
    if isinstance(ip, (ipaddress.IPv4Address, ipaddress.IPv6Address)):
        addr: ipaddress.IPv4Address | ipaddress.IPv6Address = ip
    elif isinstance(ip, str):
        if not ip or len(ip) > _MAX_IP_STR_LEN:
            return None
        candidate = ip.strip()
        if candidate.startswith("[") and candidate.endswith("]"):
            candidate = candidate[1:-1]
        if "%" in candidate:  # zone ids are never tailnet addresses
            return None
        try:
            addr = ipaddress.ip_address(candidate)
        except ValueError:
            return None
    else:
        return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    return addr


def is_tailnet_ip(ip: object) -> bool:
    """Return True iff *ip* is inside Tailscale's address space.

    Accepts ``100.64.0.0/10`` (IPv4) and ``fd7a:115c:a1e0::/48`` (IPv6).
    IPv4-mapped IPv6 (``::ffff:100.64.0.1``) is unwrapped first. Any value that
    is not a parseable IP address (garbage, ``None``, ints, hostnames) is False.
    """
    addr = _parse_ip(ip)
    if addr is None:
        return False
    if isinstance(addr, ipaddress.IPv4Address):
        return addr in TAILNET_V4
    return addr in TAILNET_V6


def validate_bind_host(ip: object) -> str:
    """Validate an address the inbox server is about to bind to.

    Rejects unspecified (``0.0.0.0``/``::``), loopback, and any non-tailnet
    address so the HTTP inbox is never exposed on LAN/public interfaces.

    Returns the normalized textual address. Raises :class:`SecurityError`.
    """
    addr = _parse_ip(ip)
    if addr is None:
        raise SecurityError(f"bind host is not a valid IP address: {truncate_for_log(str(ip), 64)}")
    if addr.is_unspecified:
        raise SecurityError("refusing to bind to an unspecified (all-interfaces) address")
    if addr.is_loopback:
        raise SecurityError("refusing to bind to a loopback address")
    if not is_tailnet_ip(addr):
        raise SecurityError(f"refusing to bind to non-tailnet address {addr}")
    return str(addr)


# --------------------------------------------------------------------------- #
# Field validation
# --------------------------------------------------------------------------- #
_SENDER_RE = re.compile(r"[A-Za-z0-9._-]{1,%d}" % MAX_SENDER_LEN)


def validate_sender(name: object) -> str:
    """Validate a sender node name: ``^[A-Za-z0-9._-]{1,64}$`` (full match, str only).

    No stripping or normalization is done: a name with surrounding whitespace
    or newlines is rejected rather than silently fixed. Raises SecurityError.
    """
    if not isinstance(name, str):
        raise SecurityError("sender must be a string")
    if _SENDER_RE.fullmatch(name) is None:
        raise SecurityError("sender must match ^[A-Za-z0-9._-]{1,64}$")
    return name


# Characters removed from untrusted text:
#  * C0 controls except \t (0x09) and \n (0x0A); \r handled separately
#  * DEL (0x7F) and C1 controls (0x80-0x9F)
#  * bidi embeddings/overrides U+202A-U+202E and isolates U+2066-U+2069 (Trojan Source)
#  * Unicode "tag" characters U+E0000-U+E007F (invisible "ASCII smuggling" of
#    instructions to LLMs)
#  * lone surrogates (cannot be encoded as UTF-8)
_STRIP_RE = re.compile(
    "[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f‪-‮⁦-⁩"
    "\U000e0000-\U000e007f\ud800-\udfff]"
)


def validate_task_text(s: object, max_bytes: int = MAX_TASK_BYTES) -> str:
    """Sanitize untrusted free text and enforce a UTF-8 byte budget.

    * ``s`` must be ``str`` (otherwise SecurityError).
    * ``\\r\\n`` and lone ``\\r`` are normalized to ``\\n``.
    * NUL, other C0/C1 control characters (except ``\\n`` and ``\\t``), DEL,
      bidi override/isolate characters, Unicode tag characters and lone
      surrogates are removed.
    * The *cleaned* text must encode to at most ``max_bytes`` UTF-8 bytes
      (otherwise SecurityError). The raw input is also bounded at 4x the budget
      so pathological inputs are rejected before doing regex work.
    """
    if not isinstance(s, str):
        raise SecurityError("text must be a string")
    if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes < 0:
        raise SecurityError("max_bytes must be a non-negative int")
    # Cheap pre-check: every char is >= 1 byte, so this bounds the work done.
    if len(s) > max_bytes * 4 + 16:
        raise SecurityError(f"text exceeds {max_bytes} bytes")
    cleaned = s.replace("\r\n", "\n").replace("\r", "\n")
    cleaned = _STRIP_RE.sub("", cleaned)
    if len(cleaned.encode("utf-8")) > max_bytes:
        raise SecurityError(f"text exceeds {max_bytes} bytes")
    return cleaned


# --------------------------------------------------------------------------- #
# Filesystem
# --------------------------------------------------------------------------- #
_MAX_COLLISIONS = 10_000


def safe_inbox_path(inbox_dir: Path | str, received_at: datetime) -> Path:
    """Return a fresh, non-existing path for a received task inside *inbox_dir*.

    The filename is derived **only** from the server-side timestamp
    (``task_YYYYMMDD-HHMMSS-ffffff.md``), never from request data, so path
    traversal via sender/content is impossible by construction. If the name is
    taken (or a dangling symlink sits there) ``-1``, ``-2``, ... is appended.
    The resolved result is asserted to be a direct child of the resolved
    *inbox_dir*. Raises SecurityError.

    Note: this is check-then-use; the writer must still create the final file
    exclusively (e.g. ``os.link``/``O_EXCL``) or accept last-writer-wins with
    ``os.replace``. Name collisions within the same microsecond are the only
    realistic race.
    """
    if not isinstance(received_at, datetime):
        raise SecurityError("received_at must be a datetime")
    base_dir = Path(inbox_dir).expanduser().resolve()
    stem = "task_" + received_at.strftime("%Y%m%d-%H%M%S-%f")
    for n in range(_MAX_COLLISIONS):
        name = f"{stem}.md" if n == 0 else f"{stem}-{n}.md"
        candidate = base_dir / name
        if candidate.exists() or candidate.is_symlink():
            continue
        resolved = candidate.resolve()
        if resolved.parent != base_dir or resolved.name != name:
            raise SecurityError("computed inbox path escapes the inbox directory")
        return resolved
    raise SecurityError("too many filename collisions in inbox")


# --------------------------------------------------------------------------- #
# Authentication
# --------------------------------------------------------------------------- #
def check_secret(provided: str | None, expected: str | None) -> bool:
    """Constant-time comparison of a provided shared secret.

    * ``expected`` is None (or empty): no secret configured -> True.
    * ``provided`` is None / not a str while a secret is configured -> False.
    * Otherwise ``hmac.compare_digest`` on the UTF-8 bytes.
    """
    if expected is None or expected == "":
        return True
    if not isinstance(provided, str) or not isinstance(expected, str):
        return False
    try:
        p = provided.encode("utf-8")
        e = expected.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return hmac.compare_digest(p, e)


# --------------------------------------------------------------------------- #
# Rate limiting
# --------------------------------------------------------------------------- #
class RateLimiter:
    """Thread-safe per-key token bucket.

    Each key gets a bucket of capacity ``burst`` (default ``per_minute``) that
    refills at ``per_minute / 60`` tokens per second. Memory is bounded: when
    more than ``max_keys`` keys are tracked, fully-refilled (idle) buckets are
    dropped first, then the least recently used ones. Dropping a bucket is
    equivalent to it being full, so eviction never makes a key *stricter*.

    ``clock`` is injectable (monotonic seconds) for deterministic tests.
    """

    def __init__(
        self,
        per_minute: int = 30,
        *,
        burst: int | None = None,
        max_keys: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if per_minute <= 0:
            raise ValueError("per_minute must be positive")
        if max_keys <= 0:
            raise ValueError("max_keys must be positive")
        self.per_minute = per_minute
        self.capacity = float(burst if burst is not None else per_minute)
        if self.capacity < 1:
            raise ValueError("burst must be >= 1")
        self.rate = per_minute / 60.0  # tokens per second
        self.max_keys = max_keys
        self._clock = clock
        self._lock = threading.Lock()
        # key -> (tokens, last_refill_timestamp); ordered by recency of use
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()

    def __len__(self) -> int:
        with self._lock:
            return len(self._buckets)

    def _evict(self, now: float) -> None:
        """Drop idle buckets, then LRU buckets, until under ``max_keys``. Lock held."""
        full_after = self.capacity / self.rate
        stale = [k for k, (_, ts) in self._buckets.items() if now - ts >= full_after]
        for k in stale:
            del self._buckets[k]
        while len(self._buckets) >= self.max_keys:
            self._buckets.popitem(last=False)

    def allow(self, key: str) -> bool:
        """Consume one token for *key*; return False if the bucket is empty."""
        key = str(key)
        with self._lock:
            now = self._clock()
            entry = self._buckets.get(key)
            if entry is None:
                if len(self._buckets) >= self.max_keys:
                    self._evict(now)
                tokens = self.capacity
            else:
                tokens, last = entry
                elapsed = max(0.0, now - last)
                tokens = min(self.capacity, tokens + elapsed * self.rate)
            if tokens >= 1.0:
                self._buckets[key] = (tokens - 1.0, now)
                self._buckets.move_to_end(key)
                return True
            self._buckets[key] = (tokens, now)
            self._buckets.move_to_end(key)
            return False


# --------------------------------------------------------------------------- #
# Markdown hardening
# --------------------------------------------------------------------------- #
_BACKTICK_RUN_RE = re.compile(r"`+")


def fence_for(content: str) -> str:
    """Return a backtick fence strictly longer than any backtick run in *content*.

    Minimum length 3. Using this fence around untrusted code guarantees the
    content cannot terminate the code block early and inject markdown after it.
    """
    longest = max((len(m.group(0)) for m in _BACKTICK_RUN_RE.finditer(content or "")), default=0)
    return "`" * max(3, longest + 1)


# Line consisting solely of -, =, +, *, _ (and spaces): setext underline,
# thematic break or YAML/TOML front-matter delimiter.
_RULE_LINE_RE = re.compile(r"^( {0,3})([-=+*_])[ \t\-=+*_]*$")
# ATX heading, blockquote, code fence opener (``` or ~~~)
_LEADING_RE = re.compile(r"^( {0,3})(#|>|```|~~~)")


def neutralize_markdown(text: str) -> str:
    """Make untrusted text inert when embedded in a markdown document.

    Keeps the text readable while preventing it from forging structure in the
    surrounding document or auto-loading remote resources:

    * ``<`` / ``>`` / ``&`` become HTML entities (no raw HTML, no autolinks,
      immune to backslash tricks).
    * Leading ``#`` (headings), ``>`` (quotes) and code fences ``````/``~~~``
      are backslash-escaped.
    * Lines made only of ``-``, ``=``, ``+``, ``*``, ``_`` (front-matter
      delimiters ``---``/``+++``, setext underlines, horizontal rules) get
      their first char backslash-escaped.
    * Image syntax ``![`` becomes ``!\\[`` (no remote image fetch / tracking
      pixel). Plain links are left intact for readability.

    Newlines are preserved (``\\r\\n`` normalized to ``\\n``).
    """
    if not isinstance(text, str):
        raise SecurityError("text must be a string")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    out: list[str] = []
    for line in text.split("\n"):
        line = line.replace("![", "!\\[")
        m = _RULE_LINE_RE.match(line)
        if m:
            line = m.group(1) + "\\" + line[len(m.group(1)):]
        else:
            # Note: '>' is already '&gt;' here and so cannot form a blockquote;
            # it stays in the pattern as defence in depth.
            m2 = _LEADING_RE.match(line)
            if m2:
                line = m2.group(1) + "\\" + line[len(m2.group(1)):]
        out.append(line)
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# Logging helpers
# --------------------------------------------------------------------------- #
_LOG_UNSAFE_RE = re.compile(
    "[\x00-\x1f\x7f-\x9f  ‪-‮⁦-⁩]"
)


def truncate_for_log(s: object, n: int = 200) -> str:
    """Render *s* safely for a single log line.

    Control characters (including CR/LF, so attackers cannot forge log lines)
    and bidi characters are replaced with ``\\xNN``/``\\uNNNN`` escapes, and the
    result is cut to *n* characters with a ``...(+K chars)`` marker.
    """
    if s is None:
        return "None"
    if not isinstance(s, str):
        s = str(s)
    n = max(0, int(n))
    total = len(s)
    head = s[:n]
    head = _LOG_UNSAFE_RE.sub(lambda m: m.group(0).encode("unicode_escape").decode("ascii"), head)
    if total > n:
        return f"{head}...(+{total - n} chars)"
    return head


def redact(s: object) -> str:
    """Return a placeholder for a secret value; never reveals any of it.

    ``None``/empty -> ``"<unset>"``; anything else -> ``"<redacted>"``.
    """
    if s is None or s == "" or s == b"":
        return "<unset>"
    return "<redacted>"
