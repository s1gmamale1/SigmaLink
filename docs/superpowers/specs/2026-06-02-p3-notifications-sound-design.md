# P3 — Notifications + Sound (pillars d, e) · design spec

**Status:** approved (autonomous execution under operator `/goal` — finish whole ROADMAP sequentially).
**Ships as:** `v1.39.0` (untagged on merge; rides next operator-authorized release, like P1/P2).
**Roadmap items:** NTF-1, NTF-2, NTF-3 (=UX-9, already shipped P2), SND-1, ANIM-3.
**Date:** 2026-06-02. **Baseline:** main @ `2c65ab6` (P1 + P2 shipped).

## Goal

A calm, controllable notification + sound experience — tasteful where it adds value, silent
where it doesn't. The notification **backend** (`manager.ts` taxonomy/dedup/caps, `os-notify.ts`
OS forwarding) is already mature; the gap is front-of-house: DND/quiet-hours/per-source control,
a real soundscape, dropdown polish, and a coherent toast↔bell handoff.

## Current state (evidence)

- `src/main/core/notifications/os-notify.ts:18` — "Quiet hours and per-source toggles are
  explicitly out of scope"; `KV_OS_PER_SOURCE` (`:30`) **scaffolded but unused**. Single gate
  point: `osNotifier.notify(added)` at `rpc-router.ts:364`.
- `src/renderer/lib/notifications.ts` — TWO synthesized Web-Audio tones: `playDing()` (`:61`,
  Jorvis completion A5→E6) and `playNotificationTone()` (`:106`, D4→A3 on new notification).
  One tone covers warn/error/critical; fixed gain; **plays under reduced-motion + hidden window**.
  Toggles `notifications.ding` + `notifications.sound` (both default ON).
- Wiring: `use-live-events.ts:200` calls `playNotificationTone()` once per delta with any unread;
  `use-jorvis-dispatch-echo.ts:105` calls `playDing()`.
- `NotificationsSettings.tsx` — master OS toggle + per-severity checkboxes + ding/sound toggles.
- `NotificationDropdown.tsx` — P2 Radix-Popover body; flat list + [All|Workspace|Errors] chips +
  mark-all/clear. No grouping, no per-row source mute, no enter/leave animation.
- `PaneFooter.tsx` — auto/bypass hint only. `AgentSession` has `startedAt:number` + `status`.
- P2 motion lib: `src/renderer/lib/motion.ts` (spring tokens), themed sonner at `components/ui/sonner.tsx`.

## Architecture

### Shared contract (load-bearing seam — lead-authored, round 0)

`src/shared/notification-prefs.ts` — **pure** (no electron, no DOM types). Single source of truth:

- **KV keys**: `notifications.dnd` (`'1'|'0'`), `notifications.quietHours` (JSON), reuse
  `notifications.osPerSource` (JSON `NotificationSource[]`), `sound.enabled`, `sound.volume`
  (`'0'..'1'`), `sound.mutedCues` (JSON `SoundCue[]`). Legacy `notifications.ding` /
  `notifications.sound` honored as defaults for the `agent-done` / notification cues (no regression).
- **Source taxonomy**: `NotificationSource = 'pty'|'swarm'|'tool'|'system'` + `notificationSource(kind)`
  mapper (`pty-exit`→pty, `swarm*`→swarm, `tool*`→tool, else system) + labelled list for the UI.
- **Quiet hours**: `QuietHoursConfig {enabled,start:"HH:MM",end:"HH:MM"}`, `parseQuietHours`,
  `hhmmToMinutes` (validates 0..1439), `isWithinQuietHours(cfg, nowLocalMinutes)` — **wrap-aware**
  (start>end spans midnight).
- **Suppression predicates** (pure, time injected so both processes + tests are deterministic):
  - `isQuietActive(prefs, nowMin) = prefs.dnd || isWithinQuietHours(prefs.quietHours, nowMin)`.
  - `isOsSuppressed(prefs, {source, severity}, nowMin)` — per-source mute wins; **critical bypasses**
    DND/quiet (must-see); else suppressed when quiet active.
  - `isSoundSuppressedByPrefs(prefs, {source?}, nowMin)` — per-source mute wins; suppressed whenever
    quiet active (**all** severities — sound is never must-see).
- **Sound cue catalog**: `SoundCue` union (`agent-done`,`agent-crash`,`message-arrive`,`merge-ready`,
  `error`,`send`,`record-start`,`record-stop`,`notify-info`,`notify-warn`,`notify-error`,
  `notify-critical`); `CueDef {cue,label,category:'alert'|'ui',tones:ToneSpec[],legacyKey?}`;
  `SOUND_CATALOG`; `severityCue(sev)`; `DEFAULT_SOUND_VOLUME=0.6`. `ToneSpec` uses a local
  `ToneType` string union — **not** the DOM `OscillatorType` — so the module stays DOM-free for main.

### Sound engine (lead-authored, round 0)

