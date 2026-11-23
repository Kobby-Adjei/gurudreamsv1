"""AirBridge outbound side: the MCP server exposed to Claude Desktop over stdio.

Exactly two tools are registered:

* ``list_airbridge_nodes`` - which machines on the tailnet can receive tasks.
* ``send_task_to_node``    - deliver a task (and optional code) to one of them.

Both tools always return a human-readable string starting with ``SUCCESS:`` or
``FAILURE:`` (the list tool returns the list itself on success) and never raise.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import socket
from typing import Any

import requests
from mcp.server.mcpserver import MCPServer

from . import config, events, network, security

logger = logging.getLogger("airbridge.outbox")

_INSTRUCTIONS = (
    "AirBridge lets you hand tasks to Claude running on the user's other computers "
    "over their private Tailscale network. Call list_airbridge_nodes to see which "
    "machines are reachable, then send_task_to_node to deliver a task. The receiving "
    "machine saves it as a Markdown file in its AirBridge inbox for its user to review."
)


def _local_sender_name() -> str:
    """This machine's hostname, sanitised to the sender-name pattern."""
    raw = (socket.gethostname() or "").split(".")[0]
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "-", raw).strip("-.")[: security.MAX_SENDER_LEN]
    try:
        return security.validate_sender(cleaned or "airbridge-node")
    except security.SecurityError:
        return "airbridge-node"


def _format_peers(peers: dict[str, str]) -> str:
    return "\n".join(f"• {name} — {ip}" for name, ip in sorted(peers.items()))


async def _available_hosts_hint() -> str:
    try:
        peers = await asyncio.to_thread(network.get_airbridge_peers)
    except Exception:
        return "Could not list available nodes either; check that Tailscale is running."
    if not peers:
        return "No other online nodes were found on your tailnet."
    return "Available nodes:\n" + _format_peers(peers)


async def list_nodes() -> str:
    """Implementation of the ``list_airbridge_nodes`` tool."""
    try:
        peers = await asyncio.to_thread(network.get_airbridge_peers)
    except network.TailscaleError as exc:
        logger.warning("listing peers failed: %s", exc)
        return f"FAILURE: could not query Tailscale: {exc}"
    except Exception as exc:  # never raise into the MCP layer
        logger.exception("unexpected error listing peers")
        return f"FAILURE: unexpected error while listing nodes: {type(exc).__name__}"
    if not peers:
        return (
            "No other online nodes found on your Tailscale network. Make sure the other "
            "computer is powered on, signed in to Tailscale, and running AirBridge."
        )
    return (
        f"Online nodes on your tailnet ({len(peers)}). Each can receive tasks if AirBridge "
        f"is running there:\n{_format_peers(peers)}"
    )


def _post(url: str, body: dict[str, Any], headers: dict[str, str], timeout: float) -> requests.Response:
    with requests.Session() as session:
        session.trust_env = False  # never route tailnet traffic through env proxies
        return session.post(url, json=body, headers=headers, timeout=timeout, allow_redirects=False)


def _response_detail(resp: requests.Response) -> str:
    try:
        data = resp.json()
    except ValueError:
        return ""
    if isinstance(data, dict):
        detail = data.get("detail")
        if isinstance(detail, str):
            return detail[:200]
    return ""


def _ok(target: str, name: str, message: str, nbytes: int) -> dict[str, Any]:
    return {"ok": True, "status": 200, "target": target, "file": name or None,
            "error": None, "message": message, "bytes": nbytes}


def _fail(error: str, status: int, target: str | None = None, nbytes: int | None = None) -> dict[str, Any]:
    """Structured failure; ``message`` is the Phase-1 "FAILURE: ..." string."""
    return {"ok": False, "status": status, "target": target, "file": None,
            "error": error, "message": f"FAILURE: {error}", "bytes": nbytes}


