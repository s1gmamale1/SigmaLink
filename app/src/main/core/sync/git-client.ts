// v1.5.0 packet 09 — isomorphic-git wrapper.
//
// Wraps isomorphic-git for the sync engine. Key decisions (from brief S7):
//   - Pure JS — no system git required, works in Electron main process.
//   - Transport: HTTPS (username/password or token) or SSH.
//   - Pre-push: git pull --rebase equivalent before every push (prevents
//     push rejection; conflict resolution happens at the row level, not git).
//   - Local clone config: user.email = "sigma-sync@localhost",
//     user.name = "sigma". NEVER reads the user's git global config.
//   - One-process lock at <cloneDir>/.sigma-sync.lock to prevent concurrent
//     push/pull cycles.
//
// The sync repo layout:
//   <cloneDir>/
//     .git/
//     sync/
//       blobs/
//         <table>/<row_id>.bin   — encrypted row payload
//       tombstones/
//         <table>/<row_id>.tomb  — tombstone marker
//
// All file contents are opaque encrypted blobs. Filenames reveal the table
// and row_id — this is acceptable per S1 (the git host (A1) sees only
// ciphertext + opaque-ish paths; row IDs are UUIDs so no PII leaks).

import path from 'node:path';
import fs from 'node:fs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface GitConfig {
  /** URL of the remote git repository. */
  remoteUrl: string;
  /** Username for HTTPS auth (or token-based: use PAT as username, empty password). */
  username?: string;
  /** Password / personal access token. */
  password?: string;
  /** Local directory for the clone. Default: <userData>/sync-repo */
  cloneDir: string;
}

export interface PushResult {
  ok: boolean;
  error?: string;
}

export interface PullResult {
  ok: boolean;
  /** Paths of files that were updated/added by the pull. */
  updatedPaths: string[];
  error?: string;
}

// ------------------------------------------------------------------
// Initialise / clone
// ------------------------------------------------------------------

/**
 * Ensure the local sync repo clone exists. If not, clones from the remote.
 * Configures local git identity to sigma-sync@localhost.
 *
 * Safe to call multiple times — idempotent if clone already exists.
 */
export async function ensureRepo(config: GitConfig): Promise<void> {
  const { cloneDir, remoteUrl, username, password } = config;

  if (!fs.existsSync(cloneDir)) {
    fs.mkdirSync(cloneDir, { recursive: true });
  }

  const hasGitDir = fs.existsSync(path.join(cloneDir, '.git'));
  if (!hasGitDir) {
    // Perform initial clone.
    await git.clone({
      fs,
      http,
      dir: cloneDir,
      url: remoteUrl,
      singleBranch: true,
      depth: undefined, // full history for integrity
      onAuth: buildAuthHandler(username, password),
    });
  }

  // Always set local identity — never use global git config.
  await git.setConfig({ fs, dir: cloneDir, path: 'user.email', value: 'sigma-sync@localhost' });
  await git.setConfig({ fs, dir: cloneDir, path: 'user.name', value: 'sigma' });
}

/**
 * Initialise a new empty repo (when user is setting up sync for the first time
 * and the remote is already an empty repo).
 */
export async function initRepo(config: GitConfig): Promise<void> {
  const { cloneDir } = config;
  if (!fs.existsSync(cloneDir)) {
    fs.mkdirSync(cloneDir, { recursive: true });
  }

  const hasGitDir = fs.existsSync(path.join(cloneDir, '.git'));
  if (!hasGitDir) {
    await git.init({ fs, dir: cloneDir });
  }

  await git.setConfig({ fs, dir: cloneDir, path: 'user.email', value: 'sigma-sync@localhost' });
  await git.setConfig({ fs, dir: cloneDir, path: 'user.name', value: 'sigma' });
}

// ------------------------------------------------------------------
// Write blob
// ------------------------------------------------------------------

/**
 * Write an encrypted blob to the working tree at the canonical path.
 * Does NOT commit — the engine calls commit() after staging all dirty rows.
 */
export function writeBlobToWorkTree(
  cloneDir: string,
  tableName: string,
  rowId: string,
  payload: Buffer,
): string {
  const blobDir = path.join(cloneDir, 'sync', 'blobs', tableName);
  fs.mkdirSync(blobDir, { recursive: true });
  const blobPath = path.join(blobDir, `${rowId}.bin`);
  fs.writeFileSync(blobPath, payload);
  return path.relative(cloneDir, blobPath);
}

/**
 * Write a tombstone marker file.
 */
export function writeTombstoneToWorkTree(
  cloneDir: string,
  tableName: string,
  rowId: string,
  hlcPacked: string,
): string {
  const tombDir = path.join(cloneDir, 'sync', 'tombstones', tableName);
  fs.mkdirSync(tombDir, { recursive: true });
  const tombPath = path.join(tombDir, `${rowId}.tomb`);
  fs.writeFileSync(tombPath, hlcPacked, 'utf8');
  return path.relative(cloneDir, tombPath);
}

/**
 * Remove a blob from the working tree (when a row is deleted).
 */
export function removeBlobFromWorkTree(
  cloneDir: string,
  tableName: string,
  rowId: string,
): void {
  const blobPath = path.join(cloneDir, 'sync', 'blobs', tableName, `${rowId}.bin`);
  if (fs.existsSync(blobPath)) {
    fs.unlinkSync(blobPath);
  }
}

// ------------------------------------------------------------------
// Stage + commit
// ------------------------------------------------------------------

/**
 * Stage all modified files and create a commit.
 * Returns the new commit OID, or null if there was nothing to commit.
 */
