// win32-db-lifecycle (2026-06-11) — pragma-order tripwire.
//
// `PRAGMA journal_mode = WAL` is itself a lock-acquiring statement (WAL-index/
// DMS handshake). On Windows, orphaned per-CLI mcp-memory-server children from
// a previous run can still hold sigmalink.db/-shm at boot; when journal_mode
// ran BEFORE busy_timeout, that lock threw SQLITE_BUSY instantly → uncaught →
// the "JavaScript error in the main process" crash dialog (operator-confirmed
// on the W-4 device). busy_timeout MUST therefore be the FIRST pragma.
//
// better-sqlite3 cannot load under vitest (Electron ABI) and client.ts imports
// it at module top — so, following the client.bootstrap-index.test.ts
// precedent, this suite asserts on client.ts SOURCE TEXT.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = fs.readFileSync(path.join(__dirname, 'client.ts'), 'utf8');

function openAndCheckBody(): string {
  const start = clientSrc.indexOf('function openAndCheck(');
  expect(start).toBeGreaterThan(-1);
  const end = clientSrc.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return clientSrc.slice(start, end);
}

describe('openAndCheck pragma order (win32 boot-crash tripwire)', () => {
  it('sets busy_timeout BEFORE journal_mode = WAL', () => {
    const body = openAndCheckBody();
    const busyIdx = body.indexOf("pragma('busy_timeout");
    const walIdx = body.indexOf("pragma('journal_mode = WAL')");
    expect(busyIdx).toBeGreaterThan(-1);
    expect(walIdx).toBeGreaterThan(-1);
    expect(busyIdx).toBeLessThan(walIdx);
  });

  it('still runs the quick_check integrity probe after the pragmas', () => {
    const body = openAndCheckBody();
    const walIdx = body.indexOf("pragma('journal_mode = WAL')");
    const quickIdx = body.indexOf("pragma('quick_check')");
    expect(quickIdx).toBeGreaterThan(walIdx);
  });
});
