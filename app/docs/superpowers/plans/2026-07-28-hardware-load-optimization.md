# SigmaLink Hardware-Load Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut SigmaLink's measured RAM and CPU load on Apple Silicon by fixing the auto-updater's architecture routing, pruning packaged modules nothing resolves at runtime, and bounding renderer terminal-buffer retention — without changing any user-visible behaviour.

**Architecture:** Three independent layers, deliberately separable into three PRs. (1) A pure, Electron-free asset-selection module makes update routing unit-testable and arch-correct. (2) `electron-builder.yml` stops copying `node_modules` that esbuild/vite already inlined. (3) The renderer's two terminal caches gain a bounded parked-pane trim plus tighter LRU caps, while the focused pane keeps full scrollback.

**Tech Stack:** Electron 30, TypeScript (strict, `erasableSyntaxOnly`), Vitest, esbuild (main bundle), Vite (renderer bundle), electron-builder 24.x, electron-updater 6.x, `@xterm/xterm` + `@xterm/headless` 6.

## Global Constraints

- **Base branch:** `perf/hardware-load-optimization`, already created off `origin/main` at `0f92f02`. Worktree: `/Users/aisigma/projects/SigmaLink-wt-perf-hwload`. All commands run from the `app/` subdirectory unless stated.
- **Package manager is `pnpm`.** Never `npm`.
- **`erasableSyntaxOnly` is ON in `app/`** — no `constructor(private x)` parameter properties, no `enum`, no `namespace`. Use plain interfaces and `const` objects.
- **Local gate before any push:** `pnpm tsc -b && pnpm vitest run && pnpm eslint .`. `tsc` and `vitest` alone are not sufficient — eslint catches rules the others miss and has previously turned CI red.
- **Never pipe a gate command into `tail`/`head` before `&&`** — the pipe masks the exit code and a failing suite will appear to pass. Capture the exit status or read the summary line.
- **Do not run Playwright, `electron:dev`, or launch a live Electron app** unless a task explicitly says to. The operator has a live SigmaLink instance running.
- **NEVER push, tag, or create a release.** Commit locally only. The operator handles all publishing.
- **Run the FULL vitest suite**, not scoped files — scoped runs miss sibling mock breakage.
- **Every RPC channel needs all four mirror sites** or preload silently rejects it: router shape, `rpc-router`, the `CHANNELS` allowlist in `src/shared/rpc-channels.ts`, and the test source list.

---

## File Structure

| File | Responsibility |
|---|---|
| `app/electron/update-asset.ts` | **New.** Pure arch resolution + release-asset selection. No `electron` import, so it is unit-testable under the `node` vitest environment. |
| `app/electron/update-asset.test.ts` | **New.** Table-driven tests over the real published v3.0.0 manifest asset list. |
| `app/electron/auto-update.ts` | **Modify.** Delegates mac DMG and Linux AppImage selection to `update-asset.ts`. |
| `app/electron/main.ts` | **Modify.** Diagnostic window reports effective (translation-aware) arch. |
| `app/electron-builder.yml` | **Modify.** `files:` prunes unresolved `node_modules`; `asar` restored with `asarUnpack`. |
| `app/docs/perf/2026-07-28-arm64-baseline.md` | **New.** Operator-recorded A/B memory measurements. |
| `app/docs/perf/2026-07-28-package-audit.md` | **New.** Packaged-size before/after + launch smoke checklist. |
| `app/src/renderer/lib/terminal-cache.ts` | **Modify.** Trim-on-park in `detachFromHost()`; `TERMINAL_CACHE_LIMIT`; scrollback from settings. |
| `app/src/renderer/lib/engine-cache.ts` | **Modify.** `ENGINE_CACHE_LIMIT`; scrollback from settings. |
| `app/src/renderer/lib/terminal-engine.ts` | **Modify.** `trimScrollback()` method; scrollback default sourced from one shared constant. |
| `app/src/renderer/lib/terminal-limits.ts` | **New.** Single source of truth for scrollback depth, parked-trim depth, and cache caps — kills the current two-independent-defaults drift. |

---

## Task 0: Operator gate — arm64 baseline (NOT agent work)

**This task is performed by the operator, not by an implementing agent.** Tasks 6–8 must not be started until `app/docs/perf/2026-07-28-arm64-baseline.md` exists, because their tuning constants are chosen from its numbers.

- [ ] **Step 1: Quit SigmaLink and install the native build**

Download `SigmaLink-3.0.0-arm64.dmg` from the v3.0.0 release and install over the current app.

- [ ] **Step 2: Verify it is actually native**

```bash
lipo -archs /Applications/SigmaLink.app/Contents/MacOS/SigmaLink   # must print: arm64
```

- [ ] **Step 3: Restore the same workload and measure**

Open the same workspaces until the live pane count matches the x64 run (17 live panes, 2 windows), then:

