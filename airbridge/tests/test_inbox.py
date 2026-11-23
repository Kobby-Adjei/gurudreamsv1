"""Tests for airbridge_app.inbox (FastAPI receiver)."""

from __future__ import annotations

import dataclasses
import json
import os
import stat
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from airbridge_app import config, inbox, security
TAILNET_CLIENT = ("100.101.102.103", 50000)
NON_TAILNET_CLIENT = ("192.168.1.20", 50000)
URL = "/incoming_task"


def _payload(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "sender_node": "laptop",
        "task_description": "Please review the attached function.",
        "code_payload": "def add(a, b):\n    return a + b\n",
    }
    body.update(overrides)
    return body


def _client(settings: config.Settings, client=TAILNET_CLIENT) -> TestClient:
    app = inbox.create_app(settings, peers_provider=lambda: {})
    return TestClient(app, client=client)


def _md_files(inbox_dir: Path) -> list[Path]:
    if not inbox_dir.exists():
        return []
    return sorted(inbox_dir.glob("*.md"))


# --------------------------------------------------------------------------- #
# Happy path
# --------------------------------------------------------------------------- #
def test_valid_task_is_stored(settings, inbox_dir, notifications):
    with _client(settings) as client:
        resp = client.post(URL, json=_payload())
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "ok"
    files = _md_files(inbox_dir)
    assert [f.name for f in files] == [data["file"]]
    assert data["file"].startswith("task_") and data["file"].endswith(".md")
    text = files[0].read_text(encoding="utf-8")
    assert "Please review the attached function." in text
    assert "laptop" in text
    assert "untrusted" in text.lower()
    assert notifications == [("AirBridge", "New AirBridge Task received from laptop")]


def test_task_without_code_payload(settings, inbox_dir):
    body = _payload()
    del body["code_payload"]
    with _client(settings) as client:
        resp = client.post(URL, json=body)
    assert resp.status_code == 201
    assert len(_md_files(inbox_dir)) == 1


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permissions")
def test_file_and_dir_permissions(settings, inbox_dir):
    with _client(settings) as client:
        resp = client.post(URL, json=_payload())
    assert resp.status_code == 201
    assert stat.S_IMODE(os.stat(inbox_dir).st_mode) == 0o700
    path = inbox_dir / resp.json()["file"]
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_no_temp_files_left_behind(settings, inbox_dir):
    with _client(settings) as client:
        for _ in range(3):
            assert client.post(URL, json=_payload()).status_code == 201
    leftovers = [p.name for p in inbox_dir.iterdir() if not p.name.endswith(".md")]
    assert leftovers == []
    assert len(_md_files(inbox_dir)) == 3


def test_ipv6_tailnet_client_allowed(settings, inbox_dir):
    with _client(settings, client=("fd7a:115c:a1e0::1", 50000)) as client:
        resp = client.post(URL, json=_payload())
    assert resp.status_code == 201


def test_control_characters_are_stripped(settings, inbox_dir):
    with _client(settings) as client:
        resp = client.post(URL, json=_payload(task_description="hello\x00world\x1b[31m"))
    assert resp.status_code == 201
    text = (inbox_dir / resp.json()["file"]).read_text(encoding="utf-8")
    assert "\x00" not in text and "\x1b" not in text


# --------------------------------------------------------------------------- #
# 403: source address
# --------------------------------------------------------------------------- #
def test_non_tailnet_source_rejected(settings, inbox_dir, notifications):
    with _client(settings, client=NON_TAILNET_CLIENT) as client:
        resp = client.post(URL, json=_payload())
    assert resp.status_code == 403
    assert _md_files(inbox_dir) == []
    assert notifications == []


@pytest.mark.parametrize("ip", ["127.0.0.1", "8.8.8.8", "100.128.0.1", "::1"])
def test_various_non_tailnet_sources_rejected(settings, ip):
    with _client(settings, client=(ip, 1234)) as client:
        assert client.post(URL, json=_payload()).status_code == 403


