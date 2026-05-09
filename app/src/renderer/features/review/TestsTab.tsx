// Test runner tab. Streams `review:run-output` events into a scrollback,
// supports a sticky default command per-provider, and lets the operator kill
// the in-flight process.

import { useEffect, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ReviewSession } from '@/shared/types';

const PROVIDER_DEFAULT_TEST: Record<string, string> = {
  claude: 'npm test',
  codex: 'npm test',
  gemini: 'npm test',
};

interface Props {
  session: ReviewSession;
}

interface RunLine {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export function TestsTab({ session }: Props) {
  const [command, setCommand] = useState(
    session.lastTestCommand ?? PROVIDER_DEFAULT_TEST[session.providerId] ?? 'npm test',
  );
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<RunLine[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new output.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Reset scrollback whenever the active session changes — keep the reset
  // out of the subscription effect so React doesn't see a setState() call in
  // the effect body itself.
  useEffect(() => {
    return () => {
      setLines([]);
      setRunning(false);
    };
  }, [session.sessionId]);

  // Subscribe to streamed run output for this session.
  useEffect(() => {
    const off = window.sigma.eventOn('review:run-output', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as Record<string, unknown>;
      if (typeof p.sessionId !== 'string' || p.sessionId !== session.sessionId) return;
      const stream = p.stream as RunLine['stream'];
      const text = typeof p.data === 'string' ? p.data : '';
      const done = Boolean(p.done);
      setLines((prev) => [...prev, { stream, text }]);
      if (done) setRunning(false);
    });
    return off;
  }, [session.sessionId]);

  const start = async () => {
    setErr(null);
    setLines([]);
    setRunning(true);
    try {
      await rpc.review.runCommand({
        sessionId: session.sessionId,
        command,
      });
    } catch (e) {
      setRunning(false);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    try {
      await rpc.review.killCommand(session.sessionId);
    } catch {
      /* ignore */
    }
    setRunning(false);
  };

  const disabled = !session.worktreePath;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-2">
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="npm test"
          className="h-8 font-mono text-xs"
          disabled={disabled || running}
        />
        {running ? (
          <Button onClick={stop} size="sm" variant="destructive">
            <Square className="mr-1 h-3 w-3" /> Stop
          </Button>
        ) : (
          <Button onClick={start} size="sm" disabled={disabled || command.trim().length === 0}>
            <Play className="mr-1 h-3 w-3" /> Run
          </Button>
        )}
      </div>
      {err ? (
        <div className="border-b border-red-500/40 bg-red-500/5 px-3 py-1 text-xs text-red-500">
          {err}
        </div>
      ) : null}
      <div
        ref={scrollerRef}
        className="flex-1 overflow-auto bg-black/60 p-3 font-mono text-[12px] text-foreground"
      >
        {lines.length === 0 ? (
          <span className="text-muted-foreground">
            {disabled
              ? 'No worktree to run commands in.'
              : 'No output yet — press Run.'}
          </span>
        ) : (
          lines.map((l, i) => (
            <span
              key={i}
              className={cn(
                l.stream === 'stderr'
                  ? 'text-red-400'
                  : l.stream === 'system'
                  ? 'text-amber-400'
                  : '',
              )}
            >
              {l.text}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
