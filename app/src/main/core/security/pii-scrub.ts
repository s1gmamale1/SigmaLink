// Shared local PII / secret redactor (H-19).
//
// Extracted VERBATIM from R-1's `core/remote/safety.ts` so the assistant gate
// (`aidefence-gate.ts scrubOutbound`) and the Telegram bridge share ONE audited,
// ReDoS-conscious regex set instead of two divergent copies (the H-5
// `assertAllowedPath` single-source-of-truth pattern). The Telegram-specific
// bot-token redaction stays in `core/remote/safety.ts` — it is not general PII.
//
// Safety properties (preserved from the reviewed R-1 patterns):
//   - Every pattern is LINEAR + length-capped — no nested/ambiguous quantifiers,
//     so no catastrophic backtracking (ReDoS) on adversarial / long replies.
//   - `lastIndex` is reset before every `.replace` (defensive; global regexes
//     are reused across calls).
// This is best-effort: it catches well-formed secrets / emails / phones, not
// every obfuscated PII form. Callers treat it as a scrub floor, not a guarantee.

// Common API-key prefixes followed by at least 8 non-whitespace chars.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-[A-Za-z0-9_-]{8,}/g, // OpenAI / generic sk- keys
  /ghp_[A-Za-z0-9_]{8,}/g, // GitHub personal access tokens
  /AKIA[A-Z0-9]{12,}/g, // AWS access key IDs
  /Bearer\s+[A-Za-z0-9._~+/=-]+=*/gi, // Authorization: Bearer …
];

// Linear, bounded email matcher. The base domain class excludes '.' and the
// dotted labels are a separate anchored group `(?:\.label)+`, so there is no
// quantifier ambiguity (no catastrophic backtracking on inputs like
// `a@a.a.a.a…`). All quantifiers are length-capped.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,255}(?:\.[A-Za-z]{2,24})+/g;

// E.164 phone: REQUIRES a leading `+` (international format), then 7-15 total
// digits with optional single separators. The `+` anchor is deliberate (H-19
// re-review): without it, `{7,15}` over digit-ish chars over-redacts a CODING
// assistant's output — dates (2026-05-28), numeric indices, ISBNs, dotted/
// dashed IDs are NOT phone numbers. Bounded repetition over a mandatory digit
// ⇒ no catastrophic backtracking. Trade-off: bare domestic numbers (no `+`)
// are not caught — acceptable; low false-positives matter more here than
// catching every format.
const PHONE_PATTERN = /\+[0-9](?:[\s.-]?[0-9]){6,14}/g;

/**
 * Redact well-formed secrets, emails, and phone numbers from `text`. Pure +
 * synchronous + offline (no network). Returns the redacted string; returns the
 * input unchanged when nothing matched. Never throws.
 */
export function scrubPii(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, '[REDACTED]');
  }
  EMAIL_PATTERN.lastIndex = 0;
  out = out.replace(EMAIL_PATTERN, '[EMAIL]');
  PHONE_PATTERN.lastIndex = 0;
  out = out.replace(PHONE_PATTERN, '[PHONE]');
  return out;
}
