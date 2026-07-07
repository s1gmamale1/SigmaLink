# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.** Low ceremony.
> Promote an item into [ROADMAP.md](ROADMAP.md) when it gets scoped into a phase.
>
> Buckets: **Deferred by design** (consciously out of scope) and **Future enhancements**
> (planned-later upgrades). **New ideas** is the untriaged inbox.
>
> **Cleared 2026-07-07** at the start of the Jorvis-evolution cycle. The full previous inbox
> (v2.9.x era: pane hibernate, theme follow-ups, notification lows/design-gaps, Phase 2.5 residue,
> multi-window residue, …) is preserved verbatim in
> [docs/03-plan/archive/WISHLIST-pre-jorvis-cycle-2026-07-07.md](docs/03-plan/archive/WISHLIST-pre-jorvis-cycle-2026-07-07.md)
> — still-alive items get re-promoted from there when they come up.

---

## 🚫 Deferred by design (out of scope for now)

_(consciously NOT built — each is a separate track or a non-goal, not a gap)_

---

## ✨ Future enhancements (planned-later upgrades)

_(real upgrades to build once the current system is production-grade)_

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

### Jorvis P0 execution — parked review findings (2026-07-07, Phase 19 branch)

_Non-blocking findings from the subagent review loop during P0 implementation. Both Important-but-edge; deferred out of P0.2 by lead + reviewer agreement._

- 🐞 **[med][jorvis] Retry button re-sends the CURRENT `lastSentPromptRef`, not the failed turn's prompt** — `app/src/renderer/features/jorvis-assistant/JorvisRoom.tsx` `onRetryError` reads a shared mutable ref at click time. Repro: turn A fails → Retry shows on error row A → click Retry, A succeeds (no new error row, so row A's Retry persists) → send unrelated prompt C → `lastSentPromptRef='C'` → clicking row A's still-live Retry silently sends **C**, not A. Wrong-action-on-click, no visual cue. Fix: capture the failed prompt ONTO the error row (thread a `retryPrompt` onto the committed error `ChatMessageView`) and have Retry send that, not the shared ref; or clear/hide Retry once its row is no longer the active failure. Effort: S–M. (rev-t2, P0.2 review.)
- 🐞 **[low][jorvis] Ruflo pattern-store records a FAILED turn's prompt as a `task-completion` pattern** — the `standby` branch's fire-and-forget `ruflo.patterns.store` fires on any standby, including the error path's trailing standby. PRE-EXISTING (predates P0.2; before it, `kind:'error'` was unhandled so every failed turn hit this deterministically — P0.2 actually NARROWS the window to the rare adoption race). Fix: gate the pattern-store on a real success signal, not bare standby. Effort: S. (rev-t2 + impl-t2, P0.2 review.)
- 🐞 **[low][jorvis] `sendPrompt` ignores `res.busy` — a programmatic re-send in the sub-tick window after `kind:'error'` unlocks the renderer can attach to a retired turn** — main frees `liveTurnByConversation` in the IIFE finally, a tick AFTER the synchronous delta→error→standby emits; a re-send inside that window gets `{busy:true, turnId:<retired>}` and `JorvisRoom.sendPrompt` latches the dead turnId → orphaned optimistic row + composer locked until the watchdog. NOT reachable by a human click (>100ms). Clean fix is nuanced — the same path intentionally gives multi-window attach-to-live-turn. Effort: S–M. (rev-final, P0 whole-branch review.)
- 🐞 **[low][telegram] a prompt sent while a turn is live is silently dropped** — the P0.1 busy guard returns before `appendMessage`, so a second Telegram prompt during a live turn persists nothing, spawns nothing, and the remote user gets NO reply (invisible drop; strictly better than the old double-spawn but still silent). Fix: on `res.busy` reply "Jorvis is still working — resend in a moment." Effort: S. (rev-final, P0 whole-branch review.)
- 🧹 **[nit][test] no named render-count regression test pins the error-row + Retry memo contract** — the existing `ChatTranscript.render-count.test.tsx` stays green but nothing explicitly guards that an error row + its Retry button don't re-invoke `useJorvisStreamReveal` or break `memo(ChatRow)` skipping. Add a named case. Effort: XS. (rev-t2, P0.2 review.)

