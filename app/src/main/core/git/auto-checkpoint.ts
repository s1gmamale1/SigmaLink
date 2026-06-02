// FEAT-11 fast-follow — auto-checkpoint-on-dispatch.
//
// Automatically create a git checkpoint of a pane's worktree BEFORE a freshly
// dispatched agent's turn begins, so that the agent's very first changes are
// always reversible from the existing Rewind UI. The whole feature is gated
// behind `kv['git.autoCheckpointOnDispatch']` (DEFAULT OFF) and is wired into
// BOTH spawn paths (launcher.executeLaunchPlan + swarms.spawnAgentSession).
//
// CONTRACT (all of these are guarantees, not best-effort niceties):
//   - GATE: when the KV flag is absent or not '1', this is a no-op.
//   - CHANGE-CHECK: a `git status --porcelain` runs in the worktree; a clean
//     tree is skipped (there is nothing to make reversible, and committing an
//     --allow-empty savepoint for every dispatch would just spam history).
//   - MIN-INTERVAL: if THIS session already received an 'auto' checkpoint less
//     than `MIN_INTERVAL_MS` ago, the dispatch is skipped (rapid re-dispatch
//     guard — e.g. resume + immediate prompt).
//   - KIND: the recorded row is `kind: 'auto'` so the Rewind UI can distinguish
//     it from operator-pressed manual checkpoints (the FEAT-11 contract already
//     uses 'auto' for the pre-rewind safety snapshot; pre-dispatch reuses it).
//   - FAIL-OPEN: every branch is wrapped in try/catch. A missing/locked DB, an
//     absent worktree, a slow git, or a write failure can only degrade to a
//     no-op — it NEVER throws into the spawn loop and never blocks a dispatch.

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDb as getDbLive, getRawDb as getRawDbLive } from '../db/client';
import { sessionCheckpoints } from '../db/schema';
import { execCmd } from '../../lib/exec';
import { createCheckpoint as createCheckpointLive } from './git-ops';

/** KV flag (default OFF). '1' = on. Renderer uses the literal string. */
export const KV_AUTO_CHECKPOINT = 'git.autoCheckpointOnDispatch';

/** Min spacing between two auto checkpoints for the SAME session. */
export const MIN_INTERVAL_MS = 10_000;

/** Label stamped on auto pre-dispatch checkpoints. */
export const AUTO_CHECKPOINT_LABEL = 'pre-dispatch';

// The drizzle DB handle the helper reads/writes through. Typed off the live
// `getDb` return so production wiring stays end-to-end typed; the test passes a
// chainable fake cast through this signature (better-sqlite3 can't load under
// vitest).
export type AutoCheckpointDb = ReturnType<typeof getDbLive>;

export interface MaybeAutoCheckpointArgs {
  sessionId: string;
  worktreePath: string | null | undefined;
  /** Drizzle handle (defaults to the live client). */
  getDb?: () => AutoCheckpointDb;
  // ── Injectable seams (default to the live implementations) ──────────────
  /** Reads the KV gate; default reads `kv[KV_AUTO_CHECKPOINT]` via getRawDb. */
  readGate?: () => boolean;
  /** `git status --porcelain` of the worktree; default shells out via execCmd. */
  getPorcelain?: (worktreePath: string) => Promise<string>;
  /** The git-ops checkpoint creator; default is the live `createCheckpoint`. */
  createCheckpoint?: typeof createCheckpointLive;
  /** Clock injection for the min-interval test. */
  now?: () => number;
}

/** Default KV-gate reader: `kv[KV_AUTO_CHECKPOINT] === '1'`, default OFF. */
function readGateLive(): boolean {
  try {
    const row = getRawDbLive()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KV_AUTO_CHECKPOINT) as { value?: string } | undefined;
    return row?.value === '1';
  } catch {
    return false;
  }
}

/** Default change-check: porcelain status of the worktree (empty = clean). */
async function getPorcelainLive(worktreePath: string): Promise<string> {
  const res = await execCmd('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    timeoutMs: 8_000,
  });
  // A non-zero exit (not a git repo, etc.) yields whatever git printed; the
  // caller treats a non-empty string as "dirty" and an empty string as "clean".
  return res.stdout;
}

/**
 * Create a `kind: 'auto'` pre-dispatch checkpoint for `sessionId`'s worktree,
 * subject to the gate / change-check / min-interval guards. Fully fail-open:
 * resolves (never rejects) on every path, including internal errors.
 */
export async function maybeAutoCheckpoint(args: MaybeAutoCheckpointArgs): Promise<void> {
  const {
    sessionId,
    worktreePath,
    getDb = getDbLive,
    readGate = readGateLive,
    getPorcelain = getPorcelainLive,
    createCheckpoint = createCheckpointLive,
    now = Date.now,
  } = args;

  try {
    // 0) Cheap guards first — no worktree (plain workspace) means nothing to
    //    checkpoint, and the feature must be explicitly enabled.
    if (!worktreePath) return;
    if (!readGate()) return;

    // 1) Min-interval guard: skip if this session got an 'auto' checkpoint very
    //    recently (rapid re-dispatch / resume-then-prompt). Read the most recent
    //    'auto' row for this session and compare timestamps.
    const lastAuto = getDb()
      .select({ createdAt: sessionCheckpoints.createdAt })
      .from(sessionCheckpoints)
      .where(
        and(
          eq(sessionCheckpoints.sessionId, sessionId),
          eq(sessionCheckpoints.kind, 'auto'),
        ),
      )
      .orderBy(desc(sessionCheckpoints.createdAt))
      .get();
    if (lastAuto && now() - lastAuto.createdAt < MIN_INTERVAL_MS) return;

    // 2) Change-check: skip a clean tree (no point savepointing an unchanged
    //    worktree; --allow-empty would otherwise spam one commit per dispatch).
    const porcelain = await getPorcelain(worktreePath);
    if (porcelain.trim().length === 0) return;

    // 3) Take the checkpoint commit. createCheckpoint is itself fail-soft (it
    //    returns {ok:false} rather than throwing), so a failure here just
    //    means no row is recorded.
    const res = await createCheckpoint(worktreePath, AUTO_CHECKPOINT_LABEL);
    if (!res.ok || !res.sha) return;

    // 4) Record the row (mirror checkpoint-controller's insert shape, kind:'auto').
    getDb()
      .insert(sessionCheckpoints)
      .values({
        id: randomUUID(),
        sessionId,
        sha: res.sha,
        label: AUTO_CHECKPOINT_LABEL,
        kind: 'auto',
        createdAt: now(),
      })
      .run();
  } catch {
    // FAIL-OPEN — a checkpoint is a convenience, never a precondition. Any
    // failure (DB locked, git timeout, schema drift) degrades to a silent
    // no-op so the dispatch always proceeds.
  }
}
