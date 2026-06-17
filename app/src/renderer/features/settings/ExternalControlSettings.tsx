// External Control MCP — Settings tab.
//
// Lets the operator manage the stdio MCP server that allows external agents
// (e.g. a remote Claude instance) to drive SigmaLink. Controls:
//   • Enable toggle  — starts/stops the MCP server.
//   • Freeze kill-switch — denies all external calls until unfrozen.
//   • Live connections read-out.
//   • Connect command field (copy-to-clipboard, warns it contains a secret).
//   • Rotate token button.

import { useCallback, useEffect, useState } from 'react';
import { Plug, ShieldOff, Copy, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { ControlStatus } from '@/shared/router-shape';

export function ExternalControlSettings() {
  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await rpc.control.status();
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  const guard = useCallback(
    async (fn: () => Promise<ControlStatus>) => {
      try {
        const next = await fn();
        setStatus(next);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const handleToggleEnabled = useCallback(
    (next: boolean) =>
      guard(() => (next ? rpc.control.enable() : rpc.control.disable())),
    [guard],
  );

  const handleToggleFreeze = useCallback(
    (next: boolean) =>
      guard(() => (next ? rpc.control.freeze() : rpc.control.unfreeze())),
    [guard],
  );

  const handleRotateToken = useCallback(
    () => guard(() => rpc.control.rotateToken()),
    [guard],
  );

  const handleCopy = useCallback(() => {
    const cmd = status?.connectCommand;
    if (!cmd) return;
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [status?.connectCommand]);

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading external control…
      </div>
    );
  }

  const enabled = status?.enabled ?? false;
  const frozen = status?.frozen ?? false;
  const liveConnections = status?.liveConnections ?? 0;

  return (
    <div data-testid="external-control-settings" className="max-w-2xl space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-primary" aria-hidden />
          <h3 className="text-sm font-semibold">External Control MCP</h3>
          <ConnectionPill enabled={enabled} frozen={frozen} connections={liveConnections} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Exposes a stdio MCP server so external agents can drive SigmaLink. The
          connection command below contains a secret token — keep it private.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <XCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Enable toggle */}
      <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/20 p-4">
        <div>
          <p className="text-sm font-medium leading-none">Enable external control</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Start the MCP server. External agents can connect only while this is on.
          </p>
        </div>
        <Switch
          data-testid="control-enable-switch"
          checked={enabled}
          onCheckedChange={(v) => void handleToggleEnabled(v)}
          aria-label="Enable external control"
        />
      </div>

      {/* Freeze kill-switch */}
      <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/20 p-4">
        <div>
          <div className="flex items-center gap-1.5">
            <ShieldOff className="h-4 w-4 text-amber-500" aria-hidden />
            <p className="text-sm font-medium leading-none">Freeze (kill-switch)</p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            When frozen, ALL external control calls are denied immediately — no
            action is taken regardless of the enable state. Toggle off to resume.
          </p>
          {frozen && (
            <p className="mt-1.5 text-xs font-semibold text-amber-500">
              Frozen — all external control denied.
            </p>
          )}
        </div>
        <Switch
          data-testid="control-freeze-switch"
          checked={frozen}
          disabled={!enabled}
          onCheckedChange={(v) => void handleToggleFreeze(v)}
          aria-label="Freeze external control"
        />
      </div>

      {/* Live connections */}
      <div className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-4">
        <p className="text-sm font-medium">Live connections</p>
        <span
          data-testid="control-live-connections"
          className="ml-auto rounded-full bg-background px-2.5 py-0.5 text-xs font-mono tabular-nums border border-border"
        >
          {liveConnections}
        </span>
      </div>

      {/* Connect command */}
      <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
        <div>
          <p className="text-sm font-medium">Connect command</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Run this in your external agent to connect via MCP.{' '}
            <span className="font-semibold text-amber-500">
              This string contains a secret token — do not share it.
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          <code
            data-testid="control-connect-command"
            className="flex-1 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground"
          >
            {status?.connectCommand ?? '(enable to generate)'}
          </code>
          <Button
            data-testid="control-copy-command"
            variant="outline"
            size="sm"
            disabled={!enabled || !status?.connectCommand}
            onClick={handleCopy}
            aria-label="Copy connect command"
          >
            {copied ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <Button
          data-testid="control-rotate-token"
          variant="outline"
          size="sm"
          disabled={!enabled}
          onClick={() => void handleRotateToken()}
        >
          <RefreshCw className="mr-1.5 h-3 w-3" />
          Rotate token
        </Button>
        <p className="text-xs text-muted-foreground">
          Rotating the token invalidates all existing connections. Reconnect each
          external agent using the new command.
        </p>
      </div>
    </div>
  );
}

function ConnectionPill({
  enabled,
  frozen,
  connections,
}: {
  enabled: boolean;
  frozen: boolean;
  connections: number;
}) {
  if (frozen) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500">
        <ShieldOff className="h-3 w-3" />
        Frozen
      </span>
    );
  }
  if (enabled && connections > 0) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-500">
        <CheckCircle2 className="h-3 w-3" />
        {connections} connected
      </span>
    );
  }
  if (enabled) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-500">
        <CheckCircle2 className="h-3 w-3" />
        Active
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      <XCircle className="h-3 w-3" />
      Inactive
    </span>
  );
}
