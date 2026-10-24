#!/usr/bin/env node
// Command-line client. Every read and write goes to your own node.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { FarcasterNetwork, MessageData, ViemLocalEip712Signer, type Message } from "@farcaster/core";
import { privateKeyToAccount } from "viem/accounts";
import {
  addAppKey,
  buildCast,
  buildCastRemove,
  buildFollow,
  buildKeyAdd,
  buildReaction,
  buildReactionRemove,
  buildSelfRevoke,
  buildUnfollow,
  cast,
  custodyFromSeedPhrase,
  deleteCast,
  follow,
  Hub,
  HubError,
  react,
  resolveAccount,
  revokeAppKey,
  syncState,
  unfollow,
  unreact,
  FeedBuilder,
  parseAppSelector,
  checkNodeUrl,
  checkToken,
  DEFAULT_CHECK_NODE,
  DEFAULT_OPTIMISM_RPC,
  Optimism,
  secondNode,
  Verifier,
  type AppFilter,
  type FeedItem,
  type AppKey,
  type HexString,
  type Reaction,
} from "../core/index.js";
import { askHidden, confirm, printable } from "./prompt.js";
import { cmdCharter, verificationNote } from "./charter.js";
import { deleteKey, keyPath, loadKey, saveKey } from "./store.js";

const WARNING = `
  STOP. Read this before you paste a recovery phrase.

  A recovery phrase is the custody key of an account. Whoever has it can
  transfer the account, add or remove every app key, and change the username.
  Pasting it into the wrong program is like running rm -rf / as root: there
  is no undo.

  - Use a TEST account only. Never your main account.
  - Only paste it into software whose code you have read, or whose author
    you trust.
  - Prefer the web client's "sign with wallet" button. The phrase then never
    leaves your wallet.

  What this program does with it: derives the custody address in memory,
  signs ONE authorization for a scoped, expiring app key, and then drops it.
  It never writes the phrase to disk and never sends it over the network.
  Only the app key is saved, to ${keyPath()} (mode 600).
`;

const USAGE = `usage: ./outpost cli <command> [options]

  status                         node sync state
  login                          import a TEST account's phrase, add a gasless app key
  whoami                         show the saved app key and its expiry
  cast <text> [--reply fid:0xhash] [--channel url] [--embed url]
  delete <0xhash>                remove one of your casts
  follow <fid> | unfollow <fid>
  like <fid> <0xhash> | unlike <fid> <0xhash>
  recast <fid> <0xhash> | unrecast <fid> <0xhash>
  feed [--fid n] [--channel url] [--include apps] [--exclude apps] [--limit n]
                                 following feed (or a channel) from your node. apps is a
                                 comma list of app FIDs, "self" or "unknown"
  charter new <file>             start a charter file
  charter sign <in> <out>        sign it with the society's key ($CHARTER_PRIVATE_KEY or phrase)
  charter verify <file|url>      check the signature and the issuer's custody on your node;
                                 for a charter log, recount every amendment from your node
  charter census <file|url> [days]   members, active members, casts per day, app mix
  charter feed <file|url>        the society's feed through its lens
  charter join <file|url>        follow its members with your app key
  charter proposals <log> [days] society votes: add every amendment that has passed to the
                                 log file, list open proposals and their approvals
  charter propose <log> --add <user|fid> [--remove ..] [--add-mod ..] [--remove-mod ..]
                                 post a proposal and approve it. Members approve by liking it,
                                 in any app; it passes when more than half of them have
  charter announce <log>         reply under the last passed proposal with the result
  charter import <theirs> <log>  take a member's newer log, if it extends yours and recounts
  uninstall                      revoke the app key (no phrase needed) and delete it
  selftest                       sign every message type with throwaway keys and
                                 ask the node to validate them (sends nothing)

options:
  --node <url>        node HTTP API (default $OUTPOST_NODE_URL or http://127.0.0.1:3381)
  --token-file <path> access token for a society node, read from this file. Tokens are never
                      taken from the command line, where other users and shell history see them
  --rpc <url>         Optimism RPC for key and custody checks (default $OUTPOST_OPTIMISM_RPC or
                      ${DEFAULT_OPTIMISM_RPC}; "off" skips them)
  --check-node <url>  second node asked about gasless app keys, which have no onchain record
                      (default $OUTPOST_CHECK_NODE or ${DEFAULT_CHECK_NODE}; "off" skips it)
  --show-unverified   also show casts whose signing key could not be checked (marked); by
                      default they are hidden
  --ttl-days <n>      app key expiry after last use, 1-90 (default 30)
  --trust-unrecountable  use a charter log even if a version's majority rests on approvals
                      whose keys cannot be checked now (revoked since, or listed by no node)

Every message read from the node is verified here (hash, signature, account) before use.
`;

