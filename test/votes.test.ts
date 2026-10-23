import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CastType, FarcasterNetwork } from "@farcaster/core";
import {
  advance,
  applyChanges,
  approvalCache,
  buildCast,
  compareLogs,
  farcasterNow,
  genesisHead,
  needed,
  parseProposal,
  proposalCast,
  replay,
  signCharter,
  tally,
  toLog,
  type Change,
  type CharterLog,
  type HubMessage,
} from "../src/core/index.js";
import { add, appKey, BODY, CAST, FOUNDER, json, LIKE, MEMBERS, OTHER_FOUNDER, society, World } from "./votes-world.js";

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("a proposal round-trips through a signed cast, with its FIDs as mentions", async () => {
  const w = new World();
  await w.member(100);
  const head = genesisHead(BODY);
  const changes: Change[] = [
    { op: "+", role: "member", fid: 3356407 },
    { op: "-", role: "member", fid: 500 },
    { op: "+", role: "moderator", fid: 200 },
  ];
  const m = await w.propose(100, head, changes);
  assert.equal(m.data.castAddBody!.text, `Amend charter ${head}\n+ member \n- member \n+ moderator \nLike this cast to approve.`);
  assert.deepEqual(parseProposal(m), { head, changes });
});

test("the parser accepts only the exact format", async () => {
  const w = new World();
  await w.member(100);
  const head = genesisHead(BODY);
  const good = await w.propose(100, head, add(600));
  const bad: Array<[string, (m: HubMessage) => void]> = [
    ["no header", (m) => (m.data.castAddBody!.text = m.data.castAddBody!.text.replace("Amend charter", "Amend"))],
    ["short head", (m) => (m.data.castAddBody!.text = m.data.castAddBody!.text.replace(head, head.slice(0, 20)))],
    ["no footer", (m) => (m.data.castAddBody!.text = m.data.castAddBody!.text.replace("Like this cast to approve.", "Like it."))],
    ["extra mention", (m) => (m.data.castAddBody!.mentions.push(7), m.data.castAddBody!.mentionsPositions.push(3))],
    ["mention mid-line", (m) => (m.data.castAddBody!.mentionsPositions[0] = m.data.castAddBody!.mentionsPositions[0]! - 2)],
    ["not ASCII", (m) => (m.data.castAddBody!.text = m.data.castAddBody!.text.replace("approve.", "apprové."))],
    ["embed", (m) => m.data.castAddBody!.embeds.push({ url: "https://example.org" })],
    ["channel post", (m) => (m.data.castAddBody!.parentUrl = "https://example.org/channel")],
    ["reply", (m) => (m.data.castAddBody!.parentCastId = { fid: 1, hash: head })],
    ["testnet", (m) => (m.data.network = "FARCASTER_NETWORK_TESTNET")],
    ["unknown verb", (m) => (m.data.castAddBody!.text = m.data.castAddBody!.text.replace("+ member ", "+ admin  "))],
  ];
  for (const [label, mutate] of bad) {
    const m = copy(good);
    mutate(m);
    assert.equal(typeof parseProposal(m), "string", label);
  }
  assert.throws(() => proposalCast(head, Array.from({ length: 11 }, (_, i) => ({ op: "+", role: "member", fid: 600 + i }))), /1 to 10 changes/);
  assert.throws(() => proposalCast(head, [...add(600), ...add(600)]), /named twice/);
  assert.throws(() => proposalCast(head, []), /1 to 10 changes/);
});

test("changes apply in order and keep at least one member", () => {
  assert.deepEqual(applyChanges(BODY, [{ op: "-", role: "member", fid: 100 }]), { ...BODY, members: [200, 300, 400, 500], moderators: [] });
  assert.match(applyChanges(BODY, add(100)) as string, /already a member/);
  assert.match(applyChanges(BODY, [{ op: "-", role: "member", fid: 999 }]) as string, /not a member/);
  assert.match(applyChanges(BODY, [{ op: "+", role: "moderator", fid: 999 }]) as string, /must be a member/);
  assert.match(applyChanges({ ...BODY, members: [100] }, [{ op: "-", role: "member", fid: 100 }]) as string, /at least one member/);
});

