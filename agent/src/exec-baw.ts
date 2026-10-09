// exec-baw.ts — runs the local `baw` binary (Node only). The hosted agent runs it in a container instead.

import { execFile } from "node:child_process";
import type { BawRunner } from "./agentic-wallet.ts";

/** Returns stdout whatever the exit code: baw reports errors inside its JSON envelope. */
export const execBaw = (bin = "baw", timeoutMs = 120_000, env?: Record<string, string>): BawRunner => (args) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 << 20, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
      if (stdout.trim()) return resolve(stdout);
      reject(err ? new Error(`${bin} ${args.slice(0, 2).join(" ")}: ${stderr.trim() || err.message}`) : new Error(`${bin}: empty output`));
    });
  });
