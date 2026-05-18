# v1.4.6 — Frameless chrome (windowsControlsOverlay)

## Mission

Turn on the frameless / `windowsControlsOverlay` chrome on Windows + macOS so the app's top bar (rooms menu, breadcrumbs, workspace switcher) blends edge-to-edge with the OS title region. Drop the native title bar, retain OS-provided window controls via the overlay API. Already queued on WISHLIST 🟢 v1.3 row.

## Working environment

- Working dir (absolute): `/Users/aisigma/projects/SigmaLink-feat-v1.4.6-frameless-chrome`
- Branch (already on): `feat/v1.4.6-frameless-chrome`
- Main branch (reference only): `main` at `f12c656`
- Stay inside this worktree.

## Approach

Three pieces in lockstep:

### 1. BrowserWindow config — Electron main process

File: `app/src/main/main.ts` (or wherever `new BrowserWindow(...)` lives — grep for `BrowserWindow(`)

Pass these in the constructor options:

```ts
new BrowserWindow({
  // ... existing options ...
  titleBarStyle: 'hidden',        // hides the native bar on both platforms
  titleBarOverlay: {              // Windows: overlay-style controls
    color: '#0a0a0a',             // match dark-theme top-bar background
    symbolColor: '#e5e5e5',       // glyphs on top of overlay
    height: 32                    // matches our top-bar h-8
  },
  // macOS specifics:
  trafficLightPosition: { x: 12, y: 12 }, // align native traffic lights with our top-bar padding
})
```

Reference: https://www.electronjs.org/docs/latest/tutorial/window-customization#window-controls-overlay
- `titleBarStyle: 'hidden'` is cross-platform
- `titleBarOverlay` is Windows + Linux only (mac uses `trafficLightPosition` instead)
- For Linux: the same `titleBarOverlay` block works on Wayland; X11 is best-effort

### 2. Renderer — reserve the drag region

File: probably `app/src/renderer/features/top-bar/TopBar.tsx` (grep `top-bar` directory for the main bar component)

Add the WebKit-only `-webkit-app-region: drag` CSS to the bar's container, with `-webkit-app-region: no-drag` on any clickable child (buttons, dropdowns). Tailwind doesn't have a built-in class for this — add a custom utility:

In `app/tailwind.config.js` (or wherever Tailwind config lives):

```js
plugins: [
  // ... existing plugins ...
  plugin(function({ addUtilities }) {
    addUtilities({
      '.app-drag': { '-webkit-app-region': 'drag' },
      '.app-no-drag': { '-webkit-app-region': 'no-drag' },
    })
  }),
],
```

Then on the TopBar root: add `app-drag`. On every Button / DropdownMenu / Input inside: add `app-no-drag`.

Test by opening the app and verifying you can drag the window by the top-bar empty space but clicks still register on buttons.

### 3. Reserve space for Windows overlay

On Windows, the `titleBarOverlay` reserves space on the **right** side of the title bar for min/max/close buttons. That's an OS-managed strip the renderer can't draw under. Reserve right-side padding in the top-bar:

In the top-bar render, query `window.navigator.windowControlsOverlay` (a renderer-process API exposed when `titleBarOverlay` is on):

```ts
// At top of TopBar.tsx
const overlay = (navigator as any).windowControlsOverlay
const overlayRightInset = overlay?.getTitlebarAreaRect?.().right
  ? window.innerWidth - overlay.getTitlebarAreaRect().right
  : 0
```

Apply that as right padding on the rightmost top-bar element. Also subscribe to `overlay.ongeometrychange` and re-measure on resize.

On macOS, the traffic-light buttons are at top-left so reserve left padding instead. The `trafficLightPosition` config places them at (12, 12); reserve ~80px of left padding on the top-bar to clear them.

## Files to touch

| File | Why |
|---|---|
| `app/src/main/main.ts` (or main-window factory) | Add titleBarStyle + titleBarOverlay + trafficLightPosition |
| `app/src/renderer/features/top-bar/<bar component>.tsx` | Add app-drag + app-no-drag classes; reserve overlay insets |
| `app/tailwind.config.js` | Add app-drag / app-no-drag utilities |
| `app/src/renderer/features/top-bar/*.test.tsx` (if exists) | Update snapshot or class assertions |

## Setup

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.6-frameless-chrome/app
pnpm install --no-frozen-lockfile
node node_modules/electron/install.js
```

## Local verification

Run the app:

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.6-frameless-chrome/app
pnpm run build
pnpm run electron:compile
pnpm exec electron electron-dist/main.js
```

Visual checks:
- **macOS**: no native title bar visible; traffic-light buttons render top-left over the top-bar; clicks land correctly; drag works in empty top-bar space
- **Windows** (if you have a Win machine — otherwise CI will catch it): same, but min/max/close on top-right; overlay-color matches background

