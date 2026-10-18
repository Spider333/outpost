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
      p = this.hub.userDataByFid(fid).then((page) => {
        const prof: Profile = { fid };
        for (const m of page.items) {
          const b = m.data.userDataBody;
          if (!b) continue;
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
    const pages = await mapLimit(fids, concurrency, (fid) =>
      this.hub.castsByFid(fid, { reverse: true, pageSize: perAuthor }).then(
        (p) => p.items,
        () => [] as HubMessage[], // one unreachable author should not sink the feed
      ),
    );
    const casts = pages
      .flat()
      .filter((m) => m.data.castAddBody && (includeReplies || !m.data.castAddBody.parentCastId))
      .sort((a, b) => b.data.timestamp - a.data.timestamp);
    return this.hydrate(casts, limit, filter, concurrency);
  }

  async following(fid: number, opts: FeedOptions = {}): Promise<FeedItem[]> {
    const fids = await followingOf(this.hub, fid, opts.maxFollowing);
    return this.fromAuthors([fid, ...fids], opts);
  }

  async channel(parentUrl: string, opts: FeedOptions = {}): Promise<FeedItem[]> {
    const { limit = 50, filter, concurrency = 24 } = opts;
    const page = await this.hub.castsByParentUrl(parentUrl, { reverse: true, pageSize: Math.min(1000, limit * 4) });
    const casts = page.items.filter((m) => m.data.castAddBody).sort((a, b) => b.data.timestamp - a.data.timestamp);
    return this.hydrate(casts, limit, filter, concurrency);
  }

  // Walks the sorted casts, resolving apps, until `limit` casts pass the filter.
  private async hydrate(casts: HubMessage[], limit: number, filter: AppFilter | undefined, concurrency: number): Promise<FeedItem[]> {
    const out: FeedItem[] = [];
    for (let i = 0; i < casts.length && out.length < limit; i += limit) {
      const batch = casts.slice(i, i + limit);
      const refs = await mapLimit(batch, concurrency, (m) => this.apps.appOf(m.data.fid, m.signer));
      batch.forEach((m, j) => {
        const ref = refs[j]!;
        if (out.length < limit && passesFilter(ref, filter)) {
          const item = toItem(m, ref);
          if (item) out.push(item);
        }
      });
    }
    const authors = await mapLimit(out, concurrency, (it) => this.profile(it.fid).catch(() => ({ fid: it.fid })));
    out.forEach((it, i) => (it.author = authors[i]));
    return out;
  }

  // Display names for app FIDs seen in a feed, for the filter toggles.
  async appNames(items: FeedItem[]): Promise<Map<number, string>> {
    const fids = [...new Set(items.flatMap((i) => (i.app.kind === "app" ? [i.app.requestFid!] : [])))];
    const profiles = await mapLimit(fids, 8, (f) => this.profile(f).catch(() => ({ fid: f }) as Profile));
    return new Map(profiles.map((p) => [p.fid, p.username ?? p.displayName ?? `fid:${p.fid}`]));
  }
}
