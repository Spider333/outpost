// A second, independent node, asked whether a key really is one of an account's active keys
// when Optimism cannot say (gasless keys have no onchain record, and Snapchain's HTTP API does
// not return the custody signature that added them). A fake then needs both nodes to lie.
// The second node learns which accounts you check (one signersByFid read per account per
// session, covering all its keys), not which casts you read.
//
// Snapchain deletes a removed gasless key's record but, since engine V14, keeps the messages it
// signed; an expired gasless key stays listed (with its expiresAt). So "not listed" means the
// key was revoked since, or was never the account's: the HTTP API cannot tell which.

import { FARCASTER_EPOCH_MS } from "./feed.js";
import { Hub, liveToken, type HexString, type HubSigner } from "./hub.js";
import type { KeyLister, KeyScopes, KeyUse } from "./verify.js";

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
  private byFid = new Map<number, Promise<Map<string, HubSigner>>>();

  constructor(readonly hub: Hub) {}

  private keys(fid: number): Promise<Map<string, HubSigner>> {
    let p = this.byFid.get(fid);
    if (!p) {
      p = (async () => {
        const keys = new Map<string, HubSigner>();
        let pageToken: string | undefined;
        do {
          const page = await this.hub.signersByFidPage(fid, pageToken);
          for (const s of page.signers) {
            if (s.fid === fid) keys.set(s.key.toLowerCase(), s);
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

  // With `use`, the key must also be allowed to sign that message. A gasless key signs only the
  // types its KEY_ADD named (Snapchain refuses the rest: engine.rs, active_key.admits) and only
  // until it expires (appkey.ts). Its expiresAt moves later each time it is used, so every message
  // it really signed is dated before the expiresAt listed now. Onchain keys have no scopes. Scopes
  // or an expiry the node does not list are not checked. The date is the signer's own, so whoever
  // holds an expired key can still backdate a message; only the node that refused it can tell.
  listsKey(fid: number, key: HexString, use?: KeyUse): Promise<boolean> {
    return this.keys(fid).then((keys) => {
      const s = keys.get(key.toLowerCase());
      if (!s || !use) return !!s;
      if (s.source !== "SIGNER_SOURCE_ONCHAIN" && s.scopes && !s.scopes.includes(use.type)) return false;
      return !s.expiresAt || FARCASTER_EPOCH_MS / 1000 + use.timestamp < s.expiresAt;
    });
  }

  keyScopes(fid: number, key: HexString): Promise<KeyScopes | undefined> {
    return this.keys(fid).then((keys) => {
      const s = keys.get(key.toLowerCase());
      return s && { onchain: s.source === "SIGNER_SOURCE_ONCHAIN", scopes: s.scopes ?? [] };
    });
  }
}

// Undefined when the second node is the node being read: a node cannot second itself. Compared by
// base URL, so ./outpost client can forward one path to the node and another to the second node.
export function secondNode(url: string, readingFrom: string, fetchImpl?: typeof fetch): SecondNode | undefined {
  const base = (u: string) => new URL(u).href.replace(/\/+$/, "");
  if (base(url) === base(readingFrom)) return undefined;
  return new SecondNode(new Hub({ url, fetch: fetchImpl, timeoutMs: 10_000 }));
}
