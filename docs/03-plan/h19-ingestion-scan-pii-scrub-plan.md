# H-19 (full) — ingestion scanning + outbound PII scrub — Implementation Plan

> **For agentic workers:** ONE worktree-isolated Opus lane (security-sensitive; the wiring depends on the gate method so it's a coupled domain, not a parallel split) + a MANDATORY Opus security-review after merge. `isolation:"worktree"` on the Agent CALL. **Gate in MAIN; e2e = FULL `tests/e2e/` dir.** pnpm. Agent NEVER pushes/tags/bumps/releases. Steps use `- [ ]` checkboxes.

**Goal:** Scan content ingested by the assistant's tools (`read_files` file contents, `search_memories` entries) for prompt-injection before it reaches the model — **redacting + annotating** flagged spans — and wire the built-but-unwired **outbound PII scrub** onto the assistant's `final` reply. Extends the existing opportunistic / local-first / never-fail-open `aidefence-gate.ts`. Completes H-19.

**Architecture:** Add `scanIngested` to the existing `AidefenceGate` (redact/annotate, opportunistic). Thread it onto `ToolContext` (controller populates from the gate). Call it in the `read_files` + `search_memories` handlers. Wire the gate's existing `scrubOutbound` onto the `final` emit. No new deps; no new network surface (reuses the Ruflo `aidefence_*` opportunistic proxy).

**Tech Stack:** Electron 30 main · the Ruflo `aidefence_*` MCP tools via the injected `rufloCall` proxy · vitest. **No new npm deps.**

## Verified facts (exploration 2026-05-27)
| Area | Reality (file:line) |
|---|---|
| Gate | `core/security/aidefence-gate.ts` — `createAidefenceGate({rufloCall, audit})` → `scanInbound` (wired to operator prompt, `controller.ts:307`) + `scrubOutbound` (built `:105`, **called nowhere**). Opportunistic: no `rufloCall`/throw → safe default, NEVER throws. |
| Ingestion vectors | `read_files` (`tools.ts:264` → returns `{files:[{content}]}`) + `search_memories` (`tools.ts:460` → returns memory entries). **`open_url` navigates only (`{tabId}`, no text); `monitor_pane` subscribes only; `list_*` = metadata** — NOT ingestion vectors. |
| ToolContext | `tools.ts:35` `interface ToolContext` (pty/worktreePool/mailbox/memory/tasks/browserRegistry/…/origin). Add `scanIngested?` here. |
| Tool ctx build | the controller builds the ctx passed to `invokeAssistantTool`; the gate is built there (`controller.ts:124-130`, `deps.rufloCall`). |
| final emit | `runClaudeCliTurn.emit.ts:90-94` emits `kind:'final'` with the reply text. The turn runs via `runClaudeCliTurn(deps,…)`; scrub the final text before this emit (thread the gate's `scrubOutbound` into the turn/emit deps — opportunistic). |
| aidefence tools | `aidefence_is_safe` → `{safe, reason}`; `aidefence_scan` → richer (matches/spans — VERIFY shape); `aidefence_has_pii` → `{hasPii, scrubbed}`. |

## Cross-component contract (fixed)
- **`AidefenceGate.scanIngested(text: string, label: string): Promise<{ text: string; flagged: boolean; reason?: string }>`** — opportunistic; returns possibly-redacted `text` + `flagged`. Never throws.
- **`ToolContext.scanIngested?: (text: string, label: string) => Promise<{ text: string; flagged: boolean; reason?: string }>`** — populated by the controller as `(t,l) => gate.scanIngested(t,l)`; absent ⇒ tools skip scanning (back-compat).

---

## Task 1: `scanIngested` on the gate (security core)
**Files:** Modify `app/src/main/core/security/aidefence-gate.ts` + `aidefence-gate.test.ts`

- [ ] **Step 1 — verify the `aidefence_scan` contract.** If a Ruflo daemon is reachable, call `aidefence_scan({content})` with a known injection sample and record the return shape (does it return match spans/offsets, or just a boolean + reason?). This decides span-redaction vs coarse-redaction. Document the finding in a code comment.
- [ ] **Step 2 — failing tests** (`aidefence-gate.test.ts`, node, inject a mock `rufloCall`):
  - no `rufloCall` → `scanIngested(t,l)` returns `{ text: t, flagged: false }` (pass-through).
  - `rufloCall` throws → `{ text: t, flagged: false }` (never-fail-open).
  - flagged with spans (if `aidefence_scan` returns matches) → the flagged spans are replaced with a redaction placeholder, `flagged:true`, `text` is annotated with the `⚠` prefix; `audit('aidefence-ingestion-flagged', …)` fired.
  - flagged with only `is_safe:false` (no spans) → coarse: `text` = annotation + placeholder for the whole item; `flagged:true`.
  - not flagged → `{ text: t, flagged:false }`, no audit.
- [ ] **Step 3:** Run → FAIL. **Step 4 — implement** `scanIngested` on the `AidefenceGate` interface + in `createAidefenceGate`:
```ts
const REDACTION = '[⚠ aidefence: redacted potential injected content]';
async function scanIngested(text, label) {
  if (!rufloCall) return { text, flagged: false };
  try {
    // Prefer aidefence_scan (spans) when available; fall back to is_safe.
    const scan = await rufloCall('aidefence_scan', { content: text });
    const spans = extractSpans(scan); // [] when none / shape unknown
    if (spans.length > 0) {
      const redacted = redactSpans(text, spans, REDACTION);
      emitAudit('aidefence-ingestion-flagged', `${label}: ${spans.length} span(s)`);
      return { text: annotate(label, redacted), flagged: true, reason: 'injection-spans' };
    }
    // No spans → fall back to the boolean verdict.
    const safe = await rufloCall('aidefence_is_safe', { content: text });
    if (isUnsafe(safe)) {
      emitAudit('aidefence-ingestion-flagged', `${label}: coarse`);
      return { text: annotate(label, REDACTION), flagged: true, reason: reasonOf(safe) };
    }
    return { text, flagged: false };
  } catch {
    return { text, flagged: false };
  }
}
```
(`extractSpans`/`redactSpans`/`annotate`/`isUnsafe` are small local helpers; `annotate(label, body)` = `\`⚠ aidefence flagged & redacted content in ${label}\n${body}\``. If Step 1 shows `aidefence_scan` lacks spans, drop the spans branch and use is_safe coarse-redaction only — keep the helper but document it.)
- [ ] **Step 5:** Run → PASS. `npx tsc --noEmit` + eslint clean. **Step 6:** Commit `feat(security): aidefence scanIngested — redact+annotate injected content (H-19)`.

## Task 2: thread `scanIngested` into ToolContext + the controller
**Files:** Modify `app/src/main/core/assistant/tools.ts` (`ToolContext`), `app/src/main/core/assistant/controller.ts`
- [ ] **Step 1:** Add `scanIngested?: (text: string, label: string) => Promise<{ text: string; flagged: boolean; reason?: string }>` to `ToolContext` (tools.ts:35 block).
- [ ] **Step 2:** In `controller.ts`, where the tool-invocation `ctx` is built, set `scanIngested: aidefence ? (t, l) => aidefence.scanIngested(t, l) : undefined` (mirrors the existing gate build at `:124-130`). No-op when `aidefence` absent.
- [ ] **Step 3:** `tsc -b` clean. **Step 4:** Commit `feat(assistant): expose scanIngested on ToolContext (H-19)`.

## Task 3: scan in `read_files` + `search_memories`
**Files:** Modify `app/src/main/core/assistant/tools.ts` + `tools.test.ts`
- [ ] **Step 1 — failing tests** (`tools.test.ts`): with a mock `ctx.scanIngested` that flags + redacts, `read_files` returns the redacted `content` + a `flagged`/annotation marker per file; with `scanIngested` absent, content is unchanged (back-compat). Same for `search_memories` entries.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3 — implement:** in `read_files`, after building each successful file's `content`, `const scan = ctx.scanIngested ? await ctx.scanIngested(content, p) : { text: content, flagged: false };` then push `content: scan.text` (+ a `flagged: scan.flagged` field when true). Opportunistic; bounded by the existing 32-file cap. Same pattern per entry in `search_memories`.
- [ ] **Step 4:** Run → PASS. `tsc -b` + eslint clean. **Step 5:** Commit `feat(assistant): scan read_files + search_memories ingestion via aidefence (H-19)`.

## Task 4: wire `scrubOutbound` on the final reply
**Files:** Modify `app/src/main/core/assistant/runClaudeCliTurn.emit.ts` (+ the turn deps) and/or `controller.ts`, + the relevant test
- [ ] **Step 1:** Find the cleanest point where the `final` reply text AND a `scrubOutbound` fn are both in scope. Thread an optional `scrubFinal?: (text: string) => Promise<string>` into the turn/emit deps (the controller supplies `aidefence ? (t) => aidefence.scrubOutbound(t) : undefined`). In `emitFinal` (`runClaudeCliTurn.emit.ts:90-94`), if `scrubFinal` is present, `text = await scrubFinal(text)` BEFORE the `kind:'final'` emit. **Final only** — never per-delta. Opportunistic (absent ⇒ unchanged).
- [ ] **Step 2 — failing test:** with a `scrubFinal` that redacts a fake SSN, the emitted `final` payload's text is scrubbed; without it, unchanged; the scrub never blocks/throws (a throwing scrubFinal → original text still emitted — wrap defensively).
- [ ] **Step 3:** Run → FAIL → implement → PASS. `tsc -b` + eslint clean. **Step 4:** Commit `feat(assistant): scrub PII from the final reply at emit (H-19)`.

---

## Security review pass (MANDATORY — after merge, before gate sign-off) · **Opus reviewer**
Checklist: scanIngested is fully opportunistic (no rufloCall/throw ⇒ pass-through, NEVER throws into a tool handler or breaks ingestion); redaction never corrupts non-flagged content; the annotation can't itself be used to smuggle instructions (it's a fixed literal prefix); `scrubOutbound`-on-final never blocks/drops a reply on aidefence failure (fail-open to original text); no secrets logged; the 32-file scan loop can't be turned into a DoS (bounded + opportunistic); back-compat preserved when `aidefence`/`scanIngested` absent (every existing caller unchanged). Lead folds fixes.

## Gate (in MAIN, after merge + security review)
`npx tsc -b` · `npx eslint . --max-warnings 0` · `npx vitest run` · `npm run product:check` · **`npx playwright test tests/e2e/` (FULL dir)**.

## Execution dispatch
1 lane, `run_in_background`, `isolation:"worktree"`, branched from current main HEAD — **Opus** (security-sensitive, coupled domain). Lead reviews the diff → merges (path-scoped; `diff -q` any unexpected file vs the worktree-leak lesson [[feedback_agent_worktree_isolation]]) → **mandatory Opus security-review** → FULL gate in main → ship **v1.32.0** on explicit operator go.

## Self-review
- **Coverage:** scanIngested gate method (T1) · ToolContext + controller wiring (T2) · read_files + search_memories scanning (T3) · scrubOutbound-on-final (T4) · security review. Matches the approved design (redact+annotate · read_files+search_memories · final-emit scrub).
- **Type consistency:** `scanIngested(text,label)→{text,flagged,reason?}` defined on the gate (T1) + ToolContext (T2) + used in T3; `scrubFinal(text)→text` (T4).
- **Opportunistic / secure-by-default:** every aidefence call wrapped; absent/throw ⇒ safe default; redaction (not block) per the operator decision; advisory audit rides the existing `assistant:security` emit.
- **YAGNI:** no open_url/monitor_pane (no text ingested), no per-delta scrub, aidefence stays opportunistic (not a hard dep).

## Out of scope
`open_url`/`monitor_pane`/`list_*` (no model ingestion) · per-delta PII scrub · making aidefence a hard/fail-closed dependency · a new local (non-Ruflo) injection scanner (the gate stays Ruflo-proxy-based; R-1's `core/remote/safety.ts` keeps its own local heuristics for the Telegram path).
