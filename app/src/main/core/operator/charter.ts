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
import { JORVIS_CHARTER_DEFAULT } from './charter-default';
import type { JorvisAmendment } from '../../../shared/types';

const KV_CHARTER_PATH = 'jorvis.charter.path';

export interface LoadJorvisCharterDeps {
  kvGet: (key: string) => string | null;
  /** DI seam for tests; defaults to fs.readFileSync(path, 'utf8'). */
  readFile?: (path: string) => string;
}

export function loadJorvisCharter(deps: LoadJorvisCharterDeps): string {
  const path = deps.kvGet(KV_CHARTER_PATH);
  if (!path) return JORVIS_CHARTER_DEFAULT;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  try {
    return readFile(path);
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
