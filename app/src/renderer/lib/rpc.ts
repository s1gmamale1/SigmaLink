// Renderer-side RPC client. Wraps window.sigma.invoke with channel-name routing
// and unwraps the {ok,data,error} envelope into a normal Promise.

import { toast } from 'sonner';
import type { RpcResult } from '@/shared/rpc';
import type { AppRouter } from '@/shared/router-shape';

async function invokeChannel(
  channel: string,
  silent: boolean,
  ...args: unknown[]
): Promise<unknown> {
  if (!('sigma' in window)) {
    throw new Error('Preload bridge missing — restart the app.');
  }
  const env = (await window.sigma.invoke(channel, ...args)) as RpcResult<unknown>;
  if (!env || typeof env !== 'object') {
    const msg = `Bad RPC response from ${channel}`;
    if (!silent) showRpcErrorToast(channel, msg);
    throw new Error(msg);
  }
  if ('ok' in env && env.ok) return env.data;
  if ('ok' in env && !env.ok) {
    const msg = env.error || `${channel} failed`;
    if (!silent) showRpcErrorToast(channel, msg);
    throw new Error(msg);
  }
  return env;
}

function showRpcErrorToast(channel: string, message: string): void {
  // The toast surface is mounted at the app root via <Toaster /> in App.tsx.
  // We deliberately fire-and-forget — sonner deduplicates by id when callers
  // pass the same id, but for unhandled RPC errors we want each to be visible.
  try {
    toast.error(message, { description: channel });
  } catch {
    // Toaster not mounted yet (very early in boot) — silently drop. The
    // rejection still propagates to the caller via the throw below.
  }
}

type AnyClient = {
  [NS in keyof AppRouter]: {
    [K in keyof AppRouter[NS]]: AppRouter[NS][K] extends (...a: infer A) => infer X
      ? (...a: A) => Promise<Awaited<X>>
      : never;
  };
};

function buildClient(silent: boolean): AnyClient {
  const cache = new Map<string, unknown>();
  return new Proxy({} as AnyClient, {
    get(_t, ns: string) {
      const cached = cache.get(ns);
      if (cached) return cached;
      const nsObj = new Proxy(
        {},
        {
          get: (_t2, key: string) => {
            return (...args: unknown[]) =>
              invokeChannel(`${ns}.${String(key)}`, silent, ...args);
          },
        },
      );
      cache.set(ns, nsObj);
      return nsObj;
    },
  });
}

export const rpc = buildClient(false);
/**
 * Identical to `rpc` but never raises a global toast on rejection. Use for
 * probe loops, optional fetches, or any call site where the caller already
 * shows local feedback. The rejection still propagates so existing
 * `try/catch` paths see it.
 */
export const rpcSilent = buildClient(true);

export function onEvent<T = unknown>(name: string, cb: (payload: T) => void): () => void {
  return window.sigma.eventOn(name, (p) => cb(p as T));
}
