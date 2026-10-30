// A second, independent node, asked whether a key really is one of an account's active keys
// when Optimism cannot say (gasless keys have no onchain record, and Snapchain's HTTP API does
// not return the custody signature that added them). A fake then needs both nodes to lie.
// The second node learns which accounts you check (one signersByFid read per account per
// session, covering all its keys), not which casts you read.
//
// Snapchain deletes a removed gasless key's record but, since engine V14, keeps the messages it
// signed; an expired gasless key stays listed (with its expiresAt). So "not listed" means the
// key was revoked since, or was never the account's: the HTTP API cannot tell which.

import { Hub, liveToken, type HexString } from "./hub.js";
import type { KeyLister, KeyScopes } from "./verify.js";

// Farcaster's public read node: plain GETs work from any page (Access-Control-Allow-Origin: *).
export const DEFAULT_CHECK_NODE = "https://snap.farcaster.xyz:3381";
// Another public node Farcaster runs, on a separate machine. Used as the second node when the node
// being read is snap.farcaster.xyz (./outpost client --public): same operator, so it catches one
// node being wrong, not Farcaster itself.
export const OTHER_PUBLIC_NODE = "https://crackle.farcaster.xyz:3381";

// The default second node for a node being read: Farcaster's public node, or, when that is the
// node being read, its other public node.
export function checkNodeFor(readingFrom: string): string {
  return new URL(readingFrom).origin === new URL(DEFAULT_CHECK_NODE).origin ? OTHER_PUBLIC_NODE : DEFAULT_CHECK_NODE;
}

export class SecondNode implements KeyLister {
  private byFid = new Map<number, Promise<Map<string, KeyScopes>>>();

  constructor(readonly hub: Hub) {}

  private keys(fid: number): Promise<Map<string, KeyScopes>> {
    let p = this.byFid.get(fid);
    if (!p) {
      p = (async () => {
        const keys = new Map<string, KeyScopes>();
        let pageToken: string | undefined;
        do {
          const page = await this.hub.signersByFidPage(fid, pageToken);
          for (const s of page.signers) {
            if (s.fid === fid) keys.set(s.key.toLowerCase(), { onchain: s.source === "SIGNER_SOURCE_ONCHAIN", scopes: s.scopes ?? [] });
          }
          pageToken = liveToken(page.nextPageToken);
        } while (pageToken);
        return keys;
      })();
      p.catch(() => this.byFid.delete(fid)); // errors are not remembered
      this.byFid.set(fid, p);
    }
    return p;
  }

  listsKey(fid: number, key: HexString): Promise<boolean> {
    return this.keys(fid).then((keys) => keys.has(key.toLowerCase()));
  }

  keyScopes(fid: number, key: HexString): Promise<KeyScopes | undefined> {
    return this.keys(fid).then((keys) => keys.get(key.toLowerCase()));
  }
}

// Undefined when the second node is the node being read: a node cannot second itself. Compared by
// base URL, so ./outpost client can forward one path to the node and another to the second node.
export function secondNode(url: string, readingFrom: string, fetchImpl?: typeof fetch): SecondNode | undefined {
  const base = (u: string) => new URL(u).href.replace(/\/+$/, "");
  if (base(url) === base(readingFrom)) return undefined;
  return new SecondNode(new Hub({ url, fetch: fetchImpl, timeoutMs: 10_000 }));
}
