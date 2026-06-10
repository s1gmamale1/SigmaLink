// @vitest-environment jsdom
//
// 2026-06-10 audit finding #5 — programmatic composer pushes carry a
// monotonic nonce. A bare-string externalValue dedups on Object.is, so the
// SECOND clear-to-'' (banner-retry / voice send after a previous send) is a
// silent no-op that leaves typed-but-unsent text in the textarea.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('@/renderer/lib/canDo', () => ({ useCanDo: () => false }));

import { Composer } from './Composer';

afterEach(() => cleanup());

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea[aria-label="Ask Jorvis"]');
  if (!el) throw new Error('composer textarea not found');
  return el as HTMLTextAreaElement;
}

describe('<Composer /> external push token', () => {
  it('re-clears on a nonce bump even when value is unchanged (banner-retry/voice send)', async () => {
    const onSend = vi.fn();
    const { container, rerender } = render(
      <Composer busy={false} onSend={onSend} externalValue={undefined} />,
    );
    const textarea = getTextarea(container);

    // First programmatic clear (e.g. after send #1).
    fireEvent.change(textarea, { target: { value: 'first draft' } });
    rerender(<Composer busy={false} onSend={onSend} externalValue={{ value: '', nonce: 1 }} />);
    await waitFor(() => expect(textarea.value).toBe(''));

    // The user types again; then a banner-retry/voice send clears AGAIN with
    // the SAME value (''). A string prop dedups here — the nonce must not.
    fireEvent.change(textarea, { target: { value: 'typed but unsent' } });
    rerender(<Composer busy={false} onSend={onSend} externalValue={{ value: '', nonce: 2 }} />);
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  it('an external push lands and the user can take back control by typing', async () => {
    const { container } = render(
      <Composer
        busy={false}
        onSend={vi.fn()}
        externalValue={{ value: 'from ribbon', nonce: 1 }}
      />,
    );
    const textarea = getTextarea(container);
    await waitFor(() => expect(textarea.value).toBe('from ribbon'));
    fireEvent.change(textarea, { target: { value: 'edited by user' } });
    expect(textarea.value).toBe('edited by user');
  });
});
