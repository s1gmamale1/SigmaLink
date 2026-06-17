import { describe, it, expect } from 'vitest';
import {
  KV_CONTROL_MCP_ENABLED,
  KV_CONTROL_MCP_FROZEN,
  isControlEnabled,
  isControlFrozen,
  setControlEnabled,
  setControlFrozen,
  ensureBearerToken,
  getBearerToken,
  rotateBearerToken,
  controlSocketPath,
  tokenEquals,
} from './control-config';

function fakeKv() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
}
function fakeCreds() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    remove: async (k: string) => m.delete(k),
    isEncryptionAvailable: () => true,
  };
}

describe('control-config', () => {
  it('enabled/frozen default off and toggle via kv === "1"', () => {
    const kv = fakeKv();
    expect(isControlEnabled(kv)).toBe(false);
    expect(isControlFrozen(kv)).toBe(false);
    setControlEnabled(kv, true);
    setControlFrozen(kv, true);
    expect(kv.get(KV_CONTROL_MCP_ENABLED)).toBe('1');
    expect(kv.get(KV_CONTROL_MCP_FROZEN)).toBe('1');
    expect(isControlEnabled(kv)).toBe(true);
    expect(isControlFrozen(kv)).toBe(true);
    setControlEnabled(kv, false);
    expect(isControlEnabled(kv)).toBe(false);
  });

  it('ensureBearerToken generates once and is stable; getBearerToken reads it', async () => {
    const creds = fakeCreds();
    expect(await getBearerToken(creds)).toBeNull();
    const t1 = await ensureBearerToken(creds);
    expect(t1).toHaveLength(64); // 32 random bytes hex
    const t2 = await ensureBearerToken(creds);
    expect(t2).toBe(t1); // stable
    expect(await getBearerToken(creds)).toBe(t1);
  });

  it('rotateBearerToken changes the stored token', async () => {
    const creds = fakeCreds();
    const t1 = await ensureBearerToken(creds);
    const t2 = await rotateBearerToken(creds);
    expect(t2).not.toBe(t1);
    expect(await getBearerToken(creds)).toBe(t2);
  });

  it('controlSocketPath is platform-appropriate and stable', () => {
    const p = controlSocketPath('/tmp/ud', 'win32');
    expect(p).toMatch(/^\\\\\.\\pipe\\sigmalink-control-/);
    const u = controlSocketPath('/tmp/ud', 'darwin');
    expect(u).toBe('/tmp/ud/control.sock');
  });

  it('tokenEquals is true for equal, false for different/length-mismatch', () => {
    expect(tokenEquals('abc123', 'abc123')).toBe(true);
    expect(tokenEquals('abc123', 'abc124')).toBe(false);
    expect(tokenEquals('abc', 'abcd')).toBe(false);
  });
});
