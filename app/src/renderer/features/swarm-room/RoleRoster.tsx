import type { Role, RoleAssignment, SwarmAgent } from '@/shared/types';

const ROLE_LABEL: Record<Role, string> = {
  coordinator: 'Coordinator',
  builder: 'Builder',
  scout: 'Scout',
  reviewer: 'Reviewer',
};

const ROLE_COLOR: Record<Role, string> = {
  coordinator: '#A78BFA',
  builder: '#22C55E',
  scout: '#38BDF8',
  reviewer: '#F59E0B',
};

interface ProviderOption {
  id: string;
  name: string;
}

interface Props {
  roster: RoleAssignment[];
  providers: ProviderOption[];
  onChange: (next: RoleAssignment[]) => void;
  readOnly?: boolean;
  liveAgents?: SwarmAgent[];
  messageCounts?: Record<string, number>;
}

export function RoleRoster({
  roster,
  providers,
  onChange,
  readOnly,
  liveAgents,
  messageCounts,
}: Props) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
      {roster.map((row, idx) => {
        const live = liveAgents?.find(
          (a) => a.role === row.role && a.roleIndex === row.roleIndex,
        );
        const agentKey = `${row.role}-${row.roleIndex}`;
        const status = live?.status ?? 'idle';
        const dot =
          status === 'error'
            ? '#ef4444'
            : status === 'busy'
              ? '#22c55e'
              : status === 'blocked'
                ? '#f59e0b'
                : status === 'done'
                  ? '#0ea5e9'
                  : '#71717a';
        return (
          <div
            key={`${row.role}-${row.roleIndex}`}
            className="flex flex-col gap-2 rounded-lg border border-border bg-card/60 p-3"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: ROLE_COLOR[row.role] }}
              />
              <div className="text-sm font-medium">
                {ROLE_LABEL[row.role]} {row.roleIndex}
              </div>
              <div className="ml-auto flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
                {status}
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Provider</span>
              <select
                value={row.providerId}
                disabled={readOnly}
                onChange={(e) => {
                  const next = roster.map((r, i) =>
                    i === idx ? { ...r, providerId: e.target.value } : r,
                  );
                  onChange(next);
                }}
                className="ml-auto rounded-md border border-border bg-background px-2 py-1 text-xs"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span title="Mailbox identifier">{agentKey}</span>
              {messageCounts ? (
                <span>{messageCounts[agentKey] ?? 0} msgs</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
