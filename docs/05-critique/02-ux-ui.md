# UX/UI Critique

Author: principal product designer review of `docs/03-plan/UI_SPEC.md`, `docs/03-plan/PRODUCT_SPEC.md` (esp. §3, §13), and `docs/03-plan/BUILD_BLUEPRINT.md` Phase 7, against the visual research in `docs/02-research/visual-spec.md`, `docs/02-research/glossary.md`, `docs/02-research/workflows.md`, and the launch/V3 thumbnails.

Date: 2026-05-09.

## Summary

- **6 CRITICAL, 9 HIGH, 9 MEDIUM, 3 LOW** (27 issues total).
- The spec is unusually thorough on tokens, motion budgets, and component inventories. Where it falls down is squarely on the *operator's mental model* of running a 16-pane, multi-swarm session: the sidebar is over-broad, the launcher is one-shot rather than progressive, and several rooms collapse two distinct jobs (build vs. monitor) onto the same surface. The visual identity also drifts from the BridgeSpace research without an explicit IP/divergence rationale.

**Top 5 changes that materially improve usability**

1. **Collapse 11 rooms into 5 primary rooms + 4 contextual sub-views.** Workspaces, Settings, and Bridge Assistant should not be peers of Command/Swarm/Review/Memory/Browser/Tasks/Skills in the rail. (See U1.)
2. **Promote operator/target ambiguity in Swarm to a first-class composer pattern** — chip-token recipient, "to: #all / coordinator-1" persistent banner, color-shift on the textarea border. (See U16.)
3. **Move the memory force-graph behind a tab, default to list+search+backlinks.** A 1,000-node force graph at the v1 default is a guaranteed bad first impression. (See U7.)
4. **First-run onboarding: a 3-step "Pick a folder → Pick a preset → Pick providers" wizard with a default 4-pane Claude preset and a "Try sample repo" escape.** Today the empty state just says "Pick a folder." (See U2.)
5. **Ship 4 themes day one (obsidian, light, high-contrast, system).** Defer the 25-theme catalog to a "Themes" import store. The Phase 7 spend on 21 cosmetic CSS files is the wrong investment vs. accessibility, error states, and the launcher. (See U13.)

---

## Critiques

### U1. The 11-room sidebar is two navs glued together [CRITICAL]

**Spec ref**: `UI_SPEC.md` §5 enumerated rooms (5.1–5.10), `PRODUCT_SPEC.md` C-014 + §3.

**Concern**: The left rail mixes three categories: (a) workspace-scoped rooms (Command, Swarm, Review, Memory, Browser, Tasks, Skills), (b) cross-workspace utilities (Workspaces, Settings, Bridge Assistant), and (c) an overlay (Command Palette) that doesn't belong in a rail. Several entries are also workspace-type-specific: Swarm exists only for Bridge Swarm; Skills are global. The sidebar implies parity the data model does not have. When a swarm spans rooms (builders also drive the Browser), the user has no visible cue that the swarm "owns" both rooms.

**User impact**: Hits every user, every minute. Constant cognitive cost choosing between visually-equal options of unequal weight. The Command Palette icon "in header hint only" (§6.1) is a hedge that admits the rail is too long.

**Remedy**:
- Split the rail into two zones: (top) workspace-scoped — Command, Swarm (only when type=swarm), Review, Tasks, Memory, Browser, Skills; (bottom, separator + smaller icons) Workspaces hub, Bridge Assistant, Settings.
- Hide Swarm when the active workspace type doesn't need it (or render disabled with tooltip).
- Drop Command Palette from the rail; surface it as a top-right button (see U20).
- When a swarm is running, decorate any room icon with active swarm traffic via a `--brand-warm` corner pip — a "swarm presence" cue. Tooltip names the swarm.

```
[ Command ]  ●     ← active room
[ Swarm   ]  ◌·    ← swarm has active mailbox traffic
[ Review  ]  ◌     ← swarm produced reviewable diffs
[ Browser ]  ◌     ← swarm drove the browser in last 60s
─────────
[ ⌂ Hub ]   [ ✦ Bridge ]   [ ⚙ Settings ]
```

