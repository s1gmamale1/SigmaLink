# Shift+Enter Newline (Provider-Aware) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In DOM-presenter panes, Shift+Enter inserts a newline using the bytes the pane's actual CLI understands — **Claude → `\x1B\r` (meta-Enter), Codex/others → `\n` (LF)** — instead of submitting (CR).

**Architecture:** A pure provider→bytes mapping `shiftEnterNewline(providerId)` plus an optional `opts.shiftEnterNewline` parameter on `encodeKeyEvent`. `DomTerminalView` resolves the pane's real `providerId` from app state and passes the resolved bytes. Pure logic is golden-tested; the wiring is tested via the existing `DomTerminalView` keydown→`pty.write` harness.

**Tech Stack:** TypeScript (strict, `erasableSyntaxOnly`), Vitest + jsdom + `@testing-library/react`. `input-encoder.ts` stays a pure module.

## Global Constraints

- **Base:** origin/main only. Work in worktree `/Users/aisigma/projects/sl-shift-enter/app`. Never touch the main working tree at `/Users/aisigma/projects/SigmaLink`.
- **Empirical mapping (do not change without re-verifying):** `claude → "\x1b\r"`; every other provider and `undefined` → `"\n"`.
- Plain `Enter → "\r"` (submit) and `Alt+Enter → "\x1b\r"` (meta-Enter) MUST remain unchanged.
- Resolve the REAL provider via `session.providerId` — NOT `displayProviderId` (that is a cosmetic relabel; spawn/IO use the real id).
- TS `erasableSyntaxOnly`: no enums/namespaces/constructor-param-properties.
- The xterm path is out of scope — do not touch `terminal-cache.ts` / `Terminal.tsx`.
- Run all commands from `/Users/aisigma/projects/sl-shift-enter/app`.

> **NOTE FOR THE RESUMING IMPLEMENTER:** an earlier commit (`8090b7b`) made
> Shift+Enter send a plain `"\n"`. This plan SUPERSEDES that with the
> provider-aware behavior. Build on top, then **amend so the final branch shows
> one clean provider-aware change** (the PR should not advertise the abandoned
> LF-only step). Re-verify the final diff matches this plan.

---

### Task 1: `shiftEnterNewline` mapping + `encodeKeyEvent` opts param

**Files:**
- Modify: `src/renderer/features/command-room/input-encoder.ts`
- Test: `src/renderer/features/command-room/input-encoder.test.ts`

**Interfaces:**
- Produces:
  - `shiftEnterNewline(providerId: string | undefined | null): string`
  - `encodeKeyEvent(ev: EncoderKeyEvent, modes: EncoderModes, opts?: { shiftEnterNewline?: string }): string | null`

- [ ] **Step 1: Write the failing tests** — in `input-encoder.test.ts`, replace the current `Enter / shift+Enter / alt+Enter` it-block (in `describe('encodeKeyEvent — editing keys', …)`) with:

```ts
  it('Enter / shift+Enter / alt+Enter (shift uses provider-resolved newline)', () => {
    expect(encodeKeyEvent(k('Enter'), M())).toBe('\r'); // plain Enter still submits
    expect(encodeKeyEvent(k('Enter', { shift: true }), M())).toBe('\n'); // default newline = LF
    expect(encodeKeyEvent(k('Enter', { shift: true }), M(), { shiftEnterNewline: '\x1b\r' })).toBe('\x1b\r');
    expect(encodeKeyEvent(k('Enter', { alt: true }), M())).toBe('\x1b\r'); // meta-enter unchanged
    expect(encodeKeyEvent(k('Enter', { alt: true, shift: true }), M())).toBe('\x1b\r'); // alt wins
  });
```

and add a new describe block (place it right after the `editing keys` block):

```ts
describe('shiftEnterNewline — provider-aware newline bytes', () => {
  it('claude uses meta-Enter (ESC CR)', () => {
    expect(shiftEnterNewline('claude')).toBe('\x1b\r');
  });
  it('codex and other providers use LF', () => {
    expect(shiftEnterNewline('codex')).toBe('\n');
    expect(shiftEnterNewline('gemini')).toBe('\n');
    expect(shiftEnterNewline('shell')).toBe('\n');
  });
  it('unknown / undefined provider falls back to LF', () => {
    expect(shiftEnterNewline(undefined)).toBe('\n');
    expect(shiftEnterNewline(null)).toBe('\n');
  });
});
```

Add `shiftEnterNewline` to the existing import at the top of the test file:
```ts
import { encodeKeyEvent, encodePaste, isNativePasteCombo, shiftEnterNewline, type EncoderModes } from './input-encoder';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/input-encoder.test.ts`
Expected: FAIL — `shiftEnterNewline` is not exported; the opts-param assertion fails.

- [ ] **Step 3: Implement** — in `input-encoder.ts`:

Add this exported helper (place it just above `encodeKeyEvent`):
```ts
/**
 * Bytes Shift+Enter sends to insert a newline — this differs per CLI:
 *  - claude: meta-Enter (`ESC CR`) — exactly what Claude Code's own
 *    `/terminal-setup` configures Shift+Enter to send; a bare LF does NOT
 *    insert a newline there.
 *  - codex / everything else / unknown: LF (`\n`, i.e. Ctrl+J) — Codex's
 *    documented newline; a safe generic default (cooked-mode shells submit on
 *    it exactly as they do on CR, so no regression).
 */
export function shiftEnterNewline(providerId: string | undefined | null): string {
  return providerId === 'claude' ? `${ESC}\r` : '\n';
}
```

