// Feeds built from raw node data. Snapchain has no "home timeline" endpoint:
// a following feed is the accounts you follow (linksByFid), the latest casts of each
// (castsByFid), merged by time. Then each cast is traced to the app that posted it.

import { AppResolver, passesFilter, type AppFilter, type AppRef } from "./apps.js";
import { Hub, type HexString, type HubMessage } from "./hub.js";

export const FARCASTER_EPOCH_MS = 1609459200000;

export interface Profile {
  fid: number;
  username?: string;
  displayName?: string;
  pfp?: string;
  bio?: string;
}

export interface FeedItem {
  fid: number;
  hash: HexString;
  signer: HexString;
  time: number; // Unix ms
  text: string;
  embeds: string[];
  parent?: { fid: number; hash: string } | { url: string };
  app: AppRef;
  author?: Profile;
}

// Nodes keep a few old casts dated far in the future (e.g. 2061 on mainnet). Left in, they
// would sit at the top of every feed. Allow ten minutes of clock skew, as hubs do.
const MAX_SKEW_MS = 10 * 60_000;
export function notFuture(m: HubMessage, now = Date.now()): boolean {
  return FARCASTER_EPOCH_MS + m.data.timestamp * 1000 <= now + MAX_SKEW_MS;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// Mentions are not part of a cast's text: the node stores the mentioned FIDs and the UTF-8
// byte offsets where each one goes. This puts "@name" back at those offsets.
export function withMentions(text: string, mentions: number[], positions: number[], name: (fid: number) => string): string {
  if (!mentions.length) return text;
  const bytes = new TextEncoder().encode(text);
  const dec = new TextDecoder();
  let out = "";
  let at = 0;
  mentions.forEach((fid, i) => {
    const p = Math.min(Math.max(positions[i] ?? at, at), bytes.length);
    out += `${dec.decode(bytes.slice(at, p))}@${name(fid)}`;
    at = p;
  });
  return out + dec.decode(bytes.slice(at));
}

export function toItem(m: HubMessage, app: AppRef): FeedItem | undefined {
  const body = m.data.castAddBody;
  if (!body) return undefined;
  const embeds = body.embeds.flatMap((e) => ("url" in e ? [e.url] : []));
  const parent = body.parentCastId ? { fid: body.parentCastId.fid, hash: body.parentCastId.hash } : body.parentUrl ? { url: body.parentUrl } : undefined;
  return {
    fid: m.data.fid,
    hash: m.hash,
    signer: m.signer,
    time: FARCASTER_EPOCH_MS + m.data.timestamp * 1000,
    text: body.text,
    embeds,
    parent,
    app,
  };
}

export async function followingOf(hub: Hub, fid: number, max = 2000): Promise<number[]> {
  const fids: number[] = [];
  let pageToken: string | undefined;
  do {
    const page = await hub.linksByFid(fid, { pageSize: 1000, pageToken });
    for (const m of page.items) {
      const t = m.data.linkBody?.targetFid;
      if (t && m.data.linkBody?.type === "follow") fids.push(t);
    }
    pageToken = page.nextPageToken;
  } while (pageToken && fids.length < max);
  return [...new Set(fids)].slice(0, max);
}

export interface FeedOptions {
  limit?: number; // casts returned (default 50)
  perAuthor?: number; // latest casts fetched per account (default 5)
  includeReplies?: boolean; // default false: top-level casts and channel posts only
  filter?: AppFilter;
  concurrency?: number;
  maxFollowing?: number;
}

export class FeedBuilder {
  readonly apps: AppResolver;
  private profiles = new Map<number, Promise<Profile>>();

  constructor(readonly hub: Hub) {
    this.apps = new AppResolver(hub);
  }

  profile(fid: number): Promise<Profile> {
    let p = this.profiles.get(fid);
    if (!p) {
      p = this.hub.userDataByFid(fid).then(async (page) => {
        const prof: Profile = { fid };
        for (const m of page.items) {
          const b = m.data.userDataBody;
          if (!b) continue;
          // A name or picture set with a key that is not theirs, or that could not be checked.
          if (this.hub.verifier && !this.hub.verifier.admits((await this.apps.appOf(fid, m.signer)).keyCheck)) continue;
          if (b.type === "USER_DATA_TYPE_USERNAME") prof.username = b.value;
          else if (b.type === "USER_DATA_TYPE_DISPLAY") prof.displayName = b.value;
          else if (b.type === "USER_DATA_TYPE_PFP") prof.pfp = b.value;
          else if (b.type === "USER_DATA_TYPE_BIO") prof.bio = b.value;
        }
        return prof;
      });
      p.catch(() => this.profiles.delete(fid));
      this.profiles.set(fid, p);
    }
    return p;
  }

  // Latest casts from a set of authors, merged newest first, traced to apps, filtered.
  async fromAuthors(fids: number[], opts: FeedOptions = {}): Promise<FeedItem[]> {
    const { limit = 50, perAuthor = 5, includeReplies = false, filter, concurrency = 24 } = opts;
    // Without replies, read further back: many accounts mostly reply, and their last few
    // messages may hold no top-level cast at all.
    const pageSize = includeReplies ? perAuthor : Math.min(100, perAuthor * 10);
    const pages = await mapLimit(fids, concurrency, (fid) =>
      this.hub.castsByFid(fid, { reverse: true, pageSize }).then(
        (p) =>
          p.items
            .filter((m) => m.data.castAddBody && notFuture(m) && (includeReplies || !m.data.castAddBody.parentCastId))
            .slice(0, perAuthor),
        () => [] as HubMessage[], // one unreachable author should not sink the feed
      ),
    );
    const casts = pages.flat().sort((a, b) => b.data.timestamp - a.data.timestamp);
    return this.hydrate(casts, limit, filter, concurrency);
  }

  async following(fid: number, opts: FeedOptions = {}): Promise<FeedItem[]> {
    const fids = await followingOf(this.hub, fid, opts.maxFollowing);
    return this.fromAuthors([fid, ...fids], opts);
  }

  async channel(parentUrl: string, opts: FeedOptions = {}): Promise<FeedItem[]> {
    const { limit = 50, filter, concurrency = 24 } = opts;
    const page = await this.hub.castsByParentUrl(parentUrl, { reverse: true, pageSize: Math.min(1000, limit * 4) });
    const casts = page.items.filter((m) => m.data.castAddBody && notFuture(m)).sort((a, b) => b.data.timestamp - a.data.timestamp);
    return this.hydrate(casts, limit, filter, concurrency);
  }

  // Walks the sorted casts, resolving apps, until `limit` casts pass the filter.
  private async hydrate(casts: HubMessage[], limit: number, filter: AppFilter | undefined, concurrency: number): Promise<FeedItem[]> {
    const out: FeedItem[] = [];
    const msgs: HubMessage[] = [];
    for (let i = 0; i < casts.length && out.length < limit; i += limit) {
      const batch = casts.slice(i, i + limit);
      const refs = await mapLimit(batch, concurrency, (m) => this.apps.appOf(m.data.fid, m.signer));
      batch.forEach((m, j) => {
        const ref = refs[j]!;
        if (out.length < limit && passesFilter(ref, filter)) {
          // A forged key is never shown; an unchecked one only when the member asked (verify.ts).
          if (this.hub.verifier && !this.hub.verifier.admits(ref.keyCheck)) return;
          const item = toItem(m, ref);
          if (item) {
            out.push(item);
            msgs.push(m);
          }
        }
      });
    }
    const authors = await mapLimit(out, concurrency, (it) => this.profile(it.fid).catch(() => ({ fid: it.fid })));
    out.forEach((it, i) => (it.author = authors[i]));
    const mentioned = [...new Set(msgs.flatMap((m) => m.data.castAddBody?.mentions ?? []))];
    const names = new Map(
      await mapLimit(mentioned, concurrency, async (f) => {
        const p = await this.profile(f).catch(() => ({ fid: f }) as Profile);
        return [f, p.username ?? `fid:${f}`] as const;
      }),
    );
    out.forEach((it, i) => {
      const b = msgs[i]!.data.castAddBody!;
      it.text = withMentions(it.text, b.mentions ?? [], b.mentionsPositions ?? [], (f) => names.get(f) ?? `fid:${f}`);
    });
    return out;
  }

  // Display names for app FIDs seen in a feed, for the filter toggles.
  async appNames(items: FeedItem[]): Promise<Map<number, string>> {
    const fids = [...new Set(items.flatMap((i) => (i.app.kind === "app" ? [i.app.requestFid!] : [])))];
    const profiles = await mapLimit(fids, 8, (f) => this.profile(f).catch(() => ({ fid: f }) as Profile));
    // Only apps with a name; callers fall back to showing the app's FID.
    return new Map(profiles.flatMap((p) => (p.username || p.displayName ? [[p.fid, (p.username ?? p.displayName)!] as const] : [])));
  }
}
