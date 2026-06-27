import { afterEach, describe, expect, it } from 'vitest';
import {
  feedPromptKey,
  feedPromptPaste,
  clearPromptDraft,
  __resetPromptCapture,
  type CaptureKeyEvent,
} from './pane-prompt-capture';
import { getAgentLabel, __resetAgentLabels } from './pane-labels';

afterEach(() => {
  __resetPromptCapture();
  __resetAgentLabels();
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
  it('commits a typed line into the shared label store on a plain Enter', () => {
    type('s1', 'fix the auth bug');
    expect(getAgentLabel('s1')).toBeNull(); // not committed until Enter
    expect(feedPromptKey('s1', K('Enter'))).toBe('fix the auth bug');
    expect(getAgentLabel('s1')).toBe('fix the auth bug');
  });

  it('RE-TITLES on every prompt (no first-message lock)', () => {
    type('s2', 'first task');
    feedPromptKey('s2', K('Enter'));
    expect(getAgentLabel('s2')).toBe('first task');
    type('s2', 'second different task');
    feedPromptKey('s2', K('Enter'));
    expect(getAgentLabel('s2')).toBe('second different task'); // overwritten
  });

  it('Shift+Enter and Alt+Enter insert a newline, they do NOT commit', () => {
    type('s3', 'line one');
    expect(feedPromptKey('s3', K('Enter', { shiftKey: true }))).toBeNull();
    type('s3', 'line two');
    expect(feedPromptKey('s3', K('Enter', { altKey: true }))).toBeNull();
    expect(getAgentLabel('s3')).toBeNull();
    type('s3', ' end');
    feedPromptKey('s3', K('Enter'));
    expect(getAgentLabel('s3')).toBe('line one line two end'); // newlines collapsed
  });

  it('Backspace edits the draft before commit', () => {
    type('s4', 'helloo');
    feedPromptKey('s4', K('Backspace'));
    feedPromptKey('s4', K('Enter'));
    expect(getAgentLabel('s4')).toBe('hello');
  });

  it('rejects trivial commits (empty / single char / no alphanumerics)', () => {
    expect(feedPromptKey('e1', K('Enter'))).toBeNull();
    type('e2', 'a');
    expect(feedPromptKey('e2', K('Enter'))).toBeNull();
    type('e3', '...');
    expect(feedPromptKey('e3', K('Enter'))).toBeNull();
    expect(getAgentLabel('e1')).toBeNull();
    expect(getAgentLabel('e2')).toBeNull();
    expect(getAgentLabel('e3')).toBeNull();
  });

  it('accepts a non-Latin line (Cyrillic/Uzbek)', () => {
    type('s5', 'обнови шлюз');
    feedPromptKey('s5', K('Enter'));
    expect(getAgentLabel('s5')).toBe('обнови шлюз');
  });

  it('ignores control/named keys and meta-shortcuts in the draft', () => {
    feedPromptKey('s6', K('ArrowLeft'));
    feedPromptKey('s6', K('v', { metaKey: true }));
    feedPromptKey('s6', K('c', { ctrlKey: true }));
    type('s6', 'go');
    feedPromptKey('s6', K('Tab'));
    feedPromptKey('s6', K('Enter'));
    expect(getAgentLabel('s6')).toBe('go');
  });

  it('paste appends to the draft (newlines flattened); Enter still commits', () => {
    feedPromptPaste('s7', 'review the\nPR diff');
    feedPromptKey('s7', K('Enter'));
    expect(getAgentLabel('s7')).toBe('review the PR diff');
  });

  it('clearPromptDraft drops an in-progress draft', () => {
    type('s8', 'half typed');
    clearPromptDraft('s8');
    feedPromptKey('s8', K('Enter'));
    expect(getAgentLabel('s8')).toBeNull();
  });
});
