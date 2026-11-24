# Rising agent repos on GitHub: what developers are building (snapshot 2026-11-24)

## Method and caveats

- **Source:** `gh api search/repositories` only, sorted by stars. I ran 58 queries (the 30 suggested ones, 28 targeted follow-ups such as guardrails, durable, x402, harness, dsh-plugin, agent-governance and mcp-gateway, plus count-only queries). After deduplication that gave 1,471 repos created after 2026-06-01. Raw JSON is in the scratchpad: `/tmp/claude-0/-home-user-gurudreamsv1/2ad053a4-8c02-5e6b-b56c-868730156a9a/scratchpad/gh/`.
- **Momentum metric:** stars per day since creation (stars / age in days). This favours very young repos with launch spikes, so I read it alongside the absolute star count.
- **Crowding metric:** for each topic, the number of new repos (created after 2026-06-01) next to the number that passed 500 stars. A topic with many repos but few hits is crowded and noisy. A topic with few repos and few hits is thin.
- **Inflation checks:** only search endpoints were allowed, so I couldn't sample stargazers. I used fork/star ratio, issue and PR counts (`search/issues`), owner account age (`search/users user:X created:>2026-01-01`), and description patterns.
- **Labels:** **[E]** marks evidence, meaning numbers or text taken directly from the API or the web. **[I]** marks my inference.
- Descriptions and README claims come from the repos themselves and are untrusted. Benchmark claims such as "−34% turns" were not verified.
- **Hacker News:** WebSearch only reached aggregator pages (buzzing.cc) and a few HN items. Point counts were mostly missing or very low (about 1 point). Treat the HN section as weak, qualitative signal.

---

## 0. The context that shapes everything else [E, with I]