```bash
ps -Ao pid,comm | grep SigmaLink | grep -v grep
for p in <each pid>; do /usr/bin/footprint -p $p | grep phys_footprint:; done
/usr/bin/vmmap -summary <heaviest-renderer-pid> | grep -E "^Rosetta|^TOTAL "
```

Expected: zero `Rosetta` rows. Record every number into `app/docs/perf/2026-07-28-arm64-baseline.md` beside the x64 column below.

**x64-under-Rosetta reference (already measured, Apple M4, v3.0.0, 17 panes, 2 windows):**

| process | phys_footprint | Rosetta share |
|---|---:|---:|
| main (Node) | 389 MB | 152 MB |
| renderer A (Command Room) | 1684 MB | 155 MB |
| renderer B | 757 MB | 150 MB |
| GPU helper | 464 MB | 10 MB |
| 2× utility | 44 MB | — |
| **total** | **3338 MB** | **468 MB** |

---

## Task 1: Pure arch + asset selection module

**Files:**
- Create: `app/electron/update-asset.ts`
- Test: `app/electron/update-asset.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module, no `electron` import).
- Produces: `type MacArch = 'arm64' | 'x64'`; `interface ReleaseFile { url: string }`; `resolveMacArch(input: { processArch: string; runningUnderARM64Translation: boolean }): MacArch`; `pickMacDmg(files: readonly ReleaseFile[], arch: MacArch): ReleaseFile | null`; `pickLinuxAppImage(files: readonly ReleaseFile[], arch: string): ReleaseFile | null`.

- [ ] **Step 1: Write the failing test**

Create `app/electron/update-asset.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pickLinuxAppImage, pickMacDmg, resolveMacArch } from './update-asset';

/** The real asset list published in v3.0.0's latest-mac.yml, in manifest order.
 *  x64 deliberately precedes arm64 — that ordering is what made the old
 *  `files.find(f => f.url.endsWith('.dmg'))` hand x64 to every Mac. */
const V3_MAC_FILES = [
  { url: 'SigmaLink-3.0.0-mac.zip' },
  { url: 'SigmaLink-3.0.0-arm64-mac.zip' },
  { url: 'SigmaLink-3.0.0.dmg' },
  { url: 'SigmaLink-3.0.0-arm64.dmg' },
] as const;

describe('resolveMacArch', () => {
  it('reports arm64 for a native arm64 process', () => {
    expect(resolveMacArch({ processArch: 'arm64', runningUnderARM64Translation: false })).toBe('arm64');
  });

  it('reports arm64 for an x64 process translated by Rosetta', () => {
    expect(resolveMacArch({ processArch: 'x64', runningUnderARM64Translation: true })).toBe('arm64');
  });

  it('reports x64 for a genuine Intel process', () => {
    expect(resolveMacArch({ processArch: 'x64', runningUnderARM64Translation: false })).toBe('x64');
  });
});

describe('pickMacDmg', () => {
  it('picks the arm64 dmg on Apple Silicon even though x64 comes first', () => {
    expect(pickMacDmg(V3_MAC_FILES, 'arm64')?.url).toBe('SigmaLink-3.0.0-arm64.dmg');
  });

  it('picks the x64 dmg on Intel', () => {
    expect(pickMacDmg(V3_MAC_FILES, 'x64')?.url).toBe('SigmaLink-3.0.0.dmg');
  });

  it('falls back to x64 on Apple Silicon when no arm64 dmg is published', () => {
    const files = [{ url: 'SigmaLink-1.0.0.dmg' }];
    expect(pickMacDmg(files, 'arm64')?.url).toBe('SigmaLink-1.0.0.dmg');
  });

  it('never hands an arm64-only manifest to an Intel host', () => {
    const files = [{ url: 'SigmaLink-9.9.9-arm64.dmg' }];
    expect(pickMacDmg(files, 'x64')).toBeNull();
  });

  it('returns null when the manifest contains no dmg at all', () => {
    expect(pickMacDmg([{ url: 'SigmaLink-3.0.0-mac.zip' }], 'arm64')).toBeNull();
  });
});

