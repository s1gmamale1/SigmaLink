# Design — Finish W-4 + W-5, add W-8 (per-pane worktree browsing)

> Brainstormed 2026-05-21 (superpowers:brainstorming). Source decisions captured
> via AskUserQuestion. Terminal state: dispatch a 3-agent swarm after W-6 Cluster A
> merges. Flag-gated, zero-regression posture throughout.

## Goal

Drive the two remaining open wishlist features to their code-achievable end, and
close the one genuine architectural gap surfaced during brainstorming:

- **W-4** shell-first pane architecture — Phases 5–7 (win32 + validation + flip wiring).
- **W-5** skills tab — Phase 3 (behavioral activation).
- **W-8** (NEW) — IDE per-pane worktree file browsing.

"Fully finish" is bounded by reality: human dogfood (W-4 P6), the actual default
flip (W-4 P7), and a Windows host (W-4 P5 verification) are **operator/environment
gated** and explicitly held — the swarm builds everything up to those gates.

## User-confirmed decisions

| Fork | Decision |
|---|---|
| W-5 P3 activation mechanism | **Native slash-command injection** for all slash-capable providers (Claude, Codex, Gemini for now). Modeled on the IDE file→pane `@`-mention drag-drop. Skills tab shows per-skill provider-compat labels ("Claude · Codex · Gemini compatible"). |
| W-4 P5 win32 | **Build flagged, default-off**, marked pending-Windows-dogfood. |
| W-4 P7 flip default | **Build + wire everything, HOLD the flip** at default `'direct'`. Operator flips via Settings after a dogfood. P8–9 (resume simplification, `external_session_id` drop) stay deferred until post-flip. |
| IDE/worktree seam | **Fold full per-pane worktree browsing in** (W-8): root selector + "Follow focused pane" mode. |

### Key insight that scoped W-8

A slash command `/skill-name` is resolved by the CLI from its config dirs, **not**
from a file path — so skill activation is **worktree-agnostic** and needs nothing
special for multi-worktree panes. The fan-out system already makes skills available
per-provider.

For **files**, the IDE tree roots at the workspace `repoRoot` (one root) and drops a
workspace-relative path (`FileTree.tsx:245`). Because a git worktree is a checkout of
the same repo, `@src/foo.ts` resolves correctly in each pane's own worktree cwd — so
cross-worktree referencing of **tracked** files already works today. The only real
gap is **files unique to one pane's worktree** (untracked/agent-created), invisible in
the root-rooted tree. W-8 closes exactly that.

## Section 1 — W-4 shell-first Phases 5–7

Plan ref: `docs/03-plan/v1.6.0-shell-first-pane-architecture.md`. Invariant unchanged:
the whole arc stays behind KV flag `pty.spawnMode ∈ 'direct' (DEFAULT) | 'shell-first'`.

- **P5 win32 shell-first** — `pty/sentinel.ts` gains per-shell exit sentinels beside
  the POSIX `printf "$?"`: PowerShell `Write-Host "...$LASTEXITCODE..."`, cmd
  `echo ...%ERRORLEVEL%...`. `pty/local-pty.ts` gains win32 command quoting (sibling to
  `posixQuoteArg`) and wires the win32 shell-first branch (today forced to `'direct'`).
  Ships behind default `'direct'` → **zero regression**. Tagged "pending Windows dogfood";
  win32 sentinel/quote logic is unit-tested, but full e2e verification needs a Windows host.
- **P6 validation** — Opus reviewer pass + automated shell-first integration test matrix
  (macOS-verifiable paths real; win32 paths unit-only). Human dogfood is operator-led,
  not swarm-closable.
- **P7 flip wiring** — implement the default-flip mechanism but **keep default `'direct'`**.
  Operator flips via the existing Settings toggle after dogfood. **P8–P9 remain deferred**
  (only safe post-flip; direct mode still needs `external_session_id`).

## Section 2 — W-5 Phase 3 skill slash-command activation

Today bindings are pure metadata; nothing in the dispatch path reads them
(`skills/controller.ts` attach/detach/listBindings are INFORMATIONAL).

