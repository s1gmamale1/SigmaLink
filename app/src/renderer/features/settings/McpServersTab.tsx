// MCP servers tab — read-only listing of the per-workspace MCP services.
// v1.2.6: Browser MCP is now stdio (npx-on-demand); SigmaMemory remains our
// internal stdio server. Both are surfaced passively.

import { useCallback, useEffect, useState } from 'react';
import { Globe, RefreshCcw, Server, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';

interface Entry {
  workspaceId: string;
  workspaceName: string;
  browserMcp: { command: string; args: string[] } | null;
  memoryMcp: { command: string; args: string[] } | null;
}

export function McpServersTab() {
  const { state } = useAppState();
  const [rows, setRows] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const out: Entry[] = [];
      for (const w of state.workspaces) {
        const memory = await rpc.memory.getMcpCommand({ workspaceId: w.id }).catch(() => null);
        out.push({
          workspaceId: w.id,
          workspaceName: w.name,
          browserMcp: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.75'] },
          memoryMcp: memory ?? null,
        });
      }
      setRows(out);
    } finally {
      setBusy(false);
    }
  }, [state.workspaces]);

  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          MCP services SigmaLink supervises per workspace. Read-only.
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void refresh()}
          disabled={busy}
          className="gap-1"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No workspaces yet"
          description="Open a project folder to see its MCP services here."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.workspaceId}
              className="rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
            >
              <div className="font-medium">{r.workspaceName}</div>
              <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <div className="rounded border border-border/60 bg-muted/20 px-2 py-1.5">
                  <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Globe className="h-3 w-3" /> Browser MCP
                  </div>
                  <div className="mt-1 truncate font-mono" title={r.browserMcp ? `${r.browserMcp.command} ${r.browserMcp.args.join(' ')}` : ''}>
                    {r.browserMcp ? (
                      `${r.browserMcp.command} ${r.browserMcp.args.join(' ')}`
                    ) : (
                      <span className="text-muted-foreground">— not started —</span>
                    )}
                  </div>
                </div>
                <div className="rounded border border-border/60 bg-muted/20 px-2 py-1.5">
                  <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Sparkles className="h-3 w-3" /> SigmaMemory MCP
                  </div>
                  <div className="mt-1 truncate font-mono" title={r.memoryMcp ? r.memoryMcp.command : ''}>
                    {r.memoryMcp ? (
                      `${r.memoryMcp.command} ${r.memoryMcp.args.join(' ')}`
                    ) : (
                      <span className="text-muted-foreground">— not started —</span>
                    )}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
