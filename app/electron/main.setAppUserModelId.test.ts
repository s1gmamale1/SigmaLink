import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const SRC = readFileSync(resolve(__dirname, 'main.ts'), 'utf8');
describe('RC2b — setAppUserModelId win32 guard', () => {
  it('contains the platform-gated call', () => { expect(SRC).toContain("app.setAppUserModelId('com.sigmalink.agentorchestrator')"); });
  it('call before app.whenReady()', () => { const c=SRC.indexOf("app.setAppUserModelId('com.sigmalink.agentorchestrator')"); const r=SRC.indexOf('app.whenReady()'); expect(c).toBeGreaterThan(-1); expect(r).toBeGreaterThan(-1); expect(c).toBeLessThan(r); });
  it('guarded by win32', () => { const c=SRC.indexOf("app.setAppUserModelId('com.sigmalink.agentorchestrator')"); const g=SRC.lastIndexOf("process.platform === 'win32'", c); expect(g).toBeGreaterThan(-1); expect(g).toBeLessThan(c); });
});
