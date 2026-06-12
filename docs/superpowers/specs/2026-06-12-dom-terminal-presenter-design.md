# DOM Terminal Presenter — engine/presenter split for SigmaLink panes

**Date:** 2026-06-12 · **Status:** P1a SHIPPED v2.4.0 (#162) · P1b SHIPPED v2.4.0 (#163) · **default flipped to `dom` v2.4.1 (#165, operator-directed — pulls P3's flip forward)** · dogfood polish v2.4.2 (#166: SGR wheel routing, cursor space-tracking, alt-screen no-wrap + full-height backgrounds) · REMAINING: P1c GridView + conditional #160 + context-menu toggle, then P2/P3 deletions
**Decision (mini-ADR):** Split every terminal pane into a **headless VT engine** (`@xterm/headless@6.0.0` — xterm's full escape-sequence parser + buffer state, no renderer) and a **DOM presenter we own** (CSS-wrapped logical lines for flowing output; a DOM grid for alt-screen TUIs). Staged rollout behind a per-pane renderer flag; the existing attached-xterm path remains the fallback until the presenter earns default. Phase 1 = claude + codex panes.

## Why (context that forced this)

The 2026-06-11 arc (#152/#156/#159/#160) fixed every *defect* in the xterm-grid pipeline, but the remaining UX ceiling is structural: a character-grid renderer makes resize a geometry contract (cols×rows + buffer rewrap + renderer clear + SIGWINCH), scrollback a grid buffer (no native selection, no DOM scroll), and ties pane feel to whatever the hosted TUI repaints. Competitive analysis (BridgeSpace v3.1.12, operator-verified behavior + their on-stream code review showing `src-tauri`, a custom terminal renderer, and `osc133-parser.ts`) confirmed the Warp-class model: **real PTY terminals under a custom DOM renderer** — visual reflow is a CSS operation decoupled from the PTY size contract, so the entire resize-glitch class is impossible by construction. Their structural weaknesses (they own VT coverage forever; all agents share one working dir) are exactly what this design avoids: we keep xterm's battle-tested VT engine, and our per-pane worktrees are untouched.

## Goals / Non-goals

**Goals**
- G1: Pane resize = instant CSS reflow of content; the PTY learns its size once per settle (RefitController semantics preserved).
- G2: Native DOM selection/copy, native scrolling, real anchor links in flowing output.
- G3: Claude panes return to **inline** mode under the DOM presenter (revert the #160 `tui:fullscreen` injection *for DOM-mode panes only*) — the presenter makes inline safe because there is no scrollback grid for Ink reprints to corrupt; dup frames become collapsible duplicate *blocks* we can dedupe at the model layer later.
- G4: Zero regression surface for the xterm fallback path — it stays exactly as shipped today.
- G5: Foundation for OSC-133 command blocks (wishlist) — the presenter's line/block model is where that lands naturally.

**Non-goals (this spec)**
- Mouse reporting for TUIs, IME/composition completeness, full vim/htop polish — Phase 2/3 (explicitly out of Phase 1's gate).
- Replacing the main-side PTY layer, ring buffer, `read_pane`/`panes.brief`, snapshot/resume — all renderer-independent and untouched.
- Removing xterm.js — it remains the fallback renderer indefinitely until a separate decision retires it.

## Architecture

```
PTY (main, unchanged) ──pty:data──▶ renderer data bus (unchanged)
                                        │
                          TerminalEngine (per session, cache-owned)
                          @xterm/headless: VT parse → buffer state
                          (also answers DA/DSR queries via onData → pty.write,
                           exactly as today — that pipe moves engine-side)
                                        │ buffer-change events (write-batched)
                    ┌───────────────────┴────────────────────┐
        DomTerminalView (NEW, per mount)            XtermView (TODAY's path,
        presenter chosen by pane renderer flag       Terminal.tsx + attached
                                                     xterm + RefitController)
        ├─ FlowView: normal buffer → virtualized list of LOGICAL lines
        │   (join `isWrapped` continuations; cells → styled span runs;
        │   CSS wraps at pane width — reflow is free; native selection)
        ├─ GridView: alt buffer → rows×cols absolutely-sized DOM grid
        │   (viewport-only; enough for codex's ratatui UI in Phase 1)
        └─ InputEncoder: keydown/paste → VT byte sequences → pty.write
            (printables, Enter/Backspace/Tab/Shift+Tab, arrows, Esc,
             Ctrl-A..Z, Home/End/PgUp/PgDn, bracketed paste — the set
             claude/codex actually consume; kitty protocol deferred)
```

- **TerminalEngine** evolves `terminal-cache.ts`: the cached instance becomes headless for DOM-mode sessions (attached xterm instances remain for fallback-mode sessions). Cache lifecycle (park/attach/GC/LRU, PTY bus subscription, exit listener) is renderer-agnostic and carries over.
- **Resize path**: container ResizeObserver → CSS reflow happens by itself (FlowView) → on settle (reuse `RefitController` with `dragFit` as a no-op in DOM mode) compute cols from pane width ÷ measured cell width → `engine.resize(cols, rows)` + ONE `pty.resize`. GridView re-lays out on the same settle. The reveal/atlas machinery is unnecessary in DOM mode (nothing composites stale frames); `window:restored` becomes a no-op for DOM panes.
- **Buffer→DOM sync**: subscribe to engine write batches (throttled rAF flush); re-render only dirty logical lines (keyed by absolute line index); scrollback virtualized (~8k logical lines budget, render ±1 viewport).
- **Mode switch**: engine exposes `buffer.active.type`; the view swaps FlowView↔GridView on `normal`↔`alternate` transitions (claude inline stays Flow; codex lives in Grid; a shell that launches vim — Phase 2 concern, agent panes rarely do).

## Renderer flag & fallback

- KV `panes.renderer.default` ∈ `xterm | dom` (global default, ships `xterm`), per-pane override in pane context menu (`Renderer → DOM (beta) / xterm`), persisted per session row. Flag read at mount; switching re-mounts the pane view (cache keeps the engine/scrollback either way — switching renderers must NOT lose content: on switch, the headless engine is the source of truth; the xterm fallback path replays from the main ring-buffer snapshot exactly as today).
- Phase 1 enables `dom` by default ONLY for provider ∈ {claude, codex} panes behind a beta KV (`panes.renderer.agentBeta = '1'`), one toggle to revert globally.
- The #160 `--settings '{"tui":"fullscreen"}'` injection becomes conditional: omitted when the spawning pane is DOM-mode (engine passes a flag through the spawn path), kept for xterm-mode panes.

## Phasing (staged; each phase independently shippable + revertible)

- **P1 — Agent panes (claude + codex)**: Engine + FlowView + GridView(viewport-only) + InputEncoder(core set) + flag plumbing + conditional #160. Gate: operator dogfood — resize feels like DOM, selection/copy native, codex usable, claude inline clean. No mouse reporting.
- **P2 — Shell panes**: mouse reporting (SGR), link detection in FlowView (real anchors via the existing routeLinkClick), search, OSC-133 command blocks (the wishlist item lands here), vim/htop-grade GridView fidelity pass.
- **P3 — Default flip + deletions**: `dom` becomes default; delete for DOM-mode: WebGL addon + atlas choreography, reveal path, fullscreen injection; xterm stays as `legacy` flag.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Keyboard encoding gaps (the attached xterm did this) | Encoder is a pure, golden-tested map (key event → bytes); start from xterm's own keymap source as reference; claude/codex smoke in P1 gate; fallback flag per pane |
| Alt-screen fidelity (codex ratatui) | GridView renders the full viewport cell-exact (rows×cols spans, ch-units); no partial-damage tricks in P1 — repaint whole dirty rows |
| Perf: huge output bursts | Engine already absorbs bytes (headless parse is the same cost as today); DOM flush is rAF-throttled + virtualized; budget test: 10MB `yes`-burst keeps UI ≥30fps |
| Two renderers drift | Shared engine = shared state; parity vitest suite runs the same byte fixtures through both paths and compares extracted text |
| IME/composition, a11y | Out of P1 gate, tracked as P2 items; hidden-textarea input host keeps the door open |
| Selection during live writes | Virtualized list keys are stable absolute line indexes; only dirty lines re-render, so DOM selection survives appends (test pinned) |

## Testing

- **Engine goldens**: byte-fixture → headless buffer snapshot (text + attrs) — pure vitest, no DOM.
- **Presenter**: jsdom — logical-line joining (isWrapped), span-run styling, Flow↔Grid switching, virtualization windows, InputEncoder golden table.
- **Parity**: same fixtures through xterm path (existing) and DOM path — extracted text equal.
- **E2E (CI)**: frame-content assertions (per the visual-assertion-gap rule): resize a DOM pane mid-stream → screenshot text equals ring-buffer tail; selection/copy round-trip.
- Full gate in main per house rules; e2e in CI only.

## Success criteria (P1 exit)

1. Drag/minimize/restore on a DOM agent pane: zero artifacts, content reflows continuously, exactly ≤1 SIGWINCH per gesture (existing controller tests adapted).
2. Claude inline (no fullscreen injection) shows NO duplicate blocks after 10 resize gestures (the #49086 reprint may emit bytes; FlowView renders them — measure; if dups appear, P1 keeps the injection and dedupe moves to P2 block-model).
3. Codex pane fully operable (navigate, approve, type) in GridView.
4. Native selection/copy returns exactly the on-screen text (the operator's paste test).
5. One-toggle revert to xterm renderer with no content loss.

## Files (anticipated, plan refines)

`src/renderer/lib/terminal-engine.ts` (cache evolution) · `src/renderer/features/command-room/DomTerminalView.tsx` + `FlowView.tsx` + `GridView.tsx` + `input-encoder.ts` (+tests) · `Terminal.tsx` becomes the renderer switch · provider spawn flag thread for conditional #160 · KV plumbing + pane context menu entry.
