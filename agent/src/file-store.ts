// file-store.ts — the Store on local disk, for the CLI (Node only). The hosted agent uses D1 instead.

import fs from "node:fs";
import path from "node:path";
import { emptyState, type Store } from "./store.ts";

export function fileStore(dir: string, key: string): Store {
  const file = path.join(dir, `${key}.json`);
  const cycles = path.join(dir, "cycles.jsonl");
  return {
    load: async () => (fs.existsSync(file) ? { ...emptyState(), ...JSON.parse(fs.readFileSync(file, "utf8")) } : emptyState()),
    save: async (s) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify(s, null, 2));
      fs.renameSync(file + ".tmp", file); // atomic: a crash mid-write keeps the previous state
    },
    appendCycle: async (r) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(cycles, JSON.stringify(r) + "\n");
    },
  };
}
