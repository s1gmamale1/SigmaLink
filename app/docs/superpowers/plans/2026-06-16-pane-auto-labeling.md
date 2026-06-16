# Pane Auto-Labeling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a pane show what Claude is working on — Claude self-emits a `SIGMA::LABEL <text>` sentinel (via an injected system prompt) that the app parses into the header pill, with the launch prompt as a deterministic floor and the operator's manual rename always winning.

**Architecture:** Renderer-only except one main-side line (a claude-only `--append-system-prompt`). A module-scope store (`pane-labels.ts`) holds the latest sanitized label per `sessionId`. A renderer `label-watcher.ts` (mirror of the proven `prompt-watcher.ts`) parses `SIGMA::LABEL` lines from the pane's PTY stream → `setAgentLabel`. `PaneHeader` consumes the store via `useSyncExternalStore`, extending its display chain to `manual name → SIGMA::LABEL → summarizePrompt(initialPrompt) → alias`. No DB column; no `protocol.ts`/swarm change (the watcher self-parses, reusing the pure `ProtocolLineBuffer`).

**Tech Stack:** TypeScript, React 19 (`useSyncExternalStore`), Vitest + jsdom + RTL, the existing `pty-data-bus` + `ProtocolLineBuffer`, claude CLI `--append-system-prompt` (verified v2.1.177).

**Working tree:** Current branch `feat/remote-stt-openrouter` has unrelated in-flight changes. **Work in a fresh worktree off `origin/main`** (`superpowers:using-git-worktrees`), branch `feat/pane-auto-label`. First commit lands the spec + plan docs.

**Gate before commit:** `npx tsc -b` + `npx vitest run <files>` + lint. Defer e2e to CI. Never run `electron:dev`/`playwright` locally.

---

## File Structure

- **Create** `src/renderer/lib/pane-labels.ts` — module-scope label store + `sanitizeLabel` + `summarizePrompt`.
- **Create** `src/renderer/lib/pane-labels.test.ts`.
- **Create** `src/renderer/lib/label-watcher.ts` — per-pane PTY watcher parsing `SIGMA::LABEL` → `setAgentLabel` (mirrors `prompt-watcher.ts`).
- **Create** `src/renderer/lib/label-watcher.test.ts`.
- **Modify** `src/shared/providers.ts` — `PANE_LABEL_INSTRUCTION` constant + pure `paneLabelArgs(providerId)` helper (vitest-safe; testable without the native-heavy launcher).
- **Modify** `src/shared/providers.test.ts` (or create) — `paneLabelArgs` claude-vs-other.
- **Modify** `src/main/core/providers/launcher.ts` — `buildArgs` pushes `...paneLabelArgs(provider.id)`.
- **Modify** `src/renderer/features/command-room/PaneHeader.tsx` — store subscription, precedence, tooltip, rename-prefill, rename-request listener.
- **Modify** `src/renderer/features/command-room/PaneHeader.test.tsx`.
- **Modify** `src/renderer/features/command-room/PaneShell.tsx` — `ensureLabelWatcher` on mount + `Rename label…` context-menu item.
- **Modify** `src/renderer/features/command-room/PaneShell.test.tsx`.
- **Modify** `src/renderer/app/state-hooks/use-terminal-cache-gc.ts` — `clearAgentLabel(id)` + `disposeLabelWatcher(id)` on permanent removal.
- **Modify** `src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`.

---

## Task 0: Spike — DONE (recorded; no code)

- [x] **Terminal-title capture is dead.** 4 PTY probes: Claude (v2.1.177) sets a static OSC title `✳ Claude Code`, never task-specific. Abandoned.
- [x] **Pivot verified.** `--append-system-prompt` is a valid top-level claude flag; instructed with *"emit `SIGMA::LABEL <2-4 word summary>`"* + task "refactor auth to async token refresh", Claude emitted `SIGMA::LABEL Async token refresh refactor`. Mechanism confirmed.
- [x] **Known tradeoff:** the `SIGMA::LABEL` line is visible in the pane transcript (same as `SIGMA::PROMPT`). Display-filtering deferred (see spec Out of Scope).