**Effort**: medium. Sidebar + route-mounter changes; no DB impact.

---

### U2. First-run experience is a brick wall [CRITICAL]

**Spec ref**: `UI_SPEC.md` §5.1 Workspaces room and §8 empty states ("Pick a folder to start your first workspace.").

**Concern**: A new user sees a single sentence and a "+ New workspace" button. There is no path from "just installed" to "agents running" inside one minute: no provider self-check, no sample repo, no opinionated default, no overlay tour, no recovery for missing CLIs (the spec only surfaces "Provider not found" *after* a launch attempt).

**User impact**: First impression. Power users who already use a CLI will be fine; everyone else churns.

**Remedy**: Three-step onboarding overlay on first run, dismissible, restartable from Settings → "Reset onboarding."

- Step 1 — Probe providers: list each CLI with status (`✓ claude v2.1.72`, `✗ gemini not found [Install hint]`); buttons "Use these" / "Edit overrides."
- Step 2 — Folder pick, with "Use sample repo" (a vendored `<userData>/samples/hello-sigma`).
- Step 3 — Preset picker; default 4-pane Claude. Enter advances each step.

**Effort**: medium.

---

### U3. The 9-step preset picker (1/2/4/6/8/10/12/14/16) is a slider in disguise [HIGH]

**Spec ref**: `PRODUCT_SPEC.md` C-006 and §2.1; `UI_SPEC.md` §5.1 ("preset chooser").

**Concern**: Nine fixed steps is awkward. The leap from 1 to 2 is qualitatively different (companionship vs. solo); 12→14→16 differ only at hardware-load level. The spec exposes nine equal buttons.

**User impact**: Decision overhead at every workspace creation.

**Remedy**: Replace with a discrete slider snapping to `[1, 2, 4, 8, 16]` plus a numeric input for `Other…`. Show a per-step label: "Solo", "Pair", "Quad", "Octet", "Sixteen". Below the slider, show a live grid preview at the chosen count. Roster screen for swarms keeps the named presets (Squad/Team/Platoon/Legion/Custom) — those names carry semantic weight (5/10/15/50 are *role-balanced*, not just count).

**Effort**: small.

---

### U4. Swarm role-roster screen does not scale to Legion (50) [HIGH]

**Spec ref**: `UI_SPEC.md` §4.2 `RoleRosterCard`; `PRODUCT_SPEC.md` §5.2 (Legion = 50).

**Concern**: The spec implies one card per agent in setup. 50 cards on a roster screen is an overwhelming pre-launch wall of identical chrome where every decision matters less than the operator thinks.

**User impact**: Swarm users (a smaller cohort but the differentiator). Setup feels heavier than the swarm itself.

**Remedy**: Roster setup at scale should default to *per-role bulk*: "30 builders, all Claude" rendered as one row with a count input + provider picker + "Override 1…" expand. Only switch to per-card mode when the operator clicks "Customise individually." This matches how the PRODUCT_SPEC §5.2 presets are structured (per-role counts) and avoids 50 redundant provider pickers.

```
Role            Count   Provider          Override
────────────────────────────────────────────────────
Coordinator      [4]    [Codex ▾]         [▶ 4 indiv]
Builder         [30]    [Claude ▾]        [▶ 30 indiv]
Scout           [10]    [Gemini ▾]        [▶ 10 indiv]
Reviewer         [6]    [Codex ▾]         [▶ 6 indiv]
                ────
                 50
```

**Effort**: small.

---

### U5. Provider picker has no search/filter [MEDIUM]

**Spec ref**: `PRODUCT_SPEC.md` §4 (11 providers + auto-detected); `UI_SPEC.md` §5.1.

**Concern**: 11 + auto-detected is enough to need filtering when probing finds many; conversely, when probing finds *few* (which will be common — most users will only have 1–3 CLIs installed), an 11-row picker with 8 disabled rows is depressing.

