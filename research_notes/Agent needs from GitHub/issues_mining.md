# GitHub issue mining: unmet needs of people building and running AI agents

As of 2026-11-24. Method: GitHub search API (`search/issues`, `search/repositories`) sorted by reactions and comments, run over the main agent repos and across all of GitHub. Raw result tables (TSV: 👍, total reactions, comments, created, state, URL, title) and the exact queries are in `raw/`. All fetched content was treated as untrusted data. Issue bodies were read through search-result `body` fields. The GitHub MCP tools were restricted to this repo, so they could not be used.

**Notation.** "👍" means +1 reactions and "R" means all reactions. "c" is the comment count. Dates are creation dates. State is open, closed/completed, or closed/not_planned, as of the search. **[E]** marks evidence (what users wrote or what the numbers show). **[I]** marks my inference.

**Caveats**
- Reaction counts skew toward Claude Code and Codex because those repos have far more users. A count of 30 in OpenClaw or A2A means more than 30 in claude-code.
- Many claude-code issues were closed as "completed" on 2026-08-17 at about 03:00 UTC, including #6235, #24798 and #15776. That looks like a bulk triage pass. "Closed/completed" does not prove the feature shipped.
- GitHub issue volume itself grew 3.4x, from about 159k titles containing "bug" in 2025Q1 to 543k in 2026Q3. A lot of that is agents filing issues. So the trend numbers below are normalized to that baseline.
- Exact-phrase searches across all of GitHub ("agent wallet", "agent-to-agent") are loose and full of noise, including crypto-bounty spam such as Scottcjn/rustchain-bounties. I used `in:title` searches for trends.

---

## 0. Trend data: share of new GitHub issues whose title mentions the theme

Source: `raw/trend1.tsv`, `raw/trend3.tsv`. 2026Q4 covers only 2026-10-01 to 11-24.

| Theme (title query) | 2025Q1 | 2025Q4 | 2026Q1 | 2026Q2 | 2026Q3 | 2026Q4* | Growth in share, Q1-25 to Q3-26 |
|---|---|---|---|---|---|---|---|
| worktree | 81 | 834 | 5,520 | 13,491 | 34,082 | 33,108 | **~123x** (0.05% to 6.3% of issues) |
| subagent / sub-agent | 43 | 897 | 5,344 | 10,463 | 17,611 | 15,853 | **~120x** |
| agent + audit | 6 | 112 | 840 | 2,609 | 3,628 | 3,342 | **~177x** |
| agent + long-running | 1 | 29 | 141 | 242 | 282 | 212 | ~83x (small n) |
| agent + budget | 7 | 8 | 193 | 593 | 1,655 | 1,734 | ~69x |
| agent + approval | 7 | 29 | 269 | 728 | 1,562 | **2,432** (still rising) | ~65x |
| sandbox + agent | 11 | 69 | 494 | 1,127 | 2,315 | 2,774 (still rising) | ~62x |
| agent payment/wallet/x402 | 26 | 224 | 1,189 | 1,750 | 3,409 | 3,129 | ~38x (noisy: crypto bounties) |
| agent + lock | 9 | 31 | 133 | 382 | 980 | 1,058 | ~32x |
| agent + handoff | 20 | 57 | 240 | 775 | 1,769 | 1,579 | ~26x |
| agent team(s) | 53 | 1,172 | 2,761 | 3,076 | 3,695 | 3,067 | ~20x |
| agent memory | 111 | 278 | 1,600 | 2,984 | 4,229 | 3,860 | ~11x |
| a2a / agent-to-agent | 173 | 808 | 2,670 | 4,424 | 5,898 | 5,878 | ~10x |
| agent identity/auth/credentials | 132 | 133 | 1,256 | 2,319 | 4,154 | 3,830 | ~9x |
| AGENTS.md | 0 | 629 | 2,130 | 5,164 | 13,607 | 13,660 | from 0 |
| mcp | 2,827 | 16,597 | 38,749 | 67,692 | 106,902 | 114,725 | ~11x (now ~20% of all new issue titles) |

**[I]** The step change happened in 2026Q1 for every theme. That matches the arrival of agent teams and subagents in Claude Code (Feb 2026), Codex subagents and Multi-Agent V2 (Feb to Jun 2026), worktree-by-default desktop apps, and Cowork and routines. The fastest-growing themes are the ones that only exist once you run many agents: worktrees, subagents, audit, budget, approvals and sandboxing. Themes that only need a single agent, such as memory and identity, grew more slowly. Approval and sandbox are the only themes still accelerating in Q4.

---

## 1. Candidate needs, with evidence

### N1. Many agents on one codebase need to coordinate: messaging, shared state, conflict and merge control
**One line:** People now run 5 to 20+ agent sessions in parallel, often from different vendors. They have no way to make those agents tell each other things, avoid stepping on each other, or merge the results safely.

