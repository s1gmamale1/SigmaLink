import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import type { SwarmMessage } from '@/shared/types';

interface Props {
  message: SwarmMessage;
}

const KIND_BADGE: Record<string, string> = {
  SAY: 'bg-emerald-500/15 text-emerald-300',
  ACK: 'bg-sky-500/15 text-sky-300',
  STATUS: 'bg-amber-500/15 text-amber-300',
  DONE: 'bg-violet-500/15 text-violet-300',
  OPERATOR: 'bg-primary/15 text-primary-foreground',
  ROLLCALL: 'bg-pink-500/15 text-pink-300',
  ROLLCALL_REPLY: 'bg-pink-500/10 text-pink-200',
  SYSTEM: 'bg-muted text-muted-foreground',
  // V3-W13 envelope kinds.
  task_brief: 'bg-indigo-500/15 text-indigo-300',
  board_post: 'bg-teal-500/15 text-teal-300',
  directive: 'bg-orange-500/15 text-orange-300',
  escalation: 'bg-red-500/15 text-red-300',
  review_request: 'bg-blue-500/15 text-blue-300',
  quiet_tick: 'bg-zinc-500/15 text-zinc-300',
  error_report: 'bg-rose-500/15 text-rose-300',
};

// V3-W13-007 — task_brief structured payload. We tolerate slightly older
// schemas where `links` may be `string[]` instead of `{label,url}[]`.
interface TaskBriefLink {
  label: string;
  url: string;
}
interface TaskBriefHeading {
  title: string;
  bullets: string[];
  links: TaskBriefLink[];
}
interface TaskBriefPayload {
  taskId: string;
  urgency: 'low' | 'normal' | 'urgent';
  headings: TaskBriefHeading[];
}

function asTaskBrief(payload: unknown): TaskBriefPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const taskId = typeof p.taskId === 'string' ? p.taskId : '';
  const urgencyRaw = typeof p.urgency === 'string' ? p.urgency : 'normal';
  const urgency: TaskBriefPayload['urgency'] =
    urgencyRaw === 'urgent' || urgencyRaw === 'low' ? urgencyRaw : 'normal';
  const headingsRaw = Array.isArray(p.headings) ? p.headings : [];
  const headings: TaskBriefHeading[] = headingsRaw
    .map((h: unknown): TaskBriefHeading | null => {
      if (!h || typeof h !== 'object') return null;
      const hh = h as Record<string, unknown>;
      const title = typeof hh.title === 'string' ? hh.title : '';
      if (!title) return null;
      const bullets = Array.isArray(hh.bullets)
        ? hh.bullets.filter((b): b is string => typeof b === 'string')
        : [];
      const linksRaw = Array.isArray(hh.links) ? hh.links : [];
      const links: TaskBriefLink[] = linksRaw
        .map((l: unknown): TaskBriefLink | null => {
          if (typeof l === 'string') {
            return { label: l, url: l };
          }
          if (l && typeof l === 'object') {
            const ll = l as Record<string, unknown>;
            const url = typeof ll.url === 'string' ? ll.url : '';
            const label = typeof ll.label === 'string' ? ll.label : url;
            return url ? { label, url } : null;
          }
          return null;
        })
        .filter((l): l is TaskBriefLink => l !== null);
      return { title, bullets, links };
    })
    .filter((h): h is TaskBriefHeading => h !== null);
  return { taskId, urgency, headings };
}

export function MailboxBubble({ message }: Props) {
  const { state } = useAppState();
  const isOperator = message.fromAgent === 'operator';
  const isBroadcast = message.toAgent === '*';
  // SwarmMessage.kind is the narrow legacy SIGMA::* enum; V3 envelopes ride
  // the same column with wider strings (board_post, task_brief, …). Compare
  // via string so TS doesn't complain about the impossible narrow overlap.
  const kindStr = message.kind as string;
  const isTaskBrief = kindStr === 'task_brief';

  const taskBrief = useMemo(
    () => (isTaskBrief ? asTaskBrief(message.payload) : null),
    [isTaskBrief, message.payload],
  );

  return (
    <div
      className={cn(
        'flex w-full',
        isOperator ? 'justify-end' : 'justify-start',
      )}
    >
      <div
        className={cn(
          'flex max-w-[85%] flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs',
          isOperator ? 'bg-primary/10' : 'bg-card/60',
          taskBrief?.urgency === 'urgent' && 'border-red-500/60 bg-red-500/5',
        )}
      >
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-medium',
              KIND_BADGE[message.kind] ?? KIND_BADGE.SYSTEM,
            )}
          >
            {message.kind}
          </span>
          {taskBrief?.urgency === 'urgent' ? (
            <span className="rounded bg-red-500 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
              URGENT
            </span>
          ) : null}
          <span>
            {message.fromAgent} → {isBroadcast ? 'all' : message.toAgent}
          </span>
          <span className="ml-auto opacity-60">{formatTime(message.ts)}</span>
        </div>

        {taskBrief ? (
          <TaskBriefBody brief={taskBrief} workspaceId={state.activeWorkspace?.id ?? null} />
        ) : (
          <div className="whitespace-pre-wrap text-sm text-foreground">{message.body}</div>
        )}
      </div>
    </div>
  );
}

function TaskBriefBody({
  brief,
  workspaceId,
}: {
  brief: TaskBriefPayload;
  workspaceId: string | null;
}) {
  // Resolve a link click to the in-app browser when an active workspace is
  // available. We open a new tab so the brief's links never overwrite the
  // operator's current browsing context. Fall back to no-op so we never
  // throw on render.
  function onLinkClick(e: React.MouseEvent, url: string): void {
    e.preventDefault();
    if (!workspaceId) return;
    void rpc.browser.openTab({ workspaceId, url }).catch(() => undefined);
  }

  return (
    <div className="flex flex-col gap-2 text-sm text-foreground">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        task {brief.taskId}
      </div>
      {brief.headings.map((h, i) => (
        <div key={`${h.title}-${i}`} className="flex flex-col gap-0.5">
          <div className="font-semibold">{h.title}</div>
          {h.bullets.length > 0 ? (
            <ul className="ml-4 list-disc text-[12px] text-foreground/90">
              {h.bullets.map((b, j) => (
                <li key={j}>{b}</li>
              ))}
            </ul>
          ) : null}
          {h.links.length > 0 ? (
            <div className="ml-4 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
              {h.links.map((l, j) => (
                <a
                  key={`${l.url}-${j}`}
                  href={l.url}
                  onClick={(e) => onLinkClick(e, l.url)}
                  className="text-[12px] text-primary underline-offset-2 hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {l.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
