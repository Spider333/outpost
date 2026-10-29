// Web client. Static page; every request goes to your own node's HTTP API, or to a society
// node (someone else's, with your access token). Every message read is verified here first.
// By default the page and the node share an origin: `./outpost client` serves this page and
// forwards /v1/* to the node, so no node port has to be opened to the internet.

import { zeroAddress, type EIP1193Provider } from "viem";
import { optimism } from "viem/chains";
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
  newRecoveryPhrase,
  Optimism,
  REGISTER_DEADLINE_SECONDS,
  secondNode,
  signRegistration,
  sponsorRegister,
  sponsorStatus,
  takeInvite,
  Verifier,
  advance,
  announce,
  approvalCache,
  compareLogs,
  propose,
  replay,
  short,
  toLog,
  ALREADY_CHECKED,
  MAX_CHANGES,
  type Change,
  type CharterBody,
  type CharterLog,
  type Status,
  type Tally,
  type Version,
  type Society,
  type AccountInfo,
  type AppFilter,
  type AppKey,
  type AppSelector,
  type Custody,
  type FeedItem,
  type HexString,
  type Profile,
  extractMentions,
  mapLimit,
  mentionQuery,
} from "../core/index.js";
import { httpsUrl, initial, isImageEmbed } from "./media.js";

