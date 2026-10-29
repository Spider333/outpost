// Try mentions, notifications and "Approve in the Farcaster app" in the web client, with no
// mainnet account and no phone: a fake node, a stand-in for Farcaster's endpoint that approves on
// its own after a few polls, and the real sign-in handler of `./outpost client`.
//
//   npm run build && node --import tsx test/phase1-demo.ts
//
// Open the printed URL. Everything the page loads comes from 127.0.0.1. Ctrl-C stops the demo.
//   - Signed in as @me (FID 100, open /demo/as-me): notifications from @alice, @bob and FID 400, an unread count,
//     "Mark all read", and "@" suggestions in the composer.
//   - Fresh browser (/demo/fresh): no key; choose "Approve in the Farcaster app" to sign in as @carol
//     (FID 700, an account "made in the Farcaster app") without a phrase.
// The app account's custody key is Hardhat's public test key 2 and holds nothing.

import { createServer } from "node:http";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { buildReaction, extractMentions, type AppAccount, type HexString } from "../src/core/index.js";
import { sameOrigin, signInHandler } from "../src/server/appsignin-service.js";
import { fakeFarcaster } from "./fake-farcaster.js";
import { json, World } from "./votes-world.js";

const PORT = Number(process.env.OUTPOST_DEMO_PORT ?? 18390);
const CUSTODY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as HexString;
const APP: AppAccount = { fid: 900, custodyKey: CUSTODY, address: privateKeyToAccount(CUSTODY).address };
const ME = 100;
const CAROL = 700;
const ago = (min: number) => Math.floor((Date.now() - 1609459200000) / 1000) - min * 60;

const w = new World();
for (const [fid, name] of [[ME, "me"], [200, "alice"], [300, "bob"], [400, "dave"], [500, "erin"], [CAROL, "carol"], [APP.fid, "outpost-demo"]] as const) {
  await w.member(fid);
  await w.name(fid, name);
}
for (const f of [200, 300, 500]) await w.follow(ME, f, ago(600));
const like = async (fid: number, cast: { data: { fid: number }; hash: HexString }, min: number, kind: "like" | "recast" = "like") =>
  w.likes.push(json(await buildReaction(w.keys.get(fid)!, kind, { fid: cast.data.fid, hash: cast.hash }, ago(min))));

const first = await w.cast(ME, { text: "Trying Outpost: my own node, every message checked." }, ago(180));
const second = await w.cast(ME, { text: "Second cast, for the recasts." }, ago(120));
await w.cast(200, { text: "Welcome! Which node do you run?", replyTo: { fid: ME, hash: first.hash } }, ago(90));
await w.cast(300, { ...extractMentions("Good thread with @me and @alice 🎉", [{ name: "me", fid: ME }, { name: "alice", fid: 200 }]) }, ago(60));
await like(200, first, 50);
await like(300, first, 45);
await like(400, first, 40);
await like(500, second, 30, "recast");
await w.follow(400, ME, ago(20));
await w.cast(500, { text: "gm from erin" }, ago(10));

const second_ = await w.serve(0);
const fc = await fakeFarcaster({
  appAddress: APP.address,
  userFid: CAROL,
  autoApproveAfter: 3,
  onApprove: (r) => w.approve(CAROL, r.body.key, APP.fid),
});
const signIn = signInHandler({ account: () => APP, api: fc.url, refuse: sameOrigin });
const node = w.handler({ "/outpost-config.json": { network: "devnet", checkNode: second_.url } }, resolve("dist/web"));
// Opening /demo/as-me stores @me's throwaway key in the page's storage, so it is never printed.
const asMe = `<!doctype html><meta charset="utf-8"><script>localStorage.setItem("outpost.appkey", ${JSON.stringify(JSON.stringify(w.keys.get(ME)))}); location.replace("/");</script>`;
const fresh = `<!doctype html><meta charset="utf-8"><script>localStorage.clear(); location.replace("/");</script>`;
const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  if (path === "/demo/as-me" || path === "/demo/fresh") return void res.writeHead(200, { "content-type": "text/html" }).end(path === "/demo/as-me" ? asMe : fresh);
  if (path === "/outpost/app-signin" || path.startsWith("/outpost/app-signin/")) return signIn(req, res, path.slice("/outpost/app-signin".length));
  node(req, res);
});
await new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok));
const url = `http://127.0.0.1:${PORT}`;

console.log(`client, fake node and sign-in: ${url}   (second node for key checks: ${second_.url}, Farcaster stand-in: ${fc.url})`);
console.log(`app account: FID ${APP.fid} (@outpost-demo); approvals sign in as @carol (FID ${CAROL}) after 3 polls, about 6 s`);
console.log(`To act as @me (notifications, mentions), open ${url}/demo/as-me`);
console.log(`For the sign-in, start from a clean page: ${url}/demo/fresh`);
