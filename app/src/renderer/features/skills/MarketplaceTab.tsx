// Phase 4 Step 5 — SigmaSkills marketplace.
//
// Reads the bundled `/marketplace/skills.json` index. Each card now installs
// live via `skills.installFromUrl` (clone tarball → validate SKILL.md →
// reuse existing ingestion pipeline → fan out to enabled providers). The
// progress bar is driven by `skills:install-progress`.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download,
  ExternalLink,
  Loader2,
  Store,
  Check,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/renderer/components/EmptyState';
import { rpcSilent, onEvent } from '@/renderer/lib/rpc';

interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  installInstructions?: string;
  /** Phase 4 Step 5 — preferred install source. `owner/repo` shorthand or a
   *  full GitHub URL. When omitted we fall back to `repoUrl`. */
  install?: { ownerRepo: string; ref?: string; subPath?: string };
  repoUrl?: string;
  homepageUrl?: string;
}

interface Manifest {
  schemaVersion: number;
  generatedAt?: string;
  skills: MarketplaceSkill[];
}

type InstallPhase =
  | 'resolve'
  | 'fetch'
  | 'extract'
  | 'validate'
  | 'ingest'
  | 'fanout'
  | 'done'
  | 'error';

interface InstallProgressPayload {
  ownerRepo: string;
  phase: InstallPhase;
  bytesDone: number;
  bytesTotal: number;
  message?: string;
}

interface CardState {
  installing: boolean;
  phase?: InstallPhase;
  bytesDone: number;
  bytesTotal: number;
  installed?: boolean;
  error?: string;
}

const PHASE_LABEL: Record<InstallPhase, string> = {
  resolve: 'Resolving repository…',
  fetch: 'Downloading…',
  extract: 'Extracting…',
  validate: 'Validating SKILL.md…',
  ingest: 'Installing…',
  fanout: 'Updating providers…',
  done: 'Done',
  error: 'Error',
};

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

/** Best-effort `'owner/repo'` derivation when a manifest entry only carries a
 *  raw `repoUrl`. Returns `null` if we can't make sense of the URL. */
function repoUrlToOwnerRepo(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) return null;
    return `${segs[0]}/${segs[1]!.replace(/\.git$/i, '')}`;
  } catch {
    return null;
  }
}

