// Helpers for scripts that run against the local Snapchain devnet (scripts/devnet-compose.yml).
// Accounts, keys and usernames are made through the devnet's admin RPC (synthetic onchain events
// and fname proofs, which only a devnet accepts). Never point these at mainnet.

import { randomBytes } from "node:crypto";
import {
  FarcasterNetwork,
  IdRegisterEventType,
  makeUserDataAdd,
  OnChainEvent,
  OnChainEventType,
  SignerEventType,
  UserDataType,
  UserNameProof,
  UserNameType,
  encodeGaslessSignedKeyRequestMetadata,
} from "@farcaster/core";
import { getAdminRpcClient, getAuthMetadata } from "@farcaster/hub-nodejs";
import { bytesToHex, hexToBytes } from "viem";
import { farcasterNow, generatePrivateKey, Hub, publicKeyOf, signerOf, unwrap, type AppKey, type HexString } from "../src/core/index.js";

export const HTTP = process.env.OUTPOST_E2E_HTTP ?? "http://127.0.0.1:23381";
export const GRPC = process.env.OUTPOST_E2E_GRPC ?? "127.0.0.1:23383";
export const network = FarcasterNetwork.DEVNET;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function admin<T>(fn: (c: Awaited<ReturnType<typeof getAdminRpcClient>>, md: ReturnType<typeof getAuthMetadata>) => Promise<T>): Promise<T> {
  const c = await getAdminRpcClient(GRPC);
  try {
    return await fn(c, getAuthMetadata("dev", "dev"));
  } finally {
    c.close();
  }
}

export async function submitEvents(events: OnChainEvent[]) {
  await admin(async (c, md) => {
    for (const e of events) {
      const r = await c.submitOnChainEvent(e, md);
      if (r.isErr()) throw new Error(`admin submit failed: ${r.error.message}`);
    }
  });
}

// Mirrors snapchain's cli/src/factory.rs: timestamp 10 s in the past, block number derived from it.
export function baseEvent(type: OnChainEventType, fid: number): OnChainEvent {
  const ts = Math.floor(Date.now() / 1000) - 10;
  return OnChainEvent.create({
    type,
    chainId: 10,
    blockNumber: ts * 1024 + Math.floor(Math.random() * 1000),
    blockHash: new Uint8Array(),
    blockTimestamp: ts,
    transactionHash: randomBytes(32),
    logIndex: 0,
    fid,
    txIndex: 0,
    version: 1,
  });
}

export async function registerFid(fid: number, custody: HexString) {
  const rent = baseEvent(OnChainEventType.EVENT_TYPE_STORAGE_RENT, fid);
  rent.storageRentEventBody = { expiry: 0, units: 1, payer: randomBytes(32) };
  const reg = baseEvent(OnChainEventType.EVENT_TYPE_ID_REGISTER, fid);
  reg.idRegisterEventBody = { to: hexToBytes(custody), eventType: IdRegisterEventType.REGISTER, from: new Uint8Array(), recoveryAddress: new Uint8Array() };
  await submitEvents([rent, reg]);
}

// An onchain key (full access, no expiry) whose SignedKeyRequest metadata names `requestFid`, as
// a KeyGateway add from the Farcaster app's approval would.
export async function addOnchainSigner(fid: number, key: Uint8Array, requestFid: number) {
  const ev = baseEvent(OnChainEventType.EVENT_TYPE_SIGNER, fid);
  const metadata = encodeGaslessSignedKeyRequestMetadata({
    requestFid: BigInt(requestFid),
    requestSigner: "0x00000000000000000000000000000000000000aa",
    signature: new Uint8Array(65),
    deadline: 1n,
  })._unsafeUnwrap();
  ev.signerEventBody = { key, keyType: 1, eventType: SignerEventType.ADD, metadata, metadataType: 1 };
  await submitEvents([ev]);
}

export async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined && v !== null && (v as unknown) !== false) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

// A full-access onchain key for `fid`, requested by the account itself, as an AppKey.
export async function onchainKey(hub: Hub, fid: number, requestFid = fid): Promise<AppKey> {
  const priv = generatePrivateKey();
  const pub = await publicKeyOf(priv);
  await addOnchainSigner(fid, pub, requestFid);
  await until(`onchain key for ${fid}`, () => hub.signer(fid, bytesToHex(pub)));
  return { fid, privateKey: bytesToHex(priv), publicKey: bytesToHex(pub), requestFid, scopes: [], ttl: 0, network };
}

// An fname for `fid` (devnet skips the fname server's signature), then the USERNAME user data,
// signed with a key of the account that may sign user data.
export async function setUsername(hub: Hub, fid: number, owner: HexString, key: AppKey, name: string) {
  const proof = UserNameProof.create({ timestamp: Math.floor(Date.now() / 1000), name: new TextEncoder().encode(name), owner: hexToBytes(owner), signature: new Uint8Array(65), fid, type: UserNameType.USERNAME_TYPE_FNAME });
  await admin(async (c, md) => {
    const r = await c.submitUserNameProof(proof, md);
    if (r.isErr()) throw new Error(`fname proof failed: ${r.error.message}`);
  });
  await until(`fname ${name}`, () => hub.fidByUsername(name));
  const m = unwrap(await makeUserDataAdd({ type: UserDataType.USERNAME, value: name }, { fid, network, timestamp: farcasterNow() }, signerOf(key)));
  await until(`username ${name} accepted`, () => hub.submit(m).then(() => true));
  await until(`username ${name} on the node`, async () => (await hub.userDataByFid(fid)).items.some((u) => u.data.userDataBody?.value === name) || undefined);
}