---

## Task 1: `pane-labels.ts` store + `sanitizeLabel` + `summarizePrompt`

**Files:** Create `src/renderer/lib/pane-labels.ts`; Test `src/renderer/lib/pane-labels.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/renderer/lib/pane-labels.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sanitizeLabel, summarizePrompt,
  setAgentLabel, getAgentLabel, subscribeAgentLabel, clearAgentLabel, __resetAgentLabels,
} from './pane-labels';

afterEach(() => __resetAgentLabels());

describe('sanitizeLabel', () => {
  it('keeps a normal label, trimmed', () => {
    expect(sanitizeLabel('  Async token refresh refactor  ')).toBe('Async token refresh refactor');
  });
  it('strips ANSI escape sequences and control chars', () => {
    expect(sanitizeLabel('\x1b[31mReviewing auth\x1b[0m')).toBe('Reviewing auth');
    expect(sanitizeLabel('Build\x07 step')).toBe('Build step');
  });
  it('collapses internal whitespace', () => {
    expect(sanitizeLabel('a   b\t c')).toBe('a b c');
  });
  it('rejects empty / whitespace-only', () => {
    expect(sanitizeLabel('   ')).toBeNull();
    expect(sanitizeLabel('')).toBeNull();
  });
  it('caps at 80 chars', () => {
    expect(sanitizeLabel('x'.repeat(200))?.length).toBe(80);
  });
});

describe('summarizePrompt', () => {
  it('returns null for empty/nullish', () => {
    expect(summarizePrompt(null)).toBeNull();
    expect(summarizePrompt(undefined)).toBeNull();
    expect(summarizePrompt('   ')).toBeNull();
  });
  it('collapses whitespace/newlines to one line', () => {
    expect(summarizePrompt('Refactor the\n  auth module')).toBe('Refactor the auth module');
  });
  it('caps long prompts with an ellipsis', () => {
    const out = summarizePrompt('x'.repeat(200));
    expect(out?.length).toBe(60);
    expect(out?.endsWith('…')).toBe(true);
  });
});

describe('agent-label store', () => {
  it('stores a sanitized label and reads it back', () => {
    setAgentLabel('s1', 'Reviewing auth');
    expect(getAgentLabel('s1')).toBe('Reviewing auth');
  });
  it('returns null for unknown session', () => {
    expect(getAgentLabel('nope')).toBeNull();
  });
  it('keeps the last good value when junk arrives', () => {
    setAgentLabel('s1', 'Reviewing auth');
    setAgentLabel('s1', '   ');
    expect(getAgentLabel('s1')).toBe('Reviewing auth');
  });
  it('notifies on change, stops after unsubscribe', () => {
    const cb = vi.fn();
    const off = subscribeAgentLabel('s1', cb);
    setAgentLabel('s1', 'A');
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    setAgentLabel('s1', 'B');
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('does not notify when sanitized value is unchanged', () => {
    const cb = vi.fn();
    subscribeAgentLabel('s1', cb);
    setAgentLabel('s1', 'A');
    setAgentLabel('s1', 'A');
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('clearAgentLabel removes the entry and notifies', () => {
    const cb = vi.fn();
    subscribeAgentLabel('s1', cb);
    setAgentLabel('s1', 'A');
    clearAgentLabel('s1');
    expect(getAgentLabel('s1')).toBeNull();
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/lib/pane-labels.test.ts`
Expected: FAIL — `Cannot find module './pane-labels'`.

- [ ] **Step 3: Implement `pane-labels.ts`**

