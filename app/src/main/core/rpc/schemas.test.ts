// BUG-4 — schema-registry tests for the side-band channels that the
// rpc-router registers OUTSIDE the typed AppRouter loop. Unlike validate.test.ts
// (which mocks the registry to exercise the validator's branches), this suite
// drives the REAL `CHANNEL_SCHEMAS` through the REAL `validateChannelInput`
// (enforce mode) so a regression that drops/loosens a side-band schema entry
// fails here. Pure node test: schemas.ts imports only zod — no Electron, no DB,
// no native modules.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getChannelSchema } from './schemas';
import { validateChannelInput } from './validate';

const CLEANUP_CHANNELS = [
  'cleanup.removeWorkspace',
  'cleanup.clearPanes',
  'cleanup.pruneWorktrees',
] as const;

describe('cleanup.* side-band channels (BUG-4 — destructive, must be validated)', () => {
  it('every destructive cleanup channel has a concrete (non-z.any) input schema', () => {
    for (const channel of CLEANUP_CHANNELS) {
      const schema = getChannelSchema(channel);
      expect(schema, `${channel} must have a schema entry`).toBeDefined();
      expect(schema?.input, `${channel} must declare an input schema`).toBeDefined();
      // A `z.any()` stub would parse anything — assert the schema actually
      // rejects a bad payload (i.e. it is NOT the permissive stub).
      const bad = schema!.input!.safeParse({ workspaceId: 42 });
      expect(bad.success, `${channel} must reject a non-string workspaceId`).toBe(false);
    }
  });

  it('ACCEPTS a well-formed cleanup payload (workspaceId + dryRun) through the router seam', () => {
    for (const channel of CLEANUP_CHANNELS) {
      const out = validateChannelInput(channel, { workspaceId: 'ws-1', dryRun: false });
      expect(out).toEqual({ workspaceId: 'ws-1', dryRun: false });
    }
  });

  it('ACCEPTS a minimal payload (workspaceId only — dryRun is optional)', () => {
    const out = validateChannelInput('cleanup.removeWorkspace', { workspaceId: 'ws-1' });
    expect(out).toEqual({ workspaceId: 'ws-1' });
  });

  it('REJECTS a malformed payload (wrong-typed workspaceId) at the boundary', () => {
    for (const channel of CLEANUP_CHANNELS) {
      expect(
        () => validateChannelInput(channel, { workspaceId: 42, dryRun: false }),
        `${channel} must throw on a numeric workspaceId`,
      ).toThrow(z.ZodError);
    }
  });

  it('REJECTS a missing workspaceId', () => {
    expect(() => validateChannelInput('cleanup.removeWorkspace', { dryRun: true })).toThrow(
      z.ZodError,
    );
  });

  it('REJECTS an empty-string workspaceId (min(1))', () => {
    expect(() => validateChannelInput('cleanup.clearPanes', { workspaceId: '' })).toThrow(
      z.ZodError,
    );
  });

  it('REJECTS a wrong-typed dryRun (must be boolean when present)', () => {
    expect(() =>
      validateChannelInput('cleanup.pruneWorktrees', { workspaceId: 'ws-1', dryRun: 'yes' }),
    ).toThrow(z.ZodError);
  });

  it('PASSES THROUGH unknown extra keys (.passthrough — permissive, not z.any)', () => {
    const out = validateChannelInput('cleanup.removeWorkspace', {
      workspaceId: 'ws-1',
      dryRun: false,
      futureFlag: 'ignored',
    });
    expect(out).toMatchObject({ workspaceId: 'ws-1', dryRun: false, futureFlag: 'ignored' });
  });
});
