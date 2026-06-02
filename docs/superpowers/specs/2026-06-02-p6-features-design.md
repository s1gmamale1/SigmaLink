# P6 — Competitive features & leapfrogs (multi-release) · design spec

**Status:** approved (autonomous `/goal`). **Ships as:** `v1.42.0`+ (untagged; spans several rounds).
**Date:** 2026-06-02. **Baseline:** main @ `137c8c4` (P1–P5 shipped). The LAST roadmap phase.

## Goal
Close v3.0.74 parity + ship the worktree-only differentiators a shared-dir competitor can't match. Per the
ROADMAP, each non-trivial leapfrog (FEAT-4/6/11/13) gets its own spec before build. Executed in rounds.

## Round plan (priority order)
- **Round 1 (this round) — parity, low-risk:** FEAT-7 (per-agent visual identity) + FEAT-1 (resume-agents
  modal, additive). FEAT-3 **deferred** (see below).
- **Round 2 — leapfrogs (each its own mini-spec):** FEAT-11 (agent rewind via worktree checkpoints),
  FEAT-13 (cross-pane merge-orchestration UI surfacing `scoreConflicts`), FEAT-8 (per-worktree git heatmap).
- **Round 3 — surfaces:** FEAT-2 (context/MCP/LSP sidebar), FEAT-5 (MCP diagnostics), FEAT-6 (swarm phase
  tree), FEAT-9 (swarm-chat search/filter/pin), FEAT-4 (in-terminal prompt cards), FEAT-10 (launch presets),
  FEAT-12 (drag affordance), FEAT-14 (per-pane effort control), ONB-1 (first-run tour + settings search).
- **Cross-cutting still owed:** ARCH-1 (`tsconfig.main.json` — main-process Node typecheck), the ARCH-2..9
  opportunistic decompositions, FEAT-3's usage data layer.

## Round-1 design (recon-grounded)

### FEAT-7 — per-agent visual identity (small, pure renderer; file-disjoint from FEAT-1)
Today N same-provider panes share one color + a `PROVIDER·N` label; nothing keys off the session/agent id.
- Add `agentColor(id)` to `renderer/lib/workspace-color.ts` (reuse the existing deterministic id→hue
  polynomial-hash palette; return a hex/hue for an inline accent, not a Tailwind class). + test.
- `PaneHeader.tsx`: a per-agent accent (from `session.id`) + a short-ID badge (first ~4 chars / 2-char
  monogram of `session.id`) alongside the existing provider stripe/label. **Calm + static** (no animation —
  the v1.36 purple-flash lesson). Only render site is `PaneShell.tsx`.
- `RoleRoster.tsx` (swarm room): echo the same per-agent accent on each card via the resolved `live.sessionId`.
- No RPC / schema / state change.

### FEAT-1 — resume-agents relaunch modal (medium; ADDITIVE — does NOT rewire the boot auto-resume)
Today resume is automatic + all-or-nothing (`use-session-restore.ts` fires `rpc.panes.resume(wsId)` for all
eligible panes; the only surface is a failure toast). Add an **on-demand** selective-relaunch modal — the
boot auto-resume stays as-is (no annoying modal on every open).
- **New backend:** `panes.resumeSelected(wsId, sessionIds[])` — `resumeWorkspacePanes` gains a `sessionIds?`
  allowlist gating its eligible-row loop (`resume-launcher.ts`). Wire through `rpc-router.ts` +
  `rpc/schemas.ts` + `shared/rpc-channels.ts` + `shared/router-shape.ts`. Reuse `panes.listForWorkspace`
  (returns `AgentSession[]` with provider/status/startedAt) for the list.
- **New `RelaunchResumeModal.tsx`:** lists the workspace's persisted sessions (provider dot + short id +
  status + relative last-activity) with checkboxes + "Relaunch selected" + "Select exited/crashed" → calls
  `resumeSelected`. Reuses the existing `PaneResumeResult` shape + the failure-toast machinery for results.
- **Trigger (additive):** a Command-Palette command "Resume agents…" (+ optionally a CommandRoom CTA when a
  workspace has resumable-but-not-running sessions). Do NOT change the auto-resume drain effect.
- FEAT-1's modal uses the EXISTING per-provider color (+ its own short-id) so it does NOT depend on FEAT-7's
  `agentColor` (stays file-disjoint); echoing `agentColor` is a trivial post-merge follow-up.

### FEAT-3 — per-pane usage/cost — DEFERRED (needs a data-source spec)
Recon (confirming P4): there is **no per-PTY-session token/cost source.** `total_cost_usd`/`usage` exist only
in the Jorvis assistant path (`core/assistant/cli-envelope.ts`), never the panes; the PTY path captures raw
bytes only; no `agent_sessions` usage columns. FEAT-3 needs a NEW data layer (tail per-provider JSONL
transcripts → a `usage_ledger` table → week-window rollup → recharts) — its own round + spec. Parked → WISHLIST.

## Gate (each round)
`tsc -b` · `vitest` · build + electron:compile · full `tests/e2e/` · `eslint .` · Opus review. Worktree lanes
FF-align to the round's foundation SHA (the P3–P5 lesson). FEAT-7 + FEAT-1 are file-disjoint → 2 parallel lanes.

## Exit criteria (ROADMAP P6, per-feature)
Each feature ships behind its own acceptance test. Round-1: a relaunch-modal selectively relaunches a chosen
subset (and the auto-resume path is unchanged); panes + roster cards carry a stable per-agent color + short id.
(The leapfrog exit criteria — rewind restores a worktree checkpoint; merge-order merges N panes conflict-aware
without touching the base on conflict — are round-2.)