def _interpret_response(resp: requests.Response, host: str, nbytes: int) -> dict[str, Any]:
    status = resp.status_code
    if status in (200, 201):
        name = ""
        try:
            data = resp.json()
            if isinstance(data, dict) and isinstance(data.get("file"), str):
                name = data["file"]
        except ValueError:
            pass
        where = f" as {name}" if name else ""
        return _ok(host, name,
                   f"SUCCESS: task delivered to {host}{where}. It is waiting in {host}'s AirBridge inbox.",
                   nbytes)
    detail = _response_detail(resp)
    suffix = f" (server said: {detail})" if detail else ""
    if status == 400:
        return _fail(f"{host} rejected the task as invalid{suffix}.", 502, host, nbytes)
    if status == 401:
        return _fail(
            f"{host} refused the task because the shared secret did not match. "
            "Set the same AIRBRIDGE_SECRET on both machines and restart AirBridge.", 502, host, nbytes)
    if status == 403:
        return _fail(
            f"{host} refused the connection because it did not come from a "
            "Tailscale address. Check that both machines are on the same tailnet.", 502, host, nbytes)
    if status == 413:
        return _fail(
            f"the task is too large for {host} (limit {security.MAX_BODY_BYTES} bytes). "
            "Shorten the description or send less code.", 413, host, nbytes)
    if status == 429:
        return _fail(f"{host} is rate-limiting requests. Wait a minute and try again.", 429, host, nbytes)
    if 300 <= status < 400:
        return _fail(f"{host} answered with a redirect (HTTP {status}); AirBridge does not follow redirects.",
                     502, host, nbytes)
    return _fail(f"{host} returned an unexpected HTTP {status}{suffix}.", 502, host, nbytes)


async def send_task(
    settings: config.Settings,
    target_hostname: str,
    task_description: str,
    code_payload: str | None = None,
) -> str:
    """Implementation of the ``send_task_to_node`` tool (Phase-1 string result)."""
    result = await send_task_result(settings, target_hostname, task_description, code_payload)
    return result["message"]


async def send_task_result(
    settings: config.Settings,
    target_hostname: str,
    task_description: str,
    code_payload: str | None = None,
    *,
    origin: str | None = None,
) -> dict[str, Any]:
    """Send a task and return a structured result. Never raises.

    Returns ``{ok, status, target, file, error, message, bytes}`` where
    ``status`` is the HTTP status the control API should answer with (200 on
    success; 400/404/413/429/502 on failure) and ``message`` is the Phase-1
    ``SUCCESS: ...``/``FAILURE: ...`` text. Emits ``task_sent`` or
    ``send_failed`` (origin defaults to the process origin: "mcp" in stdio
    mode, "daemon" in the desktop daemon).
    """
    try:
        result = await _send_task(settings, target_hostname, task_description, code_payload)
    except Exception as exc:  # last-resort guard: tools never raise
        logger.exception("unexpected error sending task")
        result = _fail(f"unexpected error while sending the task: {type(exc).__name__}", 500)
    _emit_send_event(result, target_hostname, code_payload, origin)
    return result


def _emit_send_event(result: dict[str, Any], raw_target: object, code_payload: str | None, origin: str | None) -> None:
    try:
        peer = result.get("target") or (raw_target if isinstance(raw_target, str) else None)
        peer = (peer or "").strip()[:64] or None
        if result.get("ok"):
            what = "code" if code_payload else "task"
            events.emit("task_sent", peer=peer, summary=f"Sent {what} to {peer}", origin=origin,
                        bytes=result.get("bytes"), file=result.get("file"))
        else:
            where = f" to {peer}" if peer else ""
            events.emit("send_failed", peer=peer, summary=f"Send failed{where}", origin=origin,
                        bytes=result.get("bytes"), error=result.get("error"))
    except Exception:  # events must never break sending
        logger.exception("could not record send event")


