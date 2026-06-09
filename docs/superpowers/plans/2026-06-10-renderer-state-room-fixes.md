# Renderer State & Room Hygiene Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 2026-06-10 renderer state/persistence audit cluster: the GLOBAL_ROOMS guard drift that lets 'settings'/'automations' leak into `roomByWorkspace` (and into the boot snapshot), plus six small leak/hygiene fixes (Splitter body styles, toggleRail KV side effect, dropped final session snapshot, PaneDivider listener leak, PaneShell flash timer, Launcher swarm-hydration sibling drift).

**Architecture:** All changes are renderer-side (Electron renderer, `app/src/renderer`). The centerpiece (Task 1) promotes `GLOBAL_ROOMS`/`isGlobalRoom` from a module-local helper in `state.reducer.ts` to an exported single source of truth in `state.types.ts`, then makes all four guard sites consume it, locked by an anti-drift test that enumerates every `GLOBAL_ROOMS` member at every site. Tasks 2–7 are independent, minimal, test-first fixes to existing files. No main-process, IPC-schema, or DB changes.

**Tech Stack:** TypeScript, React 19, Vitest + @testing-library/react (jsdom), Electron renderer. All commands run from `/Users/aisigma/projects/SigmaLink/app`.

**Verified against code 2026-06-10:** all 7 findings reproduced in source as described. None refuted.

---

## File Structure

