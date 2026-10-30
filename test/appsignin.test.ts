import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { SIGNED_KEY_REQUEST_TYPE, SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN } from "@farcaster/core";
import { verifyMessage, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REQUEST_SECONDS, signKeyRequest, SignInClient, type AppAccount, type HexString } from "../src/core/index.js";
import { sameOrigin, signInHandler } from "../src/server/appsignin-service.js";
import { fakeFarcaster } from "./fake-farcaster.js";

// Hardhat test account 2: public, never holds anything.
const CUSTODY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as HexString;
const APP: AppAccount = { fid: 777, custodyKey: CUSTODY, address: privateKeyToAccount(CUSTODY).address };
const KEY = "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a" as HexString;

test("the key request is a valid EIP-712 SignedKeyRequest from the app account, deadline ahead", async () => {
  const now = Math.floor(Date.now() / 1000);
  const b = await signKeyRequest(APP, KEY, now);
  assert.equal(b.requestFid, 777);
  assert.equal(b.key, KEY);
  assert.equal(b.deadline, now + REQUEST_SECONDS);
  assert.ok(b.deadline > now);
  assert.ok(
    await verifyTypedData({
      address: APP.address,
      domain: SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN,
      types: { SignedKeyRequest: SIGNED_KEY_REQUEST_TYPE },
      primaryType: "SignedKeyRequest",
      message: { requestFid: 777n, key: KEY, deadline: BigInt(b.deadline) },
      signature: b.signature,
    }),
  );
  assert.equal(b.sponsorship, undefined);
  const s = await signKeyRequest({ ...APP, sponsor: true }, KEY, now);
  assert.equal(s.sponsorship?.sponsorFid, 777);
  assert.ok(await verifyMessage({ address: APP.address, message: { raw: s.signature }, signature: s.sponsorship!.signature }));
  await assert.rejects(signKeyRequest(APP, "0x1234" as HexString), /32-byte/);
  await assert.rejects(signKeyRequest({ ...APP, address: "0x0000000000000000000000000000000000000001" }, KEY), /does not match/);
});

async function serve(handler: ReturnType<typeof signInHandler>): Promise<{ url: string; server: Server; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const end = res.end.bind(res);
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (chunk) bodies.push(String(chunk));
      return end(chunk as never, ...(rest as []));
    }) as typeof res.end;
    const path = (req.url ?? "/").split("?")[0]!;
    handler(req, res, path.slice("/outpost/app-signin".length));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, bodies };
}

test("sign-in over HTTP: same origin only, approval polled, the app account's key never sent", async () => {
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  const fc = await fakeFarcaster({ appAddress: APP.address, userFid: 4242 });
  const { url, server, bodies } = await serve(signInHandler({ account: () => APP, api: fc.url, refuse: sameOrigin }));
  try {
    const page = new SignInClient(`${url}/outpost/app-signin`, { origin: url });
    assert.deepEqual(await page.service(), { configured: true, fid: 777, sponsored: false });
    // Another website, or a request without Origin, cannot start one.
    const foreign = await fetch(`${url}/outpost/app-signin`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ key: KEY }) });
    assert.equal(foreign.status, 403);
    assert.equal((await fetch(`${url}/outpost/app-signin`, { method: "POST", body: JSON.stringify({ key: KEY }) })).status, 403);
    assert.equal((await fetch(`${url}/outpost/app-signin`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ key: "0x12" }) })).status, 400);

    const r = await page.start(KEY);
    assert.match(r.deeplinkUrl, /^farcaster:\/\/signed-key-request\?token=0x[0-9a-f]+$/);
    assert.equal(r.requestFid, 777);
    assert.ok(r.deadline > Date.now() / 1000);
    assert.deepEqual(Object.keys(r).sort(), ["deadline", "deeplinkUrl", "requestFid", "token"]);
    assert.equal(fc.requests.length, 1, "the endpoint got one request, with a signature it accepted");
    assert.deepEqual(await page.state(r.token), { state: "pending" });
    fc.approve(r.token);
    assert.deepEqual(await page.state(r.token), { state: "completed", userFid: 4242 });
    // Only tokens this server handed out can be polled.
    await assert.rejects(page.state("0xabc"), /unknown request/);

    const secret = CUSTODY.slice(2).toLowerCase();
    const signature = fc.requests[0]!.body.signature.slice(2).toLowerCase();
    for (const b of [...bodies, ...logs]) {
      assert.ok(!b.toLowerCase().includes(secret), "custody key in a response or log");
      assert.ok(!b.toLowerCase().includes(signature), "the app account's signature in a response or log");
    }
  } finally {
    console.log = log;
    server.close();
    fc.close();
  }
});

