# GitHub: bridge-mind/BridgeSecurity
URL: https://github.com/bridge-mind/BridgeSecurity
Fetched: 2026-05-09

## Headings (verbatim)
- BridgeSecurity — Find vulnerabilities. Ship secure.
- Why BridgeSecurity?
- The Bugs It Catches
- What's Inside
- Reference Documentation
- Installation
- How It Works
- The 10-Question Threat Model
- Audit Mode
- When to Use
- Project Layout
- Compatibility
- What It Is Not
- Companion Skills
- References / License / About

## Components (verbatim)
| Component | Type | Purpose |
|-----------|------|---------|
| bridgesecurity | Skill | Core security discipline; auto-loads when code is read/written/reviewed |
| security-audit | Skill | Slash-command audit with severity-ranked CWE/OWASP reports |
| security-auditor | Agent | Read-only subagent applying OWASP Top 10 + CWE Top 25 |

## Reference docs (8 files)
vulnerability-taxonomies.md, language-patterns.md, frontend-patterns.md, infrastructure-patterns.md, secrets-patterns.md, case-studies.md, tooling.md, threat-modeling.md.

## The Five Disciplines
1. Find trust boundaries.
2. Match input to sink.
3. Auth on every state-changing path.
4. Secrets are already leaked.
5. Fail closed, log loudly, blast-radius small.

## 10-Question Threat Model (paraphrased)
Trust boundaries / AuthN+AuthZ server-side / Input validation / Output encoding / Secrets safe+rotatable / Failure mode closed / Blast radius / Supply chain pinned / Logging+PII redaction / Replay protection.

## Audit Mode commands
- `/security-audit src/api/users.ts`
- `/security-audit https://github.com/owner/repo/pull/123`
- `/security-audit ./terraform/`
- `/security-audit "all server actions in this app"`

## Installation (verbatim)
- `claude plugin install bridgesecurity@bridgemind-plugins`
- Or manual: cp -r skills/bridgesecurity .claude/skills/ etc.

## Project layout
```
BridgeSecurity/
├── .claude-plugin/plugin.json
├── skills/
│   ├── bridgesecurity/{SKILL.md, references/[8 .md files]}
│   └── security-audit/SKILL.md
├── agents/security-auditor.md
├── scripts/scan.sh
└── README, LICENSE, CHANGELOG, CONTRIBUTING, .gitignore
```

## Companion skills
- BridgeWard, BridgeUI, BridgeRemotion, BridgeMotion.

## Source quote (≤15 words, in quotes)
"Find vulnerabilities. Ship secure."
