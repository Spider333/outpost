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
// Callers never see the node's JSON: a message that passes is rebuilt from the decoded data
// whose bytes matched the hash (signedMessage), so a field the node adds next to the signed
// ones cannot reach the feed. Such a field also marks the message as altered.
//
// A valid signature only proves that key `signer` signed. Whether that key belongs to
// `data.fid` is checked without the node being read:
//   - onchain keys: the KeyRegistry on Optimism must list the key as added for that FID, read
//     through an RPC the member chooses (chain.ts).
//   - gasless keys (KEY_ADD): no onchain record, and the HTTP API returns no KEY_ADD message or
//     custody signature. A second, independent node is asked instead (secondnode.ts). Without
//     one, such messages are kept and marked unverified.

import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import {
  castTypeToJSON,
  farcasterNetworkToJSON,
  messageTypeToJSON,
  reactionTypeToJSON,
  userDataTypeToJSON,
  CastAddBody,
  MessageData,
  type CastId,
} from "@farcaster/core";
import { bytesToHex, hexToBytes } from "viem";
import type { HexString, HubMessage } from "./hub.js";

export type DropReason = "altered" | "signature" | "mismatch" | "signer";

// "onchain": the KeyRegistry lists the key for this FID. "confirmed": a second node lists it as
// one of the FID's active keys. "unverified": not checkable (no RPC or second node, or they
// failed). "false": the key is not (or no longer) the FID's: on Optimism, or per the second node.
export type KeyCheck = "onchain" | "confirmed" | "unverified" | "false";

export interface KeyRegistry {
  keyState(fid: number, key: HexString): Promise<"added" | "removed" | "none">;
}

export interface KeyLister {
  listsKey(fid: number, key: HexString): Promise<boolean>;
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

const bytesToBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

// A message in the node's JSON shape, built only from signed data: `d` is what was encoded and
// matched the hash. Bodies the client never reads (verifications, frames, ...) are left out.
export function signedMessage(d: MessageData, hash: Uint8Array, signature: Uint8Array, signer: Uint8Array): HubMessage {
  const id = (c: CastId | undefined) => c && { fid: c.fid, hash: bytesToHex(c.hash) };
  const data: HubMessage["data"] = { type: messageTypeToJSON(d.type), fid: d.fid, timestamp: d.timestamp, network: farcasterNetworkToJSON(d.network) };
  const c = d.castAddBody;
  if (c) {
    data.castAddBody = {
      text: c.text,
      embeds: c.embeds.map((e) => (e.castId ? { castId: id(e.castId)! } : { url: e.url ?? "" })),
      embedsDeprecated: [...c.embedsDeprecated],
      mentions: [...c.mentions],
      mentionsPositions: [...c.mentionsPositions],
      parentCastId: id(c.parentCastId) ?? null,
      parentUrl: c.parentUrl ?? null,
      type: castTypeToJSON(c.type),
    };
  }
  if (d.castRemoveBody) data.castRemoveBody = { targetHash: bytesToBase64(d.castRemoveBody.targetHash) };
  const r = d.reactionBody;
  if (r) {
    data.reactionBody = { type: reactionTypeToJSON(r.type) };
    if (r.targetCastId) data.reactionBody.targetCastId = id(r.targetCastId);
    if (r.targetUrl !== undefined) data.reactionBody.targetUrl = r.targetUrl;
  }
  const l = d.linkBody;
  if (l) data.linkBody = { type: l.type, targetFid: l.targetFid ?? 0, displayTimestamp: l.displayTimestamp ?? null };
  if (d.userDataBody) data.userDataBody = { type: userDataTypeToJSON(d.userDataBody.type), value: d.userDataBody.value };
  return {
    data,
    hash: bytesToHex(hash),
    hashScheme: "HASH_SCHEME_BLAKE3",
    signature: bytesToBase64(signature),
    signatureScheme: "SIGNATURE_SCHEME_ED25519",
    signer: bytesToHex(signer),
  };
}

// True when the node's JSON has a field (not null) that the signed message lacks, at any depth.
function extraField(node: unknown, signed: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (signed === null || typeof signed !== "object") return true;
  if (Array.isArray(node)) return !Array.isArray(signed) || node.length !== signed.length || node.some((v, i) => extraField(v, signed[i]));
  const s = signed as Record<string, unknown>;
  return Object.entries(node).some(([k, v]) => v !== null && v !== undefined && (!(k in s) || extraField(v, s[k])));
}

// The message rebuilt from its signed bytes, or why it failed.
export async function verifyMessage(m: HubMessage): Promise<HubMessage | "altered" | "signature"> {
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
    const signature = base64ToBytes(m.signature);
    const signer = hexToBytes(m.signer);
    if (!(await verifyEd25519(signature, hash, signer))) return "signature";
    const signed = signedMessage(d, hash, signature, signer);
    return extraField(m, signed) ? "altered" : signed; // the node added something
  } catch {
    return "altered"; // malformed JSON, hex, base64 or bytes: nothing to trust
  }
}

export async function checkMessage(m: HubMessage): Promise<"ok" | "altered" | "signature"> {
  const r = await verifyMessage(m);
  return typeof r === "string" ? r : "ok";
}

export class Verifier {
  checked = 0;
  readonly dropped: Record<DropReason, number> = { altered: 0, signature: 0, mismatch: 0, signer: 0 };
  private keys = new Map<string, Promise<KeyCheck>>();

  constructor(
    readonly chain?: KeyRegistry,
    readonly second?: KeyLister,
  ) {}

  get failed(): number {
    return Object.values(this.dropped).reduce((a, b) => a + b, 0);
  }

  drop(reason: DropReason) {
    this.dropped[reason]++;
  }

  // The messages that pass, rebuilt from their signed bytes; `asked` says whether a message
  // answers the request.
  async messages(ms: HubMessage[], asked: (m: HubMessage) => boolean = () => true): Promise<HubMessage[]> {
    const results = await Promise.all(ms.map(verifyMessage));
    this.checked += ms.length;
    const out: HubMessage[] = [];
    for (const r of results) {
      const failed = typeof r === "string" ? r : asked(r) ? undefined : "mismatch";
      if (failed) this.drop(failed);
      else out.push(r as HubMessage);
    }
    return out;
  }

  // `claimedOnchain`: the node says this is an onchain key. Errors give "unverified" and are
  // not remembered, so the next look tries again.
  keyCheck(fid: number, key: HexString, claimedOnchain: boolean): Promise<KeyCheck> {
    const k = `${fid}:${key.toLowerCase()}:${claimedOnchain}`;
    let p = this.keys.get(k);
    if (!p) {
      p = this.checkKey(fid, key, claimedOnchain);
      p.catch(() => this.keys.delete(k));
      this.keys.set(k, p);
    }
    return p.catch(() => "unverified" as const);
  }

  private async checkKey(fid: number, key: HexString, claimedOnchain: boolean): Promise<KeyCheck> {
    let state: "added" | "removed" | "none" | undefined;
    try {
      state = await this.chain?.keyState(fid, key);
    } catch (e) {
      if (!this.second) throw e; // the second node lists onchain keys too, so it can stand in
    }
    if (state === "added") return "onchain";
    // A removed onchain key's messages are revoked by the protocol, so none should be served.
    if (state === "removed" || (state === "none" && claimedOnchain)) return "false";
    if (!this.second) return "unverified";
    return (await this.second.listsKey(fid, key)) ? "confirmed" : "false";
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
