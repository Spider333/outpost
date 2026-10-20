// Web client. Static page; every request goes to your own node's HTTP API, or to a society
// node (someone else's, with your access token). Every message read is verified here first.
// By default the page and the node share an origin: `./outpost client` serves this page and
// forwards /v1/* to the node, so no node port has to be opened to the internet.

import type { EIP1193Provider } from "viem";
import { FarcasterNetwork } from "@farcaster/core";
import {
  addAppKey,
  cast,
  custodyFromSeedPhrase,
  custodyFromWallet,
  FeedBuilder,
  follow,
  followingOf,
  Hub,
  passesFilter,
  react,
  resolveAccount,
  revokeAppKey,
  syncState,
  unfollow,
  unreact,
  census,
  charterFeed,
  verifyCharter,
  checkNodeUrl,
  checkToken,
  DEFAULT_CHECK_NODE,
  DEFAULT_OPTIMISM_RPC,
  HubError,
  Optimism,
  secondNode,
  takeInvite,
  Verifier,
  type Society,
  type Charter,
  type AccountInfo,
  type AppFilter,
  type AppKey,
  type AppSelector,
  type Custody,
  type FeedItem,
  type HexString,
} from "../core/index.js";

const KEY_STORAGE = "outpost.appkey";
const CHARTER_STORAGE = "outpost.charter";
const SOCIETY_STORAGE = "outpost.society";
const RPC_STORAGE = "outpost.rpc";
const CHECKNODE_STORAGE = "outpost.checknode";

// Set by scripts/build.mjs: the git commit this bundle was built from.
declare const __OUTPOST_COMMIT__: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}

