# SigmaLink Performance, Reliability, and Platform Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an independently verified, cross-domain SigmaLink audit; rebuild the active wishlist from current evidence; and land only low-risk, regression-protected fixes.

**Architecture:** Eight read-only specialist reviews run in three concurrency-safe waves and feed a single primary-agent evidence ledger. The primary agent traces and reproduces each candidate before classifying it, while accepted fixes are isolated into finding-specific TDD tasks so speculative observations never become code churn.

**Tech Stack:** Electron 30, React 19, TypeScript 5.9, Vite 7, Vitest 4, Playwright 1.59, node-pty, xterm.js, better-sqlite3/Drizzle, pnpm workspaces, electron-builder.

## Global Constraints

- Work only in `/Users/aisigma/projects/SigmaLink-wt-audit-2026-07-24` on branch `audit/performance-platform-cleanup-2026-07-24`.
- Keep the original checkout and all unrelated worktrees unchanged.
- Deploy exactly eight read-only audit sub-agents; sub-agents must not edit files.
- Treat every sub-agent report as a hypothesis until the primary agent independently inspects and verifies it.
- Every retained finding requires exact `file:line` citations, an execution path, an impact mechanism, a verification receipt, severity, effort, confidence, and a concrete action.
- Use **Confirmed**, **Strong static evidence**, **Hypothesis**, and **Rejected** exactly as defined in the approved design.
- Do not claim live Windows verification from macOS; distinguish source/CI inspection from target-OS execution.
- Do not remove features based only on an import/reference search.
- Implement a fix only after confirming its root cause and adding a failing regression test or a reproducible measurement.
- Use `apply_patch` for hand-authored file changes and preserve unrelated user work.
- Archive the pre-audit wishlist verbatim before replacing the active file.
- Do not place completed fixes in the rebuilt wishlist.

---

## Planned file structure

- Create: `docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md` — canonical evidence ledger, baseline receipts, verified findings, rejected hypotheses, fixes, and final gate.
- Create: `docs/03-plan/archive/WISHLIST-pre-performance-audit-2026-07-24.md` — verbatim pre-audit wishlist history.
- Modify: `WISHLIST.md` — clean active inbox containing only unresolved, current, cited findings.
- Modify conditionally: exact source and colocated test files identified by confirmed findings. Each conditional change must be introduced by a finding-specific plan section added to the audit report before editing code.

The audit spans independent subsystems, but they intentionally share one master plan because their product is a single deduplicated evidence ledger. Code remediation is not pre-guessed: each accepted implementation becomes a self-contained TDD task only after the relevant code path and expected behavior are known.

---

### Task 1: Establish the isolated baseline and evidence ledger

**Files:**
- Create: `docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md`
- Read: `app/package.json`
- Read: `app/playwright.config.ts`
- Read: `app/tests/perf/jank-review.spec.ts`
- Read: `app/tests/perf/trace-analyzer.ts`

**Interfaces:**
- Consumes: clean audit worktree at commit `b81df24` or a descendant containing only approved audit documentation.
- Produces: a baseline section whose command receipts every later finding and fix can compare against.

- [ ] **Step 1: Verify worktree identity and cleanliness**

Run:

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --short
node --version
pnpm --version
uname -a
```

Expected: the top-level path and branch match the global constraints; status is clean; tool and OS versions are recorded verbatim.

- [ ] **Step 2: Install the locked dependency graph**

Run:

```bash
cd app
pnpm install --frozen-lockfile
```

Expected: exit 0 with no lockfile mutation. If native-module installation fails, record the complete error and classify it before continuing.

- [ ] **Step 3: Record the pre-change verification baseline**

Run each command separately from `app/` so failures remain attributable:

```bash
pnpm test
pnpm lint
pnpm build
pnpm electron:compile
```

Expected: record exit code, test counts, elapsed time, and warnings for each command. A failure must be reproduced once and labeled pre-existing or environmental before any product fix begins.

- [ ] **Step 4: Record artifact and dependency baselines**

Run:

```bash
du -ah dist electron-dist 2>/dev/null | sort -h | tail -40
pnpm list --depth 0
pnpm exec vite --version
pnpm exec electron --version
```

Expected: renderer chunk sizes, Electron bundle sizes, direct dependency graph, and build-tool versions are captured in the ledger.

- [ ] **Step 5: Inspect and run the repository performance harness**

First read the performance config and specs completely, then run:

```bash
pnpm test:perf
```

Expected: results are recorded without treating a dev-mode benchmark as a production result. Missing browser/runtime prerequisites are classified as an environment limitation, not a product defect.

- [ ] **Step 6: Create the baseline ledger**

Create `docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md` with these exact top-level sections:

```markdown
# SigmaLink Performance, Reliability, and Platform Audit

