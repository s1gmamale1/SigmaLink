# V3 Agent Roles & Roster Delta

What V3 changes vs PRODUCT_SPEC §5.1-5.2 + `swarm-room/preset-data.ts` (Wave 6a). Sources:
`v3-frame-by-frame.md` 0184/0185/0205/0295.

## 1. Role taxonomy — confirmed unchanged

Four roles retained. NEW: per-role colour tokens (sources 0185, 0205, 0250, 0295; B:L22):

- `--role-coordinator: hsl(216 90% 60%)` — blue
- `--role-builder: hsl(266 85% 65%)` — violet
- `--role-scout: hsl(150 75% 50%)` — green
- `--role-reviewer: hsl(40 90% 60%)` — amber

Add to each theme block in `index.css`. Today's Swarm Room uses generic primary tones.

## 2. Preset reset — Squad / Team / Platoon / Battalion

Current `preset-data.ts`: Squad 5 (1/2/1/1), Team 10 (2/5/2/1), Platoon 15 (2/7/3/3),
**Legion 50 (4/30/10/6)**, Custom 1..50. V3 chips (0184, 0185): **`5 Squad · 10 Team · 15
Platoon · 20 Battalion`** — Legion-50 gone, Battalion-20 new.

| preset | total | comp (C/B/S/R) | confidence |
|---|---|---|---|
| Squad | 5 | 1/2/1/1 | `[CONFIRMED]` |
| Team | 10 | 2/5/2/1 | `[CONFIRMED]` |
| Platoon | 15 | 2/7/3/3 | `[CONFIRMED]` |
| **Battalion** | **20** | **3/11/3/3** | `[INFERRED]` — chip never expanded; extrapolated from Platoon ratios |
| Custom | 1..20 | operator | NEW cap (was 50) |

Existing > 20-agent swarms load read-only with `legacy` flag; only new swarms enforce cap.

## 3. Per-role auto-approve toggle

Frame 0205: `Auto` chip on each role row. Add `autoApprove?: boolean` to `SwarmAgentSpec`;
persist on `swarm_agents.autoApprove INTEGER NOT NULL DEFAULT 0`. Review Room auto-runs
validations and merges if all pass; otherwise reverts to manual review with a banner.

## 4. Per-row provider override

Frame 0205: Reviewer row expanded with its own provider strip (separate from the CLI strip
at top). Each role row in `RoleRoster.tsx` exposes: 8-provider chip strip, model dropdown
(defaults from `models.ts`), Auto-approve, count -/+, and a role colour stripe.

## 5. Provider-default mapping (carried forward)

V3 doesn't contradict the launch video's role-defaults (Video 1, ch. 03:03-03:52, L99-104):
Coordinator → Codex, Builder → Claude *or* BridgeCode when available, Scout → Gemini,
Reviewer → Codex. Update `recommendedRoles`. Per-row override (§4) supersedes.

## 6. Constellation graph topology

Frame 0250: hub-and-spoke with Coordinator 1 at centre. Multi-coordinator presets (Team,
Platoon, Battalion) need **multi-hub** — each Coordinator owns a subset of the workforce,
glow lines only between a Coordinator and its assignees. Encode in
`swarm_agents.coordinatorId` (NULL for coordinators themselves).

## 7. Group filter chips

Frame 0295: `All Agents · COORDINATORS · BUILDERS · REVIEWERS · SCOUTS`. Filtering scopes
both the chat tail and the constellation graph.

## 8. Wave routing

**W12** Legion → Battalion rename + drop 50-cap + Custom cap 20; Battalion split
`3/11/3/3` `[INFERRED]`; four `--role-*` colour CSS vars across themes; per-row provider
strip + colour stripe in `RoleRoster.tsx`; group filter chips in Operator Console.
**W13** `swarm_agents.autoApprove` migration + per-row Auto chip; `swarm_agents.coordinatorId`
for multi-hub constellation.
