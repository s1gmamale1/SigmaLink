// v1.6.1 B3 — Skills tab Phase 1: read-only discovery panel.
// v1.7.1 W-5  Skills tab Phase 2: drag-drop binding (INFORMATIONAL only).
//
// Renders a searchable list of installed superpowers + Ruflo skills discovered
// from the on-disk plugin cache (~/.claude/plugins/cache/…).
//
// Phase 2 adds:
//   - Rows are draggable (draggable=true). dragstart sets a dataTransfer
//     payload `{ kind: 'skill', name, source }` under the custom MIME type
//     `application/sigmalink-skill`.
//   - Pane bodies and the workspace header become drop targets that accept
//     `kind: 'skill'` → call `skills.attach` (pane drop → paneSessionId set;
//     workspace header drop → paneSessionId null).
//   - Attached skills render as dismissible chips on the pane / workspace area.
//     Chip X → `skills.detach`.
//   - On workspace load, fetch `skills.listBindings` + render existing chips.
//
// SCOPE NOTE — INFORMATIONAL ONLY: Attaching a skill = a persisted visual
// association (chip). It does NOT change agent dispatch, does NOT inject into
// agent context, and does NOT alter Sigma/Jorvis tool-calling. Behavioral
// activation is a SEPARATE future enhancement requiring design decisions and
// is explicitly deferred (OUT OF SCOPE for this phase).

import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { Search, Copy, ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { toast } from 'sonner';
import { rpc } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';

interface InstalledSkillEntry {
  name: string;
  description: string;
  source: 'superpowers' | 'ruflo' | 'custom';
}

// Payload shape written to dataTransfer for cross-component drag-drop.
// Consumed by SkillDropTarget (PaneShell + workspace header area).
export interface SkillDragPayload {
  kind: 'skill';
  name: string;
  source: string;
}

/** MIME type used for skill drag-drop. Matches the check in SkillDropTarget. */
export const SKILL_DRAG_MIME = 'application/sigmalink-skill';

const SOURCE_BADGE: Record<InstalledSkillEntry['source'], string> = {
  superpowers: 'bg-violet-500/15 text-violet-300 border border-violet-500/30',
  ruflo: 'bg-sky-500/15 text-sky-300 border border-sky-500/30',
  custom: 'bg-muted text-muted-foreground border border-border',
};

export function SkillsTab() {
  const [skills, setSkills] = useState<InstalledSkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await rpc.skills.listInstalled();
        if (alive) setSkills(Array.isArray(result) ? (result as InstalledSkillEntry[]) : []);
      } catch {
        if (alive) setSkills([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const filtered = skills.filter((s) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  const onCopySlashCommand = useCallback(async (name: string) => {
    try {
      await navigator.clipboard.writeText(`/${name}`);
      toast.success(`Copied /${name}`);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  }, []);

  const toggleExpand = useCallback((name: string) => {
    setExpanded((prev) => (prev === name ? null : name));
  }, []);

  // v1.7.1 W-5 Phase 2 — dragstart handler. Sets a custom MIME payload so
  // SkillDropTarget instances can accept this drag while plain file drops
  // (handled by the existing v1.4.8 drag path) are unaffected.
  const handleDragStart = useCallback(
    (e: DragEvent<HTMLLIElement>, skill: InstalledSkillEntry) => {
      const payload: SkillDragPayload = { kind: 'skill', name: skill.name, source: skill.source };
      e.dataTransfer.setData(SKILL_DRAG_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'copy';
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search bar */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 rounded-md border border-border bg-background/60 px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="search"
            placeholder="Search skills…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            aria-label="Search skills"
          />
        </div>
      </div>

      {/* Skill list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
            Loading skills…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-1 p-6 text-center text-xs text-muted-foreground">
            {skills.length === 0
              ? 'No skills found in plugin cache.'
              : 'No skills match your search.'}
          </div>
        ) : (
          <ul role="list" className="divide-y divide-border">
            {filtered.map((skill) => {
              const isExpanded = expanded === skill.name;
              return (
                <li
                  key={skill.name}
                  className="flex flex-col"
                  draggable
                  onDragStart={(e) => handleDragStart(e, skill)}
                  aria-label={`Skill: ${skill.name}. Drag to attach to a pane or workspace.`}
                >
                  {/* Row header */}
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => toggleExpand(skill.name)}
                    aria-expanded={isExpanded}
                  >
                    {/* Drag handle indicator */}
                    <GripVertical
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/40"
                      aria-hidden
                    />
                    <span className="mt-0.5 shrink-0 text-muted-foreground">
                      {isExpanded
                        ? <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                        : <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                      }
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium text-foreground">
                          {skill.name}
                        </span>
                        <span className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                          SOURCE_BADGE[skill.source],
                        )}>
                          {skill.source}
                        </span>
                      </div>
                      {!isExpanded ? (
                        <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                          {skill.description}
                        </p>
                      ) : null}
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded ? (
                    <div className="border-t border-border bg-muted/20 px-4 py-3">
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {skill.description}
                      </p>
                      <button
                        type="button"
                        onClick={() => void onCopySlashCommand(skill.name)}
                        className="mt-2 flex items-center gap-1.5 rounded border border-border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <Copy className="h-3 w-3" aria-hidden />
                        Copy /{skill.name}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
