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

  it('detects "could not be refreshed" as unauthorized', () => {
    expect(scanCodexAuthError('OAuth token could not be refreshed')).toEqual({
      kind: 'unauthorized',
    });
  });

  it('detects "sign in again" as unauthorized', () => {
    expect(scanCodexAuthError('Session expired. Please sign in again to continue.')).toEqual({
      kind: 'unauthorized',
    });
  });

  it('detects "could not be refreshed" case-insensitively', () => {
    expect(scanCodexAuthError('ERROR: COULD NOT BE REFRESHED')).toEqual({ kind: 'unauthorized' });
  });

  // ── false-positive guard — user-typed text must NOT match ──────────────────

  it('does NOT match user-typed text mentioning "401 unauthorized"', () => {
    // The bare \b401\b...auth catch-all was removed precisely because it matched
    // arbitrary user messages like this.
    expect(scanCodexAuthError('please fix the 401 unauthorized error in my API')).toBeNull();
  });

  it('does NOT match user-typed "401 auth failed" echoed in the pane', () => {
    expect(scanCodexAuthError('debug the 401 auth failed response from our server')).toBeNull();
  });

  it('does NOT match standalone "401 Unauthorized" not prefixed by "HTTP "', () => {
    // Without the catch-all, "401 Unauthorized" alone is not a match.
    expect(scanCodexAuthError('Error: 401 Unauthorized')).toBeNull();
  });

  // ── no false positives ─────────────────────────────────────────────────────

  it('returns null for ordinary codex output', () => {
    expect(scanCodexAuthError('Running codex on task: implement feature X')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(scanCodexAuthError('')).toBeNull();
  });

  it('returns null for a 401 only in a multi-line chunk where auth is on a different line', () => {
    // [^\n]* prevents the auth context from crossing a newline — and the bare
    // \b401\b pattern no longer exists, so this is doubly safe.
    expect(scanCodexAuthError('error code 401\nauth is fine')).toBeNull();
  });

  // ── priority: first match wins ─────────────────────────────────────────────

  it('token_expired takes priority over refresh_reused in the same chunk', () => {
    const chunk = 'token_expired: refresh token already used';
    expect(scanCodexAuthError(chunk)).toEqual({ kind: 'token_expired' });
  });
});
