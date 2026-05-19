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