**Date:** 2026-07-24
**Branch:** `audit/performance-platform-cleanup-2026-07-24`
**Design:** [2026-07-24-performance-platform-cleanup-audit-design.md](../../superpowers/specs/2026-07-24-performance-platform-cleanup-audit-design.md)

## Scope and evidence rules
## Environment and baseline
## Candidate ledger
## Verified findings
## Rejected or downgraded hypotheses
## Implemented low-risk fixes
## Deferred platform verification
## Final verification
```

Under `Environment and baseline`, paste the literal commands, exit codes, counts, timings, warnings, and artifact sizes from Steps 1–5. Under `Scope and evidence rules`, summarize the four evidence classes from the design without weakening them.

- [ ] **Step 7: Checkpoint the baseline**

Run:

```bash
git diff --check
git add docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md
git commit -m "docs: record performance audit baseline"
```

Expected: one documentation-only commit and a clean status.

---

### Task 2: Dispatch Wave 1 — renderer, terminal, and PTY/process lifecycle

**Files:**
- Read: `app/src/renderer/**`
- Read: `app/src/main/core/pty/**`
- Read: `app/src/main/core/process/**`
- Read: relevant shared contracts and tests reached from those paths
- Modify: none

**Interfaces:**
- Consumes: the evidence rules and baseline from Task 1.
- Produces: three structured candidate reports delivered to the primary agent; no filesystem edits.

- [ ] **Step 1: Spawn the renderer/React lifecycle specialist**

The prompt must require inspection of reachable component and hook lifecycles, listener/timer/observer cleanup, state fan-out, memoization boundaries, cache bounds, large-list behavior, and hidden-surface work. Require a maximum of ten candidates and the exact report schema in Step 4.

- [ ] **Step 2: Spawn the pane/terminal/xterm specialist**

The prompt must require end-to-end tracing of pane create/mount/hide/restore/close, terminal cache ownership, xterm and add-on disposal, WebGL/context handling, resize/refit loops, scrollback copying, terminal-engine subscriptions, and repeated-session behavior. Require comparison against existing lifecycle tests and a maximum of ten candidates.

- [ ] **Step 3: Spawn the PTY/process specialist**

The prompt must require end-to-end tracing of spawn, stream, exit, expected-exit, kill, shutdown, process-tree cleanup, orphan sweep, retries, intervals, and platform branches. It must distinguish Electron-owned resources from child CLI resource use and return at most ten candidates.

- [ ] **Step 4: Enforce the candidate report schema**

Every candidate returned by all three specialists must contain exactly these fields:

```text
Title:
Classification proposed: Confirmed | Strong static evidence | Hypothesis | Rejected
Severity / effort / confidence:
Primary citations: file:line
Reachable trigger:
Full ownership or data-flow path:
Impact mechanism and bound:
Existing mitigation or test:
Verification performed and literal result:
Independent verification recipe:
Recommended action:
```

Agents must also list searched areas with no findings and identify anything they rejected during their own review.

- [ ] **Step 5: Wait for all Wave 1 reports**

Expected: all three agents complete before any Wave 2 agent starts, freeing the three sub-agent slots and preventing accidental scope overlap.

---

### Task 3: Validate and record Wave 1 candidates

**Files:**
- Modify: `docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md`
- Read/Test: exact files and tests cited by Wave 1

**Interfaces:**
- Consumes: three Wave 1 candidate reports.
- Produces: deduplicated, primary-agent classifications with receipts.

- [ ] **Step 1: Deduplicate by root cause**

Merge candidates only when their cited ownership path and cause are the same. Keep distinct symptoms together under one root cause and preserve all citations.

- [ ] **Step 2: Trace every surviving path independently**

For each candidate, read the full function, its caller, lifecycle owner, cleanup path, and closest relevant test. Search for alternate cleanup and bounded-cache behavior before accepting an absence claim.

- [ ] **Step 3: Reproduce or downgrade each claim**

Use the smallest existing test, a focused new disposable test, a deterministic command, or direct state inspection. If cause and effect cannot both be shown, label the candidate **Strong static evidence** or **Hypothesis**. Do not use **Confirmed** based solely on an agent report.

- [ ] **Step 4: Record literal verification receipts**

Add each candidate to `Candidate ledger` with its final evidence class, commands, exit codes, output summary, citations, and acceptance/rejection reason. Move accepted items into `Verified findings`; move disproved or immaterial items into `Rejected or downgraded hypotheses`.

- [ ] **Step 5: Commit the Wave 1 ledger**

Run:

```bash
git diff --check
git add docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md
git commit -m "docs: validate renderer and process audit findings"
```

Expected: documentation-only commit; any experimental test file used solely for diagnosis is removed before committing.

---

### Task 4: Dispatch Wave 2 — database/memory, platforms, and startup/build

**Files:**
- Read: `app/src/main/core/db/**`
- Read: `app/src/main/core/memory/**`
- Read: `app/src/main/core/ruflo/**`
- Read: `app/electron/**`
- Read: `app/scripts/**`
- Read: `app/electron-builder.yml`
- Read: `.github/workflows/**`
- Read: `app/package.json`, `app/pnpm-lock.yaml`, and workspace manifests
- Modify: none

**Interfaces:**
- Consumes: Task 1 baseline and the evidence schema from Task 2.
- Produces: three structured candidate reports delivered to the primary agent.

- [ ] **Step 1: Spawn the database/cache/memory specialist**

Require tracing of database open/close and statements, transaction scope, WAL/checkpoint behavior, row retention, in-memory maps/sets/queues, AgentDB/Ruflo daemon supervision, intervals, listeners, cache bounds, and repeated start/stop behavior. The agent must separate current-scale impact from threshold-triggered future work.

- [ ] **Step 2: Spawn the Windows/macOS compatibility specialist**

Require source and configuration analysis of shell/path/process behavior, native modules, platform guards, installer scripts, signing/notarization, permissions, update/relaunch paths, packaging targets, and CI matrices. Require explicit evidence labels: live-tested, CI-covered, unit-tested branch, or static-only.

- [ ] **Step 3: Spawn the startup/build/dependency specialist**

Require tracing from Electron boot through eager service initialization and renderer entry, bundle/chunk inspection, dependency usage evidence, native rebuild costs, packaged-file inclusions, duplicated libraries, and upgrade risks. A dependency may be called removable only after manifest, import, runtime-load, build-script, and packaging references are checked.

- [ ] **Step 4: Enforce the Task 2 report schema and ten-candidate cap**

Expected: every candidate is bounded and actionable; broad advice such as “upgrade Electron” or “use memoization” without a cited mechanism is rejected by the agent before return.

- [ ] **Step 5: Wait for all Wave 2 reports**

Expected: all three agents complete and release their slots before Wave 3.

---

### Task 5: Validate and record Wave 2 candidates

**Files:**
- Modify: `docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md`
- Read/Test: exact files, configs, workflows, and tests cited by Wave 2

**Interfaces:**
- Consumes: three Wave 2 reports.
- Produces: deduplicated platform and resource findings with evidence-level precision.

- [ ] **Step 1: Repeat Task 3’s deduplication and full-path tracing**

For platform findings, trace both the platform-specific branch and its callers. For resource claims, identify allocation, ownership, bound, cleanup, and repeat trigger.

- [ ] **Step 2: Validate dependency and feature-cost claims mechanically**

Use `rg` across source, scripts, configs, workflows, docs, dynamic import strings, and package manifests. Use build output inspection where tree-shaking or runtime loading could invalidate static counts.

- [ ] **Step 3: Apply platform evidence labels**

Mark every platform claim as one of: live-tested on current host, exercised by an automated test, covered by repository CI configuration, or static-only. Never collapse these into the word “verified.”

- [ ] **Step 4: Record accepted and rejected candidates with receipts**

Update the same ledger sections used in Task 3. Include current observed scale for database/storage items and define a measurable trigger for optimizations that are not presently material.

- [ ] **Step 5: Commit the Wave 2 ledger**

Run:

```bash
git diff --check
git add docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md
git commit -m "docs: validate memory platform and build findings"
```

Expected: documentation-only commit with no untracked diagnostic artifacts.

---

### Task 6: Dispatch Wave 3 — feature archaeology and verification blind spots

**Files:**
- Read: all application source, manifests, routes, RPC channel registries, scripts, assets, docs, and tests needed to prove reachability
- Modify: none

**Interfaces:**
- Consumes: the baseline and both prior-wave ledgers so agents can avoid rediscovering accepted items.
- Produces: two structured reports and completes the required eight-agent deployment.

- [ ] **Step 1: Spawn the feature-archaeology specialist**

Require a reachability map from UI navigation, commands, settings, RPC/public contracts, Electron startup, scripts, installers, and documented features. Candidates must distinguish dead code, dormant-but-supported features, debug/dev tooling, compatibility shims, generated assets, duplicated generations, and intentional defaults-off features. Removal candidates need evidence across every entry surface.

- [ ] **Step 2: Spawn the verification/performance-blind-spots specialist**

Require an adversarial review of existing unit, E2E, and performance tests: lifecycle cleanup coverage, benchmark realism, false-positive assertions, timing dependence, missing repeated-cycle tests, untested platform branches, and observability gaps. The agent must challenge existing Wave 1/2 classifications without treating disagreement as proof.

- [ ] **Step 3: Enforce the Task 2 schema and ten-candidate cap**

Expected: each report includes negative findings and rejects noisy “unused” claims that are reachable through runtime strings, packaging, or public contracts.

- [ ] **Step 4: Wait for both Wave 3 reports**

Expected: exactly eight distinct sub-agents have completed across the three waves.

---

### Task 7: Validate Wave 3 and perform the global adversarial review

**Files:**
- Modify: `docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md`
- Read/Test: every path required to establish reachability and test validity

**Interfaces:**
- Consumes: Wave 3 reports and all prior accepted/rejected candidates.
- Produces: final pre-remediation evidence ledger.

- [ ] **Step 1: Validate feature reachability across all entry surfaces**

For each removal/deprecation candidate, check imports, dynamic imports, route tables, navigation, command palette, settings, RPC allowlists and handlers, preload exposure, Electron startup, scripts, package/build configuration, CI, docs, and release compatibility.

- [ ] **Step 2: Validate test-gap and benchmark claims**

Read the test setup and assertion path rather than counting test names. Re-run any allegedly weak test under the condition it claims to protect when feasible.

- [ ] **Step 3: Challenge loaded language across the full ledger**

Search the audit report for `leak`, `unused`, `dead`, `cross-platform`, `faster`, `fixed`, `confirmed`, `always`, and `never`. For each occurrence, attach a receipt or weaken the language.

- [ ] **Step 4: Rank final findings**

Use severity `critical|high|medium|low`, effort `S|M|L|XL`, confidence `confirmed|strong-static|hypothesis`, and action `fix-now|wishlist|deprecate-proposal|archive-proposal|reject`. Explain ordering by user impact and expected return, not novelty.

- [ ] **Step 5: Commit the complete pre-remediation ledger**

Run:

```bash
git diff --check
git add docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md
git commit -m "docs: complete adversarial audit validation"
```

Expected: every candidate has a final disposition.

---

### Task 8: Implement each accepted low-risk fix with TDD

**Files:**
- Modify: only exact source files named in a **Confirmed** finding with action `fix-now`
- Test: colocated focused test files for those source files
- Modify: `docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md`

**Interfaces:**
- Consumes: final findings whose cause, behavior, and minimal fix are fully specified.
- Produces: independently reviewable commits, one root cause per commit, with before/after receipts.

- [ ] **Step 1: Invoke `superpowers:test-driven-development` for the first `fix-now` finding**

If no finding meets every fix-now rule, record “No code change met the evidence and risk gate” under `Implemented low-risk fixes` and skip to Task 9.

- [ ] **Step 2: Add a finding-specific implementation section before editing code**

The section must name the exact source and test paths, current behavior, expected behavior, failing-test command, minimal production change, focused pass command, and regression command. It must contain no unrelated cleanup.

- [ ] **Step 3: Write and run the failing regression test**

Expected: the new test fails for the predicted reason against the pre-fix code. A test that passes immediately does not prove the bug and blocks implementation until corrected.

- [ ] **Step 4: Apply the smallest production change**

Change only the verified ownership/root-cause site. Do not combine findings or refactor neighboring code.

- [ ] **Step 5: Run focused and neighboring regression tests**

Expected: the new test passes; existing tests for the same subsystem pass; no snapshots or expectations are loosened merely to accept the change.

- [ ] **Step 6: Record before/after evidence and commit**

Update `Implemented low-risk fixes` with the failing-before and passing-after receipts, then run:

```bash
git diff --check
git status --short
git add app/src app/electron app/scripts docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md
git commit -m "fix: apply verified low-risk audit finding"
```

Expected: the commit contains one root cause, its focused regression test, and its audit receipt. Repeat Steps 1–6 separately for each additional fix-now finding.

---

### Task 9: Archive and rebuild the wishlist

**Files:**
- Create: `docs/03-plan/archive/WISHLIST-pre-performance-audit-2026-07-24.md`
- Modify: `WISHLIST.md`
- Read: `docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md`

**Interfaces:**
- Consumes: the final disposition of every candidate and implemented fix.
- Produces: a clean active inbox plus lossless historical archive.

- [ ] **Step 1: Copy the current wishlist verbatim into the archive**

The archive must begin with:

```markdown
# Archived SigmaLink Wishlist — pre-performance audit

> Verbatim snapshot of the active `WISHLIST.md` before the 2026-07-24 evidence-gated
> performance, reliability, and platform audit. Preserved for history; active items
> were re-evaluated rather than carried forward automatically.

---
```

Append the complete pre-audit `WISHLIST.md` below the divider without rewriting its contents.

- [ ] **Step 2: Replace the active wishlist with the standard clean skeleton**

Use the project title, archive link, audit-report link, and these buckets:

```markdown
# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.**
> The pre-audit inbox is archived at [WISHLIST-pre-performance-audit-2026-07-24.md](docs/03-plan/archive/WISHLIST-pre-performance-audit-2026-07-24.md).
> Full evidence: [2026-07-24 performance/platform audit](docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md).

---

## 🚫 Deferred by design (out of scope for now)
## ✨ Future enhancements (planned-later upgrades)
## 🆕 New ideas (untriaged)
## 🔬 Deep review findings (2026-07-24)
```

- [ ] **Step 3: Add only unresolved accepted findings**

Every bullet must include area, title, evidence class, severity, effort, exact `file:line`, concrete action, and build trigger where applicable. Exclude rejected claims, completed fixes, already-fixed history, and vague advice.

- [ ] **Step 4: Verify wishlist traceability**

For every `file:line` citation, open the path and confirm the cited lines still support the wording after any code fixes. Confirm every wishlist bullet links back to a full audit finding.

- [ ] **Step 5: Commit the archive and rebuilt wishlist**

Run:

```bash
git diff --check
git add WISHLIST.md docs/03-plan/archive/WISHLIST-pre-performance-audit-2026-07-24.md docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md
git commit -m "docs: rebuild wishlist from verified audit findings"
```

Expected: the active wishlist contains no pre-audit noise and the archive is verbatim.

---

### Task 10: Run final verification and adversarial diff review

**Files:**
- Modify: `docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md`
- Review: every changed file on the audit branch

**Interfaces:**
- Consumes: complete audit, optional fixes, archive, and rebuilt wishlist.
- Produces: final ship/no-ship evidence for the branch.

- [ ] **Step 1: Run focused tests for every implemented fix**

Expected: all named regression tests pass individually. Record commands, counts, and elapsed times.

- [ ] **Step 2: Run the full gate from `app/`**

Run separately:

```bash
pnpm test
pnpm lint
pnpm build
pnpm electron:compile
```

Expected: all commands exit 0. Compare test counts, warnings, elapsed times, and artifact sizes against Task 1.

- [ ] **Step 3: Re-run applicable performance checks**

Run:

```bash
pnpm test:perf
du -ah dist electron-dist 2>/dev/null | sort -h | tail -40
```

Expected: use identical conditions to the baseline. Report only comparable measurements and explain environmental skips.

- [ ] **Step 4: Review the entire branch diff**

Run:

```bash
git diff --check
git diff --stat 80065c3..HEAD
git diff 80065c3..HEAD -- WISHLIST.md docs/03-plan docs/superpowers app/src app/electron app/scripts app/package.json app/electron-builder.yml
git status --short
```

Expected: no unrelated modifications, no secrets or live-user data, no untracked diagnostics, and no unsupported claims.

- [ ] **Step 5: Record and commit the final verification receipt**

Update `Final verification` with the literal final commands, exit codes, counts, timings, artifact comparison, platform limits, and final Git status. Then run:

```bash
git add docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md
git commit -m "docs: record final audit verification"
git status --short
```

Expected: clean status and a final report that clearly separates measured facts, static evidence, and unresolved hypotheses.
