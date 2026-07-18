# Windows Audit Fix Wave (2026-07-03) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every *fixable* finding from the 2026-07-03 Windows-parity audit (WISHLIST.md "🔍 Windows-parity audit" section) — A1 cmd sentinel, A2 forget() tree-kill, A3 dead RSS hook, D1–D4 doc drift, C1/C2/C4 CI+UX seams — and refresh PR #209 (B2).

**Architecture:** All changes are main-process / native-stub / docs / CI — zero renderer UI changes (design freeze). Fixes land on `worktree-windows-audit-fixes` (based on `origin/main@5681f5e`), pushed as `fix/windows-audit-wave-1`. PR #209 refresh happens on its own branch in a separate throwaway worktree.

**Tech Stack:** TypeScript (Electron main), vitest (via node_modules junction — do NOT run `pnpm install`; native builds fail locally per project memory), N-API stub JS, GitHub Actions YAML, PSScriptAnalyzer.

**Audited evidence:** every `file:line` in this plan was read directly at `origin/main@5681f5e`. Baseline: `pnpm exec vitest run src/main/core/pty/sentinel.test.ts src/main/core/ram-brake/session-risk.test.ts` → 47/47 green.

**Explicitly deferred (documented in WISHLIST, not in this plan):**
- **B1** (enable win32 shell-first) — requires operator dogfooding; Task 1 is its prerequisite.
- **B3** (whisper-on-Windows) — new native C++ (PCM tap) + MSVC LNK4042 build work; own spec.
- **B4** (win-arm64 targets) — needs an arm64 prebuild matrix decision; WoA runs via x64 emulation today.
- **C3** (NSIS expansion), **C5** (tray icon 32px — visual/design freeze), **E1/E2** (renderer hygiene — design freeze).

---

### Task 1: A1 — Fix the cmd.exe exit sentinel (conditional-echo form)

**Why:** `buildCmdSentinelSnippet()` is triply broken: stray `%` before the suffix; `SET __SL_EC=%ERRORLEVEL%` captures the *pre-line* errorlevel (cmd expands `%VAR%` at parse time for the whole `&`-chained interactive line); `%__SL_EC%` in the echo expands at parse time too (undefined on first use). No single-line interactive form can read `%ERRORLEVEL%` post-execution without delayed expansion, and spawning the pane shell with `/V:ON` would change `!` semantics for everything the user types. **Chosen design:** conditional-echo — `&& (echo. & echo …_0__) || (echo. & echo …_1__)` — zero variable expansion; non-zero exit codes collapse to `1` (documented; pwsh panes keep exact codes; cmd is only the shell when pwsh AND powershell.exe are missing, or for unknown shells).

**Files:**
- Modify: `app/src/main/core/pty/sentinel.ts:164-196` (snippet + doc comment)
- Test: `app/src/main/core/pty/sentinel.test.ts:234-278` (replace the Phase-5 cmd blocks)

- [ ] **Step 1: Replace the cmd-snippet tests with failing tests for the new form**

Delete the two describe blocks `buildCmdSentinelSnippet (Phase 5 — win32 cmd.exe)` (lines 239-261) and `buildCmdSentinelSnippet round-trip (Phase 5)` (lines 263-~278) and insert:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-03 audit A1 — win32 cmd.exe sentinel, conditional-echo form.
//
// The old SET-capture form could never work: cmd expands %VAR% at PARSE time
// for the whole `&`-chained interactive line, so SET captured the pre-line
// ERRORLEVEL and the echo expanded __SL_EC before SET ran. The fixed snippet
// uses `&& … || …` conditional echoes — no variable expansion anywhere, at the
// documented cost of collapsing non-zero exit codes to 1.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCmdSentinelSnippet (audit A1 — conditional-echo)', () => {
  it('contains no cmd variable-expansion tokens at all', () => {
    const snippet = buildCmdSentinelSnippet();
    expect(snippet).not.toContain('%');
    expect(snippet).not.toContain('!');
  });

  it('is exactly the conditional-echo pair (success 0 via &&, failure 1 via ||)', () => {
    expect(buildCmdSentinelSnippet()).toBe(
      ` && (echo. & echo ${SENTINEL_PREFIX}0${SENTINEL_SUFFIX})` +
        ` || (echo. & echo ${SENTINEL_PREFIX}1${SENTINEL_SUFFIX})`,
    );
  });
});

