// Where the CLI keeps its app key. One JSON file, mode 0600, never the seed phrase.

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { approvalCache, type ApprovalCache, type AppAccount, type AppKey } from "../core/index.js";

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

// Per FID, the time up to which notifications were marked read (`notifications --mark-read`).
const seenPath = () => join(stateDir(), "notifications-seen.json");

export function notificationsSeen(fid: number): number | undefined {
  const p = seenPath();
  if (!existsSync(p)) return undefined;
  const v = (JSON.parse(readFileSync(p, "utf8")) as Record<string, number>)[String(fid)];
  return typeof v === "number" ? v : undefined;
}

export function markNotificationsSeen(fid: number, at: number): void {
  const p = seenPath();
  const all = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, number>) : {};
  all[String(fid)] = at;
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(all) + "\n", { mode: 0o600 });
}

// The app account for "Approve in the Farcaster app" (`./outpost app-account`). Its custody key
// sits here, mode 0600, and is read by the CLI and by `./outpost client`'s server; it is never
// sent to a browser.
export function appAccountPath(): string {
  return join(stateDir(), "app-account.json");
}

export function loadAppAccount(): AppAccount | undefined {
  const p = appAccountPath();
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as AppAccount;
}

export function saveAppAccount(a: AppAccount): string {
  const p = appAccountPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

export function deleteAppAccount(): boolean {
  const p = appAccountPath();
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function deleteKey(): void {
  const p = keyPath();
  if (existsSync(p)) unlinkSync(p);
}
