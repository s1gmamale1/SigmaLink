// V1.1.1 — Settings → Voice tab.
//
// v1.4.9 adds a "Global capture" section at the top with:
//   - Enable toggle (default OFF on first launch — opt-in)
//   - Hotkey rebinder (default Cmd+Option+Space)
//   - Model picker with lazy-download progress bar + size disclosure
//   - Push-to-talk vs Toggle mode radio
//   - Output target priority
//   - "Use Apple Speech.framework instead" alternative on macOS
//
// Existing rows (SigmaVoice mode / mic permission / diagnostics) are
// preserved unchanged below the new section.
//
// All RPC calls swallow toast errors (`rpcSilent`) so the surface degrades
// quietly when the controller isn't booted (e.g. very early Settings open).

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Download, Keyboard, Mic, Radio, RefreshCw, Settings2, Terminal, BarChart2 } from 'lucide-react';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { IS_WIN32, getPlatform } from '@/renderer/lib/platform';
import { cn } from '@/lib/utils';
import type { DictionaryEntry } from '@/shared/voice-dictionary';
import type { SessionStat } from '@/main/core/voice/voice-stats';

// ---------------------------------------------------------------------------
// v1.4.9 — Global capture types
// ---------------------------------------------------------------------------

type CaptureState = 'idle' | 'recording' | 'transcribing' | 'routing';
type CaptureMode = 'toggle' | 'push-to-talk';

interface GlobalCaptureStatus {
  state: CaptureState;
  enabled: boolean;
  mode: CaptureMode;
  modelId: string;
  hotkey: string;
}

interface ModelEntry {
  id: string;
  name: string;
  sizeMb: number;
  isDefault: boolean;
}

const GLOBAL_CAPTURE_MODELS: ReadonlyArray<ModelEntry> = [
  { id: 'tiny.en-q5_1',   name: 'Tiny (31 MB)',   sizeMb: 31,  isDefault: false },
  { id: 'base.en-q5_1',   name: 'Base (57 MB)',    sizeMb: 57,  isDefault: true  },
  { id: 'small.en-q5_1',  name: 'Small (182 MB)',  sizeMb: 182, isDefault: false },
  { id: 'medium.en-q5_0', name: 'Medium (515 MB)', sizeMb: 515, isDefault: false },
];

const CAPTURE_MODE_OPTIONS: ReadonlyArray<{ value: CaptureMode; label: string; description: string }> = [
  {
    value: 'toggle',
    label: 'Toggle (recommended)',
    description: 'First press starts recording; second press stops. Fewer "let go too early" failures.',
  },
  {
    value: 'push-to-talk',
    label: 'Push-to-talk',
    description: 'Hold to record, release to transcribe. Best for quick one-liners.',
  },
];

const IS_MAC = getPlatform() === 'darwin';

/** Invoke a global-capture side-band channel. */
async function invokeGlobalCapture<T = unknown>(
  method: string,
  payload?: unknown,
): Promise<T> {
  if (!('sigma' in window)) throw new Error('Preload bridge missing');
  const ch = `voice.globalCapture.${method}`;
  const env = (await window.sigma.invoke(ch, payload)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!env || typeof env !== 'object' || !('ok' in env)) {
    throw new Error('Bad RPC response from ' + ch);
  }
  if (env.ok) return env.data;
  throw new Error(env.error);
}

// ---------------------------------------------------------------------------
// v1.4.9 — Global capture section component
// ---------------------------------------------------------------------------

// KV key for the C-10b focused-pane routing toggle
const KV_ROUTE_TO_FOCUSED_PANE = 'voice.routeToFocusedPane';
// C-11 — KV key for the "Hey Sigma" always-on listening mode toggle.
const KV_LISTENING_MODE = 'voice.listeningMode';

