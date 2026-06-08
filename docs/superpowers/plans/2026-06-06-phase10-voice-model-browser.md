# Phase 10 — Voice / model & browser depth (V1+V2+B2+B3+B4) Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. TDD per task, commit per task. Invoke **apple-design** + **frontend-design** for any UI (pane-header badge, voice picker, detached toolbar). **LOCAL GATE ONLY: `tsc -b` · vitest · lint · build — DO NOT run `playwright`/`electron:dev`** (operator's machine; e2e runs in the PR's CI). Steps use `- [ ]`.

**Goal:** Cloud STT choice (V1), live per-pane cost + tok/s + a fast/balanced/deep dispatch preset (V2), browser detach-to-monitor (B2), an agent-drivable headless-browser skill (B3, read-only + gated), and the embedded-browser focus fix (B4).

**Base:** main HEAD `56e6184` (Phase 6 shipped). Each lane is an **isolated git worktree off current main**. Integrate via PR to main at the end (do NOT direct-FF). A concurrent session is active on this repo — keep lanes file-disjoint; re-gate in main at integration.

**Locked decisions (operator):** all 5 items · B3 = navigate + DOM-snapshot READ only (no arbitrary `evaluate`), KV `browser.agentDriving` default **OFF**, SSRF-blocked (https-only, reject private IPs/localhost) + aidefence-scanned + driver-locked + per-turn rate-limited · V2 = preset (fast→haiku / balanced→sonnet / deep→opus) + live cost `$` (real, from CLI usage) + tok/s **estimate** (output chars ÷ 4 ÷ elapsed, labelled "~"). · V1 = picker `[local, gemini-cli, openai-whisper-api, deepgram]`, cloud keys in KV, cloud engines opt-in (disabled w/o key). · B2 = minimal detached native chrome + reattach.

**SHARED SEAM (lead-owned — lanes edit locally so their tsc passes, FLAG in report):** `src/shared/router-shape.ts`, `src/shared/rpc-channels.ts`, `src/shared/types.ts`. Lanes W (B4/B2) + M (V2) touch these; lead hand-merges at integration.

---

## Lane W — Browser window: B4 (focus fix) + B2 (detach-to-monitor)

**Owns:** `src/main/core/browser/manager.ts`, `controller.ts`, `src/renderer/features/browser/BrowserViewMount.tsx`, `BrowserRoom.tsx` (+ tests), `electron/main.ts`; SEAM: `router-shape.ts`/`rpc-channels.ts`/`types.ts`.

### B4 — forward focus to the embedded page (the real bug)
**Root cause (recon):** the browser is a `WebContentsView` attached to the window's `contentView`; `setBounds` positions it but **nothing ever calls `webContents.focus()`** → clicks/typing into web form fields go to the React SPA, not the page. (`manager.ts:357` `ensureView`; `BrowserViewMount.tsx:62-130` only sends bounds.)
- [ ] TDD: extend `BrowserRoom.test.tsx` mock with `focusView`; assert clicking the mount calls `rpc.browser.focusView`.
- [ ] Add `focusView()` to `BrowserManager` — `this.activeTabId`'s `rec.view.webContents.focus()` (guarded try/catch).
- [ ] Add `browser.focusView` to `controller.ts`, `router-shape.ts`, and the `rpc-channels.ts` allowlist. **Also add the missing `'browser.listRecents'`** to the `rpc-channels.ts` allowlist (recon found it absent ~line 126).
- [ ] `BrowserViewMount.tsx`: call `rpc.browser.focusView({ workspaceId })` on a `pointerdown`/`click` handler on the placeholder div (and after `setBounds` on mount when the tab is active).
- [ ] Commit: `fix(browser): forward focus to the embedded WebContentsView so web form fields receive input (BSP-B4)`.

