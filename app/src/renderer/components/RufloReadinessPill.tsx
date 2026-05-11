import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { onEvent, rpcSilent } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';

type Cli = 'claude' | 'codex' | 'gemini';
type Readiness = 'pending' | 'verified' | 'partial' | 'unavailable';

interface RufloWorkspaceVerified {
  workspaceId?: string;
  workspaceRoot: string;
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  mode: 'fast' | 'strict';
  errors: Array<{ cli: Cli; message: string }>;
}

interface SkillsWorkspaceVerified {
  workspaceId: string;
  verified: number;
  refanned: number;
  errors: Array<{ message: string }>;
}

export function RufloReadinessPill() {
  const { state } = useAppState();
  const active = state.activeWorkspace;
  const [ruflo, setRuflo] = useState<Record<string, RufloWorkspaceVerified>>({});
  const [skills, setSkills] = useState<Record<string, SkillsWorkspaceVerified>>({});

  useEffect(() => {
    const offRuflo = onEvent<RufloWorkspaceVerified>('ruflo:workspace-verified', (payload) => {
      if (!payload || typeof payload.workspaceRoot !== 'string') return;
      const key = payload.workspaceId ?? payload.workspaceRoot;
      setRuflo((prev) => ({ ...prev, [key]: payload }));
    });
    const offSkills = onEvent<SkillsWorkspaceVerified>('skills:workspace-verified', (payload) => {
      if (!payload || typeof payload.workspaceId !== 'string') return;
      setSkills((prev) => ({ ...prev, [payload.workspaceId]: payload }));
    });
    return () => {
      offRuflo();
      offSkills();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const hasRuflo = ruflo[active.id] ?? ruflo[active.rootPath];
    const hasSkills = skills[active.id];
    if (hasRuflo && hasSkills) return;
    void (async () => {
      try {
        if (!hasRuflo) {
          const result = await rpcSilent.ruflo.verifyForWorkspace(active.rootPath);
          setRuflo((prev) => ({
            ...prev,
            [active.id]: { workspaceId: active.id, workspaceRoot: active.rootPath, ...result },
          }));
        }
        if (!hasSkills) {
          const result = await rpcSilent.skills.verifyForWorkspace(active.id);
          setSkills((prev) => ({ ...prev, [active.id]: result }));
        }
      } catch {
        /* background status only */
      }
    })();
  }, [active, ruflo, skills]);

  const status = useMemo(() => {
    if (!active) return null;
    const r = ruflo[active.id] ?? ruflo[active.rootPath];
    const s = skills[active.id];
    const rState = r ? readinessFromRuflo(r) : 'pending';
    const sState = s ? readinessFromSkills(s) : 'pending';
    const combined = combineReadiness(rState, sState);
    const title = [
      r
        ? `Ruflo ${r.mode}: ${r.claude && r.codex && r.gemini ? 'verified' : `${r.errors.length} issue(s)`}`
        : 'Ruflo verification pending',
      s
        ? `Skills: ${s.verified} verified, ${s.refanned} refreshed, ${s.errors.length} issue(s)`
        : 'Skills verification pending',
    ].join('\n');
    return { combined, title };
  }, [active, ruflo, skills]);

  if (!active || !status) return null;

  const Icon =
    status.combined === 'verified'
      ? CheckCircle2
      : status.combined === 'pending'
        ? Loader2
        : status.combined === 'partial'
          ? AlertTriangle
          : XCircle;

  return (
    <span
      className={cn(
        'ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded border px-2 text-[11px]',
        status.combined === 'verified' &&
          'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
        status.combined === 'pending' && 'border-border bg-muted/30 text-muted-foreground',
        status.combined === 'partial' && 'border-amber-500/40 bg-amber-500/10 text-amber-300',
        status.combined === 'unavailable' && 'border-red-500/40 bg-red-500/10 text-red-300',
      )}
      title={status.title}
    >
      <Icon className={cn('h-3 w-3', status.combined === 'pending' && 'animate-spin')} />
      <span>Ruflo + Skills</span>
    </span>
  );
}

function readinessFromRuflo(result: RufloWorkspaceVerified): Readiness {
  const count = [result.claude, result.codex, result.gemini].filter(Boolean).length;
  if (count === 3) return 'verified';
  if (count > 0) return 'partial';
  return 'unavailable';
}

function readinessFromSkills(result: SkillsWorkspaceVerified): Readiness {
  if (result.errors.length === 0) return 'verified';
  if (result.verified > 0 || result.refanned > 0) return 'partial';
  return 'unavailable';
}

function combineReadiness(a: Readiness, b: Readiness): Readiness {
  if (a === 'pending' || b === 'pending') return 'pending';
  if (a === 'unavailable' || b === 'unavailable') return 'unavailable';
  if (a === 'partial' || b === 'partial') return 'partial';
  return 'verified';
}
