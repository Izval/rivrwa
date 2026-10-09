// server.ts — runs the `baw` CLI for River's agent Worker. One container instance serves one user (or one
// pending sign-in), and it keeps nothing: every request carries the user's session file (decrypted by the
// Worker), and every response returns the file as baw left it, so the Worker can re-encrypt and store it.
//
//   GET  /ping                                           health check for the container supervisor
//   POST /run     {instanceId, session, args}         -> {stdout, session}
//   POST /signin  {instanceId}                         -> baw auth signin output; starts `auth verify` in background
//   GET  /signin                                       -> {state: idle|pending|success|failed, error?, session?}
//   POST /egress  {url, method?, headers?, body?}      -> {status, contentType, body} for an allow-listed host
//
// `auth verify` blocks until the user confirms in the Binance App (≤ 5 min) and must not be killed early, so
// it runs here, inside the container, while the Worker polls GET /signin.
//
// /egress exists because Binance's Web3 API ("compliance restriction"), GeckoTerminal and the public BSC RPCs (429)
// refuse Workers' shared egress, while this container's egress gets through. It only reaches those data hosts.

import http from "node:http";
import fs from "node:fs";
import { execFile } from "node:child_process";

const DIR = "/tmp/baw";
const FILE = `${DIR}/session.json`;

type SigninState = { state: "idle" | "pending" | "success" | "failed"; error?: string; session?: string | null };
let signin: SigninState = { state: "idle" };
let queue: Promise<unknown> = Promise.resolve();
/** baw calls share one session dir, so they run one at a time. */
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const p = queue.then(f, f);
  queue = p.catch(() => {});
  return p;
};

function baw(args: string[], instanceId: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve) => {
    execFile("baw", args, {
      timeout: timeoutMs, maxBuffer: 4 << 20,
      env: { ...process.env, BINANCE_BAW_DIR: DIR, BINANCE_INSTANCE_ID: instanceId },
    }, (err, stdout, stderr) => {
      resolve(stdout.trim() ? stdout : JSON.stringify({ success: false, error: { code: "EXEC", name: "EXEC", message: (stderr || err?.message || "no output").slice(0, 500) } }));
    });
  });
}

const readSession = () => (fs.existsSync(FILE) ? fs.readFileSync(FILE).toString("base64") : null);
function writeSession(b64: string | null) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (b64) fs.writeFileSync(FILE, Buffer.from(b64, "base64"), { mode: 0o600 });
}

async function body<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

const send = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};

const EGRESS_HOSTS = new Set(["api.geckoterminal.com", "web3.binance.com", "bsc-dataseed.bnbchain.org", "bsc-rpc.publicnode.com"]);

const idOk = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(id);

http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/ping") return send(res, 200, { ok: true });

    if (req.method === "POST" && req.url === "/egress") {
      const b = await body<{ url: string; method?: string; headers?: Record<string, string>; body?: string }>(req);
      let u: URL;
      try { u = new URL(b.url); } catch { return send(res, 400, { error: "bad url" }); }
      if (u.protocol !== "https:" || !EGRESS_HOSTS.has(u.hostname)) return send(res, 403, { error: "host not allowed" });
      const r = await fetch(u, { method: b.method ?? "GET", headers: b.headers, body: b.body, signal: AbortSignal.timeout(30_000) });
      return send(res, 200, { status: r.status, contentType: r.headers.get("content-type"), body: await r.text() });
    }

    if (req.method === "POST" && req.url === "/run") {
      const b = await body<{ instanceId: string; session: string | null; args: string[] }>(req);
      if (!idOk(b.instanceId) || !Array.isArray(b.args) || !b.args.every((a) => typeof a === "string")) return send(res, 400, { error: "bad request" });
      const out = await serial(async () => {
        writeSession(b.session);
        const stdout = await baw(b.args, b.instanceId);
        return { stdout, session: readSession() };
      });
      return send(res, 200, out);
    }

    if (req.method === "POST" && req.url === "/signin") {
      const b = await body<{ instanceId: string }>(req);
      if (!idOk(b.instanceId)) return send(res, 400, { error: "bad request" });
      const stdout = await serial(async () => {
        writeSession(null);
        return baw(["auth", "signin", "--json"], b.instanceId);
      });
      const j = JSON.parse(stdout) as { success: boolean; data?: { qrCodeId?: string } };
      if (j.success && j.data?.qrCodeId) {
        signin = { state: "pending" };
        // Not serialized: verify must hold the dir while it waits, and nothing else runs on a pairing instance.
        baw(["auth", "verify", "--qrCodeId", j.data.qrCodeId, "--json"], b.instanceId, 330_000).then((out) => {
          const v = JSON.parse(out) as { success: boolean; error?: { message?: string } };
          signin = v.success ? { state: "success", session: readSession() } : { state: "failed", error: v.error?.message ?? "verify failed" };
        });
      }
      return send(res, 200, j);
    }

    if (req.method === "GET" && req.url === "/signin") return send(res, 200, signin);

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
}).listen(8080, () => console.log("baw runner on :8080"));
