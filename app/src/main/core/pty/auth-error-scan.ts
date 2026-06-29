// src/main/core/pty/auth-error-scan.ts
//
// Scan a codex PTY output chunk for known OAuth / auth-error signatures.
//
// PURE — no I/O, no state. Called per PTY data chunk by registry.onData for
// codex panes. Must be cheap (regex test on the incoming chunk, first match wins).
//
// Anchored on the phrases the codex CLI / OAuth server actually emits to avoid
// false positives on ordinary output:
//   token_expired          — exact key emitted on token expiry
//   refresh token already used — race: second spawn consumed the single-use token
//   HTTP 401 / 401 + auth  — generic HTTP Unauthorized on the auth endpoint

export type CodexAuthErrorKind = 'token_expired' | 'refresh_reused' | 'unauthorized';

export interface CodexAuthError {
  kind: CodexAuthErrorKind;
}

const PATTERNS: ReadonlyArray<{ re: RegExp; kind: CodexAuthErrorKind }> = [
  // Exact key the OAuth server / codex CLI emits on token expiry.
  { re: /\btoken_expired\b/, kind: 'token_expired' },
  // Single-use refresh token already consumed by another codex process (race).
  { re: /refresh token already used/i, kind: 'refresh_reused' },
  // HTTP 401 on an auth endpoint; or "401" followed by auth-related context on
  // the same line (e.g. "401 Unauthorized", "401 - auth failed").
  { re: /HTTP 401|\b401\b[^\n]*(?:auth|unauthorized)/i, kind: 'unauthorized' },
];

/**
 * Returns the first recognized auth-error kind found in `chunk`, or `null`.
 *
 * Called on every PTY data chunk for codex panes — O(chunk.length), no
 * allocations beyond the RegExp internal match state.
 */
export function scanCodexAuthError(chunk: string): CodexAuthError | null {
  for (const { re, kind } of PATTERNS) {
    if (re.test(chunk)) return { kind };
  }
  return null;
}
