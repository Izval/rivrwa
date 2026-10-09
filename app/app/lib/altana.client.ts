// altana.client.ts — the browser half of flow B. Everything here needs the user's passkey, so it runs only in the
// browser: creating the account, approving the position manager once, granting River's session key, revoking
// it, withdrawing, and signing in. The SDK (viem + Porto) is loaded on first use, so no other page pays for it.
//
// River's session key never reaches the browser. The grant only needs its address and public key, and those arrive
// from the agent's /altana/draft. `sessionSigner` below carries only them and cannot sign.

import { PANCAKE_V3_NPM, USDT } from "../../../packages/core/src/assets.ts";
import { sessionPermissions, type WeeklyCaps } from "./altana.ts";

type Sdk = typeof import("@altananetwork/sdk");
type Hex = `0x${string}`;
export interface PasskeyRef { id: string; publicKey: string; rpId: string }

let sdkP: Promise<Sdk> | null = null;
const sdk = () => (sdkP ??= import("@altananetwork/sdk"));
let clientP: Promise<ReturnType<Sdk["createClient"]>> | null = null;
const client = () => (clientP ??= sdk().then((s) => s.createClient({ chains: [s.BNB] })));

const passkeySigner = async (p: PasskeyRef) =>
  (await sdk()).signerFromPasskey({ kind: "webauthn", id: p.id, publicKey: p.publicKey as Hex, rpId: p.rpId });

const MAX = (1n << 256n) - 1n;
const word = (x: bigint | string) => BigInt(x).toString(16).padStart(64, "0");
const approve = (token: string) => ({ to: token as Hex, value: 0n, data: `0x095ea7b3${word(PANCAKE_V3_NPM)}${word(MAX)}` as Hex });
const transfer = (token: string, to: string, amount: bigint) => ({ to: token as Hex, value: 0n, data: `0xa9059cbb${word(to)}${word(amount)}` as Hex });

/** One passkey prompt: a new passkey and its smart account (counterfactual: nothing on-chain yet). */
export async function createAccount(): Promise<{ account: string; passkey: PasskeyRef }> {
  const c = await client();
  const w = await c.createPasskeyWallet({ name: "River", rpId: location.hostname });
  const cred = w.signer.credential;
  if (cred.kind !== "webauthn") throw new Error("expected a WebAuthn passkey");
  return { account: w.address.toLowerCase(), passkey: { id: cred.id, publicKey: cred.publicKey.toLowerCase(), rpId: cred.rpId ?? location.hostname } };
}

/** Balances in human units (all legs are 18 decimals on BSC), from the raw balanceOf the transfers use. */
export async function balances(account: string, stockToken: string) {
  const c = await client();
  const r = await c.balances({ wallet: account as Hex, tokens: [stockToken as Hex, USDT as Hex], chainId: 56 });
  const raw = (t: string) => {
    const x = r.tokens?.find((y) => y.address.toLowerCase() === t.toLowerCase());
    return x && x.ok ? x.raw : 0n;
  };
  const human = (x: bigint) => Number(x / 10n ** 9n) / 1e9;
  return { bnb: human(r.native), stock: human(raw(stockToken)), usd: human(raw(USDT)), rawStock: raw(stockToken), rawUsd: raw(USDT) };
}

/** Passkey prompt: the account approves the position manager for the stock and USDT, once. */
export async function approvePositionManager(account: string, passkey: PasskeyRef, stockToken: string) {
  const c = await client();
  const res = await c.execute({ wallet: { address: account as Hex }, signer: await passkeySigner(passkey), calls: [approve(stockToken), approve(USDT)], chainId: 56 });
  if (res.status === "FAILED") throw new Error("the approval failed on-chain");
  return res.transactionHash ?? null;
}

/** Passkey prompt: grant River's session key (public half only) for `expiry` with the given weekly caps. */
export async function grant(account: string, passkey: PasskeyRef, session: { address: string; publicKey: string }, stockToken: string, caps: WeeklyCaps, expiry: number) {
  const s = await sdk(), c = await client();
  const sessionSigner = {
    type: "privateKey" as const, address: session.address as Hex, publicKey: session.publicKey as Hex,
    signDigest: async (): Promise<Hex> => { throw new Error("River's session key is held by River's server"); },
  };
  const g = await c.grantSession({
    wallet: { address: account as Hex }, signer: await passkeySigner(passkey), sessionSigner, register: true, expiry,
    permissions: sessionPermissions(stockToken, caps), chainId: 56,
  });
  return { serialized: s.serializeSession(g), grantTx: g.transactionHash ?? null };
}

/** Passkey prompt: revoke River's current session key on-chain (by its public key). */
export async function revokeOnchain(account: string, passkey: PasskeyRef, sessionPubkey: string) {
  const c = await client();
  const res = await c.revokeSession({ wallet: { address: account as Hex }, signer: await passkeySigner(passkey), session: sessionPubkey as Hex, chainId: 56 });
  return res.transactionHash ?? null;
}

/** Passkey prompt: send the whole stock and USDT balance to `to`. */
export async function withdrawAll(account: string, passkey: PasskeyRef, stockToken: string, to: string) {
  const b = await balances(account, stockToken);
  const calls = [
    ...(b.rawStock > 0n ? [transfer(stockToken, to, b.rawStock)] : []),
    ...(b.rawUsd > 0n ? [transfer(USDT, to, b.rawUsd)] : []),
  ];
  if (calls.length === 0) throw new Error("nothing to withdraw");
  const c = await client();
  const res = await c.execute({ wallet: { address: account as Hex }, signer: await passkeySigner(passkey), calls, chainId: 56 });
  return res.transactionHash ?? null;
}

const b64u = {
  dec: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0)),
  enc: (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
};

/** Passkey prompt over River's challenge; the agent verifies it against the account's passkey. */
export async function assertPasskey(challenge: string) {
  const cred = (await navigator.credentials.get({
    publicKey: { challenge: b64u.dec(challenge), rpId: location.hostname, userVerification: "preferred", timeout: 120_000 },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no passkey chosen");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    credentialId: cred.id, authenticatorData: b64u.enc(r.authenticatorData), clientDataJSON: b64u.enc(r.clientDataJSON), signature: b64u.enc(r.signature),
  };
}
