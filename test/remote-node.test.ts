import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { checkNodeFor, DEFAULT_CHECK_NODE, OTHER_PUBLIC_NODE, secondNode, SecondNode } from "../src/core/index.js";

test("the second node is never the node being read", () => {
  assert.equal(checkNodeFor("http://127.0.0.1:13381"), DEFAULT_CHECK_NODE);
  assert.equal(checkNodeFor("https://snap.farcaster.xyz:3381/"), OTHER_PUBLIC_NODE);
  // ./outpost client forwards /v1/* to the node and /outpost/check/v1/* to the second node.
  assert.ok(secondNode("http://127.0.0.1:8381/outpost/check", "http://127.0.0.1:8381") instanceof SecondNode);
  assert.equal(secondNode("http://127.0.0.1:8381/", "http://127.0.0.1:8381"), undefined);
});

// A stand-in for a node, a second node or an RPC: answers with its name, the method and the path.
async function upstream(name: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name, method: req.method, path: req.url, body })));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

async function client(env: Record<string, string>): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/serve.ts"], { env: { ...process.env, ...env, OUTPOST_PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((ok, fail) => {
    child.stdout.on("data", (d: Buffer) => d.toString().includes("client:") && ok());
    child.on("exit", (code) => fail(new Error(`serve.ts exited with ${code}`)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

test("./outpost client --public: the page learns the node is not yours, and key checks go through this server", async () => {
  const node = await upstream("node");
  const check = await upstream("check");
  const rpc = await upstream("rpc");
  const c = await client({ OUTPOST_NODE_URL: node.url, OUTPOST_NODE_REMOTE: "1", OUTPOST_CHECK_NODE: check.url, OUTPOST_OPTIMISM_RPC: rpc.url });
  try {
    const cfg = await (await fetch(`${c.url}/outpost-config.json`)).json();
    assert.deepEqual(cfg, { network: "mainnet", node: { url: node.url, farcaster: false, check: check.url, rpc: `${rpc.url}/` } });
    assert.deepEqual(await (await fetch(`${c.url}/v1/info?x=1`)).json(), { name: "node", method: "GET", path: "/v1/info?x=1", body: "" });
    assert.deepEqual(await (await fetch(`${c.url}/outpost/check/v1/signersByFid?fid=3`)).json(), { name: "check", method: "GET", path: "/v1/signersByFid?fid=3", body: "" });
    const read = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] });
    const call = await fetch(`${c.url}/outpost/optimism`, { method: "POST", headers: { "content-type": "application/json" }, body: read });
    assert.deepEqual(await call.json(), { name: "rpc", method: "POST", path: "/", body: read });
    // Optimism is only read: a transaction is not forwarded.
    const send = JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x00"] }]);
    assert.equal((await fetch(`${c.url}/outpost/optimism`, { method: "POST", body: send })).status, 403);
    assert.equal((await fetch(`${c.url}/outpost/optimism`, { method: "POST", body: "{}" })).status, 403);
    // The second node is only read, and nothing else leaves through these paths.
    assert.notEqual((await fetch(`${c.url}/outpost/check/v1/submitMessage`, { method: "POST", body: "x" })).status, 200);
    assert.notEqual((await fetch(`${c.url}/outpost/check/other`)).status, 200);
  } finally {
    c.stop();
    for (const s of [node, check, rpc]) s.server.close();
  }
});

test("./outpost client through the tunnel: no remote node, no forwarded checks", async () => {
  const node = await upstream("node");
  const c = await client({ OUTPOST_NODE_URL: node.url, OUTPOST_NODE_REMOTE: "" });
  try {
    assert.deepEqual(await (await fetch(`${c.url}/outpost-config.json`)).json(), { network: "mainnet" });
    assert.equal((await fetch(`${c.url}/outpost/check/v1/info`)).status, 404);
    assert.equal((await fetch(`${c.url}/outpost/optimism`, { method: "POST", body: "{}" })).status, 405);
  } finally {
    c.stop();
    node.server.close();
  }
});
