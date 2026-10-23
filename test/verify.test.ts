import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CastType, FarcasterNetwork, makeCastAdd, NobleEd25519Signer } from "@farcaster/core";
import { bytesToHex } from "viem";
import {
  checkMessage,
  FeedBuilder,
  Hub,
  messageData,
  SecondNode,
  secondNode,
  signedMessage,
  Verifier,
  verifyMessage,
  census,
  type HexString,
  type HubMessage,
  type HubSigner,
  type KeyRegistry,
} from "../src/core/index.js";

// Real mainnet messages from Farcaster's public read node, unmodified (see the file's "source").
const real = JSON.parse(readFileSync(new URL("./fixtures/real-messages.json", import.meta.url), "utf8")).messages as Record<string, HubMessage>;
const copy = (m: HubMessage): HubMessage => JSON.parse(JSON.stringify(m));
const AUTHOR = real.quote!.data.fid;
const AUTHOR_KEY = real.quote!.signer;

// Snapchain's JSON for a message @farcaster/core built (what the node would return for it).
async function asNodeJson(text: string, signer: NobleEd25519Signer, fid = AUTHOR): Promise<HubMessage> {
  const m = (
    await makeCastAdd(
      { text, type: CastType.CAST, embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [] },
      { fid, network: FarcasterNetwork.MAINNET, timestamp: real.quote!.data.timestamp + 10 },
      signer,
    )
  )._unsafeUnwrap();
  return {
    data: {
      type: "MESSAGE_TYPE_CAST_ADD",
      fid,
      timestamp: m.data!.timestamp,
      network: "FARCASTER_NETWORK_MAINNET",
      castAddBody: { embedsDeprecated: [], mentions: [], parentCastId: null, parentUrl: null, text, embeds: [], mentionsPositions: [], type: "CAST" },
    },
    hash: bytesToHex(m.hash),
    hashScheme: "HASH_SCHEME_BLAKE3",
    signature: Buffer.from(m.signature).toString("base64"),
    signatureScheme: "SIGNATURE_SCHEME_ED25519",
    signer: bytesToHex(m.signer),
  };
}

const throwaway = () => new NobleEd25519Signer(crypto.getRandomValues(new Uint8Array(32)));
const keyOf = async (s: NobleEd25519Signer) => bytesToHex((await s.getSignerKey())._unsafeUnwrap());
const onchain = (fid: number, key: HexString): HubSigner => ({ source: "SIGNER_SOURCE_ONCHAIN", key, keyType: 1, fid });
const gasless = (fid: number, key: HexString): HubSigner => ({ source: "SIGNER_SOURCE_OFFCHAIN", key, keyType: 1, fid, requestFid: fid });

// A node that answers castsByFid, signersByFid and userDataByFid from fixed lists.
function fakeNode(world: { casts: HubMessage[]; signers: HubSigner[]; userData?: HubMessage[] }): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body));
    switch (url.pathname) {
      case "/v1/castsByFid":
        return json({ messages: world.casts });
      case "/v1/signersByFid":
        return json({ signers: world.signers, gaslessSignerCount: 0, gaslessSignerLimit: 1000, currentUserNonce: 0 });
      case "/v1/userDataByFid":
        return json({ messages: world.userData ?? [] });
      default:
        return new Response(JSON.stringify({ error: "not found" }), { status: 400 });
    }
  };
}

// Stands in for the KeyRegistry on Optimism: only the listed keys are added onchain.
const registry = (added: Array<[number, string]>, removed: Array<[number, string]> = []): KeyRegistry => ({
  keyState: async (fid, key) =>
    added.some(([f, k]) => f === fid && k === key.toLowerCase()) ? "added" : removed.some(([f, k]) => f === fid && k === key.toLowerCase()) ? "removed" : "none",
});

test("real mainnet messages of every type we read pass verification", async () => {
  for (const [name, m] of Object.entries(real)) assert.equal(await checkMessage(m), "ok", name);
});

