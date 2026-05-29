// SigmaVoice — settings data helpers (dictionary + usage stats).
//
// Pure read/aggregate logic over the KV store, shared by the IPC handlers in
// main.ts. Kept out of main.ts to keep it lean and to make this logic unit-able.
//
// Storage formats are dictated by @sigmalink/voice-core (we must stay
// compatible so the live transcription path reads what the UI writes):
//   - voice.dictionary : JSON `Array<{ pattern, replacement, type }>`
//                        (consumed by voice-core normalizeTranscript)
//   - voice.stats      : JSON `Array<{ words, durationMs, wpm, timestamp }>`
//                        (appended by voice-core appendSessionStat, capped 200)

import type { KvStore } from './kv-store';

const KV_DICTIONARY = 'voice.dictionary';
const KV_STATS = 'voice.stats';
const MAX_PATTERN_LENGTH = 200;
const RECENT_LIMIT = 12;

export interface DictionaryEntry {
  pattern: string;
  replacement: string;
  type: 'phrase' | 'macro';
}

export interface StatsRecord {
  timestamp: number;
  words: number;
  wpm: number;
}

export interface StatsSummary {
  totalWords: number;
  recordings: number;
  avgWpm: number;
  recent: StatsRecord[];
}

/** Read + parse the dictionary; returns [] on missing/corrupt data. */
export function getDictionary(kv: KvStore): DictionaryEntry[] {
  try {
    const raw = kv.get(KV_DICTIONARY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDictionaryEntry);
  } catch {
    return [];
  }
}

/**
 * Validate (input boundary) + persist the dictionary. Drops malformed rows and
 * over-long patterns rather than throwing, so a bad row from the UI can't wedge
 * the store. Returns the sanitized list that was written.
 */
export function setDictionary(kv: KvStore, entries: unknown): DictionaryEntry[] {
  const clean = Array.isArray(entries) ? entries.filter(isDictionaryEntry) : [];
  const sanitized = clean
    .filter((e) => e.pattern.length > 0 && e.pattern.length <= MAX_PATTERN_LENGTH)
    .map((e) => ({ pattern: e.pattern, replacement: e.replacement, type: e.type }));
  kv.set(KV_DICTIONARY, JSON.stringify(sanitized));
  return sanitized;
}

/** Aggregate the rolling stats list into the dashboard summary. */
export function getStatsSummary(kv: KvStore): StatsSummary {
  const empty: StatsSummary = { totalWords: 0, recordings: 0, avgWpm: 0, recent: [] };
  try {
    const raw = kv.get(KV_STATS);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return empty;

    let totalWords = 0;
    let wpmSum = 0;
    let wpmCount = 0;
    const recent: StatsRecord[] = [];

    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const words = typeof r.words === 'number' ? r.words : 0;
      const wpm = typeof r.wpm === 'number' ? r.wpm : 0;
      const timestamp = typeof r.timestamp === 'number' ? r.timestamp : 0;
      totalWords += words;
      if (wpm > 0) {
        wpmSum += wpm;
        wpmCount += 1;
      }
      recent.push({ timestamp, words, wpm });
    }

    return {
      totalWords,
      recordings: parsed.length,
      avgWpm: wpmCount > 0 ? Math.round(wpmSum / wpmCount) : 0,
      recent: recent.slice(-RECENT_LIMIT).reverse(),
    };
  } catch {
    return empty;
  }
}

function isDictionaryEntry(value: unknown): value is DictionaryEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pattern === 'string' &&
    typeof v.replacement === 'string' &&
    (v.type === 'phrase' || v.type === 'macro')
  );
}
