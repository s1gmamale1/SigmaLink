# Dead-Code Removal (2026-06-10 Audit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove ~470 LOC of zero-importer dead code plus 2 unused prod dependencies (`monaco-editor`, `@radix-ui/react-separator`) from the SigmaLink Electron app, with a re-verify gate before every deletion and a green build gate after every commit.

**Architecture:** Pure subtraction — no behavior changes. Each item was zero-importer-proven at audit HEAD, but the tree moves (multiple concurrent sessions), so EVERY deletion starts with a re-verification `rg` whose expected output is empty (or an exact known set). If a re-verify finds the item LIVE, **skip it, record it in the Execution Log at the bottom of this file, and move on — never force**. The one wiring change is repointing VoiceTab's `SessionStat` type import from the dead `src/main/core/voice/voice-stats.ts` twin to `@sigmalink/voice-core` (which requires adding a one-line type re-export to voice-core's index).

**Tech Stack:** pnpm 11 workspace (root = `app/` — `app/pnpm-workspace.yaml`), Vite + React renderer, esbuild-bundled Electron main, `tsc -b` project refs (all `noEmit: true`), vitest, eslint.

**Not-TDD by nature:** Deletions have no failing-test-first step. The TDD equivalent here is: (1) the verify-`rg` that must come back empty before each removal — that is the "red" proving the code is unreachable — and (2) the post-delete green gate (`npx tsc -b` + targeted `npx vitest run`) proving nothing depended on it. Both are mandatory for every task.

**Gate discipline (the heart of this plan):**
- After EACH deletion commit: `npx tsc -b` + the task's targeted `npx vitest run <path>`.
- Final gate (Task 11): `npx tsc -b` + `npx vitest run` (full) + `npx eslint . --max-warnings 0` + `npm run product:check`.
- `npm run product:check` (= `npm run build && npm run electron:compile`) is NON-NEGOTIABLE in the final gate and in Task 8: **`tsc -b` does NOT compile `electron/main.ts` — only esbuild does.** A past "dead" deletion of `model-registry.ts` broke prod through a green tsc gate.
- NO local e2e (`npx playwright test`) — it launches competing Electron windows on the operator's machine. Defer e2e to CI.
- All commands run from `/Users/aisigma/projects/SigmaLink/app` unless stated otherwise. Git repo root is `/Users/aisigma/projects/SigmaLink`; git commands with `src/...`-relative paths work fine from `app/`.
- If a full-suite vitest run times out under load (swarms/factory, VoiceTab are known flakes), re-run that file in isolation before reacting.

---

## File Structure

**DELETED (7 files, ~462 LOC):**
- `app/src/shared/events.ts` (116) — dead typed-event map, zero importers
- `app/src/components/ui/sheet.tsx` (142) — unused shadcn Sheet
- `app/src/components/ui/separator.tsx` (28) — unused shadcn Separator
- `app/src/hooks/use-mobile.ts` (20) — unused breakpoint hook
- `app/src/components/ui/skeleton.tsx` (13) — unused shadcn Skeleton (App.tsx ships its own local `RoomSkeleton`)
- `app/src/main/core/voice/voice-stats.ts` (87) — runtime-dead twin of `packages/voice-core/src/voice-stats.ts`
- `app/src/main/core/voice/voice-stats.test.ts` (56) — test of the dead twin

**MODIFIED:**
- `app/package.json` — drop `monaco-editor`, `@radix-ui/react-separator` deps
- `app/vite.config.ts` — correct the misleading monaco manualChunks comment
- `app/src/components/ui/overlay-close-button.test.tsx` — remove Sheet reflection block
- `app/src/components/ui/ui-polish.test.tsx` — remove Separator block
- `app/src/renderer/lib/motion.ts` — remove `sheetSideMotion` + `SHEET_SLIDE` (sole consumer was sheet.tsx)
- `app/src/renderer/features/command-room/PaneHeader.tsx` — drop dead `[[data-grid-density=dense]_&]:h-6` selector
- `app/src/renderer/features/command-room/PaneHeader.test.tsx` — drop the matching assertion
- `app/src/renderer/features/command-room/PaneShell.tsx` — remove dead `inSplitGroup` prop
- `app/src/index.css` — remove `.memory-tri-grid` + its `@media` override; fix stale density NOTE
- `app/src/renderer/features/command-room/CommandRoom.tsx` — fix stale GridLayout comment (line 3 only)
- `app/src/renderer/app/state-hooks/use-terminal-cache-gc.ts` — fix stale GridLayout comment (line 32)
- `app/src/renderer/lib/themes.ts` — fix stale GridLayout comment (line 156)
- `app/src/renderer/app/state.reducer.ts` — fix stale GridLayout comment (lines 692-693; the SPLIT_PANE case itself is LIVE)
- `app/src/renderer/features/settings/VoiceTab.tsx` — repoint `SessionStat` type import to `@sigmalink/voice-core`
- `app/packages/voice-core/src/index.ts` — add `SessionStat` type re-export
- `app/packages/voice-core/src/voice-stats.ts` — update stale "mirrors the twin" comment
- `app/src/shared/types.ts` — remove free-standing dead aliases `HlcPacked` + `ProjectId` (the other 10 audit candidates are in-file doc-anchors — KEEP, see Task 9)
- `app/src/main/core/pty/session-disk-scanner.ts` — un-export `DiskScanOptions` / `ListSessionsOptions`

**DELIBERATELY UNTOUCHED:**
- `app/scripts/reapply-ruflo-hook-tuning.cjs` — DECISION: KEEP (one-shot operator tooling, documented in CHANGELOG). No action.
- `app/pnpm-workspace.yaml` — REVERT if pnpm writes an `allowBuilds`/`onlyBuiltDependencies` placeholder into it; never approve node-pty builds.
- `app/pnpm-lock.yaml` — gitignored (root `.gitignore:123`); never stage it.
- Everything in `app/src/main/core/voice/` EXCEPT the two voice-stats files — **that tree is LIVE** (`src/main/rpc-router.ts:113,122` imports `./core/voice/adapter` + `./core/voice/diagnostics`; `electron/main.ts:18,230,250` imports `../src/main/core/voice/model-registry`).

