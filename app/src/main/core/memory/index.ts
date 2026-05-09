// In-memory inverted index over memory bodies + names. The DB owns the
// authoritative state; this index is rebuilt on demand for fast search and
// kept in sync via `updateMemory` / `removeMemory` calls from the manager.
//
// Tokenization: lowercase, ASCII letters / digits / underscore runs of length
// >= 2. Stop-words are filtered out so `the` doesn't dominate scoring. Title
// hits get a 4x weight per the spec; ties are broken by recency.

import type { Memory, MemorySearchHit } from '../../../shared/types';

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'have',
  'has',
  'are',
  'were',
  'was',
  'been',
  'being',
  'about',
  'they',
  'them',
  'their',
  'there',
  'then',
  'than',
  'will',
  'when',
  'where',
  'which',
  'while',
  'after',
  'before',
  'over',
  'under',
  'between',
  'among',
  'such',
  'some',
  'each',
  'every',
  'other',
  'just',
  'also',
  'you',
  'your',
  'our',
  'his',
  'her',
  'him',
  'she',
  'shall',
  'should',
  'would',
  'could',
  'doing',
  'does',
  'did',
  'not',
  'but',
  'because',
  'all',
  'any',
  'one',
  'two',
  'into',
]);

interface Entry {
  id: string;
  name: string;
  bodyTokens: Map<string, number>;
  nameTokens: Set<string>;
  updatedAt: number;
  body: string; // raw, for snippet generation
}

export class MemoryIndex {
  private readonly entries = new Map<string, Entry>();

  rebuild(memories: Memory[]): void {
    this.entries.clear();
    for (const m of memories) this.upsert(m);
  }

  upsert(memory: Memory): void {
    this.entries.set(memory.id, {
      id: memory.id,
      name: memory.name,
      bodyTokens: tokenCounts(memory.body),
      nameTokens: new Set(tokens(memory.name)),
      updatedAt: memory.updatedAt,
      body: memory.body,
    });
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  size(): number {
    return this.entries.size;
  }

  search(query: string, limit = 20): MemorySearchHit[] {
    const qTokens = tokens(query);
    if (qTokens.length === 0) return [];
    const seen = new Set(qTokens);
    const hits: MemorySearchHit[] = [];
    for (const entry of this.entries.values()) {
      let score = 0;
      for (const tok of seen) {
        const bodyHit = entry.bodyTokens.get(tok) ?? 0;
        if (bodyHit > 0) score += bodyHit;
        if (entry.nameTokens.has(tok)) score += 4;
      }
      if (score === 0) continue;
      hits.push({
        id: entry.id,
        name: entry.name,
        snippet: snippet(entry.body, qTokens),
        score,
        updatedAt: entry.updatedAt,
      });
    }
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.updatedAt - a.updatedAt;
    });
    return hits.slice(0, limit);
  }
}

function tokens(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /[A-Za-z0-9_]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text.toLowerCase())) !== null) {
    const tok = m[0];
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

function tokenCounts(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const tok of tokens(text)) map.set(tok, (map.get(tok) ?? 0) + 1);
  return map;
}

function snippet(body: string, qTokens: string[]): string {
  if (!body) return '';
  const lower = body.toLowerCase();
  for (const tok of qTokens) {
    const idx = lower.indexOf(tok);
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, idx + tok.length + 80);
      const ellipsisPrefix = start > 0 ? '… ' : '';
      const ellipsisSuffix = end < body.length ? ' …' : '';
      return ellipsisPrefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + ellipsisSuffix;
    }
  }
  return body.slice(0, 120).replace(/\s+/g, ' ').trim();
}
