import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCalldata, setAgentUriCalldata, registeredAgentId, agentRegistration, ERC8004 } from "../src/erc8004.ts";

// Expected calldata produced by viem's encodeFunctionData (2026-10-06), an encoder independent of ours.
test("erc8004: register(string) calldata matches viem", () => {
  assert.equal(
    registerCalldata("https://api.rivrwa.com/.well-known/agent-registration.json"),
    "0xf2c298be0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003a68747470733a2f2f6170692e7269767277612e636f6d2f2e77656c6c2d6b6e6f776e2f6167656e742d726567697374726174696f6e2e6a736f6e000000000000",
  );
  assert.equal(
    setAgentUriCalldata(42, "ipfs://x"),
    "0x0af28bd3000000000000000000000000000000000000000000000000000000000000002a00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000008697066733a2f2f78000000000000000000000000000000000000000000000000",
  );
});

test("erc8004: agent id from the mint Transfer, ignoring other logs", () => {
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const zero = "0x" + "0".repeat(64), me = "0x" + "ab".repeat(20).padStart(64, "0");
  const r = {
    transactionHash: "0x1", status: "0x1", blockNumber: "0x1",
    logs: [
      { address: "0x55d398326f99059ff775485246999027b3197955", topics: [T, zero, me, "0x" + "9".padStart(64, "0")], data: "0x" },
      { address: ERC8004.identity.toLowerCase(), topics: [T, zero, me, "0x" + "1f3".padStart(64, "0")], data: "0x" },
    ],
  };
  assert.equal(registeredAgentId(r), 0x1f3n);
  assert.equal(registeredAgentId({ ...r, logs: [r.logs[0]] }), null);
});

test("erc8004: registration file lists MCP and x402, and the id once minted", () => {
  const o = { web: "https://rivrwa.com", api: "https://api.rivrwa.com", image: "https://rivrwa.com/icon.png" };
  assert.deepEqual(agentRegistration({ ...o, agentId: null }).registrations, []);
  const f = agentRegistration({ ...o, agentId: 7 });
  assert.deepEqual(f.registrations, [{ agentId: 7, agentRegistry: `eip155:56:${ERC8004.identity}` }]);
  assert.ok(f.services.some((s) => s.name === "MCP" && s.endpoint === "https://api.rivrwa.com/mcp"));
  assert.equal(f.x402Support, true);
});
