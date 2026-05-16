// V1.1.1 — Settings → Voice tab.
//
// Shipped after support reports of "voice not enabled or something". Three
// rows let users (and support) verify exactly which stage of the SigmaVoice
// pipeline is healthy:
//
//   1. Routing mode — radio (off / auto / on). Persists to `kv['voice.mode']`
//      via the typed `voice.setMode` channel so the bootstrap reload picks it
//      up next launch.
//   2. Microphone permission — text status row + Re-prompt button. Calls
//      `voice.permissionRequest` which tunnels into the native
//      `requestPermission()` on darwin and resolves with `unsupported`
//      everywhere else.
//   3. Test voice pipeline — runs the four-stage diagnostics probe via the
//      side-band `voice.diagnostics.run` channel and renders four traffic-
//      light dots (native / permission / dispatcher / lastError) with hover
//      tooltips so support can copy the failure text directly.
//
// All RPC calls swallow toast errors (`rpcSilent`) so the surface degrades
// quietly when the controller isn't booted (e.g. very early Settings open).

import { useCallback, useEffect, useState } from 'react';
import { Mic, RefreshCw } from 'lucide-react';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { IS_WIN32, getPlatform } from '@/renderer/lib/platform';
import { cn } from '@/lib/utils';

// v1.2.0 Windows port — the "native macOS engine" only exists on darwin.
// On every other platform the auto/on radio still works but quietly falls
// back to Web Speech. We surface that fact in the radio copy and in the
// diagnostics row so a Windows / Linux user does not see a red error on a
// platform where the native module is, by design, unavailable.
const NATIVE_ENGINE_LABEL: string = (() => {
  if (IS_WIN32) return 'Web Speech API (Chromium, requires internet)';
  if (getPlatform() === 'linux') return 'Web Speech API (Chromium, requires internet)';
  return 'macOS native engine';
})();

// True when the native engine is buildable on this platform. Today that's
// darwin only — the napi-rs prebuild ships in the macOS DMG and is absent
// from the win/linux artifacts. Gates the red error on the diagnostics dot
// so non-darwin users see "unavailable on this platform" instead.
const NATIVE_ENGINE_AVAILABLE = getPlatform() === 'darwin';

type DiagnosticsMode = 'off' | 'auto' | 'on';
type PermissionStatus = 'granted' | 'denied' | 'undetermined' | 'unsupported';

interface DiagnosticsResult {
  nativeLoaded: boolean;
  permissionStatus: PermissionStatus;
  dispatcherReachable: boolean;
  mode: DiagnosticsMode;
  lastError: string | null;
}

const KV_VOICE_MODE = 'voice.mode';

const MODE_OPTIONS: ReadonlyArray<{
  value: 'off' | 'auto' | 'on';
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Off',
    description: 'Disable SigmaVoice. The mic affordance stays hidden.',
  },
  {
    value: 'auto',
    label: 'Auto (recommended)',
    description: NATIVE_ENGINE_AVAILABLE
      ? 'Use the macOS native engine when available; fall back to Web Speech.'
      : `Use ${NATIVE_ENGINE_LABEL} (native engine unavailable on this platform).`,
  },
  {
    value: 'on',
    label: 'On',
    description: NATIVE_ENGINE_AVAILABLE
      ? 'Force the on-device native engine on macOS.'
      : `Force ${NATIVE_ENGINE_LABEL}.`,
  },
];

const PERMISSION_LABEL: Record<PermissionStatus, string> = {
  granted: 'Granted',
  denied: 'Denied — open System Settings → Privacy → Microphone',
  undetermined: 'Not requested yet',
  unsupported: 'Unsupported on this platform',
};

/** Map the simplified UI mode value to the wire enum the controller uses. */
function uiModeToWire(value: 'off' | 'auto' | 'on'): 'auto' | 'web-speech' | 'native-mac' | 'off' {
  if (value === 'off') return 'off';
  if (value === 'on') return 'native-mac';
  return 'auto';
}

