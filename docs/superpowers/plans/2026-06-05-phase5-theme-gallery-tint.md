# Phase 5 — Theme Gallery (BSP-T3) + Per-Workspace Tint (BSP-T4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development / superpowers:executing-plans to implement task-by-task. ALSO invoke the **frontend-design** and **apple-design** (foundations/materials) skills for the gallery cards + tint visuals — this is a visual-quality feature for an operator who cares about Apple-grade UI. Steps use `- [ ]` checkboxes.

**Goal:** Turn the AppearanceTab theme picker into a responsive **card gallery** (mini mock-UI preview per theme + All/Dark/Light filter + search + ✓ ACTIVE), and let each workspace carry its own **tint** (a picked hue → `--accent` + a subtle `--surface-tint`), persisted per-workspace and applied on workspace switch without leaking across workspaces or touching the global theme.

**Architecture:** Renderer-only (React 19 + Tailwind). Themes live in `src/renderer/lib/themes.ts` (`THEMES`, `applyTheme`, `setRootCssVar`, KV key `app.theme`). Theme = `data-theme` attribute + CSS token blocks in `src/index.css`. Per-workspace state uses the established `ui.<wsId>.<panel>` convention (`src/renderer/lib/workspace-ui-kv.ts`, `readWorkspaceUi`/`writeWorkspaceUi` over `rpcSilent`). Tint is applied as **inline `documentElement.style.setProperty`** (higher specificity than the `[data-theme]` attribute blocks; never mutates `app.theme`) and cleared on workspace switch. Tests are vitest; renderer files use `// @vitest-environment jsdom`.

**Tech Stack:** TypeScript, React 19, Tailwind, vitest, `lucide-react` icons.

**Locked decisions (operator):**
1. Cards depict a **mini mock-UI chrome** (fake sidebar + pane + accent button + text rows) painted from `theme.swatch` hexes via inline style — static, lazy-mounted; NOT a real `data-theme` subtree (render-cost).
2. Per-workspace tint is set in a **"This workspace" section inside AppearanceTab**, rendered only when a workspace is active.
3. Tint = override `--accent` to the picked hue **and** a subtle surface hue via a new `--surface-tint` (one hue drives both); default `--surface-tint` is a **no-op**.

**Single lane** (no parallelization): BSP-T3 + BSP-T4 both edit `AppearanceTab.tsx`, `themes.ts`, `index.css` — file-overlapping, so execute sequentially in one worktree.

> Verify line numbers against current code (main HEAD `c1200f2`); recon anchors below.

---

## Deliverable 1 — BSP-T3 theme card gallery

**Files:**
- Create: `src/renderer/features/settings/ThemePreviewCard.tsx`
- Create: `src/renderer/features/settings/ThemeGallery.tsx` (filter + search + grid; keeps AppearanceTab lean)
- Create: `src/renderer/features/settings/ThemeGallery.test.tsx`
- Modify: `src/renderer/features/settings/AppearanceTab.tsx` (replace the theme-button grid ~lines 108-137 with `<ThemeGallery>`)
- Maybe modify: `src/renderer/lib/themes.ts` (add a `themeFamily(id)` helper if useful — derive `'glass' | 'clean' | 'classic'` from the id prefix)

### Task 1: `ThemePreviewCard` — selectable mini mock-UI card

**Pattern to follow:** `features/workspace-launcher/IntentCards.tsx:97-134` — `<button aria-pressed={active}>` with `border-ring bg-accent/10` selected, `border-border bg-card/40 hover:border-ring/50` unselected, GPU hover lift `hover:-translate-y-0.5 transition-[transform] duration-200 ease-[var(--ease-smooth)]`. Use the **apple-design/frontend-design skills** for the mock-UI composition + spacing.

- [ ] **Step 1: Write the failing test** (`ThemeGallery.test.tsx`, first case targets the card)

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemePreviewCard } from './ThemePreviewCard';
import { THEMES } from '@/renderer/lib/themes';

