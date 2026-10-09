// Live smoke test of the core Binance client (read-only endpoints).
import fs from "node:fs";
import { binanceWeb3, ASSETS } from "../packages/core/src/index.ts";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")
    .filter((l) => /^[A-Z_0-9]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const bw = binanceWeb3({ apiKey: env.BINANCE_WEB3_API_KEY, secretKey: env.BINANCE_WEB3_SECRET_KEY });
const toks = await bw.rwaTokens("bstock");
for (const a of ASSETS) {
  const t = toks.find((x) => x.tokenContractAddress.toLowerCase() === a.token);
  const d = await bw.investmentDetail(a.investmentId);
  console.log(a.symbol, "price", t?.tokenPrice.slice(0, 7), "ratio", t?.tokenToShareRatio.slice(0, 8),
    "status", t?.statusInfo.reasonCode, "| pool ok", d.poolAddress.toLowerCase() === a.pool, "apr", d.apyDisplay);
}