**User impact**: Per-pane provider assignment in launcher, swarm role override.

**Remedy**: Provider picker is a `Command`/combobox with three sections: *Available* (probed=found, sorted by recently used), *Installable* (probed=not-found, with `installHint`), *Auto-detected* (other PATH agents). Add a small search input above. Default focus on first Available row. When fewer than 4 are available, still show "Show 7 not-installed" expander rather than padding the list.

**Effort**: small.

---

### U6. 16-pane mosaic is illegible in the spec's compact density [HIGH]

**Spec ref**: `UI_SPEC.md` §5.2 ("mosaic" + density), §2 typography (compact: mono 11/1.15).

**Concern**: At 16 panes on a 1440×900 display with the spec's chrome (40 px tab + 28 px pane header + 48 px collapsed sidebar), each pane is ~320×170 — short of the spec's own balanced minHeight of 300. Compact density at 11 px mono shows ~10 lines of usable terminal. That's not a working surface; it's a status wall. `focus` mode exists but with no automatic transition.

**User impact**: Anyone running 12+ panes hits this constantly.

**Remedy**:
1. Auto-density: when minHeight cannot be met, drop to compact and surface a one-line banner ("16 panes at compact density. Switch to focus? `⌘\\`").
2. Add an `auto-focus` layout — whichever pane most recently emitted >N tokens fills the body; rest tile as a thumbnail strip. Driven by `pty:data`.
3. Per-pane pin glyph in the header. Pinned panes are excluded from auto-focus rotation and survive a layout switch back from focus.

**Effort**: medium.

---

### U7. Memory force-graph default is the worst-case experience [CRITICAL]

**Spec ref**: `UI_SPEC.md` §5.5; `PRODUCT_SPEC.md` §3.5; §6 (12 memory tools, no node-count cap).

**Concern**: Force-directed layouts at >300 nodes are dense hairballs. At 1,000 notes (a realistic year-one library) the graph view is unreadable. The spec treats the graph as a peer of editor/list. The marketing comp in visual research shows an *agent topology*, not a knowledge graph — we may be implementing an aesthetic memory of a marketing image.

**User impact**: Every memory user.

