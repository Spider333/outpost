// Notifications, read from your own node. Snapchain has no notifications endpoint, so they are
// put together from plain reads:
//   replies:   castsByParent on each of your recent casts
//   likes:     reactionsByCast (Like) on the same casts
//   recasts:   reactionsByCast (Recast) on the same casts
//   mentions:  castsByMention for your FID
//   followers: linksByTargetFid for your FID
// Every message goes through the node client's verifier (hash, signature, "is this what was
// asked"), and the key that signed it must pass the same key check as the feed (verify.ts).
// Likes and recasts of one cast are grouped into one item. Newest first.

import { FARCASTER_EPOCH_MS, mapLimit, notFuture, type FeedBuilder, type FeedItem, type Profile } from "./feed.js";
import type { HexString, HubMessage, Paged } from "./hub.js";

export type NotificationKind = "reply" | "mention" | "like" | "recast" | "follow";

export interface Notification {
  id: string; // stable, for the page
  kind: NotificationKind;
  time: number; // Unix ms of the newest action in the item
  actors: Profile[]; // newest first; for a like or recast, everyone who did it
  cast?: FeedItem; // the reply or the mentioning cast
  target?: FeedItem; // your cast that was replied to, liked or recast
}

export interface NotificationOptions {
  recent?: number; // your latest casts whose replies and reactions are read (default 25)
  perSource?: number; // messages read per source (default 50)
  concurrency?: number;
  // Called after each source finishes, with everything so far and how many sources are left,
  // so a slow node shows partial results instead of nothing.
  onUpdate?: (r: NotificationResult) => void;
}

export interface NotificationResult {
  items: Notification[];
  pending: number; // sources still loading (0 when done)
  failed: string[]; // sources the node did not answer, e.g. "mentions"
}

const timeOf = (m: HubMessage) => FARCASTER_EPOCH_MS + m.data.timestamp * 1000;

