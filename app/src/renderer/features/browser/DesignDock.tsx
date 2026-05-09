// V3-W14-002, V3-W14-003, V3-W14-004 — Design-mode left dock. Mounted in the
// left rail of the Browser room while Design picker is on. Surfaces the most-
// recent capture (selector pill, outerHTML preview, screenshot), provider
// chips with shift/alt multi-select, and the prompt textarea with file-drop
// staging.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from 'react';
import { Send, ChevronDown, ChevronRight, Copy, Image as ImageIcon } from 'lucide-react';
import { rpc, onEvent } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';

interface CapturePayload {
  pickerToken: string;
  workspaceId: string;
  tabId: string;
  selector: string;
  outerHTML: string;
  computedStyles: Record<string, string>;
  screenshotPng: string;
  pageUrl: string;
}

interface PatchPayload {
  workspaceId: string;
  tabId: string;
  file: string;
  range?: { startLine: number; endLine: number };
}

const PROVIDERS = [
  { id: 'claude', label: 'Claude', color: '#E57035' },
  { id: 'codex', label: 'Codex', color: '#10A37F' },
  { id: 'gemini', label: 'Gemini', color: '#4285F4' },
  { id: 'opencode', label: 'OpenCode', color: '#F59E0B' },
] as const;

const KV_PROVIDERS_PREFIX = 'canvas.';
const KV_PROVIDERS_SUFFIX = '.lastProviders';

interface DesignDockProps {
  workspaceId: string;
  /** Optional canvas id when the user opened a Bridge Canvas. */
  canvasId?: string;
  /** Compact mode renders inline (under the AddressBar) rather than as a sidebar. */
  compact?: boolean;
}