function hubFromEnv(v: { node?: string; "token-file"?: string; rpc?: string; "check-node"?: string; "show-unverified"?: boolean }): { hub: Hub; chain?: Optimism } {
  const rpc = v.rpc ?? process.env.OUTPOST_OPTIMISM_RPC ?? DEFAULT_OPTIMISM_RPC;
  const chain = rpc === "off" ? undefined : new Optimism(rpc);
  const url = v.node ?? process.env.OUTPOST_NODE_URL ?? "http://127.0.0.1:3381";
  const tokenFile = v["token-file"];
  // A token goes only to https (or this machine), so it never crosses a network in the clear.
  const auth = tokenFile
    ? { url: checkNodeUrl(url), token: checkToken(readFileSync(tokenFile, "utf8")) }
    : { url, username: process.env.OUTPOST_NODE_USER, password: process.env.OUTPOST_NODE_PASSWORD };
  const check = v["check-node"] ?? process.env.OUTPOST_CHECK_NODE ?? DEFAULT_CHECK_NODE;
  const second = check === "off" ? undefined : secondNode(checkNodeUrl(check), auth.url);
  if (check !== "off" && !second) console.error("note: the second node is the node being read, so gasless keys are not checked");
  const verifier = new Verifier(chain, second);
  verifier.showUnverified = !!v["show-unverified"];
  const own = loadKey();
  if (own) verifier.trust(own.fid, own.publicKey);
  return { hub: new Hub({ ...auth, verifier }), chain };
}


function requireKey(): AppKey {
  const key = loadKey();
  if (!key) throw new Error(`no app key found at ${keyPath()}. Run: ./outpost cli login`);
  return key;
}

function parseFid(s: string | undefined): number {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`not an FID: ${s}`);
  return n;
}

function parseHash(s: string | undefined): HexString {
  if (!s || !/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`not a cast hash (0x + 40 hex chars): ${s}`);
  return s.toLowerCase() as HexString;
}

function parseCastRef(s: string): { fid: number; hash: HexString } {
  const [fid, hash] = s.split(":");
  return { fid: parseFid(fid), hash: parseHash(hash) };
}

function report(what: string, r: { hash: HexString; confirmed: boolean }) {
  console.log(
    r.confirmed
      ? `${what}: ${r.hash} (confirmed: your node returns it)`
      : `${what}: ${r.hash} (accepted for relay, not seen yet. Check again in a minute.)`,
  );
}

async function cmdStatus(hub: Hub) {
  const info = await hub.info();
  const { synced, maxDelay } = syncState(info);
  console.log(printable(`node ${hub.url}  version ${info.version}`));
  for (const s of info.shardInfos) {
    const note = s.shardId === 0 ? " (block shard: app keys and storage)" : "";
    console.log(printable(`  shard ${s.shardId}: height ${s.maxHeight}, ${s.blockDelay} blocks behind, ${s.numMessages} messages${note}`));
  }
  console.log(synced ? "synced: yes" : `synced: no (furthest shard is ${maxDelay} blocks behind)`);
}

