# Pane Auto-Labeling — Design

**Date:** 2026-06-16
**Status:** Approved design; **mechanism pivoted after spike** (terminal-title → `SIGMA::LABEL`). Re-review pending.
**Area:** `src/renderer/features/command-room/`, `src/renderer/lib/`, `src/main/core/providers/launcher.ts`

## Problem

With many panes open in the Command Room they're hard to tell apart. The header
pill shows a deterministic cute alias ("Vera", "Nova") + effort — `● Vera · high`.
Two improvements:

1. **Claude auto-labels the pane** with what it's working on (the new capability).
2. **The operator can set their own label** — already shipped (`session.name` +
   `rpc.panes.rename`), but undiscoverable behind a bare double-click.

## Spike result (decisive — recorded 2026-06-16)

The original plan captured the **terminal title** (OSC 0/2). Four live PTY probes
proved this is a **dead end**: Claude Code (v2.1.177) sets a **static** title
`✳ Claude Code` and never puts the task in it — task activity renders in the TUI
body, not the title. Capturing it would label every pane "Claude Code", worse
than the alias. **Terminal-title capture is abandoned.**

Pivot (verified live): Claude **will emit a sentinel line** when instructed via
`--append-system-prompt`. Probe with the instruction *"emit `SIGMA::LABEL
<2-4 word summary>`"* + the task *"refactor the auth module to use async token
refresh"* produced exactly `SIGMA::LABEL Async token refresh refactor`. Both
the flag (`--append-system-prompt` is a valid top-level claude flag) and Claude's
compliance are confirmed.

## What already exists (do not rebuild)

- `AgentSession.name?: string | null` — operator display name, persisted on
  `agent_sessions.name` (migration `0036`).
- `AgentSession.initialPrompt?: string` — the launch task, available renderer-side.
- `rpc.panes.rename({ sessionId, name })` → `UPDATE agent_sessions.name` →
  broadcasts `panes:session-renamed`.
- `PaneHeader.tsx`: `localName` state, inline-edit on double-click, listens to
  `panes:session-renamed`, `displayLabel = localName?.trim() || id.alias`
  (line 176), rendered `{displayLabel} · {id.effortLabel}` (line 260), inner span
  `title="Double-click to rename"` (line 258).
- `prompt-watcher.ts` — the proven pattern for parsing `SIGMA::` sentinel lines
  out of a pane's PTY stream (subscribe `pty-data-bus` → `ProtocolLineBuffer` →
  parse → store, persists across remounts, disposed by the GC hook). The new
  label-watcher mirrors it.
- The manual-rename path (RPC → DB → broadcast → `localName`) and its persistence
  are **unchanged** by this work.

## Approved shape

**Two auto-label sources feed one slot; manual rename always wins.**

**Display precedence** — only the `displayLabel` fallback chain grows:

```
manual name  →  SIGMA::LABEL (Claude's own summary)  →  launch-prompt summary  →  alias (Vera)
```

```ts
const initialLabel = summarizePrompt(session.initialPrompt);          // floor
const displayLabel =
  localName?.trim() || agentLabel?.trim() || initialLabel || id.alias;
```

- **Source 1 — Claude self-emit (default, primary).** SigmaLink injects a
  claude-only `--append-system-prompt` at spawn instructing Claude to emit
  `SIGMA::LABEL <≤5-word summary>` when it starts/changes a task. A renderer
  `label-watcher.ts` (mirror of `prompt-watcher.ts`) parses the line → calls
  `setAgentLabel`. Best label quality. Degrades gracefully (no emit → floor/alias).
- **Source 2 — launch-prompt floor (deterministic).** `session.initialPrompt`
  is already known renderer-side; `summarizePrompt()` of it is a precedence tier
  below the SIGMA::LABEL. No hook, no `/dev/tty`, no project-settings write.
  (A full `UserPromptSubmit`-hook approach for *every* re-prompt was considered
  and rejected — hook stdout doesn't reach the PTY; it'd need a `/dev/tty` write
  + writing into the operator's repo `.claude/settings.local.json`. Out of scope.)
- **Manual always wins.** `localName` overrides both auto sources. Clearing it to
  empty reverts to SIGMA::LABEL → floor → alias.
- **Renderer-only except one main-side line** — the claude `--append-system-prompt`
  injection. No DB column, no `protocol.ts`/swarm change (the watcher parses
  `SIGMA::LABEL ` lines itself, reusing the pure `ProtocolLineBuffer`), so **zero
  swarm blast radius**.
- **Ephemeral.** The SIGMA::LABEL value lives in renderer memory; the floor is
  derived from `session.initialPrompt` each render. A resumed idle pane shows the
  floor (if it had a launch prompt) or the alias.
- **All providers display labels.** SIGMA::LABEL parsing is provider-agnostic; the
  `--append-system-prompt` injection is claude-only (codex/gemini get the floor +
  manual rename).

## Components

### 1. `pane-labels.ts` (new, ~90 LOC)
Module-scope store keyed by `sessionId` (mirrors `scratch-tabs.ts`), consumed via
`useSyncExternalStore`:
```ts
export function sanitizeLabel(raw: string): string | null;     // strip ANSI+ctrl, trim, cap 80, reject empty
export function summarizePrompt(p: string | null | undefined): string | null; // floor: collapse ws, cap 60, …
export function setAgentLabel(sessionId: string, raw: string): void;  // sanitizeLabel; junk → keep last good
export function getAgentLabel(sessionId: string): string | null;      // snapshot
export function subscribeAgentLabel(sessionId: string, cb: () => void): () => void;
export function clearAgentLabel(sessionId: string): void;             // on permanent removal
export function __resetAgentLabels(): void;                            // test-only
```
`sanitizeLabel` is conservative but light (source is deliberate text, not a noisy
title): strip ANSI escape sequences + control chars, collapse whitespace, trim,
reject empty, cap 80. **Last-good:** junk → ignored.

### 2. `label-watcher.ts` (new, ~50 LOC — mirrors `prompt-watcher.ts`)
```ts
export function ensureLabelWatcher(sessionId: string): void;   // idempotent; subscribePtyData + ProtocolLineBuffer
export function disposeLabelWatcher(sessionId: string): void;  // GC tears down
export function __resetLabelWatchers(): void;                  // test-only
```
On each buffered line: `if (/^SIGMA::LABEL\s+(.+)$/.test(line.trim())) setAgentLabel(sessionId, match[1])`.
Feeds the Task-1 store directly (no own state — unlike prompt-watcher). Persists
across remounts; the bus has no replay (accepted, same as prompt-watcher).

### 3. Claude `--append-system-prompt` injection (main-side, claude-only)
`src/main/core/providers/launcher.ts:buildArgs` (220-243): after `provider.args`,
when `provider.id === 'claude'`, push `'--append-system-prompt', PANE_LABEL_INSTRUCTION`.
`PANE_LABEL_INSTRUCTION` is a small constant. Applies to all claude spawns (pane +
swarm); benign for swarm (parser ignores unknown `SIGMA::LABEL`).

### 4. `PaneHeader.tsx`
- `useSyncExternalStore` → `agentLabel`.
- `initialLabel = summarizePrompt(session.initialPrompt)`.
- `displayLabel = localName?.trim() || agentLabel?.trim() || initialLabel || id.alias`.
- Tooltip `title=` (line 258) → full `{displayLabel} · {effortLabel}` (was the static hint).
- `startEditing` prefill → `localName ?? agentLabel ?? initialLabel ?? id.alias`.
- Listen for `sigma:pane-rename-request` (from the context menu) → `startEditing()`.
- Manual editor + rename RPC: **unchanged.**

### 5. `PaneShell.tsx`
- `useEffect` → `ensureLabelWatcher(session.id)` on mount (alongside `usePromptCard`).
- Context menu: `Rename label…` item → dispatch `sigma:pane-rename-request`.

### 6. `use-terminal-cache-gc.ts`
On permanent session removal (line ~50, beside `disposePromptWatcher`):
`clearAgentLabel(id); disposeLabelWatcher(id);`.

## Data flow

```
Claude (instructed via --append-system-prompt) prints  SIGMA::LABEL Async token refresh refactor
  → pty:data → pty-data-bus → label-watcher ProtocolLineBuffer → /^SIGMA::LABEL (.+)$/
  → setAgentLabel(sessionId, "Async token refresh refactor")  // sanitized; junk ignored
  → pane-labels store notifies → PaneHeader useSyncExternalStore re-renders
  → displayLabel: manual name || agentLabel || summarizePrompt(initialPrompt) || alias

Manual (unchanged): double-click / "Rename label…" → inline edit → rpc.panes.rename
  → UPDATE agent_sessions.name → broadcast panes:session-renamed → localName (wins).
```

## Error handling / lifecycle
- `sanitizeLabel` → null ⇒ ignored (no junk shown; last good kept).
- Watcher subscription disposed by the GC hook on permanent removal; label cleared
  there too (NOT on renderer-switch/eviction — that would false-clear a live pane).
- No `protocol.ts` change → swarm parser unaffected.

## Testing
- `pane-labels.test.ts` — `sanitizeLabel` (ANSI/ctrl strip, empty, cap),
  `summarizePrompt` (collapse, cap, null), store set/get/subscribe, last-good,
  no-notify-on-unchanged, `clearAgentLabel`.
- `label-watcher.test.ts` — feed `SIGMA::LABEL Reviewing auth\n` via a mocked
  pty-data bus → `getAgentLabel` updates; chunked line across two pushes; ignores
  non-LABEL lines; `disposeLabelWatcher` unsubscribes.
- `use-terminal-cache-gc.test.ts` — vanished session → label cleared + watcher disposed.
- `PaneHeader.test.tsx` — precedence (manual > agentLabel > initialPrompt > alias);
  empty manual reverts; tooltip full text; rename-request event opens editor.
- `PaneShell.test.tsx` — `Rename label…` dispatches `sigma:pane-rename-request`.
- providers/launcher test — claude spawn args include `--append-system-prompt`;
  a non-claude (e.g. codex) spawn does NOT.

## Out of scope (YAGNI / follow-ups)
- **Hiding the `SIGMA::LABEL` line from the pane transcript** — it's visible in
  scrollback (same as `SIGMA::PROMPT`). DOM-presenter line-filtering is a clean
  follow-up if the operator finds it noisy. (Flag at review.)
- Full `UserPromptSubmit` hook for re-prompt determinism (rejected above).
- Persisting the auto-label across restart (additive column; not needed — floor
  covers resumed panes that had a launch prompt).
- Adding a `LABEL` verb to the swarm `protocol.ts` (not needed; watcher self-parses).
