# Packet 10 — Cross-machine session sync (opt-in, e2ee, git-backed)

> **Effort**: L (~4-6d). **Tier**: v1.3 feature. **Delegate**: Sonnet (data layer + crypto).
> **Blocks**: nothing. **Blocked by**: nothing.

## Problem

Users with multiple machines (work desktop + travel laptop) want to continue Sigma conversations + see the same agent_sessions history. Today: zero sync. Each machine has its own SQLite DB.

`docs/03-plan/v1.2.8-session-capture-rewrite.md` flagged this in "What's NOT in this scope", effort L.

## Design constraints

1. **User-owned storage**: NO SigmaLink backend. The user supplies a git remote (their GitHub account, self-hosted Gitea, etc).
2. **End-to-end encrypted**: SigmaLink at rest contains conversation text + commands + AI outputs that may contain secrets. Sync MUST encrypt with a key only the user knows. Use `age` (modern, audited, no PKI ceremony).
3. **Conflict-free or fail-safe**: if both machines edit at once, neither edit is silently lost.
4. **Opt-in**: default off. Settings → Sync → "Enable cross-machine sync" with a one-screen setup wizard.
5. **Append-only on remote**: NO `git push --force`. Conflicts surface in a "review and merge" UX.

## High-level approach

```
                ┌─────────────────────────┐
                │ User-owned git remote   │
                │ (encrypted blobs)       │
                └────────▲────────────────┘
                         │
                  e2ee via age
                         │
        ┌────────────────┼────────────────┐
        │                                 │
   ┌────────┐                        ┌────────┐
   │ Mac A  │  ◀── identical key ──▶ │ Mac B  │
   │ SQLite │                        │ SQLite │
   └────────┘                        └────────┘
```

### Sync unit: row-level CRDT

Each row in synced tables gets a CRDT clock: `(machine_id, lamport_ts, row_hash)`. On sync:

1. **Push (every 30s when enabled + dirty)**: scan dirty rows since last push, encrypt with user's age key, push to a `sync/blobs/<lamport_ts>-<machine_id>.age` file in the git remote.
2. **Pull (every 30s when enabled)**: `git fetch`. Decrypt new blobs. Apply rows to local DB using last-write-wins per row (highest lamport_ts wins; tie-broken by machine_id alphabetical).
3. **Conflict (rare)**: if local has a newer lamport_ts than the pulled row but the pulled row also exists locally with an older ts, that's a conflict — log to `sync_conflicts` table; UI shows both versions; user picks.

### Synced tables

| Table | Sync? | Reason |
|---|---|---|
| `kv` | NO | Local-only preferences (UI state). User would NOT want their cross-machine UI state synced. |
| `workspaces` | YES | Same workspace name + repo path on multiple machines is common. |
| `agent_sessions` | YES | Core value: see pane history across machines. |
| `swarms` | YES | Same reason. |
| `assistant_conversations` | YES | Headline use case. |
| `assistant_messages` | YES | Same. |
| `sigma_pane_events` | YES | Carry sigma's pane observation history. |
| `notifications` | NO | Per-machine context. |
| `skills` | NO | Local install state. |
| `memory` | YES | Sigma's vector memory — high value to sync. |
| `review` | NO | Per-machine debugging output. |
| `tasks` | YES | Cross-machine TODOs. |

## Schema additions

```sql
-- migration 0018_sync_metadata.sql (NEW)
CREATE TABLE IF NOT EXISTS sync_state (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  lamport_ts INTEGER NOT NULL,
  row_hash TEXT NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0,    -- 1 = needs push
  last_pushed_at INTEGER,
  PRIMARY KEY (table_name, row_id)
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,                  -- ulid
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  local_ts INTEGER NOT NULL,
  remote_ts INTEGER NOT NULL,
  remote_machine_id TEXT NOT NULL,
  local_row TEXT NOT NULL,              -- JSON snapshot
  remote_row TEXT NOT NULL,             -- JSON snapshot
  resolved INTEGER NOT NULL DEFAULT 0,
  resolution TEXT,                       -- 'local' | 'remote' | 'manual'
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
```

