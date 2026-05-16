# BUG-V1.4.1-WIN-OPENCODE-PANE6 — OpenCode CLI pane renders garbled on Windows

- **Severity**: P2 (provider-specific render corruption; CLI is usable but ugly)
- **First reported**: 2026-05-17 user dogfood of v1.4.1 NSIS build on Windows
- **State**: **HYPOTHESIS** — one user screenshot, no debug trace, no Windows VM reproduction yet
- **App commit**: `6e635db` (main, v1.4.1)
- **Affected provider**: `opencode` (`app/src/shared/providers.ts:113-123`)
- **Affected platform**: Windows 10/11 (NSIS build, ConPTY via node-pty)
- **macOS**: confirmed clean on the same commit (paired screenshot)
- **Suggested delegate**: **Kimi via OpenCode** — Windows VM diagnostic-gated; needs font/unicode interpretation. Cleanup self.

---

## 1. Symptom

In a 6-pane swarm (3 cols × 2 rows; `GridLayout.shapeFor(6) → {cols:3, rows:2}`), the OpenCode CLI pane in the bottom-right slot — pane index 6 in the user-facing 1-indexed numbering (`CommandRoom.tsx:297` `paneIndex={ctx.index + 1}`), `cellIdx === 5` in `GridLayout.tsx:144` — shows stray vertical bar characters (`┃` / `|` / box-drawing) overlapping text content. Looks like one of:

- Unicode box-drawing characters missing from the resolved monospace font on Windows, so the cell falls back to a half-width glyph that paints over neighbouring columns.
- xterm.js column-width calculation mis-counting CJK-width or ambiguous-width glyphs that OpenCode emits inside its TUI border.
- ConPTY translating an OpenCode-emitted ANSI sequence (e.g. DEC line-drawing `\x1b(0` / `\x1b(B`) into raw bytes that xterm.js renders as Unicode replacement.

Claude / Codex / Gemini / Kimi panes in the same swarm render correctly on the same Windows build.

## 2. Repro (suspected)

1. Install SigmaLink v1.4.1 NSIS EXE on Windows 11.
2. Open any workspace, launch a 6-pane preset, assign provider order `claude, codex, gemini, kimi, opencode, opencode` (or any layout where OpenCode lands in slot 6).
3. Type one OpenCode prompt that triggers its TUI status panel.
4. Observe: pane 6 (bottom-right) shows overlapping bar/box glyphs.
5. Re-arrange so OpenCode is in pane 1 or 3 instead — does it still break?  **← this is the diagnostic that disambiguates H1 vs H2.**

## 3. Two competing hypotheses

### H1 — OpenCode-specific (font / TUI box-drawing)

OpenCode emits box-drawing or ambiguous-width Unicode characters that ConPTY passes through, but xterm.js renders with the wrong cell width because the Windows font fallback chain resolves these glyphs to a font with different metrics than `Cascadia Mono` / `Consolas`.

Evidence supporting H1:
- Same xterm config, same theme, same `convertEol: true`, same scrollback for all 6 panes — there is **no per-pane branch** in `Terminal.tsx`. The only variable is the data stream itself.
- `Terminal.tsx:113` font stack is `'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Courier New", monospace'`. JetBrains Mono is not bundled with Windows; Cascadia Mono ships with Win11 but **not** Win10 by default; Consolas is the realistic Windows fallback. Each has slightly different box-drawing coverage.
- All four other CLIs render their own TUI fine on Windows, suggesting their glyph sets stay within the safe ASCII / common-Unicode box.
- macOS uses the same JetBrains Mono / Menlo branch and is clean → not a code path.

Evidence against H1:
- We don't yet know which font is actually winning on the user's Windows machine (`document.fonts.check` would tell us).

### H2 — Pane-6-specific (grid layout / column-width calc)

Whatever pane lands in grid slot 6 (3-col × 2-row, bottom-right) has a layout bug — sub-pixel column width, scrollbar overlay, or ResizeObserver double-fire — that corrupts xterm's cell grid only on Windows.

Evidence against H2:
- `GridLayout.tsx:32-47` `shapeFor()` and `:142-170` cell rendering have **no branch on cell index**. Every cell gets `min-h-0 min-w-0 overflow-hidden rounded-lg border`. Resize handles (`:171-196`) are absolutely-positioned dividers — they don't affect cell content.
- `Terminal.tsx:204-217` ResizeObserver fires the same `runFit()` for every pane; no special-case for slot 6.
- `local-pty.ts:199-258` spawns every PTY through the same `platformAwareSpawnArgs` → `nodePty.spawn` path with identical `cols`/`rows` from the renderer's measured cell grid. No pane-index-aware sizing.
- `gap-1.5 p-2` plus `gridTemplateColumns: <fr fr fr>` is symmetric; there is no asymmetric padding that would make slot 6 narrower in pixels than slots 1/3.

Evidence supporting H2:
- The bottom-right cell is the only one with **no** right or bottom neighbour, so any rounding error in `(width / cols)` math accumulates there. Mathematically real but unlikely to cause character-level corruption — at worst the rightmost column gets truncated, not overpainted with `┃`.

### Lean: **H1 (OpenCode-specific)**, ~75% confidence

The render artefact in the screenshot is glyph-shaped (vertical bars overlapping letterforms), not grid-shaped (clipping / scrollbar / misalignment). Box-drawing-character fallback on Windows is a well-documented xterm.js issue when the primary font lacks U+2500..U+257F coverage. The fact that all four other CLIs render fine in the same grid kills most of H2 outright — if it were a slot-6 layout bug it would affect whatever CLI lands there.

