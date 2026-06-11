import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Presence guard for the `panes.close` RPC across ALL FIVE mirror surfaces
// (P14 quint lesson — a missed sibling stays gate-green while the bridge
// hard-rejects at runtime). The channel surfaces register the literal
// `'panes.close'` token; router-shape declares a `close(` method on the
// `panes` interface; schemas register the `'panes.close'` key.
describe('panes.close RPC is declared in every sibling surface', () => {
  it('router-shape.ts declares panes.close on the panes interface', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/shared/router-shape.ts'), 'utf8');
    expect(/\bclose:\s*\(sessionId:\s*string\)/.test(src)).toBe(true);
  });

  const channelFiles = [
    'src/shared/rpc-channels.ts',
    'src/shared/rpc-channels.test.ts', // the defensive TYPED_ROUTER_CHANNELS hand-list
    'src/main/core/rpc/schemas.ts',
  ];
  it.each(channelFiles)('%s registers the panes.close channel', (f) => {
    const src = readFileSync(resolve(process.cwd(), f), 'utf8');
    expect(src.includes("'panes.close'")).toBe(true);
  });
});
