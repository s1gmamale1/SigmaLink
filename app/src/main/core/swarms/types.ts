// Swarm Room — main-side type & preset definitions. The role enum and the
// composition tables live here so factory.ts and the renderer's PresetPicker
// stay aligned. The renderer imports the role-split numbers via a thin shape
// in shared/types.ts; this module is main-side only and may use Node APIs.

import { z } from 'zod';
import type { Role, SwarmPreset, SwarmMessageKind } from '../../../shared/types';

export type { Role, SwarmPreset };

// ──────────────────────────────────────────────────────────────────────────
// V3 Mailbox envelope kinds & per-kind zod payload schemas
// (V3-W12-016) Source: docs/02-research/v3-protocol-delta.md §1, §2.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Union of every envelope kind a SwarmMailbox row may carry. The legacy
 * SIGMA::* verbs from `SwarmMessageKind` (SAY/ACK/STATUS/DONE/...) remain in
 * use on the PTY wire; the new V3 kinds below are first-class envelope kinds
 * that drive Operator Console counters and surface-specific renderers.
 */
export type MailboxKind =
  | SwarmMessageKind
  | 'escalation'
  | 'review_request'
  | 'quiet_tick'
  | 'error_report'
  | 'task_brief'
  | 'board_post'
  | 'bridge_dispatch'
  | 'design_dispatch'
  | 'skill_toggle'
  | 'directive';

/** Group selectors usable as an envelope recipient. */
export type MailboxRecipientGroup =
  | '@all'
  | '@coordinators'
  | '@builders'
  | '@scouts'
  | '@reviewers';

/** A recipient is either a group selector, the legacy `'*'`, or an agentKey. */
export type MailboxRecipient = MailboxRecipientGroup | '*' | string;

/**
 * Envelope schema shared by every kind. `payload` is validated separately by
 * `MAILBOX_PAYLOAD_SCHEMAS[kind]` so callers can keep storing per-kind shapes
 * while the wire-level row schema stays uniform.
 */
export interface MailboxEnvelope {
  swarmId: string;
  fromAgent: string; // 'operator' | agentKey | external producer id
  toAgent: MailboxRecipient;
  kind: MailboxKind;
  body: string;
  payload?: Record<string, unknown>;
  /**
   * `directive` envelopes only — when set to `'pane'`, the target agent's
   * PTY stdin receives `[Operator → <Role> <N>] <body>\n`. The mailbox row
   * is persisted regardless. (V3-W13-009 wires the pane echo.)
   */
  echo?: 'pane';
}

// Per-kind payload schemas. Schemas are intentionally permissive on optional
// fields so renderer / coordinator code can extend without a migration.
const escalationPayload = z.object({
  taskId: z.string(),
  blockedOn: z.string(),
  attempts: z.number().int().nonnegative(),
  askingOf: z.string(),
});

const reviewRequestPayload = z.object({
  taskId: z.string(),
  branch: z.string(),
  files: z.array(z.string()),
  summary: z.string(),
});

const quietTickPayload = z.object({
  since: z.number().int().nonnegative(),
  lastActivityKind: z.string().optional(),
});

const errorReportPayload = z.object({
  kind: z.enum(['spawn', 'runtime', 'validate']),
  message: z.string(),
  stderrTail: z.string().optional(),
});

const taskBriefHeading = z.object({
  title: z.string(),
  bullets: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
});

const taskBriefPayload = z.object({
  taskId: z.string(),
  urgency: z.enum(['low', 'normal', 'urgent']).default('normal'),
  headings: z.array(taskBriefHeading),
});

const boardPostPayload = z.object({
  boardId: z.string(),
  title: z.string(),
  bodyMd: z.string(),
  attachments: z.array(z.string()).optional(),
});

const bridgeDispatchPayload = z.object({
  conversationId: z.string().optional(),
  targetSessionId: z.string(),
  prompt: z.string(),
  attachments: z.array(z.string()).optional(),
});

const designDispatchPayload = z.object({
  pickerToken: z.string(),
  prompt: z.string(),
  providers: z.array(z.string()),
  modifiers: z
    .object({ shift: z.boolean().optional(), alt: z.boolean().optional() })
    .optional(),
  attachments: z.array(z.string()).optional(),
});

const skillTogglePayload = z.object({
  skillKey: z.string(),
  on: z.boolean(),
  group: z.enum(['workflow', 'quality', 'ops', 'analysis']),
});

const directivePayload = z.object({
  directive: z.string(),
  // Free-form context map used by Operator → agent DMs.
  meta: z.record(z.string(), z.unknown()).optional(),
});

const looseRecord = z.record(z.string(), z.unknown());

/**
 * Per-kind payload schema map. Use `.parse()` (throws) at the trust boundary
 * and `.safeParse()` for soft validation in renderers / counters.
 */
