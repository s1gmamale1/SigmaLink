# Pane Auto-Labeling — TUI Read-Path Fix — Design

**Date:** 2026-06-23
**Status:** Approved design.
**Area:** `src/renderer/lib/` (label read path), `src/renderer/features/command-room/PaneHeader.tsx`
**Base:** fresh worktree off `origin/main` (branch `feat/pane-auto-label-tui-fix`).

## Problem

Pane auto-labeling shipped in v2.7.0 (PR #176). The app injects a claude-only
`--append-system-prompt` instructing Claude to emit `SIGMA::LABEL <summary>`; a
renderer `label-watcher.ts` is supposed to parse that line and feed the
`pane-labels` store, which `PaneHeader` renders. **The injection works** (live
panes carry the flag; Claude emits the sentinel) **but the header never updates** —
the operator sees the sentinel as noise inside the TUI body and nothing on the
pane chrome.

## Root cause (verified live, byte-level)

`label-watcher.ts` subscribes to the raw `pty:data` byte stream, splits on `\n`
(`ProtocolLineBuffer`), and matches the **anchored** regex
`/^SIGMA::LABEL\s+(.+)$/` against `line.trim()`.

Interactive Claude Code is a **full-screen TUI that paints with cursor-control
escape sequences, not newline-delimited stdout.** A PTY capture of Claude
emitting "SIGMA::LABEL say hello" produced:

```
…\x1b[2C\x1b[9ASIGMA::LABEL\x1b[16Gsay\x1b[20Ghello
```

Two independent reasons the anchored byte-regex can never match:

1. The logical line is **preceded by cursor-move escapes** (`\x1b[2C\x1b[9A`), so
   it does not start with `SIGMA::LABEL`; `.trim()` only strips whitespace, not
   ANSI, so the anchor fails.
2. The words are spaced by **absolute-column jumps** (`\x1b[16G`, `\x1b[20G`), not
   space characters. Stripping ANSI collapses the line to `SIGMA::LABELsayhello`.

Therefore the store is never fed → the header stays on the deterministic alias.

**Why it escaped review:** unit tests fed a clean `SIGMA::LABEL foo\n`; the spike
verified emission in clean / non-interactive mode (`claude -p`-style), not the
interactive TUI repaint stream the app actually spawns. (Recurring
"specs-out-run-shipped / test-the-right-build" class.)

The same applies to the swarm `SIGMA::*` verbs — they work only because swarm
agents run **non-interactively** (clean stdout), unlike interactive panes.

## Key insight

The DOM presenter (the **default** renderer) already solves the hard part. Each
DOM-mode session has a per-session `TerminalEngine` (`engine-cache.ts`) wrapping
`@xterm/headless` — xterm's full escape-sequence parser + buffer. It consumes the
same cursor-paint byte stream via `engine.write()` and exposes:

- `logicalLines(startRow?, endRow?): { startRow; text }[]` — rendered logical
  lines with wrapped continuations joined and cursor-jumps resolved to real
  columns. "SIGMA::LABEL say hello" comes out **correctly spaced**.
- `onBufferChanged(cb): () => void` — coalesced buffer-change notifications.

So: **read the label from the rendered engine buffer, not the raw bytes.** The
opt-in `xterm` renderer mode (`terminal-cache.ts`, classic `@xterm/xterm`) has the
same `buffer.active` API + an `onRender` event, so it gets parity cheaply.

## Approved shape

**Read the sentinel from the parsed terminal buffer; keep the store + header
display chain unchanged (they were always correct, just never fed).**

### 1. `pane-labels.ts` — UNCHANGED
The store, `sanitizeLabel`, and `summarizePrompt` are correct. No edit.

### 2. `pane-label-scan.ts` (new, pure, ~25 LOC)
```ts
export function extractLabel(lines: string[]): string | null;
```
Scans rendered logical-line strings, returns the text of the **last** line that
is the sentinel after an optional leading bullet/indent decoration, else null:
```ts
const SENTINEL = /^[\s>│⏺•*\-]*SIGMA::LABEL\s+(.+?)\s*$/;
```
Pure → unit-tested in isolation. "Last match wins" because the agent re-emits on
task change and the freshest line is at/near the bottom of the scan window.

### 3. `label-reader.ts` (new, replaces `label-watcher.ts`)
Reads from the live parsed buffer instead of raw bytes:
```ts
export function attachEngineLabelReader(sessionId: string, engine: TerminalEngine): void;
export function attachXtermLabelReader(sessionId: string, term: Terminal): void; // @xterm/xterm
export function detachLabelReader(sessionId: string): void;       // idempotent
export function __resetLabelReaders(): void;                       // test-only
```
- `attachEngineLabelReader`: subscribe `engine.onBufferChanged` (already
  coalesced). On change, read `engine.logicalLines(start, end)` over a **bounded
  recent window** (last `SCAN_LINES = 60` logical lines, derived from
  `engine.logicalLines()` length) → `extractLabel` → `setAgentLabel`
  (sanitize + last-good + no-notify-on-unchanged already live in the store).
- `attachXtermLabelReader`: subscribe `term.onRender`; read the last `SCAN_LINES`
  rows of `term.buffer.active` via `translateToString(true)` (joining `isWrapped`
  continuations) → `extractLabel` → `setAgentLabel`.
- `detachLabelReader`: unsubscribe + drop. Idempotent; safe if never attached.
- One reader per session (idempotent attach); a session is only ever in ONE mode
  at a time (engine/xterm mutual exclusion is enforced upstream by the caches),
  so the two attach paths never run concurrently for the same session.

### 4. Wiring — attach where the PTY is already parsed
- `engine-cache.ts`: in `getOrCreateEngine`, after the engine is constructed,
  `attachEngineLabelReader(sessionId, engine)`; in `destroyEngine`,
  `detachLabelReader(sessionId)`.
- `terminal-cache.ts`: at xterm Terminal creation, `attachXtermLabelReader`; at
  its destroy/eviction, `detachLabelReader`.
- `PaneShell.tsx`: **remove** the dead `ensureLabelWatcher(session.id)` mount
  effect + import.
- `use-terminal-cache-gc.ts`: keep `clearAgentLabel(id)` on permanent removal;
  replace `disposeLabelWatcher(id)` → `detachLabelReader(id)` (belt-and-suspenders;
  the caches already detach on destroy).
- Delete `label-watcher.ts` + `label-watcher.test.ts`; update the
  `CommandRoom.test.tsx` mock (`vi.mock('@/renderer/lib/label-watcher' …)`).

### 5. `PaneHeader.tsx` — visible rename affordance
Add a small pencil/edit affordance shown on hover/focus of the title pill that
calls the existing `startEditing()`. Keep double-click and the context-menu
`Rename label…` item. Manual rename (RPC → DB → broadcast → `localName`) is
otherwise unchanged. `displayLabel` precedence is unchanged:
`localName → agentLabel (SIGMA::LABEL) → summarizePrompt(initialPrompt) → alias`.

## Data flow

```
claude TUI paints  …\x1b[9ASIGMA::LABEL\x1b[16Gsay\x1b[20Ghello
  → pty:data → engine.write()  [@xterm/headless resolves cursor-jumps]
  → onBufferChanged (coalesced)
  → engine.logicalLines(recent window)  →  "… SIGMA::LABEL say hello"
  → extractLabel → "say hello"
  → setAgentLabel(sessionId, "say hello")  [sanitize + last-good]
  → pane-labels store notifies → PaneHeader useSyncExternalStore re-renders
  → displayLabel: localName || agentLabel || summarizePrompt(initialPrompt) || alias
```

## Testing

- `pane-label-scan.test.ts` (pure): leading bullet/indent forms, column-spaced
  rendered form, last-match-wins, no-match, reject mid-prose mention
  (`see the SIGMA::LABEL foo line` must NOT match — the sentinel is not at the
  effective line start).
- `label-reader.test.ts` **(regression — the centerpiece):** construct a real
  `TerminalEngine`, `engine.write("\x1b[2C\x1b[9ASIGMA::LABEL\x1b[16Gsay\x1b[20Ghello\n")`,
  drive the attached reader → assert `getAgentLabel(id) === "say hello"`. This
  exercises the exact production path through the real parser and would have
  caught the original bug. Also: re-emit updates the label; detach stops updates.
- `engine-cache` wiring: `getOrCreateEngine` attaches a reader; `destroyEngine`
  detaches it. (Mock `label-reader` to assert attach/detach calls, matching the
  cache's existing test style; or assert behavior via a real engine.)
- `PaneHeader.test.tsx`: clicking the new affordance opens inline edit
  (`pane-rename-input` present). Existing precedence/tooltip tests unchanged.

## Error handling / lifecycle

- `extractLabel` → null ⇒ `setAgentLabel` not called for that scan (store keeps
  last good). Malformed/empty → `sanitizeLabel` rejects in the store.
- Reader lifecycle is owned by the caches (attach on create, detach on destroy),
  so it tracks the live renderer; `use-terminal-cache-gc` clears the label on
  permanent session removal.
- No `protocol.ts`/swarm change. No DB change. The main-side
  `--append-system-prompt` injection already ships — untouched.

## Known limitations (accepted)

- **False positive:** a bare `SIGMA::LABEL X` line that appears in the recent
  on-screen window (e.g. quoted output) can be picked up. Accepted: the operator
  chose to leave the sentinel visible in scrollback (sentinel-in-transcript
  model, same as `SIGMA::PROMPT`); last-good + the agent re-emitting its real
  task line mitigate. The scan requires the sentinel at the effective line start,
  so mid-sentence mentions do not match.
- **Alt-screen emission:** if the sentinel is emitted while the pane is in an
  alternate-screen mode, it is caught on the next normal-buffer re-emit. The
  assistant transcript (where the label prints) is the normal buffer.

## Out of scope (YAGNI / follow-ups)

- Hiding the `SIGMA::LABEL` line from the rendered transcript (operator chose to
  keep it visible). Clean presenter-side follow-up if it becomes noisy.
- Persisting the auto-label across restart (floor covers resumed panes that had a
  launch prompt).
- Backporting the fix onto the operator's stale `feat/tools-in-scoped-windows`
  branch (separate concern; this lands on `main`).
