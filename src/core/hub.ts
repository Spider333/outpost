// Minimal client for a Snapchain node's HTTP API (port 3381).
// Uses fetch only, so the same code runs in Node 20+ and in the browser.
// Snapchain does not serve gRPC-web, so @farcaster/hub-web does not work here.

import { Message } from "@farcaster/core";
import type { Verifier } from "./verify.js";

export type HexString = `0x${string}`;

// JSON shapes returned by snapchain v0.14.x (src/network/http_server.rs).
export interface HubMessage {
  data: {
    type: string; // e.g. "MESSAGE_TYPE_CAST_ADD"
    fid: number;
    timestamp: number; // Farcaster seconds
    network: string;
    castAddBody?: {
      text: string;
      embeds: Array<{ url: string } | { castId: { fid: number; hash: string } }>;
      embedsDeprecated: string[];
      mentions: number[];
      mentionsPositions: number[];
      parentCastId?: { fid: number; hash: string } | null;
      parentUrl?: string | null;
      type: string;
      // Since Snapchain 0.15.0, only when set: 1 is article Markdown; absent is plain text.
      formatVersion?: number;
      // Since Snapchain 0.15.0, on every cast of a chain; `root` is absent on the first one.
      chain?: { root?: { fid: number; hash: string }; index: number; count: number };
    };
    castRemoveBody?: { targetHash: string }; // base64
    reactionBody?: { type: string; targetCastId?: { fid: number; hash: string }; targetUrl?: string };
    linkBody?: { type: string; targetFid: number; displayTimestamp?: number | null };
    userDataBody?: { type: string; value: string };
    keyAddBody?: { key: string; scopes: string[]; ttl: number; nonce: number; deadline: number };
    keyRemoveBody?: { key: string; signatureType: number; nonce: number; deadline: number };
  };
  hash: HexString;
  hashScheme: string;
  signature: string; // base64
  signatureScheme: string;
  signer: HexString;
}

export interface Paged<T> {
  items: T[];
  nextPageToken?: string;
}

export interface HubSigner {
  source: "SIGNER_SOURCE_ONCHAIN" | "SIGNER_SOURCE_OFFCHAIN" | "SIGNER_SOURCE_NONE";
  key: HexString;
  keyType: number;
  fid: number;
  addedAt?: number;
  lastUsedAt?: number;
  ttl?: number;
  expiresAt?: number; // Unix seconds (the node converts from Farcaster time)
  scopes?: string[];
  requestFid?: number;
  nonce?: number;
  onChainEvent?: {
    fid: number;
    signerEventBody?: { key: HexString; eventType: string; metadata: string /* base64 */; metadataType: number };
  };
}

export interface SignersByFid {
  signers: HubSigner[];
  nextPageToken?: string;
  gaslessSignerCount: number;
  gaslessSignerLimit: number;
  currentUserNonce: number;
  requesterFidNonces?: Record<string, number>;
}

export interface ShardInfo {
  shardId: number;
  maxHeight: number;
  numMessages: number;
  blockDelay: number;
}

export interface HubInfo {
  version: string;
  numShards: number;
  shardInfos: ShardInfo[];
}

export interface StorageLimits {
  units: number;
  limits: Array<{ storeType: string; name?: string; limit: number; used: number }>;
}

// Endpoints that read every shard (castsByParent, for example) end with a token that is
// base64 of "[null,null]", not an empty one. Sending it back starts again from page 1, so a
// client that follows tokens until they run out loops forever. Treat it as the end.
export function liveToken(token: string | undefined | null): string | undefined {
  if (!token) return undefined;
  try {
    const parts: unknown = JSON.parse(atob(token));
    if (Array.isArray(parts) && parts.every((p) => p === null)) return undefined;
  } catch {
    // A single-shard token is opaque bytes, not JSON.
  }
  return token;
}

export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "HubError";
  }
}

