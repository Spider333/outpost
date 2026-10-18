// Builds and signs the two example charters in examples/ from live node data.
//   npx tsx scripts/example-charters.ts            (needs OUTPOST_NODE_URL and an example key)
// The example key is a throwaway signing key kept outside the repo
// (~/.config/outpost/example-charter.key). The examples name no issuer FID, because no real
// society signed them; the charter says so in its description.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FARCASTER_EPOCH_MS, Hub, notFuture, signCharter, verifyCharter, type CharterBody, type HexString } from "../src/core/index.js";

const hub = new Hub({ url: process.env.OUTPOST_NODE_URL ?? "http://127.0.0.1:3381" });
const keyFile = join(homedir(), ".config/outpost/example-charter.key");

function exampleKey() {
  if (!existsSync(keyFile)) {
    mkdirSync(join(homedir(), ".config/outpost"), { recursive: true, mode: 0o700 });
    writeFileSync(keyFile, generatePrivateKey() + "\n", { mode: 0o600 });
  }
  return privateKeyToAccount(readFileSync(keyFile, "utf8").trim() as HexString);
}

// Channel casts carry the channel's parent URL. Early channels used a custom URL:
// /network-states is https://thenetworkstate.com. Newer ones use the warpcast.com form.
const CHANNEL_CANDIDATES = [
  "https://thenetworkstate.com",
  "https://warpcast.com/~/channel/network-states",
  "https://farcaster.xyz/~/channel/network-states",
];

async function channelPosters(days: number, top: number): Promise<{ url: string; members: number[]; casts: number }> {
  const cutoff = Math.floor((Date.now() - days * 86_400_000 - FARCASTER_EPOCH_MS) / 1000);
  for (const url of CHANNEL_CANDIDATES) {
    const counts = new Map<number, number>();
    let casts = 0;
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await hub.castsByParentUrl(url, { reverse: true, pageSize: 1000, pageToken });
      for (const m of res.items) {
        if (m.data.timestamp < cutoff || !notFuture(m)) continue;
        casts++;
        counts.set(m.data.fid, (counts.get(m.data.fid) ?? 0) + 1);
      }
      // A page holds one newest-first run per shard, so stop only when the whole page is old.
      const newest = Math.max(...res.items.map((m) => m.data.timestamp));
      if (!res.nextPageToken || !res.items.length || newest < cutoff) break;
      pageToken = res.nextPageToken;
    }
    console.log(`${url}: ${casts} casts from ${counts.size} accounts in the last ${days} days`);
    if (casts > 0) {
      const members = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, top).map(([fid]) => fid);
      return { url, members: members.sort((a, b) => a - b), casts };
    }
  }
  throw new Error("no casts found under any /network-states channel URL");
}

async function main() {
  const signer = exampleKey();
  mkdirSync("examples", { recursive: true });
  const now = new Date().toISOString();

  const days = Number(process.env.EXAMPLE_DAYS ?? 90);
  const ch = await channelPosters(days, 100);
  const networkStates: CharterBody = {
    charter: 1,
    name: "network-states channel (example)",
    description: `Unofficial example built by Outpost from public data: the ${ch.members.length} accounts that posted most in /network-states in the ${days} days before ${now.slice(0, 10)}. Not signed by the channel's moderators.`,
    members: ch.members,
    moderators: [],
    feed: { channels: [ch.url] },
    issuedAt: now,
  };

  const testMembers = (process.env.TEST_SOCIETY_MEMBERS ?? "").split(",").map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  const testSociety: CharterBody = {
    charter: 1,
    name: "Outpost test society",
    description: "The society people join while testing Outpost. Members are the testers who vouched for it.",
    codeOfConduct: "https://github.com/Spider333/outpost/blob/main/examples/test-society-conduct.md",
    members: testMembers,
    moderators: testMembers.slice(0, 1),
    clients: { exclude: [] },
    feed: { excludeKeywords: ["airdrop"] },
    issuedAt: now,
  };

  for (const [file, body] of [
    ["examples/network-states.charter.json", networkStates],
    ["examples/test-society.charter.json", testSociety],
  ] as const) {
    const signed = await signCharter(body, signer);
    const v = await verifyCharter(signed, hub);
    if (!v.ok) throw new Error(`${file}: ${v.problems.join("; ")}`);
    writeFileSync(file, JSON.stringify(signed, null, 2) + "\n");
    console.log(`wrote ${file}: ${body.members.length} members, signed by ${signer.address}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
