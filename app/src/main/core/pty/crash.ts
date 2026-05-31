// Shared PTY-exit crash classification.
//
// BUG-1 — both the workspace launcher (`workspaces/launcher.ts`) and the swarm
// spawn helper (`swarms/factory-spawn.ts`) must classify a PTY exit identically
// so a swarm CLI that crashes (non-zero code or killed by a signal) is recorded
// as 'error', not silently 'exited'/'done'. The classifier used to live in
// launcher.ts, but importing it into factory-spawn.ts would close a runtime
// import cycle (launcher → rpc-router → factory → factory-spawn → launcher).
// Hoisting it into this dependency-free leaf module lets both call sites share
// one definition without a cycle.

/**
 * Classify a PTY exit as a crash for the `pty:error` IPC event and for the
 * `agent_sessions` / `swarm_agents` status write.
 *
 * Crash = earlyDeath (process died within the launch grace window, computed by
 * the caller as `Date.now() - startedMs < 1500`) OR a non-zero exit code OR a
 * non-zero signal. A clean exit (code 0, signal 0/null/undefined, not
 * earlyDeath) → NOT a crash.
 */
export function isPtyCrash(earlyDeath: boolean, exitCode: number, signal?: number | null): boolean {
  return earlyDeath || exitCode !== 0 || (signal != null && signal !== 0);
}
