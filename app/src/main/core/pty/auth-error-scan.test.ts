import { describe, expect, it } from 'vitest';
import { scanCodexAuthError } from './auth-error-scan';

describe('scanCodexAuthError', () => {
  // ── token_expired ──────────────────────────────────────────────────────────

  it('detects token_expired exact key', () => {
    expect(scanCodexAuthError('error: token_expired')).toEqual({ kind: 'token_expired' });
  });

  it('detects token_expired mid-line', () => {
    expect(scanCodexAuthError('{"error":"token_expired","message":"..."}')).toEqual({
      kind: 'token_expired',
    });
  });

  it('does NOT match "token_expired" if word boundary breaks it', () => {
    // "mytoken_expired_value" — word boundary check: \b before "token" and
    // after "expired".  "mytoken_expired" has no \b before 'token'.
    // Actually: \b is between non-word and word char. 'y' (word) and 't' (word)
    // means NO \b. So "mytoken_expired" → no match. ✓
    expect(scanCodexAuthError('mytoken_expired_value has no match')).toBeNull();
  });

  // ── refresh_reused ─────────────────────────────────────────────────────────

  it('detects refresh token already used', () => {
    expect(scanCodexAuthError('Auth failed: refresh token already used')).toEqual({
      kind: 'refresh_reused',
    });
  });

  it('detects refresh token already used case-insensitively', () => {
    expect(scanCodexAuthError('REFRESH TOKEN ALREADY USED')).toEqual({
      kind: 'refresh_reused',
    });
  });

  // ── unauthorized ───────────────────────────────────────────────────────────

  it('detects HTTP 401 as unauthorized', () => {
    expect(scanCodexAuthError('Response: HTTP 401 from auth server')).toEqual({
      kind: 'unauthorized',
    });
  });

  it('detects 401 Unauthorized as unauthorized', () => {
    expect(scanCodexAuthError('Error: 401 Unauthorized')).toEqual({ kind: 'unauthorized' });
  });

  it('detects 401 auth failed as unauthorized', () => {
    expect(scanCodexAuthError('status 401 auth failed')).toEqual({ kind: 'unauthorized' });
  });

  // ── no false positives ─────────────────────────────────────────────────────

  it('returns null for ordinary codex output', () => {
    expect(scanCodexAuthError('Running codex on task: implement feature X')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(scanCodexAuthError('')).toBeNull();
  });

  it('returns null for 401 without auth context on the same line', () => {
    // A standalone "401" (e.g. a line number or index) should not match.
    // Our pattern requires "401" to be followed by auth/unauthorized on the
    // same line OR to be prefixed by "HTTP ".
    expect(scanCodexAuthError('item 401 is processed')).toBeNull();
  });

  it('returns null for a 401 only in a multi-line chunk where auth is on a different line', () => {
    // [^\n]* prevents the auth context from crossing a newline.
    expect(scanCodexAuthError('error code 401\nauth is fine')).toBeNull();
  });

  // ── priority: first match wins ─────────────────────────────────────────────

  it('token_expired takes priority over refresh_reused in the same chunk', () => {
    const chunk = 'token_expired: refresh token already used';
    expect(scanCodexAuthError(chunk)).toEqual({ kind: 'token_expired' });
  });
});
