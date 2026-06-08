import { describe, expect, it } from 'vitest';
import { buildClaudeMcpLaunchArgs } from './mcp-launch-mode';

describe('buildClaudeMcpLaunchArgs', () => {
  it('returns no args for inherited MCP mode', () => {
    expect(buildClaudeMcpLaunchArgs({ mode: 'inherit' })).toEqual([]);
  });

  it('returns strict empty MCP config for no-MCP diagnostic mode', () => {
    expect(buildClaudeMcpLaunchArgs({ mode: 'none' })).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ]);
  });

  it('returns strict core config with Ruflo HTTP URL when provided', () => {
    const args = buildClaudeMcpLaunchArgs({
      mode: 'strict-core',
      rufloHttpUrl: 'http://127.0.0.1:4317/mcp',
    });

    expect(args[0]).toBe('--strict-mcp-config');
    expect(args[1]).toBe('--mcp-config');
    expect(JSON.parse(args[2]!).mcpServers.ruflo.type).toBe('http');
    expect(JSON.parse(args[2]!).mcpServers.ruflo.url).toBe('http://127.0.0.1:4317/mcp');
  });

  it('falls back to strict empty config when strict core has no HTTP URL', () => {
    expect(buildClaudeMcpLaunchArgs({ mode: 'strict-core', rufloHttpUrl: null })).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ]);
  });
});
