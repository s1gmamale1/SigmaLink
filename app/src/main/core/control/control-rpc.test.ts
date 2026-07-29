import { describe, it, expect, vi } from 'vitest';
import { buildControlController } from './control-rpc';

function fakeKv() { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) }; }
function fakeCreds(initial?: string) { let v = initial ?? null; return { get: async () => v, set: async (_k: string, nv: string) => { v = nv; }, remove: async () => true, isEncryptionAvailable: () => true }; }

describe('control-rpc', () => {
  it('enable/disable toggle the flag and start/stop the host', async () => {
    const start = vi.fn(async () => {}); const stop = vi.fn();
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('tok'), socketPath: '/tmp/c.sock', execPath: '/app/electron', serverEntry: '/app/x.cjs', start, stop, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {} });
    let s = await ctl.enable(); expect(s.enabled).toBe(true); expect(start).toHaveBeenCalled();
    s = await ctl.disable(); expect(s.enabled).toBe(false); expect(stop).toHaveBeenCalled();
  });
  it('freeze/unfreeze toggle the kill-switch', async () => {
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('tok'), socketPath: '/tmp/c.sock', execPath: '/app/electron', serverEntry: '/app/x.cjs', start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {} });
    expect((await ctl.freeze()).frozen).toBe(true);
    expect((await ctl.unfreeze()).frozen).toBe(false);
  });
  it('connectCommand includes socket + token + server entry', async () => {
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('secret-tok'), socketPath: '/tmp/c.sock', execPath: '/app/electron', serverEntry: '/app/x.cjs', start: async () => {}, stop: () => {}, liveConnections: () => 2, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {} });
    const { command } = await ctl.connectCommand();
    expect(command).toContain('/tmp/c.sock'); expect(command).toContain('secret-tok'); expect(command).toContain('/app/x.cjs');
    expect(command).toContain('SIGMA_CONTROL_LABEL');
  });
  it('connect command launches Electron-as-node — never bare `node` on an asar path', async () => {
    // Packaged reality: asar:true makes app.getAppPath() return
    // <...>/Resources/app.asar, and plain `node` cannot read inside an asar
    // archive (MODULE_NOT_FOUND). The bundled Electron binary CAN, when
    // ELECTRON_RUN_AS_NODE=1 tells it to behave as node.
    const execPath = '/Applications/SigmaLink.app/Contents/MacOS/SigmaLink';
    const serverEntry =
      '/Applications/SigmaLink.app/Contents/Resources/app.asar/electron-dist/mcp-sigma-control-server.cjs';
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('tok'), socketPath: '/tmp/c.sock', execPath, serverEntry, start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {} });
    const { command } = await ctl.connectCommand();
    expect(command).not.toMatch(/--\s+'?node'?\s/);
    expect(command).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(command).toContain(`-- '${execPath}' '${serverEntry}'`);
  });
  it('rotateToken rotates + pushes the new token via setBearer', async () => {
    const setBearer = vi.fn(); const creds = fakeCreds('old');
    const ctl = buildControlController({ kv: fakeKv(), credentials: creds, socketPath: '/s', execPath: '/app/electron', serverEntry: '/e', start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {} });
    await ctl.rotateToken();
    expect(setBearer).toHaveBeenCalledTimes(1);
    expect(setBearer.mock.calls[0][0]).toHaveLength(64);
  });
  it('respondEscalation forwards to the escalator', async () => {
    const respondEscalation = vi.fn();
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('t'), socketPath: '/s', execPath: '/app/electron', serverEntry: '/e', start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation, cancelEscalations: () => {}, reportViewport: () => {} });
    await ctl.respondEscalation({ id: 'esc-1', approved: true });
    expect(respondEscalation).toHaveBeenCalledWith('esc-1', true);
  });
  it('freeze AND disable cancel in-flight escalations (kill-switch authority over pending approvals)', async () => {
    const cancelEscalations = vi.fn();
    const mk = () => buildControlController({ kv: fakeKv(), credentials: fakeCreds('t'), socketPath: '/s', execPath: '/app/electron', serverEntry: '/e', start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations, reportViewport: () => {} });
    await mk().freeze();
    expect(cancelEscalations).toHaveBeenCalledTimes(1);
    await mk().disable();
    expect(cancelEscalations).toHaveBeenCalledTimes(2);
  });
});