```ts
// Renderer-only, ephemeral pane auto-label store. Holds the latest SANITIZED
// label per sessionId, fed by label-watcher.ts (Claude's SIGMA::LABEL line).
// PaneHeader reads it via useSyncExternalStore; precedence is
// `manual name → this label → summarizePrompt(initialPrompt) → alias`.
// Not persisted. Mirrors the module-scope store pattern of scratch-tabs.ts.

const LABEL_CAP = 80;
const PROMPT_CAP = 60;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g; // CSI sequences (colors, cursor)

/** Clean a label: strip ANSI + control chars, collapse whitespace, trim, cap.
 *  Returns null for junk (empty after cleaning). Callers treat null as
 *  "ignore — keep the last good value". */
export function sanitizeLabel(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(ANSI, '').replace(/[\x00-\x1f\x7f]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return s.length > LABEL_CAP ? s.slice(0, LABEL_CAP) : s;
}

/** Floor label derived from the launch prompt. Collapse to one line, cap with
 *  an ellipsis. Returns null when there's no usable prompt. */
export function summarizePrompt(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const s = prompt.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return s.length > PROMPT_CAP ? s.slice(0, PROMPT_CAP - 1).trimEnd() + '…' : s;
}

const labels = new Map<string, string>();
const subs = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const set = subs.get(sessionId);
  if (set) for (const cb of set) cb();
}

/** Feed a raw label. Junk is ignored (last good value preserved). */
export function setAgentLabel(sessionId: string, raw: string): void {
  const clean = sanitizeLabel(raw);
  if (clean === null) return;
  if (labels.get(sessionId) === clean) return; // no-op → no notify
  labels.set(sessionId, clean);
  notify(sessionId);
}

/** Snapshot for useSyncExternalStore (stable string | null). */
export function getAgentLabel(sessionId: string): string | null {
  return labels.get(sessionId) ?? null;
}

export function subscribeAgentLabel(sessionId: string, cb: () => void): () => void {
  let set = subs.get(sessionId);
  if (!set) { set = new Set(); subs.set(sessionId, set); }
  set.add(cb);
  return () => {
    const s = subs.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subs.delete(sessionId);
  };
}

/** Permanent removal (pane closed). Clears the value and notifies. */
export function clearAgentLabel(sessionId: string): void {
  if (!labels.has(sessionId)) return;
  labels.delete(sessionId);
  notify(sessionId);
}

/** Test-only: wipe all labels. */
export function __resetAgentLabels(): void {
  labels.clear();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/lib/pane-labels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/pane-labels.ts src/renderer/lib/pane-labels.test.ts
git commit -m "feat(command-room): add pane auto-label store + sanitizer + prompt floor"
```

---

## Task 2: `label-watcher.ts` (SIGMA::LABEL source) + PaneShell wiring

**Files:**
- Create: `src/renderer/lib/label-watcher.ts`
- Test: `src/renderer/lib/label-watcher.test.ts`
- Modify: `src/renderer/features/command-room/PaneShell.tsx` (import + a mount effect)

- [ ] **Step 1: Write the failing test**

`src/renderer/lib/label-watcher.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

// Controllable mock of the PTY data bus.
vi.mock('@/renderer/lib/pty-data-bus', () => {
  const subs = new Map<string, (p: { sessionId: string; data: string }) => void>();
  return {
    subscribePtyData: (id: string, fn: (p: { sessionId: string; data: string }) => void) => {
      subs.set(id, fn);
      return () => subs.delete(id);
    },
    __emit: (id: string, data: string) => subs.get(id)?.({ sessionId: id, data }),
    __has: (id: string) => subs.has(id),
  };
});

import * as bus from '@/renderer/lib/pty-data-bus';
import { ensureLabelWatcher, disposeLabelWatcher, __resetLabelWatchers } from './label-watcher';
import { getAgentLabel, __resetAgentLabels } from './pane-labels';

const emit = (id: string, data: string) => (bus as unknown as { __emit: (i: string, d: string) => void }).__emit(id, data);
const has = (id: string) => (bus as unknown as { __has: (i: string) => boolean }).__has(id);

afterEach(() => { __resetLabelWatchers(); __resetAgentLabels(); });

describe('label-watcher', () => {
  it('parses a SIGMA::LABEL line into the label store', () => {
    ensureLabelWatcher('s1');
    emit('s1', 'SIGMA::LABEL Reviewing auth\n');
    expect(getAgentLabel('s1')).toBe('Reviewing auth');
  });
  it('handles a line split across two chunks', () => {
    ensureLabelWatcher('s1');
    emit('s1', 'SIGMA::LABEL Refactor');
    emit('s1', ' tokens\n');
    expect(getAgentLabel('s1')).toBe('Refactor tokens');
  });
  it('ignores non-LABEL output', () => {
    ensureLabelWatcher('s1');
    emit('s1', 'just normal terminal output\n');
    expect(getAgentLabel('s1')).toBeNull();
  });
  it('is idempotent (one subscription per session)', () => {
    ensureLabelWatcher('s1');
    ensureLabelWatcher('s1');
    expect(has('s1')).toBe(true);
  });
  it('disposeLabelWatcher unsubscribes', () => {
    ensureLabelWatcher('s1');
    disposeLabelWatcher('s1');
    expect(has('s1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/lib/label-watcher.test.ts`
