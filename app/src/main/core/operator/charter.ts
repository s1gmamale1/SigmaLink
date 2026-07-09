// P2 Task 4 — pure, DI'd loader for Jorvis's operator persona charter.
//
// The charter text is vendored from Sigma-Profile's "jorvis" render target
// (see scripts/sync-jorvis-charter.cjs) into charter-default.ts as an
// inlined string constant (P2 design decision D2) — no runtime file
// resolution, no packaging changes: esbuild inlines the bundled default
// straight into the build. An operator can override it with a KV-configured
// file path (`jorvis.charter.path`, seeded '' by migration 0041); a
// missing/unreadable override file fails soft back to the bundled default
// rather than breaking a wake (D3 — charter is a reversible prompt-surface
// change, not a safety gate).
//
// D6 — approved self-amendments are appended AFTER the charter at
// prompt-build time (system-prompt.ts, P2 Task 5), never edited into it.

import fs from 'node:fs';
import nodePath from 'node:path';
import { JORVIS_CHARTER_DEFAULT } from './charter-default';
import type { JorvisAmendment } from '../../../shared/types';

const KV_CHARTER_PATH = 'jorvis.charter.path';

// The KV override value is a file path flowing into a read sink whose output
// lands verbatim in every turn's system prompt (and can relay onward, e.g.
// over Telegram). KV writers are operator-side surfaces (settings RPC, main
// process) — no assistant tool exposes arbitrary kvSet — but gate the sink
// anyway: absolute path only, prose extensions only, size-capped. Anything
// else fails soft to the bundled charter, same as an unreadable file.
const CHARTER_EXTENSIONS = new Set(['.md', '.txt']);
export const MAX_CHARTER_CHARS = 262_144; // 256 KiB of text — far above any real charter

export interface LoadJorvisCharterDeps {
  kvGet: (key: string) => string | null;
  /** DI seam for tests; defaults to fs.readFileSync(path, 'utf8'). */
  readFile?: (path: string) => string;
}

export function loadJorvisCharter(deps: LoadJorvisCharterDeps): string {
  const path = deps.kvGet(KV_CHARTER_PATH);
  if (!path) return JORVIS_CHARTER_DEFAULT;
  if (!nodePath.isAbsolute(path)) return JORVIS_CHARTER_DEFAULT;
  if (!CHARTER_EXTENSIONS.has(nodePath.extname(path).toLowerCase())) return JORVIS_CHARTER_DEFAULT;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  try {
    const content = readFile(path);
    if (content.length > MAX_CHARTER_CHARS) return JORVIS_CHARTER_DEFAULT;
    return content;
  } catch {
    return JORVIS_CHARTER_DEFAULT;
  }
}

export function appendApprovedAmendments(charter: string, amendments: JorvisAmendment[]): string {
  const approved = amendments.filter((a) => a.status === 'approved');
  if (approved.length === 0) return charter;
  const lines = approved.map((a) => `- ${a.text}`);
  return `${charter}\n\n## Approved amendments (operator-signed)\n${lines.join('\n')}`;
}
