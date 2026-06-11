// Contract tests locking the three Jorvis tool surfaces together:
//   • tools.ts TOOLS — authoritative handlers
//   • tool-catalogue.ts — the MCP tools/list; under `--strict-mcp-config`
//     (runClaudeCliTurn.args.ts) this is the ONLY surface the CLI can call
//   • system-prompt.ts TOOL_BLURB — what the model is told it can call
//
// Drift between these caused the 2026-06-11 "Jorvis can't interact" bug:
// close_pane was advertised in the system prompt but absent from the MCP
// catalogue, so the model's calls failed inside the CLI — invisible to the
// tool tracer (zero ok:false traces ever recorded).
import { describe, expect, it, vi } from 'vitest';

// Same mock set as tools.test.ts — importing tools.ts must not load
// better-sqlite3 (Electron-ABI; cannot load under vitest) or real launchers.
vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
vi.mock('../browser/cdp', () => ({
  runCDP: vi.fn(),
  attachDebugger: vi.fn(() => true),
  detachDebugger: vi.fn(),
}));
vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: vi.fn(async () => ({ sessions: [] })),
}));

import { JORVIS_TOOL_CATALOGUE } from './tool-catalogue';
import { TOOLS } from './tools';
import { buildJorvisSystemPrompt } from './system-prompt';

const catalogueNames = JORVIS_TOOL_CATALOGUE.map((t) => t.name).sort();
const toolIds = TOOLS.map((t) => t.id).sort();

describe('jorvis tool catalogue parity', () => {
  it('catalogue names exactly match tools.ts ids (no drift in either direction)', () => {
    expect(catalogueNames).toEqual(toolIds);
  });

  it('catalogue required args match tools.ts inputSchema.required per tool', () => {
    for (const cat of JORVIS_TOOL_CATALOGUE) {
      const tool = TOOLS.find((t) => t.id === cat.name);
      expect(tool, `tools.ts is missing ${cat.name}`).toBeDefined();
      const catReq = [...(cat.inputSchema.required ?? [])].sort();
      const toolReq = [
        ...((tool!.inputSchema as { required?: string[] }).required ?? []),
      ].sort();
      expect(catReq, `required mismatch for ${cat.name}`).toEqual(toolReq);
    }
  });

  it('catalogue property keys match tools.ts schema properties per tool', () => {
    for (const cat of JORVIS_TOOL_CATALOGUE) {
      const tool = TOOLS.find((t) => t.id === cat.name)!;
      const catProps = Object.keys(cat.inputSchema.properties).sort();
      const toolProps = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).sort();
      expect(catProps, `properties mismatch for ${cat.name}`).toEqual(toolProps);
    }
  });

  it('the system prompt blurb mentions every catalogue tool by name', () => {
    const prompt = buildJorvisSystemPrompt({ workspaceName: 'w', workspaceRoot: '/tmp/w' });
    for (const cat of JORVIS_TOOL_CATALOGUE) {
      expect(prompt, `system prompt is missing ${cat.name}`).toContain(cat.name);
    }
  });
});
