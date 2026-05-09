# W6 — Browser Room Build Report (Phase 3)

Status: complete. All four build checks (`npm run build`, `npm run electron:compile`, `npm run product:check`, `npm run lint`) green. Lint baseline preserved at 56 problems / 53 errors / 3 warnings — identical to W5/W6a (no new lint regressions).

## 1. Files created (new in this wave)

| Path | Purpose |
|---|---|
| `app/src/main/core/browser/types.ts` | Re-exports `BrowserTab`, `BrowserState`, `LockOwner`, `TabId`, `WorkspaceId` from `shared/types`; defines `Bounds` and the `DEFAULT_TAB_URL = 'about:blank'` constant. |
| `app/src/main/core/browser/cdp.ts` | `attachDebugger(view)` and `runCDP(view, method, params)` helpers wrapping `webContents.debugger.attach('1.3')`. Uses a `WeakSet` to memoize attachments and detaches automatically on `webContents.destroyed`. Returns `false` (not throw) when DevTools is already open so callers can fall through. |
| `app/src/main/core/browser/playwright-supervisor.ts` | `PlaywrightMcpSupervisor` class. Allocates a free TCP port on 127.0.0.1, spawns `npx -y @playwright/mcp@latest --port <n>`, supervises with up to 3 respawns at 1.5 s × restartCount backoff, and exposes `start(workspaceId)` / `stop(workspaceId)` / `stopAll()` / `getMcpUrl(workspaceId)`. |
| `app/src/main/core/browser/manager.ts` | `BrowserManager` (per-workspace) plus the `BrowserManagerRegistry`. The manager owns the `WebContentsView` per tab, lazy-creates views on activation, attaches them to `mainWindow.contentView`, and applies bounds via `view.setBounds`. State changes emit `state` for the router. The registry holds singletons keyed by `workspaceId` and pipes their `state` events into a single `onState` callback the router converts into the IPC `browser:state` event. |
| `app/src/main/core/browser/controller.ts` | `buildBrowserController({ registry })`. 16 RPC methods: `openTab`, `closeTab`, `navigate`, `back`, `forward`, `reload`, `stop`, `listTabs`, `getActiveTab`, `setActiveTab`, `setBounds`, `getState`, `claimDriver`, `releaseDriver`, `getMcpUrl`, `teardown`. `openTab` and `getMcpUrl` lazily ensure the supervisor is up. |
| `app/src/main/core/browser/mcp-config-writer.ts` | `writeMcpConfigForAgent({ worktree, mcpUrl })` writes Claude (`<worktree>/.mcp.json`), Codex (`~/.codex/config.toml` with `# sigmalink-browser` marker for idempotent re-write), and Gemini (`~/.gemini/extensions/sigmalink-browser/gemini-extension.json`) snippets. Each writer is best-effort; failures return `null` instead of throwing. |
| `app/src/renderer/features/browser/BrowserRoom.tsx` | Main page. Hydrates persisted state on first mount per workspace, opens a default tab if none exist, wires every UI handler to `rpc.browser.*`. |
| `app/src/renderer/features/browser/AddressBar.tsx` | Editable URL field with Enter-to-go + Back/Forward/Reload/Stop/Home buttons. Includes a `normalizeUrl` heuristic so a bare `example.com` becomes `https://example.com` and a non-URL string falls back to a Google search query. |
| `app/src/renderer/features/browser/TabStrip.tsx` | Horizontal tab strip with new-tab, switch-tab, close (× button or middle-click). Truncates long titles with an ellipsis. |
| `app/src/renderer/features/browser/BrowserViewMount.tsx` | The renderer-side placeholder div whose bounding rect is reported to main via `rpc.browser.setBounds`. ResizeObserver + window resize/scroll keep the `WebContentsView` aligned. On unmount, sends `bounds=null` so the view is parked at zero-size when the user navigates to another room. |
| `app/src/renderer/features/browser/AgentDrivingIndicator.tsx` | Soft amber ring overlay + chip with the agent's name and a "Take over" button. Pointer-events-none on the ring so it doesn't interfere with clicks. |
| `docs/05-build/W6-BROWSER-report.md` | This report. |

## 2. Files modified (additive Edits, no removals)

