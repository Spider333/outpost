// "Approve in the Farcaster app": sign in without a recovery phrase, for accounts made in the
// Farcaster app. Farcaster's documented signed key request flow
// (farcasterxyz/docs, docs/reference/farcaster/signer-requests.md):
//
//   1. Outpost makes a new Ed25519 key. Its private part stays where it was made (the browser,
//      or the CLI).
//   2. An "app account" (an FID set up once by the node or client owner) signs a
//      SignedKeyRequest (EIP-712) for the public key with its custody key. That key lives only on
//      the owner's machine or server (`./outpost app-account`), never in a browser.
//   3. The request goes to Farcaster's endpoint, which answers with a farcaster:// link (a QR
//      code). A link alone cannot work: it carries the token this endpoint hands out. No API key.
//   4. The person approves in the Farcaster app, which adds the key onchain (KeyRegistry) and
//      pays the fee, unless the app account sponsors it.
//   5. Outpost confirms the key on its own node (/v1/signer) before using it.
//
// Such a key is an ordinary onchain key: it can sign every kind of message for the account, has
// no expiry, and only the account's owner can remove it (in the Farcaster app). Outpost cannot
// revoke it, so the page says so before showing the QR code.

import { ViemLocalEip712Signer } from "@farcaster/core";
import { bytesToHex, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { unwrap } from "./appkey.js";
import type { HexString } from "./hub.js";

// Farcaster's client API: the one host besides your node that this flow talks to, and only from
// the Outpost server or CLI, never from the page.
export const FARCASTER_API = "https://api.farcaster.xyz";

// How long the app account's signature stays valid. Farcaster suggests a day; an approval that
// has not happened within this time is shown as expired.
export const REQUEST_SECONDS = 30 * 60;

// The app account, as stored by `./outpost app-account` (mode 600). `custodyKey` is the
// account's custody private key: whoever has it owns that account.
export interface AppAccount {
  fid: number;
  custodyKey: HexString;
  address: HexString;
  sponsor?: boolean; // also sign Farcaster's sponsorship, so the person pays no fee
}

export interface KeyRequestBody {
  key: HexString;
  requestFid: number;
  signature: HexString;
  deadline: number; // Unix seconds
  sponsorship?: { sponsorFid: number; signature: HexString };
}

export function isPublicKey(k: unknown): k is HexString {
  return typeof k === "string" && /^0x[0-9a-f]{64}$/i.test(k);
}

export async function signKeyRequest(account: AppAccount, key: HexString, now = Math.floor(Date.now() / 1000)): Promise<KeyRequestBody> {
  if (!isPublicKey(key)) throw new Error("the key must be a 32-byte Ed25519 public key in hex");
  const signer = privateKeyToAccount(account.custodyKey);
  if (signer.address.toLowerCase() !== account.address.toLowerCase()) throw new Error("the app account's key does not match its address");
  const deadline = now + REQUEST_SECONDS;
  const signature = bytesToHex(
    unwrap(await new ViemLocalEip712Signer(signer).signKeyRequest({ requestFid: BigInt(account.fid), key: hexToBytes(key), deadline: BigInt(deadline) })),
  );
  const body: KeyRequestBody = { key: key.toLowerCase() as HexString, requestFid: account.fid, signature, deadline };
  // Farcaster's sponsorship: an EIP-191 signature, by the sponsoring FID, of the request signature.
  if (account.sponsor) body.sponsorship = { sponsorFid: account.fid, signature: await signer.signMessage({ message: { raw: signature } }) };
  return body;
}

export type RequestState = "pending" | "approved" | "completed";
// What the Outpost server reports: Farcaster's states, or expired once the deadline has passed.
export type SignInState = RequestState | "expired";

export interface KeyRequest {
  token: string;
  deeplinkUrl: string;
  state: RequestState;
  userFid?: number;
}

const TOKEN = /^0x[0-9a-f]{1,128}$/i;
const LINK = /^farcaster:\/\/signed-key-request\?token=0x[0-9a-f]{1,128}$/i;

export function isToken(t: unknown): t is string {
  return typeof t === "string" && TOKEN.test(t);
}

// Only the fields Outpost uses, checked, so nothing else from the endpoint reaches the page.
function keyRequestFrom(json: unknown): KeyRequest {
  const r = (json as { result?: { signedKeyRequest?: Record<string, unknown> } })?.result?.signedKeyRequest;
  const { token, deeplinkUrl, state, userFid } = r ?? {};
  if (!isToken(token) || typeof deeplinkUrl !== "string" || !LINK.test(deeplinkUrl) || !["pending", "approved", "completed"].includes(state as string)) {
    throw new Error("Farcaster's endpoint gave an answer Outpost does not understand");
  }
  if (userFid !== undefined && !(Number.isSafeInteger(userFid) && (userFid as number) > 0)) throw new Error("Farcaster's endpoint returned a bad FID");
  return { token, deeplinkUrl, state: state as RequestState, userFid: userFid as number | undefined };
}

async function call(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<KeyRequest> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(`cannot reach Farcaster's endpoint (${(e as Error).message})`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Farcaster's endpoint refused the request (HTTP ${res.status})`);
  try {
    return keyRequestFrom(JSON.parse(text));
  } catch (e) {
    throw e instanceof SyntaxError ? new Error("Farcaster's endpoint did not answer with JSON") : e;
  }
}

export function createKeyRequest(body: KeyRequestBody, api = FARCASTER_API, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<KeyRequest> {
  return call(fetchImpl, `${api}/v2/signed-key-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function keyRequestState(token: string, api = FARCASTER_API, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<KeyRequest> {
  if (!isToken(token)) return Promise.reject(new Error("not a request token"));
  return call(fetchImpl, `${api}/v2/signed-key-request?token=${encodeURIComponent(token)}`);
}

// ---- the page's side: it asks its own Outpost server (or a society node), never Farcaster.

export interface SignInService {
  configured: boolean;
  fid?: number;
  sponsored?: boolean;
}

export interface StartedRequest {
  token: string;
  deeplinkUrl: string;
  deadline: number;
  requestFid: number;
}

export class SignInClient {
  constructor(
    readonly base: string, // e.g. "" (same origin) or "https://society.example/app-signin"
    private readonly headers: Record<string, string> = {},
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers: { ...this.headers, ...(init?.headers as Record<string, string>) } });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  }

  // Undefined when nothing answers there (a static host, or an Outpost too old for this).
  async service(): Promise<SignInService | undefined> {
    try {
      const s = await this.json<SignInService>("");
      return typeof s.configured === "boolean" ? s : undefined;
    } catch {
      return undefined;
    }
  }

  start(key: HexString): Promise<StartedRequest> {
    return this.json("", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  }

  state(token: string): Promise<{ state: SignInState; userFid?: number }> {
    return this.json(`/state?token=${encodeURIComponent(token)}`);
  }
}
