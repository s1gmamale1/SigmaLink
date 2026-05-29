// SigmaVoice — persistent KV store.
//
// The voice-core capture controller, dictionary (normalizeTranscript) and usage
// stats (appendSessionStat) all read/write through a synchronous
// `{ get, set }` KV. v0.2 backed this with an in-memory Map, so the dictionary
// and stats were lost on every restart. This file-backed store persists them to
// a single JSON file under <userData> with atomic writes.
//
// Intentionally tiny + synchronous to match the KV contract voice-core expects.

import fs from 'node:fs';
import path from 'node:path';

export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * Create a JSON-file-backed KV store. Loads once at construction; every `set`
 * persists the whole map via temp-file + rename (atomic). All filesystem errors
 * are swallowed so a read-only disk or corrupt file never crashes the app — it
 * degrades to an effectively in-memory store.
 */
export function createFileKv(filePath: string): KvStore {
  let data: Record<string, string> = {};

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Keep only string values — the KV contract is string→string.
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') data[k] = v;
      }
    }
  } catch {
    // Missing or corrupt file → start empty.
    data = {};
  }

  function persist(): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch {
      // Non-fatal: persistence failure must never disrupt capture.
    }
  }

  return {
    get: (key: string): string | null => (key in data ? data[key] : null),
    set: (key: string, value: string): void => {
      data[key] = value;
      persist();
    },
  };
}