export const MAILBOX_PAYLOAD_SCHEMAS: Record<MailboxKind, z.ZodTypeAny> = {
  // Legacy SIGMA::* verbs — payload is opaque, parsers already validate.
  SAY: looseRecord,
  ACK: looseRecord,
  STATUS: looseRecord,
  DONE: looseRecord,
  OPERATOR: looseRecord,
  ROLLCALL: looseRecord,
  ROLLCALL_REPLY: looseRecord,
  SYSTEM: looseRecord,
  // V3 first-class kinds.
  escalation: escalationPayload,
  review_request: reviewRequestPayload,
  quiet_tick: quietTickPayload,
  error_report: errorReportPayload,
  task_brief: taskBriefPayload,
  board_post: boardPostPayload,
  bridge_dispatch: bridgeDispatchPayload,
  design_dispatch: designDispatchPayload,
  skill_toggle: skillTogglePayload,
  directive: directivePayload,
};

/**
 * V3 envelope kinds that should drive the four Operator Console counters
 * (V3-W12-014). All other kinds are excluded from the badge projection.
 */
export const COUNTED_MAILBOX_KINDS = new Set<MailboxKind>([
  'escalation',
  'review_request',
  'quiet_tick',
  'error_report',
]);

const RECIPIENT_GROUPS = new Set<MailboxRecipientGroup>([
  '@all',
  '@coordinators',
  '@builders',
  '@scouts',
  '@reviewers',
]);

/** Coerce a recipient string into a typed `MailboxRecipient`. Never throws. */
export function parseRecipient(raw: string): MailboxRecipient {
  if (raw === '*') return '*';
  if (RECIPIENT_GROUPS.has(raw as MailboxRecipientGroup)) {
    return raw as MailboxRecipientGroup;
  }
  return raw;
}

/** Soft-validate a payload for a given kind. Returns parsed payload or null. */
export function validateMailboxPayload(
  kind: MailboxKind,
  payload: unknown,
): Record<string, unknown> | null {
  const schema = MAILBOX_PAYLOAD_SCHEMAS[kind];
  if (!schema) return null;
  const result = schema.safeParse(payload ?? {});
  return result.success ? (result.data as Record<string, unknown>) : null;
}

export interface RolesPerPreset {
  coordinator: number;
  builder: number;
  scout: number;
  reviewer: number;
}

/**
 * Roster split per preset. Sources: PRODUCT_SPEC.md §5.2 +
 * docs/02-research/v3-agent-roles-delta.md §2.
 * V3-W12-009: Legion → Battalion rename. V3 totals: 5 / 10 / 15 / 20.
 * Legion (50) retained for read-only loading of historical rows; new swarms
 * must select Battalion or another canonical V3 preset.
 */
export const PRESET_ROSTER: Record<Exclude<SwarmPreset, 'custom'>, RolesPerPreset> = {
  squad: { coordinator: 1, builder: 2, scout: 1, reviewer: 1 },
  team: { coordinator: 2, builder: 5, scout: 2, reviewer: 1 },
  platoon: { coordinator: 2, builder: 7, scout: 3, reviewer: 3 },
  // [INFERRED] Battalion split — V3 chip never expanded; extrapolated from
  // Platoon ratios (frames 0184/0185).
  battalion: { coordinator: 3, builder: 11, scout: 3, reviewer: 3 },
  // Legacy 50-agent preset kept so DB rows from pre-V3 swarms still load.
  legion: { coordinator: 4, builder: 30, scout: 10, reviewer: 6 },
};

/** Per-role default provider when the operator didn't pick one. */
export const DEFAULT_PROVIDER_BY_ROLE: Record<Role, string> = {
  coordinator: 'codex',
  builder: 'claude',
  scout: 'gemini',
  reviewer: 'codex',
};

export const ROLE_ORDER: Role[] = ['coordinator', 'builder', 'scout', 'reviewer'];

export function totalForPreset(preset: SwarmPreset): number {
  if (preset === 'custom') return 0;
  const r = PRESET_ROSTER[preset];
  return r.coordinator + r.builder + r.scout + r.reviewer;
}

/**
 * Build the default roster (one RoleAssignment per agent) for a preset using
 * the per-role default providers. Used as a starting point for the UI; the
 * operator can override each row before launching.
 */
export function defaultRoster(preset: SwarmPreset): {
  role: Role;
  roleIndex: number;
  providerId: string;
}[] {
  if (preset === 'custom') return [];
  const split = PRESET_ROSTER[preset];
  const roster: { role: Role; roleIndex: number; providerId: string }[] = [];
  for (const role of ROLE_ORDER) {
    const count = split[role];
    for (let i = 1; i <= count; i++) {
      roster.push({ role, roleIndex: i, providerId: DEFAULT_PROVIDER_BY_ROLE[role] });
    }
  }
  return roster;
}

/** "coordinator-1", "builder-7", etc. */
export function agentKey(role: Role, roleIndex: number): string {
  return `${role}-${roleIndex}`;
}
