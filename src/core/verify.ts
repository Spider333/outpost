// Every message read from a node is checked here, in the member's own code, before anything
// uses it. The node is not asked whether a message is valid: a dishonest node would say yes.
//
// Snapchain's HTTP API (v0.14, src/network/http_server.rs) returns messages as JSON without
// the signed bytes, so the data is encoded again with Farcaster's protobuf schema
// (@farcaster/core), in the two forms apps produce (see castBytesProto3). Then: blake3 of those
// bytes must equal `hash`, `signature` must be a valid
// ed25519 signature of `hash` by `signer` (strict rules, as Snapchain checks them), and the
// message must be what was asked for (the right account, cast or target).
//
// A valid signature only proves that key `signer` signed. Whether that key belongs to
// `data.fid` is checked against Optimism, through an RPC the member chooses (see chain.ts):
//   - onchain keys: the KeyRegistry must list the key as added for that FID.
//   - gasless keys (KEY_ADD): NOT checkable. The HTTP API returns no KEY_ADD message and no
//     custody signature, only the node's word. Such messages are kept and marked unverified.

import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { CastAddBody, MessageData } from "@farcaster/core";
import { bytesToHex, hexToBytes } from "viem";
import type { HexString, HubMessage } from "./hub.js";

export type DropReason = "altered" | "signature" | "mismatch" | "signer";

// "onchain": the KeyRegistry lists the key for this FID. "unverified": not checkable (gasless
// key, no RPC, or the RPC failed). "false": the key is provably not (or no longer) the FID's.
export type KeyCheck = "onchain" | "unverified" | "false";

export interface KeyRegistry {
  keyState(fid: number, key: HexString): Promise<"added" | "removed" | "none">;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBase64(hex: string): string {
  return btoa(String.fromCharCode(...hexToBytes(hex as HexString)));
}

// Snapchain JSON -> protobuf MessageData. Cast ids carry hex hashes in Snapchain's JSON and
// base64 in @farcaster/core's JSON form; everything else has the same names.
export function messageData(d: HubMessage["data"]): MessageData {
  const id = (c?: { fid: number; hash: string } | null) => (c ? { fid: c.fid, hash: hexToBase64(c.hash) } : undefined);
  const cast = d.castAddBody && {
    ...d.castAddBody,
    parentCastId: id(d.castAddBody.parentCastId),
    embeds: d.castAddBody.embeds.map((e) => ("castId" in e ? { castId: id(e.castId) } : e)),
  };
  const reaction = d.reactionBody && { ...d.reactionBody, targetCastId: id(d.reactionBody.targetCastId) };
  return MessageData.fromJSON({ ...d, castAddBody: cast, reactionBody: reaction });
}

// One level of protobuf bytes rewritten the way strict proto3 encoders write it: fields in
// field-number order, and no length-0 field among `dropIfEmpty`.
function proto3Order(bytes: Uint8Array, dropIfEmpty: number[]): Uint8Array {
  const out: Array<{ n: number; b: Uint8Array }> = [];
  const varint = (i: number): [number, number] => {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      const b = bytes[i++]!;
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return [v, i];
    }
  };
  for (let i = 0; i < bytes.length; ) {
    const [tag, at] = varint(i);
    const wire = tag & 7;
    const [len, body] = wire === 2 ? varint(at) : [0, at];
    const end = wire === 0 ? varint(at)[1] : wire === 1 ? at + 8 : wire === 5 ? at + 4 : wire === 2 ? body + len : NaN;
    if (Number.isNaN(end) || end > bytes.length) throw new Error("bad protobuf");
    const n = Math.floor(tag / 8);
    if (!(wire === 2 && len === 0 && dropIfEmpty.includes(n))) out.push({ n, b: bytes.subarray(i, end) });
    i = end;
  }
  return Uint8Array.from(out.sort((a, b) => a.n - b.n).flatMap((f) => [...f.b])); // stable: lists keep their order
}

// @farcaster/core writes an empty `mentions` or `mentionsPositions` list as a field of length 0,
// and a channel's `parentUrl` (field 7) right after `mentions` (field 2). Apps built on other
// protobuf libraries (Rust, Go, protobuf-es) leave empty lists out and write fields in number
// order. The hash covers the posting app's own bytes, so both forms are tried. Both decode to
// the same cast.
function castBytesProto3(d: MessageData): Uint8Array | undefined {
  if (!d.castAddBody) return undefined;
  const body = proto3Order(CastAddBody.encode(d.castAddBody).finish(), [2, 5]);
  const head = MessageData.encode({ ...d, castAddBody: undefined }).finish();
  const len: number[] = [];
  for (let n = body.length; ; n >>>= 7) {
    if (n < 0x80) {
      len.push(n);
      break;
    }
    len.push((n & 0x7f) | 0x80);
  }
  // castAddBody is field 5 and every field before it is in `head`.
  return Uint8Array.from([...head, 0x2a, ...len, ...body]);
}

