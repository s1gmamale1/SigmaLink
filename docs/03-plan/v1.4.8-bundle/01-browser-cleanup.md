# Packet 01 — Browser auto-spawn + `about:about` fix

**Severity**: P3 paper-cut (UX annoyance, not blocking)
**Effort**: XS (~20 min total)
**Cluster**: Browser room
**Suggested delegate**: opencode-Qwen (free, mechanical) OR Sonnet
**Depends on**: nothing
**Blocks**: nothing

## Context

Surfaced 2026-05-19 in live dogfood after v1.4.7 ship:

1. **Auto-spawn**: every time the user enters the Browser room for a workspace with zero persisted tabs, `BrowserRoom.tsx:72-83` calls `rpc.browser.openTab({ url: 'about:blank' })`. User can't glance at the Browser room without it spawning a tab.
2. **`about:about` directory page**: typing bare `about:` in the address bar and pressing Enter — `AddressBar.normalizeUrl()` passes the string through unchanged (line 31), Chromium then resolves to its internal directory page (`about:about`). Confusing and harmless but ugly.

## Files

- `app/src/renderer/features/browser/BrowserRoom.tsx` (lines 62-95) — the auto-spawn branch
- `app/src/renderer/features/browser/AddressBar.tsx` (line 31 — `normalizeUrl`)
- `app/src/main/core/browser/manager.ts` (line 88 — `DEFAULT_TAB_URL='about:blank'`, no change required)

## Fix

### Sub-task A — replace auto-spawn with EmptyState (~15 min)

In `BrowserRoom.tsx`, remove the `openTab({ url: 'about:blank' })` call from the mount-time branch. Replace with an `EmptyState` component:

```tsx
{tabs.length === 0 ? (
  <EmptyState
    title="No tabs open"
    description="Open a new tab to start browsing"
    action={
      <Button size="sm" onClick={() => void openTab(DEFAULT_TAB_URL)}>
        <Plus className="h-3.5 w-3.5" /> New tab
      </Button>
    }
  />
) : (
  <TabsGrid tabs={tabs} />
)}
```

