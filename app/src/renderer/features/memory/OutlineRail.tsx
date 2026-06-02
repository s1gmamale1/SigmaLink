// MEM-9 — Outline rail. Extracts ATX headings (`#`..`######`) from the editor
// body and renders a click-to-scroll outline. Selecting a heading scrolls the
// (non-wrapping, mono) editor textarea to that line via
// `scrollTop = lineIdx × lineHeight`.
//
// Scoped to the editor's mono textarea: because the editor is `font-mono` with
// no soft-wrap reflow of headings (headings are short, single-line), the line
// index is a faithful row index, so `lineIdx × lineHeight` lands the heading at
// the top of the viewport.

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

export interface OutlineHeading {
  /** 1..6 — number of leading `#` characters. */
  level: number;
  /** Heading text with the leading `#`s + space stripped. */
  text: string;
  /** Zero-based body line index (rows split on `\n`). */
  lineIndex: number;
}

const FENCE_RE = /^(\s*)(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;

/**
 * Extract ATX headings from `body`, skipping fenced code blocks so a `# ...`
 * comment inside a code block isn't mistaken for a heading (mirrors the
 * fence-aware scan in `wikilink.ts`).
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, exported for unit tests
export function extractHeadings(body: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  if (!body) return out;
  const lines = body.split('\n');
  let inFence = false;
  let marker: '```' | '~~~' | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        marker = fence[2] as '```' | '~~~';
      } else if (marker && line.trim() === marker) {
        inFence = false;
        marker = null;
      }
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (m) {
      out.push({ level: m[1].length, text: m[2].trim(), lineIndex: i });
    }
  }
  return out;
}

/**
 * Compute `scrollTop` to bring a given line index to the top of a textarea.
 * Pure helper exported for unit tests + the editor's jump handler.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, exported for unit tests
export function scrollTopForLine(lineIndex: number, lineHeight: number): number {
  return Math.max(0, lineIndex * lineHeight);
}

interface Props {
  body: string;
  /** Scroll the editor so the heading on `lineIndex` is at the top. */
  onJump: (lineIndex: number) => void;
}

export function OutlineRail({ body, onJump }: Props) {
  const headings = useMemo<OutlineHeading[]>(() => extractHeadings(body), [body]);

  return (
    <div
      data-testid="outline-rail"
      className="flex h-full min-h-0 flex-col border-l border-border bg-card text-xs"
    >
      <div className="border-b border-border px-3 py-2 font-medium text-foreground">
        Outline
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {headings.length === 0 ? (
          <div className="px-2 py-2 text-muted-foreground">
            No headings yet. Add a <code className="rounded bg-muted px-1"># Heading</code>.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {headings.map((h) => (
              <li key={`${h.lineIndex}-${h.text}`}>
                <button
                  type="button"
                  onClick={() => onJump(h.lineIndex)}
                  title={h.text}
                  className={cn(
                    'block w-full truncate rounded px-2 py-1 text-left text-muted-foreground transition hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  )}
                  // Indent by depth so the hierarchy reads at a glance.
                  style={{ paddingLeft: `${0.5 + (h.level - 1) * 0.75}rem` }}
                >
                  {h.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