### B2 — detach the browser to a second window + reattach
**Approach (minimal chrome):** a new `BrowserWindow` receives the `WebContentsView` via `removeChildView`(main) → `addChildView`(detached); minimal native toolbar (URL in title + a small HTML toolbar with back/forward/reattach) ; reattach reverses it. `BrowserManager.window` is already a mutable ref (`manager.ts:51` + `setWindow():67`) — designed for this.
- [ ] Add `BrowserState.detached: boolean` (+ `browser:state` event carries it) — `shared/types.ts`.
- [ ] `manager.ts`: `detachToWindow()` creates a 2nd BrowserWindow (minimal/frameless or default frame), moves the active tab's view across `contentView`s, recomputes bounds for the new window, tracks the detached window; `reattach()` reverses. Handle the detached window `close` → reattach. The `windowProvider` (`rpc-router.ts:664`) must resolve the right window per workspace (today single-window focused fallback — make it detach-aware).
- [ ] Add `browser.detachToWindow` + `browser.reattach` RPC (controller + router-shape + rpc-channels).
- [ ] `BrowserRoom.tsx`: a detach/reattach button in the browser chrome; when `detached`, hide the in-window `BrowserViewMount` placeholder + show a "browser detached" state with a Reattach button.
- [ ] The detached window's minimal toolbar: a tiny static HTML page (URL display + back/forward/reattach) loaded into a thin top strip, OR the window title shows the URL — pick the simplest that gives back/forward/reattach. Use `apple-design` for the minimal chrome.
- [ ] TDD where unit-testable (manager state transitions with a fake window/view; the React detach button). Electron multi-window behavior itself is e2e (defer to CI/operator smoke).
- [ ] Commit: `feat(browser): detach the embedded browser to a second window + reattach (BSP-B2)`.

### Lane W gate
`npx tsc -b && npx vitest run src/main/core/browser src/renderer/features/browser && npm run lint && npm run build`. Report the `router-shape.ts`/`rpc-channels.ts`/`types.ts` hunks for the lead.

---

## Lane A — Browser agent: B3 (agent-drivable headless browser, read-only + gated)

**Owns:** `src/main/core/assistant/tools.ts`, `src/main/core/assistant/mcp-host-server.ts`, `src/main/core/assistant/system-prompt.ts`, a new `src/main/core/browser/agent-guard.ts` (SSRF validator) + test. **Do NOT edit `manager.ts`/`controller.ts`/`router-shape.ts`** — use existing `cdp.ts` (`runCDP`) + `manager.claimDriver/releaseDriver` (already present). If you think you need them, STOP + report (Lane W owns them).

**Capability (locked):** navigate + DOM-snapshot READ only — NO arbitrary `evaluate(js)`.