async function cmdLogin(hub: Hub, ttlDays: number, network: FarcasterNetwork, chain?: Optimism) {
  const existing = loadKey();
  if (existing) {
    console.log(`An app key for FID ${existing.fid} is already saved at ${keyPath()}.`);
    console.log("Run `./outpost cli uninstall` first if you want a new one.");
    return;
  }
  const info = await hub.info();
  if (!syncState(info).synced) {
    throw new Error("your node is still syncing. Run `./outpost cli status` and try again when it says synced: yes.");
  }
  console.log(WARNING);
  if (!(await confirm("Is this a test account, and do you accept the above?"))) return;

  let phrase = await askHidden("Recovery phrase (input hidden): ");
  const custody = custodyFromSeedPhrase(phrase);
  phrase = ""; // JS strings cannot be wiped; we drop the reference and keep no copy.

  const account = await resolveAccount(hub, custody.address, chain);
  console.log(`\ncustody address  ${account.custody}`);
  console.log(printable(`FID              ${account.fid}`));
  console.log(printable(`storage units    ${account.storageUnits}`));
  if (account.storageUnits === 0) throw new Error("this account has no storage, so the network will reject its messages.");
  console.log(`app key          can cast, react and follow; expires ${ttlDays} days after last use`);
  if (!(await confirm("Sign the app key authorization for this FID?"))) return;

  let path = "";
  const { key, confirmed } = await addAppKey(hub, { fid: account.fid, custody: custody.signer, ttl: ttlDays * 86400, network }, { timeoutMs: 60_000 }, (k) => {
    path = saveKey(k); // saved as soon as the node accepts it, so a slow merge cannot lose it
  });
  console.log(
    confirmed
      ? `\napp key ${key.publicKey} is live. Saved to ${path}.`
      : `\napp key ${key.publicKey} was accepted but your node does not show it yet. Saved to ${path}. Check with: ./outpost cli whoami`,
  );
  console.log("Your recovery phrase was not saved anywhere. Revoke this key any time with: ./outpost cli uninstall");
}

async function cmdWhoami(hub: Hub) {
  const key = requireKey();
  const s = await hub.signer(key.fid, key.publicKey);
  console.log(`FID ${key.fid}, app key ${key.publicKey}`);
  if (!s) {
    console.log("status: NOT active on your node (revoked, expired, or not merged yet)");
    return;
  }
  console.log(printable(`scopes: ${(s.scopes ?? []).map((x) => x.replace("MESSAGE_TYPE_", "").toLowerCase()).join(", ")}`));
  if (s.expiresAt) console.log(`expires: ${new Date(s.expiresAt * 1000).toISOString()} unless used before then`);
}

async function cmdFeed(hub: Hub, v: { fid?: string; channel?: string; include?: string; exclude?: string; limit?: string }) {
  const fid = v.fid ? parseFid(v.fid) : requireKey().fid;
  const list = (s?: string) => (s ? s.split(",").map((x) => parseAppSelector(x.trim())) : undefined);
  const filter: AppFilter = { include: list(v.include), exclude: list(v.exclude) };
  const limit = v.limit ? Number(v.limit) : 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be 1 to 500");
  const feed = new FeedBuilder(hub);
  const t0 = Date.now();
  const items = v.channel ? await feed.channel(v.channel, { limit, filter }) : await feed.following(fid, { limit, filter });
  const ms = Date.now() - t0;
  const names = await feed.appNames(items);
  const label = (it: FeedItem) =>
    it.app.kind === "app" ? `via ${names.get(it.app.requestFid!) ?? it.app.requestFid} (app fid ${it.app.requestFid})` : it.app.kind === "self" ? "via own key" : "via unknown key";
  // Onchain keys are checked on Optimism; gasless keys with the second node, if one is set.
  const own = loadKey()?.publicKey.toLowerCase();
  const keyNote = (it: FeedItem) =>
    it.app.keyCheck === "onchain" || it.app.keyCheck === "own" || it.signer.toLowerCase() === own
      ? ""
      : it.app.keyCheck === "confirmed"
        ? "  [signer confirmed by second node]"
        : it.app.keyCheck === "revoked"
          ? "  [key revoked since]"
          : it.app.keyCheck === "unlisted"
            ? "  [key not listed: revoked since, or not the author's]"
            : "  [signer not verified]";
  for (const it of items) {
    const who = it.author?.username ? `@${it.author.username}` : `fid:${it.fid}`;
    console.log(printable(`${new Date(it.time).toISOString().slice(0, 16).replace("T", " ")}  ${who}  ${label(it)}${keyNote(it)}`));
    console.log(`  ${printable(it.text.replace(/\s+/g, " ")).slice(0, 200)}${it.embeds.length ? `  [${it.embeds.length} embed]` : ""}`);
    console.log(`  ${it.fid}:${it.hash}`);
  }
  const mix = new Map<string, number>();
  for (const it of items) mix.set(label(it), (mix.get(label(it)) ?? 0) + 1);
  console.log(`\n${items.length} cast${items.length === 1 ? "" : "s"} in ${(ms / 1000).toFixed(2)} s from ${hub.url}`);
  for (const [k, n] of [...mix].sort((a, b) => b[1] - a[1])) console.log(printable(`  ${String(n).padStart(3)}  ${k}`));
  console.log(verificationNote(hub));
}

