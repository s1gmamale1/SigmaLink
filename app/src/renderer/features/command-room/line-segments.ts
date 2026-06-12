// line-segments.ts — pure run decoration. Splits StyledRuns at decoration
// boundaries so FlowView can render link anchors and search highlights
// without disturbing the attribute runs (a segment inherits its source
// run's style verbatim).

import type { StyledRun } from '@/renderer/lib/terminal-engine';

export interface Decoration {
  start: number;
  /** exclusive */
  end: number;
  link?: string;
  search?: 'normal' | 'active';
}

export interface LineSegment extends StyledRun {
  link?: string;
  search?: 'normal' | 'active';
}

export function segmentRuns(runs: StyledRun[], decorations: Decoration[]): LineSegment[] {
  if (decorations.length === 0) return runs.map((r) => ({ ...r }));
  // Collect every boundary offset, then walk runs emitting sub-segments.
  const bounds = new Set<number>();
  for (const d of decorations) {
    bounds.add(d.start);
    bounds.add(d.end);
  }
  const out: LineSegment[] = [];
  let offset = 0;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    const cuts = [offset, ...[...bounds].filter((b) => b > offset && b < runEnd).sort((a, b) => a - b), runEnd];
    for (let i = 0; i < cuts.length - 1; i++) {
      const s = cuts[i]!;
      const e = cuts[i + 1]!;
      if (e <= s) continue;
      const seg: LineSegment = { ...run, text: run.text.slice(s - offset, e - offset) };
      for (const d of decorations) {
        if (d.start <= s && e <= d.end) {
          if (d.link) seg.link = d.link;
          if (d.search) seg.search = d.search;
        }
      }
      out.push(seg);
    }
    offset = runEnd;
  }
  return out;
}
