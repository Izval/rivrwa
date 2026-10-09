// webauthn.ts — sign-in for flow B accounts. An Altana account is controlled by a passkey, so a returning user
// proves who they are with a WebAuthn assertion over a one-time challenge from River. The public key it is checked
// against was bound to the account on-chain when the user granted River's session (altana-sdk.ts `keysInclude`),
// so a valid assertion means "the holder of this account's admin passkey". WebCrypto only, no library.

export interface Assertion {
  /** All base64url, as the browser's PublicKeyCredential gives them. */
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  /** ASN.1 DER ECDSA signature. */
  signature: string;
}

export const b64url = {
  decode: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
  encode: (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
};

const hexBytes = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const concat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };

/** DER `SEQUENCE { INTEGER r, INTEGER s }` → the 64-byte r ‖ s that WebCrypto verifies. */
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("signature is not DER");
  let i = 2;
  const int = () => {
    if (der[i] !== 0x02) throw new Error("signature is not DER");
    const len = der[i + 1];
    let v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    return concat(new Uint8Array(32 - v.length), v);
  };
  return concat(int(), int());
}

/**
 * Checks the assertion: type, challenge and origin in clientData, the rpId hash and user-presence flag in
 * authenticatorData, then the P-256 signature over authenticatorData ‖ sha256(clientDataJSON) with `publicKey`
 * (x ‖ y hex, as Altana stores a passkey). Throws with the reason when anything is off.
 */
export async function verifyAssertion(a: Assertion, publicKey: string, expect: { challenge: string; origin: string; rpId: string }): Promise<void> {
  const clientRaw = b64url.decode(a.clientDataJSON);
  const client = JSON.parse(new TextDecoder().decode(clientRaw)) as { type?: string; challenge?: string; origin?: string };
  if (client.type !== "webauthn.get") throw new Error("not a WebAuthn assertion");
  if (client.challenge !== expect.challenge) throw new Error("challenge mismatch");
  if (client.origin !== expect.origin) throw new Error(`origin ${client.origin} is not ${expect.origin}`);

  const auth = b64url.decode(a.authenticatorData);
  const rpHash = await sha256(new TextEncoder().encode(expect.rpId));
  if (auth.length < 37 || !rpHash.every((b, i) => auth[i] === b)) throw new Error("rpId mismatch");
  if (!(auth[32] & 0x01)) throw new Error("user presence flag not set");

  const xy = hexBytes(publicKey);
  if (xy.length !== 64) throw new Error("stored passkey is not an uncompressed P-256 key");
  const key = await crypto.subtle.importKey("raw", concat(new Uint8Array([4]), xy), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = concat(auth, await sha256(clientRaw));
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(b64url.decode(a.signature)), signed);
  if (!ok) throw new Error("bad signature");
}
