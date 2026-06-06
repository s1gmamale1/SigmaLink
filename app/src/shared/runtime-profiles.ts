export type AgentRuntimeProfileId =
  | 'ruflo-core'
  | 'browser-tools'
  | 'security-tools'
  | 'full-tools';

export type McpServerId = 'ruflo' | 'browser' | 'sigmamemory' | 'security';

export interface AgentRuntimeProfile {
  id: AgentRuntimeProfileId;
  label: string;
  description: string;
  mcpAllowlist: readonly McpServerId[];
  enabled: boolean;
  mcpHeavy: boolean;
}

export const DEFAULT_AGENT_RUNTIME_PROFILE_ID: AgentRuntimeProfileId = 'ruflo-core';

export const AGENT_RUNTIME_PROFILES: readonly AgentRuntimeProfile[] = [
  {
    id: 'ruflo-core',
    label: 'Ruflo Core',
    description: 'Ruflo orchestration only. Default profile for normal agent panes.',
    mcpAllowlist: ['ruflo'],
    enabled: true,
    mcpHeavy: false,
  },
  {
    id: 'browser-tools',
    label: 'Browser Tools',
    description: 'Ruflo plus Browser MCP and SigmaMemory for lanes that need web/tool context.',
    mcpAllowlist: ['ruflo', 'browser', 'sigmamemory'],
    enabled: true,
    mcpHeavy: true,
  },
  {
    id: 'security-tools',
    label: 'Security Tools',
    description: 'Ruflo plus the security MCP lane. Use only for scans or security review panes.',
    mcpAllowlist: ['ruflo', 'security'],
    enabled: true,
    mcpHeavy: true,
  },
  {
    id: 'full-tools',
    label: 'Full Tools',
    description: 'Explicit escape hatch for Browser, SigmaMemory, and security MCP together.',
    mcpAllowlist: ['ruflo', 'browser', 'sigmamemory', 'security'],
    enabled: true,
    mcpHeavy: true,
  },
] as const;

const PROFILE_BY_ID = new Map<AgentRuntimeProfileId, AgentRuntimeProfile>(
  AGENT_RUNTIME_PROFILES.map((profile) => [profile.id, profile]),
);

export function normalizeAgentRuntimeProfileId(value: unknown): AgentRuntimeProfileId {
  if (
    value === 'ruflo-core' ||
    value === 'browser-tools' ||
    value === 'security-tools' ||
    value === 'full-tools'
  ) {
    return value;
  }
  return DEFAULT_AGENT_RUNTIME_PROFILE_ID;
}

export function getAgentRuntimeProfile(value: unknown): AgentRuntimeProfile {
  return PROFILE_BY_ID.get(normalizeAgentRuntimeProfileId(value)) ?? AGENT_RUNTIME_PROFILES[0];
}

export function profileAllowsMcp(profileId: unknown, serverId: McpServerId): boolean {
  const profile = getAgentRuntimeProfile(profileId);
  return profile.enabled && profile.mcpAllowlist.includes(serverId);
}

export function profileIsMcpHeavy(profileId: unknown): boolean {
  return getAgentRuntimeProfile(profileId).mcpHeavy;
}
