// Try society votes in the web client without mainnet accounts: a fake node with a 5-member
// society and one open proposal, approved by 2 of the 3 members it needs.
//
//   npm run build && node --import tsx test/votes-demo.ts
//
// The fake node serves the built client itself (dist/web), so the page, the node and the
// charter log share one origin; `./outpost client` would only let the page reach https hosts
// besides its own. Open the printed URL and approve as member 300.

import { resolve } from "node:path";
import { add, BODY, society } from "./votes-world.js";

// A new founder's charter each run, so a browser that kept an earlier run's log sees another society.
const { w, log, head0 } = await society({}, { ...BODY, issuedAt: new Date().toISOString() });
await w.member(600); // the account the proposal adds
const p = await w.propose(100, head0, add(600));
await w.like(100, p);
await w.like(200, p);
const node = await w.serve(18390, { "/charter.log.json": log }, resolve("dist/web"));
const second = await w.serve(18391);
const key = w.keys.get(300)!;

console.log(`client and fake node: ${node.url}, second node: ${second.url}`);
console.log(`charter log: ${node.url}/charter.log.json (5 members; proposal "+ member 600" has 2 of 3 approvals)`);
console.log("In the page's console, start clean, act as member 300 and use the fake second node:");
console.log("  localStorage.clear();");
console.log(`  localStorage.setItem("outpost.appkey", ${JSON.stringify(JSON.stringify(key))});`);
console.log(`  localStorage.setItem("outpost.checknode", ${JSON.stringify(JSON.stringify(second.url))});`);
console.log(`  localStorage.setItem("outpost.rpc", '""'); location.reload();`);
console.log("Then load the charter log URL under Society. Ctrl-C stops the demo.");
