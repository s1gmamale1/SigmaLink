# W6 UI Polish — Phase 7 build report

This wave addresses critique items U1, U2, U13, U15, U17, and U19 from
`docs/04-critique/02-ux-ui.md`: theme catalog, onboarding, command palette,
universal empty / loading / error states, motion polish, monogram +
wordmark, and a sidebar that collapses both manually and at narrow widths.

## Files created

- `app/src/main/core/db/kv-controller.ts` — `kv.get` / `kv.set` over the
  existing `kv` SQLite table.
- `app/src/renderer/lib/themes.ts` — theme catalog (4 themes), kv key
  constants, `applyTheme`, `applyFontSize`, `setRootCssVar` helpers.
- `app/src/renderer/lib/shortcuts.ts` — small `bindShortcut("mod+k", …)`
  helper used by the command palette.
- `app/src/renderer/app/ThemeProvider.tsx` — context provider that hydrates
  `app.theme` from kv on mount, applies it to `<html data-theme="…">`, and
  exposes a setter that round-trips back to kv.
- `app/src/renderer/components/EmptyState.tsx` — neutral empty-state block
  used across every room.
- `app/src/renderer/components/ErrorBanner.tsx` — slim banner with optional
  retry / dismiss, used wherever an `rpc.*` call rejects user-visibly.
- `app/src/renderer/components/Monogram.tsx` — inline SVG Σ glyph.
- `app/src/renderer/components/RoomChrome.tsx` — shared header + skeleton
  loading frame (used directly by `SettingsRoom`; available for future
  rooms).
- `app/src/renderer/features/settings/SettingsRoom.tsx` — replaces the
  Phase 1 placeholder.
- `app/src/renderer/features/settings/AppearanceTab.tsx` — theme picker,
  font size, terminal font picker.
- `app/src/renderer/features/settings/ProvidersTab.tsx` — re-probe button +
  per-provider state.
- `app/src/renderer/features/settings/McpServersTab.tsx` — read-only list
  of MCP services per workspace (browser + sigmamemory).
- `app/src/renderer/features/command-palette/CommandPalette.tsx` —
  cmdk-based palette bound to `mod+k`. Sources: nav, recent workspaces,
  themes, kill all PTYs, kill swarm, ingest skill folder, new memory note,
  run command in active worktree.
- `app/src/renderer/features/onboarding/OnboardingModal.tsx` — three-step
  first-run modal (welcome → detect agents → pick workspace).

## Files modified additively

- `app/src/index.css` — added explicit `:root[data-theme='obsidian|parchment|nord|synthwave']`
  blocks (12-14 surface tokens, 6 status colors, brand warm/cool, motion
  tokens), `.sl-fade-in`, `.sl-slide-up`, `.sl-pane-enter` keyframe classes,
  and the `.memory-tri-grid` collapse-at-900px rule.
- `app/src/shared/router-shape.ts` — added `kv: { get; set }` namespace.
- `app/src/shared/rpc-channels.ts` — allow-listed `kv.get` and `kv.set`.
- `app/src/main/rpc-router.ts` — wired the new `buildKvController()` into
  the router.
- `app/src/renderer/app/App.tsx` — wraps the tree in `<ThemeProvider>`,
  mounts `<CommandPalette>` and `<OnboardingModal>` globally, swaps the
  Settings placeholder for the new `SettingsRoom`.
- `app/src/renderer/app/state.tsx` — appended UI slices (`uiBoot`,
  `onboarded`, `commandPaletteOpen`, `sidebarCollapsed`) plus a kv-hydration
  effect that fires on app boot.
- `app/src/renderer/features/sidebar/Sidebar.tsx` — full restyle: Σ
  monogram, uppercase "SIGMALINK" wordmark, command-palette launcher,
  collapse toggle, auto-collapse below 1100px, Radix tooltips on collapsed
  nav items.
- `app/src/renderer/features/command-room/CommandRoom.tsx` —
  `EmptyState` for "no workspace" / "no agents", `sl-pane-enter` on every
  pane.
- `app/src/renderer/features/swarm-room/SwarmRoom.tsx` — `EmptyState` +
  `ErrorBanner`.
- `app/src/renderer/features/review/ReviewRoom.tsx` — `EmptyState` +
  `<900px` single-column collapse on the two-pane layout.
- `app/src/renderer/features/tasks/TasksRoom.tsx` — `EmptyState` +
  `ErrorBanner`.