Change the `encodeKeyEvent` signature and the `Enter` case:
```ts
export function encodeKeyEvent(
  ev: EncoderKeyEvent,
  modes: EncoderModes,
  opts?: { shiftEnterNewline?: string },
): string | null {
```
```ts
    case 'Enter':
      if (ev.altKey) return `${ESC}\r`; // Option/Alt+Enter = meta-enter (unchanged)
      if (ev.shiftKey) return opts?.shiftEnterNewline ?? '\n'; // provider-resolved newline
      return '\r'; // plain Enter submits
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/command-room/input-encoder.test.ts`
Expected: PASS (all encoder goldens green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

---

### Task 2: Resolve provider in DomTerminalView and pass the bytes

**Files:**
- Modify: `src/renderer/features/command-room/DomTerminalView.tsx`
- Test: `src/renderer/features/command-room/DomTerminalView.test.tsx`

**Interfaces:**
- Consumes: `shiftEnterNewline` from Task 1.

- [ ] **Step 1: Write the failing test** — in `DomTerminalView.test.tsx`:

1. Replace the `useAppStateSelector` mock (currently `selector({ activeWorkspace: { id: 'ws-1' } })`) with a configurable hoisted state:
```ts
const stateMock = vi.hoisted(() => ({
  state: {
    activeWorkspace: { id: 'ws-1' } as { id?: string },
    sessions: [] as Array<{ id: string; providerId: string }>,
  },
}));
vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (selector: (s: typeof stateMock.state) => unknown) => selector(stateMock.state),
}));
```
2. Reset the sessions list in `beforeEach` (after `vi.clearAllMocks()`):
```ts
  stateMock.state.sessions = [];
```
3. Add two tests inside `describe('DomTerminalView', …)`:
```ts
  it('Shift+Enter sends meta-Enter (ESC CR) for a claude pane', async () => {
    stateMock.state.sessions = [{ id: 'se-claude', providerId: 'claude' }];
    const { container } = render(<DomTerminalView sessionId="se-claude" />);
    await settle();
    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'Enter', shiftKey: true });
    expect(rpcMock.pty.write).toHaveBeenCalledWith('se-claude', '\x1b\r');
  });

  it('Shift+Enter sends LF for a codex pane', async () => {
    stateMock.state.sessions = [{ id: 'se-codex', providerId: 'codex' }];
    const { container } = render(<DomTerminalView sessionId="se-codex" />);
    await settle();
    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'Enter', shiftKey: true });
    expect(rpcMock.pty.write).toHaveBeenCalledWith('se-codex', '\n');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/DomTerminalView.test.tsx`
Expected: FAIL — Shift+Enter currently writes `\r` (or the Task-1 default `\n`), not the provider-resolved bytes; the claude case fails first.

- [ ] **Step 3: Implement** — in `DomTerminalView.tsx`:

1. Extend the existing input-encoder import to include the helper:
```ts
import { encodeKeyEvent, encodePaste, isNativePasteCombo, shiftEnterNewline } from './input-encoder';
```
2. Add a provider selector near the existing `activeWorkspaceId` selector (top of the component):
```ts
const providerId = useAppStateSelector((s) =>
  s.sessions.find((sess) => sess.id === sessionId)?.providerId,
);
```
> `s.sessions` and `AgentSession.providerId` already exist in app state
> (`state.types.ts` → `sessions: AgentSession[]`; `types.ts` → `providerId`).
> Use `providerId` (real CLI), NOT `displayProviderId`.

3. In `onKeyDown`, pass the resolved newline into the encoder. Find:
```ts
    const bytes = encodeKeyEvent(keyEvent, entry.engine.modes);
```
and replace with:
```ts
    const bytes = encodeKeyEvent(keyEvent, entry.engine.modes, {
      shiftEnterNewline: shiftEnterNewline(providerId),
    });
```
(`onKeyDown` is defined in the component body, so it closes over the current
render's `providerId` — no ref needed. Leave the wheel-handler's
`encodeKeyEvent` call inside the effect unchanged.)

- [ ] **Step 4: Run DomTerminalView tests**

Run: `npx vitest run src/renderer/features/command-room/DomTerminalView.test.tsx`
Expected: PASS, including the existing keydown test (plain `Enter` still `\r`; with `sessions: []`, `providerId` is undefined → default `\n` only applies to Shift+Enter, which that test does not use).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

---

### Task 3: Full gate + clean history

- [ ] **Step 1: Full command-room suite**

Run: `npx vitest run src/renderer/features/command-room/input-encoder.test.ts src/renderer/features/command-room/DomTerminalView.test.tsx`
Expected: all PASS.

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc -b && npx eslint src/renderer/features/command-room/input-encoder.ts src/renderer/features/command-room/DomTerminalView.tsx`
Expected: clean.

- [ ] **Step 3: Commit (single clean provider-aware commit)**

Amend/rework so the branch shows ONE feature commit (drop the superseded LF-only step). Stage ONLY these files:
```bash
git -C /Users/aisigma/projects/sl-shift-enter add app/src/renderer/features/command-room/input-encoder.ts app/src/renderer/features/command-room/input-encoder.test.ts app/src/renderer/features/command-room/DomTerminalView.tsx app/src/renderer/features/command-room/DomTerminalView.test.tsx
git -C /Users/aisigma/projects/sl-shift-enter commit --amend -m "feat(pane): provider-aware Shift+Enter newline (claude=meta-Enter, codex/others=LF)"
```
(If the prior commit message/scope makes amend awkward, a fresh single commit replacing it via interactive history is fine — the goal is one clean commit on top of the docs commit.)

> Pure + wiring tests cover the mapping. No live PTY probe needed — the byte
> mapping was derived directly from each CLI's own configuration/footer.
