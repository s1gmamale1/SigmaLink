// Lightweight wikilink helpers for the renderer. Mirrors the main-process
// `parse.ts` semantics — same regex / same fence handling — without pulling
// any Node-only dependencies in.

export interface RendererWikilink {
  target: string;
  alias?: string;
  range: [number, number];
}

const FENCE_RE = /^(\s*)(```|~~~)/;

export function extractWikilinks(body: string): RendererWikilink[] {
  const out: RendererWikilink[] = [];
  if (!body) return out;
  const lines = body.split(/\r?\n/);
  let cursor = 0;
  let inFence = false;
  let marker: '```' | '~~~' | null = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const eol = li < lines.length - 1 ? 1 : 0;
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        marker = fence[2] as '```' | '~~~';
      } else if (marker && new RegExp(`^\\s*${marker}\\s*$`).test(line)) {
        inFence = false;
        marker = null;
      }
      cursor += line.length + eol;
      continue;
    }
    if (!inFence) {
      let i = 0;
      while (i < line.length) {
        const idx = line.indexOf('[[', i);
        if (idx === -1) break;
        if (idx > 0 && line[idx - 1] === '\\') {
          i = idx + 2;
          continue;
        }
        const close = line.indexOf(']]', idx + 2);
        if (close === -1) break;
        const inner = line.slice(idx + 2, close);
        if (!inner.trim()) {
          i = close + 2;
          continue;
        }
        const pipe = inner.indexOf('|');
        let target: string;
        let alias: string | undefined;
        if (pipe === -1) {
          target = inner.trim();
        } else {
          target = inner.slice(0, pipe).trim();
          const a = inner.slice(pipe + 1).trim();
          alias = a || undefined;
        }
        if (target && !target.includes('[') && !target.includes(']')) {
          out.push({ target, alias, range: [cursor + idx, cursor + close + 2] });
        }
        i = close + 2;
      }
    }
    cursor += line.length + eol;
  }
  return out;
}

/**
 * Render `body` to a sequence of plain / wikilink chunks. The renderer
 * decides how to display each chunk; we keep this side-effect free so it can
 * be unit-tested without React.
 */
export type RenderChunk =
  | { kind: 'text'; value: string }
  | { kind: 'wikilink'; target: string; alias?: string };

export function renderChunks(body: string): RenderChunk[] {
  const links = extractWikilinks(body);
  if (links.length === 0) return [{ kind: 'text', value: body }];
  const out: RenderChunk[] = [];
  let last = 0;
  for (const l of links) {
    if (l.range[0] > last) {
      out.push({ kind: 'text', value: body.slice(last, l.range[0]) });
    }
    out.push({ kind: 'wikilink', target: l.target, alias: l.alias });
    last = l.range[1];
  }
  if (last < body.length) out.push({ kind: 'text', value: body.slice(last) });
  return out;
}

export function uniqueLinkTargets(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of extractWikilinks(body)) {
    const k = l.target.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l.target);
  }
  return out;
}
