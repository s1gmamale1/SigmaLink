// V3-W13-003: per-pane provider splash.
//
// Rendered overlaid on the terminal area while the PTY is initializing — i.e.
// before the first byte of stdout/stderr arrives. Listens to `pty:data` for
// the matching sessionId and self-hides on first byte. This avoids the empty
// "blank pane" flash that V3 frames replace with provider-branded boot text.
//
// Frame references:
//   0045 — Claude:   `Claude Code v2.1.116 · Opus 4.7 (1M) · Claude Max`
//   0070 — Codex:    `OpenAI Codex (v0.121.0) · gpt-5.4 high fast · directory: ~/Desktop/bridgemind`
//   0100/0140 — OpenCode ASCII + `Build · Kimi K2.6 OpenRouter`
//   0150 — BridgeCode `coming soon · falling back to Claude`

import { useEffect, useState } from 'react';
import { findProvider } from '@/shared/providers';
import type { AgentSession } from '@/shared/types';

// Inline default-model labels per provider. Mirrors `MODEL_OPTIONS` in
// `main/core/providers/models.ts` but stays renderer-local to avoid a
// renderer→main import. If/when a shared catalog is created the per-pane
// chrome should switch to it.
const DEFAULT_MODEL_LABEL: Record<string, string> = {
  claude: 'Opus 4.7 (1M)',
  codex: 'gpt-5.4',
  gemini: 'Gemini 2.5 Pro',
  opencode: 'Kimi K2.6 OpenRouter',
  bridgecode: 'BridgeCode default',
};

interface Props {
  session: AgentSession;
}

function isPtyDataPayload(p: unknown): p is { sessionId: string; data: string } {
  return (
    !!p &&
    typeof p === 'object' &&
    'sessionId' in p &&
    typeof (p as { sessionId: unknown }).sessionId === 'string'
  );
}

export function PaneSplash({ session }: Props) {
  const [firstByteSeen, setFirstByteSeen] = useState(false);

  useEffect(() => {
    // Subscribe to PTY output from external bus; setState only fires from
    // the bus callback (the documented exception in react-hooks rules) plus
    // a safety timeout that also hides via the same setter.
    const off = window.sigma.eventOn('pty:data', (raw: unknown) => {
      if (!isPtyDataPayload(raw)) return;
      if (raw.sessionId === session.id) setFirstByteSeen(true);
    });
    const t = setTimeout(() => setFirstByteSeen(true), 4000);
    return () => {
      off();
      clearTimeout(t);
    };
  }, [session.id]);

  // Hide the splash if either: first byte arrived, or the session itself is
  // already past the boot phase. Computed at render time so we never call
  // setState synchronously inside the effect body.
  const hidden = firstByteSeen || session.status === 'exited' || session.status === 'error';
  if (hidden) return null;

  const provider = findProvider(session.providerId);
  const modelLabel = DEFAULT_MODEL_LABEL[session.providerId];
  const cwd = session.cwd;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-start overflow-hidden bg-card/95 px-4 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
      {renderSplash(session.providerId, provider?.name ?? session.providerId, modelLabel, cwd, provider?.color)}
    </div>
  );
}

function renderSplash(
  providerId: string,
  providerName: string,
  modelLabel: string | undefined,
  cwd: string,
  providerColor: string | undefined,
) {
  const colour = providerColor ?? '#a78bfa';
  if (providerId === 'claude') {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-[12px] font-semibold" style={{ color: colour }}>
          {'✦'} Claude Code v2.1.116
        </div>
        <div>
          <span style={{ color: colour }}>{modelLabel ?? 'Opus 4.7 (1M)'}</span>
          <span className="text-muted-foreground"> · Claude Max</span>
        </div>
        <div className="text-muted-foreground">cwd: {cwd}</div>
        <div className="mt-2 text-[10px] text-muted-foreground/70">starting session…</div>
      </div>
    );
  }
  if (providerId === 'codex') {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-[12px] font-semibold" style={{ color: colour }}>
          OpenAI Codex (v0.121.0)
        </div>
        <div>
          <span style={{ color: colour }}>{modelLabel ?? 'gpt-5.4'}</span>
          <span className="text-muted-foreground"> · high fast</span>
        </div>
        <div className="text-muted-foreground">directory: {cwd}</div>
        <div className="mt-2 text-[10px] text-muted-foreground/70">starting session…</div>
      </div>
    );
  }
  if (providerId === 'opencode') {
    return (
      <div className="flex flex-col gap-1">
        <pre className="text-[10px] leading-tight" style={{ color: colour }}>
{`  ___  ____  ____ _ _   _  ____ ___  ____  ____
 / _ \\|  _ \\| ___| \\ | |/ ___/ _ \\|  _ \\| ___|
| | | | |_) |  _ |  \\| | |  | | | | | | |  _|
| |_| |  __/| |__| |\\  | |__| |_| | |_| | |__
 \\___/|_|   |____|_| \\_|\\____\\___/|____/|____|`}
        </pre>
        <div className="mt-1">
          <span className="text-muted-foreground">Build · </span>
          <span style={{ color: colour }}>{modelLabel ?? 'Kimi K2.6 OpenRouter'}</span>
        </div>
        <div className="text-muted-foreground">cwd: {cwd}</div>
      </div>
    );
  }
  // BridgeCode falls back to Claude under the hood, so we render the generic
  // splash (instead of the misleading "coming soon" stub) — the agent is
  // actually running. Generic provider splash.
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: colour }}>
        {providerName}
      </div>
      {modelLabel ? <div style={{ color: colour }}>{modelLabel}</div> : null}
      <div className="text-muted-foreground">cwd: {cwd}</div>
      <div className="mt-2 text-[10px] text-muted-foreground/70">starting session…</div>
    </div>
  );
}