function store<T>(key: string, value?: T | null): T | undefined {
  try {
    if (value === null) localStorage.removeItem(key);
    else if (value !== undefined) localStorage.setItem(key, JSON.stringify(value));
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function say(msg: string, error = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", error);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Runs an action with the button disabled and errors shown in the status line.
async function busy(btn: HTMLButtonElement | null, label: string, fn: () => Promise<void>) {
  const old = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = label;
  }
  try {
    await fn();
  } catch (e) {
    say(errText(e), true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old ?? "";
    }
  }
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ---- state

const params = new URLSearchParams(location.search);
// The page's own origin (`./outpost client` forwards /v1/* to your node), unless you chose a
// society node: in the panel, or by accepting an invite link (#node=...&token=...). A link alone
// never switches nodes: the invite is removed from the address bar and you are asked first.
let inviteError: string | undefined;
try {
  const invite = takeInvite(location, history);
  if (invite && confirm(`Use the society node at ${invite.node}?\n\nIts host will see what you read and can withhold or delay messages. This page checks every message itself; the host cannot post as you.`)) {
    store(SOCIETY_STORAGE, invite);
  }
} catch (e) {
  inviteError = `Invite link not used: ${errText(e)}`;
}
const society = store<Society>(SOCIETY_STORAGE);
// Key and custody checks read Optimism through this RPC, never through the node. "" turns them off.
const rpc = store<string>(RPC_STORAGE) ?? DEFAULT_OPTIMISM_RPC;
const chain = rpc ? new Optimism(rpc) : undefined;
// Gasless keys have no onchain record, so a second, independent node is asked. "" turns it off;
// a second node on the same origin as the node being read is skipped.
const checkUrl = store<string>(CHECKNODE_STORAGE) ?? DEFAULT_CHECK_NODE;
const readUrl = society?.node ?? location.origin;
const second = checkUrl ? secondNode(checkUrl, readUrl) : undefined;
const verifier = new Verifier(chain, second);
const hub = new Hub({ url: readUrl, token: society?.token, verifier });
let feed = new FeedBuilder(hub);

let key: AppKey | undefined = store<AppKey>(KEY_STORAGE);
if (key) verifier.trust(key.fid, key.publicKey);
// Mainnet unless the local server says it fronts a test devnet.
let network = FarcasterNetwork.MAINNET;
let pendingCustody: Custody | undefined;
let pendingAccount: AccountInfo | undefined;
let viewFid: number | undefined;
let items: FeedItem[] = [];
let perAuthor = 5;
let replyTo: { fid: number; hash: HexString } | undefined;
let myFollowing = new Set<number>();
const chipState = new Map<string, "include" | "exclude">();
let appNames = new Map<number, string>();
let charter: Charter | undefined = store<Charter>(CHARTER_STORAGE);

// ---- node status

async function checkNode() {
  const pill = $("node-status");
  const which = society ? `society node ${new URL(society.node).host}` : "node";
  try {
    const info = await hub.info();
    const { synced, maxDelay } = syncState(info);
    pill.textContent = synced ? `${which} synced (v${info.version})` : `${which} syncing, ${maxDelay} blocks behind`;
    pill.className = `pill ${synced ? "ok" : "warn"}`;
    return synced;
  } catch (e) {
    pill.textContent = e instanceof HubError && e.status === 401 ? `${which}: access refused` : `${which} unreachable`;
    pill.className = "pill bad";
    if (e instanceof HubError && e.status === 401) {
      say(`The society node at ${hub.url} no longer accepts your access token: the host removed it, or it was mistyped. Ask the host for a new invite link, or go back to your own node under "Node and checks".`, true);
    } else {
      say(`Cannot reach ${society ? "the society node" : "your node"} at ${hub.url}. ${errText(e)}`, true);
      if (!society) ($("node-settings") as HTMLDetailsElement).open = true;
    }
    return false;
  }
}

// What the verifier dropped or held back so far. The node is not asked; these checks run here.
function showVerification() {
  const el = $("verify-status");
  if (!verifier.checked) return;
  el.replaceChildren(verifier.summary());
  if (verifier.failed) el.append(" (A failed check can rarely come from an honest node, when the app that posted the message encoded it unusually.)");
  if (verifier.unverified && !verifier.showUnverified) {
    el.append(" ", h("button", { type: "button", onclick: (e: Event) => busy(e.currentTarget as HTMLButtonElement, "Loading...", showUnverified) }, "Show them anyway"));
  }
  el.classList.toggle("bad", verifier.failed > 0);
  el.classList.toggle("warn", !verifier.failed && verifier.unverified > 0);
}

// For this visit only: show messages whose key could not be checked, marked. Fresh caches, so
// profiles are rebuilt too and the counts describe what is on screen.
async function showUnverified() {
  verifier.showUnverified = true;
  verifier.reset();
  feed = new FeedBuilder(hub);
  await loadFeed();
}

// ---- node settings

function wireNodeSettings() {
  $("soc-current").textContent = society
    ? `Using the society node ${society.node}.`
    : `Using your own node (this page's origin, ${location.origin}).`;
  $<HTMLInputElement>("rpc-url").value = rpc;
  $<HTMLInputElement>("check-node").value = checkUrl;
  $("check-note").textContent = !checkUrl
    ? 'The second-node check is off: casts signed with gasless keys say "signer not verified".'
    : !second
      ? "The second node is the node you read from, so the gasless-key check is skipped. Choose a different node."
      : `Gasless keys are checked with ${checkUrl}. It learns which accounts you look at (one request per account), not which casts you read. A fake cast now needs both nodes to lie.`;
  $("node-note").textContent = society ? `Reads and writes go to the society node ${society.node}.` : "Reads and writes go only to your own node.";
  $("soc-save").addEventListener("click", () =>
    busy(null, "", async () => {
      const s: Society = { node: checkNodeUrl($<HTMLInputElement>("soc-node").value), token: checkToken($<HTMLInputElement>("soc-token").value) };
      $<HTMLInputElement>("soc-token").value = "";
      store(SOCIETY_STORAGE, s);
      location.reload();
    }),
  );
  $("soc-forget").addEventListener("click", () => {
    store(SOCIETY_STORAGE, null);
    location.reload();
  });
  $("check-save").addEventListener("click", () =>
    busy(null, "", async () => {
      const v = $<HTMLInputElement>("check-node").value.trim();
      store(CHECKNODE_STORAGE, v ? checkNodeUrl(v) : "");
      location.reload();
    }),
  );
  $("rpc-save").addEventListener("click", () =>
    busy(null, "", async () => {
      const v = $<HTMLInputElement>("rpc-url").value.trim();
      if (v && !/^https:\/\/[^\s]+$/.test(v)) throw new Error("The RPC must be an https URL, or empty to turn the checks off.");
      store(RPC_STORAGE, v);
      location.reload();
    }),
  );
}

// ---- connect

function showConnectStep(step: "choose" | "phrase" | "confirm") {
  $("phrase-box").hidden = step !== "phrase";
  $("confirm-box").hidden = step !== "confirm";
  $("use-wallet").parentElement!.hidden = step === "confirm";
}

async function prepare(custody: Custody) {
  say("Looking up the account on your node...");
  const account = await resolveAccount(hub, custody.address);
  if (account.storageUnits === 0) throw new Error(`FID ${account.fid} has no storage, so the network would reject its casts.`);
  pendingCustody = custody;
  pendingAccount = account;
  $("c-addr").textContent = account.custody;
  $("c-fid").textContent = String(account.fid);
  $("c-storage").textContent = String(account.storageUnits);
  showConnectStep("confirm");
  say(`Found FID ${account.fid}. Check the details, then authorize.`);
}

function wireConnect() {
  $("use-wallet").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Waiting for wallet...", async () => {
      const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
      if (!eth) throw new Error("No browser wallet found. Install one, or use a test account's phrase.");
      await prepare(await custodyFromWallet(eth));
    }),
  );
  $("use-phrase").addEventListener("click", () => {
    showConnectStep("phrase");
    $("phrase").focus();
  });
  const isTest = $<HTMLInputElement>("is-test");
  isTest.addEventListener("change", () => ($<HTMLButtonElement>("phrase-go").disabled = !isTest.checked));
  $("phrase-go").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Checking...", async () => {
      const input = $<HTMLInputElement>("phrase");
      const phrase = input.value;
      input.value = ""; // clear the field right away; the phrase is kept nowhere else
      await prepare(custodyFromSeedPhrase(phrase));
    }),
  );
  $("cancel").addEventListener("click", () => {
    pendingCustody = undefined;
    pendingAccount = undefined;
    showConnectStep("choose");
    say("");
  });
  $("authorize").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Signing and waiting for the node...", async () => {
      if (!pendingCustody || !pendingAccount) return;
      const { key: k, confirmed } = await addAppKey(hub, { fid: pendingAccount.fid, custody: pendingCustody.signer, network }, { timeoutMs: 60_000 }, (added) => {
        store(KEY_STORAGE, added); // saved as soon as the node accepts it, so a slow merge cannot lose it
      });
      pendingCustody = undefined; // drop the custody signer; only the app key is kept
      key = k;
      verifier.trust(k.fid, k.publicKey);
      say(confirmed ? `App key added for FID ${k.fid}. Your node shows it as active.` : `App key sent for FID ${k.fid}; your node does not show it yet. Check the key panel in a minute.`);
      renderAccount();
      await loadFeed(k.fid);
    }),
  );
}

