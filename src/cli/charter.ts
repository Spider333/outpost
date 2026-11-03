// ./outpost cli charter <new|sign|verify|census|feed|join|proposals|propose|announce|import> ...

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  advance,
  announce,
  census,
  charterFeed,
  checkShape,
  compareLogs,
  CUSTODY_PATH,
  FeedBuilder,
  follow,
  followingOf,
  Hub,
  needed,
  propose,
  PROPOSAL_DAYS,
  replay,
  short,
  signCharter,
  toLog,
  verifyCharter,
  type AppKey,
  type Change,
  type Optimism,
  type Charter,
  type CharterBody,
  type CharterLog,
  type Census,
  type Tally,
  type Version,
} from "../core/index.js";
import { askHidden, printable } from "./prompt.js";
import { savedApprovals } from "./store.js";

async function load(src: string | undefined): Promise<unknown> {
  if (!src) throw new Error("give a charter file or URL");
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`could not fetch ${src}: HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(src, "utf8"));
}

// A version whose majority rests on approvals that cannot be checked now (a key revoked since, or
// one no node lists, as a made-up key would be) is only used when the member says so.
function refuseUnrecountable(versions: Version[], trust = false) {
  const weak = versions.flatMap((ver, i) => (ver.amendment && !ver.amendment.recountable ? [i] : []));
  if (!weak.length || trust) return;
  printVersions(versions);
  throw new Error(
    `version(s) ${weak.join(", ")} cannot be recounted from scratch: their majority rests on approvals whose keys cannot be checked now (revoked since, or not listed by your second node). If you trust whoever gave you this log, run again with --trust-unrecountable`,
  );
}

// A charter or charter log, checked: the founder's signature, then every amendment, with keys
// checked afresh on Optimism and the second node.
async function loadSociety(hub: Hub, src: string | undefined, chain?: Optimism, trust = false): Promise<{ log: CharterLog; versions: Version[]; body: CharterBody }> {
  const log = toLog(await load(src));
  const v = await verifyCharter(log.genesis, hub, chain);
  if (!v.ok) throw new Error(`charter rejected: ${v.problems.join("; ")}`);
  const r = await replay(log, hub.verifier!);
  if (r.problems.length) throw new Error(`charter log rejected: ${r.problems.join("; ")}`);
  refuseUnrecountable(r.versions, trust);
  return { log, versions: r.versions, body: r.versions.at(-1)!.body };
}

// Proposals and imports write the log back, so it must be a file this member keeps.
function logFile(src: string | undefined, usage: string): string {
  if (!src || /^https?:\/\//.test(src)) throw new Error(`usage: ${usage}. The log is a file you keep: passed amendments are added to it`);
  return src;
}

function save(file: string, log: CharterLog) {
  writeFileSync(file, JSON.stringify(log, null, 2) + "\n");
}

function describeVerification(c: Charter, v: Awaited<ReturnType<typeof verifyCharter>>, chain?: Optimism): string {
  if (!v.ok) return `REJECTED: ${printable(v.problems.join("; "))}`;
  const who =
    v.issuerCheck === "custody"
      ? `signed by the custody address of FID ${c.issuer!.fid} (${v.signer}), checked ${chain ? `on Optimism via ${chain.url}` : "on your node"}`
      : v.issuerCheck === "no-issuer"
        ? `signed by ${v.signer}. It names no issuer FID, so only the address vouches for it`
        : `signed by ${v.signer}`;
  return `OK: "${printable(c.name)}", ${c.members.length} members, ${who}${c.nodes?.length ? `\nsociety nodes: ${printable(c.nodes.join(", "))}` : ""}`;
}

const changeList = (cs: Change[]) => cs.map((c) => `${c.op} ${c.role} ${c.fid}`).join(", ");

function printVersions(versions: Version[]) {
  for (const [i, ver] of versions.entries()) {
    const a = ver.amendment;
    if (!a) {
      console.log(`  v0  ${ver.head}  the founder's charter, ${ver.body.members.length} members`);
      continue;
    }
    const n = a.approvers.length + a.unchecked.length;
    let line = `  v${i}  ${ver.head}  ${changeList(a.proposal.changes)}, proposed by FID ${a.proposal.id.fid}, approved by ${n} of ${a.members} (needed ${a.needed})`;
    if (a.unchecked.length) {
      line += `\n       ${a.unchecked.length} approval(s) accepted earlier cannot be re-checked now (key revoked or no longer listed): FID ${a.unchecked.join(", ")}`;
      if (!a.recountable) line += "\n       NOT RECOUNTABLE FROM SCRATCH: the majority rests on those approvals";
    }
    console.log(printable(line));
  }
}

function printTally(t: Tally) {
  const p = t.proposal;
  console.log(printable(`  ${p.id.hash} by FID ${p.id.fid}: ${changeList(p.changes)}`));
  console.log(printable(`    ${t.approvers.length} of ${t.members} approved, passes at ${t.needed}${t.approvers.length ? `. Approved by FID ${t.approvers.join(", ")}` : ""}`));
  console.log(`    approve: like it in any Farcaster app, or ./outpost cli like ${p.id.fid} ${p.id.hash}`);
}

