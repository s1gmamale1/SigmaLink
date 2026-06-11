// Spec 2026-06-10 (B) — image-staging concern extracted from PaneShell.tsx
// (PaneShell exceeded the 500-LOC guideline). PURE REFACTOR: behaviour is
// byte-for-byte identical to the inline version — this hook owns
//   • arrayBufferToBase64 (renderer-side ArrayBuffer→base64, no Buffer)
//   • stageAndInsertImages (panes.stageImage RPC → inject the absolute @path)
//   • the drop-handler IMAGE BRANCH (partition image files from path-mention
//     files on an image-capable pane), and
//   • the capture-phase `paste` interceptor effect (xterm reads only
//     text/plain so an image clipboard was silently swallowed).
//
// ADR-003 semantics preserved: stage a temp file + inject `@path`, NEVER
// clipboard-write (Claude Code reads legacy «class PNGf»; Electron writes
// public.png — anthropics/claude-code#30936). The IMAGE_CAPABLE_PROVIDERS
// gate (isImageCapableProvider) is the same one used inline.

import { useCallback, useEffect, type RefObject } from 'react';
import { toast } from 'sonner';
import { rpc } from '@/renderer/lib/rpc';
import { insertMention } from './insertMention';
import { isImageCapableProvider } from '@/shared/providers';
import type { AgentSession } from '@/shared/types';

// Spec 2026-06-10 (B) — renderer-side ArrayBuffer→base64 (no Buffer in the
// renderer). Chunked to stay under the fromCharCode argument-count limit.
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface UsePaneImageStagingArgs {
  /** Pane session id — staged @paths are injected into this PTY. */
  sessionId: string;
  /** Provider id — gates whether image staging applies (image-capable only). */
  providerId: string;
  /** Pane status — staging only injects into a `running` pane (paste path). */
  status: AgentSession['status'];
  /** The pane container; the paste interceptor only fires for events inside it. */
  containerRef: RefObject<HTMLDivElement | null>;
}

export interface UsePaneImageStaging {
  /**
   * Whether this pane is image-capable (so the drop handler should partition
   * out image files for staging instead of degrading them to path-mentions).
   */
  isImageCapable: boolean;
  /**
   * Stage image bytes via panes.stageImage and inject the ABSOLUTE @path
   * (insertMention prefixes '@'). Absolute (not workspace-relative) because
   * screenshots live outside the workspace (/var/folders/…) and the CLI must
   * open the file from the prompt path alone.
   */
  stageAndInsertImages: (imageFiles: File[]) => Promise<void>;
}

/**
 * Spec 2026-06-10 (B) — encapsulates a pane's image-staging behaviour:
 * the drop-branch staging helper + the capture-phase paste interceptor.
 * Wiring the hook installs the paste listener for this pane's lifetime.
 */
export function usePaneImageStaging({
  sessionId,
  providerId,
  status,
  containerRef,
}: UsePaneImageStagingArgs): UsePaneImageStaging {
  const isImageCapable = isImageCapableProvider(providerId);

  // Shared by the drop branch and the paste interceptor.
  const stageAndInsertImages = useCallback(
    async (imageFiles: File[]): Promise<void> => {
      for (const file of imageFiles) {
        try {
          const buf = await file.arrayBuffer();
          const ext = (file.type.split('/')[1] ?? 'png').toLowerCase();
          const { absPath } = await rpc.panes.stageImage({ bytesBase64: arrayBufferToBase64(buf), ext });
          await insertMention(sessionId, absPath, status);
          toast.success('Screenshot staged for the agent', { description: absPath });
        } catch (err) {
          toast.error('Could not stage image', { description: err instanceof Error ? err.message : String(err) });
        }
      }
    },
    [sessionId, status],
  );

  // Spec 2026-06-10 (B) — intercept image PASTE before xterm. xterm's paste
  // handler reads only text/plain, so an image clipboard (macOS screenshot)
  // produced "" and was silently swallowed. Capture phase on window +
  // containment check, mirroring the Cmd+T handler in PaneShell. Text pastes
  // fall through untouched (no preventDefault) so xterm still handles them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function handlePaste(e: ClipboardEvent): void {
      if (!container!.contains(e.target as Node)) return;
      if (!isImageCapableProvider(providerId)) return;
      if (status !== 'running') return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
      if (!imageItem) return; // text paste — let xterm handle it
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void stageAndInsertImages([file]);
    }

    window.addEventListener('paste', handlePaste, true);
    return () => window.removeEventListener('paste', handlePaste, true);
  }, [containerRef, providerId, status, stageAndInsertImages]);

  return { isImageCapable, stageAndInsertImages };
}