const KEY_STORAGE = "outpost.appkey";
const CHARTER_STORAGE = "outpost.charter";
const SOCIETY_STORAGE = "outpost.society";
const PUBLIC_STORAGE = "outpost.public";
const RPC_STORAGE = "outpost.rpc";
const CHECKNODE_STORAGE = "outpost.checknode";
const PICTURES_STORAGE = "outpost.pictures";
const APPROVALS_STORAGE = "outpost.approvals";

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
// never switches nodes: the invite is removed from the address bar and you are asked first, on the
// page (a browser popup at load can be missed or suppressed, and then the invite is lost).
let inviteError: string | undefined;
let invite: Society | undefined;
try {
  invite = takeInvite(location, history);
} catch (e) {
  inviteError = `Invite link not used: ${errText(e)}`;
}
const society = store<Society>(SOCIETY_STORAGE);
if (invite && invite.node === society?.node && invite.token === society.token) invite = undefined; // already in use
// With no node of your own, Farcaster's public node can be read, never written to: a page may only
// send it plain GETs (no token, no POST), and no app key is loaded, so no button that writes is shown.
// A society node, once chosen, comes first.
const publicNode = !society && store<boolean>(PUBLIC_STORAGE) === true;
const source = society ? "the society node" : publicNode ? "Farcaster's public node" : "your node";
// An invite opened in this tab while the page is open only changes the fragment: start over to read it.
addEventListener("hashchange", () => {
  if (/(^#|&)(node|token)=/.test(location.hash)) location.reload();
});
// Key and custody checks read Optimism through this RPC, never through the node. "" turns them off.
const rpc = store<string>(RPC_STORAGE) ?? DEFAULT_OPTIMISM_RPC;
const chain = rpc ? new Optimism(rpc) : undefined;
// Gasless keys have no onchain record, so a second, independent node is asked. "" turns it off;
// a second node on the same origin as the node being read is skipped.
const checkUrl = store<string>(CHECKNODE_STORAGE) ?? DEFAULT_CHECK_NODE;
const readUrl = society?.node ?? (publicNode ? DEFAULT_CHECK_NODE : location.origin);
const second = checkUrl ? secondNode(checkUrl, readUrl) : undefined;
const verifier = new Verifier(chain, second);
const hub = new Hub({ url: readUrl, token: society?.token, verifier });
let feed = new FeedBuilder(hub);

let key: AppKey | undefined = publicNode ? undefined : store<AppKey>(KEY_STORAGE);
if (key) verifier.trust(key.fid, key.publicKey);
// Mainnet unless the local server says it fronts a test devnet.
let network = FarcasterNetwork.MAINNET;
let pendingCustody: Custody | undefined;
let pendingAccount: AccountInfo | undefined;
// A phrase made here for a new account: kept only until its app key is added.
let newPhrase: string | undefined;
let viewFid: number | undefined;
let items: FeedItem[] = [];
let perAuthor = 5;
let replyTo: { fid: number; hash: HexString } | undefined;
let myFollowing = new Set<number>();
const chipState = new Map<string, "include" | "exclude">();
let appNames = new Map<number, string>();
// The society: its charter log (the founder's charter plus every amendment members passed), its
// versions, and the current one, whose lens the feed uses.
const savedLog = store<unknown>(CHARTER_STORAGE);
let societyLog: CharterLog | undefined;
let versions: Version[] = [];
let charter: CharterBody | undefined;
// Every approval seen, so a later unlike changes nothing. Only an aid: votes still count from the node.
const approvals = approvalCache(
  () => {
    try {
      return localStorage.getItem(APPROVALS_STORAGE);
    } catch {
      return null;
    }
  },
  (json) => {
    try {
      localStorage.setItem(APPROVALS_STORAGE, json);
    } catch {
      // storage blocked or full: approvals are then counted from the node each time
    }
  },
);
let draft: Array<Change & { label: string }> = [];
const names = new Map<number, string>();
// Profile pictures and image embeds load from their own hosts, not from the node.
let pictures = store<boolean>(PICTURES_STORAGE) ?? true;

// ---- node status

async function checkNode() {
  const pill = $("node-status");
  const which = society ? `society node ${new URL(society.node).host}` : publicNode ? "public node, read-only," : "node";
  try {
    const info = await hub.info();
    const { synced, maxDelay } = syncState(info);
    pill.textContent = synced ? `${which} synced (v${info.version})` : `${which} syncing, ${maxDelay} blocks behind`;
    pill.className = `pill ${synced ? "ok" : "warn"}`;
    if (!$("first-run").hidden) {
      $("first-run").hidden = true;
      $("connect").hidden = !!key || publicNode;
    }
    return synced;
  } catch (e) {
    pill.textContent = e instanceof HubError && e.status === 401 ? `${which}: access refused` : `${which} unreachable`;
    pill.className = "pill bad";
    if (e instanceof HubError && e.status === 401) {
      say(`The society node at ${hub.url} no longer accepts your access token: the host removed it, or it was mistyped. Ask the host for a new invite link, or go back to your own node under "Node and checks".`, true);
    } else if (!society) {
      // Typical on a static host such as GitHub Pages: no node behind this page, and its 404 page is no help.
      // Not an error the person made, so a calm first-run card, not a red line.
      const reason = e instanceof HubError && e.message.includes("returned non-JSON") ? `HTTP ${e.status}, not a node` : errText(e);
      pill.textContent = "no node";
      pill.className = "pill";
      $("first-run-why").textContent = `No node answers at ${hub.url} (${reason}).`;
      $("first-run-public").hidden = publicNode;
      $("first-run").hidden = false;
      $("connect").hidden = true;
    } else {
      say(`Cannot reach the society node at ${hub.url}. ${errText(e)}`, true);
    }
    return false;
  }
}

// What the verifier dropped or held back so far. The node is not asked; these checks run here.
function showVerification() {
  const el = $("verify-status");
  if (!verifier.checked) return;
  el.replaceChildren(verifier.summary(source[0]!.toUpperCase() + source.slice(1)));
  if (verifier.failed) el.append(" (A failed check can rarely come from an honest node, when the app that posted the message encoded it unusually.)");
  if (verifier.unverified && !verifier.showUnverified) {
    el.append(" ", h("button", { type: "button", onclick: (e: Event) => busy(e.currentTarget as HTMLButtonElement, "Loading…", showUnverified) }, "Show them anyway"));
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
  $("first-run-open").addEventListener("click", () => {
    const details = $("node-settings") as HTMLDetailsElement;
    details.open = true;
    $("soc-node").focus();
  });
  $("first-run-public").addEventListener("click", () => {
    if (store(PUBLIC_STORAGE, true) === true) return location.reload();
    say("This browser does not let the page save that choice. Allow this site to store data (in Safari: turn off Settings > Safari > Block All Cookies), then try again.", true);
  });
  $("soc-current").textContent = society
    ? `Using the society node ${society.node}.`
    : publicNode
      ? `Reading Farcaster's public node ${DEFAULT_CHECK_NODE}, read-only.`
      : `Using your own node (this page's origin, ${location.origin}).`;
  $<HTMLInputElement>("rpc-url").value = rpc;
  $<HTMLInputElement>("check-node").value = checkUrl;
  $("check-note").textContent = !checkUrl
    ? 'The second-node check is off: casts signed with gasless keys say "signer not verified".'
    : !second
      ? "The second node is the node you read from, so the gasless-key check is skipped. Choose a different node."
      : `Gasless keys are checked with ${checkUrl}. It learns which accounts you look at (one request per account), not which casts you read. A fake cast now needs both nodes to lie.`;
  $("node-note").textContent = society
    ? `Reads and writes go to the society node ${society.node}.`
    : publicNode
      ? `Reads go to Farcaster's public node ${DEFAULT_CHECK_NODE}; nothing is written.`
      : "Reads and writes go only to your own node.";
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
    store(PUBLIC_STORAGE, null);
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

// An invite only fills in this card. Join saves the node and reloads onto it; Not now changes nothing.
function askToJoin(inv: Society): Promise<void> {
  $("invite-node").textContent = inv.node;
  $("invite").hidden = false;
  $("invite-join").focus();
  return new Promise((resolve) => {
    const done = () => {
      $("invite").hidden = true;
      resolve();
    };
    $("invite-join").addEventListener("click", () => {
      const saved = store<Society>(SOCIETY_STORAGE, inv);
      if (saved?.node === inv.node && saved.token === inv.token) return location.reload();
      inviteError = "Invite link not used: this browser does not let the page save it. Allow this site to store data (in Safari: turn off Settings > Safari > Block All Cookies), then open the invite link again.";
      done();
    });
    $("invite-skip").addEventListener("click", done);
  });
}

// ---- connect

type ConnectStep = "choose" | "app" | "create" | "phrase" | "confirm";

function showConnectStep(step: ConnectStep) {
  $("app-box").hidden = step !== "app";
  $("create-box").hidden = step !== "create";
  $("phrase-box").hidden = step !== "phrase";
  $("confirm-box").hidden = step !== "confirm";
  $("connect-choices").hidden = step === "confirm";
  for (const [id, s] of [["new-account", "create"], ["app-user", "app"], ["use-phrase", "phrase"]] as const) {
    $(id).setAttribute("aria-expanded", String(step === s));
  }
}

const walletProvider = () => (window as unknown as { ethereum?: EIP1193Provider }).ethereum;

async function prepare(custody: Custody) {
  say("Looking up the account…");
  // Devnet accounts are not on Optimism mainnet, so only mainnet looks the FID up there.
  const account = await resolveAccount(hub, custody.address, network === FarcasterNetwork.MAINNET ? chain : undefined);
  if (account.storageUnits === 0) throw new Error(`FID ${account.fid} has no storage, so the network would reject its casts.`);
  pendingCustody = custody;
  pendingAccount = account;
  $("c-addr").textContent = account.custody;
  $("c-fid").textContent = String(account.fid);
  $("c-storage").textContent = String(account.storageUnits);
  showConnectStep("confirm");
  say(`Found FID ${account.fid}. Check the details, then authorize.`);
}

// Adds an app key for an account whose owner key we hold now, then shows its feed.
async function authorize(custody: Custody, account: AccountInfo) {
  const { key: k, confirmed } = await addAppKey(hub, { fid: account.fid, custody: custody.signer, network }, { timeoutMs: 60_000 }, (added) => {
    store(KEY_STORAGE, added); // saved as soon as the node accepts it, so a slow merge cannot lose it
  });
  pendingCustody = undefined; // drop the custody signer; only the app key is kept
  pendingAccount = undefined;
  key = k;
  verifier.trust(k.fid, k.publicKey);
  say(confirmed ? `App key added for FID ${k.fid}. Your node shows it as active.` : `App key sent for FID ${k.fid}; your node does not show it yet. Check the key panel in a minute.`);
  renderAccount();
  await loadFeed(k.fid);
}

// ---- create an account (paid by the society's sponsor)

async function openCreate() {
  showConnectStep("create");
  $("new-phrase-box").hidden = true;
  const offer = $("create-offer");
  const ways = $("create-ways");
  ways.hidden = true;
  if (!society) {
    offer.textContent =
      "Creating an account here needs a society node that pays for it; this page reads from your own node. Open a society's invite link, or make an account in the Farcaster app (it asks for an invite code or an X account, and such accounts can only read here for now).";
    return;
  }
  if (!chain) {
    offer.textContent = 'Creating an account needs the Optimism RPC, which is turned off. Turn it on under "Node and checks".';
    return;
  }
  offer.textContent = "Checking whether this society can pay for your account…";
  let s;
  try {
    s = await sponsorStatus(society.node, society.token);
  } catch {
    offer.textContent = "This society node does not create accounts. Ask its host for a test account; you can read every feed here without one.";
    return;
  }
  if (!s.available) {
    offer.textContent = `${s.reason ?? "This society cannot pay for an account right now."} You can still read every feed here.`;
    return;
  }
  offer.textContent =
    "This society pays the network fee for your new account ($0.20), so you need no ETH, invite code or X account. The account is yours alone: its key is made in this page, or stays in your wallet, and is never sent anywhere.";
  $("create-wallet").hidden = !walletProvider();
  ways.hidden = false;
}

// The node learns about a new account from Optimism, usually within a minute.
async function waitForAccount(fid: number, owner: HexString): Promise<AccountInfo> {
  const end = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      const c = await hub.custodyOf(fid);
      if (c?.toLowerCase() === owner.toLowerCase()) {
        const { units } = await hub.storageLimits(fid);
        if (units > 0) return { fid, custody: owner, storageUnits: units };
      }
    } catch (e) {
      // A node that is catching up or briefly away is asked again; a refused token is final.
      if (e instanceof HubError && e.status === 401) throw e;
    }
    if (Date.now() > end) {
      throw new Error(`FID ${fid} is yours on Optimism, but the node has not seen it after 5 minutes. Reload later and connect it with "I have a test account's recovery phrase" (or your wallet).`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

// `owner` signs Register (for a wallet, on Optimism); `forKey` gives the signer for the app key
// (for a wallet, on mainnet, as KeyAdd's typed data wants).
async function createAccount(owner: Custody, forKey: () => Promise<Custody>) {
  if (!society || !chain) return;
  const existing = await chain.idOf(owner.address);
  if (existing) {
    say(`${owner.address} already owns FID ${existing}. Connecting it instead.`);
    await prepare(await forKey());
    return;
  }
  const nonce = await chain.registerNonce(owner.address);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + REGISTER_DEADLINE_SECONDS);
  say("Signing the registration. It is free: nothing is paid or sent from your side.");
  const signature = await signRegistration(owner, nonce, deadline);
  say("Creating your account on Optimism. The society pays; this takes a few seconds…");
  const r = await sponsorRegister(society.node, society.token, { to: owner.address, recovery: zeroAddress, deadline: deadline.toString(), signature });
  if (r.dryRun) throw new Error("The society's sponsor runs in test mode (dry run): your registration was checked but not sent.");
  say(`Account created: FID ${r.fid}. Waiting for the node to see it, usually under a minute…`);
  const account = await waitForAccount(r.fid, owner.address);
  say(`FID ${r.fid} is on the node. Adding Outpost's app key…`);
  const signer = await forKey();
  if (signer.address.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`Your wallet now uses ${signer.address}, but FID ${r.fid} belongs to ${owner.address}. Switch the wallet back to that account, then choose "My account's owner key is in a browser wallet".`);
  }
  try {
    await authorize(signer, account);
  } finally {
    // Once the app key is stored the phrase is not needed here, even if the feed fails to load.
    if (key?.fid === r.fid) forgetNewPhrase();
  }
}

function forgetNewPhrase() {
  newPhrase = undefined;
  $("new-phrase").textContent = "";
  $("new-phrase-box").hidden = true;
}

function wireCreate() {
  $("new-account").addEventListener("click", () => void openCreate());
  $("app-user").addEventListener("click", () => showConnectStep("app"));
  $("create-phrase").addEventListener("click", () => {
    newPhrase = newRecoveryPhrase();
    $("new-phrase").textContent = newPhrase;
    $<HTMLInputElement>("saved-phrase").checked = false;
    $<HTMLButtonElement>("create-go").disabled = true;
    $("create-ways").hidden = true;
    $("new-phrase-box").hidden = false;
    $("new-phrase").focus();
  });
  $("saved-phrase").addEventListener("change", (e) => ($<HTMLButtonElement>("create-go").disabled = !(e.target as HTMLInputElement).checked));
  $("copy-phrase").addEventListener("click", () =>
    busy(null, "", async () => {
      if (!newPhrase) return;
      await navigator.clipboard.writeText(newPhrase);
      say("Copied. Paste the words somewhere safe, then copy something else so they leave your clipboard.");
    }),
  );
  $("create-go").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Creating…", async () => {
      if (!newPhrase) return;
      const custody = custodyFromSeedPhrase(newPhrase);
      await createAccount(custody, async () => custody);
    }),
  );
  $("create-wallet").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Waiting for wallet…", async () => {
      const eth = walletProvider();
      if (!eth) throw new Error("No browser wallet found. Make a new account here instead.");
      await createAccount(await custodyFromWallet(eth, optimism), () => custodyFromWallet(eth));
    }),
  );
}

