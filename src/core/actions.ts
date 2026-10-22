// Everyday writes, each signed by the app key and sent through your own node.
// A read node checks the message and relays it to validators over gossip.
// After submitting we read the message back, because "accepted" is not "in a block".

import {
  CastType,
  makeCastAdd,
  makeCastRemove,
  makeLinkAdd,
  makeLinkRemove,
  makeReactionAdd,
  makeReactionRemove,
  ReactionType,
  type Message,
} from "@farcaster/core";
import { bytesToHex, hexToBytes } from "viem";
import { farcasterNow, signerOf, unwrap, waitFor, type AppKey } from "./appkey.js";
import { Hub, type HexString, type HubMessage } from "./hub.js";

export interface CastTarget {
  fid: number;
  hash: HexString;
}

export interface CastInput {
  text: string;
  embeds?: string[]; // URLs, up to 4
  replyTo?: CastTarget;
  channelUrl?: string; // parent URL of a channel, e.g. "https://farcaster.xyz/~/channel/dev"
}

function opts(key: AppKey, now?: number) {
  return { fid: key.fid, network: key.network, timestamp: now ?? farcasterNow() };
}

// Byte length limit for a normal account. Pro accounts can post 10,000 bytes.
export const MAX_CAST_BYTES = 1024;

export async function buildCast(key: AppKey, input: CastInput, now?: number): Promise<Message> {
  const text = input.text.trim();
  if (!text && !input.embeds?.length) throw new Error("a cast needs text or an embed");
  if (new TextEncoder().encode(text).length > MAX_CAST_BYTES) throw new Error(`cast is longer than ${MAX_CAST_BYTES} bytes`);
  if ((input.embeds?.length ?? 0) > 4) throw new Error("at most 4 embeds");
  if (input.replyTo && input.channelUrl) throw new Error("a cast is either a reply or a channel post, not both");
  return unwrap(
    await makeCastAdd(
      {
        text,
        type: CastType.CAST,
        embeds: (input.embeds ?? []).map((url) => ({ url })),
        embedsDeprecated: [],
        mentions: [],
        mentionsPositions: [],
        parentCastId: input.replyTo ? { fid: input.replyTo.fid, hash: hexToBytes(input.replyTo.hash) } : undefined,
        parentUrl: input.channelUrl,
      },
      opts(key, now),
      signerOf(key),
    ),
  );
}

export async function buildCastRemove(key: AppKey, hash: HexString, now?: number): Promise<Message> {
  return unwrap(await makeCastRemove({ targetHash: hexToBytes(hash) }, opts(key, now), signerOf(key)));
}

export async function buildFollow(key: AppKey, targetFid: number, now?: number): Promise<Message> {
  return unwrap(await makeLinkAdd({ type: "follow", targetFid }, opts(key, now), signerOf(key)));
}

export async function buildUnfollow(key: AppKey, targetFid: number, now?: number): Promise<Message> {
  return unwrap(await makeLinkRemove({ type: "follow", targetFid }, opts(key, now), signerOf(key)));
}

export type Reaction = "like" | "recast";

function reactionType(r: Reaction): ReactionType {
  return r === "like" ? ReactionType.LIKE : ReactionType.RECAST;
}

export async function buildReaction(key: AppKey, r: Reaction, target: CastTarget, now?: number): Promise<Message> {
  return unwrap(
    await makeReactionAdd(
      { type: reactionType(r), targetCastId: { fid: target.fid, hash: hexToBytes(target.hash) } },
      opts(key, now),
      signerOf(key),
    ),
  );
}

export async function buildReactionRemove(key: AppKey, r: Reaction, target: CastTarget, now?: number): Promise<Message> {
  return unwrap(
    await makeReactionRemove(
      { type: reactionType(r), targetCastId: { fid: target.fid, hash: hexToBytes(target.hash) } },
      opts(key, now),
      signerOf(key),
    ),
  );
}

export function hashOf(msg: Message): HexString {
  return bytesToHex(msg.hash);
}

export interface WriteResult {
  hash: HexString;
  confirmed: boolean; // true once the node returns the message from its own state
}

type Wait = { timeoutMs?: number; intervalMs?: number };

// Adds are confirmed when the node returns this exact message (same hash), not just any
// earlier like or follow of the same target. Removes are confirmed when the target is gone.
async function submitAndConfirm(hub: Hub, msg: Message, probe: () => Promise<HubMessage | true | undefined>, wait?: Wait): Promise<WriteResult> {
  await hub.submit(msg);
  const hash = hashOf(msg);
  const seen = await waitFor(async () => {
    const r = await probe();
    if (r === true) return true;
    return r && r.hash.toLowerCase() === hash ? true : undefined;
  }, wait);
  return { hash, confirmed: !!seen };
}

export async function cast(hub: Hub, key: AppKey, input: CastInput, wait?: Wait): Promise<WriteResult> {
  const msg = await buildCast(key, input);
  return submitAndConfirm(hub, msg, () => hub.castById(key.fid, hashOf(msg)), wait);
}

export async function deleteCast(hub: Hub, key: AppKey, hash: HexString, wait?: Wait): Promise<WriteResult> {
  const msg = await buildCastRemove(key, hash);
  return submitAndConfirm(hub, msg, async () => ((await hub.castById(key.fid, hash)) ? undefined : true), wait);
}

export async function follow(hub: Hub, key: AppKey, targetFid: number, wait?: Wait): Promise<WriteResult> {
  return submitAndConfirm(hub, await buildFollow(key, targetFid), () => hub.linkById(key.fid, targetFid), wait);
}

export async function unfollow(hub: Hub, key: AppKey, targetFid: number, wait?: Wait): Promise<WriteResult> {
  const msg = await buildUnfollow(key, targetFid);
  return submitAndConfirm(hub, msg, async () => ((await hub.linkById(key.fid, targetFid)) ? undefined : true), wait);
}

export async function react(hub: Hub, key: AppKey, r: Reaction, target: CastTarget, wait?: Wait): Promise<WriteResult> {
  const type = r === "like" ? "Like" : "Recast";
  return submitAndConfirm(hub, await buildReaction(key, r, target), () => hub.reactionById(key.fid, type, target), wait);
}

export async function unreact(hub: Hub, key: AppKey, r: Reaction, target: CastTarget, wait?: Wait): Promise<WriteResult> {
  const type = r === "like" ? "Like" : "Recast";
  const msg = await buildReactionRemove(key, r, target);
  return submitAndConfirm(hub, msg, async () => ((await hub.reactionById(key.fid, type, target)) ? undefined : true), wait);
}
