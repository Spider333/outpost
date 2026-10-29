// A fake node for society votes: members with keys, casts and likes, and the two key sources a
// Verifier asks. Used by votes.test.ts, and served over HTTP by votes-demo.ts for the web client.

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { encodeGaslessSignedKeyRequestMetadata, FarcasterNetwork, makeUserDataAdd, Message, UserDataType, type Message as MessageT } from "@farcaster/core";
import { bytesToHex } from "viem";
import {
  buildCast,
  buildFollow,
  buildReaction,
  signerOf,
  unwrap,
  type CastInput,
  genesisHead,
  Hub,
  proposalCast,
  publicKeyOf,
  signCharter,
  signedMessage,
  toLog,
  Verifier,
  type AppKey,
  type Change,
  type CharterBody,
  type HexString,
  type HubMessage,
  type KeyRegistry,
  type KeyScopes,
} from "../src/core/index.js";
import { privateKeyToAccount } from "viem/accounts";

// Hardhat test accounts 0 and 1: public, never hold anything.
export const FOUNDER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const OTHER_FOUNDER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const CAST = "MESSAGE_TYPE_CAST_ADD";
export const LIKE = "MESSAGE_TYPE_REACTION_ADD";
export const MEMBERS = [100, 200, 300, 400, 500];
export const BODY: CharterBody = { charter: 1, name: "Test Society", members: MEMBERS, moderators: [100], issuedAt: "2026-10-23T00:00:00.000Z" };

export async function appKey(fid: number, network = FarcasterNetwork.MAINNET): Promise<AppKey> {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { fid, privateKey: bytesToHex(priv), publicKey: bytesToHex(await publicKeyOf(priv)), requestFid: fid, scopes: [], ttl: 0, network };
}

// What a node returns for a message @farcaster/core built.
export const json = (m: MessageT): HubMessage => signedMessage(m.data!, m.hash, m.signature, m.signer);

export const add = (fid: number): Change[] => [{ op: "+", role: "member", fid }];

type Answer = { status: number; body: unknown };

export class World {
  casts: HubMessage[] = [];
  likes: HubMessage[] = [];
  links: HubMessage[] = [];
  userData: HubMessage[] = [];
  // Onchain keys added through an app's signed key request ("Approve in the Farcaster app"):
  // "fid:key" -> the app's FID, listed by signersByFid with that metadata.
  approved = new Map<string, number>();
  onchain = new Map<string, "added" | "removed">();
  gasless = new Map<string, KeyScopes>();
  keys = new Map<number, AppKey>();
  // A dishonest node may return likes on other casts too.
  lieAboutTargets = false;

  async member(fid: number, how: "gasless" | "onchain" | "cast-only" = "gasless", network?: FarcasterNetwork): Promise<AppKey> {
    const k = await appKey(fid, network);
    const id = `${fid}:${k.publicKey}`;
    if (how === "onchain") this.onchain.set(id, "added");
    else this.gasless.set(id, { onchain: false, scopes: how === "cast-only" ? [CAST] : [CAST, LIKE] });
    this.keys.set(fid, k);
    return k;
  }

  async propose(fid: number, head: HexString, changes: Change[]): Promise<HubMessage> {
    const m = json(await buildCast(this.keys.get(fid)!, proposalCast(head, changes)));
    this.casts.unshift(m); // newest first, as castsByFid with reverse=true
    return m;
  }

  async like(fid: number, p: HubMessage, key = this.keys.get(fid)!, kind: "like" | "recast" = "like"): Promise<HubMessage> {
    const m = json(await buildReaction({ ...key, fid }, kind, { fid: p.data.fid, hash: p.hash }));
    this.likes.push(m);
    return m;
  }

  // A cast by a member (a reply when input.replyTo is set), newest first like the real node.
  async cast(fid: number, input: CastInput, now?: number): Promise<HubMessage> {
    const m = json(await buildCast(this.keys.get(fid)!, input, now));
    this.casts.unshift(m);
    return m;
  }

