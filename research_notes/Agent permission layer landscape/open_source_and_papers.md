# Open-source projects and papers close to a neutral agent permission layer

Scope: open-source projects and papers that combine two or more of the following for AI agents: attenuable capability tokens, verified or declarative policy, plan/approve/apply, snapshot-based undo, tamper-evident logs, OS sandboxing, and MCP or multi-agent delegation. The target is "a neutral layer where any AI agent acts on the user's own machines with previewed plans, narrow-only delegated capability passes, verified policies, undo, receipts and sandboxing."

Method and caveats:
- Star counts, creation dates and "last push" dates come from the GitHub search API (`gh api search/repositories`), queried on 2026-11-24. "Last push" is the repo's `pushed_at` value: the most recent push to any branch, which is close to the last commit date but not the same thing.
- Feature claims come from each repo's README as fetched on 2026-11-24. These are self-descriptions, not audits.
- Many relevant repos were created in 2026 and already have hundreds or thousands of stars. Treat star counts on young repos with caution (see Inferences).

---

## Q1. Which repos combine Biscuit/Macaroons/UCAN/Cedar with MCP or AI agents? How active and popular are they?

### Takeaway
The token and policy foundations are mature and active: Cedar (1.9k stars), OPA (12.5k), Cerbos (4.7k) and Biscuit (1.2k) all had pushes this week. Projects that apply them to agents are young (created 2026) and small, usually under about 250 stars. Tenuo is the clearest narrow-only capability token for agents with MCP enforcement. StrongDM Leash is the most visible Cedar-for-agents project. No sizable project wires Biscuit or UCAN directly into MCP.

### Cited Findings

