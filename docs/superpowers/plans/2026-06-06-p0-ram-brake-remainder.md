# P0 RAM Brake Remainder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the release-critical RAM Brake controls: hard admission caps, operator override UX, pane RSS/profile visibility, heavy-profile MCP wiring, diagnostics, and leak verification.

**Architecture:** Persist each pane's runtime profile on `agent_sessions`, then enforce caps in both spawn siblings before any worktree or PTY is created. Renderer launch surfaces catch structured RAM Brake errors and let the operator queue, cancel, or force the same request. Live chrome reads process-tree RSS through a focused PTY stats RPC, while MCP writer/diagnostics derive behavior from the shared runtime profile registry.

**Tech Stack:** Electron main process, better-sqlite3/Drizzle schema, React renderer, Vitest/node:test.

---

## File Map

- `app/src/shared/runtime-profiles.ts`: profile metadata, heavy-profile helpers, MCP server allowlists.
- `app/src/shared/types.ts`: `runtimeProfileId` persistence on `AgentSession`, `forceRamBrake` on launch/add inputs.
- `app/src/main/core/db/migrations/0035_agent_sessions_runtime_profile.ts`: forward migration for `agent_sessions.runtime_profile_id`.
- `app/src/main/core/db/schema.ts`, `client.ts`, `migrate.ts`: schema/bootstrap registration.
- `app/src/main/core/ram-brake/admission.ts`: cap defaults, live-count queries, structured rejection error.
- `app/src/main/core/workspaces/launcher.ts`: pre-launch budget check and persisted runtime profile.
- `app/src/main/core/swarms/factory-spawn.ts`, `factory-add-agent.ts`: +Pane/swarm admission check and persisted runtime profile.
- `app/src/main/core/browser/mcp-config-writer.ts`: security/full profile MCP wiring and stale pruning.
- `app/src/main/core/workspaces/mcp-diagnostic.ts`: profile-aware diagnostics.
- `app/src/main/core/pty/registry.ts`, `rpc-router.ts`, `schemas.ts`, `router-shape.ts`: per-session process stats RPC.
- `app/src/renderer/features/workspace-launcher/Launcher.tsx`: Queue/Cancel/Force over-budget dialog for workspace launch.
- `app/src/renderer/features/command-room/AddPaneButton.tsx`: Queue/Cancel/Force over-budget dialog for +Pane.
- `app/src/renderer/features/command-room/PaneHeader.tsx`, `usePaneLiveStats.ts`: profile badge and RSS readout.
- Focused tests in existing adjacent test files.

## Tasks

### Task 1: Persist Runtime Profile

- [ ] Add migration `0035_agent_sessions_runtime_profile.ts` with `ALTER TABLE agent_sessions ADD COLUMN runtime_profile_id TEXT NOT NULL DEFAULT 'ruflo-core'`.
- [ ] Register migration in `migrate.ts` and add schema/client bootstrap column.
- [ ] Add `runtimeProfileId?: AgentRuntimeProfileId` to `AgentSession`.
- [ ] Persist `runtimeProfileId` in both `launcher.ts` and `factory-spawn.ts`.
- [ ] Map it from `loadAgentSession` and `panes.listForWorkspace`.

### Task 2: Main-Process Admission Control

- [ ] Add `app/src/main/core/ram-brake/admission.ts`.
- [ ] Default caps: total live panes 24, per-workspace live panes 12, MCP-heavy live panes 4.
- [ ] Count live rows by `status IN ('starting','running')`; count heavy by persisted runtime profile plus requested profiles.
- [ ] Throw `RamBrakeAdmissionError` with machine-readable details unless `forceRamBrake` is true.
- [ ] Call the check before worktree/PTY creation in `executeLaunchPlan` and before worktree/PTY creation in `spawnAgentSession`.

### Task 3: Queue / Cancel / Force UX

- [ ] Add `forceRamBrake?: boolean` to `LaunchPlan` and `AddAgentToSwarmInput`.
- [ ] Accept `forceRamBrake` in `swarms.addAgent` zod schema.
- [ ] In `Launcher.tsx`, catch RAM Brake errors and open a themed dialog with Queue, Cancel, Force launch.
- [ ] Queue stores the pending launch request locally with Retry and Force controls.
- [ ] In `AddPaneButton.tsx`, add the same dialog for the selected provider add request.

### Task 4: Live Pane RSS + Profile Chrome

- [ ] Add `pty.processStats(sessionId)` RPC returning `{ supported, rssBytes, descendantPids, processCount }`.
- [ ] Extend `usePaneLiveStats` to poll RSS through the new RPC while running.
- [ ] Render a compact profile badge and RSS readout in `PaneHeader`.
- [ ] Keep polling status-gated so exited/error panes do not create a poll storm.

### Task 5: Heavy MCP Profiles + Diagnostics

- [ ] Extend `mcp-config-writer.ts` so `security-tools` writes a `semgrep` MCP entry and `full-tools` writes Browser, SigmaMemory, and Semgrep.
- [ ] Prune stale `semgrep` config when the selected profile does not allow security MCP.
- [ ] Extend MCP diagnostics to report which profile is active and which optional MCP servers are disabled by profile rather than missing/broken.
- [ ] Add focused writer and diagnostics tests.

### Task 6: PERF-RAM-2 Leak Verification

- [ ] Trace `PaneHeader` close → `rpc.pty.kill` → `PtyRegistry.kill`.
- [ ] Trace `swarms.kill` → `killSwarm` → `PtyRegistry.kill`.
- [ ] If child process trees are not stopped, change both kill paths to call process-tree stop logic through the registry.
- [ ] Add a registry test proving `kill()` stops the process tree or prove existing `forget()`/kill path already does.

### Task 7: Verification

- [ ] Run `pnpm build`.
- [ ] Run `pnpm lint`.
- [ ] Run focused Vitest/node tests for admission, MCP writer, renderer launch/add UX, pane live stats, and PTY registry.
- [ ] Re-read this plan and verify every checkbox has code/test coverage or an explicit evidence note.