function GlobalCaptureSection() {
  const [status, setStatus] = useState<GlobalCaptureStatus | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [capturingHotkey, setCapturingHotkey] = useState(false);
  const [pressedKeys, setPressedKeys] = useState('');
  const [routeToFocusedPane, setRouteToFocusedPane] = useState(false);
  const [listeningMode, setListeningMode] = useState(false);
  const hotkeyInputRef = useRef<HTMLButtonElement>(null);

  // Load status on mount
  useEffect(() => {
    void (async () => {
      try {
        const s = await invokeGlobalCapture<GlobalCaptureStatus>('getStatus');
        if (s) setStatus(s);
      } catch {
        /* leave null — surface shows "macOS feature" note */
      }
      // C-10b — load the focused-pane routing toggle from KV
      try {
        const raw = await rpc.kv.get(KV_ROUTE_TO_FOCUSED_PANE);
        setRouteToFocusedPane(raw === '1');
      } catch { /* best-effort */ }
      // C-11 — load the "Hey Sigma" listening-mode toggle from KV
      try {
        const raw = await rpc.kv.get(KV_LISTENING_MODE);
        setListeningMode(raw === '1');
      } catch { /* best-effort */ }
    })();
  }, []);

  // Listen for state updates pushed by main process
  useEffect(() => {
    if (!('sigma' in window)) return;
    const unsub = window.sigma.eventOn('voice:global-capture-state', (s: unknown) => {
      if (s && typeof s === 'object' && 'enabled' in s) {
        setStatus(s as GlobalCaptureStatus);
      }
    });
    // Listen for download progress toasts
    const unsubToast = window.sigma.eventOn('voice:global-capture-toast', (msg: unknown) => {
      const t = msg as { downloadProgress?: { fraction: number; done: boolean; modelId: string }; message?: string };
      if (t?.downloadProgress) {
        const { fraction, done, modelId } = t.downloadProgress;
        setDownloadPercent(Math.round(fraction * 100));
        if (done) {
          setDownloadingId(null);
          setDownloadPercent(0);
        } else {
          setDownloadingId(modelId);
        }
      }
    });
    return () => { unsub?.(); unsubToast?.(); };
  }, []);

  const onToggleEnabled = useCallback(async () => {
    if (!status) return;
    try {
      await invokeGlobalCapture('setEnabled', { value: !status.enabled });
    } catch { /* silent */ }
  }, [status]);

  const onSetMode = useCallback(async (m: CaptureMode) => {
    try {
      await invokeGlobalCapture('setMode', { mode: m });
    } catch { /* silent */ }
  }, []);

  const onSetModel = useCallback(async (id: string) => {
    try {
      await invokeGlobalCapture('setModelId', { modelId: id });
    } catch { /* silent */ }
  }, []);

  const onDownloadModel = useCallback(async (id: string) => {
    setDownloadingId(id);
    setDownloadPercent(0);
    try {
      await invokeGlobalCapture('downloadModel', { modelId: id });
    } catch {
      setDownloadingId(null);
      setDownloadPercent(0);
    }
  }, []);

  const onToggleRouteToFocusedPane = useCallback(async () => {
    const next = !routeToFocusedPane;
    setRouteToFocusedPane(next);
    try {
      await rpc.kv.set(KV_ROUTE_TO_FOCUSED_PANE, next ? '1' : '0');
    } catch { /* best-effort */ }
  }, [routeToFocusedPane]);

  // C-11 — toggle "Hey Sigma" listening mode. Persist + arm/disarm via the
  // side-band IPC so the main process opens/closes the mic + wake loop.
  const onToggleListeningMode = useCallback(async () => {
    const next = !listeningMode;
    setListeningMode(next);
    try {
      await invokeGlobalCapture('setListeningMode', { value: next });
    } catch {
      // Revert optimistic state if the controller rejected the change.
      setListeningMode(!next);
    }
  }, [listeningMode]);

  const onStartHotkeyCapture = useCallback(() => {
    setCapturingHotkey(true);
    setPressedKeys('');
    hotkeyInputRef.current?.focus();
  }, []);

  const onHotkeyKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!capturingHotkey) return;
      e.preventDefault();
      e.stopPropagation();

      const mods: string[] = [];
      if (e.metaKey) mods.push('Command');
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');

      // Ignore modifier-only presses; wait for a non-modifier key
      const nonModKeys = ['Meta', 'Control', 'Alt', 'Shift', 'OS'];
      if (nonModKeys.includes(e.key)) {
        setPressedKeys(mods.join('+') + '+…');
        return;
      }

      // Must have at least one modifier
      if (mods.length === 0) {
        setCapturingHotkey(false);
        return;
      }

      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const chord = [...mods, key].join('+');
      // Map to Electron accelerator syntax
      const electronChord = chord
        .replace('Command', 'CommandOrControl')
        .replace('Control', 'CommandOrControl');

      setCapturingHotkey(false);
      setPressedKeys('');

      try {
        await invokeGlobalCapture('setHotkey', { hotkey: electronChord });
      } catch { /* silent */ }
    },
    [capturingHotkey],
  );

  if (!IS_MAC) {
    return (
      <section data-testid="voice-global-capture-section">
        <div className="mb-2 flex items-center gap-2">
          <Mic className="h-4 w-4 text-muted-foreground" aria-hidden />
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Global capture
          </div>
        </div>
        <div className="rounded-md border border-border bg-card/30 px-3 py-2 text-[11px] text-muted-foreground">
          Global voice capture is available on macOS in v1.4.9.
          Windows + Linux support is planned for v1.5.0.
        </div>
      </section>
    );
  }

  return (
    <section data-testid="voice-global-capture-section">
      <div className="mb-2 flex items-center gap-2">
        <Mic className="h-4 w-4 text-muted-foreground" aria-hidden />
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Global capture
        </div>
        {status?.state === 'recording' && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-red-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
            Recording
          </span>
        )}
        {(status?.state === 'transcribing' || status?.state === 'routing') && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-yellow-400">
            <span className="h-2 w-2 animate-spin rounded-full border border-yellow-500 border-t-transparent" />
            Transcribing
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {/* Enable toggle */}
        <div className="flex items-center justify-between rounded-md border border-border bg-card/40 px-3 py-2">
          <div>
            <div className="text-sm font-medium">Enable global capture</div>
            <div className="text-[11px] text-muted-foreground">
              Press <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                {status?.hotkey ?? 'Cmd+Option+Space'}
              </kbd> anywhere to record. Requires Whisper model (or Apple Speech as fallback).
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={status?.enabled ?? false}
            onClick={() => void onToggleEnabled()}
            data-testid="voice-global-capture-toggle"
            className={cn(
              'relative ml-4 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
              (status?.enabled ?? false) ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                (status?.enabled ?? false) ? 'translate-x-4' : 'translate-x-0',
              )}
            />
          </button>
        </div>

        {/* Hotkey rebinder */}
        <div className="rounded-md border border-border bg-card/40 px-3 py-2">
          <div className="mb-1.5 flex items-center gap-2">
            <Keyboard className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <span className="text-xs font-medium">Hotkey</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              ref={hotkeyInputRef}
              type="button"
              onKeyDown={onHotkeyKeyDown}
              onBlur={() => { setCapturingHotkey(false); setPressedKeys(''); }}
              onClick={onStartHotkeyCapture}
              data-testid="voice-global-capture-hotkey-btn"
              className={cn(
                'rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs transition',
                capturingHotkey
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'hover:bg-card',
              )}
            >
              {capturingHotkey
                ? (pressedKeys || 'Press a key combination…')
                : (status?.hotkey ?? 'Cmd+Option+Space')}
            </button>
            {capturingHotkey && (
              <span className="text-[10px] text-muted-foreground">
                Press modifier + key. Esc to cancel.
              </span>
            )}
          </div>
        </div>

        {/* Mode radio */}
        <div className="rounded-md border border-border bg-card/40 px-3 py-2">
          <div className="mb-1.5 flex items-center gap-2">
            <Radio className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <span className="text-xs font-medium">Recording mode</span>
          </div>
          <div role="radiogroup" aria-label="Recording mode" className="flex flex-col gap-1.5">
            {CAPTURE_MODE_OPTIONS.map((opt) => {
              const selected = (status?.mode ?? 'toggle') === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => void onSetMode(opt.value)}
                  data-testid={`voice-capture-mode-${opt.value}`}
                  className={cn(
                    'flex items-start gap-2 rounded border px-2 py-1.5 text-left text-xs transition',
                    selected ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-card',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full border',
                      selected ? 'border-primary' : 'border-muted-foreground/40',
                    )}
                    aria-hidden
                  >
                    {selected ? <span className="h-1.5 w-1.5 rounded-full bg-primary" /> : null}
                  </span>
                  <span>
                    <span className="block font-medium">{opt.label}</span>
                    <span className="block text-[10px] text-muted-foreground">{opt.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Model picker + download */}
        <div className="rounded-md border border-border bg-card/40 px-3 py-2">
          <div className="mb-1.5 flex items-center gap-2">
            <Settings2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <span className="text-xs font-medium">Whisper model</span>
            <span className="ml-auto text-[10px] text-muted-foreground">Offline transcription</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {GLOBAL_CAPTURE_MODELS.map((m) => {
              const isSelected = (status?.modelId ?? 'base.en-q5_1') === m.id;
              const isDownloading = downloadingId === m.id;
              return (
                <div
                  key={m.id}
                  className={cn(
                    'flex items-center gap-2 rounded border px-2 py-1.5 text-xs transition',
                    isSelected ? 'border-primary bg-primary/10' : 'border-border bg-background',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void onSetModel(m.id)}
                    data-testid={`voice-model-${m.id}`}
                    className="flex flex-1 items-center gap-2 text-left"
                    aria-pressed={isSelected}
                  >
                    <span
                      className={cn(
                        'inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full border',
                        isSelected ? 'border-primary' : 'border-muted-foreground/40',
                      )}
                      aria-hidden
                    >
                      {isSelected ? <span className="h-1.5 w-1.5 rounded-full bg-primary" /> : null}
                    </span>
                    <span className="font-medium">{m.name}</span>
                    {m.isDefault && (
                      <span className="rounded bg-primary/20 px-1 py-0.5 text-[9px] text-primary">
                        default
                      </span>
                    )}
                  </button>
                  {isDownloading ? (
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${downloadPercent}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground">{downloadPercent}%</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onDownloadModel(m.id)}
                      data-testid={`voice-model-download-${m.id}`}
                      className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[10px] hover:bg-card"
                      title={`Download ${m.name} (${m.sizeMb} MB)`}
                    >
                      <Download className="h-2.5 w-2.5" aria-hidden />
                      {m.sizeMb} MB
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {IS_MAC && (
            <div className="mt-2 text-[10px] text-muted-foreground">
              Tip: If Whisper is not downloaded, global capture falls back to Apple Speech.framework
              automatically on macOS.
            </div>
          )}
        </div>

        {/* C-10b — Dictate into the focused pane toggle */}
        <div className="flex items-center justify-between rounded-md border border-border bg-card/40 px-3 py-2">
          <div>
            <div className="text-sm font-medium">Dictate into the focused pane</div>
            <div className="text-[11px] text-muted-foreground">
              When on, the transcript is written directly into the active PTY pane instead of routing to the Sigma assistant.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={routeToFocusedPane}
            onClick={() => void onToggleRouteToFocusedPane()}
            data-testid="voice-route-to-focused-pane-toggle"
            className={cn(
              'relative ml-4 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
              routeToFocusedPane ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                routeToFocusedPane ? 'translate-x-4' : 'translate-x-0',
              )}
            />
          </button>
        </div>

        {/* C-11 — "Hey Sigma" always-on wake-word listening toggle */}
        <div className="flex items-center justify-between rounded-md border border-border bg-card/40 px-3 py-2">
          <div>
            <div className="text-sm font-medium">Hey Sigma wake word</div>
            <div className="text-[11px] text-muted-foreground">
              Listens continuously and dispatches when you say{' '}
              <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">Hey Sigma</kbd>.
              Uses the Tiny model for low-power detection (download it above). An energy gate keeps
              idle CPU low. macOS only.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={listeningMode}
            onClick={() => void onToggleListeningMode()}
            data-testid="voice-listening-mode-toggle"
            className={cn(
              'relative ml-4 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
              listeningMode ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                listeningMode ? 'translate-x-4' : 'translate-x-0',
              )}
            />
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
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
 * the helper in `JorvisRoom.tsx` — the typed `rpc` proxy only knows about
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

// ---------------------------------------------------------------------------
// C-10a — Dictionary editor section
// ---------------------------------------------------------------------------

function DictionarySection() {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [newReplacement, setNewReplacement] = useState('');
  const [newType, setNewType] = useState<'phrase' | 'macro'>('phrase');

  useEffect(() => {
    void (async () => {
      try {
        const raw = await rpc.kv.get('voice.dictionary');
        if (raw) {
          const parsed = JSON.parse(raw) as DictionaryEntry[];
          if (Array.isArray(parsed)) setEntries(parsed);
        }
      } catch { /* best-effort */ }
    })();
  }, []);

  const persist = useCallback(async (next: DictionaryEntry[]) => {
    setEntries(next);
    try {
      await rpc.kv.set('voice.dictionary', JSON.stringify(next));
    } catch { /* best-effort */ }
  }, []);

  const onAdd = useCallback(async () => {
    const pattern = newPattern.trim();
    const replacement = newReplacement;
    if (!pattern) return;
    const entry: DictionaryEntry = { pattern, replacement, type: newType };
    await persist([...entries.filter((e) => e.type === 'phrase' || e.type === 'macro'), entry]);
    setNewPattern('');
    setNewReplacement('');
  }, [entries, newPattern, newReplacement, newType, persist]);

  const onRemove = useCallback(async (idx: number) => {
    const next = entries.filter((_, i) => i !== idx);
    await persist(next);
  }, [entries, persist]);

  const phrases = entries.filter((e) => e.type === 'phrase');

  return (
    <section data-testid="voice-dictionary-section">
      <div className="mb-2 flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-muted-foreground" aria-hidden />
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Voice dictionary
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {phrases.length === 0 ? (
          <div className="rounded-md border border-border bg-card/30 px-3 py-2 text-[11px] text-muted-foreground">
            No phrase substitutions yet. Add one below.
          </div>
        ) : (
          phrases.map((entry, i) => {
            const globalIdx = entries.indexOf(entry);
            return (
              <div
                key={i}
                className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-1.5 text-xs"
              >
                <span className="flex-1 font-mono">{entry.pattern}</span>
                <span className="text-muted-foreground">→</span>
                <span className="flex-1 font-mono">{entry.replacement}</span>
                <button
                  type="button"
                  onClick={() => void onRemove(globalIdx)}
                  className="ml-2 rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                >
                  Remove
                </button>
              </div>
            );
          })
        )}
        {/* Add entry row */}
        <div className="flex items-center gap-2 pt-1">
          <input
            type="text"
            placeholder="Spoken phrase"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            data-testid="voice-dict-pattern-input"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="text"
            placeholder="Replacement"
            value={newReplacement}
            onChange={(e) => setNewReplacement(e.target.value)}
            data-testid="voice-dict-replacement-input"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as 'phrase' | 'macro')}
            data-testid="voice-dict-type-select"
            className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="phrase">Phrase</option>
            <option value="macro">Macro</option>
          </select>
          <button
            type="button"
            onClick={() => void onAdd()}
            data-testid="voice-dict-add-btn"
            disabled={!newPattern.trim()}
            className={cn(
              'rounded-md border border-border bg-background px-3 py-1 text-xs transition hover:bg-card',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            Add
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// C-10a — Macro list section
// ---------------------------------------------------------------------------

function MacrosSection() {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [newReplacement, setNewReplacement] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const raw = await rpc.kv.get('voice.dictionary');
        if (raw) {
          const parsed = JSON.parse(raw) as DictionaryEntry[];
          if (Array.isArray(parsed)) setEntries(parsed);
        }
      } catch { /* best-effort */ }
    })();
  }, []);

  const persist = useCallback(async (allEntries: DictionaryEntry[]) => {
    setEntries(allEntries);
    try {
      await rpc.kv.set('voice.dictionary', JSON.stringify(allEntries));
    } catch { /* best-effort */ }
  }, []);

  const onAdd = useCallback(async () => {
    const pattern = newPattern.trim();
    if (!pattern) return;
    const entry: DictionaryEntry = { pattern, replacement: newReplacement, type: 'macro' };
    await persist([...entries, entry]);
    setNewPattern('');
    setNewReplacement('');
  }, [entries, newPattern, newReplacement, persist]);

  const onRemove = useCallback(async (idx: number) => {
    await persist(entries.filter((_, i) => i !== idx));
  }, [entries, persist]);

  const macros = entries.filter((e) => e.type === 'macro');

  return (
    <section data-testid="voice-macros-section">
      <div className="mb-2 flex items-center gap-2">
        <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden />
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Voice macros
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {macros.length === 0 ? (
          <div className="rounded-md border border-border bg-card/30 px-3 py-2 text-[11px] text-muted-foreground">
            No macros yet. Add a verbal command below.
          </div>
        ) : (
          macros.map((entry, i) => {
            const globalIdx = entries.indexOf(entry);
            return (
              <div
                key={i}
                className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-1.5 text-xs"
              >
                <span className="flex-1 font-mono">{entry.pattern}</span>
                <span className="text-muted-foreground">→</span>
                <span className="flex-1 font-mono text-[10px] text-muted-foreground">
                  {JSON.stringify(entry.replacement)}
                </span>
                <button
                  type="button"
                  onClick={() => void onRemove(globalIdx)}
                  className="ml-2 rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                >
                  Remove
                </button>
              </div>
            );
          })
        )}
        <div className="flex items-center gap-2 pt-1">
          <input
            type="text"
            placeholder="Spoken command"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            data-testid="voice-macro-pattern-input"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="text"
            placeholder='Expansion (e.g. "\n")'
            value={newReplacement}
            onChange={(e) => setNewReplacement(e.target.value)}
            data-testid="voice-macro-replacement-input"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={() => void onAdd()}
            data-testid="voice-macro-add-btn"
            disabled={!newPattern.trim()}
            className={cn(
              'rounded-md border border-border bg-background px-3 py-1 text-xs transition hover:bg-card',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            Add
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// C-10a — Usage dashboard section
// ---------------------------------------------------------------------------

function UsageSection() {
  const [stats, setStats] = useState<SessionStat[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const raw = await rpc.kv.get('voice.stats');
        if (raw) {
          const parsed = JSON.parse(raw) as SessionStat[];
          if (Array.isArray(parsed)) setStats(parsed);
        }
      } catch { /* best-effort */ }
    })();
  }, []);

  const totalWords = stats.reduce((sum, s) => sum + (s.words ?? 0), 0);
  const avgWpm =
    stats.length > 0
      ? Math.round(stats.reduce((sum, s) => sum + (s.wpm ?? 0), 0) / stats.length)
      : 0;
  const recent = stats.slice(-5).reverse();

  return (
    <section data-testid="voice-usage-section">
      <div className="mb-2 flex items-center gap-2">
        <BarChart2 className="h-4 w-4 text-muted-foreground" aria-hidden />
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Usage
        </div>
      </div>
      {stats.length === 0 ? (
        <div className="rounded-md border border-border bg-card/30 px-3 py-2 text-[11px] text-muted-foreground">
          No sessions recorded yet. Use global capture to start tracking usage.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex gap-4 rounded-md border border-border bg-card/40 px-3 py-2 text-xs">
            <div>
              <span className="font-medium">{totalWords.toLocaleString()}</span>
              <span className="ml-1 text-muted-foreground">total words</span>
            </div>
            <div>
              <span className="font-medium">{avgWpm}</span>
              <span className="ml-1 text-muted-foreground">avg WPM</span>
            </div>
            <div>
              <span className="font-medium">{stats.length}</span>
              <span className="ml-1 text-muted-foreground">sessions</span>
            </div>
          </div>
          {recent.length > 0 && (
            <div className="rounded-md border border-border bg-card/30 px-3 py-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Recent sessions
              </div>
              <div className="flex flex-col gap-1">
                {recent.map((s, i) => (
                  <div key={i} className="flex gap-3 text-[11px]">
                    <span className="w-16 text-right font-mono">{s.words}w</span>
                    <span className="text-muted-foreground">{Math.round(s.wpm)} WPM</span>
                    <span className="text-muted-foreground">
                      {(s.durationMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
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
      {/* v1.4.9 — Global capture section */}
      <GlobalCaptureSection />

      {/* C-10a — Dictionary, macros, usage */}
      <DictionarySection />
      <MacrosSection />
      <UsageSection />

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
