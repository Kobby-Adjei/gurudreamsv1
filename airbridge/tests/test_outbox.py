"""Tests for airbridge_app.outbox (MCP server + outbound HTTP)."""

from __future__ import annotations

import asyncio
import dataclasses
from typing import Any

import pytest
import requests

from airbridge_app import config, network, outbox, security


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
class FakeResponse:
    def __init__(self, status_code: int, data: Any = None) -> None:
        self.status_code = status_code
        self._data = data

    def json(self) -> Any:
        if self._data is None:
            raise ValueError("no json")
        return self._data


class PostRecorder:
    """Replaces requests.Session.post; records call details."""

    def __init__(self, result: Any) -> None:
        self.result = result
        self.calls: list[dict[str, Any]] = []

    def __call__(self, session: requests.Session, url: str, **kwargs: Any) -> Any:
        self.calls.append({"url": url, "trust_env": session.trust_env, **kwargs})
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


@pytest.fixture
def post(monkeypatch: pytest.MonkeyPatch):
    def install(result: Any) -> PostRecorder:
        rec = PostRecorder(result)

        def fake_post(self: requests.Session, url: str, **kwargs: Any) -> Any:
            return rec(self, url, **kwargs)

        monkeypatch.setattr(requests.Session, "post", fake_post)
        return rec

    return install


