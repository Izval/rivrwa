// erc8004.ts — River's on-chain agent identity (ERC-8004) on BSC mainnet.
//
// ERC-8004's IdentityRegistry is an ERC-721: `register(agentURI)` mints an agent id to the caller, and the URI points
// at a registration file that lists the agent's services. River's file is served by the public API
// (`/.well-known/agent-registration.json`), so the endpoints can change without a new transaction; only the id is
// fixed, and it is written back into the file as `registrations` once minted.
//
// Nothing here signs. `registerCalldata` is what the operator sends from River's agent wallet (the same address
// that receives x402 payments for the signal, so the identity and the treasury are one account), and
// `registeredAgentId` reads the id from the receipt.

import type { Receipt } from "./bsc.ts";

/** The canonical ERC-8004 registries (same vanity addresses on every chain); verified on BSC 2026-10-06. */
export const ERC8004 = {
  chainId: 56,
  identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
} as const;

const SEL = { register: "0xf2c298be", setAgentURI: "0x0af28bd3" } as const;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
function abiString(s: string): string {
  const hex = [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
}

/** `register(string agentURI)`. */
export const registerCalldata = (agentURI: string) => SEL.register + word(32) + abiString(agentURI);
/** `setAgentURI(uint256 agentId, string newURI)`, for moving the file later. */
export const setAgentUriCalldata = (agentId: bigint | number, uri: string) => SEL.setAgentURI + word(agentId) + word(64) + abiString(uri);

/** The id minted by a `register` receipt: the registry's ERC-721 `Transfer` from 0x0. */
export function registeredAgentId(r: Receipt, registry = ERC8004.identity): bigint | null {
  const log = r.logs.find((l) => l.address.toLowerCase() === registry.toLowerCase() && l.topics[0] === TRANSFER && BigInt(l.topics[1] ?? "0x1") === 0n);
  return log?.topics[3] ? BigInt(log.topics[3]) : null;
}

export interface AgentService { name: string; endpoint: string; version?: string }
export interface AgentRegistration {
  type: string;
  name: string;
  description: string;
  image: string;
  services: AgentService[];
  /** Pre-2026 readers look for `endpoints`; same list. */
  endpoints: AgentService[];
  x402Support: boolean;
  active: boolean;
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
}

/** River's registration file. `agentId` is null until the operator has sent `register`. */
export function agentRegistration(o: { agentId: number | null; web: string; api: string; image: string }): AgentRegistration {
  const services: AgentService[] = [
    { name: "web", endpoint: o.web },
    { name: "MCP", endpoint: `${o.api}/mcp`, version: "2025-06-18" },
    { name: "x402", endpoint: `${o.api}/v1/paid/plan` },
  ];
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "River",
    description:
      "Puts tokenized stocks (bStocks) to work as PancakeSwap v3 liquidity only while the NYSE is closed, and withdraws before the reopen. " +
      "Non-custodial: it signs from each user's own wallet under their mandate. Other agents can buy its signal (closed window + IVL band, " +
      "fitted to their inventory) over x402 or MCP.",
    image: o.image,
    services,
    endpoints: services,
    x402Support: true,
    active: true,
    registrations: o.agentId === null ? [] : [{ agentId: o.agentId, agentRegistry: `eip155:${ERC8004.chainId}:${ERC8004.identity}` }],
    supportedTrust: ["reputation"],
  };
}