test("more than half the members must approve; a member leaving needs only their own like", () => {
  const n = (members: number[]) => needed({ ...BODY, members }, 1, add(9));
  assert.equal(n([1, 2, 3, 4, 5]), 3);
  assert.equal(n([1, 2, 3, 4]), 3);
  assert.equal(n([1, 2]), 2);
  assert.equal(n([1]), 1);
  assert.equal(n([1, 2, 2, 3, 3]), 2, "duplicates count once");
  assert.equal(needed(BODY, 500, [{ op: "-", role: "member", fid: 500 }]), 1);
  assert.equal(needed(BODY, 400, [{ op: "-", role: "member", fid: 500 }]), 3, "removing someone else needs a majority");
});

test("3 of 5 members like a proposal: it passes, the log grows, and anyone can recount it", async () => {
  const { w, log, head0 } = await society({ 300: "onchain" });
  const p = await w.propose(100, head0, add(600));
  await w.like(100, p);
  await w.like(200, p);
  const before = await advance(w.hub(), log);
  assert.equal(before.passed.length, 0);
  assert.deepEqual(before.open.map((t) => [t.approvers.length, t.needed]), [[2, 3]]);
  await w.like(300, p);
  const s = await advance(w.hub(), log);
  assert.equal(s.passed.length, 1);
  assert.equal(s.head, p.hash);
  assert.deepEqual(s.body.members, [...MEMBERS, 600]);
  assert.equal(s.log.amendments.length, 1);
  assert.equal(s.log.amendments[0]!.approvals.length, 3);

  // A recount from the file alone, with fresh key checks, as anyone would run it.
  const r = await replay(copy(s.log), w.verifier());
  assert.deepEqual(r.problems, []);
  const a = r.versions[1]!.amendment!;
  assert.deepEqual([a.approvers.sort(), a.unchecked, a.needed, a.members, a.recountable], [[100, 200, 300], [], 3, 5, true]);
  assert.equal(r.versions[1]!.head, p.hash);
});

test("a proposal dated a few seconds ahead of this clock (another member's clock, or rounding) is still found", async () => {
  const { w, log, head0 } = await society();
  const ahead = json(await buildCast(w.keys.get(100)!, proposalCast(head0, add(600)), farcasterNow() + 30));
  w.casts.unshift(ahead);
  const s = await advance(w.hub(), log);
  assert.deepEqual(s.open.map((t) => t.proposal.id.hash), [ahead.hash]);
});

test("non-members, recasts, other casts, testnet likes and keys that may not like are not counted", async () => {
  const { w, log, head0 } = await society({ 400: "cast-only" });
  const p = await w.propose(100, head0, add(600));
  const elsewhere = await w.propose(200, head0, add(700));
  await w.like(100, p);
  await w.member(900); // not a member
  await w.like(900, p);
  await w.like(200, p, undefined, "recast");
  await w.like(300, elsewhere);
  await w.like(400, p); // its key was added for casts only
  const testnet = await appKey(500, FarcasterNetwork.TESTNET);
  w.gasless.set(`500:${testnet.publicKey}`, { onchain: false, scopes: [CAST, LIKE] });
  await w.like(500, p, testnet);
  w.lieAboutTargets = true; // the node also sends likes of other casts
  const hub = w.hub();
  const t = await tally(hub, log.genesis, { cast: p, id: { fid: 100, hash: p.hash }, head: head0, changes: add(600) });
  assert.deepEqual(t.approvers, [100]);
  assert.equal(t.passes, false);
});

test("a like signed by a key that is not the member's is not counted, and a log built with it does not recount", async () => {
  const { w, log, head0 } = await society();
  const p = await w.propose(100, head0, add(600));
  const stranger = await appKey(200); // signs as FID 200, but no node or registry lists the key
  const forged = await w.like(200, p, stranger);
  await w.like(100, p);
  await w.like(300, p);
  const s = await advance(w.hub(), log);
  assert.equal(s.passed.length, 0, "2 genuine likes of 3 needed");

  // A hand-made log that includes the forged like.
  const hand: CharterLog = { ...log, amendments: [{ proposal: p, approvals: [w.likes[1]!, w.likes[2]!, forged] }] };
  const r = await replay(hand, w.verifier());
  const a = r.versions[1]!.amendment!;
  assert.deepEqual([a.unchecked, a.recountable], [[200], false]);
});

