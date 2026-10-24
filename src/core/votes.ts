// Society votes: members change their society's charter by liking a proposal cast, from any
// Farcaster app. Four rules:
//   1. A proposal is a member's cast that names the charter's current head and lists changes.
//   2. An approval is a member's like on it. Once seen, it is final.
//   3. It passes when more than half the members of that version approve. Leaving needs only
//      your own approval.
//   4. The charter is an append-only log: the founder's signed charter, then each passed
//      proposal with the likes that passed it. The head is the hash of the last passed proposal
//      (at first, of the founder's charter). A log that branches is shown, never merged.
//
// No deadlines. Farcaster timestamps are set by the author and can be backdated (Snapchain only
// refuses dates more than 10 minutes ahead), and nodes keep the block times that prove when a
// message landed for 3 days. A threshold needs no clock: a proposal stops mattering once another
// passes, because it then names an old head.
//
// Likes can be removed later, and an account over its storage loses its oldest ones, so a passed
// amendment carries the signed likes themselves, and a client keeps every approval it has seen.
// Anyone can replay a log against their own node and get the same charter.

import { cast, react, type CastTarget, type WriteResult } from "./actions.js";
import type { AppKey } from "./appkey.js";
import { recentCasts } from "./census.js";
import { canonicalJson, contentHash, type Charter, type CharterBody } from "./charter.js";
import { mapLimit, MAX_SKEW_MS } from "./feed.js";
import { Hub, type HexString, type HubMessage } from "./hub.js";
import { verifyMessage, type VoteKey } from "./verify.js";

export const FOOTER = "Like this cast to approve.";
export const MAX_CHANGES = 10;
export const PROPOSAL_DAYS = 30; // how far back members' casts are searched for proposals
const HEADER = /^Amend charter (0x[0-9a-f]{40})$/;
const CHANGE = /^([+-]) (member|moderator) $/;
const MAINNET = "FARCASTER_NETWORK_MAINNET";
const CAST_ADD = "MESSAGE_TYPE_CAST_ADD";
const REACTION_ADD = "MESSAGE_TYPE_REACTION_ADD";

export type Role = "member" | "moderator";

export interface Change {
  op: "+" | "-";
  role: Role;
  fid: number;
}

export interface Proposal {
  cast: HubMessage; // the signed proposal
  id: CastTarget;
  head: HexString; // the version it changes
  changes: Change[];
}

export interface Amendment {
  proposal: HubMessage;
  approvals: HubMessage[]; // the signed likes that passed it
}

export interface CharterLog {
  charterLog: 1;
  genesis: Charter; // signed by the founder
  amendments: Amendment[];
}

export const short = (h: string) => h.slice(0, 10);

// The founder's charter is version 0. Its head is the first 20 bytes of its content hash, so
// every head has the shape of a cast hash.
export function genesisHead(c: CharterBody): HexString {
  return contentHash(c).slice(0, 42) as HexString;
}

function checkChanges(changes: Change[]): string | undefined {
  if (changes.length < 1 || changes.length > MAX_CHANGES) return `a proposal lists 1 to ${MAX_CHANGES} changes`;
  const seen = new Set<string>();
  for (const c of changes) {
    if (!Number.isSafeInteger(c.fid) || c.fid <= 0) return `not an FID: ${c.fid}`;
    const k = `${c.role}:${c.fid}`;
    if (seen.has(k)) return `FID ${c.fid} is named twice as ${c.role}`;
    seen.add(k);
  }
  return undefined;
}

// The cast text, with each FID as a mention at the end of its line. Every app shows
// "+ member @name"; the FID itself is part of what the proposer signs.
export function proposalCast(head: HexString, changes: Change[]): { text: string; mentions: number[]; mentionsPositions: number[] } {
  if (!/^0x[0-9a-f]{40}$/.test(head)) throw new Error(`not a charter head: ${head}`);
  const bad = checkChanges(changes);
  if (bad) throw new Error(bad);
  let text = `Amend charter ${head}\n`;
  const mentions: number[] = [];
  const mentionsPositions: number[] = [];
  for (const c of changes) {
    text += `${c.op} ${c.role} `;
    mentions.push(c.fid);
    mentionsPositions.push(text.length); // ASCII only, so characters are bytes
    text += "\n";
  }
  return { text: text + FOOTER, mentions, mentionsPositions };
}