async function cmdUninstall(hub: Hub) {
  const key = loadKey();
  if (!key) {
    console.log(`no app key from ./outpost cli login at ${keyPath()}, so nothing to revoke here.`);
    console.log("A key added in the web client lives in that browser: open the client, then 'Your app key' > 'Revoke this key (uninstall)'.");
    return;
  }
  // The key file is the only way to revoke the key without the recovery phrase, so it is deleted
  // only once the node confirms the revocation. A node that is behind, or has not merged the key
  // yet, answers "not found" for a key that is live on the network.
  if (!syncState(await hub.info()).synced) {
    throw new Error("your node is still syncing, so it cannot tell whether this key is active. Nothing was revoked or deleted. Run `./outpost cli uninstall` again when `./outpost cli status` says synced: yes.");
  }
  if (!(await hub.signer(key.fid, key.publicKey))) {
    console.log("your node does not list this key (revoked, expired, or not merged yet), so nothing was revoked.");
    console.log(`The key file is kept so the key can still revoke itself: ${keyPath()}`);
    console.log("Try again in a few minutes. Delete that file yourself only once you are sure the key is gone.");
    return;
  }
  await revokeAppKey(hub, key, { timeoutMs: 60_000 });
  console.log(`revoked app key ${key.publicKey} for FID ${key.fid}. No recovery phrase was needed.`);
  deleteKey();
  console.log(`deleted ${keyPath()}`);
}