Match the existing CommandRoom EmptyState pattern (`CommandRoom.tsx:195-208` from v1.4.3 #05). The recents strip already exists in `BrowserRoom`; keep that visible so users can click a recent origin instead.

### Sub-task B — tighten `AddressBar.normalizeUrl()` (~5 min)

In `AddressBar.tsx:31` (or wherever `normalizeUrl` lives), reject bare `about:` and any `about:<x>` other than `about:blank`:

```ts
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  // Only allow the documented about:blank; treat any other about:* as search
  if (/^about:/i.test(trimmed) && trimmed.toLowerCase() !== 'about:blank') {
    return searchUrl(trimmed); // existing fallback to the workspace's default search
  }
  // ... existing protocol/url normalization
}
```

## Tests

- `BrowserRoom.test.tsx` (if exists; otherwise NEW): assert EmptyState renders when `tabs.length === 0` and `activeWorkspace` is set; assert clicking the "New tab" button calls `rpc.browser.openTab`
- `AddressBar.test.ts` (if exists; otherwise extend `normalizeUrl` unit tests): assert `normalizeUrl("about:")` returns the search URL, `normalizeUrl("about:blank")` returns `about:blank` unchanged, `normalizeUrl("about:about")` returns the search URL

## Verification gate

```bash
cd app
pnpm exec tsc -b --pretty false
pnpm exec eslint .
pnpm exec vitest run                  # baseline preserved + new tests
pnpm run build && node scripts/build-electron.cjs
```

## Risks

- If any existing test asserts the auto-spawn (probably none, but check `git grep -l "openTab.*about:blank"`)
- If the search fallback in `normalizeUrl` doesn't exist (unlikely — address bar usually handles "is this a URL or search query"), need to add it

## Commit format

```
fix(v1.4.8): browser room EmptyState + AddressBar about: normalization

- BrowserRoom.tsx: stop auto-spawning about:blank on entry; show EmptyState
- AddressBar.tsx: route bare about:/about:about/etc through search fallback
  (only literal about:blank passes through)

Closes the v1.4.8 paper-cuts row "Browser auto-opens about:blank".
```

---

## v1.4.8 review (2026-05-19)

### State validation

| Claim in brief | Actual (HEAD d45a004) | Match? |
|---|---|---|
| Auto-spawn at `BrowserRoom.tsx:72-83` | Auto-spawn lives at lines 71-83 (one-line shift) — `if (initial.tabs.length === 0)` branch inside the hydration `useEffect` | YES (off by 1 line, logic identical) |
| `AddressBar.normalizeUrl()` at line 31 | `normalizeUrl` is a module-scope function at line 28; the permissive `about:` pass-through is line 31: `if (t.startsWith('about:') \|\| ...)` | YES (exact) |
| `manager.ts:88` — `DEFAULT_TAB_URL='about:blank'` | `DEFAULT_TAB_URL` is exported from `types.ts:33`, not `manager.ts`. Manager imports it. Line 88 of `manager.ts` is `url: r.url \|\| DEFAULT_TAB_URL` inside `hydrateFromDb()` — correct value, wrong file attribution | PARTIAL — value correct, file wrong |
| `EmptyState` not yet used in `BrowserRoom` | `EmptyState` is already imported (`line 12`) and used at lines 160-167 for the `!ws` guard — but NOT for the zero-tabs case | YES (zero-tabs EmptyState still missing) |
| `BrowserRecents` referenced as something to preserve | Already present and rendered at lines 200-206 inside the `!designActive` branch | YES |
| `TabsGrid` mentioned in the fix snippet | No `TabsGrid` component exists anywhere in `app/src/` — `BrowserRoom` renders `TabStrip` + `BrowserViewMount` side-by-side, not a grid | DRIFT — `TabsGrid` is fictional |
| Search fallback in `normalizeUrl` exists | Line 38: `return 'https://www.google.com/search?q=' + encodeURIComponent(t)` — hardcoded Google, no `searchUrl()` helper | PARTIAL — fallback exists but the proposed `searchUrl(trimmed)` call in the fix snippet doesn't match reality |
| No tests exist for browser feature | Confirmed: zero `.test.*` files under `app/src/renderer/features/browser/` | YES |
| `CommandRoom.tsx:195-208` EmptyState pattern | Actual zero-sessions EmptyState is at lines 254-280; no single 195-208 block. Pattern is still valid to follow. | LINE DRIFT only |

### Drift identified

1. **`TabsGrid` is a phantom component** — the brief's sub-task A JSX snippet references `<TabsGrid tabs={tabs} />` which does not exist. The actual render uses `<BrowserViewMount>` + `<TabStrip>` + `<BrowserRecents>`. The EmptyState must replace the zero-tab *experience*, not wrap a non-existent component.

2. **`normalizeUrl` fix references `searchUrl(trimmed)`** — no such helper. The inline fallback is the Google search string on line 38. The proposed regex-based fix must call the existing inline return, or extract an inline URL, not a named helper function.

3. **`DEFAULT_TAB_URL` file attribution** — brief says `manager.ts:88` is the definition. Actual definition is `types.ts:33`. Manager references it at line 27 (import) and line 88 (usage in `hydrateFromDb`). The brief's note "no change required" remains correct — just the source file is misattributed.

4. **`BrowserRecents` already filters `about:` URLs** — `BrowserRecents.tsx:36` has `if (!url || url.startsWith('about:')) return null` in `originOf()`. An `about:blank` tab already produces zero entries in the recents strip. Removing auto-spawn will not leave a ghost entry in recents; this is a positive confirmation.

5. **`HOME_URL` vs `DEFAULT_TAB_URL`** — the renderer defines its own `const HOME_URL = 'about:blank'` at `BrowserRoom.tsx:22`. The proposed `DEFAULT_TAB_URL` reference in the EmptyState button (`onClick={() => void openTab(DEFAULT_TAB_URL)}`) should use `HOME_URL` (already in scope) or `'about:blank'` directly, since `DEFAULT_TAB_URL` lives on the main-process side and is not available to renderer code.

6. **`handleNewTab` callback already exists** — `BrowserRoom.tsx:105-114` defines `handleNewTab` which calls `rpc.browser.openTab({ workspaceId: ws.id, url: HOME_URL })`. The EmptyState CTA should wire to `handleNewTab` directly rather than duplicating the `void openTab(...)` call shown in the snippet.

7. **`Plus` icon not imported in `BrowserRoom.tsx`** — current imports are `Globe` from `lucide-react` (line 9). The EmptyState button will need `Plus` added to the lucide import and `Button` added from `@/components/ui/button`. Both are straightforward additions.

### Updated approach

Sub-task A is still the right fix; the implementation snippet needs these corrections:

- Replace `<TabsGrid tabs={tabs} />` (phantom) with nothing — the `tabs.length === 0` check gates rendering of the existing `<BrowserViewMount>` + side panels. The EmptyState should render where the content area currently is (inside the `relative flex min-h-0 flex-1` div at line 197), guarding the `<BrowserViewMount>`.
- Use `handleNewTab` as the CTA `onClick`, not a new inline async call.
- Add `Plus` to the lucide import and `Button` from `@/components/ui/button` to BrowserRoom imports.
- The `BrowserViewMount` + `AgentDrivingIndicator` + `DesignOverlayBanner` layer should be conditionally rendered only when `tabs.length > 0`; otherwise show EmptyState in that space.

Sub-task B fix is valid but the snippet must be corrected:

```ts
// Corrected — no searchUrl() helper; inline the Google fallback
if (/^about:/i.test(trimmed) && trimmed.toLowerCase() !== 'about:blank') {
  return 'https://www.google.com/search?q=' + encodeURIComponent(trimmed);
}
```

The `chrome:` and `file:` pass-through on line 31 should remain unchanged; only the `about:*` arm needs splitting.

### Risk updates

- **Original risk 1** (existing test asserts auto-spawn): confirmed no browser tests exist, so zero test churn risk.
- **Original risk 2** (searchUrl fallback missing): fallback exists as an inline expression, not a named function. Risk is resolved; the fix snippet just needs to use the inline form.
- **New risk**: `BrowserViewMount` uses a `ResizeObserver` keyed on its DOM presence. Conditionally mounting/unmounting it on `tabs.length === 0` should be safe (the view is already parked off-screen when `visible=false`), but the implementor should verify that bouncing `BrowserViewMount` in/out doesn't fire spurious `bounds` IPC calls to the main process on first tab creation.

### Verification gate (current)

Gate is still valid as written. No changes needed:

```bash
cd app
pnpm exec tsc -b --pretty false
pnpm exec eslint .
pnpm exec vitest run
pnpm run build && node scripts/build-electron.cjs
```

Add `git grep -l "openTab.*about:blank"` before starting to catch any test references to auto-spawn across the repo.

---

## Open questions for lead

1. **EmptyState placement**: should the zero-tabs EmptyState replace only the `BrowserViewMount` content area (lines 208-211), keeping `TabStrip` and `AddressBar` visible (both disabled)? Or should it replace the entire room content below the `ErrorBanner`? Keeping the chrome visible is more consistent with the existing `CommandRoom` pattern but may look odd with a disabled address bar and empty tab strip.

2. **`BrowserViewMount` conditional mount vs show/hide**: is it acceptable to unmount `BrowserViewMount` when `tabs.length === 0`, or should the component render but receive `visible=false`? The current `BrowserViewMount` prop contract accepts `visible` for the park-off-screen path — using that avoids ResizeObserver churn.

3. **`about:` normalization scope**: should the tightened `normalizeUrl` also block `chrome:` URLs (currently passed through on line 31)? They present the same "confusing internal page" risk. Out of scope for this packet but worth flagging.
