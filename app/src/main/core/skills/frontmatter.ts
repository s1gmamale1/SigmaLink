// Parse + validate SKILL.md frontmatter. The Anthropic Agent Skills format is
// YAML frontmatter delimited by `---` markers, followed by a Markdown body.
//
// Validation rules (from PRODUCT_SPEC §7.4 trimmed for v1):
//   - `name` must match /^[a-z0-9-]{1,64}$/ (lowercase, digits, hyphens)
//   - `description` required, ≤1500 chars (we keep the spec's 1500-char cap
//     even though full description bodies up to 16 KiB are tolerated downstream)
//
// We use `gray-matter` (already in deps) for the YAML parse. All YAML errors
// are surfaced as `{ ok: false, error }` so callers can show them in the UI.

import matter from 'gray-matter';
import type { SkillFrontmatter } from './types';

const NAME_RE = /^[a-z0-9-]{1,64}$/;
const DESCRIPTION_MAX = 1500;

export type ParseSkillResult =
  | { ok: true; data: SkillFrontmatter; body: string }
  | { ok: false; error: string };

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(item);
  }
  return out.length ? out : undefined;
}

/**
 * Parse a raw SKILL.md document. The optional `fallbackName` is used when
 * frontmatter omits `name` (common for skills that ship under a versioned
 * folder); pass the parent directory name.
 */
export function parseSkillMd(
  text: string,
  fallbackName?: string,
): ParseSkillResult {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(text);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const fm = parsed.data ?? {};

  // Description is required.
  const description = asString(fm.description);
  if (!description || description.trim().length === 0) {
    return { ok: false, error: 'Frontmatter is missing required field: description' };
  }
  if (description.length > DESCRIPTION_MAX) {
    return {
      ok: false,
      error: `description exceeds ${DESCRIPTION_MAX} characters (got ${description.length})`,
    };
  }

  // Name: prefer frontmatter, fall back to folder name. Either must validate.
  let name = asString(fm.name) ?? fallbackName ?? '';
  name = name.trim();
  if (!name) {
    return { ok: false, error: 'Frontmatter is missing required field: name' };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: `name "${name}" must match ${NAME_RE.source} (lowercase letters, digits, hyphens; ≤64 chars)`,
    };
  }

  // Optional fields preserved verbatim where possible.
  const version = asString(fm.version);
  const argumentHint = asString(fm['argument-hint']) ?? asString(fm.argumentHint);
  const args = asStringArray(fm.arguments) ?? asString(fm.arguments);
  const whenToUse = asString(fm['when_to_use']) ?? asString(fm.whenToUse);
  const allowedTools = asStringArray(fm['allowed-tools']) ?? asStringArray(fm.allowedTools);
  const tags = asStringArray(fm.tags);

  // Forward any unknown/extra fields untouched so fan-out targets can reuse
  // them (e.g. Codex tool translation, Gemini extension manifest).
  const known = new Set([
    'name',
    'description',
    'version',
    'tags',
    'argument-hint',
    'argumentHint',
    'arguments',
    'when_to_use',
    'whenToUse',
    'allowed-tools',
    'allowedTools',
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!known.has(k)) extra[k] = v;
  }

  return {
    ok: true,
    data: {
      name,
      description: description.trim(),
      version,
      tags,
      argumentHint,
      arguments: args,
      whenToUse,
      allowedTools,
      extra: Object.keys(extra).length ? extra : undefined,
    },
    body: parsed.content ?? '',
  };
}

export const SKILL_NAME_RE = NAME_RE;
export const SKILL_DESCRIPTION_MAX = DESCRIPTION_MAX;