Expected: FAIL — `Cannot find module './label-watcher'`.

- [ ] **Step 3: Implement `label-watcher.ts`**

```ts
// Per-pane SIGMA::LABEL watcher — the Claude-auto-label source. Mirrors
// prompt-watcher.ts: a persistent pty-data-bus subscription + ProtocolLineBuffer
// that survives React unmounts (the bus has no replay). Unlike prompt-watcher
// it owns no state — it feeds the pane-labels store directly. Disposed by the
// terminal-cache GC when the session leaves app state.
//
// ProtocolLineBuffer is a pure module (no node/electron deps); prompt-watcher
// already imports it from the same path, so there is no bundling hazard.

import { ProtocolLineBuffer } from '@/main/core/swarms/protocol';
import { subscribePtyData } from '@/renderer/lib/pty-data-bus';
import { setAgentLabel } from '@/renderer/lib/pane-labels';

const LABEL_LINE = /^SIGMA::LABEL\s+(.+)$/;

const watchers = new Map<string, { off: () => void }>();

/** Install the persistent watcher for a session (idempotent). */
export function ensureLabelWatcher(sessionId: string): void {
  if (watchers.has(sessionId)) return;
  const buf = new ProtocolLineBuffer();
  const off = subscribePtyData(sessionId, ({ data }) => {
    buf.push(data, (line) => {
      const m = LABEL_LINE.exec(line.trim());
      if (m) setAgentLabel(sessionId, m[1]); // sanitized + last-good in the store
    });
  });
  watchers.set(sessionId, { off });
}

/** Tear down a session's watcher. Idempotent; called by the GC. */
export function disposeLabelWatcher(sessionId: string): void {
  const w = watchers.get(sessionId);
  if (!w) return;
  try {
    w.off();
  } catch {
    /* bus already reset — ignore */
  }
  watchers.delete(sessionId);
}

/** Test-only: wipe all watchers. */
export function __resetLabelWatchers(): void {
  for (const id of Array.from(watchers.keys())) disposeLabelWatcher(id);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/lib/label-watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `ensureLabelWatcher` into PaneShell**

In `PaneShell.tsx`, add the import (near the other `@/renderer/lib` imports):
```ts
import { ensureLabelWatcher } from '@/renderer/lib/label-watcher';
```
Add a mount effect inside the `PaneShell` component body (near the existing
`useUncommittedCount` / prompt-card setup, after `const uncommitted = …`):
```ts
  // Auto-label — install the SIGMA::LABEL watcher for this pane. Idempotent +
  // persists across remounts (module-scope); the cache GC disposes it on close.
  useEffect(() => {
    ensureLabelWatcher(session.id);
  }, [session.id]);