describe('ThemePreviewCard', () => {
  it('renders the theme label, marks ACTIVE when selected, and is an aria-pressed button', () => {
    const glass = THEMES.find((t) => t.id === 'glass')!;
    render(<ThemePreviewCard theme={glass} active onSelect={() => {}} />);
    const btn = screen.getByRole('button', { name: new RegExp(glass.label, 'i') });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/active/i)).toBeTruthy();
  });

  it('calls onSelect(id) when clicked', () => {
    const clean = THEMES.find((t) => t.id === 'clean')!;
    const onSelect = vi.fn();
    render(<ThemePreviewCard theme={clean} active={false} onSelect={onSelect} />);
    screen.getByRole('button', { name: new RegExp(clean.label, 'i') }).click();
    expect(onSelect).toHaveBeenCalledWith('clean');
  });
});
```

- [ ] **Step 2: Run → fail** — `npx vitest run src/renderer/features/settings/ThemeGallery.test.tsx` (module missing).

- [ ] **Step 3: Implement `ThemePreviewCard.tsx`**

Props: `{ theme: ThemeDefinition; active: boolean; onSelect: (id: ThemeId) => void }`. Render a `<button aria-pressed={active} data-testid={`theme-card-${theme.id}`}>` containing:
- A **mini mock-UI preview** built from `theme.swatch` (`bg`, `fg`, `primary`, `accent`) applied as **inline `style`** (so it paints in the theme's colors WITHOUT a real `data-theme` subtree): a small rounded rectangle ≈ `aspect-[16/10]`, `background: swatch.bg`, containing a faux sidebar strip (a `swatch.primary`/`fg`-tinted column), a faux pane with 2-3 text rows (`swatch.fg` at low opacity) and one small `accent`-colored "button" pill. Keep it pure markup + inline styles (lazy/cheap).
- The `theme.label` + `theme.description`.
- A ✓ ACTIVE badge (lucide `Check`) when `active` (reuse the existing badge styling vibe; text "ACTIVE").
- Selected vs unselected border/bg per the IntentCards pattern.
Call `onSelect(theme.id)` on click.

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(settings): ThemePreviewCard — selectable mini mock-UI theme preview (BSP-T3)"`

### Task 2: `ThemeGallery` — filter + search + grid; wire into AppearanceTab

- [ ] **Step 1: Extend the failing test** with gallery behavior