export function DesignDock({ workspaceId, canvasId, compact }: DesignDockProps) {
  const [capture, setCapture] = useState<CapturePayload | null>(null);
  const [providers, setProviders] = useState<string[]>(['claude']);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [htmlOpen, setHtmlOpen] = useState(true);
  const [stagingDrag, setStagingDrag] = useState(false);
  const [lastPatch, setLastPatch] = useState<PatchPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const kvKey = useMemo(
    () => (canvasId ? `${KV_PROVIDERS_PREFIX}${canvasId}${KV_PROVIDERS_SUFFIX}` : null),
    [canvasId],
  );

  // Hydrate persisted last-used providers when a canvas is in scope.
  useEffect(() => {
    if (!kvKey) return;
    let alive = true;
    void (async () => {
      try {
        const stored = await rpc.kv.get(kvKey);
        if (!alive || !stored) return;
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
          setProviders(parsed.length ? parsed : ['claude']);
        }
      } catch {
        /* fall back to default */
      }
    })();
    return () => {
      alive = false;
    };
  }, [kvKey]);

  // Subscribe to capture events for this workspace.
  useEffect(() => {
    const off = onEvent<CapturePayload>('design:capture', (p) => {
      if (!p || p.workspaceId !== workspaceId) return;
      setCapture(p);
      setHtmlOpen(true);
    });
    return () => off();
  }, [workspaceId]);

  // Surface HMR patch toasts so the user can see when an agent's write
  // bounced into the browser tab.
  useEffect(() => {
    const off = onEvent<PatchPayload>('design:patch-applied', (p) => {
      if (!p || p.workspaceId !== workspaceId) return;
      setLastPatch(p);
    });
    return () => off();
  }, [workspaceId]);

  function persistProviders(next: string[]) {
    if (!kvKey) return;
    try {
      void rpc.kv.set(kvKey, JSON.stringify(next));
    } catch {
      /* non-fatal */
    }
  }

  function toggleProvider(id: string, e: MouseEvent<HTMLButtonElement>) {
    setProviders((prev) => {
      let next: string[];
      if (e.shiftKey) {
        next = prev.includes(id) ? prev : [...prev, id];
      } else if (e.altKey) {
        next = prev.filter((p) => p !== id);
        if (next.length === 0) next = ['claude'];
      } else {
        next = [id];
      }
      persistProviders(next);
      return next;
    });
  }

  function pasteSource() {
    if (!capture) return;
    setPrompt((curr) => {
      const sep = curr && !curr.endsWith('\n') ? '\n\n' : '';
      return curr + sep + capture.outerHTML;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  // ─────────────────────────────────────────── drag-and-drop ──

  function onDragOver(e: DragEvent<HTMLTextAreaElement>) {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      setStagingDrag(true);
    }
  }
  function onDragLeave() {
    setStagingDrag(false);
  }
  async function onDrop(e: DragEvent<HTMLTextAreaElement>) {
    e.preventDefault();
    setStagingDrag(false);
    if (!canvasId) {
      setError('Open a Bridge Canvas to stage assets.');
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const sigma = (window as unknown as { sigma?: { getPathForFile?: (f: File) => string } })
      .sigma;
    const stagingPaths: string[] = [];
    for (const file of files) {
      try {
        const filePath = sigma?.getPathForFile?.(file) ?? '';
        if (filePath) {
          const out = await rpc.design.attachFile({ canvasId, filePath });
          stagingPaths.push(out.stagingPath);
        } else {
          // Fallback: read the bytes and ship them across IPC as base64.
          const buf = await file.arrayBuffer();
          const bytesBase64 = arrayBufferToBase64(buf);
          const out = await rpc.design.attachFile({
            canvasId,
            bytesBase64,
            filename: file.name,
          });
          stagingPaths.push(out.stagingPath);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Attach failed: ${msg}`);
      }
    }
    if (stagingPaths.length === 0) return;
    setPrompt((curr) => {
      const sep = curr && !curr.endsWith('\n') ? '\n' : '';
      return curr + sep + stagingPaths.map((p) => `"${p}"`).join(' ');
    });
  }

  // ─────────────────────────────────────────── dispatch ──

  async function dispatch(e: MouseEvent<HTMLButtonElement>) {
    if (!prompt.trim()) {
      setError('Prompt is empty.');
      return;
    }
    if (providers.length === 0) {
      setError('Pick at least one provider.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpc.design.dispatch({
        pickerToken: capture?.pickerToken ?? '',
        prompt,
        providers,
        modifiers: { shift: e.shiftKey, alt: e.altKey },
        canvasId,
        workspaceId,
      });
      setPrompt('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  // ─────────────────────────────────────────── render ──

  return (
    <aside
      aria-label="Design dock"
      className={cn(
        'flex shrink-0 flex-col gap-2 overflow-y-auto border-r border-border bg-sidebar/60 p-2',
        compact ? 'w-full' : 'w-[260px]',
      )}
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Design
        </span>
        {lastPatch ? (
          <span
            className="rounded-sm bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-200"
            title={lastPatch.file}
          >
            HMR · {basename(lastPatch.file)}
          </span>
        ) : null}
      </div>

      {/* Capture card */}
      <section className="rounded-md border border-border bg-card/60">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="truncate font-mono text-[11px] text-foreground">
            {capture?.selector || 'No selection — click an element in the page'}
          </span>
          <button
            type="button"
            disabled={!capture}
            onClick={pasteSource}
            title="Paste outerHTML into prompt"
            className="ml-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Copy className="inline h-3 w-3 align-text-bottom" /> Paste source
          </button>
        </div>
        {capture ? (
          <>
            <button
              type="button"
              onClick={() => setHtmlOpen((v) => !v)}
              className="flex w-full items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent/30"
              aria-expanded={htmlOpen}
            >
              {htmlOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              outerHTML
            </button>
            {htmlOpen ? (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all border-t border-border bg-background/60 px-2 py-1 font-mono text-[10px] leading-snug text-foreground/80">
                <code className="sl-html">{capture.outerHTML}</code>
              </pre>
            ) : null}
            {capture.screenshotPng ? (
              <div className="border-t border-border p-2">
                <img
                  src={capture.screenshotPng}
                  alt="Captured element screenshot"
                  className="max-h-32 w-full rounded-sm border border-border bg-checker object-contain"
                />
              </div>
            ) : (
              <div className="flex items-center gap-1 border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground">
                <ImageIcon className="h-3 w-3 opacity-60" /> No screenshot captured
              </div>
            )}
          </>
        ) : null}
      </section>

      {/* Provider chips */}
      <section className="rounded-md border border-border bg-card/60 p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          Providers
          <span className="ml-1 normal-case text-muted-foreground/70">
            · click to set · shift add · alt remove
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {PROVIDERS.map((p) => {
            const on = providers.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={(e) => toggleProvider(p.id, e)}
                aria-pressed={on}
                className={cn(
                  'flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition',
                  on
                    ? 'border-foreground/40 bg-foreground/10 text-foreground'
                    : 'border-border bg-background/40 text-muted-foreground hover:bg-card',
                )}
                style={on ? { boxShadow: `inset 0 0 0 1px ${p.color}` } : undefined}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: p.color }}
                  aria-hidden
                />
                {p.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* Prompt buffer */}
      <section
        className={cn(
          'flex flex-col gap-2 rounded-md border bg-card/60 p-2 transition',
          stagingDrag ? 'border-blue-400 bg-blue-500/5' : 'border-border',
        )}
      >
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Prompt
          <span className="ml-1 normal-case text-muted-foreground/70">
            · drop files to attach
          </span>
        </div>
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          placeholder="Describe the change…"
          rows={5}
          spellCheck={false}
          className="min-h-[100px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-snug outline-none focus:ring-1 focus:ring-ring"
        />
        {error ? (
          <div className="rounded-sm bg-red-500/10 px-1.5 py-1 text-[10px] text-red-300">
            {error}
          </div>
        ) : null}
        <button
          type="button"
          onClick={dispatch}
          disabled={busy || !prompt.trim() || providers.length === 0}
          className="flex items-center justify-center gap-1.5 rounded-md bg-accent px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent-foreground transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          {busy ? 'Dispatching…' : `Dispatch · ${providers.length}`}
        </button>
      </section>
    </aside>
  );
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  // btoa is fine for binary strings shipped over IPC; the main process re-decodes.
  return btoa(binary);
}

function basename(p: string): string {
  if (!p) return '';
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}
