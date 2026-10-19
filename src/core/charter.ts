// Charter: a society is one signed JSON file.
// It names the members and moderators, which apps' casts to include or exclude, feed rules
// (channels, keywords) and a link to the society's code of conduct. Loading a charter applies
// its lens to your feed. Joining signs follows for its members. Leaving drops the lens and
// keeps your keys, follows and history.
//
// Signature: EIP-712 over keccak256 of the canonical JSON of everything except `signature`.
// Change one byte and the recovered signer changes, so the file is rejected.
// If the charter names an issuer FID, the signer must be that FID's custody address, which
// anyone can check on Optimism's IdRegistry (or, less strictly, against their node).

import { keccak256, recoverTypedDataAddress, toBytes, type Hex, type LocalAccount, type WalletClient } from "viem";
import { passesFilter, type AppFilter, type AppRef, type AppSelector } from "./apps.js";
import type { FeedItem } from "./feed.js";
import { Hub, type HexString } from "./hub.js";

export const CHARTER_VERSION = 1;

export interface CharterBody {
  charter: 1;
  name: string;
  description?: string;
  codeOfConduct?: string; // URL
  issuer?: { fid: number };
  members: number[];
  moderators?: number[];
  clients?: { include?: AppSelector[]; exclude?: AppSelector[] };
  feed?: {
    channels?: string[]; // parent URLs whose casts are part of the society's feed
    keywords?: string[]; // if set, a cast must contain one of them (case-insensitive)
    excludeKeywords?: string[];
  };
  nodes?: string[]; // https base URLs of society nodes members can use; signed like the rest
  issuedAt: string; // ISO 8601
}

export interface Charter extends CharterBody {
  signature: { type: "eip712"; signer: Hex; value: Hex };
}

export const CHARTER_DOMAIN = { name: "Charter", version: "1", chainId: 1 } as const;
export const CHARTER_TYPES = {
  Charter: [
    { name: "name", type: "string" },
    { name: "issuerFid", type: "uint256" },
    { name: "contentHash", type: "bytes32" },
  ],
} as const;

// Sorted keys, no whitespace, arrays kept in order. Same input, same bytes, everywhere.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("charter numbers must be finite");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function contentHash(body: CharterBody): Hex {
  const { signature: _drop, ...rest } = body as Charter;
  return keccak256(toBytes(canonicalJson(rest)));
}

function typedData(body: CharterBody) {
  return {
    domain: CHARTER_DOMAIN,
    types: CHARTER_TYPES,
    primaryType: "Charter" as const,
    message: { name: body.name, issuerFid: BigInt(body.issuer?.fid ?? 0), contentHash: contentHash(body) },
  };
}

const isFid = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
const isSelector = (s: unknown) => s === "self" || s === "unknown" || isFid(s);
const isHttpUrl = (s: unknown) => typeof s === "string" && /^(https?|chain):\/\//.test(s);
const isHttpsUrl = (s: unknown) => typeof s === "string" && /^https:\/\/[^\s/?#]+[^\s?#]*$/.test(s);

// Structural check. Returns a list of problems; empty means the shape is fine.
export function checkShape(c: unknown): string[] {
  const p: string[] = [];
  const o = c as Partial<Charter>;
  if (!o || typeof o !== "object") return ["not a JSON object"];
  if (o.charter !== CHARTER_VERSION) p.push(`"charter" must be ${CHARTER_VERSION}`);
  if (typeof o.name !== "string" || !o.name.trim() || o.name.length > 80) p.push('"name" must be 1 to 80 characters');
  if (o.description !== undefined && (typeof o.description !== "string" || o.description.length > 500)) p.push('"description" must be at most 500 characters');
  if (o.codeOfConduct !== undefined && !isHttpUrl(o.codeOfConduct)) p.push('"codeOfConduct" must be a URL');
  if (o.issuer !== undefined && !isFid(o.issuer?.fid)) p.push('"issuer.fid" must be an FID');
  if (!Array.isArray(o.members) || !o.members.every(isFid)) p.push('"members" must be a list of FIDs');
  else if (o.members.length > 5000) p.push('"members" is limited to 5000 FIDs');
  if (o.moderators !== undefined && (!Array.isArray(o.moderators) || !o.moderators.every(isFid))) p.push('"moderators" must be a list of FIDs');
  for (const k of ["include", "exclude"] as const) {
    const v = o.clients?.[k];
    if (v !== undefined && (!Array.isArray(v) || !v.every(isSelector))) p.push(`"clients.${k}" must list app FIDs, "self" or "unknown"`);
  }
  const f = o.feed;
  if (f?.channels !== undefined && (!Array.isArray(f.channels) || !f.channels.every(isHttpUrl))) p.push('"feed.channels" must be URLs');
  for (const k of ["keywords", "excludeKeywords"] as const) {
    const v = f?.[k];
    if (v !== undefined && (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.trim().length > 0))) p.push(`"feed.${k}" must be non-empty strings`);
  }
  if (o.nodes !== undefined && (!Array.isArray(o.nodes) || o.nodes.length > 20 || !o.nodes.every(isHttpsUrl))) p.push('"nodes" must be at most 20 https URLs');
  if (typeof o.issuedAt !== "string" || Number.isNaN(Date.parse(o.issuedAt))) p.push('"issuedAt" must be an ISO date');
  return p;
}