---

## 🔬 Deep review findings (2026-07-07) — Jorvis full-subsystem map

_5-lane read-only recon (main-process core · renderer UI · IPC/DB plumbing · integrations · docs/philosophy) run at `563ae08` (main) while grounding the Jorvis-evolution cycle. Full synthesized map lives in the session record + Ruflo `patterns/verdict:jorvis-full-map-2026-07-07`. All paths `app/src/…` unless noted._

### Confirmed bugs

> ✅ **Struck items FIXED in PR #222 `2805d37` (2026-07-07, Phase 19 / Jorvis P0):** orphan `assistant:security` emit DELETED (P2+ owns the real surface) · concurrent-turn guard shipped (atomic claim, race-test-pinned after the sigma-check round-1 catch) · `refResolve` routed through path-guard (now follows symlinks; dotfiles excluded, disclosed+pinned) · `resumeHint` schema stub added · stale WISHLIST twin archived to `docs/03-plan/archive/WISHLIST-legacy-2026-07-07.md` · stale comments fixed. Kept below struck-through as the record.

- ~~🐞 **[medium][assistant] `assistant:security` is an orphan event — the "Security: PENDING → active" UX does not exist**~~ — `main/core/assistant/controller.ts:189` emits `assistant:security` from the aidefence audit hook (comments at `controller.ts:182-183`, `rpc-router.ts:2562`, `aidefence-gate.ts:5,16` all describe a renderer surface consuming it), but the event is absent from the `EVENTS` allowlist in `shared/rpc-channels.ts` (preload would silently no-op it, #188 dead-plane class) AND zero renderer subscribers exist (grep-verified). The aidefence audit signal is write-only telemetry nobody reads. Fix: either wire it end-to-end (EVENTS entry + subscriber + a security indicator surface) or delete the emit + the three stale comments. The renderer-wide `eventOn()` scan test (`rpc-channels.test.ts:656`) can't catch emitted-but-never-subscribed events — consider an inverse check. Effort: S–M.
- ~~🐞 **[medium][assistant] no concurrent-turn cap — N `claude` child processes can run against one conversation**~~ — `controller.ts:178` `activeTurns` is an unbounded Map; `send()` (`controller.ts:422`) fires an unawaited async IIFE per call with no per-conversation dedupe/queue. The only guard is the renderer's `busy` composer gate — which is per-window state, so multi-window / Telegram / external origins can stack turns. Fix: main-side per-conversation in-flight guard (reject or queue a second `send` while a turn is live). Effort: S.
- ~~🐞 **[low][assistant] `refResolve` @-mention file walk bypasses the `read_files` sandbox**~~ — `controller.ts:780-839` does a synchronous recursive walk trusting the workspace's own `rootPath`, with none of the `assertAllowedPath`/realpath-symlink safety the hardened `read_files` path has (`tools.ts:637-642`, `security/path-guard.ts:91-116`). Low blast radius (workspace the user already opened) but an inconsistency between two file-touching surfaces in the same subsystem. Fix: route the walk's root + each resolved path through the same path-guard. Effort: S.
- ~~🐞 **[low][rpc] `assistant.conversations.resumeHint` has no `schemas.ts` entry — payload flows validation-free with a dead warning branch**~~ — live in `CHANNELS` (`shared/rpc-channels.ts:255`), documented in `router-shape.ts:877-879`, real handler (`conversations-controller.ts:97-124`), but `core/rpc/schemas.ts:952-955` only registers `list`/`get`/`delete`. Per `validate.ts:41-52` a schema-less channel passes through unvalidated, and the "gap visible in dev" warn only fires under `VALIDATION_MODE==='warn'` while it's hardcoded `'enforce'` (`schemas.ts:151`). Handler has a manual typeof guard so severity is low, but it breaks the "every channel gets at least a stub" invariant. Fix: add the stub; consider making the missing-schema warn fire under `enforce` too. Effort: S.

### Docs rot / hygiene

- ~~🧹 **[docs] stale twin `docs/03-plan/WISHLIST.md` actively misleads recon — archive or delete it**~~ — an older wishlist lineage (last touched `4aea51e`, ~v2.5.0 era) coexists with this canonical root file; it still lists the 2026-06-10 Jorvis renderer bugs (pane-events copy-on-add, hydrate token guard, jump-to-message single-rAF, setState-in-updater) as OPEN although all 4 fixes are live in source with inline audit-finding comments (`renderer/features/jorvis-assistant/use-jorvis-pane-events.ts:32`, `use-jorvis-conversations.ts:76-181`, `use-jorvis-jump-to-message.ts:14`, `use-jorvis-assistant-state.ts:187-208`). A docs-only recon lane got fooled by it on 2026-07-07. Effort: XS.
- ~~🧹 **[comments] stale-fact comments in the assistant core**~~ — (a) `controller.ts:60-64` says the CLI registers "the 13 Sigma tools"; live count is **39** (`tools.ts` `TOOLS`, contract-tested vs `tool-catalogue.ts`). (b) `authorization.test.ts:87` test TITLE lists only 3 of the 4 `DANGEROUS_REMOTE` members (assertion is correct, includes `kill_swarm`). Effort: XS.
- 🧹 **[naming] three naming eras coexist in jorvis-assistant test-ids** — `bridge-conversations-panel` (`ConversationsPanel.tsx:58`), `sigma-interrupted-banner`/`sigma-resume-banner` (`InterruptedTurnBanner.tsx:15`, `ResumeBanner.tsx:13`) vs the current `jorvis-*` convention. Cosmetic; rename alongside the next e2e touch. Effort: XS.
- 🧹 **[nit] two separate `lazy()` wrappers for `JorvisRoom`** — `app/App.tsx:66` (standalone room) + `right-rail/JorvisTabPlaceholder.tsx:16-19` (rail tab) each mint their own lazy identity/Suspense boundary for the same chunk. Harmless; unify if the double-spinner is ever noticed. Effort: XS.

### Known-and-acknowledged (carried forward as explicit watch items)

- ⚠️ **[security/hardening] browser agent-guard has no DNS-rebinding protection** — self-documented at `main/core/browser/agent-guard.ts:24-29`: SSRF checks are literal-hostname-only; a public hostname rebinding to a private IP post-check slips through. File recommends `webRequest.onBeforeRequest`-level hardening. Only reachable when the default-OFF `browser.agentDriving` KV is enabled. Effort: M.
- ⚠️ **[skills] skill "bindings" are informational-only — they do NOT change what Jorvis can do** — `main/core/skills/controller.ts:142-147` self-documents: attach/detach are UI chip associations; behavioral activation is a deferred enhancement. Flag kept here so nobody assumes attaching a skill alters dispatch/tool-calling. (Behavioral skills are in-scope for the Jorvis-evolution brainstorm.)
- ℹ️ **[db] shell-first `cli-exited` events are deliberately NOT persisted to `jorvis_pane_events`** — `rpc-router.ts:1009-1013`: `'cli-exited'` isn't in the table's kind CHECK constraint and no migration was added; notification still fires. Asymmetry to remember if a pane-timeline/activity view is ever built over that table. Effort: S (migration) if ever needed.
- ℹ️ **[jorvis] `turnId` missing on the `ToolTrace` payload** — `InlineToolChips.tsx:28` keeps a dead `turnId` prop; chips are conversation-scoped only, can't distinguish overlapping turns (relevant the moment the concurrent-turn cap work lands, or if concurrent turns ever become a feature). Carried from the pre-jorvis-cycle inbox. Effort: S.