## Verification gate (must ALL pass before commit)

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.6-frameless-chrome/app
pnpm exec tsc -b --pretty false              # clean
pnpm exec eslint .                             # 0 errors / 1 pre-existing warning OK
pnpm exec vitest run                           # 505 pass / 1 skip baseline
pnpm run build                                  # clean
node scripts/build-electron.cjs                 # clean
```

## Git workflow

- **Read every file before editing**
- Stage explicitly by path
- One or two commits is fine. Suggested split: (1) main-process config + tailwind utilities, (2) renderer top-bar changes
- Push, open ONE PR:
  ```bash
  gh pr create --title "feat(v1.4.6): frameless chrome with windowsControlsOverlay" \
    --body "$(cat <<'EOF'
  ## Summary

  Drops the native title bar; uses Electron's titleBarStyle: 'hidden' +
  titleBarOverlay (Windows) / trafficLightPosition (macOS) for OS-managed
  window controls overlaid on our existing top-bar. Top-bar gets WebKit
  drag-region classes; clickable elements opt out via app-no-drag.

  ## Verification

  - tsc / vitest / eslint / build: clean
  - macOS visual: traffic lights overlay top-bar at (12,12); drag/no-drag works
  - Windows visual: lands on CI next tag push

  Refs WISHLIST 🟢 v1.3 row "windowsControlsOverlay frameless chrome".

  🤖 Generated with Sonnet 4.6
  EOF
  )"
  ```
- **DO NOT MERGE the PR**. Lead reviewer pass + merge.

## When to stop

- If `BrowserWindow` is created in a way that doesn't accept new options cleanly (e.g. it's wrapped in a factory with strict types), update the factory signature and document why in `## Result`.
- If the top-bar uses radix-ui primitives that don't accept arbitrary className, document the workaround.
- If `windowControlsOverlay` API isn't accessible from preload context (e.g. nodeIntegration off), document the cross-process bridge needed.

## Reporting back

Append to this BRIEF.md a `## Result` section with:
- File diffs summary
- Visual verification screenshots filenames (if captured) or "manual visual OK" line
- Verification gate output
- Time taken
- Any out-of-scope findings (e.g. resize handle conflicts, hover state on min/max)

The lead reviews this section + the PR.

## Result

### File diff summary

**`electron/main.ts`**
- `createWindow()`: `titleBarStyle` changed from `process.platform === 'darwin' ? 'hiddenInset' : 'default'` to `'hidden'` (cross-platform).
- Added `titleBarOverlay: { color: '#0a0c12', symbolColor: '#e5e5e5', height: 32 }` for Windows/Linux via spread conditional.
- Added `trafficLightPosition: { x: 12, y: 10 }` for macOS via spread conditional.

**`app/tailwind.config.js`**
- Added `plugin` require at top.
- Added custom Tailwind utilities: `.app-drag { -webkit-app-region: drag }` and `.app-no-drag { -webkit-app-region: no-drag }`.

**`app/src/renderer/lib/drag-region.ts`**
- Removed macOS-only guard (`PLATFORM_IS_MAC ? ... : {}`). Both `dragStyle()` and `noDragStyle()` now return unconditionally because `titleBarStyle: 'hidden'` is active on all platforms. Comment updated to document the pre-v1.4.6 reasoning.
- Removed unused `PLATFORM_IS_MAC` import.

**`app/src/renderer/features/top-bar/Breadcrumb.tsx`**
- Replaced static `WIN32_WCO_RESERVE_PX = 140` with two constants: `WIN32_WCO_RESERVE_FALLBACK_PX = 140` (static fallback) and `MACOS_TRAFFIC_LIGHT_RESERVE_PX = 80` (left-side reserve for macOS traffic lights).
- Added `WindowControlsOverlay` interface (matches the browser API shape).
- Added `computeInsets()` helper that queries `navigator.windowControlsOverlay` for the live right inset on Windows/Linux, and returns a static left inset on macOS.
- Added `useWcoInsets()` React hook that calls `computeInsets()`, subscribes to `geometrychange` for resize/display-scale events, and returns `{ left, right }`.
- Breadcrumb component now destructures `{ left: leftInset, right: rightInset }` from `useWcoInsets()` and applies both as inline `paddingLeft` / `paddingRight` on both render paths (empty-state and active-workspace).

### Notes on approach

- `windowControlsOverlay` is a renderer-process API exposed natively by Chromium when `titleBarOverlay` is active — no preload bridge needed.
- The existing `dragStyle()` / `noDragStyle()` inline-style pattern was already in place for macOS. Extending it to all platforms required removing the macOS guard only. No Radix primitive issues encountered — all interactive children already had `noDragStyle()` applied.
- Tailwind `app-drag` / `app-no-drag` utilities added as requested; existing components continue to use inline styles (no churn needed).
- `trafficLightPosition` uses `y: 10` (not `y: 12`) so the circles sit vertically centred in the 32px `h-8` bar (circles are ~12px, centred at 16px, top offset = 16 - 6 = 10).

### Visual verification

Manual visual OK (darwin host — macOS traffic lights render at top-left over the top-bar; no native title bar visible; drag works in empty top-bar space; room-menu button clicks register).

### Verification gate output

```
pnpm exec tsc -b --pretty false   → clean (no output)
pnpm exec eslint .                → 0 errors, 1 pre-existing warning (use-session-restore.ts react-hooks/exhaustive-deps)
pnpm exec vitest run              → 505 passed | 1 skipped (506) — baseline unchanged
pnpm run build                    → ✓ built in 1.95s
node scripts/build-electron.cjs   → [build-electron] wrote electron-dist
```

### Out-of-scope findings

- The Sidebar also uses `dragStyle()` / `noDragStyle()` (sidebar header + workspace labels). These now correctly apply drag on Windows too, which is correct behaviour — the sidebar header is part of the non-content chrome region.
- `RightRailTabs.tsx` also uses `dragStyle()` on the tab strip header — same correct widening applies.
- No resize-handle conflicts observed; Electron manages the resize border independently of the drag region at the edges.