test("changing one byte of a sealed amendment breaks the recount", async () => {
  const { w, log, head0 } = await society();
  const p = await w.propose(100, head0, add(600));
  for (const f of [100, 200, 300]) await w.like(f, p);
  const sealed = (await advance(w.hub(), log)).log;
  const cases: Array<[string, (l: CharterLog) => void]> = [
    ["approval timestamp", (l) => l.amendments[0]!.approvals[0]!.data.timestamp++],
    ["approval target", (l) => (l.amendments[0]!.approvals[0]!.data.reactionBody!.targetCastId!.fid = 101)],
    ["approval author", (l) => (l.amendments[0]!.approvals[0]!.data.fid = 400)],
    ["proposal text", (l) => (l.amendments[0]!.proposal.data.castAddBody!.text = l.amendments[0]!.proposal.data.castAddBody!.text.replace("+ member", "- member"))],
    ["proposal mention", (l) => (l.amendments[0]!.proposal.data.castAddBody!.mentions[0] = 601)],
    ["approval dropped", (l) => l.amendments[0]!.approvals.pop()],
    ["approval repeated", (l) => (l.amendments[0]!.approvals[1] = l.amendments[0]!.approvals[0]!)],
    ["founder's member list", (l) => l.genesis.members.push(700)],
  ];
  for (const [label, mutate] of cases) {
    const l = copy(sealed);
    mutate(l);
    const r = await replay(l, w.verifier());
    // The founder's list is covered by the founder's signature, and the head moves with it.
    assert.notDeepEqual(r.problems, [], label);
  }
});

test("a proposal by a non-member, or naming another version, never applies", async () => {
  const { w, log, head0 } = await society();
  await w.member(900);
  const outsider = await w.propose(900, head0, add(600));
  const wrongHead = await w.propose(100, `0x${"ab".repeat(20)}`, add(600));
  for (const p of [outsider, wrongHead]) for (const f of [100, 200, 300]) await w.like(f, p);
  const s = await advance(w.hub(), log);
  assert.equal(s.passed.length, 0);
  assert.deepEqual(s.unknown.map((p) => p.id.hash), [wrongHead.hash]);
  for (const p of [outsider, wrongHead]) {
    const r = await replay({ ...log, amendments: [{ proposal: p, approvals: w.likes.filter((l) => l.data.reactionBody!.targetCastId!.hash === p.hash) }] }, w.verifier());
    assert.equal(r.versions.length, 1);
    assert.match(r.problems[0]!, p === outsider ? /not a member/ : /changes version/);
  }
});

test("two proposals on one version both at a majority: neither is adopted, and the members who approved both are named", async () => {
  const { w, log, head0 } = await society();
  const p = await w.propose(100, head0, add(600));
  const q = await w.propose(500, head0, add(700));
  for (const f of [100, 200, 300]) await w.like(f, p);
  for (const f of [300, 400, 500]) await w.like(f, q);
  const s = await advance(w.hub(), log);
  assert.equal(s.passed.length, 0);
  assert.equal(s.log.amendments.length, 0);
  assert.deepEqual(s.conflict?.both, [300]);
  assert.equal(s.conflict?.tallies.length, 2);
});

