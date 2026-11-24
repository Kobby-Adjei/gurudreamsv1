# OS Feasibility: Undo/Rollback and Sandboxing for a User-Level Agent Permission Desktop App (macOS / Windows / Linux)

Research date: 2026-11-24. Sources fetched 2026-11-24 unless noted. "Training knowledge" marks claims that I did not re-verify against a fetched source this session; the report writer should treat them as lower confidence.

## Q1. Undo/rollback: which OS mechanisms exist, what privilege do they need, and what is the practical no-admin approach?

### Takeaway
Whole-volume snapshot technologies (APFS local snapshots, Windows VSS, btrfs/ZFS) mostly need admin or a specific filesystem layout, and they are coarse. The practical no-admin approach is an app-managed per-folder checkpoint: copy-on-write clones (APFS `clonefile`, ReFS/Dev Drive block cloning, btrfs/XFS reflink) where available, falling back to plain copies or a shadow git repo, taken before each agent action or turn. That only covers files in granted folders. Network calls, emails, `git push`, package installs and anything outside granted folders cannot be undone this way. Even Claude Code's built-in rewind does not track files changed only by Bash commands.

### Cited Findings
**macOS**
- `tmutil localsnapshot` "creates a new local snapshot on all volumes currently being backed up by Time Machine". `tmutil snapshot` (undocumented) works when Time Machine is off. "APFS snapshots are always of whole volumes." Time Machine deletes snapshots once they reach 24 hours old, or earlier when disk space runs low. — [Eclectic Light, "Take control of snapshots", 2026-09-09](https://eclecticlight.co/2026/09/09/take-control-of-snapshots/)
- Single-file restore works by mounting the snapshot (e.g., from Disk Utility as "Data@snap-…") and copying files out. Whole-volume rollback runs from Recovery via Time Machine System Restore, "is almost instant, but automatically deletes all later snapshots." — [Eclectic Light, 2026-09-09](https://eclecticlight.co/2026/09/09/take-control-of-snapshots/)
- Privilege, from community evidence only: one user created a snapshot with `tmutil localsnapshot` without sudo, but mounting it as a normal user failed with "Operation not permitted" and worked only from a root shell. — [Apple Community thread 251655108](https://discussions.apple.com/thread/251655108). I found no Apple primary doc that settles whether a non-admin can restore from a local snapshot.
- `clonefile(2)` "create[s] copy on write clones of files". "Subsequent writes to either the original or cloned file are private to the file being modified." The destination must not already exist, and support varies by volume (check `VOL_CAP_INT_CLONE` via `getattrlist`). — [Apple xnu clonefile(2) man page](https://opensource.apple.com/source/xnu/xnu-4570.31.3/bsd/man/man2/clonefile.2.auto.html); [Apple APFSCloning sample](https://developer.apple.com/library/archive/samplecode/APFSCloning/Introduction/Intro.html)
- Third-party docs say cloning needs the source and destination on a common CoW filesystem, such as one APFS volume. — [Pike System.clonefile docs](https://pike.lysator.liu.se/generated/manual/modref/ex/predef_3A_3A/System/clonefile.html) (third-party, not Apple)
- Carbon Copy Cloner can create local snapshots with configurable retention (author's comment), so a third-party app can create snapshots. The privileged helper and entitlement it uses are not described there. — [Eclectic Light comments, 2026-09-09](https://eclecticlight.co/2026/09/09/take-control-of-snapshots/)

**Windows**
- `CreateVssBackupComponents` documents a failure return for a caller that "does not have sufficient backup privileges or is not an administrator". Backup applications must assert SE_BACKUP_NAME, and SE_RESTORE_NAME for restore. A requester can run as a Backup Operator account. — [Microsoft Learn, CreateVssBackupComponents](https://msdn.microsoft.com/en-us/library/aa381517(v=vs.85).aspx); [Microsoft Learn, Simple Shadow Copy Creation for Backup](https://learn.microsoft.com/en-us/windows/win32/vss/simple-shadow-copy-creation-for-backup)
- Microsoft troubleshooting guidance runs `vssadmin` from an elevated or Administrator command prompt. — [Microsoft Learn, VSS](https://learn.microsoft.com/windows-server/storage/file-server/volume-shadow-copy-service)
- Block cloning: "Starting with the Windows 11 Moment 5 update (KB5034848)…block cloning occurs natively in supported Windows copy operations." It can also be called explicitly via `FSCTL_DUPLICATE_EXTENTS_TO_FILE`. It works only on ReFS, including Dev Drive. — [Microsoft Learn, Block cloning (Win32)](https://learn.microsoft.com/en-us/windows/win32/FileIO/block-cloning); [Microsoft Engineering blog, CoW in Win32 API, 2023-11-02](https://devblogs.microsoft.com/engineering-at-microsoft/copy-on-write-in-win32-api-early-access/); [FSCTL_DUPLICATE_EXTENTS_TO_FILE](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_duplicate_extents_to_file)
- Dev Drive (ReFS) caps a data block at 8,176 clones. Using it means formatting a new volume or reformatting an existing one as a Dev Drive. Microsoft reported copy speedups of 18% (1 MB) to 94% (1 GB). — [Tom's Hardware summarizing Microsoft, May 2024](https://www.tomshardware.com/software/windows/one-of-the-best-features-coming-with-the-windows-2024-update-is-block-cloning-a-former-windows-server-refs-exclusive); [Microsoft Engineering blog, 2024-05-14](https://devblogs.microsoft.com/engineering-at-microsoft/copy-on-write-performance-and-debugging/)

**Linux**
- btrfs: users can snapshot subvolumes they own. Since 2017 the kernel refuses snapshots of another user's subvolume. Unprivileged `btrfs subvolume delete` is blocked unless the filesystem is mounted with `user_subvol_rm_allowed` (plain `rm -r` is the usual workaround). — [kernel commit "btrfs: restrict snapshotting to own subvolumes"](https://android-kvm.googlesource.com/linux/+/d024206133ce21936b3d5780359afc00247655b7); [linux-btrfs list, user_subvol_rm_allowed](https://lore.kernel.org/linux-btrfs/OSBPR01MB3367B6E4521888148EB778BFE5B60@OSBPR01MB3367.jpnprd01.prod.outlook.com/); [Launchpad test on Ubuntu 22.04](https://bugs.qastaging.launchpad.net/ubuntu/+source/apparmor/+bug/484786/comments/4)
- Cursor's Linux sandbox uses an overlay filesystem: ignored files "are overwritten with Landlocked copies inside an overlay filesystem". Overlay-style layering is already used in production agent sandboxes. — [Cursor blog, "agent sandboxing", 2026-02-18](https://cursor.com/blog/agent-sandboxing)

**Existing agent tools' undo**
- Claude Code checkpoints capture state "before each prompt you send that starts a turn". It keeps snapshots for the 100 most recent checkpoints and deletes them about 30 days later. "A file that only Bash commands changed isn't tracked and stays as it is. To revert it, use version control, such as Git." Subagent edits are usually not captured, symlinked and hard-linked files are skipped, and it is "Not a replacement for version control". — [Claude Code docs, Checkpointing](https://code.claude.com/docs/en/checkpointing)
- Claude Code's sandbox denies writes to `.git` hooks and config, and Cursor's Seatbelt policy denies writes to `.git/config` and `.git/hooks`. Both treat the git metadata the user would rely on for rollback as protected. — [Claude Code docs, Sandboxing](https://code.claude.com/docs/en/sandboxing); [Cursor blog, 2026-02-18](https://cursor.com/blog/agent-sandboxing)

### Inferences
- **No-admin design.** For each granted folder, snapshot before each agent turn or command:
  - macOS: `clonefile` the tree. Space use is near-zero until files change.
  - Windows: block clone if the folder is on ReFS or Dev Drive; otherwise copy, or snapshot only changed files.
  - Linux: btrfs snapshot if the folder is a user-owned subvolume; otherwise a reflink copy (`cp --reflink`) on btrfs or XFS, else a copy or a shadow git repo with a separate `GIT_DIR` outside the agent-writable tree.
  - A file-watcher journal (FSEvents, ReadDirectoryChangesW, inotify/fanotify) can scope the copies to files that actually changed.
  - None of this needs admin.
- **Why the snapshot store matters.** Snapshots must live outside the agent's writable set. Combining sandbox write restrictions with a protected checkpoint store is what makes undo trustworthy. Without the sandbox, an agent could delete its own checkpoints.
- **Whole-volume snapshots are a poor fit.** APFS, VSS and btrfs root snapshots are a coarse optional "safety net" layer, not the per-action undo primitive:
  - they capture everything on the volume, including the user's own concurrent work;
  - they need admin on Windows and probably to mount on macOS;
  - they are purged automatically (24 hours on macOS).
- **Side effects that are not undoable.** Network requests, sent emails or messages, `git push`, cloud API mutations, payments, and global package installs or OS config outside granted folders cannot be rolled back at the OS level. The realistic strategies are: (a) block them in the sandbox; (b) require approval before they run; (c) for a few, a compensating action (`git push --force` to the previous ref, `npm uninstall`), which is not true undo. The product should say clearly which actions are reversible and which are not.

### Gaps
- No Apple primary doc found on the privilege needed for `tmutil localsnapshot`, mounting, or `tmutil restore` from a local snapshot as a non-admin, nor on the entitlement a third-party app needs to create APFS snapshots. Training knowledge, unverified: `fs_snapshot_create` requires root plus the `com.apple.developer.vfs.snapshot` entitlement.
- Windows File History was not researched: it backs up library folders on a schedule, its admin needs are unverified, and it is too coarse for per-action undo.
- ZFS `zfs allow` delegation of snapshot and rollback to non-root users was not verified this session (training knowledge: delegation works but an admin must set it up once).
- Unprivileged overlayfs mounts inside user namespaces were not verified (training knowledge: since Linux 5.11).

## Q2. Sandboxing: per-OS mechanisms, privilege requirements, and what Claude Code, Codex and Cursor actually use

### Takeaway
- **macOS and Linux:** sandboxing an agent-launched process tree to granted folders and network hosts is mature and needs no admin. On macOS that is Seatbelt via `sandbox-exec`, which is deprecated but used by Claude Code, Codex, Cursor and Microsoft's MXC. On Linux it is bubblewrap with user namespaces, or Landlock plus seccomp.
- **Windows:** the hard platform. Tools either skip native sandboxing (Claude Code native, Cursor), need a one-time admin setup that creates sandbox user accounts plus firewall or WFP rules (Codex "elevated", Anthropic `srt` alpha), or adopt Microsoft Execution Containers (MXC), which went GA in October 2026.
- **Network:** filtering is typically done with a local proxy plus a ban on other egress, not per-host kernel filtering.

### Cited Findings
**Claude Code (Anthropic)**
- "macOS: uses Seatbelt for sandbox enforcement." On Linux and WSL2 it "uses bubblewrap for isolation". "On native Windows, Claude Code runs commands unsandboxed." — [Claude Code docs, Sandboxing](https://code.claude.com/docs/en/sandboxing) (no date on the page; it cites v2.1.3xx versions)
- Writes default to "the working directory, a per-user temp directory, and directories you've added". Reads cover "most of the machine," including `~/.ssh`, unless restricted. Writes to `.claude` settings, `.mcp.json`, shell startup files and `.git` hooks/config are denied. — [Claude Code docs, Sandboxing](https://code.claude.com/docs/en/sandboxing)
- Network: "Connections go through a proxy on your machine that checks each host against your allowed domains, which start empty." On Linux the command runs in a network namespace "that has no connection to your network". UDP, QUIC and ICMP can't leave the sandbox. The proxy does not terminate TLS by default. — [Claude Code docs, Sandboxing](https://code.claude.com/docs/en/sandboxing)
- Caveats:
  - Built-in file and web tools, hooks, MCP servers and `excludedCommands` run outside the sandbox.
  - Docker is incompatible with the sandbox.
  - Linux needs `bubblewrap` and `socat` (installed with sudo).
  - On Ubuntu with AppArmor's userns restriction, it needs an AppArmor profile or a sysctl change.
  - — [Claude Code docs, Sandboxing](https://code.claude.com/docs/en/sandboxing)
- The open-source `srt` (sandbox-runtime) behind it:
  - Uses "`sandbox-exec` on macOS, `bubblewrap` on Linux" plus HTTP and SOCKS5 proxies.
  - The macOS Seatbelt profile "allows communication only to a specific localhost port".
  - On Linux, "the network namespace…is removed entirely", and seccomp blocks Unix sockets.
  - Windows (alpha): a dedicated `srt-sandbox` local user, "a Windows Filtering Platform (WFP) egress fence keyed on the sandbox account's SID, a write-restricted token, and explicit ACEs on the working tree", installed "once per machine (self-elevates; one UAC prompt)".
  - Known Windows gap: OS-TLS clients (`curl.exe`, `Invoke-WebRequest`, .NET HttpClient, `winget`) can't complete HTTPS under the restricted token.
  - — [anthropic-experimental/sandbox-runtime README](https://github.com/anthropic-experimental/sandbox-runtime)

**OpenAI Codex**
- "On macOS, sandboxing works out of the box using the built-in Seatbelt framework." On Linux and WSL2 it uses `bubblewrap`, either `bwrap` on PATH or a bundled helper that needs unprivileged user namespaces. Ubuntu 24.04 may need the `bwrap-userns-restrict` AppArmor profile. Modes are read-only, workspace-write (default) and danger-full-access. — [Codex docs, Sandboxing](https://learn.chatgpt.com/codex/sandboxing) (no page date). Earlier Codex Linux builds used Landlock and seccomp (training knowledge); the current docs name bubblewrap.
- Windows, per [OpenAI, "Building the Codex Windows sandbox", 2026-05-13](https://openai.com/index/building-codex-windows-sandbox/):
  - OpenAI rejected AppContainer because it suits apps with fixed, known needs, not open-ended shells and builds.
  - It rejected Windows Sandbox because it is a disposable VM and isn't on Home SKUs.
  - It rejected Mandatory Integrity Control because low-integrity labels would be too broad.
  - Unelevated v1: a synthetic `sandbox-write` SID, a write-restricted token, ACLs on the workspace, and denied `.git`, `.codex` and `.agents`. "Network protection is weak," relying only on environment and proxy tricks.
  - Elevated: "Setup requires admin rights." It creates `CodexSandboxOffline` and `CodexSandboxOnline` users with DPAPI-stored credentials and firewall rules blocking the offline user, plus a separate `codex-command-runner.exe`.
- Current Windows docs: the elevated mode "Requires administrator-approved setup. Commands in the sandbox run without administrator privileges." IT can pre-provision it with `codex sandbox setup --elevated`. Both legacy modes use a private desktop. Unelevated "provides weaker network isolation…and doesn't support denied read paths." The fallback order is "MXC is recommended when supported", then elevated, then unelevated. — [Codex docs, Windows sandbox](https://learn.chatgpt.com/codex/windows/windows-sandbox) (no page date)

**Cursor**
- macOS: Cursor chose Seatbelt via `sandbox-exec` after weighing App Sandbox (would need every binary signed), containers (Linux binaries only) and VMs (slow and memory-heavy). The policy is generated at runtime, and Seatbelt "was deprecated in 2016" but is still used by Chrome.
- Linux: "Seccomp blocks unsafe syscalls, while Landlock enforces filesystem restrictions," plus an overlay filesystem for ignored files.
- Windows: the Linux sandbox runs inside WSL2. A native version is "significantly harder" because primitives target browsers; Cursor is "working with Microsoft".
- "Sandboxed agents stop 40% less often than unsandboxed ones." — [Cursor blog, 2026-02-18](https://cursor.com/blog/agent-sandboxing)
- Cursor docs list kernel 6.2+ with Landlock v3 as the requirement, with a bubblewrap fallback reported via `CURSOR_SANDBOX_LANDLOCK_STATUS`. — [Cursor terminal docs](https://cursor.com/docs/agent/tools/terminal.md) (via search summary; not fetched directly)

**Microsoft Execution Containers (MXC)**
- "now generally available"; a "policy-driven execution layer for untrusted code or dynamically generated workloads".
- Backends:
  - process container on Windows 11, macOS and Linux, built on AppContainer, Seatbelt and Bubblewrap respectively;
  - session container (Windows 11 only), with a separate Windows account and session that isolates desktop, clipboard and input;
  - WSL container;
  - experimental MicroVM.
- Modes are enforcement, learning and permissive, with a JSON policy covering filesystem, network and UI.
- Integrated today: GitHub Copilot, OpenAI Codex, Replit, LM Studio and others. Anthropic Claude Code is "announced, not yet shipped". Admin requirements are not stated, and Intune control is "soon". — [Windows Developer Blog, 2026-10-07](https://blogs.windows.com/windowsdeveloper/2026/10/07/microsoft-execution-containers-policy-driven-containment-for-ai-agents/)

**Linux primitives**
- Landlock: "empowers any process, including unprivileged ones, to securely restrict themselves." Enforcing it requires `no_new_privs` or `CAP_SYS_ADMIN`. It was introduced in Linux 5.13.
- Landlock ABI levels: ABI 2 refer (rename/link), ABI 3 truncate, ABI 4 TCP bind/connect, ABI 5 device ioctl, ABI 6 abstract Unix socket and signal scoping, ABI 10 UDP rules.
- Children inherit the domain, and restrictions can't be removed.
- Limits: `chdir`, `stat`, `flock`, `chmod` and `access` can't be restricted; at most 16 stacked rulesets. — [Linux kernel docs, Landlock](https://docs.kernel.org/userspace-api/landlock.html)

**macOS Endpoint Security**
- The Apple doc page body didn't render. Training knowledge, unverified: it needs the restricted entitlement `com.apple.developer.endpoint-security.client` granted by Apple, root via a system extension, and Full Disk Access approval by the user. AUTH events such as `AUTH_EXEC` and `AUTH_OPEN` can allow or deny operations system-wide. — [Apple Endpoint Security docs](https://developer.apple.com/documentation/endpointsecurity)

### Inferences
- **macOS.** Seatbelt via `sandbox-exec` is the de-facto standard for a non-admin app. Claude Code, Codex, Cursor and MXC all use it. The risk is the "deprecated" label, but MXC adopting it in October 2026 suggests Apple has not removed it in practice.
  - App Sandbox only applies to the app's own signed binaries, so it can't contain arbitrary agent-run CLIs.
  - Endpoint Security would give system-wide monitoring and blocking but needs Apple's entitlement approval, a system extension and user approval. That is heavy for a startup, though it is the path to a "monitor everything" product.
- **Linux.** bubblewrap (which needs unprivileged user namespaces) or Landlock plus seccomp (fully unprivileged) both work without root at runtime. The common friction is Ubuntu 23.10+/24.04 AppArmor restricting unprivileged userns. Fixes need a one-time sudo: an AppArmor profile or the `bwrap` package. Landlock avoids userns but needs a recent kernel for network (TCP) and UDP rules.
- **Windows.** No single no-admin primitive matches Seatbelt for arbitrary dev tools. The realistic options:
  - (a) a one-time UAC setup that creates sandbox accounts plus firewall/WFP rules and ACLs (Codex elevated, srt alpha);
  - (b) build on MXC (Windows 11, GA October 2026), which Codex already prefers;
  - (c) WSL2 only for Linux toolchains (Cursor);
  - (d) unelevated restricted tokens with weak network control.
  - Job objects (training knowledge) limit resources and process lifetime, not file or network access.
- **Network.** All the major tools use "deny all except a localhost proxy, then filter by hostname". That needs no admin on macOS or Linux. On Windows, kernel-level egress enforcement (WFP or Windows Firewall per user SID) needs admin once. Non-HTTP and non-proxy-aware tools break.

### Gaps
- Codex's current Linux implementation details (whether Landlock or seccomp are still used in addition to bubblewrap) beyond what the docs page says.
- MXC privilege requirements and AppContainer limits for arbitrary dev tools under MXC process containers are not stated in the announcement.
- No Apple primary-source text retrieved for `sandbox-exec` deprecation status or the Endpoint Security entitlement process.
- Windows Sandbox enablement requirements (Pro/Enterprise, admin to enable the optional feature) were not verified beyond OpenAI's note that it is absent on Home.

## Q3. Approving actions remotely (phone push): any OS constraints?

### Takeaway
I found no OS-level barrier. Remote approval is an app-architecture problem: a local daemon holds the pending action, sends a push via your own server or a relay (APNs, FCM, ntfy), and resumes on the reply. Several third-party tools already do this for Claude Code via hooks. Native actionable phone approval was a feature request as of May 2026.

### Cited Findings
- `claude-remote-approver` uses a Claude Code hook to send each permission request to the phone via ntfy, with Approve, Always Approve and Deny buttons. — [GitHub: claude-remote-approver](https://github.com/yuuichieguchi/claude-remote-approver)
- `claude-ntfy-hook` is a single-file Python PermissionRequest hook that pushes pending tool calls to the phone. — [claude-ntfy-hook](https://adrian-gomez.github.io/claude-ntfy-hook/)
- Claude Code channels with a trusted sender path can opt in to relay permission prompts for remote approve or deny. — [Claude Code docs, channels reference](https://code.claude.com/docs/en/channels-reference) (via search summary; not fetched)
- A feature request (May 2026) said the native push notification lacked actionable Approve/Deny buttons. — [claudeissues.com #62458](https://claudeissues.com/issue/62458-feature-request-actionable-approve-deny-on-mobile-push-for-permission-prompts) (aggregator of GitHub issues; status may have changed)

### Inferences
- **Desktop side:** you need a long-running user-level process (a LaunchAgent on macOS, a Startup/Task Scheduler task on Windows, a systemd user service on Linux) that keeps an outbound connection to a relay. None of these needs admin. macOS App Nap or sleep, Windows Modern Standby and laptop lid-close will pause pending approvals, so approvals should time out to "deny".
- **Phone side:** push requires your own mobile app (APNs/FCM) or a third-party channel (ntfy, Telegram, Slack). Security depends on authenticating the approver (device-bound keys) and binding the approval to the exact action (a hash of command, path and host) to prevent replay.

### Gaps
- No primary sources on OS power-management effects on long-poll agents; this is inference only.

## Q4. Overall: which pieces are cheap and reliable vs. hard and fragile? (per-OS feasibility table)

### Takeaway
Cheap and reliable: per-folder CoW or copy checkpoints, macOS Seatbelt and Linux bubblewrap/Landlock filesystem sandboxing, and proxy-based network allowlisting. Hard or fragile: native Windows sandboxing without admin, whole-volume snapshot restore without admin, system-wide monitoring (Endpoint Security), and undoing any non-filesystem side effect.

### Cited Findings
Each cell draws on the Q1–Q3 sources; the source column lists the main ones.

| Capability | macOS | Windows | Linux | Main sources |
|---|---|---|---|---|
| Per-folder undo, no admin | `clonefile` CoW (APFS, same volume) or copy; reliable | ReFS/Dev Drive block cloning (Win11 24H2+), else plain copy; most users are on NTFS, so mostly copies | btrfs snapshot of a user-owned subvolume, or reflink/copy; reliable | [clonefile(2)](https://opensource.apple.com/source/xnu/xnu-4570.31.3/bsd/man/man2/clonefile.2.auto.html), [MS block cloning](https://learn.microsoft.com/en-us/windows/win32/FileIO/block-cloning), [btrfs commit](https://android-kvm.googlesource.com/linux/+/d024206133ce21936b3d5780359afc00247655b7) |
| Whole-volume snapshot | `tmutil localsnapshot`; whole volume, purged after 24 hours; mounting needed root in community reports | VSS needs admin or backup privileges | btrfs/ZFS need a specific layout and root setup | [Eclectic Light](https://eclecticlight.co/2026/09/09/take-control-of-snapshots/), [Apple Community](https://discussions.apple.com/thread/251655108), [MS VSS](https://msdn.microsoft.com/en-us/library/aa381517(v=vs.85).aspx) |
| Filesystem sandbox, no admin | Seatbelt/`sandbox-exec` (deprecated but universal) | Unelevated restricted token plus ACLs (Codex fallback); MXC process container (AppContainer) | bubblewrap (userns) or Landlock plus seccomp; Ubuntu AppArmor may need one-time sudo | [Claude Code](https://code.claude.com/docs/en/sandboxing), [Codex](https://learn.chatgpt.com/codex/sandboxing), [Cursor](https://cursor.com/blog/agent-sandboxing), [Landlock](https://docs.kernel.org/userspace-api/landlock.html) |
| Network sandbox | Seatbelt allows only localhost proxy port; no admin | Needs one-time admin for firewall/WFP per sandbox-user SID; unelevated is "weak" | Empty network namespace plus proxy (bwrap), or Landlock TCP/UDP rules | [srt README](https://github.com/anthropic-experimental/sandbox-runtime), [OpenAI Windows blog](https://openai.com/index/building-codex-windows-sandbox/) |
| What tools use | Claude Code, Codex and Cursor: Seatbelt | Claude Code: none natively (WSL2); `srt` alpha with one UAC prompt; Codex: MXC, then elevated, then unelevated; Cursor: WSL2 | Claude Code and Codex: bubblewrap; Cursor: Landlock plus seccomp (bwrap fallback) | [MXC blog](https://blogs.windows.com/windowsdeveloper/2026/10/07/microsoft-execution-containers-policy-driven-containment-for-ai-agents/) and the above |
| System-wide monitor/block | Endpoint Security: Apple entitlement, system extension, root (training knowledge) | Minifilter or WFP drivers need admin and driver signing (training knowledge) | fanotify or eBPF need root or capabilities (training knowledge) | — |
| Remote approval | No OS barrier | No OS barrier | No OS barrier | [claude-remote-approver](https://github.com/yuuichieguchi/claude-remote-approver) |

### Inferences
- The defensible no-admin scope: wrap agent-launched processes (not the whole machine) in an OS sandbox, checkpoint granted folders with CoW copies, and gate network and irreversible actions behind approval. This is the same architecture Claude Code, Codex and Cursor converged on.
- Windows is the main cost and risk. Plan on a one-time UAC setup, or MXC on Windows 11 (GA October 2026, Codex already integrated), with WSL2 as a fallback.
- Products that only intercept agent tool calls (hooks or MCP proxies), without an OS sandbox, are easy to build but can be bypassed by any shell command the agent runs. Claude Code's own docs note that its sandbox covers only Bash, not MCP servers or hooks.
- A user-level app cannot see or undo actions the agent takes through other channels: cloud APIs, browser sessions, already-running apps via Apple Events or UI automation. `srt` warns that `allowAppleEvents` means "the sandbox no longer provides code-execution isolation" ([srt README](https://github.com/anthropic-experimental/sandbox-runtime)).

### Gaps
- No independent security audits of `sandbox-exec`-based agent sandboxes or MXC were found in this pass.
- No benchmark data on checkpoint overhead (copy vs. clone) for large repos such as `node_modules`.
