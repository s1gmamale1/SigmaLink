# Lane 6 — Bridge*→Sigma* Rename: User-Data & Runtime-Lookup Impact

Investigation date: 2026-05-22
Scope: v1.13.0 Bridge*→Sigma* rename; existing (pre-v1.13) installs.

---

## 1. Capability keys — compile-time only, never persisted

The three renamed capability keys (`bridgevoice.enabled` → `sigmavoice.enabled`,
`bridgemcp.slotCount` → `sigmamcp.slotCount`, `bridgejarvis.enabled` →
`sigmajarvis.enabled`) exist exclusively in the in-memory tier matrix in
`src/main/core/plan/capabilities.ts` (lines 29-64).

They are **never written to the KV table or any DB column**. The only persisted
value in the tier path is the single string `'plan.tier'`
(`KV_PLAN_TIER` — `capabilities.ts:77`) which holds `'basic' | 'pro' | 'ultra'`.
The tier string itself was not renamed. Callers (`canDo.ts`, `Composer.tsx`,
`RoleRoster.tsx`, `AppearanceTab.tsx`) all resolve capability values from the
in-memory `CAPABILITIES_BY_TIER` map at runtime; nothing touches persisted
storage with the old or new capability-key strings.

**Verdict: safe — no user-data exposure.**

---

## 2. KV keys — bridge.* keys already have a migration; sigma.* keys confirmed

The only persisted KV keys that carried `bridge.` prefixes were
`bridge.activeConversationId` and `bridge.autoFocusOnDispatch`, introduced
before v1.4.1. Both were renamed to `sigma.activeConversationId` /
`sigma.autoFocusOnDispatch`, and a forward-only idempotent migration was
shipped in `src/main/core/db/client.ts` (lines 216-246), executed inside
`initializeDatabase()` on every app start. The migration reads the old key,
copies its value under the new name, and deletes the old row — existing installs
are covered automatically on first launch after upgrade.

Consumed constants:
- `KV_ACTIVE_CONVERSATION = 'sigma.activeConversationId'` —
  `src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts:7`
- `KV_AUTO_FOCUS_ON_DISPATCH = 'sigma.autoFocusOnDispatch'` —
  `src/renderer/features/jorvis-assistant/use-jorvis-dispatch-echo.ts:8`

No surviving code reads the old `bridge.*` keys except inside the migration
handler itself. Test coverage exists in `client.kv-migration.test.ts`.

**Verdict: safe — migration is in place and idempotent.**

---

## 3. DB schema — no bridge-named columns or tables

A full review of `src/main/core/db/schema.ts` shows every table and column
uses snake_case names with no `bridge` prefix. The only `jorvis`-named items are
`jorvis_pane_events` (table, line 473) and `jorvisMonitorConversationId` (column
on `agent_sessions`, line 62). These were always named with the `jorvis` token;
they are not touched by the Bridge→Sigma rename. No migration adds or drops a
column with a `bridge` or `sigma` discriminator at the schema level.

**Verdict: safe — schema is clean.**

---

## 4. IPC channels — not renamed; `sigma` global stable

The main Electron preload (`electron/preload.ts:45`) exposes `contextBridge.exposeInMainWorld('sigma', api)`. This `'sigma'` symbol was the post-rename target and remains unchanged. No `'bridge'` symbol is exposed through this path.

The SigmaVoice standalone app preload (`apps/sigma-voice/src/preload.ts:8`) uses
`contextBridge.exposeInMainWorld('bridgeVoice', ...)`. This name was **not
renamed** and its sole consumer (`apps/sigma-voice/renderer/settings.html:100`)
still reads `window.bridgeVoice`. The symbol is consistent; it is not shared with
SigmaLink's main renderer. No crash risk here.

**Verdict: safe — IPC global names are internally consistent.**

---

## 5. MCP server names and mechanism files

The renamed mechanism files `mcp-host-sigma.ts` and `claude/gemini-resume-sigma.ts`
are referenced only by TypeScript imports — no path string is persisted. The
MCP server `name` declared at the wire level is `'jorvis-host'`
(`mcp-host-sigma.ts:278`, `mcp-host-server.ts:372`), which was never `bridge-*`.
The socket path is minted fresh per process (`jorvis-host-<pid>-<uuid>.sock`).
The temp `.mcp.json` config written to disk is thrown away after each turn;
it is not a persisted user-data artefact. The `mcp-jorvis-host-server.cjs`
bundle filename referenced at `rpc-router.ts:528` was not renamed.

**Verdict: safe — no persisted path or name refers to a renamed token.**

---

## 6. Preserved tokens — confirmed intact

| Token | Location | Still present |
|-------|----------|---------------|
| `bridge_dispatch` swarm event type | `src/main/core/swarms/types.ts:30,164` | yes |
| `bridge_dispatch` UI colour chip | `src/renderer/features/operator-console/ActivityFeed.tsx:61` | yes |
| `bridge.*` KV migration selects/deletes | `src/main/core/db/client.ts:220-242` | yes |
| `contextBridge` (Electron API usage) | `electron/preload.ts:6`, `apps/sigma-voice/src/preload.ts:6` | yes |
| `tsfn_bridge.h/mm` (napi RAII helper) | `native/voice-mac/src/`, `native/voice-win/src/` | yes |
| `bridge-conversations-panel` test-id | `src/renderer/features/jorvis-assistant/ConversationsPanel.tsx:58` | yes |
| `bridge-resumable-pill` test-id | `src/renderer/features/jorvis-assistant/ConversationsPanel.tsx:115` | yes |
| `bridge-origin-link` test-id | `src/renderer/features/operator-console/OriginLink.tsx:85` | yes |

All preserved tokens remain present in shipped v1.13.x code. Tests in
`ConversationsPanel.test.tsx` and `dogfood.spec.ts` / `smoke.spec.ts` query
these `bridge-*` test-ids and would fail immediately if they were dropped.

---

## 7. `bridgeVoice` window global — open inconsistency (cosmetic, not a crash)

`apps/sigma-voice/src/preload.ts:8` exposes `window.bridgeVoice` while the
rest of the app uses `window.sigma`. This is a naming inconsistency left over
from the rename but it is **not a regression**: the `bridgeVoice` name has
always been the SigmaVoice-app-specific symbol, consumed only by
`apps/sigma-voice/renderer/settings.html`. No other module reads it. It does not
affect SigmaLink's main window or pane/swarm flows.

---

## 5-Line Summary

1. The three renamed capability keys (`sigmavoice.enabled`, `sigmamcp.slotCount`,
   `sigmajarvis.enabled`) are compile-time constants never written to disk — no
   mismatch is possible for existing installs.
2. The two KV keys that were renamed (`bridge.*` → `sigma.*`) have a shipped,
   idempotent migration in `initializeDatabase()` that runs on every boot;
   pre-v1.4.1 installs are transparently upgraded.
3. No DB table, column, IPC channel, or MCP server name contains a `bridge`
   prefix that was renamed in v1.13; all schema identifiers use `jorvis` or
   `sigma` and were not touched by this rename.
4. All "preserved" tokens (`bridge_dispatch`, `bridge.*` migration SQL,
   `contextBridge`, `tsfn_bridge`, `bridge-*` test-ids) are confirmed present
   in the shipped source.
5. The rename does **not** contribute to the pane/swarm crashes described in
   other lanes of this investigation.
