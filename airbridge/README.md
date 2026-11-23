# AirBridge

**Hand a task from the AI on one computer to the AI on another, privately, over your own Tailscale network.**

AirBridge is a small MCP server. Ask Claude on your Mac to send a function to your Windows PC, and a
tidy Markdown task file appears there seconds later, ready for Cursor, Codex or Claude to pick up.
Nothing passes through a cloud service, and nothing leaves your tailnet.

```
   MacBook                                           Windows PC
 ┌──────────────┐                                 ┌──────────────┐
 │ Claude       │   send_task_to_node             │ Cursor/Codex │
 │   │          │                                 │   ▲          │
 │ AirBridge  ──┼──────►  Tailscale (WireGuard) ──┼─► AirBridge  │
 │   ▲          │                                 │   │          │
 │   └──────────┼─◄──────   private tailnet  ◄────┼── Inbox/*.md │
 └──────────────┘          100.x.y.z : 8989       └──────────────┘
```

Every computer runs the same AirBridge. Each one can send and receive.

---

## Before you start

- **Python 3.11 or newer** on each computer.
- **Tailscale** installed, signed in to the same tailnet, and running on each computer
  ([download](https://tailscale.com/download)).
- An MCP client: Claude Desktop, Cursor or Codex.

## Get started in 3 steps

### macOS

1. **Get AirBridge** and open a terminal in the `airbridge` folder.
2. **Install:**
   ```bash
   python3 install.py
   ```
   It creates a private virtual environment in `airbridge/.venv`, installs the dependencies, and
   prints the exact configuration for your computer.
3. **Connect your client.** Paste the printed `airbridge` entry into
   `~/Library/Application Support/Claude/claude_desktop_config.json` (keep any servers you already
   have), then quit and reopen Claude.

### Windows

1. **Get AirBridge** and open PowerShell in the `airbridge` folder.
2. **Install:**
   ```powershell
   py -3 install.py
   ```
3. **Connect your client.** Paste the printed entry into
   `%APPDATA%\Claude\claude_desktop_config.json`, then quit Claude from the system tray and reopen it.
   Then allow port 8989 on the Tailscale interface (see [Troubleshooting](#windows-firewall)).

The installer's output looks like this (paths are filled in for you):

```json
{
  "mcpServers": {
    "airbridge": {
      "command": "C:\\Users\\you\\airbridge\\.venv\\Scripts\\python.exe",
      "args": ["C:\\Users\\you\\airbridge\\main.py"]
    }
  }
}
```

**Using Cursor or Codex instead?** The installer prints those too.

| Client | Config file | Format |
|---|---|---|
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows `%APPDATA%\Claude\claude_desktop_config.json` | JSON, as above |
| Cursor | `~/.cursor/mcp.json` | JSON, as above |
| Codex | `~/.codex/config.toml` | `[mcp_servers.airbridge]` with `command` and `args` |

Installer options: `--dry-run` prints the configuration without creating anything,
`--json-only` prints only the JSON (handy for scripts), and `--venv PATH` picks a different
environment folder.

## Using it

Just talk to your assistant. AirBridge adds two tools: `list_airbridge_nodes` and
`send_task_to_node`.

> List my AirBridge nodes.

> Send this function to **my-windows-pc** and ask it to refactor it to use pathlib.

> Send the failing test output to **studio-mac** with a note to investigate the timeout.

Node names are the Tailscale machine names (as shown by `tailscale status`) and are not
case-sensitive.

### Where tasks land

Each task arrives as one Markdown file in **`~/Desktop/AirBridge_Inbox`**, named like
`task_20261123-140509-123456.md`, with a desktop notification. Open the folder in Cursor or point
your assistant at it: *"Read the newest task in my AirBridge inbox."*

Every file has the same calm shape:

- **Front matter** with the sender, source IP, time (UTC and local), and whether code is attached.
- **A warning** that the content came from a remote node and is untrusted.
- **Task**: the request, with any Markdown structure made inert.
- **Code**: in a fenced block with a detected language and line count.
- **Suggested next steps for the AI**: read, summarise, ask before running anything, then reply
  with `send_task_to_node`.

## Configuration

All settings are optional environment variables. Set them in the `env` block of your client's
MCP configuration.

| Variable | Default | What it does |
|---|---|---|
| `AIRBRIDGE_SECRET` | *(unset)* | Shared secret sent as the `X-AirBridge-Secret` header. If set, incoming tasks without the matching secret are rejected. Use the same value on every computer. |
| `AIRBRIDGE_INBOX_DIR` | `~/Desktop/AirBridge_Inbox` | Where incoming task files are written. |
| `AIRBRIDGE_LOG_FILE` | `airbridge/airbridge.log` | Where AirBridge logs. It never writes logs to the terminal, because stdout is reserved for MCP. |

```json
"airbridge": {
  "command": "/Users/you/airbridge/.venv/bin/python",
  "args": ["/Users/you/airbridge/main.py"],
  "env": { "AIRBRIDGE_SECRET": "a-long-random-phrase" }
}
```

## Security model

AirBridge assumes that your tailnet is private but that anything arriving over it might still
be hostile.

- **Tailnet only.** It listens only on this computer's Tailscale IP (never `0.0.0.0` or
  `localhost`), accepts only Tailscale source addresses, and sends only to Tailscale addresses.
- **Optional shared secret**, compared in constant time.
- **Limits**: request size caps, per-computer rate limiting, strict sender names, and inbox
  filenames that are always generated, never taken from the request.
- **Inert content.** Tasks are written as data with a visible untrusted-input warning. AirBridge
  never runs received code, and your assistant is asked to check with you before it does.
- **No shell.** There is no `shell=True`, `eval` or `exec` anywhere.

The full threat model is in [docs/SECURITY.md](docs/SECURITY.md).

## Troubleshooting

**"Tailscale is not running" / AirBridge won't start.** Open the Tailscale app and sign in, then
run `tailscale status` to confirm this computer has a `100.x.y.z` address. Your client's MCP log
shows the reason AirBridge stopped.

**Run the built-in check.** It diagnoses Tailscale and your configuration and then exits:

```bash
# macOS / Linux
.venv/bin/python main.py --check
```
```powershell
# Windows
.venv\Scripts\python.exe main.py --check
```

<a id="windows-firewall"></a>
**Tasks never arrive on Windows.** Windows Firewall blocks port 8989 by default. In an
**Administrator** PowerShell, allow it on the Tailscale interface only:

```powershell
New-NetFirewallRule -DisplayName "AirBridge (Tailscale only)" `
  -Direction Inbound -Protocol TCP -LocalPort 8989 `
  -InterfaceAlias "Tailscale" -RemoteAddress 100.64.0.0/10 -Action Allow
```

**My node isn't listed.** Only online peers appear. Check that the other computer is awake, signed in
to the same tailnet, and running AirBridge (its MCP client is open).

**`401` / `403` errors.** A `403` means the request didn't come from a Tailscale address. A `401`
means `AIRBRIDGE_SECRET` is different on the two computers.

**Nothing in the terminal?** That's expected. AirBridge talks MCP over stdio and writes everything
else to its log file (`AIRBRIDGE_LOG_FILE`).

## Privacy

AirBridge has no accounts, no telemetry and no analytics, and it makes no network calls except
the ones you ask for between your own computers, over your own encrypted Tailscale network. Tasks
are stored only as files in your inbox folder, readable only by you. Delete them whenever you like.
