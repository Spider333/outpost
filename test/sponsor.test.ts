// The sponsor's rules (src/server/sponsor-service.ts) over real HTTP, with a fake chain: who may
// ask, what is checked before money moves, the caps, and what is counted. Plus the fast
// "no account" answer in resolveAccount.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRegisterRequest, type RegisterRequest } from "../src/core/sponsor.js";
import { fileCounts, sponsor, GAS_RESERVE, type Counts, type SponsorChain } from "../src/server/sponsor-service.js";
import { resolveAccount } from "../src/core/account.js";
import { Hub, HubError, type HexString } from "../src/core/hub.js";

const APP = "https://spider333.github.io";
const ALICE = randomBytes(32).toString("hex");
const BOB = randomBytes(32).toString("hex");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const PRICE = 84_000_000_000_000n; // ~$0.20
const VALUE = (PRICE * 105n) / 100n;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as HexString;
const SIG = `0x${"ab".repeat(65)}` as HexString;
const body = (to: HexString, deadline = Math.floor(NOW / 1000) + 3600): RegisterRequest => ({ to, recovery: addr(0), deadline: String(deadline), signature: SIG });

class FakeChain implements SponsorChain {
  address = addr(999);
  owners = new Map<string, number>();
  nextFid = 4_000_000;
  wallet = VALUE * 10n + GAS_RESERVE;
  sent: Array<{ r: RegisterRequest; value: bigint }> = [];
  reject?: string;
  async idOf(a: HexString) {
    return this.owners.get(a.toLowerCase()) ?? 0;
  }
  async price() {
    return PRICE;
  }
  async balance() {
    return this.wallet;
  }
  async simulate() {
    if (this.reject) throw new Error(this.reject);
  }
  async send(r: RegisterRequest, value: bigint) {
    await new Promise((res) => setTimeout(res, 20)); // a block's worth of waiting, so requests overlap
    this.sent.push({ r, value });
    this.wallet -= PRICE;
    this.owners.set(r.to.toLowerCase(), this.nextFid++);
    return `0x${"12".repeat(32)}` as HexString;
  }
}

async function start(opts: { perMember?: number; perDay?: number; dryRun?: boolean } = {}) {
  const chain = new FakeChain();
  let counts: Counts = { day: "", today: 0, members: {} };
  const s = sponsor({
    chain,
    members: () => new Map([[sha(ALICE), "alice"], [sha(BOB), "bob"]]),
    counts: { load: () => structuredClone(counts), save: (c) => (counts = structuredClone(c)) },
    perMember: opts.perMember ?? 2,
    perDay: opts.perDay ?? 20,
    dryRun: opts.dryRun,
    now: () => NOW,
  });
  const server = createServer(s.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const port = (server.address() as { port: number }).port;
  return { chain, port, counts: () => counts, report: s.report };
}

type Res = { status: number; headers: IncomingHttpHeaders; json: Record<string, unknown> };
function call(port: number, method: string, path: string, token?: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    const data = payload === undefined ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload);
    if (data) h["content-type"] = "application/json";
    const r = request({ host: "127.0.0.1", port, method, path, headers: h, agent: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, json: b ? (JSON.parse(b) as Record<string, unknown>) : {} }));
    });
    r.on("error", reject);
    r.end(data);
  });
}

test("no token or an unknown token gets 401 and nothing else", async () => {
  const { port, chain } = await start();
  assert.equal((await call(port, "GET", "/sponsor/status")).status, 401);
  assert.equal((await call(port, "POST", "/sponsor/register", randomBytes(32).toString("hex"), body(addr(1)))).status, 401);
  assert.equal(chain.sent.length, 0);
});

test("status says how many accounts this member can get, and why not when none", async () => {
  const { port, chain } = await start({ perMember: 2 });
  const ok = await call(port, "GET", "/sponsor/status", ALICE);
  assert.deepEqual(ok.json, { available: true, left: 2 });
  chain.wallet = GAS_RESERVE;
  const empty = await call(port, "GET", "/sponsor/status", ALICE);
  assert.equal(empty.json.available, false);
  assert.match(String(empty.json.reason), /wallet is empty/);
});