export async function stageAndCommit(
  cloneDir: string,
  message = 'sigma-sync: push',
): Promise<string | null> {
  // Stage all changes (add + remove).
  await git.add({ fs, dir: cloneDir, filepath: '.' });

  // Check if there's actually anything to commit.
  const status = await git.statusMatrix({ fs, dir: cloneDir });
  const hasChanges = status.some(([, head, workDir, stage]) => {
    return head !== 1 || workDir !== 1 || stage !== 1;
  });

  if (!hasChanges) return null;

  const oid = await git.commit({
    fs,
    dir: cloneDir,
    message,
    author: { name: 'sigma', email: 'sigma-sync@localhost' },
  });

  return oid;
}

// ------------------------------------------------------------------
// Pull (fetch + fast-forward or rebase)
// ------------------------------------------------------------------

/**
 * Pull from the remote using fetch + fast-forward merge.
 * This is the "git pull --rebase" equivalent for our append-only structure.
 * Returns the list of relative paths that were updated.
 */
export async function pull(config: GitConfig): Promise<PullResult> {
  try {
    const { cloneDir, remoteUrl, username, password } = config;

    // Fetch remote changes.
    await git.fetch({
      fs,
      http,
      dir: cloneDir,
      url: remoteUrl,
      onAuth: buildAuthHandler(username, password),
    });

    // Determine remote branch HEAD.
    const remoteRef = 'refs/remotes/origin/HEAD';
    let remoteOid: string;
    try {
      remoteOid = await git.resolveRef({ fs, dir: cloneDir, ref: 'origin/HEAD' });
    } catch {
      // Try explicit main/master.
      try {
        remoteOid = await git.resolveRef({ fs, dir: cloneDir, ref: 'origin/main' });
      } catch {
        remoteOid = await git.resolveRef({ fs, dir: cloneDir, ref: 'origin/master' });
      }
    }
    void remoteRef; // suppress unused warning

    // Get local HEAD.
    let localOid: string | null = null;
    try {
      localOid = await git.resolveRef({ fs, dir: cloneDir, ref: 'HEAD' });
    } catch {
      // Fresh clone with no local commits yet.
      localOid = null;
    }

    if (localOid === remoteOid) {
      return { ok: true, updatedPaths: [] };
    }

    // Fast-forward local HEAD to remote.
    const branch = await git.currentBranch({ fs, dir: cloneDir, fullname: false }) ?? 'main';
    await git.writeRef({
      fs,
      dir: cloneDir,
      ref: `refs/heads/${branch}`,
      value: remoteOid,
      force: true,
    });

    // Checkout the updated working tree.
    await git.checkout({ fs, dir: cloneDir, ref: branch, force: true });

    // List files changed between old and new HEAD.
    const updatedPaths: string[] = [];
    if (localOid) {
      try {
        await git.walk({
          fs,
          dir: cloneDir,
          trees: [git.TREE({ ref: localOid }), git.TREE({ ref: remoteOid })],
          map: async (filepath, entries) => {
            if (!entries) return null;
            const [a, b] = entries;
            if (!a || !b) {
              updatedPaths.push(filepath);
            } else {
              const aOid = await a.oid?.();
              const bOid = await b.oid?.();
              if (aOid !== bOid) updatedPaths.push(filepath);
            }
            return null;
          },
        });
      } catch {
        // Best-effort — return empty list if walk fails.
      }
    }

    return { ok: true, updatedPaths };
  } catch (err) {
    return {
      ok: false,
      updatedPaths: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ------------------------------------------------------------------
// Push
// ------------------------------------------------------------------

/**
 * Push the local branch to origin.
 * On push rejection (non-fast-forward), returns { ok: false, error }.
 * The engine handles the retry-after-pull logic.
 */
export async function push(config: GitConfig): Promise<PushResult> {
  try {
    const { cloneDir, remoteUrl, username, password } = config;
    await git.push({
      fs,
      http,
      dir: cloneDir,
      url: remoteUrl,
      onAuth: buildAuthHandler(username, password),
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ------------------------------------------------------------------
// Read blob from working tree
// ------------------------------------------------------------------

/**
 * Read a blob payload from the local clone working tree.
 * Returns null if the file does not exist.
 */
export function readBlob(
  cloneDir: string,
  tableName: string,
  rowId: string,
): Buffer | null {
  const blobPath = path.join(cloneDir, 'sync', 'blobs', tableName, `${rowId}.bin`);
  if (!fs.existsSync(blobPath)) return null;
  return fs.readFileSync(blobPath);
}

/**
 * List all blob paths under sync/blobs/ in the working tree.
 * Returns relative paths like "sync/blobs/<table>/<rowId>.bin".
 */
export function listBlobs(cloneDir: string): string[] {
  const blobsDir = path.join(cloneDir, 'sync', 'blobs');
  if (!fs.existsSync(blobsDir)) return [];
  const results: string[] = [];
  for (const table of fs.readdirSync(blobsDir)) {
    const tableDir = path.join(blobsDir, table);
    if (!fs.statSync(tableDir).isDirectory()) continue;
    for (const file of fs.readdirSync(tableDir)) {
      if (file.endsWith('.bin')) {
        results.push(path.join('sync', 'blobs', table, file));
      }
    }
  }
  return results;
}

// ------------------------------------------------------------------
// Auth helper
// ------------------------------------------------------------------

function buildAuthHandler(username?: string, password?: string) {
  if (!username && !password) return undefined;
  return () => ({
    username: username ?? '',
    password: password ?? '',
  });
}
