// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { fs, toast } = vi.hoisted(() => {
  const fs = {
    createFile: vi.fn(async () => ({ ok: true as const })),
    mkdir: vi.fn(async () => ({ ok: true as const })),
    rename: vi.fn(async () => ({ ok: true as const })),
    trash: vi.fn(async () => ({ ok: true as const })),
  };
  const toast = { success: vi.fn(), error: vi.fn() };
  return { fs, toast };
});
vi.mock('@/renderer/lib/rpc', () => ({ rpcSilent: { fs }, rpc: { fs } }));
vi.mock('sonner', () => ({ toast }));

import { useFileMutations } from './useFileMutations';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useFileMutations', () => {
  it('createFile joins dir+name, calls rpc, returns the new path', async () => {
    const { result } = renderHook(() => useFileMutations());
    let out: string | null = null;
    await act(async () => {
      out = await result.current.createFile('/ws/src', 'new.ts');
    });
    expect(fs.createFile).toHaveBeenCalledWith({ path: '/ws/src/new.ts' });
    expect(out).toBe('/ws/src/new.ts');
    expect(toast.success).toHaveBeenCalled();
  });

  it('createFolder calls fs.mkdir and returns the new path', async () => {
    const { result } = renderHook(() => useFileMutations());
    let out: string | null = null;
    await act(async () => {
      out = await result.current.createFolder('/ws', 'sub');
    });
    expect(fs.mkdir).toHaveBeenCalledWith({ path: '/ws/sub' });
    expect(out).toBe('/ws/sub');
  });

  it('rename keeps the parent dir and swaps the basename', async () => {
    const { result } = renderHook(() => useFileMutations());
    let out: string | null = null;
    await act(async () => {
      out = await result.current.rename('/ws/a.txt', 'b.txt');
    });
    expect(fs.rename).toHaveBeenCalledWith({ from: '/ws/a.txt', to: '/ws/b.txt' });
    expect(out).toBe('/ws/b.txt');
    expect(toast.success).toHaveBeenCalled();
  });

  it('move reparents under destDir keeping the basename', async () => {
    const { result } = renderHook(() => useFileMutations());
    let out: string | null = null;
    await act(async () => {
      out = await result.current.move('/ws/src/a.txt', '/ws/dest');
    });
    expect(fs.rename).toHaveBeenCalledWith({ from: '/ws/src/a.txt', to: '/ws/dest/a.txt' });
    expect(out).toBe('/ws/dest/a.txt');
    expect(toast.success).toHaveBeenCalled();
  });

  it('trash calls fs.trash and returns true', async () => {
    const { result } = renderHook(() => useFileMutations());
    let ok = false;
    await act(async () => {
      ok = await result.current.trash('/ws/gone.txt');
    });
    expect(fs.trash).toHaveBeenCalledWith({ path: '/ws/gone.txt' });
    expect(ok).toBe(true);
  });

  it('trash surfaces a backend error as a toast and returns false', async () => {
    fs.trash.mockRejectedValueOnce(new Error('fs.trash: EACCES'));
    const { result } = renderHook(() => useFileMutations());
    let ok = true;
    await act(async () => {
      ok = await result.current.trash('/ws/x.txt');
    });
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('fs.trash: EACCES');
  });

  it('surfaces a backend error as a toast and returns null', async () => {
    fs.createFile.mockRejectedValueOnce(new Error('fs.createFile: EEXIST'));
    const { result } = renderHook(() => useFileMutations());
    let out: string | null = 'x';
    await act(async () => {
      out = await result.current.createFile('/ws', 'dup.txt');
    });
    expect(out).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('fs.createFile: EEXIST');
  });
});
