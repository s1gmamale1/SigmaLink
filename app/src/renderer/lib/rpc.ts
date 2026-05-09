// Renderer-side RPC client. Wraps window.sigma.invoke with channel-name routing
// and unwraps the {ok,data,error} envelope into a normal Promise.

import type { RpcResult } from '@/shared/rpc';
import type { AppRouter } from '@/shared/router-shape';

async function invokeChannel(channel: string, ...args: unknown[]): Promise<unknown> {
  if (!('sigma' in window)) {
    throw new Error('Preload bridge missing — restart the app.');
  }
  const env = (await window.sigma.invoke(channel, ...args)) as RpcResult<unknown>;
  if (!env || typeof env !== 'object') {
    throw new Error(`Bad RPC response from ${channel}`);
  }
  if ('ok' in env && env.ok) return env.data;
  if ('ok' in env && !env.ok) throw new Error(env.error || `${channel} failed`);
  return env;
}

type AnyClient = {
  [NS in keyof AppRouter]: {
    [K in keyof AppRouter[NS]]: AppRouter[NS][K] extends (...a: infer A) => infer X
      ? (...a: A) => Promise<Awaited<X>>
      : never;
  };
};

function buildClient(): AnyClient {
  const cache = new Map<string, unknown>();
  return new Proxy({} as AnyClient, {
    get(_t, ns: string) {
      const cached = cache.get(ns);
      if (cached) return cached;
      const nsObj = new Proxy(
        {},
        {
          get: (_t2, key: string) => {
            return (...args: unknown[]) => invokeChannel(`${ns}.${String(key)}`, ...args);
          },
        },
      );
      cache.set(ns, nsObj);
      return nsObj;
    },
  });
}

export const rpc = buildClient();

export function onEvent<T = unknown>(name: string, cb: (payload: T) => void): () => void {
  return window.sigma.eventOn(name, (p) => cb(p as T));
}
