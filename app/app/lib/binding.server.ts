// binding.server.ts — call another River Worker. In production the service binding is the only path (the agent has
// no public URL). In local dev a binding whose Worker is not running answers 503, so the call falls back to a URL.

export async function callWorker(binding: Fetcher | undefined, baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  if (binding) {
    try {
      const res = await binding.fetch(new Request(`https://internal${path}`, init));
      if (res.status !== 503 || !baseUrl) return res;
    } catch (e) {
      if (!baseUrl) throw e;
    }
  }
  if (!baseUrl) throw new Error(`no route to ${path}: binding missing and no URL configured`);
  return fetch(baseUrl.replace(/\/+$/, "") + path, init);
}
