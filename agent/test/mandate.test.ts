// mandate.test.ts — mandates resolve their asset against whatever registry the caller passes (the live one in the
// Worker), so an auto-enabled stock is accepted without a code change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSETS, type StreamAsset } from "../../packages/core/src/index.ts";
import { parseMandate, type MandateFile } from "../src/mandate.ts";

const f: MandateFile = {
  owner: "0x" + "1".repeat(40), asset: "googlb", signer: "agentic_wallet", allocation: 1, maxHalfWidth: 0.05,
  exitOnDrift: 0.03, skipEvents: false, restoreShares: false, expiresAt: "2026-12-31T00:00:00Z",
};
const googlb: StreamAsset = { ...ASSETS[0], symbol: "GOOGLB", underlying: "GOOGL", token: "0x" + "a".repeat(40), pinned: false };

test("mandate: resolves against an injected registry, canonical symbol, seed by default", () => {
  assert.throws(() => parseMandate(f), /unknown asset/);
  const m = parseMandate(f, [...ASSETS, googlb]);
  assert.equal(m.asset.token, googlb.token);
  assert.equal(m.mandate.asset, "GOOGLB");
  assert.equal(parseMandate({ ...f, asset: "nvdab" }).asset.symbol, "NVDAB");
});
