import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CastType, FarcasterNetwork, makeCastAdd, NobleEd25519Signer } from "@farcaster/core";
import { bytesToHex } from "viem";

const run = promisify(execFile);
const FID = 4242;

// A node serving one cast signed with a key it calls gasless. The second node is a closed port.
async function fakeNode(text = "cast whose key nobody can check"): Promise<{ url: string; server: Server }> {
  const signer = new NobleEd25519Signer(crypto.getRandomValues(new Uint8Array(32)));
  const key = bytesToHex((await signer.getSignerKey())._unsafeUnwrap());
  const ts = Math.floor((Date.now() - 1609459200000) / 1000) - 60;
  const m = (await makeCastAdd({ text, type: CastType.CAST, embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [] }, { fid: FID, network: FarcasterNetwork.MAINNET, timestamp: ts }, signer))._unsafeUnwrap();
  const cast = {
    data: { type: "MESSAGE_TYPE_CAST_ADD", fid: FID, timestamp: ts, network: "FARCASTER_NETWORK_MAINNET", castAddBody: { embedsDeprecated: [], mentions: [], parentCastId: null, parentUrl: null, text, embeds: [], mentionsPositions: [], type: "CAST" } },
    hash: bytesToHex(m.hash),
    hashScheme: "HASH_SCHEME_BLAKE3",
    signature: Buffer.from(m.signature).toString("base64"),
    signatureScheme: "SIGNATURE_SCHEME_ED25519",
    signer: bytesToHex(m.signer),
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body =
      path === "/v1/castsByFid" ? { messages: [cast] }
      : path === "/v1/linksByFid" || path === "/v1/userDataByFid" ? { messages: [] }
      : path === "/v1/signersByFid" ? { signers: [{ source: "SIGNER_SOURCE_OFFCHAIN", key, keyType: 1, fid: FID, requestFid: FID }], gaslessSignerCount: 1, gaslessSignerLimit: 1000, currentUserNonce: 0 }
      : undefined;
    res.writeHead(body ? 200 : 400, { "content-type": "application/json" }).end(JSON.stringify(body ?? { error: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

test("CLI: a cast whose key cannot be checked is hidden by default; --show-unverified shows it marked", async () => {
  const { url, server } = await fakeNode();
  try {
    const env = { ...process.env, OUTPOST_HOME: mkdtempSync(join(tmpdir(), "outpost-cli-test-")) };
    const args = ["--import", "tsx", "src/cli/main.ts", "feed", "--fid", String(FID), "--node", url, "--rpc", "off", "--check-node", "http://127.0.0.1:1"];
    const hidden = (await run(process.execPath, args, { env })).stdout;
    assert.doesNotMatch(hidden, /cast whose key nobody can check/);
    assert.match(hidden, /1 messages were hidden because their signing key could not be checked/);
    assert.match(hidden, /--show-unverified/);
    assert.doesNotMatch(hidden, /passed verification/);

    const shown = (await run(process.execPath, [...args, "--show-unverified"], { env })).stdout;
    assert.match(shown, /cast whose key nobody can check/);
    assert.match(shown, /\[signer not verified\]/);
    assert.match(shown, /shown although their signing key could not be checked/);
  } finally {
    server.close();
  }
});

test("CLI: control characters in a cast never reach the terminal", async () => {
  // Cursor up and erase the line, an OSC 52 clipboard write ended by BEL, and a one-byte C1 CSI.
  const { url, server } = await fakeNode("hello\x1b[1A\x1b[2Kfake line\x1b]52;c;ZWNobyBwd25lZA==\x07 world \u009b31m café ✓");
  try {
    const env = { ...process.env, OUTPOST_HOME: mkdtempSync(join(tmpdir(), "outpost-cli-test-")) };
    const args = ["--import", "tsx", "src/cli/main.ts", "feed", "--fid", String(FID), "--node", url, "--rpc", "off", "--check-node", "http://127.0.0.1:1", "--show-unverified"];
    const out = (await run(process.execPath, args, { env })).stdout;
    assert.doesNotMatch(out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    assert.ok(out.includes("hello[1A[2Kfake line]52;c;ZWNobyBwd25lZA== world 31m café ✓"), out);
  } finally {
    server.close();
  }
});

// A node for `uninstall`: it reports its sync state, answers the signer lookup as `signer` says
// ("listed" turns into "not found" once a KEY_REMOVE arrives) and records every submit.
async function uninstallNode(opts: { synced: boolean; signer: "listed" | "notfound" }) {
  const submits: number[] = [];
  let listed = opts.signer === "listed";
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    req.resume();
    req.on("end", () => {
      if (path === "/v1/submitMessage") {
        submits.push(Date.now());
        listed = false;
      }
      const body =
        path === "/v1/info" ? { version: "0.14.3", numShards: 2, shardInfos: [0, 1].map((shardId) => ({ shardId, maxHeight: 1000, numMessages: 1, blockDelay: opts.synced ? 0 : 250000 })) }
        : path === "/v1/signer" && listed ? { signer: { fid: FID, key: "listed", requestFid: FID } }
        : path === "/v1/signersByFid" ? { signers: [], currentUserNonce: 0, requesterFidNonces: { [String(FID)]: 0 } }
        : path === "/v1/submitMessage" ? {}
        : undefined;
      res.writeHead(body ? 200 : 400, { "content-type": "application/json" }).end(JSON.stringify(body ?? { error: "signer not found" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, submits };
}

async function savedKey(): Promise<{ home: string; file: string }> {
  const home = mkdtempSync(join(tmpdir(), "outpost-cli-test-"));
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = bytesToHex((await new NobleEd25519Signer(privateKey).getSignerKey())._unsafeUnwrap());
  const file = join(home, "appkey.json");
  writeFileSync(file, JSON.stringify({ fid: FID, privateKey: bytesToHex(privateKey), publicKey, requestFid: FID, scopes: [], ttl: 2592000, network: FarcasterNetwork.MAINNET }));
  return { home, file };
}

function uninstall(url: string, home: string) {
  return run(process.execPath, ["--import", "tsx", "src/cli/main.ts", "uninstall", "--node", url, "--rpc", "off", "--check-node", "off"], { env: { ...process.env, OUTPOST_HOME: home } });
}

test("CLI uninstall: a key the node does not list is kept, not deleted", async () => {
  const node = await uninstallNode({ synced: true, signer: "notfound" });
  try {
    const { home, file } = await savedKey();
    const out = (await uninstall(node.url, home)).stdout;
    assert.match(out, /does not list this key/);
    assert.ok(existsSync(file), "the key file must stay so the key can still revoke itself");
    assert.equal(node.submits.length, 0);
  } finally {
    node.server.close();
  }
});

test("CLI uninstall: a node that is still syncing is refused, and the key is kept", async () => {
  const node = await uninstallNode({ synced: false, signer: "notfound" });
  try {
    const { home, file } = await savedKey();
    await assert.rejects(uninstall(node.url, home), (e: { stderr: string }) => /still syncing/.test(e.stderr));
    assert.ok(existsSync(file));
    assert.equal(node.submits.length, 0);
  } finally {
    node.server.close();
  }
});

test("CLI uninstall: a listed key is revoked with the key itself, then deleted", async () => {
  const node = await uninstallNode({ synced: true, signer: "listed" });
  try {
    const { home, file } = await savedKey();
    const out = (await uninstall(node.url, home)).stdout;
    assert.match(out, /revoked app key/);
    assert.equal(node.submits.length, 1);
    assert.ok(!existsSync(file));
  } finally {
    node.server.close();
  }
});