// ---- account / key panel

async function renderAccount() {
  const logged = !!key;
  $("connect").hidden = logged;
  $("compose").hidden = !logged;
  $("key").hidden = !logged;
  $("who").textContent = key ? `FID ${key.fid}` : "";
  if (!key) {
    showConnectStep("choose");
    return;
  }
  $("k-fid").textContent = String(key.fid);
  $("k-pub").textContent = key.publicKey;
  $("k-status").textContent = "checking...";
  try {
    const s = await hub.signer(key.fid, key.publicKey);
    $("k-status").textContent = s
      ? `active${s.expiresAt ? `, expires ${new Date(s.expiresAt * 1000).toLocaleDateString()} unless used` : ""}`
      : "not active (revoked or expired). Revoke to remove it from this browser.";
    myFollowing = new Set(await followingOf(hub, key.fid));
  } catch (e) {
    $("k-status").textContent = `unknown (${errText(e)})`;
  }
}

function wireKey() {
  $("revoke").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Revoking...", async () => {
      if (!key) return;
      if (!confirm("Revoke this app key? This client will no longer be able to post for you.")) return;
      const active = await hub.signer(key.fid, key.publicKey);
      if (active) await revokeAppKey(hub, key, { timeoutMs: 60_000 });
      store(KEY_STORAGE, null);
      key = undefined;
      say(active ? "Key revoked. No recovery phrase was needed." : "The key was already inactive. Removed it from this browser.");
      renderAccount();
      renderFeed();
    }),
  );
}