// Ed25519 through WebCrypto where the platform has it (about 20 times faster), else the strict
// pure-JS check Snapchain also uses. Both accept every honestly signed message.
let native: boolean | undefined;
async function verifyEd25519(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): Promise<boolean> {
  if (native !== false) {
    try {
      const key = await crypto.subtle.importKey("raw", pub as BufferSource, { name: "Ed25519" }, false, ["verify"]);
      native = true;
      return await crypto.subtle.verify({ name: "Ed25519" }, key, sig as BufferSource, msg as BufferSource);
    } catch {
      if (native) return false; // a key WebCrypto rejects
      native = false; // no Ed25519 in this browser
    }
  }
  return ed25519.verify(sig, msg, pub, { zip215: false });
}

export async function checkMessage(m: HubMessage): Promise<"ok" | "altered" | "signature"> {
  try {
    if (m.hashScheme !== "HASH_SCHEME_BLAKE3" || m.signatureScheme !== "SIGNATURE_SCHEME_ED25519") return "altered";
    const d = messageData(m.data);
    const want = m.hash.toLowerCase();
    const hashOf = (b: Uint8Array) => blake3(b, { dkLen: 20 });
    let hash = hashOf(MessageData.encode(d).finish());
    if (bytesToHex(hash) !== want) {
      const alt = castBytesProto3(d);
      if (!alt || bytesToHex((hash = hashOf(alt))) !== want) return "altered";
    }
    return (await verifyEd25519(base64ToBytes(m.signature), hash, hexToBytes(m.signer))) ? "ok" : "signature";
  } catch {
    return "altered"; // malformed JSON, hex, base64 or bytes: nothing to trust
  }
}

export class Verifier {
  checked = 0;
  readonly dropped: Record<DropReason, number> = { altered: 0, signature: 0, mismatch: 0, signer: 0 };
  private keys = new Map<string, Promise<KeyCheck>>();

  constructor(readonly chain?: KeyRegistry) {}

  get failed(): number {
    return Object.values(this.dropped).reduce((a, b) => a + b, 0);
  }

  drop(reason: DropReason) {
    this.dropped[reason]++;
  }

  // Keeps the messages that pass; `asked` says whether a message answers the request.
  async messages(ms: HubMessage[], asked: (m: HubMessage) => boolean = () => true): Promise<HubMessage[]> {
    const results = await Promise.all(ms.map(checkMessage));
    this.checked += ms.length;
    return ms.filter((m, i) => {
      const r = results[i] === "ok" && !asked(m) ? "mismatch" : results[i]!;
      if (r !== "ok") this.drop(r);
      return r === "ok";
    });
  }

  // `claimedOnchain`: the node says this is an onchain key. A gasless claim cannot be checked.
  keyCheck(fid: number, key: HexString, claimedOnchain: boolean): Promise<KeyCheck> {
    const chain = this.chain;
    if (!chain) return Promise.resolve("unverified");
    const k = `${fid}:${key.toLowerCase()}:${claimedOnchain}`;
    let p = this.keys.get(k);
    if (!p) {
      p = chain.keyState(fid, key).then((s) =>
        // A removed onchain key's messages are revoked by the protocol, so none should be served.
        s === "added" ? "onchain" : s === "removed" || claimedOnchain ? "false" : "unverified",
      );
      p.catch(() => this.keys.delete(k));
      this.keys.set(k, p);
    }
    return p.catch(() => "unverified" as const);
  }

  summary(): string {
    const d = this.dropped;
    const parts = [
      d.altered && `${d.altered} altered`,
      d.signature && `${d.signature} with a bad signature`,
      d.signer && `${d.signer} signed by a key that is not the author's`,
      d.mismatch && `${d.mismatch} not matching the request`,
    ].filter(Boolean);
    return `Your node sent ${this.failed} of ${this.checked} messages that failed verification${parts.length ? ` (${parts.join(", ")})` : ""}; they are not shown.`;
  }
}