---

### Task 0: Workspace setup + baseline gate

The shared checkout runs MANY concurrent sessions and currently carries uncommitted WIP (at audit time: `src/index.css`, `src/main/core/assistant/*`, `ChatTranscript*`, `pane-identity.ts`, `workspace-color.ts`, untracked `src/shared/agent-identity*`). Two execution modes; **Option A is strongly preferred**.

**Files:** none (environment only)

- [ ] **Step 1: Create an isolated worktree off origin/main (Option A, preferred)**

```bash
cd /Users/aisigma/projects/SigmaLink
git fetch origin
git worktree add -b chore/dead-code-2026-06-10 ../SigmaLink-deadcode origin/main
cd ../SigmaLink-deadcode/app
pnpm install
```

Notes:
- If `pnpm install` prompts about build scripts (node-pty, electron, etc.), do NOT approve new builds interactively; if it writes an `allowBuilds`/`onlyBuiltDependencies` placeholder into `pnpm-workspace.yaml`, revert that file (`git checkout -- pnpm-workspace.yaml`) before any commit.
- Do NOT use `--ignore-scripts` — it breaks electron-importing vitest. If electron's postinstall did not run, run `node node_modules/electron/install.js`.
- All subsequent task commands run from `/Users/aisigma/projects/SigmaLink-deadcode/app` in this mode.

**Option B (fallback, only if a worktree install is impossible):** work in `/Users/aisigma/projects/SigmaLink/app` on a new branch off `origin/main`. Then: stage ONLY the exact files named in each task's commit step (never `git add -A`, never `git commit -a`), and **SKIP Task 6 entirely if `git diff --stat src/index.css` shows unrelated uncommitted hunks** (another session's WIP — you cannot cleanly stage around it without interactive `git add -p`). Record the skip in the Execution Log.

- [ ] **Step 2: Baseline gate — confirm the tree is green BEFORE deleting anything**

```bash
npx tsc -b && npx vitest run
```

Expected: both pass. If the baseline is already red, STOP and report — do not start deleting on a red base.

---

### Task 1: Remove unused `monaco-editor` dependency + fix the misleading vite comment

`@monaco-editor/react` (the live EditorTab dependency, lazy-imported at `src/renderer/features/editor/EditorTab.tsx:51`) defaults to its CDN loader — it never imports the local `monaco-editor` package. The vite `manualChunks` comment implies monaco is bundled; only `@monaco-editor/react` ever matches `id.includes('monaco')`.

**Files:**
- Modify: `app/package.json` (line 62: `"monaco-editor": "^0.55.1"`)
- Modify: `app/vite.config.ts` (lines 31-33)

- [ ] **Step 1: Re-verify zero local monaco-editor imports and no loader.config**

```bash
rg -n "from ['\"]monaco-editor|require\(['\"]monaco-editor|import\(['\"]monaco-editor" src/ electron/ packages/ tests/ scripts/
rg -n "loader\.config|loader\.init" src/ electron/ packages/ tests/
```

Expected: BOTH empty (exit 1). If `loader.config` appears anywhere pointing at a local monaco path, the dep is LIVE — skip this task, log it.

- [ ] **Step 2: Confirm `@monaco-editor/react` stays (it is the live dep)**

```bash
rg -n "@monaco-editor/react" src/ package.json
```

Expected: hits in `package.json:32`, `src/renderer/features/editor/EditorTab.tsx:51`, `src/renderer/features/editor/EditorTab.test.tsx`. Do NOT touch these.

- [ ] **Step 3: Remove the dep**

The pnpm workspace root IS `app/` (`app/pnpm-workspace.yaml` exists). pnpm 11 requires `-w` to modify root-manifest deps from the workspace root:

```bash
pnpm remove -w monaco-editor
```

If pnpm rejects `-w` here (behavior varies by version), fall back to plain `pnpm remove monaco-editor`. Expected result either way: `"monaco-editor": "^0.55.1"` gone from `package.json` dependencies.

- [ ] **Step 4: Check for pnpm side-effect writes and revert them**

```bash
git status --porcelain
git diff pnpm-workspace.yaml
```

Expected dirty files: `package.json` only (`pnpm-lock.yaml` is gitignored). If `pnpm-workspace.yaml` was touched (e.g. an `allowBuilds:`/`onlyBuiltDependencies:` placeholder), revert it:

```bash
git checkout -- pnpm-workspace.yaml
```

Do NOT approve node-pty (or any) build scripts as part of this removal.

- [ ] **Step 5: Correct the misleading vite comment**

In `app/vite.config.ts`, replace:

```ts
            // Keep Monaco isolated and lazy: never route it into a vendor
            // bucket — let Vite's dynamic-import code-splitting own it.
            if (id.includes('monaco')) return undefined;
```

with:

```ts
            // Keep @monaco-editor/react (the CDN-loader shim) isolated and
            // lazy: never route it into a vendor bucket — let Vite's
            // dynamic-import code-splitting own it. NOTE: `monaco-editor`
            // itself is NOT bundled — the editor core loads from the
            // loader's CDN at runtime, so this matcher only ever sees the
            // @monaco-editor/react shim.
            if (id.includes('monaco')) return undefined;
```

(The `if` line stays — it still correctly keeps the shim out of vendor buckets.)

- [ ] **Step 6: Gate**

```bash
npx tsc -b && npx vitest run src/renderer/features/editor/
```

Expected: PASS (EditorTab tests prove the CDN-loader path still typechecks/mocks fine).

- [ ] **Step 7: Commit**

```bash
git add package.json vite.config.ts
git commit -m "chore(dead-code): remove unused monaco-editor dep; clarify vite monaco chunk comment"
```

---

### Task 2: shadcn/boilerplate sweep — events.ts, sheet.tsx, separator.tsx, use-mobile.ts, skeleton.tsx (~319 LOC)