@pytest.fixture(autouse=True)
def fixed_hostname(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(outbox.socket, "gethostname", lambda: "my-mac.local")


def run(coro):
    return asyncio.run(coro)


def call_tool(server, name: str, **args: Any) -> str:
    result = run(server.call_tool(name, args))
    assert result.is_error is False
    return result.content[0].text


# --------------------------------------------------------------------------- #
# Tool registration
# --------------------------------------------------------------------------- #
def test_exactly_two_tools(settings):
    server = outbox.build_mcp_server(settings)
    tools = run(server.list_tools())
    assert sorted(t.name for t in tools) == ["list_airbridge_nodes", "send_task_to_node"]
    for t in tools:
        assert t.description and len(t.description) > 80
    send = next(t for t in tools if t.name == "send_task_to_node")
    assert send.input_schema["required"] == ["target_hostname", "task_description"]
    assert "code_payload" in send.input_schema["properties"]


def test_server_name(settings):
    server = outbox.build_mcp_server(settings)
    assert server.name == "airbridge"


def test_build_without_settings_uses_config_load(monkeypatch, tmp_path):
    monkeypatch.setenv("AIRBRIDGE_INBOX_DIR", str(tmp_path))
    server = outbox.build_mcp_server()
    assert len(run(server.list_tools())) == 2


# --------------------------------------------------------------------------- #
# list_airbridge_nodes
# --------------------------------------------------------------------------- #
def test_list_nodes_formats_peers(settings, fake_peers):
    text = call_tool(outbox.build_mcp_server(settings), "list_airbridge_nodes")
    assert "• desktop — 100.64.0.5" in text
    assert "• laptop — 100.101.102.104" in text
    assert not text.startswith("FAILURE")


def test_list_nodes_empty(settings, fake_peers):
    fake_peers.clear()
    text = call_tool(outbox.build_mcp_server(settings), "list_airbridge_nodes")
    assert "No other online nodes" in text


@pytest.mark.parametrize(
    "exc", [network.TailscaleNotInstalled("Tailscale CLI not found."), network.TailscaleNotRunning("not running")]
)
def test_list_nodes_tailscale_error(settings, monkeypatch, exc):
    def boom():
        raise exc

    monkeypatch.setattr(network, "get_airbridge_peers", boom)
    text = call_tool(outbox.build_mcp_server(settings), "list_airbridge_nodes")
    assert text.startswith("FAILURE:")
    assert str(exc) in text


def test_list_nodes_unexpected_error_never_raises(settings, monkeypatch):
    def boom():
        raise KeyError("weird")

    monkeypatch.setattr(network, "get_airbridge_peers", boom)
    assert run(outbox.list_nodes()).startswith("FAILURE:")


# --------------------------------------------------------------------------- #
# send_task_to_node: success + request shape
# --------------------------------------------------------------------------- #
def test_send_success(settings, fake_peers, post):
    rec = post(FakeResponse(201, {"status": "ok", "file": "task_1.md"}))
    text = call_tool(
        outbox.build_mcp_server(settings),
        "send_task_to_node",
        target_hostname="Desktop",
        task_description="Run the tests",
        code_payload="print('hi')",
    )
    assert text.startswith("SUCCESS:")
    assert "task_1.md" in text
    (call,) = rec.calls
    assert call["url"] == f"http://100.64.0.5:{config.PORT}/incoming_task"
    assert call["trust_env"] is False
    assert call["allow_redirects"] is False
    assert call["timeout"] == settings.http_timeout_s
    assert call["json"] == {
        "sender_node": "my-mac",
        "task_description": "Run the tests",
        "code_payload": "print('hi')",
    }
    assert config.SECRET_HEADER not in call["headers"]


def test_send_includes_secret_header(secret_settings, fake_peers, post):
    rec = post(FakeResponse(201, {"status": "ok", "file": "f.md"}))
    text = run(outbox.send_task(secret_settings, "laptop", "do it"))
    assert text.startswith("SUCCESS:")
    assert rec.calls[0]["headers"][config.SECRET_HEADER] == "s3cret-value"
    assert rec.calls[0]["json"]["code_payload"] is None


def test_sender_name_is_sanitized(settings, fake_peers, post, monkeypatch):
    monkeypatch.setattr(outbox.socket, "gethostname", lambda: "Bob's MacBook Pro.local")
    rec = post(FakeResponse(201, {"status": "ok", "file": "f.md"}))
    run(outbox.send_task(settings, "laptop", "hello"))
    sender = rec.calls[0]["json"]["sender_node"]
    assert security.validate_sender(sender) == sender
    assert sender == "Bob-s-MacBook-Pro"


def test_sender_name_fallback_when_hostname_unusable(settings, fake_peers, post, monkeypatch):
    monkeypatch.setattr(outbox.socket, "gethostname", lambda: "???")
    rec = post(FakeResponse(201, {"status": "ok", "file": "f.md"}))
    run(outbox.send_task(settings, "laptop", "hello"))
    assert rec.calls[0]["json"]["sender_node"] == "airbridge-node"


def test_control_chars_stripped_before_sending(settings, fake_peers, post):
    rec = post(FakeResponse(201, {"status": "ok", "file": "f.md"}))
    run(outbox.send_task(settings, "laptop", "hi\x00there"))
    assert rec.calls[0]["json"]["task_description"] == "hithere"


# --------------------------------------------------------------------------- #
# send_task_to_node: local validation
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("host", ["", "bad host", "../etc", "a" * 65, "evil;rm -rf"])
def test_invalid_hostname(settings, fake_peers, post, host):
    rec = post(FakeResponse(201, {}))
    text = run(outbox.send_task(settings, host, "task"))
    assert text.startswith("FAILURE:") and "hostname" in text
    assert rec.calls == []


@pytest.mark.parametrize("task", ["", "   "])
def test_empty_task(settings, fake_peers, post, task):
    rec = post(FakeResponse(201, {}))
    assert run(outbox.send_task(settings, "laptop", task)).startswith("FAILURE:")
    assert rec.calls == []


def test_task_too_large(settings, fake_peers, post):
    rec = post(FakeResponse(201, {}))
    text = run(outbox.send_task(settings, "laptop", "x" * (security.MAX_TASK_BYTES + 1)))
    assert text.startswith("FAILURE:") and "task_description" in text
    assert rec.calls == []


def test_code_too_large(settings, fake_peers, post):
    rec = post(FakeResponse(201, {}))
    text = run(outbox.send_task(settings, "laptop", "t", "c" * (security.MAX_CODE_BYTES + 1)))
    assert text.startswith("FAILURE:") and "code_payload" in text
    assert rec.calls == []


def test_encoded_body_too_large(settings, fake_peers, post):
    # Characters that expand under JSON escaping push the body over the cap
    # even though each field is individually within its limit.
    rec = post(FakeResponse(201, {}))
    code = "\t" * (security.MAX_CODE_BYTES - 10)
    text = run(outbox.send_task(settings, "laptop", "t", code))
    assert text.startswith("FAILURE:") and "too large" in text
    assert rec.calls == []


# --------------------------------------------------------------------------- #
# send_task_to_node: resolution
# --------------------------------------------------------------------------- #
def test_unknown_host_lists_available(settings, fake_peers, post):
    rec = post(FakeResponse(201, {}))
    text = run(outbox.send_task(settings, "nosuchbox", "task"))
    assert text.startswith("FAILURE:")
    assert "nosuchbox" in text
    assert "desktop" in text and "laptop" in text
    assert rec.calls == []


def test_non_tailnet_target_refused(settings, fake_peers, post):
    fake_peers["evil"] = "8.8.8.8"
    rec = post(FakeResponse(201, {}))
    text = run(outbox.send_task(settings, "evil", "task"))
    assert text.startswith("FAILURE:") and "not a Tailscale address" in text
    assert rec.calls == []


def test_resolve_tailscale_error(settings, monkeypatch, post):
    def boom(_h):
        raise network.TailscaleNotRunning("Tailscale is not running.")

    monkeypatch.setattr(network, "resolve_peer", boom)
    rec = post(FakeResponse(201, {}))
    text = run(outbox.send_task(settings, "laptop", "task"))
    assert text.startswith("FAILURE:") and "not running" in text
    assert rec.calls == []


def test_ipv6_target_url(settings, fake_peers, post):
    fake_peers["v6box"] = "fd7a:115c:a1e0::5"
    rec = post(FakeResponse(201, {"status": "ok", "file": "f.md"}))
    assert run(outbox.send_task(settings, "v6box", "task")).startswith("SUCCESS:")
    assert rec.calls[0]["url"] == f"http://[fd7a:115c:a1e0::5]:{config.PORT}/incoming_task"


# --------------------------------------------------------------------------- #
# send_task_to_node: transport errors and HTTP statuses
# --------------------------------------------------------------------------- #
def test_timeout(settings, fake_peers, post):
    post(requests.exceptions.ReadTimeout("slow"))
    text = run(outbox.send_task(settings, "laptop", "task"))
    assert text.startswith("FAILURE:") and "timed out" in text


def test_connect_timeout(settings, fake_peers, post):
    post(requests.exceptions.ConnectTimeout("slow"))
    text = run(outbox.send_task(settings, "laptop", "task"))
    assert text.startswith("FAILURE:") and "timed out" in text


def test_connection_refused(settings, fake_peers, post):
    post(requests.exceptions.ConnectionError("refused"))
    text = run(outbox.send_task(settings, "laptop", "task"))
    assert text.startswith("FAILURE:")
    assert "Is AirBridge running on laptop?" in text


def test_other_request_exception(settings, fake_peers, post):
    post(requests.exceptions.InvalidURL("bad"))
    assert run(outbox.send_task(settings, "laptop", "task")).startswith("FAILURE:")


def test_unexpected_exception_never_raises(settings, fake_peers, post):
    post(RuntimeError("kaboom"))
    text = call_tool(outbox.build_mcp_server(settings), "send_task_to_node",
                     target_hostname="laptop", task_description="task")
    assert text.startswith("FAILURE:")


@pytest.mark.parametrize(
    ("status", "needle"),
    [
        (400, "invalid"),
        (401, "shared secret"),
        (403, "Tailscale address"),
        (413, "too large"),
        (429, "rate-limiting"),
        (302, "redirect"),
        (500, "HTTP 500"),
    ],
)
def test_http_error_statuses(settings, fake_peers, post, status, needle):
    post(FakeResponse(status, {"status": "error", "detail": "server detail"}))
    text = run(outbox.send_task(settings, "laptop", "task"))
    assert text.startswith("FAILURE:")
    assert needle in text


def test_success_without_json_body(settings, fake_peers, post):
    post(FakeResponse(201, None))
    assert run(outbox.send_task(settings, "laptop", "task")).startswith("SUCCESS:")


def test_custom_timeout_used(settings, fake_peers, post):
    rec = post(FakeResponse(201, {"file": "f.md"}))
    custom = dataclasses.replace(settings, http_timeout_s=3)
    run(outbox.send_task(custom, "laptop", "task"))
    assert rec.calls[0]["timeout"] == 3
