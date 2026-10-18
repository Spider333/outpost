import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  canonicalJson,
  census,
  checkShape,
  contentHash,
  Hub,
  passesCharter,
  signCharter,
  verifyCharter,
  type CharterBody,
  type HubMessage,
} from "../src/core/index.js";

// Hardhat test accounts 0 and 1: public, never hold anything.
const ISSUER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OTHER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const BODY: CharterBody = {
  charter: 1,
  name: "Test Society",
  description: "A society for testing kit.",
  codeOfConduct: "https://example.org/conduct",
  issuer: { fid: 500 },
  members: [100, 200, 300],
  moderators: [100],
  clients: { exclude: [9152] },
  feed: { channels: ["https://example.org/channel/test"], excludeKeywords: ["spam"] },
  issuedAt: "2026-10-18T00:00:00.000Z",
};

const hubWithCustody = (custody: string) =>
  new Hub({
    url: "http://node.test",
    fetch: async () =>
      new Response(
        JSON.stringify({
          events: [
            { blockNumber: 1, logIndex: 0, idRegisterEventBody: { to: custody, eventType: "Register" } },
            // A later recovery-address change has an empty `to` and must not count as custody.
            { blockNumber: 2, logIndex: 0, idRegisterEventBody: { to: "0x", eventType: "ChangeRecovery" } },
          ],
        }),
      ),
  });

test("canonical JSON ignores key order and whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: "x" }] }), '{"a":[2,{"c":"x","d":1}],"b":1}');
  const shuffled = JSON.parse(JSON.stringify({ ...BODY, name: BODY.name }));
  assert.equal(contentHash(shuffled), contentHash(BODY));
});

test("a signed charter verifies, and the signer is the issuer's custody on the node", async () => {
  const signed = await signCharter(BODY, ISSUER);
  const v = await verifyCharter(signed, hubWithCustody(ISSUER.address));
  assert.deepEqual(v, { ok: true, signer: ISSUER.address, issuerCheck: "custody", problems: [] });
  // Round trip through text, as it would travel in a file.
  const again = await verifyCharter(JSON.parse(JSON.stringify(signed, null, 2)));
  assert.equal(again.ok, true);
});

test("a tampered charter is rejected", async () => {
  const signed = await signCharter(BODY, ISSUER);
  const cases: Array<[string, (c: any) => void]> = [
    ["member added", (c) => c.members.push(999)],
    ["member removed", (c) => c.members.pop()],
    ["name changed", (c) => (c.name = "Test Society!")],
    ["client exclude dropped", (c) => delete c.clients],
    ["keyword rule changed", (c) => (c.feed.excludeKeywords = [])],
    ["issuer changed", (c) => (c.issuer.fid = 501)],
    ["signer swapped", (c) => (c.signature.signer = OTHER.address)],
  ];
  for (const [label, mutate] of cases) {
    const c = JSON.parse(JSON.stringify(signed));
    mutate(c);
    const v = await verifyCharter(c);
    assert.equal(v.ok, false, label);
  }
  const v = await verifyCharter({ ...JSON.parse(JSON.stringify(signed)), members: [100, 200, 300, 999] });
  assert.match(v.problems[0]!, /changed after it was signed/);
});

test("signed by someone other than the issuer's custody: rejected when checked on the node", async () => {
  const signed = await signCharter(BODY, OTHER);
  const v = await verifyCharter(signed, hubWithCustody(ISSUER.address));
  assert.equal(v.ok, false);
  assert.equal(v.issuerCheck, "mismatch");
});

test("shape problems are reported and block signing", async () => {
  assert.deepEqual(checkShape(BODY), []);
  assert.ok(checkShape({ ...BODY, members: [1, -2] }).some((p) => p.includes("members")));
  assert.ok(checkShape({ ...BODY, clients: { include: ["bogus"] } }).some((p) => p.includes("clients.include")));
  assert.ok(checkShape({ ...BODY, codeOfConduct: "javascript:alert(1)" }).some((p) => p.includes("codeOfConduct")));
  await assert.rejects(signCharter({ ...BODY, name: "" }, ISSUER), /name/);
  const unsigned = await verifyCharter(BODY);
  assert.equal(unsigned.ok, false);
});

