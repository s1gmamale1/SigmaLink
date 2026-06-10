// voice-stats.ts — Whisper segment metadata → usage statistics (C-10a).
//
// Pure helpers; no Electron or native deps. The KV accessor interface is the
// same synchronous { get, set } shape used throughout global-capture.ts so
// these functions can be called from the capture controller without any async
// overhead. Single home for the SessionStat shape — the renderer (VoiceTab)
// type-imports `SessionStat` from `@sigmalink/voice-core`; the old read-side
// duplicate in `app/src/main/core/voice/voice-stats.ts` was deleted
// (2026-06-10 dead-code sweep).

export interface TranscriptSegment {
  t0: number; // segment start time, milliseconds
  t1: number; // segment end time, milliseconds
  text: string;
}

export interface SessionStat {
  words: number;
  durationMs: number;
  wpm: number;
  timestamp?: number;
}

interface KvAccessor {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
}

const KV_STATS = 'voice.stats';
const MAX_STATS = 200;

/**
 * Compute words / duration / WPM from a list of Whisper segments.
 * - words: total whitespace-delimited tokens across all segment texts.
 * - durationMs: last segment t1 minus first segment t0 (0 if empty).
 * - wpm: words / (durationMs / 60000); 0 when durationMs is 0.
 */
export function computeSessionStats(segments: TranscriptSegment[]): SessionStat {
  if (segments.length === 0) {
    return { words: 0, durationMs: 0, wpm: 0 };
  }
  let words = 0;
  for (const seg of segments) {
    const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
    words += tokens.length;
  }
  const durationMs = segments[segments.length - 1].t1 - segments[0].t0;
  const wpm = durationMs > 0 ? words / (durationMs / 60_000) : 0;
  return { words, durationMs, wpm };
}

/**
 * Append a `SessionStat` to the `voice.stats` KV list, capping at the last
 * MAX_STATS (200) entries. Best-effort: parse/write errors are swallowed so
 * stats collection never disrupts transcription.
 */
export function appendSessionStat(kv: KvAccessor, stat: SessionStat): void {
  try {
    const raw = kv.get(KV_STATS);
    let list: SessionStat[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) list = parsed as SessionStat[];
      } catch {
        list = [];
      }
    }
    list.push(stat.timestamp ? stat : { ...stat, timestamp: Date.now() });
    if (list.length > MAX_STATS) list = list.slice(list.length - MAX_STATS);
    kv.set(KV_STATS, JSON.stringify(list));
  } catch {
    // Non-fatal — stats collection must never disrupt transcription.
  }
}
