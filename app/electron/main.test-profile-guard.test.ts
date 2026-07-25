import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'main.ts'), 'utf8');

describe('Electron test-profile boot guard wiring', () => {
  it('checks isolation before app readiness can register production services', () => {
    const guardCall = source.indexOf('assertIsolatedTestProfile({');
    const readyCall = source.indexOf('app.whenReady()');
    expect(guardCall).toBeGreaterThan(-1);
    expect(readyCall).toBeGreaterThan(-1);
    expect(guardCall).toBeLessThan(readyCall);
  });
});