export async function notificationsFor(feed: FeedBuilder, fid: number, opts: NotificationOptions = {}): Promise<NotificationResult> {
  const { recent = 25, perSource = 50, concurrency = 8 } = opts;
  const hub = feed.hub;
  const failed: string[] = [];
  let pending = 5;

  // A message counts only if its key passes the same check the feed uses.
  const admitted = async (ms: HubMessage[]): Promise<HubMessage[]> => {
    const ok = await mapLimit(ms, concurrency, async (m) => !hub.verifier || hub.verifier.admits((await feed.apps.appOf(m.data.fid, m.signer)).keyCheck));
    return ms.filter((m, i) => ok[i] && m.data.fid !== fid && notFuture(m));
  };
  const profiles = (fids: number[]) => mapLimit(fids, concurrency, (f) => feed.profile(f).catch(() => ({ fid: f }) as Profile));

  const replies: Notification[] = [];
  const mentions: Notification[] = [];
  const reactions: Notification[] = [];
  const follows: Notification[] = [];
  const result = (): NotificationResult => {
    // A reply that also mentions you is shown once, as a reply.
    const replyHashes = new Set(replies.map((n) => n.cast!.hash));
    const items = [...replies, ...mentions.filter((n) => !replyHashes.has(n.cast!.hash)), ...reactions, ...follows];
    items.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
    return { items, pending, failed: [...failed] };
  };
  const source = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      failed.push(name);
    }
    pending--;
    opts.onUpdate?.(result());
  };

  const castNotes = async (kind: "reply" | "mention", ms: HubMessage[], targets?: Map<string, FeedItem>) => {
    const casts = (await admitted(ms.filter((m) => m.data.castAddBody))).sort((a, b) => b.data.timestamp - a.data.timestamp);
    const items = await feed.items(casts);
    return items.map((cast): Notification => {
      const p = cast.parent && "hash" in cast.parent ? targets?.get(cast.parent.hash.toLowerCase()) : undefined;
      return { id: `${kind}:${cast.hash}`, kind, time: cast.time, actors: [cast.author ?? { fid: cast.fid }], cast, target: p };
    });
  };

  // Your recent casts, the targets of replies, likes and recasts.
  const mine = await feed.hub.castsByFid(fid, { reverse: true, pageSize: recent }).then(
    async (p) => feed.items(p.items.filter((m) => m.data.castAddBody && notFuture(m)).slice(0, recent)),
    () => undefined,
  );
  const targets = new Map((mine ?? []).map((c) => [c.hash.toLowerCase(), c]));

  const all = <T>(p: Promise<Paged<T>>) => p.then((r) => r.items);
  await Promise.all([
    source("replies", async () => {
      if (!mine) throw new Error("your casts could not be read");
      const pages = await mapLimit(mine, concurrency, (c) => all(hub.repliesTo({ fid, hash: c.hash }, { pageSize: perSource })));
      replies.push(...(await castNotes("reply", pages.flat(), targets)));
    }),
    source("mentions", async () => {
      const ms = (await all(hub.castsByMention(fid, { reverse: true, pageSize: perSource }))).sort((a, b) => b.data.timestamp - a.data.timestamp);
      mentions.push(...(await castNotes("mention", ms.slice(0, perSource), targets)));
    }),
    source("likes", async () => {
      if (!mine) throw new Error("your casts could not be read");
      reactions.push(...(await grouped("like", mine, (t) => all(hub.likesByCast(t, { pageSize: perSource })))));
    }),
    source("recasts", async () => {
      if (!mine) throw new Error("your casts could not be read");
      reactions.push(...(await grouped("recast", mine, (t) => all(hub.recastsByCast(t, { pageSize: perSource })))));
    }),
    source("followers", async () => {
      const ms = await admitted(await all(hub.linksByTarget(fid, { linkType: "follow", reverse: true, pageSize: perSource })));
      ms.sort((a, b) => b.data.timestamp - a.data.timestamp);
      const ps = await profiles(ms.map((m) => m.data.fid));
      follows.push(...ms.slice(0, perSource).map((m, i): Notification => ({ id: `follow:${m.data.fid}`, kind: "follow", time: timeOf(m), actors: [ps[i]!] })));
    }),
  ]);
  return result();

  async function grouped(kind: "like" | "recast", casts: FeedItem[], read: (t: { fid: number; hash: HexString }) => Promise<HubMessage[]>): Promise<Notification[]> {
    const pages = await mapLimit(casts, concurrency, (c) => read({ fid, hash: c.hash }).then(admitted));
    const out: Notification[] = [];
    for (const [i, ms] of pages.entries()) {
      if (!ms.length) continue;
      ms.sort((a, b) => b.data.timestamp - a.data.timestamp);
      const fids = [...new Set(ms.map((m) => m.data.fid))];
      out.push({ id: `${kind}:${casts[i]!.hash}`, kind, time: timeOf(ms[0]!), actors: await profiles(fids), target: casts[i] });
    }
    return out;
  }
}

// Items newer than the last time you marked them read.
export function unreadCount(items: Notification[], lastSeen: number | undefined): number {
  return items.filter((n) => n.time > (lastSeen ?? 0)).length;
}

// The moment to store when marking everything read: never earlier than the newest item, so an
// item dated a little ahead of this clock does not stay unread.
export function seenUpTo(items: Notification[], now = Date.now()): number {
  return Math.max(now, ...items.map((n) => n.time));
}

const nameOf = (p: Profile) => (p.username ? `@${p.username}` : `fid ${p.fid}`);

// "@dwr", "@dwr and @v", "@dwr and 3 others".
export function actorText(actors: Profile[]): string {
  if (actors.length <= 2) return actors.map(nameOf).join(" and ");
  return `${nameOf(actors[0]!)} and ${actors.length - 1} others`;
}

export function notificationText(n: Notification): string {
  const who = actorText(n.actors);
  switch (n.kind) {
    case "reply":
      return `${who} replied`;
    case "mention":
      return `${who} mentioned you`;
    case "like":
      return `${who} liked your cast`;
    case "recast":
      return `${who} recast your cast`;
    case "follow":
      return `${who} followed you`;
  }
}
