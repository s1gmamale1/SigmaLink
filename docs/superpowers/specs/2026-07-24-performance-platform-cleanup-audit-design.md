# SigmaLink Performance, Reliability, and Platform Audit Design

**Date:** 2026-07-24  
**Branch:** `audit/performance-platform-cleanup-2026-07-24`  
**Scope:** SigmaLink desktop app and the repository-level configuration that governs its build, packaging, tests, and active product surface.

## Objective

Conduct an evidence-gated audit of SigmaLink for performance bottlenecks, memory and resource leaks, application overhead, Windows/macOS compatibility gaps, pane/terminal correctness and efficiency, and unused or abandoned features. Rebuild the active wishlist from verified findings and implement only fixes that are demonstrably low risk.

This is an audit-first engagement. A sub-agent report is a lead, not proof. The primary agent owns reproduction, validation, integration, and final claims.

## Success criteria

1. Establish a recorded baseline for tests, lint, TypeScript/build, bundle output, and the available performance checks.
2. Deploy eight specialist sub-agents across independent domains without allowing overlapping edits.
3. Require every accepted finding to identify the relevant code path, cite `file:line`, explain the impact mechanism, and provide reproducible evidence.
4. Independently verify every finding before labeling it confirmed or implementing it.
5. Replace the active root `WISHLIST.md` with a concise, current, prioritized set of cited findings while preserving the previous file in a dated archive.
6. Implement only verified changes that are small, isolated, testable, and unlikely to alter product behavior unexpectedly.
7. Finish with the relevant focused tests plus full lint, test, build, and Electron compile gates, or document any pre-existing/environmental blocker precisely.

## Non-goals

- Large architectural rewrites, framework migrations, visual redesigns, or speculative dependency upgrades.
- Removing a feature solely because it appears unused in a static search. Removal requires reachability, runtime, build, and product-intent evidence.
- Claiming Windows or macOS runtime behavior was tested when the required operating system was unavailable. Static and CI evidence must be labeled separately from live-platform proof.
- Treating child CLI process memory as an Electron leak without attributing memory to the correct process.
- Filling the wishlist with fixes completed during this audit; completed work belongs in the audit report and Git history.

## Audit structure

The eight sub-agent assignments are deliberately read-only and independently scoped:

1. **Renderer and React lifecycle:** rendering frequency, retained listeners, timers, observers, subscriptions, caches, large component boundaries, and avoidable state fan-out.
2. **Pane, terminal, and xterm:** pane lifecycle, terminal engines and caches, resize/refit paths, scrollback, WebGL/add-on disposal, hidden-pane work, data-copy amplification, and stale session state.
3. **PTY and process lifecycle:** spawn/exit/kill ordering, process-tree cleanup, orphan sweeping, streams, retry loops, shutdown behavior, and resource ownership.
4. **Database and memory systems:** SQLite/Drizzle connection lifecycle, statements, transactions, WAL behavior, AgentDB/Ruflo supervisors, cache bounds, background work, and retention.
5. **Windows and macOS compatibility:** shell/process/path behavior, native modules, packaging, installers, permissions, signing, update paths, platform guards, and CI coverage.
6. **Startup, build, and dependency overhead:** Electron boot path, eager imports and initialization, renderer chunks, duplicate/heavy dependencies, packaging payload, development scripts, and upgrade risk.
7. **Feature archaeology:** route and RPC reachability, UI entry points, flags, duplicated generations, abandoned experiments, obsolete scripts/assets/dependencies, and deprecation candidates.
8. **Verification and performance blind spots:** benchmark validity, test gaps around lifecycle cleanup, platform-specific untested branches, flaky/time-based tests, and missing observability needed to prove performance claims.

Because the environment permits three sub-agents alongside the primary agent, assignments run in waves. Agents do not edit files. This prevents shared-worktree conflicts and keeps all integration decisions with the primary agent.

## Evidence model

Each candidate finding must be classified using the following ladder:

- **Confirmed:** reproduced by an automated test, deterministic command, runtime trace/profile, benchmark, or direct state inspection that demonstrates both cause and effect.
- **Strong static evidence:** the entire ownership/data-flow path has been traced and an invariant violation is demonstrable, but runtime reproduction is unavailable. This label must remain explicit.
- **Hypothesis:** a plausible risk or optimization requiring further instrumentation or a target platform. It may be parked as an unverified wishlist item, never described as a confirmed defect.
- **Rejected:** disproved, already mitigated, unreachable, immaterial at current scale, or based on an incorrect assumption.

For every non-rejected finding, record:

- exact `file:line` citations;
- trigger and affected execution path;
- root cause or optimization mechanism;
- observed or bounded impact;
- verification command, test, trace, or inspection receipt;
- severity, effort, confidence, and regression surface;
- recommended fix, removal, archive, deprecation, or measurement trigger.

Before acceptance, the primary agent must inspect the cited source and perform an independent verification. Similar findings from multiple agents count as corroboration, not independent proof.

## Workflow

### 1. Isolated baseline

Use the dedicated worktree and install dependencies according to the lockfile. Record environment versions, Git state, baseline lint/test/build results, bundle chunk sizes, and existing performance-test behavior. Baseline failures stop implementation until they are separated into pre-existing, environmental, or reproducible product failures.

### 2. Specialist discovery

Dispatch agents with narrow prompts, explicit exclusions, and a structured return format. Agents inspect source, tests, configs, recent relevant history, and existing docs. They may run read-only diagnostics and tests but may not modify the worktree.

### 3. Primary validation

Deduplicate candidates and trace each one from source to lifecycle owner or user-visible effect. Prefer deterministic tests and existing instrumentation. For performance findings, collect before/after measurements under the same workload. For suspected leaks, verify that retained resources grow across repeated create/destroy cycles or that cleanup is provably absent from a reachable lifecycle.

### 4. Decision and remediation

A fix may be implemented during this audit only when all of these are true:

- the cause is confirmed;
- the change is local and reversible;
- behavior is protected by a failing regression test or measurable baseline;
- the expected benefit is meaningful or the correctness risk is concrete;
- platform impact is understood;
- the change does not require a product decision.

Feature removal requires stronger proof: no active route or command, no supported compatibility role, no external contract, no documented product commitment, and a green build/test result after removal. Otherwise the item is proposed for deprecation or archive in the wishlist.

### 5. Deliverables and final gate

Produce:

- a dated audit report containing verified findings, rejected hypotheses, measurements, and implemented fixes;
- a dated archive of the pre-audit wishlist;
- a rebuilt root `WISHLIST.md` containing only unresolved, cited, prioritized items;
- focused regression tests and low-risk fixes where the acceptance rules are met;
- a final verification record with commands and results.

Run focused tests after each change, then the full unit suite, lint, renderer build, and Electron compile. Review the final diff for unrelated changes. An adversarial final pass must challenge every statement that uses words such as “leak,” “unused,” “cross-platform,” “faster,” “fixed,” or “confirmed.”

## Risk controls

- Keep all work on the isolated audit branch.
- Preserve the user’s original checkout and unrelated worktrees.
- Do not let agents edit shared files.
- Do not delete active wishlist history without archiving it first.
- Do not run destructive cleanup against user data, live databases, caches, sessions, or worktrees.
- Do not benchmark with development-only conditions and generalize the result to production.
- Record uncertainty honestly when live Windows or macOS verification is unavailable.

## Completion standard

The audit is complete only when every retained finding has passed the evidence gate, every implemented change has regression protection and final-gate verification, the new wishlist contains no stale completed work, and the final report distinguishes measured facts from static evidence and open hypotheses.
