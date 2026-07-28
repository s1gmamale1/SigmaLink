# SigmaLink — Roadmap

> Cleared on 2026-07-24 (branch `fix/kimi-code-pane-rendering`). No phases are
> currently committed here — promote scoped items from [WISHLIST.md](WISHLIST.md)
> when they get sequenced into a phase.

## Phase 1: Kimi Code pane compatibility (2026-07-24)

**Plan:** [`app/docs/superpowers/plans/2026-07-24-kimi-code-pane-compatibility.md`](app/docs/superpowers/plans/2026-07-24-kimi-code-pane-compatibility.md)
**Source findings:** WISHLIST.md → `🔬 Deep review findings (2026-07-24)` sections A/B/C.

Sequenced tasks (each TDD, independently testable, commit per task):

1. **Critical** — shell-first spawn soft-miss on POSIX: `+` pane / Workspaces kimi
   launch fails on Electron's stale PATH pre-flight (`local-pty.ts` H-9).
2. **High** — honor DECSET 2026 synchronized output in `terminal-engine.ts`
   (streaming flicker).
3. **High** — OSC 0/2 title sink into the pane label (engine + xterm paths).
4. **Medium** — slash-command lines never reach the pane titler.
5. **Medium** — session-GC label clear requires two consecutive absent ticks.
6. **Medium** — MCP autowrite targets `~/.kimi-code/mcp.json` (legacy fallback).
7. **Medium** — resume picker scans the `~/.kimi-code` sessions layout.
8. **Low** — providers.ts kimi install metadata → `@moonshot-ai/kimi-code`.

**Definition of done:** full `pnpm test` + `tsc -b` green; manual smoke — kimi
launches via `+` pane, long stream without flicker, rename sticks as the pane
label; wishlist items marked promoted.

**Deferred (stays in WISHLIST.md):** FlowView scroll-pin churn, `logicalLines()`
windowing, DECSET-25 `cursorHidden` gating, NAME-slot sync from `state.json`,
shell-path cache freshness, dead `SIGMA::LABEL` reader removal.
