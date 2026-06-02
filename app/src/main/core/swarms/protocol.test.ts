// FEAT-4 — coverage for the SIGMA::PROMPT verb + PromptPayload guard added to
// the shared protocol module. Also re-asserts that adding PROMPT did not break
// parsing of the pre-existing verbs the swarm mailbox router relies on.

import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERBS,
  envelopeToInsert,
  isPromptPayload,
  parseProtocolLine,
} from './protocol';

describe('protocol — PROMPT verb', () => {
  it('exposes PROMPT in the verb list', () => {
    expect(PROTOCOL_VERBS).toContain('PROMPT');
  });

  it('parses a valid SIGMA::PROMPT line', () => {
    const parsed = parseProtocolLine(
      'SIGMA::PROMPT {"question":"Pick a colour","type":"single","choices":["red","blue"]}',
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.verb).toBe('PROMPT');
    expect(parsed?.payload).toMatchObject({
      question: 'Pick a colour',
      type: 'single',
      choices: ['red', 'blue'],
    });
  });

  it('still parses the pre-existing verbs after PROMPT was added', () => {
    expect(parseProtocolLine('SIGMA::SAY {"to":"a","body":"hi"}')?.verb).toBe('SAY');
    expect(parseProtocolLine('SIGMA::DONE {}')?.verb).toBe('DONE');
    expect(parseProtocolLine('SIGMA::ROLLCALL')?.verb).toBe('ROLLCALL');
  });

  it('returns null for an unknown verb (no accidental widening)', () => {
    expect(parseProtocolLine('SIGMA::BOGUS {}')).toBeNull();
  });

  it('routes a PROMPT envelope to the mailbox as a graceful, side-effect-free row', () => {
    // This mirrors what the swarm watcher (factory-spawn.ts) does with EVERY
    // parsed line. A PROMPT line must coerce cleanly into a mailbox insert
    // (kind 'PROMPT', toAgent defaulting to 'operator') and never throw — the
    // router has no PROMPT-specific branch, so it is a no-op there.
    const parsed = parseProtocolLine(
      'SIGMA::PROMPT {"question":"Q?","type":"multi","choices":["x"]}',
    );
    expect(parsed).not.toBeNull();
    const insert = envelopeToInsert('swarm-1', 'agent-a', parsed!);
    expect(insert.kind).toBe('PROMPT');
    expect(insert.toAgent).toBe('operator');
    expect(insert.swarmId).toBe('swarm-1');
    expect(insert.fromAgent).toBe('agent-a');
    // No board_post / directive markers → the mailbox side-effect branches stay
    // dormant for this kind.
    expect(insert.payload).toMatchObject({ type: 'multi', choices: ['x'] });
  });
});

describe('protocol — isPromptPayload guard', () => {
  it('accepts a well-formed single/multi payload', () => {
    expect(isPromptPayload({ question: 'q', type: 'single', choices: ['a'] })).toBe(true);
    expect(isPromptPayload({ question: 'q', type: 'multi', choices: ['a', 'b'] })).toBe(true);
  });

  it('rejects a blank or non-string question', () => {
    expect(isPromptPayload({ question: '', type: 'single', choices: ['a'] })).toBe(false);
    expect(isPromptPayload({ question: '   ', type: 'single', choices: ['a'] })).toBe(false);
    expect(isPromptPayload({ question: 42, type: 'single', choices: ['a'] })).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(isPromptPayload({ question: 'q', type: 'dropdown', choices: ['a'] })).toBe(false);
    expect(isPromptPayload({ question: 'q', choices: ['a'] })).toBe(false);
  });

  it('rejects empty / non-array / non-string choices', () => {
    expect(isPromptPayload({ question: 'q', type: 'single', choices: [] })).toBe(false);
    expect(isPromptPayload({ question: 'q', type: 'single', choices: 'a' })).toBe(false);
    expect(isPromptPayload({ question: 'q', type: 'single', choices: ['a', 2] })).toBe(false);
  });

  it('rejects non-object inputs', () => {
    expect(isPromptPayload(null)).toBe(false);
    expect(isPromptPayload(undefined)).toBe(false);
    expect(isPromptPayload('PROMPT')).toBe(false);
    expect(isPromptPayload(123)).toBe(false);
  });
});
