// registry.ts — the live asset registry as the Workers read it: what the discovery cron (workers/api) stored in KV,
// merged over the pinned seed. Memoised per isolate for 5 minutes; a cron tick never needs fresher than that.

import { mergeRegistry, type Registry, type RegistryAsset } from "../../../packages/core/src/index.ts";

export interface RegistryEnv {
  RIVER_KV?: KVNamespace;
}

export const REGISTRY_KEY = "registry";
let memo: { at: number; list: RegistryAsset[] } | null = null;

export async function storedRegistry(env: RegistryEnv): Promise<Registry | null> {
  if (!env.RIVER_KV) return null;
  return env.RIVER_KV.get<Registry>(REGISTRY_KEY, "json").catch(() => null);
}

/** After a write in this isolate (discovery), so the next read sees it. */
export const forgetRegistry = () => { memo = null; };

export async function loadRegistry(env: RegistryEnv, maxAgeMs = 5 * 60_000): Promise<RegistryAsset[]> {
  if (memo && Date.now() - memo.at < maxAgeMs) return memo.list;
  memo = { at: Date.now(), list: mergeRegistry(await storedRegistry(env)) };
  return memo.list;
}