export interface HubOptions {
  // e.g. "http://127.0.0.1:3381" or "https://node.example.org"
  url: string;
  // Optional Basic auth, for a node behind Caddy or with rpc_auth set.
  username?: string;
  password?: string;
  // Bearer token for a society node (one per member). Takes the place of Basic auth.
  token?: string;
  // Checks every message the node returns; failures are dropped and counted (verify.ts).
  verifier?: Verifier;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// A society node answers 429 with Retry-After (whole seconds) when a member is over their rate
// limit (default 20 reads/s). A feed reads with up to 24 requests at once, so a request may be
// turned away several times in a row: keep retrying until a minute of waiting in total.
const MAX_RETRIES = 20;
const MAX_RETRY_WAIT_MS = 60_000;

function retryAfterMs(h: string | null): number {
  const s = Number(h);
  if (h && Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = h ? Date.parse(h) : NaN;
  return Number.isNaN(t) ? 5_000 : Math.max(0, t - Date.now());
}

type Query = Record<string, string | number | boolean | Array<string | number> | undefined>;

export class Hub {
  readonly url: string;
  readonly verifier?: Verifier;
  private readonly auth?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HubOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    if (opts.token !== undefined) this.auth = `Bearer ${opts.token}`;
    else if (opts.username !== undefined) {
      this.auth = "Basic " + btoa(`${opts.username}:${opts.password ?? ""}`);
    }
    this.verifier = opts.verifier;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.auth ? { ...extra, authorization: this.auth } : extra;
  }

  private async request<T>(method: "GET" | "POST", path: string, query?: Query, body?: Uint8Array): Promise<T> {
    // Snapchain parses queries with serde_qs in strict mode: list parameters must be written
    // as key[0]=a&key[1]=b with literal brackets. Percent-encoded brackets (what
    // URLSearchParams produces) are silently ignored, and repeated keys are rejected.
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((x, i) => parts.push(`${encodeURIComponent(k)}[${i}]=${encodeURIComponent(String(x))}`));
      else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    const url = `${this.url}${path}${parts.length ? `?${parts.join("&")}` : ""}`;
    let res: Response;
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: this.headers(body ? { "content-type": "application/octet-stream" } : {}),
          body: body as BodyInit | undefined,
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new HubError(`cannot reach node at ${this.url}`, 0, (e as Error).message);
      } finally {
        clearTimeout(timer);
      }
      const wait = retryAfterMs(res.headers.get("retry-after"));
      if (res.status !== 429 || attempt >= MAX_RETRIES || waited + wait > MAX_RETRY_WAIT_MS) break;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, wait));
      waited += wait;
    }
    if (res.status === 401) throw new HubError(`the node at ${this.url} refused the access token (HTTP 401)`, 401, "the host removed it, or it was mistyped");
    if (res.status === 429) {
      throw new HubError(`the node at ${this.url} is rate limiting you (HTTP 429)`, 429, `try again in ${Math.ceil(retryAfterMs(res.headers.get("retry-after")) / 1000)} s`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new HubError(`${method} ${path} returned non-JSON (HTTP ${res.status})`, res.status, text.slice(0, 200));
    }
    if (!res.ok) {
      const j = json as { error?: string; error_detail?: string; errCode?: string; details?: string; detail?: string };
      throw new HubError(j.error ?? `${method} ${path} failed (HTTP ${res.status})`, res.status, j.error_detail ?? j.details ?? j.detail);
    }
    return json as T;
  }

  info(): Promise<HubInfo> {
    return this.request("GET", "/v1/info");
  }

  // Custody address -> its ID registry event (gives the FID). No Optimism RPC needed.
  async fidByCustody(address: HexString): Promise<number | undefined> {
    try {
      const ev = await this.request<{ fid: number }>("GET", "/v1/onChainIdRegistryEventByAddress", { address });
      return ev.fid || undefined;
    } catch (e) {
      if (e instanceof HubError && e.status >= 400 && e.status < 500) return undefined;
      throw e;
    }
  }

  // FID -> current custody address, from the latest ID registry event for that FID.
  async custodyOf(fid: number): Promise<HexString | undefined> {
    const res = await this.request<{
      events: Array<{ blockNumber: number; logIndex: number; idRegisterEventBody?: { to: HexString; eventType: string | number } }>;
    }>("GET", "/v1/onChainEventsByFid", { fid, event_type: "EVENT_TYPE_ID_REGISTER" });
    // Only Register and Transfer events set the custody address. ChangeRecovery events
    // have an empty `to` and must be skipped.
    const evs = res.events.filter((e) => {
      const b = e.idRegisterEventBody;
      return b && /^0x[0-9a-fA-F]{40}$/.test(b.to) && ["Register", "Transfer", "ID_REGISTER_EVENT_TYPE_REGISTER", "ID_REGISTER_EVENT_TYPE_TRANSFER", 1, 2].includes(b.eventType);
    });
    evs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return evs.at(-1)?.idRegisterEventBody?.to;
  }

  // fname (e.g. "dwr") -> FID. ENS names need an Ethereum RPC on the node, so we only
  // look up plain fnames here.
  async fidByUsername(name: string): Promise<number | undefined> {
    const n = name.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(n)) return undefined;
    return this.optional(async () => (await this.request<{ fid: number }>("GET", "/v1/userNameProofByName", { name: n })).fid);
  }

  storageLimits(fid: number): Promise<StorageLimits> {
    return this.request("GET", "/v1/storageLimitsByFid", { fid });
  }

  signersByFid(fid: number, requesterFid?: number): Promise<SignersByFid> {
    return this.request("GET", "/v1/signersByFid", { fid, requesterFids: requesterFid !== undefined ? [requesterFid] : undefined });
  }

  signersByFidPage(fid: number, pageToken?: string): Promise<SignersByFid> {
    return this.request("GET", "/v1/signersByFid", { fid, pageSize: 1000, pageToken });
  }

  async signer(fid: number, key: HexString): Promise<HubSigner | undefined> {
    try {
      const res = await this.request<{ signer: HubSigner }>("GET", "/v1/signer", { fid, signer: key });
      return res.signer;
    } catch (e) {
      if (e instanceof HubError && e.status === 400 && /not ?found/i.test(e.message)) return undefined;
      throw e;
    }
  }

  // `asked` says whether a message answers this request; the verifier drops those that do not.
  private async paged(path: string, query: Query, asked: (m: HubMessage) => boolean): Promise<Paged<HubMessage>> {
    const res = await this.request<{ messages: HubMessage[]; nextPageToken?: string }>("GET", path, query);
    const items = res.messages ?? [];
    return { items: this.verifier ? await this.verifier.messages(items, asked) : items, nextPageToken: liveToken(res.nextPageToken) };
  }

  private async one(path: string, query: Query, asked: (m: HubMessage) => boolean): Promise<HubMessage | undefined> {
    const m = await this.optional(() => this.request<HubMessage>("GET", path, query));
    return m && this.verifier ? (await this.verifier.messages([m], asked))[0] : m;
  }

  castsByFid(fid: number, opts: { pageSize?: number; pageToken?: string; reverse?: boolean } = {}) {
    return this.paged("/v1/castsByFid", { fid, pageSize: opts.pageSize, pageToken: opts.pageToken, reverse: opts.reverse }, (m) => m.data.fid === fid);
  }

  castsByParentUrl(url: string, opts: { pageSize?: number; pageToken?: string; reverse?: boolean } = {}) {
    return this.paged(
      "/v1/castsByParent",
      { url, pageSize: opts.pageSize, pageToken: opts.pageToken, reverse: opts.reverse },
      (m) => m.data.castAddBody?.parentUrl === url,
    );
  }

  linksByFid(fid: number, opts: { linkType?: string; pageSize?: number; pageToken?: string } = {}) {
    return this.paged("/v1/linksByFid", { fid, link_type: opts.linkType ?? "follow", pageSize: opts.pageSize, pageToken: opts.pageToken }, (m) => m.data.fid === fid);
  }

  userDataByFid(fid: number) {
    return this.paged("/v1/userDataByFid", { fid }, (m) => m.data.fid === fid);
  }

  repliesTo(target: { fid: number; hash: HexString }, opts: { pageSize?: number; pageToken?: string } = {}) {
    return this.paged(
      "/v1/castsByParent",
      { fid: target.fid, hash: target.hash, pageSize: opts.pageSize, pageToken: opts.pageToken },
      (m) => m.data.castAddBody?.parentCastId?.fid === target.fid && m.data.castAddBody.parentCastId.hash.toLowerCase() === target.hash.toLowerCase(),
    );
  }

  likesByCast(target: { fid: number; hash: HexString }, opts: { pageSize?: number; pageToken?: string } = {}) {
    return this.paged(
      "/v1/reactionsByCast",
      { target_fid: target.fid, target_hash: target.hash, reaction_type: "Like", pageSize: opts.pageSize, pageToken: opts.pageToken },
      (m) => {
        const r = m.data.reactionBody;
        return r?.type === "REACTION_TYPE_LIKE" && r.targetCastId?.fid === target.fid && r.targetCastId.hash.toLowerCase() === target.hash.toLowerCase();
      },
    );
  }

  async castById(fid: number, hash: HexString): Promise<HubMessage | undefined> {
    return this.one("/v1/castById", { fid, hash }, (m) => m.data.fid === fid && m.hash.toLowerCase() === hash.toLowerCase());
  }

  async linkById(fid: number, targetFid: number, linkType = "follow"): Promise<HubMessage | undefined> {
    return this.one(
      "/v1/linkById",
      { fid, target_fid: targetFid, link_type: linkType },
      (m) => m.data.fid === fid && m.data.linkBody?.targetFid === targetFid && m.data.linkBody.type === linkType,
    );
  }

  async reactionById(fid: number, type: "Like" | "Recast", target: { fid: number; hash: HexString }): Promise<HubMessage | undefined> {
    return this.one(
      "/v1/reactionById",
      { fid, reaction_type: type, target_fid: target.fid, target_hash: target.hash },
      (m) => {
        const r = m.data.reactionBody;
        return m.data.fid === fid && r?.type === `REACTION_TYPE_${type.toUpperCase()}` && r.targetCastId?.fid === target.fid && r.targetCastId.hash.toLowerCase() === target.hash.toLowerCase();
      },
    );
  }

  private async optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HubError && e.status === 400) return undefined;
      throw e;
    }
  }

  // Stateless check: signature, hash and body rules. Does not check custody or storage.
  validate(msg: Message): Promise<{ valid: boolean; message?: HubMessage }> {
    return this.request("POST", "/v1/validateMessage", undefined, Message.encode(msg).finish());
  }

  // Success means "accepted for relay", not "in a block". Read it back to confirm.
  submit(msg: Message): Promise<HubMessage> {
    return this.request("POST", "/v1/submitMessage", undefined, Message.encode(msg).finish());
  }
}

// A node is usable when every shard is within a few blocks of the tip. Shard 0, the block
// shard, holds no casts, but app keys (KEY_ADD, KEY_REMOVE) and storage are checked there:
// a node whose shard 0 is behind serves feeds but rejects new keys as "unknown fid".
export function syncState(info: HubInfo): { synced: boolean; maxDelay: number } {
  const shards = info.shardInfos;
  const maxDelay = Math.max(0, ...shards.map((s) => s.blockDelay));
  return { synced: shards.some((s) => s.shardId !== 0) && maxDelay < 10, maxDelay };
}