**Modified:**
- `src/renderer/app/state.types.ts` — add exported `GLOBAL_ROOMS` + `isGlobalRoom` (single source of truth; file is React-free and already imported by both consumers).
- `src/renderer/app/state.reducer.ts` — delete the local copy (lines 12–24), import from `state.types`; fix the `WORKSPACE_OPEN` seed guard (line 276).
- `src/renderer/app/state-hooks/use-session-restore.ts` — fix `fallbackRoom` (line 267) via `isGlobalRoom`; rework the snapshot debounce to mark-on-write + flush on unmount/beforeunload (lines 290–320).
- `src/renderer/app/state-hooks/use-session-restore.test.ts` — fix `installSigmaStub` (lines 43–47) so it stops replacing `window` with a prototype-less plain object (required once the hook calls `window.addEventListener`).
- `src/renderer/features/right-rail/Splitter.tsx` — unmount cleanup for `document.body` cursor/userSelect.
- `src/renderer/features/right-rail/RightRailContext.tsx` — move the `toggleRail` KV write out of the setState updater.
- `src/renderer/features/command-room/PaneDivider.tsx` — detach window listeners + release the resize-suppression pair on mid-drag unmount (PR #133 behavior preserved byte-for-byte on the normal path).
- `src/renderer/features/command-room/PaneShell.tsx` — clear the 200 ms flash-drop timer on unmount (deliberately minimal; a sibling plan does major PaneShell surgery).
- `src/renderer/features/command-room/PaneShell.test.tsx` — one appended describe.
- `src/renderer/features/workspace-launcher/Launcher.tsx` — un-nest swarm hydration from the `sessions.length > 0` gate (align with the `Sidebar.openPersistedWorkspace` twin).

**Created (tests only):**
- `src/renderer/app/state.reducer.global-rooms.test.ts` — anti-drift enumeration of reducer sites 1–3 (new file because `state.reducer.test.ts` is at 489 lines; precedent: `state.reducer.memory-graph.test.ts`).
- `src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts` — site 4 (fallbackRoom) + the Task 4 flush coverage (new file because `use-session-restore.test.ts` is at 555 lines).
- `src/renderer/features/right-rail/Splitter.test.tsx`
- `src/renderer/features/right-rail/RightRailContext.test.tsx`
- `src/renderer/features/command-room/PaneDivider.test.tsx`
- `src/renderer/features/workspace-launcher/Launcher.swarm-hydration.test.tsx`

**Read-only references (do NOT modify):** `src/renderer/features/sidebar/Sidebar.tsx:175-210` (the correctly-shaped hydration twin), `src/renderer/features/command-room/PaneGrid.tsx:206-245` (the PR #133 `beginDrag`/`endDrag` + `sigma:pane-resize-start/-end` contract).

---

### Task 1: GLOBAL_ROOMS anti-drift — share `isGlobalRoom` at all four sites

The bug: `state.reducer.ts` defines `GLOBAL_ROOMS = ['workspaces', 'settings', 'automations']` and uses `isGlobalRoom` at `SET_ROOM` (l.223) and `SET_ROOM_FOR_WORKSPACE` (l.233), but two sibling sites drifted to a hand-rolled `'workspaces'`-only check:

- `state.reducer.ts:276` — `WORKSPACE_OPEN` seed condition is `state.room === 'workspaces'`, so opening a workspace while in Settings/Automations persists `roomByWorkspace[ws] = 'settings'`/`'automations'` → next boot restores into Settings and the real last room is lost.
- `use-session-restore.ts:267` — snapshot `fallbackRoom` is `state.room !== 'workspaces' ? state.room : 'command'`, so the active workspace's snapshot entry serializes a global room.

**Files:**
- Modify: `src/renderer/app/state.types.ts` (insert after the `RoomId` union, line 50)
- Modify: `src/renderer/app/state.reducer.ts:9-24` (imports + helper block) and `:269-285` (`WORKSPACE_OPEN`)
- Modify: `src/renderer/app/state-hooks/use-session-restore.ts:17` (import) and `:267` (`fallbackRoom`)
- Test (create): `src/renderer/app/state.reducer.global-rooms.test.ts`
- Test (create): `src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts`

- [ ] **Step 1: Write the failing reducer anti-drift test**

Create `src/renderer/app/state.reducer.global-rooms.test.ts` with exactly this content. It iterates `GLOBAL_ROOMS` itself, so any future global room is automatically covered at every site (that is the anti-drift property). It imports `GLOBAL_ROOMS`/`isGlobalRoom` from `state.types` — they don't exist there yet, so the very first run fails to compile, which is the expected first failure.

```ts
// @vitest-environment node
//
// 2026-06-10 audit, finding 1 — GLOBAL_ROOMS anti-drift.
//
// Four sites must agree on "global rooms are never persisted per-workspace":
//   site 1: SET_ROOM               (state.reducer.ts — was already enforced)
//   site 2: SET_ROOM_FOR_WORKSPACE (state.reducer.ts — was already enforced)
//   site 3: WORKSPACE_OPEN seed    (state.reducer.ts — HAD DRIFTED to a
//           hand-rolled `state.room === 'workspaces'` check, leaking
//           'settings'/'automations' into roomByWorkspace)
//   site 4: snapshot fallbackRoom  (use-session-restore.ts — covered by
//           use-session-restore.snapshot.test.ts, same enumeration)
//
// Every test iterates GLOBAL_ROOMS itself, so adding a new global room to
// state.types.ts automatically extends coverage to all sites — drift between
// the list and any one site fails here, not in production.
//
// Pure reducer — no React, no DOM. (Split out of state.reducer.test.ts to
// keep that file under the 500-line cap; precedent:
// state.reducer.memory-graph.test.ts.)

import { describe, it, expect } from 'vitest';

import { appStateReducer } from './state.reducer';
import { GLOBAL_ROOMS, initialAppState, isGlobalRoom } from './state.types';
import type { Workspace } from '../../shared/types';

function workspace(id: string): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    rootPath: `/tmp/${id}`,
    repoRoot: `/tmp/${id}`,
    repoMode: 'git',
    createdAt: 1,
    lastOpenedAt: 1,
  };
}

describe('GLOBAL_ROOMS — membership + helper', () => {
  it('contains the three known global surfaces', () => {
    expect([...GLOBAL_ROOMS].sort()).toEqual(['automations', 'settings', 'workspaces']);
  });

  it('isGlobalRoom agrees with the list and rejects workspace rooms', () => {
    for (const room of GLOBAL_ROOMS) expect(isGlobalRoom(room)).toBe(true);
    expect(isGlobalRoom('command')).toBe(false);
    expect(isGlobalRoom('swarm')).toBe(false);
    expect(isGlobalRoom('memory')).toBe(false);
  });
});

describe('GLOBAL_ROOMS anti-drift — reducer sites 1–3', () => {
  const wsA = workspace('a');

  // ── site 1: SET_ROOM ───────────────────────────────────────────────────────
  it.each([...GLOBAL_ROOMS])(
    'site 1 — SET_ROOM(%s) switches the room but never writes roomByWorkspace',
    (room) => {
      let s = appStateReducer(initialAppState, { type: 'READY', workspaces: [wsA] });
      s = appStateReducer(s, { type: 'WORKSPACE_OPEN', workspace: wsA }); // activates 'a'
      s = appStateReducer(s, { type: 'SET_ROOM', room: 'command' }); // seed a real room
      const before = s.roomByWorkspace;
      s = appStateReducer(s, { type: 'SET_ROOM', room });
      expect(s.room).toBe(room);
      expect(s.roomByWorkspace).toEqual(before); // entry for 'a' still 'command'
    },
  );

  // ── site 2: SET_ROOM_FOR_WORKSPACE ─────────────────────────────────────────
  it.each([...GLOBAL_ROOMS])(
    'site 2 — SET_ROOM_FOR_WORKSPACE(%s) is a strict no-op (same state reference)',
    (room) => {
      const s = appStateReducer(initialAppState, { type: 'READY', workspaces: [wsA] });
      const after = appStateReducer(s, {
        type: 'SET_ROOM_FOR_WORKSPACE',
        workspaceId: 'a',
        room,
      });
      expect(after).toBe(s);
    },
  );

  // ── site 3: WORKSPACE_OPEN seed (THE drifted site) ─────────────────────────
  it.each([...GLOBAL_ROOMS])(
    'site 3 — WORKSPACE_OPEN while the current room is %s does NOT seed roomByWorkspace',
    (room) => {
      // SET_ROOM with no active workspace sets `room` without touching the map.
      let s = appStateReducer(initialAppState, { type: 'READY', workspaces: [wsA] });
      s = appStateReducer(s, { type: 'SET_ROOM', room });
      s = appStateReducer(s, { type: 'WORKSPACE_OPEN', workspace: wsA });
      // Pre-fix this failed for 'settings' and 'automations': the seed guard
      // only checked `state.room === 'workspaces'`, so the global room leaked
      // into the per-workspace map → persisted → restored on next boot.
      expect(s.roomByWorkspace['a']).toBeUndefined();
    },
  );

  // Positive control — seeding must still work for real workspace rooms.
  it('site 3 control — WORKSPACE_OPEN while in command DOES seed roomByWorkspace', () => {
    let s = appStateReducer(initialAppState, { type: 'READY', workspaces: [wsA] });
    s = appStateReducer(s, { type: 'SET_ROOM', room: 'command' });
    s = appStateReducer(s, { type: 'WORKSPACE_OPEN', workspace: wsA });
    expect(s.roomByWorkspace['a']).toBe('command');
  });
});
```

- [ ] **Step 2: Run the reducer test to verify it fails**

Run: `npx vitest run src/renderer/app/state.reducer.global-rooms.test.ts`
Expected: FAIL — first with a module-resolution/type error (`state.types` has no export `GLOBAL_ROOMS`/`isGlobalRoom`). That confirms the test is wired to the intended single source of truth.

- [ ] **Step 3: Write the failing hook test (site 4 — snapshot fallbackRoom)**

Create `src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts` with exactly this content. The harness mirrors `use-session-restore.test.ts` but installs the sigma stub via `Object.defineProperty` so `window` keeps its prototype methods (`addEventListener` etc.) — Task 4's flush coverage is appended to this same file later.

```ts
// @vitest-environment jsdom
//
// 2026-06-10 audit — snapshot-writer coverage for useSessionRestore:
//   • finding 1 site 4: the snapshot `fallbackRoom` must treat EVERY
//     GLOBAL_ROOMS member as non-serializable (falls back to 'command'),
//     not just 'workspaces'. Enumerated over GLOBAL_ROOMS (anti-drift).
//   • finding 4 (Task 4 appends a describe here): the debounced snapshot
//     must FLUSH on unmount/beforeunload instead of being silently dropped.
//
// Split out of use-session-restore.test.ts (555 lines) to respect the
// 500-line cap. NOTE: unlike that file's installSigmaStub, this harness uses
// Object.defineProperty so `window` keeps its real prototype
// (addEventListener) — required once the hook registers a beforeunload flush.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReducer } from 'react';
import type { Workspace } from '@/shared/types';
import type { Action, AppState } from '../state.types';
import { GLOBAL_ROOMS, initialAppState } from '../state.types';
import { appStateReducer } from '../state.reducer';

type EventCb = (payload: unknown) => void;

interface SigmaStub {
  eventOn: ReturnType<typeof vi.fn<(event: string, cb: EventCb) => () => void>>;
  eventSend: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>>;
  emit: (event: string, payload: unknown) => void;
}

function installSigmaStub(): SigmaStub {
  const handlers = new Map<string, Set<EventCb>>();
  const eventOn = vi.fn((event: string, cb: EventCb) => {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(cb);
    return () => {
      handlers.get(event)?.delete(cb);
    };
  });
  const eventSend = vi.fn();
  const emit = (event: string, payload: unknown) => {
    handlers.get(event)?.forEach((fn) => fn(payload));
  };
  // defineProperty (NOT window replacement): keeps the real jsdom Window with
  // its prototype chain, so window.addEventListener works in the hook.
  Object.defineProperty(globalThis.window, 'sigma', {
    configurable: true,
    writable: true,
    value: { eventOn, eventSend, invoke: vi.fn() },
  });
  return { eventOn, eventSend, emit };
}

const resumeMock = vi.fn((workspaceId: string) =>
  Promise.resolve({
    workspaceId,
    resumed: [] as unknown[],
    failed: [] as unknown[],
    skipped: [] as unknown[],
  }),
);
const listForWorkspaceMock = vi.fn(async (_wsId: string) => [] as unknown[]);
const swarmsListMock = vi.fn(async (_wsId: string) => [] as unknown[]);
const kvGetMock = vi.fn(async (_key: string) => null as string | null);

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    panes: {
      resume: (id: string) => resumeMock(id),
      respawnFailed: vi.fn(async () => ({ spawned: 0, failed: 0 })),
      listForWorkspace: (id: string) => listForWorkspaceMock(id),
    },
    swarms: { list: (id: string) => swarmsListMock(id) },
    kv: { get: (k: string) => kvGetMock(k) },
  },
}));
vi.mock('../../lib/rpc', () => ({
  rpc: {
    panes: {
      resume: (id: string) => resumeMock(id),
      respawnFailed: vi.fn(async () => ({ spawned: 0, failed: 0 })),
      listForWorkspace: (id: string) => listForWorkspaceMock(id),
    },
    swarms: { list: (id: string) => swarmsListMock(id) },
    kv: { get: (k: string) => kvGetMock(k) },
  },
}));

function workspace(id: string): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    rootPath: `/tmp/${id}`,
    repoRoot: `/tmp/${id}`,
    repoMode: 'git',
    createdAt: 1,
    lastOpenedAt: 1,
  };
}

let sigma: SigmaStub;

beforeEach(() => {
  sigma = installSigmaStub();
  resumeMock.mockClear();
  listForWorkspaceMock.mockClear();
  swarmsListMock.mockClear();
  kvGetMock.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Harness {
  state: AppState;
  dispatch: (a: Action) => void;
}

async function renderRestore(initialActions: Action[] = []) {
  const { useSessionRestore } = await import('./use-session-restore');
  let harness: Harness | null = null;
  const Wrapper = () => {
    const [state, dispatch] = useReducer(appStateReducer, initialAppState);
    harness = { state, dispatch };
    useSessionRestore(state, dispatch);
    return null;
  };
  const r = renderHook(() => Wrapper());
  act(() => {
    for (const a of initialActions) {
      harness?.dispatch(a);
    }
  });
  return { r, getHarness: () => harness as unknown as Harness };
}

function snapshotCalls(stub: SigmaStub) {
  return stub.eventSend.mock.calls.filter((c) => c[0] === 'app:session-snapshot');
}

describe('GLOBAL_ROOMS anti-drift — site 4: snapshot fallbackRoom', () => {
  it.each([...GLOBAL_ROOMS])(
    'serialises the active workspace as command (not %s) when the active room is global',
    async (room) => {
      const wsA = workspace('a');
      const { getHarness } = await renderRestore([
        { type: 'READY', workspaces: [wsA] },
        { type: 'WORKSPACE_OPEN', workspace: wsA },
      ]);
      act(() => {
        getHarness().dispatch({ type: 'SET_ROOM', room });
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const calls = snapshotCalls(sigma);
      expect(calls.length).toBeGreaterThan(0);
      const last = calls[calls.length - 1]?.[1] as {
        activeWorkspaceId: string;
        openWorkspaces: Array<{ workspaceId: string; room: string }>;
      };
      // Pre-fix this failed for 'settings'/'automations': fallbackRoom only
      // excluded 'workspaces', so the global room was serialized for 'a'.
      expect(last.openWorkspaces).toEqual([{ workspaceId: 'a', room: 'command' }]);
    },
  );
});
```

- [ ] **Step 4: Run the hook test to verify it fails**

Run: `npx vitest run src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts`
Expected: FAIL — compile error on `GLOBAL_ROOMS` import (not yet exported). After Step 5's `state.types.ts` change alone it fails the `settings` and `automations` cases with `room: 'settings'`/`'automations'` instead of `'command'` (the `workspaces` case passes — it was the one room the drifted code handled).

- [ ] **Step 5: Implement — export the helper, fix both drifted sites**

5a. In `src/renderer/app/state.types.ts`, insert immediately after the `RoomId` union (after line 50, the `| 'automations';` line):

```ts
/**
 * Rooms that are NOT workspace-scoped. These must never be persisted into
 * `roomByWorkspace` (or serialized as a workspace's room in the session
 * snapshot) because they are global surfaces.
 * v1.4.2 — added 'settings' to fix the "click workspace after visiting
 * Settings stays on Settings" bug.
 * BSP-O3 — 'automations' is a global surface (Telegram + digest are
 * workspace-independent), so it must NOT be remembered per-workspace.
 * 2026-06-10 audit — exported (with `isGlobalRoom`) as the SINGLE source of
 * truth for all four guard sites: SET_ROOM, SET_ROOM_FOR_WORKSPACE,
 * WORKSPACE_OPEN (state.reducer.ts) and the snapshot `fallbackRoom`
 * (use-session-restore.ts). Add new global rooms HERE only —
 * state.reducer.global-rooms.test.ts + use-session-restore.snapshot.test.ts
 * enumerate this list at every site.
 */
export const GLOBAL_ROOMS: readonly RoomId[] = ['workspaces', 'settings', 'automations'] as const;

export function isGlobalRoom(room: RoomId): boolean {
  return (GLOBAL_ROOMS as readonly string[]).includes(room);
}
```

5b. In `src/renderer/app/state.reducer.ts`, replace lines 9–24 (the import line + the whole local `GLOBAL_ROOMS`/`isGlobalRoom` block including its doc comments):

```ts
import type { AgentSession, Notification, Swarm, Workspace } from '../../shared/types';
import {
  isGlobalRoom,
  selectActiveWorkspace,
  type Action,
  type AppState,
  type RoomId,
} from './state.types';

// GLOBAL_ROOMS / isGlobalRoom moved to state.types.ts (2026-06-10) so the
// snapshot writer in use-session-restore.ts shares the exact same guard —
// the two files had drifted (the WORKSPACE_OPEN seed + snapshot fallbackRoom
// only checked 'workspaces', leaking 'settings'/'automations').
```

Also update the file-header comment (lines 5–7) which claims all helpers are module-local — append one sentence: `// (Exception: isGlobalRoom is imported from state.types — it is shared with the session-snapshot writer.)`

5c. Still in `state.reducer.ts`, in the `WORKSPACE_OPEN` case, replace the seed condition (line ~276):

```ts
      const wsId = action.workspace.id;
      const roomByWorkspace =
        state.roomByWorkspace[wsId] || isGlobalRoom(state.room)
          ? state.roomByWorkspace
          : { ...state.roomByWorkspace, [wsId]: state.room };
```

(Only `state.room === 'workspaces'` → `isGlobalRoom(state.room)` changes; everything else is identical.)

5d. In `src/renderer/app/state-hooks/use-session-restore.ts`, change line 17 from:

```ts
import type { Action, AppState } from '../state.types';
```

to:

```ts
import { isGlobalRoom, type Action, type AppState } from '../state.types';
```

and replace line 267:

```ts
  const fallbackRoom = state.room !== 'workspaces' ? state.room : 'command';
```

with:

```ts
  // 2026-06-10 — global rooms (workspaces/settings/automations) must never be
  // serialized as a workspace's room; fall back to 'command'. Shares
  // isGlobalRoom with the reducer's three guard sites (anti-drift).
  const fallbackRoom = !isGlobalRoom(state.room) ? state.room : 'command';
```

- [ ] **Step 6: Run both new tests + the existing neighbors to verify pass / no regressions**

Run: `npx vitest run src/renderer/app/state.reducer.global-rooms.test.ts src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts src/renderer/app/state.reducer.test.ts src/renderer/app/state-hooks/use-session-restore.test.ts src/renderer/app/state.test.ts`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/app/state.types.ts src/renderer/app/state.reducer.ts src/renderer/app/state-hooks/use-session-restore.ts src/renderer/app/state.reducer.global-rooms.test.ts src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts
git commit -m "fix(state): share isGlobalRoom at WORKSPACE_OPEN seed + snapshot fallbackRoom (anti-drift)"
```

---

### Task 2: Splitter — reset body cursor/userSelect on mid-drag unmount

`Splitter.tsx:47-48` sets `document.body.style.cursor/userSelect` on pointerdown; they are reset only in `endDrag` (lines 75–76). If the splitter unmounts mid-drag (rail toggled closed, workspace switch), `user-select: none` sticks app-wide.

**Files:**
- Modify: `src/renderer/features/right-rail/Splitter.tsx` (insert effect after the width-mirror effect, line 39)
- Test (create): `src/renderer/features/right-rail/Splitter.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/features/right-rail/Splitter.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// 2026-06-10 audit, finding 2 — Splitter sets document.body cursor/userSelect
// on pointerdown and resets them only in endDrag. A mid-drag unmount (rail
// closed, workspace switch) previously left `user-select: none` app-wide.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Splitter } from './Splitter';

beforeAll(() => {
  // jsdom has no pointer capture; Splitter calls setPointerCapture unguarded
  // on pointerdown. (Pattern: MemoryQuickSwitcher.test.tsx.)
  const proto = Element.prototype as unknown as {
    setPointerCapture?: (id: number) => void;
    releasePointerCapture?: (id: number) => void;
  };
  if (!proto.setPointerCapture) proto.setPointerCapture = () => undefined;
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => undefined;
});

afterEach(() => {
  cleanup();
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

describe('Splitter — body style hygiene', () => {
  it('resets body cursor/userSelect when unmounted mid-drag', () => {
    const { getByRole, unmount } = render(
      <Splitter width={400} onResize={() => {}} onCommit={() => {}} />,
    );
    fireEvent.pointerDown(getByRole('separator'), { pointerId: 1, clientX: 500 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    unmount(); // mid-drag — endDrag never fires

    // Pre-fix: both stuck ('col-resize' / 'none') app-wide.
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('normal release still resets styles and commits the width (regression guard)', () => {
    const onCommit = vi.fn();
    const { getByRole } = render(
      <Splitter width={400} onResize={() => {}} onCommit={onCommit} />,
    );
    const sep = getByRole('separator');
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 500 });
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 480 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('unmount with NO drag in flight leaves body styles untouched (never stomp siblings)', () => {
    document.body.style.cursor = 'wait'; // another surface owns the cursor
    const { unmount } = render(
      <Splitter width={400} onResize={() => {}} onCommit={() => {}} />,
    );
    unmount();
    expect(document.body.style.cursor).toBe('wait');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/right-rail/Splitter.test.tsx`
Expected: FAIL — test 1 fails (`expected 'col-resize' to be ''`). Tests 2–3 pass (existing behavior).

- [ ] **Step 3: Implement the unmount cleanup**

In `src/renderer/features/right-rail/Splitter.tsx`, insert after the width-mirror effect (after line 39, before `onPointerDown`):

```tsx
  // 2026-06-10 — mid-drag unmount safety: pointerdown sets app-wide
  // cursor/userSelect on document.body and only endDrag resets them. If the
  // Splitter unmounts while a drag is in flight (rail toggled closed,
  // workspace switch), `user-select: none` sticks app-wide. Reset on unmount,
  // but ONLY when a drag is actually active so we never stomp styles another
  // component owns.
  useEffect(() => {
    return () => {
      if (draggingRef.current) {
        draggingRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, []);
```

(`useEffect` is already imported on line 8.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/features/right-rail/Splitter.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/right-rail/Splitter.tsx src/renderer/features/right-rail/Splitter.test.tsx
git commit -m "fix(rail): reset body cursor/userSelect when Splitter unmounts mid-drag"
```

---

### Task 3: RightRailContext — move the toggleRail KV write out of the setState updater

`RightRailContext.tsx:106-117` performs the KV write INSIDE the `setRailOpenState` updater. State updaters must be pure — React double-invokes them (StrictMode dev / render replay), double-firing the write.

**Files:**
- Modify: `src/renderer/features/right-rail/RightRailContext.tsx:106-117`
- Test (create): `src/renderer/features/right-rail/RightRailContext.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/features/right-rail/RightRailContext.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// 2026-06-10 audit, finding 3 — toggleRail performed its KV write INSIDE the
// setRailOpenState updater. Updaters must be pure: React double-invokes them
// under StrictMode (dev) — the write fired twice per toggle. Rendering under
// <StrictMode> makes the double-fire observable, so the assert below is the
// regression lock.

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const writeWorkspaceUiMock = vi.fn(async (..._a: unknown[]) => undefined);
const readWorkspaceUiMock = vi.fn(async (..._a: unknown[]) => null as string | null);
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: (...args: unknown[]) => readWorkspaceUiMock(...args),
  writeWorkspaceUi: (...args: unknown[]) => writeWorkspaceUiMock(...args),
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      set: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn(async () => null) },
  },
}));

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (sel: (s: unknown) => unknown) =>
    sel({ activeWorkspace: { id: 'ws1' } }),
}));

import { RightRailProvider } from './RightRailContext';
import { KV_OPEN, useRightRail, type RightRailContextValue } from './RightRailContext.data';

let ctx: RightRailContextValue | null = null;
function Probe() {
  ctx = useRightRail();
  return null;
}

function renderProvider() {
  return render(
    <StrictMode>
      <RightRailProvider>
        <Probe />
      </RightRailProvider>
    </StrictMode>,
  );
}

afterEach(() => {
  cleanup();
  ctx = null;
  vi.clearAllMocks();
});

describe('RightRailContext — toggleRail KV write hygiene', () => {
  it('toggleRail writes the per-workspace KV exactly ONCE under StrictMode', async () => {
    renderProvider();
    await act(async () => {}); // drain hydration reads
    writeWorkspaceUiMock.mockClear();

    act(() => {
      ctx?.toggleRail();
    });

    expect(ctx?.railOpen).toBe(false); // default open → closed
    // Pre-fix: 2 calls (updater double-invoked under StrictMode).
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith('ws1', KV_OPEN, 'false');
  });

  it('a second toggle round-trips back to open and writes "true" once', async () => {
    renderProvider();
    await act(async () => {});
    act(() => {
      ctx?.toggleRail();
    });
    writeWorkspaceUiMock.mockClear();

    act(() => {
      ctx?.toggleRail();
    });

    expect(ctx?.railOpen).toBe(true);
    expect(writeWorkspaceUiMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith('ws1', KV_OPEN, 'true');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/right-rail/RightRailContext.test.tsx`
Expected: FAIL — `expected writeWorkspaceUiMock to be called 1 times, but got 2 times` (StrictMode double-invokes the impure updater).

- [ ] **Step 3: Implement — compute next, delegate to setRailOpen**

In `src/renderer/features/right-rail/RightRailContext.tsx`, replace the whole `toggleRail` callback (lines 106–117):

```tsx
  const toggleRail = useCallback(() => {
    // 2026-06-10 — the KV write used to live INSIDE the setRailOpenState
    // updater. Updaters must be pure: React may invoke them twice (StrictMode
    // dev / render replay), double-firing the write. Compute the next value
    // from the rendered state and delegate to setRailOpen, which owns the
    // single state-set + KV-write path (DRY).
    setRailOpen(!railOpen);
  }, [railOpen, setRailOpen]);
```

(`toggleRail`'s identity now changes when `railOpen` flips — harmless: the memoized context `value` already lists `railOpen` in its deps, so consumers re-render on toggle regardless.)

- [ ] **Step 4: Run to verify pass + neighbors**

Run: `npx vitest run src/renderer/features/right-rail/`
Expected: ALL PASS (new file 2/2; `RightRail.layout`, `RightRail.rsp`, `SigmaPanel`, `SwarmPhaseTree`, `SwarmRailTab` unchanged-green — they mock the context).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/right-rail/RightRailContext.tsx src/renderer/features/right-rail/RightRailContext.test.tsx
git commit -m "fix(rail): move toggleRail KV write out of the setState updater"
```

---

### Task 4: use-session-restore — flush the debounced snapshot instead of dropping it

`use-session-restore.ts:307-308` marks `lastSnapshotKeyRef` as written BEFORE the 250 ms debounce fires, and the unmount cleanup (lines 295–302) cancels the timer. Unmount/quit inside the window silently drops the final snapshot. Fix: mark the key only when the write actually executes, keep the pending payload in a ref, and FLUSH it on unmount and on `beforeunload`.

**Depends on Task 1** (this file now imports `isGlobalRoom`; the code below reflects that state).

**Files:**
- Modify: `src/renderer/app/state-hooks/use-session-restore.ts:13` (imports) and `:290-320` (the ref/effect block)
- Modify: `src/renderer/app/state-hooks/use-session-restore.test.ts:43-47` (`installSigmaStub` window stub — REQUIRED, see Step 3)
- Test (modify): `src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts` (append a describe)

- [ ] **Step 1: Append the failing flush tests**

Append to the END of `src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts` (after the site-4 describe; all harness helpers — `workspace`, `renderRestore`, `snapshotCalls`, `sigma` — are already defined in that file from Task 1):

```ts
describe('snapshot debounce — flush instead of drop (2026-06-10 finding 4)', () => {
  it('flushes the pending snapshot on unmount instead of dropping it', async () => {
    const wsA = workspace('a');
    const { r, getHarness } = await renderRestore([
      { type: 'READY', workspaces: [wsA] },
      { type: 'WORKSPACE_OPEN', workspace: wsA },
    ]);
    // Drain the initial debounce so the baseline snapshot is written.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    sigma.eventSend.mockClear();

    // Change the room → a NEW snapshot is pending inside the 250ms window.
    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'swarm' });
    });
    expect(snapshotCalls(sigma)).toHaveLength(0); // still debouncing

    // Unmount INSIDE the window (hook teardown). Pre-fix: the cleanup
    // cancelled the timer and the key was already marked written → the final
    // snapshot was silently lost (0 calls).
    r.unmount();

    const calls = snapshotCalls(sigma);
    expect(calls).toHaveLength(1);
    const payload = calls[0]?.[1] as {
      openWorkspaces: Array<{ workspaceId: string; room: string }>;
    };
    expect(payload.openWorkspaces).toEqual([{ workspaceId: 'a', room: 'swarm' }]);
  });

  it('flushes the pending snapshot on beforeunload (quit inside the debounce window)', async () => {
    const wsA = workspace('a');
    const { getHarness } = await renderRestore([
      { type: 'READY', workspaces: [wsA] },
      { type: 'WORKSPACE_OPEN', workspace: wsA },
    ]);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    sigma.eventSend.mockClear();

    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'memory' });
    });
    expect(snapshotCalls(sigma)).toHaveLength(0);

    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    const calls = snapshotCalls(sigma);
    expect(calls).toHaveLength(1);
    const payload = calls[0]?.[1] as {
      openWorkspaces: Array<{ workspaceId: string; room: string }>;
    };
    expect(payload.openWorkspaces).toEqual([{ workspaceId: 'a', room: 'memory' }]);
  });

  it('cancels a stale pending write when state returns to the last-written key (A→B→A)', async () => {
    const wsA = workspace('a');
    const { getHarness } = await renderRestore([
      { type: 'READY', workspaces: [wsA] },
      { type: 'WORKSPACE_OPEN', workspace: wsA },
    ]);
    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'command' }); // A
    });
    act(() => {
      vi.advanceTimersByTime(500); // A written
    });
    sigma.eventSend.mockClear();

    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'swarm' }); // B pending
    });
    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'command' }); // back to A
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // A is already persisted; the stale B write must have been cancelled —
    // nothing (especially not 'swarm') may land.
    expect(snapshotCalls(sigma)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts`
Expected: site-4 describe PASSES (Task 1 done); the three new tests FAIL — tests 1–2 with `expected [] to have a length of 1` (snapshot dropped), test 3 with a `'swarm'` payload landing.

- [ ] **Step 3: Fix the OLD test file's window stub (prerequisite for the implementation)**

The implementation below adds `window.addEventListener('beforeunload', …)` to the hook. `use-session-restore.test.ts`'s `installSigmaStub` (lines 43–47) REPLACES `globalThis.window` with `{ ...window, sigma }` — a plain object that loses prototype methods like `addEventListener` (spread copies only own enumerable props), so every existing test in that file would crash. Replace lines 43–47 of `src/renderer/app/state-hooks/use-session-restore.test.ts`:

```ts
  (globalThis as unknown as { window: { sigma: unknown } }).window = {
    ...(globalThis.window ?? {}),
    sigma: { eventOn, eventSend, invoke: vi.fn() },
  };
```

with:

```ts
  // 2026-06-10 — defineProperty instead of window replacement: spreading the
  // jsdom Window produced a prototype-less plain object, which broke once the
  // hook started calling window.addEventListener (beforeunload flush).
  Object.defineProperty(globalThis.window, 'sigma', {
    configurable: true,
    writable: true,
    value: { eventOn, eventSend, invoke: vi.fn() },
  });
```

- [ ] **Step 4: Implement mark-on-write + flush**

4a. In `src/renderer/app/state-hooks/use-session-restore.ts` line 13, add `useCallback`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
```

4b. Replace the entire block from `const lastSnapshotKeyRef = useRef<string>('');` (line 290) through the end of the debounce effect (line 320, the `}, [state.ready, snapshotKey, snapshotEntries, wsId]);` line) — i.e. BOTH the old unmount-cancel effect and the old debounce effect — with:

```ts
  // 2026-06-10 finding 4 — mark-on-write + flush-on-teardown.
  //
  // The old shape marked `lastSnapshotKeyRef` BEFORE the 250ms debounce fired
  // and the unmount cleanup cancelled the timer — an unmount/quit inside the
  // window silently dropped the FINAL snapshot (the key was already "written"
  // so it could never be retried). Now:
  //   • `pendingSnapshotRef` holds the payload of the scheduled write;
  //   • `lastSentKeyRef` is set only when the write actually EXECUTES;
  //   • unmount and `beforeunload` FLUSH the pending write instead of
  //     dropping it.
  // The v1.3.3 no-op-re-render guarantee is preserved: a re-render with an
  // unchanged key early-returns on the pending-key compare and never touches
  // the timer.
  const lastSentKeyRef = useRef<string>('');
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSnapshotRef = useRef<{
    key: string;
    activeWorkspaceId: string;
    openWorkspaces: Array<{ workspaceId: string; room: string }>;
  } | null>(null);

  // Send the pending snapshot NOW (if any) and mark its key as written.
  // Stable identity (no deps) so the teardown effect never re-subscribes.
  const flushSnapshot = useCallback(() => {
    const pending = pendingSnapshotRef.current;
    if (!pending) return;
    pendingSnapshotRef.current = null;
    if (snapshotTimerRef.current) {
      clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
    }
    lastSentKeyRef.current = pending.key;
    try {
      window.sigma.eventSend('app:session-snapshot', {
        activeWorkspaceId: pending.activeWorkspaceId,
        openWorkspaces: pending.openWorkspaces,
      });
    } catch {
      /* preload bridge gone — nothing actionable on the renderer side */
    }
  }, []);

  // Flush (not drop) on unmount AND on window unload, so a quit/reload inside
  // the debounce window still persists the final snapshot.
  useEffect(() => {
    window.addEventListener('beforeunload', flushSnapshot);
    return () => {
      window.removeEventListener('beforeunload', flushSnapshot);
      flushSnapshot();
    };
  }, [flushSnapshot]);

  useEffect(() => {
    if (!state.ready) return;
    if (!snapshotKey) return;
    const pending = pendingSnapshotRef.current;
    // No-op when this exact content is already scheduled, or already written
    // with nothing newer pending.
    if (snapshotKey === (pending?.key ?? lastSentKeyRef.current)) return;
    if (snapshotKey === lastSentKeyRef.current && pending) {
      // State changed BACK to the last-written key while a DIFFERENT write
      // was pending (A → B → A inside the window): cancel the stale B write
      // instead of letting it persist over the already-correct A.
      pendingSnapshotRef.current = null;
      if (snapshotTimerRef.current) {
        clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
      return;
    }
    pendingSnapshotRef.current = {
      key: snapshotKey,
      activeWorkspaceId: wsId!,
      openWorkspaces: snapshotEntries,
    };
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      snapshotTimerRef.current = null;
      flushSnapshot();
    }, 250);
  }, [state.ready, snapshotKey, snapshotEntries, wsId, flushSnapshot]);
```

Keep the long v1.1.10/v1.3.3 comment block above `const wsId = state.activeWorkspace?.id;` (lines 242–265) unchanged — it documents the still-true serialization semantics.

- [ ] **Step 5: Run to verify pass + no regressions in the old suite**

Run: `npx vitest run src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts src/renderer/app/state-hooks/use-session-restore.test.ts`
Expected: ALL PASS. (The old suite's snapshot assertions use `.find(...)` on `eventSend` calls, so the extra flush-on-unmount emission at RTL teardown does not affect them; the stub fix from Step 3 keeps `window.addEventListener` available.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/state-hooks/use-session-restore.ts src/renderer/app/state-hooks/use-session-restore.test.ts src/renderer/app/state-hooks/use-session-restore.snapshot.test.ts
git commit -m "fix(state): flush the debounced session snapshot on unmount/beforeunload instead of dropping it"
```

---

### Task 5: PaneDivider — detach window listeners on mid-drag unmount

`PaneDivider.tsx:49-68` attaches `window` `pointermove`/`pointerup` listeners per drag, removed only inside `up`. A mid-drag unmount (pane closed, grid reshape) leaks both listeners + the pending rAF — and worse, the parent's `onResizeEnd` never fires, so the `sigma:pane-resize-start` terminal-refit suppression (PR #133, `PaneGrid.tsx:215/244`) is never released.

**CAUTION:** This file is part of the just-shipped PR #133 drag system. The normal pointerdown→move→up path must remain byte-identical in behavior: same listener targets, same rAF coalescing, same `flush()` + `onResizeEnd()` ordering on release. The fix ONLY adds an unmount path.

**Files:**
- Modify: `src/renderer/features/command-room/PaneDivider.tsx:8` (import) and `:36-69` (`onPointerDown` + new ref/effect)
- Test (create): `src/renderer/features/command-room/PaneDivider.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/features/command-room/PaneDivider.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// 2026-06-10 audit, finding 5 — PaneDivider's per-drag window pointermove/up
// listeners (and pending rAF) leaked when the divider unmounted mid-drag, and
// the parent's onResizeEnd never fired — leaving the PR #133
// sigma:pane-resize-start refit suppression stuck ON for every terminal.
// The normal release path must stay byte-identical (PR #133 drag system).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { PaneDivider } from './PaneDivider';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDivider() {
  const onResizeStart = vi.fn();
  const onResize = vi.fn();
  const onResizeEnd = vi.fn();
  const utils = render(
    <PaneDivider
      orientation="vertical"
      getSize={() => 1000}
      onResizeStart={onResizeStart}
      onResize={onResize}
      onResizeEnd={onResizeEnd}
    />,
  );
  return { ...utils, onResizeStart, onResize, onResizeEnd };
}

describe('PaneDivider — mid-drag unmount safety (PR #133 behavior preserved)', () => {
  it('normal release: pointerup ends the drag exactly once; a later unmount does not re-end it', () => {
    const { getByTestId, unmount, onResizeStart, onResizeEnd } = renderDivider();
    fireEvent.pointerDown(getByTestId('pane-divider'), { pointerId: 1, clientX: 100 });
    expect(onResizeStart).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 120 });
    expect(onResizeEnd).toHaveBeenCalledTimes(1);

    unmount();
    expect(onResizeEnd).toHaveBeenCalledTimes(1); // no double-end
  });

  it('unmount mid-drag detaches the window listeners and still releases the drag once', () => {
    // Synchronous rAF: a LEAKED pointermove listener would call onResize
    // immediately, making the leak assertion deterministic.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const { getByTestId, unmount, onResize, onResizeEnd } = renderDivider();
    fireEvent.pointerDown(getByTestId('pane-divider'), { pointerId: 1, clientX: 100 });

    unmount(); // pane closed / grid reshape mid-drag

    // The sigma:pane-resize-start suppression pair must be released exactly
    // once (pre-fix: never — terminals stayed refit-suppressed forever).
    expect(onResizeEnd).toHaveBeenCalledTimes(1);

    // And the window listeners must be GONE: a post-unmount pointermove must
    // not drive onResize (pre-fix: the leaked listener still fired).
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('keyboard nudge path is untouched: arrow key fires start → resize → end once each', () => {
    const { getByTestId, onResizeStart, onResize, onResizeEnd } = renderDivider();
    fireEvent.keyDown(getByTestId('pane-divider'), { key: 'ArrowRight' });
    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(0.02);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/PaneDivider.test.tsx`
Expected: FAIL — test 2 fails at `expect(onResizeEnd).toHaveBeenCalledTimes(1)` (got 0: unmount never released the drag). Tests 1 and 3 pass (existing behavior).

- [ ] **Step 3: Implement the abort-on-unmount path**

In `src/renderer/features/command-room/PaneDivider.tsx`:

3a. Line 8 — add `useEffect`:

```tsx
import { useEffect, useRef } from 'react';
```

3b. After `const pendingRef = useRef<number | null>(null);` (line 26), add:

```tsx
  // 2026-06-10 — mid-drag unmount safety. The window pointermove/up listeners
  // + pending rAF attached in onPointerDown normally detach in `up`. If the
  // divider unmounts mid-drag (pane closed, grid reshape), they leak — and
  // worse, the paired `sigma:pane-resize-end` (fired by the parent's
  // onResizeEnd, see PaneGrid endDrag) never happens, leaving terminal refits
  // suppressed forever. `dragAbortRef` holds a cancel closure for the ACTIVE
  // drag only; the normal `up` path clears it first, so release behavior is
  // identical to PR #133.
  const dragAbortRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      dragAbortRef.current?.();
      dragAbortRef.current = null;
    };
  }, []);
```

3c. Inside `onPointerDown`, replace the `up` closure and the two `addEventListener` lines (lines 55–68) with:

```tsx
    const up = (ev: PointerEvent) => {
      dragAbortRef.current = null;
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* may already be released / detached — ignore */
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      flush();
      onResizeEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    dragAbortRef.current = () => {
      // Unmount path only: detach listeners + cancel the rAF WITHOUT flushing
      // a final onResize (the parent may be unmounting too); still fire
      // onResizeEnd so the sigma:pane-resize-start suppression is released.
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pendingRef.current = null;
      onResizeEnd();
    };
```

(The only change to the normal path is the added `dragAbortRef.current = null;` first line in `up` — everything else is the existing PR #133 code verbatim.)

- [ ] **Step 4: Run to verify pass + PaneGrid neighbors**

Run: `npx vitest run src/renderer/features/command-room/PaneDivider.test.tsx src/renderer/features/command-room/PaneGrid.test.tsx`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/command-room/PaneDivider.tsx src/renderer/features/command-room/PaneDivider.test.tsx
git commit -m "fix(command-room): detach PaneDivider window listeners + release refit suppression on mid-drag unmount"
```

---

### Task 6: PaneShell — clear the 200 ms flash-drop timer on unmount

`PaneShell.tsx:261` — `setTimeout(() => setFlashDrop(false), 200)` is never cleared; a drop followed by an immediate pane close leaks the timeout (setState on an unmounted component). **Keep this edit MINIMAL** — a sibling plan (terminal-cache-scratch) does major PaneShell scratch-tab surgery; this task adds exactly one ref, one effect, and two lines in `handleDrop`.

**Files:**
- Modify: `src/renderer/features/command-room/PaneShell.tsx:109` (after the `flashDrop` state) and `:260-261` (in `handleDrop`)
- Test (modify): `src/renderer/features/command-room/PaneShell.test.tsx` (append one describe at the end)

- [ ] **Step 1: Append the failing test**

Append at the END of `src/renderer/features/command-room/PaneShell.test.tsx` (its existing imports already include `fireEvent`, `screen`, `vi`; `makeSession`/`renderPaneShell` are defined at lines 162–193):

```tsx
// ---------------------------------------------------------------------------
// 2026-06-10 audit, finding 6 — flash-drop timer hygiene
// ---------------------------------------------------------------------------
describe('PaneShell — flash-drop timer hygiene', () => {
  it('clears the 200ms flash reset timer on unmount', async () => {
    vi.useFakeTimers();
    try {
      // worktreePath:null keeps the git-status poller inert so the timer
      // delta below isolates the flash timer.
      const session = makeSession({ worktreePath: null });
      const { unmount } = await renderPaneShell(session);
      await act(async () => {}); // settle mount effects (kv gate read)

      const body = screen.getByTestId('pane-body');
      const before = vi.getTimerCount();
      fireEvent.drop(body, {
        dataTransfer: { types: ['Files'], getData: () => '', files: [] },
      });
      expect(vi.getTimerCount()).toBe(before + 1); // flash reset armed

      unmount();
      // Pre-fix: before + 1 — the 200ms timeout leaked past unmount.
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/PaneShell.test.tsx`
Expected: the new test FAILS with `expected <before+1> to be <before>` (timer leaked); all existing scratch-tab tests stay green.

- [ ] **Step 3: Implement the minimal fix**

In `src/renderer/features/command-room/PaneShell.tsx`:

3a. Directly after `const [flashDrop, setFlashDrop] = useState(false);` (line 109), add:

```tsx
  // 2026-06-10 — the 200ms flash reset timer must not outlive the pane (drop
  // → immediate pane close leaked the timeout). DELIBERATELY minimal: the
  // terminal-cache-scratch plan does larger PaneShell surgery.
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);
```

(`useEffect`/`useRef` are already imported on line 15.)

3b. In `handleDrop` (lines 260–261), replace:

```tsx
    setFlashDrop(true);
    setTimeout(() => setFlashDrop(false), 200);
```

with:

```tsx
    setFlashDrop(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashDrop(false), 200);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/features/command-room/PaneShell.test.tsx`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/command-room/PaneShell.tsx src/renderer/features/command-room/PaneShell.test.tsx
git commit -m "fix(command-room): clear PaneShell flash-drop timer on unmount"
```

---

### Task 7: Launcher — hydrate swarms independently of panes (sibling drift with Sidebar)

`Launcher.tsx:395-405` (`chooseExisting`) nests the swarm hydration inside `if (sessions.length > 0)`. Its twin, `Sidebar.tsx:187-202` (`openPersistedWorkspace`), hydrates sessions and swarms with INDEPENDENT checks (so does `use-session-restore.ts:148-159`). A swarm-but-no-panes workspace opened via the Launcher skips `UPSERT_SWARM` — currently masked by the canonical use-live-events loader, but the mirrored read-paths must agree.

**Files:**
- Modify: `src/renderer/features/workspace-launcher/Launcher.tsx:386-411` (inside `chooseExisting`)
- Reference (do NOT modify): `src/renderer/features/sidebar/Sidebar.tsx:175-210`
- Test (create): `src/renderer/features/workspace-launcher/Launcher.swarm-hydration.test.tsx`

- [ ] **Step 1: Write the failing drift test**

Create `src/renderer/features/workspace-launcher/Launcher.swarm-hydration.test.tsx` (harness mirrors `Launcher.sessions.integration.test.tsx`: StartStep stub auto-fires `onChooseRecent` → `chooseExisting` runs; mock factories run lazily at the dynamic `import('./Launcher')`, so referencing module-level consts is safe — same pattern as the existing integration file):

```tsx
// @vitest-environment jsdom
//
// 2026-06-10 audit, finding 7 — sibling-drift guard. Launcher.chooseExisting
// and Sidebar.openPersistedWorkspace are twin workspace-open hydration
// read-paths. The Sidebar (and use-session-restore) hydrate swarms
// INDEPENDENTLY of sessions; the Launcher used to nest swarm hydration inside
// `if (sessions.length > 0)`, so a swarm-but-no-panes workspace silently
// skipped UPSERT_SWARM (masked by the canonical use-live-events loader).
// This locks the aligned behavior. Harness mirrors
// Launcher.sessions.integration.test.tsx.

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { Workspace } from '@/shared/types';

// The drift case: a RUNNING swarm but ZERO panes.
const runningSwarm = {
  id: 'swarm-1',
  workspaceId: 'ws-drift',
  status: 'running',
  name: 'drift swarm',
  startedAt: 0,
};

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: async () => null, set: async () => undefined },
    providers: { probeAll: async () => [] },
    workspaces: {
      launch: async () => ({ sessions: [] }),
      pickFolder: async () => null,
      open: async () => makeWorkspace(),
      list: async () => [makeWorkspace()],
    },
    panes: { listForWorkspace: async () => [] },
    swarms: { list: async () => [runningSwarm] },
    design: { createCanvas: async () => ({}) },
    browser: { getState: async () => ({ tabs: [] }) },
  },
  rpcSilent: {
    panes: {
      listSessions: async () => [],
      lastResumePlan: async () => [],
    },
    kv: { get: async () => null },
  },
}));