// Builds one of every message type with a throwaway custody key and app key, then asks the
// node's stateless validator about each. A tampered copy must fail. Nothing is submitted.
async function cmdSelftest(hub: Hub) {
  const throwaway = privateKeyToAccount(("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")) as HexString);
  const custody = new ViemLocalEip712Signer(throwaway);
  const fid = 1;
  const target = { fid: 37, hash: "0x50184b62b4c52fd76628713562e1eda3dccaf63d" as HexString };
  const { message: keyAdd, key } = await buildKeyAdd({ fid, custody, nonce: 1 });
  const cases: Array<[string, Message, boolean]> = [
    ["KEY_ADD (gasless, scoped, 30-day TTL)", keyAdd, true],
    ["CAST_ADD", await buildCast(key, { text: "selftest" }), true],
    ["CAST_REMOVE", await buildCastRemove(key, target.hash), true],
    ["LINK_ADD follow", await buildFollow(key, 37), true],
    ["LINK_REMOVE follow", await buildUnfollow(key, 37), true],
    ["REACTION_ADD like", await buildReaction(key, "like", target), true],
    ["REACTION_ADD recast", await buildReaction(key, "recast", target), true],
    ["REACTION_REMOVE like", await buildReactionRemove(key, "like", target), true],
    ["KEY_REMOVE (self-revoke)", await buildSelfRevoke(key, 1), true],
  ];
  // Tampering: change the signed bytes but keep the original hash and signature.
  const reencode = (m: Message) => ((m.dataBytes = MessageData.encode(m.data!).finish()), m);
  const tampered = await buildCast(key, { text: "original" });
  tampered.data!.castAddBody!.text = "tampered";
  cases.push(["CAST_ADD with text changed after signing", reencode(tampered), false]);
  const widened = await buildKeyAdd({ fid, custody, nonce: 1, ttl: 86400 });
  widened.message.data!.keyAddBody!.ttl = 90 * 86400;
  cases.push(["KEY_ADD with TTL widened after signing", reencode(widened.message), false]);

  let failures = 0;
  for (const [name, msg, expected] of cases) {
    const res = await hub.validate(msg);
    const ok = res.valid === expected;
    if (!ok) failures++;
    console.log(printable(`${ok ? "PASS" : "FAIL"}  ${name}: node says valid=${res.valid}, expected ${expected}`));
  }
  console.log(failures ? `\n${failures} check(s) failed` : `\nall ${cases.length} checks passed against ${hub.url}`);
  if (failures) process.exitCode = 1;
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      node: { type: "string" },
      reply: { type: "string" },
      channel: { type: "string" },
      embed: { type: "string", multiple: true },
      "token-file": { type: "string" },
      rpc: { type: "string" },
      "check-node": { type: "string" },
      "show-unverified": { type: "boolean" },
      "ttl-days": { type: "string", default: "30" },
      // For testing against a local devnet. Everything real uses mainnet.
      network: { type: "string", default: "mainnet" },
      fid: { type: "string" },
      include: { type: "string" },
      exclude: { type: "string" },
      limit: { type: "string" },
      add: { type: "string", multiple: true },
      remove: { type: "string", multiple: true },
      "add-mod": { type: "string", multiple: true },
      "remove-mod": { type: "string", multiple: true },
      "trust-unrecountable": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help) {
    console.log(USAGE);
    return;
  }
  const { hub, chain } = hubFromEnv(values);
  const reaction = (r: Reaction, add: boolean) => async () => {
    const key = requireKey();
    const target = { fid: parseFid(args[0]), hash: parseHash(args[1]) };
    report(`${add ? "" : "un"}${r}`, await (add ? react : unreact)(hub, key, r, target));
  };
  const commands: Record<string, () => Promise<void>> = {
    status: () => cmdStatus(hub),
    login: () => {
      const days = Number(values["ttl-days"]);
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--ttl-days must be 1 to 90");
      const nets: Record<string, FarcasterNetwork> = { mainnet: FarcasterNetwork.MAINNET, devnet: FarcasterNetwork.DEVNET };
      const network = nets[values.network ?? "mainnet"];
      if (network === undefined) throw new Error("--network must be mainnet or devnet");
      // Devnet accounts are not on Optimism mainnet, so only mainnet looks the FID up there.
      return cmdLogin(hub, days, network, network === FarcasterNetwork.MAINNET ? chain : undefined);
    },
    whoami: () => cmdWhoami(hub),
    uninstall: () => cmdUninstall(hub),
    selftest: () => cmdSelftest(hub),
    feed: () => cmdFeed(hub, values),
    charter: () => cmdCharter(hub, args, requireKey, chain, values),
    cast: async () => {
      const text = args.join(" ");
      report(
        "cast",
        await cast(hub, requireKey(), {
          text,
          embeds: values.embed,
          replyTo: values.reply ? parseCastRef(values.reply) : undefined,
          channelUrl: values.channel,
        }),
      );
    },
    delete: async () => report("delete", await deleteCast(hub, requireKey(), parseHash(args[0]))),
    follow: async () => report("follow", await follow(hub, requireKey(), parseFid(args[0]))),
    unfollow: async () => report("unfollow", await unfollow(hub, requireKey(), parseFid(args[0]))),
    like: reaction("like", true),
    unlike: reaction("like", false),
    recast: reaction("recast", true),
    unrecast: reaction("recast", false),
  };
  const run = commands[cmd];
  if (!run) {
    console.error(`unknown command: ${cmd}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  await run();
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(printable(`error: ${e instanceof HubError || e instanceof Error ? e.message : String(e)}`));
  process.exitCode = 1;
});
