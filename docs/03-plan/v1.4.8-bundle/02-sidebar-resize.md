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