// "--add dwr --add 3 --remove-mod 100" -> changes, usernames looked up on your node.
async function changesFrom(hub: Hub, o: CharterOptions): Promise<Change[]> {
  const fidOf = async (s: string) => {
    if (/^\d+$/.test(s)) return Number(s);
    const fid = await hub.fidByUsername(s);
    if (!fid) throw new Error(`no FID found for "${s}". Plain usernames or FIDs only`);
    return fid;
  };
  const out: Change[] = [];
  const kinds: Array<[keyof CharterOptions, Change["op"], Change["role"]]> = [
    ["add", "+", "member"],
    ["remove", "-", "member"],
    ["add-mod", "+", "moderator"],
    ["remove-mod", "-", "moderator"],
  ];
  for (const [opt, op, role] of kinds) for (const s of (o[opt] as string[] | undefined) ?? []) out.push({ op, role, fid: await fidOf(s) });
  if (!out.length) throw new Error("say what to change: --add, --remove, --add-mod or --remove-mod, each with a username or FID");
  return out;
}

// One line on what verification dropped, for commands that read messages.
export function verificationNote(hub: Hub): string {
  const v = hub.verifier;
  if (!v?.checked) return "";
  // Through the tunnel the node is on 127.0.0.1; anything else (--public, a society node) is not yours.
  const node = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(hub.url) ? "Your node" : `The node ${hub.url}`;
  if (!v.failed && !v.unverified) return v.summary(node);
  return `warning: ${v.summary(node)}${v.unverified && !v.showUnverified ? " Run again with --show-unverified to see them, marked." : ""}`;
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
    console.log(printable(`    ${String(a.casts).padStart(5)}  ${label}`));
  }
}

export interface CharterOptions {
  add?: string[];
  remove?: string[];
  "add-mod"?: string[];
  "remove-mod"?: string[];
  "trust-unrecountable"?: boolean;
}