Five zero-(production)-importer modules. Per-file: verify, then delete, then a cheap incremental gate; one commit at the end. AUDIT CORRECTION discovered at plan time: `sheet.tsx` has ONE importer — `overlay-close-button.test.tsx` reflection-imports it for class-string assertions — so that test's Sheet block goes too. Same pattern for `separator.tsx` (`ui-polish.test.tsx:146-156`). Keep `@radix-ui/react-dialog` (dialog.tsx is live); remove `@radix-ui/react-separator`.

**Files:**
- Delete: `app/src/shared/events.ts`, `app/src/components/ui/sheet.tsx`, `app/src/components/ui/separator.tsx`, `app/src/hooks/use-mobile.ts`, `app/src/components/ui/skeleton.tsx`
- Modify: `app/src/components/ui/overlay-close-button.test.tsx`, `app/src/components/ui/ui-polish.test.tsx`, `app/src/renderer/lib/motion.ts`, `app/package.json`

- [ ] **Step 1: Verify + delete `src/shared/events.ts`**

```bash
rg -n "shared/events|from ['\"]\./events['\"]|from ['\"]\.\./shared/events" src/ electron/ packages/ tests/ scripts/
```

Expected: empty (exit 1). Then:

```bash
git rm src/shared/events.ts
npx tsc -b
```

Expected: tsc green. (A live typed-events implementation exists elsewhere; this module was an orphaned duplicate of the event-name vocabulary.)

- [ ] **Step 2: Verify `sheet.tsx` importers**

```bash
rg -n "ui/sheet|from ['\"]\./sheet['\"]|SheetModule|SheetContent|SheetTrigger" src/ electron/ packages/ tests/
```

Expected: hits ONLY in `src/components/ui/sheet.tsx` itself and `src/components/ui/overlay-close-button.test.tsx` (lines ~8-9, 31, 34, 66-91). ANY other hit = sheet is live → skip Steps 3-5, log it.

- [ ] **Step 3: Strip the Sheet block from `overlay-close-button.test.tsx`**

Three edits:

(a) Replace the header assertion list (lines 5-12):

```ts
// Asserts that:
//   1. Dialog close button uses the STANDARD focus-visible:ring-[3px] pattern
//   2. Dialog close button does NOT use the legacy ring-offset-2 pattern
//   3. Sheet close button uses the STANDARD focus-visible:ring-[3px] pattern
//   4. Sheet close button does NOT use the legacy ring-offset-2 pattern
//   5. Both carry opacity-70 / hover:opacity-100
//   6. Both carry hover:bg-foreground/[0.07] ghost-on-glass token
//   7. DialogFooter uses flex-col-reverse / sm:flex-row / sm:justify-end ordering
```

with:

```ts
// Asserts that:
//   1. Dialog close button uses the STANDARD focus-visible:ring-[3px] pattern
//   2. Dialog close button does NOT use the legacy ring-offset-2 pattern
//   3. It carries opacity-70 / hover:opacity-100
//   4. It carries hover:bg-foreground/[0.07] ghost-on-glass token
//   5. DialogFooter uses flex-col-reverse / sm:flex-row / sm:justify-end ordering
```

(b) Delete the import line 31 and the derived const line 34:

```ts
import * as SheetModule from './sheet';
```

```ts
const sheetContentSrc = SheetModule.SheetContent.toString();
```

(c) Delete the whole `describe('Sheet close button — focus-ring', ...)` block (lines 66-91):

```ts
describe('Sheet close button — focus-ring', () => {
  it('carries focus-visible:ring-[3px]', () => {
    expect(sheetContentSrc).toContain('focus-visible:ring-[3px]');
  });

  it('does NOT carry legacy ring-offset-2', () => {
    expect(sheetContentSrc).not.toContain('ring-offset-2');
  });

  it('carries focus-visible:ring-ring/50', () => {
    expect(sheetContentSrc).toContain('focus-visible:ring-ring/50');
  });

  it('carries focus-visible:border-ring', () => {
    expect(sheetContentSrc).toContain('focus-visible:border-ring');
  });

  it('carries opacity-70 and hover:opacity-100', () => {
    expect(sheetContentSrc).toContain('opacity-70');
    expect(sheetContentSrc).toContain('hover:opacity-100');
  });

  it('carries ghost-on-glass hover token', () => {
    expect(sheetContentSrc).toContain('hover:bg-foreground/[0.07]');
  });
});
```

- [ ] **Step 4: Delete `sheet.tsx`**

```bash
git rm src/components/ui/sheet.tsx
```

- [ ] **Step 5: Remove the now-orphaned `sheetSideMotion` from motion.ts**

sheet.tsx was the SOLE consumer of `sheetSideMotion` (`src/renderer/lib/motion.ts:73`). (`overlayScrimMotion`, which sheet.tsx also imported, stays — dialog.tsx and alert-dialog.tsx use it.) Verify, then delete:

```bash
rg -n "sheetSideMotion" src/ electron/ packages/ tests/
```

Expected after Step 4: the only hits are the definition in `src/renderer/lib/motion.ts`. Then delete this entire block from `motion.ts` (lines ~55-77 — comment + const + function):

```ts
/**
 * Edge sheets — full-surface directional slide keyed off the
 * resolved side. Enter rides the snappy spring at the slow budget (350ms)
 * so a large surface settles with weight; exit is quicker + smooth.
 *
 * Radix `react-dialog` (Sheet) exposes the side via our own conditional
 * classes, so we key on `data-[state]`.
 */
const SHEET_SLIDE: Record<"top" | "right" | "bottom" | "left", string> = {
  right:
    "data-[state=open]:animate-sl-slide-in-right data-[state=closed]:animate-sl-slide-out-right",
  left: "data-[state=open]:animate-sl-slide-in-left data-[state=closed]:animate-sl-slide-out-left",
  top: "data-[state=open]:animate-sl-slide-in-top data-[state=closed]:animate-sl-slide-out-top",
  bottom:
    "data-[state=open]:animate-sl-slide-in-bottom data-[state=closed]:animate-sl-slide-out-bottom",
};

/** Slide animation for a Radix-dialog-backed Sheet on a given side. */
export function sheetSideMotion(
  side: "top" | "right" | "bottom" | "left"
): string {
  return SHEET_SLIDE[side];
}
```