// ---- compose

function setReply(target?: { fid: number; hash: HexString; name: string }) {
  replyTo = target && { fid: target.fid, hash: target.hash };
  const el = $("reply-to");
  el.hidden = !target;
  el.replaceChildren();
  if (target) {
    el.append(`Replying to ${target.name} `, h("button", { type: "button", onclick: () => setReply() }, "cancel reply"));
    $("text").focus();
  }
}

function wireCompose() {
  const text = $<HTMLTextAreaElement>("text");
  text.addEventListener("input", () => ($("count").textContent = `${new TextEncoder().encode(text.value).length} / 1024`));
  $("post").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Posting...", async () => {
      if (!key) return;
      const r = await cast(hub, key, { text: text.value, replyTo });
      text.value = "";
      $("count").textContent = "0 / 1024";
      setReply();
      say(r.confirmed ? `Cast ${r.hash.slice(0, 10)} is on your node.` : `Cast ${r.hash.slice(0, 10)} was accepted for relay; not visible yet.`);
      if (viewFid === key.fid) await loadFeed(key.fid);
    }),
  );
}

// ---- feed

function selectorKey(it: FeedItem): string {
  return it.app.kind === "app" ? String(it.app.requestFid) : it.app.kind;
}

function appLabel(it: FeedItem): string {
  if (it.app.kind === "app") return appNames.get(it.app.requestFid!) ?? `app ${it.app.requestFid}`;
  return it.app.kind === "self" ? "own key" : "unknown key";
}

function currentFilter(): AppFilter {
  const include: AppSelector[] = [];
  const exclude: AppSelector[] = [];
  for (const [k, v] of chipState) {
    const sel: AppSelector = k === "self" || k === "unknown" ? k : Number(k);
    (v === "include" ? include : exclude).push(sel);
  }
  return { include, exclude };
}

function renderChips() {
  const counts = new Map<string, { label: string; n: number }>();
  for (const it of items) {
    const k = selectorKey(it);
    const c = counts.get(k) ?? { label: appLabel(it), n: 0 };
    c.n++;
    counts.set(k, c);
  }
  const box = $("apps");
  box.replaceChildren(
    ...[...counts].sort((a, b) => b[1].n - a[1].n).map(([k, c]) => {
      const state = chipState.get(k);
      const verb = state === "include" ? "showing only" : state === "exclude" ? "hiding" : "showing";
      return h(
        "button",
        {
          type: "button",
          class: "chip",
          "data-state": state ?? "none",
          "aria-label": `${c.label}, ${c.n} casts, ${verb}`,
          onclick: () => {
            const next = !state ? "include" : state === "include" ? "exclude" : undefined;
            if (next) chipState.set(k, next);
            else chipState.delete(k);
            renderFeed();
          },
        },
        `${c.label} · ${c.n}`,
      );
    }),
  );
}

function actionButton(label: string, pressed: boolean, onToggle: (now: boolean) => Promise<void>) {
  const btn = h("button", { type: "button", "aria-pressed": String(pressed) }, label);
  btn.addEventListener("click", () =>
    busy(btn, "...", async () => {
      const now = btn.getAttribute("aria-pressed") !== "true";
      await onToggle(now);
      btn.setAttribute("aria-pressed", String(now));
    }).then(() => (btn.textContent = label)),
  );
  return btn;
}

