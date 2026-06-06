export const RAM_BRAKE_ERROR_PREFIX = 'RAM_BRAKE_ADMISSION ';

export interface RamBrakeAdmissionDetails {
  kind: 'ram-brake-admission';
  caps: {
    maxTotalLiveAgents: number;
    maxWorkspaceLiveAgents: number;
    maxTotalMcpHeavyAgents: number;
    maxWorkspaceMcpHeavyAgents: number;
  };
  current: {
    totalLiveAgents: number;
    workspaceLiveAgents: number;
    totalMcpHeavyAgents: number;
    workspaceMcpHeavyAgents: number;
  };
  requested: {
    totalAgents: number;
    mcpHeavyAgents: number;
  };
  projected: {
    totalLiveAgents: number;
    workspaceLiveAgents: number;
    totalMcpHeavyAgents: number;
    workspaceMcpHeavyAgents: number;
  };
  violations: Array<'total' | 'workspace' | 'total-heavy' | 'workspace-heavy'>;
}

export function parseRamBrakeAdmissionError(value: unknown): RamBrakeAdmissionDetails | null {
  const message = value instanceof Error ? value.message : String(value);
  const idx = message.indexOf(RAM_BRAKE_ERROR_PREFIX);
  if (idx < 0) return null;
  const raw = message.slice(idx + RAM_BRAKE_ERROR_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw) as Partial<RamBrakeAdmissionDetails>;
    if (parsed.kind !== 'ram-brake-admission') return null;
    if (!Array.isArray(parsed.violations)) return null;
    if (!parsed.caps || !parsed.current || !parsed.requested || !parsed.projected) return null;
    return parsed as RamBrakeAdmissionDetails;
  } catch {
    return null;
  }
}

export function summarizeRamBrakeAdmission(details: RamBrakeAdmissionDetails): string {
  const parts = [
    `${details.projected.totalLiveAgents}/${details.caps.maxTotalLiveAgents} total`,
    `${details.projected.workspaceLiveAgents}/${details.caps.maxWorkspaceLiveAgents} workspace`,
  ];
  if (details.requested.mcpHeavyAgents > 0 || details.projected.totalMcpHeavyAgents > 0) {
    parts.push(
      `${details.projected.totalMcpHeavyAgents}/${details.caps.maxTotalMcpHeavyAgents} heavy`,
      `${details.projected.workspaceMcpHeavyAgents}/${details.caps.maxWorkspaceMcpHeavyAgents} workspace heavy`,
    );
  }
  return parts.join(' · ');
}