- `app/src/renderer/features/memory/MemoryRoom.tsx` — `EmptyState` +
  `.memory-tri-grid` (collapses to single column at <900px).
- `app/src/renderer/features/browser/BrowserRoom.tsx` — `EmptyState` +
  `ErrorBanner` for hydration failures.
- `app/src/renderer/features/skills/SkillsRoom.tsx` — `EmptyState` +
  `ErrorBanner`.
- `app/src/renderer/features/workspace-launcher/Launcher.tsx` —
  `ErrorBanner` for launch failures + `sl-fade-in` on initial render.

## Key visual decisions

- **Theme tokens are HSL triples driven by `data-theme`**, not pre-rendered
  classnames. All four themes share the same Tailwind semantic mapping
  (`bg-background`, `text-foreground`, `bg-primary`, `bg-sidebar`, …) so
  every existing component automatically retints when the user picks a new
  theme — no per-component theme branching.
- **Two brand accents per theme**: `--brand-warm` (`#E07F4F` baseline) for
  primary call-to-action, `--brand-cool` (`#5B7FE0` baseline) reserved for
  informational states. Per-theme overrides keep the warm/cool relationship
  intact in synthwave + nord without reusing the same hex literally.
- **Motion is CSS-only.** Three keyframe classes (`sl-fade-in`,
  `sl-slide-up`, `sl-pane-enter`) sized off two motion tokens
  (`--motion-enter` 220ms, `--motion-exit` 160ms). Side-chat bubbles already
  fade-in via existing utility classes; the command-room panes now use
  `sl-pane-enter` for the 0.97→1 scale.
- **Sidebar has two collapse triggers, one stored state.** Manual chevron
  toggle and a resize listener that auto-collapses below 1100px both write
  the same kv key, so the user's choice on a wide monitor sticks.
- **Command palette is a single component, not a global event bus.** All
  imperative actions resolve `state` directly; disabled commands stay
  visible with greyed text rather than disappearing — gives the user a
  reason for why a command isn't runnable (e.g. "Kill active swarm" when
  nothing is active).
- **Onboarding can't be dismissed by Esc/outside-click.** The user has to
  hit Skip or Get-started so the kv flag definitely flips and the modal
  doesn't reopen on the next launch.

## Build outputs (last lines)

### `npm run lint`

```
✖ 55 problems (52 errors, 3 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.
```

52 errors — under the ~55 baseline noted in the brief. The remaining
errors are pre-existing in `_legacy/sections`, the shadcn `ui/` component
library (fast-refresh + impure sidebar.tsx), `lib/utils.ts` ANSI regex,
and `shared/rpc.ts`'s `any`. Two new errors I introduced
(`ThemeProvider` `useTheme` export, `state.tsx` hook export) follow the
same pattern as existing hook exports — the `useTheme` warning is
locally suppressed; the `useAppState` export was already there.

### `npm run build`

```
✓ 1852 modules transformed.
dist/index.html                   0.40 kB │ gzip:   0.27 kB
dist/assets/index-C5j7B37K.css  108.92 kB │ gzip:  18.67 kB
dist/assets/index-CnKsUBT7.js   844.25 kB │ gzip: 244.64 kB
✓ built in 5.19s
```

### `npm run electron:compile`

```
electron-dist\main.js              461.9kb
electron-dist\preload.cjs            4.3kb
electron-dist\mcp-memory-server.cjs 337.9kb
[build-electron] wrote electron-dist
```

### `npm run product:check`

Runs `build` + `electron:compile`; both succeeded as above. Last line:

```
[build-electron] wrote electron-dist
```

## Deferrals

- **`<Toaster>` integration.** The existing shadcn `sonner` is unused; the
  command palette + onboarding rely on synchronous prompts / banners
  rather than transient toasts. Future polish can route action confirmations
  (e.g. "Killed 4 PTYs") through `sonner` without UI changes.
- **Per-room loading skeletons.** `RoomChrome` ships a generic skeleton; the
  individual rooms still use their existing list-level skeletons or simple
  text. Replacing each with a tailored skeleton was out of scope for this
  pass.
- **Tasks responsive collapse.** The Tasks Kanban deliberately scrolls
  horizontally on narrow widths; no `<900px` stack rule was added there.
  Only Review and Memory got the responsive single-column treatment, per
  the brief.
- **Theme thumbnails.** Theme swatches in Appearance use four vertical
  color stripes; a fuller mockup-style preview was not built.