```tsx
import { ThemeGallery } from './ThemeGallery';
import { fireEvent } from '@testing-library/react';

describe('ThemeGallery', () => {
  it('All/Dark/Light filter narrows by appearance', () => {
    render(<ThemeGallery current="glass" onSelect={() => {}} />);
    // default All → both a known dark (glass) and the known light (clean-light) present
    expect(screen.getByTestId('theme-card-glass')).toBeTruthy();
    expect(screen.getByTestId('theme-card-clean-light')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^light$/i }));
    expect(screen.queryByTestId('theme-card-glass')).toBeNull();        // dark hidden
    expect(screen.getByTestId('theme-card-clean-light')).toBeTruthy();  // light kept
  });

  it('search narrows by label/description/id', () => {
    render(<ThemeGallery current="glass" onSelect={() => {}} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'parchment' } });
    expect(screen.getByTestId('theme-card-parchment')).toBeTruthy();
    expect(screen.queryByTestId('theme-card-glass')).toBeNull();
  });

  it('marks the current theme ACTIVE and calls onSelect on a card click', () => {
    const onSelect = vi.fn();
    render(<ThemeGallery current="glass" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('theme-card-nord'));
    expect(onSelect).toHaveBeenCalledWith('nord');
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `ThemeGallery.tsx`**

Props: `{ current: ThemeId; onSelect: (id: ThemeId) => void }`. Local state: `filter: 'all'|'dark'|'light'` (default `'all'`), `query: string`. Render:
- A segmented filter control (All / Dark / Light) — three `aria-pressed` buttons; `aria-label="Filter themes by appearance"`.
- A search `<input type="search">` (role `searchbox`), placeholder "Search themes…".
- A responsive grid (`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3`) of `<ThemePreviewCard>` for the filtered+searched `THEMES`. Filter: `filter==='all' || t.appearance===filter`. Search: case-insensitive match on `label`/`description`/`id`. `active={t.id===current}`.
Use frontend-design/apple-design for the segmented control + search field styling.

- [ ] **Step 4: Wire into AppearanceTab.** Replace the theme-button grid block (`AppearanceTab.tsx` ~108-137) with `<ThemeGallery current={theme} onSelect={setTheme} />`. KEEP the surrounding `<section>` header + the "Reset to default" button (`aria-label="Reset theme to default"`, ~line 101) intact. `theme` + `setTheme` come from the existing `useTheme()`.

- [ ] **Step 5: Run gallery + existing theme tests → pass.**

Run: `npx vitest run src/renderer/features/settings src/renderer/lib/themes.test.ts`
Expected: PASS (themes.test.ts CSS-drift guard unaffected — no `data-theme` blocks changed).

- [ ] **Step 6: Commit** — `git commit -m "feat(settings): theme card gallery with All/Dark/Light filter + search (BSP-T3)"`

---

## Deliverable 2 — BSP-T4 per-workspace tint

**Files:**
- Modify: `src/index.css` (add the `--surface-tint` base token + a subtle no-op-by-default chrome mix)
- Create: `src/renderer/lib/workspace-tint.ts` (pure helpers: `applyTint`, `clearTint`, types) + `workspace-tint.test.ts`
- Create: `src/renderer/app/useWorkspaceTint.ts` (hook reacting to active workspace) — or fold into `ThemeProvider.tsx`
- Modify: `src/renderer/app/App.tsx` (mount the hook with `activeWorkspaceId`) OR `ThemeProvider.tsx`
- Modify: `src/renderer/features/settings/AppearanceTab.tsx` (the "This workspace" tint section + its test)
- Create/extend: `src/renderer/features/settings/WorkspaceTintSection.tsx` + test

### Task 3: `--surface-tint` token + subtle chrome wiring (no-op by default)

- [ ] **Step 1: Add the token + chrome mix in `index.css`.**

In `:root` (after the existing surface/accent tokens), add a **no-op default**:
```css
/* Per-workspace tint hue (BSP-T4). Default is a no-op (mixes the surface with
   itself). The workspace-tint hook overrides --surface-tint inline to a chosen
   hue; the chrome surfaces below then pick up a subtle wash of it. */