function castCard(it: FeedItem): HTMLLIElement {
  const name = it.author?.username ? `@${it.author.username}` : `fid ${it.fid}`;
  const target = { fid: it.fid, hash: it.hash };
  const actions = h("div", { class: "cast-actions" });
  if (key) {
    const k = key;
    const like = actionButton("Like", false, async (on) => void (await (on ? react : unreact)(hub, k, "like", target)));
    const recast = actionButton("Recast", false, async (on) => void (await (on ? react : unreact)(hub, k, "recast", target)));
    actions.append(like, recast, h("button", { type: "button", onclick: () => setReply({ ...target, name }) }, "Reply"));
    if (it.fid !== k.fid) {
      actions.append(
        actionButton(myFollowing.has(it.fid) ? "Following" : "Follow", myFollowing.has(it.fid), async (on) => {
          await (on ? follow : unfollow)(hub, k, it.fid);
          if (on) myFollowing.add(it.fid);
          else myFollowing.delete(it.fid);
        }),
      );
    }
    // Show whether we already liked or recast it, without blocking the render.
    void Promise.all([hub.reactionById(k.fid, "Like", target), hub.reactionById(k.fid, "Recast", target)]).then(([l, r]) => {
      like.setAttribute("aria-pressed", String(!!l));
      recast.setAttribute("aria-pressed", String(!!r));
    }, () => undefined);
  }
  const embeds = it.embeds.filter((u) => /^https?:\/\//.test(u));
  return h(
    "li",
    { class: "cast" },
    h(
      "div",
      { class: "cast-head" },
      h("span", { class: "name" }, it.author?.displayName ?? name),
      h("span", { class: "meta" }, `${name} · ${ago(it.time)}`),
      h("span", { class: "app-tag", title: "The app that requested the key that signed this cast" }, appLabel(it)),
      // Your own key needs no proof; any other key must be on Optimism or listed by the second node.
      it.app.keyCheck === "onchain" || it.app.keyCheck === "own" || it.signer.toLowerCase() === key?.publicKey.toLowerCase()
        ? null
        : it.app.keyCheck === "confirmed"
          ? h(
              "span",
              { class: "app-tag", title: `A gasless key: no onchain record, but the second node (${checkUrl}) lists it as this account's key. Faking it would need both nodes to lie.` },
              "signer confirmed by second node",
            )
          : h(
              "span",
              {
                class: "key-tag",
                title:
                  "The signature is valid, but this page could not prove the key belongs to this account: it is not on Optimism and no second node could be asked (off, unreachable, or the same node). The node could have signed this with its own key.",
              },
              "signer not verified",
            ),
    ),
    it.text ? h("p", { class: "cast-text" }, it.text) : null,
    embeds.length
      ? h("div", { class: "cast-embeds" }, ...embeds.flatMap((u) => [h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, u), " "]))
      : null,
    actions,
  );
}

function renderFeed() {
  renderChips();
  const filter = currentFilter();
  const shown = items.filter((it) => passesFilter(it.app, filter));
  $("feed").replaceChildren(...shown.map(castCard));
  $("more").hidden = items.length === 0;
  if (charter) $("feed-title").textContent = `Society feed of "${charter.name}" through its lens: ${shown.length} of ${items.length} casts shown`;
  else if (viewFid) $("feed-title").textContent = `Following feed of FID ${viewFid}: ${shown.length} of ${items.length} casts shown`;
  else $("feed-title").textContent = "";
}

