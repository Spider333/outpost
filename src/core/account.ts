// Custody account: the Ethereum address that owns an FID.
// Two ways to get a custody signer:
//   - fromWallet(): an EIP-1193 wallet signs. The phrase never leaves the wallet. Preferred.
//   - fromSeedPhrase(): for TEST accounts, and for a phrase this page just made for a new
//     account. The phrase is used in memory to sign, never stored.

import { Eip712Signer, ViemLocalEip712Signer, ViemWalletEip712Signer } from "@farcaster/core";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import { bytesToHex, createWalletClient, custom, zeroAddress, type Chain, type EIP1193Provider } from "viem";
import { mainnet } from "viem/chains";
import { Hub, HubError, type HexString } from "./hub.js";
import { unwrap } from "./appkey.js";

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

// `chain` is the chain of the typed data the wallet will sign: KeyAdd's EIP-712 domain uses
// chainId 1, Register uses Optimism. Some wallets refuse to sign typed data for a chain that is
// not active, so ask to switch first (and to add the chain if the wallet lacks it). Nothing is
// sent onchain.
export async function custodyFromWallet(provider: EIP1193Provider, chain: Chain = mainnet): Promise<Custody> {
  const probe = createWalletClient({ chain, transport: custom(provider) });
  const [address] = await probe.requestAddresses();
  if (!address) throw new Error("wallet returned no address");
  try {
    await probe.switchChain({ id: chain.id });
  } catch {
    // Wallets without chain switching still sign; the node checks the signature, not the chain.
    if (chain.id !== mainnet.id) await probe.addChain({ chain }).catch(() => undefined);
  }
  const client = createWalletClient({ account: address, chain, transport: custom(provider) });
  return { address, signer: new ViemWalletEip712Signer(client) };
}

// A fresh 12-word phrase for a new account. The caller shows it once and keeps no copy.
export function newRecoveryPhrase(): string {
  return generateMnemonic(english);
}

// The Register signature a sponsor needs to create an FID owned by `custody.address` and paid
// for by the sponsor (IdGateway.registerFor). No recovery address: the phrase or wallet is the
// only key to the account.
export async function signRegistration(custody: Custody, nonce: bigint, deadline: bigint): Promise<HexString> {
  return bytesToHex(unwrap(await custody.signer.signRegister({ to: custody.address, recovery: zeroAddress, nonce, deadline })));
}

export interface AccountInfo {
  fid: number;
  custody: HexString;
  storageUnits: number;
}

// Finds the FID owned by this custody address and checks, against the node, that the
// address really is the current custody before anything gets signed. With `chain` the FID is
// looked up on Optimism: a node can take a minute to answer for an address that owns none.
export async function resolveAccount(hub: Hub, custody: HexString, chain?: { idOf(a: HexString): Promise<number> }): Promise<AccountInfo> {
  let fid: number | undefined;
  try {
    fid = chain ? await chain.idOf(custody) : await hub.fidByCustody(custody);
  } catch (e) {
    if (chain || !(e instanceof HubError) || (e.status !== 0 && e.status < 500)) throw e;
    throw new Error(`Could not tell whether ${custody} owns a Farcaster account: the node did not answer in time, which happens for addresses without one. Turn the Optimism RPC on under "Node and checks" for a quick answer.`);
  }
  if (!fid) {
    throw new Error(`No Farcaster account belongs to ${custody}. Check the phrase or wallet${chain ? "" : ", or wait until your node has synced"}.`);
  }
  const current = await hub.custodyOf(fid);
  if (!current && chain) throw new Error(`${custody} owns FID ${fid}, but your node has not seen that account yet. A new account shows up within a few minutes; try again then.`);
  if (!current || current.toLowerCase() !== custody.toLowerCase()) {
    throw new Error(`FID ${fid} has moved: its custody is now ${current ?? "unknown"}, not ${custody}. Refusing to sign.`);
  }
  const storage = await hub.storageLimits(fid);
  return { fid, custody, storageUnits: storage.units };
}
