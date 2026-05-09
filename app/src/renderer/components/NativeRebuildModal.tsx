// V3-W14-009 — native-module rebuild prompt for the running app. Boot-time
// ABI mismatches are caught by the Wave-10 `checkNativeModules()` guard in
// `electron/main.ts` (separate diagnostic window). This modal handles the
// in-flight case: the main process emits `app:native-rebuild-needed` if a
// runtime require fails (e.g. after a background `pnpm install` rewrote
// node_modules while the app was open). Mounted once at App.tsx root.

import { useCallback, useEffect, useState } from 'react';
import { Copy, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { onEvent } from '@/renderer/lib/rpc';

const REBUILD_CMD = 'cd app && pnpm rebuild better-sqlite3 node-pty';

interface NativeRebuildPayload {
  modules?: Array<{ module: string; error?: string }>;
}

export function NativeRebuildModal() {
  const [open, setOpen] = useState(false);
  const [modules, setModules] = useState<NativeRebuildPayload['modules']>(undefined);

  useEffect(() => {
    return onEvent<NativeRebuildPayload>('app:native-rebuild-needed', (payload) => {
      setModules(payload?.modules);
      setOpen(true);
    });
  }, []);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(REBUILD_CMD);
      toast.success('Rebuild command copied');
    } catch {
      toast.error('Could not access clipboard — copy the command manually');
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden />
            Native module rebuild required
          </DialogTitle>
          <DialogDescription>
            A required native module is out of sync with the current Electron
            runtime. SigmaLink will keep working in a degraded state until you
            rebuild — usually after upgrading Electron or running a partial
            install.
          </DialogDescription>
        </DialogHeader>

        {modules && modules.length > 0 ? (
          <div className="rounded-md border border-border bg-card/40 p-3">
            <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Affected modules
            </div>
            <ul className="flex flex-col gap-1">
              {modules.map((m) => (
                <li key={m.module} className="font-mono text-xs">
                  <span className="text-amber-300">{m.module}</span>
                  {m.error ? (
                    <span className="ml-2 text-muted-foreground">— {m.error}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            Run from the repository root
          </div>
          <pre className="select-all whitespace-pre-wrap break-words rounded border border-border bg-background/60 p-2 font-mono text-xs">
            {REBUILD_CMD}
          </pre>
          <div className="mt-2 text-[11px] text-muted-foreground">
            After the rebuild completes, fully quit and relaunch SigmaLink. Do not
            run the command from inside this window — the running Electron is the
            very binary that needs to be re-linked.
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void onCopy()} className="gap-1">
            <Copy className="h-3.5 w-3.5" />
            Copy command
          </Button>
          <Button type="button" size="sm" onClick={() => setOpen(false)}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
