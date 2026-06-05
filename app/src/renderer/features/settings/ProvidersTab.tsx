// Providers tab — re-uses providers.list / providers.probeAll. The user can
// trigger a fresh probe via the "Re-probe" button. Found providers show a
// green dot + version (when known); missing ones show the install hint
// inline so the user can copy-paste it into their shell.
//
// V3-W12-003: legacy providers are gated when present. The "Show legacy
// providers" switch persists to kv['providers.showLegacy'] (default '0').
// Coming-soon rows render with a chip and the install hint as their badge.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, RefreshCcw, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { rpc } from '@/renderer/lib/rpc';
import type { ProviderProbe } from '@/shared/types';
import { AGENT_PROVIDERS, listVisibleProviders } from '@/shared/providers';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';

const KV_SHOW_LEGACY = 'providers.showLegacy';

interface Row {
  id: string;
  name: string;
  description: string;
  installHint: string;
  comingSoon: boolean;
  legacy: boolean;
  probe?: ProviderProbe;
}

// v1.4.9-06 — consent-resettable providers (all 5 user-facing CLIs).
const CONSENT_PROVIDERS = listVisibleProviders(false).filter(
  (p) => p.installCommand !== undefined,
);

export function ProvidersTab() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLegacy, setShowLegacy] = useState(false);
  // v1.4.9-06 — consent reset section: track which providers have a stored consent.
  const [consentStates, setConsentStates] = useState<Record<string, 'declined' | null>>({});
  const [resetBusy, setResetBusy] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await rpc.providers.list();
      const probes = await rpc.providers.probeAll().catch(() => [] as ProviderProbe[]);
      const byId = new Map(probes.map((p) => [p.id, p]));
      // Cross-reference with the renderer-safe registry to pick up the
      // comingSoon / legacy flags. The RPC list omits them today (router-shape
      // is owned by another agent and stays frozen for this wave).
      const flagsById = new Map(
        AGENT_PROVIDERS.map((p) => [p.id, { comingSoon: !!p.comingSoon, legacy: !!p.legacy }]),
      );
      setRows(
        list.map((p) => {
          const flags = flagsById.get(p.id) ?? { comingSoon: false, legacy: false };
          return {
            id: p.id,
            name: p.name,
            description: p.description,
            installHint: p.installHint,
            comingSoon: flags.comingSoon,
            legacy: flags.legacy,
            probe: byId.get(p.id),
          };
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // v1.4.9-06 — fetch consent states for all installable providers.
  const refreshConsents = useCallback(async () => {
    const entries = await Promise.all(
      CONSENT_PROVIDERS.map(async (p) => {
        const val = await rpc.providers.getInstallConsent(p.id).catch(() => null);
        return [p.id, val] as const;
      }),
    );
    setConsentStates(Object.fromEntries(entries));
  }, []);

  const resetConsent = useCallback(async (providerId: string) => {
    setResetBusy((prev) => ({ ...prev, [providerId]: true }));
    try {
      // Resetting consent = deleting the kv key. The kv API only has set/get,
      // so we overwrite with a sentinel that `getInstallConsent` treats as null.
      // We use kv.set directly to write an empty string, which the consent handler
      // will treat as null (it only recognises 'declined').
      await rpc.kv.set(`provider.autoinstall.consent.${providerId}`, '');
      await refreshConsents();
    } catch {
      /* non-fatal */
    } finally {
      setResetBusy((prev) => ({ ...prev, [providerId]: false }));
    }
  }, [refreshConsents]);

  useEffect(() => {
    queueMicrotask(() => {
      void refresh();
      void refreshConsents();
      void rpc.kv
        .get(KV_SHOW_LEGACY)
        .then((v) => setShowLegacy(v === '1'))
        .catch(() => undefined);
    });
  }, [refresh, refreshConsents]);

  const onToggleLegacy = useCallback((next: boolean) => {
    setShowLegacy(next);
    void rpc.kv.set(KV_SHOW_LEGACY, next ? '1' : '0').catch(() => undefined);
  }, []);

  const visibleRows = useMemo(
    () => rows.filter((r) => (r.legacy ? showLegacy : true)),
    [rows, showLegacy],
  );
  const hasLegacyRows = useMemo(() => rows.some((r) => r.legacy), [rows]);
  const foundCount = visibleRows.filter((r) => r.probe?.found).length;

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <ErrorBanner
          message={error}
          onRetry={() => void refresh()}
          onDismiss={() => setError(null)}
        />
      ) : null}
      {/* V3-W14-009 — top-of-tab "Re-probe all" affordance. Re-runs the
          provider PATH probe so users can pick up newly-installed CLIs
          without restarting the app. Mirrors the smaller header button
          below (kept for backwards compat with existing screenshots). */}
      <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-card/40 p-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Re-probe all providers</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Re-runs PATH detection for every provider. Use after installing or
            removing a CLI without restarting SigmaLink.
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => void refresh()}
          disabled={busy}
          className="gap-1"
          aria-label="Re-probe all providers"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          Re-probe all
        </Button>
      </div>
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {visibleRows.length} provider{visibleRows.length === 1 ? '' : 's'} · {foundCount} found
        </div>
        <div className="flex items-center gap-3">
          {hasLegacyRows ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={showLegacy}
                onCheckedChange={onToggleLegacy}
                aria-label="Show legacy providers"
              />
              <span>Show legacy providers</span>
            </label>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            disabled={busy}
            className="gap-1"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
            Re-probe
          </Button>
        </div>
      </div>
      {/* v1.4.9-06 — consent-reset section */}
      <div className="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-3">
        <div className="text-sm font-medium">Install prompt consent</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Reset a provider's install-prompt consent to re-enable the "Not on PATH" modal.
        </div>
        <ul className="flex flex-col gap-1.5 mt-1">
          {CONSENT_PROVIDERS.map((p) => {
            const consent = consentStates[p.id];
            const isBusy = !!resetBusy[p.id];
            return (
              <li key={p.id} className="flex items-center gap-3">
                <span className="flex-1 text-sm">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  {consent === 'declined' ? 'Declined (modal suppressed)' : 'No preference set'}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isBusy || consent !== 'declined'}
                  onClick={() => void resetConsent(p.id)}
                  className="gap-1"
                >
                  {isBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3 w-3" />
                  )}
                  Reset
                </Button>
              </li>
            );
          })}
        </ul>
      </div>

      <ul className="flex flex-col gap-2">
        {visibleRows.map((r) => {
          const ok = !!r.probe?.found;
          // "Coming soon" rows are de-emphasised so they don't compete with
          // installed / installable providers for the user's attention.
          const dim = r.comingSoon ? 'opacity-60' : '';
          return (
            <li
              key={r.id}
              className={`flex items-start gap-3 rounded-md border border-border bg-card/40 px-3 py-2 ${dim}`}
            >
              <span
                className={
                  r.comingSoon
                    ? 'mt-[2px] grid h-5 w-5 place-items-center rounded-full bg-blue-500/20 text-blue-300'
                    : ok
                      ? 'mt-[2px] grid h-5 w-5 place-items-center rounded-full bg-emerald-500/20 text-emerald-300'
                      : 'mt-[2px] grid h-5 w-5 place-items-center rounded-full bg-muted text-muted-foreground'
                }
                aria-hidden
              >
                {r.comingSoon ? (
                  <Loader2 className="h-3 w-3" />
                ) : ok ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <X className="h-3 w-3" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{r.name}</span>
                  {r.comingSoon ? (
                    <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-300">
                      Coming soon
                    </span>
                  ) : null}
                  {r.legacy ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Legacy
                    </span>
                  ) : null}
                  {r.probe?.version ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      v{r.probe.version}
                    </span>
                  ) : null}
                  {r.probe?.resolvedPath ? (
                    <span
                      className="ml-auto truncate font-mono text-[10px] text-muted-foreground"
                      title={r.probe.resolvedPath}
                    >
                      {r.probe.resolvedPath}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">{r.description}</div>
                {!ok && !r.comingSoon ? (
                  <pre className="mt-2 overflow-x-auto rounded border border-border bg-muted/30 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    {r.installHint}
                  </pre>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
