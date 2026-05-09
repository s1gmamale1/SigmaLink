// V3-W14-007 — Editor tab state hook. Owns current file, dirty flag, save.
// No abort controller: a request-id ref drops out-of-order results.

import { useCallback, useRef, useState } from 'react';
import { rpc } from '@/renderer/lib/rpc';

export interface EditorFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'binary';
  truncated: boolean;
  loadedAt: number;
}

export interface UseEditorResult {
  file: EditorFile | null;
  buffer: string;
  setBuffer: (next: string) => void;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  open: (path: string) => Promise<void>;
  save: (repoRoot: string) => Promise<void>;
}

export function useEditor(): UseEditorResult {
  const [file, setFile] = useState<EditorFile | null>(null);
  const [buffer, setBufferState] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track the in-flight `open` request id so a slow earlier load doesn't
  // overwrite a newer one when both resolve out-of-order.
  const reqIdRef = useRef(0);

  const open = useCallback(async (path: string) => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await rpc.fs.readFile({ path });
      if (reqIdRef.current !== myReq) return; // newer load already in flight
      const next: EditorFile = {
        path,
        content: res.content,
        encoding: res.encoding,
        truncated: res.truncated,
        loadedAt: Date.now(),
      };
      setFile(next);
      setBufferState(res.content);
    } catch (err) {
      if (reqIdRef.current !== myReq) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setFile(null);
      setBufferState('');
    } finally {
      if (reqIdRef.current === myReq) setLoading(false);
    }
  }, []);

  const setBuffer = useCallback((next: string) => {
    setBufferState(next);
  }, []);

  const save = useCallback(
    async (repoRoot: string) => {
      if (!file) return;
      try {
        await rpc.fs.writeFile({ path: file.path, content: buffer, repoRoot });
        // Sync `file.content` so the dirty flag clears.
        setFile({ ...file, content: buffer });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    },
    [file, buffer],
  );

  // The `open` callback above already clears `error` before each fetch, so we
  // don't need a separate effect to reset stale errors on path change.
  const dirty = file !== null && buffer !== file.content;

  return { file, buffer, setBuffer, dirty, loading, error, open, save };
}

// Synthetic "open this file" event. Other surfaces (chat, pane footer) fire
// this; EditorTab listens and opens the path. Keeps the wiring decoupled.
export const EDITOR_FOCUS_EVENT = 'editor:focus';

export interface EditorFocusDetail { path: string; }

export function dispatchEditorFocus(path: string): void {
  try {
    window.dispatchEvent(new CustomEvent(EDITOR_FOCUS_EVENT, { detail: { path } }));
  } catch {
    /* no window (SSR/test) — no-op. */
  }
}