// Anything that can sign EIP-712 typed data for an address: a viem LocalAccount
// (from a key or phrase), or a wallet wrapped with walletCharterSigner().
export interface CharterSigner {
  address: Hex;
  signTypedData(td: ReturnType<typeof typedData>): Promise<Hex>;
}

export function walletCharterSigner(wallet: WalletClient): CharterSigner {
  const account = wallet.account;
  if (!account) throw new Error("wallet has no account selected");
  return { address: account.address, signTypedData: (td) => wallet.signTypedData({ ...td, account }) };
}

export async function signCharter(body: CharterBody, signer: CharterSigner | LocalAccount): Promise<Charter> {
  const problems = checkShape(body);
  if (problems.length) throw new Error(`charter is not valid: ${problems.join("; ")}`);
  const value = await (signer as CharterSigner).signTypedData(typedData(body));
  return { ...body, signature: { type: "eip712", signer: signer.address, value } };
}

export interface Verification {
  ok: boolean;
  signer?: Hex;
  // "custody" when the signer is the issuer FID's custody address (on Optimism if a chain was
  // given, else on your node).
  issuerCheck: "custody" | "mismatch" | "no-issuer" | "not-checked";
  problems: string[];
}

// With `chain` (an Optimism RPC the member chose), the issuer's custody comes from the IdRegistry
// contract, not from the node.
export async function verifyCharter(c: unknown, hub?: Hub, chain?: { custodyOf(fid: number): Promise<HexString | undefined> }): Promise<Verification> {
  const problems = checkShape(c);
  const ch = c as Charter;
  const sig = ch?.signature as { type?: unknown; signer?: unknown; value?: unknown } | undefined;
  if (!sig || sig.type !== "eip712" || typeof sig.value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig.value) || typeof sig.signer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(sig.signer)) {
    problems.push("missing or malformed signature");
  }
  if (problems.length) return { ok: false, issuerCheck: "not-checked", problems };
  let recovered: Hex;
  try {
    recovered = await recoverTypedDataAddress({ ...typedData(ch), signature: ch.signature.value });
  } catch (e) {
    return { ok: false, issuerCheck: "not-checked", problems: [`signature does not parse: ${(e as Error).message}`] };
  }
  if (recovered.toLowerCase() !== ch.signature.signer.toLowerCase()) {
    return { ok: false, signer: recovered, issuerCheck: "not-checked", problems: ["the file was changed after it was signed (signature does not match its content)"] };
  }
  if (!ch.issuer) return { ok: true, signer: recovered, issuerCheck: "no-issuer", problems: [] };
  const source = chain ?? hub;
  if (!source) return { ok: true, signer: recovered, issuerCheck: "not-checked", problems: [] };
  const custody = await source.custodyOf(ch.issuer.fid);
  if (!custody || custody.toLowerCase() !== recovered.toLowerCase()) {
    return { ok: false, signer: recovered, issuerCheck: "mismatch", problems: [`signed by ${recovered}, but FID ${ch.issuer.fid}'s custody address is ${custody ?? "unknown"}`] };
  }
  return { ok: true, signer: recovered, issuerCheck: "custody", problems: [] };
}

// ---- lens

export function charterAppFilter(c: CharterBody): AppFilter {
  return { include: c.clients?.include, exclude: c.clients?.exclude };
}

export function passesCharter(c: CharterBody, cast: { fid: number; text: string; parentUrl?: string; app: AppRef }): boolean {
  const members = new Set(c.members);
  const channels = new Set(c.feed?.channels ?? []);
  const inScope = members.has(cast.fid) || (cast.parentUrl !== undefined && channels.has(cast.parentUrl));
  if (!inScope) return false;
  if (!passesFilter(cast.app, charterAppFilter(c))) return false;
  const text = cast.text.toLowerCase();
  if (c.feed?.excludeKeywords?.some((k) => text.includes(k.toLowerCase()))) return false;
  if (c.feed?.keywords?.length && !c.feed.keywords.some((k) => text.includes(k.toLowerCase()))) return false;
  return true;
}

export function applyLens(c: CharterBody, items: FeedItem[]): FeedItem[] {
  return items.filter((it) =>
    passesCharter(c, { fid: it.fid, text: it.text, parentUrl: it.parent && "url" in it.parent ? it.parent.url : undefined, app: it.app }),
  );
}

// The society's feed: its members' casts plus its channels' casts, through the lens.
export async function charterFeed(
  feed: import("./feed.js").FeedBuilder,
  c: CharterBody,
  opts: { limit?: number; perAuthor?: number } = {},
): Promise<FeedItem[]> {
  const limit = opts.limit ?? 50;
  const filter = charterAppFilter(c);
  const [fromMembers, ...fromChannels] = await Promise.all([
    feed.fromAuthors(c.members, { limit: limit * 2, perAuthor: opts.perAuthor ?? 5, includeReplies: false, filter }),
    ...(c.feed?.channels ?? []).map((url) => feed.channel(url, { limit: limit * 2, filter })),
  ]);
  const seen = new Set<string>();
  return [fromMembers!, ...fromChannels]
    .flat()
    .filter((it) => (seen.has(it.hash) ? false : (seen.add(it.hash), true)))
    .sort((a, b) => b.time - a.time)
    .filter((it) => applyLens(c, [it]).length === 1)
    .slice(0, limit);
}