test("a malformed request is refused before the chain is asked", async () => {
  const { port, chain } = await start();
  for (const [payload, why] of [
    ["not json", /not JSON/],
    [{ ...body(addr(1)), to: "0x123" }, /to must be an address/],
    [body(addr(1), Math.floor(NOW / 1000) + 7200), /deadline/],
    [{ ...body(addr(1)), signature: "0x00" }, /signature/],
  ] as const) {
    const r = await call(port, "POST", "/sponsor/register", ALICE, payload);
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), why);
  }
  assert.equal(chain.sent.length, 0);
});

test("a signature IdGateway would reject costs nothing: simulated, never sent", async () => {
  const { port, chain, counts } = await start();
  chain.reject = "InvalidSignature()";
  const r = await call(port, "POST", "/sponsor/register", ALICE, body(addr(1)));
  assert.equal(r.status, 400);
  assert.match(String(r.json.error), /Optimism would reject this registration: InvalidSignature/);
  assert.equal(chain.sent.length, 0);
  assert.equal(counts().today, 0);
});

test("an address that already owns an FID is told so, and nothing is paid", async () => {
  const { port, chain } = await start();
  chain.owners.set(addr(7).toLowerCase(), 123);
  const r = await call(port, "POST", "/sponsor/register", ALICE, body(addr(7)));
  assert.equal(r.status, 409);
  assert.equal(r.json.fid, 123);
  assert.equal(chain.sent.length, 0);
});

test("a good request is paid with the fee plus 5%, and counted by member name only", async () => {
  const { port, chain, counts, report } = await start();
  const r = await call(port, "POST", "/sponsor/register", ALICE, body(addr(1)), { origin: APP });
  assert.equal(r.status, 200);
  assert.equal(r.json.fid, 4_000_000);
  assert.equal(r.headers["access-control-allow-origin"], APP);
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.sent[0]!.value, VALUE);
  assert.deepEqual(counts(), { day: "2026-10-23", today: 1, members: { alice: 1 } });
  assert.doesNotMatch(JSON.stringify(counts()), /0x/); // no address or hash is kept
  assert.deepEqual(report(), { lastHour: 1, today: 1 });
});