async function loadFeed(fid?: number) {
  if (fid) viewFid = fid;
  const t0 = performance.now();
  if (charter) {
    say(`Loading the "${charter.name}" society feed from your node...`);
    items = await charterFeed(feed, charter, { limit: 100, perAuthor });
  } else if (viewFid) {
    say(`Loading the feed for FID ${viewFid} from your node...`);
    items = await feed.following(viewFid, { limit: 100, perAuthor });
  } else return;
  appNames = await feed.appNames(items);
  renderFeed();
  showVerification();
  say(`Loaded ${items.length} casts in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
}

function wireFeed() {
  $("view-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void busy(null, "", async () => {
      const v = $<HTMLInputElement>("view").value.trim();
      const fid = /^\d+$/.test(v) ? Number(v) : await hub.fidByUsername(v);
      if (!fid) throw new Error(`No FID found for "${v}". Plain usernames only; .eth names need an Ethereum RPC on the node.`);
      perAuthor = 5;
      if (charter) leaveCharter();
      await loadFeed(fid);
    });
  });
  $("more").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Loading...", async () => {
      perAuthor *= 2;
      await loadFeed();
    }),
  );
}

// ---- society (charter)

async function showCharter(c: unknown, source: string) {
  const v = await verifyCharter(c, hub, chain);
  const verdict = $("charter-verdict");
  $("charter-view").hidden = false;
  if (!v.ok) {
    verdict.className = "verdict-bad";
    verdict.textContent = `Rejected (${source}): ${v.problems.join("; ")}`;
    for (const id of ["ch-name", "ch-desc", "ch-coc", "ch-members", "ch-rules", "ch-nodes"]) $(id).textContent = "";
    ($("ch-join") as HTMLButtonElement).disabled = true;
    $("ch-details").hidden = true;
    // Never keep an earlier society's lens active behind a rejected file.
    charter = undefined;
    store(CHARTER_STORAGE, null);
    $("ch-census").hidden = true;
    items = [];
    renderFeed();
    return;
  }
  const ch = c as Charter;
  $("ch-details").hidden = false;
  verdict.className = "verdict-ok";
  verdict.textContent =
    v.issuerCheck === "custody"
      ? `Signature OK: signed by the owner of FID ${ch.issuer!.fid}, checked ${chain ? "on Optimism" : "on your node"}.`
      : `Signature OK, signed by ${v.signer}. ${ch.issuer ? "Could not confirm it is the issuer's key." : "It names no issuer account."}`;
  $("ch-name").textContent = ch.name;
  $("ch-desc").textContent = ch.description ?? "";
  const coc = $("ch-coc");
  coc.replaceChildren(ch.codeOfConduct && /^https?:\/\//.test(ch.codeOfConduct) ? h("a", { href: ch.codeOfConduct, target: "_blank", rel: "noopener noreferrer" }, ch.codeOfConduct) : "none");
  $("ch-members").textContent = `${ch.members.length} members${ch.moderators?.length ? `, ${ch.moderators.length} moderators` : ""}`;
  const rules: string[] = [];
  if (ch.feed?.channels?.length) rules.push(`channels: ${ch.feed.channels.join(", ")}`);
  if (ch.feed?.keywords?.length) rules.push(`must mention: ${ch.feed.keywords.join(", ")}`);
  if (ch.feed?.excludeKeywords?.length) rules.push(`hides: ${ch.feed.excludeKeywords.join(", ")}`);
  if (ch.clients?.include?.length) rules.push(`only apps: ${ch.clients.include.join(", ")}`);
  if (ch.clients?.exclude?.length) rules.push(`hides apps: ${ch.clients.exclude.join(", ")}`);
  $("ch-rules").textContent = rules.join("; ") || "members' casts, no other rules";
  $("ch-nodes").replaceChildren(
    ...(ch.nodes ?? []).map((url) =>
      h(
        "div",
        {},
        `${url} `,
        h("button", { type: "button", onclick: () => useNode(url) }, url === society?.node ? "in use" : "use this node"),
      ),
    ),
  );
  if (!ch.nodes?.length) $("ch-nodes").textContent = "none listed";
  ($("ch-join") as HTMLButtonElement).disabled = !key;
  charter = ch;
  store(CHARTER_STORAGE, ch);
  chipState.clear();
  perAuthor = 5;
  await loadFeed();
}

// A charter lists nodes; a token still comes from that node's host.
function useNode(url: string) {
  const details = $("node-settings") as HTMLDetailsElement;
  details.open = true;
  $<HTMLInputElement>("soc-node").value = url;
  $("soc-token").focus();
  say(`Paste the access token the host of ${url} gave you, then press "Use this node".`);
}

function leaveCharter() {
  charter = undefined;
  store(CHARTER_STORAGE, null);
  $("charter-view").hidden = true;
  $("ch-census").hidden = true;
}

function wireCharter() {
  $("charter-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void busy(null, "", async () => {
      const url = $<HTMLInputElement>("charter-url").value.trim();
      if (!/^https?:\/\//.test(url)) throw new Error("Enter an http(s) URL of a charter file.");
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Could not fetch the charter: HTTP ${r.status}`);
      await showCharter(await r.json(), url);
    });
  });
  $("charter-file").addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    void busy(null, "", async () => showCharter(JSON.parse(await f.text()), f.name));
  });
  $("ch-leave").addEventListener("click", () =>
    busy(null, "", async () => {
      const name = charter?.name;
      leaveCharter();
      say(`Left "${name}". Your keys, follows and posts are unchanged.`);
      items = [];
      renderFeed();
      if (viewFid ?? key?.fid) await loadFeed(viewFid ?? key?.fid);
    }),
  );
  $("ch-join").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Following...", async () => {
      if (!key || !charter) return;
      const k = key;
      const todo = charter.members.filter((m) => m !== k.fid && !myFollowing.has(m));
      let n = 0;
      let unconfirmed = 0;
      for (const m of todo) {
        say(`Following member ${++n} of ${todo.length} (FID ${m})...`);
        const r = await follow(hub, k, m, { timeoutMs: 15_000 });
        if (r.confirmed) myFollowing.add(m);
        else unconfirmed++;
      }
      say(
        unconfirmed
          ? `Joined "${charter.name}": ${todo.length - unconfirmed} follows confirmed, ${unconfirmed} sent but not seen yet.`
          : `Joined "${charter.name}": you follow all ${charter.members.length} members.`,
      );
    }),
  );
  $("ch-census-btn").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Counting...", async () => {
      if (!charter) return;
      const c = await census(hub, charter, { days: 7 });
      const names = await feed.appNames(items);
      $("cs-members").textContent = String(c.members);
      $("cs-active").textContent = `${c.active} posted in the last ${c.days} days`;
      $("cs-perday").textContent = `${c.castsPerDay} (${c.casts} casts)`;
      $("cs-apps").textContent =
        c.apps
          .map((a) => `${a.app.kind === "app" ? names.get(a.app.requestFid!) ?? `app ${a.app.requestFid}` : a.app.kind === "self" ? "own key" : "unknown"}: ${a.casts}`)
          .join(", ") || "no casts";
      $("ch-census").hidden = false;
      showVerification();
    }),
  );
}