test("lens: members or channel, minus excluded apps and keywords", () => {
  const app = (requestFid: number) => ({ kind: "app" as const, requestFid });
  assert.ok(passesCharter(BODY, { fid: 100, text: "hello", app: app(1) }));
  assert.ok(!passesCharter(BODY, { fid: 999, text: "hello", app: app(1) }), "not a member, not in channel");
  assert.ok(passesCharter(BODY, { fid: 999, text: "hello", parentUrl: "https://example.org/channel/test", app: app(1) }), "channel post");
  assert.ok(!passesCharter(BODY, { fid: 100, text: "hello", app: app(9152) }), "excluded app");
  assert.ok(!passesCharter(BODY, { fid: 100, text: "buy SPAM now", app: app(1) }), "excluded keyword");
  const kw = { ...BODY, feed: { keywords: ["node"] } };
  assert.ok(passesCharter(kw, { fid: 100, text: "my Node synced", app: app(1) }));
  assert.ok(!passesCharter(kw, { fid: 100, text: "gm", app: app(1) }));
});

test("census counts match a manual count", async () => {
  const DAY = 86400;
  const nowFc = 180_000_000; // Farcaster seconds
  const now = 1609459200000 + nowFc * 1000;
  const cast = (fid: number, ageDays: number, signer: string): HubMessage => ({
    data: { type: "MESSAGE_TYPE_CAST_ADD", fid, timestamp: nowFc - Math.round(ageDays * DAY), network: "", castAddBody: { text: "x", embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: "CAST" } },
    hash: `0x${(fid * 1000 + Math.round(ageDays * 10)).toString(16).padStart(40, "0")}`,
    hashScheme: "",
    signature: "",
    signatureScheme: "",
    signer: signer as `0x${string}`,
  });
  // 100: 3 casts in the window (2 via app 9152, 1 own key), 1 older.
  // 200: 1 cast in the window via app 777. 300: nothing recent.
  const data: Record<number, HubMessage[]> = {
    100: [cast(100, 0.5, "0xa1"), cast(100, 2, "0xa1"), cast(100, 6.9, "0xa2"), cast(100, 8, "0xa1")],
    200: [cast(200, 1, "0xb1")],
    300: [cast(300, 30, "0xc1")],
  };
  const signers: Record<number, unknown[]> = {
    100: [
      { source: "SIGNER_SOURCE_OFFCHAIN", key: "0xa1", keyType: 1, fid: 100, requestFid: 9152 },
      { source: "SIGNER_SOURCE_OFFCHAIN", key: "0xa2", keyType: 1, fid: 100, requestFid: 100 },
    ],
    200: [{ source: "SIGNER_SOURCE_OFFCHAIN", key: "0xb1", keyType: 1, fid: 200, requestFid: 777 }],
    300: [],
  };
  const hub = new Hub({
    url: "http://node.test",
    fetch: async (input) => {
      const u = new URL(String(input));
      const fid = Number(u.searchParams.get("fid"));
      if (u.pathname === "/v1/castsByFid") {
        // Serve two per page to exercise paging.
        const all = data[fid] ?? [];
        const start = Number(u.searchParams.get("pageToken") ?? 0);
        const next = start + 2 < all.length ? String(start + 2) : undefined;
        return new Response(JSON.stringify({ messages: all.slice(start, start + 2), nextPageToken: next }));
      }
      if (u.pathname === "/v1/signersByFid") {
        return new Response(JSON.stringify({ signers: signers[fid] ?? [], gaslessSignerCount: 0, gaslessSignerLimit: 1000, currentUserNonce: 0 }));
      }
      return new Response(JSON.stringify({ error: "signer not found" }), { status: 400 });
    },
  });
  const c = await census(hub, BODY, { days: 7, now });
  assert.equal(c.members, 3);
  assert.equal(c.active, 2);
  assert.equal(c.casts, 4);
  assert.equal(c.castsPerDay, 0.6);
  const mix = Object.fromEntries(c.apps.map((a) => [a.app.kind === "app" ? a.app.requestFid : a.app.kind, a.casts]));
  assert.deepEqual(mix, { 9152: 2, self: 1, 777: 1 });
  assert.equal(c.perMember.find((m) => m.fid === 300)!.casts, 0);
  assert.equal(c.perMember.find((m) => m.fid === 100)!.lastCast, now - 43_200_000);
});

test("custodyOf follows transfers and skips recovery changes", async () => {
  const hub = new Hub({
    url: "http://node.test",
    fetch: async () =>
      new Response(
        JSON.stringify({
          events: [
            { blockNumber: 5, logIndex: 1, idRegisterEventBody: { to: OTHER.address, eventType: "Transfer" } },
            { blockNumber: 1, logIndex: 0, idRegisterEventBody: { to: ISSUER.address, eventType: "Register" } },
            { blockNumber: 9, logIndex: 0, idRegisterEventBody: { to: "0x", eventType: "ChangeRecovery" } },
          ],
        }),
      ),
  });
  assert.equal(await hub.custodyOf(500), OTHER.address);
});
