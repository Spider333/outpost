// End-to-end test of the client core against a local Snapchain devnet.
// Registers throwaway FIDs through the devnet's admin RPC (synthetic onchain events, which
// only a devnet accepts), then runs the real flow over HTTP:
//   gasless KEY_ADD (with a separate app FID as requester) -> cast -> follow -> like ->
//   recast -> following feed with app filter -> charter verify + census -> self-revoke.
//
//   docker compose -p kitdevnet -f scripts/devnet-compose.yml up -d
//   npx tsx scripts/e2e-devnet.ts
//   docker compose -p kitdevnet -f scripts/devnet-compose.yml down

import { randomBytes } from "node:crypto";
import {
  FarcasterNetwork,
  IdRegisterEventType,
  OnChainEvent,
  OnChainEventType,
  SignerEventType,
  ViemLocalEip712Signer,
  encodeGaslessSignedKeyRequestMetadata,
} from "@farcaster/core";
import { getAdminRpcClient, getAuthMetadata } from "@farcaster/hub-nodejs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bytesToHex, hexToBytes } from "viem";
import {
  addAppKey,
  cast,
  census,
  FeedBuilder,
  follow,
  generatePrivateKey as generateEd25519,
  Hub,
  publicKeyOf,
  react,
  resolveAccount,
  revokeAppKey,
  signCharter,
  verifyCharter,
  type HexString,
} from "../src/core/index.js";

const HTTP = process.env.OUTPOST_E2E_HTTP ?? "http://127.0.0.1:23381";
const GRPC = process.env.OUTPOST_E2E_GRPC ?? "127.0.0.1:23383";
const hub = new Hub({ url: HTTP });
const network = FarcasterNetwork.DEVNET;

