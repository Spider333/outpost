import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CastType, FarcasterNetwork, makeCastAdd, NobleEd25519Signer } from "@farcaster/core";
import { bytesToHex } from "viem";

const run = promisify(execFile);
const FID = 4242;

// A node serving one cast signed with a key it calls gasless. The second node is a closed port.
async function fakeNode(): Promise<{ url: string; server: Server }> {
  const signer = new NobleEd25519Signer(crypto.getRandomValues(new Uint8Array(32)));
  const key = bytesToHex((await signer.getSignerKey())._unsafeUnwrap());
  const text = "cast whose key nobody can check";
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
