// @vitest-environment jsdom
// MEM-9 — PropertiesPanel grid → body write-back.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PropertiesPanel } from './PropertiesPanel';

afterEach(cleanup);

describe('PropertiesPanel', () => {
  it('seeds the grid from the body frontmatter', () => {
    render(
      <PropertiesPanel body={'---\ntitle: Hi\ncount: 2\n---\nbody'} onBodyChange={vi.fn()} />,
    );
    expect((screen.getByLabelText('Property 1 key') as HTMLInputElement).value).toBe('title');
    expect((screen.getByLabelText('Property 1 value') as HTMLInputElement).value).toBe('Hi');
    expect((screen.getByLabelText('Property 2 key') as HTMLInputElement).value).toBe('count');
  });

  it('splices an edited value back into the body', () => {
    const onBodyChange = vi.fn();
    render(
      <PropertiesPanel body={'---\ntitle: Old\n---\nthe body\n'} onBodyChange={onBodyChange} />,
    );
    fireEvent.change(screen.getByLabelText('Property 1 value'), {
      target: { value: 'New' },
    });
    expect(onBodyChange).toHaveBeenCalledWith('---\ntitle: New\n---\nthe body\n');
  });

  it('adds a new property row and writes it once a key+value exists', () => {
    const onBodyChange = vi.fn();
    render(<PropertiesPanel body={'body only'} onBodyChange={onBodyChange} />);
    fireEvent.click(screen.getByTestId('properties-add'));
    fireEvent.change(screen.getByLabelText('Property 1 key'), { target: { value: 'tag' } });
    fireEvent.change(screen.getByLabelText('Property 1 value'), { target: { value: 'x' } });
    // The last emitted body carries the new property prepended to the content.
    expect(onBodyChange).toHaveBeenLastCalledWith('---\ntag: x\n---\nbody only');
  });

  it('removes a property and drops the block when none remain', () => {
    const onBodyChange = vi.fn();
    render(
      <PropertiesPanel body={'---\ntitle: x\n---\nbody'} onBodyChange={onBodyChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove property 1' }));
    expect(onBodyChange).toHaveBeenCalledWith('body');
  });

  it('hides editing affordances when read-only', () => {
    render(
      <PropertiesPanel body={'---\ntitle: x\n---\n'} onBodyChange={vi.fn()} readOnly />,
    );
    expect(screen.queryByTestId('properties-add')).toBeNull();
    expect((screen.getByLabelText('Property 1 key') as HTMLInputElement).readOnly).toBe(true);
  });
});
