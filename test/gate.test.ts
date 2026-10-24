// Runs src/server/gate.ts as its own process in front of a fake node and checks every rule it
// enforces from the outside: status codes, CORS headers, what reaches the node, what is logged.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("../src/server/gate.ts", import.meta.url));
const APP = "https://spider333.github.io";
const ALICE = randomBytes(32).toString("hex");
const BOB = randomBytes(32).toString("hex");
const line = (name: string, token: string) => `${name} ${createHash("sha256").update(token).digest("hex")}\n`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// Fake node: records what reaches it and answers 200 with a header the gate must not pass on.
type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: Buffer };
const seen: Seen[] = [];
const node = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/json", "x-node-internal": "1" }).end('{"ok":true}');
  });
});
await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
const nodePort = (node.address() as { port: number }).port;
after(() => node.close());

async function until<T>(f: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const v = f();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function startGate(members: string | undefined, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const file = join(dir, "members");
  if (members !== undefined) writeFileSync(file, members, { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx", GATE], {
    env: { ...process.env, OUTPOST_GATE_MEMBERS: file, OUTPOST_GATE_PORT: "0", OUTPOST_GATE_UPSTREAM: `http://127.0.0.1:${nodePort}`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<void>((r) => child.on("exit", () => r()));
  const port = Number(await until(() => /127\.0\.0\.1:(\d+) ->/.exec(out)?.[1], "the gate to listen"));
  return {
    port,
    file,
    output: () => out,
    // Sends SIGHUP and waits for the gate to report the new member count.
    reload: async (count: number) => {
      const before = out.length;
      child.kill("SIGHUP");
      await until(() => (out.slice(before).includes(`members: ${count}`) ? true : undefined), "the reload");
    },
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
      rmSync(dir, { recursive: true });
      return out;
    },
  };
}

type Res = { status: number; headers: IncomingHttpHeaders; body: string };
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

test("a CORS preflight gets 204 without a token; allowed origins only get CORS headers", async () => {
  const g = await startGate(line("alice", ALICE));
  seen.length = 0;
  for (const origin of [APP, "http://127.0.0.1:8381", "http://localhost:8381"]) {
    const r = await call(g.port, "OPTIONS", "/v1/castsByFid?fid=1", { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" });
    assert.equal(r.status, 204);
    assert.equal(r.headers["access-control-allow-origin"], origin);
    assert.equal(r.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
    assert.equal(r.headers["access-control-allow-headers"], "Authorization, Content-Type");
  }
  const other = await call(g.port, "OPTIONS", "/v1/info", { origin: "https://evil.example" });
  assert.equal(other.status, 204);
  assert.equal(other.headers["access-control-allow-origin"], undefined);
  assert.equal(other.headers["access-control-allow-methods"], undefined);
  // A real request from an allowed origin carries CORS headers too, Retry-After readable.
  const ok = await call(g.port, "GET", "/v1/info", { origin: APP, ...bearer(ALICE) });
  assert.equal(ok.headers["access-control-allow-origin"], APP);
  assert.equal(ok.headers["access-control-expose-headers"], "Retry-After");
  const evil = await call(g.port, "GET", "/v1/info", { origin: "https://evil.example", ...bearer(ALICE) });
  assert.equal(evil.headers["access-control-allow-origin"], undefined);
  assert.equal(seen.length, 2, "preflights never reach the node");
  await g.stop();
});

test("a missing, malformed or unknown token gets 401 and reaches nothing", async () => {
  const g = await startGate(line("alice", ALICE));
  seen.length = 0;
  for (const headers of [{}, { authorization: ALICE }, { authorization: `Basic ${ALICE}` }, bearer(BOB), bearer(`${ALICE} x`)]) {
    const r = await call(g.port, "GET", "/v1/info", { origin: APP, ...headers });
    assert.equal(r.status, 401);
    // The browser client can see it is a 401, not a network error.
    assert.equal(r.headers["access-control-allow-origin"], APP);
  }
  // Also before the allowlist: no token on a forbidden path is 401, not 403.
  assert.equal((await call(g.port, "DELETE", "/admin")).status, 401);
  assert.equal(seen.length, 0);
  await g.stop();

  // No members file: fails closed.
  const none = await startGate(undefined);
  assert.equal((await call(none.port, "GET", "/v1/info", bearer(ALICE))).status, 401);
  assert.match(await none.stop(), /members: 0/);
});

test("only GET /v1/* and POST /v1/submitMessage are allowed; everything else is 403", async () => {
  const g = await startGate(line("alice", ALICE));
  seen.length = 0;
  const denied: [string, string][] = [
    ["POST", "/v1/validateMessage"],
    ["POST", "/v1/submitMessage/x"],
    ["PUT", "/v1/submitMessage"],
    ["DELETE", "/v1/info"],
    ["HEAD", "/v1/info"],
    ["PATCH", "/v1/info"],
    ["GET", "/"],
    ["GET", "/index.html"],
    ["GET", "/v2/info"],
    ["GET", "/v1"],
    ["GET", "/v1/../admin"],
    ["GET", "/v1/%2e%2e/admin"],
    ["GET", "//evil.example/v1/info"],
    ["POST", "/v1/../v1/validateMessage"],
  ];
  for (const [method, path] of denied) {
    const r = await call(g.port, method, path, bearer(ALICE));
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  assert.equal(seen.length, 0, "nothing denied reaches the node");
  await g.stop();
});

test("forwards reads and submits to the node without the member's headers", async () => {
  const g = await startGate(line("alice", ALICE));
  seen.length = 0;
  const read = await call(g.port, "GET", "/v1/castsByFid?fid=3&pageSize=10", { origin: APP, cookie: "c=1", "x-forwarded-for": "198.51.100.1", ...bearer(ALICE) });
  assert.equal(read.status, 200);
  assert.equal(read.body, '{"ok":true}');
  assert.equal(read.headers["content-type"], "application/json");
  assert.equal(read.headers["x-node-internal"], undefined, "node headers are not passed back");
  const msg = randomBytes(300);
  const sub = await call(g.port, "POST", "/v1/submitMessage", { "content-type": "application/octet-stream", ...bearer(ALICE) }, msg);
  assert.equal(sub.status, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.method, "GET");
  assert.equal(seen[0]!.url, "/v1/castsByFid?fid=3&pageSize=10");
  assert.equal(seen[1]!.method, "POST");
  assert.equal(seen[1]!.url, "/v1/submitMessage");
  assert.deepEqual(seen[1]!.body, msg);
  assert.equal(seen[1]!.headers["content-type"], "application/octet-stream");
  for (const s of seen) {
    for (const h of ["authorization", "cookie", "origin", "x-forwarded-for"]) assert.equal(s.headers[h], undefined, `${h} passed to the node`);
  }
  // Society votes read the likes on a proposal: a plain GET, so no gate change is needed.
  const likes = "/v1/reactionsByCast?target_fid=3&target_hash=0x50184b62b4c52fd76628713562e1eda3dccaf63d&reaction_type=Like&pageSize=1000";
  assert.equal((await call(g.port, "GET", likes, bearer(ALICE))).status, 200);
  assert.equal(seen[2]!.url, likes);
  await g.stop();
});

test("each member has their own rate limit: 429 with Retry-After", async () => {
  const g = await startGate(line("alice", ALICE) + line("bob", BOB), {
    OUTPOST_GATE_READ_RATE: "1",
    OUTPOST_GATE_READ_BURST: "2",
    OUTPOST_GATE_SUBMIT_RATE: "0.5",
    OUTPOST_GATE_SUBMIT_BURST: "1",
  });
  seen.length = 0;
  const get = (t: string) => call(g.port, "GET", "/v1/info", { origin: APP, ...bearer(t) });
  const post = (t: string) => call(g.port, "POST", "/v1/submitMessage", bearer(t), Buffer.from("x"));
  assert.equal((await get(ALICE)).status, 200);
  assert.equal((await get(ALICE)).status, 200);
  const limited = await get(ALICE);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "1");
  assert.equal(limited.headers["access-control-allow-origin"], APP);
  assert.equal((await get(BOB)).status, 200, "another member is not limited");
  assert.equal((await post(ALICE)).status, 200, "submits have their own bucket");
  const slow = await post(ALICE);
  assert.equal(slow.status, 429);
  assert.equal(slow.headers["retry-after"], "2");
  assert.equal(seen.length, 4, "limited requests do not reach the node");
  await g.stop();
});

test("request bodies over 64 KiB get 413 and never reach the node", async () => {
  const g = await startGate(line("alice", ALICE));
  seen.length = 0;
  const big = Buffer.alloc(64 * 1024 + 1);
  const r = await call(g.port, "POST", "/v1/submitMessage", bearer(ALICE), big);
  assert.equal(r.status, 413);
  // Without a content-length the gate counts bytes as they arrive.
  const chunked = await call(g.port, "POST", "/v1/submitMessage", { "transfer-encoding": "chunked", ...bearer(ALICE) }, Buffer.alloc(200 * 1024)).catch(
    (e: NodeJS.ErrnoException) => ({ status: e.code ?? "error" }),
  );
  assert.ok(chunked.status === 413 || chunked.status === "ECONNRESET" || chunked.status === "EPIPE", `got ${chunked.status}`);
  assert.equal((await call(g.port, "POST", "/v1/submitMessage", bearer(ALICE), Buffer.alloc(64 * 1024))).status, 200, "64 KiB is allowed");
  assert.equal(seen.length, 1);
  await g.stop();
});

test("reloads the members file on SIGHUP: a removed member gets 401, a new one gets in", async () => {
  const g = await startGate(line("alice", ALICE) + line("bob", BOB));
  assert.equal((await call(g.port, "GET", "/v1/info", bearer(BOB))).status, 200);
  const carol = randomBytes(32).toString("hex");
  // Replaced the way infra/society.sh does it: a new file moved over the old one.
  writeFileSync(`${g.file}.tmp`, line("alice", ALICE) + line("carol", carol));
  renameSync(`${g.file}.tmp`, g.file);
  await g.reload(2);
  assert.equal((await call(g.port, "GET", "/v1/info", bearer(BOB))).status, 401);
  assert.equal((await call(g.port, "GET", "/v1/info", bearer(ALICE))).status, 200);
  assert.equal((await call(g.port, "GET", "/v1/info", bearer(carol))).status, 200);
  await g.stop();
});

test("logs only counts per member: no token, path, query, body or address", async () => {
  const g = await startGate(line("alice", ALICE));
  await call(g.port, "GET", "/v1/castById?fid=7654321&hash=0xfeedfacecafe", { origin: APP, "user-agent": "agent-marker", "x-forwarded-for": "198.51.100.77", ...bearer(ALICE) });
  await call(g.port, "POST", "/v1/submitMessage", bearer(ALICE), Buffer.from("body-marker"));
  await call(g.port, "GET", "/v1/secretPathMarker", bearer(ALICE));
  await call(g.port, "GET", "/admin-marker", bearer(ALICE));
  await call(g.port, "GET", "/v1/info", bearer(BOB));
  const out = await g.stop();
  for (const secret of [ALICE, BOB, "castById", "7654321", "feedface", "secretPathMarker", "admin-marker", "body-marker", "agent-marker", "198.51.100.77", "/v1/"]) {
    assert.ok(!out.includes(secret), `log contains ${secret}:\n${out}`);
  }
  assert.match(out, /Z alice: 2 reads, 1 submits, 1 refused, 0 rate-limited\n/);
  assert.match(out, /Z no or unknown token: 1\n/);
  // Nothing else: the start-up lines and the counts.
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 4, out);
});

test("the gate imports nothing but Node itself, so it runs without a build or npm install", () => {
  const src = readFileSync(GATE, "utf8");
  const imports = [...src.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const i of imports) assert.match(i!, /^node:/);
  assert.doesNotMatch(src, /\b(require|import)\s*\(/);
});
