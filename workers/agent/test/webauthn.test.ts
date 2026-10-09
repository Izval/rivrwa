import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAssertion, derToRaw, b64url, type Assertion } from "../src/webauthn.ts";

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** r ‖ s → DER, as authenticators return it (leading 0x00 when the high bit is set). */
function rawToDer(raw: Uint8Array) {
  const int = (v: Uint8Array) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.slice(i);
    if (v[0] & 0x80) v = Uint8Array.from([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

async function passkey() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const publicKey = "0x" + hex(raw.slice(1)); // x ‖ y, as Altana stores it
  const assert_ = async (o: { challenge: string; origin?: string; rpId?: string; flags?: number; type?: string }): Promise<Assertion> => {
    const client = enc.encode(JSON.stringify({ type: o.type ?? "webauthn.get", challenge: o.challenge, origin: o.origin ?? "https://rivrwa.com" }));
    const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(o.rpId ?? "rivrwa.com")));
    const auth = Uint8Array.from([...rpHash, o.flags ?? 0x05, 0, 0, 0, 1]);
    const signed = Uint8Array.from([...auth, ...new Uint8Array(await crypto.subtle.digest("SHA-256", client))]);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, signed));
    return { credentialId: "cred", authenticatorData: b64url.encode(auth), clientDataJSON: b64url.encode(client), signature: b64url.encode(rawToDer(sig)) };
  };
  return { publicKey, assert: assert_ };
}

const expect = { challenge: "c2FsdHktY2hhbGxlbmdl", origin: "https://rivrwa.com", rpId: "rivrwa.com" };

test("webauthn: a passkey assertion over River's challenge verifies against the stored x‖y key", async () => {
  const pk = await passkey();
  await verifyAssertion(await pk.assert({ challenge: expect.challenge }), pk.publicKey, expect);
});

test("webauthn: wrong challenge, origin, rpId, flags, type or key are refused", async () => {
  const pk = await passkey(), other = await passkey();
  await assert.rejects(verifyAssertion(await pk.assert({ challenge: "b3RoZXI" }), pk.publicKey, expect), /challenge/);
  await assert.rejects(verifyAssertion(await pk.assert({ challenge: expect.challenge, origin: "https://evil.example" }), pk.publicKey, expect), /origin/);
  await assert.rejects(verifyAssertion(await pk.assert({ challenge: expect.challenge, rpId: "evil.example" }), pk.publicKey, expect), /rpId/);
  await assert.rejects(verifyAssertion(await pk.assert({ challenge: expect.challenge, flags: 0x04 }), pk.publicKey, expect), /presence/);
  await assert.rejects(verifyAssertion(await pk.assert({ challenge: expect.challenge, type: "webauthn.create" }), pk.publicKey, expect), /not a WebAuthn assertion/);
  await assert.rejects(verifyAssertion(await pk.assert({ challenge: expect.challenge }), other.publicKey, expect), /bad signature/);
});

test("webauthn: DER with a padded high-bit integer converts to 64 raw bytes", () => {
  const r = new Uint8Array(32).fill(0x80), s = new Uint8Array(32); s[31] = 1;
  const raw = derToRaw(rawToDer(Uint8Array.from([...r, ...s])));
  assert.equal(raw.length, 64);
  assert.deepEqual(raw, Uint8Array.from([...r, ...s]));
});
