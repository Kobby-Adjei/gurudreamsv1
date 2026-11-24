# Commercial and vendor-native permission, approval, sandboxing, undo and audit features for AI agents (as of 2026-11-24)

All pages were retrieved on 2026-11-24 unless a different date is given. "Doc" means the vendor's own documentation or changelog. "Search summary" means the claim came from a search-engine digest of the linked page and was not fetched in full, so it carries lower confidence. Capability codes used below: (1) plan/preview + human approval, including mobile/remote; (2) scoped/least-privilege permissions or capability tokens; (3) policy engine; (4) undo/rollback/checkpoints; (5) tamper-evident audit/receipts; (6) sandboxing.

## Q1. Vendor-native controls: what each agent does and what is missing

### Takeaway
By November 2026 every major coding agent ships (1) approvals, (2) allow/deny rules, (3) some admin-managed policy, and (6) an OS-level sandbox for shell commands (Seatbelt on macOS, bubblewrap/Landlock plus seccomp on Linux). Several also offer phone approvals for a session running on the user's own machine: Claude Code Remote Control and Codex via the ChatGPT mobile app. All of these controls are single-vendor. Undo is limited to files: only Claude Code and Gemini CLI document checkpoints, and neither reverts shell side effects or changes to external systems. No vendor documents tamper-evident or signed audit. Logs are plain OTel events or vendor compliance APIs.

### Cited Findings

