import { describe, expect, it } from 'vitest';
import { assertIsolatedTestProfile } from './test-profile-guard';

describe('assertIsolatedTestProfile', () => {
  it('rejects an Electron test boot without an explicit isolated profile', () => {
    expect(() =>
      assertIsolatedTestProfile({ nodeEnv: 'test', isolatedMarker: undefined, argv: ['electron', 'main.js'] }),
    ).toThrow(/isolated test profile/i);
  });

  it('rejects a marker that does not include a user-data-dir argument', () => {
    expect(() =>
      assertIsolatedTestProfile({ nodeEnv: 'test', isolatedMarker: '1', argv: ['electron', 'main.js'] }),
    ).toThrow(/user-data-dir/i);
  });

  it('accepts an explicitly isolated test boot and every non-test boot', () => {
    expect(() =>
      assertIsolatedTestProfile({
        nodeEnv: 'test',
        isolatedMarker: '1',
        argv: ['electron', 'main.js', '--user-data-dir=/tmp/sigmalink-test'],
      }),
    ).not.toThrow();
    expect(() =>
      assertIsolatedTestProfile({ nodeEnv: 'production', isolatedMarker: undefined, argv: [] }),
    ).not.toThrow();
  });
});
