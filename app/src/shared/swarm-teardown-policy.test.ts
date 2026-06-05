import { describe, it, expect } from 'vitest';
import {
  swarmTeardownPolicyKey,
  readSwarmTeardownPolicy,
  type SwarmTeardownPolicy,
} from './swarm-teardown-policy';

// ---------------------------------------------------------------------------
// Key builder
// ---------------------------------------------------------------------------

describe('swarmTeardownPolicyKey', () => {
  it('builds the canonical KV key', () => {
    expect(swarmTeardownPolicyKey('ws-abc')).toBe(
      'workspace.swarmTeardownPolicy.ws-abc',
    );
  });

  it('is stable for the same id', () => {
    expect(swarmTeardownPolicyKey('x')).toBe(swarmTeardownPolicyKey('x'));
  });

  it('is distinct per workspace', () => {
    expect(swarmTeardownPolicyKey('a')).not.toBe(swarmTeardownPolicyKey('b'));
  });
});

// ---------------------------------------------------------------------------
// Policy type sanity
// ---------------------------------------------------------------------------

describe('SwarmTeardownPolicy type', () => {
  it('admits the three valid values', () => {
    const policies: SwarmTeardownPolicy[] = [
      'keep-all',
      'keep-passing',
      'destroy-failing',
    ];
    expect(policies).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// readSwarmTeardownPolicy
// ---------------------------------------------------------------------------

/** Build a minimal rawDb stub that returns the given KV value (or undefined). */
function makeRawDb(value: string | undefined) {
  return {
    prepare: () => ({
      get: () =>
        value === undefined ? undefined : { value },
    }),
  };
}

describe('readSwarmTeardownPolicy', () => {
  it('returns keep-all when the row is absent', () => {
    expect(readSwarmTeardownPolicy(makeRawDb(undefined), 'ws-1')).toBe('keep-all');
  });

  it('returns keep-all for an empty string', () => {
    expect(readSwarmTeardownPolicy(makeRawDb(''), 'ws-1')).toBe('keep-all');
  });

  it('returns keep-all for an unrecognised value', () => {
    expect(readSwarmTeardownPolicy(makeRawDb('nuke-everything'), 'ws-1')).toBe(
      'keep-all',
    );
  });

  it('returns keep-all when policy is keep-all', () => {
    expect(readSwarmTeardownPolicy(makeRawDb('keep-all'), 'ws-2')).toBe('keep-all');
  });

  it('returns keep-passing', () => {
    expect(readSwarmTeardownPolicy(makeRawDb('keep-passing'), 'ws-3')).toBe(
      'keep-passing',
    );
  });

  it('returns destroy-failing', () => {
    expect(readSwarmTeardownPolicy(makeRawDb('destroy-failing'), 'ws-4')).toBe(
      'destroy-failing',
    );
  });

  it('returns keep-all (fail-safe) when prepare() throws', () => {
    const badDb = {
      prepare: () => {
        throw new Error('db closed');
      },
    };
    expect(readSwarmTeardownPolicy(badDb, 'ws-5')).toBe('keep-all');
  });
});
