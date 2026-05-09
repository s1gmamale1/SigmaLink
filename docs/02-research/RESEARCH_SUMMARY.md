# Research Summary
Compiled: 2026-05-09

## Executive summary

This research pass covered **39 distinct URLs** across bridgemind.ai, docs.bridgemind.ai, GitHub (bridge-mind org), and Anthropic's canonical Skills documentation (used for cross-check), producing a per-page brief in `docs/02-research/web-pages/` plus nine synthesis files. We catalogued **66 product features** across the BridgeMind ecosystem (BridgeSpace, BridgeSwarm, BridgeMCP, BridgeMemory, BridgeVoice, BridgeCode, BridgeWard, BridgeSecurity, BridgeBench, plus future-named BridgeUI / BridgeRemotion / BridgeMotion / Bridge Assistant), enumerated **22 BridgeMCP+BridgeMemory tool names** (10 BridgeMCP server tools with full parameter signatures, plus the 12 BridgeMemory tools by name only), captured **8 BridgeSpace + 8 BridgeVoice changelog entries**, and compiled the canonical **4-role / 8-rule BridgeSwarm protocol** alongside the parallel role taxonomies appearing in five other blog posts. Seven product images were downloaded locally to `web-images/`.

## Top 10 unknowns (most consequential blockers for the build phase)

1. **BridgeSwarm Rule 5–8 verbatim text** — landing page lists 8 rules but the deep-dive blog only details 4. Need the missing four to faithfully clone behavior.
2. **Inter-agent message format** — completion-report schema, escalation payload, and transport are referenced but never published.
3. **BridgeMemory tool parameter signatures** — only the 12 names exist publicly; no schemas, no return types, no error semantics.
4. **The 5th product** — roadmap says "Five products. One mission." but lists only four. (Likely BridgeMemory or BridgeSwarm.)
5. **BridgeSpace room shortcuts** — "Fast room switching" is named but no key binding given; only macOS basic shortcuts published.
6. **Browser sidebar capabilities** — confirmed shipped in v3.0.8 but tabs, navigation, agent control, sandbox model are undocumented.
7. **Mention textarea (@-mentions)** — added in v3.0.7; resolution targets and syntax not described.
8. **Credit accounting** — the meaning of "1 credit" (token, task, minute, agent-hour?) is not defined.
9. **Workspace template config format** — files for 1/2/4/6/8/10/12/14/16-pane layouts exist but their schema is not published.
10. **Bridge Assistant identity** — appears in Basic-tier pricing and changelog v3.0.8 but has no product page; unclear if it's a standalone surface or BridgeVoice-in-BridgeSpace.

## Files produced

- 39 per-page briefs in `docs/02-research/web-pages/`
- `feature-matrix.md` — single 66-row table
- `keyboard-shortcuts.md` — every documented shortcut by platform
- `changelog-summary.md` — chronological release log
- `mcp-tool-catalog.md` — 10 BridgeMCP tools with full signatures + 12 BridgeMemory tools
- `agent-roles-and-protocol.md` — 4 roles, 8 rules, file ownership, protocol fragments
- `skills-spec.md` — BridgeMind plugin marketplace + canonical Anthropic Skills cross-check
- `browser-spec.md` — what is and isn't documented about the in-app browser
- `visual-asset-inventory.md` — every image URL referenced (7 saved locally)
- `open-questions.md` — 56 specific gaps the build phase must invent or replicate

## Key facts pinned

- BridgeSpace v3.0.x is the current line (initial v3.0.1 on 2026-04-20).
- BridgeVoice v2.2.22 current; v1.0.0 GA was 2026-02-23.
- Pricing: Basic $16/$20, Pro $40/$50, Ultra $80/$100; annual 20% off; 7-day refund.
- Credits per month: 5,000 / 12,500 / 25,000.
- BridgeMCP server: `https://mcp.bridgemind.ai/mcp`, API key `bm_live_*`.
- Founder: Matthew Miller; founded 2025.
- Community: 9,700+ Discord, 70,000+ YouTube subscribers, 30,000+ X.
- $3k MRR within 4 weeks per YouTube announcement.
- Open-source skills (MIT): BridgeWard, BridgeSecurity (live); BridgeUI, BridgeRemotion, BridgeMotion (mentioned only).
