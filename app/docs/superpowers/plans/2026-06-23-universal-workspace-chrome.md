# Universal Workspace Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution note (this run):** worker subagents EDIT files + run their scoped tests + report a diff. They do **NOT** `git commit`/`push` and must touch ONLY files under `/Users/aisigma/projects/sl-ws-chrome/app`. The orchestrator integrates, gates, and commits after two-stage review.

**Goal:** Make the main window's UI chrome (sidebar width, right-rail width/open/active-tab, color) universal across workspace switches, while keeping detached "scoped" windows independent and keeping panes/tool-content per-workspace.

**Architecture:** Introduce a window-scope-aware kv helper (`chrome-ui-kv.ts`). In the MAIN window (`getWorkspaceScope()===null`) chrome reads/writes a single GLOBAL key; in a SCOPED window it reads/writes the per-window-scope key `ui.<scope>.<panel>` (preserving #177's no-clobber). Components hydrate ONCE on mount (`[]`) instead of re-running on active-workspace change. Separately, remove the per-workspace "tint" feature so color is driven solely by the already-global Theme.

**Tech Stack:** React + TypeScript (renderer), Vitest + @testing-library/react (jsdom), kv store via `rpc`/`rpcSilent`.

## Global Constraints

- TS `erasableSyntaxOnly`: NO `constructor(private x)` param props, NO enums/namespaces (declare field + assign).
- Renderer `.tsx`/`.ts` tests: `// @vitest-environment jsdom` docblock when DOM is touched; config is node-env + `globals:false` → import `{ describe, it, expect, vi }` from `vitest`; explicit `afterEach(cleanup)`.
- Keep files < 500 lines. Read before edit. Validate input at boundaries (kv values are clamped/validated as today).
- Global kv keys (unchanged values): sidebar width `app.sidebar.width`; rail width `rightRail.width`; rail open `rightRail.open`; rail tab `rightRail.tab`.
- Scope primitive: `getWorkspaceScope()` from `@/renderer/lib/window-context` — `null` in main window, fixed workspace id in a scoped window.
- Workers do NOT commit/push; touch only `/Users/aisigma/projects/sl-ws-chrome/app`.

---

### Task 1: `chrome-ui-kv` window-scope-aware helper

**Files:**
- Create: `app/src/renderer/lib/chrome-ui-kv.ts`
- Test: `app/src/renderer/lib/chrome-ui-kv.test.ts`

**Interfaces:**
- Consumes: `getWorkspaceScope()` (`@/renderer/lib/window-context`); `readWorkspaceUi(ws, panel, legacyGlobalKey?)`, `writeWorkspaceUi(ws, panel, value)`, `workspaceUiKey(ws, panel)` (`@/renderer/lib/workspace-ui-kv`); `rpcSilent.kv.get/set` (`@/renderer/lib/rpc`).
- Produces:
  - `chromeUiKey(globalKey: string, panel: string): string`
  - `readChromeUi(globalKey: string, panel: string): Promise<string | null>`
  - `writeChromeUi(globalKey: string, panel: string, value: string): Promise<void>`

- [ ] **Step 1: Write the failing test** — `app/src/renderer/lib/chrome-ui-kv.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getWorkspaceScopeMock = vi.fn<() => string | null>();
vi.mock('@/renderer/lib/window-context', () => ({
  getWorkspaceScope: () => getWorkspaceScopeMock(),
}));

const readWorkspaceUiMock = vi.fn<(...a: unknown[]) => Promise<string | null>>(
  async () => 'scoped-val',
);
const writeWorkspaceUiMock = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: (...a: unknown[]) => readWorkspaceUiMock(...a),
  writeWorkspaceUi: (...a: unknown[]) => writeWorkspaceUiMock(...a),
  workspaceUiKey: (ws: string, panel: string) => `ui.${ws}.${panel}`,
}));

const kvGetMock = vi.fn<(k: string) => Promise<string | null>>(async () => 'global-val');
const kvSetMock = vi.fn<(k: string, v: string) => Promise<void>>(async () => undefined);
vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: { kv: { get: (...a: [string]) => kvGetMock(...a), set: (...a: [string, string]) => kvSetMock(...a) } },
}));

import { chromeUiKey, readChromeUi, writeChromeUi } from './chrome-ui-kv';

beforeEach(() => vi.clearAllMocks());

describe('chrome-ui-kv — main window (no scope → GLOBAL key)', () => {
  beforeEach(() => getWorkspaceScopeMock.mockReturnValue(null));

  it('chromeUiKey returns the global key', () => {
    expect(chromeUiKey('rightRail.open', 'rightRail.open')).toBe('rightRail.open');
  });

  it('readChromeUi reads the GLOBAL key and never the per-workspace key', async () => {
    const v = await readChromeUi('app.sidebar.width', 'sidebar.width');
    expect(kvGetMock).toHaveBeenCalledWith('app.sidebar.width');
    expect(readWorkspaceUiMock).not.toHaveBeenCalled();
    expect(v).toBe('global-val');
  });

  it('writeChromeUi writes the GLOBAL key', async () => {
    await writeChromeUi('app.sidebar.width', 'sidebar.width', '320');
    expect(kvSetMock).toHaveBeenCalledWith('app.sidebar.width', '320');
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();
  });
});

describe('chrome-ui-kv — scoped window (per-window-scope key)', () => {
  beforeEach(() => getWorkspaceScopeMock.mockReturnValue('ws-a'));

  it('chromeUiKey returns the per-scope key', () => {
    expect(chromeUiKey('rightRail.open', 'rightRail.open')).toBe('ui.ws-a.rightRail.open');
  });

  it('readChromeUi reads the per-scope key with a global fallback', async () => {
    const v = await readChromeUi('rightRail.width', 'rightRail.width');
    expect(readWorkspaceUiMock).toHaveBeenCalledWith('ws-a', 'rightRail.width', 'rightRail.width');
    expect(kvGetMock).not.toHaveBeenCalled();
    expect(v).toBe('scoped-val');
  });

  it('writeChromeUi writes the per-scope key', async () => {
    await writeChromeUi('rightRail.open', 'rightRail.open', 'false');
    expect(writeWorkspaceUiMock).toHaveBeenCalledWith('ws-a', 'rightRail.open', 'false');
    expect(kvSetMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/aisigma/projects/sl-ws-chrome/app && npx vitest run src/renderer/lib/chrome-ui-kv.test.ts`
Expected: FAIL — cannot resolve `./chrome-ui-kv`.

- [ ] **Step 3: Write minimal implementation** — `app/src/renderer/lib/chrome-ui-kv.ts`

```ts
// Window-scope-aware UI-chrome persistence.
//
// The MAIN window's chrome (sidebar width, right-rail width/open/tab) is a
// GLOBAL preference: it must NOT change when the user switches the active
// workspace. A SCOPED (detached-workspace) window is bound to one fixed
// workspace, so its chrome is keyed per-workspace (`ui.<scope>.<panel>`),
// keeping it independent of the main window — preserving the no-clobber
// property from #177 (tools in scoped windows).
//
// Resolution: getWorkspaceScope() is null in the main window (→ global key)
// and the fixed workspace id in a scoped window (→ per-scope key).

import { rpcSilent } from '@/renderer/lib/rpc';
import { getWorkspaceScope } from '@/renderer/lib/window-context';
import { readWorkspaceUi, writeWorkspaceUi, workspaceUiKey } from '@/renderer/lib/workspace-ui-kv';

/** Resolve the kv key for a chrome panel: the global key in the main window,
 *  or the per-window-scope key (`ui.<scope>.<panel>`) in a scoped window. */
export function chromeUiKey(globalKey: string, panel: string): string {
  const scope = getWorkspaceScope();
  return scope ? workspaceUiKey(scope, panel) : globalKey;
}

/** Read chrome state. Main → global key. Scoped → per-scope key with a
 *  read-through fallback to the global key. Null when unset / on error. */
export async function readChromeUi(globalKey: string, panel: string): Promise<string | null> {
  const scope = getWorkspaceScope();
  if (scope) return readWorkspaceUi(scope, panel, globalKey);
  try {
    const v = await rpcSilent.kv.get(globalKey);
    return v ?? null;
  } catch {
    return null;
  }
}

/** Write chrome state. Main → global key. Scoped → per-scope key. Best-effort. */
export async function writeChromeUi(globalKey: string, panel: string, value: string): Promise<void> {
  const scope = getWorkspaceScope();
  if (scope) {
    await writeWorkspaceUi(scope, panel, value);
    return;
  }
  try {
    await rpcSilent.kv.set(globalKey, value);
  } catch {
    /* best-effort — layout persistence is non-critical */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/aisigma/projects/sl-ws-chrome/app && npx vitest run src/renderer/lib/chrome-ui-kv.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Report diff to orchestrator** (orchestrator commits: `feat(chrome): window-scope-aware kv helper`).

---

### Task 2: Sidebar width → global (main-window only)

**Files:**
- Modify: `app/src/renderer/features/sidebar/Sidebar.tsx`
- Test: `app/src/renderer/features/sidebar/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `rpc.kv.get/set` (already imported). Sidebar renders only in the main window (ScopedShell has no Sidebar), so it always uses the global key directly — no `chrome-ui-kv` needed here.
- Produces: nothing for other tasks.

- [ ] **Step 1: Write the failing test** — add to `Sidebar.test.tsx`, inside the `describe('Sidebar — v1.4.8 resize handle (expanded state)')` block (after the existing "applies persisted width" test):

```ts
  it('reads the GLOBAL key even when a workspace is active (universal, not per-workspace)', async () => {
    mockState = {
      ...mockState,
      activeWorkspace: { id: 'ws1', name: 'W', rootPath: '/x', repoMode: 'git' },
    };
    kvGetMock.mockResolvedValue('360');
    const { container } = renderSidebar();
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('360px');
    // Proves it did NOT key by workspace — it read the single global key.
    expect(kvGetMock).toHaveBeenCalledWith('app.sidebar.width');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/aisigma/projects/sl-ws-chrome/app && npx vitest run src/renderer/features/sidebar/Sidebar.test.tsx`
Expected: FAIL — current code calls `readWorkspaceUi('ws1', 'sidebar.width', 'app.sidebar.width')` (per-workspace), so `kvGetMock` is NOT called with `'app.sidebar.width'` (and `readWorkspaceUi` is unmocked here → no '360').

- [ ] **Step 3: Edit `Sidebar.tsx`** — make width global:

1. Delete the import line:
   `import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';`
   (width was its only consumer — verify with `grep -n "readWorkspaceUi\|writeWorkspaceUi" src/renderer/features/sidebar/Sidebar.tsx` → expect zero remaining after edits).
2. Rename the key const for clarity and delete the now-unused panel const:
   - Replace `const APP_SIDEBAR_LEGACY_WIDTH_KEY = 'app.sidebar.width';` and its comment with:
     `// Sidebar width is a GLOBAL preference (universal across workspaces). The`
     `// sidebar renders only in the main window, so a single global key is used.`
     `const APP_SIDEBAR_WIDTH_KEY = 'app.sidebar.width';`
   - Delete `const SIDEBAR_WIDTH_PANEL = 'sidebar.width';` (and its 2-line comment above it).
3. Delete the `wsId` line + its RSP-1 comment (lines ~51-54):
   `// RSP-1 — per-workspace width keying...` + `const wsId = activeWorkspace?.id ?? null;`
   (verify `grep -n "wsId" Sidebar.tsx` → zero remaining; if any non-width use exists, keep `wsId` and only change the width paths.)
4. Replace the hydrate effect (the `useEffect` that reads width) with:

```ts
  // Sidebar width is universal across workspaces — read the global key once on
  // mount (no per-workspace re-hydrate). Detached windows have no Sidebar.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const v = await rpc.kv.get(APP_SIDEBAR_WIDTH_KEY).catch(() => null);
      if (!alive) return;
      const n = Number(v);
      if (Number.isFinite(n) && n >= APP_SIDEBAR_MIN && n <= APP_SIDEBAR_MAX) {
        setSidebarWidth(n);
      } else {
        setSidebarWidth(APP_SIDEBAR_DEFAULT);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
```

5. Replace `persistWidth` with:

```ts
  // Persist under the single global key (best-effort; layout is non-critical).
  const persistWidth = useCallback((value: number) => {
    void rpc.kv.set(APP_SIDEBAR_WIDTH_KEY, String(value)).catch(() => undefined);
  }, []);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aisigma/projects/sl-ws-chrome/app && npx vitest run src/renderer/features/sidebar/Sidebar.test.tsx`
Expected: PASS — existing width tests already assert `app.sidebar.width`; new regression test passes.

- [ ] **Step 5: Report diff to orchestrator** (commit: `fix(sidebar): sidebar width is universal, not per-workspace`).

---

### Task 3: Right-rail width → window-scope-aware

**Files:**
- Modify: `app/src/renderer/features/right-rail/RightRail.tsx`

**Interfaces:**
- Consumes: `readChromeUi`, `writeChromeUi` (Task 1). Constants `KV_WIDTH='rightRail.width'`, `RIGHT_RAIL_WIDTH_PANEL='rightRail.width'` (already in file).
- Produces: nothing for other tasks.

> No component test exists for `RightRail.tsx` (heavy lazy/Suspense tree). Scope resolution is covered by Task 1's `chrome-ui-kv.test.ts`; this task is a thin call-site swap verified by `tsc` + the full suite + live-verify.

- [ ] **Step 1: Edit `RightRail.tsx`**

1. Replace the import `import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';` with:
   `import { readChromeUi, writeChromeUi } from '@/renderer/lib/chrome-ui-kv';`
   (verify `grep -n "readWorkspaceUi\|writeWorkspaceUi" RightRail.tsx` → zero remaining.)
2. Delete the `wsId` selector line `const wsId = useAppStateSelector((s) => s.activeWorkspace?.id ?? null);` and its RSP-1 comment — IF `grep -n "wsId" RightRail.tsx` shows it is only used in the width effect + `handleCommit`. (If used elsewhere, keep it and only change the width paths.)
3. In the width hydrate `useEffect`, replace the read expression:
   ```ts
   const rawWidth = wsId
     ? await readWorkspaceUi(wsId, RIGHT_RAIL_WIDTH_PANEL, KV_WIDTH)
     : await rpc.kv.get(KV_WIDTH).catch(() => null);
   ```
   with:
   ```ts
   const rawWidth = await readChromeUi(KV_WIDTH, RIGHT_RAIL_WIDTH_PANEL);
   ```
   and change the effect dependency array from `[wsId]` to `[]`.
4. Replace `handleCommit` with:
   ```ts
   const handleCommit = useCallback((final: number) => {
     void writeChromeUi(KV_WIDTH, RIGHT_RAIL_WIDTH_PANEL, String(Math.round(final)));
   }, []);
   ```
5. If `rpc` is now unused in the file, drop it from the import; otherwise leave it. (Verify with `grep -n "rpc\." RightRail.tsx`.)

- [ ] **Step 2: Typecheck**

Run: `cd /Users/aisigma/projects/sl-ws-chrome/app && npx tsc -b --pretty false 2>&1 | head -30`
Expected: no new errors in `RightRail.tsx`.

- [ ] **Step 3: Report diff to orchestrator** (commit folded with Task 4 → `fix(right-rail): rail width/open/tab universal in main window, per-scope when detached`).

---

### Task 4: Right-rail open + active-tab → window-scope-aware

**Files:**
- Modify: `app/src/renderer/features/right-rail/RightRailContext.tsx`
- Modify: `app/src/renderer/features/right-rail/RightRailContext.data.ts` (doc comments only)
- Test: `app/src/renderer/features/right-rail/RightRailContext.test.tsx` (rewrite mocks + assertions)

**Interfaces:**
- Consumes: `readChromeUi`, `writeChromeUi` (Task 1). Constants `KV_OPEN='rightRail.open'`, `KV_TAB='rightRail.tab'`, `DEFAULT_TAB`, `VALID_TABS`, `normalizeTabId` (from `RightRailContext.data`).
- Produces: the `RightRailContextValue` (unchanged shape).

- [ ] **Step 1: Rewrite the test** — replace the whole `app/src/renderer/features/right-rail/RightRailContext.test.tsx` with:

```tsx
// @vitest-environment jsdom
//
// Window-scope-aware rail chrome. The component calls readChromeUi/writeChromeUi
// (which resolve main→global / scoped→per-scope; that resolution is unit-tested
// in chrome-ui-kv.test.ts). Here we assert the component calls the helper with
// the right (globalKey, panel) and preserves the StrictMode write-once invariant.

import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const readChromeUiMock = vi.fn<(...a: unknown[]) => Promise<string | null>>(async () => null);
const writeChromeUiMock = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock('@/renderer/lib/chrome-ui-kv', () => ({
  readChromeUi: (...a: unknown[]) => readChromeUiMock(...a),
  writeChromeUi: (...a: unknown[]) => writeChromeUiMock(...a),
}));

import { RightRailProvider } from './RightRailContext';
import { KV_OPEN, KV_TAB, useRightRail, type RightRailContextValue } from './RightRailContext.data';

const ctxRef: { current: RightRailContextValue | null } = { current: null };
function Probe() {
  const value = useRightRail();
  useEffect(() => {
    ctxRef.current = value;
  });
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
  ctxRef.current = null;
  vi.clearAllMocks();
});

describe('RightRailContext — toggleRail KV write hygiene', () => {
  it('toggleRail writes the open key exactly ONCE under StrictMode', async () => {
    renderProvider();
    await act(async () => {});
    writeChromeUiMock.mockClear();

    act(() => {
      ctxRef.current?.toggleRail();
    });

    expect(ctxRef.current?.railOpen).toBe(false);
    expect(writeChromeUiMock).toHaveBeenCalledTimes(1);
    expect(writeChromeUiMock).toHaveBeenCalledWith(KV_OPEN, KV_OPEN, 'false');
  });

  it('a second toggle round-trips back to open and writes "true" once', async () => {
    renderProvider();
    await act(async () => {});
    act(() => {
      ctxRef.current?.toggleRail();
    });
    writeChromeUiMock.mockClear();

    act(() => {
      ctxRef.current?.toggleRail();
    });

    expect(ctxRef.current?.railOpen).toBe(true);
    expect(writeChromeUiMock).toHaveBeenCalledTimes(1);
    expect(writeChromeUiMock).toHaveBeenCalledWith(KV_OPEN, KV_OPEN, 'true');
  });
});

describe('RightRailContext — active tab persistence (window-scope-aware)', () => {
  it('hydrates the active tab via readChromeUi(KV_TAB, KV_TAB)', async () => {
    renderProvider();
    await act(async () => {
      await Promise.resolve();
    });
    expect(readChromeUiMock).toHaveBeenCalledWith(KV_TAB, KV_TAB);
  });

  it('persists tab changes via writeChromeUi(KV_TAB, KV_TAB, tab)', async () => {
    renderProvider();
    await act(async () => {
      await Promise.resolve();
    });
    writeChromeUiMock.mockClear();

    await act(async () => {
      ctxRef.current?.setActiveTab('skills');
    });

    expect(writeChromeUiMock).toHaveBeenCalledWith(KV_TAB, KV_TAB, 'skills');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/aisigma/projects/sl-ws-chrome/app && npx vitest run src/renderer/features/right-rail/RightRailContext.test.tsx`
Expected: FAIL — component still imports/calls `readWorkspaceUi`/`writeWorkspaceUi`; `chrome-ui-kv` mocks are never hit.

- [ ] **Step 3: Edit `RightRailContext.tsx`**

1. Imports: replace
   `import { rpc, rpcSilent } from '@/renderer/lib/rpc';`
   `import { useAppStateSelector } from '@/renderer/app/state';`
   `import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';`
   with the single line:
   `import { readChromeUi, writeChromeUi } from '@/renderer/lib/chrome-ui-kv';`
2. Delete the `const wsId = useAppStateSelector(...)` line + its DEV-W4 comment.
3. Replace the tab hydrate `useEffect` with:
   ```ts
   // Hydrate the active tab. Window-scope-aware: main window → global key;
   // detached/scoped window → its own per-scope key (no clobber, #177).
   useEffect(() => {
     let alive = true;
     void (async () => {
       try {
         const raw = await readChromeUi(KV_TAB, KV_TAB);
         if (!alive) return;
         const normalized = typeof raw === 'string' ? normalizeTabId(raw) : raw;
         if (typeof normalized === 'string' && VALID_TABS.has(normalized as RightRailTabId)) {
           setActiveTabState(normalized as RightRailTabId);
         }
       } catch {
         // kv unavailable — leave at DEFAULT_TAB.
       }
     })();
     return () => {
       alive = false;
     };
   }, []);
   ```
4. Replace the open hydrate `useEffect` with:
   ```ts
   // Hydrate rail open/closed (same window-scope-aware keying as the tab).
   useEffect(() => {
     let alive = true;
     void (async () => {
       try {
         const raw = await readChromeUi(KV_OPEN, KV_OPEN);
         if (!alive) return;
         setRailOpenState(raw === 'false' ? false : true);
       } catch {
         // kv unavailable — leave at default (open).
       }
     })();
     return () => {
       alive = false;
     };
   }, []);
   ```
5. Replace `setActiveTab` with:
   ```ts
   const setActiveTab = useCallback((tab: RightRailTabId) => {
     setActiveTabState(tab);
     void writeChromeUi(KV_TAB, KV_TAB, tab);
   }, []);
   ```
6. Replace `setRailOpen` with:
   ```ts
   const setRailOpen = useCallback((open: boolean) => {
     setRailOpenState(open);
     void writeChromeUi(KV_OPEN, KV_OPEN, String(open));
   }, []);
   ```
   (`toggleRail` and the `useMemo` value stay unchanged.)

- [ ] **Step 4: Edit `RightRailContext.data.ts` doc comments** — change the two JSDoc lines:
   - `/** Explicitly set the rail open/closed state. Persists per-workspace. */`
     → `/** Explicitly set the rail open/closed state. Persists globally (per-window-scope when detached). */`
   - `/** Toggle rail open↔closed. Persists per-workspace. */`
     → `/** Toggle rail open↔closed. Persists globally (per-window-scope when detached). */`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/aisigma/projects/sl-ws-chrome/app && npx vitest run src/renderer/features/right-rail/RightRailContext.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Report diff to orchestrator** (commit with Task 3: `fix(right-rail): rail width/open/tab universal in main window, per-scope when detached`).

---

### Task 5: Remove the per-workspace tint feature (color → universal)

**Files:**
- Delete: `app/src/renderer/app/useWorkspaceTint.ts`, `app/src/renderer/app/useWorkspaceTint.test.tsx`
- Delete: `app/src/renderer/lib/workspace-tint.ts`, `app/src/renderer/lib/workspace-tint.test.ts`
- Delete: `app/src/renderer/features/settings/WorkspaceTintSection.tsx`, `app/src/renderer/features/settings/WorkspaceTintSection.test.tsx`
- Modify: `app/src/renderer/app/App.tsx`, `app/src/renderer/features/settings/AppearanceTab.tsx`

**Interfaces:**
- Consumes: nothing. Produces: nothing. (Pure removal — color now comes solely from the already-global Theme / `ThemeProvider`.)

> Pre-check (run first): `grep -rn "useWorkspaceTint\|WorkspaceTintSection\|workspace-tint\|applyTint\|clearTint\|parseTint\|hexToHslChannels\|WorkspaceTintMount" src` — every hit must be inside the 6 files being deleted OR the 2 files being edited (App.tsx, AppearanceTab.tsx). If any OTHER consumer exists, STOP and report.

- [ ] **Step 1: Delete the 6 tint files**

```bash
cd /Users/aisigma/projects/sl-ws-chrome/app
git rm src/renderer/app/useWorkspaceTint.ts src/renderer/app/useWorkspaceTint.test.tsx \
  src/renderer/lib/workspace-tint.ts src/renderer/lib/workspace-tint.test.ts \
  src/renderer/features/settings/WorkspaceTintSection.tsx src/renderer/features/settings/WorkspaceTintSection.test.tsx
```
(Workers: use `rm` if avoiding git; orchestrator stages the deletion.)

- [ ] **Step 2: Edit `App.tsx`** — remove all tint wiring:
  1. Delete the import: `import { useWorkspaceTint } from '@/renderer/app/useWorkspaceTint';`
  2. Delete the `WorkspaceTintMount` function (the `function WorkspaceTintMount() {…}` block and its `/** BSP-T4 … */` doc comment above it).
  3. Delete the `<WorkspaceTintMount />` JSX line and the `{/* BSP-T4 — per-workspace tint … */}` comment immediately above it.
  4. In the `{/* Multi-window B4 — navigation-bearing globals … */}` comment, change
     `Toaster / ZoomIndicator / NativeRebuildModal / WorkspaceTintMount stay global — they carry no navigation.`
     to `Toaster / ZoomIndicator / NativeRebuildModal stay global — they carry no navigation.`

- [ ] **Step 3: Edit `AppearanceTab.tsx`** — remove the tint section:
  1. Delete the import: `import { WorkspaceTintSection } from './WorkspaceTintSection';`
  2. Delete the line `const activeWorkspaceId = useAppStateSelector((s) => s.activeWorkspaceId);` (it becomes unused once the section is gone — verify no other use with `grep -n "activeWorkspaceId" AppearanceTab.tsx`; if `useAppStateSelector` is now unused, drop it from its import too).
  3. Delete the section + its comment:
     `{/* BSP-T4 — per-workspace tint section. Only rendered when a workspace is active. */}`
     `<WorkspaceTintSection activeWorkspaceId={activeWorkspaceId} />`

- [ ] **Step 4: Typecheck + run the settings/app suites**

```bash
cd /Users/aisigma/projects/sl-ws-chrome/app
npx tsc -b --pretty false 2>&1 | head -30
npx vitest run src/renderer/features/settings src/renderer/app
```
Expected: no TS errors; settings/app tests pass; no references to deleted modules remain (`grep -rn "workspace-tint\|WorkspaceTintSection\|useWorkspaceTint" src` → only stale CSS comments, if any).

- [ ] **Step 5: Report diff to orchestrator** (commit: `feat(theme): remove per-workspace tint — color is universal via global theme`).

> CSS note (orchestrator, optional): the `.sl-chrome-tint` rules in `src/index.css` are now dead (no applier — `grep -rn "sl-chrome-tint" src` returns only index.css). Removing them + the stale `useWorkspaceTint` comment (index.css ~43-45) is safe ONLY if no CSS custom-property definition is deleted. If uncertain, leave as-is and park to wishlist (dead CSS is harmless; nothing applies the class).

---

## Integration & gate (orchestrator)

1. After Task 1/2/5 land → gate touched files. After Task 3/4 land → gate again.
2. Final gate in the worktree: `npx tsc -b` + `npx vitest run` (full) + `npm run lint` + `npm run build`.
3. Regression guard (base-drift): `git diff origin/main...HEAD -- src/renderer/features/right-rail src/renderer/features/sidebar` — confirm scoped-window keying is preserved (scoped path still routes through `ui.<scope>.*`).
4. Defer e2e to CI. Live-verify in Electron only if the operator asks.
5. `finishing-a-development-branch` → PR.

## Self-review (against the spec)

- Spec §A (globalize 3 shell keys) → Tasks 2 (sidebar width), 3 (rail width), 4 (rail open). ✓
- Spec §A active-tab — spec said "already global"; corrected: on `origin/main` the tab is per-workspace. Task 4 globalizes it in the main window, window-scope-aware. ✓ (supersedes the spec line; design re-approved by operator.)
- Spec §B (remove tint) → Task 5. ✓
- Spec §C (back-compat, no destructive cleanup) → orphaned `ui.<wsId>.*` keys ignored; global keys default when missing. ✓
- Window-scope-aware decision (protect #177) → Task 1 helper + Tasks 3/4 use it; scoped windows keep per-scope keys. ✓
- Placeholder scan: every step has concrete code/commands. ✓
- Type consistency: `chromeUiKey/readChromeUi/writeChromeUi` signatures identical across Tasks 1/3/4; `KV_OPEN`/`KV_TAB` from `RightRailContext.data`. ✓
