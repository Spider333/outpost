// The sponsor's rules, apart from the process that runs them (src/server/sponsor.ts), so tests
// can drive them with a fake chain. Every rule the sponsor applies to a member's request and
// everything it keeps about members is in this file.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { optimism } from "viem/chains";
import { parseRegisterRequest, type RegisterRequest } from "../core/sponsor.js";
import type { HexString } from "../core/hub.js";

const ID_GATEWAY = "0x00000000Fc25870C6eD6b6c7E41Fb078b7656f69";
const ID_REGISTRY = "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b";
const ABI = parseAbi([
  "function price() view returns (uint256)",
  "function registerFor(address to, address recovery, uint256 deadline, bytes sig) payable returns (uint256 fid, uint256 overpayment)",
  "function idOf(address owner) view returns (uint256)",
]);
// Left in the wallet for gas: a registration costs about 0.0000001 ETH of gas on Optimism.
export const GAS_RESERVE = 10n ** 13n;
const MAX_BODY = 4 * 1024;
const ORIGINS = new Set(["https://spider333.github.io", "http://127.0.0.1:8381", "http://localhost:8381"]);

export interface SponsorChain {
  address: HexString;
  idOf(a: HexString): Promise<number>;
  // The fee for one account; IdGateway refunds anything above it.
  price(): Promise<bigint>;
  balance(): Promise<bigint>;
  // Throws with IdGateway's reason when it would reject the call. Costs nothing.
  simulate(r: RegisterRequest, value: bigint): Promise<void>;
  // Sends registerFor and waits until Optimism includes it.
  send(r: RegisterRequest, value: bigint): Promise<HexString>;
}

// Accounts paid for per member (ever) and in all today. Member names, never addresses or FIDs.
export interface Counts {
  day: string;
  today: number;
  members: Record<string, number>;
}

export interface CountStore {
  load(): Counts;
  save(c: Counts): void;
}

export function fileCounts(path: string): CountStore {
  return {
    load() {
      // Only a missing file means "nothing counted yet". A file that cannot be read or parsed
      // stops the sponsor instead of resetting the caps.
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { day: "", today: 0, members: {} };
        throw e;
      }
      const c = JSON.parse(text) as Counts;
      if (typeof c?.day !== "string" || typeof c.today !== "number" || typeof c.members !== "object" || c.members === null) {
        throw new Error(`the counts file ${path} is damaged`);
      }
      return c;
    },
    save(c) {
      // A new file moved over the old one, so a crash never leaves half of it.
      writeFileSync(`${path}.tmp`, JSON.stringify(c), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  };
}

// The gate's members file: "<name> <SHA-256 hex of the token>" per line. Read on every request,
// so `./outpost members remove` takes effect at once. Unreadable: nobody gets in.
export function membersFrom(path: string): () => Map<string, string> {
  return () => {
    const m = new Map<string, string>();
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const r = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,39})\s+([0-9a-f]{64})$/.exec(line.trim());
        if (r) m.set(r[2]!, r[1]!);
      }
    } catch {
      // Fails closed.
    }
    return m;
  };
}

export function viemChain(rpc: string, privateKey: HexString, dryRun = false): SponsorChain {
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpc, { retryCount: 1, timeout: 20_000 });
  const pub = createPublicClient({ chain: optimism, transport });
  const wallet = createWalletClient({ account, chain: optimism, transport });
  const args = (r: RegisterRequest) => [r.to, r.recovery, BigInt(r.deadline), r.signature] as const;
  return {
    address: account.address,
    idOf: async (a) => Number(await pub.readContract({ address: ID_REGISTRY, abi: ABI, functionName: "idOf", args: [a] })),
    price: () => pub.readContract({ address: ID_GATEWAY, abi: ABI, functionName: "price" }),
    balance: () => pub.getBalance({ address: account.address }),
    async simulate(r, value) {
      // A dry run pretends the wallet is funded, so a test checks the signature for free.
      const stateOverride = dryRun ? [{ address: account.address, balance: value + 10n ** 17n }] : undefined;
      await pub.simulateContract({ account, address: ID_GATEWAY, abi: ABI, functionName: "registerFor", args: args(r), value, stateOverride });
    },
    async send(r, value) {
      const hash = await wallet.writeContract({ address: ID_GATEWAY, abi: ABI, functionName: "registerFor", args: args(r), value });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`registerFor reverted in ${hash}`);
      return hash;
    },
  };
}

export interface SponsorOptions {
  chain: SponsorChain;
  members: () => Map<string, string>;
  counts: CountStore;
  perMember: number;
  perDay: number;
  dryRun?: boolean;
  now?: () => number; // ms
}

const HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function shortError(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? String(e);
  return m.split("\n")[0]!.slice(0, 200);
}

export function sponsor(o: SponsorOptions) {
  const now = o.now ?? Date.now;
  let paidThisHour = 0;
  // One registration at a time: the wallet's nonce and balance checks stay simple and true.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.then(f, f);
    queue = next.catch(() => undefined);
    return next;
  };

  const today = (): Counts => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const c = o.counts.load();
    return c.day === day ? c : { day, today: 0, members: c.members ?? {} };
  };

  // What stops this member from getting an account now, if anything.
  function capReason(c: Counts, name: string): string | undefined {
    if ((c.members[name] ?? 0) >= o.perMember) return "You already got the accounts this society pays for.";
    if (c.today >= o.perDay) return "This society has paid for as many accounts as it will today. Try again tomorrow.";
    return undefined;
  }

  async function status(name: string) {
    const c = today();
    const cap = capReason(c, name);
    if (cap) return { available: false, left: 0, reason: cap };
    const [price, balance] = await Promise.all([o.chain.price(), o.chain.balance()]);
    const value = (price * 105n) / 100n;
    // A dry run sends nothing, so the wallet's balance does not limit it.
    const affordable = o.dryRun ? Infinity : balance > GAS_RESERVE ? Number((balance - GAS_RESERVE) / value) : 0;
    const left = Math.min(o.perMember - (c.members[name] ?? 0), o.perDay - c.today, affordable);
    if (left <= 0) return { available: false, left: 0, reason: "This society's sponsor wallet is empty. Ask the host to top it up." };
    return { available: true, left };
  }

  async function register(name: string, r: RegisterRequest): Promise<[number, Record<string, unknown>]> {
    const cap = capReason(today(), name);
    if (cap) return [429, { error: cap }];
    const owned = await o.chain.idOf(r.to);
    if (owned) return [409, { error: `${r.to} already owns FID ${owned}. Connect it instead.`, fid: owned }];
    const price = await o.chain.price();
    // 5% above the fee in case the price moves before the transaction lands; the rest is refunded.
    const value = (price * 105n) / 100n;
    if (!o.dryRun && (await o.chain.balance()) < value + GAS_RESERVE) {
      return [503, { error: "This society's sponsor wallet is empty. Ask the host to top it up." }];
    }
    try {
      await o.chain.simulate(r, value);
    } catch (e) {
      return [400, { error: `Optimism would reject this registration: ${shortError(e)}` }];
    }
    if (o.dryRun) return [200, { fid: 0, tx: "0x", dryRun: true }];
    const tx = await o.chain.send(r, value);
    const c = today();
    c.today++;
    c.members[name] = (c.members[name] ?? 0) + 1;
    o.counts.save(c);
    paidThisHour++;
    const fid = await o.chain.idOf(r.to);
    return [200, { fid, tx }];
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin && ORIGINS.has(origin) ? { vary: "Origin", "access-control-allow-origin": origin } : { vary: "Origin" };
    const reply = (code: number, body: Record<string, unknown>) => {
      if (!res.headersSent) res.writeHead(code, { ...HEADERS, ...cors }).end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") {
      const allow = cors["access-control-allow-origin"]
        ? { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type" }
        : {};
      res.writeHead(204, { ...cors, ...allow }).end();
      return;
    }
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    const name = token === undefined ? undefined : o.members().get(createHash("sha256").update(token).digest("hex"));
    if (name === undefined) return reply(401, { error: "missing or unknown token" });

    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/sponsor/status") {
      status(name).then(
        (s) => reply(200, s),
        (e) => reply(502, { error: `the sponsor cannot answer now: ${shortError(e)}` }),
      );
      return;
    }
    if (req.method !== "POST" || path !== "/sponsor/register") return reply(404, { error: "only GET /sponsor/status and POST /sponsor/register" });

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return reply(413, { error: "request body over 4 KiB" });
      let r: RegisterRequest;
      try {
        r = parseRegisterRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")), Math.floor(now() / 1000));
      } catch (e) {
        return reply(400, { error: e instanceof SyntaxError ? "the body is not JSON" : (e as Error).message });
      }
      serial(() => register(name, r)).then(
        ([code, body]) => reply(code, body),
        (e) => reply(502, { error: `the registration failed: ${shortError(e)}` }),
      );
    });
  }

  return {
    handle,
    // For the hourly report: accounts paid for since the last call, and today in all.
    report() {
      const n = paidThisHour;
      paidThisHour = 0;
      return { lastHour: n, today: today().today };
    },
  };
}
