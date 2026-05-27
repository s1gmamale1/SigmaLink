import { describe, it, expect } from 'vitest';
import { scrubPii } from './pii-scrub';

describe('scrubPii (shared local redactor — H-19)', () => {
  it('redacts API-key secrets (sk-/ghp_/AKIA/Bearer)', () => {
    expect(scrubPii('key sk-abcd1234efgh5678')).toBe('key [REDACTED]');
    expect(scrubPii('tok ghp_ABCDEFGH12345678')).toBe('tok [REDACTED]');
    expect(scrubPii('aws AKIAABCDEFGH123456')).toBe('aws [REDACTED]');
    expect(scrubPii('auth Bearer eyJ.abc-123_x=')).toBe('auth [REDACTED]');
  });

  it('redacts email addresses', () => {
    expect(scrubPii('mail me at alice.b@example.co.uk please')).toBe(
      'mail me at [EMAIL] please',
    );
  });

  it('redacts E.164 phone numbers (leading +)', () => {
    expect(scrubPii('call +1 415-555-0199 now')).toContain('[PHONE]');
    expect(scrubPii('call +1 415-555-0199 now')).not.toContain('555');
  });

  it('does NOT over-redact dev output (dates / indices / IDs — no leading +)', () => {
    // H-19 re-review: the E.164 `+` anchor prevents mangling coding output.
    const dev = 'build on 2026-05-28 at index 0123456789 ISBN 978-3-16-148410-0';
    expect(scrubPii(dev)).toBe(dev);
  });

  it('leaves clean content unchanged (byte-identical)', () => {
    const clean = 'const x = computeSum(a, b); // returns the total, no PII here';
    expect(scrubPii(clean)).toBe(clean);
  });

  it('is idempotent / lastIndex-safe across repeated calls on the same input', () => {
    const input = 'sk-deadbeef12345678 and bob@test.com';
    const first = scrubPii(input);
    const second = scrubPii(input);
    expect(first).toBe(second);
    expect(first).toBe('[REDACTED] and [EMAIL]');
  });

  it('does NOT catastrophically backtrack on long adversarial input (ReDoS guard)', () => {
    // Pathological inputs for the email/phone classes. If any pattern had
    // nested ambiguous quantifiers this would hang; with the linear patterns it
    // returns near-instantly. The assertion is that it COMPLETES well under a
    // generous bound.
    const evilEmail = `${'a'.repeat(100_000)}@`; // local part, never completes a domain
    const evilPhone = `+${'9'.repeat(200_000)}!`; // long pure-digit run + failing tail
    const start = Date.now();
    scrubPii(evilEmail);
    scrubPii(evilPhone);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
