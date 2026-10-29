// End-to-end test of mentions and notifications against a local Snapchain devnet, over HTTP.
// Throwaway FIDs, keys and fnames, made through the devnet's admin RPC.
//
//   docker compose -p kitdevnet -f scripts/devnet-compose.yml up -d
//   npx tsx scripts/e2e-phase1.ts [--save <dir>]
//   docker compose -p kitdevnet -f scripts/devnet-compose.yml down
//
// --save <dir> writes the accounts' app keys there (mode 600) for trying the web client on the
// devnet; they are devnet keys and worth nothing.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ViemLocalEip712Signer } from "@farcaster/core";
import type { HexString } from "../src/core/index.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, statSync } from "node:fs";
import { hexToBytes } from "viem";
import { addAppKey, cast, FeedBuilder, requestFidOf, follow, Hub, notificationsFor, notificationText, react, resolveMentions, type AppKey } from "../src/core/index.js";
import { addOnchainSigner, HTTP, network, onchainKey, registerFid, setUsername, until } from "./devnet-lib.js";
import { fakeFarcaster } from "../test/fake-farcaster.js";

const hub = new Hub({ url: HTTP });
let step = 0;
const log = (s: string) => console.log(`${String(++step).padStart(2)}. ${s}`);
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
}
const wait = { timeoutMs: 20_000, intervalMs: 500 };

async function account(fid: number, name: string): Promise<{ key: AppKey; name: string; custody: HexString }> {
  const custodyKey = generatePrivateKey();
  const custody = privateKeyToAccount(custodyKey);
  await registerFid(fid, custody.address);
  await until(`FID ${fid}`, async () => ((await hub.storageLimits(fid)).units > 0 ? true : undefined));
  const full = await onchainKey(hub, fid);
  await setUsername(hub, fid, custody.address, full, name);
  const { key, confirmed } = await addAppKey(hub, { fid, custody: new ViemLocalEip712Signer(custody), network }, wait);
  check(confirmed, `app key for ${fid}`);
  return { key, name, custody: custodyKey };
}