// Strict: anything but the exact format is not a proposal, so no wording can be read two ways.
export function parseProposal(m: HubMessage): { head: HexString; changes: Change[] } | string {
  const b = m.data.castAddBody;
  if (m.data.type !== CAST_ADD || !b) return "not a cast";
  if (m.data.network !== MAINNET) return "not a mainnet cast";
  if (b.embeds.length || b.embedsDeprecated.length || b.parentCastId || b.parentUrl) return "a proposal has no embeds and is not a reply or a channel post";
  if (!/^[\x20-\x7e\n]*$/.test(b.text)) return "a proposal is plain ASCII text";
  const lines = b.text.split("\n");
  const head = HEADER.exec(lines[0]!)?.[1];
  if (!head) return "not a proposal";
  if (lines.length < 3 || lines.at(-1) !== FOOTER) return `the last line of a proposal is "${FOOTER}"`;
  const body = lines.slice(1, -1);
  if (b.mentions.length !== body.length || b.mentionsPositions.length !== body.length) return "each change line has exactly one mention, and nothing else has one";
  const changes: Change[] = [];
  let offset = lines[0]!.length + 1;
  for (const [i, line] of body.entries()) {
    const x = CHANGE.exec(line);
    if (!x) return `line ${i + 2} is not "+ member", "- member", "+ moderator" or "- moderator" and a mention`;
    offset += line.length;
    if (b.mentionsPositions[i] !== offset) return `the mention on line ${i + 2} is not at its end`;
    changes.push({ op: x[1] as Change["op"], role: x[2] as Role, fid: b.mentions[i]! });
    offset += 1;
  }
  return checkChanges(changes) ?? { head: head as HexString, changes };
}

// Applies changes in order. Removing a member also removes them as moderator.
export function applyChanges(body: CharterBody, changes: Change[]): CharterBody | string {
  const members = [...new Set(body.members)];
  const mods = [...new Set(body.moderators ?? [])];
  for (const c of changes) {
    const list = c.role === "member" ? members : mods;
    const i = list.indexOf(c.fid);
    if (c.op === "+") {
      if (i >= 0) return `FID ${c.fid} is already a ${c.role}`;
      if (c.role === "moderator" && !members.includes(c.fid)) return `FID ${c.fid} must be a member to be a moderator`;
      list.push(c.fid);
    } else {
      if (i < 0) return `FID ${c.fid} is not a ${c.role}`;
      list.splice(i, 1);
      if (c.role === "member" && mods.includes(c.fid)) mods.splice(mods.indexOf(c.fid), 1);
    }
  }
  if (!members.length) return "a charter keeps at least one member";
  if (members.length > 5000) return "a charter has at most 5000 members";
  return { ...body, members, ...(body.moderators !== undefined || mods.length ? { moderators: mods } : {}) };
}

// More than half the members of the version being changed. A member leaving needs only their own.
export function needed(body: CharterBody, proposer: number, changes: Change[]): number {
  const c = changes[0]!;
  if (changes.length === 1 && c.op === "-" && c.role === "member" && c.fid === proposer) return 1;
  return Math.floor(new Set(body.members).size / 2) + 1;
}

function isLikeOf(m: HubMessage, id: CastTarget): boolean {
  const r = m.data.reactionBody;
  return (
    m.data.type === REACTION_ADD &&
    m.data.network === MAINNET &&
    r?.type === "REACTION_TYPE_LIKE" &&
    r.targetCastId?.fid === id.fid &&
    r.targetCastId.hash.toLowerCase() === id.hash.toLowerCase()
  );
}

// A plain founder-signed charter is a log with no amendments.
export function toLog(x: unknown): CharterLog {
  const o = x as Partial<CharterLog> & { charter?: unknown };
  if (o && typeof o === "object" && o.charterLog === 1) {
    const ok =
      !!o.genesis &&
      typeof o.genesis === "object" &&
      Array.isArray(o.amendments) &&
      o.amendments.every((a) => !!a && typeof a === "object" && !!a.proposal && typeof a.proposal === "object" && Array.isArray(a.approvals));
    if (!ok) throw new Error("not a charter log: it needs the founder's charter and a list of amendments");
    return o as CharterLog;
  }
  if (o && typeof o === "object" && "charter" in o) return { charterLog: 1, genesis: o as Charter, amendments: [] };
  throw new Error("not a charter or a charter log");
}

// ---- replay (recount)

// Who may sign: a Verifier (verify.ts) checks keys on Optimism and with a second node.
export interface VoteKeys {
  voteKey(fid: number, key: HexString, type: string): Promise<VoteKey>;
}

