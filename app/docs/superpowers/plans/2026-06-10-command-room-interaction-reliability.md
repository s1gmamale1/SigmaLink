# Command Room Interaction Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four root-caused Command Room bugs: Jorvis `launch_pane` panes never render (missing echo), terminal copy/paste missing (Radix menu intercepts right-click), screenshot drop/paste never reaches the agent as an image, and `+ Pane` dead after restart (no swarm-resume escape hatch).

**Architecture:** Four independent surgical fixes per the approved spec `docs/superpowers/specs/2026-06-10-command-room-interaction-reliability-design.md`. A: thread `emit` into `ToolContext` and echo `assistant:dispatch-echo` from `launch_pane`. C: `getCached` accessor + `copyOnSelect` + two Radix menu items. B: stage image bytes to a temp file via a new `panes.stageImage` RPC and inject the absolute `@path` (clipboard-write is upstream-broken for Claude Code — never use it). D: new `swarms.resume` RPC + auto-resume inside `addPane()`.

**Tech Stack:** TypeScript, Electron (main + renderer), React 19, xterm.js 6, Radix UI, vitest (jsdom for renderer; db-fake raw shim for DB — NEVER `new Database()`, better-sqlite3 is Electron-ABI).

**Branch:** create `fix/command-room-interaction-reliability` off `origin/main`, push after the first commit (concurrent-tree-stomp protection — this repo has multiple live sessions).

**Order:** Task 1 (A, high sev) → Tasks 2 (C) → Tasks 3-6 (B) → Task 7 (D) → Task 8 (gate + PR). C lands before B because both edit `PaneShell.tsx`.

---

### Task 0: Branch setup

- [ ] **Step 0.1: Create the branch off origin/main**

```bash
cd /Users/aisigma/projects/SigmaLink && git fetch origin --quiet
git switch -c fix/command-room-interaction-reliability origin/main
```

Expected: `Switched to a new branch 'fix/command-room-interaction-reliability'`.

---

### Task 1: A — `launch_pane` emits `assistant:dispatch-echo` 🐞[high]

**Files:**
- Modify: `app/src/main/core/assistant/tools.ts` (ToolContext interface ~`:39-93`; `launch_pane` handler ~`:269-301`)
- Modify: `app/src/main/core/assistant/controller.ts` (ctx construction inside `invokeAssistantTool`, ~`:218-235`)
- Test: `app/src/main/core/assistant/tools.test.ts`

Background: the Command Room only adds spawned panes when `assistant:dispatch-echo` arrives (`use-jorvis-dispatch-echo.ts:35` refetches + `ADD_SESSIONS`). `dispatchPane` emits it (`controller.ts:466`); the bare `launch_pane` tool emits nothing → panes invisible.

- [ ] **Step 1.1: Write the failing test**

In `app/src/main/core/assistant/tools.test.ts`, add a module mock for the launcher near the existing `vi.mock` calls at the top (BEFORE the `import { findTool }` line — vitest hoists, but keep it adjacent to the other mocks for readability):

```typescript
// Spec 2026-06-10 (A) — mock executeLaunchPlan so launch_pane tests control
// the spawned-session shapes without real PTYs/worktrees.
vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: vi.fn(),
}));
```

Add the import alongside the other imports:

```typescript
import { executeLaunchPlan } from '../workspaces/launcher';
```

Add the test suite at the end of the file:

```typescript
describe('assistant launch_pane echo (spec 2026-06-10 A)', () => {
  it('emits assistant:dispatch-echo once per spawned session', async () => {
    vi.mocked(executeLaunchPlan).mockResolvedValue({
      sessions: [
        { id: 'sess-a', providerId: 'codex', status: 'running', error: null },
        { id: 'sess-b', providerId: 'codex', status: 'error', error: 'spawn failed' },
      ],
    } as unknown as Awaited<ReturnType<typeof executeLaunchPlan>>);
    const emit = vi.fn();
    const ctx = { ...makeCtx([], 'ws-1'), emit } as unknown as ToolContext;

    await findTool('launch_pane')!.handler(
      { workspaceRoot: '/tmp/ws-1', provider: 'codex', count: 2 },
      ctx,
    );

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, 'assistant:dispatch-echo', {
      workspaceId: 'ws-1',
      sessionId: 'sess-a',
      providerId: 'codex',
      ok: true,
      error: null,
      conversationId: null,
    });
    expect(emit).toHaveBeenNthCalledWith(2, 'assistant:dispatch-echo', {
      workspaceId: 'ws-1',
      sessionId: 'sess-b',
      providerId: 'codex',
      ok: false,
      error: 'spawn failed',
      conversationId: null,
    });
  });

  it('does not throw when ctx.emit is absent (back-compat)', async () => {
    vi.mocked(executeLaunchPlan).mockResolvedValue({
      sessions: [{ id: 'sess-a', providerId: 'codex', status: 'running', error: null }],
    } as unknown as Awaited<ReturnType<typeof executeLaunchPlan>>);

    const out = await findTool('launch_pane')!.handler(
      { workspaceRoot: '/tmp/ws-1', provider: 'codex' },
      makeCtx([], 'ws-1'),
    );
    expect(out).toMatchObject({ sessionIds: ['sess-a'] });
  });
});
```

NOTE: `makeCtx` exists at the top of the file (`tools.test.ts:41`); its second arg is `defaultWorkspaceId`. The existing `launch_pane`-adjacent tests (`list_*`, `add_agent`) do NOT call `executeLaunchPlan`, so the new module mock must not break them — `add_agent` uses `addAgentToSwarm` from `../swarms/factory`, untouched. If any existing test in this file DOES exercise the real launcher, run the file first to see, and scope the mock accordingly.