export function MarketplaceTab() {
  const [skills, setSkills] = useState<MarketplaceSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});

  // Map ownerRepo → marketplace card id so the progress event knows which row
  // to drive without round-tripping the id through the channel payload.
  const ownerRepoIndex = useMemo(() => {
    const idx = new Map<string, string>();
    for (const s of skills ?? []) {
      const owner = s.install?.ownerRepo ?? repoUrlToOwnerRepo(s.repoUrl);
      if (owner) idx.set(owner.toLowerCase(), s.id);
    }
    return idx;
  }, [skills]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('marketplace/skills.json');
        if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
        const data = (await res.json()) as Manifest;
        if (!cancelled) setSkills(Array.isArray(data.skills) ? data.skills : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const off = onEvent<InstallProgressPayload>('skills:install-progress', (p) => {
      if (!p || typeof p !== 'object') return;
      const cardId = ownerRepoIndex.get(p.ownerRepo.toLowerCase());
      if (!cardId) return;
      setCardStates((prev) => {
        const cur = prev[cardId] ?? {
          installing: true,
          bytesDone: 0,
          bytesTotal: 0,
        };
        return {
          ...prev,
          [cardId]: {
            ...cur,
            installing: p.phase !== 'done' && p.phase !== 'error',
            phase: p.phase,
            bytesDone: p.bytesDone,
            bytesTotal: p.bytesTotal,
            error: p.phase === 'error' ? p.message : cur.error,
            installed: p.phase === 'done' ? true : cur.installed,
          },
        };
      });
    });
    return () => {
      off();
    };
  }, [ownerRepoIndex]);

  const handleInstall = useCallback(async (skill: MarketplaceSkill) => {
    const ownerRepo = skill.install?.ownerRepo ?? repoUrlToOwnerRepo(skill.repoUrl);
    if (!ownerRepo) {
      toast.error('No GitHub source for this skill', {
        description: 'Add `install.ownerRepo` or a `repoUrl` field to the manifest entry.',
      });
      return;
    }
    setCardStates((prev) => ({
      ...prev,
      [skill.id]: { installing: true, bytesDone: 0, bytesTotal: 0, phase: 'resolve' },
    }));
    try {
      const result = await rpcSilent.skills.installFromUrl({
        ownerRepo,
        ref: skill.install?.ref,
        subPath: skill.install?.subPath,
        force: false,
      });
      if (result.ok && result.skill) {
        toast.success(`Installed ${result.skill.name}`, {
          description: `Version ${result.skill.version ?? 'unversioned'} from ${ownerRepo}`,
        });
        setCardStates((prev) => ({
          ...prev,
          [skill.id]: {
            installing: false,
            bytesDone: prev[skill.id]?.bytesDone ?? 0,
            bytesTotal: prev[skill.id]?.bytesTotal ?? 0,
            installed: true,
            phase: 'done',
          },
        }));
      } else {
        const code = result.error?.code ?? 'install-failed';
        const message = result.error?.message ?? 'Install failed';
        toast.error(`${code}`, { description: message });
        setCardStates((prev) => ({
          ...prev,
          [skill.id]: {
            installing: false,
            bytesDone: 0,
            bytesTotal: 0,
            error: message,
            phase: 'error',
          },
        }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Install failed', { description: message });
      setCardStates((prev) => ({
        ...prev,
        [skill.id]: {
          installing: false,
          bytesDone: 0,
          bytesTotal: 0,
          error: message,
          phase: 'error',
        },
      }));
    }
  }, []);

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Could not load marketplace manifest: {error}
      </div>
    );
  }

  if (skills === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading marketplace…
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <EmptyState
        icon={Store}
        title="No skills published yet"
        description="The marketplace manifest is empty. Check back later."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Live install fetches the repository tarball, validates SKILL.md, and fans out
        to your enabled providers. You can also drop a SKILL.md folder onto the
        Installed tab.
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {skills.map((skill) => {
          const state = cardStates[skill.id];
          const ownerRepo = skill.install?.ownerRepo ?? repoUrlToOwnerRepo(skill.repoUrl);
          const canInstall = !!ownerRepo && !state?.installing;
          const pct =
            state && state.bytesTotal > 0
              ? Math.min(100, Math.round((state.bytesDone / state.bytesTotal) * 100))
              : null;
          return (
            <article
              key={skill.id}
              className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 text-sm"
            >
              <header className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{skill.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    v{skill.version} · {skill.author}
                  </p>
                </div>
                {skill.repoUrl || skill.homepageUrl ? (
                  <a
                    href={skill.repoUrl ?? skill.homepageUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                    aria-label={`Open ${skill.name} homepage`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </header>
              <p className="text-xs text-muted-foreground">{skill.description}</p>
              {skill.tags.length > 0 ? (
                <ul className="flex flex-wrap gap-1">
                  {skill.tags.map((tag) => (
                    <li
                      key={tag}
                      className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                    >
                      {tag}
                    </li>
                  ))}
                </ul>
              ) : null}

              {state?.installing && state.phase ? (
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>{PHASE_LABEL[state.phase]}</span>
                    {state.bytesTotal > 0 ? (
                      <span className="ml-auto font-mono">
                        {formatBytes(state.bytesDone)} / {formatBytes(state.bytesTotal)}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="h-1 w-full overflow-hidden rounded bg-muted"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct ?? undefined}
                  >
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: pct !== null ? `${pct}%` : '20%' }}
                    />
                  </div>
                </div>
              ) : null}

              {state?.installed && !state.installing ? (
                <div className="flex items-center gap-1 text-[11px] text-emerald-400">
                  <Check className="h-3 w-3" />
                  Installed — manage from the Installed tab.
                </div>
              ) : null}

              {state?.error && !state.installing ? (
                <div className="flex items-start gap-1 rounded border border-amber-300/40 bg-amber-100/10 p-2 text-[11px] text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="break-words">{state.error}</span>
                </div>
              ) : null}

              <div className="mt-auto pt-1">
                <Button
                  size="sm"
                  variant={state?.installed ? 'outline' : 'default'}
                  disabled={!canInstall}
                  onClick={() => void handleInstall(skill)}
                  title={
                    !ownerRepo
                      ? 'No GitHub source listed for this skill'
                      : state?.installed
                        ? 'Reinstall'
                        : 'Install'
                  }
                >
                  {state?.installing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {state?.installed ? 'Reinstall' : 'Install'}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Want to publish a skill? Open a PR adding your repository to{' '}
        <code className="text-[10px]">app/public/marketplace/skills.json</code>.
      </p>
    </div>
  );
}