function wireConnect() {
  wireCreate();
  $("use-wallet").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Waiting for wallet…", async () => {
      const eth = walletProvider();
      if (!eth) throw new Error('No browser wallet found in this browser. No account yet? Choose "I have no Farcaster account".');
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
    busy(e.currentTarget as HTMLButtonElement, "Checking…", async () => {
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
    busy(e.currentTarget as HTMLButtonElement, "Signing and waiting for the node…", async () => {
      if (!pendingCustody || !pendingAccount) return;
      await authorize(pendingCustody, pendingAccount);
    }),
  );
}

// ---- account / key panel

async function renderAccount() {
  const logged = !!key;
  $("connect").hidden = logged || publicNode;
  $("compose").hidden = !logged;
  $("key").hidden = !logged;
  $("who").textContent = key ? `FID ${key.fid}` : "";
  if (!key) {
    showConnectStep("choose");
    return;
  }
  $("k-fid").textContent = String(key.fid);
  $("k-pub").textContent = key.publicKey;
  $("k-status").textContent = "checking…";
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
    busy(e.currentTarget as HTMLButtonElement, "Revoking…", async () => {
      if (!key) return;
      if (!confirm("Revoke this app key? This client will no longer be able to post for you.")) return;
      // Same rule as `./outpost cli uninstall`: the stored key is the only way to revoke it without
      // the recovery phrase, and a node that is behind says "not found" for a live key.
      if (!syncState(await hub.info()).synced) {
        say("Your node is still syncing, so it cannot tell whether this key is active. Nothing was revoked or removed. Try again when it has caught up.", true);
        return;
      }
      const active = await hub.signer(key.fid, key.publicKey);
      if (active) await revokeAppKey(hub, key, { timeoutMs: 60_000 });
      else if (!confirm("Your node does not list this key (revoked, expired, or not merged yet), so it cannot be revoked now. Remove it from this browser anyway? It cannot revoke itself after that.")) return;
      store(KEY_STORAGE, null);
      key = undefined;
      say(active ? "Key revoked. No recovery phrase was needed." : "Removed the key from this browser without revoking it.");
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

// ---- @mentions in the composer

// Signed profiles seen so far (feed authors, accounts you follow), for the suggestions.
const people = new Map<number, Profile>();
// Names picked from the suggestions. Only these become mentions when posting (mentions.ts).
let picks = new Map<string, number>();
let suggestions: Profile[] = [];
let activeSuggestion = -1;
let followedProfiles: Promise<void> | undefined;
let lookupTimer: ReturnType<typeof setTimeout> | undefined;

function remember(p: Profile | undefined) {
  if (p?.username) people.set(p.fid, p);
}

// Profiles of up to 300 accounts you follow, read once, the first time you type "@".
function loadFollowedProfiles(): Promise<void> {
  if (!myFollowing.size) return Promise.resolve(); // not read yet: try again on the next "@"
  followedProfiles ??= mapLimit([...myFollowing].filter((f) => !people.has(f)).slice(0, 300), 8, (f) =>
    feed.profile(f).then(remember, () => undefined),
  ).then(() => undefined);
  return followedProfiles;
}

function closeSuggestions() {
  suggestions = [];
  activeSuggestion = -1;
  const list = $("mention-list");
  list.hidden = true;
  list.replaceChildren();
  const text = $("text");
  text.setAttribute("aria-expanded", "false");
  text.removeAttribute("aria-activedescendant");
}

function renderSuggestions() {
  const list = $("mention-list");
  const text = $("text");
  if (!suggestions.length) return closeSuggestions();
  list.replaceChildren(
    ...suggestions.map((p, i) =>
      h(
        "li",
        {
          id: `mention-${i}`,
          role: "option",
          "aria-selected": String(i === activeSuggestion),
          // mousedown, not click: the textarea keeps focus and its cursor.
          onmousedown: (e: Event) => {
            e.preventDefault();
            pickSuggestion(i);
          },
        },
        h("span", { class: "mn" }, `@${p.username}`),
        p.displayName ? h("span", { class: "md" }, p.displayName) : null,
        myFollowing.has(p.fid) ? h("span", { class: "md" }, "you follow") : null,
      ),
    ),
  );
  list.hidden = false;
  text.setAttribute("aria-expanded", "true");
  if (activeSuggestion >= 0) text.setAttribute("aria-activedescendant", `mention-${activeSuggestion}`);
  else text.removeAttribute("aria-activedescendant");
  $("mention-note").textContent = `${suggestions.length} ${suggestions.length === 1 ? "person" : "people"} to mention. Up and down arrows to choose, Enter to pick, Escape to close.`;
}

function matches(query: string): Profile[] {
  const q = query.toLowerCase();
  const rank = (p: Profile) => (myFollowing.has(p.fid) ? 0 : 2) + (p.username!.toLowerCase().startsWith(q) ? 0 : 1);
  return [...people.values()]
    .filter((p) => p.username!.toLowerCase().startsWith(q) || (q && p.displayName?.toLowerCase().includes(q)))
    .sort((a, b) => rank(a) - rank(b) || a.username!.localeCompare(b.username!))
    .slice(0, 6);
}

// A full username nobody here has loaded is looked up on the node, and kept only if the account's
// own signed profile carries that name.
async function lookUp(query: string) {
  const fid = await hub.fidByUsername(query).catch(() => undefined);
  if (!fid) return;
  const p = await feed.profile(fid).catch(() => undefined);
  if (p?.username?.toLowerCase() !== query.toLowerCase()) return;
  remember(p);
  const now = mentionQuery($<HTMLTextAreaElement>("text").value, $<HTMLTextAreaElement>("text").selectionStart);
  if (now?.query.toLowerCase() === query.toLowerCase()) {
    suggestions = matches(query);
    renderSuggestions();
  }
}

function suggest() {
  const text = $<HTMLTextAreaElement>("text");
  const q = mentionQuery(text.value, text.selectionStart);
  clearTimeout(lookupTimer);
  if (!q || text.selectionStart !== text.selectionEnd) return closeSuggestions();
  void loadFollowedProfiles().then(() => {
    const again = mentionQuery(text.value, text.selectionStart);
    if (again?.query === q.query && !suggestions.length && matches(q.query).length) {
      suggestions = matches(q.query);
      renderSuggestions();
    }
  });
  suggestions = matches(q.query);
  activeSuggestion = suggestions.length ? 0 : -1;
  renderSuggestions();
  if (!suggestions.some((p) => p.username!.toLowerCase() === q.query.toLowerCase()) && q.query.length >= 2) {
    lookupTimer = setTimeout(() => void lookUp(q.query), 300);
  }
}

function pickSuggestion(i: number) {
  const p = suggestions[i];
  const text = $<HTMLTextAreaElement>("text");
  const q = mentionQuery(text.value, text.selectionStart);
  if (!p?.username || !q) return closeSuggestions();
  const insert = `@${p.username} `;
  text.value = text.value.slice(0, q.start) + insert + text.value.slice(text.selectionStart);
  const at = q.start + insert.length;
  text.setSelectionRange(at, at);
  picks.set(p.username.toLowerCase(), p.fid);
  closeSuggestions();
  $("mention-note").textContent = `Mentioning @${p.username}.`;
  text.dispatchEvent(new Event("input"));
  text.focus();
}

function wireMentions() {
  const text = $<HTMLTextAreaElement>("text");
  text.addEventListener("input", suggest);
  text.addEventListener("click", suggest);
  text.addEventListener("blur", () => setTimeout(closeSuggestions, 150));
  text.addEventListener("keydown", (e) => {
    if ($("mention-list").hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = suggestions.length;
      activeSuggestion = (activeSuggestion + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderSuggestions();
      document.getElementById(`mention-${activeSuggestion}`)?.scrollIntoView({ block: "nearest" });
    } else if ((e.key === "Enter" || e.key === "Tab") && activeSuggestion >= 0) {
      e.preventDefault();
      pickSuggestion(activeSuggestion);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSuggestions();
    }
  });
}

function wireCompose() {
  wireMentions();
  const text = $<HTMLTextAreaElement>("text");
  text.addEventListener("input", () => ($("count").textContent = `${new TextEncoder().encode(text.value).length} / 1024`));
  $("post").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Posting…", async () => {
      if (!key) return;
      const m = extractMentions(text.value, [...picks].map(([name, fid]) => ({ name, fid })));
      const r = await cast(hub, key, { text: m.text, replyTo, ...(m.mentions.length ? { mentions: m.mentions, mentionsPositions: m.mentionsPositions } : {}) });
      text.value = "";
      picks = new Map();
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
    busy(btn, "…", async () => {
      const now = btn.getAttribute("aria-pressed") !== "true";
      await onToggle(now);
      btn.setAttribute("aria-pressed", String(now));
    }).then(() => (btn.textContent = label)),
  );
  return btn;
}

function letterAvatar(it: FeedItem): HTMLSpanElement {
  return h("span", { class: "avatar letter", "aria-hidden": "true" }, initial(it.author?.displayName ?? it.author?.username));
}

// The author's picture from their signed profile, or their initial when there is none or it fails.
function avatar(it: FeedItem): HTMLElement {
  const src = pictures ? httpsUrl(it.author?.pfp) : undefined;
  if (!src) return letterAvatar(it);
  const img = h("img", { class: "avatar", src, alt: "", width: "40", height: "40", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
  img.addEventListener("error", () => img.replaceWith(letterAvatar(it)), { once: true });
  return img;
}

function embedLink(u: string): HTMLAnchorElement {
  return h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, u);
}

function embed(u: string): HTMLElement {
  if (!pictures || !isImageEmbed(u)) return embedLink(u);
  const img = h("img", { src: u, alt: "Image attached to this cast", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
  const a = h("a", { class: "cast-image", href: u, target: "_blank", rel: "noopener noreferrer" }, img);
  img.addEventListener("error", () => a.replaceWith(embedLink(u)), { once: true });
  return a;
}

// Your own key needs no proof; any other key must be on Optimism or listed by the second node.
function keyTag(it: FeedItem): HTMLSpanElement | null {
  const k = it.app.keyCheck;
  if (k === "onchain" || k === "own" || it.signer.toLowerCase() === key?.publicKey.toLowerCase()) return null;
  if (k === "confirmed") {
    return h("span", { class: "app-tag", title: `A gasless key: no onchain record, but the second node (${checkUrl}) lists it as this account's key. Faking it would need both nodes to lie.` }, "signer confirmed by second node");
  }
  if (k === "revoked") {
    return h("span", { class: "app-tag", title: "This account's key on Optimism, removed since. What it signed before stays valid on the network; it cannot sign anything new." }, "key revoked since");
  }
  if (k === "unlisted") {
    return h("span", { class: "key-tag", title: `The second node (${checkUrl}) does not list this key for this account. It was revoked since, or it is not the account's key: the node's API cannot tell which.` }, "key not listed");
  }
  return h(
    "span",
    {
      class: "key-tag",
      title:
        "The signature is valid, but this page could not prove the key belongs to this account: it is not on Optimism and no second node could be asked (off, unreachable, or the same node). The node could have signed this with its own key.",
    },
    "signer not verified",
  );
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
    avatar(it),
    h(
      "div",
      { class: "cast-body" },
      h(
        "div",
        { class: "cast-head" },
        h("span", { class: "name" }, it.author?.displayName ?? name),
        h("span", { class: "meta" }, `${name} · ${ago(it.time)}`),
        h("span", { class: "app-tag", title: "The app that requested the key that signed this cast" }, appLabel(it)),
        keyTag(it),
      ),
      it.text ? h("p", { class: "cast-text" }, it.text) : null,
      embeds.length ? h("div", { class: "cast-embeds" }, ...embeds.flatMap((u) => [embed(u), " "])) : null,
      actions,
    ),
  );
}

function renderFeed() {
  renderChips();
  const filter = currentFilter();
  const shown = items.filter((it) => passesFilter(it.app, filter));
  $("feed").replaceChildren(...shown.map(castCard));
  if (!shown.length && (charter || viewFid)) {
    $("feed").append(
      h(
        "li",
        { class: "feed-empty" },
        items.length ? "No casts from the apps you chose. Tap a chip above to change the filter." : charter ? "No casts yet in this society's feed." : `No casts yet for FID ${viewFid}.`,
      ),
    );
  }
  $("more").hidden = items.length === 0;
  if (charter) $("feed-title").textContent = `"${charter.name}" society feed, through its lens · ${shown.length} of ${items.length} casts`;
  else if (viewFid) $("feed-title").textContent = `Following feed of FID ${viewFid} · ${shown.length} of ${items.length} casts`;
  else $("feed-title").textContent = "";
}

async function loadFeed(fid?: number) {
  if (fid) viewFid = fid;
  const t0 = performance.now();
  if (!charter && !viewFid) return;
  // The old casts stay, dimmed, until the new ones are in: the page does not jump while loading.
  const list = $("feed");
  list.setAttribute("aria-busy", "true");
  try {
    if (charter) {
      say(`Loading the "${charter.name}" society feed from ${source}…`);
      items = await charterFeed(feed, charter, { limit: 100, perAuthor });
    } else {
      say(`Loading the feed for FID ${viewFid} from ${source}…`);
      items = await feed.following(viewFid!, { limit: 100, perAuthor });
    }
    appNames = await feed.appNames(items);
    for (const it of items) remember(it.author);
  } finally {
    list.removeAttribute("aria-busy");
  }
  renderFeed();
  showVerification();
  say(`Loaded ${items.length} cast${items.length === 1 ? "" : "s"} in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
}

function showPicturesNote() {
  $("pictures-note").textContent = pictures ? "Pictures load straight from where their owners host them; those sites see your IP address." : "";
}

function wireFeed() {
  const box = $<HTMLInputElement>("pictures");
  box.checked = pictures;
  showPicturesNote();
  box.addEventListener("change", () => {
    pictures = box.checked;
    store(PICTURES_STORAGE, pictures);
    showPicturesNote();
    renderFeed();
  });
  $("view-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void busy(null, "", async () => {
      const v = $<HTMLInputElement>("view").value.trim();
      const fid = /^\d+$/.test(v) ? Number(v) : await hub.fidByUsername(v);
      if (!fid) throw new Error(`No FID found for "${v}" on ${source}.`);
      perAuthor = 5;
      if (charter) leaveCharter();
      await loadFeed(fid);
    });
  });
  $("more").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Loading…", async () => {
      perAuthor *= 2;
      await loadFeed();
    }),
  );
}

// ---- society (charter)

function rejectCharter(source: string, why: string) {
  const verdict = $("charter-verdict");
  $("charter-view").hidden = false;
  verdict.className = "verdict-bad";
  verdict.textContent = `Rejected (${source}): ${why}`;
  for (const id of ["ch-name", "ch-desc", "ch-coc", "ch-members", "ch-rules", "ch-nodes"]) $(id).textContent = "";
  ($("ch-join") as HTMLButtonElement).disabled = true;
  $("ch-details").hidden = true;
  // Never keep an earlier society's lens active behind a rejected file.
  charter = undefined;
  societyLog = undefined;
  versions = [];
  store(CHARTER_STORAGE, null);
  $("ch-census").hidden = true;
  items = [];
  renderFeed();
}

// A charter file or charter log. One from outside is recounted with fresh key checks; the one
// saved in this browser was checked when it was accepted. A newer log of the same society
// replaces the saved one only if it extends it.
async function showCharter(c: unknown, source: string, saved = false) {
  let log: CharterLog;
  try {
    log = toLog(c);
  } catch (e) {
    return rejectCharter(source, errText(e));
  }
  const v = await verifyCharter(log.genesis, hub, chain);
  if (!v.ok) return rejectCharter(source, v.problems.join("; "));
  const r = await replay(log, saved ? ALREADY_CHECKED : verifier);
  if (r.problems.length) return rejectCharter(source, r.problems.join("; "));
  if (!saved && societyLog) {
    const rel = compareLogs(societyLog, log);
    if (rel.relation === "same") return say("That is the charter log you already have.");
    if (rel.relation === "behind") return say("The log saved in this browser is newer than that one. Kept yours.");
    if (rel.relation === "fork") {
      return say(`That log branches from yours after version ${rel.at}: a different amendment passed there. Kept yours. Members who approved both: ${(rel.both ?? []).map(nameOf).join(", ") || "none"}.`, true);
    }
  }
  const weak = r.versions.flatMap((ver, i) => (ver.amendment && !ver.amendment.recountable ? [i] : []));
  if (!saved && weak.length && !confirm(`Version ${weak.join(", ")} of this log cannot be recounted from scratch: the majority rests on approvals whose keys cannot be checked now (revoked since, or not listed by your second node). Use it only if you trust whoever gave it to you. Use it?`)) return;
  const ch = log.genesis;
  societyLog = log;
  versions = r.versions;
  charter = versions.at(-1)!.body;
  $("ch-details").hidden = false;
  const verdict = $("charter-verdict");
  $("charter-view").hidden = false;
  verdict.className = "verdict-ok";
  verdict.textContent =
    (v.issuerCheck === "custody"
      ? `Signature OK: signed by the owner of FID ${ch.issuer!.fid}, checked ${chain ? "on Optimism" : "on your node"}.`
      : `Signature OK, signed by ${v.signer}. ${ch.issuer ? "Could not confirm it is the issuer's key." : "It names no issuer account."}`) +
    (log.amendments.length ? ` Members have changed it ${log.amendments.length} time${log.amendments.length === 1 ? "" : "s"}${saved ? "" : `; every change recounted from ${source}`}.` : "");
  $("ch-name").textContent = ch.name;
  $("ch-desc").textContent = ch.description ?? "";
  const coc = $("ch-coc");
  coc.replaceChildren(ch.codeOfConduct && /^https?:\/\//.test(ch.codeOfConduct) ? h("a", { href: ch.codeOfConduct, target: "_blank", rel: "noopener noreferrer" }, ch.codeOfConduct) : "none");
  showMembers();
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
  store(CHARTER_STORAGE, log);
  await renderVotes();
  chipState.clear();
  perAuthor = 5;
  await loadFeed();
  void checkVotes(null);
}

function showMembers() {
  if (!charter) return;
  $("ch-members").textContent = `${charter.members.length} members${charter.moderators?.length ? `, ${charter.moderators.length} moderators` : ""}`;
}

// ---- society votes (votes.ts)

const nameOf = (fid: number) => names.get(fid) ?? `FID ${fid}`;

// @usernames for these FIDs, from their signed profiles on your node.
async function loadNames(fids: number[]) {
  const todo = [...new Set(fids)].filter((f) => !names.has(f));
  const profiles = await Promise.all(todo.map((f) => feed.profile(f).catch(() => undefined)));
  profiles.forEach((p, i) => names.set(todo[i]!, p?.username ? `@${p.username}` : `FID ${todo[i]}`));
}

const changeText = (c: Change) => `${c.op === "+" ? "Add" : "Remove"} ${c.role} ${nameOf(c.fid)}`;

function versionItem(ver: Version, i: number): HTMLLIElement {
  const a = ver.amendment;
  if (!a) return h("li", {}, `The founder's charter: ${ver.body.members.length} members.`);
  const n = a.approvers.length + a.unchecked.length;
  return h(
    "li",
    {},
    `${a.proposal.changes.map(changeText).join("; ")}. Proposed by ${nameOf(a.proposal.id.fid)}, approved by ${n} of ${a.members} (needed ${a.needed}).`,
    a.unchecked.length
      ? h(
          "span",
          { class: a.recountable ? "muted" : "warn-text" },
          ` ${a.unchecked.length} approval${a.unchecked.length === 1 ? "" : "s"} (${a.unchecked.map(nameOf).join(", ")}) cannot be re-checked now: the key was revoked since, or your second node does not list it.${a.recountable ? "" : " The majority rests on them, so this version cannot be recounted from scratch."}`,
        )
      : null,
    i === versions.length - 1 && key && charter?.members.includes(key.fid)
      ? h("span", {}, " ", h("button", { type: "button", onclick: (e: Event) => busy(e.currentTarget as HTMLButtonElement, "Posting…", () => announceResult(a.proposal.id, n, a.members)) }, "Post the result under the proposal"))
      : null,
  );
}

async function announceResult(id: { fid: number; hash: HexString }, approved: number, members: number) {
  if (!key) return;
  const r = await announce(hub, key, id, approved, members);
  say(r ? "Replied under the proposal with the result, so people see it in any app." : "A result is already posted under the proposal.");
}

function proposalItem(t: Tally): HTMLLIElement {
  const p = t.proposal;
  const member = !!key && !!charter?.members.includes(key.fid);
  const approved = !!key && t.approvers.includes(key.fid);
  return h(
    "li",
    { class: "proposal" },
    h("div", {}, `Proposed by ${nameOf(p.id.fid)} `, h("span", { class: "muted mono" }, short(p.id.hash))),
    h("ul", { class: "changes" }, ...p.changes.map((c) => h("li", {}, changeText(c)))),
    h(
      "div",
      { class: "tally" },
      h("progress", { max: String(t.needed), value: String(Math.min(t.approvers.length, t.needed)), "aria-label": `${t.approvers.length} of ${t.needed} approvals needed` }),
      `${t.approvers.length} of ${t.members} members approved · passes at ${t.needed}`,
    ),
    t.approvers.length ? h("p", { class: "muted small" }, `Approved by ${t.approvers.map(nameOf).join(", ")}.`) : null,
    approved
      ? h("p", { class: "small verdict-ok" }, "You approved this. Unliking now is not a veto: an approval once seen keeps counting.")
      : member
        ? h(
            "button",
            {
              type: "button",
              class: "primary",
              onclick: (e: Event) =>
                busy(e.currentTarget as HTMLButtonElement, "Approving…", async () => {
                  await react(hub, key!, "like", p.id);
                  await checkVotes(null);
                }),
            },
            "Approve (like it)",
          )
        : h("p", { class: "muted small" }, key ? "Only members can approve." : publicNode ? "Approving needs your own node or a society's: the public node is read-only here." : "Connect an account to approve."),
  );
}

async function renderVotes(st?: Status) {
  if (!societyLog || !charter) return;
  const fids = [...versions.flatMap((v) => (v.amendment ? [v.amendment.proposal.id.fid, ...v.amendment.proposal.changes.map((c) => c.fid), ...v.amendment.approvers, ...v.amendment.unchecked] : []))];
  for (const t of st?.open ?? []) fids.push(t.proposal.id.fid, ...t.proposal.changes.map((c) => c.fid), ...t.approvers);
  await loadNames(fids.concat(st?.conflict?.both ?? []));
  $("v-version").textContent = `Version ${versions.length - 1} of this charter, head ${short(versions.at(-1)!.head)}.`;
  $("v-history").replaceChildren(...versions.map(versionItem));
  if (st) {
    $("v-open").replaceChildren(...st.open.map(proposalItem));
    const notes: string[] = [];
    if (st.conflict) notes.push(`${st.conflict.tallies.length} proposals reached a majority at once, so none was adopted. Members who approved more than one: ${st.conflict.both.map(nameOf).join(", ")}.`);
    if (!st.open.length) notes.push("No open proposals in members' casts of the last 30 days.");
    if (st.outdated.length) notes.push(`${st.outdated.length} older proposal${st.outdated.length === 1 ? " names" : "s name"} an earlier version and no longer count${st.outdated.length === 1 ? "s" : ""}.`);
    if (st.unknown.length) notes.push(`${st.unknown.length} proposal${st.unknown.length === 1 ? " names" : "s name"} a version this browser does not have: another society's, or your copy is behind. Ask a member for their log and open it above.`);
    const alert = $("v-alert");
    alert.textContent = notes.join(" ");
    alert.className = `small ${st.conflict ? "bad-text" : st.unknown.length ? "warn-text" : "muted"}`;
    alert.hidden = !notes.length;
  }
  $("v-propose").hidden = !(key && charter.members.includes(key.fid));
}

// Reads proposals and likes from your node, and adds every amendment that has passed.
async function checkVotes(btn: HTMLButtonElement | null) {
  await busy(btn, "Checking…", async () => {
    if (!societyLog) return;
    const st = await advance(hub, societyLog, { cache: approvals });
    if (st.passed.length) {
      societyLog = st.log;
      store(CHARTER_STORAGE, st.log);
      versions = (await replay(st.log, ALREADY_CHECKED)).versions;
      charter = st.body;
      showMembers();
      await loadNames(st.passed.flatMap((t) => t.proposal.changes.map((c) => c.fid)));
      await loadFeed(); // the lens now covers the new members
      say(`Passed: ${st.passed.map((t) => t.proposal.changes.map(changeText).join("; ")).join(" Then: ")}. The charter is now at version ${versions.length - 1}.`);
    }
    await renderVotes(st);
  });
}

function renderDraft() {
  $("v-changes").replaceChildren(
    ...draft.map((c, i) =>
      h(
        "li",
        {},
        `${c.op === "+" ? "Add" : "Remove"} ${c.role} ${c.label}`,
        h(
          "button",
          {
            type: "button",
            "aria-label": `Drop: ${c.op === "+" ? "add" : "remove"} ${c.role} ${c.label}`,
            onclick: () => {
              draft.splice(i, 1);
              renderDraft();
            },
          },
          "drop",
        ),
      ),
    ),
  );
  $<HTMLButtonElement>("v-post").disabled = !draft.length;
}

function wireVotes() {
  $("v-check").addEventListener("click", (e) => checkVotes(e.currentTarget as HTMLButtonElement));
  $("v-recount").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Recounting…", async () => {
      if (!societyLog) return;
      const r = await replay(societyLog, verifier);
      if (r.problems.length) throw new Error(`Recount failed at ${r.problems.join("; ")}`);
      versions = r.versions;
      await renderVotes();
      const weak = versions.filter((v) => v.amendment && !v.amendment.recountable).length;
      say(
        weak
          ? `Recounted ${versions.length - 1} change(s) from ${source}; ${weak} cannot be recounted from scratch (see the notes under Votes).`
          : `Recounted from ${source}: all ${versions.length - 1} change(s) check out, every signature and key.`,
        weak > 0,
      );
      showVerification();
    }),
  );
  $("v-download").addEventListener("click", () => {
    if (!societyLog || !charter) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(societyLog, null, 2) + "\n"], { type: "application/json" }));
    h("a", { href: url, download: `${charter.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "society"}.log.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
  $("v-add").addEventListener("click", (e) =>
    busy(e.currentTarget as HTMLButtonElement, "Looking up…", async () => {
      const input = $<HTMLInputElement>("v-who");
      const who = input.value.trim();
      const fid = /^\d+$/.test(who) ? Number(who) : await hub.fidByUsername(who);
      if (!fid) throw new Error(`No FID found for "${who}". Plain usernames or FIDs only.`);
      if (draft.length >= MAX_CHANGES) throw new Error(`A proposal holds at most ${MAX_CHANGES} changes.`);
      const [op, role] = $<HTMLSelectElement>("v-op").value.split(" ") as [Change["op"], Change["role"]];
      draft.push({ op, role, fid, label: /^\d+$/.test(who) ? `FID ${fid}` : `@${who.replace(/^@/, "")} (FID ${fid})` });
      input.value = "";
      renderDraft();
    }),
  );
  $("v-propose-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void busy($<HTMLButtonElement>("v-post"), "Posting…", async () => {
      if (!key || !charter || !draft.length) return;
      const changes = draft.map(({ op, role, fid }) => ({ op, role, fid }));
      const r = await propose(hub, key, { head: versions.at(-1)!.head, body: charter }, changes);
      draft = [];
      renderDraft();
      say(`Proposal posted${r.confirmed ? "" : " (accepted for relay, not visible yet)"} and approved by you. Members approve by liking it, in any Farcaster app.`);
      await checkVotes(null);
    });
  });
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
  societyLog = undefined;
  versions = [];
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
    busy(e.currentTarget as HTMLButtonElement, "Following…", async () => {
      if (!key || !charter) return;
      const k = key;
      const todo = charter.members.filter((m) => m !== k.fid && !myFollowing.has(m));
      let n = 0;
      let unconfirmed = 0;
      for (const m of todo) {
        say(`Following member ${++n} of ${todo.length} (FID ${m})…`);
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
    busy(e.currentTarget as HTMLButtonElement, "Counting…", async () => {
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
  wireVotes();
  await renderAccount();
  if (invite) await askToJoin(invite);
  if (await checkNode()) {
    const start = key?.fid ?? (params.get("fid") ? Number(params.get("fid")) : undefined);
    if (savedLog) await showCharter(savedLog, "saved in this browser", true).catch((e) => say(errText(e), true));
    else if (start) await loadFeed(start).catch((e) => say(errText(e), true));
    else if (publicNode) say('Enter an FID or username to read a feed. This is read-only: to post, run your own node or join a society (see "Node and checks").');
    else say('Enter an FID or username to read a feed. To post, see "Post from Outpost" below.');
  }
  if (inviteError) say(inviteError, true);
  setInterval(checkNode, 60_000);
}

void main();
