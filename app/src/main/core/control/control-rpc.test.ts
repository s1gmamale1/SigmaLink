import { describe, it, expect, vi } from 'vitest';
import { buildControlController, quoteArg } from './control-rpc';

function fakeKv() { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) }; }
function fakeCreds(initial?: string) { let v = initial ?? null; return { get: async () => v, set: async (_k: string, nv: string) => { v = nv; }, remove: async () => true, isEncryptionAvailable: () => true }; }

describe('control-rpc', () => {
  it('enable/disable toggle the flag and start/stop the host', async () => {
    const start = vi.fn(async () => {}); const stop = vi.fn();
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('tok'), socketPath: '/tmp/c.sock', execPath: '/app/electron', serverEntry: '/app/x.cjs', start, stop, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {}, platform: 'darwin' });
    let s = await ctl.enable(); expect(s.enabled).toBe(true); expect(start).toHaveBeenCalled();
    s = await ctl.disable(); expect(s.enabled).toBe(false); expect(stop).toHaveBeenCalled();
  });
  it('freeze/unfreeze toggle the kill-switch', async () => {
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('tok'), socketPath: '/tmp/c.sock', execPath: '/app/electron', serverEntry: '/app/x.cjs', start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {}, platform: 'darwin' });
    expect((await ctl.freeze()).frozen).toBe(true);
    expect((await ctl.unfreeze()).frozen).toBe(false);
  });
  it('connectCommand includes socket + token + server entry', async () => {
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('secret-tok'), socketPath: '/tmp/c.sock', execPath: '/app/electron', serverEntry: '/app/x.cjs', start: async () => {}, stop: () => {}, liveConnections: () => 2, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {}, platform: 'darwin' });
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
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('tok'), socketPath: '/tmp/c.sock', execPath, serverEntry, start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {}, platform: 'darwin' });
    const { command } = await ctl.connectCommand();
    expect(command).not.toMatch(/--\s+'?node'?\s/);
    expect(command).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(command).toContain(`-- '${execPath}' '${serverEntry}'`);
  });
  // --- platform-aware quoting -------------------------------------------
  // cmd.exe does NOT treat `'` as a quoting character: it passes the byte
  // through literally and still splits argv on spaces. An NSIS install into
  // `C:\Program Files\SigmaLink` (electron-builder.yml allows choosing the
  // directory) therefore registered an MCP server that could never spawn.
  const WIN_EXEC = 'C:\\Program Files\\SigmaLink\\SigmaLink.exe';
  const WIN_ENTRY =
    'C:\\Program Files\\SigmaLink\\resources\\app.asar\\electron-dist\\mcp-sigma-control-server.cjs';
  const WIN_PIPE = '\\\\.\\pipe\\sigmalink-control-deadbeef';

  it('quoteArg double-quotes on win32 and single-quotes elsewhere', () => {
    expect(quoteArg(WIN_EXEC, 'win32')).toBe(`"${WIN_EXEC}"`);
    expect(quoteArg('/app/electron', 'darwin')).toBe(`'/app/electron'`);
    expect(quoteArg('/app/electron', 'linux')).toBe(`'/app/electron'`);
  });

  it('win32 connect command keeps a spaced Program Files execPath as ONE argv token', async () => {
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('tok'), socketPath: WIN_PIPE, execPath: WIN_EXEC, serverEntry: WIN_ENTRY, start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {}, platform: 'win32' });
    const { command } = await ctl.connectCommand();
    expect(command).toContain(`-- "${WIN_EXEC}" "${WIN_ENTRY}"`);
    // The literal-quote failure mode: cmd.exe would receive `'C:\Program`.
    expect(command).not.toContain(`'${WIN_EXEC}'`);
  });

  it('win32 connect command double-quotes the named-pipe socket, token and label', async () => {
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('win-tok'), socketPath: WIN_PIPE, execPath: WIN_EXEC, serverEntry: WIN_ENTRY, start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {}, platform: 'win32' });
    const { command } = await ctl.connectCommand();
    expect(command).toContain(`SIGMA_CONTROL_SOCKET="${WIN_PIPE}"`);
    expect(command).toContain('SIGMA_CONTROL_TOKEN="win-tok"');
    expect(command).toContain('SIGMA_CONTROL_LABEL="external"');
    // No single quote may survive anywhere — every one of them is a literal
    // character to cmd.exe, so a stray pair corrupts the value it wraps.
    expect(command).not.toContain("'");
  });

  it('posix connect command is byte-for-byte unchanged (single quotes)', async () => {
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('secret-tok'), socketPath: '/tmp/c.sock', execPath: '/app/electron', serverEntry: '/app/x.cjs', start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {}, platform: 'darwin' });
    const { command } = await ctl.connectCommand();
    expect(command).toBe(
      "claude mcp add sigmalink -e ELECTRON_RUN_AS_NODE=1 -e SIGMA_CONTROL_SOCKET='/tmp/c.sock' -e SIGMA_CONTROL_TOKEN='secret-tok' -e SIGMA_CONTROL_LABEL='external' -- '/app/electron' '/app/x.cjs'",
    );
  });

  it('rotateToken rotates + pushes the new token via setBearer', async () => {
    const setBearer = vi.fn(); const creds = fakeCreds('old');
    const ctl = buildControlController({ kv: fakeKv(), credentials: creds, socketPath: '/s', execPath: '/app/electron', serverEntry: '/e', start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer, respondEscalation: () => {}, cancelEscalations: () => {}, reportViewport: () => {}, platform: 'darwin' });
    await ctl.rotateToken();
    expect(setBearer).toHaveBeenCalledTimes(1);
    expect(setBearer.mock.calls[0][0]).toHaveLength(64);
  });
  it('respondEscalation forwards to the escalator', async () => {
    const respondEscalation = vi.fn();
    const ctl = buildControlController({ kv: fakeKv(), credentials: fakeCreds('t'), socketPath: '/s', execPath: '/app/electron', serverEntry: '/e', start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation, cancelEscalations: () => {}, reportViewport: () => {}, platform: 'darwin' });
    await ctl.respondEscalation({ id: 'esc-1', approved: true });
    expect(respondEscalation).toHaveBeenCalledWith('esc-1', true);
  });
  it('freeze AND disable cancel in-flight escalations (kill-switch authority over pending approvals)', async () => {
    const cancelEscalations = vi.fn();
    const mk = () => buildControlController({ kv: fakeKv(), credentials: fakeCreds('t'), socketPath: '/s', execPath: '/app/electron', serverEntry: '/e', start: async () => {}, stop: () => {}, liveConnections: () => 0, setBearer: () => {}, respondEscalation: () => {}, cancelEscalations, reportViewport: () => {}, platform: 'darwin' });
    await mk().freeze();
    expect(cancelEscalations).toHaveBeenCalledTimes(1);
    await mk().disable();
    expect(cancelEscalations).toHaveBeenCalledTimes(2);
  });
});