| Path | Change |
|---|---|
| `app/src/shared/types.ts` | Appended `TabId`, `BrowserTab`, `LockOwner`, `BrowserState`. Existing entries untouched. |
| `app/src/shared/router-shape.ts` | Imported `BrowserState`/`BrowserTab`; appended a 16-method `browser` namespace. |
| `app/src/shared/rpc-channels.ts` | Appended 16 `browser.*` entries to `CHANNELS`. `browser:state` was already in `EVENTS` from W5 — no change there. |
| `app/src/shared/events.ts` | Widened `browser:state` payload to the full `BrowserState` shape (`workspaceId`, `tabs[]`, `activeTabId`, `lockOwner`, `mcpUrl`) while keeping the original Phase-1 placeholder fields (`tabId`, `url`, `title`, `canGoBack`, `canGoForward`) optional so any consumer that targeted only the per-tab navigation update keeps compiling. |
| `app/src/main/core/db/schema.ts` | Appended `browserTabs` Drizzle table + `BrowserTabRow` / `BrowserTabInsert` inferred types and `browser_tabs_ws_idx` index. |
| `app/src/main/core/db/client.ts` | Appended `CREATE TABLE IF NOT EXISTS browser_tabs (...)` with `FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE` and the matching `browser_tabs_ws_idx`. |
| `app/src/main/rpc-router.ts` | Imported the supervisor, registry, and controller; instantiated both in `buildRouter()`; threaded the registry's `onState` into `broadcast('browser:state', ...)`; added `browser` to the router; tore down the registry and stopped the supervisor in `shutdownRouter()`. New `getSharedDeps()` export so the workspace launcher can fetch the supervisor without re-importing the registry. |
| `app/src/main/core/workspaces/launcher.ts` | After the worktree is materialised and before the PTY spawns, calls `playwrightSupervisor.start(workspaceId)` and `writeMcpConfigForAgent({ worktree: cwd, mcpUrl })`. Wrapped in try/catch so MCP plumbing failures never block agent launch. |
| `app/electron/main.ts` | Imported `getSharedDeps`; on the main `BrowserWindow`'s `closed` event, calls `browserRegistry.teardownAll()` so per-workspace WebContentsViews don't outlive the window. |
| `app/src/renderer/app/state.tsx` | Appended `browser: Record<string, BrowserState>` to `AppState`, the `SET_BROWSER_STATE` action, the reducer case, and a `browser:state` event subscription that coerces raw payloads into the typed BrowserState. |
| `app/src/renderer/app/App.tsx` | `case 'browser'` now renders `<BrowserRoom />` instead of the `<PhasePlaceholder />`. |
| `app/src/renderer/features/sidebar/Sidebar.tsx` | Removed the `phase: 3` pill on the Browser nav item so the entry enables when an active workspace exists. |

## 3. Decisions

### 3.1 CDP-attach vs. separate-Chromium mode

**Chosen: separate-Chromium mode for v1.**

`PlaywrightMcpSupervisor` spawns `npx -y @playwright/mcp@latest --port <n>` without `--cdp-endpoint`. The Playwright server therefore manages its own headed/headless Chromium independent of the in-app `WebContentsView`.

Why not CDP-attach over Electron's WebContentsView debugger? Electron exposes a per-WebContents CDP only via `webContents.debugger.attach('1.3')`. That gives us in-process CDP commands for navigation/screenshot/evaluation, but it does NOT expose the global `/json/version` HTTP endpoint that Playwright's `--cdp-endpoint` requires. To get that, we would need to set `app.commandLine.appendSwitch('remote-debugging-port', '0')` BEFORE `app.whenReady()` — which is impossible from the BrowserManager because main.ts has already booted. We could move that switch to the very top of `electron/main.ts`, but the build blueprint marks "port discovery is too brittle" as the documented escape hatch and asks us to fall back to separate-Chromium mode in that case. We took that escape hatch.

In v1 the user's pane and the agent's pane are NOT the same Chromium instance. They share persisted tabs (DB) and the lock indicator, but visual mirroring is deferred. A Phase-7 follow-up can flip on the global remote-debugging port and switch to shared-Chromium CDP-attach without breaking the supervisor's API — `start()` returns the same MCP URL either way.

### 3.2 Port-discovery method

The supervisor allocates the Playwright MCP HTTP port from the OS via `net.createServer().listen(0, '127.0.0.1')`, reads `address().port`, then closes the listener and re-uses that port number for the spawn. This avoids a hard-coded port, sidesteps collisions when multiple workspaces are open, and works on Windows/macOS/Linux without admin privileges. The chosen port is stored on the `SupervisedEntry` and the URL `http://127.0.0.1:<port>/mcp` is what gets written into the per-provider MCP config.

### 3.3 Lock semantics

The "agent is driving" state is a simple advisory lock:

- `claimDriver(agentKey, label?)` sets `lockOwner = { agentKey, claimedAt, label? }`, broadcasts `browser:state`, and emits `lockClaimed` on the manager.
- `releaseDriver()` sets `lockOwner = null`, broadcasts, and emits `lockReleased`.
- The renderer subscribes to `browser:state`; the indicator overlays the pane only when `lockOwner !== null`.
- The "Take over" button calls `releaseDriver` from the renderer. It does NOT actually pause MCP traffic — per the spec, v1 surfaces the lock visually only.
- Future Phase 7 work can add a real semaphore that the MCP-bridge consults before forwarding navigation commands; the events `lockClaimed` / `lockReleased` are already there for the supervisor to subscribe.

