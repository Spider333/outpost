import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeGaslessSignedKeyRequestMetadata } from "@farcaster/core";
import { appRefOf, FeedBuilder, Hub, passesFilter, parseAppSelector, type HubMessage, type HubSigner } from "../src/core/index.js";

const k = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const h = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;

function onchainMeta(requestFid: number): string {
  const r = encodeGaslessSignedKeyRequestMetadata({
    requestFid: BigInt(requestFid),
    requestSigner: "0x00000000000000000000000000000000000000aa",
    signature: new Uint8Array(65),
    deadline: 1n,
  });
  return Buffer.from(r._unsafeUnwrap()).toString("base64");
}

// Fake world: user 100 follows 200 and 300.
// 200 posts via app 9152 (onchain key) and via a gasless key from app 777.
// 300 posts with a key it signed for itself.
const signers: Record<number, HubSigner[]> = {
  100: [],
  200: [
    { source: "SIGNER_SOURCE_ONCHAIN", key: k(1), keyType: 1, fid: 200, onChainEvent: { fid: 200, signerEventBody: { key: k(1), eventType: "SIGNER_EVENT_TYPE_ADD", metadata: onchainMeta(9152), metadataType: 1 } } },
    { source: "SIGNER_SOURCE_OFFCHAIN", key: k(2), keyType: 1, fid: 200, requestFid: 777, scopes: ["MESSAGE_TYPE_CAST_ADD"] },
  ],
  300: [{ source: "SIGNER_SOURCE_OFFCHAIN", key: k(3), keyType: 1, fid: 300, requestFid: 300 }],
};

function castMsg(fid: number, ts: number, signer: string, text: string, reply = false): HubMessage {
  return {
    data: {
      type: "MESSAGE_TYPE_CAST_ADD",
      fid,
      timestamp: ts,
      network: "FARCASTER_NETWORK_MAINNET",
      castAddBody: {
        text,
        embeds: [{ url: "https://example.org" }],
        embedsDeprecated: [],
        mentions: [],
        mentionsPositions: [],
        parentCastId: reply ? { fid: 1, hash: h(1) } : null,
        parentUrl: null,
        type: "CAST",
      },
    },
    hash: h(ts),
    hashScheme: "HASH_SCHEME_BLAKE3",
    signature: "",
    signatureScheme: "SIGNATURE_SCHEME_ED25519",
    signer: signer as `0x${string}`,
  };
}

const casts: Record<number, HubMessage[]> = {
  100: [castMsg(100, 50, k(9), "my own")],
  200: [castMsg(200, 40, k(1), "from app 9152"), castMsg(200, 30, k(2), "from app 777"), castMsg(200, 35, k(1), "a reply", true)],
  // 1284259438 Farcaster seconds is 2061-09-12, like a real mainnet cast; it must not show.
  300: [castMsg(300, 45, k(3), "self signed"), castMsg(300, 1284259438, k(3), "from 2061")],
};

const calls: string[] = [];
const fakeFetch: typeof fetch = async (input) => {
  const url = new URL(String(input));
  calls.push(url.pathname);
  const fid = Number(url.searchParams.get("fid"));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  switch (url.pathname) {
    case "/v1/linksByFid":
      return json({
        messages: fid === 100 ? [200, 300].map((t) => ({ data: { type: "MESSAGE_TYPE_LINK_ADD", fid, timestamp: 1, network: "", linkBody: { type: "follow", targetFid: t } } })) : [],
      });
    case "/v1/castsByFid": {
      const all = [...(casts[fid] ?? [])].sort((a, b) => b.data.timestamp - a.data.timestamp);
      return json({ messages: all.slice(0, Number(url.searchParams.get("pageSize") ?? 100)) });
    }
    case "/v1/signersByFid":
      return json({ signers: signers[fid] ?? [], gaslessSignerCount: 0, gaslessSignerLimit: 1000, currentUserNonce: 0 });
    case "/v1/signer":
      return json({ error: "signer not found" }, 400);
    case "/v1/userDataByFid":
      return json({ messages: [{ data: { type: "MESSAGE_TYPE_USER_DATA_ADD", fid, timestamp: 1, network: "", userDataBody: { type: "USER_DATA_TYPE_USERNAME", value: `user${fid}` } } }] });
    default:
      return json({ error: "unexpected " + url.pathname }, 404);
  }
};

const hub = new Hub({ url: "http://node.test:3381", fetch: fakeFetch });

test("appRefOf: gasless gives requestFid directly, onchain is decoded from metadata", () => {
  assert.deepEqual(appRefOf(200, signers[200]![0]), { kind: "app", requestFid: 9152, source: "onchain" });
  assert.deepEqual(appRefOf(200, signers[200]![1]), { kind: "app", requestFid: 777, source: "gasless" });
  assert.deepEqual(appRefOf(300, signers[300]![0]), { kind: "self", requestFid: 300, source: "gasless" });
  assert.deepEqual(appRefOf(1, undefined), { kind: "unknown" });
});

test("filter: include and exclude by app FID, self and unknown", () => {
  const app = { kind: "app", requestFid: 9152 } as const;
  const self = { kind: "self", requestFid: 5 } as const;
  const unknown = { kind: "unknown" } as const;
  assert.ok(passesFilter(app, undefined));
  assert.ok(passesFilter(app, { include: [9152] }));
  assert.ok(!passesFilter(self, { include: [9152] }));
  assert.ok(!passesFilter(app, { exclude: [9152] }));
  assert.ok(passesFilter(self, { exclude: [9152] }));
  assert.ok(!passesFilter(unknown, { exclude: ["unknown"] }));
  assert.ok(passesFilter(self, { include: ["self"] }));
  assert.ok(!passesFilter(app, { include: [9152], exclude: [9152] }), "exclude wins");
  assert.equal(parseAppSelector("9152"), 9152);
  assert.throws(() => parseAppSelector("abc"));
});

