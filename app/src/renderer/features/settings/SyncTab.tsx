// v1.5.0 packet 09 — Settings → Sync tab.
// v1.5.1-C — Added "Anonymise paths" toggle (caveat 2).
//
// Mounted in SettingsRoom.tsx next to the existing settings tabs.
// Shows sync status, conflict badge, and entry point to the setup wizard.

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, GitBranch, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import type { SyncStatus, SyncConflict } from '@/shared/types';
import { ConflictReview } from '@/renderer/features/sync-setup/ConflictReview';
import { SetupWizard } from '@/renderer/features/sync-setup/SetupWizard';

type View = 'overview' | 'setup-wizard' | 'conflicts';

export function SyncTab() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [isConfigured, setIsConfigured] = useState(false);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [view, setView] = useState<View>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [anonymisePaths, setAnonymisePaths] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const [s, configured, c, anonRaw] = await Promise.all([
        rpc.sync.status(),
        rpc.sync.isConfigured(),
        rpc.sync.listConflicts(),
        rpc.kv.get('sync.anonymisePaths'),
      ]);
      setStatus(s);
      setIsConfigured(configured);
      setConflicts(c);
      setAnonymisePaths(anonRaw === '1');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleToggleAnonymise = useCallback(async () => {
    const next = !anonymisePaths;
    setAnonymisePaths(next);
    try {
      await rpc.kv.set('sync.anonymisePaths', next ? '1' : '0');
    } catch (e) {
      // Revert optimistic update on failure.
      setAnonymisePaths(!next);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [anonymisePaths]);

  useEffect(() => {
    queueMicrotask(() => void refreshStatus());
    // Refresh every 10 seconds to pick up status changes.
    const interval = setInterval(() => void refreshStatus(), 10_000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handleDisable = useCallback(async () => {
    try {
      await rpc.sync.disable();
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refreshStatus]);

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading sync status...
      </div>
    );
  }

  if (view === 'setup-wizard') {
    return (
      <SetupWizard
        onComplete={() => {
          setView('overview');
          void refreshStatus();
        }}
        onCancel={() => setView('overview')}
      />
    );
  }

  if (view === 'conflicts') {
    return (
      <ConflictReview
        conflicts={conflicts}
        onResolved={() => {
          void refreshStatus();
          setView('overview');
        }}
        onBack={() => setView('overview')}
      />
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h3 className="text-sm font-semibold">Cross-machine sync</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Sync your sessions, memories, and conversations across devices using your
          own private git repository. Fully encrypted — only you can read your data.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <XCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Status card */}
      <div className="rounded-md border border-border bg-muted/20 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Sync status</span>
          </div>
          <StatusBadge status={status} isConfigured={isConfigured} />
        </div>

        {status?.lastPushAt && (
          <p className="text-xs text-muted-foreground">
            Last push: {new Date(status.lastPushAt).toLocaleString()}
          </p>
        )}
        {status?.lastPullAt && (
          <p className="text-xs text-muted-foreground">
            Last pull: {new Date(status.lastPullAt).toLocaleString()}
          </p>
        )}
        {status?.lastError && (
          <p className="text-xs text-destructive">Error: {status.lastError}</p>
        )}
      </div>

      {/* Conflicts banner */}
      {(status?.pendingConflicts ?? 0) > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="flex-1 text-sm">
            <span className="font-medium">{status!.pendingConflicts} conflict{status!.pendingConflicts !== 1 ? 's' : ''} need review.</span>
            <button
              type="button"
              className="ml-2 underline text-primary hover:no-underline"
              onClick={() => setView('conflicts')}
            >
              Review now
            </button>
          </div>
        </div>
      )}

      {/* Upgrade pending */}
      {(status?.pendingUpgrade ?? 0) > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-blue-500/50 bg-blue-500/10 px-3 py-2">
          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
          <p className="text-sm">
            {status!.pendingUpgrade} sync blob{status!.pendingUpgrade !== 1 ? 's' : ''} pending schema upgrade.
            Update SigmaLink to apply.
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {!isConfigured && (
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => setView('setup-wizard')}
          >
            Set up sync
          </button>
        )}
        {isConfigured && !status?.enabled && (
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => {
              // Re-enable with stored config — user won't need to re-enter
              // creds since they are stored in CredentialStore.
              setView('setup-wizard');
            }}
          >
            Enable sync
          </button>
        )}
        {status?.enabled && (
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={() => void handleDisable()}
          >
            Disable sync
          </button>
        )}
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          onClick={() => void refreshStatus()}
        >
          <RefreshCw className="mr-1.5 inline h-3 w-3" />
          Refresh
        </button>
      </div>

      {/* Anonymise paths toggle (v1.5.1-C caveat 2) */}
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={anonymisePaths}
          onClick={() => void handleToggleAnonymise()}
          className={[
            'relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            anonymisePaths ? 'bg-primary' : 'bg-muted',
          ].join(' ')}
        >
          <span
            className={[
              'pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              anonymisePaths ? 'translate-x-4' : 'translate-x-0',
            ].join(' ')}
          />
        </button>
        <div>
          <p className="text-sm font-medium leading-none">Anonymise paths</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Replaces your home directory with{' '}
            <code className="font-mono">~/</code> in synced workspace paths so
            other machines can&apos;t see your username.
          </p>
        </div>
      </div>

      {/* Security note */}
      <div className="rounded-md bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">Security notes</p>
        <p>
          All data is encrypted before leaving your device using XChaCha20-Poly1305.
          Your git host only sees ciphertext — it cannot read your conversations or memories.
        </p>
        <p>
          Recovery depends on your 24-word mnemonic phrase. If you lose your mnemonic
          AND all your devices, your synced data is permanently unrecoverable.
          SigmaLink cannot recover it for you.
        </p>
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  isConfigured,
}: {
  status: SyncStatus | null;
  isConfigured: boolean;
}) {
  if (!isConfigured) {
    return <span className="text-xs text-muted-foreground">Not configured</span>;
  }
  if (status?.enabled) {
    return (
      <span className="flex items-center gap-1 text-xs text-green-500">
        <CheckCircle2 className="h-3 w-3" />
        Active
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <XCircle className="h-3 w-3" />
      Disabled
    </span>
  );
}