- **New `command-room/insertSkillCommand.ts`** (sibling to `insertMention.ts`): writes
  `/${skillName} ` to the pane PTY via `rpc.pty.write` (no newline → lands in the input
  line; operator presses Enter). Worktree-agnostic. Toasts when the pane is not running
  (same pattern as `insertMention`).
- **`PaneShell.tsx` skill-drop branch (`:199`)**: in addition to the existing chip
  binding, call `insertSkillCommand` — **gated on provider compatibility**. Pane provider
  ∈ {claude, codex, gemini} → inject; kimi/opencode → toast "not supported for {provider}",
  chip-only (no misleading "active" injection).
- **`SkillsTab.tsx`**: per-skill **provider-compat badges** sourced from existing
  `SkillProviderState` / `verifyFanoutForWorkspace` fan-out state. Drops onto incompatible
  panes are blocked or warned.
- Reuses `ProviderTarget` (`skills/types.ts` — already `'claude'|'codex'|'gemini'`), the
  fan-out system, and the `insertMention` injection pattern. Minimal new infra.

## Section 3 — W-8 IDE per-pane worktree browsing (NEW)

- **`EditorTab.tsx:147`**: replace fixed `treeRoot = ws.repoRoot ?? ws.rootPath` with a
  **root selector** dropdown above `FileTree`: *Workspace root* + each open pane's
  `worktreePath` (labelled by provider/branch) + a **"Follow focused pane"** mode that
  auto-switches the tree root to the active pane's worktree.
- Persist selection in KV: `editor.<workspaceId>.rootSelection`.
- **Save path-containment**: when editing a worktree file, `fs.writeFile`'s `repoRoot`
  guard must accept the worktree path (worktrees share `.git`). Verify + test the
  containment logic so worktree edits save correctly.
- Net effect: untracked/worktree-specific files become browsable + draggable into panes,
  closing the only real file/worktree gap.

> Open micro-decision (trim at spec-review if desired): keep both the explicit dropdown
> AND "Follow focused pane", or dropdown-only. Designed with both; auto-follow is the
> ergonomic win for multi-pane dogfooding.

## Section 4 — Swarm topology, sequencing, gates

- **3 parallel Sonnet coder agents** in isolated git worktrees, disjoint file surfaces:
  - Agent **W4** — `pty/sentinel.ts`, `pty/local-pty.ts`, `pty/registry.ts`, settings, tests.
  - Agent **W5** — `command-room/insertSkillCommand.ts` (new), `command-room/PaneShell.tsx`,
    `skills/SkillsTab.tsx`, `skills/` manager (expose provider compat), shared types.
  - Agent **W8** — `editor/EditorTab.tsx`, `editor/FileTree.tsx`, `editor/useEditor.ts`,
    fs write-containment, tests.
- Each agent paired with an **Opus 4.7 reviewer**. Models stated at dispatch.
- **Sequencing vs in-flight W-6 Cluster A** (agent a2f0eaebfc955d6fd): all work in separate
  worktrees off `1b54a10`; no conflict during work. Lead merges in order — **W-6 A first,
  then W4, W5, W8** — resolving any `PaneShell.tsx` / `rpc-router.ts` / right-rail contention
  at each merge.
- **Hard scope rules** (binding at dispatch): agents NEVER push/tag/bump-version/release;
  lead runs the full gate (tsc + full vitest + eslint `--max-warnings 0` + build +
  electron:compile + **smoke e2e in main**) and ships.
- **Release**: likely v1.11.0 (W-6 rename) then v1.12.0 (this W4/W5/W8 bundle), or folded —
  decided at merge time.

## Out of scope / deferred (unchanged)

- W-4 P5 Windows e2e verification (needs Windows host), P6 human dogfood, P7 actual flip,
  P8–P9 schema cleanup.
- W-5 — non-slash providers (kimi/opencode) get chip-only, no injection.
- SigmaVoice signing (funded certs; explicitly off-roadmap for internal use).