const dispatchMock = vi.fn();
vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStateSelector: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ activeWorkspace: makeWorkspace(), workspaces: [makeWorkspace()] }),
  ),
}));

// StartStep stub fires onChooseRecent immediately → chooseExisting runs.
vi.mock('./StartStep', () => ({
  StartStep: ({
    onChooseRecent,
    recents,
  }: {
    onChooseRecent: (ws: Workspace) => void;
    recents: Workspace[];
  }) => {
    const ws = recents[0];
    if (ws) void Promise.resolve().then(() => onChooseRecent(ws));
    return <div data-testid="start-step-stub" />;
  },
}));
vi.mock('./IntentCards', () => ({ IntentCards: () => <div data-testid="intent-cards" /> }));
vi.mock('./Stepper', () => ({ Stepper: () => <div data-testid="stepper" /> }));
vi.mock('./LayoutStep', () => ({ LayoutStep: () => <div data-testid="layout-step" /> }));
vi.mock('./AgentsStep', () => ({ AgentsStep: () => <div data-testid="agents-step" /> }));
vi.mock('./SessionStep', () => ({
  SessionStep: () => <div data-testid="session-step" />,
  fetchLastResumePlan: async () => [],
}));
vi.mock('@/components/ui/card', () => ({
  Card: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: () => <input type="checkbox" />,
}));
vi.mock('@/renderer/components/ErrorBanner', () => ({
  ErrorBanner: ({ message }: { message: string }) => <div data-testid="error-banner">{message}</div>,
}));

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-drift',
    name: 'Drift Test WS',
    rootPath: '/tmp/drift',
    repoRoot: null,
    repoMode: 'plain',
    createdAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  dispatchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe('Launcher.chooseExisting — swarm-but-no-panes hydration (twin: Sidebar.openPersistedWorkspace)', () => {
  it('dispatches UPSERT_SWARM + SET_ACTIVE_SWARM even when the workspace has zero panes', async () => {
    const { WorkspaceLauncher } = await import('./Launcher');
    await act(async () => {
      render(<WorkspaceLauncher />);
      // Pump microtasks: StartStep → onChooseRecent → chooseExisting →
      // Promise.all(listForWorkspace, swarms.list) resolves.
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });

    await waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledWith({ type: 'UPSERT_SWARM', swarm: runningSwarm });
    });
    expect(dispatchMock).toHaveBeenCalledWith({ type: 'SET_ACTIVE_SWARM', id: 'swarm-1' });
    // Alignment with the Sidebar twin: an empty pane list must NOT dispatch
    // ADD_SESSIONS.
    expect(dispatchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ADD_SESSIONS' }),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/workspace-launcher/Launcher.swarm-hydration.test.tsx`
Expected: FAIL — `waitFor` times out: `UPSERT_SWARM` is never dispatched (the swarm hydration is nested inside the `sessions.length > 0` branch, and `sessions` is empty).

- [ ] **Step 3: Implement — un-nest the swarm hydration**

In `src/renderer/features/workspace-launcher/Launcher.tsx`, inside `chooseExisting`, replace the body of the first `try` block (lines 386–411, from the `// v1.5.3-hotfix` comment through `return;` and its closing brace) with:

```ts
    try {
      // v1.5.3-hotfix — Promise.all of sessions + swarms so AddPaneButton's
      // activeSwarm resolves correctly after Launcher-driven workspace open
      // (was dispatching ADD_SESSIONS only → renderer thought no swarm
      // existed → +Pane disabled with misleading reason).
      const [sessions, swarms] = await Promise.all([
        rpc.panes.listForWorkspace(reopened.id),
        rpc.swarms.list(reopened.id),
      ]);
      // ADD_SESSIONS dispatches first so terminal-cache GC doesn't dispose
      // sessions that are about to become visible.
      if (sessions.length > 0) {
        dispatch({ type: 'ADD_SESSIONS', sessions });
      }
      // 2026-06-10 sibling-drift fix (twin: Sidebar.openPersistedWorkspace,
      // also use-session-restore) — swarm hydration must NOT be gated on
      // sessions.length: a swarm-but-no-panes workspace previously skipped
      // UPSERT_SWARM here. The twins hydrate sessions and swarms
      // independently; keep all three read-paths aligned.
      if (swarms.length > 0) {
        for (const swarm of swarms) {
          dispatch({ type: 'UPSERT_SWARM', swarm });
        }
        const running = swarms.find((s) => s.status === 'running');
        if (running) {
          dispatch({ type: 'SET_ACTIVE_SWARM', id: running.id });
        }
      }
      if (sessions.length > 0) {
        // Route to Command Room now that panes are hydrated.
        // v1.3.3 — route into the Command Room so the user sees panes instead
        // of staying on the Launcher's Start step after re-opening a workspace.
        dispatch({ type: 'SET_ROOM', room: 'command' });
        return;
      }
    } catch (err) {
      // Best-effort: log + fall through to resume plan flow.
      console.warn('[chooseExisting] listForWorkspace failed; falling through', err);
    }
```

(Routing is unchanged: with panes → Command Room + return; without panes → fall through to the existing `SET_ROOM 'command'` + resume-plan flow below, exactly as before.)

- [ ] **Step 4: Run to verify pass + Launcher neighbors**

Run: `npx vitest run src/renderer/features/workspace-launcher/`
Expected: ALL PASS (new file 1/1; `Launcher.test.tsx`, `Launcher.sessions.integration.test.tsx`, step tests unchanged-green).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/workspace-launcher/Launcher.tsx src/renderer/features/workspace-launcher/Launcher.swarm-hydration.test.tsx
git commit -m "fix(launcher): hydrate swarms even when a workspace has no panes (sibling drift with Sidebar)"
```

---

### Task 8: Full gate

**Files:** none (verification only). Run from `/Users/aisigma/projects/SigmaLink/app`.

- [ ] **Step 1: Typecheck**

Run: `npx tsc -b`
Expected: clean exit (0). (`tsc -b` checks test files too — the worktree/lane tsc is laxer, so always re-gate here.)

- [ ] **Step 2: Lint**

Run: `npx eslint . --max-warnings 0`
Expected: clean exit (0).

- [ ] **Step 3: Full unit suite**

Run: `npx vitest run`
Expected: ALL PASS. Known flake note: under load, `swarms/factory` and `VoiceTab` files can time out — re-run the failing file in isolation before reacting; do not "fix" a flake.

- [ ] **Step 4: Product check**

Run: `npm run product:check`
Expected: build + electron:compile succeed.

- [ ] **Step 5: NO local e2e**

Do NOT run `npx playwright test tests/e2e/` or `npm run electron:dev` locally — it launches competing Electron windows on the operator's machine (standing rule). E2E is covered by the CI e2e-matrix on the PR.

---

## Coordination notes

**Sibling plans in this batch (file-ownership fences):**
- **terminal-cache-scratch plan** owns major `PaneShell.tsx` surgery (scratch-tab rework). Task 6 here is deliberately a 3-line + 1-effect edit. If that plan lands first, REBASE and re-locate the flash lines (`flashDrop` state is currently `PaneShell.tsx:109`, the timer at `:261`) — the fix shape (ref + unmount-clear + re-arm guard) carries over verbatim. If this plan lands first, tell that lane the `flashTimerRef` exists so they don't re-introduce a bare `setTimeout`.
- **jorvis plan** owns `src/renderer/features/jorvis-assistant/**` — this plan touches none of those files; no ordering constraint.
- **perf-render plan** owns `useAppState`→selector swaps — this plan changes no selector wiring (`RightRailContext` already consumes `useAppStateSelector` and keeps it). No ordering constraint.

**Execution hygiene (repo-specific):**
- This repo runs MANY concurrent sessions; the shared working tree gets stomped mid-task. Execute in an ISOLATED worktree branched off `origin/main` (`superpowers:using-git-worktrees`), commit atomically per task, push to a fresh branch, open a PR — do not work on `feat/bsp-pane-tiling` (it carries unrelated agent-identity WIP).
- Task 4 depends on Task 1 (shared `use-session-restore.ts` + shared new test file); execute in order. Tasks 2, 3, 5, 6, 7 are independent of each other and of 1/4.
- PR #133 caution (Tasks 5 and 6): the `sigma:pane-resize-start`/`-end` suppression contract lives in `PaneGrid.tsx:206-245`. Task 5's normal-path code is the existing code verbatim plus one `dragAbortRef.current = null;` line; any other delta to `up`/`move`/`flush` is a red flag — stop and re-check.
- Sibling-site map for reviewers (grep-the-twins): finding 1 has FOUR sites (two reducer guards already correct, two fixed here); finding 7 has THREE read-paths (`Launcher.chooseExisting` fixed here; `Sidebar.openPersistedWorkspace` and `use-session-restore` already correct — verify, don't edit).

**Self-review (done at plan time):**
- Spec coverage: finding 1 → Task 1; finding 2 → Task 2; finding 3 → Task 3; finding 4 → Task 4; finding 5 → Task 5; finding 6 → Task 6; finding 7 → Task 7; gate → Task 8. No gaps; no findings refuted (all seven reproduced in source on 2026-06-10).
- Placeholder scan: every code step contains complete, paste-ready code; no TBDs.
- Type consistency: `GLOBAL_ROOMS: readonly RoomId[]` + `isGlobalRoom(room: RoomId): boolean` are used with identical signatures in Tasks 1's reducer, hook, and both test files; `flushSnapshot` (Task 4) is referenced only within its own file; `dragAbortRef` (Task 5) and `flashTimerRef` (Task 6) are file-local.
- Known harness traps accounted for: jsdom pointer-capture stubs (Tasks 2/5), the `installSigmaStub` window-replacement fix (Task 4 Step 3 — REQUIRED before the hook gains `addEventListener`), StrictMode double-invoke as the failing signal (Task 3), fake-timer count deltas with the git poller made inert via `worktreePath: null` (Task 6), lazily-evaluated `vi.mock` factories with dynamic import (Task 7, proven pattern from the existing integration test).
