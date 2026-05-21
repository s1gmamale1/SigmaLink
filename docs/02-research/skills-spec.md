# Skills Spec — SigmaMind + Anthropic
Compiled: 2026-05-09

## What SigmaMind says about skills

Sources: opensource, github-bridgeward, github-bridgesecurity.

### Plugin architecture (6 layers, /opensource)
1. MCP Servers — universal, 15+ agents.
2. Agent Skills — universal, 30+ agents.
3. Claude Code Plugins — deep integration.
4. Hooks — deep integration.
5. Custom Subagents — deep integration.
6. Agent SDK — full integration.

### SigmaMind plugin marketplace
- Install syntax: `claude plugin install <name>@sigmamind-plugins`.
- Status: marketplace launching soon (per /opensource), but BridgeWard and BridgeSecurity already shipping.

### Concrete SigmaMind skill repos

#### BridgeWard (skill + skill + agent)
- Skill: `bridgeward` — auto-loads on untrusted content; provenance tagging, red-flag patterns, refusal templates, capability scoping.
- Skill: `injection-audit` — slash command, scans files/dirs/URLs/MCP servers, severity-tagged reports.
- Subagent: `injection-auditor` — read-only.
- Layout:
```
BridgeWard/
├── .claude-plugin/plugin.json
├── skills/
│   ├── bridgeward/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── threat-taxonomy.md
│   │       ├── red-flag-patterns.md
│   │       ├── case-studies.md
│   │       ├── trust-labels.md
│   │       ├── per-tool-defenses.md
│   │       ├── refusal-templates.md
│   │       └── checklist.md
│   └── injection-audit/SKILL.md
├── agents/injection-auditor.md
├── scripts/scan.sh
└── templates/
```

#### BridgeSecurity
- Skill: `bridgesecurity` — auto-loads on code read/write/review.
- Skill: `security-audit` — slash command for severity-ranked CWE/OWASP reports.
- Subagent: `security-auditor` — read-only, OWASP Top 10 + CWE Top 25.
- 8 reference docs: vulnerability-taxonomies, language-patterns, frontend-patterns, infrastructure-patterns, secrets-patterns, case-studies, tooling, threat-modeling.

### Compatibility (per BridgeWard README)
- Claude Code (full plugin support, includes subagents).
- Cursor, Windsurf, OpenAI Codex, Gemini CLI, Cline/Roo Code, GitHub Copilot, Continue.dev, Goose — skill format.

---

## Canonical Anthropic Agent Skills format
Source: https://code.claude.com/docs/en/skills (cited in `web-pages/anthropic-skills-spec.md`).

### Storage
| Scope | Path |
|---|---|
| Personal | `~/.claude/skills/<name>/SKILL.md` |
| Project | `.claude/skills/<name>/SKILL.md` |
| Plugin | `<plugin>/skills/<name>/SKILL.md` |
| Enterprise | managed settings |

Override order: enterprise > personal > project. Plugins use `plugin-name:skill-name` namespace.

### Required frontmatter
- Only `description` is recommended (others optional).

### Frontmatter fields
| Field | Notes |
|---|---|
| name | display; lowercase + numbers + hyphens; ≤64 chars |
| description | trigger context; first 1,536 chars used in skill listing |
| when_to_use | extra trigger phrases |
| argument-hint | autocomplete hint |
| arguments | named positional args (yaml list or space-separated) |
| disable-model-invocation | true = user-only |
| user-invocable | false = hide from slash menu |
| allowed-tools | pre-approved tools |
| model | model override |
| effort | low / medium / high / xhigh / max |
| context | "fork" → run in subagent |
| agent | which subagent type (Explore, Plan, general-purpose, custom) |
| hooks | skill-scoped hooks |
| paths | glob patterns gating auto-activation |
| shell | bash / powershell |

### Substitutions
- `$ARGUMENTS`, `$ARGUMENTS[N]` / `$N`, `$name`.
- `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`.

### Dynamic context injection
- `` !`<command>` `` runs shell before sending content to model (preprocessing).
- `` ```! ... ``` `` for multi-line.
- Disable via `disableSkillShellExecution: true`.

### Lifecycle
- SKILL.md content enters conversation as one message; stays for session.
- Auto-compaction keeps first 5,000 tokens of most recent invocation per skill, total 25,000 budget.

### Example SKILL.md
```yaml
---
name: my-skill
description: What this skill does and when to use it.
disable-model-invocation: true
allowed-tools: Read Grep
---

Instructions for the agent…
```

### Subagent integration
- `context: fork` + `agent: Explore` → SKILL.md becomes the prompt in fresh subagent context.
- Subagents can also `preload` skills (set on subagent side).

### Permission control
- `Skill(name)` exact match, `Skill(name *)` prefix.
- `skillOverrides` setting: on / name-only / user-invocable-only / off.

### Live change detection
- Files under `~/.claude/skills/`, `.claude/skills/`, and `--add-dir` `.claude/skills/` are watched live.
- New top-level skills directories require Claude Code restart.

---

## Cross-check: do SigmaMind skills follow the canonical format?
Yes. BridgeWard and BridgeSecurity both:
- Place SKILL.md inside `skills/<name>/` directories.
- Provide subagents via `agents/<name>.md`.
- Support `--plugin-dir` development.
- Reference the open standard explicitly: "agentskills.io" / "Agent Skills standard".
- Use `.claude-plugin/plugin.json` for marketplace metadata.

## Open
- SigmaMind has not yet published its plugin.json schema or detailed skill authoring guide.
- BridgeUI / BridgeRemotion / BridgeMotion mentioned in BridgeWard README but not yet on GitHub.
