// Farcaster's registries on Optimism, read through an RPC the member chooses, so key and
// custody checks do not take the node's word. Reads only (eth_call); nothing is ever sent.

import { createPublicClient, http } from "viem";
import { optimism } from "viem/chains";
import { ID_REGISTRY_ADDRESS, idRegistryABI, KEY_REGISTRY_ADDRESS, keyRegistryABI } from "@farcaster/core";
import type { HexString } from "./hub.js";
import type { KeyRegistry } from "./verify.js";

export const DEFAULT_OPTIMISM_RPC = "https://mainnet.optimism.io";

// Reads made together go out as one Multicall3 call: a feed costs a few RPC requests.
const client = (url: string, fetchFn?: typeof fetch) =>
  createPublicClient({ chain: optimism, transport: http(url, { fetchFn, retryCount: 1 }), batch: { multicall: true } });

export class Optimism implements KeyRegistry {
  private readonly client: ReturnType<typeof client>;

  constructor(
    readonly url = DEFAULT_OPTIMISM_RPC,
    fetchFn?: typeof fetch,
  ) {
    this.client = client(url, fetchFn);
  }

  async keyState(fid: number, key: HexString): Promise<"added" | "removed" | "none"> {
    const d = await this.client.readContract({ address: KEY_REGISTRY_ADDRESS, abi: keyRegistryABI, functionName: "keyDataOf", args: [BigInt(fid), key] });
    return d.state === 1 ? "added" : d.state === 2 ? "removed" : "none";
  }

  async custodyOf(fid: number): Promise<HexString | undefined> {
    const a = await this.client.readContract({ address: ID_REGISTRY_ADDRESS, abi: idRegistryABI, functionName: "custodyOf", args: [BigInt(fid)] });
    return /^0x0{40}$/.test(a) ? undefined : a;
  }
}
