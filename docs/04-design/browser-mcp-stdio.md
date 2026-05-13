# Browser MCP — stdio mode (v1.2.6)

> Status: **Shipped** in v1.2.6 (2026-05-13).
>
> Replaces the HTTP-supervisor approach from v1.2.0–v1.2.5.

## Problem statement

v1.2.0 introduced a **per-workspace Playwright MCP HTTP supervisor** (`playwright-supervisor.ts`, ~400 LOC). The idea was to spawn a long-lived `@playwright/mcp` child process on a dynamically-allocated TCP port, write the URL into `.mcp.json`, and share one Chromium instance across all panes in a workspace.

v1.2.5 patched two holes in this approach:
1. `@playwright/mcp` moved from `devDependencies` to `dependencies` so electron-builder included it in the DMG.
2. `bootstrapNodeToolPath()` prepended common Node tool directories to `process.env.PATH` so Finder-launched Electron could find `npx`.

But a deeper bug remained: **Playwright needs Chromium browser binaries (~170 MB)**. The DMG ships at 501 MB with NO `.local-browsers/` directory. Playwright's auto-download path (`downloadBrowserWithProgressBar`) requires a TTY. Our supervisor spawned the child with `stdio: ['ignore', 'pipe', 'pipe']` — no TTY → the download hung or silently exited. The supervisor's `app:browser-mcp-failed` broadcast only fired after 3 failed restarts (~4.5 s), but the CLI agent's MCP handshake timed out before that — so users never saw the warning; they just saw "MCP client for `browser` failed to start" in every pane.

## Architectural pivot

The **idiomatic MCP pattern is stdio**: each agent spawns its own MCP server process via stdio. We write a static stdio config into `.mcp.json` and let the agent handle everything:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.75"]
    },
    "sigmamemory": {
      "command": "node",
      "args": ["/path/to/mcp-memory-server.cjs"]
    }
  }
}
```

1. Agent reads `.mcp.json` on startup.
2. Agent spawns `npx -y @playwright/mcp@0.0.75`.
3. `npx -y` auto-downloads `@playwright/mcp` to the npm cache if missing (~10 s on first call).
4. Communication is via stdio (no HTTP, no port allocation, no supervisor).
5. First call to a browser tool → Playwright's auto-installer runs **with a TTY** because npx passes through the agent's stdio → Chromium downloads cleanly with a visible progress bar in the pane terminal (~30 s on first navigation).
6. Subsequent calls: instant.

Three failure modes (bundling, PATH, Chromium) collapse to **zero failure modes** for our code path. The remaining "failure mode" is "user has no `npx` on PATH" — every Node developer has it; non-Node users are documented.

## Trade-offs accepted

| Aspect | HTTP supervisor (v1.2.0–v1.2.5) | stdio mode (v1.2.6+) |
|---|---|---|
| Shared browser state across panes | Yes (one Chromium, one cookie jar) | No (each pane spawns its own) |
| Code complexity | ~440 LOC (supervisor + port mgmt + error broadcast) | ~15 LOC (config writer only) |
| DMG size impact | +~50 MB (`@playwright/mcp` + deps in node_modules) | 0 MB (agent downloads on demand) |
| Failure modes in our path | 3 (bundling, PATH, Chromium TTY) | 0 |
| First-call latency | ~4 s supervisor boot + hidden Chromium download | ~10 s npx + ~30 s visible Chromium download |
| Retry / recovery | Supervisor restarts up to 3× | Agent re-spawns automatically on next tool call |

The "shared browser state" benefit was theoretical: agents rarely coordinate browser state across panes, and N concurrent automation drivers on one Chrome instance tends to create more bugs than it solves.

## Files changed

### Added
- `docs/04-design/browser-mcp-stdio.md` (this file)

### Modified
- `app/src/main/core/browser/mcp-config-writer.ts` — emits stdio `command` + `args` instead of HTTP `url` for the `browser` entry across Claude (.mcp.json), Codex (config.toml), and Gemini (extension.json).
- `app/src/main/core/workspaces/launcher.ts` — drops `playwrightSupervisor.start()` call; writes browser config without an allocated URL.
- `app/src/main/rpc-router.ts` — removes `PlaywrightMcpSupervisor` import, instantiation, and `sharedDeps.playwrightSupervisor` reference; removes `stopAll()` from shutdown hook.
- `app/src/main/core/browser/manager.ts` — removes `supervisor` from `ManagerDeps` and `RegistryDeps`; removes `ensureSupervisor()` and `getMcpUrl()`; `teardown()` no longer stops supervisor.
- `app/src/main/core/browser/controller.ts` — removes `getMcpUrl` RPC method; `openTab` no longer calls `ensureSupervisor()`.
- `app/src/shared/router-shape.ts` — removes `browser.getMcpUrl` type.
- `app/src/shared/rpc-channels.ts` — removes `browser.getMcpUrl` from CHANNELS and `app:browser-mcp-failed` from EVENTS.
- `app/src/main/core/rpc/schemas.ts` — removes `browser.getMcpUrl` stub.
- `app/src/renderer/components/RufloReadinessPill.tsx` — removes `app:browser-mcp-failed` subscription and `browserMcpFailed` state.
- `app/src/renderer/features/settings/McpServersTab.tsx` — shows static stdio command instead of querying a supervisor URL.
- `app/src/main/core/browser/__tests__/mcp-config-writer.spec.ts` — three test cases rewritten for stdio output shape.
- `app/package.json` — `@playwright/mcp` moved back to `devDependencies`.

### Deleted
- `app/src/main/core/browser/playwright-supervisor.ts` (~400 LOC)

## Risks

1. **User without `npx` on PATH** (R-1.2.6-1). Mitigation: `bootstrapNodeToolPath()` already finds Node tool dirs. Documented in README.
2. **First-call latency** (R-1.2.6-2). Worst case ~1 min on slow network. Mitigation: pane terminal shows progress. Pinned to `@playwright/mcp@0.0.75` for reproducibility.
3. **Upstream breaking change** (R-1.2.6-3). Pin avoids surprise breakage; we bump the pin explicitly after testing.
4. **Supply-chain** (R-1.2.6-4). `npx -y` auto-confirms. Pin to exact version mitigates.
5. **No shared browser state** (R-1.2.6-5). Explicitly accepted; revisit only if a user reports it as a blocker.

## Retrospective — why the HTTP supervisor existed

v1.2.0 built the supervisor because we wanted **one Playwright instance shared across all panes** in a workspace. The reasoning was sound on paper: Claude in pane 1 and Codex in pane 4 could see the same browser state (cookies, localStorage, session). In practice:

- Agents almost never intentionally share browser state across panes.
- Concurrent automation drivers on a single Chromium create race conditions (two agents trying to navigate simultaneously).
- The supervisor added 3 failure modes that were harder to debug than the theoretical benefit was worth.

The stdio pivot is a return to the **MCP spec's intended transport**: each client spawns its own server. We should have started here.