**Building blocks (stars / last push as of 2026-11-24)**
- **cedar-policy/cedar:** 1,895 stars, pushed 2026-11-24. **cedar-policy/cedar-spec** (the Lean model and differential-testing "definitional implementation"): 230 stars, pushed 2026-11-24. — [GitHub cedar](https://github.com/cedar-policy/cedar), [GitHub cedar-spec](https://github.com/cedar-policy/cedar-spec)
- **Cedar verification:**
  - Cedar was formalized in Lean, and key properties were proved there. The symbolic compiler, which turns policies into SMT-LIB, is also written and proved correct in Lean. — [How We Built Cedar, arXiv 2407.01688](https://arxiv.org/pdf/2407.01688); [AWS blog: Lean into verified software development](https://aws.amazon.com/blogs/opensource/lean-into-verified-software-development/)
  - AWS open-sourced a Cedar Symbolic Compiler and a Cedar Analysis CLI. Equivalence of two policy sets can be checked by an SMT solver: an UNSAT result means they are equivalent. — [AWS blog: Introducing Cedar Analysis](https://aws.amazon.com/blogs/opensource/introducing-cedar-analysis-open-source-tools-for-verifying-authorization-policies); [docs.rs cedar-policy-symcc](https://docs.rs/cedar-policy-symcc)
  - SymCert, a framework for building verified SMT-based analyses in Lean, was used to verify five analyses in a Cedar analysis service at AWS. — [SymCert paper (Amazon Science PDF)](https://cdn.amazon.science/9f/c9/5d18658a41c48628b686493aa327/scipub-approval152134-46496997-symcert-verifying-smtbased-policy-analyses.pdf)
- **Other engines and token formats:**
  - **open-policy-agent/opa:** 12,512 stars, pushed 2026-11-24. **cerbos/cerbos:** 4,668 stars, pushed 2026-11-23. Cerbos now describes itself as "authorizing every identity and governing every action." — [OPA](https://github.com/open-policy-agent/opa), [Cerbos](https://github.com/cerbos/cerbos)
  - **eclipse-biscuit/biscuit** (spec): 1,173 stars, pushed 2026-11-21. **eclipse-biscuit/biscuit-rust:** 254 stars, pushed 2026-11-21. Biscuit moved from the biscuit-auth org to Eclipse. — [biscuit](https://github.com/eclipse-biscuit/biscuit), [biscuit-rust](https://github.com/eclipse-biscuit/biscuit-rust)
  - **ucan-wg/spec:** 300 stars, pushed 2026-10-22. **superfly/macaroon** (Fly.io's macaroon implementation): 124 stars, pushed 2026-11-12. — [UCAN spec](https://github.com/ucan-wg/spec), [superfly/macaroon](https://github.com/superfly/macaroon)

**Agent-specific projects**
- **tenuo-ai/tenuo:** 109 stars, pushed 2026-11-24, Apache-2.0, version about 0.3.7.
  - Provides "cryptographic warrants" that list tools, argument constraints, holder key and expiry, verified offline.
  - Delegation is narrow-only ("Subtractive Delegation"): a child warrant that tries to widen its parent is rejected with `MonotonicityError`. The README says it is "inspired by" Macaroons, Biscuit and UCAN and references an IETF Internet-Draft.
  - Enforces at MCP tool servers (FastMCP, the official SDK, custom servers) and supports LangChain, LangGraph, Google ADK, CrewAI, AutoGen, A2A and Temporal.
  - Signed authorization receipts are opt-in.
  - It is explicitly not a sandbox and recommends a container or VM.
  - Source: [GitHub tenuo](https://github.com/tenuo-ai/tenuo)
- **strongdm/leash:** 600 stars, last push 2026-04-06 (about 7 months idle), Apache-2.0, 77 commits.
  - Wraps Claude, Codex, Gemini, Qwen and OpenCode in containers. A separate "Leash container" monitors syscalls and enforces **Cedar** policies.
  - An "MCP observer" inspects, records and enforces MCP tool calls and correlates them with filesystem and network telemetry.
  - There is an experimental native macOS mode. No per-action approval workflow is described.
  - Source: [GitHub leash](https://github.com/strongdm/leash)
- **Garudex-Labs/caracal:** 228 stars, pushed 2026-11-23, Apache-2.0, v1.0.0.
  - Uses short-lived signed "mandates" where "delegated authority can only shrink." It is built on OAuth 2.0 Token Exchange (RFC 8693) rather than Biscuit or Macaroons.
  - Uses **OPA** default-deny policy, a gateway that injects credentials, MCP server verification, approval gates, a tamper-evident append-only audit trail and a one-call revocation kill switch.
  - Has no sandbox and no undo of executed actions.
  - Source: [GitHub caracal](https://github.com/Garudex-Labs/caracal)
- **Raj-glitch-max/atlas:** 106 stars, created 2026-07-03, last push 2026-10-29. Description: "scoped, attenuable tokens bound to SPIFFE workload identity." — [GitHub atlas](https://github.com/Raj-glitch-max/atlas)
- **dtkav/agent-creds:** 32 stars, last push 2026-08-29. Provides ephemeral agent credentials using **macaroons**, with Envoy as a transparent proxy. — [GitHub agent-creds](https://github.com/dtkav/agent-creds)
- **M64GitHub/clawgate:** 19 stars, created 2026-02-01, last push 2026-02-09 (dormant). A "zero-trust capability proxy for AI agents" for files, git and tools via signed tokens. — [GitHub clawgate](https://github.com/M64GitHub/clawgate)
- **agent-passport-system/agent-passport-system:** 67 stars, pushed 2026-11-22. A protocol and TypeScript SDK covering identity, scoped delegation, and enforcement before the action. — [GitHub](https://github.com/agent-passport-system/agent-passport-system)
- **Cedar demos and tools:**
  - **aws-samples/sample-cedar-agentic-ai-authorization:** 6 stars, last push 2026-07-03. Uses Cedar for least privilege in multi-agent delegation chains. — [GitHub](https://github.com/aws-samples/sample-cedar-agentic-ai-authorization)
  - **Pigius/cedar-mcp-server:** 8 stars, last push 2026-05-23. An MCP server to validate, authorize, diff and plan Cedar policy changes. — [GitHub](https://github.com/Pigius/cedar-mcp-server)
  - **permitio/cedar-agent:** 205 stars, last push 2025-10-16. A generic Cedar PDP server, not AI-specific despite the name. — [GitHub](https://github.com/permitio/cedar-agent)
- **cerbos/cerbos-mcp-authorization-demo:** 6 stars, pushed 2026-11-16. A demo MCP server that uses Cerbos to authorize tool access. — [GitHub](https://github.com/cerbos/cerbos-mcp-authorization-demo)
- **kanywst/mcp-opa-authz:** 1 star, pushed 2026-11-23. An MCP server that evaluates Rego in-process. — [GitHub](https://github.com/kanywst/mcp-opa-authz)
- **UCAN with agents:** Only tiny repos turned up, for example Zahanturel/adtp (2 stars, "UCAN chains, RESTRICT mode") and receipt-commons/receipt-interop (0 stars, verifies UCANs and agent delegation receipts). — [adtp](https://github.com/Zahanturel/adtp), [receipt-interop](https://github.com/receipt-commons/receipt-interop)
- GitHub search for "biscuit mcp" and "macaroon agent" returned no repos with meaningful adoption. — GitHub search API, 2026-11-24

### Inferences
- No dominant open-source "capability pass for agents" exists yet. Tenuo is closest on narrow-only and offline-verifiable semantics with MCP enforcement; Caracal is closest on a full control plane (OPA, approvals, audit, revocation). Neither does sandboxing or undo.
- Biscuit's Datalog caveats and third-party blocks fit narrow-only agent passes well, yet nobody has packaged Biscuit plus MCP. Projects either borrow the idea (Tenuo) or use OAuth token exchange (Caracal).
- Cedar's Lean-verified analysis is used for agents only at demo scale (aws-samples, Leash). Nobody yet uses the SMT analyzer to prove that a delegated pass is a subset of its parent's policy, which is an open niche.

### Gaps
- I could not check commit histories directly: the GitHub repos API was blocked in this session, and only the search API worked. Last-commit dates are therefore approximated by `pushed_at`.
- I did not determine whether Tenuo's warrant format is Biscuit-compatible or a custom encoding. The README defers to a "Related Work" doc and an IETF draft I did not open.

---

## Q2. Which projects provide snapshot-based undo or rollback for coding or computer-use agents?

### Takeaway
Undo is now built into mainstream coding agents (Claude Code `/rewind`, Gemini CLI `/restore` with a shadow git repo). Several open-source sandboxes add workspace snapshots, notably nono, agentsh, hazmat (Kopia snapshots) and arrakis (VM snapshots). Coverage is limited to local files. Shell-command side effects (in Claude Code) and all external effects such as email or API calls are not undoable, a gap that 2026 research papers explicitly name.

### Cited Findings

**Built into agents**
- **Claude Code** creates a checkpoint at every user prompt and offers separate "restore conversation" and "restore code" options.
  - Checkpointing does **not** track files modified by bash commands, and edits made by subagents are usually not captured.
  - Snapshots are deleted about 30 days after the session last saved one, and the docs say checkpoints are not a substitute for version control.
  - Source: [Claude Code checkpointing docs](https://code.claude.com/docs/en/checkpointing)
- **Gemini CLI** checkpointing commits to a **shadow Git repo** at `~/.gemini/history/<project_hash>`. `/restore` restores files and conversation, and the feature is enabled via `settings.json`. — [Gemini CLI checkpointing docs](https://geminicli.com/docs/cli/checkpointing.md). google-gemini/gemini-cli has 109,032 stars, pushed 2026-11-24 — [GitHub](https://github.com/google-gemini/gemini-cli)
- **RonitSachdev/ccundo:** 1,399 stars, last push 2025-07-27 (stalled). Its description now says "[claude now natively supports this feature]," so it was superseded by native checkpoints. — [GitHub ccundo](https://github.com/RonitSachdev/ccundo)
- **Ixe1/claude-code-checkpointing-hook:** 15 stars, last push 2025-07-06. Creates git checkpoints via Claude Code hooks; stalled, presumably for the same reason. — [GitHub](https://github.com/Ixe1/claude-code-checkpointing-hook)

**Sandboxes and harnesses with snapshots**
- **nolabs-ai/nono:** 5,086 stars, pushed 2026-11-23, Apache-2.0.
  - Kernel-enforced sandboxing on macOS, Linux and WSL2. Satellite repos (langchain-nono) name Landlock and Seatbelt.
  - Can "restore tracked files from verified snapshots" after agent mistakes.
  - Keeps a tamper-evident session audit with integrity verification and optional signing.
  - Policy is set by agent-immutable JSON profiles covering filesystem, network, credentials and per-tool rules, plus phantom-token credential injection and Sigstore attestation for skills and hooks.
  - Its README says it was "Built by the team that brought you Sigstore."
  - Sources: [GitHub nono](https://github.com/nolabs-ai/nono); [langchain-nono](https://github.com/nolabs-ai/langchain-nono)
- **canyonroad/agentsh:** 412 stars, pushed 2026-11-08, Apache-2.0, 1,516 commits.
  - Workspace checkpoints can be created, listed, diffed, rolled back (with dry-run) and purged. Auto-checkpoints run before `rm`, `mv` and `git reset`, and a `soft_delete` policy decision quarantines deletes for restore.
  - Source: [GitHub agentsh](https://github.com/canyonroad/agentsh)
- **dredozubov/hazmat:** 180 stars, pushed 2026-11-20, MIT, macOS only.
  - Takes a pre-session **Kopia** snapshot, with `hazmat diff`, `hazmat snapshots` and `hazmat restore`.
  - Runs the agent as a dedicated macOS user under a per-session `sandbox-exec` (Seatbelt) policy, adds `pf` firewall rules, and prints a "session contract" before launch.
  - Its TLA+ models are "partial" verification.
  - Supports 8 harnesses (Claude Code, Codex, OpenCode, Cursor Agent and others).
  - Source: [GitHub hazmat](https://github.com/dredozubov/hazmat)
- **abshkbh/arrakis:** 897 stars, last push 2025-06-02 (stalled about 18 months). A self-hosted sandbox for code execution and computer use; its description notes snapshot features. — [GitHub arrakis](https://github.com/abshkbh/arrakis)
- **dagger/container-use:** 4,104 stars, pushed 2026-11-14. Gives each agent its own container environment, with git-branch isolation per the project description. — [GitHub](https://github.com/dagger/container-use)
- **Continuum-AI-Corp/OrcaReplay:** 1,162 stars, created 2026-08-29, last push 2026-10-01. "Time travel for AI agents" that records, replays, forks and debugs runs. This is replay of the agent run, not filesystem undo. — [GitHub](https://github.com/Continuum-AI-Corp/OrcaReplay)

**Research**
- **DeltaBox** (arXiv 2605.22781, May 2026): millisecond-scale checkpoint and rollback of the whole sandbox, files plus process state, using incremental deltas. — [arXiv](https://arxiv.org/abs/2605.22781)
- **AgentRewind** (arXiv 2608.14380, Aug 2026): restores agent context together with environment state. Effects outside the workspace filesystem, such as network requests or external services, cannot be undone. — [arXiv](https://arxiv.org/abs/2608.14380)
- **Atomix** (arXiv 2602.14849, Feb 2026): checkpoint rollback cannot recall an email, booking or remote API update. It proposes transactional staging of tool effects with commit or abort. — [arXiv](https://arxiv.org/abs/2602.14849)
- **"Safe to Resume?"** (arXiv 2608.29381, Aug 2026): a faithfully restored checkpoint may resume an execution "whose states, assumptions, and external effects never coexisted in any valid history." This is a security argument against naive rollback. — [arXiv](https://arxiv.org/abs/2608.29381)
- **GoEX** (Gorilla team, UC Berkeley; arXiv 2404.06921, Apr 2024): proposes a runtime for autonomous LLM applications built on "post-facto validation" with undo and damage confinement. It was a direct early proposal of the "undo + blast-radius" design. — [arXiv](https://arxiv.org/abs/2404.06921). ShishirPatil/gorilla has 13,085 stars, pushed 2026-10-17 — [GitHub](https://github.com/ShishirPatil/gorilla)

### Inferences
- File-level undo is commoditized in agent CLIs, so a neutral layer cannot differentiate on "undo for code edits" alone. The open space is undo that covers bash and subprocess effects (agentsh, nono and hazmat attempt this), whole-machine snapshots (APFS, btrfs, ZFS), and honest labeling of effects that cannot be undone (Atomix's point).
- ccundo and the checkpoint hooks stalled because the agent vendor shipped the feature natively. That is a recurring risk for any agent-specific add-on.

### Gaps
- No open-source project turned up that uses APFS local snapshots or btrfs/ZFS snapshots specifically as an agent undo mechanism. Hazmat uses Kopia (file-level backup) instead. A targeted search might find small ones.
- I did not verify arrakis's snapshot mechanism beyond its repo description.

---

## Q3. Which projects provide tamper-evident logs for agent actions?

### Takeaway
2026 brought a wave of "agent receipts" and hash-chained audit projects. The most rigorous open-source one is Tracekit (862 stars): Ed25519 over RFC 8785 JSON, RFC 6962 Merkle trees, C2SP signed notes, and experimental witness cosigning, "built like Certificate Transparency." Others (asqav, obsigna, nono, Caracal, agentvault) use signed or hash-chained logs. Anchoring in a public transparency log (Rekor) is rare and appears only in tiny repos. The underlying transparency infrastructure (Rekor, Trillian, Tessera) is mature and active.

### Cited Findings
- **Cygnux-Labs/Tracekit:** 862 stars, created 2026-09-26, pushed 2026-11-24, MIT, version 1.7.2.
  - Each run is a signed hash chain: Ed25519 over RFC 8785 canonical JSON, RFC 6962 Merkle trees, and C2SP signed notes with cosignatures. Independent witness cosigning is experimental.
  - Decides each tool call (allow, deny or hold) using "policy packs" for shell, files, SQL, HTTP, cloud CLIs, email, payments, secrets and MCP. The README admits the rules "match text and tool names" and are "tripwires, not a wall."
  - An approval is bound to its exact arguments and used once. Approvals can come from passkeys on a web page, Slack (experimental) or a reviewer agent.
  - It is not a sandbox and has no undo. A companion project, "Tracekit Box," runs jobs in Firecracker microVMs with no network card.
  - Source: [GitHub Tracekit](https://github.com/Cygnux-Labs/Tracekit)
- **jagmarques/asqav-sdk:** 508 stars, created 2026-01-14, pushed 2026-11-23. "Verifiable evidence of AI agent actions. Signed receipts, policy enforcement, audit trail." — [GitHub](https://github.com/jagmarques/asqav-sdk)
- **agent-receipts/obsigna:** 23 stars, pushed 2026-11-21, Apache-2.0. "Agent Receipts": a protocol spec plus Go, TypeScript and Python SDKs for cryptographically signed audit trails. — [GitHub](https://github.com/agent-receipts/obsigna)
- **MetapriseAI/OrgKernel:** 2,671 stars, created 2026-03-25, last push 2026-07-06 (about 4.5 months idle). "Trust layer for AI agents": Ed25519 agent identity, instance-scoped execution tokens, SHA-256 chain. — [GitHub](https://github.com/MetapriseAI/OrgKernel)
- **Smaller hash-chain and Merkle projects:**
  - bkuan001/halo-record (86 stars): hash-chained runtime records.
  - brandynfisher/ToolReplay (50 stars): hash-chain sealing and replay of tool-call transcripts.
  - ZIZKA-AI-SL/ZizkaDB (163 stars): tamper-evident decision logs with time-travel debugging.
  - asinadarsh/attestor (1 star): RFC 6962 Merkle checkpoints anchored in Sigstore.
  - ark-forge/trust-layer (2 stars): proof chain with RFC 3161 timestamps and Sigstore.
  - aileron-sh/aileron (1 star): a hash-chained, signed flight recorder with an MCP proxy.
  - Sources: [halo-record](https://github.com/bkuan001/halo-record), [ToolReplay](https://github.com/brandynfisher/ToolReplay), [ZizkaDB](https://github.com/ZIZKA-AI-SL/ZizkaDB), [attestor](https://github.com/asinadarsh/attestor), [trust-layer](https://github.com/ark-forge/trust-layer), [aileron](https://github.com/aileron-sh/aileron)
- **Tamper-evident audit as one feature among several:** nono (tamper-evident session audit with optional signing) — [nono](https://github.com/nolabs-ai/nono); Caracal (append-only tamper-evident trail) — [caracal](https://github.com/Garudex-Labs/caracal); aashish254/agentvault (80 stars, YAML policies, one-tap macOS or Telegram approvals, "tamper-evident sign[ed]" logs) — [agentvault](https://github.com/aashish254/agentvault); Mindburn-Labs/helm-ai-kernel (56 stars, a fail-closed firewall that "emit[s] signed receipts") — [helm-ai-kernel](https://github.com/Mindburn-Labs/helm-ai-kernel)
- **Transparency-log infrastructure:** sigstore/rekor (1,238 stars, pushed 2026-11-22), google/trillian (3,766 stars, pushed 2026-11-18), transparency-dev/tessera (263 stars, tile-based tlogs, pushed 2026-11-23). — [Rekor](https://github.com/sigstore/rekor), [Trillian](https://github.com/google/trillian), [Tessera](https://github.com/transparency-dev/tessera)
- **Research:** "Authenticated Delegation and Authorized AI Agents" (South, Marro, Hardjono, Mahari et al.; arXiv 2501.09674, Jan 2025) proposes a framework for "authenticated, authorized, and auditable delegation" built on OAuth and OpenID-style credentials. — [arXiv](https://arxiv.org/abs/2501.09674)

### Inferences
- Signed, hash-chained receipts are converging on CT-style primitives (RFC 6962 Merkle trees, C2SP signed notes, witnesses), and Tracekit is the reference implementation in this space. The missing piece for a personal-machine layer is a lightweight local log plus optional public or witness anchoring that a third party can verify. Tracekit's witnesses point that way but are experimental.
- Many audit-receipt repos are less than 10 months old and overlap heavily. Expect consolidation, and possibly an IETF or C2SP receipt format.

### Gaps
- I did not verify asqav's or OrgKernel's cryptographic design beyond their repo descriptions.
- I found no evidence that any project anchors per-action agent receipts in the public Sigstore Rekor instance at scale. Only 1–2-star repos claim it.

---

## Q4. Which open-source MCP proxies and gateways add policy or approval?

### Takeaway
The MCP gateway space is crowded and active. Large projects such as agentgateway (6.4k stars), IBM ContextForge (4.9k), docker/mcp-gateway (1.6k) and microsoft/mcp-gateway (0.9k) focus on routing, auth and registry, with policy as one feature. Security-first gateways and firewalls (pipelock, cordum, agentsh, Tracekit, Caracal, agentvault) add allow/deny, human approval and audit. Early entrants, including eqtylab mcp-guardian, the Invariant gateway and Trail of Bits' mcp-context-protector, have gone quiet or been archived.

### Cited Findings

**Routing, auth and registry gateways**
- **agentgateway/agentgateway:** 6,387 stars, pushed 2026-11-24. "Next Generation Agentic Proxy for AI Agents and MCP servers." — [GitHub](https://github.com/agentgateway/agentgateway)
- **IBM/mcp-context-forge:** 4,880 stars, pushed 2026-11-23. A gateway, registry and proxy for MCP, A2A and REST/gRPC. — [GitHub](https://github.com/IBM/mcp-context-forge)
- **docker/mcp-gateway:** 1,647 stars, pushed 2026-11-19. — [GitHub](https://github.com/docker/mcp-gateway). **microsoft/mcp-gateway:** 925 stars, pushed 2026-11-21, a reverse proxy and management layer. — [GitHub](https://github.com/microsoft/mcp-gateway)
- **sparfenyuk/mcp-proxy:** 2,836 stars, pushed 2026-11-23. A transport bridge (stdio to Streamable HTTP) with no policy. — [GitHub](https://github.com/sparfenyuk/mcp-proxy). **TBXark/mcp-proxy:** 747 stars, an aggregator. — [GitHub](https://github.com/tbxark/mcp-proxy)
- **hyprmcp/mcp-gateway:** 92 stars, last push 2026-04-21. OAuth proxy with dynamic client registration and an "MCP firewall." — [GitHub](https://github.com/hyprmcp/mcp-gateway)
- **lasso-security/mcp-gateway:** 403 stars, last push 2026-01-22. A plugin-based gateway with security plugins. — [GitHub](https://github.com/lasso-security/mcp-gateway)

**Security-focused gateways and firewalls**
- **pipelab-org/pipelock:** 1,020 stars, created 2026-02-08, pushed 2026-11-24, Apache-2.0. An "AI agent firewall for MCP security and agent egress" that scans HTTP, MCP, A2A and WebSocket traffic. — [GitHub](https://github.com/pipelab-org/pipelock)
- **cordum-io/cordum:** 508 stars, pushed 2026-11-19, license not detected by GitHub. "Enforce policy and human approval before risky tool calls, shell commands, workflows." — [GitHub](https://github.com/cordum-io/cordum)
- **hashgraph-online/hol-guard:** 1,122 stars. **denoland/clawpatrol:** 1,096 stars, a security firewall for agents from Deno. **hardenrun/aif:** 1,963 stars, last push 2026-09-05, an on-device firewall for coding and personal agents. — [hol-guard](https://github.com/hashgraph-online/hol-guard), [clawpatrol](https://github.com/denoland/clawpatrol), [aif](https://github.com/hardenrun/aif)
- **openagentidentityprotocol/agentidentityprotocol:** 38 stars, last push 2026-03-05. A policy-enforcement proxy for MCP with human-in-the-loop. — [GitHub](https://github.com/openagentidentityprotocol/agentidentityprotocol)
- **ressl/mcp-firewall:** 22 stars, AGPL-3.0. Policy, threat detection and compliance audit. — [GitHub](https://github.com/ressl/mcp-firewall)
- **NVIDIA/Nomos:** 26 stars, created 2026-05-22, pushed 2026-11-23. "Stops AI agents from taking unwanted or overeager actions"; it reviews each proposed action against the agent's own context. — [GitHub](https://github.com/NVIDIA/Nomos)
- **withcoral/coral:** 5,030 stars, created 2026-04-03. "Execution rails for agents ... precise permissions." — [GitHub](https://github.com/withcoral/coral)

**Stalled or archived early entrants**
- **eqtylab/mcp-guardian:** 205 stars, last push **2025-08-08** (about 15 months idle). "Manage / Proxy / Secure your MCP Servers." — [GitHub](https://github.com/eqtylab/mcp-guardian)
- **Invariant Labs:**
  - invariantlabs-ai/invariant (Guardrails): 479 stars, last push 2026-01-12.
  - invariantlabs-ai/invariant-gateway: 83 stars, last push 2025-11-06.
  - Snyk acquired Invariant Labs on 2025-06-24. MCP-Scan now lives on as **snyk/agent-scan** (3,275 stars, pushed 2026-11-23).
  - Sources: [invariant](https://github.com/invariantlabs-ai/invariant), [invariant-gateway](https://github.com/invariantlabs-ai/invariant-gateway), [Snyk press release](https://snyk.io/news/snyk-acquires-invariant-labs-to-accelerate-agentic-ai-security-innovation), [snyk/agent-scan](https://github.com/snyk/agent-scan)
- **trailofbits/mcp-context-protector:** 228 stars, **archived**, last push 2026-04-14. — [GitHub](https://github.com/trailofbits/mcp-context-protector)
- **pydantic/mcp-run-python:** 193 stars, **archived**, last push 2026-01-30. — [GitHub](https://github.com/pydantic/mcp-run-python)

**MCP authorization spec**
- In the 2025-11-25 revision, MCP servers MUST implement OAuth 2.0 Protected Resource Metadata (RFC 9728), and clients use Resource Indicators (RFC 8707). A 2026-07-28 spec revision exists and appears to be current. — [MCP authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization); [MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

### Inferences
- The MCP spec's authorization covers *who the client is* (OAuth) and *which server a token is for*. It does not cover per-call argument constraints, attenuation across sub-agents, or receipts. Every gateway fills that gap differently, and none has become a de-facto standard.
- Early proxy projects stalled for three apparent reasons: acquisition (Invariant to Snyk), absorption of the feature into big gateways and agent CLIs, and a limited security model. The Tracekit README says text-matching policy is "tripwires, not a wall."

### Gaps
- I did not verify which policy languages agentgateway, ContextForge, Docker or Microsoft gateways use (CEL, OPA, RBAC and so on), or whether they support human approval. Fetching their docs is needed.
- Download and usage numbers for these gateways were not available.

---

## Q5. Does any project attempt most of the stack? What stalled and why?

### Takeaway
No open-source project covers all seven building blocks. The closest are nono (sandbox, snapshot undo, tamper-evident audit, immutable policy profiles, credential injection), agentsh (sandbox via seccomp/FUSE/eBPF and AppContainer, YAML policy, human approval, checkpoints and rollback, audit, MCP controls), and Caracal (narrow-only mandates, OPA, approvals, tamper-evident audit, MCP). The consistently missing pieces are (a) attenuable, offline-verifiable capability tokens combined with OS sandboxing, (b) formally verified policy such as Cedar or SMT analysis, and (c) a previewed plan/approve/apply step over a whole multi-step plan rather than per-call holds.

### Cited Findings

Coverage matrix, from README claims. Legend: Y = yes; P = partial or experimental; – = not described.

| Project | Stars / last push | Narrow-only cap tokens | Policy engine | Plan/approve | Undo | Tamper-evident log | OS sandbox | MCP |
|---|---|---|---|---|---|---|---|---|
| [nolabs-ai/nono](https://github.com/nolabs-ai/nono) | 5,086 / 2026-11-23 | – (phantom tokens for creds) | JSON profiles | – | Y (snapshots) | Y (optional signing) | Y (kernel) | topic only |
| [canyonroad/agentsh](https://github.com/canyonroad/agentsh) | 412 / 2026-11-08 | – | YAML rules | Y (per-action: TTY/TOTP/WebAuthn) | Y (checkpoints, soft_delete) | audit (not stated as signed) | Y (Linux, macOS ESF, Windows AppContainer) | Y |
| [Garudex-Labs/caracal](https://github.com/Garudex-Labs/caracal) | 228 / 2026-11-23 | Y (mandates, RFC 8693) | OPA | Y (approval gates) | – (revocation only) | Y | – | Y |
| [tenuo-ai/tenuo](https://github.com/tenuo-ai/tenuo) | 109 / 2026-11-24 | Y (warrants) | – | – | – | P (opt-in receipts) | – | Y |
| [Cygnux-Labs/Tracekit](https://github.com/Cygnux-Labs/Tracekit) | 862 / 2026-11-24 | – | policy packs | Y (per-call, arg-bound) | – | Y (Merkle, C2SP, witnesses P) | P (Tracekit Box, Firecracker) | Y |
| [strongdm/leash](https://github.com/strongdm/leash) | 600 / 2026-04-06 | – | Cedar | – | – | telemetry | Y (container) | Y (observer) |
| [dredozubov/hazmat](https://github.com/dredozubov/hazmat) | 180 / 2026-11-20 | – | session contract | P (pre-launch contract) | Y (Kopia) | – | Y (macOS Seatbelt + user) | – |
| [aashish254/agentvault](https://github.com/aashish254/agentvault) | 80 / 2026-11-23 | – | YAML | Y (one-tap) | – | Y | – | per description |

Supporting details for the matrix:
- **agentsh** platform scores: Linux 100%, macOS ESF+NE 90% (Alpha), Windows native (minifilter + AppContainer) 85% "awaiting driver signing." Its approval modes are `local_tty`, `totp`, `webauthn` and `api`, and its MCP controls cover tool allow/deny, version pinning and cross-server exfiltration detection. — [agentsh](https://github.com/canyonroad/agentsh)
- **Sandbox primitives** (all active, pushed 2026-11):
  - anthropics/sandbox-runtime: 7,247 stars; filesystem and network restrictions at the OS level.
  - superradcompany/microsandbox: 9,195 stars; microVMs.
  - gvisor/gvisor: 20,099 stars.
  - firecracker-microvm/firecracker: 38,192 stars.
  - google/nsjail: 4,203 stars.
  - bytecodealliance/wasmtime: 18,891 stars.
  - microsoft/wassette: 977 stars; runs Wasm components via MCP.
  - kubernetes-sigs/agent-sandbox: 4,699 stars.
  - e2b-dev/E2B: 14,987 stars.
  - Sources: [sandbox-runtime](https://github.com/anthropics/sandbox-runtime), [microsandbox](https://github.com/superradcompany/microsandbox), [gVisor](https://github.com/gvisor/gvisor), [Firecracker](https://github.com/firecracker-microvm/firecracker), [nsjail](https://github.com/google/nsjail), [wasmtime](https://github.com/bytecodealliance/wasmtime), [wassette](https://github.com/microsoft/wassette), [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox), [E2B](https://github.com/e2b-dev/E2B)
- **openai/codex:** 136,265 stars, pushed 2026-11-24. Ships its own OS sandboxing. — [GitHub](https://github.com/openai/codex)
- **Stalled or dormant projects (facts):**
  - eqtylab/mcp-guardian: last push 2025-08-08.
  - RonitSachdev/ccundo: last push 2025-07-27; it self-declares obsolescence because Claude Code added native checkpoints.
  - abshkbh/arrakis: last push 2025-06-02.
  - google-research/camel-prompt-injection: 425 stars, last push 2025-06-20; a research prototype.
  - invariantlabs-ai/invariant-gateway: last push 2025-11-06, after the Snyk acquisition.
  - trailofbits/mcp-context-protector and pydantic/mcp-run-python: archived.
  - strongdm/leash: no push since 2026-04-06.
  - MetapriseAI/OrgKernel: no push since 2026-07-06.
  - M64GitHub/clawgate: one week of activity (2026-02-01 to 2026-02-09).
  - Sources: [mcp-guardian](https://github.com/eqtylab/mcp-guardian), [ccundo](https://github.com/RonitSachdev/ccundo), [arrakis](https://github.com/abshkbh/arrakis), [camel repo](https://github.com/google-research/camel-prompt-injection), [invariant-gateway](https://github.com/invariantlabs-ai/invariant-gateway), [mcp-context-protector](https://github.com/trailofbits/mcp-context-protector), [mcp-run-python](https://github.com/pydantic/mcp-run-python), [leash](https://github.com/strongdm/leash), [OrgKernel](https://github.com/MetapriseAI/OrgKernel), [clawgate](https://github.com/M64GitHub/clawgate)

### Inferences
- **Why projects stall (inferred from the evidence above):**
  1. Agent vendors absorb the feature: Claude Code checkpoints killed ccundo, and Codex and Claude ship their own sandboxes.
  2. Acquisition: Invariant was bought by Snyk.
  3. Research prototypes are not maintained: CaMeL, GoEx.
  4. Company side projects lose priority: Leash and OrgKernel are possible examples, but this is speculative.
  5. A crowded field of near-identical "firewall" and "receipts" repos created in 2026 splits attention.
- **Composition is the open gap.** Each project picks two or three blocks. A neutral layer could combine:
  - Tenuo or Biscuit-style narrow-only passes,
  - Cedar with SMT-checked "child ⊆ parent" analysis,
  - nono or agentsh-style kernel sandbox and snapshots,
  - Tracekit-style CT receipts,
  - a whole-plan preview and approval step.

  That combination does not exist in open source today.
- **Star caution:** Several repos created in 2026 show very high star counts relative to age and commit history: OrgKernel (2.7k), hardenrun/aif (2.0k), withcoral/coral (5.0k), and nanoMuse and internet-court-skill, which surfaced in searches. Star inflation is common in AI-security repos in 2026. Use commit cadence and issues as better signals. This is an inference, not verified.
- **nono stands out** for traction: 5.1k stars, 340 forks and 255 open issues, which suggests real usage. Its Sigstore lineage makes it the most likely candidate to add Rekor-anchored receipts.

### Gaps
- I could not confirm the reason any specific project stalled. No maintainer statements were found beyond ccundo's README note.
- I found no Hacker News thread analyzing the failures of agent permission layers. I did not search HN deeply because of the tool-call budget.
- Whole-plan preview (plan/approve/apply with a diff of all intended effects) appears only as per-call holds, plus hazmat's pre-launch "session contract" and Pigius/cedar-mcp-server's "plan policy changes." I found no Terraform-style plan for agent actions on a local machine. getkastordev/kastor (66 stars) is "plan/apply/state" for hosted agent *definitions*, not actions — [kastor](https://github.com/getkastordev/kastor).

---

## Q6. Academic and industry papers and standards proposing similar designs

### Takeaway
Research has converged on "move authorization out of the model": capability or IFC layers (CaMeL, FIDES, Progent), contextual policies (Conseca), narrow-only delegated capabilities (AgentCap, DelegateGuard), and auditable delegation (South et al.). Standards work is fragmented. The IETF OAuth WG was rechartered in June 2026 with agents in scope, and dozens of individual drafts exist, but none is adopted as a standard for agent delegation.

### Cited Findings

**Capability and information-flow control**
- **CaMeL, "Defeating Prompt Injections by Design"** (Debenedetti, Shumailov et al., Google DeepMind/ETH; arXiv 2503.18813, Mar 2025). A protective layer extracts control flow and data flow from the trusted query, so untrusted data cannot change program flow, and capabilities restrict data flows. — [arXiv](https://arxiv.org/abs/2503.18813); code at [google-research/camel-prompt-injection](https://github.com/google-research/camel-prompt-injection) (425 stars, last push 2025-06-20)
- **FIDES, "Securing AI Agents with Information-Flow Control"** (Costa, Köpf et al., Microsoft; arXiv 2505.23643, May 2025). Builds a formal model of agent planners and characterizes the properties IFC can enforce. — [arXiv](https://arxiv.org/abs/2505.23643)

**Policy and privilege control**
- **Progent: "Securing AI Agents with Privilege Control"** (Shi, He et al.; arXiv 2504.11703, Apr 2025). Applies programmable, task-dependent privilege control at tool calls. — [arXiv](https://arxiv.org/abs/2504.11703)
- **Conseca, "Contextual Agent Security: A Policy for Every Purpose"** (Tsai, Bagdasarian; arXiv 2501.17070, Jan 2025). Generates context-specific security policies for each task. — [arXiv](https://arxiv.org/abs/2501.17070)
- **"Design Patterns for Securing LLM Agents against Prompt Injections"** (Beurer-Kellner, Debenedetti et al.; arXiv 2506.08837, Jun 2025). A catalog of patterns including plan-then-execute. — [arXiv](https://arxiv.org/abs/2506.08837)

**Delegation and narrow-only capabilities**
- **AgentCap** (arXiv 2611.00729, 31 Oct 2026). A runtime authorization layer that wraps every tool call via MCP. Delegation is session-bound parent-child, with budget and lifetime only narrowing at each hop, and tools receive short-lived capability tokens. — [arXiv](https://arxiv.org/abs/2611.00729)
- **DelegateGuard** (arXiv 2610.16005, Oct 2026). A reference monitor with purpose-bound capabilities that narrow but never widen across purpose, operations, sinks and depth. It argues that attenuation alone cannot stop leaks to authorized sinks. — [arXiv](https://arxiv.org/abs/2610.16005)
- **SAGA** (Syros, Suri, Nita-Rotaru et al.; arXiv 2504.21034, Apr 2025). A security architecture for governing agentic systems that covers user control over agent identity, authorization and inter-agent delegation. — [arXiv](https://arxiv.org/abs/2504.21034)
- **"Authenticated Delegation and Authorized AI Agents"** (South et al., MIT; arXiv 2501.09674, Jan 2025). Authenticated, authorized and auditable delegation that extends OAuth/OIDC. — [arXiv](https://arxiv.org/abs/2501.09674)
- **"Delegation Without Trust"** (arXiv 2609.00267, Aug 2026). An empirical gap analysis of identity, authorization and runtime governance in multi-agent LLM systems. — [arXiv](https://arxiv.org/abs/2609.00267)
- **"Rethinking Access Control for AI Agents: Recent Advances and Open Challenges"** (Zhou, Zhang; arXiv 2611.06764, Nov 2026). A survey across policy specification, identity and delegation, enforcement, and IFC. It argues authorization must be reassessed as plans change and that evaluation should measure unauthorized effects that remain enabled. — [arXiv](https://arxiv.org/abs/2611.06764)

**Undo and runtime**
- See Q2: GoEX 2404.06921, Atomix 2602.14849, AgentRewind 2608.14380, DeltaBox 2605.22781, Safe to Resume? 2608.29381.

**IETF and MCP standards**
- **draft-oauth-ai-agents-on-behalf-of-user** (WSO2 authors) adds agent identity to the authorization-code flow and consent. Version -02 (Aug 2025) has **expired**. — [Datatracker](https://datatracker.ietf.org/doc/draft-oauth-ai-agents-on-behalf-of-user/)
- **draft-klrc-aiagent-auth** is an AI agent authentication and authorization framework; Aaron Parecki is among its authors, and -02 is dated 2026-03-30. — [Datatracker](https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/02/)
- **Other 2026 drafts:**
  - draft-liu-ai-agent-authorization-integration (Jul 2026): composing OAuth extensions for agents — [Datatracker](https://datatracker.ietf.org/doc/draft-liu-ai-agent-authorization-integration/)
  - draft-sweeney-wimse-credential-delegation-00 (Jul 2026) — [IETF](https://www.ietf.org/archive/id/draft-sweeney-wimse-credential-delegation-00.html)
  - draft-chen-oauth-agent-authz-use-cases-05 (Oct 2026) — [Datatracker](https://datatracker.ietf.org/doc/html/draft-chen-oauth-agent-authz-use-cases-05)
- An interim OAuth WG meeting (May 2026) grouped about seven individual drafts into a "delegation cluster" of competing proposals. — [IETF interim slides](https://datatracker.ietf.org/meeting/interim-2026-oauth-03/materials/slides-interim-2026-oauth-03-sessa-ietf-individual-draft-analysis-00)
- One July 2026 draft states the OAuth WG was rechartered in June 2026 with agents acting for users in scope, and that "several dozen" individual drafts address agent identity or delegation. This is reported via search summary; I did not open the draft text. — [draft-sweeney-wimse-credential-delegation-00](https://www.ietf.org/archive/id/draft-sweeney-wimse-credential-delegation-00.html)
- **MCP authorization spec:** OAuth 2.1-based, with servers as resource servers (RFC 9728 metadata) and RFC 8707 resource indicators. Revisions are dated 2025-06-18, 2025-11-25 and 2026-07-28. — [MCP spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [MCP spec 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

### Inferences
- The academic consensus matches the target design: (1) separate planning from authorization, (2) narrow-only delegation, (3) verify at the tool boundary, and (4) treat rollback as insufficient for external effects. The two most recent papers (AgentCap, DelegateGuard, Oct–Nov 2026) describe MCP-wrapping capability monitors very close to a "narrow-only pass" layer. They are research prototypes, not maintained products.
- Standards are OAuth-centric, server- and enterprise-oriented, and fragmented. A local "user's own machines" layer would likely need to bridge OAuth/MCP tokens to local capability passes rather than wait for a standard.

### Gaps
- I did not open the full text of Progent, FIDES, SAGA or GoEX. The summaries above come from arXiv abstract metadata.
- I did not verify whether AgentCap or DelegateGuard released code.
- I did not confirm the exact IETF WG adoption status of draft-klrc-aiagent-auth, or the IETF draft that Tenuo references.
- "Invocation-Bound Capability Tokens" (Prakash, 2026) was cited in arXiv 2605.05440 but not located. — [arXiv 2605.05440](https://arxiv.org/html/2605.05440v1)