- [ ] **Step 1.2: Run the test to verify it fails**

```bash
cd /Users/aisigma/projects/SigmaLink/app && npx vitest run src/main/core/assistant/tools.test.ts -t "launch_pane echo"
```

Expected: FAIL — `emit` called 0 times.

- [ ] **Step 1.3: Add `emit` to `ToolContext`**

In `app/src/main/core/assistant/tools.ts`, inside `export interface ToolContext { … }` (after the `userDataDir: string;` field):

```typescript
  /**
   * Spec 2026-06-10 (A) — renderer event broadcaster (the controller's
   * `deps.emit`). Lets tool handlers that spawn panes echo
   * `assistant:dispatch-echo` so the Command Room grid refetches and shows
   * them (the bare launch_pane tool previously emitted nothing → panes
   * spawned but never rendered). Optional: absent in tests/legacy callers
   * ⇒ no echo, no throw (back-compat).
   */
  emit?: (event: string, payload: unknown) => void;
```

- [ ] **Step 1.4: Emit from the `launch_pane` handler**

In `app/src/main/core/assistant/tools.ts`, in the `launch_pane` handler, replace the final two statements:

```typescript
      const out = await executeLaunchPlan(plan, {
        pty: ctx.pty,
        worktreePool: ctx.worktreePool,
      });
      return { sessionIds: out.sessions.map((s) => s.id), sessions: out.sessions };
```

with:

```typescript
      const out = await executeLaunchPlan(plan, {
        pty: ctx.pty,
        worktreePool: ctx.worktreePool,
      });
      // Spec 2026-06-10 (A) — echo each spawned session so the Command Room
      // grid refetches (use-jorvis-dispatch-echo) and renders the new panes.
      // Sibling of dispatchPane's loop (controller.ts) — same payload shape.
      // workspaceId: the conversation's workspace (same source requireWs uses).
      const workspaceId = ctx.defaultWorkspaceId;
      if (ctx.emit && workspaceId) {
        for (const session of out.sessions) {
          try {
            ctx.emit('assistant:dispatch-echo', {
              workspaceId,
              sessionId: session.id,
              providerId: session.providerId,
              ok: session.status !== 'error',
              error: session.error ?? null,
              conversationId: null,
            });
          } catch {
            /* best-effort — an echo failure must not fail the launch */
          }
        }
      }
      return { sessionIds: out.sessions.map((s) => s.id), sessions: out.sessions };
```

- [ ] **Step 1.5: Pass `emit` where the ctx is built**

In `app/src/main/core/assistant/controller.ts`, inside `invokeAssistantTool`'s `tool.handler(parsed, { … })` object literal (the block at ~`:218-235` that already passes `pty: deps.pty, … userDataDir: deps.userDataDir,`), add one line after `userDataDir: deps.userDataDir,`:

```typescript
        // Spec 2026-06-10 (A) — let pane-spawning tools echo dispatch-echo.
        emit: deps.emit,
```

- [ ] **Step 1.6: Run the tests to verify they pass**

```bash
cd /Users/aisigma/projects/SigmaLink/app && npx vitest run src/main/core/assistant/tools.test.ts
```

Expected: ALL tests in the file PASS (the new 2 + all pre-existing).

- [ ] **Step 1.7: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink
git add app/src/main/core/assistant/tools.ts app/src/main/core/assistant/tools.test.ts app/src/main/core/assistant/controller.ts
git commit -m "fix(jorvis): launch_pane echoes dispatch-echo so spawned panes render

