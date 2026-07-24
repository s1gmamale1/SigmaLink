# SigmaLink Performance, Reliability, and Platform Audit

**Date:** 2026-07-24  
**Branch:** `audit/performance-platform-cleanup-2026-07-24`  
**Baseline commit:** `d265d7e`  
**Design:** [2026-07-24-performance-platform-cleanup-audit-design.md](../../superpowers/specs/2026-07-24-performance-platform-cleanup-audit-design.md)

## Scope and evidence rules

This audit covers SigmaLink's Electron main process, React renderer, pane and terminal stack, PTY/process lifecycle, database and memory systems, macOS/Windows behavior, startup/build/dependency overhead, product-surface reachability, and verification blind spots.

Evidence classes:

- **Confirmed:** a deterministic test, command, runtime trace/profile, benchmark, or direct state inspection demonstrates both cause and effect.
- **Strong static evidence:** the full reachable ownership/data-flow path demonstrates an invariant violation, but a safe runtime reproduction is unavailable.
- **Hypothesis:** plausible and cited, but missing enough evidence that it must not be described as a defect or optimization win.
- **Rejected:** disproved, already mitigated, unreachable, immaterial at current scale, or based on an incorrect assumption.

A specialist report is only a candidate. The primary agent must inspect the cited source and independently reproduce, measure, or trace the claim before it can move into **Verified findings**.

## Environment and baseline

### Host and worktree

- Worktree: `/Users/aisigma/projects/SigmaLink-wt-audit-2026-07-24`
- Branch: `audit/performance-platform-cleanup-2026-07-24`
- Host: Apple Silicon, macOS 26.4 (25E246), Darwin 25.4.0
- Node: `v22.22.3`
- pnpm: `11.0.9`
- Git status before dependency setup: clean

### Dependency setup receipt

The repository does not provide a reproducible clean-worktree install on this host:

1. `pnpm install --frozen-lockfile` exited 1 with `ERR_PNPM_NO_LOCKFILE`. The only app lockfile path is ignored by `.gitignore` (`.gitignore:123`), and no lockfile is tracked.
2. A read-only attempt using the original checkout's ignored lockfile (SHA-256 `d1cd213d46a407b4bf49538eb0d9868c21c166487d41a73cf03ed021fa7358b3`) exited 1 with `ERR_PNPM_OUTDATED_LOCKFILE`: three current dependencies were absent and three removed dependencies remained.
3. An isolated `pnpm install --no-frozen-lockfile` resolved 878 packages, generated an ignored lockfile (SHA-256 `be659277297615b0db014c6d4130e1148782d75c92128cf29bf115eb5aaf3bcd`), then exited 1 because pnpm 11 blocked required native build scripts and the app postinstall could not rebuild `better-sqlite3`.
4. A temporary, worktree-only build approval let `esbuild`, `node-pty`, `better-sqlite3`, and Electron install scripts run, but the rebuild exited 228 with `ENOSPC`. The temporary tracked configuration was removed. The 790 MB generated `node_modules` was moved to macOS Trash as `~/.Trash/node_modules` and remains recoverable.
5. To continue source verification without touching the original dependencies, the audit worktree's ignored `app/node_modules` is a symlink to `/Users/aisigma/projects/SigmaLink/app/node_modules`.

The reused dependency tree is sufficient for the baseline gates but is stale relative to the current manifest: `pnpm list --depth 0` includes removed direct dependencies (`@radix-ui/react-separator`, `monaco-editor`, `recharts`) and does not reflect all newly declared direct dependencies. Therefore, the green build proves the checked-out source compiles against the operator's existing install; it does not prove a fresh clone resolves the same graph.

### Pre-change gates

| Command | Result | Receipt |
|---|---:|---|
| `pnpm test` | PASS | 477 files passed; 5,013 tests passed; 2 skipped; Vitest duration 69.58 s. Repeated jsdom canvas warnings and per-worker `NO_COLOR`/`FORCE_COLOR` warnings were non-fatal. |
| `pnpm lint` | PASS | ESLint exited 0 with no findings. |
| `pnpm build` | PASS | TypeScript project build and Vite production build exited 0; 2,131 modules transformed; Vite phase 5.39 s. |
| `pnpm electron:compile` | PASS | Main, preload, and three MCP entry bundles built successfully. |
| `pnpm test:perf` | NOT RUN | Safety hold: the perf spec launches Electron without a throwaway `--user-data-dir` (`app/tests/perf/jank-review.spec.ts:76-80`), while router boot opens the database under `app.getPath('userData')` (`app/src/main/rpc-router.ts:444-455`). This candidate requires independent trace/review before execution. |

### Artifact baseline

- Renderer `dist/`: 2.0 MB total.
- Largest renderer asset: `vendor-xterm-*.js`, 607.27 kB raw / 155.10 kB gzip.
- Main renderer entry chunk: `index-*.js`, 349.64 kB raw / 102.59 kB gzip.
- Settings chunk: 142.77 kB raw / 32.85 kB gzip.
- Electron `electron-dist/`: 14 MB total, including source maps.
- Electron main bundle: 4.1 MB; main source map: 8.2 MB.
- MCP memory server bundle: 421.4 kB; source map: 978.9 kB.

## Candidate ledger

| ID | Area | Candidate | Initial class | Primary evidence | Status |
|---|---|---|---|---|---|
| C-001 | dependency/build | A fresh clone cannot perform a deterministic locked install; the ignored local lock is stale and pnpm 11 build approvals are not encoded. | Confirmed setup reproduction | `.gitignore:123`; `app/package.json:35-109`; three literal install failures in the baseline receipt | Awaiting startup/build specialist and primary remediation decision |
| C-002 | perf/test safety | The opt-in perf harness appears to use the operator's real Electron user data and may mutate the live database, logs, caches, or worktrees. | Strong static evidence | `app/tests/perf/jank-review.spec.ts:70-81` → `app/src/main/rpc-router.ts:444-455`; no `app.setPath('userData', ...)` found | Awaiting verification specialist and independent full boot trace |

## Verified findings

No candidate is promoted here until the specialist waves and primary-agent evidence gates complete.

## Rejected or downgraded hypotheses

None yet.

## Implemented low-risk fixes

None yet.

## Deferred platform verification

- Windows live runtime and installer behavior cannot be exercised on this macOS host. Windows claims will be labeled as unit-tested branch, CI-covered, or static-only.
- The perf harness is deferred until its user-data isolation is proven or fixed; protecting operator data takes precedence over producing a baseline video.

## Final verification

Pending completion of specialist discovery, independent validation, any accepted TDD fixes, and the rebuilt wishlist.