test("caps: per member, ever, and per day for everyone; simultaneous requests cannot slip past", async () => {
  const { port, chain } = await start({ perMember: 1, perDay: 2 });
  const [a, b] = await Promise.all([
    call(port, "POST", "/sponsor/register", ALICE, body(addr(1))),
    call(port, "POST", "/sponsor/register", ALICE, body(addr(2))),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  assert.equal((await call(port, "POST", "/sponsor/register", BOB, body(addr(3)))).status, 200);
  const day = await call(port, "POST", "/sponsor/register", BOB, body(addr(4)));
  assert.equal(day.status, 429);
  assert.equal(chain.sent.length, 2);
  assert.equal((await call(port, "GET", "/sponsor/status", ALICE)).json.available, false);
});

test("an empty wallet answers 503 and sends nothing", async () => {
  const { port, chain } = await start();
  chain.wallet = VALUE; // not enough once gas is kept aside
  const r = await call(port, "POST", "/sponsor/register", ALICE, body(addr(1)));
  assert.equal(r.status, 503);
  assert.equal(chain.sent.length, 0);
});

test("a dry run checks the registration but neither sends nor counts it", async () => {
  const { port, chain, counts } = await start({ dryRun: true });
  chain.wallet = 0n; // an unfunded test wallet still lets the client reach the create step
  assert.deepEqual((await call(port, "GET", "/sponsor/status", ALICE)).json, { available: true, left: 2 });
  const r = await call(port, "POST", "/sponsor/register", ALICE, body(addr(1)));
  assert.equal(r.status, 200);
  assert.equal(r.json.dryRun, true);
  assert.equal(chain.sent.length, 0);
  assert.equal(counts().today, 0);
});

test("a damaged counts file stops the sponsor instead of resetting the caps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sponsor-"));
  const path = join(dir, "counts.json");
  try {
    assert.deepEqual(fileCounts(path).load(), { day: "", today: 0, members: {} }); // missing: nothing counted yet
    fileCounts(path).save({ day: "2026-10-23", today: 1, members: { alice: 1 } });
    assert.equal(fileCounts(path).load().members.alice, 1);
    for (const bad of ["{not json", "[]", '{"day":"x"}']) {
      writeFileSync(path, bad);
      assert.throws(() => fileCounts(path).load());
    }
    // Over HTTP: refused, and nothing is sent.
    const chain = new FakeChain();
    const s = sponsor({ chain, members: () => new Map([[sha(ALICE), "alice"]]), counts: fileCounts(path), perMember: 2, perDay: 20, now: () => NOW });
    const server = createServer(s.handle);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    assert.equal((await call(port, "GET", "/sponsor/status", ALICE)).status, 502);
    assert.equal((await call(port, "POST", "/sponsor/register", ALICE, body(addr(1)))).status, 502);
    assert.equal(chain.sent.length, 0);
    server.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("CORS: preflight for the client's origin only; other paths are 404", async () => {
  const { port } = await start();
  const pre = await call(port, "OPTIONS", "/sponsor/register", undefined, undefined, { origin: APP });
  assert.equal(pre.status, 204);
  assert.match(String(pre.headers["access-control-allow-headers"]), /Authorization/);
  const other = await call(port, "OPTIONS", "/sponsor/register", undefined, undefined, { origin: "https://evil.example" });
  assert.equal(other.headers["access-control-allow-origin"], undefined);
  assert.equal((await call(port, "GET", "/v1/info", ALICE)).status, 404);
});

test("parseRegisterRequest keeps the deadline within an hour", () => {
  const now = Math.floor(NOW / 1000);
  assert.equal(parseRegisterRequest(body(addr(1), now + 3600), now).deadline, String(now + 3600));
  assert.throws(() => parseRegisterRequest(body(addr(1), now + 10), now), /deadline/);
  assert.throws(() => parseRegisterRequest([], now), /JSON object/);
});

// ---- resolveAccount: the quick "no account" answer

const fakeHub = (h: Partial<Record<"fidByCustody" | "custodyOf" | "storageLimits", (...a: never[]) => Promise<unknown>>>) => h as unknown as Hub;

test("resolveAccount: with Optimism, an address without an FID fails at once, without asking the node", async () => {
  let asked = false;
  const hub = fakeHub({ fidByCustody: async () => ((asked = true), 1) });
  await assert.rejects(resolveAccount(hub, addr(5), { idOf: async () => 0 }), /No Farcaster account belongs to 0x0+5\. Check the phrase or wallet\./);
  assert.equal(asked, false);
});

test("resolveAccount: a new FID the node has not seen yet says so", async () => {
  const hub = fakeHub({ custodyOf: async () => undefined });
  await assert.rejects(resolveAccount(hub, addr(5), { idOf: async () => 42 }), /owns FID 42, but your node has not seen that account yet/);
});

test("resolveAccount: without Optimism, a node that times out gets a clear message, not 'cannot reach node'", async () => {
  const hub = fakeHub({ fidByCustody: async () => Promise.reject(new HubError("cannot reach node at https://x", 0, "aborted")) });
  await assert.rejects(resolveAccount(hub, addr(5)), /Could not tell whether 0x0+5 owns a Farcaster account/);
});

test("resolveAccount: an existing account still resolves through the node", async () => {
  const hub = fakeHub({ custodyOf: async () => addr(5), storageLimits: async () => ({ units: 1 }) });
  assert.deepEqual(await resolveAccount(hub, addr(5), { idOf: async () => 42 }), { fid: 42, custody: addr(5), storageUnits: 1 });
});
