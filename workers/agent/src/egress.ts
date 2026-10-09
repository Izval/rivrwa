// egress.ts — a fetch that leaves through the baw container instead of the Worker. Binance's Web3 API refuses
// Workers' egress ("compliance restriction"); GeckoTerminal and the public BSC RPCs rate-limit it (429). The
// container gets through all of them.
// One shared instance ("egress") serves every caller, apart from the per-user baw instances. If the container
// cannot be reached (local dev without it), the request goes out directly.

/** Any Durable Object namespace whose class serves the container's HTTP API (only fetch is used). */
export interface EgressNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(req: Request): Promise<Response> };
}

export function egressFetch(ns: EgressNamespace | undefined): typeof fetch {
  if (!ns) return fetch;
  return async (input, init) => {
    const req = new Request(input, init);
    try {
      const stub = ns.get(ns.idFromName("egress"));
      const r = await stub.fetch(new Request("http://baw/egress", {
        method: "POST",
        body: JSON.stringify({
          url: req.url, method: req.method, headers: Object.fromEntries(req.headers),
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.clone().text(),
        }),
      }));
      if (!r.ok) throw new Error(`egress HTTP ${r.status}`);
      const o = (await r.json()) as { status: number; contentType: string | null; body: string };
      return new Response(o.body, { status: o.status, headers: { "content-type": o.contentType ?? "application/json" } });
    } catch (e) {
      console.warn(`egress via container failed, going direct: ${(e as Error).message}`);
      return fetch(req);
    }
  };
}

/** BSC reads for the runner and the checklist: public RPCs rate-limit Workers' shared egress, the container's gets through. */
export const rpcOpts = (env: { BSC_RPC_URL?: string; BAW?: EgressNamespace }) => ({ url: env.BSC_RPC_URL || undefined, fetchImpl: egressFetch(env.BAW) });