A `machine_id` is generated once at app boot (`crypto.randomUUID()` stored in `kv['app.machineId']`).

## Encryption layer

```typescript
// app/src/main/core/sync/crypto.ts (NEW)
import { age } from '@codemirror/age-encryption';  // or vendored age-rust binding
import fs from 'node:fs';

export async function encryptBlob(plaintext: Buffer, recipientKey: string): Promise<Buffer> {
  return age.encrypt(plaintext, { recipients: [recipientKey] });
}

export async function decryptBlob(ciphertext: Buffer, identityKey: string): Promise<Buffer> {
  return age.decrypt(ciphertext, { identities: [identityKey] });
}
```

**Key management UX**:
- Setup wizard generates an age keypair via `age-keygen`
- User MUST write down the recovery phrase (32 bytes → bip39-style mnemonic)
- Key stored in OS keychain (`keytar` dep, already present? — check) under service `sigma.sync.key`
- Public key stored in `kv['sync.publicKey']` (visible)
- Private key NEVER leaves keychain; sync engine asks keychain on each push/pull

## Sync engine

```typescript
// app/src/main/core/sync/engine.ts (NEW)
import simpleGit from 'simple-git';  // dep
import { encryptBlob, decryptBlob } from './crypto';
import { getDb, getRawDb } from '../db/client';

interface SyncConfig {
  enabled: boolean;
  remoteUrl: string;       // user-supplied
  branchName: string;       // default 'main'
  machineId: string;        // from kv
  publicKey: string;        // from kv
  intervalMs: number;       // default 30000
}

export class SyncEngine {
  private timer: NodeJS.Timeout | null = null;
  private git: ReturnType<typeof simpleGit>;
  private repoDir: string;  // ~/.sigma/sync-repo/

  constructor(private config: SyncConfig) {
    this.repoDir = path.join(os.homedir(), '.sigma', 'sync-repo');
    this.git = simpleGit(this.repoDir);
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.repoDir)) {
      fs.mkdirSync(this.repoDir, { recursive: true });
      await this.git.clone(this.config.remoteUrl, '.');
    }
  }

  async push(): Promise<{ pushed: number }> {
    const dirtyRows = getDirtyRows();
    let pushed = 0;
    for (const row of dirtyRows) {
      const plaintext = Buffer.from(JSON.stringify(row), 'utf8');
      const ciphertext = await encryptBlob(plaintext, this.config.publicKey);
      const filename = `sync/blobs/${row.lamport_ts}-${this.config.machineId}.age`;
      fs.writeFileSync(path.join(this.repoDir, filename), ciphertext);
      pushed++;
    }
    if (pushed > 0) {
      await this.git.add('sync/blobs/*');
      await this.git.commit(`sync: ${pushed} rows from ${this.config.machineId}`);
      await this.git.push();
      markRowsClean(dirtyRows);
    }
    return { pushed };
  }

  async pull(): Promise<{ applied: number; conflicts: number }> {
    await this.git.fetch();
    await this.git.pull();
    const newBlobs = findNewBlobs(this.repoDir);
    let applied = 0;
    let conflicts = 0;
    const privateKey = await getKeychainSecret('sigma.sync.key');
    for (const blob of newBlobs) {
      const ciphertext = fs.readFileSync(blob);
      const plaintext = await decryptBlob(ciphertext, privateKey);
      const row = JSON.parse(plaintext.toString('utf8'));
      const result = applyRow(row);
      if (result === 'applied') applied++;
      else if (result === 'conflict') conflicts++;
    }
    return { applied, conflicts };
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.push().catch(console.error);
      void this.pull().catch(console.error);
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
```

## UX flow

### First-time setup wizard (5 steps)

1. **Welcome**: "Cross-machine sync keeps your conversations + agent history in sync between your devices. Sync data is end-to-end encrypted; SigmaLink never sees it."
2. **Remote**: Pick a git remote. Help text: "We recommend a private GitHub repo named `sigma-sync`. Other options: Gitea, GitLab self-hosted, raw SSH."
3. **Auth**: SSH key reuse OR token paste. Test connection.
4. **Encryption key**: SigmaLink generates an age keypair. Shows the recovery mnemonic. Forces user to type it back to confirm save.
5. **Done**: Push test commit. If successful, sync starts.