| Issue | 👍 / R | c | Created | State |
|---|---|---|---|---|
| [claude-code#24798](https://github.com/anthropics/claude-code/issues/24798) Inter-session communication for multi-Claude workflows | 23 | 85 | 2026-02-10 | closed/completed 2026-08-17 (bulk) |
| [opencode#12661](https://github.com/anomalyco/opencode/issues/12661) Add Agent Teams Equivalent or Better | 119 / 190 | 36 | 2026-02-08 | **closed/not_planned** |
| [gemini-cli#19430](https://github.com/google-gemini/gemini-cli/issues/19430) Parallel Agent Teams / Multi-Agent Collaboration | 44 | 15 | 2026-02-18 | **closed/not_planned** (stale bot) |
| [claude-code#23669](https://github.com/anthropics/claude-code/issues/23669) Agent Teams: per-teammate working dir, CLAUDE.md, MCP configs | 33 | 26 | 2026-02-06 | open |
| [openclaw#40245](https://github.com/openclaw/openclaw/issues/40245) Shared workspace directory for multi-agent setups | 7 | 8 | 2026-03-08 | closed |
| [oh-my-pi#8077](https://github.com/can1357/oh-my-pi/issues/8077) Cross-session messaging between independent sessions (Claude Code parity) | 18 | 10 | 2026-08-09 | open |
| [vscode#311148](https://github.com/microsoft/vscode/issues/311148) Agents App: multi-root workspaces with cross-repo change tracking and worktrees | 50 | 9 | 2026-04-18 | open |
| [vscode#316336](https://github.com/microsoft/vscode/issues/316336) Agent worktree merge-back is unsafe for small changes with existing local edits | 1 | 2 | 2026-05-13 | open |
| [claude-code#28847](https://github.com/anthropics/claude-code/issues/28847) Race condition: .claude.json corruption with multiple instances | 26 | 27 | 2026-02-26 | closed |

Also: worktree-plumbing requests from both vendors: [codex#10599](https://github.com/openai/codex/issues/10599) (78 👍, open), [claude-code#27282](https://github.com/anthropics/claude-code/issues/27282) (74, open), [claude-code#23622](https://github.com/anthropics/claude-code/issues/23622) (89, open), and [codex#26648](https://github.com/openai/codex/issues/26648) jj workspaces (37, open). Many small repos opened issues in Oct to Nov 2026 such as "Parallel agent sessions with worktree isolation and a shared merge-back flow" (raw/out5/gt_worktree_merge.tsv).

**Quotes [E]**
- #24798: "Today I'm running 5 concurrent Claude sessions… These sessions are completely siloed… I have to manually relay information between sessions — copy-pasting context, writing handoff documents to disk." Asks for "Inter-session messaging", a "Shared project scratchpad", and an "Event/notification bus".
- openclaw#40245: "Silent drift — files get updated in one workspace but not others… No single source of truth."
- opencode#48837: the forced V2 UI "destroys productivity for multi-project/multi-agent workflows (20+ sessions)".

**Vendors affected:** all of them: Claude Code, Codex, Gemini/Antigravity, OpenCode, OpenClaw, VS Code Agents, Kiro, Pi.

**Shipped?** Partly, and only inside each vendor. Claude Code has Agent Teams (SendMessage, shared task list, Feb 2026), and this cloud session's own tools include `send_message` between sessions. Codex has Multi-Agent V2 (`spawn_agent`/`send_message`) and `--worktree` (#12862, closed/completed 2026-10-12). OpenCode and Gemini declined (not_planned). No vendor coordinates agents from a different vendor, and none offers a merge or conflict layer across agents.

**Neutral layer needed?** **Yes, strongly.** [I] Third-party projects are filling the gap: OrchestratorInc/agent-orchestrator (15k★, Feb 2026), omnigent (11.5k★, "orchestrate Claude Code, Codex, Cursor, Pi"), johannesjo/parallel-code (1.1k★, "Run Claude Code, Codex, Copilot… in parallel worktrees"), and agentbox and lanes. The issue volume says builders want this. The not_planned closures say vendors outside Anthropic and OpenAI won't build it.

**New in 2026:** yes. Worktree titles went from 81 to 34k per quarter, and the agent-teams requests start in Feb 2026.

---

### N2. Memory and context that survive sessions, devices and tools
**One line:** Agent memory is stuck in one vendor, one machine and one absolute path. Users want project memory and session state that move with them across sessions, machines, surfaces (CLI, desktop, web, mobile) and other agents.

| Issue | 👍 / R | c | Created | State |
|---|---|---|---|---|
| [claude-code#28791](https://github.com/anthropics/claude-code/issues/28791) Sync conversation history between CLI and desktop app | 159 / 192 | 41 | 2026-02-26 | open |
| [claude-code#20697](https://github.com/anthropics/claude-code/issues/20697) Sync Skills between Claude Desktop and CLI | 164 / 173 | 49 | 2026-01-25 | open |
| [opencode#20695](https://github.com/anomalyco/opencode/issues/20695) Memory Megathread | 112 / 173 | 150 | 2026-04-02 | closed |
| [codex#21803](https://github.com/openai/codex/issues/21803) Cross-device sync for Codex Projects and Chats | 65 | 14 | 2026-05-08 | open |
| [claude-code#25739](https://github.com/anthropics/claude-code/issues/25739) Portable project memory across machines | 29 / 50 | 36 | 2026-02-14 | open |
| [claude-code#14227](https://github.com/anthropics/claude-code/issues/14227) Persistent Memory Between Claude Code Sessions | 10 | 38 | 2025-12-16 | **closed/not_planned** |
| [claude-code#11455](https://github.com/anthropics/claude-code/issues/11455) Session Handoff / Continuity Support | 27 | 45 | 2025-11-12 | open |
| [claude-code#31992](https://github.com/anthropics/claude-code/issues/31992) Cross-machine session resume, CLI-to-CLI handoff | 22 | 16 | 2026-03-08 | open |
| [claude-code#2511](https://github.com/anthropics/claude-code/issues/2511) Connect Claude Code to Claude projects | 435 / 674 | 57 | 2025-06-24 | open |

Related: [claude-code#27242](https://github.com/anthropics/claude-code/issues/27242) No working mechanism to review previous context after compaction (93, open). [claude-code#98747](https://github.com/anthropics/claude-code/issues/98747) "idle compaction silently discards working context in long-running sessions" (32, 2026-10-01). [codex#40124](https://github.com/openai/codex/issues/40124) Seamless session handoff CLI/Web/Mobile (open).

**Quotes [E]**
- #25739: "Claude Code loses all accumulated project context each time" because memory is keyed to "paths derived from the absolute project path".
- #11455: "Claude CLI sessions are stateless… Multi-day workflows require users to manually brief Claude at session start."
- #28791: CLI and desktop conversations are "completely separate with no shared history."

**Vendors affected:** Claude Code, Codex, OpenCode, OpenClaw (per-agent memory vaults, [#63829](https://github.com/openclaw/openclaw/issues/63829)), VS Code ([#342279](https://github.com/microsoft/vscode/issues/342279) "User memory is unavailable in Agent Host sessions").

**Shipped?** Each vendor has its own memory feature (CLAUDE.md, auto-memory, Codex memories). Moving memory across devices or tools is not shipped. The cross-surface sync issues are all still open.

**Neutral layer needed?** **Yes.** [E] trailhq/Trail-Code (11.4k★, Jul 2026) describes itself as "One shared memory for every coding agent on your team. Claude Code, Cursor and Codex." Gentleman-Programming/engram (8.3k★) is an "Agent-agnostic" memory binary. tickernelz/opencode-mem#366 asks for "Multi-agent support (Claude Code, Codex, Gemini CLI, Cursor)". [I] Memory is the clearest example of something users want to own outside any single vendor.

**New in 2026:** It is a long-standing need. Its share of issues grew about 11x, and the cross-device and handoff variants are new in 2026.

---

### N3. Guardrails for destructive and out-of-scope actions, with real undo
**One line:** Autonomous agents with shell and infrastructure access occasionally destroy things. Users want enforced scope limits, a classifier that can't be bypassed, and an undo that rolls back file *and* side effects.

| Issue | 👍 / R | c | Created | State |
|---|---|---|---|---|
| [codex#59060](https://github.com/openai/codex/issues/59060) Told to reboot a server, it destroyed systemd, destroyed containers… cost me $10,000+ | 548 / **3,491** | 440 | **2026-11-03** | closed |
| [gemini-cli#26856](https://github.com/google-gemini/gemini-cli/issues/26856) AI disobeyed me… cost me 300 dollars worth of work | 17 / 170 | 48 | 2026-05-11 | closed |
| [claude-code#82165](https://github.com/anthropics/claude-code/issues/82165) Catastrophic data loss: agent-built command expanded to "rm -rf /*"; safety classifier then blocked the kill attempts | 0 / 1 | 7 | 2026-07-29 | open |
| [codex#9203](https://github.com/openai/codex/issues/9203) Please make "/undo" back | 505 / 557 | 102 | 2026-01-14 | open |
| [codex#11626](https://github.com/openai/codex/issues/11626) /rewind restoring chat context *and* code edits | 233 | 58 | 2026-02-12 | open |
| [codex#2847](https://github.com/openai/codex/issues/2847) A way to exclude sensitive files | 474 | 93 | 2025-08-28 | closed/completed 2026-06-29 |
| [claude-code#34327](https://github.com/anthropics/claude-code/issues/34327) Destroyed uncommitted work via git reset --hard on session startup, TWICE | 5 | 14 | 2026-03-14 | closed |
| [opencode#53560](https://github.com/anomalyco/opencode/issues/53560) /undo destroyed 227 files, /restore destroyed 15,232 files | 0 / 11 | 2 | 2026-10-06 | closed |

Also: [claude-code#30519](https://github.com/anthropics/claude-code/issues/30519) "Permissions matching is fundamentally broken — 30+ open issues" (80, open). [claude-code#28240](https://github.com/anthropics/claude-code/issues/28240) compound-command permission bug (209, open). [opencode#2242](https://github.com/anomalyco/opencode/issues/2242) "Is there a way to sandbox the agent?" (84 👍, 115 c). [orbstack#2295](https://github.com/orbstack/orbstack/issues/2295) docker sandbox for AI agents (240 👍).

**Quotes [E]**
- codex#59060 expected behavior: "DOING WHAT IT IS TOLD TO DO… TO NOT … IMAGINE [extra actions]" (heavily profane). It is the most-reacted Codex issue of the past month.
- claude-code#82165: the command "deleted the WSL distro (including a live production database…)", and the safety classifier "then blocked the kill attempts."

**Vendors affected:** all of them.

**Shipped?** Each vendor has its own sandbox and permission modes: the Codex sandbox and exclude-files (#2847 completed), Claude Code's sandbox and auto-mode classifier, and Docker Sandboxes (docker/sbx). Undo across shell side effects is not shipped anywhere. Codex #9203 and #11626 are still open.

**Neutral layer needed?** **Yes.** [I] Policy and blast-radius enforcement belongs below the agent (OS, container, proxy, cloud IAM), so it works whichever vendor's agent is running. [E] microsoft/agent-governance-toolkit (6.6k★) offers "Policy enforcement, zero-trust identity, execution sandboxing". The CubeSandbox, sandcastle and sandstorm repos (6 to 13k★) are 2026 sandbox infrastructure projects. A related MCP issue, "Add Agent Governance Toolkit MCP server for policy enforcement" ([servers#3988](https://github.com/modelcontextprotocol/servers/issues/3988)), was closed.

**New in 2026:** The need is old, but its severity is new. Agents now run on production servers (codex#59060, claude-code#46452 "executed rm -rf /* on production VPS"). Titles with "agent approval" grew about 65x and are still rising in Q4.

---

### N4. Scoped delegation for subagents and teams: inherited permissions, per-agent tools and models, fan-out and budget caps
**One line:** When one agent spawns others, users can't reliably say what each child may do, which model and tools it gets, how many it can spawn, and how much it can spend.

| Issue | 👍 / R | c | Created | State |
|---|---|---|---|---|
| [claude-code#6915](https://github.com/anthropics/claude-code/issues/6915) Allow MCP tools to be available only to subagent | 270 / 377 | 89 | 2025-08-31 | closed/completed (dup) |
| [claude-code#4476](https://github.com/anthropics/claude-code/issues/4476) Agent-Scoped MCP Configuration with Strict Isolation | 183 | 41 | 2025-07-26 | closed/completed |
| [codex#31814](https://github.com/openai/codex/issues/31814) Cannot specify subagent models, forcing all subagents to also be Sol | 176 / 206 | 100 | 2026-07-09 | closed |
| [claude-code#18950](https://github.com/anthropics/claude-code/issues/18950) Skills/subagents do not inherit user-level permissions | 72 | 29 | 2026-01-18 | open |
| [claude-code#26479](https://github.com/anthropics/claude-code/issues/26479) Agent Teams teammates ignore bypassPermissions… don't inherit settings | 16 | 14 | 2026-02-18 | open |
| [claude-code#68110](https://github.com/anthropics/claude-code/issues/68110) Sub-agents recursively spawn unbounded child agents | 12 / 13 | 15 | 2026-06-13 | open |
| [codex#9748](https://github.com/openai/codex/issues/9748) Launching concurrent subagents instantly drains entire Pro quota | 16 / 18 | 31 | 2026-01-23 | closed |
| [opencode#27110](https://github.com/anomalyco/opencode/issues/27110) Setting to limit max number of parallel subagents | 45 | 15 | 2026-05-12 | open |
| [vscode#292452](https://github.com/microsoft/vscode/issues/292452) Billing can be bypassed using subagents with an agent definition | 33 / 106 | 33 | 2026-02-03 | open |

Also: [claude-code#66023](https://github.com/anthropics/claude-code/issues/66023) "one invocation spawned 46 Opus subagents (~3M tokens) with no cost confirmation". [claude-code#38698](https://github.com/anthropics/claude-code/issues/38698) per-agent provider routing (51, open). [claude-code#43869](https://github.com/anthropics/claude-code/issues/43869) "Subagent model routing is broken" (35, open). [opencode#20280](https://github.com/anomalyco/opencode/issues/20280) show subagent identity in permission prompts.

**Quotes [E]**
- #68110: "a single Agent call… resulted in 48+ background agents… The agents kept spawning faster than I could stop them."
- #9748: "launch approximately 6 subagents concurrently… entire Pro plan 5-hour usage quota is instantly consumed."

**Vendors affected:** Claude Code, Codex, OpenCode, VS Code/Copilot, OpenClaw (per-agent plugin overrides, [#25359](https://github.com/openclaw/openclaw/issues/25359)).

**Shipped?** Partly. Claude Code has per-agent `tools:`/`model:` frontmatter and agent-scoped MCP, which is why #4476 and #6915 are closed. Codex Multi-Agent V2 has per-agent config, but model overrides are still buggy ([codex#32031](https://github.com/openai/codex/issues/32031), [#34301](https://github.com/openai/codex/issues/34301)). Inherited permissions, fan-out limits and per-agent budgets are still open.

**Neutral layer needed?** **Medium.** [I] Scope config is configured inside each harness. But a delegation policy (a capability token that only narrows, never widens, with a budget and depth limit, as "a delegated grant can only be smaller") could be a cross-vendor spec, similar to OAuth scopes for agents.

**New in 2026:** yes. Subagent title share grew about 120x.

---

### N5. Identity, credentials and secrets for autonomous and cloud agents
**One line:** Agents running unattended or in the cloud need to authenticate *as someone*: several accounts per service, secrets that never enter the model context, tokens that refresh during multi-day runs, and a session or caller identity that downstream tools can see.

| Issue | 👍 / R | c | Created | State |
|---|---|---|---|---|
| [claude-code#27302](https://github.com/anthropics/claude-code/issues/27302) Multiple Connector accounts (same connector, different accounts) | 490 / 702 | **324** | 2026-02-21 | open |
| [claude-code#32733](https://github.com/anthropics/claude-code/issues/32733) Secure secrets injection for Claude Code on the web | 183 / 217 | 12 | 2026-03-10 | open |
| [codex#20500](https://github.com/openai/codex/issues/20500) Multiple named accounts per app/connector | 118 / 147 | 34 | 2026-04-30 | open |
| [codex#4432](https://github.com/openai/codex/issues/4432) First-class multi-account auth via `--auth-profile` | 135 / 156 | 21 | 2025-09-29 | open |
| [claude-code#41836](https://github.com/anthropics/claude-code/issues/41836) No session/conversation identifier sent to MCP servers | 42 | 19 | 2026-04-01 | open |
| [claude-code#12447](https://github.com/anthropics/claude-code/issues/12447) OAuth token expiration disrupts autonomous workflows | 36 / 39 | 27 | 2025-11-26 | open |
| [e2b#1160](https://github.com/e2b-dev/E2B/issues/1160) Credential/Secret Brokering for HTTP(S) Requests | 11 | 3 | 2026-02-25 | closed |
| [claude-code#81502](https://github.com/anthropics/claude-code/issues/81502) Issue an OIDC identity token to cloud sessions for keyless cloud auth | 20 | 3 | 2026-07-27 | open |

Also: [claude-code#29910](https://github.com/anthropics/claude-code/issues/29910) built-in secrets management (42). [claude-code#83380](https://github.com/anthropics/claude-code/issues/83380) credential handoff to password managers for headless sessions. [claude-code#96762](https://github.com/anthropics/claude-code/issues/96762) opt-in credential/payment entry with 1Password-style handoff. [MCP#214](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/214) On-Behalf-Of token exchange for agent-to-agent. [A2A#153](https://github.com/a2aproject/A2A/issues/153) "A2A should account for the confused deputy problem" (open). [A2A#1990](https://github.com/a2aproject/A2A/issues/1990) auth scheme and credential discovery in AgentCard. [oauth-wg#73](https://github.com/oauth-wg/oauth-identity-assertion-authz-grant/issues/73) "Workload/Agent Identity SSO and Explicit Delegated On-Behalf". [openclaw#16035](https://github.com/openclaw/openclaw/issues/16035) "Make OpenClaw agents identify themselves as agent… in GitHub profile". [vscode#313962](https://github.com/microsoft/vscode/issues/313962) "Add `Assisted-by` instead of `Co-authored-by` for AI agents" (77, open).

**Quotes [E]**
- #32733: the env-var field "explicitly warns: 'don't add secrets or credentials.' This blocks any workflow that requires authentication."
- #41836: "there is no way for the server to identify which conversation or session a request belongs to."
- #12447: "token expiration halts all in-progress tasks simultaneously, leaving work in incomplete states."
- codex#20500: wants "hard privacy boundaries" between personal and work accounts of the same connector.

**Vendors affected:** Claude Code, Codex, E2B, OpenClaw, MCP, A2A, VS Code.

**Shipped?** Partly. The Claude Code cloud environment now has proxy-injected network credentials (this session's `request_credential` tool). Multiple accounts per connector is not shipped by either Claude or Codex. A per-session identity for MCP is unresolved, and MCP *removed* sessions from the core protocol ([transports-wg#36](https://github.com/modelcontextprotocol/transports-wg/issues/36), "Exploring the Future of Sessions").

**Neutral layer needed?** **Yes, strongly.** [I] Identity and credential brokering is by nature shared across vendors: the same Gmail or GitHub or AWS identity is used by Claude, Codex and OpenClaw agents. A vault or proxy that injects scoped, short-lived credentials and stamps a verifiable "agent X acting for user Y" identity is the missing layer. [E] Projects such as MetapriseAI/OrgKernel ("cryptographic agent identity… instance-scoped execution tokens") and agent-governance-toolkit are trying it.

**New in 2026:** The cloud, multi-account and agent-identity variants are new in 2026. Identity title share grew about 9x and accelerated after Q1.

---

### N6. Observability, audit trail and cost attribution across many agents
**One line:** Once work fans out to agents and subagents, users can't see who did what, why, at what cost, and they can't produce a record they could hand to an auditor.

| Issue | 👍 / R | c | Created | State |
|---|---|---|---|---|
| [codex#28058](https://github.com/openai/codex/issues/28058) Encrypted MultiAgentV2 messages remove readable task audit trail | 141 / 155 | 45 | 2026-06-13 | open |
| [claude-code#109446](https://github.com/anthropics/claude-code/issues/109446) 2.1.323 removed subagentStatusLine: per-agent context, cost, model, effort no longer visible | 39 / 41 | 14 | **2026-11-13** | open |
| [claude-code#24537](https://github.com/anthropics/claude-code/issues/24537) Agent Hierarchy Dashboard for multi-agent workflows | 20 | 20 | 2026-02-09 | open |
| [claude-code#11008](https://github.com/anthropics/claude-code/issues/11008) Expose token usage and cost data in hook inputs | 36 | 26 | 2025-11-04 | open |
| [codex#21753](https://github.com/openai/codex/issues/21753) Full Claude Code Hook Parity (29+) | 33 / 51 | 35 | 2026-05-08 | open |
| [MCP FSIG#17](https://github.com/modelcontextprotocol/financial-services-interest-group/issues/17) A tool-call audit record a regulator can verify | 2 | 30 | 2026-10-16 | open |
| [MCP#3229](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3229) RFC: Native Token Metering, Session Budgets, Payment Tracking (x402) | 0 | 13 | 2026-08-11 | closed |
| [vscode#293225](https://github.com/microsoft/vscode/issues/293225) Meta: Agent Observability based on OpenTelemetry | 8 | 14 | 2026-02-05 | open |

Also: [codex#19897](https://github.com/openai/codex/issues/19897) user identity in OTel attributes. [claude-code#88490](https://github.com/anthropics/claude-code/issues/88490) cloud Cowork OTLP missing identity attributes. [claude-code#16424](https://github.com/anthropics/claude-code/issues/16424) agent context in hook payloads (closed/completed). [claude-code#43859](https://github.com/anthropics/claude-code/issues/43859) hook for SendMessage "inter-agent communication logging". [codex#32504](https://github.com/openai/codex/issues/32504) MultiAgentV2 activity omits subagent identity/model. MCP comment-heavy threads on "execution receipts" ([#2852](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2852), 24 c) and "Tool Outcome Attestation" ([#3350](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3350), 23 c).

**Quotes [E]**
- codex#28058: "Users still cannot inspect the exact tasks delegated by the parent, follow-up instructions, or intermediate child-to-parent messages."
- MCP#3229: "massive, unexpected API bills (e.g., $2,800 in 60 seconds) because autonomous agents can enter infinite loops."
- FSIG#17 (quoting its charter): "tamper-evident, portable records of what a tool call did."

**Vendors affected:** Claude Code, Codex, VS Code, MCP ecosystem, regulated industries.

**Shipped?** Each vendor has OTel export, and Claude Code exposes hook agent context. Cross-agent and cross-vendor trace stitching is not shipped, nor are verifiable records. Vendors are moving the wrong way in places: Codex encrypted inter-agent messages, and Claude Code removed the per-subagent status line.

**Neutral layer needed?** **Yes.** [I] An audit log is only credible when it is independent of the agent vendor. Regulators and enterprises will want a single, signed log across Claude, Codex and in-house agents. Audit title share grew about 177x, the fastest of any theme measured.

**New in 2026:** yes.

---

### N7. Lifecycle for long-running and unattended agents: wake on events, survive limits, retry without duplicating effects, scheduled runs that keep their permissions
**One line:** Agents now run for hours or days and on schedules. The runtime around them assumes a human at the terminal: polling, dying at quota resets, re-prompting for approvals, and double-executing on retry.

| Issue | 👍 / R | c | Created | State |
|---|---|---|---|---|
| [codex#21073](https://github.com/openai/codex/issues/21073) Auto-resume CLI session when usage limit resets | 94 | 24 | 2026-05-04 | open |
| [codex#28931](https://github.com/openai/codex/issues/28931) Auto Resume /Goal after limit reached once limit is reset | 86 | 18 | 2026-06-18 | open |
| [claude-code#48322](https://github.com/anthropics/claude-code/issues/48322) Team/Enterprise: shared routines (org-owned scheduled agents) | 81 | 7 | 2026-04-15 | open |
| [claude-code#61015](https://github.com/anthropics/claude-code/issues/61015) Scheduled routines fail every MCP tool call with "requires approval" | 53 | 43 | 2026-05-21 | closed |
| [claude-code#47180](https://github.com/anthropics/claude-code/issues/47180) Cowork scheduled tasks ignore "Always allow" permissions | 48 | 41 | 2026-04-13 | open |
| [codex#32188](https://github.com/openai/codex/issues/32188) Event-driven wakeup when background exec sessions complete | 30 / 34 | 29 | 2026-07-10 | open |
| [codex#29922](https://github.com/openai/codex/issues/29922) Agent-callable `monitor` tool that wakes Codex on background events | 10 / 32 | 25 | 2026-06-24 | open |
| [MCP#3394](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3394) Lost-response retry on a mutating `tools/call` re-executes external effects | 0 | **91** | 2026-09-27 | open |
| [codex#40905](https://github.com/openai/codex/issues/40905) 5-hour usage limit repeatedly interrupts long-running agent tasks | 4 | 15 | 2026-08-26 | open |

Also: [codex#13733](https://github.com/openai/codex/issues/13733) "Background process polling wastes tokens" (50). [claude-code#30447](https://github.com/anthropics/claude-code/issues/30447) daemonizable remote-control `--headless` (48). [codex#23200](https://github.com/openai/codex/issues/23200) headless remote Linux hosts (68). [codex#48195](https://github.com/openai/codex/issues/48195) "make daemon_auto_start opt-in" (193 👍; shows the backlash when the daemon is vendor-controlled). [aaif/project-proposals#34](https://github.com/aaif/project-proposals/issues/34) Durable Agents (ex-Dapr Agents). [openclaw#77964](https://github.com/openclaw/openclaw/issues/77964) "Multiple Agents Stalled - Session Recovery Not Triggered".

**Quotes [E]**
- MCP#3394: "When the application retries with a fresh JSON-RPC request ID, the tool executes again and a second external effect occurs. MCP 2025-11-25 defines no normative retry or duplicate-effect semantics."
- codex#32188: "Repeated polling creates additional model turns, while a monitoring subagent adds its own context and reasoning costs."

**Vendors affected:** Codex, Claude Code (routines, Cowork), MCP, OpenClaw, durable-execution frameworks.

**Shipped?** Partly. Claude Code has routines and scheduled tasks plus a Monitor tool. Codex has /goal and the daemon. Auto-resume after limits, idempotent tool calls and permission-preserving schedules are open.

**Neutral layer needed?** **Medium to high.** [I] Idempotency keys, durable task state and event wakeups are protocol and runtime concerns (MCP Tasks SEP-1686/2663, A2A pub/sub [#1029](https://github.com/a2aproject/A2A/issues/1029)) more than UI ones. A vendor-neutral durable runner could host any harness.

**New in 2026:** yes. Agent+long-running titles went from 1 to 282 per quarter. Scheduled agents only appear from Apr 2026 onward.

---

### N8. One portable way to configure agents: instructions, skills, hooks and protocols
**One line:** Teams run several agent harnesses on the same repo and want one AGENTS.md, one `.agents/skills/` and one hook and plugin model, instead of maintaining parallel `.claude/`, `.codex/`, `.github/` and `.gemini/` trees.

| Issue | 👍 / R | c | Created | State |
|---|---|---|---|---|
| [claude-code#6235](https://github.com/anthropics/claude-code/issues/6235) Support AGENTS.md | **5,197 / 6,696** | 409 | 2025-08-21 | closed/completed 2026-08-17 |
| [claude-code#31005](https://github.com/anthropics/claude-code/issues/31005) Support for AGENTS.md and .agents/skills/, asked since Aug 2025 | 498 / 656 | 38 | 2026-03-05 | **open** |
| [agentskills#15](https://github.com/agentskills/agentskills/issues/15) Standard folder where agent skills should be | 188 / 271 | 130 | 2025-12-19 | open |
| [agentsmd#91](https://github.com/agentsmd/agents.md/issues/91) Standardize global user-level AGENTS.md at ~/.config/agents/ | 144 / 151 | 20 | 2025-10-22 | open |
| [claude-code#6686](https://github.com/anthropics/claude-code/issues/6686) Support Agent Client Protocol (ACP) | 437 / 550 | 37 | 2025-08-27 | **closed/not_planned** |
| [vscode#265496](https://github.com/microsoft/vscode/issues/265496) Add support for ACP | 324 / 348 | 49 | 2025-09-06 | open |
| [codex#29989](https://github.com/openai/codex/issues/29989) / [opencode#34498](https://github.com/anomalyco/opencode/issues/34498) Respect `disable-model-invocation` in SKILL.md | 61 / 70 | 5 / 19 | 2026-06 | open / closed |
| [vscode#327256](https://github.com/microsoft/vscode/issues/327256) Shared `.agents/` directory and manifest-based discovery | 22 | 9 | 2026-07-24 | closed |

**Quotes [E]**
- agentskills#15: "Claude is looking at `.claude/skills/` and Github Copilot is looking at `.github/skills/`… now we have Codex also looking at its own folder."
- claude-code#31005: "#6235… 3,020 upvotes… zero team response."

**Vendors affected:** all of them.

**Shipped?** This is the most "being solved" of the eight. AGENTS.md is now near-universal. The Agent Skills standard exists, and Codex, OpenCode, Goose, Amp and Copilot have adopted it. ACP is supported by Zed, Copilot CLI and OpenCode, but Claude Code declined it. Gaps remain: user-level paths, frontmatter semantics and hook parity ([codex#21753](https://github.com/openai/codex/issues/21753)).

**Neutral layer needed?** It is already happening through open standards (AAIF, agentskills, agents.md). [I] This is less of a product opportunity now, but it is the base that N1, N2 and N4 need.

**New in 2026:** no. It is a 2025 need that peaked in 2026 and is now partly served.

---

### Noted but not in the top 8
- **Account switching and multiple subscriptions** ([claude-code#18435](https://github.com/anthropics/claude-code/issues/18435) 1,097 👍; [#36151](https://github.com/anthropics/claude-code/issues/36151) 783). Huge demand, but it is consumer account UX for each vendor. The connector-level variant is folded into N5.
- **Usage limits and quota transparency** ([claude-code#16157](https://github.com/anthropics/claude-code/issues/16157) 697 👍, 1,499 c; [codex#28879](https://github.com/openai/codex/issues/28879)). This is the loudest pain overall, but it is pricing, not a missing layer. Its agent-specific form (subagent cost blowups) is in N4 and N6.
- **Agent payments and wallets.** [E] GitHub evidence is weak and noisy: mostly crypto bounty repos, [x402#447](https://github.com/x402-foundation/x402/issues/447) (18 👍), MCP#3229 (closed), and claude-code#96762 (6 👍). [I] Title counts are growing about 38x, but they come mostly from crypto projects, not from agent builders. This is not yet a validated mainstream need.
- **Agent-to-agent protocol adoption (A2A)** in coding harnesses: [opencode#3023](https://github.com/anomalyco/opencode/issues/3023) (34), [hermes-agent#514](https://github.com/NousResearch/hermes-agent/issues/514) (53 R), [codex#58146](https://github.com/openai/codex/issues/58146) (2). Interest is modest. [I] Builders ask for "make my agents talk" (N1), not for "A2A" by name.

---

## 2. Ranking

Scoring is 1 to 5 on each factor: evidence strength (reactions, comments, number of independent issues), cross-vendor (number of vendors and whether a neutral layer is needed), trend (growth in title share, newness in 2026), and unserved (5 = nobody ships it, 1 = solved). Score = product. **[I] These are judgment calls based on the evidence above.**

| Rank | Need | Evidence | Cross-vendor | Trend | Unserved | Score |
|---|---|---|---|---|---|---|
| 1 | **N1 Multi-agent coordination, shared state and merge control across sessions and vendors** | 4 | 5 | 5 | 4 | **400** |
| 2 | **N5 Agent identity, credentials and secrets brokering** | 5 | 5 | 4 | 4 | **400** |
| 3 | **N6 Cross-agent observability, audit trail and cost attribution** | 3 | 5 | 5 | 5 | **375** |
| 4 | **N3 Enforced guardrails and blast-radius control with real undo** | 5 | 5 | 4 | 3 | **300** |
| 5 | **N2 Portable memory and context across sessions, devices and tools** | 4 | 5 | 3 | 4 | **240** |
| 6 | **N4 Scoped delegation for subagents (permissions, models, fan-out, budgets)** | 4 | 3 | 5 | 3 | **180** |
| 7 | **N7 Lifecycle for long-running agents (wakeups, auto-resume, idempotent retries, scheduled permissions)** | 3 | 3 | 4 | 4 | **144** |
| 8 | **N8 Portable agent config (AGENTS.md, skills, hooks, ACP)** | 5 | 4 | 3 | 1 | **60** |

**What the ranking suggests [I]**
- The top three share a theme. When there are many agents from many vendors, nobody owns the space *between* agents: who an agent is (N5), what it is allowed to touch and how it coordinates with peers (N1), and what it actually did (N6). Vendors build these inside their own walls (Agent Teams, Multi-Agent V2, per-vendor OTel), and the smaller vendors decline (OpenCode and Gemini closed agent teams as not_planned). Third-party orchestrators with 10 to 15k stars and a 2026 wave of "shared memory for every coding agent" repos show demand for a neutral layer.
- The fastest-growing signals in 2026 are audit (~177x), worktree (~123x), subagent (~120x), long-running (~83x), budget (~69x) and approval (~65x). Approval and sandbox are still accelerating in 2026Q4.
- Things a neutral product shouldn't chase: N8 (standards bodies are handling it) and account and quota UX (vendor-owned).

## 3. Best links (short list)
- Coordination: https://github.com/anthropics/claude-code/issues/24798 · https://github.com/anomalyco/opencode/issues/12661 · https://github.com/google-gemini/gemini-cli/issues/19430 · https://github.com/openclaw/openclaw/issues/40245
- Identity/credentials: https://github.com/anthropics/claude-code/issues/27302 · https://github.com/anthropics/claude-code/issues/32733 · https://github.com/openai/codex/issues/20500 · https://github.com/anthropics/claude-code/issues/41836
- Audit/observability: https://github.com/openai/codex/issues/28058 · https://github.com/anthropics/claude-code/issues/109446 · https://github.com/modelcontextprotocol/financial-services-interest-group/issues/17
- Guardrails: https://github.com/openai/codex/issues/59060 · https://github.com/anthropics/claude-code/issues/82165 · https://github.com/openai/codex/issues/9203
- Memory: https://github.com/anthropics/claude-code/issues/28791 · https://github.com/anthropics/claude-code/issues/25739 · https://github.com/anomalyco/opencode/issues/20695
- Delegation: https://github.com/anthropics/claude-code/issues/68110 · https://github.com/openai/codex/issues/9748 · https://github.com/anthropics/claude-code/issues/18950
- Long-running: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3394 · https://github.com/openai/codex/issues/21073 · https://github.com/openai/codex/issues/32188
- Config standards: https://github.com/anthropics/claude-code/issues/6235 · https://github.com/agentskills/agentskills/issues/15

## 4. Limitations
- I could not read GitHub Discussions, because only search endpoints were allowed and GraphQL discussion search was not used. I also could not read full comment threads, because the GitHub MCP tools are restricted to this repo. Quotes come from issue bodies only.
- `repo:block/goose` and `repo:sst/opencode` returned HTTP 422 (the repos moved or were renamed). OpenCode was searched as `anomalyco/opencode`. Goose was not covered.
- Star counts and issue text are untrusted and can be inflated by bots. Reaction counts can also be brigaded: codex#59060 has 3,491 reactions, mostly not 👍.
- The bulk "closed/completed" claude-code issues dated 2026-08-17 need checking against the changelog before claiming they shipped.