**Claude Code (Anthropic)**
- **(1)(3) Permission modes.** The documented modes are `default` (shown as "Manual"), `acceptEdits`, `plan`, `auto`, `dontAsk` and `bypassPermissions`:
  - `plan` lets Claude read and run read-only commands but not edit source files.
  - `auto` runs without routine prompts. Instead, "a background classifier checks that [actions] align with your request".
  - `dontAsk` auto-denies anything that would otherwise prompt.
  - Source: [Claude Code permissions doc](https://code.claude.com/docs/en/permissions)
- **(2) Rules.** Allow/ask/deny rules can be set per tool with specifiers, for example `Bash(git push *)`, path rules for Read/Edit, domains for WebFetch, MCP tools and subagents. Deny takes precedence over everything else. — [permissions doc](https://code.claude.com/docs/en/permissions)
- **(3) Hooks.** PreToolUse hooks "run before the permission prompt" and can deny the call, force a prompt or skip the prompt. Hooks cannot override deny or ask rules, including deny rules from managed settings. A hook that exits with code 2 blocks the call even when an allow rule exists. — [permissions doc](https://code.claude.com/docs/en/permissions)
- **(3) Managed settings.** Administrators can deploy managed settings that user and project settings can't override. `allowManagedPermissionRulesOnly` makes managed settings the only source of permission rules, and `disableBypassPermissionsMode` locks out bypass mode. — [permissions doc](https://code.claude.com/docs/en/permissions)
- **(6) Sandbox scope and platforms.**
  - It is an OS-enforced sandbox for Bash, PowerShell and Monitor commands and their child processes. It is off by default and is turned on with `/sandbox`.
  - macOS uses Seatbelt. Linux and WSL2 use bubblewrap and socat, with an optional seccomp filter.
  - Native Windows is not supported.
  - It is built on the open-source `@anthropic-ai/sandbox-runtime`.
  - Source: [Claude Code sandboxing doc](https://code.claude.com/docs/en/sandboxing)
- **(6) Sandbox filesystem and network.**
  - Writes are limited to the working directory, a temp directory and added directories. Protected paths such as `.claude/settings.json`, `.mcp.json`, `.bashrc` and `.git/hooks` stay write-denied.
  - Reads are allowed across most of the machine by default, including `~/.ssh` and `~/.aws/credentials`.
  - Network traffic goes through a local proxy with `allowedDomains` and `deniedDomains`.
  - Credential masking (`credentials.files`/`envVars` with `mask`) substitutes the real credential at the proxy for allowed hosts. This requires `tlsTerminate`.
  - Source: [sandboxing doc](https://code.claude.com/docs/en/sandboxing)
- **(6) Sandbox limits.** Built-in file and web tools, hooks, local MCP servers and mods run outside the sandbox. `dangerouslyDisableSandbox` retries are possible unless `allowUnsandboxedCommands: false` is set. Docker is incompatible. — [sandboxing doc](https://code.claude.com/docs/en/sandboxing)
- **(4) Checkpoints.**
  - `/rewind` (alias `/undo`, or double Esc) restores code, the conversation, or both, to a point before any prompt. Snapshots cover the 100 most recent checkpoints and are deleted about 30 days later by default.
  - Not covered: files changed only by Bash, most subagent edits, external or concurrent-session changes, and symlinked or hard-linked files.
  - The doc says it is "not a replacement for version control".
  - Source: [Claude Code checkpointing doc](https://code.claude.com/docs/en/checkpointing)
- **(1) Remote Control: what it does.**
  - It connects claude.ai/code or the Claude iOS/Android app to a Claude Code session running locally. Execution and filesystem access stay on the machine.
  - The local process makes outbound HTTPS only and opens no inbound ports. The transcript is stored on Anthropic servers while connected.
  - Push notifications ("Push when actions required") cover permission prompts and questions. Permission prompts stay open until answered.
  - It requires Pro, Max, Ultra, Team or Enterprise. API keys are not supported. ZDR and HIPAA organizations can't enable it.
  - Source: [Remote Control doc](https://code.claude.com/docs/en/remote-control)
- **(1) Remote Control: Trusted Devices.** This optional setting requires an enrolled device plus a sign-in no older than 18 hours, refreshed by Face ID, Touch ID or a passkey. It also applies to Cowork computer access. — [Remote Control doc](https://code.claude.com/docs/en/remote-control)
- **Remote Control across machines.** It works per process ("one remote session per interactive process", or server mode for multiple). "Cross-session messaging" carries messages between the user's own sessions on different machines. This is multi-machine, but only for Claude Code sessions. — [Remote Control doc](https://code.claude.com/docs/en/remote-control)

**Claude computer use / Cowork**
- **(1)(2) Per-app approval.**
  - Claude asks before accessing each application. Investment, trading and cryptocurrency apps are blocked by default.
  - Users can keep a blocklist, and blocked apps are auto-denied. A "full control" mode skips per-app prompts.
  - The safety article says computer use clicks and types "without the permission checks that gate other Cowork tools".
  - Search summary of [Claude Help Center: Let Claude use your computer in Cowork](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
- **Plan availability is inconsistent between sources.** One help article says Pro and Max only. The product page says Pro, Max, Ultra and Team, as a research preview. — [Help Center](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork) vs [Cowork product page](https://www.claude.com/product/cowork). I did not fetch either page in full.

**OpenAI Codex**
- **(6) Sandbox modes and OS mechanisms.**
  - Modes are `read-only`, `workspace-write` and `danger-full-access`. The "Auto" preset is workspace-write with `on-request` approvals. `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) is "not recommended".
  - macOS uses Seatbelt (`sandbox-exec`). Linux uses `bwrap` plus seccomp. Windows uses "MXC", with elevated and unelevated legacy fallbacks. WSL1 is unsupported from version 0.115.
  - Source: [Codex Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security). The old developers.openai.com/codex URLs now 308-redirect to learn.chatgpt.com.
- **(1) Approval policies.** The policies are `on-request`, `never` and a `granular` form. `untrusted` is retired. — [Codex approvals doc](https://learn.chatgpt.com/docs/agent-approvals-security)
- **(3) Auto-review.** `approvals_reviewer = "auto_review"` routes approval requests to a reviewer agent. It allows low- and medium-risk actions, denies critical-risk ones and fails closed on errors. Admins can restrict it with `allowed_approvals_reviewers`. — [Codex approvals doc](https://learn.chatgpt.com/docs/agent-approvals-security)
- **(6) Network.** Network is off by default in workspace-write. A `network_proxy` with domain rules is available. — [Codex approvals doc](https://learn.chatgpt.com/docs/agent-approvals-security)
- **(3) Managed configuration and rules.** Managed configuration supports `allowed_approval_policies`, `allowed_web_search_modes` and network requirements. Precedence runs MDM, then "Agent Security", then the device requirements file. Execution-policy "Rules" can auto-allow commands or require review. — [Codex approvals doc](https://learn.chatgpt.com/docs/agent-approvals-security)
- **(5) Telemetry.** OTel export is opt-in and includes `codex.tool_decision` and `codex.tool_result` events. The navigation also lists a "Compliance API and audit events" page, which I did not fetch. — [Codex approvals doc](https://learn.chatgpt.com/docs/agent-approvals-security)
- **(6) Codex Cloud (legacy).** It runs in isolated OpenAI-managed containers. The setup phase can use the network. The agent phase is offline by default, and secrets are removed before it starts. — [Codex approvals doc](https://learn.chatgpt.com/docs/agent-approvals-security)
- **(1) Remote connections.**
  - The ChatGPT mobile app (iOS/Android) controls a macOS or Windows host running the ChatGPT desktop app. From the phone a user can approve commands, answer questions, and review diffs, terminal output and screenshots, and is notified when a task finishes or needs attention.
  - The phone is paired separately with each host. A desktop can also "Control other devices". SSH hosts can be added.
  - The host must stay awake and signed in. Setup is only possible from the desktop app, not the CLI. Workspace admins may need to enable it.
  - Source: [Codex Remote connections doc](https://learn.chatgpt.com/docs/remote-connections)
- **Remote connections launch and plans.** The launch post is "Work with Codex from anywhere". Mobile is in preview on all plans including Free and Go. — [OpenAI](https://openai.com/index/work-with-codex-from-anywhere/) (search summary; launch date not confirmed)

**Cursor**
- **(1)(2) Approvals and allowlists.**
  - Terminal commands need approval by default. "Run Modes" range from an allowlist to an "Auto-review" classifier. Cursor calls these "best-effort guardrails rather than a hard security boundary".
  - Workspace edits need no approval, except configuration files.
  - Each MCP connection and each MCP tool call requires approval unless the tool is on the MCP allowlist.
  - Workspace trust can be enforced through MDM.
  - Changes save to disk immediately, and Cursor recommends version control for reverting them.
  - Source: [Cursor agent security doc](https://cursor.com/docs/agent/security)
- **(6) Sandbox (blog of 2026-02-18).**
  - macOS uses Seatbelt with a profile generated at runtime from workspace settings, admin settings and `.cursorignore`. Linux uses Landlock plus seccomp. Windows runs the Linux sandbox inside WSL2.
  - Sandboxed agents "stop 40% less often". About a third of requests on supported platforms run sandboxed.
  - Source: [Cursor blog: agent sandboxing](https://cursor.com/blog/agent-sandboxing)
- **Sandbox default is disputed.** Cursor's terminal docs say commands run sandboxed by default on macOS/Linux. A third-party glossary says it is off by default. Forum reports from early to mid 2026 describe network-config bugs. — [search summary](https://cursor.com/docs/agent/tools/terminal.md); [flaviocopes glossary](https://flaviocopes.com/ai-glossary/sandbox/)
- **Not documented on the security page:** checkpoints, hooks and background-agent isolation. I did not research these further.

**GitHub Copilot**
- **(3)(1) Enterprise managed permissions (changelog of 2026-09-09).**
  - Admins of Copilot Business or Enterprise can block, require human approval for, or allow shell commands, file reads and edits, and network domains, with different policies per enterprise team.
  - User or workspace settings, auto-approval and previously saved approvals cannot weaken these restrictions.
  - Applies to the Copilot app, Copilot CLI and VS Code sessions that use Agent Host.
  - Source: [GitHub changelog](https://github.blog/changelog/2026-09-09-enterprise-managed-permissions-for-github-copilot-agent-operations)
- **(6) Cloud agent firewall.**
  - The cloud/coding agent runs in a GitHub Actions environment behind a default firewall. Admins can add allowed hosts or disable it.
  - The firewall does not apply to processes outside that environment.
  - Only users with write access can trigger the agent.
  - Source: [GitHub docs: customize the agent firewall](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/customize-the-agent-firewall) (search summary)

**Gemini CLI (Google)**
- **(3) Policy engine.** It checks each tool call against configuration such as trusted folders and allowed commands, then allows, confirms or blocks the call. — [Gemini CLI core concepts](https://geminicli.com/docs/core/concepts) (search summary)
- **(2) Trusted folders.** Off by default. Trust decisions are saved in `~/.gemini/trustedFolders.json`. — [Trusted Folders doc](https://geminicli.com/docs/cli/trusted-folders/) (search summary)
- **(4) Checkpointing.** It snapshots project files before modification. It is off by default and can be enabled only in `settings.json`, because the `--checkpointing` flag was removed in v0.11.0. — [Checkpointing doc](https://geminicli.com/docs/cli/checkpointing.md) (search summary)
- **(6) Sandbox.** Backends include Docker, Podman, LXC, macOS Seatbelt and gVisor. — [Sandbox doc](https://geminicli.com/docs/cli/sandbox) (search summary); [The New Stack](https://thenewstack.io/gemini-cli-prompt-injection-safeguards/)

**OpenClaw (open-source personal agent with gateway and "nodes")**
- **(1)(2)(3) Exec approvals.**
  - Approvals are enforced locally on the execution host: the gateway host or a node host (the macOS companion app or a headless node).
  - `exec.security` is `deny`, `allowlist` or `full`. The default is `full` on gateway and node hosts and `deny` on sandbox hosts.
  - `exec.ask` is `off`, `on-miss` or `always`. `askFallback` defaults to `deny` when no UI is reachable.
  - Approvals "can only tighten config-derived security/ask, never loosen them" and are "not a per-user auth boundary".
  - Allowlist entries are globs on binary paths, with an `argPattern` regex. Every segment of a shell chain must match. `allow-always` entries are bound to the exact argv and working directory.
  - Source: [OpenClaw exec approvals doc](https://docs.openclaw.ai/tools/exec-approvals)
- **(1) Approval surfaces.**
  - The gateway broadcasts `exec.approval.requested` to operator clients, meaning the Control UI and the macOS app.
  - Matrix supports reaction-based approval (✅, ♾️, ❌) plus `/approve`. Telegram, Slack and Discord forwarding are covered in a separate advanced doc that I did not fetch.
  - There is no dedicated audit log. Lifecycle messages are "Exec finished/denied (gateway id=...)", plus a standing-grant ledger (`openclaw approvals grants list`).
  - Source: [OpenClaw exec approvals doc](https://docs.openclaw.ai/tools/exec-approvals)
- **Per-node approvals.** Approvals are stored per host in `~/.openclaw/exec-approvals.json`. `openclaw approvals get/set --node <id>` edits a node's approvals remotely. This is a multi-machine approval model, but only for OpenClaw. — [OpenClaw CLI approvals doc](https://docs.openclaw.ai/cli/approvals.md) (search summary)

### Inferences
- These vendors have converged on the same mechanisms, which makes the features hard to compete on:
  - OS sandbox: Seatbelt, bwrap/Landlock and seccomp.
  - Allow/ask/deny rules.
  - Admin-managed policy that users can't weaken.
  - A classifier-based "auto" mode: Claude Code auto, Codex auto_review, Cursor Auto-review.
- Gaps no vendor-native system fills:
  - Cross-vendor policy: a single rule set for Claude Code, Codex, Cursor and Copilot together.
  - Undo beyond local files: shell side effects, MCP or SaaS actions, and email.
  - Signed, tamper-evident receipts.
  - A single approval inbox spanning multiple agents and multiple machines.
- Mobile approval exists for Claude Code and Codex, but each runs in its own app and pairs per host/process. A user running both agents on two machines has at least two approval surfaces, each with its own pairings.
- OpenClaw's gateway/node model comes closest to "one control plane, many machines", but it covers OpenClaw only, its default is permissive (`full`), and it has no audit log.

### Gaps
- I could not fetch or confirm these: Cursor checkpoints/hooks/background-agent specifics; Copilot CLI hooks; the contents of Codex's "Compliance API and audit events" page; the Codex remote launch date.
- Gemini CLI and Copilot firewall details come from search summaries, not full fetches.
- I did not verify the date the Claude Code `auto` mode launched.

## Q2. Third-party security, guardrail, gateway, identity and sandbox products: pricing and target

### Takeaway
The third-party market is overwhelmingly enterprise and has consolidated through acquisitions by large security vendors (2025–2026). Coverage of coding agents on endpoints now mostly works by plugging into vendors' native hooks or OTel (Zenity, Lasso), or through an endpoint agent (Operant), rather than by building its own sandbox. MCP gateways (Docker, Cloudflare, Kong, Lunar) add policy and audit to tool traffic but don't see local shell or file actions. Tailscale Aperture is the main product aimed at individuals and homelab users that spans a user's machines (its tailnet). Identity vendors (Okta XAA, Aembit, Auth0, Arcade) handle delegated credentials and scoped tokens for SaaS and API access, not local actions.

### Cited Findings

**Consolidation: acquisitions (prices from a tracker citing SEC filings; verify against filings)**

| Target | Acquirer | Date | Price | Source |
|---|---|---|---|---|
| Invariant Labs (ETH Zurich spin-off; named "tool poisoning" and MCP "rug pulls") | Snyk | 2025-06-24 | undisclosed | [M&A tracker](https://guptadeepak.com/agent-security/deals/) (search summary) |
| Protect AI | Palo Alto Networks | completed July 2025 | ~$634.5M | [M&A tracker](https://guptadeepak.com/agent-security/deals/) |
| Prompt Security | SentinelOne | announced 2025-08-05 | ~$160.2M | [M&A tracker](https://guptadeepak.com/agent-security/deals/) |
| Pangea | CrowdStrike | announced 2025-09-16 | ~$222.7M | [SiliconANGLE](https://siliconangle.com/2025/09/16/crowdstrike-check-point-extend-ai-security-capabilities-new-acquisitions/) |
| Lakera | Check Point | announced 2025-09-16 | ~$201.8M (another source says ~$300M) | [SiliconANGLE](https://siliconangle.com/2025/09/16/crowdstrike-check-point-extend-ai-security-capabilities-new-acquisitions/) |
| Astrix Security (agent control plane / NHI) | Cisco | completion reported 2026-05-04 | ~$400M per Israeli press, unconfirmed by Cisco | [search summary](https://accuroai.co/blog/nhi-vendor-landscape-2026) |

- Products acquired this way are no longer sold standalone. Prompt Security ships inside SentinelOne Singularity "by quote", and Pangea sells only within CrowdStrike Falcon. — [M&A tracker](https://guptadeepak.com/agent-security/deals/)

**Coding-agent and endpoint runtime control (enterprise; vendor-stated claims)**
- **Zenity.** Enforces through native agent hooks plus its MCP gateway. It can block or modify a dangerous tool call before it runs, and covers Claude Code, Cursor, Codex and Copilot. It normalizes telemetry from OTel and native hooks with "no endpoint sensor required". It offers a Claude Enterprise runtime-control integration and a Cursor Marketplace listing. A roundup says hooks plus gateway reached GA in July 2026. — [Zenity coding agents](https://zenity.io/use-cases/agent-type/coding-personal-agents); [Zenity for Claude Enterprise](https://zenity.io/blog/zenity-launches-universal-runtime-control-for-claude-enterprise); [Zenity for Cursor](https://zenity.io/blog/zenity-joins-the-cursor-marketplace)
- **Lasso Security.** Attaches to lifecycle hooks and is deployed through the enterprise management platform, with "no agent to install". Covers Claude Code, Cursor, Codex and OpenCode. — [Lasso AI coding assistants](https://www.lasso.security/use-cases/ai-coding-assistants)
- **Operant AI.** An MCP gateway plus an endpoint agent for Claude Code, Cursor and Copilot. Allows, blocks or redacts in real time and scans installs before they run. — [Operant code agents](https://www.operant.ai/solutions/code-agents)
- **Pillar Security** publishes a buyer's guide for "Claude Code, Cursor, Codex and Local AI Agents" (it is a competitor in the space). — [Pillar blog](https://www.pillar.security/blog/best-ai-coding-agent-security-tools-for-the-enterprise-2026)
- I found no public pricing for Zenity, Lasso, Operant or Pillar. All are sold to enterprises.

**MCP gateways with policy**
- **Docker MCP Gateway.**
  - The open-source gateway has flags `--verify-signatures --log-calls --block-secrets`, plus pre-call and post-call interceptors.
  - Enterprise policy is written in Cedar ("forbid overrides permit") and includes an approval mode for sensitive calls.
  - Docker AI Governance scopes secrets to a session and blocks exfiltration.
  - Inside Docker Sandboxes the agent can reach only the gateway, but local stdio servers still run on the host.
  - Per-user SSO and SIEM audit events require the paid Enterprise Gateway. Geekflare reported two critical advisories in July 2026 and notes that releases are still pre-release.
  - Sources: [Docker blog](https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/); [Docker MCP policy reference](https://docs.docker.com/ai/governance/reference/mcp-policy/); [Docker Sandboxes MCP gateway](https://docs.docker.com/ai/sandboxes/mcp-gateway/); [Geekflare review](https://geekflare.com/open-source/docker-mcp-gateway/); [Docker AI Governance blog](https://www.docker.com/blog/docker-ai-governance-unlock-agent-autonomy-safely/)
- **Cloudflare MCP server portals.**
  - They put multiple MCP servers behind one URL protected by Cloudflare Access. Per-user server access is enforced "regardless of the underlying server's authorization policies".
  - The GA release (changelog of 2026-09-24) added HTTP logging, DLP scanning and Code Mode policies.
  - Portals live in Cloudflare One (Zero Trust), separate from Cloudflare AI Gateway.
  - Sources: [Cloudflare changelog](https://developers.cloudflare.com/changelog/post/2026-09-24-mcp-portals-ga/); [Cloudflare blog](https://blog.cloudflare.com/zero-trust-mcp-server-portals); [WorkOS comparison](https://workos.com/blog/mcp-gateways-compared)
- **Kong AI Gateway.** Includes an MCP proxy and an AI MCP OAuth2 plugin (Gateway 3.12+). An MCP Registry was added to Konnect in February 2026. Tool-level authorization usually needs custom plugins. — [WorkOS comparison](https://workos.com/blog/mcp-gateways-compared); [DEV roundup](https://dev.to/grove_chatforest/api-gateway-mcp-servers-kong-apisix-cloudflare-envoy-and-beyond-4i45)
- **Envoy AI Gateway.** I found only one secondary source (session-aware MCP load balancing, OAuth). Unverified.
- **Lunar MCPX.** Claims per-agent RBAC, approval workflows, DLP and an immutable audit trail. A reviewer could not find org-level policy or approval workflows in Lunar's public docs as of 2026-06-09. — [StackOne comparison](https://www.stackone.com/blog/best-mcp-gateways/)

**Tailscale Aperture**
- **Timeline and positioning.**
  - Private alpha 2026-01-27, then self-serve 2026-03-23, public beta 2026-04-23 and GA 2026-08-26.
  - The GA post is aimed at "individuals and homelab users".
  - Sources: [private alpha](https://tailscale.com/blog/aperture-private-alpha); [self-serve](https://tailscale.com/blog/aperture-self-serve); [public beta](https://tailscale.com/blog/aperture-public-beta); [GA](https://tailscale.com/blog/aperture-ga)
- **What it does at GA.**
  - It began as an LLM proxy, so agents don't need their own API keys, and now also proxies MCP and APIs.
  - It sets default tool permissions across chats, which projects can expand or restrict.
  - Tailscale ACLs still bind Aperture and its agents.
  - New MCP endpoints, Tailscale and Tailscale SSH, let coding agents add nodes to the tailnet and SSH into them. The user approves each machine.
  - "All agent actions are logged."
  - Source: [Tailscale blog: Aperture GA](https://tailscale.com/blog/aperture-ga)
- **Pricing.** The beta was "included for users on our Personal plans". The FAQ says there is no published pricing during alpha and beta. The GA post mentions starter tokens, token purchases and bring-your-own keys, but no tier prices. — [public beta](https://tailscale.com/blog/aperture-public-beta); [Aperture page](https://tailscale.com/aperture)

**Agent identity and authorization**
- **Okta Cross App Access (XAA).** Built on the IETF ID-JAG draft. Agent SSO reportedly went GA on 2026-08-24, included in core Okta SSO plans. — search summary of [Aembit press release](https://aembit.io/press-release/aembit-launches-support-for-okta-cross-app-access-extending-enterprise-identity-controls-to-ai-agents/) and [Substack](https://theaieconomy.substack.com/p/identity-for-ai-agents-okta-cross-app-access). The GA date is not verified from an Okta primary source.
- **Aembit.** On 2026-09-22 announced XAA support and an "Enterprise-Managed Authorization Credential Provider", which implements the MCP enterprise-managed authorization extension. — [Aembit press release](https://aembit.io/press-release/aembit-launches-support-for-okta-cross-app-access-extending-enterprise-identity-controls-to-ai-agents/)
- **Auth0 for AI Agents.** Offers Token Vault, CIBA-based asynchronous approval (out-of-band human approval) and fine-grained authorization. GA was reportedly October 2025. Sources disagree on whether XAA is shipped. — [Arcade comparison](https://www.arcade.dev/blog/best-ai-agent-authentication-platforms/) (a competitor's blog)
- **Arcade.dev.** A tool-calling runtime with an automated token vault and delegated user auth. Source is its own marketing. — [Arcade blog](https://www.arcade.dev/blog/best-ai-agent-authentication-platforms/)
- Not researched in this pass: Oso, Permit.io, Cerbos and Composio. No findings.

**Cloud sandboxes (developer- and usage-priced)**
- **Per-vCPU-hour rates.** One comparison lists E2B and Daytona at ~$0.0504 per vCPU-hour, Modal Sandboxes at ~$0.0710 and Beam at $0.0675. — [Fly.io pricing comparison](https://fly.io/learn/ai-sandbox-pricing/); [Upstash comparison](https://upstash.com/blog/ai-agent-sandbox-providers-compared-2026)
- **Fixed fees.** E2B Pro reportedly has a $150/month base fee. Daytona has none. — [Fly.io](https://fly.io/learn/ai-sandbox-pricing/); [Beam: E2B pricing](https://www.beam.cloud/blog/e2b-pricing-explained)
- **Modeled cost.** For 100 sandbox-hours at 2 vCPU / 4 GB, E2B costs $16.56, Daytona $16.56 and Modal $23.79. — [Fly.io](https://fly.io/learn/ai-sandbox-pricing/)
- **Modal.** The only option where a sandbox can hold a GPU. — [Upstash](https://upstash.com/blog/ai-agent-sandbox-providers-compared-2026)
- **Microsandbox.** A self-hosted libkrun microVM with no platform fee. — [Upstash](https://upstash.com/blog/ai-agent-sandbox-providers-compared-2026)
- These are third-party figures and they disagree. Verify on vendor pages.

### Inferences
- Enterprise buyers are served by many vendors, now mostly inside large platforms (Palo Alto, SentinelOne, CrowdStrike, Check Point, Snyk, Cisco).
- Pricing for individual developers and prosumers is nearly absent. The exceptions are Tailscale Aperture (free or included for Personal plans), open-source Docker MCP Gateway and usage-priced cloud sandboxes.
- Hook-based vendors (Zenity, Lasso) depend on each coding agent's native hook APIs. Their cross-agent coverage is real, but it is limited by those hooks and inherits the vendors' limits: no undo, and no coverage of non-hook surfaces such as computer use.
- MCP gateways and identity products govern remote tool and API calls, not local shell, file or GUI actions. Cloud sandboxes protect by moving work off the user's machine, the opposite of governing the user's own computers.

### Gaps
- No public pricing for Zenity, Lasso, Operant, Pillar, Lunar or Docker Enterprise Gateway.
- Aperture's GA pricing tiers are not published.
- Not researched: Oso, Permit.io, Cerbos, Composio, Apigee and Microsoft (Entra Agent ID, Copilot Studio controls). These remain gaps.

## Q3. Products specifically for agent undo/rollback and tamper-evident audit

### Takeaway
Commercial "agent undo" is rare. Rubrik Agent Rewind (an established data-protection vendor, enterprise) is the most concrete product: an immutable activity record plus selective rollback. Otherwise undo exists only as file checkpoints inside individual agents (Claude Code, Gemini CLI). Signed, hash-chained "agent receipts" are an active 2026 niche of open-source projects, small startups and research, not a mainstream product category, and no major agent vendor ships them.

### Cited Findings
- **Rubrik Agent Rewind.** Pairs an immutable record of agent activity with selective rollback, positioned for GDPR and EU AI Act compliance. — [Rubrik](https://www.rubrik.com/insights/ai-issues-take-control-with-rubrik-agent-rewind) (search summary; the page returned 403 on fetch, so launch date, integrations and pricing are unverified)
- **The limits of undo, per practitioner writing.**
  - There is usually "no universal undo button" once an agent has changed an external system. — [Sekin](https://sekin.in/can-you-undo-an-ai-agents-actions-what-actually-reverses-a-tool-call/)
  - Suggested patterns: capture prior state and transaction IDs per action ([Moring](https://www.moring.ai/topics/asset-mgmt-audit-trail-rollback-paths/)); classify actions as reversible, costly or irreversible ([agentsuse](https://agentsuse.com/guides/agent-actions-reversibility-undo-plan)); keep soft deletes and write-ahead logs ([TianPan](https://tianpan.co/blog/2026/04/20/ai-agent-data-rollback-production)).
- **Signed and receipt projects.** These include agentic-receipts on GitHub (Ed25519-signed receipts with input and output hashes), Agent Receipts, Obsigna, TrustNotch and Signet. — [agentic-receipts](https://github.com/0rlych1kk4/agentic-receipts); [agentreceipts.ai](https://agentreceipts.ai/); [obsigna.dev](https://obsigna.dev/); [TrustNotch on DEV](https://dev.to/sandro_chekalov/trustnotch-tamper-evident-audit-logs-for-ai-agents-that-your-agent-can-sign-up-for-by-itself-493); [Signet on DEV](https://dev.to/willamhou/how-i-built-cryptographic-signing-for-every-ai-agent-tool-call-1f6a)
- **Research.** "Notarized Agents" proposes receiver-attested receipts and notes that hash chains don't prove completeness: an operator can withhold receipts. — [arXiv 2606.04193](https://arxiv.org/html/2606.04193)
- **Standards.** The OWASP agentic Top 10 recommends "immutable and signed audit logs of all agent actions". Whether signing is required under EU AI Act Article 12 is opinion, not settled law. — [Gravity blog](https://gravity.fast/blog/ai-agent-audit-trails/); [agentpatterns.ai](https://agentpatterns.ai/security/cryptographic-governance-audit-trail/)
- **Vendor audit today.**
  - Codex: opt-in OTel events (`codex.tool_decision`).
  - OpenClaw: approval-ID lifecycle messages and a grant ledger.
  - Aperture: "All agent actions are logged".
  - Docker Enterprise Gateway: SIEM audit.
  - None documents cryptographic tamper evidence.
  - Sources: [Codex](https://learn.chatgpt.com/docs/agent-approvals-security); [OpenClaw](https://docs.openclaw.ai/tools/exec-approvals); [Aperture GA](https://tailscale.com/blog/aperture-ga); [Geekflare on Docker](https://geekflare.com/open-source/docker-mcp-gateway/)

### Inferences
- Cross-agent undo, especially for non-file actions, and tamper-evident receipts are the least-served capabilities among the six.
- Existing receipt projects are libraries or SaaS loggers. None binds receipts to an approval decision across multiple agents and machines.

### Gaps
- Not verified: Rubrik Agent Rewind's GA date, the platforms it supports and its pricing.
- No other funded "agent undo" startups were found in this pass. A targeted search could still surface some, so absence is not proven.
- Traction and funding of the receipt startups are unknown.

## Q4. Who covers the user's own personal computers, across machines and across agents?

### Takeaway
There is no documented commercial product that provides all six capabilities vendor-neutrally across many agents and across a user's multiple personal machines. Partial overlaps:
- **Claude Code** (Remote Control, cross-session messaging) and **Codex** (pair the phone with each host) offer multi-machine approval, but each covers only its own agent.
- **OpenClaw** has per-node approvals from one gateway, but only for itself.
- **Tailscale Aperture** spans a user's tailnet machines with key brokering, tool defaults and logging, but it is an AI gateway, not an approval, undo or sandbox layer for local agents.
- **Zenity, Lasso and Operant** cover many coding agents on endpoints through hooks, but they target enterprises, not individuals, and offer no undo.

### Cited Findings
- **Claude Code.**
  - Remote Control: execution stays local, and the user approves from phone or web.
  - "Cross-session messaging … carries messages between your own sessions on different machines".
  - Single vendor. Requires a claude.ai subscription.
  - Source: [Claude Code Remote Control doc](https://code.claude.com/docs/en/remote-control)
- **Codex.** "You pair your phone with each host you want to control". A desktop can "Control other devices". SSH hosts are supported. Single vendor. — [Codex remote connections](https://learn.chatgpt.com/docs/remote-connections)
- **OpenClaw.** Approvals are enforced on each node host and edited remotely with `--node`. — [OpenClaw exec approvals](https://docs.openclaw.ai/tools/exec-approvals); [OpenClaw CLI approvals](https://docs.openclaw.ai/cli/approvals.md)
- **Tailscale Aperture.** Aimed at individuals and homelab users. Spans tailnet nodes, uses per-machine approval to join the tailnet, sets tool permission defaults, applies ACLs and logs all agent actions. — [Aperture GA](https://tailscale.com/blog/aperture-ga)
- **Zenity.** Cross-agent hooks and OTel for Claude Code, Cursor, Codex and Copilot, with "no endpoint sensor". — [Zenity](https://zenity.io/use-cases/agent-type/coding-personal-agents)
- **Operant.** An endpoint agent for Claude Code and Cursor. — [Operant](https://www.operant.ai/solutions/code-agents)
- **Enterprise policy is managed per vendor.** Copilot's managed permissions apply only to Copilot surfaces ([GitHub changelog](https://github.blog/changelog/2026-09-09-enterprise-managed-permissions-for-github-copilot-agent-operations)). Claude Code has its own managed settings ([Claude Code permissions](https://code.claude.com/docs/en/permissions)). Codex has its own managed configuration ([Codex](https://learn.chatgpt.com/docs/agent-approvals-security)).
- **Gateway-level endpoint reach.** One guide describes a "level five" of governance that extends gateway policy "to every machine in the organization", including desktop apps and coding agents. This is an aspirational, enterprise-framed description, not a specific product claim. — [Maxim: best MCP gateways](https://www.getmaxim.ai/articles/best-mcp-gateways-in-2026-compared-by-deployment-model-and-governance-depth/)

### Inferences
- **The open position:** a vendor-neutral, individual- or prosumer-oriented layer that combines:
  - one approval inbox, including mobile, for Claude Code, Codex, Cursor, Copilot CLI, Gemini CLI, OpenClaw and MCP clients;
  - one policy expressed once and compiled into each agent's native rules or hooks;
  - cross-machine coverage of the user's own laptops and desktops;
  - signed receipts;
  - undo beyond files.
- **Biggest competitive threats** to such a layer:
  - Anthropic and OpenAI extending their own multi-machine remote approval.
  - Tailscale Aperture expanding from a gateway into local approvals.
  - Zenity or Lasso shipping a prosumer tier.
- **Technical feasibility.** Every major agent now exposes hooks or managed policy (Claude Code hooks, Codex rules and approvals_reviewer, Copilot managed permissions, Gemini policy engine, OpenClaw exec approvals). That makes a cross-agent adapter layer technically feasible, which is exactly how Zenity and Lasso already work for enterprises.

### Gaps
- Not found: any consumer or prosumer product marketed as "one approval app for all my coding agents across my machines". Search coverage of small open-source or indie projects (GitHub, HN, Product Hunt) was limited in this pass, so small projects in this exact niche may exist.
- Not confirmed: whether Zenity or Lasso offer any individual or self-serve tier.