export async function cmdCharter(hub: Hub, args: string[], key: () => AppKey, chain?: Optimism, opts: CharterOptions = {}) {
  const [sub, a, b] = args;
  const trust = !!opts["trust-unrecountable"];
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
      const log = toLog(await load(a));
      const v = await verifyCharter(log.genesis, hub, chain);
      console.log(describeVerification(log.genesis, v, chain));
      if (!v.ok || !log.amendments.length) {
        if (!v.ok) process.exitCode = 1;
        return;
      }
      const r = await replay(log, hub.verifier!);
      console.log(`recount from your node: ${r.versions.length - 1} of ${log.amendments.length} amendments check out`);
      printVersions(r.versions);
      if (r.problems.length) {
        console.log(printable(`REJECTED at ${r.problems.join("; ")}`));
        process.exitCode = 1;
      } else if (r.versions.some((ver) => ver.amendment && !ver.amendment.recountable)) {
        process.exitCode = 1; // listed above as NOT RECOUNTABLE FROM SCRATCH
      }
      console.log(verificationNote(hub));
      return;
    }
    case "census": {
      const s = await loadSociety(hub, a, chain, trust);
      const days = b ? Number(b) : 7;
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("days must be 1 to 90");
      const t0 = Date.now();
      const result = await census(hub, s.body, { days });
      const feed = new FeedBuilder(hub);
      const appFids = result.apps.flatMap((x) => (x.app.kind === "app" ? [x.app.requestFid!] : []));
      const names = new Map((await Promise.all(appFids.map((f) => feed.profile(f).catch(() => ({ fid: f }))))).map((p) => [p.fid, ("username" in p && p.username) || `fid ${p.fid}`]));
      console.log(printable(`"${s.body.name}"`));
      printCensus(result, names);
      console.log(`computed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      console.log(verificationNote(hub));
      return;
    }
    case "feed": {
      const s = await loadSociety(hub, a, chain, trust);
      const limit = b ? Number(b) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be 1 to 500");
      const items = await charterFeed(new FeedBuilder(hub), s.body, { limit });
      console.log(printable(`"${s.body.name}" feed, ${items.length} casts, through its lens:`));
      for (const it of items) {
        console.log(printable(`${new Date(it.time).toISOString().slice(0, 16).replace("T", " ")}  ${it.author?.username ? "@" + it.author.username : "fid:" + it.fid}`));
        console.log(`  ${printable(it.text.replace(/\s+/g, " ")).slice(0, 200)}`);
      }
      console.log(verificationNote(hub));
      return;
    }
    case "join": {
      const s = await loadSociety(hub, a, chain, trust);
      const k = key();
      const already = new Set(await followingOf(hub, k.fid));
      const todo = s.body.members.filter((m) => m !== k.fid && !already.has(m));
      console.log(printable(`"${s.body.name}": following ${todo.length} members you do not follow yet (${s.body.members.length - todo.length} already followed or you).`));
      let confirmed = 0;
      for (const m of todo) {
        const r = await follow(hub, k, m, { timeoutMs: 15_000 });
        if (r.confirmed) confirmed++;
        console.log(`  follow ${m}: ${r.confirmed ? "confirmed" : "accepted, not seen yet"}`);
      }
      console.log(`done: ${confirmed}/${todo.length} confirmed. To leave, stop using the charter; your follows stay yours.`);
      return;
    }
    case "proposals": {
      const file = logFile(a, "charter proposals <log file> [days]");
      const days = b ? Number(b) : PROPOSAL_DAYS;
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("days must be 1 to 90");
      const s = await loadSociety(hub, file, chain, trust);
      const st = await advance(hub, s.log, { cache: savedApprovals(), days });
      for (const t of st.passed) console.log(printable(`PASSED: ${changeList(t.proposal.changes)} (${t.approvers.length} of ${t.members} members). Announce it with: ./outpost cli charter announce ${file}`));
      if (st.passed.length) {
        save(file, st.log);
        console.log(`added ${st.passed.length} amendment(s) to ${file}`);
      }
      console.log(printable(`"${s.body.name}" is at version ${st.log.amendments.length}, head ${st.head}, ${st.body.members.length} members.`));
      if (st.conflict) {
        console.log(printable(`CONFLICT: ${st.conflict.tallies.length} proposals reached a majority at once, so none was adopted. Members who approved more than one: FID ${st.conflict.both.join(", ")}.`));
      }
      console.log(st.open.length ? `open proposals (members' casts of the last ${days} days):` : `no open proposals in members' casts of the last ${days} days.`);
      for (const t of st.open) printTally(t);
      if (st.outdated.length) console.log(`${st.outdated.length} proposal(s) name an older version and no longer count.`);
      if (st.unknown.length) console.log(`${st.unknown.length} proposal(s) name a version this log does not have: another society's, or your log is behind (import a newer one from a member).`);
      console.log(verificationNote(hub));
      return;
    }
    case "propose": {
      const file = logFile(a, "charter propose <log file> --add <user|fid> [--remove ...] [--add-mod ...] [--remove-mod ...]");
      const s = await loadSociety(hub, file, chain, trust);
      const st = await advance(hub, s.log, { cache: savedApprovals() }); // propose against the latest version
      if (st.passed.length) save(file, st.log);
      const changes = await changesFrom(hub, opts);
      const k = key();
      const r = await propose(hub, k, { head: st.head, body: st.body }, changes);
      console.log(printable(`proposed ${changeList(changes)}: ${r.id.fid}:${r.id.hash}${r.confirmed ? "" : " (accepted for relay, not seen yet)"}`));
      console.log(`your like counts as your approval. It passes at ${needed(st.body, k.fid, changes)} of ${new Set(st.body.members).size} members.`);
      console.log(`members approve by liking it in any Farcaster app, or: ./outpost cli like ${r.id.fid} ${r.id.hash}`);
      return;
    }
    case "announce": {
      const s = await loadSociety(hub, logFile(a, "charter announce <log file>"), chain, trust);
      const last = s.versions.at(-1)!.amendment;
      if (!last) throw new Error("no amendment has passed yet");
      const r = await announce(hub, key(), last.proposal.id, last.approvers.length + last.unchecked.length, last.members);
      console.log(r ? `replied under the proposal: ${r.hash}` : "a result is already posted under the proposal");
      return;
    }
    case "import": {
      if (!a || !b) throw new Error("usage: charter import <their log file|url> <your log file>");
      const theirs = toLog(await load(a));
      const v = await verifyCharter(theirs.genesis, hub, chain);
      if (!v.ok) throw new Error(`their charter is rejected: ${v.problems.join("; ")}`);
      const rel = existsSync(b) ? compareLogs(toLog(JSON.parse(readFileSync(b, "utf8"))), theirs) : { relation: "extends" as const };
      if (rel.relation === "same") return console.log("their log is the same as yours. Nothing to do.");
      if (rel.relation === "behind") return console.log("yours is newer than theirs. Kept yours.");
      if (rel.relation === "other-society") throw new Error("their log has a different founder's charter: it is another society, not a newer version of yours");
      if (rel.relation === "fork") {
        throw new Error(`their log branches from yours after version ${rel.at}: another amendment passed there. Kept yours. Members who approved both: FID ${rel.both?.join(", ") || "none"}`);
      }
      const r = await replay(theirs, hub.verifier!);
      if (r.problems.length) throw new Error(`their log is rejected: ${r.problems.join("; ")}`);
      refuseUnrecountable(r.versions, trust);
      save(b, theirs);
      console.log(`imported ${theirs.amendments.length} amendment(s) into ${b}, head ${short(r.versions.at(-1)!.head)}:`);
      printVersions(r.versions);
      return;
    }
    default:
      throw new Error("usage: charter <new|sign|verify|census|feed|join|proposals|propose|announce|import> ...");
  }
}
