// V3-W15-005 — Renderer-side capability-gate helper.
//
// Wraps `kv['plan.tier']` so any renderer-side feature gate can read its
// allowance synchronously (after a one-time async warm-up).
//
// SigmaLink defaults to `'ultra'` since the user runs the app locally and
// pays nothing — every gated affordance is enabled by default. The tier
// override exists in Settings → Appearance behind a dev-only "Show advanced"
// toggle so QA can flip the matrix without a billing surface.
//
// Usage:
//   import { canDo, useCanDo, useTier } from '@/renderer/lib/canDo';
//
//   // Synchronous read after the cache warms — safe in any render path.
//   const max = canDo<number>('swarm.maxSize');
//
//   // React-hook variant that re-renders if the override changes.
//   const voiceOn = useCanDo<boolean>('bridgevoice.enabled');
//
// The helper warm-loads the tier on import. While the load is in flight the
// cached value is `DEFAULT_TIER` ('ultra'), so the worst case is "everything
// looks enabled for one render tick" — which is what we want anyway since
// SigmaLink ships with everything enabled.

import { useEffect, useState } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import {
  CAPABILITIES_BY_TIER,
  DEFAULT_TIER,
  KV_PLAN_TIER,
  parseTier,
  type Capability,
  type CapabilityValue,
  type Tier,
} from '@/main/core/plan/capabilities';

let cachedTier: Tier = DEFAULT_TIER;
let warmupPromise: Promise<Tier> | null = null;

const subscribers = new Set<(tier: Tier) => void>();

function notifySubscribers(tier: Tier): void {
  for (const fn of subscribers) {
    try {
      fn(tier);
    } catch {
      /* never let one bad subscriber break the rest */
    }
  }
}

async function loadTier(): Promise<Tier> {
  try {
    const raw = await rpcSilent.kv.get(KV_PLAN_TIER);
    return parseTier(raw);
  } catch {
    return DEFAULT_TIER;
  }
}

/** Lazy warm-up: fires once on first call, memoises the in-flight Promise. */
function warmupTier(): Promise<Tier> {
  if (!warmupPromise) {
    warmupPromise = loadTier().then((t) => {
      cachedTier = t;
      notifySubscribers(t);
      return t;
    });
  }
  return warmupPromise;
}

/**
 * Force a re-fetch of the tier from kv. Called by the Settings override UI
 * so capability reads pick up the new value without a full reload.
 */
export async function refreshTier(): Promise<Tier> {
  const t = await loadTier();
  cachedTier = t;
  warmupPromise = Promise.resolve(t);
  notifySubscribers(t);
  return t;
}

/**
 * Synchronous capability read. Returns the value for the **currently cached**
 * tier — call sites that mount before the warm-up resolves see `DEFAULT_TIER`
 * (Ultra), which is correct for SigmaLink. Pair with `useCanDo` if a render
 * needs to react to override changes.
 */
export function canDo<T extends CapabilityValue = CapabilityValue>(cap: Capability): T {
  // Trigger warm-up but don't await — the cached value is correct enough.
  void warmupTier();
  const row = CAPABILITIES_BY_TIER[cachedTier] ?? CAPABILITIES_BY_TIER[DEFAULT_TIER];
  const v = row[cap];
  if (v === undefined) {
    return CAPABILITIES_BY_TIER[DEFAULT_TIER][cap] as T;
  }
  return v as T;
}

/** React hook variant of `canDo` that re-renders when the override changes. */
export function useCanDo<T extends CapabilityValue = CapabilityValue>(cap: Capability): T {
  const [, setBump] = useState(0);
  useEffect(() => {
    const bump = () => setBump((n) => n + 1);
    subscribers.add(bump);
    void warmupTier().then(() => bump());
    return () => {
      subscribers.delete(bump);
    };
  }, []);
  return canDo<T>(cap);
}

/** React hook returning the current resolved `Tier`. */
export function useTier(): Tier {
  const [tier, setTier] = useState<Tier>(cachedTier);
  useEffect(() => {
    const sub = (t: Tier) => setTier(t);
    subscribers.add(sub);
    void warmupTier().then((t) => setTier(t));
    return () => {
      subscribers.delete(sub);
    };
  }, []);
  return tier;
}

/** Synchronous read of the cached tier, primarily for non-React call sites. */
export function getCachedTier(): Tier {
  return cachedTier;
}
