# AirBridge

**Hand a task from the AI on one computer to the AI on another, privately, over your own Tailscale network.**

Ask Claude on your Mac to send a function to your Windows PC, and a tidy task file appears there
seconds later, ready for Cursor, Codex or Claude to pick up. Nothing passes through a cloud service,
and nothing leaves your own private network.

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

## Setup for everyone (2 minutes)

Do these three steps on **each** computer you want to connect.

**1. Install Tailscale and sign in.**
Download it from [tailscale.com/download](https://tailscale.com/download), open it, and sign in.
Use the **same account** on both computers.

**2. Double-click _Install AirBridge_.**
In the AirBridge folder, double-click:

- **Mac:** `Install AirBridge.command`
- **Windows:** `Install AirBridge.bat`

A window opens and walks you through four short steps. When it asks
*"Add AirBridge to Claude Desktop for you?"*, press **Enter** for yes. It keeps a backup of your
previous settings.

**3. Restart Claude.**
Quit Claude Desktop completely and open it again, then ask:

> List my AirBridge nodes.

That's it.

<details>
<summary><b>If something gets in the way</b></summary>

- **"Python 3.11 or newer is needed."** The installer opens the download page for you. Install
  Python from [python.org/downloads](https://www.python.org/downloads/) (on Windows, tick
  **Add python.exe to PATH**), then double-click _Install AirBridge_ again.
- **Mac says the file "can't be opened because it is from an unidentified developer".**
  Right-click `Install AirBridge.command`, choose **Open**, then click **Open** again.
- **Windows says "Windows protected your PC".** Click **More info**, then **Run anyway**.
- **Windows asks whether Python may use networks.** Click **Allow**. If you clicked Cancel, see
  [the firewall fix](#windows-firewall).
- **"Tailscale is installed but not connected."** Open the Tailscale app, sign in, and press
  Enter in the installer window to check again.

</details>

---

## Advanced setup

Everything the double-click installer does, by hand. You need **Python 3.11+**, **Tailscale**
running on each computer, and an MCP client (Claude Desktop, Cursor or Codex).

```bash
python3 install.py            # macOS / Linux
py -3 install.py              # Windows
```

| Option | What it does |
|---|---|
| `--yes` | Accept every offer and never wait for input (for scripts and remote setup). |
| `--dry-run` | Change nothing; show what would happen. |
| `--json-only` | Print only the JSON configuration. |
| `--venv PATH` | Keep AirBridge's virtual environment somewhere other than `airbridge/.venv`. |

The installer creates `airbridge/.venv`, installs `requirements.txt`, checks Tailscale, and merges
an `airbridge` entry into Claude Desktop's and Cursor's configuration. It never overwrites a file it
can't parse, and it saves a timestamped `.bak-YYYYMMDD-HHMMSS` copy before changing one.
To configure a client by hand, add:

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

On macOS and Linux the command is `.../airbridge/.venv/bin/python`.

| Client | Config file | Format |
|---|---|---|
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows `%APPDATA%\Claude\claude_desktop_config.json` | JSON, as above |
| Cursor | `~/.cursor/mcp.json` | JSON, as above |
| Codex | `~/.codex/config.toml` | `[mcp_servers.airbridge]` with `command` and `args` |

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
