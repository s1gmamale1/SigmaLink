// V3-W13-010 — Mission step with `@<workspaceSlug>` autocomplete.
//
// Source: docs/02-research/v3-protocol-delta.md §2 (`@workspace` resolver) +
// frames 0210, 0235.
//
// UX: a plain textarea — when the operator types `@`, a combobox opens
// directly above the caret listing matching workspace slugs (filtered by the
// substring after the `@`). Picking an entry replaces the partial `@<typed>`
// inline with the canonical `@<slug>`. Selection is keyboard-driven
// (ArrowUp / ArrowDown / Enter / Esc) and the popover closes on Esc, on
// blur, or when the operator types a whitespace character.
//
// Backend resolution (slug → absolute path + last-known branch) lands when
// the swarm is created — we surface the typed mission verbatim; the
// controller-side resolver replaces `@<slug>` tokens at launch and stashes
// the result under a structured marker in `swarms.mission` (see
// V3-PARITY-BACKLOG → V3-W13-010 acceptance). For the renderer we only
// guarantee the inline replacement is syntactically correct.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import type { Workspace } from '@/shared/types';
// V3-W15-002 — voice intake into the mission textarea. The adapter wraps the
// Web Speech API and emits `voice:state` so the title-bar pill stays in sync.
import {
  isVoiceSupported,
  startCapture,
  VoiceBusyError,
  type VoiceCaptureHandle,
} from '@/renderer/lib/voice';

interface Props {
  mission: string;
  onMissionChange: (next: string) => void;
  /** V3-W15-002 — Cmd/Ctrl+Enter submits the mission and advances the wizard. */
  onAdvance?: () => void;
}

interface SlugSuggestion {
  /** Always lowercase, hyphenated. Used in the inline replacement. */
  slug: string;
  /** Human-friendly workspace name shown alongside the slug. */
  label: string;
  /** 'workspace' or 'file' — drives the icon prefix in the suggestion list. */
  kind: 'workspace' | 'file';
}

