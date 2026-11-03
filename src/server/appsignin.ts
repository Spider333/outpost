// "Approve in the Farcaster app" for a society node: signs members' key requests with the
// society's app account. It runs next to the gate, behind Caddy at /app-signin (see
// infra/society.sh). The rules are in src/server/appsignin-service.ts.
//
// - Members only: the gate's members file and Bearer tokens.
// - The app account's custody key is read from a file (mode 600) that `./outpost app-account
//   --society` put on this server. It is never sent anywhere; the members' browsers send only
//   public keys, and get back only Farcaster's approval link.
// - Nothing about a request is logged.
//
// Environment: OUTPOST_APPSIGNIN_ACCOUNT (/appsignin/account.json), OUTPOST_APPSIGNIN_MEMBERS
// (/gate/members), OUTPOST_APPSIGNIN_PORT (3392, 127.0.0.1 only).

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { AppAccount } from "../core/appsignin.js";
import { societySignIn } from "./appsignin-service.js";
import { membersFrom } from "./sponsor-service.js";

const account = JSON.parse(readFileSync(process.env.OUTPOST_APPSIGNIN_ACCOUNT ?? "/appsignin/account.json", "utf8")) as AppAccount;
if (!(Number.isSafeInteger(account.fid) && account.fid > 0) || !/^0x[0-9a-f]{64}$/i.test(account.custodyKey) || privateKeyToAccount(account.custodyKey).address.toLowerCase() !== account.address?.toLowerCase()) {
  throw new Error("the app account file must hold fid, custodyKey and the matching address");
}
const port = Number(process.env.OUTPOST_APPSIGNIN_PORT ?? 3392);
const server = createServer(societySignIn({ account: () => account, members: membersFrom(process.env.OUTPOST_APPSIGNIN_MEMBERS ?? "/gate/members") }));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
server.listen(port, "127.0.0.1", () => console.log(`app-signin: app account FID ${account.fid}${account.sponsor ? ", sponsoring the fee" : ""}; 127.0.0.1:${port}`));
