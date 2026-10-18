// Custody account: the Ethereum address that owns an FID.
// Two ways to get a custody signer:
//   - fromWallet(): an EIP-1193 wallet signs. The phrase never leaves the wallet. Preferred.
//   - fromSeedPhrase(): for TEST accounts only. The phrase is used in memory to sign, never stored.

import { Eip712Signer, ViemLocalEip712Signer, ViemWalletEip712Signer } from "@farcaster/core";
import { mnemonicToAccount } from "viem/accounts";
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { mainnet } from "viem/chains";
import { Hub, type HexString } from "./hub.js";

// Farcaster recovery phrases use the first standard Ethereum account.
export const CUSTODY_PATH = "m/44'/60'/0'/0/0";

export interface Custody {
  address: HexString;
  signer: Eip712Signer;
}

export function custodyFromSeedPhrase(phrase: string): Custody {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(" ");
  const words = normalized.split(" ").length;
  if (![12, 15, 18, 21, 24].includes(words)) {
    throw new Error(`a recovery phrase has 12 or 24 words; got ${words}`);
  }
  const account = mnemonicToAccount(normalized, { path: CUSTODY_PATH });
  return { address: account.address, signer: new ViemLocalEip712Signer(account) };
}

export async function custodyFromWallet(provider: EIP1193Provider): Promise<Custody> {
  const probe = createWalletClient({ chain: mainnet, transport: custom(provider) });
  const [address] = await probe.requestAddresses();
  if (!address) throw new Error("wallet returned no address");
  // The KeyAdd EIP-712 domain uses chainId 1. Some wallets refuse to sign typed data
  // for a chain that is not active, so ask to switch first. Nothing is sent onchain.
  try {
    await probe.switchChain({ id: mainnet.id });
  } catch {
    // Wallets without chain switching still sign; the node checks the signature, not the chain.
  }
  const client = createWalletClient({ account: address, chain: mainnet, transport: custom(provider) });
  return { address, signer: new ViemWalletEip712Signer(client) };
}

export interface AccountInfo {
  fid: number;
  custody: HexString;
  storageUnits: number;
}

// Finds the FID owned by this custody address and checks, against the node, that the
// address really is the current custody before anything gets signed.
export async function resolveAccount(hub: Hub, custody: HexString): Promise<AccountInfo> {
  const fid = await hub.fidByCustody(custody);
  if (!fid) {
    throw new Error(`no FID is registered to ${custody}. Check the phrase, or wait until your node has synced.`);
  }
  const current = await hub.custodyOf(fid);
  if (!current || current.toLowerCase() !== custody.toLowerCase()) {
    throw new Error(`FID ${fid} has moved: its custody is now ${current ?? "unknown"}, not ${custody}. Refusing to sign.`);
  }
  const storage = await hub.storageLimits(fid);
  return { fid, custody, storageUnits: storage.units };
}
