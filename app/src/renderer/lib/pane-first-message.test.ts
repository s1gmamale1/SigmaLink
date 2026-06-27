import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  feedFirstMessageKey,
  feedFirstMessagePaste,
  getFirstMessage,
  subscribeFirstMessage,
  clearFirstMessage,
  __resetFirstMessages,
  type CaptureKeyEvent,
} from './pane-first-message';

afterEach(() => __resetFirstMessages());

const K = (key: string, mods: Partial<CaptureKeyEvent> = {}): CaptureKeyEvent => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

function type(sessionId: string, text: string): void {
  for (const ch of text) feedFirstMessageKey(sessionId, K(ch));
}

describe('pane-first-message', () => {
  it('captures the first typed line on a plain Enter', () => {
    type('s1', 'fix the auth bug');
    expect(getFirstMessage('s1')).toBeNull(); // not committed until Enter
    const committed = feedFirstMessageKey('s1', K('Enter'));
    expect(committed).toBe('fix the auth bug');
    expect(getFirstMessage('s1')).toBe('fix the auth bug');
  });

  it('locks the first message — later lines do not overwrite it', () => {
    type('s2', 'first task');
    feedFirstMessageKey('s2', K('Enter'));
    type('s2', 'a totally different second message');
    feedFirstMessageKey('s2', K('Enter'));
    expect(getFirstMessage('s2')).toBe('first task');
  });

  it('Shift+Enter and Alt+Enter insert a newline, they do NOT commit', () => {
    type('s3', 'line one');
    expect(feedFirstMessageKey('s3', K('Enter', { shiftKey: true }))).toBeNull();
    type('s3', 'line two');
    expect(feedFirstMessageKey('s3', K('Enter', { altKey: true }))).toBeNull();
    expect(getFirstMessage('s3')).toBeNull();
    type('s3', ' end');
    feedFirstMessageKey('s3', K('Enter'));
    // newlines collapse to single spaces via sanitizeLabel
    expect(getFirstMessage('s3')).toBe('line one line two end');
  });

  it('Backspace edits the draft before commit', () => {
    type('s4', 'helloo');
    feedFirstMessageKey('s4', K('Backspace'));
    feedFirstMessageKey('s4', K('Enter'));
    expect(getFirstMessage('s4')).toBe('hello');
  });

  it('rejects trivial commits (empty / single char / no alphanumerics)', () => {
    expect(feedFirstMessageKey('e1', K('Enter'))).toBeNull(); // empty
    expect(getFirstMessage('e1')).toBeNull();

    type('e2', 'a');
    expect(feedFirstMessageKey('e2', K('Enter'))).toBeNull(); // < MIN_COMMIT_LEN
    expect(getFirstMessage('e2')).toBeNull();

    type('e3', '...');
    expect(feedFirstMessageKey('e3', K('Enter'))).toBeNull(); // no alnum
    expect(getFirstMessage('e3')).toBeNull();

    // a rejected commit does NOT lock the session — a later real line still captures
    type('e3', 'real task now');
    feedFirstMessageKey('e3', K('Enter'));
    expect(getFirstMessage('e3')).toBe('real task now');
  });

  it('ignores control/named keys and meta-shortcuts in the draft', () => {
    feedFirstMessageKey('s5', K('ArrowLeft'));
    feedFirstMessageKey('s5', K('v', { metaKey: true })); // cmd+v
    feedFirstMessageKey('s5', K('c', { ctrlKey: true })); // ctrl-c
    type('s5', 'go');
    feedFirstMessageKey('s5', K('Tab'));
    feedFirstMessageKey('s5', K('Enter'));
    expect(getFirstMessage('s5')).toBe('go');
  });

  it('paste appends to the draft (newlines flattened); Enter still commits', () => {
    feedFirstMessagePaste('s6', 'review the\nPR diff');
    feedFirstMessageKey('s6', K('Enter'));
    expect(getFirstMessage('s6')).toBe('review the PR diff');
  });

  it('notifies subscribers on commit and on clear', () => {
    const cb = vi.fn();
    const off = subscribeFirstMessage('s7', cb);
    type('s7', 'do the thing');
    feedFirstMessageKey('s7', K('Enter'));
    expect(cb).toHaveBeenCalledTimes(1);
    clearFirstMessage('s7');
    expect(cb).toHaveBeenCalledTimes(2);
    expect(getFirstMessage('s7')).toBeNull();
    off();
  });

  it('clear resets the captured lock so a fresh first message can be captured again', () => {
    type('s8', 'task one');
    feedFirstMessageKey('s8', K('Enter'));
    clearFirstMessage('s8');
    type('s8', 'task two');
    feedFirstMessageKey('s8', K('Enter'));
    expect(getFirstMessage('s8')).toBe('task two');
  });
});
