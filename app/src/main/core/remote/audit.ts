// Append-only audit log for R-1 Jorvis Remote.
//
// Persists AuditEntry objects as newline-delimited JSON (JSONL) to a file.
// The file is capped at `maxEntries` lines by rewriting when it grows too
// large (default: 10 000 entries).  All operations are synchronous so callers
// can call append() inside both async and sync code without ordering concerns.
//
// Usage:
//   const log = createAuditLog({ dir: '/path/to/logs', now: Date.now });
//   log.append({ ts: Date.now(), kind: 'inbound', chatId: 123, detail: 'ok' });
//   const recent = log.tail(20);

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Public types ────────────────────────────────────────────────────────────

// Audit event vocabulary. The safety layer emits the short kinds
// ('inbound'/'drop'/'lock'/'unlock'); the bridge supervisor emits the richer
// operational kinds (lifecycle, dispatch, confirm outcomes, relay/reply
// errors). The union is the superset so every audited event is type-checked.
export type AuditKind =
  // safety layer
  | 'inbound'
  | 'drop'
  | 'tool'
  | 'confirm'
  | 'lock'
  | 'unlock'
  // bridge supervisor
  | 'start'
  | 'crash'
  | 'inbound-dropped'
  | 'dispatch'
  | 'dispatch-skipped'
  | 'dispatch-error'
  | 'confirm-error'
  | 'confirm-timeout'
  | 'confirm-approved'
  | 'confirm-denied'
  | 'relay-error'
  | 'reply-error';

export interface AuditEntry {
  ts: number;
  kind: AuditKind;
  chatId?: number;
  detail: string;
}

export interface AuditLog {
  /** Synchronously append one entry to the JSONL file. */
  append(entry: AuditEntry): void;
  /** Return the last `n` entries (most-recent last). */
  tail(n: number): AuditEntry[];
}

export interface AuditLogDeps {
  /** Directory where the audit.jsonl file is kept. Must exist. */
  dir: string;
  /** Injectable clock so tests don't need to wait for real time. */
  now: () => number;
  /** Maximum lines kept before the file is compacted (default: 10 000). */
  maxEntries?: number;
  /** Override filename (default: 'audit.jsonl'). */
  filename?: string;
}

// ─── Implementation ──────────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_FILENAME = 'audit.jsonl';

export function createAuditLog(deps: AuditLogDeps): AuditLog {
  const {
    dir,
    now,
    maxEntries = DEFAULT_MAX_ENTRIES,
    filename = DEFAULT_FILENAME,
  } = deps;

  // Ensure the target directory exists so the first append() can't ENOENT.
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, filename);

  // ── Internal helpers ───────────────────────────────────────────────────────

  /** Read all current lines from the file. Returns [] if the file is absent. */
  function readLines(): string[] {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return raw.split('\n').filter((l) => l.trim().length > 0);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Overwrite the file with the given lines (each is already a JSON string). */
  function writeLines(lines: string[]): void {
    const content = lines.length > 0 ? lines.join('\n') + '\n' : '';
    fs.writeFileSync(filePath, content, 'utf8');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function append(entry: AuditEntry): void {
    // Always stamp ts from the injected clock — this is the authoritative
    // append-time timestamp regardless of what the caller passes.
    const stamped: AuditEntry = { ...entry, ts: now() };
    const line = JSON.stringify(stamped);

    let lines = readLines();
    lines.push(line);

    // Cap: keep the most-recent `maxEntries` lines.
    if (lines.length > maxEntries) {
      lines = lines.slice(lines.length - maxEntries);
    }

    writeLines(lines);
  }

  function tail(n: number): AuditEntry[] {
    if (n <= 0) return [];
    const lines = readLines();
    const slice = lines.slice(Math.max(0, lines.length - n));
    const entries: AuditEntry[] = [];
    for (const line of slice) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip corrupt lines rather than crashing.
      }
    }
    return entries;
  }

  return { append, tail };
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
