// Sponsor for a society node: pays for members' new Farcaster accounts from a hot wallet on the
// host's server. It runs next to the gate, behind Caddy at /sponsor/* (see infra/society.sh).
// A member's browser makes the account's key, or uses their wallet, and signs Register; this
// service calls IdGateway.registerFor and pays the fee. It never sees a member's key. The rules
// are in src/server/sponsor-service.ts.
//
// - Members only: the gate's members file and Bearer tokens.
// - Caps: OUTPOST_SPONSOR_PER_MEMBER accounts per member, ever (default 2), and
//   OUTPOST_SPONSOR_PER_DAY in all per UTC day (default 20). Counts are kept in the state file.
// - Every registration is simulated first, so a bad signature costs nothing.
// - Nothing about a request is logged: no address, FID, token or IP address. Once an hour it
//   prints how many accounts it paid for and how many more the wallet can pay for.
//
// Environment: OUTPOST_SPONSOR_KEY (file holding the wallet's private key, 0x + 64 hex),
// OUTPOST_SPONSOR_MEMBERS (/gate/members), OUTPOST_SPONSOR_STATE (/state/counts.json),
// OUTPOST_SPONSOR_PORT (3391, 127.0.0.1 only), OUTPOST_SPONSOR_RPC (https://mainnet.optimism.io),
// OUTPOST_SPONSOR_DRY_RUN=1 checks registrations on Optimism without sending them.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { formatEther } from "viem";
import { fileCounts, GAS_RESERVE, membersFrom, sponsor, viemChain } from "./sponsor-service.js";
import type { HexString } from "../core/hub.js";

function whole(name: string, fallback: number): number {
  const v = Number(process.env[name] || fallback);
  if (!(Number.isInteger(v) && v >= 0)) throw new Error(`${name} must be a whole number`);
  return v;
}

const key = readFileSync(process.env.OUTPOST_SPONSOR_KEY ?? "/sponsor/key", "utf8").trim();
if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error("the key file must hold 0x and 64 hex digits");
const dryRun = process.env.OUTPOST_SPONSOR_DRY_RUN === "1";
const port = whole("OUTPOST_SPONSOR_PORT", 3391);
const chain = viemChain(process.env.OUTPOST_SPONSOR_RPC || "https://mainnet.optimism.io", key as HexString, dryRun);
const s = sponsor({
  chain,
  members: membersFrom(process.env.OUTPOST_SPONSOR_MEMBERS ?? "/gate/members"),
  counts: fileCounts(process.env.OUTPOST_SPONSOR_STATE ?? "/state/counts.json"),
  perMember: whole("OUTPOST_SPONSOR_PER_MEMBER", 2),
  perDay: whole("OUTPOST_SPONSOR_PER_DAY", 20),
  dryRun,
});

async function report() {
  const { lastHour, today } = s.report();
  let afford = "unknown (Optimism did not answer)";
  try {
    const [price, balance] = await Promise.all([chain.price(), chain.balance()]);
    afford = `${balance > GAS_RESERVE ? (balance - GAS_RESERVE) / ((price * 105n) / 100n) : 0n} more (balance ${formatEther(balance)} ETH)`;
  } catch {}
  console.log(`${new Date().toISOString()} sponsor: paid for ${lastHour} accounts in the last hour, ${today} today; the wallet can pay for ${afford}`);
}

for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void report().finally(() => process.exit(0)));
setInterval(() => void report(), 3600_000).unref();

const server = createServer(s.handle);
server.listen(port, "127.0.0.1", () => {
  console.log(`sponsor: wallet ${chain.address} on Optimism${dryRun ? " (dry run: nothing is sent)" : ""}; 127.0.0.1:${port}`);
  void report();
});
