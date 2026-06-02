// @vitest-environment jsdom
// MEM-9 — OutlineRail heading extraction + click-to-scroll.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OutlineRail, extractHeadings, scrollTopForLine } from './OutlineRail';

afterEach(cleanup);

describe('extractHeadings', () => {
  it('extracts ATX headings with level + line index', () => {
    const body = '# Title\n\nintro\n## Section\n### Sub';
    expect(extractHeadings(body)).toEqual([
      { level: 1, text: 'Title', lineIndex: 0 },
      { level: 2, text: 'Section', lineIndex: 3 },
      { level: 3, text: 'Sub', lineIndex: 4 },
    ]);
  });

  it('ignores headings inside fenced code blocks', () => {
    const body = '# Real\n```\n# Not a heading\n```\n## After';
    expect(extractHeadings(body).map((h) => h.text)).toEqual(['Real', 'After']);
  });

  it('ignores non-heading hashes (no space, or >6)', () => {
    expect(extractHeadings('#NoSpace\n####### TooDeep')).toEqual([]);
  });
});

describe('scrollTopForLine', () => {
  it('multiplies line index by line height, clamped at 0', () => {
    expect(scrollTopForLine(0, 20)).toBe(0);
    expect(scrollTopForLine(5, 20)).toBe(100);
    expect(scrollTopForLine(-3, 20)).toBe(0);
  });
});

describe('OutlineRail', () => {
  it('renders the empty state when there are no headings', () => {
    render(<OutlineRail body="plain text" onJump={vi.fn()} />);
    expect(screen.getByText(/No headings yet/i)).toBeTruthy();
  });

  it('calls onJump with the heading line index', () => {
    const onJump = vi.fn();
    render(<OutlineRail body={'# A\n\n## B'} onJump={onJump} />);
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(onJump).toHaveBeenCalledWith(2);
  });
});
