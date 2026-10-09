// altana-sdk.ts — the only module that loads @altananetwork/sdk. It makes River's session keys, submits a guarded
// batch with one (execute), and reads an account's keys on-chain, which is how River learns that the account's
// admin (the user's passkey) really authorised River's key. That read is the proof of ownership behind an Altana
// sign-in.
//
// The SDK reaches Altana's relay and a public BSC RPC with the Worker's own fetch. If Workers' shared egress gets
// rate-limited there, set ALTANA_RPC_URL to a private endpoint.

import {
  BNB, createClient, createPrivateKeySigner, deserializeSession, signerFromPrivateKey, type NetworkConfig, type SerializedSession,
} from "@altananetwork/sdk";
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { rpc, type Call, type RpcOpts } from "../../../packages/core/src/index.ts";

export const network = (rpcUrl?: string): NetworkConfig => (rpcUrl ? { ...BNB, publicRpcUrl: rpcUrl } : BNB);

/** A fresh secp256k1 session key. The private half is sealed in D1 at once and never leaves the server. */
export function newSessionKey() {
  const s = createPrivateKeySigner();
  return { privateKey: s._privateKey, publicKey: s.publicKey, address: s.address.toLowerCase() };
}

/** One Altana intent signed by the session key; the tx hash once the relay reports it included. */
export async function sendWithSession(serialized: SerializedSession, privateKey: Hex, calls: Call[], rpcUrl?: string): Promise<string> {
  const session = deserializeSession(serialized, signerFromPrivateKey(privateKey));
  const client = createClient({ chains: [network(rpcUrl)] });
  const res = await client.execute({
    session, chainId: 56,
    calls: calls.map((c) => ({ to: c.to as Hex, data: c.data as Hex, value: BigInt(c.value ?? 0) })),
  });
  if (res.status === "FAILED") throw new Error(`Altana relay: the intent failed (${res.callsId})`);
  if (!res.transactionHash) throw new Error(`Altana relay: no transaction hash yet (${res.callsId}, ${res.status})`);
  return res.transactionHash;
}

const GET_KEYS = [{
  name: "getKeys", type: "function", stateMutability: "view", inputs: [],
  outputs: [
    { name: "keys", type: "tuple[]", components: [
      { name: "expiry", type: "uint40" }, { name: "keyType", type: "uint8" }, { name: "isSuperAdmin", type: "bool" }, { name: "publicKey", type: "bytes" },
    ] },
    { name: "keyHashes", type: "bytes32[]" },
  ],
}] as const;

export interface AccountKey { expiry: number; keyType: number; isSuperAdmin: boolean; publicKey: string }

/** The account's authorised keys (admin passkey, session keys) as the account contract reports them. */
export async function accountKeys(account: string, o: RpcOpts = {}): Promise<AccountKey[]> {
  const ret = await rpc<Hex>("eth_call", [{ to: account, data: encodeFunctionData({ abi: GET_KEYS, functionName: "getKeys" }) }, "latest"], o);
  const [keys] = decodeFunctionResult({ abi: GET_KEYS, functionName: "getKeys", data: ret });
  return keys.map((k) => ({ expiry: Number(k.expiry), keyType: k.keyType, isSuperAdmin: k.isSuperAdmin, publicKey: k.publicKey.toLowerCase() }));
}

/**
 * Whether `keys` hold River's session key (a secp256k1 key is stored as its address, left-padded) and the passkey
 * (x ‖ y), each matched by its public key. Expiry 0 means no expiry.
 */
export function keysInclude(keys: AccountKey[], p: { sessionAddress?: string; passkeyPubkey?: string }, nowS = Date.now() / 1000) {
  const live = keys.filter((k) => k.expiry === 0 || k.expiry > nowS);
  const has = (needle: string) => live.some((k) => k.publicKey.replace(/^0x/, "").endsWith(needle.toLowerCase().replace(/^0x/, "")));
  return {
    session: p.sessionAddress ? has(p.sessionAddress) : false,
    passkey: p.passkeyPubkey ? has(p.passkeyPubkey) : false,
  };
}