// Convert a workspace name to a slug. Lowercase, replace non-alnum with `-`,
// collapse runs, strip leading/trailing dashes.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// Active `@…` token at the caret. Returns `null` when the caret is not in a
// trigger context (e.g. previous char is whitespace+letter, or we have a
// space inside the partial). The token must start at a word boundary or the
// very beginning of the string.
function tokenAtCaret(value: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === '@') {
      const before = i === 0 ? '' : value[i - 1];
      // Trigger only at start-of-string or after whitespace; otherwise this
      // is part of an email or some other `@`-bearing token we shouldn't
      // hijack.
      if (before === '' || /\s/.test(before)) {
        return { start: i, query: value.slice(i + 1, caret) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

export function MissionStep({ mission, onMissionChange, onAdvance }: Props) {
  const { state } = useAppState();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  // V3-W15-002 — voice intake state. `voiceHandle` is the live capture so we
  // can stop it from a second click. `partial` shows the in-progress transcript
  // appended to the committed mission text without mutating `mission` until
  // the recognizer commits a final result (then we append-and-clear).
  const [voiceHandle, setVoiceHandle] = useState<VoiceCaptureHandle | null>(null);
  const [partial, setPartial] = useState('');
  const missionRef = useRef(mission);
  useEffect(() => {
    missionRef.current = mission;
  }, [mission]);

  // Pull the workspace list once; the picker is a snapshot — operators
  // rarely add a workspace mid-wizard, and a stale entry is harmless because
  // server-side resolution catches missing slugs.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await rpc.workspaces.list();
        if (!alive) return;
        setWorkspaces(list);
      } catch (err) {
        // Failure is non-fatal: the textarea still works without
        // suggestions. Log so smoke tests catch the regression but don't
        // pop a toast — `rpc` already does that.
        console.error('MissionStep: workspaces.list failed', err);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Lazy file-picker fallback. We don't recurse the repo; instead we probe a
  // small fixed set of common top-level files via `rpc.fs.exists`, then use
  // whatever exists as suggestion candidates. This keeps W13 focused — the
  // full assistant `:ref-resolve` lands with V3-W13-013.
  useEffect(() => {
    const ws = state.activeWorkspace;
    let alive = true;
    void (async () => {
      if (!ws) {
        if (alive) setFiles([]);
        return;
      }
      const candidates = [
        'README.md',
        'package.json',
        'tsconfig.json',
        'CLAUDE.md',
        'AGENTS.md',
        '.gitignore',
        'CHANGELOG.md',
        'LICENSE',
      ];
      const found: string[] = [];
      for (const c of candidates) {
        try {
          const ok = await rpc.fs.exists(`${ws.rootPath.replace(/\/$/, '')}/${c}`);
          if (ok) found.push(c);
        } catch {
          /* ignore */
        }
      }
      if (alive) setFiles(found);
    })();
    return () => {
      alive = false;
    };
  }, [state.activeWorkspace]);

  // Recompute the suggestion list whenever the typed query changes. We
  // dedupe by `slug` so a workspace named identically to a file (rare) only
  // appears once.
  const suggestions = useMemo<SlugSuggestion[]>(() => {
    if (!token) return [];
    const q = token.query.toLowerCase();
    const wsSuggestions: SlugSuggestion[] = workspaces
      .map((w) => ({ slug: slugify(w.name), label: w.name, kind: 'workspace' as const }))
      .filter((s) => s.slug.startsWith(q));
    const fileSuggestions: SlugSuggestion[] = files
      .filter((f) => f.toLowerCase().startsWith(q))
      .map((f) => ({ slug: f, label: f, kind: 'file' as const }));
    const seen = new Set<string>();
    const out: SlugSuggestion[] = [];
    for (const s of [...wsSuggestions, ...fileSuggestions]) {
      if (seen.has(s.slug)) continue;
      seen.add(s.slug);
      out.push(s);
      if (out.length >= 8) break;
    }
    return out;
  }, [token, workspaces, files]);

  // Clamp during render — when the suggestions list shrinks below the
  // current cursor we drop back to 0. Avoids a `setState` in an effect
  // while still keeping the cursor in range. (See react-hooks rule
  // `set-state-in-effect`.)
  const safeActiveIdx = activeIdx >= suggestions.length ? 0 : activeIdx;

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    const value = e.target.value;
    onMissionChange(value);
    const t = tokenAtCaret(value, e.target.selectionStart ?? value.length);
    setToken(t);
    setOpen(t !== null);
    setActiveIdx(0);
  }

  function pick(idx: number): void {
    if (!token) return;
    const choice = suggestions[idx];
    if (!choice) return;
    const before = mission.slice(0, token.start);
    const after = mission.slice(token.start + 1 + token.query.length);
    const next = `${before}@${choice.slug}${after}`;
    onMissionChange(next);
    setOpen(false);
    setToken(null);
    // Restore caret just after the inserted slug.
    const caret = before.length + 1 + choice.slug.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  // Cleanup any live voice capture when the step unmounts.
  useEffect(() => {
    return () => {
      voiceHandle?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleVoice(): Promise<void> {
    if (voiceHandle) {
      voiceHandle.stop();
      setVoiceHandle(null);
      setPartial('');
      return;
    }
    if (!isVoiceSupported()) {
      toast.error('Voice not supported on this platform');
      return;
    }
    try {
      const handle = await startCapture({
        source: 'mission',
        onPartial: (text) => setPartial(text),
        onFinal: (text) => {
          // Append the committed transcript to whatever the user has typed so
          // far, separated by a space so multiple utterances don't clobber.
          const current = missionRef.current;
          const sep = current && !/\s$/.test(current) ? ' ' : '';
          onMissionChange(`${current}${sep}${text}`);
          setPartial('');
        },
        onError: () => {
          setVoiceHandle(null);
          setPartial('');
        },
      });
      setVoiceHandle(handle);
    } catch (err) {
      if (err instanceof VoiceBusyError) {
        toast.error('Another voice session is active', {
          description: 'Stop the current capture before starting a new one.',
        });
      }
      setVoiceHandle(null);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // V3-W15-002 — Cmd/Ctrl+Enter advances the wizard. The autocomplete
    // popover swallows plain Enter (suggestion pick); the modifier path
    // bypasses that branch entirely.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      voiceHandle?.stop();
      onAdvance?.();
      return;
    }
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(safeActiveIdx);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setToken(null);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="text-sm font-medium">Mission</div>
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={mission}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // Slight delay so a click on a suggestion still fires `pick`
            // before blur tears the popover down.
            setTimeout(() => setOpen(false), 80);
          }}
          placeholder="What should this swarm accomplish? Tip: type @ to reference a workspace or file."
          rows={6}
          className="min-h-[140px] w-full resize-none rounded-md border border-border bg-background px-3 py-2 pr-10 text-sm"
        />
        {/* V3-W15-002 — mic toggle pinned top-right of the textarea. Active
            state pulses the icon cyan; click again to stop the capture. */}
        <button
          type="button"
          onClick={() => void toggleVoice()}
          aria-label={voiceHandle ? 'Stop voice capture' : 'Dictate mission'}
          aria-pressed={voiceHandle !== null}
          data-testid="mission-mic"
          className={
            'absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md border border-border bg-background text-muted-foreground transition hover:text-foreground ' +
            (voiceHandle ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-200' : '')
          }
        >
          {voiceHandle ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
        </button>
        {/* Live partial transcript — rendered just below the textarea so the
            operator sees what the recognizer is hearing before it commits. */}
        {partial ? (
          <div
            data-testid="mission-voice-partial"
            className="mt-1 truncate rounded-sm bg-cyan-400/10 px-2 py-1 text-[11px] italic text-cyan-200"
          >
            {partial}
          </div>
        ) : null}
        {open && suggestions.length > 0 ? (
          <ul
            role="listbox"
            data-testid="mission-autocomplete"
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm shadow-md"
          >
            {suggestions.map((s, i) => (
              <li
                key={`${s.kind}:${s.slug}`}
                role="option"
                aria-selected={i === safeActiveIdx}
                onMouseDown={(e) => {
                  // Use mousedown so the textarea blur fires AFTER our
                  // handler — onClick would lose the selection.
                  e.preventDefault();
                  pick(i);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                className={
                  'flex cursor-pointer items-center gap-2 rounded px-2 py-1 ' +
                  (i === safeActiveIdx ? 'bg-accent text-accent-foreground' : '')
                }
              >
                <span className="font-mono text-[10px] uppercase opacity-60">
                  {s.kind === 'workspace' ? 'WS' : 'FILE'}
                </span>
                <span className="font-mono text-xs">@{s.slug}</span>
                {s.label !== s.slug ? (
                  <span className="ml-auto text-[10px] text-muted-foreground">{s.label}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="text-[11px] text-muted-foreground">
        Type <code>@</code> to reference a workspace by slug or a top-level file in the active repo.
        Server resolves <code>@&lt;slug&gt;</code> to absolute path + last-known branch at launch.
      </div>
    </Card>
  );
}
