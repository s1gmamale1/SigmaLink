# Design — Session Picker (v1.3.0)

> Architecture, smart-default rules, and persistence model for the per-pane session picker introduced in the Workspace Launcher.

## Overview

v1.2.8 gave SigmaLink reliable session capture and a `--continue` fallback but left users with no control over which session gets resumed. v1.3.0 inserts a **SessionStep** into the Workspace Launcher wizard (after AgentsStep, before Launch) that shows a chip per pane, auto-suggests the newest session, and lets the user override per-pane or in bulk.

Two flows are handled:

- **Scenario A — New workspace**: after Start → Layout → Agents, the picker appears. Smart default auto-selects the newest session on disk for each pane's (cwd, provider) tuple.
- **Scenario B — Re-open persisted workspace**: sidebar dropdown navigates directly to SessionStep with chips pre-populated from the last-run session IDs. Layout and Agents steps are skipped unless the user requests "Reconfigure layout…".

---

## Component topology

```
Launcher.tsx
  └─ Stepper.tsx  [steps: start | layout | agents | sessions | (launch)]
       └─ SessionStep.tsx
            ├─ BulkBar  ("Resume newest for all" | "All new" | "Reset to suggested")
            └─ PaneRow (×N)
                 ├─ ProviderDot  (workspace-color.ts)
                 ├─ SessionChip  (shadcn Badge, shows "New session" | "<age> · <preview>")
                 └─ "Change…"  → Radix Popover
                                   └─ shadcn Command (cmdk)
                                         ├─ search input
                                         └─ SessionListItem (×up to 50)
```

State owned by `Launcher.tsx`:

```ts
paneResumePlan: Record<number, { providerId: string; sessionId: string | null }>
```

Passed into the `executeLaunchPlan` RPC payload; consumed by `executeLaunchPlan` in `launcher.ts`.

---

## Disk-scanner extension

`session-disk-scanner.ts` gains a second exported function alongside the existing `findLatestSessionId`:

```ts
export async function listSessionsInCwd(
  providerId: string,
  cwd: string,
  opts?: { maxCount?: number }
): Promise<SessionListItem[]>

export interface SessionListItem {
  id: string
  providerId: string
  cwd: string
  createdAt: Date
  updatedAt: Date
  title?: string
  firstMessagePreview?: string   // truncated to 80 chars
}
```

Per-provider strategy (cap at `opts.maxCount ?? 50`, sorted DESC by `updatedAt`):

| Provider | Source | ID extraction |
|---|---|---|
| Claude | `~/.claude/projects/<cwd-slug>/*.jsonl` | filename UUID; line-1 JSON metadata |
| Codex | `~/.codex/sessions/**/rollout-*-<uuid>.jsonl` | UUID from filename; ISO timestamp in name |
| Gemini | (deferred to v1.3.1 — return `[]`) | — |
| Kimi | `~/.kimi/sessions/<sha1(cwd)>/<uuid>/state.json` | directory UUID; `state.json` timestamp field |
| OpenCode | `opencode session list --format json --max-count 50` | filter `directory === cwd`; parse `{id,updated,title}` |

`findLatestSessionId` (v1.2.8) is unchanged — it keeps its 5-min mtime window and single-return contract.

---

## Smart-default rules

1. On SessionStep mount, call `panes.listSessions(providerId, cwd)` for each pane.
2. If `sessions.length > 0` → pre-select `sessions[0]` (newest by `updatedAt`) as chip value.
3. If `sessions.length === 0` → chip shows "New session"; no resume args passed at spawn.
4. Gemini panes always land on "New session" in v1.3.0 (disk layout undocumented).
5. For Scenario B re-opens: `panes.lastResumePlan(workspaceId)` is fetched first and its values override the disk-derived default if non-null. This surfaces the exact session the user ran last time rather than re-deriving from mtime alone.
6. If a pre-populated session ID from Scenario B is no longer on disk: silently fall back to the disk-derived newest, emit `console.warn`. Not surfaced as a user-blocking error.

Lazy loading rule: `listSessions` is called on Popover open (per pane), NOT eagerly on step entry — avoiding N file-open bursts for panes the user never changes.

Exception: the smart-default auto-pick for each pane IS eager (one call per pane on step mount), but fetches only the top-1 entry (`maxCount: 1`) for speed.

---

## Persistence model

No new database columns. The `agent_sessions` table (v1.2.8) already holds:

| Column | Use |
|---|---|
| `workspaceId` | group by workspace |
| `paneIndex` | group by pane slot |
| `providerId` | per-provider chip |
| `externalSessionId` | the chosen session ID (or null = new) |
| `startedAt` | sort DESC to find last-run row |

`panes.lastResumePlan(workspaceId)` executes:

```sql
SELECT paneIndex, providerId, externalSessionId
FROM agent_sessions
WHERE workspaceId = ?
GROUP BY paneIndex
ORDER BY startedAt DESC
```

This is a pure read; no migration required.

When the user launches with a picker-chosen sessionId, `executeLaunchPlan` pre-stamps `agent_sessions.externalSessionId = sessionId` at row insert (same as v1.2.8 pre-assign path for claude/gemini). The v1.2.8 `onPostSpawnCapture` hook is a no-op for rows that already have a non-null `externalSessionId`.

---

## Risk register (reviewer's table)

| ID | Risk | Mitigation |
|---|---|---|
| R-1.3.0-1 | N file-opens for 50 sessions on slow disk | Lazy-load: only the smart-default pick is eager (maxCount 1 per pane); full list deferred to Popover open |
| R-1.3.0-2 | Gemini disk layout undocumented | Return `[]` for Gemini; show "No sessions found" in Popover; file v1.3.1 backlog row |
| R-1.3.0-3 | Pre-populated session IDs stale (file GC'd) | Validate on SessionStep mount; silent fallback to disk-newest; `console.warn` for debug |
| R-1.3.0-4 | Scenario B skips Layout+Agents, surprising layout changes | "Reconfigure layout…" link at top of SessionStep navigates back to Layout |
| R-1.3.0-5 | Bulk "Resume newest" over 20 panes = 20 disk reads | Reuses cached smart-default values; no second fetch |

---

## Verification gates (pre-tag)

1. `pnpm exec tsc -b` clean.
2. `pnpm exec vitest run` — target 263+ / 263+ (net +12-15 new cases).
3. `pnpm exec eslint .` clean.
4. `pnpm run build` clean.
5. Manual Scenario A: two Claude panes, two prior sessions on disk — confirm both chips auto-suggest, both spawn with `--resume <id>`.
6. Manual override path: change pane 1 chip to an older session — confirm pane 1 uses the chosen ID, pane 2 uses the default.
7. Manual "All new" bulk bar — confirm both panes spawn fresh (no `--resume` args).
8. Manual Scenario B: quit and re-open workspace — confirm chips are pre-populated from the prior run.
9. Gemini edge case: Popover shows empty list, chip stays "New session", launch proceeds.
10. Stale ID edge case: delete session file, re-open — chip silently falls back, no blocking error.