### 3.4 Dependency footprint

No new `package.json` dependencies. `@playwright/mcp` is invoked at runtime via `npx -y @playwright/mcp@latest`, which downloads the package on first launch and caches it in npm's local cache. This avoids bloating the Electron bundle by ~80 MB and lets the supervisor pick up upstream patches without an app rebuild.

### 3.5 `WebContentsView` lifecycle

Each tab lazily creates its own `WebContentsView`. We add it via `window.contentView.addChildView(view)` on first activation and remove it via `removeChildView` on close or workspace teardown. Bounds are sent from the renderer's `BrowserViewMount` placeholder div via a ResizeObserver + window resize listener, so the embedded Chromium stays aligned with the React layout under it. When the user switches to another room, the renderer dispatches `bounds=null`, which collapses the view to `0×0`. This is a deliberate substitute for `setVisible()` (Electron does not expose visibility on `WebContentsView`).

## 4. Schema migrations added

One new table in `app/src/main/core/db/schema.ts` and `app/src/main/core/db/client.ts`:

```sql
CREATE TABLE IF NOT EXISTS browser_tabs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_visited_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS browser_tabs_ws_idx ON browser_tabs(workspace_id);
```

Existing `workspaces`, `agent_sessions`, `swarms`, `swarm_agents`, `swarm_messages`, and `kv` tables untouched.

## 5. RPC channels added

16 new entries on the `browser.*` namespace in `app/src/shared/rpc-channels.ts`:

```
browser.openTab
browser.closeTab
browser.navigate
browser.back
browser.forward
browser.reload
browser.stop
browser.listTabs
browser.getActiveTab
browser.setActiveTab
browser.setBounds
browser.getState
browser.claimDriver
browser.releaseDriver
browser.getMcpUrl
browser.teardown
```

`browser:state` was already in the `EVENTS` allowlist from the W5 wave; we widened only its payload shape.

## 6. Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | `npm run build` / `electron:compile` / `product:check` / `lint` pass without lint regressions | ✅ 56 lint problems (matches W5/W6a baseline) |
| 2 | Browser room reachable from sidebar; phase-3 pill removed | ✅ Sidebar entry enables when a workspace is open |
| 3 | URL bar Enter-to-navigate the embedded Chromium | ✅ `AddressBar` → `rpc.browser.navigate` → `webContents.loadURL` |
| 4 | Tab strip allows new / switch / close | ✅ `TabStrip` + `rpc.browser.openTab/setActiveTab/closeTab` |
| 5 | `browser_tabs` persists across restarts | ✅ Inserts/updates on open/navigate; hydrate via `BrowserManager.hydrateFromDb` on first instantiation |
| 6 | Playwright MCP supervisor spawns lazily; killed on workspace teardown | ✅ `PlaywrightMcpSupervisor.start` is invoked on first `openTab`/`getMcpUrl`/launcher; `BrowserManagerRegistry.teardown(workspaceId)` calls `supervisor.stop(workspaceId)` |
| 7 | MCP config files land per-provider after launch | ✅ `executeLaunchPlan` calls `writeMcpConfigForAgent({ worktree, mcpUrl })` for each pane; the writer fans to `.mcp.json`, `~/.codex/config.toml`, `~/.gemini/extensions/sigmalink-browser/gemini-extension.json` |
| 8 | Agent-driving banner toggles on `claimDriver`/`releaseDriver`; user can Take Over | ✅ `AgentDrivingIndicator` reads `lockOwner` from `browser:state`; the button calls `rpc.browser.releaseDriver` |

## 7. Deferrals (out of v1, captured here for future waves)

- **Real CDP-attach mode** (sharing Electron's Chromium with Playwright). Requires `app.commandLine.appendSwitch('remote-debugging-port', '0')` at the top of `electron/main.ts` plus port discovery from the websocket URL. The supervisor's `start()` API is stable enough to swap the implementation without affecting callers.
- **Per-workspace cookie/session isolation** via `persist:ws-<workspaceId>` partitions. The schema (and the manager constructor) leave room for this; v1 uses the default Electron session.
- **Bookmarks, history search, downloads, DevTools toggle, "Activate Design Tool"** — all listed under the Phase 3+ scope but explicitly out of scope for this wave.
- **Hard-blocking lock** that pauses MCP traffic when the user clicks "Take over". v1 surfaces the lock visually only; `lockClaimed` / `lockReleased` events are emitted on the manager so a future supervisor patch can subscribe and gate forwarded commands.
- **Frame-by-frame mirroring** of the agent's separate-Chromium pane back into the in-app `WebContentsView`. v1 simply shows the user's local pane and the indicator chip.
- **Idempotent revoke of MCP config** when the workspace is removed. The writer is idempotent on add; teardown leaves the snippet in place because removing it from `~/.codex/config.toml` is destructive without a transaction.