let step = 0;
const log = (s: string) => console.log(`${String(++step).padStart(2)}. ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
}

async function submitEvents(events: OnChainEvent[]) {
  const admin = await getAdminRpcClient(GRPC);
  const md = getAuthMetadata("dev", "dev");
  for (const e of events) {
    const r = await admin.submitOnChainEvent(e, md);
    if (r.isErr()) throw new Error(`admin submit failed: ${r.error.message}`);
  }
  admin.close();
}

// Mirrors snapchain's cli/src/factory.rs: timestamp 10 s in the past, block number derived from it.
function baseEvent(type: OnChainEventType, fid: number): OnChainEvent {
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

async function registerFid(fid: number, custody: HexString) {
  const rent = baseEvent(OnChainEventType.EVENT_TYPE_STORAGE_RENT, fid);
  rent.storageRentEventBody = { expiry: 0, units: 1, payer: randomBytes(32) };
  const reg = baseEvent(OnChainEventType.EVENT_TYPE_ID_REGISTER, fid);
  reg.idRegisterEventBody = { to: hexToBytes(custody), eventType: IdRegisterEventType.REGISTER, from: new Uint8Array(), recoveryAddress: new Uint8Array() };
  await submitEvents([rent, reg]);
}

// An onchain app key whose SignedKeyRequest metadata names `requestFid`, as a KeyGateway add would.
async function addOnchainSigner(fid: number, key: Uint8Array, requestFid: number) {
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

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined && v !== null && (v as unknown) !== false) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function main() {
  const t0 = Date.now();
  const base = 300000 + Math.floor(Math.random() * 600000);
  const USER = base, APP = base + 1, FRIEND = base + 2, OTHER_APP = base + 3;
  const userCustody = privateKeyToAccount(generatePrivateKey());
  const appCustody = privateKeyToAccount(generatePrivateKey());
  const friendCustody = privateKeyToAccount(generatePrivateKey());

  console.log(`devnet ${HTTP}  user ${USER}  app ${APP}  friend ${FRIEND}`);
  await Promise.all([registerFid(USER, userCustody.address), registerFid(APP, appCustody.address), registerFid(FRIEND, friendCustody.address)]);
  const account = await until("user FID to appear", async () => resolveAccount(hub, userCustody.address));
  check(account.fid === USER, "FID lookup by custody address");
  check(account.storageUnits >= 1, "storage rented");
  log(`registered FIDs; resolveAccount(custody) -> FID ${account.fid}, ${account.storageUnits} storage unit(s)`);

  // Friend posts with an onchain key requested by OTHER_APP, so the feed has two apps.
  const friendKey = generateEd25519();
  const friendPub = await publicKeyOf(friendKey);
  await addOnchainSigner(FRIEND, friendPub, OTHER_APP);
  await until("friend's onchain signer", () => hub.signer(FRIEND, bytesToHex(friendPub)));

  // Gasless KEY_ADD for the user, requested by APP (signed by APP's custody key).
  const before = await hub.signersByFid(USER);
  const { key, confirmed } = await addAppKey(
    hub,
    { fid: USER, custody: new ViemLocalEip712Signer(userCustody), requestFid: APP, requestSigner: new ViemLocalEip712Signer(appCustody), network },
    { timeoutMs: 20_000, intervalMs: 500 },
  );
  check(confirmed, "KEY_ADD merged");
  const s = await hub.signer(USER, key.publicKey);
  check(s?.source === "SIGNER_SOURCE_OFFCHAIN", "key is a gasless (offchain) signer");
  check(s?.requestFid === APP, "node reports requestFid = app FID");
  check((s?.scopes ?? []).length === 6, "6 scopes");
  const after = await hub.signersByFid(USER);
  check(after.currentUserNonce === before.currentUserNonce + 1, "user nonce advanced by 1");
  log(`gasless KEY_ADD merged: source ${s.source}, requestFid ${s.requestFid}, scopes ${s.scopes!.join(",").replace(/MESSAGE_TYPE_/g, "")}, ttl ${s.ttl}s, nonce ${before.currentUserNonce} -> ${after.currentUserNonce}`);

  // Friend casts with the onchain key (a plain, valid message from a second app).
  const friend = { fid: FRIEND, privateKey: bytesToHex(friendKey), publicKey: bytesToHex(friendPub), requestFid: OTHER_APP, scopes: [], ttl: 1, network };
  const fc = await cast(hub, friend, { text: "hello from the friend, via another app" }, { timeoutMs: 15_000, intervalMs: 500 });
  check(fc.confirmed, "friend cast merged");

  const c1 = await cast(hub, key, { text: "first cast from outpost e2e" }, { timeoutMs: 15_000, intervalMs: 500 });
  check(c1.confirmed, "cast merged");
  log(`cast ${c1.hash} merged (read back by hash)`);

  const f = await follow(hub, key, FRIEND, { timeoutMs: 15_000, intervalMs: 500 });
  check(f.confirmed, "follow merged");
  log(`follow ${FRIEND} merged`);

  const like = await react(hub, key, "like", { fid: FRIEND, hash: fc.hash }, { timeoutMs: 15_000, intervalMs: 500 });
  const recast = await react(hub, key, "recast", { fid: FRIEND, hash: fc.hash }, { timeoutMs: 15_000, intervalMs: 500 });
  check(like.confirmed && recast.confirmed, "like and recast merged");
  log(`like and recast of ${fc.hash} merged`);

  // Following feed, traced to apps, and the filter.
  const feed = new FeedBuilder(hub);
  const t = Date.now();
  const all = await feed.following(USER);
  const ms = Date.now() - t;
  const byText = Object.fromEntries(all.map((i) => [i.text, i]));
  check(all.length === 2, `feed has 2 casts (got ${all.length})`);
  check(byText["first cast from outpost e2e"]?.app.requestFid === APP, "own cast attributed to the app FID (gasless)");
  check(byText["hello from the friend, via another app"]?.app.requestFid === OTHER_APP, "friend cast attributed via onchain metadata");
  const onlyApp = await feed.following(USER, { filter: { include: [APP] } });
  const noApp = await feed.following(USER, { filter: { exclude: [APP] } });
  check(onlyApp.length === 1 && onlyApp[0]!.app.requestFid === APP, "include filter");
  check(noApp.length === 1 && noApp[0]!.app.requestFid === OTHER_APP, "exclude filter");
  log(`feed: ${all.length} casts in ${ms} ms; include ${APP} -> ${onlyApp.length}, exclude ${APP} -> ${noApp.length}`);

  // Charter: signed by the app FID's custody key, checked on the node, census by hand.
  const charter = await signCharter(
    { charter: 1, name: "e2e society", issuer: { fid: APP }, members: [USER, FRIEND], issuedAt: new Date().toISOString() },
    appCustody,
  );
  const v = await verifyCharter(charter, hub);
  check(v.ok && v.issuerCheck === "custody", "charter verified against issuer custody on the node");
  const tampered = { ...charter, members: [USER, FRIEND, 1] };
  check(!(await verifyCharter(tampered, hub)).ok, "tampered charter rejected");
  const cen = await census(hub, charter, { days: 7 });
  check(cen.members === 2 && cen.active === 2 && cen.casts === 2, `census 2 members, 2 active, 2 casts (got ${cen.members}/${cen.active}/${cen.casts})`);
  log(`charter verified (issuer custody), tampered copy rejected, census ${cen.members} members / ${cen.active} active / ${cen.casts} casts = hand count`);

  // Self-revoke: no custody key involved.
  await revokeAppKey(hub, key, { timeoutMs: 20_000, intervalMs: 500 });
  check(!(await hub.signer(USER, key.publicKey)), "key gone after self-revoke");
  const late = await cast(hub, key, { text: "this must fail" }, { timeoutMs: 3_000 }).then(
    () => "accepted",
    (e: Error) => e.message,
  );
  check(late !== "accepted", "revoked key can no longer post");
  const survived = await hub.castById(USER, c1.hash);
  log(`self-revoke merged; key removed; posting now fails ("${late.slice(0, 70)}"); earlier cast still present: ${!!survived}`);

  console.log(`\nall ${step} steps passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
