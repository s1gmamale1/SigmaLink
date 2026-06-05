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

/** True when `line` closes the current fence. A closing fence is a line that is
 *  ONLY the marker plus optional surrounding whitespace — equivalent to the old
 *  `^\s*<marker>\s*$` regex but without a (lint-flagged) dynamic RegExp. */
function isFenceClose(marker: '```' | '~~~' | null, line: string): boolean {
  if (!marker) return false;
  return line.trim() === marker;
}

// ── Frontmatter (BUG-10) ────────────────────────────────────────────────────
// A deliberately tiny, dependency-free YAML-frontmatter reader. We only parse a
// leading `---\n … \n---` block of flat `key: value` lines and coerce simple
// scalar types (string / number / boolean) plus inline `[a, b]` lists. Anything
// we don't understand (nested maps, block lists, multi-line scalars, anchors)
// is preserved verbatim as a trimmed string — we NEVER eval and we never pull
// in a YAML lib here. The filesystem layer still uses `gray-matter` for the
// canonical on-disk parse; this exists so the DB can cache structured
// properties without a heavyweight dependency in the hot upsert path.

export interface ParsedFrontmatter {
  /** Flat key/value map, or null when the body has no frontmatter block. */
  frontmatter: Record<string, unknown> | null;
}

/**
 * Parse the leading `---` frontmatter block of `body` into a flat record.
 * Returns `{ frontmatter: null }` when there is no well-formed leading block
 * (the body must START with a `---` line and contain a closing `---` line).
 */
export function parseFrontmatter(body: string): ParsedFrontmatter {
  if (!body) return { frontmatter: null };

  // The opening fence must be the very first line. We strip a single leading
  // UTF-8 BOM (U+FEFF) if present so a BOM-prefixed file still parses.
  const normalized = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  const lines = normalized.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return { frontmatter: null };

  // Find the closing fence.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return { frontmatter: null };

  const out: Record<string, unknown> = {};
  for (let i = 1; i < closeIdx; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue; // blank or comment

    // We only handle flat `key: value` pairs. Lines without a top-level colon
    // (e.g. block-list `- item` continuations of a nested key) are ignored —
    // nested/complex YAML is explicitly out of scope.
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    const rawValue = line.slice(sep + 1).trim();
    out[key] = coerceScalar(rawValue);
  }

  if (Object.keys(out).length === 0) return { frontmatter: null };
  return { frontmatter: out };
}

/** Coerce a trimmed YAML scalar string into string / number / boolean / list. */
function coerceScalar(raw: string): unknown {
  if (raw === '') return '';

  // Inline flow list: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => coerceScalar(item.trim()));
  }

  // Quoted string — strip the matching quotes, no escape processing.
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }

  // Booleans (YAML 1.1 style, case-insensitive true/false only — we avoid the
  // yes/no/on/off footguns).
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null' || lower === '~') return null;

  // Numbers — integer or float, optionally signed. Reject anything else so we
  // don't accidentally turn version-like strings ("1.2.3") into NaN.
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }

  return raw;
}

/**
 * Serialize a frontmatter record for the `frontmatter_json` column.
 * Returns null when there is nothing to store (null / empty object), so the
 * column stays NULL rather than holding a meaningless `"{}"`.
 */
export function frontmatterToJson(frontmatter: Record<string, unknown> | null): string | null {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return null;
  return JSON.stringify(frontmatter);
}

/**
 * Parse a `frontmatter_json` column value back into a record. Tolerates null,
 * empty, malformed JSON, and non-object JSON — all collapse to null so a bad
 * cached value never throws on read.
 */
export function frontmatterFromJson(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
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
