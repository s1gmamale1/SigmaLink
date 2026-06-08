// BUG-4 — schema-registry tests for the side-band channels that the
// rpc-router registers OUTSIDE the typed AppRouter loop. Unlike validate.test.ts
// (which mocks the registry to exercise the validator's branches), this suite
// drives the REAL `CHANNEL_SCHEMAS` through the REAL `validateChannelInput`
// (enforce mode) so a regression that drops/loosens a side-band schema entry
// fails here. Pure node test: schemas.ts imports only zod — no Electron, no DB,
// no native modules.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getChannelSchema, CHANNEL_SCHEMAS } from './schemas';
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

// DEV-6 — every channel that was missing a schema entry before this ticket
// must now have an entry in CHANNEL_SCHEMAS. This is a pure registry test
// (no Electron/DB/native modules); adding a channel here without a
// CHANNEL_SCHEMAS entry will make this suite fail at import time.
describe('DEV-6 — previously-missing channel schemas are now registered', () => {
  const DEV6_CHANNELS = [
    // app.*
    'app.quitAndInstall',
    'app.revealInFolder',
    'app.openShell',
    'app.getUserDataPath',
    'app.dismissedWorktreeBanner',
    // pty.*
    'pty.spawnScratch',
    'pty.killScratch',
    // panes.*
    'panes.listForWorkspace',
    'panes.setDisplayProvider',
    'panes.brief',
    // providers.*
    'providers.spawnInstall',
    'providers.setInstallConsent',
    'providers.getInstallConsent',
    // fs.*
    'fs.getWorktreeSizes',
    // browser.*
    'browser.listRecents',
    'browser.focusView',
    'browser.detachToWindow',
    'browser.reattach',
    // skills.*
    'skills.listInstalled',
    'skills.attach',
    'skills.detach',
    'skills.listBindings',
    // memory.*
    'memory.find_unlinked_mentions',
    'memory.list_tags',
    'memory.list_by_tag',
    'memory.export_db',
    'memory.import_db',
    // assistant.*
    'assistant.dispatchBulk',
    'assistant.refResolve',
    // ruflo.*
    'ruflo.entries.list',
    'ruflo.entries.neighbors',
    'ruflo.daemonStatus',
    'ruflo.restartDaemon',
    // sync.*
    'sync.enable',
    'sync.disable',
    'sync.status',
    'sync.listConflicts',
    'sync.resolveConflict',
    'sync.exportMnemonic',
    'sync.isConfigured',
    'sync.recoverFromMnemonic',
    // telegram.*
    'telegram.getStatus',
    'telegram.setToken',
    'telegram.clearToken',
    'telegram.setEnabled',
    'telegram.setAllowlist',
    'telegram.setIdleLockMinutes',
    'telegram.lock',
    'telegram.unlock',
    'telegram.auditTail',
  ] as const;

  it('every DEV-6 channel has an entry in CHANNEL_SCHEMAS', () => {
    const missing: string[] = [];
    for (const ch of DEV6_CHANNELS) {
      if (!(ch in CHANNEL_SCHEMAS)) missing.push(ch);
    }
    expect(
      missing,
      `These channels still have no schema entry: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });

  it('every DEV-6 channel schema has at least an input field declared', () => {
    for (const ch of DEV6_CHANNELS) {
      const schema = getChannelSchema(ch);
      expect(schema, `${ch} must have a schema entry`).toBeDefined();
      // input field must be present (even if z.undefined/z.any — the key matters)
      expect(
        'input' in schema!,
        `${ch} must declare an input field in its schema`,
      ).toBe(true);
    }
  });
});

describe('Phase 2 RAM Brake — session risk schema', () => {
  it('registers a concrete schema for ramBrake.sessionRisk', () => {
    const schema = getChannelSchema('ramBrake.sessionRisk');
    expect(schema, 'ramBrake.sessionRisk must have a schema entry').toBeDefined();
    expect(schema?.input?.safeParse({ providerId: 42, cwd: '/tmp/ws' }).success).toBe(false);
    expect(
      schema?.input?.safeParse({
        providerId: 'claude',
        cwd: '/tmp/ws',
        externalSessionId: '37846eca-4143-4f3b-a1b5-5fe919ddf2b3',
      }).success,
    ).toBe(true);
  });
});
