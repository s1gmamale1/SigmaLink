// V3-W15-005 — Plan-gating capability matrix.
//
// SigmaLink is a local-only/free fork of BridgeMind. The user pays nothing,
// runs the app on their own hardware, and never talks to a billing surface.
// **Default tier is `'ultra'` so every affordance is enabled out of the box**;
// this module exists purely as forward-compat scaffolding so the codebase can
// later sync with BridgeMind's tier matrix if SigmaLink ever adopts a hosted
// model.
//
// Frames 0500 / 0510 of the V3 frame log show three pricing tiles
// (Basic / Pro / Ultra). The numbers below mirror those tiles. Renderers
// should read capabilities through `app.tier()` + the renderer-side
// `canDo()` helper rather than importing this file directly, but the matrix
// is also safe to import from main-process code (see
// `assistant.dispatchPane`, swarm factory, etc.).

/** The three SigmaLink/BridgeMind plan tiers. */
export type Tier = 'basic' | 'pro' | 'ultra';

/**
 * Plan-gated affordances. Adding a new capability:
 *   1. Append the literal here.
 *   2. Add a value for every tier in `CAPABILITIES_BY_TIER`.
 *   3. Add a corresponding entry in `CAP_VALUE_TYPES` if you want callers
 *      to use `getCapability<number>(...)` without manual casts.
 */
export type Capability =
  | 'swarm.maxSize'
  | 'bridgemcp.slotCount'
  | 'bridgevoice.enabled'
  | 'sigmavoice.enabled'
  | 'bridgejarvis.enabled'
  | 'canvas.enabled';

/** Strongly typed value union. Helps IDE inference at call sites. */
export type CapabilityValue = number | boolean;

/**
 * Tier × capability matrix. Numbers come from frames 0500/0510:
 *   - swarm.maxSize:       basic=5, pro=15, ultra=20 (matches V3 pricing tiles)
 *   - bridgemcp.slotCount: basic=1, pro=10, ultra=999 (effectively unlimited)
 *   - bridgevoice.enabled: pro+ only
 *   - bridgejarvis.enabled: ultra only
 *   - canvas.enabled:      pro+ only
 */
export const CAPABILITIES_BY_TIER: Record<Tier, Record<Capability, CapabilityValue>> = {
  basic: {
    'swarm.maxSize': 5,
    'bridgemcp.slotCount': 1,
    'bridgevoice.enabled': false,
    'sigmavoice.enabled': false,
    'bridgejarvis.enabled': false,
    'canvas.enabled': false,
  },
  pro: {
    'swarm.maxSize': 15,
    'bridgemcp.slotCount': 10,
    'bridgevoice.enabled': true,
    'sigmavoice.enabled': true,
    'bridgejarvis.enabled': false,
    'canvas.enabled': true,
  },
  ultra: {
    'swarm.maxSize': 20,
    'bridgemcp.slotCount': 999,
    'bridgevoice.enabled': true,
    'sigmavoice.enabled': true,
    'bridgejarvis.enabled': true,
    'canvas.enabled': true,
  },
};

/**
 * SigmaLink default tier. Local-only / free; everything is on. Production
 * builds never expose the override (see AppearanceTab) so end users always
 * see Ultra; the override exists for QA/dev flag-flip scenarios only.
 */
export const DEFAULT_TIER: Tier = 'ultra';

/** kv key used to persist the (optional) tier override. */
export const KV_PLAN_TIER = 'plan.tier';

const TIERS: ReadonlySet<Tier> = new Set(['basic', 'pro', 'ultra']);

/** Narrow an opaque kv string into a `Tier`, falling back to `DEFAULT_TIER`. */
export function parseTier(raw: string | null | undefined): Tier {
  if (raw && TIERS.has(raw as Tier)) return raw as Tier;
  return DEFAULT_TIER;
}

/**
 * Read the value for a capability under the given tier. Generic so call sites
 * can document the expected runtime type without casts:
 *   const max = getCapability<number>('ultra', 'swarm.maxSize');
 *   const voice = getCapability<boolean>(tier, 'bridgevoice.enabled');
 *
 * Never throws — if a row is missing (which would be a programmer error), the
 * Ultra value is returned as a permissive fallback.
 */
export function getCapability<T extends CapabilityValue = CapabilityValue>(
  tier: Tier,
  cap: Capability,
): T {
  const row = CAPABILITIES_BY_TIER[tier] ?? CAPABILITIES_BY_TIER[DEFAULT_TIER];
  const v = row[cap];
  if (v === undefined) {
    return CAPABILITIES_BY_TIER[DEFAULT_TIER][cap] as T;
  }
  return v as T;
}