async function main() {
  const t0 = Date.now();
  const base = 300000 + Math.floor(Math.random() * 600000);
  const tag = base.toString(36);
  const save = process.argv.indexOf("--save") > 0 ? process.argv[process.argv.indexOf("--save") + 1] : undefined;
  const [me, friend, other, app] = await Promise.all([
    account(base, `me-${tag}`),
    account(base + 1, `friend-${tag}`),
    account(base + 2, `other-${tag}`),
    account(base + 3, `app-${tag}`),
  ]);
  log(`devnet ${HTTP}: @${me.name} (${me.key.fid}), @${friend.name} (${friend.key.fid}), @${other.name} (${other.key.fid}), each with a username and an app key`);

  // Mentions: the CLI path (names looked up on the node, checked against the signed profile).
  const m = await resolveMentions(hub, `🎉 gm @${friend.name} and @${other.name}!`);
  check("mentions" in m, "names resolved to mentions");
  const enc = new TextEncoder();
  check(m.mentions[0] === friend.key.fid && m.mentionsPositions[0] === enc.encode("🎉 gm ").length, "first mention FID and byte offset after the emoji");
  check(m.mentions[1] === other.key.fid && m.mentionsPositions[1] === enc.encode("🎉 gm  and ").length, "second mention");
  const mc = await cast(hub, me.key, m, wait);
  check(mc.confirmed, "mention cast merged");
  const stored = await hub.castById(me.key.fid, mc.hash);
  const b = stored?.data.castAddBody;
  check(b && JSON.stringify(b.mentions) === JSON.stringify(m.mentions) && JSON.stringify(b.mentionsPositions) === JSON.stringify(m.mentionsPositions), "node stores the mentions and positions as sent");
  const feed = new FeedBuilder(hub);
  const mine = await feed.fromAuthors([me.key.fid], { limit: 5 });
  check(mine[0]?.text === `🎉 gm @${friend.name} and @${other.name}!`, `feed renders the names (got "${mine[0]?.text}")`);
  log(`mention cast ${mc.hash.slice(0, 10)}: node has mentions [${b.mentions}] at bytes [${b.mentionsPositions}]; feed shows "${mine[0]!.text}"`);
  const unknown = await resolveMentions(hub, "hi @nobody-here-xyz").then(() => "accepted", (e: Error) => e.message);
  check(/unknown username @nobody-here-xyz/.test(unknown), "unknown name refused");
  log(`unknown @name refused: "${unknown.slice(0, 60)}…"`);

  // Notifications: friend replies, mentions, likes, recasts and follows; other also likes.
  const target = await cast(hub, me.key, { text: "a cast to get notifications on" }, wait);
  const t = { fid: me.key.fid, hash: target.hash };
  const reply = await cast(hub, friend.key, { text: "a reply from friend", replyTo: t }, wait);
  const mention = await cast(hub, friend.key, await resolveMentions(hub, `hey @${me.name}, look`), wait);
  const results = await Promise.all([
    react(hub, friend.key, "like", t, wait),
    react(hub, other.key, "like", t, wait),
    react(hub, friend.key, "recast", t, wait),
    follow(hub, friend.key, me.key.fid, wait),
  ]);
  check(reply.confirmed && mention.confirmed && results.every((r) => r.confirmed), "friend's and other's messages merged");
  log("friend replied, mentioned, liked, recast and followed; other liked");

  // Q4: the two new reads on Snapchain 0.15.0.
  const byMention = await hub.castsByMention(me.key.fid);
  const followers = await hub.linksByTarget(me.key.fid);
  check(byMention.items.some((x) => x.hash === mention.hash), "/v1/castsByMention returns the mention");
  check(followers.items.some((x) => x.data.fid === friend.key.fid), "/v1/linksByTargetFid returns the follower");
  log(`node API: /v1/castsByMention -> ${byMention.items.length} cast(s), /v1/linksByTargetFid -> ${followers.items.length} follower(s)`);

  const r = await notificationsFor(new FeedBuilder(hub), me.key.fid);
  const lines = r.items.map(notificationText);
  for (const l of lines) console.log(`      ${l}`);
  const kinds = r.items.map((n) => n.kind);
  check(kinds.includes("reply") && kinds.includes("mention") && kinds.includes("like") && kinds.includes("recast") && kinds.includes("follow"), `all five kinds (got ${kinds.join(", ")})`);
  const likes = r.items.find((n) => n.kind === "like" && n.target?.hash === target.hash);
  check(likes?.actors.length === 2, "two likes grouped into one item");
  for (let i = 1; i < r.items.length; i++) check(r.items[i - 1]!.time >= r.items[i]!.time, "newest first");
  check(r.failed.length === 0, "every source answered");
  log(`notifications: ${r.items.length} items, newest first, likes grouped (${likes.actors.map((a) => a.username).join(", ")})`);

  // The same from the CLI, with mark-read stored per FID.
  const home = mkdtempSync(join(tmpdir(), "outpost-e2e-"));
  writeFileSync(join(home, "appkey.json"), JSON.stringify(me.key), { mode: 0o600 });
  const cli = (...args: string[]) =>
    promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli/main.ts", "notifications", "--node", HTTP, "--rpc", "off", "--check-node", "off", "--show-unverified", ...args], { env: { ...process.env, OUTPOST_HOME: home } }).then((x) => x.stdout);
  const out1 = await cli();
  check(/followed you/.test(out1) && /replied/.test(out1) && /mentioned you/.test(out1) && /and @/.test(out1) && /recast your cast/.test(out1), "CLI lists all kinds");
  check(new RegExp(`${r.items.length} notifications for FID ${me.key.fid}, ${r.items.length} new`).test(out1), "CLI: all new before mark-read");
  await cli("--mark-read");
  const out3 = await cli();
  check(new RegExp(`, 0 new`).test(out3), "CLI: 0 new after mark-read");
  log("CLI: ./outpost cli notifications lists them; 0 new after --mark-read");

  // Approve in the Farcaster app, from the CLI. A stand-in for Farcaster's endpoint checks the
  // app account's signature; its "approval" adds the onchain key on the devnet, as the KeyGateway
  // would. A fourth account, made in "the app", signs in with no phrase.
  const appUser = await account(base + 4, `appuser-${tag}`);
  const appAddress = privateKeyToAccount(app.custody).address;
  const fc = await fakeFarcaster({
    appAddress,
    userFid: appUser.key.fid,
    autoApproveAfter: 2,
    onApprove: (r) => void addOnchainSigner(appUser.key.fid, hexToBytes(r.body.key), app.key.fid),
  });
  const appHome = mkdtempSync(join(tmpdir(), "outpost-e2e-app-"));
  writeFileSync(join(appHome, "app-account.json"), JSON.stringify({ fid: app.key.fid, custodyKey: app.custody, address: appAddress }), { mode: 0o600 });
  const login = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli/main.ts", "login", "--app", "--yes", "--network", "devnet", "--node", HTTP, "--rpc", "off", "--check-node", "off"], {
    env: { ...process.env, OUTPOST_HOME: appHome, OUTPOST_SIGNIN_API: fc.url },
  }).then((x) => x.stdout);
  fc.close();
  check(/full access and no expiry/.test(login) && /Manage connected apps/.test(login), "login --app warns before the QR code");
  check(/farcaster:\/\/signed-key-request\?token=0x/.test(login) && /[▀▄█]/.test(login), "login --app prints the link and a QR code");
  check(!login.includes(app.custody.slice(2)), "the app account's key is not printed");
  const saved = JSON.parse(readFileSync(join(appHome, "appkey.json"), "utf8")) as AppKey;
  check(saved.fid === appUser.key.fid && saved.onchain === true && saved.requestFid === app.key.fid, "saved key: the user's FID, onchain, requested by the app account");
  check((statSync(join(appHome, "appkey.json")).mode & 0o777) === 0o600, "key file mode 600");
  const signer = await hub.signer(saved.fid, saved.publicKey);
  check(signer?.source === "SIGNER_SOURCE_ONCHAIN" && requestFidOf(signer) === app.key.fid, "node lists it as an onchain key for the app FID");
  const viaApp = await cast(hub, saved, { text: "posted with a key approved in the app" }, wait);
  check(viaApp.confirmed, "cast with the approved key merged");
  const f2 = new FeedBuilder(hub);
  const items = await f2.fromAuthors([saved.fid], { limit: 1 });
  const names = await f2.appNames(items);
  check(items[0]?.app.requestFid === app.key.fid && names.get(app.key.fid) === app.name, `feed shows it via @${app.name}`);
  log(`login --app: QR + link printed, approved, key saved (onchain, mode 600), cast shows "via @${names.get(app.key.fid)}"`);

  if (save) {
    mkdirSync(save, { recursive: true, mode: 0o700 });
    writeFileSync(join(save, "app-account.json"), JSON.stringify({ fid: app.key.fid, custodyKey: app.custody, address: appAddress }), { mode: 0o600 });
    for (const [n, a] of [["me", me], ["friend", friend], ["other", other], ["appuser", appUser]] as const) {
      writeFileSync(join(save, `${n}.json`), JSON.stringify({ ...a.key, username: a.name, custody: a.custody }), { mode: 0o600 });
    }
    log(`devnet app keys saved in ${save}`);
  }
  console.log(`\nall ${step} steps passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
