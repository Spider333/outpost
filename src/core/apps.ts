// Which app posted a cast? A cast carries no "client" field, but it is signed by an app key,
// and every app key records the FID of the app that requested it (requestFid).
//   - Gasless keys: the node returns requestFid directly.
//   - Onchain keys: requestFid sits inside the key's SignedKeyRequest metadata; decode it.
// Limits: a key the user signed for themselves has requestFid == their own FID, so all
// self-signed tools look the same. A removed key may no longer be listed.

import { decodeGaslessSignedKeyRequestMetadata } from "@farcaster/core";
import { Hub, liveToken, type HexString, type HubSigner } from "./hub.js";

export type AppKind = "app" | "self" | "unknown";

export interface AppRef {
  kind: AppKind;
  requestFid?: number; // set when kind is "app" or "self"
  source?: "gasless" | "onchain";
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function requestFidOf(s: HubSigner): number | undefined {
  if (s.source === "SIGNER_SOURCE_OFFCHAIN") return s.requestFid;
  const meta = s.onChainEvent?.signerEventBody?.metadata;
  if (!meta) return undefined;
  const decoded = decodeGaslessSignedKeyRequestMetadata(base64ToBytes(meta));
  if (decoded.isErr()) return undefined;
  return Number(decoded.value.requestFid);
}

export function appRefOf(fid: number, s: HubSigner | undefined): AppRef {
  if (!s) return { kind: "unknown" };
  const requestFid = requestFidOf(s);
  const source = s.source === "SIGNER_SOURCE_OFFCHAIN" ? "gasless" : "onchain";
  if (requestFid === undefined) return { kind: "unknown", source };
  return { kind: requestFid === fid ? "self" : "app", requestFid, source };
}

// Caches signer -> app per author. One signersByFid call per author covers all their casts.
export class AppResolver {
  private byKey = new Map<string, AppRef>();
  private loaded = new Map<number, Promise<void>>();

  constructor(private readonly hub: Hub) {}

  private load(fid: number): Promise<void> {
    let p = this.loaded.get(fid);
    if (!p) {
      p = (async () => {
        let pageToken: string | undefined;
        do {
          const page = await this.hub.signersByFidPage(fid, pageToken);
          for (const s of page.signers) this.byKey.set(`${fid}:${s.key.toLowerCase()}`, appRefOf(fid, s));
          pageToken = liveToken(page.nextPageToken);
        } while (pageToken);
      })();
      p.catch(() => this.loaded.delete(fid));
      this.loaded.set(fid, p);
    }
    return p;
  }

  async appOf(fid: number, signer: HexString): Promise<AppRef> {
    const k = `${fid}:${signer.toLowerCase()}`;
    const hit = this.byKey.get(k);
    if (hit) return hit;
    await this.load(fid);
    const after = this.byKey.get(k);
    if (after) return after;
    // Not in the active list (removed or expired). Ask for this one key directly once.
    const ref = appRefOf(fid, await this.hub.signer(fid, signer).catch(() => undefined));
    this.byKey.set(k, ref);
    return ref;
  }
}

// Include/exclude rule. Values are app FIDs, or "self" for keys users signed for themselves,
// or "unknown" for casts whose key is no longer listed.
export type AppSelector = number | "self" | "unknown";

export interface AppFilter {
  include?: AppSelector[]; // if set, only these
  exclude?: AppSelector[]; // always removed
}

function matches(ref: AppRef, sel: AppSelector): boolean {
  if (sel === "self") return ref.kind === "self";
  if (sel === "unknown") return ref.kind === "unknown";
  return ref.kind === "app" && ref.requestFid === sel;
}

export function passesFilter(ref: AppRef, f: AppFilter | undefined): boolean {
  if (!f) return true;
  if (f.exclude?.some((s) => matches(ref, s))) return false;
  if (f.include && f.include.length > 0) return f.include.some((s) => matches(ref, s));
  return true;
}

export function parseAppSelector(s: string): AppSelector {
  if (s === "self" || s === "unknown") return s;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`app must be an FID, "self" or "unknown": ${s}`);
  return n;
}
