# 09 — Backlog verify-and-close sweep

**Severity**: P3 hygiene
**Effort**: XS each, S total (~2-3hr)
**Cluster**: Backlog hygiene
**Suggested delegate**: Qwen via OpenCode
**Depends on**: nothing

## Context

BACKLOG.md flags 4 items as "already implemented on `codex/bug-backlog-pr` branch" but they were never verified + moved to Shipped. v1.4.2 closes them as one polish bundle.

## The 4 items

### 9.1 — BUG-W7-015 Launch button low-contrast in Parchment theme

- WISHLIST: line 63 ("Launch button low-contrast in Parchment theme")
- BACKLOG: lines 46-52
- Status: "no additional code change was needed in this PR" (2026-05-12) — verify-and-close path
- Verify steps:
  1. `git log --all --oneline | grep -i 'parchment\|w7-015'`
  2. Confirm the contrast fix landed on `main` (check current `Launcher.tsx` Parchment theme styles)
  3. Manual: open Settings → Appearance → Parchment; verify Launch button has WCAG AA contrast (>4.5:1) against background
  4. If verified: move row from BACKLOG → CHANGELOG `[Fixed]` (or just delete from BACKLOG with a note that it shipped earlier and the row is now closed)

### 9.2 — shellcheck step for `install-macos.sh`

- WISHLIST: line 70
- BACKLOG: lines 238-244
- Status: "Added a CI step…" (2026-05-12) — verify-and-close
- Verify steps:
  1. `cat .github/workflows/lint-and-build.yml` — confirm shellcheck step exists for `app/scripts/install-macos.sh`
  2. Manual: `gh run list --workflow=lint-and-build.yml --limit=3` — confirm last 3 runs ran shellcheck
  3. If verified: close BACKLOG row.

### 9.3 — CI cache-dependency-path fix

- WISHLIST: line 68
- BACKLOG: lines 222-227
- Status: "already done on `codex/bug-backlog-pr`" — verify-and-close
- Verify steps:
  1. Read `.github/workflows/lint-and-build.yml` cache step — `cache-dependency-path` should point at `app/pnpm-lock.yaml` (or wherever the lockfile actually lives)
  2. `gh run list` — confirm cache hits in recent runs (look for "Cache restored" in logs)
  3. If verified: close BACKLOG row.

### 9.4 — vitest coverage thresholds

- WISHLIST: line 69
- BACKLOG: lines 229-236
- Status: "already added with 22% line floor" — verify-and-close
- Verify steps:
  1. Read `app/vitest.config.ts` — confirm `coverage.thresholds` block present
  2. `pnpm exec vitest run --coverage` — confirm coverage report runs and threshold gate is wired
  3. If verified: close BACKLOG row.

## Process

For each item:
- Run the verify steps
- If verified clean → delete the BACKLOG row + add a one-line entry to `CHANGELOG.md [Unreleased]` or `[1.4.2]`
- If NOT verified (the claim was false) → escalate to lead with a finding; do NOT silently close

Single commit covers all 4: `docs(v1.4.2): close 4 backlog verify-and-close items`.

## File:line targets

| File | Operation |
|---|---|
| `docs/08-bugs/BACKLOG.md` | Remove the 4 verified rows |
| `CHANGELOG.md` | Add 1-2 lines under v1.4.2 covering the swept items |
| (none) | No source changes if all 4 verify clean |

## Verification

Single command per item; all 4 in under 30 minutes total. Output a markdown verification table for the lead.

## Risks

- R-09-1: Any item that fails verification needs to flip back to a "do real work" task. Flag immediately.

## Closes

4 BACKLOG rows.
