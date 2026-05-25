// R-1 Lane B — telegram controller tests (node env).
//
// Covers: setToken never returns the token + refuses without encryption;
// getStatus shape; setAllowlist dedup/coercion; clearToken.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTelegramController } from './controller';
import { CRED_TELEGRAM_TOKEN, type BridgeStatusSnapshot } from './bridge';

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (k: string) => store.get(k) ?? null,
    set: (k: string, v: string) => void store.set(k, v),
  };
}

function makeCredentials(opts: { token?: string | null; encryption?: boolean } = {}) {
  let token = opts.token ?? null;
  const encryption = opts.encryption ?? true;
  return {
    get: vi.fn(async () => token),
    set: vi.fn(async (_k: string, v: string) => {
      token = v;
    }),
    remove: vi.fn(async () => {
      token = null;
      return true;
    }),
    isEncryptionAvailable: vi.fn(() => encryption),
  };
}

function makeBridge(snapshot: Partial<BridgeStatusSnapshot> = {}) {
  return {
    snapshot: vi.fn(
      (token: string | null): BridgeStatusSnapshot => ({
        enabled: false,
        running: false,
        locked: false,
        allowlist: [],
        encryptionAvailable: true,
        tokenSet: !!token,
        ...snapshot,
      }),
    ),
    start: vi.fn(async () => 'running' as const),
    stop: vi.fn(async () => undefined),
    lock: vi.fn(),
    unlock: vi.fn(),
    auditTail: vi.fn(() => [{ ts: 1, kind: 'start', chatId: null, detail: 'x' }]),
    isRunning: vi.fn(() => true),
    isLocked: vi.fn(() => false),
  };
}

// `defineController` returns the same object; cast to the call shape for tests.
type Ctl = {
  getStatus: () => Promise<BridgeStatusSnapshot>;
  setToken: (t: string) => Promise<void>;
  clearToken: () => Promise<void>;
  setEnabled: (b: boolean) => Promise<void>;
  setAllowlist: (ids: number[]) => Promise<void>;
  setIdleLockMinutes: (m: number) => Promise<void>;
  lock: () => Promise<void>;
  unlock: () => Promise<void>;
  auditTail: (n: number) => Promise<unknown[]>;
};

describe('telegram controller', () => {
  let kv: ReturnType<typeof makeKv>;
  let credentials: ReturnType<typeof makeCredentials>;
  let bridge: ReturnType<typeof makeBridge>;
  let ctl: Ctl;

  beforeEach(() => {
    kv = makeKv();
    credentials = makeCredentials({ token: null, encryption: true });
    bridge = makeBridge();
    ctl = buildTelegramController({
      bridge: bridge as never,
      kv,
      credentials,
    }) as unknown as Ctl;
  });

  it('getStatus returns the snapshot shape and never the token value', async () => {
    credentials = makeCredentials({ token: 'super-secret-token', encryption: true });
    bridge = makeBridge({ tokenSet: true });
    ctl = buildTelegramController({ bridge: bridge as never, kv, credentials }) as unknown as Ctl;

    const status = await ctl.getStatus();
    expect(status).toMatchObject({
      enabled: expect.any(Boolean),
      running: expect.any(Boolean),
      locked: expect.any(Boolean),
      allowlist: expect.any(Array),
      encryptionAvailable: expect.any(Boolean),
      tokenSet: true,
    });
    expect(JSON.stringify(status)).not.toContain('super-secret-token');
  });

  it('setToken stores the token, restarts, and returns void (never the token)', async () => {
    const result = await ctl.setToken('123456:ABC');
    expect(result).toBeUndefined();
    expect(credentials.set).toHaveBeenCalledWith(CRED_TELEGRAM_TOKEN, '123456:ABC');
    expect(bridge.stop).toHaveBeenCalled();
    expect(bridge.start).toHaveBeenCalled();
  });

  it('setToken refuses when encryption is unavailable', async () => {
    credentials = makeCredentials({ token: null, encryption: false });
    ctl = buildTelegramController({ bridge: bridge as never, kv, credentials }) as unknown as Ctl;
    await expect(ctl.setToken('123456:ABC')).rejects.toThrow(/encryption/i);
    expect(credentials.set).not.toHaveBeenCalled();
  });

  it('setToken rejects an empty token', async () => {
    await expect(ctl.setToken('   ')).rejects.toThrow(/non-empty/);
  });

  it('clearToken removes the credential and restarts', async () => {
    await ctl.clearToken();
    expect(credentials.remove).toHaveBeenCalledWith(CRED_TELEGRAM_TOKEN);
    expect(bridge.stop).toHaveBeenCalled();
  });

  it('setEnabled persists the flag', async () => {
    await ctl.setEnabled(true);
    expect(kv.get('remote.telegram.enabled')).toBe('1');
    await ctl.setEnabled(false);
    expect(kv.get('remote.telegram.enabled')).toBe('0');
  });

  it('setAllowlist dedups, coerces, and persists JSON', async () => {
    await ctl.setAllowlist([1, 1, 2, 3.5 as unknown as number, '4' as unknown as number]);
    expect(JSON.parse(kv.get('remote.telegram.allowlist')!)).toEqual([1, 2, 4]);
  });

  it('setIdleLockMinutes clamps non-positive to 0', async () => {
    await ctl.setIdleLockMinutes(-5);
    expect(kv.get('remote.telegram.idleLockMinutes')).toBe('0');
    await ctl.setIdleLockMinutes(15);
    expect(kv.get('remote.telegram.idleLockMinutes')).toBe('15');
  });

  it('lock / unlock delegate to the bridge', async () => {
    await ctl.lock();
    expect(bridge.lock).toHaveBeenCalled();
    await ctl.unlock();
    expect(bridge.unlock).toHaveBeenCalled();
  });

  it('auditTail forwards a sane default count', async () => {
    await ctl.auditTail(0);
    expect(bridge.auditTail).toHaveBeenCalledWith(50);
    await ctl.auditTail(10);
    expect(bridge.auditTail).toHaveBeenCalledWith(10);
  });
});