test("a request not approved before its deadline is reported expired; no app account is explained", async () => {
  const fc = await fakeFarcaster({ appAddress: APP.address, userFid: 4242 });
  let now = Math.floor(Date.now() / 1000);
  const { url, server } = await serve(signInHandler({ account: () => APP, api: fc.url, now: () => now }));
  const none = await serve(signInHandler({ account: () => undefined, api: fc.url }));
  try {
    const page = new SignInClient(`${url}/outpost/app-signin`);
    const r = await page.start(KEY);
    now += REQUEST_SECONDS + 1;
    assert.deepEqual(await page.state(r.token), { state: "expired" });
    await assert.rejects(page.state(r.token), /unknown request/);

    const empty = new SignInClient(`${none.url}/outpost/app-signin`);
    assert.deepEqual(await empty.service(), { configured: false });
    await assert.rejects(empty.start(KEY), /no app account is set up here/);
    // A static host with no Outpost server behind it.
    assert.equal(await new SignInClient("http://127.0.0.1:1/x").service(), undefined);
  } finally {
    server.close();
    none.server.close();
    fc.close();
  }
});

test("an answer from the endpoint that is not a Farcaster link is refused", async () => {
  const bad = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: { signedKeyRequest: { token: "0xab", deeplinkUrl: "https://phish.example/?token=0xab", state: "pending" } } })));
  await new Promise<void>((ok) => bad.listen(0, "127.0.0.1", ok));
  const api = `http://127.0.0.1:${(bad.address() as { port: number }).port}`;
  const { url, server } = await serve(signInHandler({ account: () => APP, api }));
  try {
    await assert.rejects(new SignInClient(`${url}/outpost/app-signin`).start(KEY), /does not understand/);
  } finally {
    server.close();
    bad.close();
  }
});

test("society node: members only by token, CORS for the hosted page, nothing outside /app-signin", async () => {
  const { createHash } = await import("node:crypto");
  const { societySignIn } = await import("../src/server/appsignin-service.js");
  const fc = await fakeFarcaster({ appAddress: APP.address, userFid: 4242 });
  const members = () => new Map([[createHash("sha256").update("member-token").digest("hex"), "alice"]]);
  const server = createServer(societySignIn({ account: () => APP, api: fc.url, members }));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const pages = "https://spider333.github.io";
    const pre = await fetch(`${url}/app-signin`, { method: "OPTIONS", headers: { origin: pages } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), pages);
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    assert.equal((await fetch(`${url}/app-signin`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).headers.get("access-control-allow-origin"), null);

    const stranger = new SignInClient(`${url}/app-signin`, { authorization: "Bearer wrong" });
    assert.equal(await stranger.service(), undefined);
    await assert.rejects(stranger.start(KEY), /members only/);
    const member = new SignInClient(`${url}/app-signin`, { authorization: "Bearer member-token", origin: pages });
    assert.deepEqual(await member.service(), { configured: true, fid: 777, sponsored: false });
    const r = await member.start(KEY);
    assert.match(r.deeplinkUrl, /^farcaster:\/\//);
    assert.deepEqual(await member.state(r.token), { state: "pending" });
    assert.equal((await fetch(`${url}/v1/info`, { headers: { authorization: "Bearer member-token" } })).status, 404);
  } finally {
    server.close();
    fc.close();
  }
});