`src/renderer/lib/sounds.ts` — Web-Audio synth over the catalog. `playCue(cue)`, `playForSeverity(sev)`,
`previewCue(cue)` (settings test button — bypasses DND/hidden, respects volume + master). Volume +
per-cue mute getters/setters persist via `rpcSilent.kv`. Gating order in `playCue`: master off →
cue muted → quiet active (DND/quiet via shared predicate, prefs read from KV) → for `category:'ui'`
also `prefersReducedMotion() || document.hidden` → else synth `tones` at `volume`. Best-effort, never
throws (audio is non-critical). `lib/notifications.ts` refactored to a thin shim: `playDing()`→
`playCue('agent-done')`; `playNotificationTone(severity?)`→`playForSeverity(severity ?? 'warn')`;
legacy getters/setters retained. **All existing call sites + their test mocks stay valid.**

### Parallel lanes (worktree-isolated, off main after round-0 commit, file-disjoint)

- **Lane A — `os-notify` gating (backend).** Read `dnd`/`quietHours`/`osPerSource` KV; apply
  `isOsSuppressed` + `notificationSource` (local time → minutes). Update the `:18` scope comment.
  Files: `os-notify.ts` (+ test). 
- **Lane C1 — NotificationsSettings.** New sections: DND toggle, quiet-hours window (enable +
  start/end time inputs), per-source mute checkboxes (from `NOTIFICATION_SOURCES`), **Sound**: master
  toggle + volume slider + per-cue mute matrix (from `SOUND_CATALOG`, grouped alert/ui) + "Test"
  button per cue (`previewCue`). Keep legacy ding/sound rows mapped to their cues. Files:
  `NotificationsSettings.tsx` (+ test).
- **Lane C2 — Dropdown polish + toast↔bell handoff.** Group the list by source (then kind) with
  collapsible sections; MOT-1 enter/leave on rows; keep filter chips + mark-all/clear. In
  `use-live-events.ts`: compute the delta's max unread severity → `playNotificationTone(maxSev)`
  (distinct severity tone) + surface a **themed sonner toast** per new unread (info ≤3s auto;
  warn 5s; error/critical persistent w/ "View" action that opens bell / deep-links). Suppress the
  toast when quiet active (reuse shared predicate via a small renderer prefs read). Files:
  `NotificationDropdown.tsx`, `notifications/helpers.ts` (grouping), `use-live-events.ts` (+ tests).
- **Lane D — ANIM-3 PaneFooter aliveness.** When `session.status==='running'`: rotating gerund
  ("Percolating…", "Cogitating…", …) + elapsed `now-startedAt` (mm:ss), reduced-motion gated
  (static verb + coarse elapsed, no rotation). Tokens omitted (no per-session token source yet →
  FEAT-3/P6). Files: `PaneFooter.tsx`, `progress-verbs.ts` (const) (+ test).

## Data flow

`NotificationsManager.add` → `emit(delta)` → `rpc-router` fans out `notifications:changed` **and**
calls `osNotifier.notify(row)` (now gated by prefs). Renderer `use-live-events` receives the delta →
reducer upsert → **sound** (gated) + **toast** (gated). Settings write KV; main reads KV synchronously
on each `notify`; renderer reads KV (cached, invalidated on set) in `sounds.ts` + the toast gate.

## Error handling

Audio + toast + OS-notify are all best-effort and already wrapped in try/catch; malformed KV falls
back to safe defaults (DND off, quiet off, no muted sources, default volume, master on). Quiet-hours
parsing rejects out-of-range HH:MM → treated as disabled.

## Testing

- `notification-prefs.test.ts` (pure): quiet-hours wrap math, all suppression-matrix cells
  (per-source mute, critical bypass, DND, quiet window in/out), source mapper.
- `sounds.test.ts`: mock `AudioContext` + `rpcSilent.kv`; assert gating (master/mute/quiet/hidden/
  reduced-motion per category), volume applied, preview bypasses gates, legacy-key mapping.
- Lane tests: os-notify DND/quiet/per-source; settings render+persist+preview; dropdown grouping +
  toast handoff (sonner spy) + severity-tone arg; PaneFooter verb rotation + reduced-motion.

## Exit criteria (from ROADMAP P3)

DND silences OS + sound; per-source mute works (OS + sound, still recorded in bell); sound suppressed
under quiet/DND (and reduced-motion/hidden for `ui` cues); distinct per-severity tones; volume persists.

## Out of scope (deferred → WISHLIST)

Daily-summary digest (Apple Scheduled Summary — needs a main-process scheduler + new notification
kind); designed audio assets (synth-only this phase; catalog leaves room for `legacyKey`/asset path);
per-PTY-data sound (explicitly NOT wanted — restraint default).

## Gate (before PR)

`npx tsc -b` · `npx vitest run` · `npm run build && npm run electron:compile` · `npx playwright test
tests/e2e/` · **`npm run lint`** · Opus security/quality review (SEC-1: sound assets + toast render +
quiet-hours parsing reopen no H-19 surface — none ingest external text, but re-gate).
