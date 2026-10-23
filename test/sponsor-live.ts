// Live check against Optimism, no money spent: a fresh phrase signs Register the way the web
// client does, and IdGateway simulates registerFor from a throwaway sponsor wallet (its balance
// is overridden for the simulation only). Then a signature for another address must fail.
// Run by hand: npx tsx test/sponsor-live.ts [optimism-rpc]
import { zeroAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { custodyFromSeedPhrase, newRecoveryPhrase, signRegistration } from "../src/core/account.js";
import { Optimism } from "../src/core/chain.js";
import { REGISTER_DEADLINE_SECONDS } from "../src/core/sponsor.js";
import { viemChain } from "../src/server/sponsor-service.js";

const rpc = process.argv[2] ?? "https://mainnet.optimism.io";
const op = new Optimism(rpc);
const owner = custodyFromSeedPhrase(newRecoveryPhrase());
const other = custodyFromSeedPhrase(newRecoveryPhrase());
const deadline = BigInt(Math.floor(Date.now() / 1000) + REGISTER_DEADLINE_SECONDS);
const signature = await signRegistration(owner, await op.registerNonce(owner.address), deadline);
const sponsor = viemChain(rpc, generatePrivateKey(), true);
const value = ((await sponsor.price()) * 105n) / 100n;
const req = { to: owner.address, recovery: zeroAddress, deadline: deadline.toString(), signature };

if ((await op.idOf(owner.address)) !== 0) throw new Error("a fresh address should own no FID");
await sponsor.simulate(req, value);
console.log(`ok: IdGateway accepts the signature (simulated) for ${owner.address}; fee with 5% margin ${value} wei`);
try {
  await sponsor.simulate({ ...req, to: other.address }, value);
  console.log("FAIL: a signature made for another address was accepted");
  process.exit(1);
} catch (e) {
  console.log(`ok: a signature for another address is rejected (${((e as { shortMessage?: string }).shortMessage ?? String(e)).split("\n")[0]})`);
}
