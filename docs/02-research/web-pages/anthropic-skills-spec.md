# Anthropic Agent Skills Documentation
URL: https://code.claude.com/docs/en/skills (redirect from docs.anthropic.com/en/docs/claude-code/skills)
Fetched: 2026-05-09

## Headings (verbatim)
- Extend Claude with skills
- Bundled skills
- Getting started — Create your first skill / Where skills live / Live change detection / Automatic discovery from nested directories / Skills from additional directories
- Configure skills — Types of skill content / Frontmatter reference / Available string substitutions / Add supporting files / Control who invokes a skill / Skill content lifecycle / Pre-approve tools for a skill / Pass arguments to skills
- Advanced patterns — Inject dynamic context / Run skills in a subagent / Restrict Claude's skill access / Override skill visibility from settings
- Share skills — Generate visual output
- Troubleshooting

## Skill storage locations (verbatim)
| Location | Path | Applies to |
| Enterprise | (managed settings) | All users in org |
| Personal | ~/.claude/skills/<skill-name>/SKILL.md | All your projects |
| Project | .claude/skills/<skill-name>/SKILL.md | This project only |
| Plugin | <plugin>/skills/<skill-name>/SKILL.md | Where plugin is enabled |

Override order: enterprise > personal > project. Plugin skills use `plugin-name:skill-name` namespace.

## Frontmatter fields (full table)
- name (No, optional) — display name; lowercase letters/numbers/hyphens only, max 64 chars; defaults to dir name.
- description (Recommended) — what skill does and when to use; first paragraph fallback; combined with when_to_use truncated at 1,536 chars.
- when_to_use (No) — extra trigger context.
- argument-hint (No) — autocomplete hint, e.g., "[issue-number]".
- arguments (No) — named positional args for $name substitution.
- disable-model-invocation (No, default false) — only user can invoke.
- user-invocable (No, default true) — false hides from `/` menu.
- allowed-tools (No) — pre-approved tools while skill active.
- model (No) — model to use when skill active.
- effort (No) — low / medium / high / xhigh / max.
- context (No) — `fork` to run in subagent.
- agent (No) — which subagent type when context: fork.
- hooks (No) — skill-scoped hooks.
- paths (No) — glob patterns to gate auto-activation.
- shell (No) — bash (default) or powershell.

## String substitutions
- $ARGUMENTS — full args.
- $ARGUMENTS[N] / $N — indexed.
- $name — named arg.
- ${CLAUDE_SESSION_ID}, ${CLAUDE_EFFORT}, ${CLAUDE_SKILL_DIR}.

## File structure
```
my-skill/
├── SKILL.md           # Required
├── template.md        # Optional templates
├── examples/          # Optional examples
└── scripts/           # Optional executables
```

## Example SKILL.md
```yaml
---
name: my-skill
description: What this skill does
disable-model-invocation: true
allowed-tools: Read Grep
---
Your skill instructions here...
```

## Dynamic context injection
- `` !`<command>` `` runs shell before sending to model.
- `` ```! ... ``` `` for multi-line.
- Disable via `disableSkillShellExecution: true`.

## Permission control
- Skill(name) exact match; Skill(name *) prefix.
- Settings file: `skillOverrides` — values: on, name-only, user-invocable-only, off.

## Subagent integration
- context: fork + agent: Explore (or general-purpose) — runs SKILL.md as task in fresh context.

## Source quote (≤15 words, in quotes)
"Skills extend what Claude can do."