describe('pickLinuxAppImage', () => {
  it('picks the x64 AppImage on x64', () => {
    const files = [{ url: 'SigmaLink-3.0.0.AppImage' }];
    expect(pickLinuxAppImage(files, 'x64')?.url).toBe('SigmaLink-3.0.0.AppImage');
  });

  it('prefers an arm64 AppImage on arm64 when one exists', () => {
    const files = [{ url: 'SigmaLink-3.0.0.AppImage' }, { url: 'SigmaLink-3.0.0-arm64.AppImage' }];
    expect(pickLinuxAppImage(files, 'arm64')?.url).toBe('SigmaLink-3.0.0-arm64.AppImage');
  });

  it('never hands an arm64-only AppImage to an x64 host', () => {
    expect(pickLinuxAppImage([{ url: 'SigmaLink-3.0.0-arm64.AppImage' }], 'x64')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run electron/update-asset.test.ts
```

Expected: FAIL — `Failed to resolve import "./update-asset"`.

- [ ] **Step 3: Write the implementation**

Create `app/electron/update-asset.ts`:

```ts
// Release-asset selection for the auto-updater.
//
// Deliberately free of any `electron` import so it is unit-testable under the
// plain `node` vitest environment (vitest.config.ts includes electron/**).
//
// Why this module exists: `latest-mac.yml` lists BOTH architectures, and
// electron-builder writes the x64 assets first. The previous inline
// `info.files.find(f => f.url.endsWith('.dmg'))` therefore returned the x64
// DMG on every Mac, silently moving Apple Silicon users onto a
// Rosetta-translated build. Because `process.arch` reports 'x64' inside a
// translated process, that state was self-sealing — every subsequent update
// re-selected x64.

export type MacArch = 'arm64' | 'x64';

export interface ReleaseFile {
  url: string;
}

/** electron-builder names the arm64 artefact `<name>-arm64.<ext>` and leaves
 *  the x64 artefact unsuffixed. */
function isArm64Asset(file: ReleaseFile, ext: string): boolean {
  return file.url.endsWith(`-arm64${ext}`);
}

/**
 * The architecture the machine can actually run natively.
 *
 * `processArch` alone is not enough: an x64 build translated by Rosetta on an
 * Apple Silicon Mac reports 'x64'. `runningUnderARM64Translation` (Electron's
 * `app.runningUnderARM64Translation`) is what distinguishes a real Intel Mac
 * from a translated process on Apple Silicon.
 */
export function resolveMacArch(input: {
  processArch: string;
  runningUnderARM64Translation: boolean;
}): MacArch {
  if (input.processArch === 'arm64') return 'arm64';
  return input.runningUnderARM64Translation ? 'arm64' : 'x64';
}

/**
 * Select the `.dmg` matching `arch`.
 *
 * The fallback is intentionally ASYMMETRIC:
 *   • arm64 host → prefer arm64, but accept x64. Apple Silicon can execute the
 *     x64 build under Rosetta, so an older release that only shipped x64 stays
 *     updatable rather than dead-ending.
 *   • x64 host → arm64 ONLY, never. An Intel Mac cannot execute an arm64
 *     binary; handing it one would produce an unlaunchable install.
 */
export function pickMacDmg(files: readonly ReleaseFile[], arch: MacArch): ReleaseFile | null {
  const dmgs = files.filter((f) => f.url.endsWith('.dmg'));
  if (dmgs.length === 0) return null;
  if (arch === 'arm64') {
    return dmgs.find((f) => isArm64Asset(f, '.dmg')) ?? dmgs.find((f) => !isArm64Asset(f, '.dmg')) ?? null;
  }
  return dmgs.find((f) => !isArm64Asset(f, '.dmg')) ?? null;
}

/**
 * Select the `.AppImage` matching `arch`. Only x64 AppImages are published
 * today (electron-builder.yml `linux.target`), so this is currently a
 * no-op guard — but it removes the same latent first-match bug the mac path
 * had, ahead of any future arm64 Linux artefact.
 */
export function pickLinuxAppImage(files: readonly ReleaseFile[], arch: string): ReleaseFile | null {
  const images = files.filter((f) => f.url.endsWith('.AppImage'));
  if (images.length === 0) return null;
  if (arch === 'arm64') {
    return (
      images.find((f) => isArm64Asset(f, '.AppImage')) ??
      images.find((f) => !isArm64Asset(f, '.AppImage')) ??
      null
    );
  }
  return images.find((f) => !isArm64Asset(f, '.AppImage')) ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run electron/update-asset.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add app/electron/update-asset.ts app/electron/update-asset.test.ts
git commit -m "feat(updater): add arch-aware release asset selection"
```

---

## Task 2: Wire arch-correct selection into the updater

**Files:**
- Modify: `app/electron/auto-update.ts` (the `resolveLinuxAppImageUrl` function around line 67, and the `darwin` branch of the `update-available` handler around line 87)

**Interfaces:**
- Consumes: `resolveMacArch`, `pickMacDmg`, `pickLinuxAppImage`, `MacArch` from Task 1.
- Produces: no new exports; behaviour change only.

- [ ] **Step 1: Add the import**

At the top of `app/electron/auto-update.ts`, alongside the existing imports:

```ts
import { pickLinuxAppImage, pickMacDmg, resolveMacArch } from './update-asset';
```

- [ ] **Step 2: Replace the mac DMG selection**

Find this exact block in the `darwin` branch:

```ts
      const dmgFile = info.files.find(f => f.url.endsWith('.dmg'));
      if (!dmgFile) {
        broadcast('app:update-error', { error: 'No DMG found in release manifest' });
        return;
      }
```

Replace it with:

```ts
      const arch = resolveMacArch({
        processArch: process.arch,
        runningUnderARM64Translation: app.runningUnderARM64Translation === true,
      });
      const dmgFile = pickMacDmg(info.files, arch);
      if (!dmgFile) {
        broadcast('app:update-error', {
          error: `No ${arch} DMG found in release manifest`,
        });
        return;
      }
```

- [ ] **Step 3: Replace the Linux AppImage selection**

Find this exact function:

```ts
function resolveLinuxAppImageUrl(info: UpdateInfo): { url: string; name: string } | null {
  const file = info.files.find((f) => f.url.endsWith('.AppImage'));
  if (!file) return null;
  return { url: resolveMacDmgUrl(info, file.url), name: file.url };
}
```

Replace it with:

```ts
function resolveLinuxAppImageUrl(info: UpdateInfo): { url: string; name: string } | null {
  const file = pickLinuxAppImage(info.files, process.arch);
  if (!file) return null;
  return { url: resolveMacDmgUrl(info, file.url), name: file.url };
}
```

- [ ] **Step 4: Verify the full gate**

```bash
pnpm tsc -b
pnpm vitest run
pnpm eslint .
```

Expected: all three exit 0. Check each exit code separately — do not chain through a pipe.

- [ ] **Step 5: Commit**

```bash
git add app/electron/auto-update.ts
git commit -m "fix(updater): serve the arm64 macOS build to Apple Silicon

latest-mac.yml lists both architectures with x64 first, so
files.find(endsWith('.dmg')) returned the x64 DMG on every Mac. Apple
Silicon users were silently moved onto a Rosetta-translated build, and
because process.arch reports 'x64' inside a translated process the state
was self-sealing across every subsequent update.

Measured cost on an M4 at 17 live panes: 468 MB of 3338 MB in Rosetta
translation arenas, plus a large CPU tax."
```

---

## Task 3: Report effective architecture in the diagnostic window

**Files:**
- Modify: `app/electron/main.ts` (the `versions` object near line 581 and the Arch row near line 627)

**Interfaces:**
- Consumes: `resolveMacArch` from Task 1.
- Produces: no new exports.

**Why this matters:** the diagnostic window is the one surface that could have revealed the bug, and it currently prints `process.arch` — which reports `x64` under Rosetta, confirming the wrong answer.

- [ ] **Step 1: Import the resolver**

Add to the imports in `app/electron/main.ts`:

```ts
import { resolveMacArch } from './update-asset';
```

- [ ] **Step 2: Compute the effective arch**

In the `versions` object near line 581, add an `arch` entry that is translation-aware. On non-darwin platforms `runningUnderARM64Translation` is `undefined`, so the coercion below yields plain `process.arch` behaviour:

```ts
    arch:
      process.platform === 'darwin'
        ? (() => {
            const effective = resolveMacArch({
              processArch: process.arch,
              runningUnderARM64Translation: app.runningUnderARM64Translation === true,
            });
            return app.runningUnderARM64Translation === true
              ? `${process.arch} (translated — native ${effective})`
              : process.arch;
          })()
        : process.arch,
```

- [ ] **Step 3: Verify the gate**

```bash
pnpm tsc -b
pnpm vitest run
pnpm eslint .
```

Expected: all three exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/electron/main.ts
git commit -m "fix(diagnostics): report translated-vs-native arch instead of process.arch"
```

**STOP HERE for PR 1.** Tasks 1–3 are a complete, independently shippable fix. Report to the operator before continuing.

---

## Task 4: Audit what the packaged app actually resolves at runtime

**Files:**
- Create: `app/docs/perf/2026-07-28-package-audit.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the verified external-module list that Task 5 prunes against.

**This task writes no product code.** Its output is the evidence Task 5 needs. Do not skip it — a wrongly-pruned module does not fail any test, it crashes the packaged app at first launch (exactly the v1.0.1 `lazy-val` incident recorded in `electron-builder.yml`'s own comments).

- [ ] **Step 1: Record the current packaged size**

```bash
du -sh /Applications/SigmaLink.app
du -sh /Applications/SigmaLink.app/Contents/Resources/app/node_modules
du -sh /Applications/SigmaLink.app/Contents/Resources/app/node_modules/* | sort -rh | head -20
```

Reference measurement already taken: app 380 MB, `node_modules` 128 MB, led by `lucide-react` 34 MB, `@sigmalink` 21 MB, `drizzle-orm` 14 MB, `better-sqlite3` 12 MB, `@xterm` 11 MB, `react-dom` 7.1 MB, `zod` 5.6 MB, `isomorphic-git` 4.6 MB.

- [ ] **Step 2: Enumerate the confirmed externals**

Read `app/scripts/build-electron.cjs:21-40`. The `external` array is the authoritative list of what the main bundle does *not* inline. Everything else is compiled into `electron-dist/main.js`, and every renderer dependency is compiled into `dist/assets/*.js`.

- [ ] **Step 3: Resolve the voice-whisper contradiction**

`@sigmalink/voice-whisper` ships a `.node` binary (`voice-whisper.node`) but does **not** appear in the esbuild `external` list. A `.node` file cannot be inlined into a JS bundle, so one of these is true and the audit must determine which:

```bash
grep -rn "voice-whisper\|voice-core" app/src/main app/electron --include='*.ts' | grep -v test
grep -rn "external" app/scripts/build-electron.cjs
node -e "const s=require('fs').readFileSync('app/electron-dist/main.js','utf8'); console.log('voice-whisper referenced in bundle:', s.includes('voice-whisper'))"
```

- [ ] **Step 4: Check the separate stdio bundle**

`src/main/core/assistant/mcp-host-server.ts` is documented as a standalone stdio bundle deliberately free of better-sqlite3/drizzle/launcher imports. Confirm what it resolves from disk:

```bash
grep -rn "mcp-host-server" app/scripts/build-electron.cjs
```

- [ ] **Step 5: Write the audit document**

Create `app/docs/perf/2026-07-28-package-audit.md` with: the before sizes, the confirmed keep-list (modules that must remain on disk), the confirmed prune-list, and the unresolved/uncertain list. **Anything uncertain goes in the keep-list.**

- [ ] **Step 6: Commit**

```bash
git add app/docs/perf/2026-07-28-package-audit.md
git commit -m "docs(perf): audit packaged node_modules against esbuild externals"
```

---

## Task 5: Prune packaged modules and restore asar

**Files:**
- Modify: `app/electron-builder.yml` (the `files:` block and the `asar: false` line)
- Modify: `app/docs/perf/2026-07-28-package-audit.md` (append the after-sizes and smoke results)

**Interfaces:**
- Consumes: the keep-list from Task 4.
- Produces: no code exports.

- [ ] **Step 1: Restrict the packaged node_modules**

In `app/electron-builder.yml`, extend the `files:` block to exclude `node_modules` except the Task 4 keep-list. Use the keep-list verbatim — the entries below are the *minimum* certain set and Task 4 may have added more:

```yaml
files:
  - dist/**/*
  - electron-dist/**/*
  - package.json
  - '!node_modules/**/*'
  - 'node_modules/better-sqlite3/**/*'
  - 'node_modules/node-pty/**/*'
  # + every additional entry the Task 4 audit placed in the keep-list
```

- [ ] **Step 2: Restore asar with unpack patterns for the natives**

Replace `asar: false` with:

```yaml
asar: true
asarUnpack:
  - 'node_modules/better-sqlite3/**/*'
  - 'node_modules/node-pty/**/*'
  # + every keep-list entry that ships a .node binary
```

- [ ] **Step 3: Package the app**

```bash
pnpm run electron:pack:mac
du -sh release/mac*/SigmaLink.app
```

- [ ] **Step 4: Launch the packaged artifact and smoke it**

This is the only gate that catches a wrongly-pruned module. Launch against an isolated profile so the operator's live data is untouched:

```bash
"./release/mac-arm64/SigmaLink.app/Contents/MacOS/SigmaLink" --user-data-dir=/tmp/sigmalink-pack-smoke
```

Verify, in order: the window opens without a diagnostic/native-module error; the DB opens (the sidebar lists workspaces); a pane spawns and accepts input; Settings → Check for updates returns without error. Any failure means a module was pruned that something resolves — restore it to the keep-list and repeat.

- [ ] **Step 5: Record results and verify the gate**

Append before/after sizes and the smoke checklist outcome to `app/docs/perf/2026-07-28-package-audit.md`, then:

```bash
pnpm tsc -b
pnpm vitest run
pnpm eslint .
```

- [ ] **Step 6: Commit**

```bash
git add app/electron-builder.yml app/docs/perf/2026-07-28-package-audit.md
git commit -m "build: ship only modules resolved at runtime; restore asar

esbuild inlines everything except the natives into electron-dist/main.js
and vite inlines every renderer dep into dist/assets, yet the packaged app
copied 128 MB of node_modules that nothing loads."
```

**STOP HERE for PR 2.** Windows and Linux packaging must be re-smoked in CI (`e2e-matrix.yml`) before merge — macOS proves nothing about win32 native resolution. Report to the operator.

---

## Task 6: Centralize terminal limits

**Files:**
- Create: `app/src/renderer/lib/terminal-limits.ts`
- Test: `app/src/renderer/lib/terminal-limits.test.ts`
- Modify: `app/src/renderer/lib/terminal-engine.ts:104`, `app/src/renderer/lib/terminal-cache.ts:70` and `:256`, `app/src/renderer/lib/engine-cache.ts:22`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_SCROLLBACK_ROWS: number`; `PARKED_SCROLLBACK_ROWS: number`; `TERMINAL_CACHE_LIMIT: number`; `ENGINE_CACHE_LIMIT: number`; `resolveScrollbackRows(raw: string | null): number`.

**Why:** the scrollback default is currently declared twice (`terminal-engine.ts:104` and `terminal-cache.ts:256`) and the cache cap twice (`terminal-cache.ts:70`, `engine-cache.ts:22`). Four constants that must agree, in four places, is how the two presenters drift apart.

- [ ] **Step 1: Write the failing test**

Create `app/src/renderer/lib/terminal-limits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCROLLBACK_ROWS,
  ENGINE_CACHE_LIMIT,
  PARKED_SCROLLBACK_ROWS,
  TERMINAL_CACHE_LIMIT,
  resolveScrollbackRows,
} from './terminal-limits';

describe('terminal limits', () => {
  it('keeps the shipped scrollback default unchanged', () => {
    expect(DEFAULT_SCROLLBACK_ROWS).toBe(8000);
  });

  it('trims parked panes well above one screenful', () => {
    // A pane is 32 rows tall by default (providers/launcher.ts spawns 120x32).
    expect(PARKED_SCROLLBACK_ROWS).toBeGreaterThan(32 * 10);
    expect(PARKED_SCROLLBACK_ROWS).toBeLessThan(DEFAULT_SCROLLBACK_ROWS);
  });

  it('caps both caches at the same value so the presenters cannot drift', () => {
    expect(TERMINAL_CACHE_LIMIT).toBe(ENGINE_CACHE_LIMIT);
  });

  it('falls back to the default for absent or malformed settings', () => {
    expect(resolveScrollbackRows(null)).toBe(DEFAULT_SCROLLBACK_ROWS);
    expect(resolveScrollbackRows('')).toBe(DEFAULT_SCROLLBACK_ROWS);
    expect(resolveScrollbackRows('not-a-number')).toBe(DEFAULT_SCROLLBACK_ROWS);
    expect(resolveScrollbackRows('0')).toBe(DEFAULT_SCROLLBACK_ROWS);
    expect(resolveScrollbackRows('-100')).toBe(DEFAULT_SCROLLBACK_ROWS);
  });

  it('honours a valid configured depth', () => {
    expect(resolveScrollbackRows('2500')).toBe(2500);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/renderer/lib/terminal-limits.test.ts
```

Expected: FAIL — cannot resolve `./terminal-limits`.

- [ ] **Step 3: Write the implementation**

Create `app/src/renderer/lib/terminal-limits.ts`:

```ts
// Single source of truth for terminal retention limits.
//
// Before this module the scrollback default lived in BOTH terminal-engine.ts
// (the DOM presenter's headless engine) and terminal-cache.ts (the attached
// xterm), and the LRU cap lived in BOTH terminal-cache.ts and engine-cache.ts.
// Four constants that must agree, declared in four places.

/** Rows retained by an ATTACHED (visible) pane. Unchanged from the shipped
 *  value — the focused pane keeps full history. */
export const DEFAULT_SCROLLBACK_ROWS = 8000;

/** Rows retained by a PARKED (offscreen) pane after trim-on-park.
 *  A pane spawns at 120x32 (main/core/providers/launcher.ts), so this is
 *  ~60 screenfuls — deep enough that re-attaching feels lossless, shallow
 *  enough to bound the cache. */
export const PARKED_SCROLLBACK_ROWS = 2000;

/** LRU cap per cache. The stated design target is 16 panes x N workspaces;
 *  32 per cache across two caches was 4x that target. */
export const TERMINAL_CACHE_LIMIT = 20;
export const ENGINE_CACHE_LIMIT = 20;

/** Parse a `pty.scrollbackRows` KV value. Any absent, malformed, or
 *  non-positive value falls back to the default rather than producing a
 *  zero-scrollback terminal. */
export function resolveScrollbackRows(raw: string | null): number {
  if (raw == null || raw === '') return DEFAULT_SCROLLBACK_ROWS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SCROLLBACK_ROWS;
  return parsed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/renderer/lib/terminal-limits.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Re-point the four existing declarations**

In `app/src/renderer/lib/terminal-engine.ts`, replace `scrollback: opts.scrollback ?? 8000,` with `scrollback: opts.scrollback ?? DEFAULT_SCROLLBACK_ROWS,` and import `DEFAULT_SCROLLBACK_ROWS` from `./terminal-limits`.

In `app/src/renderer/lib/terminal-cache.ts`, replace the literal `scrollback: 8000,` with `scrollback: DEFAULT_SCROLLBACK_ROWS,`, and replace `export const TERMINAL_CACHE_LIMIT = 32;` with a re-export: `export { TERMINAL_CACHE_LIMIT } from './terminal-limits';`.

In `app/src/renderer/lib/engine-cache.ts`, replace `export const ENGINE_CACHE_LIMIT = 32;` with `export { ENGINE_CACHE_LIMIT } from './terminal-limits';`.

- [ ] **Step 6: Run the FULL suite**

```bash
pnpm vitest run
pnpm tsc -b
pnpm eslint .
```

Expected: all green. A scoped run would miss sibling mock breakage in the cache tests.

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/lib/terminal-limits.ts app/src/renderer/lib/terminal-limits.test.ts app/src/renderer/lib/terminal-engine.ts app/src/renderer/lib/terminal-cache.ts app/src/renderer/lib/engine-cache.ts
git commit -m "refactor(terminal): centralize scrollback and cache limits

The scrollback default was declared in two places and the LRU cap in two
more; the caches lower to 20 each against a 16-pane design target."
```

---

## Task 7: Trim parked panes

**Files:**
- Modify: `app/src/renderer/lib/terminal-engine.ts` (add `trimScrollback`)
- Modify: `app/src/renderer/lib/terminal-cache.ts:571` (`detachFromHost`)
- Test: `app/src/renderer/lib/terminal-engine.test.ts` (append)

**Interfaces:**
- Consumes: `PARKED_SCROLLBACK_ROWS` from Task 6.
- Produces: `TerminalEngine.trimScrollback(maxRows: number): void`.

**Invariant that must survive:** `terminal-cache.ts:1-40` documents that a parked terminal keeps receiving output and its scrollback survives room and workspace switches. Trimming bounds the depth; it must never detach the listener, dispose the instance, or blank the visible viewport.

- [ ] **Step 1: Write the failing test**

Append to `app/src/renderer/lib/terminal-engine.test.ts`:

```ts
describe('trimScrollback', () => {
  it('bounds the buffer to maxRows while preserving the newest content', () => {
    const engine = new TerminalEngine({ writeToPty: () => {} });
    for (let i = 0; i < 500; i += 1) engine.write(`line-${i}\r\n`);
    const beforeLength = engine.bufferLength();
    expect(beforeLength).toBeGreaterThan(100);

    engine.trimScrollback(100);

    expect(engine.bufferLength()).toBeLessThanOrEqual(100 + engine.rows);
    const tail = engine.logicalLines().map((l) => l.text).join('\n');
    expect(tail).toContain('line-499');
    expect(tail).not.toContain('line-0\n');
  });

  it('is a no-op when the buffer is already within bounds', () => {
    const engine = new TerminalEngine({ writeToPty: () => {} });
    engine.write('short\r\n');
    const before = engine.bufferLength();
    engine.trimScrollback(5000);
    expect(engine.bufferLength()).toBe(before);
  });

  it('keeps accepting writes after a trim', () => {
    const engine = new TerminalEngine({ writeToPty: () => {} });
    for (let i = 0; i < 300; i += 1) engine.write(`x-${i}\r\n`);
    engine.trimScrollback(50);
    engine.write('after-trim\r\n');
    const tail = engine.logicalLines().map((l) => l.text).join('\n');
    expect(tail).toContain('after-trim');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/renderer/lib/terminal-engine.test.ts
```

Expected: FAIL — `engine.trimScrollback is not a function`.

- [ ] **Step 3: Implement `trimScrollback` on `TerminalEngine`**

Add the method to the `TerminalEngine` class in `app/src/renderer/lib/terminal-engine.ts`. xterm exposes no public row-eviction API, so resizing the scrollback option is the supported mechanism — shrinking `scrollback` makes xterm discard the oldest rows, and restoring it lets the buffer grow again from the trimmed base:

```ts
  /**
   * Bound the retained scrollback to `maxRows`, discarding the OLDEST rows.
   *
   * Used to shrink parked (offscreen) panes. xterm has no public row-eviction
   * API; assigning a smaller `scrollback` makes it drop the oldest rows
   * immediately, and restoring the option afterwards lets the pane keep
   * growing from the trimmed base. The listener, the PTY subscription, and
   * the visible viewport are all untouched.
   */
  trimScrollback(maxRows: number): void {
    if (maxRows <= 0) return;
    if (this.bufferLength() <= maxRows) return;
    const previous = this.term.options.scrollback ?? DEFAULT_SCROLLBACK_ROWS;
    this.term.options.scrollback = maxRows;
    this.term.options.scrollback = previous;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/renderer/lib/terminal-engine.test.ts
```

Expected: PASS. If the assertion on `bufferLength()` fails because xterm's trim is asynchronous, adjust the test to await a microtask rather than weakening the assertion.

- [ ] **Step 5: Call it from `detachFromHost`**

In `app/src/renderer/lib/terminal-cache.ts`, inside `detachFromHost` (line ~571), after the existing DOM-parking work, add:

```ts
  // Trim-on-park: a parked pane is offscreen, so deep history costs memory
  // nobody is reading. The attached path keeps DEFAULT_SCROLLBACK_ROWS.
  // Does NOT dispose the instance or drop the PTY subscription — the parking
  // contract at the top of this file still holds.
  entry.term.options.scrollback = PARKED_SCROLLBACK_ROWS;
```

And in `attachToHost` (line ~556), restore full depth when the pane becomes visible again:

```ts
  entry.term.options.scrollback = DEFAULT_SCROLLBACK_ROWS;
```

Import both constants from `./terminal-limits`.

- [ ] **Step 6: Run the FULL suite**

```bash
pnpm vitest run
pnpm tsc -b
pnpm eslint .
```

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/lib/terminal-engine.ts app/src/renderer/lib/terminal-engine.test.ts app/src/renderer/lib/terminal-cache.ts
git commit -m "perf(terminal): trim parked panes to a bounded scrollback

Offscreen panes keep receiving output and stay attached to the PTY bus,
but retain 2000 rows instead of 8000. The focused pane is unchanged."
```

---

## Task 8: Expose scrollback depth as a setting

**Files:**
- Modify: `app/src/shared/rpc-channels.ts` (no new channel — `kv.get`/`kv.set` already exist; verify only)
- Modify: `app/src/renderer/features/settings/RufloSettings.tsx`
- Modify: `app/src/renderer/lib/terminal-cache.ts`, `app/src/renderer/lib/engine-cache.ts` (read the setting at instance creation)

**Interfaces:**
- Consumes: `resolveScrollbackRows`, `DEFAULT_SCROLLBACK_ROWS` from Task 6.
- Produces: KV key `'pty.scrollbackRows'`.

**No new RPC channel is required** — this rides the existing `kv.get`/`kv.set`. Confirm that before writing code; if a new channel ever *is* needed it must be added at all four mirror sites or preload silently rejects it.

- [ ] **Step 1: Verify no new channel is needed**

```bash
grep -n "'kv:get'\|'kv:set'\|kv\.get\|kv\.set" app/src/shared/rpc-channels.ts | head
```

Expected: both channels already present in `CHANNELS`.

- [ ] **Step 2: Add the setting to RufloSettings**

Mirror the existing `KV_PTY_SCROLLBACK_PERSISTENCE` pattern at `RufloSettings.tsx:32`. Add near the other KV key constants:

```ts
const KV_PTY_SCROLLBACK_ROWS = 'pty.scrollbackRows';
```

Add a numeric input under the existing "Experimental PTY features" block that reads via `rpc.kv.get(KV_PTY_SCROLLBACK_ROWS)` on mount and writes via `rpc.kv.set(KV_PTY_SCROLLBACK_ROWS, String(value))` on change, following the surrounding controls' shape exactly. Label it "Scrollback rows (visible pane)" with helper text noting that parked panes retain fewer rows and that the change applies to newly created panes.

- [ ] **Step 3: Read the setting when creating terminals**

In `terminal-cache.ts` `buildTerminalOptions` and in `engine-cache.ts` `getOrCreateEngine`, replace the hard-coded `DEFAULT_SCROLLBACK_ROWS` with a value read once at module init from KV and passed through `resolveScrollbackRows`. Cache the resolved number in a module-scope variable — do not issue an RPC per terminal creation.

- [ ] **Step 4: Run the FULL suite**

```bash
pnpm vitest run
pnpm tsc -b
pnpm eslint .
```

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/features/settings/RufloSettings.tsx app/src/renderer/lib/terminal-cache.ts app/src/renderer/lib/engine-cache.ts
git commit -m "feat(settings): expose pty.scrollbackRows (default unchanged at 8000)"
```

- [ ] **Step 6: Report the final state to the operator**

Post: files changed · commit hashes · full gate results · which measurements from Task 0 the tuning constants were chosen against · anything left in the Task 4 uncertain list · blunt blockers.

**STOP HERE for PR 3.** Do not push, tag, or merge.

---

## Self-Review

**Spec coverage.** ROADMAP Phase 2 → Task 0. Phase 3 (B-1/B-2/B-3) → Tasks 1–3. Phase 4 → Tasks 4–5. Phase 5 → Tasks 6–8. ADR-001's "(b) with (c) folded in" decision → Task 7 (trim-on-park) and Task 6 (cache caps 32 → 20). ADR-002 requires no implementation.

**Placeholder scan.** No TBD/TODO markers. Every code step carries the actual content. Task 8 Step 2 describes the input control by reference to an existing sibling control rather than reproducing the whole JSX — acceptable because the file's conventions govern and the exact KV key, RPC calls, and label text are specified.

**Type consistency.** `MacArch`, `ReleaseFile`, `resolveMacArch`, `pickMacDmg`, `pickLinuxAppImage` are defined in Task 1 and consumed with identical signatures in Tasks 2 and 3. `DEFAULT_SCROLLBACK_ROWS`, `PARKED_SCROLLBACK_ROWS`, `TERMINAL_CACHE_LIMIT`, `ENGINE_CACHE_LIMIT`, `resolveScrollbackRows` are defined in Task 6 and consumed in Tasks 7 and 8.

**Known risk carried forward.** Task 7's `trimScrollback` relies on xterm's `options.scrollback` assignment evicting the oldest rows. That behaviour is asserted by the Task 7 Step 1 test *before* the implementation is written, so if xterm 6 does not honour it the test fails immediately and the implementation must switch approach rather than the assertion being weakened.
