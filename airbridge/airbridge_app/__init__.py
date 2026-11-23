"""AirBridge: peer-to-peer task handoff between Claude Desktop instances over Tailscale.

Runtime modules must never write to stdout: stdout carries MCP JSON-RPC.
"""

__all__ = ["__version__"]

__version__ = "1.0.0"