test("following feed merges newest first, skips replies and future-dated casts, labels apps and authors", async () => {
  const feed = new FeedBuilder(hub);
  const items = await feed.following(100);
  assert.deepEqual(
    items.map((i) => i.text),
    ["my own", "self signed", "from app 9152", "from app 777"],
  );
  const byText = Object.fromEntries(items.map((i) => [i.text, i]));
  assert.equal(byText["from app 9152"]!.app.requestFid, 9152);
  assert.equal(byText["from app 777"]!.app.requestFid, 777);
  assert.equal(byText["self signed"]!.app.kind, "self");
  assert.equal(byText["my own"]!.app.kind, "unknown", "key not listed -> unknown");
  assert.equal(byText["from app 9152"]!.author!.username, "user200");
  assert.equal(byText["from app 9152"]!.time, 1609459200000 + 40_000);
  assert.deepEqual(byText["from app 9152"]!.embeds, ["https://example.org"]);
  const names = await feed.appNames(items);
  assert.equal(names.get(9152), "user9152");
  assert.equal(names.has(777), true);
});

test("filter changes which casts show", async () => {
  const feed = new FeedBuilder(hub);
  const only9152 = await feed.following(100, { filter: { include: [9152] } });
  assert.deepEqual(only9152.map((i) => i.text), ["from app 9152"]);
  const no9152 = await feed.following(100, { filter: { exclude: [9152, "unknown"] } });
  assert.deepEqual(no9152.map((i) => i.text), ["self signed", "from app 777"]);
  const replies = await feed.following(100, { includeReplies: true });
  assert.ok(replies.some((i) => i.text === "a reply"));
});

test("signers are fetched once per author, not once per cast", async () => {
  calls.length = 0;
  const feed = new FeedBuilder(hub);
  await feed.following(100, { includeReplies: true });
  const signerCalls = calls.filter((c) => c === "/v1/signersByFid").length;
  assert.equal(signerCalls, 3); // authors 100, 200, 300
});

test("list query params use literal brackets (snapchain serde_qs strict mode)", async () => {
  let seen = "";
  const h = new Hub({
    url: "http://node.test",
    fetch: async (input) => {
      seen = String(input);
      return new Response(JSON.stringify({ signers: [], gaslessSignerCount: 0, gaslessSignerLimit: 1000, currentUserNonce: 3, requesterFidNonces: { "42": 7 } }));
    },
  });
  const r = await h.signersByFid(100, 42);
  assert.equal(seen, "http://node.test/v1/signersByFid?fid=100&requesterFids[0]=42");
  assert.equal(r.requesterFidNonces!["42"], 7);
});

test("a multi-shard page token of all nulls means no more pages", async () => {
  const { liveToken } = await import("../src/core/index.js");
  // Real tokens from mainnet castsByParent: the last page returns base64 of "[null,null]".
  assert.equal(liveToken("W251bGwsbnVsbF0="), undefined);
  assert.equal(liveToken(""), undefined);
  assert.equal(liveToken(undefined), undefined);
  const more = "W1s0LDEwNCwxMTZdLFs0LDEwNF1d"; // "[[4,104,116],[4,104]]"
  assert.equal(liveToken(more), more);
  assert.equal(liveToken("AAEC"), "AAEC", "opaque single-shard token kept");
  let n = 0;
  const h = new Hub({
    url: "http://node.test",
    fetch: async () => (n++, new Response(JSON.stringify({ messages: [], nextPageToken: "W251bGwsbnVsbF0=" }))),
  });
  const page = await h.castsByParentUrl("https://example.org");
  assert.equal(page.nextPageToken, undefined);
  assert.equal(n, 1);
});

test("sync state counts data shards only, not the block shard", async () => {
  const { syncState } = await import("../src/core/index.js");
  const shard = (shardId: number, blockDelay: number) => ({ shardId, blockDelay, maxHeight: 1, numMessages: 0, numFidRegistrations: 0, approxSize: 0 });
  // Mainnet read node after loading the snapshot: shard 0 replays from zero.
  assert.deepEqual(syncState({ shardInfos: [shard(0, 49_725_542), shard(1, 3), shard(2, 4)] } as any), { synced: true, maxDelay: 4 });
  assert.deepEqual(syncState({ shardInfos: [shard(0, 0), shard(1, 78_016), shard(2, 2)] } as any), { synced: false, maxDelay: 78_016 });
  assert.equal(syncState({ shardInfos: [shard(0, 0)] } as any).synced, false);
});

test("mentions go back into the text at their byte offsets", async () => {
  const { withMentions } = await import("../src/core/index.js");
  const names = new Map([[3, "dwr"], [5650, "vitalik.eth"]]);
  const name = (f: number) => names.get(f) ?? `fid:${f}`;
  // Mainnet shape: "Excited to collaborate with  and " with two mentions at offsets 28 and 33.
  assert.equal(withMentions("Excited to collaborate with  and ", [3, 5650], [28, 33], name), "Excited to collaborate with @dwr and @vitalik.eth");
  // Offsets count UTF-8 bytes: "é" and "👀" are 2 and 4 bytes.
  assert.equal(withMentions("é  👀 !", [3, 7], [3, 9], name), "é @dwr 👀 @fid:7!");
  assert.equal(withMentions(" gm", [3], [0], name), "@dwr gm");
  assert.equal(withMentions("plain", [], [], name), "plain");
});