// ---- start

async function main() {
  try {
    const cfg = (await (await fetch("/outpost-config.json")).json()) as { network?: string };
    if (cfg.network === "devnet") network = FarcasterNetwork.DEVNET;
  } catch {
    // Served without Outpost's server (e.g. Caddy for phones): mainnet.
  }
  $("build").replaceChildren(
    __OUTPOST_COMMIT__ === "unknown"
      ? "Built from an unknown commit."
      : h("a", { href: `https://github.com/Spider333/outpost/commit/${__OUTPOST_COMMIT__.replace(/-dirty$/, "")}`, rel: "noopener noreferrer" }, `Built from ${__OUTPOST_COMMIT__.slice(0, 12)}${__OUTPOST_COMMIT__.endsWith("-dirty") ? " plus local changes" : ""}.`),
  );
  wireNodeSettings();
  wireConnect();
  wireKey();
  wireCompose();
  wireFeed();
  wireCharter();
  await renderAccount();
  if (await checkNode()) {
    const start = key?.fid ?? (params.get("fid") ? Number(params.get("fid")) : undefined);
    if (charter) await showCharter(charter, "saved in this browser").catch((e) => say(errText(e), true));
    else if (start) await loadFeed(start).catch((e) => say(errText(e), true));
    else say("Enter an FID or username to read a feed, or connect an account to post.");
  }
  if (inviteError) say(inviteError, true);
  setInterval(checkNode, 60_000);
}

void main();