test("an approval seen once stays counted after an unlike or pruning", async () => {
  const { w, log, head0 } = await society();
  const p = await w.propose(100, head0, add(600));
  for (const f of [100, 200]) await w.like(f, p);
  let saved: string | undefined;
  const cache = approvalCache(
    () => saved,
    (s) => (saved = s),
  );
  const proposal = { cast: p, id: { fid: 100, hash: p.hash }, head: head0, changes: add(600) };
  assert.equal((await tally(w.hub(), log.genesis, proposal, cache)).approvers.length, 2);
  w.likes.shift(); // FID 100 unliked, or the node pruned it
  assert.equal((await tally(w.hub(), log.genesis, proposal)).approvers.length, 1, "without the cache");
  await w.like(300, p);
  const s = await advance(w.hub(), log, { cache });
  assert.equal(s.passed.length, 1, "100's earlier like still counts");
  assert.deepEqual(s.log.amendments[0]!.approvals.map((m) => m.data.fid).sort(), [100, 200, 300]);
});

test("a member leaves on their own like", async () => {
  const { w, log, head0 } = await society();
  const p = await w.propose(500, head0, [{ op: "-", role: "member", fid: 500 }]);
  await w.like(500, p);
  const s = await advance(w.hub(), log);
  assert.equal(s.passed.length, 1);
  assert.deepEqual(s.body.members, [100, 200, 300, 400]);
});

test("after add-then-remove, an old proposal for the founder's version is outdated, not counted", async () => {
  const { w, log, head0 } = await society();
  await w.member(600);
  const addIt = await w.propose(100, head0, add(600));
  for (const f of [100, 200, 300]) await w.like(f, addIt);
  const removeIt = await w.propose(100, addIt.hash, [{ op: "-", role: "member", fid: 600 }]);
  for (const f of [100, 200, 300, 400]) await w.like(f, removeIt); // 4 of 6
  const s1 = await advance(w.hub(), log);
  assert.equal(s1.passed.length, 2);
  assert.deepEqual(s1.body.members, MEMBERS);
  assert.equal(s1.head, removeIt.hash, "same members as the founder's version, different head");

  const stale = await w.propose(200, head0, add(700));
  for (const f of [100, 200, 300]) await w.like(f, stale);
  const s2 = await advance(w.hub(), s1.log);
  assert.equal(s2.passed.length, 0);
  assert.deepEqual(s2.outdated.map((p) => p.id.hash), [stale.hash]);
});

test("a recount labels approvals whose keys were revoked since, and says when the majority rests on them", async () => {
  const { w, log, head0 } = await society({ 200: "onchain" });
  const p = await w.propose(100, head0, add(600));
  for (const f of [100, 200, 300, 400]) await w.like(f, p);
  const sealed = (await advance(w.hub(), log)).log;
  // FID 200's onchain key is removed; FID 300 revokes its gasless key.
  w.onchain.set(`200:${w.keys.get(200)!.publicKey}`, "removed");
  w.gasless.delete(`300:${w.keys.get(300)!.publicKey}`);
  let a = (await replay(sealed, w.verifier())).versions[1]!.amendment!;
  assert.deepEqual([a.approvers.sort(), a.unchecked.sort(), a.recountable], [[100, 400], [200, 300], false]);
  w.onchain.set(`200:${w.keys.get(200)!.publicKey}`, "added");
  a = (await replay(sealed, w.verifier())).versions[1]!.amendment!;
  assert.deepEqual([a.unchecked, a.recountable], [[300], true], "3 of 3 needed still check out");
});

