// mcp.ts — the Model Context Protocol transport for River's tools (`POST /mcp` on api.rivrwa.com).
//
// Stateless JSON-RPC 2.0 over Streamable HTTP, answered with one JSON object per request: every tool resolves in
// one round trip, so there are no server-initiated messages, no SSE and no `Mcp-Session-Id` (omitting it is how a
// server says "no sessions").
//
// The tools themselves live in index.ts, next to the signal cache they read. A paid tool throws `PaymentRequired`;
// the client gets the x402 requirements back as a tool error, pays from its own wallet, and calls again with the
// payment in the `payment` argument. River never holds a caller's key.

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

/** A tool's answer when the call needs an x402 payment first; `body` is the same JSON a 402 carries. */
export class PaymentRequired extends Error {
  readonly body: unknown;
  constructor(body: unknown) {
    super("payment_required");
    this.body = body;
  }
}

export class InvalidParams extends Error {}

const LATEST = "2025-06-18";
const SUPPORTED = new Set(["2024-11-05", "2025-03-26", LATEST]);

type Id = string | number | null;

export async function handleMcp(req: Request, tools: McpTool[], headers: Record<string, string>, instructions: string): Promise<Response> {
  const hv = req.headers.get("MCP-Protocol-Version");
  let version = hv && SUPPORTED.has(hv) ? hv : "2025-03-26";
  const send = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "MCP-Protocol-Version": version, ...headers } });
  const ok = (id: Id, result: unknown) => send({ jsonrpc: "2.0", id, result });
  const err = (id: Id, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { Allow: "POST", ...headers } });
  let m: { id?: Id; method?: string; params?: Record<string, unknown> };
  try { m = await req.json(); } catch { return err(null, -32700, "Parse error"); }
  const id = m.id ?? null;
  if (m.method?.startsWith("notifications/")) return new Response(null, { status: 202, headers });

  switch (m.method) {
    case "initialize": {
      const asked = m.params?.protocolVersion as string | undefined;
      version = asked && SUPPORTED.has(asked) ? asked : LATEST;
      return ok(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "river", version: "1.0.0" }, instructions });
    }
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === m.params?.name);
      if (!tool) return err(id, -32602, `Unknown tool: ${String(m.params?.name)}`);
      try {
        const out = await tool.run((m.params?.arguments ?? {}) as Record<string, unknown>);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out });
      } catch (e) {
        if (e instanceof PaymentRequired) return ok(id, { isError: true, content: [{ type: "text", text: JSON.stringify(e.body) }], structuredContent: e.body });
        if (e instanceof InvalidParams) return err(id, -32602, `Invalid params: ${e.message}`);
        return ok(id, { isError: true, content: [{ type: "text", text: (e as Error).message }] });
      }
    }
    default: return err(id, -32601, `Method not found: ${m.method ?? "(none)"}`);
  }
}