### Ongoing UI

- Settings → Sync tab:
  - Status: "Synced 2m ago" / "Pushing..." / "Conflict needs review"
  - Last push: timestamp + row count
  - Last pull: timestamp + row count
  - Conflicts: link to conflict review screen
  - Disable button (data stays local; remote untouched)

### Conflict review screen

- Side-by-side diff: local row vs remote row
- "Keep local" / "Keep remote" / "Merge manually (advanced)"
- Confirmed picks update `sync_conflicts.resolution` + write the chosen row back to the source table

## Files to touch

### Main process
- `app/src/main/core/db/migrations/0018_sync_metadata.ts` — NEW
- `app/src/main/core/db/schema.ts` — register sync tables
- `app/src/main/core/db/migrate.ts` — register migration
- `app/src/main/core/sync/crypto.ts` — NEW
- `app/src/main/core/sync/engine.ts` — NEW
- `app/src/main/core/sync/dirty-tracker.ts` — NEW (DB triggers OR app-level dispatch hooks)
- `app/src/main/core/sync/conflict-resolver.ts` — NEW
- `app/src/main/core/sync/keychain.ts` — NEW (wraps keytar)
- `app/src/main/rpc-router.ts` — register `sync.enable`, `sync.disable`, `sync.status`, `sync.listConflicts`, `sync.resolveConflict`
- Tests for every file above (vitest)

### Renderer
- `app/src/renderer/features/settings/SyncTab.tsx` — NEW (status + disable)
- `app/src/renderer/features/sync-setup/SetupWizard.tsx` — NEW (5-step flow)
- `app/src/renderer/features/sync-setup/ConflictReview.tsx` — NEW
- Renderer tests for each

### Shared / Deps
- `app/src/shared/types.ts` — `SyncConfig`, `SyncStatus`, `SyncConflict`
- `app/src/shared/router-shape.ts` — sync controller shape
- `app/package.json` — add `simple-git`, `age-encryption`, ensure `keytar` is present

## Verification

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false
pnpm exec vitest run src/main/core/sync/       # NEW (target 30+ tests)
pnpm exec eslint .
```

Manual smoke (TWO machines, or a VM + host):
1. On Machine A: set up sync with a private GitHub repo. Confirm first push.
2. On Machine B: install SigmaLink, set up sync with the SAME repo + same recovery mnemonic. Confirm first pull. Conversations from A appear.
3. On Machine A: start a new Sigma conversation. Wait 30s. On Machine B: confirm the conversation appears.
4. Concurrent edit: on A and B simultaneously edit the SAME conversation. Wait for sync. Confirm conflict surfaces in Sync tab → review screen.
5. Resolve conflict → confirm both machines converge on the chosen version.
6. Disable sync on B → confirm local data stays. Re-enable → confirm it picks up where it left off.

## Risk

- **age key loss = data loss**. If user loses the recovery mnemonic, sync data is permanently undecryptable. Setup wizard MUST hammer this point.
- **Network churn**: 30s interval × N machines × M users on the same remote could create push contention. Mitigate with `git pull --rebase` before push. Also: if push fails with "remote has new commits", do a pull + retry once.
- **Schema evolution**: when SigmaLink ships migration 0019/0020, machines on different versions sync. Solve via: each sync blob includes the schema_version + a per-table dispatch table that knows how to upgrade an old-version row to the current schema. If the schema is too far ahead, queue the row in `sync_pending_upgrade` until the local app catches up.
- **Privacy footgun**: a workspace's `rootPath` might leak ("D:/Users/jdoe/SuperSecretClient/") even though it's e2ee. Document that `rootPath` is part of the synced payload. Offer a "anonymise paths" toggle that replaces home prefixes with `~`.

## Reporting back

PR title: `feat(v1.4.7): cross-machine session sync — opt-in, e2ee via age, git-backed`. Include the two-machine smoke recording + the setup wizard screenshots.

This is a HEADLINE feature for v1.4.7. Ship with a blog-post-quality user-facing doc at `docs/09-release/cross-machine-sync.md`.
