import { describe, expect, it } from 'vitest';
import { findTomlTableRanges, replaceTomlTables, stripMarkerLines } from './toml-merge';

const LEGACY_MARKERS = [
  '# sigmalink-browser',
  '# end sigmalink-browser',
  '# sigmalink-memory',
  '# end sigmalink-memory',
] as const;

const BROWSER_BLOCK = [
  '[mcp_servers.browser]',
  'transport = "stdio"',
  'command = "npx"',
  'args = ["-y", "@playwright/mcp@0.0.75"]',
].join('\n');

const MEMORY_BLOCK = [
  '[mcp_servers.sigmamemory]',
  'transport = "stdio"',
  'command = "node"',
  'args = ["mcp-memory-server.cjs"]',
  '[mcp_servers.sigmamemory.env]',
  'SIGMALINK_DB_PATH = "/x/sigmalink.db"',
].join('\n');

// The exact B1 failure shape from the live ~/.codex/config.toml: codex's TOML
// rewriter orphaned our markers and THREE [mcp_servers.browser] tables piled up
// (naked, orphaned-with-end-marker, complete), alongside unrelated tables.
const BROKEN_CODEX = `[model_providers.openai]
name = "OpenAI"

[mcp_servers.browser]
transport = "stdio"
command = "npx"
args = ["-y", "@playwright/mcp@0.0.75"]

[mcp_servers.sigmamemory]
command = "node"
args = ["old.cjs"]
[mcp_servers.sigmamemory.env]
SIGMALINK_DB_PATH = "/old/sigmalink.db"

# sigmalink-browser
[tui.model_availability_nux]
"gpt-5.5" = 4
[mcp_servers.browser]
transport = "stdio"
command = "npx"
args = ["-y", "@playwright/mcp@0.0.75"]
# end sigmalink-browser

[mcp_servers.ruflo]
command = "npx"
args = ["-y","@claude-flow/cli@latest","mcp","start"]

[mcp_servers.browser]
transport = "stdio"
command = "npx"
args = ["-y", "@playwright/mcp@0.0.75"]
`;

/** Mirror the codex writer's collapse sequence. */
function collapse(source: string): string {
  let next = stripMarkerLines(source, LEGACY_MARKERS);
  next = replaceTomlTables(next, findTomlTableRanges(next, 'mcp_servers.browser'), BROWSER_BLOCK);
  next = replaceTomlTables(next, findTomlTableRanges(next, 'mcp_servers.sigmamemory'), MEMORY_BLOCK);
  return next;
}

// Count exact `[header]` table lines without a dynamic RegExp (repo ReDoS rule).
const count = (s: string, header: string) =>
  s.split('\n').filter((l) => l.trim() === `[${header}]`).length;

describe('toml-merge — B1 codex duplicate-table collapse', () => {
  it('collapses 3 duplicate browser tables to ONE, dedups sigmamemory, preserves others, strips markers', () => {
    const out = collapse(BROKEN_CODEX);
    expect(count(out, 'mcp_servers.browser'), 'exactly one browser table').toBe(1);
    expect(count(out, 'mcp_servers.sigmamemory'), 'exactly one sigmamemory table').toBe(1);
    expect(count(out, 'mcp_servers.sigmamemory.env'), 'one sigmamemory.env subtable').toBe(1);
    // unrelated tables survive untouched
    expect(out).toContain('[mcp_servers.ruflo]');
    expect(out).toContain('[tui.model_availability_nux]');
    expect(out).toContain('[model_providers.openai]');
    // legacy markers swept
    expect(out).not.toContain('# sigmalink-browser');
    expect(out).not.toContain('# end sigmalink-browser');
    // the surviving sigmamemory points at the FRESH block, not the stale one
    expect(out).toContain('SIGMALINK_DB_PATH = "/x/sigmalink.db"');
    expect(out).not.toContain('/old/sigmalink.db');
  });

  it('is an idempotent fixpoint — re-running the writer yields identical output', () => {
    const once = collapse(BROKEN_CODEX);
    const twice = collapse(once);
    expect(twice).toBe(once);
    expect(count(twice, 'mcp_servers.browser')).toBe(1);
  });

  it('produces output with no duplicate table headers (valid TOML, codex can load it)', () => {
    const out = collapse(BROKEN_CODEX);
    const headers = (out.match(/^\[[^\]]+\]\s*$/gm) ?? []).map((h) => h.trim());
    expect(new Set(headers).size, 'no duplicate table keys').toBe(headers.length);
  });

  it('writes a fresh block into an empty file', () => {
    const out = collapse('');
    expect(count(out, 'mcp_servers.browser')).toBe(1);
    expect(count(out, 'mcp_servers.sigmamemory')).toBe(1);
  });

  it('findTomlTableRanges respects the dot boundary (no prefix false-match)', () => {
    const src = '[mcp_servers.browser]\nx=1\n\n[mcp_servers.browserbeam]\ny=2\n';
    const ranges = findTomlTableRanges(src, 'mcp_servers.browser');
    expect(ranges.map((r) => r.header)).toEqual(['mcp_servers.browser']);
  });

  it('findTomlTableRanges matches a prefix sub-table (.env)', () => {
    const src = '[mcp_servers.sigmamemory]\na=1\n[mcp_servers.sigmamemory.env]\nB="c"\n';
    const ranges = findTomlTableRanges(src, 'mcp_servers.sigmamemory');
    expect(ranges.map((r) => r.header)).toEqual([
      'mcp_servers.sigmamemory',
      'mcp_servers.sigmamemory.env',
    ]);
  });

  it('stripMarkerLines removes only exact marker lines, never table content', () => {
    const src = '# sigmalink-browser\n[mcp_servers.browser]\ncommand = "npx"\n';
    const out = stripMarkerLines(src, LEGACY_MARKERS);
    expect(out).not.toContain('# sigmalink-browser');
    expect(out).toContain('[mcp_servers.browser]');
    expect(out).toContain('command = "npx"');
  });
});
