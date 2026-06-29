import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the orchestrator so commits don't start real 3s timers; we just assert
// the captured prompt is handed off.
const onPrompt = vi.fn();
vi.mock('@/renderer/lib/pane-title-orchestrator', () => ({
  onPrompt: (sessionId: string, text: string) => onPrompt(sessionId, text),
}));

import {
  feedPromptKey,
  feedPromptPaste,
  clearPromptDraft,
  __resetPromptCapture,
  type CaptureKeyEvent,
} from './pane-prompt-capture';

afterEach(() => {
  __resetPromptCapture();
  onPrompt.mockClear();
});

const K = (key: string, mods: Partial<CaptureKeyEvent> = {}): CaptureKeyEvent => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

function type(sessionId: string, text: string): void {
  for (const ch of text) feedPromptKey(sessionId, K(ch));
}

describe('pane-prompt-capture', () => {
  it('hands the typed line to the orchestrator on a plain Enter', () => {
    type('s1', 'fix the auth bug');
    expect(onPrompt).not.toHaveBeenCalled(); // not until Enter
    expect(feedPromptKey('s1', K('Enter'))).toBe('fix the auth bug');
    expect(onPrompt).toHaveBeenCalledWith('s1', 'fix the auth bug');
  });

  it('fires on EVERY prompt (no lock)', () => {
    type('s2', 'first task');
    feedPromptKey('s2', K('Enter'));
    type('s2', 'second task');
    feedPromptKey('s2', K('Enter'));
    expect(onPrompt).toHaveBeenNthCalledWith(1, 's2', 'first task');
    expect(onPrompt).toHaveBeenNthCalledWith(2, 's2', 'second task');
  });

  it('Shift+Enter and Alt+Enter insert a newline, they do NOT commit', () => {
    type('s3', 'line one');
    expect(feedPromptKey('s3', K('Enter', { shiftKey: true }))).toBeNull();
    type('s3', 'line two');
    expect(feedPromptKey('s3', K('Enter', { altKey: true }))).toBeNull();
    expect(onPrompt).not.toHaveBeenCalled();
    type('s3', ' end');
    feedPromptKey('s3', K('Enter'));
    expect(onPrompt).toHaveBeenCalledWith('s3', 'line one line two end'); // newlines collapsed
  });

  it('Backspace edits the draft before commit', () => {
    type('s4', 'helloo');
    feedPromptKey('s4', K('Backspace'));
    feedPromptKey('s4', K('Enter'));
    expect(onPrompt).toHaveBeenCalledWith('s4', 'hello');
  });

  it('rejects trivial commits (empty / single char / no alphanumerics)', () => {
    expect(feedPromptKey('e1', K('Enter'))).toBeNull();
    type('e2', 'a');
    expect(feedPromptKey('e2', K('Enter'))).toBeNull();
    type('e3', '...');
    expect(feedPromptKey('e3', K('Enter'))).toBeNull();
    expect(onPrompt).not.toHaveBeenCalled();
  });

  it('accepts a non-Latin line (Cyrillic/Uzbek)', () => {
    type('s5', 'обнови шлюз');
    feedPromptKey('s5', K('Enter'));
    expect(onPrompt).toHaveBeenCalledWith('s5', 'обнови шлюз');
  });

  it('ignores control/named keys and meta-shortcuts in the draft', () => {
    feedPromptKey('s6', K('ArrowLeft'));
    feedPromptKey('s6', K('v', { metaKey: true }));
    feedPromptKey('s6', K('c', { ctrlKey: true }));
    type('s6', 'go');
    feedPromptKey('s6', K('Tab'));
    feedPromptKey('s6', K('Enter'));
    expect(onPrompt).toHaveBeenCalledWith('s6', 'go');
  });

  it('paste appends to the draft (newlines flattened); Enter still commits', () => {
    feedPromptPaste('s7', 'review the\nPR diff');
    feedPromptKey('s7', K('Enter'));
    expect(onPrompt).toHaveBeenCalledWith('s7', 'review the PR diff');
  });

  it('clearPromptDraft drops an in-progress draft', () => {
    type('s8', 'half typed');
    clearPromptDraft('s8');
    feedPromptKey('s8', K('Enter'));
    expect(onPrompt).not.toHaveBeenCalled();
  });
});
