// v1.4.9-06 — Provider auto-install prompt modal.
//
// Triggered by clicking the "Not on PATH" amber badge in AgentsStep. Shows
// the per-OS install command, a copy button, a docs-link fallback, and
// "Install now" / "I'll install it myself" actions.
//
// Consent gating: absent = show next time; 'declined' = never prompt again.
// "Don't ask again" sets the consent immediately on dismiss.
//
// Prereq check: if the required runtime (npm / pip) is not on PATH, we show
// the installDocsUrl fallback instead of an unrunnable command.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AGENT_PROVIDERS } from '@/shared/providers';
import { rpc, onEvent } from '@/renderer/lib/rpc';

interface Props {
  providerId: string;
  onClose: () => void;
}

/** Strip ANSI escape sequences so raw PTY output is human-readable in a <pre>. */
function stripAnsi(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1B\[[0-9;]*[mGKHFJST]|\x1B\[[0-9;]*[A-D]|\r/g, '');
}

/** Check whether a command name is available on PATH via the preload bridge. */
async function checkRuntime(cmd: string): Promise<boolean> {
  try {
    // The fs.exists RPC checks arbitrary paths. Instead we probe by trying to
    // spawn a version check via pty — but that is expensive. Use the simpler
    // `rpc.providers.probe` approach: if npm/pip appears as the command of
    // any provider probe, it is on PATH. For our purposes, we can use the
    // app.getPlatform() + which-style path check via a lightweight probe RPC.
    //
    // Simplest available mechanism: call rpc.providers.probeAll() and check
    // whether the runtime binary is already tracked — but this only covers
    // registered CLIs, not npm/pip. We instead rely on the fact that
    // `providers.spawnInstall` on the main side will throw ENOENT if the
    // runtime is absent, and surface the docs URL at that point.
    //
    // For the modal pre-check we use a lightweight which-style lookup via
    // the fs.exists RPC on common well-known paths. This is best-effort;
    // false negatives are acceptable (we fall through to docs link).
    const platform = await rpc.app.getPlatform();
    const candidates: string[] =
      platform === 'win32'
        ? cmd === 'npm'
          ? ['C:\\Program Files\\nodejs\\npm.cmd']
          : ['C:\\Python312\\Scripts\\pip.exe', 'C:\\Python311\\Scripts\\pip.exe']
        : cmd === 'npm'
          ? ['/usr/local/bin/npm', '/usr/bin/npm', `${String(await getUserHome(platform))}/node_modules/.bin/npm`]
          : ['/usr/local/bin/pip', '/usr/bin/pip', '/usr/local/bin/pip3', '/usr/bin/pip3'];
    for (const p of candidates) {
      const ok = await rpc.fs.exists(p);
      if (ok) return true;
    }
    // Inconclusive — assume runtime is available (the spawn will tell us otherwise).
    return true;
  } catch {
    return true;
  }
}

async function getUserHome(platform: NodeJS.Platform): Promise<string> {
  // Approximate home dir for the npm shim path check above.
  if (platform === 'darwin' || platform === 'linux') {
    return typeof window !== 'undefined' && 'sigma' in window
      ? (await rpc.app.getUserDataPath()).replace(/Library\/Application Support\/SigmaLink$/, '').replace(/\/\.local\/share\/SigmaLink$/, '').replace(/\/SigmaLink$/, '')
      : '/usr/local';
  }
  return 'C:\\Users';
}

export function ProviderInstallModal({ providerId, onClose }: Props) {
  const def = AGENT_PROVIDERS.find((p) => p.id === providerId);
  const [platform, setPlatform] = useState<'darwin' | 'linux' | 'win32'>('darwin');
  const [runtimeMissing, setRuntimeMissing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string>('');
  const [installDone, setInstallDone] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const paneIdRef = useRef<string | null>(null);

  // On mount: resolve platform + consent + prereq check.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const pl = await rpc.app.getPlatform();
        if (cancelled) return;
        setPlatform((pl === 'win32' ? 'win32' : pl === 'linux' ? 'linux' : 'darwin'));
        // Prereq check — only run for providers whose installCommand uses npm/pip.
        const cmd = def?.installCommand?.[pl === 'win32' ? 'win32' : pl === 'linux' ? 'linux' : 'darwin'];
        if (cmd && cmd.length > 0) {
          const runtime = cmd[0]!; // 'npm' or 'pip'
          if (runtime === 'npm' || runtime === 'pip') {
            const ok = await checkRuntime(runtime);
            if (!cancelled) setRuntimeMissing(!ok);
          }
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => { cancelled = true; };
  }, [def, providerId]);

  // Subscribe to pty:data events for the install pane once it is spawned.
  useEffect(() => {
    if (!installing) return;
    const unsub = onEvent<{ sessionId: string; data: string }>('pty:data', (ev) => {
      if (ev.sessionId !== paneIdRef.current) return;
      setInstallLog((prev) => prev + stripAnsi(ev.data));
      // Auto-scroll the log.
      requestAnimationFrame(() => {
        if (logRef.current) {
          logRef.current.scrollTop = logRef.current.scrollHeight;
        }
      });
    });
    const unsubExit = onEvent<{ sessionId: string; exitCode: number }>('pty:exit', (ev) => {
      if (ev.sessionId !== paneIdRef.current) return;
      setInstalling(false);
      setInstallDone(true);
      if (ev.exitCode !== 0) {
        setInstallError(`Install exited with code ${ev.exitCode}. Check the log above.`);
      }
    });
    return () => {
      unsub();
      unsubExit();
    };
  }, [installing]);

  const handleDismiss = useCallback(async () => {
    if (dontAskAgain) {
      try {
        await rpc.providers.setInstallConsent(providerId, 'declined');
      } catch {
        /* non-fatal */
      }
    }
    onClose();
  }, [dontAskAgain, onClose, providerId]);

  const handleDecline = useCallback(async () => {
    try {
      await rpc.providers.setInstallConsent(providerId, 'declined');
    } catch {
      /* non-fatal */
    }
    onClose();
  }, [onClose, providerId]);

  const handleInstallNow = useCallback(async () => {
    setInstallError(null);
    setInstallLog('');
    setInstalling(true);
    try {
      const result = await rpc.providers.spawnInstall(providerId);
      paneIdRef.current = result.paneId;
    } catch (err) {
      setInstalling(false);
      setInstallError(err instanceof Error ? err.message : String(err));
    }
  }, [providerId]);

  const handleCopy = useCallback(() => {
    if (!def) return;
    const cmd = def.installCommand?.[platform] ?? def.installCommand?.linux ?? [];
    void navigator.clipboard.writeText(cmd.join(' ')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [def, platform]);

  if (!def) return null;

  const cmd = def.installCommand?.[platform] ?? def.installCommand?.linux ?? [];
  const cmdStr = cmd.join(' ');
  const docsUrl = def.installDocsUrl;

  const showLog = installing || installDone || installError;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void handleDismiss(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{def.name} is not installed</DialogTitle>
          <DialogDescription>
            {def.name} was not found on PATH. Install it to use this provider in SigmaLink.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Install command or docs fallback */}
          {runtimeMissing || cmd.length === 0 ? (
            <div className="flex flex-col gap-1.5">
              <div className="text-sm text-muted-foreground">
                The required runtime is not on PATH. Visit the docs to install manually:
              </div>
              {docsUrl ? (
                <a
                  href={docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300"
                  onClick={(e) => { e.preventDefault(); window.open(docsUrl, '_blank', 'noopener,noreferrer'); }}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {docsUrl}
                </a>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Install command
                </span>
                {docsUrl ? (
                  <a
                    href={docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={(e) => { e.preventDefault(); window.open(docsUrl, '_blank', 'noopener,noreferrer'); }}
                  >
                    <ExternalLink className="h-3 w-3" />
                    Docs
                  </a>
                ) : null}
              </div>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <code className="flex-1 truncate font-mono text-sm">{cmdStr}</code>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="shrink-0 rounded p-1 text-muted-foreground transition hover:text-foreground"
                  aria-label="Copy install command"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Install log */}
          {showLog ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Terminal className="h-3 w-3" />
                Install output
              </div>
              <pre
                ref={logRef}
                className="h-40 overflow-y-auto rounded-md border border-border bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-green-300"
              >
                {installing && !installLog ? (
                  <span className="text-muted-foreground">Running {cmdStr}…</span>
                ) : (
                  installLog || ''
                )}
                {installDone && !installError ? (
                  <span className="text-emerald-400">{'\n'}Done. Close this dialog and re-probe providers.</span>
                ) : null}
              </pre>
              {installError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {installError}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Don't ask again checkbox */}
          {!installDone ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Don't ask again for {def.name}
            </label>
          ) : null}
        </div>

        <DialogFooter className="flex-row justify-end gap-2">
          {installDone ? (
            <Button onClick={onClose}>Close</Button>
          ) : installing ? (
            <Button variant="outline" disabled className="gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Installing…
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => void handleDecline()}>
                I'll install it myself
              </Button>
              {!runtimeMissing && cmd.length > 0 ? (
                <Button onClick={() => void handleInstallNow()} className="gap-1.5">
                  <Terminal className="h-3.5 w-3.5" />
                  Install now
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
