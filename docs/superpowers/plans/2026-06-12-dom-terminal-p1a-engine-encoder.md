# DOM Terminal Presenter P1a — Engine + Input Encoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the two pure foundations of the DOM terminal presenter (spec `docs/superpowers/specs/2026-06-12-dom-terminal-presenter-design.md`): the headless VT engine wrapper and the keyboard→VT-bytes encoder. No UI wiring, no behavior change for any existing pane — a purely additive, independently-mergeable PR.

**Architecture:** `TerminalEngine` wraps `@xterm/headless` (xterm's full VT parser/buffer, no renderer): write pipe, DA/DSR auto-answers via `onData→writeToPty` (parity with today's SF-3 pipe), coalesced buffer-change notifications, logical-line extraction (the FlowView contract), buffer-type (normal/alternate) exposure, mode flags for the encoder. `encodeKeyEvent`/`encodePaste` are pure functions with a golden-table test suite — the job the attached xterm's UI layer did invisibly until now.

**Tech Stack:** TypeScript, `@xterm/headless@6.0.0` (matches `@xterm/xterm@^6.0.0` core), vitest (node env — no jsdom needed; the engine is DOM-free).

**Worktree:** `/Users/aisigma/projects/SigmaLink/.claude/worktrees/refit-smoke`, branch `feat/dom-terminal-p1a` off `a0e9bee`. Commands run from its `app/`.

---

### Task 1: Add the `@xterm/headless` dependency

**Files:** Modify: `app/package.json`

- [ ] **Step 1:** In `package.json` `dependencies`, after the `"@xterm/addon-webgl"` line add `"@xterm/headless": "^6.0.0",` (caret matches the `@xterm/xterm` style; webgl stays exact-pinned).
- [ ] **Step 2:** Run `pnpm add @xterm/headless@^6.0.0` from `app/` (installs through the shared hoisted node_modules — additive; lockfile is gitignored). Verify: `node -e "console.log(require('@xterm/headless/package.json').version)"` → `6.0.0`.
- [ ] **Step 3:** Commit: `git add package.json && git commit -m "build: @xterm/headless — VT engine for the DOM terminal presenter (P1a)"`

### Task 2: InputEncoder (pure) + golden tests

**Files:** Create: `app/src/renderer/features/command-room/input-encoder.ts`, `input-encoder.test.ts`

- [ ] **Step 1:** Write the failing golden-table tests (full table in the implementation section below — the test file enumerates: printables passthrough; alt-as-meta ESC prefix; Enter `\r`; Backspace `\x7f` / alt `\x1b\x7f`; Tab `\t`; Shift+Tab `\x1b[Z`; Escape `\x1b`; arrows CSI vs SS3 under `applicationCursorKeys`; modified arrows `\x1b[1;<N><A-D>` with N=1+shift·1+alt·2+ctrl·4; Home/End CSI-vs-SS3; PgUp/PgDn/Delete/Insert tilde codes; F1–F4 SS3 `OP..OS`, F5–F12 CSI `15~..24~` (with the 16/17 gap quirks); Ctrl+a..z → `\x01..\x1a`, Ctrl+Space `\x00`; unhandled (e.g. bare `Shift`, `Meta`+c) → `null`; paste: `\r\n`→`\r` normalization, bracketed wrap `\x1b[200~…\x1b[201~` only when the mode flag is on).
- [ ] **Step 2:** Run `npx vitest run src/renderer/features/command-room/input-encoder.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement `input-encoder.ts` (full code below).
- [ ] **Step 4:** Re-run — ALL PASS. `npx tsc -b` clean.
- [ ] **Step 5:** Commit: `feat(command-room): InputEncoder — keyboard/paste → VT byte sequences (DOM presenter P1a)`

### Task 3: TerminalEngine + VT-golden tests

**Files:** Create: `app/src/renderer/lib/terminal-engine.ts`, `terminal-engine.test.ts`

- [ ] **Step 1:** Write the failing tests (real `@xterm/headless`, node env): plain write → `logicalLines()`; a 25-char line at cols=10 → ONE logical line (isWrapped joining); SGR colors don't corrupt text; `\x1b[?1049h/l` → `bufferType` alternate↔normal; `resize()` updates cols; DA answer parity: `engine.write('\x1b[c')` → delegate `writeToPty` called with a `\x1b[?` … `c` response; `modes` reflects `\x1b[?1h` (app cursor) and `\x1b[?2004h` (bracketed paste); `onBufferChanged` fires once (coalesced) for a burst of writes; `dispose()` goes inert.
- [ ] **Step 2:** Run — FAIL (module missing).
- [ ] **Step 3:** Implement `terminal-engine.ts` (full code below): headless term (`scrollback: 8000`, `convertEol: true`, `allowProposedApi: true`), `onData → delegate.writeToPty` (the SF-3 DA/DSR pipe, engine-side), `onWriteParsed → coalesced notify` (rAF when available, `setTimeout(0)` fallback for node), `write/resize/dispose`, `logicalLines(start?, end?)` joining `isWrapped` continuations via `translateToString(true)`, `bufferType`, `modes` getter reading `term.modes`.
- [ ] **Step 4:** Re-run — ALL PASS. `npx tsc -b` clean.
- [ ] **Step 5:** Commit: `feat(terminal): TerminalEngine — headless VT engine wrapper (DOM presenter P1a)`

### Task 4: Full gate + PR

- [ ] **Step 1:** `npx vitest run` (full) · `npx eslint .` · `npm run build` — all green. No existing file modified except package.json, so zero regression surface.
- [ ] **Step 2:** Push branch, open PR titled `feat(panes): DOM terminal presenter P1a — headless VT engine + input encoder (additive)`, body links the spec, states "no UI wiring, no behavior change; foundation for P1b FlowView". CI green → squash-merge per cadence.

## Self-Review
- Spec coverage: P1a slice only (engine + encoder) — FlowView/GridView/flag/conditional-#160 are P1b/P1c by design.
- Type consistency: `EncoderModes` produced by `TerminalEngine.modes`, consumed by `encodeKeyEvent` — single shared interface exported from `input-encoder.ts`, imported by the engine (keeps the dependency arrow pointing at the pure module).
- No placeholders: complete code lives in the implementation sections used verbatim by the executor.
