# In-app Browser Sidebar — Documented Spec
Compiled: 2026-05-09

Sources: changelog (BridgeSpace v3.0.8), bridgecode (BridgeCode panels), products-bridgespace (Review Room reference), discord-and-socials (Twitter quote).

## Confirmed facts

- BridgeSpace v3.0.8 (2026-04-22) shipped "Browser sidebar capability" (verbatim).
- BridgeCode docs list "Browser preview" as one of six panels (Chat / Terminal / Browser preview / File Explorer / Plan / Source).
- BridgeSpace product page mentions a "Review Room" — likely the surface where the browser sidebar lives.
- Twitter quote (BridgeMind official): "Three modes. One platform" — implies BridgeSpace orchestrates Command Room, Swarm Room, Review Room.
- Tauri-based desktop app (Cargo configuration appears in changelog v3.0.4) — browser implemented via webview, likely Tauri's native webview.

## Inferred facts (not directly documented; treat as open question)
- URL bar / navigation controls — not documented.
- Multiple tabs — not documented.
- Dev tools — not documented.
- Cookies / sessions persistence — not documented.
- Whether the browser can be the target of an agent (e.g., Claude controls the browser) — not documented.
- Whether the browser preview reflects a local dev server or arbitrary URL — not documented.
- Sandboxing model (separate process? same Tauri webview?) — not documented.

## Related changelog items that may relate to the browser
- v3.0.8: pane/session snapshot infrastructure — likely also captures browser state.
- v3.0.3: blob: support added to script-src and worker-src — CSP relaxation likely supports inline assets in browser preview pane.
- v3.0.7: sidebar behavior changes — generic sidebar logic.

## Source quote (≤15 words, in quotes)
"Browser sidebar capability"
