// Seed a workspace-local .claude-flow store with one "project-context"
// memory derived from the workspace-root CLAUDE.md (or README.md fallback).
// This is intentionally best-effort: failures are logged once and never
// propagate to the caller. Cross-project bleed is forbidden — only files
// directly inside workspaceRoot are read.

import fs from 'node:fs';
import path from 'node:path';
import { spawnExecutable } from '../util/spawn-cross-platform';
import { commandOnPath } from './http-daemon-supervisor';

const MAX_VALUE_CHARS = 2000;

export interface RunStoreArgs {
  claudeFlowDir: string;
  key: string;
  namespace: string;
  value: string;
}

export interface SeedDeps {
  /**
   * Injectable for testing. When omitted, the default implementation spawns:
   *   npx -y @claude-flow/cli@latest memory store --namespace patterns
   *     --key project-context --value <value>
   * with CLAUDE_FLOW_DIR set to claudeFlowDir. Resolves on close regardless
   * of exit code (best-effort). Never rejects.
   */
  runStore?: (args: RunStoreArgs) => Promise<void>;
  /**
   * Injectable availability gate. When omitted, defaults to
   * `commandOnPath('ruflo')` — the SAME PATH probe the HTTP daemon supervisor
   * uses for its tier-2 resolution (platform-agnostic, no process.platform
   * branches). When this returns false, seeding is SKIPPED entirely.
   *
   * Why: the default `runStore` spawns `npx -y @claude-flow/cli@latest …`,
   * which AUTO-DOWNLOADS the package from the network on a machine that does
   * not have ruflo installed. seedWorkspaceMemory is fired best-effort from
   * factory.ts during the awaited `workspaces.open`, so on a no-ruflo CI runner
   * that added concurrent network downloads → contention. Best-effort seeding
   * must never trigger a network download during workspace open.
   */
  isRufloAvailable?: () => boolean;
}

/**
 * Read the first candidate file from workspaceRoot only.
 * Returns null if neither CLAUDE.md nor README.md can be read as a file.
 * Never reads outside workspaceRoot. Never throws.
 */
function readContextFile(workspaceRoot: string): string | null {
  const candidates = ['CLAUDE.md', 'README.md'];
  for (const name of candidates) {
    const filePath = path.join(workspaceRoot, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      // not found or unreadable — try next
    }
  }
  return null;
}

/**
 * Default runStore: spawns the claude-flow CLI with CLAUDE_FLOW_DIR set to
 * the workspace-local .claude-flow directory. Stdio is ignored (fire-and-
 * forget). Resolves on process close regardless of exit code. Never rejects.
 *
 * Routed through `spawnExecutable` so bare `npx` resolves to `npx.cmd` on
 * win32 (a raw `spawn('npx', …)` CreateProcessW-ENOENTs there). NOTE: the
 * `--value` payload is multi-line markdown; on win32 the cmd wrap flattens
 * newlines to spaces (Task-1 `cmdEscapeArg` sanitization) — degraded content,
 * never command injection.
 */
function defaultRunStore(args: RunStoreArgs): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const child = spawnExecutable(
        'npx',
        [
          '-y',
          '@claude-flow/cli@latest',
          'memory',
          'store',
          '--namespace',
          args.namespace,
          '--key',
          args.key,
          '--value',
          args.value,
        ],
        {
          env: { ...process.env, CLAUDE_FLOW_DIR: args.claudeFlowDir },
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.on('close', () => resolve());
      child.on('error', (err: unknown) => {
        // Best-effort seeding must never reject — but an invisible ENOENT
        // (bare `npx` on win32 pre-fix) cost us this whole feature silently.
        console.warn(
          `[ruflo-seed] memory store spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/**
 * Seed the workspace-local .claude-flow store with one "project-context"
 * memory in the "patterns" namespace.
 *
 * - SKIPS entirely (no spawn, no network) when ruflo is not installed — the
 *   default `runStore` would otherwise `npx -y` auto-download the package
 *   during the awaited workspace open (see SeedDeps.isRufloAvailable).
 * - Reads CLAUDE.md; falls back to README.md; no-ops if neither exists.
 * - Takes the first MAX_VALUE_CHARS characters as the value.
 * - Writes to <workspaceRoot>/.claude-flow (CLAUDE_FLOW_DIR), never to
 *   global/app stores.
 * - Is entirely best-effort: never throws, never rejects.
 */
export async function seedWorkspaceMemory(
  input: { workspaceRoot: string } & SeedDeps,
): Promise<void> {
  const {
    workspaceRoot,
    runStore = defaultRunStore,
    isRufloAvailable = () => commandOnPath('ruflo'),
  } = input;
  try {
    // Best-effort seeding must never trigger a network download during open:
    // when ruflo is not installed, skip without spawning anything.
    if (!isRufloAvailable()) {
      return;
    }
    const raw = readContextFile(workspaceRoot);
    if (raw === null) {
      // No source file found — no-op.
      return;
    }
    const value = raw.slice(0, MAX_VALUE_CHARS);
    const claudeFlowDir = path.join(workspaceRoot, '.claude-flow');
    await runStore({ claudeFlowDir, key: 'project-context', namespace: 'patterns', value });
  } catch (err) {
    console.warn(
      `[ruflo] seedWorkspaceMemory: unexpected error for ${workspaceRoot}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
