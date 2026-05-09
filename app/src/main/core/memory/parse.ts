// Wikilink extractor. Recognizes `[[Name]]` and `[[Name|Alias]]` patterns and
// returns byte ranges for downstream renderers. Skips fenced code blocks and
// backslash-escaped brackets so notes that mention markdown syntax verbatim
// don't generate spurious links.

import type { Wikilink } from './types';

const FENCE_RE = /^(\s*)(```|~~~)/;

/** Extract every `[[link]]` outside fenced code blocks. */
export function extractWikilinks(body: string): Wikilink[] {
  const out: Wikilink[] = [];
  if (!body) return out;

  // Walk line-by-line to track fenced regions. We compute line offsets so we
  // can convert to absolute body offsets when we find a match.
  const lines = body.split(/\r?\n/);
  let inFence = false;
  let fenceMarker: '```' | '~~~' | null = null;
  let cursor = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineEol = li < lines.length - 1 ? 1 : 0; // approximation; recovered with cursor below
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[2] as '```' | '~~~';
      } else if (isFenceClose(fenceMarker, line)) {
        inFence = false;
        fenceMarker = null;
      }
      cursor += line.length + lineEol;
      continue;
    }

    if (!inFence) {
      // Scan the line for [[...]] occurrences manually so we can skip escapes.
      let i = 0;
      while (i < line.length) {
        const idx = line.indexOf('[[', i);
        if (idx === -1) break;
        // Backslash-escaped open bracket: skip
        if (idx > 0 && line[idx - 1] === '\\') {
          i = idx + 2;
          continue;
        }
        const close = line.indexOf(']]', idx + 2);
        if (close === -1) break;
        const inner = line.slice(idx + 2, close);
        // Reject empty / multi-line content (already line-bounded) / pipes-only
        if (!inner.trim()) {
          i = close + 2;
          continue;
        }
        const pipeIdx = inner.indexOf('|');
        let target: string;
        let alias: string | undefined;
        if (pipeIdx === -1) {
          target = inner.trim();
        } else {
          target = inner.slice(0, pipeIdx).trim();
          const rawAlias = inner.slice(pipeIdx + 1).trim();
          alias = rawAlias.length > 0 ? rawAlias : undefined;
        }
        if (target.length > 0 && !target.includes('[') && !target.includes(']')) {
          out.push({
            target,
            alias,
            range: [cursor + idx, cursor + close + 2],
          });
        }
        i = close + 2;
      }
    }
    cursor += line.length + lineEol;
  }

  return out;
}

/** True when `line` closes the current fence. */
function isFenceClose(marker: '```' | '~~~' | null, line: string): boolean {
  if (!marker) return false;
  return new RegExp(`^\\s*${marker}\\s*$`).test(line);
}

/**
 * De-duplicated, ordered list of unique link targets in `body`. Useful for
 * persisting outgoing edges; the parser preserves first-seen order.
 */
export function uniqueLinkTargets(body: string): string[] {
  const links = extractWikilinks(body);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of links) {
    const key = l.target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l.target);
  }
  return out;
}

/**
 * Render `body` into safe HTML with `[[wiki]]` chips replaced by `<a
 * data-wikilink="...">`. NOT a full markdown renderer — the editor preview
 * uses this output as the textual baseline before piping it through the
 * renderer's markdown lib.
 */
export function transformWikilinksToAnchors(
  body: string,
  exists: (target: string) => boolean,
): string {
  const links = extractWikilinks(body);
  if (links.length === 0) return body;
  const parts: string[] = [];
  let last = 0;
  for (const l of links) {
    parts.push(body.slice(last, l.range[0]));
    const text = l.alias ?? l.target;
    const cls = exists(l.target) ? 'wikilink' : 'wikilink wikilink-missing';
    const safeTarget = l.target.replace(/"/g, '&quot;');
    const safeText = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    parts.push(
      `<a class="${cls}" data-wikilink="${safeTarget}" href="#">${safeText}</a>`,
    );
    last = l.range[1];
  }
  parts.push(body.slice(last));
  return parts.join('');
}
