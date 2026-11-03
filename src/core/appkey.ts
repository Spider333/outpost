// App keys: Ed25519 keys that sign everyday messages (casts, follows, reactions).
// Since May 2026 an app key is added with a gasless KEY_ADD message, not an Optimism transaction.
// The key is scoped (which message types it may sign) and expires after `ttl` seconds unused.

import {
  FarcasterNetwork,
  getFarcasterTime,
  makeKeyAdd,
  makeKeyAddBody,
  makeKeyRemove,
  makeKeyRemoveBodySelfRevoke,
  MessageType,
  NobleEd25519Signer,
  type Eip712Signer,
  type Message,
  ADMISSIBLE_KEY_ADD_SCOPES,
  MAX_KEY_ADD_SCOPES,
  MAX_KEY_TTL_SECONDS,
} from "@farcaster/core";
import { bytesToHex, hexToBytes } from "viem";
import { Hub, type HexString } from "./hub.js";

export const DEFAULT_SCOPES: MessageType[] = [
  MessageType.CAST_ADD,
  MessageType.CAST_REMOVE,
  MessageType.REACTION_ADD,
  MessageType.REACTION_REMOVE,
  MessageType.LINK_ADD,
  MessageType.LINK_REMOVE,
];

export const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

// How long the custody signature stays valid. Farcaster seconds, not Unix seconds.
const DEADLINE_SECONDS = 60 * 60;

export interface AppKey {
  fid: number;
  privateKey: HexString;
  publicKey: HexString;
  requestFid: number;
  scopes: MessageType[];
  ttl: number;
  network: FarcasterNetwork;
  // Approved in the Farcaster app (appsignin.ts): an onchain key with full access and no expiry,
  // which only the account's owner can remove. Outpost cannot revoke it.
  onchain?: boolean;
}

export function generatePrivateKey(): Uint8Array {
  const key = new Uint8Array(32);
  globalThis.crypto.getRandomValues(key);
  return key;
}

export function signerOf(key: AppKey): NobleEd25519Signer {
  return new NobleEd25519Signer(hexToBytes(key.privateKey));
}

export async function publicKeyOf(privateKey: Uint8Array): Promise<Uint8Array> {
  return unwrap(await new NobleEd25519Signer(privateKey).getSignerKey());
}

export function farcasterNow(): number {
  return unwrap(getFarcasterTime());
}

export interface KeyAddOptions {
  fid: number;
  custody: Eip712Signer;
  // Next user nonce. Read it with hub.signersByFid(fid).currentUserNonce + 1.
  nonce: number;
  scopes?: MessageType[];
  ttl?: number;
  // An app with its own FID signs the key request with that FID's custody key,
  // so other clients can tell its casts apart. Defaults to the user's own FID.
  requestFid?: number;
  requestSigner?: Eip712Signer;
  privateKey?: Uint8Array;
  network?: FarcasterNetwork;
  now?: number; // Farcaster seconds, for tests
}