async def _send_task(
    settings: config.Settings,
    target_hostname: str,
    task_description: str,
    code_payload: str | None,
) -> dict[str, Any]:
    # --- local validation (same rules the receiver enforces) ---
    try:
        target = security.validate_sender((target_hostname or "").strip())
    except security.SecurityError:
        return _fail(
            "invalid target hostname. Use a node name exactly as shown by "
            "list_airbridge_nodes (letters, digits, '.', '_' or '-', max 64 characters).", 400)
    try:
        task = security.validate_task_text(task_description or "", security.MAX_TASK_BYTES)
    except security.SecurityError as exc:
        return _fail(f"task_description is not acceptable: {exc}", 400, target)
    if not task.strip():
        return _fail("task_description must not be empty.", 400, target)
    code: str | None = None
    if code_payload is not None and code_payload != "":
        try:
            code = security.validate_task_text(code_payload, security.MAX_CODE_BYTES)
        except security.SecurityError as exc:
            return _fail(f"code_payload is not acceptable: {exc}", 400, target)

    body: dict[str, Any] = {
        "sender_node": _local_sender_name(),
        "task_description": task,
        "code_payload": code,
    }
    encoded_len = len(json.dumps(body).encode("utf-8"))
    if encoded_len > security.MAX_BODY_BYTES:
        return _fail(
            f"the task is too large to send ({encoded_len} bytes encoded, limit "
            f"{security.MAX_BODY_BYTES}). Shorten the description or send less code.", 413, target, encoded_len)

    # --- resolve the target on the tailnet ---
    try:
        ip = await asyncio.to_thread(network.resolve_peer, target)
    except network.TailscaleError as exc:
        return _fail(f"could not query Tailscale: {exc}", 502, target, encoded_len)
    if not ip:
        hint = await _available_hosts_hint()
        return _fail(f"no online node named '{target}' was found on your tailnet. {hint}", 404, target, encoded_len)
    if not security.is_tailnet_ip(ip):
        logger.warning("refusing to send to non-tailnet address %s for %s", security.truncate_for_log(ip, 64), target)
        return _fail(f"'{target}' resolved to {ip}, which is not a Tailscale address; refusing to send.",
                     400, target, encoded_len)

    host_part = f"[{ip}]" if ":" in ip else ip
    url = f"http://{host_part}:{settings.port}/incoming_task"
    headers = {"Content-Type": "application/json"}
    if settings.shared_secret:
        headers[config.SECRET_HEADER] = settings.shared_secret

    logger.info("sending task to %s (%s): %s", target, ip, security.truncate_for_log(task, 200))
    try:
        resp = await asyncio.to_thread(_post, url, body, headers, settings.http_timeout_s)
    except requests.exceptions.Timeout:
        return _fail(
            f"timed out after {settings.http_timeout_s}s waiting for {target} ({ip}). "
            "The machine may be asleep or AirBridge may be busy.", 502, target, encoded_len)
    except requests.exceptions.ConnectionError:
        return _fail(
            f"could not connect to {target} ({ip}) on port {settings.port}. "
            f"Is AirBridge running on {target}?", 502, target, encoded_len)
    except requests.exceptions.RequestException as exc:
        return _fail(f"request to {target} failed: {type(exc).__name__}", 502, target, encoded_len)

    result = _interpret_response(resp, target, encoded_len)
    logger.info("send to %s finished with HTTP %s", target, resp.status_code)
    return result


def build_mcp_server(settings: config.Settings | None = None) -> MCPServer:
    """Create the AirBridge MCP server with its two tools."""
    resolved = settings if settings is not None else config.load()
    server = MCPServer("airbridge", instructions=_INSTRUCTIONS)

    @server.tool()
    async def list_airbridge_nodes() -> str:
        """List the computers on the user's private Tailscale network that can receive AirBridge tasks.

        Call this first whenever the user wants to send work to "my other computer",
        "the desktop", "my laptop" or a machine by name, so you can pick the exact node
        name to pass to send_task_to_node. Takes no arguments.

        Returns one line per online node in the form "• hostname — 100.x.y.z". A node
        appears here when it is online in Tailscale; it can only receive tasks if the
        AirBridge app is also running on it. Returns a message starting with "FAILURE:"
        if Tailscale is not installed or not running on this computer.
        """
        return await list_nodes()

    @server.tool()
    async def send_task_to_node(
        target_hostname: str,
        task_description: str,
        code_payload: str | None = None,
    ) -> str:
        """Send a task, and optionally code, to Claude on another of the user's computers.

        The task is delivered over the user's private Tailscale network and saved as a
        Markdown file in the AirBridge inbox on the target machine, where the user (or
        Claude on that machine) will review it. Nothing is executed automatically.

        Args:
            target_hostname: The node name exactly as listed by list_airbridge_nodes
                (case-insensitive, e.g. "macbook-pro"). Call list_airbridge_nodes first
                if you are not sure of the name.
            task_description: Clear, self-contained instructions for the receiving side:
                what to do, why, and any context it needs, since it cannot see this
                conversation. Plain text or Markdown, up to 64 KB.
            code_payload: Optional code, diff, log or file contents that the task refers
                to, up to 512 KB. Omit it when there is nothing to attach.

        Returns "SUCCESS: ..." with the stored file name when the task was delivered, or
        "FAILURE: ..." explaining what went wrong (unknown node, AirBridge not running on
        the target, timeout, wrong shared secret, payload too large, rate limited) so you
        can tell the user or fix the call.
        """
        return await send_task(resolved, target_hostname, task_description, code_payload)

    return server


__all__ = ["build_mcp_server", "list_nodes", "send_task", "send_task_result"]
