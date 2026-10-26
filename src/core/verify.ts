// Every message read from a node is checked here, in the member's own code, before anything
// uses it. The node is not asked whether a message is valid: a dishonest node would say yes.
//
// Snapchain's HTTP API (v0.15, src/network/http_server.rs) returns messages as JSON without
// the signed bytes, so the data is encoded again with Farcaster's protobuf schema
// (@farcaster/core), in the two forms apps produce (see castBytes). @farcaster/core 0.20.0 does
// not have the two cast fields Snapchain 0.15.0 added, so those are encoded here (castExtra).
// Then: blake3 of those
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
  CastId as CastIdCodec,
  MessageData,
  type CastId,
} from "@farcaster/core";
import { bytesToHex, hexToBytes } from "viem";
import type { HexString, HubMessage } from "./hub.js";

export type DropReason = "altered" | "signature" | "mismatch" | "signer";

// "onchain": the KeyRegistry lists the key for this FID. "confirmed": a second node lists it as
// one of the FID's active keys. "own": the member's own app key, held by this client.
// "revoked": the KeyRegistry lists it as the FID's key, removed since. Since Snapchain engine V14
// a removed key's earlier messages stay on the network (engine.rs, should_revoke_signer) and
// later ones are refused, so they are shown, marked. "unverified": not checkable (no RPC or
// second node, or they failed). "unlisted": a gasless key the second node does not list:
// revoked since, or never the FID's, and the HTTP API cannot tell which. Both are held back
// unless the member asks to see them. "false": provably not the FID's key: never shown.
export type KeyCheck = "onchain" | "confirmed" | "own" | "revoked" | "unverified" | "unlisted" | "false";

export interface KeyRegistry {
  keyState(fid: number, key: HexString): Promise<"added" | "removed" | "none">;
}

// How a node lists one of an account's keys. `scopes` are message type names such as
// "MESSAGE_TYPE_REACTION_ADD"; onchain keys have none and may sign any type.
export interface KeyScopes {
  onchain: boolean;
  scopes: string[];
}

export interface KeyLister {
  listsKey(fid: number, key: HexString): Promise<boolean>;
  keyScopes?(fid: number, key: HexString): Promise<KeyScopes | undefined>;
}

// For votes: "ok" when the key provably belongs to the account and may sign the message type,
// "unchecked" when that cannot be shown now, "no" when it provably does not or may not.
export type VoteKey = "ok" | "unchecked" | "no";

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// viem's hexToBytes skips the first two characters without looking at them, so "1x…" would
// decode like "0x…", and it reads upper and lower case alike. Nothing signed changes, but a
// changed character should still fail. Snapchain writes "0x" and lower case.
function strictHexToBytes(hex: string): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("not 0x-prefixed lower-case hex");
  return hexToBytes(hex as HexString);
}

// MessageData.fromJSON would turn "1234" or 1234.9 into 1234, and the hash would still match, so
// callers would see a value nobody signed. Only a plain non-negative integer passes.
function fidOf(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error("not a fid");
  return v as number;
}

function hexToBase64(hex: string): string {
  return btoa(String.fromCharCode(...strictHexToBytes(hex)));
}

// Snapchain JSON -> protobuf MessageData. Cast ids carry hex hashes in Snapchain's JSON and
// base64 in @farcaster/core's JSON form; everything else has the same names.
export function messageData(d: HubMessage["data"]): MessageData {
  const id = (c?: { fid: number; hash: string } | null) => (c ? { fid: fidOf(c.fid), hash: hexToBase64(c.hash) } : undefined);
  const cast = d.castAddBody && {
    ...d.castAddBody,
    parentCastId: id(d.castAddBody.parentCastId),
    embeds: d.castAddBody.embeds.map((e) => ("castId" in e ? { castId: id(e.castId) } : e)),
  };
  const reaction = d.reactionBody && { ...d.reactionBody, targetCastId: id(d.reactionBody.targetCastId) };
  return MessageData.fromJSON({ ...d, castAddBody: cast, reactionBody: reaction });
}

// The cast fields Snapchain 0.15.0 added (FIP "Cast Format and Chained Casts"), which
// @farcaster/core 0.20.0 does not know: format_version (field 9, uint32) and chain (field 10, a
// ChainCast: root CastId 1, index 2, count 3). The node's JSON has formatVersion only when it
// is not 0, and chain only when the cast has one (proto/definitions/message.proto, v0.15.0).
export interface CastExtra {
  formatVersion?: number;
  chain?: { root?: CastId; index: number; count: number };
}

function uint32(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 0xffffffff) throw new Error("not a uint32");
  return v as number;
}

