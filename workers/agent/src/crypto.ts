// crypto.ts — sealing user secrets at rest. A baw session file is a bearer credential for the user's Agentic
// Wallet (within the limits set in the Binance App), so D1 only ever holds it AES-GCM encrypted under
// RIVER_MASTER_KEY. The container also needs a BINANCE_INSTANCE_ID to read the file; it is derived from the
// same key and a per-session salt, so a leaked database alone opens nothing.

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function subKey(master: string, label: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", enc.encode(`${label}:${master}`));
}

async function aesKey(master: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await subKey(master, "river-seal-v1"), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** base64(iv ‖ ciphertext). */
export async function seal(master: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(master), enc.encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

export async function unseal(master: string, sealed: string): Promise<string> {
  const raw = unb64(sealed);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(master), raw.slice(12));
  return dec.decode(pt);
}

export async function hmacHex(master: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", await subKey(master, "river-hmac-v1"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const instanceIdFor = async (master: string, salt: string) => "rv" + (await hmacHex(master, `baw-instance:${salt}`)).slice(0, 40);

export const randomId = (bytes = 16) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
