// main.ts — River agent CLI. One process runs one mandate from the machine where the signer is signed in.
//
//   node agent/src/main.ts status   --mandate agent/mandates/nvdab.json [--at <iso>]
//                                   read-only: signal, wallet, session and the next action (as of --at, if given)
//   node agent/src/main.ts tick     --mandate … [--dry-run]               one step (dry-run previews, never sends)
//   node agent/src/main.ts run      --mandate … [--dry-run] [--interval 300]   tick forever
//   node agent/src/main.ts exit-now --mandate …                           remove the open position now
//   node agent/src/main.ts resume   --mandate …                           clear a halt after checking by hand

import { parseArgs } from "node:util";
import {
  ASSETS, computeSignal, fetchOhlcv, fillGaps, poolState, erc20Balance, getReceipt, BSC_RPC, USDT, type Candle, type StreamAsset,
} from "../../packages/core/src/index.ts";
import fs from "node:fs";
import { AgenticWalletSigner } from "./agentic-wallet.ts";
import { execBaw } from "./exec-baw.ts";
import { parseMandate, type MandateFile } from "./mandate.ts";
import { fileStore } from "./file-store.ts";
import { tick, type Deps, type RunConfig, type TickOutcome } from "./runner.ts";
import type { Signer } from "./signer.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    mandate: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    interval: { type: "string", default: "300" },
    at: { type: "string" },
    "state-dir": { type: "string", default: new URL("../state/", import.meta.url).pathname },
    rpc: { type: "string", default: process.env.BSC_RPC_URL ?? BSC_RPC },
  },
});
const cmd = positionals[0] ?? "status";
if (!values.mandate || !["status", "tick", "run", "exit-now", "resume"].includes(cmd)) {
  console.error("usage: main.ts <status|tick|run|exit-now|resume> --mandate <file.json> [--dry-run] [--interval <s>]");
  process.exit(2);
}

// The live registry (auto-enabled stocks included) from the public API; the pinned seed if it cannot be reached.
async function registry(): Promise<readonly StreamAsset[]> {
  const url = process.env.RIVER_API_URL ?? "https://api.rivrwa.com";
  try {
    const r = await fetch(`${url}/v1/assets`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) return ((await r.json()) as { assets: StreamAsset[] }).assets;
  } catch { /* offline: use the seed */ }
  return ASSETS;
}

const loaded = parseMandate(JSON.parse(fs.readFileSync(values.mandate, "utf8")) as MandateFile, await registry());
const { mandate } = loaded;
const log = (line: string) => console.log(`${new Date().toISOString().slice(0, 19)}Z ${line}`);

function makeSigner(kind: string): Signer {
  if (kind === "agentic_wallet") return new AgenticWalletSigner(execBaw(process.env.BAW_BIN ?? "baw"));
  throw new Error(`signer ${kind} runs only in the agent Worker (flow B: workers/agent/src/altana.ts), not in the CLI`);
}

// Hourly candles change once an hour; refetching every tick would only burn GeckoTerminal's rate limit.
let candleCache: { at: number; data: Candle[] } | null = null;
async function candles(a: StreamAsset): Promise<Candle[]> {
  if (candleCache && Date.now() - candleCache.at < 15 * 60_000) return candleCache.data;
  const data = fillGaps(await fetchOhlcv(a.pool, a.token, "1h", 1000), 3600);
  candleCache = { at: Date.now(), data };
  return data;
}

const rpc = { url: values.rpc };
const store = fileStore(values["state-dir"]!, `${mandate.asset}-${mandate.owner}`);
const deps: Deps = {
  signer: makeSigner(loaded.signer),
  store,
  now: Date.now,
  log,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  candles,
  pool: (a) => poolState(a.pool, a, rpc),
  balance: (token, owner) => erc20Balance(token, owner, rpc),
  receipt: (tx) => getReceipt(tx, rpc),
};
const mode = values["dry-run"] ? "dry-run" : "live";
const cfg = (m: RunConfig["mode"]): RunConfig => ({ ...loaded, mode: m });
const show = (o: TickOutcome) => log(`${o.kind.padEnd(9)} ${o.note}`);

const iso = (t: number) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16) + "Z" : "never");

if (cmd === "status") {
  const at = values.at ? Date.parse(values.at) : Date.now();
  if (!Number.isFinite(at)) throw new Error("--at must be an ISO date");
  const a = loaded.asset;
  const [h1, pool, session] = await Promise.all([candles(a), deps.pool(a), deps.signer.session()]);
  const s = computeSignal(h1, at);
  // Without a session the wallet is read at the mandate's owner address.
  const owner = session.connected ? await deps.signer.address() : mandate.owner;
  const [stock, usdt] = await Promise.all([deps.balance(a.token, owner), deps.balance(USDT, owner)]);
  const w = s.clock.window;
  log(`signal    ${a.symbol} pool ${pool.price.toFixed(2)} (last candle ${s.price.toFixed(2)}), band ±${(s.band.halfWidth * 100).toFixed(2)}% (${s.band.basis}${s.ivl.sigmaPct ? `, IVL σ ${s.ivl.sigmaPct.toFixed(2)}% over ${s.ivl.windows} windows` : ""})`);
  log(`window    ${s.clock.phase}, ${w.reason} ${iso(w.start)} → ${iso(w.end)}; River enters ${iso(s.entryAt)}, exits ${iso(s.exitAt)}`);
  log(`wallet    ${owner}: ${stock.toFixed(4)} ${a.symbol} + ${usdt.toFixed(2)} USDT; session ${session.connected ? `until ${iso(session.expiresAt)}` : "NOT CONNECTED"}${session.quotaUsd !== undefined ? `, DeFi quota left $${session.quotaUsd}` : ""}`);
  if (session.connected && session.expiresAt - 30 * 60_000 < s.exitAt) log(`warn      the session ends before the planned exit; River will leave at ${iso(session.expiresAt - 30 * 60_000)}`);
  show(await tick(cfg("status"), { ...deps, now: () => at }));
} else if (cmd === "tick") {
  show(await tick(cfg(mode), deps));
} else if (cmd === "resume") {
  const s = await store.load();
  log(s.halted ? `cleared halt: ${s.halted}` : "not halted");
  await store.save({ ...s, halted: null });
} else if (cmd === "exit-now") {
  const s = await store.load();
  if (!s.position) log("no open position");
  else {
    const withExit = { ...s, exit: s.exit ?? { reason: "manual", startedAt: Date.now(), gasBnb: 0 } };
    if (mode === "live") await store.save(withExit);
    // A dry run must not persist the exit, so it reads the exit state from memory instead.
    const d = mode === "live" ? deps : { ...deps, store: { ...store, load: async () => structuredClone(withExit) } };
    show(await tick(cfg(mode), d));
  }
} else {
  const everyMs = Number(values.interval) * 1000;
  log(`River agent: ${mandate.asset} for ${mandate.owner}, ${mode}, every ${values.interval}s`);
  let failures = 0;
  for (;;) {
    try {
      show(await tick(cfg(mode), deps));
      failures = 0;
    } catch (e) {
      failures++;
      log(`error (${failures} in a row) ${(e as Error).message}`);
      if (failures >= 3 && (await store.load()).position) log("\u0007ALERT: the agent keeps failing while a position is open — check it now");
    }
    await deps.sleep(everyMs);
  }
}
