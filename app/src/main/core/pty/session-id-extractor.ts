export interface SessionIdExtraction {
  providerId: string;
  sessionId: string;
  raw: string;
  source: 'jsonl' | 'banner';
}

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const CLAUDE_PROVIDER_IDS = new Set(['claude', 'bridgecode']);
const CODEX_PROVIDER_IDS = new Set(['codex']);

function cleanLine(line: string): string {
  return line.replace(OSC_RE, '').replace(ANSI_RE, '').trim();
}

function normaliseProvider(providerId: string): string {
  return providerId.trim().toLowerCase();
}

function readStringField(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function looksLikeSessionId(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 200) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(trimmed);
}

function result(
  providerId: string,
  sessionId: string | null,
  raw: string,
  source: SessionIdExtraction['source'],
): SessionIdExtraction | null {
  if (!sessionId || !looksLikeSessionId(sessionId)) return null;
  return { providerId, sessionId, raw, source };
}

function extractClaudeJson(providerId: string, line: string): SessionIdExtraction | null {
  if (!line.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : '';
  const subtype = typeof obj.subtype === 'string' ? obj.subtype : '';
  if (type !== 'system' || subtype !== 'init') return null;
  return result(
    providerId,
    readStringField(obj, ['session_id', 'sessionId', 'sessionID']),
    line,
    'jsonl',
  );
}

function extractClaudeBanner(providerId: string, line: string): SessionIdExtraction | null {
  const match =
    line.match(/\bSession(?:\s+ID)?\s*:\s*([A-Za-z0-9][A-Za-z0-9._:@-]{7,199})\b/i) ??
    line.match(/\bConversation(?:\s+ID)?\s*:\s*([A-Za-z0-9][A-Za-z0-9._:@-]{7,199})\b/i);
  return result(providerId, match?.[1] ?? null, line, 'banner');
}

function extractCodexBanner(providerId: string, line: string): SessionIdExtraction | null {
  const match =
    line.match(/\bSession\s+ID\s*:\s*([A-Za-z0-9][A-Za-z0-9._:@-]{7,199})\b/i) ??
    line.match(/\bcodex\s+resume\s+([A-Za-z0-9][A-Za-z0-9._:@-]{7,199})\b/i);
  return result(providerId, match?.[1] ?? null, line, 'banner');
}

export function extractSessionIdFromLine(
  providerId: string,
  line: string,
): SessionIdExtraction | null {
  const provider = normaliseProvider(providerId);
  const cleaned = cleanLine(line);
  if (!cleaned) return null;

  if (CLAUDE_PROVIDER_IDS.has(provider)) {
    return (
      extractClaudeJson(provider, cleaned) ??
      extractClaudeBanner(provider, cleaned)
    );
  }
  if (CODEX_PROVIDER_IDS.has(provider)) {
    return extractCodexBanner(provider, cleaned);
  }
  // Gemini and unknown providers do not currently expose a stable resumable id
  // that SigmaLink can trust.
  return null;
}

export function extractSessionId(
  providerId: string,
  output: string,
): SessionIdExtraction | null {
  for (const line of output.split(/\r?\n/)) {
    const hit = extractSessionIdFromLine(providerId, line);
    if (hit) return hit;
  }
  return null;
}
