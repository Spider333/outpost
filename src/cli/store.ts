// Where the CLI keeps its app key. One JSON file, mode 0600, never the seed phrase.

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { approvalCache, type ApprovalCache, type AppKey } from "../core/index.js";

export function stateDir(): string {
  return process.env.OUTPOST_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "outpost");
}

export function keyPath(): string {
  return join(stateDir(), "appkey.json");
}

export function loadKey(): AppKey | undefined {
  const p = keyPath();
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as AppKey;
}

export function saveKey(key: AppKey): string {
  const p = keyPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(key, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

// Every society-vote approval this CLI has seen (votes.ts), so a later unlike changes nothing.
export function savedApprovals(): ApprovalCache {
  const p = join(stateDir(), "approvals.json");
  return approvalCache(
    () => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
    (json) => {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, json, { mode: 0o600 });
    },
  );
}

export function deleteKey(): void {
  const p = keyPath();
  if (existsSync(p)) unlinkSync(p);
}
