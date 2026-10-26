import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { checkShape, DEFAULT_CHECK_NODE, Hub, HubError, parseInvite, signCharter, takeInvite, verifyCharter, type CharterBody } from "../src/core/index.js";

const TOKEN = "s3cr3t-token_ABCDEFGHIJKLMNOP";
const NODE = "https://203.0.113.7.sslip.io";

test("invite link: node and token are read, and the fragment is removed from the address bar", () => {
  const replaced: string[] = [];
  const history = { replaceState: (_d: unknown, _u: string, url: string) => void replaced.push(url) };
  const loc = { pathname: "/outpost/app/", search: "?fid=3", hash: `#node=${encodeURIComponent(NODE + "/")}&token=${TOKEN}` };
  assert.deepEqual(takeInvite(loc, history), { node: NODE, token: TOKEN });
  assert.deepEqual(replaced, ["/outpost/app/?fid=3"]);
  // Not an invite: the address bar is left alone.
  assert.equal(takeInvite({ ...loc, hash: "#feed" }, history), undefined);
  assert.equal(replaced.length, 1);
  // A malformed invite is still removed before the error is shown.
  assert.throws(() => takeInvite({ ...loc, hash: `#node=${encodeURIComponent(NODE)}` }, history), /needs both/);
  assert.equal(replaced.length, 2);
});

test("invite link: read before the address bar is cleaned, because a browser's location changes with it", () => {
  const loc = { pathname: "/outpost/app/", search: "", hash: `#node=${encodeURIComponent(NODE)}&token=${TOKEN}` };
  const history = { replaceState: (_d: unknown, _u: string, url: string) => void (loc.hash = new URL(url, "https://spider333.github.io").hash) };
  assert.deepEqual(takeInvite(loc, history), { node: NODE, token: TOKEN });
  assert.equal(loc.hash, "");
});

test("invite link: only https nodes (or this machine), and a header-safe token", () => {
  assert.throws(() => parseInvite(`#node=${encodeURIComponent("http://203.0.113.7")}&token=${TOKEN}`), /https/);
  assert.throws(() => parseInvite(`#node=${encodeURIComponent("javascript:alert(1)")}&token=${TOKEN}`), /https/);
  assert.throws(() => parseInvite(`#node=${encodeURIComponent("https://user:pw@node.example")}&token=${TOKEN}`), /plain base URL/);
  assert.throws(() => parseInvite(`#node=${encodeURIComponent(NODE)}&token=short`), /16 to 512/);
  assert.throws(() => parseInvite(`#node=${encodeURIComponent(NODE)}&token=${encodeURIComponent("has a space in it ok")}`), /16 to 512/);
  assert.deepEqual(parseInvite(`#node=${encodeURIComponent("http://127.0.0.1:3381")}&token=${TOKEN}`), { node: "http://127.0.0.1:3381", token: TOKEN });
});

test("society node: every request carries the bearer token; 401 says the token was refused", async () => {
  const seen: Array<string | null> = [];
  const hub = new Hub({
    url: NODE,
    token: TOKEN,
    fetch: async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response("unauthorized", { status: 401 });
    },
  });
  await assert.rejects(hub.info(), (e: unknown) => e instanceof HubError && e.status === 401 && /refused the access token/.test(e.message));
  assert.deepEqual(seen, [`Bearer ${TOKEN}`]);
});

test("public node: reads are plain GETs with no authorization or content-type, so a page needs no CORS preflight", async () => {
  const seen: Array<{ method?: string; headers: string[] }> = [];
  const hub = new Hub({
    url: DEFAULT_CHECK_NODE,
    fetch: async (_url, init) => {
      const headers: string[] = [];
      new Headers(init?.headers).forEach((_v, k) => headers.push(k));
      seen.push({ method: init?.method, headers });
      return new Response(JSON.stringify({ version: "0.15.0", numShards: 2, shardInfos: [] }));
    },
  });
  await hub.info();
  assert.deepEqual(seen, [{ method: "GET", headers: [] }]);
});

test("society node: 429 waits for Retry-After and retries; a long wait is reported, not slept", async () => {
  let calls = 0;
  const flaky = new Hub({
    url: NODE,
    token: TOKEN,
    fetch: async () => (++calls < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : new Response(JSON.stringify({ version: "0.14.3", numShards: 2, shardInfos: [] }))),
  });
  assert.equal((await flaky.info()).version, "0.14.3");
  assert.equal(calls, 3);

  // Under a sustained limit a request keeps its place: here it is refused 10 times in a row.
  calls = 0;
  const busyNode = new Hub({
    url: NODE,
    token: TOKEN,
    fetch: async () => (++calls <= 10 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : new Response(JSON.stringify({ version: "0.14.3", numShards: 2, shardInfos: [] }))),
  });
  assert.equal((await busyNode.info()).version, "0.14.3");
  assert.equal(calls, 11);

  const t0 = Date.now();
  const limited = new Hub({ url: NODE, token: TOKEN, fetch: async () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }) });
  await assert.rejects(limited.info(), (e: unknown) => e instanceof HubError && e.status === 429 && /try again in 120 s/.test(e.message));
  assert.ok(Date.now() - t0 < 1000);
});

const KEY = privateKeyToAccount(generatePrivateKey()); // throwaway, for this test run only
const BODY: CharterBody = { charter: 1, name: "Node society", members: [1, 2], nodes: [NODE, "https://node.example.org/outpost"], issuedAt: "2026-10-19T00:00:00.000Z" };

test("charter nodes: signed with the rest, so a changed list fails verification", async () => {
  const signed = await signCharter(BODY, KEY);
  assert.equal((await verifyCharter(signed)).ok, true);
  const swapped = { ...signed, nodes: ["https://evil.example"] };
  const v = await verifyCharter(swapped);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /changed after it was signed/);
  assert.equal((await verifyCharter({ ...signed, nodes: undefined })).ok, false); // removing the list is a change too
});

test("charter nodes: https URLs only; charters without nodes still verify", async () => {
  assert.match(checkShape({ ...BODY, nodes: ["http://203.0.113.7"] }).join(), /"nodes" must be/);
  assert.match(checkShape({ ...BODY, nodes: ["https://a.example?x=1"] }).join(), /"nodes" must be/);
  assert.match(checkShape({ ...BODY, nodes: ["https://user:pw@node.example"] }).join(), /"nodes" must be/);
  await assert.rejects(signCharter({ ...BODY, nodes: ["https://user:pw@node.example"] }, KEY), /not valid/);
  await assert.rejects(signCharter({ ...BODY, nodes: ["ftp://x"] }, KEY), /not valid/);
  for (const f of ["network-states", "test-society"]) {
    const old = JSON.parse(readFileSync(new URL(`../examples/${f}.charter.json`, import.meta.url), "utf8"));
    assert.equal(old.nodes, undefined);
    assert.equal((await verifyCharter(old)).ok, true, f);
  }
});
