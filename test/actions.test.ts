import { test } from "node:test";
import assert from "node:assert/strict";
import { blake3 } from "@noble/hashes/blake3";
import { ed25519 } from "@noble/curves/ed25519";
import { FarcasterNetwork, MessageData, MessageType, ReactionType, type Message } from "@farcaster/core";
import { bytesToHex, hexToBytes } from "viem";
import {
  buildCast,
  buildCastRemove,
  buildFollow,
  buildReaction,
  buildReactionRemove,
  buildUnfollow,
  hashOf,
  type AppKey,
} from "../src/core/index.js";

const KEY: AppKey = {
  fid: 424242,
  privateKey: "0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  publicKey: "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  requestFid: 424242,
  scopes: [],
  ttl: 86400,
  network: FarcasterNetwork.MAINNET,
};
const NOW = 182_000_000;
const TARGET = { fid: 37, hash: "0x50184b62b4c52fd76628713562e1eda3dccaf63d" } as const;

function verify(msg: Message) {
  const dataBytes = msg.dataBytes && msg.dataBytes.length > 0 ? msg.dataBytes : MessageData.encode(msg.data!).finish();
  assert.deepEqual(msg.hash, blake3(dataBytes, { dkLen: 20 }));
  assert.equal(bytesToHex(msg.signer), KEY.publicKey);
  assert.ok(ed25519.verify(msg.signature, msg.hash, msg.signer));
  assert.equal(msg.data!.fid, KEY.fid);
  assert.equal(msg.data!.timestamp, NOW);
  assert.equal(msg.data!.network, FarcasterNetwork.MAINNET);
}

test("cast: text, embeds, reply and channel", async () => {
  const m = await buildCast(KEY, { text: "hello from my own node", embeds: ["https://example.org"] }, NOW);
  verify(m);
  assert.equal(m.data!.type, MessageType.CAST_ADD);
  assert.equal(m.data!.castAddBody!.text, "hello from my own node");
  assert.equal(m.data!.castAddBody!.embeds[0]!.url, "https://example.org");

  const reply = await buildCast(KEY, { text: "reply", replyTo: TARGET }, NOW);
  verify(reply);
  assert.equal(reply.data!.castAddBody!.parentCastId!.fid, 37);
  assert.equal(bytesToHex(reply.data!.castAddBody!.parentCastId!.hash), TARGET.hash);

  const chan = await buildCast(KEY, { text: "gm", channelUrl: "https://farcaster.xyz/~/channel/dev" }, NOW);
  assert.equal(chan.data!.castAddBody!.parentUrl, "https://farcaster.xyz/~/channel/dev");
});

test("cast: input limits are checked before signing", async () => {
  await assert.rejects(buildCast(KEY, { text: "   " }, NOW), /text or an embed/);
  await assert.rejects(buildCast(KEY, { text: "x".repeat(1025) }, NOW), /1024 bytes/);
  await assert.rejects(buildCast(KEY, { text: "é".repeat(513) }, NOW), /1024 bytes/); // 2 bytes each
  await assert.rejects(buildCast(KEY, { text: "a", embeds: ["1", "2", "3", "4", "5"] }, NOW), /4 embeds/);
  await assert.rejects(buildCast(KEY, { text: "a", replyTo: TARGET, channelUrl: "https://x" }, NOW), /not both/);
});

test("cast remove targets the hash", async () => {
  const m = await buildCastRemove(KEY, TARGET.hash, NOW);
  verify(m);
  assert.equal(m.data!.type, MessageType.CAST_REMOVE);
  assert.equal(bytesToHex(m.data!.castRemoveBody!.targetHash), TARGET.hash);
});

test("follow and unfollow are LINK_ADD / LINK_REMOVE of type follow", async () => {
  const f = await buildFollow(KEY, 37, NOW);
  verify(f);
  assert.equal(f.data!.type, MessageType.LINK_ADD);
  assert.equal(f.data!.linkBody!.type, "follow");
  assert.equal(f.data!.linkBody!.targetFid, 37);
  const u = await buildUnfollow(KEY, 37, NOW);
  verify(u);
  assert.equal(u.data!.type, MessageType.LINK_REMOVE);
});

test("like and recast, and their removals", async () => {
  const like = await buildReaction(KEY, "like", TARGET, NOW);
  verify(like);
  assert.equal(like.data!.type, MessageType.REACTION_ADD);
  assert.equal(like.data!.reactionBody!.type, ReactionType.LIKE);
  assert.equal(bytesToHex(like.data!.reactionBody!.targetCastId!.hash), TARGET.hash);
  const recast = await buildReaction(KEY, "recast", TARGET, NOW);
  assert.equal(recast.data!.reactionBody!.type, ReactionType.RECAST);
  const unlike = await buildReactionRemove(KEY, "like", TARGET, NOW);
  verify(unlike);
  assert.equal(unlike.data!.type, MessageType.REACTION_REMOVE);
});

test("hashOf returns the 20-byte message hash as hex", async () => {
  const m = await buildFollow(KEY, 37, NOW);
  assert.match(hashOf(m), /^0x[0-9a-f]{40}$/);
  assert.deepEqual(hexToBytes(hashOf(m)), m.hash);
});
