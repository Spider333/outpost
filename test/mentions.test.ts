import { test } from "node:test";
import assert from "node:assert/strict";
import { FarcasterNetwork } from "@farcaster/core";
import { buildCast, extractMentions, Hub, mentionedNames, mentionQuery, resolveMentions, withMentions, type AppKey } from "../src/core/index.js";

const KEY: AppKey = {
  fid: 424242,
  privateKey: "0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  publicKey: "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  requestFid: 424242,
  scopes: [],
  ttl: 86400,
  network: FarcasterNetwork.MAINNET,
};
const bytes = (s: string) => new TextEncoder().encode(s).length;
const names = new Map([[3, "dwr"], [5650, "vitalik.eth"], [1, "a"], [2, "b"]]);
const back = (r: { text: string; mentions: number[]; mentionsPositions: number[] }) => withMentions(r.text, r.mentions, r.mentionsPositions, (f) => names.get(f)!);

test("a picked @name becomes a mention at its byte offset", () => {
  assert.deepEqual(extractMentions("hi @dwr", [{ name: "dwr", fid: 3 }]), { text: "hi ", mentions: [3], mentionsPositions: [3] });
});

test("offsets are UTF-8 bytes after emoji and multibyte text", () => {
  const r = extractMentions("🎉 @dwr ok", [{ name: "dwr", fid: 3 }]);
  assert.deepEqual(r, { text: "🎉  ok", mentions: [3], mentionsPositions: [5] });
  assert.equal(r.mentionsPositions[0], bytes("🎉 "));
  const r2 = extractMentions("Grüße, 日本 👩‍👩‍👧 @dwr und @vitalik.eth!", [{ name: "dwr", fid: 3 }, { name: "vitalik.eth", fid: 5650 }]);
  assert.deepEqual(r2.mentionsPositions, [bytes("Grüße, 日本 👩‍👩‍👧 "), bytes("Grüße, 日本 👩‍👩‍👧  und ")]);
  assert.equal(back(r2), "Grüße, 日本 👩‍👩‍👧 @dwr und @vitalik.eth!");
});

test("two names give two mentions in ascending order", () => {
  const r = extractMentions("@a and @b", [{ name: "b", fid: 2 }, { name: "a", fid: 1 }]);
  assert.deepEqual(r, { text: " and ", mentions: [1, 2], mentionsPositions: [0, 5] });
  assert.equal(back(r), "@a and @b");
});

test("more than 10 mentions is refused", () => {
  const picks = Array.from({ length: 11 }, (_, i) => ({ name: `u${i}`, fid: 100 + i }));
  assert.throws(() => extractMentions(picks.map((p) => `@${p.name}`).join(" "), picks), /at most 10 mentions/);
  assert.equal(extractMentions(picks.slice(0, 10).map((p) => `@${p.name}`).join(" "), picks).mentions.length, 10);
});

test("an edited pick, or a name never picked, stays plain text", () => {
  const picks = [{ name: "dwr", fid: 3 }];
  assert.deepEqual(extractMentions("hi @dwrx", picks), { text: "hi @dwrx", mentions: [], mentionsPositions: [] });
  assert.deepEqual(extractMentions("hi @dw", picks), { text: "hi @dw", mentions: [], mentionsPositions: [] });
  assert.deepEqual(extractMentions("hi @someone", picks).mentions, []);
  assert.deepEqual(extractMentions("mail me@dwr", picks).mentions, []); // not after a name character
  assert.deepEqual(extractMentions("hi @dwr.eth", picks).mentions, []); // a longer, different name
});

test("a full stop or comma after a name ends it; case does not matter", () => {
  const r = extractMentions("thanks @DWR. and @dwr, bye", [{ name: "dwr", fid: 3 }]);
  assert.deepEqual(r.mentions, [3, 3]);
  assert.equal(back(r), "thanks @dwr. and @dwr, bye");
});