- [ ] **SSRF guard** (`agent-guard.ts`): `assertAgentNavigable(url): void` — allow `https:` only; reject `http:`/`file:`/`javascript:`/`data:`; reject hosts that are `localhost`, `*.local`, or resolve to private/loopback IP literals (`127.`, `10.`, `172.16-31.`, `192.168.`, `::1`, `fc00::/7`, link-local `169.254.`). TDD first: a table of allowed/blocked URLs. (Mirror the existing `open_url` scheme check in `tools.ts:346-354` but extend with the private-IP block.)
- [ ] **KV gate** `browser.agentDriving` default **OFF**: each new tool first reads the KV flag; if off → return a typed "agent browsing is disabled (enable in Settings → Browser)" error, never navigate.
- [ ] **Per-turn rate limit:** a small in-memory counter (max ~20 CDP calls/turn) on the ToolContext; exceeding → error.
- [ ] **Tools** (in `tools.ts`, the Jorvis in-process tool layer — NOT renderer RPC): `browser_navigate({url})` (guard → claimDriver → `browser.navigate`), `browser_snapshot()` (CDP DOM/text dump or `Page.captureScreenshot`→ but READ-only means prefer a DOM/text dump via `runCDP('Runtime.evaluate', {expression:'document.body.innerText', returnByValue:true})` — note this is a fixed read expression, NOT agent-supplied JS), `browser_read_dom()` similar. **aidefence-scan the returned content**: `await ctx.gate.scanIngested(text, 'browser_snapshot')` (pattern from `read_files`, `ToolContext` ~`tools.ts:62-73`) before returning to the model. `releaseDriver` on finish/error.
- [ ] Register the 3 tools in `mcp-host-server.ts` (~line 77+) + document them + the gate in `system-prompt.ts`. Note the **prompt-injection residual** (page content can steer the agent) in a code comment + the system-prompt tool doc.
- [ ] TDD: SSRF table; KV-off returns the disabled error (no navigate); rate-limit trips; snapshot output passes through `scanIngested` (mock the gate, assert it's called).
- [ ] Commits per piece: `feat(security): SSRF guard for agent browser driving (BSP-B3)` · `feat(assistant): read-only agent-drivable browser tools, default-off + aidefence-gated (BSP-B3)`.

### Lane A gate
`npx tsc -b && npx vitest run src/main/core/assistant src/main/core/browser && npm run lint && npm run build`.

---

## Lane V — Voice: V1 (multi-provider STT picker)

**Owns:** `packages/voice-core/src/whisper-engine.ts`, new `packages/voice-core/src/cloud-stt-engine.ts`, `packages/voice-core/src/global-capture.ts`, `src/renderer/features/settings/VoiceTab.tsx` (+ tests), `src/main/core/credentials/storage.ts` (read only — add a key namespace if needed).

**Locked:** picker `[local, gemini-cli, openai-whisper-api, deepgram]`; cloud keys in KV (`voice.stt.<provider>.apiKey`); cloud engines **opt-in** (the option is disabled/greyed until a key is present); resolve stays single-engine.

- [ ] Widen `TranscriptionMode` (`whisper-engine.ts:95`) to add `'openai-whisper-api' | 'deepgram'`. Keep `resolveTranscriptionEngine` (`:107-117`) returning the right engine per mode.
- [ ] New `cloud-stt-engine.ts`: a `WhisperEngine`-shaped factory per cloud provider that POSTs the captured audio to the provider's STT endpoint with the KV-stored key (OpenAI `/v1/audio/transcriptions`; Deepgram `/v1/listen`). Pure-ish: inject `fetch` + a `getApiKey(provider)` for testability. On missing key → throw a typed `SttKeyMissingError` (caller surfaces a toast).
- [ ] `global-capture.ts` (~line 483): build the cloud engine(s) from KV keys and pass into `resolveTranscriptionEngine` alongside the existing local/gemini engines.
- [ ] `VoiceTab.tsx` `GlobalCaptureSection` (~507-539): expand the 2-button segmented control to the 4 providers; add a per-cloud-provider API-key `<input type="password">` (persist to KV `voice.stt.<provider>.apiKey`); disable a cloud option until its key is set, with a hint.
- [ ] TDD: `whisper-engine.test` resolve picks the right engine per mode incl. the 2 new; `cloud-stt-engine.test` (mock fetch) builds the right request + parses the transcript + throws on missing key; `VoiceTab` test: the 4 options render, a cloud option is disabled w/o a key + enabled with one, selecting persists the KV mode. (Renderer tests mock `rpc.kv`; no real network.)
- [ ] Commits: `feat(voice): cloud STT engines (OpenAI/Deepgram) behind the WhisperEngine interface (BSP-V1)` · `feat(voice): multi-provider STT picker + per-provider key field in VoiceTab (BSP-V1)`.

### Lane V gate
`npx tsc -b && npx vitest run packages/voice-core src/renderer/features/settings && npm run lint && npm run build`.
> NOTE: `packages/voice-core` may have its own build — confirm `tsc -b` covers it; if the voice-core has native deps, do NOT rebuild natives (no `electron-builder`/`pack`). Unit tests mock fetch — no live mic/network.

---

## Lane M — Model/usage: V2 (dispatch preset + live cost/tok-s)

**Owns:** `src/main/core/usage/dao.ts` (read; add a live-rate helper if needed), a usage RPC for live polling, `src/renderer/features/command-room/PaneHeader.tsx` + `pane-identity.ts`, a new `usePaneLiveStats` hook, `src/renderer/features/workspace-launcher/AgentsStep.tsx` + `Launcher.tsx`, `src/main/core/workspaces/launcher.ts` (`buildExtraArgs`); SEAM: `router-shape.ts`/`rpc-channels.ts`/`types.ts`.

### V2a — fast/balanced/deep dispatch preset
**Locked mapping:** fast→`claude-haiku-4-5` · balanced→`claude-sonnet-4-6` · deep→`claude-opus-4-7` (read the real ids from `model-catalog.ts`). The preset is a UI shorthand that sets the existing per-row `modelId` (no new spawn flag needed — `buildExtraArgs` already injects `--model`).
- [ ] `AgentsStep.tsx` (~300-327): add a 3-button **fast/balanced/deep** segmented control above/beside the per-row `ModelSelect`; selecting sets `models.claude = <mappedId>` via the existing `onModelsChange`. Keep the raw ModelSelect for power users.
- [ ] Thread the preset/modelId through the **`+Pane`** path too (`AddAgentToSwarmInput`, `shared/types.ts:222` already has `modelId` — confirm it's honored at `addAgent` spawn; sibling-site per [[feedback_grep_sibling_call_sites]]).
- [ ] TDD: `AgentsStep.test` — clicking "deep" sets the opus id; the mapping table is unit-tested.
- [ ] Commit: `feat(launcher): fast/balanced/deep dispatch preset → model mapping (BSP-V2)`.

### V2b — live cost + tok/s estimate in the pane header
- [ ] Add a usage RPC for a single session's running totals (reuse `usage.sessionSummary` if present; else add `usage.sessionLive`). Real cost = `total_cost_usd` sum.
- [ ] `usePaneLiveStats(sessionId)` hook: poll the usage RPC every ~3s; compute tok/s **estimate** = `outputTokensDelta / secondsDelta` (or, if only post-hoc tokens exist, derive from the streamed text length ÷ 4 over elapsed — labelled "~"). Use `useSyncExternalStore`/refcount pattern if a poller already exists.
- [ ] `PaneHeader.tsx` (~160, the title pill `{alias} · {effortLabel}`): add a compact `~N tok/s · $X` badge (truncate-safe; reduced-motion-safe; apple-design). Honest "~" prefix on the estimate. Hidden when no usage yet.
- [ ] TDD: `PaneHeader.test` renders the badge when stats present, hides when absent; the tok/s estimate math is unit-tested; cost shows the real `$`.
- [ ] Commit: `feat(command-room): live cost + tok/s estimate badge in the pane header (BSP-V2)`.

### Lane M gate
`npx tsc -b && npx vitest run src/main/core/usage src/renderer/features/command-room src/renderer/features/workspace-launcher && npm run lint && npm run build`. Report the seam hunks.

---

## Integration (LEAD) → PR to main
1. After all lanes return + Opus review each, capture each worktree diff (`git -C <wt> add -A && git -C <wt> diff --cached <merge-base>`).
2. Branch off **current origin/main** (re-fetch — concurrent session moves it). Wholesale-checkout each lane's disjoint files; **hand-merge the shared seam** (`router-shape.ts`/`rpc-channels.ts`/`types.ts` — additive across lanes W + M).
3. Re-gate in the integration branch: `tsc -b` · full `npm test` · lint · build. **Defer e2e to the PR's CI e2e-matrix** (no local playwright).
4. Push the branch + open ONE PR to main (title "Phase 10 — voice/model & browser depth"). Do NOT direct-FF.

## Self-review
- Coverage: V1 (Lane V), V2a+V2b (Lane M), B2+B4 (Lane W), B3 (Lane A). ✓
- Security: B3 SSRF guard + default-OFF KV + aidefence scan + driver-lock + rate-limit; prompt-injection residual documented. ✓
- Seam: only Lanes W + M touch router-shape/rpc-channels/types; lead merges. ✓
- No-local-e2e respected (gates are tsc/vitest/lint/build). ✓
