// src/main/core/control/control-config.ts
//
// Configuration + secrets for the External Control MCP surface: the enable
// flag, the kill-switch (freeze) flag, the bearer token, and the platform
// socket path. PURE/IO-light — kv + credentials are injected (no electron/DB
// import) so this loads and tests under vitest.

import * as crypto from 'node:crypto';
import * as path from 'node:path';

// erasableSyntaxOnly: declare interfaces locally (no constructor param-properties).
export interface KvLike {
  get(key: string): string | null;
  set(key: string, value: string): void;
}
export interface CredentialStoreLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<boolean>;
  isEncryptionAvailable(): boolean;
}

export const KV_CONTROL_MCP_ENABLED = 'control.mcp.enabled';
export const KV_CONTROL_MCP_FROZEN = 'control.mcp.frozen';
export const CRED_CONTROL_BEARER = 'control.mcp.bearerToken';

export function isControlEnabled(kv: KvLike): boolean {
  return kv.get(KV_CONTROL_MCP_ENABLED) === '1';
}
export function isControlFrozen(kv: KvLike): boolean {
  return kv.get(KV_CONTROL_MCP_FROZEN) === '1';
}
export function setControlEnabled(kv: KvLike, on: boolean): void {
  kv.set(KV_CONTROL_MCP_ENABLED, on ? '1' : '0');
}
export function setControlFrozen(kv: KvLike, on: boolean): void {
  kv.set(KV_CONTROL_MCP_FROZEN, on ? '1' : '0');
}

export async function getBearerToken(creds: CredentialStoreLike): Promise<string | null> {
  return creds.get(CRED_CONTROL_BEARER);
}
export async function ensureBearerToken(creds: CredentialStoreLike): Promise<string> {
  const existing = await creds.get(CRED_CONTROL_BEARER);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  await creds.set(CRED_CONTROL_BEARER, token);
  return token;
}
export async function rotateBearerToken(creds: CredentialStoreLike): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await creds.set(CRED_CONTROL_BEARER, token);
  return token;
}

export function controlSocketPath(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const hash = crypto.createHash('sha1').update(userDataDir).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\sigmalink-control-${hash}`;
  }
  return path.join(userDataDir, 'control.sock');
}

/** Constant-time token compare (avoid a timing oracle on the handshake). */
export function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