(The `animate-sl-slide-*` keyframes in CSS may now be orphaned too — do NOT chase that chain here; note it in the Execution Log for the wishlist.)

```bash
npx tsc -b
```

Expected: green.

- [ ] **Step 6: Verify + remove `separator.tsx` and its test block**

```bash
rg -n "ui/separator|react-separator|from ['\"]\./separator['\"]" src/ electron/ packages/ tests/
```

Expected: hits ONLY in `src/components/ui/separator.tsx` itself and `src/components/ui/ui-polish.test.tsx` (line ~148). Then edit `ui-polish.test.tsx`:

(a) Line 3 comment: replace

```ts
// Stage-3 UI polish — tabs, badge, card, and separator class assertions.
```

with

```ts
// Stage-3 UI polish — tabs, badge, and card class assertions.
```

(b) Delete the trailing Separator section (lines 146-156, end of file):

```ts
// ---- Separator --------------------------------------------------------------

import { Separator } from './separator';

describe('Separator — bg-border token', () => {
  it('uses bg-border', () => {
    const { container } = render(<Separator />);
    const sep = container.querySelector('[data-slot="separator"]') as HTMLElement;
    expect(sep.className).toContain('bg-border');
  });
});
```

Then:

```bash
git rm src/components/ui/separator.tsx
pnpm remove -w @radix-ui/react-separator
git diff pnpm-workspace.yaml   # revert if pnpm touched it (same rule as Task 1 Step 4)
npx tsc -b
```

Expected: `@radix-ui/react-separator` gone from `package.json:41`; tsc green. (KEEP `@radix-ui/react-dialog` — `dialog.tsx` is live.)

- [ ] **Step 7: Verify + delete `use-mobile.ts`**

```bash
rg -n "use-mobile|useIsMobile" src/ electron/ packages/ tests/
```

Expected: hits only inside `src/hooks/use-mobile.ts` itself. Then:

```bash
git rm src/hooks/use-mobile.ts
```

- [ ] **Step 8: Verify + delete `skeleton.tsx`**

```bash
rg -n "ui/skeleton|from ['\"]\./skeleton['\"]" src/ electron/ packages/ tests/
rg -nw "Skeleton" src/ electron/ packages/ tests/
```

