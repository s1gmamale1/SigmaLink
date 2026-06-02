// P3 SND-1 — soundscape controls (sibling of NotificationsSettings).
//
// Master sound switch + global volume + a per-cue mute matrix grouped by
// category ("alert" cues play even when you are away; "ui" cues are ambient
// feedback). Each cue row has a "Test" button that force-previews the cue.
// Reads/writes go through the engine in `@/renderer/lib/sounds` (which owns the
// KV keys, legacy-key back-compat, and the cache invalidation).

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  getSoundMasterEnabled,
  setSoundMasterEnabled,
  getSoundVolume,
  setSoundVolume,
  getMutedCues,
  setCueMuted,
  previewCue,
} from '@/renderer/lib/sounds';
import { SOUND_CATALOG, type SoundCue } from '@/shared/notification-prefs';

const CATEGORY_LABELS: ReadonlyArray<{ id: 'alert' | 'ui'; label: string; hint: string }> = [
  { id: 'alert', label: 'Alerts', hint: 'Functional — play even when the window is in the background.' },
  { id: 'ui', label: 'Interface', hint: 'Ambient feedback — silenced when minimized or under Reduce Motion.' },
];

export function NotificationsSoundSettings() {
  const [master, setMaster] = useState<boolean>(true);
  const [volume, setVolume] = useState<number>(0.6);
  const [muted, setMuted] = useState<Set<SoundCue>>(new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [m, v, mc] = await Promise.all([
          getSoundMasterEnabled(),
          getSoundVolume(),
          getMutedCues(),
        ]);
        if (!alive) return;
        setMaster(m);
        setVolume(v);
        setMuted(mc);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const persistMaster = async (next: boolean) => {
    setMaster(next);
    await setSoundMasterEnabled(next);
  };

  const persistVolume = async (next: number) => {
    setVolume(next);
    await setSoundVolume(next);
  };

  const toggleCue = async (cue: SoundCue, nextEnabled: boolean) => {
    setMuted((prev) => {
      const copy = new Set(prev);
      if (nextEnabled) copy.delete(cue);
      else copy.add(cue);
      return copy;
    });
    await setCueMuted(cue, !nextEnabled);
  };

  if (!ready) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="notifications-sound-loading">
        Loading sound settings…
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-3" data-testid="notifications-sound" aria-label="Sound">
      <h4 className="text-sm font-semibold tracking-tight">Sound</h4>

      <label className="flex items-center gap-2 text-sm" data-testid="notifications-sound-master-row">
        <input
          type="checkbox"
          checked={master}
          onChange={(e) => void persistMaster(e.target.checked)}
          data-testid="notifications-sound-master"
          className="accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span>Play sound effects</span>
      </label>

      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-disabled={!master}>
        <span className="w-12 shrink-0">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(volume * 100)}
          disabled={!master}
          onChange={(e) => void persistVolume(Number(e.target.value) / 100)}
          data-testid="notifications-sound-volume"
          aria-label="Sound volume"
          className="h-1 flex-1 cursor-pointer accent-primary disabled:opacity-50"
        />
        <span className="w-8 shrink-0 text-right tabular-nums">{Math.round(volume * 100)}%</span>
      </div>

      <fieldset
        className="flex flex-col gap-3"
        disabled={!master}
        aria-disabled={!master}
        data-testid="notifications-sound-matrix"
      >
        {CATEGORY_LABELS.map(({ id, label, hint }) => {
          const cues = SOUND_CATALOG.filter((c) => c.category === id);
          if (cues.length === 0) return null;
          return (
            <div key={id} className="flex flex-col gap-1">
              <legend className="px-1 text-xs font-medium text-muted-foreground">{label}</legend>
              <p className="px-1 text-[11px] text-muted-foreground/80">{hint}</p>
              {cues.map((def) => {
                const isEnabled = !muted.has(def.cue);
                return (
                  <div key={def.cue} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={(e) => void toggleCue(def.cue, e.target.checked)}
                      data-testid={`notifications-sound-cue-${def.cue}`}
                      className="accent-primary"
                    />
                    <span className="flex-1">{def.label}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void previewCue(def.cue)}
                      data-testid={`notifications-sound-test-${def.cue}`}
                      aria-label={`Test ${def.label} sound`}
                    >
                      Test
                    </Button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </fieldset>
    </section>
  );
}
