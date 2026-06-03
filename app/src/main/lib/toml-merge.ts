// Shared, marker-independent TOML table merge helpers.
//
// Agent CLIs (codex) own their config.toml and run their OWN TOML rewriter that
// strips / relocates comments — which orphaned our old marker-pair regex and
// piled up duplicate `[mcp_servers.browser]` tables (B1). The robust approach is
// to find + collapse tables by NAME, never by comment marker.
//
// Extracted from core/workspaces/mcp-autowrite.ts so the ruflo autowrite and the
// browser/codex writer share ONE implementation.

export interface TomlTableRange {
  header: string;
  start: number;
  end: number;
}

/**
 * Find every TOML table whose header equals `tablePrefix` OR starts with
 * `${tablePrefix}.` (so `mcp_servers.sigmamemory` also catches its `.env`
 * sub-table). A table's range runs from its `[header]` line to the next table
 * header (or EOF). Naked `mcp_servers.browser` and `mcp_servers.browserXYZ` do
 * NOT collide — the dot boundary is required.
 */
export function findTomlTableRanges(source: string, tablePrefix: string): TomlTableRange[] {
  const headerRe = /^\s*\[([^\]]+)\]\s*$/gm;
  const headers: Array<{ header: string; start: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(source))) {
    headers.push({ header: match[1].trim(), start: match.index });
  }

  const ranges: TomlTableRange[] = [];
  for (let i = 0; i < headers.length; i += 1) {
    const current = headers[i];
    if (current.header !== tablePrefix && !current.header.startsWith(`${tablePrefix}.`)) {
      continue;
    }
    ranges.push({
      header: current.header,
      start: current.start,
      end: i + 1 < headers.length ? headers[i + 1].start : source.length,
    });
  }
  return ranges;
}

/**
 * Remove the given table ranges (back-to-front so earlier indices stay valid)
 * and append `replacement` once at the end. Idempotent: re-running finds the
 * just-appended table by name, removes it, and re-appends — a stable fixpoint.
 */
export function replaceTomlTables(
  source: string,
  ranges: TomlTableRange[],
  replacement: string,
): string {
  let next = source;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, range.start) + next.slice(range.end);
  }
  next = next.trimEnd();
  return next.length > 0 ? `${next}\n\n${replacement}` : replacement;
}

/**
 * Drop any lines that are exactly (trimmed) one of `markers`. Used to sweep
 * legacy `# sigmalink-*` comment markers a TOML rewriter may have orphaned, so
 * they never accumulate. Marker-equality only — never touches table content.
 */
export function stripMarkerLines(source: string, markers: readonly string[]): string {
  if (markers.length === 0) return source;
  const set = new Set(markers.map((m) => m.trim()));
  return source
    .split('\n')
    .filter((line) => !set.has(line.trim()))
    .join('\n');
}