--surface-tint: var(--surface);
```
Apply a **subtle** mix on a couple of chrome surfaces only (sidebar + the app chrome header/border — NOT content panes, to protect readability). Use `color-mix` so default (`--surface-tint: var(--surface)`) is a true no-op:
```css
/* example — adapt selectors to the real sidebar/header classes */
.sl-sidebar-surface { background: color-mix(in oklab, var(--surface) 90%, var(--surface-tint) 10%); }
```
> Find the real sidebar/header surface selectors (recon: `Sidebar.tsx`, the chrome). Apply the mix to ≤2 chrome surfaces; keep it ≤10–12%. Use **apple-design-foundations** for the hue/contrast judgment. Do NOT tint content panes or text backgrounds.

- [ ] **Step 2: Verify the drift guard still passes** — `npx vitest run src/renderer/lib/themes.test.ts` (it only checks `data-theme` selector presence; adding a `:root` token + a class mix is unaffected). Expected: PASS.

- [ ] **Step 3: Commit** — `git commit -m "feat(theme): --surface-tint token + subtle no-op-by-default chrome wash (BSP-T4)"`

### Task 4: tint helpers + `useWorkspaceTint` hook

**Tint value shape:** `{ accent: string }` (a single hex hue; surface-tint is set to the same hue — the CSS mixes it at low %). Persisted at `ui.<wsId>.tint` via `writeWorkspaceUi(wsId, 'tint', JSON.stringify({accent}))`.

- [ ] **Step 1: Write the failing test** (`workspace-tint.test.ts`)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { applyTint, clearTint, parseTint } from './workspace-tint';

describe('workspace-tint', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--surface-tint');
  });
  it('applyTint sets --accent and --surface-tint inline', () => {
    applyTint({ accent: '#b966f5' });
    const s = document.documentElement.style;
    expect(s.getPropertyValue('--accent').trim()).toBe('#b966f5');
    expect(s.getPropertyValue('--surface-tint').trim()).toBe('#b966f5');
  });
  it('clearTint removes the inline overrides (reverting to theme defaults)', () => {
    applyTint({ accent: '#b966f5' });
    clearTint();
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--surface-tint')).toBe('');
  });
  it('parseTint validates a hex accent and rejects junk', () => {
    expect(parseTint(JSON.stringify({ accent: '#abc123' }))?.accent).toBe('#abc123');
    expect(parseTint('not json')).toBeNull();
    expect(parseTint(JSON.stringify({ accent: 'red; }html{}' }))).toBeNull(); // reject non-hex (CSS-injection guard)
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `workspace-tint.ts`**

```ts
export interface WorkspaceTint { accent: string; }
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function parseTint(raw: string | null | undefined): WorkspaceTint | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { accent?: unknown };
    if (typeof v.accent === 'string' && HEX.test(v.accent)) return { accent: v.accent };
  } catch { /* fallthrough */ }
  return null;
}
export function applyTint(t: WorkspaceTint): void {
  const s = document.documentElement.style;
  s.setProperty('--accent', t.accent);
  s.setProperty('--surface-tint', t.accent);
}
export function clearTint(): void {
  const s = document.documentElement.style;
  s.removeProperty('--accent');
  s.removeProperty('--surface-tint');
}
```
> The HEX validation is a **CSS-injection guard** — never write an unvalidated string into `style.setProperty`.

- [ ] **Step 4: Implement `useWorkspaceTint(activeWorkspaceId)`** (`src/renderer/app/useWorkspaceTint.ts`)

Mirror the Sidebar rail-width model (`Sidebar.tsx:61-80`). On `activeWorkspaceId` change: if null → `clearTint()`; else `readWorkspaceUi(wsId, 'tint').then(raw => { const t = parseTint(raw); t ? applyTint(t) : clearTint(); })`. Also re-run `clearTint()` on unmount. **Re-apply when the global theme changes:** depend on `useTheme().theme` too, so that after the global theme switches, a still-active workspace tint is re-applied on top (read the current ws tint again and re-apply, else clear). Mount the hook in `App.tsx` near `ThemeProvider`, fed by `activeWorkspaceId` from app state.

```ts
export function useWorkspaceTint(activeWorkspaceId: string | null): void {
  const { theme } = useTheme();
  useEffect(() => {
    let alive = true;
    if (!activeWorkspaceId) { clearTint(); return; }
    void readWorkspaceUi(activeWorkspaceId, 'tint').then((raw) => {
      if (!alive) return;
      const t = parseTint(raw);
      if (t) applyTint(t); else clearTint();
    });
    return () => { alive = false; };
  }, [activeWorkspaceId, theme]);
}
```

- [ ] **Step 5: Run → pass** — `npx vitest run src/renderer/lib/workspace-tint.test.ts`

- [ ] **Step 6: Commit** — `git commit -m "feat(theme): useWorkspaceTint applies/clears per-workspace tint on switch (BSP-T4)"`

### Task 5: "This workspace" tint section in AppearanceTab

- [ ] **Step 1: Write the failing test** (`WorkspaceTintSection.test.tsx`)

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceTintSection } from './WorkspaceTintSection';

// mock workspace-ui-kv write + the tint apply
const writes: Array<[string, string, string]> = [];
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  writeWorkspaceUi: (ws: string, panel: string, val: string) => { writes.push([ws, panel, val]); },
  readWorkspaceUi: async () => null,
}));

describe('WorkspaceTintSection', () => {
  beforeEach(() => { writes.length = 0; });
  it('renders nothing when no workspace is active', () => {
    const { container } = render(<WorkspaceTintSection activeWorkspaceId={null} />);
    expect(container.firstChild).toBeNull();
  });
  it('writes ui.<ws>.tint with the picked accent when active', () => {
    render(<WorkspaceTintSection activeWorkspaceId="ws1" />);
    const picker = screen.getByLabelText(/workspace tint/i);
    fireEvent.change(picker, { target: { value: '#b966f5' } });
    expect(writes.some(([ws, panel, val]) => ws === 'ws1' && panel === 'tint' && val.includes('b966f5'))).toBe(true);
  });
  it('reset clears the per-workspace tint', () => {
    render(<WorkspaceTintSection activeWorkspaceId="ws1" />);
    fireEvent.click(screen.getByRole('button', { name: /reset to global/i }));
    // writes an empty/cleared tint (e.g. removeWorkspaceUi or a write of '') + clears inline vars
    expect(writes.some(([ws, panel]) => ws === 'ws1' && panel === 'tint')).toBe(true);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `WorkspaceTintSection.tsx`**

Props: `{ activeWorkspaceId: string | null }`. If `!activeWorkspaceId` → return `null`. Else render a `<section>` "This workspace" with:
- `aria-label="Workspace tint"` color `<input type="color">` (or a small preset hue row + a custom `<input type=color>`), seeded from the current `ui.<ws>.tint` (read on mount).
- On change: `applyTint({accent})` immediately + `writeWorkspaceUi(ws, 'tint', JSON.stringify({accent}))`.
- A "Reset to global" button: `clearTint()` + persist the cleared state (write `''` / a sentinel that `parseTint` treats as null, OR add `removeWorkspaceUi`). Keep it consistent with how `useWorkspaceTint` reads (parseTint('') → null → clear).
- Copy: one tasteful line explaining the tint only affects this workspace (apple-design-tactics voice).

Mount `<WorkspaceTintSection activeWorkspaceId={activeWorkspaceId} />` inside AppearanceTab (after the gallery). Source `activeWorkspaceId` from app state (the same selector App.tsx uses for the hook).

- [ ] **Step 4: Run → pass** — `npx vitest run src/renderer/features/settings`

- [ ] **Step 5: Commit** — `git commit -m "feat(settings): per-workspace tint section in AppearanceTab (BSP-T4)"`

---

## Lane gate (run in the worktree, then the lead re-gates in main)

```bash
cd /Users/aisigma/projects/SigmaLink/app
npx tsc -b && npx vitest run src/renderer/features/settings src/renderer/lib src/renderer/app && npm run lint
```
Then capture the diff incl. new files: `git -C <wt> add -A && git -C <wt> diff --cached HEAD`.

## Definition of done (ROADMAP)
Gallery shows every theme as a preview card; All/Dark/Light filter + search narrow; selecting sets the theme (✓ ACTIVE on current); a workspace's tint persists, applies on open, **clears on switch to another workspace** (no leak), and never changes the global `app.theme`; default `--surface-tint` is a visual no-op; `tsc -b` · vitest · lint · build · full `tests/e2e/` green.

## Self-review
- **Coverage:** BSP-T3 (Tasks 1-2: card + gallery + filter/search + AppearanceTab wire). BSP-T4 (Tasks 3-5: token + hook + section). ✓
- **No-leak invariant:** tint via inline `style` + `clearTint` on `[activeWorkspaceId]` change; global theme KV untouched. ✓
- **Injection guard:** `parseTint` HEX-validates before `setProperty`. ✓
- **Drift guard:** no `data-theme` blocks added → `themes.test.ts` unaffected. ✓
- **Visual quality:** coder MUST use frontend-design + apple-design for the cards + tint wash. ✓
