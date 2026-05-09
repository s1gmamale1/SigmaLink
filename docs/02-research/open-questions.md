# Open Questions
Compiled: 2026-05-09

Facts referenced on bridgemind.ai or in repos but not actually published in detail. The build phase will need to invent vs replicate.

## BridgeSpace UI / interaction model
1. Exact pixel dimensions, spacing, colors of the UI (only screenshots, no design tokens published).
2. Full keyboard-shortcut map for the "Command Room", "Swarm Room", "Review Room" (only macOS basics from docs).
3. How "Fast room switching" is bound (no documented shortcut).
4. Settings panel structure / preferences schema.
5. Mention textarea (added in v3.0.7) — exact behavior, @mention syntax, target resolution.
6. Editor theme system internals (TextMate grammars? Tree-sitter?).
7. Exact rendering library for the Kanban board (drag-drop interactions, columns customizable?).
8. Workspace template config file format.

## BridgeMemory
9. Parameter signatures of all 12 BridgeMemory MCP tools (only group names + tool names public; no schemas).
10. Hub bootstrap workflow (`init_hub` defaults).
11. Exactly which fields are markdown frontmatter vs body.
12. Search ranking weights (scoring formula not published).
13. Force-directed graph layout algorithm + parameters (canvas-based but specifics not given).
14. Whether the graph supports tags or only wikilinks.
15. Sync model when multiple agents write simultaneously (atomic-rename helps but conflict policy?).
16. How `~/.bridgespace/runtime.session` token rotates / expires.

## BridgeMCP
17. Whether `delete_task` / `delete_project` exist (not in any public list).
18. Webhooks or polling for task-status changes.
19. Rate limits per API key tier.
20. How knowledge is segmented (single string up to 50k chars, or structured blocks?).
21. Project access control (multi-user permissions?).
22. Audit log API.

## BridgeSwarm
23. Discrepancy: 8 rules on landing page vs 4 named in blog — which is canonical, what are rules 5–8 verbatim text?
24. Completion-report schema (mentioned but not published).
25. Inter-agent message format (transport, schema, shape).
26. Escalation transport / format (specific context = which fields?).
27. "Safe git practices enforced at orchestration layer" — exact policies (no force push? branch naming? squash?).
28. How file ownership is recorded (lockfile? in-memory? in BridgeMCP?).
29. Whether Coordinator is itself an LLM or deterministic dispatcher.
30. Concurrency limit (16 agents per pane vs per swarm?).

## BridgeCode
31. Exact CLI binary name and command syntax (no examples published; status "Coming Soon").
32. Config file format and location.
33. Whether agents like `vibe` / `build` / `plan` / `architect` / `ship` are deterministic flows or LLM personas.
34. Auto-compaction behavior threshold.
35. Sub-agent batch ops (mentioned in feature list, no examples).

## BridgeVoice
36. Default global hotkey on Windows / Linux (only macOS Right Option example given).
37. Exact custom-dictionary file format.
38. Whisper config knobs (beam size, temperature) — exposed?
39. Where transcription history is stored.
40. Cross-device sync architecture (coming soon — no design).

## Pricing / business
41. Definition of "1 credit" (token? task? minute?).
42. Overage handling.
43. Discount on student / open-source plans?
44. Team-seat pricing (Ultra "coming soon").

## Roadmap
45. The "Five products. One mission." line lists only 4 — what is the 5th product? (Likely BridgeMemory or BridgeSwarm but unclear.)
46. BridgeBench public leaderboard URL — not located on main site nav.
47. BridgeUI, BridgeRemotion, BridgeMotion — only mentioned in BridgeWard README; no other surface.

## Plugins / open source
48. Skill marketplace JSON format (`@bridgemind-plugins` registry — exact protocol).
49. plugin.json schema.
50. Submission/approval workflow for community skills.

## Identity / tagline
51. Tagline mismatch: "Vibe Coding for Builders" (homepage) vs "Stop Typing. Start Shipping." (about) vs "Ship at the speed of thought" (pricing) vs "Ship with agents" (BridgeWard) — which is canonical?

## Browser sidebar
52. Browser tabs / multiple URLs?
53. Agent-controlled navigation?
54. Sandbox boundaries.
55. Whether browser can render local dev servers vs only external.

## Bridge Assistant
56. Mentioned in pricing (Basic) and changelog (v3.0.8 voice flows) but no dedicated page — is it a separate product or BridgeVoice integration inside BridgeSpace?