Expected: first command — hits only inside `src/components/ui/skeleton.tsx`; second command — only `skeleton.tsx` itself (`App.tsx:69`'s `RoomSkeleton` is a different word and a separate local component — it does NOT match `-w "Skeleton"` and must NOT be touched). Then:

```bash
git rm src/components/ui/skeleton.tsx
```

- [ ] **Step 9: Task gate**

```bash
npx tsc -b && npx vitest run src/components/ui/
```

Expected: PASS — `overlay-close-button.test.tsx` (Dialog blocks only) and `ui-polish.test.tsx` (tabs/badge/card) green.

- [ ] **Step 10: Commit**

```bash
git add package.json src/components/ui/overlay-close-button.test.tsx src/components/ui/ui-polish.test.tsx src/renderer/lib/motion.ts
git commit -m "chore(dead-code): delete zero-importer modules — events.ts, sheet, separator, use-mobile, skeleton (+ orphaned sheetSideMotion, @radix-ui/react-separator dep)"
```

(`git rm` already staged the deletions.)

---

### Task 3: PaneHeader — drop the always-false `data-grid-density` dense variant

The `data-grid-density` attribute setter died with GridLayout (retired in the PaneGrid pivot, commit `75245bd`); nothing sets it anymore, so `[[data-grid-density=dense]_&]:h-6` can never match. The test at `PaneHeader.test.tsx:284` asserts the dead literal.

**Files:**
- Modify: `app/src/renderer/features/command-room/PaneHeader.tsx:204`
- Modify: `app/src/renderer/features/command-room/PaneHeader.test.tsx:278-286`

- [ ] **Step 1: Re-verify no setter exists**

```bash
rg -n "data-grid-density" src/ electron/ packages/ tests/
```

Expected: exactly 4 hits, ALL passive — `PaneHeader.tsx:204` (the selector), `PaneHeader.test.tsx:284` (the assertion), `src/renderer/lib/themes.ts:156` (comment), `src/index.css:150` (comment). If ANY hit is a setter (`setAttribute`, a JSX `data-grid-density={...}` attribute, or `dataset.gridDensity`), the variant is LIVE → skip, log it.

- [ ] **Step 2: Remove the selector from PaneHeader.tsx:204**

Replace the className:

```ts
      <div className="sl-glass-toolbar flex h-7 items-center gap-1.5 border-b border-border px-2 pt-[2px] text-[length:calc(11px*var(--pane-font-scale,1))] [[data-grid-density=dense]_&]:h-6">
```

with:

```ts
      <div className="sl-glass-toolbar flex h-7 items-center gap-1.5 border-b border-border px-2 pt-[2px] text-[length:calc(11px*var(--pane-font-scale,1))]">
```

- [ ] **Step 3: Fix the test (keep the h-7 assertion, drop the dead-literal one)**

In `PaneHeader.test.tsx` replace:

```ts
  it('carries h-7 + dense variant on the toolbar strip', () => {
    const { getByTestId } = render(<PaneHeader {...baseProps()} />);
    const header = getByTestId('pane-header');
    const strip = header.querySelector('.sl-glass-toolbar') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(strip.className).toMatch(/\bh-7\b/);
    expect(strip.className).toMatch(/\[\[data-grid-density=dense\]_&\]:h-6/);
  });
```

with:

```ts
  it('carries h-7 on the toolbar strip', () => {
    const { getByTestId } = render(<PaneHeader {...baseProps()} />);
    const header = getByTestId('pane-header');
    const strip = header.querySelector('.sl-glass-toolbar') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(strip.className).toMatch(/\bh-7\b/);
  });
```

- [ ] **Step 4: Gate**

```bash
npx tsc -b && npx vitest run src/renderer/features/command-room/PaneHeader.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/command-room/PaneHeader.tsx src/renderer/features/command-room/PaneHeader.test.tsx
git commit -m "chore(dead-code): drop always-false data-grid-density dense variant from PaneHeader (+ stale test assertion)"
```

---

### Task 4: PaneShell — remove the dead `inSplitGroup` prop

No caller passes `inSplitGroup` (the `SplitGroupCell` that set it was deleted with GridLayout), so it is always `false` and `canSplit` is always `true`. PaneHeader's `canSplit` prop already defaults to `true` (`PaneHeader.tsx:96`), so the pass-through line can simply be deleted.

**COORDINATION (read before executing):** the sibling plan `terminal-cache-scratch-lifecycle` performs major PaneShell surgery. Execute this task AFTER that plan has landed (or in the same integration window with the same owner). If PaneShell at execution time differs materially from the line numbers below, re-locate by symbol (`rg -n "inSplitGroup" …`) — the edit is the same.

**Files:**
- Modify: `app/src/renderer/features/command-room/PaneShell.tsx` (lines ~64-70, 91, 408)

- [ ] **Step 1: Re-verify no caller passes the prop**

```bash
rg -n "inSplitGroup" src/ electron/ packages/ tests/
rg -n "SplitGroupCell" src/ electron/ packages/ tests/
```

Expected: `inSplitGroup` only inside `PaneShell.tsx` (definition/destructure/usage — no JSX call-site `inSplitGroup={...}` anywhere else); `SplitGroupCell` only in comments (`PaneShell.tsx:67`, `CommandRoom.tsx:33`). Any call-site hit = LIVE → skip, log it.

- [ ] **Step 2: Remove the destructure + stale comment block (lines 64-70)**

Delete:

```ts
  /**
   * v1.4.3 #06 — When the pane is in a split group, the Split-H/V icons are
   * disabled (max 2-level deep in v1.4.x). The CommandRoom passes this true
   * for sub-panes via `SplitGroupCell`. Defaults to false for the standalone
   * pane case.
   */
  inSplitGroup = false,
```

- [ ] **Step 3: Remove the prop type (line 91)**

Delete:

```ts
  inSplitGroup?: boolean;
```

- [ ] **Step 4: Remove the pass-through (line 408)**

Delete the line:

```ts
        canSplit={!inSplitGroup}
```

entirely — do NOT replace it with `canSplit={true}`; PaneHeader defaults `canSplit = true` (`PaneHeader.tsx:96`), and the existing test at `PaneHeader.test.tsx:275` covers the `canSplit={false}` disabled path independently.

- [ ] **Step 5: Gate**

```bash
npx tsc -b && npx vitest run src/renderer/features/command-room/
```

Expected: PASS. (`noUnusedLocals`/`noUnusedParameters` are on — tsc will catch a leftover reference.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/features/command-room/PaneShell.tsx
git commit -m "chore(dead-code): remove dead inSplitGroup prop from PaneShell (SplitGroupCell retired with GridLayout)"
```

---

### Task 5: voice-stats — repoint VoiceTab's type import, delete the dead twin

`src/main/core/voice/voice-stats.ts` is a runtime-dead duplicate of `packages/voice-core/src/voice-stats.ts` (the LIVE write-side, used by `global-capture.ts`). The only thing keeping the twin alive is `VoiceTab.tsx:23` type-importing `SessionStat` from it. AUDIT CORRECTION found at plan time: voice-core's `index.ts` does NOT yet export `SessionStat` — a one-line type re-export must be added first.

⚠️ **HARD WARNING:** the `src/main/core/voice/` TREE is LIVE — `src/main/rpc-router.ts:113,122` (adapter, diagnostics) and `electron/main.ts:18,230,250` (model-registry). Touch ONLY `voice-stats.ts` + `voice-stats.test.ts`. **`tsc -b` does NOT compile `electron/main.ts` (only esbuild does), so this task's gate MUST include `npm run product:check`** — a past deletion of model-registry.ts as "dead" broke prod through a green tsc gate.

**Files:**
- Modify: `app/packages/voice-core/src/index.ts` (add export)
- Modify: `app/packages/voice-core/src/voice-stats.ts` (stale comment, lines 3-9)
- Modify: `app/src/renderer/features/settings/VoiceTab.tsx:23`
- Delete: `app/src/main/core/voice/voice-stats.ts`, `app/src/main/core/voice/voice-stats.test.ts`

- [ ] **Step 1: Re-verify the importer set of the dead twin**

```bash
rg -n "core/voice/voice-stats" src/ electron/ packages/ tests/ scripts/
rg -n "from ['\"]\./voice-stats" src/main/core/voice/
```

Expected: exactly (a) `src/renderer/features/settings/VoiceTab.tsx:23` (the type import we are repointing), (b) the twin's own test `src/main/core/voice/voice-stats.test.ts`, (c) a prose mention in `packages/voice-core/src/voice-stats.ts:7` (comment, not an import — updated in Step 3). The second command must show NO sibling in `src/main/core/voice/` (adapter/dispatcher/etc.) importing `./voice-stats`. Any runtime importer = LIVE → skip, log it.

- [ ] **Step 2: Add the type re-export to voice-core's public API**

In `app/packages/voice-core/src/index.ts`, after the Model-registry export section (after the `export type { ModelEntry, DownloadProgress, ProgressCallback } from './model-registry.js';` block), add:

```ts
// ── Voice usage stats (C-10a) ──────────────────────────────────────────────
export type { SessionStat } from './voice-stats.js';
```

- [ ] **Step 3: Update the now-stale "mirrors the twin" comment in voice-core**

In `app/packages/voice-core/src/voice-stats.ts`, replace lines 3-9:

```ts
// Pure helpers; no Electron or native deps. The KV accessor interface is the
// same synchronous { get, set } shape used throughout global-capture.ts so
// these functions can be called from the capture controller without any async
// overhead. Mirrors the renderer-read counterpart in
// `app/src/main/core/voice/voice-stats.ts` (same KV key + SessionStat shape);
// voice-core is self-contained and cannot import from `app/src`, so the pure
// logic is duplicated here for the WRITE side of the dashboard.
```

with:

```ts
// Pure helpers; no Electron or native deps. The KV accessor interface is the
// same synchronous { get, set } shape used throughout global-capture.ts so
// these functions can be called from the capture controller without any async
// overhead. Single home for the SessionStat shape — the renderer (VoiceTab)
// type-imports `SessionStat` from `@sigmalink/voice-core`; the old read-side
// duplicate in `app/src/main/core/voice/voice-stats.ts` was deleted
// (2026-06-10 dead-code sweep).
```

- [ ] **Step 4: Repoint VoiceTab's import**

In `app/src/renderer/features/settings/VoiceTab.tsx`, replace line 23:

```ts
import type { SessionStat } from '@/main/core/voice/voice-stats';
```

with:

```ts
import type { SessionStat } from '@sigmalink/voice-core';
```

(`@sigmalink/voice-core` is already a `workspace:*` dep of `app/package.json:46`; the package's `exports` map points at TS source, and `moduleResolution: "bundler"` resolves it. It MUST stay `import type` — no runtime voice-core code in the renderer bundle. Fallback if the renderer project somehow cannot resolve the package at typecheck: declare the 4-field shape locally in VoiceTab instead — `interface SessionStat { words: number; durationMs: number; wpm: number; timestamp?: number }` — and log the fallback.)

- [ ] **Step 5: Typecheck the repoint BEFORE deleting**

```bash
npx tsc -b
```

Expected: green with both old and new modules present (proves the new path resolves before the old one is removed).

- [ ] **Step 6: Delete the twin + its test — and NOTHING else in that directory**

```bash
git rm src/main/core/voice/voice-stats.ts src/main/core/voice/voice-stats.test.ts
git status --porcelain -- src/main/core/voice/
```

Expected `git status` output: exactly two `D ` lines (voice-stats.ts, voice-stats.test.ts). If anything else under `src/main/core/voice/` shows as modified/deleted, STOP and restore it.

- [ ] **Step 7: Gate — including product:check (mandatory here)**

```bash
npx tsc -b
npx vitest run src/renderer/features/settings/ packages/voice-core/src/voice-stats.test.ts
npm run product:check
```

Expected: all PASS. `product:check` runs the vite build (renderer resolves `@sigmalink/voice-core`) AND `electron:compile` (esbuild proves `electron/main.ts`'s `model-registry` imports are intact). If the vitest filter matches no files for the voice-core path (outside the include globs), run just `npx vitest run src/renderer/features/settings/` — the voice-core file is unchanged logic-wise.

- [ ] **Step 8: Commit**

```bash
git add packages/voice-core/src/index.ts packages/voice-core/src/voice-stats.ts src/renderer/features/settings/VoiceTab.tsx
git commit -m "chore(dead-code): delete dead main-process voice-stats twin; VoiceTab SessionStat now types from @sigmalink/voice-core"
```

---

### Task 6: index.css — remove `.memory-tri-grid` + fix the stale density NOTE

Zero consumers of `.memory-tri-grid` anywhere. ⚠️ **WIP HAZARD:** `src/index.css` carries uncommitted concurrent-session WIP in the main checkout — this plan is written against COMMITTED state (block at lines 619-630 at audit HEAD). In the Option-A worktree the tree is clean and this is a non-issue. In Option B: if `git diff src/index.css` shows ANY unrelated hunks, SKIP this whole task and log it (see Task 0 Step 1).

**Files:**
- Modify: `app/src/index.css` (two comment/rule blocks)

- [ ] **Step 1: Re-verify zero consumers and re-locate the lines**

```bash
rg -n "memory-tri-grid" src/ electron/ packages/ tests/
git diff --stat src/index.css
```

Expected: hits ONLY in `src/index.css` itself (2: the class + the @media override). Re-locate by grep, not by line number — the file moves.

- [ ] **Step 2: Delete the rule block (committed lines ~619-630)**

Delete exactly:

```css
/* Memory room three-column → single-column collapse. Kept here because
   Tailwind's arbitrary-variant breakpoints can't override an inline
   gridTemplateColumns style at runtime. */
.memory-tri-grid {
  grid-template-columns: 260px 1fr 280px;
}
@media (max-width: 900px) {
  .memory-tri-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 3: Fix the stale GridLayout density NOTE (~lines 145-150) — discovered sibling of Task 3**

After Task 3, nothing references `data-grid-density` at all. In the `--space-scale` comment, replace:

```css
       density-is-a-feature — never loosen further). The `--space-*`
       tokens are derived from the scale so any surface that opts in
       tightens uniformly across the app.

       NOTE: distinct from GridLayout's auto-derived per-grid tier, which
       now lives on `data-grid-density` to avoid colliding with this. */
```

with:

```css
       density-is-a-feature — never loosen further). The `--space-*`
       tokens are derived from the scale so any surface that opts in
       tightens uniformly across the app. */
```

- [ ] **Step 4: Gate** (CSS is outside tsc; the build is the checker — defer the full build to Task 11, do a cheap sanity gate here)

```bash
rg -n "memory-tri-grid|data-grid-density" src/index.css
npx tsc -b
```

Expected: rg empty; tsc green (unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/index.css
git commit -m "chore(dead-code): drop unused .memory-tri-grid CSS + stale data-grid-density NOTE"
```

---

### Task 7: Stale GridLayout comments (comment-only edits, zero code changes)

GridLayout was retired in the PaneGrid pivot (`75245bd`); four comments still describe it as live. **Comment-only:** verify each diff hunk touches no executable line.

**Files:**
- Modify: `app/src/renderer/features/command-room/CommandRoom.tsx:3`
- Modify: `app/src/renderer/app/state-hooks/use-terminal-cache-gc.ts:32` (NOTE: audit said `command-room/`; the file actually lives in `src/renderer/app/state-hooks/`)
- Modify: `app/src/renderer/lib/themes.ts:156`
- Modify: `app/src/renderer/app/state.reducer.ts:692-693`

- [ ] **Step 1: Re-verify the stale mentions**

```bash
rg -n "GridLayout" src/ electron/ packages/ tests/
```

Expected: comment-only hits, including the four below. Hits that are accurate-historical ("retired with GridLayout…", e.g. `CommandRoom.tsx:33`, `PaneShell` history notes) are KEPT — only fix comments that claim GridLayout is the live mechanism.

- [ ] **Step 2: CommandRoom.tsx line 3** — replace:

```ts
// Renders the per-workspace agent sessions inside a generic <GridLayout>.
```

with:

```ts
// Renders the per-workspace agent sessions inside the <PaneGrid> fill-grid.
```

(Line 33's "retired with GridLayout/SplitGroupCell" is accurate history — KEEP. `PaneGrid` is the live component: `CommandRoom.tsx:18` imports it, `:421` renders it.)

- [ ] **Step 3: use-terminal-cache-gc.ts line 32** — in the comment block:

```ts
    // Walk every per-workspace session list. The flat `state.sessions`
    // array exists too, but the per-workspace map is the source of truth
    // GridLayout / SessionTerminal subscribe to.
```

replace the last line with:

```ts
    // PaneGrid / SessionTerminal subscribe to.
```

- [ ] **Step 4: themes.ts line 156** — delete this single line from the `DensityId` doc comment (the mechanism it contrasts against no longer exists after Task 3):

```ts
 * Distinct from GridLayout's auto-derived per-grid tier (`data-grid-density`).
```

- [ ] **Step 5: state.reducer.ts lines 692-693** — the `SPLIT_PANE` case is LIVE; comment fix only. Replace:

```ts
      // v1.4.3 #06 — Annotate the parent (splitIndex 0) AND insert the new
      // sub-pane (splitIndex 1) in a single dispatch so the GridLayout sees
      // both panes in the same render pass. Without this, ADD_SESSIONS would
```

with:

```ts
      // v1.4.3 #06 — Annotate the parent (splitIndex 0) AND insert the new
      // sub-pane (splitIndex 1) in a single dispatch so the pane grid sees
      // both panes in the same render pass. Without this, ADD_SESSIONS would
```

- [ ] **Step 6: Gate + verify comment-only**

```bash
git diff --stat
git diff | grep -E "^[+-]" | grep -vE "^[+-]{3}|^[+-]\s*(//|\*|/\*)" ; echo "exit=$? (1 = comment-only, good)"
npx tsc -b
```

Expected: 4 files changed; the grep finds no non-comment changed lines (exit 1); tsc green.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/features/command-room/CommandRoom.tsx src/renderer/app/state-hooks/use-terminal-cache-gc.ts src/renderer/lib/themes.ts src/renderer/app/state.reducer.ts
git commit -m "chore(dead-code): fix stale GridLayout comments — PaneGrid is the live grid"
```

---

### Task 8: shared/types.ts — remove free-standing dead aliases (expected: `HlcPacked` + `ProjectId` only)

The audit flagged 12 exported types with zero EXTERNAL refs. Plan-time verification adds the in-file dimension: 10 of the 12 are used as field-type doc-anchors INSIDE live interfaces in the same file (e.g. `MemoryId` annotates 7 fields, `SwarmId` 4, `SessionId` 2). Per the audit's own rule — **SKIP doc-anchors and brand-type building blocks others alias** — those 10 are KEEP. Only `HlcPacked` and `ProjectId` have zero external AND zero in-file refs.

**Files:**
- Modify: `app/src/shared/types.ts` (line 5 and lines ~700-701)

- [ ] **Step 1: Per-symbol re-verify (run the full loop — the tree moves; trust the data, not this plan)**

```bash
for T in HlcPacked MemoryId NotificationKind PaneLaunchMode ProjectId RepoMode SessionId SkillId SwarmAgentId SwarmId SwarmStatus TaskId; do
  EXT=$(rg -n "\b$T\b" src/ electron/ packages/ tests/ scripts/ | grep -v "^src/shared/types.ts" | wc -l | tr -d ' ')
  INF=$(rg -n "\b$T\b" src/shared/types.ts | grep -v "export type $T" | wc -l | tr -d ' ')
  echo "$T: external=$EXT in-file=$INF"
done
```

Expected at plan time: `external=0` for all 12; `in-file=0` ONLY for `HlcPacked` and `ProjectId`. Decision rule: **delete a symbol only if external=0 AND in-file=0.** Everything with in-file>0 is a doc-anchor in a live interface — KEEP, list in the Execution Log as "kept: doc-anchor". If a symbol now has external refs, it went live — KEEP, log it.

- [ ] **Step 2: Delete `ProjectId` (line 5)**

```ts
export type ProjectId = string;
```

- [ ] **Step 3: Delete `HlcPacked` + its doc comment (lines ~700-701)**

```ts
/** Packed HLC value for IPC transport (52-char hex string). */
export type HlcPacked = string;
```

(Leave the surrounding "Cross-machine sync (v1.5.0 packet 09)" section header and `SyncConfig` types intact — they are live.)

- [ ] **Step 4: Gate**

```bash
npx tsc -b && npx vitest run src/shared/
```

Expected: PASS. (If `npx vitest run src/shared/` matches no test files in this worktree, run `npx vitest run src/shared/types` and accept "no tests found" by falling back to just `npx tsc -b` — these are type-only deletions; tsc IS the test.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts
git commit -m "chore(dead-code): remove free-standing dead type aliases HlcPacked + ProjectId (10 audit siblings kept as doc-anchors)"
```

---

### Task 9: session-disk-scanner — un-export internal option types

`DiskScanOptions` (`:49`) and `ListSessionsOptions` (`:92`) have zero external references but heavy in-file use (function params at `:405,515,576,654,757,845,887`) — so un-export, do NOT delete. Safe for `tsc -b` because every project is `noEmit: true` (no declaration emit → no TS4023 "exported function using private name").

**Files:**
- Modify: `app/src/main/core/pty/session-disk-scanner.ts:49,92`

- [ ] **Step 1: Re-verify zero external refs (NOTE: filter the definition file by exact path — a bare `grep -v session-disk-scanner.ts` would also hide hits in `session-disk-scanner.test.ts`)**

```bash
rg -n "DiskScanOptions|ListSessionsOptions" src/ electron/ packages/ tests/ | grep -v "^src/main/core/pty/session-disk-scanner.ts:"
```

Expected: empty (exit 1) — in particular zero hits in `src/main/core/pty/session-disk-scanner.test.ts`. Any hit = the types are consumed → skip, log it.

- [ ] **Step 2: Un-export both (keep the interfaces, drop the `export` keyword)**

Line 49: `export interface DiskScanOptions {` → `interface DiskScanOptions {`
Line 92: `export interface ListSessionsOptions extends DiskScanOptions {` → `interface ListSessionsOptions extends DiskScanOptions {`

- [ ] **Step 3: Gate**

```bash
npx tsc -b && npx vitest run src/main/core/pty/session-disk-scanner.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/core/pty/session-disk-scanner.ts
git commit -m "chore(dead-code): un-export internal disk-scanner option types (zero external consumers)"
```

---

### Task 10: DECISION record — `scripts/reapply-ruflo-hook-tuning.cjs` stays

**Files:** none.

- [ ] **Step 1: Record the decision — no code action**

`app/scripts/reapply-ruflo-hook-tuning.cjs` is a one-shot operator script with docs-only references. DECISION: **KEEP** — it is operator tooling documented in the CHANGELOG, not dead code. Add a line to the Execution Log: "reapply-ruflo-hook-tuning.cjs — kept by decision (operator tooling)". Do not delete, do not modify.

---

### Task 11: Final full gate

**Files:** none (verification only).

- [ ] **Step 1: Full local gate (NO local e2e — CI's e2e-matrix owns that)**

```bash
npx tsc -b
npx vitest run
npx eslint . --max-warnings 0
npm run product:check
```

Expected: ALL green. `product:check` is the esbuild safety net for `electron/main.ts` imports that `tsc -b` cannot see (the voice-tree hazard from Task 5). If a vitest file times out under load (known flakes: swarms/factory, VoiceTab), re-run that file in isolation before treating it as a failure.

- [ ] **Step 2: Sanity-sweep the diff for scope leaks**

```bash
git log --oneline origin/main..HEAD
git diff origin/main --stat
git status --porcelain
```

Expected: ~9 `chore(dead-code):` commits; the stat list matches the File Structure section exactly; working tree clean; `pnpm-workspace.yaml` NOT in the diff.

- [ ] **Step 3: If executed in the Option-A worktree — re-gate in MAIN after integration**

Worktree tsc/vitest can differ subtly from the main checkout. After this branch is merged/cherry-picked into the main working copy (push + PR is a separate operator-authorized step — this plan does NOT authorize a release or tag), re-run `npx tsc -b && npx vitest run` there. Then remove the worktree:

```bash
cd /Users/aisigma/projects/SigmaLink
git worktree remove --force ../SigmaLink-deadcode
```

(Stale worktrees become accidental write targets — do not leave it behind.)

- [ ] **Step 4: Fill in the Execution Log below** — every skipped item with the rg evidence, every kept doc-anchor, the sheetSideMotion keyframes follow-on (`animate-sl-slide-*` CSS possibly orphaned → wishlist), and any pnpm side-effect reverts.

---

## Coordination notes

1. **PaneShell ordering (Task 4):** the sibling plan `terminal-cache-scratch-lifecycle` does major PaneShell surgery. Land that plan FIRST (or hand Task 4 to the same integration owner). The `inSplitGroup` edit is tiny and symbol-locatable, so rebasing it over the other plan's changes is cheap; the reverse is not true.
2. **index.css WIP hazard (Task 6):** `src/index.css` has uncommitted concurrent-session WIP in the main checkout. Option-A worktree neutralizes this. In Option B, skip Task 6 if the file is dirty — never mix another session's hunks into a dead-code commit.
3. **vite.config.ts contention (Task 1):** the sibling perf-render plan also edits `vite.config.ts` `manualChunks`. Coordinate the matcher/comment edit — whoever lands second rebases; the `if (id.includes('monaco'))` line itself must survive (it keeps the @monaco-editor/react shim out of vendor buckets).
4. **Concurrent shared-tree discipline:** integrate via an isolated worktree off `origin/main`, commit atomically per task, and push to a fresh branch immediately when the operator authorizes — the shared tree and branch refs get stomped mid-task in this repo.
5. **This plan does NOT authorize:** pushing, PR creation, tagging, releasing, approving pnpm build scripts, or touching `src/main/core/voice/` beyond the two voice-stats files.

## Execution Log

(Executor fills this in. One line per item: `SKIPPED <item> — rg showed <evidence>` / `KEPT <symbol> — doc-anchor (<n> in-file refs)` / `DONE <task> — <commit sha>`. Known pre-seeded entries:)

- Task 8 expected keeps: MemoryId (7 in-file), SwarmId (4), SessionId (2), SkillId (2), TaskId (2), NotificationKind (1), PaneLaunchMode (1), RepoMode (1), SwarmAgentId (1), SwarmStatus (1) — all doc-anchor field types inside live interfaces.
- Task 10: reapply-ruflo-hook-tuning.cjs — kept by decision (operator tooling).
- Wishlist candidate (do not action here): `animate-sl-slide-in/out-{top,right,bottom,left}` keyframes may be orphaned after sheet.tsx + sheetSideMotion removal; also `index.css:150`-area comments referencing retired mechanisms beyond the two fixed in Tasks 6-7.
