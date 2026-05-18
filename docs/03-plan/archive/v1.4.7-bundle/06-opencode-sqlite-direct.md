# Packet 06 — OpenCode SQLite direct read (skip subprocess)

> **Effort**: S (~4hr). **Tier**: v1.3 feature. **Delegate**: Sonnet (data layer).
> **Blocks**: #07 (provider auto-install) — both touch provider-detect layer.
> **Blocked by**: nothing.

## Problem

OpenCode stores its session metadata in a SQLite database. Currently SigmaLink's session disk-scanner shells out to `opencode session list --json` to enumerate OpenCode sessions for the picker. The subprocess approach:
- Adds ~200-400ms per workspace open (cold subprocess start)
- Fails silently when opencode CLI isn't in PATH (the registry has `command: 'opencode'`)
- Requires opencode CLI version compatibility (`session list --json` is only present in opencode ≥0.x.y; older versions silently return non-JSON output)

`docs/03-plan/v1.2.8-session-capture-rewrite.md` flagged this as "What's NOT in this scope" with a "S" effort estimate.

## Fix approach

Read the OpenCode SQLite database directly using `better-sqlite3` in read-only mode. OpenCode session storage:

| OS | Path |
|---|---|
| macOS | `~/.local/share/opencode/sessions.db` (XDG default) OR `~/Library/Application Support/opencode/sessions.db` |
| Linux | `~/.local/share/opencode/sessions.db` |
| Windows | `%LOCALAPPDATA%/opencode/sessions.db` |

Schema (verified empirically on opencode CLI v0.x at plan time):
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_path TEXT,
  created_at INTEGER,
  last_used_at INTEGER,
  model TEXT,
  title TEXT
);
```

## Implementation

```typescript
// app/src/main/core/opencode/sqlite-reader.ts (NEW)
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function resolveOpencodeDbPath(): string | null {
  const candidates = [
    process.env.OPENCODE_HOME && path.join(process.env.OPENCODE_HOME, 'sessions.db'),
    process.platform === 'darwin' && path.join(os.homedir(), 'Library', 'Application Support', 'opencode', 'sessions.db'),
    path.join(os.homedir(), '.local', 'share', 'opencode', 'sessions.db'),
    process.platform === 'win32' && path.join(process.env.LOCALAPPDATA ?? '', 'opencode', 'sessions.db'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface OpencodeSessionRow {
  id: string;
  workspacePath: string;
  createdAt: number;
  lastUsedAt: number;
  model: string | null;
  title: string | null;
}

export function listOpencodeSessionsForCwd(cwd: string, maxCount = 20): OpencodeSessionRow[] {
  const dbPath = resolveOpencodeDbPath();
  if (!dbPath) return [];

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // Tolerate unknown columns / schema drift — SELECT only what we need.
    const rows = db.prepare(`
      SELECT id, workspace_path AS workspacePath, created_at AS createdAt,
             last_used_at AS lastUsedAt, model, title
      FROM sessions
      WHERE workspace_path = ?
      ORDER BY last_used_at DESC
      LIMIT ?
    `).all(cwd, maxCount) as OpencodeSessionRow[];
    return rows;
  } catch {
    // Schema mismatch, missing table, locked DB — fall back to empty list.
    // The subprocess path remains as the safety net during transition.
    return [];
  } finally {
    db?.close();
  }
}
```

Wire into the disk-scanner at `app/src/main/core/pty/session-disk-scanner.ts`:

```typescript
// session-disk-scanner.ts — replace the opencode subprocess branch
case 'opencode': {
  const rows = listOpencodeSessionsForCwd(cwd, opts?.maxCount);
  return rows.map((r) => ({
    sessionId: r.id,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    title: r.title ?? undefined,
  }));
}
```

## Tests

```typescript
// app/src/main/core/opencode/sqlite-reader.test.ts (NEW)
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { listOpencodeSessionsForCwd } from './sqlite-reader';

describe('listOpencodeSessionsForCwd', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sqlite-test-'));
    dbPath = path.join(tempDir, 'sessions.db');
    process.env.OPENCODE_HOME = tempDir;
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_path TEXT,
        created_at INTEGER,
        last_used_at INTEGER,
        model TEXT,
        title TEXT
      );
      INSERT INTO sessions VALUES ('a', '/repo', 1000, 2000, 'qwen', 'first');
      INSERT INTO sessions VALUES ('b', '/repo', 1500, 1800, 'qwen', 'second');
      INSERT INTO sessions VALUES ('c', '/other', 2000, 2000, 'qwen', 'unrelated');
    `);
    db.close();
  });

  it('returns sessions filtered by cwd, ordered by lastUsedAt DESC', () => {
    const rows = listOpencodeSessionsForCwd('/repo');
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe('a');  // lastUsedAt 2000 > 1800
    expect(rows[1].id).toBe('b');
  });

  it('returns empty list when DB is missing', () => {
    fs.unlinkSync(dbPath);
    expect(listOpencodeSessionsForCwd('/repo')).toEqual([]);
  });

  it('tolerates schema drift (unknown columns)', () => {
    const db = new Database(dbPath);
    db.exec(`ALTER TABLE sessions ADD COLUMN unknown_future_column TEXT`);
    db.close();
    const rows = listOpencodeSessionsForCwd('/repo');
    expect(rows.length).toBe(2);
  });
});
```

## Files to touch

- `app/src/main/core/opencode/sqlite-reader.ts` — NEW (≤120 LOC)
- `app/src/main/core/opencode/sqlite-reader.test.ts` — NEW (≤80 LOC)
- `app/src/main/core/pty/session-disk-scanner.ts` — wire in the new reader for `case 'opencode'`
- `app/src/main/core/pty/session-disk-scanner.test.ts` — update mock for the new path

## Verification gate

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false
pnpm exec vitest run src/main/core/opencode/  # NEW tests pass
pnpm exec vitest run src/main/core/pty/session-disk-scanner.test.ts  # baseline preserved
pnpm exec eslint .                              # 0 errors
```

Plus manual smoke: open a workspace with an opencode pane previously launched, confirm the session picker shows the prior opencode session within 100ms (was ~400ms via subprocess).

## Risk

- OpenCode schema might change between releases. The reader tolerates extra columns + missing tables (falls back to empty list). Subprocess remains as a fallback if the SQLite read returns empty AND the user has the CLI installed.
- DB might be locked if opencode is currently writing. SQLite's `readonly: true` opens shared-read locks; concurrent reads are fine. If we hit `SQLITE_BUSY`, fall back to subprocess.

## Reporting back

PR title: `feat(v1.4.7): OpenCode SQLite direct read — skip subprocess for session picker`. Include before/after timing benchmark (workspace open cold → first picker render).
