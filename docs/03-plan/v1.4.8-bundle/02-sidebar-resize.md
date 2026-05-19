# Packet 02 — Sidebar resize (IDE Editor + main Sidebar)

**Severity**: P3 polish (UX request, no functional bug)
**Effort**: M (~3-5 hr total)
**Cluster**: Layout / panels
**Suggested delegate**: Sonnet (UI work, needs Pointer Events + state + kv persistence)
**Depends on**: nothing
**Blocks**: nothing

## Context

2 hardcoded panels with no user control:

1. **IDE Editor file-tree sidebar** — `EditorTab.tsx:128-139` renders `<aside style={{ width: 240 }}>`. No drag handle, no constraint, no persistence. Introduced in V3-W14-007 (`d4b2610`).
2. **Main app left Sidebar** — `Sidebar.tsx:78-81` uses Tailwind `w-14` collapsed / `w-60` expanded. Two-state only; no fine-grained user control.

Both should follow the same pattern (proven in `GridLayout.tsx` divider drag from v1.4.2 #07): stateful width + Pointer Events draggable handle + clamp + kv persistence + optional double-click reset.

## Files

- `app/src/renderer/features/editor/EditorTab.tsx` (lines 128-139)
- `app/src/renderer/features/sidebar/Sidebar.tsx` (lines 78-81)
- `app/src/renderer/features/command-room/GridLayout.tsx` (lines 91-132 — reference pattern for divider drag)
- `app/src/main/core/db/kv-controller.ts` — verify `kv.set`/`kv.get` signatures (no change required)

## Fix

### Sub-task A — IDE Editor sidebar resize (~2 hr)

In `EditorTab.tsx`:

1. Replace `style={{ width: 240 }}` with a stateful width:
   ```tsx
   const [width, setWidth] = useState<number>(240);
   useEffect(() => {
     void rpc.kv.get('editor.sidebar.width').then((v) => {
       const n = Number(v);
       if (Number.isFinite(n) && n >= 160 && n <= 600) setWidth(n);
     });
   }, []);
   ```
2. Apply via inline style: `<aside style={{ width }}>`
3. Add a 4px draggable divider sibling. Pattern from `GridLayout.tsx:91-132`:
   ```tsx
   <div
     role="separator"
     aria-orientation="vertical"
     className="w-1 cursor-col-resize hover:bg-accent active:bg-accent-emphasis"
     onPointerDown={startDrag}
     onDoubleClick={() => { setWidth(240); void rpc.kv.set('editor.sidebar.width', '240'); }}
   />
   ```
4. `startDrag` handler: capture pointer, listen for `pointermove` + `pointerup`, clamp width to `[160, 600]`, persist via `rpc.kv.set` on `pointerup` (NOT every frame — coalesce with rAF if needed)

### Sub-task B — main left Sidebar resize (~1-2 hr)

In `Sidebar.tsx`:

- Only the **expanded** state gets a resize handle. Collapsed (`w-14`) stays fixed-width.
- Same Pointer Events pattern as Sub-task A
- Persist via `kv['app.sidebar.width']`, default 240px (matches Tailwind's `w-60`), clamp `[180, 480]`
- The kv key namespace `app.*` (vs `editor.*`) keeps them independent

## Tests

- `EditorTab.test.tsx` extend: mount with mocked `rpc.kv.get` returning `'320'`, assert aside has `width: 320px`. Simulate divider `pointerdown` → `pointermove` → `pointerup` sequence, assert width updates and `rpc.kv.set` is called with the final value
- `Sidebar.test.tsx` same shape

## Verification gate

```bash
cd app
pnpm exec tsc -b --pretty false
pnpm exec eslint .
pnpm exec vitest run
pnpm run build && node scripts/build-electron.cjs
```

Plus a manual dogfood pass: drag both handles, verify smooth resize without xterm jank (the GridLayout divider already addresses rAF coalesce for terminal fits, but be aware the Sidebar resize affects the entire renderer tree — keep the drag handler cheap)

## Risks

- **xterm jank during Sidebar drag**: changing the main left Sidebar width changes the available width for the CommandRoom pane grid. Each xterm pane has a `ResizeObserver` that schedules a `fit.fit()` 25ms after last resize. A 200ms drag could trigger 8+ fits. Use rAF coalescing in `startDrag` similar to `GridLayout.tsx`'s pattern.
- **Collapsed state interaction**: when Sidebar is collapsed and user drags toward expansion, decide: snap to expanded at threshold? gradient? Keep simplest behavior first — only allow drag when expanded.
- **kv key migration**: if anyone previously stored a width under a different key, decide whether to migrate. Probably nothing exists; verify with `git grep kv.*sidebar`.

## Commit format (2 commits per sub-task)

```
feat(v1.4.8): IDE Editor sidebar resize handle + persistence

- EditorTab.tsx: stateful width (160-600px clamp), 4px drag divider,
  double-click reset to 240px default
- Persist via kv['editor.sidebar.width']
- rAF-coalesce drag updates to avoid blocking layout
```

```
feat(v1.4.8): main Sidebar resize handle on expanded state

- Sidebar.tsx: drag handle on expanded state only (180-480px clamp)
- Persist via kv['app.sidebar.width']
- Collapsed state unchanged (w-14)
```

---

## v1.4.8 review (2026-05-19)

### State validation

**EditorTab.tsx lines 128–139** — confirmed. `<aside style={{ width: 240 }}>` is exactly as the brief describes. Line numbers are accurate; the flex container at line 127 (`flex h-full min-h-0 flex-row`) is the natural mount point for the drag divider sibling. No intervening changes since the brief was written.

**Sidebar.tsx lines 78–81** — confirmed. The `<aside>` uses `cn('... transition-[width] duration-200 ease-out', collapsed ? 'w-14' : 'w-60')`. Two-state only; no width state. The `transition-[width]` CSS transition class is live on this element today (see drift note below).

**GridLayout.tsx lines 91–132 (reference pattern)** — confirmed accurate. The `startDrag` implementation spans lines 139–205 (the brief's range 91–132 covers the fracs state init and pre-drag setup; the actual drag logic is lines 139–205). The rAF coalesce, `document.body.dataset.dragging` signal to Terminal.tsx, and synchronous flush on pointerup are all present and directly reusable.

**kv-controller.ts** — signatures confirmed. `kv.get(key: string): Promise<string | null>` and `kv.set(key: string, value: string): Promise<void>`. The set implementation coerces non-strings via `String(value ?? '')`, so passing `String(width)` is correct. The keys `editor.sidebar.width` and `app.sidebar.width` do not exist anywhere in the codebase (`git grep` found only `app.sidebar.collapsed`); no migration needed.

**boot hydration** — `use-session-restore.ts` currently loads only `app.onboarded` and `app.sidebar.collapsed` via `BOOT_UI`. The brief proposes local component state (a `useState` + `useEffect` in each component), NOT a global AppState field. This is the right call: `sidebarWidth` is not in `AppState` and adding it there would require a new action, reducer branch, and hydration path. Keep width local to each component.

**tailwind.config.js** — `tw-animate-css` is listed in `package.json` devDependencies (`^1.4.0`) but is NOT referenced in `tailwind.config.js` (which uses only `tailwindcss-animate`). The brief does not reference `tw-animate-css` at all — no correction needed there.

**`accent-emphasis` token** — the brief's drag-divider snippet uses `active:bg-accent-emphasis`. This token does NOT exist in `tailwind.config.js` or `src/index.css`. The config defines `accent.DEFAULT` and `accent.foreground` only. Use `active:bg-accent/70` or `active:bg-accent` instead (same pattern as the existing dividers in GridLayout, which use no explicit active color — just the hover state).

### Drift

1. **`transition-[width] duration-200`** is currently on the Sidebar `<aside>`. When a drag handle is added and width is driven by inline `style={{ width }}`, this CSS transition will animate every pixel of drag movement, creating a ~200ms lag that makes the handle feel broken. The transition must be suppressed during drag (e.g. add `data-dragging` to the element and use `[[data-dragging]&]:transition-none`, or conditionally omit the Tailwind transition class while `isDragging` state is true). The brief does not mention this — add to the fix steps.

2. **`tw-animate-css` devDep present but unused in config** — the brief says nothing about it. No action for this packet; it is a stale devDep (separate cleanup concern, not blocking).

3. **GridLayout `startDrag` is line 139, not line 91** — the brief says "reference pattern for divider drag" at lines 91–132, but the actual drag handler starts at 139. The setup state (fracs, refs) is at 85–93; the fullscreen logic is 95–108; the keyboard shortcut effect is 110–125. The drag implementation proper is 127–205. Not a blocking error — the file reference is still useful — but the implementer should read to line 205.

### Updated approach

- Sub-task A (EditorTab): no structural changes needed. Add `isDragging` state ref (not React state — a `useRef<boolean>`) so the drag handler can suppress unnecessary re-renders. Use `useRef` for the rAF handle. Width state via `useState`. kv load in `useEffect([], [])`.
- Sub-task B (Sidebar): must suppress `transition-[width]` during drag. Simplest approach: track an `isDragging` boolean in a `useRef` and toggle a `dragging` data-attribute on the `<aside>` element, then add `data-[dragging=true]:transition-none` to the className. Alternative: conditionally exclude the transition classes from `cn(...)` when a `isDraggingState` React state boolean is true (triggers one extra render on pointerdown/pointerup, acceptable).

### Risk updates

- **New risk — Sidebar CSS transition conflict**: HIGH probability of causing a jank/lag perception during drag if not addressed. Add transition suppression as a required step (not optional polish).
- **xterm jank risk** (existing): still valid. The `document.body.dataset.dragging` signal already used by GridLayout should be set here too; Terminal.tsx already reads it to relax the fit debounce.
- **kv key migration**: confirmed no existing keys to migrate. Risk is resolved.

### Verification gate

Gate in the brief is correct. Add one manual check: verify that dragging the Sidebar handle shows no CSS transition lag (the handle should track the pointer without delay).

---

## Open questions

1. **Sidebar `transition-[width]` suppression method** — conditional class removal (one extra React render per drag start/end) vs. `data-attribute` + Tailwind `data-*` variant. Either is acceptable; pick one approach and apply it consistently across both components.
2. **Sidebar width and the auto-collapse breakpoint** — `Sidebar.tsx` has a `COLLAPSE_BREAKPOINT_PX = 1100` listener that force-collapses when `window.innerWidth < 1100`. If the user drags the sidebar to 480px on a 1200px window, then resizes the window to 1090px, the sidebar collapses and the persisted width is irrelevant until re-expanded. On re-expansion, should it restore the persisted width (yes — that is what `useEffect` on mount will do) or reset to 240px default? The brief's current approach (load from kv on mount) handles this correctly without special-casing.
