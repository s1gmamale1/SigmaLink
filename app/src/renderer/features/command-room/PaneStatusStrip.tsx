// V3-W13-003: per-pane mid-strip showing `<model> <effort> <speed> · <cwd>`.
//
// Sits between the PaneHeader and the terminal body. Mirrors V3 frame 0070
// (Codex `gpt-5.4 high fast · ~/Desktop/bridgemind`) and frame 0100/0140
// (OpenCode `Build · Kimi K2.6 OpenRouter`). The defaults below mirror the
// `MODEL_OPTIONS` table in `main/core/providers/models.ts` — they live here
// renderer-side to avoid a renderer→main import; they should track that
// table whenever a model entry is added or its `defaultEffort` changes.

import type { AgentSession } from '@/shared/types';

interface ModelMeta {
  label: string;
  effort: 'low' | 'medium' | 'high';
  speed: 'slow' | 'fast';
}

const DEFAULT_MODELS: Record<string, ModelMeta> = {
  claude: { label: 'Opus 4.7 (1M)', effort: 'high', speed: 'fast' },
  codex: { label: 'gpt-5.4', effort: 'high', speed: 'fast' },
  gemini: { label: 'Gemini 2.5 Pro', effort: 'medium', speed: 'fast' },
  opencode: { label: 'Kimi K2.6 OpenRouter', effort: 'medium', speed: 'fast' },
  bridgecode: { label: 'BridgeCode default', effort: 'medium', speed: 'fast' },
  cursor: { label: 'Cursor agent', effort: 'medium', speed: 'fast' },
  droid: { label: 'Droid', effort: 'medium', speed: 'fast' },
  copilot: { label: 'Copilot', effort: 'medium', speed: 'fast' },
};

function shortenCwd(cwd: string): string {
  // Best-effort `~/...` shortening for display. We can't read $HOME from the
  // renderer reliably; the launcher emits absolute paths so we strip a
  // leading `/Users/<name>/` prefix if it's there.
  const m = cwd.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (m) return `~${m[1] ?? ''}`;
  const home = cwd.match(/^\/home\/[^/]+(\/.*)?$/);
  if (home) return `~${home[1] ?? ''}`;
  return cwd;
}

interface Props {
  session: AgentSession;
}

export function PaneStatusStrip({ session }: Props) {
  const meta = DEFAULT_MODELS[session.providerId];
  const cwd = shortenCwd(session.cwd);

  return (
    <div className="flex h-6 items-center gap-1.5 border-b border-border/60 bg-card px-2 font-mono text-[10px] text-muted-foreground">
      {meta ? (
        <>
          <span className="font-semibold text-foreground/80">{meta.label}</span>
          <span>{meta.effort}</span>
          <span>{meta.speed}</span>
          <span>·</span>
        </>
      ) : null}
      <span className="truncate" title={session.cwd}>
        {cwd}
      </span>
    </div>
  );
}