The bare launch_pane tool spawned PTY+DB rows but emitted no event; the
Command Room only adds panes on assistant:dispatch-echo (the
dispatchPane/dispatchBulk twins DID emit). Thread emit into ToolContext
and echo per spawned session.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push -u origin fix/command-room-interaction-reliability
```

---

### Task 2: C — right-click Copy/Paste + copy-on-select

**Files:**
- Modify: `app/src/renderer/lib/terminal-cache.ts` (`buildTerminalOptions` ~`:175-196`; new export near `hasCached` ~`:439`)
- Modify: `app/src/renderer/features/command-room/PaneShell.tsx` (lucide import `:16`; `ContextMenuContent` `:534`)
- Test: `app/src/renderer/lib/workspace... ` no — `app/src/renderer/features/command-room/PaneShell.test.tsx` (exists) and `app/src/renderer/lib/terminal-cache.test.ts` if present (check; otherwise assert via PaneShell test only)

- [ ] **Step 2.1: Add `getCached` + `copyOnSelect` to terminal-cache**

In `app/src/renderer/lib/terminal-cache.ts`:

(a) Change `interface CacheEntry {` to `export interface CacheEntry {` (the interface ending just above `const cache = new Map<string, CacheEntry>();` at `:129`).

(b) In `buildTerminalOptions` (`:175`), after the `cursorStyle: 'bar',` line add:

```typescript
    // Spec 2026-06-10 (C) — iTerm2-style select-to-copy (operator choice).
    // The right-click Copy menu item in PaneShell complements this for
    // discoverability; both read the same xterm selection.
    copyOnSelect: true,
```

(c) Directly below the existing `hasCached` export (`:439-441`), add:

```typescript
/** Spec 2026-06-10 (C) — read-only accessor for a cached entry (no create).
 *  Used by PaneShell's context-menu Copy/Paste to reach the live xterm
 *  instance for a pane/scratch-tab without constructing a cache context. */
export function getCached(sessionId: string): CacheEntry | undefined {
  return cache.get(sessionId);
}
```

- [ ] **Step 2.2: Write the failing PaneShell menu test**

Open `app/src/renderer/features/command-room/PaneShell.test.tsx` and read its existing render/mocking scaffolding FIRST (it already mounts PaneShell with mocked rpc/session — reuse its `makeSession`/render helpers verbatim; do not invent a parallel harness). Add a suite (adapting helper names to what the file actually uses):

```typescript
describe('pane context-menu Copy/Paste (spec 2026-06-10 C)', () => {
  it('Copy writes the xterm selection to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, readText: vi.fn().mockResolvedValue('') },
      configurable: true,
    });
    // Stub the cached terminal for the session id used by the test render.
    const term = { hasSelection: () => true, getSelection: () => 'picked text' };
    vi.spyOn(terminalCache, 'getCached').mockReturnValue({
      terminal: term,
    } as unknown as ReturnType<typeof terminalCache.getCached>);

    // …render PaneShell with the file's existing helper, open the context
    // menu (fireEvent.contextMenu on the pane body), click the Copy item:
    // fireEvent.contextMenu(screen.getByTestId('pane-body'));
    // (Radix renders the menu in a portal) —
    // await user.click(await screen.findByTestId('ctx-copy'));

    expect(writeText).toHaveBeenCalledWith('picked text');
  });

  it('Paste writes clipboard text to the pane PTY', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(), readText: vi.fn().mockResolvedValue('pasted!') },
      configurable: true,
    });
    // …open menu, click ctx-paste…
    // expect(mockRpc.pty.write).toHaveBeenCalledWith(<sessionId>, 'pasted!');
  });
});
```

NOTE for the implementer: the commented lines are where you wire into the file's EXISTING render harness and rpc mock — fill them with the file's real helper calls (this is mandatory; the assertions above are the contract). Import the module namespace for spying: `import * as terminalCache from '@/renderer/lib/terminal-cache';`.

- [ ] **Step 2.3: Run to verify it fails**

```bash
cd /Users/aisigma/projects/SigmaLink/app && npx vitest run src/renderer/features/command-room/PaneShell.test.tsx -t "Copy/Paste"
```

Expected: FAIL — `ctx-copy` testid not found.

- [ ] **Step 2.4: Add the menu items**

In `app/src/renderer/features/command-room/PaneShell.tsx`:

(a) Extend the lucide import at `:16` with `Copy` and `ClipboardPaste`:

```typescript
import { FolderOpen, GitBranch, RotateCw, Square, Terminal as TerminalIcon, FolderGit2, LayoutPanelLeft, Copy, ClipboardPaste } from 'lucide-react';
```

(b) Add the terminal-cache import next to the other `@/renderer/lib` imports:

```typescript
import { getCached } from '@/renderer/lib/terminal-cache';
```

(c) At the TOP of `<ContextMenuContent>` (immediately after the opening tag at `:534`, BEFORE the "Reveal worktree" item), insert:

```tsx
          {/* Spec 2026-06-10 (C) — terminal Copy/Paste. The Radix trigger
              intercepts right-click (xterm's native copy never fires), so the
              menu must own clipboard access. Keyed on activeTabId so scratch
              tabs work. */}
          <ContextMenuItem
            data-testid="ctx-copy"
            disabled={!getCached(activeTabId)?.terminal.hasSelection()}
            onSelect={() => {
              const sel = getCached(activeTabId)?.terminal.getSelection();
              if (sel) void navigator.clipboard.writeText(sel).catch(() => undefined);
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Copy</span>
          </ContextMenuItem>
          <ContextMenuItem
            data-testid="ctx-paste"
            disabled={exited || errored}
            onSelect={() => {
              void navigator.clipboard
                .readText()
                .then((text) => {
                  if (text) void rpc.pty.write(activeTabId, text);
                })
                .catch(() => undefined);
            }}
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>Paste</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
```

(`exited` / `errored` already exist in component scope — the Stop item uses them.)

- [ ] **Step 2.5: Run the tests to verify they pass**

```bash
cd /Users/aisigma/projects/SigmaLink/app && npx vitest run src/renderer/features/command-room/PaneShell.test.tsx
```

Expected: PASS (new + all pre-existing — the pre-existing menu-item tests must still pass; the new items are ABOVE the old ones, which can shift index-based queries — fix any test that selected items by position to use text/testid).

- [ ] **Step 2.6: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink
git add app/src/renderer/lib/terminal-cache.ts app/src/renderer/features/command-room/PaneShell.tsx app/src/renderer/features/command-room/PaneShell.test.tsx
git commit -m "feat(command-room): right-click Copy/Paste in panes + copy-on-select

Radix ContextMenu intercepts right-click (xterm native copy never fires)
and never offered Copy/Paste. Add both items (Copy gated on
hasSelection, Paste -> rpc.pty.write) via a new getCached terminal-cache
accessor, plus copyOnSelect:true.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

---

### Task 3: B1 — `IMAGE_CAPABLE_PROVIDERS` shared capability set

**Files:**
- Modify: `app/src/shared/providers.ts`
- Test: `app/src/shared/providers.test.ts`

- [ ] **Step 3.1: Write the failing test** — append to `app/src/shared/providers.test.ts`:

```typescript
describe('IMAGE_CAPABLE_PROVIDERS (spec 2026-06-10 B)', () => {
  it('claude and codex are image-capable; shell and unknown are not', async () => {
    const { isImageCapableProvider } = await import('./providers');
    expect(isImageCapableProvider('claude')).toBe(true);
    expect(isImageCapableProvider('codex')).toBe(true);
    expect(isImageCapableProvider('shell')).toBe(false);
    expect(isImageCapableProvider('gemini')).toBe(false); // unverified upstream — OFF until proven
    expect(isImageCapableProvider('')).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run to verify it fails**

```bash
cd /Users/aisigma/projects/SigmaLink/app && npx vitest run src/shared/providers.test.ts -t IMAGE_CAPABLE
```

Expected: FAIL — `isImageCapableProvider` is not a function.

- [ ] **Step 3.3: Implement** — append to `app/src/shared/providers.ts`:

```typescript
/**
 * Spec 2026-06-10 (B) — providers whose CLIs ingest an image FILE PATH from
 * the prompt (Claude Code detects image paths; Codex accepts paths / -i).
 * Drives the pane drop/paste image-staging interceptor. Gemini stays OFF
 * until its PTY image-path support is verified. Precedent:
 * SLASH_CAPABLE_PROVIDERS (renderer insertSkillCommand.ts).
 */
export const IMAGE_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex']);

export function isImageCapableProvider(providerId: string): boolean {
  return IMAGE_CAPABLE_PROVIDERS.has(providerId);
}
```

- [ ] **Step 3.4: Run to verify pass** — same command, expected PASS.

- [ ] **Step 3.5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink
git add app/src/shared/providers.ts app/src/shared/providers.test.ts
git commit -m "feat(providers): IMAGE_CAPABLE_PROVIDERS capability set (claude, codex)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: B2 — `panes.stageImage` RPC (testable helper + channel triple)

**Files:**
- Create: `app/src/main/core/workspaces/stage-image.ts`
- Test: `app/src/main/core/workspaces/stage-image.test.ts`
- Modify: `app/src/shared/rpc-channels.ts` (add `'panes.stageImage'` after `'panes.rename'` at `:64`)
- Modify: `app/src/shared/router-shape.ts` (panes block, `:193+`)
- Modify: `app/src/main/rpc-router.ts` (panes controller, after the `rename` handler ~`:1292`)

⚠️ Channel additions touch the **known triple** — `rpc-channels.ts` + `router-shape.ts` + `rpc-router.ts` must ALL change or preload blocks the call. There is also `rpc-channels.test.ts` — run it; if it asserts an exact channel list, add the new channel there too.

- [ ] **Step 4.1: Write the failing helper test** — create `app/src/main/core/workspaces/stage-image.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageImage } from './stage-image';

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-image-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('stageImage (spec 2026-06-10 B)', () => {
  it('writes the decoded bytes under <baseDir>/staged-images and returns the abs path', () => {
    const { absPath } = stageImage({ bytesBase64: PNG_B64, ext: 'png' }, { baseDir: dir });
    expect(absPath.startsWith(path.join(dir, 'staged-images'))).toBe(true);
    expect(absPath.endsWith('.png')).toBe(true);
    expect(fs.readFileSync(absPath).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });

  it('rejects a non-allowlisted extension', () => {
    expect(() => stageImage({ bytesBase64: PNG_B64, ext: 'svg' }, { baseDir: dir })).toThrow(
      /unsupported extension/,
    );
    expect(() => stageImage({ bytesBase64: PNG_B64, ext: '../../evil' }, { baseDir: dir })).toThrow(
      /unsupported extension/,
    );
  });

  it('rejects an empty payload', () => {
    expect(() => stageImage({ bytesBase64: '', ext: 'png' }, { baseDir: dir })).toThrow(/empty payload/);
  });

  it('rejects an image over the 20MB cap', () => {
    const big = Buffer.alloc(21 * 1024 * 1024).toString('base64');
    expect(() => stageImage({ bytesBase64: big, ext: 'png' }, { baseDir: dir })).toThrow(/20MB cap/);
  });
});
```

- [ ] **Step 4.2: Run to verify it fails**

```bash
cd /Users/aisigma/projects/SigmaLink/app && npx vitest run src/main/core/workspaces/stage-image.test.ts
```

Expected: FAIL — cannot resolve `./stage-image`.

- [ ] **Step 4.3: Implement the helper** — create `app/src/main/core/workspaces/stage-image.ts`:

```typescript
// Spec 2026-06-10 (B) — stage a dropped/pasted image to a temp file so a pane
// can inject an absolute @path that image-capable CLIs (claude/codex) read
// from the prompt. The clipboard-write alternative is upstream-broken for
// Claude Code (it reads legacy «class PNGf»; Electron writes public.png —
// anthropics/claude-code#30936), so the FILE PATH is the only path that works
// for both CLIs today. Boundary validation lives HERE (renderer input is
// untrusted): extension allowlist + size cap; the filename is fully
// server-generated so no path traversal is possible.
//
// Extracted as a pure DI-style helper (baseDir injected) because rpc-router
// itself cannot be loaded under vitest (Electron imports).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

export function stageImage(
  input: { bytesBase64: string; ext: string },
  opts: { baseDir: string },
): { absPath: string } {
  const cleanExt = String(input.ext ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!ALLOWED_EXTENSIONS.has(cleanExt)) {
    throw new Error(`stageImage: unsupported extension "${input.ext}"`);
  }
  if (typeof input.bytesBase64 !== 'string' || input.bytesBase64.length === 0) {
    throw new Error('stageImage: empty payload');
  }
  const buf = Buffer.from(input.bytesBase64, 'base64');
  if (buf.byteLength === 0) throw new Error('stageImage: empty payload');
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error('stageImage: image exceeds 20MB cap');
  const dir = path.join(opts.baseDir, 'staged-images');
  fs.mkdirSync(dir, { recursive: true });
  const absPath = path.join(dir, `sigmalink-img-${Date.now()}-${randomUUID().slice(0, 8)}.${cleanExt}`);
  fs.writeFileSync(absPath, buf);
  return { absPath };
}
```

- [ ] **Step 4.4: Run to verify pass** — same command, expected: 4 PASS.

- [ ] **Step 4.5: Wire the channel triple**

(a) `app/src/shared/rpc-channels.ts` — after the `'panes.rename',` line (`:64`):

```typescript
  // Spec 2026-06-10 (B) — image staging for pane drop/paste.
  'panes.stageImage',
```

(b) `app/src/shared/router-shape.ts` — in the `panes:` block (after the `rename` signature, ~`:274+`):

```typescript
    /**
     * Spec 2026-06-10 (B) — stage a dropped/pasted image under
     * `<userData>/staged-images/` and return its absolute path, so the pane
     * injects `@<absPath>` for image-capable CLIs. ext ∈ png|jpg|jpeg|gif|webp,
     * payload ≤ 20MB; throws on violation.
     */
    stageImage: (input: { bytesBase64: string; ext: string }) => Promise<{ absPath: string }>;
```

(c) `app/src/main/rpc-router.ts` — in the panes controller object, directly after the `rename` handler's closing `},` (~`:1292`):

```typescript
    // Spec 2026-06-10 (B) — stage a dropped/pasted image (see
    // core/workspaces/stage-image.ts for validation + rationale).
    stageImage: async (input: { bytesBase64: string; ext: string }): Promise<{ absPath: string }> => {
      return stageImageFile(input, { baseDir: app.getPath('userData') });
    },
```

and add the import near the other `./core/workspaces/*` imports at the top:

```typescript
import { stageImage as stageImageFile } from './core/workspaces/stage-image';
```

(`app` is already imported in rpc-router — it uses `app.getAppPath()` at `:700`.)

- [ ] **Step 4.6: Gate the triple**

```bash
cd /Users/aisigma/projects/SigmaLink/app && npx tsc -b && npx vitest run src/shared/rpc-channels.test.ts src/main/core/workspaces/stage-image.test.ts
```

Expected: tsc clean; tests PASS. If `rpc-channels.test.ts` fails on a channel-list assertion, add `'panes.stageImage'` to its expected list.

- [ ] **Step 4.7: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink
git add app/src/main/core/workspaces/stage-image.ts app/src/main/core/workspaces/stage-image.test.ts app/src/shared/rpc-channels.ts app/src/shared/router-shape.ts app/src/main/rpc-router.ts
git add app/src/shared/rpc-channels.test.ts 2>/dev/null || true
git commit -m "feat(panes): panes.stageImage RPC — stage dropped/pasted images to temp files

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

---

### Task 5: B3 — image-aware drop in `handleDrop`

**Files:**
- Modify: `app/src/renderer/features/command-room/PaneShell.tsx` (`handleDrop` Finder fallback `:303-321`; component scope for the shared stager)
- Test: `app/src/renderer/features/command-room/PaneShell.test.tsx`

- [ ] **Step 5.1: Write the failing tests** — add to `PaneShell.test.tsx` (reusing the file's existing render harness + rpc mock; the rpc mock must now also stub `panes.stageImage`):

```typescript
describe('image drop staging (spec 2026-06-10 B)', () => {
  // Helper: a DataTransfer-shaped stub for a Finder drop with given files.
  function makeDropEvent(files: File[]): Partial<DragEvent> {
    return {
      dataTransfer: {
        types: ['Files'],
        files: files as unknown as FileList,
        getData: () => '',
      } as unknown as DataTransfer,
      preventDefault: () => undefined,
    };
  }

  it('stages an image file on a claude pane and injects the ABSOLUTE @path', async () => {
    // render PaneShell with providerId 'claude', status 'running'
    // mockRpc.panes.stageImage.mockResolvedValue({ absPath: '/tmp/staged/img.png' });
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    // fireEvent.drop(screen.getByTestId('pane-body'), makeDropEvent([file]));
    // await waitFor(() =>
    //   expect(mockRpc.panes.stageImage).toHaveBeenCalledWith(
    //     expect.objectContaining({ ext: 'png' }),
    //   ));
    // insertMention writes '@<path> ' via rpc.pty.write:
    // await waitFor(() =>
    //   expect(mockRpc.pty.write).toHaveBeenCalledWith(expect.any(String),
    //     expect.stringContaining('/tmp/staged/img.png')));
  });

  it('keeps the relative path-mention for an image on a NON-image provider (shell)', async () => {
    // render with providerId 'shell'; drop the same image file;
    // expect stageImage NOT called and the existing getPathForFile→relative
    // mention path taken (mock window.sigma.getPathForFile as the file does today).
  });

  it('keeps the relative path-mention for a non-image file on claude', async () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    // drop on claude pane → stageImage NOT called.
  });
});
```

(The commented lines wire into the existing harness — fill with the file's real helpers; the assertions are the contract.)

- [ ] **Step 5.2: Run to verify failure**

```bash
cd /Users/aisigma/projects/SigmaLink/app && npx vitest run src/renderer/features/command-room/PaneShell.test.tsx -t "image drop"
```

Expected: FAIL — `stageImage` never called.

- [ ] **Step 5.3: Implement the stager + drop branch**

In `app/src/renderer/features/command-room/PaneShell.tsx`:

(a) Imports — add to the existing blocks:

```typescript
import { isImageCapableProvider } from '@/shared/providers';
```

(b) Component scope (near the other `useCallback`s, after `spawnScratch`): add the shared stager + the base64 helper at MODULE scope (bottom of file, near other helpers):

```typescript
// Spec 2026-06-10 (B) — renderer-side ArrayBuffer→base64 (no Buffer in the
// renderer). Chunked to stay under the argument-count limit of fromCharCode.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
```

and inside the component:

```typescript
  // Spec 2026-06-10 (B) — stage image bytes via panes.stageImage and inject
  // the ABSOLUTE @path (insertMention prefixes '@'). Shared by the drop
  // branch and the paste interceptor. Absolute (not workspace-relative)
  // because screenshots live outside the workspace (/var/folders/…) and the
  // CLI must be able to open the file from the prompt path alone.
  const stageAndInsertImages = useCallback(
    async (files: File[]): Promise<void> => {
      for (const file of files) {
        try {
          const buf = await file.arrayBuffer();
          const ext = (file.type.split('/')[1] ?? 'png').toLowerCase();
          const { absPath } = await rpc.panes.stageImage({
            bytesBase64: arrayBufferToBase64(buf),
            ext,
          });
          await insertMention(session.id, absPath, session.status);
          toast.success('Screenshot staged for the agent', { description: absPath });
        } catch (err) {
          toast.error('Could not stage image', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    [session.id, session.status],
  );
```

(c) In `handleDrop`'s Finder fallback (`:303-321`), replace:

```typescript
    const capped = files.slice(0, MAX_DROP_FILES);
    const paths: string[] = [];
    for (const file of capped) {
```

with:

```typescript
    const capped = files.slice(0, MAX_DROP_FILES);
    // Spec 2026-06-10 (B) — image files on an image-capable pane are staged
    // (bytes → temp file → absolute @path) so the CLI can READ the image;
    // previously they degraded to a fragile relative path-mention and the
    // bytes were never read. Everything else keeps the mention behaviour.
    const imageFiles = isImageCapableProvider(session.providerId)
      ? capped.filter((f) => f.type.startsWith('image/'))
      : [];
    if (imageFiles.length > 0) void stageAndInsertImages(imageFiles);
    const pathFiles = capped.filter((f) => !imageFiles.includes(f));
    const paths: string[] = [];
    for (const file of pathFiles) {
```

(the rest of the loop and the `insertMention` tail are unchanged; the existing `if (paths.length === 0) return;` now simply skips the mention when ALL dropped files were staged images).

- [ ] **Step 5.4: Run to verify pass**

```bash
cd /Users/aisigma/projects/SigmaLink/app && npx vitest run src/renderer/features/command-room/PaneShell.test.tsx
```

Expected: PASS (new + pre-existing, incl. the Task 2 menu tests).

- [ ] **Step 5.5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink
git add app/src/renderer/features/command-room/PaneShell.tsx app/src/renderer/features/command-room/PaneShell.test.tsx
git commit -m "feat(command-room): stage dropped screenshots as absolute @path for image-capable panes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: B4 — image paste interception

**Files:**
- Modify: `app/src/renderer/features/command-room/PaneShell.tsx` (new effect next to the Cmd+T handler `:192-217`)
- Test: `app/src/renderer/features/command-room/PaneShell.test.tsx`

- [ ] **Step 6.1: Write the failing test**

```typescript
describe('image paste interception (spec 2026-06-10 B)', () => {
  it('stages a pasted image on a running claude pane (and blocks xterm)', async () => {
    // render claude pane (running); mockRpc.panes.stageImage resolves.
    const file = new File([new Uint8Array([9])], 'clip.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      },
    });
    Object.defineProperty(event, 'target', { value: /* a node INSIDE pane-body */ undefined });
    // dispatch on a child of pane-body:
    // screen.getByTestId('pane-body').dispatchEvent(event);
    // await waitFor(() => expect(mockRpc.panes.stageImage).toHaveBeenCalled());
  });

  it('ignores a text-only paste (xterm keeps handling it)', async () => {
    // same but items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }]
    // expect stageImage NOT called and preventDefault NOT invoked.
  });
});
```

(Wire the commented lines into the existing harness; dispatch the event from a node inside `pane-body` so the containment check passes.)

- [ ] **Step 6.2: Run to verify failure** — expected FAIL (no paste listener yet).

- [ ] **Step 6.3: Implement the listener** — in `PaneShell.tsx`, directly after the Cmd+T `useEffect` (`:192-217`):

```typescript
  // Spec 2026-06-10 (B) — intercept image PASTE before xterm. xterm's paste
  // handler reads only text/plain, so an image clipboard (macOS screenshot)
  // produced "" and was silently swallowed (terminal-cache onData early-
  // returns on ''). Capture phase on window + containment check, mirroring
  // the Cmd+T handler above. Text pastes fall through untouched.
  useEffect(() => {
    const container = paneContainerRef.current;
    if (!container) return;

    function handlePaste(e: ClipboardEvent): void {
      if (!container!.contains(e.target as Node)) return;
      if (!isImageCapableProvider(session.providerId)) return;
      if (session.status !== 'running') return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
      if (!imageItem) return; // text paste — xterm handles it
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void stageAndInsertImages([file]);
    }

    window.addEventListener('paste', handlePaste, true);
    return () => window.removeEventListener('paste', handlePaste, true);
  }, [session.providerId, session.status, stageAndInsertImages]);
```

- [ ] **Step 6.4: Run to verify pass** — full `PaneShell.test.tsx`, expected PASS.

- [ ] **Step 6.5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink
git add app/src/renderer/features/command-room/PaneShell.tsx app/src/renderer/features/command-room/PaneShell.test.tsx
git commit -m "feat(command-room): intercept image paste — stage + inject @path instead of silent swallow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

---

### Task 7: D — `swarms.resume` + auto-resume on `+ Pane`

**Files:**
- Modify: `app/src/main/core/swarms/controller.ts` (after the `kill` handler `:184-186`)
- Modify: `app/src/shared/router-shape.ts` (swarms block `:400-431`, after `kill`)
- Modify: `app/src/shared/rpc-channels.ts` (after `'swarms.kill'`)
- Modify: `app/src/renderer/features/command-room/AddPaneButton.tsx` (`getAddPaneDisabledReason` `:74-76`; `addPane` swarm-target branch `:222-227`)
- Test: `app/src/main/core/swarms/controller.test.ts` (check it exists — if the controller has no test file, create one using `@/test-utils/db-fake` exactly like `tools.test.ts` does) + `app/src/renderer/features/command-room/AddPaneButton.test.tsx` (same: reuse existing harness if present)

- [ ] **Step 7.1: Write the failing controller test** (in the swarms controller test file; mirror `tools.test.ts`'s `vi.mock('../db/client', …)` + `createDbFake` setup):

```typescript
describe('swarms.resume (spec 2026-06-10 D)', () => {
  it("heals a 'failed' swarm to running and reports healed=true", async () => {
    seedSwarm(fake, { id: 'swarm-1', workspaceId: 'ws-1', name: 'S', mission: 'm', preset: 'custom', status: 'failed', createdAt: 1 });
    const out = await ctl.resume('swarm-1');
    expect(out).toEqual({ ok: true, healed: true });
    const row = (fake.store.tables.get('swarms') ?? []).find((r) => r.id === 'swarm-1');
    expect(row).toMatchObject({ status: 'running' });
  });

  it("leaves a 'completed' swarm ended (healed=false)", async () => {
    seedSwarm(fake, { id: 'swarm-2', workspaceId: 'ws-1', name: 'S', mission: 'm', preset: 'custom', status: 'completed', createdAt: 1 });
    const out = await ctl.resume('swarm-2');
    expect(out).toEqual({ ok: true, healed: false });
  });

  it('rejects a blank id', async () => {
    expect(await ctl.resume('')).toEqual({ ok: false, healed: false });
  });
});
```

(`ctl` = the `buildSwarmController(...)` instance from the file's setup; if creating the test file fresh, construct it with stub deps the same way existing swarm tests do — grep `buildSwarmController` in tests for the pattern.)

- [ ] **Step 7.2: Run to verify failure** — `ctl.resume is not a function`.

- [ ] **Step 7.3: Implement the RPC**

(a) `app/src/main/core/swarms/controller.ts` — after the `kill` handler (`:184-186`):

```typescript
    // Spec 2026-06-10 (D) — escape hatch for swarms the boot janitor left
    // non-running when the resume-path heal (unfailZombieSwarms,
    // resume-launcher.ts) didn't fire (0 panes spawned) or the renderer holds
    // a stale status. Heals failed|paused ONLY — 'completed' is a deliberate
    // end state and stays ended (same policy as unfailZombieSwarms).
    resume: async (id: string): Promise<{ ok: boolean; healed: boolean }> => {
      if (typeof id !== 'string' || !id.trim()) return { ok: false, healed: false };
      try {
        const res = getRawDb()
          .prepare(
            "UPDATE swarms SET status = 'running', ended_at = NULL WHERE id = ? AND status IN ('failed','paused')",
          )
          .run(id);
        return { ok: true, healed: Number(res.changes ?? 0) > 0 };
      } catch {
        return { ok: false, healed: false };
      }
    },
```

If `getRawDb` is not yet imported in controller.ts, add it to the existing `../db/client` import.

(b) `app/src/shared/router-shape.ts` — in the swarms block after `kill: (id: string) => Promise<void>;`:

```typescript
    /**
     * Spec 2026-06-10 (D) — heal a janitor-'failed' (or legacy 'paused')
     * swarm back to running. 'completed' stays ended. Called by + Pane's
     * auto-resume; healed=false means nothing needed healing.
     */
    resume: (id: string) => Promise<{ ok: boolean; healed: boolean }>;
```

(c) `app/src/shared/rpc-channels.ts` — after `'swarms.kill',`:

```typescript
  // Spec 2026-06-10 (D) — + Pane auto-resume escape hatch.
  'swarms.resume',
```

- [ ] **Step 7.4: Run controller tests to verify pass** — expected PASS.

- [ ] **Step 7.5: Wire auto-resume into `AddPaneButton`**

In `app/src/renderer/features/command-room/AddPaneButton.tsx`:

(a) Relax the gate (`:74-76`) — replace:

```typescript
  if (activeSwarm.status !== 'running') {
    return 'Swarm is paused — resume it to add panes';
  }
```

with:

```typescript
  if (activeSwarm.status === 'completed') {
    // Deliberate end state — stay gated (start a new swarm instead).
    return 'Swarm has ended — start a new swarm to add panes';
  }
  // Spec 2026-06-10 (D): other non-running states (janitor 'failed', legacy
  // 'paused') no longer gate the button — addPane() auto-resumes on click.
```

(b) In `addPane()`'s target-swarm branch (`:222-227`) — replace:

```typescript
      } else if (activeSwarm) {
        targetSwarmId = activeSwarm.id;
      } else {
```

with:

```typescript
      } else if (activeSwarm) {
        // Spec 2026-06-10 (D) — auto-resume a non-running swarm on + Pane
        // (symmetric with the auto-CREATE below): the boot janitor can leave
        // a restored swarm 'failed' with no other escape hatch.
        if (activeSwarm.status !== 'running' && activeSwarm.status !== 'completed') {
          await rpc.swarms.resume(activeSwarm.id);
          dispatch({ type: 'UPSERT_SWARM', swarm: { ...activeSwarm, status: 'running' } });
        }
        targetSwarmId = activeSwarm.id;
      } else {
```

- [ ] **Step 7.6: Write + run the AddPaneButton test** — in its test file (reuse/extend the existing harness; create following the sibling component-test pattern if absent):

```typescript
describe('+ Pane auto-resume (spec 2026-06-10 D)', () => {
  it("clicking + Pane on a 'failed' swarm resumes it then adds the agent", async () => {
    // render with activeSwarm = { id: 'swarm-1', status: 'failed', agents: [] }
    // click the provider entry → expect mockRpc.swarms.resume called with 'swarm-1'
    // AND mockRpc.swarms.addAgent called after it.
  });

  it("a 'completed' swarm stays gated", () => {
    // render with status 'completed' → button disabled with
    // 'Swarm has ended — start a new swarm to add panes'.
  });
});
```

Run:

```bash
cd /Users/aisigma/projects/SigmaLink/app && npx vitest run src/renderer/features/command-room/AddPaneButton.test.tsx src/main/core/swarms/
```

Expected: PASS.

- [ ] **Step 7.7: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink
git add app/src/main/core/swarms/controller.ts app/src/shared/router-shape.ts app/src/shared/rpc-channels.ts app/src/renderer/features/command-room/AddPaneButton.tsx
git add app/src/main/core/swarms/*.test.ts app/src/renderer/features/command-room/AddPaneButton.test.tsx 2>/dev/null || true
git commit -m "fix(command-room): + Pane auto-resumes a failed/paused swarm (swarms.resume escape hatch)

unfailZombieSwarms (#134) only heals when panes actually spawned at
resume; with 0 spawns or a stale renderer status the + Pane gate locked
forever with no escape. Auto-resume on click, symmetric with the
existing auto-create. 'completed' stays a deliberate end state.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

---

### Task 8: Full gate + PR

- [ ] **Step 8.1: Full local gate (NO local e2e — CI runs the e2e-matrix)**

```bash
cd /Users/aisigma/projects/SigmaLink/app
npx tsc -b && npx vitest run && npx eslint . && npm run build && npm run electron:compile
```

Expected: all green (vitest ~315+ files; flaky under-load timeouts in swarms/factory or VoiceTab → re-run that file in isolation before reacting).

- [ ] **Step 8.2: Sibling sweep (grep the twins)**

```bash
cd /Users/aisigma/projects/SigmaLink/app
# Echo emitters — launch_pane must now appear alongside dispatchPane/dispatchBulk:
grep -rn "assistant:dispatch-echo" src/main | grep -v test
# Channel triple — all three files must mention the two new channels:
grep -rn "stageImage\|swarms.resume" src/shared/rpc-channels.ts src/shared/router-shape.ts src/main/rpc-router.ts src/main/core/swarms/controller.ts | grep -v test
```

Expected: `launch_pane`'s emit present; both new channels present in all of allowlist + shape + handler.

- [ ] **Step 8.3: Open the PR**

```bash
cd /Users/aisigma/projects/SigmaLink
gh pr create --base main --head fix/command-room-interaction-reliability \
  --title "fix(command-room): interaction reliability — launch_pane echo, copy/paste, screenshot staging, +Pane auto-resume" \
  --body "Implements docs/superpowers/specs/2026-06-10-command-room-interaction-reliability-design.md (4 root-caused bugs; plan: docs/superpowers/plans/2026-06-10-command-room-interaction-reliability.md). Roadmap Phase: Command Room interaction reliability.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 8.4: Watch CI; merge only when green**

```bash
gh pr checks --watch
```

Operator smoke after merge (manual): ① ask Jorvis to launch 2 panes → they appear in the grid; ② select text → right-click → Copy pastes elsewhere; Paste types into the pane; ③ drop + paste a screenshot on a claude pane → `@/…/staged-images/….png` appears and the CLI can read it; ④ force-quit → reopen → + Pane works first click.

---

## Self-review notes (writing-plans checklist)

- **Spec coverage:** A→Task 1, C→Task 2, B→Tasks 3-6, D→Task 7, gate→Task 8. The spec's "extract `usePaneImageStaging.ts` if PaneShell crosses 500 lines" is conditional — the implementer checks `wc -l` after Task 6 and extracts `stageAndInsertImages` + the paste effect + `arrayBufferToBase64` into `app/src/renderer/features/command-room/usePaneImageStaging.ts` if over.
- **Known unknowns made explicit:** PaneShell.test.tsx / AddPaneButton.test.tsx harness details are referenced, not invented — implementer must read the existing harness first (commented wiring lines mark exactly what to fill).
- **Type consistency:** `stageImage` input `{ bytesBase64, ext }` and return `{ absPath }` used identically in helper, shape, router, and renderer. `resume` returns `{ ok, healed }` in controller + shape + tests.