describe('buildCmdSentinelSnippet round-trip (audit A1)', () => {
  // `echo X` prints X verbatim and `echo.` prints a blank line; because the
  // snippet contains no % or ! tokens, cmd performs NO expansion on it — this
  // simulation is now faithful to real cmd semantics (unlike the old tests,
  // which hand-simulated output the buggy snippet could never produce).
  it('success-path output matches SENTINEL_RE with code 0', () => {
    const out = `CLI output\r\n\r\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\r\nC:\\> `;
    const result = extractSentinel(out);
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(result!.strippedData).not.toContain(SENTINEL_PREFIX);
  });

  it('failure-path output matches SENTINEL_RE with code 1', () => {
    const out = `\r\n${SENTINEL_PREFIX}1${SENTINEL_SUFFIX}\r\n`;
    expect(extractSentinel(out)!.exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify the exact-string test fails**

Run: `pnpm exec vitest run src/main/core/pty/sentinel.test.ts`
Expected: FAIL — old snippet ` & SET __SL_EC=%ERRORLEVEL% & …` ≠ conditional-echo string; the "no % tokens" test also fails.

- [ ] **Step 3: Implement the new snippet + rewrite the doc comment**

Replace `sentinel.ts` lines 164-196 (the cmd doc comment + `buildCmdSentinelSnippet`) with:

```ts
/**
 * Build the cmd.exe snippet that emits the sentinel after the CLI exits.
 *
 * Appended to the injected interactive command line:
 *   claude --args && (echo. & echo __SIGMALINK_CLI_EXIT_0__) || (echo. & echo __SIGMALINK_CLI_EXIT_1__)
 *
 * WHY conditional echoes instead of %ERRORLEVEL% (2026-07-03 audit A1):
 * cmd.exe expands every `%VAR%` at PARSE time for the entire `&`-chained
 * interactive line — before ANY command in the line has run. A same-line
 * `SET __SL_EC=%ERRORLEVEL%` therefore captures the PRE-line errorlevel, and
 * a same-line `echo %__SL_EC%` expands before the SET executes (undefined on
 * first use → echoed literally). Delayed expansion (`cmd /V:ON` + !VAR!)
 * would fix that but changes `!` handling for everything the user types into
 * the pane shell — unacceptable. The conditional-echo pair needs no
 * expansion at all.
 *
 * FIDELITY TRADE: non-zero exit codes collapse to 1 on cmd.exe (pwsh panes
 * keep exact codes via $LASTEXITCODE). `&&`/`||` bind to the CLI because it
 * is the only preceding command; `(echo. & echo …)` always succeeds, so the
 * `||` arm cannot double-fire after a successful `&&` arm.
 *
 * `echo.` prints the blank line that gives SENTINEL_RE its line-start anchor.
 * The caller appends `\r\n` or `\n` (the Enter keystroke; both work in ConPTY).
 */
export function buildCmdSentinelSnippet(): string {
  return (
    ` && (echo. & echo ${SENTINEL_PREFIX}0${SENTINEL_SUFFIX})` +
    ` || (echo. & echo ${SENTINEL_PREFIX}1${SENTINEL_SUFFIX})`
  );
}
```

- [ ] **Step 4: Run to verify pass + neighbors**

Run: `pnpm exec vitest run src/main/core/pty/sentinel.test.ts src/main/core/pty/registry-lifecycle.test.ts src/main/core/pty/local-pty.test.ts`
Expected: PASS (local-pty tests exercise `buildWin32CmdCommandLine(withSentinel=true)` — if any assert the old snippet substring, update them to the new form in the same spirit as Step 1).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/core/pty/sentinel.ts app/src/main/core/pty/sentinel.test.ts app/src/main/core/pty/local-pty.test.ts
git commit -m "fix(pty): cmd.exe exit sentinel — conditional-echo form (audit A1)"
```

---

### Task 2: A2 — Tree-aware kill in `forget()` on win32 (escalation hardening)

**Why:** Primary pane teardown is tree-aware (`stop({tree:true,forget:true})`), but `forget()`'s own still-alive branch (clean-replace at `registry.ts:277`, stop-escalation, direct calls) does `pty.kill()` + single-PID SIGKILL only — on Windows that can strand MCP/npx descendants. Gate the tree call to win32 to avoid changing macOS teardown semantics in a Windows PR.

**Files:**
- Modify: `app/src/main/core/pty/registry.ts:569-575` (inside `forget()`)
- Test: `app/src/main/core/pty/registry-lifecycle.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing tests** (append at end of `registry-lifecycle.test.ts`; it already mocks `../process/process-tree` via `processTreeMock` and intercepts `process.kill` for `FAKE_PID`):

```ts
describe('forget() teardown is tree-aware on win32 (2026-07-03 audit A2)', () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('win32: forget() on a live record routes the kill through stopProcessTree, then drops the handle', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const h = makeLifecyclePty();
    vi.mocked(spawnLocalPty).mockReturnValue(h.pty);
    const registry = new PtyRegistry(() => undefined, () => undefined);
    registry.create({ ...baseInput, sessionId: 'pane-w32-forget' });

    registry.forget('pane-w32-forget');

    expect(processTreeMock.stopProcessTree).toHaveBeenCalledWith(FAKE_PID, expect.any(Number));
    expect(h.pty.killCalls).toBe(1); // handle release still happens after the tree kill
  });

  it('non-win32: forget() keeps the pty.kill() + SIGKILL fallback path (no tree call — macOS semantics unchanged)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const h = makeLifecyclePty();
    vi.mocked(spawnLocalPty).mockReturnValue(h.pty);
    const registry = new PtyRegistry(() => undefined, () => undefined);
    registry.create({ ...baseInput, sessionId: 'pane-posix-forget' });

    registry.forget('pane-posix-forget');

    expect(processTreeMock.stopProcessTree).not.toHaveBeenCalled();
    expect(h.pty.killCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify the win32 test fails**

Run: `pnpm exec vitest run src/main/core/pty/registry-lifecycle.test.ts`
Expected: FAIL — `stopProcessTree` not called.

- [ ] **Step 3: Implement** — in `forget()`, at the top of the `if (stillAlive) {` block (before `rec.pty.kill()`), insert:

```ts
      // 2026-07-03 audit A2 — on Windows a single-PID kill strands MCP/npx
      // descendants of the old process. Route the escalation through the same
      // tree-aware taskkill path stop({tree:true}) uses. win32-gated so macOS
      // teardown semantics stay byte-for-byte unchanged.
      if (process.platform === 'win32') {
        try {
          stopProcessTree(pid, PTY_KILL_FALLBACK_MS);
        } catch {
          /* ignore — fall through to pty.kill() + SIGKILL fallback */
        }
      }
```

(`stopProcessTree` and `PTY_KILL_FALLBACK_MS` are already imported/defined in this file — see `registry.ts:26` and the existing `stop()` usage at `:531`.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run src/main/core/pty/registry-lifecycle.test.ts src/main/core/pty/registry.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/core/pty/registry.ts app/src/main/core/pty/registry-lifecycle.test.ts
git commit -m "fix(pty): tree-aware forget() escalation on win32 (audit A2)"
```

---

### Task 3: A3 — Remove the dead `priorTotalRssBytes` hook

**Why:** `classifyClaudeSessionRisk`'s `priorTotalRssBytes` param has zero producers (grep: only its declaration and single use), so the `>750 MB → critical` branch is unreachable. Proper observed-RSS enforcement is PR #209's admission-level design — remove the stub rather than half-wire it.

**Files:**
- Modify: `app/src/main/core/ram-brake/session-risk.ts:45-52`

- [ ] **Step 1: Confirm zero references** (repeat the audit's grep so the removal is provably safe)

Run: `grep -rn "priorTotalRssBytes" app/src app/packages 2>/dev/null`
Expected: exactly 2 hits, both in `session-risk.ts`.

- [ ] **Step 2: Remove the field + branch**

```ts
export function classifyClaudeSessionRisk(input: {
  sessionBytes: number;
  lineCount: number;
}): SessionRiskLevel {
  // NOTE (2026-07-03 audit A3): an unwired `priorTotalRssBytes > 750MB →
  // critical` hook was removed here — no caller ever produced it. Observed
  // process-tree RSS enforcement belongs to the admission layer (PR #209).
  if (input.sessionBytes > 8 * 1024 * 1024 || input.lineCount > 1800) return 'critical';
  if (input.sessionBytes >= 4 * 1024 * 1024 || input.lineCount >= 1200) return 'high';
  if (input.sessionBytes >= 1 * 1024 * 1024 || input.lineCount >= 500) return 'medium';
  return 'low';
}
```

- [ ] **Step 3: Verify**

Run: `pnpm exec vitest run src/main/core/ram-brake/ && pnpm exec tsc --noEmit -p tsconfig.json`
(If the app uses project references and `tsc --noEmit -p` errors on config, use the package's own check: `pnpm run lint` — eslint runs the TS parser over the tree.)
Expected: PASS / no type errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/core/ram-brake/session-risk.ts
git commit -m "refactor(ram-brake): drop unreachable priorTotalRssBytes hook (audit A3)"
```

---

### Task 4: D3 — voice-win stub parity + honest header

**Files:**
- Modify: `app/native/voice-win/index.js:9-12` (header) and `:43` (stub)

- [ ] **Step 1: Fix the header comment** — replace the sentence at lines 9-12:

```js
// The stub's `stop()`/`requestPermission()` resolve no-op payloads;
// `start()` REJECTS with `code: 'unsupported'` so callers cannot believe a
// dead recognizer is capturing. The voice adapter checks `isAvailable()`
// first anyway, but defending the contract end-to-end keeps unit tests
// boring on macOS CI.
```

- [ ] **Step 2: Add the missing stub method** — in `buildStub()` after `onState: noop,` (line 42), add:

```js
    // Parity with the native export (sigmavoice_win.cc): output-router probes
    // this with a typeof check before calling; the stub returns "unknown" so
    // the PowerShell frontmost-app fallback engages.
    getFrontmostAppExePath() {
      return '';
    },
```

- [ ] **Step 3: Verify**

Run: `node -e "const m=require('./app/native/voice-win/index.js'); console.log(typeof m.getFrontmostAppExePath, typeof m.isAvailable)"`
Expected: `function function` (stub or native — both now expose it).
Run: `pnpm exec vitest run src/main/core/voice/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/native/voice-win/index.js
git commit -m "fix(voice-win): stub exports getFrontmostAppExePath + honest header (audit D3)"
```

---

### Task 5: D1 + D2 + D4 + C4 — documentation pass

**Files:**
- Modify: `README.md:342`, `app/README.md:126`, `app/src/main/core/voice/native-win.ts:8-12`, `app/src/main/core/voice/native-mac.ts:8-12`, `app/native/voice-win/index.d.ts` (near `isAvailable`), `.github/workflows/e2e-matrix.yml:74-77`

- [ ] **Step 1 (D1a):** Replace `README.md:342` bullet:

```markdown
- **Voice parity** — Windows has native SAPI5 offline STT since v1.5.0 (`@sigmalink/voice-win`); macOS uses Speech.framework plus optional local whisper.cpp. Linux remains on the Web Speech API fallback; whisper.cpp offline transcription is currently macOS-only.
```

- [ ] **Step 2 (D1b):** In `app/README.md:126`, replace the sentence `Voice capture on Windows currently routes through the Chromium Web Speech API (requires internet); a native SAPI5 binding is deferred to v1.3+.` with:

```markdown
Voice capture on Windows uses the native SAPI5 binding (`@sigmalink/voice-win`, shipped v1.5.0), with the Chromium Web Speech API as fallback when the native module is unavailable; whisper.cpp offline transcription remains macOS-only.
```

- [ ] **Step 3 (D2):** In BOTH `native-win.ts:8-12` and `native-mac.ts:8-12`, replace the "does not (yet) register" sentence with:

```ts
 * Why a relative createRequire rather than a workspace import? Historical —
 * when this loader was written the native packages were not yet workspace
 * members. pnpm-workspace.yaml registers them since v1.4.8, but the relative
 * createRequire keeps working identically for dev checkouts and packaged
 * (asar-disabled) layouts, so it stays.
```

- [ ] **Step 4 (D4):** In `app/native/voice-win/index.d.ts`, add above the `isAvailable` declaration:

```ts
  /**
   * NOTE (PR #53 caveat 2): unlike @sigmalink/voice-mac (sync boolean), this
   * is ASYNC on Windows — the SAPI5 probe hops to the STA thread. The
   * load-failure stub returns a sync `false`. Callers must wrap:
   * `await Promise.resolve(mod.isAvailable())` (see voice/diagnostics.ts).
   * Also: SAPI5 ignores the `onDevice` / `addPunctuation` start options
   * (always on-device; punctuation is grammar-dependent).
   */
```

- [ ] **Step 5 (C4):** In `.github/workflows/e2e-matrix.yml`, extend the rebuild comment (after the voice-whisper sentence, before the `run:` line) with:

```yaml
        # voice-mac / voice-win are likewise skipped on purpose: e2e smoke
        # never exercises native voice; the unit suites cover them with mocks.
```

- [ ] **Step 6: Verify + commit**

Run: `grep -rn "not yet shipped\|deferred to v1.3\|does not (yet )\?register" README.md app/README.md app/src/main/core/voice/ | grep -v Binary`
Expected: no hits.

```bash
git add README.md app/README.md app/src/main/core/voice/native-win.ts app/src/main/core/voice/native-mac.ts app/native/voice-win/index.d.ts .github/workflows/e2e-matrix.yml
git commit -m "docs: correct Windows voice claims + stale loader comments (audit D1/D2/D4/C4)"
```

---

### Task 6: C2 — explain the unsigned-updater UAC error (message + coupled test)

**Files:**
- Modify: `app/electron/auto-update.ts:157`
- Modify: `app/src/renderer/features/settings/UpdatesTab.test.tsx:113` (fixture mirrors the string — test-fixture edit only, freeze-compatible)

- [ ] **Step 1:** In BOTH files, replace the string
`'Admin permission required. Re-run the SigmaLink installer to upgrade: https://github.com/s1gmamale1/SigmaLink/releases/latest'`
with
`'Update blocked by Windows (UAC). SigmaLink is not code-signed yet, so elevation can be denied — re-run the SigmaLink installer to upgrade: https://github.com/s1gmamale1/SigmaLink/releases/latest'`

- [ ] **Step 2: Verify**

Run: `pnpm exec vitest run src/renderer/features/settings/UpdatesTab.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/electron/auto-update.ts app/src/renderer/features/settings/UpdatesTab.test.tsx
git commit -m "fix(updater): explain UAC/unsigned cause in win32 update error (audit C2)"
```

---

### Task 7: C1 — PSScriptAnalyzer job for install-windows.ps1

**Files:**
- Modify: `.github/workflows/lint-and-build.yml` (extend the shellcheck job's steps)

- [ ] **Step 1: Calibrate locally** (PSScriptAnalyzer is not installed on this box):

Run (PowerShell): `Install-Module PSScriptAnalyzer -Force -Scope CurrentUser; Invoke-ScriptAnalyzer -Path app/scripts/install-windows.ps1 -Severity Warning,Error | Format-Table -AutoSize`
Record the output. If Warnings exist, gate CI at `-Severity Error` and note the warning count in the commit body; if clean, gate at `Warning,Error`.

- [ ] **Step 2: Add the step** after the `Shellcheck installer` step (ubuntu runner — pwsh is preinstalled on GitHub images):

```yaml
      - name: PSScriptAnalyzer (Windows installer)
        shell: pwsh
        run: |
          if (-not (Get-Module -ListAvailable PSScriptAnalyzer)) {
            Install-Module PSScriptAnalyzer -Force -Scope CurrentUser
          }
          $findings = Invoke-ScriptAnalyzer -Path app/scripts/install-windows.ps1 -Severity Error
          $findings | Format-Table -AutoSize | Out-String | Write-Host
          if ($findings) { exit 1 }
```

(Use the severity chosen in Step 1.)

- [ ] **Step 3: Verify + commit**

Run the same `Invoke-ScriptAnalyzer` command locally with the chosen severity → expect exit-condition clean.

```bash
git add .github/workflows/lint-and-build.yml
git commit -m "ci: lint install-windows.ps1 with PSScriptAnalyzer (audit C1)"
```

---

### Task 8: Full verification + push + PR

- [ ] **Step 1:** `pnpm exec vitest run src/main/core/pty src/main/core/ram-brake src/main/core/voice src/renderer/features/settings/UpdatesTab.test.tsx` → all green.
- [ ] **Step 2:** `pnpm run lint` → clean (repo keeps lint at zero).
- [ ] **Step 3:** Push: `git push origin HEAD:fix/windows-audit-wave-1`
- [ ] **Step 4:** Open PR against `main` titled `fix(windows): audit wave 1 — cmd sentinel, tree-aware forget, dead RSS hook, docs/CI parity` with a body mapping each commit to its WISHLIST audit item (A1, A2, A3, D1-D4, C1, C2, C4). Report the PR URL; do NOT merge — the operator decides.

---

### Task 9: B2 — Refresh PR #209 (separate branch, separate worktree)

PR #209 (`fix/windows-ram-leakage`) is only **8 ahead / 4 behind** `origin/main`. Merge main into it so it is mergeable again.

- [ ] **Step 1:** `git worktree add C:/Users/DaddysHere/AppData/Local/Temp/sl-pr209-refresh -b pr209-refresh origin/fix/windows-ram-leakage`
- [ ] **Step 2:** In that worktree: `git merge origin/main --no-edit`. **If conflicts touch more than trivial context (imports/CHANGELOG), STOP and report — do not improvise resolutions on RAM-brake logic.**
- [ ] **Step 3:** Junction node_modules (`cmd /c mklink /J app\node_modules C:\Users\DaddysHere\Documents\SigmaLink\app\node_modules`), then run the PR's affected suites: `pnpm exec vitest run src/main/core/ram-brake src/main/core/workspaces src/main/core/process`
- [ ] **Step 4:** If green: `git push origin HEAD:fix/windows-ram-leakage` (additive merge commit — updates PR #209, no force). Report; merging PR #209 remains the operator's call.
- [ ] **Step 5:** Clean up: `git worktree remove C:/Users/DaddysHere/AppData/Local/Temp/sl-pr209-refresh` (after push).

---

## Self-review notes

- **Spec coverage:** A1→T1, A2→T2, A3→T3, D3→T4, D1/D2/D4/C4→T5, C2→T6, C1→T7, B2→T9. B1/B3/B4/C3/C5/E1/E2 intentionally deferred (header).
- **Type consistency:** `stopProcessTree(pid, PTY_KILL_FALLBACK_MS)` matches the existing call at `registry.ts:531`; test mocks reuse `processTreeMock` fixtures already in `registry-lifecycle.test.ts:37-42`.
- **Trap check:** C2's string is mirrored in `UpdatesTab.test.tsx:113` (both edited together); Task 1 Step 4 checks `local-pty.test.ts` for old-snippet substring assertions.
