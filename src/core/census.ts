// Census: numbers about a society, computed only from your own node, so anyone who runs a
// node and loads the same charter gets the same numbers (give or take casts that arrive
// while it runs). Counts every cast a member posted in the window, replies included.
// Storage limits apply: the network keeps only the newest casts of an account that is over
// its storage, so very old casts may be gone.

import { AppResolver, type AppRef } from "./apps.js";
import type { CharterBody } from "./charter.js";
import { FARCASTER_EPOCH_MS, mapLimit } from "./feed.js";
import { Hub, type HubMessage } from "./hub.js";

export interface MemberStats {
  fid: number;
  casts: number; // in the window
  lastCast?: number; // Unix ms of their newest cast, any age
}

export interface Census {
  members: number;
  active: number; // members with at least one cast in the window
  casts: number;
  castsPerDay: number;
  days: number;
  apps: Array<{ app: AppRef; casts: number }>;
  perMember: MemberStats[];
  from: number; // Unix ms
  to: number;
}

export function appKey(a: AppRef): string {
  return a.kind === "app" ? `app:${a.requestFid}` : a.kind;
}

export async function census(hub: Hub, c: CharterBody, opts: { days?: number; now?: number; concurrency?: number } = {}): Promise<Census> {
  const days = opts.days ?? 7;
  const to = opts.now ?? Date.now();
  const from = to - days * 86_400_000;
  const cutoff = Math.floor((from - FARCASTER_EPOCH_MS) / 1000); // Farcaster seconds
  const apps = new AppResolver(hub);
  const members = [...new Set(c.members)];

  const per = await mapLimit(members, opts.concurrency ?? 16, async (fid) => {
    const recent: HubMessage[] = [];
    let lastCast: number | undefined;
    let pageToken: string | undefined;
    for (;;) {
      const page = await hub.castsByFid(fid, { reverse: true, pageSize: 100, pageToken });
      for (const m of page.items) {
        const t = FARCASTER_EPOCH_MS + m.data.timestamp * 1000;
        // Mainnet has a few old casts dated decades ahead; they are not "recent".
        if (!m.data.castAddBody || t > to) continue;
        lastCast ??= t;
        if (m.data.timestamp >= cutoff) recent.push(m);
      }
      const oldest = page.items.at(-1)?.data.timestamp;
      if (!page.nextPageToken || oldest === undefined || oldest < cutoff) break;
      pageToken = page.nextPageToken;
    }
    const refs = (await mapLimit(recent, 8, (m) => apps.appOf(fid, m.signer))).filter((r) => {
      if (r.keyCheck !== "false") return true;
      hub.verifier?.drop("signer"); // signed by a key that is provably not the member's: not counted
      return false;
    });
    return { stats: { fid, casts: refs.length, lastCast }, refs };
  });

  const mix = new Map<string, { app: AppRef; casts: number }>();
  for (const { refs } of per) {
    for (const r of refs) {
      const k = appKey(r);
      const e = mix.get(k) ?? { app: r, casts: 0 };
      e.casts++;
      mix.set(k, e);
    }
  }
  const perMember = per.map((p) => p.stats);
  const casts = perMember.reduce((n, m) => n + m.casts, 0);
  return {
    members: members.length,
    active: perMember.filter((m) => m.casts > 0).length,
    casts,
    castsPerDay: Math.round((casts / days) * 10) / 10,
    days,
    apps: [...mix.values()].sort((a, b) => b.casts - a.casts),
    perMember,
    from,
    to,
  };
}
