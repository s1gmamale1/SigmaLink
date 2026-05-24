// C-9 — Idempotent guardrail block writer for per-worktree CLAUDE.md.
//
// Mirrors scope-block.ts writeScopeBlock exactly but uses the
// <!-- sigmalink-guardrails:start/end --> markers and injects
// buildGuardrailMarkdown(enabledIds) as the body.

import fs from 'node:fs';
import path from 'node:path';
import { buildGuardrailMarkdown } from '@/shared/guardrails';

const GUARDRAIL_BLOCK_START = '<!-- sigmalink-guardrails:start -->';
const GUARDRAIL_BLOCK_END = '<!-- sigmalink-guardrails:end -->';

function buildGuardrailBlockContent(enabledIds: string[]): string {
  const body = buildGuardrailMarkdown(enabledIds);
  const lines: string[] = [GUARDRAIL_BLOCK_START];
  if (body) {
    lines.push('', body, '');
  }
  lines.push(GUARDRAIL_BLOCK_END);
  return lines.join('\n');
}

function writeFileAtomic(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * Write (or update) the guardrail block in `<worktreePath>/CLAUDE.md`.
 *
 * - Idempotent: calling twice with the same ids produces one block.
 * - Preserves prose outside the markers.
 * - When `enabledIds` is empty, writes an empty/collapsed block (markers present
 *   but no inner content) — this is intentional: it signals the block was
 *   evaluated with no active guardrails rather than being absent entirely.
 */
export async function writeGuardrailBlock(
  worktreePath: string,
  enabledIds: string[],
): Promise<void> {
  const target = path.join(worktreePath, 'CLAUDE.md');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

  const managedBlock = buildGuardrailBlockContent(enabledIds);

  const startIdx = existing.indexOf(GUARDRAIL_BLOCK_START);
  const endIdx = existing.indexOf(GUARDRAIL_BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Block already present — replace it.
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + GUARDRAIL_BLOCK_END.length);
    const next = before + managedBlock + after;
    if (next === existing) return; // already identical — skip write
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, next);
    return;
  }

  // No markers present — append the block.
  const separator = existing.length > 0 && !existing.endsWith('\n\n') ? '\n\n' : '';
  const trailingNewline = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const next =
    existing.length === 0
      ? managedBlock + '\n'
      : existing + trailingNewline + separator + managedBlock + '\n';
  if (next === existing) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, next);
}