  async follow(fid: number, target: number, now?: number): Promise<HubMessage> {
    const m = json(await buildFollow(this.keys.get(fid)!, target, now));
    this.links.push(m);
    return m;
  }

  // The member's username, signed with their key, as userDataByFid returns it.
  async name(fid: number, username: string): Promise<void> {
    const k = this.keys.get(fid)!;
    const m = unwrap(await makeUserDataAdd({ type: UserDataType.USERNAME, value: username }, { fid, network: k.network, timestamp: Math.floor((Date.now() - 1609459200000) / 1000) }, signerOf(k)));
    this.userData.push(json(m));
  }

  verifier(): Verifier {
    const chain: KeyRegistry = { keyState: async (fid, key) => this.onchain.get(`${fid}:${key}`) ?? "none" };
    const second = {
      listsKey: async (fid: number, key: HexString) => this.gasless.has(`${fid}:${key}`),
      keyScopes: async (fid: number, key: HexString) => this.gasless.get(`${fid}:${key}`),
    };
    return new Verifier(chain, second);
  }

  // Takes a submitted like, unlike or cast, as a node would after checking it.
  private submit(bytes: Uint8Array): Answer {
    const m = json(Message.decode(bytes));
    const r = m.data.reactionBody;
    if (m.data.type === "MESSAGE_TYPE_REACTION_ADD") this.likes.push(m);
    else if (m.data.type === "MESSAGE_TYPE_REACTION_REMOVE") this.likes = this.likes.filter((l) => !(l.data.fid === m.data.fid && l.data.reactionBody?.targetCastId?.hash === r?.targetCastId?.hash));
    else if (m.data.type === "MESSAGE_TYPE_CAST_ADD") this.casts.unshift(m);
    else if (m.data.type === "MESSAGE_TYPE_LINK_ADD") this.links.push(m);
    return { status: 200, body: m };
  }

  // An onchain key requested by `requestFid`, as the KeyGateway adds it after an approval.
  approve(fid: number, key: HexString, requestFid: number) {
    this.approved.set(`${fid}:${key.toLowerCase()}`, requestFid);
    this.onchain.set(`${fid}:${key.toLowerCase()}`, "added");
  }

  private signers(fid: number) {
    const gasless = [...this.gasless].filter(([id]) => id.startsWith(`${fid}:`)).map(([id, s]) => ({ source: "SIGNER_SOURCE_OFFCHAIN", key: id.split(":")[1], keyType: 1, fid, requestFid: fid, scopes: s.scopes }));
    const onchain = [...this.approved].filter(([id]) => id.startsWith(`${fid}:`)).map(([id, requestFid]) => {
      const metadata = encodeGaslessSignedKeyRequestMetadata({ requestFid: BigInt(requestFid), requestSigner: "0x00000000000000000000000000000000000000aa", signature: new Uint8Array(65), deadline: 1n })._unsafeUnwrap();
      const key = id.split(":")[1] as HexString;
      return { source: "SIGNER_SOURCE_ONCHAIN", key, keyType: 1, fid, requestFid, onChainEvent: { fid, signerEventBody: { key, eventType: "SIGNER_EVENT_TYPE_ADD", metadata: Buffer.from(metadata).toString("base64"), metadataType: 1 } } };
    });
    return [...gasless, ...onchain];
  }

