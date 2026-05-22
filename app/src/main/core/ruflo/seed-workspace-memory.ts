// Seed a workspace-local .claude-flow store with one "project-context"
// memory derived from the workspace-root CLAUDE.md (or README.md fallback).
// This is intentionally best-effort: failures are logged once and never
// propagate to the caller. Cross-project bleed is forbidden — only files
// directly inside workspaceRoot are read.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
 */
function defaultRunStore(args: RunStoreArgs): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const child = spawn(
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
      child.on('error', () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Seed the workspace-local .claude-flow store with one "project-context"
 * memory in the "patterns" namespace.
 *
 * - Reads CLAUDE.md; falls back to README.md; no-ops if neither exists.
 * - Takes the first MAX_VALUE_CHARS characters as the value.
 * - Writes to <workspaceRoot>/.claude-flow (CLAUDE_FLOW_DIR), never to
 *   global/app stores.
 * - Is entirely best-effort: never throws, never rejects.
 */
export async function seedWorkspaceMemory(
  input: { workspaceRoot: string } & SeedDeps,
): Promise<void> {
  const { workspaceRoot, runStore = defaultRunStore } = input;
  try {
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