// For this client's own log: it checked every key when it accepted each amendment.
export const ALREADY_CHECKED: VoteKeys = { voteKey: async () => "ok" };

export interface AmendmentResult {
  proposal: Proposal;
  members: number; // of the version it changed
  needed: number;
  approvers: number[]; // members whose like and key check out now
  unchecked: number[]; // members whose like checks out, but whose key can no longer be checked
  recountable: boolean; // `approvers` alone reach `needed`
}

export interface Version {
  head: HexString;
  body: CharterBody;
  amendment?: AmendmentResult; // how it came about; none for the founder's charter
}

export interface Replay {
  versions: Version[]; // up to the last amendment that checks out
  problems: string[]; // why replay stopped early; empty when every amendment applied
}

// Does not check the founder's signature: verifyCharter(log.genesis) does.
export async function replay(log: CharterLog, keys: VoteKeys): Promise<Replay> {
  const { signature: _signature, ...genesis } = log.genesis;
  const versions: Version[] = [{ head: genesisHead(log.genesis), body: genesis }];
  for (const [i, a] of log.amendments.entries()) {
    const next = await checkAmendment(versions.at(-1)!, a, keys);
    if (typeof next === "string") return { versions, problems: [`amendment ${i + 1}: ${next}`] };
    versions.push(next);
  }
  return { versions, problems: [] };
}

async function checkAmendment(at: Version, a: Amendment, keys: VoteKeys): Promise<Version | string> {
  const signed = await verifyMessage(a.proposal);
  if (typeof signed === "string") return "the proposal was changed after it was signed, or is not signed by its key";
  const p = parseProposal(signed);
  if (typeof p === "string") return p;
  if (p.head !== at.head) return `it changes version ${short(p.head)}, but the log is at ${short(at.head)}`;
  const proposer = signed.data.fid;
  const members = new Set(at.body.members);
  if (!members.has(proposer)) return `the proposer, FID ${proposer}, is not a member`;
  if ((await keys.voteKey(proposer, signed.signer, CAST_ADD)) === "no") return `the proposal is signed by a key that is not FID ${proposer}'s`;
  const body = applyChanges(at.body, p.changes);
  if (typeof body === "string") return body;
  const id: CastTarget = { fid: proposer, hash: signed.hash.toLowerCase() as HexString };
  const need = needed(at.body, proposer, p.changes);
  const approvers: number[] = [];
  const unchecked: number[] = [];
  for (const m of a.approvals) {
    const like = await verifyMessage(m);
    if (typeof like === "string") return "an approval was changed after it was signed, or is not signed by its key";
    if (!isLikeOf(like, id)) return "an approval is not a mainnet like of this proposal";
    const fid = like.data.fid;
    if (!members.has(fid)) return `FID ${fid} approved but is not a member`;
    if (approvers.includes(fid) || unchecked.includes(fid)) return `FID ${fid} approved twice`;
    const k = await keys.voteKey(fid, like.signer, REACTION_ADD);
    if (k === "no") return `FID ${fid}'s approval is signed by a key that is not theirs, or may not like`;
    (k === "ok" ? approvers : unchecked).push(fid);
  }
  const n = approvers.length + unchecked.length;
  if (n < need) return `${n} of ${members.size} members approved; it needs ${need}`;
  return {
    head: id.hash,
    body,
    amendment: { proposal: { cast: signed, id, ...p }, members: members.size, needed: need, approvers, unchecked, recountable: approvers.length >= need },
  };
}

// ---- live: proposals and tallies from your node

// Every approval a client has seen, kept so that an unlike or pruning later changes nothing.
export interface ApprovalCache {
  get(proposal: HexString): HubMessage[];
  put(proposal: HexString, approvals: HubMessage[]): void;
}