// Builds a signed KEY_ADD. Nothing is sent; pass the result to hub.submit().
export async function buildKeyAdd(opts: KeyAddOptions): Promise<{ message: Message; key: AppKey }> {
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  const ttl = opts.ttl ?? DEFAULT_TTL_SECONDS;
  if (scopes.length === 0) throw new Error("an app key needs at least one scope");
  if (scopes.length > MAX_KEY_ADD_SCOPES || new Set(scopes).size !== scopes.length) throw new Error("scopes must be distinct, at most 16");
  const bad = scopes.filter((s) => !ADMISSIBLE_KEY_ADD_SCOPES.includes(s));
  if (bad.length) throw new Error(`these message types cannot be app key scopes: ${bad.join(", ")}`);
  if (!(Number.isInteger(ttl) && ttl > 0 && ttl <= MAX_KEY_TTL_SECONDS)) throw new Error(`ttl must be a whole number of seconds between 1 and 90 days`);
  if (opts.requestFid !== undefined && opts.requestFid !== opts.fid && !opts.requestSigner) {
    throw new Error("a different requestFid needs that app's custody signer");
  }
  const network = opts.network ?? FarcasterNetwork.MAINNET;
  const privateKey = opts.privateKey ?? generatePrivateKey();
  const appSigner = new NobleEd25519Signer(privateKey);
  const publicKey = unwrap(await appSigner.getSignerKey());
  const now = opts.now ?? farcasterNow();

  const body = unwrap(
    await makeKeyAddBody(
      {
        fid: BigInt(opts.fid),
        key: publicKey,
        scopes,
        ttl,
        nonce: opts.nonce,
        deadline: now + DEADLINE_SECONDS,
        requestFid: opts.requestFid !== undefined ? BigInt(opts.requestFid) : undefined,
      },
      opts.custody,
      opts.requestSigner,
    ),
  );
  // The envelope is signed by the new key itself: proof that we hold it.
  const message = unwrap(await makeKeyAdd(body, { fid: opts.fid, network, timestamp: now }, appSigner));
  return {
    message,
    key: {
      fid: opts.fid,
      privateKey: bytesToHex(privateKey),
      publicKey: bytesToHex(publicKey),
      requestFid: opts.requestFid ?? opts.fid,
      scopes,
      ttl,
      network,
    },
  };
}

// Builds a KEY_REMOVE signed by the key itself. No custody key, no seed phrase.
// `nonce` is the app nonce for the key's requestFid, not the user nonce.
export async function buildSelfRevoke(key: AppKey, nonce: number, now = farcasterNow()): Promise<Message> {
  const body = unwrap(makeKeyRemoveBodySelfRevoke({ key: hexToBytes(key.publicKey), nonce, deadline: now + DEADLINE_SECONDS }));
  return unwrap(await makeKeyRemove(body, { fid: key.fid, network: key.network, timestamp: now }, signerOf(key)));
}

// Adds a key end to end: read the nonce, sign, submit, then wait until the node shows it.
// `onSubmitted` runs right after the node accepts the message, before waiting, so the caller
// can save the key: a key that merges late must not be lost.
export async function addAppKey(
  hub: Hub,
  opts: Omit<KeyAddOptions, "nonce">,
  wait: { timeoutMs?: number; intervalMs?: number } = {},
  onSubmitted?: (key: AppKey) => void | Promise<void>,
): Promise<{ key: AppKey; confirmed: boolean }> {
  const signers = await hub.signersByFid(opts.fid);
  const { message, key } = await buildKeyAdd({ ...opts, nonce: signers.currentUserNonce + 1 });
  await hub.submit(message);
  await onSubmitted?.(key);
  const seen = await waitFor(() => hub.signer(key.fid, key.publicKey), wait);
  return { key, confirmed: !!seen };
}

export async function revokeAppKey(hub: Hub, key: AppKey, wait: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const signers = await hub.signersByFid(key.fid, key.requestFid);
  const current = signers.requesterFidNonces?.[String(key.requestFid)];
  if (current === undefined) throw new Error(`the node did not return the app nonce for requestFid ${key.requestFid}`);
  await hub.submit(await buildSelfRevoke(key, current + 1));
  const gone = await waitFor(async () => ((await hub.signer(key.fid, key.publicKey)) ? undefined : true), wait);
  if (!gone) throw new Error("revocation was accepted but the key is still listed. Check again in a minute.");
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  { timeoutMs = 30_000, intervalMs = 1_500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() >= end) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// @farcaster/core returns neverthrow Results; turn errors into exceptions with a readable message.
export function unwrap<T>(r: { isErr(): boolean; value?: T; error?: unknown }): T {
  if (r.isErr()) {
    const e = r.error as { message?: string; errCode?: string };
    throw new Error(e?.message ? `${e.errCode ? e.errCode + ": " : ""}${e.message}` : String(r.error));
  }
  return r.value as T;
}