  // The node's answers. signersByFid lists the gasless keys, as a second node would.
  answer(path: string, q: URLSearchParams, body?: Uint8Array): Answer {
    const messages = (ms: HubMessage[]) => ({ status: 200, body: { messages: ms, nextPageToken: "" } });
    const one = (m?: HubMessage) => (m ? { status: 200, body: m } : { status: 400, body: { error: "not found" } });
    const fid = Number(q.get("fid"));
    const hash = (q.get("hash") ?? q.get("target_hash") ?? "").toLowerCase();
    switch (path) {
      case "/v1/submitMessage":
        return this.submit(body!);
      case "/v1/info":
        return { status: 200, body: { version: "fake", numShards: 1, shardInfos: [{ shardId: 1, maxHeight: 1, numMessages: 0, blockDelay: 0 }] } };
      case "/v1/castsByFid":
        return messages(this.casts.filter((m) => m.data.fid === fid));
      case "/v1/castById":
        return one(this.casts.find((m) => m.data.fid === fid && m.hash === hash));
      case "/v1/reactionsByCast": {
        const type = `REACTION_TYPE_${(q.get("reaction_type") ?? "Like").toUpperCase()}`;
        return messages(this.lieAboutTargets ? this.likes : this.likes.filter((m) => m.data.reactionBody?.type === type && m.data.reactionBody.targetCastId?.hash.toLowerCase() === hash));
      }
      case "/v1/castsByMention":
        return messages(this.casts.filter((m) => m.data.castAddBody?.mentions.includes(fid)));
      case "/v1/linksByTargetFid":
        return messages(this.links.filter((m) => m.data.linkBody?.targetFid === Number(q.get("target_fid"))));
      case "/v1/userNameProofByName": {
        const u = this.userData.find((m) => m.data.userDataBody?.value === q.get("name"));
        return u ? { status: 200, body: { fid: u.data.fid } } : { status: 400, body: { error: "not found" } };
      }
      case "/v1/reactionById": {
        const type = `REACTION_TYPE_${(q.get("reaction_type") ?? "").toUpperCase()}`;
        return one(this.likes.find((m) => m.data.fid === fid && m.data.reactionBody?.type === type && m.data.reactionBody.targetCastId?.hash === hash));
      }
      case "/v1/castsByParent":
        return messages(this.casts.filter((m) => m.data.castAddBody?.parentCastId?.hash === hash));
      case "/v1/linksByFid":
        return messages(this.links.filter((m) => m.data.fid === fid));
      case "/v1/userDataByFid":
        return messages(this.userData.filter((m) => m.data.fid === fid));
      case "/v1/signersByFid": {
        const signers = this.signers(fid);
        return { status: 200, body: { signers, gaslessSignerCount: signers.length, gaslessSignerLimit: 1000, currentUserNonce: 0 } };
      }
      case "/v1/signer": {
        const s = this.signers(fid).find((x) => x.key === q.get("signer"));
        return s ? { status: 200, body: { signer: s } } : { status: 400, body: { error: "signer not found" } };
      }
      case "/v1/onChainEventsByFid":
        return { status: 200, body: { events: [{ blockNumber: 1, logIndex: 0, idRegisterEventBody: { to: FOUNDER.address, eventType: "Register" } }] } };
      default:
        return { status: 400, body: { error: "not found" } };
    }
  }

  hub(): Hub {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const r = this.answer(url.pathname, url.searchParams);
      return new Response(JSON.stringify(r.body), { status: r.status });
    };
    return new Hub({ url: "http://node.test", fetch: fetchImpl as typeof fetch, verifier: this.verifier() });
  }

  // Over HTTP, open to any page (as Farcaster's public node is), plus JSON files at fixed paths,
  // and a built web client from `web` for every other path outside /v1/.
  async serve(port = 0, files: Record<string, unknown> = {}, web?: string): Promise<{ url: string; close: () => void }> {
    const server = createServer(this.handler(files, web));
    await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
  }

  handler(files: Record<string, unknown> = {}, web?: string): (req: IncomingMessage, res: ServerResponse) => void {
    const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
    return (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://x");
        if (web && !url.pathname.startsWith("/v1/") && !(url.pathname in files)) {
          const file = join(web, url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
          if (!file.startsWith(web) || !existsSync(file)) return void res.writeHead(404).end();
          return void res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
        }
        const r = url.pathname in files ? { status: 200, body: files[url.pathname] } : this.answer(url.pathname, url.searchParams, Buffer.concat(chunks));
        res.writeHead(r.status, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify(r.body));
      });
    };
  }
}

export async function society(how: Partial<Record<number, "gasless" | "onchain" | "cast-only">> = {}, body = BODY) {
  const w = new World();
  for (const f of MEMBERS) await w.member(f, how[f] ?? "gasless");
  const log = toLog(await signCharter(body, FOUNDER));
  return { w, log, head0: genesisHead(log.genesis) };
}