// Kept as JSON text (localStorage, a file): { "<proposal hash>": [likes] }.
export function approvalCache(read: () => string | null | undefined, write: (json: string) => void): ApprovalCache {
  const all = (): Record<string, unknown> => {
    try {
      const o: unknown = JSON.parse(read() ?? "{}");
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: (p) => {
      const v = all()[p.toLowerCase()];
      return Array.isArray(v) ? (v as HubMessage[]) : [];
    },
    put: (p, approvals) => write(JSON.stringify({ ...all(), [p.toLowerCase()]: approvals })),
  };
}

function needVerifier(hub: Hub): VoteKeys {
  if (!hub.verifier) throw new Error("votes are only counted with a verifier, which checks every like and key");
  return hub.verifier;
}

// Proposals among members' casts of the last `days` days, any head. The proposer's key must check out.
export async function findProposals(hub: Hub, members: number[], opts: { days?: number; now?: number } = {}): Promise<Proposal[]> {
  const keys = needVerifier(hub);
  const to = opts.now ?? Date.now();
  const from = to - (opts.days ?? PROPOSAL_DAYS) * 86_400_000;
  // A proposal posted a moment ago may be dated a little ahead of this clock: allow the skew nodes allow.
  const casts = (await mapLimit([...new Set(members)], 16, async (fid) => (await recentCasts(hub, fid, from, to + MAX_SKEW_MS)).recent)).flat();
  const found = await mapLimit(casts, 8, async (c): Promise<Proposal | undefined> => {
    if (!c.data.castAddBody?.text.startsWith("Amend charter ")) return undefined;
    const p = parseProposal(c);
    if (typeof p === "string" || (await keys.voteKey(c.data.fid, c.signer, CAST_ADD)) !== "ok") return undefined;
    return { cast: c, id: { fid: c.data.fid, hash: c.hash.toLowerCase() as HexString }, ...p };
  });
  return found.filter((p): p is Proposal => !!p);
}

export interface Tally {
  proposal: Proposal;
  members: number;
  needed: number;
  approvers: number[];
  approvals: HubMessage[]; // the likes counted, which go into the log if it passes
  passes: boolean;
}

// Likes from members of `body` whose keys check out, plus every approval seen before.
export async function tally(hub: Hub, body: CharterBody, p: Proposal, cache?: ApprovalCache): Promise<Tally> {
  const keys = needVerifier(hub);
  const members = new Set(body.members);
  const counted = new Map<number, HubMessage>();
  for (const m of cache?.get(p.id.hash) ?? []) {
    const like = await verifyMessage(m);
    if (typeof like !== "string" && isLikeOf(like, p.id) && members.has(like.data.fid)) counted.set(like.data.fid, like);
  }
  let pageToken: string | undefined;
  do {
    const page = await hub.likesByCast(p.id, { pageSize: 1000, pageToken });
    const fresh = page.items.filter((m) => !counted.has(m.data.fid) && members.has(m.data.fid) && isLikeOf(m, p.id));
    const checks = await mapLimit(fresh, 8, (m) => keys.voteKey(m.data.fid, m.signer, REACTION_ADD));
    fresh.forEach((m, i) => checks[i] === "ok" && !counted.has(m.data.fid) && counted.set(m.data.fid, m));
    pageToken = page.nextPageToken;
  } while (pageToken);
  const approvals = [...counted.values()];
  cache?.put(p.id.hash, approvals);
  const need = needed(body, p.id.fid, p.changes);
  return { proposal: p, members: members.size, needed: need, approvers: [...counted.keys()], approvals, passes: counted.size >= need };
}

export interface Status {
  log: CharterLog; // with the amendments that passed in this call appended
  head: HexString;
  body: CharterBody;
  open: Tally[]; // proposals for the current head
  passed: Tally[]; // appended in this call, in order
  conflict?: { tallies: Tally[]; both: number[] }; // two or more passed at once, so none was adopted
  outdated: Proposal[]; // name an older version of this log
  unknown: Proposal[]; // name a version this log lacks: another society's, or this log is behind
}

// Reads proposals and likes from your node and appends every amendment that has passed.
export async function advance(hub: Hub, log: CharterLog, opts: { cache?: ApprovalCache; days?: number; now?: number } = {}): Promise<Status> {
  const r = await replay(log, ALREADY_CHECKED);
  if (r.problems.length) throw new Error(`the saved charter log does not replay: ${r.problems.join("; ")}`);
  const versions = [...r.versions];
  const amendments = [...log.amendments];
  const inLog = new Set(amendments.map((a) => String(a.proposal.hash).toLowerCase()));
  const searched = new Set(versions.flatMap((v) => v.body.members));
  let proposals = await findProposals(hub, [...searched], opts);
  const passed: Tally[] = [];
  let open: Tally[] = [];
  let conflict: Status["conflict"];
  for (;;) {
    const at = versions.at(-1)!;
    const members = new Set(at.body.members);
    const here = proposals.filter((p) => p.head === at.head && members.has(p.id.fid) && typeof applyChanges(at.body, p.changes) !== "string");
    open = await mapLimit(here, 4, (p) => tally(hub, at.body, p, opts.cache));
    const won = open.filter((t) => t.passes);
    if (won.length > 1) {
      const n = new Map<number, number>();
      for (const t of won) for (const f of t.approvers) n.set(f, (n.get(f) ?? 0) + 1);
      conflict = { tallies: won, both: [...n].filter(([, k]) => k > 1).map(([f]) => f) };
    }
    if (won.length !== 1) break;
    const t = won[0]!;
    amendments.push({ proposal: t.proposal.cast, approvals: t.approvals });
    inLog.add(t.proposal.id.hash);
    passed.push(t);
    const body = applyChanges(at.body, t.proposal.changes) as CharterBody;
    versions.push({ head: t.proposal.id.hash, body });
    const fresh = body.members.filter((f) => !searched.has(f));
    fresh.forEach((f) => searched.add(f));
    if (fresh.length) proposals = proposals.concat(await findProposals(hub, fresh, opts));
  }
  const head = versions.at(-1)!.head;
  const known = new Set(versions.map((v) => v.head));
  const rest = proposals.filter((p) => !inLog.has(p.id.hash) && p.head !== head);
  return {
    log: { ...log, amendments },
    head,
    body: versions.at(-1)!.body,
    open: open.filter((t) => !t.passes || conflict),
    passed,
    conflict,
    outdated: rest.filter((p) => known.has(p.head)),
    unknown: rest.filter((p) => !known.has(p.head)),
  };
}

// ---- writes

// Checks the change against the current version, posts the proposal, and likes it.
export async function propose(hub: Hub, key: AppKey, at: { head: HexString; body: CharterBody }, changes: Change[]): Promise<{ id: CastTarget; confirmed: boolean }> {
  if (!new Set(at.body.members).has(key.fid)) throw new Error("only members can propose changes");
  const next = applyChanges(at.body, changes);
  if (typeof next === "string") throw new Error(next);
  for (const c of changes) {
    if (c.op !== "+" || c.role !== "member") continue;
    if (!(await hub.custodyOf(c.fid))) throw new Error(`FID ${c.fid} does not exist`);
    if (!(await hub.signersByFidPage(c.fid)).signers.length) throw new Error(`FID ${c.fid} has no keys, so it could never approve anything`);
  }
  const posted = await cast(hub, key, proposalCast(at.head, changes));
  const id: CastTarget = { fid: key.fid, hash: posted.hash };
  const liked = await react(hub, key, "like", id);
  return { id, confirmed: posted.confirmed && liked.confirmed };
}

export function resultText(approved: number, members: number, head: HexString): string {
  return `Passed with ${approved} of ${members} members. Charter head: ${head}`;
}

// One reply under the proposal, so people see the result in any app. Skipped if one is there.
export async function announce(hub: Hub, key: AppKey, id: CastTarget, approved: number, members: number): Promise<WriteResult | undefined> {
  const replies = await hub.repliesTo(id, { pageSize: 100 });
  if (replies.items.some((m) => m.data.castAddBody?.text.startsWith("Passed with "))) return undefined;
  return cast(hub, key, { text: resultText(approved, members, id.hash), replyTo: id });
}

// ---- sharing logs

export type LogRelation = "same" | "extends" | "behind" | "fork" | "other-society";

// How a shared log relates to the one this client keeps. Only one that extends it may replace it.
export function compareLogs(mine: CharterLog, theirs: CharterLog): { relation: LogRelation; at?: number; both?: number[] } {
  if (canonicalJson(mine.genesis) !== canonicalJson(theirs.genesis)) return { relation: "other-society" };
  const hash = (a: Amendment) => String(a.proposal.hash).toLowerCase();
  const n = Math.min(mine.amendments.length, theirs.amendments.length);
  for (let i = 0; i < n; i++) {
    const a = mine.amendments[i]!;
    const b = theirs.amendments[i]!;
    if (hash(a) !== hash(b)) {
      const theirFids = new Set(b.approvals.map((m) => m.data?.fid));
      return { relation: "fork", at: i, both: [...new Set(a.approvals.map((m) => m.data?.fid))].filter((f) => theirFids.has(f)) };
    }
  }
  if (mine.amendments.length === theirs.amendments.length) return { relation: "same" };
  return { relation: theirs.amendments.length > n ? "extends" : "behind", at: n };
}