/** Inverse mapping for restoring radio state from kv. */
function wireModeToUi(value: string | null): 'off' | 'auto' | 'on' {
  if (value === 'off') return 'off';
  if (value === 'native-mac' || value === 'on' || value === 'web-speech') return 'on';
  return 'auto';
}

interface DiagnosticsDotProps {
  ok: boolean;
  label: string;
  detail: string;
}

function DiagnosticsDot({ ok, label, detail }: DiagnosticsDotProps) {
  return (
    <div
      data-testid={`voice-diagnostics-dot-${label.toLowerCase().replace(/\s+/g, '-')}`}
      data-status={ok ? 'ok' : 'fail'}
      className="flex flex-col items-center gap-1"
      title={detail}
    >
      <span
        className={cn(
          'inline-flex h-3 w-3 rounded-full ring-2 ring-offset-1 ring-offset-background',
          ok ? 'bg-emerald-500 ring-emerald-500/30' : 'bg-red-500 ring-red-500/30',
        )}
        aria-label={`${label}: ${ok ? 'ok' : 'failed'}`}
      />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * Side-band invoker for the `voice.diagnostics.<method>` namespace. Mirrors
 * the helper in `SigmaRoom.tsx` — the typed `rpc` proxy only knows about
 * flat namespaces, so 3-segment side-band channels need to call
 * `window.sigma.invoke` directly with the full channel id.
 */
async function invokeVoiceDiagnostics(): Promise<DiagnosticsResult> {
  if (!('sigma' in window)) {
    throw new Error('Preload bridge missing — restart the app.');
  }
  const env = (await window.sigma.invoke('voice.diagnostics.run')) as
    | { ok: true; data: DiagnosticsResult }
    | { ok: false; error: string };
  if (!env || typeof env !== 'object' || !('ok' in env)) {
    throw new Error('Bad RPC response from voice.diagnostics.run');
  }
  if (env.ok) return env.data;
  throw new Error(env.error);
}

export function VoiceTab() {
  const [mode, setMode] = useState<'off' | 'auto' | 'on'>('auto');
  const [permission, setPermission] = useState<PermissionStatus>('undetermined');
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(null);
  const [running, setRunning] = useState(false);
  const [requesting, setRequesting] = useState(false);

  // Hydrate the radio from persisted kv on mount; also kick off a one-shot
  // diagnostics probe so the permission row reflects reality without the user
  // having to click "Test voice pipeline" first.
  useEffect(() => {
    void (async () => {
      const stored = await rpcSilent.kv.get(KV_VOICE_MODE).catch(() => null);
      setMode(wireModeToUi(stored));
      try {
        const out = await invokeVoiceDiagnostics();
        setDiagnostics(out);
        setPermission(out.permissionStatus);
      } catch {
        /* leave defaults — Test button can retry */
      }
    })();
  }, []);

  const onChangeMode = useCallback(async (next: 'off' | 'auto' | 'on') => {
    setMode(next);
    try {
      await rpc.voice.setMode({ mode: uiModeToWire(next) });
    } catch {
      /* silent — toast handled by rpc client */
    }
  }, []);

  const onReprompt = useCallback(async () => {
    setRequesting(true);
    try {
      const res = await rpc.voice.permissionRequest();
      setPermission(res.status);
    } catch {
      setPermission('undetermined');
    } finally {
      setRequesting(false);
    }
  }, []);

  const onRunDiagnostics = useCallback(async () => {
    setRunning(true);
    try {
      const out = await invokeVoiceDiagnostics();
      setDiagnostics(out);
      setPermission(out.permissionStatus);
    } catch {
      /* error envelope already toasted by invokeVoiceDiagnostics caller */
    } finally {
      setRunning(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-6" data-testid="voice-settings-tab">
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Mic className="h-4 w-4 text-muted-foreground" aria-hidden />
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            SigmaVoice mode
          </div>
        </div>
        <div role="radiogroup" aria-label="SigmaVoice mode" className="flex flex-col gap-2">
          {MODE_OPTIONS.map((opt) => {
            const selected = mode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => void onChangeMode(opt.value)}
                className={cn(
                  'flex items-start gap-3 rounded-md border px-3 py-2 text-left transition',
                  selected
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card/40 hover:bg-card',
                )}
                data-testid={`voice-mode-${opt.value}`}
              >
                <span
                  className={cn(
                    'mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-primary' : 'border-muted-foreground/40',
                  )}
                  aria-hidden
                >
                  {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{opt.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{opt.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Microphone permission
        </div>
        <div className="flex items-center justify-between rounded-md border border-border bg-card/40 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium" data-testid="voice-permission-status">
              {PERMISSION_LABEL[permission]}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {NATIVE_ENGINE_AVAILABLE
                ? 'macOS prompts once; deny → re-grant in System Settings.'
                : 'Permission is requested by the browser engine when you first speak.'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onReprompt()}
            disabled={requesting || permission === 'unsupported'}
            className={cn(
              'shrink-0 rounded-md border border-border bg-background px-3 py-1.5 text-xs transition hover:bg-card',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
            data-testid="voice-permission-reprompt"
          >
            {requesting ? 'Requesting…' : 'Re-prompt'}
          </button>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Test voice pipeline
          </div>
          <button
            type="button"
            onClick={() => void onRunDiagnostics()}
            disabled={running}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs transition hover:bg-card',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
            data-testid="voice-diagnostics-run"
          >
            <RefreshCw className={cn('h-3 w-3', running && 'animate-spin')} aria-hidden />
            {running ? 'Probing…' : 'Run diagnostics'}
          </button>
        </div>
        <div className="rounded-md border border-border bg-card/30 p-3">
          {diagnostics ? (
            <>
              <div className="flex items-center gap-6 px-2 py-2" data-testid="voice-diagnostics-dots">
                {NATIVE_ENGINE_AVAILABLE ? (
                  <DiagnosticsDot
                    ok={diagnostics.nativeLoaded}
                    label="Native"
                    detail={
                      diagnostics.nativeLoaded
                        ? 'Native macOS module loaded.'
                        : 'Native module unavailable (prebuild missing).'
                    }
                  />
                ) : (
                  <div
                    data-testid="voice-diagnostics-dot-native-unavailable"
                    data-status="neutral"
                    className="flex flex-col items-center gap-1"
                    title="Native engine: unavailable on this platform"
                  >
                    <span
                      className="inline-flex h-3 w-3 rounded-full bg-muted-foreground/40 ring-2 ring-offset-1 ring-offset-background ring-muted-foreground/10"
                      aria-label="Native engine: unavailable on this platform"
                    />
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Native: unavailable
                    </span>
                  </div>
                )}
                <DiagnosticsDot
                  ok={diagnostics.permissionStatus === 'granted'}
                  label="Permission"
                  detail={PERMISSION_LABEL[diagnostics.permissionStatus]}
                />
                <DiagnosticsDot
                  ok={diagnostics.dispatcherReachable}
                  label="Dispatcher"
                  detail={
                    diagnostics.dispatcherReachable
                      ? 'Intent classifier import + smoke succeeded.'
                      : 'Dispatcher import or classify smoke failed.'
                  }
                />
                <DiagnosticsDot
                  ok={diagnostics.lastError === null}
                  label="Last error"
                  detail={diagnostics.lastError ?? 'No errors.'}
                />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 px-2 text-[11px] text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">Mode</span>: {diagnostics.mode}
                </div>
                <div>
                  <span className="font-medium text-foreground">Permission</span>: {diagnostics.permissionStatus}
                </div>
                {diagnostics.lastError ? (
                  <div className="col-span-2 break-words text-red-400">
                    <span className="font-medium">Last error:</span> {diagnostics.lastError}
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">
              Click <span className="font-medium">Run diagnostics</span> to probe the pipeline.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
