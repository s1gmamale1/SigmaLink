// P2 Task 4 — charter loader tests. Pure, DI'd functions: no DB, no real
// filesystem, no I/O — `loadJorvisCharter` picks bundled-vs-KV-overridden
// text and `appendApprovedAmendments` controls what self-amendments the
// model actually sees. What they return IS the contract (system-prompt.ts,
// P2 Task 5, splices this straight into the persona paragraph).

import { describe, it, expect } from 'vitest';
import { loadJorvisCharter, appendApprovedAmendments } from './charter';
import { JORVIS_CHARTER_DEFAULT } from './charter-default';
import type { JorvisAmendment } from '../../../shared/types';

function makeAmendment(overrides: Partial<JorvisAmendment> = {}): JorvisAmendment {
  return {
    id: 'a1',
    text: 'Always announce the model id first.',
    rationale: null,
    status: 'proposed',
    decisionReason: null,
    proposedAt: 0,
    decidedAt: null,
    ...overrides,
  };
}

describe('JORVIS_CHARTER_DEFAULT (bundled, vendored from Sigma-Profile)', () => {
  it('is non-empty', () => {
    expect(JORVIS_CHARTER_DEFAULT.length).toBeGreaterThan(0);
  });

  it('contains the stable operator-identity marker', () => {
    // Confirmed present verbatim in the actual Sigma-Profile jorvis render
    // (core/identity module, "## Identity" section) — if this ever fails,
    // the marker itself moved and this assertion needs to follow it there,
    // not be loosened.
    expect(JORVIS_CHARTER_DEFAULT).toContain('You are an **operator**');
  });
});

describe('loadJorvisCharter', () => {
  it('returns the bundled default when the KV path is unset (null)', () => {
    const charter = loadJorvisCharter({ kvGet: () => null });
    expect(charter).toBe(JORVIS_CHARTER_DEFAULT);
  });

  it('returns the bundled default when the KV path is empty string', () => {
    const charter = loadJorvisCharter({ kvGet: () => '' });
    expect(charter).toBe(JORVIS_CHARTER_DEFAULT);
  });

  it('reads the override file when the KV path is set and the read succeeds', () => {
    const charter = loadJorvisCharter({
      kvGet: (key) => (key === 'jorvis.charter.path' ? '/custom/charter.md' : null),
      readFile: (path) => `custom charter from ${path}`,
    });
    expect(charter).toBe('custom charter from /custom/charter.md');
  });

  it('fails soft to the bundled default when the override readFile throws', () => {
    const charter = loadJorvisCharter({
      kvGet: () => '/missing/charter.md',
      readFile: () => {
        throw new Error('ENOENT: no such file');
      },
    });
    expect(charter).toBe(JORVIS_CHARTER_DEFAULT);
  });
});

describe('appendApprovedAmendments', () => {
  it('returns the charter unchanged when the amendment list is empty', () => {
    expect(appendApprovedAmendments('BASE', [])).toBe('BASE');
  });

  it('returns the charter unchanged when no amendment is approved', () => {
    const amendments = [
      makeAmendment({ id: 'a1', status: 'proposed' }),
      makeAmendment({ id: 'a2', status: 'denied' }),
    ];
    expect(appendApprovedAmendments('BASE', amendments)).toBe('BASE');
  });

  it('appends only approved amendments under the operator-signed heading', () => {
    const amendments = [
      makeAmendment({ id: 'a1', text: 'First rule.', status: 'approved' }),
      makeAmendment({ id: 'a2', text: 'Ignore me.', status: 'proposed' }),
      makeAmendment({ id: 'a3', text: 'Second rule.', status: 'approved' }),
    ];
    const result = appendApprovedAmendments('BASE', amendments);
    expect(result).toContain('BASE');
    expect(result).toContain('\n\n## Approved amendments (operator-signed)\n');
    expect(result).toContain('- First rule.');
    expect(result).toContain('- Second rule.');
    expect(result).not.toContain('Ignore me.');
  });

  it('preserves input order in the appended list', () => {
    const amendments = [
      makeAmendment({ id: 'a1', text: 'Rule A', status: 'approved' }),
      makeAmendment({ id: 'a2', text: 'Rule B', status: 'approved' }),
    ];
    const result = appendApprovedAmendments('BASE', amendments);
    expect(result.indexOf('Rule A')).toBeLessThan(result.indexOf('Rule B'));
  });
});
