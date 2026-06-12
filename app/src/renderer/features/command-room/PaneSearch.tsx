// DOM terminal presenter P2 — find-in-pane overlay. A small bar pinned to the
// pane's top-right: an autofocused input, the `n/total` count, prev/next
// cycling, and a close button. Pure presentational: all state (term, matches,
// active index) lives in DomTerminalView; this renders it and reports intents
// (term change, navigate ±1, close). Keydown stops propagation so the
// terminal's hidden textarea never sees the search keystrokes.

import type { CSSProperties } from 'react';

interface PaneSearchProps {
  term: string;
  matchCount: number;
  /** 0-based index of the active match (display is 1-based). */
  activeIndex: number;
  onTermChange: (term: string) => void;
  /** +1 = next match, -1 = previous match. */
  onNavigate: (direction: 1 | -1) => void;
  onClose: () => void;
}

const BAR: CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 6,
  zIndex: 5,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  background: '#161926',
  border: '1px solid #525a73',
  borderRadius: 4,
  padding: '3px 6px',
  fontFamily: 'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  color: '#e6e8f0',
};

const INPUT: CSSProperties = {
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: '#e6e8f0',
  fontFamily: 'inherit',
  fontSize: 12,
  width: 120,
  padding: 0,
};

const BTN: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#e6e8f0',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  padding: '0 2px',
  lineHeight: 1,
};

const COUNT: CSSProperties = { color: '#9aa3bd', minWidth: 28, textAlign: 'right' };

export function PaneSearch({
  term,
  matchCount,
  activeIndex,
  onTermChange,
  onNavigate,
  onClose,
}: PaneSearchProps) {
  const display = matchCount === 0 ? '0/0' : `${activeIndex + 1}/${matchCount}`;
  return (
    <div style={BAR} data-testid="pane-search" onMouseDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        aria-label="find in pane"
        placeholder="Find"
        value={term}
        style={INPUT}
        spellCheck={false}
        onChange={(e) => onTermChange(e.target.value)}
        onKeyDown={(e) => {
          // Keep search keystrokes out of the terminal's hidden textarea.
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            onNavigate(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span data-testid="pane-search-count" style={COUNT}>
        {display}
      </span>
      <button type="button" aria-label="previous match" style={BTN} onClick={() => onNavigate(-1)}>
        ↑
      </button>
      <button type="button" aria-label="next match" style={BTN} onClick={() => onNavigate(1)}>
        ↓
      </button>
      <button type="button" aria-label="close search" style={BTN} onClick={onClose}>
        ×
      </button>
    </div>
  );
}