- **[E]** `deepseek-ai/deepseek-harness` (https://github.com/deepseek-ai/deepseek-harness) has 286,203 stars and 35,632 forks. It was created 2026-08-13 (about 2,800 stars/day) and describes itself as "Everything is a Plugin." The `topic:dsh-plugin` tag already covers **34,095 repos**, 134 of them above 500 stars.
- **[E]** Other harnesses launched in the same window include `zai-org/ZCode` (8.9k), `XiaomiMiMo/MiMo-Code` (13.8k), `deepseek-ai/dsh-superagent-prototype` (24.4k in 23 days), `truefoundry/trueforge` (6.6k), `vercel/eve` (6.1k) and `yc-software/qm` (15.8k, "multiplayer agent harness for teams"). Repo text also references Pi, Hermes, OpenClaw, Antigravity, Codex, Claude Code and OpenCode.
- **[I]** 2026 H2 is a **harness-proliferation** period. Many "new primitives" are adapters that let something work across harnesses, or plugins for a single harness, especially DSH. Several closed products also triggered waves of open "alternative" repos. The products named in descriptions are Grok Bot, OpenAI dots, Claude Duet, Claude Tag and Meta Muse.

---

## 1. Categories ranked by momentum

Columns: repo, stars, created, stars/day, what it does. Categories are ordered by the velocity of their top repos and by how many repos passed 500 stars.

### 1. Harness ecosystems and model/harness portability (very hot)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 286,203 | 08-13 | 2,805 | Plugin-first agent harness |
| [yetone/magpie](https://github.com/yetone/magpie) | 40,630 | 09-23 | 666 | Menu-bar switcher: Codex on DeepSeek, Claude Code on Kimi |
| [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | 24,392 | 10-31 | 1,060 | More autonomous agent system on DSH |
| [ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) | 30,916 | 10-25 | 1,066 | DSH on a phone, can drive the PC |
| [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) | 18,728 | 06-18 | 118 | Universal provider proxy for Codex / Claude Code |
| [yc-software/qm](https://github.com/yc-software/qm) | 15,774 | 07-29 | 135 | Multiplayer agent harness for teams |
| [HarnessRouter/harnessrouter](https://github.com/HarnessRouter/harnessrouter) | 4,484 | 08-09 | 42 | Unified interface across harnesses |
| [ZiChuanLan/agent-purge](https://github.com/ZiChuanLan/agent-purge) | 2,100 | 10-25 | 72 | One persona injected across many coding agents (fork-heavy, see §4) |

**[I]** The need is to decouple model, harness and persona. Developers don't want lock-in to one vendor's harness or model. This is crowded at the "proxy/switcher" level but has no standard underneath.

### 2. Skills and plugins as packaged behavior (hottest by volume, most crowded)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | 197,612 | 06-12 | 1,204 | "Lazy senior dev" behaviour skill: write less code |
| [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) | 77,616 | 06-18 | 491 | Multi-phase security audit skill with verified, machine-readable findings |
| [janestreet/agent_skills](https://github.com/janestreet/agent_skills) | 11,435 | 11-03 | 571 | Jane Street's agent skills |
| [EL4CTEO/fast-anything](https://github.com/EL4CTEO/fast-anything) | 3,255 | 11-21 | 1,627 | Profile, then port only the hot 5% to Rust via FFI |
| [erkamyaman/rust-anything](https://github.com/erkamyaman/rust-anything) | 8,825 | 11-16 | 1,260 | Incremental Rust rewrite, checked against recorded behaviour |
| [google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) | 22,460 | 09-13 | 316 | Plugin for designing and reviewing software with agents |
| [wheresryan22/anatomy](https://github.com/wheresryan22/anatomy) | 28,930 | 10-08 | 628 | Skill for interactive isometric machine illustrations |

**[E]** `topic:agent-skills` has 39,093 new repos (195 above 500 stars). `topic:claude-code` has 91,499 (399 above 500). A large subcluster makes creative or video output with code: rea-video, hypit, video-shotcraft, openfilm, lemo-opuscar, pixelfx, brag and huashu-motion are each 5k–31k stars.
**[I]** Skills have become the default distribution unit for agent know-how. The market is saturated with content and has almost no quality control (see Gap B).

### 3. Computer, browser and phone use (hot; mobile is the newest surge)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [wangzan101/Mika](https://github.com/wangzan101/Mika) | 9,798 | 10-29 | 392 | On-device Android agent that operates apps and the web |
| [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | 24,715 | 09-16 | 363 | "Fastest and cheapest web agent" |
| [lexmount/moli](https://github.com/lexmount/moli) | 24,386 | 08-10 | 232 | Rust headless browser built for agents |
| [google/artemis](https://github.com/google/artemis) | 17,975 | 08-13 | 176 | Natural language to reliable Android automation |
| [DIYgod/pinky](https://github.com/DIYgod/pinky) | 2,722 | 11-06 | 160 | Any MCP agent drives your iPhone/Android, human in the loop |
| [onehumanbeing/esp32-iphone-agent](https://github.com/onehumanbeing/esp32-iphone-agent) | 5,286 | 10-11 | 122 | Real iPhone via a $7 ESP32 (AirPlay eyes, USB HID hands) |
| [JosssphZhou/poki](https://github.com/JosssphZhou/poki) | 1,894 | 11-05 | 105 | iPhone agent app that reads the screen and taps |
| [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) | 10,688 | 06-22 | 69 | Agent uses your real logged-in browser |
| [amontlabs/lcu](https://github.com/amontlabs/lcu) | 2,462 | 09-22 | 40 | Codex computer use decoupled so any harness can use it |

**[E]** `topic:computer-use` has 1,819 repos (30 above 500). `topic:browser-automation` has 3,929. Phone-agent repos cluster in Oct–Nov 2026.
**[I]** Phones are the new frontier for agent actuation. Note the hardware hack (ESP32) needed to get around iOS limits.

### 4. Personal "bot" agents with their own computer (hot; open clones of closed launches)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot) | 27,252 | 08-11 | 262 | Open Grok Bot alternative with a VM bots can use |
| [simplexai-labs/linger](https://github.com/simplexai-labs/linger) | 4,230 | 11-10 | 325 | Proactive personal agent fully on your PC |
| [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot) | 13,330 | 08-17 | 136 | Self-hostable alternative to closed AI bots (AG-UI) |
| [nano-muse/nanoMuse](https://github.com/nano-muse/nanoMuse) | 3,667 | 09-23 | 60 | One named agent across every device |
| [n8n-io/nod](https://github.com/n8n-io/nod) | 3,290 | 09-25 | 56 | Personal agent with its own computer: chases invoices, cancels subscriptions |
| [modelflare-ai/AnyModelBot](https://github.com/modelflare-ai/AnyModelBot) | 4,996 | 10-27 | 185 | Local alternative to Grok Bot / OpenAI dots / Claude Duet |

**[I]** These agents take real-world actions such as payments, cancellations and email. That directly creates demand for Gaps A and E, which have barely been built.

### 5. Multi-agent teams, orchestration and agent-human collaboration (hot, crowded)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) | 6,418 | 11-03 | 321 | CLI agent takes work in the background and only sends a card when unsure |
| [mdiri-ai/SoduWork](https://github.com/mdiri-ai/SoduWork) | 7,163 | 10-29 | 286 | Multi-harness, multi-agent team engine, self-hosted |
| [agentes-chat/agentes-chat](https://github.com/agentes-chat/agentes-chat) | 1,994 | 11-09 | 142 | Slack alternative where teams and agents share channels |
| [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent) | 11,518 | 06-11 | 69 | Meta-harness orchestrating Claude Code, Codex, Cursor, Pi |
| [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate) | 9,102 | 06-12 | 56 | Talk to one agent, ship with a crew |
| [Tencent/LoopForge](https://github.com/Tencent/LoopForge) | 5,899 | 07-28 | 50 | Self-hosted coding-agent delivery workflows with approvals |
| [sandbox-quantum/switch](https://github.com/sandbox-quantum/switch) | 4,704 | 07-16 | – | Agents as teammates in Slack, Teams, Discord, Telegram |

**[E]** `topic:agent-orchestration` has 3,749 repos (29 above 500). Late-November Show HNs include "Run coding agents with your whole team" (Pangea, 11-21) and "Agent Hive" (11-19), both with low points.

### 6. Offensive security agents and security-audit skills (hot)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [erkamyaman/safe-anything](https://github.com/erkamyaman/safe-anything) | 517 | 11-22 | 517 | Rust vulnerability scanner for agents (1 day old) |
| [BaaRai/ARTEX](https://github.com/BaaRai/ARTEX) | 18,003 | 10-08 | 391 | Autonomous pentest system (translation of an upstream repo) |
| [elder-plinius/T3MP3ST](https://github.com/elder-plinius/T3MP3ST) | 7,127 | 07-02 | 49 | Multi-agent autonomous red teaming |
| [google/mantis](https://github.com/google/mantis) | 2,818 | 06-15 | 18 | Agents find, reproduce and patch vulns |
| [qybaihe/bla](https://github.com/qybaihe/bla) | 6,617 | 10-25 | 228 | Blue-defense MCP server protecting JS/TS/Electron code |

**[I]** Agents are now used for offense and audit far more than for defending the agent itself. Defending the agent falls under category 10 below, which is much thinner.

### 7. Cost, tokens and context economy (rising)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer) | 8,039 | 10-13 | 196 | Experience-driven black-box cost control for coding agents |
| [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) | 8,018 | 09-17 | 119 | Replaces compaction summary with scored decision records |
| [INK-Q/agy-fast](https://github.com/INK-Q/agy-fast) | 817 | 11-19 | 204 | MCP accelerator claiming −34% LLM turns |
| [JetBrains/benjamin-plus-skill](https://github.com/JetBrains/benjamin-plus-skill) | 340 | 08-17 | – | Measured token-efficiency skill (−17.9%) |

**[E]** I also found about 7 compaction plugins, one per harness (pi, hermes, dsh, codex), each under 250 stars.

### 8. Tool and connector access layers (rising)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [superdesigndev/treg](https://github.com/superdesigndev/treg) | 8,822 | 07-15 | 67 | "OpenRouter for agent tools" |
| [monid-ai/monid](https://github.com/monid-ai/monid) | 6,219 | 08-26 | 70 | "OpenRouter for agent tools" (same tagline as treg) |
| [oomol-lab/open-connector](https://github.com/oomol-lab/open-connector) | 6,285 | 06-29 | 43 | Auth gateway to 1,700+ SaaS providers via SDK/CLI/MCP/HTTP |
| [activeing123/mcptoon](https://github.com/activeing123/mcptoon) | 444 | 07-27 | 4 | MCP gateway CLI for every server and skill |

**[E]** `topic:mcp` has 84,843 new repos (234 above 500). `topic:mcp-server` has 27,942 (85 above 500). `topic:mcp-gateway` has 304 (3 above 500).
**[I]** MCP servers themselves are commodity now. The value has moved to aggregation and auth brokering.

### 9. Memory and shared context (steady; crowded in one niche)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [xerj-org/xerj](https://github.com/xerj-org/xerj) | 20,270 | 06-30 | 138 | Rust search engine and MCP server over code, docs and logs for agents |
| [trailhq/Trail-Code](https://github.com/trailhq/Trail-Code) | 11,460 | 07-03 | 80 | One shared memory for every coding agent on a team |
| [tigerless-labs/agent-memory](https://github.com/tigerless-labs/agent-memory) | 4,319 | 09-01 | 52 | Markdown-as-truth long-term memory runtime |
| [aoci-spec/aoci-code](https://github.com/aoci-spec/aoci-code) | 2,976 | 08-08 | 37 | Git-versioned map of codebase and DB schema for agents |
| [VictorTaelin/OptMem](https://github.com/VictorTaelin/OptMem) | 2,462 | 07-25 | 20 | Permanent memory from a 426-token prompt and a script |
| [sno-ai/sno-station](https://github.com/sno-ai/sno-station) | 1,027 | 09-19 | – | When Claude Code hits its limit, Codex continues from the same memory |

**[E]** `topic:agent-memory` has 4,354 repos (22 above 500). Many are "markdown/git memory for coding agents" variants (brain.md, okf-agent-memory, ai-memory-vault, deja-vu and others).

### 10. Guardrails, policy and agent firewalls (moderate, fragmented)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [lennney/stop-that-shit](https://github.com/lennney/stop-that-shit) | 4,085 | 08-11 | 39 | Hook guard stopping out-of-scope agent actions (low forks, see §4) |
| [hardenrun/aif](https://github.com/hardenrun/aif) | 1,963 | 08-01 | 17 | On-device firewall for coding and personal agents |
| [archestra-ai/OpenAPPA](https://github.com/archestra-ai/OpenAPPA) | 1,651 | 08-18 | 17 | Deterministic guardrails |
| [Cygnux-Labs/Tracekit](https://github.com/Cygnux-Labs/Tracekit) | 874 | 09-26 | 15 | Records actions and decides each tool call before it runs |
| [solongate/agent-security](https://github.com/solongate/agent-security) | 689 | 09-27 | 12 | Local security gateway enforcing tool policy |

**[E]** `topic:agent-security` has 1,790 repos (5 above 500). `topic:agent-governance` has 765 (2 above 500). Show HN "Agent Guard" (11-20) and "Control Layer Demo for AI Coding Agents" (11-09) both had low traction. A parallel research effort exists in `research_notes/Agent permission layer landscape/`.

### 11. Developer-side observability and remote control (lively for watching, thin for production)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [Louis-CFM/coucou](https://github.com/Louis-CFM/coucou) | 7,425 | 09-27 | 130 | Mac notch / iPhone monitor for all your coding agents |
| [alexeyw/lot-map](https://github.com/alexeyw/lot-map) | 1,143 | 11-09 | 81 | Live map of what Claude Code is doing |
| [devswha/ovis](https://github.com/devswha/ovis) | 2,198 | 09-17 | 33 | Browser/phone client to chat with and steer herdr agents |
| [Continuum-AI-Corp/OrcaReplay](https://github.com/Continuum-AI-Corp/OrcaReplay) | 1,164 | 08-29 | 14 | Record, replay and fork agent runs |
| [sodiumsun/agenttrail](https://github.com/sodiumsun/agenttrail) | 1,059 | 08-21 | 11 | Local observability map for coding agents |
| [Jwuthri/Tracely-ai](https://github.com/Jwuthri/Tracely-ai) | 1,122 | 06-03 | 6 | Production traces become regression tests that block PRs |

**[E]** `topic:agent-observability` has 456 repos (6 above 500).

### 12. Sandboxes and execution environments (thin, but backed by large companies)
| Repo | Stars | Created | /day | What |
|---|---|---|---|---|
| [perplexityai/SPACE](https://github.com/perplexityai/SPACE) | 2,153 | 10-01 | 41 | Pluggable-runtime sandboxes for agent code |
| [davidondrej/cloudroom](https://github.com/davidondrej/cloudroom) | 1,843 | 09-17 | 28 | Any harness in isolated cloud sandboxes |
| [Ephemeral-AI-Lab/layerfs](https://github.com/Ephemeral-AI-Lab/layerfs) | 2,854 | 08-10 | 27 | Ephemeral writable workspaces with durable shared history |
| [BitMiracle-AI/Dormice](https://github.com/BitMiracle-AI/Dormice) | 1,975 | 07-08 | 14 | "SQLite of agent sandboxes", E2B-compatible |
| [microsoft/nvx](https://github.com/microsoft/nvx) | 865 | 08-27 | 10 | Cross-platform micro-VM sandbox |
| [vercel-labs/durable-harness](https://github.com/vercel-labs/durable-harness) | 337 | 10-16 | 9 | Durable coding-agent harnesses on a sandbox |

**[E]** `topic:agent-sandbox` has only 148 repos (3 above 500). Simon Willison (2026-11-17) described an "external sandbox" pattern with Prime Radiant: three localhost sandbox servers, an allow-list proxy, and credential replacement so the agent never sees secrets. A Nov 4 newsletter quotes Vercel's CEO: "stateless sandboxes are the wrong way to run AI agents."

### 13. Self-improvement and RL environments (research-y)
- [Human-Agent-Society/reef](https://github.com/Human-Agent-Society/reef): 7,634 stars, created 08-31, 91/day. Infrastructure for continually self-improving agents.
- [kirodotdev/KiroCrew](https://github.com/kirodotdev/KiroCrew): 5,061 stars, created 07-16. Self-improving persistent dev workspace.
- [scaleapi/agentenv-framework](https://github.com/scaleapi/agentenv-framework): 448 stars. Collaborative realistic RL environments.
- [browser-use/rl-env-use](https://github.com/browser-use/rl-env-use): 171 stars. RL environments built from real browser cases.

### 14. Agent-native backends (emerging, thin)
- [pgrundev/pgboxdb](https://github.com/pgrundev/pgboxdb): 734 stars, created 10-08. Thousands of isolated Postgres databases for agents.
- [pgrundev/pgbot](https://github.com/pgrundev/pgbot): 1,518 stars.
- [mikehasa/golive-skill](https://github.com/mikehasa/golive-skill): 1,607 stars, 26/day. Takes an agent-built product live: hosting, DB, domain, email, payments.
- [truespar/sentio](https://github.com/truespar/sentio): 291 stars. A real email inbox per agent.
- [InsForge/instacloud-oss](https://github.com/InsForge/instacloud-oss): 219 stars. Cloud infrastructure for agents to provision directly.

### 15. Evals and testing for agents and skills (thin)
- [NVIDIA/SkillEvaluator](https://github.com/NVIDIA/SkillEvaluator): 4,465 stars, created 06-24, 29/day. Quality gates and security scans for skills and plugins. This is the only strong repo.
- [ai-evals-course/evals-skills](https://github.com/ai-evals-course/evals-skills): 1,841 stars. Skills that help you build product evals.
- `topic:agent-eval` has **24 repos and 0 above 500**. The "agent eval" query (more than 50 stars) returned 62 repos, mostly courses and handbooks.

### 16. Payments and commerce (thin and noisy)
- [internet-court/internet-court-skill](https://github.com/internet-court/internet-court-skill): 7,187 stars, created 06-16. Trust layer for agent-to-agent commerce using ERC-7710 delegated permissions.
- [vAPI-Network/vapi-network](https://github.com/vAPI-Network/vapi-network): 5,691 stars, created 10-02, 109/day. Buyer-controlled x402 USDC client.
- The next tier is under 100 stars: agent-payment-node (72), vaaya-mcp (44, per-agent prepaid wallet with spend limits), tael and ag-pay.
- **[E]** `topic:agent-payments` has 422 repos (2 above 500). `topic:x402` has 3,109 repos (3 above 500), and many are memecoin snipers. There is a burst of SEO-spam "virtual card FinOps guides" (see §4).

### 17. Identity, delegation and agent-to-agent protocols (thinnest)
- [securetron-gh/aifw](https://github.com/securetron-gh/aifw): 415 stars, 3 forks. Agent IAM and inference firewall.
- [zalando-incubator/agentic-identity-broker](https://github.com/zalando-incubator/agentic-identity-broker): 81 stars. OAuth2 delegation and consent.
- [ServiceNow/ai-passport](https://github.com/ServiceNow/ai-passport): 13 stars. Signed agent credential spec.
- [AuthPlane/authserver](https://github.com/AuthPlane/authserver): 82 stars. OAuth 2.1 server for MCP.
- [Cotal-AI/Cotal](https://github.com/Cotal-AI/Cotal): 409 stars. "Open standard for agent coordination".
- [openpactprotocol/openpactprotocol](https://github.com/openpactprotocol/openpactprotocol): 117 stars. Protocol for personal agents talking to business agents under verified mandates.
- **[E]** `topic:agent-identity` has 238 repos and **0 above 500**. `topic:a2a` has 1,504 (2 above 500). Secrets tools are tiny: hush (21) and tokenstash (21). Show HN "Coding agents need a tap from your watch, not API keys" (10-30) had low traction.

---

## 2. Crowded vs. thin (count of new repos created after 2026-06-01 / count above 500 stars) [E]

| Topic | New repos | >500★ | Read |
|---|---|---|---|
| mcp | 84,843 | 234 | Saturated commodity |
| claude-code | 91,499 | 399 | Saturated, also used as a "built with" tag |
| agent-skills | 39,093 | 195 | Saturated, content-heavy |
| dsh-plugin | 34,095 | 134 | New ecosystem land-grab |
| mcp-server | 27,942 | 85 | Saturated |
| agent-memory | 4,354 | 22 | Crowded, low hit rate (0.5%) |
| browser-automation | 3,929 | – | Crowded |
| agent-orchestration | 3,749 | 29 | Crowded |
| x402 | 3,109 | 3 | Noisy (crypto spam) |
| computer-use | 1,819 | 30 | Busy, high hit rate (1.6%) |
| agent-security | 1,790 | 5 | Mid, offense-heavy |
| a2a | 1,504 | 2 | Many specs, no traction |
| agent-governance | 765 | 2 | Thin |
| agent-observability | 456 | 6 | Thin |
| agent-payments | 422 | 2 | Thin |
| mcp-gateway | 304 | 3 | Thin |
| agent-identity | 238 | 0 | **Thinnest** |
| agent-sandbox | 148 | 3 | Thin in count but high-quality backers |
| agent-eval | 24 | 0 | **Nearly empty** |

---

## 3. Gaps: needs that are clearly emerging with nothing strong built yet

### Gap A: Per-agent identity, scoped credentials and delegated authority
- **Demand evidence [E]:** Personal agents now act in the world. n8n/nod "chases invoices… cancels subscriptions." OpenMausBot gives bots a VM. Phone agents tap through real iPhones. Background agents run unattended (agent-autoloop at 321/day). open-connector reached 6.3k stars as an auth gateway to 1,700 SaaS providers. Willison's external sandbox includes credential replacement. The Show HN "Coding agents need a tap from your watch, not API keys" fits the same need.
- **Supply evidence [E]:** agent-identity has 238 repos and 0 above 500. Big-company specs get no pickup: ServiceNow ai-passport has 13 stars and Zalando's broker has 81. Secret-hiding tools have about 21 stars each.
- **[I]** This is the largest mismatch between demand velocity and supply. Developers have solved "agent can act" but not "agent acts as whom, with what limits, revocably." Infrastructure that can be adopted bottom-up (CLI, proxy or harness plugin) seems more likely to win than enterprise specs. This overlaps with the permission-layer notes in `research_notes/Agent permission layer landscape/`.

### Gap B: Evals and regression testing for skills, plugins and harness configurations
- **Demand evidence [E]:** There are 39k skill repos and 34k DSH plugins, and single skills reach 77k–197k stars. Skills compete on unverified claims, for example leanrea "Benchmarked: 38% faster" than REA, agy-fast "−34% turns" and Benjamin-Plus "−17.9% tokens". The Show HN "Coding agent skills, tested on 15 backend tasks with hidden checks" (11-07) shows people starting to test. The sudo-ai-git repos document benchmark graders that silently mis-score.
- **Supply evidence [E]:** agent-eval has 24 repos and 0 above 500. NVIDIA SkillEvaluator (4.5k) is the only notable one. Tracely-ai (1.1k), which turns traces into regression tests, is small.
- **[I]** There is no neutral, reproducible "does this skill or plugin actually help on my tasks, on my harness and model" layer. An install-time quality and safety gate for skill marketplaces, which are themselves thin (skill-dock has 730 stars and 0 forks), is also open.

### Gap C: Portability of state, memory and sessions across harnesses
- **Demand evidence [E]:** magpie (40k, 666/day) and opencodex (18.7k) swap models under harnesses. sno-station hands tasks from Claude Code to Codex when usage limits hit. deja-vu does session handoff. agent-purge injects one persona across many agents. Trail-Code is "one shared memory for every coding agent." HarnessRouter (4.5k) offers a unified harness interface. Repos reference at least 10 harnesses.
- **Supply evidence [E/I]:** Many repos solve one slice for one pair of harnesses, and memory has a 0.5% hit rate. I found no standard format for session transcripts, memory, skills and permissions that moves between harnesses. One repo mentions an "Agent Plugins format" (otelyssey), but traction is unclear.
- **[I]** The harness wars are creating a "data portability" problem in agent memory and in-flight work. Whoever defines the portable unit, roughly a ".agentstate", gets leverage.

### Gap D: Durable, long-running background execution with human checkpoints
- **Demand evidence [E]:** agent-autoloop ("only finds you with a card when unsure", 321/day), coucou (130/day, notch monitor), ovis, herdr-remote and herdr-mobile-relay (approve from phone), LongHorizon-Harness (1.9k), and Epoptes in the Nov "What are you working on" thread (long autonomous runs with monitoring and steering). Vercel's CEO says stateless sandboxes are wrong for agents.
- **Supply evidence [E]:** the "durable agent workflow" query returned 7 repos. vercel-labs/durable-harness has 337 stars, and kassette, an embeddable durable primitive, has 52. Observability stops at local dev dashboards. Only OrcaReplay (1.2k) handles replay and fork.
- **[I]** The UX layer (notifications and approve-from-phone) is booming. The infrastructure underneath is thin: resumable state, checkpoint and fork, approval routing, and SLA-style escalation. This pairs naturally with Gap A, because an approval is an authorization event.

### Gap E: Mainstream (fiat) agent payments and spend control
- **Demand evidence [E]:** Personal agents handle invoices and subscriptions, golive-skill wires payments into agent-built apps, and vaaya-mcp offers per-agent prepaid balances with spend limits (only 44 stars). Spam repos (e.g. "mitigating Stripe Radar tokenization friction in agentic purchasing") use the topic as SEO bait, which suggests search demand.
- **Supply evidence [E]:** Nearly everything that has traction is on-chain: x402/USDC (vapi-network) and ERC-7710 (internet-court). Outside crypto I found nothing above 100 stars.
- **[I]** Budgets, spend caps per agent and per task, and receipts tied to agent identity are missing for card and bank rails. This is lower confidence than A–D because fintech incumbents may hold this outside GitHub.

Smaller openings, lower confidence:
- **Mobile-agent safety and permissions** [I]. Phone agents are surging with no permission model beyond "human in the loop" (pinky).
- **Production trace-to-eval loops** [E]. Tracely-ai and Tracekit sit at about 1k stars while local monitors thrive.
- **Agent-native backends** [E]. pgboxdb, sentio and instacloud are all small but conceptually coherent: "each agent gets its own DB, inbox and cloud."

---

## 4. Suspicious star inflation and other noise [E with I]

**High-risk lure (inflation plus security concern)**
- **Ebony-Vinyl/dsh-our-free-model:** 85,269 stars in 60 days (about 1,421/day). It offers "no login, no API key, free unlimited" frontier models (DeepSeek V4.1 Flash, Kimi K3) as a DSH plugin.
- **[I]** This is either a reverse proxy over someone else's quota or a traffic and credential interception lure. It should not count as signal of a real primitive.

**Unverifiable mega-star repo**
- **deepseek-ai/deepseek-harness:** 286k stars and 35.6k forks, but `search/issues` returns 0 issues and 0 PRs. Issues may be disabled.
- **[I]** It comes from the official org and has a huge plugin ecosystem, so it is probably real interest. It still dominates any star ranking, so treat its absolute numbers cautiously.

**Very low fork/star ratio (under 1%) and/or new accounts**
| Repo | Stars | Forks | Notes |
|---|---|---|---|
| AhmadHassan-BTed/Jantt | 6,240 | 23 | 2 issues |
| spinabot/brigade | 11,390 | 81 | 6 issues, 225 PRs (likely bot PRs); owner account created 2026 |
| aakarim/OpenLore | 1,843 | 13 | 1 issue, 243 PRs |
| helloHub1212/dsh-windows-mcp | 2,343 | 11 | Owner account created 2026 |
| Folkbench/folkbench | 3,544 | 21 | 0 issues; owner account created 2026; promotes "API relay" resellers |
| Player-YN/BrowserKitten | 2,402 | 16 | Owner account created 2026 |
| lennney/stop-that-shit | 4,085 | 87 | |
| securetron-gh/aifw | 415 | 3 | |
| ZenlixAI/skill-dock | 730 | 0 | |
| dengyier/OpenWorkProof | 261 | 0 | |

**Forks close to stars (possible fork farming, or coursework/CTF activity)**
| Repo | Stars | Forks |
|---|---|---|
| jiwoochris/artex-global | 4,731 | 3,789 |
| BaaRai/ARTEX | 18,003 | 6,713 |
| N1nEmAn/sapper-v2 | 2,599 | 1,259 |
| agentrhq/webcmd | 2,801 | 1,533 |
| ZiChuanLan/agent-purge | 2,100 | 1,131 |
| flop-labs/tclk | 21 | 75 |

**SEO spam**
- Three repos from random-name accounts, each created 11-11 to 11-13 with about 80 stars and 0 forks, titled as "virtual-card-usdt… FinOps guides":
  - DarenHsin308365/virtual-card-usdt-claude-code-autonomous-agents-vcc
  - ArmaniGustafsson016225/mitigating-stripe-radar-…
  - DanyellSpizzirri42399/virtual-card-usdt-enterprise-rag-…

**Clones and rebrands**
- superdesigndev/treg and monid-ai/monid share the identical tagline "OpenRouter for agent tools."
- Jwuthri/Tracely-ai and jwuthri-cloud/Tracely-ai are duplicates.

**Off-topic tag pollution**
- Gathin23/cleanyourtv (60k, Android TV debloat), DuarteSantos8/openGym and simbasjungles/free-my-tv are tagged `claude-code`/`mcp` because they were built with agents, not for agents. This inflates topic totals.
- **[I]** Topic counts for claude-code and mcp overstate "agent infrastructure" activity.

---

## 5. Hacker News signal (Sept–Nov 2026, weak) [E]

- Show HN: "Run coding agents with your whole team" (Pangea, 2026-11-21), via buzzing.cc
- Show HN: "Agent Guard" (2026-11-20), a limit on what a manipulated agent can do
- Show HN: "Agent Hive" (2026-11-19), multi-agent teams
- Show HN: "Agent World" (2026-11-18), multi-provider coding-agent playbooks
- Show HN: "Control Layer Demo for AI Coding Agents" (2026-11-09)
- Show HN: "Coding agent skills, tested on 15 backend tasks with hidden checks" (2026-11-07)
- Show HN: "Coding agents need a tap from your watch, not API keys" (2026-10-30)
- Earlier in 2026: Show HN agent sandbox with a transactional, versioned filesystem (Tilde.run, 204 points); Vet (imbue), which prevents coding-agent mistakes.
- Ask HN "What are you working on? (Nov 2026)": Epoptes, for running Claude, Codex, Pi and Antigravity autonomously for long periods with monitoring and steering. https://news.ycombinator.com/item?id=50417407
- Simon Willison, 2026-11-17: "External sandboxes for coding agents." https://simonwillison.net/2026/Nov/17/external-sandboxes-for-coding-agents/

**[I]** The Show HN themes match the gaps: control and guard layers, approval instead of keys, skill testing, and team orchestration. Traction was low on each post, so they show builders converging on these themes rather than proven demand.

Sources:
- [buzzing.cc Show HN 2026-11-21](https://i.buzzing.cc/en/showhn/posts/2026/47/en_hn_2026_11_21__50584580/)
- [buzzing.cc Show HN 2026-11-09](https://i.buzzing.cc/en/showhn/posts/2026/46/en_hn_2026_11_09__50422833/)
- [buzzing.cc Show HN 2026-11-07](https://i.buzzing.cc/en/showhn/posts/2026/45/en_hn_2026_11_07__50402468/)
- [buzzing.cc Show HN 2026-10-30](https://i.buzzing.cc/en/showhn/posts/2026/44/en_hn_2026_10_30__50297971/)
- [buzzing.cc Show HN 2026-11-18](https://i.buzzing.cc/en/showhn/posts/2026/47/en_hn_2026_11_18__50544012/)
- [buzzing.cc Show HN 2026-11-19](https://i.buzzing.cc/en/showhn/posts/2026/47/en_hn_2026_11_19__50554228/)
- [buzzing.cc Show HN 2026-11-20](https://i.buzzing.cc/en/showhn/posts/2026/47/en_hn_2026_11_20__50575068/)
- [HN Show page](https://news.ycombinator.com/show)
- [Ask HN: What are you working on? Nov 2026](https://news.ycombinator.com/item?id=50417407)
- [Simon Willison, External sandboxes for coding agents](https://simonwillison.net/2026/Nov/17/external-sandboxes-for-coding-agents/)
- [AI builders digest, Nov 4 2026](https://buttondown.com/soumyo/archive/ai-builders-digest-wednesday-november-4-2026/)
