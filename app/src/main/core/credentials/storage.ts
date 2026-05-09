// Encrypted credential storage primitive (closes A5).
//
// Wraps Electron's `safeStorage` API and persists ciphertext blobs in the
// `credentials` SQLite table. Designed for provider API tokens, OAuth
// refresh tokens, and any other operator-supplied secret that previously
// would have leaked into `process.env` or a plaintext config file.
//
// Threat model
// ────────────
// safeStorage uses the OS keychain on macOS (Keychain), Windows (DPAPI),
// and Linux (libsecret / kwallet) to seal a per-user master key. The key is
// not exposed to the renderer; only the main process can call set/get.
// Ciphertext blobs at rest in `sigmalink.db` are useless without the
// master key, so a stolen DB file cannot be decrypted on a different
// machine or under a different user account.
//
// Fallback
// ────────
// On Linux without a keyring (or any environment where
// `safeStorage.isEncryptionAvailable()` returns false) we fall back to a
// `base64:` prefixed encoding so dev workflows still function. The fallback
// is NOT confidential — it is logged loudly via console.warn and the
// table's `ciphertext` blob is just base64. Callers should treat the
// fallback as "obfuscation only" and refuse to handle high-value secrets
// in environments where encryption is unavailable.
//
// API
// ───
//   await CredentialStore.set('provider.openai.apiKey', 'sk-…');
//   const v = await CredentialStore.get('provider.openai.apiKey'); // string | null
//   await CredentialStore.remove('provider.openai.apiKey');
//
// The store is a thin singleton that lazily resolves Electron's safeStorage
// and the SQLite handle. It must be called from the main process; the
// renderer reaches it through an RPC controller W13 will add (out of scope
// here per task spec).

import { safeStorage } from 'electron';
import { getRawDb } from '../db/client';

const FALLBACK_PREFIX = 'b64:';

let warnedAboutFallback = false;

// The `credentials` table is provisioned by migration 0002_credentials,
// which `migrate(db)` runs at main-process boot before any controller can
// invoke CredentialStore — so callers below assume the table exists.

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptValue(value: string): Buffer {
  if (encryptionAvailable()) {
    return safeStorage.encryptString(value);
  }
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      '[credentials] safeStorage.isEncryptionAvailable() === false — ' +
        'falling back to base64 obfuscation. Install a keyring (gnome-keyring ' +
        'or kwallet on Linux) for at-rest encryption. Do NOT use this fallback ' +
        'with production secrets.',
    );
  }
  return Buffer.from(FALLBACK_PREFIX + Buffer.from(value, 'utf8').toString('base64'), 'utf8');
}

function decryptValue(blob: Buffer): string | null {
  // Detect fallback marker first. A real safeStorage ciphertext begins with
  // platform-specific magic bytes (v10/v11 on macOS, DPAPI header on
  // Windows) that will never collide with our ASCII "b64:" prefix.
  if (blob.length >= FALLBACK_PREFIX.length) {
    const head = blob.slice(0, FALLBACK_PREFIX.length).toString('utf8');
    if (head === FALLBACK_PREFIX) {
      try {
        const b64 = blob.slice(FALLBACK_PREFIX.length).toString('utf8');
        return Buffer.from(b64, 'base64').toString('utf8');
      } catch {
        return null;
      }
    }
  }
  if (!encryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(blob);
  } catch (err) {
    console.warn('[credentials] decrypt failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export const CredentialStore = {
  /**
   * Store an encrypted credential. Idempotent on `key`. Throws on empty
   * key. Empty values are allowed (caller may want to "clear without
   * removing the row").
   */
  async set(key: string, value: string): Promise<void> {
    if (typeof key !== 'string' || !key) {
      throw new Error('credentials.set: key must be a non-empty string');
    }
    const v = typeof value === 'string' ? value : String(value ?? '');
    const ct = encryptValue(v);
    const now = Date.now();
    getRawDb()
      .prepare(
        `INSERT INTO credentials (key, ciphertext, createdAt, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           updatedAt = excluded.updatedAt`,
      )
      .run(key, ct, now, now);
  },

  /**
   * Read and decrypt a credential. Returns null if the key is unknown or
   * decryption fails (e.g. blob was written under a different OS user and
   * the keychain master key cannot be derived).
   */
  async get(key: string): Promise<string | null> {
    if (typeof key !== 'string' || !key) return null;
    const row = getRawDb()
      .prepare('SELECT ciphertext FROM credentials WHERE key = ?')
      .get(key) as { ciphertext?: Buffer } | undefined;
    if (!row?.ciphertext) return null;
    const blob = Buffer.isBuffer(row.ciphertext) ? row.ciphertext : Buffer.from(row.ciphertext);
    return decryptValue(blob);
  },

  /**
   * Delete a credential row. No-op when the key is unknown. Returns true
   * if a row was deleted.
   */
  async remove(key: string): Promise<boolean> {
    if (typeof key !== 'string' || !key) return false;
    const info = getRawDb().prepare('DELETE FROM credentials WHERE key = ?').run(key);
    return info.changes > 0;
  },

  /**
   * Test-only: report whether encryption is currently available. Renderer
   * settings UI (W13) can use this to surface the fallback warning.
   */
  isEncryptionAvailable(): boolean {
    return encryptionAvailable();
  },
};

export type CredentialStoreT = typeof CredentialStore;
