// Sponsored accounts: a society node can pay for a member's new Farcaster account. The member's
// browser makes the account's key (or uses their wallet) and signs Register, which is free. The
// host's sponsor service (src/server/sponsor.ts) calls IdGateway.registerFor and pays the fee,
// one storage unit ($0.20 in October 2026). The sponsor never sees the key: the account belongs
// to the member from its first block.

import type { HexString } from "./hub.js";

export interface SponsorStatus {
  available: boolean;
  // Accounts this member can get right now.
  left: number;
  // Why not, when not available.
  reason?: string;
}

export interface RegisterRequest {
  to: HexString;
  recovery: HexString;
  // Unix seconds, as a decimal string.
  deadline: string;
  signature: HexString;
}

export interface Sponsored {
  fid: number;
  tx: HexString;
  dryRun?: boolean;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
export const REGISTER_DEADLINE_SECONDS = 3600;

// Checks a request's shape and deadline. Whether the signature is good is IdGateway's call.
export function parseRegisterRequest(body: unknown, nowSeconds: number): RegisterRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("expected a JSON object");
  const { to, recovery, deadline, signature } = body as Record<string, unknown>;
  if (typeof to !== "string" || !ADDRESS.test(to)) throw new Error("to must be an address");
  if (typeof recovery !== "string" || !ADDRESS.test(recovery)) throw new Error("recovery must be an address");
  if (typeof deadline !== "string" || !/^\d{1,12}$/.test(deadline)) throw new Error("deadline must be Unix seconds");
  const d = Number(deadline);
  if (d < nowSeconds + 60 || d > nowSeconds + REGISTER_DEADLINE_SECONDS + 60) throw new Error("deadline must be between 1 minute and 1 hour from now");
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) throw new Error("signature must be 65 bytes of hex");
  return { to: to as HexString, recovery: recovery as HexString, deadline, signature: signature as HexString };
}

async function call<T>(node: string, token: string, path: string, init: RequestInit, timeoutMs: number, fetchFn: typeof fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`${node}/sponsor/${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`cannot reach the sponsor at ${node}: ${(e as Error).message}`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await res.text()) as Record<string, unknown>;
  } catch {
    // Not JSON: the status code says enough.
  }
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `the sponsor answered HTTP ${res.status}`);
  return body as T;
}

// Whether this society node will pay for an account for this member. A node without a sponsor
// answers with an error, which the caller shows as "not available here".
export function sponsorStatus(node: string, token: string, fetchFn: typeof fetch = fetch): Promise<SponsorStatus> {
  return call<SponsorStatus>(node, token, "status", {}, 15_000, fetchFn);
}

// Waits while the sponsor sends the transaction and Optimism includes it (seconds, usually).
export function sponsorRegister(node: string, token: string, req: RegisterRequest, fetchFn: typeof fetch = fetch): Promise<Sponsored> {
  const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) };
  return call<Sponsored>(node, token, "register", init, 150_000, fetchFn);
}
