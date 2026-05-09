// V3-W15-007 — Read-only marketplace stub. Fetches a static manifest from
// /marketplace/skills.json (served from app/public). Install button does NOT
// install; it surfaces a toast directing the user to the drag-and-drop flow.
// No network calls beyond the bundled JSON; live registry lands in a later wave.

import { useEffect, useState } from 'react';
import { Download, ExternalLink, Loader2, Store } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/renderer/components/EmptyState';

interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  installInstructions: string;
  repoUrl?: string;
  homepageUrl?: string;
}

interface Manifest {
  schemaVersion: number;
  generatedAt?: string;
  skills: MarketplaceSkill[];
}

const INSTALL_TOAST = 'Drag the skill folder onto the Skills room. Network installs not yet supported.';

export function MarketplaceTab() {
  const [skills, setSkills] = useState<MarketplaceSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        Read-only preview — sourced from a bundled manifest. To install, drop a SKILL.md folder onto
        the Installed tab.
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {skills.map((skill) => (
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
            <div className="mt-auto pt-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  toast.info(INSTALL_TOAST, { description: skill.installInstructions })
                }
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Install
              </Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
