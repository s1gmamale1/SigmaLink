// R-1 — Settings → Telegram tab. SECURITY-CRITICAL surface for the Jorvis
// Telegram remote.
//
// The bot token is WRITE-ONLY: this component shows "Token set ✓" / "Not set"
// but NEVER displays or fetches the token value (the controller has no getter).
// When at-rest encryption is unavailable, the token field is disabled and a
// loud warning replaces it. The tab also exposes the enable toggle, a numeric
// chat-id allowlist editor, Lock/Unlock with a running/locked status pill, an
// idle-lock-minutes input, and a scrollable audit tail (polled).

import { useCallback, useEffect, useState } from 'react';
import {
  Send,
  ShieldAlert,
  Lock,
  Unlock,
  Plus,
  X,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { TelegramRemoteStatus, TelegramAuditEntry } from '@/shared/router-shape';

const DEFAULT_IDLE_LOCK_MIN = 30;

export function TelegramTab() {
  const [status, setStatus] = useState<TelegramRemoteStatus | null>(null);
  const [audit, setAudit] = useState<TelegramAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tokenDraft, setTokenDraft] = useState('');
  const [newChatId, setNewChatId] = useState('');
  const [idleLockMin, setIdleLockMin] = useState(String(DEFAULT_IDLE_LOCK_MIN));

  const refresh = useCallback(async () => {
    try {
      const [s, a, idleRaw] = await Promise.all([
        rpc.telegram.getStatus(),
        rpc.telegram.auditTail(50),
        rpc.kv.get('remote.telegram.idleLockMinutes'),
      ]);
      setStatus(s);
      setAudit(a);
      if (idleRaw) setIdleLockMin(idleRaw);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refresh());
    const interval = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const guard = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const handleSaveToken = useCallback(async () => {
    const token = tokenDraft.trim();
    if (!token) return;
    await guard(async () => {
      await rpc.telegram.setToken(token);
      // Clear the draft immediately — never keep the secret in component state.
      setTokenDraft('');
    });
  }, [tokenDraft, guard]);

  const handleClearToken = useCallback(
    () => guard(() => rpc.telegram.clearToken()),
    [guard],
  );

  const handleToggleEnabled = useCallback(
    (next: boolean) => guard(() => rpc.telegram.setEnabled(next)),
    [guard],
  );

  const handleAddChatId = useCallback(async () => {
    const id = Number(newChatId.trim());
    if (!Number.isInteger(id)) {
      setError('Chat id must be a whole number.');
      return;
    }
    const current = status?.allowlist ?? [];
    if (current.includes(id)) {
      setNewChatId('');
      return;
    }
    await guard(async () => {
      await rpc.telegram.setAllowlist([...current, id]);
      setNewChatId('');
    });
  }, [newChatId, status, guard]);

  const handleRemoveChatId = useCallback(
    (id: number) => {
      const next = (status?.allowlist ?? []).filter((x) => x !== id);
      return guard(() => rpc.telegram.setAllowlist(next));
    },
    [status, guard],
  );

  const handleSaveIdleLock = useCallback(() => {
    const n = Number(idleLockMin.trim());
    const minutes = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    return guard(() => rpc.telegram.setIdleLockMinutes(minutes));
  }, [idleLockMin, guard]);

  const handleLock = useCallback(() => guard(() => rpc.telegram.lock()), [guard]);
  const handleUnlock = useCallback(() => guard(() => rpc.telegram.unlock()), [guard]);

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading Telegram remote…
      </div>
    );
  }

  const encryptionAvailable = status?.encryptionAvailable ?? false;
  const tokenSet = status?.tokenSet ?? false;
  const allowlist = status?.allowlist ?? [];

  return (
    <div data-testid="telegram-settings-tab" className="max-w-2xl space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 text-primary" aria-hidden />
          <h3 className="text-sm font-semibold">Jorvis remote (Telegram)</h3>
          <StatusPill status={status} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Create a bot via <span className="font-mono">@BotFather</span>, paste the token, add
          your numeric chat id, then Enable. Jorvis stays inert until all three are set.
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
          <p className="text-sm font-medium leading-none">Enable remote</p>
          <p className="mt-1 text-xs text-muted-foreground">
            When on (and a token + allowlist exist), Jorvis answers from your bot.
          </p>
        </div>
        <Switch
          data-testid="telegram-enable-switch"
          checked={status?.enabled ?? false}
          onCheckedChange={(v) => void handleToggleEnabled(v)}
          aria-label="Enable Telegram remote"
        />
      </div>

      {/* Token (write-only) */}
      <div className="space-y-2 rounded-md border border-border bg-muted/20 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Bot token</p>
          <span className="flex items-center gap-1 text-xs" data-testid="telegram-token-state">
            {tokenSet ? (
              <>
                <CheckCircle2 className="h-3 w-3 text-green-500" />
                <span className="text-green-500">Token set ✓</span>
              </>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </span>
        </div>

        {!encryptionAvailable ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p>
              At-rest encryption is unavailable on this machine, so SigmaLink refuses to store a
              bot token. Install a system keyring (Keychain / DPAPI / libsecret) and reopen this
              tab.
            </p>
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              data-testid="telegram-token-input"
              type="password"
              autoComplete="off"
              placeholder={tokenSet ? 'Replace token…' : '123456:ABC-DEF…'}
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
            />
            <Button
              data-testid="telegram-token-save"
              onClick={() => void handleSaveToken()}
              disabled={tokenDraft.trim().length === 0}
            >
              Save
            </Button>
            {tokenSet && (
              <Button variant="outline" onClick={() => void handleClearToken()}>
                Clear
              </Button>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          The token is encrypted and never shown again — not even here.
        </p>
      </div>

      {/* Allowlist */}
      <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
        <div>
          <p className="text-sm font-medium">Allowed chat ids</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Only these numeric chat ids may talk to Jorvis. Everything else is dropped silently.
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            data-testid="telegram-chatid-input"
            inputMode="numeric"
            placeholder="e.g. 123456789"
            value={newChatId}
            onChange={(e) => setNewChatId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAddChatId();
            }}
          />
          <Button
            data-testid="telegram-chatid-add"
            variant="outline"
            onClick={() => void handleAddChatId()}
          >
            <Plus className="mr-1 h-3 w-3" />
            Add
          </Button>
        </div>
        {allowlist.length === 0 ? (
          <p className="text-xs text-muted-foreground">No chat ids yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="telegram-allowlist">
            {allowlist.map((id) => (
              <li
                key={id}
                className="flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-mono"
              >
                {id}
                <button
                  type="button"
                  aria-label={`Remove ${id}`}
                  data-testid={`telegram-allowlist-remove-${id}`}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => void handleRemoveChatId(id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Lock + idle-lock */}
      <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {status?.locked ? (
            <Button data-testid="telegram-unlock" variant="outline" onClick={() => void handleUnlock()}>
              <Unlock className="mr-1.5 h-3 w-3" />
              Unlock
            </Button>
          ) : (
            <Button data-testid="telegram-lock" variant="outline" onClick={() => void handleLock()}>
              <Lock className="mr-1.5 h-3 w-3" />
              Lock
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            Locking drops all inbound until you unlock (or send <span className="font-mono">/unlock</span>).
          </span>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Idle auto-lock (minutes, 0 = off)</span>
            <Input
              data-testid="telegram-idle-input"
              inputMode="numeric"
              className="w-32"
              value={idleLockMin}
              onChange={(e) => setIdleLockMin(e.target.value)}
            />
          </label>
          <Button variant="outline" onClick={() => void handleSaveIdleLock()}>
            Save
          </Button>
        </div>
      </div>

      {/* Audit tail */}
      <div className="space-y-2 rounded-md border border-border bg-muted/20 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Activity log</p>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="mr-1 h-3 w-3" />
            Refresh
          </Button>
        </div>
        {audit.length === 0 ? (
          <p className="text-xs text-muted-foreground">No activity yet.</p>
        ) : (
          <ul
            data-testid="telegram-audit"
            className="max-h-48 space-y-1 overflow-y-auto font-mono text-[11px] leading-relaxed"
          >
            {audit.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="flex gap-2 text-muted-foreground">
                <span className="shrink-0 tabular-nums">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
                <span className="shrink-0 font-semibold text-foreground">{e.kind}</span>
                <span className="truncate">{e.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: TelegramRemoteStatus | null }) {
  if (status?.locked) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500">
        <Lock className="h-3 w-3" />
        Locked
      </span>
    );
  }
  if (status?.running) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-500">
        <CheckCircle2 className="h-3 w-3" />
        Running
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