test("a malicious node: altered text, bad signature and a key falsely claimed for the author are dropped", async () => {
  const altered = copy(real.quote!);
  altered.data.castAddBody!.text += " (edited by the node)";
  const badSig = copy(real.cast!);
  const sig = Buffer.from(badSig.signature, "base64");
  sig[10]! ^= 1;
  badSig.signature = sig.toString("base64");
  // The node's own key signs a cast "by" the author and the node lists that key as theirs.
  const nodeKey = throwaway();
  const forged = await asNodeJson("I endorse whatever the host says", nodeKey);
  const valid = real.quote!;

  const verifier = new Verifier(registry([[AUTHOR, AUTHOR_KEY]]));
  const hub = new Hub({
    url: "http://node.test",
    verifier,
    fetch: fakeNode({ casts: [altered, badSig, forged, valid], signers: [onchain(AUTHOR, AUTHOR_KEY), onchain(AUTHOR, await keyOf(nodeKey))], userData: [real.userData!] }),
  });
  const items = await new FeedBuilder(hub).fromAuthors([AUTHOR], { limit: 10, perAuthor: 10 });

  assert.deepEqual(items.map((i) => i.hash), [valid.hash]);
  assert.equal(items[0]!.app.keyCheck, "onchain");
  assert.equal(items[0]!.author?.displayName, "Farcaster"); // the real profile passed too
  assert.deepEqual(verifier.dropped, { altered: 1, signature: 1, mismatch: 0, signer: 1 });
  assert.equal(verifier.failed, 3);
  assert.match(verifier.summary(), /^Your node sent 3 of 5 messages that failed verification \(1 altered, 1 with a bad signature, 1 signed by a key that is not the author's\)/);
});

test("a key that cannot be checked (no second node): hidden by default and counted, shown marked on request", async () => {
  const k = throwaway();
  const cast = await asNodeJson("signed with a gasless key", k);
  const node = fakeNode({ casts: [cast], signers: [gasless(AUTHOR, await keyOf(k))] });
  const verifier = new Verifier(registry([]));
  assert.equal((await new FeedBuilder(new Hub({ url: "http://node.test", verifier, fetch: node })).fromAuthors([AUTHOR], { limit: 10 })).length, 0);
  assert.equal(verifier.unverified, 1);
  assert.equal(verifier.failed, 0);
  assert.doesNotMatch(verifier.summary(), /passed/);
  assert.match(verifier.summary(), /^1 messages were hidden because their signing key could not be checked/);

  const shown = new Verifier(registry([]));
  shown.showUnverified = true;
  const items = await new FeedBuilder(new Hub({ url: "http://node.test", verifier: shown, fetch: node })).fromAuthors([AUTHOR], { limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.app.keyCheck, "unverified"); // the web and CLI mark it "signer not verified"
  assert.match(shown.summary(), /shown although their signing key could not be checked/);
});

test("an onchain key the author removed since is marked revoked, and its earlier casts are shown (Snapchain V14 keeps them)", async () => {
  const k = throwaway();
  const key = await keyOf(k);
  const cast = await asNodeJson("signed before the key was removed", k);
  const verifier = new Verifier(registry([], [[AUTHOR, key]]));
  const items = await new FeedBuilder(new Hub({ url: "http://node.test", verifier, fetch: fakeNode({ casts: [cast], signers: [] }) })).fromAuthors([AUTHOR], { limit: 10 });
  assert.deepEqual(items.map((i) => [i.hash, i.app.keyCheck]), [[cast.hash, "revoked"]]);
  assert.deepEqual({ failed: verifier.failed, unverified: verifier.unverified }, { failed: 0, unverified: 0 });
});

test("no RPC means unverified, and RPC errors are not cached", async () => {
  const key = await keyOf(throwaway());
  assert.equal(await new Verifier().keyCheck(AUTHOR, key, true), "unverified");
  let calls = 0;
  const flaky = new Verifier({ keyState: async () => (++calls === 1 ? Promise.reject(new Error("rpc down")) : "added") });
  assert.equal(await flaky.keyCheck(AUTHOR, key, true), "unverified");
  assert.equal(await flaky.keyCheck(AUTHOR, key, true), "onchain");
});

test("a valid message that does not answer the request is dropped", async () => {
  const other = await asNodeJson("someone else's cast", throwaway(), AUTHOR + 1);
  const verifier = new Verifier();
  const answer = (body: unknown) => async () => new Response(JSON.stringify(body));
  // castsByFid for AUTHOR returning another account's cast.
  const page = await new Hub({ url: "http://node.test", verifier, fetch: answer({ messages: [other] }) }).castsByFid(AUTHOR);
  assert.equal(page.items.length, 0);
  // castById for one cast returning a different (valid) cast of the same account.
  const hub = new Hub({ url: "http://node.test", verifier, fetch: answer(real.cast) });
  assert.equal(await hub.castById(AUTHOR, real.quote!.hash), undefined);
  // reactionById returning the account's like of a different cast.
  const target = { fid: 1970, hash: "0x00000000000000000000000000000000000000aa" as HexString };
  assert.equal(await new Hub({ url: "http://node.test", verifier, fetch: answer(real.reaction) }).reactionById(AUTHOR, "Like", target), undefined);
  assert.equal(verifier.dropped.mismatch, 3);
  // The same reaction, asked for correctly, passes.
  const r = real.reaction!.data.reactionBody!.targetCastId!;
  assert.ok(await new Hub({ url: "http://node.test", verifier, fetch: answer(real.reaction) }).reactionById(AUTHOR, "Like", { fid: r.fid, hash: r.hash as HexString }));
});

test("census does not count casts whose key is provably not the member's", async () => {
  const k = throwaway();
  const forged = await asNodeJson("forged", k);
  const verifier = new Verifier(registry([[AUTHOR, AUTHOR_KEY]]));
  const hub = new Hub({ url: "http://node.test", verifier, fetch: fakeNode({ casts: [forged, real.quote!], signers: [onchain(AUTHOR, AUTHOR_KEY), onchain(AUTHOR, await keyOf(k))] }) });
  const now = Date.UTC(2021, 0, 1) + (real.quote!.data.timestamp + 60) * 1000;
  const c = await census(hub, { charter: 1, name: "t", members: [AUTHOR], issuedAt: "2026-10-19T00:00:00Z" }, { days: 30, now });
  assert.equal(c.casts, 1);
  assert.equal(verifier.dropped.signer, 1);
});

test("casts encoded by non-TypeScript apps verify, and are no loophole: changing one still fails", async () => {
  // Posted by an app that writes protobuf fields in number order and leaves empty lists out.
  const ch = real.channelProto3!;
  assert.equal(await checkMessage(ch), "ok");
  for (const change of [
    (m: HubMessage) => (m.data.castAddBody!.text += "!"),
    (m: HubMessage) => (m.data.castAddBody!.parentUrl = "https://farcaster.xyz/~/channel/other"),
    (m: HubMessage) => m.data.castAddBody!.embeds.pop(),
    (m: HubMessage) => (m.data.castAddBody!.mentions = [3]),
  ]) {
    const m = copy(ch);
    change(m);
    assert.equal(await checkMessage(m), "altered");
  }
  // A channel feed keeps only casts posted to the channel that was asked for.
  const verifier = new Verifier();
  const answer = async () => new Response(JSON.stringify({ messages: [ch, real.quote] }));
  const page = await new Hub({ url: "http://node.test", verifier, fetch: answer }).castsByParentUrl(ch.data.castAddBody!.parentUrl!);
  assert.deepEqual(page.items.map((m) => m.hash), [ch.hash]);
  assert.equal(verifier.dropped.mismatch, 1);
});

// A second node that lists only `keys` as AUTHOR's active keys, or is down. Counts its requests.
function secondListing(keys: string[], state = { down: false, calls: 0 }) {
  const node = new SecondNode(
    new Hub({
      url: "http://second.test",
      fetch: async (input) => {
        state.calls++;
        if (state.down) throw new Error("connection refused");
        const fid = Number(new URL(String(input)).searchParams.get("fid"));
        const signers = fid === AUTHOR ? keys.map((k) => gasless(AUTHOR, k as HexString)) : [];
        return new Response(JSON.stringify({ signers, gaslessSignerCount: signers.length, gaslessSignerLimit: 1000, currentUserNonce: 0 }));
      },
    }),
  );
  return { node, state };
}

test("a malicious node with a second node: a gasless key the second node does not list is held back, one it lists is confirmed", async () => {
  const real1 = throwaway();
  const fake = throwaway();
  const listed = await asNodeJson("posted from an app with a gasless key", real1);
  const forged = await asNodeJson("the node's own key, called gasless", fake);
  const second = secondListing([await keyOf(real1)]);
  const verifier = new Verifier(registry([[AUTHOR, AUTHOR_KEY]]), second.node);
  const hub = new Hub({
    url: "http://node.test",
    verifier,
    fetch: fakeNode({
      casts: [listed, forged, real.quote!],
      signers: [onchain(AUTHOR, AUTHOR_KEY), gasless(AUTHOR, await keyOf(real1)), gasless(AUTHOR, await keyOf(fake))],
      userData: [real.userData!],
    }),
  });
  const items = await new FeedBuilder(hub).fromAuthors([AUTHOR], { limit: 10, perAuthor: 10 });
  assert.deepEqual(new Map(items.map((i) => [i.hash, i.app.keyCheck])), new Map([[listed.hash, "confirmed"], [real.quote!.hash, "onchain"]]));
  // Not shown, and not called a forgery either: a key revoked since looks the same.
  assert.deepEqual({ unlisted: verifier.unlisted, failed: verifier.failed }, { unlisted: 1, failed: 0 });
  // One signersByFid read covered both gasless keys; the onchain key never reached it.
  assert.equal(second.state.calls, 1);
});

test("second node down: unverified and not remembered; a second node on the same origin is skipped", async () => {
  const k = await keyOf(throwaway());
  const second = secondListing([k], { down: true, calls: 0 });
  const verifier = new Verifier(registry([]), second.node);
  assert.equal(await verifier.keyCheck(AUTHOR, k, false), "unverified");
  second.state.down = false;
  assert.equal(await verifier.keyCheck(AUTHOR, k, false), "confirmed");
  // The Optimism RPC failing is not fatal either: the second node lists onchain keys too.
  const noRpc = new Verifier({ keyState: () => Promise.reject(new Error("rpc down")) }, secondListing([k]).node);
  assert.equal(await noRpc.keyCheck(AUTHOR, k, true), "confirmed");

  assert.equal(secondNode("https://node.example:3381", "https://node.example:3381/"), undefined);
  assert.ok(secondNode("https://snap.farcaster.xyz:3381", "https://203-0-113-7.sslip.io") instanceof SecondNode);
  assert.equal(await new Verifier(registry([]), secondNode("https://node.example", "https://node.example")).keyCheck(AUTHOR, k, false), "unverified");
});

const PHISH = "https://phish.example/claim";
// What signedMessage() would build from the node's JSON, before the extra-field check runs.
const rebuiltFrom = (m: HubMessage) => signedMessage(messageData(m.data), new Uint8Array(20), new Uint8Array(64), new Uint8Array(32));

test("embed injection: a url the node adds next to a signed castId never reaches the feed", async () => {
  const inj = copy(real.quote!);
  const e = inj.data.castAddBody!.embeds.find((x) => "castId" in x) as { castId: unknown; url?: string };
  e.url = PHISH;
  assert.equal(await checkMessage(inj), "altered");
  // Even without that check, the rebuilt message carries only the signed castId.
  assert.ok(!JSON.stringify(rebuiltFrom(inj)).includes("phish"));

  const verifier = new Verifier(registry([[AUTHOR, AUTHOR_KEY]]));
  const hub = new Hub({ url: "http://node.test", verifier, fetch: fakeNode({ casts: [inj], signers: [onchain(AUTHOR, AUTHOR_KEY)] }) });
  const items = await new FeedBuilder(hub).fromAuthors([AUTHOR], { includeReplies: true });
  assert.equal(items.length, 0);
  assert.equal(verifier.dropped.altered, 1);
});

test("every message type: callers get the message rebuilt from signed data, and an added field marks it altered", async () => {
  for (const [name, m] of Object.entries(real)) {
    // An honest message round-trips exactly.
    assert.deepEqual(await verifyMessage(m), m, name);
    const body = Object.keys(m.data).find((k) => k.endsWith("Body"))!;
    for (const add of [
      (x: HubMessage) => ((x.data as unknown as Record<string, Record<string, unknown>>)[body]!.injected = PHISH),
      (x: HubMessage) => ((x.data as unknown as Record<string, unknown>).injected = PHISH),
      (x: HubMessage) => ((x as unknown as Record<string, unknown>).injected = PHISH),
    ]) {
      const x = copy(m);
      add(x);
      assert.equal(await checkMessage(x), "altered", name);
      assert.ok(!JSON.stringify(rebuiltFrom(x)).includes("phish"), name);
    }
  }
  // Through the Hub as well: what castById returns is the rebuilt message, not the node's object.
  const verifier = new Verifier();
  const served = copy(real.cast!);
  const got = await new Hub({ url: "http://node.test", verifier, fetch: async () => new Response(JSON.stringify(served)) }).castById(AUTHOR, served.hash);
  assert.deepEqual(got, real.cast);
  assert.notEqual(got, served);
});

test("an added field named like a built-in (constructor, toString, __proto__) also marks a message altered", async () => {
  for (const [name, m] of Object.entries(real)) {
    const body = Object.keys(m.data).find((k) => k.endsWith("Body"))!;
    for (const field of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      for (const at of [(x: HubMessage) => (x.data as unknown as Record<string, object>)[body]!, (x: HubMessage) => x.data, (x: HubMessage) => x]) {
        const x = copy(m);
        // defineProperty makes an own property even for __proto__, as JSON.parse does.
        Object.defineProperty(at(x), field, { value: "honest words", enumerable: true, writable: true, configurable: true });
        assert.equal(await checkMessage(x), "altered", `${name} ${field}`);
      }
    }
  }
});

test("fail closed: with the second node down, a forged gasless cast is hidden and counted as unverified, not as passed", async () => {
  const fake = throwaway();
  const forged = await asNodeJson("the host's own key, called gasless", fake);
  const second = secondListing([], { down: true, calls: 0 });
  const verifier = new Verifier(registry([[AUTHOR, AUTHOR_KEY]]), second.node);
  const node = fakeNode({ casts: [forged, real.quote!], signers: [onchain(AUTHOR, AUTHOR_KEY), gasless(AUTHOR, await keyOf(fake))], userData: [real.userData!] });
  const hub = new Hub({ url: "http://node.test", verifier, fetch: node });
  const hidden = await new FeedBuilder(hub).fromAuthors([AUTHOR], { limit: 10, perAuthor: 10 });
  assert.deepEqual(hidden.map((i) => i.hash), [real.quote!.hash]);
  assert.equal(verifier.unverified, 1);
  assert.equal(verifier.failed, 0);
  assert.doesNotMatch(verifier.summary(), /All .* passed/);

  // "Show them anyway": shown, still marked unverified; the down state was not remembered.
  verifier.showUnverified = true;
  verifier.reset();
  const shown = await new FeedBuilder(hub).fromAuthors([AUTHOR], { limit: 10, perAuthor: 10 });
  assert.deepEqual(new Map(shown.map((i) => [i.hash, i.app.keyCheck])), new Map([[forged.hash, "unverified"], [real.quote!.hash, "onchain"]]));

  // Second node back: it does not list the key. That is either a forgery or a key revoked since
  // (whose casts Snapchain keeps), so the cast stays hidden and is called what it is.
  second.state.down = false;
  verifier.showUnverified = false;
  verifier.reset();
  const back = await new FeedBuilder(hub).fromAuthors([AUTHOR], { limit: 10, perAuthor: 10 });
  assert.deepEqual(back.map((i) => i.hash), [real.quote!.hash]);
  assert.deepEqual({ unverified: verifier.unverified, unlisted: verifier.unlisted, failed: verifier.failed }, { unverified: 1, unlisted: 1, failed: 0 });
  assert.match(verifier.summary(), /^1 messages were hidden because the second node does not list their signing key: it was revoked since, or is not the author's\.$/);

  verifier.showUnverified = true;
  verifier.reset();
  const marked = await new FeedBuilder(hub).fromAuthors([AUTHOR], { limit: 10, perAuthor: 10 });
  assert.equal(marked.find((i) => i.hash === forged.hash)?.app.keyCheck, "unlisted");
  assert.match(verifier.summary(), /shown although the second node does not list their signing key/);
});

test("hex fields must be 0x and lower case, and the signature canonical base64, though none of it changes what was signed", async () => {
  assert.equal(await checkMessage(real.reaction!), "ok");
  const sig = real.reaction!.signature;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = sig.replace(/=+$/, "").length - 1;
  const changes: Array<[string, (m: HubMessage) => void]> = [
    ["signer prefix", (m) => (m.signer = `1x${m.signer.slice(2)}` as HexString)],
    ["target hash prefix", (m) => (m.data.reactionBody!.targetCastId!.hash = `0y${m.data.reactionBody!.targetCastId!.hash.slice(2)}`)],
    ["signer upper case", (m) => (m.signer = `0x${m.signer.slice(2).toUpperCase()}` as HexString)],
    ["hash upper case", (m) => (m.hash = `0x${m.hash.slice(2).toUpperCase()}` as HexString)],
    ["target hash upper case", (m) => (m.data.reactionBody!.targetCastId!.hash = `0x${m.data.reactionBody!.targetCastId!.hash.slice(2).toUpperCase()}`)],
    // Flips a bit the decoder ignores: the same 64 signature bytes, spelled differently.
    ["signature spelling", (m) => (m.signature = sig.slice(0, last) + alphabet[alphabet.indexOf(sig[last]!) ^ 1]! + sig.slice(last + 1))],
  ];
  for (const [label, change] of changes) {
    const m = copy(real.reaction!);
    change(m);
    assert.equal(await checkMessage(m), "altered", label);
  }
});

test("the member's own app key is never held back, even with no way to check keys", async () => {
  const mine = throwaway();
  const cast = await asNodeJson("my own cast", mine);
  const verifier = new Verifier();
  verifier.trust(AUTHOR, await keyOf(mine));
  const hub = new Hub({ url: "http://node.test", verifier, fetch: fakeNode({ casts: [cast], signers: [gasless(AUTHOR, await keyOf(mine))] }) });
  const items = await new FeedBuilder(hub).fromAuthors([AUTHOR], { limit: 10 });
  assert.equal(items[0]?.app.keyCheck, "own");
  assert.equal(verifier.unverified, 0);
});
