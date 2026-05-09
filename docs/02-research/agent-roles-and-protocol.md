# BridgeSwarm Agent Roles and Protocol
Compiled: 2026-05-09

Sources: bridgeswarm, blog-bridgeswarm, products-bridgespace, blog-anatomy-of-agentic-organization, blog-scaling-ai-systems, blog-ai-engineering-best-practices.

## The four canonical roles

### Coordinator
- Persona: Staff Engineer / Tech Lead.
- Duties: decompose goals into safe, parallel tasks; assign file ownership; manage dependencies; monitor progress; unblock builders.
- Source quote: "Manages the overall plan and unblocks agents when they get stuck."

### Builder
- Persona: Senior Software Engineer ("the engineer who ships").
- Duties: read context first, plan before implementing, modify only assigned files, match code patterns/conventions, validate (tests/lint) before marking work done.
- Source quote: "Reading context, planning before implementing, validating before marking done."

### Scout
- Persona: Codebase Intelligence Specialist ("codebase expert").
- Duties: map the project before builders start; provide structured intelligence on patterns, conventions, risks; eliminate discovery time for builders.
- Source quote: "Provides structured intelligence about patterns, conventions, and potential risks."

### Reviewer
- Persona: Principal Engineer / Quality Gate.
- Duties: comprehensive review for correctness, security, consistency; block substandard work; enforce quality gates.
- Source quote: "Every piece of work passes through a comprehensive review."

---

## Behavioral rules

### From bridgeswarm landing page (8)
1. Agents always know full project context before starting.
2. Real-time status tracking keeps swarm synchronized.
3. Strict file ownership prevents merge conflicts by design.
4. Zero idle chatter—every message advances the goal.
5. Structured completion reporting prevents falling through cracks.
6. Automatic escalation when agents are blocked.
7. Safe git practices enforced at orchestration layer.
8. Agents prioritize shipping code over sending messages.

### From bridgeswarm blog post (4 named)
- Rule 1: No idle chatter. Every message must advance the goal.
- Rule 2: Strict scope. Agents only modify what they're assigned.
- Rule 3: Work over talk. Agents prioritize doing work over messaging.
- Rule 4: Structured escalation. When blocked, agents escalate with specific context rather than spinning.

(The 8-vs-4 mismatch is an open question.)

---

## File ownership rules
- Each task has exclusive ownership of the files it modifies.
- "No two concurrent tasks can own the same file — period."
- When tasks share dependencies, the orchestration layer sequences them automatically.

---

## Shared source of truth
- All agents read/write through the same task board (BridgeMCP project + tasks + knowledge).
- Task knowledge field (≤50,000 chars) accumulates discoveries across agents.
- Real-time status sync; no out-of-band channels.

---

## Quality gates
- Reviewer must pass before merge.
- Quality dimensions checked: correctness, security, consistency.
- Companion skills (BridgeSecurity, BridgeWard) provide automated audit hooks.

---

## Completion reports
- Public docs reference "Structured completion reporting prevents falling through cracks" (rule 5) but do not publish the canonical schema (open question).
- Implied minimum fields: task ID, status, files touched, validation results, follow-ups.

---

## Inter-agent communication protocol
- Public docs do not specify message format, transport, or schema (open question).
- Hints from sources:
  - Mediated via BridgeMCP task lifecycle (todo → in-progress → in-review → complete → cancelled).
  - Mentions: "real-time status tracking" (rule 2), "automatic escalation when agents are blocked" (rule 6).
  - Status updates flow through BridgeMCP, not chat.
  - "Mention textarea" added in BridgeSpace v3.0.7 — likely surface for human → agent comms.

---

## Escalation protocol
- Rule 4 / 6: when blocked, agent escalates with specific context (not retries forever).
- Coordinator unblocks builders.
- Public docs do not specify channel or format (open question).

---

## Other role taxonomies referenced (do NOT replace canonical 4)
- Blog "Agentic Engineering Best Practices" lists Feature / Review / Test / Refactor agents.
- Blog "Anatomy of an Agentic Organization" frames humans as Technical Director, agents as autonomous executors.
- Blog "Scaling Vibe Coding" introduces Supervisor Agent for stage-3 swarms.
- Blog "Agentic Coding" cites Architect / Frontend / Backend / QA roles as examples.
- BridgeCode docs add 5 built-in agents: vibe / build / plan / architect / ship.

---

## Git practices (rule 7)
- Safe git practices enforced at orchestration layer.
- Specific behaviors not published (open question; presumably: no force push, branch per task, commit per atomic change).

---

## Source quote (≤15 words, in quotes)
"No two concurrent tasks can own the same file — period."