test("the longest picked name wins", () => {
  const r = extractMentions("gm @vitalik.eth", [{ name: "vitalik", fid: 9 }, { name: "vitalik.eth", fid: 5650 }]);
  assert.deepEqual(r.mentions, [5650]);
});

test("trimming never moves a mention or puts it past the end", () => {
  assert.deepEqual(extractMentions("  hi @dwr  ", [{ name: "dwr", fid: 3 }]), { text: "hi ", mentions: [3], mentionsPositions: [3] });
  const r = extractMentions(" @dwr gm", [{ name: "dwr", fid: 3 }]);
  assert.deepEqual(r, { text: "  gm", mentions: [3], mentionsPositions: [1] });
  for (const t of ["hi @dwr", "@dwr", " @dwr ", "x @dwr   "]) {
    const m = extractMentions(t, [{ name: "dwr", fid: 3 }]);
    assert.ok(m.mentionsPositions.every((p) => p <= bytes(m.text)), t);
  }
});

test("buildCast signs the mentions with the extracted text unchanged", async () => {
  const r = extractMentions("🎉 @dwr ok", [{ name: "dwr", fid: 3 }]);
  const msg = await buildCast(KEY, r, 182_000_000);
  const body = msg.data!.castAddBody!;
  assert.equal(body.text, "🎉  ok");
  assert.deepEqual(body.mentions, [3]);
  assert.deepEqual(body.mentionsPositions, [5]);
});

test("mentionQuery finds the @word being typed", () => {
  assert.deepEqual(mentionQuery("hi @dw", 6), { start: 3, query: "dw" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.equal(mentionQuery("hi @dw ", 7), undefined);
  assert.equal(mentionQuery("me@dw", 5), undefined);
  assert.deepEqual(mentionQuery("🎉 @v", "🎉 @v".length), { start: 3, query: "v" });
});

test("mentionedNames lists every @word", () => {
  assert.deepEqual(mentionedNames("hi @dwr and @Vitalik.eth. me@x @-no"), ["dwr", "vitalik.eth"]);
});

// A node that knows one name: "dwr" is FID 3, and FID 3's profile says so. FID 9 claims "liar"
// in the proof, but its own profile carries a different name.
function nameNode() {
  const userData = (fid: number, name: string) => ({
    messages: [{ data: { type: "MESSAGE_TYPE_USER_DATA_ADD", fid, timestamp: 1, network: "FARCASTER_NETWORK_MAINNET", userDataBody: { type: "USER_DATA_TYPE_USERNAME", value: name } }, hash: "0x00", hashScheme: "", signature: "", signatureScheme: "", signer: "0x00" }],
  });
  const fetch = async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const body =
      u.pathname === "/v1/userNameProofByName" && u.searchParams.get("name") === "dwr" ? { fid: 3 }
      : u.pathname === "/v1/userNameProofByName" && u.searchParams.get("name") === "liar" ? { fid: 9 }
      : u.pathname === "/v1/userDataByFid" && u.searchParams.get("fid") === "3" ? userData(3, "dwr")
      : u.pathname === "/v1/userDataByFid" && u.searchParams.get("fid") === "9" ? userData(9, "someone-else")
      : undefined;
    return new Response(JSON.stringify(body ?? { error: "not found" }), { status: body ? 200 : 400 });
  };
  return new Hub({ url: "http://node.test", fetch: fetch as typeof globalThis.fetch });
}

test("resolveMentions looks names up and refuses an unknown one, naming it", async () => {
  const hub = nameNode();
  assert.deepEqual(await resolveMentions(hub, "🎉 hi @dwr!"), { text: "🎉 hi !", mentions: [3], mentionsPositions: [bytes("🎉 hi ")] });
  assert.deepEqual(await resolveMentions(hub, "no names here"), { text: "no names here" });
  await assert.rejects(resolveMentions(hub, "hi @dwr and @nobody"), /unknown username @nobody/);
  // The node's proof alone is not enough: the account's own profile must carry the name.
  await assert.rejects(resolveMentions(hub, "hi @liar"), /unknown username @liar/);
});