def test_health_tailnet_only(settings):
    with _client(settings) as client:
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}
    with _client(settings, client=NON_TAILNET_CLIENT) as client:
        assert client.get("/health").status_code == 403


def test_docs_and_openapi_disabled(settings):
    with _client(settings) as client:
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404


# --------------------------------------------------------------------------- #
# 413: body size
# --------------------------------------------------------------------------- #
def test_oversized_body_rejected_by_content_length(settings, inbox_dir):
    big = "x" * (security.MAX_BODY_BYTES + 10)
    with _client(settings) as client:
        resp = client.post(URL, json=_payload(code_payload=big))
    assert resp.status_code == 413
    assert _md_files(inbox_dir) == []


def test_oversized_chunked_body_rejected(settings, inbox_dir):
    chunk = b"x" * 65_536
    n_chunks = security.MAX_BODY_BYTES // len(chunk) + 2

    def gen():
        for _ in range(n_chunks):
            yield chunk

    with _client(settings) as client:
        resp = client.post(URL, content=gen(), headers={"Content-Type": "application/json"})
    assert resp.status_code == 413
    assert _md_files(inbox_dir) == []


def test_lying_content_length_cannot_bypass_cap(settings, inbox_dir):
    """Even if Content-Length is absent/small, the real byte count is enforced."""
    body = json.dumps(_payload(code_payload="y" * (security.MAX_BODY_BYTES + 1))).encode()

    def gen():
        yield body

    with _client(settings) as client:
        resp = client.post(URL, content=gen(), headers={"Content-Type": "application/json"})
    assert resp.status_code == 413


def test_invalid_content_length_header(settings):
    with _client(settings) as client:
        resp = client.post(URL, content=b"{}", headers={"Content-Length": "abc"})
    assert resp.status_code in (400, 413)


# --------------------------------------------------------------------------- #
# 429: rate limiting
# --------------------------------------------------------------------------- #
def test_rate_limit_per_ip(settings, inbox_dir):
    limited = dataclasses.replace(settings, rate_limit_per_minute=2)
    app = inbox.create_app(limited, peers_provider=lambda: {})
    with TestClient(app, client=TAILNET_CLIENT) as client:
        assert client.post(URL, json=_payload()).status_code == 201
        assert client.post(URL, json=_payload()).status_code == 201
        assert client.post(URL, json=_payload()).status_code == 429
    # A different tailnet IP has its own bucket.
    with TestClient(app, client=("100.64.0.9", 1)) as other:
        assert other.post(URL, json=_payload()).status_code == 201
    assert len(_md_files(inbox_dir)) == 3


# --------------------------------------------------------------------------- #
# 401: shared secret
# --------------------------------------------------------------------------- #
def test_missing_secret_rejected(secret_settings, inbox_dir):
    with _client(secret_settings) as client:
        resp = client.post(URL, json=_payload())
    assert resp.status_code == 401
    assert _md_files(inbox_dir) == []


def test_wrong_secret_rejected(secret_settings):
    with _client(secret_settings) as client:
        resp = client.post(URL, json=_payload(), headers={config.SECRET_HEADER: "nope"})
    assert resp.status_code == 401
    assert "s3cret-value" not in resp.text


def test_correct_secret_accepted(secret_settings, inbox_dir):
    with _client(secret_settings) as client:
        resp = client.post(URL, json=_payload(), headers={config.SECRET_HEADER: "s3cret-value"})
    assert resp.status_code == 201
    assert len(_md_files(inbox_dir)) == 1


# --------------------------------------------------------------------------- #
# 400: validation
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "body",
    [
        _payload(sender_node="bad sender!"),
        _payload(sender_node="../../etc/passwd"),
        _payload(sender_node=""),
        _payload(sender_node="a" * 65),
        _payload(task_description=""),
        _payload(task_description="   \n  "),
        _payload(task_description="x" * (security.MAX_TASK_BYTES + 1)),
        _payload(task_description=123),
        _payload(code_payload=["not", "a", "string"]),
        _payload(extra_field="nope"),
        {"sender_node": "laptop"},
    ],
)
def test_invalid_payloads_rejected(settings, inbox_dir, notifications, body):
    with _client(settings) as client:
        resp = client.post(URL, json=body)
    assert resp.status_code == 400
    assert resp.json()["status"] == "error"
    assert _md_files(inbox_dir) == []
    assert notifications == []


