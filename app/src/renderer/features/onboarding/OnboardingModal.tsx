// First-run onboarding flow. Three steps:
//   1. Welcome / what SigmaLink is.
//   2. Detect installed agent CLIs (re-uses providers.probeAll).
//   3. Pick a workspace folder.
//
// The modal is fully skippable; on completion (or skip) it sets
// `kv['app.onboarded'] = '1'` so it never reopens for this user.

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Folder, FolderPlus, Sparkles, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { Monogram } from '@/renderer/components/Monogram';
import type { ProviderProbe } from '@/shared/types';

interface ProviderInfo {
  id: string;
  name: string;
  installHint: string;
  probe?: ProviderProbe;
}

const KV_KEY = 'app.onboarded';

export function OnboardingModal() {
  const { state, dispatch } = useAppState();
  const open = state.uiBoot && !state.onboarded;
  const [step, setStep] = useState(0);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [probing, setProbing] = useState(false);
  const [pickedFolder, setPickedFolder] = useState<{ path: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset stepper whenever the modal opens.
  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  // Load providers + probe results when entering step 2 the first time.
  useEffect(() => {
    if (!open || step !== 1 || providers.length > 0 || probing) return;
    let alive = true;
    setProbing(true);
    void (async () => {
      try {
        const list = await rpc.providers.list();
        const probes = await rpc.providers
          .probeAll()
          .catch(() => [] as ProviderProbe[]);
        if (!alive) return;
        const byId = new Map(probes.map((p) => [p.id, p]));
        setProviders(
          list.map((p) => ({
            id: p.id,
            name: p.name,
            installHint: p.installHint,
            probe: byId.get(p.id),
          })),
        );
      } catch (err) {
        console.error('probe failed:', err);
      } finally {
        if (alive) setProbing(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, step, providers.length, probing]);

  const found = useMemo(() => providers.filter((p) => p.probe?.found).length, [providers]);

  async function complete(): Promise<void> {
    // BUG-W7-012: Skip used to await the kv.set round-trip before closing
    // the modal, which dropped the click if it landed during the Radix
    // open/close transition (the modal was technically not yet `data-state="open"`
    // and pointer events were ignored). Now we close the modal synchronously
    // (state-driven, no pointer-event dependency) and persist in the
    // background. The kv write is idempotent so redundant skips are harmless.
    dispatch({ type: 'SET_ONBOARDED', value: true });
    void rpc.kv.set(KV_KEY, '1').catch(() => undefined);
    if (!pickedFolder) return;
    setBusy(true);
    try {
      const ws = await rpc.workspaces.open(pickedFolder.path);
      dispatch({ type: 'SET_ACTIVE_WORKSPACE', workspace: ws });
      dispatch({ type: 'SET_WORKSPACES', workspaces: await rpc.workspaces.list() });
    } catch (err) {
      console.error('open workspace failed', err);
    } finally {
      setBusy(false);
    }
  }

  async function pickFolder(): Promise<void> {
    try {
      const r = await rpc.workspaces.pickFolder();
      if (!r) return;
      const parts = r.path.split(/[\\/]/).filter(Boolean);
      setPickedFolder({ path: r.path, name: parts[parts.length - 1] ?? r.path });
    } catch (err) {
      console.error('pickFolder failed', err);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o && state.onboarded ? undefined : undefined)}>
      <DialogContent
        className="sm:max-w-lg"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-primary"><Monogram size={28} /></span>
            <span>Welcome to SigmaLink</span>
          </DialogTitle>
          <DialogDescription>
            Three quick steps and you’re set up — you can skip any of them.
          </DialogDescription>
        </DialogHeader>

        <div className="my-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <StepDot active={step === 0} done={step > 0} />
          <span className={step >= 0 ? 'text-foreground' : ''}>Welcome</span>
          <ChevronRight className="h-3 w-3" />
          <StepDot active={step === 1} done={step > 1} />
          <span className={step >= 1 ? 'text-foreground' : ''}>Detect agents</span>
          <ChevronRight className="h-3 w-3" />
          <StepDot active={step === 2} done={false} />
          <span className={step >= 2 ? 'text-foreground' : ''}>Workspace</span>
        </div>

        {step === 0 ? (
          <section className="sl-fade-in space-y-3 text-sm text-muted-foreground">
            <p>
              SigmaLink is a desktop control room for your CLI agents — Claude Code, Codex,
              Cursor, Gemini, Aider — all in tiled terminals over real git worktrees.
            </p>
            <ul className="space-y-1 pl-5 [&>li]:list-disc">
              <li>Launch up to 16 panes with one click.</li>
              <li>Coordinate them in swarms with shared mailboxes.</li>
              <li>Review diffs side-by-side and merge what passes.</li>
              <li>Browser, memory, and skills built in.</li>
            </ul>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="sl-fade-in space-y-3">
            <div className="text-xs text-muted-foreground">
              {probing
                ? 'Probing your PATH for agent CLIs…'
                : `Found ${found} of ${providers.length} agent CLI${providers.length === 1 ? '' : 's'} on your PATH.`}
            </div>
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {providers.map((p) => {
                const ok = !!p.probe?.found;
                return (
                  <li
                    key={p.id}
                    className="flex items-start gap-2 rounded px-2 py-1.5 text-xs"
                  >
                    <span
                      className={
                        ok
                          ? 'mt-[2px] grid h-4 w-4 place-items-center rounded-full bg-emerald-500/20 text-emerald-300'
                          : 'mt-[2px] grid h-4 w-4 place-items-center rounded-full bg-muted text-muted-foreground'
                      }
                      aria-hidden
                    >
                      {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-foreground">{p.name}</div>
                      {!ok ? (
                        <div className="mt-0.5 select-all whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                          {p.installHint}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
              {providers.length === 0 && !probing ? (
                <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No providers configured.
                </li>
              ) : null}
            </ul>
            <div className="text-[11px] text-muted-foreground">
              Missing CLIs aren’t a blocker — you can always launch the built-in shell.
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="sl-fade-in space-y-3">
            <div className="text-xs text-muted-foreground">
              Pick a project folder. SigmaLink only reads &amp; writes inside the folders you choose.
            </div>
            {pickedFolder ? (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <Folder className="h-4 w-4" /> {pickedFolder.name}
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground" title={pickedFolder.path}>
                  {pickedFolder.path}
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border bg-muted/10 p-6 text-center text-xs text-muted-foreground">
                <Sparkles className="mx-auto mb-2 h-4 w-4 text-muted-foreground" />
                You can do this later from the Workspaces room.
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void pickFolder()}
              className="gap-2"
            >
              <FolderPlus className="h-4 w-4" /> {pickedFolder ? 'Change folder' : 'Pick folder'}
            </Button>
          </section>
        ) : null}

        <DialogFooter className="flex flex-row items-center gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // BUG-W7-012: never `disabled`; Skip should always close the modal
            // even mid-transition. `pointer-events: auto` survives the Radix
            // open/close fade so the click is never dropped.
            onClick={() => void complete()}
            style={{ pointerEvents: 'auto' }}
          >
            Skip
          </Button>
          <div className="flex items-center gap-2">
            {step > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={busy}
              >
                Back
              </Button>
            ) : null}
            {step < 2 ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setStep((s) => Math.min(2, s + 1))}
                disabled={busy}
              >
                Continue
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={() => void complete()} disabled={busy}>
                {busy ? 'Finishing…' : 'Get started'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepDot({ active, done }: { active: boolean; done: boolean }) {
  return (
    <span
      className={
        done
          ? 'inline-block h-1.5 w-1.5 rounded-full bg-primary'
          : active
            ? 'inline-block h-1.5 w-1.5 rounded-full bg-foreground'
            : 'inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40'
      }
      aria-hidden
    />
  );
}