**Remedy**: Default layout 30/50/20 — list / editor / backlinks panel. Move the graph behind an `Editor | Graph` tab toggle (default Editor). Graph defaults to ego-mode at depth 2 around the active note; full-graph only on explicit "Show all" with a node-count warning (>500 nodes). Add the missing `suggest_connections` panel as a right rail in Editor mode (it's listed in §3.5 affordances but unplaced in §5.5).

**Effort**: medium.

---

### U8. Browser room: agent-driving cue is too quiet [HIGH]

**Spec ref**: `UI_SPEC.md` §5.6, §4.2 `AgentDriveIndicator` ("warm-amber dot + ripple animation"); `PRODUCT_SPEC.md` §8.2.

**Concern**: A 6-px dot inside a tab strip is invisible when the user is focused on page content. There's no input-lock model — if both user and agent click, race conditions ensue. Per `workflows.md` W6 the user is *expected* to interact (Design Tool element-pick) while agents are driving — that ambiguity is dangerous.

**User impact**: Browser power-users; especially Bridge Canvas workflow.

**Remedy**: Active-driving frame — 2-px `--brand-warm` border around the WebContentsView with 4-px outer glow when `is_driving=true`. Co-pilot toggle in address bar, three-state `[You] [Shared] [Agent]`: Agent intercepts user clicks (toast "Take control? `Esc`"); Shared (default) shows a recent-actor indicator near the URL ("last: builder-2 · 3s"). Per-tab driver attribution via role-badge prefix in tab title; needs new `last_driver_id` column.

**Effort**: medium.

---

### U9. Review room has no batch path for 16-session approvals [HIGH]

**Spec ref**: `UI_SPEC.md` §5.4; `PRODUCT_SPEC.md` §3.4 ("per-session panel … 'Commit & Merge' action").

**Concern**: With 16 panes finishing simultaneously, per-session diff + per-session merge is a 16-modal slog. There's no unified-across-sessions diff for cross-cutting refactors. Overlapping `task_file_locks` conflicts are nowhere surfaced in the room.

**User impact**: Heavy review days.

**Remedy**: Add a Workspace Diff aggregate tab above the per-session list — all changed files grouped by file, color-coded by author session, conflicts pinned to the top with a Resolve CTA. Add session checkboxes in the left list and a sticky bottom action bar ("Commit & Merge selected (3)"). Per-session conflict chip on each row with tooltip showing the overlapping file and conflicting session id.

**Effort**: medium.

---

### U10. Swarm room is monitoring console *and* messaging app — pick one [CRITICAL]

**Spec ref**: `UI_SPEC.md` §5.3; `PRODUCT_SPEC.md` §3.3, §5.6.

**Concern**: The room mixes a 4×4 monitoring grid (glanceable, peripheral) with a side chat (attention-demanding). The broadcast composer is a footer row under the grid — the most consequential operator action treated as an afterthought. Roll-call is invisible until invoked; there's no surface for "the swarm last replied to roll-call 4 minutes ago."

**User impact**: The exact users our differentiator targets.

**Remedy**: Reframe Swarm room as a monitoring console with a docked chat drawer (70/30 split, drawer collapsible). Promote the broadcast composer to a persistent header bar with the recipient chip on the left (Tab cycles `#all → coordinator-1 → builder-1 …`). Promote roll-call into the same header with an aging indicator ("Last roll-call: 4m ago — 12/16 replied") that opens a response-matrix modal. Mailbox bubbles move into the drawer.

```
┌── Swarm: marketing-video ─────── 12/16 idle · 3 busy · 1 blocked ─┐
│  to: [#all ▾] [Type message…]   [Broadcast] [Roll call] [End]     │
├────────────────────────────────────────────────────┬──────────────┤
│  Grid · Roster · Mission · Brain (3 docs)          │   Chat ▸     │
└────────────────────────────────────────────────────┴──────────────┘
```

**Effort**: medium.

---

### U11. Tasks: drag-to-swarm-role assignment is missing UI [HIGH]

**Spec ref**: `UI_SPEC.md` §5.8, §4.2 `KanbanColumn`/`TaskCard`; `PRODUCT_SPEC.md` §3.8 (assignment kinds: agent / session / swarm).

**Concern**: The PRODUCT_SPEC says task assignment can target an agent, a session, or a swarm (which routes via the coordinator). The UI_SPEC `TaskCard` has a "role chip and assignee avatar" but no spec for *how* you set the assignee. The user prompt asks the right question: inline on the card or modal?

**User impact**: Tasks room users when actually delegating.

**Remedy**: Click-card opens a right-side drawer for full editing (description, success criteria, assignee, file locks, comments). Drag-assignment: while a card is dragged, show a translucent strip along the room's right edge with drop targets per active swarm and running session, badged with role; dropping sets assignee and snaps the card to "In Progress." Quick-assign popover from the card header avatar (Linear-style).

**Effort**: medium.

---

### U12. Settings has no left-rail-within-rail and no danger guards [HIGH]

**Spec ref**: `UI_SPEC.md` §5.9; `PRODUCT_SPEC.md` §3.9, §13.

**Concern**: Settings is the densest forms surface but the spec gives one paragraph. No danger-action treatment for clearing memory or pruning worktrees — both irreversible.

**Remedy**:
- Sections explicit, in order: Providers, MCP Servers, Skills, Themes, Shortcuts, Memory, Worktrees, Logs, Privacy & Telemetry, About. (Memory and Worktrees are new sections housing their destructive operations.)
- Two-tier confirmation: reversible actions get an 8 s `sonner` undo bar; irreversible actions require typed confirmation ("Type the workspace name").
- Backups before nuke: irreversible actions write `<userData>/backups/<ISO>-<action>.tgz` first; toast offers "Open backup folder."
- Reset onboarding belongs in About, not Logs.

**Effort**: medium.

---

### U13. 25 themes is theatre [HIGH]

**Spec ref**: `BUILD_BLUEPRINT.md` Phase 7 (25 theme files); `UI_SPEC.md` §1.3.

**Concern**: 21 of 25 themes are cosmetic re-skins of existing IDE themes (Dracula, Tokyo Night, etc.). Each is a CSS file and a maintenance burden — every new component must be re-eyeballed under each theme. Phase 8 visual baselines only cover `obsidian` and `solarized-light`, so the other 23 are untested-by-design.

**User impact**: Every user pays the cost (perf + cohesion) for a feature 5% of users will exercise.

**Remedy**: Ship 4 day-one themes (obsidian, quiet-light, high-contrast, system). Build a theme import/install flow that loads CSS-variable-only files from `<userData>/themes/`; expose the other 21 in a docs gallery as downloads. Theme picker shows a build-time live-preview tile (320×180 Command-room snapshot) per theme. The freed Phase 7 budget funds U2, U7, U10.

**Effort**: small (cut), medium (importer).

---

### U14. Accessibility floor is too low for a terminal-grid product [HIGH]

**Spec ref**: `UI_SPEC.md` §11; §5.2/§5.3 don't address screen readers inside terminals.

**Concern**: §11 lists focus rings and `aria-current`, but xterm.js terminals are notoriously inaccessible. With 16 panes, keyboard-only navigation is impossible. Shape-encoding for status dots is described but not implemented in `PaneStatusDot`.

**Remedy**: Adopt xterm.js `screenReaderMode` per pane; add a hidden ARIA live-region tail mirroring the last 3 lines per pane. Skip-to-content link at the top of Command room. Implement shape variants in `PaneStatusDot.tsx`. Keyboard escape from grid: `Esc` exits pane focus to the pane header, then Tab through chrome. Add axe-core per-room audit to Phase 8 acceptance.

**Effort**: medium.

---

### U15. Empty / error / loading states inventory has gaps [MEDIUM]

**Spec ref**: `UI_SPEC.md` §8, §9, §10.

**Concern**: §8 misses several real states: stale recents (>30 days untouched), pane exited successfully (distinct from "no panes"), worktree deleted out from under a pane, ended-swarm (read-only), broken `[[wikilink]]`, browser load failures (network vs. cert vs. DNS), assistant-no-provider. §9 errors lack recovery affordances (every error needs Retry + Copy-log-path). §10 loading patterns omit a Cancel for long progress bars.

**Remedy**: Enumerate the missing states; add §10 rule "every progress bar has a Cancel; cancellation must be safe (rollback)."

**Effort**: small.

---

### U16. Operator broadcast vs targeted — composer ambiguity is dangerous [CRITICAL]

**Spec ref**: `UI_SPEC.md` §5.3 (Swarm room SideChat + Broadcast button); `PRODUCT_SPEC.md` §3.3 affordances + §5.6 broadcast/roll-call.

**Concern**: One textarea, one "Broadcast" button, with per-agent DM lanes accessed via the right-side address book. Switching lanes silently changes the recipient. There's no defensive UI cue when the operator types a 200-word directive into the wrong lane. A 50-agent broadcast intended as a DM is an attention-storm and a credibility hit.

**User impact**: Swarm operators, every session.

**Remedy**: Single unified composer with explicit recipient chip (Slack-style channel-vs-DM). Chip is color-coded — `#all` warm-amber + "BROADCAST" label; `#role` role color; `agent-N` provider color. Textarea border mirrors the chip color (1 px subtle). Submit button label adapts ("Broadcast (Cmd+Enter)" vs. "Send to coordinator-1"). Three guardrails:
- Broadcast >10 recipients triggers a 1-line inline banner ("This will reach 50 agents. Confirm with another `Cmd+Enter`."). No modal.
- Recipient locked on focus — only `Backspace` from empty composer or `Tab` changes it.
- Recipient chip remembers last 3 per swarm; cycle with `Cmd+Up`/`Cmd+Down`.

**Effort**: small.

---

### U17. Visual identity drifts from BridgeSpace research without rationale [HIGH]

**Spec ref**: `UI_SPEC.md` §1.1 (default theme `obsidian` with cool-blue `--brand-cool` and warm-amber `--brand-warm`); compare `visual-spec.md` §1 (amber→blue gradient on hero surfaces).

**Concern**: Research says BridgeSpace's signature is the *amber-to-blue gradient* on hero surfaces. The spec ports warm/cool as discrete tokens but never composes them as a gradient; hero glow is described as monochrome. This is either intentional IP divergence (fine — but say so) or accidental reduction (the visual signature is the *pairing*, not either color alone).

**User impact**: Brand recognition, marketing confidence.

**Remedy**: Pick a position and document it.

- Option A (recommended, IP safety): replace the warm-cool pair with a single distinct accent (e.g. `#4FD1C5` teal or `#A78BFA` violet). Today's `--accent #3FA9F5` is identical to BridgeSpace's blue. Drop warm-amber entirely.
- Option B (homage with attribution): keep the pair but actually compose it — `--brand-gradient: linear-gradient(90deg, var(--brand-warm), var(--brand-cool))` — and use it on the swarm-window ring, launcher header, and wordmark. Document in §1 with NOTICE attribution.

**Effort**: small.

---

### U18. Animation budget — pulse-on-pulse is jittery [MEDIUM]

**Spec ref**: `UI_SPEC.md` §7.

**Concern**: A Swarm room with 16 cards has 16 simultaneous 1.6s status pulses plus a 4.0s brand glow plus drive ripples plus jump-to-pane swaps. Cumulative effect is ambient nausea. Spec forbids dual cues on the same surface but doesn't constrain *aggregate* pulses.

**Remedy**: Cap simultaneous breathing pulses at 4 per room (excess cards downgrade to static border). Stagger active pulses' phase offsets by `pulseIndex * 400 ms`. Pause hero brand glow during modal-open and composer-focus. Add an explicit `prefers-reduced-motion` test to Phase 8 acceptance.

**Effort**: small.

---

### U19. Mobile / small windows — sidebar collapse drops the workspace name [MEDIUM]

**Spec ref**: `UI_SPEC.md` §5.1; §3.

**Concern**: When the sidebar collapses to 48 px icon-only, the workspace name lives only in the top tab strip. With more than 3 workspaces open at small widths, tabs truncate. Below 720 px the spec only addresses Recent grid; below ~600 px a 16-pane grid is meaningless.

**Remedy**: Active workspace pill in the top-right (always visible, click → switcher). Hard minimum window size 960×640; below that, single-column "Resize to enable full UI" notice. Tooltip labels on icon-only sidebar items.

**Effort**: small.

---

### U20. Command Palette coverage and discoverability [MEDIUM]

**Spec ref**: `UI_SPEC.md` §5.11; `BUILD_BLUEPRINT.md` Phase 7.

**Concern**: "Actions" group is a black box. Palette icon is "header hint only" — no escape hatch for users who don't know `Cmd+K` exists. No grouping-order or fuzzy-match guidance.

**Remedy**: Palette icon becomes a visible top-right button, label-on-hover. Register every PRODUCT_SPEC §13 shortcut as an Action contribution, plus per-room state actions ("Stop pane", "Pin pane", "Roll call", "End swarm"). Default group order: Recents → Rooms → Actions in active room → Workspaces → Memory titles → Tasks → Providers → Skills. Show a one-time second-run nudge: "Tip: press `⌘K` to find anything."

**Effort**: small.

---

### U21. Workspaces hub does not surface workspace *type* clearly [MEDIUM]

**Spec ref**: `UI_SPEC.md` §5.1; `PRODUCT_SPEC.md` §2.

**Concern**: Recent cards show count and timestamp but not type (Space/Swarm/Canvas). Type is fixed at creation and changes the launcher form, room set, and data model.

**Remedy**: Type chip on each recent card with the default-room icon. Filter pills above the grid: `All · Spaces · Swarms · Canvases`.

**Effort**: small.

---

### U22. Bridge Assistant placement: room vs. omnipresent [MEDIUM]

**Spec ref**: `UI_SPEC.md` §5.10; `PRODUCT_SPEC.md` §3.10.

**Concern**: Spec hedges between "pinned to the right side" and "full-room." Workflow W5 makes clear the operator wants Bridge available *while looking at panes*, not as a destination requiring a context switch.

**Remedy**: Rebase as a right-side dockable drawer (`Cmd+J`), pinned 360 px, with full-room mode (`Cmd+Shift+J`) for long sessions. Drop the dedicated rail entry. Tool-call inspector stays as inline collapsible cards.

**Effort**: medium.

---

### U23. Skills: no per-workspace enable, no "currently loaded" surfacing [MEDIUM]

**Spec ref**: `UI_SPEC.md` §5.7; `PRODUCT_SPEC.md` §3.7, §7.

**Concern**: Operators frequently want to *not* expose all skills to every workspace (e.g. `aws-deploy` disabled in a doc-writing workspace). Spec has only per-provider toggles.

**Remedy**: Per-workspace allowlist override (default: all enabled), honored by `mcp.writeAgentConfig`. Add a "Loaded by" badge on each `SkillCard` showing running agents with the skill active.

**Effort**: small.

---

### U24. Top tab strip — agent count pill is the only state cue [LOW]

**Spec ref**: `UI_SPEC.md` §4.2 `TopTabStrip`; `visual-spec.md` §1.

**Concern**: The pill shows count but not health. Mixed running/error/blocked is invisible until click-through. Operators with 4×16 setups need glanceable status.

**Remedy**: Pill becomes a fixed-width segmented gauge — green=running, red=error, gray=idle — with the numeric count to its right and a tooltip for breakdown.

**Effort**: small.

---

### U25. Bridge Canvas spec is a sketch, not a room [LOW]

**Spec ref**: `PRODUCT_SPEC.md` §2.3; `UI_SPEC.md` has no §5 entry for Bridge Canvas.

**Concern**: Canvas is a workspace type and can also be auto-spawned from the Browser, but UI_SPEC §5 enumerates no Canvas layout. Implicitly Canvas reuses Browser room with the design overlay on, but that's never stated.

**Remedy**: Add UI_SPEC §5.6.1 "Bridge Canvas mode" as a documented Browser state (overlay, scoped composer, asset drop strip). Canvas-type workspaces default to Browser room with overlay enabled.

**Effort**: small.

---

### U26. Pane header has no operator-attention "ack" affordance [LOW]

**Spec ref**: `UI_SPEC.md` §5.2 pane header contents.

**Concern**: When an agent finishes, `JumpToPaneToast` notifies. If dismissed or missed, the pane has no persistent "finished while you were away" cue. Multiply by 16.

**Remedy**: Add an `unread` dot to the pane header (cleared on focus, persists across room switches). Mirror on Command sidebar icon and workspace tab pill (composes with U24).

**Effort**: small.

---

### U27. No undo bar primitive in the spec [HIGH]

**Spec ref**: `UI_SPEC.md` §10 lists `sonner` but does not specify the undo pattern; §12 (this critique's U12) needs it.

**Concern**: The product has many recoverable destructive actions: closing a pane, removing a skill, deleting a memory note, transitioning a task. None of them currently spec an undo affordance. Confirmation dialogs are the wrong tool here — they're slow and habituate users to dismiss.

**Remedy**: Define a global UndoBar primitive backed by `sonner`. Pattern: action → toast `"<thing> closed. Undo (8s)"` with kbd hint. 8-second window; click or `Cmd+Z` undoes. Max 3 stacked toasts. Every reversible RPC returns an `undoToken`; preload exposes `app.undo(undoToken)`. Add to §10 as a third pattern alongside Spinner and Skeleton.

**Effort**: medium.

---

## Recommended UI_SPEC edits

- [ ] §5 — restructure room enumeration to two zones (workspace-scoped, app-scoped); show/hide Swarm based on workspace type. (U1)
- [ ] §5.1 — replace 9-step preset row with snap-slider [1,2,4,8,16] + custom input. (U3)
- [ ] §5.1 — add Workspace type filter pills + type chip on each Recent card. (U21)
- [ ] §5.1 — specify first-run onboarding overlay (3 steps), wire Settings → "Reset onboarding". (U2)
- [ ] §5.2 — define `auto-focus` layout mode; document auto-density downgrade rule. (U6)
- [ ] §5.2 — add `pin` and `unread` glyphs to pane header components. (U6, U26)
- [ ] §5.3 — restructure Swarm room: header bar with composer + recipient chip + roll-call + broadcast; chat as docked drawer. (U10, U16)
- [ ] §5.3 — define recipient-chip color rule and confirmation-on-large-broadcast banner. (U16)
- [ ] §5.4 — add Workspace Diff aggregate tab + batch action bar; conflict surfacing. (U9)
- [ ] §5.5 — default layout 30/50/20 list/editor/backlinks; Graph behind tab; ego-mode default at depth 2; node-count warning. (U7)
- [ ] §5.6 — define active-driving frame, three-state co-pilot toggle, last-driver attribution. (U8)
- [ ] §5.6.1 — new section: Bridge Canvas mode overlay on Browser room. (U25)
- [ ] §5.7 — add per-workspace skill allowlist; "Loaded by" badge on SkillCard. (U23)
- [ ] §5.8 — define click-card → side panel for full task editing; drag-to-swarm-role drop targets; quick-assign popover. (U11)
- [ ] §5.9 — explicit section list (Providers, MCP Servers, Skills, Themes, Shortcuts, Memory, Worktrees, Logs, Privacy, About); two-tier confirmation; backups before nuke. (U12)
- [ ] §5.10 — drop dedicated room; reframe as right-side drawer (`Cmd+J`) + full-room (`Cmd+Shift+J`). (U22)
- [ ] §5.11 — palette as visible top-right button; explicit Action contributor inventory; default group order. (U20)
- [ ] §1 — pick visual-identity position (divergence vs. homage); document it; either replace warm/cool pair with new accent or compose `--brand-gradient`. (U17)
- [ ] §1.3 — cut from 25 themes to 4 (obsidian / quiet-light / high-contrast / system); add theme import flow + live preview tile. (U13)
- [ ] §3 — TopTabStrip pill becomes segmented health gauge; add active-workspace pill in top-right. (U24, U19)
- [ ] §4.2 — add `UndoBar` to the custom component table; spec the API. (U27)
- [ ] §4.2 — `RoleRosterCard` gains a per-role bulk row mode; "Customise individually" expander. (U4)
- [ ] §4.2 — `ProviderPicker` (new) — combobox with Available/Installable/Auto-detected groups + search. (U5)
- [ ] §7 — cap simultaneous breathing pulses at 4, stagger phases; pause hero glow during composer focus and modals. (U18)
- [ ] §8 — add missing empty states (stale recents, exited pane, deleted worktree, ended swarm, broken wikilink, browser load failures, assistant-no-provider). (U15)
- [ ] §9 — every error sentence gets a Retry CTA + "Copy log path" affordance. (U15)
- [ ] §10 — add UndoBar pattern; require Cancel on every Progress bar; rollback safety. (U15, U27)
- [ ] §11 — add screen-reader live-region tail for terminals; skip-to-content link; keyboard escape from grid; per-component shape-encoding for status; axe-core in Phase 8. (U14)
- [ ] §12 (new) — minimum window size 960×640; below that, single-column notice. (U19)

---

## Closing note

Tokens, motion budget, RPC surface, and component inventory are in good shape. The structural debt is concentrated in three areas: navigation treats unequal rooms as peers; the launcher/onboarding is a brick wall for new users; and the Swarm experience treats the differentiating workflow as a footer instead of a stage. Address U1, U2, U7, U10, U13, and U16 before Phase 8 visual baselines lock — the rest is touch-up work.
