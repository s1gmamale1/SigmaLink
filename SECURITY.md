# Security policy

## Threat model

SigmaLink is a local-first desktop application that runs untrusted CLI coding agents inside PTYs against repositories on the operator's machine. The threat model assumes:

- Each agent has full read and write access to the files inside its assigned Git worktree, plus read access to anything else the operator's user account can reach. Worktrees live under the Electron user-data directory; merges back to the base branch require an explicit operator click in the Review Room.
- Agents can run arbitrary shell commands via the PTY. We do not sandbox the child process. `runShellLine` in `core/git/` uses argv arrays only and does not interpolate operator strings into a shell, but agent output is still trusted to its worktree.
- The planned in-app browser (Phase 3) gives agents network egress and the ability to drive a real Chromium tab through Playwright MCP over CDP. Per-workspace `Session` partitions isolate cookies and storage between workspaces, but not from the operator's browser at large.
- Skill files (Phase 4) are user-supplied content. Validation is structural (Zod over SKILL.md frontmatter); we do not analyse skill bodies for malicious instructions.
- The renderer-main IPC bridge currently exposes a single generic `invoke`. Tightening this to a per-channel allowlist is the first item on Phase 1.5 (see [`docs/01-investigation/02-bug-sweep.md`](docs/01-investigation/02-bug-sweep.md) entry `P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST`).

Out of scope for the threat model:

- Adversarial multi-tenant operation. SigmaLink is single-operator, single-machine.
- Cloud sync, account systems, billing — none of these exist.
- Network-attached agents, SSH workspaces — explicitly deferred.

Operate SigmaLink only against repositories and agents you trust. Treat a SigmaLink workspace the way you would treat running a coding agent with `--dangerously-skip-permissions`.

## Reporting a vulnerability

Please report security issues through GitHub's private vulnerability disclosure flow:

> https://github.com/s1gmamale1/SigmaLink/security/advisories/new

Do not open a public issue or pull request for a vulnerability. Initial acknowledgement is targeted within seven days; remediation timelines depend on severity and the affected phase.

When reporting, include:

- Affected version or commit SHA.
- Operating system and Electron version.
- Steps to reproduce, ideally including a minimal repository.
- The impact you observed (information disclosure, code execution, persistence boundary crossed, etc.).

## Supported versions

Only `main` is supported at this time. There are no tagged releases yet; once a `0.1.0` is cut, this section will list which release lines receive backports.

## Hardening notes

The codebase already enforces or has scheduled the following:

- Argv-array `exec` only; no shell-string interpolation in Git or PTY spawns.
- A shared OS-aware spawn helper (`resolveForCurrentOS`) is being introduced in Phase 1.5 so `.cmd`, `.bat`, and `.ps1` shims route through `cmd.exe /d /s /c` or `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`.
- The preload exposes a single generic `invoke` plus event helpers. A per-channel allowlist is on the Phase 1.5 patch list and will land before any new feature work.
- Worktree paths live under the Electron user-data directory and are scoped by workspace id. Failed launches that leak worktrees are tracked as `P1-WORKTREE-LEAK` and patched in Phase 1.5.
- Force-pushes from agent sessions are rejected at the orchestration layer; merges to a base branch are gated by the operator.

If you find behaviour outside these constraints, please report it via the security advisory link above.
