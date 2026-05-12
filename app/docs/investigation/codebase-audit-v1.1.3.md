# Codebase Audit & Optimization Investigation (v1.1.3)

This document consolidates findings from a comprehensive audit of the SigmaLink codebase performed by a Ruflo agent swarm. The investigation covers bugs, dead code, logic optimizations, and performance improvements across the main and renderer processes.

---

## 🏗 Backend — Main Process

### 🔴 High Priority Bugs & Reliability Issues
1. **Broken Command Fallback** (`src/main/core/providers/launcher.ts`):
   - `resolveAndSpawn` attempts to try alternative commands if the primary fails. However, `spawnLocalPty` swallows errors and returns `null` instead of throwing `ENOENT`, causing the loop to terminate prematurely without trying alternatives.
2. **Process Leaks in Registry** (`src/main/core/pty/registry.ts`):
   - `pty.forget()` removes a session from the registry but does **not** kill the underlying PTY process if it's still alive.
   - `killAll()` schedules redundant 5s timeouts for every session, which can cause excessive timer overhead during mass shutdowns.
3. **Ghost Processes in Exec** (`src/main/lib/exec.ts`):
   - `execCmd` fails to kill child processes that are terminated because they hit `maxBuffer`. The process may continue to run in the background despite the error being returned.
4. **Git Concurrency Safety** (`src/main/core/git/git-ops.ts`):
   - `commitAndMerge` lacks a locking mechanism. Concurrent attempts to access the same repository (e.g., from multiple swarms) could lead to race conditions or index corruption.

### 🟠 Optimization Opportunities
1. **Database Efficiency** (`src/main/core/db/janitor.ts` & `src/main/core/swarms/factory-spawn.ts`):
   - The boot janitor and swarm launcher perform individual row updates in loops. These should be moved to **batch updates** or handled within a single transaction to reduce I/O overhead.
2. **Missing Cascade Deletes** (`src/main/core/db/schema.ts`):
   - `agent_sessions` lacks an `ON DELETE CASCADE` relationship with workspaces. This can lead to orphaned worktrees and database rows when a workspace is removed.
3. **RingBuffer Performance** (`src/main/core/pty/registry.ts`):
   - The terminal `RingBuffer` uses `Array.prototype.shift()`, which is an O(N) operation. For large terminal buffers, this becomes a performance bottleneck. Suggest using a linked list or a circular buffer implementation.

---

## 🤖 Orchestration — Assistant & Swarms

### 🔴 High Priority Bugs & Reliability Issues
1. **Mailbox Broadcast Failure Chain** (`src/main/core/swarms/mailbox.ts`):
   - The broadcast loop in `doAppend` for JSONL mirroring and PTY echoes terminates early if a single recipient's operation fails. This causes remaining agents in the `@all` or `@coordinators` group to miss the message.
2. **RoleIndex Race Condition** (`src/main/core/swarms/factory.ts`):
   - `addAgentToSwarm` determines the next `roleIndex` using a non-atomic read-then-write approach. Concurrent requests to add the same role to a swarm will result in duplicate indexes and DB unique constraint violations.
3. **Stdin Queue Hangs** (`src/main/core/assistant/runClaudeCliTurn.emit.ts`):
   - The `StdinWriter` queue is susceptible to permanent hangs if the CLI process becomes unresponsive or stops reading `stdin`. There is no timeout on the promise-based write chain.

### 🟠 Optimization Opportunities
1. **Mailbox Performance Isolation** (`src/main/core/swarms/mailbox.ts`):
   - Currently, a global single-writer queue handles all messages for all swarms. High-volume activity in one swarm can block message delivery for others. Suggest moving to **per-swarm queues**.
2. **Out-of-Order Tool Results** (`src/main/core/assistant/runClaudeCliTurn.trajectory.ts`):
   - Concurrent tool execution from multiple envelopes can lead to tool results being returned to the CLI in an order different from their invocation. While technically allowed by some protocols, it can confuse agents and should be guarded.

---

## 🎨 Frontend — Renderer Process

### 🟠 Performance & Logic Optimizations
1. **State Consumption Overhead** (`src/renderer/app/state.hook.ts`):
   - Many high-level components (e.g., `Terminal`, `Sidebar`, `Launcher`) use the full `useAppState()` hook. This triggers a re-render of the entire component whenever **any** part of the global state changes (even if irrelevant, like a notification count). 
   - **Suggestion**: Use `useAppStateSelector()` to subscribe only to specific state slices.
2. **React 19 Modernization**:
   - The codebase does not yet utilize React 19's `useActionState` for handling async operations with `busy` and `error` flags (prevalent in `SwarmRoom` and `TasksRoom`).
   - Long-running UI transitions (like room switching) should be wrapped in `useTransition` to keep the UI responsive.
3. **Canvas Animation Gating** (`src/renderer/features/operator-console/Constellation.tsx`):
   - The force-directed graph uses a manual `requestAnimationFrame` loop that runs continuously even when the tab is hidden. It should be gated by the `data-active` attribute.
4. **Browser State "Smearing"** (`src/renderer/features/browser/BrowserRoom.tsx`):
   - The `BrowserRoom` state slice is spread in the reducer on every change, creating fresh objects that invalidate downstream `useMemo` hooks even when values are identical.

### ⚪ Dead Code
- `src/renderer/features/placeholders/PhasePlaceholder.tsx`: Identified as a development remnant not used in any production routes.
- `RoomChrome.tsx`: Under-utilized; suggest consolidating into a single standard layout wrapper.

---

## 📄 Documentation & Memory Updates
- **Master Memory**: Phase 8 investigation milestone recorded.
- **Memory Index**: Task T-63 (Codebase Audit) added.
