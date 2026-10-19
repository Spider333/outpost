// ./outpost cli charter <new|sign|verify|census|feed|join> ...

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  census,
  charterFeed,
  checkShape,
  CUSTODY_PATH,
  FeedBuilder,
  follow,
  followingOf,
  Hub,
  signCharter,
  verifyCharter,
  type AppKey,
  type Optimism,
  type Charter,
  type CharterBody,
  type Census,
} from "../core/index.js";
import { askHidden } from "./prompt.js";

async function load(src: string | undefined): Promise<unknown> {
  if (!src) throw new Error("give a charter file or URL");
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`could not fetch ${src}: HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(src, "utf8"));
}

async function loadVerified(hub: Hub, src: string | undefined, chain?: Optimism): Promise<Charter> {
  const c = await load(src);
  const v = await verifyCharter(c, hub, chain);
  if (!v.ok) throw new Error(`charter rejected: ${v.problems.join("; ")}`);
  return c as Charter;
}

function describeVerification(c: Charter, v: Awaited<ReturnType<typeof verifyCharter>>, chain?: Optimism): string {
  if (!v.ok) return `REJECTED: ${v.problems.join("; ")}`;
  const who =
    v.issuerCheck === "custody"
      ? `signed by the custody address of FID ${c.issuer!.fid} (${v.signer}), checked ${chain ? `on Optimism via ${chain.url}` : "on your node"}`
      : v.issuerCheck === "no-issuer"
        ? `signed by ${v.signer}. It names no issuer FID, so only the address vouches for it`
        : `signed by ${v.signer}`;
  return `OK: "${c.name}", ${c.members.length} members, ${who}${c.nodes?.length ? `\nsociety nodes: ${c.nodes.join(", ")}` : ""}`;
}

// One line on what verification dropped, for commands that read messages.
export function verificationNote(hub: Hub): string {
  const v = hub.verifier;
  if (!v?.checked) return "";
  return v.failed ? `warning: ${v.summary()}` : `all ${v.checked} messages from the node passed verification`;
}

export function printCensus(c: Census, names: Map<number, string>) {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  console.log(`census ${day(c.from)} to ${day(c.to)} (${c.days} days), from your node`);
  console.log(`  members            ${c.members}`);
  console.log(`  active (posted)    ${c.active}`);
  console.log(`  casts              ${c.casts}  (${c.castsPerDay} per day)`);
  console.log("  apps members posted from:");
  for (const a of c.apps) {
    const label = a.app.kind === "app" ? `${names.get(a.app.requestFid!) ?? "fid " + a.app.requestFid} (app fid ${a.app.requestFid})` : a.app.kind === "self" ? "own key" : "unknown key";
    console.log(`    ${String(a.casts).padStart(5)}  ${label}`);
  }
}

export async function cmdCharter(hub: Hub, args: string[], key: () => AppKey, chain?: Optimism) {
  const [sub, a, b] = args;
  switch (sub) {
    case "new": {
      if (!a) throw new Error("usage: charter new <file>");
      if (existsSync(a)) throw new Error(`${a} exists; not overwriting`);
      const body: CharterBody = {
        charter: 1,
        name: "My Society",
        description: "One or two sentences on what this society is for.",
        codeOfConduct: "https://example.org/code-of-conduct",
        members: [],
        moderators: [],
        clients: { include: [], exclude: [] },
        feed: { channels: [], keywords: [], excludeKeywords: [] },
        issuedAt: new Date().toISOString(),
      };
      writeFileSync(a, JSON.stringify(body, null, 2) + "\n");
      console.log(`wrote ${a}. Edit it, then: ./outpost cli charter sign ${a} ${a.replace(/\.json$/, "")}.signed.json`);
      return;
    }
    case "sign": {
      if (!a || !b) throw new Error("usage: charter sign <unsigned.json> <signed.json>");
      const body = (await load(a)) as CharterBody & { signature?: unknown };
      delete body.signature;
      body.issuedAt = new Date().toISOString();
      const problems = checkShape(body);
      if (problems.length) throw new Error(problems.join("; "));
      // The society's key. Ideally the custody key of the issuer FID, so readers can check it.
      const hex = process.env.CHARTER_PRIVATE_KEY;
      const account = hex
        ? privateKeyToAccount(hex as `0x${string}`)
        : mnemonicToAccount((await askHidden("Recovery phrase of the society's account (input hidden): ")).trim().toLowerCase().split(/\s+/).join(" "), { path: CUSTODY_PATH });
      const signed = await signCharter(body, account);
      writeFileSync(b, JSON.stringify(signed, null, 2) + "\n");
      console.log(`signed by ${account.address}. Wrote ${b}.`);
      const v = await verifyCharter(signed, hub, chain);
      console.log(describeVerification(signed, v, chain));
      if (!v.ok) process.exitCode = 1;
      return;
    }
    case "verify": {
      const c = (await load(a)) as Charter;
      const v = await verifyCharter(c, hub, chain);
      console.log(describeVerification(c, v, chain));
      if (!v.ok) process.exitCode = 1;
      return;
    }
    case "census": {
      const c = await loadVerified(hub, a, chain);
      const days = b ? Number(b) : 7;
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("days must be 1 to 90");
      const t0 = Date.now();
      const result = await census(hub, c, { days });
      const feed = new FeedBuilder(hub);
      const appFids = result.apps.flatMap((x) => (x.app.kind === "app" ? [x.app.requestFid!] : []));
      const names = new Map((await Promise.all(appFids.map((f) => feed.profile(f).catch(() => ({ fid: f }))))).map((p) => [p.fid, ("username" in p && p.username) || `fid ${p.fid}`]));
      console.log(`"${c.name}"`);
      printCensus(result, names);
      console.log(`computed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      console.log(verificationNote(hub));
      return;
    }
    case "feed": {
      const c = await loadVerified(hub, a, chain);
      const limit = b ? Number(b) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be 1 to 500");
      const items = await charterFeed(new FeedBuilder(hub), c, { limit });
      console.log(`"${c.name}" feed, ${items.length} casts, through its lens:`);
      for (const it of items) {
        console.log(`${new Date(it.time).toISOString().slice(0, 16).replace("T", " ")}  ${it.author?.username ? "@" + it.author.username : "fid:" + it.fid}`);
        console.log(`  ${it.text.replace(/\s+/g, " ").slice(0, 200)}`);
      }
      console.log(verificationNote(hub));
      return;
    }
    case "join": {
      const c = await loadVerified(hub, a, chain);
      const k = key();
      const already = new Set(await followingOf(hub, k.fid));
      const todo = c.members.filter((m) => m !== k.fid && !already.has(m));
      console.log(`"${c.name}": following ${todo.length} members you do not follow yet (${c.members.length - todo.length} already followed or you).`);
      let confirmed = 0;
      for (const m of todo) {
        const r = await follow(hub, k, m, { timeoutMs: 15_000 });
        if (r.confirmed) confirmed++;
        console.log(`  follow ${m}: ${r.confirmed ? "confirmed" : "accepted, not seen yet"}`);
      }
      console.log(`done: ${confirmed}/${todo.length} confirmed. To leave, stop using the charter; your follows stay yours.`);
      return;
    }
    default:
      throw new Error("usage: charter <new|sign|verify|census|feed|join> ...");
  }
}
