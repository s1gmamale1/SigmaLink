// MEM-9 — renderer-side frontmatter parse + serialize. Mirrors the main-process
// `core/memory/parse.ts` semantics (flat `---\n…\n---` YAML, scalar + inline
// list coercion) WITHOUT pulling in any Node-only dependency — same pattern as
// the renderer `wikilink.ts`. We deliberately replicate the minimal logic
// rather than import the main module so this stays bundleable in the renderer.
//
// Used by PropertiesPanel.tsx to read the open note's leading frontmatter block
// into an editable key/value grid and splice an edited block back into the body.

export interface ParsedBody {
  /** Flat key/value map parsed from the leading `---` block (null when none). */
  frontmatter: Record<string, unknown> | null;
  /**
   * Character offset in `body` where the content AFTER a leading frontmatter
   * block begins (i.e. the index just past the closing `---` line + its EOL).
   * `0` when there is no frontmatter block, so `body.slice(bodyStart)` is the
   * non-frontmatter content in both cases.
   */
  bodyStart: number;
}

/**
 * Parse the leading `---` frontmatter block of `body`. Returns the flat record
 * plus the offset where the rest of the body begins. When there is no
 * well-formed leading block, `{ frontmatter: null, bodyStart: 0 }`.
 */
export function parseFrontmatter(body: string): ParsedBody {
  if (!body) return { frontmatter: null, bodyStart: 0 };

  // Strip a single leading UTF-8 BOM if present (mirrors parse.ts). We track
  // the BOM offset so `bodyStart` indexes back into the ORIGINAL `body`.
  const hasBom = body.charCodeAt(0) === 0xfeff;
  const normalized = hasBom ? body.slice(1) : body;
  const bomOffset = hasBom ? 1 : 0;

  const lines = normalized.split('\n');
  if (lines.length === 0 || stripCr(lines[0]).trim() !== '---') {
    return { frontmatter: null, bodyStart: 0 };
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (stripCr(lines[i]).trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return { frontmatter: null, bodyStart: 0 };

  const out: Record<string, unknown> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = stripCr(lines[i]).trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    out[key] = coerceScalar(line.slice(sep + 1).trim());
  }

  // Offset just past the closing `---` line. Sum the original line lengths
  // (each split on '\n' dropped one '\n', so add 1 per consumed line) and add
  // the BOM offset back. A trailing '\n' after the close is consumed so the
  // remaining body doesn't begin with a blank line.
  let offset = bomOffset;
  for (let i = 0; i <= closeIdx; i++) {
    offset += lines[i].length + 1; // + the '\n' that split removed
  }
  // If the closing line was the very last line (no trailing newline), `offset`
  // overshoots by 1 — clamp to the body length.
  if (offset > body.length) offset = body.length;

  if (Object.keys(out).length === 0) {
    // A block existed but held nothing parseable. Treat as no frontmatter for
    // the properties grid, but still strip the empty block from the body view.
    return { frontmatter: null, bodyStart: offset };
  }
  return { frontmatter: out, bodyStart: offset };
}

/** Drop a trailing CR so CRLF bodies parse identically to LF bodies. */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Coerce a trimmed YAML scalar into string / number / boolean / null / list. */
function coerceScalar(raw: string): unknown {
  if (raw === '') return '';

  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => coerceScalar(item.trim()));
  }

  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }

  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null' || lower === '~') return null;

  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }

  return raw;
}

/** Serialize one frontmatter value back to a flat-YAML scalar/inline-list. */
function serializeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => serializeValue(v)).join(', ')}]`;
  }
  const s = String(value);
  // Quote when the value would otherwise re-parse as a different type, contains
  // a comma/colon/brackets, or has leading/trailing whitespace — so a
  // round-trip is stable.
  if (
    s === '' ||
    s !== s.trim() ||
    /[:,#[\]]/.test(s) ||
    /^(true|false|null|~)$/i.test(s) ||
    /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)
  ) {
    return JSON.stringify(s); // double-quoted, escapes embedded quotes
  }
  return s;
}

/**
 * Serialize a frontmatter record into a `---\n…\n---\n` block (no trailing
 * blank line). Returns '' for null / empty so callers can drop the block
 * entirely. Key order is the record's own insertion order.
 */
export function serializeFrontmatter(frontmatter: Record<string, unknown> | null): string {
  if (!frontmatter) return '';
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return '';
  const lines = keys.map((k) => `${k}: ${serializeValue(frontmatter[k])}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

/**
 * Splice an updated frontmatter record into `body`, replacing any existing
 * leading block (or prepending a new one). When `frontmatter` is null/empty the
 * existing block is removed. The non-frontmatter content is preserved verbatim.
 */
export function applyFrontmatter(
  body: string,
  frontmatter: Record<string, unknown> | null,
): string {
  const { bodyStart } = parseFrontmatter(body);
  const rest = body.slice(bodyStart);
  const block = serializeFrontmatter(frontmatter);
  if (!block) return rest;
  // Ensure exactly one newline between the block and the rest when rest is
  // non-empty and doesn't already start with one (the block ends in '\n').
  return block + rest;
}

/** A single editable row for the PropertiesPanel grid. Values are rendered as
 *  their YAML-scalar text so a user edits the literal they'd type in the file. */
export interface PropertyRow {
  key: string;
  value: string;
}

/** Display a parsed value as the editable text the grid shows. */
export function valueToText(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map((v) => valueToText(v)).join(', ');
  return String(value);
}

/** Turn the grid's editable text back into a coerced value. Comma-bearing text
 *  (outside quotes) becomes a list, matching the inline `[a, b]` round-trip. */
export function textToValue(text: string): unknown {
  const trimmed = text.trim();
  // Already-bracketed inline lists coerce directly.
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return coerceScalar(trimmed);
  // Bare comma-separated text → list (so `a, b, c` stays a list across a save).
  if (trimmed.includes(',')) {
    return trimmed.split(',').map((p) => coerceScalar(p.trim()));
  }
  return coerceScalar(trimmed);
}

/** Build the ordered grid rows from a frontmatter record. */
export function recordToRows(frontmatter: Record<string, unknown> | null): PropertyRow[] {
  if (!frontmatter) return [];
  return Object.keys(frontmatter).map((key) => ({ key, value: valueToText(frontmatter[key]) }));
}

/** Build a frontmatter record from grid rows. Blank keys are dropped; later
 *  duplicate keys win (last-write). */
export function rowsToRecord(rows: PropertyRow[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (!k) continue;
    out[k] = textToValue(value);
  }
  return Object.keys(out).length === 0 ? null : out;
}
