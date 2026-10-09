import { test } from "node:test";
import assert from "node:assert/strict";
import { seal, unseal, instanceIdFor, randomId } from "../src/crypto.ts";

test("crypto: sealed sessions round-trip, differ per call, and fail under another key", async () => {
  const secret = '{"clientId":"abc","sessionId":"xyz"}';
  const a = await seal("master-1", secret), b = await seal("master-1", secret);
  assert.notEqual(a, b); // random IV
  assert.equal(await unseal("master-1", a), secret);
  await assert.rejects(unseal("master-2", a));
});

test("crypto: the baw instance id is stable per salt, distinct across salts and keys, and container-safe", async () => {
  const salt = randomId(16);
  const id = await instanceIdFor("master-1", salt);
  assert.equal(id, await instanceIdFor("master-1", salt));
  assert.notEqual(id, await instanceIdFor("master-1", randomId(16)));
  assert.notEqual(id, await instanceIdFor("master-2", salt));
  assert.match(id, /^[A-Za-z0-9_-]{16,128}$/); // what containers/baw/server.ts accepts
});
