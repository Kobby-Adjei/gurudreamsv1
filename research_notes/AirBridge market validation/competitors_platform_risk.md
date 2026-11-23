# Competitors and Platform Risk: cross-machine handoff between local AI coding agents (MCP over a private encrypted P2P network)

Research date: 2026-11-23. About 17 search/fetch calls. Official docs (code.claude.com, learn.chatgpt.com / developers.openai.com, cursor.com, tailscale.com) were preferred. Many third-party sites in this space are SEO comparison blogs with forward-dated or conflicting details; those are flagged. Items marked "[unverified / background knowledge]" were not confirmed by a source in this session.

## Q1. Official vendor features (late 2026): which already cover cross-device task handoff, and at what price?

### Takeaway
Anthropic now ships most of the core idea natively, but only for Claude Code: Remote Control plus cross-session messaging lets one Claude Code session message your own sessions on other machines or in the cloud, and Claude Projects can run a "thread" on a folder of your computer. OpenAI Codex has task and Git-state handoff between your computer and connected hosts. Cursor has local-to-cloud handoff and self-hosted machines. All of these are single-vendor, routed through the vendor's servers, and tied to subscription sign-in. None found bridges Claude to Codex to Cursor.

### Cited Findings
**Anthropic / Claude Code**
- Remote Control connects claude.ai/code or the Claude iOS/Android app to a Claude Code session running on your machine. Execution, filesystem, local MCP servers and tools stay local. Available on Pro, Max, Ultra, Team, Enterprise; API keys not supported; Team/Enterprise owners must enable it. — [Claude Code docs: Remote Control](https://code.claude.com/docs/en/remote-control)
- Transport: the local session makes outbound HTTPS only and never opens inbound ports. It registers with the Anthropic API, polls for work, and Anthropic servers route messages. The transcript is stored on Anthropic servers while connected. Zero Data Retention and HIPAA-configured orgs cannot enable Remote Control. Using a custom `ANTHROPIC_BASE_URL` / LLM gateway disables it. — [Remote Control: connection and security](https://code.claude.com/docs/en/remote-control)
- **Cross-session messaging (most direct overlap):** "Let Claude list and message your other Claude Code sessions on this machine, and reach your sessions on other machines or in the cloud." Claude finds targets with `ListAgents` and sends with `SendMessage`. Same-machine messages go over a local Unix socket or named pipe. Messages to another of your machines go "Through Anthropic servers, arriving over that machine's Remote Control connection." Cross-machine requires v2.1.225+. Messaging is on by default (v2.1.224+ macOS/Linux; v2.1.234+ native Windows). — [Claude Code docs: cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md)
  - Limits that leave gaps: plain text only ("never the sender's conversation history or files"). Cloud sessions cannot reply cross-machine. Cross-machine needs claude.ai sign-in, so it does not work with API keys, Bedrock, Vertex, or Foundry. A session in a container and one on the host cannot reach each other. Loop throttling applies. `isolatePeerMachines` requires approval before a message leaves the machine. — same source
- Claude Projects (public beta on Pro/Max/Ultra, not Team/Enterprise yet, gradual rollout): a coordinator conversation spawns parallel threads, usually cloud sessions. You can "run a thread on your own computer": you expose a folder via the desktop app ("Use this computer from your phone and claude.ai") or `claude remote-control`, which needs v2.1.280+. The thread runs in auto mode in that folder. It pauses when the computer sleeps. — [Claude Code docs: Projects](https://code.claude.com/docs/en/claude-projects.md)
- Teleport (`claude --teleport` / `/teleport`) pulls a cloud session into the local terminal. Cloud sessions run on Anthropic infrastructure and are started from claude.ai/code, the app, or `claude --cloud`. Not available on Bedrock, Vertex, or Foundry. — [Claude support: power user tips](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips); [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- Other surfaces listed in the docs: Dispatch (message a task from the phone, runs on Desktop; "isn't available to new users"), Channels (push Telegram/Discord/server events into a CLI session), self-hosted environments (cloud sessions on your org's runners, Team/Enterprise), and scheduled tasks. — [Remote Control docs comparison table](https://code.claude.com/docs/en/remote-control)
- Agent View (`claude agents`, shipped May 11, 2026) is a terminal dashboard of local and background sessions. Third-party summary: cloud sessions "cannot access local files, git, MCP servers, or terminal tools." — [First AI Movers guide, May 22, 2026](https://radar.firstaimovers.com/claude-code-remote-control-dispatch-multi-device-guide-2026) (secondary)
- Boris Cherny (Claude Code lead) promoted moving sessions between mobile, web, desktop and terminal via teleport and remote-control. — [Threads post](https://www.threads.com/@boris_cherny/post/DWfjo22FKJ4/move-sessions-back-and-forth-between-mobile-web-desktop-and-terminal-run-claude)

**OpenAI Codex**
- Remote connections: pair the phone or another desktop with each host. Hosts run the ChatGPT desktop app on macOS or Windows. SSH hosts are added from `~/.ssh/config`. Handoff moves a chat and its Git state between your computer and a connected host (a worktree is created or reused on the destination). Handoff to Codex cloud is not supported. A "secure relay layer" keeps machines reachable, and the docs recommend a VPN or mesh tool for access from outside your network. Workspace admins may need to enable it. No specific plan tier is named. — [Codex docs: Remote connections](https://learn.chatgpt.com/docs/remote-connections) (redirected from developers.openai.com/codex/remote-connections)
- From the CLI you can launch Codex Cloud tasks and pull results back with `codex apply <TASK_ID>`. — [Scrimba guide](https://scrimba.com/articles/how-to-use-openai-codex/) (secondary)
- Open GitHub issue (April 2026) requests native local-CLI-to-cloud session handoff. Status beyond a "remote" label was not confirmed. — [openai/codex #19657](https://github.com/openai/codex/issues/19657)

**Cursor**
- Cursor 3 (April 2026) added local-to-cloud handoff. Background Agents were renamed Cloud Agents. — [The Rundown: Cursor 3](https://www.therundown.ai/tools/cursor-3); [Morph guide](https://www.morphllm.com/cursor-background-agents) (secondary)
- Self-hosted cloud agents launched March 2026, letting agents run on your own infrastructure. — [Cursor blog](https://cursor.com/blog/self-hosted-cloud-agents); [Cursor changelog](https://cursor.com/changelog/self-hosted-machines)
- Week of Oct 19, 2026 release notes: agents on self-hosted machines can be opened from the desktop app with files, terminal, and forwarded ports; admins can set a default pool. — [Cursor cloud agents release notes](https://cursor.com/docs/release-notes/cloud-agents)
- Sept 2, 2026 (third-party): team-wide worker pools plus backends (AWS Lambda, Cloudflare, Coder, Daytona, E2B, Modal, Namespace, Vercel). Not confirmed on Cursor's own changelog. — [DevX](https://www.devx.com/artificial-intelligence-ai/self-hosted-cloud-agents-cursor-worker-pools/); [Developer-Tech](https://www.developer-tech.com/news/cursor-self-hosted-cloud-agents/)
- "Projects" beta (Sept 10, 2026 per third party): a coordinator agent hands work to parallel cloud and local agents. — [The Rundown: Cursor Agents](https://www.therundown.ai/tools/cursor-agents) (secondary, unverified)
- Pricing (conflicting, secondary). An August 2026 review lists Pro $20, Pro+ $60, Ultra $200, Teams $40/$120 per user, with Cloud Agents billed at model API rates. October 2026 sources describe new tiers: Plus $8, Premium $30 (entry point for cloud agents), Super $100, Ultra $200. — [Omid Saffari review](https://omidsaffari.com/blog/cursor-review); [The Rundown](https://www.therundown.ai/tools/cursor-agents)

**GitHub Copilot coding agent**
- Each coding agent session consumes premium requests (times a model multiplier) plus GitHub Actions minutes. Steering comments also count. — [GitHub docs: premium requests](https://docs.github.com/en/billing/concepts/product-billing/github-copilot-premium-requests); [GitHub changelog, July 2025](https://github.blog/changelog/2025-07-10-github-copilot-coding-agent-now-uses-one-premium-request-per-session/)
- Copilot is moving to usage-based billing with "GitHub AI Credits". Monthly Pro/Pro+ users migrated June 1, 2026. — [GitHub blog](https://github.blog/news-insights/product-news/github-copilot-is-moving-to-usage-based-billing/)
- The coding agent runs in GitHub Actions (cloud), not on the user's own workstations [background knowledge; Agent HQ and self-hosted-runner details not confirmed in this session].

### Inferences
- Anthropic's Remote Control plus cross-session messaging plus Projects "run on your computer" is effectively a first-party, Claude-only version of "link my computers so agents hand tasks to each other." The remaining white space is narrower than it looked in 2025:
  1. **Cross-vendor** (Claude to Codex to Cursor to Gemini). No vendor does this.
  2. **No vendor relay / private P2P.** Anthropic and OpenAI route through their servers and store transcripts. Anthropic's feature is unavailable for ZDR, HIPAA, API-key, Bedrock, Vertex, and gateway users.
  3. **Moving code and files, not just text.** Claude's messaging is plain text only. Codex handoff moves Git state, but only between Codex hosts.
- Each vendor has an incentive to keep orchestration inside its own subscription. That makes cross-vendor neutrality the most durable differentiator, and the hardest for any single vendor to copy.

### Gaps
- VS Code Remote Tunnels and JetBrains Gateway were not researched in this session. Background knowledge: Remote Tunnels is free and uses a Microsoft/GitHub relay for remote IDE access, and Gateway is a JetBrains remote-dev client. Neither does agent-to-agent handoff [unverified].
- Codex remote connections' plan tier and current Windows support conflict across OpenAI pages.
- Official Cursor pricing page not fetched; tier names conflict.
- GitHub Agent HQ status not found.

## Q2. Agent-to-agent protocols and MCP transport

### Takeaway
Standards exist for agent interop (A2A v1.0, now under the Agentic AI Foundation) and for remote MCP over HTTP, but they define message formats, not a private network between a user's own machines. That gap is filled today by ad-hoc open-source bridges.

### Cited Findings
- IBM's ACP was folded into A2A under the Linux Foundation in Aug/Sept 2025. ACP development wound down. — [LF AI & Data](https://lfaidata.foundation/?p=7689); [Ry Walker research](https://rywalker.com/research/acp-agent-communication-protocol)
- A2A v1.0 shipped March 2026. More than 150 supporting organizations at the one-year mark (April 2026). — [Linux Foundation press](https://linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year); [Google Open Source Blog](https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html)
- A2A moved to the Agentic AI Foundation (AAIF) in August 2026. AAIF post is dated Aug 17, 2026; Forkast says Aug 20. A2A and MCP remain separate, complementary projects. — [AAIF blog](https://aaif.io/blog/a2a-joins-aaif); [Axios](https://axios.com/2026/08/17/a2a-agentic-ai-foundation-open-ai-standards)
- Tailscale Aperture exposes an MCP gateway endpoint (`/v1/mcp`) that aggregates remote MCP servers. Proxying is labeled alpha and MCP grants experimental per one directory. — [Feluda](https://feluda.ai/mcp-servers/tailscale-aperture); [Tailscale docs: connectors](https://tailscale.com/docs/aperture/connectors)
- Note: "Agent Client Protocol" (Zed's editor-to-agent protocol) is distinct from IBM's ACP. It is used by some local Claude/Codex delegation bridges. — [Ming0429 agent-bridge on Glama](https://glama.ai/mcp/servers/Ming0429/bridge-mcp-server)

### Inferences
- Building on MCP (tools exposed to every agent) plus optional A2A compatibility is aligned with where standards are going. The protocol itself is not a moat. Value sits in the network, identity, pairing, and UX layer.

### Gaps
- Docker MCP Gateway and Cloudflare remote MCP hosting were not researched this session. Background knowledge: both exist (2025) and target hosting or proxying MCP servers, not linking personal machines [unverified].

## Q3. Networking incumbents (Tailscale, ZeroTier, ngrok, Cloudflare Tunnel): do they target AI-agent connectivity?

### Takeaway
Tailscale is the most serious adjacent incumbent. Its Aperture product is an AI gateway that already speaks MCP, uses tailnet identity, and recently added skill sharing across agents. It is aimed at teams' model and tool access, not machine-to-machine agent handoff, but it is one feature away.

### Cited Findings
- Aperture is "a Private AI Platform for Teams." It sits between agents and LLM APIs, works with any coding agent that lets you replace the base URL, and uses Tailscale identity instead of distributing API keys. It can extract MCP and local tool calls from popular agents, with "more fine-grained MCP control" planned. — [Tailscale: AI Gateway use case](https://tailscale.com/use-cases/securing-ai); [aperture.tailscale.com](https://aperture.tailscale.com/)
- Connectors let Aperture reach external MCP servers and HTTP APIs through one authenticated gateway. — [Tailscale docs: Aperture connectors](https://tailscale.com/docs/aperture/connectors)
- Nov 2026: Aperture shares agent skills across users, teams, and agents via its MCP endpoint. It also exposes endpoints for listing and reading a user's LLM sessions. — [Tailscale blog: skill sharing](https://tailscale.com/blog/skill-sharing-with-aperture); [Sulat news, Nov 11, 2026](https://news.sulat.com/2026/11/11/tailscale-aperture-skill-sharing-mcp/)
- Aperture is built on Vercel AI Gateway and Vercel Sandbox. — [Vercel case study](https://vercel.com/customers/how-tailscale-built-a-customer-facing-model-router-on-ai-gateway)
- Third-party claim: Aperture's MCP surface went GA on Aug 26, 2026 with tailnet provisioning and Tailscale SSH tools. This conflicts with the alpha label above. — [Scalekit blog](https://www.scalekit.com/blog/tailscale-mcp-vs-api) (unverified)
- OpenAI's Codex docs explicitly recommend "a VPN or mesh networking tool" for off-network access, which implicitly points users to Tailscale-like tools. — [Codex remote connections](https://learn.chatgpt.com/docs/remote-connections)
- The open-source ethansk/agent-bridge recommends Tailscale for stable 100.x addresses across machines. — [agent-bridge site](https://ethansk.github.io/agent-bridge/)

### Inferences
- Tailscale already has the P2P encrypted mesh, identity, an MCP gateway, and AI-developer mindshare. A "share sessions/tasks between agents on my tailnet" feature would be a short step for Tailscale. It is the highest-risk non-model-vendor competitor, and also a possible partner or acquirer. A product that embeds its own P2P network competes with free Tailscale (personal plan) as the transport. It needs a reason to exist beyond "Tailscale plus an MCP server."

### Gaps
- ZeroTier, ngrok, and Cloudflare Tunnel AI-agent positioning was not researched in this session. Background knowledge: ngrok and Cloudflare both marketed AI/MCP gateway features in 2025 [unverified].
- Tailscale personal-plan pricing was not checked this session.

## Q4. Startups and open-source tools for multi-agent / multi-machine coding-agent orchestration

### Takeaway
The crowded category is same-machine parallel-agent managers (worktrees plus tmux or GUI) and phone remotes for one machine. True cross-machine, cross-vendor agent bridges exist only as tiny open-source projects, which validates the idea but shows no traction yet.

### Cited Findings
**Cross-machine, cross-vendor bridges (closest direct competitors)**
- **Latth/agent-bridge**: lets coding agents on different machines work together over an encrypted bridge (Claude Code, Codex, Gemini CLI, Cursor, Copilot via CLI or MCP server). Host relay plus ngrok HTTPS or `--lan`. One-time pairing code. AES-256-GCM end to end. MIT, zero dependencies, v1.6.0. **2 stars, 0 forks** when fetched. — [GitHub](https://github.com/Latth/agent-bridge)
- **ethansk/agent-bridge** (v4.10.1): pushes messages into running agent sessions across machines. Claude Code via a `claude/channel` MCP plugin, Codex (verified with 0.145.0), and OpenClaw are live; Gemini CLI and Aider are scaffolded. P2P over SSH/SFTP with ED25519 keys, no broker; recommends Tailscale off-LAN. Warns pairing grants full shell access by default. License is inconsistent (MIT badge vs "Apache 2.0 + Commons Clause"). — [agent-bridge site](https://ethansk.github.io/agent-bridge/)
- Same-machine or hosted variants: Claude Bridge (Claude Code and Codex via a local SQLite task board), Ming0429 agent-bridge (Agent Client Protocol, local), PeerBridge MCP (local-first coordination), BridgeMCP by BridgeMind (hosted shared task board across Cursor and Claude Code), and claude-mcp-bridge / cursor-mcp-bridge (wrap a CLI agent as an MCP tool). — [Glama: claude-bridge](https://glama.ai/mcp/servers/RajeshMadanu/claude-bridge); [PeerBridge](https://baeseokjae.github.io/posts/peerbridge-mcp-coordination-2026/); [BridgeMCP](https://www.bridgemind.ai/bridgemcp); [cursor-mcp-bridge](https://github.com/JaimeJunr/cursor-mcp-bridge); [claude-mcp-bridge](https://github.com/hampsterx/claude-mcp-bridge)

**Parallel-agent managers (single machine)**
- Claude Squad: terminal, tmux plus a git worktree per agent, AGPL-3.0. Activity status conflicts across sources (one says the last release was Aug 20, 2026). — [Augment Code roundup](https://www.augmentcode.com/tools/open-source-agent-orchestrators); [crystl.dev](https://crystl.dev/blog/best-ai-agent-orchestration-tools/)
- Vibe Kanban: kanban board for many agents. Its site says it is "sunsetting" and will continue as a community-maintained open-source project. — same roundups
- Conductor: closed-source Mac app with a free tier and paid plans with cloud workspaces. — same roundups
- Crystal: deprecated February 2026, replaced by Nimbalyst (MIT). — [Nimbalyst blog](https://nimbalyst.com/blog/best-agent-management-tools-2026/)
- Sculptor (Imbue): per-agent isolation (sources disagree on worktree vs Docker), MIT, no Windows build. — [Augment Code roundup](https://www.augmentcode.com/tools/open-source-agent-orchestrators)

**Phone remotes for one machine**
- Happy (Happy Coder): free and open source, iOS app for Claude Code and Codex. Relay sees only encrypted blobs (TweetNaCl). Launched via Show HN. — [Happy FAQ](https://happy.engineering/docs/faq); [GitHub slopus/happy](https://github.com/slopus/happy); [App Store](https://apps.apple.com/app/id6748571505); [Show HN](https://hn.svelte.dev/item/44904039). A fork called "Happier" exists. — [EveryDev](https://www.everydev.ai/tools/happier)
- Omnara (YC): mobile-first control of Claude Code. Claims it keeps work moving even when the laptop goes offline. A third party reports "free unlimited sessions," unverified. — [YC page](https://ycombinator.com/companies/omnara); [SeaWork comparison](https://seawork.ai/en/blogs/omnara-vs-happy-vs-seawork/)

### Inferences
- Anthropic's free first-party Remote Control and mobile Code tab directly commoditize the Happy and Omnara phone-remote category. Vibe Kanban sunsetting and Crystal's deprecation suggest wrapper tools get squeezed once vendors ship native features.
- Two independent hobby projects building the exact cross-machine, cross-vendor MCP bridge suggest real developer pull. Their near-zero traction (2 stars) suggests the pain is niche, or that packaging, trust, and security are the hard parts.

### Gaps
- Terragon was not researched. Background knowledge: Terragon was a cloud background-agent service for Claude Code; its current status is unknown [unverified].
- Star counts and traction for Claude Squad, Conductor, Vibe Kanban, Happy, and Omnara were not fetched. Conductor and Omnara pricing was not confirmed.

## Q5. User complaints about these alternatives

### Takeaway
Direct complaint evidence was thin in this session. The documented constraints, though, map onto the product's pitch: cloud sessions lose local resources, vendor features need a subscription sign-in and vendor-relayed transcripts, hosts must stay awake, and pricing is usage-metered and confusing.

### Cited Findings
- Claude cloud sessions don't have the skills, MCP servers, plugins, and tools installed only on your machine. Project permission rules and hooks in `.claude/settings.json` are not applied in cloud threads. — [Claude Projects docs](https://code.claude.com/docs/en/claude-projects.md)
- Remote Control stores transcripts on Anthropic servers. It is unavailable for ZDR, HIPAA, API-key, and LLM-gateway users, and it goes offline when the local process stops or the machine sleeps. — [Remote Control docs](https://code.claude.com/docs/en/remote-control)
- Codex hosts must stay awake, online, and signed in. A Mac with the lid closed needs an external display. Pairings unused since June 8, 2026 must be re-paired. — [Codex remote connections](https://learn.chatgpt.com/docs/remote-connections)
- Parallel sessions draw from one usage pool and hit rate limits sooner (about 3–5 parallel sessions sustainable on Max, per a third party). — [First AI Movers](https://radar.firstaimovers.com/claude-code-remote-control-dispatch-multi-device-guide-2026)
- Copilot's coding agent consumes premium requests and Actions minutes, and billing moved to usage-based AI Credits in 2026. Third-party overage figures conflict ($0.04/request vs $0.01/credit). — [GitHub blog](https://github.blog/news-insights/product-news/github-copilot-is-moving-to-usage-based-billing/); [Tech Insider](https://tech-insider.org/github-copilot-ai-credits-pricing-2026/)
- Cursor pricing churn: tier names and prices conflict across 2026 reviews. Daily agent users reportedly spend $60–$100/month. — [The Rundown](https://www.therundown.ai/tools/cursor-agents); [Morph](https://www.morphllm.com/cursor-background-agents) (secondary)
- Security concern in DIY bridges: ethansk/agent-bridge pairing grants full shell access by default. — [agent-bridge](https://ethansk.github.io/agent-bridge/)

### Inferences
- The strongest wedge pains are privacy (no vendor relay or transcript storage, usable under ZDR or regulated rules), mixing vendors (Claude on a Mac, Codex on a Linux GPU box, Cursor on Windows), and using specific local resources (GPU, OS-specific toolchains, simulators, VPN-only APIs). Anthropic's own "run a thread on your computer" pitch explicitly names local databases, device emulators, and VPN-bound APIs. That validates the need, and also shows Anthropic is serving it.

### Gaps
- No Hacker News or Reddit complaint threads were gathered for Remote Control, Codex remote, Happy, or Omnara. That needs a dedicated pass.

## Q6. Platform risk: will Anthropic, OpenAI, Cursor, GitHub/Microsoft, or Tailscale ship this natively?

### Takeaway
For single-vendor use, the risk is no longer hypothetical: Anthropic (cross-session messaging across machines, Projects local threads) and OpenAI (Codex host-to-host handoff) have already shipped it, and Cursor is close (local/cloud handoff, self-hosted machines, coordinator Projects). The residual opportunity is cross-vendor, self-hosted or P2P, and privacy-first. Tailscale is the most likely incumbent to ship a neutral version.

### Cited Findings (evidence of vendor movement)
- Anthropic: cross-session messaging reaches "your sessions on other machines or in the cloud" (v2.1.225+), on by default. Projects run threads on a user's computer folder (v2.1.280+). Remote Control is on all paid plans. Version numbers moved from v2.1.51 (Remote Control GA requirement) to v2.1.3xx, showing rapid iteration. — [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md); [Projects](https://code.claude.com/docs/en/claude-projects.md); [Remote Control](https://code.claude.com/docs/en/remote-control)
- OpenAI: chat plus Git-state handoff between connected hosts, mobile control, a relay layer, and desktop devices controlling other devices ("Control other devices"). — [Codex remote connections](https://learn.chatgpt.com/docs/remote-connections)
- Cursor: local-to-cloud handoff (Cursor 3, April 2026), self-hosted machines and pools (March–October 2026), coordinator "Projects" across cloud and local agents (Sept 2026, secondary). — [Cursor release notes](https://cursor.com/docs/release-notes/cloud-agents); [The Rundown](https://www.therundown.ai/tools/cursor-agents)
- Tailscale: Aperture AI gateway with an MCP endpoint, connectors, cross-agent skill sharing (Nov 2026), and LLM-session listing endpoints. — [Tailscale blog](https://tailscale.com/blog/skill-sharing-with-aperture); [Tailscale AI Gateway](https://tailscale.com/use-cases/securing-ai)
- GitHub/Microsoft: no evidence found this session of cross-machine local-agent handoff. The coding agent remains cloud/Actions-based. — [GitHub docs](https://docs.github.com/en/billing/concepts/product-billing/github-copilot-premium-requests)

### Inferences (speculation, clearly labeled)
- **Anthropic: very high risk** for Claude-to-Claude use. Already shipped. Likely next steps (speculative): file and diff payloads in messages, and broader Projects availability on Team/Enterprise. Low likelihood of first-class bridging to Codex or Cursor, since it is against their interest.
- **OpenAI: high risk** for Codex-to-Codex. Already shipped host handoff. Cloud handoff is requested in issue #19657.
- **Cursor: medium-high.** It is moving toward a cloud-plus-self-hosted fleet under a Cursor subscription.
- **Tailscale: medium.** It has the network, identity, MCP gateway, and the developer audience. A "tailnet agent mesh" is a natural extension. It is a partner/acquirer candidate as much as a threat.
- **GitHub/Microsoft: low-medium** in the near term. Its focus is the cloud coding agent and Actions billing.
- Defensible positioning, if any: a vendor-neutral layer (MCP tools usable from any agent), data that never touches vendor relays (works for ZDR, regulated, and API-key or Bedrock users who are excluded from Anthropic's feature), moving real artifacts (files, diffs, Git bundles, not just text), and secure-by-default scoped trust (unlike DIY SSH bridges). Being "Claude-only" or a "phone remote" is not defensible.

### Gaps
- No public roadmaps from any vendor explicitly promising cross-vendor agent handoff were found.
- Dates for when Anthropic cross-session messaging first shipped were not pinned down (docs give version numbers only).
