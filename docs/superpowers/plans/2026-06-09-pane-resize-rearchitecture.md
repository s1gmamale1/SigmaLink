# Pane Resize Re-architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Command Room pane resize smooth (no glitch/oscillation) by removing the React-vs-imperative conflict at the root.

**Architecture:** Replace per-cell `flex` (a React-controlled inline style that any incidental re-render rewrites to the stale committed value) with a **CSS-Grid layout whose track sizes live in CSS custom properties** (`--pg-rows` on the grid, `--pg-cols` on each row). React's JSX only ever emits the *constant* string `var(--pg-cols)` / `var(--pg-rows)`, so reconciliation can never stomp the live size. The vars are written imperatively (the drag handler per rAF, and a `useLayoutEffect` on commit). Terminal refit defers to a `sigma:pane-resize-end` event fired on release.

**Tech Stack:** React 19, TypeScript, CSS Grid (`minmax(0,fr)`), xterm.js (cache-backed), Vitest/jsdom.

---

## Root cause (CONFIRMED via 4 parallel deep-dive agents)

1. **PRIMARY — re-render stomp.** Running terminals emit focus sequences → `sigma:pty-focus` → `dispatch(SET_ACTIVE_SESSION)` at *cursor-move frequency*. `CommandRoom` subscribes to `activeSessionId`, re-renders, re-renders non-memoized `PaneGrid`; React reconciles each cell's `style={{ flex: staleFrac }}` (and the `isActive` ring className subtree) and writes the **stale** committed flex back to the DOM — stomping the live imperative `el.style.flex` from the drag → oscillation. (`CommandRoom.tsx:46,111-121`; `PaneGrid.tsx:234-240`.)
2. **Sub-pixel flex jitter.** Fractional `flex-grow` (0.6/0.4) can round to ±1px per frame against xterm's stamped pixel content width. Grid `fr` distribution is deterministic (last track absorbs the remainder).
3. **Post-release snap.** The 60 ms refit debounce fires `term.resize` ~60 ms *after* release → a one-time content jolt.
4. **Latent:** stale-snap race (drag within ~10 ms of workspace switch corrupts other rows' persisted fracs); `parseFracs` doesn't validate array lengths.

**Invariant the fix must satisfy:** *During a drag, the size value React writes for the dragged elements must never be a stale React-owned prop.* → move size out of React's control into CSS vars React doesn't write.

---

## Task 1: Re-architect PaneGrid to CSS-Grid + CSS variables

**Files:**
- Modify: `app/src/renderer/features/command-room/PaneGrid.tsx` (full rewrite of the render + drag)
- Modify: `app/src/renderer/features/command-room/PaneGrid.test.tsx` (assert CSS var instead of flex)

- [ ] **Step 1:** Replace flex with grid. Container `display:grid; style={{gridTemplateRows:'var(--pg-rows)'}}`. Each row `display:grid; style={{gridTemplateColumns:'var(--pg-cols)'}}` + `data-testid="pane-row"`. Dividers + cells become grid-track items (auto-flow). Cells keep `min-w-0 min-h-0 overflow-hidden bg-card` + active ring + fullscreen(absolute z-50)/hidden(display:none) branches; cells carry **no size style**.
- [ ] **Step 2:** Templates: `colsTemplate(cols)=cols.map(c=>`minmax(0,${c}fr)`).join(' 1px ')`; same for rows. (1px tracks = the dividers.)
- [ ] **Step 3:** `storedRef` (synced at every mutation: KV-load + endDrag, never during render) is the authoritative base for `beginDrag`/`endDrag` → fixes the stale-snap race.
- [ ] **Step 4:** Drag writes the var imperatively: `beginDrag` captures `{kind,row,index,snap,el(container|rowEl),prop('--pg-rows'|'--pg-cols'),last}`; `applyDrag(delta)` → `el.style.setProperty(prop, template(shiftPair(snap,index,delta)))`; `endDrag` → `setStored(next)` + `persist(next)` + `dispatchEvent(new CustomEvent('sigma:pane-resize-end'))`.
- [ ] **Step 5:** `useLayoutEffect` writes `--pg-rows`/`--pg-cols` from committed `fracs`; deps `[fracsKey]` (= `JSON.stringify(fracs)`) so incidental re-renders DON'T re-run it; guard `if (dragRef.current) return;`.
- [ ] **Step 6:** `parseFracs(raw,sig,rows)` validates `rows`/`cols` lengths + numeric entries.
- [ ] **Step 7:** Update the 2 KV-seed tests to read `getByTestId('pane-row').style.getPropertyValue('--pg-cols')` contains `0.7fr` / `0.5fr`.
- [ ] **Step 8:** `npx vitest run src/renderer/features/command-room/PaneGrid.test.tsx` → PASS.

## Task 2: Defer terminal refit to drag-end

**Files:** Modify `app/src/renderer/features/command-room/Terminal.tsx`

- [ ] **Step 1:** In the RO effect add `window.addEventListener('sigma:pane-resize-end', onResizeEnd)` where `onResizeEnd` clears the debounce timer + calls `runFit()` immediately. Keep the 60 ms RO debounce for non-drag resizes (window/sidebar). Remove the listener in cleanup.

## Task 3: Gate (in MAIN working tree)

- [ ] `npx tsc -b` → 0 · `npx eslint . --max-warnings 0` → 0 · `npx vitest run` → all pass · `npm run product:check` → 0. (e2e deferred to CI — no local live app.)
- [ ] Commit on `feat/bsp-pane-tiling`.