def test_malformed_json_rejected(settings):
    with _client(settings) as client:
        resp = client.post(URL, content=b"{not json", headers={"Content-Type": "application/json"})
    assert resp.status_code == 400


def test_error_detail_does_not_echo_payload(settings):
    marker = "SECRET-MARKER-" + "z" * 100
    with _client(settings) as client:
        resp = client.post(URL, json=_payload(sender_node=marker))
    assert resp.status_code == 400
    assert marker not in resp.text
    assert "sender_node" in resp.json()["detail"]
    assert len(resp.json()["detail"]) <= 200


def test_code_payload_limit(settings):
    too_big = "c" * (security.MAX_CODE_BYTES + 1)
    with _client(settings) as client:
        resp = client.post(URL, json=_payload(code_payload=too_big))
    # Below MAX_BODY_BYTES on the wire, so it is a validation (400) failure.
    assert len(too_big) < security.MAX_BODY_BYTES
    assert resp.status_code == 400


# --------------------------------------------------------------------------- #
# Ordering of checks
# --------------------------------------------------------------------------- #
def test_order_tailnet_before_size(settings):
    big = "x" * (security.MAX_BODY_BYTES + 10)
    with _client(settings, client=NON_TAILNET_CLIENT) as client:
        assert client.post(URL, json=_payload(code_payload=big)).status_code == 403


def test_order_size_before_secret(secret_settings):
    big = "x" * (security.MAX_BODY_BYTES + 10)
    with _client(secret_settings) as client:
        assert client.post(URL, json=_payload(code_payload=big)).status_code == 413


def test_order_rate_limit_before_secret(secret_settings):
    limited = dataclasses.replace(secret_settings, rate_limit_per_minute=1)
    with _client(limited) as client:
        assert client.post(URL, json=_payload()).status_code == 401
        assert client.post(URL, json=_payload()).status_code == 429


def test_order_secret_before_validation(secret_settings):
    with _client(secret_settings) as client:
        assert client.post(URL, json={"bogus": True}).status_code == 401


# --------------------------------------------------------------------------- #
# Failure handling / misc
# --------------------------------------------------------------------------- #
def test_storage_failure_returns_500(settings, monkeypatch, notifications):
    def boom(*_a, **_k):
        raise security.SecurityError("nope")

    monkeypatch.setattr(security, "safe_inbox_path", boom)
    with _client(settings) as client:
        resp = client.post(URL, json=_payload())
    assert resp.status_code == 500
    assert notifications == []
    assert [p for p in settings.inbox_dir.iterdir()] == []


def test_notification_failure_does_not_break_request(settings, monkeypatch, inbox_dir):
    from airbridge_app import notify

    def broken(title, body):
        raise RuntimeError("no display")

    monkeypatch.setattr(notify, "send_notification", broken)
    with _client(settings) as client:
        resp = client.post(URL, json=_payload())
    assert resp.status_code == 201
    assert len(_md_files(inbox_dir)) == 1


def test_task_payload_model_forbids_extra():
    with pytest.raises(Exception):
        inbox.TaskPayload.model_validate({"sender_node": "a", "task_description": "b", "x": 1})
    ok = inbox.TaskPayload.model_validate({"sender_node": "a", "task_description": "b"})
    assert ok.code_payload is None


def test_build_server_config(settings):
    app = inbox.create_app(settings, peers_provider=lambda: {})
    server = inbox.build_server(app, "100.101.102.103", 8989)
    cfg = server.config
    assert cfg.host == "100.101.102.103"
    assert cfg.port == 8989
    assert cfg.log_config is None
    assert cfg.access_log is False
    assert cfg.server_header is False
    assert cfg.date_header is False
