import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReaction, extractMentions, FeedBuilder, notificationsFor, notificationText, seenUpTo, unreadCount, type HexString, type Notification } from "../src/core/index.js";
import { appKey, json, World } from "./votes-world.js";

// Farcaster seconds, a few minutes apart, all in the past.
const NOW = Math.floor((Date.now() - 1609459200000) / 1000);
const t = (minutesAgo: number) => NOW - minutesAgo * 60;
const ME = 100;

async function world() {
  const w = new World();
  for (const f of [ME, 200, 300, 400, 500]) await w.member(f);
  await w.name(ME, "me");
  await w.name(200, "alice");
  await w.name(300, "bob");
  return w;
}

test("replies, mentions, likes, recasts and follows, newest first, likes grouped per cast", async () => {
  const w = await world();
  const mine = await w.cast(ME, { text: "my first cast" }, t(60));
  const mine2 = await w.cast(ME, { text: "my second cast" }, t(50));
  const target = { fid: ME, hash: mine.hash };
  await w.cast(200, { text: "a reply", replyTo: target }, t(40));
  await w.cast(300, { ...extractMentions("hey @me look", [{ name: "me", fid: ME }]) }, t(30));
  for (const [f, ago] of [[200, 20], [300, 19], [400, 18]] as const) w.likes.push(await like(w, f, mine, t(ago)));
  w.likes.push(await like(w, 500, mine2, t(15), "recast"));
  await w.follow(400, ME, t(10));
  w.likes.push(await like(w, ME, mine, t(5))); // your own like is not a notification

  const r = await notificationsFor(new FeedBuilder(w.hub()), ME);
  assert.equal(r.pending, 0);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(
    r.items.map((n) => [n.kind, n.actors.map((a) => a.fid)]),
    [["follow", [400]], ["recast", [500]], ["like", [400, 300, 200]], ["mention", [300]], ["reply", [200]]],
  );
  const texts = r.items.map(notificationText);
  assert.deepEqual(texts, ["fid 400 followed you", "fid 500 recast your cast", "fid 400 and 2 others liked your cast", "@bob mentioned you", "@alice replied"]);
  const likeItem = r.items.find((n) => n.kind === "like")!;
  assert.equal(likeItem.target?.text, "my first cast");
  assert.equal(r.items.find((n) => n.kind === "mention")!.cast!.text, "hey @me look");
  assert.equal(r.items.find((n) => n.kind === "reply")!.target?.hash, mine.hash);
  for (let i = 1; i < r.items.length; i++) assert.ok(r.items[i - 1]!.time >= r.items[i]!.time, "newest first");
});

async function like(w: World, fid: number, cast: { data: { fid: number }; hash: HexString }, ts: number, kind: "like" | "recast" = "like") {
  return json(await buildReaction(w.keys.get(fid)!, kind, { fid: cast.data.fid, hash: cast.hash }, ts));
}

test("a reply that also mentions you shows once, as a reply", async () => {
  const w = await world();
  const mine = await w.cast(ME, { text: "hi" }, t(30));
  await w.cast(200, { ...extractMentions("@me yes", [{ name: "me", fid: ME }]), replyTo: { fid: ME, hash: mine.hash } }, t(20));
  const r = await notificationsFor(new FeedBuilder(w.hub()), ME);
  assert.deepEqual(r.items.map((n) => n.kind), ["reply"]);
});

test("a forged reply and a like from a key that is not the liker's are dropped", async () => {
  const w = await world();
  const mine = await w.cast(ME, { text: "hi" }, t(30));
  const reply = await w.cast(200, { text: "real reply", replyTo: { fid: ME, hash: mine.hash } }, t(20));
  // The node changes the reply's text after it was signed.
  const forged = structuredClone(reply);
  forged.data.castAddBody!.text = "forged text";
  forged.hash = (await w.cast(300, { text: "other", replyTo: { fid: ME, hash: mine.hash } }, t(19))).hash;
  w.casts = w.casts.filter((m) => m.data.fid !== 300);
  w.casts.unshift(forged);
  // A like signed by a key nobody lists for FID 400.
  const stranger = await appKey(400);
  w.likes.push(json(await buildReaction(stranger, "like", { fid: ME, hash: mine.hash }, t(10))));
  const hub = w.hub();
  const r = await notificationsFor(new FeedBuilder(hub), ME);
  assert.deepEqual(r.items.map((n) => [n.kind, n.cast?.text]), [["reply", "real reply"]]);
  assert.ok(hub.verifier!.failed >= 1, "the forged reply was counted as failed");
});

test("a source the node does not answer is reported; the rest still shows", async () => {
  const w = await world();
  const mine = await w.cast(ME, { text: "hi" }, t(30));
  await w.cast(200, { text: "reply", replyTo: { fid: ME, hash: mine.hash } }, t(20));
  const base = w.answer.bind(w);
  w.answer = (path, q, body) => (path === "/v1/castsByMention" ? { status: 500, body: { error: "boom" } } : base(path, q, body));
  const updates: number[] = [];
  const r = await notificationsFor(new FeedBuilder(w.hub()), ME, { onUpdate: (u) => updates.push(u.pending) });
  assert.deepEqual(r.failed, ["mentions"]);
  assert.deepEqual(r.items.map((n) => n.kind), ["reply"]);
  assert.deepEqual(updates.sort(), [0, 1, 2, 3, 4]);
});

test("unread count is the items after the last-seen time; marking read covers clock skew", () => {
  const n = (time: number): Notification => ({ id: String(time), kind: "follow", time, actors: [{ fid: 1 }] });
  const items = [n(5000), n(4000), n(3000), n(1000)];
  assert.equal(unreadCount(items, undefined), 4);
  assert.equal(unreadCount(items, 3000), 2);
  assert.equal(unreadCount(items, 5000), 0);
  assert.equal(seenUpTo(items, 4500), 5000);
  assert.equal(seenUpTo(items, 9000), 9000);
  assert.equal(unreadCount(items, seenUpTo(items, 4500)), 0);
});