## 4. File:line evidence

- `app/src/shared/providers.ts:113-123` — OpenCode entry; no `args`, no env override, no `TERM` override, no Windows-specific flag. Spawn is plain `opencode` / `opencode.cmd`.
- `app/src/main/core/pty/local-pty.ts:233-238` — every PTY gets `TERM=xterm-256color`, `COLORTERM=truecolor`, `FORCE_COLOR=1`. No provider-specific or pane-specific env injection. So OpenCode receives the same TERM as Claude/Codex/Gemini.
- `app/src/main/core/pty/local-pty.ts:175-197` — `platformAwareSpawnArgs` wraps `.cmd` shims through `cmd.exe /d /s /c`. `opencode.cmd` would route through this path on Windows. Could `cmd.exe /d /s /c` mangle a UTF-8 byte stream? Unlikely (ConPTY is UTF-16 internally, node-pty bridges to UTF-8) but **measurable**.
- `app/src/renderer/features/command-room/Terminal.tsx:111-133` — xterm.js Terminal constructor: no `windowsMode`, no `windowsPty: {…}`, no custom `unicode` handler. xterm.js defaults to its v5 unicode handler; the v11 wide-char handler is **not** enabled.
- `app/src/renderer/features/command-room/GridLayout.tsx:32-47, 142-170` — pane-index-agnostic CSS grid. No branch on `cellIdx === 5`.

## 5. Diagnostic next steps (in priority order)

1. **Swap pane positions on Windows** (kills H2 if confirmed):
   - Spawn 6 OpenCode panes (`opencode × 6`). If **every** pane shows the corruption → H1 confirmed.
   - Spawn 1 OpenCode in slot 1 + 5 Claude. If OpenCode in slot 1 still breaks and Claude in slot 6 is fine → H1 confirmed.
   - **Cost**: 5 minutes, no code change. **Do this first.**

2. **Capture the byte stream from OpenCode**:
   - On Windows, run `opencode 2>&1 | xxd | head -200` outside SigmaLink (in a stock terminal). Look for `\x1b(0` (DEC line-drawing), wide UTF-8 box chars (`\xe2\x94\x80` etc.), or CSI sequences with unusual `n` parameters.
   - If DEC line-drawing is present → xterm.js handles it but the active font may not have the glyphs, **or** the `cmd.exe` shim wrapper might be eating one byte of the escape.

3. **Probe the resolved font in the renderer**:
   - DevTools console in the OpenCode pane: `document.fonts.check('12px "Cascadia Mono"')` and `getComputedStyle(document.querySelector('.xterm-rows')).fontFamily`. If `Cascadia Mono` is **not** present (Win10 default), the active glyph for U+2503 (`┃`) is coming from a font with different cell metrics → renders shifted.

4. **Enable xterm.js `unicode11` handler**:
   - Behind a temporary flag, register `@xterm/addon-unicode11` and `term.unicode.activeVersion = '11'`. If the OpenCode pane straightens out → confirmed ambiguous-width glyph issue. (No code change in this doc — diagnostic plan only.)

5. **Bypass `cmd.exe` shim**:
   - Try forcing `opencode.exe` directly (some npm shims do ship an `.exe` wrapper). Modify `altCommands: ['opencode.cmd', 'opencode.exe']` order temporarily. If `.exe` renders clean and `.cmd` doesn't, the shim is the culprit, not OpenCode.

## 6. Verification — what data we need before a fix

We will **not** ship a fix from one screenshot. Before any code change, collect from a Windows dogfood session:

- [ ] Screenshot of OpenCode in pane 1 (not pane 6) — disambiguates H1/H2 instantly.
- [ ] Output of `chcp` in a stock Windows terminal (codepage check).
- [ ] DevTools: `getComputedStyle(document.querySelector('.xterm-rows')).fontFamily` value, plus `document.fonts.check('12px "Cascadia Mono"')` boolean.
- [ ] First 500 bytes of OpenCode's startup output captured via `opencode > out.txt 2>&1` outside SigmaLink (so we can replay into a stock xterm.js demo).
- [ ] Windows version (`winver`) + node-pty / ConPTY version (`pnpm why node-pty`).

## 7. Why no fix in this doc

User instruction is investigation-only. The cheapest fix candidates (when the data is in) are:

- Bundle / require Cascadia Mono Web via `@font-face` in the renderer so Windows 10 stops falling back to Consolas (~700 KB asset cost).
- Register `@xterm/addon-unicode11` for all panes (no per-pane logic; one-line constructor change).
- Add a provider-specific env injection in `local-pty.ts` for OpenCode if its TUI honours `OPENCODE_NO_TUI=1` or similar (need upstream docs).

None are P1 — OpenCode is still usable, the corruption is cosmetic.

## 8. Related

- `docs/04-design/windows-port.md` §3.7 — documents the Cascadia Mono prepend rationale; precisely the surface H1 lives on.
- `docs/08-bugs/BACKLOG.md` Phase 18 — Windows port shipped clean for the other four CLIs; OpenCode was tested but not flagged for box-drawing render until this dogfood.
- No matching prior bug entry exists in `OPEN.md`, `BACKLOG.md`, or `DEFERRED.md` as of commit `6e635db`.

## 9. Owner / next action

- **Owner**: unassigned (target triage in v1.4.2 window)
- **Next action (user)**: run the pane-swap diagnostic from §5.1 on the Windows machine. One screenshot of OpenCode in slot 1 will pick the hypothesis for us.
