# v1.4.8 bundle — index

**Status**: planning complete — all 9 briefs reviewed against current main (HEAD `d45a004`)
**Created**: 2026-05-19 (post-v1.4.7 ship)
**Refreshed**: 2026-05-20 — 9 parallel reviewer agents (3 Opus + 6 Sonnet) cross-checked every brief vs current source code; corrections + design locks merged in-place

## Packets — full table with post-review state

| # | Packet | Effort | Status | Notes |
|---|---|---|---|---|
| 01 | [Browser auto-spawn + `about:` normalization](01-browser-cleanup.md) | XS (~20 min) | ✅ ready-to-dispatch | Correct fixes; brief had phantom `TabsGrid` + `searchUrl()` references, now corrected to target `BrowserViewMount` + inline Google fallback |
| 02 | [Sidebar resize (IDE + main)](02-sidebar-resize.md) | M (~3-5 hr) | ✅ ready-to-dispatch | Added `transition-[width]` suppression step; corrected `accent-emphasis`→`accent` token; kv keys verified non-conflicting |
| 03 | [Drag-drop file → pane `@-mention`](03-drag-drop-file-mention.md) | **S (~2-3 hr)** ← from M | ✅ ready-to-dispatch | Major drift: `PaneShell`/`PaneComposer`/`EditorTab` all WRONG — drop target is `PaneCell` in `CommandRoom.tsx`, source is `FileTree.tsx`. `window.sigma.getPathForFile` (not `webUtils`). Electron 29+ (not 32). `@dnd-kit` conflict watch. xterm IS the composer |
| 04 | [Global voice capture](04-global-voice-capture.md) | **L+ (7-10d)** ← from L | 🟡 research-locked, 7 lead Q's | **Decisions LOCKED**: whisper.cpp primary + Apple Speech.framework macOS fallback; Path A++ (globalShortcut + Tray); hotkey Cmd+Opt+Space / Ctrl+Alt+Space; lazy-download base.en-Q5_1 (57 MB) via HuggingFace ggerganov + SHA-256. **BridgeVoice researched**: real Tauri 2.0 paid product ($50/mo), not open source, use as UX reference. Recommend split mac (v1.4.9) → Win+Linux (v1.4.10) |
| 05 | [Windows auto-update verify](05-windows-autoupdate-verify.md) | **XS (1-2 hr)** ← from S | ✅ ready-to-dispatch | **Auto-update already SHIPPED in v1.2.4 + v1.3.x.** auto-update.ts (179 LOC) + UpdatesTab.tsx (366 LOC) + RPCs + workflow ALL live. Remaining work is UAC error-code-5 detection + Win11 dogfood smoke |
| 06 | [Provider auto-install](06-provider-auto-install.md) | M (~6-8 hr) | ✅ ready-to-dispatch, 4 lead Q's | Detection layer ALREADY shipped (`providers.probeAll`/`probe` RPCs + amber badge in `AgentsStep.tsx`). Corrected: Kimi pkg `kimi-cli` (not `kimi-code-cli`); OpenCode `npm i -g opencode` (not brew). RPC simplified to `providers.spawnInstall` + string-enum consent |
| 07 | [Notifications + bell](07-notifications-bell.md) | **L+½d (3.5-4.5d)** ← from L | ✅ ready-to-dispatch (Opus delegate) | Full taxonomy LOCKED: migration **0018**; 4-level severity (info/warn/error/**critical**); persistence N=500+200/kind+30d TTL; dedup `dedup_key` tuple+`dup_count`+30s window+critical bypass; IPC delta-only (prevents saturation); OS-notify opt-in OFF + 5min throttle. Files-to-touch 20→28 |
| 08 | [Windows SAPI5 voice](08-windows-sapi5-voice.md) | L (~3-5d) | ✅ ready-to-dispatch | COM threading FULLY specified: dedicated STA + Win32 message pump + `HWND_MESSAGE` + `SetNotifyWindowMessage` + TSFN marshalling. `node-gyp-build` loader pattern (matches voice-mac). Prebuild matrix x64 hard + arm64 continue-on-error. **Interaction**: whisper.cpp from packet 04 could subsume STT — see consolidation question below |
| 09 | [Cross-machine sync](09-cross-machine-sync.md) | **L+1d (5-7d)** ← from L | 🔴 blocked-on-user-signoff, 6 lead Q's | **Threat model LOCKED**: `libsodium-wrappers-sumo` + XChaCha20-Poly1305 + AAD `(schema_version\|table_name\|row_id)`. **DROPPED `age`** — original brief's `@codemirror/age-encryption` import is a hallucination. CRDT: HLC + LWW (rejected Yjs/Automerge — 3mo refactor). Transport: `isomorphic-git`. Reuses existing `CredentialStore` (no new keytar). Migration **0018** |

## Cross-packet interactions (resolve before dispatch)

| Interaction | Decision needed |
|---|---|
| **Migration slot 0018** contested by 07 (notifications) + 09 (cross-sync) | Whichever ships first claims 0018, second gets 0019. Update the second brief on the way to dispatch |
| **04 (whisper.cpp) ↔ 08 (SAPI5 STT)** | If 04 ships whisper.cpp on Win, does 08 still need SAPI5 STT? Or only TTS via SAPI5? — Lead call |
| **03 (drag-drop) ↔ 04 (voice-capture)** | Both write to focused pane via `rpc.pty.write`. The `insertMention` helper in 03 should be reused by 04's voice→pane path. Refactor opportunity, not a blocker |
| **04 (voice) ↔ existing voice-mac** | Don't duplicate Speech.framework — wrap the existing module + add globalShortcut + Tray |

## Effort summary

| Tier | Packets | Total dev-days |
|---|---|---|
| XS (≤2 hr) | 01, 05 | ~½d |
| S (2-3 hr) | 03 | ~½d |
| M (3-8 hr) | 02, 06 | ~1d |
| L (3-5d) | 07, 08 | ~6-9d |
| L+ (5-10d) | 04, 09 | ~12-17d |

**Total all-shipped**: ~20-28 dev-days. **Recommend phased release** across v1.4.8 → v1.5.0.

## Suggested release grouping — 3 work sessions (Option A, locked 2026-05-20)

Each "session" = one bundled dispatch + reviewer pass + release. Compressed from a 4-release plan to 3 to reduce per-release overhead (~1hr each: CHANGELOG + version bump + release notes + memory rows + tag + CI watch).

| Session | Release | Packets | Effort | Lead Q's | Status |
|---|---|---|---|---|---|
| **A** | v1.4.8 | 01 browser-cleanup, 02 sidebar-resize, 03 drag-drop, 05 win-autoupdate | ~1.5d | 0 | **Ready NOW** — all unblocked, no design decisions pending. Dispatch ~4 parallel agents |
| **B** | v1.4.9 | 06 provider-install, 07 notifications, 04 voice-capture (macOS only) | ~10d | 16 (4 + 5 + 7) | Lead answers 16 questions in one sitting, then dispatch UX-decision cluster as 3 parallel agents. macOS voice capture lands here to validate lazy-download UX before fanning to Win+Linux |
| **C** | v1.5.0 | 04 voice-capture (Win+Linux), 08 SAPI5, 09 cross-sync | ~10-12d | 6 + security signoff | Needs Windows VM + threat-model signoff for 09. Heaviest sprint of the bundle. Sequence: 09 signoff → 09+04-Win+Linux+08 parallel (or fold 08 STT into 04's whisper.cpp — open consolidation question) |

### Why 3 sessions, not 4

- **A** is the obvious paper-cut bundle: zero lead questions, all XS/S/M, ships in one work session
- **B** consolidates ALL pending UX decisions (provider-install consent UX + notification taxonomy + voice hotkey/output policy) so lead answers them ONCE. Voice macOS rides along to shake out lazy-download UX before the cross-platform fan-out
- **C** is the heavy/security cluster: Windows VM required for 3 of 3 packets, security signoff for 1 of 3. Natural single sprint

### Why not 2 mega-sessions

Considered. Rejected because:
- Merging 07 (notifications) with C means it waits behind security signoff for no reason
- Session B at ~10d is already close to reviewer-fatigue threshold; pushing to 12-14d (Option C) compounds rollback risk

### Trigger conditions per session

- **A → ship**: nothing blocking. Dispatch any time
- **B → ship**: lead answers the 16 questions in this index. Dispatch within same conversation
- **C → ship**: B's voice-capture-mac validates lazy-download UX cleanly AND lead signs off 09 threat model (S1/S5/S6/S8). Windows VM access confirmed

## All lead questions surfaced by the reviews

These need answers before the affected packet dispatches:

### 04 Voice capture (7 questions)
1. Hotkey default & rebinding UX — accept Cmd+Opt+Space / Ctrl+Alt+Space?
2. Model bundling — confirm lazy-download default + user-selectable size?
3. Clipboard vs pane-focus-aware output policy
4. Show "Listening…" overlay window or just status indicator?
5. Cost stance on OpenAI Whisper API as v1.5 BYOK option
6. macOS notarisation impact (dropped Apple Dev ID 2026-05-18 → mic permission strategy)
7. Background-run when window closed — confirm Tray-only path?

### 06 Provider auto-install (4 questions)
1. `spawnInstall` vs reuse existing launcher flow?
2. Pane lifecycle for install-pane (auto-close on success? leave open?)
3. `uvx` as alternative to `npm i -g` for Python-based CLIs?
4. Defer `detect.ts` (version display) to v1.5.0?

### 07 Notifications (5 questions)
1. Tray icon + bell badge unification?
2. Persisted notifications survive workspace delete?
3. Per-source mute granularity (mute specific pane's exits)?
4. Multi-workspace bell aggregation behavior?
5. Click-to-navigate destination when source pane is gone?

### 09 Cross-sync (6 questions)
1. **S5**: Key management — Option B (safeStorage + BIP-39) vs A (Argon2id passphrase) vs C (hardware key, v1.5.x)?
2. **S1**: Threat model — accept "A4 lost-device" undefended; confirm A7/A8/A9 non-goals?
3. **S8**: Recovery — confirm Signal-style "unrecoverable on full key loss"?
4. **S6**: Sync scope — confirm hard-DENY of `credentials`; in/out for canvases/boards/replay?
5. **S2**: Crypto lib alternative — `@stablelib/*` preferred over `libsodium-wrappers-sumo`?
6. **Effort**: 5-7d as written, or scope-cut to workspaces+conversations+messages only (<4d)?

## Sequencing rules (hard)

- **04 research → 04 impl**: research is locked but the 7 user questions must answer before impl dispatch
- **09 threat-model signoff → 09 impl**: user must answer S1/S5/S6/S8 before any code lands
- **02 must not break CommandRoom grid**: rAF coalesce verified in GridLayout pattern; reuse exactly
- **05 needs Windows VM** for smoke (cannot complete without it)
- **08 needs Windows VM** for COM development + node-gyp prebuild
- **07 must coordinate migration number with 09** (both want 0018)

## Cleanup-loop pattern

Per `~/.claude/skills/orchestrator/SKILL.md`:

1. Delegate → PR push (no merge)
2. Opus 4.7 reviewer pass
3. Verdict: APPROVE / APPROVE-WITH-CAVEATS / REQUEST-CHANGES
4. Cleanup loop if caveats
5. Lead lands the PR

**HARD rules** per `feedback_agent_scope_discipline.md`:
- Agents MUST NOT push tags, bump versions, write release notes, open extra PRs, or auto-merge
- Bind scope at dispatch with explicit "STOP CONDITION" + "HARD PROHIBITIONS" sections
- Verify worktree diff after every Bg dispatch — never fire-and-forget
- SendMessage to a "completed" agent re-invokes it; don't use SendMessage for shutdown

## Review session metadata (2026-05-20)

- 9 parallel agents dispatched: 3 Opus (voice-capture, notifications, cross-sync — design-heavy) + 6 Sonnet (mechanical reviews)
- Wall-clock: ~6 minutes from dispatch to last completion
- Ruflo MCP unavailable for some agents this session (Notion/Drive only were loaded) — agents used fallback CLI where possible; pattern store partial
- All 9 briefs now reflect current `main` state (HEAD `d45a004`)
- 22 unique drift items + 5 hallucinated dependencies caught and corrected
- 2 effort downgrades (03, 05), 3 upgrades (04, 07, 09) — net ~+2 dev-days
- 22 open questions for lead consolidated in this index
