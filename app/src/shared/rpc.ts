// Typed Proxy-based RPC bridge between main and renderer.
// Channel naming: "<namespace>.<method>"; one ipcMain.handle per pair.
// Renderer uses createRpcClient<Router>() to get an end-to-end typed proxy.

export type RpcProcedureMap = Record<string, (...args: any[]) => unknown>;
export type RpcRouterShape = Record<string, RpcProcedureMap>;

export type RpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type RpcClient<R extends RpcRouterShape> = {
  [NS in keyof R]: {
    [K in keyof R[NS]]: R[NS][K] extends (...a: infer A) => infer X
      ? (...a: A) => Promise<Awaited<X>>
      : never;
  };
};

export function defineController<T extends RpcProcedureMap>(handlers: T): T {
  return handlers;
}

export function defineRouter<T extends RpcRouterShape>(routers: T): T {
  return routers;
}

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createRpcClient<R extends RpcRouterShape>(invoke: Invoker): RpcClient<R> {
  const cache = new Map<string, unknown>();
  const root = new Proxy({} as RpcClient<R>, {
    get(_t, ns: string) {
      let nsObj = cache.get(ns);
      if (nsObj) return nsObj;
      nsObj = new Proxy({} as Record<string, unknown>, {
        get: (_t2, key: string) => {
          return (...args: unknown[]) => invoke(`${ns}.${String(key)}`, ...args);
        },
      });
      cache.set(ns, nsObj);
      return nsObj;
    },
  });
  return root;
}
