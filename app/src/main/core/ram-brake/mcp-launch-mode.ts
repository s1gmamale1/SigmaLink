import type { McpLaunchMode } from '../../../shared/types';

export interface BuildClaudeMcpLaunchArgsInput {
  mode: McpLaunchMode;
  rufloHttpUrl?: string | null;
}

export function buildClaudeMcpLaunchArgs(input: BuildClaudeMcpLaunchArgsInput): string[] {
  if (input.mode === 'inherit') return [];
  if (input.mode === 'none') {
    return ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} })];
  }
  if (input.mode === 'strict-core' && input.rufloHttpUrl) {
    return [
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          ruflo: {
            type: 'http',
            url: input.rufloHttpUrl,
          },
        },
      }),
    ];
  }
  return ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} })];
}