```
(`useEffect` is already imported in PaneShell.)

- [ ] **Step 6: Type-check + commit**

Run: `npx tsc -b`
Expected: no errors.
```bash
git add src/renderer/lib/label-watcher.ts src/renderer/lib/label-watcher.test.ts src/renderer/features/command-room/PaneShell.tsx
git commit -m "feat(command-room): SIGMA::LABEL watcher feeds the pane auto-label store"
```

---

## Task 3: Inject the claude-only `--append-system-prompt`

**Files:**
- Modify: `src/shared/providers.ts` (add constant + pure helper)
- Test: `src/shared/providers.test.ts` (create if absent)
- Modify: `src/main/core/providers/launcher.ts:buildArgs` (line 229 area)

- [ ] **Step 1: Write the failing test**

`src/shared/providers.test.ts` (add this block; create the file with the import if it doesn't exist):
```ts
import { describe, expect, it } from 'vitest';
import { paneLabelArgs, PANE_LABEL_INSTRUCTION } from './providers';

describe('paneLabelArgs', () => {
  it('injects --append-system-prompt for claude', () => {
    expect(paneLabelArgs('claude')).toEqual(['--append-system-prompt', PANE_LABEL_INSTRUCTION]);
  });
  it('injects nothing for non-claude providers', () => {
    expect(paneLabelArgs('codex')).toEqual([]);
    expect(paneLabelArgs('gemini')).toEqual([]);
    expect(paneLabelArgs('shell')).toEqual([]);
  });
  it('the instruction names the SIGMA::LABEL sentinel', () => {
    expect(PANE_LABEL_INSTRUCTION).toContain('SIGMA::LABEL');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/providers.test.ts`
Expected: FAIL — `paneLabelArgs is not exported`.

- [ ] **Step 3: Implement in `src/shared/providers.ts`**

Add near the top-level exports:
```ts
/** Injected into pane Claude spawns via --append-system-prompt so the pane
 *  self-labels. Kept short for compliance; label-watcher parses the line. */
export const PANE_LABEL_INSTRUCTION =
  'When you start working on a task, output one line exactly in the form ' +
  '"SIGMA::LABEL <a 2-4 word summary of the task>" and nothing else on that ' +
  'line, before your other output. Emit it again whenever the task changes.';

/** Claude-only auto-label args. Other providers get the launch-prompt floor +
 *  manual rename instead. Pure (no node deps) so it's unit-testable. */
export function paneLabelArgs(providerId: string): string[] {
  return providerId === 'claude'
    ? ['--append-system-prompt', PANE_LABEL_INSTRUCTION]
    : [];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/shared/providers.test.ts`
Expected: PASS.

- [ ] **Step 5: Call it from `buildArgs`**

In `src/main/core/providers/launcher.ts`, import `paneLabelArgs` (add to the existing
`@/shared/providers` import, or add the import line). Then in `buildArgs`, right
after `out.push(...provider.args);` (line 229):
```ts
  // Pane auto-label — claude-only SIGMA::LABEL instruction (no-op for others).
  out.push(...paneLabelArgs(provider.id));
```

- [ ] **Step 6: Type-check + commit**

Run: `npx tsc -b`
Expected: no errors.
```bash
git add src/shared/providers.ts src/shared/providers.test.ts src/main/core/providers/launcher.ts
git commit -m "feat(providers): inject SIGMA::LABEL instruction into claude pane spawns"
```

---

## Task 4: Clear label + dispose watcher on permanent removal

**Files:**
- Modify: `src/renderer/app/state-hooks/use-terminal-cache-gc.ts` (import line ~21; loop ~line 50)
- Test: `src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `use-terminal-cache-gc.test.ts` (mirror the file's existing render/rerender harness):
```ts
import { setAgentLabel, getAgentLabel, __resetAgentLabels } from '@/renderer/lib/pane-labels';

it('clears the auto-label when a session permanently disappears', () => {
  __resetAgentLabels();
  setAgentLabel('gone-1', 'Reviewing auth');
  const { rerender } = renderHookWithSessions(['gone-1']);  // present — use the file's helper
  expect(getAgentLabel('gone-1')).toBe('Reviewing auth');
  rerender(withSessions([]));                                // vanished
  expect(getAgentLabel('gone-1')).toBeNull();
});
```
(Use the suite's existing AppState-building helper; the behavioral assertion — label present, then null after the session leaves both `sessions` and `sessionsByWorkspace` — is what matters.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts -t "clears the auto-label"`
Expected: FAIL — label still present.

- [ ] **Step 3: Implement**

Add the import (line ~21, beside `disposePromptWatcher`):
```ts
import { disposeLabelWatcher } from '@/renderer/lib/label-watcher';
import { clearAgentLabel } from '@/renderer/lib/pane-labels';
```
In the disappearance loop, next to `disposePromptWatcher(id);` (line 50):
```ts
      disposeLabelWatcher(id);
      clearAgentLabel(id);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/state-hooks/use-terminal-cache-gc.ts src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts
git commit -m "feat(command-room): clear pane label + dispose watcher on session removal"
```

---

## Task 5: PaneHeader — precedence, tooltip, rename prefill + request listener

**Files:**
- Modify: `src/renderer/features/command-room/PaneHeader.tsx` (imports; subscription ~line 144; `startEditing` line 155; `displayLabel` line 176; tooltip `title=` line 258)
- Test: `src/renderer/features/command-room/PaneHeader.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `PaneHeader.test.tsx` (it already mocks `rpc`):
```ts
import { setAgentLabel, __resetAgentLabels } from '@/renderer/lib/pane-labels';
import { act } from '@testing-library/react';

describe('PaneHeader auto-label precedence', () => {
  afterEach(() => __resetAgentLabels());

  it('shows the alias with no manual name, no SIGMA::LABEL, no initialPrompt', () => {
    renderHeader({ session: makeSession({ id: 'p1', name: null, initialPrompt: undefined }) });
    expect(screen.getByTestId('pane-display-name').textContent).toMatch(/·/);
  });

  it('shows the launch-prompt summary when there is no SIGMA::LABEL', () => {
    renderHeader({ session: makeSession({ id: 'p2', name: null, initialPrompt: 'Refactor the auth module' }) });
    expect(screen.getByTestId('pane-display-name').textContent).toContain('Refactor the auth module');
  });

  it('SIGMA::LABEL beats the launch-prompt summary', () => {
    renderHeader({ session: makeSession({ id: 'p3', name: null, initialPrompt: 'Refactor the auth module' }) });
    act(() => setAgentLabel('p3', 'Reviewing PR'));
    const t = screen.getByTestId('pane-display-name').textContent ?? '';
    expect(t).toContain('Reviewing PR');
    expect(t).not.toContain('Refactor the auth module');
  });

  it('manual name beats SIGMA::LABEL', () => {
    renderHeader({ session: makeSession({ id: 'p4', name: 'Reviewer', initialPrompt: 'x' }) });
    act(() => setAgentLabel('p4', 'Reviewing PR'));
    const t = screen.getByTestId('pane-display-name').textContent ?? '';
    expect(t).toContain('Reviewer');
    expect(t).not.toContain('Reviewing PR');
  });

  it('tooltip title carries the full label', () => {
    renderHeader({ session: makeSession({ id: 'p5', name: null }) });
    act(() => setAgentLabel('p5', 'A very long task summary that overflows the narrow pane pill region here'));
    expect(screen.getByTestId('pane-display-name').getAttribute('title')).toContain('A very long task summary');
  });

  it('opens inline edit on a targeted pane-rename-request', () => {
    renderHeader({ session: makeSession({ id: 'p6', name: null }) });
    act(() => window.dispatchEvent(new CustomEvent('sigma:pane-rename-request', { detail: { sessionId: 'p6' } })));
    expect(screen.getByTestId('pane-rename-input')).toBeInTheDocument();
  });
});
```
(Reuse the file's `renderHeader`/`makeSession`; ensure `makeSession` passes `initialPrompt` through to the session object.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/PaneHeader.test.tsx -t "auto-label precedence"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend the `react` import to add the store hooks:
```ts
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
```
Add the store import (near other `@/renderer/lib` imports):
```ts
import { subscribeAgentLabel, getAgentLabel, summarizePrompt } from '@/renderer/lib/pane-labels';
```

Subscribe + the rename-request listener (after the `panes:session-renamed` effect, ~line 144):
```ts
  // Claude auto-label (SIGMA::LABEL). Ephemeral; precedence below.
  const agentLabel = useSyncExternalStore(
    useCallback((cb) => subscribeAgentLabel(session.id, cb), [session.id]),
    useCallback(() => getAgentLabel(session.id), [session.id]),
  );

  // Context-menu "Rename label…" (PaneShell) requests inline edit via a window
  // event — same renderer-internal CustomEvent pattern as sigma:renderer-mode-changed.
  useEffect(() => {
    function onReq(e: Event): void {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      if (detail?.sessionId === session.id) startEditing();
    }
    window.addEventListener('sigma:pane-rename-request', onReq as EventListener);
    return () => window.removeEventListener('sigma:pane-rename-request', onReq as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
```

Add the floor + update `displayLabel` (replace line 176):
```ts
  // Display label: operator name > Claude SIGMA::LABEL > launch-prompt summary > alias.
  const initialLabel = summarizePrompt(session.initialPrompt);
  const displayLabel = localName?.trim() || agentLabel?.trim() || initialLabel || id.alias;
```

Update `startEditing` (line 155) to prefill from the shown label:
```ts
  function startEditing(): void {
    setDraftName(localName ?? agentLabel ?? initialLabel ?? id.alias);
    setEditing(true);
  }
```
(`initialLabel` is defined above `startEditing` already in source order — `startEditing` is a function declaration and is hoisted, but it READS `initialLabel`/`agentLabel` at call time, so placement is fine as long as both consts exist in the component scope. Define `agentLabel` and `initialLabel` before the JSX; they are.)

Update the tooltip `title=` (line 258):
```tsx
                    title={`${displayLabel} · ${id.effortLabel}`}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/features/command-room/PaneHeader.test.tsx`
Expected: PASS (new + existing cases).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/command-room/PaneHeader.tsx src/renderer/features/command-room/PaneHeader.test.tsx
git commit -m "feat(command-room): pane header shows auto-label behind manual name + full tooltip"
```

---

## Task 6: PaneShell — `Rename label…` context-menu item

**Files:**
- Modify: `src/renderer/features/command-room/PaneShell.tsx` (lucide import line 16; context menu near the renderer-toggle item ~line 626-645)
- Test: `src/renderer/features/command-room/PaneShell.test.tsx`

- [ ] **Step 1: Add the icon import**

Append `Pencil` to the lucide-react import (line 16):
```ts
import { ClipboardPaste, Copy, FolderOpen, GitBranch, RotateCw, Square, SquareTerminal, Terminal as TerminalIcon, FolderGit2, LayoutPanelLeft, Pencil } from 'lucide-react';
```

- [ ] **Step 2: Add the menu item**

After the `ctx-renderer-toggle` `ContextMenuItem` (closes ~line 645), before the next `<ContextMenuSeparator />` (~line 646), insert:
```tsx
          {/* Rename the pane label. Targets the MAIN session; PaneHeader listens
              for this event and enters inline edit. Clearing the name reverts to
              the auto-label, then the launch-prompt summary, then the alias. */}
          <ContextMenuItem
            data-testid="ctx-rename-label"
            onSelect={() => {
              window.dispatchEvent(
                new CustomEvent('sigma:pane-rename-request', {
                  detail: { sessionId: session.id },
                }),
              );
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            <span>Rename label…</span>
          </ContextMenuItem>
```

- [ ] **Step 3: Add the test**

Add to `PaneShell.test.tsx` (reuse the file's render helper + Radix interaction pattern):
```ts
it('dispatches sigma:pane-rename-request for this session from the context menu', async () => {
  const onReq = vi.fn();
  window.addEventListener('sigma:pane-rename-request', onReq as EventListener);
  renderPaneShell({ session: makeSession({ id: 'pane-x' }) });
  fireEvent.contextMenu(screen.getByTestId('pane-body'));
  fireEvent.click(await screen.findByTestId('ctx-rename-label'));
  const evt = onReq.mock.calls[0]?.[0] as CustomEvent<{ sessionId: string }>;
  expect(evt?.detail.sessionId).toBe('pane-x');
  window.removeEventListener('sigma:pane-rename-request', onReq as EventListener);
});
```
(If the suite can't drive a Radix context menu open in jsdom, instead render and assert the item's `onSelect` dispatches with the right sessionId — keep the behavioral assertion.)

- [ ] **Step 4: Run + type-check**

Run: `npx vitest run src/renderer/features/command-room/PaneShell.test.tsx && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/command-room/PaneShell.tsx src/renderer/features/command-room/PaneShell.test.tsx
git commit -m "feat(command-room): add Rename label… to the pane context menu"
```

---

## Task 7: Full gate

- [ ] **Step 1: Type-check whole project** — `npx tsc -b` → no errors.
- [ ] **Step 2: Full renderer suite** — `npx vitest run` → all green. If a sibling *mock* broke (e.g. a test instantiating PaneShell now needs the `pty-data-bus`/label-watcher path), fix the mock (per repo memory, mocked-dep member access can break hand-written mocks the scoped tests miss).
- [ ] **Step 3: Lint** — `npm run lint` → clean (the one `exhaustive-deps` disable in Task 5 is the only suppression).
- [ ] **Step 4: Build** — `npm run build` → success.
- [ ] **Step 5: Commit any gate fixups**

```bash
git add -A
git commit -m "chore(command-room): gate fixups for pane auto-labeling"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Precedence manual → SIGMA::LABEL → launch-prompt → alias → Task 5 (`displayLabel`). ✓
- Source 1 (Claude self-emit via injected arg) → Task 3 (`paneLabelArgs`/buildArgs) + Task 2 (label-watcher parse). ✓
- Source 2 (launch-prompt floor, app-side) → Task 5 (`summarizePrompt(session.initialPrompt)`). ✓
- Manual always wins / clear reverts → Task 5 precedence; existing empty→null rename unchanged. ✓
- Renderer-only except one claude arg; no protocol/swarm change → watcher self-parses (Task 2); only `providers.ts`+`launcher.ts` main-side (Task 3). ✓
- `useSyncExternalStore` → Task 5. ✓
- Last-good + sanitize (ANSI/ctrl/cap) → Task 1. ✓
- Dispose watcher + clear label on permanent removal only → Task 4 (GC hook, not on switch/evict). ✓
- Tooltip = full label → Task 5. ✓
- Context-menu `Rename label…`, keep double-click → Task 6 + existing double-click. ✓
- Spike done; tradeoff (visible sentinel) recorded → Task 0. ✓
- All providers display; claude-only injection → Task 3 (`providerId === 'claude'`). ✓

**Placeholder scan:** No TBD/TODO. Test helper names flagged "reuse the file's helper" are pre-existing in those suites; assertions are concrete.

**Type consistency:** `sanitizeLabel`/`summarizePrompt`/`setAgentLabel`/`getAgentLabel`/`subscribeAgentLabel`/`clearAgentLabel`/`__resetAgentLabels` (Task 1) match Tasks 2/4/5. `ensureLabelWatcher`/`disposeLabelWatcher`/`__resetLabelWatchers` (Task 2) match Task 4. `paneLabelArgs`/`PANE_LABEL_INSTRUCTION` (Task 3) match the launcher call. `sigma:pane-rename-request` matches between Task 5 (listener) and Task 6 (dispatch). ✓
