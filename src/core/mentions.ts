// @mentions. A cast does not carry "@name" in its text: the node stores the mentioned FIDs and,
// for each, the UTF-8 byte offset in the text where apps put the name back (feed.ts withMentions).
// Snapchain checks: at most 10, each offset at most the text's byte length, offsets ascending
// (validations/cast.rs).

import { FeedBuilder } from "./feed.js";
import type { Hub } from "./hub.js";

export const MAX_MENTIONS = 10;

// A name the person picked from the suggestions (or that the CLI looked up), and its FID.
export interface MentionPick {
  name: string; // without "@", e.g. "dwr" or "vitalik.eth"
  fid: number;
}

export interface MentionedText {
  text: string;
  mentions: number[];
  mentionsPositions: number[];
}

// Characters a username can hold. A "." only counts when a letter or digit follows it, so the
// full stop in "thanks @dwr." ends the name.
const NAME_CHAR = /[a-z0-9_-]/i;

function nameEndsAt(text: string, i: number): boolean {
  const c = text[i];
  if (c === undefined) return true;
  if (NAME_CHAR.test(c)) return false;
  return !(c === "." && NAME_CHAR.test(text[i + 1] ?? ""));
}

// Every "@name" whose name was picked becomes a mention; any other "@word" stays plain text, so a
// picked name that is edited afterwards ("@dwr" -> "@dwrx") no longer mentions anyone.
export function extractMentions(input: string, picks: MentionPick[]): MentionedText {
  const byName = new Map<string, number>();
  for (const p of picks) byName.set(p.name.replace(/^@/, "").toLowerCase(), p.fid);
  // Longest names first, so "@dwr.eth" is not read as "@dwr" followed by ".eth".
  const names = [...byName.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  const enc = new TextEncoder();
  let text = "";
  const mentions: number[] = [];
  const positions: number[] = [];
  let bytes = 0;
  let i = 0;
  while (i < input.length) {
    const before = input[i - 1];
    if (input[i] === "@" && (before === undefined || !NAME_CHAR.test(before))) {
      const rest = input.slice(i + 1).toLowerCase();
      const name = names.find((n) => rest.startsWith(n) && nameEndsAt(input, i + 1 + n.length));
      if (name) {
        mentions.push(byName.get(name)!);
        positions.push(bytes);
        i += 1 + name.length;
        continue;
      }
    }
    // One code point at a time, so the byte count never splits a character.
    const ch = String.fromCodePoint(input.codePointAt(i)!);
    text += ch;
    bytes += enc.encode(ch).length;
    i += ch.length;
  }
  if (mentions.length > MAX_MENTIONS) throw new Error(`at most ${MAX_MENTIONS} mentions in one cast`);
  // buildCast keeps text with mentions as it is, so trim here without moving a mention.
  const lead = text.length - text.trimStart().length;
  const leadBytes = enc.encode(text.slice(0, lead)).length;
  if (!positions.length || positions[0]! >= leadBytes) {
    text = text.slice(lead);
    for (let j = 0; j < positions.length; j++) positions[j]! -= leadBytes;
  }
  const last = positions.at(-1) ?? 0;
  while (/\s$/.test(text) && enc.encode(text).length - 1 >= last) text = text.slice(0, -1);
  return { text, mentions, mentionsPositions: positions };
}

// The "@word" being typed just before the cursor, for the suggestion list. Undefined when the
// cursor is not at the end of an "@" word.
export function mentionQuery(text: string, cursor: number): { start: number; query: string } | undefined {
  const m = /(^|[^a-z0-9_-])@([a-z0-9_.-]{0,20})$/i.exec(text.slice(0, cursor));
  if (!m) return undefined;
  return { start: cursor - m[2]!.length - 1, query: m[2]! };
}

// Every "@word" in the text, in order: names to look up (CLI) or to check against picks.
export function mentionedNames(text: string): string[] {
  const out: string[] = [];
  const re = /(^|[^a-z0-9_-])@([a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[2]!.toLowerCase());
  return out;
}

// Typed text (CLI) -> mentions. Each "@name" is looked up on the node and kept only if that
// account's own signed profile carries the name. An unknown name throws, naming it, instead of
// quietly posting it as plain text.
export async function resolveMentions(hub: Hub, text: string, feed = new FeedBuilder(hub)): Promise<MentionedText | { text: string }> {
  const names = [...new Set(mentionedNames(text))];
  if (!names.length) return { text };
  const picks: MentionPick[] = [];
  for (const name of names) {
    const fid = await hub.fidByUsername(name);
    const p = fid ? await feed.profile(fid).catch(() => undefined) : undefined;
    if (!fid || p?.username?.toLowerCase() !== name) {
      throw new Error(`unknown username @${name}: the node has no account with that name. Fix it, or add --no-mentions to post every @ as plain text.`);
    }
    picks.push({ name, fid });
  }
  const m = extractMentions(text, picks);
  return m.mentions.length ? m : { text };
}