test("a recount rejects an approval from a key that may only cast", async () => {
  const { w, log, head0 } = await society();
  const p = await w.propose(100, head0, add(600));
  for (const f of [100, 200, 300]) await w.like(f, p);
  const sealed = (await advance(w.hub(), log)).log;
  w.gasless.set(`300:${w.keys.get(300)!.publicKey}`, { onchain: false, scopes: [CAST] });
  const r = await replay(sealed, w.verifier());
  assert.match(r.problems[0]!, /FID 300's approval is signed by a key that is not theirs, or may not like/);
});

test("logs only grow: same, extends, behind, fork and another society", async () => {
  const { w, log, head0 } = await society();
  const p = await w.propose(100, head0, add(600));
  for (const f of [100, 200, 300]) await w.like(f, p);
  const one = (await advance(w.hub(), log)).log;
  assert.deepEqual(compareLogs(log, log), { relation: "same" });
  assert.deepEqual(compareLogs(log, one), { relation: "extends", at: 0 });
  assert.deepEqual(compareLogs(one, log), { relation: "behind", at: 0 });

  // Another branch from the founder's version, by members who also approved the first.
  const w2 = new World();
  w2.keys = w.keys;
  w2.gasless = w.gasless;
  const q = await w2.propose(200, head0, add(700));
  for (const f of [200, 300, 400]) await w2.like(f, q);
  const other = (await advance(w2.hub(), log)).log;
  assert.deepEqual(compareLogs(one, other), { relation: "fork", at: 0, both: [200, 300] });

  const refounded = toLog(await signCharter({ ...BODY, issuedAt: "2026-10-24T00:00:00.000Z" }, OTHER_FOUNDER));
  assert.deepEqual(compareLogs(one, refounded), { relation: "other-society" });
});

test("a plain founder-signed charter is a log with no amendments", async () => {
  const signed = await signCharter(BODY, FOUNDER);
  const log = toLog(JSON.parse(JSON.stringify(signed)));
  assert.deepEqual(log, { charterLog: 1, genesis: signed, amendments: [] });
  const r = await replay(log, new World().verifier());
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.versions.map((v) => v.body.members), [MEMBERS]);
  assert.throws(() => toLog({ charterLog: 1, genesis: signed }), /not a charter log/);
  assert.throws(() => toLog({ hello: 1 }), /not a charter/);
});

test("CLI: proposals adds the passed amendment to the log file; verify recounts it; a changed file is rejected", async () => {
  const { w, log, head0 } = await society();
  const p = await w.propose(100, head0, add(600));
  for (const f of [100, 200, 300]) await w.like(f, p);
  const node = await w.serve();
  const second = await w.serve(); // another origin, so it counts as the independent second node
  try {
    const dir = mkdtempSync(join(tmpdir(), "outpost-votes-test-"));
    const file = join(dir, "society.log.json");
    writeFileSync(file, JSON.stringify(log.genesis));
    const cli = (...args: string[]) =>
      promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli/main.ts", "charter", ...args, "--node", node.url, "--rpc", "off", "--check-node", second.url], {
        env: { ...process.env, OUTPOST_HOME: dir },
      });
    const listed = (await cli("proposals", file)).stdout;
    assert.match(listed, /PASSED: \+ member 600 \(3 of 5 members\)/);
    assert.match(listed, new RegExp(`is at version 1, head ${p.hash}, 6 members`));
    const saved = toLog(JSON.parse(readFileSync(file, "utf8")));
    assert.equal(saved.amendments.length, 1);

    const recount = (await cli("verify", file)).stdout;
    assert.match(recount, /recount from your node: 1 of 1 amendments check out/);
    assert.match(recount, /v1 {2}0x[0-9a-f]{40} {2}\+ member 600, proposed by FID 100, approved by 3 of 5 \(needed 3\)/);

    saved.amendments[0]!.approvals[2]!.data.timestamp++;
    writeFileSync(file, JSON.stringify(saved));
    await assert.rejects(cli("verify", file), (e: { stdout: string }) => /REJECTED at amendment 1: an approval was changed after it was signed/.test(e.stdout));
  } finally {
    node.close();
    second.close();
  }
});

test("casts over 320 bytes go out as long casts, and mentions keep their offsets", async () => {
  const key = await appKey(1);
  const short = await buildCast(key, { text: "x".repeat(320) });
  const long = await buildCast(key, { text: "x".repeat(321) });
  assert.equal(short.data!.castAddBody!.type, CastType.CAST);
  assert.equal(long.data!.castAddBody!.type, CastType.LONG_CAST);
  await assert.rejects(buildCast(key, { text: "x".repeat(1025) }), /longer than 1024/);
  const m = await buildCast(key, { text: " + member \n", mentions: [5], mentionsPositions: [10] });
  assert.equal(m.data!.castAddBody!.text, " + member \n", "not trimmed when it has mentions");
  await assert.rejects(buildCast(key, { text: "hi", mentions: [5], mentionsPositions: [] }), /each with one position/);
});
