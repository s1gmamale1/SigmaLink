// src/main/core/pty/auth-error-scan.ts
//
// Scan a codex PTY output chunk for known OAuth / auth-error signatures.
//
// PURE — no I/O, no state. Called per PTY data chunk by registry.onData for
// codex panes. Must be cheap (regex test on the incoming chunk, first match wins).
//
// All patterns are anchored on phrases the codex CLI or OAuth server actually
// emits so that user-echoed text (e.g. "please fix the 401 unauthorized error
// in my API") cannot trigger false positives:
//   token_expired              — exact JSON key on token expiry
//   refresh token already used — race: second spawn consumed the single-use token
//   HTTP 401                   — literal HTTP status line in auth server responses
//   could not be refreshed     — codex-specific OAuth client phrase
//   sign in again              — codex CLI prompt on session expiry
//
// The bare `\b401\b...(auth|unauthorized)` catch-all was intentionally removed:
// it matched arbitrary user text containing "401 unauthorized" and produced
// false positives on user-visible pane output.

export type CodexAuthErrorKind = 'token_expired' | 'refresh_reused' | 'unauthorized';

export interface CodexAuthError {
  kind: CodexAuthErrorKind;
}

const PATTERNS: ReadonlyArray<{ re: RegExp; kind: CodexAuthErrorKind }> = [
  // Exact key the OAuth server / codex CLI emits on token expiry.
  { re: /\btoken_expired\b/, kind: 'token_expired' },
  // Single-use refresh token already consumed by another codex process (race).
  { re: /refresh token already used/i, kind: 'refresh_reused' },
  // Codex-specific auth-failure phrases. `HTTP 401` is the literal HTTP status
  // line that codex logs from its OAuth client — specific enough to never appear
  // in user-echoed text. `could not be refreshed` and `sign in again` are codex
  // CLI phrases that only appear in the process's own error output.
  { re: /HTTP 401|could not be refreshed|sign in again/i, kind: 'unauthorized' },
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