export function castExtra(d: HubMessage["data"]): CastExtra {
  const b = d.castAddBody;
  const out: CastExtra = {};
  if (!b) return out;
  if (b.formatVersion !== undefined && b.formatVersion !== null) out.formatVersion = uint32(b.formatVersion);
  if (b.chain !== undefined && b.chain !== null) {
    const { root, index, count } = b.chain;
    out.chain = { index: uint32(index), count: uint32(count) };
    if (root !== undefined && root !== null) out.chain.root = { fid: fidOf(root.fid), hash: strictHexToBytes(root.hash) };
  }
  return out;
}

function varint(n: number): number[] {
  const out: number[] = [];
  for (; n >= 0x80; n = Math.floor(n / 128)) out.push((n % 128) | 0x80);
  out.push(n);
  return out;
}

// Fields 9 and 10 of CastAddBody, as every proto3 encoder writes them: format_version only when
// not 0, chain whenever it is set (it is `optional`), index and count only when not 0.
function castExtraBytes(e: CastExtra): number[] {
  const out: number[] = [];
  if (e.formatVersion) out.push(0x48, ...varint(e.formatVersion));
  if (e.chain) {
    const c: number[] = [];
    if (e.chain.root) {
      const root = CastIdCodec.encode(e.chain.root).finish();
      c.push(0x0a, ...varint(root.length), ...root);
    }
    if (e.chain.index) c.push(0x10, ...varint(e.chain.index));
    if (e.chain.count) c.push(0x18, ...varint(e.chain.count));
    out.push(0x52, ...varint(c.length), ...c);
  }
  return out;
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
// the same cast. The 0.15.0 fields (9 and 10) come last in both: they have the highest numbers,
// and they follow `type` (8) in the schema, the order @farcaster/core writes fields in.
function castBytes(d: MessageData, extra: CastExtra, proto3: boolean): Uint8Array | undefined {
  if (!d.castAddBody) return undefined;
  const raw = Uint8Array.from([...CastAddBody.encode(d.castAddBody).finish(), ...castExtraBytes(extra)]);
  const body = proto3 ? proto3Order(raw, [2, 5]) : raw;
  const head = MessageData.encode({ ...d, castAddBody: undefined }).finish();
  // castAddBody is field 5 and every field before it is in `head`.
  return Uint8Array.from([...head, 0x2a, ...varint(body.length), ...body]);
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
export function signedMessage(d: MessageData, hash: Uint8Array, signature: Uint8Array, signer: Uint8Array, extra: CastExtra = {}): HubMessage {
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
    if (extra.formatVersion) data.castAddBody.formatVersion = extra.formatVersion;
    const chain = extra.chain;
    if (chain) data.castAddBody.chain = { ...(chain.root && { root: id(chain.root)! }), index: chain.index, count: chain.count };
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
// Null fields are skipped on purpose, whatever their name: honest nodes send nulls the rebuilt
// message does not have (an absent parent, for example), and a null carries nothing signed or
// shown, since callers only ever see the rebuilt message. Flagging them would reject honest data.
function extraField(node: unknown, signed: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (signed === null || typeof signed !== "object") return true;
  if (Array.isArray(node)) return !Array.isArray(signed) || node.length !== signed.length || node.some((v, i) => extraField(v, signed[i]));
  const s = signed as Record<string, unknown>;
  // Object.hasOwn, not `in`: `in` also finds inherited names such as constructor or toString.
  return Object.entries(node).some(([k, v]) => v !== null && v !== undefined && (!Object.hasOwn(s, k) || extraField(v, s[k])));
}

// The message rebuilt from its signed bytes, or why it failed.
export async function verifyMessage(m: HubMessage): Promise<HubMessage | "altered" | "signature"> {
  try {
    if (m.hashScheme !== "HASH_SCHEME_BLAKE3" || m.signatureScheme !== "SIGNATURE_SCHEME_ED25519") return "altered";
    const d = messageData(m.data);
    const extra = castExtra(m.data);
    const want = m.hash; // compared with lower-case hex, so any other spelling fails
    const hashOf = (b: Uint8Array) => blake3(b, { dkLen: 20 });
    let hash = hashOf(castBytes(d, extra, false) ?? MessageData.encode(d).finish());
    if (bytesToHex(hash) !== want) {
      const alt = castBytes(d, extra, true);
      if (!alt || bytesToHex((hash = hashOf(alt))) !== want) return "altered";
    }
    const signature = base64ToBytes(m.signature);
    // atob ignores the unused bits of the last character; only the canonical spelling passes.
    if (bytesToBase64(signature) !== m.signature) return "altered";
    const signer = strictHexToBytes(m.signer);
    if (!(await verifyEd25519(signature, hash, signer))) return "signature";
    const signed = signedMessage(d, hash, signature, signer, extra);
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
  // Messages whose key could not be checked, or is not listed: hidden unless `showUnverified`.
  // Not failures. `unlisted` counts the second kind.
  unverified = 0;
  unlisted = 0;
  showUnverified = false;
  readonly dropped: Record<DropReason, number> = { altered: 0, signature: 0, mismatch: 0, signer: 0 };
  private keys = new Map<string, Promise<KeyCheck>>();
  private own = new Set<string>();

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

  // Whether a message signed with a key in state `k` may be used. Fails closed: a forged key
  // is dropped, an unchecked one is held back (and counted) unless the member asked for it.
  admits(k: KeyCheck | undefined): boolean {
    if (k === "false") {
      this.drop("signer");
      return false;
    }
    if (k === "unverified" || k === "unlisted") {
      this.unverified++;
      if (k === "unlisted") this.unlisted++;
      return this.showUnverified;
    }
    return true;
  }

  // Counts start again (caches stay), e.g. when the member switches showUnverified on.
  reset() {
    this.checked = 0;
    this.unverified = 0;
    this.unlisted = 0;
    for (const k of Object.keys(this.dropped) as DropReason[]) this.dropped[k] = 0;
  }

  // The member's own app key: this client holds it, so what it signed needs no second opinion.
  trust(fid: number, key: HexString) {
    this.own.add(`${fid}:${key.toLowerCase()}`);
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
    if (this.own.has(`${fid}:${key.toLowerCase()}`)) return Promise.resolve("own");
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
    if (state === "removed") return "revoked";
    if (state === "none" && claimedOnchain) return "false";
    if (!this.second) return "unverified";
    return (await this.second.listsKey(fid, key)) ? "confirmed" : "unlisted";
  }

  // For votes (votes.ts): may `key` sign a message of `type` (e.g. "MESSAGE_TYPE_REACTION_ADD")
  // for `fid`? A gasless key signs only the types its KEY_ADD named, and Snapchain refuses the
  // rest (engine.rs, active_key.admits), so its scopes are checked as well. "unchecked": a removed
  // onchain key, a gasless key the second node no longer lists, or nothing to ask. Since engine
  // V14 a removed key's old messages stay on the network, so such a vote may be genuine, but
  // nothing shows it was signed before the key went.
  async voteKey(fid: number, key: HexString, type: string): Promise<VoteKey> {
    if (this.own.has(`${fid}:${key.toLowerCase()}`)) return "ok";
    let state: "added" | "removed" | "none" | undefined;
    try {
      state = await this.chain?.keyState(fid, key);
    } catch {
      if (!this.second) return "unchecked";
    }
    if (state === "added") return "ok";
    if (state === "removed") return "unchecked";
    if (!this.second?.keyScopes) return "unchecked";
    let listed: KeyScopes | undefined;
    try {
      listed = await this.second.keyScopes(fid, key);
    } catch {
      return "unchecked";
    }
    if (!listed) return "unchecked";
    // Optimism says this is not an onchain key, yet the second node lists it as one.
    if (listed.onchain) return state === "none" ? "no" : "ok";
    return listed.scopes.includes(type) ? "ok" : "no";
  }

  // Tells "failed verification" (the node altered or forged something) apart from "could not
  // be checked" (no answer about a key). Never says "all passed" while either happened.
  // `node`: who sent the messages, as the start of a sentence.
  summary(node = "Your node"): string {
    const d = this.dropped;
    const parts = [
      d.altered && `${d.altered} altered`,
      d.signature && `${d.signature} with a bad signature`,
      d.signer && `${d.signer} signed by a key that is not the author's`,
      d.mismatch && `${d.mismatch} not matching the request`,
    ].filter(Boolean);
    const out: string[] = [];
    if (this.failed) out.push(`${node} sent ${this.failed} of ${this.checked} messages that failed verification${parts.length ? ` (${parts.join(", ")})` : ""}; they are not shown.`);
    const unchecked = this.unverified - this.unlisted;
    if (unchecked) {
      out.push(
        this.showUnverified
          ? `${unchecked} messages are shown although their signing key could not be checked (the second node is off or did not answer); they are marked "signer not verified".`
          : `${unchecked} messages were hidden because their signing key could not be checked (the second node is off or did not answer).`,
      );
    }
    if (this.unlisted) {
      out.push(
        this.showUnverified
          ? `${this.unlisted} messages are shown although the second node does not list their signing key (revoked since, or not the author's); they are marked "key not listed".`
          : `${this.unlisted} messages were hidden because the second node does not list their signing key: it was revoked since, or is not the author's.`,
      );
    }
    return out.join(" ") || `All ${this.checked} messages from the node passed verification.`;
  }
}
