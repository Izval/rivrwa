// register-agent.ts — gives River its ERC-8004 identity on BSC mainnet. Claude never signs: this prints the
// transaction, the operator sends it from River's agent wallet, and a second run reads the minted id back.
//
//   node scripts/register-agent.ts                 # checks the registration file, prints {to, data} to send
//   node scripts/register-agent.ts --tx 0x…        # reads the receipt, prints the agent id and what to set next
//
// The agent wallet is a plain EOA (the Agentic Wallet cannot send arbitrary calls). It needs ~0.0005 BNB for gas.
// Its address must equal AGENT_WALLET on rivrwa-api, because the same wallet receives the x402 payments: identity
// and treasury are one account. Sending the tx, e.g. with Foundry:
//
//   cast send 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 <data> --rpc-url https://bsc-dataseed.bnbchain.org --private-key …
//
// or MetaMask (BNB Chain, "send" to the registry with the hex data). Afterwards set AGENT_ID in
// workers/api/wrangler.toml [vars] and deploy, so the registration file lists the id (ERC-8004 `registrations`).

import { ERC8004, getReceipt, registerCalldata, registeredAgentId } from "../packages/core/src/index.ts";

const URI = process.env.RIVER_AGENT_URI ?? "https://api.rivrwa.com/.well-known/agent-registration.json";
const i = process.argv.indexOf("--tx");

if (i < 0) {
  const r = await fetch(URI);
  const f = (await r.json().catch(() => null)) as { name?: string; services?: { name: string; endpoint: string }[] } | null;
  if (!r.ok || f?.name !== "River") throw new Error(`registration file not served at ${URI} (HTTP ${r.status}); deploy rivrwa-api first`);
  console.log(`registration file OK: ${f.services?.map((s) => `${s.name} ${s.endpoint}`).join(" · ")}\n`);
  console.log(`chain  BSC mainnet (56)`);
  console.log(`to     ${ERC8004.identity}   (ERC-8004 IdentityRegistry)`);
  console.log(`value  0`);
  console.log(`data   ${registerCalldata(URI)}`);
  console.log(`\nSend it from River's agent wallet, then: node scripts/register-agent.ts --tx <hash>`);
} else {
  const tx = process.argv[i + 1];
  const rec = await getReceipt(tx);
  if (!rec) throw new Error("not mined yet; retry in a few seconds");
  if (rec.status !== "0x1") throw new Error("the register transaction reverted");
  const id = registeredAgentId(rec);
  if (id === null) throw new Error("no IdentityRegistry mint in this receipt");
  console.log(`agent id ${id}  (eip155:56:${ERC8004.identity})`);
  console.log(`tx       https://bscscan.com/tx/${tx}`);
  console.log(`scan     https://www.8004scan.io/agents/bsc/${id}`);
  console.log(`\nNext: AGENT_ID = "${id}" in workers/api/wrangler.toml [vars], then cd workers/api && npx wrangler deploy`);
}
